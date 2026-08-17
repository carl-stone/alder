# Session: the complete per-notebook execution state machine.
#
# The Session owns the notebook data, its dependency DAG, per-cell runtime
# state, the run queue, and the single serial worker process. It is driven
# entirely by the server routes, which translate HTTP requests into Session
# method calls and map thrown conditions to HTTP status codes. No mutable
# session field is ever read outside this file.

Session <- R6::R6Class(
  "alder_session",
  public = list(
    initialize = function(notebook, worker = NULL,
                          execution_mode = c("automatic", "lazy"),
                          run_on_startup = TRUE,
                          disk_version = list(exists = NA, bytes = raw())) {
      execution_mode <- match.arg(execution_mode)
      private$notebook <- notebook
      private$disk_version <- disk_version
      private$execution_mode <- execution_mode
      private$run_on_startup <- run_on_startup
      private$state_version <- 0L
      private$changed <- FALSE
      private$run_counter <- 0L
      private$op_counter <- 0L
      private$worker_failed <- FALSE
      private$stopped <- FALSE
      private$barrier_restart_required <- FALSE
      private$queue <- list()
      private$cell_state <- list()
      private$button_resets <- list()
      private$last_action_error <- NULL
      private$last_value <- NULL
      private$value_operation <- NULL
      private$current <- NULL
      private$analysis <- list()
      private$dag <- NULL
      private$topo <- character()
      if (!is.null(worker)) {
        private$worker <- worker
        worker$set_on_failure(function(message) private$on_worker_failure(message))
      }
      private$recompute()
      # Markdown cells never execute: render them locally and mark done so
      # a freshly loaded notebook already shows its Markdown (plan §8).
      for (id in private$dag_nodes()) {
        if (identical(private$cell_type(id), "markdown")) {
          private$cell_state[[id]] <- list(
            status = "done",
            output = render_markdown_cell_output(nb_cell(private$notebook, id)$body),
            log = character(), revision = 0L, diagnostics = list())
        }
      }
      private$bump()
      private$startup_run()
    },

    # ------------------------------------------------------------------
    # Read-only state
    # ------------------------------------------------------------------

    worker_available = function() {
      !private$worker_failed && !private$stopped &&
        !is.null(private$worker) && private$worker$alive()
    },

    # Full client-visible state snapshot. log/diagnostic arrays, the dag
    # node list, and the topological plan stay arrays under JSON via I().
    state = function() {
      nodes <- private$dag_nodes()
      cells <- lapply(private$notebook$cells, function(c) {
        rec <- private$cell_state[[c$id]] %||%
          list(status = "idle", output = NULL, log = character(),
               revision = 0L, diagnostics = list())
        list(id = c$id, type = c$type, delim = c$delim,
             body = I(c$body %||% character()),
             options = c$options,
             status = rec$status,
             output = rec$output,
             log = I(rec$log %||% character()),
             revision = rec$revision %||% 0L,
             diagnostics = I(rec$diagnostics %||% list()))
      })
      list(
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
        cells = cells,
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
        last_action_error = private$last_action_error
      )
    },

    # ------------------------------------------------------------------
    # Graph validation
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Topological queries (also used by the app view)
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Cell source mutation
    # ------------------------------------------------------------------

    set_cell = function(id, body, type, expected_revision = NULL) {
      private$assert_active()
      if (!id %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", id))
      }
      if (!(identical(type, "code") || identical(type, "markdown"))) {
        alder_abort("invalid_request",
                    "cell type must be \"code\" or \"markdown\"")
      }
      if (!is.character(body) || anyNA(body)) {
        alder_abort("invalid_request",
                    "cell body must be a character array")
      }
      old <- private$cell_state[[id]]
      if (!is.null(expected_revision) &&
          !identical(as.integer(expected_revision), old$revision)) {
        alder_abort("source_conflict",
                    paste("cell", id, "changed on the server"))
      }
      cs <- private$cell_source(id)
      if (identical(cs$body, body) && identical(cs$type, type)) {
        # exact same-body/same-type edit is a successful no-op
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
      private$bump()

      if (identical(type, "markdown")) {
        # a code-to-Markdown change releases the old artifact
        rec <- private$cell_state[[id]]
        private$release_output_artifacts(rec$output)
        rec$status <- "done"
        rec$output <- render_markdown_cell_output(body)
        rec$log <- character()
        rec$revision <- old$revision
        private$cell_state[[id]] <- rec
        for (d in unique(c(old_desc, new_desc))) {
          if (!is.null(private$cell_state[[d]])) private$mark_stale(d)
        }
      } else {
        # code cell: keep stale output/artifact, stale the affected union
        affected <- unique(c(id, old_desc, new_desc))
        for (a in affected) {
          if (!is.null(private$cell_state[[a]])) private$mark_stale(a)
        }
        if (!identical(cs$type, type)) {
          # markdown -> code conversion: retained output no longer matches
          rec <- private$cell_state[[id]]
          private$release_output_artifacts(rec$output)
          rec$output <- NULL
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

    add_cell = function(after = NULL, body = character(), type = "code") {
      private$assert_active()
      if (!is.null(after) && !after %in% private$dag_nodes()) {
        alder_abort("not_found", paste("no such cell:", after))
      }
      if (!(identical(type, "code") || identical(type, "markdown"))) {
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
        rec$output <- render_markdown_cell_output(body)
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
      if (!is.null(expected_revision) &&
          !identical(as.integer(expected_revision), old$revision)) {
        alder_abort("source_conflict",
                    paste("cell", id, "changed on the server"))
      }
      old_barrier <- isTRUE(private$analysis[[id]]$barrier)
      old_desc <- self$descendants(id)
      private$cancel_run_region(unique(c(id, old_desc)), "source")
      private$cancel_owned_ops(id)
      private$release_output_artifacts(old$output)
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

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Runtime mode
    # ------------------------------------------------------------------

    set_runtime = function(execution_mode) {
      private$assert_active()
      em <- match.arg(execution_mode, c("automatic", "lazy"))
      private$execution_mode <- em
      private$last_action_error <- NULL
      private$bump()
      list(execution_mode = em, version = private$state_version)
    },

    # Read-only current runtime mode for server dispatch (e.g. which global
    # run action applies).
    get_execution_mode = function() {
      private$execution_mode
    },

    # ------------------------------------------------------------------
    # Widgets and value inspection
    # ------------------------------------------------------------------

    # Apply a widget update, returning the operation token. Throws 409
    # operation_in_progress when the same widget already has a pending op.
    set_widget = function(name, update, source = c("editor", "app")) {
      source <- match.arg(source)
      private$assert_active()
      g <- self$validate_graph()
      if (!is.null(g)) {
        alder_abort("graph_invalid", paste(g, collapse = "\n"), messages = g)
      }
      if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name)) {
        alder_abort("invalid_request", "widget name invalid")
      }
      owner <- private$widget_owner(name)
      if (is.null(owner)) {
        alder_abort("invalid_request", paste("no such widget:", name))
      }
      rec <- private$cell_state[[owner]]
      out <- rec$output
      if (!identical(rec$status, "done") || is.null(out) ||
          !identical(out$kind, "widget")) {
        alder_abort("widget_not_current",
                    paste("widget", name, "is not current"))
      }
      kind <- out$spec$kind %||% "unknown"
      if (!kind %in% c("slider", "number", "text_input", "checkbox",
                       "dropdown", "run_button")) {
        alder_abort("invalid_request", "unknown widget kind")
      }
      update <- private$validate_widget_update(kind, update)
      op <- out$operation
      if (!is.null(op) && identical(op$status, "pending")) {
        alder_abort("operation_in_progress",
                    paste("widget", name, "already has a pending update"))
      }
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      out$operation <- list(token = tok, status = "pending", error = NULL)
      rec$output <- out
      private$cell_state[[owner]] <- rec
      private$bump()

      if (identical(kind, "dropdown")) {
        private$worker$send("set_widget", name = name,
                            index = as.integer(update$index),
                            op_id = as.integer(tok),
                            on_response = function(context, resp)
                              private$on_widget_response(name, owner, tok,
                                                         kind, resp, source))
      } else {
        private$worker$send("set_widget", name = name,
                            value = private$widget_send_value(kind, update$value),
                            op_id = as.integer(tok),
                            on_response = function(context, resp)
                              private$on_widget_response(name, owner, tok,
                                                         kind, resp, source))
      }
      tok
    },

    # Inspect one top-level value; results land in state()$last_value.
    request_value = function(name) {
      private$assert_active()
      if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name)) {
        alder_abort("invalid_request", "value name invalid")
      }
      vop <- private$value_operation
      if (!is.null(vop) && identical(vop$status, "pending")) {
        alder_abort("operation_in_progress", "a value request is already pending")
      }
      if (!self$worker_available()) {
        alder_abort("worker_unavailable", "worker is not available")
      }
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      private$value_operation <- list(token = tok, name = name,
                                      status = "pending", error = NULL)
      private$bump()
      private$worker$send("get_value", name = name, token = as.integer(tok),
                          on_response = function(context, resp)
                            private$on_value_response(name, tok, resp))
      tok
    },

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    stop = function() {
      if (private$stopped) return(invisible())
      private$stopped <- TRUE
      if (!is.null(private$worker)) {
        tryCatch(private$worker$stop(grace = 0.2), error = function(e) NULL)
        # bounded wait: let the shutdown request land and the deferred kill
        # fire before the caller removes the artifact directory, so a
        # still-booting worker cannot fail its startup validation afterwards
        later::run_now(0.3)
        if (private$worker$alive()) {
          tryCatch(private$worker$kill(), error = function(e) NULL)
        }
      }
      invisible()
    },

    active = function() !private$stopped
  ),

  private = list(
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
    state_version = 0L,
    changed = FALSE,
    run_counter = 0L,
    op_counter = 0L,
    worker_failed = FALSE,
    stopped = FALSE,
    barrier_restart_required = FALSE,
    button_resets = list(),
    last_action_error = NULL,
    last_value = NULL,
    value_operation = NULL,
    disk_version = list(exists = NA, bytes = raw()),

    # --- small navigation helpers ------------------------------------

    dag_nodes = function() as.character(private$dag$nodes %||% character()),
    cell_source = function(id) nb_cell(private$notebook, id),
    cell_body = function(id) nb_cell(private$notebook, id)$body,
    cell_type = function(id) nb_cell(private$notebook, id)$type,
    cell_record = function(id) private$cell_state[[id]],
    status_of = function(id) {
      rec <- private$cell_state[[id]]
      if (is.null(rec)) "idle" else rec$status
    },
    needs_run = function(ids) {
      ids[vapply(ids, function(id)
        private$status_of(id) %in% c("idle", "stale", "error"), FALSE)]
    },
    topo_order_of = function(ids) private$topo[private$topo %in% ids],
    bump = function() {
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

    # --- graph + analysis ---------------------------------------------

    recompute = function() {
      cells <- private$notebook$cells
      analysis <- list()
      dagcells <- vector("list", length(cells))
      for (i in seq_along(cells)) {
        c <- cells[[i]]
        if (identical(c$type, "code")) {
          p <- cell_defs_refs(c$body)
        } else {
          p <- list(defs = character(), refs = character(),
                    self_refs = character(), barrier = FALSE,
                    diagnostics = list(), error = NULL)
        }
        analysis[[c$id]] <- p
        dagcells[[i]] <- list(
          id = c$id, type = c$type,
          defs = p$defs %||% character(),
          refs = p$refs %||% character(),
          self_refs = p$self_refs %||% character(),
          barrier = isTRUE(p$barrier))
      }
      private$analysis <- analysis
      d <- build_dag(dagcells)
      private$dag <- d
      private$topo <- topo_order(d$edges, as.character(d$nodes %||% character()))
      for (id in private$dag_nodes()) {
        if (is.null(private$cell_state[[id]])) {
          private$cell_state[[id]] <- list(
            status = "idle", output = NULL, log = character(),
            revision = 0L, diagnostics = list())
        }
      }
      private$refresh_diagnostics()
      invisible()
    },

    refresh_diagnostics = function() {
      dups <- private$dag$duplicates %||% list()
      bad_names <- sort(names(dups))
      cycles <- as.character(private$dag$cycles %||% character())
      for (id in private$dag_nodes()) {
        rec <- private$cell_state[[id]]
        p <- private$analysis[[id]] %||%
          list(defs = character(), refs = character(), self_refs = character(),
               diagnostics = list(), error = NULL)
        diags <- list()
        if (!is.null(p$error)) {
          diags <- c(diags, list(list(level = "error", code = "syntax-error",
                                      message = p$error, symbol = NULL)))
        }
        for (d in p$diagnostics) {
          diags <- c(diags, list(list(
            level = d$level %||% "error",
            code = d$code %||% "analysis",
            message = d$message %||% "analysis error",
            symbol = d$symbol %||% NULL)))
        }
        if (length(cycles) && id %in% cycles) {
          diags <- c(diags, list(list(
            level = "error", code = "dependency-cycle",
            message = paste("dependency cycle:",
                            paste(cycles, collapse = ", ")),
            symbol = NULL)))
        }
        mine <- intersect(p$defs, bad_names)
        if (length(mine)) {
          diags <- c(diags, list(list(
            level = "error", code = "duplicate-definition",
            message = paste("duplicate definition:",
                            paste(mine, collapse = ", ")),
            symbol = NULL)))
        }
        rec$diagnostics <- diags
        private$cell_state[[id]] <- rec
      }
      invisible()
    },

    # --- stale marking ------------------------------------------------

    mark_stale = function(id) {
      rec <- private$cell_state[[id]]
      if (is.null(rec)) return(invisible())
      st <- rec$status
      if (st %in% c("done", "error")) {
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
      invisible()
    },

    # --- cancellation of in-flight work --------------------------------

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

    # Cancel any pending widget operation owned by this cell so its late
    # response cannot commit against the edited record; the retained
    # output reports the operation failed with widget_not_current.
    cancel_owned_ops = function(id) {
      rec <- private$cell_state[[id]]
      if (is.null(rec) || is.null(rec$output)) return(invisible())
      op <- rec$output$operation
      if (!is.null(op) && identical(op$status, "pending")) {
        op$status <- "cancelled"
        op$error <- list(code = "widget_not_current",
                         message = "widget owner changed")
        rec$output$operation <- op
        private$cell_state[[id]] <- rec
      }
      invisible()
    },

    # --- run launch + pumping ------------------------------------------

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
      invisible()
    },

    launch_run = function(plan) {
      rid <- private$run_counter + 1L
      private$run_counter <- rid
      private$enqueue_targets(plan, rid)
      private$pump()
      rid
    },

    enqueue_targets = function(plan, rid) {
      for (id in private$topo_order_of(plan)) {
        if (!identical(private$cell_type(id), "code")) next
        p <- private$analysis[[id]]
        defs <- if (is.null(p)) character() else (as.character(p$defs %||% character()))
        private$queue[[length(private$queue) + 1L]] <- list(
          id = id, code = private$cell_body(id),
          revision = private$cell_record(id)$revision,
          run_id = rid, defs = as.list(defs))
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
      req <- private$worker$send(
        "eval_cell", id = job$id, code = job$code, run_id = job$run_id,
        revision = job$revision, defs = job$defs,
        on_response = function(context, resp)
          private$on_cell_result(job, resp))
      private$current <- list(job = job, req = req, cancel_mode = NULL)
      invisible()
    },

    # --- eval responses -----------------------------------------------

    on_cell_result = function(job, resp) {
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
      private$current <- NULL
      private$bump()
      private$check_pending_button_resets()
      private$pump()
      invisible()
    },

    validate_eval_response = function(resp) {
      if (!is.logical(resp$ok) || length(resp$ok) != 1L || is.na(resp$ok)) {
        return("eval response missing ok")
      }
      if (!is.null(resp$log) &&
          !(is.character(resp$log) || is.list(resp$log))) {
        return("eval response log invalid")
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
      }
      v <- resp$value
      if (isFALSE(resp$ok) && !is.null(v)) {
        return("eval response value on failure")
      }
      if (is.null(v)) return(NULL)
      if (!is.list(v) || !is.character(v$kind) || length(v$kind) != 1L ||
          is.na(v$kind)) {
        return("eval response value kind invalid")
      }
      # JSON arrays arrive as lists of scalars under simplifyVector = FALSE;
      # accept either the atomic form or scalar-element lists.
      coll_ok <- function(x) {
        (is.logical(x) || is.numeric(x) || is.character(x)) ||
          (is.list(x) && all(vapply(x, function(e)
            (is.logical(e) || is.numeric(e) || is.character(e)) &&
              length(e) == 1L && !is.na(e), FALSE)))
      }
      charcoll_ok <- function(x) {
        is.character(x) || (is.list(x) && all(vapply(x, function(e)
          is.character(e) && length(e) == 1L && !is.na(e), FALSE)))
      }
      switch(v$kind,
        text = {
          if (!is.character(v$text) || length(v$text) != 1L || is.na(v$text)) {
            return("text output invalid")
          }
          if (!is.null(v$truncated) &&
              (!is.logical(v$truncated) || length(v$truncated) != 1L ||
               is.na(v$truncated))) {
            return("text output invalid")
          }
        },
        table = {
          if (!is.numeric(v$nrow) || length(v$nrow) != 1L || is.na(v$nrow) ||
              v$nrow < 0 || !is.numeric(v$ncol) || length(v$ncol) != 1L ||
              is.na(v$ncol) || v$ncol < 0) {
            return("table output invalid")
          }
          for (f in c("truncated_rows", "truncated_columns")) {
            if (!is.logical(v[[f]]) || length(v[[f]]) != 1L || is.na(v[[f]])) {
              return("table output invalid")
            }
          }
          if (!is.null(v$columns) && !charcoll_ok(v$columns)) {
            return("table output invalid")
          }
          if (!is.list(v$preview) || length(v$preview) > 25L) {
            return("table output invalid")
          }
          for (row in v$preview) {
            if (!is.list(row) || length(row) > 50L) {
              return("table output invalid")
            }
            ok <- all(vapply(row, function(x)
              is.character(x) && length(x) == 1L && !is.na(x), FALSE))
            if (!ok) return("table output invalid")
          }
        },
        image = {
          a <- v$artifact
          if (is.null(a) || length(a) != 1L || !is.character(a) ||
              is.na(a) || !grepl("^[A-Za-z0-9._-]+\\.png$", a)) {
            return("image output invalid")
          }
          if (!is.null(v$alt_text) &&
              (!is.character(v$alt_text) || length(v$alt_text) != 1L)) {
            return("image output invalid")
          }
        },
        html = {
          a <- v$artifact
          if (is.null(a) || length(a) != 1L || !is.character(a) ||
              is.na(a) || !grepl("^[A-Za-z0-9._-]+\\.html$", a)) {
            return("html output invalid")
          }
          if (!is.null(v$height) &&
              (!is.numeric(v$height) || length(v$height) != 1L ||
               is.na(v$height))) {
            return("html output invalid")
          }
        },
        widget = {
          if (!is.character(v$name) || length(v$name) != 1L || is.na(v$name) ||
              !is.character(v$owner) || length(v$owner) != 1L ||
              is.na(v$owner)) {
            return("widget output invalid")
          }
          ct <- v$commit_token
          # worker renders NULL; the Session later records its integer token
          if (!is.null(ct) &&
              !((is.numeric(ct) || is.character(ct)) && length(ct) == 1L &&
                !is.na(ct))) {
            return("widget output invalid")
          }
          sp <- v$spec
          if (!is.list(sp) || !is.character(sp$kind) ||
              length(sp$kind) != 1L ||
              !(sp$kind %in% c("slider", "number", "text_input", "checkbox",
                               "dropdown", "run_button"))) {
            return("widget output invalid")
          }
          if (!is.null(sp$label) &&
              (!is.character(sp$label) || length(sp$label) != 1L)) {
            return("widget output invalid")
          }
          sv <- sp$value
          if (!is.null(sv) && !((is.numeric(sv) || is.logical(sv)) &&
                                length(sv) == 1L) &&
              !(is.character(sv) && length(sv) == 1L)) {
            return("widget output invalid")
          }
          if (sp$kind %in% c("slider", "number")) {
            for (f in c("min", "max", "step")) {
              if (!is.null(sp[[f]]) &&
                  (!is.numeric(sp[[f]]) || length(sp[[f]]) != 1L ||
                   is.na(sp[[f]]))) {
                return("widget output invalid")
              }
            }
          }
          if (identical(sp$kind, "dropdown")) {
            if (!coll_ok(sp$choices) || !length(sp$choices)) {
              return("widget output invalid")
            }
            if (!is.numeric(sp$index) || length(sp$index) != 1L ||
                is.na(sp$index)) {
              return("widget output invalid")
            }
          }
        },
        return("eval response value kind invalid"))
      NULL
    },

    # A discarded response must never leave a rendered artifact behind.
    discard_late = function(resp) {
      if (isTRUE(resp$ok) && !is.null(resp$value)) {
        private$release_output_artifacts(resp$value)
      }
      invisible()
    },

    # --- commit transitions --------------------------------------------

    commit_success = function(id, resp) {
      rec <- private$cell_state[[id]]
      private$release_output_artifacts(rec$output)
      rec$status <- "done"
      rec$output <- resp$value
      rec$log <- private$normalize_log(resp$log)
      private$cell_state[[id]] <- rec
      private$last_action_error <- NULL
      invisible()
    },

    commit_failure = function(id, resp, drop_descendants) {
      rec <- private$cell_state[[id]]
      private$release_output_artifacts(rec$output)
      rec$status <- "error"
      rec$output <- NULL
      if (isTRUE(resp$error$interrupted)) {
        line <- "Error: Interrupted"
      } else {
        line <- paste("Error:", resp$error$message %||% "Unknown error")
      }
      rec$log <- c(rec$log, line)
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
      private$note_action_error(NULL, "eval_error",
                                resp$error$message %||% "Unknown error")
      private$bump()
      invisible()
    },

    # A failed cell removes only its queued same-run descendants; their
    # prior idle/stale/error state and old outputs stay intact.
    drop_same_run_descendants = function(id, run_id) {
      if (is.null(run_id) || !length(private$queue)) return(invisible())
      desc <- self$descendants(id)
      keep <- vapply(private$queue, function(j)
        !(identical(j$run_id, run_id) && j$id %in% desc), FALSE)
      if (!all(keep)) private$queue <- private$queue[keep]
      invisible()
    },

    normalize_log = function(log) {
      if (is.null(log)) return(character())
      as.character(unlist(log, use.names = FALSE))
    },

    # Release any .png/.html artifact carried by a previous output record.
    release_output_artifacts = function(output) {
      if (is.null(output) || is.null(private$worker)) return(invisible())
      if (output$kind %in% c("image", "html") && !is.null(output$artifact)) {
        tryCatch(private$worker$release_artifact(output$artifact),
                 error = function(e) NULL)
      }
      invisible()
    },

    note_action_error = function(token, code, message) {
      private$last_action_error <- list(token = token, code = code,
                                        message = message)
      invisible()
    },

    # --- worker failure ------------------------------------------------

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
      private$worker_failed <- TRUE
      if (!is.null(current_id)) {
        rec <- private$cell_state[[current_id]]
        if (!is.null(rec)) {
          rec$status <- "error"
          rec$output <- NULL
          rec$log <- c(rec$log, paste("Error:", message))
          private$cell_state[[current_id]] <- rec
        }
      }
      private$current <- NULL
      private$queue <- list()
      private$note_action_error(NULL, "worker_unavailable", message)
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

    # --- widget internals ----------------------------------------------

    widget_owner = function(name) {
      for (id in private$dag_nodes()) {
        rec <- private$cell_state[[id]]
        if (!is.null(rec$output) && identical(rec$output$kind, "widget") &&
            identical(rec$output$name %||% NULL, name)) {
          return(id)
        }
      }
      NULL
    },

    widget_send_value = function(kind, value) {
      if (kind %in% c("slider", "number")) return(as.double(value))
      if (identical(kind, "text_input")) return(as.character(value))
      value
    },

    validate_widget_update = function(kind, update) {
      if (!is.list(update)) {
        alder_abort("invalid_request", "widget update must be an object")
      }
      if (identical(kind, "dropdown")) {
        idx <- update$index
        if (!is.numeric(idx) || length(idx) != 1L || is.na(idx) ||
            as.integer(idx) < 1L || as.integer(idx) > 100000L) {
          alder_abort("invalid_request",
                      "dropdown index must be a positive integer")
        }
        return(list(index = as.integer(idx)))
      }
      val <- update$value
      if (kind %in% c("slider", "number")) {
        if (!is.numeric(val) || length(val) != 1L || is.na(val) ||
            !is.finite(val)) {
          alder_abort("invalid_request", "numeric widget value required")
        }
        return(list(value = val))
      }
      if (identical(kind, "text_input")) {
        if (!is.character(val) || length(val) != 1L || is.na(val)) {
          alder_abort("invalid_request", "text widget value required")
        }
        return(list(value = val))
      }
      if (kind %in% c("checkbox", "run_button")) {
        if (!is.logical(val) || length(val) != 1L || is.na(val)) {
          alder_abort("invalid_request", "logical widget value required")
        }
        return(list(value = val))
      }
      alder_abort("invalid_request", "unknown widget kind")
    },

    # Validate the worker's `selected` reply against the widget kind; a
    # mismatch is a transport failure (invalid worker response).
    decode_widget_selected = function(kind, resp) {
      sel <- resp$selected
      if (!is.list(sel)) return(list(ok = FALSE))
      typ <- sel$type
      val <- sel$value
      if (!typ %in% c("logical", "integer", "double", "character")) {
        return(list(ok = FALSE))
      }
      if (typ == "logical") {
        if (!is.logical(val) || length(val) != 1L) return(list(ok = FALSE))
        v <- val
      } else if (typ == "integer") {
        if (!is.numeric(val) || length(val) != 1L) return(list(ok = FALSE))
        v <- as.integer(val)
      } else if (typ == "double") {
        if (!is.numeric(val) || length(val) != 1L) return(list(ok = FALSE))
        v <- as.double(val)
      } else {
        if (!is.character(val) || length(val) != 1L) return(list(ok = FALSE))
        v <- val
      }
      idx <- NULL
      if (identical(kind, "dropdown")) {
        idx <- sel$index
        if (is.null(idx) || !is.numeric(idx) || length(idx) != 1L ||
            is.na(idx) || as.integer(idx) < 1L) return(list(ok = FALSE))
        idx <- as.integer(idx)
      } else if (!is.null(sel$index)) {
        return(list(ok = FALSE))
      }
      list(ok = TRUE, value = v, index = idx)
    },

    # A widget response commits only while its control identity is still
    # live (pending); a cancelled/failed op or an edited owner never
    # commits late output.
    on_widget_response = function(name, owner, tok, kind, resp, source) {
      rec <- private$cell_state[[owner]]
      if (is.null(rec)) return(invisible())
      out <- rec$output
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        private$widget_op_error(owner, tok, "worker_unavailable",
                                "Worker exited before responding")
        return(invisible())
      }
      op <- out$operation %||% NULL
      if (is.null(out) || !identical(out$name %||% NULL, name) ||
          is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) {
        return(invisible())
      }
      d <- private$decode_widget_selected(kind, resp)
      if (!isTRUE(d$ok)) {
        if (self$worker_available()) {
          private$worker$transport_error("invalid worker response")
        }
        return(invisible())
      }
      if (!isTRUE(resp$ok)) {
        private$widget_op_error(owner, tok, "widget_update_failed",
                                resp$error$message %||% "widget update failed")
        return(invisible())
      }
      if (identical(kind, "dropdown")) {
        out$spec$value <- d$value
        out$spec$index <- d$index
      } else {
        out$spec$value <- d$value
      }
      out$commit_token <- tok
      out$operation <- list(token = tok, status = "done", error = NULL)
      rec$output <- out
      private$cell_state[[owner]] <- rec
      private$last_action_error <- NULL
      private$bump()
      if (identical(kind, "run_button")) {
        private$schedule_run_button(name, owner, source, tok)
      } else {
        private$schedule_widget_consumers(name, source)
      }
      invisible()
    },

    widget_op_error = function(owner, tok, code, message) {
      rec <- private$cell_state[[owner]]
      if (!is.null(rec) && !is.null(rec$output)) {
        rec$output$operation <- list(token = tok, status = "error",
                                     error = list(code = code, message = message))
        private$cell_state[[owner]] <- rec
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
    # cancelled, or disappear. Reset immediately when it has no consumers.
    schedule_run_button = function(name, owner, source, tok) {
      refs <- private$cells_referencing(name, owner)
      if (!length(refs)) {
        private$send_button_reset(name)
        private$bump()
        return(invisible())
      }
      if (identical(source, "app") || identical(private$execution_mode, "automatic")) {
        region <- unique(c(refs, unlist(lapply(refs, function(r)
          self$descendants(r)), use.names = FALSE)))
        private$cancel_run_region(region, "widget")
        plan <- private$widget_closure(refs, owner)
        rid <- private$launch_run(plan)
        private$button_resets[[name]] <- list(run_id = rid, direct = refs)
      } else {
        # lazy editor mode: mark direct consumers stale; reset only after
        # each has participated in a later explicit run
        for (r in refs) {
          private$mark_stale(r)
          for (d in self$descendants(r)) private$mark_stale(d)
        }
        private$button_resets[[name]] <- list(run_id = NULL, direct = refs)
      }
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

    # --- button resets -------------------------------------------------

    send_button_reset = function(name) {
      owner <- private$widget_owner(name)
      if (is.null(owner)) return(invisible())
      if (!self$worker_available()) return(invisible())
      rec <- private$cell_state[[owner]]
      tok <- private$op_counter + 1L
      private$op_counter <- tok
      if (!is.null(rec) && !is.null(rec$output)) {
        rec$output$operation <- list(token = tok, status = "pending",
                                     error = NULL)
        private$cell_state[[owner]] <- rec
      }
      private$worker$send("set_widget", name = name, value = FALSE,
                          op_id = as.integer(tok),
                          on_response = function(context, resp)
                            private$on_button_reset_response(name, owner, tok,
                                                             resp))
      invisible()
    },

    on_button_reset_response = function(name, owner, tok, resp) {
      rec <- private$cell_state[[owner]]
      if (is.null(rec)) return(invisible())
      out <- rec$output
      if (isTRUE(private$worker_failed) || isTRUE(resp$error$transport)) {
        private$widget_op_error(owner, tok, "worker_unavailable",
                                "Worker exited before responding")
        return(invisible())
      }
      op <- out$operation %||% NULL
      if (is.null(out) || !identical(out$name %||% NULL, name) ||
          is.null(op) || !identical(op$token, tok) ||
          !identical(op$status, "pending")) {
        return(invisible())
      }
      d <- private$decode_widget_selected("run_button", resp)
      if (!isTRUE(d$ok)) {
        if (self$worker_available()) private$worker$transport_error("invalid worker response")
        return(invisible())
      }
      if (!isTRUE(resp$ok)) {
        private$widget_op_error(owner, tok, "widget_update_failed",
                                resp$error$message %||% "button reset failed")
        return(invisible())
      }
      out$spec$value <- FALSE
      out$commit_token <- tok
      out$operation <- list(token = tok, status = "done", error = NULL)
      rec$output <- out
      private$cell_state[[owner]] <- rec
      private$last_action_error <- NULL
      private$bump()
      invisible()
    },

    check_pending_button_resets = function() {
      if (!length(private$button_resets)) return(invisible())
      for (nm in names(private$button_resets)) {
        info <- private$button_resets[[nm]]
        if (is.null(info$run_id)) {
          # lazy mode: reset only after every direct consumer has
          # participated in a later explicit run (done or errored)
          remaining <- info$direct[vapply(info$direct, function(r)
            !private$status_of(r) %in% c("done", "error"), FALSE)]
          if (!length(remaining)) {
            private$send_button_reset(nm)
            private$button_resets[[nm]] <- NULL
          }
          next
        }
        if (!private$run_has_pending_jobs(info$run_id)) {
          private$send_button_reset(nm)
          private$button_resets[[nm]] <- NULL
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
      for (nm in names(private$button_resets)) {
        info <- private$button_resets[[nm]]
        still <- private$cells_referencing(nm, private$widget_owner(nm))
        if (!length(still)) {
          private$send_button_reset(nm)
          private$button_resets[[nm]] <- NULL
        } else {
          info$direct <- still
          private$button_resets[[nm]] <- info
        }
      }
      invisible()
    },

    # --- value inspection ----------------------------------------------

    on_value_response = function(name, tok, resp) {
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
        private$last_value <- list(token = tok, name = name, value = v)
        private$value_operation <- list(token = tok, name = name,
                                        status = "done", error = NULL)
        private$last_action_error <- NULL
      } else {
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

    # --- maintenance clear + barrier invalidation ----------------------

    # clear_cell runs before any later eval of the same cell so a removed
    # definition cannot survive only because the new DAG lost its old edge.
    enqueue_clear_cell = function(id) {
      if (!is.null(private$worker) && self$worker_available()) {
        private$worker$send("clear_cell", id = id)
      }
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
