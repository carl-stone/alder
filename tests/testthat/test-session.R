# Session/worker integration tests: the public state machine against a real
# worker process. Worker setup/pumping lives in helper-session.R.

# A slow-ish cell so Stop has time to land after the eval ack.
slow_body <- c("Sys.sleep(1.5)", "42")

# Wait until no cell is running (an eval request in flight).
wait_until_settled <- function(s, timeout = 10) {
  wait_for(s, function() {
    st <- s$state()
    !any(vapply(st$cells, function(c) identical(c$status, "running"), FALSE))
  }, timeout)
}

# Wait until a widget operation with this token reaches a terminal status.
wait_widget_done <- function(s, cell_id, token, timeout = 10) {
  wait_for(s, function() {
    out <- cell_of(s, cell_id)$output
    !is.null(out) && !is.null(out$operation) &&
      identical(out$operation$token, token) &&
      !identical(out$operation$status, "pending")
  }, timeout)
  invisible()
}

cell_of <- function(s, id) {
  st <- s$state()
  for (c in st$cells) if (identical(c$id, id)) return(c)
  stop("no such cell: ", id)
}

test_that("worker executes cells end to end with visible values", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "x * 2"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  expect_false(s$state()$runtime$busy)

  s$run_all()
  expect_true(s$state()$runtime$busy)
  wait_until_settled(s)

  c1 <- cell_of(s, "cell-1")
  c2 <- cell_of(s, "cell-2")
  expect_equal(c1$status, "done")
  expect_equal(c2$status, "done")
  expect_equal(c2$output$kind, "text")
  expect_match(c2$output$text, "\\[1\\] 2")
  expect_length(c2$log, 0)
})

test_that("top-level functions have .GlobalEnv as their environment", {
  m <- make_test_session(c(
    "# %%", "f <- function() 1",
    "# %%", "environmentName(environment(f))"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_match(cell_of(s, "cell-2")$output$text, "R_GlobalEnv")
})

test_that("startup autorun executes all cells; graph rejection is recorded", {
  m <- make_test_session(c(
    "# %%", "a <- 1",
    "# %%", "b <- a"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")

  # run_on_startup = FALSE leaves every code cell idle
  m2 <- make_test_session(c("# %%", "a <- 1"), run_on_startup = FALSE)
  s2 <- m2$session
  withr::defer(s2$stop(), testthat::teardown_env())
  expect_equal(cell_of(s2, "cell-1")$status, "idle")
  expect_equal(m2$worker$counter, 1L)  # no request was sent

  # a startup graph rejection records last_action_error and stays editable
  m3 <- make_test_session(c("# %%", "a <- 1", "# %%", "a <- 2"),
                          run_on_startup = TRUE)
  s3 <- m3$session
  withr::defer(s3$stop(), testthat::teardown_env())
  st <- s3$state()
  expect_equal(st$last_action_error$code, "graph_invalid")
  expect_match(st$last_action_error$message, "duplicate definitions")
  expect_equal(cell_of(s3, "cell-1")$status, "idle")
})

test_that("duplicate definitions and cycles dispatch nothing", {
  m <- make_test_session(c("# %%", "a <- 1", "# %%", "a <- 2"),
                         run_on_startup = FALSE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  expect_error(s$run_all(), "duplicate definitions")
  expect_equal(m$worker$counter, 1L)

  m2 <- make_test_session(c("# %%", "a <- b", "# %%", "b <- a"),
                          run_on_startup = FALSE)
  s2 <- m2$session
  withr::defer(s2$stop(), testthat::teardown_env())
  expect_error(s2$run_all(), "dependency cycle")
  expect_equal(m2$worker$counter, 1L)
})

test_that("automatic mode reruns every descendant after an edit", {
  m <- make_test_session(c(
    "# %%", "n <- 1",
    "# %%", "m <- n + 1",
    "# %%", "m * 10"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 20")

  s$set_cell("cell-1", c("n <- 2"), "code", expected_revision = 0L)
  expect_equal(cell_of(s, "cell-1")$status, "stale")
  expect_equal(cell_of(s, "cell-2")$status, "stale")
  expect_equal(cell_of(s, "cell-3")$status, "stale")
  # old outputs remain visible while stale
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 20")

  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_equal(cell_of(s, "cell-3")$status, "done")
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 30")
})

test_that("lazy mode leaves descendants stale and runs stale ancestors first", {
  m <- make_test_session(c(
    "# %%", "n <- 1",
    "# %%", "y <- n + 1", "y"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")

  # edit upstream: both stale; running the upstream cell reruns only it
  s$set_cell("cell-1", c("n <- 2"), "code", expected_revision = 0L)
  expect_equal(cell_of(s, "cell-2")$status, "stale")
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "stale")

  # running the stale downstream cell runs its stale ancestors first
  s$set_cell("cell-1", c("n <- 3"), "code", expected_revision = 1L)
  expect_equal(cell_of(s, "cell-2")$status, "stale")
  s$run_cell("cell-2")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_equal(cell_of(s, "cell-2")$output$text, "[1] 4")
})

test_that("editing a cell enqueues worker cleanup of its old bindings", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "x + 1"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  # empty the defining cell: its old global must not survive the rerun
  s$set_cell("cell-1", character(), "code", expected_revision = 0L)
  s$run_cell("cell-2")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "error")
  expect_match(paste(cell_of(s, "cell-2")$log, collapse = "\n"),
               "object 'x' not found")
})

test_that("widgets render only as a bare owned visible name", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "ui$slider(min = 0, max = 1)"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "error")
  expect_match(paste(cell_of(s, "cell-2")$log, collapse = "\n"),
               "must be assigned in this cell")
})

test_that("slider updates rerun consumers automatically", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "min_wt <- ui$slider(min = 0, max = 10, value = 5)", "min_wt",
    "# %%", "min_wt$value * 2"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  w <- cell_of(s, "cell-2")$output
  expect_equal(w$kind, "widget")
  expect_equal(w$spec$value, 5)

  tok <- s$set_widget("min_wt", list(value = 7), "editor")
  expect_type(tok, "integer")
  wait_widget_done(s, "cell-2", tok)
  wait_until_settled(s)
  w <- cell_of(s, "cell-2")$output
  expect_equal(w$spec$value, 7)
  expect_equal(w$commit_token, tok)
  expect_equal(w$operation$status, "done")
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 14")
})

test_that("dropdown selections preserve the choices type in consumers", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "d <- ui$dropdown(choices = c(1L, 2L))", "d",
    "# %%", "typeof(d$value)"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] \"integer\"")

  tok <- s$set_widget("d", list(index = 2L), "editor")
  wait_widget_done(s, "cell-2", tok)
  wait_until_settled(s)
  w <- cell_of(s, "cell-2")$output
  expect_equal(w$spec$index, 2L)
  expect_equal(w$spec$value, 2L)
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] \"integer\"")

  m2 <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "d <- ui$dropdown(choices = c(1, 2))", "d",
    "# %%", "typeof(d$value)"
  ))
  s2 <- m2$session
  withr::defer(s2$stop(), testthat::teardown_env())
  s2$run_all()
  wait_until_settled(s2)
  tok <- s2$set_widget("d", list(index = 2L), "editor")
  wait_widget_done(s2, "cell-2", tok)
  wait_until_settled(s2)
  expect_equal(cell_of(s2, "cell-2")$output$spec$value, 2)
  expect_equal(cell_of(s2, "cell-3")$output$text, "[1] \"double\"")
})

test_that("run_button is one-shot and resets after its consumers finish", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "btn <- ui$run_button(label = \"Go\")", "btn",
    "# %%", "btn$value"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$output$spec$value, FALSE)

  tok <- s$set_widget("btn", list(value = TRUE), "editor")
  wait_widget_done(s, "cell-2", tok)
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] TRUE")
  # the button resets to FALSE once the direct consumer finished
  wait_for(s, function() {
    out <- cell_of(s, "cell-2")$output
    identical(out$spec$value, FALSE) &&
      identical(out$operation$status, "done")
  })
  expect_equal(cell_of(s, "cell-2")$output$spec$value, FALSE)
  expect_equal(cell_of(s, "cell-2")$output$operation$status, "done")
})

test_that("editing a widget owner cancels its pending update", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "w <- ui$slider(min = 0, max = 10, value = 5)", "w",
    "# %%", "w$value"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  s$set_widget("w", list(value = 9), "editor")
  # cancel the pending op by editing the owner cell (different body)
  s$set_cell("cell-2", c("w <- ui$slider(min = 0, max = 10, value = 9)", "w"),
             "code", expected_revision = 0L)
  wait_until_settled(s)
  w <- cell_of(s, "cell-2")$output
  expect_equal(w$operation$status, "cancelled")
  expect_equal(w$spec$value, 5)
})

test_that("package-attach barrier edits require a clean worker restart", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "1 + 1"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  # editing the barrier marks every code cell stale and invalidates the
  # worker; the next run restarts it and still completes
  s$set_cell("cell-1", c("library(alder)", "message('edited')"),
             "code", expected_revision = 0L)
  expect_equal(cell_of(s, "cell-2")$status, "stale")
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "done")
})

test_that("a failed barrier run marks other cells stale and recovers", {
  m <- make_test_session(c(
    "# %%", "library(alder_nonexistent_pkg)",
    "# %%", "1 + 1"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_equal(cell_of(s, "cell-2")$status, "stale")
  # the same broken graph cannot run; editing repairs it and the worker
  # restarts cleanly before the next evaluation
  s$set_cell("cell-1", c("1"), "code", expected_revision = 0L)
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
})

test_that("normal Stop interrupts the active cell and leaves the worker usable", {
  m <- make_test_session(c("# %%", slow_body))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_cell("cell-1")
  wait_for(s, function() isTRUE(s$state()$runtime$busy))
  # wait until the eval start ack has been received so SIGINT lands
  wait_for(s, function() !is.null(m$worker$executing_req), timeout = 5)
  res <- s$interrupt()
  expect_type(res$run_id, "integer")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_match(paste(cell_of(s, "cell-1")$log, collapse = "\n"),
               "Error: Interrupted")
  # the same worker answers the next request
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
})

test_that("a late Stop after completion is a no_run_in_progress 409", {
  m <- make_test_session(c("# %%", "1 + 1"))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_error(s$interrupt(), "no run in progress")
  expect_equal(cell_of(s, "cell-1")$status, "done")
})

test_that("worker transport failure marks the active cell error and 503s", {
  m <- make_test_session(c("# %%", slow_body))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_cell("cell-1")
  wait_for(s, function() isTRUE(s$state()$runtime$busy))
  m$worker$kill()
  wait_until_settled(s)
  st <- s$state()
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_false(st$runtime$worker_available)
  expect_equal(st$last_action_error$code, "worker_unavailable")
  expect_error(s$run_cell("cell-1"), "worker is unavailable")
  # source editing stays available after a transport failure
  s$set_cell("cell-1", c("x <- 1"), "code", expected_revision = 0L)
  expect_equal(cell_of(s, "cell-1")$status, "stale")
})

test_that("log and visible-value truncation end with the exact markers", {
  m <- make_test_session(c(
    "# %%", "cat(paste(rep('x', 1048577), collapse = ''))",
    "# %%", "paste(rep('y', 262145), collapse = '')"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s, timeout = 15)
  c1 <- cell_of(s, "cell-1")
  expect_equal(c1$status, "done")
  log_text <- paste(c1$log, collapse = "")
  expect_match(log_text, "\\[output truncated at 1048576 bytes\\]$")
  c2 <- cell_of(s, "cell-2")
  expect_equal(c2$output$truncated, TRUE)
  expect_match(c2$output$text, "\\[output truncated at 262144 bytes\\]$")
})

test_that("table output is bounded to a 25x50 preview", {
  m <- make_test_session(c("# %%",
    "df <- as.data.frame(matrix(1:(30*60), nrow = 30, ncol = 60))",
    "# %%", "df"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_all()
  wait_until_settled(s)
  out <- cell_of(s, "cell-2")$output
  expect_equal(out$kind, "table")
  expect_equal(out$nrow, 30L)
  expect_equal(out$ncol, 60L)
  expect_equal(out$truncated_rows, TRUE)
  expect_equal(out$truncated_columns, TRUE)
  expect_equal(length(out$preview), 25L)
  expect_equal(length(out$preview[[1L]]), 50L)
})

test_that("a malformed worker line is a terminal transport failure", {
  fake_proc <- list(
    is_alive = function() TRUE,
    kill = function() invisible(),
    wait = function(t) invisible(),
    interrupt = function() invisible(),
    write_input = function(x) invisible()
  )
  fired <- 0L
  w <- Worker$new(fake_proc, "ws", "app", tempfile("art-"))
  dir.create(w$artifact_dir)
  w$set_on_failure(function(message) fired <<- fired + 1L)
  w$handle_line("this is not json")
  expect_equal(fired, 1L)
  expect_true(w$failed_once)
  # no second terminal transition for a later bad line
  w$handle_line("{\"req\": 1, \"cmd\": \"eval_cell\"}")
  expect_equal(fired, 1L)
})

test_that("a throwing response callback fails once and invokes on_failure", {
  m <- make_test_session(c("# %%", "1"))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  w <- m$worker
  fired <- 0L
  w$set_on_failure(function(message) fired <<- fired + 1L)
  w$send("ping", on_response = function(ctx, resp) stop("boom"))
  wait_for(s, function() fired >= 1L)
  expect_equal(fired, 1L)
  expect_true(w$failed_once)
})
test_that("malformed eval payloads from the worker are terminal transport failures", {
  # a table output missing required fields kills the worker (bounded schema)
  m <- make_test_session(c("# %%", slow_body))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_cell("cell-1")
  wait_for(s, function() isTRUE(s$state()$runtime$busy))
  req <- ls(m$worker$pending)
  expect_length(req, 1L)
  m$worker$handle_line(jsonlite::toJSON(
    list(req = as.integer(req), cmd = "eval_cell", id = "cell-1",
         run_id = 1L, revision = 0L, ok = TRUE,
         value = list(kind = "table", nrow = 1), log = list()),
    auto_unbox = TRUE, null = "null"))
  wait_until_settled(s)
  st <- s$state()
  expect_false(st$runtime$worker_available)
  expect_equal(st$last_action_error$code, "worker_unavailable")
  expect_equal(cell_of(s, "cell-1")$status, "error")

  # a widget output with an unknown spec kind is likewise terminal
  m2 <- make_test_session(c("# %%", "1"))
  s2 <- m2$session
  withr::defer(s2$stop(), testthat::teardown_env())
  s2$run_cell("cell-1")
  wait_for(s2, function() isTRUE(s2$state()$runtime$busy))
  req2 <- ls(m2$worker$pending)
  m2$worker$handle_line(jsonlite::toJSON(
    list(req = as.integer(req2), cmd = "eval_cell", id = "cell-1",
         run_id = 1L, revision = 0L, ok = TRUE,
         value = list(kind = "widget", name = "w", owner = "cell-1",
                      spec = list(kind = "nope")), log = list()),
    auto_unbox = TRUE, null = "null"))
  wait_until_settled(s2)
  expect_false(s2$state()$runtime$worker_available)
})

test_that("responses with unknown identity are a terminal transport failure", {
  m <- make_test_session(c("# %%", slow_body))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  s$run_cell("cell-1")
  wait_for(s, function() isTRUE(s$state()$runtime$busy))
  # a response for a request the worker never sent is a transport failure:
  # the worker cannot route it and the Session transitions to unavailable
  m$worker$handle_line(jsonlite::toJSON(
    list(req = 999L, cmd = "eval_cell", id = "cell-1",
         ok = TRUE, value = NULL, log = list()),
    auto_unbox = TRUE, null = "null"))
  wait_until_settled(s)
  st <- s$state()
  expect_false(st$runtime$worker_available)
  expect_equal(st$last_action_error$code, "worker_unavailable")
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_error(s$run_cell("cell-1"), "worker is unavailable")
  # source-cancelled runs keep discarding late responses: a widget edit
  # cancels the pending op, and the late commit cannot land (covered by
  # the widget-cancel test above); a late success for a finished run is
  # unreachable because the Worker consumes the request identity once.
})

