#' Reactive notebooks for R
#'
#' Alder keeps notebooks in ordinary `.R` files separated by `# %%` comments.
#' A local web editor runs cells in dependency order in a dedicated R process.
#' Changing a widget reruns its dependents; lazy mode leaves those cells stale
#' until requested. Read widget values explicitly with `$value`.
#'
#' @section Getting started:
#' Install the shell command with [alder_install_cli()], then run
#' `alder analysis.R` in a terminal. The command owns the editor, server, and
#' worker lifecycle. Copy the installed Iris example to a writable directory
#' with the example below, then launch it with `alder iris.R`.
#'
#' @section Working with notebooks:
#' [ui] supplies reactive controls and [out] supplies rich presentation.
#' [cache] reuses computations when code and inputs still match.
#' [alder_config()] resolves editor and runtime settings, and [alder_env()]
#' manages standard renv environments. [alder_source()] and [alder_test()] run
#' notebooks noninteractively. [alder_render()] publishes through Quarto/knitr
#' or Pandoc; [alder_export()] and [alder_convert()] provide interchange formats.
#' [alder_mcp()] exposes notebook inspection, editing, and execution to agents.
#'
#' @section Execution boundary:
#' Alder serves the local machine and runs trusted R with the user's permissions.
#' Definitions must be unique across cells and the dependency graph must be
#' acyclic. Dynamic environment operations that cannot be analyzed safely receive
#' actionable diagnostics. Reference-object mutations and external side effects
#' are not transactional. Warnings, messages, and errors remain visible.
#'
#' @examples
#' \dontrun{
#' file.copy(system.file("examples", "iris.R", package = "alder"), "iris.R")
#' alder_install_cli()
#' # In a terminal: alder iris.R
#' }
#' @seealso [start_alder()], [stop_alder()], [alder_cli()], [alder_check()]
#' @keywords package
#' @importFrom rlang hash
#' @importFrom base64enc base64encode
#' @importFrom languageserver run
"_PACKAGE"
