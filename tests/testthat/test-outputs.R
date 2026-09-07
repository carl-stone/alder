# Output constructors, media/layout rendering, plot capture, and lazy values.

output_cell <- function(s, id) {
  st <- s$state()
  for (cell in st$cells) {
    if (identical(cell$id, id)) return(cell)
  }
  stop("no such cell: ", id)
}

output_records <- function(s, id) {
  cell <- output_cell(s, id)
  if (is.null(cell$outputs)) list() else cell$outputs
}

test_that("out constructors produce sanitized wire records", {
  md <- out$md(c("**bold**", "line"))
  expect_equal(md$kind, "markdown")
  expect_match(md$html, "<strong>bold</strong>")
  expect_false(grepl("script", md$html, fixed = TRUE))

  html <- out$html("<script>alert(1)</script><strong>safe</strong>")
  expect_equal(html$kind, "markdown")
  expect_false(grepl("script", html$html, fixed = TRUE))
  expect_match(html$html, "<strong>safe</strong>")

  runtime <- get("RUNTIME", envir = asNamespace("alder"))
  old_dir <- runtime$artifact_dir
  artifact_dir <- tempfile("alder-output-artifacts-")
  dir.create(artifact_dir)
  runtime$artifact_dir <- artifact_dir
  withr::defer({
    runtime$artifact_dir <- old_dir
    unlink(artifact_dir, recursive = TRUE)
  })

  raw <- as.raw(c(137L, 80L, 78L, 71L))
  for (constructor in list(out$image, out$audio, out$video, out$pdf)) {
    record <- constructor(raw)
    expect_equal(record$kind, "media")
    expect_true(file.exists(file.path(artifact_dir, record$artifact)))
  }

  layout <- out$tabs(first = 1, second = 2)
  expect_equal(layout$kind, "layout")
  expect_equal(layout$layout, "tabs")
  expect_identical(unclass(layout$attrs$titles), c("first", "second"))
  expect_length(layout$children, 2)

  invalid_widget <- out$hstack(ui$slider(0, 1))
  expect_equal(invalid_widget$children[[1]]$kind, "error")
  expect_match(invalid_widget$children[[1]]$message, "bare variable name")
})

test_that("base graphics and media records precede the final value", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "plot(1:10); out$md('tail')"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  outputs <- output_records(s, "cell-2")
  expect_true(any(vapply(outputs, function(x) identical(x$kind, "image"),
    logical(1))))
  expect_equal(tail(outputs, 1L)[[1L]]$kind, "markdown")

  image_index <- which(vapply(outputs,
    function(x) identical(x$kind, "image"), logical(1)))
  old_artifact <- outputs[[image_index[[1L]]]]$artifact
  artifact_dir <- m$boot$ready$artifactDirectory
  expect_true(file.exists(file.path(artifact_dir, old_artifact)))
  expect_identical(s$await_operation(s$run_cell("cell-2")$run_id)$status,
                   "done")
  current_outputs <- output_records(s, "cell-2")
  current_index <- which(vapply(current_outputs,
    function(x) identical(x$kind, "image"), logical(1)))[[1L]]
  current_artifact <- current_outputs[[current_index]]$artifact
  expect_false(identical(current_artifact, old_artifact))
  expect_true(file.exists(file.path(artifact_dir, current_artifact)))
})

test_that("lazy output expands once and expires after a rerun", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "out$lazy(function() 1 + 1)"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  key <- output_records(s, "cell-2")[[1L]]$key
  expect_identical(s$await_operation(s$request_lazy(key))$status, "done")
  expanded <- output_records(s, "cell-2")[[1L]]
  expect_equal(expanded$state, "loaded")
  expect_equal(expanded$child$kind, "text")
  expect_match(expanded$child$text, "2")

  expect_identical(s$await_operation(s$run_cell("cell-2")$run_id)$status,
                   "done")
  err <- tryCatch({
    operation <- s$request_lazy(key)
    s$await_operation(operation)
    NULL
  }, error = identity)
  expect_s3_class(err, "alder_error")
  expect_equal(err$code, "lazy_expired")
  expect_match(conditionMessage(err), "earlier run")
})

test_that("table pages sort, filter, and expire with the source", {
  m <- make_test_session(c(
    "# %%", "library(alder)",
    "# %%", "df <- data.frame(x = 1:500, group = paste0('g', 1:500))",
    "# %%", "df"
  ), execution_mode = "lazy")
  s <- m$session
  withr::defer(m$close())
  expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
  wait_for(s, function() {
    vars <- s$state()$variables
    if (is.null(vars)) vars <- list()
    any(vapply(vars, function(x) identical(x$name, "df"), logical(1)))
  })
  vars <- s$state()$variables
  df_index <- which(vapply(vars, function(x)
    identical(x$name, "df"), logical(1)))[[1L]]
  df_var <- vars[[df_index]]
  expect_equal(df_var$class, "data.frame")
  expect_equal(as.integer(df_var$dim), c(500L, 2L))
  expect_equal(df_var$owner, "cell-2")

  output <- tail(output_records(s, "cell-3"), 1L)[[1L]]
  expect_equal(output$kind, "table")
  expect_equal(output$nrow, 500)
  expect_length(output$preview, 25)
  handle <- output$handle

  operation <- s$request_table_page(handle, offset = 100, limit = 10,
                                    sort_by = "x", sort_desc = TRUE)
  expect_identical(s$await_operation(operation)$status, "done")
  page <- tail(output_records(s, "cell-3"), 1L)[[1L]]$page
  expect_equal(page$limit, 10)
  expect_equal(page$preview[[1L]][[1L]], "400")

  operation <- s$request_table_page(handle, filter = "g3")
  expect_identical(s$await_operation(operation)$status, "done")
  page <- tail(output_records(s, "cell-3"), 1L)[[1L]]$page
  expect_true(all(grepl("g3", vapply(page$preview,
                                     function(row) row[[2L]], ""), fixed = TRUE)))

  s$delete_cell("cell-2", expected_revision = 0)
  error <- tryCatch({
    operation <- s$request_table_page(handle)
    s$await_operation(operation)
    NULL
  }, alder_error = identity)
  expect_s3_class(error, "alder_error")
  expect_identical(error$code, "table_unavailable")
})
