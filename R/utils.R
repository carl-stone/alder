# Package-internal helpers shared across R/ modules.
#
`%||%` <- function(a, b) if (is.null(a)) b else a

# A source revision is deliberately narrower than an arbitrary R number.  It
# crosses the HTTP and MCP optimistic-concurrency boundaries and is later
# compared to an integer stored in Session state, so accepting a fractional or
# out-of-range double here would silently change its meaning on coercion.
alder_is_revision <- function(value) {
  is.numeric(value) && length(value) == 1L && !is.na(value) &&
    is.finite(value) && value >= 0 && value <= .Machine$integer.max &&
    value == floor(value)
}

#' @noRd
alder_abort <- function(code, message, messages = NULL, token = NULL,
                        result = NULL, state = NULL) {
  cond <- structure(
    list(message = message, code = code, messages = messages,
         token = token, result = result, state = state, call = NULL),
    class = c("alder_error", "error", "condition")
  )
  stop(cond)
}

# Return a stable identity for an existing regular filesystem object when the
# platform exposes one.  Normalized paths catch lexical and symlink aliases;
# device/inode catches hard links which necessarily retain distinct paths.
# `fs` supplies these fields on the platforms Alder supports.  The defensive
# fallback deliberately returns NULL rather than guessing from mutable fields
# such as size or mtime.
alder_file_identity <- function(path) {
  if (!is.character(path) || length(path) != 1L || is.na(path) ||
      !nzchar(path) || !file.exists(path) || dir.exists(path)) return(NULL)
  info <- tryCatch(fs::file_info(path), error = function(e) NULL)
  if (is.null(info) || nrow(info) != 1L ||
      !all(c("device_id", "inode") %in% names(info))) return(NULL)
  device <- info$device_id[[1L]]
  inode <- info$inode[[1L]]
  if (is.na(device) || is.na(inode)) return(NULL)
  paste(as.character(device), as.character(inode), sep = ":")
}

# Resolve an output path through an existing parent directory.  This preserves
# a non-existing final filename while resolving symlinked directory aliases.
alder_output_path_normalize <- function(path) {
  parent <- dirname(path)
  if (!dir.exists(parent)) return(normalizePath(path, mustWork = FALSE))
  parent <- normalizePath(parent, mustWork = TRUE)
  candidate <- file.path(parent, basename(path))
  if (file.exists(candidate) && !dir.exists(candidate)) {
    return(normalizePath(candidate, mustWork = TRUE))
  }
  candidate
}

# Input/output equality is a data-safety boundary, not a convenience check:
# an explicit output must never be another spelling of the input.  This is
# intentionally evaluated before parsing or executing a notebook.
alder_same_file <- function(input, output) {
  if (!file.exists(input) || dir.exists(input)) return(FALSE)
  input <- normalizePath(input, mustWork = TRUE)
  output <- alder_output_path_normalize(output)
  if (identical(input, output)) return(TRUE)
  if (!file.exists(output) || dir.exists(output)) return(FALSE)
  input_id <- alder_file_identity(input)
  output_id <- alder_file_identity(output)
  !is.null(input_id) && !is.null(output_id) && identical(input_id, output_id)
}

# Allocate a same-directory staging file.  A same-filesystem rename is the
# replacement boundary, so serializers never touch an existing destination.
alder_output_stage <- function(out, pattern = ".alder-stage-") {
  tempfile(pattern = pattern, tmpdir = dirname(out))
}

alder_output_replace <- function(stage, out) {
  if (!file.exists(stage) || dir.exists(stage)) {
    stop("staged output file was not created", call. = FALSE)
  }
  # fs::file_move uses the platform's same-filesystem rename primitive.  It
  # either replaces the destination or reports an error without a partial
  # serializer write to that destination.
  fs::file_move(stage, out)
  invisible(out)
}

# Markdown output goes through a strict whitelist sanitizer because it is
# rendered into the page. Allowed tags keep only safe attributes; links and
# images accept relative URLs plus http/https (and mailto for links);
# everything else is dropped or flattened to text, and dangerous elements
# (script/style/iframe/object/embed/svg/math) are removed entirely.

MD_ALLOWED_TAGS <- c("p", "br", "hr", "em", "strong", "blockquote",
                     "ul", "ol", "li", "pre", "code", "h1", "h2", "h3",
                     "h4", "h5", "h6", "a", "img")
MD_DROPPED_TAGS <- c("script", "style", "iframe", "object", "embed",
                     "svg", "math", "noscript", "template")

md_url_safe <- function(u, image = FALSE) {
  if (length(u) != 1L || is.na(u) || !nzchar(u)) return(FALSE)
  # Raw controls and backslashes are never acceptable in a URL.
  if (any(utf8ToInt(u) < 32L)) return(FALSE)
  if (grepl("\\\\", u)) return(FALSE)
  dec <- tryCatch(utils::URLdecode(u), error = function(e) "")
  if (!nzchar(dec)) return(FALSE)
  # Browsers strip tab/newline/CR from URLs and trim surrounding spaces
  # before resolving the scheme, so any decoded control or backslash — and
  # any leading/trailing space — must fail closed, never be ignored.
  if (any(utf8ToInt(dec) < 32L)) return(FALSE)
  if (grepl("\\\\", dec)) return(FALSE)
  dec <- trimws(dec, whitespace = "[ \t\r\n\v\f]")
  if (!nzchar(dec)) return(FALSE)
  # Scheme-relative URLs (after normalization) are always rejected.
  if (startsWith(dec, "//")) return(FALSE)
  dl <- tolower(dec)
  if (grepl("^[a-z][a-z0-9+.-]*:", dl)) {
    scheme <- sub(":.*$", "", dl)
    if (!scheme %in% if (image) c("http", "https") else c("http", "https", "mailto")) {
      return(FALSE)
    }
  }
  TRUE
}

md_clean_text_attr <- function(v) {
  is.character(v) && length(v) == 1L && !any(utf8ToInt(v) < 32L)
}

md_attr_ok <- function(tag, name, value) {
  if (tag == "a" && name == "href") return(md_url_safe(value, FALSE))
  if (tag == "img" && name == "src") return(md_url_safe(value, TRUE))
  if (name %in% c("title", "alt")) return(md_clean_text_attr(value))
  if (tag == "ol" && name == "start") return(grepl("^[1-9][0-9]*$", value))
  if (tag == "code" && name == "class") return(grepl("^language-[a-zA-Z0-9_-]+$", value))
  FALSE
}

md_sanitize_node <- function(node, allowed_tags = MD_ALLOWED_TAGS,
                             unwrap_unknown = FALSE) {
  tag <- xml2::xml_name(node)
  if (tag %in% MD_DROPPED_TAGS) {
    xml2::xml_remove(node)
    return(invisible(NULL))
  }
  if (tag %in% allowed_tags) {
    at <- xml2::xml_attrs(node)
    keep <- character()
    for (nm in names(at)) {
      if (!is.null(at[[nm]]) && is.na(at[[nm]])) next
      if (md_attr_ok(tag, nm, at[[nm]])) keep[[nm]] <- at[[nm]]
    }
    if (length(names(at))) {
      for (nm in names(at)) {
        if (!(nm %in% names(keep))) xml2::xml_set_attr(node, nm, NULL)
      }
      if (length(keep)) xml2::xml_set_attrs(node, keep)
    }
    for (ch in xml2::xml_children(node)) {
      md_sanitize_node(ch, allowed_tags, unwrap_unknown)
    }
  } else if (unwrap_unknown) {
    # Sanitize descendants before unwrapping, and remove the unknown element
    # itself so none of its attributes or element behavior enter trusted HTML.
    for (ch in xml2::xml_children(node)) {
      md_sanitize_node(ch, allowed_tags, unwrap_unknown)
    }
    for (ch in xml2::xml_contents(node)) {
      xml2::xml_add_sibling(node, ch, .where = "before", .copy = TRUE)
    }
    xml2::xml_remove(node)
  } else {
    # Unknown wrappers retain only inert text. Setting text alone can leave
    # descendant elements and wrapper attributes intact in libxml2.
    for (ch in xml2::xml_children(node)) {
      md_sanitize_node(ch, allowed_tags, unwrap_unknown)
    }
    text <- xml2::xml_text(node)
    xml2::xml_remove(xml2::xml_contents(node))
    for (nm in names(xml2::xml_attrs(node))) {
      xml2::xml_set_attr(node, nm, NULL)
    }
    xml2::xml_set_text(node, text)
  }
  invisible(NULL)
}

sanitize_markdown_html <- function(html, allowed_tags = MD_ALLOWED_TAGS,
                                   unwrap_unknown = FALSE) {
  if (is.null(html) || !nzchar(html)) return("")
  doc <- xml2::read_html(paste0("<div>", html, "</div>"),
                         options = c("RECOVER", "NOERROR", "NONET"))
  div <- xml2::xml_find_first(doc, "//div")
  for (ch in xml2::xml_children(div)) {
    md_sanitize_node(ch, allowed_tags, unwrap_unknown)
  }
  kids <- if (unwrap_unknown) xml2::xml_contents(div) else xml2::xml_children(div)
  if (!length(kids)) return("")
  paste0(vapply(kids, function(k) as.character(k), character(1)), collapse = "")
}

# Remove the R comment prefix from a Markdown cell without changing the
# Markdown that follows it. This is the canonical source normalization used by
# both rendering and document-outline extraction.
markdown_source_lines <- function(body) {
  vapply(body, function(ln) {
    if (grepl("^\\s*#", ln)) {
      sub("^(\\s*)#+ ?", "\\1", ln)
    } else {
      ln
    }
  }, character(1))
}

# Render a Markdown cell body (comment lines) to sanitized HTML. Ensures
# the whole fragment is a single element so the serializer emits the root
# content verbatim rather than planner-inserted wrapper markup.
render_markdown_fragment <- function(body) {
  lines <- markdown_source_lines(body)
  html <- commonmark::markdown_html(paste0(lines, collapse = "\n"),
                                    extensions = FALSE)
  sanitize_markdown_html(html)
}

# The output record for a Markdown cell: locally rendered, always "done".
render_markdown_cell_output <- function(body) {
  list(kind = "markdown",
       html = render_markdown_fragment(body),
       text = paste(body, collapse = "\n"))
}

# Keep the original LSP payload intact while providing safely rendered help
# for its standard Markdown, plaintext, and MarkedString content shapes.
lsp_hover_html <- function(contents) {
  render <- function(value) {
    if (is.null(value)) return("")
    if (is.character(value)) {
      return(commonmark::markdown_html(paste(value, collapse = "\n"),
                                       extensions = "table"))
    }
    if (!is.list(value)) return("")
    if (is.character(value$value)) {
      text <- paste(value$value, collapse = "\n")
      if (identical(value$kind, "plaintext") || !is.null(value$language)) {
        return(paste0("<pre><code>", export_html_escape(text), "</code></pre>"))
      }
      return(commonmark::markdown_html(text, extensions = "table"))
    }
    paste(vapply(value, render, ""), collapse = "\n")
  }
  html <- sanitize_markdown_html(render(contents),
    allowed_tags = c(MD_ALLOWED_TAGS, "div", "span", "table", "thead",
                     "tbody", "tfoot", "tr", "th", "td"),
    unwrap_unknown = TRUE)
  if (!nzchar(html)) return("")
  doc <- xml2::read_html(paste0("<div>", html, "</div>"),
                         options = c("RECOVER", "NOERROR", "NONET"))
  # R's native help uses relative links such as sum.html. Alder does not serve
  # that help tree; retain their labels without creating a misleading 404 link.
  for (link in xml2::xml_find_all(doc, "//a[@href]")) {
    href <- xml2::xml_attr(link, "href")
    if (!grepl("^(https?|mailto):", href, ignore.case = TRUE)) {
      xml2::xml_set_name(link, "span")
      xml2::xml_set_attr(link, "href", NULL)
    }
  }
  nodes <- xml2::xml_contents(xml2::xml_find_first(doc, "//div"))
  paste0(vapply(nodes, as.character, ""), collapse = "")
}

# Client-visible md5 change token over the exact serialized notebook.
notebook_etag <- function(nb) {
  tmp <- tempfile()
  write_notebook(nb, tmp)
  h <- tools::md5sum(tmp)
  unlink(tmp)
  unname(h)
}
