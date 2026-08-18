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
is_sql_delim <- function(delim) {
  m <- regexec("^\\s*#\\s*%%\\s*(.*)$", delim, perl = TRUE)
  mm <- regmatches(delim, m)[[1L]]
  if (length(mm) != 2L) return(FALSE)
  tolower(trimws(mm[[2L]])) == "[sql]"
}

sql_cell_shape <- function() {
  paste0("<into> <- sql(r\"---(\n",
         "SELECT ...\n",
         ")---\", conn = <conn>)")
}

parse_sql_cell <- function(body) {
  if (!is.character(body) || !length(body)) return(NULL)
  text <- paste(body, collapse = "\n")
  m <- regexec(
    paste0("^\\s*([A-Za-z][A-Za-z0-9_.]*)\\s*<-\\s*sql\\(\\s*",
           "r\\\"(-+)\\(([\\s\\S]*)\\)\\2\\\"",
           "(?:\\s*,\\s*conn\\s*=\\s*(.+?))?\\s*\\)\\s*$"),
    text, perl = TRUE
  )
  mm <- regmatches(text, m)[[1L]]
  if (length(mm) != 5L) return(NULL)
  query <- mm[[4L]]
  if (startsWith(query, "\n")) query <- substring(query, 2L)
  if (endsWith(query, "\n")) query <- substr(query, 1L, nchar(query) - 1L)
  conn <- trimws(mm[[5L]])
  if (!nzchar(conn)) conn <- NULL
  list(into = mm[[2L]], query = query, conn = conn)
}

sql_raw_delimiter <- function(query) {
  dashes <- "---"
  while (grepl(paste0(")", dashes, "\""), query, fixed = TRUE)) {
    dashes <- paste0(dashes, "-")
  }
  dashes
}

# Bare identifiers appearing in a SQL query body (ADR 0012). These become
# cell references: minus well-known SQL keywords they are the table/column
# names a query reads at runtime, so the notebook dependency graph orders
# the SQL cell after any cell defining one of them (e.g. a data frame
# registered into duckdb by sql()).
sql_query_identifiers <- function(query) {
  if (!is.character(query) || length(query) != 1L || is.na(query)) {
    return(character())
  }
  ids <- regmatches(query, gregexpr("[A-Za-z_][A-Za-z0-9_]*", query,
                                    perl = TRUE))[[1L]]
  keywords <- c(
    "all", "alter", "and", "as", "asc", "between", "by", "case", "check",
    "column", "constraint", "count", "create", "cross", "current",
    "default", "delete", "desc", "distinct", "drop", "else", "end",
    "except", "exists", "false", "fetch", "for", "foreign", "from", "full",
    "grant", "group", "having", "in", "index", "inner", "insert",
    "intersect", "into", "is", "join", "key", "left", "like", "limit",
    "not", "null", "offset", "on", "or", "order", "outer", "primary",
    "references", "right", "rollback", "select", "set", "table", "then",
    "true", "union", "unique", "update", "using", "values", "when",
    "where", "with"
  )
  unique(ids[!tolower(ids) %in% keywords])
}

sql_cell_body <- function(query, conn = NULL, into = "result") {
  if (!is.character(query) || length(query) != 1L || is.na(query)) {
    stop("SQL query must be a single string", call. = FALSE)
  }
  if (!cell_name_valid(into)) {
    stop("SQL result name must match ^[A-Za-z][A-Za-z0-9_.]*$",
         call. = FALSE)
  }
  if (!is.null(conn) &&
      (!is.character(conn) || length(conn) != 1L || is.na(conn) ||
       !grepl("^[A-Za-z][A-Za-z0-9_.]*(:::[A-Za-z][A-Za-z0-9_.]*)?$",
              conn, perl = TRUE))) {
    stop("SQL connection must be a symbol or namespace-qualified name",
         call. = FALSE)
  }
  dashes <- sql_raw_delimiter(query)
  query_lines <- if (nzchar(query)) strsplit(query, "\n", fixed = TRUE)[[1L]]
    else ""
  opening <- paste0(into, ' <- sql(r"', dashes, "(")
  closing <- paste0(")", dashes, '"')
  if (!is.null(conn)) closing <- paste0(closing, ", conn = ", conn)
  closing <- paste0(closing, ")")
  c(opening, query_lines, closing)
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
  cell$type <- if (is_markdown_delim(delim_rec$text)) "markdown"
    else if (is_sql_delim(delim_rec$text)) "sql" else "code"
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
  type <- if (is_markdown_delim(delim)) "markdown"
    else if (is_sql_delim(delim)) "sql" else "code"
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

metadata_records <- function(metadata, eol) {
  if (!length(metadata)) return(list())
  rendered <- yaml::as.yaml(metadata)
  rendered <- sub("[\r\n]+$", "", rendered)
  lines <- strsplit(rendered, "\n", fixed = TRUE)[[1L]]
  lapply(lines, function(line) {
    text <- if (nzchar(line)) paste0("# ", line) else "#"
    new_record(text, eol, "header")
  })
}

nb_set_metadata <- function(nb, key, value) {
  if (!is.character(key) || length(key) != 1L || is.na(key) ||
      !grepl("^[A-Za-z][A-Za-z0-9_.-]*$", key, perl = TRUE)) {
    stop("metadata key must be a non-empty scalar", call. = FALSE)
  }
  metadata <- nb$metadata %||% list()
  if (is.null(value)) metadata[[key]] <- NULL else metadata[[key]] <- value
  records <- nb$header_records
  fences <- which(vapply(
    records, function(record) grepl("^\\s*#\\s*---\\s*$",
                                     record$text, perl = TRUE), FALSE
  ))
  eol <- if (length(fences) && nzchar(records[[fences[[1L]]]]$eol)) {
    records[[fences[[1L]]]]$eol
  } else {
    nb$preferred_eol
  }
  interior <- metadata_records(metadata, eol)
  if (length(fences) >= 2L) {
    open <- fences[[1L]]
    close <- fences[[2L]]
    records <- c(
      if (open > 1L) records[seq_len(open)] else records[open],
      interior,
      records[close:length(records)]
    )
  } else {
    block <- c(
      list(new_record("# ---", eol, "header")),
      interior,
      list(new_record("# ---", eol, "header"))
    )
    records <- c(block, records)
  }
  nb$header_records <- records
  nb$header <- vapply(records, function(record) record$text, "")
  nb$metadata <- metadata
  normalize_nb_boundary(nb, hdr = TRUE)
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
# Return the 1-based physical line numbers occupied by a cell's source
# records. `#|` option records are intentionally excluded even when they are
# interleaved with the source body.
nb_body_lines <- function(nb, id) {
  cell <- nb_cell(nb, id)
  if (is.null(cell)) return(integer())
  before <- if (length(nb$header_records)) length(nb$header_records) else 0L
  for (candidate in nb$cells) {
    if (identical(candidate$id, id)) {
      kinds <- vapply(candidate$records, function(record) record$kind, "")
      return(before + which(kinds == "body"))
    }
    before <- before + length(candidate$records)
  }
  integer()
}

# Translate a zero-based cell-body position to a zero-based LSP file
# position. Characters are passed through unchanged; LSP and R use UTF-8
# source text here, and the editor sends the same byte-faithful body.
nb_to_file_pos <- function(nb, id, line, character) {
  if (length(line) != 1L || is.na(line) || line < 0L ||
      length(character) != 1L || is.na(character) || character < 0L) {
    return(NULL)
  }
  lines <- nb_body_lines(nb, id)
  index <- as.integer(line) + 1L
  if (!length(lines) || index > length(lines)) return(NULL)
  list(line = as.integer(lines[[index]] - 1L),
       character = as.integer(character))
}

# Translate a zero-based LSP file line to a zero-based cell-body line.
# Non-body lines (headers, delimiters, and #| options) return NULL.
nb_from_file_pos <- function(nb, line) {
  if (length(line) != 1L || is.na(line) || line < 0L) return(NULL)
  physical <- as.integer(line) + 1L
  cursor <- if (length(nb$header_records)) length(nb$header_records) else 0L
  for (cell in nb$cells) {
    kinds <- vapply(cell$records, function(record) record$kind, "")
    body <- which(kinds == "body")
    hits <- which(cursor + seq_along(kinds) == physical & kinds == "body")
    if (length(hits)) {
      body_line <- match(hits[[1L]], body) - 1L
      return(list(id = cell$id, line = as.integer(body_line)))
    }
    cursor <- cursor + length(kinds)
  }
  NULL
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

# Update a cell's body and type. SQL bodies are canonicalized by
# `nb_set_sql_cell`; this lower-level helper also accepts raw SQL bodies so
# malformed source can be displayed and diagnosed by Session.
nb_update_cell <- function(nb, id, body, type) {
  if (!type %in% c("code", "markdown", "sql")) {
    stop("invalid cell type; must be \"code\", \"markdown\", or \"sql\"",
         call. = FALSE)
  }
  if (type == "markdown") validate_markdown_lines(body, id)
  ci <- nb_cell_index(nb, id)
  cell <- nb$cells[[ci]]
  records <- splice_body_records(cell$records, body, nb$preferred_eol)
  old_type <- if (is_markdown_delim(records[[1L]]$text)) "markdown"
    else if (is_sql_delim(records[[1L]]$text)) "sql" else "code"
  if (!identical(old_type, type)) {
    records[[1L]]$text <- switch(
      type,
      markdown = "# %% [markdown]",
      sql = "# %% [sql]",
      code = "# %%"
    )
  }
  cell$records <- records
  nb$cells[[ci]] <- sync_cell_from_records(cell)
  normalize_nb_boundary(nb, region = ci)
}

nb_set_sql_cell <- function(nb, id, query, conn = NULL, into = "result") {
  nb_update_cell(nb, id, sql_cell_body(query, conn, into), "sql")
}

option_record_key <- function(text) {
  if (!grepl("^\\s*#\\|", text, perl = TRUE)) return("")
  value <- sub("^\\s*#\\|\\s*", "", text, perl = TRUE)
  key <- strsplit(value, ":", fixed = TRUE)[[1L]][[1L]]
  trimws(key)
}

serialize_cell_option <- function(key, value) {
  if (!is.character(key) || length(key) != 1L || is.na(key) ||
      !nzchar(trimws(key)) || grepl("[:\r\n]", key, perl = TRUE)) {
    stop("cell option key must be a non-empty scalar without ':'", call. = FALSE)
  }
  if (length(value) != 1L || is.na(value)) {
    stop("cell option value must be a scalar", call. = FALSE)
  }
  rendered <- if (is.logical(value)) {
    if (isTRUE(value)) "true" else "false"
  } else if (is.character(value)) {
    value
  } else if (is.numeric(value) || is.integer(value)) {
    format(value, trim = TRUE, scientific = FALSE)
  } else {
    stop("cell option value must be logical, character, or numeric",
         call. = FALSE)
  }
  if (length(rendered) != 1L || grepl("[\r\n]", rendered, fixed = FALSE)) {
    stop("cell option value must be a single line", call. = FALSE)
  }
  paste0("#| ", trimws(key), ": ", rendered)
}

cell_name_valid <- function(value) {
  is.character(value) && length(value) == 1L && !is.na(value) &&
    grepl("^[A-Za-z][A-Za-z0-9_.]*$", value, perl = TRUE)
}

validate_cell_name <- function(value) {
  if (!cell_name_valid(value)) {
    stop("cell name must match ^[A-Za-z][A-Za-z0-9_.]*$", call. = FALSE)
  }
  invisible(value)
}


# Set or remove one cell option without rewriting unrelated physical records.
# Existing options use their original record and EOL; new options use the
# cell's delimiter EOL and are inserted immediately after the delimiter.
nb_set_cell_option <- function(nb, id, key, value) {
  ci <- nb_cell_index(nb, id)
  cell <- nb$cells[[ci]]
  records <- cell$records
  if (identical(key, "name") && !is.null(value)) {
    validate_cell_name(value)
  }
  option_positions <- which(vapply(
    records, function(record) identical(option_record_key(record$text), key),
    FALSE
  ))
  if (is.null(value)) {
    if (length(option_positions)) records <- records[-option_positions]
  } else {
    text <- serialize_cell_option(key, value)
    if (length(option_positions)) {
      # The last record is the effective value when duplicate options exist.
      records[[option_positions[[length(option_positions)]]]]$text <- text
    } else {
      eol <- records[[1L]]$eol
      if (!nzchar(eol)) {
        eol <- vapply(records, function(record) record$eol, "")
        eol <- eol[nzchar(eol)]
        eol <- if (length(eol)) eol[[1L]] else nb$preferred_eol
      }
      option <- new_record(text, eol, "option")
      records <- append(records, list(option), after = 1L)
    }
  }
  cell$records <- records
  nb$cells[[ci]] <- sync_cell_from_records(cell)
  normalize_nb_boundary(nb, region = ci)
}

nb_move_cell <- function(nb, id, after = NULL) {
  from <- nb_cell_index(nb, id)
  if (!is.null(after)) {
    if (identical(after, id)) {
      stop("cannot move a cell after itself", call. = FALSE)
    }
    nb_cell_index(nb, after)
  }
  cells <- nb$cells
  moved <- cells[[from]]
  remaining <- cells[-from]
  target <- if (is.null(after)) {
    1L
  } else {
    match(after, vapply(remaining, function(cell) cell$id, "")) + 1L
  }
  if (target == from) return(nb)
  nb$cells <- append(remaining, list(moved), after = target - 1L)
  normalize_nb_boundary(nb, region = unique(c(from, target)))
}

nb_add_cell <- function(nb, body = character(), type = "code", after = NULL) {
  if (!type %in% c("code", "markdown", "sql")) {
    stop("invalid cell type; must be \"code\", \"markdown\", or \"sql\"",
         call. = FALSE)
  }
  if (type == "markdown") validate_markdown_lines(body, "<new cell>")
  delim <- switch(type, markdown = "# %% [markdown]",
                  sql = "# %% [sql]", code = "# %%")
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
