# Language-server protocol framing and notebook position contracts.

test_that("LSP frames use UTF-8 byte content lengths", {
  frame <- alder:::lsp_message_frame(list(jsonrpc = "2.0", method = "test",
                                           params = list(text = "café")))
  separator <- alder:::lsp_raw_index(frame, charToRaw("\r\n\r\n"))[[1L]]
  header <- rawToChar(frame[seq_len(separator - 1L)])
  body <- frame[(separator + 4L):length(frame)]
  expect_match(header, paste0("Content-Length: ", length(body)))
  expect_equal(jsonlite::fromJSON(rawToChar(body), simplifyVector = FALSE)$method,
               "test")
})

test_that("notebook body positions map through delimiters and options", {
  nb <- alder:::parse_notebook_lines("demo.R", c(
    "# ---", "# title: demo", "# ---", "", "# %%", "x <- 1", "",
    "# %%", "#| name: second", "y <- x + 1", ""
  ))
  expect_identical(alder:::nb_body_lines(nb, "cell-1"), c(6L, 7L))
  expect_identical(alder:::nb_body_lines(nb, "cell-2"), c(10L, 11L))
  expect_identical(alder:::nb_to_file_pos(nb, "cell-2", 0L, 2L),
                   list(line = 9L, character = 2L))
  expect_identical(alder:::nb_from_file_pos(nb, 9L),
                   list(id = "cell-2", line = 0L))
  expect_null(alder:::nb_to_file_pos(nb, "cell-2", 2L, 0L))
})

test_that("LSP locations and diagnostics are translated to cell coordinates", {
  nb <- alder:::parse_notebook_lines("demo.R", c(
    "# %%", "x <- 1", "", "# %%", "y <- x + 1"
  ))
  uri <- alder:::lsp_file_uri("demo.R")
  location <- list(uri = uri, range = list(
    start = list(line = 4L, character = 4L),
    end = list(line = 4L, character = 5L)
  ))
  translated <- alder:::lsp_translate_result(location, "textDocument/definition",
                                               nb, uri)
  expect_equal(translated$range$start$cell, "cell-2")
  expect_equal(translated$range$start$line, 0L)
  expect_equal(translated$range$start$character, 4L)
  expect_equal(translated$range$end$cell, "cell-2")

  range <- list(start = list(line = 1L, character = 0L),
                end = list(line = 1L, character = 1L))
  converted <- alder:::lsp_translate_range(range, nb)
  expect_equal(converted$start$cell, "cell-1")
  expect_equal(converted$start$line, 0L)
  expect_equal(converted$end$character, 1L)
})

test_that("LSP completion translation preserves item shapes", {
  nb <- alder:::parse_notebook_lines("demo.R", c("# %%", "x <- iris"))
  uri <- alder:::lsp_file_uri("demo.R")
  result <- list(isIncomplete = FALSE, items = list(list(
    label = "iris", kind = 6L,
    textEdit = list(range = list(
      start = list(line = 1L, character = 5L),
      end = list(line = 1L, character = 5L)
    ), newText = "iris")
  )))
  translated <- alder:::lsp_translate_result(result, "textDocument/completion",
                                               nb, uri)
  expect_false(translated$isIncomplete)
  expect_equal(translated$items[[1L]]$label, "iris")
  expect_equal(translated$items[[1L]]$textEdit$range$start$line, 0L)
  expect_equal(translated$items[[1L]]$textEdit$range$start$cell, "cell-1")
})

test_that("real R language server cold-starts with completion and signatures", {
  nb <- alder:::parse_notebook_lines(tempfile(fileext = ".R"), c(
    "# %%", "mea"
  ))
  failures <- character()
  client <- alder:::LspClient$new(
    nb, timeout = 30,
    on_failure = function(message) failures <<- c(failures, message)
  )
  on.exit(client$stop(), add = TRUE)
  expect_true(client$alive())

  completion <- client$request_document(
    "textDocument/completion",
    list(position = list(cell = "cell-1", line = 0L, character = 3L)),
    nb, timeout = 10
  )
  items <- completion$items %||% completion
  labels <- vapply(items %||% list(), function(item) {
    as.character(item$label %||% "")
  }, "")
  expect_true(any(grepl("^mean", labels)))

  signature_nb <- alder:::parse_notebook_lines(tempfile(fileext = ".R"), c(
    "# %%", "stats::lm("
  ))
  signature <- client$request_document(
    "textDocument/signatureHelp",
    list(position = list(cell = "cell-1", line = 0L, character = 10L)),
    signature_nb, timeout = 10
  )
  expect_match(signature$signatures[[1L]]$label, "lm\\(formula")
  expect_length(failures, 0L)
})

test_that("language-server lintr diagnostics are opt-in and stoppable", {
  nb <- alder:::parse_notebook_lines(tempfile(fileext = ".R"), c(
    "# %%", "x=1"
  ))
  client <- alder:::LspClient$new(nb, timeout = 30)
  on.exit(client$stop(), add = TRUE)

  deadline <- Sys.time() + 2
  while (Sys.time() < deadline) later::run_now(0.05)
  expect_false(client$diagnostics_enabled)
  expect_length(client$diagnostics_by_cell(nb), 0L)

  expect_true(client$set_diagnostics(TRUE))
  deadline <- Sys.time() + 10
  diagnostics <- list()
  while (!length(diagnostics) && Sys.time() < deadline) {
    later::run_now(0.05)
    diagnostics <- client$diagnostics_by_cell(nb)
  }
  expect_true(client$diagnostics_enabled)
  expect_gt(length(diagnostics), 0L)
  messages <- vapply(
    unlist(diagnostics, recursive = FALSE),
    function(item) item$message %||% "", ""
  )
  expect_true(any(grepl("<-", messages, fixed = TRUE)))

  expect_true(client$set_diagnostics(FALSE))
  expect_false(client$diagnostics_enabled)
  expect_length(client$diagnostics_by_cell(nb), 0L)
})

test_that("idle language-server death is reported without another request", {
  nb <- alder:::parse_notebook_lines(tempfile(fileext = ".R"), c(
    "# %%", "x <- 1"
  ))
  failures <- character()
  client <- alder:::LspClient$new(
    nb, timeout = 30,
    on_failure = function(message) failures <<- c(failures, message)
  )
  on.exit(client$stop(), add = TRUE)
  client$proc$kill()
  deadline <- Sys.time() + 5
  while (!length(failures) && Sys.time() < deadline) {
    later::run_now(0.1)
  }
  expect_length(failures, 1L)
  expect_match(failures[[1L]], "language server exited")
  expect_false(client$alive())
})

test_that("LSP diagnostics merge without becoming blocking analysis errors", {
  nb <- alder:::parse_notebook_lines("demo.R", c("# %%", "x <- 1"))
  session <- alder:::Session$new(nb, worker = NULL,
                                  execution_mode = "automatic",
                                  run_on_startup = FALSE)
  on.exit(session$stop(), add = TRUE)
  session$set_lsp_diagnostics(list(`cell-1` = list(list(
    source = "lsp", level = "warning", message = "style"
  ))))
  expect_null(session$validate_graph())
  session$set_lsp_diagnostics(list(`cell-1` = list(list(
    source = "lsp", level = "error", message = "parse failure"
  ))))
  expect_null(session$validate_graph())
  expect_true(any(vapply(session$state()$cells[[1L]]$diagnostics,
                          function(item) identical(item$source, "lsp"),
                          logical(1))))

  session$record_action_error("language server exited", "lsp_unavailable")
  session$clear_action_error(c("lsp_unavailable", "lsp_timeout"))
  expect_null(session$state()$last_action_error)

  session$record_service_error(
    "lsp", "R language server exited", "lsp_unavailable"
  )
  session$record_action_error("unrelated request failed", "internal_error")
  session$clear_action_error("internal_error")
  expect_identical(
    session$state()$last_action_error$service, "lsp"
  )
  session$clear_service_error("lsp")
  expect_null(session$state()$last_action_error)
})

test_that("document LSP diagnostics retain conditions without fake cell positions", {
  project <- withr::local_tempdir()
  path <- file.path(project, "notebook.R")
  writeLines(c("# %%", "x <- 1", "# %%", "y <- x + 1"), path)
  nb <- alder:::read_notebook(path)
  client <- alder:::LspClient$new(nb, path = path, diagnostics = FALSE)
  on.exit(client$stop(), add = TRUE)
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  on.exit(session$stop(), add = TRUE)
  client$diagnostics_enabled <- TRUE
  at <- function(start, end = start) list(
    start = list(line = start, character = 0L),
    end = list(line = end, character = 0L)
  )
  rows <- list(
    list(range = at(0L), severity = 1L, source = "lintr",
         message = "Failed to run diagnostics: retained failure"),
    list(range = at(1L, 3L), severity = 2L, code = "cross-cell",
         message = "A warning spanning cells"),
    list(severity = 3L, message = "A document note without a range"),
    list(range = at(1L), severity = 3L, code = "style",
         message = "A located style note")
  )
  publish <- function(value, version = client$version) client$handle_message(list(
    method = "textDocument/publishDiagnostics",
    params = list(uri = client$uri, version = version, diagnostics = value)
  ))
  publish(rows)
  mapped <- client$diagnostics_by_cell(nb)
  expect_length(mapped[[".document"]], 3L)
  expect_identical(vapply(mapped[[".document"]], `[[`, "", "level"),
                   c("error", "warning", "info"))
  expect_identical(vapply(mapped[[".document"]], `[[`, "", "message"),
                   vapply(rows[1:3], `[[`, "", "message"))
  expect_true(all(vapply(mapped[[".document"]], function(item) {
    is.null(item$range) && identical(item$source, "lsp")
  }, logical(1L))))
  expect_identical(mapped[[".document"]][[1L]]$file_range, rows[[1L]]$range)
  expect_identical(mapped[[".document"]][[2L]]$file_range, rows[[2L]]$range)
  expect_length(mapped[["cell-1"]], 1L)
  expect_identical(mapped[["cell-1"]][[1L]]$range$start$line, 0L)
  expect_null(mapped[["cell-2"]])

  session$set_lsp_diagnostics(mapped)
  expect_null(session$validate_graph())
  wire <- jsonlite::fromJSON(jsonlite::toJSON(
    session$state(), auto_unbox = TRUE, null = "null", force = TRUE
  ), simplifyVector = FALSE)
  expect_length(wire$editor_diagnostics, 3L)
  expect_identical(wire$editor_diagnostics[[1L]]$level, "error")
  expect_null(wire$editor_diagnostics[[1L]]$range)
  expect_identical(wire$cells[[1L]]$diagnostics[[1L]]$message,
                   "A located style note")

  publish(rows[1L])
  session$set_lsp_diagnostics(client$diagnostics_by_cell(nb))
  wire <- jsonlite::fromJSON(jsonlite::toJSON(
    session$state(), auto_unbox = TRUE, null = "null", force = TRUE
  ), simplifyVector = FALSE)
  expect_length(wire$editor_diagnostics, 1L)
  expect_true(is.list(wire$editor_diagnostics[[1L]]))

  publish(list())
  session$set_lsp_diagnostics(client$diagnostics_by_cell(nb))
  expect_length(session$state()$editor_diagnostics, 0L)
  expect_length(session$state()$cells[[1L]]$diagnostics, 0L)

  # Source synchronization invalidates old ranges, and a late result from an
  # older document revision must not restore them on the next state poll.
  publish(rows)
  old_version <- client$version
  changed <- alder:::parse_notebook_lines(path, c(
    "# %%", "x <- 2", "# %%", "y <- x + 1"
  ))
  expect_true(client$sync_document(changed))
  expect_length(client$diagnostics_by_cell(changed), 0L)
  publish(rows, version = old_version)
  expect_length(client$diagnostics_by_cell(changed), 0L)
  current_rows <- rows
  current_rows[[1L]]$message <- "Current document diagnostic"
  publish(current_rows)
  expect_identical(client$diagnostics_by_cell(changed)[[".document"]][[1L]]$message,
                   "Current document diagnostic")
  publish(rows, version = old_version)
  expect_identical(client$diagnostics_by_cell(changed)[[".document"]][[1L]]$message,
                   "Current document diagnostic")
  expect_false(client$sync_document(changed))
  expect_length(client$diagnostics_by_cell(changed)[[".document"]], 3L)
  publish(list(), version = NULL)
  expect_length(client$diagnostics_by_cell(changed), 0L)

  # Turning lint off clears retained diagnostics even with no live LSP.
  publish(rows)
  session$set_lsp_diagnostics(client$diagnostics_by_cell(nb))
  client$stop()
  expect_false(client$alive())
  session$set_config(list(editor = list(live_diagnostics = FALSE)))
  expect_length(session$state()$editor_diagnostics, 0L)
  expect_length(session$state()$cells[[1L]]$diagnostics, 0L)
  expect_null(session$validate_graph())
})
