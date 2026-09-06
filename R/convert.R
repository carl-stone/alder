convert_fail <- function(message) alder_abort("convert_failed", as.character(message))

convert_read_lines <- function(path) {
  if (!is.character(path) || length(path) != 1L || is.na(path) || !file.exists(path) ||
      dir.exists(path)) convert_fail(paste0("input file not found: ", path))
  size <- file.info(path)$size
  bytes <- readBin(path, "raw", n = size)
  if (0L %in% as.integer(bytes)) convert_fail("input contains an embedded NUL")
  text <- rawToChar(bytes)
  if (!validUTF8(text)) convert_fail(paste0("input is not valid UTF-8: ", path))
  text <- gsub("\\r\\n", "\n", text, fixed = TRUE)
  text <- gsub("\\r", "\n", text, fixed = TRUE)
  lines <- strsplit(text, "\n", fixed = TRUE)[[1L]]
  if (length(lines) && !nzchar(lines[[length(lines)]]) &&
      (grepl("\n$", text, fixed = FALSE))) lines <- lines[-length(lines)]
  lines
}

convert_markdown_body <- function(lines) {
  if (!length(lines)) return(character())
  vapply(lines, function(line) {
    if (!nzchar(line)) "" else paste0("# ", line)
  }, character(1))
}

convert_apply_metadata <- function(nb, metadata) {
  if (!is.list(metadata) || !length(metadata)) return(nb)
  for (key in names(metadata)) {
    if (!nzchar(key)) next
    nb <- tryCatch(nb_set_metadata(nb, key, metadata[[key]]),
                   error = function(e) convert_fail(conditionMessage(e)))
  }
  nb
}

convert_front_matter <- function(lines) {
  if (!length(lines) || !identical(trimws(lines[[1L]]), "---")) {
    return(list(metadata = list(), start = 1L))
  }
  close <- which(seq_along(lines) > 1L & trimws(lines) %in% c("---", "..."))
  if (!length(close)) convert_fail("YAML front matter is not closed")
  close <- close[[1L]]
  interior <- if (close > 2L) lines[seq.int(2L, close - 1L)] else character()
  yaml_text <- paste(interior, collapse = "\n")
  metadata <- tryCatch(yaml::yaml.load(yaml_text, eval.expr = FALSE),
                       error = function(e) convert_fail(
                         paste0("malformed YAML front matter: ", conditionMessage(e))))
  if (is.null(metadata)) metadata <- list()
  if (!is.list(metadata) || is.null(names(metadata))) {
    convert_fail("YAML front matter must be a named mapping")
  }
  list(metadata = metadata, start = close + 1L)
}

convert_ipynb_source_lines <- function(source) {
  if (is.null(source)) return(character())
  if (is.list(source)) source <- unlist(source, use.names = FALSE)
  if (!is.character(source)) convert_fail("ipynb cell source must be text")
  text <- if (length(source) <= 1L) {
    paste(source, collapse = "")
  } else {
    out <- source[[1L]]
    for (part in source[-1L]) {
      if (!endsWith(out, "\n")) out <- paste0(out, "\n")
      out <- paste0(out, part)
    }
    out
  }
  text <- gsub("\r", "\n", text, fixed = TRUE)
  lines <- strsplit(text, "\n", fixed = TRUE)[[1L]]
  if (length(lines) && !nzchar(lines[[length(lines)]]) &&
      grepl("\n$", text, fixed = TRUE)) lines <- lines[-length(lines)]
  lines
}

convert_ipynb_metadata <- function(metadata) {
  if (is.null(metadata) || !is.list(metadata)) return(list())
  out <- list()
  md <- if (is.list(metadata$alder %||% NULL)) metadata$alder else metadata
  if (!is.null(md$title)) out$title <- as.character(md$title)
  if (!is.null(md$app) && is.list(md$app)) out$app <- md$app
  if (!is.null(md$packages)) out$packages <- md$packages
  if (!is.null(md$snapshot)) out$snapshot <- md$snapshot
  if (!is.null(md$runtime) && is.list(md$runtime)) out$runtime <- md$runtime
  out
}

convert_from_ipynb <- function(path) {
  obj <- tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE),
                  error = function(e) convert_fail(
                    paste0("malformed ipynb JSON: ", conditionMessage(e))))
  if (!is.list(obj) || is.null(obj$cells) || !is.list(obj$cells)) {
    convert_fail("ipynb must contain a cells array")
  }
  nb <- parse_notebook_lines(path, character())
  nb <- convert_apply_metadata(nb, convert_ipynb_metadata(obj$metadata))
  for (raw_cell in obj$cells) {
    if (!is.list(raw_cell) || is.null(raw_cell$cell_type)) {
      convert_fail("ipynb cell is missing cell_type")
    }
    type <- as.character(raw_cell$cell_type)[[1L]]
    source <- convert_ipynb_source_lines(raw_cell$source %||% character())
    if (identical(type, "markdown")) {
      nb <- nb_add_cell(nb, convert_markdown_body(source), "markdown")
    } else if (identical(type, "code")) {
      md <- raw_cell$metadata %||% list()
      # Legacy `metadata.alder.type = sql` is intentionally imported as an
      # ordinary R cell. Alder has no dedicated SQL cell surface; the source
      # remains byte-visible and users can migrate it to explicit DBI code.
      nb <- nb_add_cell(nb, source, "code")
      if (is.list(md) && !is.null(md$alder) && is.list(md$alder)) {
        for (key in names(md$alder)) {
          if (identical(key, "type")) next
          nb <- tryCatch(nb_set_cell_option(nb, nb$cells[[length(nb$cells)]]$id,
                                            key, md$alder[[key]]),
                         error = function(e) convert_fail(conditionMessage(e)))
        }
      }
    } else {
      convert_fail(paste0("unsupported ipynb cell type: ", type))
    }
  }
  nb
}

convert_chunk_header <- function(header) {
  inner <- trimws(sub("^```\\{", "", sub("\\}\\s*$", "", header)))
  if (!nzchar(inner)) convert_fail("empty fenced chunk header")
  # The language is the first token; comma-separated values after it are
  # Quarto/R Markdown chunk options. A label may be the first bare token.
  lang <- sub("[,[:space:]].*$", "", inner)
  rest <- trimws(sub(paste0("^", lang), "", inner))
  tokens <- if (nzchar(rest)) strsplit(sub("^,\\s*", "", rest), ",", fixed = FALSE)[[1L]] else character()
  tokens <- trimws(tokens)
  label <- NULL
  if (length(tokens) && nzchar(tokens[[1L]]) && !grepl("=|:", tokens[[1L]])) {
    label <- tokens[[1L]]
    tokens <- tokens[-1L]
  }
  options <- list()
  for (token in tokens) {
    if (!nzchar(token)) next
    m <- regexec("^\\s*([A-Za-z][A-Za-z0-9_.-]*)\\s*(?:=|:)\\s*(.*?)\\s*$",
                 token, perl = TRUE)
    mm <- regmatches(token, m)[[1L]]
    if (length(mm) != 3L) {
      message("alder_convert: dropping unsupported chunk option ", token)
      next
    }
    value <- trimws(mm[[3L]])
    if (grepl("^(TRUE|FALSE|true|false)$", value)) {
      value <- tolower(value) == "true"
    } else if (grepl("^(['\"]).*\\1$", value)) {
      value <- substr(value, 2L, nchar(value) - 1L)
    }
    options[[mm[[2L]]]] <- value
  }
  list(language = tolower(lang), label = label, options = options)
}

convert_apply_chunk_options <- function(nb, id, chunk) {
  options <- chunk$options
  if (!is.null(chunk$label)) options$label <- chunk$label
  for (key in names(options)) {
    value <- options[[key]]
    if (identical(key, "label")) {
      if (cell_name_valid(value)) {
        nb <- nb_set_cell_option(nb, id, "name", as.character(value))
      } else {
        message("alder_convert: dropping unsupported option label=", value)
      }
    } else if (identical(key, "echo")) {
      if (identical(value, FALSE)) nb <- nb_set_cell_option(nb, id, "hide_code", TRUE)
      else if (!identical(value, TRUE)) {
        message("alder_convert: dropping unsupported option echo=", value)
      }
    } else if (identical(key, "eval")) {
      if (identical(value, FALSE)) nb <- nb_set_cell_option(nb, id, "disabled", TRUE)
      else if (!identical(value, TRUE)) {
        message("alder_convert: dropping unsupported option eval=", value)
      }
    } else {
      message("alder_convert: dropping unsupported option ", key)
    }
  }
  nb
}

convert_flush_prose <- function(nb, prose) {
  if (!length(prose) || !any(nzchar(trimws(prose)))) return(nb)
  nb_add_cell(nb, convert_markdown_body(prose), "markdown")
}

convert_from_rmd <- function(path) {
  lines <- convert_read_lines(path)
  front <- convert_front_matter(lines)
  nb <- parse_notebook_lines(path, character())
  nb <- convert_apply_metadata(nb, front$metadata)
  i <- front$start
  prose <- character()
  n <- length(lines)
  while (i <= n) {
    header <- lines[[i]]
    if (!grepl("^\\s*```\\{", header)) {
      prose <- c(prose, header)
      i <- i + 1L
      next
    }
    nb <- convert_flush_prose(nb, prose)
    prose <- character()
    following <- if (i < n) seq.int(i + 1L, n) else integer()
    close <- following[grepl("^\\s*```\\s*$", lines[following])]
    if (!length(close)) convert_fail("fenced chunk is not closed")
    close <- close[[1L]]
    chunk <- convert_chunk_header(header)
    body <- if (close > i + 1L) lines[seq.int(i + 1L, close - 1L)] else character()
    if (chunk$language %in% c("r", "rscript", "rmarkdown")) {
      nb <- nb_add_cell(nb, body, "code")
      id <- nb$cells[[length(nb$cells)]]$id
      nb <- convert_apply_chunk_options(nb, id, chunk)
    } else {
      convert_fail(paste0("unsupported fenced chunk language: ", chunk$language))
    }
    i <- close + 1L
  }
  convert_flush_prose(nb, prose)
}

#' Convert an ipynb, Rmd, or qmd file to an alder notebook.
#'
#' @param path Input `.ipynb`, `.Rmd`, or `.qmd` path.
#' @param out Optional output `.R` path. Defaults beside the input and must
#'   not identify the input through a direct, symlink, or hard-link path.
#' @return The output path, invisibly.
#' @examples
#' \dontrun{alder_convert("report.qmd")}
#' @export
alder_convert <- function(path, out = NULL) {
  if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path) ||
      !file.exists(path) || dir.exists(path)) {
    convert_fail(paste0("input file not found: ", path))
  }
  ext <- tolower(tools::file_ext(path))
  if (!ext %in% c("ipynb", "rmd", "qmd")) {
    convert_fail(paste0("cannot convert .", ext,
                       "; supported: .ipynb, .Rmd, .qmd"))
  }
  if (is.null(out)) {
    out <- file.path(dirname(path), paste0(tools::file_path_sans_ext(basename(path)), ".R"))
  }
  if (!is.character(out) || length(out) != 1L || is.na(out) || !nzchar(out) ||
      dir.exists(out) || !dir.exists(dirname(out))) {
    convert_fail("output path must be a writable file path")
  }
  path <- normalizePath(path, mustWork = TRUE)
  out <- alder_output_path_normalize(out)
  if (alder_same_file(path, out)) {
    convert_fail("output path must not refer to input file")
  }
  nb <- tryCatch(
    if (ext == "ipynb") convert_from_ipynb(path) else convert_from_rmd(path),
    alder_error = function(e) stop(e),
    error = function(e) convert_fail(conditionMessage(e)))
  tryCatch({
    stage <- alder_output_stage(out, ".alder-convert-")
    on.exit(unlink(stage, force = TRUE), add = TRUE)
    write_notebook(nb, stage)
    # Verify the staged notebook before the destination is replaced.  This
    # keeps a valid input and a pre-existing output intact on every parse or
    # serialization failure.
    read_notebook(stage)
    alder_output_replace(stage, out)
  }, error = function(e) convert_fail(conditionMessage(e)))
  invisible(out)
}
