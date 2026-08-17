# Static analysis: R evaluation-order scoping walk (ADR 0001's "notebook
# state corresponds to source"; ADR 0002's reactive dependency model).
#
# R is dynamically typed and masking-heavy, so the analyzer favours
# over-approximating references (a missed dependency silently breaks stale
# marking, which is worse than a spurious one). Names provably local to a
# function body are excluded; everything else a cell reads eagerly is a
# reference, and a read of a name the cell itself defines — before that
# definition executes — is a self-references. Where code is too dynamic to
# analyse confidently, the cell reports a blocking error diagnostic instead
# of guessing (VISION: "understandable diagnostics when code is too dynamic
# to analyze safely").
#
# Evaluation order within a cell matters:
# - Eager reads (ordinary RHSs, compound-LHS subscripts, control-flow
#   conditions) that happen before the cell's own first unconditional
#   definition of the same name are SELF references: `x <- x + 1` reads x
#   before defining it, so the cell depends on its own prior value.
# - Deferred reads (function bodies, formal defaults, lazy arguments) execute
#   later; a name the cell defines anywhere is cell-local there, while a
#   name the cell never defines remains an external reference.
# - A definition is definitely available afterwards only when it is a direct
#   sequential assignment, a `for` iterator, or on every branch of an
#   if/switch. Definitions inside loop bodies and lazily evaluated call
#   arguments are never definitely available afterwards.

# Names that are never notebook variables.
RESERVED <- c("NA", "TRUE", "FALSE", "NULL", "Inf", "NaN", "...", ".", "T",
              "F", "break", "next", ".data", ".env")

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
  "assign", "rm", "get", "get0", "mget", "exists", "dynGet", "do.call")

is_reserved <- function(nm) nm %in% RESERVED

# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Per-cell analysis
# ---------------------------------------------------------------------------

cell_defs_refs <- function(code) {
  # Returns list(defs, refs, self_refs, barrier, diagnostics, error).
  empty <- list(defs = character(), refs = character(),
                self_refs = character(), barrier = FALSE,
                diagnostics = list(), error = NULL)
  if (length(code) == 0L) return(empty)
  text <- paste(code, collapse = "\n")
  exprs <- tryCatch(base::parse(text = text),
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
  state$self_refs <- character()
  state$barrier <- FALSE
  state$diagnostics <- list()
  state$mask_warned <- character()

  top <- new_frame(character(), "top")
  for (i in seq_along(exprs)) walk_expr(exprs[[i]], top, new_ctx(), state)

  list(defs = state$defs,
       refs = unique(state$refs),
       self_refs = unique(state$self_refs),
       barrier = isTRUE(state$barrier),
       diagnostics = state$diagnostics,
       error = NULL)
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
    if (q$name %in% c(MASK_VERBS, AES_VERBS)) {
      if (length(node) >= 2L) collect_top_defs(node[[2L]], p1)
      return(invisible())
    }
    for (j in seq_along(node)[-1L]) {
      if (!is.null(node[[j]])) collect_top_defs(node[[j]], p1)
    }
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

# ---------------------------------------------------------------------------
# Evaluation-order scope walk (pass 2)
# ---------------------------------------------------------------------------

new_frame <- function(defined, kind) {
  e <- new.env(parent = baseenv())
  e$defined <- unique(defined)
  e$kind <- kind
  e
}

new_ctx <- function(deferred = FALSE, mask = 0L) {
  list(deferred = deferred, mask = mask)
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
      state$self_refs <- c(state$self_refs, nm)
    } else {
      state$refs <- c(state$refs, nm)
    }
  }
  invisible()
}

# A bare value symbol in a data-mask context: conservative reference plus an
# ambiguity warning (it may be a column or a notebook variable).
mask_read <- function(nm, frame, state) {
  if (is_reserved(nm) || nm %in% frame$defined) return(invisible())
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

add_block <- function(state, symbol, message) {
  state$diagnostics <- c(state$diagnostics, list(list(
    level = "error", code = "dynamic-dependency",
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
      mask_read(nm, frame, state)
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
    return(walk_qualified(node, q$name, frame, ctx, state))
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
    if (length(ivar) && !is_reserved(ivar)) define_name(ivar, frame)
    # body definitions are never definitely available afterwards
    walk_expr(node[[4L]], new_frame(frame$defined, frame$kind), ctx, state)
    return(if (length(ivar) && !is_reserved(ivar)) ivar else character())
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
  if (!(hn %in% OPERATORS)) {
    if (nzchar(hn)) {
      record_read(hn, frame, ctx, state)
    } else {
      walk_expr(node[[1L]], frame, ctx, state)
    }
  }
  for (j in seq_along(node)[-1L]) {
    if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
  }
  character()
}

# A namespace-qualified call `pkg::fn(...)`: fn belongs to the package, so
# the head is never a notebook reference; dispatch on fn's role.
walk_qualified <- function(node, name, frame, ctx, state) {
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
  for (j in seq_along(node)[-1L]) {
    if (!is.null(node[[j]])) walk_lazy_arg(node[[j]], frame, ctx, state)
  }
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
      if (lit %in% BLOCKED_DYNAMIC) {
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

# ---------------------------------------------------------------------------
# Dependency DAG
# ---------------------------------------------------------------------------

build_dag <- function(cells) {
  # cells: list of cells with $id, $type, analyzed $defs/$refs/$self_refs,
  # and $barrier. Returns list(nodes, edges, duplicates, cycles, error).
  n <- length(cells)
  if (n == 0L) {
    return(list(nodes = list(), edges = list(), duplicates = list(),
                cycles = list(), error = NULL))
  }
  ids <- vapply(cells, function(c) c$id, "")
  defof <- new.env(parent = emptyenv())  # name -> character ids defining it
  barrier_at <- which(vapply(cells, function(c) isTRUE(c$barrier), FALSE))

  edges <- vector("list", n)
  names(edges) <- ids
  for (i in seq_along(cells)) edges[[ids[[i]]]] <- character()

  for (i in seq_along(cells)) {
    c <- cells[[i]]
    for (d in c$defs) defof[[d]] <- c(defof[[d]], c$id)
  }

  # Edge A -> B when B references a name A defines; plus each cell's own
  # self references (read-before-define) as a self-loop.
  for (i in seq_along(cells)) {
    ci <- cells[[i]]
    deps <- character()
    for (r in unique(ci$refs)) {
      producers <- defof[[r]]
      if (length(producers)) deps <- c(deps, producers)
    }
    deps <- unique(setdiff(deps, ci$id))
    if (length(ci$self_refs)) deps <- c(deps, ci$id)
    edges[[ci$id]] <- deps
  }

  # Package-attach barriers order every later code cell after the barrier:
  # a successful barrier run invalidates/reruns code whose lookup can change.
  for (i in barrier_at) {
    for (j in seq_len(n)) {
      if (j > i && identical(cells[[j]]$type, "code")) {
        edges[[cells[[j]]$id]] <- c(edges[[cells[[j]]$id]], cells[[i]]$id)
      }
    }
  }
  for (i in seq_along(cells)) edges[[ids[[i]]]] <- unique(edges[[ids[[i]]]])

  # Contradictory definitions: a name defined by >1 cell.
  duplicates <- list()
  for (nm in ls(defof, all.names = TRUE)) {
    defs <- defof[[nm]]
    if (length(unique(defs)) > 1L) duplicates[[nm]] <- unique(defs)
  }

  cycles <- detect_cycles(edges, ids)
  list(nodes = ids, edges = edges, duplicates = duplicates,
       cycles = cycles, error = NULL)
}

# Topological order of cell execution: a cell before its dependents.
# Repeatedly emit every cell whose remaining dependencies are already
# emitted (Kahn's algorithm); deterministic in input order. Returns a
# character vector, or NULL when the graph has a cycle (including self-loops,
# whose cells can never satisfy their own dependency).
topo_order <- function(edges, ids) {
  remaining <- ids
  order <- character()
  while (length(remaining) > 0L) {
    ready <- remaining[vapply(remaining, function(id)
      length(intersect(edges[[id]], remaining)) == 0L, FALSE)]
    if (length(ready) == 0L) break
    order <- c(order, ready)
    remaining <- setdiff(remaining, ready)
  }
  if (length(remaining) > 0L) return(NULL)
  order
}

# Deterministic strongly connected components (Tarjan, input-order
# iteration): returns a flat input-order vector of every cell in an SCC of
# size > 1 plus every explicit self-loop.
detect_cycles <- function(edges, ids) {
  if (length(ids) == 0L) return(character())
  idx <- setNames(rep(NA_integer_, length(ids)), ids)
  low <- setNames(rep(NA_integer_, length(ids)), ids)
  on_stack <- setNames(rep(FALSE, length(ids)), ids)
  stack <- character()
  counter <- 0L
  members <- character()
  visit <- function(v) {
    counter <<- counter + 1L
    idx[[v]] <<- counter
    low[[v]] <<- counter
    stack <<- c(stack, v)
    on_stack[[v]] <<- TRUE
    for (w in edges[[v]]) {
      if (is.na(idx[[w]])) {
        visit(w)
        low[[v]] <<- min(low[[v]], low[[w]])
      } else if (on_stack[[w]]) {
        low[[v]] <<- min(low[[v]], idx[[w]])
      }
    }
    if (identical(low[[v]], idx[[v]])) {
      comp <- character()
      repeat {
        w <- stack[[length(stack)]]
        stack <<- stack[-length(stack)]
        on_stack[[w]] <<- FALSE
        comp <- c(comp, w)
        if (identical(w, v)) break
      }
      self_loop <- length(comp) == 1L && v %in% edges[[v]]
      if (length(comp) > 1L || self_loop) members <<- c(members, comp)
    }
    invisible()
  }
  for (id in ids) {
    if (is.na(idx[[id]])) visit(id)
  }
  u <- unique(members)
  u[order(match(u, ids))]
}
