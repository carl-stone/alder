# Pure dataflow projections over Session-shaped snapshots.

make_dataflow_snapshot <- function() {
  list(
    version = 7L,
    cells = list(
      list(
        id = "cell-1", name = "source", type = "code",
        body = c("x <- 1", "message('x')"), defs = "x",
        refs = character(), status = "done", diagnostics = list()
      ),
      list(
        id = "cell-2", type = "code",
        body = "y <- x + 1 # x in a comment is not another token",
        defs = "y", refs = "x", status = "stale",
        diagnostics = list(list(level = "warning", code = "example",
                                message = "not blocking"))
      ),
      list(
        id = "cell-3", options = list(name = "report"), type = "markdown",
        body = c("# Report", "", "## Details"), defs = character(),
        refs = character(), status = "done"
      )
    ),
    variables = list(
      list(name = "x", class = "numeric", dim = NULL, size = 8,
           value = 1, widget = FALSE),
      list(name = "unsafe", class = "environment", status = "done",
           value = globalenv())
    ),
    dag = list(
      nodes = c("cell-1", "cell-2", "cell-3"),
      edges = list("cell-1" = character(), "cell-2" = "cell-1",
                   "cell-3" = character()),
      cycles = character()
    ),
    topo = c("cell-1", "cell-2", "cell-3")
  )
}

test_that("variables are ordered by definitions and omit unsafe values", {
  snapshot <- make_dataflow_snapshot()
  vars <- alder:::alder_variables(snapshot)
  expect_equal(vapply(vars, `[[`, "", "name"), c("x", "y", "unsafe"))
  expect_equal(vars[[1]]$owner, "cell-1")
  expect_equal(vars[[1]]$status, "done")
  expect_equal(vars[[1]]$value, 1)
  expect_match(vars[[1]]$value_summary, "numeric")
  expect_equal(vars[[2]]$owner, "cell-2")
  expect_equal(vars[[2]]$status, "stale")
  expect_false("value" %in% names(vars[[3]]))
  expect_false(isTRUE(vars[[3]]$value_available))

  no_values <- alder:::alder_variables(snapshot, include_values = FALSE)
  expect_false("value" %in% names(no_values[[1]]))
})

test_that("dependency graph preserves order and exposes reverse edges", {
  graph <- alder:::alder_dependency_graph(make_dataflow_snapshot())
  expect_equal(graph$nodes, c("cell-1", "cell-2", "cell-3"))
  expect_equal(graph$edges$`cell-2`, "cell-1")
  expect_equal(graph$reverse_edges$`cell-1`, "cell-2")
  expect_equal(graph$reverse_edges$`cell-2`, character())
  expect_equal(graph$edge_records[[1]], list(from = "cell-1", to = "cell-2"))
  expect_false(graph$node_info$`cell-2`$cycle)
  expect_equal(graph$diagnostics[[1]]$cell, "cell-2")
})

test_that("outline keeps notebook order, names, defs, and headings", {
  outline <- alder:::alder_outline(make_dataflow_snapshot())
  expect_equal(vapply(outline, `[[`, "", "id"),
               c("cell-1", "cell-2", "cell-3"))
  expect_equal(outline[[1]]$name, "source")
  expect_equal(outline[[1]]$defs, "x")
  expect_equal(outline[[3]]$name, "report")
  expect_equal(vapply(outline[[3]]$headings, `[[`, "", "text"),
               c("Report", "Details"))
  expect_equal(vapply(outline[[3]]$headings, `[[`, integer(1), "level"),
               c(1L, 2L))
})

test_that("reactive ranges find definitions and references, not strings or comments", {
  snapshot <- make_dataflow_snapshot()
  snapshot$cells[[2]]$body <- c(
    "y <- x + x", "txt <- 'x'; z <- obj$x", "# x is a comment"
  )
  ranges <- alder:::alder_reactive_ranges(snapshot, "cell-2")
  expect_equal(vapply(ranges, `[[`, "", "name"), c("y", "x", "x"))
  expect_equal(vapply(ranges, `[[`, "", "kind"),
               c("definition", "reference", "reference"))
  expect_equal(ranges[[2]]$target, "cell-1")
  expect_equal(ranges[[2]]$start, list(line = 0L, character = 5L))
  expect_equal(ranges[[2]]$end, list(line = 0L, character = 6L))
})

test_that("dataflow aggregate and a workerless Session use the same projections", {
  nb <- alder:::parse_notebook_lines(
    path = NA_character_,
    lines = c("# %%", "x <- 1", "# %%", "y <- x + 1")
  )
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  snapshot <- session$state()
  aggregate <- alder:::alder_dataflow_state(snapshot, include_values = FALSE)
  expect_equal(vapply(aggregate$variables, `[[`, "", "name"), c("x", "y"))
  expect_equal(aggregate$dag$reverse_edges$`cell-1`, "cell-2")
  expect_equal(vapply(aggregate$outline, `[[`, "", "id"),
               c("cell-1", "cell-2"))
  expect_equal(alder:::alder_reactive_ranges(snapshot, "cell-2")[[2]]$target,
               "cell-1")
})

test_that("malformed snapshots fail with actionable messages", {
  expect_error(alder:::alder_variables(list(cells = "bad")),
               "cells.*must be a list")
  expect_error(alder:::alder_dependency_graph(list(cells = list(
    list(id = "a"), list(id = "a")
  ))), "duplicate cell id")
  expect_error(alder:::alder_dependency_graph(list(
    cells = list(list(id = "a")),
    dag = list(edges = list(a = "missing"))
  )), "unknown cell")
  expect_error(alder:::alder_reactive_ranges(list(cells = list(
    list(id = "a")
  )), "missing"), "no cell")
})
