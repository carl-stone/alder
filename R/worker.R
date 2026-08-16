# Server-side control of the per-notebook R worker (ADR 0004).
#
# We spawn one Rscript per notebook and drive it over stdin/stdout JSON.
# Responses are matched to requests by a monotonically increasing `req` id and
# dispatched on the httpuv/later event loop (non-blocking poll), so a long cell
# never freezes the editor. Interrupt sends SIGINT to the worker process.
#
# Every pending request stores its callback plus the outgoing identity
# {cmd, id, revision, run_id}; callbacks receive (context, response). When
# the process dies, every pending callback is invoked exactly once with a
# synthetic transport error so the session can fail closed deterministically.

# Resolve the widget proxy module path (ADR 0003) from the host side.
# Works under install, pkgload, and plain-source layouts; the worker cannot
# rely on its own cwd (testing harnesses move it).
alder_ui_module <- function() {
  cand <- c(
    system.file("worker", "ui-widgets.R", package = "alder"),
    file.path(getwd(), "inst", "worker", "ui-widgets.R"),
    file.path(getwd(), "R", "ui-widgets.R")
  )
  for (p in cand) if (nzchar(p) && file.exists(p)) return(p)
  stop("alder widget module (ui-widgets.R) not found")
}

# Spawn the worker with a validated artifact directory on the host side.
# The worker re-validates and fails closed when the directory is absent or
# invalid (it owns every rendered artifact under it).
.spawn_worker <- function(worker_script, app_dir, artifact_dir) {
  if (length(artifact_dir) != 1L || is.na(artifact_dir) || !nzchar(artifact_dir)) {
    stop("artifact directory must be a single non-NA path")
  }
  if (!dir.exists(artifact_dir)) {
    stop("artifact directory does not exist: ", artifact_dir)
  }
  if (file.access(artifact_dir, 2) != 0L) {
    stop("artifact directory is not writable: ", artifact_dir)
  }
  if (!file.exists(worker_script)) {
    stop("worker script not found: ", worker_script)
  }
  env <- Sys.getenv()
  env <- c(ALDER_APP_DIR = app_dir,
           ALDER_ARTIFACT_DIR = artifact_dir,
           ALDER_UI_WIDGETS = alder_ui_module(),
           env)
  env <- env[!duplicated(names(env))]
  proc <- processx::process$new(
    file.path(R.home("bin"), "Rscript"),
    args = c("--vanilla", worker_script),
    env = env,
    stdin = "|",
    stdout = "|", stderr = "|", supervise = TRUE
  )
  Worker$new(proc)
}

# A Worker is a small stateful controller for one worker process.
Worker <- R6::R6Class(
  "alder_worker",
  public = list(
    proc = NULL,
    pending = NULL,     # named env: req id -> list(callback, context)
    counter = NULL,     # next req id
    poll_active = NULL,
    executing = NULL,   # the worker acked an eval; safe to SIGINT

    initialize = function(proc) {
      self$proc <- proc
      self$pending <- new.env(parent = emptyenv())
      self$counter <- 1L
      self$poll_active <- FALSE
      self$executing <- FALSE
    },

    # Send a command; call `on_response(context, response)` with the parsed
    # response. Identity context {cmd, id, revision, run_id} is captured
    # from the outgoing message. If the process is already dead, the
    # callback fires once, synchronously, with a synthetic transport error.
    send = function(cmd, ..., on_response = NULL) {
      dots <- list(...)
      req <- self$counter
      self$counter <- self$counter + 1L
      ctx <- list(cmd = cmd, id = dots$id %||% NULL,
                  revision = dots$revision %||% NULL,
                  run_id = dots$run_id %||% NULL)
      if (!self$proc$is_alive()) {
        if (!is.null(on_response)) {
          on_response(ctx, list(req = req, ok = FALSE,
                                error = list(message = "Worker exited before responding",
                                             transport = TRUE)))
        }
        return(req)
      }
      message <- list(req = req)
      message[names(dots)] <- dots
      message$cmd <- cmd
      if (!is.null(on_response)) {
        self$pending[[as.character(req)]] <- list(callback = on_response, context = ctx)
      }
      self$proc$write_input(jsonlite::toJSON(message, auto_unbox = TRUE, null = "null"))
      self$proc$write_input("\n")
      self$ensure_polling()
      req
    },

    ensure_polling = function() {
      if (self$poll_active) return(invisible())
      self$poll_active <- TRUE
      self$poll_cycle()
    },

    poll_cycle = function() {
      if (!self$poll_active) return(invisible())
      proc <- self$proc
      if (!proc$is_alive()) {
        self$poll_active <- FALSE
        if (length(ls(self$pending, all.names = TRUE))) self$fail_pending()
        return(invisible())
      }
      out <- proc$get_output_connection()
      err <- proc$get_error_connection()
      resp <- processx::poll(list(out, err), 0)
      if (resp[[1L]] %in% c("ready", "silent")) {
        lines <- tryCatch(proc$read_output_lines(100), error = function(e) character())
        for (ln in lines) if (nzchar(ln)) self$handle_line(ln)
      }
      if (resp[[2L]] %in% c("ready", "silent")) {
        el <- tryCatch(proc$read_error_lines(100), error = function(e) character())
        for (ln in el) if (nzchar(ln)) message("[worker stderr] ", ln)
      }
      if (length_pending(self$pending) || proc$is_alive()) {
        later::later(self$poll_cycle, 0.02)
      } else {
        self$poll_active <- FALSE
      }
      invisible()
    },

    handle_line = function(line) {
      resp <- tryCatch(jsonlite::fromJSON(line, simplifyVector = FALSE),
                       error = function(e) NULL)
      if (is.null(resp)) return(invisible())
      rid <- as.character(resp$req %||% NULL)
      entry <- NULL
      if (!is.null(resp$ack)) {
        # The worker has begun evaluating the request: the only SIGINT-safe
        # window is now (a signal on the blocking read would kill it).
        if (length(rid) && nzchar(rid) && !is.null(self$pending[[rid]])) {
          self$executing <- TRUE
        }
        return(invisible())
      }
      if (length(rid)) {
        entry <- self$pending[[rid]]
        if (!is.null(entry)) rm(list = rid, envir = self$pending)
      }
      self$executing <- FALSE
      if (!is.null(entry)) {
        tryCatch(
          entry$callback(entry$context, resp),
          error = function(e) message("worker callback error: ", conditionMessage(e))
        )
      }
      invisible()
    },

    # Fail every pending request once: snapshot and remove the entries, then
    # invoke each callback with its identity and a synthetic transport error.
    fail_pending = function(message = "Worker exited before responding") {
      ids <- ls(self$pending, all.names = TRUE)
      self$executing <- FALSE
      if (!length(ids)) return(invisible())
      entries <- lapply(ids, function(rid) {
        e <- self$pending[[rid]]
        rm(list = rid, envir = self$pending)
        e
      })
      for (i in seq_along(entries)) {
        rid <- ids[[i]]
        e <- entries[[i]]
        if (is.null(e)) next
        tryCatch(
          e$callback(e$context, list(req = as.integer(rid), ok = FALSE,
                                     error = list(message = message, transport = TRUE))),
          error = function(err) message("worker callback error: ", conditionMessage(err))
        )
      }
      invisible()
    },

    # SIGINT only while the worker is known to be evaluating (ack received)
    # or after its response already arrived. A signal during the worker's
    # blocking stdin read would terminate a non-interactive Rscript.
    interrupt = function() {
      if (!self$proc$is_alive()) return(invisible())
      if (self$executing) {
        self$proc$interrupt()
      } else {
        self$retry_interrupt()
      }
      invisible()
    },

    retry_interrupt = function() {
      if (!self$proc$is_alive()) return(invisible())
      if (self$executing) {
        self$proc$interrupt()
        return(invisible())
      }
      if (!length(ls(self$pending, all.names = TRUE))) return(invisible())
      later::later(self$retry_interrupt, 0.005)
    },

    stop = function(grace = 0.2) {
      tryCatch(self$send("shutdown"), error = function(e) NULL)
      if (grace > 0) later::later(function() self$kill(), grace)
    },

    kill = function() {
      tryCatch(self$proc$kill(), error = function(e) NULL)
      invisible()
    },

    alive = function() self$proc$is_alive()
  )
)

length_pending <- function(env) length(ls(env, all.names = TRUE))

# Minimal `%||%` without importing rlang across the package.
`%||%` <- function(a, b) if (is.null(a)) b else a