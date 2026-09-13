# R language-server worker. It shares the exact helper/library bootstrap used
# by Ark, the analyzer and package jobs; it never evaluates notebook source.

path_is_absolute <- function(value) {
  if (.Platform$OS.type == "windows") {
    grepl("^(?:[A-Za-z]:[/\\\\]|[/\\\\]{2})", value, perl = TRUE)
  } else startsWith(value, "/")
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
  if (.Platform$OS.type == "windows") {
    path <- tolower(path)
    root <- tolower(root)
  }
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
linter_file <- normalizePath(file.path(worker_dir, "host-lsp.lintr"),
                             mustWork = FALSE, winslash = "/")
if (!path_is_under(linter_file, resources_root) ||
    !identical(dirname(linter_file), worker_dir) ||
    !file.exists(linter_file) || isTRUE(file.info(linter_file)$isdir) ||
    file.access(linter_file, 4L) != 0L) {
  stop("validated Alder LSP linter configuration is missing or outside resources",
       call. = FALSE)
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
# lintr evaluates .lintr files as R code. Point its discovery at this
# application-owned configuration so an untrusted project cannot execute its
# linter configuration while retaining the standard diagnostics.
options(lintr.linter_file = linter_file)
Sys.setenv(R_LINTR_LINTER_FILE = linter_file)
# Keep startup deterministic and ensure package diagnostics travel over the
# JSON-RPC streams owned by languageserver rather than an application logger.
suppressPackageStartupMessages(base::library("languageserver"))
languageserver::run()
