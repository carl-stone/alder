# Shared binary framing for the TypeScript host adapters. This file is sourced
# into a private environment; it must not add bindings to the notebook globals.

MAX_FRAME_BYTES <- 128L * 1024L * 1024L
MAX_JSON_NESTING <- 64L
PROTOCOL <- "alder-engine-v1"

open_input <- function() processx::conn_create_fd(0L, close = FALSE)
open_output <- function() processx::conn_create_fd(1L, close = FALSE)

read_exact <- function(con, count) {
  value <- raw(count)
  offset <- 0L
  while (offset < count) {
    part <- processx::conn_read_bytes(con, count - offset)
    if (!length(part)) {
      if (offset == 0L) return(NULL)
      stop("protocol stream ended with a truncated frame", call. = FALSE)
    }
    size <- length(part)
    value[seq.int(offset + 1L, offset + size)] <- part
    offset <- offset + size
  }
  value
}

frame_length <- function(header) {
  if (length(header) != 4L) stop("invalid frame header", call. = FALSE)
  bytes <- as.numeric(as.integer(header))
  sum(bytes * c(16777216, 65536, 256, 1))
}

frame_header <- function(size) {
  if (!is.numeric(size) || length(size) != 1L || !is.finite(size) ||
      size != floor(size) || size < 1 || size > MAX_FRAME_BYTES) {
    stop("invalid frame length", call. = FALSE)
  }
  as.raw(c(
    floor(size / 16777216) %% 256,
    floor(size / 65536) %% 256,
    floor(size / 256) %% 256,
    size %% 256
  ))
}

check_json_text <- function(text) {
  # Strip complete JSON strings in PCRE before walking containers. Codec frames
  # are mostly large base64 strings; an R-level byte loop made their cost grow
  # with every source byte rather than with the small structural envelope.
  outside <- gsub(
    '"(?:\\\\["\\\\/bfnrt]|\\\\u[0-9A-Fa-f]{4}|[^"\\\\[:cntrl:]])*"',
    '""', text, perl = TRUE
  )
  positions <- gregexpr("[\\[\\]{}]", outside, perl = TRUE)
  tokens <- regmatches(outside, positions)[[1L]]
  stack <- character(MAX_JSON_NESTING)
  depth <- 0L
  for (token in tokens) {
    if (token %in% c("{", "[")) {
      depth <- depth + 1L
      if (depth > MAX_JSON_NESTING) {
        stop("JSON nesting limit exceeded", call. = FALSE)
      }
      stack[[depth]] <- if (identical(token, "{")) "}" else "]"
    } else {
      if (depth == 0L || !identical(stack[[depth]], token)) {
        stop("mismatched JSON container", call. = FALSE)
      }
      depth <- depth - 1L
    }
  }
  if (depth != 0L) stop("incomplete JSON value", call. = FALSE)
  invisible()
}

check_json_value <- function(value) {
  if (is.list(value)) {
    fields <- names(value)
    if (!is.null(fields) && anyDuplicated(fields)) {
      stop("duplicate JSON object key", call. = FALSE)
    }
    for (item in value) check_json_value(item)
  } else if (is.numeric(value) && any(!is.finite(value))) {
    stop("non-finite JSON number", call. = FALSE)
  }
  invisible()
}

read_frame <- function(con) {
  header <- read_exact(con, 4L)
  if (is.null(header)) return(NULL)
  length <- frame_length(header)
  if (!is.finite(length) || length < 1 || length > MAX_FRAME_BYTES) {
    stop(sprintf("frame length %.0f is outside 1..%d",
                 length, MAX_FRAME_BYTES), call. = FALSE)
  }
  bytes <- read_exact(con, as.integer(length))
  if (is.null(bytes)) stop("protocol stream ended with a truncated frame",
                           call. = FALSE)
  if (any(bytes == as.raw(0L))) stop("frame contains a NUL byte", call. = FALSE)
  text <- rawToChar(bytes)
  Encoding(text) <- "UTF-8"
  if (is.na(iconv(text, from = "UTF-8", to = "UTF-8", sub = NA_character_))) {
    stop("frame body is not valid UTF-8", call. = FALSE)
  }
  check_json_text(text)
  value <- tryCatch(
    jsonlite::fromJSON(text, simplifyVector = FALSE),
    error = function(error) stop("invalid JSON frame: ", conditionMessage(error),
                                 call. = FALSE)
  )
  check_json_value(value)
  value
}

write_frame <- function(con, value) {
  text <- jsonlite::toJSON(value, auto_unbox = TRUE, null = "null", na = "null",
                           force = TRUE)
  bytes <- charToRaw(enc2utf8(text))
  header <- frame_header(length(bytes))
  processx::conn_write(con, c(header, bytes))
  invisible()
}
