# Focused contracts for static export, diagnostics, source/test execution, and
# ipynb/Rmd/qmd conversion. These tests deliberately avoid HTTP routes; the
# live export route is owned by the server phase.

export_test_notebook <- function(path) {
  writeLines(c(
    "# ---", "# title: Export demo", "# ---", "# %% [markdown]",
    "# # A heading", "# %%", "x <- 1", "# %%", "x + 1"
  ), path, useBytes = TRUE)
  path
}

test_that("all static exporters write their declared formats", {
  td <- tempfile("alder-export-")
  dir.create(td)
  nb_path <- export_test_notebook(file.path(td, "demo.R"))
  outputs <- setNames(lapply(c("html", "md", "script", "ipynb", "qmd", "session"),
                             function(fmt) {
                               out <- file.path(td, paste0("demo.", fmt,
                                                            if (fmt == "script") "R" else ""))
                               alder:::alder_export(nb_path, fmt, out = out,
                                                    include_code = TRUE)
                               out
                             }),
                     c("html", "md", "script", "ipynb", "qmd", "session"))
  expect_true(all(vapply(outputs, file.exists, logical(1))))
  expect_true(startsWith(paste(readLines(outputs$html, warn = FALSE), collapse = "\n"),
                         "<!DOCTYPE html"))
  expect_match(paste(readLines(outputs$html, warn = FALSE), collapse = "\n"),
               "A heading")
  expect_match(paste(readLines(outputs$script, warn = FALSE), collapse = "\n"),
               "x <- 1")
  ip <- jsonlite::fromJSON(outputs$ipynb, simplifyVector = FALSE)
  expect_length(ip$cells, 3L)
  expect_identical(vapply(ip$cells, `[[`, character(1), "cell_type"),
                   c("markdown", "code", "code"))
  session <- jsonlite::fromJSON(outputs$session, simplifyVector = FALSE)
  expect_equal(session$version, 1)
  expect_length(session$cells, 3L)
})

test_that("ipynb export converts back with cell types and bodies", {
  td <- tempfile("alder-roundtrip-")
  dir.create(td)
  source <- export_test_notebook(file.path(td, "roundtrip.R"))
  ipynb <- file.path(td, "roundtrip.ipynb")
  alder:::alder_export(source, "ipynb", out = ipynb)
  converted <- file.path(td, "converted.R")
  alder:::alder_convert(ipynb, out = converted)
  original <- alder:::read_notebook(source)
  result <- alder:::read_notebook(converted)
  expect_identical(vapply(result$cells, `[[`, character(1), "type"),
                   vapply(original$cells, `[[`, character(1), "type"))
  expect_identical(lapply(result$cells, `[[`, "body"),
                   lapply(original$cells, `[[`, "body"))
})

test_that("Rmd and qmd chunks map supported alder options", {
  td <- tempfile("alder-rmd-")
  dir.create(td)
  for (ext in c("Rmd", "qmd")) {
    source <- file.path(td, paste0("input.", ext))
    writeLines(c(
      "---", "title: Chunk demo", "custom: retained", "---", "",
      "A paragraph.", "", "```{r sample, echo=FALSE, eval=FALSE, cache=TRUE}",
      "x <- 1", "```"
    ), source, useBytes = TRUE)
    converted <- file.path(td, paste0("output-", ext, ".R"))
    alder:::alder_convert(source, out = converted)
    nb <- alder:::read_notebook(converted)
    expect_identical(nb$metadata$title, "Chunk demo")
    expect_identical(nb$metadata$custom, "retained")
    code <- nb$cells[[2L]]
    expect_identical(code$type, "code")
    expect_identical(code$options$name, "sample")
    expect_true(isTRUE(code$options$hide_code))
    expect_true(isTRUE(code$options$disabled))
    expect_false("cache" %in% names(code$options))
  }
})

test_that("alder_check prints diagnostics and rejects duplicate definitions", {
  td <- tempfile("alder-check-")
  dir.create(td)
  good <- export_test_notebook(file.path(td, "good.R"))
  clean <- capture.output(result <- alder:::alder_check(good))
  expect_length(clean, 0L)
  expect_equal(nrow(result), 0L)
  bad <- file.path(td, "bad.R")
  writeLines(c("# %%", "x <- 1", "# %%", "x <- 2"), bad, useBytes = TRUE)
  printed <- capture.output(expect_error(alder:::alder_check(bad),
                                         "alder_check found 2 error diagnostics"))
  expect_true(any(grepl("duplicate-definition", printed, fixed = TRUE)))
})

test_that("alder_source evaluates topologically and alder_test runs marked cells", {
  td <- tempfile("alder-source-")
  dir.create(td)
  path <- file.path(td, "source.R")
  writeLines(c("# %%", "x <- 1", "# %%", "#| test: true",
               "testthat::expect_equal(x, 1)"), path, useBytes = TRUE)
  env <- new.env(parent = globalenv())
  expect_invisible(alder:::alder_source(path, env))
  results <- alder:::alder_test(path)
  expect_s3_class(results, "testthat_results")
  expect_length(results, 1L)
  expect_true(any(vapply(results[[1L]]$results, inherits,
                          logical(1), "expectation_success")))
})

test_that("unsupported conversion fails with convert_failed", {
  td <- tempfile("alder-convert-error-")
  dir.create(td)
  path <- file.path(td, "input.txt")
  writeLines("not a notebook", path)
  expect_error(alder:::alder_convert(path), class = "alder_error")
  err <- tryCatch(alder:::alder_convert(path), error = identity)
  expect_identical(err$code, "convert_failed")
})
