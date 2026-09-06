pkgload::load_all(".", quiet = TRUE)
sys.source("tests/testthat/helper-session.R", envir = globalenv())

browser_expressions <- parse("tests/testthat/test-browser.R")
for (index in seq_len(22L)) eval(browser_expressions[[index]], globalenv())

ctx <- start_browser_server(c("# %%", "x <- 1"))
on.exit({
  try(ctx$session$close(), silent = TRUE)
  if (!is.null(ctx$browser)) try(ctx$browser$close(), silent = TRUE)
  if (ctx$proc$is_alive()) ctx$proc$kill()
  ctx$proc$wait(5000)
  unlink(ctx$root, recursive = TRUE, force = TRUE)
}, add = TRUE)

wait_cells_done(ctx$session, 1L)
id <- browser_state(ctx$session)$cells[[1L]]$id
stopifnot(browser_eval(ctx$session, sprintf(
  "window.__alderSetCellSource(%s,%s)", js_json(id), js_json("x <- 2")
)))
wait_browser(ctx$session, function() isTRUE(browser_state(ctx$session)$changed),
             label = "server acknowledgement")
browser_eval(ctx$session, paste0(
  "(()=>{window.__shutdownConfirms=0;window.confirm=()=>{",
  "window.__shutdownConfirms+=1;return false};return true})()"
))
clicked <- click_selector(ctx$session, "#shutdown")
Sys.sleep(3)

dom <- browser_eval(ctx$session, paste0(
  "(()=>({confirmCount:window.__shutdownConfirms,",
  "status:document.querySelector('#status')?.textContent||'',",
  "statusClass:document.querySelector('#status')?.className||'',",
  "shutdownDisabled:document.querySelector('#shutdown')?.disabled,",
  "saveDisabled:document.querySelector('#save')?.disabled,",
  "shutdownComplete:document.body.classList.contains('shutdown-complete')}))()"
))
state <- tryCatch(browser_state(ctx$session), error = function(error) {
  list(fetch_error = conditionMessage(error))
})
result <- list(
  clicked = clicked,
  dom = dom,
  state_changed = state$changed %||% NULL,
  state_error = state$last_action_error %||% NULL,
  process_alive = ctx$proc$is_alive(),
  server_stdout = ctx$proc$read_output_lines(),
  server_stderr = ctx$proc$read_error_lines()
)
jsonlite::write_json(
  result,
  "dev/reviews/evidence/cycle-2-integrated/12-shutdown-sync-debug.json",
  auto_unbox = TRUE,
  pretty = TRUE,
  null = "null"
)
print(result)
