#' Reactive notebook helpers for R
#'
#' Alder's R package provides ordinary values for notebook controls, rich output
#' records, and explicit computation caching. The same helpers work in a plain
#' `Rscript` process; no application host is required to construct or inspect
#' their values.
#'
#' @section Public helpers:
#' [ui] creates validated widgets whose current values are read explicitly with
#' `$value`. [out] creates text, table, media, layout, progress, lazy, and other
#' rich output values. [cache] provides memory and disk-backed wrappers with
#' dependency-aware invalidation and atomic RDS writes.
#'
#' @section Notebook boundary:
#' The application host owns notebook persistence, execution, rendering, and
#' transport. These R helpers retain their value semantics independently of that
#' host, including R dates, POSIXct instants, data frames, and composite widget
#' values.
#'
#' @examples
#' \dontrun{
#' library(alder)
#' control <- ui$slider(1, 5, value = 3)
#' control$value
#' out$md("A **rich** value")
#' }
#' @keywords package
"_PACKAGE"
