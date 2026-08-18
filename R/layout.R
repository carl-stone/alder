# Pure app-layout and gallery helpers.
#
# Layouts are persisted next to a notebook as <notebook>.alder-layout.json.

LAYOUT_VERSION <- 1L
LAYOUT_GRID_COLUMNS <- 12L
LAYOUT_MAX_ROW <- 1000000L
LAYOUT_MAX_HEIGHT <- 1000000L
LAYOUT_MAX_BYTES <- 1024L * 1024L

layout_abort <- function(message) {
  if (exists("alder_abort", mode = "function", inherits = TRUE)) {
    alder_abort("invalid_layout", message)
  }
  cond <- structure(
    list(message = message, code = "invalid_layout", call = NULL),
    class = c("alder_error", "error", "condition")
  )
  stop(cond)
}

layout_sidecar_path <- function(path) {
  if (inherits(path, "alder_notebook")) path <- path$path
  if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path)) {
    layout_abort("layout path must be a non-empty scalar path")
  }
  nul <- rawToChar(as.raw(0))
  if (nzchar(nul) && grepl(nul, path, fixed = TRUE)) {
    layout_abort("layout path contains an embedded NUL")
  }
  if (grepl("\\.alder-layout\\.json$", path, perl = TRUE)) path
  else paste0(path, ".alder-layout.json")
}

layout_scalar <- function(x, field) {
  if (is.list(x)) {
    if (length(x) != 1L) layout_abort(paste0(field, " must be a scalar"))
    x <- x[[1L]]
  }
  if (length(x) != 1L || is.na(x)) layout_abort(paste0(field, " must be a scalar"))
  x
}

layout_key_valid <- function(key, field = "cell key") {
  if (!is.character(key) || length(key) != 1L || is.na(key) || !nzchar(key)) {
    layout_abort(paste0(field, " must be a non-empty string"))
  }
  if (grepl("/", key, fixed = TRUE) ||
      grepl(rawToChar(as.raw(92)), key, fixed = TRUE) ||
      (nzchar(rawToChar(as.raw(0))) &&
       grepl(rawToChar(as.raw(0)), key, fixed = TRUE)) ||
      key %in% c(".", "..")) {
    layout_abort(paste0(field, " contains traversal or a path separator"))
  }
  invisible(TRUE)
}

layout_integer <- function(x, field, lower, upper) {
  x <- layout_scalar(x, field)
  if (!is.numeric(x) || !is.finite(x) || x != floor(x) ||
      x < lower || x > upper) {
    layout_abort(paste0(field, " must be a finite integer in [", lower,
                        ", ", upper, "]"))
  }
  as.integer(x)
}

layout_geometry <- function(value, key) {
  if (!is.list(value) || is.null(names(value)) || anyDuplicated(names(value))) {
    layout_abort(paste0("geometry for ", key, " must be an object"))
  }
  required <- c("x", "y", "w", "h")
  if (!all(required %in% names(value)) || !all(names(value) %in% required)) {
    layout_abort(paste0("geometry for ", key, " must contain only x, y, w, h"))
  }
  x <- layout_integer(value$x, paste0(key, ".x"), 0L, LAYOUT_GRID_COLUMNS - 1L)
  y <- layout_integer(value$y, paste0(key, ".y"), 0L, LAYOUT_MAX_ROW)
  w <- layout_integer(value$w, paste0(key, ".w"), 1L, LAYOUT_GRID_COLUMNS)
  h <- layout_integer(value$h, paste0(key, ".h"), 1L, LAYOUT_MAX_HEIGHT)
  if (x + w > LAYOUT_GRID_COLUMNS) {
    layout_abort(paste0("geometry for ", key, " extends beyond the 12-column grid"))
  }
  list(x = x, y = y, w = w, h = h)
}

layout_slide_group <- function(group, index) {
  title <- NULL
  if (is.list(group) && is.null(names(group))) {
    group <- unlist(group, use.names = FALSE)
  }
  if (is.list(group) && !is.null(names(group))) {
    valid_names <- identical(names(group), "cells") ||
      identical(sort(names(group)), c("cells", "title"))
    if (!valid_names) layout_abort(paste0("slides[[", index,"]] must be an array of cell keys"))
    if (is.null(group$cells)) layout_abort(paste0("slides[[", index,"]] has no cells"))
    if ("title" %in% names(group)) {
      title <- layout_scalar(group$title, paste0("slides[[", index, "]].title"))
      if (!is.character(title) || !nzchar(title)) {
        layout_abort(paste0("slides[[", index, "]].title must be a string"))
      }
    }
    group <- group$cells
  }
  if (is.list(group) && is.null(names(group))) {
    group <- unlist(group, use.names = FALSE)
  }
  if (!is.character(group) || !length(group) || anyNA(group)) {
    layout_abort(paste0("slides[[", index, "]] must be a non-empty array"))
  }
  keys <- as.character(group)
  for (key in keys) layout_key_valid(key, paste0("slides[[", index, "]] key"))
  if (anyDuplicated(keys)) layout_abort(paste0("slides[[", index, "]] contains duplicate cell keys"))
  if (is.null(title)) keys else list(cells = keys, title = title)
}

layout_normalize_slides <- function(slides) {
  if (is.null(slides)) return(NULL)
  if (is.character(slides)) slides <- list(slides)
  if (!is.list(slides)) layout_abort("slides must be an array of groups")
  if (!length(slides)) return(list())
  groups <- lapply(seq_along(slides), function(i) layout_slide_group(slides[[i]], i))
  members <- unlist(lapply(groups, function(g) if (is.list(g)) g$cells else g),
                    use.names = FALSE)
  if (anyDuplicated(members)) layout_abort("a cell key occurs in more than one slide")
  groups
}

# Validate and canonicalize a layout sidecar. `layout` is optional for
# compatibility with the original grid-only sidecar; absent means grid.
alder_layout_validate <- function(layout) {
  if (!is.list(layout) || is.null(names(layout)) || anyDuplicated(names(layout))) {
    layout_abort("layout must be a JSON object with unique fields")
  }
  allowed <- c("version", "layout", "cells", "slides")
  unknown <- setdiff(names(layout), allowed)
  if (length(unknown)) layout_abort(paste0("unknown layout field: ", unknown[[1L]]))
  version <- if ("version" %in% names(layout)) {
    layout_integer(layout$version, "version", LAYOUT_VERSION, LAYOUT_VERSION)
  } else {
    LAYOUT_VERSION
  }
  mode_present <- "layout" %in% names(layout)
  mode <- if (mode_present) {
    mode <- layout_scalar(layout$layout, "layout")
    if (!is.character(mode) || !mode %in% c("grid", "slides")) {
      layout_abort("layout must be \"grid\" or \"slides\"")
    }
    mode
  } else "grid"
  cells <- layout$cells
  if (is.null(cells)) cells <- structure(list(), names = character())
  if (!is.list(cells)) layout_abort("cells must be an object")
  cell_names <- names(cells)
  if (length(cells) && (is.null(cell_names) || anyNA(cell_names) || anyDuplicated(cell_names))) {
    layout_abort("cells must be an object with unique keys")
  }
  if (is.null(cell_names)) cell_names <- character()
  for (key in cell_names) layout_key_valid(key, "cells key")
  cells <- cells[order(cell_names, method = "radix")]
  if (length(cells)) {
    names(cells) <- sort(cell_names, method = "radix")
    cells <- Map(layout_geometry, cells, names(cells))
    names(cells) <- sort(cell_names, method = "radix")
  } else {
    cells <- structure(list(), names = character())
  }
  slides_present <- "slides" %in% names(layout)
  slides <- if (slides_present) layout_normalize_slides(layout$slides) else NULL
  out <- list(version = version, cells = cells)
  if (mode_present) out$layout <- mode
  if (slides_present) out$slides <- slides
  out
}

alder_layout_read <- function(path) {
  sidecar <- layout_sidecar_path(path)
  if (!file.exists(sidecar)) return(NULL)
  if (dir.exists(sidecar) || file.access(sidecar, 4L) != 0L) {
    layout_abort(paste0("layout sidecar is not readable: ", sidecar))
  }
  size <- file.info(sidecar)$size
  if (is.na(size) || size > LAYOUT_MAX_BYTES) layout_abort("layout sidecar exceeds the 1 MiB safety limit")
  text <- tryCatch(
    paste(readLines(sidecar, warn = FALSE, encoding = "UTF-8"), collapse = "\n"),
    error = function(e) layout_abort(paste0("cannot read layout sidecar: ", conditionMessage(e)))
  )
  parsed <- tryCatch(
    jsonlite::fromJSON(text, simplifyVector = FALSE),
    error = function(e) layout_abort(paste0("invalid layout JSON: ", conditionMessage(e)))
  )
  alder_layout_validate(parsed)
}

layout_json_scalar <- function(value) {
  as.character(jsonlite::toJSON(value, auto_unbox = TRUE, null = "null",
                                digits = 15, pretty = FALSE))
}

layout_json_array <- function(values) {
  as.character(jsonlite::toJSON(unname(as.character(values)),
                                auto_unbox = FALSE, null = "null",
                                digits = 15, pretty = FALSE))
}

layout_json_geometry <- function(value) {
  paste0("{\"x\":", layout_json_scalar(value$x),
         ",\"y\":", layout_json_scalar(value$y),
         ",\"w\":", layout_json_scalar(value$w),
         ",\"h\":", layout_json_scalar(value$h), "}")
}

layout_json <- function(layout) {
  cell_json <- if (!length(layout$cells)) {
    "{}"
  } else {
    paste0(
      "{",
      paste(vapply(names(layout$cells), function(key) {
        paste0(layout_json_scalar(key), ":",
               layout_json_geometry(layout$cells[[key]]))
      }, ""), collapse = ","),
      "}"
    )
  }
  fields <- c(paste0("\"version\":", layout_json_scalar(layout$version)),
              paste0("\"cells\":", cell_json))
  if ("layout" %in% names(layout)) {
    fields <- c(fields, paste0("\"layout\":", layout_json_scalar(layout$layout)))
  }
  if ("slides" %in% names(layout)) {
    groups <- vapply(layout$slides, function(group) {
      if (is.list(group)) {
        paste0("{\"cells\":", layout_json_array(group$cells),
               ",\"title\":", layout_json_scalar(group$title), "}")
      } else {
        layout_json_array(group)
      }
    }, "")
    slides_json <- if (length(groups)) paste0("[", paste(groups, collapse = ","), "]") else "[]"
    fields <- c(fields, paste0("\"slides\":", slides_json))
  }
  paste0("{", paste(fields, collapse = ","), "}")
}

 
alder_layout_write <- function(path, layout) {
  sidecar <- layout_sidecar_path(path)
  checked <- alder_layout_validate(layout)
  parent <- dirname(sidecar)
  if (!dir.exists(parent)) layout_abort(paste0("layout directory does not exist: ", parent))
  if (file.access(parent, 2L) != 0L) layout_abort(paste0("layout directory is not writable: ", parent))
  text <- paste0(layout_json(checked), "\n")
  tmp <- tempfile(pattern = ".alder-layout-", tmpdir = parent)
  on.exit(unlink(tmp), add = TRUE)
  con <- file(tmp, open = "wb")
  on.exit(tryCatch(close(con), error = function(e) NULL), add = TRUE)
  writeBin(charToRaw(text), con)
  flush(con)
  close(con)
  # Same-directory rename is atomic on supported POSIX platforms.
  if (!file.rename(tmp, sidecar)) layout_abort(paste0("cannot atomically replace layout sidecar: ", sidecar))
  invisible(checked)
}

layout_notebook <- function(notebook) {
  if (inherits(notebook, "alder_notebook")) return(notebook)
  if (is.character(notebook) && length(notebook) == 1L && !is.na(notebook)) {
    if (!exists("read_notebook", mode = "function", inherits = TRUE)) layout_abort("notebook parser is unavailable")
    return(tryCatch(read_notebook(notebook), error = function(e) layout_abort(conditionMessage(e))))
  }
  if (is.list(notebook) && is.list(notebook$cells)) return(notebook)
  layout_abort("notebook must be a parsed notebook or a path")
}

layout_cell_keys <- function(notebook) {
  nb <- layout_notebook(notebook)
  cells <- nb$cells
  if (!length(cells)) return(character())
  ids <- vapply(cells, function(cell) {
    id <- cell$id
    if (is.character(id) && length(id) == 1L && !is.na(id) && nzchar(id)) id else ""
  }, "")
  names <- vapply(cells, function(cell) {
    value <- if (is.list(cell$options)) cell$options$name else NULL
    if (is.character(value) && length(value) == 1L && !is.na(value) && nzchar(value) &&
        grepl("^[A-Za-z][A-Za-z0-9_.]*$", value, perl = TRUE)) value else ""
  }, "")
  usable <- nzchar(names) & !duplicated(names) & !duplicated(names, fromLast = TRUE)
  keys <- ids
  keys[usable] <- names[usable]
  for (key in keys) layout_key_valid(key, "notebook cell key")
  if (anyDuplicated(keys)) {
    dup <- duplicated(keys) | duplicated(keys, fromLast = TRUE)
    keys[dup] <- paste0("cell-", seq_along(keys)[dup])
  }
  keys
}

layout_rect_overlap <- function(a, b) {
  a$x < b$x + b$w && a$x + a$w > b$x && a$y < b$y + b$h && a$y + a$h > b$y
}

alder_grid_positions <- function(notebook, layout = NULL) {
  nb <- layout_notebook(notebook)
  keys <- layout_cell_keys(nb)
  checked <- if (is.null(layout)) NULL else alder_layout_validate(layout)
  persisted <- if (is.null(checked)) list() else checked$cells
  out <- vector("list", length(keys))
  names(out) <- keys
  occupied <- list()
  for (i in seq_along(keys)) {
    key <- keys[[i]]
    if (length(persisted) && key %in% names(persisted)) {
      out[[i]] <- persisted[[key]]
      occupied[[length(occupied) + 1L]] <- out[[i]]
    }
  }
  # Fill absent cells with full-width one-row tiles, choosing the first free row.
  for (i in seq_along(keys)) {
    if (!is.null(out[[i]])) next
    y <- 0L
    candidate <- list(x = 0L, y = y, w = LAYOUT_GRID_COLUMNS, h = 1L)
    while (length(occupied) && any(vapply(occupied, layout_rect_overlap,
                                          logical(1), b = candidate))) {
      y <- y + 1L
      if (y > LAYOUT_MAX_ROW) layout_abort("cannot place all cells within the safe grid bounds")
      candidate$y <- y
    }
    out[[i]] <- candidate
    occupied[[length(occupied) + 1L]] <- candidate
  }
  out
}

layout_heading_start <- function(cell) {
  if (!identical(cell$type, "markdown")) return(FALSE)
  body <- cell$body
  if (!is.character(body) || !length(body)) return(FALSE)
  body <- body[nzchar(trimws(body))]
  if (!length(body)) return(FALSE)
  grepl("^\\s*#{1,2}(?:\\s|$)", body[[1L]], perl = TRUE)
}

layout_slide_marker <- function(cell) {
  value <- if (is.list(cell$options)) cell$options$slide else NULL
  isTRUE(value) || (is.character(value) && length(value) == 1L && tolower(trimws(value)) %in% c("true", "yes", "1"))
}

alder_slide_groups <- function(notebook, layout = NULL) {
  nb <- layout_notebook(notebook)
  keys <- layout_cell_keys(nb)
  cells <- nb$cells
  checked <- if (is.null(layout)) NULL else alder_layout_validate(layout)
  if (!length(keys)) return(list())
  # Explicit groups take precedence; unmentioned cells become singleton slides.
  if (!is.null(checked) && "slides" %in% names(checked) && length(checked$slides)) {
    key_set <- keys
    groups <- list()
    used <- character()
    for (group in checked$slides) {
      members <- if (is.list(group)) group$cells else group
      members <- members[members %in% key_set & !(members %in% used)]
      if (!length(members)) next
      groups[[length(groups) + 1L]] <- members
      used <- c(used, members)
    }
    missing <- keys[!(keys %in% used)]
    if (length(missing)) groups <- c(groups, lapply(missing, function(key) key))
    if (length(groups)) return(groups)
  }
  # Automatic grouping starts at level-1/2 markdown headings or slide: true.
  groups <- list(character())
  for (i in seq_along(cells)) {
    if (i > 1L && (layout_heading_start(cells[[i]]) || layout_slide_marker(cells[[i]]))) {
      groups[[length(groups) + 1L]] <- character()
    }
    current <- length(groups)
    groups[[current]] <- c(groups[[current]], keys[[i]])
  }
  groups[vapply(groups, length, 0L) > 0L]
}

layout_gallery_paths <- function(paths) {
  if (!is.character(paths) || anyNA(paths)) layout_abort("gallery paths must be character paths")
  expanded <- character()
  for (path in paths) {
    if (!nzchar(path)) next
    if (dir.exists(path)) {
      expanded <- c(expanded, list.files(path, full.names = TRUE, all.files = FALSE, no.. = TRUE))
    } else {
      expanded <- c(expanded, path)
    }
  }
  expanded <- expanded[file.exists(expanded) & !dir.exists(expanded)]
  if (!length(expanded)) return(character())
  normalized <- normalizePath(expanded, winslash = "/", mustWork = FALSE)
  normalized <- unique(normalized)
  normalized <- normalized[tolower(tools::file_ext(normalized)) == "r"]
  if (!length(normalized)) return(character())
  normalized[order(basename(normalized), normalized, method = "radix")]
}

layout_gallery_description <- function(cell) {
  body <- cell$body
  if (!is.character(body) || !length(body)) return("")
  lines <- vapply(body, function(line) sub("^\\s*#+\\s?", "", line, perl = TRUE), "")
  text <- paste(trimws(lines[nzchar(trimws(lines))]), collapse = " ")
  text <- gsub("[[:space:]]+", " ", trimws(text), perl = TRUE)
  if (nchar(text, type = "chars") > 240L) substr(text, 1L, 240L) else text
}

alder_gallery_index <- function(paths) {
  candidates <- layout_gallery_paths(paths)
  if (!length(candidates)) return(list())
  result <- list()
  for (path in candidates) {
    nb <- tryCatch(read_notebook(path), error = function(e) NULL)
    if (is.null(nb) || !length(nb$cells)) next
    markdown <- vapply(nb$cells, function(cell) identical(cell$type, "markdown"), logical(1))
    first_md <- if (any(markdown)) nb$cells[[which(markdown)[[1L]]]] else NULL
    title <- if (is.list(nb$metadata)) nb$metadata$title else NULL
    if (!is.character(title) || length(title) != 1L || is.na(title) || !nzchar(trimws(title))) {
      title <- basename(path)
    }
    result[[length(result) + 1L]] <- list(
      path = path,
      basename = basename(path),
      title = title,
      description = if (is.null(first_md)) "" else layout_gallery_description(first_md)
    )
  }
  result
}
