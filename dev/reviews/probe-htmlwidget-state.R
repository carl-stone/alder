pkgload::load_all(".", quiet = TRUE)
sys.source("tests/testthat/helper-session.R", envir = globalenv())

browser_expressions <- parse("tests/testthat/test-browser.R")
for (index in seq_len(22L)) eval(browser_expressions[[index]], globalenv())

ctx <- start_browser_server(c(
  "# %%",
  "library(htmlwidgets)",
  "tw <- htmlwidgets::createWidget(name = 'tw', x = list(message = 'hi'))",
  "tw"
))
on.exit({
  try(ctx$session$close(), silent = TRUE)
  if (!is.null(ctx$browser)) try(ctx$browser$close(), silent = TRUE)
  if (ctx$proc$is_alive()) ctx$proc$kill()
  ctx$proc$wait(5000)
  unlink(ctx$root, recursive = TRUE, force = TRUE)
}, add = TRUE)

snapshots <- list()
started <- Sys.time()
deadline <- started + 45
repeat {
  state <- tryCatch(browser_state(ctx$session), error = function(error) {
    list(fetch_error = conditionMessage(error))
  })
  cell <- if (length(state$cells %||% list())) state$cells[[1L]] else list()
  snapshots[[length(snapshots) + 1L]] <- list(
    elapsed = as.numeric(difftime(Sys.time(), started, units = "secs")),
    status = cell$status %||% NULL,
    error = cell$error %||% NULL,
    outputs = cell$outputs %||% list(),
    runtime = state$runtime %||% NULL,
    last_action_error = state$last_action_error %||% NULL
  )
  if (!identical(cell$status %||% "", "running") || Sys.time() >= deadline) break
  Sys.sleep(1)
}

dom <- browser_eval(ctx$session, paste0(
  "(()=>({body:document.body.textContent,",
  "widget:document.querySelector('.html-widget')?.outerHTML||null}))()"
))
result <- list(
  snapshots = snapshots,
  dom = dom,
  process_alive = ctx$proc$is_alive(),
  server_stdout = ctx$proc$read_output_lines(),
  server_stderr = ctx$proc$read_error_lines()
)
jsonlite::write_json(
  result,
  "dev/reviews/evidence/cycle-2-integrated/19-htmlwidget-state.json",
  auto_unbox = TRUE,
  pretty = TRUE,
  null = "null"
)
print(tail(snapshots, 1L))
print(result[c("dom", "process_alive", "server_stdout", "server_stderr")])
