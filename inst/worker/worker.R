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

  `%||%` <- function(a, b) if (is.null(a)) b else a

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

  notify <- function(kind, payload) {
    if (is.null(CURRENT_REQ) || is.null(CURRENT_CELL)) return(invisible())
    if (identical(kind, "append") && !is.null(payload$output)) {
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

  bounded_capture <- function(run, max_bytes) {
    f <- tempfile("alder-cap-")
    con <- NULL
    result <- NULL
    err <- NULL
    err_condition <- NULL
    interrupted <- FALSE
    tryCatch({
      con <- file(f, open = "wt")
      CAPTURE_SINK$con <- con
      CAPTURE_SINK$active <- TRUE
      sink(con)
      withCallingHandlers(
        tryCatch(result <- run(),
                 error = function(e) {
                   err <<- conditionMessage(e)
                   err_condition <<- e
                 },
                 interrupt = function(e) {
                   interrupted <<- TRUE
                   err_condition <<- e
                 }),
        message = function(m) {
          line <- conditionMessage(m)
          cat(line)
          notify("log", list(lines = line))
          invokeRestart("muffleMessage")
        },
        warning = function(w) {
          line <- paste0("Warning: ", conditionMessage(w))
          cat(line, "\n", sep = "")
          notify("log", list(lines = line))
          invokeRestart("muffleWarning")
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
    list(result = result, lines = lines, truncated = truncated,
         error = err, condition = err_condition, interrupted = interrupted)
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
    TABLE_HANDLES[[handle]] <- list(name = as.character(name %||% ""),
                                    path = as.character(path %||% character()))
    page <- table_page_record(x)
    if (!is.null(page$error)) return(list(kind = "error",
                                          message = page$error$message))
    page$kind <- "table"
    page$handle <- handle
    page
  }

  render_plot <- function(x) {
    f <- tempfile(tmpdir = artifact_dir, fileext = ".png")
    devs_before <- names(grDevices::dev.list())
    tryCatch(
      ggplot2::ggsave(f, plot = x, width = 8, height = 5, dpi = 96),
      error = function(e) NULL,
      finally = {
        # close only the devices this renderer opened
        for (d in setdiff(names(grDevices::dev.list()), devs_before)) {
          tryCatch(grDevices::dev.off(d), error = function(e) NULL)
        }
      })
    if (file.exists(f) && file.info(f)$size > 0) {
      return(list(kind = "image", artifact = basename(f)))
    }
    unlink(f)
    list(kind = "error", message = "could not render plot")
  }

  render_htmlwidget <- function(x) {
    stage <- tempfile(tmpdir = artifact_dir)
    dir.create(stage)
    o <- file.path(stage, "index.html")
    dest <- ""
    ok <- FALSE
    tryCatch({
      htmlwidgets::saveWidget(x, o, selfcontained = TRUE)
      if (file.exists(o)) {
        dest <- tempfile(tmpdir = artifact_dir, fileext = ".html")
        ok <- file.rename(o, dest)
      }
    }, error = function(e) NULL, finally = {
      # promote only the final regular .html file; drop the staging directory
      unlink(stage, recursive = TRUE)
    })
    if (ok && file.exists(dest)) {
      list(kind = "html", artifact = basename(dest))
    } else {
      list(kind = "error", message = "could not render htmlwidget")
    }
  }

  wire_widget_value <- function(kind, value) {
    if (identical(kind, "date")) return(format(value, "%Y-%m-%d"))
    if (identical(kind, "date_range")) return(format(value, "%Y-%m-%d"))
    if (identical(kind, "datetime")) {
      return(format(value, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"))
    }
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
        spec$indices <- which(vapply(x$choices, function(choice)
          any(vapply(x$value, function(value)
            identical(choice, value), logical(1))), logical(1)))
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
      spec$selected <- as.integer(x$selected %||% integer())
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
    ok <- FALSE
    tryCatch({
      open_png_device(f)
      grDevices::replayPlot(x)
      grDevices::dev.off()
      ok <- file.exists(f) && file.info(f)$size > 0
    }, error = function(e) {
      tryCatch(grDevices::dev.off(), error = function(e) NULL)
    })
    if (ok) list(kind = "image", artifact = basename(f))
    else {
      unlink(f)
      list(kind = "error", message = "could not render recorded plot")
    }
  }

  render_text_value <- function(x, show = FALSE) {
    cap <- bounded_capture(function() {
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
      cap <- bounded_capture(
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
      cap <- bounded_capture(function() render_plot(x), 262144L)
      if (!is.null(cap$error)) {
        return(list(kind = "error", message = paste("could not render value:",
                                                    cap$error)))
      }
      return(cap$result)
    }
    if (inherits(x, "htmlwidget")) {
      cap <- bounded_capture(function() render_htmlwidget(x), 262144L)
      if (!is.null(cap$error)) {
        return(list(kind = "error", message = paste("could not render value:",
                                                    cap$error)))
      }
      return(cap$result)
    }
    if (inherits(x, "recordedplot")) {
      cap <- bounded_capture(function() render_recordedplot(x), 262144L)
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
    if (head_name %in% c("quote", "substitute", "expression", "alist")) {
      return(node)
    }
    parts <- as.list(node)
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
    id <- as.character(req$id %||% "")
    code <- as.character(req$code %||% "")
    defs <- normalize_defs(req$defs)
    locals <- normalize_defs(req$locals)
    if (is.null(defs) || is.null(locals)) {
      return(list(ok = FALSE, outputs = list(), stopped = FALSE,
                  log = character(),
                  error = list(message = "invalid definition or local array")))
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
    inject_runtime()
    on.exit({
      CURRENT_CELL <<- NULL
      CURRENT_REQ <<- NULL
      CURRENT_RUN_ID <<- NULL
      EMITTED_OUTPUTS$value <- list()
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
    base_file <- NULL
    open_base_device <- function() {
      if (!is.null(base_device)) return(invisible())
      f <- tempfile("alder-plot-", tmpdir = artifact_dir, fileext = ".png")
      ok <- tryCatch({
        open_png_device(f)
        grDevices::dev.control(displaylist = "enable")
        base_device <<- grDevices::dev.cur()
        base_file <<- f
        TRUE
      }, error = function(e) FALSE)
      if (!ok) {
        if (file.exists(f)) unlink(f)
        base_device <<- NULL
        base_file <<- NULL
      }
      invisible()
    }
    capture_base_plot <- function() {
      if (is.null(base_device) || is.null(base_file)) return(invisible())
      devices <- grDevices::dev.list()
      if (is.null(devices) || !(base_device %in% devices)) {
        base_device <<- NULL
        base_file <<- NULL
        return(invisible())
      }
      previous <- grDevices::dev.cur()
      tryCatch({
        grDevices::dev.set(base_device)
        recorded <- grDevices::recordPlot()
        if (!is.null(recorded[[1L]])) {
          grDevices::dev.off()
          if (file.exists(base_file) && file.info(base_file)$size > 0) {
            EMITTED_OUTPUTS$value <- c(
              EMITTED_OUTPUTS$value %||% list(),
              list(list(kind = "image", artifact = basename(base_file))))
          } else {
            unlink(base_file)
          }
          base_device <<- NULL
          base_file <<- NULL
        }
      }, error = function(e) NULL, finally = {
        current <- grDevices::dev.list()
        if (!is.null(current) && previous %in% current) {
          tryCatch(grDevices::dev.set(previous), error = function(e) NULL)
        }
      })
      if (is.null(base_device)) open_base_device()
      invisible()
    }
    cleanup_base_device <- function() {
      if (!is.null(base_device)) {
        devices <- grDevices::dev.list()
        if (!is.null(devices) && base_device %in% devices) {
          previous <- grDevices::dev.cur()
          tryCatch({
            grDevices::dev.set(base_device)
            grDevices::dev.off()
          }, error = function(e) NULL)
          current <- grDevices::dev.list()
          if (!is.null(current) && previous %in% current) {
            tryCatch(grDevices::dev.set(previous), error = function(e) NULL)
          }
        }
      }
      if (!is.null(base_file) && file.exists(base_file)) unlink(base_file)
      base_device <<- NULL
      base_file <<- NULL
      invisible()
    }
    open_base_device()
    on.exit(cleanup_base_device(), add = TRUE)
    cap <- bounded_capture(function() {
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
          capture_base_plot()
        }
      }
    }, 1048576L)

    msgs <- cap$lines
    if (cap$interrupted) {
      cleanup_failed_defs(defs, pre, local_names, id)
      return(list(ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
                  error = list(message = "Interrupted", interrupted = TRUE)))
    }
    if (inherits(cap$condition, "alder_stop")) {
      cleanup_failed_defs(defs, pre, local_names, id)
      CELL_DEFS[[id]] <- NULL
      stopped <- EMITTED_OUTPUTS$value %||% list()
      if (!is.null(cap$condition$output)) {
        stopped <- c(stopped, list(render_kind(cap$condition$output)))
      }
      return(list(ok = TRUE, outputs = I(stopped), stopped = TRUE,
                  log = I(msgs), truncated = cap$truncated))
    }
    if (!is.null(cap$error)) {
      cleanup_failed_defs(defs, pre, local_names, id)
      CELL_DEFS[[id]] <- NULL
      return(list(ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
                  error = list(message = cap$error)))
    }

    # success: own only the requested definitions that now exist
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
        cleanup_failed_defs(defs, pre, local_names, id)
        CELL_DEFS[[id]] <- NULL
        return(list(ok = FALSE, outputs = list(), stopped = FALSE, log = I(msgs),
                    error = list(message = rv$message)))
      }
      outputs <- c(outputs, list(rv))
    }
    list(ok = TRUE, outputs = I(outputs), stopped = FALSE,
         log = I(msgs), truncated = cap$truncated)
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
    inject_runtime()
    on.exit({
      CURRENT_CELL <<- NULL
      CURRENT_REQ <<- NULL
      CURRENT_RUN_ID <<- NULL
      EMITTED_OUTPUTS$value <- list()
    }, add = TRUE)

    thunk <- get(key, envir = LAZY_ENV, inherits = FALSE)
    cap <- bounded_capture(function() withVisible(thunk()), 1048576L)
    if (isTRUE(cap$interrupted)) {
      return(list(ok = FALSE, error = list(
        message = "Interrupted", interrupted = TRUE)))
    }
    if (!is.null(cap$error)) {
      return(list(ok = FALSE, log = I(cap$lines),
                  error = list(message = cap$error)))
    }
    wv <- cap$result
    output <- render_kind(wv$value)
    if (identical(output$kind, "error")) {
      return(list(ok = FALSE, log = I(cap$lines),
                  error = list(message = output$message)))
    }
    list(ok = TRUE, output = output, log = I(cap$lines),
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
    if (length(name) != 1L || is.na(name) || !nzchar(name) ||
        !exists(name, envir = NB_ENV, inherits = FALSE)) {
      return(NULL)
    }
    value <- get(name, envir = NB_ENV, inherits = FALSE)
    for (part in as.character(ref$path %||% character())) {
      if (is.null(value) || is.null(part) || !nzchar(part)) return(NULL)
      value <- tryCatch(value[[part]], error = function(e) NULL)
      if (is.null(value)) return(NULL)
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
  cleanup_failed_defs <- function(defs, pre, local_names = character(), id = NULL) {
    for (nm in setdiff(defs, pre)) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        rm(list = nm, envir = NB_ENV)
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
    target <- if (identical(x$kind, "form") && isTRUE(req$submit)) {
      x
    } else if (identical(x$kind, "form")) {
      UI_ENV$widget_child(x$child, path)
    } else {
      UI_ENV$widget_child(x, path)
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
    set_field <- function(root, at, field, value) {
      if (!length(at)) {
        root[[field]] <- value
        return(root)
      }
      if (identical(root$kind, "form")) {
        root$child <- set_field(root$child, at, field, value)
      } else {
        key <- at[[1L]]
        root$children[[key]] <- set_field(root$children[[key]],
                                          at[-1L], field, value)
      }
      root
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
      x$value <- UI_ENV$widget_value(x$child)
      x$dirty <- FALSE
      assign(name, x, envir = NB_ENV)
      selected <- selected_payload("form", x$value)
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
      indices <- req$indices %||% integer()
      indices <- unlist(indices, use.names = FALSE)
      if (length(indices) &&
          (!is.numeric(indices) || anyNA(indices) ||
           any(indices < 1 | indices > length(target$choices)) ||
           any(indices != floor(indices)) || anyDuplicated(indices))) {
        return(list(ok = FALSE, error = list(message = "choice indices invalid")))
      }
      indices <- as.integer(indices)
      if (length(indices) && !identical(indices, sort(indices))) {
        return(list(ok = FALSE, error = list(
          message = "choice indices must follow choice order")))
      }
      val <- target$choices[indices]
    } else if (kind %in% c("slider", "range_slider", "number")) {
      val <- req$value
      if (!is.numeric(val)) {
        return(list(ok = FALSE, error = list(message = "numeric widget value invalid")))
      }
      val <- as.double(val)
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
      raw <- unlist(req$value %||% character(), use.names = FALSE)
      val <- tryCatch(as.Date(as.character(raw), format = "%Y-%m-%d"),
                      error = function(e) as.Date(c(NA, NA)))
    } else if (identical(kind, "datetime")) {
      val <- tryCatch(as.POSIXct(as.character(req$value), tz = "UTC",
                                 format = "%Y-%m-%dT%H:%M:%S"),
                      error = function(e) as.POSIXct(NA, origin = "1970-01-01"))
    } else if (identical(kind, "file")) {
      val <- decode_file_value(req$value)
      val <- validate_file_paths(val)
      if (is.null(val)) {
        return(list(ok = FALSE, error = list(message = "file value invalid")))
      }
    } else if (identical(kind, "table")) {
      indices <- unlist(req$selected %||% integer(), use.names = FALSE)
      if (length(indices) &&
          (!is.numeric(indices) || anyNA(indices) ||
           any(indices < 1 | indices > nrow(target$data)) ||
           any(indices != floor(indices)) || anyDuplicated(indices))) {
        return(list(ok = FALSE, error = list(message = "table selection invalid")))
      }
      indices <- as.integer(indices)
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
    updated <- tryCatch({
      if (identical(x$kind, "form") && !isTRUE(req$submit)) {
        x$child <- UI_ENV$widget_set_child(x$child, path, val)
        UI_ENV$widget_recompute_value(x)
      } else {
        UI_ENV$widget_set_child(x, path, val)
      }
    }, error = function(e) NULL)
    if (is.null(updated)) {
      return(list(ok = FALSE, error = list(message = "widget value rejected")))
    }
    set_target_field <- function(root, at, field, value) {
      if (identical(x$kind, "form") && !isTRUE(req$submit)) {
        root$child <- set_field(root$child, at, field, value)
        UI_ENV$widget_recompute_value(root)
      } else {
        set_field(root, at, field, value)
      }
    }
    if (identical(kind, "refresh") && !is.null(req$paused)) {
      if (!is.logical(req$paused) || length(req$paused) != 1L ||
          is.na(req$paused)) {
        return(list(ok = FALSE, error = list(message = "refresh pause invalid")))
      }
      updated <- set_target_field(updated, path, "paused", isTRUE(req$paused))
    }
    if (identical(kind, "table")) {
      updated <- set_target_field(updated, path, "selected", indices)
    }
    if (identical(kind, "dataframe")) {
      updated <- set_target_field(updated, path, "ops", req$ops %||% list())
    }
    if (identical(x$kind, "form") && !isTRUE(req$submit)) updated$dirty <- TRUE
    assign(name, updated, envir = NB_ENV)
    target_after <- if (identical(x$kind, "form") && !isTRUE(req$submit)) {
      UI_ENV$widget_child(updated$child, path)
    } else {
      UI_ENV$widget_child(updated, path)
    }
    selected <- if (identical(kind, "table")) {
      list(type = "integer", value = as.integer(indices))
    } else {
      selected_payload(kind, target_after$value)
    }
    if (!is.null(idx)) selected$index <- idx
    if (!is.null(indices) && identical(kind, "multiselect")) {
      selected$indices <- as.integer(indices)
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
    on.exit(tryCatch(close(stdin_con), error = function(e) NULL))
    eof_count <- 0L
    repeat {
      line <- ""
      tryCatch(line <- readLines(stdin_con, n = 1, warn = FALSE),
               # SIGINT while blocked on the idle read is ignored
               interrupt = function(e) "",
               error = function(e) NA_character_)
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
      if (identical(cmd, "eval_cell")) {
        # ack-gated eval: emit the ack and the complete response inside
        # suspendInterrupts; evaluation/rendering runs under allowInterrupts
        # so an interrupt produces a single complete interrupted response
        # and can never land in the success-to-response gap.
        tryCatch(
          suspendInterrupts({
            emit(ack_identity(req))
            resp <- tryCatch(
              allowInterrupts(exec_cell(req)),
              interrupt = function(e) list(
                ok = FALSE, outputs = list(), stopped = FALSE, log = character(),
                error = list(message = "Interrupted", interrupted = TRUE)),
              error = function(e) list(
                ok = FALSE, outputs = list(), stopped = FALSE, log = character(),
                error = list(message = conditionMessage(e))))
            emit(echo_identity(req, resp))
          }),
          interrupt = function(e) NULL)
      } else {
        resp <- tryCatch(
          switch(cmd,
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
            ok = FALSE, error = list(message = conditionMessage(e))))
        emit(echo_identity(req, resp))
      }
    }
    invisible()
  }

  run_loop()
})
