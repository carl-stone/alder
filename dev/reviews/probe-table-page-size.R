# Diagnostic evidence probe for the settings-driven table repagination flow.
# Run from the package root against an installed Alder build.

library(alder)
library(testthat)

browser_test <- readLines("tests/testthat/test-browser.R", warn = FALSE)
helper_end <- grep("^# 1 -", browser_test)[[1L]] - 1L
eval(parse(text = paste(browser_test[seq_len(helper_end)], collapse = "\n")),
     envir = .GlobalEnv)

ctx <- start_browser_server(c("# %%", "data.frame(x = 1:30)"))
on.exit({
  try(ctx$session$close(), silent = TRUE)
  if (!is.null(ctx$browser)) try(ctx$browser$close(), silent = TRUE)
  if (ctx$proc$is_alive()) ctx$proc$kill()
  ctx$proc$wait(5000)
  unlink(ctx$root, recursive = TRUE, force = TRUE)
}, add = TRUE)

wait_cells_done(ctx$session, 1L)
show_state <- function(tag) {
  state <- browser_state(ctx$session)
  output <- state$cells[[1L]]$outputs[[1L]]
  cat("---", tag, "---\n")
  cat("version", state$version, "config", state$config$table$page_size,
      "kind", output$kind, "handle", output$handle, "\n")
  page <- if (is.null(output$page)) {
    "NULL"
  } else {
    paste(output$page$offset, output$page$limit, output$page$nrow)
  }
  cat("page", page, "\n")
  cat(
    "rows",
    browser_eval(ctx$session,
      "document.querySelectorAll('.table-preview tbody tr').length"),
    "label",
    browser_eval(ctx$session,
      "document.querySelector('.table-page-label')?.textContent || ''"),
    "\n"
  )
  cat(
    "status",
    browser_eval(ctx$session,
      "document.querySelector('#status')?.textContent || ''"),
    "\n"
  )
  action_error <- if (is.null(state$last_action_error)) {
    "NULL"
  } else {
    paste(state$last_action_error$code, state$last_action_error$message)
  }
  cat("last_error", action_error, "\n")
}

show_state("before")
stopifnot(click_selector(ctx$session, "#settings-open"))
stopifnot(set_input(ctx$session, "#settings-table-page-size", "10", "input"))
stopifnot(click_selector(ctx$session, "#settings-apply"))
for (i in seq_len(120L)) {
  Sys.sleep(0.1)
  if (i %in% c(5L, 20L, 50L, 120L)) show_state(paste0("after-", i))
}
