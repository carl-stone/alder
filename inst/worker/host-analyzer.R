# Persistent static-analysis adapter for the TypeScript host.
# Notebook source is parsed and walked by Alder's analyzer; it is never evaluated.

# The bootstrap path is selected only from the host-supplied worker directory.
# The shared bootstrap owns the complete environment/path policy after load.
path_is_absolute <- function(value) {
  startsWith(value, "/")
}
resolve_directory <- function(value, label) {
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !nzchar(value) || !validUTF8(value) ||
      nchar(value, type = "bytes") > 4096L || !path_is_absolute(value)) {
    stop(label, " must be an absolute directory", call. = FALSE)
  }
  resolved <- tryCatch(normalizePath(value, mustWork = TRUE, winslash = "/"),
                       error = function(error) NULL)
  if (is.null(resolved) || !dir.exists(resolved) || file.access(resolved, 4L) != 0L) {
    stop(label, " must be an existing readable directory", call. = FALSE)
  }
  resolved
}
trim_path <- function(value) {
  if (identical(value, "/")) "/" else sub("/+$", "", value)
}
path_is_under <- function(path, root) {
  path <- trim_path(path)
  root <- trim_path(root)
  prefix <- if (identical(root, "/")) "/" else paste0(root, "/")
  identical(path, root) || startsWith(path, prefix)
}

resources_root <- resolve_directory(Sys.getenv("ALDER_RESOURCES_ROOT", unset = ""),
                                    "ALDER_RESOURCES_ROOT")
worker_dir <- resolve_directory(Sys.getenv("ALDER_WORKER_DIR", unset = ""),
                                "ALDER_WORKER_DIR")
if (!path_is_under(worker_dir, resources_root)) {
  stop("ALDER_WORKER_DIR must be contained inside application resources", call. = FALSE)
}

bootstrap_path <- normalizePath(file.path(worker_dir, "host-bootstrap.R"),
                                mustWork = FALSE, winslash = "/")
if (!path_is_under(bootstrap_path, resources_root) ||
    !identical(dirname(bootstrap_path), worker_dir) ||
    !file.exists(bootstrap_path) || isTRUE(file.info(bootstrap_path)$isdir) ||
    file.access(bootstrap_path, 4L) != 0L) {
  stop("validated Alder host bootstrap is missing or outside resources", call. = FALSE)
}
bootstrap <- new.env(parent = baseenv())
sys.source(bootstrap_path, envir = bootstrap, keep.source = FALSE)
worker <- bootstrap$.alder_worker_bootstrap()
Sys.unsetenv("ALDER_WORKER_DIR")
if (!is.list(worker) || !is.character(worker$workerDirectory) ||
    length(worker$workerDirectory) != 1L) {
  stop("worker bootstrap returned no worker directory", call. = FALSE)
}
bootstrap_worker_dir <- resolve_directory(worker$workerDirectory,
                                          "bootstrapped worker directory")
if (!identical(bootstrap_worker_dir, worker_dir) ||
    !path_is_under(bootstrap_worker_dir, resources_root)) {
  stop("worker bootstrap returned a directory outside application resources", call. = FALSE)
}
worker_dir <- bootstrap_worker_dir

service <- new.env(parent = baseenv())
for (module in c("private-json.R", "private-protocol.R", "private-analysis.R")) {
  module_path <- normalizePath(file.path(worker_dir, module), mustWork = TRUE,
                               winslash = "/")
  if (!path_is_under(module_path, resources_root) ||
      !identical(dirname(module_path), worker_dir)) {
    stop("private analyzer module is outside application resources", call. = FALSE)
  }
  sys.source(module_path, envir = service, keep.source = FALSE)
}

local({
  or_else <- function(left, right) if (is.null(left)) right else left
  normalize_diagnostics <- function(value) {
    diagnostics <- or_else(value, list())
    if (!is.list(diagnostics) || !is.null(names(diagnostics))) {
      stop("analysis diagnostics must be an unnamed array", call. = FALSE)
    }
    lapply(diagnostics, function(diagnostic) {
      if (!is.list(diagnostic)) {
        stop("analysis diagnostic must be an object", call. = FALSE)
      }
      if (!("range" %in% names(diagnostic))) {
        diagnostic <- c(diagnostic, list(range = NULL))
      }
      diagnostic
    })
  }
  perf_begin <- function(...) NULL
  perf_end <- function(...) invisible()
  package_version <- unname(read.dcf(
    file.path(worker$privateLibrary, "alder", "DESCRIPTION"),
    fields = "Version")[[1L]])
  r_version <- as.character(getRversion())
  framing_path <- tryCatch(normalizePath(file.path(worker_dir, "host-framing.R"),
                                          mustWork = TRUE, winslash = "/"),
                           error = function(error) NULL)
  if (is.null(framing_path) || !path_is_under(framing_path, resources_root) ||
      !identical(dirname(framing_path), worker_dir) ||
      file.access(framing_path, 4L) != 0L) {
    stop("validated Alder host framing module is missing or outside worker directory",
         call. = FALSE)
  }
  framing <- new.env(parent = baseenv())
  sys.source(framing_path, envir = framing, keep.source = FALSE)

  input <- framing$open_input()
  output <- framing$open_output()
  on.exit(tryCatch(close(input), error = function(error) NULL), add = TRUE)
  on.exit(tryCatch(close(output), error = function(error) NULL), add = TRUE)

  safe_identity <- service$.alder_runtime_safe_identity
  has_control <- service$.alder_runtime_has_control
  decode_source <- service$alder_host_decode_source
  max_cells <- service$ALDER_HOST_MAX_CELLS
  max_source_bytes <- service$ALDER_HOST_MAX_SOURCE_BYTES
  analysis_environment_id <- worker$analysisEnvironmentId
  policy <- worker$policy

  scalar_text <- function(value, label, allow_empty = FALSE,
                          max_bytes = 32L * 1024L * 1024L,
                          reject_controls = FALSE) {
    if (!is.character(value) || length(value) != 1L || is.na(value) ||
        (!allow_empty && !nzchar(value)) || !validUTF8(value) ||
        nchar(value, type = "bytes") > max_bytes ||
        (reject_controls && has_control(value))) {
      stop(label, " must be bounded valid UTF-8 text", call. = FALSE)
    }
    value
  }
  scalar_integer <- function(value, label) {
    if (!is.numeric(value) || length(value) != 1L || is.na(value) ||
        !is.finite(value) || value != floor(value) || value < 0 ||
        value > 9007199254740991) {
      stop(label, " must be a non-negative safe integer", call. = FALSE)
    }
    value
  }
  require_object <- function(value, label, fields = NULL) {
    names_value <- names(value)
    if (!is.list(value) || is.null(names_value) || anyNA(names_value) ||
        any(!nzchar(names_value)) || anyDuplicated(names_value) ||
        any(!vapply(names_value, function(name)
          isTRUE(tryCatch({ safe_identity(name, "JSON field name", max_bytes = 256L); TRUE },
                          error = function(error) FALSE)), logical(1)))) {
      stop(label, " must be a JSON object with unique fields", call. = FALSE)
    }
    if (!is.null(fields) && !setequal(names_value, fields)) {
      stop(label, " contains unexpected or missing fields", call. = FALSE)
    }
    invisible(value)
  }
  require_request <- function(request) {
    require_object(request, "host request")
    if (!identical(request[["protocol"]], framing$PROTOCOL)) {
      stop("incompatible Alder engine protocol", call. = FALSE)
    }
    request_id <- scalar_integer(request[["req"]], "request id")
    if (request_id < 1) stop("request id must be positive", call. = FALSE)
    command <- scalar_text(request[["cmd"]], "request command", max_bytes = 64L,
                           reject_controls = TRUE)
    if (!grepl("^[a-z][a-z0-9_]*$", command)) {
      stop("invalid host request command", call. = FALSE)
    }
    fields <- switch(command,
      ping = c("protocol", "req", "cmd"),
      analyze = c("protocol", "req", "cmd", "revision",
                  "analysisEnvironmentId", "cells"),
      shutdown = c("protocol", "req", "cmd"),
      c("protocol", "req", "cmd"))
    require_object(request, "host request", fields)
    invisible(request)
  }

  empty_analysis <- function() {
    list(defs = I(character()), refs = I(character()),
         selfRefs = I(character()),
         diagnostics = I(list()),
         ranges = I(list()), error = NULL)
  }

  analyze_request <- function(request) {
    revision <- scalar_integer(request[["revision"]], "analysis revision")
    requested_environment_id <- safe_identity(
      request[["analysisEnvironmentId"]], "analysisEnvironmentId", max_bytes = 256L)
    if (!is.null(analysis_environment_id) &&
        !identical(requested_environment_id, analysis_environment_id)) {
      stop("analysisEnvironmentId does not match the worker environment", call. = FALSE)
    }
    cells <- request[["cells"]]
    if (!is.list(cells) || !is.null(names(cells)) || length(cells) > max_cells) {
      stop("analysis cells must be a bounded JSON array", call. = FALSE)
    }
    source_bytes <- 0
    ids <- character(length(cells))
    results <- lapply(seq_along(cells), function(index) {
      cell <- cells[[index]]
      require_object(cell, "analysis cell")
      cell_names <- names(cell)
      if (!("source_base64" %in% cell_names) && !("source" %in% cell_names)) {
        stop("analysis cell must contain source_base64 or source", call. = FALSE)
      }
      source_field <- if ("source_base64" %in% cell_names) "source_base64" else "source"
      require_object(cell, "analysis cell",
                     c("id", "revision", "type", source_field))
      source <- decode_source(cell, "source_base64", "source", "analysis source")
      cell_revision <- scalar_integer(cell[["revision"]], "cell revision")
      cell_id <- safe_identity(cell[["id"]], "analysis cell id", max_bytes = 256L)
      cell_type <- safe_identity(cell[["type"]], "analysis cell type", max_bytes = 16L)
      scalar_text(source, "analysis source", allow_empty = TRUE,
                  max_bytes = max_source_bytes)
      if (!(cell_type %in% c("code", "markdown"))) {
        stop("invalid analysis cell snapshot", call. = FALSE)
      }
      source_bytes <<- source_bytes + nchar(source, type = "bytes")
      if (source_bytes > max_source_bytes) {
        stop("analysis source exceeds the 32 MiB notebook limit", call. = FALSE)
      }
      ids[[index]] <<- cell_id
      analysis <- if (identical(cell_type, "code")) {
        analysis_span <- perf_begin("analyzer.cell_defs_refs", list(
          req = request[["req"]], revision = revision,
          cell = cell_id, cell_revision = cell_revision))
        analysis_result <- list(ok = FALSE)
        on.exit(perf_end(analysis_span, analysis_result), add = TRUE)
        value <- service$cell_defs_refs(source)
        analysis_result <- list(ok = TRUE,
          defs = length(or_else(value$defs, character())),
          refs = length(or_else(value$refs, character())),
          diagnostics = length(or_else(value$diagnostics, list())))
        value
      } else empty_analysis()
      list(id = cell_id, revision = cell_revision,
           defs = I(or_else(analysis$defs, character())),
           refs = I(or_else(analysis$refs, character())),
           selfRefs = I(or_else(analysis$selfRefs, character())),
           diagnostics = I(normalize_diagnostics(analysis$diagnostics)),
           ranges = I(or_else(analysis$ranges, list())),
           error = or_else(analysis$error, NULL))
    })
    if (anyDuplicated(ids)) stop("analysis cell ids must be unique", call. = FALSE)
    list(ok = TRUE, revision = revision,
         analysisEnvironmentId = requested_environment_id, cells = I(results),
         analyzer = list(package_version = package_version,
                         r_version = r_version, policy = policy,
                         analysisEnvironmentId = requested_environment_id))
  }

  respond <- function(request, response) {
    response$req <- request[["req"]]
    response$cmd <- request[["cmd"]]
    if (!is.null(request[["revision"]])) response$revision <- request[["revision"]]
    if (!is.null(request[["analysisEnvironmentId"]])) {
      response$analysisEnvironmentId <- request[["analysisEnvironmentId"]]
    }
    framing$write_frame(output, response)
  }
  dispatch_request <- function(request) {
    fields <- list(req = request[["req"]], cmd = request[["cmd"]])
    if (!is.null(request[["revision"]])) fields$revision <- request[["revision"]]
    request_span <- perf_begin("analyzer.request", fields)
    request_result <- list(ok = FALSE)
    on.exit(perf_end(request_span, request_result), add = TRUE)
    response <- tryCatch(
      if (!(request[["cmd"]] %in% c("ping", "analyze", "shutdown"))) {
        list(ok = FALSE, error = list(code = "unknown_command",
             message = paste0("unknown analyzer command: ", request[["cmd"]])))
      } else switch(request[["cmd"]],
        ping = list(ok = TRUE), analyze = analyze_request(request),
        shutdown = list(ok = TRUE)),
      error = function(error) list(ok = FALSE, error = list(
        code = "analysis_error", message = conditionMessage(error))))
    request_result <- list(ok = isTRUE(response$ok))
    if (!is.null(response$error$code)) request_result$error_code <- response$error$code
    respond(request, response)
    invisible()
  }

  # Compile the bounded internal path before advertising readiness; notebook
  # source is parsed only in the analyze command and is never evaluated.
  for (name in c("read_exact", "frame_length", "frame_header", "check_json_text",
                 "check_json_value", "read_frame", "write_frame")) {
    assign(name, compiler::cmpfun(get(name, envir = framing, inherits = FALSE)),
           envir = framing)
  }
  target <- environment(dispatch_request)
  for (name in c("scalar_text", "scalar_integer", "require_object",
                 "require_request", "respond", "dispatch_request",
                 "empty_analysis", "analyze_request")) {
    assign(name, compiler::cmpfun(get(name, envir = target, inherits = FALSE)),
           envir = target)
  }

  framing$write_frame(output, list(
    kind = "handshake", protocol = framing$PROTOCOL, role = "analyzer",
    engine = list(name = "alder-r-analyzer", version = "1"),
    package_version = package_version, r_version = r_version,
    capabilities = I(c("analysis", "analysis-policy:v1")),
    readiness = list(initialized = TRUE, analysis = TRUE)))

  repeat {
    request <- framing$read_frame(input)
    if (is.null(request)) break
    require_request(request)
    dispatch_request(request)
    if (identical(request[["cmd"]], "shutdown")) break
  }
})
