
test_that("worker exposes the session cache directory", {
  m <- make_test_session(c(
    "# %%",
    "library(alder)",
    "cached <- cache$disk(function(x) x * 3)",
    "result <- cached(4)"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  wait_for(s, function() {
    !any(vapply(s$state()$cells,
                function(cell) identical(cell$status, "running"),
                logical(1)))
  })
  expect_true(all(vapply(s$state()$cells,
                         function(cell) !identical(cell$status, "error"),
                         logical(1))))
  expect_length(list.files(m$worker$cache_dir, pattern = "\\.rds$"), 1L)
})

test_that("disk cache hits, misses after body changes, and clears", {
  cache_dir <- tempfile("alder-cache-")
  dir.create(cache_dir)
  withr::defer(unlink(cache_dir, recursive = TRUE, force = TRUE))

  calls <- 0L
  f <- function(x) {
    calls <<- calls + 1L
    x * 2
  }
  cached <- alder::cache$disk(f, dir = cache_dir)
  expect_s3_class(cached, "alder_cached")
  expect_identical(attr(cached, "cache"), "disk")
  expect_identical(cached(2), 4)
  expect_identical(cached(2), 4)
  expect_identical(calls, 1L)

  f_changed <- f
  body(f_changed) <- quote({
    calls <<- calls + 1L
    x * 3
  })
  cached_changed <- alder::cache$disk(f_changed, dir = cache_dir)
  expect_identical(cached_changed(2), 6)
  expect_identical(calls, 2L)
  expect_length(list.files(cache_dir, pattern = "\\.rds$"), 2L)

  alder::cache$clear("disk")
  expect_length(list.files(cache_dir, pattern = "\\.rds$"), 0L)
})
