# Incremental Language Server Protocol client for the editor.
#
# The client is deliberately small: one languageserver process per notebook,
# full-document synchronization, and the request methods Alder exposes. It
# never evaluates notebook code. Because editor assistance is a product
# requirement, process startup and death are observable failures rather than a
# silently disabled optional feature.

lsp_file_uri <- function(path) {
  path <- normalizePath(path.expand(path), winslash = "/", mustWork = FALSE)
  absolute <- startsWith(path, "/") ||
    (.Platform$OS.type == "windows" && grepl("^[A-Za-z]:[/\\\\]", path))
  if (!absolute) path <- file.path(getwd(), path)
  lsp_encode_file_path(path)
}

lsp_encode_file_path <- function(path, windows = .Platform$OS.type == "windows") {
  if (windows) path <- gsub("\\", "/", path, fixed = TRUE)
  encoded <- utils::URLencode(enc2utf8(path), reserved = TRUE, repeated = TRUE)
  # Separators and a Windows drive colon belong to the URI path structure.
  # A literal percent escape in a filename must remain escaped after decoding.
  encoded <- gsub("%2F", "/", encoded, fixed = TRUE)
  if (windows) encoded <- sub("^([A-Za-z])%3A/", "\\1:/", encoded)
  # languageserver uses the five-slash UNC compatibility form on Windows
  # (RFC 8089 E.3.2); its parser does not accept an authority-form UNC URI.
  paste0(if (windows) "file:///" else "file://", encoded)
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
    diagnostics_enabled = NULL,
    on_failure = NULL,
    failure_reported = NULL,
    failure = NULL,
    stderr_text = NULL,
    stderr_limit = NULL,

    initialize = function(notebook, path = NULL, timeout = 30,
                          diagnostics = FALSE,
                          on_failure = NULL, stderr_limit = 16384L) {
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
      if (!is.logical(diagnostics) || length(diagnostics) != 1L ||
          is.na(diagnostics)) {
        stop("`diagnostics` must be TRUE or FALSE", call. = FALSE)
      }
      self$diagnostics_enabled <- isTRUE(diagnostics)
      self$on_failure <- on_failure
      self$failure_reported <- FALSE
      self$failure <- NULL
      self$stderr_text <- ""
      self$stderr_limit <- as.integer(stderr_limit)
      if (is.na(self$stderr_limit) || self$stderr_limit < 1024L) {
        self$stderr_limit <- 16384L
      }

      self$proc <- processx::process$new(
        file.path(R.home("bin"), "Rscript"),
        c("--vanilla", "-e", "languageserver::run()"),
        stdin = "|", stdout = "|", stderr = "|", supervise = TRUE,
        wd = dirname(self$path))
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
      # languageserver diagnostics are lintr diagnostics. Keep that background
      # task disabled unless the user explicitly opts in; completion, hover,
      # definitions, and signature help do not depend on it.
      self$notify("workspace/didChangeConfiguration", list(
        settings = list(diagnostics = self$diagnostics_enabled)
      ))
      self$notify("textDocument/didOpen", list(
        textDocument = list(uri = self$uri, languageId = "r", version = self$version,
                            text = self$text)
      ))
      # Continue polling while idle: publishDiagnostics notifications and
      # process death are asynchronous and must not depend on another request.
      self$ensure_polling()
      ok <- TRUE
      invisible(self)
    },

    alive = function() {
      !isTRUE(self$closed) && !is.null(self$proc) && self$proc$is_alive()
    },

    send = function(message) {
      if (!self$alive()) stop(self$failure_detail(
        "language server is unavailable"
      ), call. = FALSE)
      self$proc$write_input(lsp_message_frame(message))
      invisible()
    },

    notify = function(method, params = list()) {
      self$send(list(jsonrpc = "2.0", method = method, params = params))
      invisible()
    },

    request = function(method, params = list(), timeout = 3) {
      if (!self$alive()) stop(self$failure_detail(
        "language server is unavailable"
      ), call. = FALSE)
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
        stop(self$failure_detail(paste0(
          "language server request timed out: ", method
        )), call. = FALSE)
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
      if (!isTRUE(self$poll_active)) return(invisible())
      if (!self$alive()) {
        self$poll_active <- FALSE
        self$drain_stderr()
        message <- self$failure_detail("language server exited")
        self$fail_pending(message)
        self$report_failure(message)
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
        self$drain_stderr()
      }
      later::later(self$poll_cycle, 0.05)
      invisible()
    },

    drain_stderr = function() {
      if (is.null(self$proc)) return(invisible())
      bytes <- tryCatch(self$proc$read_error_bytes(-1), error = function(e) raw())
      if (!length(bytes)) return(invisible())
      chunk <- tryCatch(rawToChar(bytes), error = function(e) "")
      if (nzchar(chunk)) {
        self$stderr_text <- paste0(self$stderr_text, enc2utf8(chunk))
        n <- nchar(self$stderr_text, type = "bytes")
        if (n > self$stderr_limit) {
          self$stderr_text <- substr(
            self$stderr_text, n - self$stderr_limit + 1L, n
          )
        }
      }
      invisible()
    },

    failure_detail = function(prefix) {
      self$drain_stderr()
      status <- if (is.null(self$proc)) NULL else {
        tryCatch(self$proc$get_exit_status(), error = function(e) NULL)
      }
      suffix <- character()
      if (!is.null(status) && length(status) == 1L && !is.na(status)) {
        suffix <- c(suffix, paste0("exit status ", as.integer(status)))
      }
      stderr <- trimws(self$stderr_text %||% "")
      if (nzchar(stderr)) suffix <- c(suffix, paste0("stderr: ", stderr))
      if (!length(suffix)) as.character(prefix) else {
        paste0(prefix, " (", paste(suffix, collapse = "; "), ")")
      }
    },

    report_failure = function(message) {
      if (isTRUE(self$closed) || isTRUE(self$failure_reported)) {
        return(invisible())
      }
      self$failure <- as.character(message)
      self$failure_reported <- TRUE
      if (is.function(self$on_failure)) {
        tryCatch(
          self$on_failure(self$failure),
          error = function(error) cat(
            "[alder:lsp] failure callback failed: ",
            conditionMessage(error), "\n", sep = "", file = stderr()
          )
        )
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
          message <- "invalid language-server frame"
          self$fail_pending(message)
          self$report_failure(message)
          if (self$proc$is_alive()) self$proc$kill()
          return(invisible())
        }
        len <- suppressWarnings(as.numeric(mm[[2L]]))
        if (!is.finite(len) || len < 0 || len != floor(len)) {
          message <- "invalid language-server content length"
          self$fail_pending(message)
          self$report_failure(message)
          if (self$proc$is_alive()) self$proc$kill()
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
          detail <- "invalid language-server JSON"
          self$fail_pending(detail)
          self$report_failure(detail)
          if (self$proc$is_alive()) self$proc$kill()
          return(invisible())
        }
        self$handle_message(message)
      }
    },

    handle_message = function(message) {
      if (identical(message$method %||% NULL, "textDocument/publishDiagnostics")) {
        params <- message$params %||% list()
        uri <- params$uri %||% self$uri
        revision <- params$version
        if (identical(uri, self$uri) && !is.null(revision) &&
            (!is.numeric(revision) || length(revision) != 1L ||
             is.na(revision) || revision != self$version)) {
          return(invisible())
        }
        self$diagnostics[[uri]] <- if (isTRUE(self$diagnostics_enabled)) {
          params$diagnostics %||% list()
        } else {
          list()
        }
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
      self$diagnostics[[self$uri]] <- NULL
      self$notify("textDocument/didChange", list(
        textDocument = list(uri = self$uri, version = self$version),
        contentChanges = list(list(text = text))
      ))
      invisible(TRUE)
    },

    set_diagnostics = function(enabled) {
      if (!is.logical(enabled) || length(enabled) != 1L || is.na(enabled)) {
        stop("`enabled` must be TRUE or FALSE", call. = FALSE)
      }
      enabled <- isTRUE(enabled)
      changed <- !identical(self$diagnostics_enabled, enabled)
      self$diagnostics_enabled <- enabled
      if (!enabled) self$diagnostics <- list()
      if (!changed) return(invisible(FALSE))
      self$notify("workspace/didChangeConfiguration", list(
        settings = list(diagnostics = enabled)
      ))
      if (enabled) {
        # A configuration change alone does not schedule languageserver's
        # lint task. Resend the current document after this explicit opt-in.
        self$version <- self$version + 1L
        self$notify("textDocument/didChange", list(
          textDocument = list(uri = self$uri, version = self$version),
          contentChanges = list(list(text = self$text))
        ))
      }
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
        if (!is.list(diagnostic)) next
        range <- diagnostic$range
        if (!is.list(range)) range <- list()
        start <- range$start %||% list()
        end <- range$end %||% start
        a <- lsp_diagnostic_position(notebook, start)
        b <- lsp_diagnostic_position(notebook, end)
        sev <- as.integer(diagnostic$severity %||% 3L)
        level <- if (sev == 1L) "error" else if (sev == 2L) "warning" else "info"
        item <- list(
          level = level, code = as.character(diagnostic$code %||% "lsp"),
          message = as.character(diagnostic$message %||% "language-server diagnostic"),
          symbol = NULL, source = "lsp", range = NULL
        )
        if (!is.null(a) && !is.null(b) && identical(a$id, b$id)) {
          item$range <- list(
            start = list(line = a$line, character = a$character),
            end = list(line = b$line, character = b$character)
          )
          out[[a$id]] <- c(out[[a$id]] %||% list(), list(item))
        } else {
          # Linter failures commonly point to (0, 0), which can be a notebook
          # delimiter. Preserve these and cross-cell/file-level diagnostics
          # without inventing a cell location or turning them into DAG errors.
          item$file_range <- diagnostic$range
          out[[".document"]] <- c(out[[".document"]] %||% list(), list(item))
        }
      }
      out
    },

    stop = function() {
      if (isTRUE(self$closed)) return(invisible())
      self$closed <- TRUE
      self$poll_active <- FALSE
      self$fail_pending("language server stopped")
      if (!is.null(self$proc) && self$proc$is_alive()) {
        tryCatch({
          self$proc$kill()
          self$proc$wait(5000)
          if (self$proc$is_alive()) {
            self$proc$kill_tree()
            self$proc$wait(5000)
          }
          if (self$proc$is_alive()) {
            cat("[alder:lsp] language server did not exit after termination\n",
                file = stderr())
          }
        }, error = function(error) cat(
          "[alder:lsp] could not stop language server: ",
          conditionMessage(error), "\n", sep = "", file = stderr()
        ))
      }
      invisible()
    }
  )
)

lsp_diagnostic_position <- function(notebook, position) {
  if (!is.list(position)) return(NULL)
  coordinates <- list(position$line, position$character %||% 0L)
  valid <- vapply(coordinates, function(value) {
    is.numeric(value) && length(value) == 1L && !is.na(value) &&
      is.finite(value) && value >= 0 && value <= .Machine$integer.max &&
      value == trunc(value)
  }, logical(1L))
  if (!all(valid)) return(NULL)
  mapped <- nb_from_file_pos(notebook, as.integer(coordinates[[1L]]))
  if (is.null(mapped)) return(NULL)
  mapped$character <- as.integer(coordinates[[2L]])
  mapped
}

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
