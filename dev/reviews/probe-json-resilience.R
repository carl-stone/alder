#!/usr/bin/env Rscript

# Installed-artifact B-102 resilience probe.
#
# This deliberately calls only the installed namespace.  The request fixture
# matches the browser's file widget upload shape:
#   {"name":"files","files":[{"name":"...","content_base64":"..."}]}

options(warn = 2)

required_env <- function(name) {
  value <- Sys.getenv(name, unset = "")
  if (!nzchar(value)) stop(name, " is required")
  value
}

artifact <- normalizePath(required_env("ALDER_JSON_RESILIENCE_ARTIFACT"),
                          mustWork = TRUE)
private_lib <- normalizePath(required_env("ALDER_JSON_RESILIENCE_LIB"),
                             mustWork = TRUE)
expected_sha <- required_env("ALDER_JSON_RESILIENCE_SHA256")
if (!grepl("^[[:xdigit:]]{64}$", expected_sha)) {
  stop("ALDER_JSON_RESILIENCE_SHA256 must be a 64-character SHA-256 digest")
}

sha_line <- system2("sha256sum", artifact, stdout = TRUE, stderr = TRUE)
if (length(sha_line) != 1L) stop("could not read artifact SHA-256")
observed_sha <- strsplit(sha_line[[1L]], "[[:space:]]+")[[1L]][[1L]]
if (!identical(tolower(observed_sha), tolower(expected_sha))) {
  stop("artifact SHA-256 mismatch: expected ", expected_sha,
       ", received ", observed_sha)
}

installed_dir <- normalizePath(file.path(private_lib, "alder"), mustWork = TRUE)
if (!file.exists(file.path(installed_dir, "DESCRIPTION"))) {
  stop("private library does not contain an installed Alder package")
}

cat("B-102 installed JSON resilience probe\n")
cat("artifact=", artifact, "\n", sep = "")
cat("artifact_sha256=", observed_sha, "\n", sep = "")
cat("private_library=", private_lib, "\n", sep = "")
cat("installed_alder=", installed_dir, "\n", sep = "")

# `lib.loc` is intentional: this probe must not accidentally resolve the
# source checkout or a different Alder installation from the ambient library.
library("alder", lib.loc = private_lib, character.only = TRUE)
loaded_dir <- normalizePath(find.package("alder"), mustWork = TRUE)
if (!identical(loaded_dir, installed_dir)) {
  stop("Alder resolved outside the requested private library: ", loaded_dir)
}
cat("installed_version=", as.character(packageVersion("alder")), "\n", sep = "")

new_request <- function(body) {
  raw_body <- if (is.raw(body)) body else charToRaw(enc2utf8(body))
  list(
    CONTENT_TYPE = "application/json; charset=utf-8",
    CONTENT_LENGTH = as.character(length(raw_body)),
    rook.input = list(read = function(n) raw_body)
  )
}

json_result <- function(body) {
  elapsed <- system.time({
    value <- tryCatch(
      alder:::read_json_body(new_request(body), max_bytes = 16777216L),
      error = function(error) list(.probe_error = conditionMessage(error))
    )
  })[["elapsed"]]
  list(value = value, elapsed = unname(elapsed), bytes = length(
    if (is.raw(body)) body else charToRaw(enc2utf8(body))))
}

valid_file_widget <- function(target_bytes) {
  name_json <- as.character(jsonlite::toJSON(
    'brace { and "quote"', auto_unbox = TRUE))
  prefix <- paste0('{"name":"files","files":[{"name":', name_json,
                   ',"content_base64":"')
  suffix <- '"}]}'
  minimum <- nchar(prefix, type = "bytes") + nchar(suffix, type = "bytes")
  if (target_bytes < minimum) stop("target fixture is smaller than its envelope")
  paste0(prefix, strrep("A", target_bytes - minimum), suffix)
}

valid_sizes <- c(
  `~1KB` = 1024L,
  `~10KB` = 10240L,
  `~50KB` = 51200L,
  `1MiB` = 1048576L,
  `just-under-16MiB` = 16776192L
)
valid_bounds <- c(
  `~1KB` = 1,
  `~10KB` = 1.5,
  `~50KB` = 2,
  `1MiB` = 3,
  `just-under-16MiB` = 8
)

failures <- character()
record <- function(label, passed, detail) {
  status <- if (isTRUE(passed)) "PASS" else "FAIL"
  cat(sprintf("%s bytes=%d elapsed=%.3fs status=%s %s\n",
              label, detail$bytes, detail$elapsed, status,
              detail$summary %||% ""))
  if (!isTRUE(passed)) failures <<- c(failures, label)
}

`%||%` <- function(left, right) {
  if (is.null(left)) right else left
}

process_rows <- function() {
  raw <- processx::run(
    "ps", c("-e", "-o", "pid=,ppid=,args="), error_on_status = FALSE
  )$stdout
  lines <- strsplit(raw, "\n", fixed = TRUE)[[1L]]
  parsed <- lapply(lines, function(line) {
    match <- regexec(
      "^[[:space:]]*([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+(.*)$", line
    )
    hit <- regmatches(line, match)[[1L]]
    if (length(hit) != 4L) return(NULL)
    list(pid = as.integer(hit[[2L]]), ppid = as.integer(hit[[3L]]),
         args = hit[[4L]])
  })
  parsed[!vapply(parsed, is.null, logical(1L))]
}

descendants <- function(parent) {
  rows <- process_rows()
  found <- integer()
  frontier <- as.integer(parent)
  repeat {
    kids <- vapply(
      rows[vapply(rows, function(row) row$ppid %in% frontier, logical(1L))],
      function(row) row$pid, integer(1L)
    )
    kids <- setdiff(kids, found)
    if (!length(kids)) break
    found <- c(found, kids)
    frontier <- kids
  }
  rows[vapply(rows, function(row) row$pid %in% found, logical(1L))]
}

same_process_alive <- function(identity, rows) {
  any(vapply(rows, function(row) {
    identical(row$pid, identity$pid) && identical(row$args, identity$args)
  }, logical(1L)))
}

for (label in names(valid_sizes)) {
  result <- json_result(valid_file_widget(unname(valid_sizes[[label]])))
  parsed <- result$value
  valid <- is.null(parsed$.probe_error) &&
    is.null(parsed$error) && is.list(parsed$body) &&
    length(parsed$body$files) == 1L &&
    identical(parsed$body$files[[1L]]$name, 'brace { and "quote"')
  result$summary <- sprintf("parse=%s bound=%.1fs", valid, valid_bounds[[label]])
  record(paste0("valid/", label), valid && result$elapsed < valid_bounds[[label]], result)
}

invalid_cases <- list(
  `dense-container-array` = paste0(
    '{"files":[', paste(rep("{}", 10050L), collapse = ","), "]}"),
  `depth-40k` = paste0('{"a":', strrep("[", 40000L), "0",
                       strrep("]", 40000L), "}"),
  `depth-50k` = paste0('{"a":', strrep("[", 50000L), "0",
                       strrep("]", 50000L), "}"),
  `invalid-utf8` = as.raw(c(
    charToRaw('{"files":[{"name":"'), 0xc3, 0x28,
    charToRaw('","content_base64":"AAAA"}]}'))),
  `duplicate-escaped-key` = '{"na\\u006de":1,"name":2}',
  `active-escaped-nul` = '{"name":"\\u0000"}',
  `lone-high-surrogate` = '{"name":"\\uD800"}',
  `lone-low-surrogate` = '{"name":"\\uDC00"}',
  `separator-flood` = paste0('{"values":[', strrep("0,", 100001L), "0]}"),
  `escape-flood` = paste0('{"value":"', strrep("\\\\", 100001L), '"}')
)

for (label in names(invalid_cases)) {
  trials <- lapply(seq_len(3L), function(trial) {
    result <- json_result(invalid_cases[[label]])
    parsed <- result$value
    result$trial <- trial
    result$passed <- is.null(parsed$.probe_error) &&
      identical(parsed$body, NULL) && identical(parsed$error$status, 400L)
    result
  })
  for (result in trials) {
    result$summary <- sprintf("trial=%d error_status=%s bound=1.0s",
                              result$trial,
                              result$value$error$status %||% NA)
    record(paste0("invalid/", label, "/trial-", result$trial),
           result$passed && result$elapsed < 1,
           result)
  }
}

# Exercise the production route in a separate process. The independent
# httpuv loop is important: the probe can then ask for state immediately
# after a large upload and distinguish a responsive server from a parser that
# monopolizes the caller's event loop.
http_upload_probe <- function() {
  notebook <- tempfile("alder-b102-http-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "files <- ui$file()", "files",
    "# %%", "files$value"
  ), notebook, useBytes = TRUE)
  on.exit(unlink(notebook, force = TRUE), add = TRUE)

  cli <- Sys.getenv("ALDER_JSON_RESILIENCE_CLI", unset = "")
  temporary_cli <- ""
  if (!nzchar(cli)) {
    temporary_cli <- tempfile("alder-b102-cli-")
    dir.create(temporary_cli, recursive = TRUE)
    alder::alder_install_cli(temporary_cli)
    cli <- file.path(temporary_cli, "alder")
  }
  cli <- normalizePath(cli, mustWork = TRUE)
  on.exit(if (nzchar(temporary_cli)) {
    unlink(temporary_cli, recursive = TRUE, force = TRUE)
  }, add = TRUE)

  port <- httpuv::randomPort()
  args <- c("edit", notebook, "--host", "127.0.0.1", "--port",
            as.character(port), "--no-open", "--no-run",
            "--no-idle-timeout")
  process <- processx::process$new(
    cli, args, stdout = "|", stderr = "|",
    env = c(R_LIBS = private_lib, R_LIBS_USER = private_lib, R_TESTS = ""),
    cleanup_tree = TRUE
  )
  on.exit(if (process$is_alive()) {
    try(process$kill(), silent = TRUE)
  }, add = TRUE)

  stdout <- character()
  stderr <- character()
  drain <- function() {
    stdout <<- c(stdout, process$read_output_lines())
    stderr <<- c(stderr, process$read_error_lines())
    invisible()
  }
  deadline <- Sys.time() + 45
  ready <- FALSE
  while (process$is_alive() && Sys.time() < deadline) {
    drain()
    if (any(grepl("^alder running at ", stdout))) {
      ready <- TRUE
      break
    }
    Sys.sleep(0.05)
  }
  drain()
  if (!ready) {
    stop("installed CLI did not become ready: ", paste(stderr, collapse = " | "))
  }
  owned_descendants <- descendants(process$get_pid())

  base <- paste0("http://127.0.0.1:", port)
  request <- function(route, method = "GET", body = NULL, headers = list()) {
    handle <- curl::new_handle()
    curl::handle_setopt(
      handle, connecttimeout_ms = 3000L, timeout_ms = 10000L
    )
    if (identical(method, "POST")) {
      curl::handle_setopt(
        handle, customrequest = "POST",
        postfields = if (is.null(body)) "" else body,
        timeout_ms = 120000L
      )
    }
    if (!is.null(body)) headers$`Content-Type` <- "application/json"
    if (length(headers)) curl::handle_setheaders(handle, .list = headers)
    started <- proc.time()[["elapsed"]]
    response <- curl::curl_fetch_memory(paste0(base, route), handle = handle)
    elapsed <- proc.time()[["elapsed"]] - started
    text <- rawToChar(response$content)
    parsed <- tryCatch(
      jsonlite::fromJSON(text, simplifyVector = FALSE),
      error = function(error) list(.probe_error = conditionMessage(error))
    )
    list(status = as.integer(response$status_code), elapsed = elapsed,
         parsed = parsed, text = text)
  }

  state <- request("/api/state")
  shutdown_token <- state$parsed$shutdown_token %||% ""
  if (state$status != 200L || !nzchar(shutdown_token)) {
    stop("installed HTTP probe could not obtain initial state")
  }

  run <- request(
    "/api/run", method = "POST",
    body = as.character(jsonlite::toJSON(list(all = TRUE), auto_unbox = TRUE))
  )
  run_id <- run$parsed$run_id %||% NA_integer_
  if (run$status != 202L || is.na(as.integer(run_id))) {
    stop("/api/run did not return 202 with a run id")
  }
  run_settled <- FALSE
  run_deadline <- Sys.time() + 30
  while (Sys.time() < run_deadline && !run_settled) {
    operation <- request(paste0("/api/run-operation?run_id=", run_id))
    run_settled <- operation$status == 200L &&
      identical(operation$parsed$operation$status, "done")
    if (!run_settled) Sys.sleep(0.05)
  }
  if (!run_settled) stop("initial /api/run did not settle")

  decoded_bytes <- 12578814L
  encoded_bytes <- decoded_bytes / 3L * 4L
  encoded <- strrep("A", encoded_bytes)
  upload_body <- as.character(jsonlite::toJSON(list(
    name = "files",
    files = list(list(name = "near-limit.bin", content_base64 = encoded))
  ), auto_unbox = TRUE))
  upload_bytes <- nchar(upload_body, type = "bytes")
  if (upload_bytes >= 16777216L || upload_bytes <= 16700000L ||
      encoded_bytes %% 4L != 0L) {
    stop("production upload fixture is not just under the 16 MiB request ceiling")
  }
  upload <- request("/api/upload", method = "POST", body = upload_body)
  upload_token <- upload$parsed$token %||% NA_integer_
  if (upload$status != 202L || is.na(as.integer(upload_token))) {
    stop("/api/upload did not return 202 with an operation token")
  }
  state_after_upload <- request("/api/state")
  operation_settled <- FALSE
  upload_deadline <- Sys.time() + 30
  operation <- NULL
  while (Sys.time() < upload_deadline && !operation_settled) {
    operation <- request(paste0("/api/widget-operation?token=", upload_token))
    operation_settled <- operation$status == 200L &&
      identical(operation$parsed$operation$status, "done")
    if (!operation_settled) Sys.sleep(0.05)
  }

  state_final <- request("/api/state")
  widget <- NULL
  for (cell in state_final$parsed$cells %||% list()) {
    for (output in cell$outputs %||% list()) {
      if (identical(output$kind, "widget") &&
          identical(output$spec$kind, "file")) {
        widget <- output$spec
      }
    }
  }
  file_row <- if (!is.null(widget) && length(widget$value)) {
    widget$value[[1L]]
  } else {
    NULL
  }
  stored_path <- file_row$path %||% ""
  stored_size <- if (nzchar(stored_path) && file.exists(stored_path)) {
    file.info(stored_path)$size
  } else {
    NA_real_
  }
  upload_ok <- upload$status == 202L && upload$elapsed < 20 &&
    identical(as.integer(upload$parsed$token), as.integer(upload_token))
  state_ok <- state_after_upload$status == 200L &&
    state_after_upload$elapsed < 3
  widget_ok <- operation_settled && state_final$status == 200L &&
    identical(file_row$name, "near-limit.bin") &&
    identical(as.numeric(file_row$size), as.numeric(decoded_bytes)) &&
    identical(as.numeric(stored_size), as.numeric(decoded_bytes))
  cat(sprintf(
    paste0("http/upload request_bytes=%d decoded_bytes=%d encoded_bytes=%d ",
           "elapsed=%.3fs status=%d route=%s\n"),
    upload_bytes, decoded_bytes, encoded_bytes, upload$elapsed, upload$status,
    if (upload_ok) "PASS" else "FAIL"
  ))
  cat(sprintf(
    "http/state-after-upload bytes=%d elapsed=%.3fs status=%d route=%s\n",
    nchar(state_after_upload$text, type = "bytes"),
    state_after_upload$elapsed, state_after_upload$status,
    if (state_ok) "PASS" else "FAIL"
  ))
  cat(sprintf(
    "http/widget-operation decoded_size=%d stored_size=%s route=%s\n",
    decoded_bytes, stored_size %||% "NA", if (widget_ok) "PASS" else "FAIL"
  ))

  shutdown <- request(
    "/api/shutdown", method = "POST", headers = list(
      `X-Alder-Shutdown-Token` = shutdown_token
    )
  )
  exit_deadline <- Sys.time() + 30
  while (process$is_alive() && Sys.time() < exit_deadline) {
    drain()
    Sys.sleep(0.05)
  }
  if (process$is_alive()) process$kill()
  process$wait(5000)
  drain()
  closed_handle <- curl::new_handle()
  curl::handle_setopt(
    closed_handle, connecttimeout_ms = 1000L, timeout_ms = 2000L
  )
  port_closed <- inherits(
    try(curl::curl_fetch_memory(base, handle = closed_handle), silent = TRUE),
    "try-error"
  )
  cleanup_deadline <- Sys.time() + 10
  live_descendants <- owned_descendants
  while (length(live_descendants) && Sys.time() < cleanup_deadline) {
    remaining_processes <- process_rows()
    live_descendants <- owned_descendants[
      vapply(owned_descendants, same_process_alive, logical(1L),
             rows = remaining_processes)
    ]
    if (length(live_descendants)) Sys.sleep(0.1)
  }
  cleaned <- !nzchar(stored_path) || !file.exists(stored_path)
  teardown_ok <- shutdown$status == 202L && process$get_exit_status() == 0L &&
    port_closed && cleaned && !length(live_descendants)
  cat(sprintf(
    paste0("http/shutdown status=%d exit=%s port_closed=%s ",
           "upload_removed=%s live_descendants=%d route=%s\n"),
    shutdown$status, process$get_exit_status(), port_closed, cleaned,
    length(live_descendants),
    if (teardown_ok) "PASS" else "FAIL"
  ))

  list(
    upload = upload_ok, state = state_ok, widget = widget_ok,
    teardown = teardown_ok,
    bytes = upload_bytes, elapsed = upload$elapsed,
    state_elapsed = state_after_upload$elapsed,
    state_bytes = nchar(state_after_upload$text, type = "bytes"),
    summary = sprintf("decoded=%d stored=%s", decoded_bytes, stored_size %||% "NA")
  )
}

http_result <- tryCatch(
  http_upload_probe(),
  error = function(error) {
    cat("http/probe status=FAIL error=", conditionMessage(error), "\n", sep = "")
    list(upload = FALSE, state = FALSE, widget = FALSE, teardown = FALSE,
         bytes = 0L, state_bytes = 0L, elapsed = 0, state_elapsed = 0,
         summary = conditionMessage(error))
  }
)
record("http/upload", http_result$upload,
       list(bytes = http_result$bytes, elapsed = http_result$elapsed,
            summary = http_result$summary))
record("http/state-after-upload", http_result$state,
       list(bytes = http_result$state_bytes,
            elapsed = http_result$state_elapsed,
            summary = "responsive subsequent state request"))
record("http/widget-operation", http_result$widget,
       list(bytes = http_result$bytes, elapsed = http_result$elapsed,
            summary = http_result$summary))
record("http/shutdown", http_result$teardown,
       list(bytes = http_result$bytes, elapsed = http_result$elapsed,
            summary = "exit 0, closed port, removed upload"))

if (length(failures)) {
  stop("B-102 probe failures: ", paste(failures, collapse = ", "))
}
cat(sprintf("PASS: B-102 JSON resilience (%d valid-size and %d malformed trials)\n",
            length(valid_sizes), length(invalid_cases) * 3L))
