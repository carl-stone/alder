# The configured/installed bundle is always local. Opening notebook source
# must never install npm dependencies or download an executable.
alder_host_spec <- function(host = Sys.getenv("ALDER_HOST", unset = ""),
                            node = Sys.getenv("ALDER_NODE", unset = "")) {
  if (!nzchar(host)) {
    host <- system.file("host", "alder-host.mjs", package = "alder")
  }
  if (!nzchar(host) || !file.exists(host) || dir.exists(host)) {
    alder_abort("host_unavailable", paste0(
      "A compatible Alder application host is required. Install the Alder ",
      "application distribution or set ALDER_HOST to its local alder-host.mjs."
    ))
  }
  host <- normalizePath(host, mustWork = TRUE)
  if (!nzchar(node)) {
    bundled <- file.path(dirname(host), "runtime",
                         if (.Platform$OS.type == "windows") "node.exe" else "node")
    node <- if (file.exists(bundled)) bundled else Sys.which("node")
  }
  if (!nzchar(node) || !file.exists(node)) {
    alder_abort("host_unavailable", paste0(
      "Node is unavailable. Install the Alder application distribution ",
      "with its runtime or set ALDER_NODE to a compatible local executable."
    ))
  }
  node <- normalizePath(node, mustWork = TRUE)
  info <- tryCatch(processx::run(node, c(host, "--host-info"),
                                timeout = 10000, error_on_status = TRUE),
                   error = function(e) alder_abort("host_unavailable",
                     paste("Could not start Alder host:", conditionMessage(e))))
  identity <- tryCatch(jsonlite::fromJSON(info$stdout), error = function(e) NULL)
  if (!is.list(identity) || !identical(identity$protocol, 1L) ||
      !identical(identity$packageVersion,
                 as.character(utils::packageVersion("alder")))) {
    alder_abort("host_incompatible", "Alder host protocol/package version is incompatible")
  }
  list(command = node, args = host, identity = identity)
}

alder_host_environment <- function() {
  env <- Sys.getenv()
  package <- getNamespaceInfo(asNamespace("alder"), "path")
  if (!file.exists(file.path(package, "Meta", "package.rds"))) {
    package <- find.package("alder", lib.loc = .libPaths(), quiet = FALSE)
  }
  env[["ALDER_R_PACKAGE"]] <- normalizePath(package, mustWork = TRUE)
  env[["ALDER_RSCRIPT"]] <- file.path(R.home("bin"), "Rscript")
  inherited <- strsplit(Sys.getenv("R_LIBS"), .Platform$path.sep,
                         fixed = TRUE)[[1L]]
  libs <- unique(c(dirname(package), .libPaths(), inherited))
  env[["R_LIBS"]] <- paste(libs[nzchar(libs)], collapse = .Platform$path.sep)
  env
}

alder_host_process <- function(path, options = list()) {
  spec <- alder_host_spec()
  config <- tempfile("alder-host-", fileext = ".json")
  on.exit(unlink(config), add = TRUE)
  options$path <- path
  jsonlite::write_json(options, config, auto_unbox = TRUE, null = "null")
  # The host reads this file before its readiness line; keep it until then.
  proc <- processx::process$new(spec$command,
    c(spec$args, "--config", config), env = alder_host_environment(),
    stdin = "|", stdout = "|", stderr = "|", supervise = TRUE)
  ready <- FALSE
  on.exit(if (!ready && proc$is_alive()) proc$kill_tree(), add = TRUE)
  deadline <- Sys.time() + getOption("alder.worker_startup_timeout", 45)
  diagnostics <- character()
  while (proc$is_alive() && Sys.time() < deadline) {
    proc$poll_io(100)
    lines <- proc$read_output_lines()
    for (line in lines) {
      record <- tryCatch(jsonlite::fromJSON(line), error = function(e) NULL)
      if (is.list(record) && identical(record$type, "host.ready")) {
        ready <- TRUE
        return(list(process = proc, ready = record))
      }
    }
    diagnostics <- tail(c(diagnostics, proc$read_error_lines()), 50L)
  }
  alder_abort("host_unavailable", paste(c("Alder host did not become ready",
                                           diagnostics), collapse = "\n"))
}

alder_host_request <- function(boot, path, body = NULL, shutdown = FALSE) {
  handle <- curl::new_handle(timeout = 300)
  headers <- c("Accept" = "application/json")
  if (isTRUE(shutdown)) {
    headers <- c(headers, "X-Alder-Shutdown-Token" = boot$ready$address$shutdownToken)
    curl::handle_setopt(handle, customrequest = "POST", postfields = "")
  } else if (!is.null(body)) {
    headers <- c(headers, "Content-Type" = "application/json")
    curl::handle_setopt(handle, customrequest = "POST", postfields =
      as.character(jsonlite::toJSON(body, auto_unbox = TRUE, null = "null")))
  }
  curl::handle_setheaders(handle, .list = headers)
  response <- tryCatch(
    curl::curl_fetch_memory(paste0(boot$ready$address$origin, path), handle),
    error = function(error) alder_abort(
      "host_unavailable",
      paste0("Alder host request failed: ", conditionMessage(error))
    )
  )
  value <- tryCatch(
    jsonlite::fromJSON(rawToChar(response$content), simplifyVector = FALSE),
    error = function(error) alder_abort(
      "invalid_host_response",
      paste0("Alder host returned invalid JSON: ", conditionMessage(error))
    )
  )
  if (response$status_code >= 400L) {
    alder_abort(value$error$code %||% "host_request_failed",
                value$error$message %||% "Alder host request failed",
                result = value$error)
  }
  value
}

alder_host_operation_id <- function(prefix = "r") {
  paste0(prefix, "-", basename(tempfile()))
}

alder_host_command <- function(boot, type, ...) {
  command <- c(list(type = type, sessionEpoch = boot$ready$epoch,
                   operationId = alder_host_operation_id()), list(...))
  alder_host_request(boot, "/api/command", command)
}

alder_host_operation <- function(boot, operation_id) {
  if (!is.character(operation_id) || length(operation_id) != 1L ||
      is.na(operation_id) || !nzchar(operation_id)) {
    alder_abort("invalid_request", "operation id must be a nonempty string")
  }
  alder_host_request(boot, paste0("/api/operation?operation_id=",
    utils::URLencode(operation_id, reserved = TRUE)))$operation
}

alder_host_wait <- function(boot, operation_id) {
  result <- alder_host_request(boot, paste0("/api/operation/wait?operation_id=",
    utils::URLencode(operation_id, reserved = TRUE)))$operation
  if (identical(result$status, "error")) {
    alder_abort(result$error$code %||% "execution_failed",
                 result$error$message %||% "Alder operation failed")
  }
  result
}

alder_host_request_service <- function(boot, command, payload = list(), wait = TRUE) {
  if (!length(payload) && is.null(names(payload))) {
    # jsonlite otherwise writes an empty unnamed list as [], while the host's
    # service boundary deliberately accepts only JSON objects.
    payload <- jsonlite::fromJSON("{}", simplifyVector = FALSE)
  }
  receipt <- alder_host_command(boot, "service", command = command,
                                payload = payload)
  operation <- receipt$operation
  if (isTRUE(wait) && !operation$status %in%
      c("done", "error", "cancelled")) {
    operation <- alder_host_wait(boot, operation$id)
  }
  if (operation$status %in% c("error", "cancelled")) {
    cancelled <- identical(operation$status, "cancelled")
    code <- if (cancelled) "cancelled" else "service_error"
    message <- if (cancelled) "Alder service was cancelled" else "Alder service failed"
    alder_abort(operation$error$code %||% code,
                operation$error$message %||% message,
                result = operation$error)
  }
  if (isTRUE(wait)) operation$result else receipt
}

alder_host_cell <- function(state, id) {
  if (!is.character(id) || length(id) != 1L || is.na(id) || !nzchar(id)) {
    alder_abort("invalid_request", "cell id must be a nonempty string")
  }
  hits <- vapply(state$cells %||% list(), function(cell)
    identical(cell$id, id), FALSE)
  if (!any(hits)) alder_abort("not_found", paste("no such cell:", id))
  state$cells[[which(hits)[[1L]]]]
}

alder_host_expected_revision <- function(cell, expected_revision = NULL) {
  revision <- expected_revision %||% cell$revision
  if (!alder_is_revision(revision)) {
    alder_abort("invalid_request",
                "expected_revision must be a non-negative integer")
  }
  as.integer(revision)
}

alder_host_state <- function(boot) {
  state <- alder_host_request(boot, "/api/state")
  state$topo <- unlist(state$graph$topologicalOrder, use.names = FALSE)
  state$dag <- state$graph
  state$dag$nodes <- unlist(state$dag$nodes, use.names = FALSE) %||% character()
  state$dag$reverse_edges <- state$dag$reverseEdges
  state$runtime$execution_mode <- state$runtime$executionMode
  state$runtime$run_on_startup <- state$runtime$runOnStartup
  state$runtime$worker_available <- isTRUE(state$runtime$kernelAvailable)
  state$runtime$active_run_id <- state$runtime$activeRunId
  state$last_value <- state$lastValue
  state$last_action_error <- state$lastActionError
  state$app <- tryCatch(
    alder_app_config(list(metadata = state$metadata)),
    error = function(error) state$metadata$app %||% list(
      layout = "vertical", width = "medium", include_code = FALSE
    )
  )
  inspections <- Filter(function(operation)
    identical(operation$kind, "inspect"), state$operations %||% list())
  state$value_operation <- if (length(inspections)) {
    inspections[[length(inspections)]]
  } else {
    NULL
  }
  for (i in seq_along(state$cells)) {
    for (field in c("body", "defs", "refs", "selfRefs", "locals", "log")) {
      state$cells[[i]][[field]] <- unlist(state$cells[[i]][[field]],
                                         use.names = FALSE) %||% character()
    }
    state$cells[[i]]$self_refs <- state$cells[[i]]$selfRefs
    state$cells[[i]]$disabled <-
      identical(state$cells[[i]]$options$disabled %||% NULL, TRUE)
  }
  state
}

alder_host_facade <- function(boot, close) {
  state <- function() alder_host_state(boot)
  command_result <- function(type, ...) alder_host_command(boot, type, ...)
  run <- function(scope, cell = NULL) {
    receipt <- if (identical(scope, "cell")) {
      command_result("run", scope = scope, cellId = cell)
    } else {
      command_result("run", scope = scope)
    }
    # R Session run ids are caller-facing operation handles. Keep that useful
    # contract while retaining the host's internal run identity separately.
    receipt$run_id <- receipt$operation$id
    receipt$engine_run_id <- receipt$operation$runId %||% NULL
    receipt
  }
  operation_by_handle <- function(handle) {
    direct <- tryCatch(alder_host_operation(boot, handle),
                       alder_error = function(error) NULL)
    if (!is.null(direct)) return(direct)
    operations <- state()$operations %||% list()
    hits <- Filter(function(operation)
      identical(operation$runId %||% NULL, handle), operations)
    if (!length(hits)) alder_abort("not_found", "operation was not found")
    hits[[length(hits)]]
  }
  notebook_snapshot <- function() {
    snapshot <- state()
    list(path = snapshot$path, metadata = snapshot$metadata,
         cells = lapply(snapshot$cells, function(cell) {
           list(id = cell$id, type = cell$type, body = cell$body,
                options = cell$options)
         }))
  }
  set_cell <- function(id, body, type, expected_revision = NULL) {
    snapshot <- state()
    cell <- alder_host_cell(snapshot, id)
    revision <- alder_host_expected_revision(cell, expected_revision)
    receipt <- command_result("edit", edits = list(list(
      cellId = id, body = I(body), cellType = type,
      expectedRevision = revision
    )))
    edited <- receipt$result$edited[[1L]]
    list(id = edited$id, revision = edited$revision,
         version = receipt$version, operation = receipt$operation)
  }
  apply_formatted <- function(bodies) {
    if (!is.list(bodies) || is.null(names(bodies)) ||
        anyDuplicated(names(bodies))) {
      alder_abort("invalid_request", "formatted bodies must be a named list")
    }
    snapshot <- state()
    if (!length(bodies)) {
      return(list(changed = 0L, version = snapshot$version, cells = list()))
    }
    edits <- lapply(names(bodies), function(id) {
      cell <- alder_host_cell(snapshot, id)
      body <- bodies[[id]]
      if (!is.character(body) || anyNA(body)) {
        alder_abort("invalid_request",
                    "formatted cell body must be a character array")
      }
      list(cellId = id, body = I(body), cellType = cell$type,
           expectedRevision = as.integer(cell$revision))
    })
    receipt <- command_result("edit", edits = edits)
    after <- state()
    cells <- lapply(names(bodies), function(id) {
      old <- alder_host_cell(snapshot, id)
      current <- alder_host_cell(after, id)
      list(id = id, body = current$body, type = current$type,
           previous_revision = old$revision, revision = current$revision)
    })
    list(changed = sum(vapply(cells, function(cell)
           !identical(cell$previous_revision, cell$revision), FALSE)),
         version = receipt$version, cells = cells,
         operation = receipt$operation)
  }
  format_source <- function(cell = NULL, expected_revisions = NULL) {
    snapshot <- state()
    ids <- vapply(snapshot$cells, function(value) value$id, "")
    if (!is.null(cell)) alder_host_cell(snapshot, cell)
    selected <- if (is.null(cell)) ids else cell
    if (is.null(expected_revisions)) {
      expected_revisions <- setNames(lapply(selected, function(id)
        as.integer(alder_host_cell(snapshot, id)$revision)), selected)
    }
    receipt <- command_result("format",
      expectedRevisions = expected_revisions,
      cellIds = I(selected))
    c(receipt$result, list(version = receipt$version,
                           operation = receipt$operation))
  }
  add_cell <- function(after = NULL, body = character(), type = "code") {
    creation <- alder_host_operation_id("create")
    receipt <- command_result("create", creations = list(list(
      clientOperationId = creation, after = after, body = I(body),
      cellType = type
    )))
    created <- receipt$result$created[[1L]]
    list(id = created$id, revision = created$revision,
         version = receipt$version, operation = receipt$operation)
  }
  delete_cell <- function(id, expected_revision = NULL) {
    snapshot <- state()
    cell <- alder_host_cell(snapshot, id)
    receipt <- command_result("delete", cellId = id,
      expectedRevision = alder_host_expected_revision(cell, expected_revision))
    c(receipt$result, list(version = receipt$version,
                           operation = receipt$operation))
  }
  set_cell_disabled <- function(id, disabled) {
    snapshot <- state()
    cell <- alder_host_cell(snapshot, id)
    receipt <- command_result("disable", cellId = id, disabled = disabled,
                              expectedRevision = as.integer(cell$revision))
    c(receipt$result, list(version = receipt$version,
      run_id = if (!is.null(receipt$result$runId)) receipt$operation$id else NULL,
      operation = receipt$operation))
  }
  set_widget <- function(name, path = character(), update = NULL,
                         source = "editor") {
    # Retain Session's historical set_widget(name, update, source) calling
    # convention while sending one typed command to the host controller.
    if (is.list(path) && (is.null(update) || is.character(update))) {
      old_update <- path
      source <- if (is.character(update) && length(update) == 1L) update else source
      path <- character()
      update <- old_update
    }
    source <- match.arg(source, c("editor", "app", "mcp", "cli"))
    receipt <- command_result("widget", name = name, path = I(path),
                              update = update, source = source)
    receipt$operation$id
  }
  packages <- function(command, packages = character()) {
    payload <- if (identical(command, "packages.status")) {
      jsonlite::fromJSON("{}", simplifyVector = FALSE)
    } else {
      list(packages = I(packages))
    }
    alder_host_request_service(boot, command, payload, wait = TRUE)
  }
  list(
    state = state,
    state_json = function(fields = list()) as.character(jsonlite::toJSON(
      c(state(), fields), auto_unbox = TRUE, null = "null", force = TRUE
    )),
    notebook_snapshot = notebook_snapshot,
    worker_available = function() {
      if (!boot$process$is_alive()) return(FALSE)
      isTRUE(state()$runtime$worker_available)
    },
    run_operation = operation_by_handle,
    widget_operation = operation_by_handle,
    await_operation = function(id) alder_host_wait(boot, id),
    validate_graph = function() {
      result <- alder_host_request_service(boot, "check", wait = TRUE)
      if (isTRUE(result$ok)) NULL else
        unlist(result$issues, use.names = FALSE)
    },
    set_cell = set_cell,
    apply_formatted = apply_formatted,
    format_source = format_source,
    set_cell_disabled = set_cell_disabled,
    set_cell_name = function(id, name = NULL) {
      result <- alder_host_request_service(boot, "rename-cell",
        list(cellId = id, name = name), wait = TRUE)
      c(result, list(version = state()$version))
    },
    move_cell = function(id, after = NULL) {
      receipt <- command_result("move", cellId = id, after = after)
      c(receipt$result, list(version = receipt$version,
                             operation = receipt$operation))
    },
    add_cell = add_cell,
    delete_cell = delete_cell,
    run_cell = function(id) run("cell", id),
    run_all = function() run("all"),
    run_stale = function() run("stale"),
    interrupt = function() {
      receipt <- command_result("interrupt")
      c(receipt$result, list(version = receipt$version,
                             operation = receipt$operation))
    },
    restart_worker = function(replay = TRUE) {
      receipt <- command_result("restart", replay = replay)
      receipt$run_id <- if (isTRUE(replay)) receipt$operation$id else NULL
      receipt
    },
    set_runtime = function(execution_mode = NULL, run_on_startup = NULL) {
      args <- list()
      if (!is.null(execution_mode)) args$executionMode <- execution_mode
      if (!is.null(run_on_startup)) args$runOnStartup <- run_on_startup
      receipt <- do.call(command_result, c(list("set-runtime"), args))
      runtime <- receipt$result
      list(execution_mode = runtime$executionMode,
           run_on_startup = runtime$runOnStartup,
           version = receipt$version, operation = receipt$operation)
    },
    get_execution_mode = function() state()$runtime$execution_mode,
    set_app = function(updates) {
      result <- alder_host_request_service(boot, "set-app", updates, wait = TRUE)
      c(result, list(version = state()$version))
    },
    set_layout = function(layout) {
      receipt <- command_result("set-layout", layout = layout)
      c(receipt$result, list(version = receipt$version,
                             operation = receipt$operation))
    },
    set_config = function(patch) {
      receipt <- command_result("set-config", patch = patch)
      c(receipt$result, list(version = receipt$version,
                             operation = receipt$operation))
    },
    declare_packages = function(values) {
      result <- packages("packages.declare", values)
      result$declaration %||% result
    },
    install_packages = function(values = character()) {
      result <- packages("packages.install", values)
      result$result %||% result
    },
    packages = function() packages("packages.status"),
    set_widget = set_widget,
    request_value = function(name) {
      receipt <- command_result("inspect", name = name)
      receipt$operation$id
    },
    request_lazy = function(key) {
      receipt <- command_result("lazy-output", key = key)
      receipt$operation$id
    },
    request_table_page = function(handle, offset = 0, limit = 25,
                                  sort_by = "", sort_desc = FALSE,
                                  filter = "") {
      receipt <- command_result("table-page", handle = handle,
        offset = as.integer(offset), limit = as.integer(limit),
        sortBy = sort_by, sortDescending = sort_desc, filter = filter)
      receipt$operation$id
    },
    save = function() {
      receipt <- command_result("save")
      c(receipt$result, list(version = receipt$version,
                             operation = receipt$operation))
    },
    stop = close,
    active = function() boot$process$is_alive()
  )
}

# This facade contains no execution plan, graph or freshness decisions. R
# entry points observe and command the same host that serves the browser.
alder_start_host <- function(path, host, port, open, execution_mode,
                             run_on_startup, allowed_origins, sandbox,
                             idle_timeout, expected_source = NULL) {
  validate_loopback_host(host)
  if (!is.null(path)) {
    if (!is.character(path) || length(path) != 1L || is.na(path) ||
        !nzchar(path)) {
      stop("`path` must be NULL or a nonempty string")
    }
    if (any(charToRaw(path) == as.raw(0))) stop("`path` contains NUL bytes")
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
  if (!is.numeric(port) || length(port) != 1L || is.na(port) ||
      !is.finite(port) || port < 1L || port > 65535L || port != floor(port)) {
    stop("`port` must be an integer between 1 and 65535")
  }
  if (!is.logical(open) || length(open) != 1L || is.na(open)) {
    stop("`open` must be TRUE or FALSE")
  }
  if (!is.null(execution_mode)) {
    execution_mode <- match.arg(execution_mode, c("automatic", "lazy"))
  }
  if (!is.null(run_on_startup) &&
      (!is.logical(run_on_startup) || length(run_on_startup) != 1L ||
       is.na(run_on_startup))) {
    stop("`run_on_startup` must be TRUE or FALSE")
  }
  if (!is.null(allowed_origins) &&
      (!is.character(allowed_origins) || !length(allowed_origins) ||
       anyNA(allowed_origins))) {
    stop("`allowed_origins` must be NULL or a character vector")
  }
  if (!is.logical(sandbox) || length(sandbox) != 1L || is.na(sandbox)) {
    stop("`sandbox` must be TRUE or FALSE")
  }
  if (isTRUE(sandbox) && is.null(path)) {
    alder_abort("invalid_request", "sandbox mode requires a notebook path")
  }
  gallery <- !is.null(path) && dir.exists(path)
  if (isTRUE(sandbox) && isTRUE(gallery)) {
    alder_abort("invalid_request",
                "sandbox mode requires a notebook path, not a directory")
  }
  if (!is.null(idle_timeout) &&
      (!is.numeric(idle_timeout) || length(idle_timeout) != 1L ||
       is.na(idle_timeout) || !is.finite(idle_timeout) || idle_timeout < 0)) {
    stop("`idle_timeout` must be NULL or one non-negative finite number")
  }
  options <- list(host = host, port = as.integer(port), sandbox = sandbox,
                  idleTimeout = idle_timeout %||% 0)
  if (!is.null(execution_mode)) options$executionMode <- execution_mode
  if (!is.null(run_on_startup)) options$runOnStartup <- run_on_startup
  if (!is.null(allowed_origins)) options$allowedOrigins <- I(allowed_origins)
  if (!is.null(expected_source)) options$expectedSource <- expected_source
  boot <- alder_host_process(path, options)
  lifecycle <- new_alder_lifecycle(if (is.null(idle_timeout) ||
    identical(as.numeric(idle_timeout), 0)) NULL else idle_timeout)
  close <- function(reason = "stop_alder") {
    if (isTRUE(lifecycle$stopped)) return(invisible())
    lifecycle$shutdown_requested <- TRUE
    lifecycle$shutdown_reason <- lifecycle$shutdown_reason %||% reason
    if (boot$process$is_alive()) {
      try(alder_host_request(boot, "/api/shutdown", shutdown = TRUE), silent = TRUE)
      try(boot$process$close_input(), silent = TRUE)
      boot$process$wait(5000)
      if (boot$process$is_alive()) {
        boot$process$kill_tree()
        boot$process$wait(5000)
      }
    }
    lifecycle$stopped <- TRUE
    lifecycle$exit_status <- boot$process$get_exit_status() %||%
      lifecycle$exit_status %||% 0L
    invisible()
  }
  gallery <- isTRUE(boot$ready$gallery)
  facade <- if (gallery) NULL else
    alder_host_facade(boot, function() close("session_stop"))
  check_exit <- NULL
  check_exit <- function() {
    if (isTRUE(lifecycle$stopped)) return(invisible())
    if (!boot$process$is_alive()) {
      lifecycle$stopped <- TRUE
      lifecycle$shutdown_requested <- TRUE
      lifecycle$shutdown_reason <- lifecycle$shutdown_reason %||% "host_exit"
      lifecycle$exit_status <- boot$process$get_exit_status() %||% 1L
    } else {
      later::later(check_exit, 0.1)
    }
    invisible()
  }
  later::later(check_exit, 0.1)
  url <- paste0(boot$ready$address$origin, "/")
  cat("alder running at ", url, "\n", sep = "")
  if (isTRUE(open)) {
    tryCatch(utils::browseURL(url), error = function(error) warning(
      "Alder started, but the browser could not be opened: ",
      conditionMessage(error), call. = FALSE
    ))
  }
  lifecycle$stop_callback <- function(reason = "requested") close(reason)
  artifact_dir <- boot$ready$artifactDirectory %||% NULL
  structure(list(session = facade, lifecycle = lifecycle, host_process = boot,
                 host_close = close, server = NULL, lsp = NULL, worker = NULL,
                 gallery = gallery, gallery_root = if (gallery) path else NULL,
                 gallery_sessions = NULL, artifact_dir = artifact_dir,
                 upload_dir = if (is.null(artifact_dir)) NULL else
                   file.path(artifact_dir, "uploads"),
                 cache_dir = if (is.null(path) || gallery) NULL else
                   file.path(dirname(path), ".alder", "cache"),
                 stopped = FALSE), class = "alder_server")
}

alder_mcp_host <- function(path = NULL, url = NULL) {
  if (is.null(path) == is.null(url)) {
    alder_abort("invalid_request", "provide exactly one notebook path or host URL")
  }
  spec <- alder_host_spec()
  args <- c(spec$args, "--mcp")
  if (!is.null(path)) args <- c(args, "--notebook", path)
  if (!is.null(url)) args <- c(args, "--url", url)
  environment <- alder_host_environment()
  previous <- Sys.getenv(names(environment), unset = NA_character_)
  on.exit({
    missing <- is.na(previous)
    if (any(missing)) Sys.unsetenv(names(previous)[missing])
    if (any(!missing)) do.call(Sys.setenv, as.list(previous[!missing]))
  }, add = TRUE)
  do.call(Sys.setenv, as.list(environment))
  status <- system2(spec$command, shQuote(args), stdout = "", stderr = "")
  if (!identical(as.integer(status), 0L)) {
    alder_abort("host_failed", paste("Alder MCP host exited with status", status))
  }
  invisible(NULL)
}
