# Launcher: serve an installed alder notebook from any working directory.
#
# Usage:
#   Rscript inst/worker/server.R                  # empty notebook, port 8899
#   Rscript inst/worker/server.R notebook.R       # notebook, port 8899
#   Rscript inst/worker/server.R notebook.R 8080  # notebook, explicit port
#   Rscript inst/worker/server.R "" 8080          # empty notebook, explicit port
#
# Zero args means path = NULL and port = 8899L; one arg is the path (an
# empty string maps to NULL) with port 8899L; two args are path and port.
# Any other count, or a port that is not decimal text converting within
# 1-65535, stops with a usage error. The launcher loads the installed
# `alder` package (no caller-relative sourcing), so it works from any cwd
# through `system.file("worker", "server.R", package = "alder")`.

main <- function(args = commandArgs(trailingOnly = TRUE)) {
  if (length(args) > 2L) {
    stop("usage: Rscript server.R [notebook-path [port]]", call. = FALSE)
  }
  path <- if (length(args) >= 1L) {
    if (!nzchar(args[[1L]])) NULL else args[[1L]]
  } else {
    NULL
  }
  port <- 8899L
  if (length(args) >= 2L) {
    p <- args[[2L]]
    if (!grepl("^[1-9][0-9]*$", p)) {
      stop("invalid port: ", p, call. = FALSE)
    }
    port <- as.integer(p)
    if (is.na(port) || port < 1L || port > 65535L) {
      stop("invalid port: ", p, call. = FALSE)
    }
  }
  library(alder)
  srv <- start_alder(path, port = port)
  on.exit(stop_alder(srv), add = TRUE)
  # A top-level interrupt unwinds this pump (no tryCatch swallowing), so
  # the on.exit cleanup runs instead of a silent Ctrl-C.
  repeat later::run_now(0.05)
}

main()
