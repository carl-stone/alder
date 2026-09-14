# Shared binary framing for the TypeScript host adapters. This file is sourced
# into a private environment; it must not add bindings to the notebook globals.
# It is the sole R-side strict JSON/framing boundary for every worker.

MAX_FRAME_BYTES <- 128L * 1024L * 1024L
MAX_JSON_NESTING <- 64L
PROTOCOL <- "alder-engine-v2"

open_input <- function() processx::conn_create_fd(0L, close = FALSE)
open_output <- function() processx::conn_create_fd(1L, close = FALSE)

read_exact <- function(con, count) {
  if (!is.numeric(count) || length(count) != 1L || !is.finite(count) ||
      count != floor(count) || count < 0 || count > MAX_FRAME_BYTES + 4L) {
    stop("invalid read size", call. = FALSE)
  }
  count <- as.integer(count)
  value <- raw(count)
  offset <- 0L
  while (offset < count) {
    part <- processx::conn_read_bytes(con, count - offset)
    if (!length(part)) {
      if (offset == 0L) return(NULL)
      stop("protocol stream ended with a truncated frame", call. = FALSE)
    }
    size <- length(part)
    if (size > count - offset) stop("protocol stream returned too many bytes", call. = FALSE)
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

# JSON strings are removed from structural scans by their exact lexical shape.
# jsonlite remains the syntax/value decoder; these scans add the strict checks
# it deliberately does not provide (duplicate decoded keys and surrogates).
.JSON_STRING_PATTERN <- '"(?:\\\\["\\\\/bfnrt]|\\\\u[0-9A-Fa-f]{4}|[^"\\\\[:cntrl:]])*"'
.JSON_KEY_PATTERN <- paste0(.JSON_STRING_PATTERN, "(?=[[:space:]]*:)")

.json_match_table <- function(pattern, text) {
  starts <- gregexpr(pattern, text, perl = TRUE)[[1L]]
  if (length(starts) == 1L && starts[[1L]] == -1L) {
    return(list(start = integer(), length = integer()))
  }
  list(start = as.integer(starts),
       length = as.integer(attr(starts, "match.length")))
}

.json_escape_is_active <- function(text, position) {
  # A backslash is an escape introducer only after an even run of backslashes.
  if (position <= 1L) return(TRUE)
  index <- position - 1L
  count <- 0L
  while (index >= 1L && identical(substr(text, index, index), "\\")) {
    count <- count + 1L
    index <- index - 1L
  }
  count %% 2L == 0L
}

.json_validate_surrogates <- function(text, start, token_length) {
  token <- substring(text, start, start + token_length - 1L)
  units <- .json_match_table("\\\\u[0-9A-Fa-f]{4}", token)
  if (!length(units$start)) return(invisible())
  active <- vapply(units$start, function(position)
    .json_escape_is_active(token, position), logical(1))
  positions <- units$start[active]
  lengths <- units$length[active]
  values <- vapply(seq_along(positions), function(index)
    strtoi(substring(token, positions[[index]] + 2L,
                    positions[[index]] + 5L), base = 16L), integer(1))
  index <- 1L
  while (index <= length(values)) {
    value <- values[[index]]
    if (value == 0L) stop("JSON string contains NUL", call. = FALSE)
    if (value >= 0xD800L && value <= 0xDBFFL) {
      paired <- index < length(values) &&
        values[[index + 1L]] >= 0xDC00L && values[[index + 1L]] <= 0xDFFFL &&
        positions[[index + 1L]] == positions[[index]] + lengths[[index]]
      if (!paired) stop("unpaired JSON surrogate", call. = FALSE)
      index <- index + 2L
    } else if (value >= 0xDC00L && value <= 0xDFFFL) {
      stop("unpaired JSON surrogate", call. = FALSE)
    } else {
      index <- index + 1L
    }
  }
  invisible()
}

.json_structural_tokens <- function(text, strings) {
  tokens <- gregexpr("[\\[\\]{}]", text, perl = TRUE)[[1L]]
  if (length(tokens) == 1L && tokens[[1L]] == -1L) return(integer())
  tokens <- as.integer(tokens)
  if (!length(strings$start)) return(tokens)
  which_string <- findInterval(tokens, strings$start)
  positive <- which(which_string > 0L)
  inside <- rep(FALSE, length(tokens))
  if (length(positive)) {
    inside[positive] <- tokens[positive] <
      strings$start[which_string[positive]] + strings$length[which_string[positive]]
  }
  tokens[!inside]
}

.json_key_tokens <- function(strings, keys) {
  if (!length(keys$start) || !length(strings$start)) {
    return(list(start = integer(), length = integer()))
  }
  index <- match(keys$start, strings$start)
  keep <- !is.na(index) & keys$start == strings$start[index]
  list(start = keys$start[keep], length = keys$length[keep])
}

.json_duplicate_keys <- function(text, strings, keys, structural) {
  if (!length(structural) && !length(keys$start)) return(invisible())
  events <- sort(unique(c(structural, keys$start)))
  key_lengths <- keys$length
  names(key_lengths) <- as.character(keys$start)
  stack <- list()
  for (position in events) {
    token <- substr(text, position, position)
    if (token %in% c("{", "[")) {
      stack[[length(stack) + 1L]] <- list(
        kind = token,
        keys = if (identical(token, "{")) new.env(parent = emptyenv()) else NULL
      )
    } else if (token %in% c("}", "]")) {
      if (!length(stack)) stop("mismatched JSON container", call. = FALSE)
      expected <- if (identical(stack[[length(stack)]]$kind, "{")) "}" else "]"
      if (!identical(token, expected)) stop("mismatched JSON container", call. = FALSE)
      stack <- stack[-length(stack)]
    } else if (token == '"') {
      if (!length(stack) || !identical(stack[[length(stack)]]$kind, "{")) next
      key_length <- unname(key_lengths[[as.character(position)]])
      if (is.null(key_length) || is.na(key_length)) next
      raw_key <- substring(text, position, position + key_length - 1L)
      decoded <- tryCatch(jsonlite::fromJSON(paste0("[", raw_key, "]"),
                                              simplifyVector = FALSE),
                          error = function(error) NULL)
      key <- if ((is.list(decoded) || is.character(decoded)) &&
                 length(decoded) == 1L) decoded[[1L]] else NULL
      if (!is.character(key) || length(key) != 1L || is.na(key) ||
          !validUTF8(key)) stop("invalid JSON object key", call. = FALSE)
      key_environment <- stack[[length(stack)]]$keys
      if (exists(key, envir = key_environment, inherits = FALSE)) {
        stop("duplicate JSON object key", call. = FALSE)
      }
      assign(key, TRUE, envir = key_environment)
    }
  }
  if (length(stack)) stop("incomplete JSON value", call. = FALSE)
  invisible()
}

check_json_text <- function(text) {
  if (!is.character(text) || length(text) != 1L || is.na(text) ||
      !validUTF8(text)) stop("JSON text is not valid UTF-8", call. = FALSE)
  codepoints <- utf8ToInt(text)
  if (any(codepoints < 32L & !(codepoints %in% c(9L, 10L, 13L)))) {
    stop("JSON text contains an invalid control character", call. = FALSE)
  }
  if (.json_has_nul(text)) stop("JSON text contains NUL", call. = FALSE)
  strings <- .json_match_table(.JSON_STRING_PATTERN, text)
  if (length(strings$start)) {
    for (index in seq_along(strings$start)) {
      .json_validate_surrogates(text, strings$start[[index]], strings$length[[index]])
    }
  }
  keys <- .json_key_tokens(strings, .json_match_table(.JSON_KEY_PATTERN, text))
  structural <- .json_structural_tokens(text, strings)
  depth <- 0L
  stack <- character()
  for (token_position in structural) {
    token <- substr(text, token_position, token_position)
    if (token %in% c("{", "[")) {
      depth <- depth + 1L
      if (depth > MAX_JSON_NESTING) stop("JSON nesting limit exceeded", call. = FALSE)
      stack[[depth]] <- if (identical(token, "{")) "}" else "]"
    } else {
      if (depth == 0L || !identical(stack[[depth]], token)) {
        stop("mismatched JSON container", call. = FALSE)
      }
      depth <- depth - 1L
    }
  }
  if (depth != 0L) stop("incomplete JSON value", call. = FALSE)
  .json_duplicate_keys(text, strings, keys, structural)
  invisible()
}

.json_has_nul <- function(value) {
  any(vapply(value, function(item) any(utf8ToInt(item) == 0L), logical(1)))
}

check_json_value <- function(value) {
  if (is.null(value)) return(invisible())
  if (is.list(value)) {
    fields <- names(value)
    if (!is.null(fields)) {
      if (anyNA(fields) || anyDuplicated(fields)) {
        stop("duplicate JSON object key", call. = FALSE)
      }
      if (any(!validUTF8(fields)) || .json_has_nul(fields)) {
        stop("JSON object key contains invalid text", call. = FALSE)
      }
    }
    for (item in value) check_json_value(item)
  } else if (is.character(value)) {
    if (anyNA(value) || any(!validUTF8(value)) || .json_has_nul(value)) {
      stop("JSON string contains invalid text", call. = FALSE)
    }
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
    stop(sprintf("frame length %.0f is outside 1..%d", length, MAX_FRAME_BYTES),
         call. = FALSE)
  }
  bytes <- read_exact(con, as.integer(length))
  if (is.null(bytes)) stop("protocol stream ended with a truncated frame", call. = FALSE)
  if (any(bytes == as.raw(0L))) stop("frame contains a NUL byte", call. = FALSE)
  text <- rawToChar(bytes)
  Encoding(text) <- "UTF-8"
  if (!validUTF8(text)) stop("frame body is not valid UTF-8", call. = FALSE)
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
  check_json_value(value)
  text <- tryCatch(
    jsonlite::toJSON(value, auto_unbox = TRUE, null = "null", na = "null", force = TRUE),
    error = function(error) stop("invalid JSON response: ", conditionMessage(error),
                                 call. = FALSE)
  )
  if (!is.character(text) || length(text) != 1L || !validUTF8(text)) {
    stop("invalid JSON response text", call. = FALSE)
  }
  bytes <- charToRaw(enc2utf8(text))
  if (!length(bytes) || length(bytes) > MAX_FRAME_BYTES || any(bytes == as.raw(0L))) {
    stop("JSON response exceeds the frame limit", call. = FALSE)
  }
  header <- frame_header(length(bytes))
  processx::conn_write(con, c(header, bytes))
  invisible()
}
