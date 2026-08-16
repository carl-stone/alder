# Launcher: source the package and serve, pumping the httpuv/later loop.
args <- commandArgs(trailingOnly = TRUE)
path <- if (length(args) >= 1L && nzchar(args[[1L]])) args[[1L]] else NULL
port <- if (length(args) >= 2L) as.integer(args[[2L]]) else 8899L
for (f in c("R/notebook.R", "R/analysis.R", "R/worker.R", "R/session.R", "R/server.R"))
  source(f)
srv <- start_alder(path, port = port)
repeat later::run_now(0.05)
