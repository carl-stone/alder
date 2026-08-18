test_that("app configuration uses stable defaults", {
  nb <- alder:::parse_notebook_lines(
    path = NA_character_, lines = c("# %%", "x <- 1")
  )
  expect_identical(
    alder:::alder_app_config(nb),
    list(layout = "vertical", width = "medium", include_code = FALSE)
  )
})

test_that("app metadata overrides defaults and survives round-trip", {
  nb <- alder:::parse_notebook_lines(
    path = "demo.R",
    lines = c(
      "# ---", "# title: Demo", "# author: alder", "# ---", "",
      "# %%", "x <- 1"
    )
  )
  nb <- alder:::nb_set_metadata(
    nb, "app", list(layout = "grid", width = "full", include_code = TRUE)
  )
  expect_identical(
    alder:::alder_app_config(nb),
    list(layout = "grid", width = "full", include_code = TRUE)
  )

  changed <- alder:::alder_set_app_config(
    nb, list(layout = "slides", include_code = FALSE)
  )
  expect_identical(
    changed$metadata$app,
    list(layout = "slides", width = "full", include_code = FALSE)
  )
  reopened <- alder:::read_notebook(
    local({
      path <- tempfile(fileext = ".R")
      writeBin(charToRaw(alder:::serialize_notebook(changed)), path)
      path
    })
  )
  expect_identical(reopened$metadata$app, changed$metadata$app)
  expect_identical(reopened$metadata$title, "Demo")
  expect_identical(reopened$metadata$author, "alder")
})

test_that("app updates preserve cell bytes and unrelated metadata", {
  raw <- paste0(
    "# ---\r\n# title: Keep me\r\n# owner: test\r\n# ---\r\n",
    "# %%\r\nx <- 1\r\n# odd source\n"
  )
  path <- tempfile(fileext = ".R")
  writeBin(charToRaw(raw), path)
  nb <- alder:::read_notebook(path)
  before_cells <- paste0(
    unlist(lapply(nb$cells, function(cell) {
      vapply(cell$records, function(record) paste0(record$text, record$eol), "")
    }), use.names = FALSE), collapse = ""
  )
  changed <- alder:::alder_set_app_config(nb, list(width = "compact"))
  after_cells <- paste0(
    unlist(lapply(changed$cells, function(cell) {
      vapply(cell$records, function(record) paste0(record$text, record$eol), "")
    }), use.names = FALSE), collapse = ""
  )
  expect_identical(after_cells, before_cells)
  expect_identical(changed$metadata$title, "Keep me")
  expect_identical(changed$metadata$owner, "test")
})

test_that("invalid app updates use the invalid_request error code", {
  nb <- alder:::parse_notebook_lines("demo.R", c("# %%", "x <- 1"))
  bad <- list(
    list(layout = "columns"),
    list(width = "wide"),
    list(include_code = c(TRUE, FALSE)),
    list(include_code = NA),
    list(unknown = TRUE),
    list(layout = "grid", layout2 = "vertical")
  )
  for (updates in bad) {
    err <- tryCatch(
      alder:::alder_set_app_config(nb, updates),
      alder_error = identity
    )
    expect_s3_class(err, "alder_error")
    expect_identical(err$code, "invalid_request")
  }
})

test_that("app titles use metadata, sans-extension basename, or a safe fallback", {
  path <- file.path(tempdir(), "sample-notebook.R")
  nb <- alder:::parse_notebook_lines(path, c("# %%", "x <- 1"))
  expect_identical(alder:::alder_app_title(nb), "sample-notebook")

  nb <- alder:::nb_set_metadata(nb, "title", "Published demo")
  expect_identical(alder:::alder_app_title(nb), "Published demo")
  nb <- alder:::nb_set_metadata(nb, "title", "")
  expect_identical(alder:::alder_app_title(nb), "sample-notebook")

  pathless <- alder:::parse_notebook_lines(NA_character_, c("# %%", "x <- 1"))
  expect_identical(alder:::alder_app_title(pathless), "Untitled notebook")
})

test_that("app descriptions use the first markdown cell and truncate at 240 chars", {
  long <- paste(rep("word", 80L), collapse = " ")
  nb <- alder:::parse_notebook_lines(
    NA_character_,
    c(
      "# %%", "x <- 1", "# %% [markdown]", "# First   paragraph", "#", 
      paste0("# ", long), "# %% [markdown]", "# Later cell"
    )
  )
  description <- alder:::alder_app_description(nb)
  expect_true(startsWith(description, "First paragraph"))
  expect_false(grepl("^#", description))
  expect_length(description, 1L)
  expect_lte(nchar(description, type = "chars"), 240L)
  expect_identical(description, substr(description, 1L, 240L))

  no_markdown <- alder:::parse_notebook_lines(NA_character_, c("# %%", "x <- 1"))
  expect_identical(alder:::alder_app_description(no_markdown), "")
})
