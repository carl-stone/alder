# Notebook-scoped memory and disk caching.

cache_key <- function(f, args) {
  rlang::hash(list(
    deparse(body(f)),
    names(formals(f)),
    args
  ))
}

cache_dir_for <- function(dir = NULL) {
  target <- dir %||% RUNTIME$cache_dir
  if (is.null(target) || !is.character(target) || length(target) != 1L ||
      is.na(target) || !nzchar(target)) {
    target <- file.path(tempdir(), "alder-cache")
  }
  if (!dir.exists(target) && !dir.create(target, recursive = TRUE, showWarnings = FALSE) &&
      !dir.exists(target)) {
    stop("could not create cache directory: ", target, call. = FALSE)
  }
  if (file.access(target, 2) != 0L) {
    stop("cache directory is not writable: ", target, call. = FALSE)
  }
  target
}

register_cache_dir <- function(dir) {
  dirs <- RUNTIME$disk_cache_dirs
  if (!is.environment(dirs)) {
    dirs <- new.env(parent = emptyenv())
    RUNTIME$disk_cache_dirs <- dirs
  }
  dirs[[normalizePath(dir, mustWork = FALSE)]] <- TRUE
  invisible(dir)
}

new_cached_wrapper <- function(f, kind, dir = NULL) {
  if (!is.function(f)) stop("f must be a function", call. = FALSE)
  if (!kind %in% c("memory", "disk")) stop("invalid cache kind", call. = FALSE)
  cache_dir <- if (identical(kind, "disk")) cache_dir_for(dir) else NULL
  if (!is.null(cache_dir)) register_cache_dir(cache_dir)

  wrapped <- function(...) {
    args <- list(...)
    key <- cache_key(f, args)
    if (identical(kind, "memory")) {
      store <- RUNTIME$mem_cache
      if (!is.environment(store)) {
        store <- new.env(parent = emptyenv())
        RUNTIME$mem_cache <- store
      }
      if (exists(key, envir = store, inherits = FALSE)) {
        return(get(key, envir = store, inherits = FALSE))
      }
      value <- do.call(f, args)
      assign(key, value, envir = store)
      return(value)
    }

    file <- file.path(cache_dir, paste0(key, ".rds"))
    if (file.exists(file)) {
      hit <- tryCatch(list(ok = TRUE, value = readRDS(file)),
                      error = function(e) list(ok = FALSE))
      if (isTRUE(hit$ok)) return(hit$value)
      unlink(file, force = TRUE)
    }
    value <- do.call(f, args)
    tryCatch(saveRDS(value, file, version = 3), error = function(e) NULL)
    value
  }
  wrapper_env <- new.env(parent = environment(f))
  wrapper_env$f <- f
  wrapper_env$kind <- kind
  wrapper_env$cache_dir <- cache_dir
  wrapper_env$cache_key <- cache_key
  wrapper_env$RUNTIME <- RUNTIME
  environment(wrapped) <- wrapper_env
  attr(wrapped, "cache") <- kind
  class(wrapped) <- c("alder_cached", "function")
  wrapped
}

clear_cache_memory <- function() {
  store <- RUNTIME$mem_cache
  if (is.environment(store)) {
    keys <- ls(store, all.names = TRUE)
    if (length(keys)) rm(list = keys, envir = store)
  }
  invisible()
}

clear_cache_disk <- function() {
  dirs <- RUNTIME$disk_cache_dirs
  locations <- if (is.environment(dirs)) ls(dirs, all.names = TRUE) else character()
  default <- RUNTIME$cache_dir
  if (!is.null(default) && length(default) == 1L && nzchar(default)) {
    locations <- unique(c(locations, normalizePath(default, mustWork = FALSE)))
  }
  for (dir in locations) {
    if (!dir.exists(dir)) next
    files <- list.files(dir, pattern = "\\.rds$", full.names = TRUE)
    if (length(files)) unlink(files, force = TRUE)
  }
  invisible()
}

#' Cache notebook computations
#'
#' \code{cache$memory(f)} wraps a function with a per-worker memory cache;
#' \code{cache$disk(f, dir)} caches to disk below \code{dir} (default: the
#' notebook cache directory). \code{cache$clear(which)} drops cached values
#' from \code{"memory"}, \code{"disk"}, or \code{"all"} stores. Cache keys
#' include the function body, formal argument names, and call arguments.
#' Wrapped functions carry class \code{alder_cached}.
#'
#' @export
cache <- list(
  memory = function(f) new_cached_wrapper(f, "memory"),
  disk = function(f, dir = NULL) new_cached_wrapper(f, "disk", dir),
  clear = function(which = c("all", "memory", "disk")) {
    which <- match.arg(which)
    if (which %in% c("all", "memory")) clear_cache_memory()
    if (which %in% c("all", "disk")) clear_cache_disk()
    invisible()
  }
)
