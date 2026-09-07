test_that("production host exposes one coherent dataflow projection", {
  m <- make_test_session(c(
    "# %%", "#| name: source", "x <- 1", "message('x')",
    "# %%", "y <- x + 1 # x in a comment is not another token",
    "# %% [markdown]", "# # Report", "# Narrative paragraph.",
    "# ## Details"
  ), execution_mode = "lazy", run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session

  run <- session$run_all()
  expect_identical(session$await_operation(run$run_id)$status, "done")
  wait_for(session, function() {
    names <- vapply(session$state()$variables, `[[`, "", "name")
    all(c("x", "y") %in% names)
  })
  state <- session$state()

  expect_identical(state$cells[[1L]]$defs, "x")
  expect_identical(state$cells[[2L]]$refs, "x")
  graph <- alder:::alder_dependency_graph(state)
  expect_identical(graph$nodes, c("cell-1", "cell-2", "cell-3"))
  expect_identical(graph$edges$`cell-2`, "cell-1")
  expect_identical(graph$reverse_edges$`cell-1`, "cell-2")
  expect_identical(graph$edge_records[[1L]],
                   list(from = "cell-1", to = "cell-2"))

  variables <- alder:::alder_variables(state, include_values = FALSE)
  expect_identical(vapply(variables, `[[`, "", "name"), c("x", "y"))
  expect_identical(variables[[1L]]$owner, "cell-1")
  expect_identical(variables[[2L]]$owner, "cell-2")
  expect_false(any(vapply(variables, function(variable)
    "value" %in% names(variable), logical(1))))

  outline <- alder:::alder_outline(state)
  expect_identical(vapply(outline, `[[`, "", "id"),
                   c("cell-1", "cell-2", "cell-3"))
  expect_identical(outline[[1L]]$name, "source")
  expect_identical(vapply(outline[[3L]]$headings, `[[`, "", "text"),
                   c("Report", "Details"))
  expect_identical(vapply(outline[[3L]]$headings, `[[`, integer(1), "level"),
                   c(1L, 2L))

  ranges <- alder:::alder_reactive_ranges(state, "cell-2")
  expect_identical(vapply(ranges, `[[`, "", "name"), c("y", "x"))
  expect_identical(vapply(ranges, `[[`, "", "kind"),
                   c("definition", "reference"))
  expect_identical(ranges[[2L]]$target, "cell-1")
})

test_that("production analysis diagnostics remain serializable for incomplete source", {
  m <- make_test_session(c(
    "# %%", "x <-",
    "# %%", "assign(paste0('dynamic', '_name'), 1)"
  ), run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session
  state <- session$state()

  expect_true(any(vapply(state$cells[[1L]]$diagnostics, function(item) {
    identical(item$code, "syntax-error")
  }, logical(1))))
  expect_true(any(vapply(state$cells[[2L]]$diagnostics, function(item) {
    identical(item$code, "dynamic-dependency")
  }, logical(1))))
  expect_identical(state$dag$nodes, c("cell-1", "cell-2"))

  decoded <- jsonlite::fromJSON(session$state_json(), simplifyVector = FALSE)
  expect_identical(decoded$graph$nodes, list("cell-1", "cell-2"))
  expect_type(decoded$graph$edges$`cell-1`, "list")
  expect_type(decoded$graph$reverseEdges$`cell-2`, "list")
})

test_that("production source mutations update owners, edges, and reactive ranges", {
  m <- make_test_session(c(
    "# %%", "x <- 1",
    "# %%", "y <- x + 1"
  ), run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session

  initial <- session$state()
  expect_identical(
    alder:::alder_reactive_ranges(initial, "cell-2")[[2L]]$target,
    "cell-1"
  )

  session$set_cell("cell-1", "z <- 1", "code", 0L)
  expect_null(session$validate_graph())
  changed <- session$state()
  expect_null(alder:::alder_reactive_ranges(changed, "cell-2")[[2L]]$target)
  expect_identical(alder:::alder_dependency_graph(changed)$edges$`cell-2`,
                   character())

  session$set_cell("cell-2", "y <-   z + 1", "code", 0L)
  expect_null(session$validate_graph())
  moved <- session$state()
  reference <- alder:::alder_reactive_ranges(moved, "cell-2")[[2L]]
  expect_identical(reference$target, "cell-1")
  expect_identical(reference$start$character, 7L)
  expect_identical(alder:::alder_dependency_graph(moved)$edges$`cell-2`,
                   "cell-1")

  added <- session$add_cell("cell-2", "w <- z", "code")
  expect_null(session$validate_graph())
  expect_identical(
    alder:::alder_dependency_graph(session$state())$edges[[added$id]],
    "cell-1"
  )
  session$delete_cell("cell-1")
  expect_null(session$validate_graph())
  final <- session$state()
  expect_false("cell-1" %in% final$graph$nodes)
  graph <- alder:::alder_dependency_graph(final)
  expect_identical(graph$edges$`cell-2`, character())
  expect_identical(graph$edges[[added$id]], character())
})
