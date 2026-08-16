# Widget proxy semantics (ADR 0003): the proxy IS the value.

test_that("slider proxy coerces and behaves as its numeric value", {
  n <- alder:::ui$slider(10, 1000, value = 100)
  expect_equal(as.numeric(n), 100)
  expect_true(is.numeric(n))
  expect_false(n > 200)
  expect_equal(n + 5, 105)
  expect_equal(sqrt(n), 10)
})

test_that("proxy works in tidy-eval style predicates", {
  n <- alder:::ui$slider(10, 1000, value = 300)
  d <- data.frame(x = c(50, 500, 900))
  expect_equal(nrow(subset(d, x > n)), 2)
})

test_that("Summary-style aggregation unwraps proxies", {
  n <- alder:::ui$slider(5, 10, value = 7)
  expect_equal(sum(n), 7)
  expect_equal(max(n, 100), 100)
  expect_equal(sort(c(n, 3)), c(3, 7))
})

test_that("$value returns the current value while .value stays internal", {
  n <- alder:::ui$slider(5, 10, value = 7)
  expect_equal(n$value, 7)
  # `$value` follows updates made through the proxy
  n[[".value"]] <- 8
  expect_equal(n$value, 8)
  d <- alder:::ui$dropdown(c("a", "b"), value = "b")
  expect_equal(d$value, "b")
  expect_equal(d$.value, "b")
})

test_that("literal NULL stays a binary operand", {
  n <- alder:::ui$slider(5, 10, value = 7)
  expect_equal(n + NULL, numeric(0))   # binary: 7 + NULL
  expect_equal(n > NULL, logical(0))
  expect_equal(-n, -7)                 # unary still works
  expect_equal(!alder:::ui$checkbox(TRUE), FALSE)
})

test_that("mean() on a widget delegates to the unwrapped value", {
  n <- alder:::ui$slider(5, 10, value = 7)
  expect_equal(mean(n), 7)
  expect_equal(mean(n, trim = 0.1), 7)
  expect_equal(mean(n, na.rm = TRUE), 7)
  x <- alder:::ui$slider(1, 4, value = 2)
  expect_equal(mean(c(n, x, 10)), mean(c(7, 2, 10)))
  expect_equal(mean(c(n, x), trim = 0.2, na.rm = TRUE),
               mean(c(7, 2), trim = 0.2, na.rm = TRUE))
  na <- alder:::ui$slider(0, 5, value = NA_real_)
  expect_equal(mean(c(na, 3), na.rm = TRUE), 3)
})

test_that("dropdown and text_input proxies expose their value", {
  d <- alder:::ui$dropdown(c("a", "b", "c"), value = "b")
  expect_equal(as.character(d), "b")
  t <- alder:::ui$text_input("hi")
  expect_equal(as.character(t), "hi")
})

test_that("widget carries control spec and updates in place", {
  n <- alder:::ui$slider(0, 9, value = 3, step = 2)
  expect_true(inherits(n, "alder_widget_proxy"))
  expect_equal(n$.kind, "slider")   # dispatch-safe spec access
  expect_equal(n$.value, 3)
  expect_equal(n$min, 0)
  n[[".value"]] <- 5
  expect_equal(as.numeric(n), 5)
})
