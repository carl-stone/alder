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
  m <- make_test_session(c(
    "# %%", "x <- 1", "", "# %%", "y <- x + 1"
  ), execution_mode = "automatic", run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session
  run <- session$run_all()
  expect_identical(session$await_operation(run$run_id)$status, "done")
  before <- session$state()
  expect_true(all(vapply(before$cells, function(cell)
    identical(cell$status, "done"), logical(1))))
  result <- session$apply_formatted(list(`cell-1` = c("x <- 2")))
  expect_equal(result$changed, 1L)
  after <- session$state()
  expect_identical(after$cells[[1L]]$status, "stale")
  expect_identical(after$cells[[2L]]$status, "stale")
  expect_equal(as.character(after$cells[[1L]]$body[[1L]]), "x <- 2")
  expect_equal(as.character(before$cells[[1L]]$body[[1L]]), "x <- 1")
})

test_that("formatting preconditions reject the whole request before transformation", {
  m <- make_test_session(c(
    "# %%", "x<-1", "# %%", "y<-2"
  ), run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session
  session$set_cell("cell-2", "y <- 3", "code", 0L)
  before <- session$notebook_snapshot()
  expect_error(session$format_source(expected_revisions =
    list(`cell-1` = 0L, `cell-2` = 0L)), class = "alder_error")
  expect_identical(session$notebook_snapshot(), before)
  invalid <- list(list(`cell-1` = 0L),
    list(`cell-1` = 0L, `cell-2` = 1L, extra = 0L),
    setNames(list(0L, 1L), c("cell-1", "cell-1")),
    list(`cell-1` = 0L, `cell-2` = -1L))
  for (revisions in invalid) {
    expect_error(session$format_source(expected_revisions = revisions),
                 class = "alder_error")
    expect_identical(session$notebook_snapshot(), before)
  }
  expect_error(session$apply_formatted(list(`cell-1` = "x <- 9", `cell-2` = 1)),
               class = "alder_error")
  expect_identical(session$notebook_snapshot(), before)
})

test_that("format acknowledgements identify exact targeted source and revisions", {
  skip_if(!nzchar(Sys.which("air")) &&
          !requireNamespace("styler", quietly = TRUE),
          "air or styler is required")
  m <- make_test_session(c(
    "# %% [markdown]", "# Notes stay exact.", "# %%", "x<-1"
  ), run_on_startup = FALSE)
  on.exit(m$close(), add = TRUE)
  session <- m$session
  before <- session$notebook_snapshot()
  response <- session$format_source("cell-2", list(`cell-2` = 0L))
  wire <- jsonlite::fromJSON(jsonlite::toJSON(response, auto_unbox = TRUE,
    null = "null", force = TRUE), simplifyVector = FALSE)
  expect_identical(wire$changed, 1L)
  expect_identical(wire$edited, list(list(id = "cell-2", revision = 1L)))
  after <- session$notebook_snapshot()
  expect_identical(after$cells[[2L]]$body, "x <- 1")
  expect_identical(session$state()$cells[[2L]]$revision, 1L)
  expect_identical(after$cells[[1L]], before$cells[[1L]])
  no_change <- session$format_source("cell-2", list(`cell-2` = 1L))
  expect_identical(no_change$changed, 0L)
  expect_identical(no_change$edited[[1L]]$revision, 1L)
})
