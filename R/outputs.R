# Output records and runtime hooks shared by notebook code and the worker.

RUNTIME <- new.env(parent = emptyenv())
RUNTIME$emit <- NULL
RUNTIME$cell_id <- function() NULL
RUNTIME$artifact_dir <- NULL
RUNTIME$cache_dir <- NULL
RUNTIME$lazy <- new.env(parent = emptyenv())
RUNTIME$lazy_seq <- NULL
RUNTIME$mem_cache <- new.env(parent = emptyenv())
RUNTIME$disk_cache_dirs <- new.env(parent = emptyenv())
RUNTIME$duckdb <- NULL

runtime_seq <- function() {
  if (is.environment(RUNTIME$seq)) {
    RUNTIME$seq$value <- as.integer(RUNTIME$seq$value %||% 0L) + 1L
    return(RUNTIME$seq$value)
  }
  RUNTIME$seq <- as.integer(RUNTIME$seq %||% 0L) + 1L
  RUNTIME$seq
}

runtime_lazy_seq <- function() {
  if (is.environment(RUNTIME$lazy_seq)) {
    RUNTIME$lazy_seq$value <- as.integer(RUNTIME$lazy_seq$value %||% 0L) + 1L
    return(RUNTIME$lazy_seq$value)
  }
  runtime_seq()
}

new_output <- function(kind, ...) {
  kinds <- c("text", "table", "image", "html", "markdown", "widget",
             "error", "media", "layout", "lazy", "progress")
  if (!is.character(kind) || length(kind) != 1L || is.na(kind) ||
      !kind %in% kinds) stop("unknown alder output kind", call. = FALSE)
  structure(c(list(kind = kind), list(...)),
            class = c("alder_output", "list"))
}

output_text <- function(x) {
  if (inherits(x, "alder_output")) return(x)
  if (is.null(x)) return(new_output("text", text = "NULL", truncated = FALSE))
  if (is.data.frame(x) || is.matrix(x)) {
    nr <- nrow(x); nc <- ncol(x)
    pv <- if (is.matrix(x)) as.data.frame(utils::head(x, 25L)) else utils::head(x, 25L)
    if (nc > 50L) pv <- pv[, seq_len(50L), drop = FALSE]
    pv <- as.data.frame(lapply(pv, function(col) {
      z <- as.character(col)
      z[is.na(z)] <- "NA"
      z
    }), stringsAsFactors = FALSE, check.names = FALSE)
    return(new_output("table", nrow = as.numeric(nr), ncol = as.numeric(nc),
                      columns = as.character(colnames(pv)),
                      preview = unname(lapply(seq_len(nrow(pv)), function(i)
                        as.list(as.character(pv[i, , drop = TRUE])))),
                      truncated_rows = nr > 25L,
                      truncated_columns = nc > 50L))
  }
  cap <- utils::capture.output(utils::str(x, max.level = 1L))
  new_output("text", text = paste(cap, collapse = "\n"), truncated = FALSE)
}

output_widget <- function(x, name = NULL) {
  if (!inherits(x, "alder_widget")) return(NULL)
  spec <- unclass(x)
  if (identical(x$kind, "dropdown")) {
    idx <- which(vapply(x$choices, function(choice) identical(choice, x$value), logical(1)))
    if (length(idx)) spec$index <- idx[[1L]]
    spec$choices <- I(x$choices)
  }
  new_output("widget", name = as.character(name %||% ""),
             owner = as.character(RUNTIME$cell_id() %||% ""), path = character(),
             commit_token = NULL, operation = NULL, spec = spec)
}

output_value <- function(x, widget_name = NULL) {
  if (inherits(x, "alder_output")) return(x)
  if (inherits(x, "alder_widget")) {
    return(output_widget(x, widget_name))
  }
  output_text(x)
}

#' Execute SQL against an explicit DBI connection or notebook data frames.
#'
#' @param query A single SQL query string.
#' @param conn An optional DBI connection.
#' @export
sql <- function(query, conn = NULL) {
  if (!is.character(query) || length(query) != 1L || is.na(query)) {
    stop("sql() query must be a single string", call. = FALSE)
  }
  emit_result <- function(result) {
    if (!is.null(RUNTIME$emit)) {
      RUNTIME$emit("append", list(output = output_text(result)))
    }
    result
  }
  if (!is.null(conn)) {
    if (!requireNamespace("DBI", quietly = TRUE)) {
      stop("sql() with a connection needs the DBI package", call. = FALSE)
    }
    return(emit_result(DBI::dbGetQuery(conn, query)))
  }
  if (!requireNamespace("DBI", quietly = TRUE) ||
      !requireNamespace("duckdb", quietly = TRUE)) {
    stop("sql() without a connection needs the duckdb package", call. = FALSE)
  }
  db <- RUNTIME$duckdb
  valid <- !is.null(db) && isTRUE(tryCatch(DBI::dbIsValid(db),
                                            error = function(e) FALSE))
  if (!valid) {
    db <- DBI::dbConnect(duckdb::duckdb())
    RUNTIME$duckdb <- db
  }
  names <- ls(envir = .GlobalEnv, all.names = TRUE)
  names <- names[grepl("^[A-Za-z_][A-Za-z0-9_]*$", names, perl = TRUE)]
  data_names <- names[vapply(names, function(name) {
    is.data.frame(get(name, envir = .GlobalEnv, inherits = FALSE))
  }, logical(1))]
  registered <- character()
  on.exit({
    for (name in registered) {
      tryCatch(duckdb::duckdb_unregister(db, name),
               error = function(e) NULL)
    }
  }, add = TRUE)
  for (name in data_names) {
    duckdb::duckdb_register(db, name,
                            get(name, envir = .GlobalEnv, inherits = FALSE),
                            overwrite = TRUE)
    registered <- c(registered, name)
  }
  emit_result(DBI::dbGetQuery(db, query))
}

render_layout_args <- function(exprs, env) {
  lapply(seq_along(exprs), function(i) {
    expr <- exprs[[i]]
    value <- eval(expr, envir = env)
    if (inherits(value, "alder_widget")) {
      if (!is.symbol(expr)) {
        return(new_output("error",
          message = "a widget inside a layout must be a bare variable name"))
      }
      return(output_widget(value, as.character(expr)))
    }
    output_value(value)
  })
}

layout_output <- function(kind, args, attrs = list()) {
  new_output("layout", layout = kind, attrs = attrs, children = args)
}

media_output <- function(path_or_raw, media_type, alt = NULL) {
  if (is.character(path_or_raw) && length(path_or_raw) == 1L &&
      grepl("^https?://", path_or_raw, ignore.case = TRUE)) {
    return(new_output("error", message = "out$image() needs a local file or raw vector"))
  }
  dir <- RUNTIME$artifact_dir %||% file.path(tools::R_user_dir("alder", "cache"),
                                              "artifacts")
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  if (is.raw(path_or_raw)) {
    mime_type <- switch(media_type, image = "image/png", audio = "audio/wav",
                        video = "video/mp4", pdf = "application/pdf")
    ext <- switch(mime_type, "image/png" = ".png", "audio/wav" = ".wav",
                  "video/mp4" = ".mp4", "application/pdf" = ".pdf")
    dest <- tempfile("alder-media-", tmpdir = dir, fileext = ext)
    writeBin(path_or_raw, dest)
  } else {
    if (!is.character(path_or_raw) || length(path_or_raw) != 1L ||
        is.na(path_or_raw) || !file.exists(path_or_raw) || dir.exists(path_or_raw)) {
      return(new_output("error", message = "media input must be a local file or raw vector"))
    }
    mime_type <- mime::guess_type(path_or_raw) %||% "application/octet-stream"
    ext <- tools::file_ext(path_or_raw)
    if (!nzchar(ext)) ext <- switch(media_type, image = "png", audio = "wav",
                                    video = "mp4", pdf = "pdf")
    dest <- tempfile("alder-media-", tmpdir = dir, fileext = paste0(".", ext))
    if (!file.copy(path_or_raw, dest, overwrite = TRUE)) {
      return(new_output("error", message = "could not copy media artifact"))
    }
  }
  new_output("media", media_type = media_type, artifact = basename(dest),
             mime = mime_type, alt = alt %||% "")
}

progress_emit <- function(record) {
  emit <- RUNTIME$emit
  if (is.null(emit)) {
    message(sprintf("%s: %s/%s", record$label, record$value,
                    record$total %||% ""))
  } else {
    emit("progress", list(progress = record))
  }
  invisible(record)
}

#' Notebook output library
#'
#' \code{out$md()}, \code{out$html()}, \code{out$image()} and the media
#' helpers emit rich outputs; \code{out$callout()}, \code{out$hstack()},
#' \code{out$vstack()}, \code{out$tabs()}, \code{out$accordion()} and
#' \code{out$sidebar()} compose them; \code{out$progress()} streams a
#' progress bar, \code{out$append()} emits an extra output, \code{out$lazy()}
#' defers a computation behind a button, \code{out$inspect()} prints a
#' bounded \code{str()}, and \code{out$stop()} halts a cell early. When the
#' notebook runs as a plain Rscript (no worker), every constructor degrades
#' to ordinary R behavior (ADR 0001).
#'
#' @export
out <- list(
  md = function(text, ...) {
    text <- paste(as.character(text), collapse = "\n")
    dots <- list(...)
    if (length(dots)) text <- tryCatch(do.call(sprintf, c(list(text), dots)),
                                       error = function(e) paste(c(text, dots), collapse = ""))
    html <- sanitize_markdown_html(commonmark::markdown_html(text, extensions = FALSE))
    new_output("markdown", html = html, text = text)
  },
  html = function(html) {
    html <- paste(as.character(html), collapse = "\n")
    clean <- sanitize_markdown_html(html)
    new_output("markdown", html = clean, text = clean)
  },
  image = function(path_or_raw, alt = NULL) media_output(path_or_raw, "image", alt),
  audio = function(path_or_raw, alt = NULL) media_output(path_or_raw, "audio", alt),
  video = function(path_or_raw, alt = NULL) media_output(path_or_raw, "video", alt),
  pdf = function(path_or_raw, alt = NULL) media_output(path_or_raw, "pdf", alt),
  callout = function(x, variant = c("info", "warn", "danger", "success")) {
    variant <- match.arg(variant)
    exprs <- as.list(substitute(list(x)))[-1L]
    layout_output("callout", render_layout_args(exprs, parent.frame()),
                  list(variant = variant))
  },
  hstack = function(..., gap = 8, align = "center", justify = "start") {
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("hstack", render_layout_args(exprs, parent.frame()),
                  list(gap = gap, align = align, justify = justify))
  },
  vstack = function(..., gap = 8) {
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("vstack", render_layout_args(exprs, parent.frame()), list(gap = gap))
  },
  tabs = function(...) {
    exprs <- as.list(substitute(list(...)))[-1L]
    titles <- names(exprs)
    titles[is.null(titles)] <- ""
    layout_output("tabs", render_layout_args(exprs, parent.frame()), list(titles = titles))
  },
  accordion = function(...) {
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("accordion", render_layout_args(exprs, parent.frame()),
                  list(titles = names(exprs)))
  },
  sidebar = function(...) {
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("sidebar", render_layout_args(exprs, parent.frame()), list())
  },
  progress = function(total = NULL, label = NULL) {
    if (!is.null(total) && (!is.numeric(total) || length(total) != 1L ||
                            is.na(total) || total < 0)) {
      stop("`total` must be a non-negative scalar", call. = FALSE)
    }
    if (!is.null(label) && (!is.character(label) || length(label) != 1L || is.na(label))) {
      stop("`label` must be a scalar character", call. = FALSE)
    }
    at <- 0
    closed <- FALSE
    update <- function(value = NULL, label = NULL) {
      if (isTRUE(closed)) return(invisible(NULL))
      if (is.null(value)) {
        at <<- at + 1
      } else {
        if (!is.numeric(value) || length(value) != 1L || is.na(value) ||
            !is.finite(value) || value < 0) {
          stop("`value` must be a non-negative scalar number", call. = FALSE)
        }
        at <<- as.numeric(value)
      }
      if (!is.null(label)) label0 <<- as.character(label)
      progress_emit(new_output("progress", value = at, total = total,
                               label = label0 %||% "", done = FALSE))
      invisible(at)
    }
    close <- function() {
      if (isTRUE(closed)) return(invisible(NULL))
      closed <<- TRUE
      progress_emit(new_output("progress", value = at, total = total,
                               label = label0 %||% "", done = TRUE))
      invisible(at)
    }
    label0 <- label
    structure(list(update = update, close = close),
              class = c("alder_progress", "list"))
  },
  append = function(x) {
    output <- output_value(x)
    emit <- RUNTIME$emit
    if (is.null(emit)) print(x) else emit("append", list(output = output))
    invisible(x)
  },
  lazy = function(f, label = "Show") {
    if (!is.function(f) || length(formals(f)) != 0L) {
      stop("out$lazy() needs a zero-argument function", call. = FALSE)
    }
    if (is.null(RUNTIME$emit)) return(f())
    key <- paste0(RUNTIME$cell_id(), ":", runtime_lazy_seq())
    if (!is.environment(RUNTIME$lazy)) {
      stop("lazy output runtime is unavailable", call. = FALSE)
    }
    assign(key, f, envir = RUNTIME$lazy)
    new_output("lazy", key = key, label = as.character(label),
               state = "collapsed", child = NULL)
  },
  inspect = function(x) {
    txt <- paste(utils::capture.output(utils::str(x)), collapse = "\n")
    if (nchar(txt, type = "bytes") > 65536L) {
      txt <- substr(txt, 1L, 65536L)
    }
    new_output("text", text = txt, truncated = nchar(txt, type = "bytes") >= 65536L)
  },
  stop = function(condition = TRUE, output = NULL) {
    if (!isTRUE(condition)) return(invisible(NULL))
    structure(list(message = "", call = NULL, output = output),
              class = c("alder_stop", "error", "condition")) |> stop()
  }
)
