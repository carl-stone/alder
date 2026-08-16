test_that("cell_defs_refs finds top-level definitions and references", {
  p <- alder:::cell_defs_refs("raw <- readr::read_csv('counts.csv')")
  expect_true("raw" %in% p$defs)
  p2 <- alder:::cell_defs_refs("filtered <- raw |> dplyr::filter(count > 100)")
  expect_true("filtered" %in% p2$defs)
  expect_true("raw" %in% p2$refs)
  # namespace package names are not variables
  expect_false("dplyr" %in% p2$refs)
})

test_that("function-local names and args are excluded from top-level refs", {
  p <- alder:::cell_defs_refs("f <- function(a, b) { local <- a + b; local * GLOBAL }")
  expect_true("f" %in% p$defs)
  # GLOBAL is a free variable referenced inside the function body
  expect_true("GLOBAL" %in% p$refs)
  # a, b are function args; local is function-local
  expect_false("a" %in% p$refs)
  expect_false("b" %in% p$refs)
  expect_false("local" %in% p$refs)
  expect_false("local" %in% p$defs)
})

test_that("function args do not leak into sibling top-level expressions", {
  p <- alder:::cell_defs_refs(c(
    "f <- function(x) x + 1",
    "y <- x * 2"))
  # x is an arg of f, but the second expression uses the top-level x
  expect_true("x" %in% p$refs)
  expect_false("x" %in% p$defs)
  expect_true("f" %in% p$defs)
  expect_true("y" %in% p$defs)
})

test_that("function-body assignments are local even before assignment (R hoisting)", {
  p <- alder:::cell_defs_refs("f <- function() { y <- x * 2; x <- 1 }")
  expect_false("x" %in% p$refs)
  expect_false("y" %in% p$refs)
  expect_false("x" %in% p$defs)
  expect_true("f" %in% p$defs)
})

test_that("pipes and formulas contribute references", {
  p <- alder:::cell_defs_refs("p <- ggplot(d, aes(x, y)) + geom_point()")
  expect_true("d" %in% p$refs)
  expect_true("p" %in% p$defs)
})

test_that("syntax errors are reported as diagnostics, not crashes", {
  r <- alder:::cell_defs_refs("x <- ")
  expect_false(is.null(r$error))
})

test_that("cells referencing a function defined in another cell edge properly", {
  p <- alder:::cell_defs_refs("g <- f(1)")
  expect_true("f" %in% p$refs)   # the call head is a reference
  expect_true("g" %in% p$defs)
})

test_that("eager self-update records a self reference", {
  p <- alder:::cell_defs_refs("x <- x + 1")
  expect_true("x" %in% p$self_refs)
  expect_false("x" %in% p$refs)
  # read-before-own-definition in a later expression is still a self ref
  p2 <- alder:::cell_defs_refs(c("y <- x", "x <- 1"))
  expect_true("x" %in% p2$self_refs)
  expect_true("y" %in% p2$defs)
})

test_that("reads after the cell's own definition are not self refs", {
  p <- alder:::cell_defs_refs(c("x <- 1", "y <- x + 1"))
  expect_false("x" %in% p$self_refs)
  expect_false("x" %in% p$refs)
  expect_true("y" %in% p$defs)
})

test_that("deferred closure reads of later definitions are inert", {
  # f reads x when CALLED, after the cell has defined x: no edge at all.
  p <- alder:::cell_defs_refs(c("f <- function() x", "x <- 1"))
  expect_false("x" %in% p$refs)
  expect_false("x" %in% p$self_refs)
  # a deferred read of an external name is still a reference
  p2 <- alder:::cell_defs_refs("f <- function() x")
  expect_true("x" %in% p2$refs)
})

test_that("recursion is local, eager self-update is not", {
  p <- alder:::cell_defs_refs("f <- function() f()")
  expect_false("f" %in% p$refs)
  expect_false("f" %in% p$self_refs)
})

test_that("formal defaults are scanned with all formals local", {
  p <- alder:::cell_defs_refs("f <- function(a, b = a + 1) b")
  expect_false("a" %in% p$refs)
  expect_false("b" %in% p$refs)
  p2 <- alder:::cell_defs_refs("f <- function(a = G + 1) a")
  expect_true("G" %in% p2$refs)      # free variable in a default
  p3 <- alder:::cell_defs_refs(c("f <- function(a = G + 1) a", "G <- 2"))
  expect_false("G" %in% p3$refs)    # defined later in the same cell
  expect_false("G" %in% p3$self_refs)
})

test_that("superassignment targets are nonlocal references, not locals", {
  p <- alder:::cell_defs_refs("f <- function() { g <<- 1 }")
  expect_true("f" %in% p$defs)
  expect_true("g" %in% p$refs)     # <<- target reaches outside the closure
  expect_false("f" %in% p$refs)    # but f itself is the cell's own name
  p2 <- alder:::cell_defs_refs("f <- function() { 1 ->> h }")
  expect_true("h" %in% p2$refs)
})

test_that("compound assignment targets read their root and subscripts", {
  p <- alder:::cell_defs_refs("x[i] <- v")
  expect_true("x" %in% p$self_refs)   # x[i] <- reads x before defining it
  expect_true("i" %in% p$refs)
  expect_true("v" %in% p$refs)
  p2 <- alder:::cell_defs_refs(c("x <- 1", "x[2] <- 2"))
  expect_false("x" %in% p2$self_refs) # x already defined earlier
  p3 <- alder:::cell_defs_refs("x$col <- 1")
  expect_true("x" %in% p3$self_refs)
})

test_that("a plain assignment does not read its LHS", {
  p <- alder:::cell_defs_refs("x <- 1")
  expect_false("x" %in% p$self_refs)
  expect_false("x" %in% p$refs)
})

test_that("build_dag adds self-loops for self references", {
  cells <- list(
    list(id = "cell-1", defs = "x", refs = character(), self_refs = "x"),
    list(id = "cell-2", defs = "y", refs = "x", self_refs = character()))
  dag <- alder:::build_dag(cells)
  expect_true("cell-1" %in% dag$edges[["cell-1"]])
  expect_true("cell-1" %in% dag$edges[["cell-2"]])
  expect_true(length(dag$cycles) > 0L)           # self-loop is a cycle
  expect_null(alder:::topo_order(dag$edges, dag$nodes))
  # same cells without self_refs: no loop, runnable
  cells2 <- list(
    list(id = "cell-1", defs = "x", refs = character(), self_refs = character()),
    list(id = "cell-2", defs = "y", refs = "x", self_refs = character()))
  dag2 <- alder:::build_dag(cells2)
  expect_false("cell-1" %in% dag2$edges[["cell-1"]])
  expect_equal(alder:::topo_order(dag2$edges, dag2$nodes), c("cell-1", "cell-2"))
})

test_that("cycles report their members and exclude downstream cells", {
  cy <- list(
    list(id = "a", defs = "x", refs = "y", self_refs = character()),
    list(id = "b", defs = "y", refs = "x", self_refs = character()),
    list(id = "c", defs = "z", refs = "x", self_refs = character()))
  dag <- alder:::build_dag(cy)
  expect_setequal(dag$cycles, c("a", "b"))
  expect_false("c" %in% dag$cycles)   # plain consumer: not part of the SCC
  expect_null(alder:::topo_order(dag$edges, dag$nodes))
})

test_that("build_dag produces dependency edges in the right direction", {
  cells <- list(
    list(id = "a", defs = "x", refs = character()),
    list(id = "b", defs = "y", refs = "x"),
    list(id = "c", defs = "z", refs = c("x", "y")))
  dag <- alder:::build_dag(cells)
  expect_true("a" %in% dag$edges$b)
  expect_true(all(c("a", "b") %in% dag$edges$c))
  expect_length(dag$edges$a, 0)
})

test_that("topo_order runs dependencies first", {
  cells <- list(
    list(id = "a", defs = "x", refs = character()),
    list(id = "b", defs = "y", refs = "x"),
    list(id = "c", defs = "z", refs = c("x", "y")))
  dag <- alder:::build_dag(cells)
  ord <- alder:::topo_order(dag$edges, dag$nodes)
  expect_equal(ord, c("a", "b", "c"))
})

test_that("cycles are detected and topo fails safely", {
  cy <- list(
    list(id = "a", defs = "x", refs = "y"),
    list(id = "b", defs = "y", refs = "x"))
  dag <- alder:::build_dag(cy)
  expect_true(length(dag$cycles) > 0)
  expect_null(alder:::topo_order(dag$edges, dag$nodes))
})

test_that("duplicate (contradictory) definitions are reported", {
  dup <- list(
    list(id = "a", defs = "x", refs = character()),
    list(id = "b", defs = "x", refs = character()))
  dag <- alder:::build_dag(dup)
  expect_true("x" %in% names(dag$duplicates))
})
