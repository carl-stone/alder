# Static analysis: turn each cell's code into its top-level definitions,
# references, and self-references, then assemble a dependency DAG over the
# cells (ADR 0001's "notebook state corresponds to source"; ADR 0002's
# manual-rerun model).
#
# R is dynamically scoped and masking-heavy, so the analyzer favours
# over-approximating references (a missed dependency silently breaks stale
# marking, which is worse than a spurious one). Names that are provably local
# to a function body are excluded; everything else mentioned is a reference.
# Where code is too dynamic to analyse confidently, the cell reports a
# diagnostic instead of guessing (VISION: "understandable diagnostics when
# code is too dynamic to analyze safely").
#
# Evaluation order within a cell matters:
# - Eager reads (ordinary RHSs, subscripts of compound LHSs, control-flow
#   conditions) that happen before the cell's own first definition of the
#   same name are SELF references (`self_refs`): `x <- x + 1` reads x before
#   defining it, so the cell depends on its own prior value.
# - Deferred reads (function bodies, formal defaults) execute later and
#   never become self references; a same-cell definition just removes them
#   from the external `refs`.

# Names that are never notebook variables.
RESERVED <- c("NA", "TRUE", "FALSE", "NULL", "Inf", "NaN", "...", ".",
              "T", "F", "break", "next")

is_reserved <- function(nm) nm %in% RESERVED

# ---------------------------------------------------------------------------
# Per-cell analysis
# ---------------------------------------------------------------------------

cell_defs_refs <- function(code) {
  # Returns list(defs, refs, self_refs, error = NULL | msg).
  if (length(code) == 0L) {
    return(list(defs = character(), refs = character(),
                self_refs = character(), error = NULL))
  }
  text <- paste(code, collapse = "\n")
  exprs <- tryCatch(
    base::parse(text = text),
    error = function(e) conditionMessage(e)
  )
  if (is.character(exprs)) {
    return(list(defs = character(), refs = character(),
                self_refs = character(), error = exprs))
  }

  # Pass 1: every name defined at the top level of this cell, in order.
  defs <- new.env(parent = emptyenv())
  defs$defs <- character()
  for (i in seq_along(exprs)) collect_top_defs(exprs[[i]], defs)
  defs <- unique(defs$defs)

  # Pass 2: walk evaluation order. Reads of names this cell defines are
  # self references when they occur (eagerly) before that definition.
  state <- new.env(parent = emptyenv())
  state$defs_all <- defs
  state$refs <- character()
  state$self_refs <- character()
  state$defined_so_far <- character()
  for (i in seq_along(exprs)) scan_expr(exprs[[i]], character(), state, in_fn = FALSE)

  list(defs = defs,
       refs = unique(state$refs),
       self_refs = unique(state$self_refs),
       error = NULL)
}

# Names assigned by this top-level expression (walking call arguments, but
# not function bodies: their assignments are closure-local).
collect_top_defs <- function(node, defs) {
  if (!is.call(node) || length(node) < 2L) return(invisible())
  h <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else ""
  if (h == "function") return(invisible())
  if (h %in% c("<-", "=", "<<-")) {
    lhs <- node[[2L]]
  } else if (h %in% c("->", "->>")) {
    lhs <- node[[3L]]
  } else {
    lhs <- NULL
  }
  if (!is.null(lhs)) {
    nm <- lhs_def_root(lhs)
    if (length(nm) && nzchar(nm) && !is_reserved(nm)) defs$defs <- c(defs$defs, nm)
  }
  for (j in seq_along(node)[-1L]) {
    if (!is.null(node[[j]])) collect_top_defs(node[[j]], defs)
  }
  invisible()
}

# scan_expr walks one expression. `locals` holds names that are provably not
# notebook variables (function formals, function-body assignments, loop
# variables); it is passed BY VALUE so a function's locals can never leak
# into the enclosing scope. `in_fn` marks a deferred context (a function
# body or formal default): reads evaluate later, so same-cell names read
# there are neither refs nor self_refs. R's actual runtime scoping is
# dynamic, so this is intentionally a conservative approximation.
scan_expr <- function(node, locals, state, in_fn = FALSE) {
  if (is.symbol(node)) {
    nm <- as.character(node)
    if (is_reserved(nm) || (nm %in% locals)) return(invisible())
    if (nm %in% state$defs_all) {
      # Defined somewhere in this cell: same-cell use.
      if (!in_fn && !(nm %in% state$defined_so_far)) {
        state$self_refs <- c(state$self_refs, nm)  # read before own def
      }
    } else {
      state$refs <- c(state$refs, nm)
    }
    return(invisible())
  }
  if (!is.call(node)) return(invisible())  # literals: no refs

  head <- node[[1L]]
  head_name <- if (is.symbol(head)) as.character(head) else ""

  if (head_name %in% c("<-", "=", "<<-", "->", "->>")) {
    if (head_name %in% c("<-", "=", "<<-")) {
      value <- node[[3L]]
      target <- node[[2L]]
    } else {
      value <- node[[2L]]
      target <- node[[3L]]
    }
    # A function RHS may refer to its own name (recursion): the assignment
    # name is a local inside that closure only.
    nm <- lhs_def_root(target)
    extra <- character()
    if (length(nm) && nzchar(nm) && !is_reserved(nm) &&
        is.call(value) && identical(as.character(value[[1L]]), "function")) {
      extra <- nm
    }
    scan_expr(value, c(locals, extra), state, in_fn)
    # `<<-`: the target is a nonlocal reference when the scan is deferred
    # (function body); at top level it is a definition, not a read.
    if (head_name %in% c("<<-", "->>")) {
      if (in_fn) scan_expr(target, locals, state, in_fn)
    }
    scan_lhs_reads(target, locals, state, in_fn)
    if (!in_fn) define_lhs(target, state)
    return(invisible())
  }

  if (head_name == "function") {
    # The closure's own scope: formals, formal defaults and every `<-`
    # assignment in the body are local. `<<-`/`->>` targets are NOT local
    # (they reach enclosing frames) and are scanned as nonlocal references.
    f_locals <- unique(c(
      function_args(node[[2L]]),
      body_assigns(node[[3L]])
    ))
    body_locals <- c(f_locals, locals)
    scan_expr(node[[3L]], body_locals, state, in_fn = TRUE)
    # Formal defaults are deferred and see all formals as local.
    formals <- node[[2L]]
    if (is.pairlist(formals)) {
      fml <- as.list(formals)  # missing defaults become empty symbols
      for (nm in names(fml)) {
        # Extract inline: assigning the empty symbol to a variable would
        # turn it into a missing-argument error on later use.
        if (!identical(fml[[nm]], quote(expr = )) && !is.null(fml[[nm]])) {
          scan_expr(fml[[nm]], body_locals, state, in_fn = TRUE)
        }
      }
    }
    return(invisible())
  }

  if (head_name %in% c("::", ":::")) {
    # pkg::fun — package name is not a notebook variable; skip it.
    return(invisible())
  }

  if (head_name %in% c("$", "@")) {
    # x$y / x@y — the object is a reference; the element name is not.
    scan_expr(node[[2L]], locals, state, in_fn)
    return(invisible())
  }

  if (head_name %in% c("[[", "[")) {
    # x[i] / x[[i]] — object and index are references (index may be a name).
    for (j in seq_along(node)[-1]) scan_expr(node[[j]], locals, state, in_fn)
    return(invisible())
  }

  if (head_name %in% c("|>")) {
    # native pipe: both sides are eager references.
    for (j in seq_along(node)[-1]) scan_expr(node[[j]], locals, state, in_fn)
    return(invisible())
  }

  if (head_name %in% c("~", "formula")) {
    for (j in seq_along(node)[-1]) scan_expr(node[[j]], locals, state, in_fn)
    return(invisible())
  }

  if (head_name == "for") {
    # for (var in seq) body — var is local; seq and body are references.
    varname <- as.character(node[[2L]])
    scan_expr(node[[3L]], c(varname, locals), state, in_fn)
    scan_expr(node[[4L]], locals, state, in_fn)
    return(invisible())
  }

  if (head_name %in% c("while", "if", "repeat", "return")) {
    for (j in seq_along(node)[-1]) scan_expr(node[[j]], locals, state, in_fn)
    return(invisible())
  }

  # Default: a normal call. The function head is a reference (e.g. `filter`,
  # `ggplot`), and so are all arguments. The head may be a composite
  # expression (e.g. `pkg$fun`), which is scanned like any read.
  scan_expr(head, locals, state, in_fn)
  for (j in seq_along(node)[-1]) scan_expr(node[[j]], locals, state, in_fn)
  invisible()
}

# Eager reads an assignment target performs: bare `x <- v` reads nothing;
# `x[i] <- v`, `x[[i]] <- v`, `x$y <- v` and `x@y <- v` evaluate the root
# object and the subscripts before assignment.
scan_lhs_reads <- function(lhs, locals, state, in_fn) {
  if (!is.call(lhs) || length(lhs) < 2L) return(invisible())
  h <- as.character(lhs[[1L]])
  if (!(h %in% c("$", "@", "[[", "["))) return(invisible())
  scan_expr(lhs[[2L]], locals, state, in_fn)          # root object
  if (h %in% c("[", "[[")) {
    for (j in 3:length(lhs)) scan_expr(lhs[[j]], locals, state, in_fn)
  }
  invisible()
}

# Names assigned anywhere in a function body (including inside if/for/while
# and braced blocks, but NOT inside nested function definitions whose scope
# is their own). `<<-` and `->>` targets are excluded: they reach outside
# the closure and are scanned as nonlocal references instead.
body_assigns <- function(node) {
  out <- character()
  collect <- function(n) {
    if (!is.call(n)) return(invisible())
    h <- as.character(n[[1L]])
    if (h == "function") return(invisible())  # nested closure: own scope
    if (h %in% c("<-", "=", "->")) {
      lhs <- if (h == "->") n[[3L]] else n[[2L]]
      nm <- lhs_def_root(lhs)
      if (length(nm) && nzchar(nm) && !is_reserved(nm)) out <<- c(out, nm)
    }
    if (h == "for" && length(n) >= 2L) {
      vn <- as.character(n[[2L]])
      if (length(vn) && !is_reserved(vn)) out <<- c(out, vn)
    }
    for (j in seq_along(n)[-1]) {
      if (!is.null(n[[j]])) collect(n[[j]])
    }
    invisible()
  }
  collect(node)
  out
}

# Capture a definition name from an assignment LHS, handling x, x[i],
# x$y, x[[i]] (the root object name is what's defined).
define_lhs <- function(lhs, state) {
  nm <- lhs_def_root(lhs)
  if (length(nm) && nzchar(nm) && !is_reserved(nm)) {
    state$defined_so_far <- c(state$defined_so_far, nm)
  }
}

lhs_def_root <- function(lhs) {
  while (is.call(lhs) && length(lhs) >= 2L) {
    h <- as.character(lhs[[1L]])
    if (h %in% c("[", "[[", "$", "@")) lhs <- lhs[[2L]]
    else break
  }
  if (is.symbol(lhs)) as.character(lhs) else character(0)
}

function_args <- function(formals) {
  # formals is a pairlist; names are the argument names.
  argn <- names(formals)
  argn[!(argn %in% c("", "..."))]
}
# ---------------------------------------------------------------------------
# Dependency DAG
# ---------------------------------------------------------------------------

build_dag <- function(cells) {
  # cells: list of cells with $id and analyzed defs/refs ($defs, $refs,
  # $self_refs). Returns list(nodes, edges, duplicates, cycles, error).
  n <- length(cells)
  if (n == 0L) {
    return(list(nodes = list(), edges = list(), duplicates = list(),
                cycles = list(), error = NULL))
  }

  ids <- vapply(cells, function(c) c$id, "")
  defof <- new.env(parent = emptyenv())  # name -> character ids defining it
  refs <- vector("list", n)
  names(refs) <- ids

  for (i in seq_along(cells)) {
    c <- cells[[i]]
    refs[[c$id]] <- c$refs %||% character()
    for (d in c$defs) {
      defof[[d]] <- c(defof[[d]], c$id)
    }
  }

  # Edge A -> B when B references a name A defines.
  edges <- vector("list", n)
  names(edges) <- ids
  for (i in seq_along(cells)) {
    ci <- cells[[i]]
    deps <- character()
    for (r in unique(ci$refs)) {
      producers <- defof[[r]]
      if (length(producers)) deps <- c(deps, producers)
    }
    deps <- unique(setdiff(deps, ci$id))
    # A cell that reads a name before defining it depends on its own prior
    # value (`x <- x + 1`): a self-loop marks it stale on itself.
    if (length(ci$self_refs %||% character())) deps <- c(deps, ci$id)
    edges[[ci$id]] <- deps
  }

  # Duplicate/contradictory definitions: a name defined by >1 cell.
  duplicates <- list()
  nm_names <- ls(defof, all.names = TRUE)
  for (nm in nm_names) {
    if (length(defof[[nm]]) > 1L) duplicates[[nm]] <- defof[[nm]]
  }

  cycles <- detect_cycles(edges, ids)

  list(nodes = ids, edges = edges, duplicates = duplicates,
       cycles = cycles, error = NULL)
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# Topological order of cell execution: a cell before its dependents.
# Repeatedly emit every cell whose remaining dependencies are already
# emitted (Kahn's algorithm); deterministic in input order.
# Returns a character vector, or NULL if the graph has a cycle (including
# self-loops, whose cells can never satisfy their own dependency).
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
    ws <- edges[[v]]
    for (w in ws) {
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
      self_loop <- length(comp) == 1L && v %in% (edges[[v]] %||% character())
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