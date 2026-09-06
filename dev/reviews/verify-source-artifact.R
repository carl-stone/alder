#!/usr/bin/env Rscript

# Verify the contents of an R source package against the repository that
# produced it.  This intentionally uses only base R so it can run before the
# package is installed.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2L || length(args) > 3L) {
  cat("usage: Rscript dev/reviews/verify-source-artifact.R ARTIFACT REPO [OUTPUT_LOG]\n",
      file = stderr())
  quit(status = 2L)
}

artifact <- normalizePath(args[[1L]], mustWork = TRUE)
repo <- normalizePath(args[[2L]], mustWork = TRUE)
artifact_info <- file.info(artifact)
repo_info <- file.info(repo)
if (isTRUE(artifact_info$isdir) || !isTRUE(repo_info$isdir)) {
  cat("artifact must be a regular file and repo must be a directory\n",
      file = stderr())
  quit(status = 2L)
}

log_file <- if (length(args) == 3L) args[[3L]] else NULL
if (!is.null(log_file)) {
  parent <- dirname(normalizePath(log_file, mustWork = FALSE))
  if (!dir.exists(parent)) dir.create(parent, recursive = TRUE, showWarnings = FALSE)
  sink(log_file, split = TRUE)
  on.exit(sink(), add = TRUE)
}

failures <- character()
warnings_seen <- character()
fail <- function(label, detail = "") {
  failures <<- c(failures, label)
  cat("FAIL ", label, if (nzchar(detail)) paste0(" | ", detail) else "", "\n",
      sep = "")
}
pass <- function(label, detail = "") {
  cat("PASS ", label, if (nzchar(detail)) paste0(" | ", detail) else "", "\n",
      sep = "")
}
show_value <- function(label, value) {
  if (!length(value)) value <- "<none>"
  cat(label, "=", paste(value, collapse = ","), "\n", sep = "")
}

sha256 <- function(path) {
  result <- system2("sha256sum", c("--", path), stdout = TRUE, stderr = TRUE)
  status <- attr(result, "status") %||% 0L
  if (!identical(as.integer(status), 0L) || !length(result)) {
    stop("sha256sum failed for ", path, call. = FALSE)
  }
  sub("[[:space:]].*$", "", result[[1L]])
}

`%||%` <- function(x, y) if (is.null(x)) y else x
raw_equal <- function(left, right) {
  li <- file.info(left)
  ri <- file.info(right)
  if (isTRUE(li$isdir) || isTRUE(ri$isdir) ||
      nzchar(Sys.readlink(left)) || nzchar(Sys.readlink(right)) ||
      !identical(as.numeric(li$size), as.numeric(ri$size))) return(FALSE)
  identical(readBin(left, "raw", n = as.integer(li$size)),
            readBin(right, "raw", n = as.integer(ri$size)))
}

relative_files <- function(root) {
  paths <- list.files(root, recursive = TRUE, all.files = TRUE,
                      include.dirs = FALSE, no.. = TRUE)
  if (!length(paths)) return(character())
  paths <- paths[vapply(paths, function(path) {
    info <- file.info(file.path(root, path))
    !isTRUE(info$isdir) && !nzchar(Sys.readlink(file.path(root, path)))
  }, logical(1L))]
  sort(unique(gsub("\\\\", "/", paths, fixed = FALSE)))
}

description_semantics <- function(path) {
  fields <- read.dcf(path, all = TRUE)
  if (!nrow(fields)) return(setNames(character(), character()))
  value <- as.character(fields[1L, ])
  names(value) <- colnames(fields)
  # DCF continuation whitespace is presentation, not field semantics.
  value <- trimws(gsub("[[:space:]]+", " ", value, perl = TRUE))
  value
}

cat("ALDER_SOURCE_ARTIFACT_VERIFIER=1\n")
cat("ARTIFACT_PATH=", artifact, "\n", sep = "")
cat("REPOSITORY_PATH=", repo, "\n", sep = "")
cat("ARTIFACT_SHA256=", sha256(artifact), "\n", sep = "")
cat("ARTIFACT_SIZE_BYTES=", as.numeric(file.info(artifact)$size), "\n", sep = "")

archive_entries <- tryCatch(
  withCallingHandlers(utils::untar(artifact, list = TRUE), warning = function(w) {
    warnings_seen <<- c(warnings_seen, conditionMessage(w))
    invokeRestart("muffleWarning")
  }),
  error = function(e) {
    fail("archive-list", conditionMessage(e))
    character()
  }
)
archive_entries <- gsub("\\\\", "/", archive_entries, fixed = FALSE)
archive_entries <- sub("/$", "", archive_entries)
archive_entries <- archive_entries[nzchar(archive_entries)]
path_invalid <- archive_entries[
  grepl("^/", archive_entries) |
    grepl("(^|/)\\.\\.($|/)", archive_entries, perl = TRUE) |
    grepl("(^|/)\\.($|/)", archive_entries, perl = TRUE)
]
entry_roots <- unique(vapply(strsplit(archive_entries, "/", fixed = TRUE),
                             `[`, character(1L), 1L))
if (length(path_invalid)) fail("archive-path-safety", paste(path_invalid, collapse = ","))
if (length(entry_roots) != 1L || !identical(entry_roots, "alder")) {
  fail("single-alder-root", paste(entry_roots, collapse = ","))
} else {
  pass("single-alder-root", "alder")
}

extract_dir <- tempfile("alder-source-artifact-")
dir.create(extract_dir)
tryCatch(
  withCallingHandlers(utils::untar(artifact, exdir = extract_dir), warning = function(w) {
    warnings_seen <<- c(warnings_seen, conditionMessage(w))
    invokeRestart("muffleWarning")
  }),
  error = function(e) fail("archive-extract", conditionMessage(e))
)
packaged_root <- file.path(extract_dir, "alder")
if (!dir.exists(packaged_root)) {
  fail("extracted-alder-root", "missing extracted alder directory")
  packaged_root <- extract_dir
}

packaged <- relative_files(extract_dir)
packaged <- packaged[sub("^alder/", "", packaged) != packaged]
packaged <- sub("^alder/", "", packaged)
packaged <- sort(unique(packaged))
show_value("PACKAGE_ROOT", if (dir.exists(file.path(extract_dir, "alder"))) "alder" else "<missing>")
cat("PACKAGED_REGULAR_FILES=", length(packaged), "\n", sep = "")

# These are the package-facing repository files.  tests/AGENTS.md is the one
# package-facing-tree file intentionally excluded by .Rbuildignore.
repo_all <- relative_files(repo)
expected <- repo_all[
  repo_all %in% c("DESCRIPTION", "NAMESPACE", "README.md", "NEWS.md") |
    grepl("^(R|exec|inst|man|tests)/", repo_all)
]
expected <- expected[expected != "tests/AGENTS.md"]
expected <- sort(unique(expected))
cat("REPOSITORY_EXPECTED_FILES=", length(expected), "\n", sep = "")

missing <- setdiff(expected, packaged)
extra <- setdiff(packaged, expected)
if (length(missing)) fail("required-files-present", paste(missing, collapse = ",")) else pass("required-files-present")
if (length(extra)) fail("packaged-files-have-repository-source", paste(extra, collapse = ",")) else pass("packaged-files-have-repository-source")

internal_pattern <- paste0(
  "^(AGENTS[.]md|ALDER_TASK[.]md|TASK_STATE[.]md|SUBAGENTS[.]md|",
  "USER_FLOWS[.]md|NORTH_STAR_RUBRIC[.]md|VISION[.]md|LICENSE|",
  "[.]Rbuildignore|[.]gitignore|alder[.]Rproj|demo[.]R|",
  "dev/|[.]github/|[.]agents/|[.]codex/|js/|tests/AGENTS[.]md)"
)
debris_pattern <- paste0(
  "(^|/)(node_modules|[.]git|[.]Rcheck|[.]DS_Store)(/|$)|",
  "(^|/)[^/]+[.]tar[.]gz$|(^|/)[^/]+[.](o|so|dll|a)$|",
  "(^|/)[.]Rhistory$"
)
internal <- grep(internal_pattern, packaged, value = TRUE, perl = TRUE)
debris <- grep(debris_pattern, packaged, value = TRUE, perl = TRUE)
show_value("INTERNAL_OR_REVIEW_FILES", internal)
show_value("GENERATED_OR_DEBRIS_FILES", debris)
if (length(internal)) fail("internal-files-excluded", paste(internal, collapse = ",")) else pass("internal-files-excluded")
if (length(debris)) fail("generated-debris-excluded", paste(debris, collapse = ",")) else pass("generated-debris-excluded")

byte_candidates <- intersect(packaged, setdiff(expected, "DESCRIPTION"))
content_mismatch <- byte_candidates[
  !vapply(byte_candidates, function(rel) {
    raw_equal(file.path(packaged_root, rel), file.path(repo, rel))
  }, logical(1L))
]
cat("BYTE_CANDIDATE_FILES=", length(byte_candidates), "\n", sep = "")
cat("BYTE_IDENTICAL_FILES=", length(byte_candidates) - length(content_mismatch), "\n", sep = "")
show_value("BYTE_MISMATCH_FILES", content_mismatch)
if (length(content_mismatch)) fail("packaged-content-byte-identical", paste(content_mismatch, collapse = ",")) else pass("packaged-content-byte-identical")

description_ok <- TRUE
description_fields <- character()
tryCatch({
  source_desc <- description_semantics(file.path(repo, "DESCRIPTION"))
  artifact_desc <- description_semantics(file.path(packaged_root, "DESCRIPTION"))
  if (!length(source_desc) || !length(artifact_desc)) stop("DESCRIPTION is empty or invalid", call. = FALSE)
  description_fields <- union(names(source_desc), names(artifact_desc))
  missing_fields <- setdiff(names(source_desc), names(artifact_desc))
  added_fields <- setdiff(names(artifact_desc), names(source_desc))
  changed_fields <- intersect(names(source_desc), names(artifact_desc))[
    vapply(intersect(names(source_desc), names(artifact_desc)), function(name) {
      !identical(source_desc[[name]], artifact_desc[[name]])
    }, logical(1L))
  ]
  # R CMD build adds these derived metadata fields.  Packaged is intentionally
  # unconstrained (it contains the build timestamp); the other three must have
  # the standard generated shape/value for this source tree.
  build_fields <- c("Packaged", "NeedsCompilation", "Author", "Maintainer")
  unexpected_added <- setdiff(added_fields, build_fields)
  unexpected_changed <- setdiff(changed_fields, build_fields)
  expected_compile <- if (any(grepl("(^|/)src/[^/]+\\.(c|cc|cpp|cxx|f|f90|m)$",
                                    repo_all, ignore.case = TRUE))) "yes" else "no"
  if ("NeedsCompilation" %in% names(artifact_desc) &&
      !identical(artifact_desc[["NeedsCompilation"]], expected_compile)) {
    unexpected_changed <- c(unexpected_changed, "NeedsCompilation")
  }
  for (field in intersect(c("Author", "Maintainer"), names(artifact_desc))) {
    if (!nzchar(artifact_desc[[field]])) unexpected_changed <- c(unexpected_changed, field)
  }
  if (length(missing_fields) || length(unexpected_added) || length(unexpected_changed)) {
    description_ok <- FALSE
    detail <- paste(c(
      if (length(missing_fields)) paste0("missing=", paste(missing_fields, collapse = ",")),
      if (length(unexpected_added)) paste0("added=", paste(unexpected_added, collapse = ",")),
      if (length(unexpected_changed)) paste0("changed=", paste(unique(unexpected_changed), collapse = ","))
    ), collapse = ";")
    fail("DESCRIPTION-DCF-semantics", detail)
  } else {
    pass("DESCRIPTION-DCF-semantics",
         paste0("fields=", length(description_fields),
                ";build-added=", paste(intersect(added_fields, build_fields), collapse = ",")))
  }
} , error = function(e) {
  description_ok <<- FALSE
  fail("DESCRIPTION-DCF-semantics", conditionMessage(e))
})

show_value("DESCRIPTION_NORMALIZED_FIELDS", description_fields)
show_value("DESCRIPTION_BUILD_METADATA_ALLOWED", c("Packaged", "NeedsCompilation", "Author", "Maintainer"))
if (length(warnings_seen)) fail("verifier-warnings", paste(unique(warnings_seen), collapse = " | "))
if (!length(failures)) {
  cat("RESULT=PASS\n")
  quit(status = 0L)
}
show_value("FAILURES", unique(failures))
cat("RESULT=FAIL\n")
quit(status = 1L)
