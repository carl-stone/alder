# Widget semantics (ADR 0003): plain classed `alder_widget` lists with
# explicit `$value`; no coercion/arithmetic/subsetting promises. The
# module is mirrored byte-for-byte into inst/worker (ADR 0007).

test_that("the worker mirror is byte-identical to the source of truth", {
  # testthat relocates the cwd to tests/testthat; anchor to the repo root.
  repo <- normalizePath(testthat::test_path("..", ".."))
  # Under pkgload::test_local the source sits at the repo root; under
  # R CMD check the tests copy lives in alder.Rcheck/tests/testthat and the
  # full source (R/ and inst/) sits under alder.Rcheck/00_pkg_src/alder.
  base <- repo
  if (!file.exists(file.path(base, "R", "ui-widgets.R"))) {
    base <- file.path(repo, "00_pkg_src", "alder")
  }
  src <- file.path(base, "R", "ui-widgets.R")
  mir <- file.path(base, "inst", "worker", "ui-widgets.R")
  expect_true(file.exists(src))
  expect_true(file.exists(mir))
  expect_identical(readBin(mir, "raw", n = file.info(mir)$size),
                   readBin(src, "raw", n = file.info(src)$size))
})

test_that("constructors return classed lists with explicit $value and no .value", {
  n <- alder:::ui$slider(10, 1000, value = 300)
  expect_true(inherits(n, "alder_widget"))
  expect_equal(n$kind, "slider")
  expect_equal(n$value, 300)
  expect_null(n$.value)
  expect_false(".value" %in% names(unclass(n)))
  # label may be NULL
  expect_null(n$label)
  expect_equal(alder:::ui$slider(1, 9, label = "l")$label, "l")
})

test_that("sliders and numbers normalize value and bounds to unclassed double", {
  n <- alder:::ui$slider(1L, 9L, value = 3L, step = 2L)
  expect_true(is.double(n$min) && is.double(n$max) && is.double(n$step))
  expect_true(is.double(n$value))
  m <- alder:::ui$number(5L, min = 1L, max = 10L)
  expect_true(is.double(m$value) && is.double(m$min) && is.double(m$max))
  # classless: a plain list under the class
  expect_false(is.object(unclass(n)))
})

test_that("validation rejects bad bounds, ranges, and step lattices", {
  expect_error(alder:::ui$slider(5, 1), "min")
  expect_error(alder:::ui$slider(1, 10, value = 11), "between")
  expect_error(alder:::ui$slider(1, 10, value = 0), "between")
  expect_error(alder:::ui$slider(1, 10, step = 0), "positive")
  expect_error(alder:::ui$slider(1, 10, step = -1), "positive")
  expect_error(alder:::ui$slider(1, 10, step = Inf), "finite")
  # off-lattice values rejected, on-lattice accepted
  expect_error(alder:::ui$slider(1, 10, value = 5.4, step = 1), "lattice")
  expect_equal(alder:::ui$slider(1, 10, value = 5.0, step = 1)$value, 5)
  # number: bound ordering, bound violation, and lattice base zero
  expect_error(alder:::ui$number(5, min = 10, max = 1), "min")
  expect_error(alder:::ui$number(0.5, step = 1), "lattice")
  expect_equal(alder:::ui$number(0, step = 1)$value, 0)
  expect_equal(alder:::ui$number(5, min = 1, step = 2)$value, 5)  # (5-1)/2 int
  expect_error(alder:::ui$number(6, min = 1, step = 2), "lattice")
})

test_that("validate_widget is the shared full-object contract", {
  # Fully constructed widgets validate cleanly, with or without a label.
  expect_silent(alder:::validate_widget(alder:::ui$slider(1, 10, value = 5)))
  expect_silent(alder:::validate_widget(alder:::ui$slider(1, 10, label = "warmth")))
  expect_silent(alder:::validate_widget(alder:::ui$dropdown(c("a", "b"))))
  expect_silent(alder:::validate_widget(alder:::ui$text_input()))
  expect_silent(alder:::validate_widget(alder:::ui$checkbox(TRUE)))
  expect_silent(alder:::validate_widget(alder:::ui$run_button()))
  # A widget whose kind or label field was corrupted by hand is rejected,
  # even when the value itself is fine: the object-level validator must not
  # depend on how the object was constructed.
  expect_error({
    w <- alder:::ui$slider(1, 10, value = 5)
    w$label <- 42
    alder:::validate_widget(w)
  }, "label")
  expect_error({
    w <- alder:::ui$slider(1, 10, value = 5)
    w$label <- c("a", "b")
    alder:::validate_widget(w)
  }, "label")
  expect_error({
    w <- alder:::ui$slider(1, 10, value = 5)
    w$kind <- "slidr"
    alder:::validate_widget(w)
  }, "kind")
  # A corrupted constraint spec is caught through the value validator.
  expect_error({
    w <- alder:::ui$slider(1, 10, value = 5)
    w$max <- "ten"
    alder:::validate_widget(w)
  }, "finite")
  expect_error(alder:::validate_widget(list(kind = "slider")), "alder_widget")
})

test_that("dropdown choices are validated and values preserve type", {
  expect_error(alder:::ui$dropdown(character()), "non-empty")
  expect_error(alder:::ui$dropdown(c("a", "a")), "unique")
  expect_error(alder:::ui$dropdown(c("a", NA)), "missing")
  expect_error(alder:::ui$dropdown(c(1, Inf)), "finite")
  expect_error(alder:::ui$dropdown(setNames(1:2, c("a", "b"))), "unnamed")
  expect_error(alder:::ui$dropdown(factor("a")), "unclassed")
  expect_error(alder:::ui$dropdown(c("a", "b"), value = "c"),
               "identical in type and value")
  # value must match exactly including type
  expect_error(alder:::ui$dropdown(c(1, 2), value = 1L), "identical")
  d <- alder:::ui$dropdown(c(1, 2))
  expect_true(is.double(d$value) && identical(d$value, 1))
  di <- alder:::ui$dropdown(c(1L, 2L), value = 2L)
  expect_true(is.integer(di$value) && identical(di$value, 2L))
  dc <- alder:::ui$dropdown(c("a", "b"), value = "b")
  expect_true(is.character(dc$value) && identical(dc$value, "b"))
})

test_that("text, checkbox, and run_button values are canonical scalars", {
  t <- alder:::ui$text_input("hi")
  expect_identical(t$value, "hi")
  expect_error(alder:::ui$text_input(NA_character_), "non-missing")
  expect_error(alder:::ui$text_input(c("a", "b")), "scalar")
  cb <- alder:::ui$checkbox(TRUE)
  expect_identical(cb$value, TRUE)
  expect_error(alder:::ui$checkbox(NA), "non-missing")
  expect_error(alder:::ui$checkbox(1), "logical")
})

test_that("run_button is a Boolean one-shot input that starts FALSE", {
  rb <- alder:::ui$run_button()
  expect_true(inherits(rb, "alder_widget"))
  expect_equal(rb$kind, "run_button")
  expect_identical(rb$value, FALSE)
  expect_false(is.null(rb$label))
  expect_equal(alder:::ui$run_button("go")$label, "go")
  # a run-button value is a logical scalar when driven by the worker
  rb$value <- TRUE
  expect_true(inherits(rb, "alder_widget"))
  rb <- alder:::validate_widget_value("run_button", TRUE, list())
  expect_identical(rb, TRUE)
  expect_error(alder:::validate_widget_value("run_button", 1, list()), "logical")
})

test_that("ui exposes the supported widget constructor set", {
  expect_setequal(
    names(alder:::ui),
    c(
      "slider", "range_slider", "dropdown", "radio", "multiselect",
      "text_input", "text_area", "number", "checkbox", "switch",
      "run_button", "button", "date", "date_range", "datetime",
      "code_editor", "refresh", "file", "table", "dataframe",
      "array", "dictionary", "form"
    )
  )
})

test_that("composite widget paths update only the addressed child", {
  original <- alder:::ui$array(
    alder:::ui$slider(0, 10, value = 2),
    alder:::ui$checkbox(FALSE)
  )
  expect_equal(alder:::widget_child(original, c("1"))$value, 2)
  expect_true(isTRUE(alder:::widget_child(original, c("2"))$value == FALSE))
  expect_error(alder:::widget_child(original, c(NA_character_)), "non-empty")
  expect_error(
    alder:::widget_set_child(original, c("missing"), TRUE),
    "does not exist"
  )

  updated <- alder:::widget_set_child(original, c("1"), 7)
  expect_equal(updated$value[[1]], 7)
  expect_identical(updated$value[[2]], FALSE)
  expect_equal(original$value[[1]], 2)

  form <- alder:::ui$form(original)
  edited_form <- alder:::widget_set_child(form, c("1"), 8)
  expect_null(edited_form$value)
  expect_equal(alder:::widget_child(edited_form$child, c("1"))$value, 8)
})

test_that("nested composites expose recursive child paths", {
  nested <- alder:::ui$dictionary(
    settings = alder:::ui$form(alder:::ui$array(
      alder:::ui$checkbox(FALSE),
      alder:::ui$dictionary(name = alder:::ui$text_input("before"))
    )),
    files = alder:::ui$file()
  )
  expect_true(isTRUE(alder:::widget_child(
    nested, c("settings", "1"))$value == FALSE))
  expect_identical(
    alder:::widget_child(nested, c("settings", "2", "name"))$value,
    "before"
  )
  changed <- alder:::widget_set_child(
    nested, c("settings", "2", "name"), "after"
  )
  expect_identical(
    alder:::widget_child(changed, c("settings", "2", "name"))$value,
    "after"
  )
  expect_identical(
    alder:::widget_child(changed, c("files"))$value,
    nested$value$files
  )
})

