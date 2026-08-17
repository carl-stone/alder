# Notebook file format (ADR 0001): plain-text .R with `# %%` cells.
#
# A notebook is ordinary R source. Cells are delimited by `# %%` comment
# lines; a standalone `[markdown]` tag (case-insensitive) opens a markdown
# cell. Cell metadata uses `#|` (Quarto code-option syntax). Notebook-level
# metadata lives in a YAML block inside `# ---` comment fences at the top of
# the file.
#
# Round-trip fidelity: parsing never rewrites the file. Every physical
# source line is a record `list(text = <scalar>, eol = "\n"|"\r\n"|"\r"|"",
# kind = "header"|"delimiter"|"option"|"body")`; serialization concatenates
# `text + eol` exactly, so an unedited notebook reproduces the input
# byte-for-byte, including mixed line terminators and a missing final EOL.
#
# Body mutation: EVERY `kind == "body"` record is an editable slot
# (including trailing blanks). The body returned by /api/state round-trips
# exactly: sending `c("x")` removes a previously visible trailing blank
# while `c("x", "")` retains it.

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
# A Cell holds: id (stable character id), type ("code" or "markdown"), delim
# (the raw `# %% ...` delimiter line), body (raw code or markdown lines,
# excluding the delimiter and `#|` lines), options (named list parsed from
# `#| key: value` lines, last value wins), option_duplicates (named list:
# duplicated option key -> 1-based positions of all its records within
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

# A cell delimiter is a comment line whose content is `# %%` followed by
# end-of-line or whitespace (`# %%x` is not a delimiter). A standalone
# `[markdown]` token (case-insensitive) makes it a markdown cell.
cell_delim_index <- function(lines) {
  m <- grepl("^\\s*#\\s*%%(\\s|$)", lines, perl = TRUE)
  which(m)
}

# `# %% [markdown]` (any case), and only that trailing token.
is_markdown_delim <- function(delim) {
  m <- regexec("^\\s*#\\s*%%\\s*(.*)$", delim, perl = TRUE)
  mm <- regmatches(delim, m)[[1L]]
  if (length(mm) != 2L) return(FALSE)
  tolower(trimws(mm[[2L]])) == "[markdown]"
}

# Markdown cells must remain ordinary R source: every body line is blank or
# an R comment (`^\\s*#`), so a `.R` file with markdown cells still parses.
validate_markdown_lines <- function(body, id) {
  ok <- vapply(body,
               function(ln) !nzchar(trimws(ln)) || grepl("^\\s*#", ln),
               logical(1))
  if (!all(ok)) {
    stop("markdown cell lines must be blank or R comments: ", id, call. = FALSE)
  }
  invisible(body)
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
    id <- paste0("cell-", i)
    parsed <- parse_cell_records(cell_recs, id)
    cells[[i]] <- new_cell(
      id = id,
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
  cell$type <- if (is_markdown_delim(delim_rec$text)) "markdown" else "code"
  cell$delim <- delim_rec$text
  kinds <- vapply(recs, function(r) r$kind, "")
  opt_pos <- which(kinds == "option")
  body_pos <- which(kinds == "body")
  cell$body <- vapply(recs[body_pos], function(r) r$text, "")
  po <- parse_option_values(recs, opt_pos)
  cell$options <- po$options
  cell$option_duplicates <- po$duplicates
  cell$raw <- vapply(recs, function(r) r$text, "")
  if (cell$type == "markdown") validate_markdown_lines(cell$body, cell$id)
  cell
}

parse_cell_records <- function(cell_records, id = "?") {
  delim <- cell_records[[1L]]$text
  type <- if (is_markdown_delim(delim)) "markdown" else "code"
  kinds <- vapply(cell_records, function(r) r$kind, "")
  opt_pos <- which(kinds == "option")
  body_pos <- which(kinds == "body")
  body <- vapply(cell_records[body_pos], function(r) r$text, "")
  po <- parse_option_values(cell_records, opt_pos)
  if (type == "markdown") validate_markdown_lines(body, id)
  list(
    type = type, delim = delim, body = body,
    options = po$options,
    option_duplicates = po$duplicates,
    raw = vapply(cell_records, function(r) r$text, "")
  )
}

# Parse `#| key: value` / `#| key` option records into (a) a named list of
# values (last occurrence wins) and (b) a map from each duplicated key to
# ALL its 1-based record positions within the cell's records.
parse_option_values <- function(records, opt_pos) {
  options <- list()
  positions <- list()
  for (pos in opt_pos) {
    s <- sub("^\\s*#\\|\\s*", "", records[[pos]]$text)
    kv <- strsplit(s, ":", fixed = TRUE)[[1L]]
    key <- trimws(kv[[1L]])
    if (!length(key) || !nzchar(key)) next
    positions[[key]] <- c(positions[[key]], pos)
    if (length(kv) >= 2L) {
      val <- parse_scalar(trimws(paste(kv[-1L], collapse = ":")))
    } else {
      val <- TRUE
    }
    options[[key]] <- val
  }
  dups <- positions[vapply(positions, length, 0L) > 1L]
  list(options = options, duplicates = dups)
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

# Parse comment-stripped YAML with yaml::yaml.load(eval.expr = FALSE): tagged
# expressions are never evaluated. The metadata root must be empty or a
# named mapping; parser warnings (e.g. duplicate mapping keys) are treated
# as malformed metadata.
parse_yaml_lines <- function(lines) {
  text <- paste(lines, collapse = "\n")
  if (!nzchar(trimws(text))) return(list())
  res <- tryCatch(
    withCallingHandlers(
      yaml::yaml.load(text, eval.expr = FALSE),
      warning = function(w) {
        stop("malformed YAML metadata: ", conditionMessage(w), call. = FALSE)
      }
    ),
    error = function(e) {
      if (startsWith(conditionMessage(e), "malformed YAML metadata:")) stop(e)
      stop("malformed YAML metadata: ", conditionMessage(e), call. = FALSE)
    }
  )
  if (is.null(res)) return(list())
  if (!is.list(res) || is.null(names(res))) {
    stop("notebook metadata must be a named mapping", call. = FALSE)
  }
  res
}

# Raw-byte reader: rejects directories, unreadable files, invalid UTF-8,
# and embedded NULs with deterministic path-bearing errors; invalid text
# fails as `notebook is not valid UTF-8: <path>` before parsing/mutation.
read_notebook <- function(path) {
  if (dir.exists(path)) stop("notebook path is a directory: ", path)
  if (!file.exists(path)) stop("notebook file not found: ", path)
  if (file.access(path, 4) != 0L) stop("notebook file is not readable: ", path)
  size <- file.info(path)$size
  bytes <- readBin(path, "raw", n = size)
  if (0L %in% as.integer(bytes)) {
    stop("notebook contains an embedded NUL: ", path)
  }
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

# Atomic save with optimistic conflict detection. The Session re-reads the
# path immediately before saving and passes the expected disk version; this
# function re-checks the same bytes, writes a temporary file in the target
# directory, preserves existing mode when present, and replaces the target
# with fs::file_move(). A move failure leaves the original in place and
# always removes the temporary file.
write_notebook_atomic <- function(nb, expected_version = NULL) {
  path <- nb$path
  if (!is.character(path) || length(path) != 1L || is.na(path) ||
      !nzchar(path)) {
    stop("notebook has no path", call. = FALSE)
  }
  parent <- dirname(path)
  if (!dir.exists(parent)) {
    stop("notebook directory does not exist: ", parent, call. = FALSE)
  }
  if (file.access(parent, 2L) != 0L) {
    stop("notebook directory is not writable: ", parent, call. = FALSE)
  }
  if (!is.null(expected_version)) {
    cur_exists <- file.exists(path)
    cur_bytes <- if (cur_exists) readBin(path, "raw", n = file.info(path)$size)
                 else raw()
    if (identical(expected_version$exists, FALSE)) {
      if (cur_exists) {
        stop("notebook changed on disk; restart alder before saving",
             call. = FALSE)
      }
    } else {
      if (!cur_exists || !identical(cur_bytes, expected_version$bytes)) {
        stop("notebook changed on disk; restart alder before saving",
             call. = FALSE)
      }
    }
  }
  bytes <- charToRaw(serialize_notebook(nb))
  tmp <- tempfile(pattern = ".alder-save-", tmpdir = parent)
  on.exit(unlink(tmp), add = TRUE)
  con <- file(tmp, "wb")
  on.exit(tryCatch(close(con), error = function(e) NULL), add = TRUE)
  writeBin(bytes, con)
  flush(con)
  close(con)
  if (file.exists(path) && file.access(path, 0L) == 0L) {
    mode <- file.info(path)$mode
    if (!is.na(mode)) tryCatch(Sys.chmod(tmp, mode), error = function(e) NULL)
  }
  # fs::file_move returns the destination path (invisibly); any failure
  # raises and leaves the original in place.
  fs::file_move(tmp, path)
  invisible(nb)
}

# ---------------------------------------------------------------------------
# Terminal-EOL invariant
# ---------------------------------------------------------------------------
# After any record-count mutation:
# - if the file had a final newline (final_newline TRUE), no record may
#   carry eol = "";
# - if it had none, exactly the final physical record carries eol = "" and
#   every record that became interior receives preferred_eol.
#
# `normalize_nb_boundary()` touches only the mutated cells (`region`, an
# integer vector of 1-based cell indices) plus, when `hdr` is set, the last
# header record, and the true terminal record — never an O(total records)
# pass over an untouched notebook.

terminal_ref <- function(nb) {
  if (length(nb$cells)) {
    ci <- length(nb$cells)
    ri <- length(nb$cells[[ci]]$records)
    if (ri >= 1L) return(list(where = "cell", ci = ci, ri = ri))
  }
  if (length(nb$header_records)) {
    return(list(where = "header", ri = length(nb$header_records)))
  }
  NULL
}

record_eol_of <- function(nb, ref) {
  if (identical(ref$where, "cell")) nb$cells[[ref$ci]]$records[[ref$ri]]$eol
  else nb$header_records[[ref$ri]]$eol
}

set_record_eol <- function(nb, ref, eol) {
  if (identical(ref$where, "cell")) nb$cells[[ref$ci]]$records[[ref$ri]]$eol <- eol
  else nb$header_records[[ref$ri]]$eol <- eol
  nb
}

normalize_nb_boundary <- function(nb, region = integer(), hdr = FALSE) {
  pref <- nb$preferred_eol
  tr <- terminal_ref(nb)
  if (hdr && !isTRUE(nb$final_newline) && length(nb$header_records) &&
      identical(record_eol_of(nb, list(where = "header",
                                       ri = length(nb$header_records))), "")) {
    nb <- set_record_eol(nb, list(where = "header",
                                  ri = length(nb$header_records)), pref)
  }
  for (ci in region) {
    if (ci < 1L || ci > length(nb$cells)) next
    recs <- nb$cells[[ci]]$records
    term_ri <- if (!is.null(tr) && identical(tr$where, "cell") &&
                   identical(tr$ci, ci)) tr$ri else 0L
    for (ri in seq_along(recs)) {
      if (identical(recs[[ri]]$eol, "") && ri != term_ri) recs[[ri]]$eol <- pref
    }
    nb$cells[[ci]]$records <- recs
  }
  # A file that ends with a terminator keeps its terminal bytes verbatim —
  # only a no-final-newline file carries a bare terminal record.
  if (!is.null(tr) && !isTRUE(nb$final_newline) &&
      !identical(record_eol_of(nb, tr), "")) {
    nb <- set_record_eol(nb, tr, "")
  }
  nb
}

# ---------------------------------------------------------------------------
# Body mutation (byte-aware)
# ---------------------------------------------------------------------------

# Splice new body lines into a cell's records: every `kind == "body"`
# record is a body slot (including trailing blanks). Replace slots in
# order (retaining each slot's eol), delete every surplus slot, and insert
# extra slots after the final old body slot, or after the last option
# record when no body slot exists. No immutable separator is invented.
splice_body_records <- function(records, body, preferred_eol) {
  kinds <- vapply(records, function(r) r$kind, "")
  body_pos <- which(kinds == "body")
  opt_last <- tail(which(kinds == "option"), 1L)
  n_old <- length(body_pos)
  n_new <- length(body)

  if (n_old == 0L) {
    if (n_new == 0L) return(records)
    extra <- lapply(body, function(ln) new_record(ln, preferred_eol, "body"))
    anchor <- if (length(opt_last)) opt_last[[1L]] else 1L
    return(append(records, extra, after = anchor))
  }

  k <- min(n_old, n_new)
  if (k > 0L) {
    for (j in seq_len(k)) records[[body_pos[[j]]]]$text <- body[[j]]
  }
  if (n_new > n_old) {
    extra <- lapply(body[(n_old + 1L):n_new],
                    function(ln) new_record(ln, preferred_eol, "body"))
    records <- append(records, extra, after = body_pos[[n_old]])
  } else if (n_new < n_old) {
    records <- records[-body_pos[(n_new + 1L):n_old]]
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

nb_cell_index <- function(nb, id) {
  hits <- which(vapply(nb$cells, function(c) identical(c$id, id), FALSE))
  if (!length(hits)) stop("no such cell: ", id, call. = FALSE)
  hits[[1L]]
}

nb_cell <- function(nb, id) {
  hits <- which(vapply(nb$cells, function(c) identical(c$id, id), FALSE))
  if (!length(hits)) NULL else nb$cells[[hits[[1L]]]]
}

# Update a cell's body and type. `type` is exactly "code" or "markdown";
# markdown bodies must be blank or R comments so the file stays ordinary R
# source. The delimiter text is preserved when the type is unchanged; on a
# type change only the delimiter text is replaced with the canonical
# `# %%` or `# %% [markdown]`, retaining its original EOL.
nb_update_cell <- function(nb, id, body, type) {
  if (!(identical(type, "code") || identical(type, "markdown"))) {
    stop("invalid cell type; must be \"code\" or \"markdown\"", call. = FALSE)
  }
  if (type == "markdown") validate_markdown_lines(body, id)
  ci <- nb_cell_index(nb, id)
  cell <- nb$cells[[ci]]
  records <- splice_body_records(cell$records, body, nb$preferred_eol)
  old_type <- if (is_markdown_delim(records[[1L]]$text)) "markdown" else "code"
  if (!identical(old_type, type)) {
    records[[1L]]$text <- if (type == "markdown") "# %% [markdown]" else "# %%"
  }
  cell$records <- records
  nb$cells[[ci]] <- sync_cell_from_records(cell)
  normalize_nb_boundary(nb, region = ci)
}

nb_add_cell <- function(nb, body = character(), type = "code", after = NULL) {
  if (!(identical(type, "code") || identical(type, "markdown"))) {
    stop("invalid cell type; must be \"code\" or \"markdown\"", call. = FALSE)
  }
  if (type == "markdown") validate_markdown_lines(body, "<new cell>")
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

  n_before <- length(nb$cells)
  if (is.null(after)) {
    idx <- length(nb$cells) + 1L
  } else {
    idx <- nb_cell_index(nb, after) + 1L
  }
  nb$cells <- append(nb$cells, list(cell), after = idx - 1L)
  # Boundary repair only when the new cell is appended at the end (the old
  # terminal record may have become interior).
  if (idx == length(nb$cells)) {
    nb <- normalize_nb_boundary(nb, unique(c(idx, idx - 1L)),
                                hdr = n_before == 0L)
  }
  nb
}

nb_delete_cell <- function(nb, id) {
  ci <- nb_cell_index(nb, id)
  was_last <- ci == length(nb$cells)
  nb$cells <- nb$cells[-ci]
  if (was_last) {
    # The true terminal record moved: repair the invariant in place.
    nb <- normalize_nb_boundary(nb, hdr = length(nb$cells) == 0L)
  }
  nb
}
