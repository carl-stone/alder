# App metadata and gallery presentation helpers.
#
# These functions intentionally operate on the notebook value rather than on a
# Session.  The notebook remains the source of truth for app configuration,
# while title and description are deterministic projections used by gallery
# callers.

ALDER_APP_DEFAULTS <- list(
  layout = "vertical",
  width = "medium",
  include_code = FALSE
)

alder_app_invalid <- function(message) {
  alder_abort("invalid_request", message)
}

alder_app_scalar_choice <- function(value, key, choices) {
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !(value %in% choices)) {
    alder_app_invalid(
      paste0(key, " must be one of ", paste(choices, collapse = ", "))
    )
  }
  value
}

alder_app_scalar_logical <- function(value, key) {
  if (!is.logical(value) || length(value) != 1L || is.na(value)) {
    alder_app_invalid(paste0(key, " must be a scalar logical"))
  }
  isTRUE(value)
}

alder_app_updates <- function(updates) {
  if (!is.list(updates) || !length(updates) || is.null(names(updates)) ||
      anyNA(names(updates)) || any(!nzchar(names(updates))) ||
      anyDuplicated(names(updates))) {
    alder_app_invalid(
      "app updates must be a non-empty named list with unique keys"
    )
  }
  allowed <- names(ALDER_APP_DEFAULTS)
  unknown <- setdiff(names(updates), allowed)
  if (length(unknown)) {
    alder_app_invalid(paste0("unknown app key: ", unknown[[1L]]))
  }

  out <- list()
  if ("layout" %in% names(updates)) {
    out$layout <- alder_app_scalar_choice(
      updates$layout, "layout", c("vertical", "grid", "slides")
    )
  }
  if ("width" %in% names(updates)) {
    out$width <- alder_app_scalar_choice(
      updates$width, "width", c("compact", "medium", "full")
    )
  }
  if ("include_code" %in% names(updates)) {
    out$include_code <- alder_app_scalar_logical(
      updates$include_code, "include_code"
    )
  }
  out
}

alder_app_metadata <- function(nb) {
  metadata <- nb$metadata
  if (is.null(metadata)) metadata <- list()
  if (!is.list(metadata)) {
    alder_app_invalid("notebook metadata must be a named list")
  }
  app <- metadata$app
  if (is.null(app)) return(list())
  if (!is.list(app) || (length(app) && is.null(names(app)))) {
    alder_app_invalid("app metadata must be a named list")
  }
  if (length(app) && (anyNA(names(app)) || any(!nzchar(names(app))) ||
                      anyDuplicated(names(app)))) {
    alder_app_invalid("app metadata keys must be unique and non-empty")
  }
  app
}

# Return the effective app settings.  Missing settings intentionally fall back
# to stable defaults; metadata is not mutated by this accessor.
alder_app_config <- function(nb) {
  app <- alder_app_metadata(nb)
  result <- ALDER_APP_DEFAULTS
  if ("layout" %in% names(app)) {
    result$layout <- alder_app_scalar_choice(
      app$layout, "layout", c("vertical", "grid", "slides")
    )
  }
  if ("width" %in% names(app)) {
    result$width <- alder_app_scalar_choice(
      app$width, "width", c("compact", "medium", "full")
    )
  }
  if ("include_code" %in% names(app)) {
    result$include_code <- alder_app_scalar_logical(
      app$include_code, "include_code"
    )
  }
  result
}

# Apply a partial update while retaining effective values for omitted settings.
# Unknown app metadata fields are retained so changing app settings cannot erase
# metadata written by a newer client.
alder_set_app_config <- function(nb, updates) {
  checked <- alder_app_updates(updates)
  current <- alder_app_config(nb)
  result <- current
  for (key in names(checked)) result[[key]] <- checked[[key]]

  existing <- alder_app_metadata(nb)
  app <- existing
  for (key in names(result)) app[[key]] <- result[[key]]
  nb_set_metadata(nb, "app", app)
}

alder_app_title <- function(nb) {
  metadata <- nb$metadata
  title <- if (is.list(metadata)) metadata$title else NULL
  if (is.character(title) && length(title) == 1L && !is.na(title) &&
      nzchar(trimws(title))) {
    return(title)
  }

  path <- nb$path
  if (is.character(path) && length(path) == 1L && !is.na(path) &&
      nzchar(path)) {
    name <- tools::file_path_sans_ext(basename(path))
    if (nzchar(name)) return(name)
  }
  "Untitled notebook"
}

alder_app_description <- function(nb) {
  cells <- nb$cells
  if (!is.list(cells) || !length(cells)) return("")
  markdown <- NULL
  for (cell in cells) {
    if (is.list(cell) && identical(cell$type, "markdown")) {
      markdown <- cell$body
      break
    }
  }
  if (is.null(markdown) || !length(markdown)) return("")

  lines <- vapply(markdown, function(line) {
    if (!is.character(line) || length(line) != 1L || is.na(line)) return("")
    sub("^\\s*#\\s?", "", line, perl = TRUE)
  }, "")
  text <- paste(lines, collapse = " ")
  text <- trimws(gsub("[[:space:]]+", " ", text, perl = TRUE))
  if (nchar(text, type = "chars") > 240L) {
    text <- substr(text, 1L, 240L)
  }
  text
}
