#' Run the alder Model Context Protocol server over stdin/stdout.
#'
#' @param path Optional notebook path.  When omitted, an in-memory notebook is
#'   started.
#' @param url Optional URL of an already-running alder REST server.  Exactly
#'   one of `path` and `url` may be supplied.
#' @details Run tools and `set_widget` have the same settlement contract for
#'   both backends. Run tools return after the exact requested run and every
#'   deferred run-button reset it causes have settled; ordinary cell errors
#'   remain visible in notebook state. Reset failures retain their Alder error
#'   code. `set_widget` returns only after the exact widget update and its
#'   automatic reactive effects have settled, including a causally linked
#'   run-button reset.
#'   Named widgets composed inside layouts or resolved lazy outputs use the
#'   same settlement contract as top-level widget outputs.
#'   Widget failures retain their Alder error code.
#'   Value inspection rejects stale, disabled, failed, or otherwise unexecuted
#'   definitions with `stale_value`. Run the defining cell and its dependencies
#'   before inspecting it again. Source changes also invalidate pending value
#'   responses and previous inspector results; notebook outputs remain visibly
#'   stale until their cells rerun.
#'
#'   The stdio transport accepts one UTF-8 JSON object per line, with a 16 MiB
#'   message limit. It rejects malformed bytes, excessive structural
#'   complexity, and duplicate object keys at any depth before dispatch, so an
#'   ambiguous request cannot select a tool or mutate notebook state. A rejected
#'   frame does not prevent a later valid frame from being processed.
#'   MCP requests require a scalar string ID or an exactly represented integer
#'   ID in the inclusive range `-(2^53 - 1)` through `2^53 - 1`; invalid IDs
#'   are rejected before dispatch. Method parameters use named JSON objects,
#'   and initialization requires protocol version, client capabilities, and
#'   client information. A successful initialize request enters an awaiting
#'   phase; only a subsequent valid `notifications/initialized` message makes
#'   normal tools and resources available. Before that point, only `ping` may
#'   execute. Notifications never emit a response, and invalid or out-of-phase
#'   notifications are effect-free. `tools/call` requires a known, nonempty
#'   tool name and object-valued arguments; malformed calls receive a top-level
#'   JSON-RPC parameter error before any tool executes.
#'   For a local path backend, notebook runtime metadata and layered Alder
#'   configuration are resolved with the same precedence as the web server.
#'   User cells never run before lifecycle readiness; a configured startup run
#'   begins after a valid initialized notification and settles before normal
#'   MCP operations are accepted.
#' @return Invisibly, `NULL` after stdin reaches EOF or a `shutdown` request.
#' @examples
#' \dontrun{alder_mcp(path = "analysis.R")}
#' @export
alder_mcp <- function(path = NULL, url = NULL) {
  alder_mcp_host(path, url)
}
