# Over-approximate uncertain references: missing a dependency can silently
# preserve stale values. Eager reads before definition are self-dependencies;
# deferred reads can use definitions appearing later in the cell. Only bindings
# established on every branch are definitely available afterward.

RESERVED <- c("NA", "TRUE", "FALSE", "NULL", "Inf", "NaN", "...", ".", "T",
              "F", "break", "next", ".data", ".env", ".Random.seed")

# Bare syntactic operators / infrastructure whose head is never a notebook
# reference, but whose arguments still are.
OPERATORS <- c("(", "{", "[", "[[", "$", "@", "::", ":::",
               "+", "-", "*", "/", "^", "%%", "%/%", "%*%", "%in%",
               "==", "!=", "<", ">", "<=", ">=", "&&", "||", "!", "&", "|",
               "|>", "~")

# Operations whose NSE/quoting semantics prevent treating their contents as
# evaluated reads or definitions.
QUOTE_OPS <- c("quote", "expression", "alist")

# Data-mask NSE verbs (first argument is the data; the rest mask columns).
MASK_VERBS <- c("subset", "with", "within", "transform", "filter", "mutate",
                "transmute", "select", "summarise", "summarize", "arrange",
                "group_by", "count")

# Plotting verbs whose arguments are all data-mask columns.
AES_VERBS <- c("aes", "aes_string")

# Operations whose notebook bindings cannot be determined safely; a cell
# using any of them (bare or namespace-qualified) is blocked from dispatch.
BLOCKED_DYNAMIC <- c(
  "eval", "evalq", "eval.parent", "source", "sys.source", "load",
  "attach", "detach", "delayedAssign", "makeActiveBinding",
  "assign", "remove", "get", "get0", "mget", "exists", "dynGet",
  "do.call")

# Runtime helpers are available to every notebook cell and are not notebook
# bindings. Alder currently injects no callable names; widgets are reached
# through the explicit `ui` module binding.
RUNTIME_CALLS <- character()
is_reserved <- function(nm) nm %in% RESERVED

# The statically identifiable bare root name of an assignment LHS
# (`x`, `x[i]`, `x$y`, `x@y`, `names(x)`, `attr(x, ...)`, and nested
# combinations). Returns NULL when no static root exists (dynamic/deparsed
# target), which is a blocking diagnostic.
lhs_root_name <- function(lhs) {
  while (is.call(lhs) && length(lhs) >= 2L) {
    h <- lhs[[1L]]
    hc <- if (is.symbol(h)) as.character(h) else ""
    if (hc %in% c("[", "[[", "$", "@")) {
      lhs <- lhs[[2L]]
    } else if (is.symbol(h)) {
      # replacement-function form f(a, ...) -> root lives in the first arg
      lhs <- lhs[[2L]]
    } else {
      return(NULL)
    }
  }
  if (is.symbol(lhs)) as.character(lhs) else NULL
}

# For a call whose head is the `pkg::fn` / `pkg:::fn` expression, return
# list(pkg, name); otherwise list(pkg = NULL, name = NULL).
qualified_name <- function(node) {
  if (is.call(node) && length(node) >= 2L) {
    head <- node[[1L]]
    if (is.call(head) && length(head) >= 3L) {
      hh <- head[[1L]]
      if (is.symbol(hh) && as.character(hh) %in% c("::", ":::")) {
        pkg <- head[[2L]]
        nm <- head[[3L]]
        if (is.symbol(pkg) && is.symbol(nm)) {
          return(list(pkg = as.character(pkg), name = as.character(nm)))
        }
      }
    }
  }
  list(pkg = NULL, name = NULL)
}

# A literal target/name argument. For the get-family the argument is a NAME,
# so only a scalar character constant is truly literal (a bare symbol is an
# unknown name and must block). For do.call the argument is a function, so a
# bare symbol names a known function reference and is accepted.
literal_name_of <- function(node, string_only = FALSE) {
  if (string_only) {
    if (is.character(node) && length(node) == 1L && !is.na(node) &&
        nzchar(node)) return(node)
    return(NULL)
  }
  if (is.symbol(node)) return(as.character(node))
  if (is.character(node) && length(node) == 1L && !is.na(node) &&
      nzchar(node)) return(node)
  NULL
}

# Return the literal target and value of a two-argument assign() call. Exact
# `x` / `value` argument names may reorder the call, but environment controls
# and partial argument names are deliberately excluded: only assignment into
# the call's default evaluation environment is statically bounded.
literal_assign_parts <- function(node) {
  args <- as.list(node)[-1L]
  if (length(args) != 2L) return(NULL)
  nms <- names(node)[-1L]
  if (is.null(nms)) nms <- rep("", length(args))
  if (any(!(nms %in% c("", "x", "value"))) ||
      anyDuplicated(nms[nzchar(nms)])) return(NULL)

  positions <- rep(NA_integer_, 2L)
  names(positions) <- c("x", "value")
  named <- which(nzchar(nms))
  if (length(named)) positions[nms[named]] <- named
  unnamed <- which(!nzchar(nms))
  remaining <- which(is.na(positions))
  if (length(unnamed) != length(remaining)) return(NULL)
  positions[remaining] <- unnamed

  target <- literal_name_of(args[[positions[["x"]]]], string_only = TRUE)
  if (is.null(target) || is_reserved(target)) return(NULL)
  list(name = target, value = args[[positions[["value"]]]])
}

# Source locations from R parse data.
# R reports parse-data columns as display columns (tabs advance to the next
# tab stop). The analyzer converts those prefixes to one-based UTF-8 byte
# columns; the TypeScript engine maps them to UTF-16.

.analysis_has_ancestor <- function(data, id, ancestor) {
  current <- as.integer(id)
  target <- as.integer(ancestor)
  seen <- integer()
  while (length(current) && !is.na(current) && current != 0L &&
         isFALSE(current %in% seen)) {
    if (identical(current, target)) return(TRUE)
    seen <- c(seen, current)
    idx <- match(current, data$id)
    if (is.na(idx)) break
    current <- as.integer(data$parent[[idx]])
  }
  FALSE
}

.analysis_before <- function(data, left, right) {
  left_line <- as.integer(data$line1[[left]])
  right_line <- as.integer(data$line1[[right]])
  if (left_line != right_line) return(left_line < right_line)
  as.integer(data$col1[[left]]) < as.integer(data$col1[[right]])
}
.analysis_prefix_bytes <- function(line, column) {
  if (length(column) != 1L || is.na(column) || column < 0L) return(NULL)
  if (!grepl("\t", line, fixed = TRUE)) {
    characters <- nchar(line)
    if (column > characters + 1L) return(NULL)
    prefix <- if (column > 0L) substr(line, 1L, column) else ""
    return(nchar(prefix, type = "bytes"))
  }
  characters <- strsplit(line, "", fixed = TRUE)[[1L]]
  display <- 1L
  bytes <- 0L
  for (character in characters) {
    width <- if (identical(character, "\t")) {
      8L - ((display - 1L) %% 8L)
    } else {
      1L
    }
    end_display <- display + width - 1L
    if (column < display) return(bytes)
    if (column <= end_display) {
      return(bytes + nchar(character, type = "bytes"))
    }
    display <- end_display + 1L
    bytes <- bytes + nchar(character, type = "bytes")
  }
  if (column == display) return(bytes)
  NULL
}

.analysis_token_range <- function(data, index, lines) {
  line1 <- as.integer(data$line1[[index]])
  line2 <- as.integer(data$line2[[index]])
  col1 <- as.integer(data$col1[[index]])
  col2 <- as.integer(data$col2[[index]])
  if (anyNA(c(line1, line2, col1, col2)) || line1 < 1L || line2 < line1 ||
      col1 < 1L || col2 < 1L || line1 > length(lines) || line2 > length(lines)) {
    return(NULL)
  }
  first <- lines[[line1]]
  last <- lines[[line2]]
  start_prefix <- .analysis_prefix_bytes(first, col1 - 1L)
  end_prefix <- .analysis_prefix_bytes(last, col2)
  if (is.null(start_prefix) || is.null(end_prefix) || end_prefix < start_prefix) {
    return(NULL)
  }
  list(start = list(line = line1, column = start_prefix + 1L),
       end = list(line = line2, column = end_prefix))
}

.analysis_parse_ranges <- function(text, exprs, defs, refs, self_refs) {
  data <- tryCatch(utils::getParseData(exprs, includeText = TRUE),
                   error = function(e) NULL)
  if (is.null(data) || !nrow(data) ||
      all(c("id", "parent", "token", "terminal", "text",
            "line1", "col1", "line2", "col2") %in% names(data)) == FALSE) {
    return(list())
  }
  lines <- strsplit(text, "\n", fixed = TRUE)[[1L]]
  terminals <- which(data$terminal & data$token %in%
                     c("SYMBOL", "SYMBOL_FUNCTION_CALL"))
  if (!length(terminals)) return(list())

  # Identify the root symbol on the defining side of assignment operators.
  definitions <- integer()
  operators <- which(data$terminal &
                     data$token %in% c("LEFT_ASSIGN", "EQ_ASSIGN",
                                        "RIGHT_ASSIGN"))
  for (op in operators) {
    parent <- data$parent[[op]]
    candidates <- terminals[vapply(terminals, function(i)
      .analysis_has_ancestor(data, data$id[[i]], parent), logical(1))]
    if (!length(candidates)) next
    before <- vapply(candidates, function(i) .analysis_before(data, i, op),
                     logical(1))
    candidates <- if (data$token[[op]] == "RIGHT_ASSIGN") {
      candidates[!before]
    } else {
      candidates[before]
    }
    candidates <- candidates[data$text[candidates] %in% defs &
                             data$token[candidates] == "SYMBOL"]
    if (length(candidates)) definitions <- c(definitions, data$id[[candidates[[1L]]]])
  }

  # A top-level for-loop iterator is also a definition.
  for_rows <- which(data$terminal & data$token == "FOR")
  for (for_row in for_rows) {
    cond <- which(!data$terminal & data$token == "forcond" &
                  data$parent == data$parent[[for_row]])
    if (!length(cond)) next
    cond_id <- data$id[[cond[[1L]]]]
    candidates <- terminals[vapply(terminals, function(i)
      .analysis_has_ancestor(data, data$id[[i]], cond_id), logical(1))]
    candidates <- candidates[data$text[candidates] %in% defs &
                             data$token[candidates] == "SYMBOL"]
    if (length(candidates)) {
      in_token <- which(data$terminal & data$token == "IN" &
                        data$parent == cond_id)
      if (length(in_token)) {
        before_in <- vapply(candidates, function(i)
          .analysis_before(data, i, in_token[[1L]]), logical(1))
        candidates <- candidates[before_in]
      }
    }
    if (length(candidates)) definitions <- c(definitions, data$id[[candidates[[1L]]]])
  }
  definitions <- unique(definitions)

  result <- list()
  append_range <- function(index, kind) {
    range <- .analysis_token_range(data, index, lines)
    if (is.null(range)) return(invisible())
    result[[length(result) + 1L]] <<- list(
      name = as.character(data$text[[index]]), kind = kind,
      start = range$start, end = range$end)
    invisible()
  }
  ref_names <- unique(c(refs, self_refs))
  for (index in terminals) {
    name <- as.character(data$text[[index]])
    id <- data$id[[index]]
    if (name %in% defs && id %in% definitions) {
      append_range(index, "definition")
      # Replacement assignments read the same root before defining it.
      if (name %in% self_refs) append_range(index, "reference")
    } else if (name %in% ref_names) {
      append_range(index, "reference")
    }
  }
  result
}

.analysis_diagnostic_ranges <- function(diagnostics, ranges) {
  if (!length(diagnostics)) return(diagnostics)
  for (i in seq_along(diagnostics)) {
    diagnostic <- diagnostics[[i]]
    if (!is.list(diagnostic)) {
      stop("analysis diagnostics must be objects", call. = FALSE)
    }
    if (!("range" %in% names(diagnostic))) {
      diagnostic <- c(diagnostic, list(range = NULL))
    }
    if (is.null(diagnostic$range)) {
      name <- diagnostic$symbol
      candidates <- if (length(name) && !is.na(name)) {
        Filter(function(value) identical(value$name, name), ranges)
      } else list()
      if (length(candidates)) {
        diagnostic$range <- list(start = candidates[[1L]]$start,
                                 end = candidates[[1L]]$end)
      }
    }
    diagnostics[[i]] <- diagnostic
  }
  diagnostics
}
cell_defs_refs <- function(code) {
  # Returns list(defs, refs, selfRefs, locals, barrier, diagnostics, error, ranges).
  empty <- list(defs = character(), refs = character(),
                selfRefs = character(), locals = character(),
                barrier = FALSE, opaque = FALSE,
                diagnostics = list(), error = NULL, ranges = list())
  if (length(code) == 0L) return(empty)
  text <- enc2utf8(paste(code, collapse = "\n"))
  exprs <- tryCatch(base::parse(text = text, keep.source = TRUE),
                    error = function(e) conditionMessage(e))
  if (is.character(exprs)) {
    empty$error <- exprs
    return(empty)
  }

  # Pass 1: every name this cell could define at top level (including under
  # branches and loops), used to classify reads in pass 2.
  p1 <- new.env(parent = emptyenv())
  p1$defs <- character()
  for (i in seq_along(exprs)) collect_top_defs(exprs[[i]], p1)

  state <- new.env(parent = emptyenv())
  state$defs <- unique(p1$defs)
  state$refs <- character()
  state$selfRefs <- character()
  state$barrier <- FALSE
  state$opaque <- FALSE
  state$diagnostics <- list()
  state$mask_warned <- character()

  top <- new_frame(character(), "top")
  for (i in seq_along(exprs)) walk_expr(exprs[[i]], top, new_ctx(), state)
  locals <- unique(state$defs[grepl("^\\.", state$defs)])
  defs <- setdiff(state$defs, locals)
  refs <- setdiff(unique(state$refs), locals)
  self_refs <- setdiff(unique(state$selfRefs), locals)
  ranges <- .analysis_parse_ranges(text, exprs, defs, refs, self_refs)
  diagnostics <- .analysis_diagnostic_ranges(state$diagnostics, ranges)
  list(defs = defs, refs = refs, selfRefs = self_refs,
       locals = locals, barrier = isTRUE(state$barrier),
       opaque = isTRUE(state$opaque), diagnostics = diagnostics,
       error = NULL, ranges = ranges)
}

# Names assigned anywhere at the top level of this cell, in order. Function
# bodies, local() and quoting operators carry their own scope; data-mask
# expressions never promote their assignments to notebook definitions.
collect_top_defs <- function(node, p1) {
  if (!is.call(node) || identical(node, quote(expr = ))) return(invisible())
  head <- node[[1L]]
  hn <- if (is.symbol(head)) as.character(head) else ""

  if (hn %in% c("function", "quote", "expression", "alist", "local")) {
    return(invisible())
  }
  q <- qualified_name(node)
  if (!is.null(q$name)) {
    if (identical(q$pkg, "base") && identical(q$name, "assign")) {
      parts <- literal_assign_parts(node)
      if (!is.null(parts)) {
        p1$defs <- c(p1$defs, parts$name)
        if (is.call(parts$value) &&
            !(is.symbol(parts$value[[1L]]) &&
              identical(as.character(parts$value[[1L]]), "function"))) {
          collect_top_defs(parts$value, p1)
        }
      }
      return(invisible())
    }
    literal <- literal_eval_nodes(node, q$name)
    if (!is.null(literal)) {
      for (expr in literal) collect_top_defs(expr, p1)
      return(invisible())
    }
    if (identical(q$name, "rm") ||
        (identical(q$pkg, "base") && identical(q$name, "remove"))) {
      nms <- rm_target_names(node)
      if (!is.null(nms)) p1$defs <- c(p1$defs, nms)
      return(invisible())
    }
    if (q$name %in% c(MASK_VERBS, AES_VERBS)) {
      if (length(node) >= 2L) collect_top_defs(node[[2L]], p1)
      return(invisible())
    }
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) collect_top_defs(node[[j]], p1)
    }
    return(invisible())
  }
  literal <- literal_eval_nodes(node, hn)
  if (!is.null(literal)) {
    for (expr in literal) collect_top_defs(expr, p1)
    return(invisible())
  }
  if (identical(hn, "assign")) {
    parts <- literal_assign_parts(node)
    if (!is.null(parts)) {
      p1$defs <- c(p1$defs, parts$name)
      if (is.call(parts$value) &&
          !(is.symbol(parts$value[[1L]]) &&
            identical(as.character(parts$value[[1L]]), "function"))) {
        collect_top_defs(parts$value, p1)
      }
    }
    return(invisible())
  }
  if (hn %in% c("rm", "remove")) {
    nms <- rm_target_names(node)
    if (!is.null(nms)) p1$defs <- c(p1$defs, nms)
    return(invisible())
  }
  if (hn %in% c(MASK_VERBS, AES_VERBS) || hn == "~") {
    if (hn %in% c(MASK_VERBS, AES_VERBS) && length(node) >= 2L) {
      collect_top_defs(node[[2L]], p1)
    }
    return(invisible())
  }
  if (hn %in% c("<-", "=", "->")) {
    target <- if (hn == "->") node[[3L]] else node[[2L]]
    r <- lhs_root_name(target)
    if (length(r) && nzchar(r) && !is_reserved(r)) p1$defs <- c(p1$defs, r)
    val_idx <- if (hn == "->") 2L else 3L
    value <- node[[val_idx]]
    if (is.call(value)) {
      vh <- value[[1L]]
      if (!(is.symbol(vh) && as.character(vh) == "function")) {
        collect_top_defs(value, p1)
      }
    }
    return(invisible())
  }
  if (hn == "for") {
    ivar <- as.character(node[[2L]])
    if (length(ivar) && !is_reserved(ivar)) p1$defs <- c(p1$defs, ivar)
    for (j in 3:4) if (!is.null(node[[j]])) collect_top_defs(node[[j]], p1)
    return(invisible())
  }
  # brace, if, switch, and ordinary calls: recurse for nested possible defs.
  for (j in seq_along(node)[-1L]) {
    if (!is.null(node[[j]])) collect_top_defs(node[[j]], p1)
  }
  invisible()
}

new_frame <- function(defined, kind) {
  e <- new.env(parent = baseenv())
  e$defined <- unique(defined)
  e$kind <- kind
  e
}

new_ctx <- function(deferred = FALSE, mask = 0L, mask_mode = "warn") {
  list(deferred = deferred, mask = mask, mask_mode = mask_mode)
}

define_name <- function(nm, frame) {
  if (!is_reserved(nm)) frame$defined <- c(frame$defined, nm)
  invisible(nm)
}

# A call argument is lazily evaluated: an assignment inside it is never
# definitely available in the caller frame afterward. Scan it in an isolated
# frame that shares the current definitely-local set, so its reads are still
# classified but its definitions cannot leak into the caller.
walk_lazy_arg <- function(node, frame, ctx, state) {
  aframe <- new_frame(frame$defined, frame$kind)
  if (!is.null(node)) walk_expr(node, aframe, ctx, state)
  invisible()
}

record_read <- function(nm, frame, ctx, state) {
  if (!length(nm) || !nzchar(nm) || is_reserved(nm) || nm %in% frame$defined) {
    return(invisible())
  }
  if (ctx$deferred) {
    if (nm %in% state$defs) return(invisible())  # cell-local, deferred use
    state$refs <- c(state$refs, nm)
  } else {
    if (nm %in% state$defs) {
      if (nm %in% frame$defined) return(invisible())  # local read
      state$selfRefs <- c(state$selfRefs, nm)
    } else {
      state$refs <- c(state$refs, nm)
    }
  }
  invisible()
}

# Formula symbols can be tracked quietly, or treated as data columns when the
# formula is paired with an explicit `data=` argument. Other data masks retain
# the ambiguity warning because a bare name could genuinely select either a
# column or a notebook global.
mask_read <- function(nm, frame, ctx, state) {
  if (is_reserved(nm) || nm %in% frame$defined) return(invisible())
  mode <- ctx$mask_mode %||% "warn"
  if (identical(mode, "columns")) return(invisible())
  if (identical(mode, "quiet")) {
    rctx <- ctx
    rctx$mask <- 0L
    record_read(nm, frame, rctx, state)
    return(invisible())
  }
  state$refs <- c(state$refs, nm)
  if (!(nm %in% state$mask_warned)) {
    state$mask_warned <- c(state$mask_warned, nm)
    state$diagnostics <- c(state$diagnostics, list(list(
      level = "warning",
      code = "ambiguous-data-mask-reference",
      message = paste0("could be a data column or a notebook variable: ", nm),
      symbol = nm)))
  }
  invisible()
}

# Return formula and data argument positions when a call contains a literal
# formula together with an explicit `data=` argument. This covers base and
# package modelling APIs without a brittle function-name allowlist.
formula_data_indices <- function(node) {
  idx <- seq_along(node)[-1L]
  nms <- names(node)
  if (is.null(nms)) nms <- rep("", length(node))
  data_idx <- idx[nms[idx] == "data"]
  if (length(data_idx) != 1L) return(NULL)
  formula_idx <- idx[nms[idx] == "formula"]
  if (!length(formula_idx)) {
    formula_idx <- idx[vapply(idx, function(i) {
      arg <- node[[i]]
      is.call(arg) && is.symbol(arg[[1L]]) &&
        identical(as.character(arg[[1L]]), "~")
    }, logical(1))]
  }
  if (!length(formula_idx)) return(NULL)
  list(formula = formula_idx[[1L]], data = data_idx[[1L]])
}

walk_call_arguments <- function(node, frame, ctx, state) {
  formula_data <- formula_data_indices(node)
  for (j in seq_along(node)[-1L]) {
    if (is.null(node[[j]])) next
    arg_ctx <- ctx
    if (!is.null(formula_data) && identical(j, formula_data$formula)) {
      arg_ctx$mask_mode <- "columns"
    }
    walk_lazy_arg(node[[j]], frame, arg_ctx, state)
  }
  invisible()
}
rm_target_names <- function(node) {
  args <- as.list(node)[-1L]
  nms <- names(node)[-1L]
  if (length(nms) && any(nzchar(nms))) return(NULL)
  if (!length(args)) return(NULL)
  out <- vapply(args, function(arg) {
    literal_name_of(arg) %||% NA_character_
  }, character(1))
  if (anyNA(out) || any(is_reserved(out))) return(NULL)
  out
}

walk_rm <- function(node, frame, state) {
  nms <- rm_target_names(node)
  if (is.null(nms)) {
    add_block(state, "rm",
              paste0("rm() requires bare names or scalar string literals and ",
                     "only the default evaluation environment; use ",
                     "rm(\"name\") when the target is statically known"))
    return(character())
  }
  for (nm in nms) define_name(nm, frame)
  nms
}

walk_assign <- function(node, frame, ctx, state) {
  parts <- literal_assign_parts(node)
  if (is.null(parts)) {
    add_block(state, "assign",
              paste0("assign() requires a scalar string literal name and only ",
                     "the default evaluation environment; use name <- value ",
                     "when possible"))
    return(character())
  }
  if (is.call(parts$value) && is.symbol(parts$value[[1L]]) &&
      identical(as.character(parts$value[[1L]]), "function")) {
    walk_function(parts$value, frame, ctx, state, parts$name)
  } else {
    walk_expr(parts$value, frame, ctx, state)
  }
  define_name(parts$name, frame)
  parts$name
}

add_block <- function(state, symbol, message) {
  state$diagnostics <- c(state$diagnostics, list(list(
    level = "error", code = "dynamic-dependency",
    message = message, symbol = symbol)))
  invisible()
}

add_opaque <- function(state, symbol, message) {
  state$opaque <- TRUE
  state$barrier <- TRUE
  state$diagnostics <- c(state$diagnostics, list(list(
    level = "warning", code = "opaque-dependency",
    message = message, symbol = symbol)))
  invisible()
}

# Walk one expression in evaluation order. Mutates `frame$defined` (direct
# sequential definitions) and `state`; returns the names this subtree
# DEFINITELY adds to the frame (used by if/switch intersections).
walk_expr <- function(node, frame, ctx, state) {
  if (is.symbol(node)) {
    nm <- as.character(node)
    if (ctx$mask > 0L) {
      mask_read(nm, frame, ctx, state)
    } else {
      record_read(nm, frame, ctx, state)
    }
    return(character())
  }
  if (!is.call(node) || identical(node, quote(expr = ))) {
    return(character())
  }

  head <- node[[1L]]
  hn <- if (is.symbol(head)) as.character(head) else ""
  if (hn %in% c("::", ":::")) return(character())  # bare pkg::fn is inert

  q <- qualified_name(node)
  if (!is.null(q$name)) {
    return(walk_qualified(node, q$name, frame, ctx, state, q$pkg))
  }

  if (hn %in% c("<-", "=", "->", "->>", "<<-")) {
    return(walk_assignment(node, hn, frame, ctx, state))
  }
  if (hn == "function") {
    walk_function(node, frame, ctx, state, "")
    return(character())
  }
  if (hn %in% QUOTE_OPS) return(character())
  if (hn == "local") {
    lframe <- new_frame(frame$defined, "local")
    if (length(node) >= 2L && !is.null(node[[2L]])) {
      walk_expr(node[[2L]], lframe, ctx, state)
    }
    for (j in seq_along(node)[-(1:2)]) {
      if (!is.null(node[[j]])) walk_expr(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  if (hn == "substitute") {
    for (j in seq_along(node)[-(1:2)]) {
      if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  if (hn == "{") {
    out <- character()
    for (j in seq_along(node)[-1L]) {
      if (is.null(node[[j]])) next
      out <- c(out, walk_expr(node[[j]], frame, ctx, state))
    }
    return(unique(out))
  }
  if (hn == "if") {
    walk_expr(node[[2L]], frame, ctx, state)
    then_def <- walk_expr(node[[3L]], new_frame(frame$defined, frame$kind),
                          ctx, state)
    else_def <- if (length(node) >= 4L && !is.null(node[[4L]])) {
      walk_expr(node[[4L]], new_frame(frame$defined, frame$kind), ctx, state)
    } else character()
    common <- intersect(then_def, else_def)
    for (nm in common) define_name(nm, frame)
    return(common)
  }
  if (hn == "for") {
    walk_expr(node[[3L]], frame, ctx, state)
    ivar <- as.character(node[[2L]])
    body_defined <- frame$defined
    if (length(ivar) && !is_reserved(ivar)) body_defined <- c(body_defined, ivar)
    # The iterator is definite inside the body, but a zero-length sequence
    # means neither it nor body definitions are definite afterwards.
    walk_expr(node[[4L]], new_frame(body_defined, frame$kind), ctx, state)
    return(character())
  }
  if (hn == "while") {
    walk_expr(node[[2L]], frame, ctx, state)
    walk_expr(node[[3L]], new_frame(frame$defined, frame$kind), ctx, state)
    return(character())
  }
  if (hn == "repeat") {
    walk_expr(node[[2L]], new_frame(frame$defined, frame$kind), ctx, state)
    return(character())
  }
  if (hn %in% c("return")) {
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) walk_expr(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  if (hn == "switch") {
    walk_expr(node[[2L]], frame, ctx, state)
    common <- character()
    if (length(node) >= 3L) {
      common <- NULL
      for (j in 3:length(node)) {
        d <- walk_expr(node[[j]], new_frame(frame$defined, frame$kind),
                       ctx, state)
        common <- if (is.null(common)) d else intersect(common, d)
      }
      if (is.null(common)) common <- character()
    }
    for (nm in common) define_name(nm, frame)
    return(common)
  }
  if (hn == "~") {
    mctx <- ctx
    mctx$mask <- ctx$mask + 1L
    if (ctx$mask == 0L && identical(ctx$mask_mode %||% "warn", "warn")) {
      mctx$mask_mode <- "quiet"
    }
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) walk_expr(node[[j]], frame, mctx, state)
    }
    return(character())
  }
  if (hn %in% AES_VERBS) {
    mctx <- ctx
    mctx$mask <- ctx$mask + 1L
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) walk_expr(node[[j]], frame, mctx, state)
    }
    return(character())
  }
  if (hn %in% MASK_VERBS) {
    mctx <- ctx
    mctx$mask <- ctx$mask + 1L
    for (j in seq_along(node)[-1L]) {
      if (j == 2L) {
        walk_lazy_arg(node[[j]], frame, ctx, state)   # the data argument
      } else if (!is.null(node[[j]])) {
        walk_lazy_arg(node[[j]], frame, mctx, state)
      }
    }
    return(character())
  }
  if (hn %in% c("rm", "remove")) {
    return(walk_rm(node, frame, state))
  }
  if (identical(hn, "assign")) {
    return(walk_assign(node, frame, ctx, state))
  }
  if (hn %in% BLOCKED_DYNAMIC) {
    return(walk_blocked(node, hn, frame, ctx, state))
  }
  if (hn %in% c("library", "require")) {
    if (!ctx$deferred) state$barrier <- TRUE
    # arg 1 is the package name under NSE, never a notebook reference
    for (j in seq_along(node)[-(1:2)]) {
      if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  if (hn %in% c("[", "[[")) {
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) walk_expr(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  if (hn %in% c("$", "@")) {
    obj <- node[[2L]]
    if (is.symbol(obj) && as.character(obj) == ".data") {
      # data-column pronoun: not a notebook reference
    } else if (is.symbol(obj) && as.character(obj) == ".env") {
      elem <- node[[3L]]
      if (is.symbol(elem)) {
        # unambiguous notebook reference (never an ambiguous-mask warning)
        record_read(as.character(elem), frame, ctx, state)
      }
    } else {
      walk_expr(obj, frame, ctx, state)  # element name is static
    }
    return(character())
  }
  if (hn == "|>") {
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) walk_expr(node[[j]], frame, ctx, state)
    }
    return(character())
  }

  # Default: an ordinary call. The head is a reference unless it is a bare
  # operator or a non-symbol call head (e.g. `ui$slider(...)`), in which
  # case the head expression itself is walked; every argument is lazily
  # evaluated (isolated frame).
  if (!(hn %in% c(OPERATORS, RUNTIME_CALLS))) {
    if (nzchar(hn)) {
      record_read(hn, frame, ctx, state)
    } else {
      walk_expr(node[[1L]], frame, ctx, state)
    }
  }
  walk_call_arguments(node, frame, ctx, state)
  character()
}

# A namespace-qualified call `pkg::fn(...)`: fn belongs to the package, so
# the head is never a notebook reference; dispatch on fn's role.
walk_qualified <- function(node, name, frame, ctx, state, package = NULL) {
  if (name %in% c(MASK_VERBS, AES_VERBS)) {
    mctx <- ctx
    mctx$mask <- ctx$mask + 1L
    if (name %in% AES_VERBS) {
      for (j in seq_along(node)[-1L]) {
        if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, mctx, state)
      }
    } else {
      for (j in seq_along(node)[-1L]) {
        if (j == 2L) walk_lazy_arg(node[[j]], frame, ctx, state)
        else if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, mctx, state)
      }
    }
    return(character())
  }
  if (identical(name, "rm") ||
      (identical(package, "base") && identical(name, "remove"))) {
    return(walk_rm(node, frame, state))
  }
  if (identical(package, "base") && identical(name, "assign")) {
    return(walk_assign(node, frame, ctx, state))
  }
  if (name %in% BLOCKED_DYNAMIC) {
    return(walk_blocked(node, name, frame, ctx, state))
  }
  if (name %in% c("library", "require")) {
    if (!ctx$deferred) state$barrier <- TRUE
    for (j in seq_along(node)[-(1:2)]) {
      if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  walk_call_arguments(node, frame, ctx, state)
  character()
}

# Superassignment never creates a binding in the current environment and is
# a blocking dynamic mutation.
walk_assignment <- function(node, hn, frame, ctx, state) {
  right <- hn %in% c("->", "->>")
  if (right) {
    value <- node[[2L]]
    target <- node[[3L]]
  } else {
    target <- node[[2L]]
    value <- node[[3L]]
  }
  if (hn %in% c("<<-", "->>")) {
    r <- lhs_root_name(target)
    add_block(state, if (length(r) && nzchar(r)) r else NULL,
              "superassignment (<<- / ->>) cannot be analysed safely")
    return(character())
  }
  if (is.call(value) && is.symbol(value[[1L]]) &&
      as.character(value[[1L]]) == "function") {
    r <- lhs_root_name(target)
    recname <- if (length(r) && nzchar(r) && !is_reserved(r)) r else ""
    walk_function(value, frame, ctx, state, recname)
  } else {
    walk_expr(value, frame, ctx, state)
  }
  # compound assignment targets read their prior root value, the replacement
  # function, and any indices/arguments before defining the root
  if (is.call(target)) walk_expr(target, frame, ctx, state)
  r <- lhs_root_name(target)
  if (is.null(r)) {
    add_block(state, NULL,
              "compound assignment with no statically identifiable root")
    return(character())
  }
  if (is_reserved(r) || ctx$mask > 0L) return(character())
  define_name(r, frame)
  r
}

# A function definition: formals start local, defaults are scanned as
# deferred expressions with the formals and lexical parents in scope, and
# the body accumulates definitely-local names in evaluation order. Nested
# closures receive the enclosing function's definitely-local set as lexical
# parents. No body assignment becomes a notebook definition.
walk_function <- function(node, frame, ctx, state, recname = "") {
  formals <- node[[2L]]
  body <- node[[3L]]
  fnames <- names(formals)
  fnames <- fnames[!(fnames %in% c("", "..."))]
  base_def <- unique(c(frame$defined, fnames,
                       if (nzchar(recname)) recname else character()))
  fctx <- ctx
  fctx$deferred <- TRUE
  if (is.pairlist(formals)) {
    fml <- as.list(formals)
    for (j in seq_along(fml)) {
      # compare before binding: assigning the empty symbol would make the
      # local itself a missing argument
      if (identical(fml[[j]], quote(expr = ))) next
      d <- fml[[j]]
      if (!is.null(d)) walk_expr(d, new_frame(base_def, "fn"), fctx, state)
    }
  }
  walk_expr(body, new_frame(base_def, "fn"), fctx, state)
  invisible()
}

# Blocked dynamic operations, with support for literal lookup/do.call names.
walk_blocked <- function(node, name, frame, ctx, state) {
  literal <- literal_eval_nodes(node, name)
  if (!is.null(literal)) {
    out <- character()
    for (expr in literal) {
      out <- c(out, walk_expr(expr, frame, ctx, state))
    }
    return(unique(out))
  }
  if (identical(name, "source") && length(node) >= 2L &&
      !is.null(literal_name_of(node[[2L]], string_only = TRUE))) {
    add_opaque(
      state, "source",
      "source() reads a literal file at runtime; this cell is conservatively ordered"
    )
    for (j in seq_along(node)[-(1:2)]) {
      if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
    }
    return(character())
  }
  if (name %in% c("get", "get0", "mget", "exists", "dynGet") &&
      length(node) >= 2L && !is.null(node[[2L]])) {
    lit <- literal_name_of(node[[2L]], string_only = TRUE)
    if (!is.null(lit)) {
      record_read(lit, frame, ctx, state)
      for (j in seq_along(node)[-(1:2)]) {
        if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
      }
      return(character())
    }
  }
  if (name == "do.call" && length(node) >= 2L && !is.null(node[[2L]])) {
    lit <- literal_name_of(node[[2L]])
    if (!is.null(lit)) {
      if (lit %in% c(BLOCKED_DYNAMIC, "rm")) {
        add_block(state, lit,
                  paste0("non-literal or blocked target in do.call: ", lit))
        return(character())
      }
      if (lit %in% c("library", "require")) {
        if (!ctx$deferred) state$barrier <- TRUE
        for (j in seq_along(node)[-(1:2)]) {
          if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
        }
        return(character())
      }
      # ordinary literal do.call: the target is a function reference
      record_read(lit, frame, ctx, state)
      for (j in seq_along(node)[-(1:2)]) {
        if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
      }
      return(character())
    }
  }
  add_block(state, name,
            paste0(name, "() cannot be analysed safely"))
  character()
}

# Return expressions whose default-environment eval is statically visible.
# Explicit `envir`/`enclos` arguments remain blocked because their binding
# effects do not belong to the notebook environment.
literal_eval_nodes <- function(node, name) {
  if (!name %in% c("eval", "evalq") || length(node) != 2L) return(NULL)
  arg <- node[[2L]]
  if (identical(name, "evalq")) return(list(arg))
  if (!is.call(arg) || !is.symbol(arg[[1L]])) return(NULL)
  head <- as.character(arg[[1L]])
  if (identical(head, "quote") && length(arg) == 2L) return(list(arg[[2L]]))
  if (identical(head, "expression")) return(as.list(arg)[-1L])
  NULL
}
