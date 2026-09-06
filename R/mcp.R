# MCP agent surface: line-delimited JSON-RPC 2.0 over stdio.
#
# The MCP transport deliberately stays independent of httpuv.  A local
# context owns the same Session/Worker pair as the editor, while a URL context
# translates tool calls to the running server's REST API.  The request
# dispatcher is kept as a package-internal function so tests and embedders can
# exercise the protocol without taking over stdin/stdout.

MCP_PROTOCOL_VERSION <- "2024-11-05"

MCP_TIMEOUT_SECONDS <- 120

# Stdio is line-delimited JSON-RPC. Keep one hostile peer from making the
# transport allocate an unbounded line; this is the same 16 MiB ceiling used
# by the largest JSON HTTP boundary.
MCP_MAX_MESSAGE_BYTES <- 16L * 1024L * 1024L

# JSON Numbers are parsed as binary64 doubles. Restrict numeric request IDs to
# the contiguous integer interval in which adjacent values remain distinct.
MCP_MAX_SAFE_NUMERIC_ID <- 2^53 - 1

# The 2024-11-05 MCP lifecycle is a three-message handshake. Keeping the
# phase explicit prevents an otherwise valid tool notification from mutating
# notebook state before capability negotiation has completed.
MCP_PHASE_NEW <- "new"
MCP_PHASE_AWAITING_INITIALIZED <- "awaiting_initialized"
MCP_PHASE_READY <- "ready"
MCP_PHASE_SHUTDOWN <- "shutdown"

mcp_empty_object <- function() {
  structure(list(), names = character())
}

mcp_json <- function(value) {
  as.character(jsonlite::toJSON(value, auto_unbox = TRUE, null = "null",
                                na = "null", digits = 17, force = TRUE))
}

mcp_schema <- function(properties = list(), required = character()) {
  out <- list(
    type = "object",
    properties = if (length(properties)) properties else mcp_empty_object()
  )
  if (length(required)) out$required <- I(as.character(required))
  out
}

mcp_type <- function(type, description = NULL, enum = NULL, items = NULL,
                     minimum = NULL, maximum = NULL) {
  out <- list(type = if (length(type) == 1L) type else I(type))
  if (!is.null(description)) out$description <- description
  if (!is.null(enum)) out$enum <- I(as.character(enum))
  if (!is.null(items)) out$items <- items
  if (!is.null(minimum)) out$minimum <- minimum
  if (!is.null(maximum)) out$maximum <- maximum
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
  kind <- mcp_type("string", "Cell kind", enum = c("code", "markdown"))
  revision <- mcp_type("integer", "Expected source revision", minimum = 0L,
                       maximum = .Machine$integer.max)
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
         description = "Insert a new code or markdown cell.",
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
         description = paste(
           "Run one cell and its required reactive dependencies, waiting for",
           "execution and any deferred run-button resets to settle."
         ),
         inputSchema = mcp_schema(list(cell = cell), "cell")),
    list(name = "run_all",
         description = paste(
           "Run all runnable cells, waiting for execution and any deferred",
           "run-button resets to settle."
         ),
         inputSchema = mcp_schema()),
    list(name = "run_stale",
         description = paste(
           "Run stale cells and required ancestors, waiting for execution and",
           "any deferred run-button resets to settle."
         ),
         inputSchema = mcp_schema()),
    list(name = "interrupt",
         description = "Interrupt the active run.",
         inputSchema = mcp_schema()),
    list(name = "get_value",
         description = paste("Render and return a current top-level notebook value;",
                             "stale values require rerunning their defining cell."),
         inputSchema = mcp_schema(
           list(name = mcp_type("string", "Top-level binding name")), "name")),
    list(name = "set_widget",
         description = paste(
           "Apply one widget update, wait for its reactive effects to settle,",
           "including an automatic run-button reset, and return its operation",
           "token."
         ),
         inputSchema = mcp_schema(
           list(
             name = mcp_type(
               "string",
               "Widget binding name, including a widget composed in a layout"
             ),
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
  keys <- if (is.list(request)) names(request) else NULL
  if (is.null(keys) || anyNA(keys) || sum(keys == "id") != 1L) return(NULL)
  id <- request$id
  if (is.null(id)) return(NULL)
  string_id <- is.character(id) && length(id) == 1L && !is.na(id)
  numeric_id <- is.numeric(id) && length(id) == 1L && !is.na(id) &&
    is.finite(id) && id == trunc(id) && abs(id) <= MCP_MAX_SAFE_NUMERIC_ID
  valid <- string_id || numeric_id
  if (isTRUE(valid)) id else NULL
}

# Parse one wire message using the same safety boundary as JSON HTTP bodies.
# The returned request is retained on invalid-object errors so a non-ambiguous
# id can still be echoed, while malformed syntax and byte-level failures have
# no safely parsed request and therefore use a null id.
mcp_parse_json <- function(text, max_bytes = MCP_MAX_MESSAGE_BYTES) {
  invalid <- function(code, message, request = NULL) {
    list(request = request, error = list(code = as.integer(code),
                                         message = as.character(message)))
  }
  if (!is.character(text) || length(text) != 1L || is.na(text)) {
    return(invalid(-32700L, "parse error"))
  }
  raw <- tryCatch(charToRaw(text), error = function(e) raw())
  if (length(raw) > max_bytes) {
    return(invalid(-32600L, "invalid JSON-RPC request"))
  }
  if (!length(raw) || any(raw == as.raw(0)) || !validUTF8(text)) {
    return(invalid(-32700L, "parse error"))
  }
  first <- sub("^[ \\t\\r\\n]*", "", text)
  if (!nzchar(first) || !startsWith(first, "{")) {
    # Arrays and scalar JSON values are valid JSON but invalid JSON-RPC
    # requests. This also avoids building a non-object tree unnecessarily.
    return(invalid(-32600L, "invalid JSON-RPC request"))
  }
  if (!json_structure_within_limits(text, bytes = raw)) {
    return(invalid(-32600L, "invalid JSON-RPC request"))
  }
  request <- tryCatch(jsonlite::fromJSON(text, simplifyVector = FALSE),
                      error = function(e) NULL)
  if (is.null(request)) return(invalid(-32700L, "parse error"))
  if (!is.list(request) || is.null(names(request))) {
    return(invalid(-32600L, "invalid JSON-RPC request", request))
  }
  # jsonlite keeps duplicate names in unsimplified lists. Check every object,
  # including tool arguments and nested widget values, before dispatch.
  if (!is.null(json_dup_key(request))) {
    return(invalid(-32600L, "invalid JSON-RPC request", request))
  }
  list(request = request, error = NULL)
}

# Read a single raw line in fixed-size chunks. `readLines()` has no byte limit
# and can allocate a complete hostile message before callers can reject it.
# Chunks are retained only through the current line and are discarded once a
# message exceeds the cap; bytes after an overlong line are consumed through
# its newline so a following valid request still survives.
mcp_stdio_reader <- function(con, max_bytes = MCP_MAX_MESSAGE_BYTES) {
  state <- new.env(parent = emptyenv())
  state$chunk <- raw()
  state$position <- 1L
  state$eof <- FALSE
  read_line <- function() {
    if (isTRUE(state$eof)) return(NULL)
    pieces <- list()
    piece_count <- 0L
    total <- 0L
    oversized <- FALSE
    repeat {
      if (!length(state$chunk) || state$position > length(state$chunk)) {
        # A processx fd connection returns short chunks as soon as bytes are
        # available, unlike readBin() on a live pipe which can wait for the
        # requested chunk size (or EOF). Transport failures remain visible to
        # the caller instead of being misreported as a clean EOF.
        processx::poll(list(con), -1L)
        state$chunk <- processx::conn_read_bytes(con, 65536L)
        state$position <- 1L
        if (!length(state$chunk)) {
          incomplete <- processx::conn_is_incomplete(con)
          if (!isTRUE(incomplete)) {
            state$eof <- TRUE
            if (!total && !length(pieces) && !oversized) return(NULL)
            break
          }
          next
        }
      }
      start <- state$position
      indexes <- which(state$chunk[seq.int(start, length(state$chunk))] ==
                       as.raw(10L))
      if (length(indexes)) {
        stop_at <- start + indexes[[1L]] - 1L
        end <- stop_at - 1L
        state$position <- stop_at + 1L
        if (end >= start) {
          part <- state$chunk[seq.int(start, end)]
          part_length <- length(part)
          if (!oversized && part_length > max_bytes - total) {
            oversized <- TRUE
            pieces <- list()
            piece_count <- 0L
          } else if (!oversized) {
            total <- total + part_length
            piece_count <- piece_count + 1L
            pieces[[piece_count]] <- part
          }
        }
        break
      }
      part <- state$chunk[seq.int(start, length(state$chunk))]
      part_length <- length(part)
      if (!oversized && part_length > max_bytes - total) {
        oversized <- TRUE
        pieces <- list()
        piece_count <- 0L
      } else if (!oversized) {
        total <- total + part_length
        piece_count <- piece_count + 1L
        pieces[[piece_count]] <- part
      }
      state$position <- length(state$chunk) + 1L
    }
    list(bytes = if (oversized) raw() else do.call(c, pieces),
         oversized = oversized)
  }
  read_line
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

mcp_scalar_revision <- function(value, label, nullable = FALSE) {
  if (nullable && is.null(value)) return(NULL)
  if (!alder_is_revision(value)) {
    alder_abort("invalid_request",
                paste0(label, " must be a non-negative integer"))
  }
  value
}

mcp_has <- function(x, name) name %in% names(x)

mcp_named_object <- function(value, label) {
  if (!is.list(value) || is.null(names(value))) {
    alder_abort("invalid_request", paste0(label, " must be an object"))
  }
  value
}

mcp_param_object <- function(request, required = FALSE) {
  if (!mcp_has(request, "params")) {
    if (isTRUE(required)) {
      alder_abort("invalid_request", "params must be an object")
    }
    return(mcp_empty_object())
  }
  params <- request$params
  if (!is.list(params) || is.null(names(params))) {
    alder_abort("invalid_request", "params must be an object")
  }
  params
}

mcp_empty_params <- function(request, method) {
  params <- mcp_param_object(request)
  if (length(params)) {
    alder_abort("invalid_request", paste0(method, " params must be empty"))
  }
  params
}

mcp_initialize_params <- function(request) {
  params <- mcp_param_object(request, required = TRUE)
  required <- c("protocolVersion", "capabilities", "clientInfo")
  missing <- required[!required %in% names(params)]
  if (length(missing)) {
    alder_abort(
      "invalid_request",
      paste0("initialize params missing: ", paste(missing, collapse = ", "))
    )
  }
  mcp_scalar_character(params$protocolVersion, "protocolVersion")
  mcp_named_object(params$capabilities, "capabilities")
  client <- mcp_named_object(params$clientInfo, "clientInfo")
  mcp_scalar_character(client$name, "clientInfo.name")
  mcp_scalar_character(client$version, "clientInfo.version")
  params
}

mcp_tools_call_params <- function(request) {
  params <- mcp_param_object(request, required = TRUE)
  if (!mcp_has(params, "name")) {
    alder_abort("invalid_request", "tool name is required")
  }
  name <- mcp_scalar_character(params$name, "tool name")
  if (!name %in% MCP_TOOL_NAMES) {
    alder_abort("invalid_request", paste("unknown tool:", name))
  }
  arguments <- if (mcp_has(params, "arguments")) {
    mcp_named_object(params$arguments, "tool arguments")
  } else {
    mcp_empty_object()
  }
  list(name = name, arguments = arguments)
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

  # Match the single-notebook server bootstrap exactly.  In particular, the
  # runtime metadata aliases remain supported and project/user configuration
  # participates in the same precedence chain.  Unlike the HTTP server, MCP
  # must *not* let Session's constructor start user code: that effect belongs
  # after the peer has completed the initialize/initialized handshake.
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
  execution_mode <- runtime$execution_mode %||%
    runtime$on_cell_change %||% config$on_cell_change %||% "automatic"
  run_on_startup <- runtime$run_on_startup %||%
    runtime$on_startup %||% config$on_startup %||% TRUE
  execution_mode <- match.arg(execution_mode, c("automatic", "lazy"))
  if (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
      is.na(run_on_startup)) {
    stop("`run_on_startup` must be TRUE or FALSE", call. = FALSE)
  }
  package_lib <- if (!is.null(path) && nzchar(path)) {
    file.path(dirname(path), ALDER_PACKAGE_INSTALL_LIB)
  } else {
    NULL
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
    .spawn_worker(
      worker_script, app_dir, artifact_dir, cache_dir,
      env = if (!is.null(path) && nzchar(path)) {
        c(
          ALDER_NOTEBOOK_DIR = dirname(path),
          ALDER_PROJECT_LIB = file.path(dirname(path),
                                        ALDER_PACKAGE_INSTALL_LIB)
        )
      } else {
        character()
      }
    ),
    error = function(e) {
      unlink(artifact_dir, recursive = TRUE, force = TRUE)
      stop(e)
    }
  )

  # `env_snapshot` is a real worker command and therefore doubles as a
  # readiness probe while retaining the single-request startup invariant.
  tryCatch(
    .wait_for_worker(worker, command = "env_snapshot"),
    error = function(e) {
      try(worker$kill(), silent = TRUE)
      unlink(artifact_dir, recursive = TRUE, force = TRUE)
      stop(e)
    }
  )

  session <- tryCatch(
    Session$new(nb, worker, execution_mode = execution_mode,
                # Preserve the requested policy, but leave its one startup
                # effect to the validated MCP lifecycle boundary.
                run_on_startup = run_on_startup, defer_startup = TRUE,
                disk_version = disk_version,
                config = config, package_lib = package_lib),
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
  context$execution_mode <- execution_mode
  context$run_on_startup <- isTRUE(run_on_startup)
  context$startup_settled <- FALSE
  context$startup_error <- NULL
  context$dispatch <- function(request) mcp_dispatch(context, request)
  context$handle_request <- context$dispatch
  context$request_handler <- context$dispatch
  context$closed <- FALSE
  context$shutdown <- FALSE
  context$phase <- MCP_PHASE_NEW
  context$initialized <- FALSE
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
  if (!is.null(config_error)) {
    session$record_config_error(
      conditionMessage(config_error),
      config_error$code %||% "config_invalid"
    )
  }
  context
}

# Settle the startup policy only after the client completes the MCP lifecycle.
# Session normally executes startup from its constructor, so local MCP retains
# the resolved policy but defers that constructor effect to this lifecycle
# boundary. This keeps a pre-ready ping responsive and makes EOF/failed
# negotiation effect-free.
mcp_local_startup <- function(context) {
  if (!identical(context$kind, "local") || isTRUE(context$startup_settled)) {
    return(invisible())
  }
  if (!isTRUE(context$run_on_startup)) {
    context$startup_settled <- TRUE
    return(invisible())
  }
  outcome <- tryCatch({
    run <- context$session$run_all()
    mcp_wait_local_run(context, run$run_id)
    NULL
  }, error = identity)
  if (inherits(outcome, "condition")) {
    context$startup_error <- outcome
    # The notification cannot carry a JSON-RPC error.  Keep the error on the
    # context so the first normal request surfaces it instead of claiming a
    # usable post-ready session.
    return(invisible())
  }
  context$startup_settled <- TRUE
  invisible()
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
  context$phase <- MCP_PHASE_NEW
  context$initialized <- FALSE
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

mcp_wait_local_widget_operation <- function(context, token) {
  operation <- NULL
  context$pump(function() {
    # state() also detects a worker that exited without delivering a response,
    # terminalizing its pending widget operations instead of timing out.
    context$session$state()
    current <- context$session$widget_operation(token)
    if (is.null(current) || identical(current$status %||% NULL, "pending")) {
      return(FALSE)
    }
    operation <<- current
    TRUE
  })
  operation
}

mcp_assert_run_operation_done <- function(operation) {
  if (!identical(operation$status %||% NULL, "done")) {
    error <- operation$error %||% list()
    alder_abort(error$code %||% "run_failed",
                error$message %||% "run settlement failed")
  }
  invisible(operation)
}

mcp_wait_local_run <- function(context, run_id) {
  operation <- NULL
  context$pump(function() {
    # state() detects a lost worker and terminalizes the exact run record.
    context$session$state()
    current <- context$session$run_operation(run_id)
    if (is.null(current) || identical(current$status %||% NULL, "pending")) {
      return(FALSE)
    }
    operation <<- current
    TRUE
  })
  mcp_assert_run_operation_done(operation)
  invisible(operation)
}

mcp_widget_spec_at <- function(spec, path = character()) {
  if (is.null(spec) || !is.list(spec)) return(NULL)
  if (!length(path)) return(spec)
  if (identical(spec$kind %||% NULL, "form")) {
    return(mcp_widget_spec_at(spec$child, path))
  }
  if (!(spec$kind %||% "") %in% c("array", "dictionary")) return(NULL)
  children <- spec$children %||% list()
  matches <- which(vapply(children, function(child) {
    identical(as.character(child$name %||% ""), path[[1L]])
  }, logical(1L)))
  if (!length(matches)) return(NULL)
  mcp_widget_spec_at(children[[matches[[1L]]]], path[-1L])
}

mcp_local_widget_spec <- function(context, name, path = character()) {
  mcp_widget_spec_from_state(context$session$state(), name, path)
}

mcp_widget_output_in_record <- function(output, name) {
  if (is.null(output) || !is.list(output)) return(NULL)
  if (identical(output$kind %||% NULL, "widget") &&
      identical(output$name %||% NULL, name)) {
    return(output)
  }
  if (identical(output$kind %||% NULL, "layout")) {
    for (child in output$children %||% list()) {
      found <- mcp_widget_output_in_record(child, name)
      if (!is.null(found)) return(found)
    }
  } else if (identical(output$kind %||% NULL, "lazy") &&
             !is.null(output$child)) {
    return(mcp_widget_output_in_record(output$child, name))
  }
  NULL
}

mcp_widget_spec_from_state <- function(state, name, path = character()) {
  for (cell in state$cells %||% list()) {
    outputs <- cell$outputs %||% list()
    for (output in rev(outputs)) {
      widget <- mcp_widget_output_in_record(output, name)
      if (!is.null(widget)) return(mcp_widget_spec_at(widget$spec, path))
    }
  }
  NULL
}

mcp_assert_widget_operation_done <- function(operation) {
  if (!identical(operation$status %||% NULL, "done")) {
    error <- operation$error %||% list()
    alder_abort(error$code %||% "widget_update_failed",
                error$message %||% "widget update failed")
  }
  invisible(operation)
}

mcp_wait_http_widget_operation <- function(context, token) {
  timeout <- context$timeout %||% MCP_TIMEOUT_SECONDS
  timeout <- mcp_scalar_number(timeout, "timeout")
  deadline <- Sys.time() + timeout
  route <- paste0("/api/widget-operation?token=", as.integer(token))
  repeat {
    result <- context$request("GET", route)
    operation <- result$operation %||% list()
    if (!identical(operation$status %||% NULL, "pending")) {
      return(operation)
    }
    if (Sys.time() >= deadline) {
      alder_abort("mcp_timeout", "MCP widget update timed out")
    }
    Sys.sleep(0.05)
  }
}

mcp_wait_http_run <- function(context, run_id,
                              timeout_message = "MCP run timed out") {
  timeout <- context$timeout %||% MCP_TIMEOUT_SECONDS
  timeout <- mcp_scalar_number(timeout, "timeout")
  deadline <- Sys.time() + timeout
  route <- paste0("/api/run-operation?run_id=", as.integer(run_id))
  repeat {
    result <- context$request("GET", route)
    operation <- result$operation %||% list()
    if (!identical(operation$status %||% NULL, "pending")) {
      mcp_assert_run_operation_done(operation)
      return(invisible(operation))
    }
    if (Sys.time() >= deadline) alder_abort("mcp_timeout", timeout_message)
    Sys.sleep(0.05)
  }
}

mcp_wait_http_idle <- function(context,
                               timeout_message = "MCP operation timed out") {
  timeout <- context$timeout %||% MCP_TIMEOUT_SECONDS
  timeout <- mcp_scalar_number(timeout, "timeout")
  deadline <- Sys.time() + timeout
  repeat {
    state <- context$request("GET", "/api/state")
    if (!isTRUE(state$runtime$busy)) return(state)
    if (Sys.time() >= deadline) {
      alder_abort("mcp_timeout", timeout_message)
    }
    Sys.sleep(0.05)
  }
}

mcp_wait_http_widget <- function(context, token, name, path = character()) {
  operation <- mcp_wait_http_widget_operation(context, token)
  mcp_assert_widget_operation_done(operation)
  # As in local mode, the initiating callback schedules consumers or marks
  # them stale before terminalizing this exact token.  Only now is idle a
  # meaningful indication that the causal downstream work has settled.
  state <- mcp_wait_http_idle(
    context, "MCP widget consumer run timed out"
  )
  operation <- context$request(
    "GET", paste0("/api/widget-operation?token=", as.integer(token))
  )$operation %||% operation
  if (isTRUE(operation$reset_expected)) {
    reset_token <- operation$reset_token %||% NULL
    if (is.null(reset_token)) {
      alder_abort("widget_update_failed",
                  "run button reset was not scheduled")
    }
    reset <- mcp_wait_http_widget_operation(context, reset_token)
    mcp_assert_widget_operation_done(reset)
    state <- context$request("GET", "/api/state")
    spec <- mcp_widget_spec_from_state(state, name, path)
    if (is.null(spec) || !identical(spec$value %||% NULL, FALSE)) {
      alder_abort("widget_update_failed",
                  "run button reset did not restore its idle value")
    }
  }
  invisible(operation)
}

mcp_wait_local_widget <- function(context, token, name, path = character()) {
  operation <- mcp_wait_local_widget_operation(context, token)
  mcp_assert_widget_operation_done(operation)
  # The exact operation becomes terminal inside the same callback that
  # schedules automatic consumers (or marks lazy consumers stale). Waiting
  # for it first closes the otherwise observable pre-scheduling idle window.
  mcp_wait_local_idle(context)
  operation <- context$session$widget_operation(token) %||% operation
  if (isTRUE(operation$reset_expected)) {
    reset_token <- operation$reset_token %||% NULL
    if (is.null(reset_token)) {
      alder_abort("widget_update_failed",
                  "run button reset was not scheduled")
    }
    reset <- mcp_wait_local_widget_operation(context, reset_token)
    mcp_assert_widget_operation_done(reset)
    spec <- mcp_local_widget_spec(context, name, path)
    if (is.null(spec) || !identical(spec$value %||% NULL, FALSE)) {
      alder_abort("widget_update_failed",
                  "run button reset did not restore its idle value")
    }
  }
  invisible(operation)
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
      if (!type %in% c("code", "markdown")) {
        alder_abort("invalid_request", "cell type must be code or markdown")
      }
      session$add_cell(after, body, type)
    },
    edit_cell = {
      body <- mcp_character_array(params$body, "body")
      type <- mcp_scalar_character(params$type, "type")
      if (!type %in% c("code", "markdown")) {
        alder_abort("invalid_request", "cell type must be code or markdown")
      }
      expected <- if (mcp_has(params, "expected_revision"))
        mcp_scalar_revision(params$expected_revision, "expected_revision") else NULL
      session$set_cell(id(), body, type, expected)
    },
    delete_cell = {
      expected <- if (mcp_has(params, "expected_revision"))
        mcp_scalar_revision(params$expected_revision, "expected_revision") else NULL
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
      mcp_wait_local_run(context, run$run_id)
      run
    },
    run_all = {
      run <- session$run_all()
      mcp_wait_local_run(context, run$run_id)
      run
    },
    run_stale = {
      run <- session$run_stale()
      mcp_wait_local_run(context, run$run_id)
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
      mcp_wait_local_widget(context, token, name_value, path_value)
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
        mcp_scalar_revision(params$expected_revision, "expected_revision")
      } else {
        as.numeric(mcp_find_cell(state(), id())$revision %||% 0)
      }
      request_body$expected_revision <- expected
      request("POST", "/api/cell", request_body)
    },
    delete_cell = {
      request_body <- list(op = "delete", id = id())
      expected <- if (mcp_has(params, "expected_revision")) {
        mcp_scalar_revision(params$expected_revision, "expected_revision")
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
    run_cell = {
      accepted <- request("POST", "/api/run", list(cell = id()))
      mcp_wait_http_run(context, accepted$run_id, "MCP cell run timed out")
      accepted
    },
    run_all = {
      accepted <- request(
        "POST", "/api/run", list(all = TRUE, scope = "all")
      )
      mcp_wait_http_run(
        context, accepted$run_id, "MCP notebook run timed out"
      )
      accepted
    },
    run_stale = {
      accepted <- request(
        "POST", "/api/run", list(all = TRUE, scope = "stale")
      )
      mcp_wait_http_run(
        context, accepted$run_id, "MCP stale-cell run timed out"
      )
      accepted
    },
    interrupt = {
      accepted <- request("POST", "/api/interrupt")
      mcp_wait_http_idle(context, "MCP interrupt timed out")
      accepted
    },
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
      accepted <- request("POST", "/api/widget", body)
      token <- accepted$token %||% NULL
      if (!is.numeric(token) || length(token) != 1L || is.na(token) ||
          !is.finite(token) || token < 1 || token != floor(token)) {
        alder_abort("internal_error",
                    "REST API returned an invalid widget operation token")
      }
      mcp_wait_http_widget(context, token, name_value, path_value)
      list(token = token)
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
  if (!is.list(params) || is.null(names(params))) {
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
# notification with no response. Valid notifications execute only after the
# MCP initialize/initialized handshake has reached the ready phase.
mcp_dispatch <- function(context, request) {
  if (is.character(request) && length(request) == 1L) {
    parsed <- mcp_parse_json(request)
    if (!is.null(parsed$error)) {
      return(mcp_rpc_error(mcp_request_id(parsed$request),
                           parsed$error$code, parsed$error$message))
    }
    request <- parsed$request
  }
  if (is.list(request) && !is.null(json_dup_key(request))) {
    return(mcp_rpc_error(mcp_request_id(request), -32600L,
                         "invalid JSON-RPC request"))
  }
  if (!is.list(request) || !identical(request$jsonrpc %||% NULL, "2.0") ||
      !is.character(request$method %||% NULL) ||
      length(request$method %||% character()) != 1L) {
    return(mcp_rpc_error(mcp_request_id(request), -32600L,
                         "invalid JSON-RPC request"))
  }
  method <- request$method
  id_present <- "id" %in% names(request)
  id <- if (id_present) mcp_request_id(request) else NULL
  if (id_present && is.null(id)) {
    return(mcp_rpc_error(NULL, -32600L, "invalid JSON-RPC request"))
  }
  reply <- function(response) if (id_present) response else NULL

  # This MCP method exists only as a notification. An ID-bearing form is an
  # invalid Request, not a notification that may be silently discarded.
  if (identical(method, "notifications/initialized") && id_present) {
    return(mcp_rpc_error(id, -32600L, "invalid JSON-RPC request"))
  }
  if (mcp_has(request, "params") &&
      (is.null(request$params) || !is.list(request$params))) {
    return(reply(mcp_rpc_error(id, -32602L,
                               "params must be an object or array")))
  }

  if (identical(method, "notifications/initialized")) {
    params <- tryCatch(mcp_empty_params(request, method),
                       alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    if (identical(context$phase %||% MCP_PHASE_NEW,
                  MCP_PHASE_AWAITING_INITIALIZED)) {
      context$phase <- MCP_PHASE_READY
      context$initialized <- TRUE
      mcp_local_startup(context)
    }
    return(NULL)
  }
  if (identical(method, "initialize")) {
    # MCP initialization is a request, never a notification. Notifications
    # remain silent, but must not advance the lifecycle or apply any effect.
    if (!id_present) return(NULL)
    if (!identical(context$phase %||% MCP_PHASE_NEW, MCP_PHASE_NEW)) {
      return(mcp_rpc_error(id, -32600L, "server already initialized"))
    }
    params <- tryCatch(mcp_initialize_params(request),
                       alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    context$phase <- MCP_PHASE_AWAITING_INITIALIZED
    context$initialized <- FALSE
    result <- list(
      protocolVersion = MCP_PROTOCOL_VERSION,
      capabilities = list(tools = mcp_empty_object(), resources = mcp_empty_object()),
      serverInfo = list(name = "alder", version = "0.1.0")
    )
    return(reply(mcp_rpc_response(id, result)))
  }
  if (identical(method, "ping")) {
    params <- tryCatch(mcp_empty_params(request, method),
                       alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    return(reply(mcp_rpc_response(id, mcp_empty_object())))
  }

  # Initialization must be the first interaction and normal operations begin
  # only after the client confirms the initialize response. Invalid
  # notifications remain silent and, crucially, effect-free.
  if (!identical(context$phase %||% MCP_PHASE_NEW, MCP_PHASE_READY)) {
    return(reply(mcp_rpc_error(id, -32600L, "server not initialized")))
  }
  if (identical(method, "shutdown")) {
    params <- tryCatch(mcp_empty_params(request, method),
                       alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    context$shutdown <- TRUE
    context$phase <- MCP_PHASE_SHUTDOWN
    context$initialized <- FALSE
    return(reply(mcp_rpc_response(id, mcp_empty_object())))
  }
  if (identical(context$kind, "local") && !is.null(context$startup_error)) {
    return(reply(mcp_rpc_error(
      id, -32603L,
      paste0("notebook startup failed: ", conditionMessage(context$startup_error))
    )))
  }
  if (identical(method, "tools/list")) {
    params <- tryCatch(mcp_param_object(request), alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    return(reply(mcp_rpc_response(id, list(tools = MCP_TOOL_DEFINITIONS))))
  }
  if (identical(method, "resources/list")) {
    params <- tryCatch(mcp_param_object(request), alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    result <- tryCatch(mcp_resource_list(context),
                       alder_error = function(e) e,
                       error = function(e) e)
    if (inherits(result, "condition")) {
      return(reply(mcp_rpc_error(id, -32603L, conditionMessage(result))))
    }
    return(reply(mcp_rpc_response(id, result)))
  }
  if (identical(method, "resources/read")) {
    params <- tryCatch(mcp_param_object(request), alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    result <- tryCatch(
      mcp_resource_read(context, params$uri),
      alder_error = function(e) e,
      error = function(e) e
    )
    if (inherits(result, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(result))))
    }
    return(reply(mcp_rpc_response(id, result)))
  }
  if (identical(method, "tools/call")) {
    params <- tryCatch(mcp_tools_call_params(request),
                       alder_error = function(e) e)
    if (inherits(params, "condition")) {
      return(reply(mcp_rpc_error(id, -32602L, conditionMessage(params))))
    }
    result <- mcp_tool_call(context, params$name, params$arguments)
    return(reply(mcp_rpc_response(id, result)))
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
#' @details Run tools and `set_widget` have the same settlement contract for
#'   both backends. Run tools return after the exact requested run and every
#'   deferred run-button reset it causes have settled; ordinary cell errors
#'   remain visible in notebook state. Reset failures retain their Alder error
#'   code. `set_widget` returns only after the exact widget update and its
#'   automatic reactive effects have settled, including a causally linked
#'   run-button reset.
#'   Named widgets composed inside layouts or resolved lazy outputs use the
#'   same settlement contract as top-level widget outputs.
#'   Widget failures retain their Alder error code.
#'   Value inspection rejects stale, disabled, failed, or otherwise unexecuted
#'   definitions with `stale_value`. Run the defining cell and its dependencies
#'   before inspecting it again. Source changes also invalidate pending value
#'   responses and previous inspector results; notebook outputs remain visibly
#'   stale until their cells rerun.
#'
#'   The stdio transport accepts one UTF-8 JSON object per line, with a 16 MiB
#'   message limit. It rejects malformed bytes, excessive structural
#'   complexity, and duplicate object keys at any depth before dispatch, so an
#'   ambiguous request cannot select a tool or mutate notebook state. A rejected
#'   frame does not prevent a later valid frame from being processed.
#'   MCP requests require a scalar string ID or an exactly represented integer
#'   ID in the inclusive range `-(2^53 - 1)` through `2^53 - 1`; invalid IDs
#'   are rejected before dispatch. Method parameters use named JSON objects,
#'   and initialization requires protocol version, client capabilities, and
#'   client information. A successful initialize request enters an awaiting
#'   phase; only a subsequent valid `notifications/initialized` message makes
#'   normal tools and resources available. Before that point, only `ping` may
#'   execute. Notifications never emit a response, and invalid or out-of-phase
#'   notifications are effect-free. `tools/call` requires a known, nonempty
#'   tool name and object-valued arguments; malformed calls receive a top-level
#'   JSON-RPC parameter error before any tool executes.
#'   For a local path backend, notebook runtime metadata and layered Alder
#'   configuration are resolved with the same precedence as the web server.
#'   User cells never run before lifecycle readiness; a configured startup run
#'   begins after a valid initialized notification and settles before normal
#'   MCP operations are accepted.
#' @return Invisibly, `NULL` after stdin reaches EOF or a `shutdown` request.
#' @examples
#' \dontrun{alder_mcp(path = "analysis.R")}
#' @export
alder_mcp <- function(path = NULL, url = NULL) {
  context <- mcp_backend(path = path, url = url)
  on.exit(context$close(), add = TRUE)
  # Keep stdin as a nonblocking processx fd connection; the stdio reader
  # polls for short available chunks so interactive clients need not close the
  # pipe or fill a 64 KiB read before the first response is dispatched.
  stdin_con <- processx::conn_create_fd(0L, close = FALSE)
  stdout_con <- stdout()
  on.exit(try(processx::processx_conn_close(stdin_con), silent = TRUE), add = TRUE)
  read_line <- mcp_stdio_reader(stdin_con)
  repeat {
    line <- read_line()
    if (is.null(line)) break
    response <- if (isTRUE(line$oversized)) {
      mcp_rpc_error(NULL, -32600L, "invalid JSON-RPC request")
    } else {
      raw_line <- line$bytes
      if (!length(raw_line)) {
        NULL
      } else if (all(raw_line %in% as.raw(c(9L, 13L, 32L)))) {
        NULL
      } else if (any(raw_line == as.raw(0L))) {
        mcp_rpc_error(NULL, -32700L, "parse error")
      } else {
        text <- tryCatch(rawToChar(raw_line), error = function(e) NULL)
        if (is.null(text)) {
          mcp_rpc_error(NULL, -32700L, "parse error")
        } else {
          parsed <- mcp_parse_json(text)
          if (!is.null(parsed$error)) {
            mcp_rpc_error(mcp_request_id(parsed$request),
                          parsed$error$code, parsed$error$message)
          } else {
            tryCatch(
              mcp_dispatch(context, parsed$request),
              error = function(e) {
                if (!("id" %in% names(parsed$request))) return(NULL)
                mcp_rpc_error(
                  mcp_request_id(parsed$request), -32603L, conditionMessage(e)
                )
              }
            )
          }
        }
      }
    }
    if (!is.null(response)) {
      cat(mcp_json(response), "\n", file = stdout_con)
      flush(stdout_con)
    }
    if (isTRUE(context$shutdown)) break
  }
  invisible(NULL)
}
