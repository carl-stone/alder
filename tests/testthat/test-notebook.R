# Notebook parser/serializer contracts (ADR 0001): byte-identical round
# trips, physical record model, body-slot splicing, strict YAML metadata,
# terminal-EOL invariants, and hardened raw-read boundaries.

write_raw_file <- function(text) {
  f <- tempfile(fileext = ".R")
  writeBin(charToRaw(text), f)
  f
}

test_that("notebook round-trips byte-identical", {
  lines <- c(
    "# ---", "# title: demo", "# author: carl", "# ---", "",
    "# %%", "library(dplyr)", "raw <- readr::read_csv(\"counts.csv\")", "",
    "# %%", "filtered <- raw |> dplyr::filter(count > 100)", "",
    "# %% [markdown]", "# A markdown cell.", "",
    "# %%", "pl <- ggplot(filtered, aes(gene, count)) + geom_point()", ""
  )
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_identical(alder:::serialize_notebook(nb),
                   paste0(paste(lines, collapse = "\n"), "\n"))
})

test_that("parse extracts types, metadata, and options", {
  lines <- c("# %%", "x <- 1", "", "# %% [markdown]", "# md text", "",
             "# %%", "#| id: special", "y <- 2")
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_equal(vapply(nb$cells, function(c) c$type, ""),
               c("code", "markdown", "code"))
  special <- alder:::nb_cell(nb, "cell-3")
  expect_equal(special$options$id, "special")
  expect_equal(special$delim, "# %%")
  expect_null(alder:::nb_cell(nb, "nope"))
})

test_that("delimiter detection is exact: %% must be followed by space or EOL", {
  # `# %%x` is a comment, not a delimiter, so it belongs to the prior body.
  lines <- c("# %%", "x <- 1", "# %%x", "y <- 2", "# %%", "z <- 3")
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_equal(length(nb$cells), 2L)
  expect_equal(nb$cells[[1]]$body, c("x <- 1", "# %%x", "y <- 2"))
  # zero-space `#%%` delimiters still work (whitespace is optional).
  nb2 <- alder:::parse_notebook_lines("x.R", c("#%%", "a", "#%%", "b"))
  expect_equal(length(nb2$cells), 2L)
})

test_that("markdown tag is standalone and case-insensitive", {
  nb <- alder:::parse_notebook_lines("x.R", c(
    "# %% [Markdown]", "# hi", "# %%", "x <- 1",
    "# %% [markdown] extra", "not md?"))
  types <- vapply(nb$cells, function(c) c$type, "")
  expect_identical(types, c("markdown", "code", "code"))
  # `# %% [markdown] extra` is a code cell whose body carries the text.
  expect_equal(nb$cells[[3]]$delim, "# %% [markdown] extra")
})

test_that("markdown cells must be blank lines or R comments", {
  # plain text inside a markdown cell is rejected at parse...
  expect_error(
    alder:::parse_notebook_lines("x.R", c("# %% [markdown]", "plain text")),
    "markdown cell lines must be blank or R comments: cell-1")
  # ...and at mutation, naming the offending cell.
  nb <- alder:::parse_notebook_lines("x.R", c("# %%", "x <- 1"))
  expect_error(alder:::nb_update_cell(nb, "cell-1", "not a comment", "markdown"),
               "markdown cell lines must be blank or R comments: cell-1")
  expect_error(alder:::nb_add_cell(nb, c("not a comment"), type = "markdown"),
               "markdown cell lines must be blank or R comments")
  # blank and comment lines are fine.
  md <- alder:::parse_notebook_lines("x.R", c("# %% [markdown]", "", "# ok"))
  expect_identical(md$cells[[1]]$body, c("", "# ok"))
})

test_that("notebook header metadata parsed from YAML block", {
  lines <- c("# ---", "# title: hello", "# n_cells: 3", "# flag: false",
             "# ---", "", "# %%", "x <- 1")
  nb <- alder:::parse_notebook_lines("x.R", lines)
  expect_equal(nb$metadata$title, "hello")
  expect_identical(nb$metadata$n_cells, 3L)
  expect_identical(nb$metadata$flag, FALSE)
  # the raw header comment lines are preserved in the round trip
  expect_identical(nb$header[1:4], c("# ---", "# title: hello",
                                     "# n_cells: 3", "# flag: false"))
})

test_that("malformed YAML front matter is rejected, not executed", {
  # duplicate mapping keys are malformed metadata
  expect_error(
    alder:::parse_notebook_lines("x.R", c("# ---", "# title: 1", "# title: 2",
                                          "# ---", "", "# %%", "x <- 1")),
    "malformed YAML metadata")
  # root must be a named mapping
  expect_error(
    alder:::parse_notebook_lines("x.R", c("# ---", "# - a", "# - b",
                                          "# ---", "", "# %%", "x <- 1")),
    "notebook metadata must be a named mapping")
  # a bare scalar is not a mapping
  expect_error(
    alder:::parse_notebook_lines("x.R", c("# ---", "# just some text",
                                          "# ---", "", "# %%", "x <- 1")),
    "must be a named mapping")
  # scanner errors are surfaced as malformed metadata
  expect_error(
    alder:::parse_notebook_lines("x.R", c("# ---", "# p: [unclosed",
                                          "# ---", "", "# %%", "x <- 1")),
    "malformed YAML metadata")
  # tagged expressions are carried through unevaluated (no stop() runs)
  expect_no_error(
    nb <- alder:::parse_notebook_lines("x.R", c("# ---",
                                                "# p: !expr stop(\"boom\")",
                                                "# ---", "", "# %%", "x <- 1")))
  expect_true("p" %in% names(nb$metadata))
  expect_identical(nb$metadata$p, "stop(\"boom\")")
})

test_that("cell body mutation preserves position and serializes correctly", {
  nb <- alder:::parse_notebook_lines("x.R", c("# %%", "a <- 1", "", "# %%", "b <- 2"))
  nb <- alder:::nb_update_cell(nb, "cell-2", c("b <- 20", "b2 <- b + 1"), "code")
  out <- alder:::serialize_notebook(nb)
  expect_match(out, "b <- 20", fixed = TRUE)
  expect_match(out, "b2 <- b + 1", fixed = TRUE)
  expect_match(out, "a <- 1", fixed = TRUE)
})

test_that("type changes swap only the delimiter, retaining its EOL bytes", {
  f <- write_raw_file("# %%\r\nx <- 1\r\n")
  nb <- alder:::read_notebook(f)
  nb <- alder:::nb_update_cell(nb, "cell-1", "# note", "markdown")
  expect_identical(alder:::serialize_notebook(nb), "# %% [markdown]\r\n# note\r\n")
  nb2 <- alder:::read_notebook(f)
  nb2 <- alder:::nb_update_cell(nb2, "cell-1", "y <- 2", "code")
  expect_identical(alder:::serialize_notebook(nb2), "# %%\r\ny <- 2\r\n")
  expect_identical(nb2$cells[[1]]$type, "code")
  # an unchanged type preserves the delimiter bytes verbatim
  nb3 <- alder:::parse_notebook_lines("x.R", c("# %%   ", "x <- 1"))
  nb3 <- alder:::nb_update_cell(nb3, "cell-1", "x <- 2", "code")
  expect_identical(nb3$cells[[1]]$delim, "# %%   ")
  expect_identical(alder:::serialize_notebook(nb3), "# %%   \nx <- 2\n")
})

test_that("invalid type and unknown ids are rejected", {
  nb <- alder:::parse_notebook_lines("x.R", c("# %%", "x <- 1"))
  expect_error(alder:::nb_update_cell(nb, "cell-1", "x <- 2", "html"),
               "invalid cell type")
  expect_error(alder:::nb_update_cell(nb, "ghost", "x <- 2", "code"),
               "no such cell: ghost")
  expect_error(alder:::nb_add_cell(nb, "x", type = "python"), "invalid cell type")
  expect_error(alder:::nb_add_cell(nb, "x", after = "ghost"), "no such cell: ghost")
  expect_error(alder:::nb_delete_cell(nb, "ghost"), "no such cell: ghost")
})

test_that("empty notebook parses and reserializes", {
  nb <- alder:::parse_notebook_lines(NULL, character())
  expect_equal(length(nb$cells), 0L)
  expect_identical(alder:::serialize_notebook(nb), "")
})

test_that("save -> reopen -> serialize is byte-stable (no growth on rewrite)", {
  lines <- c("# %%", "x <- 1", "", "# %%", "y <- x + 1", "")
  f <- tempfile(fileext = ".R")
  nb <- alder:::read_notebook(f <- {writeLines(lines, f); f})
  alder:::write_notebook(nb, f)
  b1 <- readBin(f, "raw", n = file.info(f)$size)

  for (i in 1:3) {  # re-save repeatedly must not grow the file
    nb2 <- alder:::read_notebook(f)
    alder:::write_notebook(nb2, f)
  }
  b2 <- readBin(f, "raw", n = file.info(f)$size)
  expect_identical(b1, b2)
})

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

test_that("raw-read boundaries are hardened with path-bearing errors", {
  # invalid UTF-8 fails with the file path before any change
  f <- tempfile(fileext = ".R")
  writeBin(as.raw(c(0x23, 0x20, 0x25, 0x25, 0x0a, 0xff, 0xfe, 0x21)), f)
  expect_error(alder:::read_notebook(f), "notebook is not valid UTF-8: ")
  expect_equal(file.info(f)$size, 8)  # untouched

  # embedded NUL is rejected at the raw-read boundary
  fn <- tempfile(fileext = ".R")
  writeBin(as.raw(c(0x23, 0x20, 0x25, 0x25, 0x0a, 0x78, 0x20, 0x3c, 0x2d,
                    0x20, 0x41, 0x00, 0x62, 0x63)), fn)
  expect_error(alder:::read_notebook(fn), "embedded NUL")

  # a directory and a missing file are deterministic errors
  expect_error(alder:::read_notebook(tempdir()), "is a directory")
  expect_error(alder:::read_notebook(file.path(tempdir(), "nope.R")), "not found")

  # an unreadable file is rejected (skipped for users who can read mode-000)
  fu <- tempfile(fileext = ".R")
  writeLines("# %%\nx <- 1\n", fu)
  Sys.chmod(fu, "000")
  on.exit(Sys.chmod(fu, "644"), add = TRUE)
  if (file.access(fu, 4) == 0L) skip("user can read mode-000 files (root?)")
  expect_error(alder:::read_notebook(fu), "not readable")
})

test_that("non-ASCII notebook paths parse and serialize", {
  f <- file.path(tempdir(), "caf\u00e9-notebook.R")
  writeBin(charToRaw("# %%\nx <- 1\n"), f)
  on.exit(unlink(f), add = TRUE)
  nb <- alder:::read_notebook(f)
  expect_equal(length(nb$cells), 1L)
  expect_identical(alder:::serialize_notebook(nb), "# %%\nx <- 1\n")
})

test_that("body growth transfers terminal EOL on no-final-newline file", {
  # "# %%\na" — the delimiter has no EOL either, so preferred falls back to LF.
  f <- write_raw_file("# %%\na")
  nb <- alder:::read_notebook(f)
  expect_false(nb$final_newline)
  nb <- alder:::nb_update_cell(nb, "cell-1", c("b", "c"), "code")
  expect_identical(alder:::serialize_notebook(nb), "# %%\nb\nc")
  # second edit keeps the invariant: exactly one terminal record without EOL
  nb <- alder:::nb_update_cell(nb, "cell-1", "d", "code")
  expect_identical(alder:::serialize_notebook(nb), "# %%\nd")
})

test_that("EOF body growth/shrink on final-newline file", {
  f <- write_raw_file("# %%\na\n")
  nb <- alder:::read_notebook(f)
  nb <- alder:::nb_update_cell(nb, "cell-1", c("a", "b"), "code")
  expect_identical(alder:::serialize_notebook(nb), "# %%\na\nb\n")
  nb <- alder:::nb_update_cell(nb, "cell-1", "z", "code")
  expect_identical(alder:::serialize_notebook(nb), "# %%\nz\n")
})

test_that("zero-body insertion lands after options and preserves them", {
  f <- write_raw_file("# %%\n#| key: 1\nx <- 1\n")
  nb <- alder:::read_notebook(f)
  nb <- alder:::nb_update_cell(nb, "cell-1", "y <- 2", "code")
  expect_identical(alder:::serialize_notebook(nb), "# %%\n#| key: 1\ny <- 2\n")
  # zero-body insertion into an option-only cell at EOF without final newline
  f2 <- write_raw_file("# %%\n#| key: 1")
  nb2 <- alder:::read_notebook(f2)
  nb2 <- alder:::nb_update_cell(nb2, "cell-1", "y <- 2", "code")
  expect_identical(alder:::serialize_notebook(nb2), "# %%\n#| key: 1\ny <- 2")
  # shrink the body back to nothing
  nb2 <- alder:::nb_update_cell(nb2, "cell-1", character(), "code")
  expect_identical(alder:::serialize_notebook(nb2), "# %%\n#| key: 1")
})

test_that("duplicate and oddly-spaced options survive edits byte-for-byte", {
  f <- write_raw_file("# %%\n#| key:  1\n#| other : two\n#| key: 3\nx <- 1\n")
  nb <- alder:::read_notebook(f)
  c1 <- alder:::nb_cell(nb, "cell-1")
  expect_equal(c1$options$key, "3")
  expect_equal(c1$options$other, "two")
  expect_identical(c1$option_duplicates$key, c(2L, 4L))  # 1-based record positions
  nb <- alder:::nb_update_cell(nb, "cell-1", "y <- 2", "code")
  expect_identical(alder:::serialize_notebook(nb),
                   "# %%\n#| key:  1\n#| other : two\n#| key: 3\ny <- 2\n")
  nb2 <- alder:::read_notebook(f)
  nb2 <- alder:::nb_update_cell(nb2, "cell-1", c("y <- 2", "z <- 3"), "code")
  expect_identical(alder:::serialize_notebook(nb2),
                   "# %%\n#| key:  1\n#| other : two\n#| key: 3\ny <- 2\nz <- 3\n")
  # every occurrence position is reported for a triply-defined option
  f3 <- write_raw_file("# %%\n#| tag: 1\n#| tag: 2\n#| tag: 3\nx <- 1\n")
  c3 <- alder:::nb_cell(alder:::read_notebook(f3), "cell-1")
  expect_identical(c3$option_duplicates$tag, c(2L, 3L, 4L))
  expect_equal(c3$options$tag, "3")
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

test_that("editing a nonterminal cell never rewrites the terminal EOL bytes", {
  # preferred_eol is LF but the file ends with CRLF: the untouched terminal
  # record must keep its \r\n even though a sibling cell was edited.
  text <- "# %%\nx <- 1\n# %%\ry <- x\r\n"
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  expect_identical(nb$preferred_eol, "\n")
  expect_true(nb$final_newline)
  nb <- alder:::nb_update_cell(nb, "cell-1", "x <- 2", "code")
  expect_identical(alder:::serialize_notebook(nb),
                   "# %%\nx <- 2\n# %%\ry <- x\r\n")
})

test_that("body round-trips through /api/state exactly, blanks included", {
  # start with a visible trailing blank between the cells
  text <- "# %%\npeng <- iris\nnrow(peng)\n\n# %%\nb <- 2\n"
  f <- write_raw_file(text)
  nb <- alder:::read_notebook(f)
  expect_identical(nb$cells[[1]]$body, c("peng <- iris", "nrow(peng)", ""))
  # sending c("x") for the body drops the trailing blank
  nb1 <- alder:::nb_update_cell(nb, "cell-1", c("peng <- iris", "nrow(peng)"), "code")
  expect_identical(alder:::serialize_notebook(nb1),
                   "# %%\npeng <- iris\nnrow(peng)\n# %%\nb <- 2\n")
  # sending c("x", "") retains it
  nb2 <- alder:::read_notebook(f)
  nb2 <- alder:::nb_update_cell(nb2, "cell-1",
                                c("peng <- iris", "nrow(peng)", ""), "code")
  expect_identical(alder:::serialize_notebook(nb2),
                   "# %%\npeng <- iris\nnrow(peng)\n\n# %%\nb <- 2\n")
  # a body that IS the blank line remains a blank-line body slot
  nb3 <- alder:::nb_update_cell(nb2, "cell-1", "", "code")
  expect_identical(alder:::serialize_notebook(nb3), "# %%\n\n# %%\nb <- 2\n")
})
