# Package-internal helpers shared across R/ modules.
#
# `%||%` is defined once here; other R/ files import it from utils without
# redefining it. The standalone mirrored widget module
# (inst/worker/ui-widgets.R) must NEVER use `%||%` from this file — it is
# sourced in a private worker environment and must stay self-contained.

`%||%` <- function(a, b) if (is.null(a)) b else a

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

# ---------------------------------------------------------------------------
# Markdown rendering (sanitized)
# ---------------------------------------------------------------------------

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

md_sanitize_node <- function(node) {
  tag <- xml2::xml_name(node)
  if (tag %in% MD_DROPPED_TAGS) {
    xml2::xml_remove(node)
    return(invisible(NULL))
  }
  if (tag %in% MD_ALLOWED_TAGS) {
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
    for (ch in xml2::xml_children(node)) md_sanitize_node(ch)
  } else {
    # Unknown element: reduce to its (already recursive) text content.
    xml2::xml_set_text(node, xml2::xml_text(node))
  }
  invisible(NULL)
}

sanitize_markdown_html <- function(html) {
  if (is.null(html) || !nzchar(html)) return("")
  doc <- xml2::read_html(paste0("<div>", html, "</div>"),
                         options = c("RECOVER", "NOERROR", "NONET"))
  div <- xml2::xml_find_first(doc, "//div")
  for (ch in xml2::xml_children(div)) md_sanitize_node(ch)
  kids <- xml2::xml_children(div)
  if (!length(kids)) return("")
  paste0(vapply(kids, function(k) as.character(k), character(1)), collapse = "")
}

# Render a Markdown cell body (comment lines) to sanitized HTML. Ensures
# the whole fragment is a single element so the serializer emits the root
# content verbatim rather than planner-inserted wrapper markup.
render_markdown_fragment <- function(body) {
  lines <- vapply(body, function(ln) {
    if (grepl("^\\s*#", ln)) {
      sub("^(\\s*)#+ ?", "\\1", ln)
    } else {
      ln
    }
  }, character(1))
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

# ---------------------------------------------------------------------------
# Notebook change token
# ---------------------------------------------------------------------------

# Client-visible md5 change token over the exact serialized notebook.
notebook_etag <- function(nb) {
  tmp <- tempfile()
  write_notebook(nb, tmp)
  h <- tools::md5sum(tmp)
  unlink(tmp)
  unname(h)
}
