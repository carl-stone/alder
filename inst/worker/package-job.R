# One-shot package worker. It inspects package metadata and performs only an
# explicit package operation requested by the host; it never evaluates notebook
# source or attaches a package to Ark.
local({
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 2L) stop("package worker requires input and result paths", call. = FALSE)
  input_path <- args[[1L]]
  result_path <- args[[2L]]
path_is_absolute <- function(value) {
  if (.Platform$OS.type == "windows") {
    (nchar(value, type = "bytes") >= 3L && grepl("^[A-Za-z]:", value) &&
      utf8ToInt(substr(value, 3L, 3L)) %in% c(47L, 92L)) ||
      startsWith(value, "//") || startsWith(value, intToUtf8(c(92L, 92L)))
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
framing_path <- normalizePath(file.path(bootstrap_worker_dir, "host-framing.R"),
                              mustWork = FALSE, winslash = "/")
if (!path_is_under(framing_path, resources_root) ||
    !identical(dirname(framing_path), bootstrap_worker_dir) ||
    !file.exists(framing_path) || isTRUE(file.info(framing_path)$isdir) ||
    file.access(framing_path, 4L) != 0L) {
  stop("validated Alder host framing module is missing or outside resources", call. = FALSE)
}
framing <- new.env(parent = baseenv())
sys.source(framing_path, envir = framing, keep.source = FALSE)

  read_request <- function(path) {
    info <- file.info(path)
    if (is.na(info$size) || info$size < 1 || info$size > 16 * 1024 * 1024) {
      stop("package worker input is missing or exceeds 16 MiB", call. = FALSE)
    }
    bytes <- readBin(path, "raw", n = info$size)
    if (any(bytes == as.raw(0))) stop("package worker input contains a NUL", call. = FALSE)
    text <- rawToChar(bytes)
    Encoding(text) <- "UTF-8"
    if (!validUTF8(text)) stop("package worker input is not valid UTF-8", call. = FALSE)
    framing$check_json_text(text)
    value <- jsonlite::fromJSON(text, simplifyVector = FALSE)
    framing$check_json_value(value)
    if (!is.list(value) || is.null(names(value)) || anyDuplicated(names(value)) ||
        identical(identical(sort(names(value)), c("command", "payload")), FALSE)) {
      stop("package worker request must contain command and payload", call. = FALSE)
    }
    value
  }

  scalar_string <- function(value, label, allow_empty = FALSE, max_bytes = 4096L) {
    if (!is.character(value) || length(value) != 1L || is.na(value) ||
        (!allow_empty && !nzchar(value)) || !validUTF8(value) ||
        nchar(value, type = "bytes") > max_bytes) {
      stop(paste0(label, " must be a bounded UTF-8 string"), call. = FALSE)
    }
    value
  }
  scalar_path <- function(value, label) {
    value <- scalar_string(value, label, max_bytes = 4096L)
    absolute <- if (.Platform$OS.type == "windows") {
      (nchar(value, type = "bytes") >= 3L && grepl("^[A-Za-z]:", value) &&
        utf8ToInt(substr(value, 3L, 3L)) %in% c(47L, 92L)) ||
        startsWith(value, "//") || startsWith(value, intToUtf8(c(92L, 92L)))
    } else startsWith(value, "/")
    if (!absolute || any(charToRaw(value) == as.raw(0))) {
      stop(paste0(label, " must be an absolute path"), call. = FALSE)
    }
    value
  }
  package_names <- function(value) {
    if (!is.list(value) || (!is.null(names(value)) && any(nzchar(names(value))))) {
      stop("packages must be an array", call. = FALSE)
    }
    if (!length(value)) return(character())
    packages <- vapply(value, function(item) scalar_string(item, "package name", max_bytes = 256L), "")
    if (any(!grepl("^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$", packages, perl = TRUE))) {
      stop("invalid package name", call. = FALSE)
    }
    sort(unique(packages))
  }
  library_paths <- function(value) {
    if (!is.list(value) || (!is.null(names(value)) && any(nzchar(names(value))))) {
      stop("libraryPaths must be an array", call. = FALSE)
    }
    if (!length(value)) return(character())
    paths <- vapply(value, function(item) scalar_path(item, "library path"), "")
    unique(paths)
  }
  object <- function(value, label) {
    if (!is.list(value) || is.null(names(value)) || anyDuplicated(names(value))) {
      stop(paste0(label, " must be a JSON object"), call. = FALSE)
    }
    value
  }
  `%||%` <- function(left, right) if (is.null(left)) right else left
  strict_lock_string <- function(value, label, max_bytes = 64L * 1024L) {
    if (!is.character(value) || length(value) != 1L || is.na(value) || !nzchar(value)
        || !validUTF8(value) || nchar(value, type = "bytes") > max_bytes
        || grepl("[[:cntrl:]]", value, perl = TRUE)) {
      stop(paste0(label, " must be a bounded lockfile string"), call. = FALSE)
    }
    value
  }
  strict_lock_object <- function(value, label) {
    if (!is.list(value) || is.null(names(value)) || anyDuplicated(names(value))) {
      stop(paste0(label, " must be a JSON object"), call. = FALSE)
    }
    value
  }
  check_lock_keys <- function(value, label = "renv.lock") {
    if (!is.list(value)) return(invisible(NULL))
    keys <- names(value)
    if (!is.null(keys) && anyDuplicated(keys)) {
      stop(paste0(label, " contains duplicate object keys"), call. = FALSE)
    }
    for (index in seq_along(value)) {
      child <- if (!is.null(keys) && length(keys)) paste0(label, ".", keys[[index]])
               else paste0(label, "[", index, "]")
      check_lock_keys(value[[index]], child)
    }
    invisible(NULL)
  }
  read_lockfile <- function(path) {
    info <- file.info(path)
    if (is.na(info$size) || info$size < 1 || info$size > 16 * 1024 * 1024) {
      stop("renv.lock is missing or exceeds 16 MiB", call. = FALSE)
    }
    if (!file.exists(path) || dir.exists(path) || nzchar(Sys.readlink(path))) {
      stop("renv.lock must be the project's regular file", call. = FALSE)
    }
    bytes <- readBin(path, "raw", n = info$size)
    if (any(bytes == as.raw(0))) stop("renv.lock contains a NUL", call. = FALSE)
    text <- rawToChar(bytes)
    Encoding(text) <- "UTF-8"
    if (!validUTF8(text) || !isTRUE(jsonlite::validate(text))) {
      stop("renv.lock is not valid JSON", call. = FALSE)
    }
    lock <- tryCatch(jsonlite::fromJSON(text, simplifyVector = FALSE),
                     error = function(error) stop("renv.lock could not be parsed: ",
                                                  conditionMessage(error), call. = FALSE))
    check_lock_keys(lock)
    lock <- strict_lock_object(lock, "renv.lock")
    if (!all(c("R", "Packages") %in% names(lock))) {
      stop("renv.lock must contain R and Packages", call. = FALSE)
    }
    r <- strict_lock_object(lock$R, "renv.lock R")
    strict_lock_string(r$Version, "renv.lock R.Version")
    if (!is.list(r$Repositories) || !is.null(names(r$Repositories))) {
      stop("renv.lock R.Repositories must be an array", call. = FALSE)
    }
    repositories <- lapply(r$Repositories, function(repository) {
      repository <- strict_lock_object(repository, "renv.lock repository")
      if (!all(c("Name", "URL") %in% names(repository))) {
        stop("renv.lock repository must contain Name and URL", call. = FALSE)
      }
      list(Name = strict_lock_string(repository$Name, "renv.lock repository Name"),
           URL = strict_lock_string(repository$URL, "renv.lock repository URL"))
    })
    if (length(repositories)) {
      repository_names <- vapply(repositories, function(value) value$Name, "")
      if (anyDuplicated(repository_names)) stop("renv.lock has duplicate repositories", call. = FALSE)
    }
    packages_map <- lock$Packages
    if (!is.list(packages_map) || is.null(names(packages_map)) || anyDuplicated(names(packages_map))) {
      stop("renv.lock Packages must be an object", call. = FALSE)
    }
    package_records <- lapply(names(packages_map), function(name) {
      if (!grepl("^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$", name, perl = TRUE)) {
        stop("renv.lock has an invalid package name", call. = FALSE)
      }
      record <- strict_lock_object(packages_map[[name]], paste0("renv.lock package ", name))
      if (!all(c("Package", "Version", "Source") %in% names(record))
          || !identical(record$Package, name)) {
        stop(paste0("renv.lock package ", name, " lacks an exact Package identity"), call. = FALSE)
      }
      strict_lock_string(record$Package, paste0("renv.lock package ", name, ".Package"))
      strict_lock_string(record$Version, paste0("renv.lock package ", name, ".Version"))
      source <- strict_lock_string(record$Source, paste0("renv.lock package ", name, ".Source"))
      repository <- record$Repository %||% NULL
      if (!is.null(repository)) strict_lock_string(repository, paste0("renv.lock package ", name, ".Repository"))
      if (tolower(source) %in% c("repository", "cran", "p3m", "ppm", "rspm", "bioconductor")
          && is.null(repository)) {
        stop(paste0("renv.lock package ", name, " lacks repository identity"), call. = FALSE)
      }
      for (field in names(record)) {
        if (startsWith(field, "Remote")) strict_lock_string(record[[field]],
          paste0("renv.lock package ", name, ".", field))
      }
      record
    })
    names(package_records) <- names(packages_map)
    list(records = package_records, repositories = repositories)
  }
  require_locked_packages <- function(packages, snapshot) {
    missing <- setdiff(packages, names(snapshot$records))
    if (length(missing)) {
      stop(structure(list(message = paste0("renv.lock does not declare requested package(s): ",
                                           paste(missing, collapse = ", ")),
                        code = "package_metadata_error", mutated = FALSE),
                     class = c("alder_package_error", "error", "condition")))
    }
    invisible(NULL)
  }
  emit <- function(phase, package = NULL, message = NULL) {
    event <- list(phase = phase)
    if (!is.null(package)) event$package <- package
    if (!is.null(message)) event$message <- message
    cat("ALDER_PACKAGE_PROGRESS\t",
        jsonlite::toJSON(event, auto_unbox = TRUE, null = "null"),
        "\n", sep = "", file = stdout())
    flush(stdout())
  }
  normalize_lock_source <- function(record) {
    source <- tolower(as.character(record$Source %||%
      if (!is.null(record$Repository)) "repository" else "unknown"))
    if (source %in% c("cran", "p3m", "ppm", "rspm")) source <- "repository"
    if (source %in% c("git2r", "xgit")) source <- "git"
    source
  }
  same_record_value <- function(left, right) {
    if (is.null(left) || is.null(right)) return(is.null(left) && is.null(right))
    identical(as.character(unlist(left, use.names = FALSE)),
              as.character(unlist(right, use.names = FALSE)))
  }
  lock_record_matches <- function(installed, locked, snapshot) {
    if (!is.list(installed) || !is.list(locked)
        || !same_record_value(installed$Version, locked$Version)
        || !identical(normalize_lock_source(installed), normalize_lock_source(locked))) {
      return(FALSE)
    }
    source <- normalize_lock_source(locked)
    if (source %in% c("repository", "bioconductor")) {
      expected_repository <- locked$Repository %||% NULL
      actual_repository <- installed$Repository %||% NULL
      if (is.null(expected_repository) || is.null(actual_repository)
          || (!same_record_value(expected_repository, actual_repository)
              && !any(vapply(snapshot$repositories, function(repository)
                identical(repository$Name, expected_repository)
                  && identical(repository$URL, actual_repository), logical(1))))) {
        return(FALSE)
      }
    }
    remote_names <- union(grep("^Remote", names(locked), value = TRUE),
                          grep("^Remote", names(installed), value = TRUE))
    if (source == "repository") remote_names <- character()
    all(vapply(remote_names, function(field)
      same_record_value(locked[[field]] %||% NULL, installed[[field]] %||% NULL), logical(1)))
  }
  lock_library_matches <- function(packages, snapshot, project, library, lockfile) {
    installed <- tryCatch(
      renv:::renv_snapshot_library(library = library, project = project),
      error = function(error) {
        stop(structure(list(message = paste0("could not verify renv library: ",
                                             conditionMessage(error)),
                             code = "install_failed", mutated = TRUE),
                       class = c("alder_package_error", "error", "condition")))
      }
    )
    if (!is.list(installed)) {
      stop(structure(list(message = "renv returned invalid library records",
                           code = "install_failed", mutated = TRUE),
                     class = c("alder_package_error", "error", "condition")))
    }
    exact <- vapply(packages, function(name) {
      candidate <- installed[[name]]
      !is.null(candidate) && lock_record_matches(candidate, snapshot$records[[name]], snapshot)
    }, logical(1))
    list(installed = installed, exact = exact)
  }
  package_record <- function(name, installed, version = NULL, library = NULL) {
    list(package = name, status = if (installed) "installed" else "missing",
         version = if (installed) as.character(version %||% NA_character_) else NULL,
         library = if (installed) as.character(library %||% NA_character_) else NULL)
  }
  inspect <- function(packages, paths, expected = NULL) {
    records <- lapply(packages, function(name) package_record(name, FALSE))
    for (lib in unique(paths)) {
      if (!dir.exists(lib)) next
      table <- tryCatch(
        suppressWarnings(utils::installed.packages(lib.loc = lib, fields = "Version", noCache = TRUE)),
        error = function(error) NULL
      )
      if (is.null(table) || !NROW(table)) next
      found <- match(packages, rownames(table))
      for (index in which(!is.na(found))) {
        if (identical(records[[index]]$status, "installed")) next
        version <- as.character(table[found[[index]], "Version"])
        if (!is.null(expected) &&
            (is.null(expected[[packages[[index]]]])
             || !identical(version, as.character(expected[[packages[[index]]]]$Version)))) next
        records[[index]] <- package_record(packages[[index]], TRUE, version, lib)
      }
    }
    records
  }
  output_records <- function(records) {
    lapply(records, function(record) {
      list(package = record$package, status = record$status,
           version = if (is.null(record$version) || is.na(record$version)) NULL else record$version,
           library = if (is.null(record$library) || is.na(record$library)) NULL else record$library)
    })
  }
  error_result <- function(packages, library, records, code, message, mutated = FALSE, status = NULL) {
    list(ok = FALSE, status = "error", mutatedLibrary = isTRUE(mutated),
         library = library, output = "", records = output_records(records),
         error = list(code = code, message = message,
                      status = status, output = ""))
  }
  request <- read_request(input_path)
  command <- scalar_string(request$command, "command", max_bytes = 32L)
  if (!command %in% c("status", "install")) {
    stop("unknown package worker command", call. = FALSE)
  }
  payload <- object(request$payload, "payload")
  required <- c("projectDirectory", "packages", "mode", "lockfilePath", "libraryPath", "libraryPaths")
  allowed <- c(required, "operationId")
  if (!all(required %in% names(payload)) || any(!names(payload) %in% allowed)) {
    stop("package worker payload has an invalid shape", call. = FALSE)
  }
  if ("operationId" %in% names(payload)) scalar_string(payload$operationId, "operationId", max_bytes = 128L)
  project <- scalar_path(payload$projectDirectory, "projectDirectory")
  if (!dir.exists(project)) stop("projectDirectory is not an existing directory", call. = FALSE)
  packages <- package_names(payload$packages)
  mode <- scalar_string(payload$mode, "mode", max_bytes = 16L)
  if (!mode %in% c("pak", "renv")) stop("package worker mode is invalid", call. = FALSE)
  lockfile <- payload$lockfilePath
  if (!is.null(lockfile)) {
    lockfile <- scalar_path(lockfile, "lockfilePath")
    if (!file.exists(lockfile) || dir.exists(lockfile) || nzchar(Sys.readlink(lockfile))) {
      stop("renv.lock is unavailable or symbolic", call. = FALSE)
    }
    lockfile <- normalizePath(lockfile, mustWork = TRUE, winslash = "/")
    expected_lockfile <- normalizePath(file.path(project, "renv.lock"), mustWork = TRUE, winslash = "/")
    if (!identical(lockfile, expected_lockfile)) stop("lockfilePath must be project renv.lock", call. = FALSE)
  }
  if (identical(mode, "renv") && is.null(lockfile)) stop("renv mode requires renv.lock", call. = FALSE)
  if (identical(mode, "pak") && !is.null(lockfile)) stop("pak mode does not accept renv.lock", call. = FALSE)
  assert_project_library <- function(path, expected = NULL) {
    physical_project <- normalizePath(project, mustWork = TRUE, winslash = "/")
    physical <- normalizePath(path, mustWork = TRUE, winslash = "/")
    if (!startsWith(paste0(physical, "/"), paste0(physical_project, "/"))) {
      stop("package library escapes the project directory", call. = FALSE)
    }
    relative <- substring(path, nchar(project) + 2L)
    cursor <- project
    for (part in strsplit(relative, "/", fixed = TRUE)[[1L]]) {
      cursor <- file.path(cursor, part)
      if (nzchar(Sys.readlink(cursor))) stop("package library path contains a symbolic link", call. = FALSE)
    }
    if (!is.null(expected) && !identical(physical, expected)) stop("pak libraryPath must be the project-local .alder/library", call. = FALSE)
    physical
  }
  library <- payload$libraryPath
  if (!is.null(library)) library <- scalar_path(library, "libraryPath")
  if (identical(mode, "renv") && !is.null(library)) stop("renv mode resolves its own project library", call. = FALSE)
  paths <- library_paths(payload$libraryPaths)
  if (identical(command, "install") && identical(mode, "pak") && is.null(library)) stop("pak mode requires a target library", call. = FALSE)
  if (identical(mode, "pak") && !is.null(library)) {
    canonical_library <- file.path(normalizePath(project, mustWork = TRUE, winslash = "/"), ".alder", "library")
    library <- assert_project_library(library, canonical_library)
    paths <- unique(c(library, paths))
  }
  # Package availability is project-local. Environment libraries are supplied
  # only for the Alder bootstrap and never satisfy an explicit project install.
  project_paths <- if (is.null(library)) character() else library
  lock_snapshot <- NULL

  run <- function() {
    if (identical(mode, "renv")) {
      # Parse and bind the lock before touching the project library.
      lock_snapshot <<- read_lockfile(lockfile)
      require_locked_packages(packages, lock_snapshot)
      if (!requireNamespace("renv", quietly = TRUE)) {
        stop(structure(list(message = "renv is required for projects with renv.lock",
                             code = "environment_unavailable"), class = c("alder_package_error", "error", "condition")))
      }
      library <<- normalizePath(renv::paths$library(project = project), mustWork = FALSE)
      dir.create(library, recursive = TRUE, showWarnings = FALSE, mode = "0700")
      library <<- assert_project_library(library)
      project_paths <<- library
      paths <<- unique(c(library, paths))
    }
    expected <- if (is.null(lock_snapshot)) NULL else lock_snapshot$records
    if (identical(command, "status")) {
      records <- inspect(packages, project_paths, expected)
      if (identical(mode, "renv")) {
        verified <- lock_library_matches(packages, lock_snapshot, project, library, lockfile)
        records <- lapply(seq_along(records), function(index)
          if (isTRUE(verified$exact[[index]])) records[[index]] else package_record(packages[[index]], FALSE))
      }
      emit("status")
      return(list(ok = TRUE, status = "installed", mutatedLibrary = FALSE,
                  output = "", records = output_records(records), library = library))
    }
    if (!length(packages)) stop("at least one package is required", call. = FALSE)
    if (identical(mode, "pak")) {
      if (identical(dir.exists(library), FALSE) &&
          identical(isTRUE(dir.create(library, recursive = TRUE, mode = "0700", showWarnings = FALSE)), FALSE) &&
          identical(dir.exists(library), FALSE)) stop("could not create package library", call. = FALSE)
      if (file.access(library, 2L) != 0L) stop("package library is not writable", call. = FALSE)
    } else if (!dir.exists(library)) {
      # renv owns its project library layout, but the explicit target keeps
      # installation out of the bootstrap/user libraries.
      if (identical(isTRUE(dir.create(library, recursive = TRUE, mode = "0700", showWarnings = FALSE)), FALSE) &&
          identical(dir.exists(library), FALSE)) stop("could not create renv project library", call. = FALSE)
    }
    if (identical(mode, "renv") && file.access(library, 2L) != 0L) {
      stop("renv project library is not writable", call. = FALSE)
    }
    before <- inspect(packages, project_paths, expected)
    missing_before <- vapply(before, function(record) identical(record$status, "missing"), logical(1))
    needed <- if (identical(mode, "renv")) packages else packages[missing_before]
    if (!length(needed)) {
      emit("complete", message = "all requested packages are already installed")
      return(list(ok = TRUE, status = "installed", mutatedLibrary = FALSE,
                  output = "", records = output_records(before), library = library))
    }
    for (name in needed) emit("install", name)
    if (identical(mode, "pak")) {
      if (!requireNamespace("pak", quietly = TRUE)) {
        return(error_result(packages, library, before, "environment_unavailable",
                            "pak is required for ordinary project package installs", FALSE))
      }
      tryCatch({
        pak::pkg_install(needed, lib = library)
      }, error = function(error) {
        stop(structure(list(message = conditionMessage(error), code = "install_failed",
                             mutated = TRUE), class = c("alder_package_error", "error", "condition")))
      })
    } else {
      tryCatch({
        renv::restore(project = project, library = library, lockfile = lockfile,
                      packages = needed, prompt = FALSE, clean = FALSE, strict = TRUE,
                      retry = FALSE, transactional = TRUE)
      }, error = function(error) {
        stop(structure(list(message = conditionMessage(error), code = "install_failed",
                             mutated = TRUE), class = c("alder_package_error", "error", "condition")))
      })
    }
    after <- inspect(packages, project_paths, expected)
    if (identical(mode, "renv")) {
      verified <- lock_library_matches(packages, lock_snapshot, project, library, lockfile)
      after <- lapply(seq_along(after), function(index)
        if (isTRUE(verified$exact[[index]])) after[[index]] else package_record(packages[[index]], FALSE))
    }
    missing <- vapply(after, function(record) identical(record$status, "missing"), logical(1))
    if (any(missing)) {
      return(error_result(packages, library, after, "install_failed",
                          paste("packages remain unavailable:", paste(packages[missing], collapse = ", ")),
                          TRUE, 0L))
    }
    emit("complete")
    list(ok = TRUE, status = "installed", mutatedLibrary = TRUE,
         output = "", records = output_records(after), library = library)
  }

  response <- tryCatch({
    value <- run()
    list(ok = TRUE, result = value)
  }, error = function(error) {
    code <- if (is.null(error$code)) "job_failed" else as.character(error$code)
    mutated <- isTRUE(error$mutated)
    if (identical(command, "install") && identical(code, "install_failed")) mutated <- TRUE
    expected <- if (is.null(lock_snapshot)) NULL else lock_snapshot$records
    list(ok = TRUE, result = error_result(packages, library, inspect(packages, project_paths, expected),
                                          code, conditionMessage(error), mutated))
  })
  jsonlite::write_json(response, result_path, auto_unbox = TRUE, null = "null", force = TRUE)
})
