#!/usr/bin/env Rscript
# Execute inside codex-universal under a long-lived tini -s. Timed interactions
# use CDP input; no extra state request is sent during a measured interval.
options(warn = 2, chromote.timeout = 60)
args <- commandArgs(TRUE)
evidence <- normalizePath(args[[1L]], mustWork = TRUE)
samples_n <- as.integer(args[[2L]])
warmups <- as.integer(args[[3L]])
mode <- args[[4L]]
stopifnot(samples_n > 0, warmups >= 0, mode %in% c("baseline", "profile"))
library(alder)
stopifnot(requireNamespace("microbenchmark", quietly = TRUE))

save_json <- function(value, path) {
  jsonlite::write_json(value, path, auto_unbox = TRUE, pretty = TRUE,
                       null = "null", na = "null", digits = NA)
}
js_json <- function(value) as.character(jsonlite::toJSON(
  value, auto_unbox = TRUE, null = "null"))
clock_ms <- function() microbenchmark::get_nanotime() / 1e6
await <- function(predicate, label, timeout = 60) {
  start <- clock_ms()
  repeat {
    if (isTRUE(predicate())) return(invisible())
    if (clock_ms() - start > timeout * 1000) stop("timeout: ", label)
    Sys.sleep(0.02)
  }
}
fixture <- function(kind) {
  if (kind == "create") return(character())
  code <- if (kind == "single") c("# %%", "x <- 1L", "x * 2L") else c(
    "# %%", "x <- 1L", "# %%", "y <- x + 1L", "# %%", "z <- y * 2L", "z")
  if (kind == "long") {
    code <- c(code, unlist(lapply(seq_len(100), function(i) {
      c("# %%", sprintf("unrelated_%03d <- %dL", i, i))
    })))
  }
  code
}

run_fixture <- function(kind) {
  root <- file.path(evidence, kind)
  dir.create(root)
  path <- file.path(root, "notebook.R")
  writeLines(fixture(kind), path)
  dir.create(file.path(root, ".alder"))
  writeLines(c("autosave: false", "format:", "  on_save: false", "editor:",
               "  live_diagnostics: false"), file.path(root, ".alder", "config.yaml"))
  port <- httpuv::randomPort()
  url <- sprintf("http://127.0.0.1:%d/", port)
  process_env <- Sys.getenv()
  process_env <- process_env[!names(process_env) %in% c(
    "R_TESTS", "ALDER_PERF_TRACE_DIR", "ALDER_PERF_RPROF")]
  process_env[["BROWSER"]] <- "false"
  if (mode == "profile") {
    dir.create(file.path(root, "trace"))
    process_env[["ALDER_PERF_TRACE_DIR"]] <- file.path(root, "trace")
    process_env[["ALDER_PERF_RPROF"]] <- "1"
  }
  cli <- browser <- session <- NULL
  samples <- list()
  startup <- list()
  failure <- NULL
  cleanup <- list(forced = FALSE)
  channels <- list(console = list(), exceptions = list(), dialogs = list())
  on.exit({
    if (!is.null(session)) try(session$close(), silent = TRUE)
    if (!is.null(browser)) try(browser$close(), silent = TRUE)
    if (!is.null(cli)) {
      cleanup$forced <- cli$is_alive()
      if (cleanup$forced) cli$kill_tree()
      cli$wait(5000)
      cleanup$exit_status <- cli$get_exit_status()
    }
    save_json(list(fixture = kind, mode = mode, url = url, startup = startup,
      samples = samples, failure = failure, cleanup = cleanup, channels = channels),
      file.path(root, "result.json"))
  }, add = TRUE)
  tryCatch({
    start <- clock_ms()
    cli <- processx::process$new(system.file("exec", "alder", package = "alder"),
      c("edit", path, "--no-run", "--no-open", "--no-idle-timeout", "--port", as.character(port)),
      stdout = file.path(root, "cli.stdout"), stderr = file.path(root, "cli.stderr"),
      env = process_env)
    await(function() {
      if (!cli$is_alive()) stop("CLI died before readiness")
      any(grepl("alder running", readLines(file.path(root, "cli.stdout"), warn = FALSE), fixed = TRUE))
    }, "CLI readiness")
    startup$cli_ready_ms <- clock_ms() - start
    startup$cli_pid <- cli$get_pid()
    start <- clock_ms()
    browser <- chromote::Chromote$new()
    session <- browser$new_session()
    session$Page$enable()
    session$Runtime$enable()
    session$Page$addScriptToEvaluateOnNewDocument(source = paste(
      readLines("dev/reviews/input-latency-browser.js"), collapse = "\n"))
    session$Runtime$consoleAPICalled(function(p) {
      if (p$type %in% c("error", "warning")) channels$console[[length(channels$console) + 1L]] <<- p
    })
    session$Runtime$exceptionThrown(function(p) {
      channels$exceptions[[length(channels$exceptions) + 1L]] <<- p
    })
    session$Page$javascriptDialogOpening(function(p) {
      channels$dialogs[[length(channels$dialogs) + 1L]] <<- p
      session$Page$handleJavaScriptDialog(accept = FALSE, wait_ = FALSE)
    }, wait_ = FALSE)
    session$Emulation$setDeviceMetricsOverride(width = 1440L, height = 1200L,
      deviceScaleFactor = 1, mobile = FALSE)
    startup$browser_launch_ms <- clock_ms() - start
    js <- function(code) {
      value <- session$Runtime$evaluate(code, returnByValue = TRUE, awaitPromise = TRUE)
      if (!is.null(value$exceptionDetails)) stop(js_json(value$exceptionDetails))
      value$result$value
    }
    start <- clock_ms()
    session$go_to(url)
    session$Page$bringToFront()
    await(function() isTRUE(js("window.__alderLatency?.renderedVersion!==null && !!window.__alderLatency?.states.get(window.__alderLatency.renderedVersion)")),
      "first rendered state")
    startup$browser_ready_ms <- clock_ms() - start
    startup$browser <- session$Browser$getVersion()
    read_state <- function() js("window.__alderLatency.states.get(window.__alderLatency.renderedVersion)")
    http <- function(route, body = NULL) {
      handle <- curl::new_handle(timeout = 30)
      if (!is.null(body)) {
        curl::handle_setheaders(handle, "Content-Type" = "application/json", Origin = sub("/$", "", url))
        curl::handle_setopt(handle, postfields = js_json(body))
      }
      value <- curl::curl_fetch_memory(paste0(url, route), handle)
      if (value$status_code >= 400) stop(rawToChar(value$content))
      jsonlite::fromJSON(rawToChar(value$content), simplifyVector = FALSE)
    }
    initial <- read_state()
    ids <- vapply(initial$cells, `[[`, "", "id")
    target_ids <- if (kind == "single") ids[[1L]] else if (kind == "create") character() else ids[1:3]
    key <- function(name, code, vk, modifiers = 0L, text = NULL) {
      fields <- list(type = "keyDown", key = name, code = code,
        windowsVirtualKeyCode = as.integer(vk), modifiers = as.integer(modifiers))
      if (!is.null(text)) fields$text <- text
      do.call(session$Input$dispatchKeyEvent, fields)
      session$Input$dispatchKeyEvent(type = "keyUp", key = name, code = code,
        windowsVirtualKeyCode = as.integer(vk), modifiers = as.integer(modifiers))
    }
    collect <- function(spec, phase) {
      await(function() isTRUE(js("window.__alderLatency.active?.finished===true")), "visible current result", 30)
      active <- js("window.__alderLatency.active")
      if (!is.null(active$failure)) stop(active$failure)
      row <- active$result
      if (is.null(row) || !is.finite(row$input_to_result_ms)) stop("missing browser measurement")
      row$phase <- phase
      row$fixture <- kind
      row$mode <- mode
      if (spec$kind != "create") {
        operation <- http(paste0("api/run-operation?run_id=", row$run_id))$operation
        if (!identical(operation$status, "done") || !is.null(operation$error)) {
          stop("measured result did not belong to a settled successful run")
        }
        row$operation <- operation
        current <- read_state()
        filler <- Filter(function(c) startsWith(paste(c$body, collapse = ""), "unrelated_"), current$cells)
        if (length(filler) && !all(vapply(filler, function(c) identical(c$status, "idle"), FALSE))) {
          stop("unrelated cells executed")
        }
      }
      samples[[length(samples) + 1L]] <<- row
      save_json(samples, file.path(root, "samples.json"))
      cat(mode, kind, phase, spec$kind, sprintf("%.1f ms", row$input_to_result_ms), "\n")
      invisible(row)
    }
    value <- 1L
    execute <- function(edit, phase) {
      # Setup changes only focus/selection; actual measured source edits use CDP keys.
      await(function() isTRUE(js("!document.querySelector('#run-all').disabled")), "run controls ready")
      if (edit) value <<- if (value == 1L) 2L else 1L
      source <- if (kind == "single") sprintf("x <- %dL\nx * 2L", value) else sprintf("x <- %dL", value)
      expected <- sprintf("[1] %d", if (kind == "single") value * 2L else (value + 1L) * 2L)
      spec <- list(label = paste(kind, if (edit) "edit-run" else "run", sep = "/"),
        kind = if (edit) "edit-run" else "run", phase = phase, sourceCell = target_ids[[1L]],
        resultCell = tail(target_ids, 1), cells = I(target_ids), source = source, expected = expected)
      js(sprintf(paste0("(()=>{const e=window.__alderEditors.get(%s);e.focus();",
        "const p=e.getDoc().indexOf('L')-1;e.view.dispatch({selection:{anchor:p,head:p+1}});",
        "document.querySelector('#cell-'+%s).scrollIntoView({block:'start'});return true})()"),
        js_json(target_ids[[1L]]), js_json(target_ids[[1L]])))
      js(sprintf("window.__alderLatency.arm(%s)", js_json(spec)))
      if (edit) key(as.character(value), paste0("Digit", value), 48L + value, text = as.character(value))
      key("Enter", "Enter", 13L, 2L)
      collect(spec, phase)
    }
    create <- function(phase) {
      spec <- list(label = "create/cell", kind = "create", phase = phase)
      point <- js(paste0("(()=>{const e=document.querySelector('[data-act=add][data-type=code]');",
        "e.scrollIntoView();const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()"))
      js(sprintf("window.__alderLatency.arm(%s)", js_json(spec)))
      session$Input$dispatchMouseEvent(type = "mousePressed", x = point$x, y = point$y,
        button = "left", buttons = 1L, clickCount = 1L)
      session$Input$dispatchMouseEvent(type = "mouseReleased", x = point$x, y = point$y,
        button = "left", buttons = 0L, clickCount = 1L)
      row <- collect(spec, phase)
      current <- read_state()
      cell <- Filter(function(c) identical(c$id, row$created_id), current$cells)[[1L]]
      # This is an external fixture reset. Release focus so source protection
      # correctly permits removal instead of retaining an editable tombstone.
      js("document.activeElement.blur();true")
      http("api/cell", list(op = "delete", id = cell$id, expected_revision = cell$revision))
      await(function() isTRUE(js(paste0(
        "window.__alderLatency.states.get(window.__alderLatency.renderedVersion).cells.length===0 && ",
        "document.querySelectorAll('.cell').length===0"))), "creation fixture reset")
    }
    if (kind == "create") {
      create("first")
      for (i in seq_len(warmups)) create("warmup")
      for (i in seq_len(samples_n)) create("measured")
    } else {
      execute(FALSE, "first")
      for (i in seq_len(warmups)) { execute(FALSE, "warmup"); execute(TRUE, "warmup") }
      for (i in seq_len(samples_n)) { execute(FALSE, "measured"); execute(TRUE, "measured") }
    }
    session$screenshot(filename = file.path(root, "final.png"))
    if (any(lengths(channels) > 0)) stop("unexpected browser error or dialog")
    state <- http("api/state")
    # Stop the client before the server so its ordinary polling cannot race
    # native shutdown and manufacture a teardown-only network error.
    session$close()
    session <- NULL
    browser$close()
    browser <- NULL
    if (any(lengths(channels) > 0)) stop("unexpected browser error or dialog")
    handle <- curl::new_handle(customrequest = "POST")
    curl::handle_setheaders(handle, Origin = sub("/$", "", url),
      "X-Alder-Shutdown-Token" = state$shutdown_token)
    response <- curl::curl_fetch_memory(paste0(url, "api/shutdown"), handle)
    if (response$status_code != 202L) stop("shutdown was not accepted")
    await(function() !cli$is_alive(), "native shutdown", 15)
    if (cli$get_exit_status() != 0L) stop("CLI exited unsuccessfully")
    if (file.info(file.path(root, "cli.stderr"))$size > 0) stop("CLI stderr is not empty")
  }, error = function(e) {
    failure <<- conditionMessage(e)
    if (!is.null(session)) {
      try(session$screenshot(filename = file.path(root, "failure.png")), silent = TRUE)
      try(save_json(js("window.__alderLatency.active"), file.path(root, "failed-sample.json")), silent = TRUE)
    }
    stop(e)
  })
  invisible()
}

save_json(list(R = R.version.string, platform = R.version$platform,
  package = as.character(packageVersion("alder")), library = find.package("alder"),
  mode = mode, samples = samples_n, warmups = warmups,
  timer = list(package = "microbenchmark", version = as.character(packageVersion("microbenchmark"))),
  system = as.list(Sys.info())), file.path(evidence, "environment.json"))
failures <- list()
for (kind in c("single", "chain", "long", "create")) {
  tryCatch(run_fixture(kind), error = function(e) {
    failures[[kind]] <<- conditionMessage(e)
    cat("FAILED", mode, kind, conditionMessage(e), "\n")
  })
}
save_json(failures, file.path(evidence, "failures.json"))
if (length(failures)) quit(status = 1L)
