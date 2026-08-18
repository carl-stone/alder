# Incremental Language Server Protocol client for the editor.
#
# The client is deliberately small: one languageserver process per notebook,
# full-document synchronization, and the request methods alder exposes.  It
# never evaluates notebook code and it is optional when the languageserver R
# package is not installed.

lsp_file_uri <- function(path) {
  path <- normalizePath(path, mustWork = FALSE)
  path <- gsub("\\\\", "/", path)
  paste0("file://", utils::URLencode(path, reserved = TRUE))
}

lsp_raw_index <- function(raw, needle) {
  n <- length(needle)
  if (!n || length(raw) < n) return(integer())
  limit <- length(raw) - n + 1L
  which(vapply(seq_len(limit), function(i) {
    identical(as.integer(raw[i:(i + n - 1L)]), as.integer(needle))
  }, logical(1)))
}

lsp_message_frame <- function(message) {
  json <- jsonlite::toJSON(message, auto_unbox = TRUE, null = "null",
                            force = TRUE)
  body <- charToRaw(enc2utf8(json))
  header <- charToRaw(paste0("Content-Length: ", length(body),
                             "\r\n\r\n"))
  c(header, body)
}

LspClient <- R6::R6Class(
  "alder_lsp_client",
  public = list(
    proc = NULL,
    path = NULL,
    uri = NULL,
    root_uri = NULL,
    buffer = NULL,
    pending = NULL,
    next_id = NULL,
    poll_active = NULL,
    closed = NULL,
    version = NULL,
    text = NULL,
    diagnostics = NULL,

    initialize = function(notebook, path = NULL, timeout = 5) {
      if (!requireNamespace("languageserver", quietly = TRUE)) {
        stop("the languageserver package is not installed", call. = FALSE)
      }
      self$path <- path %||% tempfile("alder-lsp-", fileext = ".R")
      self$path <- normalizePath(self$path, mustWork = FALSE)
      self$uri <- lsp_file_uri(self$path)
      self$root_uri <- lsp_file_uri(dirname(self$path))
      self$buffer <- raw()
      self$pending <- new.env(parent = emptyenv())
      self$next_id <- 1L
      self$poll_active <- FALSE
      self$closed <- FALSE
      self$version <- 1L
      self$text <- serialize_notebook(notebook)
      self$diagnostics <- list()

      self$proc <- processx::process$new(
        file.path(R.home("bin"), "Rscript"),
        c("--vanilla", "-e", "languageserver::run()"),
        stdin = "|", stdout = "|", stderr = "|", supervise = TRUE)
      ok <- FALSE
      on.exit(if (!ok) self$stop(), add = TRUE)
      result <- self$request("initialize", list(
        processId = as.integer(Sys.getpid()),
        rootUri = self$root_uri,
        capabilities = list(
          textDocument = list(
            completion = list(completionItem = list(snippetSupport = FALSE)),
            hover = list(contentFormat = c("markdown", "plaintext")),
            definition = list(), references = list(), documentSymbol = list(),
            signatureHelp = list()
          ),
          workspace = list()
        ),
        workspaceFolders = list(list(uri = self$root_uri, name = basename(dirname(self$path))))
      ), timeout = timeout)
      if (is.null(result)) stop("language server initialization returned no result",
                               call. = FALSE)
      self$notify("initialized", list())
      self$notify("textDocument/didOpen", list(
        textDocument = list(uri = self$uri, languageId = "r", version = self$version,
                            text = self$text)
      ))
      ok <- TRUE
      invisible(self)
    },

    alive = function() {
      !isTRUE(self$closed) && !is.null(self$proc) && self$proc$is_alive()
    },

    send = function(message) {
      if (!self$alive()) stop("language server is unavailable", call. = FALSE)
      self$proc$write_input(lsp_message_frame(message))
      invisible()
    },

    notify = function(method, params = list()) {
      self$send(list(jsonrpc = "2.0", method = method, params = params))
      invisible()
    },

    request = function(method, params = list(), timeout = 3) {
      if (!self$alive()) stop("language server is unavailable", call. = FALSE)
      id <- self$next_id
      self$next_id <- self$next_id + 1L
      entry <- new.env(parent = emptyenv())
      entry$done <- FALSE
      entry$result <- NULL
      entry$error <- NULL
      key <- as.character(id)
      self$pending[[key]] <- entry
      self$send(list(jsonrpc = "2.0", id = id, method = method,
                     params = params))
      self$ensure_polling()
      deadline <- Sys.time() + timeout
      while (!isTRUE(entry$done) && Sys.time() < deadline) {
        later::run_now(0.01)
        if (!isTRUE(entry$done)) Sys.sleep(0.005)
      }
      if (!isTRUE(entry$done)) {
        if (exists(key, envir = self$pending, inherits = FALSE)) {
          rm(list = key, envir = self$pending)
        }
        stop("language server request timed out: ", method, call. = FALSE)
      }
      if (!is.null(entry$error)) {
        stop("language server request failed: ", entry$error, call. = FALSE)
      }
      entry$result
    },

    ensure_polling = function() {
      if (isTRUE(self$poll_active)) return(invisible())
      self$poll_active <- TRUE
      self$poll_cycle()
      invisible()
    },

    poll_cycle = function() {
      if (!isTRUE(self$poll_active) || !self$alive()) {
        self$poll_active <- FALSE
        self$fail_pending("language server exited")
        return(invisible())
      }
      out <- self$proc$get_output_connection()
      err <- self$proc$get_error_connection()
      status <- processx::poll(list(out, err), 0L)
      if (status[[1L]] %in% c("ready", "silent")) {
        bytes <- tryCatch(self$proc$read_output_bytes(-1),
                          error = function(e) raw())
        if (length(bytes)) {
          self$buffer <- c(self$buffer, bytes)
          self$parse_buffer()
        }
      }
      if (status[[2L]] %in% c("ready", "silent")) {
        # Language-server diagnostics and protocol responses are stdout data;
        # stderr is intentionally drained so a warning cannot block the pipe.
        try(self$proc$read_error_bytes(-1), silent = TRUE)
      }
      waiting <- length(ls(self$pending, all.names = TRUE)) > 0L
      if (waiting && self$alive()) {
        later::later(self$poll_cycle, 0.03)
      } else {
        self$poll_active <- FALSE
      }
      invisible()
    },

    parse_buffer = function() {
      repeat {
        if (length(self$buffer) < 4L) return(invisible())
        crlf <- lsp_raw_index(self$buffer, charToRaw("\r\n\r\n"))
        lf <- lsp_raw_index(self$buffer, charToRaw("\n\n"))
        sep <- if (length(crlf)) crlf[[1L]] else if (length(lf)) lf[[1L]] else NA_integer_
        sep_len <- if (length(crlf)) 4L else 2L
        if (is.na(sep)) return(invisible())
        header <- rawToChar(self$buffer[seq_len(sep - 1L)])
        m <- regexec("(?im)^Content-Length\\s*:\\s*([0-9]+)\\s*$",
                     header, perl = TRUE)
        mm <- regmatches(header, m)[[1L]]
        if (length(mm) != 2L) {
          self$fail_pending("invalid language-server frame")
          return(invisible())
        }
        len <- suppressWarnings(as.numeric(mm[[2L]]))
        if (!is.finite(len) || len < 0 || len != floor(len)) {
          self$fail_pending("invalid language-server content length")
          return(invisible())
        }
        start <- sep + sep_len
        end <- start + as.integer(len) - 1L
        if (length(self$buffer) < end) return(invisible())
        body <- if (len) self$buffer[start:end] else raw()
        self$buffer <- if (end < length(self$buffer)) self$buffer[(end + 1L):length(self$buffer)] else raw()
        message <- tryCatch(
          jsonlite::fromJSON(rawToChar(body), simplifyVector = FALSE),
          error = function(e) NULL)
        if (!is.list(message)) {
          self$fail_pending("invalid language-server JSON")
          return(invisible())
        }
        self$handle_message(message)
      }
    },

    handle_message = function(message) {
      if (identical(message$method %||% NULL, "textDocument/publishDiagnostics")) {
        params <- message$params %||% list()
        uri <- params$uri %||% self$uri
        self$diagnostics[[uri]] <- params$diagnostics %||% list()
        return(invisible())
      }
      if (is.null(message$id)) return(invisible())
      key <- as.character(message$id)
      entry <- self$pending[[key]]
      if (is.null(entry)) return(invisible())
      if (!is.null(message$error)) {
        entry$error <- as.character(message$error$message %||% "unknown error")
      } else {
        entry$result <- message$result %||% NULL
      }
      entry$done <- TRUE
      rm(list = key, envir = self$pending)
      invisible()
    },

    fail_pending = function(message) {
      ids <- ls(self$pending, all.names = TRUE)
      for (id in ids) {
        entry <- self$pending[[id]]
        entry$error <- message
        entry$done <- TRUE
        rm(list = id, envir = self$pending)
      }
      invisible()
    },

    sync_document = function(notebook) {
      text <- serialize_notebook(notebook)
      if (identical(text, self$text)) return(invisible(FALSE))
      self$version <- self$version + 1L
      self$text <- text
      self$notify("textDocument/didChange", list(
        textDocument = list(uri = self$uri, version = self$version),
        contentChanges = list(list(text = text))
      ))
      invisible(TRUE)
    },

    request_document = function(method, params, notebook, timeout = 3) {
      self$sync_document(notebook)
      params <- params %||% list()
      params$textDocument <- c(params$textDocument %||% list(), uri = self$uri)
      if (!is.null(params$position) && !is.null(params$position$cell)) {
        pos <- nb_to_file_pos(
          notebook, params$position$cell,
          as.integer(params$position$line %||% 0L),
          as.integer(params$position$character %||% 0L))
        if (is.null(pos)) stop("position is outside a cell body", call. = FALSE)
        params$position <- list(line = pos$line, character = pos$character)
      }
      result <- self$request(method, params, timeout = timeout)
      lsp_translate_result(result, method, notebook, self$uri)
    },

    diagnostics_by_cell = function(notebook) {
      out <- list()
      rows <- self$diagnostics[[self$uri]] %||% list()
      for (diagnostic in rows) {
        if (!is.list(diagnostic) || is.null(diagnostic$range)) next
        start <- diagnostic$range$start %||% list()
        end <- diagnostic$range$end %||% start
        a <- nb_from_file_pos(notebook, as.integer(start$line %||% -1L))
        b <- nb_from_file_pos(notebook, as.integer(end$line %||% -1L))
        if (is.null(a) || is.null(b) || !identical(a$id, b$id)) next
        sev <- as.integer(diagnostic$severity %||% 3L)
        level <- if (sev == 1L) "error" else if (sev == 2L) "warning" else "info"
        item <- list(
          level = level, code = as.character(diagnostic$code %||% "lsp"),
          message = as.character(diagnostic$message %||% "language-server diagnostic"),
          symbol = NULL, source = "lsp",
          range = list(
            start = list(line = a$line, character = as.integer(start$character %||% 0L)),
            end = list(line = b$line, character = as.integer(end$character %||% 0L))
          )
        )
        out[[a$id]] <- c(out[[a$id]] %||% list(), list(item))
      }
      out
    },

    stop = function() {
      if (isTRUE(self$closed)) return(invisible())
      self$closed <- TRUE
      self$poll_active <- FALSE
      self$fail_pending("language server stopped")
      if (!is.null(self$proc) && self$proc$is_alive()) {
        try(self$proc$kill(), silent = TRUE)
      }
      invisible()
    }
  )
)

lsp_translate_position <- function(position, notebook) {
  if (!is.list(position)) return(NULL)
  mapped <- nb_from_file_pos(notebook, as.integer(position$line %||% -1L))
  if (is.null(mapped)) return(NULL)
  list(line = mapped$line, character = as.integer(position$character %||% 0L))
}

lsp_translate_range <- function(range, notebook) {
  if (!is.list(range)) return(NULL)
  start <- lsp_translate_position(range$start, notebook)
  end <- lsp_translate_position(range$end %||% range$start, notebook)
  if (is.null(start) || is.null(end)) return(NULL)
  start$cell <- nb_from_file_pos(notebook, as.integer(range$start$line %||% -1L))$id
  end$cell <- nb_from_file_pos(notebook, as.integer((range$end %||% range$start)$line %||% -1L))$id
  if (!identical(start$cell, end$cell)) return(NULL)
  list(start = start, end = end)
}

lsp_translate_location <- function(location, notebook, uri) {
  if (!is.list(location) || !identical(location$uri %||% uri, uri)) return(NULL)
  range <- lsp_translate_range(location$range, notebook)
  if (is.null(range)) return(NULL)
  location$range <- range
  location$uri <- uri
  location
}

lsp_translate_result <- function(result, method, notebook, uri) {
  if (is.null(result)) return(NULL)
  if (method %in% c("textDocument/definition", "textDocument/references")) {
    if (is.list(result) && !is.null(result$uri)) {
      return(lsp_translate_location(result, notebook, uri))
    }
    if (!is.list(result)) return(list())
    return(Filter(Negate(is.null), lapply(result,
      lsp_translate_location, notebook = notebook, uri = uri)))
  }
  if (identical(method, "textDocument/hover") && is.list(result) &&
      !is.null(result$range)) {
    result$range <- lsp_translate_range(result$range, notebook)
    if (is.null(result$range)) result$range <- NULL
    return(result)
  }
  if (identical(method, "textDocument/documentSymbol") && is.list(result)) {
    rows <- lapply(result, function(symbol) {
      if (!is.list(symbol)) return(NULL)
      symbol$range <- lsp_translate_range(symbol$range, notebook)
      if (!is.null(symbol$selectionRange)) {
        symbol$selectionRange <- lsp_translate_range(symbol$selectionRange, notebook)
      }
      if (is.null(symbol$range) || (!is.null(symbol$selectionRange) &&
          is.null(symbol$selectionRange))) return(NULL)
      symbol
    })
    return(Filter(Negate(is.null), rows))
  }
  if (identical(method, "textDocument/completion") && is.list(result)) {
    items <- result$items %||% result
    rows <- lapply(items, function(item) {
      if (!is.list(item)) return(NULL)
      if (!is.null(item$textEdit) && !is.null(item$textEdit$range)) {
        item$textEdit$range <- lsp_translate_range(item$textEdit$range, notebook)
        if (is.null(item$textEdit$range)) return(NULL)
      }
      item
    })
    if (!is.null(result$items)) result$items <- Filter(Negate(is.null), rows)
    else result <- Filter(Negate(is.null), rows)
  }
  result
}
