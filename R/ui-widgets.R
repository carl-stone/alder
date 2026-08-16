# alder `ui$` widgets (ADR 0003): an S3 proxy that IS its value.
#
# `n <- ui$slider(10, 1000)` binds `n` to a proxy object carrying the current
# value. S3 methods (arithmetic, comparison, coercion, subsetting, aggregation)
# make the proxy behave as the underlying value in ordinary R code, plots, and
# tidy-eval predicates — no explicit unwrap, no source rewriting. In the UI the
# proxy renders as an interactive control; setting its value propagates to the
# notebook and invalidates dependents (handled by the server, not here).

`%||%` <- function(a, b) if (is.null(a)) b else a

# `.Generic` is injected by the S3 group-generic dispatch machinery (Writing
# R Extensions, Ops/Math/Summary sections); declare it so static checks
# treat it as provided.
utils::globalVariables(".Generic")

is_widget <- function(x) inherits(x, "alder_widget_proxy")

# Read the proxy's current value without going through S3 dispatch (which
# would recurse back into `[[.alder_widget_proxy`).
widget_value <- function(x) .subset2(x, ".value")
as_widget_value <- function(x) if (is_widget(x)) widget_value(x) else x

# Generic proxy constructor.
proxy <- function(kind, value, ..., label = NULL) {
  structure(
    c(list(.kind = kind, .label = label %||% "", .value = value), list(...)),
    class = "alder_widget_proxy"
  )
}

`ui` <- list(
  slider = function(min, max, value = min, step = 1, label = NULL)
    proxy("slider", value, min = min, max = max, step = step, label = label),
  dropdown = function(choices, value = choices[[1L]], label = NULL)
    proxy("dropdown", value, choices = choices, label = label),
  text_input = function(value = "", label = NULL)
    proxy("text_input", value, label = label),
  number = function(value, min = NA_real_, max = NA_real_, step = 1, label = NULL)
    proxy("number", value, min = min, max = max, step = step, label = label),
  button = function(label = "Run", value = 0L)
    proxy("button", value, label = label),
  checkbox = function(value = FALSE, label = NULL)
    proxy("checkbox", value, label = label)
)

# -- Coercion ---------------------------------------------------------------
as.numeric.alder_widget_proxy <- function(x, ...) as.numeric(widget_value(x))
as.integer.alder_widget_proxy <- function(x, ...) as.integer(widget_value(x))
as.character.alder_widget_proxy <- function(x, ...) as.character(widget_value(x))
as.logical.alder_widget_proxy <- function(x, ...) as.logical(widget_value(x))
as.double.alder_widget_proxy <- function(x, ...) as.double(widget_value(x))

# -- Ops (arithmetic & comparison) ------------------------------------------
Ops.alder_widget_proxy <- function(e1, e2) {
  v1 <- as_widget_value(e1)
  missing_e2 <- missing(e2)   # literal NULL stays a binary operand
  v2 <- if (missing_e2) NULL else as_widget_value(e2)
  base_op <- get(.Generic, envir = baseenv())
  if (missing_e2) base_op(v1) else base_op(v1, v2)
}

# -- Math -------------------------------------------------------------------
Math.alder_widget_proxy <- function(x, ...) {
  get(.Generic, envir = baseenv())(widget_value(x), ...)
}

# -- Summary (aggregation: sum, min, max, ...) ------------------------------
Summary.alder_widget_proxy <- function(..., na.rm = FALSE) {
  args <- lapply(list(...), as_widget_value)
  do.call(get(.Generic, envir = baseenv()), c(args, list(na.rm = na.rm)))
}

# `mean()` is not a Summary generic member; give the proxy its own method so
# plain `mean(widget)` — including trim/na.rm arguments — delegates to the
# unwrapped value.
mean.alder_widget_proxy <- function(x, trim = 0, na.rm = FALSE, ...) {
  mean(widget_value(x), trim = trim, na.rm = na.rm, ...)
}

# -- Subsetting -------------------------------------------------------------
`[.alder_widget_proxy` <- function(x, i) widget_value(x)[i]
`[[.alder_widget_proxy` <- function(x, i) widget_value(x)[[i]]
`[<-.alder_widget_proxy` <- function(x, i, value) {
  v <- widget_value(x)
  v[i] <- value
  x[[".value"]] <- v
  x
}
# `$value` is the public value accessor (a widget's value in plain R code);
# `.value` stays the protocol/internal storage field. Other names reveal the
# control spec (.kind/.label/min/max/...); unknown names fall through to the
# underlying value's element.
`$.alder_widget_proxy` <- function(x, name) {
  if (identical(name, "value")) return(widget_value(x))
  nms <- names(unclass(x))
  if (name %in% nms) return(.subset2(x, name))
  widget_value(x)[[name]]
}
length.alder_widget_proxy <- function(x) length(widget_value(x))
names.alder_widget_proxy <- function(x) names(widget_value(x))
is.na.alder_widget_proxy <- function(x) is.na(widget_value(x))
is.numeric.alder_widget_proxy <- function(x) is.numeric(widget_value(x))
is.character.alder_widget_proxy <- function(x) is.character(widget_value(x))
is.logical.alder_widget_proxy <- function(x) is.logical(widget_value(x))
xtfrm.alder_widget_proxy <- function(x) xtfrm(widget_value(x))
as.matrix.alder_widget_proxy <- function(x, ...) as.matrix(widget_value(x), ...)
as.data.frame.alder_widget_proxy <- function(x, ...) as.data.frame(widget_value(x), ...)

c.alder_widget_proxy <- function(...) {
  args <- lapply(list(...), as_widget_value)
  do.call(base::c, args)
}

# -- Formatting -------------------------------------------------------------
print.alder_widget_proxy <- function(x, ...) {
  cat("<alder widget:", .subset2(x, ".kind"), "value =", widget_value(x), ">\n")
  invisible(x)
}
format.alder_widget_proxy <- function(x, ...) format(widget_value(x), ...)
