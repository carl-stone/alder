# Source formatting contracts: validation, formatter output shape, and edit semantics.

test_that("formatting rejects an unknown cell before invoking a formatter", {
  nb <- alder:::parse_notebook_lines("demo.R", c("# %%", "x <- 1"))
  expect_error(alder:::format_notebook_source(nb, "missing"),
               class = "alder_error")
  expect_equal(conditionMessage(
    tryCatch(alder:::format_notebook_source(nb, "missing"), error = identity)
  ), "no such cell: missing")
})

test_that("formatting returns only the selected formatted body", {
  skip_if(!nzchar(Sys.which("air")) &&
          !requireNamespace("styler", quietly = TRUE),
          "air or styler is required")
  nb <- alder:::parse_notebook_lines("demo.R", c(
    "# %%", "x<-1", "", "# %%", "y <- x + 1"
  ))
  result <- alder:::format_notebook_source(nb, "cell-1")
  expect_identical(names(result$bodies), "cell-1")
  expect_length(result$bodies, 1L)
  expect_true(all(is.character(result$bodies[[1L]])))
  expect_identical(vapply(result$notebook$cells, `[[`, character(1), "id"),
                   c("cell-1", "cell-2"))
})

test_that("formatted bodies reuse source-edit stale semantics", {
  nb <- alder:::parse_notebook_lines("demo.R", c(
    "# %%", "x <- 1", "", "# %%", "y <- x + 1"
  ))
  session <- alder:::Session$new(nb, worker = NULL,
                                  execution_mode = "automatic",
                                  run_on_startup = FALSE)
  on.exit(session$stop(), add = TRUE)
  before <- session$state()
  result <- session$apply_formatted(list(`cell-1` = c("x <- 2")))
  expect_equal(result$changed, 1L)
  after <- session$state()
  expect_true(after$cells[[1L]]$status %in% c("idle", "stale"))
  expect_true(after$cells[[2L]]$status %in% c("idle", "stale"))
  expect_equal(as.character(after$cells[[1L]]$body[[1L]]), "x <- 2")
  expect_equal(as.character(before$cells[[1L]]$body[[1L]]), "x <- 1")
})

test_that("formatting preconditions reject the whole request before transformation", {
  nb <- alder:::parse_notebook_lines("demo.R", c(
    "# %%", "x<-1", "# %%", "y<-2"
  ))
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  on.exit(session$stop(), add = TRUE)
  called <- FALSE
  local_mocked_bindings(format_notebook_source = function(...) {
    called <<- TRUE
    stop("formatter must not run")
  }, .package = "alder")
  session$set_cell("cell-2", "y <- 3", "code", 0L)
  before <- session$notebook_snapshot()
  expect_error(session$format_source(expected_revisions =
    list(`cell-1` = 0L, `cell-2` = 0L)), class = "alder_error")
  expect_false(called)
  expect_identical(session$notebook_snapshot(), before)
  invalid <- list(list(`cell-1` = 0L),
    list(`cell-1` = 0L, `cell-2` = 1L, extra = 0L),
    setNames(list(0L, 1L), c("cell-1", "cell-1")),
    list(`cell-1` = 0L, `cell-2` = -1L))
  for (revisions in invalid) {
    expect_error(session$format_source(expected_revisions = revisions),
                 class = "alder_error")
    expect_false(called)
    expect_identical(session$notebook_snapshot(), before)
  }
  expect_error(session$apply_formatted(list(`cell-1` = "x <- 9", `cell-2` = 1)),
               class = "alder_error")
  expect_identical(session$notebook_snapshot(), before)
})

test_that("format acknowledgements identify exact targeted source and revisions", {
  nb <- alder:::parse_notebook_lines("demo.R", c(
    "# %% [markdown]", "# Notes stay exact.", "# %%", "x<-1"
  ))
  session <- alder:::Session$new(nb, worker = NULL, run_on_startup = FALSE)
  on.exit(session$stop(), add = TRUE)
  local_mocked_bindings(format_notebook_source = function(nb, cell = NULL) {
    list(bodies = list(`cell-2` = "x <- 1"))
  }, .package = "alder")
  response <- session$format_source("cell-2", list(`cell-2` = 0L))
  wire <- jsonlite::fromJSON(jsonlite::toJSON(response, auto_unbox = TRUE,
    null = "null", force = TRUE), simplifyVector = FALSE)
  expect_length(wire$cells, 1L)
  expect_identical(wire$cells[[1L]]$id, "cell-2")
  expect_identical(wire$cells[[1L]]$type, "code")
  expect_identical(wire$cells[[1L]]$body, list("x <- 1"))
  expect_identical(wire$cells[[1L]]$previous_revision, 0L)
  expect_identical(wire$cells[[1L]]$revision, 1L)
  expect_identical(session$notebook_snapshot()$cells[[1L]], nb$cells[[1L]])
  no_change <- session$format_source("cell-2", list(`cell-2` = 1L))
  expect_identical(no_change$changed, 0L)
  expect_identical(no_change$cells[[1L]]$revision, 1L)
})
