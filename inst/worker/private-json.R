# Private transport primitives for the Ark adapter. These deliberately use only
# base R so the kernel does not load the application's jsonlite or base64enc
# namespaces ahead of notebook code.

.alder_b64_alphabet <- strsplit(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "",
  fixed = TRUE
)[[1L]]

alder_private_base64_encode <- function(value) {
  bytes <- as.integer(value)
  if (!length(bytes)) return("")
  groups <- ceiling(length(bytes) / 3L)
  padded <- c(bytes, rep.int(0L, groups * 3L - length(bytes)))
  indices <- rbind(
    padded[seq.int(1L, length(padded), by = 3L)] %/% 4L,
    (padded[seq.int(1L, length(padded), by = 3L)] %% 4L) * 16L +
      padded[seq.int(2L, length(padded), by = 3L)] %/% 16L,
    (padded[seq.int(2L, length(padded), by = 3L)] %% 16L) * 4L +
      padded[seq.int(3L, length(padded), by = 3L)] %/% 64L,
    padded[seq.int(3L, length(padded), by = 3L)] %% 64L
  )
  encoded <- .alder_b64_alphabet[as.integer(indices) + 1L]
  remainder <- length(bytes) %% 3L
  if (remainder == 1L) encoded[(length(encoded) - 1L):length(encoded)] <- "="
  if (remainder == 2L) encoded[length(encoded)] <- "="
  paste0(encoded, collapse = "")
}

alder_private_base64_decode <- function(value) {
  invalid <- function() stop("invalid base64 encoding", call. = FALSE)
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !validUTF8(value)) invalid()
  if (!nzchar(value)) return(raw())
  chars <- strsplit(value, "", fixed = TRUE)[[1L]]
  if (length(chars) %% 4L != 0L) invalid()
  padding <- if (length(chars) >= 2L && identical(chars[length(chars) - 1L], "=")) {
    2L
  } else if (identical(chars[length(chars)], "=")) {
    1L
  } else {
    0L
  }
  if (any(chars[seq_len(length(chars) - padding)] == "=") ||
      (padding && any(chars[(length(chars) - padding + 1L):length(chars)] != "="))) {
    invalid()
  }
  values <- match(chars, .alder_b64_alphabet) - 1L
  values[is.na(values)] <- 0L
  quartets <- matrix(values, nrow = 4L)
  bytes <- as.integer(rbind(
    quartets[1L, ] * 4L + quartets[2L, ] %/% 16L,
    (quartets[2L, ] %% 16L) * 16L + quartets[3L, ] %/% 4L,
    (quartets[3L, ] %% 4L) * 64L + quartets[4L, ]
  ))
  if (padding) bytes <- bytes[seq_len(length(bytes) - padding)]
  decoded <- as.raw(bytes)
  if (!identical(alder_private_base64_encode(decoded), value)) invalid()
  decoded
}

.alder_json_escape <- function(value) {
  chars <- strsplit(enc2utf8(value), "", fixed = TRUE)[[1L]]
  if (!length(chars)) return("\"\"")
  escaped <- vapply(chars, function(char) {
    if (identical(char, "\\")) return("\\\\")
    if (identical(char, "\"")) return("\\\"")
    if (identical(char, "\b")) return("\\b")
    if (identical(char, "\f")) return("\\f")
    if (identical(char, "\n")) return("\\n")
    if (identical(char, "\r")) return("\\r")
    if (identical(char, "\t")) return("\\t")
    code <- utf8ToInt(char)
    if (length(code) == 1L && code < 32L) sprintf("\\u%04x", code) else char
  }, character(1L), USE.NAMES = FALSE)
  paste0("\"", paste0(escaped, collapse = ""), "\"")
}

alder_private_json_encode <- function(value) {
  encode <- function(item) {
    if (is.null(item)) return("null")
    if (inherits(item, "AsIs")) {
      item <- unclass(item)
      if (!length(item)) return("[]")
    }
    if (is.list(item)) {
      item_names <- names(item)
      if (!is.null(item_names)) {
        fields <- vapply(seq_along(item), function(index) {
          paste0(.alder_json_escape(item_names[[index]]), ":", encode(item[[index]]))
        }, character(1L), USE.NAMES = FALSE)
        return(paste0("{", paste0(fields, collapse = ","), "}"))
      }
      fields <- vapply(item, encode, character(1L), USE.NAMES = FALSE)
      return(paste0("[", paste0(fields, collapse = ","), "]"))
    }
    if (length(item) != 1L) {
      fields <- vapply(as.list(item), encode, character(1L), USE.NAMES = FALSE)
      return(paste0("[", paste0(fields, collapse = ","), "]"))
    }
    if (is.na(item)) return("null")
    if (is.character(item)) return(.alder_json_escape(item))
    if (is.logical(item)) return(if (item) "true" else "false")
    if (is.integer(item)) return(as.character(item))
    if (is.numeric(item)) {
      if (!is.finite(item)) return("null")
      return(trimws(formatC(item, digits = 17L, format = "g", decimal.mark = ".")))
    }
    stop("unsupported private JSON value", call. = FALSE)
  }
  encode(value)
}
