# Narrow R helpers shared by the Ark and isolated analyzer workers.
# Application document/configuration services do not belong in this module.

ALDER_HOST_MAX_CELLS <- 10000L
ALDER_HOST_MAX_SOURCE_BYTES <- 32L * 1024L * 1024L

.alder_runtime_valid_text <- function(value, allow_empty = FALSE,
                                       max_bytes = ALDER_HOST_MAX_SOURCE_BYTES) {
  is.character(value) && length(value) == 1L && !is.na(value) &&
    (allow_empty || nzchar(value)) && validUTF8(value) &&
    nchar(value, type = "bytes") <= max_bytes
}
.alder_runtime_has_control <- function(value) {
  codepoints <- utf8ToInt(value)
  any(codepoints <= 31L | codepoints == 127L)
}
.alder_runtime_has_nul <- function(value) {
  any(utf8ToInt(value) == 0L)
}

.alder_runtime_safe_identity <- function(value, label,
                                         max_bytes = 256L) {
  if (!.alder_runtime_valid_text(value, max_bytes = max_bytes) ||
      .alder_runtime_has_control(value)) {
    stop(label, " must be a bounded UTF-8 identifier without controls",
         call. = FALSE)
  }
  value
}

.alder_runtime_absolute_directory <- function(path, label = "library path") {
  if (!is.character(path) || length(path) != 1L || is.na(path) ||
      !nzchar(path) || !validUTF8(path) ||
      .alder_runtime_has_control(path)) {
    stop(label, " must be a non-empty absolute directory", call. = FALSE)
  }
  absolute <- if (.Platform$OS.type == "windows") {
    (nchar(path, type = "bytes") >= 3L && grepl("^[A-Za-z]:", path) &&
      utf8ToInt(substr(path, 3L, 3L)) %in% c(47L, 92L)) ||
      startsWith(path, "//") || startsWith(path, intToUtf8(c(92L, 92L)))
  } else {
    startsWith(path, "/")
  }
  if (!absolute) stop(label, " must be absolute", call. = FALSE)
  resolved <- tryCatch(normalizePath(path, mustWork = TRUE, winslash = "/"),
                       error = function(error) NULL)
  if (is.null(resolved) || !dir.exists(resolved) ||
      file.access(resolved, 4L) != 0L) {
    stop(label, " must be an existing readable directory", call. = FALSE)
  }
  resolved
}

# The host owns library selection. R only validates the complete ordered list
# and applies it without adding site/user defaults or interpreting path syntax.
alder_apply_library_paths <- function(paths) {
  if (!is.character(paths) || !length(paths) || anyNA(paths) ||
      any(!nzchar(paths))) {
    stop("library paths must be a non-empty character array", call. = FALSE)
  }
  resolved <- vapply(paths, .alder_runtime_absolute_directory, "",
                     label = "library path")
  if (anyDuplicated(resolved)) {
    stop("library paths must be unique", call. = FALSE)
  }
  if ("include.site" %in% names(formals(base::.libPaths))) {
    base::.libPaths(unname(resolved), include.site = FALSE)
  } else {
    assign(".lib.loc", unique(unname(resolved)),
           envir = environment(base::.libPaths))
  }
  invisible(unname(resolved))
}

alder_host_decode_encoded_source <- function(encoded, error_message) {
  invalid <- function() stop(error_message, call. = FALSE)
  if (!is.character(encoded) || length(encoded) != 1L || is.na(encoded) ||
      nchar(encoded, type = "bytes") > ceiling(ALDER_HOST_MAX_SOURCE_BYTES / 3) * 4L ||
      !validUTF8(encoded)) invalid()
  bytes <- tryCatch(suppressWarnings(base64enc::base64decode(encoded)),
                    error = function(error) NULL)
  canonical <- if (is.null(bytes)) NULL else if (!length(bytes)) "" else
    base64enc::base64encode(bytes)
  if (is.null(bytes) || !identical(canonical, encoded) ||
      length(bytes) > ALDER_HOST_MAX_SOURCE_BYTES || any(bytes == as.raw(0L))) {
    invalid()
  }
  source <- rawToChar(bytes)
  if (!validUTF8(source)) invalid()
  Encoding(source) <- "UTF-8"
  source
}

alder_host_decode_source <- function(value, encoded_field, plain_field,
                                     label = "source") {
  if (!is.list(value)) {
    stop("invalid ", label, " encoding", call. = FALSE)
  }
  encoded <- value[[encoded_field]]
  plain <- value[[plain_field]]
  if (is.null(encoded)) {
    if (!.alder_runtime_valid_text(plain, allow_empty = TRUE) ||
        .alder_runtime_has_nul(plain)) {
      stop("invalid ", label, " encoding", call. = FALSE)
    }
    return(plain)
  }
  if (!is.null(plain)) stop("invalid ", label, " encoding", call. = FALSE)
  alder_host_decode_encoded_source(
    encoded, paste0("invalid ", label, " encoding"))
}
