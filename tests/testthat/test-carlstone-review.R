# Requester-named deterministic regression file.
#
# Exercises three public clobber/rollback contracts against a real worker:
#  1. exact trailing-blank source replacement (blank retained vs removed)
#  2. a stale-revision edit leaves the acknowledged source unchanged
#  3. a failed rerun cannot leave a newly introduced global binding
# The public API for these behaviors is the misnamed-soon-to-change
# ui-value/rerun surface, so only the session public state machine is used:
# state(), set_cell(), add_cell(), run_cell(). No private fields, no
# source-code text assertions.

cell_of <- function(s, id) {
  st <- s$state()
  for (c in st$cells) if (identical(c$id, id)) return(c)
  stop("no such cell: ", id)
}

test_that("trailing-blank replacement round-trips exactly", {
  m <- make_test_session(c("# %%", "x <- 1"))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())

  rev0 <- cell_of(s, "cell-1")$revision

  # retaining an explicit trailing blank keeps it visible in state
  r1 <- s$set_cell("cell-1", c("x <- 1", ""), "code", rev0)
  expect_equal(r1$revision, rev0 + 1L)
  expect_identical(unclass(cell_of(s, "cell-1")$body), c("x <- 1", ""))

  # replacing that same body without the blank removes it exactly
  r2 <- s$set_cell("cell-1", c("x <- 1"), "code", r1$revision)
  expect_equal(r2$revision, r1$revision + 1L)
  expect_identical(unclass(cell_of(s, "cell-1")$body), c("x <- 1"))

  # re-adding the blank and then syncing back is a clean round-trip
  r3 <- s$set_cell("cell-1", c("x <- 1", ""), "code", r2$revision)
  expect_identical(unclass(cell_of(s, "cell-1")$body), c("x <- 1", ""))
  r4 <- s$set_cell("cell-1", c("x <- 1"), "code", r3$revision)
  expect_identical(unclass(cell_of(s, "cell-1")$body), c("x <- 1"))
})

test_that("stale-revision edit leaves acknowledged source unchanged", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "x + 1"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())

  rev0 <- cell_of(s, "cell-1")$revision
  ack <- s$set_cell("cell-1", c("x <- 2"), "code", rev0)
  expect_equal(cell_of(s, "cell-1")$revision, ack$revision)

  # the frontend re-sends the stale revision from before the acknowledged
  # edit: this must be rejected, not silently applied
  e <- tryCatch(s$set_cell("cell-1", c("x <- 999"), "code", rev0),
                error = identity)
  expect_s3_class(e, "alder_error")
  expect_identical(e$code, "source_conflict")

  # acknowledged source is untouched by the rejected edit
  c1 <- cell_of(s, "cell-1")
  expect_identical(unclass(c1$body), c("x <- 2"))
  expect_equal(c1$revision, ack$revision)
})

test_that("failed rerun cannot leave a newly introduced global binding", {
  m <- make_test_session(c(
    "# %%", "z <- 1",
    "# %%", "42"
  ))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())

  # cell-1 first defines z successfully
  s$run_all()
  wait_until_idle(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")

  call_run <- function(id) {
    s$run_cell(id)
    wait_until_idle(s)
  }

  # rerun cell-1 with a body that binds a NEW global q, then fails
  ack <- cell_of(s, "cell-1")$revision
  s$set_cell("cell-1", c("q <- 1", "stop('boom')"), "code", ack)
  call_run("cell-1")
  c1 <- cell_of(s, "cell-1")
  expect_equal(c1$status, "error")
  expect_match(paste(c1$log, collapse = "\n"), "boom")

  # probe with an independent leaf cell: the failed rerun left the cell with
  # NO bindings — neither the newly introduced q nor the pre-existing z from
  # the prior successful run survive (ls() avoids registering a literal-name
  # reference to q/z)
  probe <- s$add_cell(NULL, c("any(ls() %in% c('q', 'z'))"), "code")$id
  call_run(probe)
  expect_match(cell_of(s, probe)$output$text, "\\[1\\] FALSE")

  # positive control: repairing the cell restores the binding, so the worker
  # env is alive and the probe itself works
  ack2 <- cell_of(s, "cell-1")$revision
  s$set_cell("cell-1", c("z <- 1"), "code", ack2)
  call_run("cell-1")
  expect_equal(cell_of(s, "cell-1")$status, "done")
  prag <- cell_of(s, probe)
  s$set_cell(probe, c("any(ls() %in% 'z')"), "code", prag$revision)
  call_run(probe)
  expect_match(cell_of(s, probe)$output$text, "\\[1\\] TRUE")
})
