# One short-lived project package operation using the selected R executable.
local({
  `%||%` <- function(left, right) if (is.null(left)) right else left
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 2L) stop("package service requires input and result paths", call. = FALSE)
  worker_dir <- Sys.getenv("ALDER_WORKER_DIR", unset = "")
  sys.source(file.path(worker_dir, "private-json.R"), envir = environment(), keep.source = FALSE)
  read_json <- jsonlite::read_json
  from_json <- jsonlite::fromJSON
  selected_libraries <- from_json(
    Sys.getenv("ALDER_SELECTED_R_LIBRARIES", unset = "[]"),
    simplifyVector = TRUE
  )
  Sys.unsetenv("ALDER_SELECTED_R_LIBRARIES")
  if (!is.character(selected_libraries) || any(!dir.exists(selected_libraries))) {
    stop("selected R libraries are unavailable", call. = FALSE)
  }
  request <- read_json(args[[1L]], simplifyVector = TRUE)
  command <- request$command
  project <- request$projectDirectory
  library <- request$library
  packages <- unique(as.character(request$packages %||% character()))
  repositories <- unique(as.character(request$repositories %||% character()))
  if (!length(repositories)) repositories <- as.character(getOption("repos"))
  repositories[repositories == "@CRAN@"] <- "https://cloud.r-project.org"
  repositories <- unique(repositories[nzchar(repositories)])
  if (!command %in% c("status", "install")) stop("unknown package command", call. = FALSE)
  if (!is.character(project) || length(project) != 1L || !dir.exists(project)) stop("project directory is unavailable", call. = FALSE)
  if (!is.character(library) || length(library) != 1L || !nzchar(library)) stop("project library is unavailable", call. = FALSE)
  if (any(!grepl("^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$", packages))) stop("invalid package name", call. = FALSE)
  .libPaths(unique(c(library, selected_libraries)))
  try(unloadNamespace("jsonlite"), silent = TRUE)

  record <- function(name) {
    description <- suppressWarnings(tryCatch(utils::packageDescription(name, lib.loc = library), error = function(error) NULL))
    if (is.null(description) || !"Version" %in% names(description)) {
      list(package = name, status = "missing", version = NULL, library = NULL)
    } else {
      list(package = name, status = "installed", version = unname(description[["Version"]]), library = library)
    }
  }
  inspect <- function() lapply(packages, record)
  mutated <- FALSE
  response <- tryCatch({
    if (identical(command, "install")) {
      dir.create(library, recursive = TRUE, showWarnings = FALSE, mode = "0700")
      missing <- packages[vapply(inspect(), function(value) identical(value$status, "missing"), logical(1))]
      if (length(missing)) {
        if (!length(repositories)) stop("no package repository is configured", call. = FALSE)
        mutated <- TRUE
        utils::install.packages(missing, lib = library, repos = repositories, quiet = TRUE)
      }
    }
    records <- inspect()
    missing <- vapply(records, function(value) identical(value$status, "missing"), logical(1))
    if (identical(command, "install") && any(missing)) stop(paste("packages remain unavailable:", paste(packages[missing], collapse = ", ")), call. = FALSE)
    list(ok = TRUE, records = records, mutatedLibrary = mutated)
  }, error = function(error) list(ok = FALSE, records = inspect(), mutatedLibrary = mutated, error = conditionMessage(error)))
  writeLines(alder_private_json_encode(response), args[[2L]], useBytes = TRUE)
})
