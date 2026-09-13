RUNTIME <- new.env(parent = emptyenv())
RUNTIME$emit <- NULL
RUNTIME$render <- NULL
RUNTIME$cell_id <- function() NULL
RUNTIME$artifact_dir <- NULL
RUNTIME$register_artifact <- NULL
RUNTIME$cache_dir <- NULL
RUNTIME$lazy <- new.env(parent = emptyenv())
RUNTIME$lazy_seq <- NULL
RUNTIME$mem_cache <- new.env(parent = emptyenv())
RUNTIME$disk_cache_dirs <- new.env(parent = emptyenv())

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

output_text_record <- function(text, max_bytes = 262144L) {
  bytes <- charToRaw(enc2utf8(text))
  truncated <- length(bytes) > max_bytes
  if (truncated) {
    suffix <- "\n[output truncated]"
    keep <- max_bytes - nchar(suffix, type = "bytes")
    prefix <- rawToChar(bytes[seq_len(keep)])
    text <- paste0(iconv(prefix, from = "UTF-8", to = "UTF-8", sub = ""), suffix)
  }
  new_output("text", text = text, truncated = truncated)
}

output_text <- function(x) {
  if (inherits(x, "alder_output")) return(x)
  if (is.null(x)) return(new_output("text", text = "NULL", truncated = FALSE))
  if (is.character(x) && !is.object(x) && length(x) == 1L && !is.na(x)) {
    return(output_text_record(x))
  }
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
  cap <- utils::capture.output(print(x))
  output_text_record(paste(cap, collapse = "\n"))
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
  if (is.character(x) && !is.object(x) && length(x) == 1L && !is.na(x)) {
    return(output_text(x))
  }
  if (is.function(RUNTIME$render)) return(RUNTIME$render(x))
  output_text(x)
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
validate_layout_gap <- function(gap) {
  if (!is.numeric(gap) || length(gap) != 1L || is.na(gap) ||
      !is.finite(gap) || gap < 0 || gap > 4096) {
    stop("`gap` must be a finite non-negative number no greater than 4096", call. = FALSE)
  }
  gap
}

validate_layout_choice <- function(value, name, choices) {
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !value %in% choices) {
    stop(sprintf("`%s` must be one of: %s", name, paste(choices, collapse = ", ")),
         call. = FALSE)
  }
  value
}
media_default_mime <- function(media_type) {
  switch(media_type,
    image = "image/png",
    audio = "audio/wav",
    video = "video/mp4",
    pdf = "application/pdf",
    "application/octet-stream"
  )
}

media_mime_essence <- function(mime_type) {
  sub(";.*$", "", tolower(trimws(mime_type)))
}

media_mime_compatible <- function(media_type, mime_type) {
  if (!is.character(mime_type) || length(mime_type) != 1L || is.na(mime_type) || !nzchar(mime_type)) {
    return(FALSE)
  }
  essence <- media_mime_essence(mime_type)
  switch(media_type,
    image = startsWith(essence, "image/"),
    audio = startsWith(essence, "audio/"),
    video = startsWith(essence, "video/"),
    pdf = identical(essence, "application/pdf"),
    FALSE
  )
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
    mime_type <- media_default_mime(media_type)
    ext <- switch(media_type, image = ".png", audio = ".wav", video = ".mp4", pdf = ".pdf", ".bin")
    dest <- tempfile("alder-media-", tmpdir = dir, fileext = ext)
    writeBin(path_or_raw, dest)
  } else {
    if (!is.character(path_or_raw) || length(path_or_raw) != 1L ||
        is.na(path_or_raw) || !file.exists(path_or_raw) || dir.exists(path_or_raw)) {
      return(new_output("error", message = "media input must be a local file or raw vector"))
    }
    ext <- tools::file_ext(path_or_raw)
    guessed <- tryCatch(mime::guess_type(path_or_raw), error = function(e) NULL)
    guessed_ok <- is.character(guessed) && length(guessed) == 1L && !is.na(guessed) && nzchar(guessed)
    known_mime <- switch(tolower(ext), html = "text/html", htm = "text/html", xhtml = "application/xhtml+xml", NULL)
    if (!guessed_ok || identical(media_mime_essence(guessed), "application/octet-stream")) {
      mime_type <- known_mime %||% media_default_mime(media_type)
    } else {
      mime_type <- as.character(guessed)
    }
    if (!media_mime_compatible(media_type, mime_type)) {
      return(new_output("error", message = "media input MIME type does not match requested media type"))
    }
    if (!nzchar(ext)) ext <- sub("^\\.", "", switch(media_type, image = ".png", audio = ".wav", video = ".mp4", pdf = ".pdf", ".bin"))
    dest <- tempfile("alder-media-", tmpdir = dir, fileext = paste0(".", ext))
    if (!file.copy(path_or_raw, dest, overwrite = TRUE)) {
      return(new_output("error", message = "could not copy media artifact"))
    }
  }
  if (is.function(RUNTIME$register_artifact)) {
    RUNTIME$register_artifact(basename(dest))
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

validate_progress_total <- function(total) {
  if (is.null(total)) return(NULL)
  if (!is.numeric(total) || length(total) != 1L || is.na(total) ||
      !is.finite(total) || total < 0) {
    stop("`total` must be a non-negative scalar", call. = FALSE)
  }
  as.double(total)
}

validate_progress_label <- function(label) {
  if (is.null(label)) return(NULL)
  if (!is.character(label) || length(label) != 1L || is.na(label) ||
      !validUTF8(label) || nchar(label, type = "bytes") > 4096L) {
    stop("`label` must be a scalar character", call. = FALSE)
  }
  label
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
#' to ordinary R behavior. Named widgets nested in supported
#' layouts or resolved lazy outputs retain reactive updates, focus, and
#' operation identity. Layouts and appended outputs use the same native plot,
#' HTML widget, table, and printed model renderers as standalone values;
#' character scalars are displayed as readable text. Use \code{out$inspect()}
#' explicitly for an object's internal structure.
#' Tabs expose linked tab/tablist/tabpanel selection
#' semantics, and accordions expose linked expanded/region state.
#'
#' @examples
#' out$md("## Result")
#' out$callout("Check assumptions", variant = "warn")
#' @export
out <- list(
  md = function(text, ...) {
    text <- paste(as.character(text), collapse = "\n")
    dots <- list(...)
    if (length(dots)) text <- tryCatch(do.call(sprintf, c(list(text), dots)),
                                       error = function(e) paste(c(text, dots), collapse = ""))
    new_output("markdown", text = text)
  },
  html = function(html) {
    html <- paste(as.character(html), collapse = "\n")
    new_output("html", html = html)
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
    gap <- validate_layout_gap(gap)
    align <- validate_layout_choice(align, "align", c("start", "center", "end", "stretch"))
    justify <- validate_layout_choice(justify, "justify",
                                      c("start", "center", "end", "space-between",
                                        "space-around", "space-evenly"))
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("hstack", render_layout_args(exprs, parent.frame()),
                  list(gap = gap, align = align, justify = justify))
  },
  vstack = function(..., gap = 8) {
    gap <- validate_layout_gap(gap)
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("vstack", render_layout_args(exprs, parent.frame()), list(gap = gap))
  },
  tabs = function(...) {
    exprs <- as.list(substitute(list(...)))[-1L]
    titles <- names(exprs)
    titles[is.null(titles)] <- ""
    layout_output("tabs", render_layout_args(exprs, parent.frame()), list(titles = I(titles)))
  },
  accordion = function(...) {
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("accordion", render_layout_args(exprs, parent.frame()),
                  list(titles = I(names(exprs) %||% character())))
  },
  sidebar = function(...) {
    exprs <- as.list(substitute(list(...)))[-1L]
    layout_output("sidebar", render_layout_args(exprs, parent.frame()), list())
  },
  progress = function(total = NULL, label = NULL) {
    total <- validate_progress_total(total)
    label <- validate_progress_label(label)
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
      if (!is.null(label)) label0 <<- validate_progress_label(label)
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
    label <- validate_progress_label(label) %||% "Show"
    if (!is.function(f) || length(formals(f)) != 0L) {
      stop("out$lazy() needs a zero-argument function", call. = FALSE)
    }
    if (is.null(RUNTIME$emit)) return(f())
    key <- paste0(RUNTIME$cell_id(), ":", runtime_lazy_seq())
    if (!is.environment(RUNTIME$lazy)) {
      stop("lazy output runtime is unavailable", call. = FALSE)
    }
    assign(key, f, envir = RUNTIME$lazy)
    new_output("lazy", key = key, label = label,
               state = "collapsed", child = NULL)
  },
  inspect = function(x) {
    txt <- paste(utils::capture.output(utils::str(x)), collapse = "\n")
    output_text_record(txt, max_bytes = 65536L)
  },
  stop = function(condition = TRUE, output = NULL) {
    if (!isTRUE(condition)) return(invisible(NULL))
    structure(list(message = "", call = NULL, output = output),
              class = c("alder_stop", "error", "condition")) |> stop()
  }
)
