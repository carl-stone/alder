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

file_res <- function(path, ctype) {
  if (!file.exists(path) || dir.exists(path)) {
    return(error_res("not_found", "not found", 404L))
  }
  list(status = 200L,
       headers = list(
         "Content-Type" = ctype,
         "Cache-Control" = "no-store",
         "X-Content-Type-Options" = "nosniff",
         "Referrer-Policy" = "no-referrer"
       ),
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
safe_child_path <- function(root, encoded_rel, allowed_ext) {
  rel <- tryCatch(utils::URLdecode(encoded_rel), error = function(e) "")
  if (is.na(rel) || !nzchar(rel)) return(NULL)
  nul_re <- paste0("[", rawToChar(as.raw(0)), "/\\\\]")   # NUL or any separator
  if (grepl(nul_re, rel)) return(NULL)
  if (grepl("(^|[.])[.][.]?$", rel)) return(NULL)      # "." / ".." endings
  if (startsWith(rel, ".")) return(NULL)                # dotfiles
  ext <- tolower(tools::file_ext(rel))
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
  html = "text/html; charset=utf-8",
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

# Map an alder_error condition code to HTTP status (plan §7)
alder_error_status <- function(code) {
  switch(code,
    invalid_request = 400L,
    notebook_has_no_path = 400L,
    forbidden_origin = 403L,
    not_found = 404L,
    method_not_allowed = 405L,
    graph_invalid = 409L,
    save_conflict = 409L,
    alder_save_conflict = 409L,
    source_conflict = 409L,
    run_in_progress = 409L,
    operation_in_progress = 409L,
    widget_not_current = 409L,
    no_run_in_progress = 409L,
    payload_too_large = 413L,
    unsupported_media_type = 415L,
    save_failed = 500L,
    internal_error = 500L,
    worker_unavailable = 503L,
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

# ---------------------------------------------------------------------------
# Application builder
# ---------------------------------------------------------------------------

start_alder <- function(path = NULL, host = "127.0.0.1", port = 8899L,
                        open = FALSE,
                        execution_mode = c("automatic", "lazy"),
                        run_on_startup = TRUE,
                        allowed_origins = NULL) {
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
  execution_mode <- match.arg(execution_mode)
  if (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
      is.na(run_on_startup)) {
    stop("`run_on_startup` must be TRUE or FALSE")
  }
  if (!is.null(allowed_origins) &&
      (!is.character(allowed_origins) || !length(allowed_origins))) {
    stop("`allowed_origins` must be NULL or a character vector")
  }

  # --- bootstrap ----------------------------------------------------------
  app_dir <- alder_app_dir()
  worker_script <- alder_worker_script()

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

  artifact_dir <- tempfile("alder-artifacts-")
  dir.create(artifact_dir, recursive = TRUE)

  cleanup <- function() {
    if (dir.exists(artifact_dir)) {
      try(unlink(artifact_dir, recursive = TRUE), silent = TRUE)
    }
  }

  worker <- tryCatch(
    .spawn_worker(worker_script, app_dir, artifact_dir),
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
                run_on_startup = run_on_startup, disk_version = disk_version),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )

  origins <- tryCatch(
    build_origins(host, port, allowed_origins),
    error = function(e) {
      sess$stop()
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )
  hosts <- origin_hosts(origins)

  # --- httpuv call handler ------------------------------------------------
  call_handler <- function(req) {
    path_req <- sub("\\?.*$", "", req$PATH_INFO)
    method <- req$REQUEST_METHOD

    if (!validate_origin(req, origins, hosts)) {
      return(error_res("forbidden_origin", "origin not allowed", 403L))
    }

    need <- function(allowed) {
      if (method %in% allowed) return(NULL)
      res <- error_res("method_not_allowed",
                       paste("method not allowed:", method), 405L)
      res$headers$Allow <- paste(allowed, collapse = ", ")
      res
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
      f <- safe_child_path(file.path(app_dir, "static"),
                           sub("^/static/", "", path_req),
                           c("js", "css"))
      if (is.null(f)) return(error_res("not_found", "not found", 404L))
      ext <- tools::file_ext(f)
      ctype <- if (identical(ext, "js")) "text/javascript; charset=utf-8"
        else paste0("text/", ext, "; charset=utf-8")
      return(file_res(f, ctype))
    }

    # --- artifact (plot) files --------------------------------------------
    if (startsWith(path_req, "/plot/")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      f <- safe_child_path(artifact_dir, sub("^/plot/", "", path_req),
                           c("png", "html"))
      if (is.null(f)) return(error_res("not_found", "not found", 404L))
      ct <- artifact_content_type(tools::file_ext(f))
      if (is.null(ct)) return(error_res("not_found", "not found", 404L))
      return(file_res(f, ct))
    }

    # --- API: unknown paths are 404 before any body parsing ---------------
    api_routes <- c("/api/state", "/api/run", "/api/cell", "/api/widget",
                    "/api/value", "/api/runtime", "/api/interrupt", "/api/save")
    if (!(path_req %in% api_routes)) {
      return(error_res("not_found", "not found", 404L))
    }

    if (identical(path_req, "/api/state")) {
      m <- need("GET")
      if (!is.null(m)) return(m)
      return(json_res(sess$state()))
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
        ok_res(path = r$path, etag = r$etag, version = r$version)
      }))
    }

    parsed <- read_json_body(req)
    if (!is.null(parsed$error)) {
      return(error_res(parsed$error$code, parsed$error$message,
                       parsed$error$status))
    }
    body <- parsed$body


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
      if (op == "edit") {
        v <- validate_body(body, list(
          op = list(type = c("edit", "add", "delete"), required = TRUE),
          id = list(type = "scalar_char", required = TRUE),
          body = list(type = "array_char", required = TRUE),
          type = list(type = "scalar_char", required = TRUE),
          expected_revision = list(type = "scalar_num", required = TRUE)))
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
        value = list(type = "scalar", required = FALSE),
        index = list(type = "scalar_int", required = FALSE),
        source = list(type = "scalar_char", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      has_val <- "value" %in% names(body)
      has_idx <- "index" %in% names(body)
      if (has_val == has_idx) {
        return(error_res("invalid_request",
                         "must provide exactly one of `value` or `index`",
                         400L))
      }
      if (!body$source %in% c("editor", "app")) {
        return(error_res("invalid_request",
                         "source must be editor or app", 400L))
      }
      return(session_call({
        upd <- if (has_idx) list(index = body$index) else list(value = body$value)
        tok <- sess$set_widget(body$name, upd, body$source)
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
        execution_mode = list(type = "scalar_char", required = TRUE)))
      if (!is.null(v)) return(error_res(v$code, v$message, v$status))
      if (!body$execution_mode %in% c("automatic", "lazy")) {
        return(error_res("invalid_request",
                         "execution_mode must be automatic or lazy", 400L))
      }
      return(session_call({
        sess$set_runtime(body$execution_mode)
        ok_res(execution_mode = body$execution_mode,
               version = sess$state()$version)
      }))
    }

    error_res("not_found", "not found", 404L)
  }

  # --- start httpuv server ---------------------------------------------------
  server <- tryCatch(
    httpuv::startServer(host, port, list(call = call_handler)),
    error = function(e) {
      sess$stop()
      try(worker$kill(), silent = TRUE)
      cleanup()
      stop(e)
    }
  )
  cat("alder running at http://", host, ":", port, "/\n", sep = "")
  if (open) {
    try(utils::browseURL(paste0("http://", host, ":", port, "/")),
        silent = TRUE)
  }
  structure(list(server = server, session = sess, artifact_dir = artifact_dir,
                 stopped = FALSE),
            class = "alder_server")
}

stop_alder <- function(srv) {
  if (isTRUE(srv$stopped)) return(invisible(srv))
  srv$stopped <- TRUE
  try(srv$session$stop(), silent = TRUE)
  try(httpuv::stopServer(srv$server), silent = TRUE)
  if (!is.null(srv$artifact_dir) && dir.exists(srv$artifact_dir)) {
    try(unlink(srv$artifact_dir, recursive = TRUE, force = TRUE),
        silent = TRUE)
  }
  invisible(srv)
}