# Source formatting helpers shared by the HTTP route and tests.

format_notebook_source <- function(nb, cell = NULL) {
  if (!is.null(cell) &&
      (!is.character(cell) || length(cell) != 1L || is.na(cell) ||
       !nzchar(cell))) {
    alder_abort("invalid_request", "cell must be a nonempty string")
  }
  ids <- vapply(nb$cells, function(value) value$id, "")
  if (!is.null(cell) && !cell %in% ids) {
    alder_abort("not_found", paste("no such cell:", cell))
  }

  tmp <- tempfile("alder-format-", fileext = ".R")
  on.exit(unlink(tmp, force = TRUE), add = TRUE)
  writeBin(charToRaw(serialize_notebook(nb)), tmp)

  air <- Sys.which("air")
  if (nzchar(air)) {
    air_error <- NULL
    result <- tryCatch(
      processx::run(air, c("format", tmp), error_on_status = FALSE),
      error = function(error) {
        air_error <<- conditionMessage(error)
        NULL
      }
    )
    if (is.null(result) || !identical(as.integer(result$status), 0L)) {
      detail <- if (!is.null(air_error)) {
        air_error
      } else {
        text <- trimws(paste(c(result$stdout, result$stderr), collapse = "\n"))
        if (nzchar(text)) text else paste0("exit status ", result$status)
      }
      alder_abort("format_failed", paste0(
        "air could not format the notebook: ", detail
      ))
    }
  } else if (requireNamespace("styler", quietly = TRUE)) {
    tryCatch(
      writeLines(
        as.character(styler::style_text(readLines(tmp, warn = FALSE))),
        tmp,
        useBytes = TRUE
      ),
      error = function(e) alder_abort("format_failed", conditionMessage(e))
    )
  } else {
    alder_abort("format_unavailable",
                "formatting requires air or the styler package")
  }

  parse_error <- NULL
  formatted <- tryCatch(
    read_notebook(tmp),
    error = function(error) {
      parse_error <<- conditionMessage(error)
      NULL
    }
  )
  formatted_ids <- if (!is.null(formatted)) {
    vapply(formatted$cells, function(value) value$id, "")
  } else {
    character()
  }
  if (is.null(formatted) || !identical(ids, formatted_ids) ||
      !identical(vapply(nb$cells, function(value) value$type, ""),
                 vapply(formatted$cells, function(value) value$type, ""))) {
    detail <- if (!is.null(parse_error)) {
      paste0("formatter produced an invalid notebook: ", parse_error)
    } else {
      "formatter changed notebook cell order or cell types"
    }
    alder_abort("format_failed", detail)
  }

  selected <- if (is.null(cell)) ids else cell
  bodies <- lapply(selected, function(id) nb_cell(formatted, id)$body)
  names(bodies) <- selected
  list(bodies = bodies, notebook = formatted)
}
