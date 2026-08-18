# Streaming output, stopped cells, cell-local names, and rm() contracts.
if (!exists("cell_of", mode = "function", inherits = TRUE)) {
  cell_of <- function(s, id) {
    st <- s$state()
    for (c in st$cells) {
      if (identical(c$id, id)) {
        c$output <- if (length(c$outputs)) c$outputs[[length(c$outputs)]] else NULL
        return(c)
      }
    }
    stop("no such cell: ", id)
  }
}
if (!exists("wait_until_settled", mode = "function", inherits = TRUE)) {
  wait_until_settled <- function(s, timeout = 10) {
    wait_for(s, function() {
      !any(vapply(s$state()$cells, function(c) identical(c$status, "running"), FALSE))
    }, timeout)
  }
}

cell_outputs <- function(s, id) {
  outputs <- cell_of(s, id)$outputs
  if (is.null(outputs)) list() else outputs
}

last_output <- function(s, id) {
  outputs <- cell_outputs(s, id)
  if (length(outputs)) outputs[[length(outputs)]] else NULL
}

test_that("progress notifications update state before the cell settles", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "p <- out$progress(3); for (i in 1:3) { p$update(i); Sys.sleep(0.2) }; \"done\""
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_for(s, function() {
    progress <- cell_of(s, "cell-2")$progress
    !is.null(progress) && identical(as.numeric(progress$value), 3)
  }, timeout = 8)
  wait_until_settled(s, timeout = 8)
  outputs <- cell_outputs(s, "cell-2")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_equal(tail(outputs, 1L)[[1L]]$kind, "text")
  expect_match(tail(outputs, 1L)[[1L]]$text, "done")
})

test_that("progress handles increment without an explicit value", {
  runtime <- getFromNamespace("RUNTIME", "alder")
  old <- runtime$emit
  emitted <- list()
  runtime$emit <- function(kind, payload) {
    if (identical(kind, "progress")) emitted[[length(emitted) + 1L]] <<- payload$progress
  }
  withr::defer(runtime$emit <- old)
  p <- out$progress(5, label = "loop")
  p$update()
  p$update()
  expect_length(emitted, 2)
  expect_equal(as.numeric(emitted[[1L]]$value), 1)
  expect_equal(as.numeric(emitted[[2L]]$value), 2)
  expect_false(isTRUE(emitted[[2L]]$done))
  p$close()
  expect_length(emitted, 3)
  expect_equal(as.numeric(emitted[[3L]]$value), 2)
  expect_true(isTRUE(emitted[[3L]]$done))
})

test_that("append output precedes the final visible value", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "out$append(1:3); \"tail\""
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  outputs <- cell_outputs(s, "cell-2")
  expect_length(outputs, 2)
  expect_equal(outputs[[1L]]$kind, "text")
  expect_equal(outputs[[2L]]$kind, "text")
  expect_match(outputs[[2L]]$text, "tail")
})

test_that("out stop commits its output and leaves descendants idle", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "out$stop(TRUE, \"halted\"); x <- 1",
    "# %%", "x + 1"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "stopped")
  expect_equal(cell_of(s, "cell-3")$status, "idle")
  outputs <- cell_outputs(s, "cell-2")
  expect_length(outputs, 1)
  expect_equal(outputs[[1L]]$kind, "text")
  expect_match(outputs[[1L]]$text, "halted")
})

test_that("dot-prefixed definitions are private to their defining cell", {
  m <- make_test_session(c(
    "# %%", ".tmp <- 1; .tmp",
    "# %%", ".tmp <- 2; .tmp"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  st <- s$state()
  expect_equal(unclass(st$cells[[1L]]$defs), character())
  expect_equal(unclass(st$cells[[1L]]$locals), ".tmp")
  expect_equal(unclass(st$cells[[2L]]$locals), ".tmp")
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_match(last_output(s, "cell-1")$text, "1")
  expect_match(last_output(s, "cell-2")$text, "2")
})

test_that("rm of a bare definition is analyzable and removes the binding", {
  m <- make_test_session(c("# %%", "x <- 1; rm(x); 2"))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_match(last_output(s, "cell-1")$text, "2")

  m2 <- make_test_session(c("# %%", "rm(list = \"x\")"))
  s2 <- m2$session
  withr::defer(s2$stop(), testthat::teardown_env())
  expect_error(s2$run_all(), "rm\\(\\) may only remove names this cell defines")
})
