# httpuv server: editor frontend + JSON API over one Session.
#
# The R worker runs as a separate process (ADR 0004); httpuv and the worker's
# non-blocking poll share the `later` event loop, so a long cell never blocks
# the editor. All state changes flow through Session, which owns the rerun
# model (ADR 2).
#
# Artifacts (PNG/HTML renders) live in one server-owned temp directory
# and are served through `/plot/<basename>` with a normalized containment
# check; static frontend assets are confined to the app directory through
# the same helper.

# ---------------------------------------------------------------------------
# Bootstrap helpers — system.file only, no cwd probing (plan §7)
# ---------------------------------------------------------------------------

alder_app_dir <- function() {
  sys <- system.file("app", package = "alder", mustWork = TRUE)
  if (!nzchar(sys) || !dir.exists(sys)) {
    stop("alder frontend assets not found")
  }
  sys
}

alder_worker_script <- function() {
  sys <- system.file("worker", "worker.R", package = "alder", mustWork = TRUE)
  if (!nzchar(sys) || !file.exists(sys)) {
    stop("alder worker script not found")
  }
  sys
}

prepare_cache_dir <- function(notebook_path, artifact_dir) {
  cache_dir <- if (is.null(notebook_path)) {
    file.path(artifact_dir, "cache")
  } else {
    file.path(dirname(notebook_path), ".alder", "cache")
  }
  if (!dir.exists(cache_dir) &&
      !dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE) &&
      !dir.exists(cache_dir)) {
    stop("could not create cache directory: ", cache_dir)
  }
  if (file.access(cache_dir, 2) != 0L) {
    stop("cache directory is not writable: ", cache_dir)
  }

  if (!is.null(notebook_path)) {
    gitignore <- file.path(dirname(notebook_path), ".gitignore")
    existing <- if (file.exists(gitignore)) {
      readLines(gitignore, warn = FALSE)
    } else {
      character()
    }
    normalized <- trimws(sub("[[:space:]]+#.*$", "", existing))
    has_entry <- any(grepl("^/?\\.alder(/|$)", normalized))
    if (!has_entry) {
      old <- if (file.exists(gitignore)) {
        readBin(gitignore, "raw", n = file.info(gitignore)$size)
      } else {
        raw()
      }
      needs_eol <- length(old) > 0L && old[[length(old)]] != as.raw(10L)
      suffix <- paste0(if (needs_eol) "\n" else "", ".alder/\n")
      writeBin(c(old, charToRaw(suffix)), gitignore)
    }
  }
  normalizePath(cache_dir, mustWork = TRUE)
}
# ---------------------------------------------------------------------------
# Gallery/session bootstrap helpers
# ---------------------------------------------------------------------------

alder_start_lsp <- function(notebook, path, session,
                            diagnostics = FALSE) {
  report <- function(message) {
    detail <- paste0("R language server unavailable: ", message)
    cat("[alder:lsp] ", detail, "\n", sep = "", file = stderr())
    if (!is.null(session) && is.function(session$record_service_error)) {
      session$record_service_error("lsp", detail, "lsp_unavailable")
    }
    invisible()
  }
  tryCatch(
    LspClient$new(
      notebook, path = path, diagnostics = diagnostics,
      on_failure = report
    ),
    error = function(error) {
      report(conditionMessage(error))
      NULL
    }
  )
}

# Build one fully isolated notebook context for a gallery entry. The normal
# single-notebook path below keeps its historical bootstrap in place; gallery
# contexts use the same worker/session discipline but are created on demand.
alder_gallery_session_context <- function(path, execution_mode = NULL,
                                          run_on_startup = NULL) {
  app_dir <- alder_app_dir()
  worker_script <- alder_worker_script()
  nb <- read_notebook(path)
  disk_version <- list(
    exists = TRUE,
    bytes = readBin(path, "raw", n = file.info(path)$size)
  )
  config_error <- NULL
  config <- tryCatch(
    resolve_alder_config(path, nb$metadata),
    error = function(e) {
      config_error <<- e
      config_defaults()
    }
  )
  runtime <- nb$metadata$runtime %||% list()
  if (!is.list(runtime)) runtime <- list()
  if (is.null(execution_mode)) {
    execution_mode <- runtime$execution_mode %||%
      runtime$on_cell_change %||% config$on_cell_change %||% "automatic"
  }
  if (is.null(run_on_startup)) {
    run_on_startup <- runtime$run_on_startup %||%
      runtime$on_startup %||% TRUE
  }
  execution_mode <- match.arg(execution_mode, c("automatic", "lazy"))
  if (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
      is.na(run_on_startup)) {
    stop("`run_on_startup` must be TRUE or FALSE")
  }

  artifact_dir <- tempfile("alder-gallery-artifacts-")
  dir.create(artifact_dir, recursive = TRUE)
  cleanup <- function() {
    if (dir.exists(artifact_dir)) {
      try(unlink(artifact_dir, recursive = TRUE, force = TRUE), silent = TRUE)
    }
  }
  cache_dir <- tryCatch(
    prepare_cache_dir(path, artifact_dir),
    error = function(e) {
      cleanup()
      stop(e)
    }
  )
  upload_dir <- file.path(artifact_dir, "uploads")
  if (!dir.create(upload_dir, recursive = TRUE, mode = "0700")) {
    cleanup()
    stop("could not create upload storage")
  }

  worker <- tryCatch(
    .spawn_worker(
      worker_script, app_dir, artifact_dir, cache_dir,
      env = c(
        ALDER_NOTEBOOK_DIR = dirname(path),
        ALDER_PROJECT_LIB = file.path(dirname(path), ALDER_PACKAGE_INSTALL_LIB)
      )
    ),
    error = function(e) {
      cleanup()
      stop(e)
    }
  )
  tryCatch(
    .wait_for_worker(worker),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )

  sess <- tryCatch(
    Session$new(nb, worker, execution_mode = execution_mode,
                run_on_startup = run_on_startup, disk_version = disk_version,
                config = config,
                package_lib = file.path(dirname(path),
                                        ALDER_PACKAGE_INSTALL_LIB)),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )
  if (!is.null(config_error)) {
    sess$record_config_error(
      conditionMessage(config_error),
      config_error$code %||% "config_invalid"
    )
  }
  lsp <- alder_start_lsp(
    nb, path, sess,
    diagnostics = isTRUE(config$editor$live_diagnostics)
  )
  list(
    path = path, session = sess, worker = worker, lsp = lsp,
    artifact_dir = artifact_dir, upload_dir = upload_dir,
    cache_dir = cache_dir, cleanup = cleanup
  )
}

alder_gallery_catalog <- function(root) {
  alder_gallery_index(root)
}

alder_gallery_entry <- function(root, key) {
  if (!is.character(key) || length(key) != 1L || is.na(key) ||
      !nzchar(key) || grepl("[/\\\\]", key) || key %in% c(".", "..")) {
    return(NULL)
  }
  catalog <- alder_gallery_catalog(root)
  hit <- vapply(catalog, function(entry) identical(entry$basename, key), FALSE)
  if (!any(hit)) NULL else catalog[[which(hit)[[1L]]]]
}

alder_html_escape <- function(value) {
  value <- as.character(value %||% "")
  value <- gsub("&", "&amp;", value, fixed = TRUE)
  value <- gsub("<", "&lt;", value, fixed = TRUE)
  value <- gsub(">", "&gt;", value, fixed = TRUE)
  value <- gsub("\"", "&quot;", value, fixed = TRUE)
  gsub("'", "&#39;", value, fixed = TRUE)
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
        return(paste0("<pre><code>", alder_html_escape(text), "</code></pre>"))
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

alder_gallery_index_response <- function(root) {
  cards <- alder_gallery_catalog(root)
  card_html <- if (!length(cards)) {
    "<p class=\"gallery-empty\">No Alder notebooks found.</p>"
  } else {
    paste(vapply(cards, function(entry) {
      if (!is.null(entry$error)) {
        return(paste0(
          "<article class=\"gallery-card gallery-card-error\">",
          "<h2>", alder_html_escape(entry$title), "</h2>",
          "<p role=\"alert\"><strong>Unavailable:</strong> ",
          alder_html_escape(entry$error$message), "</p>",
          "</article>"
        ))
      }
      href <- paste0("/n/", utils::URLencode(entry$basename, reserved = TRUE))
      paste0(
        "<article class=\"gallery-card\">",
        "<h2><a href=\"", alder_html_escape(href), "\">",
        alder_html_escape(entry$title), "</a></h2>",
        if (nzchar(entry$description)) paste0(
          "<p>", alder_html_escape(entry$description), "</p>"
        ) else "",
        "</article>"
      )
    }, ""), collapse = "\n")
  }
  html <- paste0(
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>Alder notebooks</title>",
    "<style>body{font-family:system-ui,sans-serif;max-width:920px;",
    "margin:2rem auto;padding:0 1rem}.gallery-grid{display:grid;",
    "gap:1rem}.gallery-card{border:1px solid #ddd;border-radius:8px;",
    "padding:1rem}.gallery-card h2{margin-top:0}",
    ".gallery-card-error{border-color:#b42318;background:#fff4f2}",
    ".gallery-card-error p{color:#7a271a}</style></head>",
    "<body><main><h1>Alder notebooks</h1><section class=\"gallery-grid\">",
    card_html, "</section></main></body></html>"
  )
  list(
    status = 200L,
    headers = list(
      "Content-Type" = "text/html; charset=utf-8",
      "Cache-Control" = "no-store",
      "X-Content-Type-Options" = "nosniff",
      "Referrer-Policy" = "no-referrer"
    ),
    body = charToRaw(html)
  )
}

alder_gallery_query_value <- function(query, key) {
  if (!is.character(query) || length(query) != 1L || is.na(query) ||
      !nzchar(query)) return(NULL)
  fields <- strsplit(query, "&", fixed = TRUE)[[1L]]
  for (field in fields) {
    pair <- strsplit(field, "=", fixed = TRUE)[[1L]]
    if (!length(pair) || !identical(utils::URLdecode(pair[[1L]]), key)) next
    value <- if (length(pair) >= 2L) pair[[2L]] else ""
    return(tryCatch(utils::URLdecode(value), error = function(e) NULL))
  }
  NULL
}

# Decode the one integer query parameter accepted by the widget-operation
# status route.  This route is polled by the URL-backed MCP adapter, so reject
# duplicate or unrelated fields instead of silently choosing one.
alder_widget_operation_query <- function(query) {
  invalid <- function() list(
    token = NULL,
    error = list(
      code = "invalid_request",
      message = "query must contain exactly one positive integer token",
      status = 400L
    )
  )
  if (!is.character(query) || length(query) != 1L || is.na(query) ||
      !nzchar(query) || grepl("%(?![[:xdigit:]]{2})", query, perl = TRUE)) {
    return(invalid())
  }
  # httpuv versions differ on whether QUERY_STRING retains its leading `?`.
  query <- sub("^\\?", "", query)
  fields <- strsplit(query, "&", fixed = TRUE)[[1L]]
  if (length(fields) != 1L) return(invalid())
  pair <- strsplit(fields[[1L]], "=", fixed = TRUE)[[1L]]
  if (length(pair) != 2L) return(invalid())
  decoded <- tryCatch(
    lapply(pair, utils::URLdecode),
    error = function(e) NULL
  )
  if (is.null(decoded) || !identical(decoded[[1L]], "token") ||
      !grepl("^[1-9][0-9]*$", decoded[[2L]])) {
    return(invalid())
  }
  token <- suppressWarnings(as.numeric(decoded[[2L]]))
  if (length(token) != 1L || is.na(token) || !is.finite(token) ||
      token > .Machine$integer.max) {
    return(invalid())
  }
  list(token = as.integer(token), error = NULL)
}

# Decode the one run id accepted by the run-operation status route. Keep a
# separate public message from widget tokens while sharing the same strict
# positive-integer and single-field boundary.
alder_run_operation_query <- function(query) {
  invalid <- function() list(
    run_id = NULL,
    error = list(
      code = "invalid_request",
      message = "query must contain exactly one positive integer run_id",
      status = 400L
    )
  )
  if (!is.character(query) || length(query) != 1L || is.na(query) ||
      !nzchar(query) || grepl("%(?![[:xdigit:]]{2})", query, perl = TRUE)) {
    return(invalid())
  }
  query <- sub("^\\?", "", query)
  fields <- strsplit(query, "&", fixed = TRUE)[[1L]]
  if (length(fields) != 1L) return(invalid())
  pair <- strsplit(fields[[1L]], "=", fixed = TRUE)[[1L]]
  if (length(pair) != 2L) return(invalid())
  decoded <- tryCatch(lapply(pair, utils::URLdecode), error = function(e) NULL)
  if (is.null(decoded) || !identical(decoded[[1L]], "run_id") ||
      !grepl("^[1-9][0-9]*$", decoded[[2L]])) {
    return(invalid())
  }
  run_id <- suppressWarnings(as.numeric(decoded[[2L]]))
  if (length(run_id) != 1L || is.na(run_id) || !is.finite(run_id) ||
      run_id > .Machine$integer.max) {
    return(invalid())
  }
  list(run_id = as.integer(run_id), error = NULL)
}

alder_gallery_cookie_value <- function(cookie, key) {
  if (!is.character(cookie) || length(cookie) != 1L || is.na(cookie) ||
      !nzchar(cookie)) return(NULL)
  fields <- strsplit(cookie, ";", fixed = TRUE)[[1L]]
  for (field in fields) {
    pair <- strsplit(trimws(field), "=", fixed = TRUE)[[1L]]
    if (length(pair) >= 2L && identical(pair[[1L]], key)) {
      return(tryCatch(utils::URLdecode(pair[[2L]]), error = function(e) NULL))
    }
  }
  NULL
}

alder_gallery_request_key <- function(req, root) {
  query <- req$QUERY_STRING %||% ""
  key <- alder_gallery_query_value(query, "nb")
  if (is.null(key)) {
    key <- alder_gallery_cookie_value(req$HTTP_COOKIE %||% "", "alder_nb")
  }
  if (is.null(key)) {
    referer <- req$HTTP_REFERER %||% ""
    m <- regexec("/n/([^/?#]+)", referer, perl = TRUE)
    mm <- regmatches(referer, m)[[1L]]
    if (length(mm) == 2L) {
      key <- tryCatch(utils::URLdecode(mm[[2L]]),
                      error = function(e) NULL)
    }
  }
  entry <- alder_gallery_entry(root, key)
  if (is.null(entry)) NULL else entry$basename
}

alder_snapshot_after_save <- function(path) {
  nb <- read_notebook(path)
  if (!isTRUE(nb$metadata$snapshot)) return(NULL)
  snapshot_dir <- file.path(dirname(path), "__alder__")
  if (!dir.exists(snapshot_dir) &&
      !dir.create(snapshot_dir, recursive = TRUE, showWarnings = FALSE) &&
      !dir.exists(snapshot_dir)) {
    stop("could not create snapshot directory: ", snapshot_dir)
  }
  stem <- tools::file_path_sans_ext(basename(path))
  out <- file.path(snapshot_dir, paste0(stem, ".html"))
  alder_export(path, format = "html", out = out)
  out
}

# ---------------------------------------------------------------------------
# HTTP utilities
# ---------------------------------------------------------------------------

json_res <- function(obj, status = 200L) {
  list(
    status = as.integer(status),
    headers = list("Content-Type" = "application/json; charset=utf-8"),
    body = jsonlite::toJSON(obj, auto_unbox = TRUE, null = "null",
                            na = "null", force = TRUE)
  )
}

# Standard JSON error response (plan §7: stable boundary codes only)
error_res <- function(code, message, status = 400L) {
  json_res(list(ok = FALSE,
                error = list(code = code, message = as.character(message))),
           status = status)
}

ok_res <- function(..., status = 200L) {
  json_res(c(list(ok = TRUE), list(...)), status = status)
}

file_res <- function(path, ctype, inline = FALSE) {
  if (!file.exists(path) || dir.exists(path)) {
    return(error_res("not_found", "not found", 404L))
  }
  headers <- list(
    "Content-Type" = ctype,
    "Cache-Control" = "no-store",
    "X-Content-Type-Options" = "nosniff",
    "Referrer-Policy" = "no-referrer")
  if (isTRUE(inline)) headers[["Content-Disposition"]] <- "inline"
  list(status = 200L, headers = headers,
       body = readBin(path, "raw", n = file.info(path)$size))
}

# jsonlite preserves duplicate member names when simplifyVector is FALSE. Walk
# that already-parsed tree instead of rescanning the request bytes: scalar
# values (including uploads) are never inspected or copied here. Frames live
# in an environment so nesting does not repeatedly copy an R list stack.
json_dup_key <- function(obj) {
  if (!is.list(obj)) return(NULL)
  # Depth indexes are numeric strings; hashing keeps deep nesting lookup and
  # insertion constant-time rather than linearly probing prior frames.
  frames <- new.env(hash = TRUE, parent = emptyenv())
  depth <- 0L
  push <- function(node) {
    depth <<- depth + 1L
    entry <- new.env(parent = emptyenv())
    entry$node <- node
    # Do this once in C and visit only nested lists below. A dense scalar JSON
    # array must not cause one interpreted loop iteration per scalar element.
    entry$child_indexes <- which(vapply(node, is.list, logical(1)))
    entry$next_index <- 1L
    keys <- names(node)
    if (!is.null(keys) && length(keys)) {
      repeated <- duplicated(keys)
      if (any(repeated)) return(keys[[which(repeated)[[1L]]]])
    }
    assign(as.character(depth), entry, envir = frames)
    NULL
  }
  duplicate <- push(obj)
  if (!is.null(duplicate)) return(duplicate)
  while (depth) {
    frame <- get(as.character(depth), envir = frames, inherits = FALSE)
    if (frame$next_index > length(frame$child_indexes)) {
      depth <- depth - 1L
      next
    }
    child <- frame$node[[frame$child_indexes[[frame$next_index]]]]
    frame$next_index <- frame$next_index + 1L
    duplicate <- push(child)
    if (!is.null(duplicate)) return(duplicate)
  }
  NULL
}

# Bound structural work before jsonlite allocates an object tree. JSON strings
# are removed by PCRE in C (including escaped quotes and braces); bounded raw
# chunks then count and inspect only the remaining structural punctuation.
# This keeps a large scalar upload a single regex match rather than an R-level
# byte walk, without materializing input-sized logical or integer vectors.
json_structure_within_limits <- function(x, max_depth = 1024L,
                                        max_containers = 10000L,
                                        max_separators = 100000L,
                                        max_escapes = 100000L,
                                        max_quotes = 200000L, bytes = NULL) {
  if (!is.character(x) || length(x) != 1L || is.na(x)) return(FALSE)
  if (is.null(bytes)) bytes <- charToRaw(x)
  chunk_size <- 65536L
  escapes <- 0L
  quotes <- 0L
  byte_count <- length(bytes)
  if (byte_count) {
    for (start in seq.int(1L, byte_count, by = chunk_size)) {
      end <- min(start + chunk_size - 1L, byte_count)
      chunk <- bytes[seq.int(start, end)]
      counts <- tabulate(as.integer(chunk) + 1L, nbins = 256L)
      escapes <- escapes + counts[[93L]]
      quotes <- quotes + counts[[35L]]
      if (escapes > max_escapes || quotes > max_quotes) return(FALSE)
    }
  }
  # JSON permits DEL (U+007F), so exclude exactly C0 controls, not [:cntrl:].
  # \u0000 and unpaired UTF-16 surrogate escapes are rejected: jsonlite
  # otherwise normalizes them lossy before downstream schema validation.
  string_pattern <- r"("(?:[^"\\\x00-\x1F]++|\\["\\/bfnrt]|\\u(?:[Dd][89AaBb][0-9A-Fa-f]{2}\\u[Dd][CcDdEeFf][0-9A-Fa-f]{2}|000[1-9A-Fa-f]|00[1-9A-Fa-f][0-9A-Fa-f]|0[1-9A-Fa-f][0-9A-Fa-f]{2}|[1-9A-Ca-cE-Fe-f][0-9A-Fa-f]{3}|[Dd][0-7][0-9A-Fa-f]{2}))*")"
  general_string_pattern <- r"("(?:[^"\\\x00-\x1F]++|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*")"
  utf8 <- enc2utf8(x)
  if (!escapes) {
    # Normal uploads/base64 have no escapes: one simple C-level string pass.
    stripped <- tryCatch(gsub(r"("[^"\x00-\x1F]*+")", "", utf8, perl = TRUE),
                         warning = function(w) NA_character_, error = function(e) NA_character_)
  } else {
    safe_hits <- tryCatch(gregexpr(string_pattern, utf8, perl = TRUE)[[1L]],
                          warning = function(w) NA_integer_, error = function(e) NA_integer_)
    general_hits <- tryCatch(gregexpr(general_string_pattern, utf8, perl = TRUE)[[1L]],
                             warning = function(w) NA_integer_, error = function(e) NA_integer_)
    if (anyNA(safe_hits) || anyNA(general_hits) ||
        !identical(safe_hits, general_hits) ||
        !identical(attr(safe_hits, "match.length"), attr(general_hits, "match.length"))) return(FALSE)
    stripped <- tryCatch(gsub(general_string_pattern, "", utf8, perl = TRUE),
                         warning = function(w) NA_character_, error = function(e) NA_character_)
  }
  if (is.na(stripped)) return(FALSE)
  # `stripped` is necessarily a complete character value because PCRE removes
  # strings globally. Scan its raw bytes in fixed chunks so structural checks
  # never create input-sized comparison or punctuation vectors.
  stripped_raw <- charToRaw(stripped)
  separators <- 0L
  structural_count <- 0L
  containers <- 0L
  depth <- 0L
  stripped_count <- length(stripped_raw)
  if (!stripped_count) return(TRUE)
  for (start in seq.int(1L, stripped_count, by = chunk_size)) {
    end <- min(start + chunk_size - 1L, stripped_count)
    chunk <- stripped_raw[seq.int(start, end)]
    counts <- tabulate(as.integer(chunk) + 1L, nbins = 256L)
    # A quote left behind was not a safe JSON string (bad escape/control).
    if (counts[[35L]]) return(FALSE)
    separators <- separators + counts[[45L]] + counts[[59L]]
    if (separators > max_separators) return(FALSE)
    chunk_structural <- counts[[124L]] + counts[[126L]] +
      counts[[92L]] + counts[[94L]]
    structural_count <- structural_count + chunk_structural
    if (structural_count > max_containers * 2L) return(FALSE)
    chunk_containers <- counts[[124L]] + counts[[92L]]
    containers <- containers + chunk_containers
    if (containers > max_containers) return(FALSE)
    if (!chunk_structural) next
    # This bounded extraction and cumsum preserve nesting order across chunks.
    structural <- chunk[chunk %in% as.raw(c(123L, 125L, 91L, 93L))]
    openers <- structural %in% as.raw(c(123L, 91L))
    levels <- depth + cumsum(ifelse(openers, 1L, -1L))
    if (max(levels) > max_depth) return(FALSE)
    depth <- levels[[length(levels)]]
  }
  TRUE
}

# Strict JSON body reader (plan §7): media type, size, NUL bytes,
# object root, duplicate keys, parse validity. Returns
# list(body = parsed | NULL, error = NULL | list(code, message, status)).
json_body_limit_message <- function(max_bytes) {
  mib <- 1024L * 1024L
  if (is.numeric(max_bytes) && length(max_bytes) == 1L &&
      is.finite(max_bytes) && max_bytes > 0 && max_bytes %% mib == 0) {
    return(paste("request body exceeds", max_bytes %/% mib, "MiB"))
  }
  paste("request body exceeds", max_bytes, "bytes")
}

read_json_body <- function(req, max_bytes = 1048576L) {
  ct <- req$CONTENT_TYPE %||% ""
  ctype <- tolower(sub(";.*$", "", trimws(ct)))
  if (!identical(ctype, "application/json")) {
    return(list(body = NULL,
                error = list(code = "unsupported_media_type",
                             message = "Content-Type must be application/json",
                             status = 415L)))
  }
  # declared size check
  clen <- suppressWarnings(as.numeric(req$CONTENT_LENGTH %||% ""))
  if (length(clen) == 1L && !is.na(clen) && clen > max_bytes) {
    return(list(body = NULL,
                error = list(code = "payload_too_large",
                             message = json_body_limit_message(max_bytes),
                             status = 413L)))
  }
  # httpuv Rook input: read() returns up to n raw bytes
  raw <- tryCatch(req$rook.input$read(max_bytes + 1L),
                  error = function(e) raw())
  if (length(raw) == 0L) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "empty request body", status = 400L)))
  }
  if (length(raw) > max_bytes) {
    return(list(body = NULL,
                error = list(code = "payload_too_large",
                             message = json_body_limit_message(max_bytes),
                             status = 413L)))
  }
  if (any(raw == as.raw(0))) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "request body contains NUL bytes",
                             status = 400L)))
  }
  txt <- tryCatch(rawToChar(raw), error = function(e) "")
  if (!validUTF8(txt)) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "invalid JSON body", status = 400L)))
  }
  first <- sub("^[ \t\r\n]*", "", txt)
  if (!nzchar(first) || !startsWith(first, "{")) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "JSON body must be an object",
                             status = 400L)))
  }
  if (!json_structure_within_limits(txt, bytes = raw)) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "JSON body exceeds structural complexity limits",
                             status = 400L)))
  }
  # parse first: malformed JSON (e.g. unterminated strings) is a plain 400
  obj <- tryCatch(jsonlite::fromJSON(txt, simplifyVector = FALSE),
                  error = function(e) NULL)
  if (is.null(obj) || !is.list(obj) || is.null(names(obj))) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "invalid JSON body", status = 400L)))
  }
  # jsonlite retains duplicate member names in this unsimplified parsed tree.
  dup <- json_dup_key(obj)
  if (!is.null(dup)) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = paste("duplicate object key:", dup),
                             status = 400L)))
  }
  list(body = obj, error = NULL)
}

# Resolve an encoded relative path inside `root` to one normalized absolute
# existing file, or NULL. The path is URL-decoded once; absolute paths,
# separators, NULs, `.`/`..` segments, unsupported extensions, and any
# escape from `root` are rejected.
safe_child_path <- function(root, encoded_rel, allowed_ext,
                            allow_nested = FALSE) {
  if (!is.character(encoded_rel) || length(encoded_rel) != 1L ||
      is.na(encoded_rel) || grepl("%(?![[:xdigit:]]{2})", encoded_rel,
                                  perl = TRUE)) {
    return(NULL)
  }
  rel <- tryCatch(utils::URLdecode(encoded_rel), error = function(e) "")
  if (is.na(rel) || !nzchar(rel)) return(NULL)
  if (any(charToRaw(rel) == as.raw(0)) ||
      grepl("\\", rel, fixed = TRUE)) return(NULL)
  if (isTRUE(allow_nested)) {
    if (startsWith(rel, "/") ||
        grepl("(^|/)\\.\\.?(/|$)", rel, perl = TRUE)) {
      return(NULL)
    }
  } else if (grepl("/", rel, fixed = TRUE) ||
             grepl("(^|[.])[.][.]?$", rel)) {
    return(NULL)
  }
  if (startsWith(rel, ".")) return(NULL)                # dotfiles
  ext <- tolower(tools::file_ext(rel))
  allowed_ext <- tolower(as.character(allowed_ext))
  if (!nzchar(ext) || !(ext %in% allowed_ext)) return(NULL)
  abs <- normalizePath(file.path(root, rel), mustWork = FALSE)
  rootn <- normalizePath(root, mustWork = FALSE)
  within <- nzchar(abs) && nzchar(rootn) &&
    (identical(abs, rootn) || startsWith(abs, paste0(rootn, .Platform$file.sep)))
  if (!within) return(NULL)
  if (!file.exists(abs) || dir.exists(abs)) return(NULL)
  abs
}

artifact_content_type <- function(ext) switch(tolower(ext),
  png = "image/png",
  jpg = "image/jpeg",
  jpeg = "image/jpeg",
  gif = "image/gif",
  webp = "image/webp",
  svg = "image/svg+xml",
  html = "text/html; charset=utf-8",
  mp3 = "audio/mpeg",
  wav = "audio/wav",
  ogg = "audio/ogg",
  mp4 = "video/mp4",
  webm = "video/webm",
  pdf = "application/pdf",
  NULL)

# ---------------------------------------------------------------------------
# Route validation helpers
# ---------------------------------------------------------------------------

# Validate a route body's fields. `fields` is a named list of specs:
#   type = "scalar_char" | "scalar_num" | "scalar_revision" |
#          "scalar_logical" | "array_char" |
#          "any" | <character enum vector>
# The `required`, `allow_empty`, and `allow_controls` fields accept Booleans;
# `max_bytes` bounds a scalar character field after JSON decoding.
# Returns NULL or list(code, message, status).
validate_body <- function(body, fields) {
  extra <- setdiff(names(body), names(fields))
  if (length(extra)) {
    return(list(code = "invalid_request",
                message = paste("unknown field:", extra[[1L]]),
                status = 400L))
  }
  for (nm in names(fields)) {
    spec <- fields[[nm]]
    found <- nm %in% names(body)
    if (isTRUE(spec$required) && !found) {
      return(list(code = "invalid_request",
                  message = paste("missing required field:", nm),
                  status = 400L))
    }
    if (!found) next
    val <- body[[nm]]
    if (isTRUE(spec$nullable) && is.null(val)) next
    t <- spec$type
    if (identical(t, "scalar_char")) {
      if (!is.character(val) || length(val) != 1L || is.na(val) ||
          (!isTRUE(spec$allow_empty) && !nzchar(val)) ||
          (!isTRUE(spec$allow_controls) &&
           (any(charToRaw(val) == as.raw(0)) || grepl("[\r\n]", val)))) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be a nonempty string"),
                    status = 400L))
      }
    } else if (identical(t, "scalar_num")) {
      if (!is.numeric(val) || length(val) != 1L || is.na(val)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be a number"),
                    status = 400L))
      }
    } else if (identical(t, "scalar_revision")) {
      if (!alder_is_revision(val)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm,
                                    "must be a non-negative integer"),
                    status = 400L))
      }
    } else if (identical(t, "scalar_logical")) {
      if (!is.logical(val) || length(val) != 1L || is.na(val)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be a boolean"),
                    status = 400L))
      }
    } else if (identical(t, "array_char")) {
      coll <- if (is.character(val)) val else if (is.list(val)) val else NULL
      if (is.null(coll)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be a string array"),
                    status = 400L))
      }
      chk <- function(x) is.character(x) && !is.na(x) &&
        !any(charToRaw(x) == as.raw(0)) && !grepl("[\r\n]", x)
      if (!all(vapply(coll, chk, FALSE))) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "contains invalid strings"),
                    status = 400L))
      }
    } else if (identical(t, "scalar_int")) {
      if (!is.integer(val) || length(val) != 1L || is.na(val)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be an integer"),
                    status = 400L))
      }
    } else if (identical(t, "scalar")) {
      if (!is.atomic(val) || length(val) != 1L || is.na(val)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be a scalar"),
                    status = 400L))
      }
    } else if (identical(t, "any")) {
      # no type check
    } else if (is.character(t)) {
      if (!is.character(val) || length(val) != 1L || is.na(val) ||
          !(val %in% t)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be one of",
                                    toString(t)),
                    status = 400L))
      }
    }
    if (!is.null(spec$max_bytes) &&
        (!is.character(val) || length(val) != 1L || is.na(val) ||
         nchar(enc2utf8(val), type = "bytes") > spec$max_bytes)) {
      return(list(code = "invalid_request",
                  message = paste("field", nm, "exceeds", spec$max_bytes,
                                  "bytes"),
                  status = 400L))
    }
    if (isTRUE(spec$exact) && !identical(val, spec$exact)) {
      return(list(code = "invalid_request",
                  message = paste("field", nm, "must be exactly",
                                  deparse(spec$exact)),
                  status = 400L))
    }
  }
  NULL
}

upload_name_valid <- function(name) {
  is.character(name) && length(name) == 1L && !is.na(name) &&
    nzchar(name) && isTRUE(validUTF8(name)) &&
    !any(charToRaw(name) == as.raw(0)) &&
    !grepl("[\r\n]", name) &&
    !grepl("[/\\\\]", name) &&
    !startsWith(name, ".") &&
    !name %in% c(".", "..")
}

decode_upload_files <- function(files, upload_dir, max_total = 12582912L) {
  invalid <- function(message) {
    list(value = NULL, error = list(code = "invalid_request",
                                     message = message, status = 400L))
  }
  if (!is.list(files)) return(invalid("files must be an array"))
  rows <- vector("list", length(files))
  decoded <- vector("list", length(files))
  total <- 0
  for (i in seq_along(files)) {
    file <- files[[i]]
    if (!is.list(file) ||
        !identical(sort(names(file)), c("content_base64", "name"))) {
      return(invalid("each file must contain only name and content_base64"))
    }
    name <- file$name
    content <- file$content_base64
    if (!upload_name_valid(name)) {
      return(invalid("file name contains an invalid path or character"))
    }
    if (!is.character(content) || length(content) != 1L ||
        is.na(content) || any(charToRaw(content) == as.raw(0)) ||
        grepl("[\r\n]", content)) {
      return(invalid("file content_base64 must be a base64 string"))
    }
    bytes <- tryCatch({
      result <- NULL
      invisible(utils::capture.output(
        result <- base64enc::base64decode(content, strict = TRUE)
      ))
      result
    }, error = function(e) NULL)
    if (is.null(bytes)) {
      return(invalid("file content_base64 is invalid"))
    }
    total <- total + length(bytes)
    if (total > max_total) {
      return(list(
        value = NULL,
        error = list(code = "payload_too_large",
                     message = "decoded upload data exceeds 12 MiB",
                     status = 413L)
      ))
    }
    decoded[[i]] <- bytes
    rows[[i]] <- list(name = name, size = as.double(length(bytes)),
                      path = NULL)
  }
  written <- character()
  keep <- FALSE
  on.exit(if (!keep && length(written)) unlink(written, force = TRUE),
          add = TRUE)
  if (!dir.exists(upload_dir) &&
      !dir.create(upload_dir, recursive = TRUE, mode = "0700")) {
    return(list(value = NULL,
                error = list(code = "internal_error",
                             message = "upload storage unavailable",
                             status = 500L)))
  }
  for (i in seq_along(decoded)) {
    dest <- tempfile("upload-", tmpdir = upload_dir)
    ok <- tryCatch({
      writeBin(decoded[[i]], dest)
      Sys.chmod(dest, mode = "0600")
      TRUE
    }, error = function(e) FALSE)
    if (!ok || !file.exists(dest)) {
      return(list(value = NULL,
                  error = list(code = "internal_error",
                               message = "upload storage unavailable",
                               status = 500L)))
    }
    written <- c(written, dest)
    rows[[i]]$path <- normalizePath(dest, mustWork = TRUE)
  }
  value <- data.frame(
    name = vapply(rows, `[[`, character(1), "name"),
    size = vapply(rows, `[[`, numeric(1), "size"),
    path = vapply(rows, `[[`, character(1), "path"),
    stringsAsFactors = FALSE
  )
  keep <- TRUE
  list(value = value, error = NULL, paths = written)
}


# Map an alder_error condition code to HTTP status (plan §7)
alder_error_status <- function(code) {
  switch(code,
    invalid_request = 400L,
    invalid_notebook = 400L,
    config_invalid = 400L,
    invalid_layout = 400L,
    notebook_has_no_path = 400L,
    forbidden_origin = 403L,
    not_found = 404L,
    method_not_allowed = 405L,
    graph_invalid = 409L,
    save_conflict = 409L,
    alder_save_conflict = 409L,
    source_conflict = 409L,
    operation_in_progress = 409L,
    run_in_progress = 409L,
    lazy_expired = 409L,
    widget_not_current = 409L,
    stale_value = 409L,
    no_run_in_progress = 409L,
    payload_too_large = 413L,
    unsupported_media_type = 415L,
    save_failed = 500L,
    export_failed = 500L,
    install_failed = 500L,
    package_metadata_error = 500L,
    internal_error = 500L,
    worker_unavailable = 503L,
    lsp_unavailable = 503L,
    lsp_timeout = 504L,
    format_unavailable = 501L,
    format_failed = 500L,
    session_stopped = 410L,
    value_request_failed = 500L,
    eval_error = 500L,
    500L)
}

# ---------------------------------------------------------------------------
# Origin/Host validation (DNS rebinding protection, plan §7)
# ---------------------------------------------------------------------------

alder_loopback_hosts <- function() c("127.0.0.1", "localhost", "::1")

validate_loopback_host <- function(host) {
  if (!is.character(host) || length(host) != 1L || is.na(host) ||
      !nzchar(host)) {
    stop("`host` must be a nonempty string", call. = FALSE)
  }
  if (!(host %in% alder_loopback_hosts())) {
    stop("`host` must be exactly 127.0.0.1, localhost, or ::1; ",
         "non-loopback binds are not supported", call. = FALSE)
  }
  host
}

build_origins <- function(host, port, allowed_origins) {
  validate_loopback_host(host)
  port <- as.integer(port)
  defaults <- c(paste0("http://127.0.0.1:", port),
                paste0("http://localhost:", port),
                paste0("http://[::1]:", port))
  if (is.null(allowed_origins)) return(defaults)
  validate_origin_list(allowed_origins, port)
}

validate_origin_list <- function(origins, port) {
  if (!is.character(origins) || !length(origins)) {
    stop("allowed_origins must be a nonempty character vector")
  }
  if (anyDuplicated(origins)) {
    stop("allowed_origins must be unique")
  }
  for (o in origins) {
    # exact http(s) origin: no userinfo (@), path (/), query (?), fragment (#)
    if (is.na(o) || !nzchar(o) ||
        !grepl("^https?://[^/@?#]+$", o)) {
      stop("invalid origin: ", o,
           " (must be http(s)://host[:port], no userinfo/path/query/fragment)")
    }
  }
  origins
}

origin_hosts <- function(origins) {
  unique(sub("^https?://", "", origins))
}

# Host must match an allowed authority; Origin (when present) must be an
# exact trusted origin. CLI clients send no Origin and pass on Host alone.
validate_origin <- function(req, origins, hosts) {
  host_hdr <- req$HTTP_HOST %||% ""
  if (!nzchar(host_hdr)) return(FALSE)
  # exact authority (host:port) match only; a Host with any other port
  # must not pass when the trusted authority omits it
  if (!(host_hdr %in% hosts)) return(FALSE)
  origin <- req$HTTP_ORIGIN %||% ""
  if (!nzchar(origin)) return(TRUE)
  origin %in% origins
}

sanitize_client_log_text <- function(value) {
  bytes <- charToRaw(enc2utf8(value))
  bytes[bytes == as.raw(0)] <- as.raw(32)
  gsub("[\r\n]+", " ", rawToChar(bytes))
}

new_alder_lifecycle <- function(idle_timeout = NULL) {
  lifecycle <- new.env(parent = emptyenv())
  lifecycle$stopped <- FALSE
  lifecycle$shutdown_requested <- FALSE
  lifecycle$shutdown_reason <- NULL
  lifecycle$browser_connected <- FALSE
  lifecycle$last_browser_poll <- NULL
  lifecycle$idle_timeout <- idle_timeout
  lifecycle$idle_blocked <- FALSE
  lifecycle$idle_block_reason <- NULL
  lifecycle$stop_callback <- NULL
  # An interrupt can be delivered while httpuv is evaluating a request
  # callback. Keep the terminal status on the server itself because httpuv
  # handles the callback condition before control reaches alder_cli().
  lifecycle$exit_status <- NULL
  lifecycle$shutdown_scheduled <- FALSE
  lifecycle$shutdown_token <- paste0(
    sample(c(letters, LETTERS, 0:9), 48L, replace = TRUE), collapse = "")
  lifecycle$csp_nonce <- paste0(
    sample(c(letters, LETTERS, 0:9), 32L, replace = TRUE), collapse = "")
  lifecycle
}

# Request teardown without stopping httpuv from inside an active request
# callback. httpuv must first receive the callback's response; its later
# event-loop turn then invokes stop_callback safely.
alder_request_shutdown <- function(lifecycle, reason, exit_status = NULL) {
  lifecycle$shutdown_requested <- TRUE
  lifecycle$shutdown_reason <- reason
  if (!is.null(exit_status)) lifecycle$exit_status <- as.integer(exit_status)
  if (!isTRUE(lifecycle$shutdown_scheduled)) {
    lifecycle$shutdown_scheduled <- TRUE
    later::later(function() {
      lifecycle$shutdown_scheduled <- FALSE
      callback <- lifecycle$stop_callback
      if (is.function(callback)) callback(reason)
    }, 0)
  }
  invisible()
}

alder_browser_poll <- function(req) {
  user_agent <- req$HTTP_USER_AGENT %||% ""
  fetch_site <- req$HTTP_SEC_FETCH_SITE %||% ""
  startsWith(user_agent, "Mozilla/") ||
    fetch_site %in% c("same-origin", "same-site", "none")
}

alder_shutdown_authenticated <- function(req, lifecycle) {
  supplied <- req$HTTP_X_ALDER_SHUTDOWN_TOKEN %||% ""
  is.character(supplied) && length(supplied) == 1L &&
    nzchar(supplied) && identical(supplied, lifecycle$shutdown_token)
}

# ---------------------------------------------------------------------------
# CSP/security headers for the main editor document (plan §7)
# ---------------------------------------------------------------------------

editor_csp <- function(nonce) paste(
  "default-src 'self'", "connect-src 'self'",
  "img-src 'self' data: http: https:", "script-src 'self'",
  "style-src 'self'",
  paste0("style-src-elem 'self' 'nonce-", nonce, "'"),
  "style-src-attr 'unsafe-inline'", "frame-src 'self'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  sep = "; "
)

editor_headers <- function(nonce) list(
  "X-Content-Type-Options" = "nosniff",
  "Referrer-Policy" = "no-referrer",
  "Cache-Control" = "no-store",
  "X-Frame-Options" = "DENY",
  "Content-Security-Policy" = editor_csp(nonce)
)

editor_document_res <- function(path, nonce) {
  response <- file_res(path, "text/html; charset=utf-8")
  if (!identical(response$status, 200L)) return(response)
  html <- rawToChar(response$body)
  marker <- "__ALDER_CSP_NONCE__"
  if (!grepl(marker, html, fixed = TRUE)) {
    return(error_res("internal_error",
                     "editor document is missing its CSP nonce marker", 500L))
  }
  response$body <- charToRaw(gsub(marker, nonce, html, fixed = TRUE))
  response$headers <- c(response$headers, editor_headers(nonce))
  response
}

#' Serve an alder notebook
#'
#' Start the local alder web app for a notebook: a derivation DAG over
#' \code{# \%\%} cells is computed, cells execute in dependency order in a
#' dedicated R worker process, and the UI supports editing, reactive
#' execution, \code{ui$} widgets with explicit \code{$value}, and
#' interruptible execution.
#'
#' Only the worker is executed as a separate process for isolation; it is
#' not a security sandbox, so only trusted notebook code should be run.
#' With \code{sandbox = TRUE} the worker runs with the standard renv project
#' library (\code{renv/library} under the notebook directory) and declared
#' packages install into it.
#'
#' @param path Path to a notebook file (plain \code{.R} with \code{# \%\%}
#'   cell markers). Must be \code{NULL} or one nonempty valid-UTF-8
#'   string. When \code{NULL}, an empty notebook with no save path is
#'   served; a nonexistent path is created only on Save.
#' @param host Loopback interface to bind. Must be exactly
#'   \code{"127.0.0.1"}, \code{"localhost"}, or \code{"::1"}; Alder does
#'   not support non-loopback binds.
#' @param port TCP port for the local web server; one integer in 1--65535.
#' @param open Open a browser tab after the server is ready.
#' @param execution_mode Reactivity mode: \code{"automatic"} runs a cell's
#'   ancestors, the target, and all descendants; \code{"lazy"} runs
#'   ancestors and the target and leaves descendants stale. App views
#'   always use automatic widget reactivity. \code{NULL} resolves from
#'   notebook metadata and configuration.
#' @param run_on_startup If \code{TRUE}, all code cells run once when the
#'   server starts; if \code{FALSE}, opening the editor or an app URL never
#'   triggers execution. \code{NULL} resolves from notebook metadata and
#'   configuration.
#' @param allowed_origins Optional explicit trusted browser origins.
#'   \code{NULL} allows exactly \code{http://127.0.0.1:<port>},
#'   \code{http://localhost:<port>}, and \code{http://[::1]:<port>}.
#' @param sandbox Run the notebook worker with an isolated package library
#'   (the standard renv project library); declared packages install into it.
#'   Notebook lookup is restricted to that library plus base/recommended R
#'   packages. Requires a notebook \code{path}; \code{sandbox = TRUE} with a
#'   \code{NULL} path or a gallery directory is an error.
#' @param idle_timeout Browser-idle shutdown timeout in seconds. After a browser
#'   has connected and polled state at least once, the server stops when no
#'   browser poll arrives for this duration. Dirty notebooks are atomically
#'   saved first; a save failure or conflict pauses shutdown and is exposed in
#'   state rather than discarding work. \code{NULL} or zero disables the timer.
#'   The R API defaults to disabled; the command-line launcher defaults to 30
#'   seconds.
#' @return An \code{alder_server} list wrapping the httpuv server, the
#'   notebook \code{Session}, and the worker.
#' @examples
#' \dontrun{
#' srv <- start_alder("analysis.R", open = TRUE)
#' stop_alder(srv)
#' }
#' @export
start_alder <- function(path = NULL, host = "127.0.0.1", port = 8899L,
                        open = FALSE,
                        execution_mode = NULL,
                        run_on_startup = NULL,
                        allowed_origins = NULL,
                        sandbox = FALSE,
                        idle_timeout = NULL) {
  # --- argument validation ------------------------------------------------
  validate_loopback_host(host)
  if (!is.null(path)) {
    if (!is.character(path) || length(path) != 1L || is.na(path) ||
        !nzchar(path)) {
      stop("`path` must be NULL or a nonempty string")
    }
    if (any(charToRaw(path) == as.raw(0))) {
      stop("`path` contains NUL bytes")
    }
    if (file.exists(path)) {
      path <- normalizePath(path, mustWork = TRUE)
    } else {
      parent <- dirname(path)
      if (!dir.exists(parent)) {
        stop("parent directory of `path` does not exist: ", parent)
      }
      path <- file.path(normalizePath(parent, mustWork = TRUE), basename(path))
    }
  }
  # Sandbox mode resolves the isolated library before any branch: it
  # validates the notebook path (NULL and directory paths are rejected
  # before anything spawns) and creates the library directory. The
  # resolved library is also the install target for declared packages.
  worker_env <- character()
  package_lib <- NULL
  if (isTRUE(sandbox)) {
    sb <- alder_sandbox(path)
    worker_env <- sb$env
    package_lib <- sb$lib
  } else if (!is.null(path) && !dir.exists(path)) {
    package_lib <- file.path(dirname(path), ALDER_PACKAGE_INSTALL_LIB)
    worker_env <- c(ALDER_PROJECT_LIB = package_lib)
  }

  gallery <- !is.null(path) && dir.exists(path)
  if (!is.null(path) && !gallery) {
    worker_env <- c(ALDER_NOTEBOOK_DIR = dirname(path), worker_env)
  }
  if (!is.numeric(port) || length(port) != 1L || is.na(port) ||
      port < 1L || port > 65535L) {
    stop("`port` must be an integer between 1 and 65535")
  }
  port <- as.integer(port)
  if (!is.logical(open) || length(open) != 1L || is.na(open)) {
    stop("`open` must be TRUE or FALSE")
  }
  if (!is.null(allowed_origins) &&
      (!is.character(allowed_origins) || !length(allowed_origins))) {
    stop("`allowed_origins` must be NULL or a character vector")
  }
  if (!is.logical(sandbox) || length(sandbox) != 1L || is.na(sandbox)) {
    stop("`sandbox` must be TRUE or FALSE")
  }
  if (!is.null(idle_timeout) &&
      (!is.numeric(idle_timeout) || length(idle_timeout) != 1L ||
       is.na(idle_timeout) || !is.finite(idle_timeout) || idle_timeout < 0)) {
    stop("`idle_timeout` must be NULL or one non-negative finite number")
  }
  if (!is.null(idle_timeout) && identical(as.numeric(idle_timeout), 0)) {
    idle_timeout <- NULL
  }

  # --- bootstrap ----------------------------------------------------------
  app_dir <- alder_app_dir()
  worker_script <- alder_worker_script()
  if (!gallery) {

  if (!is.null(path) && file.exists(path)) {
    nb <- read_notebook(path)
    disk_version <- list(exists = TRUE,
                         bytes = readBin(path, "raw",
                                         n = file.info(path)$size))
  } else {
    nb <- parse_notebook_lines(path, character())
    disk_version <- if (!is.null(path)) list(exists = FALSE, bytes = raw())
      else NULL
  }
  config_error <- NULL
  config <- tryCatch(
    resolve_alder_config(path, nb$metadata),
    error = function(e) {
      config_error <<- e
      config_defaults()
    }
  )
  runtime <- nb$metadata$runtime %||% list()
  if (!is.list(runtime)) runtime <- list()
  if (is.null(execution_mode)) {
    execution_mode <- runtime$execution_mode %||%
      runtime$on_cell_change %||% config$on_cell_change %||% "automatic"
  }
  if (is.null(run_on_startup)) {
    run_on_startup <- runtime$run_on_startup %||%
      runtime$on_startup %||% config$on_startup %||% TRUE
  }
  execution_mode <- match.arg(execution_mode, c("automatic", "lazy"))
  if (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
      is.na(run_on_startup)) {
    stop("`run_on_startup` must be TRUE or FALSE")
  }


  artifact_dir <- tempfile("alder-artifacts-")
  dir.create(artifact_dir, recursive = TRUE)
  cache_dir <- tryCatch(
    prepare_cache_dir(path, artifact_dir),
    error = function(e) {
      unlink(artifact_dir, recursive = TRUE, force = TRUE)
      stop(e)
    }
  )
  upload_dir <- file.path(artifact_dir, "uploads")
  if (!dir.create(upload_dir, recursive = TRUE, mode = "0700")) {
    unlink(artifact_dir, recursive = TRUE)
    stop("could not create upload storage")
  }
  cleanup <- function() {
    if (dir.exists(artifact_dir)) {
      try(unlink(artifact_dir, recursive = TRUE), silent = TRUE)
    }
  }

  worker <- tryCatch(
    .spawn_worker(worker_script, app_dir, artifact_dir, cache_dir,
                  env = worker_env),
    error = function(e) {
      cleanup()
      stop(e)
    }
  )
  # The worker validates its environment (artifact dir, widget module) at
  # startup. Wait until it has booted so a fast stop_alder() cannot unlink
  # the artifact directory from under the booting process.
  tryCatch(
    .wait_for_worker(worker),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )

  sess <- tryCatch(
    Session$new(nb, worker, execution_mode = execution_mode,
                run_on_startup = run_on_startup, disk_version = disk_version,
                config = config, package_lib = package_lib),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )
  if (!is.null(config_error)) {
    sess$record_config_error(
      conditionMessage(config_error),
      config_error$code %||% "config_invalid"
    )
  }

  # A language-server failure does not destroy the notebook worker, but it is
  # a visible operational error because completion and argument help are part
  # of Alder's required editor experience.
  lsp <- alder_start_lsp(
    nb, path, sess,
    diagnostics = isTRUE(config$editor$live_diagnostics)
  )


  } else {
    # A gallery has no default notebook session. Entries are opened on the
    # first /n/<basename> or notebook API request.
    nb <- NULL
    disk_version <- NULL
    config_error <- NULL
    config <- tryCatch(
      resolve_alder_config(file.path(path, "__gallery__.R"), list()),
      error = function(e) config_defaults()
    )
    execution_mode <- if (is.null(execution_mode)) {
      config$on_cell_change %||% "automatic"
    } else {
      match.arg(execution_mode, c("automatic", "lazy"))
    }
    if (is.null(run_on_startup)) {
      run_on_startup <- config$on_startup %||% TRUE
    }
    if (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
        is.na(run_on_startup)) {
      stop("`run_on_startup` must be TRUE or FALSE")
    }
    artifact_dir <- tempfile("alder-gallery-")
    dir.create(artifact_dir, recursive = TRUE)
    upload_dir <- file.path(artifact_dir, "uploads")
    dir.create(upload_dir, recursive = TRUE, mode = "0700")
    cache_dir <- NULL
    gallery_last_used <- new.env(parent = emptyenv()) # nolint: object_usage_linter
    cleanup <- function() {
      if (dir.exists(artifact_dir)) {
        try(unlink(artifact_dir, recursive = TRUE, force = TRUE),
            silent = TRUE)
      }
    }
    worker <- NULL
    sess <- NULL
    lsp <- NULL
    gallery_sessions <- new.env(parent = emptyenv())
    gallery_clock <- 0L
    gallery_max <- suppressWarnings(as.integer(
      config$gallery$max_sessions %||% 4L
    ))
    if (is.na(gallery_max) || gallery_max < 1L) gallery_max <- 4L
    gallery_max <- min(gallery_max, 32L)
    gallery_errors <- Filter(
      function(entry) !is.null(entry$error),
      alder_gallery_catalog(path)
    )
    for (entry in gallery_errors) {
      message(
        "[alder:gallery] Could not load ", entry$basename, ": ",
        entry$error$message
      )
    }
  }

  origins <- tryCatch(
    build_origins(host, port, allowed_origins),
    error = function(e) {
      if (!is.null(lsp)) try(lsp$stop(), silent = TRUE)
      if (!is.null(sess)) try(sess$stop(), silent = TRUE)
      if (!is.null(worker)) try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )
  hosts <- origin_hosts(origins)
  lifecycle <- new_alder_lifecycle(idle_timeout)
  gallery_get_context <- function(key) {
    if (!gallery) return(NULL)
    entry <- alder_gallery_entry(path, key)
    if (is.null(entry)) return(NULL)
    if (!is.null(entry$error)) {
      return(structure(
        list(entry = entry, error = entry$error),
        class = "alder_gallery_entry_error"
      ))
    }
    if (exists(entry$basename, envir = gallery_sessions, inherits = FALSE)) {
      gallery_clock <<- gallery_clock + 1L
      gallery_last_used[[entry$basename]] <- gallery_clock
      return(get(entry$basename, envir = gallery_sessions, inherits = FALSE))
    }
    keys <- ls(gallery_sessions, all.names = TRUE)
    if (length(keys) >= gallery_max) {
      used <- vapply(keys, function(k) {
        as.numeric(gallery_last_used[[k]] %||% 0)
      }, numeric(1L))
      victim <- keys[[which.min(used)]]
      old <- get(victim, envir = gallery_sessions, inherits = FALSE)
      if (!is.null(old$lsp)) try(old$lsp$stop(), silent = TRUE)
      if (!is.null(old$session)) try(old$session$stop(), silent = TRUE)
      if (!is.null(old$worker) && old$worker$alive()) {
        try(old$worker$kill(), silent = TRUE)
      }
      if (!is.null(old$cleanup)) old$cleanup()
      rm(list = victim, envir = gallery_sessions)
      rm(list = victim, envir = gallery_last_used)
    }
    created <- tryCatch(
      alder_gallery_session_context(
        entry$path, execution_mode = execution_mode,
        run_on_startup = run_on_startup
      ),
      error = function(e) structure(
        list(error = e), class = "alder_gallery_context_error"
      )
    )
    if (inherits(created, "alder_gallery_context_error")) return(created)
    gallery_clock <<- gallery_clock + 1L
    assign(entry$basename, created, envir = gallery_sessions)
    gallery_last_used[[entry$basename]] <- gallery_clock
    created
  }
  gallery_close <- function() {
    if (!gallery) return(invisible())
    keys <- ls(gallery_sessions, all.names = TRUE)
    for (key in keys) {
      ctx <- get(key, envir = gallery_sessions, inherits = FALSE)
      if (!is.null(ctx$lsp)) try(ctx$lsp$stop(), silent = TRUE)
      if (!is.null(ctx$session)) try(ctx$session$stop(), silent = TRUE)
      if (!is.null(ctx$worker) && ctx$worker$alive()) {
        try(ctx$worker$kill(), silent = TRUE)
      }
      if (!is.null(ctx$cleanup)) ctx$cleanup()
    }
    invisible()
  }


  # --- httpuv call handler ------------------------------------------------
  call_handler_impl <- function(req) {
    path_req <- sub("\\?.*$", "", req$PATH_INFO %||% "")
    method <- req$REQUEST_METHOD %||% ""

    if (!validate_origin(req, origins, hosts)) {
      return(error_res("forbidden_origin", "origin not allowed", 403L))
    }

    # This route is server-scoped, including in gallery mode. Teardown is
    # deferred so httpuv can flush the accepted response before it stops.
    if (identical(path_req, "/api/shutdown")) {
      if (!identical(method, "POST")) {
        res <- error_res("method_not_allowed",
                         paste("method not allowed:", method), 405L)
        res$headers$Allow <- "POST"
        return(res)
      }
      if (!alder_shutdown_authenticated(req, lifecycle)) {
        return(error_res("forbidden", "shutdown token is invalid", 403L))
      }
      raw <- tryCatch(req$rook.input$read(1L), error = function(e) raw())
      if (length(raw)) {
        return(error_res("invalid_request",
                         "shutdown requires a zero-byte body", 400L))
      }
      alder_request_shutdown(lifecycle, "api")
      return(ok_res(stopping = TRUE, status = 202L))
    }

    gallery_key <- NULL
    gallery_context <- NULL
    if (gallery) {
      if (startsWith(path_req, "/n/")) {
        gallery_key <- tryCatch(
          utils::URLdecode(sub("^/n/", "", path_req)),
          error = function(e) NULL
        )
      } else if (startsWith(path_req, "/api/") ||
                 startsWith(path_req, "/plot/") ||
                 startsWith(path_req, "/download/") ||
                 startsWith(path_req, "/public/")) {
        gallery_key <- alder_gallery_request_key(req, path)
      }
      if (startsWith(path_req, "/n/") ||
          startsWith(path_req, "/api/") ||
          startsWith(path_req, "/plot/") ||
          startsWith(path_req, "/download/")) {
        if (is.null(gallery_key)) {
          return(error_res("not_found", "not found", 404L))
        }
        gallery_context <- gallery_get_context(gallery_key)
        if (inherits(gallery_context, "alder_gallery_entry_error")) {
          return(error_res(
            gallery_context$error$code,
            paste0("Could not load ", gallery_context$entry$basename, ": ",
                   gallery_context$error$message),
            alder_error_status(gallery_context$error$code)
          ))
        }
        if (inherits(gallery_context, "alder_gallery_context_error")) {
          return(error_res("internal_error",
                           conditionMessage(gallery_context$error), 500L))
        }
        if (is.null(gallery_context)) {
          return(error_res("not_found", "not found", 404L))
        }
        # Route-local bindings preserve all existing Session calls below.
        sess <- gallery_context$session
        lsp <- gallery_context$lsp
        artifact_dir <- gallery_context$artifact_dir
        upload_dir <- gallery_context$upload_dir
      }
    }

    need <- function(allowed) {
      if (method %in% allowed) return(NULL)
      res <- error_res("method_not_allowed",
                       paste("method not allowed:", method), 405L)
      res$headers$Allow <- paste(allowed, collapse = ", ")
      res
    }

    # --- gallery index and notebook pages ---------------------------------
    if (gallery && (identical(path_req, "/") ||
                    identical(path_req, "/index.html"))) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      return(alder_gallery_index_response(path))
    }
    if (gallery && startsWith(path_req, "/n/")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      p <- file.path(app_dir, "index.html")
      if (!file.exists(p)) return(error_res("not_found", "not found", 404L))
      res <- editor_document_res(p, lifecycle$csp_nonce)
      res$headers[["Set-Cookie"]] <- paste0(
        "alder_nb=", utils::URLencode(gallery_key, reserved = TRUE),
        "; Path=/; SameSite=Lax"
      )
      return(res)
    }

    # --- static assets ---------------------------------------------------
    if (identical(path_req, "/") || identical(path_req, "/index.html")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      p <- file.path(app_dir, "index.html")
      if (!file.exists(p)) return(error_res("not_found", "not found", 404L))
      res <- editor_document_res(p, lifecycle$csp_nonce)
      return(res)
    }
    if (startsWith(path_req, "/static/")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      rel <- sub("^/static/", "", path_req)
      if (startsWith(rel, "vendor/")) {
        f <- safe_child_path(file.path(app_dir, "static", "vendor"),
                             sub("^vendor/", "", rel), c("js", "css"))
      } else {
        f <- safe_child_path(file.path(app_dir, "static"), rel, c("js", "css"))
      }
      if (is.null(f)) return(error_res("not_found", "not found", 404L))
      ext <- tools::file_ext(f)
      ctype <- if (identical(ext, "js")) "text/javascript; charset=utf-8"
        else paste0("text/", ext, "; charset=utf-8")
      return(file_res(f, ctype))
    }
# Notebook-adjacent public assets are optional. They are served only for a
    if (startsWith(path_req, "/public/")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      public_root <- if (gallery) {
        entry <- alder_gallery_entry(path, gallery_key)
        if (is.null(entry)) NULL else file.path(dirname(entry$path), "public")
      } else if (!is.null(path)) {
        file.path(dirname(path), "public")
      } else {
        NULL
      }
      if (is.null(public_root) || !dir.exists(public_root)) {
        return(error_res("not_found", "not found", 404L))
      }
      f <- safe_child_path(
        public_root, sub("^/public/", "", path_req),
        c("png", "jpg", "jpeg", "gif", "webp", "svg",
          "mp3", "wav", "ogg", "mp4", "webm", "pdf",
          "css", "js", "json", "txt", "woff2"),
        allow_nested = TRUE)
      if (is.null(f)) return(error_res("not_found", "not found", 404L))
      ext <- tolower(tools::file_ext(f))
      ctype <- artifact_content_type(ext) %||% switch(
        ext,
        css = "text/css; charset=utf-8",
        js = "text/javascript; charset=utf-8",
        json = "application/json",
        txt = "text/plain; charset=utf-8",
        woff2 = "font/woff2",
        NULL)
      if (is.null(ctype)) return(error_res("not_found", "not found", 404L))
      return(file_res(f, ctype, inline = identical(ext, "svg")))
    }


    # --- artifact (plot/media) files ---------------------------------------
    if (startsWith(path_req, "/plot/")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      f <- safe_child_path(
        artifact_dir, sub("^/plot/", "", path_req),
        c("png", "jpg", "jpeg", "gif", "webp", "svg", "html",
          "mp3", "wav", "ogg", "mp4", "webm", "pdf"))
      if (is.null(f)) return(error_res("not_found", "not found", 404L))
      ext <- tolower(tools::file_ext(f))
      ct <- artifact_content_type(ext)
      if (is.null(ct)) return(error_res("not_found", "not found", 404L))
      return(file_res(f, ct, inline = identical(ext, "svg")))
    }

    # --- exported files ----------------------------------------------------
    if (startsWith(path_req, "/download/")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      f <- safe_child_path(
        artifact_dir, sub("^/download/", "", path_req),
        c("html", "md", "r", "ipynb", "qmd", "json"))
      if (is.null(f)) return(error_res("not_found", "not found", 404L))
      ext <- tolower(tools::file_ext(f))
      ctype <- switch(ext,
                      html = "text/html; charset=utf-8",
                      md = "text/markdown; charset=utf-8",
                      r = "text/plain; charset=utf-8",
                      ipynb = "application/json",
                      qmd = "text/plain; charset=utf-8",
                      json = "application/json",
                      NULL)
      if (is.null(ctype)) return(error_res("not_found", "not found", 404L))
      res <- file_res(f, ctype)
      res$headers[["Content-Disposition"]] <-
        paste0("attachment; filename=\"", basename(f), "\"")
      return(res)
    }

    # --- API: unknown paths are 404 before any body parsing ---------------
    api_routes <- c("/api/state", "/api/config", "/api/app", "/api/layout",
                    "/api/run", "/api/lazy", "/api/table", "/api/cell",
                    "/api/widget", "/api/widget-operation",
                    "/api/run-operation", "/api/upload",
                    "/api/value", "/api/runtime",
                    "/api/interrupt", "/api/restart", "/api/save",
                    "/api/lsp", "/api/format",
                    "/api/export", "/api/check", "/api/packages", "/api/log")

    if (!(path_req %in% api_routes)) {
      return(error_res("not_found", "not found", 404L))
    }

    if (identical(path_req, "/api/state")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      if (alder_browser_poll(req)) {
        lifecycle$browser_connected <- TRUE
        lifecycle$last_browser_poll <- Sys.time()
        lifecycle$idle_blocked <- FALSE
        lifecycle$idle_block_reason <- NULL
      }
      if (!is.null(lsp) && lsp$alive()) {
        tryCatch(
          {
            notebook <- sess$notebook_snapshot()
            lsp$sync_document(notebook)
            sess$set_lsp_diagnostics(lsp$diagnostics_by_cell(notebook))
          },
          error = function(error) {
            sess$set_lsp_diagnostics(list())
            detail <- paste0("R language server synchronization failed: ",
                             conditionMessage(error))
            sess$record_service_error("lsp", detail, "lsp_unavailable")
            cat("[alder:lsp] ", detail, "\n", sep = "", file = stderr())
          }
        )
      }
      response <- json_res(list())
      response$body <- sess$state_json(list(shutdown_token = lifecycle$shutdown_token))
      return(response)
    }
    if (identical(path_req, "/api/widget-operation")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      parsed <- alder_widget_operation_query(req$QUERY_STRING %||% "")
      if (!is.null(parsed$error)) {
        return(error_res(
          parsed$error$code, parsed$error$message, parsed$error$status
        ))
      }
      # Detect a worker exit before exposing a still-pending journal record.
      sess$worker_available()
      operation <- sess$widget_operation(parsed$token)
      if (is.null(operation)) {
        return(error_res(
          "not_found", "widget operation token was not found", 404L
        ))
      }
      # This is deliberately a narrow projection, not a second state surface.
      public_operation <- list(
        token = as.integer(operation$token),
        status = as.character(operation$status),
        error = operation$error %||% NULL
      )
      if (!is.null(operation$reset_expected)) {
        public_operation$reset_expected <- isTRUE(operation$reset_expected)
      }
      if (!is.null(operation$reset_token)) {
        public_operation$reset_token <- as.integer(operation$reset_token)
      }
      return(ok_res(operation = public_operation))
    }
    if (identical(path_req, "/api/run-operation")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      parsed <- alder_run_operation_query(req$QUERY_STRING %||% "")
      if (!is.null(parsed$error)) {
        return(error_res(
          parsed$error$code, parsed$error$message, parsed$error$status
        ))
      }
      # Detect a worker exit before exposing a still-pending journal record.
      sess$worker_available()
      operation <- sess$run_operation(parsed$run_id)
      if (is.null(operation)) {
        return(error_res(
          "not_found", "run operation id was not found", 404L
        ))
      }
      # This projection intentionally excludes queue and cell internals.
      public_operation <- list(
        run_id = as.integer(operation$run_id),
        status = as.character(operation$status),
        reset_tokens = I(as.integer(operation$reset_tokens %||% integer())),
        error = operation$error %||% NULL
      )
      return(ok_res(operation = public_operation))
    }
    if (identical(path_req, "/api/config") && identical(method, "GET")) {
      return(ok_res(config = sess$state()$config))
    }
    if (identical(path_req, "/api/app") && identical(method, "GET")) {
      return(ok_res(app = sess$state()$app))
    }
    if (identical(path_req, "/api/layout") && identical(method, "GET")) {
      state <- sess$state()
      if (!is.null(state$layout_error)) {
        return(error_res(
          state$layout_error$code,
          state$layout_error$message,
          alder_error_status(state$layout_error$code)
        ))
      }
      return(ok_res(layout = state$layout))
    }

    m <- need("POST")
    if (!is.null(m)) return(m)

    session_call <- function(expr) {
      tryCatch(expr,
        alder_error = function(e) {
          code <- e$code %||% "internal_error"
          error_res(code, conditionMessage(e), alder_error_status(code))
        },
        error = function(e) {
          message <- conditionMessage(e)
          cat("[alder:server] internal API error at ", path_req, ": ",
              message, "\n", sep = "", file = stderr())
          if (is.function(sess$record_action_error)) {
            sess$record_action_error(message, "internal_error")
          }
          error_res("internal_error", "internal server error", 500L)
        })
    }

    # --- /api/interrupt (zero-byte body, no JSON required) -------------------
    if (identical(path_req, "/api/interrupt")) {
      raw <- tryCatch(req$rook.input$read(1L), error = function(e) raw())
      if (length(raw)) {
        return(error_res("invalid_request",
                         "interrupt requires a zero-byte body", 400L))
      }
      return(session_call({
        r <- sess$interrupt()
        ok_res(run_id = r$run_id, status = 202L)
      }))
    }

    # --- /api/restart (zero-byte body, restart + dependency-order replay) ---
    if (identical(path_req, "/api/restart")) {
      raw <- tryCatch(req$rook.input$read(1L), error = function(e) raw())
      if (length(raw)) {
        return(error_res("invalid_request",
                         "restart requires a zero-byte body", 400L))
      }
      return(session_call({
        r <- sess$restart_worker(replay = TRUE)
        ok_res(run_id = r$run_id, status = 202L)
      }))
    }

    # --- /api/save (zero-byte body, no JSON required) -------------------------
    if (identical(path_req, "/api/save")) {
      raw <- tryCatch(req$rook.input$read(1L), error = function(e) raw())
      if (length(raw)) {
        return(error_res("invalid_request",
                         "save requires a zero-byte body", 400L))
      }
      return(session_call({
        r <- sess$save()
        snapshot_error <- NULL
        snapshot_path <- NULL
        if (isTRUE(gallery)) {
          # Gallery sessions are always file-backed; the notebook path is
          # selected by the request's session context.
          save_path <- r$path %||% sess$notebook_snapshot()$path
        } else {
          save_path <- r$path
        }
        if (is.character(save_path) && length(save_path) == 1L &&
            !is.na(save_path) && nzchar(save_path)) {
          result <- tryCatch(
            alder_snapshot_after_save(save_path),
            error = function(e) {
              snapshot_error <<- conditionMessage(e)
              NULL
            }
          )
          snapshot_path <- result
        }
        if (!is.null(snapshot_error) &&
            is.function(sess$record_action_error)) {
          sess$record_action_error(snapshot_error, "export_failed")
        }
        ok_res(path = r$path, etag = r$etag, version = r$version,
               snapshot = snapshot_path %||% NULL)
      }))
    }

    parsed <- read_json_body(
      req, max_bytes = if (identical(path_req, "/api/upload")) {
        16777216L
      } else {
        1048576L
      }
    )
    if (!is.null(parsed$error)) {
      return(error_res(parsed$error$code, parsed$error$message,
                       parsed$error$status))
    }
    body <- parsed$body

    # --- /api/log (surface client-side errors in server logs) --------------
    if (identical(path_req, "/api/log")) {
      v <- validate_body(body, list(
        level = list(type = "scalar_char", required = TRUE,
                     allow_controls = TRUE, max_bytes = 32L),
        message = list(type = "scalar_char", required = TRUE,
                       allow_controls = TRUE, max_bytes = 8192L),
        source = list(type = "scalar_char", required = FALSE,
                      allow_empty = TRUE, allow_controls = TRUE,
                      max_bytes = 256L),
        code = list(type = "scalar_char", required = FALSE, max_bytes = 128L),
        status = list(type = "scalar_revision", required = FALSE),
        url = list(type = "scalar_char", required = FALSE,
                   allow_empty = TRUE, allow_controls = TRUE,
                   max_bytes = 4096L),
        stack = list(type = "scalar_char", required = FALSE,
                     allow_empty = TRUE, allow_controls = TRUE,
                     max_bytes = 16384L)
      ))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      # Fetch uses status 0 for network failures; HTTP responses use 100--599.
      # Retain the frontend's structured failure details without accepting
      # arbitrary or lossy numeric values in a physical log record.
      if (!is.null(body$status) &&
          !(body$status == 0 || (body$status >= 100 && body$status <= 599))) {
        return(error_res("invalid_request",
                         "field status must be 0 or an HTTP status from 100 to 599", 400L))
      }
      lv <- sanitize_client_log_text(body$level)
      msg <- sanitize_client_log_text(body$message)
      attrs <- character(0)
      source <- sanitize_client_log_text(body$source %||% "")
      url <- sanitize_client_log_text(body$url %||% "")
      stack <- sanitize_client_log_text(body$stack %||% "")
      if (nzchar(source)) {
        attrs <- c(attrs, paste0("source=", source))
      }
      if (!is.null(body$code)) {
        attrs <- c(attrs, paste0("code=", sanitize_client_log_text(body$code)))
      }
      if (!is.null(body$status)) {
        attrs <- c(attrs, paste0("status=", body$status))
      }
      if (nzchar(url)) {
        attrs <- c(attrs, paste0("url=", url))
      }
      if (nzchar(stack)) {
        attrs <- c(attrs, paste0("stack=", stack))
      }
      cat(sprintf("[client:%s] %s%s\n", lv, msg,
                  if (length(attrs)) paste0(" | ", paste(attrs, collapse = " ")) else ""),
          file = stderr())
      return(ok_res(logged = TRUE))
    }

    # --- /api/config -------------------------------------------------------
    if (identical(path_req, "/api/config")) {
      return(session_call({
        result <- sess$set_config(body)
        if (!is.null(lsp) && lsp$alive()) {
          tryCatch(
            {
              lsp$set_diagnostics(
                isTRUE(result$config$editor$live_diagnostics)
              )
              if (!isTRUE(result$config$editor$live_diagnostics)) {
                sess$set_lsp_diagnostics(list())
              }
            },
            error = function(e) {
              detail <- paste0(
                "Could not update language-server diagnostics: ",
                conditionMessage(e)
              )
              sess$record_service_error("lsp", detail, "lsp_unavailable")
              cat("[alder:lsp] ", detail, "\n", sep = "", file = stderr())
            }
          )
        }
        ok_res(config = result$config, version = result$version)
      }))
    }

    # --- /api/app ----------------------------------------------------------
    if (identical(path_req, "/api/app")) {
      v <- validate_body(body, list(
        layout = list(type = "scalar_char", required = FALSE),
        width = list(type = "scalar_char", required = FALSE),
        include_code = list(type = "scalar_logical", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      if (!length(body)) {
        return(error_res("invalid_request", "app update is empty", 400L))
      }
      return(session_call({
        result <- sess$set_app(body)
        ok_res(app = result$app, version = result$version)
      }))
    }

    # --- /api/layout -------------------------------------------------------
    if (identical(path_req, "/api/layout")) {
      if (identical(method, "GET")) {
        state <- sess$state()
        if (!is.null(state$layout_error)) {
          return(error_res(
            state$layout_error$code,
            state$layout_error$message,
            alder_error_status(state$layout_error$code)
          ))
        }
        return(ok_res(layout = state$layout))
      }
      v <- validate_body(body, list(
        version = list(type = "scalar_num", required = FALSE),
        layout = list(type = "scalar_char", required = FALSE),
        cells = list(type = "any", required = TRUE),
        slides = list(type = "any", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        layout <- list(
          version = if ("version" %in% names(body)) body$version else 1L,
          cells = body$cells
        )
        if ("layout" %in% names(body)) layout$layout <- body$layout
        if ("slides" %in% names(body)) layout$slides <- body$slides
        result <- sess$set_layout(layout)
        ok_res(layout = result$layout, version = result$version)
      }))
    }
    if (identical(path_req, "/api/packages")) {
      v <- validate_body(body, list(
        op = list(type = "scalar_char", required = TRUE),
        package = list(type = "scalar_char", required = FALSE),
        packages = list(type = "array_char", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      if (!body$op %in% c("status", "declare", "install")) {
        return(error_res("invalid_request",
                         "op must be status, declare, or install", 400L))
      }
      if (identical(body$op, "status")) {
        if ("package" %in% names(body) || "packages" %in% names(body)) {
          return(error_res("invalid_request",
                           "status does not accept package names", 400L))
        }
        return(session_call(ok_res(packages = sess$state()$packages)))
      }
      supplied <- character()
      if ("package" %in% names(body)) supplied <- c(supplied, body$package)
      if ("packages" %in% names(body)) {
        values <- body$packages
        if (is.list(values)) values <- unlist(values, use.names = FALSE)
        supplied <- c(supplied, values %||% character())
      }
      supplied <- sort(unique(as.character(supplied)))
      if (identical(body$op, "install") && !length(supplied)) {
        supplied <- as.character(sess$state()$packages$missing %||% character())
      }
      if (!length(supplied)) {
        return(error_res("invalid_request", "at least one package is required", 400L))
      }
      return(session_call({
        if (identical(body$op, "declare")) {
          result <- sess$declare_packages(supplied)
          ok_res(packages = result$declared, path = result$metadata)
        } else {
          result <- sess$install_packages(supplied)
          ok_res(packages = result$packages,
                 installed = result$installed,
                 missing = result$missing,
                 installing = result$installing,
                 lib = result$lib,
                 status = if (identical(result$status, "installing")) 202L else 200L)
        }
      }))
    }
    # --- /api/lsp ----------------------------------------------------------
    if (identical(path_req, "/api/lsp")) {
      v <- validate_body(body, list(
        method = list(type = "scalar_char", required = TRUE),
        params = list(type = "any", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      allowed <- c("textDocument/completion", "textDocument/hover",
                   "textDocument/definition", "textDocument/references",
                   "textDocument/documentSymbol", "textDocument/signatureHelp",
                   "alder/restart")
      if (!body$method %in% allowed) {
        return(error_res("invalid_request", "unsupported language-server method",
                         400L))
      }
      if (!is.list(body$params)) {
        return(error_res("invalid_request", "params must be an object", 400L))
      }
      return(session_call({
        if (identical(body$method, "alder/restart")) {
          if (!is.null(lsp)) lsp$stop()
          nb_now <- sess$notebook_snapshot()
          replacement <- alder_start_lsp(
            nb_now, nb_now$path, sess,
            diagnostics = isTRUE(
              sess$state()$config$editor$live_diagnostics
            )
          )
          if (isTRUE(gallery)) {
            gallery_context$lsp <- replacement
            assign(gallery_key, gallery_context, envir = gallery_sessions)
            lsp <- replacement
          } else {
            lsp <<- replacement
          }
          if (is.null(replacement) || !replacement$alive()) {
            alder_abort("lsp_unavailable",
                        "R language server restart failed; see server diagnostics")
          }
          sess$clear_service_error("lsp")
          return(ok_res(result = list(ready = TRUE)))
        }
        if (is.null(lsp) || !lsp$alive()) {
          message <- if (!is.null(lsp) && nzchar(lsp$failure %||% "")) {
            lsp$failure
          } else {
            "language server is unavailable"
          }
          sess$record_service_error("lsp", message, "lsp_unavailable")
          alder_abort("lsp_unavailable", message)
        }
        nb_now <- sess$notebook_snapshot()
        result <- tryCatch(
          lsp$request_document(body$method, body$params, nb_now),
          error = function(e) {
            msg <- conditionMessage(e)
            code <- if (grepl("timed out", msg, fixed = TRUE)) {
              "lsp_timeout"
            } else if (grepl("unavailable|exited|stopped", msg,
                             ignore.case = TRUE)) {
              "lsp_unavailable"
            } else {
              "invalid_request"
            }
            sess$record_service_error("lsp", msg, code)
            cat("[alder:lsp] ", msg, "\n", sep = "", file = stderr())
            alder_abort(code, msg)
          }
        )
        # A publishDiagnostics notification may have arrived with the
        # response. Cell and document diagnostics are merged into state.
        sess$set_lsp_diagnostics(lsp$diagnostics_by_cell(nb_now))
        sess$clear_service_error("lsp")
        if (identical(body$method, "textDocument/hover")) {
          return(ok_res(result = result,
                        rendered = lsp_hover_html(result$contents)))
        }
        ok_res(result = result)
      }))
    }

    # --- /api/format -------------------------------------------------------
    if (identical(path_req, "/api/format")) {
      v <- validate_body(body, list(
        cell = list(type = "scalar_char", required = FALSE),
        expected_revisions = list(type = "any", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        result <- sess$format_source(body$cell %||% NULL,
                                     body$expected_revisions %||% NULL)
        if (!is.null(lsp) && lsp$alive()) {
          tryCatch(
            {
              lsp$sync_document(sess$notebook_snapshot())
              sess$clear_service_error("lsp")
            },
            error = function(error) {
              message <- conditionMessage(error)
              sess$record_service_error("lsp", message, "lsp_unavailable")
              cat("[alder:lsp] document sync failed after formatting: ",
                  message, "\n", sep = "", file = stderr())
            }
          )
        }
        ok_res(changed = result$changed, version = result$version,
               cells = result$cells)
      }))
    }



    # --- /api/export -------------------------------------------------------
    if (identical(path_req, "/api/export")) {
      v <- validate_body(body, list(
        format = list(type = "scalar_char", required = TRUE),
        include_code = list(type = "scalar_logical", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      formats <- c("html", "md", "script", "ipynb", "qmd", "session")
      if (!body$format %in% formats) {
        return(error_res("invalid_request",
                         paste("format must be one of", toString(formats)), 400L))
      }
      include_code <- body$include_code %||% FALSE
      return(session_call({
        state <- sess$state()
        ext <- switch(body$format, html = "html", md = "md", script = "R",
                      ipynb = "ipynb", qmd = "qmd", session = "json")
        stem <- tools::file_path_sans_ext(basename(state$path %||% "notebook.R"))
        stem <- if (nzchar(stem)) stem else "notebook"
        out <- file.path(artifact_dir,
                         paste0(stem, "-", body$format, ".", ext))
        switch(body$format,
               html = export_html_file(state, artifact_dir, out, include_code),
               md = export_markdown_file(state, artifact_dir, out, include_code),
               script = export_script_file(
                 state, out, state$path %||% "notebook.R"),
               ipynb = export_ipynb_file(
                 state, artifact_dir, out, include_code),
               qmd = export_qmd_file(state, out, include_code),
               session = export_session_file(state, out))
        if (!file.exists(out)) {
          alder_abort("export_failed", "export did not create an output file")
        }
        ok_res(download = paste0("/download/", basename(out)),
               format = body$format)
      }))
    }

    # --- /api/check --------------------------------------------------------
    if (identical(path_req, "/api/check")) {
      v <- validate_body(body, list())
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        nb_now <- sess$notebook_snapshot()
        analysis <- export_analysis(nb_now)
        diagnostics <- export_diagnostics(nb_now, analysis)
        ok_res(diagnostics = diagnostics)
      }))
    }

    # --- /api/run ----------------------------------------------------------
    if (identical(path_req, "/api/run")) {
      has_cell <- "cell" %in% names(body)
      has_all <- "all" %in% names(body)
      if (has_cell == has_all) {
        return(error_res("invalid_request",
                         "must provide exactly one of `cell` or `all`",
                         400L))
      }
      v <- if (has_cell) {
        validate_body(body, list(
          cell = list(type = "scalar_char", required = TRUE),
          scope = list(type = c("all", "stale"), required = FALSE)
        ))
      } else {
        validate_body(body, list(
          all = list(type = "scalar_logical", required = TRUE, exact = TRUE),
          scope = list(type = c("all", "stale"), required = FALSE)
        ))
      }
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      if (has_cell && "scope" %in% names(body)) {
        return(error_res(
          "invalid_request", "scope is valid only with `all`", 400L
        ))
      }
      return(session_call({
        if (has_cell) {
          run <- sess$run_cell(body$cell)
          ok_res(run_id = run$run_id, status = 202L)
        } else if (identical(body$scope %||% NULL, "stale") ||
                   (is.null(body$scope) &&
                    identical(sess$get_execution_mode(), "lazy"))) {
          # lazy "Run stale": run every stale cell plus required ancestors;
          # a plain run_all would re-execute current cells and reset widgets.
          run <- sess$run_stale()
          ok_res(run_id = run$run_id, status = 202L)
        } else {
          run <- sess$run_all()
          ok_res(run_id = run$run_id, status = 202L)
        }
      }))
    }
    # --- /api/lazy ---------------------------------------------------------
    if (identical(path_req, "/api/lazy")) {
      v <- validate_body(body, list(
        key = list(type = "scalar_char", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        token <- sess$request_lazy(body$key)
        ok_res(token = token, status = 202L)
      }))
    }
    # --- /api/table --------------------------------------------------------
    if (identical(path_req, "/api/table")) {
      v <- validate_body(body, list(
        handle = list(type = "scalar_char", required = TRUE),
        offset = list(type = "scalar_num", required = FALSE),
        limit = list(type = "scalar_num", required = FALSE),
        sort_by = list(type = "any", required = FALSE),
        sort_desc = list(type = "scalar_logical", required = FALSE),
        filter = list(type = "any", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        tok <- sess$request_table_page(
          body$handle,
          offset = body$offset %||% 0,
          limit = body$limit %||% 25,
          sort_by = body$sort_by %||% "",
          sort_desc = body$sort_desc %||% FALSE,
          filter = body$filter %||% "")
        ok_res(token = tok, status = 202L)
      }))
    }


    # --- /api/upload --------------------------------------------------------
    if (identical(path_req, "/api/upload")) {
      v <- validate_body(body, list(
        name = list(type = "scalar_char", required = TRUE),
        path = list(type = "array_char", required = FALSE),
        files = list(type = "any", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      path <- body$path %||% character()
      if (is.list(path)) path <- unlist(path, use.names = FALSE)
      if (is.null(path)) path <- character()
      if (!is.character(path) || anyNA(path) || any(!nzchar(path))) {
        return(error_res("invalid_request", "path must be a string array", 400L))
      }
      uploaded <- decode_upload_files(body$files, upload_dir)
      if (!is.null(uploaded$error)) {
        return(error_res(uploaded$error$code, uploaded$error$message,
                         uploaded$error$status))
      }
      return(session_call({
        token <- tryCatch(
          sess$set_widget(
            body$name, path, list(value = uploaded$value), source = "editor"
          ),
          error = function(e) {
            if (length(uploaded$paths)) unlink(uploaded$paths, force = TRUE)
            stop(e)
          }
        )
        ok_res(token = token, status = 202L)
      }))
    }

# JSON arrays arrive as lists under simplifyVector = FALSE; validate_body
# checks each element, then normalize to a character vector for the session.
# An empty JSON array decodes to list() and unlist(list()) is NULL, which
# would store a NULL cell body and crash I(c$body) in Session$state().
body_chars <- function(x) {
  if (is.character(x)) return(x)
  v <- unlist(x, use.names = FALSE)
  if (is.null(v)) character(0) else v
}

# --- /api/cell --------------------------------------------------------------
    if (identical(path_req, "/api/cell")) {
      op <- body$op %||% ""
      if (op == "disable") {
        v <- validate_body(body, list(
          op = list(type = "scalar_char", required = TRUE),
          cell = list(type = "scalar_char", required = TRUE),
          disabled = list(type = "scalar_logical", required = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        return(session_call({
          r <- sess$set_cell_disabled(body$cell, body$disabled)
          ok_res(id = r$id, disabled = r$disabled, run_id = r$run_id,
                 version = r$version)
        }))
      }
      if (op == "name") {
        v <- validate_body(body, list(
          op = list(type = "scalar_char", required = TRUE),
          cell = list(type = "scalar_char", required = TRUE),
          name = list(type = "scalar_char", required = TRUE,
                      nullable = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        return(session_call({
          r <- sess$set_cell_name(body$cell, body$name)
          ok_res(id = r$id, name = r$name, version = r$version)
        }))
      }
      if (op == "move") {
        v <- validate_body(body, list(
          op = list(type = "scalar_char", required = TRUE),
          cell = list(type = "scalar_char", required = TRUE),
          after = list(type = "scalar_char", required = TRUE,
                       nullable = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        return(session_call({
          r <- sess$move_cell(body$cell, body$after)
          ok_res(id = r$id, after = r$after, version = r$version)
        }))
      }
      if (op == "edit") {
        v <- validate_body(body, list(
          op = list(type = c("edit", "add", "delete"), required = TRUE),
          id = list(type = "scalar_char", required = TRUE),
          body = list(type = "array_char", required = TRUE),
          type = list(type = "scalar_char", required = TRUE),
          expected_revision = list(type = "scalar_revision", required = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        if (!body$type %in% c("code", "markdown")) {
          return(error_res("invalid_request",
                           "cell type must be code or markdown", 400L))
        }
        return(session_call({
          r <- sess$set_cell(body$id, body_chars(body$body), body$type,
                             body$expected_revision)
          ok_res(id = r$id, revision = r$revision, version = r$version)
        }))
      }
      if (op == "add") {
        v <- validate_body(body, list(
          op = list(type = c("edit", "add", "delete"), required = TRUE),
          after = list(type = "scalar_char", required = TRUE,
                       nullable = TRUE),
          body = list(type = "array_char", required = TRUE),
          type = list(type = "scalar_char", required = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        if (!body$type %in% c("code", "markdown")) {
          return(error_res("invalid_request",
                           "cell type must be code or markdown", 400L))
        }
        return(session_call({
          r <- sess$add_cell(body$after, body_chars(body$body), body$type)
          ok_res(id = r$id, revision = r$revision, version = r$version)
        }))
      }
      v <- validate_body(body, list(
        op = list(type = c("edit", "add", "delete"), required = TRUE),
        id = list(type = "scalar_char", required = TRUE),
        expected_revision = list(type = "scalar_revision", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        r <- sess$delete_cell(body$id, body$expected_revision)
        ok_res(id = r$id, version = r$version)
      }))
    }

    # --- /api/widget --------------------------------------------------------
    if (identical(path_req, "/api/widget")) {
      v <- validate_body(body, list(
        name = list(type = "scalar_char", required = TRUE),
        path = list(type = "array_char", required = FALSE),
        value = list(type = "any", required = FALSE),
        index = list(type = "scalar_int", required = FALSE),
        indices = list(type = "any", required = FALSE),
        selected = list(type = "any", required = FALSE),
        ops = list(type = "any", required = FALSE),
        submit = list(type = "scalar_logical", required = FALSE),
        paused = list(type = "scalar_logical", required = FALSE),
        source = list(type = "scalar_char", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      path <- body$path %||% character()
      if (is.list(path)) path <- unlist(path, use.names = FALSE)
      if (is.null(path)) path <- character()
      if (!is.character(path) || anyNA(path) || any(!nzchar(path))) {
        return(error_res("invalid_request", "path must be a string array", 400L))
      }
      fields <- intersect(c("value", "index", "indices", "selected", "ops",
                            "submit"), names(body))
      if (length(fields) != 1L) {
        return(error_res("invalid_request",
                         "provide exactly one widget update field", 400L))
      }
      if (!body$source %in% c("editor", "app")) {
        return(error_res("invalid_request",
                         "source must be editor or app", 400L))
      }
      return(session_call({
        upd <- setNames(list(body[[fields[[1L]]]]), fields[[1L]])
        if ("paused" %in% names(body)) upd$paused <- body$paused
        tok <- sess$set_widget(body$name, path, upd, body$source)
        ok_res(token = tok, status = 202L)
      }))
    }

    # --- /api/value ----------------------------------------------------------
    if (identical(path_req, "/api/value")) {
      v <- validate_body(body,
                         list(name = list(type = "scalar_char",
                                          required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        tok <- sess$request_value(body$name)
        ok_res(token = tok, status = 202L)
      }))
    }

    # all remaining POST routes require the POST method (checked above)

    # --- /api/runtime ---------------------------------------------------------
    if (identical(path_req, "/api/runtime")) {
      v <- validate_body(body, list(
        execution_mode = list(type = "scalar_char", required = FALSE,
                              nullable = TRUE),
        run_on_startup = list(type = "scalar_logical", required = FALSE,
                              nullable = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      em <- body$execution_mode %||% NULL
      ros <- body$run_on_startup %||% NULL
      if (is.null(em) && is.null(ros)) {
        return(error_res("invalid_request",
                         "provide execution_mode or run_on_startup", 400L))
      }
      if (!is.null(em) && !em %in% c("automatic", "lazy")) {
        return(error_res("invalid_request",
                         "execution_mode must be automatic or lazy", 400L))
      }
      return(session_call({
        r <- sess$set_runtime(em, ros)
        ok_res(execution_mode = r$execution_mode,
               run_on_startup = r$run_on_startup,
               version = r$version)
      }))
    }

    error_res("not_found", "not found", 404L)
  }

  # Keep this handler boundary around the complete httpuv callback. An OS
  # SIGINT raised while /api/state (or any other route) is being evaluated is
  # otherwise caught by httpuv and converted into its generic HTTP 500, which
  # leaves the foreground CLI and its descendants alive. Return a concrete
  # Alder response, then let the deferred event-loop callback tear down the
  # server after httpuv has unwound this request.
  call_handler <- function(req) {
    perf <- NULL
    response <- NULL
    on.exit(.alder_perf_end(perf, list(status = response$status)), add = TRUE)
    response <- tryCatch(
      {
        perf <- .alder_perf_begin("http", list(route = req$PATH_INFO,
          method = req$REQUEST_METHOD))
        call_handler_impl(req)
      },
      interrupt = function(condition) {
        alder_request_shutdown(lifecycle, "interrupt", exit_status = 130L)
        error_res("session_stopped", "Alder is shutting down after interrupt",
                  410L)
      }
    )
    if (!is.null(perf)) {
      response$headers[["X-Alder-Perf-Span"]] <- paste(perf$pid, perf$span, sep = ":")
    }
    response
  }

  # --- start httpuv server ---------------------------------------------------
  server <- tryCatch(
    httpuv::startServer(host, port, list(call = call_handler)),
    error = function(e) {
      if (!is.null(lsp)) try(lsp$stop(), silent = TRUE)
      if (!is.null(sess)) try(sess$stop(), silent = TRUE)
      if (!is.null(worker)) try(worker$kill(), silent = TRUE)
      if (isTRUE(gallery)) gallery_close()
      cleanup()
      stop(e)
    }
  )
  cat("alder running at http://", host, ":", port, "/\n", sep = "")
  if (open) {
    tryCatch(
      utils::browseURL(paste0("http://", host, ":", port, "/")),
      error = function(error) warning(
        "Alder started, but the browser could not be opened: ",
        conditionMessage(error), call. = FALSE
      )
    )
  }
  srv <- structure(list(server = server, session = sess, lsp = lsp,
                        worker = worker, gallery = gallery,
                        gallery_root = if (gallery) path else NULL,
                        gallery_sessions = if (gallery) gallery_sessions else NULL,
                        artifact_dir = artifact_dir,
                        upload_dir = upload_dir, cache_dir = cache_dir,
                        lifecycle = lifecycle,
                        stopped = FALSE), class = "alder_server")
  lifecycle$stop_callback <- function(reason = "requested") {
    if (isTRUE(lifecycle$stopped)) return(invisible(srv))
    lifecycle$shutdown_requested <- TRUE
    lifecycle$shutdown_reason <- reason
    stop_alder(srv)
  }
  idle_save_session <- function(session, label = "notebook") {
    state <- session$state()
    if (!isTRUE(state$changed)) return(TRUE)
    tryCatch(
      {
        session$save()
        cat("[alder:lifecycle] saved dirty ", label,
            " before idle shutdown\n", sep = "", file = stderr())
        TRUE
      },
      error = function(error) {
        message <- paste0(
          "Automatic idle shutdown is paused because Alder could not save ",
          label, ": ", conditionMessage(error)
        )
        session$record_action_error(message, "idle_save_failed")
        lifecycle$idle_blocked <- TRUE
        lifecycle$idle_block_reason <- message
        cat("[alder:lifecycle] ", message, "\n", sep = "", file = stderr())
        FALSE
      }
    )
  }
  idle_work_safe <- function() {
    if (isTRUE(gallery)) {
      keys <- ls(gallery_sessions, all.names = TRUE)
      for (key in keys) {
        context <- get(key, envir = gallery_sessions, inherits = FALSE)
        if (!idle_save_session(context$session, paste0("notebook `", key, "`"))) {
          return(FALSE)
        }
      }
      return(TRUE)
    }
    idle_save_session(sess)
  }
  if (!is.null(lifecycle$idle_timeout)) {
    check_idle <- NULL
    check_idle <- function() {
      if (isTRUE(lifecycle$stopped)) return(invisible())
      if (!isTRUE(lifecycle$idle_blocked) &&
          isTRUE(lifecycle$browser_connected) &&
          !is.null(lifecycle$last_browser_poll)) {
        idle <- as.numeric(difftime(Sys.time(), lifecycle$last_browser_poll,
                                    units = "secs"))
        if (is.finite(idle) && idle >= lifecycle$idle_timeout) {
          if (idle_work_safe()) {
            lifecycle$stop_callback("idle_timeout")
            return(invisible())
          }
        }
      }
      interval <- max(0.05, min(1, lifecycle$idle_timeout / 4))
      later::later(check_idle, interval)
      invisible()
    }
    later::later(check_idle,
                 max(0.05, min(1, lifecycle$idle_timeout / 4)))
  }
  srv
}

#' @rdname start_alder
#' @param srv An \code{alder_server} object returned by \code{start_alder}.
#' @export
stop_alder <- function(srv) {
  lifecycle <- srv$lifecycle
  if (is.environment(lifecycle)) {
    if (isTRUE(lifecycle$stopped)) return(invisible(srv))
    lifecycle$stopped <- TRUE
    lifecycle$shutdown_requested <- TRUE
    if (is.null(lifecycle$shutdown_reason)) {
      lifecycle$shutdown_reason <- "stop_alder"
    }
  } else if (isTRUE(srv$stopped)) {
    return(invisible(srv))
  }
  srv$stopped <- TRUE
  if (!is.null(srv$gallery_sessions) &&
      is.environment(srv$gallery_sessions)) {
    keys <- ls(srv$gallery_sessions, all.names = TRUE)
    for (key in keys) {
      ctx <- get(key, envir = srv$gallery_sessions, inherits = FALSE)
      if (!is.null(ctx$lsp)) try(ctx$lsp$stop(), silent = TRUE)
      if (!is.null(ctx$session)) try(ctx$session$stop(), silent = TRUE)
      if (!is.null(ctx$worker) && ctx$worker$alive()) {
        try(ctx$worker$kill(), silent = TRUE)
      }
      if (!is.null(ctx$cleanup)) ctx$cleanup()
    }
  } else {
    if (!is.null(srv$lsp)) try(srv$lsp$stop(), silent = TRUE)
    if (!is.null(srv$session)) try(srv$session$stop(), silent = TRUE)
    if (!is.null(srv$worker) && srv$worker$alive()) {
      try(srv$worker$kill(), silent = TRUE)
    }
  }
  try(httpuv::stopServer(srv$server), silent = TRUE)
  if (!is.null(srv$artifact_dir) && dir.exists(srv$artifact_dir)) {
    try(unlink(srv$artifact_dir, recursive = TRUE, force = TRUE),
        silent = TRUE)
  }
  invisible(srv)
}
