# Session/worker integration tests: the public state machine against a real
# worker process. Worker setup/pumping lives in helper-session.R.

test_that("value inspection rejects stale owners and discards invalidated responses", {
  m <- make_test_session(c("# %%", "x <- 2", "# %%", "y <- x * 3", "y"),
                         execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop())
  inspect <- function(name) {
    s$request_value(name)
    wait_for(s, function() !identical(s$state()$value_operation$status, "pending"))
    s$state()$last_value
  }
  s$run_all()
  wait_until_settled(s)
  expect_identical(inspect("y")$value$text, "[1] 6")
  old_output <- s$state()$cells[[2L]]$outputs
  s$set_cell("cell-1", "x <- 3", "code")
  stale <- s$state()
  expect_null(stale$last_value)
  expect_identical(stale$value_operation$error$code, "stale_value")
  expect_identical(stale$cells[[2L]]$outputs, old_output)
  rejected <- tryCatch(s$request_value("y"), alder_error = identity)
  expect_identical(rejected$code, "stale_value")
  expect_match(rejected$message, "Run its defining cell", fixed = TRUE)

  s$run_stale()
  wait_until_settled(s)
  expect_identical(inspect("y")$value$text, "[1] 9")
  # The worker may already have read the old value, but its response has not
  # been pumped. Editing its producer before that callback must invalidate it.
  s$request_value("y")
  s$set_cell("cell-1", "x <- 4", "code")
  wait_for(s, function() length(ls(m$worker$pending)) == 0L)
  expect_identical(s$state()$value_operation$error$code, "stale_value")
  expect_null(s$state()$last_value)
  s$run_stale()
  wait_until_settled(s)
  expect_identical(inspect("y")$value$text, "[1] 12")
  s$set_cell("cell-1", "x <- 5", "code")
  s$run_stale()
  # Pump only transport callbacks: freshness cannot depend on a client
  # reading an intermediate stale state before the rerun completes.
  wait_for(s, function() length(ls(m$worker$pending)) == 0L)
  expect_null(s$state()$last_value)
  expect_identical(inspect("y")$value$text, "[1] 15")
  s$set_cell_disabled("cell-2", TRUE)
  disabled <- tryCatch(s$request_value("y"), alder_error = identity)
  expect_identical(disabled$code, "stale_value")
  expect_null(s$state()$last_value)
})

# A slow-ish cell so Stop has time to land after the eval ack.
slow_body <- c("Sys.sleep(1.5)", "42")

# Wait until no cell is running (an eval request in flight).
wait_until_settled <- function(s, timeout = 10) {
  wait_for(s, function() { # nolint: object_usage_linter
    st <- s$state()
    !any(vapply(st$cells, function(c) identical(c$status, "running"), FALSE))
  }, timeout)
}

# Wait until a widget operation with this token reaches a terminal status.
wait_widget_done <- function(s, cell_id, token, timeout = 10) {
  wait_for(s, function() { # nolint: object_usage_linter
    out <- cell_of(s, cell_id)$output
    !is.null(out) && !is.null(out$operation) &&
      identical(out$operation$token, token) &&
      !identical(out$operation$status, "pending")
  }, timeout)
  invisible()
}

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

find_widget_output <- function(output, name) {
  if (!is.list(output)) return(NULL)
  if (identical(output$kind %||% NULL, "widget") &&
      identical(output$name %||% NULL, name)) return(output)
  if (identical(output$kind %||% NULL, "layout")) {
    for (child in output$children %||% list()) {
      found <- find_widget_output(child, name)
      if (!is.null(found)) return(found)
    }
  } else if (identical(output$kind %||% NULL, "lazy") &&
             !is.null(output$child)) {
    return(find_widget_output(output$child, name))
  }
  NULL
}

cell_widget <- function(s, id, name) {
  cell <- cell_of(s, id)
  for (output in cell$outputs %||% list()) {
    found <- find_widget_output(output, name)
    if (!is.null(found)) return(found)
  }
  NULL
}

test_that("worker executes cells end to end with visible values", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "x * 2"
  ))
  s <- m$session
  withr::defer(s$stop())
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

test_that("summary results render as text instead of erroring as tables", {
  m <- make_test_session(c(
    "# %%", "peng <- iris",
    "# %%", "summary(peng$Sepal.Length)"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  c2 <- cell_of(s, "cell-2")
  expect_equal(c2$status, "done")
  expect_equal(c2$output$kind, "text")
  expect_match(c2$output$text, "Min\\.")
  expect_match(c2$output$text, "Max\\.")
})

test_that("top-level functions have .GlobalEnv as their environment", {
  m <- make_test_session(c(
    "# %%", "f <- function() 1",
    "# %%", "environmentName(environment(f))"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  expect_match(cell_of(s, "cell-2")$output$text, "R_GlobalEnv")
})

test_that("worker bootstrap bindings never enter the notebook global environment", {
  sandbox <- tempfile("alder-worker-library-")
  dir.create(sandbox)
  m <- make_test_session(c(
    "# %%",
    "project_lib <- 'notebook project value'",
    "sandbox_lib <- 42L",
    "# %%",
    "paste(project_lib, sandbox_lib)"
  ), worker_env = c(ALDER_SANDBOX_LIB = sandbox))
  s <- m$session
  w <- m$worker
  withr::defer(s$stop())

  response <- NULL
  w$send("env_snapshot", on_response = function(context, value) {
    response <<- value
  })
  wait_for(NULL, function() !is.null(response))
  expect_true(response$ok)
  globals <- vapply(response$variables, function(variable) variable$name,
                    character(1))
  internal <- c(
    "sandbox_lib", "project_lib", "isolated", "ui_module",
    "artifact_dir", "cache_dir", "notebook_dir", "NB_ENV", "CELL_DEFS",
    "CELL_LOCALS", "NAME_OWNER"
  )
  expect_length(intersect(globals, internal), 0L)

  s$run_all()
  wait_until_settled(s)
  expect_identical(cell_of(s, "cell-2")$output$text,
                   "[1] \"notebook project value 42\"")

  response <- NULL
  w$send("env_snapshot", on_response = function(context, value) {
    response <<- value
  })
  wait_for(s, function() !is.null(response))
  globals <- vapply(response$variables, function(variable) variable$name,
                    character(1))
  expect_setequal(intersect(globals, internal),
                  c("project_lib", "sandbox_lib"))
})

test_that("base graphics layers one page and retains independent pages", {
  m <- make_test_session(c(
    "# %%",
    "plot(1:6, type = 'b', col = '#176B87', main = 'layered')",
    "abline(h = 3.5, col = '#B42318', lty = 2, lwd = 2)",
    "lines(1:6, 6:1, col = '#176B87')",
    "title(sub = 'all layers retained')",
    "legend('topleft', legend = 'threshold', col = '#B42318', lty = 2)",
    "# %%",
    "plot(1:6, type = 'b', col = '#176B87', main = 'layered')",
    "# %%",
    "plot(1:3, main = 'first independent plot')",
    "plot(3:1, main = 'second independent plot')",
    "# %%",
    "old_mfrow <- graphics::par(mfrow = c(1, 2))",
    "plot(1:3, main = 'left panel')",
    "plot(3:1, main = 'right panel')",
    "invisible(graphics::par(old_mfrow))",
    "# %%",
    "length(grDevices::dev.list())"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)

  layered <- cell_of(s, "cell-1")
  plain <- cell_of(s, "cell-2")
  independent <- cell_of(s, "cell-3")
  multipanel <- cell_of(s, "cell-4")
  expect_identical(layered$status, "done")
  expect_identical(plain$status, "done")
  expect_identical(independent$status, "done")
  expect_length(layered$outputs, 1L)
  expect_length(plain$outputs, 1L)
  expect_length(independent$outputs, 2L)
  expect_length(multipanel$outputs, 1L)
  expect_true(all(vapply(
    c(layered$outputs, plain$outputs, independent$outputs,
      multipanel$outputs),
    function(output) identical(output$kind, "image"), logical(1)
  )))

  layered_file <- file.path(m$worker$artifact_dir,
                            layered$outputs[[1L]]$artifact)
  plain_file <- file.path(m$worker$artifact_dir, plain$outputs[[1L]]$artifact)
  expect_true(file.exists(layered_file))
  expect_true(file.exists(plain_file))
  expect_false(identical(unname(tools::md5sum(layered_file)),
                         unname(tools::md5sum(plain_file))))
  # The next cell sees only its own capture device; no prior cell device leaked.
  expect_identical(cell_of(s, "cell-5")$output$text, "[1] 1")

  s$set_cell("cell-5", c(
    "plot(1:3)",
    "lines(1:2, 1:3)"
  ), "code", expected_revision = 0L)
  s$run_cell("cell-5")
  wait_until_settled(s)
  graphics_error <- cell_of(s, "cell-5")
  expect_identical(graphics_error$status, "error")
  expect_match(paste(graphics_error$log, collapse = "\n"),
               "lengths differ", fixed = TRUE)
  expect_true("simpleError" %in%
                unlist(graphics_error$error$class, use.names = FALSE))
  expect_match(graphics_error$error$call, "xy.coords|lines")

  s$set_cell("cell-5", "length(grDevices::dev.list())", "code",
             expected_revision = 1L)
  s$run_cell("cell-5")
  wait_until_settled(s)
  expect_identical(cell_of(s, "cell-5")$output$text, "[1] 1")
})

test_that("renderer failures preserve concrete causes and release devices", {
  m <- make_test_session(c(
    "# %%",
    "bad <- structure(list(), class = c('gg', 'ggplot'))",
    "bad"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop())

  s$run_cell("cell-1")
  wait_until_settled(s)
  error <- cell_of(s, "cell-1")
  expect_identical(error$status, "error")
  expect_match(error$error$message, "grid.draw", fixed = TRUE)
  expect_false(grepl("could not render plot", error$error$message,
                     fixed = TRUE))

  s$set_cell("cell-1", c(
    "bad <- structure(list(), class = 'htmlwidget')",
    "bad"
  ), "code", expected_revision = 0L)
  s$run_cell("cell-1")
  wait_until_settled(s)
  error <- cell_of(s, "cell-1")
  expect_identical(error$status, "error")
  expect_match(error$error$message, "invalid type/length", fixed = TRUE)
  expect_false(grepl("could not render htmlwidget", error$error$message,
                     fixed = TRUE))

  s$set_cell("cell-1", c(
    "bad <- structure(list('not a display list'), class = 'recordedplot')",
    "bad"
  ), "code", expected_revision = 1L)
  s$run_cell("cell-1")
  wait_until_settled(s)
  error <- cell_of(s, "cell-1")
  expect_identical(error$status, "error")
  expect_match(error$error$message, "recursive indexing failed", fixed = TRUE)
  expect_false(grepl("could not render recorded plot", error$error$message,
                     fixed = TRUE))

  s$set_cell("cell-1", "length(grDevices::dev.list())", "code",
             expected_revision = 2L)
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_identical(cell_of(s, "cell-1")$output$text, "[1] 1")
})

test_that("startup autorun executes all cells; graph rejection is recorded", {
  m <- make_test_session(c(
    "# %%", "a <- 1",
    "# %%", "b <- a"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop())
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")

  # run_on_startup = FALSE leaves every code cell idle
  m2 <- make_test_session(c("# %%", "a <- 1"), run_on_startup = FALSE)
  s2 <- m2$session
  withr::defer(s2$stop())
  expect_equal(cell_of(s2, "cell-1")$status, "idle")
  expect_equal(m2$worker$counter, 2L)  # readiness ping only; no cell request

  # a startup graph rejection records last_action_error and stays editable
  m3 <- make_test_session(c("# %%", "a <- 1", "# %%", "a <- 2"),
                          run_on_startup = TRUE)
  s3 <- m3$session
  withr::defer(s3$stop())
  st <- s3$state()
  expect_equal(st$last_action_error$code, "graph_invalid")
  expect_match(st$last_action_error$message, "duplicate definitions")
  expect_equal(cell_of(s3, "cell-1")$status, "idle")
})

test_that("disabled cells keep outputs, block descendants, and resume on enable", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "y <- x + 1",
    "# %%", "y + 1"
  ))
  s <- m$session
  withr::defer(s$stop())

  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 3")

  result <- s$set_cell_disabled("cell-2", TRUE)
  expect_true(result$disabled)
  expect_true(s$state()$cells[[2L]]$disabled)
  expect_equal(cell_of(s, "cell-2")$status, "disabled")
  expect_equal(cell_of(s, "cell-3")$status, "stale")
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 3")

  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "disabled")
  expect_equal(cell_of(s, "cell-3")$status, "stale")

  result <- s$set_cell_disabled("cell-2", FALSE)
  expect_false(result$disabled)
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_equal(cell_of(s, "cell-3")$status, "done")
  expect_equal(cell_of(s, "cell-3")$output$text, "[1] 3")
})


test_that("cell names validate and duplicate names warn without blocking", {
  m <- make_test_session(c(
    "# %%", "#| name: first", "x <- 1",
    "# %%", "#| name: first", "x + 1"
  ), run_on_startup = FALSE)
  s <- m$session
  withr::defer(s$stop())

  diagnostics <- lapply(s$state()$cells, function(cell) cell$diagnostics)
  expect_true(all(vapply(
    diagnostics,
    function(items) any(vapply(items, function(d)
      identical(d$code, "duplicate-cell-name"), FALSE)),
    FALSE
  )))
  expect_silent(s$run_all())
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "done")

  expect_error(
    s$set_cell_name("cell-1", "not valid"),
    "cell name must match"
  )
  s$set_cell_name("cell-1", "renamed_1")
  expect_equal(s$state()$cells[[1L]]$options$name, "renamed_1")
  s$set_cell_name("cell-1", NULL)
  expect_null(s$state()$cells[[1L]]$options$name)
})

test_that("runtime updates persist both runtime fields in notebook metadata", {
  m <- make_test_session(c("# %%", "x <- 1"))
  s <- m$session
  withr::defer(s$stop())

  expect_error(s$set_runtime(), "provide execution_mode")
  s$set_runtime(run_on_startup = FALSE)
  expect_identical(s$state()$runtime$execution_mode, "automatic")
  expect_false(s$state()$runtime$run_on_startup)
  expect_identical(
    s$state()$metadata$runtime,
    list(execution_mode = "automatic", run_on_startup = FALSE)
  )
  s$set_runtime(execution_mode = "lazy")
  expect_identical(s$state()$runtime$execution_mode, "lazy")
  expect_false(s$state()$runtime$run_on_startup)
})
test_that("duplicate definitions and cycles dispatch nothing", {
  m <- make_test_session(c("# %%", "a <- 1", "# %%", "a <- 2"),
                         run_on_startup = FALSE)
  s <- m$session
  withr::defer(s$stop())
  expect_error(s$run_all(), "duplicate definitions")
  expect_equal(m$worker$counter, 2L)  # readiness ping only

  m2 <- make_test_session(c("# %%", "a <- b", "# %%", "b <- a"),
                          run_on_startup = FALSE)
  s2 <- m2$session
  withr::defer(s2$stop())
  expect_error(s2$run_all(), "dependency cycle")
  expect_equal(m2$worker$counter, 2L)  # readiness ping only
})

test_that("automatic mode reruns every descendant after an edit", {
  m <- make_test_session(c(
    "# %%", "n <- 1",
    "# %%", "m <- n + 1",
    "# %%", "m * 10"
  ))
  s <- m$session
  withr::defer(s$stop())
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

test_that("sessions expose only R code and markdown cell types", {
  m <- make_test_session(c("# %%", "x <- 1"), run_on_startup = FALSE)
  s <- m$session
  withr::defer(s$stop())
  expect_error(
    s$set_cell("cell-1", "SELECT 1", "sql"),
    "cell type must be \\\"code\\\" or \\\"markdown\\\"",
    class = "alder_error"
  )
  expect_error(
    s$add_cell(body = "SELECT 1", type = "sql"),
    "cell type must be \\\"code\\\" or \\\"markdown\\\"",
    class = "alder_error"
  )
})

test_that("source revisions reject lossy numeric preconditions without mutation", {
  m <- make_test_session(c("# %%", "x <- 1"), run_on_startup = FALSE)
  s <- m$session
  withr::defer(s$stop())
  initial <- s$state()$cells[[1L]]
  invalid <- c(0.5, -1, .Machine$integer.max + 1, Inf, -Inf, NaN)
  for (revision in invalid) {
    expect_no_warning(expect_error(
      s$set_cell("cell-1", "x <- 2", "code", expected_revision = revision),
      "expected_revision must be a non-negative integer", class = "alder_error"
    ))
    current <- s$state()$cells[[1L]]
    expect_identical(current$body, initial$body)
    expect_identical(current$revision, initial$revision)
  }
  expect_no_warning(expect_error(
    s$delete_cell("cell-1", expected_revision = 0.5),
    "expected_revision must be a non-negative integer", class = "alder_error"
  ))
  expect_identical(s$state()$cells[[1L]]$body, initial$body)
  expect_identical(s$state()$cells[[1L]]$revision, initial$revision)

  updated <- s$set_cell("cell-1", "x <- 2", "code", expected_revision = 0)
  expect_identical(updated$revision, 1L)
  expect_error(
    s$set_cell("cell-1", "x <- 3", "code", expected_revision = 0),
    "changed on the server", class = "alder_error"
  )
  expect_identical(unclass(s$state()$cells[[1L]]$body), "x <- 2")
  expect_identical(s$state()$cells[[1L]]$revision, 1L)
})

test_that("lazy mode leaves descendants stale and runs stale ancestors first", {
  m <- make_test_session(c(
    "# %%", "n <- 1",
    "# %%", "y <- n + 1", "y"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop())
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
  withr::defer(s$stop())
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

test_that("nested runtime errors preserve condition class, call, and traceback", {
  m <- make_test_session(c(
    "# %%",
    "inner_failure <- function() stop('deep failure')",
    "outer_failure <- function() inner_failure()",
    "outer_failure()"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  cell <- cell_of(s, "cell-1")
  expect_identical(cell$status, "error")
  expect_match(paste(cell$log, collapse = "\n"), "deep failure", fixed = TRUE)
  expect_true("simpleError" %in% unlist(cell$error$class, use.names = FALSE))
  expect_match(cell$error$call, "inner_failure", fixed = TRUE)
  expect_gt(length(unlist(cell$error$trace, use.names = FALSE)), 0L)
  expect_lte(length(unlist(cell$error$trace, use.names = FALSE)), 40L)
})

test_that("widgets require an owned binding before they render", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "ui$slider(min = 0, max = 1)"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$status, "error")
  expect_match(paste(cell_of(s, "cell-2")$log, collapse = "\n"),
               "must be assigned in this cell")
})

test_that("layout widget records update recursively without disturbing siblings", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "h_slider <- ui$slider(1, 9, value = 2)",
    "h_run <- ui$run_button(label = 'H run')",
    "out$hstack(h_slider, h_slider, h_run)",
    "# %%", "sprintf('H=%d', h_slider$value * 10)",
    "# %%", paste0(
      "sprintf('RUN=%s stamp=%.6f', h_run$value, ",
      "as.numeric(Sys.time()))"
    ),
    "# %%", "v_slider <- ui$slider(0, 1, value = 0)",
    "v_check <- ui$checkbox(FALSE)",
    "out$vstack(v_slider, v_check)",
    "# %%", "if (v_slider$value == 1) stop('EXPECTED_LAYOUT_ERROR')",
    "sprintf('V=%d/%s', v_slider$value, v_check$value)",
    "# %%", "t_slider <- ui$slider(10, 20, value = 12)",
    "out$tabs(Slider = t_slider)",
    "# %%", "sprintf('T=%d', t_slider$value)",
    "# %%", "c_slider <- ui$slider(100, 110, value = 103)",
    "out$callout(c_slider)",
    "# %%", "sprintf('C=%d', c_slider$value)",
    "# %%", "a_slider <- ui$slider(30, 40, value = 32)",
    "out$accordion(Control = a_slider, Evidence = out$md('Accordion note'))",
    "# %%", "sprintf('A=%d', a_slider$value)",
    "# %%", "s_check <- ui$checkbox(FALSE)",
    "out$sidebar(s_check, out$md('Sidebar note'))",
    "# %%", "sprintf('S=%s', s_check$value)"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)

  token <- s$set_widget("h_slider", list(value = 3), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  h_layout <- cell_of(s, "cell-2")$output
  h_sliders <- h_layout$children[vapply(
    h_layout$children,
    function(child) identical(child$name %||% NULL, "h_slider"),
    logical(1)
  )]
  expect_length(h_sliders, 2L)
  expect_true(all(vapply(h_sliders, function(widget) {
    identical(widget$spec$value, 3) &&
      identical(widget$operation$status, "done")
  }, logical(1))))
  expect_false(cell_widget(s, "cell-2", "h_run")$spec$value)
  expect_identical(cell_of(s, "cell-3")$output$text, "[1] \"H=30\"")

  run_once <- function() {
    token <- s$set_widget("h_run", list(value = TRUE), "editor")
    wait_for(s, function() {
      operation <- s$widget_operation(token)
      !is.null(operation) && identical(operation$status, "done") &&
        !is.null(operation$reset_token) && !s$state()$runtime$busy
    })
    wait_for(s, function() {
      widget <- cell_widget(s, "cell-2", "h_run")
      identical(widget$spec$value, FALSE) &&
        identical(widget$operation$status, "done") &&
        widget$operation$token > token
    })
    cell_of(s, "cell-4")$output$text
  }
  first_run <- run_once()
  expect_match(first_run, "RUN=TRUE", fixed = TRUE)
  Sys.sleep(0.01)
  second_run <- run_once()
  expect_match(second_run, "RUN=TRUE", fixed = TRUE)
  expect_false(identical(second_run, first_run))

  token <- s$set_widget("v_slider", list(value = 1), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  expect_identical(cell_of(s, "cell-6")$status, "error")
  expect_match(paste(cell_of(s, "cell-6")$log, collapse = "\n"),
               "EXPECTED_LAYOUT_ERROR", fixed = TRUE)
  expect_false(cell_widget(s, "cell-5", "v_check")$spec$value)

  token <- s$set_widget("v_slider", list(value = 0), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  expect_identical(cell_of(s, "cell-6")$status, "done")
  expect_identical(cell_of(s, "cell-6")$output$text,
                   "[1] \"V=0/FALSE\"")

  token <- s$set_widget("t_slider", list(value = 15), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  expect_identical(cell_widget(s, "cell-7", "t_slider")$spec$value, 15)
  expect_identical(cell_of(s, "cell-8")$output$text, "[1] \"T=15\"")

  token <- s$set_widget("c_slider", list(value = 104), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  expect_identical(cell_widget(s, "cell-9", "c_slider")$spec$value, 104)
  expect_identical(cell_of(s, "cell-10")$output$text, "[1] \"C=104\"")

  accordion_sibling <- cell_of(s, "cell-11")$output$children[[2L]]
  token <- s$set_widget("a_slider", list(value = 33), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  accordion <- cell_of(s, "cell-11")$output
  expect_identical(cell_widget(s, "cell-11", "a_slider")$spec$value, 33)
  expect_identical(cell_of(s, "cell-12")$output$text, "[1] \"A=33\"")
  expect_identical(accordion$children[[2L]], accordion_sibling)

  sidebar_sibling <- cell_of(s, "cell-13")$output$children[[2L]]
  token <- s$set_widget("s_check", list(value = TRUE), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  sidebar <- cell_of(s, "cell-13")$output
  expect_true(cell_widget(s, "cell-13", "s_check")$spec$value)
  expect_identical(cell_of(s, "cell-14")$output$text, "[1] \"S=TRUE\"")
  expect_identical(sidebar$children[[2L]], sidebar_sibling)
  expect_true(s$state()$runtime$worker_available)
})

test_that("resolved lazy layout widgets are current and recursively mutable", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "lazy_slider <- ui$slider(1, 9, value = 2)",
    "out$lazy(function() out$hstack(lazy_slider, lazy_slider), 'Open')",
    "# %%", "lazy_slider$value * 10"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  key <- cell_of(s, "cell-2")$output$key
  s$request_lazy(key)
  wait_for(s, function() !is.null(cell_of(s, "cell-2")$output$child))

  token <- s$set_widget("lazy_slider", list(value = 4), "editor")
  wait_for(s, function() {
    identical(s$widget_operation(token)$status, "done") &&
      !s$state()$runtime$busy
  })
  lazy <- cell_of(s, "cell-2")$output
  widgets <- lazy$child$children
  expect_length(widgets, 2L)
  expect_true(all(vapply(widgets, function(widget) {
    identical(widget$spec$value, 4) &&
      identical(widget$operation$status, "done")
  }, logical(1))))
  expect_identical(cell_of(s, "cell-3")$output$text, "[1] 40")
})

test_that("nested widget cancellation and worker failure are terminal", {
  make_lines <- function() c(
    "# %%", "library(alder)",
    "# %%", "nested <- ui$slider(0, 10, value = 5)",
    "peer <- ui$checkbox(FALSE)",
    "out$vstack(nested, peer)",
    "# %%", "nested$value"
  )
  m <- make_test_session(make_lines())
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  token <- s$set_widget("nested", list(value = 9), "editor")
  s$set_cell(
    "cell-2",
    c("nested <- ui$slider(0, 10, value = 6)",
      "peer <- ui$checkbox(FALSE)", "out$vstack(nested, peer)"),
    "code", expected_revision = 0L
  )
  expect_identical(s$widget_operation(token)$status, "cancelled")
  expect_identical(
    cell_widget(s, "cell-2", "nested")$operation$status, "cancelled")
  expect_false(cell_widget(s, "cell-2", "peer")$spec$value)

  failed <- make_test_session(make_lines())
  failed_session <- failed$session
  withr::defer(failed_session$stop())
  failed_session$run_all()
  wait_until_settled(failed_session)
  failed_token <- failed_session$set_widget(
    "nested", list(value = 8), "editor")
  failed$worker$kill()
  wait_for(failed_session, function() {
    identical(failed_session$widget_operation(failed_token)$status, "error")
  })
  operation <- cell_widget(failed_session, "cell-2", "nested")$operation
  expect_identical(operation$status, "error")
  expect_identical(operation$error$code, "worker_unavailable")
  expect_false(failed_session$state()$runtime$worker_available)
})

test_that("slider updates rerun consumers automatically", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "min_wt <- ui$slider(min = 0, max = 10, value = 5)", "min_wt",
    "# %%", "min_wt$value * 2"
  ))
  s <- m$session
  withr::defer(s$stop())
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
  withr::defer(s$stop())
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
  withr::defer(s2$stop())
  s2$run_all()
  wait_until_settled(s2)
  tok <- s2$set_widget("d", list(index = 2L), "editor")
  wait_widget_done(s2, "cell-2", tok)
  wait_until_settled(s2)
  expect_equal(cell_of(s2, "cell-2")$output$spec$value, 2)
  expect_equal(cell_of(s2, "cell-3")$output$text, "[1] \"double\"")
})

test_that("vector-valued composite widgets round-trip and update", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%",
    "controls <- ui$dictionary(",
    "  range = ui$range_slider(0, 10, value = c(2, 8)),",
    "  dates = ui$date_range(as.Date(c('2026-09-01', '2026-09-03'))),",
    "  multi = ui$multiselect(c('a', 'b', 'c'), value = 'a'),",
    "  rows = ui$table(head(iris, 4), selection = 'multi')",
    ")",
    "controls",
    "# %%",
    "paste(",
    "  paste(controls$value$range, collapse = '-'),",
    "  paste(as.character(controls$value$dates), collapse = '-'),",
    "  paste(controls$value$multi, collapse = '-'),",
    "  nrow(controls$value$rows),",
    "  sep = '|'",
    ")"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)

  widget_child <- function(name) {
    output <- cell_of(s, "cell-2")$output
    index <- which(vapply(output$spec$children, function(child) {
      identical(child$name, name)
    }, logical(1L)))
    output$spec$children[[index[[1L]]]]
  }
  wait_nested_widget <- function(name, token) {
    key <- paste(c("controls", name), collapse = "\001")
    wait_for(s, function() {
      operation <- cell_of(s, "cell-2")$output$operations[[key]]
      !is.null(operation) && identical(operation$token, token) &&
        !identical(operation$status, "pending")
    }, 10)
  }

  expect_true(s$state()$runtime$worker_available)
  expect_equal(widget_child("range")$value, c(2, 8))
  expect_equal(widget_child("dates")$value,
               c("2026-09-01", "2026-09-03"))
  expect_equal(as.vector(widget_child("multi")$value), "a")
  state_json <- jsonlite::toJSON(
    s$state(), auto_unbox = TRUE, null = "null", na = "null", force = TRUE
  )
  expect_true(grepl('"indices":[1]', state_json, fixed = TRUE))
  expect_true(grepl('"selected":[]', state_json, fixed = TRUE))

  token <- s$set_widget(
    "controls", path = "range", update = list(value = list(3, 7)),
    source = "editor"
  )
  wait_nested_widget("range", token)
  wait_until_settled(s)
  expect_equal(widget_child("range")$value, c(3, 7))

  token <- s$set_widget(
    "controls", path = "dates",
    update = list(value = list("2026-09-02", "2026-09-04")),
    source = "editor"
  )
  wait_nested_widget("dates", token)
  wait_until_settled(s)
  expect_equal(widget_child("dates")$value,
               c("2026-09-02", "2026-09-04"))

  token <- s$set_widget(
    "controls", path = "multi", update = list(indices = list(2L, 3L)),
    source = "editor"
  )
  wait_nested_widget("multi", token)
  wait_until_settled(s)
  expect_equal(as.vector(widget_child("multi")$value), c("b", "c"))

  token <- s$set_widget(
    "controls", path = "rows", update = list(selected = list(1L, 3L)),
    source = "editor"
  )
  wait_nested_widget("rows", token)
  wait_until_settled(s)
  expect_equal(widget_child("rows")$selected, c(1L, 3L))
  expect_equal(cell_of(s, "cell-3")$output$text,
               "[1] \"3-7|2026-09-02-2026-09-04|b-c|2\"")

  token <- s$set_widget(
    "controls", path = "multi", update = list(indices = list(1L)),
    source = "editor"
  )
  wait_nested_widget("multi", token)
  wait_until_settled(s)
  token <- s$set_widget(
    "controls", path = "rows", update = list(selected = list(2L)),
    source = "editor"
  )
  wait_nested_widget("rows", token)
  wait_until_settled(s)
  state_json <- jsonlite::toJSON(
    s$state(), auto_unbox = TRUE, null = "null", na = "null", force = TRUE
  )
  expect_true(grepl('"indices":[1]', state_json, fixed = TRUE))
  expect_true(grepl('"selected":[2]', state_json, fixed = TRUE))
  expect_equal(as.vector(widget_child("multi")$value), "a")
  expect_equal(as.integer(widget_child("rows")$selected), 2L)
  expect_equal(cell_of(s, "cell-3")$output$text,
               "[1] \"3-7|2026-09-02-2026-09-04|a|1\"")

  expect_error(
    s$set_widget("controls", "range",
                 list(value = list(lower = 3, upper = 7)), "editor"),
    "range widget value required"
  )
  expect_error(
    s$set_widget("controls", "dates", list(value = list(
      start = "2026-09-02", end = "2026-09-04"
    )), "editor"),
    "temporal widget value required"
  )
  expect_error(
    s$set_widget("controls", "multi",
                 list(indices = list(first = 1L)), "editor"),
    "choice indices must be positive integers"
  )
  expect_error(
    s$set_widget("controls", "rows",
                 list(selected = list(second = 2L)), "editor"),
    "table selection must be integer indices"
  )
  expect_equal(cell_of(s, "cell-3")$output$text,
               "[1] \"3-7|2026-09-02-2026-09-04|a|1\"")
  expect_true(s$state()$runtime$worker_available)
})

test_that("datetime widgets round-trip canonical UTC values and bounds", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%",
    paste0(
      "stamp <- ui$datetime(as.POSIXct('2026-09-03 12:00:00', ",
      "tz = 'America/New_York'),"
    ),
    paste0(
      "  min = as.POSIXct('2026-09-03 11:00:00', ",
      "tz = 'America/New_York'),"
    ),
    paste0(
      "  max = as.POSIXct('2026-09-03 14:00:00', ",
      "tz = 'America/New_York'))"
    ),
    "stamp",
    "# %%",
    "format(stamp$value, '%Y-%m-%dT%H:%M:%SZ', tz = 'UTC')"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)

  output <- cell_of(s, "cell-2")$output
  expect_equal(output$spec$value, "2026-09-03T16:00:00Z")
  expect_equal(output$spec$min, "2026-09-03T15:00:00Z")
  expect_equal(output$spec$max, "2026-09-03T18:00:00Z")
  expect_equal(cell_of(s, "cell-3")$output$text,
               "[1] \"2026-09-03T16:00:00Z\"")

  token <- s$set_widget(
    "stamp", list(value = "2026-09-03T17:30:45Z"), "editor"
  )
  wait_widget_done(s, "cell-2", token)
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-2")$output$spec$value,
               "2026-09-03T17:30:45Z")
  expect_equal(cell_of(s, "cell-3")$output$text,
               "[1] \"2026-09-03T17:30:45Z\"")

  for (invalid in c(
    "2026-09-03T17:30:45",
    "2026-09-03T17:30:45-04:00",
    "2026-02-30T17:30:45Z",
    "2026-09-03T17:30:45.500Z",
    "2026-09-03T17:30:45Zjunk"
  )) {
    expect_error(
      s$set_widget("stamp", list(value = invalid), "editor"),
      "temporal widget value required"
    )
  }
  expect_equal(cell_of(s, "cell-2")$output$spec$value,
               "2026-09-03T17:30:45Z")
  expect_true(s$state()$runtime$worker_available)
})

test_that("root and nested form drafts commit only on submit", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "entry <- ui$form(ui$text_input('before'))", "entry",
    "# %%", "paste(entry$value, sprintf('%.6f', as.numeric(Sys.time())))",
    "# %%",
    paste0(
      "controls <- ui$dictionary(submitted = ",
      "ui$form(ui$text_input('draft'), submit_label = 'Commit'))"
    ),
    "controls",
    "# %%",
    paste0(
      "paste(controls$value$submitted, ",
      "sprintf('%.6f', as.numeric(Sys.time())))"
    )
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)

  wait_operation <- function(cell_id, name, path, token) {
    key <- paste(c(name, path), collapse = "\001")
    wait_for(s, function() {
      output <- cell_of(s, cell_id)$output
      operation <- if (length(path)) {
        output$operations[[key]]
      } else {
        output$operation
      }
      !is.null(operation) && identical(operation$token, token) &&
        !identical(operation$status, "pending")
    }, 10)
  }

  root_before <- cell_of(s, "cell-3")$output$text
  token <- s$set_widget("entry", list(value = "after"), "editor")
  wait_operation("cell-2", "entry", character(), token)
  root_draft <- cell_of(s, "cell-2")$output$spec
  expect_equal(root_draft$child$value, "after")
  expect_true(root_draft$dirty)
  expect_null(root_draft$value)
  expect_equal(cell_of(s, "cell-3")$output$text, root_before)
  expect_false(s$state()$runtime$busy)

  token <- s$set_widget("entry", list(submit = TRUE), "editor")
  wait_operation("cell-2", "entry", character(), token)
  wait_until_settled(s)
  root_commit <- cell_of(s, "cell-2")$output$spec
  expect_equal(root_commit$value, "after")
  expect_false(root_commit$dirty)
  expect_match(cell_of(s, "cell-3")$output$text, "after", fixed = TRUE)
  expect_false(identical(cell_of(s, "cell-3")$output$text, root_before))

  nested_before <- cell_of(s, "cell-5")$output$text
  token <- s$set_widget(
    "controls", "submitted", list(value = "trusted-form-value"), "editor"
  )
  wait_operation("cell-4", "controls", "submitted", token)
  nested_draft <- cell_of(s, "cell-4")$output$spec$children[[1L]]
  expect_equal(nested_draft$child$value, "trusted-form-value")
  expect_true(nested_draft$dirty)
  expect_null(nested_draft$value)
  expect_equal(cell_of(s, "cell-5")$output$text, nested_before)
  expect_false(s$state()$runtime$busy)

  token <- s$set_widget(
    "controls", "submitted", list(submit = TRUE), "editor"
  )
  wait_operation("cell-4", "controls", "submitted", token)
  wait_until_settled(s)
  nested_commit <- cell_of(s, "cell-4")$output$spec$children[[1L]]
  expect_equal(nested_commit$value, "trusted-form-value")
  expect_false(nested_commit$dirty)
  expect_match(cell_of(s, "cell-5")$output$text,
               "trusted-form-value", fixed = TRUE)
  expect_false(identical(cell_of(s, "cell-5")$output$text, nested_before))
  expect_true(s$state()$runtime$worker_available)
})

test_that("run_button is one-shot and resets after its consumers finish", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "btn <- ui$run_button(label = \"Go\")", "btn",
    "# %%", "btn$value"
  ))
  s <- m$session
  withr::defer(s$stop())
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

test_that("run operations settle only after their causal button reset", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "btn <- ui$run_button(label = 'Go')", "btn",
    "# %%", "seen <- { Sys.sleep(0.1); btn$value }", "seen",
    "# %%", "ordinary <- 1L", "ordinary"
  ), execution_mode = "lazy", run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop())
  wait_until_settled(s)

  token <- s$set_widget("btn", list(value = TRUE), "editor")
  wait_for(s, function() identical(s$widget_operation(token)$status, "done"))
  expect_true(cell_of(s, "cell-2")$output$spec$value)
  expect_identical(cell_of(s, "cell-3")$status, "stale")

  run <- s$run_cell("cell-3")
  wait_for(s, function() {
    operation <- s$run_operation(run$run_id)
    !is.null(operation) && !identical(operation$status, "pending")
  })
  operation <- s$run_operation(run$run_id)
  expect_identical(operation$status, "done")
  expect_length(operation$reset_tokens, 1L)
  expect_identical(
    s$widget_operation(operation$reset_tokens[[1L]])$status, "done"
  )
  expect_false(cell_of(s, "cell-2")$output$spec$value)
  expect_identical(cell_of(s, "cell-3")$output$text, "[1] TRUE")

  ordinary <- s$run_cell("cell-4")
  wait_for(s, function() {
    identical(s$run_operation(ordinary$run_id)$status, "done")
  })
  expect_length(s$run_operation(ordinary$run_id)$reset_tokens, 0L)
  expect_null(s$run_operation(0L))
  expect_null(s$run_operation(NA_integer_))
})

test_that("nested run_button resets its addressed composite child", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%",
    "controls <- ui$array(go = ui$run_button(label = \"Go\"),",
    "                     level = ui$slider(min = 0, max = 10, value = 5))",
    "controls",
    "# %%",
    "controls$value$go"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  key <- paste("controls", "go", sep = "\001")
  child_value <- function(out) {
    idx <- which(vapply(
      out$spec$children, function(x) identical(x$name, "go"), FALSE
    ))
    out$spec$children[[idx[[1L]]]]$value
  }
  out <- cell_of(s, "cell-2")$output
  expect_false(child_value(out))

  tok <- s$set_widget(
    "controls", path = "go", update = list(value = TRUE), source = "editor"
  )
  wait_for(s, function() {
    op <- cell_of(s, "cell-2")$output$operations[[key]]
    !is.null(op) && identical(op$token, tok) &&
      !identical(op$status, "pending")
  })
  wait_until_settled(s)
  wait_for(s, function() {
    out <- cell_of(s, "cell-2")$output
    op <- out$operations[[key]]
    identical(child_value(out), FALSE) &&
      !is.null(op) && identical(op$status, "done")
  })
})

test_that("editing a widget owner cancels its pending update", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "w <- ui$slider(min = 0, max = 10, value = 5)", "w",
    "# %%", "w$value"
  ))
  s <- m$session
  withr::defer(s$stop())
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
  withr::defer(s$stop())
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
  withr::defer(s$stop())
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

test_that("pre-ack Stop is delivered promptly and cannot spill into recovery", {
  m <- make_test_session(c("# %%", "1"),
                         execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop())

  # Warm the worker's first-eval graphics/runtime setup outside the measured
  # cancellation window, then drain the edit's clear_cell request.
  s$run_cell("cell-1")
  wait_until_settled(s)
  s$set_cell("cell-1", c("Sys.sleep(10)", "'must not commit'"), "code",
             expected_revision = 0L)
  wait_for(s, function() !length(ls(m$worker$pending, all.names = TRUE)))

  # Hold the controller poller so the request is certainly pending but its
  # worker-side start acknowledgement cannot yet be observed by the host.
  m$worker$poll_active <- TRUE
  s$run_cell("cell-1")
  expect_true(s$state()$runtime$busy)
  expect_null(m$worker$executing_req)
  pending_req <- ls(m$worker$pending, all.names = TRUE)
  expect_length(pending_req, 1L)

  started <- Sys.time()
  res <- s$interrupt()
  expect_type(res$run_id, "integer")
  expect_identical(m$worker$interrupt_requested, pending_req)
  m$worker$poll_active <- FALSE
  m$worker$ensure_polling()
  wait_until_settled(s, timeout = 5)
  elapsed <- as.numeric(difftime(Sys.time(), started, units = "secs"))

  expect_lt(elapsed, 1.5)
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_match(paste(cell_of(s, "cell-1")$log, collapse = "\n"),
               "Error: Interrupted")
  expect_null(m$worker$interrupt_requested)
  expect_null(m$worker$interrupt_sent)

  s$set_cell("cell-1", "1 + 1", "code", expected_revision = 1L)
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_identical(cell_of(s, "cell-1")$output$text, "[1] 2")
})

test_that("post-ack Stop interrupts the active cell and leaves the worker usable", {
  m <- make_test_session(c("# %%", "1"),
                         execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop())
  s$run_cell("cell-1")
  wait_until_settled(s)
  s$set_cell("cell-1", c("Sys.sleep(10)", "42"), "code",
             expected_revision = 0L)
  wait_for(s, function() !length(ls(m$worker$pending, all.names = TRUE)))
  s$run_cell("cell-1")
  wait_for(s, function() isTRUE(s$state()$runtime$busy))
  # wait until the eval start ack has been received so SIGINT lands
  wait_for(s, function() !is.null(m$worker$executing_req), timeout = 5)
  started <- Sys.time()
  res <- s$interrupt()
  expect_type(res$run_id, "integer")
  wait_until_settled(s)
  expect_lt(as.numeric(difftime(Sys.time(), started, units = "secs")), 1.5)
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_match(paste(cell_of(s, "cell-1")$log, collapse = "\n"),
               "Error: Interrupted")
  # the same worker answers the next request
  s$set_cell("cell-1", "1 + 1", "code", expected_revision = 1L)
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_identical(cell_of(s, "cell-1")$output$text, "[1] 2")
})

test_that("post-ack Stop promptly interrupts repeated blocking calls", {
  m <- make_test_session(c("# %%", "1"), execution_mode = "lazy")
  s <- m$session
  withr::defer(s$stop())
  s$run_cell("cell-1")
  wait_until_settled(s)
  s$set_cell(
    "cell-1", "for (i in seq_len(200)) Sys.sleep(0.05)", "code",
    expected_revision = 0L
  )
  wait_for(s, function() !length(ls(m$worker$pending, all.names = TRUE)))
  s$run_cell("cell-1")
  wait_for(s, function() !is.null(m$worker$executing_req), timeout = 5)
  started <- Sys.time()
  s$interrupt()
  wait_until_settled(s, timeout = 5)
  elapsed <- as.numeric(difftime(Sys.time(), started, units = "secs"))

  expect_lt(elapsed, 1.5)
  expect_equal(cell_of(s, "cell-1")$status, "error")
  expect_true(isTRUE(cell_of(s, "cell-1")$error$interrupted))
  s$set_cell("cell-1", "6 * 7", "code", expected_revision = 1L)
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_identical(cell_of(s, "cell-1")$output$text, "[1] 42")
})

test_that("worker queues only the matching pre-ack interrupt", {
  signals <- 0L
  fake_proc <- list(
    is_alive = function() TRUE,
    kill = function() invisible(),
    wait = function(t) invisible(),
    interrupt = function() {
      signals <<- signals + 1L
      TRUE
    },
    write_input = function(x) invisible()
  )
  w <- Worker$new(fake_proc, "ws", "app", tempfile("art-"))
  dir.create(w$artifact_dir)
  response <- function(req, id, run_id) jsonlite::toJSON(
    list(req = req, cmd = "eval_cell", id = id, run_id = run_id,
         ok = FALSE, error = list(message = "Interrupted", interrupted = TRUE)),
    auto_unbox = TRUE, null = "null")
  register <- function(req, id, run_id) {
    w$pending[[as.character(req)]] <- list(
      callback = function(context, resp) invisible(),
      context = list(cmd = "eval_cell", req = req, id = id,
                     run_id = run_id),
      last_seq = 0L)
  }

  register(7L, "cell-1", 1L)
  register(8L, "cell-2", 2L)
  w$interrupt(7L)
  w$interrupt(7L)
  w$interrupt(8L)
  expect_identical(w$interrupt_requested, "7")
  expect_equal(signals, 0L)

  w$handle_line('{"ack":"started","req":7,"cmd":"eval_cell"}')
  expect_null(w$interrupt_requested)
  expect_identical(w$interrupt_sent, "7")
  expect_equal(signals, 1L)
  w$interrupt(7L)
  expect_equal(signals, 1L)
  w$handle_line(response(7L, "cell-1", 1L))
  expect_null(w$executing_req)
  expect_null(w$interrupt_sent)

  # The queued cancellation belonged only to request 7. Starting the already
  # pending request 8 must not inherit a signal while idle or on its ack.
  w$interrupt(7L)
  expect_equal(signals, 1L)
  w$handle_line('{"ack":"started","req":8,"cmd":"eval_cell"}')
  expect_identical(w$executing_req, "8")
  expect_equal(signals, 1L)
  w$handle_line(response(8L, "cell-2", 2L))

  register(9L, "cell-3", 3L)
  w$interrupt(9L)
  expect_identical(w$interrupt_requested, "9")
  w$fail_pending("failed")
  expect_null(w$interrupt_requested)
  expect_null(w$interrupt_sent)
  expect_null(w$executing_req)
})

test_that("worker surfaces an OS interrupt failure and fails the request", {
  alive <- TRUE
  signal_attempts <- 0L
  fake_proc <- list(
    is_alive = function() alive,
    kill = function() {
      alive <<- FALSE
      invisible()
    },
    wait = function(t) invisible(),
    interrupt = function() {
      signal_attempts <<- signal_attempts + 1L
      stop("synthetic SIGINT failure")
    },
    write_input = function(x) invisible()
  )
  callback_response <- NULL
  terminal_message <- NULL
  w <- Worker$new(fake_proc, "ws", "app", tempfile("art-"))
  dir.create(w$artifact_dir)
  w$pending[["7"]] <- list(
    callback = function(context, resp) callback_response <<- resp,
    context = list(cmd = "eval_cell", req = 7L, id = "cell-1", run_id = 1L),
    last_seq = 0L)
  w$executing_req <- "7"
  w$set_on_failure(function(message) terminal_message <<- message)

  w$interrupt(7L)

  expect_equal(signal_attempts, 1L)
  expect_true(w$failed_once)
  expect_false(alive)
  expect_match(terminal_message, "synthetic SIGINT failure", fixed = TRUE)
  expect_false(callback_response$ok)
  expect_true(callback_response$error$transport)
  expect_match(callback_response$error$message,
               "synthetic SIGINT failure", fixed = TRUE)
  expect_length(ls(w$pending, all.names = TRUE), 0L)
  expect_null(w$executing_req)
  expect_null(w$interrupt_requested)
  expect_null(w$interrupt_sent)
})

test_that("a late Stop after completion is a no_run_in_progress 409", {
  m <- make_test_session(c("# %%", "1 + 1"))
  s <- m$session
  withr::defer(s$stop())
  s$run_cell("cell-1")
  wait_until_settled(s)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_error(s$interrupt(), "no run in progress")
  expect_equal(cell_of(s, "cell-1")$status, "done")
})

test_that("worker transport failure marks the active cell error and 503s", {
  m <- make_test_session(c("# %%", slow_body))
  s <- m$session
  withr::defer(s$stop())
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
  withr::defer(s$stop())
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
  withr::defer(s$stop())
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

test_that("anonymous table output remains pageable", {
  m <- make_test_session(c("# %%", "data.frame(x = 1:30)"))
  s <- m$session
  withr::defer(s$stop())

  s$run_all()
  wait_until_settled(s)
  output <- s$state()$cells[[1L]]$outputs[[1L]]
  expect_identical(output$kind, "table")
  expect_true(nzchar(output$handle))

  s$request_table_page(output$handle, limit = 10)
  wait_for(s, function() {
    page <- s$state()$cells[[1L]]$outputs[[1L]]$page
    !is.null(page) && identical(as.integer(page$limit), 10L)
  })
  page <- s$state()$cells[[1L]]$outputs[[1L]]$page
  expect_length(page$preview, 10L)
  expect_null(s$state()$last_action_error)
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

test_that("notify frames accept matching context but reject stale run ids as terminal", {
  fake_proc <- list(
    is_alive = function() TRUE,
    kill = function() invisible(),
    wait = function(t) invisible(),
    interrupt = function() invisible(),
    write_input = function(x) invisible()
  )
  fired <- 0L
  seen <- NULL
  w <- Worker$new(fake_proc, "ws", "app", tempfile("art-"))
  dir.create(w$artifact_dir)
  w$set_on_failure(function(message) fired <<- fired + 1L)
  w$set_on_notify(function(context, frame) seen <<- frame$id)
  # register a pending eval_cell with run_id 2L directly (no send(): the
  # fake process cannot supply output/error connections for poll_cycle)
  w$pending[["7"]] <- list(
    callback = function(context, resp) invisible(),
    context = list(cmd = "eval_cell", req = 7, id = "cell-1", run_id = 2L),
    last_seq = 0L)

  # a matching notify (same req/id/run_id, invalid sequence and payload
  # checks exercised) is accepted and routes to on_notify
  w$handle_line(jsonlite::toJSON(
    list(notify = "append", req = 7L, id = "cell-1",
         run_id = 2L, seq = 1L,
         payload = list(output = list(kind = "text", text = "hi",
                                      truncated = FALSE))),
    auto_unbox = TRUE, null = "null"))
  expect_equal(fired, 0L)
  expect_false(isTRUE(w$failed_once))
  expect_equal(seen, "cell-1")
  expect_equal(w$pending[["7"]]$last_seq, 1L)

  # a notify frame from a stale run (run_id mismatch) is a terminal
  # transport failure; nothing may weaken the identity discipline
  w$handle_line(jsonlite::toJSON(
    list(notify = "append", req = 7L, id = "cell-1",
         run_id = 1L, seq = 2L,
         payload = list(output = list(kind = "text", text = "stale",
                                      truncated = FALSE))),
    auto_unbox = TRUE, null = "null"))
  expect_equal(fired, 1L)
  expect_true(w$failed_once)
})

test_that("a throwing response callback fails once and invokes on_failure", {
  m <- make_test_session(c("# %%", "1"))
  s <- m$session
  withr::defer(s$stop())
  w <- m$worker
  fired <- 0L
  w$set_on_failure(function(message) fired <<- fired + 1L)
  w$send("ping", on_response = function(ctx, resp) stop("boom"))
  wait_for(s, function() fired >= 1L)
  expect_equal(fired, 1L)
  expect_true(w$failed_once)
})

test_that("worker stop returns only after the child has exited", {
  w <- make_test_worker()
  expect_true(w$alive())
  w$stop(grace = 0.5)
  expect_false(w$alive())
  expect_length(ls(w$pending, all.names = TRUE), 0L)
  expect_false(is.null(w$proc$get_exit_status()))
})

test_that("idle worker death stales state and restart replays the notebook", {
  m <- make_test_session(c(
    "# %%", "x <- 3L",
    "# %%", "y <- x * 2L", "y"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop())
  wait_until_settled(s)
  expect_true(all(vapply(s$state()$cells, function(cell)
    identical(cell$status, "done"), logical(1))))

  m$worker$kill()
  failed <- s$state()
  expect_false(failed$runtime$worker_available)
  expect_true(all(vapply(failed$cells, function(cell)
    identical(cell$status, "stale"), logical(1))))
  expect_length(failed$variables, 0L)
  expect_equal(failed$last_action_error$code, "worker_unavailable")
  expect_match(failed$last_action_error$message, "Restart R", fixed = TRUE)

  restarted <- s$restart_worker(replay = TRUE)
  expect_true(is.numeric(restarted$run_id))
  wait_until_settled(s, timeout = 30)
  recovered <- s$state()
  expect_true(recovered$runtime$worker_available)
  expect_null(recovered$last_action_error)
  expect_true(all(vapply(recovered$cells, function(cell)
    identical(cell$status, "done"), logical(1))))
  expect_identical(recovered$cells[[2L]]$outputs[[1L]]$text, "[1] 6")
})

test_that("failed worker replacement retains stale outputs and editable source", {
  project <- tempfile("alder-failed-restart-")
  dir.create(project)
  withr::defer(unlink(project, recursive = TRUE))
  path <- file.path(project, "notebook.R")
  lines <- c("# %%", "x <- 2", "# %%", "y <- x * 3", "y")
  writeLines(lines, path)
  worker <- make_test_worker(env = c(ALDER_NOTEBOOK_DIR = project))
  s <- Session$new(
    parse_notebook_lines(path = path, lines = lines), worker,
    run_on_startup = FALSE,
    disk_version = list(
      exists = TRUE, bytes = readBin(path, "raw", n = file.info(path)$size)
    )
  )
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  s$request_value("y")
  wait_for(s, function() identical(s$state()$value_operation$status, "done"))
  wait_for(s, function() length(ls(worker$pending, all.names = TRUE)) == 0L)
  before <- s$state()
  expect_identical(before$last_value$value$text, "[1] 6")
  expect_setequal(vapply(before$variables, function(value) value$name, ""),
                  c("x", "y"))
  source_fields <- function(state) lapply(state$cells, function(cell)
    cell[c("id", "type", "body", "revision")])
  output_fields <- function(state) lapply(state$cells, function(cell) cell$outputs)

  original_script <- worker$worker_script
  missing_script <- file.path(project, "missing-worker.R")
  worker$worker_script <- missing_script
  original_restart <- worker$restart
  restart_entry <- NULL
  if (bindingIsLocked("restart", worker)) unlockBinding("restart", worker)
  worker$restart <- function() {
    restart_entry <<- s$state()
    original_restart()
  }
  # The real old process is shut down before replacement-path validation
  # fails, so this deterministically exercises a failed public Restart R.
  error <- expect_error(s$restart_worker(replay = FALSE), class = "alder_error")
  expect_identical(error$code, "worker_unavailable")
  expect_match(conditionMessage(error), "worker script not found:", fixed = TRUE)
  expect_match(conditionMessage(error), missing_script, fixed = TRUE)
  expect_false(worker$alive())
  expect_false(is.null(worker$proc$get_exit_status()))
  expect_identical(vapply(restart_entry$cells, function(cell) cell$status, ""),
                   c("stale", "stale"))
  expect_identical(source_fields(restart_entry), source_fields(before))
  expect_identical(output_fields(restart_entry), output_fields(before))
  expect_null(restart_entry$last_value)
  expect_null(restart_entry$value_operation)
  expect_length(restart_entry$variables, 0L)
  check_failed_state <- function(state) {
    expect_false(state$runtime$worker_available)
    expect_identical(vapply(state$cells, function(cell) cell$status, ""),
                     c("stale", "stale"))
    expect_identical(source_fields(state), source_fields(before))
    expect_identical(output_fields(state), output_fields(before))
    expect_null(state$last_value)
    expect_null(state$value_operation)
    expect_length(state$variables, 0L)
    expect_identical(state$last_action_error$code, "worker_unavailable")
    expect_match(state$last_action_error$message, missing_script, fixed = TRUE)
  }
  check_failed_state(s$state())
  wait_for(s, function() length(ls(worker$pending, all.names = TRUE)) == 0L)
  later::run_now(0.05)
  check_failed_state(s$state())

  s$set_cell("cell-1", "x <- 3", "code", expected_revision = 0L)
  saved <- s$save()
  expect_identical(saved$path, path)
  expect_identical(readLines(path, warn = FALSE),
                   c("# %%", "x <- 3", "# %%", "y <- x * 3", "y"))
  expect_identical(s$state()$cells[[1L]]$revision, 1L)
  expect_identical(output_fields(s$state()), output_fields(before))

  worker$worker_script <- original_script
  worker$restart <- original_restart
  s$restart_worker(replay = TRUE)
  wait_until_settled(s)
  recovered <- s$state()
  expect_true(recovered$runtime$worker_available)
  expect_null(recovered$last_action_error)
  expect_identical(vapply(recovered$cells, function(cell) cell$status, ""),
                   c("done", "done"))
  expect_identical(recovered$cells[[2L]]$outputs[[1L]]$text, "[1] 9")
  s$request_value("y")
  wait_for(s, function() identical(s$state()$value_operation$status, "done"))
  expect_identical(s$state()$last_value$value$text, "[1] 9")
})

test_that("successful replacement clears a pending old-worker inspection", {
  m <- make_test_session(c("# %%", "x <- 2", "x"))
  s <- m$session
  worker <- m$worker
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s)
  s$request_value("x")
  wait_for(s, function() identical(s$state()$value_operation$status, "done"))
  wait_for(s, function() length(ls(worker$pending, all.names = TRUE)) == 0L)
  before <- s$state()
  expect_identical(before$last_value$value$text, "[1] 2")

  # Hold response polling, then kill the old process with a real inspection
  # pending. Restart must drain its callback without letting that obsolete
  # operation repopulate the successfully replaced runtime's state.
  worker$poll_active <- TRUE
  s$request_value("x")
  expect_identical(s$state()$value_operation$status, "pending")
  expect_length(ls(worker$pending, all.names = TRUE), 1L)
  worker$kill()
  s$restart_worker(replay = FALSE)
  restarted <- s$state()
  expect_true(restarted$runtime$worker_available)
  expect_identical(restarted$cells[[1L]]$status, "stale")
  expect_identical(restarted$cells[[1L]]$outputs, before$cells[[1L]]$outputs)
  expect_null(restarted$last_value)
  expect_null(restarted$value_operation)
  expect_length(restarted$variables, 0L)
  expect_null(restarted$last_action_error)
  expect_length(ls(worker$pending, all.names = TRUE), 0L)
  later::run_now(0.05)
  expect_null(s$state()$value_operation)

  s$run_all()
  wait_until_settled(s)
  s$request_value("x")
  wait_for(s, function() identical(s$state()$value_operation$status, "done"))
  expect_identical(s$state()$last_value$value$text, "[1] 2")
})

test_that("malformed eval payloads from the worker are terminal transport failures", {
  # a table output missing required fields kills the worker (bounded schema)
  m <- make_test_session(c("# %%", slow_body))
  s <- m$session
  withr::defer(s$stop())
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
  withr::defer(s2$stop())
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
  withr::defer(s$stop())
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
