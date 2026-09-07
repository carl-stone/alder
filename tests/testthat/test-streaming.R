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
cell_outputs <- function(s, id) {
  outputs <- cell_of(s, id)$outputs # nolint: object_usage_linter
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
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  run <- s$run_all()
  wait_for(s, function() {
    progress <- cell_of(s, "cell-2")$progress
    !is.null(progress) && identical(as.numeric(progress$value), 3)
  }, timeout = 8)
  expect_identical(s$await_operation(run$run_id)$status, "done")
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
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
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
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
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
    "# %%", "assign('.tmp', 2); .tmp"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  st <- s$state()
  expect_equal(unclass(st$cells[[1L]]$defs), character())
  expect_equal(unclass(st$cells[[1L]]$locals), ".tmp")
  expect_equal(unclass(st$cells[[2L]]$locals), ".tmp")
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_match(last_output(s, "cell-1")$text, "1")
  expect_match(last_output(s, "cell-2")$text, "2")
})

test_that("literal assign drives dependencies and literal rm removes bindings", {
  m0 <- make_test_session(c(
    "# %%", "assigned_result <- assigned_value + 1L", "assigned_result",
    "# %%", "assign(value = 41L, x = 'assigned_value')"
  ), execution_mode = "lazy")
  s0 <- m0$session
  withr::defer(m0$close())
  expect_identical(
    unlist(s0$state()$dag$edges$`cell-1`, use.names = FALSE),
    "cell-2"
  )
  expect_identical(s0$await_operation(s0$run_all()$run_id)$status, "done")
  expect_equal(cell_of(s0, "cell-1")$status, "done")
  expect_match(last_output(s0, "cell-1")$text, "42")

  m <- make_test_session(c("# %%", "x <- 1; rm('x'); 2"),
                         execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_match(last_output(s, "cell-1")$text, "2")

  m2 <- make_test_session(c("# %%", "target <- 'x'; rm(list = target)"),
                          execution_mode = "lazy")
  s2 <- m2$session
  withr::defer(m2$close())
  expect_error(s2$run_all(), "rm\\(\\) requires bare names or scalar string literals")
})
