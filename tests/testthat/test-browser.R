# Browser acceptance tests for the installed alder launcher.
#
# These tests intentionally drive the real page through Chrome. The helper
# keeps all browser-side state access in Runtime.evaluate so assertions
# exercise the same DOM and HTTP boundary as a user.

with_browser_temp <- function(root, code) {
  dir.create(root, recursive = TRUE, showWarnings = FALSE)
  old <- Sys.getenv("TMPDIR", unset = NA_character_)
  on.exit({
    if (is.na(old)) Sys.unsetenv("TMPDIR") else Sys.setenv(TMPDIR = old)
  }, add = TRUE)
  Sys.setenv(TMPDIR = root)
  force(code)
}

browser_temp_path <- function(prefix) {
  root <- if (.Platform$OS.type == "unix" && dir.exists("/tmp") &&
              file.access("/tmp", 2L) == 0L) "/tmp" else tempdir()
  tempfile(prefix, tmpdir = root)
}

browser_probe_available <- local({
  available <- NULL
  function() {
    if (!is.null(available)) return(available)
    root <- browser_temp_path("alder-chrome-probe-")
    dir.create(root, mode = "0700")
    on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)
    available <<- with_browser_temp(root, tryCatch({
      browser <- chromote::Chrome$new()
      browser$close()
      TRUE
    }, error = function(error) FALSE))
    available
  }
})

skip_browser_if_unavailable <- function() {
  testthat::skip_on_cran()
  if (!requireNamespace("chromote", quietly = TRUE)) {
    testthat::skip("browser unavailable: chromote is not installed")
  }
  if (!browser_probe_available()) {
    testthat::skip("browser unavailable: Chrome could not start")
  }
}

js_json <- function(x) jsonlite::toJSON(x, auto_unbox = TRUE, null = "null")

browser_eval <- function(session, expression) {
  result <- session$Runtime$evaluate(
    expression, returnByValue = TRUE, awaitPromise = TRUE)
  if (!is.null(result$exceptionDetails)) stop(jsonlite::toJSON(result$exceptionDetails, auto_unbox = TRUE))
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

# Hold the current client's outgoing edit commands. All receipts and events still
# come from the installed host; protocol replay/ordering is covered in clients.test.ts.
hold_browser_source_requests <- function(session) {
  browser_eval(session, r"((()=>{
    const transport = window.__alderHost.client.transport;
    const original = transport.dispatch.bind(transport);
    const gate = window.__sourceRequestGate = {
      holdEdits: true, edits: [], receipts: [], failNextEdit: false,
      release() {this.holdEdits=false;this.edits.splice(0).forEach(resolve=>resolve());},
      restore() {this.release();transport.dispatch=original;}
    };
    transport.dispatch = async command=>{
      if(command.type==='edit') {
        if(gate.holdEdits) await new Promise(resolve=>gate.edits.push(resolve));
        if(gate.failNextEdit) {gate.failNextEdit=false;throw new Error('Transport interrupted');}
      }
      const result=await original(command);
      if(command.type==='edit') gate.receipts.push(result);
      return result;
    };
    return true;
  })())")
}

# A real host configuration event exercises reconciliation without changing
# source, output, selection or notebook navigation targets.
browser_host_update <- function(session) {
  browser_eval(session, r"((async()=>{
    const client=window.__alderHost.client;
    await client.setConfig({theme:client.document.snapshot.config.theme || 'system'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return true;
  })())")
}

browser_diagnostic_snapshot <- function(session) {
  browser_eval(session, r"((()=>{
    const cell = document.querySelector('.cell');
    const notes = cell.querySelector('[data-role=diagnostics]');
    const header = document.querySelector('#editor-diagnostics');
    return {
      source: ((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(cell.dataset.cell)?.getDoc(),
      hidden: notes.hidden, text: notes.textContent,
      marked: cell.querySelectorAll('.cm-lintRange,.cm-lintPoint').length,
      statusText: document.querySelector('#status')?.textContent || '',
      headerHidden: header.hidden, headerText: header.textContent
    };
  })())")
}

wait_browser <- function(session, predicate, timeout = 15, label = "browser state") {
  deadline <- Sys.time() + timeout
  last_error <- NULL
  while (Sys.time() < deadline) {
    last <- tryCatch(predicate(), error = function(error) {
      last_error <<- conditionMessage(error)
      FALSE
    })
    if (isTRUE(last)) return(invisible(TRUE))
    Sys.sleep(0.1)
  }
  testthat::fail(paste0("timed out waiting for ", label,
    if (!is.null(last_error)) paste0(": ", last_error) else ""))
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
  editor_selector <- sub("textarea$", ".cm-content", selector)
  replace_editor_source(session, editor_selector, value)
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
    paste0(
      "(()=>{const el=document.querySelector(%s);",
      "if(!el||el.disabled)return false;el.click();return true})()"
    ),
    js_json(selector))
  isTRUE(browser_eval(session, expression))
}

pointer_click_selector <- function(session, selector) {
  point <- browser_eval(session, sprintf(paste0(
    "(()=>{const el=document.querySelector(%s);",
    "if(!el||el.disabled)return null;",
    "el.scrollIntoView({block:'center',inline:'center'});",
    "const rect=el.getBoundingClientRect();",
    "return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()"
  ), js_json(selector)))
  if (is.null(point)) return(FALSE)
  session$Page$bringToFront()
  session$Input$dispatchMouseEvent(
    type = "mouseMoved", x = point$x, y = point$y)
  session$Input$dispatchMouseEvent(
    type = "mousePressed", x = point$x, y = point$y,
    button = "left", buttons = 1L, clickCount = 1L)
  session$Input$dispatchMouseEvent(
    type = "mouseReleased", x = point$x, y = point$y,
    button = "left", buttons = 0L, clickCount = 1L)
  TRUE
}

replace_editor_source <- function(session, selector, value) {
  if (!pointer_click_selector(session, selector)) return(FALSE)
  session$Input$dispatchKeyEvent(
    type = "rawKeyDown", key = "a", code = "KeyA", modifiers = 2L,
    windowsVirtualKeyCode = 65L, nativeVirtualKeyCode = 65L
  )
  session$Input$dispatchKeyEvent(
    type = "keyUp", key = "a", code = "KeyA", modifiers = 2L,
    windowsVirtualKeyCode = 65L, nativeVirtualKeyCode = 65L
  )
  session$Input$insertText(text = value)
  TRUE
}

cell_ids <- function(session) {
  browser_eval(session, "[...document.querySelectorAll('.cell[data-cell]')].map(x => x.id)")
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

new_browser_session <- function(url, temp_root) {
  session <- with_browser_temp(file.path(temp_root, "chrome-tmp"),
    chromote::ChromoteSession$new())
  ready <- FALSE
  on.exit(if (!ready) try(session$close(), silent = TRUE), add = TRUE)
  session$Page$navigate(url)
  wait_browser(session, function() isTRUE(browser_eval(session,
    "Boolean(window.__alderHost?.client.document?.snapshot) && document.readyState !== 'loading'")),
    timeout = 30, label = "connected notebook document")
  ready <- TRUE
  session
}

stop_browser_server <- function(proc, url) {
  if (proc$is_alive()) {
    try({
      handle <- curl::new_handle(timeout = 2)
      state <- jsonlite::fromJSON(rawToChar(curl::curl_fetch_memory(
        paste0(url, "api/state"), handle)$content), simplifyVector = FALSE)
      curl::handle_setopt(handle, customrequest = "POST")
      curl::handle_setheaders(handle, "X-Alder-Shutdown-Token" = state$shutdown_token)
      curl::curl_fetch_memory(paste0(url, "api/shutdown"), handle)
    }, silent = TRUE)
    proc$wait(5000)
    if (proc$is_alive()) proc$kill_tree()
  }
  proc$wait(5000)
}

start_browser_server <- function(lines) {
  root <- browser_temp_path("alder-browser-project-")
  dir.create(root, mode = "0700")
  path <- file.path(root, "notebook.R")
  writeLines(lines, path, useBytes = TRUE)
  port <- httpuv::randomPort()
  lib <- alder_cache_lib() # nolint: object_usage_linter
  process_env <- character()
  if (nzchar(lib)) {
    existing <- Sys.getenv("R_LIBS", unset = "")
    process_env <- Sys.getenv()
    process_env[["R_LIBS"]] <- paste(
      c(lib, existing[nzchar(existing)]),
      collapse = .Platform$path.sep
    )
  }
  {
    # Exercise the primary installed lifecycle. R CMD check shadows bare
    # Rscript with a deliberate failing shim, so provide the actual runtime
    # just as the dedicated CLI acceptance helper does.
    if (!length(process_env)) process_env <- Sys.getenv()
    current_path <- unname(process_env["PATH"])
    if (is.na(current_path)) current_path <- ""
    process_env[["PATH"]] <- paste(
      c(dirname(file.path(R.home("bin"), "Rscript")),
        current_path[nzchar(current_path)]),
      collapse = .Platform$path.sep
    )
    process_env <- process_env[names(process_env) != "R_TESTS"]
    process_env[["BROWSER"]] <- "false"
    launcher <- system.file("exec",
      if (.Platform$OS.type == "windows") "alder.cmd" else "alder",
      package = "alder", mustWork = TRUE)
    command <- launcher
    args <- c("edit", path, "--no-open", "--port", as.character(port),
              "--no-idle-timeout")
    if (.Platform$OS.type == "windows") {
      command <- Sys.getenv("COMSPEC", unset = "cmd.exe")
      args <- c("/d", "/s", "/c", "call", launcher, args)
    }
  }
  proc <- processx::process$new(
    command, args, stdout = "|", stderr = "|", env = process_env
  )
  url <- sprintf("http://127.0.0.1:%d/", port)
  started <- FALSE
  on.exit(if (!started) {
    stop_browser_server(proc, url)
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  output <- character()
  deadline <- Sys.time() + 60
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
    output <- c(output, proc$read_error_lines())
    stop("launcher did not become ready: ", paste(output, collapse = " | "))
  }
  session <- new_browser_session(url, root)
  started <- TRUE
  list(root = root, path = path, port = port, proc = proc,
       session = session,
       url = sprintf("http://127.0.0.1:%d/", port))
}

with_browser_server <- function(lines, code) {
  skip_browser_if_unavailable()
  ctx <- start_browser_server(lines)
  on.exit({
    stop_browser_server(ctx$proc, ctx$url)
    try(ctx$session$close(), silent = TRUE)
    unlink(ctx$root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  force(code(ctx))
}

testthat::test_that("browser formatting save shortcut persists typing before source acknowledgement", {
  with_browser_server(c("# %%", "value <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "document.querySelector('#save').disabled")), label = "clean notebook save button")
    browser_eval(ctx$session, r"((()=>{
      window.__fastSaveRequests=[];
      window.addEventListener('alder:host-command',e=>window.__fastSaveRequests.push(e.detail.command.type));
      return true;
    })())")
    hold_browser_source_requests(ctx$session)
    browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);e.focus();",
      "e.view.dispatch({selection:{anchor:e.getDoc().length}});return true})()"
    ), js_json(id)))
    ctx$session$Input$insertText(text = "0")
    ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "s",
      code = "KeyS", modifiers = 2L,
      windowsVirtualKeyCode = 83L, nativeVirtualKeyCode = 83L)
    ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = "s",
      code = "KeyS", modifiers = 2L,
      windowsVirtualKeyCode = 83L, nativeVirtualKeyCode = 83L)
    testthat::expect_identical(cell_text(ctx$session, id), "value <- 1")
    browser_eval(ctx$session, "window.__sourceRequestGate.restore();true")
    wait_browser(ctx$session, function()
      "value <- 10" %in% readLines(ctx$path, warn = FALSE),
      timeout = 5, label = "immediate shortcut persisted local source")
    expect_true("save" %in% browser_eval(ctx$session,
      "window.__fastSaveRequests"))
  })
})

testthat::test_that("browser formatting adopts focused source and preserves selection and saves", {
  with_browser_server(c(
    "# %% [markdown]", "# Keep these notes.",
    "# %% [name=numbers]", "numbers<-c(1,2,3)",
    "# %%", "spare<-7"
  ), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    before <- browser_state(ctx$session)
    id <- before$cells[[2L]]$id
    doc <- function() browser_eval(ctx$session, sprintf(
      "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).getDoc()", js_json(id)))
    key <- function(key, code, modifiers) {
      browser_eval(ctx$session, sprintf(
        "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).focus();true", js_json(id)))
      virtual <- utf8ToInt(toupper(key))[[1L]]
      ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = key,
        code = code, modifiers = modifiers,
        windowsVirtualKeyCode = virtual, nativeVirtualKeyCode = virtual)
      ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = key,
        code = code, modifiers = modifiers,
        windowsVirtualKeyCode = virtual, nativeVirtualKeyCode = virtual)
    }
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);const at=e.getDoc().indexOf('2');",
      "e.focus();e.view.dispatch({selection:{anchor:at,head:at+1}});return true})()"
    ), js_json(id))))
    key("F", "KeyF", 10L)
    wait_browser(ctx$session, function() identical(doc(), "numbers <- c(1, 2, 3)") &&
      identical(cell_text(ctx$session, id), "numbers <- c(1, 2, 3)"),
      timeout = 30, label = "focused formatted source acknowledgement")
    testthat::expect_identical(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const v=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).view;",
      "return v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)})()"
    ), js_json(id))), "2")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).view.hasFocus", js_json(id))))
    ctx$session$Input$insertText(text = "4")
    wait_browser(ctx$session, function()
      identical(cell_text(ctx$session, id), "numbers <- c(1, 4, 3)"),
      label = "typing after format uses acknowledged revision")
    testthat::expect_false(browser_eval(ctx$session,
      "document.body.textContent.includes('changed on the server')"))
    testthat::expect_identical(cell_text(ctx$session, before$cells[[1L]]$id),
                               cell_body(before$cells[[1L]]))
    testthat::expect_identical(cell_text(ctx$session, before$cells[[3L]]$id), "spare<-7")

    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,'numbers<-c(4,5,6)')", js_json(id))))
    key("f", "KeyF", 3L)
    wait_browser(ctx$session, function() identical(doc(), "numbers <- c(4, 5, 6)"),
      timeout = 30, label = "alternate focused format shortcut")
    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    browser_eval(ctx$session,
      "document.querySelector('#settings-format-on-save').checked=true;true")
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "!document.querySelector('#settings').open && !document.querySelector('#save').disabled")),
      label = "format on save settings applied")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,'numbers<-c(7,8,9)')", js_json(id))))
    key("s", "KeyS", 2L)
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      !isTRUE(state$changed) && identical(doc(), "numbers <- c(7, 8, 9)") &&
        "numbers <- c(7, 8, 9)" %in% readLines(ctx$path, warn = FALSE)
    }, timeout = 30, label = "focused format on save visible and persisted")
    testthat::expect_true("spare <- 7" %in% readLines(ctx$path, warn = FALSE))
    testthat::expect_identical(vapply(browser_state(ctx$session)$cells, `[[`, "", "id"),
                               vapply(before$cells, `[[`, "", "id"))
    testthat::expect_identical(browser_state(ctx$session)$cells[[2L]]$options,
                               before$cells[[2L]]$options)
    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    browser_eval(ctx$session,
      "document.querySelector('#settings-autosave').checked=true;true")
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "!document.querySelector('#settings').open && !document.querySelector('#run-all').disabled")),
      label = "autosave settings applied")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,'numbers<-c(2,4,6)')", js_json(id))))
    browser_eval(ctx$session, sprintf(
      "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).focus();true", js_json(id)))
    wait_browser(ctx$session, function() !isTRUE(browser_state(ctx$session)$changed) &&
      identical(doc(), "numbers <- c(2, 4, 6)") &&
      "numbers <- c(2, 4, 6)" %in% readLines(ctx$path, warn = FALSE),
      timeout = 30, label = "focused formatted autosave visible and persisted")
  })
})

testthat::test_that("browser formatting preserves newer typing and rejects external conflicts", {
  with_browser_server(c("# %%", "value<-1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    doc <- function() browser_eval(ctx$session, sprintf(
      "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).getDoc()", js_json(id)))
    format_key <- function() {
      browser_eval(ctx$session, sprintf(
        "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).focus();true", js_json(id)))
      ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "F",
        code = "KeyF", modifiers = 10L,
        windowsVirtualKeyCode = 70L, nativeVirtualKeyCode = 70L)
      ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = "F",
        code = "KeyF", modifiers = 10L,
        windowsVirtualKeyCode = 70L, nativeVirtualKeyCode = 70L)
    }
    testthat::expect_true(browser_eval(ctx$session, r"((()=>{
      const transport=window.__alderHost.client.transport;
      window.__formatDispatch=transport.dispatch.bind(transport);
      window.__formatWaiting=false;window.__formatDelayed=false;
      transport.dispatch=async command=>{
        const result=await window.__formatDispatch(command);
        if(command.type==='format'&&!window.__formatDelayed){
          window.__formatDelayed=true;window.__formatWaiting=true;
          await new Promise(resolve=>window.__releaseFormat=resolve);
        }
        return result;
      };
      return true;
    })())"))
    format_key()
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "window.__formatWaiting")), timeout = 30, label = "format receipt held")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,'value<-9')", js_json(id))))
    testthat::expect_identical(doc(), "value<-9")
    browser_eval(ctx$session, "window.__releaseFormat();true")
    wait_browser(ctx$session, function() identical(doc(), "value<-9") &&
      identical(cell_text(ctx$session, id), "value<-9"),
      timeout = 30, label = "newer typing survives formatted acknowledgement")
    testthat::expect_false(browser_eval(ctx$session,
      "document.body.textContent.includes('changed on the server')"))

    testthat::expect_true(browser_eval(ctx$session, r"((()=>{
      window.__formatWaiting=false;
      window.__alderHost.client.transport.dispatch=async command=>{
        if(command.type==='format'){
          window.__formatWaiting=true;
          await new Promise(resolve=>window.__releaseFormat=resolve);
        }
        return window.__formatDispatch(command);
      };
      return true;
    })())"))
    format_key()
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "window.__formatWaiting")), label = "format request held before server")
    revision <- cell_state(ctx$session, id)$revision
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,'value<-10')", js_json(id))))
    testthat::expect_identical(doc(), "value<-10")
    response <- browser_eval(ctx$session, sprintf(paste0(
      "(async()=>{const r=await fetch('/api/cell',{method:'POST',",
      "headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'edit',",
      "id:%s,body:['value<-42'],type:'code',expected_revision:%s})});return r.status})()"
    ), js_json(id), js_json(revision)))
    testthat::expect_equal(response, 200)
    browser_eval(ctx$session, "window.__releaseFormat();true")
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session, paste0(
      "document.body.textContent.includes('changed on the server') && ",
      "document.querySelector('[data-recovery]') !== null"
    ))), label = "external format conflict and recovery control visible")
    testthat::expect_identical(doc(), "value<-10")
    testthat::expect_identical(cell_text(ctx$session, id), "value<-42")
    testthat::expect_true(browser_eval(ctx$session,
      "document.body.textContent.includes('Use server version')"))
    browser_eval(ctx$session, "window.__alderHost.client.transport.dispatch=window.__formatDispatch;true")
  })
})

testthat::test_that("browser keyboard help survives host events and cancels obsolete requests", {
  with_browser_server(c("# %%", "mean(1:10)"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    press <- function(key, code, virtual, modifiers = 0L) {
      ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = key, code = code,
        modifiers = modifiers, windowsVirtualKeyCode = virtual,
        nativeVirtualKeyCode = virtual)
      ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = key, code = code,
        modifiers = modifiers, windowsVirtualKeyCode = virtual,
        nativeVirtualKeyCode = virtual)
    }
    focus_mean <- function() {
      testthat::expect_true(pointer_click_selector(ctx$session, ".cell .cm-content"))
      press("Home", "Home", 36L)
      press("ArrowRight", "ArrowRight", 39L)
      press("ArrowRight", "ArrowRight", 39L)
      ctx$session$Input$dispatchMouseEvent(type = "mouseMoved", x = 2, y = 2)
    }
    testthat::expect_true(browser_eval(ctx$session, r"((()=>{
      const original = window.fetch.bind(window);
      const gate = window.__keyboardHelpGate = {rows: [],
        release(index) {const row=this.rows[index];row.resolve();},
        restore() {this.rows.forEach(row=>row.resolve());window.fetch=original;}
      };
      window.fetch = async(input, options)=>{
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        const params = options?.body ? JSON.parse(options.body) : null;
        const response = await original(input, options);
        if (path === '/api/lsp' && params?.method === 'textDocument/hover' && response.ok) {
          const value = await response.clone().json();
          const row = {position: params.params.position, value, status: response.status,
            delivered: false};
          await new Promise(resolve=>{row.resolve=resolve;gate.rows.push(row);});
          row.delivered = true;
        }
        return response;
      };
      return true;
    })())"))
    on.exit(browser_eval(ctx$session, "window.__keyboardHelpGate?.restore()"), add = TRUE)
    help_visible <- function() isTRUE(browser_eval(ctx$session, paste0(
      "document.activeElement?.matches('.cm-alder-hover-content') && ",
      "document.querySelector('.cm-alder-hover-content')?.textContent.includes('Arithmetic Mean')"
    )))
    no_help <- function() isTRUE(browser_eval(ctx$session,
      "document.querySelector('.cm-alder-hover') === null"))
    begin_help <- function() {
      focus_mean()
      index <- browser_eval(ctx$session, "window.__keyboardHelpGate.rows.length")
      press("F1", "F1", 112L)
      wait_browser(ctx$session, function() browser_eval(ctx$session, sprintf(
        "window.__keyboardHelpGate.rows.length > %d", index)),
        timeout = 45, label = "held completed keyboard help response")
      testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
        "(()=>{const row=window.__keyboardHelpGate.rows[%d];return row.status===200&&",
        "row.position.character===2&&JSON.stringify(row.value).includes('Arithmetic Mean')})()"
      ), index)))
      index
    }
    wait_updates <- function() {
      browser_host_update(ctx$session)
      browser_host_update(ctx$session)
    }
    release_help <- function(index) browser_eval(ctx$session, sprintf(
      "window.__keyboardHelpGate.release(%d)", index))

    first <- begin_help()
    wait_updates()
    release_help(first)
    wait_browser(ctx$session, help_visible, label = "F1 survives unchanged-source host events")
    testthat::expect_identical(browser_eval(ctx$session, sprintf(
      "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).getDoc()", js_json(id))), "mean(1:10)")
    press("Escape", "Escape", 27L)
    wait_browser(ctx$session, no_help, label = "keyboard help closed before cancellation cases")

    for (cancel in c("Escape", "selection", "blur", "source")) {
      held <- begin_help()
      if (cancel == "Escape") press("Escape", "Escape", 27L)
      if (cancel == "selection") press("ArrowRight", "ArrowRight", 39L)
      if (cancel == "blur") {
        testthat::expect_true(pointer_click_selector(ctx$session, "#settings-open"))
      }
      if (cancel == "source") ctx$session$Input$insertText(text = "x")
      focused <- browser_eval(ctx$session,
        "document.activeElement?.id || document.activeElement?.className || ''")
      release_help(held)
      wait_updates()
      testthat::expect_true(no_help(), info = paste("cancel keyboard help by", cancel))
      testthat::expect_identical(browser_eval(ctx$session,
        "document.activeElement?.id || document.activeElement?.className || ''"),
        focused, info = paste("preserve focus after", cancel))
      if (cancel == "blur") {
        testthat::expect_true(pointer_click_selector(ctx$session, "#settings-cancel"))
      }
    }
    testthat::expect_identical(browser_eval(ctx$session, sprintf(
      "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).getDoc()", js_json(id))), "mexan(1:10)")
  })
})

testthat::test_that("browser R help is bounded and supports keyboard access", {
  with_browser_server(c("# %%", "mean(1:10)"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    ctx$session$Emulation$setDeviceMetricsOverride(width = 1440L, height = 900L,
      deviceScaleFactor = 1, mobile = FALSE)
    focus_symbol <- function() browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);",
      "e.view.dispatch({selection:{anchor:2}});e.focus();",
      "const p=e.view.coordsAtPos(2);return {x:p.left+2,y:(p.top+p.bottom)/2}})()"
    ), js_json(id)))
    press <- function(key, code, virtual) {
      ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = key, code = code,
        windowsVirtualKeyCode = virtual, nativeVirtualKeyCode = virtual)
      ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = key, code = code,
        windowsVirtualKeyCode = virtual, nativeVirtualKeyCode = virtual)
    }
    point <- focus_symbol()
    ctx$session$Input$dispatchMouseEvent(type = "mouseMoved", x = point$x, y = point$y)
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session, paste0(
      "(()=>{const d=document.querySelector('.cm-alder-hover-content');return !!d&&",
      "d.textContent.includes('Arithmetic Mean')&&!!d.querySelector('h3')&&",
      "!!d.querySelector('pre code')&&!!d.querySelector('table')})()"
    ))), timeout = 45, label = "native rendered R documentation")
    bounds <- function() browser_eval(ctx$session, paste0(
      "(()=>{const d=document.querySelector('.cm-alder-hover');",
      "const c=d?.querySelector('.cm-alder-hover-content');if(!c)return false;",
      "const r=d.getBoundingClientRect();return r.width<=Math.min(600,innerWidth-32)+1&&",
      "r.height<=481&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&",
      "r.bottom<=innerHeight+1&&c.scrollHeight>c.clientHeight})()"
    ))
    testthat::expect_true(bounds())
    press("Escape", "Escape", 27L)
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "document.querySelector('.cm-alder-hover')===null")), label = "hover Escape dismissal")
    focus_symbol()
    press("F1", "F1", 112L)
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "document.activeElement?.matches('.cm-alder-hover-content')")),
      timeout = 30, label = "F1 focuses help contents")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "document.querySelector('.cm-alder-hover')?.getAttribute('role')==='dialog'&&",
      "document.querySelector('.cm-alder-hover')?.getAttribute('aria-label')==='R documentation'"
    )))
    press("PageDown", "PageDown", 34L)
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "document.querySelector('.cm-alder-hover-content')?.scrollTop>0")),
      label = "keyboard scrolls full R help")
    press("Escape", "Escape", 27L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell||''"), id),
      label = "help Escape returns to source")
    ctx$session$Emulation$setDeviceMetricsOverride(width = 390L, height = 844L,
      deviceScaleFactor = 1, mobile = FALSE)
    if (isFALSE(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel').hidden"))) {
      testthat::expect_true(pointer_click_selector(ctx$session, "#panel-close"))
    }
    focus_symbol()
    press("F1", "F1", 112L)
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "document.activeElement?.matches('.cm-alder-hover-content')")),
      timeout = 30, label = "narrow keyboard help")
    testthat::expect_true(bounds())
    testthat::expect_true(pointer_click_selector(ctx$session,
      ".cm-alder-hover [aria-label='Close R documentation']"))
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell||''"), id),
      label = "Close help returns to source")
    testthat::expect_identical(cell_text(ctx$session, id), "mean(1:10)")
  })
})

testthat::test_that("browser formatting preserves selection through quote changes in both directions", {
  with_browser_server(c("# %%", "label<-'sample'"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    for (forward in c(TRUE, FALSE)) {
      testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
        "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);e.setDoc(\"label<-'sample'\");",
        "const at=e.getDoc().indexOf('sample');e.focus();",
        "e.view.dispatch({selection:{anchor:%s?at:at+6,head:%s?at+6:at}});return true})()"
      ), js_json(id), js_json(forward), js_json(forward))))
      ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "F",
        code = "KeyF", modifiers = 10L,
        windowsVirtualKeyCode = 70L, nativeVirtualKeyCode = 70L)
      ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = "F",
        code = "KeyF", modifiers = 10L,
        windowsVirtualKeyCode = 70L, nativeVirtualKeyCode = 70L)
      wait_browser(ctx$session, function() {
        source <- browser_eval(ctx$session, sprintf(
          "((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).getDoc()", js_json(id)))
        !identical(source, "label<-'sample'") &&
          identical(source, cell_text(ctx$session, id))
      }, timeout = 30, label = "formatted string selection source")
      selection <- browser_eval(ctx$session, sprintf(paste0(
        "(()=>{const v=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s).view,s=v.state.selection.main;",
        "return {text:v.state.sliceDoc(s.from,s.to),anchor:s.anchor,head:s.head,focused:v.hasFocus}})()"
      ), js_json(id)))
      testthat::expect_identical(selection$text, "sample")
      testthat::expect_identical(selection$anchor < selection$head, forward)
      testthat::expect_true(selection$focused)
    }
  })
})

testthat::test_that("browser add-below preserves DOM and server order", {
  with_browser_server(character(), function(ctx) {
    wait_browser(ctx$session, function() {
      length(cell_ids(ctx$session)) == 0L && browser_eval(
        ctx$session,
        "document.querySelector('.empty-bar [data-type=code]') !== null"
      )
    }, label = "empty notebook controls")
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

testthat::test_that("browser Move Up then Move Down restores cell order", {
  with_browser_server(c("# %%", "1", "# %%", "2", "# %%", "3"), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    original <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
    middle <- original[[2L]]
    testthat::expect_true(click_selector(ctx$session,
      sprintf("#cell-%s [data-act=move-up]", middle)))
    moved <- c(middle, original[[1L]], original[[3L]])
    wait_browser(ctx$session, function() {
      state_order <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
      dom_order <- sub("^cell-", "", cell_ids(ctx$session))
      identical(state_order, moved) && identical(dom_order, moved)
    }, label = "Move Up order")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector('#cell-%s [data-act=move-down]')?.disabled === false",
      middle
    )))
    testthat::expect_true(click_selector(ctx$session,
      sprintf("#cell-%s [data-act=move-down]", middle)))
    wait_browser(ctx$session, function() {
      state_order <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
      dom_order <- sub("^cell-", "", cell_ids(ctx$session))
      identical(state_order, original) && identical(dom_order, original)
    }, label = "Move Down restored order")
  })
})

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
    testthat::expect_identical(browser_eval(ctx$session,
      sprintf("((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))('%s')?.getDoc()", id)),
      "# **bold**")
  })
})

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

testthat::test_that("browser preserves focused source across host updates", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    source_id <- browser_eval(ctx$session,
      "(()=>{const x=document.querySelector('.cm-content');x.focus();return x.closest('.cell')?.id})()")
    testthat::expect_true(is.character(source_id) && nzchar(source_id))
    browser_host_update(ctx$session)
    active <- browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.id || null")
    testthat::expect_equal(active, source_id)
  })
})

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


# 5b -------------------------------------------------------------------------
testthat::test_that("browser initializes a non-zero-min slider to its spec and accepts drags", {
  with_browser_server(c("# %%", "library(alder)",
                        "# %%", "min_wt <- ui$slider(1, 8, value = 3, label = \"min\")", "min_wt"), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    id <- browser_state(ctx$session)$cells[[2L]]$id
    selector <- sprintf("#widget-%s-slider", id)
    min_attr <- browser_eval(ctx$session, sprintf("document.querySelector('%s')?.min", selector))
    max_attr <- browser_eval(ctx$session, sprintf("document.querySelector('%s')?.max", selector))
    val_attr <- browser_eval(ctx$session, sprintf("document.querySelector('%s')?.value", selector))
    testthat::expect_equal(min_attr, "1")
    testthat::expect_equal(max_attr, "8")
    testthat::expect_equal(val_attr, "3")
    testthat::expect_true(set_input(ctx$session, selector, "5", "input"))
    wait_idle(ctx$session)
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, id)
      isTRUE(as.numeric(cell$output$spec$value) == 5)
    }, label = "non-zero-min slider commit")
    testthat::expect_equal(as.numeric(cell_state(ctx$session, id)$output$spec$value), 5)
  })
})

testthat::test_that("browser keeps layout widgets synchronized, repeatable, and keyed", {
  with_browser_server(c(
    "# %%", "library(alder)",
    "# %%", "h_slider <- ui$slider(1, 9, value = 2, step = 1, label = 'H slider')",
    "h_run <- ui$run_button(label = 'H run')",
    "out$hstack(h_slider, h_run)",
    "# %%", "sprintf('H_RESULT=%d', h_slider$value * 10)",
    "# %%", paste0(
      "sprintf('H_ACTION=%s stamp=%.6f', h_run$value, ",
      "as.numeric(Sys.time()))"
    ),
    "# %%", "v_slider <- ui$slider(0, 1, value = 0, step = 1)",
    "v_check <- ui$checkbox(FALSE)",
    "v_number <- ui$number(value = 5, min = 0, max = 10)",
    "out$vstack(v_slider, v_check, v_number)",
    "# %%", "if (v_slider$value == 1) stop('EXPECTED_LAYOUT_ERROR')",
    "sprintf('V_RESULT=%d/%s/%d', v_slider$value, v_check$value, v_number$value)",
    "# %%", "t_slider <- ui$slider(10, 20, value = 12, step = 1)",
    "t_run <- ui$run_button(label = 'Tab run')",
    "out$tabs(Slider = t_slider, Action = t_run)",
    "# %%", "sprintf('TAB_RESULT=%d/%s', t_slider$value, t_run$value)",
    "# %%", "c_slider <- ui$slider(100, 110, value = 103, step = 1)",
    "c_range <- ui$range_slider(100, 110, value = c(102, 108), step = 1)",
    "out$vstack(out$callout(c_slider), c_range)",
    "# %%", "sprintf('CALLOUT_RESULT=%d/%d-%d', c_slider$value,",
    "c_range$value[[1]], c_range$value[[2]])",
    "# %%", "a_slider <- ui$slider(30, 40, value = 32, step = 1)",
    "out$accordion(Control = a_slider, Evidence = out$md('Accordion note'))",
    "# %%", "sprintf('ACCORDION_RESULT=%d', a_slider$value)",
    "# %%", "s_check <- ui$checkbox(FALSE, label = 'Sidebar check')",
    "out$sidebar(s_check, out$md('Sidebar note'))",
    "# %%", "sprintf('SIDEBAR_RESULT=%s', s_check$value)"
  ), function(ctx) {
    wait_cells_done(ctx$session, 14L)
    state <- browser_state(ctx$session)
    ids <- vapply(state$cells, `[[`, "", "id")
    selector <- function(name) sprintf(
      "[data-role=widget][data-name=%s]", js_json(name))

    testthat::expect_true(browser_eval(ctx$session, paste0(
      "window.__layoutTrustedClicks=[];",
      "document.addEventListener('click',event=>{",
      "const target=event.target;window.__layoutTrustedClicks.push({",
      "trusted:event.isTrusted,name:target?.dataset?.name||'',",
      "accordion:!!target?.matches?.('.out-accordion-btn')});},true);true"
    )))

    initial <- browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const scalar=document.querySelector(%s);",
      "const range=[...document.querySelectorAll(%s)];return{",
      "scalar:{value:scalar?.value,min:scalar?.min,max:scalar?.max},",
      "range:range.map(node=>({value:node.value,min:node.min,max:node.max}))}})()"
    ), js_json(selector("c_slider")), js_json(selector("c_range"))))
    testthat::expect_equal(initial$scalar$value, "103")
    testthat::expect_equal(initial$scalar$min, "100")
    testthat::expect_equal(initial$scalar$max, "110")
    testthat::expect_equal(
      vapply(initial$range, `[[`, "", "value"), c("102", "108"))
    testthat::expect_true(all(vapply(
      initial$range, function(value) identical(value$min, "100") &&
        identical(value$max, "110"), logical(1)
    )))

    h_selector <- selector("h_slider")
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const node=document.querySelector(%s);window.__layoutSlider=node;",
      "node.focus();return document.activeElement===node})()"
    ), js_json(h_selector))))
    ctx$session$Input$dispatchKeyEvent(
      type = "rawKeyDown", key = "ArrowRight", code = "ArrowRight",
      windowsVirtualKeyCode = 39L, nativeVirtualKeyCode = 39L
    )
    ctx$session$Input$dispatchKeyEvent(
      type = "keyUp", key = "ArrowRight", code = "ArrowRight",
      windowsVirtualKeyCode = 39L, nativeVirtualKeyCode = 39L
    )
    wait_browser(ctx$session, function() {
      body <- browser_eval(ctx$session, "document.body.innerText")
      grepl("H_RESULT=30", body, fixed = TRUE) &&
        isTRUE(browser_eval(ctx$session, sprintf(paste0(
          "document.querySelector(%s)===window.__layoutSlider&&",
          "document.activeElement===window.__layoutSlider&&",
          "window.__layoutSlider.dataset.value==='3'"
        ), js_json(h_selector)))) && isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "focused hstack slider settlement")
    Sys.sleep(1.1)
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "document.querySelector(%s)===window.__layoutSlider&&",
      "document.activeElement===window.__layoutSlider"
    ), js_json(h_selector))))

    h_run_selector <- selector("h_run")
    run_action <- function(previous = NULL) {
      testthat::expect_true(pointer_click_selector(ctx$session, h_run_selector))
      wait_browser(ctx$session, function() {
        text <- cell_state(ctx$session, ids[[4L]])$output$text
        reset <- isTRUE(browser_eval(ctx$session, sprintf(paste0(
          "(()=>{const node=document.querySelector(%s);return ",
          "node?.dataset.value==='false'&&!node.disabled})()"
        ), js_json(h_run_selector))))
        grepl("H_ACTION=TRUE", text, fixed = TRUE) && reset &&
          isFALSE(browser_state(ctx$session)$runtime$busy) &&
          (is.null(previous) || !identical(text, previous))
      }, label = "repeatable hstack run button")
      cell_state(ctx$session, ids[[4L]])$output$text
    }
    first_action <- run_action()
    Sys.sleep(0.01)
    second_action <- run_action(first_action)
    testthat::expect_false(identical(first_action, second_action))

    v_selector <- selector("v_slider")
    testthat::expect_true(set_input(ctx$session, v_selector, "1", "input"))
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, ids[[6L]])
      identical(cell$status, "error") && grepl(
        "EXPECTED_LAYOUT_ERROR", paste(cell$log, collapse = "\n"), fixed = TRUE
      ) && isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "visible vstack dependent error")
    testthat::expect_true(set_input(ctx$session, v_selector, "0", "input"))
    wait_browser(ctx$session, function() {
      cell <- cell_state(ctx$session, ids[[6L]])
      identical(cell$status, "done") && grepl(
        "V_RESULT=0/FALSE/5", cell$output$text, fixed = TRUE
      ) && isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "vstack dependent recovery")

    number_selector <- selector("v_number")
    testthat::expect_true(set_input(
      ctx$session, number_selector, "99", "input"))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      widget <- cell_state(ctx$session, ids[[5L]])$output$children[[3L]]
      identical(widget$operation$status, "error") &&
        !is.null(state$last_action_error) &&
        isTRUE(browser_eval(ctx$session, sprintf(paste0(
          "(()=>{const node=document.querySelector(%s);return ",
          "node?.value==='5'&&!node.disabled})()"
        ), js_json(number_selector))))
    }, label = "nested widget error rollback and unlock")
    testthat::expect_true(set_input(
      ctx$session, number_selector, "6", "input"))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      grepl("V_RESULT=0/FALSE/6",
            cell_state(ctx$session, ids[[6L]])$output$text, fixed = TRUE) &&
        is.null(state$last_action_error) &&
        isFALSE(state$runtime$busy)
    }, label = "nested widget recovery after error")

    tabs_cell <- sprintf("#cell-%s", ids[[7L]])
    testthat::expect_true(pointer_click_selector(
      ctx$session, paste0(tabs_cell, " .out-tab-btn:nth-child(2)")))
    t_run_selector <- selector("t_run")
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf(
        "document.querySelector(%s)?.getClientRects().length>0",
        js_json(t_run_selector)
      )
    )), label = "visible action tab")
    testthat::expect_true(pointer_click_selector(ctx$session, t_run_selector))
    wait_browser(ctx$session, function() {
      text <- cell_state(ctx$session, ids[[8L]])$output$text
      visible <- browser_eval(ctx$session, sprintf(
        "document.querySelector(%s)?.getClientRects().length>0",
        js_json(t_run_selector)
      ))
      grepl("TAB_RESULT=12/TRUE", text, fixed = TRUE) && isTRUE(visible) &&
        isTRUE(browser_eval(ctx$session, sprintf(paste0(
          "(()=>{const node=document.querySelector(%s);return ",
          "node?.dataset.value==='false'&&!node.disabled})()"
        ), js_json(t_run_selector))))
    }, label = "hidden-tab run button reset without tab loss")
    testthat::expect_true(pointer_click_selector(
      ctx$session, paste0(tabs_cell, " .out-tab-btn:nth-child(1)")))
    testthat::expect_true(set_input(
      ctx$session, selector("t_slider"), "15", "input"))
    wait_browser(ctx$session, function() grepl(
      "TAB_RESULT=15/FALSE",
      cell_state(ctx$session, ids[[8L]])$output$text,
      fixed = TRUE
    ), label = "visible slider tab update")

    accordion_cell <- sprintf("#cell-%s", ids[[11L]])
    accordion_button <- paste0(
      accordion_cell, " .out-accordion-btn:nth-child(1)")
    accordion_slot <- paste0(
      accordion_cell, " .out-layout-child[data-index='0']")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector(%s)?.hidden===true", js_json(accordion_slot)
    )))
    testthat::expect_true(pointer_click_selector(
      ctx$session, accordion_button))
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf(
        "document.querySelector(%s)?.hidden===false", js_json(accordion_slot)
      )
    )), label = "accordion expansion")
    a_selector <- selector("a_slider")
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const slot=document.querySelector(%s);",
      "const widget=document.querySelector(%s);",
      "window.__accordionSlot=slot;window.__accordionWidget=widget;",
      "widget.focus();return document.activeElement===widget})()"
    ), js_json(accordion_slot), js_json(a_selector))))
    ctx$session$Input$dispatchKeyEvent(
      type = "rawKeyDown", key = "ArrowRight", code = "ArrowRight",
      windowsVirtualKeyCode = 39L, nativeVirtualKeyCode = 39L)
    ctx$session$Input$dispatchKeyEvent(
      type = "keyUp", key = "ArrowRight", code = "ArrowRight",
      windowsVirtualKeyCode = 39L, nativeVirtualKeyCode = 39L)
    wait_browser(ctx$session, function() {
      grepl("ACCORDION_RESULT=33",
            cell_state(ctx$session, ids[[12L]])$output$text, fixed = TRUE) &&
        isTRUE(browser_eval(ctx$session, sprintf(paste0(
          "document.querySelector(%s)===window.__accordionSlot&&",
          "window.__accordionSlot.hidden===false&&",
          "document.querySelector(%s)===window.__accordionWidget&&",
          "document.activeElement===window.__accordionWidget"
        ), js_json(accordion_slot), js_json(a_selector)))) &&
        isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "expanded accordion widget settlement")
    Sys.sleep(1.1)
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "document.querySelector(%s)===window.__accordionSlot&&",
      "window.__accordionSlot.hidden===false&&",
      "document.querySelector(%s)===window.__accordionWidget"
    ), js_json(accordion_slot), js_json(a_selector))))

    s_selector <- selector("s_check")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector(%s)?.closest('.out-sidebar')!==null",
      js_json(s_selector)
    )))
    testthat::expect_true(pointer_click_selector(ctx$session, s_selector))
    wait_browser(ctx$session, function() {
      grepl("SIDEBAR_RESULT=TRUE",
            cell_state(ctx$session, ids[[14L]])$output$text, fixed = TRUE) &&
        isTRUE(browser_eval(ctx$session, sprintf(
          "document.querySelector(%s)?.dataset.value==='true'",
          js_json(s_selector)
        ))) && isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "sidebar checkbox settlement")

    trusted <- browser_eval(ctx$session, "window.__layoutTrustedClicks")
    testthat::expect_true(any(vapply(trusted, function(event) {
      isTRUE(event$trusted) && identical(event$name, "h_run")
    }, logical(1))))
    testthat::expect_true(any(vapply(trusted, function(event) {
      isTRUE(event$trusted) && identical(event$name, "t_run")
    }, logical(1))))
    testthat::expect_true(any(vapply(trusted, function(event) {
      isTRUE(event$trusted) && identical(event$name, "s_check")
    }, logical(1))))
    testthat::expect_true(any(vapply(trusted, function(event) {
      isTRUE(event$trusted) && isTRUE(event$accordion)
    }, logical(1))))

    testthat::expect_true(click_selector(ctx$session, "#app-mode"))
    wait_browser(ctx$session, function() {
      grepl("view=app", browser_eval(ctx$session, "location.search"),
            fixed = TRUE) &&
        isTRUE(browser_eval(ctx$session, sprintf(
          "document.querySelector(%s) !== null", js_json(h_selector)
        ))) && isTRUE(browser_eval(ctx$session,
          "document.querySelector('.cm-editor') === null"))
    }, label = "output-only app layout widgets")
    testthat::expect_true(set_input(ctx$session, h_selector, "4", "input"))
    wait_browser(ctx$session, function() {
      grepl("H_RESULT=40", browser_eval(ctx$session, "document.body.innerText"),
            fixed = TRUE) && isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "app-mode nested widget update")
  })
})

testthat::test_that("browser layouts expose unique linked accessible controls", {
  with_browser_server(c(
    "# %%", "library(alder)",
    "# %%", "one <- ui$slider(0, 10, value = 2)",
    "out$tabs(Control = one, Notes = out$md('One notes'))",
    "# %%", "two <- ui$slider(0, 10, value = 4)",
    "out$tabs(Control = two, Notes = out$md('Two notes'))",
    "# %%", "three <- ui$checkbox(FALSE)",
    "out$accordion(Control = three, Notes = out$md('Three notes'))",
    "# %%", "four <- ui$checkbox(FALSE)",
    "out$accordion(Control = four, Notes = out$md('Four notes'))"
  ), function(ctx) {
    wait_cells_done(ctx$session, 5L)
    ids <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
    snapshot <- function() browser_eval(ctx$session, paste0(
      "(()=>{const groups=[...document.querySelectorAll(",
      "'.out-layout.out-tabs,.out-layout.out-accordion')];",
      "return groups.map(group=>{const layout=",
      "group.classList.contains('out-tabs')?'tabs':'accordion';",
      "const bar=group.querySelector(`:scope > .out-${layout}`);",
      "const controls=[...bar.querySelectorAll(':scope > button')];",
      "const panels=[...group.querySelectorAll(':scope > .out-layout-child')];",
      "return{layout,controlRole:bar.getAttribute('role'),",
      "controls:controls.map(node=>({id:node.id,role:node.getAttribute('role'),",
      "target:node.getAttribute('aria-controls'),",
      "selected:node.getAttribute('aria-selected'),",
      "expanded:node.getAttribute('aria-expanded')})),",
      "panels:panels.map(node=>({id:node.id,role:node.getAttribute('role'),",
      "labelledby:node.getAttribute('aria-labelledby'),hidden:node.hidden}))}})})()"
    ))
    assert_accessible <- function(groups) {
      controls <- unlist(lapply(groups, `[[`, "controls"), recursive = FALSE)
      panels <- unlist(lapply(groups, `[[`, "panels"), recursive = FALSE)
      ids <- c(vapply(controls, `[[`, "", "id"),
               vapply(panels, `[[`, "", "id"))
      testthat::expect_true(all(nzchar(ids)))
      testthat::expect_identical(anyDuplicated(ids), 0L)
      for (group in groups) {
        testthat::expect_true(all(vapply(seq_along(group$controls),
          function(index) {
            identical(group$controls[[index]]$target,
                      group$panels[[index]]$id) &&
              identical(group$panels[[index]]$labelledby,
                        group$controls[[index]]$id)
          }, logical(1))))
        if (identical(group$layout, "tabs")) {
          testthat::expect_identical(group$controlRole, "tablist")
          testthat::expect_true(all(vapply(group$controls, function(control) {
            identical(control$role, "tab") &&
              control$selected %in% c("true", "false")
          }, logical(1))))
          testthat::expect_true(all(vapply(group$panels, function(panel) {
            identical(panel$role, "tabpanel")
          }, logical(1))))
        } else {
          testthat::expect_true(all(vapply(seq_along(group$controls),
            function(index) {
              expanded <- identical(
                group$controls[[index]]$expanded, "true")
              identical(expanded, !isTRUE(group$panels[[index]]$hidden))
            }, logical(1))))
        }
      }
    }

    assert_accessible(snapshot())
    first_tab <- sprintf(
      "#cell-%s .out-tab-btn:nth-child(1)", ids[[2L]])
    second_tab <- sprintf(
      "#cell-%s .out-tab-btn:nth-child(2)", ids[[2L]])
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{window.__layoutTabKeys=[];",
      "document.addEventListener('keydown',event=>{",
      "if(event.target?.matches?.('.out-tab-btn'))",
      "window.__layoutTabKeys.push({key:event.key,trusted:event.isTrusted,",
      "prevented:event.defaultPrevented})});",
      "const first=document.querySelector(%s);first.focus();",
      "return document.activeElement===first})()"
    ), js_json(first_tab))))
    ctx$session$Input$dispatchKeyEvent(
      type = "rawKeyDown", key = "ArrowRight", code = "ArrowRight",
      windowsVirtualKeyCode = 39L, nativeVirtualKeyCode = 39L)
    ctx$session$Input$dispatchKeyEvent(
      type = "keyUp", key = "ArrowRight", code = "ArrowRight",
      windowsVirtualKeyCode = 39L, nativeVirtualKeyCode = 39L)
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf(paste0(
        "document.querySelector(%s)?.getAttribute('aria-selected')==='true'&&",
        "document.activeElement===document.querySelector(%s)"
      ), js_json(second_tab), js_json(second_tab))
    )), label = "trusted ArrowRight tab selection")
    ctx$session$Input$dispatchKeyEvent(
      type = "rawKeyDown", key = "ArrowLeft", code = "ArrowLeft",
      windowsVirtualKeyCode = 37L, nativeVirtualKeyCode = 37L)
    ctx$session$Input$dispatchKeyEvent(
      type = "keyUp", key = "ArrowLeft", code = "ArrowLeft",
      windowsVirtualKeyCode = 37L, nativeVirtualKeyCode = 37L)
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf(paste0(
        "document.querySelector(%s)?.getAttribute('aria-selected')==='true'&&",
        "document.activeElement===document.querySelector(%s)"
      ), js_json(first_tab), js_json(first_tab))
    )), label = "trusted ArrowLeft tab selection")
    tab_keys <- browser_eval(ctx$session, "window.__layoutTabKeys")
    testthat::expect_identical(
      vapply(tab_keys, `[[`, "", "key"), c("ArrowRight", "ArrowLeft"))
    testthat::expect_true(all(vapply(tab_keys, function(event) {
      isTRUE(event$trusted) && isTRUE(event$prevented)
    }, logical(1))))

    testthat::expect_true(pointer_click_selector(
      ctx$session,
      sprintf("#cell-%s .out-tab-btn:nth-child(2)", ids[[3L]])))
    testthat::expect_true(pointer_click_selector(
      ctx$session,
      sprintf("#cell-%s .out-accordion-btn:nth-child(1)", ids[[4L]])))
    wait_browser(ctx$session, function() {
      groups <- snapshot()
      tabs <- groups[vapply(
        groups, function(group) identical(group$layout, "tabs"), logical(1))]
      accordions <- groups[vapply(
        groups, function(group) identical(group$layout, "accordion"),
        logical(1))]
      identical(tabs[[2L]]$controls[[2L]]$selected, "true") &&
        isFALSE(tabs[[2L]]$panels[[2L]]$hidden) &&
        identical(accordions[[1L]]$controls[[1L]]$expanded, "true") &&
        isFALSE(accordions[[1L]]$panels[[1L]]$hidden)
    }, label = "accessible layout state")
    assert_accessible(snapshot())
  })
})

testthat::test_that("browser preserves trusted slider focus and identity across host updates", {
  with_browser_server(c(
    "# %%", "library(alder)",
    "# %%", "min_length <- ui$slider(1, 8, value = 3, label = 'Minimum length')",
    "min_length",
    "# %%", "sum(iris$Sepal.Length >= min_length$value)",
    "# %%", "plot(iris$Sepal.Length[iris$Sepal.Length >= min_length$value])"
  ), function(ctx) {
    plot_responses <- list()
    ctx$session$Network$enable()
    ctx$session$Network$responseReceived(function(params) {
      response <- params$response
      if (grepl("/plot/", response$url %||% "", fixed = TRUE)) {
        plot_responses[[length(plot_responses) + 1L]] <<- list(
          url = response$url, status = response$status
        )
      }
    })
    wait_cells_done(ctx$session, 4L)
    state <- browser_state(ctx$session)
    widget_id <- state$cells[[2L]]$id
    dependent_id <- state$cells[[3L]]$id
    plot_id <- state$cells[[4L]]$id
    selector <- sprintf("#widget-%s-slider", widget_id)
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const node=document.querySelector(%s);if(!node)return false;",
      "window.__alderSliderNode=node;window.__alderSliderEvents=[];",
      "window.__alderPlotErrors=[];document.addEventListener('error',event=>{",
      "if(event.target?.matches?.('img.plot'))",
      "window.__alderPlotErrors.push(event.target.getAttribute('src'))},true);",
      "for(const type of ['keydown','keyup','input','change','blur'])",
      "node.addEventListener(type,event=>window.__alderSliderEvents.push({",
      "type:event.type,key:event.key||'',trusted:event.isTrusted,value:node.value}));",
      "node.focus();return document.activeElement===node})()"
    ), js_json(selector))))

    # Unrelated host events must not replace the native control or
    # steal its focus before a scientist presses the next key.
    browser_host_update(ctx$session)
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector(%s)===window.__alderSliderNode && document.activeElement===window.__alderSliderNode",
      js_json(selector))))

    press_slider_key <- function(key, code, virtual_key) {
      ctx$session$Input$dispatchKeyEvent(
        type = "rawKeyDown", key = key, code = code,
        windowsVirtualKeyCode = virtual_key,
        nativeVirtualKeyCode = virtual_key
      )
      ctx$session$Input$dispatchKeyEvent(
        type = "keyUp", key = key, code = code,
        windowsVirtualKeyCode = virtual_key,
        nativeVirtualKeyCode = virtual_key
      )
    }
    committed <- function(value, rows) {
      wait_browser(ctx$session, function() {
        widget <- cell_state(ctx$session, widget_id)$output
        dependent <- cell_state(ctx$session, dependent_id)$output
        plot <- cell_state(ctx$session, plot_id)$output
        isTRUE(as.numeric(widget$spec$value) == value) &&
          identical(dependent$kind, "text") &&
          grepl(sprintf("\\[1\\] %d", rows), dependent$text) &&
          identical(plot$kind, "image") &&
          isFALSE(browser_state(ctx$session)$runtime$busy)
      }, label = sprintf("trusted slider value %d", value))
      testthat::expect_true(browser_eval(ctx$session, sprintf(
        "document.querySelector(%s)===window.__alderSliderNode && document.activeElement===window.__alderSliderNode && !window.__alderSliderNode.disabled",
        js_json(selector))))
    }

    # The first pair is deliberately faster than a host round trip so the
    # second value exercises the in-flight coalescer without losing focus.
    press_slider_key("ArrowRight", "ArrowRight", 39L)
    press_slider_key("ArrowRight", "ArrowRight", 39L)
    committed(5, 128)
    press_slider_key("ArrowLeft", "ArrowLeft", 37L)
    committed(4, 150)
    intermediate_src <- browser_eval(ctx$session, sprintf(
      "document.querySelector('#cell-%s img.plot')?.getAttribute('src') || ''",
      plot_id
    ))
    testthat::expect_true(startsWith(intermediate_src, "/plot/"))
    press_slider_key("ArrowRight", "ArrowRight", 39L)
    committed(5, 128)

    # The newer commit must not invalidate a URL that a delivered state had
    # already told the browser to fetch.
    retired_fetch <- browser_eval(ctx$session, sprintf(paste0(
      "(async()=>{const response=await fetch(%s);const bytes=",
      "new Uint8Array(await response.arrayBuffer());return {",
      "status:response.status,type:response.headers.get('content-type')||'',",
      "length:bytes.length,png:bytes[0]===137&&bytes[1]===80&&",
      "bytes[2]===78&&bytes[3]===71}})()"
    ), js_json(intermediate_src)))
    testthat::expect_equal(retired_fetch$status, 200)
    testthat::expect_equal(retired_fetch$type, "image/png")
    testthat::expect_gt(retired_fetch$length, 100L)
    testthat::expect_true(retired_fetch$png)
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session,
      sprintf(paste0(
        "(()=>{const image=document.querySelector('#cell-%s img.plot');",
        "return image?.complete&&image.naturalWidth>0&&image.naturalHeight>0})()"
      ), plot_id)
    )), label = "final reactive plot")

    events <- browser_eval(ctx$session, "window.__alderSliderEvents")
    event_types <- vapply(events, `[[`, "", "type")
    testthat::expect_gte(sum(event_types == "keydown"), 4L)
    testthat::expect_gte(sum(event_types == "keyup"), 4L)
    testthat::expect_gte(sum(event_types == "input"), 4L)
    testthat::expect_false("blur" %in% event_types)
    trusted <- vapply(events[event_types %in% c("keydown", "keyup", "input")],
                      `[[`, FALSE, "trusted")
    testthat::expect_true(all(trusted))
    testthat::expect_length(browser_eval(
      ctx$session, "window.__alderPlotErrors"
    ), 0L)
    if (length(plot_responses)) {
      statuses <- vapply(plot_responses, function(response) {
        as.numeric(response$status)
      }, numeric(1))
      testthat::expect_true(all(statuses < 400),
                            info = paste(statuses, collapse = ", "))
    }
  })
})

testthat::test_that("browser round-trips datetime widgets in UTC without warnings", {
  with_browser_server(c(
    "# %%", "library(alder)",
    "# %%",
    paste0(
      "stamp <- ui$datetime(as.POSIXct('2026-09-03 12:00:00', ",
      "tz = 'America/New_York'),"
    ),
    paste0(
      "  min = as.POSIXct('2026-09-03 11:00:00', ",
      "tz = 'America/New_York'),"
    ),
    paste0(
      "  max = as.POSIXct('2026-09-03 14:00:00', ",
      "tz = 'America/New_York'), label = 'Timestamp')"
    ),
    "stamp",
    "# %%", "format(stamp$value, '%Y-%m-%dT%H:%M:%SZ', tz = 'UTC')"
  ), function(ctx) {
    log_entries <- list()
    widget_posts <- character()
    ctx$session$Log$enable()
    ctx$session$Log$entryAdded(function(params) {
      log_entries[[length(log_entries) + 1L]] <<- params$entry
    }, wait_ = FALSE)
    ctx$session$Network$enable()
    ctx$session$Network$webSocketFrameSent(function(params) {
      frame <- params$response$payloadData %||% ""
      if (grepl('"type":"widget"', frame, fixed = TRUE)) {
        widget_posts[[length(widget_posts) + 1L]] <<- frame
      }
    }, wait_ = FALSE)

    # A browser timezone must not change the notebook's reproducible UTC
    # display/wire value. Reload after installing Log capture so render-time
    # warnings are part of the assertion.
    ctx$session$Emulation$setTimezoneOverride(timezoneId = "America/New_York")
    ctx$session$Page$reload()
    wait_cells_done(ctx$session, 3L)
    state <- browser_state(ctx$session)
    widget_id <- state$cells[[2L]]$id
    selector <- sprintf("#widget-%s-datetime", widget_id)
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf("document.querySelector(%s) !== null", js_json(selector))
    )), label = "datetime control after reload")

    initial <- browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const node=document.querySelector(%s);window.__alderDatetimeNode=node;",
      "return {type:node?.type,value:node?.value,min:node?.min,max:node?.max,",
      "step:node?.step,valid:node?.validity.valid,",
      "timezone:document.getElementById(node?.getAttribute('aria-describedby'))",
      "?.textContent||''}})()"
    ), js_json(selector)))
    testthat::expect_equal(initial$type, "datetime-local")
    testthat::expect_equal(initial$value, "2026-09-03T16:00")
    testthat::expect_equal(initial$min, "2026-09-03T15:00:00")
    testthat::expect_equal(initial$max, "2026-09-03T18:00:00")
    testthat::expect_equal(initial$step, "1")
    testthat::expect_true(initial$valid)
    testthat::expect_equal(initial$timezone, "UTC")

    testthat::expect_true(set_input(
      ctx$session, selector, "2026-09-03T17:30:45", "change"
    ))
    wait_browser(ctx$session, function() {
      widget <- cell_state(ctx$session, widget_id)$output
      dependent <- cell_state(ctx$session, state$cells[[3L]]$id)$output
      identical(widget$spec$value, "2026-09-03T17:30:45Z") &&
        identical(dependent$kind, "text") &&
        grepl("2026-09-03T17:30:45Z", dependent$text, fixed = TRUE) &&
        isFALSE(browser_state(ctx$session)$runtime$busy)
    }, label = "UTC datetime update")
    testthat::expect_true(any(grepl(
      '"value":"2026-09-03T17:30:45Z"', widget_posts, fixed = TRUE
    )))

    browser_host_update(ctx$session)
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "document.querySelector(%s)===window.__alderDatetimeNode&&",
      "document.querySelector(%s).value==='2026-09-03T17:30:45'"
    ), js_json(selector), js_json(selector))))
    unexpected <- log_entries[vapply(log_entries, function(entry) {
      (entry$level %||% "") %in% c("warning", "error")
    }, logical(1))]
    testthat::expect_equal(
      length(unexpected), 0L,
      info = paste(vapply(unexpected, function(entry) {
        as.character(entry$text %||% "")
      }, character(1)), collapse = " | ")
    )
  })
})


# 5c -------------------------------------------------------------------------
testthat::test_that("browser runs a freshly added summary cell and reruns it", {
  with_browser_server(c("# %%", "library(alder)",
                        "# %%", "peng <- iris"), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    before <- sub("^cell-", "", cell_ids(ctx$session))
    expect_true(click_selector(ctx$session,
      sprintf("#cell-%s [data-act=add][data-type=code]", before[[1L]])))
    wait_browser(ctx$session, function() length(cell_ids(ctx$session)) == 3L,
                 label = "added cell")
    after <- sub("^cell-", "", cell_ids(ctx$session))
    id <- setdiff(after, before)
    testthat::expect_length(id, 1L)
    id <- id[[1L]]
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, %s)", js_json(id),
      js_json("summary(peng$Sepal.Length)"))))
    wait_browser(ctx$session,
      function() identical(cell_text(ctx$session, id), "summary(peng$Sepal.Length)"),
      label = "source committed")
    run_selector <- sprintf("#cell-%s [data-act=run]", id)
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf(
        "document.querySelector(%s)?.disabled===false", js_json(run_selector)
      )
    )), label = "new summary Run control")
    testthat::expect_true(click_selector(ctx$session, run_selector))
    wait_browser(ctx$session, function() {
      c <- cell_state(ctx$session, id)
      identical(c$status, "done") && identical(c$output$kind, "text") &&
        grepl("Min\\.", c$output$text)
    }, label = "summary output")
    testthat::expect_match(cell_state(ctx$session, id)$output$text, "Max\\.")
    # A second run must also produce output (issue #4: no silent no-ops).
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session, sprintf(
        "document.querySelector(%s)?.disabled===false", js_json(run_selector)
      )
    )), label = "summary rerun control")
    testthat::expect_true(click_selector(ctx$session, run_selector))
    wait_browser(ctx$session, function() {
      c <- cell_state(ctx$session, id)
      identical(c$status, "done") && identical(c$output$kind, "text") &&
        grepl("Min\\.", c$output$text)
    }, label = "rerun output")
  })
})
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

testthat::test_that("browser edits and submits a form nested in a dictionary", {
  with_browser_server(c(
    "# %%", "library(alder)",
    "# %%",
    paste0(
      "controls <- ui$dictionary(submitted = ",
      "ui$form(ui$text_input('draft'), submit_label = 'Commit'))"
    ),
    "controls",
    "# %%", "controls$value$submitted"
  ), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    state <- browser_state(ctx$session)
    widget_id <- state$cells[[2L]]$id
    dependent_id <- state$cells[[3L]]$id
    text_selector <- sprintf("#widget-%s-text_input-submitted", widget_id)
    submit_selector <- sprintf("#widget-%s-form-submitted", widget_id)
    before <- cell_state(ctx$session, dependent_id)$output

    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector(%s)?.disabled === true",
      js_json(submit_selector)
    )))
    testthat::expect_true(set_input(
      ctx$session, text_selector, "trusted-form-value", "input"
    ))
    wait_browser(ctx$session, function() {
      spec <- cell_state(ctx$session, widget_id)$output$spec$children[[1L]]
      identical(spec$child$value, "trusted-form-value") &&
        isTRUE(spec$dirty) && is.null(spec$value) &&
        isTRUE(browser_eval(ctx$session, sprintf(
          "document.querySelector(%s)?.disabled === false",
          js_json(submit_selector)
        )))
    }, label = "nested form draft")
    testthat::expect_equal(cell_state(ctx$session, dependent_id)$output, before)

    # A scientist can type again and press Submit immediately. The frontend
    # must sequence Submit behind the in-flight draft instead of surfacing the
    # host's intentional operation_in_progress response.
    testthat::expect_true(set_input(
      ctx$session, text_selector, "rapid-form-value", "input"
    ))
    testthat::expect_true(click_selector(ctx$session, submit_selector))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      widget <- cell_state(ctx$session, widget_id)$output
      spec <- widget$spec$children[[1L]]
      dependent <- cell_state(ctx$session, dependent_id)$output
      identical(spec$value, "rapid-form-value") &&
        isFALSE(spec$dirty) && identical(dependent$kind, "text") &&
        grepl("rapid-form-value", dependent$text, fixed = TRUE) &&
        is.null(state$last_action_error) && isFALSE(state$runtime$busy)
    }, label = "nested form submit")
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "document.querySelector(%s)?.disabled === true",
      js_json(submit_selector)
    )))
  })
})

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


testthat::test_that("canonical CLI Stop cancels repeatedly and the notebook recovers", {
  with_browser_server(c("# %%", "1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    for (attempt in seq_len(3L)) {
      long_source <- paste0(
        "for (i in seq_len(200)) Sys.sleep(0.05); invisible(", attempt, ")"
      )
      testthat::expect_true(replace_editor_source(
        ctx$session, sprintf("#cell-%s .cm-content", id), long_source
      ))
      wait_browser(ctx$session,
        function() identical(cell_text(ctx$session, id), long_source),
        label = paste("long-running source", attempt))
      run_selector <- sprintf("#cell-%s [data-act=run]", id)
      wait_browser(ctx$session, function() isTRUE(browser_eval(
        ctx$session, sprintf(
          "document.querySelector(%s)?.disabled===false", js_json(run_selector)
        )
      )), label = paste("enabled Run control", attempt))
      testthat::expect_true(click_selector(ctx$session, run_selector))
      wait_browser(ctx$session, function() {
        state <- browser_state(ctx$session)
        isTRUE(state$runtime$busy) &&
          isTRUE(browser_eval(ctx$session,
            "document.querySelector('#stop')?.disabled === false"))
      }, label = paste("enabled Stop control", attempt))
      started <- Sys.time()
      testthat::expect_true(click_selector(ctx$session, "#stop"))
      wait_browser(ctx$session, function() {
        cell <- browser_state(ctx$session)$cells[[1L]]
        identical(cell$status, "error") &&
          grepl("Interrupted", paste(cell$log, collapse = "\n"), fixed = TRUE) &&
          isFALSE(browser_state(ctx$session)$runtime$busy)
      }, label = paste("interrupted cell", attempt))
      testthat::expect_lt(as.numeric(difftime(
        Sys.time(), started, units = "secs"
      )), 1.5)
      interrupted <- browser_state(ctx$session)$cells[[1L]]
      testthat::expect_identical(interrupted$error$message, "Interrupted")
      testthat::expect_true(isTRUE(interrupted$error$interrupted))

      recovery_source <- paste(attempt, "+ 40")
      testthat::expect_true(replace_editor_source(
        ctx$session, sprintf("#cell-%s .cm-content", id), recovery_source
      ))
      wait_browser(ctx$session,
        function() identical(cell_text(ctx$session, id), recovery_source),
        label = paste("replacement source", attempt))
      wait_browser(ctx$session, function() isTRUE(browser_eval(
        ctx$session, sprintf(
          "document.querySelector(%s)?.disabled===false", js_json(run_selector)
        )
      )), label = paste("enabled recovery Run control", attempt))
      testthat::expect_true(click_selector(ctx$session, run_selector))
      expected <- paste0("[1] ", attempt + 40L)
      wait_browser(ctx$session, function() {
        cell <- cell_state(ctx$session, id)
        identical(cell$status, "done") && identical(cell$output$text, expected)
      }, label = paste("post-interrupt recovery", attempt))
      wait_browser(ctx$session, function() {
        state <- browser_state(ctx$session)
        is.null(state$last_action_error) &&
          identical(trimws(browser_eval(ctx$session,
            "document.querySelector('#status')?.textContent || ''")), "")
      }, label = paste("cleared interruption banner", attempt))
    }
  })
})

testthat::test_that("browser dark theme keeps notebook text at AA contrast", {
  with_browser_server(c("# %%", "42", "# %%",
                        "data.frame(x = 1:3, group = c('a', 'b', 'c'))"), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    testthat::expect_true(browser_eval(ctx$session,
      "(()=>{document.documentElement.dataset.theme='dark';return true})()"))
    ratios <- unlist(browser_eval(ctx$session, paste0(
      "(()=>{",
      "const rgb=(s)=>{const m=s.match(/[\\d.]+/g).map(Number);return m.slice(0,3)},",
      "lum=(c)=>{const x=c.map(v=>v/255).map(v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4));return .2126*x[0]+.7152*x[1]+.0722*x[2]},",
      "ratio=(q)=>{const s=getComputedStyle(document.querySelector(q)),a=lum(rgb(s.color)),b=lum(rgb(s.backgroundColor));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};",
      "return ['.cell-head','.value-text','.table-preview th','.table-sort'].map(ratio)",
      "})()"
    )), use.names = FALSE)
    testthat::expect_length(ratios, 4L)
    testthat::expect_true(all(ratios >= 4.5), info = paste(ratios, collapse = ", "))
  })
})


testthat::test_that("browser app view is output-only but keeps logs and widgets", {
  with_browser_server(c("# %%", "library(alder)", "cat('hello log')",
                        "# %% [markdown]", "# App **markdown**",
                        "# %%", "s <- ui$slider(0, 10, value = 5)", "s"), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    click_selector(ctx$session, "#app-mode")
    wait_browser(ctx$session, function() {
      grepl("view=app", browser_eval(ctx$session, "location.search")) &&
        isTRUE(browser_eval(ctx$session,
          "(()=>{const controls=[...document.querySelectorAll('#run-all,#save,#runtime-select')];return controls.length===3&&controls.every(node=>node.getClientRects().length===0)})()")) &&
        grepl("hello log", browser_eval(ctx$session,
          "document.body.textContent"), fixed = TRUE) &&
        isTRUE(browser_eval(ctx$session,
          "document.querySelector('.markdown-output strong') !== null")) &&
        isTRUE(browser_eval(ctx$session,
          "document.querySelector('[data-role=widget]')?.disabled === false"))
    }, timeout = 30, label = "rendered app view")
    testthat::expect_equal(browser_eval(ctx$session, "document.querySelectorAll('textarea').length"), 0)
    testthat::expect_equal(browser_eval(ctx$session, "document.querySelectorAll('.cell-head').length"), 0)
    testthat::expect_true(browser_eval(ctx$session,
      "(()=>{const controls=[...document.querySelectorAll('#run-all,#save,#runtime-select')];return controls.length===3&&controls.every(node=>node.getClientRects().length===0)})()"))
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('#stop') !== null"))
    testthat::expect_match(browser_eval(ctx$session, "document.body.textContent"), "hello log")
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('.markdown-output strong') !== null"))
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('[data-role=widget]')?.disabled === false"))
  })
})

testthat::test_that("browser retains layered and independent base-graphics pages", {
  with_browser_server(c(
    "# %%",
    "plot(1:6, type = 'b', col = '#176B87', main = 'layered')",
    "abline(h = 3.5, col = '#B42318', lty = 2, lwd = 2)",
    "lines(1:6, 6:1, col = '#176B87')",
    "title(sub = 'all layers retained')",
    "legend('topleft', legend = 'threshold', col = '#B42318', lty = 2)",
    "# %%",
    "plot(1:3, main = 'first independent plot')",
    "plot(3:1, main = 'second independent plot')"
  ), function(ctx) {
    wait_cells_done(ctx$session, 2L, timeout = 30)
    wait_browser(ctx$session, function() isTRUE(browser_eval(
      ctx$session,
      "[...document.querySelectorAll('img.plot')].length===3&&[...document.querySelectorAll('img.plot')].every(x=>x.complete&&x.naturalWidth>0&&x.naturalHeight>0)"
    )), timeout = 30, label = "base graphics images")

    state <- browser_state(ctx$session)
    testthat::expect_equal(vapply(state$cells, function(cell) {
      length(cell$outputs)
    }, integer(1)), c(1L, 2L))
    testthat::expect_true(all(vapply(state$cells, function(cell) {
      all(vapply(cell$outputs, function(output) {
        identical(output$kind, "image")
      }, logical(1)))
    }, logical(1))))
    testthat::expect_identical(
      unname(unlist(browser_eval(ctx$session,
        "[...document.querySelectorAll('.cell')].map(x=>x.querySelectorAll('img.plot').length)"))),
      c(1L, 2L)
    )
  })
})

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

testthat::test_that("browser table page-size setting repaginates visible output", {
  with_browser_server(c("# %%", "data.frame(x = 1:30)"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    testthat::expect_match(browser_eval(ctx$session,
      "document.querySelector('.table-page-label')?.textContent || ''"),
      "1\\.\\.25 of 30")
    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    testthat::expect_true(set_input(ctx$session,
      "#settings-table-page-size", "10", "input"))
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      page <- state$cells[[1L]]$outputs[[1L]]$page
      identical(as.integer(state$config$table$page_size), 10L) &&
        identical(as.integer(page$limit), 10L) &&
        identical(as.integer(browser_eval(ctx$session,
          "document.querySelectorAll('.table-preview tbody tr').length")), 10L) &&
        grepl("1..10 of 30", browser_eval(ctx$session,
          "document.querySelector('.table-page-label')?.textContent || ''"
        ), fixed = TRUE)
    }, timeout = 35, label = "visible table repagination")
  })
})

testthat::test_that("browser exposes worker loss while preserving edit controls", {
  with_browser_server(c("# %%", "library(alder)", "tools::pskill(Sys.getpid(), 9)"), function(ctx) {
    wait_browser(ctx$session, function() isFALSE(browser_state(ctx$session)$runtime$busy), label = "worker loss")
    wait_browser(ctx$session, function() isFALSE(browser_state(ctx$session)$runtime$worker_available), label = "worker unavailable")
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('.cm-content') !== null"))
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('[data-role=source]') !== null"))
    testthat::expect_true(browser_eval(ctx$session, "document.querySelector('[data-act=run]').disabled === true"))
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('#restart')?.hidden === false"))
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, %s)", js_json(id), js_json("6 * 7")
    )))
    wait_browser(ctx$session,
      function() identical(cell_text(ctx$session, id), "6 * 7"),
      label = "worker-loss repair source")
    testthat::expect_true(click_selector(ctx$session, "#restart"))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      cell <- cell_state(ctx$session, id)
      isTRUE(state$runtime$worker_available) &&
        identical(cell$status, "done") && identical(cell$output$text, "[1] 42")
    }, timeout = 30, label = "worker restart and replay")
    testthat::expect_identical(trimws(browser_eval(ctx$session,
      "document.querySelector('#status')?.textContent || ''")), "")
  })
})

testthat::test_that("browser exposes structured runtime error details", {
  with_browser_server(c(
    "# %%",
    "inner_failure <- function() stop('deep failure')",
    "outer_failure <- function() inner_failure()",
    "outer_failure()"
  ), function(ctx) {
    wait_browser(ctx$session, function() {
      identical(browser_state(ctx$session)$cells[[1L]]$status, "error")
    }, label = "nested runtime error")
    cell <- browser_state(ctx$session)$cells[[1L]]
    testthat::expect_true("simpleError" %in%
      unlist(cell$error$class, use.names = FALSE))
    testthat::expect_match(cell$error$call, "inner_failure", fixed = TRUE)
    testthat::expect_gt(length(unlist(cell$error$trace, use.names = FALSE)), 0L)
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('.error-details') !== null"))
    details <- browser_eval(ctx$session,
      "document.querySelector('.error-trace')?.textContent || ''")
    testthat::expect_match(details, "simpleError", fixed = TRUE)
    testthat::expect_match(details, "Traceback:", fixed = TRUE)
  })
})

testthat::test_that("browser aligns every gutter line and identifies cells", {
  with_browser_server(c(
    "# %%", "#| name: setup", "x <- 1", "x + 1", "x + 2",
    "# %%", "y <- x + 1", "y"
  ), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    counts <- browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.cell')].map(cell=>({",
      "lines:cell.querySelectorAll('.cm-line').length,",
      "gutters:[...cell.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]",
      ".filter(x=>x.textContent.trim()!==''&&getComputedStyle(x).visibility!==",
      "'hidden').length}))"
    ))
    testthat::expect_identical(
      vapply(counts, `[[`, 0L, "gutters"),
      vapply(counts, `[[`, 0L, "lines")
    )
    geometry <- unlist(browser_eval(ctx$session, paste0(
      "(()=>{const out=[];for(const cell of document.querySelectorAll('.cell')){",
      "const lines=[...cell.querySelectorAll('.cm-line')];",
      "const nums=[...cell.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]",
      ".filter(x=>x.textContent.trim()!==''&&getComputedStyle(x).visibility!==",
      "'hidden');",
      "lines.forEach((line,i)=>out.push(Math.abs(line.getBoundingClientRect().top-",
      "nums[i].getBoundingClientRect().top)));}return out})()"
    )), use.names = FALSE)
    testthat::expect_gt(length(geometry), 0L)
    testthat::expect_true(all(as.numeric(geometry) <= 1.5),
      info = paste(geometry, collapse = ", "))

    titles <- unlist(browser_eval(ctx$session,
      "[...document.querySelectorAll('[data-role=cell-title]')].map(x=>x.textContent)"),
      use.names = FALSE)
    testthat::expect_identical(titles, c("Cell 1 · setup", "Cell 2"))
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.cell')].every(cell=>{",
      "const title=cell.querySelector('[data-role=cell-title]');",
      "return cell.getAttribute('aria-labelledby')===title.id&&",
      "title.title.includes(cell.dataset.cell)})"
    )))
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.minimap-cell')].every((x,i)=>{",
      "const r=x.getBoundingClientRect();return r.width>=24&&r.height>=24&&",
      "x.textContent===String(i+1)&&x.title.includes(x.dataset.targetCell)})"
    )))
    testthat::expect_equal(browser_eval(ctx$session,
      "document.querySelectorAll('[data-type=sql],option[value=sql],[data-role=sql-editor]').length"),
      0)

    ids <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const b=document.querySelectorAll('.minimap-cell')[1];b.focus();",
      "return true})()"
    )))
    ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "Enter",
      code = "Enter", windowsVirtualKeyCode = 13L, nativeVirtualKeyCode = 13L)
    ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = "Enter",
      code = "Enter", windowsVirtualKeyCode = 13L, nativeVirtualKeyCode = 13L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell || ''"), ids[[2L]]),
      label = "keyboard cell navigation")

    testthat::expect_true(click_selector(ctx$session,
      sprintf("#cell-%s [data-act=move-up]", ids[[2L]])))
    wait_browser(ctx$session, function() identical(unlist(browser_eval(ctx$session,
      "[...document.querySelectorAll('[data-role=cell-title]')].map(x=>x.textContent)"),
      use.names = FALSE), c("Cell 1", "Cell 2 · setup")),
      label = "renumbered cell titles")
  })
})

testthat::test_that("browser drag handle reorders cells with a visible drop target", {
  with_browser_server(c("# %%", "1", "# %%", "2", "# %%", "3"), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    original <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
    dragged <- original[[3L]]
    target <- original[[1L]]
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const h=document.querySelector('#cell-%s [data-role=drag-handle]');",
      "const t=document.querySelector('#cell-%s');const dt=new DataTransfer();",
      "h.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,",
      "dataTransfer:dt}));const r=t.getBoundingClientRect();",
      "t.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,",
      "clientY:r.top+1,dataTransfer:dt}));",
      "const shown=t.classList.contains('drop-before');",
      "t.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,",
      "clientY:r.top+1,dataTransfer:dt}));return shown})()"
    ), dragged, target)))
    expected <- c(dragged, original[1:2])
    wait_browser(ctx$session, function() {
      state_order <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
      dom_order <- sub("^cell-", "", cell_ids(ctx$session))
      identical(state_order, expected) && identical(dom_order, expected)
    }, label = "drag reorder")
    testthat::expect_identical(unlist(browser_eval(ctx$session,
      "[...document.querySelectorAll('[data-role=cell-title]')].map(x=>x.textContent)"),
      use.names = FALSE), c("Cell 1", "Cell 2", "Cell 3"))
  })
})

testthat::test_that("browser dependency graph keeps exact paths and readable geometry", {
  with_browser_server(c(
    "# %% [markdown]", "#| name: overview", "# # Dependency review",
    "# A paragraph that must not become an outline heading.",
    "# %%", "#| name: root_value", "root_value <- 1",
    "# %%", "#| name: left_value", "left_value <- root_value + 1",
    "# %%", "#| name: right_value", "right_value <- root_value + 2",
    "# %%", "#| name: merged_value",
    "merged_value <- left_value + right_value",
    "# %%", "#| name: branch_a", "branch_a <- merged_value + 1",
    "# %%", "#| name: branch_b", "branch_b <- merged_value + 2",
    "# %%", "#| name: deep_a", "deep_a <- branch_a + 1",
    "# %%", "#| name: deep_b", "deep_b <- branch_b + 1",
    "# %%", "#| name: combined", "combined <- deep_a + deep_b",
    "# %%", "#| name: selected", "selected <- combined * 2",
    "# %%", "#| name: report", "report <- selected + 1",
    "# %%", "#| name: summary", "summary <- report + combined"
  ), function(ctx) {
    wait_cells_done(ctx$session, 13L)
    ctx$session$Emulation$setDeviceMetricsOverride(
      width = 1350L, height = 900L, deviceScaleFactor = 1, mobile = FALSE)
    state <- browser_state(ctx$session)
    ids <- setNames(
      vapply(state$cells, `[[`, "", "id"),
      vapply(state$cells, function(cell) cell$options$name %||% "", "")
    )

    shape <- browser_eval(ctx$session, paste0(
      "(async()=>{const s=await(await fetch('/api/state')).json();",
      "const d=s.dataflow.dag;return {edges:Object.values(d.edges).every(Array.isArray),",
      "reverse:Object.values(d.reverse_edges).every(Array.isArray),",
      "empty:Array.isArray(d.edges[", js_json(ids[["root_value"]]), "])&&",
      "d.edges[", js_json(ids[["root_value"]]), "].length===0,",
      "single:Array.isArray(d.edges[", js_json(ids[["left_value"]]), "])&&",
      "d.edges[", js_json(ids[["left_value"]]), "].length===1}})()"
    ))
    testthat::expect_true(all(unlist(shape, use.names = FALSE)))

    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const cell=document.querySelector('#cell-%s');",
      "cell.querySelector('.cm-content').focus();return true})()"
    ), ids[["merged_value"]])))
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-dependencies"))
    wait_browser(ctx$session, function() grepl("report", browser_eval(
      ctx$session, "document.querySelector('#panel-dependencies')?.textContent || ''"
    ), fixed = TRUE), label = "complete transitive descendants")
    descendant_ids <- unlist(browser_eval(ctx$session, paste0(
      "(()=>{const section=[...document.querySelectorAll(",
      "'#panel-dependencies .dependency-section')].find(x=>",
      "x.querySelector('h3')?.textContent==='Descendants');return ",
      "[...(section?.querySelectorAll('button')||[])].map(x=>",
      "x.dataset.targetCell)})()"
    )), use.names = FALSE)
    testthat::expect_true(all(unname(ids[c(
      "branch_a", "branch_b", "deep_a", "deep_b", "combined", "selected",
      "report", "summary"
    )]) %in% descendant_ids))

    testthat::expect_true(click_selector(ctx$session, "#panel-tab-graph"))
    graph_geometry <- function() browser_eval(ctx$session, paste0(
      "(()=>{const v=document.querySelector('#panel-graph');",
      "const s=v.querySelector('.graph-scroll');const svg=v.querySelector('svg');",
      "const nodes=[...v.querySelectorAll('.dag-node')].map(n=>{",
      "const r=n.querySelector('rect').getBoundingClientRect();",
      "const t=n.querySelector('text').getBoundingClientRect();",
      "return {id:n.dataset.targetCell,rank:Number(n.dataset.rank),",
      "left:r.left,right:r.right,top:r.top,bottom:r.bottom,",
      "width:r.width,height:r.height,labelHeight:t.height}});",
      "const overlaps=[];for(let i=0;i<nodes.length;i+=1){",
      "for(let j=i+1;j<nodes.length;j+=1){const a=nodes[i],b=nodes[j];",
      "if(a.left<b.right-0.5&&a.right>b.left+0.5&&",
      "a.top<b.bottom-0.5&&a.bottom>b.top+0.5)",
      "overlaps.push([a.id,b.id])}}",
      "const sr=svg.getBoundingClientRect();const nodesInside=nodes.every(n=>",
      "n.left>=sr.left-1&&n.right<=sr.right+1&&",
      "n.top>=sr.top-1&&n.bottom<=sr.bottom+1);",
      "return {orientation:svg.dataset.orientation,nodes,clientWidth:s.clientWidth,",
      "clientHeight:s.clientHeight,scrollWidth:s.scrollWidth,scrollHeight:s.scrollHeight,",
      "width:svg.getAttribute('width'),height:svg.getAttribute('height'),",
      "intrinsicWidth:svg.dataset.intrinsicWidth,",
      "intrinsicHeight:svg.dataset.intrinsicHeight,",
      "overlaps,nodesInside,",
      "edges:v.querySelectorAll('.dag-edge[marker-end]').length,",
      "controls:[...v.querySelectorAll('[data-graph-action]')].map(b=>",
      "({name:b.dataset.graphAction,label:b.getAttribute('aria-label')}))}})()"
    ))
    vertical <- graph_geometry()
    node_values <- vertical$nodes
    testthat::expect_true(all(vapply(node_values, function(node) {
      node$width >= 150 && node$height >= 44 && node$labelHeight >= 11
    }, logical(1))))
    testthat::expect_gt(vertical$scrollWidth, vertical$clientWidth)
    testthat::expect_gt(vertical$scrollHeight, vertical$clientHeight)
    testthat::expect_length(vertical$overlaps, 0L)
    testthat::expect_true(vertical$nodesInside)
    testthat::expect_equal(vertical$edges, 14)
    testthat::expect_true(all(nzchar(vapply(vertical$controls, `[[`, "", "label"))))
    ranks <- setNames(vapply(node_values, `[[`, 0, "rank"),
                      vapply(node_values, `[[`, "", "id"))
    testthat::expect_equal(unname(ranks[ids[c(
      "root_value", "left_value", "right_value", "merged_value", "branch_a",
      "deep_a", "combined", "selected", "report", "summary"
    )]]), c(0, 1, 1, 2, 3, 4, 5, 6, 7, 8))

    testthat::expect_true(click_selector(ctx$session,
      "#panel-graph [data-graph-action=zoom-in]"))
    wait_browser(ctx$session, function() grepl("120%", browser_eval(ctx$session,
      "document.querySelector('[data-graph-zoom-status]')?.textContent || ''"),
      fixed = TRUE), label = "graph zoom in")
    fit_status <- browser_eval(ctx$session, paste0(
      "(()=>{const button=document.querySelector(",
      "'#panel-graph [data-graph-action=fit]');if(!button)return '';",
      "button.click();return document.querySelector(",
      "'[data-graph-zoom-status]')?.textContent || ''})()"
    ))
    testthat::expect_match(fit_status, "fit", fixed = TRUE)
    testthat::expect_true(click_selector(ctx$session,
      "#panel-graph [data-graph-action=reset]"))
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.querySelector('[data-graph-zoom-status]')?.textContent || ''"),
      "100%"), label = "graph zoom reset")

    panel_width <- as.numeric(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel').getBoundingClientRect().width"))
    testthat::expect_true(click_selector(ctx$session,
      "#panel-graph [data-graph-action=expand]"))
    wait_browser(ctx$session, function() as.numeric(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel').getBoundingClientRect().width")) >
        panel_width * 2, label = "expanded graph")
    testthat::expect_true(click_selector(ctx$session,
      "#panel-graph [data-graph-action=expand]"))

    testthat::expect_true(click_selector(ctx$session,
      "#panel-graph [data-graph-orientation]"))
    wait_browser(ctx$session, function() identical(
      graph_geometry()$orientation, "horizontal"), label = "horizontal graph")
    horizontal <- graph_geometry()
    testthat::expect_true(all(vapply(horizontal$nodes, function(node) {
      node$width >= 150 && node$height >= 44 && node$labelHeight >= 11
    }, logical(1))))
    testthat::expect_gt(horizontal$scrollWidth, horizontal$clientWidth)
    testthat::expect_length(horizontal$overlaps, 0L)
    testthat::expect_true(horizontal$nodesInside)

    ctx$session$Emulation$setDeviceMetricsOverride(
      width = 390L, height = 844L, deviceScaleFactor = 1, mobile = TRUE)
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "innerWidth===390"), label = "mobile graph viewport")
    mobile_horizontal <- graph_geometry()
    testthat::expect_true(all(vapply(mobile_horizontal$nodes, function(node) {
      node$width >= 150 && node$height >= 44 && node$labelHeight >= 11
    }, logical(1))))
    testthat::expect_gt(mobile_horizontal$scrollWidth,
                        mobile_horizontal$clientWidth)
    testthat::expect_length(mobile_horizontal$overlaps, 0L)
    testthat::expect_true(mobile_horizontal$nodesInside)
    testthat::expect_true(click_selector(ctx$session,
      "#panel-graph [data-graph-orientation]"))
    wait_browser(ctx$session, function() identical(
      graph_geometry()$orientation, "vertical"), label = "mobile vertical graph")
    mobile_vertical <- graph_geometry()
    testthat::expect_true(all(vapply(mobile_vertical$nodes, function(node) {
      node$width >= 150 && node$height >= 44 && node$labelHeight >= 11
    }, logical(1))))
    testthat::expect_gt(mobile_vertical$scrollWidth, mobile_vertical$clientWidth)
    testthat::expect_gt(mobile_vertical$scrollHeight, mobile_vertical$clientHeight)
    testthat::expect_length(mobile_vertical$overlaps, 0L)
    testthat::expect_true(mobile_vertical$nodesInside)
  })
})

testthat::test_that("browser outline handles trusted Enter and Space once", {
  with_browser_server(c(
    "# %% [markdown]", "#| name: overview", "# # Study overview",
    "# %%", "#| name: analysis", "x <- 1",
    "# %%", "#| name: result", "result <- x + 1", "result"
  ), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    state <- browser_state(ctx$session)
    ids <- vapply(state$cells, `[[`, "", "id")
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-outline"))
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{window.__outlineKeyEvents=[];window.__outlineNavigations=[];",
      "const panel=document.querySelector('#dataflow-panel');",
      "panel.addEventListener('keydown',event=>{const target=event.target.closest(",
      "'.panel-link[data-target-cell]');if(target)window.__outlineKeyEvents.push({",
      "type:event.type,key:event.key,isTrusted:event.isTrusted,",
      "defaultPrevented:event.defaultPrevented,target:target.dataset.targetCell})});",
      "for(const id of ", js_json(paste0("cell-", ids[2:3])), "){",
      "const cell=document.getElementById(id);const original=cell.scrollIntoView.bind(cell);",
      "cell.scrollIntoView=(...args)=>{window.__outlineNavigations.push(id);",
      "return original(...args)}}return true})()"
    )))
    focus_outline <- function(id) isTRUE(browser_eval(ctx$session, paste0(
      "(()=>{const button=[...document.querySelectorAll(",
      "'#panel-outline .panel-link[data-target-cell]')].find(item=>",
      "item.dataset.targetCell===", js_json(id), ");button?.focus();",
      "return document.activeElement===button})()"
    )))
    press_key <- function(key, code, virtual_key) {
      ctx$session$Input$dispatchKeyEvent(
        type = "rawKeyDown", key = key, code = code,
        windowsVirtualKeyCode = virtual_key,
        nativeVirtualKeyCode = virtual_key
      )
      ctx$session$Input$dispatchKeyEvent(
        type = "keyUp", key = key, code = code,
        windowsVirtualKeyCode = virtual_key,
        nativeVirtualKeyCode = virtual_key
      )
    }

    testthat::expect_true(focus_outline(ids[[2L]]))
    press_key("Enter", "Enter", 13L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell || ''"), ids[[2L]]),
      label = "trusted outline Enter navigation")

    testthat::expect_true(focus_outline(ids[[3L]]))
    press_key(" ", "Space", 32L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell || ''"), ids[[3L]]),
      label = "trusted outline Space navigation")

    events <- browser_eval(ctx$session, "window.__outlineKeyEvents")
    testthat::expect_identical(vapply(events, `[[`, "", "key"), c("Enter", " "))
    testthat::expect_true(all(vapply(events, `[[`, FALSE, "isTrusted")))
    testthat::expect_true(all(vapply(events, `[[`, FALSE, "defaultPrevented")))
    testthat::expect_identical(
      unlist(browser_eval(ctx$session, "window.__outlineNavigations"),
             use.names = FALSE),
      paste0("cell-", ids[2:3])
    )
  })
})

testthat::test_that("browser drawer, navigator, outline, and reorder semantics fit", {
  headings <- unlist(lapply(seq_len(24L), function(index) c(
    paste0("# ## Section ", index),
    paste0("# Narrative paragraph ", index, " is not a heading.")
  )), use.names = FALSE)
  assignments <- paste0("value_", sprintf("%02d", seq_len(30L)), " <- ",
                        seq_len(30L))
  with_browser_server(c(
    "# %% [markdown]", "#| name: study_notes", "# # Study notes",
    "# Opening narrative is not a heading.", headings,
    "# %%", "#| name: values", assignments, "sum(value_01, value_30)",
    "# %%", "#| name: result", "result <- value_01 + value_30", "result"
  ), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    ctx$session$Emulation$setDeviceMetricsOverride(
      width = 1350L, height = 900L, deviceScaleFactor = 1, mobile = FALSE)
    if (!isTRUE(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel')?.hidden"))) {
      testthat::expect_true(click_selector(ctx$session, "#panel-close"))
    }
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel')?.hidden")),
      label = "fully hidden desktop dataflow panel")
    closed <- browser_eval(ctx$session, paste0(
      "(()=>{const panel=document.querySelector('#dataflow-panel');",
      "const notebook=document.querySelector('#notebook').getBoundingClientRect();",
      "const panelRect=panel.getBoundingClientRect();return {",
      "display:getComputedStyle(panel).display,rectCount:panel.getClientRects().length,",
      "panelWidth:panelRect.width,panelHeight:panelRect.height,",
      "notebookWidth:notebook.width}})()"
    ))
    testthat::expect_identical(closed$display, "none")
    testthat::expect_identical(closed$rectCount, 0L)
    testthat::expect_equal(closed$panelWidth, 0)
    testthat::expect_equal(closed$panelHeight, 0)
    testthat::expect_gte(closed$notebookWidth, 900)
    testthat::expect_lte(closed$notebookWidth, 920)
    testthat::expect_true(click_selector(ctx$session, "#panel-toggle"))
    wait_browser(ctx$session, function() isFALSE(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel')?.hidden")),
      label = "reopened desktop dataflow panel")
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-outline"))
    desktop <- browser_eval(ctx$session, paste0(
      "(()=>{const rect=n=>n.getBoundingClientRect();",
      "const main=rect(document.querySelector('#notebook'));",
      "const nav=rect(document.querySelector('#minimap'));",
      "const panel=rect(document.querySelector('#dataflow-panel'));",
      "const visibleActions=[...document.querySelectorAll('.cell-actions button:last-child')]",
      ".filter(n=>{const r=rect(n);return r.top>=0&&r.bottom<=innerHeight});",
      "return {notebookNav:Math.max(0,main.right-nav.left),",
      "navPanel:Math.max(0,nav.right-panel.left),",
      "actionsInside:[...document.querySelectorAll('.cell-actions button:last-child')]",
      ".every(n=>rect(n).right<=main.right+1),hit:visibleActions.length>0&&",
      "visibleActions.every(n=>{const r=rect(n);return document.elementFromPoint(",
      "r.left+r.width/2,r.top+r.height/2)===n})}})()"
    ))
    testthat::expect_equal(desktop$notebookNav, 0)
    testthat::expect_equal(desktop$navPanel, 0)
    testthat::expect_true(desktop$actionsInside)
    testthat::expect_true(desktop$hit)

    outline_text <- unlist(browser_eval(ctx$session,
      "[...document.querySelectorAll('#panel-outline button')].map(x=>x.textContent.trim())"),
      use.names = FALSE)
    testthat::expect_true(all(c("Study notes", "Section 1", "Section 24") %in%
                              outline_text))
    testthat::expect_false(any(grepl("Narrative paragraph|Opening narrative",
                                    outline_text)))
    semantics <- browser_eval(ctx$session, paste0(
      "(()=>{const c=document.querySelector('.cell');",
      "const h=c.querySelector('[data-role=drag-handle]');",
      "const up=c.querySelector('[data-act=move-up]');",
      "const down=c.querySelector('[data-act=move-down]');",
      "return {tag:h.tagName,tabIndex:h.tabIndex,hidden:h.getAttribute('aria-hidden'),",
      "role:h.getAttribute('role'),upLabel:up.getAttribute('aria-label'),",
      "downLabel:down.getAttribute('aria-label'),",
      "upDescription:up.getAttribute('aria-describedby'),",
      "downDescription:down.getAttribute('aria-describedby')}})()"
    ))
    testthat::expect_identical(semantics$tag, "SPAN")
    testthat::expect_identical(semantics$tabIndex, -1L)
    testthat::expect_identical(semantics$hidden, "true")
    testthat::expect_null(semantics$role)
    testthat::expect_match(semantics$upLabel, "Move Cell 1")
    testthat::expect_match(semantics$downLabel, "Move Cell 1")
    testthat::expect_identical(semantics$upDescription,
                               semantics$downDescription)
    testthat::expect_true(nzchar(semantics$upDescription))

    order_before_keyboard <- vapply(browser_state(ctx$session)$cells,
                                    `[[`, "", "id")
    moving_id <- order_before_keyboard[[3L]]
    focus_move <- function(action) isTRUE(browser_eval(ctx$session, sprintf(
      paste0(
        "(()=>{const cell=document.getElementById('cell-'+%s);",
        "const button=cell?.querySelector('[data-act=%s]');",
        "button?.scrollIntoView({block:'center'});button?.focus();",
        "return document.activeElement===button})()"
      ), js_json(moving_id), js_json(action)
    )))
    press_enter <- function() {
      ctx$session$Input$dispatchKeyEvent(
        type = "rawKeyDown", key = "Enter", code = "Enter",
        windowsVirtualKeyCode = 13L, nativeVirtualKeyCode = 13L
      )
      ctx$session$Input$dispatchKeyEvent(
        type = "char", key = "Enter", code = "Enter", text = "\r",
        unmodifiedText = "\r", windowsVirtualKeyCode = 13L,
        nativeVirtualKeyCode = 13L
      )
      ctx$session$Input$dispatchKeyEvent(
        type = "keyUp", key = "Enter", code = "Enter",
        windowsVirtualKeyCode = 13L, nativeVirtualKeyCode = 13L
      )
    }
    testthat::expect_true(focus_move("move-up"))
    press_enter()
    wait_browser(ctx$session, function() {
      dom <- sub("^cell-", "", cell_ids(ctx$session))
      api <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
      identical(dom, api) && identical(dom[[2L]], moving_id)
    }, label = "native keyboard Move up")
    order_after_keyboard_up <- vapply(browser_state(ctx$session)$cells,
                                      `[[`, "", "id")
    testthat::expect_false(identical(order_after_keyboard_up,
                                     order_before_keyboard))
    testthat::expect_true(focus_move("move-down"))
    press_enter()
    wait_browser(ctx$session, function() {
      dom <- sub("^cell-", "", cell_ids(ctx$session))
      api <- vapply(browser_state(ctx$session)$cells, `[[`, "", "id")
      identical(dom, api) && identical(api, order_before_keyboard)
    }, label = "native keyboard Move down restore")

    ctx$session$Emulation$setDeviceMetricsOverride(
      width = 390L, height = 844L, deviceScaleFactor = 1, mobile = TRUE)
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      "innerWidth===390")), label = "mobile live-session viewport")
    if (!isTRUE(browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel')?.hidden"))) {
      testthat::expect_true(click_selector(ctx$session, "#panel-close"))
    }
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session,
      paste0("(()=>{const panel=document.querySelector('#dataflow-panel');",
        "return panel.hidden&&getComputedStyle(panel).display==='none'&&",
        "panel.getClientRects().length===0})()"))),
      label = "closed mobile drawer")
    browser_eval(ctx$session, "window.scrollTo(0,400);true")
    testthat::expect_true(click_selector(ctx$session, "#panel-toggle"))
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-variables"))
    wait_browser(ctx$session, function() browser_eval(ctx$session, paste0(
      "(()=>{const p=document.querySelector('#dataflow-panel').getBoundingClientRect();",
      "const t=document.querySelector('#topbar').getBoundingClientRect();",
      "const v=document.querySelector('#panel-variables');return p.top>=t.bottom-1&&",
      "p.bottom<=innerHeight+1&&v.scrollHeight>v.clientHeight})()"
    )), label = "bounded scrollable variables drawer")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const v=document.querySelector('#panel-variables');",
      "v.scrollTop=v.scrollHeight;const last=v.querySelector('.variable-row:last-child');",
      "const a=last.getBoundingClientRect(),b=v.getBoundingClientRect();",
      "return v.scrollTop>0&&a.bottom<=b.bottom+1})()"
    )))

    testthat::expect_true(click_selector(ctx$session, "#panel-tab-dependencies"))
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const p=document.querySelector('#dataflow-panel').getBoundingClientRect();",
      "const t=document.querySelector('#topbar').getBoundingClientRect();",
      "const v=document.querySelector('#panel-dependencies');return p.top>=t.bottom-1&&",
      "p.bottom<=innerHeight+1&&v.clientHeight>300})()"
    )))
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-outline"))
    wait_browser(ctx$session, function() browser_eval(ctx$session, paste0(
      "(()=>{const v=document.querySelector('#panel-outline');",
      "return v.scrollHeight>v.clientHeight})()"
    )), label = "scrollable outline drawer")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const v=document.querySelector('#panel-outline');v.scrollTop=v.scrollHeight;",
      "const last=v.querySelector('button:last-child');",
      "const a=last.getBoundingClientRect(),b=v.getBoundingClientRect();",
      "return v.scrollTop>0&&a.bottom<=b.bottom+1})()"
    )))

    testthat::expect_true(click_selector(ctx$session, "#panel-close"))
    browser_eval(ctx$session, "window.scrollTo(0,1200);true")
    testthat::expect_true(click_selector(ctx$session, "#panel-toggle"))
    wait_browser(ctx$session, function() browser_eval(ctx$session, paste0(
      "(()=>{const p=document.querySelector('#dataflow-panel').getBoundingClientRect();",
      "const t=document.querySelector('#topbar').getBoundingClientRect();",
      "return Math.abs(p.top-t.bottom)<=1&&p.bottom<=innerHeight+1&&",
      "document.documentElement.scrollWidth<=innerWidth})()"
    )), label = "stable drawer inset after document scroll")
  })
})

testthat::test_that("browser keeps retained output explicitly stale while running", {
  with_browser_server(c("# %%", "1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    source <- "Sys.sleep(5); 42"
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,%s)", js_json(id), js_json(source))))
    wait_browser(ctx$session, function() identical(cell_text(ctx$session, id), source),
      label = "long source committed")
    testthat::expect_true(click_selector(ctx$session,
      sprintf("#cell-%s [data-act=run]", id)))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      isTRUE(state$runtime$busy) && identical(state$cells[[1L]]$status, "running") &&
        grepl("Previous output", browser_eval(ctx$session,
          "document.querySelector('.retained-output-label')?.textContent || ''"),
          fixed = TRUE)
    }, label = "rendered running cell with retained output")
    testthat::expect_equal(trimws(browser_eval(ctx$session,
      "document.querySelector('.retained-output-label')?.textContent || ''")),
      "Previous output — updating")
    opacity <- as.numeric(browser_eval(ctx$session,
      "getComputedStyle(document.querySelector('.retained-output .out-record:not(.out-progress)')).opacity"))
    testthat::expect_lt(opacity, 1)
    testthat::expect_true(click_selector(ctx$session, "#stop"))
    wait_idle(ctx$session)
  })
})

testthat::test_that("browser editor assistance is explicit and independently gated", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const original=window.fetch.bind(window);window.__lspCalls=[];",
      "window.__assistanceErrors=[];window.addEventListener('error',e=>",
      "window.__assistanceErrors.push(e.message));window.addEventListener(",
      "'unhandledrejection',e=>window.__assistanceErrors.push(String(",
      "e.reason?.message||e.reason)));",
      "window.fetch=(input,init={})=>{",
      "const path=new URL(input,location.href).pathname;if(path!=='/api/lsp')",
      "return original(input,init);const body=JSON.parse(init.body);",
      "window.__lspCalls.push(body.method);",
      "const result=body.method==='textDocument/completion'?",
      "{items:[{label:'mean',insertText:'mean',kind:3,detail:'base'}]}:",
      "body.method==='textDocument/signatureHelp'?{activeSignature:0,",
      "activeParameter:0,signatures:[{label:'mean(x, trim = 0, na.rm = FALSE)',",
      "parameters:[{label:'x',documentation:'Values to average.'}]}]}:null;",
      "return Promise.resolve(new Response(JSON.stringify({ok:true,result}),",
      "{status:200,headers:{'Content-Type':'application/json'}}))};return true})()"
    )))
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);e.setDoc('mea');",
      "e.view.dispatch({selection:{anchor:e.view.state.doc.length}});e.focus();",
      "return true})()"
    ), js_json(id))))
    wait_browser(ctx$session, function() identical(cell_text(ctx$session, id), "mea"),
      label = "completion source committed")
    ctx$session$Input$dispatchKeyEvent(
      type = "keyDown", key = "Tab", code = "Tab",
      windowsVirtualKeyCode = 9L, nativeVirtualKeyCode = 9L)
    ctx$session$Input$dispatchKeyEvent(
      type = "keyUp", key = "Tab", code = "Tab",
      windowsVirtualKeyCode = 9L, nativeVirtualKeyCode = 9L)
    wait_browser(ctx$session, function() "textDocument/completion" %in%
      unlist(browser_eval(ctx$session, "window.__lspCalls"), use.names = FALSE),
      label = "Tab completion request")
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      sprintf("((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s)?.completionStatus() || ''",
        js_json(id))), "active"), label = "active completion state")
    testthat::expect_length(unlist(browser_eval(ctx$session,
      "window.__assistanceErrors"), use.names = FALSE), 0L)
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "document.querySelector('.cm-tooltip-autocomplete') !== null"),
      label = "Tab completion menu")

    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);e.setDoc('mean');",
      "const p=e.view.state.doc.length;e.view.dispatch({changes:{from:p,insert:'('},",
      "selection:{anchor:p+1}});return true})()"
    ), js_json(id))))
    wait_browser(ctx$session, function() "textDocument/signatureHelp" %in%
      unlist(browser_eval(ctx$session, "window.__lspCalls"), use.names = FALSE),
      label = "signature help request")
    testthat::expect_length(unlist(browser_eval(ctx$session,
      "window.__assistanceErrors"), use.names = FALSE), 0L)
    wait_browser(ctx$session, function() grepl("Argument: x", browser_eval(ctx$session,
      "document.querySelector('.cm-alder-signature')?.textContent || ''"),
      fixed = TRUE), label = "signature argument tooltip")

    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    testthat::expect_true(browser_eval(ctx$session,
      "(()=>{document.querySelector('#settings-completions').checked=false;document.querySelector('#settings-signature-help').checked=false;return true})()"))
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() {
      editor <- browser_state(ctx$session)$config$editor
      isFALSE(editor$completions) && isFALSE(editor$signature_help) &&
        isFALSE(editor$live_diagnostics)
    }, label = "independent editor settings")
    wait_browser(ctx$session, function() isFALSE(browser_eval(ctx$session,
      "document.querySelector('.cm-alder-signature') !== null")),
      label = "disabled signature tooltip removed")
    testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
      "(()=>{const e=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(%s);e.setDoc('mea');",
      "e.view.dispatch({selection:{anchor:e.view.state.doc.length}});e.focus();",
      "return true})()"
    ), js_json(id))))
    calls_before <- length(unlist(browser_eval(ctx$session, "window.__lspCalls"),
      use.names = FALSE))
    ctx$session$Input$dispatchKeyEvent(
      type = "keyDown", key = "Tab", code = "Tab",
      windowsVirtualKeyCode = 9L, nativeVirtualKeyCode = 9L)
    ctx$session$Input$dispatchKeyEvent(
      type = "keyUp", key = "Tab", code = "Tab",
      windowsVirtualKeyCode = 9L, nativeVirtualKeyCode = 9L)
    Sys.sleep(0.4)
    testthat::expect_false(browser_eval(ctx$session,
      "document.querySelector('.cm-tooltip-autocomplete') !== null"))
    testthat::expect_equal(length(unlist(browser_eval(ctx$session,
      "window.__lspCalls"), use.names = FALSE)), calls_before)
    testthat::expect_length(unlist(browser_eval(ctx$session,
      "window.__assistanceErrors"), use.names = FALSE), 0L)
  })
})

testthat::test_that("browser preserves notebook-level linter failures and diagnostic severity", {
  with_browser_server(c("# %% [name=analysis]", "value <- 1"), function(ctx) {
    config <- file.path(ctx$root, ".lintr")
    # A deterministic failing project linter exercises the same locationless
    # failure as an upstream linter bug, independent of lintr's current version.
    writeLines(paste0(
      "linters: list(failing = lintr::Linter(function(source_expression) ",
      "stop('Custom linter failure <not-markup>')))"
    ), config)
    toggle_lint <- function(enabled) {
      testthat::expect_true(click_selector(ctx$session, "#settings-open"))
      testthat::expect_true(browser_eval(ctx$session, sprintf(paste0(
        "(()=>{document.querySelector('#settings-live-diagnostics').checked=%s;",
        "return true})()"
      ), if (enabled) "true" else "false")))
      testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    }
    region_hidden <- function() isTRUE(browser_eval(ctx$session,
      "document.querySelector('#editor-diagnostics')?.hidden"))
    testthat::expect_true(region_hidden())
    toggle_lint(TRUE)
    wait_browser(ctx$session, function() {
      rows <- browser_state(ctx$session)$editor_diagnostics
      length(rows) == 1L && grepl("Custom linter failure", rows[[1L]]$message,
                                fixed = TRUE)
    }, timeout = 40, label = "notebook-level linter failure state")
    row <- browser_eval(ctx$session,
      "window.__alderHost.client.document.snapshot.editorDiagnostics['.document'][0]")
    testthat::expect_identical(row$level, "error")
    testthat::expect_identical(row$source, "lsp")
    testthat::expect_null(row$range)
    testthat::expect_equal(row$fileRange$start$line, 0)
    wait_browser(ctx$session, function() !region_hidden() && grepl(
      "Custom linter failure <not-markup>", browser_eval(ctx$session,
        "document.querySelector('#editor-diagnostics')?.textContent || ''"),
      fixed = TRUE), label = "visible notebook-level linter failure")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const region=document.querySelector('#editor-diagnostics');",
      "return region?.getAttribute('aria-labelledby') === 'editor-diagnostics-title' && ",
      "region.querySelector('[aria-live=polite]') !== null && ",
      "/^Error · /.test(region.querySelector('.diagnostic-error')?.textContent || '') && ",
      "region.querySelector('button,a,not-markup') === null})()"
    )))
    testthat::expect_false(browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.cell [data-role=diagnostics]')]",
      ".some((node)=>node.textContent.includes('Custom linter failure'))"
    )))
    testthat::expect_false(browser_eval(ctx$session,
      "document.querySelector('#status').textContent.includes('Custom linter failure')"))

    toggle_lint(FALSE)
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      isFALSE(state$config$editor$live_diagnostics) &&
        length(state$editor_diagnostics) == 0L && region_hidden() &&
        identical(browser_eval(ctx$session,
          "document.querySelector('#editor-diagnostics-list').textContent"), "")
    }, label = "disabled notebook diagnostics cleared")

    # Header notes retain all severity classes without inventing a cell range.
    # A later empty publication must clear every row.
    writeLines(paste0(
      "linters: list(header = lintr::Linter(function(source_expression) { ",
      "if (!lintr::is_lint_level(source_expression, 'file')) return(list()); ",
      "lapply(c('error', 'warning', 'style'), function(kind) lintr::Lint(",
      "filename = source_expression$filename, line_number = 1L, column_number = 1L, ",
      "type = kind, message = paste('Header', kind), line = '# %% [name=analysis]')) }))"
    ), config)
    toggle_lint(TRUE)
    wait_browser(ctx$session, function() {
      rows <- browser_state(ctx$session)$editor_diagnostics
      length(rows) == 3L && setequal(vapply(rows, `[[`, "", "level"),
                                    c("error", "warning", "info"))
    }, timeout = 40, label = "notebook diagnostic severity state")
    wait_browser(ctx$session, function() isTRUE(browser_eval(ctx$session, paste0(
      "(()=>{const region=document.querySelector('#editor-diagnostics');",
      "return !region.hidden && ",
      "/^Error · .*Header error/.test(region.querySelector('.diagnostic-error')?.textContent || '') && ",
      "/^Warning · .*Header warning/.test(region.querySelector('.diagnostic-warning')?.textContent || '') && ",
      "/^Info · .*Header style/.test(region.querySelector('.diagnostic-info')?.textContent || '') && ",
      "!region.textContent.includes('Custom linter failure')})()"
    ))), label = "visible error warning and info notes")
    id <- browser_state(ctx$session)$cells[[1L]]$id
    writeLines("linters: list()", config)
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, 'value <- 2')", js_json(id)
    )))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      isTRUE(state$config$editor$live_diagnostics) &&
        length(state$editor_diagnostics) == 0L && region_hidden()
    }, timeout = 40, label = "recovered linter clears notebook diagnostics")

    writeLines(paste0(
      "linters: list(updated = lintr::Linter(function(source_expression) { ",
      "if (!lintr::is_lint_level(source_expression, 'file')) return(list()); ",
      "if (!any(source_expression$file_lines == 'value <- 3')) return(list()); ",
      "lintr::Lint(filename = source_expression$filename, line_number = 1L, ",
      "column_number = 1L, type = 'warning', message = 'Updated source diagnostic', ",
      "line = '# %% [name=analysis]') }))"
    ), config)
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, 'value <- 3')", js_json(id)
    )))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      rows <- state$editor_diagnostics
      identical(cell_body(state$cells[[1L]]), "value <- 3") &&
        length(rows) == 1L && identical(rows[[1L]]$level, "warning") &&
        identical(rows[[1L]]$message, "Updated source diagnostic")
    }, timeout = 40, label = "fresh notebook diagnostic after ordinary edit")
    wait_browser(ctx$session, function() !region_hidden() && grepl(
      "Updated source diagnostic", browser_eval(ctx$session,
        "document.querySelector('#editor-diagnostics .diagnostic-warning')?.textContent || ''"),
      fixed = TRUE), label = "visible fresh diagnostic after ordinary edit")
  })
})

testthat::test_that("browser makes lintr opt-in without hiding Alder diagnostics", {
  with_browser_server(c(
    "# %% [name=lint_target]", "x=1",
    "# %% [name=safety_target]", "target <- \"dynamic_name\"", "assign(target, 1)"
  ), function(ctx) {
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      safety <- state$cells[[2L]]$diagnostics
      isFALSE(state$config$editor$live_diagnostics) &&
        any(vapply(safety, function(item) {
          identical(item$code, "dynamic-dependency")
        }, logical(1L)))
    }, label = "default lint policy and Alder safety diagnostic")
    testthat::expect_match(browser_eval(ctx$session, paste0(
      "document.querySelector('label[for=settings-live-diagnostics]')",
      "?.textContent || ''"
    )), "lintr", ignore.case = TRUE)
    testthat::expect_false(browser_eval(ctx$session,
      "document.querySelector('#settings-live-diagnostics').checked"))
    testthat::expect_false(any(vapply(
      browser_state(ctx$session)$cells[[1L]]$diagnostics,
      function(item) identical(item$source, "lsp"), logical(1L)
    )))
    wait_browser(ctx$session, function() grepl(
      "dynamic-dependency",
      browser_eval(ctx$session,
        paste0(
          "[...document.querySelectorAll('.diagnostics-area')]",
          ".map((node)=>node.textContent).join('|')"
        )),
      fixed = TRUE
    ), label = "visible Alder safety diagnostic with lint off")

    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    testthat::expect_true(browser_eval(ctx$session,
      "(()=>{const e=document.querySelector('#settings-live-diagnostics');e.checked=true;return e.checked})()"))
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      rows <- state$cells[[1L]]$diagnostics
      isTRUE(state$config$editor$live_diagnostics) && any(vapply(
        rows,
        function(item) identical(item$source, "lsp") && grepl(
          "assignment_linter|infix_spaces_linter",
          paste(item$code, item$message), ignore.case = TRUE
        ),
        logical(1L)
      ))
    }, timeout = 40, label = "explicit lintr diagnostic")
    wait_browser(ctx$session, function() grepl(
      "assignment_linter|infix_spaces_linter",
      browser_eval(ctx$session,
        paste0(
          "[...document.querySelectorAll('.diagnostics-area')]",
          ".map((node)=>node.textContent).join('|')"
        )),
      ignore.case = TRUE
    ), label = "visible opt-in lintr note")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.diagnostic-info')]",
      ".some((node)=>/assignment_linter|infix_spaces_linter/i.test(node.textContent))"
    )))
    testthat::expect_false(browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.diagnostic-error')]",
      ".some((node)=>/assignment_linter|infix_spaces_linter/i.test(node.textContent))"
    )))

    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    testthat::expect_true(browser_eval(ctx$session,
      "(()=>{const e=document.querySelector('#settings-live-diagnostics');e.checked=false;return !e.checked})()"))
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      all_rows <- unlist(lapply(state$cells, `[[`, "diagnostics"),
                         recursive = FALSE)
      isFALSE(state$config$editor$live_diagnostics) &&
        !any(vapply(all_rows, function(item) identical(item$source, "lsp"),
                    logical(1L)))
    }, label = "lintr state cleared")
    wait_browser(ctx$session, function() {
      visible <- browser_eval(ctx$session, paste0(
        "[...document.querySelectorAll('.diagnostics-area')]",
        ".map((node)=>node.textContent).join('|')"
      ))
      grepl("dynamic-dependency", visible, fixed = TRUE) &&
        !grepl(
          "assignment_linter|infix_spaces_linter", visible,
          ignore.case = TRUE
        )
    }, label = "visible lintr notes cleared without hiding Alder diagnostics")
    visible <- browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('.diagnostics-area')]",
      ".map((node)=>node.textContent).join('|')"
    ))
    testthat::expect_match(visible, "dynamic-dependency", fixed = TRUE)
    testthat::expect_false(grepl(
      "assignment_linter|infix_spaces_linter", visible, ignore.case = TRUE
    ))
  })
})

testthat::test_that("browser keeps dataflow available for incomplete R source", {
  with_browser_server(c(
    "# %%", "x <- 1", "# %%", "assign(\"dynamic_name\", 1)"
  ), function(ctx) {
    wait_cells_done(ctx$session, 2L)
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, 'x <-')", js_json(id)
    )))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      diagnostics <- state$cells[[1L]]$diagnostics
      any(vapply(diagnostics, function(item) {
        identical(item$code, "syntax-error")
      }, logical(1L))) && is.null(state$dataflow_error) &&
        is.null(state$dataflow$error)
    }, label = "syntax diagnostic with a valid dataflow projection")
    wait_browser(ctx$session, function() {
      visible <- browser_eval(ctx$session, paste0(
        "document.body.textContent.includes('syntax-error') && ",
        "!document.body.textContent.includes('Dataflow projection failed')"
      ))
      isTRUE(visible)
    }, label = "visible syntax diagnostic without projection failure")
  })
})

testthat::test_that("browser exposes a working editor-help retry after LSP death", {
  testthat::skip_if(.Platform$OS.type != "unix")
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    testthat::expect_true(browser_eval(ctx$session, r"((async()=>{
      const response=await fetch('/api/lsp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'textDocument/documentSymbol',params:{}})});
      const result=await response.json();return response.ok&&result.ok===true;
    })())"))
    process_table <- function() {
      output <- processx::run(
        "ps", c("-e", "-o", "pid=,ppid=,args="),
        error_on_status = FALSE
      )$stdout
      lines <- strsplit(output, "\n", fixed = TRUE)[[1L]]
      matches <- regexec(
        "^[[:space:]]*([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+(.*)$",
        lines
      )
      fields <- regmatches(lines, matches)
      fields <- fields[vapply(fields, length, integer(1L)) == 4L]
      data.frame(
        pid = vapply(fields, function(row) as.integer(row[[2L]]), integer(1L)),
        ppid = vapply(fields, function(row) as.integer(row[[3L]]), integer(1L)),
        command = vapply(fields, `[[`, "", 4L),
        stringsAsFactors = FALSE
      )
    }
    descendant_rows <- function(parent) {
      rows <- process_table()
      found <- integer()
      frontier <- as.integer(parent)
      repeat {
        children <- rows$pid[rows$ppid %in% frontier]
        children <- setdiff(children, found)
        if (!length(children)) break
        found <- c(found, children)
        frontier <- children
      }
      rows[rows$pid %in% found, , drop = FALSE]
    }
    before <- descendant_rows(ctx$proc$get_pid())
    language_server <- before$pid[grepl(
      "languageserver::run", before$command, fixed = TRUE
    )]
    testthat::expect_length(language_server, 1L)
    tools::pskill(language_server[[1L]], signal = 9L)

    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      identical(state$service_errors$lsp$code, "lsp_unavailable") &&
        identical(browser_eval(ctx$session, paste0(
          "document.querySelector('[data-status-action=retry-editor-help]')",
          "?.textContent || ''"
        )), "Retry editor help")
    }, timeout = 15, label = "persistent editor-help failure and retry")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{const b=document.querySelector(",
      "'[data-status-action=retry-editor-help]');return b?.tagName==='BUTTON'&&",
      "!b.disabled})()"
    )))
    testthat::expect_true(click_selector(
      ctx$session, "[data-status-action=retry-editor-help]"
    ))
    wait_browser(ctx$session, function() {
      state <- browser_state(ctx$session)
      is.null(state$service_errors$lsp) && is.null(browser_eval(
        ctx$session,
        "document.querySelector('[data-status-action=retry-editor-help]')"
      ))
    }, timeout = 45, label = "editor help restart")
    after <- descendant_rows(ctx$proc$get_pid())
    replacement <- after$pid[grepl(
      "languageserver::run", after$command, fixed = TRUE
    )]
    testthat::expect_length(replacement, 1L)
    testthat::expect_false(replacement[[1L]] %in% language_server)
  })
})

testthat::test_that("browser shows only diagnostics for acknowledged displayed source", {
  with_browser_server(c("# %%", "old_problem <-"), function(ctx) {
    wait_browser(ctx$session, function() {
      note <- browser_diagnostic_snapshot(ctx$session)
      !note$hidden && grepl("old_problem <-", note$text, fixed = TRUE)
    }, label = "old source syntax diagnostic")
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(hold_browser_source_requests(ctx$session))
    on.exit(browser_eval(ctx$session, "window.__sourceRequestGate?.restore()"), add = TRUE)
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, 'pending_problem <-')", js_json(id))))
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "window.__sourceRequestGate.edits.length === 1"), label = "held source edit")
    # The edit has not reached R even after the typing pause expires.
    Sys.sleep(1.1)
    pending <- browser_diagnostic_snapshot(ctx$session)
    testthat::expect_identical(pending$source, "pending_problem <-")
    testthat::expect_true(pending$hidden)
    testthat::expect_equal(pending$marked, 0)

    browser_eval(ctx$session, "window.__sourceRequestGate.release()")
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "window.__sourceRequestGate.receipts.length === 1"), label = "source edit receipt")
    wait_browser(ctx$session, function() {
      note <- browser_diagnostic_snapshot(ctx$session)
      !note$hidden && grepl("pending_problem <-", note$text, fixed = TRUE) &&
        !grepl("old_problem <-", note$text, fixed = TRUE)
    }, label = "fresh source syntax diagnostic")

    # A failed command keeps the displayed draft; the next edit retries through
    # the same current transport and must not revive the preceding diagnostics.
    browser_eval(ctx$session, "window.__sourceRequestGate.failNextEdit = true")
    testthat::expect_true(set_textarea(ctx$session, "textarea", "failed_problem <-"))
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "document.querySelector('#status').textContent.includes('Transport interrupted')"),
      label = "failed edit exposed")
    failed <- browser_diagnostic_snapshot(ctx$session)
    testthat::expect_identical(failed$source, "failed_problem <-")
    testthat::expect_true(failed$hidden)
    testthat::expect_equal(failed$marked, 0)
    testthat::expect_true(set_textarea(ctx$session, "textarea", "retried_problem <-"))
    wait_browser(ctx$session, function() {
      note <- browser_diagnostic_snapshot(ctx$session)
      !note$hidden && grepl("retried_problem <-", note$text, fixed = TRUE) &&
        !grepl("pending_problem <-", note$text, fixed = TRUE)
    }, label = "retried source syntax diagnostic")

  })
})

testthat::test_that("browser clears notebook diagnostics while source edits are pending", {
  with_browser_server(c("# %% [name=analysis]", "value <- 1"), function(ctx) {
    writeLines(paste0(
      "linters: list(source_note = lintr::Linter(function(source_expression) { ",
      "if (!lintr::is_lint_level(source_expression, 'file')) return(list()); ",
      "body_line = grep('^value <- ', source_expression$file_lines)[1L]; ",
      "if (is.na(body_line)) return(list()); ",
      "lapply(c(1L, body_line), function(line_number) lintr::Lint(",
      "filename = source_expression$filename, line_number = line_number, column_number = 1L, ",
      "type = 'warning', message = paste('Source note:', source_expression$file_lines[[body_line]]), ",
      "line = source_expression$file_lines[[line_number]])) }))"
    ), file.path(ctx$root, ".lintr"))
    testthat::expect_true(click_selector(ctx$session, "#settings-open"))
    browser_eval(ctx$session, "document.querySelector('#settings-live-diagnostics').checked = true")
    testthat::expect_true(click_selector(ctx$session, "#settings-apply"))
    wait_browser(ctx$session, function() {
      note <- browser_diagnostic_snapshot(ctx$session)
      !note$headerHidden && !note$hidden &&
        note$marked > 0 &&
        grepl("Source note: value <- 1", note$headerText, fixed = TRUE) &&
        grepl("Source note: value <- 1", note$text, fixed = TRUE)
    }, timeout = 40, label = "current cell and document source notes")
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(hold_browser_source_requests(ctx$session))
    on.exit(browser_eval(ctx$session, "window.__sourceRequestGate?.restore()"), add = TRUE)
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s, 'value <- 2')", js_json(id))))
    immediate <- browser_diagnostic_snapshot(ctx$session)
    testthat::expect_true(immediate$headerHidden)
    testthat::expect_true(immediate$hidden)
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "window.__sourceRequestGate.edits.length === 1"), label = "held document source edit")
    Sys.sleep(1.1)
    pending <- browser_diagnostic_snapshot(ctx$session)
    testthat::expect_identical(pending$source, "value <- 2")
    testthat::expect_true(pending$headerHidden)
    testthat::expect_true(pending$hidden)
    testthat::expect_equal(pending$marked, 0)
    browser_eval(ctx$session, "window.__sourceRequestGate.release()")
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "window.__sourceRequestGate.receipts.length === 1"), label = "document source edit receipt")
    wait_browser(ctx$session, function() {
      note <- browser_diagnostic_snapshot(ctx$session)
      !note$headerHidden && !note$hidden &&
        note$marked > 0 &&
        grepl("Source note: value <- 2", note$headerText, fixed = TRUE) &&
        grepl("Source note: value <- 2", note$text, fixed = TRUE) &&
        !grepl("Source note: value <- 1", note$headerText, fixed = TRUE) &&
        !grepl("Source note: value <- 1", note$text, fixed = TRUE)
    }, timeout = 40, label = "fresh cell and document source notes")
  })
})

testthat::test_that("browser hides transient diagnostics until typing is idle", {
  with_browser_server(c("# %%", "x <-"), function(ctx) {
    wait_browser(ctx$session, function() grepl("syntax", tolower(browser_eval(
      ctx$session, "(()=>{const node=document.querySelector('.cell [data-role=diagnostics]');return node&&!node.hidden?node.textContent:''})()"))),
      label = "initial syntax diagnostic")
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,%s)", js_json(id), js_json("y <-"))))
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('.cell [data-role=diagnostics]')?.hidden === true"))
    Sys.sleep(0.5)
    testthat::expect_true(browser_eval(ctx$session,
      "document.querySelector('.cell [data-role=diagnostics]')?.hidden === true"))
    wait_browser(ctx$session, function() grepl("syntax", tolower(browser_eval(
      ctx$session, "(()=>{const node=document.querySelector('.cell [data-role=diagnostics]');return node&&!node.hidden?node.textContent:''})()"))),
      timeout = 10, label = "idle syntax diagnostic")
  })
})

testthat::test_that("browser mobile starts with a non-obstructing closed dataflow drawer", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    ctx$session$Emulation$setDeviceMetricsOverride(
      width = 390L, height = 844L, deviceScaleFactor = 1, mobile = TRUE)
    browser_eval(ctx$session,
      "(()=>{localStorage.removeItem('alder.panel');location.reload();return true})()")
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel')?.hidden === true && document.querySelector('#panel-toggle')?.getAttribute('aria-expanded') === 'false'"),
      label = "closed mobile dataflow")
    testthat::expect_true(click_selector(ctx$session, "#panel-toggle"))
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "document.querySelector('#dataflow-panel')?.hidden === false"),
      label = "open mobile dataflow")
    overlap <- as.numeric(browser_eval(ctx$session, paste0(
      "(()=>{const top=document.querySelector('#topbar').getBoundingClientRect();",
      "const panel=document.querySelector('#dataflow-panel').getBoundingClientRect();",
      "return Math.max(0,top.bottom-panel.top)})()"
    )))
    testthat::expect_lte(overlap, 1)
    testthat::expect_equal(browser_eval(ctx$session,
      "getComputedStyle(document.querySelector('#minimap')).display"), "none")
  })
})

testthat::test_that("browser Shut down distinguishes lifecycle from execution Stop", {
  with_browser_server(c("# %%", "x <- 1"), function(ctx) {
    wait_cells_done(ctx$session, 1L)
    testthat::expect_equal(browser_eval(ctx$session,
      "document.querySelector('#shutdown')?.textContent"), "Shut down")
    testthat::expect_equal(browser_eval(ctx$session,
      "document.querySelector('#stop')?.textContent"), "Stop")
    id <- browser_state(ctx$session)$cells[[1L]]$id
    testthat::expect_true(browser_eval(ctx$session, sprintf(
      "((id,value)=>{((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(id).setDoc(value);return true})(%s,%s)", js_json(id), js_json("x <- 2"))))
    wait_browser(ctx$session, function() isTRUE(browser_state(ctx$session)$changed),
      label = "dirty notebook")
    browser_eval(ctx$session,
      "(()=>{window.__shutdownConfirms=0;window.confirm=()=>{window.__shutdownConfirms+=1;return false};return true})()")
    testthat::expect_true(click_selector(ctx$session, "#shutdown"))
    wait_browser(ctx$session, function() isTRUE(
      browser_eval(ctx$session, "window.__shutdownConfirms") == 1
    ), label = "dirty shutdown confirmation")
    testthat::expect_true(ctx$proc$is_alive())
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "!document.querySelector('#shutdown')?.disabled && !document.querySelector('#save')?.disabled"),
      label = "controls after rejected shutdown")
    testthat::expect_true(click_selector(ctx$session, "#save"))
    wait_browser(ctx$session, function() isFALSE(browser_state(ctx$session)$changed),
      label = "saved notebook")
    wait_browser(ctx$session, function() browser_eval(ctx$session,
      "document.querySelector('#shutdown')?.disabled === false"),
      label = "shutdown control after save")
    testthat::expect_true(click_selector(ctx$session, "#shutdown"))
    wait_browser(ctx$session, function() grepl("shut down", tolower(browser_eval(
      ctx$session, "document.querySelector('#status')?.textContent || ''")),
      fixed = TRUE), label = "accepted shutdown")
    testthat::expect_equal(browser_eval(ctx$session, "window.__shutdownConfirms"), 1)
    deadline <- Sys.time() + 10
    while (ctx$proc$is_alive() && Sys.time() < deadline) Sys.sleep(0.05)
    testthat::expect_false(ctx$proc$is_alive())
  })
})

testthat::test_that("browser outline preserves native focus through unchanged and renamed events", {
  with_browser_server(c(
    "# %% [markdown]", "#| name: overview", "# # Study overview",
    "# %%", "#| name: analysis", "x <- 1",
    "# %%", "#| name: result", "result <- x + 1", "result"
  ), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    initial <- browser_state(ctx$session)
    ids <- vapply(initial$cells, `[[`, "", "id")
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-outline"))
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{window.__outlineUpdateEvents=[];window.__outlineUpdateNavigations=[];",
      "window.__outlineUpdateBoundaries=[];",
      "document.querySelector('#dataflow-panel').addEventListener('keydown',event=>{",
      "const target=event.target.closest('.panel-link[data-target-cell]');",
      "if(target)window.__outlineUpdateEvents.push({key:event.key,",
      "isTrusted:event.isTrusted,defaultPrevented:event.defaultPrevented,",
      "target:target.dataset.targetCell})});",
      "for(const id of ", js_json(paste0("cell-", ids[2:3])), "){",
      "const cell=document.getElementById(id);const original=cell.scrollIntoView.bind(cell);",
      "cell.scrollIntoView=(...args)=>{window.__outlineUpdateNavigations.push(id);",
      "return original(...args)}}return true})()"
    )))

    record_boundary <- function(label) browser_eval(ctx$session, paste0(
      "(async()=>{const node=window.__outlineUpdateNode;",
      "const current=[...document.querySelectorAll('#panel-outline .outline-cell')].find(",
      "item=>item.dataset.targetCell===node?.dataset.targetCell);",
      "const active=document.activeElement;const result={label:", js_json(label), ",",
      "connected:node?.isConnected===true,current:current===node,focused:active===node,",
      "text:current?.textContent||'',originalText:node?.textContent||'',",
      "target:node?.dataset.targetCell||'',active:{tag:active?.tagName||'',",
      "id:active?.id||'',cell:active?.closest('.cell')?.dataset.cell||'',",
      "target:active?.dataset.targetCell||''},",
      "state:await (await fetch('/api/state')).json()};",
      "window.__outlineUpdateBoundaries.push(result);return result})()"
    ))
    focus_outline <- function(id) browser_eval(ctx$session, paste0(
      "(()=>{const node=[...document.querySelectorAll('#panel-outline .outline-cell')].find(",
      "item=>item.dataset.targetCell===", js_json(id), ");",
      "window.__outlineUpdateNode=node;node?.focus();return document.activeElement===node})()"
    ))
    host_update <- function(label) browser_host_update(ctx$session)
    press_key <- function(key, code, virtual_key) {
      ctx$session$Input$dispatchKeyEvent(
        type = "rawKeyDown", key = key, code = code,
        windowsVirtualKeyCode = virtual_key,
        nativeVirtualKeyCode = virtual_key
      )
      ctx$session$Input$dispatchKeyEvent(
        type = "keyUp", key = key, code = code,
        windowsVirtualKeyCode = virtual_key,
        nativeVirtualKeyCode = virtual_key
      )
    }

    testthat::expect_true(focus_outline(ids[[2L]]))
    record_boundary("unchanged-focused")
    host_update("unchanged outline event rendered")
    unchanged <- record_boundary("unchanged-rendered")
    testthat::expect_true(unchanged$connected)
    testthat::expect_true(unchanged$current)
    testthat::expect_true(unchanged$focused)
    testthat::expect_identical(unchanged$text, "analysis")
    press_key("Enter", "Enter", 13L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell||''"), ids[[2L]]),
      label = "trusted outline Enter after unchanged event")
    record_boundary("unchanged-enter")

    testthat::expect_true(focus_outline(ids[[3L]]))
    record_boundary("rename-focused")
    renamed <- browser_eval(ctx$session, paste0(
      "(async()=>{const response=await fetch('/api/cell',{method:'POST',",
      "headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'name',cell:",
      js_json(ids[[3L]]), ",name:'result_updated'})});",
      "return {status:response.status,body:await response.json()}})()"
    ))
    testthat::expect_identical(renamed$status, 200L)
    testthat::expect_identical(renamed$body$name, "result_updated")
    wait_browser(ctx$session, function() browser_eval(ctx$session, paste0(
      "[...document.querySelectorAll('#panel-outline .outline-cell')].some(node=>",
      "node.dataset.targetCell===", js_json(ids[[3L]]), "&&node.textContent==='result_updated')"
    )), label = "renamed outline event rendered")
    changed <- record_boundary("rename-rendered")
    testthat::expect_true(changed$connected)
    testthat::expect_true(changed$current)
    testthat::expect_true(changed$focused)
    testthat::expect_identical(changed$text, "result_updated")
    press_key(" ", "Space", 32L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell||''"), ids[[3L]]),
      label = "trusted outline Space after renamed event")
    record_boundary("rename-space")

    events <- browser_eval(ctx$session, "window.__outlineUpdateEvents")
    testthat::expect_identical(vapply(events, `[[`, "", "key"), c("Enter", " "))
    testthat::expect_true(all(vapply(events, `[[`, FALSE, "isTrusted")))
    testthat::expect_true(all(vapply(events, `[[`, FALSE, "defaultPrevented")))
    testthat::expect_identical(unlist(browser_eval(ctx$session,
      "window.__outlineUpdateNavigations"), use.names = FALSE), paste0("cell-", ids[2:3]))
  })
})

testthat::test_that("browser dataflow controls retain native focus and scroll through host updates", {
  lines <- c(
    "# %%", "#| name: source_values", "x <- 1", "y <- 2",
    "# %%", "#| name: combined_values", "value_02 <- x + y"
  )
  for (index in 3:10) {
    lines <- c(lines, "# %%", sprintf("#| name: stage_%02d", index),
               sprintf("value_%02d <- value_%02d + 1", index, index - 1L))
  }
  with_browser_server(lines, function(ctx) {
    wait_cells_done(ctx$session, 10L)
    ctx$session$Emulation$setDeviceMetricsOverride(
      width = 1350L, height = 800L, deviceScaleFactor = 1, mobile = FALSE)
    initial <- browser_state(ctx$session)
    ids <- vapply(initial$cells, `[[`, "", "id")
    browser_eval(ctx$session, "window.__siblingFocusBoundaries=[];true")

    record_boundary <- function(label) browser_eval(ctx$session, paste0(
      "(()=>{const node=window.__siblingFocusNode;const current=window.__siblingFindNode();",
      "const active=document.activeElement;",
      "const referenceSection=document.querySelector('#panel-dependencies .dependency-section');",
      "const result={label:", js_json(label), ",",
      "connected:node?.isConnected===true,current:current===node,focused:active===node,",
      "text:current?.textContent||'',originalText:node?.textContent||'',",
      "scrollTop:current?.scrollTop||0,scrollLeft:current?.scrollLeft||0,",
      "scrollHeight:current?.scrollHeight||0,clientHeight:current?.clientHeight||0,",
      "active:{tag:active?.tagName||'',id:active?.id||'',",
      "target:active?.dataset.targetCell||'',action:active?.dataset.graphAction||''},",
      "references:referenceSection?[...referenceSection.querySelectorAll('.panel-link')]",
      ".map(node=>({target:node.dataset.targetCell,",
      "text:node.textContent})):[]};window.__siblingFocusBoundaries.push(result);return result})()"
    ))
    host_update <- function(label) browser_host_update(ctx$session)
    cases <- list(
      list(name = "variable-owner", tab = "variables", find = paste0(
        "[...document.querySelectorAll('#panel-variables .variable-row')].find(",
        "node=>node.querySelector('.variable-name')?.textContent==='x')")),
      list(name = "dependency-reference", tab = "dependencies", find = paste0(
        "[...document.querySelectorAll('#panel-dependencies .panel-link')].find(",
        "node=>node.textContent==='x ← Cell 1 · source_values')")),
      list(name = "graph-toolbar", tab = "graph", find =
        "document.querySelector('#panel-graph [data-graph-action=zoom-in]')"),
      list(name = "graph-node", tab = "graph", find = paste0(
        "document.querySelector('#panel-graph .dag-node[data-target-cell=\"",
        ids[[3L]], "\"]')")),
      list(name = "graph-scroll", tab = "graph", find =
        "document.querySelector('#panel-graph .graph-scroll')"),
      list(name = "minimap-cell", tab = "outline", find = paste0(
        "document.querySelector('#minimap .minimap-cell[data-target-cell=\"",
        ids[[3L]], "\"]')"))
    )
    for (case in cases) {
      if (identical(case$name, "dependency-reference")) {
        testthat::expect_true(browser_eval(ctx$session, paste0(
          "(()=>{const editor=((id)=>window.__alderEditors.get(window.__alderHost.client.document.cell(id)?.key))(", js_json(ids[[2L]]), ");",
          "editor.focus();return editor.view.hasFocus})()"
        )))
      }
      testthat::expect_true(click_selector(ctx$session, paste0("#panel-tab-", case$tab)))
      wait_browser(ctx$session, function() browser_eval(ctx$session,
        paste0("Boolean(", case$find, ")")), label = paste(case$name, "projected"))
      focused <- browser_eval(ctx$session, paste0(
        "(()=>{window.__siblingFindNode=()=>", case$find, ";",
        "const node=window.__siblingFindNode();window.__siblingFocusNode=node;",
        "node?.focus({preventScroll:true});",
        if (identical(case$name, "graph-scroll")) "if(node)node.scrollTop=100;" else "",
        "return {focused:document.activeElement===node,connected:node?.isConnected===true,",
        "tabIndex:node?.tabIndex??-1,disabled:node?.disabled===true}})()"
      ))
      testthat::expect_true(focused$focused, info = case$name)
      testthat::expect_true(focused$connected, info = case$name)
      testthat::expect_true(focused$tabIndex >= 0L, info = case$name)
      testthat::expect_false(focused$disabled, info = case$name)
      before <- record_boundary(paste0(case$name, "-before"))
      if (identical(case$name, "graph-scroll")) {
        testthat::expect_gt(before$scrollTop, 0)
        testthat::expect_gt(before$scrollHeight, before$clientHeight)
      }
      if (identical(case$name, "dependency-reference")) {
        testthat::expect_identical(vapply(before$references, `[[`, "", "text"),
                                   c("x ← Cell 1 · source_values",
                                     "y ← Cell 1 · source_values"))
        testthat::expect_identical(vapply(before$references, `[[`, "", "target"),
                                   rep(ids[[1L]], 2L))
      }
      host_update(paste0(case$name, " event rendered"))
      after <- record_boundary(paste0(case$name, "-after"))
      testthat::expect_true(after$connected, info = case$name)
      testthat::expect_true(after$current, info = case$name)
      testthat::expect_true(after$focused, info = case$name)
      testthat::expect_identical(after$text, before$text, info = case$name)
      if (identical(case$name, "graph-scroll")) {
        testthat::expect_equal(after$scrollTop, before$scrollTop)
        testthat::expect_equal(after$scrollLeft, before$scrollLeft)
      }
      if (identical(case$name, "dependency-reference")) {
        testthat::expect_identical(after$references, before$references)
      }
    }
  })
})

testthat::test_that("browser navigation preserves focus while targets move appear and disappear", {
  with_browser_server(c(
    "# %%", "#| name: first", "a <- 1",
    "# %%", "#| name: second", "b <- 2",
    "# %%", "#| name: third", "c <- 3"
  ), function(ctx) {
    wait_cells_done(ctx$session, 3L)
    initial <- browser_state(ctx$session)
    ids <- vapply(initial$cells, `[[`, "", "id")
    testthat::expect_true(click_selector(ctx$session, "#panel-tab-outline"))
    browser_eval(ctx$session, "window.__navigationOrderBoundaries=[];true")
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "(()=>{window.__navigationOrderFind=()=>[...document.querySelectorAll(",
      "'#panel-outline .outline-cell')].find(node=>node.dataset.targetCell===",
      js_json(ids[[2L]]), ");window.__navigationOrderNode=window.__navigationOrderFind();",
      "window.__navigationOrderEvents=[];window.__navigationOrderCalls=[];",
      "document.querySelector('#dataflow-panel').addEventListener('keydown',event=>{",
      "if(event.target===window.__navigationOrderNode)window.__navigationOrderEvents.push({",
      "key:event.key,isTrusted:event.isTrusted,defaultPrevented:event.defaultPrevented})});",
      "const cell=document.getElementById(", js_json(paste0("cell-", ids[[2L]])), ");",
      "const original=cell.scrollIntoView.bind(cell);cell.scrollIntoView=(...args)=>{",
      "window.__navigationOrderCalls.push(cell.dataset.cell);return original(...args)};",
      "window.__navigationOrderNode.focus();",
      "return document.activeElement===window.__navigationOrderNode})()"
    )))
    snapshot <- function(label) browser_eval(ctx$session, paste0(
      "(async()=>{const node=window.__navigationOrderNode;",
      "const result={label:", js_json(label), ",connected:node.isConnected,",
      "current:window.__navigationOrderFind()===node,focused:document.activeElement===node,",
      "outline:[...document.querySelectorAll('#panel-outline .outline-cell')]",
      ".map(node=>node.dataset.targetCell),",
      "labels:[...document.querySelectorAll('#panel-outline .outline-cell')]",
      ".map(node=>node.textContent),",
      "minimap:[...document.querySelectorAll('#minimap .minimap-cell')]",
      ".map(node=>node.dataset.targetCell),",
      "state:await (await fetch('/api/state')).json()};",
      "window.__navigationOrderBoundaries.push(result);return result})()"
    ))
    mutate <- function(body) {
      response <- browser_eval(ctx$session, paste0(
        "(async()=>{const response=await fetch('/api/cell',{method:'POST',",
        "headers:{'Content-Type':'application/json'},body:JSON.stringify(",
        js_json(body), ")});return {status:response.status,body:await response.json()}})()"
      ))
      testthat::expect_identical(response$status, 200L)
      response$body
    }
    delete_target <- function(id) {
      state <- browser_state(ctx$session)
      cell <- state$cells[[match(id, vapply(state$cells, `[[`, "", "id"))]]
      mutate(list(op = "delete", id = id, expected_revision = cell$revision))
    }
    host_update <- function(label) browser_host_update(ctx$session)
    deliver_change <- function(receipt, label) {
      wait_browser(ctx$session, function() browser_eval(ctx$session, paste0(
        "window.__alderHost.client.document.snapshot.version>=", js_json(receipt$version)
      )), label = paste(label, "host event received"))
      browser_host_update(ctx$session)
      snapshot(label)
    }
    expect_current_order <- function(result, order, labels, focused = TRUE) {
      testthat::expect_identical(result$connected, focused, info = result$label)
      testthat::expect_identical(result$current, focused, info = result$label)
      testthat::expect_identical(result$focused, focused, info = result$label)
      testthat::expect_identical(unlist(result$outline, use.names = FALSE), order)
      testthat::expect_identical(unlist(result$minimap, use.names = FALSE), order)
      testthat::expect_identical(unlist(result$labels, use.names = FALSE), labels)
      testthat::expect_identical(vapply(result$state$cells, `[[`, "", "id"), order)
    }
    expect_current_order(snapshot("initial"), ids, c("first", "second", "third"))
    moved <- mutate(list(op = "move", cell = ids[[2L]], after = NULL))
    expect_current_order(deliver_change(moved, "moved-focused-target"),
                         ids[c(2L, 1L, 3L)], c("second", "first", "third"))
    added <- mutate(list(op = "add", after = NULL, body = list("d <- 4"), type = "code"))
    testthat::expect_false(added$id %in% ids)
    mutate(list(op = "name", cell = added$id, name = "new_first"))
    # Adding with a null predecessor appends. Explicitly move the new target
    # before B so this phase exercises insertion before a retained focus.
    inserted <- mutate(list(op = "move", cell = added$id, after = NULL))
    expect_current_order(deliver_change(inserted, "inserted-before-focused-target"),
                         c(added$id, ids[c(2L, 1L, 3L)]),
                         c("new_first", "second", "first", "third"))
    removed <- delete_target(ids[[1L]])
    expect_current_order(deliver_change(removed, "removed-other-target"),
                         c(added$id, ids[c(2L, 3L)]), c("new_first", "second", "third"))

    ctx$session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "Enter", code = "Enter",
      windowsVirtualKeyCode = 13L, nativeVirtualKeyCode = 13L)
    ctx$session$Input$dispatchKeyEvent(type = "keyUp", key = "Enter", code = "Enter",
      windowsVirtualKeyCode = 13L, nativeVirtualKeyCode = 13L)
    wait_browser(ctx$session, function() identical(browser_eval(ctx$session,
      "document.activeElement?.closest('.cell')?.dataset.cell||''"), ids[[2L]]),
      label = "trusted navigation to moved target")
    events <- browser_eval(ctx$session, "window.__navigationOrderEvents")
    testthat::expect_identical(vapply(events, `[[`, "", "key"), "Enter")
    testthat::expect_true(all(vapply(events, `[[`, FALSE, "isTrusted")))
    testthat::expect_true(all(vapply(events, `[[`, FALSE, "defaultPrevented")))
    testthat::expect_identical(unlist(browser_eval(ctx$session,
      "window.__navigationOrderCalls"), use.names = FALSE), ids[[2L]])
    testthat::expect_true(browser_eval(ctx$session, paste0(
      "window.__navigationOrderNode.focus();",
      "document.activeElement===window.__navigationOrderNode"
    )))
    removed <- delete_target(ids[[2L]])
    expect_current_order(deliver_change(removed, "removed-focused-target"),
                         c(added$id, ids[[3L]]), c("new_first", "third"), focused = FALSE)
  })
})
