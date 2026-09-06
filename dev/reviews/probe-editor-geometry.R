# Capture the current installed-package editor and report geometry that is
# otherwise easy to misjudge from a screenshot. Run from the package root.

browser_test <- readLines("tests/testthat/test-browser.R", warn = FALSE)
test_start <- grep("^# 1 -+", browser_test)[[1L]]
helper_env <- new.env(parent = globalenv())
eval(parse(text = paste(browser_test[seq_len(test_start - 1L)], collapse = "\n")),
     envir = helper_env)

ctx <- helper_env$start_browser_server(c(
  "# %%", "library(alder)", "x <- 1", "x",
  "# %%", "y <- x + 1", "y"
))
on.exit({
  try(ctx$session$close(), silent = TRUE)
  if (!is.null(ctx$browser)) try(ctx$browser$close(), silent = TRUE)
  if (ctx$proc$is_alive()) ctx$proc$kill()
  ctx$proc$wait(5000)
  unlink(ctx$root, recursive = TRUE, force = TRUE)
}, add = TRUE)

ctx$session$Emulation$setDeviceMetricsOverride(
  width = 1350L, height = 900L, deviceScaleFactor = 1, mobile = FALSE
)
helper_env$wait_cells_done(ctx$session, 2L, timeout = 30)

geometry <- helper_env$browser_eval(ctx$session, paste0(
  "(()=>{",
  "const cell=document.querySelector('.cell');",
  "const gutters=[...cell.querySelectorAll('.cm-gutterElement')].map(n=>{",
  "const r=n.getBoundingClientRect();return {text:n.textContent.trim(),top:r.top,left:r.left,height:r.height}});",
  "const lines=[...cell.querySelectorAll('.cm-line')].map(n=>{",
  "const r=n.getBoundingClientRect();return {text:n.textContent,top:r.top,left:r.left,height:r.height}});",
  "const s=cell.querySelector('.cm-scroller');const cs=getComputedStyle(s);",
  "const minimap=[...document.querySelectorAll('.minimap-cell')].map(n=>{",
  "const r=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),top:r.top,right:r.right,width:r.width,height:r.height}});",
  "return {scroller:{display:cs.display,flexDirection:cs.flexDirection},gutters,lines,minimap,",
  "cellLabel:cell.getAttribute('aria-label'),cellText:cell.innerText};})()"
))

dir.create("dev/reviews/evidence/frontend-cycle-1", recursive = TRUE,
           showWarnings = FALSE)
shot <- "dev/reviews/evidence/frontend-cycle-1/15-current-editor-geometry.png"
ctx$session$screenshot(filename = shot)

cat(jsonlite::toJSON(list(screenshot = shot, geometry = geometry),
                     auto_unbox = TRUE, pretty = TRUE, null = "null"), "\n")
