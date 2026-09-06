alder_cli_help <- function() {
  paste(
    "Usage: alder [edit] [options] NOTEBOOK.R",
    "       alder render NOTEBOOK.R --engine quarto|pandoc [render options]",
    "",
    "Start an Alder editor, server, and R worker without an interactive R session.",
    "If NOTEBOOK.R does not exist, it is created only when you first Save.",
    "",
    "Options:",
    "  --host HOST              Loopback bind only: 127.0.0.1, localhost, or ::1",
    "  --port PORT              Bind port (default: 8899)",
    "  --allowed-origin ORIGIN  Trusted browser origin; repeatable",
    "  --lazy                   Use lazy reactive execution",
    "  --no-run                 Do not run cells at startup",
    "  --sandbox                Use the notebook's isolated project library",
    "  --idle-timeout SECONDS   Save, then stop after browser polling ends",
    "                           (default: 30; 0 disables)",
    "  --no-idle-timeout        Disable browser-idle shutdown",
    "  --no-open                Do not open the default browser",
    "Render options:",
    "  --engine ENGINE          Required: quarto or pandoc",
    "  --output FILE            Write to an explicit output file",
    "  --no-code                Omit notebook source from the report",
    "  -h, --help               Show this help",
    "  --version                Show the installed Alder version",
    sep = "\n"
  )
}

alder_cli_error <- function(message) {
  structure(list(message = message, call = NULL),
            class = c("alder_cli_error", "error", "condition"))
}

alder_cli_value <- function(args, index, option) {
  if (index >= length(args)) {
    stop(alder_cli_error(paste0(option, " requires a value")))
  }
  args[[index + 1L]]
}

alder_cli_number <- function(value, option, integer = FALSE,
                             minimum = 0, maximum = Inf) {
  pattern <- if (integer) "^[0-9]+$" else "^[0-9]+([.][0-9]+)?$"
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !grepl(pattern, value)) {
    stop(alder_cli_error(paste0(option, " requires a numeric value")))
  }
  number <- suppressWarnings(as.numeric(value))
  if (!is.finite(number) || number < minimum || number > maximum ||
      (integer && number != floor(number))) {
    stop(alder_cli_error(paste0(option, " is outside its valid range")))
  }
  if (integer) as.integer(number) else number
}

alder_cli_parse <- function(args) {
  if (!is.character(args) || anyNA(args)) {
    stop(alder_cli_error("arguments must be non-missing strings"))
  }
  options <- list(
    host = "127.0.0.1", port = 8899L, allowed_origins = character(),
    execution_mode = NULL, run_on_startup = NULL, sandbox = FALSE,
    idle_timeout = 30, open = TRUE, help = FALSE, version = FALSE,
    path = NULL, command = "edit", engine = NULL, output = NULL,
    include_code = TRUE, new_notebook = FALSE
  )
  positional <- character()
  launch_options <- character()
  literal <- FALSE
  i <- 1L
  while (i <= length(args)) {
    arg <- args[[i]]
    if (!literal && identical(arg, "--")) {
      literal <- TRUE
    } else if (!literal && arg %in% c("-h", "--help")) {
      options$help <- TRUE
    } else if (!literal && identical(arg, "--version")) {
      options$version <- TRUE
    } else if (!literal && identical(arg, "--no-open")) {
      options$open <- FALSE
      launch_options <- c(launch_options, arg)
    } else if (!literal && identical(arg, "--lazy")) {
      options$execution_mode <- "lazy"
      launch_options <- c(launch_options, arg)
    } else if (!literal && identical(arg, "--no-run")) {
      options$run_on_startup <- FALSE
      launch_options <- c(launch_options, arg)
    } else if (!literal && identical(arg, "--sandbox")) {
      options$sandbox <- TRUE
      launch_options <- c(launch_options, arg)
    } else if (!literal && identical(arg, "--no-idle-timeout")) {
      options$idle_timeout <- 0
      launch_options <- c(launch_options, arg)
    } else if (!literal && startsWith(arg, "--engine=")) {
      options$engine <- sub("^--engine=", "", arg)
    } else if (!literal && identical(arg, "--engine")) {
      options$engine <- alder_cli_value(args, i, arg)
      i <- i + 1L
    } else if (!literal && startsWith(arg, "--output=")) {
      options$output <- sub("^--output=", "", arg)
    } else if (!literal && identical(arg, "--output")) {
      options$output <- alder_cli_value(args, i, arg)
      i <- i + 1L
    } else if (!literal && identical(arg, "--no-code")) {
      options$include_code <- FALSE
    } else if (!literal && startsWith(arg, "--host=")) {
      options$host <- sub("^--host=", "", arg)
      launch_options <- c(launch_options, "--host")
    } else if (!literal && identical(arg, "--host")) {
      options$host <- alder_cli_value(args, i, arg)
      launch_options <- c(launch_options, arg)
      i <- i + 1L
    } else if (!literal && startsWith(arg, "--port=")) {
      options$port <- alder_cli_number(sub("^--port=", "", arg),
                                       "--port", TRUE, 1, 65535)
      launch_options <- c(launch_options, "--port")
    } else if (!literal && identical(arg, "--port")) {
      options$port <- alder_cli_number(alder_cli_value(args, i, arg),
                                       arg, TRUE, 1, 65535)
      launch_options <- c(launch_options, arg)
      i <- i + 1L
    } else if (!literal && startsWith(arg, "--idle-timeout=")) {
      options$idle_timeout <- alder_cli_number(
        sub("^--idle-timeout=", "", arg), "--idle-timeout")
      launch_options <- c(launch_options, "--idle-timeout")
    } else if (!literal && identical(arg, "--idle-timeout")) {
      options$idle_timeout <- alder_cli_number(alder_cli_value(args, i, arg),
                                               arg)
      launch_options <- c(launch_options, arg)
      i <- i + 1L
    } else if (!literal && startsWith(arg, "--allowed-origin=")) {
      options$allowed_origins <- c(
        options$allowed_origins, sub("^--allowed-origin=", "", arg))
      launch_options <- c(launch_options, "--allowed-origin")
    } else if (!literal && identical(arg, "--allowed-origin")) {
      options$allowed_origins <- c(options$allowed_origins,
        alder_cli_value(args, i, arg))
      launch_options <- c(launch_options, arg)
      i <- i + 1L
    } else if (!literal && startsWith(arg, "-")) {
      stop(alder_cli_error(paste0("unknown option: ", arg)))
    } else {
      positional <- c(positional, arg)
    }
    i <- i + 1L
  }

  if (isTRUE(options$help) || isTRUE(options$version)) return(options)
  if (length(positional) && positional[[1L]] %in% c("edit", "render")) {
    options$command <- positional[[1L]]
    positional <- positional[-1L]
  }
  if (length(positional) != 1L || !nzchar(positional[[1L]])) {
    stop(alder_cli_error("exactly one NOTEBOOK.R path is required"))
  }
  path <- positional[[1L]]
  if (!isTRUE(validUTF8(path)) || any(charToRaw(path) == as.raw(0))) {
    stop(alder_cli_error("notebook path is not valid UTF-8"))
  }
  if (!identical(tolower(tools::file_ext(path)), "r")) {
    stop(alder_cli_error("notebook path must end in .R"))
  }
  if (dir.exists(path)) {
    stop(alder_cli_error("notebook path must be a file, not a directory"))
  }
  if (!file.exists(path) && !dir.exists(dirname(path))) {
    stop(alder_cli_error("parent directory of notebook path does not exist"))
  }
  if (identical(options$command, "render")) {
    if (length(launch_options)) {
      stop(alder_cli_error(paste0(launch_options[[1L]],
                                  " is not valid for `alder render`")))
    }
    if (is.null(options$engine) ||
        !(options$engine %in% c("quarto", "pandoc"))) {
      stop(alder_cli_error(
        "`alder render` requires --engine quarto or --engine pandoc"))
    }
    if (!is.null(options$output) && !nzchar(options$output)) {
      stop(alder_cli_error("--output requires a nonempty file path"))
    }
    if (!file.exists(path)) {
      stop(alder_cli_error("render notebook file does not exist"))
    }
    options$path <- path
    return(options)
  }
  if (!is.null(options$engine) || !is.null(options$output) ||
      !isTRUE(options$include_code)) {
    stop(alder_cli_error("render options require the `render` subcommand"))
  }
  if (!is.character(options$host) || length(options$host) != 1L ||
      is.na(options$host) || !nzchar(options$host)) {
    stop(alder_cli_error("--host requires a nonempty value"))
  }
  if (!(options$host %in% c("127.0.0.1", "localhost", "::1"))) {
    stop(alder_cli_error(paste0(
      "--host must be exactly 127.0.0.1, localhost, or ::1; ",
      "non-loopback binds are not supported")))
  }
  options$new_notebook <- !file.exists(path)
  options$allowed_origins <- if (length(options$allowed_origins)) {
    options$allowed_origins
  } else {
    NULL
  }
  options$path <- path
  options
}

#' Run the Alder command-line interface
#'
#' Parse command-line arguments, start the editor/server/worker lifecycle, and
#' pump the event loop until a signal, authenticated shutdown request, or
#' configured browser-idle timeout safely saves dirty notebooks and stops it.
#' The editor server binds only to an exact loopback host:
#' \code{127.0.0.1}, \code{localhost}, or \code{::1}.
#' A failed or conflicting idle save pauses shutdown and remains visible. The
#' edit command accepts a nonexistent \code{.R} path, announces a new notebook,
#' and creates the file only on its first successful Save. The
#' bounded \code{render}
#' subcommand delegates to \code{alder_render()} with an explicit Quarto or
#' Pandoc engine. This function is normally called by the packaged
#' \code{alder} executable installed by
#' \code{alder_install_cli()}.
#' If SIGINT arrives while httpuv is processing a request, the request
#' receives a structured \code{session_stopped} HTTP 410 response, teardown is
#' deferred until the callback unwinds, and the CLI exits with status 130
#' rather than returning a generic HTTP 500 response.
#'
#' @param args Character command-line arguments.
#' @return An integer process exit status: 0 for success, 2 for command-line
#'   usage errors, 1 for startup/runtime errors, and 130 for an interrupt.
#' @export
alder_cli <- function(args = commandArgs(trailingOnly = TRUE)) {
  parsed <- tryCatch(alder_cli_parse(args), alder_cli_error = identity)
  if (inherits(parsed, "alder_cli_error")) {
    cat("alder: ", conditionMessage(parsed), "\n", sep = "", file = stderr())
    cat("Try 'alder --help' for usage.\n", file = stderr())
    return(2L)
  }
  if (isTRUE(parsed$help)) {
    cat(alder_cli_help(), "\n", sep = "")
    return(0L)
  }
  if (isTRUE(parsed$version)) {
    cat("alder ", as.character(utils::packageVersion("alder")), "\n", sep = "")
    return(0L)
  }
  if (identical(parsed$command, "render")) {
    return(tryCatch({
      output <- alder_render(parsed$path, engine = parsed$engine,
                             out = parsed$output,
                             include_code = parsed$include_code)
      cat(normalizePath(output, mustWork = TRUE), "\n", sep = "")
      0L
    }, interrupt = function(condition) {
      130L
    }, error = function(condition) {
      cat("alder: ", conditionMessage(condition), "\n", sep = "",
          file = stderr())
      1L
    }))
  }

  if (isTRUE(parsed$new_notebook)) {
    cat("alder new notebook at ", parsed$path,
        " (file will be created on Save)\n", sep = "")
  }

  srv <- NULL
  status <- tryCatch({
    srv <- start_alder(
      path = parsed$path, host = parsed$host, port = parsed$port,
      open = parsed$open, execution_mode = parsed$execution_mode,
      run_on_startup = parsed$run_on_startup,
      allowed_origins = parsed$allowed_origins, sandbox = parsed$sandbox,
      idle_timeout = parsed$idle_timeout
    )
    repeat {
      if (isTRUE(srv$lifecycle$stopped)) break
      later::run_now(0.1)
      if (!isTRUE(srv$lifecycle$stopped)) Sys.sleep(0.005)
    }
    as.integer(srv$lifecycle$exit_status %||% 0L)
  }, interrupt = function(condition) {
    130L
  }, error = function(condition) {
    cat("alder: ", conditionMessage(condition), "\n", sep = "", file = stderr())
    1L
  })
  if (!is.null(srv)) stop_alder(srv)
  as.integer(status)
}

#' Install the Alder command-line launcher
#'
#' Copy the packaged launcher into a user-selected executable directory. Alder
#' installs \code{alder} on Unix-like systems and \code{alder.cmd} on Windows.
#' Existing files are never replaced unless \code{overwrite = TRUE}; the new
#' launcher is staged beside its target and moved into place atomically.
#'
#' @param bin_dir Directory in which to install the platform's \code{alder}
#'   command. It is created when necessary.
#' @param overwrite Whether to replace an existing \code{alder} file.
#' @return The normalized installed path, including the platform extension,
#'   invisibly.
#' @export
alder_install_cli <- function(bin_dir = path.expand("~/.local/bin"),
                              overwrite = FALSE) {
  alder_install_cli_impl(bin_dir, overwrite, .Platform$OS.type)
}

alder_cli_launcher_spec <- function(os_type = .Platform$OS.type) {
  if (identical(os_type, "unix")) {
    return(list(source = "alder", target = "alder", executable = TRUE))
  }
  if (identical(os_type, "windows")) {
    return(list(source = "alder.cmd", target = "alder.cmd",
                executable = FALSE))
  }
  stop("unsupported operating-system type: ", os_type, call. = FALSE)
}

alder_install_cli_impl <- function(bin_dir, overwrite, os_type) {
  if (!is.character(bin_dir) || length(bin_dir) != 1L || is.na(bin_dir) ||
      !nzchar(bin_dir) || any(charToRaw(bin_dir) == as.raw(0))) {
    stop("`bin_dir` must be one nonempty path", call. = FALSE)
  }
  if (!is.logical(overwrite) || length(overwrite) != 1L || is.na(overwrite)) {
    stop("`overwrite` must be TRUE or FALSE", call. = FALSE)
  }
  bin_dir <- path.expand(bin_dir)
  if (!dir.exists(bin_dir) &&
      !dir.create(bin_dir, recursive = TRUE, showWarnings = FALSE)) {
    stop("could not create CLI directory: ", bin_dir, call. = FALSE)
  }
  bin_dir <- normalizePath(bin_dir, mustWork = TRUE)
  if (file.access(bin_dir, 2L) != 0L) {
    stop("CLI directory is not writable: ", bin_dir, call. = FALSE)
  }
  launcher <- alder_cli_launcher_spec(os_type)
  source <- system.file("exec", launcher$source,
                        package = "alder", mustWork = TRUE)
  target <- file.path(bin_dir, launcher$target)
  if (file.exists(target) && !isTRUE(overwrite)) {
    stop("refusing to replace existing launcher: ", target,
         "; use overwrite = TRUE", call. = FALSE)
  }
  staged <- tempfile(".alder-launcher-", tmpdir = bin_dir)
  on.exit(if (file.exists(staged)) unlink(staged, force = TRUE), add = TRUE)
  if (!file.copy(source, staged, overwrite = TRUE, copy.mode = FALSE)) {
    stop("could not stage the Alder launcher", call. = FALSE)
  }
  if (isTRUE(launcher$executable)) {
    Sys.chmod(staged, mode = "0755")
    if (file.access(staged, 1L) != 0L) {
      stop("could not make the Alder launcher executable", call. = FALSE)
    }
  }
  moved <- tryCatch({
    fs::file_move(staged, target)
    TRUE
  }, error = function(condition) {
    stop("could not install the Alder launcher at ", target, ": ",
         conditionMessage(condition), call. = FALSE)
  })
  if (!isTRUE(moved)) {
    stop("could not install the Alder launcher at ", target, call. = FALSE)
  }
  message("Installed Alder CLI at ", target)
  path_entries <- strsplit(Sys.getenv("PATH"), .Platform$path.sep,
                           fixed = TRUE)[[1L]]
  normalized_entries <- vapply(path_entries, function(entry) {
    if (!nzchar(entry)) return("")
    normalizePath(path.expand(entry), mustWork = FALSE)
  }, character(1L))
  if (!(bin_dir %in% normalized_entries)) {
    message("Add ", bin_dir, " to PATH to run `alder` from your shell.")
  }
  invisible(normalizePath(target, mustWork = TRUE))
}
