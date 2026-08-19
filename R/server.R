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
    .spawn_worker(worker_script, app_dir, artifact_dir, cache_dir),
    error = function(e) {
      cleanup()
      stop(e)
    }
  )
  booted <- FALSE
  deadline <- Sys.time() + 15
  while (!booted && Sys.time() < deadline) {
    if (!worker$alive()) break
    done <- FALSE
    worker$send("ping", on_response = function(ctx, resp) done <<- TRUE)
    later::run_now(0.05)
    booted <- done
  }
  if (!booted) {
    try(worker$kill(), silent = TRUE)
    cleanup()
    stop("worker failed to start")
  }

  sess <- tryCatch(
    Session$new(nb, worker, execution_mode = execution_mode,
                run_on_startup = run_on_startup, disk_version = disk_version,
                config = config),
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
  lsp <- tryCatch(
    LspClient$new(nb, path = path),
    error = function(e) NULL
  )
  list(
    path = path, session = sess, worker = worker, lsp = lsp,
    artifact_dir = artifact_dir, upload_dir = upload_dir,
    cache_dir = cache_dir, cleanup = cleanup
  )
}

alder_gallery_catalog <- function(root) {
  files <- list.files(root, pattern = "\\.R$", full.names = TRUE)
  if (!length(files)) return(list())
  entries <- lapply(files, function(path) {
    nb <- tryCatch(read_notebook(path), error = function(e) NULL)
    if (is.null(nb) || !length(nb$cells)) return(NULL)
    list(
      basename = basename(path), path = normalizePath(path, mustWork = TRUE),
      title = tryCatch(alder_app_title(nb), error = function(e) basename(path)),
      description = tryCatch(alder_app_description(nb),
                             error = function(e) "")
    )
  })
  entries[!vapply(entries, is.null, logical(1L))]
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

alder_gallery_index_response <- function(root) {
  cards <- alder_gallery_catalog(root)
  card_html <- if (!length(cards)) {
    "<p class=\"gallery-empty\">No Alder notebooks found.</p>"
  } else {
    paste(vapply(cards, function(entry) {
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
    "padding:1rem}.gallery-card h2{margin-top:0}</style></head>",
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

# Detect the first duplicated object key at any depth in a JSON document,
# or NULL when none exists. Operates on raw text so jsonlite's silent
# last-wins collapse cannot hide duplicates. The document must already
# parse (read_json_body parses first), but the scanner is total: an
# unterminated string or escape bails out without looping.
json_dup_key <- function(x) {
  n <- nchar(x)
  i <- 1L
  stack <- list()   # frames: list(keys = character())
  in_string <- FALSE
  while (i <= n) {
    ch <- substr(x, i, i)
    if (in_string) {
      if (ch == "\\") i <- i + 1L
      else if (ch == "\"") in_string <- FALSE
      i <- i + 1L
      next
    }
    if (ch == "\"") {
      j <- i + 1L
      val <- ""
      repeat {
        if (j > n) return(NULL)          # unterminated string: total bail
        c2 <- substr(x, j, j)
        if (c2 == "\\") {
          if (j + 1L > n) return(NULL)
          esc <- substr(x, j + 1L, j + 1L)
          if (esc == "u") {
            if (j + 5L > n) return(NULL)
            hex <- substr(x, j + 2L, j + 5L)
            if (!grepl("^[0-9a-fA-F]{4}$", hex)) return(NULL)
            val <- paste0(val, intToUtf8(strtoi(hex, 16L)))
            j <- j + 6L
          } else {
            val <- paste0(val, switch(esc,
              `"` = "\"", `\\` = "\\", `/` = "/", b = "\b", f = "\f",
              n = "\n", r = "\r", t = "\t", ""))
            j <- j + 2L
          }
          next
        }
        if (c2 == "\"") break
        val <- paste0(val, c2)
        j <- j + 1L
      }
      # a key is a string directly followed by ":" (outside strings)
      k <- j + 1L
      while (k <= n && grepl("[ \t\r\n]", substr(x, k, k))) k <- k + 1L
      if (k <= n && identical(substr(x, k, k), ":")) {
        if (length(stack) && val %in% stack[[length(stack)]]$keys) {
          return(val)
        }
        if (length(stack)) {
          stack[[length(stack)]]$keys <-
            c(stack[[length(stack)]]$keys, val)
        }
        i <- k + 1L
      } else {
        i <- j + 1L
      }
      next
    }
    if (ch == "{") {
      stack[[length(stack) + 1L]] <- list(keys = character())
    } else if (ch == "}") {
      if (length(stack)) stack <- stack[-length(stack)]
    } else if (ch == "[") {
      stack[[length(stack) + 1L]] <- list(keys = character())
    } else if (ch == "]") {
      if (length(stack)) stack <- stack[-length(stack)]
    }
    i <- i + 1L
  }
  NULL
}

# Strict JSON body reader (plan §7): media type, size, NUL bytes,
# object root, duplicate keys, parse validity. Returns
# list(body = parsed | NULL, error = NULL | list(code, message, status)).
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
                             message = "request body exceeds 1 MiB",
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
                             message = "request body exceeds 1 MiB",
                             status = 413L)))
  }
  if (any(raw == as.raw(0))) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "request body contains NUL bytes",
                             status = 400L)))
  }
  txt <- tryCatch(rawToChar(raw), error = function(e) "")
  first <- sub("^[ \t\r\n]*", "", txt)
  if (!nzchar(first) || !startsWith(first, "{")) {
    return(list(body = NULL,
                error = list(code = "invalid_request",
                             message = "JSON body must be an object",
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
  # duplicate keys would otherwise be silently collapsed (last wins)
  dup <- json_dup_key(txt)
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
#   type = "scalar_char" | "scalar_num" | "scalar_logical" | "array_char" |
#          "any" | <character enum vector>
#   required = TRUE | FALSE
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
          !nzchar(val) || any(charToRaw(val) == as.raw(0)) ||
          grepl("[\r\n]", val)) {
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
      if (!(val %in% t)) {
        return(list(code = "invalid_request",
                    message = paste("field", nm, "must be one of",
                                    toString(t)),
                    status = 400L))
      }
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
    no_run_in_progress = 409L,
    payload_too_large = 413L,
    unsupported_media_type = 415L,
    save_failed = 500L,
    export_failed = 500L,
    install_failed = 500L,
    package_metadata_error = 500L,
    internal_error = 500L,
    worker_unavailable = 503L,
    sql_unavailable = 503L,
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

build_origins <- function(host, port, allowed_origins) {
  loopback <- host %in% c("127.0.0.1", "localhost", "::1")
  if (loopback) {
    port <- as.integer(port)
    defaults <- c(paste0("http://127.0.0.1:", port),
                  paste0("http://localhost:", port),
                  paste0("http://[::1]:", port))
    if (is.null(allowed_origins)) return(defaults)
    return(validate_origin_list(allowed_origins, port))
  }
  if (is.null(allowed_origins)) {
    stop("non-loopback bind requires explicit allowed_origins")
  }
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

# ---------------------------------------------------------------------------
# CSP/security headers for the main editor document (plan §7)
# ---------------------------------------------------------------------------

editor_csp <- paste(
  "default-src 'self'", "connect-src 'self'",
  "img-src 'self' data: http: https:", "script-src 'self'",
  "style-src 'self'", "frame-src 'self'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  sep = "; "
)

editor_headers <- list(
  "X-Content-Type-Options" = "nosniff",
  "Referrer-Policy" = "no-referrer",
  "Cache-Control" = "no-store",
  "X-Frame-Options" = "DENY",
  "Content-Security-Policy" = editor_csp
)

#' Serve an alder notebook
#'
#' Start the local alder web app for a notebook: a derivation DAG over
#' \code{# \%\%} cells is computed, cells execute in dependency order in a
#' dedicated R worker process, and the UI supports editing, reactive
#' execution (ADR 0002), \code{ui$} widgets with explicit \code{$value}
#' (ADR 0003), and interruptible execution.
#'
#' Only the worker is executed as a separate process for isolation; it is
#' not a security sandbox, so only trusted notebook code should be run.
#' With \code{sandbox = TRUE} the worker runs with an isolated project
#' library (\code{.alder/renv/library} under the notebook directory) and
#' declared packages install into it.
#'
#' @param path Path to a notebook file (plain \code{.R} with \code{# \%\%}
#'   cells, per ADR 0001). Must be \code{NULL} or one nonempty valid-UTF-8
#'   string. When \code{NULL}, an empty notebook with no save path is
#'   served; a nonexistent path is created only on Save.
#' @param host Interface to bind; defaults to loopback only. A non-loopback
#'   bind requires an explicit \code{allowed_origins}.
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
#' @param allowed_origins For loopback binds, optional explicit trusted
#'   origins; for non-loopback binds, required. \code{NULL} on loopback
#'   allows exactly \code{http://127.0.0.1:<port>},
#'   \code{http://localhost:<port>}, and \code{http://[::1]:<port>}.
#' @param sandbox Run the notebook worker with an isolated package library
#'   (\code{.alder/renv/library} under the notebook directory) prepended to
#'   \code{R_LIBS_USER}; declared packages install into it. Requires a
#'   notebook \code{path}; \code{sandbox = TRUE} with a \code{NULL} path or
#'   a gallery directory is an error.
#' @return An \code{alder_server} list wrapping the httpuv server, the
#'   notebook \code{Session}, and the worker.
#' @export
start_alder <- function(path = NULL, host = "127.0.0.1", port = 8899L,
                        open = FALSE,
                        execution_mode = NULL,
                        run_on_startup = NULL,
                        allowed_origins = NULL,
                        sandbox = FALSE) {
  # --- argument validation ------------------------------------------------
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
  }

  gallery <- !is.null(path) && dir.exists(path)
  if (!is.character(host) || length(host) != 1L || is.na(host) ||
      !nzchar(host)) {
    stop("`host` must be a nonempty string")
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
    nb <- parse_notebook_lines(NULL, character())
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
  booted <- FALSE
  deadline <- Sys.time() + 15
  while (!booted && Sys.time() < deadline) {
    if (!worker$alive()) break
    done <- FALSE
    worker$send("ping", on_response = function(ctx, resp) done <<- TRUE)
    later::run_now(0.05)
    booted <- done
  }
  if (!booted) {
    try(worker$kill(), silent = TRUE)
    cleanup()
    stop("worker failed to start")
  }

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

  # Editor intelligence is optional. A missing or failed languageserver must
  # not prevent the notebook worker and HTTP UI from starting.
  lsp <- tryCatch(
    LspClient$new(nb, path = path),
    error = function(e) NULL
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
    gallery_last_used <- new.env(parent = emptyenv())
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
  gallery_get_context <- function(key) {
    if (!gallery) return(NULL)
    entry <- alder_gallery_entry(path, key)
    if (is.null(entry)) return(NULL)
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
  call_handler <- function(req) {
    path_req <- sub("\\?.*$", "", req$PATH_INFO %||% "")
    method <- req$REQUEST_METHOD %||% ""

    if (!validate_origin(req, origins, hosts)) {
      return(error_res("forbidden_origin", "origin not allowed", 403L))
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
        worker <- gallery_context$worker
        artifact_dir <- gallery_context$artifact_dir
        upload_dir <- gallery_context$upload_dir
        cache_dir <- gallery_context$cache_dir
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
      res <- file_res(p, "text/html; charset=utf-8")
      res$headers <- c(res$headers, editor_headers)
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
      res <- file_res(p, "text/html; charset=utf-8")
      res$headers <- c(res$headers, editor_headers)
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
                    "/api/widget", "/api/upload", "/api/value", "/api/runtime",
                    "/api/interrupt", "/api/save", "/api/lsp", "/api/format",
                    "/api/export", "/api/check", "/api/packages", "/api/log")

    if (!(path_req %in% api_routes)) {
      return(error_res("not_found", "not found", 404L))
    }

    if (identical(path_req, "/api/state")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      return(json_res(sess$state()))
    }
    if (identical(path_req, "/api/config") && identical(method, "GET")) {
      return(ok_res(config = sess$state()$config))
    }
    if (identical(path_req, "/api/app") && identical(method, "GET")) {
      return(ok_res(app = sess$state()$app))
    }
    if (identical(path_req, "/api/layout") && identical(method, "GET")) {
      return(ok_res(layout = sess$state()$layout))
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
      lv <- body$level %||% "error"
      if (!is.character(lv) || length(lv) != 1L || is.na(lv) || !nzchar(lv)) {
        lv <- "error"
      }
      msg <- body$message
      if (!is.character(msg) || length(msg) != 1L || is.na(msg)) {
        msg <- "(no message)"
      }
      attrs <- character(0)
      if (nzchar(body$source %||% "")) {
        attrs <- c(attrs, paste0("source=", body$source))
      }
      if (nzchar(body$url %||% "")) {
        attrs <- c(attrs, paste0("url=", body$url))
      }
      if (nzchar(body$stack %||% "")) {
        attrs <- c(attrs, paste0("stack=", gsub("\n", " ", body$stack)))
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
        return(ok_res(layout = sess$state()$layout))
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
        path_now <- sess$notebook_snapshot()$path
        if (identical(body$op, "declare")) {
          if (is.null(path_now) || is.na(path_now) || !nzchar(path_now)) {
            alder_abort("notebook_has_no_path",
                        "package declarations require a notebook path")
          }
          result <- alder_declare(supplied, path_now)
          ok_res(packages = result$declared, path = result$metadata)
        } else {
          result <- alder_install(supplied, path = path_now)
          if (!isTRUE(result$ok)) {
            error <- result$error %||% list()
            alder_abort(error$code %||% "install_failed",
                        error$message %||% "package installation failed")
          }
          ok_res(packages = result$installed, missing = result$missing,
                 lib = result$lib)
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
                   "textDocument/documentSymbol", "textDocument/signatureHelp")
      if (!body$method %in% allowed) {
        return(error_res("invalid_request", "unsupported language-server method",
                         400L))
      }
      if (!is.list(body$params)) {
        return(error_res("invalid_request", "params must be an object", 400L))
      }
      return(session_call({
        if (is.null(lsp) || !lsp$alive()) {
          alder_abort("lsp_unavailable", "language server is unavailable")
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
            alder_abort(code, msg)
          }
        )
        # A publishDiagnostics notification may have arrived with the
        # response. Only these mapped diagnostics are merged into state.
        sess$set_lsp_diagnostics(lsp$diagnostics_by_cell(nb_now))
        ok_res(result = result)
      }))
    }

    # --- /api/format -------------------------------------------------------
    if (identical(path_req, "/api/format")) {
      v <- validate_body(body, list(
        cell = list(type = "scalar_char", required = FALSE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        nb_now <- sess$notebook_snapshot()
        formatted <- format_notebook_source(nb_now, body$cell %||% NULL)
        result <- sess$apply_formatted(formatted$bodies)
        if (!is.null(lsp) && lsp$alive()) {
          try(lsp$sync_document(sess$notebook_snapshot()), silent = TRUE)
        }
        ok_res(changed = result$changed, version = result$version)
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
        validate_body(body, list(cell = list(type = "scalar_char",
                                             required = TRUE)))
      } else {
        validate_body(body, list(all = list(type = "scalar_logical",
                                            required = TRUE,
                                            exact = TRUE)))
      }
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      return(session_call({
        if (has_cell) {
          sess$run_cell(body$cell)
          ok_res(run_id = sess$state()$runtime$active_run_id, status = 202L)
        } else if (identical(sess$get_execution_mode(), "lazy")) {
          # lazy "Run stale": run every stale cell plus required ancestors;
          # a plain run_all would re-execute current cells and reset widgets.
          sess$run_stale()
          ok_res(run_id = sess$state()$runtime$active_run_id, status = 202L)
        } else {
          sess$run_all()
          ok_res(run_id = sess$state()$runtime$active_run_id, status = 202L)
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
      if (op == "sql") {
        v <- validate_body(body, list(
          op = list(type = "scalar_char", required = TRUE),
          cell = list(type = "scalar_char", required = TRUE),
          query = list(type = "scalar_char", required = TRUE),
          conn = list(type = "scalar_char", required = TRUE, nullable = TRUE),
          into = list(type = "scalar_char", required = TRUE),
          expected_revision = list(type = "scalar_num", required = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        conn <- body$conn
        if (!is.null(conn) && !nzchar(trimws(conn))) conn <- NULL
        return(session_call({
          r <- sess$set_sql_cell(body$cell, body$query, conn, body$into,
                                 body$expected_revision)
          ok_res(id = r$id, revision = r$revision, version = r$version)
        }))
      }
      if (op == "edit") {
        v <- validate_body(body, list(
          op = list(type = c("edit", "add", "delete"), required = TRUE),
          id = list(type = "scalar_char", required = TRUE),
          body = list(type = "array_char", required = TRUE),
          type = list(type = "scalar_char", required = TRUE),
          expected_revision = list(type = "scalar_num", required = TRUE)))
        if (!is.null(v)) return(error_res(v$code, v$message, v$status))
        if (!body$type %in% c("code", "markdown", "sql")) {
          return(error_res("invalid_request",
                           "cell type must be code, markdown, or sql", 400L))
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
        if (!body$type %in% c("code", "markdown", "sql")) {
          return(error_res("invalid_request",
                           "cell type must be code, markdown, or sql", 400L))
        }
        return(session_call({
          r <- sess$add_cell(body$after, body_chars(body$body), body$type)
          ok_res(id = r$id, revision = r$revision, version = r$version)
        }))
      }
      v <- validate_body(body, list(
        op = list(type = c("edit", "add", "delete"), required = TRUE),
        id = list(type = "scalar_char", required = TRUE),
        expected_revision = list(type = "scalar_num", required = TRUE)))
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
    try(utils::browseURL(paste0("http://", host, ":", port, "/")),
        silent = TRUE)
  }
  structure(list(server = server, session = sess, lsp = lsp,
                 worker = worker, gallery = gallery,
                 gallery_root = if (gallery) path else NULL,
                 gallery_sessions = if (gallery) gallery_sessions else NULL,
                 artifact_dir = artifact_dir,
                 upload_dir = upload_dir, cache_dir = cache_dir,
                 stopped = FALSE), class = "alder_server")
}

#' @rdname start_alder
#' @param srv An \code{alder_server} object returned by \code{start_alder}.
#' @export
stop_alder <- function(srv) {
  if (isTRUE(srv$stopped)) return(invisible(srv))
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