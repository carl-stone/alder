test_that("workers use the parent's installed Alder without library environment hints", {
  lib <- alder_cache_lib()
  root <- tempfile("alder-library-parity-")
  dir.create(root)
  withr::defer(unlink(root, recursive = TRUE))
  notebook <- file.path(root, "library.R")
  output <- file.path(root, "session.json")
  script <- file.path(root, "parent.R")
  libraries <- file.path(root, "parent-libraries.rds")
  # R CMD check can supply dependencies through startup.Rs rather than R_LIBS.
  # Restore that search path only in the parent; its vanilla worker still needs
  # Alder's bootstrap to propagate the installed package and dependency paths.
  saveRDS(.libPaths(), libraries)
  writeLines(c("# %%", "library(alder)", "# %%",
               "normalizePath(getNamespaceInfo(asNamespace('alder'), 'path'))"),
             notebook)
  writeLines(c(
    "options(warn = 2)",
    "args <- commandArgs(trailingOnly = TRUE)",
    ".libPaths(readRDS(args[[4L]]))",
    "library(alder, lib.loc = args[[1L]])",
    "alder_export(args[[2L]], 'session', out = args[[3L]])"
  ), script)
  child_env <- Sys.getenv()
  child_env[c("R_LIBS", "R_LIBS_USER", "R_TESTS")] <- ""
  result <- processx::run(
    file.path(R.home("bin"), "Rscript"),
    c("--vanilla", script, lib, notebook, output, libraries),
    env = child_env, error_on_status = FALSE, timeout = 120000
  )
  expect_identical(result$status, 0L, info = result$stderr)
  expect_identical(result$stderr, "")
  expect_true(file.exists(output))
  if (!file.exists(output)) return(invisible())
  state <- jsonlite::fromJSON(output, simplifyVector = FALSE)
  expect_identical(state$cells[[2L]]$status, "done")
  expected <- normalizePath(file.path(lib, "alder"))
  # Compare through R's own string printer, including Windows path escaping.
  expect_identical(state$cells[[2L]]$outputs[[1L]]$text,
                   paste(capture.output(print(expected)), collapse = "\n"))
})
