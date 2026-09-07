test_that("host codec retains physical bytes and stable identities", {
  source <- "# title\r\n# %%\r\nx <- 1\n#| label: odd\r\n\r\n# %%\ny <- x + 1"
  bytes <- base64enc::base64encode(charToRaw(source))
  decoded <- alder_host_service("codec.decode", list(bytes = bytes))$notebook
  expect_length(decoded$cells, 2)
  compact_decoded <- alder_host_service("codec.decode",
    list(bytes = bytes, compact = TRUE))$notebook
  expect_identical(compact_decoded$encoding, "base64-lines-v1")
  expect_null(compact_decoded$cells[[1L]][["body"]])
  expect_identical(rawToChar(base64enc::base64decode(
    compact_decoded$cells[[1L]]$body_base64[[1L]])), "x <- 1")
  payload <- list(bytes = bytes, cells = decoded$cells)
  encoded <- alder_host_service("codec.encode", payload)
  expect_identical(base64enc::base64decode(encoded$bytes), charToRaw(source))
  payload$cells[[1]]$body[[1]] <- "x <- 2"
  encoded <- alder_host_service("codec.encode", payload)
  expect_identical(rawToChar(base64enc::base64decode(encoded$bytes)),
                   sub("x <- 1", "x <- 2", source, fixed = TRUE))
  payload$bytes <- encoded$bytes
  payload$ids <- encoded$ids
  payload$cells <- rev(payload$cells)
  moved <- alder_host_service("codec.encode", payload)
  expect_identical(as.character(moved$ids), c("cell-2", "cell-1"))
  reloaded <- alder_host_service("codec.decode", moved)$notebook
  expect_identical(reloaded$cells[[1]]$id, "cell-2")
  expect_identical(as.character(reloaded$cells[[1]]$body), "y <- x + 1")
})

test_that("host processes consume one project or sandbox library policy", {
  old_paths <- .libPaths()
  old_sandbox <- Sys.getenv("ALDER_SANDBOX_LIB", unset = NA_character_)
  old_project <- Sys.getenv("ALDER_PROJECT_LIB", unset = NA_character_)
  restore_paths <- function(paths) {
    if ("include.site" %in% names(formals(.libPaths))) {
      .libPaths(paths, include.site = FALSE)
    } else {
      assign(".lib.loc", paths, envir = environment(.libPaths))
    }
  }
  on.exit({
    restore_paths(old_paths)
    Sys.unsetenv(c("ALDER_SANDBOX_LIB", "ALDER_PROJECT_LIB"))
    if (!is.na(old_sandbox)) Sys.setenv(ALDER_SANDBOX_LIB = old_sandbox)
    if (!is.na(old_project)) Sys.setenv(ALDER_PROJECT_LIB = old_project)
  }, add = TRUE)
  root <- tempfile("alder-host-libraries-")
  project <- file.path(root, "project")
  sandbox <- file.path(root, "sandbox")
  dir.create(project, recursive = TRUE)
  dir.create(sandbox)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)

  Sys.unsetenv("ALDER_SANDBOX_LIB")
  Sys.setenv(ALDER_PROJECT_LIB = project)
  policy <- alder_host_apply_library_policy()
  expect_identical(policy$mode, "project")
  expect_identical(normalizePath(.libPaths()[[1L]]), normalizePath(project))
  expect_identical(Sys.getenv("ALDER_PROJECT_LIB", unset = ""), "")

  restore_paths(old_paths)
  Sys.setenv(ALDER_PROJECT_LIB = project, ALDER_SANDBOX_LIB = sandbox)
  policy <- alder_host_apply_library_policy()
  expect_identical(policy$mode, "sandbox")
  expect_identical(normalizePath(.libPaths()[[1L]]), normalizePath(sandbox))
  expect_null(policy$project)
  expect_identical(Sys.getenv("ALDER_SANDBOX_LIB", unset = ""), "")
  expect_identical(Sys.getenv("ALDER_PROJECT_LIB", unset = ""), "")
})

test_that("host services enforce the notebook cell bound", {
  empty <- base64enc::base64encode(charToRaw(""))
  cell <- list(id = "duplicate", type = "code", body = list(), options = list())
  expect_error(alder_host_service("codec.document", list(
    bytes = empty, cells = rep(list(cell), 10001L), metadata = list()
  )), "10000 cell limit")

  physical <- paste(rep("# %%\n", 10001L), collapse = "")
  expect_error(alder_host_service("codec.decode", list(
    bytes = base64enc::base64encode(charToRaw(physical))
  )), "10000 cell limit")
})

test_that("host codec validates source and does not evaluate it", {
  bytes <- base64enc::base64encode(charToRaw("# %%\nstop('never run')\n"))
  decoded <- alder_host_service("codec.decode", list(bytes = bytes))$notebook
  expect_identical(as.character(decoded$cells[[1]]$body), "stop('never run')")
  expect_error(alder_host_service("codec.decode", list(bytes = "AA==")), "NUL")
  expect_error(alder_host_service("codec.decode", list(bytes = "/w==")), "UTF-8")
  expect_error(alder_host_service("codec.encode",
    list(bytes = bytes, cells = rep(decoded$cells, 2))), "duplicate")
  expect_error(alder_host_service("evaluate", list()), "unknown host service")

  encoded <- base64enc::base64encode(charToRaw("x <- 1"))
  expect_identical(alder_host_decode_source(
    list(source_base64 = encoded), "source_base64", "source"), "x <- 1")
  expect_error(alder_host_decode_source(
    list(source_base64 = encoded, source = "x <- 2"),
    "source_base64", "source"), "invalid source encoding")
  expect_error(alder_host_decode_source(
    list(source_base64 = "eA"), "source_base64", "source"),
    "invalid source encoding")
})

test_that("host export jobs render the committed snapshot without evaluating source", {
  directory <- tempfile("alder-host-export-")
  dir.create(directory)
  on.exit(unlink(directory, recursive = TRUE), add = TRUE)
  output <- file.path(directory, "report.html")
  state <- list(path = "notebook.R", metadata = list(),
    graph = list(topologicalOrder = list("cell-1")),
    cells = list(list(id = "cell-1", type = "code", status = "done",
      body = list("stop('source must not run')"), log = list(),
      outputs = list(list(kind = "text", text = "committed result")))))
  result <- alder_host_job("export", list(state = state, format = "html",
    artifact_dir = directory, out = output, include_code = TRUE))
  expect_identical(result$path, output)
  html <- paste(readLines(output), collapse = "\n")
  expect_match(html, "committed result", fixed = TRUE)
  expect_match(html, "source must not run", fixed = TRUE)
  expect_error(alder_host_job("eval", list()), "unknown host job")
})

test_that("host document edits preserve the cached disk source and structural bytes", {
  source <- "# %%\r\nx <- 1\r\n# %% [markdown]\r\n# hi\r\n# %%\r\ny <- x + 1"
  bytes <- base64enc::base64encode(charToRaw(source))
  original <- alder_host_service("codec.decode", list(bytes = bytes))$notebook
  payload <- list(bytes = bytes, cells = original$cells)
  payload$cells[[1]]$body <- "x <- 9"
  expect_identical(alder_host_service("codec.document", payload)$text,
                   sub("x <- 1", "x <- 9", source, fixed = TRUE))
  expect_identical(alder_host_service("codec.document",
    list(bytes = bytes, cells = original$cells))$text, source)
  expect_identical(alder_host_service("codec.decode", list(bytes = bytes))$notebook,
                   original)
  payload$cells <- list(original$cells[[3]],
    list(id = "new-cell", type = "code", body = "z <- 3", options = list()),
    original$cells[[2]])
  payload$cells[[1]]$body <- "y <- 2"
  document <- alder_host_service("codec.document", payload)
  expect_identical(document$text,
    "# %%\r\ny <- 2\r\n# %%\r\nz <- 3\r\n# %% [markdown]\r\n# hi")
  expect_identical(vapply(document$cells, function(cell) cell$id, ""),
                   c("cell-3", "new-cell", "cell-2"))
  expect_identical(alder_host_service("codec.document",
    list(bytes = bytes, cells = original$cells))$text, source)

  compact <- original$cells
  for (i in seq_along(compact)) {
    compact[[i]]$body_base64 <- as.list(vapply(compact[[i]]$body, function(line)
      base64enc::base64encode(charToRaw(line)), ""))
    compact[[i]]$body <- NULL
  }
  expect_identical(alder_host_service("codec.document",
    list(bytes = bytes, cells = compact))$text, source)
  compact[[1L]]$body_base64[[1L]] <- "eA"
  expect_error(alder_host_service("codec.document",
    list(bytes = bytes, cells = compact)), "encoded source line is invalid")
  compact_document <- alder_host_service("codec.document",
    list(bytes = bytes, cells = original$cells, compact = TRUE))
  expect_identical(compact_document$encoding, "base64-lines-v1")
  expect_null(compact_document$text)
  expect_true(all(vapply(compact_document$cells[[1L]]$records,
    function(record) is.character(record$text_base64), FALSE)))
})
