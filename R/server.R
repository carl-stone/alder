alder_loopback_hosts <- function() c("127.0.0.1", "localhost", "::1")

validate_loopback_host <- function(host) {
  if (!is.character(host) || length(host) != 1L || is.na(host) ||
      !nzchar(host)) {
    stop("`host` must be a nonempty string", call. = FALSE)
  }
  if (!(host %in% alder_loopback_hosts())) {
    stop("`host` must be exactly 127.0.0.1, localhost, or ::1; ",
         "non-loopback binds are not supported", call. = FALSE)
  }
  host
}

new_alder_lifecycle <- function(idle_timeout = NULL) {
  lifecycle <- new.env(parent = emptyenv())
  lifecycle$stopped <- FALSE
  lifecycle$shutdown_requested <- FALSE
  lifecycle$shutdown_reason <- NULL
  lifecycle$browser_connected <- FALSE
  lifecycle$last_browser_poll <- NULL
  lifecycle$idle_timeout <- idle_timeout
  lifecycle$idle_blocked <- FALSE
  lifecycle$idle_block_reason <- NULL
  lifecycle$stop_callback <- NULL
  # Copied server handles and the R launcher share the host's terminal status.
  lifecycle$exit_status <- NULL
  lifecycle$shutdown_scheduled <- FALSE
  lifecycle$shutdown_token <- paste0(
    sample(c(letters, LETTERS, 0:9), 48L, replace = TRUE), collapse = "")
  lifecycle$csp_nonce <- paste0(
    sample(c(letters, LETTERS, 0:9), 32L, replace = TRUE), collapse = "")
  lifecycle
}

#' Serve an alder notebook
#'
#' Start the local alder web app for a notebook: a derivation DAG over
#' \code{# \%\%} cells is computed, cells execute in dependency order in a
#' dedicated Ark R kernel, and the UI supports editing, reactive
#' execution, \code{ui$} widgets with explicit \code{$value}, and
#' interruptible execution.
#'
#' The application host, kernel, and R services run as separate processes.
#' Process isolation is not a security sandbox, so only trusted notebook code
#' should be run.
#' With \code{sandbox = TRUE} the worker runs with the standard renv project
#' library (\code{renv/library} under the notebook directory) and declared
#' packages install into it.
#'
#' @param path Path to a notebook file (plain \code{.R} with \code{# \%\%}
#'   cell markers). Must be \code{NULL} or one nonempty valid-UTF-8
#'   string. When \code{NULL}, an empty notebook with no save path is
#'   served; a nonexistent path is created only on Save.
#' @param host Loopback interface to bind. Must be exactly
#'   \code{"127.0.0.1"}, \code{"localhost"}, or \code{"::1"}; Alder does
#'   not support non-loopback binds.
#' @param port TCP port for the local web server; one integer in 1--65535.
#' @param open Open a browser tab after the server is ready.
#' @param execution_mode Reactivity mode: \code{"automatic"} runs a cell's
#'   ancestors, the target, and all descendants; \code{"lazy"} runs
#'   ancestors and the target and leaves descendants stale. App views
#'   always use automatic widget reactivity. \code{NULL} resolves from
#'   notebook metadata and configuration.
#' @param run_on_startup If \code{TRUE}, all code cells run once when the
#'   server starts; if \code{FALSE}, opening the editor or an app URL never
#'   triggers execution. \code{NULL} resolves from notebook metadata and
#'   configuration.
#' @param allowed_origins Optional explicit trusted browser origins.
#'   \code{NULL} allows exactly \code{http://127.0.0.1:<port>},
#'   \code{http://localhost:<port>}, and \code{http://[::1]:<port>}.
#' @param sandbox Run the notebook worker with an isolated package library
#'   (the standard renv project library); declared packages install into it.
#'   Notebook lookup is restricted to that library plus base/recommended R
#'   packages. Requires a notebook \code{path}; \code{sandbox = TRUE} with a
#'   \code{NULL} path or a gallery directory is an error.
#' @param idle_timeout Browser-idle shutdown timeout in seconds. After a browser
#'   has connected at least once, the host stops when no
#'   browser activity arrives for this duration. Dirty notebooks are atomically
#'   saved first; a save failure or conflict pauses shutdown and is exposed in
#'   state rather than discarding work. \code{NULL} or zero disables the timer.
#'   The R API defaults to disabled; the command-line launcher defaults to 30
#'   seconds.
#' @return An \code{alder_server} list wrapping the application host process, the
#'   notebook controller facade, and shared lifecycle state.
#' @examples
#' \dontrun{
#' srv <- start_alder("analysis.R", open = TRUE)
#' stop_alder(srv)
#' }
#' @export
start_alder <- function(path = NULL, host = "127.0.0.1", port = 8899L,
                        open = FALSE, execution_mode = NULL,
                        run_on_startup = NULL, allowed_origins = NULL,
                        sandbox = FALSE, idle_timeout = NULL) {
  alder_start_host(path, host, port, open, execution_mode,
                   run_on_startup, allowed_origins, sandbox, idle_timeout)
}

#' @rdname start_alder
#' @param srv An \code{alder_server} object returned by \code{start_alder}.
#' @export
stop_alder <- function(srv) {
  if (!inherits(srv, "alder_server") || !is.function(srv$host_close)) {
    stop("`srv` must be an alder_server returned by start_alder()")
  }
  srv$host_close()
  invisible(srv)
}
