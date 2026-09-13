err_codes <- function(r) {
  vapply(r$diagnostics, function(d) d$code, "")
}
err_levels <- function(r) {
  vapply(r$diagnostics, function(d) d$level, "")
}
has_error <- function(r, code = "dynamic-dependency") {
  any(err_levels(r) == "error" & err_codes(r) == code)
}
has_mask_warning <- function(r, nm) {
  any(vapply(r$diagnostics, function(d) {
    d$level == "warning" && d$code == "ambiguous-data-mask-reference" &&
      identical(d$symbol, nm)
  }, FALSE))
}

test_that("cell_defs_refs finds top-level definitions and references", {
  p <- alder:::cell_defs_refs("raw <- readr::read_csv('counts.csv')")
  expect_true("raw" %in% p$defs)
  expect_false("readr" %in% p$refs)   # package name is not a variable
  expect_null(p$error)
  expect_false(p$barrier)
  expect_length(p$diagnostics, 0)
})

test_that("ordinary R database calls need no special cell type", {
  p <- alder:::cell_defs_refs(
    "result <- DBI::dbGetQuery(connection, 'SELECT * FROM measurements')"
  )
  expect_identical(p$defs, "result")
  expect_true("connection" %in% p$refs)
  expect_false("DBI" %in% p$refs)
  expect_length(p$diagnostics, 0L)
  expect_null(p$error)
})

test_that("function-local names and args are excluded from top-level refs", {
  p <- alder:::cell_defs_refs("f <- function(a, b) { local <- a + b; local * GLOBAL }")
  expect_true("f" %in% p$defs)
  expect_true("GLOBAL" %in% p$refs)   # free variable inside the body
  expect_false("a" %in% p$refs)
  expect_false("b" %in% p$refs)
  expect_false("local" %in% p$refs)
  expect_false("local" %in% p$defs)
})

test_that("function args do not leak into sibling top-level expressions", {
  p <- alder:::cell_defs_refs(c("f <- function(x) x + 1", "y <- x * 2"))
  expect_true("x" %in% p$refs)
  expect_false("x" %in% p$defs)
  expect_true("f" %in% p$defs)
  expect_true("y" %in% p$defs)
})

test_that("R lookup order is respected inside function bodies", {
  # y is read before x is defined in the body, so x is a free variable:
  # R resolves it in the enclosing (notebook) scope, matching actual R.
  p <- alder:::cell_defs_refs("f <- function() { y <- x * 2; x <- 1 }")
  expect_true("x" %in% p$refs)
  expect_false("x" %in% p$defs)
  expect_false("y" %in% p$refs)
  # after a preceding definition the same read is local
  p2 <- alder:::cell_defs_refs("f <- function() { x <- 1; y <- x * 2 }")
  expect_false("x" %in% p2$refs)
  expect_false("x" %in% p2$defs)
  expect_false("y" %in% p2$refs)
})

test_that("eager self-update records a self reference", {
  p <- alder:::cell_defs_refs("x <- x + 1")
  expect_true("selfRefs" %in% names(p))
  expect_false("self_refs" %in% names(p))
  expect_true("x" %in% p$selfRefs)
  expect_false("x" %in% p$refs)
  p2 <- alder:::cell_defs_refs(c("y <- x", "x <- 1"))
  expect_true("x" %in% p2$selfRefs)
  expect_true("y" %in% p2$defs)
})

test_that("reads after the cell's own definition are not self refs", {
  p <- alder:::cell_defs_refs(c("x <- 1", "y <- x + 1"))
  expect_false("x" %in% p$selfRefs)
  expect_false("x" %in% p$refs)
  expect_true("y" %in% p$defs)
})

test_that("deferred closure reads of later definitions are cell-local", {
  p <- alder:::cell_defs_refs(c("f <- function() x", "x <- 1"))
  expect_false("x" %in% p$refs)
  expect_false("x" %in% p$selfRefs)
  # a deferred read of a name the cell never defines stays external
  p2 <- alder:::cell_defs_refs("f <- function() x")
  expect_true("x" %in% p2$refs)
  # an eager read of such a name still creates the self edge
  p3 <- alder:::cell_defs_refs(c("f <- function() x", "f()", "x <- x + 1"))
  expect_true("x" %in% p3$selfRefs)
  expect_false("x" %in% p3$refs)
})

test_that("recursion is local, and the assigned name stays local inside the closure", {
  p <- alder:::cell_defs_refs("f <- function() f()")
  expect_false("f" %in% p$refs)
  expect_false("f" %in% p$selfRefs)
  expect_true("f" %in% p$defs)
})

test_that("formal defaults are scanned with all formals local", {
  p <- alder:::cell_defs_refs("f <- function(a, b = a + 1) b")
  expect_false("a" %in% p$refs)
  expect_false("b" %in% p$refs)
  p2 <- alder:::cell_defs_refs("f <- function(a = G + 1) a")
  expect_true("G" %in% p2$refs)            # free variable in a default
  p3 <- alder:::cell_defs_refs(c("f <- function(a = G + 1) a", "G <- 2"))
  expect_false("G" %in% p3$refs)           # defined later in the same cell
  expect_false("G" %in% p3$selfRefs)
})

test_that("a lazy call argument is never definitely available afterward", {
  p <- alder:::cell_defs_refs(c("foo(x <- 1)", "y <- x"))
  # x is only a candidate definition; the read must remain a self reference
  expect_true("x" %in% p$defs)
  expect_true("x" %in% p$selfRefs)
  expect_false("x" %in% p$refs)
  expect_true("y" %in% p$defs)
  # the same name read as a plain argument before its own definition:
  p2 <- alder:::cell_defs_refs(c("foo(x)", "x <- 1"))
  expect_true("x" %in% p2$selfRefs)
})

test_that("a zero-length top-level for still defines its iterator", {
  p <- alder:::cell_defs_refs("for (i in integer(0)) x <- i")
  expect_true("i" %in% p$defs)
  expect_true("x" %in% p$defs)             # possible loop-body definition
  p2 <- alder:::cell_defs_refs(c(
    "for (i in integer(0)) x <- i",
    "y <- i"
  ))
  expect_true("i" %in% p2$selfRefs)       # iterator may never become available
})

test_that("conditional definitions are definite only when every branch defines", {
  p <- alder:::cell_defs_refs("f <- function(a) { if (a) x <- 1; z <- x }")
  expect_true("x" %in% p$refs)             # x may be unresolved after the if
  p2 <- alder:::cell_defs_refs("f <- function(a) { if (a) x <- 1 else x <- 2; z <- x }")
  expect_false("x" %in% p2$refs)           # both branches define x
  p3 <- alder:::cell_defs_refs("sw <- switch(k, a = x <- 1, b = x <- 2)")
  expect_true("x" %in% p3$defs)            # possible under either alternative
  expect_true("k" %in% p3$refs)
})

test_that("quote/expression/local carry their own scopes", {
  expect_false("q" %in% alder:::cell_defs_refs("quote(q <- 1)")$defs)
  expect_false("w" %in% alder:::cell_defs_refs("expression(w <- 1)")$defs)
  expect_false("v" %in% alder:::cell_defs_refs("alist(v <- 1)")$defs)
  expect_false("y" %in% alder:::cell_defs_refs("local({ y <- 5 })")$defs)
  # unresolved reads inside local() still reference the notebook
  p <- alder:::cell_defs_refs(c("local({ y <- 5 })", "z <- y"))
  expect_true("y" %in% p$refs)
  expect_true("z" %in% p$defs)
})

test_that("supported replacement assignments read roots and indices", {
  p <- alder:::cell_defs_refs("x[i] <- v")
  expect_true("x" %in% p$selfRefs)
  expect_true("i" %in% p$refs)
  expect_true("v" %in% p$refs)
  p2 <- alder:::cell_defs_refs(c("x <- 1", "x[2] <- 2"))
  expect_false("x" %in% p2$selfRefs)      # already defined earlier
  p3 <- alder:::cell_defs_refs("x$col <- 1")
  expect_true("x" %in% p3$selfRefs)
  p4 <- alder:::cell_defs_refs("names(x) <- c(\"a\", \"b\")")
  expect_true("x" %in% p4$selfRefs)
  expect_true("x" %in% p4$defs)
  p5 <- alder:::cell_defs_refs("attr(y, \"k\") <- 1")
  expect_true("y" %in% p5$selfRefs)
  p6 <- alder:::cell_defs_refs("names(z)[1] <- \"w\"")
  expect_true("z" %in% p6$selfRefs)
  expect_true("z" %in% p6$defs)
})

test_that("a plain assignment does not read its LHS", {
  p <- alder:::cell_defs_refs("x <- 1")
  expect_false("x" %in% p$selfRefs)
  expect_false("x" %in% p$refs)
})

test_that("superassignment is a blocking dynamic mutation", {
  p <- alder:::cell_defs_refs("f <- function() { g <<- 1 }")
  expect_true("f" %in% p$defs)
  expect_false("g" %in% p$refs)            # not a normal binding either
  expect_true(has_error(p))
  p2 <- alder:::cell_defs_refs("f <- function() { 1 ->> h }")
  expect_true(has_error(p2))
})

test_that("replacement targets without a static root are blocked", {
  p <- alder:::cell_defs_refs("get(\"z\")[1] <- 1")
  expect_true(has_error(p))
  expect_true("z" %in% p$refs)             # literal lookup is still a read
  p2 <- alder:::cell_defs_refs("do.call(\"get\", list(\"a\"))[1] <- 1")
  expect_true(has_error(p2))
})

test_that("literal default-environment assign and rm are statically bounded", {
  assigned <- alder:::cell_defs_refs(
    "assign(\"assigned_value\", input + 1L)"
  )
  expect_false(has_error(assigned))
  expect_identical(assigned$defs, "assigned_value")
  expect_identical(assigned$refs, "input")

  reordered <- alder:::cell_defs_refs(
    "base::assign(value = input + 2L, x = \"qualified_value\")"
  )
  expect_false(has_error(reordered))
  expect_identical(reordered$defs, "qualified_value")
  expect_identical(reordered$refs, "input")

  self_update <- alder:::cell_defs_refs(
    "assign(x = \"counter\", value = counter + 1L)"
  )
  expect_identical(self_update$defs, "counter")
  expect_identical(self_update$selfRefs, "counter")

  removed <- alder:::cell_defs_refs(c("x <- 1L", "rm(\"x\")"))
  expect_false(has_error(removed))
  expect_identical(removed$defs, "x")
  expect_false("x" %in% removed$refs)
  removed_alias <- alder:::cell_defs_refs(c("y <- 1L", "remove(\"y\")"))
  expect_false(has_error(removed_alias))
  expect_identical(removed_alias$defs, "y")
  qualified_rm <- alder:::cell_defs_refs(c("z <- 1L", "base::rm(\"z\")"))
  expect_false(has_error(qualified_rm))
  expect_identical(qualified_rm$defs, "z")

})

test_that("computed or explicit-environment mutation blocks dispatch", {
  computed <- alder:::cell_defs_refs("assign(target, 1L)")
  expect_true(has_error(computed))
  expect_true("range" %in% names(computed$diagnostics[[1L]]))
  expect_null(computed$diagnostics[[1L]]$range)
  expect_match(computed$diagnostics[[1L]]$message,
               "scalar string literal name", fixed = TRUE)
  explicit <- alder:::cell_defs_refs(
    "assign(\"x\", 1L, envir = target_env)"
  )
  expect_true(has_error(explicit))
  expect_match(explicit$diagnostics[[1L]]$message,
               "default evaluation environment", fixed = TRUE)
  expect_true(has_error(alder:::cell_defs_refs("base::assign(target, 1L)")))

  computed_rm <- alder:::cell_defs_refs("rm(list = target)")
  expect_true(has_error(computed_rm))
  expect_match(computed_rm$diagnostics[[1L]]$message,
               "bare names or scalar string literals", fixed = TRUE)
  expect_true(has_error(alder:::cell_defs_refs(
    "rm(\"x\", envir = target_env)"
  )))
  expect_true(has_error(alder:::cell_defs_refs("remove(list = target)")))
})

test_that("unsafe dynamic evaluation blocks dispatch", {
  expect_true(has_error(alder:::cell_defs_refs("eval(parse(text = \"x <- 1\"))")))
  expect_true(has_error(alder:::cell_defs_refs("base::eval(x)")))
  literal_eval <- alder:::cell_defs_refs("eval(quote(x <- input + 1))")
  expect_false(has_error(literal_eval))
  expect_true("x" %in% literal_eval$defs)
  expect_true("input" %in% literal_eval$refs)
  literal_source <- alder:::cell_defs_refs("source(\"file.R\", local = TRUE)")
  expect_false(has_error(literal_source))
  expect_true(literal_source$opaque)
  expect_true(literal_source$barrier)
  expect_true("opaque-dependency" %in% err_codes(literal_source))
  expect_true(has_error(alder:::cell_defs_refs("source(path_var)")))
  expect_true(has_error(alder:::cell_defs_refs("sys.source(\"file.R\")")))
  expect_true(has_error(alder:::cell_defs_refs("load(\"x.RData\")")))
  expect_true(has_error(alder:::cell_defs_refs("attach(list(a = 1))")))
  expect_true(has_error(alder:::cell_defs_refs("detach(\"pkg\")")))
  expect_true(has_error(alder:::cell_defs_refs("delayedAssign(\"x\", 1)")))
  expect_true(has_error(alder:::cell_defs_refs("makeActiveBinding(\"x\", f, e)")))
  expect_true(has_error(alder:::cell_defs_refs("exists(nm)")))
  expect_true(has_error(alder:::cell_defs_refs("get(x_var)")))
  # do.call with a symbol target names a known function reference, but a
  # computed (non-literal) target can never be analysed safely
  expect_true(has_error(alder:::cell_defs_refs("do.call(f[[1]], a)")))
  expect_true(has_error(alder:::cell_defs_refs("do.call(get(\"x\"), a)")))
  # parse() on its own is data and stays analyzable
  p <- alder:::cell_defs_refs("p <- parse(text = \"x <- 1\")")
  expect_false(has_error(p))
  expect_true("p" %in% p$defs)
})


test_that("literal lookup and do.call names are supported", {
  p <- alder:::cell_defs_refs("get(\"n_cells\")")
  expect_true("n_cells" %in% p$refs)
  expect_false(has_error(p))
  p2 <- alder:::cell_defs_refs("do.call(\"mean\", list(x))")
  expect_true("mean" %in% p2$refs)
  expect_true("x" %in% p2$refs)
  expect_false(has_error(p2))
  p3 <- alder:::cell_defs_refs("do.call(rbind, list(a, b))")
  expect_true(all(c("rbind", "a", "b") %in% p3$refs))
  expect_false(has_error(p3))
  # a literal target that is itself blocked cannot bypass the block
  expect_true(has_error(alder:::cell_defs_refs("do.call(\"eval\", list(e))")))
})

test_that("package-attach barriers are detected with NSE package names", {
  p <- alder:::cell_defs_refs("library(dplyr)")
  expect_true(p$barrier)
  expect_false("dplyr" %in% p$refs)        # NSE: the package name is not a read
  p2 <- alder:::cell_defs_refs("base::library(dplyr)")
  expect_true(p2$barrier)
  p3 <- alder:::cell_defs_refs("z <- library(tidyverse)")
  expect_true(p3$barrier)
  # a deferred (function-body) package load is not a top-level barrier
  p4 <- alder:::cell_defs_refs("f <- function() library(dplyr)")
  expect_false(p4$barrier)
  # do.call routes a literal library target to the barrier
  p5 <- alder:::cell_defs_refs("do.call(\"library\", list(\"dplyr\"))")
  expect_true(p5$barrier)
})

test_that(".data and .env pronouns separate columns from notebook names", {
  p <- alder:::cell_defs_refs("p <- ggplot(d, aes(.data$Sepal.Length, .env$k))")
  expect_false("Sepal.Length" %in% p$refs) # a data column, not a variable
  expect_true("k" %in% p$refs)             # .env is an unambiguous reference
  expect_true("d" %in% p$refs)
  expect_false(any(err_levels(p) == "warning"))
  expect_true("p" %in% p$defs)
})

test_that("bare data-mask symbols warn and stay references", {
  p <- alder:::cell_defs_refs("p <- ggplot(d, aes(x, y))")
  expect_true("x" %in% p$refs)
  expect_true("y" %in% p$refs)
  expect_true(has_mask_warning(p, "x"))
  expect_true(has_mask_warning(p, "y"))
  # subset / with / mutate behave the same, without promoting assignments
  p2 <- alder:::cell_defs_refs("subset(peng, Sepal.Length > 5)")
  expect_true("peng" %in% p2$refs)
  expect_true("Sepal.Length" %in% p2$refs)
  expect_true(has_mask_warning(p2, "Sepal.Length"))
  p3 <- alder:::cell_defs_refs("with(df, x * 2)")
  expect_true(all(c("df", "x") %in% p3$refs))
  expect_true(has_mask_warning(p3, "x"))
  p4 <- alder:::cell_defs_refs("dplyr::mutate(d, z = mean(x))")
  expect_false("z" %in% p4$defs)           # columns are never notebook defs
  expect_true(all(c("d", "mean", "x") %in% p4$refs))
  expect_true(has_mask_warning(p4, "x"))
})

test_that("formulas track globals quietly and respect explicit data", {
  standalone <- alder:::cell_defs_refs("form <- y ~ poly(x, 2)")
  expect_true(all(c("y", "poly", "x") %in% standalone$refs))
  expect_false(any(err_levels(standalone) == "warning"))

  model <- alder:::cell_defs_refs(
    "fit <- stats::lm(mpg ~ poly(wt, 2) + .env$offset, data = mtcars)"
  )
  expect_true(all(c("poly", "offset", "mtcars") %in% model$refs))
  expect_false(any(c("mpg", "wt") %in% model$refs))
  expect_false(any(err_levels(model) == "warning"))
})

test_that("syntax errors are reported as diagnostics, not crashes", {
  r <- alder:::cell_defs_refs("x <- ")
  expect_false(is.null(r$error))
  expect_length(r$defs, 0)
})

test_that("cells referencing a function defined in another cell edge properly", {
  p <- alder:::cell_defs_refs("g <- f(1)")
  expect_true("f" %in% p$refs)
  expect_true("g" %in% p$defs)
})
