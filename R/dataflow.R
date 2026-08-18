# Pure dataflow projections for editor and app clients.
#
# These helpers intentionally consume an already materialised Session$state()
# snapshot. They never inspect a live Session, evaluate notebook code, or call
# user supplied methods. State produced by older alder versions is accepted
# where possible (missing fields are represented by deterministic defaults).

# Keep this module usable in isolation during package development: utils.R
# normally provides `%||%`, but dataflow helpers do not need to depend on its
# load order.
.df_or <- function(x, y) if (is.null(x)) y else x

.df_stop <- function(...) {
  stop(paste0(...), call. = FALSE)
}

.df_scalar_chr <- function(x, allow_empty = FALSE) {
  is.character(x) && length(x) == 1L && !is.na(x) &&
    (allow_empty || nzchar(x))
}

.df_chars <- function(x, field, allow_null = TRUE) {
  if (is.null(x)) {
    if (allow_null) return(character())
    .df_stop("dataflow snapshot field `", field, "` is required")
  }
  if (is.character(x)) {
    if (anyNA(x) || any(!nzchar(x))) {
      .df_stop("dataflow snapshot field `", field,
               "` must contain non-empty strings")
    }
    return(unique(as.character(x)))
  }
  # JSON parsed by jsonlite may represent an array as a list of scalar strings.
  if (is.list(x)) {
    vals <- vapply(x, function(v) {
      if (!.df_scalar_chr(v)) return(NA_character_)
      v
    }, character(1))
    if (anyNA(vals)) {
      .df_stop("dataflow snapshot field `", field,
               "` must contain strings")
    }
    return(unique(vals))
  }
  .df_stop("dataflow snapshot field `", field, "` must be a character array")
}

.df_json_value <- function(x, depth = 0L, max_items = 128L) {
  # Return a list(ok, value). The separate flag allows a JSON null value to
  # be distinguished from a value omitted because it is unsafe or too large.
  if (is.null(x)) return(list(ok = TRUE, value = NULL))
  if (depth > 3L || is.object(x)) return(list(ok = FALSE, value = NULL))
  if (is.atomic(x)) {
    n <- length(x)
    if (n > max_items || (n > 0L && anyNA(x))) {
      return(list(ok = FALSE, value = NULL))
    }
    if (is.logical(x) || is.integer(x)) {
      return(list(ok = TRUE, value = unname(as.vector(x))))
    }
    if (is.double(x)) {
      if (n && any(!is.finite(x))) return(list(ok = FALSE, value = NULL))
      return(list(ok = TRUE, value = unname(as.vector(x))))
    }
    if (is.character(x)) {
      if (n && any(nchar(x, type = "bytes") > 4096L)) {
        return(list(ok = FALSE, value = NULL))
      }
      return(list(ok = TRUE, value = unname(as.vector(x))))
    }
    # raw, complex and other atomic vectors are deliberately not sent to a
    # browser without an explicit renderer.
    return(list(ok = FALSE, value = NULL))
  }
  if (is.list(x)) {
    if (length(x) > max_items) return(list(ok = FALSE, value = NULL))
    out <- vector("list", length(x))
    nms <- names(x)
    if (is.null(nms)) nms <- rep("", length(x))
    for (i in seq_along(x)) {
      one <- .df_json_value(x[[i]], depth + 1L, max_items)
      if (!isTRUE(one$ok)) return(list(ok = FALSE, value = NULL))
      out[[i]] <- one$value
    }
    if (length(out) && any(nzchar(nms))) {
      # A JSON object cannot represent a mixture of named and unnamed list
      # entries deterministically; use positional entries in that case.
      if (all(nzchar(nms))) names(out) <- nms
    }
    return(list(ok = TRUE, value = out))
  }
  list(ok = FALSE, value = NULL)
}

.df_classes <- function(x) {
  if (is.null(x)) return(character())
  out <- tryCatch(attr(x, "class", exact = TRUE),
                  error = function(e) NULL)
  if (!is.null(out) && is.character(out) && !anyNA(out)) {
    return(as.character(out))
  }
  if (is.object(x)) return("object")
  typ <- tryCatch(typeof(x), error = function(e) "unknown")
  if (identical(typ, "double")) return("numeric")
  if (identical(typ, "environment")) return("environment")
  if (identical(typ, "closure")) return("function")
  if (!is.null(tryCatch(attr(x, "dim", exact = TRUE),
                        error = function(e) NULL))) return("matrix")
  typ
}

.df_length <- function(x) {
  # Never dispatch an arbitrary length() method from a notebook object.
  if (is.object(x)) return(NULL)
  tryCatch({
    n <- length(x)
    if (length(n) == 1L && is.numeric(n) && is.finite(n) && n >= 0) {
      as.numeric(n)
    } else {
      NULL
    }
  }, error = function(e) NULL)
}

.df_dim <- function(x) {
  d <- if (is.object(x)) {
    tryCatch(attr(x, "dim", exact = TRUE), error = function(e) NULL)
  } else {
    tryCatch(dim(x), error = function(e) NULL)
  }
  if (is.null(d)) return(NULL)
  if (!is.numeric(d) || anyNA(d) || any(!is.finite(d)) || any(d < 0)) {
    return(NULL)
  }
  as.numeric(d)
}

.df_value_summary <- function(x, metadata = NULL) {
  # A caller-provided summary is preferred when the worker already computed a
  # bounded representation. It is accepted only when JSON-safe.
  if (!is.null(metadata)) {
    safe <- .df_json_value(metadata)
    if (isTRUE(safe$ok)) {
      if (.df_scalar_chr(metadata, allow_empty = TRUE)) return(metadata)
      if (is.list(metadata)) return(metadata)
    }
  }
  if (is.null(x)) return("NULL")
  typ <- tryCatch(typeof(x), error = function(e) "unknown")
  cls <- .df_classes(x)
  label <- if (length(cls)) cls[[1L]] else typ
  n <- .df_length(x)
  d <- .df_dim(x)
  shape <- if (length(d)) {
    paste0("[", paste(as.integer(d), collapse = "x"), "]")
  } else if (!is.null(n)) {
    paste0("[", as.integer(n), "]")
  } else {
    ""
  }
  paste0(label, shape)
}

.df_normalize_diagnostics <- function(x, field = "diagnostics") {
  if (is.null(x)) return(list())
  if (!is.list(x)) {
    .df_stop("dataflow snapshot field `", field, "` must be a list")
  }
  # A single diagnostic may be supplied directly as list(level=..., code=...).
  if (length(x) && !is.null(names(x)) &&
      any(names(x) %in% c("level", "code", "message", "source"))) {
    x <- list(x)
  }
  out <- list()
  for (d in x) {
    if (!is.list(d)) {
      .df_stop("dataflow snapshot field `", field,
               "` must contain diagnostic records")
    }
    safe <- .df_json_value(d)
    if (!isTRUE(safe$ok) || !is.list(safe$value)) {
      .df_stop("dataflow snapshot field `", field,
               "` contains an unsafe diagnostic")
    }
    out[[length(out) + 1L]] <- safe$value
  }
  out
}

.df_cell_name <- function(cell) {
  candidate <- cell$name
  if (is.null(candidate) && is.list(cell$options)) {
    candidate <- cell$options$name
  }
  if (.df_scalar_chr(candidate)) candidate else NULL
}

.df_context <- function(snapshot) {
  if (!is.list(snapshot) || is.environment(snapshot)) {
    .df_stop("dataflow snapshot must be a list")
  }
  cells_raw <- snapshot$cells
  if (is.null(cells_raw)) cells_raw <- list()
  if (!is.list(cells_raw)) {
    .df_stop("dataflow snapshot field `cells` must be a list")
  }
  cells <- vector("list", length(cells_raw))
  ids <- character(length(cells_raw))
  for (i in seq_along(cells_raw)) {
    cell <- cells_raw[[i]]
    if (!is.list(cell)) {
      .df_stop("dataflow snapshot cell ", i, " must be a list")
    }
    id <- cell$id
    if (!.df_scalar_chr(id)) {
      .df_stop("dataflow snapshot cell ", i,
               " must have a non-empty character `id`")
    }
    previous <- if (i > 1L) ids[seq_len(i - 1L)] else character()
    if (id %in% previous) {
      .df_stop("dataflow snapshot contains duplicate cell id `", id, "`")
    }
    body <- cell$body
    if (is.null(body)) body <- character()
    if (!is.character(body)) {
      .df_stop("dataflow snapshot cell `", id,
               "` field `body` must be a character array")
    }
    defs <- .df_chars(cell$defs, paste0("cells[", i, "]$defs"))
    refs <- .df_chars(cell$refs, paste0("cells[", i, "]$refs"))
    locals <- .df_chars(cell$locals, paste0("cells[", i, "]$locals"))
    status <- cell$status
    if (!.df_scalar_chr(status)) status <- "idle"
    disabled <- isTRUE(cell$disabled) ||
      (is.list(cell$options) && isTRUE(cell$options$disabled))
    if (disabled && !identical(status, "running")) status <- "disabled"
    cells[[i]] <- list(
      id = id,
      name = .df_cell_name(cell),
      type = if (.df_scalar_chr(cell$type)) cell$type else "code",
      body = as.character(body),
      defs = defs,
      refs = refs,
      locals = locals,
      status = status,
      disabled = disabled,
      diagnostics = .df_normalize_diagnostics(
        cell$diagnostics, paste0("cells[", i, "]$diagnostics")),
      raw = cell
    )
    ids[[i]] <- id
  }
  names(cells) <- ids
  list(snapshot = snapshot, cells = cells, ids = ids)
}

.df_owner_map <- function(ctx) {
  owner <- character()
  for (cell in ctx$cells) {
    for (nm in cell$defs) {
      if (!(nm %in% names(owner))) owner[[nm]] <- cell$id
    }
  }
  owner
}

.df_values_map <- function(snapshot) {
  values <- snapshot$values
  if (is.null(values)) values <- snapshot$value
  if (is.null(values)) return(list())
  if (!is.list(values)) {
    .df_stop("dataflow snapshot field `values` must be a named list")
  }
  nms <- names(values)
  if (is.null(nms) || any(!nzchar(nms))) {
    .df_stop("dataflow snapshot field `values` must be a named list")
  }
  values
}

.df_variable_records <- function(snapshot) {
  vars <- snapshot$variables
  if (is.null(vars)) return(list())
  if (!is.list(vars)) {
    .df_stop("dataflow snapshot field `variables` must be a list")
  }
  if (!length(vars)) return(list())
  # Support a single record supplied without an outer array.
  if (!is.null(names(vars)) && any(names(vars) %in% c("name", "owner", "cell"))) {
    vars <- list(vars)
  }
  out <- list()
  for (i in seq_along(vars)) {
    v <- vars[[i]]
    if (!is.list(v)) {
      .df_stop("dataflow snapshot variable ", i, " must be a list")
    }
    if (is.null(v$name) && !is.null(names(vars)) &&
        nzchar(names(vars)[[i]])) v$name <- names(vars)[[i]]
    if (!.df_scalar_chr(v$name)) {
      .df_stop("dataflow snapshot variable ", i,
               " must have a non-empty character `name`")
    }
    out[[length(out) + 1L]] <- v
  }
  out
}

.df_find_value <- function(var, name, owner, ctx, values_map) {
  if (is.list(var) && "value" %in% names(var)) {
    return(list(found = TRUE, value = var$value))
  }
  if (length(values_map) && name %in% names(values_map)) {
    return(list(found = TRUE, value = values_map[[name]]))
  }
  if (!is.null(owner) && owner %in% names(ctx$cells)) {
    raw <- ctx$cells[[owner]]$raw
    if (is.list(raw$values) && name %in% names(raw$values)) {
      return(list(found = TRUE, value = raw$values[[name]]))
    }
    if ("value" %in% names(raw) && length(ctx$cells[[owner]]$defs) == 1L &&
        identical(ctx$cells[[owner]]$defs[[1L]], name)) {
      return(list(found = TRUE, value = raw$value))
    }
  }
  list(found = FALSE, value = NULL)
}

#' Return a bounded, JSON-safe variables projection.
#'
#' @param snapshot A Session$state()-shaped list.
#' @param include_values Whether safe primitive values should be included.
#' @return A deterministic list of variable records.
#' @noRd
alder_variables <- function(snapshot, include_values = TRUE) {
  if (!is.logical(include_values) || length(include_values) != 1L ||
      is.na(include_values)) {
    .df_stop("`include_values` must be TRUE or FALSE")
  }
  ctx <- .df_context(snapshot)
  owners <- .df_owner_map(ctx)
  raw_vars <- .df_variable_records(snapshot)
  values_map <- .df_values_map(snapshot)

  # Definitions are emitted in notebook order. Explicit worker variables not
  # represented by a definition are appended in lexical order, never in hash
  # or environment order.
  names_order <- character()
  for (cell in ctx$cells) names_order <- c(names_order, cell$defs)
  explicit_names <- vapply(raw_vars, function(v) v$name, character(1))
  names_order <- unique(c(names_order, sort(setdiff(explicit_names, names_order))))
  by_name <- list()
  for (v in raw_vars) by_name[[v$name]] <- v

  out <- list()
  for (name in names_order) {
    v <- if (name %in% names(by_name)) by_name[[name]] else NULL
    owner <- NULL
    if (is.list(v) && .df_scalar_chr(v$owner)) owner <- v$owner
    if (is.null(owner) && is.list(v) && .df_scalar_chr(v$cell)) owner <- v$cell
    if (is.null(owner) && name %in% names(owners)) owner <- owners[[name]]
    if (!is.null(owner) && !(owner %in% ctx$ids)) owner <- NULL

    status <- if (is.list(v) && .df_scalar_chr(v$status)) v$status
      else if (!is.null(owner)) ctx$cells[[owner]]$status else "unbound"
    found <- .df_find_value(v, name, owner, ctx, values_map)
    actual <- if (isTRUE(found$found)) found$value else NULL
    metadata_summary <- if (is.list(v) && "value_summary" %in% names(v)) {
      v$value_summary
    } else if (is.list(v) && "summary" %in% names(v)) {
      v$summary
    } else NULL
    summary <- .df_value_summary(if (isTRUE(found$found)) actual else NULL,
                                 metadata_summary)
    if (!isTRUE(found$found) && is.null(v)) {
      summary <- "unbound"
    } else if (!isTRUE(found$found) && is.list(v)) {
      cls <- if (.df_scalar_chr(v$class)) v$class else NULL
      sz <- if (is.numeric(v$size) && length(v$size) == 1L &&
                is.finite(v$size) && v$size >= 0) as.numeric(v$size) else NULL
      if (is.null(metadata_summary)) {
        summary <- paste0(.df_or(cls, "unbound"),
                          if (!is.null(sz)) paste0(" (", sz, " bytes)") else "")
      }
    }
    rec <- list(
      name = name,
      owner = owner,
      cell = owner,
      status = status,
      value_summary = summary,
      summary = summary
    )
    if (is.list(v) && .df_scalar_chr(v$class)) rec$class <- v$class
    if (is.list(v) && !is.null(v$dim)) {
      d <- .df_dim(v$dim)
      if (!is.null(d)) rec$dim <- d
    }
    if (is.list(v) && is.numeric(v$size) && length(v$size) == 1L &&
        is.finite(v$size) && v$size >= 0) rec$size <- as.numeric(v$size)
    if (is.list(v) && is.logical(v$widget) && length(v$widget) == 1L &&
        !is.na(v$widget)) rec$widget <- isTRUE(v$widget)
    if (isTRUE(include_values) && isTRUE(found$found) &&
        !is.null(owner) && !identical(status, "unbound")) {
      safe <- .df_json_value(actual)
      if (isTRUE(safe$ok)) {
        rec$value <- safe$value
        rec$value_available <- TRUE
      } else {
        rec$value_available <- FALSE
      }
    } else if (isTRUE(include_values) && isTRUE(found$found)) {
      rec$value_available <- FALSE
    }
    out[[length(out) + 1L]] <- rec
  }
  out
}

.df_cycle_nodes <- function(edges, ids) {
  marks <- setNames(integer(length(ids)), ids)
  stack <- character()
  found <- character()
  visit <- function(id) {
    marks[[id]] <<- 1L
    stack <<- c(stack, id)
    for (next_id in .df_or(edges[[id]], character())) {
      if (marks[[next_id]] == 0L) {
        visit(next_id)
      } else if (marks[[next_id]] == 1L) {
        pos <- match(next_id, stack)
        if (!is.na(pos)) found <<- c(found, stack[pos:length(stack)])
      }
    }
    stack <<- stack[-length(stack)]
    marks[[id]] <<- 2L
    invisible()
  }
  for (id in ids) if (marks[[id]] == 0L) visit(id)
  ids[ids %in% unique(found)]
}

.df_normalize_edges <- function(raw, ids) {
  edges <- setNames(lapply(ids, function(x) character()), ids)
  if (is.null(raw)) return(edges)
  add <- function(from, to) {
    if (!.df_scalar_chr(from) || !.df_scalar_chr(to) ||
        !(from %in% ids) || !(to %in% ids)) {
      .df_stop("dataflow snapshot DAG edge references an unknown cell")
    }
    # The existing Session convention stores dependent -> dependencies.
    edges[[to]] <<- unique(c(edges[[to]], from))
  }
  if (is.matrix(raw) && ncol(raw) >= 2L) {
    for (i in seq_len(nrow(raw))) add(raw[i, 1L], raw[i, 2L])
    return(edges)
  }
  if (!is.list(raw)) .df_stop("dataflow snapshot DAG `edges` must be a list")
  nms <- names(raw)
  # Named adjacency map: target/dependent -> source/dependency vector.
  if (!is.null(nms) && any(nzchar(nms))) {
    for (i in seq_along(raw)) {
      to <- nms[[i]]
      deps <- .df_chars(raw[[i]], paste0("dag$edges$", to))
      for (from in deps) add(from, to)
    }
    return(edges)
  }
  # Also accept an array of {from, to} edge records.
  for (i in seq_along(raw)) {
    e <- raw[[i]]
    if (!is.list(e) || !.df_scalar_chr(e$from) || !.df_scalar_chr(e$to)) {
      .df_stop("dataflow snapshot DAG `edges` must be an adjacency map or edge records")
    }
    add(e$from, e$to)
  }
  edges
}

.df_cycle_input <- function(raw, ids) {
  if (is.null(raw)) return(NULL)
  vals <- if (is.character(raw)) raw else {
    if (!is.list(raw)) .df_stop("dataflow snapshot DAG `cycles` must be an array")
    unlist(lapply(raw, function(group) {
      .df_chars(group, "dag$cycles")
    }), use.names = FALSE)
  }
  vals <- unique(as.character(vals))
  unknown <- setdiff(vals, ids)
  if (length(unknown)) .df_stop("dataflow snapshot DAG cycle references an unknown cell")
  ids[ids %in% vals]
}

.df_duplicate_input <- function(raw, ids) {
  if (is.null(raw)) return(list())
  if (!is.list(raw)) .df_stop("dataflow snapshot DAG `duplicates` must be a list")
  out <- list()
  nms <- names(raw)
  if (is.null(nms)) return(out)
  for (i in seq_along(raw)) {
    if (!nzchar(nms[[i]])) next
    vals <- .df_chars(raw[[i]], paste0("dag$duplicates$", nms[[i]]))
    vals <- vals[vals %in% ids]
    if (length(vals)) out[[nms[[i]]]] <- vals
  }
  out
}

#' Return the dependency graph with reverse edges and annotations.
#'
#' Edges use the Session convention: `edges[[dependent]]` lists the cells it
#' depends on. `reverse_edges[[source]]` lists direct dependents.
#' @noRd
alder_dependency_graph <- function(snapshot) {
  ctx <- .df_context(snapshot)
  ids <- ctx$ids
  dag <- snapshot$dag
  if (is.null(dag)) dag <- list()
  if (!is.list(dag)) .df_stop("dataflow snapshot field `dag` must be a list")
  dag_nodes <- dag$nodes
  if (!is.null(dag_nodes)) {
    supplied <- .df_chars(dag_nodes, "dag$nodes")
    if (!identical(supplied, ids)) {
      if (setequal(supplied, ids)) {
        supplied <- ids
      } else {
        .df_stop("dataflow snapshot DAG nodes do not match notebook cells")
      }
    }
  }
  raw_edges <- dag$edges
  if (is.null(raw_edges)) raw_edges <- snapshot$edges
  if (is.null(raw_edges)) {
    # Derive the common case from cell refs and definitions when a minimal
    # hand-built snapshot omits its precomputed DAG.
    owners <- .df_owner_map(ctx)
    raw_edges <- setNames(lapply(ctx$cells, function(cell) {
      unique(unname(owners[cell$refs]))
    }), ids)
    raw_edges <- lapply(raw_edges, function(x) x[!is.na(x) & nzchar(x)])
  }
  edges <- .df_normalize_edges(raw_edges, ids)
  reverse <- setNames(lapply(ids, function(x) character()), ids)
  for (to in ids) {
    for (from in edges[[to]]) reverse[[from]] <- c(reverse[[from]], to)
  }
  reverse <- lapply(reverse, unique)

  raw_cycles <- dag$cycles
  if (is.null(raw_cycles)) raw_cycles <- snapshot$cycles
  cycles <- .df_cycle_input(raw_cycles, ids)
  if (is.null(raw_cycles)) cycles <- .df_cycle_nodes(edges, ids)

  diagnostics <- list()
  for (cell in ctx$cells) {
    for (d in cell$diagnostics) {
      d$cell <- cell$id
      diagnostics[[length(diagnostics) + 1L]] <- d
    }
  }
  if (!is.null(snapshot$diagnostics)) {
    extra <- .df_normalize_diagnostics(snapshot$diagnostics, "diagnostics")
    for (d in extra) diagnostics[[length(diagnostics) + 1L]] <- d
  }
  node_info <- lapply(ctx$cells, function(cell) {
    list(id = cell$id, name = cell$name, type = cell$type,
         status = cell$status, defs = cell$defs, refs = cell$refs,
         diagnostics = cell$diagnostics, cycle = cell$id %in% cycles)
  })
  names(node_info) <- ids
  edge_records <- list()
  for (to in ids) for (from in edges[[to]]) {
    edge_records[[length(edge_records) + 1L]] <- list(from = from, to = to)
  }
  list(
    nodes = ids,
    node_info = node_info,
    edges = edges,
    reverse_edges = reverse,
    edge_records = edge_records,
    cycles = cycles,
    cycle_nodes = cycles,
    diagnostics = diagnostics,
    duplicates = .df_duplicate_input(dag$duplicates, ids),
    topo = if (is.null(snapshot$topo)) NULL else
      .df_chars(snapshot$topo, "topo")
  )
}

.df_headings <- function(body, cell_id) {
  out <- list()
  for (i in seq_along(body)) {
    line <- body[[i]]
    # Markdown cells retain R comment markers in their body. Accept both
    # "# Heading" (compact source form) and "# # Heading" (a literal Markdown
    # heading after the comment marker).
    m <- regexec("^\\s*(#{1,6})\\s+(.+?)\\s*#*\\s*$", line, perl = TRUE)
    mm <- regmatches(line, m)[[1L]]
    if (length(mm) == 3L) {
      hashes <- mm[[2L]]
      text <- trimws(mm[[3L]])
      nested <- regexec("^(#{1,6})\\s+(.+?)\\s*#*\\s*$",
                        text, perl = TRUE)
      nn <- regmatches(text, nested)[[1L]]
      if (length(nn) == 3L) {
        hashes <- nn[[2L]]
        text <- trimws(nn[[3L]])
      }
      out[[length(out) + 1L]] <- list(
        cell = cell_id, level = as.integer(nchar(hashes)),
        text = text, line = as.integer(i - 1L)
      )
    }
  }
  out
}

#' Return a document-order outline of named cells and Markdown headings.
#' @noRd
alder_outline <- function(snapshot) {
  ctx <- .df_context(snapshot)
  unname(lapply(ctx$cells, function(cell) {
    list(
      id = cell$id,
      name = cell$name,
      label = .df_or(cell$name, cell$id),
      type = cell$type,
      status = cell$status,
      defs = cell$defs,
      headings = if (identical(cell$type, "markdown"))
        .df_headings(cell$body, cell$id) else list(),
      diagnostics = cell$diagnostics
    )
  }))
}

.df_source_tokens <- function(line, line_no) {
  chars <- if (nzchar(line)) strsplit(line, "", fixed = TRUE)[[1L]] else character()
  n <- length(chars)
  out <- list()
  i <- 1L
  quote <- NULL
  while (i <= n) {
    ch <- chars[[i]]
    if (!is.null(quote)) {
      if (ch == "\\") {
        i <- min(n + 1L, i + 2L)
      } else if (ch == quote) {
        quote <- NULL
        i <- i + 1L
      } else {
        i <- i + 1L
      }
      next
    }
    if (ch == "#") break
    if (ch %in% c("'", "\"", "`")) {
      quote <- ch
      i <- i + 1L
      next
    }
    if (grepl("^[A-Za-z_.]$", ch)) {
      start <- i
      i <- i + 1L
      while (i <= n && grepl("^[A-Za-z0-9_.]$", chars[[i]])) i <- i + 1L
      token <- paste0(chars[start:(i - 1L)], collapse = "")
      if (token != "." && token != "...") {
        out[[length(out) + 1L]] <- list(
          name = token, start = as.integer(start - 1L),
          end = as.integer(i - 1L), line = as.integer(line_no)
        )
      }
      next
    }
    i <- i + 1L
  }
  out
}
.df_token_lhs <- function(line, token) {
  chars <- if (nzchar(line)) strsplit(line, "", fixed = TRUE)[[1L]] else character()
  n <- length(chars)
  if (token$end < n) {
    rest <- paste0(chars[(token$end + 1L):n], collapse = "")
    if (grepl("^\\s*(<<-|<-|=)", rest, perl = TRUE)) return(TRUE)
  }
  if (token$start > 0L) {
    before <- paste0(chars[seq_len(token$start)], collapse = "")
    if (grepl("(->>|->)\\s*$", before, perl = TRUE)) return(TRUE)
  }
  FALSE
}

#' Return zero-based source token ranges for reactive references.
#'
#' Each record has `start`/`end` LSP-style positions, a `kind` of
#' `reference` or `definition`, and `target`/`owner` when the token resolves
#' to a notebook cell. Unresolved references are retained with NULL targets
#' so callers can render diagnostics without re-scanning source.
#' @noRd
alder_reactive_ranges <- function(snapshot, cell_id) {
  if (!.df_scalar_chr(cell_id)) .df_stop("`cell_id` must be a non-empty string")
  ctx <- .df_context(snapshot)
  if (!(cell_id %in% ctx$ids)) {
    .df_stop("dataflow snapshot has no cell `", cell_id, "`")
  }
  cell <- ctx$cells[[cell_id]]
  owners <- .df_owner_map(ctx)
  refs <- cell$refs
  defs <- cell$defs
  out <- list()
  for (line_no in seq_along(cell$body)) {
    line <- cell$body[[line_no]]
    tokens <- .df_source_tokens(line, line_no - 1L)
    for (tok in tokens) {
      # `$field` and `@field` are object members, not notebook references.
      prefix <- if (tok$start > 0L) {
        chars <- strsplit(line, "", fixed = TRUE)[[1L]]
        chars[[tok$start]]
      } else ""
      if (prefix %in% c("$", "@")) next
      is_def <- tok$name %in% defs && .df_token_lhs(line, tok)
      is_ref <- tok$name %in% refs
      if (!is_def && !is_ref) next
      target <- if (is_def) cell_id else
        if (tok$name %in% names(owners)) unname(owners[[tok$name]]) else NULL
      if (length(target) == 0L) target <- NULL
      kind <- if (is_def) "definition" else "reference"
      pos_start <- list(line = tok$line, character = tok$start)
      pos_end <- list(line = tok$line, character = tok$end)
      out[[length(out) + 1L]] <- list(
        name = tok$name,
        kind = kind,
        start = pos_start,
        end = pos_end,
        # Flat aliases make the records convenient for CodeMirror clients and
        # preserve the same zero-based convention as the LSP bridge.
        line = tok$line,
        character = tok$start,
        end_line = tok$line,
        end_character = tok$end,
        owner = target,
        target = target,
        target_cell = target
      )
    }
  }
  out
}

#' Build all editor-facing dataflow projections from one state snapshot.
#' @noRd
alder_dataflow_state <- function(snapshot, include_values = TRUE) {
  # Validate once before projecting; each public helper repeats validation so
  # they remain independently safe when called by a route.
  .df_context(snapshot)
  graph <- alder_dependency_graph(snapshot)
  list(
    variables = alder_variables(snapshot, include_values = include_values),
    dag = graph,
    outline = alder_outline(snapshot)
  )
}
