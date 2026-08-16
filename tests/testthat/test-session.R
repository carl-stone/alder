# Rerun model (ADR 0002) + worker integration: dep-ordered execution, stale
# marking on edit/delete/widget, explicit-run reruns, cancellation, and
# deterministic worker-exit handling.
testthat::local_edition(2)   # teardown() cleanup for spawned worker processes

new_test_session <- function(lines) {
  nb <- alder:::parse_notebook_lines("test.R", lines)
  artifact_dir <- tempfile("alder-test-artifacts-")
  dir.create(artifact_dir, recursive = TRUE)
  worker <- alder:::.spawn_worker(alder:::alder_worker_script(), getwd(),
                                  artifact_dir)
  testthat::teardown(function() {
    try(unlink(artifact_dir, recursive = TRUE), silent = TRUE)
    try(worker$kill(), silent = TRUE)
  })
  list(sess = alder:::Session$new(nb, worker), worker = worker)
}

wait_idle <- function(sess, timeout = 8) {
  deadline <- Sys.time() + timeout
  repeat {
    later::run_now(0.02)
    if (!sess$busy && length(sess$queue) == 0L) return(invisible(TRUE))
    if (Sys.time() > deadline) stop("timed out waiting for idle session")
  }
}

wait_until <- function(cond, what = "condition", timeout = 8) {
  deadline <- Sys.time() + timeout
  repeat {
    later::run_now(0.02)
    if (isTRUE(cond())) return(invisible(TRUE))
    if (Sys.time() > deadline) stop("timed out waiting for ", what)
  }
}

status_of <- function(sess, id) sess$status[[id]]

NB <- c(
  "# ---", "# title: demo", "# ---", "",
  "# %%", "raw <- data.frame(gene=c('a','b','c'), count=c(10, 500, 1000))", "",
  "# %%", "filtered <- subset(raw, count > 100)", "",
  "# %%", "n <- ui$slider(10, 1000, value=300)", "",
  "# %%", "big <- subset(raw, count > n)", "big"
)

test_that("run_all executes cells in dependency order and completes", {
  env <- new_test_session(NB)
  env$sess$run_all()
  wait_idle(env$sess)
  st <- env$sess$state()
  expect_equal(st$cells[[1]]$status, "done")
  expect_equal(st$cells[[2]]$status, "done")
  expect_equal(st$cells[[4]]$status, "done")
  # cell 2 (filtered) depends on cell 1 (raw); topo places 1 first
  expect_lt(match("cell-1", st$topo), match("cell-2", st$topo))
})

test_that("editing a cell marks it and transitive dependents stale", {
  env <- new_test_session(NB)
  env$sess$run_all()
  wait_idle(env$sess)
  env$sess$set_cell_body("cell-1",
    c("raw <- data.frame(gene=c('w','x','y','z'), count=c(1,50,500,2000))"))
  expect_equal(status_of(env$sess, "cell-1"), "stale")
  expect_equal(status_of(env$sess, "cell-2"), "stale")   # depends on raw
  expect_equal(status_of(env$sess, "cell-4"), "stale")   # depends on raw
  expect_equal(status_of(env$sess, "cell-3"), "done")    # defines n only
  # stale cells keep their previous output
  expect_equal(env$sess$output[["cell-4"]]$nrow, 2)
  expect_null(env$sess$output[["cell-2"]])   # invisible assignment: no output
})

test_that("running an edited cell reruns its stale dependents in order", {
  env <- new_test_session(NB)
  env$sess$run_all(); wait_idle(env$sess)
  env$sess$set_cell_body("cell-1",
    c("raw <- data.frame(gene=c('w','x','y','z'), count=c(4,50,500,2000))"))
  env$sess$run_cell("cell-1")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "done")
  expect_equal(status_of(env$sess, "cell-2"), "done")
  expect_equal(status_of(env$sess, "cell-4"), "done")
  # count > 300: only 500 and 2000 survive the stricter raw data
  expect_equal(env$sess$output[["cell-4"]]$nrow, 2)
})

test_that("done cells outside the stale region are not rerun", {
  env <- new_test_session(NB)
  env$sess$run_all(); wait_idle(env$sess)
  env$sess$set_cell_body("cell-3", "n <- ui$slider(10, 1000, value=500)")
  expect_equal(status_of(env$sess, "cell-4"), "stale")
  expect_equal(status_of(env$sess, "cell-1"), "done")
  env$sess$run_cell("cell-3")
  wait_idle(env$sess)
  # only the edited cell and its stale dependent ran
  expect_equal(status_of(env$sess, "cell-1"), "done")
  expect_equal(status_of(env$sess, "cell-2"), "done")
  expect_equal(status_of(env$sess, "cell-3"), "done")
  expect_equal(status_of(env$sess, "cell-4"), "done")
  expect_equal(env$sess$output[["cell-4"]]$nrow, 1)   # count > 300: 500? no -- 1000
})

test_that("old and new DAG descendants are invalidated together", {
  env <- new_test_session(c(
    "# %%", "a <- 1",
    "# %%", "b <- a + 1",
    "# %%", "c <- b + 1"))
  env$sess$run_all(); wait_idle(env$sess)
  # Renaming b's definition drops the b->a edge: c was a descendant of the
  # OLD DAG and must still turn stale, and stays stale after the run.
  env$sess$set_cell_body("cell-2", "bb <- 5")
  expect_equal(status_of(env$sess, "cell-2"), "stale")
  expect_equal(status_of(env$sess, "cell-3"), "stale")
  env$sess$run_cell("cell-2")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-2"), "done")
  expect_equal(status_of(env$sess, "cell-3"), "stale")  # no longer a descendant
  env$sess$run_cell("cell-3")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-3"), "error")  # b is gone from the env
})

test_that("changing a widget marks dependents stale without running them", {
  env <- new_test_session(NB)
  env$sess$run_all(); wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-4"), "done")
  expect_equal(env$sess$output[["cell-4"]]$nrow, 2)
  env$sess$set_widget("n", 900)
  wait_until(function() {
    ws <- env$sess$widgets[["cell-3"]]
    length(ws) > 0 && isTRUE(ws[[1]]$spec$.value == 900)
  }, "widget value mirrored")
  # stale, old output preserved, nothing executed implicitly
  expect_equal(status_of(env$sess, "cell-4"), "stale")
  expect_equal(env$sess$output[["cell-4"]]$nrow, 2)
  expect_equal(env$sess$widgets[["cell-3"]][[1]]$spec$.value, 900)
  expect_false(env$sess$busy)
  # explicit run re-evaluates the dependent with the new value
  env$sess$run_cell("cell-4")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-4"), "done")
  expect_equal(env$sess$output[["cell-4"]]$nrow, 1)
  expect_equal(status_of(env$sess, "cell-1"), "done")   # untouched cells
  expect_equal(status_of(env$sess, "cell-2"), "done")
})

test_that("the widget spec is owned by its defining cell and follows set_widget", {
  env <- new_test_session(NB)
  env$sess$run_all(); wait_idle(env$sess)
  st <- env$sess$state()
  w3 <- st$cells[[3]]$widgets
  expect_length(w3, 1)
  expect_equal(w3[[1]]$name, "n")
  expect_equal(w3[[1]]$spec$.value, 300)
  # inherited proxies are not re-reported by other cells
  expect_length(st$cells[[4]]$widgets, 0)
  env$sess$set_widget("n", 450)
  wait_until(function() env$sess$widgets[["cell-3"]][[1]]$spec$.value == 450,
             "widget value mirrored")
  st <- env$sess$state()
  expect_equal(st$cells[[3]]$widgets[[1]]$spec$.value, 450)
})

test_that("deleting a cell invalidates its dependents and clears its values", {
  env <- new_test_session(NB)
  env$sess$run_all(); wait_idle(env$sess)
  env$sess$delete_cell("cell-2")          # filtered: nobody reads it
  expect_null(env$sess$status[["cell-2"]])
  env$sess$delete_cell("cell-1")          # raw: cell-4 still reads it
  expect_equal(status_of(env$sess, "cell-4"), "stale")
  env$sess$run_cell("cell-4")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-4"), "error")  # raw is gone
})

test_that("markdown cells are marked done without executing (no NULL output)", {
  env <- new_test_session(c("# %% [markdown]", "# heading", "# %%", "x <- 1", "x"))
  env$sess$run_all(); wait_idle(env$sess)
  st <- env$sess$state()
  expect_equal(st$cells[[1]]$status, "done")
  expect_null(st$cells[[1]]$output)
  expect_equal(st$cells[[2]]$status, "done")
  expect_false(is.null(st$cells[[2]]$output))
})

test_that("list-shaped state fields serialize as JSON arrays", {
  env <- new_test_session(c("# %% [markdown]", "# heading", "# %%", "x <- 1"))
  env$sess$run_all(); wait_idle(env$sess)
  js <- jsonlite::toJSON(env$sess$state(), auto_unbox = TRUE,
                         null = "null", na = "null", force = TRUE)
  expect_true(grepl('"body":\\["# heading"\\]', js))
  expect_true(grepl('"edges":\\{"cell-1":\\[\\],"cell-2":\\[\\]\\}', js))
})

test_that("an erroring cell reports status=error without hanging", {
  env <- new_test_session(c("# %%", "stop('boom')", "", "# %%", "x <- 1"))
  env$sess$run_all()
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "error")
  expect_match(paste(env$sess$log[["cell-1"]], collapse = " "), "boom")
})

test_that("an upstream error cancels only its same-run descendants", {
  env <- new_test_session(c(
    "# %%", "x <- stop('boom')",
    "# %%", "y <- x + 1",
    "# %%", "z <- 9"))
  env$sess$run_all()
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "error")
  expect_equal(status_of(env$sess, "cell-2"), "idle")   # canceled, never ran
  expect_equal(status_of(env$sess, "cell-3"), "done")   # independent cell ran
})

test_that("an edited current cell cannot return to done", {
  env <- new_test_session(c("# %%", "Sys.sleep(0.8)", "x <- 1"))
  env$sess$run_cell("cell-1")
  wait_until(function() identical(status_of(env$sess, "cell-1"), "running"),
             "cell running")
  env$sess$set_cell_body("cell-1", "x <- 2")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "stale")
  expect_null(env$sess$output[["cell-1"]])
  expect_length(env$sess$log[["cell-1"]], 0)
  env$sess$run_cell("cell-1")            # worker still healthy
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "done")
})

test_that("a running dependent is canceled by an upstream edit", {
  env <- new_test_session(c(
    "# %%", "x <- 1",
    "# %%", "z <- Sys.sleep(1.5); z <- x * 2"))
  env$sess$run_all()
  wait_until(function() identical(status_of(env$sess, "cell-2"), "running"),
             "cell-2 running")
  env$sess$set_cell_body("cell-1", "x <- 10")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "stale")
  expect_equal(status_of(env$sess, "cell-2"), "stale")   # canceled mid-run
  env$sess$run_cell("cell-2")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-2"), "done")
})

test_that("deleting an upstream cell cancels its running dependent", {
  env <- new_test_session(c(
    "# %%", "x <- 1",
    "# %%", "z <- Sys.sleep(1.5); z <- x + 0"))
  env$sess$run_all()
  wait_until(function() identical(status_of(env$sess, "cell-2"), "running"),
             "cell-2 running")
  env$sess$delete_cell("cell-1")
  wait_idle(env$sess)
  expect_null(env$sess$status[["cell-1"]])
  expect_equal(status_of(env$sess, "cell-2"), "stale")
  env$sess$set_cell_body("cell-2", "z <- 4")
  env$sess$run_cell("cell-2")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-2"), "done")
})

test_that("jobs of another run id survive an edit-triggered cancel", {
  env <- new_test_session(c(
    "# %%", "Sys.sleep(0.8)", "x <- 1",
    "# %%", "y <- 2"))
  env$sess$run_cell("cell-1")            # run 1: slow cell runs
  wait_until(function() identical(status_of(env$sess, "cell-1"), "running"),
             "cell-1 running")
  env$sess$run_cell("cell-2")            # run 2: queued independently
  env$sess$set_cell_body("cell-1", "x <- 7")   # cancels run 1 only
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "stale")
  expect_equal(status_of(env$sess, "cell-2"), "done")
})

test_that("user Stop interrupts and leaves an error; later runs recover", {
  env <- new_test_session(c("# %%", "Sys.sleep(60)"))
  env$sess$run_cell("cell-1")
  wait_until(function() identical(status_of(env$sess, "cell-1"), "running"),
             "cell-1 running")
  env$sess$interrupt()
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "error")
  expect_match(paste(env$sess$log[["cell-1"]], collapse = " "), "Interrupted")
  expect_false(env$sess$busy)
  expect_null(env$sess$current)
  env$sess$set_cell_body("cell-1", "x <- 1")
  env$sess$run_cell("cell-1")
  wait_idle(env$sess)
  expect_equal(status_of(env$sess, "cell-1"), "done")
})

test_that("cat output lands in the cell log, never the protocol stream", {
  env <- new_test_session(c("# %%", "cat('hello from cell\\n')", "x <- 1"))
  env$sess$run_all(); wait_idle(env$sess)
  expect_match(paste(env$sess$log[["cell-1"]], collapse = "\n"), "hello from cell")
  expect_equal(status_of(env$sess, "cell-1"), "done")
})

test_that("removed definitions and cleared cells vanish from the worker env", {
  env <- new_test_session(c(
    "# %%", "x <- 1; y <- 2",
    "# %%", "z <- x + y"))
  env$sess$run_all(); wait_idle(env$sess)
  env$sess$request_value("y")
  wait_until(function() !is.null(env$sess$last_value), "first value")
  expect_true(env$sess$last_value$ok)
  # cell-1 redefined without y: the binding and its ownership must vanish
  env$sess$set_cell_body("cell-1", "x <- 3")
  env$sess$run_cell("cell-1")
  wait_idle(env$sess)
  env$sess$request_value("y")
  wait_until(function() !is.null(env$sess$last_value), "missing value")
  expect_false(env$sess$last_value$ok)
  expect_match(env$sess$last_value$error$message, "No such name")
  # delete_cell sends clear_cell: x must be gone from the worker
  env$sess$delete_cell("cell-1")
  wait_idle(env$sess)
  env$sess$request_value("x")
  wait_until(function() !is.null(env$sess$last_value), "cleared value")
  expect_false(env$sess$last_value$ok)
})

test_that("worker exit fails the active job and blocks further runs", {
  env <- new_test_session(c(
    "# %%", "q <- 1",
    "# %%", "quit(save = 'no')",
    "# %%", "after <- 2"))
  env$sess$run_all()
  wait_until(function() env$sess$worker_failed, "worker failure")
  # the crashing cell is terminal error; the queue is gone, no pump
  expect_equal(status_of(env$sess, "cell-2"), "error")
  expect_match(paste(env$sess$log[["cell-2"]], collapse = " "),
               "Worker exited before responding")
  expect_false(env$sess$worker$alive())
  expect_false(env$sess$busy)
  expect_null(env$sess$current)
  expect_length(env$sess$queue, 0)
  expect_error(env$sess$run_all(), "worker is not running")
  expect_error(env$sess$set_widget("q", 5), "worker is not running")
})

test_that("Session state exposes a self-edge/cycle for self-updates", {
  nb <- alder:::parse_notebook_lines("t.R", c("# %%", "x <- x + 1"))
  s <- alder:::Session$new(nb, worker = NULL)
  st <- s$state()
  expect_true("cell-1" %in% st$dag$edges[["cell-1"]])
  expect_true("cell-1" %in% st$dag$cycles)
  expect_null(st$topo)
  # the explicit target still runs even under a cycle
  expect_equal(s$run_targets("cell-1"), "cell-1")
})