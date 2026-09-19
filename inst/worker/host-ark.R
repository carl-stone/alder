# Alder's Ark startup hook. Ark remains the notebook evaluator and owns its
# Jupyter lifecycle, streams, conditions, native graphics and interruption.
# The sourced runtime performs the one common R bootstrap for this process.

local({
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
  runtime_path <- normalizePath(file.path(worker_dir, "host-ark-runtime.R"),
                                mustWork = FALSE, winslash = "/")
  if (!path_is_under(runtime_path, resources_root) ||
      !identical(dirname(runtime_path), worker_dir) ||
      !file.exists(runtime_path) || isTRUE(file.info(runtime_path)$isdir) ||
      file.access(runtime_path, 4L) != 0L) {
    stop("validated Alder Ark worker modules are missing or outside resources", call. = FALSE)
  }

  imports <- new.env(parent = baseenv())
  imports$setNames <- stats::setNames
  runtime <- new.env(parent = imports)
  sys.source(runtime_path, envir = runtime, keep.source = FALSE)
  Sys.unsetenv("ALDER_WORKER_DIR")
  bridge <- get(".__alder_app_bridge_v1", envir = globalenv(), inherits = FALSE)
  if (!is.environment(bridge) || !is.function(bridge$evaluate) ||
      !is.function(bridge$request)) {
    stop("Alder Ark runtime is incomplete", call. = FALSE)
  }
})
