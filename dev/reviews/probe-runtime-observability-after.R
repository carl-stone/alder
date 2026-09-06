#!/usr/bin/env Rscript

# Post-fix Cycle-2 acceptance probe for the installed CLI, browser telemetry,
# interruption recovery, and editor-help recovery. This probe intentionally
# performs no injected client failure and never writes into CodeMirror-owned
# DOM. Source changes go through Alder's editor handle; completion, signature
# help, Stop, settings, retry, save, and Shutdown use their real browser paths.

required_env <- function(name) {
  value <- Sys.getenv(name, unset = "")
  if (!nzchar(value)) stop(name, " is required", call. = FALSE)
  value
}

`%||%` <- function(left, right) {
  if (is.null(left)) right else left
}

snapshot_root <- normalizePath(
  required_env("ALDER_RUNTIME_SNAPSHOT_ROOT"), mustWork = TRUE
)
evidence <- required_env("ALDER_RUNTIME_EVIDENCE")
dir.create(evidence, recursive = TRUE, showWarnings = FALSE)
evidence <- normalizePath(evidence, mustWork = TRUE)

library_candidates <- c(file.path(snapshot_root, "lib"), snapshot_root)
library_candidates <- library_candidates[dir.exists(library_candidates)]
installed <- vapply(library_candidates, function(path) {
  dir.exists(file.path(path, "alder"))
}, logical(1L))
if (!any(installed)) {
  stop(
    "ALDER_RUNTIME_SNAPSHOT_ROOT must be an installed library or contain lib/alder",
    call. = FALSE
  )
}
snapshot_lib <- normalizePath(library_candidates[which(installed)[[1L]]],
                              mustWork = TRUE)
.libPaths(c(snapshot_lib, .libPaths()))

required_packages <- c("alder", "chromote", "curl", "httpuv", "jsonlite",
                       "later", "processx")
missing_packages <- required_packages[!vapply(
  required_packages, requireNamespace, logical(1L), quietly = TRUE
)]
if (length(missing_packages)) {
  stop("required packages are unavailable: ",
       paste(missing_packages, collapse = ", "), call. = FALSE)
}

alder_path <- normalizePath(find.package("alder"), mustWork = TRUE)
library_prefix <- paste0(snapshot_lib, .Platform$file.sep)
if (!startsWith(paste0(alder_path, .Platform$file.sep), library_prefix)) {
  stop("alder did not resolve from the supplied installed library", call. = FALSE)
}

write_json <- function(value, name) {
  jsonlite::write_json(
    value, file.path(evidence, name), auto_unbox = TRUE,
    null = "null", na = "null", pretty = TRUE
  )
}

js_json <- function(value) {
  as.character(jsonlite::toJSON(value, auto_unbox = TRUE, null = "null"))
}

probe_results <- new.env(parent = emptyenv())
probe_results$metadata <- list(
  probe = "post-fix runtime/browser observability",
  runtime = R.version.string,
  alder = as.character(utils::packageVersion("alder")),
  alder_path = alder_path,
  snapshot_root = snapshot_root,
  installed_library = snapshot_lib,
  evidence = evidence,
  started_at = format(Sys.time(), tz = "UTC", usetz = TRUE)
)
probe_results$assertions <- list()
probe_results$fatal <- NULL

record <- function(name, passed, detail = NULL) {
  probe_results$assertions[[name]] <- list(
    passed = isTRUE(passed), detail = detail
  )
  cat(sprintf(
    "[%s] %s%s\n", if (isTRUE(passed)) "PASS" else "FAIL", name,
    if (is.null(detail)) "" else paste0(": ", detail)
  ))
  invisible(isTRUE(passed))
}

remote_argument <- function(argument) {
  list(
    type = argument$type %||% NULL,
    subtype = argument$subtype %||% NULL,
    value = argument$value %||% NULL,
    description = argument$description %||% NULL
  )
}

process_start_id <- function(pid) {
  path <- sprintf("/proc/%d/stat", as.integer(pid))
  if (!file.exists(path)) return(NA_character_)
  vanished <- function(condition) {
    !file.exists(path) &&
      grepl("cannot open", conditionMessage(condition), fixed = TRUE)
  }
  line <- tryCatch(
    withCallingHandlers(
      readLines(path, warn = FALSE, n = 1L),
      warning = function(warning) {
        if (vanished(warning)) invokeRestart("muffleWarning")
      }
    ),
    error = function(error) {
      if (vanished(error)) return(character())
      stop(error)
    }
  )
  if (!length(line)) return(NA_character_)
  fields <- strsplit(sub("^.*[)] ", "", line[[1L]]), " ", fixed = TRUE)[[1L]]
  if (length(fields) < 20L) return(NA_character_)
  fields[[20L]]
}

process_rows <- function() {
  output <- processx::run(
    "ps", c("-e", "-o", "pid=,ppid=,args="), error_on_status = FALSE
  )$stdout
  lines <- strsplit(output, "\n", fixed = TRUE)[[1L]]
  rows <- lapply(lines, function(line) {
    match <- regexec(
      "^[[:space:]]*([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+(.*)$", line
    )
    fields <- regmatches(line, match)[[1L]]
    if (length(fields) != 4L) return(NULL)
    pid <- as.integer(fields[[2L]])
    list(
      pid = pid, ppid = as.integer(fields[[3L]]), args = fields[[4L]],
      start_id = process_start_id(pid)
    )
  })
  rows[!vapply(rows, is.null, logical(1L))]
}

descendants <- function(parent) {
  rows <- process_rows()
  found <- integer()
  frontier <- as.integer(parent)
  repeat {
    children <- rows[vapply(rows, function(row) {
      row$ppid %in% frontier
    }, logical(1L))]
    child_pids <- unique(vapply(children, `[[`, integer(1L), "pid"))
    child_pids <- setdiff(child_pids, found)
    if (!length(child_pids)) break
    found <- c(found, child_pids)
    frontier <- child_pids
  }
  rows[vapply(rows, function(row) row$pid %in% found, logical(1L))]
}

same_process_alive <- function(identity) {
  current <- process_rows()
  match <- current[vapply(current, function(row) {
    identical(row$pid, identity$pid) &&
      identical(row$start_id, identity$start_id)
  }, logical(1L))]
  length(match) > 0L
}

format_process_rows <- function(rows) {
  if (!length(rows)) return("<none>")
  vapply(rows, function(row) {
    sprintf(
      "pid=%d ppid=%d start=%s args=%s", row$pid, row$ppid,
      row$start_id %||% "", row$args
    )
  }, character(1L))
}

port_open <- function(port) {
  tryCatch({
    handle <- curl::new_handle(connecttimeout_ms = 200L, timeout_ms = 400L)
    curl::curl_fetch_memory(
      sprintf("http://127.0.0.1:%d/api/state", port), handle = handle
    )
    TRUE
  }, error = function(error) FALSE)
}

main <- function() {
  cli <- NULL
  browser <- NULL
  session <- NULL
  stdout_lines <- character()
  stderr_lines <- character()
  visible_status <- list()
  process_snapshots <- list()
  tracked_descendants <- list()
  window_events <- list()
  retry_accessibility <- list()
  events <- new.env(parent = emptyenv())
  events$phase <- "startup"
  events$requests <- list()
  events$responses <- list()
  events$failures <- list()
  events$console <- list()
  events$exceptions <- list()
  events$log_entries <- list()
  events$request_urls <- new.env(parent = emptyenv())

  drain_cli <- function() {
    if (is.null(cli)) return(invisible(NULL))
    stdout_lines <<- c(stdout_lines, cli$read_output_lines())
    stderr_lines <<- c(stderr_lines, cli$read_error_lines())
    invisible(NULL)
  }

  browser_eval <- function(expression) {
    response <- session$Runtime$evaluate(
      expression, returnByValue = TRUE, awaitPromise = TRUE
    )
    if (!is.null(response$exceptionDetails)) {
      detail <- response$exceptionDetails
      stop(
        detail$exception$description %||% detail$text %||%
          "browser evaluation failed",
        call. = FALSE
      )
    }
    response$result$value
  }

  pump <- function(seconds = 0.1) {
    deadline <- Sys.time() + seconds
    while (Sys.time() < deadline) {
      try(browser_eval("true"), silent = TRUE)
      later::run_now(0.01)
      Sys.sleep(0.02)
    }
    invisible(NULL)
  }

  wait_until <- function(predicate, timeout = 20, label = "condition") {
    deadline <- Sys.time() + timeout
    last <- NULL
    while (Sys.time() < deadline) {
      last <- tryCatch(predicate(), error = identity)
      if (isTRUE(last)) return(TRUE)
      pump(0.05)
    }
    cat(
      "TIMEOUT: ", label, " last=",
      paste(capture.output(str(last)), collapse = " "), "\n", sep = ""
    )
    FALSE
  }

  state <- function() {
    browser_eval("(async()=>await (await fetch('/api/state')).json())()")
  }

  cell <- function(current, id) {
    for (item in current$cells) {
      if (identical(item$id, id)) return(item)
    }
    NULL
  }

  cell_text <- function(current, id) {
    item <- cell(current, id)
    if (is.null(item)) return(NA_character_)
    paste(item$body, collapse = "\n")
  }

  cell_output_text <- function(item) {
    outputs <- item$outputs %||% list()
    if (!length(outputs)) return("")
    as.character(outputs[[length(outputs)]]$text %||% "")
  }

  click_selector <- function(selector) {
    browser_eval(sprintf(
      paste0(
        "(()=>{const element=document.querySelector(%s);",
        "if(!element)return false;element.focus();element.click();return true})()"
      ),
      js_json(selector)
    ))
  }

  set_checkbox <- function(selector, checked) {
    browser_eval(sprintf(
      paste0(
        "(()=>{const element=document.querySelector(%s);",
        "if(!element)return false;if(element.checked!==%s)element.click();",
        "return element.checked===%s})()"
      ),
      js_json(selector), if (checked) "true" else "false",
      if (checked) "true" else "false"
    ))
  }

  set_doc <- function(id, source) {
    changed <- browser_eval(sprintf(
      "window.__alderSetCellSource(%s,%s)", js_json(id), js_json(source)
    ))
    committed <- wait_until(function() {
      identical(cell_text(state(), id), source)
    }, 12, paste("source commit", source))
    isTRUE(changed) && committed
  }

  focus_editor_end <- function(id) {
    browser_eval(sprintf(
      paste0(
        "(()=>{const editor=window.__alderEditors.get(%s);",
        "if(!editor)return false;const end=editor.view.state.doc.length;",
        "editor.view.dispatch({selection:{anchor:end}});editor.focus();",
        "return true})()"
      ),
      js_json(id)
    ))
  }

  press_key <- function(key, code, virtual_key, modifiers = 0L) {
    session$Input$dispatchKeyEvent(
      type = "keyDown", key = key, code = code,
      windowsVirtualKeyCode = as.integer(virtual_key),
      nativeVirtualKeyCode = as.integer(virtual_key),
      modifiers = as.integer(modifiers)
    )
    session$Input$dispatchKeyEvent(
      type = "keyUp", key = key, code = code,
      windowsVirtualKeyCode = as.integer(virtual_key),
      nativeVirtualKeyCode = as.integer(virtual_key),
      modifiers = as.integer(modifiers)
    )
    invisible(NULL)
  }

  type_open_parenthesis <- function() {
    session$Input$dispatchKeyEvent(
      type = "rawKeyDown", key = "(", code = "Digit9",
      windowsVirtualKeyCode = 57L, nativeVirtualKeyCode = 57L,
      modifiers = 8L
    )
    session$Input$dispatchKeyEvent(
      type = "char", key = "(", code = "Digit9", text = "(",
      unmodifiedText = "(", windowsVirtualKeyCode = 57L,
      nativeVirtualKeyCode = 57L, modifiers = 8L
    )
    session$Input$dispatchKeyEvent(
      type = "keyUp", key = "(", code = "Digit9",
      windowsVirtualKeyCode = 57L, nativeVirtualKeyCode = 57L,
      modifiers = 8L
    )
    invisible(NULL)
  }

  capture_status <- function(label) {
    value <- browser_eval(paste0(
      "(()=>{const element=document.querySelector('#status');return {",
      "text:element?.textContent||'',className:element?.className||'',",
      "role:element?.getAttribute('role')||'',",
      "ariaLive:element?.getAttribute('aria-live')||'',",
      "visible:Boolean(element&&element.getClientRects().length)}})()"
    ))
    visible_status[[label]] <<- value
    value
  }

  snapshot_processes <- function(label) {
    rows <- if (!is.null(cli) && cli$is_alive()) {
      descendants(cli$get_pid())
    } else {
      list()
    }
    process_snapshots[[label]] <<- rows
    for (row in rows) {
      key <- paste(row$pid, row$start_id, sep = ":")
      tracked_descendants[[key]] <<- row
    }
    writeLines(
      format_process_rows(rows), file.path(evidence, paste0(label, ".txt"))
    )
    rows
  }

  append_event <- function(name, value) {
    events[[name]][[length(events[[name]]) + 1L]] <- value
    invisible(NULL)
  }

  lsp_methods <- function() {
    methods <- lapply(events$requests, function(request) {
      if (!grepl("/api/lsp$", request$url %||% "")) return(NULL)
      body <- tryCatch(
        jsonlite::fromJSON(request$post_data %||% "{}", simplifyVector = FALSE),
        error = function(error) list()
      )
      list(method = body$method %||% "", phase = request$phase %||% "")
    })
    methods[!vapply(methods, is.null, logical(1L))]
  }

  assistance_error_count <- function() {
    values <- c(
      vapply(events$exceptions, function(event) {
        paste(event$text %||% "", event$exception$description %||% "")
      }, character(1L)),
      vapply(events$console, function(event) {
        paste(vapply(event$arguments, function(argument) {
          as.character(argument$value %||% argument$description %||% "")
        }, character(1L)), collapse = " ")
      }, character(1L)),
      vapply(events$log_entries, function(event) event$text %||% "",
             character(1L)),
      stderr_lines
    )
    if (!is.null(session)) {
      observed <- tryCatch(browser_eval(
        "window.__alderProbeWindowEvents || []"
      ), error = function(error) list())
      values <- c(values, vapply(observed, function(event) {
        paste(event$message %||% "", event$reason %||% "")
      }, character(1L)))
    }
    sum(grepl("RangeError|Field is not present in this state", values,
              ignore.case = TRUE))
  }

  save_screenshot <- function(name) {
    session$screenshot(filename = file.path(evidence, name))
    invisible(NULL)
  }

  on.exit({
    if (!is.null(session)) {
      window_events <- tryCatch(browser_eval(
        "window.__alderProbeWindowEvents || []"
      ), error = function(error) window_events)
    }
    if (!is.null(session)) try(session$close(), silent = TRUE)
    if (!is.null(browser)) try(browser$close(), silent = TRUE)
    if (!is.null(cli) && cli$is_alive()) try(cli$kill_tree(), silent = TRUE)
    if (!is.null(cli)) try(cli$wait(5000), silent = TRUE)
    try(drain_cli(), silent = TRUE)
    try(writeLines(stdout_lines, file.path(evidence, "20-cli-stdout.txt")),
        silent = TRUE)
    try(writeLines(stderr_lines, file.path(evidence, "21-server-stderr.txt")),
        silent = TRUE)
    try(write_json(events$requests, "22-network-requests.json"), silent = TRUE)
    try(write_json(events$responses, "23-network-responses.json"), silent = TRUE)
    try(write_json(events$failures, "24-network-failures.json"), silent = TRUE)
    try(write_json(events$console, "25-browser-console.json"), silent = TRUE)
    try(write_json(events$exceptions, "26-runtime-exceptions.json"), silent = TRUE)
    try(write_json(events$log_entries, "27-chrome-log-security.json"),
        silent = TRUE)
    try(write_json(window_events, "28-window-errors-rejections.json"),
        silent = TRUE)
    try(write_json(visible_status, "29-visible-status.json"), silent = TRUE)
    try(write_json(retry_accessibility, "30-retry-accessibility.json"),
        silent = TRUE)
    try(write_json(process_snapshots, "31-process-snapshots.json"), silent = TRUE)
    probe_results$metadata$finished_at <- format(
      Sys.time(), tz = "UTC", usetz = TRUE
    )
    payload <- list(
      metadata = probe_results$metadata,
      assertions = probe_results$assertions,
      fatal = probe_results$fatal
    )
    try(write_json(payload, "40-results.json"), silent = TRUE)
  }, add = TRUE)

  status <- tryCatch({
    runtime_ok <- identical(
      paste(R.version$major, R.version$minor, sep = "."), "4.6.1"
    )
    record("probe runtime is R 4.6.1", runtime_ok, R.version.string)
    if (!runtime_ok) stop("the acceptance probe requires R 4.6.1")

    rscript <- processx::run(
      "Rscript", "--version", error_on_status = FALSE
    )
    rscript_version <- trimws(paste(rscript$stdout, rscript$stderr))
    launcher_runtime_ok <- identical(rscript$status, 0L) &&
      grepl("Rscript [(]R[)] version 4[.]6[.]1", rscript_version)
    record(
      "packaged launcher resolves R 4.6.1", launcher_runtime_ok,
      rscript_version
    )
    if (!launcher_runtime_ok) stop("the packaged launcher would not use R 4.6.1")

    launcher <- system.file("exec", "alder", package = "alder", mustWork = TRUE)
    record(
      "Alder resolves from supplied installed library",
      startsWith(paste0(alder_path, .Platform$file.sep), library_prefix),
      alder_path
    )

    project <- file.path(evidence, "runtime-observability-project")
    dir.create(project, recursive = TRUE, showWarnings = FALSE)
    notebook <- file.path(project, "review.R")
    writeLines(c("# %%", "x <- 1", "", "# %%", "x + 1"), notebook,
               useBytes = TRUE)
    port <- httpuv::randomPort()
    environment <- Sys.getenv()
    environment[["R_LIBS_USER"]] <- snapshot_lib
    environment[["R_LIBS"]] <- snapshot_lib
    environment[["BROWSER"]] <- "false"

    cli <- processx::process$new(
      launcher,
      c(
        "edit", notebook, "--no-open", "--port", as.character(port),
        "--no-idle-timeout"
      ),
      env = environment, stdout = "|", stderr = "|", cleanup_tree = TRUE
    )
    ready <- FALSE
    deadline <- Sys.time() + 75
    while (cli$is_alive() && Sys.time() < deadline) {
      drain_cli()
      if (any(grepl("alder running at ", stdout_lines, fixed = TRUE))) {
        ready <- TRUE
        break
      }
      Sys.sleep(0.04)
    }
    record(
      "one-command installed CLI becomes ready", ready,
      paste(tail(c(stdout_lines, stderr_lines), 6L), collapse = " | ")
    )
    if (!ready) stop("installed CLI startup failed")
    snapshot_processes("04-process-tree-start")

    chrome_tmp <- tempfile("alder-runtime-observability-chrome-",
                           tmpdir = snapshot_root)
    dir.create(chrome_tmp, recursive = TRUE, showWarnings = FALSE)
    old_tmp <- Sys.getenv("TMPDIR", unset = NA_character_)
    Sys.setenv(TMPDIR = chrome_tmp)
    browser <- tryCatch(chromote::Chrome$new(), error = function(error) NULL)
    if (!is.null(browser) && is.function(browser$new_session)) {
      session <- browser$new_session()
    } else {
      if (!is.null(browser)) try(browser$close(), silent = TRUE)
      browser <- NULL
      session <- chromote::ChromoteSession$new()
    }
    if (is.na(old_tmp)) Sys.unsetenv("TMPDIR") else Sys.setenv(TMPDIR = old_tmp)

    session$Page$enable()
    session$Network$enable()
    session$Runtime$enable()
    log_enabled <- tryCatch({
      session$Log$enable()
      TRUE
    }, error = function(error) FALSE)
    accessibility_enabled <- tryCatch({
      session$Accessibility$enable()
      TRUE
    }, error = function(error) FALSE)
    record("Chrome Log/security collection is enabled", log_enabled)
    record("Chrome accessibility collection is enabled", accessibility_enabled)

    session$Network$requestWillBeSent(function(params) {
      request <- params$request %||% list()
      url <- request$url %||% ""
      request_id <- as.character(params$requestId %||% "")
      if (nzchar(request_id)) events$request_urls[[request_id]] <- url
      append_event("requests", list(
        phase = events$phase, request_id = request_id,
        timestamp = params$timestamp %||% NULL,
        type = params$type %||% NULL,
        method = request$method %||% NULL,
        url = url,
        post_data = request$postData %||% NULL,
        initiator_type = params$initiator$type %||% NULL
      ))
    }, wait_ = FALSE)
    session$Network$responseReceived(function(params) {
      response <- params$response %||% list()
      append_event("responses", list(
        phase = events$phase,
        request_id = as.character(params$requestId %||% ""),
        timestamp = params$timestamp %||% NULL,
        type = params$type %||% NULL,
        status = response$status %||% NULL,
        status_text = response$statusText %||% NULL,
        mime_type = response$mimeType %||% NULL,
        url = response$url %||% NULL
      ))
    }, wait_ = FALSE)
    session$Network$loadingFailed(function(params) {
      request_id <- as.character(params$requestId %||% "")
      url <- if (exists(request_id, envir = events$request_urls,
                        inherits = FALSE)) {
        events$request_urls[[request_id]]
      } else {
        ""
      }
      append_event("failures", list(
        phase = events$phase, request_id = request_id, url = url,
        timestamp = params$timestamp %||% NULL,
        type = params$type %||% NULL,
        error_text = params$errorText %||% NULL,
        canceled = params$canceled %||% FALSE,
        blocked_reason = params$blockedReason %||% NULL
      ))
    }, wait_ = FALSE)
    session$Runtime$consoleAPICalled(function(params) {
      append_event("console", list(
        phase = events$phase,
        timestamp = params$timestamp %||% NULL,
        type = params$type %||% NULL,
        arguments = lapply(params$args %||% list(), remote_argument)
      ))
    }, wait_ = FALSE)
    session$Runtime$exceptionThrown(function(params) {
      detail <- params$exceptionDetails %||% list()
      append_event("exceptions", list(
        phase = events$phase,
        timestamp = params$timestamp %||% NULL,
        text = detail$text %||% NULL,
        line_number = detail$lineNumber %||% NULL,
        column_number = detail$columnNumber %||% NULL,
        url = detail$url %||% NULL,
        exception = remote_argument(detail$exception %||% list())
      ))
    }, wait_ = FALSE)
    if (log_enabled) {
      session$Log$entryAdded(function(params) {
        entry <- params$entry %||% list()
        append_event("log_entries", list(
          phase = events$phase,
          timestamp = entry$timestamp %||% NULL,
          source = entry$source %||% NULL,
          level = entry$level %||% NULL,
          text = entry$text %||% NULL,
          url = entry$url %||% NULL,
          line_number = entry$lineNumber %||% NULL
        ))
      }, wait_ = FALSE)
    }

    listener_source <- paste0(
      "(()=>{window.__alderProbeWindowEvents=[];",
      "window.addEventListener('error',event=>{",
      "window.__alderProbeWindowEvents.push({type:'error',",
      "message:event.message||'',filename:event.filename||'',",
      "line:event.lineno||0,column:event.colno||0,",
      "stack:event.error?.stack||''})});",
      "window.addEventListener('unhandledrejection',event=>{",
      "window.__alderProbeWindowEvents.push({type:'unhandledrejection',",
      "reason:String(event.reason?.message||event.reason||''),",
      "stack:event.reason?.stack||''})});return true})()"
    )
    listener <- session$Page$addScriptToEvaluateOnNewDocument(
      source = listener_source
    )
    record(
      "window error/rejection listeners install before navigation",
      nzchar(listener$identifier %||% ""), listener$identifier %||% ""
    )

    events$phase <- "initial_load"
    session$go_to(sprintf("http://127.0.0.1:%d/", port))
    session$set_viewport_size(1440, 1000)
    loaded <- wait_until(function() {
      current <- state()
      length(current$cells) == 2L && !isTRUE(current$runtime$busy) &&
        isTRUE(browser_eval("window.__alderEditors?.size === 2"))
    }, 40, "initial browser state")
    record("real Chrome loads installed CLI session", loaded)
    if (!loaded) stop("browser did not load the installed CLI session")
    capture_status("initial")
    save_screenshot("10-cli-start.png")
    initial <- state()
    id <- initial$cells[[1L]]$id

    events$phase <- "initial_completion"
    completion_source <- set_doc(id, "mea") && focus_editor_end(id)
    press_key("Tab", "Tab", 9L)
    completion_visible <- wait_until(function() {
      nzchar(browser_eval(
        "document.querySelector('.cm-tooltip-autocomplete')?.innerText || ''"
      ))
    }, 40, "initial real Tab completion")
    completion_text <- browser_eval(
      "document.querySelector('.cm-tooltip-autocomplete')?.innerText || ''"
    )
    record(
      "real Tab completion reaches the installed R language server",
      completion_source && completion_visible &&
        grepl("mean", completion_text, ignore.case = TRUE),
      substr(completion_text, 1L, 240L)
    )
    save_screenshot("11-real-tab-completion.png")
    press_key("Escape", "Escape", 27L)

    events$phase <- "initial_signature"
    signature_source <- set_doc(id, "mean") && focus_editor_end(id)
    type_open_parenthesis()
    typed_parenthesis <- wait_until(function() {
      document <- browser_eval(sprintf(
        "window.__alderEditors.get(%s)?.view.state.doc.toString() || ''",
        js_json(id)
      ))
      document %in% c("mean(", "mean()")
    }, 5, "typed signature trigger")
    signature_visible <- wait_until(function() {
      nzchar(browser_eval(
        "document.querySelector('.cm-alder-signature')?.innerText || ''"
      ))
    }, 40, "initial real signature help")
    signature_text <- browser_eval(
      "document.querySelector('.cm-alder-signature')?.innerText || ''"
    )
    record(
      "real typed signature help reaches the installed R language server",
      signature_source && typed_parenthesis && signature_visible &&
        grepl("mean", signature_text, ignore.case = TRUE),
      substr(signature_text, 1L, 320L)
    )
    save_screenshot("12-real-signature-help.png")
    press_key("Escape", "Escape", 27L)

    events$phase <- "settings_off"
    range_errors_before <- assistance_error_count()
    methods_before_off <- length(lsp_methods())
    settings_opened <- click_selector("#settings-open")
    settings_off_clicked <- set_checkbox("#settings-completions", FALSE) &&
      set_checkbox("#settings-signature-help", FALSE)
    settings_applied <- click_selector("#settings-apply")
    settings_off <- wait_until(function() {
      editor <- state()$config$editor
      isFALSE(editor$completions) && isFALSE(editor$signature_help)
    }, 12, "editor assistance disabled")
    press_key("Escape", "Escape", 27L)
    set_doc(id, "mea")
    focus_editor_end(id)
    press_key("Tab", "Tab", 9L)
    pump(1.2)
    set_doc(id, "mean")
    focus_editor_end(id)
    type_open_parenthesis()
    pump(1.2)
    methods_after_off <- length(lsp_methods())
    disabled_tooltips <- browser_eval(paste0(
      "Boolean(document.querySelector('.cm-tooltip-autocomplete') || ",
      "document.querySelector('.cm-alder-signature'))"
    ))
    record(
      "settings disable completion and signature help",
      settings_opened && settings_off_clicked && settings_applied &&
        settings_off && !disabled_tooltips &&
        identical(methods_after_off, methods_before_off),
      sprintf(
        "LSP requests before=%d after=%d; tooltip=%s",
        methods_before_off, methods_after_off, disabled_tooltips
      )
    )
    capture_status("settings_off")
    save_screenshot("13-settings-off.png")

    events$phase <- "settings_on"
    settings_opened <- click_selector("#settings-open")
    settings_on_clicked <- set_checkbox("#settings-completions", TRUE) &&
      set_checkbox("#settings-signature-help", TRUE)
    settings_applied <- click_selector("#settings-apply")
    settings_on <- wait_until(function() {
      editor <- state()$config$editor
      isTRUE(editor$completions) && isTRUE(editor$signature_help)
    }, 12, "editor assistance enabled")
    pump(1)
    drain_cli()
    range_errors_after <- assistance_error_count()
    record(
      "settings off/on reconfiguration has no RangeError",
      settings_opened && settings_on_clicked && settings_applied &&
        settings_on && identical(range_errors_after, range_errors_before),
      sprintf("RangeError count before=%d after=%d",
              range_errors_before, range_errors_after)
    )
    capture_status("settings_on")
    save_screenshot("14-settings-on.png")

    events$phase <- "stop"
    long_source <- "Sys.sleep(10); 'should-not-complete'"
    stop_source <- set_doc(id, long_source)
    started_at <- proc.time()[["elapsed"]]
    run_clicked <- click_selector(sprintf("#cell-%s [data-act=run]", id))
    stop_enabled <- wait_until(function() {
      isTRUE(browser_eval("document.querySelector('#stop')?.disabled === false"))
    }, 4, "Stop enabled")
    enabled_elapsed <- proc.time()[["elapsed"]] - started_at
    stop_clicked <- stop_enabled && click_selector("#stop")
    interrupted <- wait_until(function() {
      current <- state()
      item <- cell(current, id)
      !isTRUE(current$runtime$busy) && identical(item$status, "error") &&
        isTRUE(item$error$interrupted)
    }, 8, "terminal interruption")
    stop_elapsed <- proc.time()[["elapsed"]] - started_at
    record(
      "immediate Stop interrupts promptly",
      stop_source && run_clicked && stop_enabled && stop_clicked &&
        interrupted && stop_elapsed < 2,
      sprintf("enabled=%.3fs terminal=%.3fs", enabled_elapsed, stop_elapsed)
    )
    capture_status("interrupted")
    save_screenshot("15-interrupted.png")

    events$phase <- "stop_recovery"
    recovery_source <- set_doc(id, "1 + 1")
    recovery_clicked <- click_selector(sprintf("#cell-%s [data-act=run]", id))
    recovered <- wait_until(function() {
      item <- cell(state(), id)
      identical(item$status, "done") &&
        identical(cell_output_text(item), "[1] 2")
    }, 15, "same-session Stop recovery")
    record(
      "same notebook executes correctly after Stop",
      recovery_source && recovery_clicked && recovered
    )
    capture_status("stop_recovered")
    save_screenshot("16-stop-recovered.png")

    events$phase <- "lsp_failure"
    before_lsp_kill <- snapshot_processes("17-process-tree-before-lsp-kill")
    lsp_rows <- before_lsp_kill[vapply(before_lsp_kill, function(row) {
      grepl("languageserver::run", row$args, fixed = TRUE)
    }, logical(1L))]
    lsp_pids <- unique(vapply(lsp_rows, `[[`, integer(1L), "pid"))
    killed <- length(lsp_pids) > 0L
    for (pid in lsp_pids) {
      killed <- isTRUE(tryCatch(tools::pskill(pid, 15L),
                                error = function(error) FALSE)) && killed
    }
    lsp_dead <- wait_until(function() {
      length(lsp_rows) > 0L &&
        !any(vapply(lsp_rows, same_process_alive, logical(1L)))
    }, 8, "real language-server process exit")
    record(
      "real installed languageserver process is terminated",
      killed && lsp_dead,
      paste("pids", paste(lsp_pids, collapse = ","))
    )

    set_doc(id, "mea")
    focus_editor_end(id)
    methods_before_dead_request <- length(lsp_methods())
    press_key("Tab", "Tab", 9L)
    service_error_visible <- wait_until(function() {
      current <- state()
      error <- current$service_errors$lsp %||% NULL
      !is.null(error) && nzchar(error$message %||% "")
    }, 25, "persistent LSP service error")
    retry_visible <- wait_until(function() {
      isTRUE(browser_eval(paste0(
        "(()=>{const button=[...document.querySelectorAll('button')]",
        ".find(node=>node.textContent.trim()==='Retry editor help');",
        "return Boolean(button&&!button.disabled&&button.getClientRects().length)})()"
      )))
    }, 15, "Retry editor help action")
    methods_after_dead_request <- length(lsp_methods())
    current <- state()
    service_error <- current$service_errors$lsp %||% list()
    record(
      "language-server death is a persistent service error",
      service_error_visible && methods_after_dead_request >
        methods_before_dead_request,
      service_error$message %||% ""
    )
    capture_status("lsp_service_error")

    retry_samples <- vector("list", 5L)
    for (index in seq_along(retry_samples)) {
      retry_samples[[index]] <- browser_eval(paste0(
        "(()=>{const button=[...document.querySelectorAll('button')]",
        ".find(node=>node.textContent.trim()==='Retry editor help');",
        "if(!button)return null;const rect=button.getBoundingClientRect();",
        "return {tag:button.tagName,text:button.textContent.trim(),",
        "ariaLabel:button.getAttribute('aria-label')||'',",
        "type:button.getAttribute('type')||'',disabled:button.disabled,",
        "tabIndex:button.tabIndex,connected:button.isConnected,",
        "visible:Boolean(button.getClientRects().length),",
        "width:rect.width,height:rect.height}})()"
      ))
      pump(0.45)
    }
    ax_tree <- if (accessibility_enabled) {
      session$Accessibility$getFullAXTree()$nodes %||% list()
    } else {
      list()
    }
    ax_retry <- ax_tree[vapply(ax_tree, function(node) {
      identical(node$role$value %||% "", "button") &&
        identical(node$name$value %||% "", "Retry editor help") &&
        !isTRUE(node$ignored)
    }, logical(1L))]
    retry_accessibility <- list(
      dom_samples = retry_samples,
      ax_matches = ax_retry,
      service_error = service_error
    )
    retry_persistent <- retry_visible && all(vapply(retry_samples, function(sample) {
      !is.null(sample) && identical(sample$tag, "BUTTON") &&
        identical(sample$text, "Retry editor help") &&
        isTRUE(sample$connected) && isTRUE(sample$visible) &&
        isFALSE(sample$disabled) && sample$tabIndex >= 0L
    }, logical(1L)))
    record(
      "Retry editor help remains visible and keyboard accessible",
      retry_persistent && length(ax_retry) > 0L,
      sprintf("persistent=%s; accessibility matches=%d",
              retry_persistent, length(ax_retry))
    )
    save_screenshot("17-lsp-error-retry-action.png")

    events$phase <- "lsp_retry"
    methods_before_retry <- length(lsp_methods())
    retry_clicked <- browser_eval(paste0(
      "(()=>{const button=[...document.querySelectorAll('button')]",
      ".find(node=>node.textContent.trim()==='Retry editor help');",
      "if(!button)return false;button.focus();button.click();return true})()"
    ))
    service_error_cleared <- wait_until(function() {
      current <- state()
      is.null(current$service_errors$lsp %||% NULL) &&
        is.null(current$last_action_error %||% NULL)
    }, 45, "editor-help service recovery")
    retry_method_seen <- wait_until(function() {
      methods <- lsp_methods()
      any(vapply(methods, function(method) {
        identical(method$method, "alder/restart") &&
          identical(method$phase, "lsp_retry")
      }, logical(1L)))
    }, 5, "alder/restart request")
    retry_absent <- isFALSE(browser_eval(paste0(
      "[...document.querySelectorAll('button')]",
      ".some(node=>node.textContent.trim()==='Retry editor help')"
    )))
    methods_after_retry <- length(lsp_methods())
    cleared_status <- capture_status("lsp_retry_cleared")
    record(
      "clicking Retry editor help clears the LSP service error",
      retry_clicked && retry_method_seen && service_error_cleared &&
        retry_absent && methods_after_retry > methods_before_retry,
      sprintf(
        "restart request=%s; service clear=%s; action absent=%s; status=%s",
        retry_method_seen, service_error_cleared, retry_absent,
        cleared_status$text %||% ""
      )
    )
    after_lsp_retry <- snapshot_processes("18-process-tree-after-lsp-retry")
    replacement_lsp <- after_lsp_retry[vapply(after_lsp_retry, function(row) {
      grepl("languageserver::run", row$args, fixed = TRUE) &&
        !(row$pid %in% lsp_pids)
    }, logical(1L))]
    record(
      "Retry launches a replacement languageserver process",
      length(replacement_lsp) > 0L,
      paste(format_process_rows(replacement_lsp), collapse = " | ")
    )

    events$phase <- "completion_recovered"
    set_doc(id, "mea")
    focus_editor_end(id)
    press_key("Tab", "Tab", 9L)
    completion_recovered <- wait_until(function() {
      grepl("mean", browser_eval(
        "document.querySelector('.cm-tooltip-autocomplete')?.innerText || ''"
      ), ignore.case = TRUE)
    }, 40, "completion after editor-help retry")
    recovered_completion_text <- browser_eval(
      "document.querySelector('.cm-tooltip-autocomplete')?.innerText || ''"
    )
    record(
      "real Tab completion recovers after editor-help retry",
      completion_recovered, substr(recovered_completion_text, 1L, 240L)
    )
    save_screenshot("18-completion-recovered.png")
    press_key("Escape", "Escape", 27L)

    events$phase <- "signature_recovered"
    set_doc(id, "mean")
    focus_editor_end(id)
    type_open_parenthesis()
    signature_recovered <- wait_until(function() {
      grepl("mean", browser_eval(
        "document.querySelector('.cm-alder-signature')?.innerText || ''"
      ), ignore.case = TRUE)
    }, 40, "signature after editor-help retry")
    recovered_signature_text <- browser_eval(
      "document.querySelector('.cm-alder-signature')?.innerText || ''"
    )
    record(
      "real signature help recovers after editor-help retry",
      signature_recovered, substr(recovered_signature_text, 1L, 320L)
    )
    save_screenshot("19-signature-recovered.png")
    press_key("Escape", "Escape", 27L)

    events$phase <- "save_before_shutdown"
    set_doc(id, "1 + 1")
    save_clicked <- click_selector("#save")
    saved <- wait_until(function() isFALSE(state()$changed), 15,
                        "clean notebook before Shutdown")
    record(
      "notebook is clean before authenticated Shutdown",
      save_clicked && saved
    )
    state_before_shutdown <- state()
    token_present <- nzchar(state_before_shutdown$shutdown_token %||% "")
    snapshot_processes("19-process-tree-before-shutdown")

    events$phase <- "authenticated_shutdown"
    shutdown_clicked <- click_selector("#shutdown")
    shutdown_visible <- wait_until(function() {
      grepl(
        "shut down",
        browser_eval("document.querySelector('#status')?.textContent || ''"),
        ignore.case = TRUE
      )
    }, 10, "authenticated Shutdown status")
    capture_status("shutdown_complete")
    save_screenshot("20-shutdown-complete.png")
    deadline <- Sys.time() + 20
    while (cli$is_alive() && Sys.time() < deadline) {
      drain_cli()
      pump(0.05)
    }
    exit_status <- if (cli$is_alive()) {
      NA_integer_
    } else {
      cli$wait(5000)
      cli$get_exit_status()
    }
    pump(0.4)
    drain_cli()
    live_descendants <- tracked_descendants[vapply(
      tracked_descendants, same_process_alive, logical(1L)
    )]
    port_is_open <- port_open(port)
    record(
      "authenticated Shutdown exits CLI and releases every descendant",
      token_present && shutdown_clicked && shutdown_visible &&
        identical(exit_status, 0L) && !port_is_open &&
        length(live_descendants) == 0L,
      sprintf(
        "token=%s exit=%s port_open=%s live_descendants=%s",
        token_present, exit_status %||% "NA", port_is_open,
        paste(vapply(live_descendants, `[[`, integer(1L), "pid"),
              collapse = ",")
      )
    )

    window_events <- browser_eval("window.__alderProbeWindowEvents || []")
    range_error_text <- c(
      vapply(events$exceptions, function(event) {
        paste(event$text %||% "", event$exception$description %||% "")
      }, character(1L)),
      vapply(events$log_entries, function(event) event$text %||% "",
             character(1L)),
      vapply(window_events, function(event) {
        paste(event$message %||% "", event$reason %||% "")
      }, character(1L)),
      stderr_lines
    )
    range_errors <- range_error_text[grepl(
      "RangeError|Field is not present in this state", range_error_text,
      ignore.case = TRUE
    )]
    record(
      "complete browser/server run contains zero RangeError",
      length(range_errors) == 0L,
      paste(range_errors, collapse = " | ")
    )

    security_entries <- events$log_entries[vapply(
      events$log_entries, function(event) {
        identical(tolower(event$source %||% ""), "security") ||
          grepl(
            "content security policy|content-security-policy|csp",
            event$text %||% "", ignore.case = TRUE
          )
      }, logical(1L)
    )]
    record(
      "Chrome Log/security reports zero CSP or security errors",
      log_enabled && length(security_entries) == 0L,
      paste(vapply(security_entries, function(event) event$text %||% "",
                   character(1L)), collapse = " | ")
    )

    runtime_errors <- events$exceptions
    window_errors <- window_events
    console_errors <- events$console[vapply(events$console, function(event) {
      tolower(event$type %||% "") %in% c("error", "assert", "warning")
    }, logical(1L))]
    record(
      "ordinary acceptance flow has no Runtime or window exception",
      length(runtime_errors) == 0L && length(window_errors) == 0L,
      sprintf("Runtime=%d window=%d", length(runtime_errors),
              length(window_errors))
    )
    record(
      "ordinary acceptance flow has no Console error or warning",
      length(console_errors) == 0L,
      sprintf("Console errors/warnings=%d", length(console_errors))
    )

    unexpected_failures <- events$failures[vapply(events$failures,
      function(event) {
        expected_shutdown_cancel <-
          identical(event$phase, "authenticated_shutdown") &&
          isTRUE(event$canceled) && grepl("/api/state$", event$url %||% "")
        !expected_shutdown_cancel
      }, logical(1L))]
    record(
      "Network reports no unexpected loading failure",
      length(unexpected_failures) == 0L,
      paste(vapply(unexpected_failures, function(event) {
        paste(event$url %||% "", event$error_text %||% "")
      }, character(1L)), collapse = " | ")
    )

    bad_responses <- events$responses[vapply(events$responses, function(event) {
      is.numeric(event$status) && length(event$status) == 1L &&
        !is.na(event$status) && event$status >= 400
    }, logical(1L))]
    expected_bad_responses <- vapply(bad_responses, function(event) {
      identical(event$phase, "lsp_failure") &&
        grepl("/api/lsp$", event$url %||% "") &&
        identical(as.integer(event$status), 503L)
    }, logical(1L))
    record(
      "only intentional LSP death produces an HTTP error response",
      length(bad_responses) > 0L && all(expected_bad_responses),
      paste(vapply(bad_responses, function(event) {
        sprintf("%s %s phase=%s", event$status, event$url, event$phase)
      }, character(1L)), collapse = " | ")
    )

    stderr_nonempty <- stderr_lines[nzchar(trimws(stderr_lines))]
    expected_stderr <- grepl(
      "language[ -]?server|languageserver|/api/lsp|[[]alder:lsp[]]|editor help",
      stderr_nonempty, ignore.case = TRUE
    )
    unexpected_stderr <- stderr_nonempty[!expected_stderr]
    record(
      "server stderr contains only the observed LSP-death diagnostic",
      length(unexpected_stderr) == 0L,
      paste(unexpected_stderr, collapse = " | ")
    )

    failed <- names(probe_results$assertions)[!vapply(
      probe_results$assertions, function(assertion) assertion$passed,
      logical(1L)
    )]
    cat(sprintf(
      "SUMMARY: %d pass, %d fail\n",
      length(probe_results$assertions) - length(failed), length(failed)
    ))
    if (length(failed)) {
      cat("FAILED: ", paste(failed, collapse = " | "), "\n", sep = "")
      1L
    } else {
      0L
    }
  }, error = function(error) {
    probe_results$fatal <- list(
      message = conditionMessage(error),
      class = class(error),
      calls = vapply(sys.calls(), deparse1, character(1L))
    )
    cat("FATAL: ", conditionMessage(error), "\n", sep = "", file = stderr())
    2L
  })
  status
}

exit_status <- main()
quit(save = "no", status = exit_status, runLast = FALSE)
