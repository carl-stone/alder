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
})
