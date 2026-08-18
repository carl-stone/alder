sql_cell <- function(session, id) {
  state <- session$state()
  for (cell in state$cells) {
    if (identical(cell$id, id)) {
      cell$output <- if (length(cell$outputs)) {
        cell$outputs[[length(cell$outputs)]]
      } else {
        NULL
      }
      return(cell)
    }
  }
  stop("no such cell: ", id)
}

if (!exists("cell_of", mode = "function", inherits = TRUE)) {
  cell_of <- function(s, id) {
    st <- s$state()
    for (c in st$cells) if (identical(c$id, id)) return(c)
    stop("no such cell: ", id)
  }
}

wait_settled <- function(s, timeout = 20) {
  wait_for(s, function() {
    !any(vapply(s$state()$cells,
                function(cell) identical(cell$status, "running"),
                logical(1)))
  }, timeout)
}

test_that("SQL cells parse and serialize canonical raw strings", {
  query <- "SELECT ')---\"' AS marker"
  nb <- alder:::parse_notebook_lines(
    path = NA_character_,
    lines = c("# %% [sql]", "result <- sql(r\"----(",
              query, ")----\")")
  )
  parsed <- alder:::parse_sql_cell(alder:::nb_cell(nb, "cell-1")$body)
  expect_identical(parsed$into, "result")
  expect_identical(parsed$query, query)
  expect_null(parsed$conn)

  nb <- alder:::nb_set_sql_cell(nb, "cell-1", query, into = "answer")
  body <- alder:::nb_cell(nb, "cell-1")$body
  expect_identical(alder:::parse_sql_cell(body),
                   list(into = "answer", query = query, conn = NULL))
  expect_identical(alder:::nb_cell(nb, "cell-1")$type, "sql")
  expect_match(paste(body, collapse = "\n"), "\\)----\\\"")
})

test_that("SQL cells with explicit connections feed consumers", {
  m <- make_test_session(c(
    "# %%",
    "con <- DBI::dbConnect(duckdb::duckdb())",
    "# %% [sql]",
    "result <- sql(r\"---(",
    "SELECT 6 AS total",
    ")---\", conn = con)",
    "# %%",
    "result$total"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  wait_for(s, function() {
    !any(vapply(s$state()$cells,
                function(cell) identical(cell$status, "running"),
                logical(1)))
  }, timeout = 20)
  expect_true(all(vapply(s$state()$cells,
                         function(cell) !identical(cell$status, "error"),
                         logical(1))))
  expect_identical(sql_cell(s, "cell-3")$output$kind, "text")
  expect_match(sql_cell(s, "cell-3")$output$text, "6")
})

test_that("connection-less SQL cells query notebook data frames", {
  m <- make_test_session(c(
    "# %%",
    "df <- data.frame(x = 1:3)",
    "# %% [sql]",
    "result <- sql(r\"---(",
    "SELECT sum(x) AS total FROM df",
    ")---\")",
    "# %%",
    "result$total"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  wait_for(s, function() {
    !any(vapply(s$state()$cells,
                function(cell) identical(cell$status, "running"),
                logical(1)))
  }, timeout = 20)
  expect_identical(sql_cell(s, "cell-3")$output$kind, "text")
  expect_match(sql_cell(s, "cell-3")$output$text, "6")
  expect_identical(sql_cell(s, "cell-2")$output$kind, "table")
})

test_that("SQL cells depend on data frames named in the query body", {
  # `df` appears only inside the SQL text; the DAG must still order the
  # SQL cell after the cell that defines it.
  m <- make_test_session(c(
    "# %% [sql]",
    "result <- sql(r\"---(",
    "SELECT count(*) AS n FROM df",
    ")---\")",
    "# %%",
    "df <- data.frame(x = 1:5)"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  topo <- unclass(s$state()$topo)
  expect_lt(match("cell-2", topo), match("cell-1", topo))
  wait_settled(s, timeout = 20)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_equal(cell_of(s, "cell-1")$outputs[[1L]]$kind, "table")
})

test_that("SQL cells wait for connections defined in later cells", {
  m <- make_test_session(c(
    "# %% [sql]",
    "result <- sql(r\"---(",
    "SELECT 6 AS total",
    ")---\", conn = con)",
    "# %%",
    "con <- DBI::dbConnect(duckdb::duckdb())"
  ), run_on_startup = TRUE)
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  topo <- unclass(s$state()$topo)
  expect_lt(match("cell-2", topo), match("cell-1", topo))
  wait_settled(s, timeout = 20)
  expect_equal(cell_of(s, "cell-1")$status, "done")
  expect_equal(cell_of(s, "cell-2")$status, "done")
  expect_equal(cell_of(s, "cell-1")$outputs[[1L]]$kind, "table")
})

test_that("malformed SQL cells report a blocking shape diagnostic", {
  m <- make_test_session(c("# %% [sql]", "result <- 1"))
  s <- m$session
  withr::defer(s$stop(), testthat::teardown_env())
  expect_error(s$run_all(), "cannot be analyzed safely")
  cell <- sql_cell(s, "cell-1")
  expect_identical(cell$status, "idle")
  expect_identical(cell$diagnostics[[1L]]$code, "sql-cell-shape")
  expect_equal(m$worker$counter, 1L)
})

test_that("SQL reports the documented missing dependency error", {
  runtime <- getFromNamespace("RUNTIME", "alder")
  old <- runtime$duckdb
  runtime$duckdb <- NULL
  withr::defer(runtime$duckdb <- old)
  lib <- tempfile("empty-lib-")
  dir.create(lib, recursive = TRUE)
  withr::with_libpaths(new = lib, action = "replace", {
    expect_error(
      getFromNamespace("sql", "alder")("SELECT 1"),
      "sql\\(\\) without a connection needs the duckdb package"
    )
  })
})
