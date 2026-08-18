# Pure app-layout sidecar, grid, slides, and gallery contracts.

layout_write_raw <- function(text, ext = ".R") {
  path <- tempfile(fileext = ext)
  writeBin(charToRaw(text), path)
  path
}


test_that("layout sidecars round-trip deterministically and atomically", {
  notebook <- layout_write_raw("# %%\nx <- 1\n")
  layout <- list(
    version = 1,
    layout = "grid",
    cells = list(
      `cell-2` = list(x = 6, y = 2, w = 6, h = 3),
      `cell-1` = list(x = 0, y = 0, w = 6, h = 2)
    )
  )
  alder:::alder_layout_write(notebook, layout)
  sidecar <- paste0(notebook, ".alder-layout.json")
  expect_true(file.exists(sidecar))
  first <- readBin(sidecar, "raw", n = file.info(sidecar)$size)
  expect_identical(alder:::alder_layout_read(notebook),
                   alder:::alder_layout_validate(layout))

  # The same logical object produces byte-identical JSON and replaces the
  # existing sidecar rather than appending to it.
  alder:::alder_layout_write(notebook, layout)
  second <- readBin(sidecar, "raw", n = file.info(sidecar)$size)
  expect_identical(first, second)
  expect_match(rawToChar(first), '"cell-1"', fixed = TRUE)
  expect_match(rawToChar(first), '"cell-2"', fixed = TRUE)
})

test_that("grid defaults follow document order and honor named cells", {
  nb <- alder:::parse_notebook_lines("x.R", c(
    "# %%", "#| name: first", "a <- 1",
    "# %%", "b <- 2",
    "# %%", "#| name: third", "c <- 3"
  ))
  positions <- alder:::alder_grid_positions(nb)
  expect_identical(names(positions), c("first", "cell-2", "third"))
  expect_equal(unname(vapply(positions, `[[`, integer(1), "x")), c(0L, 0L, 0L))
  expect_equal(unname(vapply(positions, `[[`, integer(1), "y")), c(0L, 1L, 2L))
  expect_equal(unname(vapply(positions, `[[`, integer(1), "w")), rep(12L, 3L))
  expect_equal(unname(vapply(positions, `[[`, integer(1), "h")), rep(1L, 3L))

  saved <- list(version = 1, cells = list(
    first = list(x = 3, y = 4, w = 4, h = 2)
  ))
  moved <- alder:::alder_grid_positions(nb, saved)
  expect_identical(moved$first, list(x = 3L, y = 4L, w = 4L, h = 2L))
  expect_equal(moved[[2]]$y, 0L)
  expect_equal(moved[[3]]$y, 1L)
})

test_that("invalid layout geometry and traversal raise alder errors", {
  bad_geometry <- tryCatch(
    alder:::alder_layout_validate(list(
      version = 1,
      cells = list(bad = list(x = 11, y = 0, w = 2, h = 1))
    )),
    error = function(e) e
  )
  expect_s3_class(bad_geometry, "alder_error")
  expect_identical(bad_geometry$code, "invalid_layout")
  expect_error(
    alder:::alder_layout_validate(list(
      version = 1,
      cells = list(`../escape` = list(x = 0, y = 0, w = 1, h = 1))
    )),
    class = "alder_error"
  )
  expect_error(
    alder:::alder_layout_validate(list(
      version = 1,
      cells = list(bad = list(x = Inf, y = 0, w = 1, h = 1))
    )),
    class = "alder_error"
  )
  expect_error(
    alder:::alder_layout_validate(list(version = 1, layout = "diagonal", cells = list())),
    class = "alder_error"
  )
})

test_that("slides split at level one/two headings and preserve explicit order", {
  nb <- alder:::parse_notebook_lines("x.R", c(
    "# %%", "a <- 1",
    "# %% [markdown]", "# First",
    "# %%", "b <- 2",
    "# %% [markdown]", "### not a slide boundary",
    "# %%", "c <- 3",
    "# %%", "#| slide: true", "d <- 4"
  ))
  expect_identical(
    alder:::alder_slide_groups(nb),
    list(c("cell-1"), c("cell-2", "cell-3", "cell-4", "cell-5"), "cell-6")
  )

  explicit <- list(version = 1, layout = "slides", cells = list(),
                   slides = list(c("cell-6", "cell-1"), c("cell-3")))
  expect_identical(
    alder:::alder_slide_groups(nb, explicit),
    list(c("cell-6", "cell-1"), "cell-3", "cell-2", "cell-4", "cell-5")
  )
})

test_that("gallery index filters notebooks, sorts stably, and truncates descriptions", {
  dir <- tempfile("alder-gallery-")
  dir.create(dir)
  long <- paste(rep("description", 40L), collapse = " ")
  writeLines(c(
    "# ---", "# title: Alpha", "# ---", "# %% [markdown]",
    paste0("# ", long), "# %%", "x <- 1"
  ), file.path(dir, "a.R"))
  writeLines(c(
    "# %% [markdown]", "# Beta text", "# %%", "y <- 2"
  ), file.path(dir, "b.R"))
  writeLines(c("x <- 1"), file.path(dir, "not-a-notebook.R"))
  writeLines(c("# %%", "z <- 3"), file.path(dir, "ignored.txt"))

  index <- alder:::alder_gallery_index(dir)
  expect_identical(vapply(index, `[[`, "", "basename"), c("a.R", "b.R"))
  expect_identical(index[[2]]$title, "b.R")
  expect_lte(nchar(index[[1]]$description), 240L)
  expect_true(startsWith(index[[2]]$description, "Beta text"))
  expect_identical(index, alder:::alder_gallery_index(c(
    file.path(dir, "b.R"), file.path(dir, "a.R"), file.path(dir, "ignored.txt")
  )))
})
