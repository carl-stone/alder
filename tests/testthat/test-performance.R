# Developer tracing must remain absent from ordinary execution and preserve
# values/conditions. Fresh subprocesses isolate the process-local opt-in flag.
perf_child <- function(code, dir = "") {
  env <- Sys.getenv()
  env[["ALDER_PERF_TRACE_DIR"]] <- dir
  env[["ALDER_PERF_RPROF"]] <- "0"
  processx::run(file.path(R.home("bin"), "Rscript"),
    c("--vanilla", "-e", code), env = env, error_on_status = FALSE)
}

test_that("performance tracing is inert without explicit configuration", {
  result <- perf_child(paste0(
    "library(alder); b <- getFromNamespace('.alder_perf_begin','alder');",
    "e <- getFromNamespace('.alder_perf_end','alder');",
    "s <- b('analysis', stop('disabled fields must stay lazy'));",
    "stopifnot(is.null(s)); e(s, stop('disabled results must stay lazy'));",
    "stopifnot(!'microbenchmark' %in% loadedNamespaces());",
    "cat(6 * 7)"
  ))
  expect_identical(result$status, 0L)
  expect_identical(result$stdout, "42")
  expect_identical(result$stderr, "")
})

test_that("performance spans correlate nested work and retain elapsed durations", {
  skip_if_not_installed("microbenchmark")
  dir <- tempfile("alder-perf-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  result <- perf_child(paste0(
    "library(alder); b <- getFromNamespace('.alder_perf_begin','alder');",
    "e <- getFromNamespace('.alder_perf_end','alder');",
    "invisible(loadNamespace('microbenchmark'));",
    "testthat::with_mocked_bindings({",
    "outer <- b('http', list(route='/api/run'));",
    "inner <- b('kernel.evaluate', list(req=7,run_id=3));",
    "Sys.sleep(0.025); e(inner); e(outer); cat(42)",
    "}, proc.time=function(...)stop('adjustable clock consulted'), .package='base')"
  ), dir)
  expect_identical(result$status, 0L)
  expect_identical(result$stdout, "42")
  expect_identical(result$stderr, "")
  path <- list.files(dir, full.names = TRUE)
  expect_length(path, 1L)
  rows <- lapply(readLines(path), jsonlite::fromJSON, simplifyVector = FALSE)
  expect_identical(vapply(rows, `[[`, "", "event"), c("begin", "begin", "end", "end"))
  expect_equal(rows[[2]]$span, rows[[3]]$span)
  expect_equal(rows[[1]]$span, rows[[4]]$span)
  expect_equal(rows[[3]]$fields$req, 7)
  expect_equal(rows[[3]]$fields$run_id, 3)
  expect_gte(rows[[3]]$duration_ms, 20)
  expect_gte(rows[[4]]$duration_ms, rows[[3]]$duration_ms)
})

test_that("an invalid performance destination cannot produce successful evidence", {
  result <- perf_child("library(alder); getFromNamespace('.alder_perf_begin','alder')('analysis')",
    file.path(tempdir(), "missing-perf-directory", "trace"))
  expect_true(result$status != 0L)
  expect_match(result$stderr, "existing writable directory", fixed = TRUE)
})
