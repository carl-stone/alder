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
  if (!nzchar(artifact_dir) || !dir.exists(artifact_dir) ||
      file.access(artifact_dir, 2) != 0L) {
    stop("ALDER_ARTIFACT_DIR is missing or invalid: '", artifact_dir,
         "' (must be an existing writable directory)")
  }

  NB_ENV <- globalenv()                     # notebook globals live in .GlobalEnv
  CELL_DEFS <- new.env(parent = emptyenv()) # cell id -> owned definition names
  NAME_OWNER <- new.env(parent = emptyenv())# name -> owning cell id

  emit <- function(x) {
    cat(jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null",
                         force = TRUE), "\n", sep = "")
    flush.console()
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
    interrupted <- FALSE
    tryCatch({
      con <- file(f, open = "wt")
      sink(con)
      withCallingHandlers(
        tryCatch(result <- run(),
                 error = function(e) err <<- conditionMessage(e),
                 interrupt = function(e) interrupted <<- TRUE),
        message = function(m) {
          cat(conditionMessage(m))
          invokeRestart("muffleMessage")
        },
        warning = function(w) {
          cat("Warning: ", conditionMessage(w), "\n", sep = "")
          invokeRestart("muffleWarning")
        })
    }, finally = {
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
         error = err, interrupted = interrupted)
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
  # Output rendering (never auto-prints the visible object)
  # -------------------------------------------------------------------------

  render_table <- function(x) {
    nr <- nrow(x)
    nc <- ncol(x)
    cols <- if (inherits(x, "matrix")) colnames(x) else names(x)
    pv <- if (inherits(x, "matrix")) {
      as.data.frame(utils::head(x, 25), stringsAsFactors = FALSE)
    } else {
      utils::head(x, 25)
    }
    if (nc > 50L) pv <- pv[seq_len(50L)]
    pv <- as.data.frame(lapply(pv, bounded_chr, max_bytes = 512L),
                        stringsAsFactors = FALSE, check.names = FALSE)
    list(kind = "table", nrow = nr, ncol = nc,
         truncated_rows = nr > 25L, truncated_columns = nc > 50L,
         columns = I(bounded_chr(cols, 256L)),
         preview = I(pv))
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

  widget_spec <- function(x) {
    spec <- unclass(x)
    if (identical(x$kind, "dropdown")) {
      idx <- which(vapply(x$choices, function(c) identical(c, x$value),
                          logical(1)))
      if (length(idx)) spec$index <- idx[[1L]]
      # collections stay JSON arrays even for a single choice
      spec$choices <- I(x$choices)
    }
    spec
  }

  # Render a non-widget value inside one bounded capture so renderer/formatter
  # output can never reach protocol stdout. `print()` writes directly to the
  # capture's sink; the captured lines become the generic visible text.
  render_kind <- function(x) {
    if (inherits(x, "data.frame") || inherits(x, "matrix")) {
      cap <- bounded_capture(function() render_table(x), 262144L)
      if (!is.null(cap$error)) {
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
    cap <- bounded_capture(function() print(x), 262144L)
    if (!is.null(cap$error)) {
      return(list(kind = "error", message = paste("could not render value:",
                                                  cap$error)))
    }
    list(kind = "text", text = paste(cap$lines, collapse = "\n"),
         truncated = cap$truncated)
  }

  # Render a visible value. Widgets render only when the visible expression
  # is a bare global name owned by the defining cell; any other widget in
  # the visible slot is a structured error, not a control.
  render_visible <- function(x, vname, id, owned) {
    if (UI_ENV$is_widget(x)) {
      if (!nzchar(vname) || !(vname %in% owned)) {
        return(list(kind = "error",
          message = paste0("interactive widget must be assigned in this cell ",
                           "and end the cell with that name: ", vname)))
      }
      return(list(kind = "widget", name = vname, owner = id,
                  commit_token = NULL, spec = widget_spec(x)))
    }
    render_kind(x)
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

  # eval_cell carries the analyzed unique definition-name array. Entering:
  # drop this cell's previous bindings, evaluate directly in NB_ENV. Success:
  # own only requested definitions that now exist. Error/interrupt: remove
  # definitions created before the failure and leave this cell with none.
  # Empty code therefore completes cleanup without a special early return.
  exec_cell <- function(req) {
    id <- as.character(req$id %||% "")
    code <- req$code %||% ""
    defs <- normalize_defs(req$defs)
    if (is.null(defs)) {
      return(list(ok = FALSE, value = NULL, log = character(),
                  error = list(message = "invalid definition array")))
    }
    for (nm in CELL_DEFS[[id]] %||% character()) {
      if (identical(NAME_OWNER[[nm]] %||% NULL, id)) {
        rm(list = nm, envir = NB_ENV)
        NAME_OWNER[[nm]] <- NULL
      }
    }
    CELL_DEFS[[id]] <- NULL

    pre <- ls(NB_ENV, all.names = TRUE)
    exprs <- tryCatch(parse(text = code), error = function(e) NULL)
    if (is.null(exprs)) {
      return(list(ok = FALSE, value = NULL, log = character(),
                  error = list(message = "could not parse cell source")))
    }
    value <- NULL
    visible <- FALSE
    vname <- ""
    cap <- bounded_capture(function() {
      if (length(exprs)) {
        if (length(exprs) > 1L) {
          for (i in seq_len(length(exprs) - 1L)) eval(exprs[[i]], envir = NB_ENV)
        }
        wv <- withVisible(eval(exprs[[length(exprs)]], envir = NB_ENV))
        value <<- wv$value
        visible <<- wv$visible
        if (wv$visible && is.symbol(exprs[[length(exprs)]])) {
          vname <<- as.character(exprs[[length(exprs)]])
        }
      }
    }, 1048576L)

    msgs <- cap$lines
    if (cap$interrupted) {
      cleanup_failed_defs(defs, pre)
      return(list(ok = FALSE, value = NULL, log = I(msgs),
                  error = list(message = "Interrupted", interrupted = TRUE)))
    }
    if (!is.null(cap$error)) {
      cleanup_failed_defs(defs, pre)
      return(list(ok = FALSE, value = NULL, log = I(msgs),
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

    if (isTRUE(visible)) {
      rv <- render_visible(value, vname, id, new_owned)
      if (identical(rv$kind, "error")) {
        # structured render failure: definition cleanup, not a placeholder
        cleanup_failed_defs(defs, pre)
        CELL_DEFS[[id]] <- NULL
        return(list(ok = FALSE, value = NULL, log = I(msgs),
                    error = list(message = rv$message)))
      }
      value <- rv
    } else {
      value <- NULL
    }
    list(ok = TRUE, value = value, log = I(msgs))
  }

  # Remove definitions a failed/interrupted cell created before its error.
  cleanup_failed_defs <- function(defs, pre) {
    for (nm in setdiff(defs, pre)) {
      if (exists(nm, envir = NB_ENV, inherits = FALSE)) {
        rm(list = nm, envir = NB_ENV)
      }
    }
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
    list(ok = TRUE, names = I(ls(NB_ENV, all.names = TRUE)))
  }

  # set_widget: the host validated the request; re-validate and assign here.
  # Dropdowns select by 1-based index into the live choices (typing preserved);
  # numeric controls coerce to double; text/logical keep canonical scalars.
  set_widget <- function(req) {
    name <- as.character(req$name %||% "")
    op_id <- req$op_id
    if (!exists(name, envir = NB_ENV, inherits = FALSE)) {
      return(list(ok = FALSE, error = list(message = sprintf("widget not found: %s",
                                                             name))))
    }
    x <- get(name, envir = NB_ENV)
    if (!UI_ENV$is_widget(x)) {
      return(list(ok = FALSE, error = list(message = sprintf(
        "'%s' is not a widget", name))))
    }
    kind <- x$kind
    idx <- NULL
    if (identical(kind, "dropdown")) {
      idx <- req$index
      if (!is.numeric(idx) || length(idx) != 1L || is.na(idx) ||
          idx < 1 || idx > length(x$choices)) {
        return(list(ok = FALSE, error = list(message = "dropdown index out of range")))
      }
      idx <- as.integer(idx)
      val <- x$choices[[idx]]
    } else if (kind %in% c("slider", "number")) {
      v <- req$value
      if (!is.numeric(v) || length(v) != 1L || is.na(v) ||
          !is.finite(as.double(v))) {
        return(list(ok = FALSE, error = list(message = "numeric widget value invalid")))
      }
      val <- as.double(v)
    } else if (identical(kind, "text_input")) {
      v <- req$value
      if (!is.character(v) || length(v) != 1L || is.na(v)) {
        return(list(ok = FALSE, error = list(message = "text value invalid")))
      }
      val <- v
    } else {
      # checkbox / run_button: canonical logical scalar
      v <- req$value
      if (!is.logical(v) || length(v) != 1L || is.na(v)) {
        return(list(ok = FALSE, error = list(message = "logical value invalid")))
      }
      val <- v
    }
    spec <- as.list(unclass(x)[c("min", "max", "step", "choices")])
    val <- tryCatch(UI_ENV$validate_widget_value(kind, val, spec),
                    error = function(e) NULL)
    if (is.null(val)) {
      return(list(ok = FALSE, error = list(message = "widget value rejected")))
    }
    x$value <- val
    assign(name, x, envir = NB_ENV)
    selected <- list(type = typeof(val), value = unclass(val))
    if (!is.null(idx)) selected$index <- idx
    list(ok = TRUE, name = name, op_id = op_id, selected = selected)
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
                ok = FALSE, value = NULL, log = character(),
                error = list(message = "Interrupted", interrupted = TRUE)),
              error = function(e) list(
                ok = FALSE, value = NULL, log = character(),
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
            ping = list(ok = TRUE, pong = TRUE),
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
