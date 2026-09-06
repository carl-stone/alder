if (!exists("alder_cache_lib", mode = "function")) {
  sys.source(testthat::test_path("helper-session.R"), envir = environment())
}

publish_render <- function(...) {
  library <- alder_cache_lib()
  existing <- Sys.getenv("R_LIBS", "")
  withr::local_envvar(c(R_LIBS = paste(c(library, existing[nzchar(existing)]),
                                      collapse = .Platform$path.sep)))
  alder::alder_render(...)
}

publish_notebook <- function(path, proof) {
  writeLines(c(
    "# ---", "# title: Engine proof", "# ---",
    "# %% [markdown]", "# # Publishing",
    "# %%", paste0("cat('", proof, "\\n')"), "x <- 40 + 2", "x"
  ), path, useBytes = TRUE)
  path
}

test_that("direct Pandoc render contains Alder outputs and engine provenance", {
  td <- tempfile("alder-pandoc-render-")
  dir.create(td)
  path <- publish_notebook(file.path(td, "report.R"), "pandoc-proof")
  before <- readBin(path, "raw", n = file.info(path)$size)
  out <- file.path(td, "report-pandoc.html")
  messages <- capture.output(
    result <- publish_render(path, "pandoc", out = out),
    type = "message"
  )
  expect_true(file.exists(out))
  expect_identical(readBin(path, "raw", n = file.info(path)$size), before)
  html <- paste(readLines(out, warn = FALSE), collapse = "\n")
  expect_match(html, "alder-render-engine.+pandoc")
  expect_match(html, "pandoc-proof")
  expect_match(html, "\\[1\\] 42")
  document <- xml2::read_html(out)
  heading <- xml2::xml_find_all(
    document, ".//h1[normalize-space(.)='Publishing']"
  )
  expect_length(heading, 1L)
  expect_length(xml2::xml_find_all(
    document, ".//h1[starts-with(normalize-space(.), '#')]"
  ), 0L)
  expect_identical(attr(result, "engine"), "pandoc")
  expect_type(messages, "character")

  # A second render replaces the prior artifact only after another successful
  # execution; users can publish repeatedly to one stable path.
  writeLines(c(
    "# ---", "# title: Engine proof", "# ---",
    "# %%", "cat('replacement-proof\\n')", "84"
  ), path, useBytes = TRUE)
  capture.output(publish_render(path, "pandoc", out = out),
                 type = "message")
  replaced <- paste(readLines(out, warn = FALSE), collapse = "\n")
  expect_match(replaced, "replacement-proof")
  expect_match(replaced, "\\[1\\] 84")
  expect_false(grepl("pandoc-proof", replaced, fixed = TRUE))
})

test_that("direct Pandoc render preserves layered and multi-page base graphics", {
  td <- tempfile("alder-pandoc-base-graphics-")
  dir.create(td)
  path <- file.path(td, "base-graphics.R")
  writeLines(c(
    "# ---", "# title: Base graphics", "# ---",
    "# %%", "plot(1:6, type = 'b', main = 'layered')",
    "abline(h = 3.5, col = 'red', lty = 2)",
    "lines(1:6, 6:1, col = 'navy')", "title(sub = 'layered page')",
    "legend('topleft', legend = 'threshold', col = 'red', lty = 2)",
    "# %%", "plot(1:3, main = 'page one')",
    "plot(3:1, main = 'page two')"
  ), path, useBytes = TRUE)
  out <- file.path(td, "base-graphics.html")

  capture.output(publish_render(path, "pandoc", out = out),
                 type = "message")
  html <- paste(readLines(out, warn = FALSE), collapse = "\n")
  images <- gregexpr("<img\\b", html, perl = TRUE)[[1L]]
  image_count <- if (identical(images[[1L]], -1L)) 0L else length(images)
  expect_identical(image_count, 3L)
  expect_match(html, "alder-render-engine.+pandoc")
})

test_that("Quarto render explicitly executes R with knitr", {
  td <- tempfile("alder-quarto-render-")
  dir.create(td)
  path <- publish_notebook(file.path(td, "report.R"), "quarto-knitr-proof")
  before <- readBin(path, "raw", n = file.info(path)$size)
  out <- file.path(td, "report-quarto.html")
  messages <- capture.output(
    result <- publish_render(path, "quarto", out = out),
    type = "message"
  )
  expect_true(file.exists(out))
  expect_identical(readBin(path, "raw", n = file.info(path)$size), before)
  html <- paste(readLines(out, warn = FALSE), collapse = "\n")
  expect_match(html, "alder-render-engine.+quarto")
  expect_match(html, "quarto-knitr-proof")
  expect_match(html, "\\[1\\] 42")
  expect_identical(attr(result, "engine"), "quarto")
  expect_true(any(grepl("report", messages, ignore.case = TRUE)) ||
                nzchar(attr(result, "stdout")) || nzchar(attr(result, "stderr")))
})

test_that("Quarto renders semantic tables and accessible plot alternatives", {
  td <- tempfile("alder-quarto-scientific-")
  dir.create(td)
  path <- file.path(td, "scientific.R")
  writeLines(c(
    "# ---", "# title: Scientific output", "# ---",
    "# %%", "observations <- data.frame(",
    "  sample = c('S01', 'S02'),", "  signal = c(1.25, 2.75)", ")",
    "# %%", "#| name: scientific-table", "observations",
    "# %%", "#| name: signal-plot",
    "plot(observations$signal, type = 'b')"
  ), path, useBytes = TRUE)

  out <- file.path(td, "scientific.html")
  capture.output(publish_render(path, "quarto", out = out),
                 type = "message")
  document <- xml2::read_html(out)
  table <- xml2::xml_find_all(document, ".//table")
  expect_gte(length(table), 1L)
  headers <- trimws(xml2::xml_text(xml2::xml_find_all(table, ".//th")))
  expect_true(all(c("sample", "signal") %in% headers))
  image <- xml2::xml_find_all(document, ".//img")
  expect_gte(length(image), 1L)
  expect_true(all(nzchar(trimws(xml2::xml_attr(image, "alt")))))
  expect_true(any(grepl("signal-plot", xml2::xml_attr(image, "alt"),
                        fixed = TRUE)))
})

test_that("both publishing engines execute dependency order once and preserve display order", {
  td <- tempfile("alder-render-reactive-order-")
  dir.create(td)
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  marker <- file.path(td, "execution-order")
  literal <- function(value) encodeString(value, quote = '"')
  path <- file.path(td, "reordered.R")
  writeLines(c(
    "# %% [markdown]", "# ## Result first",
    "# %%", "#| name: result-first", "answer <- state + 2L",
    paste0("cat('dependent\\n', file = ", literal(marker), ", append = TRUE)"),
    "cat('REPORT_ANSWER=', answer, '\\n', sep = '')",
    "# %% [markdown]", "# ## Input last",
    "# %%", "#| name: input-last", "state <- 40L",
    paste0("cat('input\\n', file = ", literal(marker), ", append = TRUE)"),
    "cat('REPORT_BASE=', state, '\\n', sep = '')"
  ), path, useBytes = TRUE)
  original <- readBin(path, "raw", n = file.info(path)$size)

  for (engine in c("pandoc", "quarto")) {
    unlink(marker)
    output <- file.path(td, paste0(engine, ".html"))
    capture.output(publish_render(path, engine, out = output,
                                       include_code = FALSE), type = "message")
    expect_identical(readLines(marker), c("input", "dependent"))
    document <- xml2::read_html(output)
    text <- xml2::xml_text(document)
    expect_match(text, "REPORT_ANSWER=42", fixed = TRUE)
    expect_match(text, "REPORT_BASE=40", fixed = TRUE)
    expect_lt(regexpr("REPORT_ANSWER=42", text, fixed = TRUE)[[1L]],
              regexpr("REPORT_BASE=40", text, fixed = TRUE)[[1L]])
    expect_identical(xml2::xml_text(xml2::xml_find_all(document, ".//h2")),
                     c("Result first", "Input last"))
    expect_identical(readBin(path, "raw", n = file.info(path)$size), original)
  }
})

test_that("both publishing engines exclude disabled descendants and preserve source display", {
  td <- tempfile("alder-render-disabled-descendants-")
  dir.create(td)
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  marker <- file.path(td, "disabled-ran")
  path <- file.path(td, "disabled.R")
  writeLines(c(
    "# %%", "#| name: disabled-input", "#| disabled: true",
    "disabled_value <- 40L",
    "# %%", "#| name: disabled-dependent",
    "dependent_value <- disabled_value + 2L",
    paste0("writeLines('must not run', ", encodeString(marker, quote = '"'), ")"),
    "# %%", "#| name: disabled-transitive", "transitive_value <- dependent_value + 1L",
    "# %%", "#| name: independent-result", "cat('INDEPENDENT_RESULT=7\\n')"
  ), path, useBytes = TRUE)
  for (engine in c("pandoc", "quarto")) {
    output <- file.path(td, paste0(engine, ".html"))
    capture.output(publish_render(path, engine, out = output,
                                       include_code = TRUE), type = "message")
    text <- xml2::xml_text(xml2::read_html(output))
    expect_match(text, "INDEPENDENT_RESULT=7", fixed = TRUE)
    expect_match(text, "disabled_value <- 40L", fixed = TRUE)
    expect_match(text, "dependent_value <- disabled_value + 2L", fixed = TRUE)
    expect_match(text, "transitive_value <- dependent_value + 1L", fixed = TRUE)
    expect_false(file.exists(marker))
  }
})

test_that("Quarto failure after dependency execution preserves the destination and conditions", {
  td <- tempfile("alder-quarto-reordered-failure-")
  dir.create(td)
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  path <- file.path(td, "failure.R")
  marker <- file.path(td, "executions")
  literal <- function(value) encodeString(value, quote = '"')
  writeLines(c(
    "# %%", "#| name: failing-result", "answer <- input + 2L",
    paste0("cat('result\\n', file = ", literal(marker), ", append = TRUE)"),
    "message('reordered message retained')",
    "warning('reordered warning retained')",
    "stop('reordered failure retained')",
    "# %%", "#| name: prerequisite", "input <- 40L",
    paste0("cat('input\\n', file = ", literal(marker), ", append = TRUE)")
  ), path, useBytes = TRUE)
  output <- file.path(td, "existing.html")
  writeLines("valuable previous result", output)
  before <- readBin(output, "raw", n = file.info(output)$size)
  error <- tryCatch(publish_render(path, "quarto", out = output),
                    error = identity)
  expect_s3_class(error, "alder_error")
  expect_match(conditionMessage(error), "reordered message retained", fixed = TRUE)
  expect_match(conditionMessage(error), "reordered warning retained", fixed = TRUE)
  expect_match(conditionMessage(error), "reordered failure retained", fixed = TRUE)
  expect_match(conditionMessage(error), "failing-result", fixed = TRUE)
  expect_identical(readLines(marker), c("input", "result"))
  expect_identical(readBin(output, "raw", n = file.info(output)$size), before)
})

test_that("both engines preserve native Markdown and composed scientific output", {
  td <- tempfile("alder-native-publishing-")
  dir.create(td)
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  path <- file.path(td, "native.R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "out$md('# Native heading')",
    "# %%", "out$callout(out$md('**Scientific callout**'), variant = 'success')",
    "# %%", "fit <- lm(mpg ~ wt, data = mtcars)",
    "chart <- ggplot2::ggplot(mtcars, ggplot2::aes(wt, mpg)) + ggplot2::geom_point()",
    "control <- ui$slider(1, 10, value = 3, label = 'Analysis threshold')",
    "# %%", "out$tabs(Plot = chart, Model = summary(fit), Control = control)",
    "# %%", "out$append(out$md('**Appended result**'))",
    "cat('AFTER_APPENDED_RESULT\\n')",
    "# %%", "progress_handle <- out$progress(2, label = 'Final progress')",
    "progress_handle$update(1)", "progress_handle$update(2)", "progress_handle$close()",
    "# %%", "out$lazy(function() stop('lazy must stay deferred'), label = 'Deferred notebook result')"
  ), path, useBytes = TRUE)
  original <- readBin(path, "raw", n = file.info(path)$size)
  for (engine in c("pandoc", "quarto")) {
    output <- file.path(td, paste0(engine, ".html"))
    capture.output(publish_render(path, engine, out = output,
                                       include_code = FALSE), type = "message")
    document <- xml2::read_html(output)
    expect_length(xml2::xml_find_all(document,
      ".//h1[normalize-space(.)='Native heading']"), 1L)
    expect_length(xml2::xml_find_all(document,
      ".//*[contains(@class, 'out-callout')]//strong[.='Scientific callout']"), 1L)
    tabs <- xml2::xml_find_first(document, ".//*[contains(@class, 'out-tabs')]")
    expect_false(inherits(tabs, "xml_missing"))
    # External HTML writers may put the heading text on its own line.
    expect_identical(trimws(xml2::xml_text(xml2::xml_find_all(tabs, ".//h3"))),
                     c("Plot", "Model", "Control"))
    expect_length(xml2::xml_find_all(tabs, ".//img"), 1L)
    expect_match(xml2::xml_text(tabs), "Coefficients", fixed = TRUE)
    expect_length(xml2::xml_find_all(tabs, ".//input[@value='3' and @disabled]"), 1L)
    expect_match(xml2::xml_text(tabs), "Analysis threshold", fixed = TRUE)
    expect_length(xml2::xml_find_all(document, ".//strong[.='Appended result']"), 1L)
    expect_match(xml2::xml_text(document), "AFTER_APPENDED_RESULT", fixed = TRUE)
    expect_lt(regexpr("Appended result", xml2::xml_text(document), fixed = TRUE)[[1L]],
              regexpr("AFTER_APPENDED_RESULT", xml2::xml_text(document), fixed = TRUE)[[1L]])
    expect_length(xml2::xml_find_all(document, ".//progress[@value='2' and @max='2']"), 1L)
    expect_length(xml2::xml_find_all(document, ".//progress"), 1L)
    expect_match(xml2::xml_text(document), "Deferred notebook result", fixed = TRUE)
    expect_false(grepl("ALDER_KNIT_", xml2::xml_text(document), fixed = TRUE))
    expect_false(grepl("$kind", xml2::xml_text(document), fixed = TRUE))
    expect_identical(readBin(path, "raw", n = file.info(path)$size), original)
  }
})

test_that("published transcripts preserve partial Unicode lines and append chronology", {
  td <- tempfile("alder-publish-transcript-")
  dir.create(td)
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  path <- file.path(td, "transcript.R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "print.alder_publish_order <- function(x, ...) {",
    "message('RENDER_CONDITION')", "cat('PRINTED_NATIVE')", "invisible(x)", "}",
    "# %%", "cat('BEFORE_é中')", "out$append(out$md('**APPEND_ONE**'))",
    "cat('AFTER_ß文\\n')", "message('ORDINARY_MESSAGE')",
    "warning('ORDINARY_WARNING', call. = FALSE)",
    "out$append(structure(1, class = 'alder_publish_order'))",
    "cat('AFTER_NATIVE\\n')", "'FINAL_VALUE'"
  ), path, useBytes = TRUE)
  for (engine in c("pandoc", "quarto")) {
    output <- file.path(td, paste0(engine, ".html"))
    capture.output(publish_render(path, engine, out = output,
                                  include_code = FALSE), type = "message")
    document <- xml2::read_html(output)
    body <- xml2::xml_text(xml2::xml_find_first(document, ".//body"))
    markers <- c("BEFORE_é中", "APPEND_ONE", "AFTER_ß文", "ORDINARY_MESSAGE",
                 "ORDINARY_WARNING", "RENDER_CONDITION", "PRINTED_NATIVE",
                 "AFTER_NATIVE", "FINAL_VALUE")
    positions <- vapply(markers, function(marker) {
      hits <- gregexpr(marker, body, fixed = TRUE)[[1L]]
      expect_identical(length(hits), 1L, info = paste(engine, marker))
      hits[[1L]]
    }, 1L)
    expect_true(all(positions > 0L), info = paste(engine, body))
    expect_true(all(diff(positions) > 0L), info = paste(engine, body))
  }
})

test_that("transcript offsets preserve truncated logs and older output snapshots", {
  transcript <- getFromNamespace("export_cell_transcript", "alder")
  result <- transcript(list(
    log = c("é中after", "[output truncated at 10 bytes]"),
    outputs = list(list(kind = "markdown", text = "append", log_offset = 2),
                   list(kind = "text", text = "last", log_offset = 1000000))))
  expect_identical(vapply(result, `[[`, "", "text"),
                   c("é中", "append", "after\n[output truncated at 10 bytes]", "last"))
  legacy <- transcript(list(log = "legacy log", outputs = list(
    list(kind = "text", text = "legacy value"))))
  expect_identical(vapply(legacy, `[[`, "", "text"), c("legacy log", "legacy value"))
})

test_that("render tools and execution failures are actionable", {
  td <- tempfile("alder-render-errors-")
  dir.create(td)
  bad <- file.path(td, "bad.R")
  writeLines(c("# %%", "stop('publish failure')"), bad)
  rendered_error <- NULL
  transcript <- capture.output(
    rendered_error <- tryCatch(
      publish_render(bad, "pandoc", out = file.path(td, "bad.html")),
      error = identity
    ),
    type = "message"
  )
  expect_s3_class(rendered_error, "alder_error")
  expect_match(conditionMessage(rendered_error), "publish failure")
  expect_type(transcript, "character")

  good <- publish_notebook(file.path(td, "good.R"), "ok")
  old <- options(alder.pandoc_path = file.path(td, "missing-pandoc"))
  on.exit(options(old), add = TRUE)
  error <- tryCatch(
    publish_render(good, "pandoc", out = file.path(td, "missing.html")),
    error = identity
  )
  expect_s3_class(error, "alder_error")
  expect_identical(error$code, "render_tool_unavailable")
  expect_match(conditionMessage(error), "pandoc executable is unavailable")
})

test_that("publishing rejects blocking analysis diagnostics before effects or replacement", {
  td <- tempfile("alder-publish-diagnostics-")
  dir.create(td)
  marker <- file.path(td, "must-not-run")
  literal <- function(value) paste(utils::capture.output(dput(value)), collapse = "")
  cases <- list(
    syntax = c("# %%", "if (", "# %%",
               paste0("writeLines('ran', ", literal(marker), ")")),
    duplicate = c(
      "# %%", "duplicated <- 1L", paste0("writeLines('ran', ", literal(marker), ")"),
      "# %%", "duplicated <- 2L"
    ),
    cycle = c(
      "# %%", "cycle_a <- cycle_b + 1L", paste0("writeLines('ran', ", literal(marker), ")"),
      "# %%", "cycle_b <- cycle_a + 1L"
    ),
    dynamic = c(
      "# %%", "target <- 'dynamic_name'", paste0(
        "assign(target, writeLines('ran', ", literal(marker), "))"
      )
    )
  )
  for (name in names(cases)) {
    source <- file.path(td, paste0(name, ".R"))
    writeLines(cases[[name]], source, useBytes = TRUE)
    for (engine in c("pandoc", "quarto")) {
      destination <- file.path(td, paste0(name, "-", engine, ".html"))
      sentinel <- charToRaw(paste0("preserve ", name, " ", engine, "\n"))
      writeBin(sentinel, destination)
      err <- tryCatch(
        capture.output(publish_render(source, engine, out = destination),
                       type = "message"),
        error = identity
      )
      expect_true(inherits(err, "alder_error"), info = paste(name, engine))
      expect_identical(err$code, "render_failed")
      expect_match(conditionMessage(err), switch(
        name,
        syntax = "unexpected end of input",
        duplicate = "duplicate definition of duplicated",
        cycle = "dependency cycle",
        dynamic = "assign() requires"
      ), fixed = TRUE)
      expect_identical(readBin(destination, "raw", n = file.info(destination)$size),
                       sentinel)
      expect_false(file.exists(marker))
      expect_length(list.files(
        td, pattern = "^\\.alder-(quarto|pandoc)-", all.files = TRUE
      ), 0L)
    }
  }
})

test_that("blocking analysis rejects before an external renderer is invoked", {
  td <- tempfile("alder-publish-preflight-tool-")
  dir.create(td)
  marker <- file.path(td, "renderer-invoked")
  tool <- file.path(td, if (.Platform$OS.type == "windows") "renderer.cmd" else "renderer")
  if (.Platform$OS.type == "windows") {
    writeLines(c(
      "@echo off",
      paste0(">\"", marker, "\" echo invoked"),
      "exit /b 0"
    ), tool, useBytes = TRUE)
  } else {
    writeLines(c(
      "#!/bin/sh",
      paste0("printf '%s\\n' invoked > ", shQuote(marker)),
      "exit 0"
    ), tool, useBytes = TRUE)
    Sys.chmod(tool, mode = "0755")
  }
  old <- options(alder.pandoc_path = tool, alder.quarto_path = tool)
  on.exit(options(old), add = TRUE)

  source <- file.path(td, "invalid.R")
  writeLines(c("# %%", "if ("), source, useBytes = TRUE)
  for (engine in c("pandoc", "quarto")) {
    error <- tryCatch(
      publish_render(source, engine, out = file.path(td, paste0(engine, ".html"))),
      error = identity
    )
    expect_s3_class(error, "alder_error")
    expect_identical(error$code, "render_failed")
    expect_match(conditionMessage(error), "unexpected end of input", fixed = TRUE)
    expect_false(file.exists(marker), info = engine)
  }
})

test_that("both render engines reject direct, normalized, symlink, and hard-link aliases", {
  td <- tempfile("alder-render-aliases-")
  dir.create(td)
  marker <- file.path(td, "must-not-run")
  source <- file.path(td, "alias-source.R")
  literal <- paste(utils::capture.output(dput(marker)), collapse = "")
  writeLines(c("# %%", paste0("writeLines('ran', ", literal, ")"), "42"),
             source, useBytes = TRUE)
  source_bytes <- readBin(source, "raw", n = file.info(source)$size)

  aliases <- list(
    direct = source,
    normalized = file.path(td, ".", basename(source))
  )
  symlink <- file.path(td, "alias-symlink.R")
  if (isTRUE(file.symlink(source, symlink))) aliases$symlink <- symlink
  hardlink <- file.path(td, "alias-hardlink.R")
  if (isTRUE(file.link(source, hardlink))) aliases$hardlink <- hardlink

  for (engine in c("pandoc", "quarto")) {
    for (alias_name in names(aliases)) {
      alias <- aliases[[alias_name]]
      before_alias <- readBin(alias, "raw", n = file.info(alias)$size)
      err <- tryCatch(
        capture.output(publish_render(source, engine, out = alias),
                       type = "message"),
        error = identity
      )
      expect_true(inherits(err, "alder_error"), info = paste(engine, alias_name))
      expect_identical(err$code, "render_failed")
      expect_match(conditionMessage(err), "must not overwrite the notebook",
                   fixed = TRUE)
      expect_identical(readBin(source, "raw", n = file.info(source)$size),
                       source_bytes)
      expect_identical(readBin(alias, "raw", n = file.info(alias)$size),
                       before_alias)
      expect_false(file.exists(marker))
    }
  }
})

test_that("fatal Quarto renders relay prior conditions and preserve output", {
  td <- tempfile("alder-quarto-failure-")
  dir.create(td)
  path <- file.path(td, "failure.R")
  writeLines(c(
    "# ---", "# title: Intentional failure", "# ---",
    "# %%", "#| name: intentional-failure",
    "message('UF22 FAILURE MESSAGE: visible before stop')",
    "warning('UF22 FAILURE WARNING: visible before stop', call. = FALSE)",
    "stop('UF22 INTENTIONAL FATAL ERROR')",
    "# %%", "cat('UF22 UNREACHABLE OUTPUT\\n')"
  ), path, useBytes = TRUE)
  out <- file.path(td, "failure.html")
  sentinel <- charToRaw("existing report must survive\n")
  writeBin(sentinel, out)

  rendered_error <- NULL
  transcript <- capture.output(
    rendered_error <- tryCatch(
      publish_render(path, "quarto", out = out),
      error = identity
    ),
    type = "message"
  )
  expect_s3_class(rendered_error, "alder_error")
  expect_identical(rendered_error$code, "render_failed")
  expect_match(conditionMessage(rendered_error), "quarto exited with status 1",
               fixed = TRUE)

  observed <- paste(c(transcript, conditionMessage(rendered_error)),
                    collapse = "\n")
  conditions <- c(
    "UF22 FAILURE MESSAGE: visible before stop",
    "Warning: UF22 FAILURE WARNING: visible before stop",
    "UF22 INTENTIONAL FATAL ERROR"
  )
  positions <- vapply(conditions, function(condition) {
    regexpr(condition, observed, fixed = TRUE)[[1L]]
  }, integer(1))
  occurrences <- vapply(conditions, function(condition) {
    hits <- gregexpr(condition, observed, fixed = TRUE)[[1L]]
    if (identical(hits[[1L]], -1L)) 0L else length(hits)
  }, integer(1))
  expect_false(grepl("\033", observed, fixed = TRUE))
  expect_true(all(positions > 0L))
  expect_true(all(diff(positions) > 0L))
  expect_identical(
    unname(occurrences), rep(1L, length(conditions)), info = observed
  )
  expect_false(grepl("UF22 UNREACHABLE OUTPUT", observed, fixed = TRUE))
  expect_identical(readBin(out, "raw", n = file.info(out)$size), sentinel)
})

test_that("redundant simple condition blocks do not hide unique diagnostics", {
  collapse_blocks <- getFromNamespace(
    "alder_render_dedupe_condition_blocks", "alder"
  )
  boundary <- paste(rep("~", 80L), collapse = "")
  duplicate <- paste(c(
    "visible message", "Warning: visible warning", "Error:", "! fatal detail",
    "", boundary, "<error/rlang_error>", "Error:", "! fatal detail",
    boundary, "", "Execution halted"
  ), collapse = "\n")
  collapsed <- collapse_blocks(duplicate)
  testthat::expect_identical(
    lengths(regmatches(collapsed, gregexpr("! fatal detail", collapsed,
                                           fixed = TRUE))),
    1L
  )
  testthat::expect_match(collapsed, "visible message", fixed = TRUE)
  testthat::expect_match(collapsed, "Warning: visible warning", fixed = TRUE)
  testthat::expect_match(collapsed, "Execution halted", fixed = TRUE)

  unique_block <- sub(
    paste0("! fatal detail\n", boundary),
    paste0("! different fatal detail\n", boundary),
    duplicate, fixed = TRUE
  )
  testthat::expect_match(
    collapse_blocks(unique_block), "! different fatal detail", fixed = TRUE
  )
  ordinary_repetition <- "same user message\nsame user message"
  testthat::expect_identical(
    collapse_blocks(ordinary_repetition), ordinary_repetition
  )
})

test_that("both external engines publish visible messages and warnings", {
  td <- tempfile("alder-render-conditions-")
  dir.create(td)
  path <- file.path(td, "conditions.R")
  writeLines(c(
    "# ---", "# title: Conditions", "# ---",
    "# %%", "message('published message')",
    "warning('published warning')", "42"
  ), path, useBytes = TRUE)

  for (engine in c("pandoc", "quarto")) {
    out <- file.path(td, paste0("conditions-", engine, ".html"))
    transcript <- capture.output(
      publish_render(path, engine, out = out), type = "message"
    )
    html <- paste(readLines(out, warn = FALSE), collapse = "\n")
    expect_match(html, "published message", fixed = TRUE,
                 info = paste(engine, "message"))
    expect_match(html, "published warning", fixed = TRUE,
                 info = paste(engine, "warning"))
    expect_match(html, "\\[1\\] 42", info = paste(engine, "result"))
    expect_type(transcript, "character")
  }
})

test_that("direct Pandoc publishing preserves Alder dependency order", {
  td <- tempfile("alder-pandoc-dag-")
  dir.create(td)
  path <- file.path(td, "dag.R")
  # The consumer deliberately appears first. Alder executes the later
  # definition first, then serializes outputs back in notebook order.
  writeLines(c(
    "# %%", "answer <- input + 1", "answer",
    "# %%", "input <- 41"
  ), path, useBytes = TRUE)
  out <- file.path(td, "dag.html")
  capture.output(publish_render(path, "pandoc", out = out),
                 type = "message")
  html <- paste(readLines(out, warn = FALSE), collapse = "\n")
  expect_match(html, "\\[1\\] 42")
})
