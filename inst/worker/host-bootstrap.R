# Shared bootstrap for every R child launched by the application host.
# This runs before library(alder) so an installed package outside the
# application resources cannot win package lookup.

.alder_worker_has_control <- function(value) {
  codepoints <- utf8ToInt(value)
  length(codepoints) > 0L && any(codepoints <= 31L | codepoints == 127L)
}

.alder_worker_scalar_text <- function(value, label, max_bytes = 4096L,
                                      allow_empty = FALSE) {
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      (!allow_empty && !nzchar(value)) ||
      nchar(value, type = "bytes") > max_bytes || !validUTF8(value) ||
      .alder_worker_has_control(value)) {
    stop(label, " must be bounded valid UTF-8 text", call. = FALSE)
  }
  value
}

.alder_worker_scalar_path <- function(value, label) {
  value <- .alder_worker_scalar_text(value, label, max_bytes = 4096L)
  if (.Platform$OS.type == "windows") {
    absolute <- grepl("^(?:[A-Za-z]:[/\\\\]|[/\\\\]{2})", value,
                      perl = TRUE)
  } else {
    absolute <- startsWith(value, "/")
  }
  if (!absolute) {
    stop(label, " must be an absolute directory", call. = FALSE)
  }
  resolved <- tryCatch(normalizePath(value, mustWork = TRUE, winslash = "/"),
                       error = function(error) NULL)
  if (is.null(resolved) || !dir.exists(resolved) ||
      file.access(resolved, 4L) != 0L) {
    stop(label, " must be an existing readable directory", call. = FALSE)
  }
  resolved
}

.alder_worker_scalar_file <- function(value, label) {
  value <- .alder_worker_scalar_text(value, label, max_bytes = 4096L)
  if (.Platform$OS.type == "windows") {
    absolute <- grepl("^(?:[A-Za-z]:[/\\\\]|[/\\\\]{2})", value,
                      perl = TRUE)
  } else {
    absolute <- startsWith(value, "/")
  }
  if (!absolute) stop(label, " must be an absolute file", call. = FALSE)
  resolved <- tryCatch(normalizePath(value, mustWork = TRUE, winslash = "/"),
                       error = function(error) NULL)
  if (is.null(resolved) || !file.exists(resolved) ||
      isTRUE(file.info(resolved)$isdir) || file.access(resolved, 4L) != 0L) {
    stop(label, " must be an existing readable file", call. = FALSE)
  }
  resolved
}

.alder_worker_under <- function(path, root) {
  path <- if (identical(path, "/")) "/" else sub("/+$", "", path)
  root <- if (identical(root, "/")) "/" else sub("/+$", "", root)
  if (.Platform$OS.type == "windows") {
    path <- tolower(path)
    root <- tolower(root)
  }
  prefix <- if (identical(root, "/")) "/" else paste0(root, "/")
  identical(path, root) || startsWith(path, prefix)
}
.alder_worker_set_libpaths <- function(paths) {
  if ("include.site" %in% names(formals(base::.libPaths))) {
    base::.libPaths(paths, include.site = FALSE)
  } else {
    assign(".lib.loc", unique(normalizePath(paths, winslash = "/")),
           envir = environment(base::.libPaths))
  }
}

.alder_worker_bootstrap <- function() {
  worker_dir_raw <- Sys.getenv("ALDER_WORKER_DIR", unset = "")
  resources_root_raw <- Sys.getenv("ALDER_RESOURCES_ROOT", unset = "")
  private_library_raw <- Sys.getenv("ALDER_R_PRIVATE_LIBRARY", unset = "")
  encoded <- Sys.getenv("ALDER_R_LIBRARIES", unset = "")
  framing_hint <- Sys.getenv("ALDER_HOST_FRAMING", unset = "")
  host_protocol <- Sys.getenv("ALDER_HOST_PROTOCOL", unset = "")
  role <- Sys.getenv("ALDER_HOST_ROLE", unset = "")
  policy <- Sys.getenv("ALDER_ANALYSIS_POLICY", unset = "")
  analysis_environment_id <- Sys.getenv("ALDER_ANALYSIS_ENVIRONMENT_ID", unset = "")

  resources_root <- .alder_worker_scalar_path(
    resources_root_raw, "ALDER_RESOURCES_ROOT")
  worker_dir <- .alder_worker_scalar_path(worker_dir_raw, "ALDER_WORKER_DIR")
  if (!.alder_worker_under(worker_dir, resources_root)) {
    stop("ALDER_WORKER_DIR must be contained inside application resources",
         call. = FALSE)
  }
  private_library <- .alder_worker_scalar_path(
    private_library_raw, "ALDER_R_PRIVATE_LIBRARY")
  if (!.alder_worker_under(private_library, resources_root)) {
    stop("ALDER_R_PRIVATE_LIBRARY must be inside application resources",
         call. = FALSE)
  }

  if (!nzchar(encoded) || nchar(encoded, type = "bytes") > 8L * 1024L * 1024L ||
      !validUTF8(encoded)) {
    stop("ALDER_R_LIBRARIES must be a bounded UTF-8 JSON array", call. = FALSE)
  }
  if (nzchar(framing_hint)) {
    framing_hint <- .alder_worker_scalar_file(framing_hint,
                                               "ALDER_HOST_FRAMING")
  }
  framing_path <- .alder_worker_scalar_file(
    file.path(worker_dir, "host-framing.R"), "host framing module")
  if (nzchar(framing_hint) && !identical(framing_hint, framing_path)) {
    stop("ALDER_HOST_FRAMING must name the worker sibling framing module",
         call. = FALSE)
  }
  if (nzchar(host_protocol) && !identical(host_protocol, "framed-v2")) {
    stop("ALDER_HOST_PROTOCOL must be framed-v2", call. = FALSE)
  }
  if (nzchar(role) && !identical(role, "analyzer")) {
    stop("ALDER_HOST_ROLE must be analyzer", call. = FALSE)
  }
  if (nzchar(policy)) {
    policy <- .alder_worker_scalar_text(policy, "ALDER_ANALYSIS_POLICY",
                                         max_bytes = 256L)
  } else {
    policy <- "strict"
  }
  if (nzchar(analysis_environment_id)) {
    analysis_environment_id <- .alder_worker_scalar_text(
      analysis_environment_id, "ALDER_ANALYSIS_ENVIRONMENT_ID",
      max_bytes = 256L)
  } else {
    analysis_environment_id <- NULL
  }

  # Establish the private application library and R base library before the
  # package is resolved. The host-ordered paths are applied only after this
  # package identity is fixed.
  .alder_worker_set_libpaths(unique(c(private_library, .Library)))
  Sys.unsetenv(c(
    "ALDER_WORKER_DIR", "ALDER_RESOURCES_ROOT", "ALDER_R_PRIVATE_LIBRARY", "ALDER_R_LIBRARIES",
    "ALDER_HOST_FRAMING", "ALDER_HOST_PROTOCOL", "ALDER_HOST_ROLE",
    "ALDER_ANALYSIS_POLICY", "ALDER_ANALYSIS_ENVIRONMENT_ID"
  ))

  framing <- new.env(parent = baseenv())
  sys.source(framing_path, envir = framing, keep.source = FALSE)
  suppressPackageStartupMessages(base::library("alder"))

  payload <- tryCatch({
    framing$check_json_text(encoded)
    value <- jsonlite::fromJSON(encoded, simplifyVector = FALSE)
    framing$check_json_value(value)
    value
  }, error = function(error) {
    stop("ALDER_R_LIBRARIES is invalid JSON: ", conditionMessage(error),
         call. = FALSE)
  })
  if (!is.list(payload) || !is.null(names(payload)) || !length(payload)) {
    stop("ALDER_R_LIBRARIES must be a non-empty JSON array", call. = FALSE)
  }
  paths <- vapply(payload, function(path) {
    .alder_worker_scalar_path(path, "library path")
  }, "")
  if (anyDuplicated(paths)) {
    stop("ALDER_R_LIBRARIES must contain unique library paths", call. = FALSE)
  }

  get("alder_apply_library_paths", asNamespace("alder"))(paths)
  list(workerDirectory = worker_dir, privateLibrary = private_library,
       libraryPaths = unname(paths), policy = policy,
       analysisEnvironmentId = analysis_environment_id)
}
