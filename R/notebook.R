# Notebook file format (ADR 0001): plain-text .R with `# %%` cells.
#
# A notebook is ordinary R source. Cells are delimited by `# %%` comment
# lines; `# %% [markdown]` opens a markdown cell. Cell metadata uses `#|`
# (Quarto code-option syntax). Notebook-level metadata lives in a YAML block
# inside `# ---` comment fences at the top of the file.
#
# Round-trip fidelity: parsing never rewrites the file. Every physical
# source line is a record `list(text = <scalar>, eol = "\n"|"\r\n"|"\r"|"",
# kind = "header"|"delimiter"|"option"|"body")`; serialization concatenates
# `text + eol` exactly, so an unedited notebook reproduces the input
# byte-for-byte, including mixed line terminators and a missing final EOL.

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
# A Cell holds: id (stable character id), type ("code" or "markdown"), delim
# (the raw `# %% ...` delimiter line), body (raw code or markdown lines,
# excluding the delimiter and `#|` lines), options (named list parsed from
# `#| key: value` lines, last value wins), option_duplicates (named list:
# duplicated option key -> 1-based positions of its records within
# `cell$records`), raw (every source line text of the cell, delimiter
# included) and records (the physical source records that own the cell's
# delimiter/options/body bytes).
#
# A Notebook holds: path, header (raw texts before the first cell),
# metadata (parsed YAML front matter), cells, header_records (physical
# records owning the pre-cell bytes), preferred_eol (first nonempty source
# EOL, or LF), final_newline (whether the final physical record had a
# nonempty EOL) and next_cell_number (monotonic cell-N allocator).

new_record <- function(text, eol, kind) {
  list(text = text, eol = eol, kind = kind)
}

new_cell <- function(id, type, delim, body, options, raw, records,
                     option_duplicates = list()) {
  structure(
    list(
      id = id, type = type, delim = delim,
      body = body, options = options, raw = raw,
      records = records, option_duplicates = option_duplicates
    ),
    class = "alder_cell"
  )
}

new_notebook <- function(path, header, metadata, cells, header_records = list(),
                         preferred_eol = "\n", final_newline = TRUE,
                         next_cell_number = NULL) {
  if (is.null(next_cell_number)) {
    nums <- vapply(cells, function(c) cell_number(c$id), 0L)
    next_cell_number <- (if (length(nums)) max(nums) else 0L) + 1L
  }
  structure(
    list(
      path = path, header = header, metadata = metadata, cells = cells,
      header_records = header_records,
      preferred_eol = preferred_eol, final_newline = final_newline,
      next_cell_number = as.integer(next_cell_number)
    ),
    class = "alder_notebook"
  )
}

# Numeric suffix of a `cell-N` id, or NA for ids outside that scheme.
cell_number <- function(id) {
  m <- regexec("^cell-([0-9]+)$", id)
  mm <- regmatches(id, m)[[1L]]
  if (length(mm) == 2L) as.integer(mm[[2L]]) else NA_integer_
}

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

# A cell delimiter is a comment line whose content matches `# %%`.
cell_delim_index <- function(lines) {
  m <- grepl("^\\s*#\\s*%%", lines)
  which(m)
}

# Split a whole UTF-8 file text into physical records. Each record keeps
# its terminator verbatim; the final record carries eol = "" when the file
# does not end with a line terminator. Mixed \n / \r\n / \r are preserved.
split_records <- function(text) {
  if (!nzchar(text)) return(list())
  parts <- strsplit(text, "(?<=\n)|(?<=\r)(?!\n)", perl = TRUE)[[1L]]
  # strsplit leaves a trailing "" after a final terminator.
  if (length(parts) && !nzchar(parts[[length(parts)]])) {
    parts <- parts[-length(parts)]
  }
  lapply(parts, function(p) {
    if (grepl("\r\n$", p)) new_record(sub("\r\n$", "", p), "\r\n", "header")
    else if (grepl("\n$", p)) new_record(sub("\n$", "", p), "\n", "header")
    else if (grepl("\r$", p)) new_record(sub("\r$", "", p), "\r", "header")
    else new_record(p, "", "header")
  })
}

# Parse a record list (kinds re-derived from content) into a Notebook.
parse_records <- function(path, records) {
  texts <- vapply(records, function(r) r$text, "")
  d <- cell_delim_index(texts)
  n <- length(records)
  kinds <- rep("header", n)

  breaks <- c(d, n + 1L)
  if (length(d)) {
    for (i in seq_along(d)) {
      start <- breaks[[i]]
      end <- breaks[[i + 1L]] - 1L
      kinds[[start]] <- "delimiter"
      if (end > start) {
        seg <- (start + 1L):end
        kinds[seg] <- ifelse(grepl("^\\s*#\\|", texts[seg]), "option", "body")
      }
    }
  }
  for (i in seq_along(records)) records[[i]]$kind <- kinds[[i]]

  header_records <- if (length(d)) records[seq_len(d[[1L]] - 1L)] else records
  header_texts <- vapply(header_records, function(r) r$text, "")
  hdr <- parse_notebook_header(header_texts)

  eols <- vapply(records, function(r) r$eol, "")
  preferred_eol <- eols[nzchar(eols)]
  preferred_eol <- if (length(preferred_eol)) preferred_eol[[1L]] else "\n"
  final_newline <- if (n > 0L) nzchar(eols[[n]]) else TRUE

  cells <- vector("list", length(d))
  for (i in seq_along(d)) {
    start <- breaks[[i]]
    end <- breaks[[i + 1L]] - 1L
    cell_recs <- records[start:end]
    parsed <- parse_cell_records(cell_recs)
    cells[[i]] <- new_cell(
      id = paste0("cell-", i),
      type = parsed$type,
      delim = parsed$delim,
      body = parsed$body,
      options = parsed$options,
      raw = parsed$raw,
      records = cell_recs,
      option_duplicates = parsed$option_duplicates
    )
  }

  new_notebook(path, hdr$header, hdr$metadata, cells,
               header_records = header_records,
               preferred_eol = preferred_eol,
               final_newline = final_newline)
}

# Derive the caller-facing fields of a cell from its records. Called after
# parsing and after every record mutation; the id is untouched (stable).
sync_cell_from_records <- function(cell) {
  recs <- cell$records
  delim_rec <- recs[[1L]]
  cell$type <- "code"
  if (grepl("\\[markdown\\]", delim_rec$text)) cell$type <- "markdown"
  cell$delim <- delim_rec$text
  kinds <- vapply(recs, function(r) r$kind, "")
  opt_pos <- which(kinds == "option")
  body_pos <- which(kinds == "body")
  cell$body <- vapply(recs[body_pos], function(r) r$text, "")
  po <- parse_option_values(recs, opt_pos)
  cell$options <- po$options
  cell$option_duplicates <- po$duplicates
  cell$raw <- vapply(recs, function(r) r$text, "")
  cell
}

parse_cell_records <- function(cell_records) {
  delim <- cell_records[[1L]]$text
  type <- "code"
  if (grepl("\\[markdown\\]", delim)) type <- "markdown"
  kinds <- vapply(cell_records, function(r) r$kind, "")
  opt_pos <- which(kinds == "option")
  body_pos <- which(kinds == "body")
  po <- parse_option_values(cell_records, opt_pos)
  list(
    type = type, delim = delim,
    body = vapply(cell_records[body_pos], function(r) r$text, ""),
    options = po$options,
    option_duplicates = po$duplicates,
    raw = vapply(cell_records, function(r) r$text, "")
  )
}

# Parse `#| key: value` / `#| key` option records into (a) a named list of
# values (last occurrence wins) and (b) a map from each duplicated key to
# its 1-based record positions within the cell's records.
parse_option_values <- function(records, opt_pos) {
  options <- list()
  first_pos <- list()
  duplicates <- list()
  for (pos in opt_pos) {
    s <- sub("^\\s*#\\|\\s*", "", records[[pos]]$text)
    kv <- strsplit(s, ":", fixed = TRUE)[[1L]]
    key <- trimws(kv[[1L]])
    if (!length(key) || !nzchar(key)) next
    if (length(kv) >= 2L) {
      val <- parse_scalar(trimws(paste(kv[-1L], collapse = ":")))
    } else {
      val <- TRUE
    }
    if (key %in% names(first_pos)) {
      duplicates[[key]] <- c(first_pos[[key]], pos)
    } else {
      first_pos[[key]] <- pos
    }
    options[[key]] <- val
  }
  list(options = options, duplicates = duplicates)
}

# Compatibility surface: parse `#| key: value` lines into a named list.
# Kept for callers that hold plain option lines (not records).
parse_option_lines <- function(meta_lines) {
  recs <- lapply(meta_lines, function(ln) new_record(ln, "\n", "option"))
  parse_option_values(recs, seq_along(recs))$options
}

parse_scalar <- function(s) {
  if (nzchar(s) && s %in% c("true", "TRUE")) return(TRUE)
  if (nzchar(s) && s %in% c("false", "FALSE")) return(FALSE)
  s
}

# Parse the `# ---` YAML header block (metadata) from the raw line texts.
# Returns list(header = raw line texts, metadata = named list).
parse_notebook_header <- function(lines) {
  # The header is everything up to (excluding) the first cell delimiter.
  d <- cell_delim_index(lines)
  header_end <- if (length(d)) d[[1L]] - 1L else length(lines)
  header <- if (header_end >= 1L) lines[seq_len(header_end)] else character()

  # Metadata = the `# ---` fenced YAML block within the header.
  yaml_lines <- try_extract_yaml(header)
  metadata <- parse_yaml_lines(yaml_lines)
  list(header = header, metadata = metadata)
}

# Locate a `# ---` ... `# ---` fenced region whose interior lines look like
# YAML (comment-prefixed), returning the interior (comment prefix stripped).
try_extract_yaml <- function(header) {
  fences <- which(grepl("^\\s*#\\s*---\\s*$", header))
  if (length(fences) < 2L) return(character())
  start <- fences[[1L]] + 1L
  end <- fences[[2L]] - 1L
  if (end < start) return(character())
  interior <- header[start:end]
  # Only accept lines that are comments ('# key: value' form) to avoid
  # treating arbitrary leading comment text as YAML.
  if (!all(grepl("^\\s*#", interior))) return(character())
  sub("^\\s*#\\s?", "", interior)
}

parse_yaml_lines <- function(lines) {
  out <- list()
  for (ln in lines) {
    if (!nzchar(trimws(ln))) next
    kv <- strsplit(ln, ":", fixed = TRUE)[[1L]]
    if (length(kv) < 2L) next
    out[[trimws(kv[[1L]])]] <- parse_scalar(trimws(paste(kv[-1L], collapse = ":")))
  }
  out
}

# Raw-byte reader: validates UTF-8 and splits records without normalizing
# terminators. Invalid UTF-8 fails with the file path before any change.
read_notebook <- function(path) {
  if (!file.exists(path)) stop("notebook file not found: ", path)
  size <- file.info(path)$size
  bytes <- readBin(path, "raw", n = size)
  text <- rawToChar(bytes)
  if (!validUTF8(text)) stop("notebook is not valid UTF-8: ", path)
  parse_records(path, split_records(text))
}

# Public-to-internal compatibility: one LF-terminated record per supplied
# line, parsed by the same record parser. An empty synthetic notebook uses
# the canonical final-newline policy (final_newline = TRUE) so its first
# added cell terminates the file.
parse_notebook_lines <- function(path = NA_character_, lines) {
  records <- lapply(lines, function(ln) new_record(ln, "\n", "header"))
  parse_records(path, records)
}

# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

record_texts <- function(records) {
  vapply(records, function(r) paste0(r$text, r$eol), "")
}

# Concatenate header records and every cell's records byte-for-byte.
serialize_notebook <- function(nb) {
  paste0(c(
    record_texts(nb$header_records),
    unlist(lapply(nb$cells, function(c) record_texts(c$records)),
           use.names = FALSE)
  ), collapse = "")
}

write_notebook <- function(nb, path = nb$path) {
  writeBin(charToRaw(serialize_notebook(nb)), path)
  invisible(nb)
}

# ---------------------------------------------------------------------------
# Body mutation (byte-aware) and boundary normalization
# ---------------------------------------------------------------------------

# Enforce the terminal-EOL invariant after any record-count mutation:
# - if the file had a final newline, no record may carry eol = "";
# - if it had none, exactly the final physical record carries eol = "" and
#   every record that became interior receives preferred_eol.
normalize_nb_boundary <- function(nb) {
  pref <- nb$preferred_eol
  flat <- list()
  owners <- list()  # parallel: c("h", i) header record i | c("c", ci, ri)
  for (i in seq_along(nb$header_records)) {
    flat[[length(flat) + 1L]] <- nb$header_records[[i]]
    owners[[length(owners) + 1L]] <- c("h", i)
  }
  for (ci in seq_along(nb$cells)) {
    recs <- nb$cells[[ci]]$records
    for (ri in seq_along(recs)) {
      flat[[length(flat) + 1L]] <- recs[[ri]]
      owners[[length(owners) + 1L]] <- c("c", ci, ri)
    }
  }
  n <- length(flat)
  if (n == 0L) return(nb)
  for (i in seq_len(n)) {
    if (identical(flat[[i]]$eol, "")) {
      if (isTRUE(nb$final_newline) || i < n) flat[[i]]$eol <- pref
    } else if (!isTRUE(nb$final_newline) && i == n) {
      flat[[i]]$eol <- ""
    }
  }
  hi <- 0L
  for (i in seq_len(n)) {
    if (owners[[i]][[1L]] == "h") {
      hi <- hi + 1L
      nb$header_records[[hi]] <- flat[[i]]
    } else {
      ci <- as.integer(owners[[i]][[2L]])
      ri <- as.integer(owners[[i]][[3L]])
      nb$cells[[ci]]$records[[ri]] <- flat[[i]]
    }
  }
  nb
}

# Splice new body lines into a cell's records: replace existing body slots
# in order (retaining each slot's eol), remove surplus body slots, and
# insert extra lines after the last old body slot (or after all option
# records when no body slot existed).
splice_body_records <- function(records, body, preferred_eol) {
  kinds <- vapply(records, function(r) r$kind, "")
  opt_pos <- which(kinds == "option")
  body_pos <- which(kinds == "body")
  n_body <- length(body_pos)

  # Trailing blank body records separate the cell from the next one; they
  # are not content the user typed in this edit, so every splice preserves
  # them byte-for-byte (ADR 0001). Content slots are the non-blank head.
  n_content <- n_body
  while (n_content > 0L && identical(records[[body_pos[[n_content]]]]$text, "")) {
    n_content <- n_content - 1L
  }
  content_pos <- if (n_content > 0L) body_pos[seq_len(n_content)] else integer()
  n_old <- length(content_pos)
  n_new <- length(body)

  if (n_old == 0L) {
    if (n_new == 0L) return(records)
    # Insert fresh content after the options (or before any trailing blank
    # separators when no option record exists), preserving blank records.
    extra <- lapply(body, function(ln) new_record(ln, preferred_eol, "body"))
    if (length(opt_pos)) {
      return(append(records, extra, after = opt_pos[[length(opt_pos)]]))
    }
    if (n_body > 0L) {
      return(append(records, extra, after = body_pos[[1L]] - 1L))
    }
    return(append(records, extra, after = 1L))
  }

  # Replace content slots 1:1, keeping each slot's own EOL bytes.
  k <- min(n_old, n_new)
  if (k > 0L) {
    for (j in seq_len(k)) records[[content_pos[[j]]]]$text <- body[[j]]
  }
  if (n_new > n_old) {
    # Grow: append the extra lines after the last content slot, before any
    # trailing blank separators.
    extra <- lapply(body[(n_old + 1L):n_new],
                    function(ln) new_record(ln, preferred_eol, "body"))
    records <- append(records, extra, after = content_pos[[n_old]])
  } else if (n_new < n_old) {
    # Shrink: drop the removed tail content slots, keep blank separators.
    records <- records[-(content_pos[(n_new + 1L):n_old])]
  }
  records
}

# Rebuild a cell's raw line vector (delimiter + options + body texts) —
# compatibility helper kept for tests and introspection.
rebuild_cell_raw <- function(cell) {
  vapply(cell$records, function(r) r$text, "")
}

# ---------------------------------------------------------------------------
# Cell mutation helpers
# ---------------------------------------------------------------------------

nb_cell <- function(nb, id) {
  for (c in nb$cells) if (identical(c$id, id)) return(c)
  NULL
}

# Set cell body (code/markdown), preserving position, delimiter, options and
# every untouched byte.
nb_set_cell_body <- function(nb, id, body) {
  for (i in seq_along(nb$cells)) {
    if (identical(nb$cells[[i]]$id, id)) {
      cell <- nb$cells[[i]]
      cell$records <- splice_body_records(cell$records, body, nb$preferred_eol)
      nb$cells[[i]] <- sync_cell_from_records(cell)
      break
    }
  }
  nb <- normalize_nb_boundary(nb)
  nb
}

nb_add_cell <- function(nb, body = character(), type = "code", after = NULL) {
  delim <- if (type == "markdown") "# %% [markdown]" else "# %%"
  # Monotonic id allocation: never reuse a previously allocated number.
  id <- paste0("cell-", nb$next_cell_number)
  ids <- vapply(nb$cells, function(c) c$id, "")
  while (id %in% ids) {
    nb$next_cell_number <- nb$next_cell_number + 1L
    id <- paste0("cell-", nb$next_cell_number)
  }
  nb$next_cell_number <- nb$next_cell_number + 1L

  recs <- c(
    list(new_record(delim, nb$preferred_eol, "delimiter")),
    lapply(body, function(ln) new_record(ln, nb$preferred_eol, "body"))
  )
  cell <- new_cell(id, type, delim, body, list(), c(delim, body), recs)

  idx <- if (is.null(after)) length(nb$cells) + 1L
         else which(vapply(nb$cells, function(c) identical(c$id, after), FALSE)) + 1L
  nb$cells <- append(nb$cells, list(cell), after = idx - 1L)
  nb <- normalize_nb_boundary(nb)
  nb
}

nb_delete_cell <- function(nb, id) {
  keep <- vapply(nb$cells, function(c) !identical(c$id, id), FALSE)
  nb$cells <- nb$cells[keep]
  nb <- normalize_nb_boundary(nb)
  nb
}