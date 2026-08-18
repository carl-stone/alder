# Static export, diagnostics, and script execution helpers.
#
# Export deliberately consumes a Session state snapshot. The worker remains
# the only place that renders notebook values, so this module never evaluates
# user code while producing an export (alder_source/alder_test are explicit
# execution APIs).

export_formats <- c("html", "md", "script", "ipynb", "qmd", "session")

export_scalar_chr <- function(x, default = "") {
  if (is.null(x) || length(x) != 1L || is.na(x)) default else as.character(x)
}

export_html_escape <- function(x) {
  x <- as.character(x %||% "")
  x <- gsub("&", "&amp;", x, fixed = TRUE)
  x <- gsub("<", "&lt;", x, fixed = TRUE)
  x <- gsub(">", "&gt;", x, fixed = TRUE)
  x <- gsub('"', "&quot;", x, fixed = TRUE)
  x <- gsub("'", "&#39;", x, fixed = TRUE)
  x
}

export_attr <- function(name, value) {
  paste0(name, '="', export_html_escape(value), '"')
}

export_markdown_line <- function(line) {
  if (!nzchar(trimws(line))) return("")
  if (grepl("^\\s*#", line)) sub("^(\\s*)#+ ?", "\\1", line) else line
}

export_markdown_body <- function(body) {
  if (!length(body)) return(character())
  vapply(body, export_markdown_line, character(1))
}

export_artifact_ok <- function(artifact, artifact_dir) {
  is.character(artifact) && length(artifact) == 1L && !is.na(artifact) &&
    nzchar(artifact) && !grepl("[/\\\\]", artifact) &&
    !grepl("^\\.", artifact) && file.exists(file.path(artifact_dir, artifact)) &&
    !dir.exists(file.path(artifact_dir, artifact))
}

export_artifact_uri <- function(artifact, artifact_dir, mime = NULL) {
  if (!export_artifact_ok(artifact, artifact_dir)) return(NULL)
  mime <- export_scalar_chr(mime, "application/octet-stream")
  encoded <- tryCatch(base64enc::base64encode(file.path(artifact_dir, artifact)),
                      error = function(e) NULL)
  if (is.null(encoded)) return(NULL)
  paste0("data:", mime, ";base64,", encoded)
}

export_widget_value <- function(spec) {
  value <- spec$value %||% NULL
  if (is.null(value)) return("")
  if (is.atomic(value)) return(paste(as.character(value), collapse = ", "))
  tryCatch(jsonlite::toJSON(value, auto_unbox = TRUE, null = "null"),
           error = function(e) paste(utils::capture.output(utils::str(value)),
                                     collapse = " "))
}

export_table_rows <- function(output) {
  rows <- output$preview %||% list()
  if (!is.list(rows)) return(list())
  lapply(rows, function(row) {
    if (is.list(row)) as.character(unlist(row, use.names = FALSE))
    else as.character(row)
  })
}

export_table_text <- function(output) {
  cols <- as.character(unlist(output$columns %||% character(), use.names = FALSE))
  rows <- export_table_rows(output)
  if (!length(cols) && length(rows)) cols <- paste0("V", seq_along(rows[[1L]]))
  lines <- c(if (length(cols)) paste(cols, collapse = "\t") else "",
             vapply(rows, function(row) paste(row, collapse = "\t"), ""))
  paste(lines[nzchar(lines) | seq_along(lines) == 1L], collapse = "\n")
}

export_output_plain <- function(output, artifact_dir = NULL) {
  if (!is.list(output)) return("")
  kind <- export_scalar_chr(output$kind)
  if (kind == "text") return(export_scalar_chr(output$text))
  if (kind == "table") return(export_table_text(output))
  if (kind == "markdown") return(export_scalar_chr(output$text, ""))
  if (kind == "error") return(paste0("Error: ", export_scalar_chr(output$message)))
  if (kind %in% c("media", "image")) {
    return(paste0("[", kind, ": ", export_scalar_chr(output$artifact), "]"))
  }
  if (kind == "widget") return(export_widget_value(output$spec %||% list()))
  if (kind == "lazy") {
    if (!is.null(output$child)) return(export_output_plain(output$child, artifact_dir))
    return(export_scalar_chr(output$label))
  }
  if (kind == "progress") {
    return(paste0(export_scalar_chr(output$label), ": ",
                  export_scalar_chr(output$value), "/",
                  export_scalar_chr(output$total, "")))
  }
  if (kind == "layout") {
    children <- output$children %||% list()
    return(paste(vapply(children, export_output_plain, "", artifact_dir = artifact_dir),
                 collapse = "\n"))
  }
  if (kind == "html" && !is.null(artifact_dir) &&
      export_artifact_ok(output$artifact, artifact_dir)) {
    return(paste(readLines(file.path(artifact_dir, output$artifact), warn = FALSE),
                 collapse = "\n"))
  }
  ""
}

export_output_html <- function(output, artifact_dir) {
  if (!is.list(output)) return("")
  kind <- export_scalar_chr(output$kind)
  if (kind == "text") {
    return(paste0("<pre class=\"output-text\">",
                  export_html_escape(output$text), "</pre>"))
  }
  if (kind == "table") {
    cols <- as.character(unlist(output$columns %||% character(), use.names = FALSE))
    rows <- export_table_rows(output)
    head_html <- if (length(cols)) {
      paste0("<thead><tr>", paste0("<th>", export_html_escape(cols),
                                      "</th>", collapse = ""), "</tr></thead>")
    } else ""
    body_html <- if (length(rows)) {
      paste0("<tbody>",
             paste0(vapply(rows, function(row) paste0(
               "<tr>", paste0("<td>", export_html_escape(row), "</td>",
                              collapse = ""), "</tr>"), ""),
                    collapse = ""),
             "</tbody>")
    } else "<tbody></tbody>"
    note <- if (isTRUE(output$truncated_rows) || isTRUE(output$truncated_columns)) {
      "<caption>Preview truncated</caption>"
    } else ""
    return(paste0("<div class=\"table-preview\"><table>", note,
                  head_html, body_html, "</table></div>"))
  }
  if (kind == "markdown") return(export_scalar_chr(output$html, ""))
  if (kind == "image") {
    uri <- export_artifact_uri(output$artifact, artifact_dir, "image/png")
    if (is.null(uri)) return("<pre class=\"output-error\">image artifact unavailable</pre>")
    attrs <- c(export_attr("src", uri),
               if (!is.null(output$width)) export_attr("width", output$width),
               if (!is.null(output$height)) export_attr("height", output$height))
    return(paste0("<img class=\"out-image\" ", paste(attrs, collapse = " "), "/>"))
  }
  if (kind == "media") {
    mime <- export_scalar_chr(output$mime, "application/octet-stream")
    uri <- export_artifact_uri(output$artifact, artifact_dir, mime)
    if (is.null(uri)) return("<pre class=\"output-error\">media artifact unavailable</pre>")
    media_type <- export_scalar_chr(output$media_type)
    tag <- switch(media_type, image = "img", audio = "audio", video = "video",
                  pdf = "iframe", "a")
    attrs <- c(export_attr("src", uri),
               if (tag == "img") export_attr("alt", output$alt %||% ""),
               if (tag %in% c("audio", "video")) "controls",
               if (tag == "iframe") c("sandbox=\"\"",
                                      export_attr("title", output$alt %||% "")))
    close <- if (tag == "img") "/>" else paste0(">",
      if (tag == "iframe") "</iframe>" else paste0("</", tag, ">"))
    return(paste0("<", tag, " class=\"out-media\" ",
                  paste(attrs, collapse = " "), " ", close))
  }
  if (kind == "html") {
    if (!export_artifact_ok(output$artifact, artifact_dir)) {
      return("<pre class=\"output-error\">HTML artifact unavailable</pre>")
    }
    html <- paste(readLines(file.path(artifact_dir, output$artifact), warn = FALSE),
                  collapse = "\n")
    return(paste0("<iframe class=\"out-html\" sandbox=\"allow-scripts\" srcdoc=\"",
                  export_html_escape(html), "\"></iframe>"))
  }
  if (kind == "widget") {
    spec <- output$spec %||% list()
    value <- export_widget_value(spec)
    widget_kind <- export_scalar_chr(spec$kind)
    if (widget_kind %in% c("checkbox", "switch")) {
      checked <- isTRUE(spec$value)
      return(paste0("<label class=\"widget-export\"><input type=\"checkbox\" disabled",
                    if (checked) " checked" else "", ">",
                    export_html_escape(spec$label %||% ""), "</label>"))
    }
    return(paste0("<div class=\"widget-export\"><label>",
                  export_html_escape(spec$label %||% ""),
                  "</label><input type=\"text\" disabled ",
                  export_attr("value", value), "></div>"))
  }
  if (kind == "layout") {
    layout <- export_scalar_chr(output$layout, "vstack")
    attrs <- output$attrs %||% list()
    direction <- if (layout == "hstack") "row" else "column"
    style <- paste0("display:flex;flex-direction:", direction,
                    ";gap:", export_scalar_chr(attrs$gap, "8"), "px;")
    if (layout == "sidebar") style <- paste0(style, "align-items:stretch;")
    children <- output$children %||% list()
    body <- paste(vapply(children, export_output_html, "", artifact_dir = artifact_dir),
                  collapse = "")
    if (layout %in% c("callout", "sidebar")) {
      variant <- export_scalar_chr(attrs$variant, "info")
      return(paste0("<div class=\"out-callout ", export_html_escape(variant),
                    "\" style=\"", style, "\">", body, "</div>"))
    }
    if (layout %in% c("tabs", "accordion")) {
      titles <- as.character(unlist(attrs$titles %||% character(), use.names = FALSE))
      sections <- vapply(seq_along(children), function(i) paste0(
        "<section><h3>", export_html_escape(
          if (length(titles) >= i) titles[[i]] else ""), "</h3>",
        export_output_html(children[[i]], artifact_dir), "</section>"), "")
      return(paste0("<div class=\"out-", layout, "\">", paste(sections, collapse = ""),
                    "</div>"))
    }
    return(paste0("<div class=\"out-stack\" style=\"", style, "\">", body, "</div>"))
  }
  if (kind == "lazy") {
    if (!is.null(output$child)) return(export_output_html(output$child, artifact_dir))
    return(paste0("<span class=\"out-lazy\">", export_html_escape(output$label), "</span>"))
  }
  if (kind == "progress") {
    total <- if (is.null(output$total)) "" else export_attr("max", output$total)
    return(paste0("<div class=\"progress-row\"><progress ", total,
                  " value=\"", export_html_escape(output$value %||% 0),
                  "\"></progress> ", export_html_escape(output$label %||% ""), "</div>"))
  }
  if (kind == "error") {
    return(paste0("<pre class=\"output-error\">",
                  export_html_escape(output$message), "</pre>"))
  }
  paste0("<pre>", export_html_escape(export_output_plain(output, artifact_dir)), "</pre>")
}

export_copy_artifact <- function(output, artifact_dir, files_dir) {
  if (!is.list(output)) return(NULL)
  kind <- export_scalar_chr(output$kind)
  if (!(kind %in% c("image", "media")) ||
      !export_artifact_ok(output$artifact, artifact_dir)) return(NULL)
  dir.create(files_dir, recursive = TRUE, showWarnings = FALSE)
  dest <- file.path(files_dir, basename(output$artifact))
  if (!file.exists(dest)) file.copy(file.path(artifact_dir, output$artifact), dest,
                                     overwrite = TRUE)
  basename(dest)
}

export_output_markdown <- function(output, artifact_dir, files_dir) {
  if (!is.list(output)) return(character())
  kind <- export_scalar_chr(output$kind)
  if (kind == "markdown") return(export_scalar_chr(output$text, ""))
  if (kind %in% c("text", "error", "widget")) {
    return(c("```", export_output_plain(output, artifact_dir), "```"))
  }
  if (kind == "table") {
    cols <- as.character(unlist(output$columns %||% character(), use.names = FALSE))
    rows <- export_table_rows(output)
    if (!length(cols) && length(rows)) cols <- paste0("V", seq_along(rows[[1L]]))
    return(c(paste0("| ", paste(cols, collapse = " | "), " |"),
             paste0("| ", paste(rep("---", length(cols)), collapse = " | "), " |"),
             vapply(rows, function(row) paste0("| ", paste(row, collapse = " | "), " |"), "")))
  }
  if (kind == "image" || kind == "media") {
    copied <- export_copy_artifact(output, artifact_dir, files_dir)
    if (is.null(copied)) return(c("[artifact unavailable]"))
    if (kind == "image" || identical(output$media_type, "image")) {
      return(paste0("![", export_scalar_chr(output$alt), "](",
                    basename(files_dir), "/", copied, ")"))
    }
    media_type <- export_scalar_chr(output$media_type, "media")
    if (identical(media_type, "pdf")) {
      return(paste0("[PDF](", basename(files_dir), "/", copied, ")"))
    }
    if (media_type %in% c("audio", "video")) {
      return(paste0("<", media_type, " controls src=\"",
                    basename(files_dir), "/", copied, "\"></", media_type, ">"))
    }
    return(paste0("[", media_type, "](",
                  basename(files_dir), "/", copied, ")"))
  }
  c("```", export_output_plain(output, artifact_dir), "```")
}

export_cell_by_id <- function(state, id) {
  cells <- state$cells %||% list()
  hit <- vapply(cells, function(cell) identical(cell$id, id), FALSE)
  if (!any(hit)) return(NULL)
  cells[[which(hit)[[1L]]]]
}

export_app <- function(state) {
  app <- state$app %||% state$metadata$app %||% list()
  if (!is.list(app)) app <- list()
  list(layout = export_scalar_chr(app$layout, "vertical"),
       width = export_scalar_chr(app$width, "medium"),
       include_code = isTRUE(app$include_code))
}

export_headless_session <- function(nb) {
  artifact_dir <- tempfile("alder-export-artifacts-")
  cache_dir <- tempfile("alder-export-cache-")
  dir.create(artifact_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
  worker <- NULL
  session <- NULL
  cleanup <- function() {
    if (!is.null(session)) try(session$stop(), silent = TRUE)
    if (!is.null(worker) && worker$alive()) try(worker$kill(), silent = TRUE)
    if (dir.exists(artifact_dir)) unlink(artifact_dir, recursive = TRUE, force = TRUE)
    if (dir.exists(cache_dir)) unlink(cache_dir, recursive = TRUE, force = TRUE)
  }
  app_dir <- system.file("app", package = "alder", mustWork = TRUE)
  worker_script <- system.file("worker", "worker.R", package = "alder", mustWork = TRUE)
  worker <- tryCatch(.spawn_worker(worker_script, app_dir, artifact_dir, cache_dir),
                     error = function(e) {
                       cleanup()
                       stop(e)
                     })
  booted <- FALSE
  deadline <- Sys.time() + 15
  while (!booted && Sys.time() < deadline) {
    if (!worker$alive()) break
    done <- FALSE
    worker$send("ping", on_response = function(context, response) done <<- TRUE)
    later::run_now(0.05)
    booted <- done
  }
  if (!booted) {
    cleanup()
    stop("worker failed to start")
  }
  disk <- if (!is.null(nb$path) && is.character(nb$path) &&
              length(nb$path) == 1L && file.exists(nb$path)) {
    list(exists = TRUE,
         bytes = readBin(nb$path, "raw", n = file.info(nb$path)$size))
  } else list(exists = FALSE, bytes = raw())
  session <- tryCatch(
    Session$new(nb, worker, execution_mode = "automatic", run_on_startup = TRUE,
                disk_version = disk),
    error = function(e) {
      cleanup()
      stop(e)
    })
  list(session = session, worker = worker, artifact_dir = artifact_dir,
       cache_dir = cache_dir, cleanup = cleanup)
}

export_wait_idle <- function(session, timeout = 300) {
  deadline <- Sys.time() + timeout
  repeat {
    later::run_now(0.05)
    state <- session$state()
    running <- vapply(state$cells %||% list(), function(cell)
      identical(cell$status, "running"), FALSE)
    if (!isTRUE(state$runtime$busy) && !any(running)) return(state)
    if (Sys.time() >= deadline) {
      unfinished <- vapply((state$cells %||% list())[running],
                           function(cell) cell$id, "")
      stop("export timed out with ", sum(running), " unfinished cells: ",
           paste(unfinished, collapse = ", "))
    }
    Sys.sleep(0.001)
  }
}

export_html <- function(state, artifact_dir, include_code = FALSE) {
  css_path <- system.file("app", "static", "style.css", package = "alder",
                          mustWork = TRUE)
  css <- paste(readLines(css_path, warn = FALSE), collapse = "\n")
  app <- export_app(state)
  width <- paste0("notebook width-", app$width)
  sections <- vapply(state$cells %||% list(), function(cell) {
    source <- if (isTRUE(include_code) && !isTRUE(cell$options$hide_code) &&
                  !identical(cell$type, "markdown")) {
      paste0("<pre class=\"cell-source\">", export_html_escape(
        paste(cell$body %||% character(), collapse = "\n")), "</pre>")
    } else ""
    outputs <- paste(vapply(cell$outputs %||% list(), export_output_html, "",
                            artifact_dir = artifact_dir), collapse = "")
    paste0("<section class=\"cell ", export_html_escape(cell$status %||% "idle"),
           "\" data-cell=\"", export_html_escape(cell$id), "\">",
           source, "<div class=\"outputs\">", outputs,
           "</div></section>")
  }, "")
  paste0("<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>",
         export_html_escape(state$metadata$title %||% "alder notebook"),
         "</title><style>", css,
         "</style></head><body class=\"", width, "\"><main class=\"notebook\">",
         paste(sections, collapse = "\n"), "</main></body></html>\n")
}

export_html_file <- function(state, artifact_dir, out, include_code) {
  writeLines(export_html(state, artifact_dir, include_code), out, useBytes = TRUE)
}

export_markdown_file <- function(state, artifact_dir, out, include_code) {
  files_dir <- file.path(dirname(out), paste0(tools::file_path_sans_ext(basename(out)), "_files"))
  lines <- character()
  for (cell in state$cells %||% list()) {
    if (identical(cell$type, "markdown")) {
      lines <- c(lines, export_markdown_body(cell$body %||% character()), "")
    } else if (isTRUE(include_code)) {
      lines <- c(lines, "```r", cell$body %||% character(), "```", "")
    }
    for (output in cell$outputs %||% list()) {
      lines <- c(lines, export_output_markdown(output, artifact_dir, files_dir), "")
    }
  }
  writeLines(lines, out, useBytes = TRUE)
}

export_script_file <- function(state, out, source_path) {
  ids <- state$topo %||% vapply(state$cells %||% list(), function(cell) cell$id, "")
  cells <- lapply(ids, export_cell_by_id, state = state)
  lines <- c(paste0("# Generated by alder from ", basename(source_path)),
             "# This file is a static export; edit the notebook instead.", "")
  for (cell in cells) {
    if (is.null(cell)) next
    if (identical(cell$type, "markdown")) {
      lines <- c(lines, paste0("# ", export_markdown_body(cell$body %||% character())), "")
    } else {
      lines <- c(lines, cell$body %||% character(), "")
    }
  }
  writeLines(lines, out, useBytes = TRUE)
}

export_ipynb_source <- function(body) {
  if (!length(body)) return(character())
  text <- paste(body, collapse = "\n")
  text <- paste0(text, "\n")
  I(c(text))
}

export_ipynb_output <- function(output, artifact_dir) {
  if (!is.list(output)) return(NULL)
  kind <- export_scalar_chr(output$kind)
  if (kind == "text") {
    return(list(output_type = "execute_result", execution_count = NULL,
                data = list(`text/plain` = I(c(paste0(export_scalar_chr(output$text), "\n")))),
                metadata = list()))
  }
  if (kind == "table") {
    return(list(output_type = "execute_result", execution_count = NULL,
                data = list(`text/plain` = I(c(paste0(export_table_text(output), "\n")))),
                metadata = list()))
  }
  if (kind == "markdown") {
    return(list(output_type = "display_data",
                data = list(`text/html` = I(c(export_scalar_chr(output$html), "\n"))),
                metadata = list()))
  }
  if (kind == "image" || kind == "media") {
    mime <- if (kind == "image") "image/png" else export_scalar_chr(output$mime)
    uri <- export_artifact_uri(output$artifact, artifact_dir, mime)
    if (!is.null(uri) && startsWith(mime, "image/")) {
      encoded <- sub("^data:[^,]+,", "", uri)
      return(list(output_type = "display_data",
                  data = setNames(list(I(c(encoded))), mime), metadata = list()))
    }
  }
  if (kind == "error") {
    return(list(output_type = "error", ename = "Error",
                evalue = export_scalar_chr(output$message), traceback = character()))
  }
  if (kind == "lazy" && !is.null(output$child)) {
    return(export_ipynb_output(output$child, artifact_dir))
  }
  if (kind == "layout") {
    text <- export_output_plain(output, artifact_dir)
    return(list(output_type = "execute_result", execution_count = NULL,
                data = list(`text/plain` = I(c(paste0(text, "\n")))), metadata = list()))
  }
  list(output_type = "execute_result", execution_count = NULL,
       data = list(`text/plain` = I(c(paste0(export_output_plain(output, artifact_dir), "\n")))),
       metadata = list())
}

export_ipynb_file <- function(state, artifact_dir, out, include_code) {
  cells <- lapply(state$cells %||% list(), function(cell) {
    if (identical(cell$type, "markdown")) {
      list(cell_type = "markdown", metadata = list(),
           source = export_ipynb_source(export_markdown_body(cell$body %||% character())))
    } else {
      outputs <- Filter(Negate(is.null), lapply(cell$outputs %||% list(),
                                                 export_ipynb_output,
                                                 artifact_dir = artifact_dir))
      logs <- if (length(cell$log %||% character())) {
        list(list(output_type = "stream", name = "stdout",
                  text = paste(cell$log, collapse = "\n")))
      } else list()
      alder_meta <- c(list(type = cell$type %||% "code"),
                      cell$options %||% list())
      list(cell_type = "code", execution_count = if (identical(cell$status, "done")) 1L else NULL,
           metadata = if (length(alder_meta)) list(alder = alder_meta) else list(),
           source = export_ipynb_source(cell$body %||% character()),
           outputs = c(logs, outputs))
    }
  })
  alder_md <- state$metadata %||% list()
  notebook <- list(cells = cells, metadata = c(
    list(language_info = list(
      name = "R", version = as.character(getRversion()))),
    if (length(alder_md)) list(alder = alder_md) else list()),
    nbformat = 4L, nbformat_minor = 5L)
  jsonlite::write_json(notebook, out, auto_unbox = TRUE, pretty = TRUE,
                       null = "null", na = "null", force = TRUE)
}

export_qmd_file <- function(state, out, include_code) {
  title <- state$metadata$title %||% NULL
  lines <- c("---", if (!is.null(title)) paste0("title: ", yaml::as.yaml(title)),
             "format: html", "---", "")
  for (cell in state$cells %||% list()) {
    if (identical(cell$type, "markdown")) {
      lines <- c(lines, export_markdown_body(cell$body %||% character()), "")
    } else {
      lines <- c(lines, "```{r}")
      nm <- cell$options$name %||% NULL
      if (!is.null(nm)) lines <- c(lines, paste0("#| label: ", nm))
      if (isTRUE(cell$options$hide_code)) lines <- c(lines, "#| echo: false")
      if (isTRUE(cell$options$disabled)) lines <- c(lines, "#| eval: false")
      lines <- c(lines, cell$body %||% character(), "```", "")
    }
  }
  writeLines(lines, out, useBytes = TRUE)
}

export_session_file <- function(state, out) {
  cells <- lapply(state$cells %||% list(), function(cell) list(
    id = cell$id, name = cell$options$name %||% NULL, type = cell$type,
    body = as.character(cell$body %||% character()), status = cell$status,
    outputs = cell$outputs %||% list()))
  app <- export_app(state)
  jsonlite::write_json(list(version = 1L, path = state$path %||% NULL,
                            etag = state$etag %||% NULL, app = app,
                            cells = cells, variables = state$variables %||% list()),
                       out, auto_unbox = TRUE, pretty = TRUE, null = "null",
                       na = "null", force = TRUE)
}

#' Export a notebook to a static interchange or document format.
#' @param path Path to an alder `.R` notebook.
#' @param format One of `html`, `md`, `script`, `ipynb`, `qmd`, or `session`.
#' @param out Optional output path.
#' @param include_code Include code in document-oriented exports.
#' @return The output path, invisibly.
#' @export
alder_export <- function(path, format = export_formats, out = NULL,
                         include_code = FALSE) {
  format <- tryCatch(match.arg(format, export_formats),
                     error = function(e) alder_abort("export_failed", conditionMessage(e)))
  if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path) ||
      !file.exists(path) || dir.exists(path)) {
    alder_abort("export_failed", paste0("notebook file not found: ", path))
  }
  if (!is.logical(include_code) || length(include_code) != 1L || is.na(include_code)) {
    alder_abort("export_failed", "include_code must be TRUE or FALSE")
  }
  path <- normalizePath(path, mustWork = TRUE)
  if (is.null(out)) {
    ext <- c(html = "html", md = "md", script = "R", ipynb = "ipynb",
             qmd = "qmd", session = "alder-session.json")[[format]]
    out <- paste0(file.path(dirname(path), tools::file_path_sans_ext(basename(path))),
                  ".", ext)
    # A script export has the same extension as its source. Never destroy the
    # input notebook when the caller omitted an output path.
    if (identical(normalizePath(out, mustWork = FALSE), path)) {
      out <- paste0(file.path(dirname(path),
                              tools::file_path_sans_ext(basename(path))),
                    "-export.", ext)
    }
  }
  if (!is.character(out) || length(out) != 1L || is.na(out) || !nzchar(out) ||
      dir.exists(out)) {
    alder_abort("export_failed", "output path must be a writable file path")
  }
  out <- normalizePath(out, mustWork = FALSE)
  if (!dir.exists(dirname(out))) {
    alder_abort("export_failed", paste0("output directory does not exist: ", dirname(out)))
  }
  nb <- tryCatch(read_notebook(path), error = function(e)
    alder_abort("export_failed", conditionMessage(e)))
  boot <- tryCatch(export_headless_session(nb), error = function(e)
    alder_abort("export_failed", conditionMessage(e)))
  on.exit(boot$cleanup(), add = TRUE)
  state <- tryCatch(export_wait_idle(boot$session), error = function(e)
    alder_abort("export_failed", conditionMessage(e)))
  tryCatch({
    switch(format,
           html = export_html_file(state, boot$artifact_dir, out, include_code),
           md = export_markdown_file(state, boot$artifact_dir, out, include_code),
           script = export_script_file(state, out, path),
           ipynb = export_ipynb_file(state, boot$artifact_dir, out, include_code),
           qmd = export_qmd_file(state, out, include_code),
           session = export_session_file(state, out))
    if (!file.exists(out)) stop("export did not create an output file")
  }, error = function(e) alder_abort("export_failed", conditionMessage(e)))
  invisible(out)
}

export_analysis <- function(nb) {
  analyzed <- lapply(nb$cells, function(cell) {
    if (identical(cell$type, "markdown")) {
      list(id = cell$id, type = cell$type, defs = character(), refs = character(),
           self_refs = character(), locals = character(), barrier = FALSE,
           diagnostics = list(), error = NULL)
    } else if (identical(cell$type, "sql") && is.null(parse_sql_cell(cell$body))) {
      list(id = cell$id, type = cell$type, defs = character(), refs = character(),
           self_refs = character(), locals = character(), barrier = FALSE,
           diagnostics = list(list(level = "error", code = "sql-cell-shape",
                                   message = sql_cell_shape(), symbol = NULL)),
           error = NULL)
    } else {
      p <- cell_defs_refs(cell$body)
      if (identical(cell$type, "sql")) {
        q <- parse_sql_cell(cell$body)
        if (!is.null(q)) {
          p$refs <- unique(c(p$refs %||% character(),
                             sql_query_identifiers(q$query)))
        }
      }
      p$id <- cell$id
      p$type <- cell$type
      p
    }
  })
  dag <- build_dag(analyzed)
  list(cells = analyzed, dag = dag)
}

export_cell_line <- function(nb, id) {
  lines <- nb_body_lines(nb, id)
  if (length(lines)) return(as.integer(lines[[1L]]))
  cursor <- length(nb$header_records)
  for (cell in nb$cells) {
    cursor <- cursor + 1L
    if (identical(cell$id, id)) return(as.integer(cursor))
    cursor <- cursor + length(cell$records) - 1L
  }
  1L
}

export_diagnostics <- function(nb, analysis) {
  rows <- list()
  add <- function(id, level, code, message) {
    rows[[length(rows) + 1L]] <<- data.frame(
      path = nb$path %||% NA_character_, line = export_cell_line(nb, id),
      level = as.character(level), code = as.character(code),
      message = as.character(message), stringsAsFactors = FALSE)
  }
  for (i in seq_along(nb$cells)) {
    id <- nb$cells[[i]]$id
    p <- analysis$cells[[i]]
    if (!is.null(p$error)) add(id, "error", "syntax-error", p$error)
    for (diag in p$diagnostics %||% list()) {
      add(id, diag$level %||% "error", diag$code %||% "diagnostic",
          diag$message %||% "")
    }
  }
  for (name in names(analysis$dag$duplicates %||% list())) {
    for (id in analysis$dag$duplicates[[name]]) {
      add(id, "error", "duplicate-definition",
          paste0("duplicate definition of ", name))
    }
  }
  if (length(analysis$dag$cycles %||% character())) {
    ids <- unique(as.character(unlist(analysis$dag$cycles, use.names = FALSE)))
    ids <- ids[ids %in% vapply(nb$cells, function(cell) cell$id, "")]
    for (id in ids) add(id, "error", "dependency-cycle", "dependency cycle")
  }
  if (!length(rows)) {
    return(data.frame(path = character(), line = integer(), level = character(),
                      code = character(), message = character(),
                      stringsAsFactors = FALSE))
  }
  do.call(rbind, rows)
}

#' Check an alder notebook and print diagnostics.
#' @param path Path to an alder notebook.
#' @return A data frame of diagnostics, invisibly.
#' @export
alder_check <- function(path) {
  if (!is.character(path) || length(path) != 1L || is.na(path) || !file.exists(path)) {
    stop("notebook file not found: ", path, call. = FALSE)
  }
  nb <- read_notebook(path)
  diagnostics <- export_diagnostics(nb, export_analysis(nb))
  if (nrow(diagnostics)) {
    apply(diagnostics, 1L, function(row) cat(
      paste0(row[["path"]], ":", row[["line"]], ": ", row[["level"]], ": ",
             row[["code"]], ": ", row[["message"]], "\n")))
  }
  errors <- sum(diagnostics$level == "error")
  if (errors) stop("alder_check found ", errors, " error diagnostics", call. = FALSE)
  invisible(diagnostics)
}

export_source_graph_or_stop <- function(nb) {
  analysis <- export_analysis(nb)
  diagnostics <- export_diagnostics(nb, analysis)
  if (any(diagnostics$level == "error")) {
    msg <- paste(diagnostics$message[diagnostics$level == "error"], collapse = "\n")
    alder_abort("graph_invalid", msg, messages = diagnostics$message)
  }
  topo <- topo_order(analysis$dag$edges,
                     vapply(nb$cells, function(cell) cell$id, ""))
  if (is.null(topo)) alder_abort("graph_invalid", "cannot run: dependency cycle")
  list(analysis = analysis, topo = topo)
}

#' Evaluate an alder notebook in topological order.
#' @param path Path to an alder notebook.
#' @param env Environment receiving definitions.
#' @return The evaluation environment, invisibly.
#' @export
alder_source <- function(path, env = parent.frame()) {
  if (!is.environment(env)) stop("env must be an environment", call. = FALSE)
  if (!is.character(path) || length(path) != 1L || is.na(path) || !file.exists(path)) {
    stop("notebook file not found: ", path, call. = FALSE)
  }
  nb <- read_notebook(path)
  graph <- export_source_graph_or_stop(nb)
  for (id in graph$topo) {
    cell <- nb_cell(nb, id)
    if (is.null(cell) || identical(cell$type, "markdown")) next
    exprs <- tryCatch(parse(text = paste(cell$body, collapse = "\n")),
                      error = function(e) stop(id, ": ", conditionMessage(e), call. = FALSE))
    tryCatch(eval(exprs, envir = env),
             error = function(e) stop(id, ": ", conditionMessage(e), call. = FALSE))
  }
  invisible(env)
}

#' Run cells marked `#| test: true` with testthat.
#' @param path Path to an alder notebook.
#' @return testthat result records, invisibly.
#' @export
alder_test <- function(path) {
  if (!requireNamespace("testthat", quietly = TRUE)) {
    stop("alder_test() needs the testthat package", call. = FALSE)
  }
  env <- new.env(parent = globalenv())
  alder_source(path, env)
  nb <- read_notebook(path)
  tests <- Filter(function(cell) isTRUE(cell$options$test), nb$cells)
  if (!length(tests)) return(invisible(list()))
  results <- vector("list", length(tests))
  for (i in seq_along(tests)) {
    cell <- tests[[i]]
    key <- paste0(".alder_test_", Sys.getpid(), "_", as.integer(stats::runif(1, 1, 1e9)))
    fn <- local({
      c <- cell
      e <- env
      function() {
        exprs <- parse(text = paste(c$body %||% character(), collapse = "\n"))
        eval(exprs, envir = e)
      }
    })
    assign(key, fn, envir = .GlobalEnv)
    test_file <- tempfile("alder-test-", fileext = ".R")
    on.exit({
      if (exists(key, envir = .GlobalEnv, inherits = FALSE)) rm(list = key, envir = .GlobalEnv)
      if (file.exists(test_file)) unlink(test_file)
    }, add = TRUE)
    name <- cell$options$name %||% cell$id
    literal <- function(value) paste(utils::capture.output(dput(value)),
                                     collapse = "")
    lines <- c("testthat::test_that(", paste0("  ", literal(as.character(name)), ", {"),
               paste0("    get(", literal(key), ", envir = .GlobalEnv)()"), "  })")
    writeLines(lines, test_file, useBytes = TRUE)
    results[[i]] <- testthat::test_file(test_file, reporter = "silent")
    rm(list = key, envir = .GlobalEnv)
  }
  combined <- unlist(results, recursive = FALSE)
  class(combined) <- "testthat_results"
  invisible(combined)
}
