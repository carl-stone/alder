# httpuv server: serves the frontend and a JSON API over one Session.
#
# The R worker runs as a separate process (ADR 0004); httpuv and the worker's
# non-blocking poll share the `later` event loop, so a long cell never blocks
# the editor. All state changes flow through Session, which owns the rerun
# model (ADR 2).
#
# Artifacts (PNG/HTML renders) live in one server-owned directory
# (`ALDER_ARTIFACT_DIR` passed to the worker) and are served through
# `/plot/<basename>` with a normalized containment check; static frontend
# assets are confined to the app directory through the same helper.

# Find the frontend assets (dev checkout or installed package).
alder_app_dir <- function() {
  dev <- file.path(getwd(), "inst", "app")
  if (dir.exists(dev)) return(dev)
  sys <- system.file("app", package = "alder")
  if (nzchar(sys) && dir.exists(sys)) return(sys)
  stop("alder frontend assets not found")
}

alder_worker_script <- function() {
  dev <- file.path(getwd(), "inst", "worker", "worker.R")
  if (file.exists(dev)) return(dev)
  sys <- system.file("worker", "worker.R", package = "alder")
  if (nzchar(sys) && file.exists(sys)) return(sys)
  stop("alder worker script not found")
}

# The httpuv `call` handler returns a Rook-style response:
#   list(status = <int>, headers = list(...), body = <raw|character>)
json_res <- function(obj, status = 200L) {
  list(
    status = as.integer(status),
    headers = list(
      "Content-Type" = "application/json; charset=utf-8",
      "Access-Control-Allow-Origin" = "*"
    ),
    body = jsonlite::toJSON(obj, auto_unbox = TRUE, null = "null",
                            na = "null", force = TRUE)
  )
}

file_res <- function(path, ctype) {
  if (!file.exists(path) || dir.exists(path)) return(json_res(list(error = "not found"), 404))
  list(status = 200L, headers = list("Content-Type" = ctype, "Cache-Control" = "no-store"),
       body = readBin(path, "raw", n = file.info(path)$size))
}

read_json_body <- function(req) {
  raw <- tryCatch(req$rook.input$read_lines(1e6), error = function(e) character())
  if (length(raw) == 0L || !nzchar(raw)) return(list())
  tryCatch(jsonlite::fromJSON(raw, simplifyVector = FALSE),
           error = function(e) list())
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
# Application builder
# ---------------------------------------------------------------------------
start_alder <- function(path = NULL, host = "127.0.0.1", port = 8899,
                        open = FALSE) {
  app_dir <- alder_app_dir()
  worker_script <- alder_worker_script()

  nb <- if (!is.null(path) && file.exists(path)) read_notebook(path)
    else parse_notebook_lines(NULL, character())

  # One writable artifact directory per server; the worker renders into it
  # and the server serves from it. Cleaned up with the server itself.
  artifact_dir <- tempfile("alder-artifacts-")
  if (file.exists(artifact_dir)) unlink(artifact_dir, recursive = TRUE)
  dir.create(artifact_dir, recursive = TRUE)

  stop_alder_start <- function() {
    try(unlink(artifact_dir, recursive = TRUE), silent = TRUE)
  }

  worker <- tryCatch(
    .spawn_worker(worker_script, getwd(), artifact_dir),
    error = function(e) {
      stop_alder_start()
      stop(e)
    }
  )
  sess <- Session$new(nb, worker)

  call_handler <- function(req) {
    path_req <- sub("\\?.*$", "", req$PATH_INFO)
    method <- req$REQUEST_METHOD

    # ---- static assets ------------------------------------------------
    if (identical(path_req, "/") || identical(path_req, "/index.html")) {
      return(file_res(file.path(app_dir, "index.html"), "text/html; charset=utf-8"))
    }
    if (startsWith(path_req, "/static/")) {
      f <- safe_child_path(file.path(app_dir, "static"), sub("^/static/", "", path_req), c("js", "css"))
      if (is.null(f)) return(json_res(list(error = "not found"), 404))
      ext <- tools::file_ext(f)
      ctype <- if (identical(ext, "js")) "text/javascript; charset=utf-8" else paste0("text/", ext, "; charset=utf-8")
      return(file_res(f, ctype))
    }

    # ---- API ----------------------------------------------------------
    if (identical(path_req, "/api/state") && method == "GET") {
      return(json_res(sess$state()))
    }
    if (identical(path_req, "/api/run") && method == "POST") {
      body <- read_json_body(req)
      cell <- body$cell %||% NULL
      if (!is.null(sess$worker$proc) && !sess$worker_available()) {
        return(json_res(list(ok = FALSE, error = "worker is not running"), 503))
      }
      return(tryCatch({
        # run_cell/run_all enqueue asynchronously and return the session;
        # the successful response is a JSON ok, not the session object.
        if (!is.null(cell)) sess$run_cell(cell) else sess$run_all()
        json_res(list(ok = TRUE))
      }, error = function(e) json_res(list(ok = FALSE, error = conditionMessage(e)), 400)))
    }
    if (identical(path_req, "/api/cell") && method == "POST") {
      body <- read_json_body(req)
      return(tryCatch({
        if (!is.null(body$id) && !is.null(body$body)) {
          sess$set_cell_body(body$id, body$body)
        } else if (!is.null(body$add)) {
          sess$add_cell(body$code %||% character(), body$type %||% "code", body$after %||% NULL)
        } else if (!is.null(body$delete)) {
          sess$delete_cell(body$delete)
        }
        json_res(list(ok = TRUE))
      }, error = function(e) json_res(list(ok = FALSE, error = conditionMessage(e)), 400)))
    }
    if (identical(path_req, "/api/widget") && method == "POST") {
      body <- read_json_body(req)
      return(api_worker_guard(sess, {
        sess$set_widget(body$name, body$value)
        json_res(list(ok = TRUE))
      }))
    }
    if (identical(path_req, "/api/interrupt") && method == "POST") {
      sess$interrupt()
      return(json_res(list(ok = TRUE)))
    }
    if (identical(path_req, "/api/value") && method == "POST") {
      body <- read_json_body(req)
      # Async: the response is a JSON ack; the fetched value lands in
      # state().last_value on the next state poll.
      return(api_worker_guard(sess, {
        sess$request_value(body$name)
        json_res(list(ok = TRUE))
      }))
    }
    if (identical(path_req, "/api/save") && method == "POST") {
      if (is.null(sess$notebook$path) || !nzchar(sess$notebook$path)) {
        return(json_res(list(ok = FALSE, error = "notebook has no path"), 400))
      }
      write_notebook(sess$notebook)
      sess$changed <- FALSE
      return(json_res(list(ok = TRUE, path = sess$notebook$path)))
    }
    if (startsWith(path_req, "/plot/") && method == "GET") {
      f <- safe_child_path(artifact_dir, sub("^/plot/", "", path_req), c("png", "html"))
      if (is.null(f)) return(json_res(list(error = "not found"), 404))
      ct <- artifact_content_type(tools::file_ext(f))
      if (is.null(ct)) return(json_res(list(error = "not found"), 404))
      return(file_res(f, ct))
    }

    json_res(list(error = "not found"), 404)
  }

  server <- tryCatch(
    httpuv::startServer(host, port, list(call = call_handler)),
    error = function(e) {
      worker$kill()
      stop_alder_start()
      stop(e)
    }
  )
  cat("alder running at http://", host, ":", port, "/\n", sep = "")
  if (open) try(utils::browseURL(paste0("http://", host, ":", port, "/")), silent = TRUE)
  structure(list(server = server, session = sess, artifact_dir = artifact_dir),
            class = "alder_server")
}

# Worker-loss conditions become HTTP 503; everything else stays JSON 400/500.
api_worker_guard <- function(sess, expr) {
  if (!sess$worker_available()) {
    return(json_res(list(ok = FALSE, error = "worker is not running"), 503))
  }
  tryCatch(expr, error = function(e) json_res(list(ok = FALSE, error = conditionMessage(e)), 400))
}

stop_alder <- function(srv) {
  # Order matters: worker first, httpuv second, artifact directory last.
  try(srv$session$worker$kill(), silent = TRUE)
  try(httpuv::stopServer(srv$server), silent = TRUE)
  if (!is.null(srv$artifact_dir) && dir.exists(srv$artifact_dir)) {
    try(unlink(srv$artifact_dir, recursive = TRUE, force = TRUE), silent = TRUE)
  }
  invisible(srv)
}