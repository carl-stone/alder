# alder `ui$` widgets (ADR 0003): plain classed lists with explicit `$value`.
#
# A widget is not interchangeable with its value: notebook code reads the
# current value explicitly (`n$value`), and the web UI renders an
# interactive control for it. Values are validated eagerly at construction
# and re-validated on every worker set_widget before assignment.
#
# R strings cannot reliably carry embedded NULs (jsonlite rejects \u0000 at
# the JSON boundary), so embedded-NUL rejection happens at the raw-input
# boundaries (read_json_body / the worker request loop / read_notebook),
# not inside this module. UTF-8 validity is still checked here.
#
# This module is mirrored byte-for-byte into inst/worker/ui-widgets.R
# (ADR 0007). It must stay self-contained: base R only, no package helpers,
# no `%||%`.

is_widget <- function(x) inherits(x, "alder_widget")

# Read the current value without dispatching into `$`.
widget_value <- function(x) .subset2(x, "value")

# ---------------------------------------------------------------------------
# Scalar-field validation
# ---------------------------------------------------------------------------

require_scalar_character <- function(x, what, null_ok = FALSE) {
  if (is.null(x)) {
    if (null_ok) return(invisible(NULL))
    stop(what, " must be a scalar character string", call. = FALSE)
  }
  if (!is.character(x) || length(x) != 1L || is.na(x)) {
    stop(what, " must be a scalar non-missing character string", call. = FALSE)
  }
  if (!validUTF8(x)) stop(what, " must be valid UTF-8", call. = FALSE)
  invisible(x)
}

require_scalar_logical <- function(x, what) {
  if (!is.logical(x) || length(x) != 1L || is.na(x)) {
    stop(what, " must be a scalar non-missing logical", call. = FALSE)
  }
  invisible(x)
}

# Finite scalar number, normalized to unclassed double.
require_finite_double <- function(x, what, null_ok = FALSE) {
  if (is.null(x)) {
    if (null_ok) return(invisible(NULL))
    stop(what, " must be a finite scalar number", call. = FALSE)
  }
  if (!is.numeric(x) || length(x) != 1L || is.na(x) || !is.finite(as.double(x))) {
    stop(what, " must be a finite scalar number", call. = FALSE)
  }
  as.double(x)
}

require_positive_step <- function(step) {
  step <- require_finite_double(step, "`step`")
  if (step <= 0) stop("`step` must be positive", call. = FALSE)
  step
}

# (value - base) / step must be an integer within floating-point tolerance.
check_step_lattice <- function(value, base, step, what) {
  v <- (value - base) / step
  if (!isTRUE(all.equal(v, round(v), tolerance = 1e-9))) {
    stop(what, " must lie on the step lattice from the base value", call. = FALSE)
  }
  invisible(NULL)
}

validate_choices <- function(choices) {
  if (is.null(choices) || length(choices) == 0L) {
    stop("`choices` must be a non-empty vector", call. = FALSE)
  }
  if (!is.null(names(choices)) || is.object(choices)) {
    stop("`choices` must be an unnamed, unclassed vector", call. = FALSE)
  }
  if (!(is.logical(choices) || is.integer(choices) || is.double(choices) ||
        is.character(choices))) {
    stop("`choices` must be a logical, integer, double, or character vector",
         call. = FALSE)
  }
  if (anyNA(choices)) stop("`choices` must not contain missing values", call. = FALSE)
  if (any(duplicated(choices))) stop("`choices` must be unique", call. = FALSE)
  if (is.numeric(choices) && any(!is.finite(choices))) {
    stop("numeric `choices` must be finite", call. = FALSE)
  }
  if (is.character(choices)) {
    for (ch in choices) require_scalar_character(ch, "every character `choice`")
  }
  choices
}

# ---------------------------------------------------------------------------
# Kind-specific value validation
# ---------------------------------------------------------------------------

validate_slider <- function(value, min, max, step) {
  minim <- require_finite_double(min, "`min`")
  maxim <- require_finite_double(max, "`max`")
  stepv <- require_positive_step(step)
  if (minim > maxim) stop("`min` must not exceed `max`", call. = FALSE)
  value <- require_finite_double(value, "`value`")
  if (value < minim || value > maxim) {
    stop("`value` must lie between `min` and `max`", call. = FALSE)
  }
  check_step_lattice(value, minim, stepv, "`value`")
  value
}

validate_number <- function(value, min, max, step) {
  minim <- require_finite_double(min, "`min`", null_ok = TRUE)
  maxim <- require_finite_double(max, "`max`", null_ok = TRUE)
  stepv <- require_positive_step(step)
  if (!is.null(minim) && !is.null(maxim) && minim > maxim) {
    stop("`min` must not exceed `max`", call. = FALSE)
  }
  value <- require_finite_double(value, "`value`")
  if (!is.null(minim) && value < minim) {
    stop("`value` must not be below `min`", call. = FALSE)
  }
  if (!is.null(maxim) && value > maxim) {
    stop("`value` must not exceed `max`", call. = FALSE)
  }
  base <- if (is.null(minim)) 0 else minim
  check_step_lattice(value, base, stepv, "`value`")
  value
}

validate_dropdown <- function(value, choices) {
  choices <- validate_choices(choices)
  if (length(value) != 1L || is.na(value)) {
    stop("`value` must be a non-missing scalar", call. = FALSE)
  }
  if (!any(vapply(choices, function(c) identical(c, value), logical(1)))) {
    stop("`value` must be identical in type and value to one of `choices`", call. = FALSE)
  }
  value
}

# Validate a whole widget object (construction-time / re-validation
# contract shared with the worker): the kind name, the label, and the value
# against the kind-specific constraint spec must all hold.
validate_widget <- function(x) {
  if (!inherits(x, "alder_widget")) stop("not an alder_widget", call. = FALSE)
  require_scalar_character(x$kind, "`kind`")
  require_scalar_character(x$label, "`label`", null_ok = TRUE)
  validate_widget_value(x$kind, x$value,
    list(min = x$min, max = x$max, step = x$step, choices = x$choices))
  invisible(x)
}

# Validate a candidate value against a widget's constraint spec. Returns the
# normalized scalar for slider/number; for other kinds the value is returned
# unchanged after canonical-type checks. `spec` uses min/max/step/choices.
validate_widget_value <- function(kind, value, spec) {
  switch(kind,
    slider = validate_slider(value, spec$min, spec$max, spec$step),
    number = validate_number(value, spec$min, spec$max, spec$step),
    dropdown = validate_dropdown(value, spec$choices),
    text_input = {
      require_scalar_character(value, "`value`")
      value
    },
    checkbox = {
      require_scalar_logical(value, "`value`")
      value
    },
    run_button = {
      require_scalar_logical(value, "`value`")
      value
    },
    stop("unknown widget kind: ", kind, call. = FALSE)
  )
}

# ---------------------------------------------------------------------------
# Constructors
# ---------------------------------------------------------------------------

ui <- list(
  slider = function(min, max, value = min, step = 1, label = NULL) {
    if (!is.null(label)) require_scalar_character(label, "`label`")
    spec <- list(min = require_finite_double(min, "`min`"),
                 max = require_finite_double(max, "`max`"),
                 step = require_positive_step(step))
    val <- validate_widget_value("slider", value, spec)
    structure(c(list(kind = "slider", label = label, value = val), spec),
              class = "alder_widget")
  },
  dropdown = function(choices, value = choices[[1L]], label = NULL) {
    if (!is.null(label)) require_scalar_character(label, "`label`")
    spec <- list(choices = validate_choices(choices))
    val <- validate_widget_value("dropdown", value, spec)
    structure(c(list(kind = "dropdown", label = label, value = val), spec),
              class = "alder_widget")
  },
  text_input = function(value = "", label = NULL) {
    if (!is.null(label)) require_scalar_character(label, "`label`")
    val <- validate_widget_value("text_input", value, list())
    structure(list(kind = "text_input", label = label, value = val),
              class = "alder_widget")
  },
  number = function(value = 0, min = NULL, max = NULL, step = 1, label = NULL) {
    if (!is.null(label)) require_scalar_character(label, "`label`")
    spec <- list(min = require_finite_double(min, "`min`", null_ok = TRUE),
                 max = require_finite_double(max, "`max`", null_ok = TRUE),
                 step = require_positive_step(step))
    val <- validate_widget_value("number", value, spec)
    structure(c(list(kind = "number", label = label, value = val), spec),
              class = "alder_widget")
  },
  run_button = function(label = "Run") {
    if (!is.null(label)) require_scalar_character(label, "`label`")
    structure(list(kind = "run_button", label = label, value = FALSE),
              class = "alder_widget")
  },
  checkbox = function(value = FALSE, label = NULL) {
    if (!is.null(label)) require_scalar_character(label, "`label`")
    val <- validate_widget_value("checkbox", value, list())
    structure(list(kind = "checkbox", label = label, value = val),
              class = "alder_widget")
  }
)
