with_output_host <- function(source, check, options = list()) {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  directory <- tempfile("alder-host-output-")
  dir.create(directory)
  on.exit(unlink(directory, recursive = TRUE), add = TRUE)
  path <- file.path(directory, "notebook.R")
  writeLines(source, path)
  options <- utils::modifyList(list(
    port = 0L, runOnStartup = FALSE, executionMode = "lazy"
  ), options)
  boot <- alder:::alder_host_process(path, options)
  close <- function() {
    if (boot$process$is_alive()) {
      try(alder:::alder_host_request(boot, "/api/shutdown", shutdown = TRUE),
          silent = TRUE)
      boot$process$wait(10000)
    }
    forced <- boot$process$is_alive()
    if (forced) boot$process$kill_tree()
    expect_false(forced, info = "Host must complete authenticated shutdown")
  }
  on.exit(close(), add = TRUE, after = FALSE)
  session <- alder:::alder_host_facade(boot, close)
  check(session, boot)
}

wait_output_host <- function(check, timeout = 10) {
  deadline <- Sys.time() + timeout
  repeat {
    value <- tryCatch(check(), error = function(error) FALSE)
    if (isTRUE(value)) return(invisible(TRUE))
    if (Sys.time() >= deadline) {
      testthat::fail("host output state did not settle before the timeout")
      return(invisible(FALSE))
    }
    Sys.sleep(0.02)
  }
}

output_host_widget_child <- function(output, name) {
  matches <- which(vapply(output$spec$children, function(child) {
    identical(child$name, name)
  }, FALSE))
  output$spec$children[[matches[[1L]]]]
}

output_host_cell <- function(session, id) {
  cells <- session$state()$cells
  cells[[which(vapply(cells, function(cell) identical(cell$id, id), FALSE))]]
}

test_that("installed host preserves scientific layouts, lazy output and table ownership", {
  skip_if_not_installed("ggplot2")
  with_output_host(c(
    "# %%", "library(alder)",
    "# %%", "model <- lm(mpg ~ wt, data = mtcars)",
    "p <- ggplot2::ggplot(mtcars, ggplot2::aes(wt, mpg)) + ggplot2::geom_point()",
    "# %%", "out$tabs(Plot = p, Model = summary(model), Data = data.frame(x = 1:40))",
    "# %%", "out$lazy(function() out$vstack(p, summary(model)))",
    "# %%", "cat('before append\\n')", "out$append(p)",
    "out$append(summary(model))", "cat('after append\\n')", "'tail'",
    "# %%", "draw <- function() plot(1:3)", "draw()"
  ), function(s, boot) {
    run <- s$run_all()
    expect_identical(s$await_operation(run$run_id)$status, "done")
    expect_true(all(vapply(s$state()$cells, function(cell)
      identical(cell$status, "done"), FALSE)))
    layout <- output_host_cell(s, "cell-3")$outputs[[1L]]
    expect_identical(vapply(layout$children, `[[`, "", "kind"),
                     c("image", "text", "table"))
    expect_match(layout$children[[2L]]$text, "Coefficients:", fixed = TRUE)
    image <- layout$children[[1L]]$artifact
    expect_true(file.exists(file.path(boot$ready$artifactDirectory, image)))
    table <- layout$children[[3L]]
    operation <- s$request_table_page(table$handle, offset = 25L, limit = 10L)
    expect_identical(s$await_operation(operation)$status, "done")
    page <- output_host_cell(s, "cell-3")$outputs[[1L]]$children[[3L]]$page
    expect_equal(page$offset, 25)
    expect_identical(page$preview[[1L]][[1L]], "26")

    lazy <- output_host_cell(s, "cell-4")$outputs[[1L]]
    expect_identical(s$await_operation(s$request_lazy(lazy$key))$status, "done")
    loaded <- output_host_cell(s, "cell-4")$outputs[[1L]]
    expect_identical(loaded$state, "loaded")
    expect_identical(vapply(loaded$child$children, `[[`, "", "kind"),
                     c("image", "text"))
    appended <- output_host_cell(s, "cell-5")
    expect_identical(vapply(appended$outputs, `[[`, "", "kind"),
                     c("image", "text", "text"))
    expect_identical(appended$log, c("before append", "after append"))
    expect_match(appended$outputs[[3L]]$text, "tail", fixed = TRUE)
    expect_true(any(vapply(output_host_cell(s, "cell-6")$outputs,
      function(output) identical(output$kind, "image"), FALSE)))

    s$set_cell("cell-3", "42", "code")
    stale <- tryCatch(s$request_table_page(table$handle), alder_error = identity)
    expect_s3_class(stale, "alder_error")
    expect_identical(stale$code, "table_unavailable")
  })
})

test_that("installed host validates nested widget values and rejects obsolete owners", {
  with_output_host(c(
    "# %%", "library(alder)",
    "# %%", "controls <- ui$dictionary(n = ui$slider(1, 9, value = 3, step = 2))", "controls",
    "# %%", "answer <- controls$value$n * 2", "answer"
  ), function(s, boot) {
    expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
    expect_identical(output_host_cell(s, "cell-3")$outputs[[1L]]$text, "[1] 6")
    operation <- s$set_widget("controls", path = "n", update = list(value = 5), source = "editor")
    expect_identical(s$await_operation(operation)$status, "done")
    expect_identical(output_host_cell(s, "cell-3")$status, "stale")
    expect_identical(s$await_operation(s$run_stale()$run_id)$status, "done")
    expect_identical(output_host_cell(s, "cell-3")$outputs[[1L]]$text, "[1] 10")
    invalid <- tryCatch({
      op <- s$set_widget("controls", path = "n", update = list(value = 4))
      s$await_operation(op)
    }, alder_error = identity)
    expect_s3_class(invalid, "alder_error")
    expect_match(conditionMessage(invalid), "lattice")
    s$set_cell("cell-2", "controls <- ui$dictionary(n = ui$slider(1, 9, value = 7, step = 2))", "code")
    stale <- tryCatch(s$set_widget("controls", path = "n", update = list(value = 5)),
                      alder_error = identity)
    expect_s3_class(stale, "alder_error")
    expect_identical(stale$code, "widget_not_current")
    expect_true(s$worker_available())
  })
})

test_that("installed host retains renderer conditions and continues unrelated cells after failure", {
  with_output_host(c(
    "# %%", "library(alder)",
    "# %%", "print.alder_host_note <- function(x, ...) {",
    "  message('renderer-message'); warning('renderer-warning')",
    "  cat('printed result\\n'); invisible(x)", "}",
    "note <- structure('text', class = 'alder_host_note')",
    "# %%", "cat('before layout\\n')", "out$vstack(note)",
    "cat('after layout\\n')", "out$append(note)",
    "cat('after append\\n')", "'tail'",
    "# %%", "note",
    "# %%", "out$lazy(function() note)",
    "# %%", "print.alder_host_bad <- function(x, ...) stop('printer failed')",
    "out$tabs(Bad = structure(1, class = 'alder_host_bad'))",
    "# %%", "42"
  ), function(s, boot) {
    run <- s$run_all()
    tryCatch(s$await_operation(run$run_id), alder_error = function(error) NULL)
    composed <- output_host_cell(s, "cell-3")
    expect_identical(composed$status, "done")
    expect_identical(composed$log, c(
      "before layout", "renderer-message", "Warning: renderer-warning",
      "after layout", "renderer-message", "Warning: renderer-warning", "after append"
    ))
    expect_identical(composed$outputs[[1L]]$text, "printed result")
    terminal <- output_host_cell(s, "cell-4")
    expect_identical(terminal$log, c("renderer-message", "Warning: renderer-warning"))
    expect_identical(terminal$outputs[[1L]]$text, "printed result")
    lazy <- output_host_cell(s, "cell-5")$outputs[[1L]]
    expect_identical(s$await_operation(s$request_lazy(lazy$key))$status, "done")
    expanded <- output_host_cell(s, "cell-5")
    expect_identical(expanded$outputs[[1L]]$child$text, "printed result")
    expect_match(paste(expanded$log, collapse = "\n"), "Warning: renderer-warning", fixed = TRUE)
    failure <- output_host_cell(s, "cell-6")
    expect_identical(failure$status, "error")
    expect_match(failure$error$message, "printer failed", fixed = TRUE)
    expect_identical(output_host_cell(s, "cell-7")$outputs[[1L]]$text, "[1] 42")
    expect_true(s$worker_available())
  })
})

test_that("installed host preserves datetime, form, run-button, and cancellation semantics", {
  with_output_host(c(
    "# %%", "library(alder)",
    "# %%",
    "stamp <- ui$datetime(as.POSIXct('2026-09-03 12:00:00', tz = 'America/New_York'),",
    "  min = as.POSIXct('2026-09-03 11:00:00', tz = 'America/New_York'),",
    "  max = as.POSIXct('2026-09-03 14:00:00', tz = 'America/New_York'))",
    "stamp",
    "# %%", "format(stamp$value, '%Y-%m-%dT%H:%M:%SZ', tz = 'UTC')",
    "# %%", "entry <- ui$form(ui$text_input('before'))", "entry",
    "# %%", "paste(entry$value, sprintf('%.6f', as.numeric(Sys.time())))",
    "# %%",
    paste0("controls <- ui$dictionary(submitted = ",
           "ui$form(ui$text_input('draft'), submit_label = 'Commit'))"),
    "controls",
    "# %%",
    "paste(controls$value$submitted, sprintf('%.6f', as.numeric(Sys.time())))",
    "# %%", "btn <- ui$run_button(label = 'Go')", "btn",
    "# %%", "btn$value",
    "# %%",
    "buttons <- ui$array(go = ui$run_button(label = 'Go'),",
    "                    level = ui$slider(0, 10, value = 5))",
    "buttons",
    "# %%", "buttons$value$go",
    "# %%", "w <- ui$slider(0, 10, value = 5)", "w",
    "# %%", "w$value",
    "# %%", "Sys.sleep(2)", "1"
  ), function(s, boot) {
    expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")

    stamp <- output_host_cell(s, "cell-2")$outputs[[1L]]$spec
    expect_identical(stamp$value, "2026-09-03T16:00:00Z")
    expect_identical(stamp$min, "2026-09-03T15:00:00Z")
    expect_identical(stamp$max, "2026-09-03T18:00:00Z")
    expect_identical(output_host_cell(s, "cell-3")$outputs[[1L]]$text,
                     "[1] \"2026-09-03T16:00:00Z\"")
    token <- s$set_widget(
      "stamp", list(value = "2026-09-03T17:30:45Z"), "editor"
    )
    expect_identical(s$await_operation(token)$status, "done")
    wait_output_host(function() identical(
      output_host_cell(s, "cell-3")$outputs[[1L]]$text,
      "[1] \"2026-09-03T17:30:45Z\""
    ))
    expect_identical(output_host_cell(s, "cell-2")$outputs[[1L]]$spec$value,
                     "2026-09-03T17:30:45Z")
    for (invalid in c(
      "2026-09-03T17:30:45", "2026-09-03T17:30:45-04:00",
      "2026-02-30T17:30:45Z", "2026-09-03T17:30:45.500Z",
      "2026-09-03T17:30:45Zjunk"
    )) {
      error <- tryCatch({
        operation <- s$set_widget("stamp", list(value = invalid), "editor")
        s$await_operation(operation)
        NULL
      }, alder_error = identity)
      expect_s3_class(error, "alder_error")
      expect_match(conditionMessage(error), "temporal widget value required",
                   fixed = TRUE)
    }
    expect_identical(output_host_cell(s, "cell-2")$outputs[[1L]]$spec$value,
                     "2026-09-03T17:30:45Z")

    root_before <- output_host_cell(s, "cell-5")$outputs[[1L]]$text
    draft <- s$set_widget("entry", list(value = "after"), "editor")
    expect_identical(s$await_operation(draft)$status, "done")
    root_form <- output_host_cell(s, "cell-4")$outputs[[1L]]$spec
    expect_identical(root_form$child$value, "after")
    expect_true(root_form$dirty)
    expect_null(root_form$value)
    expect_identical(output_host_cell(s, "cell-5")$outputs[[1L]]$text,
                     root_before)
    submit <- s$set_widget("entry", list(submit = TRUE), "editor")
    expect_identical(s$await_operation(submit)$status, "done")
    wait_output_host(function() grepl(
      "after", output_host_cell(s, "cell-5")$outputs[[1L]]$text,
      fixed = TRUE
    ))
    root_form <- output_host_cell(s, "cell-4")$outputs[[1L]]$spec
    expect_identical(root_form$value, "after")
    expect_false(root_form$dirty)
    expect_false(identical(output_host_cell(s, "cell-5")$outputs[[1L]]$text,
                           root_before))

    nested_before <- output_host_cell(s, "cell-7")$outputs[[1L]]$text
    draft <- s$set_widget(
      "controls", "submitted", list(value = "trusted-form-value"), "editor"
    )
    expect_identical(s$await_operation(draft)$status, "done")
    nested_form <- output_host_widget_child(
      output_host_cell(s, "cell-6")$outputs[[1L]], "submitted"
    )
    expect_identical(nested_form$child$value, "trusted-form-value")
    expect_true(nested_form$dirty)
    expect_null(nested_form$value)
    expect_identical(output_host_cell(s, "cell-7")$outputs[[1L]]$text,
                     nested_before)
    submit <- s$set_widget(
      "controls", "submitted", list(submit = TRUE), "editor"
    )
    expect_identical(s$await_operation(submit)$status, "done")
    wait_output_host(function() grepl(
      "trusted-form-value",
      output_host_cell(s, "cell-7")$outputs[[1L]]$text,
      fixed = TRUE
    ))
    nested_form <- output_host_widget_child(
      output_host_cell(s, "cell-6")$outputs[[1L]], "submitted"
    )
    expect_identical(nested_form$value, "trusted-form-value")
    expect_false(nested_form$dirty)
    expect_false(identical(output_host_cell(s, "cell-7")$outputs[[1L]]$text,
                           nested_before))

    trigger <- s$set_widget("btn", list(value = TRUE), "editor")
    trigger_operation <- s$await_operation(trigger)
    expect_identical(trigger_operation$status, "done")
    expect_length(trigger_operation$resetOperationIds, 1L)
    expect_identical(
      s$widget_operation(trigger_operation$resetOperationIds[[1L]])$status,
      "done"
    )
    expect_false(output_host_cell(s, "cell-8")$outputs[[1L]]$spec$value)
    expect_identical(output_host_cell(s, "cell-9")$outputs[[1L]]$text,
                     "[1] TRUE")

    trigger <- s$set_widget(
      "buttons", "go", list(value = TRUE), "editor"
    )
    expect_identical(s$await_operation(trigger)$status, "done")
    buttons <- output_host_cell(s, "cell-10")$outputs[[1L]]
    expect_false(output_host_widget_child(buttons, "go")$value)
    expect_identical(output_host_widget_child(buttons, "level")$value, 5L)
    expect_identical(output_host_cell(s, "cell-11")$outputs[[1L]]$text,
                     "[1] TRUE")
    key <- paste("buttons", "go", sep = "\001")
    expect_identical(buttons$operations[[key]]$status, "done")

    long_run <- s$run_cell("cell-14")
    wait_output_host(function() isTRUE(s$state()$runtime$busy))
    pending <- s$set_widget("w", list(value = 9), "editor")
    s$set_cell(
      "cell-12", c("w <- ui$slider(0, 10, value = 7)", "w"), "code", 0L
    )
    expect_identical(s$await_operation(pending)$status, "cancelled")
    expect_identical(output_host_cell(s, "cell-12")$outputs[[1L]]$spec$value,
                     5L)
    expect_identical(s$await_operation(long_run$run_id)$status, "done")
    wait_output_host(function() {
      cell <- output_host_cell(s, "cell-13")
      identical(cell$status, "done") &&
        identical(cell$outputs[[1L]]$text, "[1] 7")
    })
    expect_true(s$worker_available())
  }, list(executionMode = "automatic"))
})

test_that("installed host bounds logs and visible text with exact truncation markers", {
  with_output_host(c(
    "# %%", "cat(paste(rep('x', 1048577), collapse = ''))",
    "# %%", "paste(rep('y', 262145), collapse = '')"
  ), function(s, boot) {
    expect_identical(s$await_operation(s$run_all()$run_id)$status, "done")
    log_text <- paste(output_host_cell(s, "cell-1")$log, collapse = "")
    expect_match(log_text, "\\[output truncated at 1048576 bytes\\]$")
    output <- output_host_cell(s, "cell-2")$outputs[[1L]]
    expect_true(output$truncated)
    expect_match(output$text, "\\[output truncated at 262144 bytes\\]$")
  })
})

test_that("installed host retains native plot failures and releases failed artifacts", {
  with_output_host(c(
    "# %%",
    "plot(1:6, type = 'b', col = '#176B87', main = 'layered')",
    "abline(h = 3.5, col = '#B42318', lty = 2, lwd = 2)",
    "lines(1:6, 6:1, col = '#176B87')",
    "title(sub = 'all layers retained')",
    "# %%", "plot(1:3)", "lines(1:2, 1:3)",
    "# %%", "42"
  ), function(s, boot) {
    run <- s$run_all()
    tryCatch(s$await_operation(run$run_id), alder_error = function(error) NULL)
    valid <- output_host_cell(s, "cell-1")
    expect_identical(valid$status, "done")
    expect_length(valid$outputs, 1L)
    expect_identical(valid$outputs[[1L]]$kind, "image")
    artifact <- file.path(
      boot$ready$artifactDirectory, valid$outputs[[1L]]$artifact
    )
    expect_true(file.exists(artifact))
    before <- sort(list.files(
      boot$ready$artifactDirectory, pattern = "\\.png$"
    ))
    expect_setequal(before, basename(artifact))

    failed <- output_host_cell(s, "cell-2")
    expect_identical(failed$status, "error")
    expect_length(failed$outputs, 0L)
    expect_match(failed$error$message, "lengths differ", fixed = TRUE)
    expect_true("simpleError" %in% unlist(failed$error$class, use.names = FALSE))
    expect_match(failed$error$call, "xy.coords|lines")
    expect_identical(sort(list.files(
      boot$ready$artifactDirectory, pattern = "\\.png$"
    )), before)
    expect_identical(output_host_cell(s, "cell-3")$outputs[[1L]]$text,
                     "[1] 42")

    s$set_cell(
      "cell-2", c("plot(1:3)", "lines(1:3, 3:1)"), "code", 0L
    )
    wait_output_host(function() !isTRUE(s$state()$runtime$analysisPending))
    expect_identical(s$await_operation(s$run_cell("cell-2")$run_id)$status,
                     "done")
    repaired <- output_host_cell(s, "cell-2")
    expect_identical(repaired$status, "done")
    expect_true(any(vapply(repaired$outputs, function(output) {
      identical(output$kind, "image")
    }, FALSE)))
    expect_length(list.files(
      boot$ready$artifactDirectory, pattern = "\\.png$"
    ), 2L)
    expect_true(s$worker_available())
  })
})

test_that("installed Ark preserves structured conditions and warning positions", {
  with_output_host(c(
    "# %%", "cat('\\U0001F9ECpartial-')", "alder::out$append('in-between')",
    "cat('line\\n')", "cat('before\\n')", "warning('warning-marker')",
    "cat('after\\n')", "42",
    "# %%", "stop(structure(list(message = 'typed failure',",
    "  code = 'fixture_failure', call = NULL),",
    "  class = c('fixture_error', 'error', 'condition')))"
  ), function(s, boot) {
    run <- s$run_all()
    tryCatch(s$await_operation(run$run_id), alder_error = function(error) NULL)
    cell <- output_host_cell(s, "cell-1")
    expect_identical(cell$status, "done")
    text <- paste(unlist(cell$log, use.names = FALSE), collapse = "\n")
    expect_match(text, "\U0001F9ECpartial-line\nbefore", fixed = TRUE)
    expect_identical(cell$outputs[[1L]]$log_offset, 9L)
    markers <- c("before", "Warning: warning-marker", "after")
    positions <- vapply(markers, function(marker)
      regexpr(marker, text, fixed = TRUE)[[1L]], 0L)
    expect_true(all(positions > 0L))
    expect_true(all(diff(positions) > 0L))
    expect_identical(sum(gregexpr("warning-marker", text, fixed = TRUE)[[1L]] > 0L), 1L)
    error <- output_host_cell(s, "cell-2")$error
    expect_identical(error$message, "typed failure")
    expect_identical(error$code, "fixture_failure")
    expect_true("fixture_error" %in% unlist(error$class, use.names = FALSE))
    expect_true(length(error$trace) > 0L)
  })
})
