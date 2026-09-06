#!/usr/bin/env Rscript

# Installed-artifact B-109--B-122 MCP boundary probe. This speaks raw
# JSON-lines over live processx pipes; it never calls mcp_dispatch() directly.
# Hostile frames are retained as byte counts in evidence, not as full payloads.

options(warn = 2)

required_env <- function(name) {
  value <- Sys.getenv(name, unset = "")
  if (!nzchar(value)) stop("missing required environment variable: ", name,
                           call. = FALSE)
  value
}

artifact <- normalizePath(required_env("ALDER_MCP_FRAMING_ARTIFACT"),
                          mustWork = TRUE)
expected_sha <- tolower(required_env("ALDER_MCP_FRAMING_SHA256"))
private_lib <- normalizePath(required_env("ALDER_MCP_FRAMING_LIB"),
                             mustWork = TRUE)
audit_root <- normalizePath(required_env("ALDER_MCP_FRAMING_ROOT"),
                            mustWork = TRUE)
evidence <- normalizePath(required_env("ALDER_MCP_FRAMING_EVIDENCE"),
                          mustWork = FALSE)
if (!grepl("^[[:xdigit:]]{64}$", expected_sha)) {
  stop("ALDER_MCP_FRAMING_SHA256 must be a 64-character SHA-256 digest",
       call. = FALSE)
}
if (!file.exists(file.path(private_lib, "alder", "DESCRIPTION"))) {
  stop("private library does not contain an installed Alder package",
       call. = FALSE)
}
if (!dir.exists(evidence) && !dir.create(evidence, recursive = TRUE)) {
  stop("could not create evidence directory: ", evidence, call. = FALSE)
}

sha_output <- system2("sha256sum", artifact, stdout = TRUE, stderr = TRUE)
if (length(sha_output) != 1L) stop("could not compute artifact SHA-256",
                                    call. = FALSE)
observed_sha <- tolower(strsplit(sha_output[[1L]], "[[:space:]]+")[[1L]][[1L]])
if (!identical(observed_sha, expected_sha)) {
  stop("artifact SHA-256 mismatch: expected ", expected_sha,
       ", received ", observed_sha, call. = FALSE)
}

.libPaths(c(private_lib, .libPaths()))
suppressPackageStartupMessages({
  library(alder, lib.loc = private_lib)
  library(curl)
  library(httpuv)
  library(jsonlite)
  library(processx)
})

launcher <- file.path(audit_root, "bin", "alder")
if (!file.exists(launcher) || file.access(launcher, 1L) != 0L) {
  stop("installed audit launcher is missing or not executable: ", launcher,
       call. = FALSE)
}

checks <- list()
failures <- character()
observations <- list()
started <- as.numeric(Sys.time())
# Keep the probe's accounting explicit. Each primary transport has 103 responses
# before teardown, one shutdown response, and 17 silent notifications. The
# 109 assertions per transport plus three cross-transport assertions therefore
# produce exactly 221 checks on a complete run. The four-policy local/URL
# matrix adds 52 deterministic checks, failed negotiation adds 5, startup
# failure adds 5, and early EOF adds 3, for a total of 286.
expected_responses_per_transport <- 104L
expected_notifications_per_transport <- 17L
expected_requests_per_transport <- 121L
expected_checks_per_transport <- 109L
expected_cross_transport_checks <- 3L
expected_policy_checks <- 52L
expected_failed_negotiation_checks <- 5L
expected_startup_failure_checks <- 5L
expected_early_eof_checks <- 3L
expected_total_checks <- 2L * expected_checks_per_transport +
  expected_cross_transport_checks + expected_policy_checks +
  expected_failed_negotiation_checks + expected_startup_failure_checks +
  expected_early_eof_checks
`%||%` <- function(left, right) {
  if (is.null(left) || !length(left)) right else left
}
# jsonlite serializes an unnamed list() as [], while MCP object-valued
# parameters must be encoded as {}. Keep this distinction explicit in every
# valid no-argument tool call below.
mcp_empty_object <- function() structure(list(), names = character())
record <- function(id, pass, actual = NULL, expected = NULL) {
  pass <- isTRUE(pass)
  checks[[length(checks) + 1L]] <<- list(
    id = id, pass = pass, actual = actual, expected = expected
  )
  cat(if (pass) "PASS " else "FAIL ", id, "\n", sep = "")
  if (!pass) failures <<- c(failures, id)
  invisible(pass)
}
observe <- function(id, value) {
  observations[[length(observations) + 1L]] <<- list(id = id, value = value)
  invisible(value)
}
write_json <- function(value, path) {
  jsonlite::write_json(value, path, auto_unbox = TRUE, null = "null",
                       na = "null", digits = 17, pretty = TRUE, force = TRUE)
}
marker_count <- function(path) {
  if (!file.exists(path)) return(0L)
  values <- suppressWarnings(as.integer(readLines(path, warn = FALSE)))
  if (length(values) != 1L || is.na(values)) return(NA_integer_)
  values[[1L]]
}

process_rows <- function() {
  lines <- system2("ps", c("-eo", "pid=,ppid=,stat=,args="), stdout = TRUE)
  hits <- regmatches(lines, regexec(
    "^[[:space:]]*([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([^[:space:]]+)[[:space:]]+(.*)$",
    lines
  ))
  Filter(length, lapply(hits, function(hit) list(
    pid = as.integer(hit[[2L]]), ppid = as.integer(hit[[3L]]),
    stat = hit[[4L]], args = hit[[5L]]
  )))
}
descendants <- function(root_pid) {
  rows <- process_rows()
  wanted <- as.integer(root_pid)
  repeat {
    children <- vapply(rows[vapply(rows, function(row) row$ppid %in% wanted,
                                    logical(1L))],
                        `[[`, integer(1L), "pid")
    expanded <- unique(c(wanted, children))
    if (identical(expanded, wanted)) break
    wanted <- expanded
  }
  Filter(function(row) row$pid %in% wanted, rows)
}
wait_pids_gone <- function(pids, timeout = 12) {
  deadline <- Sys.time() + timeout
  repeat {
    present <- pids[vapply(pids, function(pid) {
      dir.exists(file.path("/proc", as.character(pid)))
    }, logical(1L))]
    if (!length(present) || Sys.time() >= deadline) return(present)
    Sys.sleep(0.05)
  }
}

peak_rss_kb <- function(pid) {
  path <- file.path("/proc", as.character(pid), "status")
  lines <- tryCatch(readLines(path, warn = FALSE), error = function(e) character())
  value <- grep("^VmHWM:[[:space:]]+[0-9]+[[:space:]]+kB$", lines,
                value = TRUE)
  if (length(value) != 1L) return(NA_real_)
  as.numeric(sub("^VmHWM:[[:space:]]+([0-9]+).*$", "\\1", value))
}

environment_for <- function(extra = character()) {
  value <- Sys.getenv()
  value <- value[names(value) != "R_TESTS"]
  prior <- Sys.getenv("R_LIBS", unset = "")
  value[["R_LIBS"]] <- paste(c(private_lib, prior[nzchar(prior)]),
                              collapse = .Platform$path.sep)
  value[["R_LIBS_USER"]] <- private_lib
  value[["BROWSER"]] <- "false"
  c(value, extra)
}

live_processes <- list()
register_process <- function(process) {
  live_processes[[length(live_processes) + 1L]] <<- process
  process
}
on.exit({
  for (process in rev(live_processes)) {
    if (inherits(process, "process") && process$is_alive()) {
      try(process$kill_tree(), silent = TRUE)
      try(process$wait(5000), silent = TRUE)
    }
  }
}, add = TRUE)

source_fixture <- function(tag) {
  path <- tempfile(paste0("alder-b109-", tag, "-"), fileext = ".R")
  marker <- paste0(path, ".started")
  writeLines(c(
    "# ---", "# runtime:", "#   execution_mode: automatic",
    "#   run_on_startup: false", "# ---", "# %%",
    paste0("writeLines('started', ", encodeString(marker, quote = "'"), ")"),
    "x <- 1L"
  ), path, useBytes = TRUE)
  path
}
frame_bytes <- function(value) {
  if (is.raw(value)) value else charToRaw(value)
}
json_frame <- function(value) frame_bytes(as.character(toJSON(
  value, auto_unbox = TRUE, null = "null", na = "null", digits = 17,
  force = TRUE
)))
send_bytes <- function(process, bytes) {
  remaining <- bytes
  deadline <- Sys.time() + 90
  while (length(remaining)) {
    remaining <- processx::conn_write(
      process$get_input_connection(), remaining
    )
    if (length(remaining)) {
      if (!process$is_alive()) stop("MCP process exited while writing a frame",
                                    call. = FALSE)
      if (Sys.time() >= deadline) stop("timed out writing an MCP frame",
                                      call. = FALSE)
      Sys.sleep(0.005)
    }
  }
  invisible(NULL)
}
response_summary <- function(response) {
  result <- response$result %||% list()
  error <- response$error %||% list()
  list(id = response$id %||% NULL, error_code = error$code %||% NULL,
       error_message = error$message %||% NULL,
       result_is_error = result$isError %||% NULL,
       result_has_content = length(result$content %||% list()) > 0L)
}

new_client <- function(kind, target) {
  expression <- if (identical(kind, "local")) {
    paste0(
      ".libPaths(c(Sys.getenv('ALDER_MCP_FRAMING_LIB'), .libPaths())); ",
      "suppressPackageStartupMessages(library(alder, lib.loc=Sys.getenv('",
      "ALDER_MCP_FRAMING_LIB'))); ",
      "alder::alder_mcp(path=Sys.getenv('ALDER_MCP_FRAMING_TARGET'))"
    )
  } else {
    paste0(
      ".libPaths(c(Sys.getenv('ALDER_MCP_FRAMING_LIB'), .libPaths())); ",
      "suppressPackageStartupMessages(library(alder, lib.loc=Sys.getenv('",
      "ALDER_MCP_FRAMING_LIB'))); ",
      "alder::alder_mcp(url=Sys.getenv('ALDER_MCP_FRAMING_TARGET'))"
    )
  }
  child <- register_process(processx::process$new(
    file.path(R.home("bin"), "Rscript"), c("--vanilla", "-e", expression),
    env = environment_for(c(ALDER_MCP_FRAMING_LIB = private_lib,
                             ALDER_MCP_FRAMING_TARGET = target)),
    stdin = "|", stdout = "|", stderr = "|", cleanup_tree = TRUE
  ))
  client <- new.env(parent = emptyenv())
  client$kind <- kind
  client$process <- child
  client$requests <- list()
  client$responses <- list()
  client$stderr <- character()
  client$queue <- list()
  client$next_id <- 1L
  client$rpc_bytes <- function(bytes, label, timeout = 90) {
    bytes <- frame_bytes(bytes)
    id <- client$next_id
    client$next_id <- id + 1L
    started <- proc.time()[["elapsed"]]
    send_bytes(child, c(bytes, as.raw(10L)))
    deadline <- Sys.time() + timeout
    repeat {
      client$queue <- c(client$queue, child$read_output_lines())
      client$stderr <- c(client$stderr, child$read_error_lines())
      if (length(client$queue)) {
        line <- client$queue[[1L]]
        client$queue <- client$queue[-1L]
        parsed <- tryCatch(fromJSON(line, simplifyVector = FALSE),
                           error = function(error) NULL)
        if (is.null(parsed)) stop(client$kind, " returned non-JSON response",
                                  call. = FALSE)
        elapsed <- proc.time()[["elapsed"]] - started
        client$requests[[length(client$requests) + 1L]] <- list(
          label = label, bytes = length(bytes), eof = FALSE
        )
        client$responses[[length(client$responses) + 1L]] <- list(
          label = label, elapsed_seconds = unname(elapsed),
          alive_after_response = child$is_alive(), response = response_summary(parsed)
        )
        return(parsed)
      }
      if (!child$is_alive()) stop(client$kind, " exited before response",
                                  call. = FALSE)
      if (Sys.time() >= deadline) stop(client$kind, " response timeout for ",
                                       label, call. = FALSE)
      Sys.sleep(0.01)
    }
  }
  client$quiet_bytes <- function(bytes, label, timeout = 1) {
    bytes <- frame_bytes(bytes)
    send_bytes(child, c(bytes, as.raw(10L)))
    client$requests[[length(client$requests) + 1L]] <- list(
      label = label, bytes = length(bytes), eof = FALSE, notification = TRUE
    )
    deadline <- Sys.time() + timeout
    repeat {
      client$queue <- c(client$queue, child$read_output_lines())
      client$stderr <- c(client$stderr, child$read_error_lines())
      if (length(client$queue)) {
        line <- client$queue[[1L]]
        client$queue <- client$queue[-1L]
        return(list(silent = FALSE, line = line,
                    alive_after = child$is_alive()))
      }
      if (!child$is_alive()) {
        return(list(silent = TRUE, line = NULL, alive_after = FALSE))
      }
      if (Sys.time() >= deadline) {
        return(list(silent = TRUE, line = NULL, alive_after = TRUE))
      }
      Sys.sleep(0.01)
    }
  }
  client$rpc <- function(method, params = NULL, label = method, timeout = 90) {
    id <- client$next_id
    request <- list(jsonrpc = "2.0", id = id, method = method)
    if (!is.null(params)) request$params <- params
    client$rpc_bytes(json_frame(request), label, timeout)
  }
  client$notify <- function(method, params = NULL, label = method) {
    request <- list(jsonrpc = "2.0", method = method)
    if (!is.null(params)) request$params <- params
    bytes <- json_frame(request)
    send_bytes(child, c(bytes, as.raw(10L)))
    client$requests[[length(client$requests) + 1L]] <- list(
      label = label, bytes = length(bytes), eof = FALSE, notification = TRUE
    )
    invisible(NULL)
  }
  client$shutdown <- function() {
    if (child$is_alive()) client$rpc("shutdown", NULL, "shutdown", 30)
    else NULL
  }
  client
}

payload <- function(response) {
  content <- response$result$content %||% list()
  if (!length(content)) return(NULL)
  fromJSON(content[[1L]]$text, simplifyVector = FALSE)
}
state_revision <- function(response) {
  value <- payload(response)
  cells <- value$cells %||% list()
  if (!length(cells)) return(NA_integer_)
  as.integer(cells[[1L]]$revision %||% NA_integer_)
}

curl_json <- function(base, route, method = "GET", token = NULL) {
  handle <- curl::new_handle(connecttimeout_ms = 1000L, timeout_ms = 5000L)
  if (identical(method, "POST")) {
    curl::handle_setopt(handle, customrequest = "POST", postfields = "")
  }
  if (!is.null(token)) curl::handle_setheaders(
    handle, .list = as.list(c("X-Alder-Shutdown-Token" = token))
  )
  response <- curl::curl_fetch_memory(paste0(base, route), handle = handle)
  list(status = as.integer(response$status_code),
       body = fromJSON(rawToChar(response$content), simplifyVector = FALSE))
}

# BEGIN PASSIVE STARTUP OBSERVATION
# This release-only observer preserves the test's control flow and assertions. It does
# not retry a launch, drain a live startup pipe, or change the readiness deadline.
startup_observer <- local({
  sequence <- 0L
  errors <- list()
  root <- file.path(evidence, "startup-observation")
  dir.create(root, recursive = TRUE, showWarnings = FALSE)
  condition_info <- function(error) list(
    message = conditionMessage(error), classes = class(error),
    call = paste(deparse(conditionCall(error)), collapse = "\n")
  )
  safe <- function(label, code) {
    tryCatch(force(code), error = function(error) {
      errors[[length(errors) + 1L]] <<- list(
        label = label, time_unix = as.numeric(Sys.time()),
        condition = condition_info(error)
      )
      try(write_json(errors, file.path(root, "observer-errors.json")),
          silent = TRUE)
      cat("STARTUP OBSERVER ERROR ", label, ": ",
          conditionMessage(error), "\n", sep = "", file = stderr())
      NULL
    })
  }
  persist <- function(observation) safe("persist-attempt", {
    write_json(observation$data, file.path(observation$directory, "attempt.json"))
    write_json(errors, file.path(root, "observer-errors.json"))
  })
  begin <- function(notebook, port, base) {
    sequence <<- sequence + 1L
    observation <- new.env(parent = emptyenv())
    observation$directory <- file.path(root, sprintf("attempt-%02d", sequence))
    observation$data <- list(
      sequence = sequence, phase = "before-spawn",
      before_spawn_unix = as.numeric(Sys.time()), parent_pid = Sys.getpid(),
      notebook = notebook, port = port, base = base,
      command = launcher,
      arguments = c("edit", notebook, "--host", "127.0.0.1", "--port",
                    as.character(port), "--no-open", "--no-idle-timeout"),
      process_options = list(stdout = "|", stderr = "|", cleanup_tree = TRUE),
      artifact = artifact, artifact_sha256 = observed_sha,
      private_library = private_lib, audit_root = audit_root,
      runtime = R.version.string, runtime_platform = R.version$platform,
      rscript = file.path(R.home("bin"), "Rscript"),
      installed_alder = find.package("alder"),
      installed_version = as.character(utils::packageVersion("alder")),
      parent_library_paths = .libPaths(), working_directory = getwd(),
      parent_runtime_environment = as.list(Sys.getenv(c(
        "R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE", "R_TESTS",
        "R_ENVIRON_USER", "R_PROFILE_USER", "R_DEFAULT_PACKAGES", "R_ENABLE_JIT",
        "TMPDIR", "TMP", "TEMP", "BROWSER", "LANG", "LC_ALL", "PATH"
      ), unset = NA_character_)),
      child_environment_contract = list(
        R_TESTS = "removed", R_LIBS = environment_for()[["R_LIBS"]],
        R_LIBS_USER = private_lib, BROWSER = "false"
      ),
      http_contract = list(route = "/api/state", method = "GET",
        connecttimeout_ms = 1000L, timeout_ms = 5000L,
        readiness = "status 200 and !isTRUE(state$body$runtime$busy)",
        deadline_seconds = 60, between_attempt_sleep_seconds = 0.05),
      http_history = list()
    )
    safe("begin-attempt", {
      dir.create(observation$directory, recursive = TRUE, showWarnings = FALSE)
      source <- readBin(notebook, what = "raw", n = file.info(notebook)$size)
      writeBin(source, file.path(observation$directory, "notebook-before.R"))
      observation$data$notebook_bytes <- length(source)
      observation$data$notebook_md5 <- unname(tools::md5sum(notebook))
      observation$data$launcher_md5 <- unname(tools::md5sum(launcher))
      persist(observation)
    })
    observation
  }
  spawned <- function(observation, process, deadline) safe("spawned", {
    observation$data$phase <- "polling"
    observation$data$pid <- process$get_pid()
    observation$data$deadline_unix <- as.numeric(deadline)
    observation$data$after_spawn_unix <- as.numeric(Sys.time())
    persist(observation)
  })
  poll <- function(observation, state, error, request_started) safe("http-result", {
    history <- observation$data$http_history
    history[[length(history) + 1L]] <- list(
      index = length(history) + 1L, started_unix = request_started,
      finished_unix = as.numeric(Sys.time()),
      response = state, error = error
    )
    observation$data$http_history <- history
  })
  boundary <- function(observation, process, deadline, classification,
                       predicate_alive = NULL) safe("original-boundary", {
    observation$data$phase <- "boundary"
    observation$data$boundary <- classification
    observation$data$boundary_unix <- as.numeric(Sys.time())
    observation$data$deadline_unix <- as.numeric(deadline)
    observation$data$process_alive_in_original_failure_predicate <- predicate_alive
    observation$data$process_alive_at_boundary <- process$is_alive()
    observation$data$exit_status_at_boundary <- process$get_exit_status()
    # These are the first pipe reads. They occur only after the original loop
    # has chosen success or failure. No wait, extra HTTP call or kill is added.
    stdout <- safe("boundary-stdout", process$read_output())
    stderr <- safe("boundary-stderr", process$read_error())
    if (!is.null(stdout)) writeBin(charToRaw(stdout),
      file.path(observation$directory, "stdout-boundary.bin"))
    if (!is.null(stderr)) writeBin(charToRaw(stderr),
      file.path(observation$directory, "stderr-boundary.bin"))
    observation$data$stdout_snapshot_bytes <- if (is.null(stdout)) NULL else
      length(charToRaw(stdout))
    observation$data$stderr_snapshot_bytes <- if (is.null(stderr)) NULL else
      length(charToRaw(stderr))
    observation$data$notebook_md5_at_boundary <- unname(tools::md5sum(
      observation$data$notebook))
    persist(observation)
  })
  local_checkpoint <- function(result) safe("pre-url-checkpoint", {
    write_json(checks, file.path(root, "pre-url-checks.json"))
    write_json(result, file.path(root, "pre-url-local-result.json"))
    write_json(observations, file.path(root, "pre-url-observations.json"))
    write_json(list(checks = length(checks), failures = failures,
      time_unix = as.numeric(Sys.time()), artifact_sha256 = observed_sha),
      file.path(root, "pre-url-checkpoint.json"))
    write_json(errors, file.path(root, "observer-errors.json"))
  })
  require_clean <- function() {
    if (length(errors)) {
      stop("MCP startup observation failed: ", length(errors),
           " observer error(s); see startup-observation/observer-errors.json",
           call. = FALSE)
    }
    invisible(NULL)
  }
  list(begin = begin, spawned = spawned, poll = poll, boundary = boundary,
       local_checkpoint = local_checkpoint, condition_info = condition_info,
       require_clean = require_clean)
})
# END PASSIVE STARTUP OBSERVATION

start_server <- function(notebook) {
  port <- httpuv::randomPort()
  base <- paste0("http://127.0.0.1:", port)
  startup_observation <- startup_observer$begin(notebook, port, base)
  process <- register_process(processx::process$new(
    launcher,
    c("edit", notebook, "--host", "127.0.0.1", "--port", as.character(port),
      "--no-open", "--no-idle-timeout"),
    env = environment_for(), stdout = "|", stderr = "|", cleanup_tree = TRUE
  ))
  deadline <- Sys.time() + 60
  startup_observer$spawned(startup_observation, process, deadline)
  state <- NULL
  repeat {
    startup_http_error <- NULL
    startup_http_started <- as.numeric(Sys.time())
    state <- tryCatch(curl_json(base, "/api/state"), error = function(e) {
      startup_http_error <<- startup_observer$condition_info(e)
      NULL
    })
    startup_observer$poll(startup_observation, state, startup_http_error,
                          startup_http_started)
    if (!is.null(state) && identical(state$status, 200L) &&
        !isTRUE(state$body$runtime$busy)) {
      startup_observer$boundary(startup_observation, process, deadline, "ready")
      break
    }
    if (!(startup_predicate_alive <- process$is_alive()) || Sys.time() >= deadline) {
      startup_observer$boundary(startup_observation, process, deadline,
        if (startup_predicate_alive) "deadline" else "process_dead",
        startup_predicate_alive)
      stop("loopback Alder server did not become ready", call. = FALSE)
    }
    Sys.sleep(0.05)
  }
  list(process = process, port = port, base = base,
       shutdown_token = state$body$shutdown_token %||% "")
}
port_open <- function(port) {
  connection <- tryCatch(suppressWarnings(socketConnection(
    "127.0.0.1", port = port, open = "r+", blocking = TRUE, timeout = 0.2
  )), error = function(error) NULL)
  if (is.null(connection)) return(FALSE)
  close(connection)
  TRUE
}
stop_server <- function(server) {
  if (is.null(server)) return(invisible())
  tracked <- vapply(descendants(server$process$get_pid()), `[[`, integer(1L),
                    "pid")
  requested_shutdown <- FALSE
  if (server$process$is_alive() && nzchar(server$shutdown_token)) {
    requested_shutdown <- !inherits(try(curl_json(
      server$base, "/api/shutdown", "POST", server$shutdown_token
    ), silent = TRUE), "try-error")
  }
  if (requested_shutdown) {
    deadline <- Sys.time() + 30
    while (server$process$is_alive() && Sys.time() < deadline) {
      Sys.sleep(0.02)
    }
  }
  if (server$process$is_alive()) try(server$process$kill_tree(), silent = TRUE)
  try(server$process$wait(5000), silent = TRUE)
  list(status = tryCatch(server$process$get_exit_status(),
                         error = function(error) NA_integer_),
       tracked_pids = tracked, alive = wait_pids_gone(tracked),
       port_open = port_open(server$port))
}
close_client <- function(client) {
  tracked <- vapply(descendants(client$process$get_pid()), `[[`, integer(1L),
                    "pid")
  if (client$process$is_alive()) try(client$shutdown(), silent = TRUE)
  deadline <- Sys.time() + 30
  while (client$process$is_alive() && Sys.time() < deadline) Sys.sleep(0.02)
  if (client$process$is_alive()) try(client$process$kill_tree(), silent = TRUE)
  if (client$process$is_alive()) try(client$process$wait(5000), silent = TRUE)
  client$stderr <- c(client$stderr, client$process$read_error_lines())
  status <- tryCatch(client$process$get_exit_status(), error = function(e) NA_integer_)
  list(status = status, tracked_pids = tracked,
       alive = wait_pids_gone(tracked), stderr = client$stderr)
}

make_oversize <- function(target_bytes) {
  prefix <- charToRaw('{"jsonrpc":"2.0","id":99,"method":"ping","padding":"')
  suffix <- charToRaw('"}')
  bytes <- c(prefix, charToRaw(strrep("x", target_bytes - length(prefix) -
                                      length(suffix))), suffix)
  if (length(bytes) != target_bytes) stop("could not size oversize frame",
                                           call. = FALSE)
  bytes
}

mcp_limit <- 16L * 1024L * 1024L

framing_cases <- function() {
  duplicate_revision <- function(first, second) paste0(
    '{"jsonrpc":"2.0","id":', first$id,
    ',"method":"tools/call","params":{"name":"edit_cell",',
    '"arguments":{"cell":"cell-1","body":["x <- ', first$body,
    '"],"type":"code","expected_revision":', first$revision,
    ',"expected_revision":', second$revision, "}}}"
  )
  list(
    duplicate_revision_current_then_stale = duplicate_revision(
      list(id = 11L, body = "101", revision = 0L),
      list(revision = 999L)),
    duplicate_revision_stale_then_current = duplicate_revision(
      list(id = 12L, body = "102", revision = 999L),
      list(revision = 0L)),
    duplicate_params_name = paste0(
      '{"jsonrpc":"2.0","id":13,"method":"tools/call",',
      '"params":{"name":"edit_cell","name":"notebook_state",',
      '"arguments":{"cell":"cell-1","body":["x <- 103"],',
      '"type":"code"}}}'
    ),
    duplicate_nested_edit_body = paste0(
      '{"jsonrpc":"2.0","id":14,"method":"tools/call",',
      '"params":{"name":"edit_cell","arguments":{"cell":"cell-1",',
      '"body":["x <- 104"],"body":["x <- 105"],"type":"code",',
      '"expected_revision":0}}}'
    ),
    duplicate_nested_widget_value = paste0(
      '{"jsonrpc":"2.0","id":15,"method":"tools/call",',
      '"params":{"name":"set_widget","arguments":{"name":"missing",',
      '"value":1,"value":2}}}'
    ),
    duplicate_envelope_method = paste0(
      '{"jsonrpc":"2.0","id":16,"method":"tools/call",',
      '"method":"ping","params":{"name":"edit_cell","arguments":{',
      '"cell":"cell-1","body":["x <- 106"],"type":"code",',
      '"expected_revision":0}}}'
    ),
    duplicate_escaped_name = paste0(
      '{"jsonrpc":"2.0","id":17,"method":"tools/call",',
      '"params":{"name":"edit_cell","na\\u006de":"notebook_state",',
      '"arguments":{"cell":"cell-1","body":["x <- 107"],',
      '"type":"code","expected_revision":0}}}'
    ),
    duplicate_inside_array_object = paste0(
      '{"jsonrpc":"2.0","id":18,"method":"tools/call",',
      '"params":{"name":"set_widget","arguments":{"name":"missing",',
      '"value":[{"choice":1,"choice":2}]}}}'
    ),
    invalid_boolean_id = paste0(
      '{"jsonrpc":"2.0","id":true,"method":"tools/call",',
      '"params":{"name":"edit_cell","arguments":{"cell":"cell-1",',
      '"body":["x <- 108"],"type":"code","expected_revision":1}}}'
    ),
    malformed_json = '{"jsonrpc":"2.0","id":19,"method":}',
    embedded_nul = c(charToRaw('{"jsonrpc":"2.0","id":20,"method":"ping'),
                     as.raw(0L), charToRaw('"}')),
    invalid_utf8 = c(charToRaw('{"jsonrpc":"2.0","id":21,"method":"'),
                     as.raw(c(0xc3L, 0x28L)), charToRaw('"}')),
    non_object_root = '[{"jsonrpc":"2.0","id":22,"method":"ping"}]',
    structural_flood = paste0('{"a":', strrep("[", 40000L), "0",
                              strrep("]", 40000L), "}"),
    one_byte_over_cap = make_oversize(mcp_limit + 1L),
    four_times_cap_plus_one = make_oversize(4L * mcp_limit + 1L)
  )
}

same_rpc_id <- function(actual, expected) {
  if (is.character(actual) || is.character(expected)) {
    return(is.character(actual) && is.character(expected) &&
             length(actual) == 1L && length(expected) == 1L &&
             !is.na(actual) && !is.na(expected) && identical(actual, expected))
  }
  if (is.numeric(actual) || is.numeric(expected)) {
    return(is.numeric(actual) && is.numeric(expected) &&
             length(actual) == 1L && length(expected) == 1L &&
             is.finite(actual) && is.finite(expected) &&
             isTRUE(actual == expected))
  }
  identical(actual, expected)
}

accepted_id_cases <- function() {
  list(
    empty_string = list(raw = '""', expected = ""),
    unicode_string = list(raw = '"\u6c34\U0001f525"', expected = "水🔥"),
    negative_one = list(raw = "-1", expected = -1),
    zero = list(raw = "0", expected = 0),
    one = list(raw = "1", expected = 1),
    minimum_safe_integer = list(raw = "-9007199254740991", expected = -9007199254740991),
    maximum_safe_integer = list(raw = "9007199254740991", expected = 9007199254740991),
    integral_exponent = list(raw = "1e3", expected = 1000)
  )
}

invalid_param_cases <- function() {
  list(
    ping_scalar = list(
      id = "params-scalar",
      raw = '{"jsonrpc":"2.0","id":"params-scalar","method":"ping","params":false}'
    ),
    ping_null = list(
      id = "params-null",
      raw = '{"jsonrpc":"2.0","id":"params-null","method":"ping","params":null}'
    ),
    ping_array = list(
      id = "params-array",
      raw = '{"jsonrpc":"2.0","id":"params-array","method":"ping","params":[]}'
    ),
    initialize_incomplete = list(
      id = "initialize-incomplete",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"initialize-incomplete",',
        '"method":"initialize","params":{"protocolVersion":"2024-11-05",',
        '"capabilities":{}}}'
      )
    ),
    initialize_wrong_protocol = list(
      id = "initialize-wrong-protocol",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"initialize-wrong-protocol",',
        '"method":"initialize","params":{"protocolVersion":false,',
        '"capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
      )
    ),
    initialize_wrong_capabilities = list(
      id = "initialize-wrong-capabilities",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"initialize-wrong-capabilities",',
        '"method":"initialize","params":{"protocolVersion":"2024-11-05",',
        '"capabilities":false,"clientInfo":{"name":"probe","version":"1"}}}'
      )
    ),
    initialize_wrong_client_info = list(
      id = "initialize-wrong-client-info",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"initialize-wrong-client-info",',
        '"method":"initialize","params":{"protocolVersion":"2024-11-05",',
        '"capabilities":{},"clientInfo":"probe"}}'
      )
    )
  )
}

invalid_id_cases <- function() {
  list(
    fractional = '{"jsonrpc":"2.0","id":0.123456789,"method":"ping","params":{}}',
    boolean = '{"jsonrpc":"2.0","id":true,"method":"ping","params":{}}',
    compound_array = '{"jsonrpc":"2.0","id":[],"method":"ping","params":{}}',
    compound_object = '{"jsonrpc":"2.0","id":{"nested":1},"method":"ping","params":{}}',
    above_safe_integer = '{"jsonrpc":"2.0","id":9007199254740992,"method":"ping","params":{}}',
    beyond_safe_integer = '{"jsonrpc":"2.0","id":9007199254740993,"method":"ping","params":{}}',
    nonintegral_exponent = '{"jsonrpc":"2.0","id":1.5e0,"method":"ping","params":{}}'
  )
}

# Wire-level tools/call envelope cases. These intentionally use raw JSON so
# that `{}`, `[]`, null, scalar, and missing fields remain distinguishable.
tools_call_invalid_cases <- function() {
  list(
    missing_name = list(
      id = "tool-missing-name",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-missing-name","method":"tools/call",',
        '"params":{"arguments":{}}}'
      )
    ),
    null_name = list(
      id = "tool-null-name",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-null-name","method":"tools/call",',
        '"params":{"name":null,"arguments":{}}}'
      )
    ),
    scalar_name = list(
      id = "tool-scalar-name",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-scalar-name","method":"tools/call",',
        '"params":{"name":1,"arguments":{}}}'
      )
    ),
    array_name = list(
      id = "tool-array-name",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-array-name","method":"tools/call",',
        '"params":{"name":[],"arguments":{}}}'
      )
    ),
    empty_name = list(
      id = "tool-empty-name",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-empty-name","method":"tools/call",',
        '"params":{"name":"","arguments":{}}}'
      )
    ),
    unknown_name = list(
      id = "tool-unknown-name",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-unknown-name","method":"tools/call",',
        '"params":{"name":"not_a_real_tool","arguments":{}}}'
      )
    ),
    null_arguments = list(
      id = "tool-null-arguments",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-null-arguments","method":"tools/call",',
        '"params":{"name":"notebook_state","arguments":null}}'
      )
    ),
    scalar_arguments = list(
      id = "tool-scalar-arguments",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-scalar-arguments","method":"tools/call",',
        '"params":{"name":"notebook_state","arguments":false}}'
      )
    ),
    array_arguments = list(
      id = "tool-array-arguments",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-array-arguments","method":"tools/call",',
        '"params":{"name":"notebook_state","arguments":[]}}'
      )
    ),
    numeric_arguments = list(
      id = "tool-numeric-arguments",
      raw = paste0(
        '{"jsonrpc":"2.0","id":"tool-numeric-arguments","method":"tools/call",',
        '"params":{"name":"notebook_state","arguments":1}}'
      )
    )
  )
}

run_client <- function(kind, notebook, server = NULL) {
  target <- if (identical(kind, "local")) notebook else server$base
  client <- new_client(kind, target)
  check_start <- length(checks)
  before <- readBin(notebook, "raw", n = file.info(notebook)$size)
  marker <- paste0(notebook, ".started")

  record(paste0(kind, ".no-startup-before-first-frame"),
         !file.exists(marker) && client$process$is_alive(),
         list(marker = marker, alive = client$process$is_alive()),
         "no notebook code before the first frame")

  # The MCP lifecycle is deliberately probed before the handshake. Only ping
  # is available in the new phase; all other requests are protocol errors and
  # notifications must be silent and effect-free. In particular, an early
  # initialized notification and malformed initialize requests must not make
  # the connection ready.
  early_ping <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":"early-ping","method":"ping","params":{}}',
    "early-ping"
  )
  record(paste0(kind, ".pre-ready-ping-is-available"),
         same_rpc_id(early_ping$id, "early-ping") &&
           is.list(early_ping$result) && !length(early_ping$result) &&
           client$process$is_alive(), response_summary(early_ping),
         "successful ping with exact id echo")

  pre_ready_requests <- list(
    tools_list = '{"jsonrpc":"2.0","id":"pre-tools-list","method":"tools/list","params":{}}',
    resources_list = '{"jsonrpc":"2.0","id":"pre-resources-list","method":"resources/list","params":{}}',
    mutating_tool = paste0(
      '{"jsonrpc":"2.0","id":"pre-mutating-tool","method":"tools/call",',
      '"params":{"name":"add_cell","arguments":{"body":["y <- blocked"],',
      '"type":"code"}}}'
    )
  )
  pre_ready_ids <- c(
    tools_list = "pre-tools-list", resources_list = "pre-resources-list",
    mutating_tool = "pre-mutating-tool"
  )
  for (label in names(pre_ready_requests)) {
    response <- client$rpc_bytes(pre_ready_requests[[label]],
                                 paste0("pre-ready-", label))
    record(paste0(kind, ".pre-ready-request.", label),
           identical(as.integer(response$error$code %||% NA_integer_), -32600L) &&
             is.character(response$error$message %||% NULL) &&
             nzchar(response$error$message %||% "") &&
             same_rpc_id(response$id, pre_ready_ids[[label]]) &&
             client$process$is_alive(),
           response_summary(response),
           "-32600 deterministic not-ready error")
  }
  pre_ready_edit <- client$quiet_bytes(
    paste0(
      '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"edit_cell",',
      '"arguments":{"cell":"cell-1","body":["x <- pre-ready-notification"],',
      '"type":"code","expected_revision":0}}}'
    ),
    "pre-ready-mutating-notification"
  )
  record(paste0(kind, ".pre-ready-mutating-notification-is-silent"),
         isTRUE(pre_ready_edit$silent) && isTRUE(pre_ready_edit$alive_after),
         pre_ready_edit, "no response, no effect, and live process")
  early_initialized <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    "early-initialized-notification"
  )
  record(paste0(kind, ".early-initialized-notification-is-silent"),
         isTRUE(early_initialized$silent) && isTRUE(early_initialized$alive_after),
         early_initialized, "no response and no lifecycle advance")
  malformed_initializes <- list(
    incomplete = paste0(
      '{"jsonrpc":"2.0","id":"malformed-init-incomplete",',
      '"method":"initialize","params":{"protocolVersion":"2024-11-05",',
      '"capabilities":{}}}'
    ),
    wrong_protocol = paste0(
      '{"jsonrpc":"2.0","id":"malformed-init-protocol",',
      '"method":"initialize","params":{"protocolVersion":false,',
      '"capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
    ),
    wrong_capabilities = paste0(
      '{"jsonrpc":"2.0","id":"malformed-init-capabilities",',
      '"method":"initialize","params":{"protocolVersion":"2024-11-05",',
      '"capabilities":false,"clientInfo":{"name":"probe","version":"1"}}}'
    )
  )
  malformed_init_ids <- c(
    incomplete = "malformed-init-incomplete",
    wrong_protocol = "malformed-init-protocol",
    wrong_capabilities = "malformed-init-capabilities"
  )
  for (label in names(malformed_initializes)) {
    response <- client$rpc_bytes(malformed_initializes[[label]],
                                 paste0("malformed-initialize-", label))
    record(paste0(kind, ".malformed-initialize.", label),
           identical(as.integer(response$error$code %||% NA_integer_), -32602L) &&
             same_rpc_id(response$id, malformed_init_ids[[label]]) &&
             client$process$is_alive(), response_summary(response),
           "-32602 with exact id and connection alive")
  }
  malformed_initialized <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":false}',
    "malformed-initialized-notification"
  )
  record(paste0(kind, ".malformed-initialized-notification-is-silent"),
         isTRUE(malformed_initialized$silent) &&
           isTRUE(malformed_initialized$alive_after),
         malformed_initialized, "no response and no lifecycle advance")
  still_pre_ready <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":"still-pre-ready","method":"tools/list","params":{}}',
    "still-pre-ready"
  )
  record(paste0(kind, ".malformed-handshake-does-not-advance"),
         identical(as.integer(still_pre_ready$error$code %||% NA_integer_), -32600L) &&
           same_rpc_id(still_pre_ready$id, "still-pre-ready"),
         response_summary(still_pre_ready), "-32600 until valid initialize")

  initialize <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"initialize","method":"initialize","params":',
      '{"protocolVersion":"2024-11-05","capabilities":{},',
      '"clientInfo":{"name":"alder-mcp-framing-probe","version":"1"}}}'
    ),
    "initialize"
  )
  record(paste0(kind, ".initialize"),
         same_rpc_id(initialize$id, "initialize") &&
           identical(initialize$result$serverInfo$name, "alder"),
         response_summary(initialize), "alder serverInfo")

  # initialize is only half of the handshake. Requests remain blocked until
  # the client's initialized notification, while ping remains available.
  post_initialize_blocked <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":"awaiting-initialized","method":"tools/list","params":{}}',
    "awaiting-initialized"
  )
  record(paste0(kind, ".awaiting-initialized-request-is-blocked"),
         identical(as.integer(post_initialize_blocked$error$code %||% NA_integer_), -32600L) &&
           same_rpc_id(post_initialize_blocked$id, "awaiting-initialized"),
         response_summary(post_initialize_blocked), "-32600 before initialized")
  post_initialize_edit <- client$quiet_bytes(
    paste0(
      '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"edit_cell",',
      '"arguments":{"cell":"cell-1","body":["x <- awaiting-initialized"],',
      '"type":"code","expected_revision":0}}}'
    ),
    "awaiting-initialized-mutating-notification"
  )
  record(paste0(kind, ".awaiting-initialized-notification-is-silent"),
         isTRUE(post_initialize_edit$silent) &&
           isTRUE(post_initialize_edit$alive_after),
         post_initialize_edit, "no response and no effect")
  awaiting_ping <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":"awaiting-ping","method":"ping","params":{}}',
    "awaiting-ping"
  )
  record(paste0(kind, ".awaiting-initialized-ping-is-available"),
         same_rpc_id(awaiting_ping$id, "awaiting-ping") &&
           is.list(awaiting_ping$result) && !length(awaiting_ping$result),
         response_summary(awaiting_ping), "successful ping")

  initialized_notification <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    "initialized-notification"
  )
  record(paste0(kind, ".initialized-notification-is-silent"),
         isTRUE(initialized_notification$silent) &&
           isTRUE(initialized_notification$alive_after),
         initialized_notification, "no response and live process")
  record(paste0(kind, ".initialized-startup-policy-is-preserved"),
         !file.exists(marker),
         file.exists(marker), "run_on_startup=false remains effect-free")
  initial_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "initial-state"
  )
  initial_revision <- state_revision(initial_state)
  initial_payload <- payload(initial_state)
  initial_body <- initial_payload$cells[[1L]]$body %||% NULL
  record(paste0(kind, ".initial-state"),
         identical(initial_revision, 0L) &&
           length(initial_body) == 2L &&
           identical(initial_body[[2L]], "x <- 1L"),
         list(revision = initial_revision, body = initial_body),
         list(revision = 0L, body_tail = "x <- 1L"))
  initial_runtime <- initial_payload$runtime %||% list()
  record(paste0(kind, ".initial-runtime-policy"),
         identical(initial_runtime$execution_mode %||% NULL, "automatic") &&
           identical(initial_runtime$run_on_startup %||% NULL, FALSE),
         initial_runtime, list(execution_mode = "automatic", run_on_startup = FALSE))
  repeated_initialize <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"repeated-initialize","method":"initialize",',
      '"params":{"protocolVersion":"2024-11-05","capabilities":{},',
      '"clientInfo":{"name":"probe","version":"1"}}}'
    ),
    "repeated-initialize"
  )
  record(paste0(kind, ".repeated-initialize-is-rejected"),
         identical(as.integer(repeated_initialize$error$code %||% NA_integer_), -32600L) &&
           same_rpc_id(repeated_initialize$id, "repeated-initialize"),
         response_summary(repeated_initialize), "-32600 without lifecycle regression")
  invalid_param_notification <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"tools/call","params":false}',
    "invalid-param-notification"
  )
  record(paste0(kind, ".invalid-param-notification-is-silent"),
         isTRUE(invalid_param_notification$silent) &&
           isTRUE(invalid_param_notification$alive_after),
         invalid_param_notification, "no response, no effect, and live process")
  initialized_request_cases <- list(
    initialized_string_request =
      '{"jsonrpc":"2.0","id":"initialized-request","method":"notifications/initialized","params":{}}',
    initialized_integer_request =
      '{"jsonrpc":"2.0","id":37,"method":"notifications/initialized","params":{}}'
  )
  for (label in names(initialized_request_cases)) {
    response <- client$rpc_bytes(initialized_request_cases[[label]], label)
    record(paste0(kind, ".initialized-request.", label),
           identical(as.integer(response$error$code %||% NA_integer_), -32600L) &&
             identical(response$error$message %||% "", "invalid JSON-RPC request") &&
             "id" %in% names(response) &&
             same_rpc_id(response$id, if (grepl("string", label)) {
               "initialized-request"
             } else {
               37L
             }),
           response_summary(response),
           "-32600 with the exact accepted request id")
  }
  tool_cases <- tools_call_invalid_cases()
  for (label in names(tool_cases)) {
    tool_case <- tool_cases[[label]]
    response <- client$rpc_bytes(tool_case$raw,
                                 paste0("invalid-tool-call-", label))
    record(paste0(kind, ".invalid-tools-call-request.", label),
           identical(as.integer(response$error$code %||% NA_integer_), -32602L) &&
             same_rpc_id(response$id, tool_case$id) &&
             !isTRUE(response$result$isError) && client$process$is_alive(),
           response_summary(response), "-32602 with exact id and no result error")
  }
  invalid_tool_notifications <- list()
  for (label in names(tool_cases)) {
    tool_case <- tool_cases[[label]]
    notification <- gsub(
      paste0(',"id":"', tool_case$id, '"'), "", tool_case$raw,
      fixed = TRUE
    )
    invalid_tool_notifications[[label]] <- client$quiet_bytes(
      notification, paste0("invalid-tool-call-notification-", label)
    )
    observation <- invalid_tool_notifications[[label]]
    record(paste0(kind, ".invalid-tools-call-notification.", label),
           isTRUE(observation$silent) && isTRUE(observation$alive_after),
           observation, "silent, effect-free notification")
  }
  invalid_tool_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "state-after-invalid-tools-call-matrix"
  )
  record(paste0(kind, ".invalid-tools-call-matrix-does-not-mutate"),
         identical(state_revision(invalid_tool_state), initial_revision),
         state_revision(invalid_tool_state), "unchanged revision")
  valid_execution_error <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"valid-execution-error",',
      '"method":"tools/call","params":{"name":"read_cell",',
      '"arguments":{"cell":"missing-cell"}}}'
    ),
    "valid-execution-error"
  )
  record(paste0(kind, ".valid-execution-error-is-result-level"),
         same_rpc_id(valid_execution_error$id, "valid-execution-error") &&
           isTRUE(valid_execution_error$result$isError) &&
           is.null(valid_execution_error$error),
         response_summary(valid_execution_error),
         "successful tools/call envelope with result.isError")
  initialized_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "state-after-initialized-cases"
  )
  record(paste0(kind, ".initialized-cases-do-not-mutate"),
         identical(state_revision(initialized_state), initial_revision),
         state_revision(initialized_state), "unchanged revision")

  client$notify(
    "tools/call", list(name = "edit_cell", arguments = list(
      cell = "cell-1", body = list("x <- notification"), type = "code",
      expected_revision = initial_revision
    )), "edit-notification"
  )
  notification_state_id <- client$next_id
  notification_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "state-after-notification"
  )
  notification_payload <- payload(notification_state)
  notification_revision <- state_revision(notification_state)
  record(paste0(kind, ".notification-executes-without-response"),
         same_rpc_id(notification_state$id, notification_state_id) &&
           identical(notification_revision, initial_revision + 1L) &&
           identical(notification_payload$cells[[1L]]$body,
                     list("x <- notification")),
         list(response_id = notification_state$id,
              revision = notification_revision,
              body = notification_payload$cells[[1L]]$body),
         list(response_id = notification_state_id,
              revision = initial_revision + 1L,
              body = list("x <- notification")))
  initial_revision <- notification_revision

  null_id_response <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":null,"method":"ping","params":{}}',
    "explicit-null-id"
  )
  record(paste0(kind, ".explicit-null-id-is-rejected"),
         identical(as.integer(null_id_response$error$code %||% NA_integer_), -32600L) &&
           identical(null_id_response$error$message %||% "", "invalid JSON-RPC request") &&
           "id" %in% names(null_id_response) && is.null(null_id_response$id) &&
           client$process$is_alive(),
         response_summary(null_id_response), "-32600 with null id")

  exact_frame <- make_oversize(mcp_limit)
  exact_response <- client$rpc_bytes(exact_frame, "exactly-at-cap", timeout = 90)
  exact_summary <- client$responses[[length(client$responses)]]
  exact_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "exactly-at-cap-state"
  )
  record(paste0(kind, ".accepts-exactly-at-cap"),
         identical(exact_response$id, 99L) &&
           is.list(exact_response$result) && !length(exact_response$result) &&
           isTRUE(exact_summary$alive_after_response) &&
           exact_summary$elapsed_seconds <= 30 &&
           identical(state_revision(exact_state), initial_revision),
         list(bytes = length(exact_frame),
              elapsed_seconds = exact_summary$elapsed_seconds,
              response = response_summary(exact_response)),
         list(bytes = mcp_limit, max_seconds = 30,
              unchanged_revision = initial_revision))
  peak_after_exact <- peak_rss_kb(client$process$get_pid())
  observe(paste0(kind, ".peak-rss-after-exact-kb"), peak_after_exact)

  accepted_ids <- accepted_id_cases()
  for (label in names(accepted_ids)) {
    id_case <- accepted_ids[[label]]
    response <- client$rpc_bytes(
      paste0('{"jsonrpc":"2.0","id":', id_case$raw,
             ',"method":"ping","params":{}}'),
      paste0("accepted-id-", label)
    )
    record(paste0(kind, ".accepted-id.", label),
           "id" %in% names(response) &&
             same_rpc_id(response$id, id_case$expected) &&
             is.list(response$result) && !length(response$result) &&
             client$process$is_alive(),
           response_summary(response), "successful ping with exact id echo")
  }
  accepted_id_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "state-after-accepted-ids"
  )
  record(paste0(kind, ".accepted-ids-do-not-mutate"),
         identical(state_revision(accepted_id_state), initial_revision),
         state_revision(accepted_id_state), "unchanged revision")

  for (label in names(invalid_id_cases())) {
    response <- client$rpc_bytes(invalid_id_cases()[[label]],
                                 paste0("invalid-id-", label))
    record(paste0(kind, ".invalid-id.", label),
           identical(as.integer(response$error$code %||% NA_integer_), -32600L) &&
             identical(response$error$message %||% "", "invalid JSON-RPC request") &&
             "id" %in% names(response) && is.null(response$id) &&
             client$process$is_alive(),
           response_summary(response), "-32600 with null id")
    state_after <- client$rpc(
      "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
      paste0("invalid-id-", label, "-state")
    )
    record(paste0(kind, ".invalid-id-does-not-mutate.", label),
           identical(state_revision(state_after), initial_revision),
           state_revision(state_after), "unchanged revision")
  }

  for (label in names(invalid_param_cases())) {
    param_case <- invalid_param_cases()[[label]]
    response <- client$rpc_bytes(param_case$raw, paste0("invalid-param-", label))
    expected_code <- if (startsWith(label, "initialize_")) -32600L else -32602L
    expected_message <- if (startsWith(label, "initialize_")) {
      "server already initialized"
    } else if (identical(label, "ping_array")) {
      "params must be an object"
    } else {
      "params must be an object or array"
    }
    record(paste0(kind, ".invalid-params.", label),
           identical(as.integer(response$error$code %||% NA_integer_), expected_code) &&
             identical(response$error$message %||% "", expected_message) &&
             "id" %in% names(response) &&
             same_rpc_id(response$id, param_case$id) &&
             client$process$is_alive(),
           response_summary(response),
           list(error_code = expected_code, error_message = expected_message,
                id = param_case$id))
    state_after <- client$rpc(
      "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
      paste0("invalid-param-", label, "-state")
    )
    record(paste0(kind, ".invalid-params-do-not-mutate.", label),
           identical(state_revision(state_after), initial_revision),
           state_revision(state_after), "unchanged revision")
  }
  survival_ping <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":"ping-after-invalid","method":"ping","params":{}}',
    "ping-after-invalid-matrix"
  )
  record(paste0(kind, ".ping-survives-invalid-matrix"),
         "id" %in% names(survival_ping) &&
           same_rpc_id(survival_ping$id, "ping-after-invalid") &&
           is.list(survival_ping$result) && !length(survival_ping$result) &&
           client$process$is_alive(),
         response_summary(survival_ping), "valid ping remains available")

  cases <- framing_cases()
  expected_codes <- c(
    duplicate_revision_current_then_stale = -32600L,
    duplicate_revision_stale_then_current = -32600L,
    duplicate_params_name = -32600L,
    duplicate_nested_edit_body = -32600L,
    duplicate_nested_widget_value = -32600L,
    duplicate_envelope_method = -32600L,
    duplicate_escaped_name = -32600L,
    duplicate_inside_array_object = -32600L,
    invalid_boolean_id = -32600L,
    malformed_json = -32700L,
    embedded_nul = -32700L,
    invalid_utf8 = -32700L,
    non_object_root = -32600L,
    structural_flood = -32600L,
    one_byte_over_cap = -32600L,
    four_times_cap_plus_one = -32600L
  )
  expected_messages <- c(
    duplicate_revision_current_then_stale = "invalid JSON-RPC request",
    duplicate_revision_stale_then_current = "invalid JSON-RPC request",
    duplicate_params_name = "invalid JSON-RPC request",
    duplicate_nested_edit_body = "invalid JSON-RPC request",
    duplicate_nested_widget_value = "invalid JSON-RPC request",
    duplicate_envelope_method = "invalid JSON-RPC request",
    duplicate_escaped_name = "invalid JSON-RPC request",
    duplicate_inside_array_object = "invalid JSON-RPC request",
    invalid_boolean_id = "invalid JSON-RPC request",
    malformed_json = "parse error",
    embedded_nul = "parse error",
    invalid_utf8 = "parse error",
    non_object_root = "invalid JSON-RPC request",
    structural_flood = "invalid JSON-RPC request",
    one_byte_over_cap = "invalid JSON-RPC request",
    four_times_cap_plus_one = "invalid JSON-RPC request"
  )
  expected_ids <- list(
    duplicate_revision_current_then_stale = 11L,
    duplicate_revision_stale_then_current = 12L,
    duplicate_params_name = 13L,
    duplicate_nested_edit_body = 14L,
    duplicate_nested_widget_value = 15L,
    duplicate_envelope_method = 16L,
    duplicate_escaped_name = 17L,
    duplicate_inside_array_object = 18L,
    invalid_boolean_id = NULL,
    malformed_json = NULL,
    embedded_nul = NULL,
    invalid_utf8 = NULL,
    non_object_root = NULL,
    structural_flood = NULL,
    one_byte_over_cap = NULL,
    four_times_cap_plus_one = NULL
  )
  for (label in names(cases)) {
    frame <- cases[[label]]
    response <- client$rpc_bytes(frame, label, timeout = 90)
    summary <- client$responses[[length(client$responses)]]
    actual_code <- response$error$code %||% NA_integer_
    actual_message <- response$error$message %||% ""
    response_has_id <- "id" %in% names(response)
    id_matches <- response_has_id &&
      identical(response[["id"]], expected_ids[[label]])
    state_after <- client$rpc(
      "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
      paste0(label, "-state")
    )
    record(paste0(kind, ".reject.", label),
           identical(as.integer(actual_code), expected_codes[[label]]) &&
             identical(actual_message, expected_messages[[label]]) &&
             id_matches && summary$elapsed_seconds <= 30 &&
             isTRUE(summary$alive_after_response) &&
             identical(state_revision(state_after), initial_revision),
           list(error_code = actual_code, error_message = actual_message,
                response_id = response[["id"]], bytes = length(frame),
                elapsed_seconds = summary$elapsed_seconds),
           list(error_code = expected_codes[[label]],
                error_message = expected_messages[[label]],
                response_id = expected_ids[[label]], max_seconds = 30,
                unchanged_revision = initial_revision))
  }

  peak_after_rejections <- peak_rss_kb(client$process$get_pid())
  observe(paste0(kind, ".peak-rss-after-rejections-kb"),
          peak_after_rejections)
  record(paste0(kind, ".peak-rss-bounded"),
         is.finite(peak_after_exact) && is.finite(peak_after_rejections) &&
           peak_after_exact <= 512L * 1024L &&
           peak_after_rejections <= 512L * 1024L,
         list(after_exact_kb = peak_after_exact,
              after_rejections_kb = peak_after_rejections),
         "both MCP parent peaks <= 512 MiB")

  valid_after <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "valid-after-rejections"
  )
  valid_payload <- payload(valid_after)
  record(paste0(kind, ".valid-after-rejections-before-eof"),
         !isTRUE(valid_after$result$isError) &&
           identical(state_revision(valid_after), initial_revision) &&
           client$process$is_alive(),
         response_summary(valid_after), "successful state while stdin open")
  after <- readBin(notebook, "raw", n = file.info(notebook)$size)
  record(paste0(kind, ".rejects-no-source-write"), identical(before, after),
         length(after), "source bytes unchanged")
  observe(paste0(kind, ".pid"), client$process$get_pid())
  observe(paste0(kind, ".descendants"), descendants(client$process$get_pid()))
  close_result <- close_client(client)
  record(paste0(kind, ".shutdown-clean"), identical(close_result$status, 0L) &&
           !length(close_result$alive), close_result, "exit 0/no live PID")
  record(paste0(kind, ".stderr-clean"),
         !length(close_result$stderr[nzchar(trimws(close_result$stderr))]),
         close_result$stderr, "empty stderr")
  observe(paste0(kind, ".wire-counts"), list(
    responses = length(client$responses),
    notifications = sum(vapply(client$requests, function(item) {
      isTRUE(item$notification)
    }, logical(1L))),
    requests = length(client$requests),
    checks = length(checks) - check_start
  ))
  actual_notifications <- sum(vapply(client$requests, function(item) {
    isTRUE(item$notification)
  }, logical(1L)))
  actual_checks <- length(checks) - check_start
  if (!identical(length(client$responses), expected_responses_per_transport) ||
      !identical(actual_notifications, expected_notifications_per_transport) ||
      !identical(length(client$requests), expected_requests_per_transport) ||
      !identical(actual_checks, expected_checks_per_transport)) {
    stop(
      kind, " MCP wire accounting mismatch: responses=", length(client$responses),
      "/", expected_responses_per_transport,
      " notifications=", actual_notifications, "/", expected_notifications_per_transport,
      " requests=", length(client$requests), "/", expected_requests_per_transport,
      " checks=", actual_checks, "/", expected_checks_per_transport,
      call. = FALSE
    )
  }
  list(kind = kind, initial_revision = initial_revision,
       valid_payload = valid_payload, close = close_result,
       requests = client$requests, responses = client$responses,
       stderr = client$stderr)
}

# B-122: local MCP must retain the notebook's configured execution mode and
# startup policy, while matching the URL-backed server after the same lifecycle
# handshake.  URL startup is intentionally allowed before its first MCP frame;
# local startup is not.  Both backends must report the same settled runtime
# state, with no duplicate startup after repeated initialized notifications.
run_policy_client <- function(kind, notebook, server, execution_mode,
                               run_on_startup, marker) {
  target <- if (identical(kind, "local")) notebook else server$base
  client <- new_client(kind, target)
  check_start <- length(checks)
  before_marker <- file.exists(marker)
  expected_before <- if (identical(kind, "local")) FALSE else run_on_startup
  record(paste0(kind, ".policy.pre-frame-marker"),
         identical(before_marker, expected_before) && client$process$is_alive(),
         list(marker_exists = before_marker, expected = expected_before),
         "local is effect-free before first frame")
  started <- proc.time()[["elapsed"]]
  ping <- client$rpc_bytes(
    '{"jsonrpc":"2.0","id":"policy-ping","method":"ping","params":{}}',
    "policy-ping", timeout = 10
  )
  elapsed <- proc.time()[["elapsed"]] - started
  record(paste0(kind, ".policy.pre-ready-ping-bounded"),
         same_rpc_id(ping$id, "policy-ping") &&
           is.list(ping$result) && !length(ping$result) && elapsed < 5,
         list(elapsed_seconds = elapsed, response = response_summary(ping)),
         "successful ping in under five seconds (startup must not block it)")
  initialize <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"policy-initialize","method":"initialize",',
      '"params":{"protocolVersion":"2024-11-05","capabilities":{},',
      '"clientInfo":{"name":"alder-policy-probe","version":"1"}}}'
    ),
    "policy-initialize"
  )
  record(paste0(kind, ".policy-initialize"),
         same_rpc_id(initialize$id, "policy-initialize") &&
           identical(initialize$result$serverInfo$name, "alder"),
         response_summary(initialize), "valid initialize response")
  initialized <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    "policy-initialized"
  )
  state_response <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "policy-state"
  )
  state <- payload(state_response)
  runtime <- state$runtime %||% list()
  expected_status <- if (isTRUE(run_on_startup)) "done" else "idle"
  record(paste0(kind, ".policy-post-ready-state"),
         isTRUE(initialized$silent) &&
           identical(runtime$execution_mode %||% NULL, execution_mode) &&
           identical(runtime$run_on_startup %||% NULL, run_on_startup) &&
           identical(state$cells[[1L]]$status %||% NULL, expected_status) &&
           identical(marker_count(marker), if (run_on_startup) 1L else 0L),
         list(runtime = runtime, status = state$cells[[1L]]$status %||% NULL,
              marker_count = marker_count(marker)),
         list(execution_mode = execution_mode, run_on_startup = run_on_startup,
              status = expected_status,
              marker_count = if (run_on_startup) 1L else 0L))
  repeat_initialized <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    "policy-repeated-initialized"
  )
  repeated_state <- client$rpc(
    "tools/call", list(name = "notebook_state", arguments = mcp_empty_object()),
    "policy-repeated-state"
  )
  repeated <- payload(repeated_state)
  record(paste0(kind, ".policy-repeated-initialized-no-rerun"),
         isTRUE(repeat_initialized$silent) &&
           identical(state_revision(repeated_state), state_revision(state_response)) &&
           identical(marker_count(marker), if (run_on_startup) 1L else 0L) &&
           identical(repeated$runtime$execution_mode %||% NULL, execution_mode),
         list(revision = state_revision(repeated_state),
              marker_count = marker_count(marker)),
         "settled state and exactly one startup execution remain unchanged")
  close_result <- close_client(client)
  record(paste0(kind, ".policy-shutdown-clean"),
         identical(close_result$status, 0L) && !length(close_result$alive),
         close_result, "exit 0/no live PID")
  actual <- length(checks) - check_start
  if (!identical(actual, 6L)) {
    stop(kind, " policy check accounting mismatch: expected 6, received ", actual,
         call. = FALSE)
  }
  invisible(list(runtime = runtime, state = state, marker = marker_count(marker)))
}

local_mcp_process <- function(notebook) {
  expression <- paste0(
    ".libPaths(c(Sys.getenv('ALDER_MCP_FRAMING_LIB'), .libPaths())); ",
    "suppressPackageStartupMessages(library(alder, lib.loc=Sys.getenv('",
    "ALDER_MCP_FRAMING_LIB'))); ",
    "alder::alder_mcp(path=Sys.getenv('ALDER_MCP_FRAMING_TARGET'))"
  )
  register_process(processx::process$new(
    file.path(R.home("bin"), "Rscript"), c("--vanilla", "-e", expression),
    env = environment_for(c(ALDER_MCP_FRAMING_LIB = private_lib,
                             ALDER_MCP_FRAMING_TARGET = notebook)),
    stdin = "|", stdout = "|", stderr = "|", cleanup_tree = TRUE
  ))
}

# A clean EOF before any frame must not trigger configured startup or emit an
# error. This is a separate process because the normal client deliberately
# keeps stdin open while it exercises the full wire matrix.
run_early_eof <- function() {
  notebook <- tempfile("alder-b122-early-eof-", fileext = ".R")
  marker <- paste0(notebook, ".started")
  writeLines(c(
    "# ---", "# runtime:", "#   execution_mode: automatic",
    "#   run_on_startup: true", "# ---", "# %%",
    paste0("writeLines('started', ", encodeString(marker, quote = "'"), ")")
  ), notebook, useBytes = TRUE)
  on.exit(unlink(c(notebook, marker), force = TRUE), add = TRUE)
  child <- local_mcp_process(notebook)
  processx::processx_conn_close(child$get_input_connection())
  deadline <- Sys.time() + 30
  while (child$is_alive() && Sys.time() < deadline) Sys.sleep(0.02)
  if (child$is_alive()) try(child$kill_tree(), silent = TRUE)
  try(child$wait(5000), silent = TRUE)
  stderr <- child$read_error_lines()
  status <- tryCatch(child$get_exit_status(), error = function(e) NA_integer_)
  record("local.early-eof-no-startup-marker", !file.exists(marker),
         file.exists(marker), "no code before a valid frame")
  record("local.early-eof-clean-exit", identical(status, 0L),
         status, "exit status 0")
  record("local.early-eof-clean-stderr",
         !length(stderr[nzchar(trimws(stderr))]), stderr, "empty stderr")
}

# A malformed handshake and an early initialized notification must remain
# effect-free even when startup is enabled. Close stdin afterward to exercise
# the abandoned-negotiation cleanup path without granting readiness.
run_failed_negotiation <- function() {
  notebook <- tempfile("alder-b122-failed-negotiation-", fileext = ".R")
  marker <- paste0(notebook, ".started")
  writeLines(c(
    "# ---", "# runtime:", "#   execution_mode: automatic",
    "#   run_on_startup: true", "# ---", "# %%",
    paste0("writeLines('started', ", encodeString(marker, quote = "'"), ")")
  ), notebook, useBytes = TRUE)
  on.exit(unlink(c(notebook, marker), force = TRUE), add = TRUE)
  client <- new_client("local", notebook)
  record("local.failed-negotiation-pre-frame-no-marker",
         !file.exists(marker) && client$process$is_alive(),
         list(marker = marker, alive = client$process$is_alive()),
         "startup-enabled local context remains effect-free")
  malformed <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"failed-init","method":"initialize",',
      '"params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
    ),
    "failed-initialize"
  )
  record("local.failed-negotiation-malformed-initialize",
         identical(as.integer(malformed$error$code %||% NA_integer_), -32602L) &&
           same_rpc_id(malformed$id, "failed-init") && client$process$is_alive(),
         response_summary(malformed), "-32602 with exact id")
  early <- client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    "failed-early-initialized"
  )
  record("local.failed-negotiation-early-notification-silent",
         isTRUE(early$silent) && isTRUE(early$alive_after),
         early, "no lifecycle advance or response")
  processx::processx_conn_close(client$process$get_input_connection())
  deadline <- Sys.time() + 10
  while (client$process$is_alive() && Sys.time() < deadline) Sys.sleep(0.02)
  if (client$process$is_alive()) try(client$process$kill_tree(), silent = TRUE)
  try(client$process$wait(5000), silent = TRUE)
  stderr <- client$process$read_error_lines()
  status <- tryCatch(client$process$get_exit_status(), error = function(e) NA_integer_)
  record("local.failed-negotiation-no-startup-marker", marker_count(marker) == 0L,
         marker_count(marker), "no startup effect after failed negotiation")
  record("local.failed-negotiation-clean-close",
         identical(status, 0L) && !client$process$is_alive() &&
           !length(stderr[nzchar(trimws(stderr))]),
         list(status = status, stderr = stderr), "exit 0 and empty stderr")
}

# An ordinary startup cell error remains inspectable in notebook state. It must
# retain the complete condition and allow revision-aware editing and recovery;
# protocol-level startup errors are reserved for failures to settle the run.
run_startup_failure <- function() {
  notebook <- tempfile("alder-b122-startup-failure-", fileext = ".R")
  marker <- paste0(notebook, ".started")
  writeLines(c(
    "# ---", "# runtime:", "#   execution_mode: automatic",
    "#   run_on_startup: true", "# ---", "# %%",
    paste0("count <- if (file.exists(", encodeString(marker, quote = "'"),
           ")) as.integer(readLines(", encodeString(marker, quote = "'"),
           ")) else 0L"),
    paste0("writeLines(as.character(count + 1L), ",
           encodeString(marker, quote = "'"), ")"),
    "Sys.sleep(0.25)",
    "stop('B-122 intentional startup failure')"
  ), notebook, useBytes = TRUE)
  on.exit(unlink(c(notebook, marker), force = TRUE), add = TRUE)
  client <- new_client("local", notebook)
  record("local.startup-failure-pre-frame-no-marker",
         !file.exists(marker) && client$process$is_alive(),
         list(marker = marker, alive = client$process$is_alive()),
         "startup is deferred until readiness")
  initialize <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"failure-init","method":"initialize",',
      '"params":{"protocolVersion":"2024-11-05","capabilities":{},',
      '"clientInfo":{"name":"alder-startup-failure","version":"1"}}}'
    ),
    "startup-failure-initialize"
  )
  client$quiet_bytes(
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    "startup-failure-initialized"
  )
  failed <- client$rpc_bytes(
    paste0(
      '{"jsonrpc":"2.0","id":"startup-failure-state",',
      '"method":"tools/call","params":{"name":"notebook_state",',
      '"arguments":{}}}'
    ),
    "startup-failure-state"
  )
  failed_summary <- client$responses[[length(client$responses)]]
  failed_state <- payload(failed)
  failed_cell <- (failed_state$cells %||% list(list()))[[1L]]
  condition <- failed_cell$error %||% list()
  record("local.startup-failure-classified",
         same_rpc_id(initialize$id, "failure-init") &&
           identical(initialize$result$serverInfo$name, "alder") &&
           same_rpc_id(failed$id, "startup-failure-state") &&
           is.null(failed$error) && !isTRUE(failed$result$isError) &&
           isTRUE(failed_state$ok) &&
           identical(failed_cell$status, "error") &&
           identical(condition$message, "B-122 intentional startup failure") &&
           identical(unlist(condition$class), c("simpleError", "error", "condition")) &&
           is.character(condition$call) && length(condition$call) == 1L &&
           nzchar(condition$call) &&
           any(grepl('stop("B-122 intentional startup failure")',
                     unlist(condition$trace), fixed = TRUE)) &&
           !isTRUE(failed_state$runtime$busy) &&
           isTRUE(failed_state$runtime$worker_available) &&
           failed_summary$elapsed_seconds < 10,
         list(response = response_summary(failed),
              cell = failed_cell, runtime = failed_state$runtime,
              elapsed_seconds = failed_summary$elapsed_seconds),
         "settled state retains the full ordinary cell error within ten seconds")
  record("local.startup-failure-executed-once", marker_count(marker) == 1L,
         marker_count(marker), "startup marker count is exactly one")

  recovery_body <- list("recovered <- 42L", "recovered")
  edited <- client$rpc("tools/call", list(name = "edit_cell", arguments = list(
    cell = failed_cell$id, body = recovery_body, type = "code",
    expected_revision = failed_cell$revision
  )), "startup-failure-edit")
  rerun <- client$rpc("tools/call", list(name = "run_cell", arguments = list(
    cell = failed_cell$id
  )), "startup-failure-rerun")
  recovered <- client$rpc("tools/call", list(name = "notebook_state",
    arguments = mcp_empty_object()), "startup-failure-recovered-state")
  inspected <- client$rpc("tools/call", list(name = "get_value",
    arguments = list(name = "recovered")), "startup-failure-recovered-value")
  recovered_state <- payload(recovered)
  recovered_cell <- (recovered_state$cells %||% list(list()))[[1L]]
  record("local.startup-failure-recovery",
         all(vapply(list(edited, rerun, recovered, inspected), function(response) {
           is.null(response$error) && !isTRUE(response$result$isError) &&
             isTRUE(payload(response)$ok) &&
             length(response$result$content %||% list()) > 0L
         }, logical(1L))) &&
           identical(as.integer(recovered_cell$revision),
                     as.integer(failed_cell$revision) + 1L) &&
           identical(unlist(recovered_cell$body), unlist(recovery_body)) &&
           identical(recovered_cell$status, "done") &&
           is.null(recovered_cell$error) &&
           is.null(recovered_state$last_action_error) &&
           !isTRUE(recovered_state$runtime$busy) &&
           isTRUE(recovered_state$runtime$worker_available) &&
           identical(payload(inspected)$value$text, "[1] 42") &&
           marker_count(marker) == 1L,
         list(edit = payload(edited), run = payload(rerun),
              state = recovered_state, value = payload(inspected),
              marker_count = marker_count(marker)),
         "revision-aware edit, run and fresh value inspection recover to 42")
  close_result <- close_client(client)
  record("local.startup-failure-clean-close",
         identical(close_result$status, 0L) && !length(close_result$alive) &&
           !length(close_result$stderr[nzchar(trimws(close_result$stderr))]),
         close_result, "exit 0, no live PID, empty stderr")
}

local_notebook <- source_fixture("local")
url_notebook <- source_fixture("url")
on.exit(unlink(c(local_notebook, url_notebook,
                 paste0(c(local_notebook, url_notebook), ".started")),
               force = TRUE), add = TRUE)

local_result <- run_client("local", local_notebook)
startup_observer$local_checkpoint(local_result)
server <- NULL
server_cleanup <- NULL
url_result <- NULL
tryCatch({
  server <- start_server(url_notebook)
  observe("loopback-port", server$port)
  observe("server-pid", server$process$get_pid())
  url_result <- run_client("url", url_notebook, server)
}, finally = {
  server_cleanup <<- stop_server(server)
})
record("loopback-server-cleanup",
       !is.null(server_cleanup) && identical(server_cleanup$status, 0L) &&
         !length(server_cleanup$alive) && !isTRUE(server_cleanup$port_open),
       server_cleanup, "exit 0/no descendants/closed port")

policy_notebooks <- character()
on.exit({
  unlink(c(policy_notebooks, paste0(policy_notebooks, ".started")),
         force = TRUE)
}, add = TRUE)
policies <- expand.grid(
  execution_mode = c("automatic", "lazy"),
  run_on_startup = c(FALSE, TRUE),
  stringsAsFactors = FALSE
)
for (index in seq_len(nrow(policies))) {
  policy <- policies[index, , drop = FALSE]
  write_policy_notebook <- function(prefix) {
    notebook <- tempfile(prefix, fileext = ".R")
    marker <- paste0(notebook, ".started")
    writeLines(c(
      "# ---", "# runtime:",
      paste0("#   execution_mode: ", policy$execution_mode),
      paste0("#   run_on_startup: ", tolower(policy$run_on_startup)),
      "# ---", "# %%",
      paste0("count <- if (file.exists(", encodeString(marker, quote = "'"),
             ")) as.integer(readLines(", encodeString(marker, quote = "'"),
             ")) else 0L"),
      paste0("writeLines(as.character(count + 1L), ",
             encodeString(marker, quote = "'"), ")"),
      "x <- 1L"
    ), notebook, useBytes = TRUE)
    list(notebook = notebook, marker = marker)
  }
  local_fixture <- write_policy_notebook("alder-b122-local-policy-")
  url_fixture <- write_policy_notebook("alder-b122-url-policy-")
  policy_notebooks <- c(policy_notebooks, local_fixture$notebook,
                        url_fixture$notebook)
  local_policy <- run_policy_client(
    "local", local_fixture$notebook, NULL, policy$execution_mode,
    policy$run_on_startup, local_fixture$marker
  )
  server_policy <- NULL
  url_policy <- NULL
  tryCatch({
    server_policy <- start_server(url_fixture$notebook)
    url_policy <- run_policy_client(
      "url", url_fixture$notebook, server_policy, policy$execution_mode,
      policy$run_on_startup, url_fixture$marker
    )
  }, finally = {
    stop_server(server_policy)
  })
  record(paste0("policy.", policy$execution_mode, ".",
                tolower(policy$run_on_startup), ".local-url-state-parity"),
         identical(local_policy$runtime, url_policy$runtime) &&
           identical(local_policy$state$cells[[1L]]$status,
                     url_policy$state$cells[[1L]]$status) &&
           identical(local_policy$marker, url_policy$marker),
         list(local = local_policy, url = url_policy),
         "same settled runtime, cell status, and startup effect")
}
run_failed_negotiation()
run_startup_failure()
run_early_eof()

response_codes <- function(result) {
  labels <- vapply(result$responses, `[[`, "", "label")
  selected <- grepl(
    paste0(
      "^(pre-ready-.*|malformed-initialize-.*|still-pre-ready|",
      "awaiting-initialized|repeated-initialize|initialized_(string|integer)_request|",
      "invalid-tool-call-.*|invalid-id-.*|",
      "invalid-param-.*|explicit-null-id|duplicate_.*|malformed_json|embedded_nul|",
      "invalid_boolean_id|non_object_root|structural_flood|one_byte_over_cap|",
      "four_times_cap_plus_one)$"
    ),
    labels
  )
  vapply(result$responses[selected], function(item) {
    as.integer(item$response$error_code %||% NA_integer_)
  }, integer(1L))
}
local_rejections <- response_codes(local_result)
url_rejections <- response_codes(url_result)
record("local-url-rejection-parity", identical(local_rejections, url_rejections),
       list(local = local_rejections, url = url_rejections),
       "same error codes/order")
record("local-url-valid-request-parity",
       identical(local_result$initial_revision, url_result$initial_revision) &&
         identical(local_result$valid_payload$runtime$busy,
                   url_result$valid_payload$runtime$busy),
       list(local_revision = local_result$initial_revision,
            url_revision = url_result$initial_revision),
       "same valid post-rejection state contract")

loopback_port <- vapply(observations, function(item) {
  identical(item$id, "loopback-port")
}, logical(1L))
loopback_port <- if (any(loopback_port)) {
  observations[[which(loopback_port)[[1L]]]]$value
} else {
  NULL
}
write_json(checks, file.path(evidence, "checks.json"))
write_json(list(
  artifact = artifact, artifact_sha256 = observed_sha,
  private_library = private_lib, audit_root = audit_root,
  started_unix = started, finished_unix = as.numeric(Sys.time()),
  loopback_port = loopback_port, observations = observations,
  local = local_result, url = url_result
), file.path(evidence, "evidence.json"))
write_json(list(local = local_result$responses, url = url_result$responses),
           file.path(evidence, "responses-summary.json"))
writeLines(c(local_result$stderr, url_result$stderr),
           file.path(evidence, "stderr.log"), useBytes = TRUE)

cat("SUMMARY checks=", length(checks), " expected=", expected_total_checks,
    " failures=", length(failures),
    " artifact_sha256=", observed_sha, "\n", sep = "")
# Preserve the actual failed records and wire observations even if accounting
# is wrong; the guard remains fatal after the evidence is durable.
if (!identical(length(checks), expected_total_checks)) {
  stop("MCP framing check accounting mismatch: expected ",
       expected_total_checks, ", received ", length(checks), call. = FALSE)
}
if (length(failures)) {
  cat("FAILED ", paste(failures, collapse = " | "), "\n", sep = "")
  quit(save = "no", status = 1L, runLast = FALSE)
}
startup_observer$require_clean()
cat("B-109--B-122 MCP BOUNDARY PROBE COMPLETE\n")
