#!/usr/bin/env Rscript

# Exact-installed-artifact replay for the installed release-safety findings
# B-105 through B-108 and successor publishing/alias findings B-120--B-121.
# The caller supplies a frozen artifact, its digest, the private library made
# from that artifact, and the already-installed canonical CLI. All fixtures
# are private and removed; durable evidence is the phase transcript plus the
# small JSON summary written beneath the caller's evidence directory.

options(warn = 2)

required_env <- function(name) {
  value <- Sys.getenv(name, unset = "")
  if (!nzchar(value)) stop("missing required environment variable: ", name,
                           call. = FALSE)
  value
}

artifact <- required_env("ALDER_RELEASE_SAFETY_ARTIFACT")
expected_sha <- required_env("ALDER_RELEASE_SAFETY_SHA256")
private_lib <- required_env("ALDER_RELEASE_SAFETY_LIB")
cli <- required_env("ALDER_RELEASE_SAFETY_CLI")
evidence_root <- required_env("ALDER_FINAL_AUDIT_EVIDENCE")

observed_sha <- strsplit(
  system2("sha256sum", artifact, stdout = TRUE, stderr = TRUE)[[1L]],
  "[[:space:]]+"
)[[1L]][[1L]]
if (!identical(observed_sha, expected_sha)) {
  stop("artifact digest mismatch", call. = FALSE)
}

.libPaths(c(private_lib, .libPaths()))
suppressPackageStartupMessages(library(alder))
installed <- normalizePath(find.package("alder"), mustWork = TRUE)
library_root <- paste0(normalizePath(private_lib, mustWork = TRUE), "/")
if (!startsWith(paste0(installed, "/"), library_root)) {
  stop("Alder did not resolve from the private artifact library: ", installed,
       call. = FALSE)
}

checks <- 0L
pass <- function(label, condition, detail = NULL) {
  if (!isTRUE(condition)) {
    stop("FAIL ", label,
         if (!is.null(detail)) paste0(": ", detail) else "",
         call. = FALSE)
  }
  checks <<- checks + 1L
  cat("PASS ", label,
      if (!is.null(detail)) paste0(" | ", detail) else "", "\n", sep = "")
  invisible(TRUE)
}

file_bytes <- function(path) {
  if (!file.exists(path) || dir.exists(path)) return(raw())
  readBin(path, "raw", n = file.info(path)$size)
}

tree_entries <- function(root) {
  sort(list.files(root, all.files = TRUE, recursive = TRUE,
                 include.dirs = TRUE))
}

capture_error <- function(expr) {
  tryCatch({
    force(expr)
    NULL
  }, error = identity)
}

expect_alder_error <- function(error, code, label) {
  pass(paste0(label, " classified"),
       inherits(error, "alder_error") && identical(error$code, code),
       if (is.null(error)) "call returned success" else conditionMessage(error))
}

expect_diagnostic <- function(error, diagnostic, label) {
  messages <- if (is.null(error) || is.null(error$messages)) character() else
    as.character(error$messages)
  pass(label,
       !is.null(error) &&
         grepl(diagnostic, conditionMessage(error), fixed = TRUE) &&
         any(messages == diagnostic),
       if (is.null(error)) "call returned success" else conditionMessage(error))
}

literal <- function(value) paste(utils::capture.output(dput(value)),
                                 collapse = "")

work <- tempfile("alder-release-safety-")
if (!dir.create(work, recursive = TRUE)) {
  stop("could not create release-safety fixture directory", call. = FALSE)
}
on.exit(unlink(work, recursive = TRUE, force = TRUE), add = TRUE)

cat("artifact=", normalizePath(artifact, mustWork = TRUE), "\n", sep = "")
cat("sha256=", observed_sha, "\n", sep = "")
cat("installed=", installed, "\n", sep = "")

# B-105: a marked test is part of the same topological pass as its setup and
# must run exactly once, exclusively under testthat.
test_marker <- file.path(work, "test-runs")
test_notebook <- file.path(work, "single-pass-test.R")
writeLines(c(
  "# %%", "setup <- 42L",
  "# %%", "#| name: runs_once", "#| test: true",
  paste0("runs <- if (file.exists(", literal(test_marker), ")) "),
  paste0("  as.integer(readLines(", literal(test_marker), ")) else 0L"),
  paste0("writeLines(as.character(runs + 1L), ", literal(test_marker), ")"),
  "testthat::expect_identical(setup, 42L)",
  "testthat::expect_identical(runs + 1L, 1L)"
), test_notebook, useBytes = TRUE)
test_results <- alder_test(test_notebook)
test_frame <- as.data.frame(test_results)
pass("B-105 marked cell executed once",
     identical(readLines(test_marker, warn = FALSE), "1"))
pass("B-105 returned testthat records", inherits(test_results, "testthat_results") &&
       nrow(test_frame) == 1L)
pass("B-105 exact run is green",
     sum(test_frame$failed + test_frame$error + test_frame$warning +
           test_frame$skipped) == 0L)

# B-106: every direct/canonical/filesystem identity alias must fail before an
# export worker can run notebook code, and before conversion can touch input.
export_marker <- file.path(work, "export-executed")
export_input <- file.path(work, "source.R")
writeLines(c(
  "# %%", paste0("writeLines('ran', ", literal(export_marker), ")"),
  "value <- 42L", "# %%", "value"
), export_input, useBytes = TRUE)
export_original <- file_bytes(export_input)
for (format in c("html", "md", "script", "ipynb", "qmd", "session")) {
  error <- capture_error(alder_export(export_input, format, out = export_input))
  expect_alder_error(error, "export_failed",
                     paste0("B-106 direct export alias ", format))
  pass(paste0("B-106 export input preserved ", format),
       identical(file_bytes(export_input), export_original))
  pass(paste0("B-106 export rejected before execution ", format),
       !file.exists(export_marker))
}

old_wd <- setwd(work)
relative_error <- capture_error(alder_export(
  basename(export_input), "md", out = file.path(".", basename(export_input))
))
setwd(old_wd)
expect_alder_error(relative_error, "export_failed",
                   "B-106 normalized relative export alias")
pass("B-106 relative alias preserved input",
     identical(file_bytes(export_input), export_original))

export_symlink <- file.path(work, "export-symlink")
if (file.symlink(export_input, export_symlink)) {
  symlink_error <- capture_error(alder_export(export_input, "md",
                                               out = export_symlink))
  expect_alder_error(symlink_error, "export_failed",
                     "B-106 symlink export alias")
  pass("B-106 symlink alias preserved input",
       identical(file_bytes(export_input), export_original))
} else {
  cat("SKIP platform could not create symlink (hard-link check remains)\n")
}

export_hardlink <- file.path(work, "export-hardlink")
if (!file.link(export_input, export_hardlink)) {
  stop("platform could not create required hard-link fixture", call. = FALSE)
}
hardlink_error <- capture_error(alder_export(export_input, "md",
                                              out = export_hardlink))
expect_alder_error(hardlink_error, "export_failed",
                   "B-106 hard-link export alias")
pass("B-106 hard-link alias preserved input",
     identical(file_bytes(export_input), export_original))

conversion_inputs <- list(
  ipynb = c(
    "{", '  "cells": [{"cell_type": "code", "metadata": {},',
    '    "source": ["answer <- 42L\\n"], "outputs": [], "execution_count": null}],',
    '  "metadata": {}, "nbformat": 4, "nbformat_minor": 5', "}"
  ),
  Rmd = c("---", "title: Safe", "---", "```{r}", "answer <- 42L", "```"),
  qmd = c("---", "title: Safe", "---", "```{r}", "answer <- 42L", "```")
)
for (extension in names(conversion_inputs)) {
  input <- file.path(work, paste0("convert-input.", extension))
  writeLines(conversion_inputs[[extension]], input, useBytes = TRUE)
  original <- file_bytes(input)
  error <- capture_error(alder_convert(input, out = input))
  expect_alder_error(error, "convert_failed",
                     paste0("B-106 direct conversion alias ", extension))
  pass(paste0("B-106 conversion input preserved ", extension),
       identical(file_bytes(input), original))
}

convert_input <- file.path(work, "convert-alias.qmd")
writeLines(conversion_inputs$qmd, convert_input, useBytes = TRUE)
convert_original <- file_bytes(convert_input)
convert_symlink <- file.path(work, "convert-symlink.R")
if (file.symlink(convert_input, convert_symlink)) {
  error <- capture_error(alder_convert(convert_input, out = convert_symlink))
  expect_alder_error(error, "convert_failed", "B-106 symlink conversion alias")
  pass("B-106 conversion symlink preserved input",
       identical(file_bytes(convert_input), convert_original))
} else {
  cat("SKIP platform could not create conversion symlink\n")
}
convert_hardlink <- file.path(work, "convert-hardlink.R")
if (!file.link(convert_input, convert_hardlink)) {
  stop("platform could not create conversion hard-link fixture", call. = FALSE)
}
error <- capture_error(alder_convert(convert_input, out = convert_hardlink))
expect_alder_error(error, "convert_failed", "B-106 hard-link conversion alias")
pass("B-106 conversion hard-link preserved input",
     identical(file_bytes(convert_input), convert_original))

# Failed input processing must not replace an existing destination. Successful
# calls must still be able to replace one, and no staging names may survive.
bad_export <- file.path(work, "bad-export.R")
writeLines(c("# %% [markdown]", "not-an-R-comment"), bad_export,
           useBytes = TRUE)
preserved_export <- file.path(work, "preserved.md")
writeLines("keep export", preserved_export, useBytes = TRUE)
preserved_export_bytes <- file_bytes(preserved_export)
error <- capture_error(alder_export(bad_export, "md", out = preserved_export))
expect_alder_error(error, "export_failed", "B-106 failing export")
pass("B-106 failed export preserved destination",
     identical(file_bytes(preserved_export), preserved_export_bytes))

bad_convert <- file.path(work, "bad-convert.qmd")
writeLines(c("```{r}", "answer <- 42L"), bad_convert, useBytes = TRUE)
preserved_convert <- file.path(work, "preserved.R")
writeLines("keep convert", preserved_convert, useBytes = TRUE)
preserved_convert_bytes <- file_bytes(preserved_convert)
error <- capture_error(alder_convert(bad_convert, out = preserved_convert))
expect_alder_error(error, "convert_failed", "B-106 failing conversion")
pass("B-106 failed conversion preserved destination",
     identical(file_bytes(preserved_convert), preserved_convert_bytes))

successful_export <- file.path(work, "successful.md")
writeLines("old export", successful_export, useBytes = TRUE)
alder_export(export_input, "md", out = successful_export)
pass("B-106 successful export replaced destination",
     !identical(file_bytes(successful_export), charToRaw("old export\n")) &&
       any(grepl("42", readLines(successful_export, warn = FALSE), fixed = TRUE)))
successful_convert <- file.path(work, "successful.R")
writeLines("old conversion", successful_convert, useBytes = TRUE)
alder_convert(convert_input, out = successful_convert)
pass("B-106 successful conversion replaced destination",
     !identical(file_bytes(successful_convert), charToRaw("old conversion\n")) &&
       any(grepl("answer <- 42L", readLines(successful_convert, warn = FALSE),
                 fixed = TRUE)))
pass("B-106 left no staging residue",
     !any(grepl("(^|/)[.]alder-(export|convert)", tree_entries(work),
                perl = TRUE)))

# B-120: every blocking analysis diagnostic must fail headless publishing
# before the first cell is evaluated.  Direct Pandoc/Quarto and all
# Session-backed export formats share this preflight contract; the marker cell makes an
# accidental partial execution observable and the sentinel destination makes
# replacement-before-validation observable.
blocking_notebooks <- list(
  syntax = c(
    "# %%", "writeLines(\"executed\", MARKER)",
    "# %%", "x <-"
  ),
  duplicate = c(
    "# %%", "writeLines(\"executed\", MARKER)",
    "# %%", "x <- 1L", "# %%", "x <- 2L"
  ),
  cycle = c(
    "# %%", "writeLines(\"executed\", MARKER)",
    "# %%", "a <- b + 1L", "# %%", "b <- a + 1L"
  ),
  dynamic = c(
    "# %%", "writeLines(\"executed\", MARKER)",
    "# %%", "target <- \"dynamic_name\"", "assign(target, 1L)"
  )
)
# Require the full native parser message, including location, source and caret.
# A short diagnostic fragment cannot be exactly equal to a complete record.
native_syntax_error <- capture_error(base::parse(
  text = tail(blocking_notebooks$syntax, 1L)
))
if (!inherits(native_syntax_error, "error")) {
  stop("syntax audit fixture must fail native R parsing", call. = FALSE)
}
blocking_diagnostics <- c(
  syntax = conditionMessage(native_syntax_error),
  duplicate = "duplicate definition of x",
  cycle = "dependency cycle",
  dynamic = paste0(
    "assign() requires a scalar string literal name and only the ",
    "default evaluation environment; use name <- value when possible"
  )
)
# B-105: 3; B-106: 41; B-120: 4 kinds * 8 outputs * 5 checks;
# B-121: 2 engines * 4 aliases * 4 checks; B-107: 22; B-108: 4.
expected_release_safety_checks <- 262L
for (kind in names(blocking_notebooks)) {
  marker <- file.path(work, paste0("b120-", kind, "-executed"))
  source <- file.path(work, paste0("b120-", kind, ".R"))
  lines <- sub("MARKER", literal(marker), blocking_notebooks[[kind]], fixed = TRUE)
  writeLines(lines, source, useBytes = TRUE)
  original <- file_bytes(source)
  for (format in c("html", "md", "script", "ipynb", "qmd", "session")) {
    extension <- c(html = "html", md = "md", script = "R", ipynb = "ipynb",
                   qmd = "qmd", session = "json")[[format]]
    destination <- file.path(work, paste0("b120-", kind, "-", format, ".", extension))
    writeLines("sentinel", destination, useBytes = TRUE)
    destination_bytes <- file_bytes(destination)
    before_files <- tree_entries(work)
    error <- capture_error(alder_export(source, format, out = destination,
                                        include_code = TRUE))
    expect_alder_error(error, "export_failed",
                       paste0("B-120 ", kind, " Session export ", format))
    expect_diagnostic(error, blocking_diagnostics[[kind]],
                      paste0("B-120 ", kind, " export exposes complete diagnostic ", format))
    pass(paste0("B-120 ", kind, " export has no marker ", format),
         !file.exists(marker))
    pass(paste0("B-120 ", kind, " export preserves source/destination ", format),
         identical(file_bytes(destination), destination_bytes) &&
           identical(file_bytes(source), original))
    pass(paste0("B-120 ", kind, " export leaves no staging ", format),
         identical(tree_entries(work), before_files))
  }
  for (render_engine in c("pandoc", "quarto")) {
    render_destination <- file.path(
      work, paste0("b120-", kind, "-", render_engine, ".html")
    )
    writeLines("sentinel", render_destination, useBytes = TRUE)
    render_bytes <- file_bytes(render_destination)
    before_files <- tree_entries(work)
    error <- capture_error(alder_render(source, engine = render_engine,
                                        out = render_destination))
    expect_alder_error(error, "render_failed",
                       paste0("B-120 ", kind, " direct ", render_engine))
    expect_diagnostic(
      error, blocking_diagnostics[[kind]],
      paste0("B-120 ", kind, " ", render_engine,
             " exposes complete diagnostic")
    )
    pass(paste0("B-120 ", kind, " ", render_engine, " has no marker"),
         !file.exists(marker))
    pass(paste0("B-120 ", kind, " ", render_engine,
                " preserves source/destination"),
         identical(file_bytes(render_destination), render_bytes) &&
           identical(file_bytes(source), original))
    pass(paste0("B-120 ", kind, " ", render_engine,
                " leaves no staging"),
         identical(tree_entries(work), before_files))
  }
}

# B-121: alder_render's same-file preflight is inode-aware.  Exercise each
# alias spelling against both external engines; no renderer may execute the
# marker cell or leave its temporary qmd/output files behind.
for (engine in c("pandoc", "quarto")) {
  marker <- file.path(work, paste0("b121-", engine, "-executed"))
  source <- file.path(work, paste0("b121-", engine, ".R"))
  writeLines(c(
    "# %%", paste0("writeLines(\"executed\", ", literal(marker), ")"),
    "# %%", "answer <- 42L"
  ), source, useBytes = TRUE)
  original <- file_bytes(source)
  aliases <- list(
    direct = source,
    normalized = file.path(work, ".", basename(source))
  )
  symlink <- file.path(work, paste0("b121-", engine, "-symlink.R"))
  if (file.symlink(source, symlink)) aliases$symlink <- symlink
  hardlink <- file.path(work, paste0("b121-", engine, "-hardlink.R"))
  if (!file.link(source, hardlink)) {
    stop("platform could not create B-121 hard-link fixture", call. = FALSE)
  }
  aliases$hardlink <- hardlink
  for (alias_kind in names(aliases)) {
    alias <- aliases[[alias_kind]]
    before_files <- tree_entries(work)
    error <- capture_error(alder_render(source, engine = engine, out = alias))
    expect_alder_error(error, "render_failed",
                       paste0("B-121 ", engine, " ", alias_kind, " alias"))
    pass(paste0("B-121 ", engine, " ", alias_kind, " has no marker"),
         !file.exists(marker))
    pass(paste0("B-121 ", engine, " ", alias_kind, " preserves source"),
         identical(file_bytes(source), original) &&
           identical(file_bytes(alias), original))
    pass(paste0("B-121 ", engine, " ", alias_kind, " leaves no staging"),
         identical(tree_entries(work), before_files))
  }
}

# B-107: the exact integer contract is independently enforced by the public
# MCP schema/backend and by Session. Invalid values must not mutate state.
mcp_notebook <- file.path(work, "mcp-revisions.R")
writeLines(c("# %%", "x <- 1L"), mcp_notebook, useBytes = TRUE)

# Direct dispatch helpers still model a real MCP client: initialize negotiates
# the protocol first, then the notification completes the two-phase handshake
# before any ordinary tool request is sent. Empty object values retain explicit
# names so they remain JSON objects if this fixture is later routed through a
# wire adapter.
mcp_empty_object <- function() structure(list(), names = character())
mcp_ready <- function(context, id) {
  initialized <- alder:::mcp_dispatch(
    context,
    list(
      jsonrpc = "2.0", id = id, method = "initialize",
      params = list(
        protocolVersion = "2024-11-05",
        capabilities = mcp_empty_object(),
        clientInfo = list(name = "alder-release-safety", version = "1")
      )
    )
  )
  stopifnot(
    identical(initialized$result$serverInfo$name, "alder"),
    identical(initialized$result$protocolVersion, "2024-11-05")
  )
  notification <- alder:::mcp_dispatch(
    context,
    list(
      jsonrpc = "2.0", method = "notifications/initialized",
      params = mcp_empty_object()
    )
  )
  stopifnot(is.null(notification))
  invisible(initialized)
}

mcp_context <- alder:::mcp_backend(mcp_notebook)
on.exit(mcp_context$close(), add = TRUE)
mcp_ready(mcp_context, "release-local-initialize")
mcp_call <- function(id, name, arguments = list()) alder:::mcp_dispatch(
  mcp_context,
  list(jsonrpc = "2.0", id = id, method = "tools/call",
       params = list(name = name, arguments = arguments))
)
mcp_payload <- function(response) jsonlite::fromJSON(
  response$result$content[[1L]]$text, simplifyVector = FALSE
)
listed <- alder:::mcp_dispatch(
  mcp_context,
  list(jsonrpc = "2.0", id = 1L, method = "tools/list")
)
tool_names <- vapply(listed$result$tools, `[[`, character(1L), "name")
edit_schema <- listed$result$tools[[match("edit_cell", tool_names)]]$
  inputSchema$properties$expected_revision
pass("B-107 MCP schema uses integer revision",
     identical(edit_schema$type, "integer"))
pass("B-107 MCP schema bounds revision",
     identical(edit_schema$minimum, 0L) &&
       identical(edit_schema$maximum, .Machine$integer.max))

invalid_revisions <- list(0.9, -1, .Machine$integer.max + 1, Inf, NaN)
for (i in seq_along(invalid_revisions)) {
  response <- mcp_call(10L + i, "edit_cell", list(
    cell = "cell-1", body = list("x <- 2L"), type = "code",
    expected_revision = invalid_revisions[[i]]
  ))
  payload <- mcp_payload(response)
  pass(paste0("B-107 local MCP rejects invalid revision ", i),
       isTRUE(response$result$isError) &&
         identical(payload$error$code, "invalid_request"))
}
before_valid <- mcp_payload(mcp_call(20L, "read_cell",
                                     list(cell = "cell-1")))$cell
pass("B-107 rejected MCP edits preserve body and revision",
     identical(unlist(before_valid$body, use.names = FALSE), "x <- 1L") &&
       identical(before_valid$revision, 0L))
valid <- mcp_call(21L, "edit_cell", list(
  cell = "cell-1", body = list("x <- 2L"), type = "code",
  expected_revision = 0L
))
pass("B-107 local MCP accepts current revision", !isTRUE(valid$result$isError))
stale <- mcp_call(22L, "edit_cell", list(
  cell = "cell-1", body = list("x <- 3L"), type = "code",
  expected_revision = 0L
))
pass("B-107 local MCP retains stale conflict",
     isTRUE(stale$result$isError) &&
       identical(mcp_payload(stale)$error$code, "source_conflict"))
mcp_context$close()
pass("B-107 local MCP worker closed", !mcp_context$worker$alive())

# Repeat malformed mutation at the real HTTP route and through the URL MCP
# adapter. The owned CLI is shut down through its authenticated lifecycle.
http_notebook <- file.path(work, "http-revisions.R")
writeLines(c("# %%", "x <- 1L"), http_notebook, useBytes = TRUE)
port <- httpuv::randomPort()
child_env <- Sys.getenv()
child_env <- child_env[names(child_env) != "R_TESTS"]
child_env[["R_LIBS"]] <- private_lib
child_env[["R_LIBS_USER"]] <- private_lib
process <- processx::process$new(
  cli,
  c("edit", http_notebook, "--no-open", "--no-run", "--port",
    as.character(port), "--no-idle-timeout"),
  env = child_env, stdout = "|", stderr = "|", cleanup_tree = TRUE
)
on.exit({
  if (process$is_alive()) process$kill_tree()
  process$wait(5000)
}, add = TRUE)
deadline <- Sys.time() + 60
ready_output <- character()
ready_errors <- character()
repeat {
  ready_output <- c(ready_output, process$read_output_lines())
  ready_errors <- c(ready_errors, process$read_error_lines())
  if (any(grepl("alder running at ", ready_output, fixed = TRUE))) break
  if (!process$is_alive() || Sys.time() >= deadline) {
    stop("release-safety CLI did not become ready: ",
         paste(c(ready_output, ready_errors), collapse = " | "), call. = FALSE)
  }
  Sys.sleep(0.02)
}
base <- sprintf("http://127.0.0.1:%d", port)
http_get <- function(route) {
  response <- curl::curl_fetch_memory(paste0(base, route))
  list(status = response$status_code,
       body = jsonlite::fromJSON(rawToChar(response$content),
                                 simplifyVector = FALSE))
}
http_post <- function(route, body) {
  handle <- curl::new_handle(
    customrequest = "POST",
    postfields = jsonlite::toJSON(body, auto_unbox = TRUE, null = "null")
  )
  curl::handle_setheaders(handle, "Content-Type" = "application/json")
  response <- curl::curl_fetch_memory(paste0(base, route), handle = handle)
  list(status = response$status_code,
       body = jsonlite::fromJSON(rawToChar(response$content),
                                 simplifyVector = FALSE))
}
for (revision in list(0.9, -1, .Machine$integer.max + 1)) {
  response <- http_post("/api/cell", list(
    op = "edit", id = "cell-1", body = list("x <- 2L"), type = "code",
    expected_revision = revision
  ))
  pass(paste0("B-107 HTTP rejects revision ", revision),
       identical(response$status, 400L) &&
         identical(response$body$error$code, "invalid_request"))
}
http_state <- http_get("/api/state")
pass("B-107 rejected HTTP edits preserve body and revision",
     identical(unlist(http_state$body$cells[[1L]]$body, use.names = FALSE),
               "x <- 1L") &&
       identical(http_state$body$cells[[1L]]$revision, 0L))

url_context <- alder:::mcp_backend(url = base)
on.exit(url_context$close(), add = TRUE)
mcp_ready(url_context, "release-url-initialize")
url_response <- alder:::mcp_dispatch(
  url_context,
  list(jsonrpc = "2.0", id = 30L, method = "tools/call",
       params = list(name = "edit_cell", arguments = list(
         cell = "cell-1", body = list("x <- 2L"), type = "code",
         expected_revision = 0.9
       )))
)
pass("B-107 URL MCP rejects fractional revision",
     isTRUE(url_response$result$isError) &&
       identical(mcp_payload(url_response)$error$code, "invalid_request"))
url_context$close()

valid_http <- http_post("/api/cell", list(
  op = "edit", id = "cell-1", body = list("x <- 2L"), type = "code",
  expected_revision = 0L
))
pass("B-107 HTTP accepts current revision",
     identical(valid_http$status, 200L) && isTRUE(valid_http$body$ok))
stale_http <- http_post("/api/cell", list(
  op = "edit", id = "cell-1", body = list("x <- 3L"), type = "code",
  expected_revision = 0L
))
pass("B-107 HTTP retains stale conflict",
     identical(stale_http$status, 409L) &&
       identical(stale_http$body$error$code, "source_conflict"))

shutdown_state <- http_get("/api/state")$body
shutdown_handle <- curl::new_handle(customrequest = "POST")
curl::handle_setheaders(
  shutdown_handle,
  "X-Alder-Shutdown-Token" = shutdown_state$shutdown_token
)
shutdown <- curl::curl_fetch_memory(paste0(base, "/api/shutdown"),
                                    handle = shutdown_handle)
pass("B-107 HTTP fixture accepted shutdown",
     identical(shutdown$status_code, 202L))
deadline <- Sys.time() + 15
while (process$is_alive() && Sys.time() < deadline) Sys.sleep(0.02)
pass("B-107 HTTP fixture exited", !process$is_alive())
process$wait(5000)
pass("B-107 HTTP fixture exit status", identical(process$get_exit_status(), 0L))
closed <- tryCatch({
  handle <- curl::new_handle(connecttimeout = 1, timeout = 1)
  curl::curl_fetch_memory(paste0(base, "/api/state"), handle = handle)
  FALSE
}, error = function(e) TRUE)
pass("B-107 HTTP fixture port closed", closed)

# B-108: both Content-Length preflight and actual-body overflow report the
# configured limit, including the upload route's 16 MiB allowance.
body_request <- function(raw_body, declared_length) list(
  CONTENT_TYPE = "application/json",
  CONTENT_LENGTH = as.character(declared_length),
  rook.input = list(read = function(n) {
    if (length(raw_body) <= n) raw_body else raw_body[seq_len(n)]
  })
)
for (limit in c(1024L * 1024L, 16L * 1024L * 1024L)) {
  expected_message <- paste("request body exceeds", limit %/% (1024L * 1024L),
                            "MiB")
  declared <- alder:::read_json_body(body_request(charToRaw("{}"), limit + 1L),
                                     max_bytes = limit)
  pass(paste0("B-108 declared limit message ", limit),
       identical(declared$error$status, 413L) &&
         identical(declared$error$message, expected_message))
  streamed <- alder:::read_json_body(body_request(raw(limit + 1L), limit),
                                     max_bytes = limit)
  pass(paste0("B-108 streamed limit message ", limit),
       identical(streamed$error$status, 413L) &&
         identical(streamed$error$message, expected_message))
}

summary_dir <- file.path(evidence_root, "b105-b108-release-safety")
dir.create(summary_dir, recursive = TRUE, showWarnings = FALSE)
if (!identical(checks, expected_release_safety_checks)) {
  stop("release-safety check accounting mismatch: expected ",
       expected_release_safety_checks, ", received ", checks, call. = FALSE)
}
jsonlite::write_json(
  list(
    ok = TRUE,
    checks = checks,
    artifact_sha256 = observed_sha,
    installed_package = installed,
    test_marker = readLines(test_marker, warn = FALSE),
    http_exit_status = process$get_exit_status(),
    staging_residue = tree_entries(work)[grepl(
      "(^|/)[.]alder-(export|convert)", tree_entries(work), perl = TRUE
    )]
  ),
  file.path(summary_dir, "summary.json"),
  auto_unbox = TRUE, pretty = TRUE, null = "null"
)
cat("release-safety checks=", checks, " status=PASS\n", sep = "")
