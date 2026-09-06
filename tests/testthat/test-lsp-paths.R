# File identity and notebook-local language-server policy.

test_that("LSP file URI encoding preserves native path structure and characters", {
  expect_identical(alder:::lsp_encode_file_path(
    "/tmp/caf\u00e9 #?%20\\name.R", windows = FALSE),
    "file:///tmp/caf%C3%A9%20%23%3F%2520%5Cname.R")
  expect_identical(alder:::lsp_encode_file_path("/", windows = FALSE), "file:///")
  expect_identical(alder:::lsp_encode_file_path(
    "C:\\Users\\caf\u00e9 #?%20.R", windows = TRUE),
    "file:///C:/Users/caf%C3%A9%20%23%3F%2520.R")
  expect_identical(alder:::lsp_encode_file_path("C:/", windows = TRUE), "file:///C:/")
  expect_identical(alder:::lsp_encode_file_path(
    "\\\\server\\share\\a b%20.R", windows = TRUE),
    "file://///server/share/a%20b%2520.R")
})

test_that("LSP native file URIs round-trip existing and unsaved relative paths", {
  root <- tempfile("alder-lsp-paths-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  withr::local_dir(root)
  decode <- asNamespace("languageserver")$path_from_uri
  name <- "caf\u00e9 # %20.R"
  writeLines("x <- 1", name)
  expect_identical(decode(alder:::lsp_file_uri(name)),
    enc2utf8(normalizePath(name, winslash = "/", mustWork = TRUE)))
  unsaved <- "unsaved # %20.R"
  expect_false(file.exists(unsaved))
  expect_identical(decode(alder:::lsp_file_uri(unsaved)),
    enc2utf8(file.path(normalizePath(root, winslash = "/"), unsaved)))
  if (.Platform$OS.type != "windows") {
    writeLines("x <- 1", "literal\\name.R")
    expect_identical(decode(alder:::lsp_file_uri("literal\\name.R")),
      file.path(normalizePath(root), "literal\\name.R"))
  }
})

test_that("LSP diagnostics honor notebook project policy for unsaved source", {
  root <- tempfile("alder-lsp-project-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  elsewhere <- file.path(root, "launcher")
  project <- file.path(root, "notebook")
  dir.create(elsewhere)
  dir.create(project)
  writeLines("linters: list()", file.path(elsewhere, ".lintr"))
  writeLines(paste0("linters: list(assignment_linter = assignment_linter(), ",
    "infix_spaces_linter = infix_spaces_linter())"), file.path(project, ".lintr"))
  path <- file.path(project, "caf\u00e9 # %20.R")
  writeLines(c("# %%", "x <- 1"), path)
  withr::local_dir(elsewhere)
  nb <- alder:::parse_notebook_lines(path, c("# %%", "x=1"))
  client <- alder:::LspClient$new(nb, path = path, diagnostics = TRUE, timeout = 30)
  on.exit(client$stop(), add = TRUE)
  deadline <- Sys.time() + 10
  rows <- list()
  while (!length(rows) && Sys.time() < deadline) {
    later::run_now(0.05)
    rows <- unlist(client$diagnostics_by_cell(nb), recursive = FALSE)
  }
  expect_true(client$alive())
  expect_setequal(vapply(rows, function(item) item$code, ""),
    c("assignment_linter", "infix_spaces_linter"))
  expect_true(all(vapply(rows, function(item)
    identical(item$range$start$line, 0L), logical(1))))
  expect_identical(readLines(path, warn = FALSE), c("# %%", "x <- 1"))
})

test_that("new unsaved notebooks inherit their own project lint configuration", {
  root <- tempfile("alder-lsp-new-project-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  elsewhere <- file.path(root, "launcher")
  project <- file.path(root, "notebook")
  dir.create(elsewhere)
  dir.create(project)
  writeLines("linters: list()", file.path(elsewhere, ".lintr"))
  writeLines(paste0("linters: list(assignment_linter = assignment_linter(), ",
    "infix_spaces_linter = infix_spaces_linter())"), file.path(project, ".lintr"))
  path <- file.path(project, "new notebook %20.R")
  withr::local_dir(elsewhere)
  nb <- alder:::parse_notebook_lines(path, c("# %%", "x=1"))
  client <- alder:::LspClient$new(nb, path = path, diagnostics = TRUE, timeout = 30)
  on.exit(client$stop(), add = TRUE)
  deadline <- Sys.time() + 10
  rows <- list()
  while (!length(rows) && Sys.time() < deadline) {
    later::run_now(0.05)
    rows <- unlist(client$diagnostics_by_cell(nb), recursive = FALSE)
  }
  expect_true(client$alive())
  expect_setequal(vapply(rows, function(item) item$code, ""),
    c("assignment_linter", "infix_spaces_linter"))
  expect_false(file.exists(path))
  expect_identical(getwd(), normalizePath(elsewhere, winslash = "/"))
})
