Session <- R6::R6Class(
  "alder_session",
  public = list(
    initialize = function(notebook, worker = NULL,
                          execution_mode = c("automatic", "lazy"),
                          run_on_startup = TRUE,
                          defer_startup = FALSE,
                          disk_version = list(exists = NA, bytes = raw()),
                          config = NULL, package_lib = NULL) {
      execution_mode <- match.arg(execution_mode)
      if (!is.logical(defer_startup) || length(defer_startup) != 1L ||
          is.na(defer_startup)) {
        stop("`defer_startup` must be TRUE or FALSE", call. = FALSE)
      }
      private$notebook <- notebook
      private$disk_version <- disk_version
      private$execution_mode <- execution_mode
      private$run_on_startup <- run_on_startup
      private$config <- if (is.null(config)) {
        resolve_alder_config(notebook$path, notebook$metadata)
      } else {
        validate_config_layer(config, partial = FALSE)
      }
      private$package_lib <- package_lib
      private$package_error <- NULL
      private$package_log <- ""
      private$state_version <- 0L
      private$changed <- FALSE
      private$run_counter <- 0L
      private$op_counter <- 0L
      private$run_operation_results <- list()
      private$widget_operation_results <- list()
      private$worker_failed <- FALSE
      private$stopped <- FALSE
      private$barrier_restart_required <- FALSE
      private$queue <- list()
      private$cell_state <- list()
      private$button_resets <- list()
      private$last_action_error <- NULL
      private$service_errors <- list()
      private$layout_error <- NULL
      private$layout <- if (exists("alder_layout_read", mode = "function") &&
                            is.character(notebook$path) &&
                            length(notebook$path) == 1L &&
                            !is.na(notebook$path) && nzchar(notebook$path)) {
        tryCatch(alder_layout_read(notebook$path),
                 error = function(e) {
                   error_message <- paste0(
                     "Could not load layout sidecar ",
                     layout_sidecar_path(notebook$path), ": ",
                     conditionMessage(e)
                   )
                   private$layout_error <- list(
                     token = NULL,
                     code = e$code %||% "invalid_layout",
                     message = error_message
                   )
                   message("[alder:layout] ", error_message)
                   NULL
                 })
      } else {
        NULL
      }
      if (!is.null(private$layout_error)) {
        private$last_action_error <- private$layout_error
      }
      private$last_value <- NULL
      private$value_operation <- NULL
      private$lazy_operations <- list()
      private$variables <- list()
      private$variables_operation <- NULL
      private$analysis <- list()
      private$dag <- NULL
      private$topo <- character()
      if (!is.null(worker)) {
        private$worker <- worker
        worker$set_on_failure(function(message) private$on_worker_failure(message))
        worker$set_on_notify(function(context, frame)
          private$on_notify(context, frame))
      }
      private$recompute()
      for (id in private$dag_nodes()) {
        if (identical(private$cell_type(id), "markdown")) {
          private$cell_state[[id]] <- list(
            status = "done",
            outputs = list(render_markdown_cell_output(
              nb_cell(private$notebook, id)$body)),
            progress = NULL, log = character(), revision = 0L,
            diagnostics = list())
        }
      }
      private$bump()
      # MCP uses a valid initialize/initialized handshake as its execution
      # boundary. It retains the normal requested policy while deferring this
      # single constructor-side startup effect until that boundary completes.
      if (!isTRUE(defer_startup)) private$startup_run()
    },

    worker_available = function() {
      private$detect_worker_failure()
      !private$worker_failed && !private$stopped &&
        !is.null(private$worker) && private$worker$alive()
    },

    # Exact terminal/pending state for one widget token. This internal
    # journal lets synchronous protocol clients follow the operation they
    # started even when a one-shot control immediately creates a reset op.
    widget_operation = function(token) {
      if (!is.numeric(token) || length(token) != 1L || is.na(token) ||
          !is.finite(token) || token < 1 || token != floor(token)) {
        return(NULL)
      }
      private$widget_operation_results[[as.character(as.integer(token))]] %||%
        NULL
    },

    # Exact settlement state for one accepted run. Runtime `busy` describes
    # only cell evaluation and can become FALSE while a deferred run-button
    # reset is still in flight, so synchronous clients follow this journal.
    run_operation = function(run_id) {
      if (!is.numeric(run_id) || length(run_id) != 1L || is.na(run_id) ||
          !is.finite(run_id) || run_id < 1 || run_id != floor(run_id)) {
        return(NULL)
      }
      private$run_operation_results[[as.character(as.integer(run_id))]] %||%
        NULL
    },

    # Full client-visible state snapshot. log/diagnostic arrays, the dag
    # node list, and the topological plan stay arrays under JSON via I().
    state = function() {
      private$detect_worker_failure()
      private$refresh_value_freshness()
      nodes <- private$dag_nodes()
      cells <- lapply(private$notebook$cells, function(c) {
        rec <- private$cell_state[[c$id]] %||%
          list(status = "idle", outputs = list(), progress = NULL,
               log = character(), revision = 0L, diagnostics = list())
        p <- private$analysis[[c$id]] %||% list(
          defs = character(), refs = character(), locals = character())
        disabled <- identical(c$options$disabled %||% NULL, TRUE)
        status <- rec$status
        if (disabled && !identical(status, "running")) status <- "disabled"
        list(id = c$id, type = c$type, delim = c$delim,
             body = I(c$body %||% character()),
             options = c$options,
             disabled = disabled,
             status = status,
             outputs = I(rec$outputs %||% list()),
             progress = rec$progress %||% NULL,
             defs = I(p$defs %||% character()),
             refs = I(p$refs %||% character()),
             locals = I(p$locals %||% character()),
             log = I(rec$log %||% character()),
             error = rec$error %||% NULL,
             revision = rec$revision %||% 0L,
             diagnostics = I(rec$diagnostics %||% list()))
      })
      snapshot <- list(
        version = private$state_version,
        path = private$notebook$path,
        etag = notebook_etag(private$notebook),
        metadata = private$notebook$metadata,
        runtime = list(
          execution_mode = private$execution_mode,
          run_on_startup = private$run_on_startup,
          worker_available = self$worker_available(),
          busy = !is.null(private$current),
          active_run_id = if (!is.null(private$current)) private$current$job$run_id else NULL
        ),
        config = private$config,
        app = if (exists("alder_app_config", mode = "function")) {
          tryCatch(alder_app_config(private$notebook),
                   error = function(e) list(layout = "vertical",
                                            width = "medium",
                                            include_code = FALSE))
        } else {
          list(layout = "vertical", width = "medium", include_code = FALSE)
        },
        cells = cells,
        packages = if (exists("alder_packages", mode = "function")) {
          tryCatch({
            packages <- alder_packages(session = self)
            package_error <- packages$error %||%
              private$package_error %||% list()
            list(declared = I(as.character(packages$declared %||% character())),
                 missing = I(as.character(packages$missing %||% character())),
                 installing = I(as.character(packages$installing %||% character())),
                 installed = I(as.character(packages$installed %||% character())),
                 log = private$package_log %||% "",
                 error = package_error)
          }, error = function(e) {
            list(declared = I(character()), missing = I(character()),
                 installing = I(character()), installed = I(character()),
                 log = private$package_log %||% "",
                 error = list(code = "package_state_error",
                              message = conditionMessage(e)))
          })
        } else {
          list(declared = I(character()), missing = I(character()),
               installing = I(character()), installed = I(character()),
               log = private$package_log %||% "", error = list())
        },
        layout = private$layout,
        layout_error = private$layout_error,
        variables = I(private$variables %||% list()),
        dag = list(
          nodes = I(nodes),
          edges = lapply(private$dag$edges %||% list(), I),
          duplicates = private$dag$duplicates %||% list(),
          cycles = I(as.character(private$dag$cycles %||% character()))
        ),
        topo = if (length(private$topo)) I(private$topo) else NULL,
        changed = private$changed,
        last_value = private$last_value,
        value_operation = private$value_operation,
        editor_diagnostics = I(private$lsp_diagnostics[[".document"]] %||% list()),
        service_errors = private$service_errors,
        last_action_error = private$last_action_error %||%
          private$layout_error %||%
          if (length(private$service_errors)) {
            private$service_errors[[1L]]
          } else {
            NULL
          }
      )
      if (exists("alder_dataflow_state", mode = "function")) {
        dataflow <- tryCatch({
          projected <- alder_dataflow_state(snapshot, include_values = FALSE)
          # Runtime updates cannot change source positions or symbol owners.
          # Include every cell in notebook order: edits in another cell can
          # change ownership even when this cell's source stays identical.
          range_key <- lapply(cells, function(cell) {
            cell[c("id", "body", "defs", "refs")]
          })
          cached <- private$reactive_range_cache
          if (is.null(cached) || !identical(cached$key, range_key)) {
            ranges <- setNames(
              lapply(nodes, function(id) alder_reactive_ranges(snapshot, id)),
              nodes
            )
            private$reactive_range_cache <- list(key = range_key, ranges = ranges)
          }
          projected$reactive_ranges <- private$reactive_range_cache$ranges
          alder_dataflow_json(projected)
        }, error = identity)
        if (inherits(dataflow, "condition")) {
          projection_error <- list(
            code = "dataflow_projection_error",
            message = paste0("Dataflow projection failed: ",
                             conditionMessage(dataflow))
          )
          empty_adjacency <- setNames(
            lapply(nodes, function(id) I(character())), nodes
          )
          dataflow <- list(
            variables = I(list()),
            dag = list(
              nodes = I(nodes),
              edges = empty_adjacency,
              reverse_edges = empty_adjacency,
              edge_records = I(list()),
              cycles = I(character()),
              cycle_nodes = I(character())
            ),
            outline = I(list()),
            reactive_ranges = setNames(
              lapply(nodes, function(id) I(list())), nodes
            ),
            error = projection_error
          )
          snapshot$dataflow_error <- projection_error
          if (is.null(snapshot$last_action_error)) {
            snapshot$last_action_error <- projection_error
          }
        } else {
          snapshot$outline <- I(dataflow$outline)
          snapshot$reactive_ranges <- dataflow$reactive_ranges
        }
        snapshot$dataflow <- dataflow
      }
      snapshot
    },

    # Serialize the same state for transports without encoding thousands of
    # unchanged source positions twice on every poll. Only encoder-produced
    # JSON is joined here; source strings never enter the framing directly.
    state_json = function(fields = list()) {
      perf <- .alder_perf_begin("state.encode")
      on.exit(.alder_perf_end(perf), add = TRUE)
      snapshot <- self$state()
      snapshot <- c(snapshot, fields)
      encode <- function(value) as.character(jsonlite::toJSON(
        value, auto_unbox = TRUE, null = "null", na = "null", force = TRUE
      ))
      cached <- private$reactive_range_cache
      if (is.null(cached) || is.null(snapshot$reactive_ranges) ||
          !identical(snapshot$reactive_ranges, cached$ranges) ||
          !identical(snapshot$dataflow$reactive_ranges, cached$ranges)) {
        return(encode(snapshot))
      }
      if (is.null(cached$json)) {
        cached$json <- encode(cached$ranges)
        private$reactive_range_cache <- cached
      }
      # Both enclosing objects are nonempty; remove only their final brace.
      append_fields <- function(object, fields) {
        paste0(substr(object, 1L, nchar(object) - 1L), ",", fields, "}")
      }
      dataflow <- snapshot$dataflow
      dataflow$reactive_ranges <- NULL
      dataflow_json <- append_fields(encode(dataflow),
        paste0('"reactive_ranges":', cached$json))
      snapshot$dataflow <- NULL
      snapshot$reactive_ranges <- NULL
      append_fields(encode(snapshot), paste0(
        '"dataflow":', dataflow_json, ',"reactive_ranges":', cached$json
      ))
    },

    # A defensive notebook snapshot for editor services. Callers must not
    # mutate Session state directly; all writes still go through set_cell.
    notebook_snapshot = function() {
      private$notebook
    },

    set_lsp_diagnostics = function(diagnostics = list()) {
      private$assert_active()
      diagnostics <- diagnostics %||% list()
      if (identical(private$lsp_diagnostics, diagnostics)) {
        return(invisible(FALSE))
      }
      private$lsp_diagnostics <- diagnostics
      private$refresh_diagnostics()
      private$bump()
      invisible(TRUE)
    },

    # NULL when the graph is runnable, else the validation messages
    # (sorted, de-duplicated) to surface to the user.
    validate_graph = function() {
      msgs <- character()
      cycles <- sort(as.character(private$dag$cycles %||% character()))
      if (length(cycles)) {
        msgs <- c(msgs, paste("cannot run: dependency cycle:",
                              paste(cycles, collapse = ", ")))
      }
      dups <- private$dag$duplicates %||% list()
      if (length(names(dups))) {
        msgs <- c(msgs, paste("cannot run: duplicate definitions:",
                              paste(sort(names(dups)), collapse = ", ")))
      }
      for (id in private$dag_nodes()) {
        p <- private$analysis[[id]]
        if (!is.null(p$error)) {
          msgs <- c(msgs, paste("cannot run:", id,
                                "has a syntax error:", p$error))
        }
        for (d in p$diagnostics) {
          if (identical(d$level, "error")) {
            msgs <- c(msgs, paste("cannot run:", id,
                                  "cannot be analyzed safely:", d$message))
          }
        }
      }
      msgs <- sort(unique(msgs))
      if (length(msgs)) msgs else NULL
    },

    ancestors = function(id) {
      if (is.null(private$dag)) return(character())
      edges <- private$dag$edges
      seen <- character()
      stack <- edges[[id]] %||% character()
      while (length(stack)) {
        cur <- stack[[1L]]
        stack <- stack[-1L]
        if (cur %in% seen) next
        seen <- c(seen, cur)
        stack <- c(stack, edges[[cur]] %||% character())
      }
      seen
    },

    descendants = function(id) {
      if (is.null(private$dag)) return(character())
      edges <- private$dag$edges
      dep_of <- function(x) {
        vapply(seq_along(edges), function(i) {
          if (x %in% edges[[i]]) names(edges)[[i]] else ""
        }, character(1))
      }
      seen <- character()
      stack <- setdiff(dep_of(id), "")
      while (length(stack)) {
        cur <- stack[[1L]]
        stack <- stack[-1L]
        if (cur %in% seen) next
        seen <- c(seen, cur)
        stack <- c(stack, setdiff(dep_of(cur), ""))
      }
      seen
    },

    set_cell = function(id, body, type, expected_revision = NULL) {
      perf <- .alder_perf_begin("source.edit", list(cell = id,
        expected_revision = expected_revision))
      on.exit(.alder_perf_end(perf), add = TRUE)
      private$assert_active()
      if (!id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      if (!type %in% c("code", "markdown")) {
        alder_abort("invalid_request",
                    "cell type must be \"code\" or \"markdown\"")
      }
      if (!is.character(body) || anyNA(body)) {
        alder_abort("invalid_request",
                    "cell body must be a character array")
      }
      old <- private$cell_state[[id]]
      if (!is.null(expected_revision)) {
        if (!alder_is_revision(expected_revision)) {
          alder_abort("invalid_request",
                      "expected_revision must be a non-negative integer")
        }
        if (!identical(as.integer(expected_revision), old$revision)) {
          alder_abort("source_conflict",
                      paste("cell", id, "changed on the server"))
        }
      }
      cs <- private$cell_source(id)
      if (identical(cs$body, body) && identical(cs$type, type)) {
        return(list(id = id, revision = old$revision,
                    version = private$state_version))
      }
      old_barrier <- isTRUE(private$analysis[[id]]$barrier)
      old_desc <- self$descendants(id)
      private$cancel_run_region(unique(c(id, old_desc)), "source")
      private$cancel_owned_ops(id)
      # re-read: cancellations can mutate the record; the pre-cancel copy
      # would clobber an op status flip back to pending
      old <- private$cell_state[[id]]
      # retain the stale output but mark the edited cell plus the union of
      # old/new descendants stale; source edits never execute user code.
      old$revision <- old$revision + 1L
      private$cell_state[[id]] <- old
      tryCatch(
        nb <- nb_update_cell(private$notebook, id, body, type),
        error = function(e) {
          if (identical(type, "markdown")) {
            alder_abort("invalid_request", conditionMessage(e))
          }
          stop(e)
        })
      private$notebook <- nb
      private$changed <- TRUE
      private$recompute()
      new_barrier <- isTRUE(private$analysis[[id]]$barrier)
      new_desc <- self$descendants(id)
      rec <- private$cell_state[[id]]
      private$bump()

      if (identical(type, "markdown")) {
        private$release_output_artifacts(rec$outputs)
        rec$status <- "done"
        rec$outputs <- list(render_markdown_cell_output(body))
        rec$progress <- NULL
        rec$log <- character()
        rec$error <- NULL
        rec$revision <- old$revision
        private$cell_state[[id]] <- rec
        for (d in unique(c(old_desc, new_desc))) {
          if (!is.null(private$cell_state[[d]])) private$mark_stale(d)
        }
      } else {
        affected <- unique(c(id, old_desc, new_desc))
        for (a in affected) {
          if (!is.null(private$cell_state[[a]])) private$mark_stale(a)
        }
        if (!identical(cs$type, type)) {
          private$release_output_artifacts(rec$outputs)
          rec$outputs <- list()
          rec$progress <- NULL
          private$cell_state[[id]] <- rec
        }
      # a code edit keeps its retained stale output/artifact and enqueues
      # worker-facing binding removal before any later eval of the cell
      private$enqueue_clear_cell(id)
      }
      if (old_barrier || new_barrier) private$handle_barrier_invalidation()
      private$refresh_button_resets()
      list(id = id, revision = old$revision, version = private$state_version)
    },

    # Apply formatter output as source edits. This deliberately reuses
    # set_cell so formatting has the same stale and clear-binding semantics
    # as a user edit and never executes a cell.
    format_source = function(cell = NULL, expected_revisions = NULL) {
      private$assert_active()
      ids <- vapply(private$notebook$cells, function(value) value$id, "")
      if (!is.null(cell) && (!is.character(cell) || length(cell) != 1L ||
          is.na(cell) || !cell %in% ids)) {
        alder_abort("not_found", "no such cell to format")
      }
      selected <- if (is.null(cell)) ids else cell
      if (!is.null(expected_revisions)) {
        keys <- names(expected_revisions)
        if (!is.list(expected_revisions) ||
            (length(selected) && is.null(keys)) || anyDuplicated(keys) ||
            !setequal(keys %||% character(), selected)) {
          alder_abort("invalid_request",
                      "expected_revisions must name every selected cell exactly once")
        }
        for (id in selected) {
          revision <- expected_revisions[[id]]
          if (!alder_is_revision(revision)) {
            alder_abort("invalid_request",
                        "expected revisions must be non-negative integers")
          }
          if (!identical(as.integer(revision), private$cell_state[[id]]$revision)) {
            alder_abort("source_conflict", paste("cell", id, "changed on the server"))
          }
        }
      }
      formatted <- format_notebook_source(private$notebook, cell)
      self$apply_formatted(formatted$bodies)
    },

    apply_formatted = function(bodies) {
      private$assert_active()
      if (!is.list(bodies) || is.null(names(bodies)) ||
          anyDuplicated(names(bodies))) {
        alder_abort("invalid_request", "formatted bodies must be a named list")
      }
      # Validate every target before the first mutation.
      for (id in names(bodies)) {
        if (!id %in% private$dag_nodes()) {
          alder_abort("not_found", paste("no such cell:", id))
        }
        body <- bodies[[id]]
        if (!is.character(body) || anyNA(body)) {
          alder_abort("invalid_request",
                      "formatted cell body must be a character array")
        }
      }
      changed <- 0L
      cells <- lapply(names(bodies), function(id) {
        body <- bodies[[id]]
        cell <- private$cell_source(id)
        previous_revision <- private$cell_state[[id]]$revision
        if (!identical(cell$body, body)) {
          self$set_cell(id, body, cell$type)
          changed <<- changed + 1L
        }
        list(id = id, body = I(body), type = cell$type,
             previous_revision = previous_revision,
             revision = private$cell_state[[id]]$revision)
      })
      list(changed = changed, version = private$state_version, cells = I(cells))
    },

    set_cell_disabled = function(id, disabled) {
      private$assert_active()
      if (!is.character(id) || length(id) != 1L || is.na(id) ||
          !id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      if (!is.logical(disabled) || length(disabled) != 1L ||
          is.na(disabled)) {
        alder_abort("invalid_request", "disabled must be a boolean")
      }
      disabled <- isTRUE(disabled)
      cell <- private$cell_source(id)
      was_disabled <- identical(cell$options$disabled %||% NULL, TRUE)
      if (identical(was_disabled, disabled)) {
        return(list(id = id, disabled = disabled,
                    version = private$state_version, run_id = NULL))
      }

      affected <- unique(c(id, self$descendants(id)))
      if (disabled) private$cancel_run_region(affected, "source")
      private$notebook <- tryCatch(
        nb_set_cell_option(private$notebook, id, "disabled", disabled),
        error = function(e) alder_abort("invalid_request",
                                        conditionMessage(e))
      )
      private$changed <- TRUE
      for (target in affected) {
        rec <- private$cell_state[[target]]
        if (!is.null(rec) && !identical(rec$status, "running")) {
          rec$status <- "stale"
          private$cell_state[[target]] <- rec
        }
      }
      private$bump()

      run_id <- NULL
      if (!disabled && identical(private$execution_mode, "automatic") &&
          identical(cell$type, "code") &&
          is.null(private$current) && !length(private$queue) &&
          self$worker_available()) {
        plan <- self$plan_cell_run(id, "app")
        if (length(plan)) run_id <- private$launch_run(plan)
      }
      list(id = id, disabled = disabled,
           version = private$state_version, run_id = run_id)
    },

    set_cell_name = function(id, name = NULL) {
      private$assert_active()
      if (!is.character(id) || length(id) != 1L || is.na(id) ||
          !id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      if (!is.null(name)) {
        tryCatch(
          validate_cell_name(name),
          error = function(e) alder_abort("invalid_request",
                                          conditionMessage(e))
        )
      }
      cell <- private$cell_source(id)
      current <- cell$options$name %||% NULL
      if (identical(current, name)) {
        return(list(id = id, name = name, version = private$state_version))
      }
      private$notebook <- tryCatch(
        nb_set_cell_option(private$notebook, id, "name", name),
        error = function(e) alder_abort("invalid_request",
                                        conditionMessage(e))
      )
      private$changed <- TRUE
      private$recompute()
      private$bump()
      list(id = id, name = name, version = private$state_version)
    },

    move_cell = function(id, after = NULL) {
      private$assert_active()
      if (!is.character(id) || length(id) != 1L || is.na(id) ||
          !id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      if (!is.null(after) &&
          (!is.character(after) || length(after) != 1L || is.na(after))) {
        alder_abort("invalid_request", "after must be a cell id or null")
      }
      if (!is.null(after) && !after %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", after))
      }
      before <- vapply(private$notebook$cells, function(cell) cell$id, "")
      private$notebook <- tryCatch(
        nb_move_cell(private$notebook, id, after),
        error = function(e) alder_abort("invalid_request",
                                        conditionMessage(e))
      )
      current <- vapply(private$notebook$cells, function(cell) cell$id, "")
      if (!identical(before, current)) {
        private$changed <- TRUE
        private$recompute()
        private$bump()
      }
      list(id = id, after = after, version = private$state_version)
    },

    add_cell = function(after = NULL, body = character(), type = "code") {
      private$assert_active()
      if (!is.null(after) && !after %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", after))
      }
      if (!type %in% c("code", "markdown")) {
        alder_abort("invalid_request",
                    "cell type must be \"code\" or \"markdown\"")
      }
      if (identical(type, "markdown")) {
        tryCatch(validate_markdown_lines(body, "<new cell>"),
                 error = function(e) alder_abort("invalid_request",
                                                 conditionMessage(e)))
      }
      before_ids <- vapply(private$notebook$cells, function(c) c$id, "")
      nb <- nb_add_cell(private$notebook, body, type, after)
      private$notebook <- nb
      private$changed <- TRUE
      private$recompute()
      after_ids <- vapply(private$notebook$cells, function(c) c$id, "")
      new_id <- setdiff(after_ids, before_ids)
      new_id <- if (length(new_id)) new_id[[1L]] else {
        alder_abort("internal_error", "failed to identify the new cell")
      }
      if (identical(type, "markdown")) {
        rec <- private$cell_state[[new_id]]
        rec$status <- "done"
        rec$outputs <- list(render_markdown_cell_output(body))
        rec$progress <- NULL
        private$cell_state[[new_id]] <- rec
      } else if (isTRUE(private$analysis[[new_id]]$barrier)) {
        private$handle_barrier_invalidation()
      } else {
        # introducing a definition must not leave a prior consumer current
        for (d in self$descendants(new_id)) {
          if (!is.null(private$cell_state[[d]])) private$mark_stale(d)
        }
      }
      private$bump()
      list(id = new_id, revision = 0L, version = private$state_version)
    },

    delete_cell = function(id, expected_revision = NULL) {
      private$assert_active()
      if (!id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      old <- private$cell_state[[id]]
      if (!is.null(expected_revision)) {
        if (!alder_is_revision(expected_revision)) {
          alder_abort("invalid_request",
                      "expected_revision must be a non-negative integer")
        }
        if (!identical(as.integer(expected_revision), old$revision)) {
          alder_abort("source_conflict",
                      paste("cell", id, "changed on the server"))
        }
      }
      old_barrier <- isTRUE(private$analysis[[id]]$barrier)
      old_desc <- self$descendants(id)
      private$cancel_owned_ops(id)
      private$release_output_artifacts(old$outputs)
      private$cell_state[[id]] <- NULL
      private$notebook <- nb_delete_cell(private$notebook, id)
      private$changed <- TRUE
      private$recompute()
      # removing a definition cannot leave a prior consumer current
      for (d in old_desc) {
        if (!is.null(private$cell_state[[d]])) private$mark_stale(d)
      }
      if (old_barrier) private$handle_barrier_invalidation()
      private$enqueue_clear_cell(id)
      private$refresh_button_resets()
      private$bump()
      list(id = id, version = private$state_version)
    },

    # Plan the run for one explicitly requested cell: idle/stale/error
    # ancestors in topological order, then the target, then (in automatic
    # or app mode) a dependency-closed closure.
    plan_cell_run = function(id, source = c("editor", "app")) {
      source <- match.arg(source)
      private$assert_active()
      if (!id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      if (identical(private$cell_type(id), "markdown")) return(character())
      g <- self$validate_graph()
      if (!is.null(g)) {
        alder_abort("graph_invalid", paste(g, collapse = "\n"), messages = g)
      }
      anc <- self$ancestors(id)
      plan <- private$needs_run(anc)
      plan <- c(plan, id)
      if (identical(source, "app") || identical(private$execution_mode, "automatic")) {
        private$automatic_closure(plan)
      } else {
        private$topo_order_of(plan)
      }
    },

    run_cell = function(id) {
      private$assert_can_launch()
      plan <- self$plan_cell_run(id, "editor")
      rid <- private$launch_run(plan)
      list(run_id = rid, version = private$state_version)
    },

    # Global automatic run: enqueue every code cell in topological order.
    run_all = function() {
      private$assert_can_launch()
      g <- self$validate_graph()
      if (!is.null(g)) {
        alder_abort("graph_invalid", paste(g, collapse = "\n"), messages = g)
      }
      targets <- private$topo[vapply(private$topo, function(id)
        identical(private$cell_type(id), "code"), FALSE)]
      rid <- private$launch_run(targets)
      list(run_id = rid, version = private$state_version)
    },

    # Lazy global action: every idle/stale/error code cell plus required
    # (idle/stale/error) ancestors.
    run_stale = function() {
      private$assert_can_launch()
      g <- self$validate_graph()
      if (!is.null(g)) {
        alder_abort("graph_invalid", paste(g, collapse = "\n"), messages = g)
      }
      targets <- private$topo[vapply(private$topo, function(id)
        identical(private$cell_type(id), "code") &&
        private$status_of(id) %in% c("idle", "stale", "error"), FALSE)]
      plan <- private$lazy_closure(targets)
      rid <- private$launch_run(plan)
      list(run_id = rid, version = private$state_version)
    },

    # Stop: mark the active identity, remove and leave stale its queued
    # same-run descendants, and send one ack-gated SIGINT. The active
    # cell's response remains authoritative: success commits; only the
    # matching interrupted response becomes Error: Interrupted.
    interrupt = function() {
      private$assert_not_stopped()
      cur <- private$current
      if (is.null(cur) || !is.null(cur$cancel_mode)) {
        alder_abort("no_run_in_progress", "no run in progress")
      }
      cur$cancel_mode <- "stop"
      private$current <- cur
      keep <- vapply(private$queue, function(j) !identical(j$run_id, cur$job$run_id),
                     FALSE)
      if (!all(keep)) private$queue <- private$queue[keep]
      if (self$worker_available()) private$worker$interrupt(cur$req)
      private$bump()
      list(run_id = cur$job$run_id, version = private$state_version)
    },

    set_runtime = function(execution_mode = NULL, run_on_startup = NULL) {
      private$assert_active()
      if (is.null(execution_mode) && is.null(run_on_startup)) {
        alder_abort("invalid_request",
                    "provide execution_mode or run_on_startup")
      }
      if (!is.null(execution_mode) &&
          (!is.character(execution_mode) || length(execution_mode) != 1L ||
           is.na(execution_mode) ||
           !execution_mode %in% c("automatic", "lazy"))) {
        alder_abort("invalid_request",
                    "execution_mode must be automatic or lazy")
      }
      if (!is.null(run_on_startup) &&
          (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
           is.na(run_on_startup))) {
        alder_abort("invalid_request",
                    "run_on_startup must be a boolean")
      }
      em <- if (is.null(execution_mode)) private$execution_mode else
        execution_mode
      ros <- if (is.null(run_on_startup)) private$run_on_startup else
        isTRUE(run_on_startup)
      runtime <- private$notebook$metadata$runtime %||% list()
      if (!is.list(runtime)) runtime <- list()
      runtime$execution_mode <- em
      runtime$run_on_startup <- ros
      private$notebook <- tryCatch(
        nb_set_metadata(private$notebook, "runtime", runtime),
        error = function(e) alder_abort("invalid_request",
                                        conditionMessage(e))
      )
      private$execution_mode <- em
      private$run_on_startup <- ros
      refreshed <- tryCatch(
        resolve_alder_config(private$notebook$path, private$notebook$metadata),
        error = function(e) NULL
      )
      if (!is.null(refreshed)) {
        private$config <- refreshed
      } else {
        private$config$on_cell_change <- em
        private$config$on_startup <- ros
      }
      private$changed <- TRUE
      private$last_action_error <- NULL
      private$bump()
      list(execution_mode = em, run_on_startup = ros,
           version = private$state_version)
    },
    # Validate and persist notebook app presentation metadata.
    set_app = function(updates) {
      private$assert_active()
      if (!exists("alder_set_app_config", mode = "function")) {
        alder_abort("internal_error", "app configuration is unavailable")
      }
      private$notebook <- tryCatch(
        alder_set_app_config(private$notebook, updates),
        error = function(e) {
          if (inherits(e, "alder_error")) stop(e)
          alder_abort("invalid_request", conditionMessage(e))
        }
      )
      private$changed <- TRUE
      private$last_action_error <- NULL
      private$bump()
      list(app = alder_app_config(private$notebook),
           version = private$state_version)
    },
    # Validate and atomically persist the independent app-layout sidecar.
    # Layout edits do not change notebook source bytes, but they do advance
    # the client-visible state version so app view can re-render immediately.
    set_layout = function(layout) {
      private$assert_active()
      path <- private$notebook$path
      if (is.null(path) || !is.character(path) || length(path) != 1L ||
          is.na(path) || !nzchar(path)) {
        alder_abort("notebook_has_no_path",
                    "layout requires a notebook path")
      }
      if (!exists("alder_layout_validate", mode = "function") ||
          !exists("alder_layout_write", mode = "function")) {
        alder_abort("internal_error", "layout support is unavailable")
      }
      checked <- alder_layout_validate(layout)
      persisted <- alder_layout_write(path, checked)
      private$layout <- persisted
      private$layout_error <- NULL
      private$last_action_error <- NULL
      private$bump()
      list(layout = persisted, version = private$state_version)
    },

    # Validate, persist, and apply a partial layered-config update.  Only the
    # project file is written; user configuration remains read-only.
    set_config = function(patch) {
      private$assert_active()
      if (!is.list(patch) || (length(patch) && is.null(names(patch)))) {
        config_invalid("config", "must be a mapping")
      }
      normalized <- validate_config_layer(patch, partial = TRUE)
      path <- private$notebook$path
      if (is.null(path) || !nzchar(path) || is.na(path)) {
        alder_abort("notebook_has_no_path", "configuration requires a notebook path")
      }
      project <- read_config_file(config_project_file(path))
      project <- merge_config(project, normalized)
      write_project_config(path, project)

      # Runtime controls have an existing metadata/API contract.  Keep that
      # path authoritative while the other keys apply directly to Session.
      if (!is.null(normalized$on_cell_change) ||
          !is.null(normalized$on_startup)) {
        self$set_runtime(
          execution_mode = normalized$on_cell_change %||% NULL,
          run_on_startup = normalized$on_startup %||% NULL
        )
      }
      private$config <- tryCatch(
        resolve_alder_config(path, private$notebook$metadata,
                             project = project),
        error = function(e) private$config
      )
      if (!isTRUE(private$config$editor$live_diagnostics)) {
        # This also clears retained notes if the language server has died.
        self$set_lsp_diagnostics(list())
      }
      private$changed <- TRUE
      private$last_action_error <- NULL
      private$bump()
      list(config = private$config, version = private$state_version)
    },
    # Package declarations and installation are owned by the live Session so
    # state() updates immediately and successful installs invalidate the
    # worker's package-attachment barrier.
    declare_packages = function(packages) {
      private$assert_active()
      path <- private$notebook$path
      if (is.null(path) || !is.character(path) || length(path) != 1L ||
          is.na(path) || !nzchar(path)) {
        alder_abort("notebook_has_no_path",
                    "package declarations require a notebook path")
      }
      result <- alder_declare(packages, path)
      private$package_error <- NULL
      private$bump()
      result
    },

    install_packages = function(packages = character()) {
      private$assert_active()
      packages <- .alder_validate_package_names(packages, allow_empty = FALSE)
      path <- private$notebook$path
      project <- .alder_package_path(path)
      target <- private$package_lib
      if (is.null(target)) target <- .alder_install_library(project)
      else target <- .alder_install_library(project, target)
      before <- alder_package_status(
        packages, lib.loc = unique(c(target, .libPaths()))
      )
      needed <- before$package[before$status == "missing"]
      private$package_error <- NULL
      private$package_log <- ""
      if (!length(needed)) {
        private$bump()
        return(list(status = "installed", path = project, lib = target,
                    packages = packages, installed = packages,
                    missing = character(), installing = character(),
                    log = ""))
      }

      key <- normalizePath(project, mustWork = FALSE)
      if (exists(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)) {
        existing <- get(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)
        current <- tryCatch(existing$poll(), error = function(e) NULL)
        if (is.list(current) && identical(current$status, "installing")) {
          alder_abort("operation_in_progress",
                      "a package installation is already in progress")
        }
        rm(list = key, envir = ALDER_PACKAGE_JOBS)
      }
      process <- tryCatch(
        processx::process$new(
          file.path(R.home("bin"), "Rscript"),
          args = c("--vanilla", "-e", .alder_install_script(),
                   "--args", needed),
          env = c(ALDER_PACKAGE_LIB = target, R_LIBS_USER = target),
          stdout = "|", stderr = "|", supervise = TRUE
        ),
        error = function(e) e
      )
      if (inherits(process, "error")) {
        err <- list(code = "install_failed",
                    message = conditionMessage(process),
                    output = "", status = NA_integer_)
        private$package_error <- err
        private$bump()
        alder_abort("install_failed", err$message)
      }

      job_env <- new.env(parent = emptyenv())
      job_env$process <- process
      job_env$key <- key
      job_env$project <- project
      job_env$target <- target
      job_env$packages <- needed
      job_env$log <- ""
      job_env$finished <- FALSE
      drain <- function() {
        out <- tryCatch(job_env$process$read_output_lines(),
                        error = function(e) character())
        err <- tryCatch(job_env$process$read_error_lines(),
                        error = function(e) character())
        lines <- c(out %||% character(), err %||% character())
        if (length(lines)) {
          job_env$log <- .alder_bound_output(
            paste(c(job_env$log, lines), collapse = "\n")
          )
          private$package_log <- job_env$log
        }
        invisible()
      }
      finish <- function(ok, error = NULL) {
        if (isTRUE(job_env$finished)) return(job_env$result)
        job_env$finished <- TRUE
        if (exists(job_env$key, envir = ALDER_PACKAGE_JOBS,
                   inherits = FALSE)) {
          rm(list = job_env$key, envir = ALDER_PACKAGE_JOBS)
        }
        private$package_log <- job_env$log
        if (isTRUE(ok)) {
          private$package_error <- NULL
          private$handle_barrier_invalidation()
          if (is.null(private$current) && self$worker_available()) {
            tryCatch(private$worker$restart(), error = function(e) NULL)
            private$barrier_restart_required <- FALSE
          }
        } else {
          private$package_error <- error %||% list(
            code = "install_failed",
            message = "package installation failed",
            output = job_env$log
          )
        }
        private$bump()
        job_env$result <- list(
          status = if (isTRUE(ok)) "installed" else "error",
          packages = job_env$packages, log = job_env$log,
          error = if (isTRUE(ok)) NULL else private$package_error
        )
        job_env$result
      }
      poll <- function() {
        drain()
        if (job_env$process$is_alive()) {
          return(list(status = "installing", packages = job_env$packages,
                      log = job_env$log))
        }
        status <- tryCatch(job_env$process$get_exit_status(),
                           error = function(e) NA_integer_)
        if (is.null(status) || is.na(status)) status <- 1L
        if (!identical(as.integer(status), 0L)) {
          parsed <- .alder_install_error(job_env$log, "", as.integer(status))
          return(finish(FALSE, parsed))
        }
        after <- alder_package_status(
          job_env$packages,
          lib.loc = unique(c(job_env$target, .libPaths()))
        )
        missing <- after$package[after$status == "missing"]
        if (length(missing)) {
          return(finish(FALSE, list(
            code = "install_failed",
            message = paste("packages remain unavailable:",
                            paste(missing, collapse = ", ")),
            output = job_env$log, status = 0L
          )))
        }
        finish(TRUE)
      }
      cancel <- function() {
        if (isTRUE(job_env$finished)) return(invisible(job_env$result))
        drain()
        if (job_env$process$is_alive()) {
          tryCatch(job_env$process$kill(), error = function(e) NULL)
        }
        tryCatch(job_env$process$wait(5000), error = function(e) NULL)
        job_env$finished <- TRUE
        job_env$result <- list(
          status = "cancelled", packages = job_env$packages,
          log = job_env$log, error = NULL
        )
        if (exists(job_env$key, envir = ALDER_PACKAGE_JOBS,
                   inherits = FALSE)) {
          rm(list = job_env$key, envir = ALDER_PACKAGE_JOBS)
        }
        invisible(job_env$result)
      }
      job <- list(packages = needed, poll = poll, cancel = cancel)
      assign(key, job, envir = ALDER_PACKAGE_JOBS)
      check <- function() {
        current <- tryCatch(poll(), error = function(e) {
          finish(FALSE, list(code = "install_failed",
                             message = conditionMessage(e),
                             output = job_env$log))
        })
        if (is.list(current) && identical(current$status, "installing")) {
          later::later(check, 0.05)
        }
        invisible()
      }
      later::later(check, 0)
      private$bump()
      list(status = "installing", path = project, lib = target,
           packages = needed, installed = character(), missing = needed,
           installing = needed, log = "")
    },

    # Startup configuration failures are non-fatal: the server starts with
    # built-in defaults and exposes this diagnostic through state().
    record_config_error = function(message, code = "config_invalid") {
      private$note_action_error(NULL, code, as.character(message))
      private$bump()
      invisible()
    },
    # Record a non-fatal server-side action failure while retaining the
    # notebook/session state (used by snapshot export after save).
    record_action_error = function(message, code = "internal_error") {
      private$note_action_error(NULL, code, as.character(message))
      private$bump()
      invisible()
    },

    # Clear only the operational failure that the caller successfully
    # recovered. This avoids an LSP request erasing an unrelated save or
    # worker failure banner.
    clear_action_error = function(code = NULL) {
      current <- private$last_action_error
      if (is.null(current)) return(invisible(FALSE))
      if (!is.null(code) && (is.null(current$code) ||
          !(current$code %in% as.character(code)))) {
        return(invisible(FALSE))
      }
      private$last_action_error <- NULL
      private$bump()
      invisible(TRUE)
    },

    # Long-lived subsystem failures survive unrelated successful notebook
    # actions. They remain visible until that subsystem itself recovers.
    record_service_error = function(service, message,
                                    code = "service_unavailable") {
      service <- as.character(service)
      if (length(service) != 1L || is.na(service) || !nzchar(service)) {
        alder_abort("invalid_request", "service must be one nonempty string")
      }
      error <- list(token = NULL, code = as.character(code),
                    message = as.character(message), service = service)
      if (identical(private$service_errors[[service]], error)) {
        return(invisible(FALSE))
      }
      private$service_errors[[service]] <- error
      private$bump()
      invisible(TRUE)
    },

    clear_service_error = function(service) {
      service <- as.character(service)
      if (length(service) != 1L || is.na(service) ||
          !nzchar(service) || is.null(private$service_errors[[service]])) {
        return(invisible(FALSE))
      }
      private$service_errors[[service]] <- NULL
      private$bump()
      invisible(TRUE)
    },

    # Read-only current runtime mode for server dispatch (e.g. which global
    # run action applies).
    get_execution_mode = function() {
      private$execution_mode
    },

    # Apply a widget update, returning the operation token. Throws 409
    # operation_in_progress when the same widget already has a pending op.
    set_widget = function(name, path = character(), update = NULL,
                           source = c("editor", "app")) {
      # Keep set_widget(name, update, source) compatible with existing users.
      if (is.list(path) && (is.null(update) || is.character(update))) {
        old_update <- path
        old_source <- if (is.character(update) && length(update) == 1L) {
          update
        } else {
          source[[1L]]
        }
        path <- character()
        update <- old_update
        source <- old_source
      }
      source <- match.arg(source)
      private$assert_active()
      g <- self$validate_graph()
      if (!is.null(g)) {
        alder_abort("graph_invalid", paste(g, collapse = "\n"), messages = g)
      }
      if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name)) {
        alder_abort("invalid_request", "widget name invalid")
      }
      if (is.null(path)) path <- character()
      if (!is.character(path) || anyNA(path) || any(!nzchar(path))) {
        alder_abort("invalid_request", "widget path invalid")
      }
      location <- private$find_widget_output(name)
      if (is.null(location)) {
        alder_abort("invalid_request", paste("no such widget:", name))
      }
      owner <- location$id
      rec <- private$cell_state[[owner]]
      out <- location$output
      if (!identical(rec$status, "done") || is.null(out) ||
          !identical(out$kind, "widget")) {
        alder_abort("widget_not_current",
                    paste("widget", name, "is not current"))
      }
      target_spec <- private$widget_spec_at(out$spec, path)
      if (is.null(target_spec)) {
        alder_abort("invalid_request", "widget path does not exist")
      }
      draft <- private$widget_path_has_form(out$spec, path) &&
        !isTRUE(update$submit)
      if (identical(target_spec$kind, "form") && !isTRUE(update$submit)) {
        target_spec <- target_spec$child
      }
      kind <- as.character(target_spec$kind %||% "")
      if (length(kind) != 1L || is.na(kind) || !nzchar(kind)) {
        alder_abort("invalid_request", "widget path does not exist")
      }
      if (is.null(update)) alder_abort("invalid_request", "widget update missing")
      update <- private$validate_widget_update(kind, update)
      key <- private$widget_operation_key(name, path)
      ops <- out$operations %||% list()
      op <- ops[[key]] %||% NULL
      if (!is.null(op) && identical(op$status, "pending")) {
        alder_abort("operation_in_progress",
                    paste("widget", name, "already has a pending update"))
      }
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      pending <- list(token = tok, status = "pending", error = NULL)
      reset_expected <- identical(kind, "run_button") && !isTRUE(draft) &&
        (identical(source, "app") ||
         identical(private$execution_mode, "automatic") ||
         !length(private$cells_referencing(name, owner)))
      private$remember_widget_operation(c(
        pending, list(reset_expected = reset_expected)
      ))
      ops[[key]] <- pending
      out$operations <- ops
      if (!length(path)) out$operation <- pending
      private$set_widget_output(owner, name, out)
      private$bump()

      send_args <- c(list(name = name, path = I(path), op_id = as.integer(tok)),
                     update)
      do.call(private$worker$send,
              c(list("set_widget"), send_args,
                list(on_response = function(context, resp)
                  private$on_widget_response(name, owner, tok, kind, path,
                                             resp, source, update, draft))))
      tok
    },

    # Inspect one top-level value; results land in state()$last_value.
    request_value = function(name) {
      private$assert_active()
      if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name)) {
        alder_abort("invalid_request", "value name invalid")
      }
      private$refresh_value_freshness()
      vop <- private$value_operation
      if (!is.null(vop) && identical(vop$status, "pending")) {
        alder_abort("operation_in_progress", "a value request is already pending")
      }
      if (!self$worker_available()) {
        alder_abort("worker_unavailable", "worker is not available")
      }
      owner <- private$value_owner(name)
      revision <- if (!is.null(owner)) private$cell_state[[owner]]$revision else NULL
      if (!private$value_is_current(name, owner, revision)) {
        private$refresh_value_freshness()
        alder_abort("stale_value", private$stale_value_message(name))
      }
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      private$value_operation <- list(token = tok, name = name,
                                      owner = owner, revision = revision,
                                      status = "pending", error = NULL)
      private$bump()
      private$worker$send("get_value", name = name, token = as.integer(tok),
                          on_response = function(context, resp)
                            private$on_value_response(name, tok, resp))
      tok
    },
    # Expand one output/lazy thunk. The key is scoped to the defining cell
    # run; a rerun removes it and makes this request return lazy_expired.
    request_lazy = function(key) {
      private$assert_active()
      if (!is.character(key) || length(key) != 1L || is.na(key) ||
          !nzchar(key)) {
        alder_abort("invalid_request", "lazy output key invalid")
      }
      loc <- private$find_lazy_output(key)
      if (is.null(loc)) {
        alder_abort("lazy_expired",
                    "this lazy output belongs to an earlier run of the cell")
      }
      op <- private$lazy_operations[[key]]
      if (!is.null(op) && identical(op$status, "pending")) {
        alder_abort("operation_in_progress",
                    "lazy output already has a pending evaluation")
      }
      if (!self$worker_available()) {
        alder_abort("worker_unavailable", "worker is not available")
      }
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      private$lazy_operations[[key]] <- list(
        token = tok, cell_id = loc$id, status = "pending")
      private$bump()
      private$worker$send(
        "lazy_eval", key = key, id = loc$id, token = as.integer(tok),
        on_response = function(context, resp)
          private$on_lazy_response(key, loc$id, tok, resp))
      tok
    },
    # Request a bounded page for a rendered table without mutating notebook
    # state or scheduling execution.
    request_table_page = function(handle, offset = 0, limit = 25,
                                  sort_by = "", sort_desc = FALSE,
                                  filter = "") {
      private$assert_active()
      scalar_num <- function(x) is.numeric(x) && length(x) == 1L &&
        !is.na(x) && is.finite(x)
      if (!is.character(handle) || length(handle) != 1L || is.na(handle) ||
          !nzchar(handle) || any(charToRaw(handle) == as.raw(0)) ||
          !scalar_num(offset) || offset < 0 || offset != floor(offset) ||
          !scalar_num(limit) || limit < 1 ||
          !is.character(sort_by) || length(sort_by) != 1L ||
          is.na(sort_by) || !is.character(filter) || length(filter) != 1L ||
          is.na(filter) || !is.logical(sort_desc) || length(sort_desc) != 1L ||
          is.na(sort_desc)) {
        alder_abort("invalid_request", "table paging arguments invalid")
      }
      loc <- private$find_table_output(handle)
      if (is.null(loc)) {
        alder_abort("table_unavailable", "table is unavailable")
      }
      if (!self$worker_available()) {
        alder_abort("worker_unavailable", "worker is not available")
      }
      op <- private$table_operations[[handle]]
      if (!is.null(op) && identical(op$status, "pending")) {
        alder_abort("operation_in_progress",
                    "table paging request already pending")
      }
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      private$table_operations[[handle]] <- list(
        token = tok, cell_id = loc$id, status = "pending")
      private$bump()
      private$worker$send(
        "table_page", handle = handle, offset = as.integer(offset),
        limit = as.integer(limit), sort_by = sort_by,
        sort_desc = sort_desc, filter = filter, token = as.integer(tok),
        on_response = function(context, resp)
          private$on_table_response(handle, loc$id, tok, resp))
      tok
    },

    # Atomic save. Re-reads the path and compares exact bytes against the
    # recorded disk version; a mismatch is a 409 conflict. Creating a path
    # that does not exist yet is only ever done here.
    save = function() {
      private$assert_active()
      path <- private$notebook$path
      if (is.null(path) || !nzchar(path) || is.na(path)) {
        alder_abort("notebook_has_no_path", "notebook has no path")
      }
      expect <- private$disk_version
      cur_exists <- file.exists(path)
      cur_bytes <- if (cur_exists) {
        readBin(path, "raw", n = file.info(path)$size)
      } else {
        raw()
      }
      if (identical(expect$exists, FALSE)) {
        if (cur_exists) {
          alder_abort("alder_save_conflict",
                      "notebook changed on disk; restart alder before saving")
        }
      } else {
        if (!cur_exists || !identical(cur_bytes, expect$bytes)) {
          alder_abort("alder_save_conflict",
                      "notebook changed on disk; restart alder before saving")
        }
      }
      write_notebook_atomic(private$notebook, private$disk_version)
      new_bytes <- readBin(path, "raw", n = file.info(path)$size)
      private$disk_version <- list(exists = TRUE, bytes = new_bytes)
      private$changed <- FALSE
      private$last_action_error <- NULL
      private$bump()
      list(path = path, etag = notebook_etag(private$notebook),
           version = private$state_version)
    },

    restart_worker = function(replay = TRUE) {
      private$assert_not_stopped()
      if (!is.logical(replay) || length(replay) != 1L || is.na(replay)) {
        alder_abort("invalid_request", "replay must be TRUE or FALSE")
      }
      if (is.null(private$worker)) {
        alder_abort("worker_unavailable", "R worker is unavailable")
      }
      if (!is.null(private$current) || length(private$queue)) {
        alder_abort("run_in_progress", "cannot restart while a run is active")
      }
      # The old process owns every retained runtime value. Its replacement
      # invalidates that view even when spawning or readiness later fails.
      private$invalidate_runtime_view()
      private$bump()
      tryCatch({
        private$worker$restart()
        .wait_for_worker(private$worker)
      }, error = function(e) {
        # Restart teardown can fail old callbacks after the initial reset.
        private$invalidate_runtime_view()
        private$worker_failed <- TRUE
        private$note_action_error(NULL, "worker_unavailable",
                                  conditionMessage(e))
        private$bump()
        alder_abort("worker_unavailable", conditionMessage(e))
      })
      private$worker_failed <- FALSE
      private$invalidate_runtime_view()
      private$last_action_error <- NULL
      private$bump()
      run_id <- NULL
      if (isTRUE(replay)) run_id <- self$run_all()$run_id
      list(run_id = run_id, version = private$state_version)
    },

    stop = function() {
      if (private$stopped) return(invisible())
      private$stopped <- TRUE
      project <- tryCatch(
        .alder_package_path(private$notebook$path),
        error = function(e) NULL
      )
      if (!is.null(project)) {
        key <- normalizePath(project, mustWork = FALSE)
        if (exists(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)) {
          job <- get(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)
          if (is.function(job$cancel)) {
            tryCatch(job$cancel(), error = function(e) NULL)
          }
          if (exists(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)) {
            rm(list = key, envir = ALDER_PACKAGE_JOBS)
          }
        }
      }
      if (!is.null(private$worker)) {
        private$worker$stop(grace = 0.2)
        if (private$worker$alive()) {
          private$worker$kill()
        }
      }
      invisible()
    },

    active = function() !private$stopped
  ),

  private = list(
    reactive_range_cache = NULL,
    notebook = NULL,
    analysis = list(),
    dag = NULL,
    topo = character(),
    cell_state = list(),
    worker = NULL,
    queue = list(),
    current = NULL,
    execution_mode = "automatic",
    run_on_startup = TRUE,
    config = config_defaults(),
    state_version = 0L,
    layout = NULL,
    layout_error = NULL,
    changed = FALSE,
    run_counter = 0L,
    op_counter = 0L,
    worker_failed = FALSE,
    stopped = FALSE,
    barrier_restart_required = FALSE,
    button_resets = list(),
    run_operation_results = list(),
    widget_operation_results = list(),
    last_action_error = NULL,
    service_errors = list(),
    last_value = NULL,
    value_operation = NULL,
    lazy_operations = list(),
    variables = list(),
    package_lib = NULL,
    package_error = NULL,
    package_log = "",
    variables_operation = NULL,
    table_operations = list(),
    lsp_diagnostics = list(),
    disk_version = list(exists = NA, bytes = raw()),


    wire_date_valid = function(x) {
      if (!is.character(x) || length(x) != 1L || is.na(x) ||
          !grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", x)) return(FALSE)
      parsed <- tryCatch(as.Date(x, format = "%Y-%m-%d"),
                         error = function(e) as.Date(NA))
      !is.na(parsed) && identical(format(parsed, "%Y-%m-%d"), x)
    },
    wire_datetime_valid = function(x) {
      if (!is.character(x) || length(x) != 1L || is.na(x) ||
          !grepl(paste0(
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}T",
            "[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
          ), x)) return(FALSE)
      parsed <- tryCatch(
        as.POSIXct(x, tz = "UTC", format = "%Y-%m-%dT%H:%M:%SZ"),
        error = function(e) as.POSIXct(NA, origin = "1970-01-01")
      )
      !is.na(parsed) && identical(
        format(parsed, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"), x)
    },

    dag_nodes = function() as.character(private$dag$nodes %||% character()),
    cell_source = function(id) nb_cell(private$notebook, id),
    cell_body = function(id) nb_cell(private$notebook, id)$body,
    cell_type = function(id) nb_cell(private$notebook, id)$type,
    cell_disabled = function(id) {
      cell <- nb_cell(private$notebook, id)
      !is.null(cell) && identical(cell$options$disabled %||% NULL, TRUE)
    },
    cell_record = function(id) private$cell_state[[id]],
    status_of = function(id) {
      rec <- private$cell_state[[id]]
      if (is.null(rec)) return("idle")
      if (private$cell_disabled(id) && !identical(rec$status, "running")) {
        "disabled"
      } else {
        rec$status
      }
    },
    visible_output = function(id) {
      rec <- private$cell_state[[id]]
      if (is.null(rec) || !length(rec$outputs)) return(NULL)
      rec$outputs[[length(rec$outputs)]]
    },
    set_visible_output = function(id, output) {
      rec <- private$cell_state[[id]]
      if (is.null(rec)) return(invisible())
      if (!length(rec$outputs)) rec$outputs <- list(output)
      else rec$outputs[[length(rec$outputs)]] <- output
      private$cell_state[[id]] <- rec
      invisible()
    },
    find_widget_in_output = function(output, name) {
      if (!is.list(output)) return(NULL)
      if (identical(output$kind %||% NULL, "widget") &&
          identical(output$name %||% NULL, name)) {
        return(output)
      }
      if (identical(output$kind %||% NULL, "layout")) {
        for (child in output$children %||% list()) {
          found <- private$find_widget_in_output(child, name)
          if (!is.null(found)) return(found)
        }
      } else if (identical(output$kind %||% NULL, "lazy") &&
                 !is.null(output$child)) {
        return(private$find_widget_in_output(output$child, name))
      }
      NULL
    },
    find_widget_output = function(name) {
      for (id in private$dag_nodes()) {
        rec <- private$cell_state[[id]]
        outputs <- rec$outputs %||% list()
        for (i in rev(seq_along(outputs))) {
          found <- private$find_widget_in_output(outputs[[i]], name)
          if (!is.null(found)) return(list(id = id, output = found))
        }
      }
      NULL
    },
    map_widgets_in_output = function(output, transform) {
      if (!is.list(output)) return(output)
      if (identical(output$kind %||% NULL, "widget")) {
        return(transform(output))
      }
      if (identical(output$kind %||% NULL, "layout")) {
        output$children <- lapply(
          output$children %||% list(),
          private$map_widgets_in_output,
          transform = transform
        )
      } else if (identical(output$kind %||% NULL, "lazy") &&
                 !is.null(output$child)) {
        output$child <- private$map_widgets_in_output(
          output$child, transform)
      }
      output
    },
    map_cell_widgets = function(id, transform) {
      rec <- private$cell_state[[id]]
      if (is.null(rec)) return(invisible(FALSE))
      rec$outputs <- lapply(
        rec$outputs %||% list(),
        private$map_widgets_in_output,
        transform = transform
      )
      private$cell_state[[id]] <- rec
      invisible(TRUE)
    },
    set_widget_output = function(id, name, widget) {
      private$map_cell_widgets(id, function(output) {
        if (identical(output$name %||% NULL, name)) widget else output
      })
    },
    find_lazy_in_output = function(output, key) {
      if (!is.list(output)) return(NULL)
      if (identical(output$kind %||% NULL, "lazy") &&
          identical(output$key %||% NULL, key)) {
        return(output)
      }
      if (identical(output$kind %||% NULL, "layout")) {
        for (child in output$children %||% list()) {
          found <- private$find_lazy_in_output(child, key)
          if (!is.null(found)) return(found)
        }
      } else if (identical(output$kind %||% NULL, "lazy") &&
                 !is.null(output$child)) {
        return(private$find_lazy_in_output(output$child, key))
      }
      NULL
    },
    find_lazy_output = function(key) {
      for (id in private$dag_nodes()) {
        rec <- private$cell_state[[id]]
        if (is.null(rec)) next
        for (output in rec$outputs %||% list()) {
          found <- private$find_lazy_in_output(output, key)
          if (!is.null(found)) return(list(id = id, output = found))
        }
      }
      NULL
    },
    replace_lazy_in_output = function(output, key, replace) {
      if (!is.list(output)) return(list(found = FALSE, output = output))
      if (identical(output$kind %||% NULL, "lazy") &&
          identical(output$key %||% NULL, key)) {
        return(list(found = TRUE, output = replace(output)))
      }
      if (identical(output$kind %||% NULL, "layout")) {
        children <- output$children %||% list()
        for (i in seq_along(children)) {
          changed <- private$replace_lazy_in_output(children[[i]], key, replace)
          if (isTRUE(changed$found)) {
            children[[i]] <- changed$output
            output$children <- children
            return(list(found = TRUE, output = output))
          }
        }
      } else if (identical(output$kind %||% NULL, "lazy") &&
                 !is.null(output$child)) {
        changed <- private$replace_lazy_in_output(output$child, key, replace)
        if (isTRUE(changed$found)) {
          output$child <- changed$output
          return(list(found = TRUE, output = output))
        }
      }
      list(found = FALSE, output = output)
    },
    find_table_in_output = function(output, handle) {
      if (!is.list(output)) return(NULL)
      if (identical(output$kind %||% NULL, "table") &&
          identical(output$handle %||% NULL, handle)) {
        return(output)
      }
      if (identical(output$kind %||% NULL, "layout")) {
        for (child in output$children %||% list()) {
          found <- private$find_table_in_output(child, handle)
          if (!is.null(found)) return(found)
        }
      } else if (identical(output$kind %||% NULL, "lazy") &&
                 !is.null(output$child)) {
        return(private$find_table_in_output(output$child, handle))
      }
      NULL
    },
    find_table_output = function(handle) {
      for (id in private$dag_nodes()) {
        rec <- private$cell_state[[id]]
        if (is.null(rec)) next
        for (output in rec$outputs %||% list()) {
          found <- private$find_table_in_output(output, handle)
          if (!is.null(found)) return(list(id = id, output = found))
        }
      }
      NULL
    },
    replace_table_in_output = function(output, handle, replace) {
      if (!is.list(output)) return(list(found = FALSE, output = output))
      if (identical(output$kind %||% NULL, "table") &&
          identical(output$handle %||% NULL, handle)) {
        return(list(found = TRUE, output = replace(output)))
      }
      if (identical(output$kind %||% NULL, "layout")) {
        children <- output$children %||% list()
        for (i in seq_along(children)) {
          changed <- private$replace_table_in_output(
            children[[i]], handle, replace)
          if (isTRUE(changed$found)) {
            children[[i]] <- changed$output
            output$children <- children
            return(list(found = TRUE, output = output))
          }
        }
      } else if (identical(output$kind %||% NULL, "lazy") &&
                 !is.null(output$child)) {
        changed <- private$replace_table_in_output(
          output$child, handle, replace)
        if (isTRUE(changed$found)) {
          output$child <- changed$output
          return(list(found = TRUE, output = output))
        }
      }
      list(found = FALSE, output = output)
    },
    needs_run = function(ids) {
      ids[vapply(ids, function(id)
        private$status_of(id) %in% c("idle", "stale", "error", "stopped"), FALSE)]
    },
    topo_order_of = function(ids) private$topo[private$topo %in% ids],
    bump = function() {
      private$refresh_value_freshness()
      private$state_version <- private$state_version + 1L
      invisible()
    },
    assert_active = function() {
      if (private$stopped) {
        alder_abort("session_stopped", "session is stopped")
      }
      invisible()
    },
    assert_not_stopped = function() {
      if (private$stopped) {
        alder_abort("session_stopped", "session is stopped")
      }
      invisible()
    },


    recompute = function() {
      perf <- .alder_perf_begin("analysis", list(cells = length(private$notebook$cells)))
      on.exit(.alder_perf_end(perf), add = TRUE)
      cells <- private$notebook$cells
      analysis <- list()
      dagcells <- vector("list", length(cells))
      for (i in seq_along(cells)) {
        c <- cells[[i]]
        if (identical(c$type, "code")) {
          p <- cell_defs_refs(c$body)
        } else {
          p <- list(defs = character(), refs = character(),
                    self_refs = character(), locals = character(),
                    barrier = FALSE, opaque = FALSE,
                    diagnostics = list(), error = NULL)
        }
        analysis[[c$id]] <- p
        dagcells[[i]] <- list(
          id = c$id, type = c$type,
          defs = p$defs %||% character(),
          refs = p$refs %||% character(),
          self_refs = p$self_refs %||% character(),
          locals = p$locals %||% character(),
          barrier = isTRUE(p$barrier),
          opaque = isTRUE(p$opaque))
      }
      private$analysis <- analysis
      d <- build_dag(dagcells)
      private$dag <- d
      private$topo <- topo_order(d$edges, as.character(d$nodes %||% character()))
      for (id in private$dag_nodes()) {
        if (is.null(private$cell_state[[id]])) {
          private$cell_state[[id]] <- list(
            status = "idle", outputs = list(), progress = NULL,
            log = character(), revision = 0L, diagnostics = list())
        }
      }
      private$refresh_diagnostics()
      invisible()
    },

    refresh_diagnostics = function() {
      dups <- private$dag$duplicates %||% list()
      bad_names <- sort(names(dups))
      cycles <- as.character(private$dag$cycles %||% character())
      name_ids <- split(
        vapply(private$notebook$cells, function(cell) cell$id, ""),
        vapply(private$notebook$cells, function(cell) {
          value <- cell$options$name %||% ""
          if (cell_name_valid(value)) value else ""
        }, "")
      )
      duplicate_cell_names <- names(name_ids)[
        nzchar(names(name_ids)) &
          vapply(name_ids, length, 0L) > 1L
      ]
      for (id in private$dag_nodes()) {
        rec <- private$cell_state[[id]]
        p <- private$analysis[[id]] %||%
          list(defs = character(), refs = character(), self_refs = character(),
               diagnostics = list(), error = NULL)
        diags <- list()
        if (!is.null(p$error)) {
          diags <- c(diags, list(list(level = "error", code = "syntax-error",
                                      source = "alder",
                                      message = p$error, symbol = NULL)))
        }
        for (d in p$diagnostics) {
          diags <- c(diags, list(list(
            source = "alder",
            level = d$level %||% "error",
            code = d$code %||% "analysis",
            message = d$message %||% "analysis error",
            symbol = d$symbol %||% NULL)))
        }
        cell_name <- private$cell_source(id)$options$name %||% NULL
        if (!is.null(cell_name) && !cell_name_valid(cell_name)) {
          diags <- c(diags, list(list(
            level = "error", code = "invalid-cell-name",
            source = "alder",
            message = "cell name must match ^[A-Za-z][A-Za-z0-9_.]*$",
            symbol = NULL)))
        } else if (!is.null(cell_name) &&
                   cell_name %in% duplicate_cell_names) {
          diags <- c(diags, list(list(
            source = "alder",
            level = "warning", code = "duplicate-cell-name",
            message = paste("duplicate cell name:", cell_name),
            symbol = NULL)))
        }
        if (length(cycles) && id %in% cycles) {
          diags <- c(diags, list(list(
            source = "alder",
            level = "error", code = "dependency-cycle",
            message = paste("dependency cycle:",
                            paste(cycles, collapse = ", ")),
            symbol = NULL)))
        }
        mine <- intersect(p$defs, bad_names)
        if (length(mine)) {
          diags <- c(diags, list(list(
            source = "alder",
            level = "error", code = "duplicate-definition",
            message = paste("duplicate definition:",
                            paste(mine, collapse = ", ")),
            symbol = NULL)))
        }
        diags <- c(diags, private$missing_library_diagnostics(id))
        diags <- c(diags, private$lsp_diagnostics[[id]] %||% list())
        rec$diagnostics <- diags
        private$cell_state[[id]] <- rec
      }
      invisible()
    },
    missing_library_diagnostics = function(id) {
      p <- private$analysis[[id]]
      if (is.null(p) || !isTRUE(p$barrier)) return(list())
      exprs <- tryCatch(parse(text = private$cell_body(id)),
                        error = function(e) expression())
      found <- character()
      visit <- function(node) {
        if (!is.call(node)) return(invisible())
        head <- node[[1L]]
        name <- if (is.symbol(head)) as.character(head) else NULL
        if (is.call(head) && length(head) >= 3L &&
            is.symbol(head[[1L]]) &&
            as.character(head[[1L]]) %in% c("::", ":::") &&
            is.symbol(head[[3L]])) {
          name <- as.character(head[[3L]])
        }
        if ((identical(name, "library") || identical(name, "require")) &&
            length(node) >= 2L) {
          arg <- node[[2L]]
          if (is.call(arg) && length(arg) >= 2L &&
              is.symbol(arg[[1L]]) &&
              as.character(arg[[1L]]) %in% c("=", "package")) {
            arg <- arg[[2L]]
          }
          package <- if (is.symbol(arg)) as.character(arg) else
            if (is.character(arg) && length(arg) == 1L) arg else NULL
          if (!is.null(package) &&
              grepl(ALDER_PACKAGE_NAME_RE, package, perl = TRUE)) {
            found <<- unique(c(found, package))
          }
        }
        if (length(node) > 1L) {
          for (child in as.list(node)[-1L]) visit(child)
        }
        invisible()
      }
      for (expr in as.list(exprs)) visit(expr)
      if (!length(found)) return(list())
      project <- tryCatch(.alder_package_path(private$notebook$path),
                          error = function(e) NULL)
      if (is.null(project)) return(list())
      status <- tryCatch(alder_package_status(
        found, lib.loc = .alder_candidate_libs(project)),
        error = function(e) NULL)
      if (is.null(status)) return(list())
      missing <- status$package[status$status == "missing"]
      lapply(missing, function(package) list(
        source = "alder", level = "error", code = "package-missing",
        message = paste("package", sQuote(package), "is not installed"),
        symbol = package, install = package
      ))
    },


    mark_stale = function(id) {
      rec <- private$cell_state[[id]]
      if (is.null(rec)) return(invisible())
      st <- rec$status
      if (st %in% c("done", "error", "stopped")) {
        rec$status <- "stale"
        private$cell_state[[id]] <- rec
      } else if (st == "running") {
        cur <- private$current
        if (!is.null(cur) && identical(cur$job$id, id) &&
            !is.null(cur$cancel_mode)) {
          rec$status <- "stale"
          private$cell_state[[id]] <- rec
        }
      }
      private$refresh_value_freshness()
      invisible()
    },


    # Cancel the active eval and queued jobs whose cells intersect `ids`
    # (source edits and newer widget commits). The interrupted eval keeps
    # running until its response arrives; it is then discarded (no commit).
    cancel_run_region = function(ids, mode) {
      ids <- unique(ids)
      cur <- private$current
      if (!is.null(cur) && !is.null(cur$job) &&
          cur$job$id %in% ids && is.null(cur$cancel_mode)) {
        cur$cancel_mode <- mode
        private$current <- cur
        rec <- private$cell_state[[cur$job$id]]
        if (!is.null(rec)) rec$status <- "stale"
        private$cell_state[[cur$job$id]] <- rec
        if (self$worker_available()) private$worker$interrupt(cur$req)
      }
      if (length(private$queue)) {
        keep <- vapply(private$queue, function(j) !(j$id %in% ids), FALSE)
        if (!all(keep)) private$queue <- private$queue[keep]
      }
      invisible()
    },

    # A failed or stopped cell removes only its queued same-run descendants;
    # their prior state and outputs remain visible.
    drop_same_run_descendants = function(id, run_id) {
      if (is.null(run_id) || !length(private$queue)) return(invisible())
      desc <- self$descendants(id)
      if (!length(desc)) return(invisible())
      keep <- vapply(private$queue, function(job) {
        !identical(job$run_id, run_id) || !(job$id %in% desc)
      }, FALSE)
      if (!all(keep)) private$queue <- private$queue[keep]
      invisible()
    },

    # Cancel any pending widget operation owned by this cell so its late
    # response cannot commit against the edited record; the retained
    # output reports the operation failed with widget_not_current.
    cancel_lazy_ops = function(id) {
      if (!length(private$lazy_operations)) return(invisible())
      for (key in names(private$lazy_operations)) {
        op <- private$lazy_operations[[key]]
        if (!is.null(op) && identical(op$cell_id, id)) {
          private$lazy_operations[[key]] <- NULL
        }
      }
      invisible()
    },
    cancel_owned_ops = function(id) {
      private$cancel_lazy_ops(id)
      private$map_cell_widgets(id, function(out) {
        ops <- out$operations %||% list()
        for (key in names(ops)) {
          op <- ops[[key]]
          if (!is.null(op) && identical(op$status, "pending")) {
            op$status <- "cancelled"
            op$error <- list(
              code = "widget_not_current",
              message = "widget owner changed"
            )
            private$remember_widget_operation(op)
            ops[[key]] <- op
          }
        }
        out$operations <- ops
        root_key <- private$widget_operation_key(out$name %||% "", character())
        root <- ops[[root_key]] %||% NULL
        if (!is.null(root)) out$operation <- root
        out
      })
      if (length(private$button_resets)) {
        for (key in names(private$button_resets)) {
          info <- private$button_resets[[key]]
          if (!is.null(info) && identical(info$owner, id)) {
            private$button_resets[[key]] <- NULL
          }
        }
      }
      invisible()
    },


    assert_can_launch = function() {
      private$assert_active()
      if (!self$worker_available()) {
        alder_abort("worker_unavailable", "R worker is unavailable")
      }
      cur <- private$current
      if ((!is.null(cur) && is.null(cur$cancel_mode)) || length(private$queue)) {
        alder_abort("run_in_progress",
                    "cannot start a run: one is already active or queued")
      }
      },

    launch_run = function(plan) {
      perf <- .alder_perf_begin("run.plan", list(run_id = private$run_counter + 1L,
        cells = length(plan)))
      on.exit(.alder_perf_end(perf), add = TRUE)
      rid <- private$run_counter + 1L
      private$run_counter <- rid
      private$remember_run_operation(list(
        run_id = rid,
        status = "pending",
        execution_done = FALSE,
        reset_tokens = I(integer()),
        error = NULL
      ))
      private$enqueue_targets(plan, rid)
      private$pump()
      private$complete_run_if_idle(rid)
      rid
    },
    enqueue_targets = function(plan, rid) {
      disabled <- private$dag_nodes()[vapply(
        private$dag_nodes(), private$cell_disabled, logical(1)
      )]
      blocked <- unique(c(
        disabled,
        unlist(lapply(disabled, self$descendants), use.names = FALSE)
      ))
      for (id in private$topo_order_of(plan)) {
        if (!identical(private$cell_type(id), "code") ||
            id %in% blocked) next
        p <- private$analysis[[id]]
        defs <- if (is.null(p)) character() else
          as.character(p$defs %||% character())
        locals <- if (is.null(p)) character() else
          as.character(p$locals %||% character())
        private$queue[[length(private$queue) + 1L]] <- list(
          id = id, code = private$cell_body(id),
          revision = private$cell_record(id)$revision,
          run_id = rid, defs = as.list(defs), locals = as.list(locals),
          opaque = isTRUE(p$opaque))
      }
      invisible()
    },

    # Dispatch the first queued eval job, if any. `current` is only ever
    # set while an eval request is the active worker identity.
    pump = function() {
      if (private$stopped || private$worker_failed) return(invisible())
      if (!is.null(private$current)) return(invisible())
      if (private$barrier_restart_required) {
        if (self$worker_available()) {
          private$worker$restart()
          private$barrier_restart_required <- FALSE
        } else {
          return(invisible())
        }
      }
      if (!length(private$queue)) return(invisible())
      job <- private$queue[[1L]]
      private$queue <- private$queue[-1L]
      if (!self$worker_available()) {
        private$fail_worker_transport(job$id, "Worker exited before responding")
        return(invisible())
      }
      rec <- private$cell_state[[job$id]]
      rec$status <- "running"
      private$cell_state[[job$id]] <- rec
      private$bump()
      # Worker$send may drain a very fast response synchronously from its
      # initial poll. Publish the active identity before sending so that such
      # a response cannot be discarded as late.
      req <- private$worker$counter
      private$current <- list(job = job, req = req, cancel_mode = NULL)
      sent <- private$worker$send(
        "eval_cell", id = job$id, code = job$code, run_id = job$run_id,
        revision = job$revision, defs = job$defs, locals = job$locals,
        opaque = job$opaque,
        on_response = function(context, resp)
          private$on_cell_result(job, resp))
      if (!is.null(private$current) &&
          identical(private$current$job$id, job$id) &&
          identical(private$current$job$run_id, job$run_id)) {
        private$current$req <- sent
      }
    },


    on_cell_result = function(job, resp) {
      perf <- .alder_perf_begin("result.commit", list(cell = job$id,
        revision = job$revision, run_id = job$run_id, req = resp$req))
      on.exit(.alder_perf_end(perf), add = TRUE)
      cur <- private$current
      if (is.null(cur)) {
        private$discard_late(resp)
        return(invisible())
      }
      if (!identical(job$id, cur$job$id) ||
          !identical(job$run_id, cur$job$run_id) ||
          !identical(job$revision, cur$job$revision)) {
        private$discard_late(resp)
        return(invisible())
      }
      if (!identical(as.integer(resp$req %||% NA_integer_),
                     as.integer(cur$req))) {
        private$discard_late(resp)
        return(invisible())
      }
      id <- job$id
      if (isTRUE(resp$error$transport) || isTRUE(private$worker_failed)) {
        private$fail_worker_transport(id, resp$error$message %||%
                                     "Worker exited before responding")
        return(invisible())
      }
      if (is.list(resp$outputs)) {
        resp$outputs <- lapply(
          resp$outputs, private$normalize_output_record)
      }
      if (!is.null(private$validate_eval_response(resp))) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      if (!is.null(cur$cancel_mode)) {
        if (identical(cur$cancel_mode, "stop")) {
          # late Stop: success commits; only the matching interrupted
          # response becomes Error: Interrupted
          if (isTRUE(resp$ok)) {
            private$commit_success(id, resp)
          } else {
            private$commit_failure(id, resp, drop_descendants = FALSE)
          }
        } else {
          # source/widget cancel: no commit, release any carried artifact
          private$discard_late(resp)
        }
      } else if (isTRUE(resp$ok)) {
        private$commit_success(id, resp)
      } else {
        private$commit_failure(id, resp, drop_descendants = TRUE)
      }
      if (isTRUE(resp$ok) && isTRUE(resp$stopped)) {
        private$drop_same_run_descendants(id, job$run_id)
      }
      private$current <- NULL
      private$bump()
      private$complete_run_if_idle(job$run_id)
      private$pump()
      invisible()
    },

    on_notify = function(ctx, frame) {
      cur <- private$current
      if (is.null(cur) || is.null(cur$job) ||
          !identical(ctx$id %||% NULL, cur$job$id) ||
          !resp_field_equal(ctx$run_id %||% NULL, cur$job$run_id) ||
          !resp_field_equal(ctx$req %||% NULL, cur$req)) {
        return(invisible())
      }
      rec <- private$cell_state[[cur$job$id]]
      if (is.null(rec)) return(invisible())
      payload <- frame$payload %||% list()
      kind <- as.character(frame$notify %||% "")
      if (identical(kind, "append")) {
        output <- private$normalize_output_record(payload$output %||% payload)
        err <- private$validate_output_record(output)
        if (!is.null(err)) stop(err, call. = FALSE)
        rec$outputs <- c(rec$outputs %||% list(), list(output))
      } else if (identical(kind, "progress")) {
        progress <- payload$progress %||% payload
        if (is.null(progress$kind)) progress$kind <- "progress"
        err <- private$validate_output_record(progress)
        if (!is.null(err)) stop(err, call. = FALSE)
        rec$progress <- progress
      } else if (identical(kind, "log")) {
        lines <- payload$lines %||% payload$log %||% character()
        rec$log <- private$bounded_log(c(rec$log %||% character(),
                                         as.character(unlist(lines,
                                                               use.names = FALSE))))
      }
      private$cell_state[[cur$job$id]] <- rec
      private$bump()
      invisible()
    },

    # JSON is deliberately parsed with simplifyVector = FALSE so a protocol
    # array can never silently change the surrounding object shape. Convert
    # only schema-declared atomic arrays after parsing, with exact type and
    # cardinality checks. Invalid objects remain unmodified for the regular
    # response validator to reject.
    decode_wire_vector = function(value, type,
                                  expected_length = NULL,
                                  integer = FALSE) {
      empty <- switch(type,
        numeric = numeric(),
        character = character(),
        logical = logical(),
        NULL
      )
      if (is.null(empty)) return(NULL)
      # JSON objects decode as named lists (and named R vectors serialize as
      # objects). Array-typed protocol fields must never discard those names
      # and reinterpret an object as an array.
      if (!is.null(names(value))) return(NULL)
      if (is.list(value)) {
        if (!length(value)) {
          value <- empty
        } else {
          scalar <- vapply(value, function(item) {
            is.atomic(item) && length(item) == 1L && !is.na(item)
          }, logical(1L))
          if (!all(scalar)) return(NULL)
          value <- unlist(value, use.names = FALSE)
        }
      }
      valid <- switch(type,
        numeric = is.numeric(value) && !anyNA(value) &&
          all(is.finite(value)),
        character = is.character(value) && !anyNA(value) &&
          all(validUTF8(value)),
        logical = is.logical(value) && !anyNA(value),
        FALSE
      )
      if (!isTRUE(valid)) return(NULL)
      if (!is.null(expected_length) && length(value) != expected_length) {
        return(NULL)
      }
      if (isTRUE(integer)) {
        if (!is.numeric(value) || any(value != floor(value)) ||
            any(value < -(.Machine$integer.max + 1) |
                value > .Machine$integer.max)) {
          return(NULL)
        }
        return(as.integer(value))
      }
      switch(type,
        numeric = as.double(value),
        character = as.character(value),
        logical = as.logical(value)
      )
    },

    normalize_widget_spec = function(spec) {
      if (!is.list(spec) || !is.character(spec$kind) ||
          length(spec$kind) != 1L || is.na(spec$kind)) {
        return(spec)
      }
      kind <- spec$kind
      if (identical(kind, "range_slider")) {
        value <- private$decode_wire_vector(
          spec$value, "numeric", expected_length = 2L)
        if (!is.null(value)) spec$value <- value
      } else if (identical(kind, "date_range")) {
        value <- private$decode_wire_vector(
          spec$value, "character", expected_length = 2L)
        if (!is.null(value)) spec$value <- value
      } else if (identical(kind, "multiselect")) {
        choice_types <- unique(vapply(spec$choices %||% list(),
                                      typeof, character(1L)))
        wire_type <- if (length(choice_types) == 1L) {
          switch(choice_types,
            integer = "numeric", double = "numeric",
            character = "character", logical = "logical", NULL)
        } else {
          NULL
        }
        if (!is.null(wire_type)) {
          value <- private$decode_wire_vector(
            spec$value, wire_type, integer = identical(choice_types, "integer"))
          if (!is.null(value)) spec$value <- I(value)
        }
        indices <- private$decode_wire_vector(
          spec$indices %||% integer(), "numeric", integer = TRUE)
        if (!is.null(indices)) spec$indices <- I(indices)
      } else if (identical(kind, "table")) {
        selected <- private$decode_wire_vector(
          spec$selected %||% integer(), "numeric", integer = TRUE)
        if (!is.null(selected)) spec$selected <- I(selected)
      } else if (kind %in% c("array", "dictionary")) {
        if (is.list(spec$children)) {
          spec$children <- lapply(spec$children,
                                  private$normalize_widget_spec)
          child_names <- vapply(spec$children, function(child) {
            name <- if (is.list(child)) child$name %||% "" else ""
            if (!is.character(name) || length(name) != 1L || is.na(name)) {
              return("")
            }
            name
          }, character(1L))
          if (!anyNA(child_names) && all(nzchar(child_names)) &&
              !anyDuplicated(child_names)) {
            spec$value <- lapply(spec$children, function(child) child$value)
            names(spec$value) <- child_names
          }
        }
      } else if (identical(kind, "form") && is.list(spec$child)) {
        spec$child <- private$normalize_widget_spec(spec$child)
      }
      spec
    },

    normalize_output_record = function(output) {
      if (!is.list(output) || !is.character(output$kind) ||
          length(output$kind) != 1L || is.na(output$kind)) {
        return(output)
      }
      if (identical(output$kind, "widget") && is.list(output$spec)) {
        output$spec <- private$normalize_widget_spec(output$spec)
      } else if (identical(output$kind, "layout") &&
                 is.list(output$children)) {
        output$children <- lapply(output$children,
                                  private$normalize_output_record)
      } else if (identical(output$kind, "lazy") &&
                 is.list(output$child)) {
        output$child <- private$normalize_output_record(output$child)
      }
      output
    },

    validate_eval_response = function(resp) {
      if (!is.logical(resp$ok) || length(resp$ok) != 1L || is.na(resp$ok)) {
        return("eval response missing ok")
      }
      if (!is.null(resp$value)) return("eval response uses singular value")
      stopped <- resp$stopped %||% FALSE
      if (!is.logical(stopped) || length(stopped) != 1L || is.na(stopped)) {
        return("eval response stopped invalid")
      }
      if (!is.null(resp$log) &&
          !(is.character(resp$log) || is.list(resp$log))) {
        return("eval response log invalid")
      }
      if (is.null(resp$outputs) || !is.list(resp$outputs)) {
        return("eval response outputs invalid")
      }
      outputs <- resp$outputs
      if (isFALSE(resp$ok) && length(outputs)) {
        return("eval response outputs on failure")
      }
      for (output in outputs) {
        err <- private$validate_output_record(output)
        if (!is.null(err)) return(err)
      }
      if (!is.null(resp$error)) {
        if (!is.list(resp$error) ||
            !is.character(resp$error$message %||% NULL) ||
            length(resp$error$message) != 1L || is.na(resp$error$message)) {
          return("eval response error invalid")
        }
        if (!is.null(resp$error$interrupted) &&
            (!is.logical(resp$error$interrupted) ||
             length(resp$error$interrupted) != 1L ||
             is.na(resp$error$interrupted))) {
          return("eval response error invalid")
        }
        scalar_chr <- function(value) {
          is.character(value) && length(value) == 1L && !is.na(value)
        }
        array_chr <- function(value, limit) {
          (is.character(value) || is.list(value)) && length(value) <= limit &&
            all(vapply(value, scalar_chr, logical(1)))
        }
        if (!is.null(resp$error$class) &&
            !array_chr(resp$error$class, 32L)) {
          return("eval response error invalid")
        }
        if (!is.null(resp$error$call) && !scalar_chr(resp$error$call)) {
          return("eval response error invalid")
        }
        if (!is.null(resp$error$trace) &&
            !array_chr(resp$error$trace, 40L)) {
          return("eval response error invalid")
        }
      }
      NULL
    },
    validate_table_page = function(page) {
      if (!is.list(page)) return("table page invalid")
      scalar_chr <- function(x) is.character(x) && length(x) == 1L &&
        !is.na(x)
      scalar_num <- function(x) is.numeric(x) && length(x) == 1L &&
        !is.na(x) && is.finite(x)
      scalar_log <- function(x) is.logical(x) && length(x) == 1L &&
        !is.na(x)
      if (!scalar_num(page$nrow) || page$nrow < 0 ||
          !scalar_num(page$ncol) || page$ncol < 0 ||
          !scalar_num(page$offset) || page$offset < 0 ||
          page$offset != floor(page$offset) ||
          !scalar_num(page$limit) || page$limit < 1 ||
          page$limit > 200) {
        return("table page invalid")
      }
      columns <- page$columns %||% list()
      if (!(is.character(columns) || is.list(columns)) ||
          length(columns) > 50L ||
          !all(vapply(columns, scalar_chr, logical(1)))) {
        return("table page invalid")
      }
      preview <- page$preview %||% list()
      if (!is.list(preview) || length(preview) > 200L) {
        return("table page invalid")
      }
      for (row in preview) {
        if (!is.list(row) || length(row) > 50L ||
            !all(vapply(row, scalar_chr, logical(1)))) {
          return("table page invalid")
        }
      }
      for (field in c("sort_by", "filter")) {
        if (!scalar_chr(page[[field]] %||% "")) return("table page invalid")
      }
      if (!scalar_log(page$sort_desc %||% FALSE) ||
          !scalar_log(page$truncated_rows %||% FALSE) ||
          !scalar_log(page$truncated_columns %||% FALSE)) {
        return("table page invalid")
      }
      NULL
    },

    validate_output_record = function(v) {
      if (!is.list(v) || !is.character(v$kind) || length(v$kind) != 1L ||
          is.na(v$kind)) {
        return("output record kind invalid")
      }
      if (!is.null(v$label) &&
          (!is.character(v$label) || length(v$label) != 1L || is.na(v$label))) {
        return("output record label invalid")
      }
      scalar_chr <- function(x) is.character(x) && length(x) == 1L && !is.na(x)
      scalar_num <- function(x) is.numeric(x) && length(x) == 1L && !is.na(x)
      scalar_log <- function(x) is.logical(x) && length(x) == 1L && !is.na(x)
      basename_ok <- function(x, ext = NULL) {
        scalar_chr(x) && !grepl("[/\\\\]", x) && !grepl("^\\.", x) &&
          (is.null(ext) || grepl(paste0("\\.", ext, "$"), x))
      }
      kind <- v$kind
      if (identical(kind, "text")) {
        if (!scalar_chr(v$text)) return("text output invalid")
        if (!is.null(v$truncated) && !scalar_log(v$truncated)) {
          return("text output invalid")
        }
      } else if (identical(kind, "table")) {
        if (!scalar_num(v$nrow) || v$nrow < 0 ||
            !scalar_num(v$ncol) || v$ncol < 0 ||
            !is.list(v$preview %||% list()) || length(v$preview) > 25L) {
          return("table output invalid")
        }
        columns <- v$columns %||% list()
        if (!(is.character(columns) || is.list(columns)) ||
            length(columns) > 50L ||
            !all(vapply(columns, scalar_chr, logical(1)))) {
          return("table output invalid")
        }
        for (flag in c("truncated_rows", "truncated_columns")) {
          if (!scalar_log(v[[flag]])) return("table output invalid")
        }
        if (!is.null(v$handle) && !scalar_chr(v$handle)) {
          return("table output invalid")
        }
        for (row in v$preview %||% list()) {
          if (!is.list(row) || length(row) > 50L ||
              !all(vapply(row, scalar_chr, logical(1)))) {
            return("table output invalid")
          }
        }
        if (!is.null(v$page)) {
          err <- private$validate_table_page(v$page)
          if (!is.null(err)) return(err)
        }
      } else if (identical(kind, "image")) {
        if (!basename_ok(v$artifact, "png")) return("image output invalid")
      } else if (identical(kind, "html")) {
        if (!basename_ok(v$artifact, "html")) return("html output invalid")
      } else if (identical(kind, "markdown")) {
        if (!scalar_chr(v$html) || !scalar_chr(v$text)) {
          return("markdown output invalid")
        }
      } else if (identical(kind, "media")) {
        if (!v$media_type %in% c("image", "audio", "video", "pdf") ||
            !basename_ok(v$artifact) || !scalar_chr(v$mime)) {
          return("media output invalid")
        }
        if (!is.null(v$alt) && !scalar_chr(v$alt)) return("media output invalid")
      } else if (identical(kind, "layout")) {
        if (!v$layout %in% c("hstack", "vstack", "tabs", "accordion",
                             "callout", "sidebar") ||
            !is.list(v$children %||% list())) return("layout output invalid")
        for (child in v$children %||% list()) {
          err <- private$validate_output_record(child)
          if (!is.null(err)) return(err)
        }
      } else if (identical(kind, "lazy")) {
        if (!scalar_chr(v$key) || !scalar_chr(v$label) ||
            !v$state %in% c("collapsed", "loaded", "error")) {
          return("lazy output invalid")
        }
        if (!is.null(v$child)) {
          err <- private$validate_output_record(v$child)
          if (!is.null(err)) return(err)
        }
      } else if (identical(kind, "progress")) {
        if (!scalar_num(v$value) ||
            (!is.null(v$total) && !scalar_num(v$total)) ||
            !scalar_chr(v$label) || !scalar_log(v$done)) {
          return("progress output invalid")
        }
      } else if (identical(kind, "error")) {
        if (!scalar_chr(v$message)) return("error output invalid")
      } else if (identical(kind, "widget")) {
        if (!scalar_chr(v$name) || !scalar_chr(v$owner) ||
            !is.list(v$spec)) {
          return("widget output invalid")
        }
        spec_err <- private$validate_widget_spec(v$spec)
        if (!is.null(spec_err)) return(paste("widget output invalid:", spec_err))
      } else {
        return("eval response output kind invalid")
      }
      NULL
    },
    validate_widget_spec = function(spec) {
      scalar_chr <- function(x) is.character(x) && length(x) == 1L &&
        !is.na(x)
      scalar_num <- function(x) is.numeric(x) && length(x) == 1L &&
        !is.na(x) && is.finite(x)
      scalar_log <- function(x) is.logical(x) && length(x) == 1L &&
        !is.na(x)
      kinds <- c(
        "slider", "range_slider", "dropdown", "radio", "multiselect",
        "text_input", "text_area", "number", "checkbox", "switch",
        "run_button", "button", "date", "date_range", "datetime",
        "code_editor", "refresh", "file", "table", "dataframe",
        "array", "dictionary", "form"
      )
      if (!is.list(spec) || !scalar_chr(spec$kind) ||
          !(spec$kind %in% kinds)) {
        return("widget kind invalid")
      }
      kind <- spec$kind
      if (!is.null(spec$label) && !scalar_chr(spec$label)) {
        return("widget label invalid")
      }
      if (kind %in% c("slider", "range_slider", "number")) {
        for (field in c("min", "max", "step")) {
          if (!is.null(spec[[field]]) && !scalar_num(spec[[field]])) {
            return("numeric widget bounds invalid")
          }
        }
      }
      if (kind %in% c("slider", "number") && !scalar_num(spec$value)) {
        return("numeric widget value invalid")
      }
      if (identical(kind, "range_slider") &&
          (!is.numeric(spec$value) || length(spec$value) != 2L ||
           anyNA(spec$value) || any(!is.finite(spec$value)))) {
        return("range widget value invalid")
      }
      if (kind %in% c("text_input", "text_area", "code_editor") &&
          !scalar_chr(spec$value)) {
        return("text widget value invalid")
      }
      if (kind %in% c("checkbox", "switch", "run_button") &&
          !scalar_log(spec$value)) {
        return("logical widget value invalid")
      }
      if (kind %in% c("button", "refresh") &&
          (!scalar_num(spec$value) || spec$value < 0 ||
           spec$value != floor(spec$value))) {
        return("counter widget value invalid")
      }
      if (identical(kind, "date") &&
          !private$wire_date_valid(spec$value)) {
        return("temporal widget value invalid")
      }
      if (identical(kind, "datetime") &&
          !private$wire_datetime_valid(spec$value)) {
        return("temporal widget value invalid")
      }
      if (identical(kind, "date_range") &&
          (!is.character(spec$value) || length(spec$value) != 2L ||
           anyNA(spec$value) || !all(vapply(
             spec$value, private$wire_date_valid, logical(1)
           )))) {
        return("date range value invalid")
      }
      if (kind %in% c("date", "date_range", "datetime")) {
        bound_ok <- if (identical(kind, "datetime")) {
          private$wire_datetime_valid
        } else {
          private$wire_date_valid
        }
        for (field in c("min", "max")) {
          if (!is.null(spec[[field]]) && !bound_ok(spec[[field]])) {
            return("temporal widget bounds invalid")
          }
        }
      }
      if (kind %in% c("dropdown", "radio", "multiselect")) {
        choices <- spec$choices
        if (!(is.atomic(choices) || is.list(choices)) || !length(choices)) {
          return("widget choices invalid")
        }
        if (kind %in% c("dropdown", "radio")) {
          idx <- spec$index
          if (!scalar_num(idx) || idx < 1 || idx != floor(idx) ||
              idx > length(choices)) {
            return("widget choice index invalid")
          }
        } else if (!is.null(spec$indices)) {
          idx <- unlist(spec$indices, use.names = FALSE)
          if (length(idx) &&
              (!is.numeric(idx) || anyNA(idx) || any(idx < 1) ||
               any(idx != floor(idx)) || any(idx > length(choices)))) {
            return("widget choice indices invalid")
          }
        }
      }
      if (identical(kind, "array") || identical(kind, "dictionary")) {
        children <- spec$children
        if (!is.list(children)) return("composite children invalid")
        child_names <- vapply(children, function(child)
          as.character(child$name %||% ""), character(1))
        if (!length(child_names) || any(!nzchar(child_names)) ||
            anyDuplicated(child_names)) {
          return("composite child names invalid")
        }
        for (child in children) {
          err <- private$validate_widget_spec(child)
          if (!is.null(err)) return(err)
        }
      }
      if (identical(kind, "form")) {
        if (!is.list(spec$child)) return("form child invalid")
        if (!is.null(spec$submit_label) &&
            !scalar_chr(spec$submit_label)) {
          return("form submit label invalid")
        }
        if (!is.null(spec$dirty) && !scalar_log(spec$dirty)) {
          return("form dirty flag invalid")
        }
        err <- private$validate_widget_spec(spec$child)
        if (!is.null(err)) return(err)
      }
      NULL
    },
    on_lazy_response = function(key, id, tok, resp) {
      op <- private$lazy_operations[[key]]
      if (is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) {
        if (isTRUE(resp$ok) && !is.null(resp$output)) {
          private$release_output_artifacts(resp$output)
        }
        return(invisible())
      }
      loc <- private$find_lazy_output(key)
      if (is.null(loc)) {
        if (isTRUE(resp$ok) && !is.null(resp$output)) {
          private$release_output_artifacts(resp$output)
        }
        private$lazy_operations[[key]] <- NULL
        private$bump()
        return(invisible())
      }

      code <- NULL
      message <- NULL
      child <- NULL
      log_valid <- is.null(resp$log) ||
        ((is.character(resp$log) || is.list(resp$log)) &&
          all(vapply(as.list(resp$log), function(line)
            is.character(line) && length(line) == 1L && !is.na(line), logical(1))))
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        code <- "worker_unavailable"
        message <- "Worker exited before responding"
      } else if (!log_valid) {
        code <- "worker_unavailable"
        message <- "invalid worker response"
      } else if (!isTRUE(resp$ok)) {
        code <- as.character(resp$error$code %||% "lazy_eval_failed")
        message <- as.character(resp$error$message %||% "lazy evaluation failed")
      } else {
        validation <- private$validate_output_record(resp$output)
        if (!is.null(validation)) {
          code <- "worker_unavailable"
          message <- "invalid worker response"
        } else {
          child <- resp$output
        }
      }
      if (!is.null(code)) {
        child <- list(kind = "error", message = message)
      }
      rec <- private$cell_state[[id]]
      if (!is.null(rec)) {
        if (log_valid) {
          rec$log <- private$bounded_log(c(rec$log,
            private$normalize_log(resp$log)))
        }
        rec$outputs <- lapply(rec$outputs %||% list(), function(output) {
          changed <- private$replace_lazy_in_output(output, key, function(lazy) {
            lazy$state <- if (is.null(code)) "loaded" else "error"
            lazy$child <- child
            lazy
          })
          changed$output
        })
        private$cell_state[[id]] <- rec
      }
      private$lazy_operations[[key]] <- NULL
      if (is.null(code)) {
        private$last_action_error <- NULL
      } else {
        private$note_action_error(tok, code, message)
      }
      private$bump()
      invisible()
    },
    on_table_response = function(handle, id, tok, resp) {
      op <- private$table_operations[[handle]]
      if (is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) {
        return(invisible())
      }
      loc <- private$find_table_output(handle)
      if (is.null(loc) || !identical(loc$id, id)) {
        private$table_operations[[handle]] <- NULL
        private$bump()
        return(invisible())
      }
      code <- NULL
      message <- NULL
      page <- NULL
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        code <- "worker_unavailable"
        message <- "Worker exited before responding"
      } else if (!isTRUE(resp$ok)) {
        code <- as.character(resp$error$code %||% "table_request_failed")
        message <- as.character(resp$error$message %||%
                                "table request failed")
      } else {
        validation <- private$validate_table_page(resp$page)
        if (!is.null(validation)) {
          if (self$worker_available()) {
            private$worker$transport_error("invalid worker response")
          }
          private$table_operations[[handle]] <- NULL
          return(invisible())
        }
        page <- resp$page
      }
      if (!is.null(code)) {
        op$status <- "error"
        op$error <- list(code = code, message = message)
        private$table_operations[[handle]] <- op
        private$note_action_error(tok, code, message)
        private$bump()
        return(invisible())
      }
      rec <- private$cell_state[[id]]
      if (is.null(rec)) {
        private$table_operations[[handle]] <- NULL
        private$bump()
        return(invisible())
      }
      rec$outputs <- lapply(rec$outputs %||% list(), function(output) {
        changed <- private$replace_table_in_output(output, handle,
          function(table) {
            table$page <- page
            table
          })
        changed$output
      })
      private$cell_state[[id]] <- rec
      op$status <- "done"
      op$error <- NULL
      private$table_operations[[handle]] <- op
      private$last_action_error <- NULL
      private$bump()
      invisible()
    },
    definition_owner = function(name) {
      for (id in private$dag_nodes()) {
        p <- private$analysis[[id]]
        if (!is.null(p) && name %in% (p$defs %||% character())) {
          return(id)
        }
      }
      NULL
    },
    validate_variables_payload = function(values) {
      if (is.null(values)) return(NULL)
      if (!is.list(values) || length(values) > 2000L) {
        return("variables payload invalid")
      }
      scalar_chr <- function(x) is.character(x) && length(x) == 1L &&
        !is.na(x) && nzchar(x)
      scalar_num <- function(x) is.numeric(x) && length(x) == 1L &&
        !is.na(x) && is.finite(x) && x >= 0
      scalar_log <- function(x) is.logical(x) && length(x) == 1L &&
        !is.na(x)
      for (value in values) {
        if (!is.list(value) || !scalar_chr(value$name) ||
            !scalar_chr(value$class) || !scalar_num(value$size) ||
            !scalar_log(value$widget)) {
          return("variables payload invalid")
        }
        dim <- value$dim %||% NULL
        if (!is.null(dim)) dim <- unlist(dim, use.names = FALSE)
        if (!is.null(dim) &&
            (!is.numeric(dim) || anyNA(dim) ||
             any(!is.finite(dim)) || any(dim < 0))) {
          return("variables payload invalid")
        }
      }
      NULL
    },
    refresh_variables = function() {
      if (!self$worker_available()) return(invisible())
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      private$variables_operation <- list(token = tok, status = "pending")
      private$worker$send(
        "env_snapshot", token = as.integer(tok),
        on_response = function(context, resp)
          private$on_variables_response(tok, resp))
      invisible()
    },
    on_variables_response = function(tok, resp) {
      op <- private$variables_operation
      if (is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) {
        return(invisible())
      }
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        op$status <- "error"
        op$error <- list(code = "worker_unavailable",
                         message = "Worker exited before responding")
        private$variables_operation <- op
        private$bump()
        return(invisible())
      }
      if (!isTRUE(resp$ok)) {
        op$status <- "error"
        op$error <- list(
          code = "variables_request_failed",
          message = as.character(resp$error$message %||%
                                 "variables request failed"))
        private$variables_operation <- op
        private$note_action_error(tok, op$error$code, op$error$message)
        private$bump()
        return(invisible())
      }
      validation <- private$validate_variables_payload(resp$variables)
      if (!is.null(validation)) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      private$variables <- lapply(resp$variables %||% list(), function(value) {
        dim <- value$dim %||% NULL
        if (!is.null(dim)) dim <- unlist(dim, use.names = FALSE)
        list(
          name = value$name,
          class = value$class,
          dim = dim,
          size = as.numeric(value$size),
          widget = value$widget,
          owner = private$definition_owner(value$name)
        )
      })
      op$status <- "done"
      op$error <- NULL
      private$variables_operation <- op
      private$bump()
      invisible()
    },

    # A discarded response must never leave a rendered artifact behind.
    discard_late = function(resp) {
      if (isTRUE(resp$ok) && length(resp$outputs %||% list())) {
        private$release_output_artifacts(resp$outputs)
      }
      invisible()
    },


    commit_success = function(id, resp) {
      rec <- private$cell_state[[id]]
      private$cancel_lazy_ops(id)
      private$release_output_artifacts(rec$outputs)
      rec$status <- if (isTRUE(resp$stopped)) "stopped" else "done"
      rec$outputs <- resp$outputs %||% list()
      rec$progress <- rec$progress %||% NULL
      rec$log <- private$normalize_log(resp$log)
      rec$error <- NULL
      private$cell_state[[id]] <- rec
      private$last_action_error <- NULL
      private$refresh_variables()
      invisible()
    },
    commit_failure = function(id, resp, drop_descendants) {
      rec <- private$cell_state[[id]]
      private$cancel_lazy_ops(id)
      private$release_output_artifacts(rec$outputs)
      rec$status <- "error"
      rec$outputs <- list()
      rec$error <- resp$error
      if (isTRUE(resp$error$interrupted)) {
        line <- "Error: Interrupted"
      } else {
        line <- paste("Error:", resp$error$message %||% "Unknown error")
      }
      rec$log <- c(private$normalize_log(resp$log), line)
      private$cell_state[[id]] <- rec
      if (drop_descendants) {
        cur <- private$current
        run_id <- if (!is.null(cur) && !is.null(cur$job)) cur$job$run_id else NULL
        private$drop_same_run_descendants(id, run_id)
      }
      if (isTRUE(private$analysis[[id]]$barrier)) {
        # every other code cell must rerun after the worker restart, even
        # ones that never ran (idle) — the barrier run was invalidated
        for (cid in private$dag_nodes()) {
          if (!identical(cid, id) &&
              identical(private$cell_type(cid), "code")) {
            rec2 <- private$cell_state[[cid]]
            if (!is.null(rec2) && !identical(rec2$status, "running")) {
              rec2$status <- "stale"
              private$cell_state[[cid]] <- rec2
            }
          }
        }
        private$barrier_restart_required <- TRUE
      }
      message <- resp$error$message %||% "Unknown error"
      private$note_action_error(NULL, "eval_error", message)
      private$refresh_variables()
      private$bump()
      invisible()
    },

    normalize_log = function(log) {
      if (is.null(log)) return(character())
      as.character(unlist(log, use.names = FALSE))
    },
    bounded_log = function(lines, max_bytes = 65536L) {
      lines <- as.character(lines)
      while (length(lines) &&
             sum(nchar(lines, type = "bytes")) + length(lines) - 1L >
               max_bytes) {
        lines <- lines[-1L]
      }
      lines
    },

    # Release artifacts carried by output records, including nested children.
    release_output_artifacts = function(outputs) {
      if (is.null(outputs) || is.null(private$worker)) return(invisible())
      records <- if (is.list(outputs) && !is.null(outputs$kind)) {
        list(outputs)
      } else {
        outputs
      }
      for (output in records) {
        if (!is.list(output)) next
        if (output$kind %in% c("image", "html", "media") &&
            !is.null(output$artifact)) {
          tryCatch(private$worker$release_artifact(output$artifact),
                   error = function(e) NULL)
        }
        if (identical(output$kind, "layout")) {
          private$release_output_artifacts(output$children %||% list())
        }
        if (identical(output$kind, "lazy") && !is.null(output$child)) {
          private$release_output_artifacts(output$child)
        }
      }
      invisible()
    },

    note_action_error = function(token, code, message) {
      private$last_action_error <- list(token = token, code = code,
                                        message = message)
      invisible()
    },


    # Keep retained output bytes, but invalidate everything owned by an old
    # runtime. Repeat after teardown/readiness so late old-operation callbacks
    # cannot leave inspection state attached to a replacement worker.
    invalidate_runtime_view = function() {
      private$variables <- list()
      private$variables_operation <- NULL
      private$last_value <- NULL
      private$value_operation <- NULL
      private$lazy_operations <- list()
      private$table_operations <- list()
      private$button_resets <- list()
      for (id in private$dag_nodes()) {
        if (!identical(private$cell_type(id), "code")) next
        rec <- private$cell_state[[id]]
        if (!is.null(rec)) {
          rec$status <- "stale"
          private$cell_state[[id]] <- rec
        }
      }
      invisible()
    },

    detect_worker_failure = function() {
      if (!private$stopped && !private$worker_failed &&
          !is.null(private$worker) && !private$worker$alive()) {
        private$on_worker_failure("R worker exited")
      }
      invisible()
    },

    on_worker_failure = function(message) {
      cur <- private$current
      cur_id <- if (!is.null(cur)) cur$job$id else NULL
      private$fail_worker_transport(cur_id, message)
      invisible()
    },

    # A worker transport failure marks the active cell error, drops queued
    # jobs, sets worker_available false, and makes worker-dependent APIs
    # return 503; source editing, runtime selection, and conflict-safe
    # Save remain available.
    fail_worker_transport = function(current_id = NULL, message = "Worker exited") {
      if (private$worker_failed) return(invisible())
      private$worker_failed <- TRUE
      private$fail_pending_widget_operations("worker_unavailable", message)
      private$fail_pending_run_operations("worker_unavailable", message)
      for (id in private$dag_nodes()) {
        if (!identical(private$cell_type(id), "code")) next
        rec <- private$cell_state[[id]]
        if (!is.null(rec)) {
          if (!is.null(current_id) && identical(id, current_id)) {
            rec$status <- "error"
            rec$outputs <- list()
            rec$error <- list(message = message, class = "worker_error",
                              call = NULL, trace = character())
            rec$log <- c(rec$log, paste("Error:", message))
          } else {
            rec$status <- "stale"
          }
          private$cell_state[[id]] <- rec
        }
      }
      private$current <- NULL
      private$queue <- list()
      private$variables <- list()
      private$variables_operation <- NULL
      private$last_value <- NULL
      private$value_operation <- NULL
      private$lazy_operations <- list()
      private$table_operations <- list()
      private$button_resets <- list()
      private$note_action_error(
        NULL, "worker_unavailable",
        paste0(message, "; outputs are stale. Restart R to replay the notebook")
      )
      private$bump()
      invisible()
    },

    # The startup run executes all cells; a graph rejection is recorded in
    # last_action_error so the editor can repair.
    startup_run = function() {
      if (!private$run_on_startup) return(invisible())
      tryCatch(
        self$run_all(),
        alder_error = function(e) {
          if (identical(e$code, "graph_invalid")) {
            private$note_action_error(NULL, "graph_invalid",
                                      conditionMessage(e))
          } else if (identical(e$code, "worker_unavailable")) {
            invisible()
          } else {
            stop(e)
          }
        })
      invisible()
    },

    widget_operation_key = function(name, path = character()) {
      paste(c(name, path), collapse = "\u0001")
    },

    # Run records are intentionally independent of cell/output state: a run
    # can replace the widget owner's output before its reset response arrives.
    # A bounded Session journal preserves the exact causal identity for MCP.
    remember_run_operation = function(operation) {
      run_id <- operation$run_id %||% NULL
      if (!is.numeric(run_id) || length(run_id) != 1L || is.na(run_id) ||
          !is.finite(run_id) || run_id < 1 || run_id != floor(run_id)) {
        return(invisible())
      }
      key <- as.character(as.integer(run_id))
      private$run_operation_results[[key]] <- operation
      limit <- 256L
      excess <- length(private$run_operation_results) - limit
      if (excess > 0L) {
        private$run_operation_results <-
          private$run_operation_results[-seq_len(excess)]
      }
      invisible()
    },

    link_run_reset = function(run_id, reset_token) {
      if (is.null(run_id)) return(invisible())
      key <- as.character(as.integer(run_id))
      operation <- private$run_operation_results[[key]] %||% NULL
      if (is.null(operation) ||
          !identical(operation$status %||% NULL, "pending")) {
        return(invisible())
      }
      tokens <- unique(c(
        as.integer(operation$reset_tokens %||% integer()),
        as.integer(reset_token)
      ))
      operation$reset_tokens <- I(tokens)
      private$remember_run_operation(operation)
      private$refresh_run_operation(run_id)
      invisible()
    },

    fail_run_operation = function(run_id, code, message) {
      if (is.null(run_id)) return(invisible())
      key <- as.character(as.integer(run_id))
      operation <- private$run_operation_results[[key]] %||% NULL
      if (is.null(operation) ||
          !identical(operation$status %||% NULL, "pending")) {
        return(invisible())
      }
      operation$status <- "error"
      operation$error <- list(code = code, message = message)
      private$remember_run_operation(operation)
      invisible()
    },

    fail_pending_run_operations = function(code, message) {
      for (key in names(private$run_operation_results)) {
        operation <- private$run_operation_results[[key]]
        if (!identical(operation$status %||% NULL, "pending")) next
        operation$status <- "error"
        operation$error <- list(code = code, message = message)
        private$run_operation_results[[key]] <- operation
      }
      invisible()
    },

    refresh_run_operation = function(run_id) {
      key <- as.character(as.integer(run_id))
      operation <- private$run_operation_results[[key]] %||% NULL
      if (is.null(operation) ||
          !identical(operation$status %||% NULL, "pending") ||
          !isTRUE(operation$execution_done)) {
        return(invisible())
      }
      tokens <- as.integer(operation$reset_tokens %||% integer())
      for (token in tokens) {
        reset <- private$widget_operation_results[[as.character(token)]] %||%
          NULL
        if (is.null(reset) ||
            identical(reset$status %||% NULL, "pending")) {
          return(invisible())
        }
        if (!identical(reset$status %||% NULL, "done")) {
          error <- reset$error %||% list()
          operation$status <- "error"
          operation$error <- list(
            code = error$code %||% "widget_update_failed",
            message = error$message %||% "run button reset failed"
          )
          private$remember_run_operation(operation)
          return(invisible())
        }
      }
      operation$status <- "done"
      operation$error <- NULL
      private$remember_run_operation(operation)
      invisible()
    },

    refresh_runs_for_widget_operation = function(token) {
      for (key in names(private$run_operation_results)) {
        operation <- private$run_operation_results[[key]]
        if (!identical(operation$status %||% NULL, "pending")) next
        tokens <- as.integer(operation$reset_tokens %||% integer())
        if (as.integer(token) %in% tokens) {
          private$refresh_run_operation(operation$run_id)
        }
      }
      invisible()
    },

    complete_run_if_idle = function(run_id) {
      operation <- private$run_operation_results[[
        as.character(as.integer(run_id))
      ]] %||% NULL
      if (is.null(operation) ||
          !identical(operation$status %||% NULL, "pending") ||
          isTRUE(operation$execution_done) ||
          private$run_has_pending_jobs(run_id)) {
        return(invisible())
      }
      private$check_pending_button_resets(run_id)
      operation <- private$run_operation_results[[
        as.character(as.integer(run_id))
      ]] %||% operation
      if (!identical(operation$status %||% NULL, "pending")) {
        return(invisible())
      }
      operation$execution_done <- TRUE
      private$remember_run_operation(operation)
      private$refresh_run_operation(run_id)
      invisible()
    },

    # Retain a bounded token-indexed operation journal. Widget outputs expose
    # the latest operation per control, but a run-button reset can replace
    # that record before an asynchronous client next observes state.
    remember_widget_operation = function(operation) {
      token <- operation$token %||% NULL
      if (!is.numeric(token) || length(token) != 1L || is.na(token) ||
          !is.finite(token) || token < 1 || token != floor(token)) {
        return(invisible())
      }
      key <- as.character(as.integer(token))
      existing <- private$widget_operation_results[[key]] %||% list()
      for (field in setdiff(names(existing), names(operation))) {
        operation[[field]] <- existing[[field]]
      }
      private$widget_operation_results[[key]] <- operation
      limit <- 256L
      excess <- length(private$widget_operation_results) - limit
      if (excess > 0L) {
        private$widget_operation_results <-
          private$widget_operation_results[-seq_len(excess)]
      }
      private$refresh_runs_for_widget_operation(token)
      invisible()
    },

    link_widget_operation = function(trigger_token, reset_token) {
      if (is.null(trigger_token)) return(invisible())
      key <- as.character(as.integer(trigger_token))
      operation <- private$widget_operation_results[[key]] %||% NULL
      if (is.null(operation)) return(invisible())
      operation$reset_token <- as.integer(reset_token)
      private$remember_widget_operation(operation)
      invisible()
    },

    fail_pending_widget_operations = function(code, message) {
      for (key in names(private$widget_operation_results)) {
        operation <- private$widget_operation_results[[key]]
        if (identical(operation$status %||% NULL, "pending")) {
          operation$status <- "error"
          operation$error <- list(code = code, message = message)
          private$widget_operation_results[[key]] <- operation
        }
      }
      for (id in private$dag_nodes()) {
        private$map_cell_widgets(id, function(out) {
          ops <- out$operations %||% list()
          changed <- FALSE
          for (key in names(ops)) {
            operation <- ops[[key]]
            if (!identical(operation$status %||% NULL, "pending")) next
            operation$status <- "error"
            operation$error <- list(code = code, message = message)
            private$remember_widget_operation(operation)
            ops[[key]] <- operation
            changed <- TRUE
          }
          if (changed) {
            out$operations <- ops
            root_key <- private$widget_operation_key(
              out$name %||% "", character())
            root <- ops[[root_key]] %||% NULL
            if (!is.null(root)) out$operation <- root
          }
          out
        })
      }
      invisible()
    },

    widget_kind_at = function(spec, path = character()) {
      spec <- private$widget_spec_at(spec, path)
      if (is.null(spec)) return(NULL)
      as.character(spec$kind %||% "")
    },

    widget_spec_at = function(spec, path = character()) {
      if (is.null(spec) || !is.list(spec)) return(NULL)
      if (!length(path)) return(spec)
      if (identical(spec$kind, "form")) {
        return(private$widget_spec_at(spec$child, path))
      }
      if (!(spec$kind %in% c("array", "dictionary"))) return(NULL)
      children <- spec$children %||% list()
      idx <- which(vapply(children, function(child)
        identical(as.character(child$name %||% ""), path[[1L]]), logical(1)))
      if (!length(idx)) return(NULL)
      private$widget_spec_at(children[[idx[[1L]]]], path[-1L])
    },

    widget_path_has_form = function(spec, path = character()) {
      if (is.null(spec) || !is.list(spec)) return(FALSE)
      if (identical(spec$kind, "form")) return(TRUE)
      if (!length(path) ||
          !(spec$kind %in% c("array", "dictionary"))) return(FALSE)
      children <- spec$children %||% list()
      idx <- which(vapply(children, function(child) {
        identical(as.character(child$name %||% ""), path[[1L]])
      }, logical(1)))
      if (!length(idx)) return(FALSE)
      private$widget_path_has_form(children[[idx[[1L]]]], path[-1L])
    },

    widget_spec_patch = function(spec, path, selected, kind, update = NULL) {
      if (identical(spec$kind, "form") && !length(path) &&
          !identical(kind, "form")) {
        spec$child <- private$widget_spec_patch(
          spec$child, character(), selected, kind, update)
        spec$dirty <- TRUE
        return(spec)
      }
      if (!length(path)) {
        if (identical(kind, "table")) {
          spec$selected <- I(as.integer(selected$selected %||%
                                        selected$value %||% integer()))
        } else if (identical(kind, "dataframe")) {
          spec$value <- selected$value
          spec$ops <- update$ops %||% spec$ops
        } else if (identical(kind, "multiselect")) {
          spec$value <- I(selected$value)
        } else {
          spec$value <- selected$value
        }
        if (!is.null(selected$index)) spec$index <- as.integer(selected$index)
        if (!is.null(selected$indices)) {
          spec$indices <- I(as.integer(selected$indices))
        }
        if (!is.null(update$paused)) spec$paused <- isTRUE(update$paused)
        if (identical(kind, "form")) spec$dirty <- FALSE
        return(spec)
      }
      if (identical(spec$kind, "form")) {
        spec$child <- private$widget_spec_patch(
          spec$child, path, selected, kind, update)
        spec$dirty <- TRUE
        return(spec)
      }
      children <- spec$children %||% list()
      idx <- which(vapply(children, function(child)
        identical(as.character(child$name %||% ""), path[[1L]]), logical(1)))
      if (!length(idx)) return(spec)
      j <- idx[[1L]]
      children[[j]] <- private$widget_spec_patch(
        children[[j]], path[-1L], selected, kind, update)
      spec$children <- children
      spec$value <- lapply(children, function(child) child$value)
      names(spec$value) <- vapply(children, function(child)
        as.character(child$name %||% ""), character(1))
      spec
    },


    widget_owner = function(name) {
      location <- private$find_widget_output(name)
      if (is.null(location)) NULL else location$id
    },

    widget_send_value = function(kind, value) {
      if (kind %in% c("slider", "range_slider", "number")) return(as.double(value))
      if (kind %in% c("text_input", "text_area", "code_editor")) {
        return(as.character(value))
      }
      value
    },

    validate_widget_update = function(kind, update) {
      if (!is.list(update)) alder_abort("invalid_request",
                                        "widget update must be an object")
      if (kind %in% c("dropdown", "radio")) {
        idx <- update$index
        if (!is.numeric(idx) || length(idx) != 1L || is.na(idx) ||
            idx < 1 || idx != floor(idx)) {
          alder_abort("invalid_request", "choice index must be a positive integer")
        }
        return(list(index = as.integer(idx)))
      }
      if (identical(kind, "multiselect")) {
        idx <- private$decode_wire_vector(
          update$indices, "numeric", integer = TRUE)
        if (is.null(idx) || any(idx < 1L) || anyDuplicated(idx)) {
          alder_abort("invalid_request", "choice indices must be positive integers")
        }
        return(list(indices = idx))
      }
      if (kind %in% c("slider", "number") &&
          (!is.numeric(update$value) || length(update$value) != 1L ||
           is.na(update$value) || !is.finite(update$value))) {
        alder_abort("invalid_request", "numeric widget value required")
      }
      if (identical(kind, "range_slider")) {
        value <- private$decode_wire_vector(
          update$value, "numeric", expected_length = 2L)
        if (is.null(value)) {
          alder_abort("invalid_request", "range widget value required")
        }
        return(list(value = value))
      }
      if (kind %in% c("slider", "number")) {
        return(list(value = as.double(update$value)))
      }
      if (kind %in% c("text_input", "text_area", "code_editor") &&
          (!is.character(update$value) || length(update$value) != 1L ||
           is.na(update$value))) {
        alder_abort("invalid_request", "text widget value required")
      }
      if (kind %in% c("text_input", "text_area", "code_editor")) {
        return(list(value = update$value))
      }
      if (kind %in% c("checkbox", "switch", "run_button") &&
          (!is.logical(update$value) || length(update$value) != 1L ||
           is.na(update$value))) {
        alder_abort("invalid_request", "logical widget value required")
      }
      if (kind %in% c("checkbox", "switch", "run_button")) {
        return(list(value = update$value))
      }
      if (kind %in% c("button", "refresh") &&
          (!is.numeric(update$value) || length(update$value) != 1L ||
           is.na(update$value) || !is.finite(update$value) ||
           update$value < 0 || update$value != floor(update$value))) {
        alder_abort("invalid_request", "counter widget value required")
      }
      if (kind %in% c("button", "refresh")) {
        out <- list(value = as.integer(update$value))
        if (!is.null(update$paused)) {
          if (!is.logical(update$paused) || length(update$paused) != 1L ||
              is.na(update$paused)) {
            alder_abort("invalid_request", "refresh pause must be logical")
          }
          out$paused <- update$paused
        }
        return(out)
      }
      if (kind %in% c("date", "date_range", "datetime")) {
        expected <- if (identical(kind, "date_range")) 2L else 1L
        value <- private$decode_wire_vector(
          update$value, "character", expected_length = expected)
        valid <- if (identical(kind, "datetime")) {
          !is.null(value) && all(vapply(
            value, private$wire_datetime_valid, logical(1)
          ))
        } else {
          !is.null(value) && all(vapply(
            value, private$wire_date_valid, logical(1)
          ))
        }
        if (!valid) {
          alder_abort("invalid_request", "temporal widget value required")
        }
        return(list(value = value))
      }
      if (kind == "file") {
        value <- tryCatch(validate_file_value(update$value),
                          error = function(e) NULL)
        if (is.null(value)) alder_abort("invalid_request",
                                        "file value must have name, size, and path columns")
        return(list(value = value))
      }
      if (kind == "table") {
        idx <- private$decode_wire_vector(
          update$selected, "numeric", integer = TRUE)
        if (is.null(idx) || any(idx < 1L) || anyDuplicated(idx)) {
          alder_abort("invalid_request", "table selection must be integer indices")
        }
        return(list(selected = idx))
      }
      if (kind == "dataframe") {
        if (!is.list(update$ops %||% list())) alder_abort("invalid_request",
                                                          "dataframe ops must be an array")
        return(list(ops = update$ops %||% list()))
      }
      if (kind == "form") {
        if (!is.logical(update$submit) || length(update$submit) != 1L ||
            is.na(update$submit) || !isTRUE(update$submit)) {
          alder_abort("invalid_request", "form submit must be true")
        }
        return(list(submit = TRUE))
      }
      alder_abort("invalid_request", "unknown widget kind")
    },

    # Validate the worker's `selected` reply against the widget kind; a
    # mismatch is a transport failure (invalid worker response).
    decode_widget_selected = function(kind, resp) {
      sel <- resp$selected
      if (!is.list(sel)) return(list(ok = FALSE))
      typ <- as.character(sel$type %||% "")
      val <- sel$value
      if (kind == "table") {
        val <- private$decode_wire_vector(val, "numeric", integer = TRUE)
        if (!identical(typ, "integer") || is.null(val) || any(val < 1L)) {
          return(list(ok = FALSE))
        }
        return(list(ok = TRUE, value = val, selected = val))
      }
      if (kind %in% c("dataframe", "file") &&
          !identical(typ, "data.frame")) {
        return(list(ok = FALSE))
      }
      if (kind == "form") {
        if (!(typ %in% c(
          "logical", "integer", "double", "character", "list",
          "date", "date_range", "datetime", "data.frame"
        ))) return(list(ok = FALSE))
        return(list(ok = TRUE, value = val))
      }
      if (kind %in% c("date", "date_range", "datetime") &&
          !identical(typ, kind)) {
        return(list(ok = FALSE))
      }
      if (kind == "date_range") {
        raw <- private$decode_wire_vector(
          val, "character", expected_length = 2L)
        if (is.null(raw) || !all(vapply(
          raw, private$wire_date_valid, logical(1)
        ))) return(list(ok = FALSE))
        out <- list(ok = TRUE, value = raw)
      } else if (kind %in% c("date", "datetime")) {
        raw <- private$decode_wire_vector(
          val, "character", expected_length = 1L)
        valid <- if (identical(kind, "datetime")) {
          !is.null(raw) && all(vapply(
            raw, private$wire_datetime_valid, logical(1)
          ))
        } else {
          !is.null(raw) && all(vapply(
            raw, private$wire_date_valid, logical(1)
          ))
        }
        if (!valid) return(list(ok = FALSE))
        out <- list(ok = TRUE, value = raw)
      } else if (kind %in% c("dataframe", "file")) {
        out <- list(ok = TRUE, value = val)
      } else {
        allowed_types <- switch(kind,
          slider = "double", range_slider = "double", number = "double",
          dropdown = c("logical", "integer", "double", "character"),
          radio = c("logical", "integer", "double", "character"),
          multiselect = c("logical", "integer", "double", "character"),
          text_input = "character", text_area = "character",
          code_editor = "character", checkbox = "logical",
          switch = "logical", run_button = "logical",
          button = "integer", refresh = "integer",
          file = "data.frame", character())
        if (!(typ %in% allowed_types)) return(list(ok = FALSE))
        wire_type <- switch(typ,
          logical = "logical", integer = "numeric", double = "numeric",
          character = "character", NULL)
        expected <- if (identical(kind, "range_slider")) {
          2L
        } else if (identical(kind, "multiselect")) {
          NULL
        } else {
          1L
        }
        raw <- private$decode_wire_vector(
          val, wire_type, expected_length = expected,
          integer = identical(typ, "integer"))
        if (is.null(raw)) return(list(ok = FALSE))
        out <- list(ok = TRUE, value = raw)
      }
      if (!is.null(sel$index)) {
        idx <- sel$index
        if (!is.numeric(idx) || length(idx) != 1L || is.na(idx) ||
            idx < 1 || idx != floor(idx)) return(list(ok = FALSE))
        out$index <- as.integer(idx)
      }
      if (!is.null(sel$indices)) {
        idx <- private$decode_wire_vector(
          sel$indices, "numeric", integer = TRUE)
        if (is.null(idx) || any(idx < 1)) {
          return(list(ok = FALSE))
        }
        out$indices <- idx
      }
      if (identical(kind, "multiselect") && is.null(out$indices)) {
        return(list(ok = FALSE))
      }
      if (identical(kind, "multiselect") &&
          length(out$value) != length(out$indices)) {
        return(list(ok = FALSE))
      }
      out
    },
    # A widget response commits only while its control identity is still
    # live (pending); a cancelled/failed op or an edited owner never commits
    # late output.
    on_widget_response = function(name, owner, tok, kind, path, resp, source,
                                  update, draft = FALSE) {
      rec <- private$cell_state[[owner]]
      location <- private$find_widget_output(name)
      if (is.null(rec) || is.null(location) ||
          !identical(location$id, owner)) return(invisible())
      out <- location$output
      key <- private$widget_operation_key(name, path)
      ops <- out$operations %||% list()
      op <- ops[[key]] %||% NULL
      if (is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) return(invisible())
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        private$widget_op_error(name, owner, tok, "worker_unavailable",
                                "Worker exited before responding", path)
        return(invisible())
      }
      if (!isTRUE(resp$ok)) {
        private$widget_op_error(name, owner, tok, "widget_update_failed",
                                resp$error$message %||% "widget update failed",
                                path)
        return(invisible())
      }
      d <- private$decode_widget_selected(kind, resp)
      if (!isTRUE(d$ok)) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      out$spec <- private$widget_spec_patch(out$spec, path, d, kind, update)
      spec_error <- private$validate_widget_spec(out$spec)
      if (!is.null(spec_error)) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      op <- list(token = tok, status = "done", error = NULL)
      private$remember_widget_operation(op)
      ops[[key]] <- op
      out$operations <- ops
      if (!length(path)) out$operation <- op
      out$commit_token <- tok
      private$set_widget_output(owner, name, out)
      private$last_action_error <- NULL
      private$bump()
      if (isTRUE(draft)) return(invisible())
      if (identical(kind, "run_button")) {
        private$schedule_run_button(name, owner, source, tok, path)
      } else {
        # Buttons and refresh controls are counters/ticks. Their values stay
        # at the committed value; only run_button is a one-shot reset.
        private$schedule_widget_consumers(name, source)
      }
      invisible()
    },

    widget_op_error = function(name, owner, tok, code, message, path = NULL) {
      rec <- private$cell_state[[owner]]
      location <- private$find_widget_output(name)
      if (!is.null(rec) && !is.null(location) &&
          identical(location$id, owner)) {
        out <- location$output
        ops <- out$operations %||% list()
        if (is.null(path) || !length(path)) {
          keys <- names(ops)[vapply(ops, function(op)
            identical(op$token %||% NULL, tok), logical(1))]
          op <- list(
            token = tok, status = "error",
            error = list(code = code, message = message)
          )
          private$remember_widget_operation(op)
          if (length(keys)) ops[[keys[[1L]]]] <- op
          out$operations <- ops
          out$operation <- op
        } else {
          key <- private$widget_operation_key(name, path)
          op <- list(
            token = tok, status = "error",
            error = list(code = code, message = message)
          )
          private$remember_widget_operation(op)
          ops[[key]] <- op
          out$operations <- ops
        }
        private$set_widget_output(owner, name, out)
      }
      private$note_action_error(tok, code, message)
      private$bump()
      invisible()
    },

    # Every non-button widget: automatic/app code runs the referencing
    # consumers (never the defining cell); lazy mode marks them stale.
    schedule_widget_consumers = function(name, source) {
      refs <- private$cells_referencing(name, private$widget_owner(name))
      if (!length(refs)) return(invisible())
      if (identical(source, "app") || identical(private$execution_mode, "automatic")) {
        region <- unique(c(refs, unlist(lapply(refs, function(r)
          self$descendants(r)), use.names = FALSE)))
        private$cancel_run_region(region, "widget")
        plan <- private$widget_closure(refs, private$widget_owner(name))
        if (length(plan)) private$launch_run(plan) else private$bump()
      } else {
        for (r in refs) {
          private$mark_stale(r)
          for (d in self$descendants(r)) private$mark_stale(d)
        }
        private$bump()
      }
      invisible()
    },

    cells_referencing = function(name, exclude = NULL) {
      refs <- character()
      for (id in private$dag_nodes()) {
        if (identical(id, exclude)) next
        p <- private$analysis[[id]]
        if (!is.null(p) && name %in% c(p$refs, p$self_refs)) refs <- c(refs, id)
      }
      refs
    },

    # ui$run_button is a one-shot input: set TRUE for the interaction, then
    # reset to FALSE once its scheduled direct consumers finish, fail, are
    # cancelled, or disappear. Reset state is keyed by widget name + path.
    schedule_run_button = function(name, owner, source, tok,
                                   path = character()) {
      key <- private$widget_operation_key(name, path)
      refs <- private$cells_referencing(name, owner)
      if (!length(refs)) {
        private$send_button_reset(name, path, trigger_token = tok)
        private$bump()
        return(invisible())
      }
      info <- list(name = name, path = path, owner = owner, run_id = NULL,
                   direct = refs, trigger_token = tok)
      if (identical(source, "app") ||
          identical(private$execution_mode, "automatic")) {
        region <- unique(c(refs, unlist(lapply(refs, function(r)
          self$descendants(r)), use.names = FALSE)))
        private$cancel_run_region(region, "widget")
        plan <- private$widget_closure(refs, owner)
        info$run_id <- private$launch_run(plan)
      } else {
        # Lazy editor mode: mark direct consumers stale; reset only after
        # each has participated in a later explicit run.
        for (r in refs) {
          private$mark_stale(r)
          for (d in self$descendants(r)) private$mark_stale(d)
        }
      }
      private$button_resets[[key]] <- info
      private$bump()
      invisible()
    },

    widget_closure = function(roots, definers) {
      plan <- roots
      repeat {
        n <- length(plan)
        for (p in plan) plan <- unique(c(plan, self$descendants(p)))
        for (p in plan) {
          plan <- unique(c(plan, private$needs_run(self$ancestors(p))))
        }
        if (length(plan) == n) break
      }
      plan <- setdiff(plan, definers)
      private$topo_order_of(plan)
    },

    automatic_closure = function(roots) {
      plan <- roots
      repeat {
        n <- length(plan)
        for (p in plan) plan <- unique(c(plan, self$descendants(p)))
        for (p in plan) {
          plan <- unique(c(plan, private$needs_run(self$ancestors(p))))
        }
        if (length(plan) == n) break
      }
      private$topo_order_of(plan)
    },

    lazy_closure = function(roots) {
      plan <- roots
      repeat {
        n <- length(plan)
        for (p in plan) {
          plan <- unique(c(plan, private$needs_run(self$ancestors(p))))
        }
        if (length(plan) == n) break
      }
      private$topo_order_of(plan)
    },


    send_button_reset = function(name, path = character(),
                                 trigger_token = NULL, run_id = NULL) {
      location <- private$find_widget_output(name)
      if (is.null(location)) {
        private$fail_run_operation(
          run_id, "widget_not_current", "run button is no longer current"
        )
        return(invisible())
      }
      if (!self$worker_available()) {
        private$fail_run_operation(
          run_id, "worker_unavailable", "R worker is unavailable"
        )
        return(invisible())
      }
      owner <- location$id
      rec <- private$cell_state[[owner]]
      out <- location$output
      if (is.null(rec) || is.null(out)) {
        private$fail_run_operation(
          run_id, "widget_not_current", "run button is no longer current"
        )
        return(invisible())
      }
      path <- as.character(path %||% character())
      key <- private$widget_operation_key(name, path)
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      pending <- list(token = tok, status = "pending", error = NULL)
      private$remember_widget_operation(pending)
      private$link_widget_operation(trigger_token, tok)
      private$link_run_reset(run_id, tok)
      ops <- out$operations %||% list()
      ops[[key]] <- pending
      out$operations <- ops
      if (!length(path)) out$operation <- pending
      private$set_widget_output(owner, name, out)
      private$worker$send(
        "set_widget", name = name, path = I(path), value = FALSE,
        op_id = as.integer(tok),
        on_response = function(context, resp)
          private$on_button_reset_response(name, owner, path, tok, resp)
      )
      invisible(tok)
    },

    on_button_reset_response = function(name, owner, path, tok, resp) {
      rec <- private$cell_state[[owner]]
      location <- private$find_widget_output(name)
      if (is.null(rec) || is.null(location) ||
          !identical(location$id, owner)) return(invisible())
      out <- location$output
      key <- private$widget_operation_key(name, path)
      ops <- out$operations %||% list()
      op <- ops[[key]] %||% NULL
      if (is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) {
        return(invisible())
      }
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        private$widget_op_error(name, owner, tok, "worker_unavailable",
                                "Worker exited before responding", path)
        return(invisible())
      }
      if (!isTRUE(resp$ok)) {
        private$widget_op_error(
          name, owner, tok, "widget_update_failed",
          resp$error$message %||% "button reset failed", path
        )
        return(invisible())
      }
      kind <- private$widget_kind_at(out$spec, path)
      d <- private$decode_widget_selected(kind %||% "run_button", resp)
      if (!isTRUE(d$ok)) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      out$spec <- private$widget_spec_patch(
        out$spec, path, d, kind %||% "run_button", list(value = FALSE)
      )
      op <- list(token = tok, status = "done", error = NULL)
      private$remember_widget_operation(op)
      ops[[key]] <- op
      out$operations <- ops
      if (!length(path)) out$operation <- op
      out$commit_token <- tok
      private$set_widget_output(owner, name, out)
      private$last_action_error <- NULL
      private$bump()
      invisible()
    },

    check_pending_button_resets = function(completed_run_id = NULL) {
      if (!length(private$button_resets)) return(invisible())
      for (key in names(private$button_resets)) {
        info <- private$button_resets[[key]]
        if (is.null(info)) next
        if (is.null(info$run_id)) {
          # Lazy mode: reset only after every direct consumer has
          # participated in a later explicit run (done or errored).
          remaining <- info$direct[vapply(
            info$direct,
            function(r) !private$status_of(r) %in%
              c("done", "error", "stopped"),
            FALSE
          )]
          if (!length(remaining)) {
            private$send_button_reset(
              info$name, info$path, trigger_token = info$trigger_token,
              run_id = completed_run_id)
            private$button_resets[[key]] <- NULL
          }
          next
        }
        if (!private$run_has_pending_jobs(info$run_id)) {
          private$send_button_reset(
            info$name, info$path, trigger_token = info$trigger_token,
            run_id = info$run_id)
          private$button_resets[[key]] <- NULL
        }
      }
      invisible()
    },

    run_has_pending_jobs = function(rid) {
      cur <- private$current
      if (!is.null(cur) && !is.null(cur$job) &&
          identical(cur$job$run_id, rid)) return(TRUE)
      length(private$queue) > 0L &&
        any(vapply(private$queue, function(j) identical(j$run_id, rid), FALSE))
    },

    # On source/delete changes intersect tracked button reset sets with
    # still-existing direct consumers and reset when empty.
    refresh_button_resets = function() {
      if (!length(private$button_resets)) return(invisible())
      for (key in names(private$button_resets)) {
        info <- private$button_resets[[key]]
        if (is.null(info)) next
        still <- private$cells_referencing(info$name, info$owner)
        if (!length(still)) {
          private$send_button_reset(
            info$name, info$path, trigger_token = info$trigger_token)
          private$button_resets[[key]] <- NULL
        } else {
          info$direct <- still
          private$button_resets[[key]] <- info
        }
      }
      invisible()
    },


    value_owner = function(name) {
      owner <- private$definition_owner(name)
      if (!is.null(owner)) return(owner)
      # Retain a former owner's identity while its removed runtime binding is
      # being cleared. A source deletion must not make an old value unowned.
      for (value in private$variables) {
        if (identical(value$name, name)) return(value$owner %||% NULL)
      }
      NULL
    },
    value_is_current = function(name, owner, revision = NULL) {
      current <- private$definition_owner(name)
      if (is.null(owner)) owner <- current
      if (is.null(owner)) return(TRUE)
      owners <- vapply(private$dag_nodes(), function(id)
        name %in% (private$analysis[[id]]$defs %||% character()), FALSE)
      if (sum(owners) != 1L || !identical(current, owner) ||
          !identical(private$status_of(owner), "done")) return(FALSE)
      is.null(revision) ||
        identical(private$cell_state[[owner]]$revision, revision)
    },
    stale_value_message = function(name) {
      paste0("Value ", sQuote(name), " is not current. Run its defining cell ",
             "and required dependencies, then inspect it again.")
    },
    refresh_value_freshness = function() {
      value <- private$last_value
      if (!is.null(value) && !private$value_is_current(
          value$name, value$owner, value$revision)) {
        private$last_value <- NULL
      }
      op <- private$value_operation
      if (!is.null(op) && op$status %in% c("pending", "done") &&
          !private$value_is_current(op$name, op$owner, op$revision)) {
        op$status <- "error"
        op$error <- list(code = "stale_value",
                         message = private$stale_value_message(op$name))
        private$value_operation <- op
      }
      invisible()
    },
    on_value_response = function(name, tok, resp) {
      private$refresh_value_freshness()
      vop <- private$value_operation
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        private$value_operation <- list(token = tok, name = name,
                                        status = "error",
                                        error = list(code = "worker_unavailable",
                                                     message = "Worker exited"))
        private$note_action_error(tok, "worker_unavailable", "Worker exited")
        private$bump()
        return(invisible())
      }
      if (is.null(vop) || !identical(vop$token, tok)) {
        # superseded: never commit a newer-request value
        return(invisible())
      }
      if (!identical(resp$name, name) || !identical(resp$token, tok)) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      if (isTRUE(resp$ok)) {
        v <- resp$value
        if (!private$validate_value_payload(v)) {
          if (self$worker_available()) {
            private$worker$transport_error("invalid worker response")
          }
          return(invisible())
        }
        if (!identical(vop$status, "pending") ||
            !private$value_is_current(name, vop$owner, vop$revision)) {
          private$release_output_artifacts(list(v))
          private$bump()
          return(invisible())
        }
        private$last_value <- list(token = tok, name = name, value = v,
                                   owner = vop$owner, revision = vop$revision)
        private$value_operation <- list(token = tok, name = name,
                                        owner = vop$owner, revision = vop$revision,
                                        status = "done", error = NULL)
        private$last_action_error <- NULL
      } else {
        if (!identical(vop$status, "pending")) return(invisible())
        private$value_operation <- list(token = tok, name = name,
                                        status = "error",
                                        error = list(code = "value_request_failed",
                                                     message = resp$error$message %||%
                                                       "value request failed"))
        private$note_action_error(tok, "value_request_failed",
                                  resp$error$message %||% "value request failed")
      }
      private$bump()
      invisible()
    },

    validate_value_payload = function(v) {
      if (is.null(v)) return(TRUE)  # visible NULL
      if (!is.list(v) || is.null(v$kind) || !is.character(v$kind) ||
          !(v$kind %in% c("text", "table", "image", "html"))) {
        return(FALSE)
      }
      if (v$kind %in% c("image", "html")) {
        a <- v$artifact
        if (is.null(a) || length(a) != 1L || !is.character(a) ||
            !grepl("^[A-Za-z0-9._-]+\\.(png|html)$", a)) {
          return(FALSE)
        }
      }
      TRUE
    },


    # clear_cell runs before any later eval of the same cell so a removed
    # definition cannot survive only because the new DAG lost its old edge.
    enqueue_clear_cell = function(id) {
      if (!is.null(private$worker) && self$worker_available()) {
        private$worker$send(
          "clear_cell", id = id,
          on_response = function(context, resp)
            private$on_clear_cell_response(id, resp))
      }
      invisible()
    },
    on_clear_cell_response = function(id, resp) {
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        return(invisible())
      }
      private$refresh_variables()
      invisible()
    },

    handle_barrier_invalidation = function() {
      for (id in private$dag_nodes()) {
        if (identical(private$cell_type(id), "code")) private$mark_stale(id)
      }
      private$barrier_restart_required <- TRUE
      private$bump()
      invisible()
    }
  )
)
