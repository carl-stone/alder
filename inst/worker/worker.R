# alder worker — the one serial R process per notebook (ADR 0004).
#
# A long-lived Rscript. Reads one JSON request per line on stdin, writes one
# JSON response per line on stdout; stderr stays a diagnostic channel.
# The server spawns us, writes requests to our stdin, matches responses by
# `req` id, and SIGINTs us to interrupt a running cell. We own the
# notebook's global environment and widget values, so notebook state has a
# single unambiguous owner.
#
# Protocol discipline: stdout carries protocol JSON ONLY. Every user-code
# output path (cat, print, auto-print of visible results, renderers) is
# wrapped in capture.output(type = "output") and appended to the cell log;
# nothing user code prints may leak into the protocol stream.

suppressMessages({
  library(jsonlite)
})

# Load the widget proxy module (ADR 0003) so `ui$slider(...)` etc. work here.
# The host passes the resolved path via ALDER_UI_WIDGETS; fall back to
# probing known layouts only for direct launcher compatibility.
ui_source <- Sys.getenv("ALDER_UI_WIDGETS", unset = "")
app_dir <- Sys.getenv("ALDER_APP_DIR", unset = "")
candidates <- c(
  ui_source,
  if (nzchar(app_dir)) file.path(app_dir, "inst", "worker", "ui-widgets.R") else "",
  if (nzchar(app_dir)) file.path(app_dir, "R", "ui-widgets.R") else "",
  file.path(dirname(sub("^--file=", "", commandArgs(FALSE)[1L])), "ui-widgets.R"),
  file.path("inst", "worker", "ui-widgets.R"),
  file.path("R", "ui-widgets.R"),
  system.file("worker", "ui-widgets.R", package = "alder")
)
ui_source <- ""
for (p in candidates) {
  if (nzchar(p) && file.exists(p)) { ui_source <- p; break }
}
if (!nzchar(ui_source)) {
  stop("alder widget module (ui-widgets.R) not found; looked in: ",
       paste(candidates, collapse = "; "))
}
source(ui_source)

artifact_dir <- Sys.getenv("ALDER_ARTIFACT_DIR", unset = "")
if (!nzchar(artifact_dir) || !dir.exists(artifact_dir) ||
    file.access(artifact_dir, 2) != 0L) {
  stop("ALDER_ARTIFACT_DIR is missing or invalid: '", artifact_dir,
       "' (must be an existing writable directory)")
}

NB_ENV <- new.env(parent = globalenv())   # notebook globals

# Per-cell definition ownership. CELL_DEFS[[id]] is the set of names the
# cell most recently defined; NAME_OWNER[[name]] is the cell that owns the
# binding. Environments, not lists: mutations inside functions must hit the
# real maps (a plain `<-` on a list would silently copy a local one).
# Success of a cell both promotes its new bindings and drops its stale
# ones (only while it still owns them); failures change nothing.
CELL_DEFS <- new.env(parent = emptyenv())
NAME_OWNER <- new.env(parent = emptyenv())

emit <- function(x) {
  cat(jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null",
                       force = TRUE), "\n", sep = "")
  flush.console()
}

`%||%` <- function(a, b) if (is.null(a)) b else a

render_value <- function(x) {
  if (inherits(x, "alder_widget_proxy")) {
    spec <- as.list(unclass(x))
    spec$kind <- "widget"
    spec$class <- NULL
    return(spec)
  }
  if (inherits(x, "data.frame") || inherits(x, "matrix")) {
    nr <- nrow(x); nc <- ncol(x)
    cols <- if (inherits(x, "matrix")) colnames(x) else colnames(x) %||% names(x)
    pv <- if (inherits(x, "matrix"))
      as.data.frame(utils::head(x, 25), stringsAsFactors = FALSE) else
      utils::head(x, 25)
    # I() keeps column lists array-shaped under auto_unbox (single column)
    return(list(kind = "table", nrow = nr, ncol = nc,
                columns = I(cols), preview = I(pv)))
  }
  if (inherits(x, "gg") || inherits(x, "ggplot")) {
    f <- tempfile(tmpdir = artifact_dir, fileext = ".png")
    ok <- tryCatch({
      ggplot2::ggsave(f, plot = x, width = 8, height = 5, dpi = 96)
      TRUE
    }, error = function(e) FALSE)
    if (ok) return(list(kind = "image", artifact = basename(f)))
    return(list(kind = "text", text = "<ggplot: could not render>"))
  }
  if (inherits(x, "htmlwidget")) {
    f <- tempfile(tmpdir = artifact_dir, fileext = ".html")
    ok <- tryCatch({
      htmlwidgets::saveWidget(x, f, selfcontained = TRUE)
      TRUE
    }, error = function(e) FALSE)
    if (ok) return(list(kind = "html", artifact = basename(f)))
    return(list(kind = "text", text = "<htmlwidget: could not render>"))
  }
  txt <- tryCatch(paste(utils::capture.output(print(x)), collapse = "\n"),
                  error = function(e) conditionMessage(e))
  list(kind = "text", text = txt)
}

exec_cell <- function(req) {
  code <- req$code %||% ""
  id <- req$id %||% ""
  if (!nzchar(code)) return(list(ok = TRUE, value = NULL, log = character()))
  cell_env <- new.env(parent = NB_ENV)
  msgs <- character()
  holder <- new.env(parent = emptyenv())
  holder$value <- NULL
  holder$visible <- FALSE

  # Evaluation, wrapped so cat()/print()/auto-print can never reach the
  # protocol stream; captured lines land in the cell log instead.
  # Note: capture.output returns the captured lines, never the expression
  # value, so errors are stashed in holder$err.
  holder$err <- NULL
  out_lines <- withCallingHandlers(
    tryCatch(
      capture.output({
        wv <- withVisible(eval(parse(text = code), envir = cell_env))
        holder$value <- wv$value
        holder$visible <- wv$visible
        if (wv$visible && !inherits(wv$value, "alder_widget_proxy")) {
          print(wv$value)
        }
      }, type = "output"),
      error = function(e) { holder$err <- conditionMessage(e) }
    ),
    message = function(m) { msgs <<- c(msgs, conditionMessage(m)); invokeRestart("muffleMessage") },
    warning = function(w) { msgs <<- c(msgs, paste("Warning:", conditionMessage(w))); invokeRestart("muffleWarning") }
  )

  if (length(out_lines) && any(nzchar(out_lines))) msgs <- c(msgs, out_lines[nzchar(out_lines)])

  if (!is.null(holder$err)) {
    return(list(ok = FALSE, value = NULL, log = msgs,
                error = list(message = holder$err)))
  }

  # Commit the successful run's bindings into NB_ENV.
  new_names <- setdiff(ls(cell_env, all.names = TRUE), c("ui"))
  old_names <- CELL_DEFS[[id]] %||% character()
  for (nm in setdiff(old_names, new_names)) {
    if (identical(NAME_OWNER[[nm]] %||% NULL, id)) {
      rm(list = nm, envir = NB_ENV)
      NAME_OWNER[[nm]] <- NULL
    }
  }
  for (nm in new_names) {
    assign(nm, get(nm, envir = cell_env), envir = NB_ENV)
    prev <- NAME_OWNER[[nm]] %||% NULL
    if (!is.null(prev) && !identical(prev, id)) {
      # Ownership transferred: the previous owner no longer defines it.
      CELL_DEFS[[prev]] <- setdiff(CELL_DEFS[[prev]] %||% character(), nm)
    }
    NAME_OWNER[[nm]] <- id
  }
  CELL_DEFS[[id]] <- new_names

  # Widget proxies this cell defined, so the frontend can render its
  # controls (ADR 0003: the proxy IS the value). Inherited proxies stay
  # owned by the cell that defined them.
  widgets <- list()
  for (nm in new_names) {
    v <- get(nm, envir = NB_ENV)
    if (inherits(v, "alder_widget_proxy")) {
      widgets[[length(widgets) + 1L]] <- list(name = nm, spec = widget_spec(v))
    }
  }

  # Visibility rendering is part of the user-code path: capture it, so a
  # noisy renderer can never corrupt the protocol stream.
  rv <- NULL
  if (isTRUE(holder$visible)) {
    rv <- tryCatch({
      rr <- NULL
      cap <- capture.output(
        rr <- if (inherits(holder$value, "alder_widget_proxy"))
          widget_spec(holder$value)
        else render_value(holder$value),
        type = "output")
      if (length(cap) && any(nzchar(cap))) msgs <- c(msgs, cap[nzchar(cap)])
      rr
    }, error = function(e) list(kind = "text", text = paste("<render error:", conditionMessage(e), ">")))
  }
  list(ok = TRUE, value = rv, log = msgs, widgets = widgets)
}

widget_spec <- function(x) {
  spec <- as.list(unclass(x))
  spec$kind <- "widget"
  spec$class <- NULL
  spec
}

# -- clear_cell / get_value / env_snapshot / set_widget ----------------------
clear_cell <- function(req) {
  id <- req$id %||% ""
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
  list(ok = TRUE)
}

server_describe <- function(req) {
  name <- req$name
  if (!exists(name, envir = NB_ENV, inherits = FALSE)) {
    return(list(ok = FALSE, error = list(message = paste0("No such name: '", name, "'"))))
  }
  list(ok = TRUE, name = name, value = render_value(get(name, envir = NB_ENV)))
}

env_snapshot <- function(req) {
  list(ok = TRUE, names = ls(NB_ENV, all.names = TRUE))
}

set_widget <- function(req) {
  name <- req$name
  if (!exists(name, envir = NB_ENV, inherits = FALSE)) {
    return(list(ok = FALSE, error = list(message = paste0("No such widget value: '", name, "'"))))
  }
  x <- get(name, envir = NB_ENV)
  if (!inherits(x, "alder_widget_proxy")) {
    return(list(ok = FALSE, error = list(message = paste0("'", name, "' is not a widget"))))
  }
  x[[".value"]] <- req$value
  assign(name, x, envir = NB_ENV)
  list(ok = TRUE, value = req$value)
}

# -- main loop ----------------------------------------------------------------
# Every interruptible point is guarded. A stop/edit interrupt may raise its
# condition at any safe point — during the read, between statements, inside
# emit — and in a non-interactive Rscript an interrupt that reaches top
# level terminates the process ("Execution halted"). One wrapper tryCatch
# therefore covers the whole iteration, swallowing stray raises; eval
# requests additionally emit a "started" ack so the host only SIGINTs while
# evaluation is known to be in progress. A true EOF is sticky (the host
# closes the pipe only when shutting down), so two consecutive empty reads
# are the only exit besides an explicit `shutdown`.
stdin_con <- file("stdin", open = "r")
eof_count <- 0L
last_cmd <- ""

repeat {
  stop_loop <- FALSE
  tryCatch({
    read <- tryCatch(readLines(stdin_con, n = 1, warn = FALSE),
                     interrupt = function(e) character(),
                     error = function(e) NA_character_)
    if (length(read) == 0L || is.na(read[[1L]]) || !nzchar(read[[1L]])) {
      if (eof_count >= 1L) stop_loop <- TRUE else eof_count <- eof_count + 1L
    } else {
      eof_count <- 0L
      req <- tryCatch(jsonlite::fromJSON(read[[1L]], simplifyVector = FALSE),
                      error = function(e) list(cmd = "raw", text = read[[1L]]))
      last_cmd <- req$cmd %||% ""
      if (identical(req$cmd, "eval_cell")) {
        # Tell the host evaluation has begun; the host only SIGINTs after
        # this ack, so an interrupt can never land on the blocking read.
        ack <- list(ok = TRUE, ack = "started", req = req$req)
        if (!is.null(req$id)) ack$id <- req$id
        if (!is.null(req$revision)) ack$revision <- req$revision
        if (!is.null(req$run_id)) ack$run_id <- req$run_id
        tryCatch(emit(ack), error = function(e) NULL, interrupt = function(e) NULL)
      }
      resp <- tryCatch(
        switch(req$cmd,
          eval_cell = exec_cell(req),
          clear_cell = clear_cell(req),
          get_value = server_describe(req),
          env_snapshot = env_snapshot(req),
          set_widget = set_widget(req),
          ping = list(ok = TRUE, pong = TRUE),
          shutdown = list(ok = TRUE),
          list(ok = FALSE, error = list(message = paste0("Unknown command: ", req$cmd)))
        ),
        interrupt = function(e)
          list(ok = FALSE, error = list(message = "Interrupted", interrupted = TRUE)),
        error = function(e)
          list(ok = FALSE, error = list(message = conditionMessage(e)))
      )
      if (!is.null(req$req)) resp$req <- req$req
      if (!is.null(req$id)) resp$id <- req$id
      if (!is.null(req$revision)) resp$revision <- req$revision
      if (!is.null(req$run_id)) resp$run_id <- req$run_id
      emitted <- tryCatch({ emit(resp); TRUE }, interrupt = function(e) FALSE)
      if (!emitted) {
        # An interrupt raced the write: re-emit now that the condition cleared.
        tryCatch(emit(resp), error = function(e) NULL, interrupt = function(e) NULL)
      }
      if (identical(last_cmd, "shutdown")) stop_loop <- TRUE
    }
  }, interrupt = function(e) NULL)
  if (stop_loop) break
}

close(stdin_con)