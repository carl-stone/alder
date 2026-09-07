# Public host regression coverage for three clobber/rollback contracts:
#  1. exact trailing-blank source replacement (blank retained vs removed)
#  2. a stale-revision edit leaves the acknowledged source unchanged
#  3. a failed rerun cannot leave a newly introduced global binding
# Only the production host facade is used: state(), set_cell(), add_cell(),
# and run_cell().

cell_of <- function(s, id) {
  st <- s$state()
  for (c in st$cells) if (identical(c$id, id)) return(c)
  stop("no such cell: ", id)
}

# Visible-value record: the last element of the outputs array.
visible_output <- function(s, id) {
  out <- cell_of(s, id)$outputs
  if (is.null(out) || !length(out)) return(NULL)
  out[[length(out)]]
}

test_that("trailing-blank replacement round-trips exactly", {
  m <- make_test_session(c("# %%", "x <- 1"), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())

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
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())

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
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())

  # cell-1 first defines z successfully
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  expect_equal(cell_of(s, "cell-1")$status, "done")

  call_run <- function(id) {
    wait_for(s, function()
      !isTRUE(s$state()$runtime$analysisPending), timeout = 10)
    receipt <- s$run_cell(id)
    s$await_operation(receipt$run_id)
  }

  # rerun cell-1 with a body that binds a NEW global q, then fails
  ack <- cell_of(s, "cell-1")$revision
  s$set_cell("cell-1", c("q <- 1", "stop('boom')"), "code", ack)
  failure <- call_run("cell-1")
  expect_identical(failure$status, "done")
  c1 <- cell_of(s, "cell-1")
  expect_equal(c1$status, "error")
  expect_match(paste(c1$log, collapse = "\n"), "boom")

  # probe with an independent leaf cell: the failed rerun left the cell with
  # NO bindings — neither the newly introduced q nor the pre-existing z from
  # the prior successful run survive (ls() avoids registering a literal-name
  # reference to q/z)
  probe <- s$add_cell(NULL, c("any(ls() %in% c('q', 'z'))"), "code")$id
  expect_identical(call_run(probe)$status, "done")
  expect_match(visible_output(s, probe)$text, "\\[1\\] FALSE")

  # Positive control: repairing the cell restores the binding, so the Ark
  # environment is alive and the probe itself works.
  ack2 <- cell_of(s, "cell-1")$revision
  s$set_cell("cell-1", c("z <- 1"), "code", ack2)
  expect_identical(call_run("cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-1")$status, "done")
  prag <- cell_of(s, probe)
  s$set_cell(probe, c("any(ls() %in% 'z')"), "code", prag$revision)
  expect_identical(call_run(probe)$status, "done")
  expect_match(visible_output(s, probe)$text, "\\[1\\] TRUE")
})
