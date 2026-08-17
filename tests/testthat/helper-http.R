# HTTP integration test helpers.
#
# Start alder on a random port, run a child Rscript process that makes HTTP
# requests to it, pump the event loop, and collect the child's output.

# Find a random available port.
random_port <- function() {
  httpuv::randomPort()
}

# Run an R expression in a child process that makes HTTP requests to the
# alder server. Returns the child's stdout lines.
#
# `code` is a format string with `%d` for the port and `%s` for the host.
http_child <- function(port, code, host = "127.0.0.1") {
  preamble <- sprintf("port <- %d; host <- '%s'\n", port, host)
  child <- processx::process$new(
    file.path(R.home("bin"), "Rscript"),
    c("-e", paste0(preamble, code)), stdout = "|", stderr = "|")
  results <- character()
  deadline <- Sys.time() + 30
  repeat {
    out <- child$read_output_lines()
    results <- c(results, out)
    if (!child$is_alive()) {
      out <- child$read_output_lines()
      results <- c(results, out)
      break
    }
    if (Sys.time() > deadline) {
      child$kill()
      stop("http_child timed out")
    }
    later::run_now(0.05)
  }
  child$wait(5000)
  results
}

# Start alder on a random port, calling `setup` with the session, run the
# child expression, then stop. Returns list(child_output, session, port).
with_server <- function(path = NULL, setup = NULL, code, ...) {
  port <- random_port()
  srv <- start_alder(path = path, port = port, ...)
  if (is.function(setup)) setup(srv$session)
  out <- http_child(port, code)
  stop_alder(srv)
  list(out = out, session = srv$session, port = port)
}