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
  # Rscript --vanilla does not inherit .libPaths() or library(lib.loc=...).
  # Bootstrap from the same installed Alder as this parent, including when
  # another version exists in the site library. Project/sandbox isolation is
  # applied by the worker after Alder and its runtime imports have loaded.
  package_path <- getNamespaceInfo(asNamespace("alder"), "path")
  if (file.exists(file.path(package_path, "Meta", "package.rds"))) {
    library_env <- if ("R_LIBS" %in% names(env)) env[["R_LIBS"]] else ""
    inherited_libs <- strsplit(library_env,
                              .Platform$path.sep, fixed = TRUE)[[1L]]
    bootstrap_libs <- unique(c(dirname(normalizePath(package_path)),
                               inherited_libs, .libPaths()))
    env[["R_LIBS"]] <- paste(bootstrap_libs[nzchar(bootstrap_libs)],
                              collapse = .Platform$path.sep)
  }
  # Parse the complete runtime before evaluating its long-lived local() scope.
  # Rscript file-mode loading is substantially slower for this large expression.
  # Unlike sys.source(), eval(parse()) leaves the notebook's R options intact.
  bootstrap <- paste0(
    "base::eval(base::parse(file = ", encodeString(worker_script, quote = "\""),
    ", keep.source = FALSE), envir = globalenv())"
  )
  processx::process$new(
    file.path(R.home("bin"), "Rscript"),
    args = c("--vanilla", "-e", bootstrap),
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

# Send exactly one startup request and pump the shared later loop until that
# tracked request succeeds, the process fails, or the deadline expires.  A
# generous default covers cold R/package-library startup on constrained
# machines; callers can shorten it in tests with `alder.worker_startup_timeout`.
.wait_for_worker <- function(worker, command = "ping",
                             timeout = getOption("alder.worker_startup_timeout", 45)) {
  if (!is.numeric(timeout) || length(timeout) != 1L || is.na(timeout) ||
      !is.finite(timeout) || timeout <= 0) {
    stop("worker startup timeout must be a positive number", call. = FALSE)
  }
  done <- FALSE
  response <- NULL
  worker$send(command, on_response = function(context, value) {
    response <<- value
    done <<- TRUE
  })
  deadline <- Sys.time() + timeout
  while (!done && worker$alive() && Sys.time() < deadline) {
    later::run_now(0.05)
    if (!done) Sys.sleep(0.001)
  }
  if (done && isTRUE(response$ok)) return(invisible(response))

  diagnostics <- worker$diagnostics()
  reason <- if (done) {
    as.character(response$error$message %||% "readiness request failed")
  } else if (!worker$alive()) {
    "worker exited before becoming ready"
  } else {
    paste0("worker did not become ready within ", format(timeout), " seconds")
  }
  detail <- character()
  status <- diagnostics$exit_status
  if (!is.null(status) && length(status) == 1L && !is.na(status)) {
    detail <- c(detail, paste0("exit status ", as.integer(status)))
  }
  if (nzchar(diagnostics$stderr)) {
    detail <- c(detail, paste0("stderr: ", diagnostics$stderr))
  }
  stop(paste0("worker failed to start: ", reason,
              if (length(detail)) paste0(" (", paste(detail, collapse = "; "), ")")
              else ""),
       call. = FALSE)
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
    interrupt_requested = NULL, # req id waiting for its start ack
    interrupt_sent = NULL,  # req id already SIGINTed
    failed_once = NULL,     # terminal transport failure has fired
    on_failure = NULL,      # one terminal callback(message)
    on_notify = NULL,       # Receives a request context and notification frame.
    stderr_lines = NULL,    # Bounded startup/runtime diagnostics.
    worker_script = NULL,   # respawn parameters for Worker$restart()
    app_dir = NULL,
    artifact_dir = NULL,
    artifact_retirements = NULL,
    artifact_sweep_scheduled = FALSE,
    artifact_retirement_seconds = 5,
    cache_dir = NULL,
    env = character(),
    initialize = function(proc, worker_script, app_dir, artifact_dir,
                          cache_dir = artifact_dir, env = character()) {
      self$proc <- proc
      self$pending <- new.env(parent = emptyenv())
      self$counter <- 1L
      self$poll_active <- FALSE
      self$interrupt_requested <- NULL
      self$interrupt_sent <- NULL
      self$failed_once <- NULL
      self$on_failure <- NULL
      self$on_notify <- NULL
      self$stderr_lines <- character()
      self$worker_script <- worker_script
      self$app_dir <- app_dir
      self$artifact_dir <- artifact_dir
      self$artifact_retirements <- new.env(parent = emptyenv())
      self$artifact_sweep_scheduled <- FALSE
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
      perf <- .alder_perf_begin("worker.dispatch", list(cmd = cmd, req = req,
        cell = ctx$id, revision = ctx$revision, run_id = ctx$run_id))
      on.exit(.alder_perf_end(perf), add = TRUE)
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
        self$record_stderr(tryCatch(proc$read_error_lines(1000),
                                    error = function(e) character()))
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
        self$record_stderr(el)
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

    record_stderr = function(lines, max_bytes = 65536L) {
      lines <- as.character(lines)
      lines <- lines[!is.na(lines) & nzchar(lines)]
      if (!length(lines)) return(invisible())
      self$stderr_lines <- c(self$stderr_lines, lines)
      while (length(self$stderr_lines) > 1L &&
             nchar(paste(self$stderr_lines, collapse = "\n"), type = "bytes") >
               max_bytes) {
        self$stderr_lines <- self$stderr_lines[-1L]
      }
      invisible()
    },

    diagnostics = function() {
      self$record_stderr(tryCatch(self$proc$read_error_lines(1000),
                                  error = function(e) character()))
      status <- tryCatch(self$proc$get_exit_status(), error = function(e) NULL)
      list(exit_status = status,
           stderr = paste(self$stderr_lines %||% character(), collapse = "\n"))
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
      perf <- .alder_perf_begin("worker.receive", list(cmd = resp$cmd,
        req = resp$req, cell = resp$id, revision = resp$revision,
        run_id = resp$run_id, ack = resp$ack, notify = resp$notify))
      on.exit(.alder_perf_end(perf), add = TRUE)
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
          if (identical(rid, self$interrupt_requested)) {
            self$interrupt_requested <- NULL
            self$signal_interrupt(rid)
          }
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
      if (identical(rid, self$interrupt_requested)) {
        self$interrupt_requested <- NULL
      }
      if (identical(rid, self$executing_req)) self$executing_req <- NULL
      if (identical(rid, self$interrupt_sent)) self$interrupt_sent <- NULL
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
      self$interrupt_requested <- NULL
      self$interrupt_sent <- NULL
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
      self$kill()
      self$fail_pending(message)
      if (!is.null(self$on_failure)) {
        tryCatch(self$on_failure(message),
                 error = function(e) message("worker on_failure callback: ",
                                             conditionMessage(e)),
                 interrupt = function(e) NULL)
      }
      invisible()
    },

    # Request SIGINT exactly once for one eval request. Before its start ack,
    # retain the matching request identity; handle_line() delivers the signal
    # as soon as that ack arrives. A request that is absent, already complete,
    # or different from the acknowledged eval can never inherit the signal.
    interrupt = function(rid = NULL) {
      if (is.null(rid)) rid <- self$executing_req
      if (is.null(rid)) return(invisible())
      rid <- as.character(rid)
      if (length(rid) != 1L || is.na(rid) || !nzchar(rid)) return(invisible())
      entry <- self$pending[[rid]]
      if (is.null(entry) || !identical(entry$context$cmd, "eval_cell")) {
        return(invisible())
      }
      if (is.null(self$executing_req)) {
        if (is.null(self$interrupt_requested)) self$interrupt_requested <- rid
        return(invisible())
      }
      if (!identical(rid, as.character(self$executing_req))) return(invisible())
      self$signal_interrupt(rid)
      invisible()
    },

    signal_interrupt = function(rid) {
      rid <- as.character(rid)
      if (!identical(rid, as.character(self$executing_req))) return(invisible())
      if (identical(rid, self$interrupt_sent)) return(invisible())
      self$interrupt_sent <- rid
      signal_error <- NULL
      signalled <- if (!self$proc$is_alive()) {
        signal_error <- "worker process is not alive"
        FALSE
      } else {
        tryCatch(
          self$proc$interrupt(),
          error = function(error) {
            signal_error <<- conditionMessage(error)
            FALSE
          })
      }
      if (!isTRUE(signalled)) {
        if (is.null(signal_error)) signal_error <- "interrupt returned false"
        self$transport_error(paste0("Worker interrupt failed: ", signal_error))
      }
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
      if (self$alive()) self$kill()
      self$fail_pending("Worker restarted")
      self$executing_req <- NULL
      self$interrupt_requested <- NULL
      self$interrupt_sent <- NULL
      self$failed_once <- NULL
      proc <- .spawn_worker_process(self$worker_script, self$app_dir,
                                    self$artifact_dir, self$cache_dir,
                                    self$env)
      self$proc <- proc
      self$pending <- new.env(parent = emptyenv())
      self$counter <- 1L
      self$poll_active <- FALSE
      self$stderr_lines <- character()
      self$on_failure <- failure_cb
      invisible(self)
    },

    # Retire a contained rendered artifact after a bounded grace period. State
    # snapshots publish immutable artifact URLs before the browser fetches
    # them; immediate unlink on the next reactive commit can otherwise turn a
    # valid, just-published plot into a transient 404. Session shutdown still
    # removes the entire temporary artifact directory.
    release_artifact = function(artifact) {
      if (is.null(artifact) || length(artifact) != 1L || is.na(artifact) ||
          !nzchar(artifact)) {
        return(invisible(FALSE))
      }
      base <- basename(artifact)
      if (!identical(base, artifact) ||
          !(tolower(tools::file_ext(base)) %in% c(
            "png", "jpg", "jpeg", "gif", "webp", "svg", "html",
            "mp3", "wav", "ogg", "mp4", "webm", "pdf"
          ))) {
        return(invisible(FALSE))
      }
      if (!dir.exists(self$artifact_dir)) return(invisible(FALSE))
      root <- normalizePath(self$artifact_dir, mustWork = TRUE)
      p <- file.path(root, base)
      if (!startsWith(tryCatch(normalizePath(p), error = function(e) ""),
                      paste0(root, .Platform$file.sep))) {
        return(invisible(FALSE))
      }
      if (!file.exists(p) || dir.exists(p)) return(invisible(FALSE))
      self$artifact_retirements[[base]] <-
        as.numeric(Sys.time()) + self$artifact_retirement_seconds
      self$schedule_artifact_sweep()
      invisible(TRUE)
    },

    schedule_artifact_sweep = function(delay = self$artifact_retirement_seconds) {
      if (isTRUE(self$artifact_sweep_scheduled)) return(invisible())
      self$artifact_sweep_scheduled <- TRUE
      later::later(function() {
        self$artifact_sweep_scheduled <- FALSE
        self$sweep_artifacts()
      }, delay)
      invisible()
    },

    # Public for deterministic tests; normal callers rely on the scheduled
    # sweep. Failed unlinks remain queued, are reported, and are retried.
    sweep_artifacts = function(now = Sys.time()) {
      ids <- ls(self$artifact_retirements, all.names = TRUE)
      if (!length(ids)) return(invisible(0L))
      now <- as.numeric(now)
      if (length(now) != 1L || is.na(now) || !is.finite(now)) {
        stop("artifact sweep time must be finite", call. = FALSE)
      }
      if (!dir.exists(self$artifact_dir)) {
        rm(list = ids, envir = self$artifact_retirements)
        return(invisible(0L))
      }
      root <- normalizePath(self$artifact_dir, mustWork = TRUE)
      removed <- 0L
      for (base in ids) {
        deadline <- self$artifact_retirements[[base]]
        if (!is.numeric(deadline) || length(deadline) != 1L ||
            is.na(deadline) || deadline > now) {
          next
        }
        p <- file.path(root, base)
        if (!file.exists(p) || dir.exists(p)) {
          rm(list = base, envir = self$artifact_retirements)
          next
        }
        status <- unlink(p)
        if (identical(status, 0L)) {
          rm(list = base, envir = self$artifact_retirements)
          removed <- removed + 1L
        } else {
          self$artifact_retirements[[base]] <-
            now + self$artifact_retirement_seconds
          message("[alder:artifact] Could not retire ", base,
                  "; cleanup will be retried")
        }
      }
      remaining <- ls(self$artifact_retirements, all.names = TRUE)
      if (length(remaining)) {
        deadlines <- vapply(remaining, function(base) {
          as.numeric(self$artifact_retirements[[base]])
        }, numeric(1))
        self$schedule_artifact_sweep(max(0.01, min(deadlines) - now))
      }
      invisible(removed)
    },

    stop = function(grace = 0.2) {
      self$poll_active <- FALSE
      # Final shutdown is intentionally synchronous. Returning while the
      # process (or processx supervisor) is still live leaks children in
      # non-init containers and lets artifact cleanup race worker teardown.
      failure_cb <- self$on_failure
      self$on_failure <- NULL
      if (self$alive()) {
        tryCatch(self$send("shutdown"), error = function(e) NULL)
        self$poll_active <- FALSE
        wait_ms <- max(0L, as.integer(grace * 1000))
        tryCatch(self$proc$wait(wait_ms), error = function(e) NULL)
        if (self$alive()) self$kill()
      } else {
        tryCatch(self$proc$wait(0), error = function(e) NULL)
      }
      self$fail_pending("Worker stopped")
      self$executing_req <- NULL
      self$interrupt_requested <- NULL
      self$interrupt_sent <- NULL
      self$artifact_retirements <- new.env(parent = emptyenv())
      self$artifact_sweep_scheduled <- FALSE
      self$on_failure <- failure_cb
      invisible()
    },

    kill = function() {
      if (self$proc$is_alive()) {
        tryCatch(self$proc$kill(), error = function(e) NULL)
      }
      # processx only reaps the child after an exit-status/wait operation.
      # A bounded wait is safe after kill and prevents zombie accumulation.
      tryCatch(self$proc$wait(5000), error = function(e) NULL)
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
