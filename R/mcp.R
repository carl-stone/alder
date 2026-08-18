# MCP agent surface: line-delimited JSON-RPC 2.0 over stdio.
#
# The MCP transport deliberately stays independent of httpuv.  A local
# context owns the same Session/Worker pair as the editor, while a URL context
# translates tool calls to the running server's REST API.  The request
# dispatcher is kept as a package-internal function so tests and embedders can
# exercise the protocol without taking over stdin/stdout.

MCP_PROTOCOL_VERSION <- "2024-11-05"

MCP_TIMEOUT_SECONDS <- 120

mcp_empty_object <- function() {
  structure(list(), names = character())
}

mcp_json <- function(value) {
  as.character(jsonlite::toJSON(value, auto_unbox = TRUE, null = "null",
                                na = "null", force = TRUE))
}

mcp_schema <- function(properties = list(), required = character()) {
  out <- list(
    type = "object",
    properties = if (length(properties)) properties else mcp_empty_object()
  )
  if (length(required)) out$required <- I(as.character(required))
  out
}

mcp_type <- function(type, description = NULL, enum = NULL, items = NULL) {
  out <- list(type = if (length(type) == 1L) type else I(type))
  if (!is.null(description)) out$description <- description
  if (!is.null(enum)) out$enum <- I(as.character(enum))
  if (!is.null(items)) out$items <- items
  out
}

mcp_any <- function(description = NULL) {
  out <- mcp_empty_object()
  if (!is.null(description)) out$description <- description
  out
}

mcp_nullable <- function(type, description = NULL) {
  mcp_type(c(type, "null"), description = description)
}

# The names and order are part of the public MCP contract (plan Phase 12).
MCP_TOOL_DEFINITIONS <- local({
  cell <- mcp_type("string", "Stable cell id")
  after <- mcp_nullable("string", "Insert after this cell; null inserts at the beginning")
  body <- mcp_type("array", "Cell source lines", items = mcp_type("string"))
  kind <- mcp_type("string", "Cell kind", enum = c("code", "markdown", "sql"))
  revision <- mcp_type("number", "Expected source revision")
  path <- mcp_type("array", "Composite widget path", items = mcp_type("string"))
  source <- mcp_type("string", "Update source", enum = c("editor", "app"))
  list(
    list(name = "notebook_state",
         description = "Return the complete notebook state snapshot.",
         inputSchema = mcp_schema()),
    list(name = "list_cells",
         description = "List cells in document order.",
         inputSchema = mcp_schema()),
    list(name = "read_cell",
         description = "Read one cell's source and metadata.",
         inputSchema = mcp_schema(list(cell = cell), "cell")),
    list(name = "add_cell",
         description = "Insert a new code, markdown, or SQL cell.",
         inputSchema = mcp_schema(
           list(after = after, body = body, type = kind),
           c("body", "type"))),
    list(name = "edit_cell",
         description = "Replace one cell's source without executing it.",
         inputSchema = mcp_schema(
           list(cell = cell, body = body, type = kind,
                expected_revision = revision),
           c("cell", "body", "type"))),
    list(name = "delete_cell",
         description = "Delete a cell.",
         inputSchema = mcp_schema(
           list(cell = cell, expected_revision = revision), "cell")),
    list(name = "move_cell",
         description = "Move a cell after another cell.",
         inputSchema = mcp_schema(
           list(cell = cell, after = after), "cell")),
    list(name = "rename_cell",
         description = "Set or clear a cell's stable display name.",
         inputSchema = mcp_schema(
           list(cell = cell, name = mcp_nullable("string")), c("cell", "name"))),
    list(name = "disable_cell",
         description = "Enable or disable a cell and its descendants.",
         inputSchema = mcp_schema(
           list(cell = cell, disabled = mcp_type("boolean")),
           c("cell", "disabled"))),
    list(name = "run_cell",
         description = "Run one cell and its required reactive dependencies.",
         inputSchema = mcp_schema(list(cell = cell), "cell")),
    list(name = "run_all",
         description = "Run all runnable cells.",
         inputSchema = mcp_schema()),
    list(name = "run_stale",
         description = "Run stale cells and required ancestors.",
         inputSchema = mcp_schema()),
    list(name = "interrupt",
         description = "Interrupt the active run.",
         inputSchema = mcp_schema()),
    list(name = "get_value",
         description = "Render and return a top-level notebook value.",
         inputSchema = mcp_schema(
           list(name = mcp_type("string", "Top-level binding name")), "name")),
    list(name = "set_widget",
         description = "Apply one widget update and return its operation token.",
         inputSchema = mcp_schema(
           list(
             name = mcp_type("string", "Top-level widget binding name"),
             path = path,
             value = list(description = "Widget value"),
             index = mcp_type("integer"),
             indices = list(type = "array", items = mcp_type("integer")),
             selected = list(type = "array", items = mcp_type("integer")),
             ops = list(type = "array"),
             submit = mcp_type("boolean"),
             paused = mcp_type("boolean"),
             source = source
           ),
           "name")),
    list(name = "save",
         description = "Atomically save the notebook to its path.",
         inputSchema = mcp_schema()),
    list(name = "export",
         description = "Export the notebook in a supported static format.",
         inputSchema = mcp_schema(
           list(
             format = mcp_type("string", enum = c("html", "md", "script",
                                                  "ipynb", "qmd", "session")),
             include_code = mcp_type("boolean")
           ),
           "format")),
    list(name = "check",
         description = "Analyze the notebook and return diagnostics.",
         inputSchema = mcp_schema())
  )
})

MCP_TOOL_NAMES <- vapply(MCP_TOOL_DEFINITIONS, `[[`, character(1), "name")

mcp_request_id <- function(request) {
  if (is.list(request) && "id" %in% names(request)) request$id else NULL
}

mcp_rpc_response <- function(id, result) {
  list(jsonrpc = "2.0", id = id, result = result)
}

mcp_rpc_error <- function(id, code, message, data = NULL) {
  out <- list(jsonrpc = "2.0", id = id,
              error = list(code = as.integer(code), message = as.character(message)))
  if (!is.null(data)) out$error$data <- data
  out
}

mcp_tool_content <- function(payload, is_error = FALSE) {
  list(
    content = list(list(type = "text", text = mcp_json(payload))),
    isError = isTRUE(is_error)
  )
}

mcp_ok_payload <- function(value = NULL) {
  if (is.null(value)) return(list(ok = TRUE))
  if (is.list(value) && identical(value$ok %||% NULL, TRUE)) return(value)
  c(list(ok = TRUE), value)
}

mcp_error_payload <- function(code, message) {
  list(ok = FALSE,
       error = list(code = as.character(code), message = as.character(message)))
}

mcp_error_from_condition <- function(e) {
  if (inherits(e, "alder_error")) {
    return(mcp_error_payload(e$code %||% "internal_error", conditionMessage(e)))
  }
  mcp_error_payload("internal_error", conditionMessage(e))
}

mcp_scalar_character <- function(value, label, nullable = FALSE) {
  if (nullable && is.null(value)) return(NULL)
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !nzchar(value) || any(charToRaw(value) == as.raw(0)) ||
      grepl("[\r\n]", value, perl = TRUE)) {
    alder_abort("invalid_request", paste0(label, " must be a nonempty string"))
  }
  value
}

mcp_scalar_logical <- function(value, label) {
  if (!is.logical(value) || length(value) != 1L || is.na(value)) {
    alder_abort("invalid_request", paste0(label, " must be a boolean"))
  }
  isTRUE(value)
}

mcp_scalar_number <- function(value, label, nullable = FALSE) {
  if (nullable && is.null(value)) return(NULL)
  if (!is.numeric(value) || length(value) != 1L || is.na(value) ||
      !is.finite(value)) {
    alder_abort("invalid_request", paste0(label, " must be a finite number"))
  }
  value
}

mcp_has <- function(x, name) name %in% names(x)

mcp_param_object <- function(request) {
  params <- request$params %||% list()
  if (!is.list(params) || is.null(names(params)) && length(params)) {
    alder_abort("invalid_request", "params must be an object")
  }
  params
}

mcp_character_array <- function(value, label, nullable = FALSE) {
  if (nullable && is.null(value)) return(character())
  if (is.character(value)) {
    out <- value
  } else if (is.list(value)) {
    out <- if (length(value)) unlist(value, use.names = FALSE) else character()
  } else {
    out <- NULL
  }
  if (is.null(out) || !is.character(out) || anyNA(out) ||
      any(vapply(out, function(x) {
        any(charToRaw(x) == as.raw(0)) || grepl("[\r\n]", x, perl = TRUE)
      }, logical(1)))) {
    alder_abort("invalid_request", paste0(label, " must be a string array"))
  }
  out
}

mcp_state_cells <- function(state) {
  cells <- state$cells %||% list()
  if (!is.list(cells)) return(list())
  cells
}

mcp_find_cell <- function(state, id) {
  id <- mcp_scalar_character(id, "cell")
  cells <- mcp_state_cells(state)
  if (!length(cells)) alder_abort("not_found", paste("no such cell:", id))
  hits <- vapply(cells, function(cell) identical(cell$id %||% NULL, id), FALSE)
  if (!any(hits)) alder_abort("not_found", paste("no such cell:", id))
  cells[[which(hits)[[1L]]]]
}

mcp_cell_id <- function(params, required = TRUE) {
  value <- if (mcp_has(params, "cell")) params$cell else params$id
  if (!required && is.null(value)) return(NULL)
  mcp_scalar_character(value, "cell")
}

mcp_local_wait <- function(context, done, timeout = NULL) {
  timeout <- timeout %||% context$timeout %||% MCP_TIMEOUT_SECONDS
  timeout <- mcp_scalar_number(timeout, "timeout")
  deadline <- Sys.time() + timeout
  repeat {
    later::run_now(0.05)
    if (isTRUE(done())) return(invisible(TRUE))
    if (Sys.time() >= deadline) {
      alder_abort("mcp_timeout", "MCP action timed out")
    }
  }
}

mcp_local_context <- function(path = NULL) {
  if (!is.null(path)) {
    mcp_scalar_character(path, "path")
    if (!nzchar(path)) alder_abort("invalid_request", "path must not be empty")
    if (dir.exists(path)) stop("notebook path is a directory: ", path, call. = FALSE)
    if (file.exists(path)) {
      path <- normalizePath(path, mustWork = TRUE)
      nb <- read_notebook(path)
      disk_version <- list(
        exists = TRUE,
        bytes = readBin(path, "raw", n = file.info(path)$size)
      )
    } else {
      parent <- dirname(path)
      if (!dir.exists(parent)) {
        stop("parent directory of `path` does not exist: ", parent, call. = FALSE)
      }
      path <- file.path(normalizePath(parent, mustWork = TRUE), basename(path))
      nb <- parse_notebook_lines(path, character())
      disk_version <- list(exists = FALSE, bytes = raw())
    }
  } else {
    nb <- parse_notebook_lines(NA_character_, character())
    disk_version <- list(exists = NA, bytes = raw())
  }

  artifact_dir <- tempfile("alder-mcp-artifacts-")
  if (!dir.create(artifact_dir, recursive = TRUE, showWarnings = FALSE)) {
    stop("could not create MCP artifact directory", call. = FALSE)
  }
  cache_dir <- if (is.null(path)) file.path(artifact_dir, "cache") else
    file.path(dirname(path), ".alder", "cache")
  if (!dir.exists(cache_dir) &&
      !dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE) &&
      !dir.exists(cache_dir)) {
    unlink(artifact_dir, recursive = TRUE, force = TRUE)
    stop("could not create MCP cache directory", call. = FALSE)
  }

  app_dir <- if (exists("alder_app_dir", mode = "function")) {
    alder_app_dir()
  } else {
    system.file("app", package = "alder", mustWork = TRUE)
  }
  worker_script <- if (exists("alder_worker_script", mode = "function")) {
    alder_worker_script()
  } else {
    system.file("worker", "worker.R", package = "alder", mustWork = TRUE)
  }
  worker <- tryCatch(
    .spawn_worker(worker_script, app_dir, artifact_dir, cache_dir),
    error = function(e) {
      unlink(artifact_dir, recursive = TRUE, force = TRUE)
      stop(e)
    }
  )

  booted <- FALSE
  # `env_snapshot` is a real worker command and therefore doubles as a
  # readiness probe (the worker protocol has no special ping command).
  worker$send("env_snapshot", on_response = function(context, response) {
    booted <<- isTRUE(response$ok)
  })
  deadline <- Sys.time() + 15
  while (!booted && Sys.time() < deadline) {
    later::run_now(0.05)
    if (!worker$alive()) break
  }
  if (!booted) {
    try(worker$kill(), silent = TRUE)
    unlink(artifact_dir, recursive = TRUE, force = TRUE)
    stop("worker failed to start", call. = FALSE)
  }

  session <- tryCatch(
    Session$new(nb, worker, execution_mode = "automatic",
                run_on_startup = TRUE, disk_version = disk_version),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      unlink(artifact_dir, recursive = TRUE, force = TRUE)
      stop(e)
    }
  )
  context <- new.env(parent = emptyenv())
  context$kind <- "local"
  context$path <- path
  context$url <- NULL
  context$session <- session
  context$worker <- worker
  context$artifact_dir <- artifact_dir
  context$cache_dir <- cache_dir
  context$timeout <- MCP_TIMEOUT_SECONDS
  context$dispatch <- function(request) mcp_dispatch(context, request)
  context$handle_request <- context$dispatch
  context$request_handler <- context$dispatch
  context$closed <- FALSE
  context$shutdown <- FALSE
  context$close <- function() {
    if (isTRUE(context$closed)) return(invisible())
    context$closed <- TRUE
    try(context$session$stop(), silent = TRUE)
    if (dir.exists(context$artifact_dir)) {
      try(unlink(context$artifact_dir, recursive = TRUE, force = TRUE), silent = TRUE)
    }
    invisible()
  }
  context$pump <- function(done, timeout = NULL) {
    mcp_local_wait(context, done, timeout)
  }

  # Startup execution is asynchronous; do not expose a context until it is
  # settled so the first request observes the same state as the HTTP client.
  context$pump(function() !isTRUE(context$session$state()$runtime$busy))
  context
}

mcp_http_context <- function(url, timeout = MCP_TIMEOUT_SECONDS) {
  mcp_scalar_character(url, "url")
  timeout <- mcp_scalar_number(timeout, "timeout")
  if (!grepl("^https?://[^[:space:]]+$", url, perl = TRUE)) {
    stop("`url` must be an http(s) URL", call. = FALSE)
  }
  if (!requireNamespace("curl", quietly = TRUE)) {
    stop("alder_mcp(url=) requires the curl package", call. = FALSE)
  }
  context <- new.env(parent = emptyenv())
  context$kind <- "url"
  context$url <- sub("/+$", "", url)
  context$path <- NULL
  context$session <- NULL
  context$dispatch <- function(request) mcp_dispatch(context, request)
  context$handle_request <- context$dispatch
  context$request_handler <- context$dispatch
  context$worker <- NULL
  context$artifact_dir <- NULL
  context$cache_dir <- NULL
  context$timeout <- timeout
  context$closed <- FALSE
  context$shutdown <- FALSE
  context$close <- function() {
    context$closed <- TRUE
    invisible()
  }
  context$request <- function(method, route, body = NULL) {
    mcp_http_request(context, method, route, body)
  }
  context
}
mcp_http_request <- function(context, method, route, body = NULL) {
  method <- toupper(method)
  if (!method %in% c("GET", "POST")) {
    alder_abort("invalid_request", "MCP HTTP method is unsupported")
  }
  if (!is.character(route) || length(route) != 1L || !startsWith(route, "/") ||
      any(charToRaw(route) == as.raw(0)) || grepl("[\r\n]", route, perl = TRUE)) {
    alder_abort("invalid_request", "MCP REST route is invalid")
  }
  timeout <- context$timeout %||% MCP_TIMEOUT_SECONDS
  timeout <- mcp_scalar_number(timeout, "timeout")
  handle <- curl::new_handle()
  args <- list(timeout = timeout, connecttimeout = min(timeout, 15))
  if (identical(method, "POST")) {
    args <- c(
      args,
      list(
        customrequest = "POST",
        postfields = if (is.null(body)) "" else mcp_json(body),
        httpheader = "Content-Type: application/json"
      )
    )
  }
  do.call(curl::handle_setopt, c(list(handle), args))
  response <- tryCatch(
    curl::curl_fetch_memory(paste0(context$url, route), handle = handle),
    error = function(e) alder_abort("internal_error", conditionMessage(e))
  )
  text <- tryCatch(rawToChar(response$content), error = function(e) "")
  value <- tryCatch(jsonlite::fromJSON(text, simplifyVector = FALSE),
                    error = function(e) NULL)
  if (!is.list(value)) {
    alder_abort("internal_error", "REST API returned invalid JSON")
  }
  status <- as.integer(response$status_code %||% 0L)
  if (status >= 400L || identical(value$ok %||% NULL, FALSE)) {
    error <- value$error %||% list()
    code <- error$code %||% if (status == 404L) "not_found" else "internal_error"
    message <- error$message %||% paste("REST request failed with HTTP", status)
    alder_abort(code, message)
  }
  value
}

mcp_backend <- function(path = NULL, url = NULL) {
  if (!is.null(path) && !is.null(url)) {
    stop("provide exactly one of `path` or `url`", call. = FALSE)
  }
  if (!is.null(url)) return(mcp_http_context(url))
  mcp_local_context(path)
}

mcp_context_state <- function(context) {
  if (identical(context$kind, "local")) return(context$session$state())
  context$request("GET", "/api/state")
}

mcp_wait_local_idle <- function(context) {
  context$pump(function() !isTRUE(context$session$state()$runtime$busy))
  invisible()
}

mcp_wait_local_value <- function(context) {
  context$pump(function() {
    operation <- context$session$state()$value_operation %||% NULL
    !is.null(operation) && !identical(operation$status %||% NULL, "pending")
  })
  invisible()
}

mcp_wait_http_value <- function(context) {
  timeout <- context$timeout %||% MCP_TIMEOUT_SECONDS
  timeout <- mcp_scalar_number(timeout, "timeout")
  deadline <- Sys.time() + timeout
  repeat {
    state <- context$request("GET", "/api/state")
    operation <- state$value_operation %||% NULL
    if (!is.null(operation) && !identical(operation$status %||% NULL, "pending")) {
      return(state)
    }
    if (Sys.time() >= deadline) alder_abort("mcp_timeout", "MCP value request timed out")
    Sys.sleep(0.05)
  }
}

mcp_local_export <- function(context, params) {
  format <- mcp_scalar_character(params$format, "format")
  formats <- c("html", "md", "script", "ipynb", "qmd", "session")
  if (!format %in% formats) {
    alder_abort("invalid_request", "unsupported export format")
  }
  include_code <- if (mcp_has(params, "include_code")) {
    mcp_scalar_logical(params$include_code, "include_code")
  } else {
    FALSE
  }
  if (!exists("alder_export", mode = "function")) {
    alder_abort("export_failed", "export support is unavailable")
  }
  ext <- switch(
    format,
    html = "html",
    md = "md",
    script = "R",
    ipynb = "ipynb",
    qmd = "qmd",
    session = "json"
  )
  out <- file.path(context$artifact_dir, paste0("mcp-export.", ext))
  source <- context$path
  temporary <- NULL
  if (is.null(source) || is.na(source) || !nzchar(source) ||
      isTRUE(context$session$state()$changed)) {
    temporary <- file.path(context$artifact_dir, "mcp-source.R")
    writeBin(
      charToRaw(serialize_notebook(context$session$notebook_snapshot())),
      temporary
    )
    source <- temporary
  }
  on.exit(if (!is.null(temporary)) unlink(temporary, force = TRUE), add = TRUE)
  tryCatch(
    alder_export(source, format = format, out = out, include_code = include_code),
    alder_error = function(e) stop(e),
    error = function(e) alder_abort("export_failed", conditionMessage(e))
  )
  if (!file.exists(out)) {
    alder_abort("export_failed", "export did not create an output file")
  }
  list(path = out, format = format)
}

mcp_diagnostic_rows <- function(diagnostics) {
  if (is.null(diagnostics)) return(list())
  if (is.data.frame(diagnostics)) {
    if (!nrow(diagnostics)) return(list())
    return(lapply(seq_len(nrow(diagnostics)), function(i) {
      row <- as.list(diagnostics[i, , drop = FALSE])
      lapply(row, function(value) {
        if (length(value) == 1L) unname(value) else value
      })
    }))
  }
  if (is.list(diagnostics)) return(unname(diagnostics))
  list(diagnostics)
}

mcp_local_check <- function(context) {
  if (!exists("export_analysis", mode = "function") ||
      !exists("export_diagnostics", mode = "function")) {
    alder_abort("invalid_request", "check support is unavailable")
  }
  nb <- context$session$notebook_snapshot()
  diagnostics <- export_diagnostics(nb, export_analysis(nb))
  list(diagnostics = mcp_diagnostic_rows(diagnostics))
}

mcp_local_tool <- function(context, name, params) {
  session <- context$session
  state <- function() session$state()
  id <- function(required = TRUE) mcp_cell_id(params, required)

  switch(name,
    notebook_state = state(),
    list_cells = list(cells = I(mcp_state_cells(state()))),
    read_cell = list(cell = mcp_find_cell(state(), id())),
    add_cell = {
      after <- if (mcp_has(params, "after"))
        mcp_scalar_character(params$after, "after", nullable = TRUE) else NULL
      body <- mcp_character_array(params$body, "body")
      type <- mcp_scalar_character(params$type, "type")
      if (!type %in% c("code", "markdown", "sql")) {
        alder_abort("invalid_request", "cell type must be code, markdown, or sql")
      }
      session$add_cell(after, body, type)
    },
    edit_cell = {
      body <- mcp_character_array(params$body, "body")
      type <- mcp_scalar_character(params$type, "type")
      if (!type %in% c("code", "markdown", "sql")) {
        alder_abort("invalid_request", "cell type must be code, markdown, or sql")
      }
      expected <- if (mcp_has(params, "expected_revision"))
        mcp_scalar_number(params$expected_revision, "expected_revision") else NULL
      session$set_cell(id(), body, type, expected)
    },
    delete_cell = {
      expected <- if (mcp_has(params, "expected_revision"))
        mcp_scalar_number(params$expected_revision, "expected_revision") else NULL
      session$delete_cell(id(), expected)
    },
    move_cell = {
      after <- if (mcp_has(params, "after"))
        mcp_scalar_character(params$after, "after", nullable = TRUE) else NULL
      session$move_cell(id(), after)
    },
    rename_cell = {
      if (!mcp_has(params, "name")) alder_abort("invalid_request", "name is required")
      new_name <- mcp_scalar_character(params$name, "name", nullable = TRUE)
      session$set_cell_name(id(), new_name)
    },
    disable_cell = {
      disabled <- mcp_scalar_logical(params$disabled, "disabled")
      session$set_cell_disabled(id(), disabled)
    },
    run_cell = {
      run <- session$run_cell(id())
      mcp_wait_local_idle(context)
      run
    },
    run_all = {
      run <- session$run_all()
      mcp_wait_local_idle(context)
      run
    },
    run_stale = {
      run <- session$run_stale()
      mcp_wait_local_idle(context)
      run
    },
    interrupt = {
      result <- session$interrupt()
      mcp_wait_local_idle(context)
      result
    },
    get_value = {
      name_value <- mcp_scalar_character(params$name, "name")
      session$request_value(name_value)
      mcp_wait_local_value(context)
      after <- state()
      operation <- after$value_operation %||% NULL
      if (is.null(operation) || !identical(operation$status %||% NULL, "done")) {
        error <- operation$error %||% list()
        alder_abort(error$code %||% "value_request_failed",
                    error$message %||% "value request failed")
      }
      value <- after$last_value %||% list()
      list(name = name_value, value = value$value %||% NULL,
           token = value$token %||% NULL)
    },
    set_widget = {
      name_value <- mcp_scalar_character(params$name, "name")
      path_value <- if (mcp_has(params, "path"))
        mcp_character_array(params$path, "path") else character()
      source_value <- if (mcp_has(params, "source"))
        mcp_scalar_character(params$source, "source") else "editor"
      if (!source_value %in% c("editor", "app")) {
        alder_abort("invalid_request", "source must be editor or app")
      }
      fields <- intersect(c("value", "index", "indices", "selected", "ops", "submit"),
                          names(params))
      if (length(fields) != 1L) {
        alder_abort("invalid_request", "provide exactly one widget update field")
      }
      update <- setNames(list(params[[fields[[1L]]]]), fields[[1L]])
      if (mcp_has(params, "paused")) {
        update$paused <- mcp_scalar_logical(params$paused, "paused")
      }
      token <- session$set_widget(name_value, path_value, update, source_value)
      # The worker response and any automatic dependents are asynchronous.
      mcp_wait_local_idle(context)
      list(token = token)
    },
    save = session$save(),
    export = mcp_local_export(context, params),
    check = mcp_local_check(context),
    alder_abort("invalid_request", paste("unknown tool:", name))
  )
}

mcp_url_tool <- function(context, name, params) {
  request <- context$request
  id <- function(required = TRUE) mcp_cell_id(params, required)
  state <- function() request("GET", "/api/state")

  switch(name,
    notebook_state = state(),
    list_cells = list(cells = I(mcp_state_cells(state()))),
    read_cell = list(cell = mcp_find_cell(state(), id())),
    add_cell = {
      after <- if (mcp_has(params, "after"))
        mcp_scalar_character(params$after, "after", nullable = TRUE) else NULL
      body <- mcp_character_array(params$body, "body")
      type <- mcp_scalar_character(params$type, "type")
      request("POST", "/api/cell",
              list(op = "add", after = after, body = I(body), type = type))
    },
    edit_cell = {
      body <- mcp_character_array(params$body, "body")
      type <- mcp_scalar_character(params$type, "type")
      request_body <- list(op = "edit", id = id(), body = I(body), type = type)
      expected <- if (mcp_has(params, "expected_revision")) {
        mcp_scalar_number(params$expected_revision, "expected_revision")
      } else {
        as.numeric(mcp_find_cell(state(), id())$revision %||% 0)
      }
      request_body$expected_revision <- expected
      request("POST", "/api/cell", request_body)
    },
    delete_cell = {
      request_body <- list(op = "delete", id = id())
      expected <- if (mcp_has(params, "expected_revision")) {
        mcp_scalar_number(params$expected_revision, "expected_revision")
      } else {
        as.numeric(mcp_find_cell(state(), id())$revision %||% 0)
      }
      request_body$expected_revision <- expected
      request("POST", "/api/cell", request_body)
    },
    move_cell = {
      after <- if (mcp_has(params, "after"))
        mcp_scalar_character(params$after, "after", nullable = TRUE) else NULL
      request("POST", "/api/cell", list(op = "move", cell = id(), after = after))
    },
    rename_cell = {
      if (!mcp_has(params, "name")) alder_abort("invalid_request", "name is required")
      new_name <- mcp_scalar_character(params$name, "name", nullable = TRUE)
      request("POST", "/api/cell", list(op = "name", cell = id(), name = new_name))
    },
    disable_cell = {
      disabled <- mcp_scalar_logical(params$disabled, "disabled")
      request("POST", "/api/cell",
              list(op = "disable", cell = id(), disabled = disabled))
    },
    run_cell = request("POST", "/api/run", list(cell = id())),
    run_all = request("POST", "/api/run", list(all = TRUE)),
    run_stale = request("POST", "/api/run", list(all = TRUE)),
    interrupt = request("POST", "/api/interrupt"),
    get_value = {
      name_value <- mcp_scalar_character(params$name, "name")
      request("POST", "/api/value", list(name = name_value))
      after <- mcp_wait_http_value(context)
      operation <- after$value_operation %||% list()
      if (!identical(operation$status %||% NULL, "done")) {
        error <- operation$error %||% list()
        alder_abort(error$code %||% "value_request_failed",
                    error$message %||% "value request failed")
      }
      value <- after$last_value %||% list()
      list(name = name_value, value = value$value %||% NULL,
           token = value$token %||% NULL)
    },
    set_widget = {
      name_value <- mcp_scalar_character(params$name, "name")
      path_value <- if (mcp_has(params, "path"))
        mcp_character_array(params$path, "path") else character()
      fields <- intersect(c("value", "index", "indices", "selected", "ops", "submit"),
                          names(params))
      if (length(fields) != 1L) {
        alder_abort("invalid_request", "provide exactly one widget update field")
      }
      update <- setNames(list(params[[fields[[1L]]]]), fields[[1L]])
      body <- c(list(name = name_value, path = I(path_value), source =
        if (mcp_has(params, "source")) mcp_scalar_character(params$source, "source") else "editor"),
        update)
      if (mcp_has(params, "paused")) body$paused <- mcp_scalar_logical(params$paused, "paused")
      request("POST", "/api/widget", body)
    },
    save = request("POST", "/api/save"),
    export = request("POST", "/api/export", params),
    check = request("POST", "/api/check", list()),
    alder_abort("invalid_request", paste("unknown tool:", name))
  )
}

mcp_tool_call <- function(context, name, params) {
  if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name)) {
    return(mcp_tool_content(mcp_error_payload("invalid_request", "tool name is required"), TRUE))
  }
  if (!name %in% MCP_TOOL_NAMES) {
    return(mcp_tool_content(mcp_error_payload("invalid_request",
                                                paste("unknown tool:", name)), TRUE))
  }
  if (is.null(params)) params <- list()
  if (!is.list(params) || (length(params) && is.null(names(params)))) {
    return(mcp_tool_content(mcp_error_payload("invalid_request",
                                                "tool arguments must be an object"), TRUE))
  }
  value <- tryCatch(
    if (identical(context$kind, "local")) mcp_local_tool(context, name, params)
    else mcp_url_tool(context, name, params),
    alder_error = function(e) e,
    error = function(e) e
  )
  if (inherits(value, "condition")) {
    return(mcp_tool_content(mcp_error_from_condition(value), TRUE))
  }
  mcp_tool_content(mcp_ok_payload(value), FALSE)
}

mcp_resource_list <- function(context) {
  resources <- list(
    list(uri = "alder://notebook/source", name = "Notebook source",
         description = "Serialized alder notebook source", mimeType = "text/plain"),
    list(uri = "alder://notebook/dag", name = "Notebook DAG",
         description = "Dependency graph", mimeType = "application/json")
  )
  state <- mcp_context_state(context)
  for (cell in mcp_state_cells(state)) {
    id <- cell$id %||% ""
    if (!nzchar(id)) next
    resources[[length(resources) + 1L]] <- list(
      uri = paste0("alder://cell/", utils::URLencode(id, reserved = TRUE), "/outputs"),
      name = paste("Outputs", id), description = "Rendered cell outputs",
      mimeType = "application/json"
    )
  }
  list(resources = resources)
}

mcp_source_from_state <- function(state) {
  lines <- character()
  for (cell in mcp_state_cells(state)) {
    lines <- c(lines, as.character(cell$delim %||% "# %%"))
    options <- cell$options %||% list()
    if (length(options)) {
      for (nm in names(options)) {
        value <- options[[nm]]
        scalar <- if (is.logical(value) && length(value) == 1L) {
          if (isTRUE(value)) "true" else "false"
        } else if (is.null(value)) "null" else paste(value, collapse = ",")
        lines <- c(lines, paste0("#| ", nm, ": ", scalar))
      }
    }
    body <- mcp_character_array(cell$body %||% character(), "cell body")
    lines <- c(lines, body)
  }
  paste0(paste(lines, collapse = "\n"), if (length(lines)) "\n" else "")
}

mcp_resource_read <- function(context, uri) {
  uri <- mcp_scalar_character(uri, "uri")
  if (identical(uri, "alder://notebook/source")) {
    text <- if (identical(context$kind, "local")) {
      serialize_notebook(context$session$notebook_snapshot())
    } else {
      # Older servers do not expose /api/source; reconstructing from state is
      # still useful for agents, while preserving the exact path when local.
      mcp_source_from_state(mcp_context_state(context))
    }
    return(list(contents = list(list(uri = uri, mimeType = "text/plain", text = text))))
  }
  if (identical(uri, "alder://notebook/dag")) {
    dag <- mcp_context_state(context)$dag %||% list()
    return(list(contents = list(list(uri = uri, mimeType = "application/json",
                                     text = mcp_json(dag)))))
  }
  match <- regexec("^alder://cell/([^/]+)/outputs$", uri, perl = TRUE)
  parts <- regmatches(uri, match)[[1L]]
  if (length(parts) == 2L) {
    id <- tryCatch(utils::URLdecode(parts[[2L]]), error = function(e) "")
    cell <- mcp_find_cell(mcp_context_state(context), id)
    return(list(contents = list(list(
      uri = uri, mimeType = "application/json",
      text = mcp_json(cell$outputs %||% list())
    ))))
  }
  alder_abort("not_found", paste("unknown resource:", uri))
}

# Package-internal request dispatcher.  Tests should pass a context created by
# `mcp_backend()` and a parsed JSON-RPC request.  A NULL return is a protocol
# notification with no response (notably notifications/initialized).
mcp_dispatch <- function(context, request) {
  if (is.character(request) && length(request) == 1L) {
    request <- tryCatch(jsonlite::fromJSON(request, simplifyVector = FALSE),
                        error = function(e) NULL)
  }
  if (!is.list(request) || !identical(request$jsonrpc %||% NULL, "2.0") ||
      !is.character(request$method %||% NULL) ||
      length(request$method %||% character()) != 1L) {
    return(mcp_rpc_error(mcp_request_id(request), -32600L,
                         "invalid JSON-RPC request"))
  }
  method <- request$method
  id_present <- "id" %in% names(request) && !is.null(request$id)
  id <- request$id %||% NULL

  if (identical(method, "notifications/initialized")) {
    return(NULL)
  }
  if (identical(method, "initialize")) {
    context$initialized <- TRUE
    result <- list(
      protocolVersion = MCP_PROTOCOL_VERSION,
      capabilities = list(tools = mcp_empty_object(), resources = mcp_empty_object()),
      serverInfo = list(name = "alder", version = "0.1.0")
    )
    return(mcp_rpc_response(id, result))
  }
  if (identical(method, "ping")) {
    return(mcp_rpc_response(id, mcp_empty_object()))
  }
  if (identical(method, "shutdown")) {
    context$shutdown <- TRUE
    return(mcp_rpc_response(id, mcp_empty_object()))
  }
  if (identical(method, "tools/list")) {
    return(mcp_rpc_response(id, list(tools = MCP_TOOL_DEFINITIONS)))
  }
  if (identical(method, "resources/list")) {
    result <- tryCatch(mcp_resource_list(context),
                       alder_error = function(e) e,
                       error = function(e) e)
    if (inherits(result, "condition")) {
      return(mcp_rpc_error(id, -32603L, conditionMessage(result)))
    }
    return(mcp_rpc_response(id, result))
  }
  if (identical(method, "resources/read")) {
    params <- tryCatch(mcp_param_object(request), alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(mcp_rpc_error(id, -32602L, conditionMessage(params)))
    }
    result <- tryCatch(
      mcp_resource_read(context, params$uri),
      alder_error = function(e) e,
      error = function(e) e
    )
    if (inherits(result, "condition")) {
      return(mcp_rpc_error(id, -32602L, conditionMessage(result)))
    }
    return(mcp_rpc_response(id, result))
  }
  if (identical(method, "tools/call")) {
    params <- tryCatch(mcp_param_object(request), alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(mcp_rpc_error(id, -32602L, conditionMessage(params)))
    }
    arguments <- params$arguments %||% list()
    result <- mcp_tool_call(context, params$name %||% "", arguments)
    return(mcp_rpc_response(id, result))
  }
  if (!id_present) return(NULL)
  mcp_rpc_error(id, -32601L, paste("method not found:", method))
}

# Conventional internal names retained for callers that embed the dispatcher
# without taking over the stdio loop.
mcp_handle_request <- mcp_dispatch
alder_mcp_dispatch <- mcp_dispatch
alder_mcp_request <- mcp_dispatch
alder_mcp_handle <- mcp_dispatch

# Short alias used by embedders that call the handler directly.
mcp_request <- mcp_dispatch
mcp_request_handler <- mcp_dispatch


#' Run the alder Model Context Protocol server over stdin/stdout.
#'
#' @param path Optional notebook path.  When omitted, an in-memory notebook is
#'   started.
#' @param url Optional URL of an already-running alder REST server.  Exactly
#'   one of `path` and `url` may be supplied.
#' @return Invisibly, `NULL` after stdin reaches EOF or a `shutdown` request.
#' @export
alder_mcp <- function(path = NULL, url = NULL) {
  context <- mcp_backend(path = path, url = url)
  on.exit(context$close(), add = TRUE)
  stdin_con <- file("stdin", open = "r")
  stdout_con <- stdout()
  on.exit(try(close(stdin_con), silent = TRUE), add = TRUE)
  repeat {
    line <- tryCatch(readLines(stdin_con, n = 1L, warn = FALSE),
                     error = function(e) character())
    if (!length(line)) break
    line <- line[[1L]]
    if (!nzchar(trimws(line))) next
    request <- tryCatch(jsonlite::fromJSON(line, simplifyVector = FALSE),
                        error = function(e) NULL)
    response <- if (is.null(request)) {
      mcp_rpc_error(NULL, -32700L, "parse error")
    } else {
      tryCatch(
        mcp_dispatch(context, request),
        error = function(e) mcp_rpc_error(mcp_request_id(request),
                                          -32603L, conditionMessage(e))
      )
    }
    if (!is.null(response)) {
      cat(mcp_json(response), "\n", file = stdout_con)
      flush(stdout_con)
    }
    if (isTRUE(context$shutdown)) break
  }
  invisible(NULL)
}
