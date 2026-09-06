# alder worker — the one serial R process per notebook (ADR 0004).
#
# A long-lived Rscript. Reads one JSON request per line on stdin, writes one
# JSON response per line on stdout; stderr stays a diagnostic channel. The
# server spawns us, writes requests to our stdin, matches responses by `req`
# id, and SIGINTs us to interrupt a running cell. We own the notebook's
# global environment and widget values, so notebook state has a single
# unambiguous owner.
#
# The whole runtime is private (ADR 0006): notebook code evaluates directly
# in our process's .GlobalEnv with ordinary R lookup, while `emit`, the
# ownership maps, artifact paths, and jsonlite are invisible to it. This is
# process isolation, not a security sandbox — run only trusted notebook code.
#
# Protocol discipline: stdout carries protocol JSON ONLY. Every user-code
# output path (cat, print, auto-print of visible results, renderers) runs
# inside bounded captures and lands in the cell log or the rendered output;
# nothing user code prints may leak into the protocol stream.

suppressPackageStartupMessages(library(alder))

local({
  # Library bootstrap changes process-wide lookup, but its transport values
  # are worker implementation details. Keep every temporary binding outside
  # the notebook's .GlobalEnv just like the runtime state below.
  sandbox_lib <- Sys.getenv("ALDER_SANDBOX_LIB", unset = "")
  Sys.unsetenv("ALDER_SANDBOX_LIB")
  project_lib <- Sys.getenv("ALDER_PROJECT_LIB", unset = "")
  Sys.unsetenv("ALDER_PROJECT_LIB")
  if (nzchar(sandbox_lib)) {
    if (!dir.exists(sandbox_lib) || file.access(sandbox_lib, 4L) != 0L) {
      stop("ALDER_SANDBOX_LIB is invalid: '", sandbox_lib,
           "' (must be an existing readable directory)")
    }
    isolated <- c(normalizePath(sandbox_lib, mustWork = TRUE), .Library)
    if ("include.site" %in% names(formals(.libPaths))) {
      .libPaths(isolated, include.site = FALSE)
    } else {
      # Compatibility with R releases predating include.site: .libPaths()
      # stores its resolved search path in this unlocked base binding.
      assign(".lib.loc", unique(normalizePath(isolated, "/")),
             envir = environment(.libPaths))
    }
  } else if (nzchar(project_lib) && dir.exists(project_lib)) {
    .libPaths(c(normalizePath(project_lib, mustWork = TRUE), .libPaths()))
  }
})

local({

  `%||%` <- function(a, b) if (is.null(a)) b else a
  perf_begin <- get(".alder_perf_begin", asNamespace("alder"))
  perf_end <- get(".alder_perf_end", asNamespace("alder"))

  # -------------------------------------------------------------------------
  # Private environment: source the mirrored widget module here only so we can
  # recognise and validate widgets; the module's names are never part of the
  # notebook's lookup. Consume and immediately unset the transport variables.
  # -------------------------------------------------------------------------
  ui_module <- Sys.getenv("ALDER_UI_WIDGETS", unset = "")
  Sys.unsetenv("ALDER_UI_WIDGETS")
  UI_ENV <- new.env(parent = baseenv())
  if (!nzchar(ui_module) || !file.exists(ui_module)) {
    stop("alder widget module (ui-widgets.R) not found")
  }
  sys.source(ui_module, envir = UI_ENV)

  artifact_dir <- Sys.getenv("ALDER_ARTIFACT_DIR", unset = "")
  Sys.unsetenv("ALDER_ARTIFACT_DIR")
  cache_dir <- Sys.getenv("ALDER_CACHE_DIR", unset = "")
  Sys.unsetenv("ALDER_CACHE_DIR")
  notebook_dir <- Sys.getenv("ALDER_NOTEBOOK_DIR", unset = "")
  Sys.unsetenv("ALDER_NOTEBOOK_DIR")
  if (!nzchar(artifact_dir) || !dir.exists(artifact_dir) ||
      file.access(artifact_dir, 2) != 0L) {
    stop("ALDER_ARTIFACT_DIR is missing or invalid: '", artifact_dir,
         "' (must be an existing writable directory)")
  }
  if (!nzchar(cache_dir) || !dir.exists(cache_dir) ||
      file.access(cache_dir, 2) != 0L) {
    stop("ALDER_CACHE_DIR is missing or invalid: '", cache_dir,
         "' (must be an existing writable directory)")
  }
  if (nzchar(notebook_dir)) {
    if (!dir.exists(notebook_dir)) {
      stop("ALDER_NOTEBOOK_DIR is invalid: '", notebook_dir,
           "' (must be an existing directory)")
    }
    setwd(normalizePath(notebook_dir, mustWork = TRUE))
  }

NB_ENV <- globalenv() # notebook globals live in .GlobalEnv
CELL_DEFS <- new.env(parent = emptyenv()) # cell id -> owned definition names
CELL_LOCALS <- new.env(parent = emptyenv()) # cell id -> mangled local names
NAME_OWNER <- new.env(parent = emptyenv())# name -> owning cell id
  SEQ <- new.env(parent = emptyenv())
  SEQ$value <- 0L
  LAZY_SEQ <- new.env(parent = emptyenv())
  LAZY_SEQ$value <- 0L
  TABLE_SEQ <- new.env(parent = emptyenv())
  TABLE_SEQ$value <- 0L
  TABLE_HANDLES <- new.env(parent = emptyenv())
  CURRENT_CELL <- NULL
  CURRENT_REQ <- NULL
  CURRENT_RUN_ID <- NULL
  LAZY_ENV <- new.env(parent = emptyenv())
  EMITTED_OUTPUTS <- new.env(parent = emptyenv())
  EMITTED_OUTPUTS$value <- list()
  CAPTURE_SINK <- new.env(parent = emptyenv())
  CAPTURE_SINK$active <- FALSE
  CAPTURE_SINK$con <- NULL
  RENDER_LOG <- new.env(parent = emptyenv())
  RENDER_LOG$value <- character()

  capture_offset <- function() {
    if (!isTRUE(CAPTURE_SINK$active) || is.null(CAPTURE_SINK$con)) return(NULL)
    flush(CAPTURE_SINK$con)
    path <- summary(CAPTURE_SINK$con)$description
    # Match readLines() newline normalization and count characters, so report
    # slicing also works inside a partial line containing multibyte text.
    prefix <- utf8_prefix(readBin(path, "raw", n = 1048576L))
    nchar(gsub("\r\n", "\n", prefix, fixed = TRUE), type = "chars")
  }

  notify <- function(kind, payload) {
    if (is.null(CURRENT_REQ) || is.null(CURRENT_CELL)) return(invisible())
    if (identical(kind, "append") && !is.null(payload$output)) {
      payload$output$log_offset <- capture_offset()
      EMITTED_OUTPUTS$value <- c(EMITTED_OUTPUTS$value %||% list(),
                                 list(payload$output))
    }
    SEQ$value <- as.integer(SEQ$value %||% 0L) + 1L
    emit(list(notify = kind, req = CURRENT_REQ, id = CURRENT_CELL,
              run_id = CURRENT_RUN_ID, seq = SEQ$value, payload = payload))
    invisible()
  }

  inject_runtime <- function() {
    if (!("alder" %in% loadedNamespaces())) return(invisible())
    rt <- get("RUNTIME", envir = asNamespace("alder"))
    rt$emit <- notify
    rt$render <- function(x) {
      output <- render_kind(x)
      if (identical(output$kind, "error")) stop(output$message, call. = FALSE)
      structure(output, class = c("alder_output", "list"))
    }
    rt$cell_id <- function() CURRENT_CELL
    rt$artifact_dir <- artifact_dir
    rt$cache_dir <- cache_dir
    rt$lazy <- LAZY_ENV
    rt$lazy_seq <- LAZY_SEQ
    rt$seq <- SEQ
  }
  tryCatch(setHook(packageEvent("alder", "attach"),
                   function(...) inject_runtime()), error = function(e) NULL)

  emit <- function(x) {
    perf <- perf_begin("kernel.emit", list(req = x$req, cell = x$id,
      revision = x$revision, run_id = x$run_id, ack = x$ack, notify = x$notify))
    on.exit(perf_end(perf), add = TRUE)
    line <- jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null",
                             force = TRUE)
    restore_capture <- isTRUE(CAPTURE_SINK$active) &&
      sink.number(type = "output") > 0L
    if (restore_capture) {
      sink()
      on.exit(sink(CAPTURE_SINK$con, append = TRUE), add = TRUE)
    }
    writeLines(line, con = stdout(), sep = "\n")
    flush(stdout())
  }

  # -------------------------------------------------------------------------
  # Bounded capture: sink evaluation/render output to a temporary file so a
  # noisy cell can never corrupt the protocol stream, cap it at `max_bytes`,
  # and always unlink the file. Warnings/messages are written to the same
  # stream and muffled. Returns list(result, lines, truncated, error,
  # interrupted).
  # -------------------------------------------------------------------------
  restore_sinks <- function() {
    while (sink.number() > 0L) tryCatch(sink(), error = function(e) NULL)
    invisible()
  }

  # A valid-UTF-8 prefix of a raw byte vector: back off over continuation
  # bytes and never split a lead byte's sequence. A complete trailing
  # multibyte character is kept whole.
  utf8_prefix <- function(ra) {
    n <- length(ra)
    if (n == 0L) return("")
    j <- n
    while (j > 1L && bitwAnd(as.integer(ra[[j]]), 0xC0L) == 0x80L) j <- j - 1L
    if (j == 1L && bitwAnd(as.integer(ra[[j]]), 0xC0L) == 0x80L) return("")
    lead <- as.integer(ra[[j]])
    need <- if (lead < 0x80L) 1L else if (lead < 0xE0L) 2L else
            if (lead < 0xF0L) 3L else 4L
    if (j + need - 1L <= n) {
      rawToChar(ra[seq_len(j + need - 1L)])
    } else if (j > 1L) {
      rawToChar(ra[seq_len(j - 1L)])
    } else {
      ""
    }
  }

  bounded_capture <- function(run, max_bytes, include_conditions = TRUE) {
    f <- tempfile("alder-cap-")
    con <- NULL
    result <- NULL
    err <- NULL
    err_condition <- NULL
    err_trace <- list()
    interrupted <- FALSE
    condition_lines <- character()
    condition_bytes <- 0L
    conditions_truncated <- FALSE
    record_condition <- function(line) {
      line <- sub("\n$", "", line)
      remaining <- max_bytes - condition_bytes
      if (remaining <= 0L) {
        conditions_truncated <<- TRUE
        return(invisible())
      }
      bytes <- charToRaw(line)
      if (length(bytes) > remaining) {
        line <- utf8_prefix(bytes[seq_len(remaining)])
        conditions_truncated <<- TRUE
      }
      condition_lines <<- c(condition_lines, line)
      condition_bytes <<- condition_bytes + nchar(line, type = "bytes") + 1L
      invisible()
    }
    tryCatch({
      con <- file(f, open = "wt")
      CAPTURE_SINK$con <- con
      CAPTURE_SINK$active <- TRUE
      sink(con)
      tryCatch(withCallingHandlers(
        result <- run(),
        error = function(e) {
          err_trace <<- sys.calls()
        },
        message = function(m) {
          line <- conditionMessage(m)
          record_condition(line)
          if (isTRUE(include_conditions)) cat(line)
          notify("log", list(lines = line))
          invokeRestart("muffleMessage")
        },
        warning = function(w) {
          line <- paste0("Warning: ", conditionMessage(w))
          record_condition(line)
          if (isTRUE(include_conditions)) cat(line, "\n", sep = "")
          notify("log", list(lines = line))
          invokeRestart("muffleWarning")
        }),
        error = function(e) {
          err <<- conditionMessage(e)
          err_condition <<- e
        },
        interrupt = function(e) {
          interrupted <<- TRUE
          err_condition <<- e
        })
    }, finally = {
      CAPTURE_SINK$active <- FALSE
      CAPTURE_SINK$con <- NULL
      restore_sinks()
      if (!is.null(con)) tryCatch(close(con), error = function(e) NULL)
    })
    sz <- file.info(f)$size
    truncated <- FALSE
    lines <- character()
    if (!is.na(sz) && sz > 0) {
      if (sz <= max_bytes) {
        lines <- readLines(f, warn = FALSE)
      } else {
        truncated <- TRUE
        txt <- utf8_prefix(readBin(f, "raw", n = max_bytes))
        lines <- strsplit(txt, "\n", fixed = TRUE)[[1L]]
        if (length(lines) && !nzchar(lines[[length(lines)]])) {
          lines <- lines[-length(lines)]
        }
        lines <- c(lines, sprintf("[output truncated at %s bytes]", max_bytes))
      }
    }
    unlink(f)
    if (conditions_truncated) {
      condition_lines <- c(condition_lines,
        sprintf("[conditions truncated at %s bytes]", max_bytes))
    }
    list(result = result, lines = lines, truncated = truncated,
         error = err, condition = err_condition, trace = err_trace,
         interrupted = interrupted, condition_lines = condition_lines)
  }

  # Layout/append constructors can render while the cell is being captured.
  # Suspend that sink so the renderer's bounded capture and JSON notifications
  # retain their normal single-capture behavior, then restore it even on error.
  # Copy conditions back at their actual position in the surrounding cell log.
  render_capture <- function(run, max_bytes) {
    parent_con <- if (isTRUE(CAPTURE_SINK$active)) CAPTURE_SINK$con else NULL
    if (!is.null(parent_con)) {
      sink()
      CAPTURE_SINK$active <- FALSE
      CAPTURE_SINK$con <- NULL
      on.exit({
        CAPTURE_SINK$con <- parent_con
        CAPTURE_SINK$active <- TRUE
        sink(parent_con, append = TRUE)
      }, add = TRUE)
    }
    cap <- bounded_capture(run, max_bytes, include_conditions = FALSE)
    if (length(cap$condition_lines)) {
      if (!is.null(parent_con)) {
        writeLines(cap$condition_lines, parent_con)
      } else {
        RENDER_LOG$value <- c(RENDER_LOG$value, cap$condition_lines)
      }
    }
    if (isTRUE(cap$interrupted)) {
      if (!is.null(cap$condition)) stop(cap$condition)
      stop(structure(list(message = "Interrupted", call = NULL),
                     class = c("interrupt", "condition")))
    }
    cap
  }

  # Bound every element of a character vector to a valid-UTF-8 prefix of at
  # most `max_bytes` bytes (no marker: the cap itself is the contract).
  bounded_chr <- function(v, max_bytes) {
    v <- as.character(v)
    vapply(v, function(s) {
      if (is.na(s)) return(s)
      ra <- charToRaw(s)
      if (length(ra) <= max_bytes) return(s)
      utf8_prefix(ra[seq_len(max_bytes)])
    }, character(1))
  }

  condition_payload <- function(condition, fallback = "Unknown error",
                                trace = list()) {
    message <- as.character(if (is.null(condition)) fallback else
      conditionMessage(condition))
    classes <- if (is.null(condition)) "error" else class(condition)
    call <- if (is.null(condition)) NULL else conditionCall(condition)
    call_text <- if (is.null(call)) NULL else
      bounded_chr(paste(deparse(call, width.cutoff = 120L), collapse = " "),
                  2048L)[[1L]]
    trace_text <- if (!length(trace)) character() else {
      trace <- utils::tail(trace, 40L)
      vapply(trace, function(entry) bounded_chr(
        paste(deparse(entry, width.cutoff = 120L), collapse = " "), 2048L
      )[[1L]], character(1))
    }
    list(
      message = bounded_chr(message, 16384L)[[1L]],
      class = I(bounded_chr(classes, 256L)),
      call = call_text,
      trace = I(trace_text)
    )
  }

  # -------------------------------------------------------------------------
  table_data_frame <- function(x) {
    if (inherits(x, "matrix")) {
      return(as.data.frame(x, stringsAsFactors = FALSE,
                          check.names = FALSE))
    }
    as.data.frame(x, stringsAsFactors = FALSE, check.names = FALSE)
  }

  preview_chr <- function(x) {
    if (length(x) == 0L || is.na(x[[1L]])) return("NA")
    bounded_chr(as.character(x[[1L]]), 512L)[[1L]]
  }

  table_page_record <- function(x, offset = 0L, limit = 25L,
                                sort_by = "", sort_desc = FALSE,
                                filter = "") {
    df <- table_data_frame(x)
    nr <- nrow(df)
    nc <- ncol(df)
    columns <- names(df)
    if (is.null(columns)) columns <- as.character(seq_len(nc))
    if (nzchar(filter)) {
      candidates <- which(vapply(df, function(col)
        is.character(col) || is.factor(col), logical(1)))
      if (length(candidates)) {
        matched <- lapply(df[candidates], function(col)
          grepl(filter, as.character(col), fixed = TRUE, ignore.case = TRUE))
        keep <- Reduce("|", matched)
      } else {
        keep <- rep(FALSE, nrow(df))
      }
      df <- df[keep, , drop = FALSE]
      nr <- nrow(df)
    }
    if (nzchar(sort_by)) {
      if (!(sort_by %in% names(df))) {
        return(list(error = list(code = "table_unavailable",
                                 message = "table sort column is unavailable")))
      }
      ord <- order(df[[sort_by]], decreasing = isTRUE(sort_desc),
                   na.last = TRUE)
      df <- df[ord, , drop = FALSE]
    }
    offset <- max(0L, as.integer(offset))
    limit <- min(200L, max(1L, as.integer(limit)))
    first <- if (offset < nr) offset + 1L else 1L
    last <- if (offset < nr) min(nr, offset + limit) else 0L
    selected <- if (last >= first) {
      df[first:last, , drop = FALSE]
    } else {
      df[FALSE, , drop = FALSE]
    }
    visible_columns <- seq_len(min(ncol(selected), 50L))
    if (length(visible_columns)) {
      selected <- selected[, visible_columns, drop = FALSE]
    }
    rows <- lapply(seq_len(nrow(selected)), function(i)
      unname(lapply(selected[i, , drop = FALSE], preview_chr)))
    list(nrow = as.numeric(nr), ncol = as.numeric(nc),
         columns = I(bounded_chr(columns[seq_len(min(nc, 50L))], 256L)),
         preview = I(rows), offset = as.numeric(offset),
         limit = as.numeric(limit), sort_by = as.character(sort_by),
         sort_desc = isTRUE(sort_desc), filter = as.character(filter),
         truncated_rows = nr > offset + limit,
         truncated_columns = nc > 50L)
  }

  render_table <- function(x, cell_id = CURRENT_CELL, name = "",
                           path = character()) {
    TABLE_SEQ$value <- as.integer(TABLE_SEQ$value %||% 0L) + 1L
    handle <- paste0(as.character(cell_id %||% ""), ":",
                     as.character(name %||% ""), ":", TABLE_SEQ$value)
    # A visible table does not need to be assigned to a name (for example,
    # `data.frame(x = 1:100)`).  Keep the ordinary name/path reference when
    # one exists, and retain a copy-on-write fallback for anonymous results so
    # every rendered table can use paging, sorting, and filtering.
    TABLE_HANDLES[[handle]] <- list(
      name = as.character(name %||% ""),
      path = as.character(path %||% character()),
      value = x
    )
    page <- table_page_record(x)
    if (!is.null(page$error)) return(list(kind = "error",
                                          message = page$error$message))
    page$kind <- "table"
    page$handle <- handle
    page
  }

  render_plot <- function(x) {
    f <- tempfile(tmpdir = artifact_dir, fileext = ".png")
    devices_before <- unname(grDevices::dev.list())
    complete <- FALSE
    on.exit({
      # A failed third-party print method can leave ggsave's device open.
      # Close only devices introduced by this renderer, identified by number.
      devices_after <- unname(grDevices::dev.list())
      for (device in rev(setdiff(devices_after, devices_before))) {
        tryCatch(grDevices::dev.off(which = device), error = function(e) NULL)
      }
      if (!complete && file.exists(f)) unlink(f)
    }, add = TRUE)

    ggplot2::ggsave(f, plot = x, width = 8, height = 5, dpi = 96)
    if (!file.exists(f) || is.na(file.info(f)$size) || file.info(f)$size <= 0) {
      stop("ggplot renderer produced no image", call. = FALSE)
    }
    complete <- TRUE
    list(kind = "image", artifact = basename(f))
  }

  render_htmlwidget <- function(x) {
    stage <- tempfile(tmpdir = artifact_dir)
    if (!dir.create(stage)) {
      stop("could not create htmlwidget staging directory", call. = FALSE)
    }
    o <- file.path(stage, "index.html")
    dest <- tempfile(tmpdir = artifact_dir, fileext = ".html")
    complete <- FALSE
    on.exit({
      unlink(stage, recursive = TRUE)
      if (!complete && file.exists(dest)) unlink(dest)
    }, add = TRUE)

    if (is.null(x$width)) x$width <- "100%"
    htmlwidgets::saveWidget(x, o, selfcontained = TRUE)
    if (!file.exists(o)) {
      stop("htmlwidget renderer produced no HTML file", call. = FALSE)
    }
    if (!file.rename(o, dest)) {
      stop("could not promote the rendered htmlwidget artifact", call. = FALSE)
    }
    complete <- TRUE
    list(kind = "html", artifact = basename(dest))
  }

  wire_widget_value <- function(kind, value) {
    if (identical(kind, "date")) return(format(value, "%Y-%m-%d"))
    if (identical(kind, "date_range")) return(format(value, "%Y-%m-%d"))
    if (identical(kind, "datetime")) {
      return(format(value, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"))
    }
    if (identical(kind, "multiselect")) return(I(value))
    if (identical(kind, "form") && is.null(value)) return(NULL)
    value
  }

  widget_table_page <- function(value, page_size) {
    tryCatch(
      table_page_record(value, offset = 0, limit = page_size),
      error = function(e) NULL)
  }

  widget_wire_spec <- function(x, cell_id, name = "", path = character()) {
    kind <- x$kind
    spec <- list(kind = kind, label = x$label,
                 value = wire_widget_value(kind, x$value))
    if (kind %in% c("slider", "range_slider", "number")) {
      spec$min <- x$min
      spec$max <- x$max
      spec$step <- x$step
    } else if (kind %in% c("dropdown", "radio", "multiselect")) {
      spec$choices <- I(x$choices)
      indices <- vapply(x$choices, function(choice)
        identical(choice, x$value), logical(1))
      if (kind %in% c("dropdown", "radio")) {
        if (any(indices)) spec$index <- which(indices)[[1L]]
      } else {
        spec$indices <- I(which(vapply(x$choices, function(choice)
          any(vapply(x$value, function(value)
            identical(choice, value), logical(1))), logical(1))))
      }
    } else if (kind == "text_area") {
      spec$rows <- x$rows
    } else if (kind == "date") {
      spec$min <- if (is.null(x$min)) NULL else format(x$min, "%Y-%m-%d")
      spec$max <- if (is.null(x$max)) NULL else format(x$max, "%Y-%m-%d")
    } else if (kind == "date_range") {
      spec$min <- if (is.null(x$min)) NULL else format(x$min, "%Y-%m-%d")
      spec$max <- if (is.null(x$max)) NULL else format(x$max, "%Y-%m-%d")
    } else if (kind == "datetime") {
      spec$min <- if (is.null(x$min)) NULL else
        format(x$min, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
      spec$max <- if (is.null(x$max)) NULL else
        format(x$max, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
    } else if (kind == "code_editor") {
      spec$language <- x$language
    } else if (kind == "refresh") {
      spec$interval <- x$interval
      spec$paused <- isTRUE(x$paused)
    } else if (kind == "file") {
      spec$accept <- x$accept
      spec$multiple <- isTRUE(x$multiple)
    } else if (kind == "table") {
      handle <- x$handle %||% NULL
      if (is.null(handle) || !exists(handle, envir = TABLE_HANDLES,
                                      inherits = FALSE)) {
        TABLE_SEQ$value <- as.integer(TABLE_SEQ$value %||% 0L) + 1L
        handle <- paste0(cell_id, ":", name, ":", TABLE_SEQ$value)
        TABLE_HANDLES[[handle]] <- list(name = name, path = c(path, "data"))
      }
      spec$handle <- handle
      spec$selection <- x$selection
      spec$page_size <- x$page_size
      spec$selected <- I(as.integer(x$selected %||% integer()))
      spec$page <- widget_table_page(x$data, x$page_size)
    } else if (kind == "dataframe") {
      handle <- x$handle %||% NULL
      if (is.null(handle) || !exists(handle, envir = TABLE_HANDLES,
                                      inherits = FALSE)) {
        TABLE_SEQ$value <- as.integer(TABLE_SEQ$value %||% 0L) + 1L
        handle <- paste0(cell_id, ":", name, ":", TABLE_SEQ$value)
        TABLE_HANDLES[[handle]] <- list(name = name, path = c(path, "data"))
      }
      spec$handle <- handle
      spec$ops <- x$ops %||% list()
      spec$page <- widget_table_page(x$data, 25L)
    } else if (kind %in% c("array", "dictionary")) {
      spec$children <- lapply(names(x$children), function(child_name) {
        child <- widget_wire_spec(x$children[[child_name]], cell_id, name,
                                  c(path, child_name))
        child$name <- child_name
        child
      })
    } else if (kind == "form") {
      spec$submit_label <- x$submit_label
      spec$dirty <- isTRUE(x$dirty)
      spec$child <- widget_wire_spec(x$child, cell_id, name, path)
    }
    spec
  }

  widget_spec <- function(x, cell_id = CURRENT_CELL, name = "",
                          path = character()) {
    widget_wire_spec(x, cell_id, name, path)
  }

  # Render a non-widget value inside one bounded capture so renderer/formatter
  # output can never reach protocol stdout. `print()` writes directly to the
  # capture's sink; the captured lines become the generic visible text.
  artifact_name_ok <- function(name, extensions = NULL) {
    is.character(name) && length(name) == 1L && !is.na(name) &&
      nzchar(name) && !grepl("[/\\\\]", name) && !grepl("^\\.", name) &&
      (is.null(extensions) || tolower(tools::file_ext(name)) %in% extensions) &&
      file.exists(file.path(artifact_dir, name))
  }
  validate_rendered_output <- function(value) {
    if (!is.list(value) || !is.character(value$kind) ||
        length(value$kind) != 1L) {
      return(list(kind = "error", message = "invalid alder output record"))
    }
    kind <- value$kind
    if (kind %in% c("image", "html", "media")) {
      extensions <- if (kind == "image") "png" else if (kind == "html") "html" else NULL
      if (!artifact_name_ok(value$artifact, extensions)) {
        return(list(kind = "error", message = "alder output artifact is unavailable"))
      }
    }
    if (identical(kind, "layout")) {
      value$children <- lapply(value$children %||% list(), validate_rendered_output)
    } else if (identical(kind, "lazy") && !is.null(value$child)) {
      value$child <- validate_rendered_output(value$child)
    }
    value
  }

  open_png_device <- function(f) {
    if (requireNamespace("ragg", quietly = TRUE)) {
      ragg::agg_png(f, width = 800, height = 500, units = "px", res = 96)
    } else {
      grDevices::png(f, width = 800, height = 500, units = "px", res = 96)
    }
    invisible()
  }

  render_recordedplot <- function(x) {
    f <- tempfile(tmpdir = artifact_dir, fileext = ".png")
    render_device <- NULL
    complete <- FALSE
    on.exit({
      if (!is.null(render_device)) {
        devices <- grDevices::dev.list()
        if (!is.null(devices) && render_device %in% unname(devices)) {
          tryCatch(grDevices::dev.off(which = render_device),
                   error = function(e) NULL)
        }
      }
      if (!complete && file.exists(f)) unlink(f)
    }, add = TRUE)

    open_png_device(f)
    render_device <- unname(grDevices::dev.cur())
    grDevices::replayPlot(x)
    grDevices::dev.off(which = render_device)
    render_device <- NULL
    if (!file.exists(f) || is.na(file.info(f)$size) || file.info(f)$size <= 0) {
      stop("recorded plot renderer produced no image", call. = FALSE)
    }
    complete <- TRUE
    list(kind = "image", artifact = basename(f))
  }

  render_text_value <- function(x, show = FALSE) {
    cap <- render_capture(function() {
      if (isTRUE(show)) methods::show(x) else print(x)
    }, 262144L)
    if (!is.null(cap$error)) {
      return(list(kind = "error", message = paste("could not render value:",
                                                   cap$error)))
    }
    list(kind = "text", text = paste(cap$lines, collapse = "\n"),
         truncated = cap$truncated)
  }
  render_s4_value <- function(x) {
    classes <- tryCatch(methods::class(x), error = function(e) character())
    is_virtual <- if (length(classes)) {
      any(vapply(classes, function(class_name) {
        isTRUE(tryCatch(methods::isVirtualClass(class_name),
                        error = function(e) FALSE))
      }, logical(1)))
    } else {
      FALSE
    }
    render_text_value(x, show = !is_virtual)
  }

  render_kind <- function(x, cell_id = CURRENT_CELL, name = "",
                          path = character()) {
    if (inherits(x, "alder_output")) {
      return(validate_rendered_output(unclass(x)))
    }
    if (inherits(x, "alder_progress")) {
      return(list(kind = "error", message = "a progress handle is not an output"))
    }
    # summary() results carry class "summaryDefault" but inherit "table",
    # whose dimnames shape breaks render_table. Their printed form (what the
    # REPL shows) is the useful output, so render them as text.
    if (inherits(x, "summaryDefault")) {
      return(render_text_value(x))
    }
    if (inherits(x, "data.frame") || inherits(x, "matrix") ||
        inherits(x, "table") || inherits(x, "tbl_df") ||
        inherits(x, "data.table")) {
      cap <- render_capture(
        function() render_table(x, cell_id = cell_id, name = name, path = path),
        262144L)
      if (!is.null(cap$error)) {
        # A table-shaped object the renderer cannot page still has a printed
        # form; fall back to text instead of failing the whole cell.
        fallback <- tryCatch(render_text_value(x), error = function(e) NULL)
        if (!is.null(fallback) && identical(fallback$kind, "text")) {
          return(fallback)
        }
        return(list(kind = "error", message = paste("could not render value:",
                                                     cap$error)))
      }
      return(cap$result)
    }
    if (inherits(x, "gg") || inherits(x, "ggplot")) {
      cap <- render_capture(function() render_plot(x), 262144L)
      if (!is.null(cap$error)) {
        return(list(kind = "error", message = paste("could not render value:",
                                                    cap$error)))
      }
      return(cap$result)
    }
    if (inherits(x, "htmlwidget")) {
      cap <- render_capture(function() render_htmlwidget(x), 262144L)
      if (!is.null(cap$error)) {
        return(list(kind = "error", message = paste("could not render value:",
                                                    cap$error)))
      }
      return(cap$result)
    }
    if (inherits(x, "recordedplot")) {
      cap <- render_capture(function() render_recordedplot(x), 262144L)
      if (!is.null(cap$error)) {
        return(list(kind = "error", message = paste("could not render value:",
                                                    cap$error)))
      }
      return(cap$result)
    }
    if (isS4(x)) return(render_s4_value(x))
    if (inherits(x, "S7_object")) return(render_text_value(x))
    render_text_value(x)
  }

  # Render a visible value. Widgets render only when the visible expression
  # is a bare global name owned by the defining cell; any other widget in
  # the visible slot is a structured error, not a control.
  render_visible <- function(x, vname, id, owned) {
    if (inherits(x, "alder_output")) return(unclass(x))
    if (UI_ENV$is_widget(x)) {
      if (!nzchar(vname) || !(vname %in% owned)) {
        return(list(kind = "error",
          message = paste0("interactive widget must be assigned in this cell ",
                           "and end the cell with that name: ", vname)))
      }
      return(list(kind = "widget", name = vname, owner = id,
                  commit_token = NULL, spec = widget_spec(x, id, vname)))
    }
    render_kind(x, cell_id = id, name = vname)
  }

  # Generic value rendering for get_value inspection (the Session gates
  # widget names separately).
  render_inspect <- function(x) {
    if (UI_ENV$is_widget(x)) {
      return(list(kind = "error", message = "widget values are not inspected"))
    }
    render_kind(x)
  }

  # -------------------------------------------------------------------------
  # Commands
  # -------------------------------------------------------------------------

  # A JSON array arrives under simplifyVector = FALSE as a list; normalize it
  # to a character vector, rejecting non-string, empty, or duplicate names as
  # protocol data.
  normalize_defs <- function(d) {
    if (is.null(d)) return(character())
    v <- unlist(d, use.names = FALSE)
    if (is.null(v)) return(character())
    if (!is.character(v)) return(NULL)
    if (anyNA(v) || any(!nzchar(v)) || any(duplicated(v))) return(NULL)
    v
  }
  local_mangled_name <- function(id, name) {
    cell_key <- gsub("[^A-Za-z0-9_]", "_", id)
    name_key <- sub("^\\.", "", name)
    paste0(".alder_local_", cell_key, "_", name_key)
  }

  mangle_local_expr <- function(node, mapping) {
    if (!length(mapping)) return(node)
    if (is.symbol(node)) {
      nm <- as.character(node)
      if (nm %in% names(mapping)) return(as.name(mapping[[nm]]))
      return(node)
    }
    if (is.pairlist(node)) {
      out <- node
      for (i in seq_along(out)) {
        out[i] <- list(mangle_local_expr(out[[i]], mapping))
      }
      return(out)
    }
    if (!is.call(node)) return(node)
    head <- node[[1L]]
    head_name <- if (is.symbol(head)) as.character(head) else ""
    call_name <- head_name
    if (is.call(head) && length(head) >= 3L && is.symbol(head[[1L]]) &&
        as.character(head[[1L]]) %in% c("::", ":::") &&
        is.symbol(head[[2L]]) && identical(as.character(head[[2L]]), "base") &&
        is.symbol(head[[3L]])) {
      call_name <- as.character(head[[3L]])
    }
    if (head_name %in% c("quote", "substitute", "expression", "alist")) {
      return(node)
    }
    parts <- as.list(node)
    arg_names <- names(parts)
    if (is.null(arg_names)) arg_names <- rep("", length(parts))
    if (identical(call_name, "assign") && length(parts) == 3L) {
      call_names <- arg_names[-1L]
      target <- which(call_names == "x")
      if (!length(target)) target <- which(!nzchar(call_names))[[1L]]
      target <- target[[1L]] + 1L
      if (is.character(parts[[target]]) && length(parts[[target]]) == 1L &&
          parts[[target]] %in% names(mapping)) {
        parts[[target]] <- unname(mapping[[parts[[target]]]])
      }
    } else if (call_name %in% c("rm", "remove") &&
               !any(nzchar(arg_names[-1L]))) {
      for (i in seq_along(parts)[-1L]) {
        if (is.character(parts[[i]]) && length(parts[[i]]) == 1L &&
            parts[[i]] %in% names(mapping)) {
          parts[[i]] <- unname(mapping[[parts[[i]]]])
        }
      }
    }
    for (i in seq_along(parts)) {
      parts[i] <- list(mangle_local_expr(parts[[i]], mapping))
    }
    as.call(parts)
  }

  mangle_local_exprs <- function(exprs, mapping) {
    if (!length(mapping)) return(exprs)
    lapply(exprs, mangle_local_expr, mapping = mapping)
  }

  # eval_cell carries the analyzed unique definition-name array. Entering:
  # drop this cell's previous bindings, evaluate directly in NB_ENV. Success:
  # own only requested definitions that now exist. Error/interrupt: remove
  # definitions created before the failure and leave this cell with none.
  # Empty code therefore completes cleanup without a special early return.
  exec_cell <- function(req) {
    perf <- perf_begin("kernel.execute", list(req = req$req, cell = req$id,
      revision = req$revision, run_id = req$run_id))
    on.exit(perf_end(perf), add = TRUE)
    id <- as.character(req$id %||% "")
    code <- as.character(req$code %||% "")
    defs <- normalize_defs(req$defs)
    locals <- normalize_defs(req$locals)
    opaque <- req$opaque %||% FALSE
    if (is.null(defs) || is.null(locals) || !is.logical(opaque) ||
        length(opaque) != 1L || is.na(opaque)) {
      return(list(ok = FALSE, outputs = list(), stopped = FALSE,
                  log = character(),
                  error = list(message = "invalid definition, local, or opaque value")))
    }
    local_map <- setNames(
      vapply(locals, function(nm) local_mangled_name(id, nm), character(1)),
      locals)
    local_names <- unname(local_map)
    CURRENT_CELL <<- id
    CURRENT_REQ <<- as.numeric(req$req %||% NA_real_)
    CURRENT_RUN_ID <<- as.numeric(req$run_id %||% NA_real_)
    SEQ$value <- 0L
    EMITTED_OUTPUTS$value <- list()
    RENDER_LOG$value <- character()
    inject_runtime()
    on.exit({
      CURRENT_CELL <<- NULL
      CURRENT_REQ <<- NULL
      CURRENT_RUN_ID <<- NULL
      EMITTED_OUTPUTS$value <- list()
      RENDER_LOG$value <- character()
    }, add = TRUE)

    old_lazy <- ls(LAZY_ENV, all.names = TRUE)
    old_lazy <- old_lazy[startsWith(old_lazy, paste0(id, ":"))]
    if (length(old_lazy)) rm(list = old_lazy, envir = LAZY_ENV)
    old_tables <- ls(TABLE_HANDLES, all.names = TRUE)
    old_tables <- old_tables[startsWith(old_tables, paste0(id, ":"))]
    if (length(old_tables)) rm(list = old_tables, envir = TABLE_HANDLES)
    for (nm in CELL_DEFS[[id]] %||% character()) {
      if (identical(NAME_OWNER[[nm]] %||% NULL, id)) {
        rm(list = nm, envir = NB_ENV)
        NAME_OWNER[[nm]] <- NULL
      }
    }
    CELL_DEFS[[id]] <- NULL
    for (nm in CELL_LOCALS[[id]] %||% character()) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        rm(list = nm, envir = NB_ENV)
      }
    }
    CELL_LOCALS[[id]] <- local_names

    pre <- ls(NB_ENV, all.names = TRUE)
    pre_values <- if (isTRUE(opaque) && length(pre)) {
      mget(pre, envir = NB_ENV, inherits = FALSE)
    } else {
      NULL
    }
    exprs <- tryCatch(parse(text = code), error = function(e) NULL)
    if (is.null(exprs)) {
      CELL_LOCALS[[id]] <- NULL
      return(list(ok = FALSE, outputs = list(), stopped = FALSE,
                  log = character(),
                  error = list(message = "could not parse cell source")))
    }
    exprs <- mangle_local_exprs(exprs, local_map)
    value <- NULL
    visible <- FALSE
    vname <- ""
    base_device <- NULL
    base_device_name <- NULL
    base_scratch <- NULL
    base_page <- NULL
    base_page_pending <- FALSE
    base_before_hook <- NULL
    base_after_hook <- NULL
    base_before_installed <- FALSE
    base_after_installed <- FALSE
    base_cleaned <- FALSE
    base_capture_condition <- NULL
    base_capture_trace <- list()

    remember_base_capture_error <- function(error) {
      if (is.null(base_capture_condition)) {
        base_capture_condition <<- error
        base_capture_trace <<- sys.calls()
      }
      invisible()
    }
    base_device_alive <- function() {
      if (is.null(base_device) || is.null(base_device_name)) return(FALSE)
      devices <- grDevices::dev.list()
      if (is.null(devices)) return(FALSE)
      match <- which(unname(devices) == base_device)
      length(match) == 1L && identical(names(devices)[[match]], base_device_name)
    }
    restore_device <- function(device) {
      number <- unname(device)
      if (identical(number, base_device)) return(invisible())
      devices <- grDevices::dev.list()
      if (!is.null(devices) && number %in% unname(devices)) {
        tryCatch(grDevices::dev.set(number), error = function(error) {
          remember_base_capture_error(error)
        })
      }
      invisible()
    }
    begin_base_page <- function() {
      page <- new.env(parent = emptyenv())
      page$snapshot <- NULL
      base_page <<- page
      marker <- structure(list(page = page, log_offset = capture_offset()),
                          class = "alder_recorded_page")
      EMITTED_OUTPUTS$value <- c(EMITTED_OUTPUTS$value %||% list(),
                                 list(marker))
      invisible()
    }
    checkpoint_base_page <- function(finalize = FALSE) {
      # A display list can contain device setup such as par(mfrow=) before a
      # page exists. Only the post-plot.new hook creates a page marker; this
      # prevents setup-only snapshots from becoming blank output images.
      if (is.null(base_page) || !base_device_alive() ||
          !is.null(base_capture_condition)) {
        if (isTRUE(finalize)) base_page <<- NULL
        return(invisible())
      }
      previous <- grDevices::dev.cur()
      tryCatch({
        if (unname(previous) != base_device) grDevices::dev.set(base_device)
        recorded <- grDevices::recordPlot()
        if (!is.null(recorded[[1L]])) {
          base_page$snapshot <- recorded
        }
      }, error = function(error) {
        remember_base_capture_error(error)
      }, finally = restore_device(previous))
      if (isTRUE(finalize)) base_page <<- NULL
      invisible()
    }
    base_before_hook <- function() {
      tryCatch({
        base_page_pending <<- FALSE
        if (!base_device_alive() ||
            unname(grDevices::dev.cur()) != base_device) return(invisible())
        if (isTRUE(graphics::par("page"))) {
          checkpoint_base_page(finalize = TRUE)
          base_page_pending <<- TRUE
        }
      }, error = function(error) {
        remember_base_capture_error(error)
      })
      invisible()
    }
    base_after_hook <- function() {
      tryCatch({
        if (isTRUE(base_page_pending) && base_device_alive() &&
            unname(grDevices::dev.cur()) == base_device) {
          begin_base_page()
        }
        base_page_pending <<- FALSE
      }, error = function(error) {
        remember_base_capture_error(error)
      })
      invisible()
    }
    remove_base_hook <- function(name, hook) {
      hooks <- getHook(name)
      remove <- vapply(hooks, identical, logical(1), hook)
      if (any(remove)) setHook(name, hooks[!remove], action = "replace")
      invisible()
    }
    cleanup_base_graphics <- function(capture = FALSE) {
      if (base_cleaned) return(invisible())
      if (isTRUE(capture)) checkpoint_base_page(finalize = TRUE)
      if (base_before_installed) {
        tryCatch(remove_base_hook("before.plot.new", base_before_hook),
                 error = function(error) remember_base_capture_error(error))
        base_before_installed <<- FALSE
      }
      if (base_after_installed) {
        tryCatch(remove_base_hook("plot.new", base_after_hook),
                 error = function(error) remember_base_capture_error(error))
        base_after_installed <<- FALSE
      }
      if (base_device_alive()) {
        previous <- grDevices::dev.cur()
        tryCatch(grDevices::dev.off(which = base_device),
                 error = function(error) remember_base_capture_error(error))
        restore_device(previous)
      }
      if (!is.null(base_scratch) && dir.exists(base_scratch)) {
        unlink(base_scratch, recursive = TRUE, force = TRUE)
      }
      base_device <<- NULL
      base_device_name <<- NULL
      base_scratch <<- NULL
      base_cleaned <<- TRUE
      invisible()
    }
    on.exit(cleanup_base_graphics(), add = TRUE)
    graphics_setup_error <- tryCatch({
      graphics_perf <- perf_begin("kernel.graphics_setup", list(req = req$req,
        cell = req$id, run_id = req$run_id))
      base_scratch <- tempfile("alder-base-device-")
      if (!dir.create(base_scratch)) {
        stop("could not create base graphics scratch directory", call. = FALSE)
      }
      open_png_device(file.path(base_scratch, "page-%03d.png"))
      grDevices::dev.control(displaylist = "enable")
      current_device <- grDevices::dev.cur()
      base_device <- unname(current_device)
      base_device_name <- names(current_device)[[1L]]
      setHook("before.plot.new", base_before_hook, action = "prepend")
      base_before_installed <- TRUE
      setHook("plot.new", base_after_hook, action = "prepend")
      base_after_installed <- TRUE
      perf_end(graphics_perf)
      NULL
    }, error = identity)
    if (!is.null(graphics_setup_error)) {
      cleanup_base_graphics()
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      return(list(
        ok = FALSE, outputs = list(), stopped = FALSE, log = character(),
        error = condition_payload(graphics_setup_error,
                                  conditionMessage(graphics_setup_error),
                                  sys.calls())
      ))
    }
    cap <- bounded_capture(function() {
      eval_perf <- perf_begin("kernel.evaluate", list(req = req$req, cell = req$id,
        revision = req$revision, run_id = req$run_id))
      on.exit(perf_end(eval_perf), add = TRUE)
      if (length(exprs)) {
        for (i in seq_along(exprs)) {
          if (i == length(exprs)) {
            wv <- withVisible(eval(exprs[[i]], envir = NB_ENV))
            value <<- wv$value
            visible <<- wv$visible
            if (wv$visible && is.symbol(exprs[[i]])) {
              vname <<- as.character(exprs[[i]])
            }
          } else {
            eval(exprs[[i]], envir = NB_ENV)
          }
          checkpoint_base_page()
        }
      }
    }, 1048576L)
    keep_pages <- is.null(cap$error) || inherits(cap$condition, "alder_stop")
    cleanup_base_graphics(capture = keep_pages)

    materialize_base_pages <- function(outputs) {
      rendered <- list()
      lines <- character()
      truncated <- FALSE
      failure <- NULL
      interrupted <- FALSE
      for (output in outputs %||% list()) {
        if (!inherits(output, "alder_recorded_page")) {
          rendered <- c(rendered, list(output))
          next
        }
        snapshot <- output$page$snapshot
        if (is.null(snapshot)) next
        page_cap <- bounded_capture(
          function() render_recordedplot(snapshot), 262144L)
        lines <- c(lines, page_cap$lines)
        truncated <- truncated || isTRUE(page_cap$truncated)
        if (isTRUE(page_cap$interrupted)) {
          interrupted <- TRUE
          break
        }
        if (!is.null(page_cap$error)) {
          failure <- page_cap
          break
        }
        page_cap$result$log_offset <- output$log_offset
        rendered <- c(rendered, list(page_cap$result))
      }
      list(outputs = rendered, lines = lines, truncated = truncated,
           failure = failure, interrupted = interrupted)
    }

    msgs <- cap$lines
    if (cap$interrupted) {
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      return(list(ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
                  error = list(message = "Interrupted", interrupted = TRUE)))
    }
    if (!is.null(cap$error) && !inherits(cap$condition, "alder_stop")) {
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      CELL_DEFS[[id]] <- NULL
      return(list(ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
                  error = condition_payload(cap$condition, cap$error, cap$trace)))
    }
    if (!is.null(base_capture_condition)) {
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      CELL_DEFS[[id]] <- NULL
      return(list(
        ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
        error = condition_payload(base_capture_condition,
                                  conditionMessage(base_capture_condition),
                                  base_capture_trace)
      ))
    }

    pages <- materialize_base_pages(EMITTED_OUTPUTS$value %||% list())
    msgs <- c(msgs, pages$lines)
    result_truncated <- isTRUE(cap$truncated) || isTRUE(pages$truncated)
    if (isTRUE(pages$interrupted)) {
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      CELL_DEFS[[id]] <- NULL
      return(list(ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
                  error = list(message = "Interrupted", interrupted = TRUE)))
    }
    if (!is.null(pages$failure)) {
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      CELL_DEFS[[id]] <- NULL
      return(list(
        ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
        error = condition_payload(pages$failure$condition,
                                  pages$failure$error,
                                  pages$failure$trace)
      ))
    }
    EMITTED_OUTPUTS$value <- pages$outputs
    if (inherits(cap$condition, "alder_stop")) {
      cleanup_failed_defs(defs, pre, local_names, id, pre_values)
      CELL_DEFS[[id]] <- NULL
      stopped <- EMITTED_OUTPUTS$value %||% list()
      if (!is.null(cap$condition$output)) {
        stopped <- c(stopped, list(render_kind(cap$condition$output)))
      }
      return(list(ok = TRUE, outputs = I(stopped), stopped = TRUE,
                  log = I(c(msgs, RENDER_LOG$value)), truncated = result_truncated))
    }

    # Opaque literal-source cells may create or replace bindings that were not
    # present in their AST. Attribute those observable changes to the cell so
    # reruns and deletion retain the same cleanup guarantees as static defs.
    dynamic_owned <- character()
    if (isTRUE(opaque)) {
      post <- ls(NB_ENV, all.names = TRUE)
      added <- setdiff(post, pre)
      common <- intersect(post, pre)
      changed <- common[vapply(common, function(nm) {
        !identical(get(nm, envir = NB_ENV, inherits = FALSE), pre_values[[nm]])
      }, logical(1))]
      dynamic_owned <- setdiff(unique(c(added, changed)),
                               c(".Random.seed", ".Last.value", ".Traceback"))
    }
    defs <- unique(c(defs, dynamic_owned))

    # success: own only the requested/dynamically observed definitions
    new_owned <- character()
    for (nm in defs) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        prev <- NAME_OWNER[[nm]] %||% NULL
        if (!is.null(prev) && !identical(prev, id)) {
          CELL_DEFS[[prev]] <- setdiff(CELL_DEFS[[prev]] %||% character(), nm)
        }
        NAME_OWNER[[nm]] <- id
        new_owned <- c(new_owned, nm)
      }
    }
    CELL_DEFS[[id]] <- new_owned
    outputs <- EMITTED_OUTPUTS$value %||% list()
    if (isTRUE(visible)) {
      rv <- render_visible(value, vname, id, new_owned)
      if (identical(rv$kind, "error")) {
        cleanup_failed_defs(defs, pre, local_names, id, pre_values)
        CELL_DEFS[[id]] <- NULL
        return(list(ok = FALSE, outputs = list(), stopped = FALSE,
                    log = I(c(msgs, RENDER_LOG$value)),
                    error = list(message = rv$message)))
      }
      outputs <- c(outputs, list(rv))
    }
    list(ok = TRUE, outputs = I(outputs), stopped = FALSE,
         log = I(c(msgs, RENDER_LOG$value)), truncated = result_truncated)
  }

  # Evaluate one registered lazy thunk. The key is invalidated whenever its
  # defining cell starts another execution, so a stale UI request cannot
  # resurrect an earlier closure.
  lazy_eval <- function(req) {
    key <- as.character(req$key %||% "")
    if (length(key) != 1L || is.na(key) || !nzchar(key) ||
        !exists(key, envir = LAZY_ENV, inherits = FALSE)) {
      return(list(ok = FALSE, error = list(
        code = "lazy_expired",
        message = "this lazy output belongs to an earlier run of the cell")))
    }
    id <- as.character(req$id %||% sub(":.*$", "", key))
    CURRENT_CELL <<- id
    CURRENT_REQ <<- NULL
    CURRENT_RUN_ID <<- NULL
    EMITTED_OUTPUTS$value <- list()
    RENDER_LOG$value <- character()
    inject_runtime()
    on.exit({
      CURRENT_CELL <<- NULL
      CURRENT_REQ <<- NULL
      CURRENT_RUN_ID <<- NULL
      EMITTED_OUTPUTS$value <- list()
      RENDER_LOG$value <- character()
    }, add = TRUE)

    thunk <- get(key, envir = LAZY_ENV, inherits = FALSE)
    cap <- bounded_capture(function() withVisible(thunk()), 1048576L)
    if (isTRUE(cap$interrupted)) {
      return(list(ok = FALSE, error = list(
        message = "Interrupted", interrupted = TRUE)))
    }
    if (!is.null(cap$error)) {
      return(list(ok = FALSE, log = I(cap$lines),
                  error = condition_payload(cap$condition, cap$error, cap$trace)))
    }
    wv <- cap$result
    output <- render_kind(wv$value)
    if (identical(output$kind, "error")) {
      return(list(ok = FALSE, log = I(c(cap$lines, RENDER_LOG$value)),
                  error = list(message = output$message)))
    }
    list(ok = TRUE, output = output, log = I(c(cap$lines, RENDER_LOG$value)),
         truncated = cap$truncated)
  }
  resolve_table_object <- function(req) {
    handle <- as.character(req$handle %||% "")
    if (length(handle) != 1L || is.na(handle) || !nzchar(handle) ||
        !exists(handle, envir = TABLE_HANDLES, inherits = FALSE)) {
      return(NULL)
    }
    ref <- get(handle, envir = TABLE_HANDLES, inherits = FALSE)
    name <- as.character(ref$name %||% "")
    has_name <- length(name) == 1L && !is.na(name) && nzchar(name)
    if (has_name) {
      if (!exists(name, envir = NB_ENV, inherits = FALSE)) return(NULL)
      value <- get(name, envir = NB_ENV, inherits = FALSE)
      for (part in as.character(ref$path %||% character())) {
        if (is.null(value) || is.null(part) || !nzchar(part)) return(NULL)
        value <- tryCatch(value[[part]], error = function(e) NULL)
        if (is.null(value)) return(NULL)
      }
    } else {
      # Only genuinely anonymous visible expressions use the retained value.
      # A named value that has since been removed must expire rather than
      # serving a stale snapshot through its old handle.
      value <- ref$value %||% NULL
    }
    if (!(inherits(value, "data.frame") || inherits(value, "matrix") ||
          inherits(value, "table") || inherits(value, "tbl_df") ||
          inherits(value, "data.table"))) {
      return(NULL)
    }
    value
  }

  table_page <- function(req) {
    value <- resolve_table_object(req)
    if (is.null(value)) {
      return(list(ok = FALSE, error = list(
        code = "table_unavailable", message = "table is unavailable")))
    }
    offset <- req$offset %||% 0
    limit <- req$limit %||% 25
    sort_by <- req$sort_by %||% ""
    sort_desc <- req$sort_desc %||% FALSE
    filter <- req$filter %||% ""
    if (!is.numeric(offset) || length(offset) != 1L || is.na(offset) ||
        !is.finite(offset) || offset < 0 ||
        !is.numeric(limit) || length(limit) != 1L || is.na(limit) ||
        !is.finite(limit) || limit < 1 ||
        !is.character(sort_by) || length(sort_by) != 1L || is.na(sort_by) ||
        !is.logical(sort_desc) || length(sort_desc) != 1L || is.na(sort_desc) ||
        !is.character(filter) || length(filter) != 1L || is.na(filter)) {
      return(list(ok = FALSE, error = list(
        code = "invalid_request", message = "table paging arguments invalid")))
    }
    page <- table_page_record(value, offset = offset, limit = limit,
                              sort_by = sort_by, sort_desc = sort_desc,
                              filter = filter)
    if (!is.null(page$error)) {
      return(list(ok = FALSE, error = page$error))
    }
    list(ok = TRUE, page = page)
  }

  # Remove definitions and private locals a failed/interrupted cell created.
  cleanup_failed_defs <- function(defs, pre, local_names = character(), id = NULL,
                                  pre_values = NULL) {
    current <- ls(NB_ENV, all.names = TRUE)
    for (nm in unique(c(setdiff(defs, pre), setdiff(current, pre)))) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        rm(list = nm, envir = NB_ENV)
      }
    }
    if (!is.null(pre_values)) {
      for (nm in names(pre_values)) {
        if (!exists(nm, envir = NB_ENV, inherits = FALSE) ||
            !identical(get(nm, envir = NB_ENV, inherits = FALSE),
                       pre_values[[nm]])) {
          assign(nm, pre_values[[nm]], envir = NB_ENV)
        }
      }
    }
    for (nm in local_names) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        rm(list = nm, envir = NB_ENV)
      }
    }
    if (!is.null(id)) CELL_LOCALS[[id]] <- NULL
    invisible()
  }

  clear_cell <- function(req) {
    id <- as.character(req$id %||% "")
    if (!nzchar(id)) {
      return(list(ok = FALSE, error = list(message = "clear_cell requires an id")))
    }
    for (nm in CELL_DEFS[[id]] %||% character()) {
      if (identical(NAME_OWNER[[nm]] %||% NULL, id)) {
        rm(list = nm, envir = NB_ENV)
        NAME_OWNER[[nm]] <- NULL
      }
    }
    CELL_DEFS[[id]] <- NULL
    for (nm in CELL_LOCALS[[id]] %||% character()) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        rm(list = nm, envir = NB_ENV)
      }
    }
    CELL_LOCALS[[id]] <- NULL
    old_lazy <- ls(LAZY_ENV, all.names = TRUE)
    old_lazy <- old_lazy[startsWith(old_lazy, paste0(id, ":"))]
    if (length(old_lazy)) rm(list = old_lazy, envir = LAZY_ENV)
    old_tables <- ls(TABLE_HANDLES, all.names = TRUE)
    old_tables <- old_tables[startsWith(old_tables, paste0(id, ":"))]
    if (length(old_tables)) rm(list = old_tables, envir = TABLE_HANDLES)
    list(ok = TRUE, id = id)
  }

  get_value <- function(req) {
    name <- req$name %||% ""
    if (!exists(name, envir = NB_ENV, inherits = FALSE)) {
      return(list(ok = FALSE, error = list(message = sprintf("no such name: %s",
                                                             name))))
    }
    v <- render_inspect(get(name, envir = NB_ENV))
    if (identical(v$kind, "error")) {
      return(list(ok = FALSE, error = list(message = v$message)))
    }
    list(ok = TRUE, name = name, value = v)
  }
  env_snapshot <- function(req) {
    nms <- ls(NB_ENV, all.names = TRUE)
    nms <- nms[!startsWith(nms, ".alder_local_")]
    if (length(nms) > 2000L) nms <- nms[seq_len(2000L)]
    variables <- lapply(nms, function(name) {
      value <- get(name, envir = NB_ENV, inherits = FALSE)
      classes <- class(value)
      list(
        name = name,
        class = if (length(classes)) classes[[1L]] else typeof(value),
        dim = dim(value),
        size = as.numeric(utils::object.size(value)),
        widget = UI_ENV$is_widget(value)
      )
    })
    list(ok = TRUE, variables = variables)
  }

  decode_file_value <- function(value) {
    if (is.data.frame(value)) return(value)
    rows <- value %||% list()
    if (!is.list(rows)) return(NULL)
    if (!length(rows)) {
      return(data.frame(name = character(), size = double(),
                        path = character(), stringsAsFactors = FALSE))
    }
    if (!all(vapply(rows, is.list, logical(1)))) return(NULL)
    read_name <- function(row) {
      value <- row$name
      if (!is.character(value) || length(value) != 1L || is.na(value)) {
        return(NA_character_)
      }
      value
    }
    read_size <- function(row) {
      value <- row$size
      if (!is.numeric(value) || length(value) != 1L || is.na(value)) {
        return(NA_real_)
      }
      as.double(value)
    }
    read_path <- function(row) {
      value <- row$path
      if (!is.character(value) || length(value) != 1L || is.na(value)) {
        return(NA_character_)
      }
      value
    }
    data.frame(
      name = vapply(rows, read_name, character(1)),
      size = vapply(rows, read_size, numeric(1)),
      path = vapply(rows, read_path, character(1)),
      stringsAsFactors = FALSE
    )
  }

  # Requests are decoded with simplifyVector = FALSE, so JSON arrays arrive
  # as unnamed lists. Decode only the atomic array fields declared by the
  # widget protocol; named objects and nested values are invalid.
  decode_atomic_request_vector <- function(value, type,
                                           expected_length = NULL,
                                           integer = FALSE) {
    empty <- switch(type,
      numeric = numeric(),
      character = character(),
      logical = logical(),
      NULL
    )
    if (is.null(empty)) return(NULL)
    if (is.list(value)) {
      if (!is.null(names(value))) return(NULL)
      if (!length(value)) {
        value <- empty
      } else {
        scalar <- vapply(value, function(item) {
          is.atomic(item) && length(item) == 1L && !is.na(item)
        }, logical(1L))
        if (!all(scalar)) return(NULL)
        value <- unlist(value, use.names = FALSE)
      }
    }
    valid <- switch(type,
      numeric = is.numeric(value) && !anyNA(value) &&
        all(is.finite(value)),
      character = is.character(value) && !anyNA(value) &&
        all(validUTF8(value)),
      logical = is.logical(value) && !anyNA(value),
      FALSE
    )
    if (!isTRUE(valid)) return(NULL)
    if (!is.null(expected_length) && length(value) != expected_length) {
      return(NULL)
    }
    if (isTRUE(integer)) {
      if (!is.numeric(value) || any(value != floor(value)) ||
          any(value < -(.Machine$integer.max + 1) |
              value > .Machine$integer.max)) {
        return(NULL)
      }
      return(as.integer(value))
    }
    switch(type,
      numeric = as.double(value),
      character = as.character(value),
      logical = as.logical(value)
    )
  }

  validate_file_paths <- function(value) {
    value <- tryCatch(UI_ENV$validate_widget_value(
      "file", value, list()), error = function(e) NULL)
    if (is.null(value)) return(NULL)
    upload_dir <- file.path(artifact_dir, "uploads")
    if (!dir.exists(upload_dir) || !length(value$path)) return(value)
    root <- normalizePath(upload_dir, mustWork = FALSE)
    for (i in seq_along(value$path)) {
      path <- value$path[[i]]
      if (!is.character(path) || is.na(path) || !nzchar(path) ||
          !file.exists(path) || dir.exists(path)) return(NULL)
      resolved <- normalizePath(path, mustWork = FALSE)
      if (!nzchar(resolved) ||
          !startsWith(resolved, paste0(root, .Platform$file.sep))) {
        return(NULL)
      }
      size <- file.info(resolved)$size
      if (is.na(size) || as.double(size) != value$size[[i]]) return(NULL)
    }
    value
  }

  # set_widget: the host validated the request; re-validate and assign here.
  set_widget <- function(req) {
    name <- as.character(req$name %||% "")
    op_id <- req$op_id
    if (length(name) != 1L || is.na(name) || !nzchar(name) ||
        !exists(name, envir = NB_ENV, inherits = FALSE)) {
      return(list(ok = FALSE, error = list(message = sprintf(
        "widget not found: %s", name))))
    }
    x <- get(name, envir = NB_ENV, inherits = FALSE)
    if (!UI_ENV$is_widget(x)) {
      return(list(ok = FALSE, error = list(message = sprintf(
        "'%s' is not a widget", name))))
    }
    path <- req$path %||% character()
    if (length(path)) {
      path <- unlist(path, use.names = FALSE)
      if (!is.character(path) || anyNA(path) || any(!nzchar(path))) {
        return(list(ok = FALSE, error = list(message = "widget path invalid")))
      }
    } else {
      path <- character()
    }
    target <- UI_ENV$widget_child(x, path)
    if (identical(target$kind, "form") && !isTRUE(req$submit)) {
      target <- target$child
    }
    if (is.null(target)) {
      return(list(ok = FALSE, error = list(message = "widget path does not exist")))
    }

    selected_payload <- function(kind, value) {
      if (inherits(value, "Date")) {
        return(list(type = if (length(value) == 2L) "date_range" else "date",
                    value = format(value, "%Y-%m-%d")))
      }
      if (inherits(value, "POSIXct")) {
        return(list(type = "datetime",
                    value = format(value, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")))
      }
      if (is.data.frame(value)) {
        return(list(type = "data.frame", value = value))
      }
      if (is.list(value)) return(list(type = "list", value = value))
      list(type = typeof(value), value = unclass(value))
    }
    replace_widget_at <- function(root, at, replacement) {
      if (!length(at)) {
        return(replacement)
      }
      if (identical(root$kind, "form")) {
        root$child <- replace_widget_at(root$child, at, replacement)
        root$dirty <- TRUE
        UI_ENV$validate_widget(root)
        return(root)
      }
      if (!(root$kind %in% c("array", "dictionary"))) {
        stop("widget path does not exist")
      }
      key <- at[[1L]]
      if (!(key %in% names(root$children))) stop("widget path does not exist")
      root$children[[key]] <- replace_widget_at(
        root$children[[key]], at[-1L], replacement)
      UI_ENV$widget_recompute_value(root)
    }
    update_control_value <- function(root, at, value) {
      if (!length(at)) {
        if (identical(root$kind, "form")) {
          root$child <- update_control_value(root$child, character(), value)
          root$dirty <- TRUE
          UI_ENV$validate_widget(root)
          return(root)
        }
        root$value <- UI_ENV$validate_widget_value(root$kind, value, root)
        return(UI_ENV$widget_recompute_value(root))
      }
      if (identical(root$kind, "form")) {
        root$child <- update_control_value(root$child, at, value)
        root$dirty <- TRUE
        UI_ENV$validate_widget(root)
        return(root)
      }
      if (!(root$kind %in% c("array", "dictionary"))) {
        stop("widget path does not exist")
      }
      key <- at[[1L]]
      if (!(key %in% names(root$children))) stop("widget path does not exist")
      root$children[[key]] <- update_control_value(
        root$children[[key]], at[-1L], value)
      UI_ENV$widget_recompute_value(root)
    }
    update_control_field <- function(root, at, field, value) {
      if (!length(at)) {
        if (identical(root$kind, "form")) {
          root$child <- update_control_field(
            root$child, character(), field, value)
          root$dirty <- TRUE
          UI_ENV$validate_widget(root)
          return(root)
        }
        root[[field]] <- value
        UI_ENV$validate_widget(root)
        return(root)
      }
      if (identical(root$kind, "form")) {
        root$child <- update_control_field(root$child, at, field, value)
        root$dirty <- TRUE
        UI_ENV$validate_widget(root)
        return(root)
      }
      if (!(root$kind %in% c("array", "dictionary"))) {
        stop("widget path does not exist")
      }
      key <- at[[1L]]
      if (!(key %in% names(root$children))) stop("widget path does not exist")
      root$children[[key]] <- update_control_field(
        root$children[[key]], at[-1L], field, value)
      UI_ENV$widget_recompute_value(root)
    }
    apply_ops <- function(data, ops) {
      if (!is.list(ops)) stop("dataframe ops must be an array")
      out <- data
      for (op in ops) {
        if (!is.list(op) || !is.character(op$op) || length(op$op) != 1L) {
          stop("dataframe operation invalid")
        }
        if (identical(op$op, "filter")) {
          column <- as.character(op$column %||% "")
          comparator <- as.character(op$comparator %||% "")
          if (!column %in% names(out) ||
              !comparator %in% c("==", "!=", "<", "<=", ">", ">=", "contains")) {
            stop("dataframe filter invalid")
          }
          lhs <- out[[column]]
          rhs <- op$value
          keep <- switch(comparator,
            `==` = lhs == rhs,
            `!=` = lhs != rhs,
            `<` = lhs < rhs,
            `<=` = lhs <= rhs,
            `>` = lhs > rhs,
            `>=` = lhs >= rhs,
            contains = grepl(as.character(rhs %||% ""), as.character(lhs),
                             fixed = TRUE, ignore.case = TRUE))
          keep[is.na(keep)] <- FALSE
          out <- out[keep, , drop = FALSE]
        } else if (identical(op$op, "sort")) {
          column <- as.character(op$column %||% "")
          if (!column %in% names(out)) stop("dataframe sort invalid")
          out <- out[order(out[[column]], decreasing = isTRUE(op$desc),
                           na.last = TRUE), , drop = FALSE]
        } else if (identical(op$op, "select")) {
          columns <- as.character(unlist(op$columns %||% character(),
                                         use.names = FALSE))
          if (any(!columns %in% names(out))) stop("dataframe select invalid")
          out <- out[, columns, drop = FALSE]
        } else {
          stop("unknown dataframe operation")
        }
      }
      out
    }

    if (identical(target$kind, "form") && isTRUE(req$submit)) {
      submitted <- target
      submitted$value <- UI_ENV$widget_value(submitted$child)
      submitted$dirty <- FALSE
      UI_ENV$validate_widget(submitted)
      updated <- replace_widget_at(x, path, submitted)
      assign(name, updated, envir = NB_ENV)
      selected <- selected_payload("form", submitted$value)
      return(list(ok = TRUE, name = name, path = I(path), op_id = op_id,
                  selected = selected))
    }
    if (identical(target$kind, "form")) {
      return(list(ok = FALSE, error = list(
        message = "a form must be submitted with `submit = TRUE`")))
    }

    idx <- NULL
    indices <- NULL
    kind <- target$kind
    if (kind %in% c("dropdown", "radio")) {
      idx <- req$index
      if (!is.numeric(idx) || length(idx) != 1L || is.na(idx) ||
          idx < 1 || idx > length(target$choices) ||
          as.double(idx) != floor(as.double(idx))) {
        return(list(ok = FALSE, error = list(message = "choice index out of range")))
      }
      idx <- as.integer(idx)
      val <- target$choices[[idx]]
    } else if (identical(kind, "multiselect")) {
      indices <- decode_atomic_request_vector(
        req$indices %||% integer(), "numeric", integer = TRUE)
      if (is.null(indices) ||
          any(indices < 1 | indices > length(target$choices)) ||
          anyDuplicated(indices)) {
        return(list(ok = FALSE, error = list(message = "choice indices invalid")))
      }
      if (length(indices) && !identical(indices, sort(indices))) {
        return(list(ok = FALSE, error = list(
          message = "choice indices must follow choice order")))
      }
      val <- target$choices[indices]
    } else if (kind %in% c("slider", "range_slider", "number")) {
      expected <- if (identical(kind, "range_slider")) 2L else 1L
      val <- decode_atomic_request_vector(
        req$value, "numeric", expected_length = expected)
      if (is.null(val)) {
        return(list(ok = FALSE, error = list(message = "numeric widget value invalid")))
      }
    } else if (kind %in% c("text_input", "text_area", "code_editor")) {
      val <- req$value
      if (!is.character(val) || length(val) != 1L || is.na(val)) {
        return(list(ok = FALSE, error = list(message = "text widget value invalid")))
      }
    } else if (kind %in% c("checkbox", "switch", "run_button")) {
      val <- req$value
      if (!is.logical(val) || length(val) != 1L || is.na(val)) {
        return(list(ok = FALSE, error = list(message = "logical value invalid")))
      }
    } else if (kind %in% c("button", "refresh")) {
      val <- req$value
      if (!is.numeric(val) || length(val) != 1L || is.na(val) ||
          !is.finite(val) || val < 0 || val != floor(val)) {
        return(list(ok = FALSE, error = list(message = "counter value invalid")))
      }
      val <- as.integer(val)
    } else if (identical(kind, "date")) {
      val <- tryCatch(as.Date(as.character(req$value), format = "%Y-%m-%d"),
                      error = function(e) NA)
    } else if (identical(kind, "date_range")) {
      raw <- decode_atomic_request_vector(
        req$value %||% character(), "character", expected_length = 2L)
      if (is.null(raw)) {
        return(list(ok = FALSE, error = list(message = "date range value invalid")))
      }
      val <- tryCatch(as.Date(as.character(raw), format = "%Y-%m-%d"),
                      error = function(e) as.Date(c(NA, NA)))
    } else if (identical(kind, "datetime")) {
      raw <- as.character(req$value)
      if (length(raw) != 1L || is.na(raw) || !grepl(paste0(
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T",
          "[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
      ), raw)) {
        raw <- NA_character_
      }
      val <- tryCatch(
        as.POSIXct(raw, tz = "UTC", format = "%Y-%m-%dT%H:%M:%SZ"),
        error = function(e) as.POSIXct(NA, origin = "1970-01-01")
      )
      if (!is.na(val) && !identical(
          format(val, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"), raw)) {
        val <- as.POSIXct(NA, origin = "1970-01-01")
      }
    } else if (identical(kind, "file")) {
      val <- decode_file_value(req$value)
      val <- validate_file_paths(val)
      if (is.null(val)) {
        return(list(ok = FALSE, error = list(message = "file value invalid")))
      }
    } else if (identical(kind, "table")) {
      indices <- decode_atomic_request_vector(
        req$selected %||% integer(), "numeric", integer = TRUE)
      if (is.null(indices) ||
          any(indices < 1 | indices > nrow(target$data)) ||
          anyDuplicated(indices)) {
        return(list(ok = FALSE, error = list(message = "table selection invalid")))
      }
      if (identical(target$selection, "single") && length(indices) > 1L) {
        return(list(ok = FALSE, error = list(message = "table accepts one selected row")))
      }
      val <- target$data[indices, , drop = FALSE]
    } else if (identical(kind, "dataframe")) {
      val <- tryCatch(apply_ops(target$data, req$ops %||% list()),
                      error = function(e) NULL)
      if (is.null(val)) {
        return(list(ok = FALSE, error = list(message = "dataframe operation invalid")))
      }
    } else {
      return(list(ok = FALSE, error = list(message = "widget kind cannot be updated")))
    }
    val <- tryCatch(UI_ENV$validate_widget_value(kind, val, target),
                    error = function(e) NULL)
    if (is.null(val)) {
      return(list(ok = FALSE, error = list(message = "widget value rejected")))
    }
    updated <- tryCatch(update_control_value(x, path, val),
                        error = function(e) NULL)
    if (is.null(updated)) {
      return(list(ok = FALSE, error = list(message = "widget value rejected")))
    }
    if (identical(kind, "refresh") && !is.null(req$paused)) {
      if (!is.logical(req$paused) || length(req$paused) != 1L ||
          is.na(req$paused)) {
        return(list(ok = FALSE, error = list(message = "refresh pause invalid")))
      }
      updated <- update_control_field(
        updated, path, "paused", isTRUE(req$paused))
    }
    if (identical(kind, "table")) {
      updated <- update_control_field(updated, path, "selected", indices)
    }
    if (identical(kind, "dataframe")) {
      updated <- update_control_field(
        updated, path, "ops", req$ops %||% list())
    }
    assign(name, updated, envir = NB_ENV)
    target_after <- UI_ENV$widget_child(updated, path)
    if (identical(target_after$kind, "form") && !isTRUE(req$submit)) {
      target_after <- target_after$child
    }
    selected <- if (identical(kind, "table")) {
      list(type = "integer", value = I(as.integer(indices)))
    } else {
      selected_payload(kind, target_after$value)
    }
    if (!is.null(idx)) selected$index <- idx
    if (!is.null(indices) && identical(kind, "multiselect")) {
      selected$indices <- I(as.integer(indices))
    }
    list(ok = TRUE, name = name, path = I(path), op_id = op_id,
         selected = selected)
  }

  # -------------------------------------------------------------------------
  # Main loop
  # -------------------------------------------------------------------------

  echo_identity <- function(req, resp) {
    if (!is.null(req$req)) resp$req <- req$req
    resp$cmd <- as.character(req$cmd %||% "")
    for (f in c("id", "revision", "run_id")) {
      if (!is.null(req[[f]])) resp[[f]] <- req[[f]]
    }
    if (!is.null(req$name)) resp$name <- req$name
    if (!is.null(req$op_id)) resp$op_id <- req$op_id
    if (!is.null(req$token)) resp$token <- req$token
    resp
  }

  ack_identity <- function(req) {
    ack <- list(ok = TRUE, ack = "started", req = req$req,
                cmd = as.character(req$cmd %||% "eval_cell"))
    for (f in c("id", "revision", "run_id")) {
      if (!is.null(req[[f]])) ack[[f]] <- req[[f]]
    }
    ack
  }

  run_loop <- function() {
    stdin_con <- file("stdin", open = "r")
    on.exit(tryCatch(suspendInterrupts(close(stdin_con)),
                     error = function(e) NULL, interrupt = function(e) NULL))
    eof_count <- 0L
    # A start acknowledgement can still be waiting in the controller's pipe
    # after evaluation has completed. Its matching late SIGINT must not kill
    # the worker while it parses or answers the next request. Only idle reads
    # and acknowledged evaluation admit interrupts; protocol work stays whole.
    tryCatch(suspendInterrupts(repeat {
      line <- tryCatch(
        allowInterrupts(readLines(stdin_con, n = 1, warn = FALSE)),
        interrupt = function(e) NULL,
        error = function(e) NA_character_)
      # An ignored idle interrupt is not EOF and cannot consume its allowance.
      if (is.null(line)) next
      if (length(line) == 0L || is.na(line[[1L]]) || !nzchar(line[[1L]])) {
        if (eof_count >= 1L) break else { eof_count <- eof_count + 1L; next }
      }
      eof_count <- 0L
      # NUL rejection at the raw boundary (a NUL cannot round-trip cleanly
      # through R strings or jsonlite)
      if (any(charToRaw(line[[1L]]) == as.raw(0L))) {
        emit(list(ok = FALSE, req = NA_integer_, cmd = "",
                  error = list(message = "request contains a NUL byte")))
        next
      }
      req <- tryCatch(jsonlite::fromJSON(line[[1L]], simplifyVector = FALSE),
                      error = function(e) NULL)
      if (is.null(req) || !is.list(req)) {
        emit(list(ok = FALSE, req = NA_integer_, cmd = "",
                  error = list(message = "invalid JSON request")))
        next
      }
      cmd <- as.character(req$cmd %||% "")
      # A deferred signal belongs to a completed evaluation: this request has
      # not emitted a start acknowledgement. Discard it before dispatch, which
      # may itself invoke user code (for example, a lazy output).
      tryCatch(allowInterrupts(Sys.sleep(0)), interrupt = function(e) NULL)
      if (identical(cmd, "eval_cell")) {
        # Ack-gated eval: the complete transaction remains inside
        # suspendInterrupts, but the start acknowledgement is emitted from the
        # same allowInterrupts region as evaluation. A controller can signal as
        # soon as it observes that acknowledgement; emitting it while still in
        # the suspended region created a narrow first-request race where SIGINT
        # could be accepted by the controller yet fail to interrupt the cell.
        # The outer suspension still prevents an interrupt from landing in the
        # success-to-response gap.
        tryCatch(
          suspendInterrupts({
            resp <- tryCatch(
              allowInterrupts({
                emit(ack_identity(req))
                exec_cell(req)
              }),
              interrupt = function(e) list(
                ok = FALSE, outputs = list(), stopped = FALSE, log = character(),
                error = list(message = "Interrupted", interrupted = TRUE)),
              error = function(e) list(
                ok = FALSE, outputs = list(), stopped = FALSE, log = character(),
                error = condition_payload(e, conditionMessage(e), sys.calls())))
            emit(echo_identity(req, resp))
          }),
          interrupt = function(e) NULL)
      } else {
        resp <- tryCatch(
          switch(cmd,
            ping = list(ok = TRUE),
            clear_cell = clear_cell(req),
            get_value = get_value(req),
            env_snapshot = env_snapshot(req),
            set_widget = set_widget(req),
            lazy_eval = lazy_eval(req),
            table_page = table_page(req),
            shutdown = list(ok = TRUE),
            list(ok = FALSE, error = list(message = paste0(
              "unknown command: ", cmd)))),
          interrupt = function(e) list(
            ok = FALSE, error = list(message = "Interrupted",
                                     interrupted = TRUE)),
          error = function(e) list(
            ok = FALSE,
            error = condition_payload(e, conditionMessage(e), sys.calls())))
        emit(echo_identity(req, resp))
      }
    }), interrupt = function(e) NULL)
    invisible()
  }

  run_loop()
})
