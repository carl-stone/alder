# Server-side control of the per-notebook R worker (ADR 0004).
#
# We spawn one Rscript per notebook and drive it over stdin/stdout JSON.
# Responses are matched to requests by a monotonically increasing `req` id and
# dispatched on the httpuv/later event loop (non-blocking poll), so a long cell
# never freezes the editor. Interrupt sends SIGINT to the worker exactly once,
# and only after that request's start acknowledgement (ack-gated), never while
# the worker is blocked on an idle stdin read (ADR 0004).
#
# Every pending request stores its callback plus the full outgoing identity
# {cmd, req, id, revision, run_id, name, op_id, token}; a response is accepted
# only when every present identity field matches exactly. Malformed JSON, a
# response with no pending request, or a mismatched identity is a terminal
# transport failure: we kill the worker, fail every remaining pending request,
# and invoke the one `on_failure` callback exactly once.

# Resolve the mirrored widget module only from the installed package
# (ADR 0007 / Plan §7): no cwd probing, no direct-source fallback.
alder_ui_module <- function() {
  system.file("worker", "ui-widgets.R", package = "alder", mustWork = TRUE)
}

# Spawn the worker process with validated artifact and cache directories.
.spawn_worker_process <- function(worker_script, app_dir, artifact_dir,
                                  cache_dir = artifact_dir, env = character()) {
  if (length(artifact_dir) != 1L || is.na(artifact_dir) ||
      !nzchar(artifact_dir)) {
    stop("artifact directory must be a single non-NA path")
  }
  if (!dir.exists(artifact_dir)) {
    stop("artifact directory does not exist: ", artifact_dir)
  }
  if (file.access(artifact_dir, 2) != 0L) {
    stop("artifact directory is not writable: ", artifact_dir)
  }
  if (length(cache_dir) != 1L || is.na(cache_dir) || !nzchar(cache_dir)) {
    stop("cache directory must be a single non-NA path")
  }
  if (!dir.exists(cache_dir)) {
    stop("cache directory does not exist: ", cache_dir)
  }
  if (file.access(cache_dir, 2) != 0L) {
    stop("cache directory is not writable: ", cache_dir)
  }
  if (!file.exists(worker_script)) {
    stop("worker script not found: ", worker_script)
  }
  if (!is.character(env) || (length(env) && is.null(names(env))) ||
      anyNA(names(env)) || any(!nzchar(names(env)))) {
    stop("worker environment must be a named character vector")
  }
  # NOTE: do not run as.character() on `env` here: it strips the names,
  # which are the environment variable names themselves.
  inherited <- Sys.getenv()
  env <- c(ALDER_APP_DIR = app_dir,
           ALDER_ARTIFACT_DIR = artifact_dir,
           ALDER_CACHE_DIR = cache_dir,
           ALDER_UI_WIDGETS = alder_ui_module(),
           env,
           inherited)
  env <- env[!duplicated(names(env))]
  processx::process$new(
    file.path(R.home("bin"), "Rscript"),
    args = c("--vanilla", worker_script),
    env = env,
    stdin = "|",
    stdout = "|", stderr = "|", supervise = TRUE
  )
}
.spawn_worker <- function(worker_script, app_dir, artifact_dir,
                          cache_dir = artifact_dir, env = character()) {
  proc <- .spawn_worker_process(worker_script, app_dir, artifact_dir,
                                cache_dir, env)
  Worker$new(proc, worker_script, app_dir, artifact_dir, cache_dir, env)
}


# A Worker is a small stateful controller for one notebook session.
Worker <- R6::R6Class(
  "alder_worker",
  public = list(
    proc = NULL,
    pending = NULL,     # named env: req id -> list(callback, context)
    counter = NULL,     # next req id
    poll_active = NULL,
    executing_req = NULL,   # req id whose start ack has been received
    interrupt_sent = NULL,  # req id already SIGINTed
    failed_once = NULL,     # terminal transport failure has fired
    on_failure = NULL,      # one terminal callback(message)
    on_notify = NULL,       # callback(context, notify_frame)
    worker_script = NULL,   # respawn parameters for Worker$restart()
    app_dir = NULL,
    artifact_dir = NULL,
    cache_dir = NULL,
    env = character(),
    initialize = function(proc, worker_script, app_dir, artifact_dir,
                          cache_dir = artifact_dir, env = character()) {
      self$proc <- proc
      self$pending <- new.env(parent = emptyenv())
      self$counter <- 1L
      self$poll_active <- FALSE
      self$interrupt_sent <- NULL
      self$failed_once <- NULL
      self$on_failure <- NULL
      self$on_notify <- NULL
      self$worker_script <- worker_script
      self$app_dir <- app_dir
      self$artifact_dir <- artifact_dir
      self$cache_dir <- cache_dir
      self$env <- env
    },

    # Register the single terminal transition: called at most once when the
    # worker dies or sends a protocol-invalid response.
    set_on_failure = function(callback) {
      self$on_failure <- callback
      invisible(self)
    },

    set_on_notify = function(callback) {
      self$on_notify <- callback
      invisible(self)
    },

    # Send a command; call `on_response(context, response)` with the parsed
    # response. The identity context {cmd, req, id, revision, run_id, name,
    # op_id, token} is captured from the outgoing message. If the process is
    # already dead, the callback fires once, synchronously, with a synthetic
    # transport error echoing every identity field.
    send = function(cmd, ..., on_response = NULL) {
      dots <- list(...)
      req <- self$counter
      self$counter <- self$counter + 1L
      ctx <- list(cmd = cmd, req = req,
                  id = dots$id %||% NULL,
                  revision = dots$revision %||% NULL,
                  run_id = dots$run_id %||% NULL,
                  name = dots$name %||% NULL,
                  op_id = dots$op_id %||% NULL,
                  token = dots$token %||% NULL)
      if (is.null(on_response)) on_response <- function(ctx, resp) invisible()
      if (!self$proc$is_alive()) {
        on_response(ctx, self$synthetic_error(ctx, "Worker exited before responding"))
        return(req)
      }
      message <- c(list(req = req), dots)
      message$cmd <- cmd
      # the worker answers every command; register each request so the
      # response is consumed (never an unsolicited line)
      self$pending[[as.character(req)]] <- list(
        callback = on_response, context = ctx, last_seq = 0L)
      self$proc$write_input(jsonlite::toJSON(message, auto_unbox = TRUE, null = "null"))
      self$proc$write_input("\n")
      self$ensure_polling()
      req
    },

    # A synthetic transport error echoing the request's saved identity.
    synthetic_error = function(ctx, message) {
      e <- list(req = ctx$req, ok = FALSE, cmd = ctx$cmd,
                error = list(message = message, transport = TRUE))
      for (f in c("id", "revision", "run_id", "name", "op_id", "token")) {
        if (!is.null(ctx[[f]])) e[[f]] <- ctx[[f]]
      }
      e
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
        self$transport_error("Worker exited before responding")
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
      # poll while requests are outstanding; idle polling is unnecessary
      if (length(ls(self$pending, all.names = TRUE))) {
        later::later(self$poll_cycle, 0.02)
      } else {
        self$poll_active <- FALSE
      }
      invisible()
    },

    # Parse one stdout protocol line. Any malformed or unidentifiable input
    # is a terminal failure: nothing may be silently ignored.
    handle_line = function(line) {
      resp <- tryCatch(jsonlite::fromJSON(line, simplifyVector = FALSE),
                       error = function(e) NULL)
      if (is.null(resp) || !is.list(resp)) {
        self$transport_error("invalid worker response")
        return(invisible())
      }
      if (!is.null(resp$notify)) {
        rid <- as.character(resp$req %||% NA_character_)
        entry <- if (length(rid) == 1L && !is.na(rid) && nzchar(rid)) {
          self$pending[[rid]]
        } else NULL
        kind <- as.character(resp$notify %||% "")
        seq <- resp$seq
        payload <- resp$payload
        payload_valid <- if (identical(kind, "append")) {
          is.list(payload) && is.list(payload$output) &&
            length(payload$output) > 0L
        } else if (identical(kind, "progress")) {
          is.list(payload) && is.list(payload$progress) &&
            identical(as.character(payload$progress$kind %||% ""), "progress")
        } else if (identical(kind, "log")) {
          is.list(payload) &&
            (is.character(payload$lines) || is.list(payload$lines))
        } else FALSE
        valid <- !is.null(entry) &&
          identical(entry$context$cmd, "eval_cell") &&
          identical(resp_field_equal(entry$context$id, resp$id), TRUE) &&
          identical(resp_field_equal(entry$context$run_id, resp$run_id), TRUE) &&
          length(seq) == 1L && is.numeric(seq) && !is.na(seq) &&
          is.finite(seq) && seq == floor(seq) &&
          seq > (entry$last_seq %||% 0) &&
          kind %in% c("append", "progress", "log") &&
          isTRUE(payload_valid)
        if (!isTRUE(valid)) {
          self$transport_error("invalid worker response")
          return(invisible())
        }
        entry$last_seq <- seq
        self$pending[[rid]] <- entry
        failed <- FALSE
        if (!is.null(self$on_notify)) {
          tryCatch(self$on_notify(entry$context, resp),
                   error = function(e) failed <<- TRUE,
                   interrupt = function(e) failed <<- TRUE)
        }
        if (failed) self$transport_error("invalid worker response")
        return(invisible())
      }
      if (!is.null(resp$ack)) {
        rid <- as.character(resp$req %||% NULL)
        if (identical(as.character(resp$ack), "started") &&
            length(rid) && nzchar(rid) &&
            identical(as.character(resp$cmd), "eval_cell") &&
            !is.null(self$pending[[rid]])) {
          # begin the ack-gated SIGINT window for this request
          self$executing_req <- rid
        } else {
          self$transport_error("invalid worker response")
        }
        return(invisible())
      }
      rid <- as.character(resp$req %||% NULL)
      entry <- NULL
      if (length(rid) && nzchar(rid)) entry <- self$pending[[rid]]
      if (is.null(entry) || !self$identity_matches(entry$context, resp)) {
        self$transport_error("invalid worker response")
        return(invisible())
      }
      rm(list = rid, envir = self$pending)
      self$executing_req <- NULL
      self$interrupt_sent <- NULL
      self$invoke_callback(entry$callback, entry$context, resp)
      invisible()
    },

    # Exact equality with the pending identity on every present field.
    identity_matches = function(ctx, resp) {
      if (!identical(resp$cmd %||% NULL, ctx$cmd %||% NULL)) return(FALSE)
      for (f in c("id", "revision", "run_id")) {
        if (!is.null(ctx[[f]]) && !resp_field_equal(ctx[[f]], resp[[f]])) return(FALSE)
      }
      if (!is.null(ctx$name) && !identical(resp$name %||% NULL, ctx$name)) return(FALSE)
      if (!is.null(ctx$op_id) && !identical(resp$op_id %||% NULL, ctx$op_id)) return(FALSE)
      if (!is.null(ctx$token) && !identical(resp$token %||% NULL, ctx$token)) return(FALSE)
      TRUE
    },

    invoke_callback = function(callback, context, resp) {
      tryCatch(callback(context, resp),
        error = function(e) {
          message("worker callback error: ", conditionMessage(e))
          self$transport_error("invalid worker response")
        },
        interrupt = function(e) self$transport_error("invalid worker response"))
      invisible()
    },

    # Fail every pending request once with its identity and a synthetic
    # transport error, without running the terminal transition again.
    fail_pending = function(message) {
      ids <- ls(self$pending, all.names = TRUE)
      self$executing_req <- NULL
      if (!length(ids)) return(invisible())
      entries <- lapply(ids, function(rid) {
        e <- self$pending[[rid]]
        rm(list = rid, envir = self$pending)
        e
      })
      for (i in seq_along(entries)) {
        e <- entries[[i]]
        if (is.null(e)) next
        tryCatch(
          e$callback(e$context, self$synthetic_error(e$context, message)),
          error = function(err) message("worker callback error: ", conditionMessage(err)),
          interrupt = function(err) NULL)
      }
      invisible()
    },

    # The single terminal path: kill, fail remaining callbacks, run the
    # session's on_failure transition once.
    transport_error = function(message) {
      if (isTRUE(self$failed_once)) return(invisible())
      self$failed_once <- TRUE
      self$poll_active <- FALSE
      tryCatch(self$proc$kill(), error = function(e) NULL)
      self$fail_pending(message)
      if (!is.null(self$on_failure)) {
        tryCatch(self$on_failure(message),
                 error = function(e) message("worker on_failure callback: ",
                                             conditionMessage(e)),
                 interrupt = function(e) NULL)
      }
      invisible()
    },

    # SIGINT exactly once for one acknowledged request, never retried. For a
    # request that has not acked (still in the blocking read), no signal is
    # sent; the fast result will commit or be discarded by the Session.
    interrupt = function(rid = NULL) {
      if (is.null(rid)) rid <- self$executing_req
      if (is.null(rid)) return(invisible())
      rid <- as.character(rid)
      if (!identical(rid, as.character(self$executing_req))) return(invisible())
      if (identical(rid, self$interrupt_sent)) return(invisible())
      if (self$proc$is_alive()) tryCatch(self$proc$interrupt(), error = function(e) NULL)
      self$interrupt_sent <- rid
      invisible()
    },

    # Deliberate clean restart (package-attach barrier invalidation only):
    # only valid while transport is healthy. Pending callbacks fail once so
    # the session can release its active identity without a terminal failure.
    restart = function() {
      self$poll_active <- FALSE
      # a deliberate restart is not a failure: detach the session transition
      # only during old-process teardown, then restore it on the new worker
      failure_cb <- self$on_failure
      self$on_failure <- NULL
      tryCatch(self$send("shutdown"), error = function(e) NULL)
      tryCatch(self$proc$wait(300), error = function(e) NULL)
      if (self$alive()) tryCatch(self$proc$kill(), error = function(e) NULL)
      self$fail_pending("Worker restarted")
      self$executing_req <- NULL
      self$interrupt_sent <- NULL
      self$failed_once <- NULL
      proc <- .spawn_worker_process(self$worker_script, self$app_dir,
                                    self$artifact_dir, self$cache_dir,
                                    self$env)
      self$proc <- proc
      self$pending <- new.env(parent = emptyenv())
      self$counter <- 1L
      self$poll_active <- FALSE
      self$on_failure <- failure_cb
      invisible(self)
    },

    # Unlink a contained regular rendered artifact (.png/.html) under the
    # configured artifact directory. Callers (Session output transitions)
    # pass only a basename produced by a committed worker response.
    release_artifact = function(artifact) {
      if (is.null(artifact) || length(artifact) != 1L || is.na(artifact) ||
          !nzchar(artifact)) {
        return(invisible(FALSE))
      }
      base <- basename(artifact)
      if (!grepl("\\.png$", base) && !grepl("\\.html$", base)) {
        return(invisible(FALSE))
      }
      root <- normalizePath(self$artifact_dir, mustWork = TRUE)
      p <- file.path(root, base)
      if (!startsWith(tryCatch(normalizePath(p), error = function(e) ""),
                      paste0(root, .Platform$file.sep))) {
        return(invisible(FALSE))
      }
      if (!file.exists(p) || dir.exists(p)) return(invisible(FALSE))
      unlink(p)
      invisible(TRUE)
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

# Numeric identity fields round-trip through JSON as double; compare
# numerically rather than by storage mode.
resp_field_equal <- function(a, b) {
  if (is.null(a) || is.null(b)) return(is.null(a) && is.null(b))
  if (is.numeric(a) || is.numeric(b)) {
    return(isTRUE(all.equal(as.numeric(a), as.numeric(b))))
  }
  identical(a, b)
}
