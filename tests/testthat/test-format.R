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
