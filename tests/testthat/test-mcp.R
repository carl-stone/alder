test_that("MCP initialize and tools list expose the stable contract", {
  nb_path <- tempfile("alder-mcp-", fileext = ".R")
  writeLines(c("# %%", "x <- 1", "# %%", "y <- x + 1"), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit(context$close(), add = TRUE)

  initialized <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 1, method = "initialize", params = list()))
  expect_equal(initialized$jsonrpc, "2.0")
  expect_equal(initialized$result$protocolVersion, "2024-11-05")
  expect_equal(initialized$result$serverInfo$name, "alder")

  listed <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 2, method = "tools/list", params = list()))
  names <- vapply(listed$result$tools, `[[`, character(1), "name")
  expect_identical(names, c(
    "notebook_state", "list_cells", "read_cell", "add_cell", "edit_cell",
    "delete_cell", "move_cell", "rename_cell", "disable_cell", "run_cell",
    "run_all", "run_stale", "interrupt", "get_value", "set_widget", "save",
    "export", "check"))
  expect_null(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = "notifications/initialized", params = list())))
  ping <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 3, method = "ping", params = list()))
  expect_length(ping$result, 0L)
  resources <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 4, method = "resources/list", params = list()))
  expect_true(any(vapply(resources$result$resources, function(x)
    identical(x$uri, "alder://notebook/source"), FALSE)))
  shutdown <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 5, method = "shutdown", params = list()))
  expect_length(shutdown$result, 0L)
})

test_that("MCP edit, run, and get_value use the live Session", {
  nb_path <- tempfile("alder-mcp-", fileext = ".R")
  writeLines(c("# %%", "x <- 1", "# %%", "y <- x + 1"), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit(context$close(), add = TRUE)

  edited <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 1, method = "tools/call",
    params = list(name = "edit_cell", arguments = list(
      cell = "cell-1", body = list("x <- 2"), type = "code"))))
  expect_false(edited$result$isError)

  ran <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 2, method = "tools/call",
    params = list(name = "run_cell", arguments = list(cell = "cell-1"))))
  expect_false(ran$result$isError)

  value <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 3, method = "tools/call",
    params = list(name = "get_value", arguments = list(name = "y"))))
  expect_false(value$result$isError)
  payload <- jsonlite::fromJSON(value$result$content[[1]]$text,
                                simplifyVector = FALSE)
  expect_true(isTRUE(payload$ok))
  expect_equal(payload$name, "y")
  expect_equal(payload$value$kind, "text")
  expect_match(payload$value$text, "3")
})

test_that("MCP unknown tools return an MCP error result", {
  context <- alder:::mcp_backend(NULL)
  on.exit(context$close(), add = TRUE)
  response <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 7, method = "tools/call",
    params = list(name = "does_not_exist", arguments = list())))
  expect_true(isTRUE(response$result$isError))
  payload <- jsonlite::fromJSON(response$result$content[[1]]$text,
                                simplifyVector = FALSE)
  expect_false(isTRUE(payload$ok))
  expect_equal(payload$error$code, "invalid_request")
})

test_that("MCP source resource returns serialized notebook bytes", {
  nb_path <- tempfile("alder-mcp-", fileext = ".R")
  bytes <- c("# ---", "title: MCP", "# ---", "# %%", "x <- 1", "")
  writeLines(bytes, nb_path, useBytes = TRUE)
  expected <- rawToChar(readBin(nb_path, "raw", n = file.info(nb_path)$size))
  context <- alder:::mcp_backend(nb_path)
  on.exit(context$close(), add = TRUE)

  response <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 9, method = "resources/read",
    params = list(uri = "alder://notebook/source")))
  expect_equal(response$result$contents[[1]]$mimeType, "text/plain")
  expect_equal(response$result$contents[[1]]$text, expected)
})
