test_that("document exports preserve console conditions and session logs", {
  root <- tempfile("alder-export-conditions-")
  dir.create(root)
  withr::defer(unlink(root, recursive = TRUE))
  path <- file.path(root, "conditions.R")
  writeLines(c("# %%", "message('export-message')",
               "warning('export-warning')", "cat('\\u524d-before ')",
               "alder::out$append('middle-marker')", "cat('after-marker\\n')",
               "42"), path)
  for (format in c("html", "md", "session", "ipynb")) {
    output <- file.path(root, paste0("result.", format))
    alder::alder_export(path, format, out = output)
    if (identical(format, "session")) {
      snapshot <- jsonlite::fromJSON(output, simplifyVector = FALSE)
      text <- paste(unlist(snapshot$cells[[1L]]$log), collapse = "\n")
    } else if (identical(format, "ipynb")) {
      snapshot <- jsonlite::fromJSON(output, simplifyVector = FALSE)
      text <- paste(vapply(snapshot$cells[[1L]]$outputs,
                           function(x) if (is.null(x$text)) "" else x$text, ""),
                    collapse = "\n")
    } else text <- paste(readLines(output, warn = FALSE), collapse = "\n")
    for (condition in c("export-message", "Warning: export-warning")) {
      hits <- gregexpr(condition, text, fixed = TRUE)[[1L]]
      expect_identical(sum(hits > 0L), 1L, info = paste(format, condition))
    }
    if (format %in% c("html", "md")) {
      markers <- c("\u524d-before", "middle-marker", "after-marker", "[1] 42")
      positions <- vapply(markers, function(marker)
        regexpr(marker, text, fixed = TRUE)[[1L]], integer(1))
      expect_true(all(positions > 0L), info = format)
      expect_true(all(diff(positions) > 0L), info = format)
    }
  }
})

test_that("failed notebook exports preserve destinations and complete diagnostics", {
  root <- tempfile("alder-export-failure-")
  dir.create(root)
  withr::defer(unlink(root, recursive = TRUE))
  path <- file.path(root, "failure.R")
  writeLines(c("# %%", "message('prior-message')", "warning('prior-warning')",
               "stop('export-failure')", "# %%", "42"), path)
  for (format in c("html", "md", "script", "ipynb", "qmd", "session")) {
    output <- file.path(root, paste0("result.", format))
    writeLines("existing-destination", output)
    error <- tryCatch(alder::alder_export(path, format, out = output),
                       error = identity)
    expect_s3_class(error, "alder_error")
    if (!inherits(error, "error")) next
    expect_identical(error$code, "export_failed")
    for (condition in c("prior-message", "Warning: prior-warning", "export-failure")) {
      expect_match(conditionMessage(error), condition, fixed = TRUE)
    }
    expect_identical(error$state$cells[[1L]]$error$message, "export-failure")
    expect_true(length(error$state$cells[[1L]]$error$trace) > 0L)
    expect_identical(readLines(output), "existing-destination")
    expect_false(any(grepl("^\\.alder-export-", list.files(root, all.files = TRUE))))
  }
})
