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

test_that("native plots models and pageable tables survive layout lazy and append", {
  skip_if_not_installed("ggplot2")
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "model <- lm(mpg ~ wt, data = mtcars)",
    "p <- ggplot2::ggplot(mtcars, ggplot2::aes(wt, mpg)) + ggplot2::geom_point()",
    "# %%", "out$tabs(Plot = p, Model = summary(model), Data = data.frame(x = 1:40))",
    "# %%", "out$lazy(function() out$vstack(p, summary(model)))",
    "# %%", "cat('before append\\n')", "out$append(p)",
    "out$append(summary(model))", "cat('after append\\n')", "'tail'",
    "# %%", "plot(1:3)", "rp <- recordPlot()", "out$tabs(Base = rp)"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s, timeout = 30)
  expect_true(all(vapply(s$state()$cells, function(cell)
    identical(cell$status, "done"), logical(1))))
  layout <- composition_cell(s, "cell-3")$outputs[[1L]]
  expect_identical(vapply(layout$children, `[[`, character(1), "kind"),
                   c("image", "text", "table"))
  expect_match(layout$children[[2L]]$text, "Coefficients:", fixed = TRUE)
  expect_true(file.exists(file.path(m$worker$artifact_dir,
                                    layout$children[[1L]]$artifact)))
  table <- layout$children[[3L]]
  expect_true(nzchar(table$handle))
  s$request_table_page(table$handle, offset = 25, limit = 10)
  wait_for(s, function() {
    page <- composition_cell(s, "cell-3")$outputs[[1L]]$children[[3L]]$page
    !is.null(page) && identical(as.numeric(page$offset), 25)
  }, timeout = 10)
  page <- composition_cell(s, "cell-3")$outputs[[1L]]$children[[3L]]$page
  expect_identical(page$preview[[1L]][[1L]], "26")

  lazy <- composition_cell(s, "cell-4")$outputs[[1L]]
  s$request_lazy(lazy$key)
  wait_for(s, function()
    identical(composition_cell(s, "cell-4")$outputs[[1L]]$state, "loaded"),
    timeout = 15)
  loaded <- composition_cell(s, "cell-4")$outputs[[1L]]$child
  expect_identical(vapply(loaded$children, `[[`, character(1), "kind"),
                   c("image", "text"))
  expect_match(loaded$children[[2L]]$text, "Coefficients:", fixed = TRUE)

  appended <- composition_cell(s, "cell-5")
  expect_identical(vapply(appended$outputs, `[[`, character(1), "kind"),
                   c("image", "text", "text"))
  expect_identical(as.character(unlist(appended$log, use.names = FALSE)),
                   c("before append", "after append"))
  expect_match(appended$outputs[[2L]]$text, "Coefficients:", fixed = TRUE)
  expect_match(appended$outputs[[3L]]$text, "tail", fixed = TRUE)
  base <- tail(composition_cell(s, "cell-6")$outputs, 1L)[[1L]]
  expect_identical(base$children[[1L]]$kind, "image")
  expect_true(file.exists(file.path(m$worker$artifact_dir,
                                    base$children[[1L]]$artifact)))
  expect_true(s$worker_available())
})

test_that("native htmlwidgets remain HTML artifacts in composed outputs", {
  skip_if_not_installed("htmlwidgets")
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "widget <- htmlwidgets::createWidget('tw', list(message = 'hello'))",
    "out$tabs(Widget = widget)"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s, timeout = 30)
  cell <- composition_cell(s, "cell-2")
  expect_identical(cell$status, "done")
  child <- cell$outputs[[1L]]$children[[1L]]
  expect_identical(child$kind, "html")
  path <- file.path(m$worker$artifact_dir, child$artifact)
  expect_true(file.exists(path))
  expect_match(paste(readLines(path, warn = FALSE), collapse = "\n"),
               "hello", fixed = TRUE)
})

test_that("renderer conditions survive composition and ordinary terminal rendering", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "print.alder_review_note <- function(x, ...) {",
    "  message('renderer-message'); warning('renderer-warning')",
    "  cat('printed result\\n'); invisible(x)", "}",
    "note <- structure('text', class = 'alder_review_note')",
    "# %%", "cat('before layout\\n')", "out$vstack(note)",
    "cat('after layout\\n')", "out$append(note)",
    "cat('after append\\n')", "'tail'",
    "# %%", "note",
    "# %%", "out$lazy(function() note)",
    "# %%", "print.alder_bad_print <- function(x, ...) stop('printer failed')",
    "out$tabs(Bad = structure(1, class = 'alder_bad_print'))",
    "# %%", "cat('worker recovered\\n')", "42"
  ))
  s <- m$session
  withr::defer(s$stop())
  s$run_all()
  wait_until_settled(s, timeout = 20)
  composed <- composition_cell(s, "cell-2")
  expect_identical(composed$status, "done")
  expect_identical(as.character(unlist(composed$log, use.names = FALSE)), c(
    "before layout", "renderer-message", "Warning: renderer-warning",
    "after layout", "renderer-message", "Warning: renderer-warning", "after append"
  ))
  expect_identical(composed$outputs[[1L]]$text, "printed result")
  terminal <- composition_cell(s, "cell-3")
  expect_identical(as.character(unlist(terminal$log, use.names = FALSE)),
                   c("renderer-message", "Warning: renderer-warning"))
  expect_identical(terminal$outputs[[1L]]$text, "printed result")
  lazy <- composition_cell(s, "cell-4")$outputs[[1L]]
  s$request_lazy(lazy$key)
  wait_for(s, function()
    identical(composition_cell(s, "cell-4")$outputs[[1L]]$state, "loaded"),
    timeout = 10)
  lazy_cell <- composition_cell(s, "cell-4")
  expect_identical(lazy_cell$outputs[[1L]]$child$text, "printed result")
  expect_match(paste(unlist(lazy_cell$log), collapse = "\n"),
               "Warning: renderer-warning", fixed = TRUE)
  failure <- composition_cell(s, "cell-5")
  expect_identical(failure$status, "error")
  expect_match(failure$error$message, "printer failed", fixed = TRUE)
  expect_identical(composition_cell(s, "cell-6")$outputs[[1L]]$text, "[1] 42")
  expect_true(s$worker_available())
})
