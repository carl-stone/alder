# Native scientific values keep their renderers when composed into layouts.

composition_cell <- function(session, id) {
  cells <- session$state()$cells
  cells[[which(vapply(cells, function(cell) identical(cell$id, id), logical(1)))]]
}

test_that("layout text and model fallback use readable output and scalar titles", {
  expect_identical(out$callout("Check assumptions")$children[[1L]]$text,
                   "Check assumptions")
  large <- out$callout(strrep("\u00e9", 200000L))$children[[1L]]
  expect_true(large$truncated)
  expect_lte(nchar(large$text, type = "bytes"), 262144L)
  expect_false(is.na(iconv(large$text, from = "UTF-8", to = "UTF-8")))
  model <- summary(stats::lm(mpg ~ wt, data = mtcars))
  shown <- out$tabs(Model = model)
  expect_match(shown$children[[1L]]$text, "Coefficients:", fixed = TRUE)
  expect_false(grepl("List of", shown$children[[1L]]$text, fixed = TRUE))
  expect_match(out$inspect(model)$text, "List of", fixed = TRUE)
  wire <- jsonlite::fromJSON(jsonlite::toJSON(shown, auto_unbox = TRUE),
                             simplifyVector = FALSE)
  expect_identical(wire$attrs$titles, list("Model"))
  accordion <- out$accordion(Model = model)
  wire <- jsonlite::fromJSON(jsonlite::toJSON(accordion, auto_unbox = TRUE),
                             simplifyVector = FALSE)
  expect_identical(wire$attrs$titles, list("Model"))
})

test_that("native htmlwidgets remain HTML artifacts in composed outputs", {
  skip_if_not_installed("htmlwidgets")
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "widget <- htmlwidgets::createWidget('tw', list(message = 'hello'))",
    "out$tabs(Widget = widget)"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  cell <- composition_cell(s, "cell-2")
  expect_identical(cell$status, "done")
  child <- cell$outputs[[1L]]$children[[1L]]
  expect_identical(child$kind, "html")
  path <- file.path(m$boot$ready$artifactDirectory, child$artifact)
  expect_true(file.exists(path))
  expect_match(paste(readLines(path, warn = FALSE), collapse = "\n"),
               "hello", fixed = TRUE)
})
