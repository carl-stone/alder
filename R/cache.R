# Notebook-scoped memory and disk caching.

cache_fingerprintable <- function(value, depth = 0L) {
  if (depth > 100L || is.environment(value) || is.function(value) ||
      isS4(value) || typeof(value) %in% c("externalptr", "weakref")) {
    return(FALSE)
  }
  if (is.list(value) || is.pairlist(value) || is.expression(value)) {
    if (length(value) &&
        !all(vapply(value, cache_fingerprintable, logical(1),
                    depth = depth + 1L))) {
      return(FALSE)
    }
  }
  attrs <- attributes(value)
  if (length(attrs) &&
      !all(vapply(attrs, cache_fingerprintable, logical(1),
                  depth = depth + 1L))) {
    return(FALSE)
  }
  TRUE
}

cache_function_signature <- function(f, seen, depth) {
  if (depth > 30L || any(vapply(seen, identical, logical(1), f))) return(NULL)
  if (is.primitive(f)) return(list(primitive = deparse(f)))
  env <- environment(f)
  if (isNamespace(env) || identical(env, baseenv())) {
    return(list(namespace = environmentName(env),
                body = deparse(body(f)), formals = deparse(formals(f))))
  }
  dependencies <- cache_dependency_values(f, c(seen, list(f)), depth + 1L)
  if (is.null(dependencies)) return(NULL)
  list(body = deparse(body(f)), formals = deparse(formals(f)),
       dependencies = dependencies)
}

cache_dependency_values <- function(f, seen = list(f), depth = 0L) {
  globals <- tryCatch(
    codetools::findGlobals(f, merge = FALSE),
    error = function(e) NULL
  )
  if (is.null(globals)) return(NULL)
  names <- sort(unique(c(globals$variables, globals$functions)))
  env <- environment(f)
  resolved <- lapply(names, function(name) {
    if (exists(name, envir = env, inherits = TRUE)) {
      value <- get(name, envir = env, inherits = TRUE)
      if (is.function(value)) {
        signature <- cache_function_signature(value, seen, depth + 1L)
        if (is.null(signature)) return(NULL)
        return(list(value = list(function_signature = signature)))
      }
      list(value = value)
    } else {
      list(value = structure(list(), class = "alder_missing_cache_dependency"))
    }
  })
  if (any(vapply(resolved, is.null, logical(1)))) return(NULL)
  values <- lapply(resolved, `[[`, "value")
  names(values) <- names
  if (!cache_fingerprintable(values)) return(NULL)
  values
}

cache_key <- function(f, args) {
  dependencies <- cache_dependency_values(f)
  if (is.null(dependencies) || !cache_fingerprintable(args)) return(NULL)
  tryCatch(
    rlang::hash(list(
      body = deparse(body(f)),
      formals = deparse(formals(f)),
      dependencies = dependencies,
      args = args
    )),
    error = function(e) NULL
  )
}

cache_dir_for <- function(dir = NULL) {
  target <- dir %||% getOption("alder.cache_dir") %||% .alder_state$cache_dir
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
  dirs <- .alder_state$disk_cache_dirs
  if (!is.environment(dirs)) {
    dirs <- new.env(parent = emptyenv())
    .alder_state$disk_cache_dirs <- dirs
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
    # Environments, external pointers, functions, and other reference-like
    # dependencies cannot produce a stable cross-run key. Recompute instead
    # of returning a potentially stale value.
    if (is.null(key)) return(do.call(f, args))
    if (identical(kind, "memory")) {
      store <- .alder_state$mem_cache
      if (!is.environment(store)) {
        store <- new.env(parent = emptyenv())
        .alder_state$mem_cache <- store
      }
      if (exists(key, envir = store, inherits = FALSE)) {
        return(get(key, envir = store, inherits = FALSE))
      }
      value <- do.call(f, args)
      assign(key, value, envir = store)
      return(value)
    }

    file <- file.path(cache_dir, paste0("alder-", key, ".rds"))
    if (file.exists(file)) {
      hit <- tryCatch(list(ok = TRUE, value = readRDS(file)),
                      error = function(e) list(ok = FALSE))
      if (isTRUE(hit$ok)) return(hit$value)
      unlink(file, force = TRUE)
    }
    value <- do.call(f, args)
    tmp <- tempfile(".alder-cache-", tmpdir = cache_dir)
    on.exit(unlink(tmp, force = TRUE), add = TRUE)
    tryCatch({
      saveRDS(value, tmp, version = 3)
      if (!file.rename(tmp, file) && !file.exists(file)) {
        unlink(tmp, force = TRUE)
      }
    }, error = function(e) unlink(tmp, force = TRUE))
    value
  }
  wrapper_env <- new.env(parent = environment(f))
  wrapper_env$f <- f
  wrapper_env$kind <- kind
  wrapper_env$cache_dir <- cache_dir
  wrapper_env$cache_key <- cache_key
  wrapper_env$.alder_state <- .alder_state
  environment(wrapped) <- wrapper_env
  attr(wrapped, "cache") <- kind
  class(wrapped) <- c("alder_cached", "function")
  wrapped
}

clear_cache_memory <- function() {
  store <- .alder_state$mem_cache
  if (is.environment(store)) {
    keys <- ls(store, all.names = TRUE)
    if (length(keys)) rm(list = keys, envir = store)
  }
  invisible()
}

clear_cache_disk <- function() {
  dirs <- .alder_state$disk_cache_dirs
  locations <- if (is.environment(dirs)) ls(dirs, all.names = TRUE) else character()
  default <- getOption("alder.cache_dir") %||% .alder_state$cache_dir
  if (!is.null(default) && length(default) == 1L && nzchar(default)) {
    locations <- unique(c(locations, normalizePath(default, mustWork = FALSE)))
  }
  for (dir in locations) {
    if (!dir.exists(dir)) next
    files <- list.files(dir, pattern = "^alder-[[:xdigit:]]+\\.rds$", full.names = TRUE)
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
#' include the function body and formals, call arguments, and serializable
#' values of free variables. Calls with reference-like dependencies that
#' cannot be fingerprinted are safely recomputed instead of cached.
#' Wrapped functions carry class \code{alder_cached}.
#'
#' @examples
#' square <- cache$memory(function(x) x ^ 2)
#' square(4)
#' cache$clear("memory")
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
