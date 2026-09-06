# Repeats the real Chrome settings/table flow in one R process to expose
# lifecycle and accumulated-load races. Run from the package root.

library(alder)
library(testthat)

browser_test <- readLines("tests/testthat/test-browser.R", warn = FALSE)
helper_end <- grep("^# 1 -", browser_test)[[1L]] - 1L
eval(parse(text = paste(browser_test[seq_len(helper_end)], collapse = "\n")),
     envir = .GlobalEnv)

iterations <- as.integer(Sys.getenv("ALDER_PROBE_ITERATIONS", "5"))
or_else <- function(x, y) if (is.null(x)) y else x
run_once <- function(iteration) {
  ctx <- start_browser_server(c("# %%", "data.frame(x = 1:30)"))
  on.exit({
    try(ctx$session$close(), silent = TRUE)
    if (!is.null(ctx$browser)) try(ctx$browser$close(), silent = TRUE)
    if (ctx$proc$is_alive()) ctx$proc$kill()
    ctx$proc$wait(5000)
    unlink(ctx$root, recursive = TRUE, force = TRUE)
  }, add = TRUE)

  wait_cells_done(ctx$session, 1L)
  stopifnot(click_selector(ctx$session, "#settings-open"))
  stopifnot(set_input(ctx$session, "#settings-table-page-size", "10", "input"))
  stopifnot(click_selector(ctx$session, "#settings-apply"))

  deadline <- Sys.time() + 35
  ok <- FALSE
  state <- NULL
  rows <- NA_integer_
  label <- ""
  dialog_open <- TRUE
  while (Sys.time() < deadline) {
    state <- browser_state(ctx$session)
    page <- state$cells[[1L]]$outputs[[1L]]$page
    rows <- browser_eval(ctx$session,
      "document.querySelectorAll('.table-preview tbody tr').length")
    label <- browser_eval(ctx$session,
      "document.querySelector('.table-page-label')?.textContent || ''")
    dialog_open <- browser_eval(ctx$session,
      "Boolean(document.querySelector('#settings')?.open)")
    ok <- identical(as.integer(state$config$table$page_size), 10L) &&
      identical(as.integer(page$limit), 10L) &&
      identical(as.integer(rows), 10L) &&
      grepl("1..10 of 30", label, fixed = TRUE) && !isTRUE(dialog_open)
    if (ok) break
    Sys.sleep(0.1)
  }
  action_error <- or_else(state$last_action_error, list())
  status <- browser_eval(ctx$session,
    "document.querySelector('#status')?.textContent || ''")
  cat("iteration", iteration, "ok", ok, "version", state$version,
      "config", state$config$table$page_size,
      "page", paste(or_else(page$offset, "NULL"),
                    or_else(page$limit, "NULL")),
      "rows", rows, "label", label, "dialog_open", dialog_open,
      "state_error", or_else(action_error$message, "NULL"), "status", status,
      "\n")
  stopifnot(ok)
}

for (iteration in seq_len(iterations)) run_once(iteration)
