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
