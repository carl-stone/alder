test_that("notebook round-trips byte-identical", {
  lines <- c(
    "# ---", "# title: demo", "# author: carl", "# ---", "",
    "# %%", "library(dplyr)", "raw <- readr::read_csv(\"counts.csv\")", "",
    "# %%", "filtered <- raw |> dplyr::filter(count > 100)", "",
    "# %% [markdown]", "A markdown cell.", "",
    "# %%", "pl <- ggplot(filtered, aes(gene, count)) + geom_point()", ""
  )
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_identical(alder:::serialize_notebook(nb),
                   paste0(paste(lines, collapse = "\n"), "\n"))
})

test_that("parse extracts types, metadata, and options", {
  lines <- c("# %%", "x <- 1", "", "# %% [markdown]", "md text", "",
             "# %%", "#| id: special", "y <- 2")
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_equal(vapply(nb$cells, function(c) c$type, ""),
               c("code", "markdown", "code"))
  # cell metadata via #| options
  special <- alder:::nb_cell(nb, "cell-3")
  expect_equal(special$options$id, "special")
  expect_equal(special$delim, "# %%")
})

test_that("notebook header metadata parsed from YAML block", {
  lines <- c("# ---", "# title: hello", "# pi: 3.14", "# ---", "", "# %%", "x <- 1")
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_equal(nb$metadata$title, "hello")
  expect_equal(nb$metadata$pi, "3.14")
})

test_that("cell body mutation preserves position and serializes correctly", {
  nb <- alder:::parse_notebook_lines("x.R", c("# %%", "a <- 1", "", "# %%", "b <- 2"))
  nb <- alder:::nb_set_cell_body(nb, "cell-2", c("b <- 20", "b2 <- b + 1"))
  out <- alder:::serialize_notebook(nb)
  expect_match(out, "b <- 20", fixed = TRUE)
  expect_match(out, "b2 <- b + 1", fixed = TRUE)
  expect_match(out, "a <- 1", fixed = TRUE)
})

test_that("empty notebook parses and reserializes", {
  nb <- alder:::parse_notebook_lines(NULL, character())
  expect_equal(length(nb$cells), 0L)
  expect_identical(alder:::serialize_notebook(nb), "")
})

test_that("save -> reopen -> serialize is byte-stable (no growth on rewrite)", {
  lines <- c("# %%", "x <- 1", "", "# %%", "y <- x + 1", "")
  f <- tempfile(fileext = ".R")
  nb <- alder:::parse_notebook_lines(f, lines)
  alder:::write_notebook(nb, f)
  b1 <- readBin(f, "raw", n = file.info(f)$size)

  for (i in 1:3) {  # re-save repeatedly must not grow the file
    nb2 <- alder:::read_notebook(f)
    alder:::write_notebook(nb2, f)
  }
  b2 <- readBin(f, "raw", n = file.info(f)$size)
  expect_identical(b1, b2)
})

write_raw_file <- function(text) {
  f <- tempfile(fileext = ".R")
  writeBin(charToRaw(text), f)
  f
}

test_that("mixed CRLF/LF/CR files round-trip byte-identically", {
  text <- "# ---\r\n# title: mixed\r\n# ---\r\n\r\n# %%\r\nx <- 1\n\n# %%\n#| id: special\n y <- x\r\n"
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  expect_identical(alder:::serialize_notebook(nb), text)
  expect_identical(nb$preferred_eol, "\r\n")  # first nonempty EOL
  expect_true(nb$final_newline)
  expect_equal(nb$cells[[2]]$options$id, "special")
})

test_that("no-final-newline files round-trip byte-identically", {
  text <- "# %%\nx <- 1\r\n# %%\ny <- x + 1"   # last record has no EOL
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  expect_identical(alder:::serialize_notebook(nb), text)
  expect_false(nb$final_newline)
  # write/re-read again stays byte-stable
  alder:::write_notebook(nb, f)
  expect_identical(readChar(f, file.info(f)$size, useBytes = TRUE), text)
})

test_that("CR-only terminators round-trip byte-identically", {
  text <- "# %%\rx <- 1\rx\r"
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  expect_identical(alder:::serialize_notebook(nb), text)
})

test_that("invalid UTF-8 fails with the file path before any change", {
  f <- tempfile(fileext = ".R")
  writeBin(as.raw(c(0x23, 0x20, 0x25, 0x25, 0x0a, 0xff, 0xfe, 0x21)), f)
  expect_error(alder:::read_notebook(f), f)
  expect_equal(file.info(f)$size, 8)  # untouched
})

test_that("body growth transfers terminal EOL on no-final-newline file", {
  # "# %%\na" — the delimiter has no EOL either, so preferred falls back to LF.
  f <- write_raw_file("# %%\na")
  nb <- alder:::read_notebook(f)
  expect_false(nb$final_newline)
  nb <- alder:::nb_set_cell_body(nb, "cell-1", c("b", "c"))
  expect_identical(alder:::serialize_notebook(nb), "# %%\nb\nc")
  # second edit keeps the invariant: exactly one terminal record without EOL
  nb <- alder:::nb_set_cell_body(nb, "cell-1", c("d"))
  expect_identical(alder:::serialize_notebook(nb), "# %%\nd")
})

test_that("EOF body growth/shrink on final-newline file", {
  f <- write_raw_file("# %%\na\n")
  nb <- alder:::read_notebook(f)
  nb <- alder:::nb_set_cell_body(nb, "cell-1", c("a", "b"))
  expect_identical(alder:::serialize_notebook(nb), "# %%\na\nb\n")
  nb <- alder:::nb_set_cell_body(nb, "cell-1", "z")
  expect_identical(alder:::serialize_notebook(nb), "# %%\nz\n")
})

test_that("zero-body insertion lands after options and preserves them", {
  f <- write_raw_file("# %%\n#| key: 1\nx <- 1\n")
  nb <- alder:::read_notebook(f)
  nb <- alder:::nb_set_cell_body(nb, "cell-1", c("y <- 2"))
  expect_identical(alder:::serialize_notebook(nb), "# %%\n#| key: 1\ny <- 2\n")
  # zero-body insertion into an option-only cell at EOF without final newline
  f2 <- write_raw_file("# %%\n#| key: 1")
  nb2 <- alder:::read_notebook(f2)
  nb2 <- alder:::nb_set_cell_body(nb2, "cell-1", c("y <- 2"))
  expect_identical(alder:::serialize_notebook(nb2), "# %%\n#| key: 1\ny <- 2")
  # shrink the body back to nothing
  nb2 <- alder:::nb_set_cell_body(nb2, "cell-1", character())
  expect_identical(alder:::serialize_notebook(nb2), "# %%\n#| key: 1")
})

test_that("duplicate and oddly-spaced options survive edits byte-for-byte", {
  f <- write_raw_file("# %%\n#| key:  1\n#| other : two\n#| key: 3\nx <- 1\n")
  nb <- alder:::read_notebook(f)
  c1 <- alder:::nb_cell(nb, "cell-1")
  expect_equal(c1$options$key, "3")
  expect_equal(c1$options$other, "two")
  expect_identical(c1$option_duplicates$key, c(2L, 4L))  # 1-based record positions
  nb <- alder:::nb_set_cell_body(nb, "cell-1", "y <- 2")
  expect_identical(alder:::serialize_notebook(nb),
                   "# %%\n#| key:  1\n#| other : two\n#| key: 3\ny <- 2\n")
  nb2 <- alder:::read_notebook(f)
  nb2 <- alder:::nb_set_cell_body(nb2, "cell-1", c("y <- 2", "z <- 3"))
  expect_identical(alder:::serialize_notebook(nb2),
                   "# %%\n#| key:  1\n#| other : two\n#| key: 3\ny <- 2\nz <- 3\n")
})

test_that("adding a cell transfers terminal EOF ownership", {
  # no final newline: old final record gains preferred EOL, new cell ends bare
  f <- write_raw_file("# %%\na")
  nb <- alder:::read_notebook(f)
  nb <- alder:::nb_add_cell(nb, "b")
  expect_identical(alder:::serialize_notebook(nb), "# %%\na\n# %%\nb")
  # final newline: appended cell's final record gets preferred EOL (CRLF)
  f2 <- write_raw_file("# %%\r\na\r\n")
  nb2 <- alder:::read_notebook(f2)
  nb2 <- alder:::nb_add_cell(nb2, "b")
  expect_identical(alder:::serialize_notebook(nb2), "# %%\r\na\r\n# %%\r\nb\r\n")
  # deleting the last cell in a no-final-newline file keeps the policy
  nb3 <- alder:::nb_delete_cell(nb, "cell-2")
  expect_identical(alder:::serialize_notebook(nb3), "# %%\na")
})

test_that("delete/add allocate from a monotonic counter, never reusing ids", {
  nb <- alder:::parse_notebook_lines("x.R", c("# %%", "a", "# %%", "b", "# %%", "c"))
  nb <- alder:::nb_add_cell(nb, "d")
  expect_identical(nb$cells[[4]]$id, "cell-4")
  nb <- alder:::nb_delete_cell(nb, "cell-2")
  nb <- alder:::nb_add_cell(nb, "d2")
  expect_identical(vapply(nb$cells, function(c) c$id, ""),
                   c("cell-1", "cell-3", "cell-4", "cell-5"))
  # fresh notebook: delete then add must allocate past the hole, not cell-3
  nb2 <- alder:::parse_notebook_lines("x.R", c("# %%", "a", "# %%", "b", "# %%", "c"))
  nb2 <- alder:::nb_delete_cell(nb2, "cell-2")
  nb2 <- alder:::nb_add_cell(nb2, "d")
  expect_identical(vapply(nb2$cells, function(c) c$id, ""),
                   c("cell-1", "cell-3", "cell-4"))
  expect_no_error(alder:::serialize_notebook(nb2))
})

test_that("header-only file round-trips byte-identically", {
  text <- "# hello\r\n"
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  expect_identical(alder:::serialize_notebook(nb), text)
  expect_length(nb$cells, 0)
})

test_that("edits preserve trailing blank separators between cells", {
  text <- "# %%\npeng <- iris\nnrow(peng)\n\n# %%\nb <- 2\n"
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  # grow: the new body lines land before the blank; the blank survives
  nb1 <- alder:::nb_set_cell_body(nb, "cell-1",
    c("peng <- iris", "nrow(peng)", "# marker"))
  expect_identical(alder:::serialize_notebook(nb1),
    "# %%\npeng <- iris\nnrow(peng)\n# marker\n\n# %%\nb <- 2\n")
  # shrink: one content line, the blank still separates the cells
  nb2 <- alder:::nb_set_cell_body(nb, "cell-1", "peng <- iris")
  expect_identical(alder:::serialize_notebook(nb2),
    "# %%\npeng <- iris\n\n# %%\nb <- 2\n")
  # zero-body: only the blank remains between delimiters
  nb3 <- alder:::nb_set_cell_body(nb, "cell-1", character())
  expect_identical(alder:::serialize_notebook(nb3), "# %%\n\n# %%\nb <- 2\n")
})
