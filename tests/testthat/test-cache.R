
test_that("worker exposes the session cache directory", {
  m <- make_test_session(c(
    "# %%",
    "library(alder)",
    "cached <- cache$disk(function(x) x * 3)",
    "result <- cached(4)"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop())
  wait_until_settled(s)
  expect_true(all(vapply(s$state()$cells,
                         function(cell) !identical(cell$status, "error"),
                         logical(1))))
  expect_length(list.files(m$worker$cache_dir, pattern = "\\.rds$"), 1L)
})

test_that("cache keys track free variables, body changes, and clear", {
  cache_dir <- tempfile("alder-cache-")
  dir.create(cache_dir)
  withr::defer(unlink(cache_dir, recursive = TRUE, force = TRUE))

  multiplier <- 2
  f <- function(x) x * multiplier
  cached <- alder::cache$disk(f, dir = cache_dir)
  expect_s3_class(cached, "alder_cached")
  expect_identical(attr(cached, "cache"), "disk")
  expect_identical(cached(2), 4)
  expect_identical(cached(2), 4)
  expect_length(list.files(cache_dir, pattern = "\\.rds$"), 1L)

  multiplier <- 3
  expect_identical(cached(2), 6)
  expect_length(list.files(cache_dir, pattern = "\\.rds$"), 2L)

  f_changed <- f
  body(f_changed) <- quote(x * multiplier + 1)
  cached_changed <- alder::cache$disk(f_changed, dir = cache_dir)
  expect_identical(cached_changed(2), 7)
  expect_length(list.files(cache_dir, pattern = "\\.rds$"), 3L)

  alder::cache$clear("disk")
  expect_length(list.files(cache_dir, pattern = "\\.rds$"), 0L)
})

test_that("reactive reruns cannot reuse a cache entry from old dependencies", {
  m <- make_test_session(c(
    "# %%", "multiplier <- 2L",
    "# %%", "cached_multiply <- alder::cache$memory(function(x) x * multiplier)",
    "cached_result <- cached_multiply(10L)", "cached_result"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop())
  wait_until_settled(s)
  output <- function() {
    cell <- s$state()$cells[[2L]]
    cell$outputs[[length(cell$outputs)]]$text
  }
  expect_identical(output(), "[1] 20")

  revision <- s$state()$cells[[1L]]$revision
  s$set_cell("cell-1", "multiplier <- 3L", "code", revision)
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_identical(output(), "[1] 30")
})

test_that("reference-like dependencies bypass unsafe cache reuse", {
  dependency <- new.env(parent = emptyenv())
  dependency$value <- 2L
  cached <- alder::cache$memory(function(x) x * dependency$value)
  expect_identical(cached(5L), 10L)
  dependency$value <- 3L
  expect_identical(cached(5L), 15L)
})

test_that("a corrupt disk entry is discarded and atomically replaced", {
  cache_dir <- tempfile("alder-cache-corrupt-")
  dir.create(cache_dir)
  withr::defer(unlink(cache_dir, recursive = TRUE, force = TRUE))
  cached <- alder::cache$disk(function(x) x + 1L, dir = cache_dir)
  expect_identical(cached(8L), 9L)
  file <- list.files(cache_dir, pattern = "\\.rds$", full.names = TRUE)
  expect_length(file, 1L)
  writeBin(charToRaw("not an rds file"), file)
  expect_identical(cached(8L), 9L)
  expect_identical(readRDS(file), 9L)
  expect_length(list.files(cache_dir, all.files = TRUE,
                           pattern = "^\\.alder-cache-"), 0L)
})
