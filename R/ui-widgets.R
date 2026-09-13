# Keep this module base-R-only. Ark loads these constructors from the installed
# package namespace; no worker mirror is sourced. Explicit $value avoids
# coercion promises that R's S3-bypassing operations cannot uphold.

is_widget <- function(x) inherits(x, "alder_widget")

# Read the current value without dispatching into `$`.
widget_value <- function(x) .subset2(x, "value")

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

require_scalar_logical <- function(x, what, null_ok = FALSE) {
  if (is.null(x)) {
    if (null_ok) return(invisible(NULL))
    stop(what, " must be a scalar non-missing logical", call. = FALSE)
  }
  if (!is.logical(x) || length(x) != 1L || is.na(x)) {
    stop(what, " must be a scalar non-missing logical", call. = FALSE)
  }
  invisible(x)
}

require_scalar_integer <- function(x, what, min = NULL, max = .Machine$integer.max) {
  if (!is.numeric(x) || length(x) != 1L || is.na(x)) {
    stop(what, " must be a scalar integer", call. = FALSE)
  }
  x_double <- as.double(x)
  if (!is.finite(x_double) || x_double != floor(x_double)) {
    stop(what, " must be a scalar integer", call. = FALSE)
  }
  if ((!is.null(min) && x_double < min) || (!is.null(max) && x_double > max)) {
    stop(what, " is out of range", call. = FALSE)
  }
  as.integer(x_double)
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

validate_date <- function(value, what = "`value`", null_ok = FALSE) {
  if (is.null(value) && null_ok) return(NULL)
  if (!inherits(value, "Date") || length(value) != 1L || is.na(value)) {
    stop(what, " must be a scalar Date", call. = FALSE)
  }
  value
}

validate_date_bounds <- function(value, min, max, what = "`value`") {
  value <- validate_date(value, what)
  min <- validate_date(min, "`min`", null_ok = TRUE)
  max <- validate_date(max, "`max`", null_ok = TRUE)
  if (!is.null(min) && !is.null(max) && min > max) {
    stop("`min` must not exceed `max`", call. = FALSE)
  }
  if (!is.null(min) && value < min) stop(what, " is below `min`", call. = FALSE)
  if (!is.null(max) && value > max) stop(what, " exceeds `max`", call. = FALSE)
  value
}

validate_datetime <- function(value, min = NULL, max = NULL, what = "`value`") {
  if (!inherits(value, "POSIXct") || length(value) != 1L || is.na(value) ||
      !is.finite(as.double(value))) {
    stop(what, " must be a scalar POSIXct", call. = FALSE)
  }
  if (as.double(value) != trunc(as.double(value))) {
    stop(what, " must have whole-second precision", call. = FALSE)
  }
  if (!is.null(min)) {
    if (!inherits(min, "POSIXct") || length(min) != 1L || is.na(min)) {
      stop("`min` must be a scalar POSIXct", call. = FALSE)
    }
    if (!is.finite(as.double(min)) || as.double(min) != trunc(as.double(min))) {
      stop("`min` must have whole-second precision", call. = FALSE)
    }
  }
  if (!is.null(max)) {
    if (!inherits(max, "POSIXct") || length(max) != 1L || is.na(max)) {
      stop("`max` must be a scalar POSIXct", call. = FALSE)
    }
    if (!is.finite(as.double(max)) || as.double(max) != trunc(as.double(max))) {
      stop("`max` must have whole-second precision", call. = FALSE)
    }
  }
  if (!is.null(min) && !is.null(max) && min > max) {
    stop("`min` must not exceed `max`", call. = FALSE)
  }
  if (!is.null(min) && value < min) stop(what, " is below `min`", call. = FALSE)
  if (!is.null(max) && value > max) stop(what, " exceeds `max`", call. = FALSE)
  value
}

validate_data_frame <- function(value, what = "`value`") {
  if (!is.data.frame(value)) stop(what, " must be a data frame", call. = FALSE)
  value
}

validate_file_value <- function(value, what = "`value`") {
  value <- validate_data_frame(value, what)
  required <- c("name", "size", "path")
  if (!identical(names(value), required)) {
    stop(what, " must have columns name, size, and path", call. = FALSE)
  }
  if (!is.character(value$name) || anyNA(value$name) ||
      any(!nzchar(value$name))) {
    stop(what, "$name must contain non-empty strings", call. = FALSE)
  }
  if (!is.numeric(value$size) || anyNA(value$size) ||
      any(!is.finite(value$size)) || any(value$size < 0)) {
    stop(what, "$size must contain non-negative finite numbers", call. = FALSE)
  }
  if (!is.character(value$path) || anyNA(value$path) ||
      any(!nzchar(value$path))) {
    stop(what, "$path must contain non-empty strings", call. = FALSE)
  }
  value
}

validate_children <- function(children, dictionary = FALSE) {
  if (!is.list(children)) stop("widget children must be a list", call. = FALSE)
  if (dictionary) {
    nms <- names(children)
    if (is.null(nms) || anyNA(nms) || any(!nzchar(nms)) ||
        any(!validUTF8(nms)) || anyDuplicated(nms)) {
      stop("dictionary children must have unique names that are non-empty, ",
           "non-missing, and valid UTF-8", call. = FALSE)
    }
  }
  for (child in children) {
    if (!is_widget(child)) stop("every widget child must be an alder_widget", call. = FALSE)
    validate_widget(child)
  }
  invisible(children)
}

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

validate_range_slider <- function(value, min, max, step) {
  minim <- require_finite_double(min, "`min`")
  maxim <- require_finite_double(max, "`max`")
  stepv <- require_positive_step(step)
  if (minim > maxim) stop("`min` must not exceed `max`", call. = FALSE)
  if (!is.numeric(value) || length(value) != 2L || anyNA(value) ||
      any(!is.finite(as.double(value))) || value[[1L]] > value[[2L]]) {
    stop("`value` must be a length-two non-decreasing numeric vector", call. = FALSE)
  }
  value <- as.double(value)
  if (any(value < minim | value > maxim)) {
    stop("`value` must lie between `min` and `max`", call. = FALSE)
  }
  check_step_lattice(value[[1L]], minim, stepv, "`value`")
  check_step_lattice(value[[2L]], minim, stepv, "`value`")
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

validate_multiselect <- function(value, choices) {
  choices <- validate_choices(choices)
  if (length(value) && anyNA(value)) {
    stop("`value` must not contain missing values", call. = FALSE)
  }
  if (typeof(value) != typeof(choices) && length(value)) {
    stop("`value` must have the same type as `choices`", call. = FALSE)
  }
  if (length(value) && anyDuplicated(value)) {
    stop("`value` must not contain duplicates", call. = FALSE)
  }
  indices <- integer()
  if (length(value)) {
    indices <- vapply(value, function(v) {
      idx <- which(vapply(choices, function(c) identical(c, v), logical(1)))
      if (!length(idx)) stop("`value` must be a subset of `choices`", call. = FALSE)
      idx[[1L]]
    }, integer(1))
    if (!identical(indices, sort(indices))) {
      stop("`value` must follow the order of `choices`", call. = FALSE)
    }
  }
  value
}

validate_table_selection <- function(value) {
  validate_data_frame(value)
}

# Validate a whole widget object (construction-time / re-validation
# contract shared with the worker).
validate_widget <- function(x) {
  if (!inherits(x, "alder_widget")) stop("not an alder_widget", call. = FALSE)
  require_scalar_character(x$kind, "`kind`")
  require_scalar_character(x$label, "`label`", null_ok = TRUE)
  validate_widget_value(x$kind, x$value, x)
  invisible(x)
}

# Validate a candidate value against a widget's constraint spec. `spec` is
# either the widget itself or the fields returned by widget_spec_constraints.
validate_widget_value <- function(kind, value, spec) {
  get_spec <- function(name, default = NULL) {
    if (is.null(spec)) return(default)
    out <- spec[[name]]
    if (is.null(out)) default else out
  }
  switch(kind,
    slider = validate_slider(value, get_spec("min"), get_spec("max"), get_spec("step")),
    range_slider = validate_range_slider(value, get_spec("min"), get_spec("max"), get_spec("step")),
    number = validate_number(value, get_spec("min"), get_spec("max"), get_spec("step")),
    dropdown = validate_dropdown(value, get_spec("choices")),
    radio = validate_dropdown(value, get_spec("choices")),
    multiselect = validate_multiselect(value, get_spec("choices")),
    text_input = { require_scalar_character(value, "`value`"); value },
    text_area = { require_scalar_character(value, "`value`"); value },
    code_editor = { require_scalar_character(value, "`value`"); value },
    checkbox = { require_scalar_logical(value, "`value`"); value },
    switch = { require_scalar_logical(value, "`value`"); value },
    run_button = { require_scalar_logical(value, "`value`"); value },
    button = { require_scalar_integer(value, "`value`", min = 0L) },
    refresh = { require_scalar_integer(value, "`value`", min = 0L) },
    date = validate_date_bounds(value, get_spec("min"), get_spec("max")),
    date_range = {
      if (!inherits(value, "Date") || length(value) != 2L || anyNA(value) ||
          value[[1L]] > value[[2L]]) {
        stop("`value` must be a length-two non-decreasing Date vector", call. = FALSE)
      }
      min <- get_spec("min"); max <- get_spec("max")
      if (!is.null(min) && value[[1L]] < min) stop("`value` is below `min`", call. = FALSE)
      if (!is.null(max) && value[[2L]] > max) stop("`value` exceeds `max`", call. = FALSE)
      value
    },
    datetime = validate_datetime(value, get_spec("min"), get_spec("max")),
    file = validate_file_value(value),
    table = validate_table_selection(value),
    dataframe = validate_data_frame(value),
    array = {
      children <- get_spec("children", list())
      validate_children(children)
      if (!is.list(value) || length(value) != length(children)) {
        stop("`value` must contain one value per child", call. = FALSE)
      }
      for (i in seq_along(children)) {
        validate_widget_value(children[[i]]$kind, value[[i]], children[[i]])
      }
      value
    },
    dictionary = {
      children <- get_spec("children", list())
      validate_children(children, dictionary = TRUE)
      if (!is.list(value) || !identical(names(value), names(children))) {
        stop("`value` must contain one value per named child", call. = FALSE)
      }
      for (nm in names(children)) {
        child <- children[[nm]]
        validate_widget_value(child$kind, value[[nm]], child)
      }
      value
    },
    form = {
      child <- get_spec("child")
      if (!is_widget(child)) stop("form child must be an alder_widget", call. = FALSE)
      if (!is.null(value)) {
        validate_widget_value(child$kind, value, child)
      }
      value
    },
    stop("unknown widget kind: ", kind, call. = FALSE)
  )
}

new_widget <- function(kind, label, value, spec = list()) {
  if (!is.null(label)) require_scalar_character(label, "`label`")
  x <- structure(c(list(kind = kind, label = label, value = value), spec),
                 class = "alder_widget")
  validate_widget(x)
  x
}

widget_validate_path <- function(path = character()) {
  if (is.null(path)) return(character())
  if (!is.character(path) || anyNA(path) || any(!nzchar(path)) ||
      any(vapply(path, function(x) any(charToRaw(x) == as.raw(0)), logical(1)))) {
    stop("widget path must be a non-empty character vector", call. = FALSE)
  }
  path
}

widget_recompute_value <- function(x) {
  if (!is_widget(x)) stop("not an alder_widget", call. = FALSE)
  if (x$kind %in% c("array", "dictionary")) {
    validate_children(x$children, dictionary = identical(x$kind, "dictionary"))
    x$value <- lapply(x$children, widget_value)
    if (identical(x$kind, "dictionary")) names(x$value) <- names(x$children)
    validate_widget(x)
  }
  x
}

widget_child <- function(x, path = character()) {
  if (!is_widget(x)) stop("not an alder_widget", call. = FALSE)
  path <- widget_validate_path(path)
  if (!length(path)) return(x)
  if (!(x$kind %in% c("array", "dictionary", "form"))) return(NULL)
  if (identical(x$kind, "form")) return(widget_child(x$child, path))
  key <- path[[1L]]
  children <- if (is.null(x$children)) list() else x$children
  if (!(key %in% names(children))) return(NULL)
  widget_child(children[[key]], path[-1L])
}

widget_set_child <- function(x, path = character(), value) {
  if (!is_widget(x)) stop("not an alder_widget", call. = FALSE)
  path <- widget_validate_path(path)
  if (!length(path)) {
    x$value <- validate_widget_value(x$kind, value, x)
    validate_widget(x)
    return(x)
  }
  if (identical(x$kind, "form")) {
    x$child <- widget_set_child(x$child, path, value)
    validate_widget(x)
    return(x)
  }
  if (!(x$kind %in% c("array", "dictionary"))) {
    stop("widget path does not exist", call. = FALSE)
  }
  key <- path[[1L]]
  children <- if (is.null(x$children)) list() else x$children
  if (!(key %in% names(children))) {
    stop("widget path does not exist", call. = FALSE)
  }
  if (length(path) == 1L) {
    child <- children[[key]]
    child$value <- validate_widget_value(child$kind, value, child)
    children[[key]] <- widget_recompute_value(child)
  } else {
    children[[key]] <- widget_set_child(children[[key]], path[-1L], value)
  }
  x$children <- children
  widget_recompute_value(x)
}

widget_child_paths <- function(x, prefix = character()) {
  if (!is_widget(x)) return(list())
  prefix <- widget_validate_path(prefix)
  if (x$kind == "form") return(widget_child_paths(x$child, prefix))
  if (!(x$kind %in% c("array", "dictionary"))) return(list(prefix))
  out <- list()
  for (nm in names(x$children)) {
    out <- c(out, widget_child_paths(x$children[[nm]], c(prefix, nm)))
  }
  out
}

#' Notebook UI widgets
#'
#' The \code{ui} collection creates interactive notebook inputs. Every
#' constructor returns an \code{alder_widget}; read its current value explicitly
#' through \code{$value}. A scalar non-missing valid-UTF-8 character string or
#' \code{NULL} is accepted for every \code{label} argument. Ordinary input
#' changes update \code{$value}; automatic and app sessions reactively rerun
#' consumers, while lazy sessions mark them stale. Buttons, refresh inputs,
#' tables, data frames, file inputs, and forms have the event semantics below.
#'
#' @section Constructor reference:
#' \describe{
#' \item{\code{ui$slider(min, max, value = min, step = 1, label = NULL)}}{
#'   A scalar numeric slider. \code{min}, \code{max}, \code{value}, and
#'   \code{step} must be finite; \code{min <= max}, \code{step} must be
#'   positive, and \code{value} must be within the bounds and on the step
#'   lattice rooted at \code{min}. \code{$value} is an unclassed double.
#' }
#' \item{\code{ui$range_slider(min, max, value = c(min, max), step = 1, label = NULL)}}{
#'   A numeric interval. Bounds and step follow \code{slider}; \code{value}
#'   must be a finite, non-missing, length-two, non-decreasing numeric vector
#'   whose endpoints are within the bounds and on the step lattice.
#'   \code{$value} is a length-two unclassed double vector.
#' }
#' \item{\code{ui$dropdown(choices, value = choices[[1L]], label = NULL)}}{
#'   One value from \code{choices}. Choices must be a nonempty, unnamed,
#'   unclassed, unique logical, integer, double, or character vector with no
#'   missing values (and finite numeric values). \code{value} must be scalar
#'   and identical in type and value to a choice; \code{$value} preserves that
#'   type.
#' }
#' \item{\code{ui$radio(choices, value = choices[[1L]], label = NULL)}}{
#'   A radio group with the same choices, value, and \code{$value} contract as
#'   \code{dropdown}.
#' }
#' \item{\code{ui$multiselect(choices, value = choices[0], label = NULL)}}{
#'   Zero or more values from choices satisfying the \code{dropdown} choices
#'   contract. \code{value} must be a unique, non-missing subset in the choices'
#'   order; a nonempty value must have the choices' type. \code{$value} is that
#'   possibly empty vector (the default \code{choices[0]} preserves its type).
#' }
#' \item{\code{ui$text_input(value = "", label = NULL)}}{
#'   A one-line input. \code{value}, and therefore \code{$value}, is one
#'   non-missing valid-UTF-8 character string.
#' }
#' \item{\code{ui$text_area(value = "", label = NULL, rows = 4L)}}{
#'   A multiline input with the \code{text_input} value contract. \code{rows}
#'   must be a positive integer.
#' }
#' \item{\code{ui$number(value = 0, min = NULL, max = NULL, step = 1, label = NULL)}}{
#'   A scalar numeric input. \code{value} and \code{step} are finite;
#'   optional \code{min} and \code{max} are finite with \code{min <= max};
#'   \code{step} is positive. The value must be within supplied bounds and on
#'   the lattice rooted at \code{min}, or zero when \code{min} is \code{NULL}.
#'   \code{$value} is an unclassed double.
#' }
#' \item{\code{ui$checkbox(value = FALSE, label = NULL)}}{
#'   A checkbox whose \code{value} and \code{$value} are one non-missing
#'   logical value.
#' }
#' \item{\code{ui$switch(value = FALSE, label = NULL)}}{
#'   A switch with the same logical value contract as \code{checkbox}.
#' }
#' \item{\code{ui$run_button(label = "Run")}}{
#'   A one-shot logical event. \code{$value} starts as \code{FALSE}; a click
#'   supplies \code{TRUE} to reactive consumers and Alder resets it to
#'   \code{FALSE} after those consumers run.
#' }
#' \item{\code{ui$button(label = "Click", value = 0L)}}{
#'   A persistent click counter. \code{value} must be a nonnegative integer;
#'   each click increments the integer \code{$value}.
#' }
#' \item{\code{ui$date(value = Sys.Date(), min = NULL, max = NULL, label = NULL)}}{
#'   A scalar, non-missing \code{Date}. Optional \code{min} and \code{max}
#'   are scalar \code{Date} bounds with \code{min <= max}; \code{$value} is
#'   the selected \code{Date} within them.
#' }
#' \item{\code{ui$date_range(value = c(Sys.Date(), Sys.Date()), min = NULL, max = NULL, label = NULL)}}{
#'   A non-missing, length-two, non-decreasing \code{Date} vector within the
#'   optional scalar \code{Date} bounds. \code{$value} preserves that shape.
#' }
#' \item{\code{ui$datetime(value = NULL, min = NULL, max = NULL, label = NULL)}}{
#'   A scalar, finite, whole-second \code{POSIXct} instant within optional
#'   scalar \code{POSIXct} bounds. \code{NULL} defaults to the current UTC
#'   instant truncated to a whole second. \code{$value} is a \code{POSIXct};
#'   browser transport represents the instant in UTC.
#' }
#' \item{\code{ui$code_editor(value = "", language = "r", label = NULL)}}{
#'   A text editor whose \code{value} follows \code{text_input}. \code{language}
#'   must be one of \code{"r"}, \code{"sql"}, \code{"python"},
#'   \code{"markdown"}, or \code{"json"}; \code{$value} is the source string.
#' }
#' \item{\code{ui$refresh(interval = 5, label = "Refresh")}}{
#'   A periodic event counter. \code{interval} is a finite number of seconds
#'   of at least 0.5. \code{$value} starts at integer zero, increments on each
#'   tick, and drives reactive consumers; the browser can pause the timer.
#' }
#' \item{\code{ui$file(label = NULL, accept = NULL, multiple = FALSE)}}{
#'   A file picker. \code{accept} is \code{NULL} or a nonempty character
#'   vector of browser file filters, and \code{multiple} is one non-missing
#'   logical value. \code{$value} is a data frame with \code{name}, numeric
#'   \code{size}, and server-side temporary \code{path} columns, initially
#'   with zero rows.
#' }
#' \item{\code{ui$table(data, selection = c("multi", "single", "none"), page_size = 25L, label = NULL)}}{
#'   An interactive table. \code{data} is a data frame or matrix, matrices are
#'   converted to data frames, \code{selection} resolves to \code{"multi"},
#'   \code{"single"}, or \code{"none"}, and \code{page_size} is a positive
#'   integer. \code{$value} is the selected rows as a data frame and starts
#'   with zero rows; selection changes rerun consumers.
#' }
#' \item{\code{ui$dataframe(data, label = NULL)}}{
#'   An interactive data-frame viewer. \code{data} is a data frame or matrix,
#'   with matrices converted to data frames. \code{$value} is the data frame
#'   after current browser transformations such as sorting or filtering.
#' }
#' \item{\code{ui$array(...)}}{
#'   A composite of zero or more widget children. Names must be non-missing,
#'   valid UTF-8, and unique; unnamed children receive positional names
#'   \code{"1"}, \code{"2"}, and so on. \code{$value} is a correspondingly
#'   named list of child values, and a child event updates only its path before
#'   reactive consumers run.
#' }
#' \item{\code{ui$dictionary(...)}}{
#'   A composite of one or more widget children. Every child must have a
#'   nonempty, valid UTF-8, unique name that is non-missing. \code{$value} is the named
#'   list of child values, updated by child path.
#' }
#' \item{\code{ui$form(child, submit_label = "Submit")}}{
#'   A submit boundary around one widget, including a composite. \code{child}
#'   must be an \code{alder_widget}; \code{submit_label} is one non-missing
#'   valid-UTF-8 string. Child edits update a draft without rerunning form
#'   consumers. \code{$value} starts as \code{NULL} and becomes the complete
#'   child value only when Submit is activated.
#' }
#' }
#'
#' @examples
#' threshold <- ui$slider(0, 10, value = 5, label = "Threshold")
#' threshold$value
#'
#' window <- ui$range_slider(0, 24, value = c(8, 17), label = "Hours")
#' groups <- ui$multiselect(c("control", "treated"), value = "treated")
#' window$value
#' groups$value
#'
#' settings <- ui$dictionary(
#'   threshold = ui$number(0.05, min = 0, max = 1, step = 0.01),
#'   enabled = ui$checkbox(TRUE)
#' )
#' settings$value
#'
#' approval <- ui$form(ui$text_input("draft"), submit_label = "Apply")
#' approval$value # NULL until the user submits the form
#' @export
ui <- list(
  slider = function(min, max, value = min, step = 1, label = NULL) {
    spec <- list(min = require_finite_double(min, "`min`"),
                 max = require_finite_double(max, "`max`"),
                 step = require_positive_step(step))
    val <- validate_widget_value("slider", value, spec)
    new_widget("slider", label, val, spec)
  },
  range_slider = function(min, max, value = c(min, max), step = 1, label = NULL) {
    spec <- list(min = require_finite_double(min, "`min`"),
                 max = require_finite_double(max, "`max`"),
                 step = require_positive_step(step))
    val <- validate_widget_value("range_slider", value, spec)
    new_widget("range_slider", label, val, spec)
  },
  dropdown = function(choices, value = choices[[1L]], label = NULL) {
    spec <- list(choices = validate_choices(choices))
    val <- validate_widget_value("dropdown", value, spec)
    new_widget("dropdown", label, val, spec)
  },
  radio = function(choices, value = choices[[1L]], label = NULL) {
    spec <- list(choices = validate_choices(choices))
    val <- validate_widget_value("radio", value, spec)
    new_widget("radio", label, val, spec)
  },
  multiselect = function(choices, value = choices[0], label = NULL) {
    spec <- list(choices = validate_choices(choices))
    val <- validate_widget_value("multiselect", value, spec)
    new_widget("multiselect", label, val, spec)
  },
  text_input = function(value = "", label = NULL) {
    val <- validate_widget_value("text_input", value, list())
    new_widget("text_input", label, val)
  },
  text_area = function(value = "", label = NULL, rows = 4L) {
    rows <- require_scalar_integer(rows, "`rows`", min = 1L)
    val <- validate_widget_value("text_area", value, list())
    new_widget("text_area", label, val, list(rows = rows))
  },
  number = function(value = 0, min = NULL, max = NULL, step = 1, label = NULL) {
    spec <- list(min = require_finite_double(min, "`min`", null_ok = TRUE),
                 max = require_finite_double(max, "`max`", null_ok = TRUE),
                 step = require_positive_step(step))
    val <- validate_widget_value("number", value, spec)
    new_widget("number", label, val, spec)
  },
  checkbox = function(value = FALSE, label = NULL) {
    val <- validate_widget_value("checkbox", value, list())
    new_widget("checkbox", label, val)
  },
  switch = function(value = FALSE, label = NULL) {
    val <- validate_widget_value("switch", value, list())
    new_widget("switch", label, val)
  },
  run_button = function(label = "Run") {
    new_widget("run_button", label, FALSE)
  },
  button = function(label = "Click", value = 0L) {
    val <- validate_widget_value("button", value, list())
    new_widget("button", label, val)
  },
  date = function(value = Sys.Date(), min = NULL, max = NULL, label = NULL) {
    value <- validate_date_bounds(value, min, max)
    min <- validate_date(min, "`min`", null_ok = TRUE)
    max <- validate_date(max, "`max`", null_ok = TRUE)
    new_widget("date", label, value, list(min = min, max = max))
  },
  date_range = function(value = c(Sys.Date(), Sys.Date()), min = NULL,
                        max = NULL, label = NULL) {
    if (!inherits(value, "Date") || length(value) != 2L || anyNA(value) ||
        value[[1L]] > value[[2L]]) {
      stop("`value` must be a length-two non-decreasing Date vector", call. = FALSE)
    }
    min <- validate_date(min, "`min`", null_ok = TRUE)
    max <- validate_date(max, "`max`", null_ok = TRUE)
    if (!is.null(min) && value[[1L]] < min) stop("`value` is below `min`", call. = FALSE)
    if (!is.null(max) && value[[2L]] > max) stop("`value` exceeds `max`", call. = FALSE)
    new_widget("date_range", label, value, list(min = min, max = max))
  },
  datetime = function(value = NULL, min = NULL, max = NULL, label = NULL) {
    if (is.null(value)) {
      value <- as.POSIXct(floor(as.double(Sys.time())),
                          origin = "1970-01-01", tz = "UTC")
    }
    value <- validate_datetime(value, min, max)
    new_widget("datetime", label, value, list(min = min, max = max))
  },
  code_editor = function(value = "", language = "r", label = NULL) {
    require_scalar_character(language, "`language`")
    if (!(language %in% c("r", "sql", "python", "markdown", "json"))) {
      stop("`language` must be one of r, sql, python, markdown, json", call. = FALSE)
    }
    val <- validate_widget_value("code_editor", value, list())
    new_widget("code_editor", label, val, list(language = language))
  },
  refresh = function(interval = 5, label = "Refresh") {
    interval <- require_finite_double(interval, "`interval`")
    if (interval < 0.5) stop("`interval` must be at least 0.5", call. = FALSE)
    new_widget("refresh", label, 0L, list(interval = interval, paused = FALSE))
  },
  file = function(label = NULL, accept = NULL, multiple = FALSE) {
    if (!is.null(accept)) {
      if (!is.character(accept) || length(accept) == 0L ||
          anyNA(accept) || any(!nzchar(accept))) {
        stop("`accept` must be NULL or a non-empty character vector", call. = FALSE)
      }
    }
    require_scalar_logical(multiple, "`multiple`")
    value <- data.frame(name = character(), size = double(), path = character(),
                        stringsAsFactors = FALSE)
    new_widget("file", label, value, list(accept = accept, multiple = multiple))
  },
  table = function(data, selection = c("multi", "single", "none"),
                   page_size = 25L, label = NULL) {
    if (is.matrix(data)) data <- as.data.frame(data, stringsAsFactors = FALSE)
    validate_data_frame(data, "`data`")
    selection <- match.arg(selection)
    page_size <- require_scalar_integer(page_size, "`page_size`", min = 1L)
    value <- data[FALSE, , drop = FALSE]
    new_widget("table", label, value,
               list(data = data, selection = selection, page_size = page_size,
                    selected = integer(), page = NULL, handle = NULL))
  },
  dataframe = function(data, label = NULL) {
    if (is.matrix(data)) data <- as.data.frame(data, stringsAsFactors = FALSE)
    validate_data_frame(data, "`data`")
    new_widget("dataframe", label, data,
               list(data = data, ops = list(), page = NULL, handle = NULL))
  },
  array = function(...) {
    children <- list(...)
    validate_children(children)
    nms <- names(children)
    if (is.null(nms)) nms <- rep("", length(children))
    for (i in seq_along(nms)) {
      if (!is.na(nms[[i]]) && !nzchar(nms[[i]])) nms[[i]] <- as.character(i)
    }
    if (anyNA(nms) || any(!validUTF8(nms)) || anyDuplicated(nms)) {
      stop("array child names must be non-missing, valid UTF-8, and unique",
           call. = FALSE)
    }
    names(children) <- nms
    new_widget("array", NULL, lapply(children, widget_value),
               list(children = children))
  },
  dictionary = function(...) {
    children <- list(...)
    validate_children(children, dictionary = TRUE)
    new_widget("dictionary", NULL,
               structure(lapply(children, widget_value), names = names(children)),
               list(children = children))
  },
  form = function(child, submit_label = "Submit") {
    if (!is_widget(child)) stop("`child` must be an alder_widget", call. = FALSE)
    require_scalar_character(submit_label, "`submit_label`")
    new_widget("form", NULL, NULL,
               list(child = child, submit_label = submit_label, dirty = FALSE))
  }
)
