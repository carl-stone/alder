# Production controller integration through the installed R host facade.

cell_of <- function(session, id) {
  cells <- session$state()$cells
  matches <- vapply(cells, function(cell) identical(cell$id, id), logical(1))
  if (!any(matches)) stop("no such cell: ", id)
  cell <- cells[[which(matches)[[1L]]]]
  cell$output <- if (length(cell$outputs)) {
    cell$outputs[[length(cell$outputs)]]
  } else {
    NULL
  }
  cell
}

test_that("value inspection follows authoritative owner freshness", {
  m <- make_test_session(c(
    "# %%", "x <- 2",
    "# %%", "y <- x * 3", "y"
  ), execution_mode = "lazy")
  on.exit(m$close(), add = TRUE)
  session <- m$session

  run <- session$run_all()
  expect_identical(session$await_operation(run$run_id)$status, "done")
  inspect <- session$request_value("y")
  expect_identical(session$await_operation(inspect)$status, "done")
  expect_identical(session$state()$last_value$value$text, "[1] 6")

  old_output <- cell_of(session, "cell-2")$outputs
  session$set_cell("cell-1", "x <- 3", "code", 0L)
  expect_null(session$state()$last_value)
  expect_identical(cell_of(session, "cell-2")$outputs, old_output)
  stale <- tryCatch(session$request_value("y"), alder_error = identity)
  expect_s3_class(stale, "alder_error")
  expect_identical(stale$code, "stale_value")

  rerun <- session$run_stale()
  expect_identical(session$await_operation(rerun$run_id)$status, "done")
  inspect <- session$request_value("y")
  expect_identical(session$await_operation(inspect)$status, "done")
  expect_identical(session$state()$last_value$value$text, "[1] 9")

  session$set_cell_disabled("cell-2", TRUE)
  disabled <- tryCatch(session$request_value("y"), alder_error = identity)
  expect_s3_class(disabled, "alder_error")
  expect_identical(disabled$code, "stale_value")
  expect_null(session$state()$last_value)
})

test_that("startup execution is explicit and invalid graphs remain editable", {
  automatic <- make_test_session(c(
    "# %%", "a <- 1",
    "# %%", "b <- a", "b"
  ), run_on_startup = TRUE)
  on.exit(automatic$close(), add = TRUE)
  wait_for(automatic$session, function() {
    all(vapply(automatic$session$state()$cells, function(cell)
      identical(cell$status, "done"), logical(1)))
  }, timeout = 15)
  expect_identical(cell_of(automatic$session, "cell-2")$output$text, "[1] 1")

  idle <- make_test_session(c("# %%", "a <- 1"), run_on_startup = FALSE)
  on.exit(idle$close(), add = TRUE)
  expect_identical(cell_of(idle$session, "cell-1")$status, "idle")

  invalid <- make_test_session(c(
    "# %%", "a <- 1",
    "# %%", "a <- 2"
  ), run_on_startup = TRUE)
  on.exit(invalid$close(), add = TRUE)
  state <- invalid$session$state()
  expect_identical(state$last_action_error$code, "graph_invalid")
  expect_match(state$last_action_error$message, "duplicate definitions")
  expect_true(all(vapply(state$cells, function(cell)
    identical(cell$status, "idle"), logical(1))))
  changed <- invalid$session$set_cell("cell-2", "b <- 2", "code", 0L)
  expect_identical(changed$revision, 1L)
  expect_null(invalid$session$validate_graph())
})

test_that("disabled cells retain output, block descendants, and resume coherently", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "y <- x + 1", "y",
    "# %%", "y + 1"
  ))
  on.exit(m$close(), add = TRUE)
  session <- m$session
  first <- session$run_all()
  expect_identical(session$await_operation(first$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-3")$output$text, "[1] 3")

  disabled <- session$set_cell_disabled("cell-2", TRUE)
  expect_true(disabled$disabled)
  expect_identical(cell_of(session, "cell-2")$status, "disabled")
  expect_identical(cell_of(session, "cell-3")$status, "stale")
  expect_identical(cell_of(session, "cell-3")$output$text, "[1] 3")
  blocked <- session$run_all()
  expect_identical(session$await_operation(blocked$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-2")$status, "disabled")
  expect_identical(cell_of(session, "cell-3")$status, "stale")

  enabled <- session$set_cell_disabled("cell-2", FALSE)
  expect_false(enabled$disabled)
  expect_identical(session$await_operation(enabled$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-2")$status, "done")
  expect_identical(cell_of(session, "cell-3")$status, "done")
  expect_identical(cell_of(session, "cell-3")$output$text, "[1] 3")
})

test_that("cell names and dependency failures are validated by the production graph", {
  names <- make_test_session(c(
    "# %%", "#| name: first", "x <- 1",
    "# %%", "#| name: first", "x + 1"
  ), run_on_startup = FALSE)
  on.exit(names$close(), add = TRUE)
  diagnostics <- lapply(names$session$state()$cells,
                        function(cell) cell$diagnostics)
  expect_true(all(vapply(diagnostics, function(items) {
    any(vapply(items, function(item)
      identical(item$code, "duplicate-cell-name"), logical(1)))
  }, logical(1))))
  run <- names$session$run_all()
  expect_identical(names$session$await_operation(run$run_id)$status, "done")
  expect_error(names$session$set_cell_name("cell-1", "not valid"),
               "cell name must match", class = "alder_error")
  expect_identical(
    names$session$set_cell_name("cell-1", "renamed_1")$name,
    "renamed_1"
  )
  expect_null(names$session$set_cell_name("cell-1", NULL)$name)

  duplicate <- make_test_session(c(
    "# %%", "a <- 1",
    "# %%", "a <- 2"
  ), run_on_startup = FALSE)
  on.exit(duplicate$close(), add = TRUE)
  expect_error(duplicate$session$run_all(), "duplicate definitions",
               class = "alder_error")
  expect_false(duplicate$session$state()$runtime$busy)

  cycle <- make_test_session(c(
    "# %%", "a <- b",
    "# %%", "b <- a"
  ), run_on_startup = FALSE)
  on.exit(cycle$close(), add = TRUE)
  expect_error(cycle$session$run_all(), "dependency cycle",
               class = "alder_error")
  expect_false(cycle$session$state()$runtime$busy)
})

test_that("runtime, cell type, and source revision controls reject invalid changes", {
  m <- make_test_session(c("# %%", "x <- 1"), run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session

  expect_error(session$set_runtime(), class = "alder_error")
  session$set_runtime(run_on_startup = TRUE)
  session$set_runtime(execution_mode = "lazy")
  state <- session$state()
  expect_identical(state$runtime$execution_mode, "lazy")
  expect_true(state$runtime$run_on_startup)
  expect_identical(state$metadata$runtime,
                   list(execution_mode = "lazy", run_on_startup = TRUE))

  expect_error(session$set_cell("cell-1", "SELECT 1", "sql"),
               class = "alder_error")
  expect_error(session$add_cell(body = "SELECT 1", type = "sql"),
               class = "alder_error")
  initial <- session$state()$cells[[1L]]
  for (revision in c(0.5, -1, .Machine$integer.max + 1, Inf, -Inf, NaN)) {
    expect_no_warning(expect_error(
      session$set_cell("cell-1", "x <- 2", "code", revision),
      "expected_revision must be a non-negative integer",
      class = "alder_error"
    ))
    current <- session$state()$cells[[1L]]
    expect_identical(current$body, initial$body)
    expect_identical(current$revision, initial$revision)
  }
  updated <- session$set_cell("cell-1", "x <- 2", "code", 0L)
  expect_identical(updated$revision, 1L)
  expect_error(session$set_cell("cell-1", "x <- 3", "code", 0L),
               "changed on the server", class = "alder_error")
  expect_identical(session$state()$cells[[1L]]$body, "x <- 2")
})

test_that("explicit runs obey automatic and lazy dependency plans", {
  m <- make_test_session(c(
    "# %%", "n <- 1",
    "# %%", "m <- n + 1", "m",
    "# %%", "m * 10"
  ), execution_mode = "automatic")
  on.exit(m$close(), add = TRUE)
  session <- m$session
  first <- session$run_all()
  expect_identical(session$await_operation(first$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-3")$output$text, "[1] 20")

  old_output <- cell_of(session, "cell-3")$outputs
  session$set_cell("cell-1", "n <- 2", "code", 0L)
  expect_true(all(vapply(session$state()$cells, function(cell)
    identical(cell$status, "stale"), logical(1))))
  expect_identical(cell_of(session, "cell-3")$outputs, old_output)
  automatic <- session$run_cell("cell-1")
  expect_identical(session$await_operation(automatic$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-3")$output$text, "[1] 30")

  session$set_runtime(execution_mode = "lazy")
  session$set_cell("cell-1", "n <- 3", "code", 1L)
  upstream <- session$run_cell("cell-1")
  expect_identical(session$await_operation(upstream$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-1")$status, "done")
  expect_identical(cell_of(session, "cell-2")$status, "stale")
  expect_identical(cell_of(session, "cell-3")$status, "stale")
  downstream <- session$run_cell("cell-3")
  expect_identical(session$await_operation(downstream$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-3")$output$text, "[1] 40")
})

test_that("source invalidation clears bindings before dependent evaluation", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "x + 1"
  ))
  on.exit(m$close(), add = TRUE)
  session <- m$session
  first <- session$run_all()
  expect_identical(session$await_operation(first$run_id)$status, "done")

  session$set_cell("cell-1", character(), "code", 0L)
  dependent <- session$run_cell("cell-2")
  failure <- session$await_operation(dependent$run_id)
  expect_identical(failure$status, "done")
  cell <- cell_of(session, "cell-2")
  expect_identical(cell$status, "error")
  expect_match(paste(cell$log, collapse = "\n"), "object 'x' not found",
               fixed = TRUE)
})

test_that("barrier edits restart cleanly and failed barriers can be repaired", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "1 + 1"
  ))
  on.exit(m$close(), add = TRUE)
  session <- m$session
  first <- session$run_all()
  expect_identical(session$await_operation(first$run_id)$status, "done")
  session$set_cell("cell-1", c("library(alder)", "message('edited')"),
                   "code", 0L)
  expect_identical(cell_of(session, "cell-2")$status, "stale")
  rerun <- session$run_all()
  expect_identical(session$await_operation(rerun$run_id)$status, "done")
  expect_identical(cell_of(session, "cell-2")$output$text, "[1] 2")

  failed <- make_test_session(c(
    "# %%", "library(alder_nonexistent_pkg)",
    "# %%", "1 + 1"
  ))
  on.exit(failed$close(), add = TRUE)
  bad <- failed$session$run_all()
  expect_identical(failed$session$await_operation(bad$run_id)$status, "done")
  expect_identical(cell_of(failed$session, "cell-1")$status, "error")
  expect_identical(cell_of(failed$session, "cell-2")$status, "stale")
  failed$session$set_cell("cell-1", "1", "code", 0L)
  repaired <- failed$session$run_all()
  expect_identical(failed$session$await_operation(repaired$run_id)$status,
                   "done")
  expect_identical(cell_of(failed$session, "cell-2")$output$text, "[1] 2")
})
