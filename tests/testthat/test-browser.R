# Browser acceptance tests for the installed alder launcher.
#
# These tests intentionally drive the real page through Chrome. The helper
# keeps all browser-side state access in Runtime.evaluate so assertions
# exercise the same DOM and HTTP boundary as a user.

skip_browser_if_unavailable <- function() {
  testthat::skip_on_cran()
  if (!requireNamespace("chromote", quietly = TRUE)) {
    testthat::skip("browser unavailable: chromote is not installed")
  }
  probe <- tryCatch({
    b <- chromote::Chrome$new()
    b$close()
    TRUE
  }, error = function(e) FALSE)
  if (!probe) testthat::skip("browser unavailable: Chrome could not start")
}

js_json <- function(x) jsonlite::toJSON(x, auto_unbox = TRUE, null = "null")

browser_eval <- function(session, expression) {
  result <- session$Runtime$evaluate(
    expression, returnByValue = TRUE, awaitPromise = TRUE)
  result$result$value
}

cell_body <- function(cell) {
  if (is.null(cell) || is.null(cell$body)) return(character())
  as.character(unlist(cell$body, use.names = FALSE))
}

cell_text <- function(session, id) cell_body(cell_state(session, id))

browser_state <- function(session) {
  browser_eval(session, "(async()=>await (await fetch('/api/state')).json())()")
}

wait_browser <- function(session, predicate, timeout = 15, label = "browser state") {
  deadline <- Sys.time() + timeout
  last <- NULL
  while (Sys.time() < deadline) {
    last <- tryCatch(predicate(), error = function(e) NULL)
    if (isTRUE(last)) return(invisible(TRUE))
    Sys.sleep(0.1)
  }
  testthat::fail(paste0("timed out waiting for ", label))
}

wait_idle <- function(session, timeout = 15) {
  wait_browser(session, function() {
    state <- browser_state(session)
    isFALSE(state$runtime$busy)
  }, timeout, "worker idle")
}

cell_statuses <- function(session) {
  browser_eval(session, "[...document.querySelectorAll('.cell')].map(x => (x.querySelector('[data-role=badge],.cell-badge,.badge') || {}).textContent || '')")
}

wait_cells_done <- function(session, n = NULL, timeout = 15) {
  wait_browser(session, function() {
    statuses <- cell_statuses(session)
    if (!is.null(n) && length(statuses) != n) return(FALSE)
    length(statuses) > 0L && all(statuses %in% c("done", "idle")) &&
      isFALSE(browser_state(session)$runtime$busy)
  }, timeout, "cells to finish")
}

set_textarea <- function(session, selector, value) {
  expression <- sprintf(
    "(()=>{let n=document.querySelector(%s);let c=n?.closest('.cell');if(!c){const raw=%s.replace(/\\s*textarea$/, '');c=(raw?document.querySelector(raw):null)||document.querySelector('.cell')};if(!c||!c.id||!window.__alderSetCellSource)return false;return window.__alderSetCellSource(c.id.replace(/^cell-/,''),%s)})()",
    js_json(selector), js_json(selector), js_json(value))
  isTRUE(browser_eval(session, expression))
}

set_input <- function(session, selector, value, event = "input") {
  expression <- sprintf(
    "(()=>{const el=document.querySelector(%s);if(!el)return false;const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(el,%s);el.dispatchEvent(new Event(%s,{bubbles:true}));return true})()",
    js_json(selector), js_json(value), js_json(event))
  isTRUE(browser_eval(session, expression))
}

set_select <- function(session, selector, value) {
  expression <- sprintf(
    "(()=>{const el=document.querySelector(%s);if(!el)return false;el.value=%s;el.dispatchEvent(new Event('change',{bubbles:true}));return true})()",
    js_json(selector), js_json(value))
  isTRUE(browser_eval(session, expression))
}

click_selector <- function(session, selector) {
  expression <- sprintf(
    "(()=>{const el=document.querySelector(%s);if(!el)return false;el.click();return true})()",
    js_json(selector))
  isTRUE(browser_eval(session, expression))
}

cell_ids <- function(session) {
  browser_eval(session, "[...document.querySelectorAll('.cell')].map(x => x.id)")
}

cell_state <- function(session, id) {
  state <- browser_state(session)
  for (cell in state$cells) {
    if (identical(cell$id, id)) {
      cell$output <- if (length(cell$outputs)) cell$outputs[[length(cell$outputs)]] else NULL
      return(cell)
    }
  }
  NULL
}

new_browser_session <- function(url) {
  # chromote releases differ: some expose Chrome$new_session(), while the
  # installed CRAN version creates a ChromoteSession directly.
  browser <- tryCatch(chromote::Chrome$new(), error = function(e) NULL)
  if (!is.null(browser) && is.function(browser$new_session)) {
    session <- browser$new_session(url = url)
    return(list(browser = browser, session = session))
  }
  if (!is.null(browser)) try(browser$close(), silent = TRUE)
  session <- chromote::ChromoteSession$new()
  session$go_to(url)
  list(browser = NULL, session = session)
}

start_browser_server <- function(lines) {
  path <- tempfile("alder-browser-", fileext = ".R")
  writeLines(lines, path, useBytes = TRUE)
  port <- httpuv::randomPort()
  launcher <- system.file("worker", "server.R", package = "alder", mustWork = TRUE)
  proc <- processx::process$new(
    file.path(R.home("bin"), "Rscript"),
    c(launcher, path, as.character(port)), stdout = "|", stderr = "|")
  output <- character()
  deadline <- Sys.time() + 30
  ready <- FALSE
  while (proc$is_alive() && Sys.time() < deadline) {
    output <- c(output, proc$read_output_lines())
    if (any(grepl("alder running", output, fixed = TRUE))) {
      ready <- TRUE
      break
    }
    Sys.sleep(0.05)
  }
  if (!ready) {
    if (proc$is_alive()) proc$kill()
    proc$wait(5000)
    stop("launcher did not become ready: ", paste(output, collapse = " | "))
  }
  browser <- new_browser_session(sprintf("http://127.0.0.1:%d/", port))
  list(path = path, port = port, proc = proc,
       browser = browser$browser, session = browser$session,
       url = sprintf("http://127.0.0.1:%d/", port))
}

with_browser_server <- function(lines, code) {
  skip_browser_if_unavailable()
  ctx <- start_browser_server(lines)
  on.exit({
    try(ctx$session$close(), silent = TRUE)
    if (!is.null(ctx$browser)) try(ctx$browser$close(), silent = TRUE)
    if (ctx$proc$is_alive()) ctx$proc$kill()
    ctx$proc$wait(5000)
    unlink(ctx$path)
  }, add = TRUE)
  force(code(ctx))
}

new_tab <- function(ctx) {
  other <- new_browser_session(ctx$url)
  other
}

# 1 ---------------------------------------------------------------------------
testthat::test_that("browser add-below preserves DOM and server order", {
  with_browser_server(character(), function(ctx) {
    wait_browser(ctx$session, function() length(cell_ids(ctx$session)) == 0L,
                 label = "empty notebook")
    testthat::expect_true(click_selector(ctx$session, ".empty-bar [data-type=code]"))
    wait_browser(ctx$session, function() length(cell_ids(ctx$session)) == 1L,
                 label = "first cell")
    first <- cell_ids(ctx$session)[[1L]]
    testthat::expect_true(click_selector(ctx$session,
      sprintf("#%s [data-act=add][data-type=code]", first)))
    wait_browser(ctx$session, function() length(cell_ids(ctx$session)) == 2L,
                 label = "second cell")
    dom <- cell_ids(ctx$session)
    state <- browser_state(ctx$session)
    testthat::expect_equal(dom[[1L]], paste0("cell-", state$cells[[1L]]$id))
    testthat::expect_equal(dom[[2L]], paste0("cell-", state$cells[[2L]]$id))
    testthat::expect_equal(state$cells[[1L]]$id, sub("^cell-", "", first))
  })
})

# 2 ---------------------------------------------------------------------------
testthat::test_that("browser converts code and Markdown types atomically", {
  with_browser_server(c("# %%", "# **bold**"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(set_select(ctx$session,
      sprintf("#cell-%s [data-role=type]", id), "markdown"))
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, id)
      identical(cell$type, "markdown") &&
        isTRUE(browser_eval(ctx$session,
          sprintf("document.querySelector('#cell-%s .markdown-output strong') !== null", id)))
    }, label = "Markdown conversion")
    testthat::expect_equal(cell_state(ctx$session, id)$status, "done")
    testthat::expect_true(set_select(ctx$session,
      sprintf("#cell-%s [data-role=type]", id), "code"))
    wait_browser(ctx$session, function() {
      identical(cell_state(ctx$session, id)$type, "code")
    }, label = "code conversion")
    source <- browser_eval(ctx$session,
      sprintf("window.__alderEditors.get('%s')?.getDoc()", id))
  })
})

# 3 --------------------------------------------------------------------------
testthat::test_that("browser renders and sanitizes a loaded Markdown cell", {
  with_browser_server(c("# %% [markdown]",
                        "# Hello **world** <script>alert(1)</script>"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    html <- browser_eval(ctx$session, "document.querySelector('.markdown-output')?.innerHTML || ''")
    scripts <- browser_eval(ctx$session, "document.querySelectorAll('.markdown-output script').length")
    testthat::expect_match(html, "<strong>world</strong>")
    testthat::expect_equal(scripts, 0)
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('.cell.done .output-area') !== null"))
  })
})

# 4 --------------------------------------------------------------------------
testthat::test_that("browser preserves focused source across polls", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    source_id <- browser_eval(ctx$session,
      "(()=>{const x=document.querySelector('.cm-content');x.focus();return x.closest('.cell')?.id})()")
    testthat::expect_true(is.character(source_id) && nzchar(source_id))
    Sys.sleep(2.1)
    active <- browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.id || null")
    testthat::expect_equal(active, source_id)
  })
})

# 5 --------------------------------------------------------------------------
testthat::test_that("browser coalesces slider input to its final value", {
  with_browser_server(c("# %%", "library(alder)",
                        "# %%", "min_wt <- ui$slider(0, 10, value = 5)", "min_wt"), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    id <- browser_state(ctx$session)$cells[[2L]]$id
    selector <- sprintf("#widget-%s-slider", id)
    testthat::expect_true(set_input(ctx$session, selector, "3", "input"))
    testthat::expect_true(set_input(ctx$session, selector, "7", "input"))
    wait_idle(ctx$session)
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, id)
      isTRUE(as.numeric(cell$output$spec$value) == 7)
    }, label = "slider commit")
    testthat::expect_equal(as.numeric(cell_state(ctx$session, id)$output$spec$value), 7)
  })
})

# 6 --------------------------------------------------------------------------
testthat::test_that("browser resets run buttons after their consumers finish", {
  with_browser_server(c("# %%", "library(alder)",
                        "# %%", "go <- ui$run_button()", "go",
                        "# %%", "go$value"), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    id <- browser_state(ctx$session)$cells[[2L]]$id
    selector <- sprintf("#widget-%s-run_button", id)
    wait_browser(ctx$session, function() {
      isTRUE(browser_eval(ctx$session, sprintf("document.querySelector('%s') !== null", selector)))
    }, label = "run button DOM")
    testthat::expect_true(click_selector(ctx$session, selector))
    disabled <- browser_eval(ctx$session, sprintf("document.querySelector('%s').disabled", selector))
    testthat::expect_true(disabled)
    wait_idle(ctx$session)
    wait_browser(ctx$session, function() {
      button <- browser_eval(ctx$session, sprintf("document.querySelector('%s').disabled", selector))
      value <- cell_state(ctx$session, id)$output$spec$value
      isFALSE(button) && isFALSE(value)
    }, label = "run button reset")
  })
})

testthat::test_that("browser patches dropdown choices and labels", {
  with_browser_server(c("# %%", "library(alder)",
                        "# %%", "pick <- ui$dropdown(c('a', 'b'), label = 'pick one')", "pick"), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    id <- browser_state(ctx$session)$cells[[2L]]$id
    testthat::expect_equal(unname(unlist(browser_eval(ctx$session,
      sprintf("[...document.querySelectorAll('#widget-%s-dropdown option')].map(x=>x.textContent)", id)))),
      c("a", "b"))
    testthat::expect_equal(browser_eval(ctx$session,
      sprintf("document.querySelector('#widget-%s-dropdown').parentElement.querySelector('label').textContent", id)), "pick one")
    testthat::expect_true(set_select(ctx$session, sprintf("#widget-%s-dropdown", id), "2"))
    wait_browser(ctx$session, function() {
      output <- cell_state(ctx$session, id)$output
      identical(as.integer(output$spec$index), 2L) && identical(as.character(output$spec$value), "b")
    }, label = "dropdown commit")
  })
})

testthat::test_that("browser renders and updates recursive composite controls", {
  with_browser_server(c(
    "# %%", "library(alder)",
    "# %%",
    "controls <- ui$dictionary(",
    "  settings = ui$form(ui$array(",
    "    ui$slider(0, 10, value = 2), ui$checkbox(FALSE)",
    "  )),",
    "  upload = ui$file()",
    ")",
    "controls"
  ), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    id <- browser_state(ctx$session)$cells[[2L]]$id
    selector <- sprintf("#widget-%s-slider-settings-1", id)
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector('%s')?.dataset.path === '[\"settings\",\"1\"]'",
      selector
    )))
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector('#cell-%s [data-role=widget][data-kind=file]') !== null",
      id
    )))
    testthat::expect_true(set_input(ctx$session, selector, "7", "input"))
    wait_browser(ctx$session, function() {
      output <- cell_state(ctx$session, id)$output
      value <- output$spec$children[[1L]]$child$children[[1L]]$value
      isTRUE(as.numeric(value) == 7)
    }, label = "nested slider commit")
  })
})

# 8 --------------------------------------------------------------------------
testthat::test_that("browser source conflicts offer server recovery", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    set_textarea(ctx$session, "textarea", "x <- 2")
    other <- new_tab(ctx)
    on.exit({
      try(other$session$close(), silent = TRUE)
      if (!is.null(other$browser)) try(other$browser$close(), silent = TRUE)
    }, add = TRUE)
    wait_browser(other$session, function() identical(
      browser_eval(other$session,
        sprintf("window.__alderEditors.get('%s')?.getDoc()", id)), "x <- 2"),
      label = "second editor source")
    set_textarea(other$session, "textarea", "x <- 4")
    wait_browser(other$session, function() identical(cell_text(other$session, id), "x <- 4"),
      label = "second edit")
    set_textarea(ctx$session, "textarea", "x <- 3")
    wait_browser(ctx$session, function() {
      browser_eval(ctx$session, sprintf("document.querySelector('#cell-%s [data-act=use-server]') !== null", id))
    }, label = "conflict recovery control")
    testthat::expect_false(isTRUE(browser_eval(ctx$session,
      sprintf("document.querySelector('#cell-%s [data-act=retry-edit]') !== null", id))))
    wait_browser(ctx$session, function() identical(
      browser_eval(ctx$session,
        sprintf("window.__alderEditors.get('%s')?.getDoc()", id)), "x <- 4"),
      label = "server source")
  })
})

# 9 --------------------------------------------------------------------------
testthat::test_that("browser keeps a deleted local cell as a tombstone", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    other <- new_tab(ctx)
    on.exit({
      try(other$session$close(), silent = TRUE)
      if (!is.null(other$browser)) try(other$browser$close(), silent = TRUE)
    }, add = TRUE)
    wait_browser(other$session, function() browser_eval(other$session,
      sprintf("document.querySelector('#cell-%s [data-act=delete]') !== null", id)),
      label = "second tab cell")
    set_textarea(ctx$session, "textarea", "x <- 9")
    testthat::expect_true(click_selector(other$session, sprintf("#cell-%s [data-act=delete]", id)))
    wait_idle(other$session)
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      sprintf("document.querySelector('#cell-%s [data-act=restore]') !== null", id)), label = "cell tombstone")
    testthat::expect_true(browser_eval(ctx$session, sprintf("document.querySelector('#cell-%s [data-act=discard-local]') !== null", id)))
    click_selector(ctx$session, sprintf("#cell-%s [data-act=discard-local]", id))
    wait_browser(ctx$session, function() length(cell_ids(ctx$session)) == 0L, label = "discard tombstone")
    wait_browser(other$session, function() browser_eval(other$session,
      "document.querySelector('.empty-bar [data-type=code]') !== null"),
      label = "empty notebook in second tab")
    testthat::expect_true(click_selector(other$session, ".empty-bar [data-type=code]"))
    wait_browser(other$session, function() length(cell_ids(other$session)) == 1L,
      label = "replacement cell")
    replacement <- cell_ids(other$session)[[1L]]
    wait_browser(ctx$session, function() {
      ids <- cell_ids(ctx$session)
      length(ids) == 1L && identical(ids[[1L]], replacement)
    }, label = "replacement in first tab")
    set_textarea(ctx$session, "textarea", "x <- 11")
    wait_browser(other$session, function() browser_eval(other$session,
      sprintf("document.querySelector('#%s [data-act=delete]') !== null", replacement)),
      label = "replacement delete control")
    testthat::expect_true(click_selector(other$session,
      sprintf("#%s [data-act=delete]", replacement)))
    wait_idle(other$session)
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      sprintf("document.querySelector('#%s [data-act=restore]') !== null", replacement)),
      label = "second tombstone")
    testthat::expect_true(click_selector(ctx$session,
      sprintf("#%s [data-act=restore]", replacement)))
    wait_browser(ctx$session, function() {
      ids <- cell_ids(ctx$session)
      length(ids) == 1L && !identical(ids[[1L]], replacement)
    }, label = "restored cell")
    restored <- cell_ids(ctx$session)[[1L]]
    testthat::expect_equal(browser_eval(ctx$session,
      sprintf("window.__alderEditors.get('%s')?.getDoc()", sub("^cell-", "", restored))),
      "x <- 11")
  })
})

# 10 -------------------------------------------------------------------------
testthat::test_that("browser commits only the latest rapid edit", {
  with_browser_server(c("# %%", "x <- 0"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    set_textarea(ctx$session, "textarea", "x <- 1")
    Sys.sleep(0.05)
    set_textarea(ctx$session, "textarea", "x <- 2")
    Sys.sleep(0.05)
    set_textarea(ctx$session, "textarea", "x <- 3")
    wait_browser(ctx$session, function() identical(cell_text(ctx$session, id), "x <- 3"), label = "latest edit")
    testthat::expect_equal(cell_text(ctx$session, id), "x <- 3")
  })
})

testthat::test_that("browser unload guard permits flushed internal app navigation", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    set_textarea(ctx$session, "textarea", "x <- 2")
    guarded <- browser_eval(ctx$session, "(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()")
    testthat::expect_true(guarded)
    click_selector(ctx$session, "#app-mode")
    wait_browser(ctx$session, function() grepl("view=app", browser_eval(ctx$session, "location.search")), label = "app navigation")
    testthat::expect_equal(browser_eval(ctx$session, "document.querySelectorAll('textarea').length"), 0)
    testthat::expect_equal(cell_text(ctx$session, browser_state(ctx$session)$cells[[1L]]$id), "x <- 2")
  })
})

# 11 -------------------------------------------------------------------------
testthat::test_that("browser automatic and lazy widget scheduling differ", {
  with_browser_server(c("# %%", "library(alder)", "a <- 1",
                        "# %%", "s <- ui$slider(0, 10, value = 5)", "s",
                        "# %%", "b <- s$value + a", "b"), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    slider_id <- browser_state(ctx$session)$cells[[2L]]$id
    consumer_id <- browser_state(ctx$session)$cells[[3L]]$id
    set_input(ctx$session, sprintf("#widget-%s-slider", slider_id), "7", "input")
    wait_browser(ctx$session, function() identical(cell_state(ctx$session, consumer_id)$output$text, "[1] 8"), label = "automatic consumer")
    testthat::expect_true(set_select(ctx$session, "#runtime-select", "lazy"))
    wait_browser(ctx$session, function() identical(browser_state(ctx$session)$runtime$execution_mode, "lazy"), label = "lazy runtime")
    set_input(ctx$session, sprintf("#widget-%s-slider", slider_id), "8", "input")
    wait_idle(ctx$session)
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, consumer_id)
      identical(cell$status, "stale") && identical(cell$output$text, "[1] 8")
    }, label = "lazy stale consumer")
    testthat::expect_true(click_selector(ctx$session, "#run-all"))
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, consumer_id)
      identical(cell$status, "done") && identical(cell$output$text, "[1] 9")
    }, label = "lazy explicit run")
  })
})


# 13 -------------------------------------------------------------------------
testthat::test_that("browser app view is output-only but keeps logs and widgets", {
  with_browser_server(c("# %%", "library(alder)", "cat('hello log')",
                        "# %% [markdown]", "# App **markdown**",
                        "# %%", "s <- ui$slider(0, 10, value = 5)", "s"), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    click_selector(ctx$session, "#app-mode")
    wait_browser(ctx$session, function() {
      grepl("view=app", browser_eval(ctx$session, "location.search")) &&
        isTRUE(browser_eval(ctx$session,
          "document.querySelectorAll('#run-all,#save,#runtime-select').length") == 0)
    }, label = "app view")
    testthat::expect_equal(browser_eval(ctx$session, "document.querySelectorAll('textarea').length"), 0)
    testthat::expect_equal(browser_eval(ctx$session, "document.querySelectorAll('.cell-head').length"), 0)
    testthat::expect_equal(browser_eval(ctx$session, "document.querySelectorAll('#run-all,#save,#runtime-select').length"), 0)
    testthat::expect_match(browser_eval(ctx$session, "document.body.textContent"), "hello log")
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('.markdown-output strong') !== null"))
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('[data-role=widget]')?.disabled === false"))
  })
})

# 14 -------------------------------------------------------------------------
testthat::test_that("browser htmlwidget output is sandboxed and fetchable", {
  with_browser_server(c("# %%", "library(htmlwidgets)",
                        "tw <- htmlwidgets::createWidget(name = 'tw', x = list(message = 'hi'))", "tw"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    info <- browser_eval(ctx$session,
      "(()=>{const x=document.querySelector('.html-widget');return x?{src:x.getAttribute('src'),sandbox:x.getAttribute('sandbox'),title:x.getAttribute('title')}:null})()")
    testthat::expect_true(is.list(info) && startsWith(info$src, "/plot/"))
    testthat::expect_equal(info$sandbox, "allow-scripts")
    testthat::expect_true(is.character(info$title) && nzchar(info$title))
    fetched <- browser_eval(ctx$session, sprintf("(async()=>{const r=await fetch(%s);return r.status})()", js_json(info$src)))
    testthat::expect_equal(fetched, 200)
  })
})

# 15 -------------------------------------------------------------------------
testthat::test_that("browser table controls page, sort, filter, and copy", {
  with_browser_server(c("# %%",
                        "df <- data.frame(x = 1:100, group = paste0('g', 1:100))",
                        "df"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('[data-role=table-sort]') !== null"))
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('[data-role=table-filter]') !== null"))
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('[data-role=table-copy]') !== null"))
    testthat::expect_match(browser_eval(ctx$session,
      "document.querySelector('.table-page-label').textContent"), "1\\.\\.25 of 100")
    testthat::expect_true(click_selector(ctx$session,
      ".table-pager button:last-child"))
    wait_browser(ctx$session, function() grepl("26\\.\\.50 of 100",
      browser_eval(ctx$session,
        "document.querySelector('.table-page-label')?.textContent || ''")),
      label = "table page DOM")
    testthat::expect_true(click_selector(ctx$session,
      "[data-role=table-sort][data-column=x]"))
    wait_browser(ctx$session, function() {
      page <- cell_state(ctx$session, id)$output$page
      !is.null(page) && identical(as.character(page$sort_by), "x") &&
        grepl("\\(asc\\)", browser_eval(ctx$session,
          "document.querySelector('[data-role=table-sort][data-column=x]')?.textContent || ''"))
    }, label = "table sort")
    testthat::expect_true(click_selector(ctx$session,
      "[data-role=table-sort][data-column=x]"))
    wait_browser(ctx$session, function() {
      page <- cell_state(ctx$session, id)$output$page
      !is.null(page) && isTRUE(page$sort_desc) &&
        grepl("\\(desc\\)", browser_eval(ctx$session,
          "document.querySelector('[data-role=table-sort][data-column=x]')?.textContent || ''"))
    }, label = "table descending sort")
    testthat::expect_true(set_input(ctx$session, ".table-filter", "g99"))
    wait_browser(ctx$session, function() {
      page <- cell_state(ctx$session, id)$output$page
      !is.null(page) && identical(as.character(page$filter), "g99") &&
        as.numeric(page$nrow) == 1 &&
        grepl("g99", browser_eval(ctx$session,
          "document.querySelector('.table-preview tbody')?.textContent || ''"))
    }, label = "table filter")
  })
})

# 16 -------------------------------------------------------------------------
testthat::test_that("browser exposes worker loss while preserving edit controls", {
  with_browser_server(c("# %%", "library(alder)", "tools::pskill(Sys.getpid(), 9)"), function(ctx) {
    wait_browser(ctx$session, function() isFALSE(browser_state(ctx$session)$runtime$busy), label = "worker loss")
    wait_browser(ctx$session, function() isFALSE(browser_state(ctx$session)$runtime$worker_available), label = "worker unavailable")
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('.cm-content') !== null"))
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('[data-role=source]') !== null"))
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('[data-act=run]').disabled === true"))
  })
})
