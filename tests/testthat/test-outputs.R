# Output constructors, media/layout rendering, plot capture, and lazy values.

test_that("out constructors preserve raw output records", {
  md <- out$md(c("**bold**", "line"))
  expect_equal(md$kind, "markdown")
  expect_identical(md$text, "**bold**\nline")
  expect_false("html" %in% names(md))

  html <- out$html("<script>alert(1)</script><strong>safe</strong>")
  expect_equal(html$kind, "html")
  expect_identical(html$html, "<script>alert(1)</script><strong>safe</strong>")
  expect_false("text" %in% names(html))

  raw <- as.raw(c(137L, 80L, 78L, 71L))
  for (constructor in list(out$image, out$audio, out$video, out$pdf)) {
    record <- constructor(raw)
    expect_equal(record$kind, "media")
    expect_true(nzchar(record$artifact))
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

test_that("out$inspect truncates multibyte output at the byte boundary", {
  attrs <- setNames(as.list(rep("界界", 3000L)), paste0("a", seq_len(3000L)))
  fixture <- do.call(structure, c(list(.Data = 1), attrs))
  record <- out$inspect(fixture)

  expect_true(record$truncated)
  expect_identical(nchar(record$text, type = "bytes"), 65536L)
  expect_false(is.na(iconv(record$text, from = "UTF-8", to = "UTF-8",
                            sub = NA_character_)))
  expect_true(endsWith(record$text, "\n[output truncated]"))
})

test_that("stack layout attributes stay within the host protocol contract", {
  h <- out$hstack(gap = 0, align = "start", justify = "space-evenly")
  expect_identical(h$attrs, list(gap = 0, align = "start", justify = "space-evenly"))
  expect_identical(out$vstack(gap = 4096)$attrs, list(gap = 4096))

  expect_error(out$hstack(gap = -1), "gap")
  expect_error(out$vstack(gap = 4097), "gap")
  expect_error(out$hstack(gap = Inf), "gap")
  expect_error(out$hstack(align = "baseline"), "align")
  expect_error(out$hstack(justify = "space"), "justify")
})

test_that("progress and lazy labels reject non-scalar values", {
  expect_error(out$progress(total = Inf), "total")
  expect_error(out$progress(total = NA_real_), "total")
  expect_error(out$progress(label = NA_character_), "label")
  expect_error(out$progress(label = c("one", "two")), "label")

  progress <- out$progress(total = 1, label = "ready")
  expect_error(progress$update(label = NA_character_), "label")
  expect_error(progress$update(label = c("one", "two")), "label")

  expect_error(out$lazy(function() 1, label = NA_character_), "label")
  expect_error(out$lazy(function() 1, label = c("one", "two")), "label")
  expect_identical(out$lazy(function() 1, label = NULL), 1)
})
