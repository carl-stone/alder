# Session: one notebook's live state — notebook, DAG, per-cell run status,
# and the rerun model (ADR 0002: manual run with stale marking).
#
# Lifecycle per cell: idle (never run) -> running -> done | error.
# Editing a cell (or changing a widget it reads) marks it and every
# transitive dependent stale. Nothing re-runs until an explicit Run; a Run
# executes the target cell and its stale descendants in dependency order.
#
# Every cell carries a monotonic `revision` (bumped on each edit) and every
# explicit run gets one monotonic `run_id`; jobs carry `{id, code,
# revision, run_id}`. A response commits only when its job is still the
# current one on all three identities plus the echoed request id, so stale
# responses can never clobber newer state.

Session <- R6::R6Class(
  "alder_session",
  public = list(
    notebook = NULL,
    dag = NULL,            # from build_dag
    topo = NULL,           # topological order of ids
    status = NULL,         # named chr: "idle"|"running"|"done"|"stale"|"error"
    output = NULL,         # named list: cell id -> rendered value (JSON-ish)
    log = NULL,            # named list: cell id -> chr messages/warnings
    worker = NULL,
    defrefs = NULL,        # named list: cell id -> list(defs, refs, self_refs)
    widgets = NULL,        # named list: cell id -> list of widget specs
    queue = NULL,          # pending cell executions (jobs, never sent)
    busy = NULL,           # a job request is in flight
    current = NULL,        # list(job, req, cancel_mode) of the running job
    changed = FALSE,       # any pending notebook edit not yet serialized
    last_value = NULL,     # most recent /api/value worker response
    revisions = NULL,      # named int: cell id -> edit revision (monotonic)
    run_counter = NULL,    # monotonic explicit-run counter (run ids)
    worker_failed = NULL,  # the worker died mid-job; nothing more can run

    initialize = function(notebook, worker) {
      self$notebook <- notebook
      self$worker <- worker
      self$queue <- list()
      self$busy <- FALSE
      self$run_counter <- 0L
      self$worker_failed <- FALSE
      self$revisions <- list()
      self$recompute_dag()
    },

    # Re-analyse every code cell and rebuild the DAG.
    recompute_dag = function() {
      cells <- self$notebook$cells
      defrefs <- list()
      for (c in cells) {
        p <- if (c$type == "code") cell_defs_refs(c$body)
             else list(defs = character(), refs = character(),
                       self_refs = character(), error = NULL)
        defrefs[[c$id]] <- p
      }
      self$defrefs <- defrefs
      dagcells <- lapply(cells, function(c) {
        list(id = c$id, defs = defrefs[[c$id]]$defs %||% character(),
             refs = defrefs[[c$id]]$refs %||% character(),
             self_refs = defrefs[[c$id]]$self_refs %||% character())
      })
      self$dag <- build_dag(dagcells)
      self$topo <- topo_order(self$dag$edges, self$dag$nodes)
      # Seed status for new cells; preserve existing status for unchanged ids.
      ids <- self$dag$nodes
      for (id in ids) if (is.null(self$status[[id]])) {
        self$status[[id]] <- "idle"
        self$output[[id]] <- NULL
        self$log[[id]] <- character()
        self$widgets[[id]] <- list()
        self$revisions[[id]] <- 0L
      }
      invisible(self)
    },

    # ---- editing ----------------------------------------------------------
    set_cell_body = function(id, body) {
      old_desc <- self$descendants(id)
      self$notebook <- nb_set_cell_body(self$notebook, id, body)
      self$changed <- TRUE
      self$revisions[[id]] <- (self$revisions[[id]] %||% 0L) + 1L
      self$recompute_dag()
      new_desc <- self$descendants(id)
      affected <- unique(c(id, old_desc, new_desc))
      self$cancel_transition(affected)
      # The edited cell and every old/new descendant are stale from now on.
      for (a in affected) self$mark_stale(a)
      invisible(self)
    },

    add_cell = function(body = character(), type = "code", after = NULL) {
      self$notebook <- nb_add_cell(self$notebook, body, type, after)
      self$changed <- TRUE
      self$recompute_dag()   # seeds revision 0 + idle status for the new id
      invisible(self)
    },

    delete_cell = function(id) {
      old_desc <- self$descendants(id)
      self$cancel_transition(unique(c(id, old_desc)))
      # Remove the cell's records before re-analyzing.
      self$status[[id]] <- NULL
      self$output[[id]] <- NULL
      self$log[[id]] <- NULL
      self$widgets[[id]] <- NULL
      self$revisions[[id]] <- NULL
      self$notebook <- nb_delete_cell(self$notebook, id)
      self$changed <- TRUE
      self$recompute_dag()
      # Tell the worker the cell's values/ownership are gone (queued before
      # any later evaluation request).
      if (self$worker$alive()) self$worker$send("clear_cell", id = id)
      for (d in old_desc) {
        if (!is.null(self$status[[d]])) self$mark_stale(d)
      }
      invisible(self)
    },

    # The one cancellation transition (edit and delete share it). Affected
    # ids come from the union of the old/new DAG regions.
    cancel_transition = function(affected) {
      cur <- self$current
      if (!is.null(cur)) {
        if (cur$job$id %in% affected) {
          # The running cell was edited/deleted: cancel this whole explicit
          # run. Its callback may only clear busy/current and pump other
          # runs; the cell is marked stale now.
          self$current$cancel_mode <- "edit"
          cur_run <- cur$job$run_id
          keep <- vapply(self$queue, function(j) !identical(j$run_id, cur_run), FALSE)
          if (!all(keep)) self$queue <- self$queue[keep]
          if (self$worker$alive()) self$worker$interrupt()
        }
      }
      # Queued jobs of affected cells from any other run are obsolete.
      keep <- vapply(self$queue, function(j) !(j$id %in% affected), FALSE)
      if (!all(keep)) self$queue <- self$queue[keep]
      invisible()
    },

    # Mark executed affected cells stale. Never clears prior output, log, or
    # widget specs; never-run idle cells stay idle.
    mark_stale = function(id) {
      st <- self$status[[id]]
      if (is.null(st)) return(invisible())
      canceled_running <- identical(st, "running") &&
        !is.null(self$current) && identical(self$current$job$id, id) &&
        identical(self$current$cancel_mode, "edit")
      if (st %in% c("done", "error") || canceled_running) {
        self$status[[id]] <- "stale"
      }
      invisible()
    },

    descendants = function(id) {
      # Transitive dependents via reverse edges of the DAG.
      out <- character()
      stack <- id
      seen <- character()
      while (length(stack)) {
        cur <- stack[[1L]]; stack <- stack[-1L]
        if (cur %in% seen) next
        seen <- c(seen, cur)
        deps_of <- names(self$dag$edges)[vapply(self$dag$edges,
          function(deps) cur %in% deps, FALSE)]
        new_ <- setdiff(deps_of, seen)
        out <- c(out, new_)
        stack <- c(stack, new_)
      }
      out
    },

    # ---- running ----------------------------------------------------------
    # Transport failure: the worker is gone, nothing can run anymore. The
    # exact active job (if any) becomes a terminal error unless an edit
    # already canceled it; the full queue is dropped because no worker
    # remains; no pump follows.
    fail_worker_transport = function(current_id = NULL) {
      self$worker_failed <- TRUE
      if (!is.null(current_id)) {
        cur <- self$current
        st <- self$status[[current_id]]
        if (!is.null(st) && (is.null(cur) || !identical(cur$cancel_mode, "edit"))) {
          self$status[[current_id]] <- "error"
          self$output[[current_id]] <- NULL
          self$log[[current_id]] <- c(self$log[[current_id]] %||% character(),
                                      "Error: Worker exited before responding")
        }
      }
      self$busy <- FALSE
      self$current <- NULL
      self$queue <- list()
      invisible()
    },

    ensure_worker = function() {
      if (!self$worker_available()) stop("worker is not running")
      invisible()
    },

    run_cell = function(id) {
      self$ensure_worker()
      rid <- self$run_counter + 1L
      self$run_counter <- rid
      targets <- self$run_targets(id)
      self$enqueue_targets(targets, rid)
      self$pump()
      invisible(self)
    },

    run_all = function() {
      self$ensure_worker()
      rid <- self$run_counter + 1L
      self$run_counter <- rid
      targets <- if (is.null(self$topo)) character() else self$topo
      self$enqueue_targets(targets, rid)
      self$pump()
      invisible(self)
    },

    # Run only cells currently marked stale, in dependency order. An
    # explicit helper: never invoked implicitly (widget changes mark stale
    # and wait for the user).
    run_stale = function() {
      self$ensure_worker()
      if (is.null(self$topo)) return(invisible(self))
      rid <- self$run_counter + 1L
      self$run_counter <- rid
      targets <- self$topo[self$status[self$topo] == "stale"]
      self$enqueue_targets(targets, rid)
      self$pump()
      invisible(self)
    },

    # Always includes the explicit target; stale descendants follow it in
    # dependency order. Done descendants never rerun.
    run_targets = function(id) {
      if (is.null(self$topo)) return(id)
      stale <- self$topo[self$status[self$topo] == "stale"]
      dep_stale <- intersect(self$descendants(id), stale)
      unique(c(id, self$topo[self$topo %in% dep_stale]))
    },

    enqueue_targets = function(targets, run_id) {
      for (t in targets) {
        if (self$cell_type(t) == "markdown") {
          # Markdown cells carry no code: mark instantly, never execute.
          self$status[[t]] <- "done"
          self$output[[t]] <- NULL
          next
        }
        idx <- self$cell_idx(t)
        self$queue <- c(self$queue, list(list(
          id = t,
          code = paste(self$notebook$cells[[idx]]$body, collapse = "\n"),
          revision = self$revisions[[t]] %||% 0L,
          run_id = run_id
        )))
      }
      invisible()
    },

    cell_idx = function(id) {
      idx <- which(vapply(self$notebook$cells, function(c) identical(c$id, id), FALSE))
      if (!length(idx)) stop("no such cell: ", id) else idx[[1L]]
    },

    cell_type = function(id) {
      self$notebook$cells[[self$cell_idx(id)]]$type
    },

    pump = function() {
      if (self$busy) return(invisible())
      while (length(self$queue)) {
        job <- self$queue[[1L]]
        self$queue <- self$queue[-1L]
        if (!self$worker$alive()) {
          # Worker died between enqueue and dispatch: the job cannot run.
          self$fail_worker_transport()
          return(invisible())
        }
        self$busy <- TRUE
        self$current <- list(job = job, req = NA_integer_, cancel_mode = NULL)
        self$status[[job$id]] <- "running"
        req <- self$worker$send("eval_cell",
          id = job$id, code = job$code,
          revision = job$revision, run_id = job$run_id,
          on_response = function(context, resp) self$on_cell_result(job, resp))
        self$current$req <- req
        return(invisible())  # resume in on_cell_result
      }
      invisible()
    },

    # The response for the exact current job. A commit happens only when the
    # job still matches the non-canceled current on {id, revision, run_id}
    # and the echoed request identity.
    on_cell_result = function(job, resp) {
      cur <- self$current
      if (is.null(cur)) return(invisible())  # already cleared: stale response
      if (!identical(job$id, cur$job$id) ||
          !identical(job$revision, cur$job$revision) ||
          !identical(job$run_id, cur$job$run_id)) {
        return(invisible())  # responsibility of a later response
      }
      id <- job$id

      if (isTRUE(resp$error$transport)) {
        # The exact active job lost its worker: nothing can run anymore.
        self$fail_worker_transport(id)
        return(invisible())
      }
      # Response identity: the request id echoed by the worker must be the
      # one we sent.
      if (!identical(resp$req, cur$req)) return(invisible())

      if (identical(cur$cancel_mode, "edit")) {
        # An edit/delete canceled this whole run. The cell is already stale;
        # the response only clears the slot and continues other runs.
        self$busy <- FALSE
        self$current <- NULL
        self$pump()
        return(invisible())
      }

      if (identical(cur$cancel_mode, "stop")) {
        # User stop: the interrupted response is the terminal error.
        self$status[[id]] <- "error"
        self$output[[id]] <- NULL
        self$log[[id]] <- c(self$log[[id]] %||% character(), "Error: Interrupted")
        self$fail_same_run_descendants(id)
        self$busy <- FALSE
        self$current <- NULL
        self$pump()
        return(invisible())
      }

      if (isTRUE(resp$ok)) {
        self$status[[id]] <- "done"
        self$output[[id]] <- resp$value
        self$widgets[[id]] <- resp$widgets %||% list()
        # keep log array-shaped even for a single line (jsonlite unboxes it)
        lg <- resp$log %||% character()
        if (is.character(lg) && length(lg) == 1L) lg <- list(lg)
        self$log[[id]] <- lg
      } else {
        self$status[[id]] <- "error"
        self$output[[id]] <- NULL
        errmsg <- if (!is.null(resp$error)) resp$error$message else "Unknown error"
        self$log[[id]] <- c(self$log[[id]] %||% character(), paste("Error:", errmsg))
        # A failed cell takes its queued descendants in the same run down.
        self$fail_same_run_descendants(id)
      }
      self$busy <- FALSE
      self$current <- NULL
      self$pump()
      invisible()
    },

    # Remove queued jobs of this run whose cells depend on the failed one.
    fail_same_run_descendants = function(id) {
      run_id <- self$run_id_of(id)
      if (length(run_id)) {
        desc <- self$descendants(id)
        keep <- vapply(self$queue, function(j)
          !(identical(j$run_id, run_id) && j$id %in% desc), FALSE)
        if (!all(keep)) self$queue <- self$queue[keep]
      }
      invisible()
    },

    run_id_of = function(id) {
      cur <- self$current
      if (!is.null(cur) && identical(cur$job$id, id)) cur$job$run_id
      else NULL
    },

    # Worker is usable only while alive and not failed.
    worker_available = function() {
      !self$worker_failed && !is.null(self$worker) && self$worker$alive()
    },

    interrupt = function() {
      cur <- self$current
      if (!is.null(cur) && self$worker_available()) {
        self$current$cancel_mode <- "stop"
        keep <- vapply(self$queue, function(j)
          !identical(j$run_id, cur$job$run_id), FALSE)
        if (!all(keep)) self$queue <- self$queue[keep]
        self$worker$interrupt()
      }
      invisible()
    },

    # Request a structured description of a notebook value (agent interface);
    # the result lands in last_value when the worker replies.
    request_value = function(name) {
      self$ensure_worker()
      self$last_value <- NULL
      self$worker$send("get_value", name = name,
        on_response = function(context, r) self$last_value <- r)
      invisible(self)
    },

    # ---- widget controls ---------------------------------------------------
    set_widget = function(name, value) {
      self$ensure_worker()
      self$worker$send("set_widget", name = name, value = value,
        on_response = function(context, resp) {
          if (isTRUE(resp$ok)) {
            # The proxy in the worker owns the value (ADR 0003); mirror the
            # committed value into any stored spec so state reflects what
            # the UI control shows.
            for (cid in names(self$widgets)) {
              ws <- self$widgets[[cid]]
              for (i in seq_along(ws)) {
                if (identical(ws[[i]]$name, name) && is.list(ws[[i]]$spec)) {
                  ws[[i]]$spec$.value <- resp$value
                }
              }
              self$widgets[[cid]] <- ws
            }
            # Widget changes mark executed dependents stale; they do not run.
            # A changed control invalidates every executed cell that reads it
            # AND its transitive descendants (heavy consumers re-derive from
            # the changed value through intermediate cells).
            for (cid in self$dag$nodes) {
              if (name %in% self$defrefs[[cid]]$refs) {
                self$mark_stale(cid)
                for (d in self$descendants(cid)) self$mark_stale(d)
              }
            }
          }
        })
      invisible(self)
    },

    # ---- introspection -------------------------------------------------------
    state = function() {
      cells <- lapply(self$notebook$cells, function(c) {
        list(
          id = c$id, type = c$type, delim = c$delim,
          # I() keeps list-shaped fields arrays under jsonlite auto_unbox,
          # so a client never sees a scalar where an array is expected.
          body = I(c$body), options = c$options,
          status = self$status[[c$id]] %||% "idle",
          output = self$output[[c$id]],
          widgets = self$widgets[[c$id]] %||% list(),
          log = I(self$log[[c$id]] %||% character())
        )
      })
      list(
        path = self$notebook$path,
        metadata = self$notebook$metadata,
        cells = cells,
        dag = list(nodes = I(self$dag$nodes),
                   edges = lapply(self$dag$edges, I),
                   duplicates = self$dag$duplicates,
                   cycles = self$dag$cycles),
        topo = if (is.null(self$topo)) NULL else I(self$topo),
        changed = self$changed,
        last_value = self$last_value
      )
    }
  )
)

`%||%` <- function(a, b) if (is.null(a)) b else a