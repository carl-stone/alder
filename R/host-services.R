# Pure services for the application host. Source records remain R-owned; the
# host holds the immutable bytes and identities and owns all revision decisions.
ALDER_HOST_MAX_CELLS <- 10000L

alder_host_apply_library_policy <- function() {
  sandbox <- Sys.getenv("ALDER_SANDBOX_LIB", unset = "")
  project <- Sys.getenv("ALDER_PROJECT_LIB", unset = "")
  Sys.unsetenv(c("ALDER_SANDBOX_LIB", "ALDER_PROJECT_LIB"))
  result <- list(mode = "inherited", sandbox = NULL, project = NULL)
  if (nzchar(sandbox)) {
    if (!dir.exists(sandbox) || file.access(sandbox, 4L) != 0L) {
      stop("ALDER_SANDBOX_LIB is invalid: '", sandbox,
           "' (must be an existing readable directory)", call. = FALSE)
    }
    sandbox <- normalizePath(sandbox, mustWork = TRUE)
    isolated <- c(sandbox, .Library)
    if ("include.site" %in% names(formals(.libPaths))) {
      .libPaths(isolated, include.site = FALSE)
    } else {
      # Compatibility with R releases predating include.site: .libPaths()
      # stores its resolved search path in this unlocked base binding.
      assign(".lib.loc", unique(normalizePath(isolated, "/")),
             envir = environment(.libPaths))
    }
    result$mode <- "sandbox"
    result$sandbox <- sandbox
  } else if (nzchar(project) && dir.exists(project)) {
    project <- normalizePath(project, mustWork = TRUE)
    .libPaths(c(project, .libPaths()))
    result$mode <- "project"
    result$project <- project
  }
  invisible(result)
}

alder_host_decode <- local({
  cached_key <- NULL
  cached_nb <- NULL
  function(payload) {
    # R copy-on-modify keeps callers' reconciled notebooks independent. Retain
    # only one immutable disk version, so typing does not reparse every cell.
    key <- list(path = payload[["path"]], bytes = payload[["bytes"]],
                ids = payload[["ids"]])
    if (identical(key, cached_key)) return(cached_nb)
    bytes <- base64enc::base64decode(payload[["bytes"]] %||% "")
    if (any(bytes == as.raw(0L))) alder_abort("invalid_source", "source contains NUL")
    text <- rawToChar(bytes)
    if (!validUTF8(text)) alder_abort("invalid_source", "source is not UTF-8")
    nb <- parse_records(payload[["path"]] %||% NA_character_, split_records(text))
    if (length(nb$cells) > ALDER_HOST_MAX_CELLS) {
      alder_abort("invalid_request", "notebook exceeds 10000 cell limit")
    }
    ids <- payload[["ids"]]
    if (!is.null(ids)) {
      ids <- unlist(ids, use.names = FALSE)
      if (length(ids) != length(nb$cells) || anyNA(ids) ||
          any(!nzchar(ids)) || anyDuplicated(ids)) {
        alder_abort("invalid_request", "codec identities do not match source")
      }
      for (i in seq_along(ids)) nb$cells[[i]]$id <- ids[[i]]
    }
    cached_key <<- key
    cached_nb <<- nb
    nb
  }
})

alder_host_encode_source_line <- function(line) {
  if (!nzchar(line)) "" else base64enc::base64encode(charToRaw(enc2utf8(line)))
}

alder_host_decode_encoded_source <- function(encoded, error_message) {
  invalid <- function() stop(error_message, call. = FALSE)
  if (!is.character(encoded) || length(encoded) != 1L || is.na(encoded) ||
      nchar(encoded, type = "bytes") > 44739244L) invalid()
  bytes <- tryCatch(suppressWarnings(base64enc::base64decode(encoded)),
                    error = function(error) NULL)
  canonical <- if (is.null(bytes)) NULL else if (!length(bytes)) "" else
    base64enc::base64encode(bytes)
  if (is.null(bytes) || !identical(canonical, encoded) ||
      length(bytes) > 32L * 1024L * 1024L || any(bytes == as.raw(0L))) {
    invalid()
  }
  source <- rawToChar(bytes)
  if (!validUTF8(source)) invalid()
  source
}

alder_host_decode_source <- function(value, encoded_field, plain_field,
                                     label = "source") {
  encoded <- value[[encoded_field]]
  plain <- value[[plain_field]]
  if (is.null(encoded)) return(plain)
  if (!is.null(plain)) stop("invalid ", label, " encoding", call. = FALSE)
  alder_host_decode_encoded_source(encoded,
                                   paste0("invalid ", label, " encoding"))
}

alder_host_snapshot <- function(nb, compact = FALSE) {
  cells <- unname(lapply(nb$cells, function(cell) {
    result <- list(
      id = cell$id, type = cell$type,
      options = if (length(cell$options)) cell$options else setNames(list(), character()),
      revision = 0L
    )
    if (isTRUE(compact)) {
      result$body_base64 <- I(vapply(cell$body,
        alder_host_encode_source_line, ""))
    } else {
      result$body <- I(cell$body)
    }
    result
  }))
  result <- list(
    path = if (is.na(nb$path)) NULL else nb$path,
    metadata = if (length(nb$metadata)) nb$metadata else setNames(list(), character()),
    cells = cells
  )
  if (isTRUE(compact)) result$encoding <- "base64-lines-v1"
  result
}

alder_host_compact_record <- function(record) {
  list(text_base64 = alder_host_encode_source_line(record$text),
       eol = record$eol, kind = record$kind)
}

alder_host_document <- function(nb, compact = FALSE) {
  if (!isTRUE(compact)) {
    return(list(
      path = if (is.na(nb$path)) NULL else nb$path,
      text = serialize_notebook(nb), headerRecords = nb$header_records,
      cells = unname(lapply(nb$cells, function(cell) {
        list(id = cell$id, type = cell$type, body = I(cell$body),
             records = cell$records)
      }))
    ))
  }
  list(
    encoding = "base64-lines-v1",
    path = if (is.na(nb$path)) NULL else nb$path,
    headerRecords = unname(lapply(nb$header_records, alder_host_compact_record)),
    cells = unname(lapply(nb$cells, function(cell) {
      list(id = cell$id, type = cell$type,
           records = unname(lapply(cell$records, alder_host_compact_record)))
    }))
  )
}

alder_host_cell_body <- function(cell) {
  encoded <- cell[["body_base64"]]
  if (!is.null(encoded)) {
    if (!is.null(cell[["body"]]) || !is.list(encoded)) {
      alder_abort("invalid_request", "encoded cell body must be an array")
    }
    body <- vapply(encoded, function(line) {
      value <- tryCatch(alder_host_decode_encoded_source(
        line, "encoded source line is invalid"), error = function(error) {
          alder_abort("invalid_request", conditionMessage(error))
        })
      if (nchar(value, type = "chars") > 1048576L ||
          grepl("[\r\n]", value)) {
        alder_abort("invalid_request", "encoded source line is invalid")
      }
      value
    }, "")
  } else {
    body <- unlist(cell[["body"]], use.names = FALSE) %||% character()
  }
  if (!is.character(body) || anyNA(body) || any(grepl("[\r\n]", body))) {
    alder_abort("invalid_request", "cell body must contain individual lines")
  }
  body
}

alder_host_reconcile <- function(payload) {
  nb <- alder_host_decode(payload)
  cells <- payload[["cells"]]
  if (!is.list(cells)) alder_abort("invalid_request", "cells must be an array")
  if (length(cells) > ALDER_HOST_MAX_CELLS) {
    alder_abort("invalid_request", "notebook exceeds 10000 cell limit")
  }
  ids <- vapply(cells, function(cell) {
    id <- cell[["id"]]
    if (!is.character(id) || length(id) != 1L || is.na(id) || !nzchar(id)) {
      alder_abort("invalid_request", "cell identity must be a nonempty string")
    }
    id
  }, "")
  if (anyDuplicated(ids)) alder_abort("invalid_request", "duplicate cell identity")
  old_ids <- vapply(nb$cells, function(cell) cell$id, "")
  for (id in setdiff(old_ids, ids)) nb <- nb_delete_cell(nb, id)
  positions <- setNames(seq_along(nb$cells),
                         vapply(nb$cells, function(cell) cell$id, ""))
  after <- NULL
  target <- 0L
  source_bytes <- 0
  for (cell in cells) {
    target <- target + 1L
    body <- alder_host_cell_body(cell)
    source_bytes <- source_bytes + sum(nchar(body, type = "bytes")) +
      max(0L, length(body) - 1L)
    if (source_bytes > 32 * 1024 * 1024) {
      alder_abort("invalid_source", "notebook exceeds 32 MiB source limit")
    }
    position <- unname(positions[cell[["id"]]])
    old <- if (is.na(position)) NULL else nb$cells[[position]]
    if (is.null(old)) {
      nb <- nb_add_cell(nb, body, cell[["type"]])
      position <- length(nb$cells)
      nb$cells[[position]]$id <- cell[["id"]]
      positions[cell[["id"]]] <- position
    } else if (!identical(body, old$body) ||
               !identical(cell[["type"]], old$type)) {
      nb <- nb_update_cell(nb, cell[["id"]], body, cell[["type"]])
    }
    current <- nb$cells[[position]]
    options <- cell[["options"]] %||% list()
    for (key in union(names(current$options), names(options))) {
      if (!identical(current$options[[key]], options[[key]])) {
        nb <- nb_set_cell_option(nb, cell[["id"]], key, options[[key]])
      }
    }
    # The preceding cells already occupy their final positions. Rebuild the
    # identity index only after a real move, keeping ordinary edits linear.
    if (position != target) {
      nb <- nb_move_cell(nb, cell[["id"]], after)
      positions <- setNames(seq_along(nb$cells),
                             vapply(nb$cells, function(value) value$id, ""))
    }
    after <- cell[["id"]]
  }
  if (!is.null(payload[["metadata"]])) {
    for (key in union(names(nb$metadata), names(payload[["metadata"]]))) {
      if (!identical(nb$metadata[[key]], payload[["metadata"]][[key]])) {
        nb <- nb_set_metadata(nb, key, payload[["metadata"]][[key]])
      }
    }
  }
  nb
}

alder_host_service <- function(command, payload = list()) {
  switch(command,
    codec.decode = {
      nb <- alder_host_decode(payload)
      list(notebook = alder_host_snapshot(nb, isTRUE(payload[["compact"]])))
    },
    codec.encode = {
      nb <- alder_host_reconcile(payload)
      list(bytes = base64enc::base64encode(charToRaw(serialize_notebook(nb))),
           ids = I(vapply(nb$cells, function(cell) cell$id, "")))
    },
    codec.document = {
      nb <- alder_host_reconcile(payload)
      alder_host_document(nb, isTRUE(payload[["compact"]]))
    },
    config.resolve = resolve_alder_config(payload[["path"]], payload[["metadata"]]),
    app.validate = alder_app_updates(payload[["app"]]),
    config.validate = validate_config_layer(payload[["config"]], partial = FALSE),
    config.encode = {
      checked <- validate_config_layer(payload[["config"]], partial = FALSE)
      list(config = checked, text = yaml::as.yaml(checked))
    },
    layout.validate = alder_layout_validate(payload[["layout"]]),
    layout.encode = {
      checked <- alder_layout_validate(payload[["layout"]])
      list(layout = checked, text = paste0(layout_json(checked), "\n"))
    },
    layout.read = alder_layout_read(payload[["path"]]),
    markdown.render = render_markdown_cell_output(
      unlist(payload[["body"]], use.names = FALSE) %||% character()),
    help.render = lsp_hover_html(payload[["contents"]]),
    format = {
      nb <- alder_host_reconcile(payload)
      identities <- vapply(nb$cells, function(cell) cell$id, "")
      canonical <- paste0("cell-", seq_along(nb$cells))
      for (i in seq_along(nb$cells)) nb$cells[[i]]$id <- canonical[[i]]
      selected <- if (is.null(payload[["cell"]])) NULL else {
        index <- match(payload[["cell"]], identities)
        if (is.na(index)) alder_abort("not_found", "format cell does not exist")
        canonical[[index]]
      }
      value <- format_notebook_source(nb, selected)
      names(value$bodies) <- identities[match(names(value$bodies), canonical)]
      lapply(value$bodies, I)
    },
    graph = {
      nb <- alder_host_reconcile(payload)
      analyzed <- export_analysis(nb)
      topo <- topo_order(analyzed$dag$edges,
                          vapply(nb$cells, function(cell) cell$id, ""))
      list(edges = lapply(analyzed$dag$edges, I),
           duplicates = lapply(analyzed$dag$duplicates, I),
           cycles = I(analyzed$dag$cycles),
           topo = if (is.null(topo)) NULL else I(topo))
    },
    alder_abort("invalid_request", paste("unknown host service:", command))
  )
}
