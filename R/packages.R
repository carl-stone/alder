# Package and project-library management.
#
# Package declarations are project metadata, not R session state.  The only
# on-disk state owned by this module is `.alder/packages.yaml`; writes are
# performed with a same-directory temporary file followed by rename so a
# process observing the project never sees a partially written document.
# Installation is deliberately delegated to a fresh Rscript process.  In
# particular, this file never calls library(), require(), or .libPaths() for a
# package selected by the user.

ALDER_PACKAGE_NAME_RE <- "^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$"
ALDER_PACKAGE_METADATA_FILE <- file.path(".alder", "packages.yaml")
ALDER_PACKAGE_INSTALL_LIB <- file.path(".alder", "library")

# A private registry is reserved for an asynchronous route implementation.
# The standalone alder_install() is synchronous and returns its final result;
# keeping this registry separate means an in-flight route need not serialize
# process state into project metadata.
ALDER_PACKAGE_JOBS <- new.env(parent = emptyenv())

.alder_packages_abort <- function(code, message, result = NULL) {
  if (exists("alder_abort", mode = "function", inherits = TRUE)) {
    alder_abort(code, message, result = result)
  }
  cond <- structure(
    list(message = as.character(message), code = code, result = result,
         call = NULL),
    class = c("alder_error", "error", "condition")
  )
  stop(cond)
}

.alder_package_path <- function(path = NULL, session = NULL,
                                require_notebook = FALSE) {
  if (is.null(path) && !is.null(session)) {
    candidate <- tryCatch({
      nb <- session$notebook_snapshot()
      if (is.list(nb)) nb$path else NULL
    }, error = function(e) NULL)
    # An in-memory notebook has NA/NULL as its path; package inspection still
    # has a useful deterministic project (the caller's working directory).
    if (is.character(candidate) && length(candidate) == 1L &&
        !is.na(candidate) && nzchar(candidate)) {
      path <- candidate
    }
  }

  if (is.null(path)) {
    if (isTRUE(require_notebook)) {
      .alder_packages_abort(
        "invalid_request",
        "sandbox mode requires a notebook path"
      )
    }
    project <- getwd()
    return(normalizePath(project, mustWork = TRUE))
  }
  if (!is.character(path) || length(path) != 1L || is.na(path) ||
      !nzchar(path) || any(charToRaw(path) == as.raw(0))) {
    .alder_packages_abort("invalid_request",
                          "path must be a nonempty string")
  }
  path <- path.expand(path)

  if (dir.exists(path)) {
    if (isTRUE(require_notebook)) {
      .alder_packages_abort(
        "invalid_request",
        "sandbox mode requires a notebook path, not a directory"
      )
    }
    return(normalizePath(path, mustWork = TRUE))
  }

  # Existing regular files, and not-yet-created paths with a notebook suffix,
  # identify the notebook.  A path without a suffix is treated as a project
  # directory so callers can bootstrap a project before creating a notebook.
  is_notebook <- file.exists(path) ||
    tolower(tools::file_ext(path)) %in% c("r", "rmd", "qmd", "ipynb")
  if (isTRUE(is_notebook)) {
    project <- dirname(path)
  } else {
    project <- path
  }
  project <- normalizePath(project, mustWork = FALSE)
  if (!dir.exists(project)) {
    # A project directory may be created by declaration/sandbox startup, but
    # never silently create a missing parent supplied as a notebook path.
    parent <- dirname(project)
    if (!dir.exists(parent)) {
      .alder_packages_abort("not_found",
                            paste("project directory not found:", parent))
    }
    if (!dir.create(project, recursive = FALSE, showWarnings = FALSE) &&
        !dir.exists(project)) {
      .alder_packages_abort("package_metadata_error",
                            paste("could not create project directory:", project))
    }
  }
  normalizePath(project, mustWork = TRUE)
}

.alder_package_file <- function(project) {
  file.path(project, ALDER_PACKAGE_METADATA_FILE)
}

.alder_validate_package_names <- function(packages, allow_empty = TRUE) {
  if (is.null(packages)) packages <- character()
  if (!is.character(packages) || anyNA(packages)) {
    .alder_packages_abort("invalid_request",
                          "packages must be a character vector of package names")
  }
  if (!isTRUE(allow_empty) && !length(packages)) {
    .alder_packages_abort("invalid_request", "at least one package is required")
  }
  bad <- which(!grepl(ALDER_PACKAGE_NAME_RE, packages, perl = TRUE))
  if (length(bad)) {
    .alder_packages_abort(
      "invalid_request",
      paste0("invalid package name: ", paste(packages[bad], collapse = ", "))
    )
  }
  sort(unique(packages))
}

.alder_validate_libs <- function(lib.loc) {
  if (is.null(lib.loc)) lib.loc <- .libPaths()
  if (!is.character(lib.loc) || anyNA(lib.loc)) {
    .alder_packages_abort("invalid_request",
                          "lib.loc must be a character vector of paths")
  }
  # installed.packages() emits noisy warnings or errors for nonexistent
  # libraries.  Ignoring those directories is deterministic and does not
  # mutate the caller's library search path.
  lib.loc <- unique(path.expand(lib.loc))
  lib.loc[dir.exists(lib.loc)]
}

.alder_yaml_packages <- function(path) {
  if (!file.exists(path)) return(character())
  if (dir.exists(path)) {
    .alder_packages_abort("package_metadata_error",
                          paste("package metadata is a directory:", path))
  }
  if (file.access(path, 4L) != 0L) {
    .alder_packages_abort("package_metadata_error",
                          paste("package metadata is not readable:", path))
  }
  bytes <- readBin(path, "raw", n = file.info(path)$size)
  if (any(bytes == as.raw(0))) {
    .alder_packages_abort("package_metadata_error",
                          paste("package metadata contains an embedded NUL:", path))
  }
  text <- tryCatch(rawToChar(bytes), error = function(e) NULL)
  parsed <- tryCatch(
    withCallingHandlers(
      yaml::yaml.load(text, eval.expr = FALSE),
      warning = function(w) {
        stop("malformed package metadata: ", conditionMessage(w),
             call. = FALSE)
      }
    ),
    error = function(e) {
      .alder_packages_abort(
        "package_metadata_error",
        paste("could not parse package metadata:", conditionMessage(e))
      )
    }
  )
  if (is.null(parsed)) return(character())

  # The canonical form is a mapping with one `packages` sequence.  Accepting
  # a top-level sequence keeps old hand-written files readable, while every
  # write below converts it to the canonical mapping.
  pkgs <- if (is.list(parsed) && !is.null(names(parsed))) {
    keys <- names(parsed)
    if (length(keys) != 1L || !identical(keys[[1L]], "packages")) {
      .alder_packages_abort("package_metadata_error",
                            "package metadata must contain only a packages sequence")
    }
    parsed$packages
  } else {
    parsed
  }
  if (is.null(pkgs)) return(character())
  if (is.list(pkgs)) {
    if (!is.null(names(pkgs)) && any(nzchar(names(pkgs)))) {
      .alder_packages_abort("package_metadata_error",
                            "packages must be a character sequence")
    }
    if (!length(pkgs)) {
      pkgs <- character()
    } else if (all(vapply(pkgs, function(x)
      is.character(x) && length(x) == 1L, logical(1)))) {
      pkgs <- unlist(pkgs, use.names = FALSE)
    } else {
      .alder_packages_abort("package_metadata_error",
                            "packages must be a character sequence")
    }
  }
  if (!is.character(pkgs) || anyNA(pkgs)) {
    .alder_packages_abort("package_metadata_error",
                          "packages must be a character sequence")
  }
  .alder_validate_package_names(pkgs)
}

.alder_write_yaml_packages <- function(path, packages) {
  packages <- .alder_validate_package_names(packages)
  parent <- dirname(path)
  if (!dir.exists(parent) &&
      (!dir.create(parent, recursive = TRUE, showWarnings = FALSE) &&
       !dir.exists(parent))) {
    .alder_packages_abort("package_metadata_error",
                          paste("could not create metadata directory:", parent))
  }
  if (file.access(parent, 2L) != 0L) {
    .alder_packages_abort("package_metadata_error",
                          paste("metadata directory is not writable:", parent))
  }
  # yaml::as.yaml is stable for a named list and gives the project file one
  # canonical ordering.  Ensure exactly one trailing LF independent of the
  # platform's native line ending.
  text <- yaml::as.yaml(list(packages = packages))
  text <- paste0(sub("[[:space:]]+$", "", text, perl = TRUE), "\n")
  tmp <- tempfile(pattern = ".packages-", tmpdir = parent)
  on.exit(unlink(tmp, force = TRUE), add = TRUE)
  con <- file(tmp, open = "wb")
  ok <- FALSE
  tryCatch({
    writeBin(charToRaw(enc2utf8(text)), con)
    flush(con)
    ok <- TRUE
  }, finally = close(con))
  if (!ok || !file.exists(tmp)) {
    .alder_packages_abort("package_metadata_error",
                          "could not write package metadata")
  }
  # On POSIX, rename(2) atomically replaces the previous path.  Do not use
  # unlink(path) as a fallback: that would expose a missing metadata window.
  if (!file.rename(tmp, path)) {
    .alder_packages_abort("package_metadata_error",
                          paste("could not atomically replace:", path))
  }
  invisible(path)
}

.alder_notebook_declared <- function(path = NULL, session = NULL) {
  nb_path <- path
  if (is.null(nb_path) && !is.null(session)) {
    nb_path <- tryCatch(session$notebook_snapshot()$path,
                        error = function(e) NULL)
  }
  if (!is.character(nb_path) || length(nb_path) != 1L || is.na(nb_path) ||
      !file.exists(nb_path) || dir.exists(nb_path)) return(character())
  meta <- tryCatch(read_notebook(nb_path)$metadata,
                   error = function(e) NULL)
  if (!is.list(meta) || is.null(meta$packages)) return(character())
  tryCatch(.alder_validate_package_names(meta$packages),
           error = function(e) character())
}

.alder_candidate_libs <- function(project) {
  unique(c(
    .alder_validate_libs(.libPaths()),
    file.path(project, ALDER_PACKAGE_INSTALL_LIB),
    file.path(project, ".alder", "renv", "library", R.version$platform,
              paste(R.version$major, R.version$minor, sep = "."))
  ))
}

#' Read project package declarations and their local availability.
#'
#' @param path Optional notebook path or project directory.
#' @param session Optional live Session; its notebook path and package state
#'   are used when available, without evaluating notebook code.
#' @return A list with declared, missing, installed, installing and error
#'   fields, plus a status data frame and metadata paths.
#' @noRd
alder_packages <- function(path = NULL, session = NULL) {
  project <- .alder_package_path(path, session)
  metadata_path <- .alder_package_file(project)
  declared <- .alder_yaml_packages(metadata_path)
  # Notebook metadata is a compatibility source for sessions created before
  # the project file existed.  A project file is authoritative when present.
  if (!file.exists(metadata_path)) {
    declared <- sort(unique(c(declared,
                              .alder_notebook_declared(path, session))))
  }

  statuses <- alder_package_status(declared,
                                   lib.loc = .alder_candidate_libs(project))
  installing <- character()
  errors <- NULL
  key <- normalizePath(project, mustWork = FALSE)
  if (exists(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)) {
    job <- get(key, envir = ALDER_PACKAGE_JOBS, inherits = FALSE)
    if (is.function(job$poll)) {
      current <- tryCatch(job$poll(), error = function(e) NULL)
      if (is.list(current) && identical(current$status, "installing")) {
        installing <- current$packages %||% character()
      } else if (is.list(current) && !is.null(current$error)) {
        errors <- current$error
        rm(list = key, envir = ALDER_PACKAGE_JOBS)
      }
    }
  }
  if (length(installing)) {
    statuses$status[statuses$package %in% installing] <- "installing"
  }
  missing <- statuses$package[statuses$status == "missing"]
  installed <- statuses$package[statuses$status == "installed"]
  list(
    declared = declared,
    missing = missing,
    installed = installed,
    installing = installing,
    error = errors,
    status = statuses,
    path = project,
    metadata = metadata_path,
    lib = .alder_candidate_libs(project)
  )
}

#' Declare project packages.
#'
#' @param packages Character package names.
#' @param path Optional notebook path or project directory.
#' @return The resulting declaration metadata and canonical file path.
#' @noRd
alder_declare <- function(packages, path = NULL) {
  packages <- .alder_validate_package_names(packages, allow_empty = FALSE)
  project <- .alder_package_path(path)
  metadata_path <- .alder_package_file(project)
  old <- sort(unique(c(
    .alder_yaml_packages(metadata_path),
    .alder_notebook_declared(path)
  )))
  declared <- sort(unique(c(old, packages)))
  .alder_write_yaml_packages(metadata_path, declared)
  list(
    ok = TRUE,
    path = project,
    metadata = metadata_path,
    declared = declared,
    packages = declared
  )
}

#' Determine package availability in explicit library paths.
#'
#' @param packages Character package names.
#' @param lib.loc Library paths; defaults to the caller's current paths.
#' @return A data frame with package, status, version and library columns.
#' @noRd
alder_package_status <- function(packages, lib.loc = .libPaths()) {
  packages <- .alder_validate_package_names(packages)
  libs <- .alder_validate_libs(lib.loc)
  out <- data.frame(
    package = packages,
    status = rep("missing", length(packages)),
    version = rep(NA_character_, length(packages)),
    library = rep(NA_character_, length(packages)),
    stringsAsFactors = FALSE
  )
  if (!length(packages) || !length(libs)) {
    class(out) <- c("alder_package_status", class(out))
    return(out)
  }

  # Read one library at a time so a package in the first path wins
  # deterministically, matching normal R library precedence.
  for (lib in libs) {
    ip <- tryCatch(
      utils::installed.packages(lib.loc = lib, fields = "Version",
                               noCache = TRUE),
      error = function(e) NULL
    )
    if (is.null(ip) || !NROW(ip)) next
    found <- match(packages, rownames(ip))
    take <- which(!is.na(found) & out$status == "missing")
    if (!length(take)) next
    out$status[take] <- "installed"
    out$version[take] <- as.character(ip[found[take], "Version"])
    out$library[take] <- lib
  }
  class(out) <- c("alder_package_status", class(out))
  out
}

.alder_install_library <- function(project, lib = NULL) {
  if (is.null(lib)) lib <- file.path(project, ALDER_PACKAGE_INSTALL_LIB)
  if (!is.character(lib) || length(lib) != 1L || is.na(lib) || !nzchar(lib) ||
      any(charToRaw(lib) == as.raw(0))) {
    .alder_packages_abort("invalid_request",
                          "lib must be a nonempty path")
  }
  lib <- normalizePath(path.expand(lib), mustWork = FALSE)
  if (!dir.exists(lib) &&
      (!dir.create(lib, recursive = TRUE, showWarnings = FALSE) &&
       !dir.exists(lib))) {
    .alder_packages_abort("invalid_request",
                          paste("could not create package library:", lib))
  }
  if (file.access(lib, 2L) != 0L) {
    .alder_packages_abort("invalid_request",
                          paste("package library is not writable:", lib))
  }
  lib
}
.alder_install_script <- function() {
  # Keep this source self-contained: the child only loads pak after it has
  # been spawned, and no package selected by the user is loaded in the parent.
  paste(c(
    "args <- commandArgs(trailingOnly = TRUE)",
    "if (length(args) && identical(args[[1L]], '--args')) args <- args[-1L]",
    "lib <- Sys.getenv('ALDER_PACKAGE_LIB', unset = '')",
    "if (!nzchar(lib) || !dir.exists(lib)) {",
    "  cat('ALDER_PACKAGE_ERROR\\tinvalid_request\\tpackage library is unavailable\\n', file = stderr())",
    "  quit(status = 42)",
    "}",
    "if (!requireNamespace('pak', quietly = TRUE)) {",
    "  cat('ALDER_PACKAGE_ERROR\\tinvalid_request\\tinstall requires the pak package\\n', file = stderr())",
    "  quit(status = 42)",
    "}",
    "result <- tryCatch({",
    "  pak::pkg_install(args, lib = lib)",
    "  TRUE",
    "}, error = function(e) {",
    "  cat('ALDER_PACKAGE_ERROR\\tinstall_failed\\t', conditionMessage(e), '\\n', sep = '', file = stderr())",
    "  FALSE",
    "})",
    "if (!isTRUE(result)) quit(status = 1)",
    "quit(status = 0)"
  ), collapse = "\n")
}

.alder_bound_output <- function(x, limit = 65536L) {
  x <- as.character(x %||% "")
  if (!length(x)) return("")
  x[is.na(x)] <- ""
  if (length(x) > 1L) x <- paste(x, collapse = "\n")
  if (nchar(x, type = "bytes") > limit) {
    suffix <- "\n[output truncated]"
    keep <- max(0L, as.integer(limit) - nchar(suffix, type = "bytes"))
    paste0(substr(x, 1L, keep), suffix)
  } else {
    x
  }
}

.alder_install_error <- function(stdout, stderr, status) {
  output <- .alder_bound_output(paste(c(stdout, stderr), collapse = "\n"))
  lines <- strsplit(output, "\n", fixed = TRUE)[[1L]]
  marker <- grep("^ALDER_PACKAGE_ERROR\t", lines)
  code <- "install_failed"
  message <- paste0("package installation failed (exit status ", status, ")")
  if (length(marker)) {
    idx <- marker[[1L]]
    fields <- strsplit(lines[[idx]], "\t", fixed = TRUE)[[1L]]
    if (length(fields) >= 3L) {
      code <- fields[[2L]]
      detail <- fields[-c(1L, 2L)]
      # pak often prints the package solver detail on lines after its marker;
      # keep that context in the diagnostic while output retains the full log.
      tail_lines <- if (idx < length(lines)) lines[(idx + 1L):length(lines)] else character()
      tail_lines <- tail_lines[nzchar(trimws(tail_lines))]
      message <- paste(c(detail, tail_lines), collapse = "\n")
    }
  }
  list(code = code, message = message, output = output,
       status = as.integer(status))
}

#' Install packages in an isolated child process.
#'
#' Installation never changes the caller's .libPaths() or loads a selected
#' package in the parent.  The returned list is successful for a no-op when all
#' requested packages are already present, and otherwise includes an `error`
#' diagnostic instead of throwing for child-process failures.
#'
#' @param packages Character package names.
#' @param path Optional notebook path or project directory.
#' @param lib Explicit target library; defaults to `<project>/.alder/library`.
#' @return An explicit result list with state vectors and optional error.
#' @noRd
alder_install <- function(packages, path = NULL, lib = NULL) {
  if (is.null(packages)) {
    .alder_packages_abort("invalid_request",
                          "packages must be a character vector of package names")
  }
  packages <- .alder_validate_package_names(packages)
  project <- .alder_package_path(path)
  target <- .alder_install_library(project, lib)
  before <- alder_package_status(packages, lib.loc = unique(c(target, .libPaths())))
  needed <- before$package[before$status == "missing"]
  base_result <- function(ok, status, error = NULL, output = "") {
    after <- alder_package_status(packages,
                                  lib.loc = unique(c(target, .libPaths())))
    list(
      ok = isTRUE(ok),
      status = status,
      path = project,
      lib = target,
      packages = packages,
      installed = after$package[after$status == "installed"],
      missing = after$package[after$status == "missing"],
      installing = character(),
      error = error,
      output = .alder_bound_output(output),
      package_status = after
    )
  }
  if (!length(needed)) return(base_result(TRUE, "installed"))

  started <- tryCatch(
    processx::run(
      file.path(R.home("bin"), "Rscript"),
      args = c("--vanilla", "-e", .alder_install_script(), "--args", needed),
      env = c(ALDER_PACKAGE_LIB = target, R_LIBS_USER = target),
      stdout = "|", stderr = "|", error_on_status = FALSE
    ),
    error = function(e) e
  )
  if (inherits(started, "error")) {
    return(base_result(
      FALSE, "error",
      list(code = "install_failed", message = conditionMessage(started),
           output = "", status = NA_integer_), ""
    ))
  }
  output <- paste(c(started$stdout %||% "", started$stderr %||% ""),
                  collapse = "\n")
  if (!identical(as.integer(started$status), 0L)) {
    err <- .alder_install_error(started$stdout, started$stderr,
                                started$status)
    return(base_result(FALSE, "error", err, output))
  }
  final <- base_result(TRUE, "installed", output = output)
  # A successful child can still leave a requested package absent (for
  # example, a repository mirror may skip an optional dependency).  Surface
  # that as a diagnostic rather than claiming success.
  if (length(final$missing)) {
    final$ok <- FALSE
    final$status <- "error"
    final$error <- list(
      code = "install_failed",
      message = paste("packages remain unavailable:",
                      paste(final$missing, collapse = ", ")),
      output = .alder_bound_output(output), status = 0L
    )
  }
  final
}

#' Resolve and create the deterministic project sandbox library.
#'
#' @param path A notebook path.  A project directory or NULL is rejected so a
#'   sandbox cannot accidentally be attached to an unsaved notebook.
#' @return A list containing the platform/versioned library and child-process
#'   environment variables.
#' @noRd
alder_sandbox <- function(path = NULL) {
  if (is.null(path) || !is.character(path) || length(path) != 1L ||
      is.na(path) || !nzchar(path)) {
    .alder_packages_abort("invalid_request",
                          "sandbox mode requires a notebook path")
  }
  if (dir.exists(path)) {
    .alder_packages_abort("invalid_request",
                          "sandbox mode requires a notebook path, not a directory")
  }
  project <- .alder_package_path(path, require_notebook = TRUE)
  lib <- file.path(project, ".alder", "renv", "library", R.version$platform,
                   paste(R.version$major, R.version$minor, sep = "."))
  if (!dir.exists(lib) &&
      (!dir.create(lib, recursive = TRUE, mode = "0700",
                   showWarnings = FALSE) && !dir.exists(lib))) {
    .alder_packages_abort("invalid_request",
                          paste("could not create sandbox library:", lib))
  }
  old_user <- Sys.getenv("R_LIBS_USER", unset = "")
  user_libs <- c(lib, if (nzchar(old_user)) old_user)
  user_libs <- paste(user_libs, collapse = .Platform$path.sep)
  # The sandbox must be first in the worker's library path even when the
  # parent process set R_LIBS (R_LIBS takes precedence over R_LIBS_USER);
  # otherwise the worker could resolve packages outside the sandbox.
  old_libs <- Sys.getenv("R_LIBS", unset = "")
  env <- c(R_LIBS_USER = user_libs,
           R_LIBS = if (nzchar(old_libs)) {
             paste(c(lib, old_libs), collapse = .Platform$path.sep)
           })
  list(
    path = project,
    root = file.path(project, ".alder", "renv"),
    lib = lib,
    R_LIBS_USER = user_libs,
    env = env
  )
}

# Startup convenience for the launcher: unlike alder_sandbox(), this helper
# returns only the environment mapping and is kept private until route wiring
# decides whether to expose it.
.alder_sandbox_env <- function(path) alder_sandbox(path)$env
