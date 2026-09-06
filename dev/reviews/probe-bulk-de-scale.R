# Opt-in scientific and real-browser scale review; run with the shell driver.
options(warn = 2, chromote.timeout = 60)
library(alder)

run_review <- function(evidence) {
  evidence <- normalizePath(evidence, mustWork = TRUE)
  source_path <- normalizePath("dev/examples/bulk-differential-expression.R")
  source_bytes <- readBin(source_path, "raw", file.info(source_path)$size)
  checks <- list()
  timings <- list()
  channels <- list(console = list(), exceptions = list(), log = list(), loading = list(), dialogs = list())
  cli <- NULL
  browser <- NULL
  session <- NULL
  failure <- NULL
  cli_stderr <- character()
  cleanup <- list()
  save_json <- function(value, name) {
    jsonlite::write_json(value, file.path(evidence, name), pretty = TRUE,
                         auto_unbox = TRUE, null = "null", na = "null", digits = 16)
  }
  check <- function(name, value) {
    checks[[name]] <<- isTRUE(value)
    cat(if (isTRUE(value)) "PASS" else "FAIL", name, "\n")
    save_json(checks, "checks.json")
    if (!isTRUE(value)) stop("check failed: ", name)
  }
  timed <- function(name, code) {
    start <- proc.time()[["elapsed"]]
    result <- force(code)
    timings[[name]] <<- proc.time()[["elapsed"]] - start
    save_json(timings, "timings.json")
    result
  }
  await <- function(predicate, label, timeout = 180) {
    start <- proc.time()[["elapsed"]]
    repeat {
      if (isTRUE(predicate())) return(invisible(TRUE))
      if (proc.time()[["elapsed"]] - start > timeout) stop("timeout: ", label)
      Sys.sleep(0.1)
    }
  }
  on.exit({
    # Closing is unconditional; normal successful teardown must use Shutdown.
    if (!is.null(session)) {
      tryCatch(session$close(), error = function(e) {
        cleanup$session_error <<- conditionMessage(e)
      })
    }
    if (!is.null(browser)) {
      tryCatch(browser$close(), error = function(e) {
        cleanup$browser_error <<- conditionMessage(e)
      })
    }
    if (!is.null(cli)) {
      cleanup$forced <- cli$is_alive()
      if (cli$is_alive()) cli$kill_tree()
      cli$wait(5000)
      cleanup$exit_status <- cli$get_exit_status()
      cleanup$alive <- cli$is_alive()

    }
    save_json(cleanup, "cleanup.json")
    save_json(channels, "browser-channels.json")
    save_json(list(
      passed = is.null(failure) && length(checks) > 0 && all(unlist(checks)),
      checks = checks, timings = timings, failure = failure,
      cleanup = cleanup, source_sha256 = digest::digest(source_bytes, "sha256", serialize = FALSE)
    ), "result.json")
  }, add = TRUE)

  tryCatch({
    nb <- alder:::read_notebook(source_path)
    analysis <- timed("analysis_seconds", alder:::export_analysis(nb))
    graph <- alder:::export_source_graph_or_stop(nb)
    diagnostics <- alder:::export_diagnostics(nb, analysis)
    lines <- readLines(source_path)
    save_json(list(
      source = source_path,
      bytes = length(source_bytes),
      lines = length(lines),
      code_lines = sum(nzchar(trimws(lines)) & !grepl("^\\s*#", lines)),
      cells = length(nb$cells),
      code_cells = sum(vapply(nb$cells, function(c) c$type == "code", logical(1))),
      edges = sum(lengths(analysis$dag$edges)),
      source_sha256 = digest::digest(source_bytes, "sha256", serialize = FALSE),
      package = as.character(packageVersion("alder")),
      package_path = find.package("alder"), R = R.version.string,
      edgeR = as.character(packageVersion("edgeR")),
      limma = as.character(packageVersion("limma")),
      statmod = as.character(packageVersion("statmod")),
      ggplot2 = as.character(packageVersion("ggplot2")),
      library_paths = .libPaths()
    ), "input.json")
    save_json(diagnostics, "analysis-diagnostics.json")
    check("at_least_1000_actual_R_lines", sum(nzchar(trimws(lines)) & !grepl("^\\s*#", lines)) >= 1000)
    check("at_least_60_cells", length(nb$cells) >= 60)
    check("all_cells_in_execution_plan", length(graph$runnable) == length(nb$cells))
    check("no_static_diagnostics", nrow(diagnostics) == 0)
    evaluate <- function(mode) {
      env <- new.env(parent = globalenv())
      grDevices::pdf(file.path(evidence, paste0(mode, "-base-plots.pdf")))
      on.exit(grDevices::dev.off(), add = TRUE)
      if (mode == "ordinary-R") sys.source(source_path, envir = env)
      else alder::alder_source(source_path, env = env)
      env
    }
    reference <- timed("ordinary_R_seconds", evaluate("ordinary-R"))
    reactive <- timed("alder_source_seconds", evaluate("alder-source"))
    check("raw_counts_identical", identical(reference$counts, reactive$counts))
    check("full_DE_table_matches_ordinary_R", isTRUE(all.equal(
      reference$de_results, reactive$de_results, tolerance = 1e-10)))
    check("full_glmTreat_table_matches_ordinary_R", isTRUE(all.equal(
      reference$treat_results, reactive$treat_results, tolerance = 1e-10)))
    check("model_coefficients_match_ordinary_R", isTRUE(all.equal(
      reference$ql_fit$coefficients, reactive$ql_fit$coefficients, tolerance = 1e-10)))
    check("analysis_checks_pass_both_modes", all(reference$analysis_checks) && all(reactive$analysis_checks))
    saveRDS(list(
      counts = reference$counts, de_results = reference$de_results,
      treat_results = reference$treat_results, signature = reference$validation_signature
    ), file.path(evidence, "ordinary-R-reference.rds"))
    save_json(list(
      signature = reference$validation_signature,
      checks = reference$analysis_checks,
      recovery = reference$recovery_metrics,
      top_genes = head(reference$de_results, 12),
      default_summary = reference$summary_text,
      strict_selection = sum(reference$de_results$FDR <= 0.05 & abs(reference$de_results$logFC) >= 2)
    ), "scientific-reference.json")

    # Borrow only the established native-browser helper definitions, never tests.
    helper <- new.env(parent = globalenv())
    browser_lines <- readLines("tests/testthat/test-browser.R")
    helper_end <- grep("^# 1 -+", browser_lines)[1] - 1L
    eval(parse(text = browser_lines[seq_len(helper_end)]), helper)
    project <- tempfile("bulk-de-", tmpdir = "/tmp")
    dir.create(project)
    notebook_path <- file.path(project, "bulk-de.R")
    writeBin(source_bytes, notebook_path)
    port <- httpuv::randomPort()
    url <- sprintf("http://127.0.0.1:%d/", port)
    writeLines(url, file.path(evidence, "url.txt"))
    launcher <- system.file("exec", "alder", package = "alder", mustWork = TRUE)
    process_env <- Sys.getenv()
    process_env[["R_LIBS"]] <- paste(.libPaths(), collapse = .Platform$path.sep)
    process_env[["BROWSER"]] <- "false"
    cli <- processx::process$new(
      launcher,
      c(notebook_path, "--no-open", "--no-run", "--no-idle-timeout", "--port", as.character(port)),
      stdout = file.path(evidence, "cli.stdout"),
      stderr = file.path(evidence, "cli.stderr"), env = process_env
    )
    http <- function(route, body = NULL) {
      handle <- curl::new_handle(connecttimeout = 2, timeout = 20)
      if (!is.null(body)) {
        curl::handle_setheaders(handle, "Content-Type" = "application/json", Origin = sub("/$", "", url))
        curl::handle_setopt(handle, postfields = jsonlite::toJSON(body, auto_unbox = TRUE))
      }
      response <- curl::curl_fetch_memory(paste0(url, sub("^/", "", route)), handle)
      if (response$status_code >= 400) stop(rawToChar(response$content))
      jsonlite::fromJSON(rawToChar(response$content), simplifyVector = FALSE)
    }
    timed("CLI_ready_seconds", await(function() {
      if (!cli$is_alive()) stop("CLI exited before ready")
      tryCatch(!is.null(http("api/state")$cells), curl_error = function(e) FALSE)
    }, "CLI readiness", 60))
    browser <- chromote::Chromote$new()
    session <- browser$new_session()
    session$Page$enable()
    session$Page$javascriptDialogOpening(function(p) {
      channels$dialogs[[length(channels$dialogs) + 1L]] <<- p
      session$Page$handleJavaScriptDialog(accept = FALSE, wait_ = FALSE)
    }, wait_ = FALSE)
    session$Network$enable()
    session$Runtime$enable()
    session$Log$enable()
    session$Runtime$consoleAPICalled(function(p) {
      channels$console[[length(channels$console) + 1L]] <<- p
    })
    session$Runtime$exceptionThrown(function(p) {
      channels$exceptions[[length(channels$exceptions) + 1L]] <<- p
    })
    session$Log$entryAdded(function(p) {
      channels$log[[length(channels$log) + 1L]] <<- p
    })
    session$Network$loadingFailed(function(p) {
      channels$loading[[length(channels$loading) + 1L]] <<- p
    })
    session$Emulation$setDeviceMetricsOverride(
      width = 1440L, height = 1000L, deviceScaleFactor = 1, mobile = FALSE)
    js <- function(code) {
      result <- session$Runtime$evaluate(code, returnByValue = TRUE, awaitPromise = TRUE)
      if (!is.null(result$exceptionDetails)) stop(jsonlite::toJSON(result$exceptionDetails, auto_unbox = TRUE))
      result$result$value
    }
    timed("browser_open_seconds", {
      session$go_to(url)
      await(function() identical(as.integer(js("document.querySelectorAll('.cell').length")), length(nb$cells)),
            "all 65 editor cells visible", 60)
    })
    js("window.__bulkEvents=[]; document.addEventListener('keydown',e=>window.__bulkEvents.push({key:e.key,trusted:e.isTrusted}),true); true")
    get_state <- function() http("api/state")
    cell <- function(state, name) {
      matches <- Filter(function(c) identical(c$options$name, name), state$cells)
      if (length(matches) != 1) stop("ambiguous cell: ", name)
      matches[[1]]
    }
    settled <- function() {
      s <- get_state()
      errors <- Filter(function(c) identical(c$status, "error") || !is.null(c$error), s$cells)
      if (length(errors)) {
        save_json(s, "failed-state.json")
        stop("notebook cell failure: ", paste(vapply(errors, function(c) c$options$name, ""), collapse = ", "))
      }
      !isTRUE(s$runtime$busy) && all(vapply(s$cells, function(c) {
        c$type == "markdown" || identical(c$status, "done")
      }, logical(1)))
    }
    check("native_Run_all_click", helper$pointer_click_selector(session, "#run-all"))
    timed("browser_full_run_seconds", await(settled, "full notebook execution"))
    before <- get_state()
    save_json(before, "state-before.json")
    text_output <- function(c) paste(vapply(c$outputs, function(o) {
      if (is.character(o$text)) paste(o$text, collapse = "\n") else ""
    }, ""), collapse = "\n")
    check("browser_summary_matches_ordinary_R", grepl(
      reference$summary_text, text_output(cell(before, "final_summary")), fixed = TRUE))
    check("all_code_cells_done", all(vapply(before$cells, function(c) {
      c$type == "markdown" || identical(c$status, "done")
    }, logical(1))))
    check("no_cell_warnings", !any(vapply(before$cells, function(c) {
      any(grepl("^Warning:", unlist(c$log))) ||
        any(vapply(c$outputs, function(o) identical(o$kind, "warning"), logical(1)))
    }, logical(1))))
    check("no_editor_or_runtime_errors", length(before$editor_diagnostics) == 0 && is.null(before$last_action_error))
    await(function() isTRUE(js(sprintf(
      "document.querySelector('#cell-%s').innerText.includes(%s)",
      cell(before, "final_summary")$id, helper$js_json(reference$summary_text)))),
      "browser renders completed summary", 30)
    await(function() isTRUE(js("[...document.querySelectorAll('.cell img')].every(i=>i.complete&&i.naturalWidth>0)")),
      "plot image loading", 30)
    images <- js("[...document.querySelectorAll('.cell img')].map(i=>({src:i.getAttribute('src'),complete:i.complete,width:i.naturalWidth}))")
    save_json(images, "rendered-images.json")
    check("at_least_15_rendered_plots", length(images) >= 15)
    check("all_plot_images_loaded", all(vapply(images, function(i) isTRUE(i$complete) && i$width > 0, logical(1))))
    state_latency <- replicate(3, system.time(get_state())[["elapsed"]])
    save_json(list(seconds = state_latency), "state-request-timings.json")
    screenshot <- function(name, cell_name) {
      id <- cell(get_state(), cell_name)$id
      plot_src <- js(sprintf("document.querySelector('#cell-%s img')?.getAttribute('src') || null", id))
      if (!is.null(plot_src)) {
        plot_response <- curl::curl_fetch_memory(paste0(url, sub("^/", "", plot_src)))
        if (plot_response$status_code != 200) stop("plot download failed")
        writeBin(plot_response$content, file.path(evidence, paste0(name, "-plot.png")))
      }
      js(sprintf("(()=>{const target=document.querySelector('#cell-%s img')||document.querySelector('#cell-%s');target.scrollIntoView({block:'center'});return true})()", id, id))
      Sys.sleep(0.2)
      capture <- session$Page$captureScreenshot(format = "png")
      writeBin(base64enc::base64decode(capture$data), file.path(evidence, paste0(name, ".png")))
    }
    screenshot("01-qc", "library_size_plot")
    screenshot("02-pca", "pca_plot")
    screenshot("03-volcano-default", "volcano_plot")
    screenshot("04-heatmap", "top_gene_heatmap")
    screenshot("05-final-summary", "final_summary")

    # Observe actual executed cells; unchanged values alone cannot prove no refit.
    js("window.__bulkRunning=[];window.__bulkFetch=window.fetch;window.fetch=async function(...args){const r=await window.__bulkFetch(...args);if(String(args[0]).startsWith('/api/state')){const s=await r.clone().json();for(const c of s.cells)if(c.status==='running')window.__bulkRunning.push(c.id);}return r;};true")
    effect_cell <- cell(before, "effect_control")$id
    selector <- paste0("#cell-", effect_cell, " input[type=range]")
    check("native_effect_slider_focus", helper$pointer_click_selector(session, selector))
    # End selects the maximum (2) using native browser keyboard events.
    session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "End", code = "End", windowsVirtualKeyCode = 35L)
    session$Input$dispatchKeyEvent(type = "keyUp", key = "End", code = "End", windowsVirtualKeyCode = 35L)
    expected_strict <- sum(reference$de_results$FDR <= 0.05 & abs(reference$de_results$logFC) >= 2)
    timed("threshold_update_seconds", await(function() {
      s <- get_state()
      control <- cell(s, "effect_control")
      widgets <- Filter(function(o) identical(o$kind, "widget"), control$outputs)
      length(widgets) == 1 && identical(as.numeric(widgets[[1]]$spec$value), 2) && settled() &&
        grepl(paste0("selected=", expected_strict, " "), text_output(cell(s, "final_summary")), fixed = TRUE)
    }, "strict effect threshold"))
    after <- get_state()
    save_json(after, "state-strict.json")
    check("strict_cutoff_reduces_selected_genes", expected_strict < reference$selection_count)
    check("model_outputs_unchanged_after_threshold", identical(
      cell(before, "quasi_likelihood_fit")$outputs,
      cell(after, "quasi_likelihood_fit")$outputs))
    # The graph proves the possible rerun set; observed state samples supplement it.
    fit_id <- cell(before, "quasi_likelihood_fit")$id
    downstream <- effect_cell
    repeat {
      expanded <- union(downstream, names(Filter(
        function(deps) any(deps %in% downstream), analysis$dag$edges)))
      if (setequal(expanded, downstream)) break
      downstream <- expanded
    }
    check("model_not_in_threshold_descendants", !fit_id %in% downstream)
    running <- js("window.__bulkRunning")
    save_json(running, "threshold-running-cells.json")
    check("no_observed_model_refit", !fit_id %in% unlist(running))
    screenshot("06-volcano-strict", "volcano_plot")
    http("api/widget", list(name = "effect_cutoff", value = 0.5, source = "editor"))
    await(function() settled() && grepl(reference$summary_text,
      text_output(cell(get_state(), "final_summary")), fixed = TRUE), "restore default threshold")

    # Edit near the end of the long source and save via a real keyboard shortcut.
    final_id <- cell(get_state(), "final_summary")$id
    js(sprintf("window.__alderEditors.get('%s').focus();const e=window.__alderEditors.get('%s');e.view.dispatch({selection:{anchor:e.getDoc().length}});true", final_id, final_id))
    session$Input$insertText(text = "\n# Scale review: edited at the end of the notebook.\n")
    session$Input$dispatchKeyEvent(type = "rawKeyDown", key = "s", code = "KeyS", modifiers = 2L, windowsVirtualKeyCode = 83L)
    session$Input$dispatchKeyEvent(type = "keyUp", key = "s", code = "KeyS", modifiers = 2L, windowsVirtualKeyCode = 83L)
    timed("save_seconds", await(function() {
      grepl("# Scale review: edited at the end of the notebook.", paste(readLines(notebook_path), collapse = "\n"), fixed = TRUE)
    }, "long notebook save", 20))
    saved_bytes <- readBin(notebook_path, "raw", file.info(notebook_path)$size)
    writeBin(saved_bytes, file.path(evidence, "saved-notebook.R"))
    saved_notebook <- alder:::read_notebook(notebook_path)
    check("save_preserves_other_64_cells", identical(
      lapply(nb$cells[-length(nb$cells)], function(c) c$records),
      lapply(saved_notebook$cells[-length(saved_notebook$cells)], function(c) c$records)))
    check("original_fixture_unchanged", identical(source_bytes,
      readBin(source_path, "raw", file.info(source_path)$size)))
    timed("save_acknowledged_seconds", await(function() {
      isTRUE(js("!hasUnsavedWork() && !actionInFlight"))
    }, "browser acknowledges completed save", 30))
    timed("reload_seconds", {
      loaded <- session$Page$loadEventFired(wait_ = FALSE)
      session$Page$reload(ignoreCache = TRUE)
      session$wait_for(loaded)
      check("reload_without_unsaved_changes_dialog", length(channels$dialogs) == 0)
      await(function() identical(as.integer(js("document.querySelectorAll('.cell').length")), length(nb$cells)), "reload all cells", 60)
    })
    check("reload_retains_saved_edit", grepl("Scale review: edited", js(sprintf(
      "window.__alderEditors.get('%s').getDoc()", final_id)), fixed = TRUE))
    check("reloaded_native_Run_all_click", helper$pointer_click_selector(session, "#run-all"))
    timed("browser_repeat_run_seconds", await(function() {
      settled() && !identical(cell(before, "quasi_likelihood_fit")$outputs,
                             cell(get_state(), "quasi_likelihood_fit")$outputs)
    }, "repeat full run"))
    check("repeat_run_same_scientific_result", grepl(reference$summary_text,
      text_output(cell(get_state(), "final_summary")), fixed = TRUE))
    save_json(get_state(), "state-final.json")
    screenshot("07-reloaded-summary", "final_summary")
    check("no_browser_exceptions", length(channels$exceptions) == 0)
    check("no_browser_console_errors", !any(vapply(channels$console,
      function(e) e$type %in% c("error", "warning"), logical(1))))
    check("native_Shutdown_click", helper$pointer_click_selector(session, "#shutdown"))
    timed("shutdown_seconds", await(function() !cli$is_alive(), "CLI shutdown", 20))
    check("CLI_shutdown_exit_zero", identical(cli$get_exit_status(), 0L))
    cli_stderr <- readLines(file.path(evidence, "cli.stderr"), warn = FALSE)
    check("CLI_stderr_empty", length(cli_stderr) == 0)
    save_json(list(complete = TRUE, checks = length(checks)), "complete.json")
  }, error = function(error) {
    failure <<- list(message = conditionMessage(error), classes = class(error),
                    call = paste(deparse(conditionCall(error)), collapse = "\n"))
    stop(error)
  })
  invisible(TRUE)
}

arguments <- commandArgs(trailingOnly = TRUE)
stopifnot(length(arguments) == 1L)
run_review(arguments[[1]])
