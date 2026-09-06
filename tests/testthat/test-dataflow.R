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
        body = c("# # Report", "# Narrative paragraph.", "# ## Details"),
        defs = character(),
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

test_that("variables never advertise stale primitive values as available", {
  snapshot <- make_dataflow_snapshot()
  snapshot$variables[[length(snapshot$variables) + 1L]] <- list(
    name = "y", class = "numeric", value = 2, size = 8)
  stale <- alder:::alder_variables(snapshot)[[2L]]
  expect_identical(stale$status, "stale")
  expect_false(stale$value_available)
  expect_false("value" %in% names(stale))
  snapshot$cells[[2L]]$status <- "done"
  fresh <- alder:::alder_variables(snapshot)[[2L]]
  expect_true(fresh$value_available)
  expect_identical(fresh$value, 2)
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
  expect_false("Narrative paragraph." %in%
                 vapply(outline[[3]]$headings, `[[`, "", "text"))
})

test_that("mixed singleton adjacency has exact reverse paths and JSON arrays", {
  ids <- paste0("cell-", 1:7)
  snapshot <- list(
    cells = lapply(ids, function(id) list(
      id = id, type = "code", body = character(), defs = character(),
      refs = character(), status = "idle"
    )),
    dag = list(
      nodes = ids,
      edges = list(
        "cell-1" = character(),
        "cell-2" = "cell-1",
        "cell-3" = c("cell-1", "cell-2"),
        "cell-4" = "cell-3",
        "cell-5" = "cell-2",
        "cell-6" = "cell-5",
        "cell-7" = c("cell-4", "cell-6")
      )
    )
  )
  graph <- alder:::alder_dependency_graph(snapshot)
  expect_equal(graph$reverse_edges$`cell-1`, c("cell-2", "cell-3"))
  expect_equal(graph$reverse_edges$`cell-2`, c("cell-3", "cell-5"))
  expect_equal(graph$reverse_edges$`cell-3`, "cell-4")
  expect_equal(graph$reverse_edges$`cell-4`, "cell-7")
  expect_equal(graph$reverse_edges$`cell-5`, "cell-6")
  expect_equal(graph$reverse_edges$`cell-6`, "cell-7")
  expect_equal(graph$reverse_edges$`cell-7`, character())

  dataflow <- alder:::alder_dataflow_state(snapshot, include_values = FALSE)
  wire <- alder:::alder_dataflow_json(dataflow)
  parsed <- jsonlite::fromJSON(jsonlite::toJSON(
    wire, auto_unbox = TRUE, null = "null", force = TRUE
  ), simplifyVector = FALSE)
  expect_true(all(vapply(parsed$dag$edges, is.list, logical(1))))
  expect_true(all(vapply(parsed$dag$reverse_edges, is.list, logical(1))))
  expect_length(parsed$dag$edges$`cell-1`, 0L)
  expect_identical(parsed$dag$edges$`cell-2`, list("cell-1"))
  expect_identical(parsed$dag$edges$`cell-3`, list("cell-1", "cell-2"))
  expect_identical(parsed$dag$reverse_edges$`cell-7`, list())
})

test_that("outline follows rendered Markdown ATX heading semantics", {
  snapshot <- make_dataflow_snapshot()
  snapshot$cells[[3L]]$body <- c(
    "# # Top heading",
    "# A paragraph, not a heading.",
    "# ## Nested heading ##",
    "# ### Heading with a literal###",
    "# ####### Not a heading",
    "#     # Indented code, not a heading"
  )
  headings <- alder:::alder_outline(snapshot)[[3L]]$headings
  expect_equal(vapply(headings, `[[`, "", "text"), c(
    "Top heading", "Nested heading", "Heading with a literal###"
  ))
  expect_equal(vapply(headings, `[[`, integer(1), "level"), c(1L, 2L, 3L))
  expect_equal(vapply(headings, `[[`, integer(1), "line"), c(0L, 2L, 3L))
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

test_that("incomplete editor source retains diagnostics without breaking dataflow", {
  nb <- alder:::parse_notebook_lines(
    path = NA_character_,
    lines = c("# %%", "x <-", "# %%",
              "assign(paste0(\"dynamic\", \"_name\"), 1)")
  )
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  state <- session$state()

  expect_null(state$dataflow_error)
  expect_null(state$dataflow$error)
  expect_true(any(vapply(state$cells[[1L]]$diagnostics, function(item) {
    identical(item$code, "syntax-error")
  }, logical(1L))))
  expect_true(any(vapply(state$cells[[2L]]$diagnostics, function(item) {
    identical(item$code, "dynamic-dependency")
  }, logical(1L))))
  expect_identical(as.character(state$dataflow$dag$nodes),
                   c("cell-1", "cell-2"))

  encoded <- jsonlite::toJSON(
    state$dataflow, auto_unbox = TRUE, null = "null", force = TRUE
  )
  decoded <- jsonlite::fromJSON(encoded, simplifyVector = FALSE)
  expect_identical(decoded$dag$nodes, list("cell-1", "cell-2"))
  expect_identical(decoded$dag$diagnostics[[1L]]$symbol, NULL)
})

test_that("Session state exposes dataflow projection failures", {
  nb <- alder:::parse_notebook_lines(
    path = NA_character_,
    lines = c("# %%", "x <- 1", "# %%", "y <- x + 1")
  )
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  testthat::local_mocked_bindings(
    alder_dataflow_state = function(...) {
      stop("forced projection failure")
    },
    .package = "alder"
  )

  state <- session$state()
  expect_identical(state$dataflow_error$code,
                   "dataflow_projection_error")
  expect_identical(state$last_action_error, state$dataflow_error)
  expect_identical(state$dataflow$error, state$dataflow_error)
  expect_match(state$dataflow_error$message, "forced projection failure",
               fixed = TRUE)

  encoded <- jsonlite::toJSON(state$dataflow, auto_unbox = TRUE,
                              null = "null")
  decoded <- jsonlite::fromJSON(encoded, simplifyVector = FALSE)
  expect_type(decoded$dag$edges$`cell-1`, "list")
  expect_type(decoded$dag$edges$`cell-2`, "list")
  expect_type(decoded$dag$reverse_edges$`cell-1`, "list")
  expect_type(decoded$dag$reverse_edges$`cell-2`, "list")
})

test_that("Session reuses source ranges while invalidating changed owners and positions", {
  nb <- alder:::parse_notebook_lines(
    path = NA_character_,
    lines = c("# %%", "x <- 1", "# %%", "y <- x + 1")
  )
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  original <- alder:::alder_reactive_ranges
  calls <- 0L
  testthat::local_mocked_bindings(
    alder_reactive_ranges = function(...) {
      calls <<- calls + 1L
      original(...)
    },
    .package = "alder"
  )
  validate <- function() {
    snapshot <- session$state()
    expected <- setNames(lapply(snapshot$cells, function(cell) {
      original(snapshot, cell$id)
    }), vapply(snapshot$cells, `[[`, "", "id"))
    expect_equal(snapshot$reactive_ranges, expected)
    encoded <- jsonlite::fromJSON(
      session$state_json(list(transport_note = "quotes: \"; Unicode: λ; braces: }")),
      simplifyVector = FALSE
    )
    ordinary <- jsonlite::fromJSON(jsonlite::toJSON(
      c(snapshot, list(transport_note = "quotes: \"; Unicode: λ; braces: }")),
      auto_unbox = TRUE, null = "null", na = "null", force = TRUE
    ), simplifyVector = FALSE)
    expect_setequal(names(encoded), names(ordinary))
    expect_equal(encoded[names(ordinary)], ordinary)
    snapshot
  }
  validate()
  initial_calls <- calls
  validate()
  expect_identical(calls, initial_calls)
  session$set_cell("cell-1", "z <- 1", "code")
  changed <- validate()
  expect_gt(calls, initial_calls)
  expect_null(changed$reactive_ranges$`cell-2`[[2]]$target)
  session$set_cell("cell-2", "y <-   z + 1", "code")
  moved <- validate()
  expect_identical(moved$reactive_ranges$`cell-2`[[2]]$target, "cell-1")
  expect_identical(moved$reactive_ranges$`cell-2`[[2]]$start$character, 7L)
  session$add_cell(body = "w <- z", type = "code")
  validate()
  session$move_cell("cell-2", after = NULL)
  validate()
  session$delete_cell("cell-1")
  validate()
  cached_calls <- calls
  validate()
  expect_identical(calls, cached_calls)
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
