call_mcp_tool <- function(context, id, name,
                          arguments = alder:::mcp_empty_object()) {
  mcp_lifecycle_handshake(context)
  alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = id, method = "tools/call",
    params = list(name = name, arguments = arguments)
  ))
}

mcp_tool_payload <- function(response) {
  jsonlite::fromJSON(
    response$result$content[[1L]]$text,
    simplifyVector = FALSE
  )
}

mcp_valid_initialize_params <- function() {
  list(
    protocolVersion = "2024-11-05",
    capabilities = alder:::mcp_empty_object(),
    clientInfo = list(name = "alder-test-client", version = "1.0")
  )
}

mcp_lifecycle_handshake <- function(context) {
  phase <- if (is.null(context$phase)) "new" else context$phase
  initialized <- NULL
  if (identical(phase, "new")) {
    initialized <- expect_no_warning(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "alder-test-initialize", method = "initialize",
      params = mcp_valid_initialize_params()
    )))
    expect_identical(initialized$error, NULL)
    expect_identical(context$phase, "awaiting_initialized")
  }
  if (identical(context$phase, "awaiting_initialized")) {
    expect_null(expect_no_warning(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized",
      params = alder:::mcp_empty_object()
    ))))
  }
  expect_identical(context$phase, "ready")
  invisible(initialized)
}

mcp_lifecycle_request <- function(context, id, method, params) {
  alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = id, method = method, params = params
  ))
}

mcp_lifecycle_notification <- function(context, method, params) {
  alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = method, params = params
  ))
}

test_that("MCP initialize and tools list expose the stable contract", {
  nb_path <- tempfile("alder-mcp-", fileext = ".R")
  writeLines(c("# %%", "x <- 1", "# %%", "y <- x + 1"), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit(context$close(), add = TRUE)

  initialized <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 1, method = "initialize",
    params = mcp_valid_initialize_params()))
  expect_equal(initialized$jsonrpc, "2.0")
  expect_equal(initialized$result$protocolVersion, "2024-11-05")
  expect_equal(initialized$result$serverInfo$name, "alder")
  expect_identical(context$phase, "awaiting_initialized")
  expect_null(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = "notifications/initialized",
    params = alder:::mcp_empty_object())))
  expect_identical(context$phase, "ready")

  listed <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 2, method = "tools/list",
    params = alder:::mcp_empty_object()))
  listed_wire <- jsonlite::fromJSON(
    alder:::mcp_json(listed), simplifyVector = FALSE
  )
  names <- vapply(listed_wire$result$tools, `[[`, character(1), "name")
  expect_identical(names, c(
    "notebook_state", "list_cells", "read_cell", "add_cell", "edit_cell",
    "delete_cell", "move_cell", "rename_cell", "disable_cell", "run_cell",
    "run_all", "run_stale", "interrupt", "get_value", "set_widget", "save",
    "export", "check"))
  add_tool <- listed_wire$result$tools[[match("add_cell", names)]]
  expect_identical(
    unlist(
      add_tool$inputSchema$properties$type$enum,
      use.names = FALSE
    ),
    c("code", "markdown")
  )
  edit_tool <- listed_wire$result$tools[[match("edit_cell", names)]]
  revision_schema <- edit_tool$inputSchema$properties$expected_revision
  expect_identical(revision_schema$type, "integer")
  expect_identical(revision_schema$minimum, 0L)
  expect_identical(revision_schema$maximum, .Machine$integer.max)
  ping <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 3, method = "ping",
    params = alder:::mcp_empty_object()))
  expect_length(ping$result, 0L)
  resources <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 4, method = "resources/list",
    params = alder:::mcp_empty_object()))
  expect_true(any(vapply(resources$result$resources, function(x)
    identical(x$uri, "alder://notebook/source"), FALSE)))
  shutdown <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 5, method = "shutdown",
    params = alder:::mcp_empty_object()))
  expect_length(shutdown$result, 0L)
})

test_that("MCP value inspection rejects stale dependencies until rerun", {
  nb_path <- tempfile("alder-mcp-stale-value-", fileext = ".R")
  writeLines(c("# %%", "x <- 2", "# %%", "y <- x * 3", "y"), nb_path)
  withr::defer(unlink(nb_path))
  context <- alder:::mcp_backend(nb_path)
  withr::defer(context$close())
  inspect <- function(id) call_mcp_tool(context, id, "get_value", list(name = "y"))
  expect_identical(mcp_tool_payload(inspect(1L))$value$text, "[1] 6")
  edited <- call_mcp_tool(context, 2L, "edit_cell", list(
    cell = "cell-1", body = list("x <- 3"), type = "code"))
  expect_false(isTRUE(edited$result$isError))
  stale <- inspect(3L)
  expect_true(stale$result$isError)
  expect_identical(mcp_tool_payload(stale)$error$code, "stale_value")
  expect_false("value" %in% names(mcp_tool_payload(stale)))
  state <- mcp_tool_payload(call_mcp_tool(context, 4L, "notebook_state"))
  expect_null(state$last_value)
  expect_identical(state$cells[[2L]]$outputs[[1L]]$text, "[1] 6")
  call_mcp_tool(context, 5L, "run_stale")
  expect_identical(mcp_tool_payload(inspect(6L))$value$text, "[1] 9")
})

test_that("URL MCP value inspection shares HTTP stale-value rejection", {
  nb_path <- tempfile("alder-mcp-url-stale-value-", fileext = ".R")
  writeLines(c("# %%", "x <- 2", "# %%", "y <- x * 3", "y"), nb_path)
  withr::defer(unlink(nb_path))
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  withr::defer(stop_alder(srv))
  code <- paste0(
    ".libPaths(c(", encodeString(alder_cache_lib(), quote = '"'), ", .libPaths()))\n",
    'context <- alder:::mcp_backend(url = sprintf("http://%s:%d", host, port))
    on.exit(context$close(), add = TRUE)
    empty <- alder:::mcp_empty_object()
    dispatch <- function(id, method, params = empty) alder:::mcp_dispatch(context,
      list(jsonrpc = "2.0", id = id, method = method, params = params))
    dispatch(1L, "initialize", list(protocolVersion = "2024-11-05",
      capabilities = empty, clientInfo = list(name = "stale-value", version = "1")))
    alder:::mcp_dispatch(context, list(jsonrpc = "2.0",
      method = "notifications/initialized", params = empty))
    tool <- function(id, name, arguments = empty) dispatch(id, "tools/call",
      list(name = name, arguments = arguments))
    payload <- function(response) jsonlite::fromJSON(
      response$result$content[[1L]]$text, simplifyVector = FALSE)
    tool(2L, "run_all")
    initial <- payload(tool(3L, "get_value", list(name = "y")))
    tool(4L, "edit_cell", list(cell = "cell-1", body = list("x <- 3"), type = "code"))
    stale <- tool(5L, "get_value", list(name = "y"))
    h <- curl::new_handle()
    curl::handle_setopt(h, postfields = "{\\"name\\":\\"y\\"}", customrequest = "POST")
    curl::handle_setheaders(h, "Content-Type" = "application/json")
    http <- curl::curl_fetch_memory(sprintf("http://%s:%d/api/value", host, port), h)
    body <- jsonlite::fromJSON(rawToChar(http$content), simplifyVector = FALSE)
    tool(6L, "run_stale")
    recovered <- payload(tool(7L, "get_value", list(name = "y")))
    cat("stale-value-parity", identical(initial$value$text, "[1] 6"),
      isTRUE(stale$result$isError), identical(payload(stale)$error$code, "stale_value"),
      http$status_code == 409L, identical(body$error$code, "stale_value"),
      identical(recovered$value$text, "[1] 9"), "\\n")'
  )
  out <- trimws(http_child(port, code))
  expect_true(any(grepl("^stale-value-parity TRUE TRUE TRUE TRUE TRUE TRUE$", out)),
              info = paste(out, collapse = "\n"))
})

test_that("MCP executes notifications without emitting responses", {
  nb_path <- tempfile("alder-mcp-notification-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path, useBytes = TRUE)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)

  expect_null(alder:::mcp_dispatch(
    context, '{"jsonrpc":"2.0","method":"ping","params":{}}'
  ))
  mcp_lifecycle_handshake(context)
  expect_null(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = "tools/call",
    params = list(name = "edit_cell", arguments = list(
      cell = "cell-1", body = list("x <- 2"), type = "code",
      expected_revision = 0L
    ))
  )))
  state <- call_mcp_tool(context, 1L, "read_cell", list(cell = "cell-1"))
  expect_identical(mcp_tool_payload(state)$cell$body, list("x <- 2"))

  null_id <- alder:::mcp_dispatch(
    context, '{"jsonrpc":"2.0","id":null,"method":"ping","params":{}}'
  )
  expect_true("id" %in% names(null_id))
  expect_null(null_id$id)
  expect_identical(null_id$error$code, -32600L)
  invalid_id <- alder:::mcp_dispatch(
    context, '{"jsonrpc":"2.0","id":true,"method":"ping","params":{}}'
  )
  expect_identical(invalid_id$error$code, -32600L)
})

test_that("MCP validates request identifiers before applying effects", {
  nb_path <- tempfile("alder-mcp-request-id-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path, useBytes = TRUE)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)

  ping_frame <- function(id) paste0(
    '{"jsonrpc":"2.0","id":', id,
    ',"method":"ping","params":{}}'
  )
  valid_ids <- c(
    "0", "-9007199254740991", "9007199254740991", '""', '"\\u2603"'
  )
  for (id in valid_ids) {
    response <- expect_no_warning(
      alder:::mcp_dispatch(context, ping_frame(id))
    )
    expect_identical(response$error, NULL)
    expect_match(alder:::mcp_json(response), '"jsonrpc":"2.0"', fixed = TRUE)
    if (startsWith(id, '"')) {
      expected <- if (identical(id, '"\\u2603"')) "☃" else ""
      expect_identical(response$id, expected)
    } else {
      expect_match(alder:::mcp_json(response), paste0('"id":', id),
                   fixed = TRUE)
    }
  }

  before_state <- context$session$state()
  before <- before_state$cells[[1L]]
  invalid_ids <- c(
    "null", "1.5", "true", "[]", "{}", "9007199254740992",
    "-9007199254740992"
  )
  edit_frame <- function(id) paste0(
    '{"jsonrpc":"2.0","id":', id,
    ',"method":"tools/call","params":{"name":"edit_cell",',
    '"arguments":{"cell":"cell-1","body":["x <- 2"],"type":"code"}}}'
  )
  for (id in invalid_ids) {
    response <- expect_no_warning(
      alder:::mcp_dispatch(context, edit_frame(id))
    )
    expect_identical(response$error$code, -32600L)
    expect_true("id" %in% names(response))
    expect_null(response$id)
    after <- context$session$state()$cells[[1L]]
    expect_identical(after$body, before$body)
    expect_identical(after$revision, before$revision)
  }

  initialized_frame <- function(id) paste0(
    '{"jsonrpc":"2.0","id":', id,
    ',"method":"notifications/initialized","params":{}}'
  )
  for (id in c("0", '""', '"\\u2603"', "9007199254740991")) {
    response <- expect_no_warning(
      alder:::mcp_dispatch(context, initialized_frame(id))
    )
    expect_identical(response$error$code, -32600L)
    if (startsWith(id, '"')) {
      expected <- if (identical(id, '"\\u2603"')) "☃" else ""
      expect_identical(response$id, expected)
    } else {
      expect_match(alder:::mcp_json(response), paste0('"id":', id),
                   fixed = TRUE)
    }
  }
  expect_null(expect_no_warning(alder:::mcp_dispatch(
    context,
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  )))

  # A rejected frame must not poison the stream: a valid request still
  # receives its response after every identifier error above.
  surviving <- expect_no_warning(alder:::mcp_dispatch(
    context, '{"jsonrpc":"2.0","id":99,"method":"ping","params":{}}'
  ))
  expect_identical(surviving$id, 99L)
  expect_length(surviving$result, 0L)
})

test_that("MCP initialize and simple methods require object-shaped params", {
  context <- alder:::mcp_backend(NULL)
  on.exit(context$close(), add = TRUE)

  malformed_initialize <- c(
    "null",
    "[]",
    "{}",
    '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"client"}}',
    '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":["client"],"version":"1.0"}}',
    '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"client","version":null}}'
  )
  for (params in malformed_initialize) {
    frame <- paste0(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":',
      params, "}"
    )
    response <- expect_no_warning(alder:::mcp_dispatch(context, frame))
    expect_identical(response$error$code, -32602L)
    expect_false(isTRUE(context$initialized))
  }
  missing_params <- expect_no_warning(alder:::mcp_dispatch(
    context, '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
  ))
  expect_identical(missing_params$error$code, -32602L)
  expect_false(isTRUE(context$initialized))
  expect_null(expect_no_warning(alder:::mcp_dispatch(
    context,
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":false}'
  )))
  expect_false(isTRUE(context$initialized))

  valid <- expect_no_warning(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 2L, method = "initialize",
    params = mcp_valid_initialize_params()
  )))
  expect_identical(valid$result$protocolVersion, "2024-11-05")
  expect_false(isTRUE(context$initialized))
  expect_identical(context$phase, "awaiting_initialized")
  expect_null(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = "notifications/initialized",
    params = alder:::mcp_empty_object()
  )))
  expect_true(isTRUE(context$initialized))

  malformed_params <- c("null", "1", '"scalar"', "[]", "[1]")
  simple_methods <- c("ping", "tools/list", "resources/list")
  for (method in simple_methods) {
    for (params in malformed_params) {
      frame <- paste0(
        '{"jsonrpc":"2.0","id":3,"method":"', method,
        '","params":', params, "}"
      )
      response <- expect_no_warning(alder:::mcp_dispatch(context, frame))
      expect_identical(response$error$code, -32602L)

      notification <- sub('"id":3,', "", frame, fixed = TRUE)
      expect_null(expect_no_warning(
        alder:::mcp_dispatch(context, notification)
      ))
    }
  }
})

test_that("MCP lifecycle gates local requests until the initialized notification", {
  nb_path <- tempfile("alder-mcp-lifecycle-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path, useBytes = TRUE)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)
  before_state <- context$session$state()
  before <- before_state$cells[[1L]]
  empty <- alder:::mcp_empty_object()
  call_arguments <- list(body = list("x <- 2"), type = "code")
  gated <- list(
    list(method = "tools/list", params = empty),
    list(method = "tools/call", params = list(
      name = "add_cell", arguments = call_arguments
    )),
    list(method = "resources/list", params = empty),
    list(method = "shutdown", params = empty)
  )
  request <- function(id, method, params) alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = id, method = method, params = params
  ))
  notification <- function(method, params) alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = method, params = params
  ))

  expect_identical(context$phase, "new")
  expect_length(request(2L, "ping", empty)$result, 0L)
  expect_null(notification("ping", empty))
  for (entry in gated) {
    response <- request(3L, entry$method, entry$params)
    expect_identical(response$error$code, -32600L)
    expect_null(notification(entry$method, entry$params))
  }
  after_state <- context$session$state()
  after <- after_state$cells[[1L]]
  expect_length(after_state$cells, length(before_state$cells))
  expect_identical(after$body, before$body)
  expect_identical(after$revision, before$revision)
  expect_identical(context$phase, "new")

  expect_null(notification("notifications/initialized", FALSE))
  expect_identical(context$phase, "new")
  malformed <- request(
    4L, "initialize", list(protocolVersion = "2024-11-05")
  )
  expect_identical(malformed$error$code, -32602L)
  expect_identical(context$phase, "new")
  expect_null(notification("notifications/initialized", empty))
  expect_identical(context$phase, "new")

  initialized <- request(5L, "initialize", mcp_valid_initialize_params())
  expect_identical(initialized$error, NULL)
  expect_identical(context$phase, "awaiting_initialized")
  awaiting <- request(6L, "tools/list", empty)
  expect_identical(awaiting$error$code, -32600L)
  expect_null(notification("tools/call", list(
    name = "add_cell", arguments = call_arguments
  )))
  expect_null(notification("notifications/initialized", FALSE))
  expect_identical(context$phase, "awaiting_initialized")
  repeated_awaiting <- request(
    7L, "initialize", mcp_valid_initialize_params()
  )
  expect_identical(repeated_awaiting$error$code, -32600L)
  expect_identical(context$phase, "awaiting_initialized")
  expect_null(notification("notifications/initialized", empty))
  expect_identical(context$phase, "ready")

  repeated <- request(8L, "initialize", mcp_valid_initialize_params())
  expect_identical(repeated$error$code, -32600L)
  expect_null(notification("notifications/initialized", empty))
  expect_identical(context$phase, "ready")
})

test_that("local MCP defers configured startup until lifecycle readiness", {
  policies <- expand.grid(
    execution_mode = c("automatic", "lazy"),
    run_on_startup = c(FALSE, TRUE),
    stringsAsFactors = FALSE
  )
  for (index in seq_len(nrow(policies))) {
    policy <- policies[index, , drop = FALSE]
    nb_path <- tempfile("alder-mcp-startup-policy-", fileext = ".R")
    marker <- tempfile("alder-mcp-startup-marker-")
    writeLines(c(
      "# ---",
      "# runtime:",
      paste0("#   execution_mode: ", policy$execution_mode),
      paste0("#   run_on_startup: ", tolower(policy$run_on_startup)),
      "# ---",
      "# %%",
      paste0("writeLines('started', ", encodeString(marker, quote = "'"), ")")
    ), nb_path, useBytes = TRUE)
    context <- expect_no_warning(alder:::mcp_backend(nb_path))
    on.exit({
      context$close()
      unlink(c(nb_path, marker))
    }, add = TRUE)
    started <- Sys.time()
    ping <- expect_no_warning(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "pre-ready-ping", method = "ping",
      params = alder:::mcp_empty_object()
    )))
    expect_lt(as.numeric(difftime(Sys.time(), started, units = "secs")), 2)
    expect_length(ping$result, 0L)
    expect_false(file.exists(marker))
    expect_null(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized",
      params = alder:::mcp_empty_object()
    )))
    expect_false(file.exists(marker))
    bad <- alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "bad", method = "initialize",
      params = list(protocolVersion = "2024-11-05")
    ))
    expect_identical(bad$error$code, -32602L)
    expect_false(file.exists(marker))
    mcp_lifecycle_handshake(context)
    state <- context$session$state()
    expect_identical(state$runtime$execution_mode, policy$execution_mode)
    expect_identical(state$runtime$run_on_startup, policy$run_on_startup)
    expect_identical(file.exists(marker), policy$run_on_startup)
    expect_identical(
      state$cells[[1L]]$status,
      if (policy$run_on_startup) "done" else "idle"
    )
    # Repeated lifecycle traffic must neither re-run startup nor mutate state.
    expect_null(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized",
      params = alder:::mcp_empty_object()
    )))
    expect_identical(file.exists(marker), policy$run_on_startup)
    context$close()
    unlink(c(nb_path, marker))
  }
})

test_that("stdio local MCP exits before initialization without startup effects", {
  nb_path <- tempfile("alder-mcp-early-eof-", fileext = ".R")
  marker <- tempfile("alder-mcp-early-eof-marker-")
  writeLines(c(
    "# ---", "# runtime:", "#   run_on_startup: true", "# ---", "# %%",
    paste0("writeLines('unexpected', ", encodeString(marker, quote = "'"), ")")
  ), nb_path, useBytes = TRUE)
  on.exit(unlink(c(nb_path, marker)), add = TRUE)
  lib <- alder_cache_lib()
  library_path <- paste(c(lib, .libPaths()), collapse = .Platform$path.sep)
  expression <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths())); ",
    "alder::alder_mcp(path = ", encodeString(nb_path, quote = '"'), ")"
  )
  process <- processx::run(
    file.path(R.home("bin"), "Rscript"), c("--vanilla", "-e", expression),
    env = c(R_LIBS = library_path), stdin = "", stdout = "|", stderr = "|",
    timeout = 60000, error_on_status = FALSE
  )
  expect_identical(process$status, 0L)
  expect_identical(trimws(process$stderr), "")
  expect_false(file.exists(marker))
})

test_that("local MCP matches project runtime configuration without source mutation", {
  project <- tempfile("alder-mcp-project-config-")
  dir.create(project)
  dir.create(file.path(project, ".alder"))
  nb_path <- file.path(project, "policy.R")
  marker <- file.path(project, "marker")
  writeLines(c("# %%", paste0(
    "writeLines('unexpected', ", encodeString(marker, quote = "'"), ")"
  )), nb_path, useBytes = TRUE)
  writeLines(c("on_cell_change: lazy", "on_startup: false"),
             file.path(project, ".alder", "config.yaml"), useBytes = TRUE)
  on.exit(unlink(project, recursive = TRUE), add = TRUE)
  original <- readBin(nb_path, "raw", n = file.info(nb_path)$size)
  context <- expect_no_warning(alder:::mcp_backend(nb_path))
  on.exit(context$close(), add = TRUE)
  expect_false(file.exists(marker))
  mcp_lifecycle_handshake(context)
  state <- context$session$state()
  expect_identical(state$runtime$execution_mode, "lazy")
  expect_false(state$runtime$run_on_startup)
  expect_identical(state$cells[[1L]]$status, "idle")
  expect_false(file.exists(marker))
  expect_identical(readBin(nb_path, "raw", n = file.info(nb_path)$size), original)
})

test_that("local MCP surfaces deferred-startup timeout and releases resources", {
  nb_path <- tempfile("alder-mcp-startup-timeout-", fileext = ".R")
  marker <- tempfile("alder-mcp-startup-timeout-marker-")
  writeLines(c(
    "# ---", "# runtime:", "#   run_on_startup: true", "# ---", "# %%",
    "Sys.sleep(2)",
    paste0("writeLines('late', ", encodeString(marker, quote = "'"), ")")
  ), nb_path, useBytes = TRUE)
  on.exit(unlink(c(nb_path, marker)), add = TRUE)
  context <- expect_no_warning(alder:::mcp_backend(nb_path))
  artifact_dir <- context$artifact_dir
  worker <- context$worker
  on.exit(context$close(), add = TRUE)
  context$timeout <- 0.05
  expect_false(file.exists(marker))
  mcp_lifecycle_handshake(context)
  failed <- expect_no_warning(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = "after-timeout", method = "tools/list",
    params = alder:::mcp_empty_object()
  )))
  expect_identical(failed$error$code, -32603L)
  expect_match(failed$error$message, "notebook startup failed", fixed = TRUE)
  # Shutdown remains available even if startup settlement failed.
  shutdown <- expect_no_warning(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = "shutdown", method = "shutdown",
    params = alder:::mcp_empty_object()
  )))
  expect_length(shutdown$result, 0L)
  context$close()
  expect_false(worker$alive())
  expect_false(dir.exists(artifact_dir))
  expect_false(file.exists(marker))
})

test_that("local MCP exposes ordinary deferred-startup cell errors in state", {
  nb_path <- tempfile("alder-mcp-startup-error-", fileext = ".R")
  writeLines(c(
    "# ---", "# runtime:", "#   run_on_startup: true", "# ---", "# %%",
    "stop('startup cell failed')"
  ), nb_path, useBytes = TRUE)
  on.exit(unlink(nb_path), add = TRUE)
  context <- expect_no_warning(alder:::mcp_backend(nb_path))
  on.exit(context$close(), add = TRUE)
  mcp_lifecycle_handshake(context)
  response <- expect_no_warning(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = "startup-error-state", method = "tools/call",
    params = list(name = "notebook_state", arguments = alder:::mcp_empty_object())
  )))
  expect_false(isTRUE(response$result$isError))
  state <- mcp_tool_payload(response)
  expect_identical(state$cells[[1L]]$status, "error")
  expect_match(state$cells[[1L]]$error$message, "startup cell failed", fixed = TRUE)
})

test_that("MCP tools/call validates its wire envelope before tool execution", {
  nb_path <- tempfile("alder-mcp-tools-schema-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path, useBytes = TRUE)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)
  empty <- alder:::mcp_empty_object()
  request <- function(id, method, params) alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = id, method = method, params = params
  ))
  request(1L, "initialize", mcp_valid_initialize_params())
  expect_null(alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", method = "notifications/initialized", params = empty
  )))
  before <- context$session$state()$cells[[1L]]
  frame <- function(id, params) paste0(
    '{"jsonrpc":"2.0","id":', id,
    ',"method":"tools/call","params":', params, "}"
  )
  invalid_params <- c(
    '{"arguments":{}}',
    '{"name":null,"arguments":{}}',
    '{"name":1,"arguments":{}}',
    '{"name":[],"arguments":{}}',
    '{"name":"","arguments":{}}',
    '{"name":"does_not_exist","arguments":{}}',
    '{"name":"add_cell","arguments":null}',
    '{"name":"add_cell","arguments":1}',
    '{"name":"add_cell","arguments":"scalar"}',
    '{"name":"add_cell","arguments":[]}'
  )
  for (index in seq_along(invalid_params)) {
    response <- expect_no_warning(
      alder:::mcp_dispatch(context, frame(index, invalid_params[[index]]))
    )
    expect_identical(response$error$code, -32602L)
    expect_false("result" %in% names(response))
    notification <- sub(
      paste0('"id":', index, ","), "", frame(index, invalid_params[[index]]),
      fixed = TRUE
    )
    expect_null(expect_no_warning(alder:::mcp_dispatch(context, notification)))
  }
  after <- context$session$state()$cells[[1L]]
  expect_identical(after$body, before$body)
  expect_identical(after$revision, before$revision)
  omitted <- expect_no_warning(alder:::mcp_dispatch(
    context, frame(20L, '{"name":"notebook_state"}')
  ))
  expect_false(isTRUE(omitted$result$isError))
  empty_arguments <- expect_no_warning(alder:::mcp_dispatch(
    context, frame(21L, '{"name":"notebook_state","arguments":{}}')
  ))
  expect_false(isTRUE(empty_arguments$result$isError))
  execution_error <- expect_no_warning(alder:::mcp_dispatch(
    context, frame(22L, '{"name":"read_cell","arguments":{"cell":"missing"}}')
  ))
  expect_true(isTRUE(execution_error$result$isError))
  expect_false("error" %in% names(execution_error))
  expect_identical(mcp_tool_payload(execution_error)$error$code, "not_found")
})

test_that("MCP lifecycle and tools/call schemas match over URL transport", {
  nb_path <- tempfile("alder-mcp-url-schema-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path, useBytes = TRUE)
  on.exit(unlink(nb_path), add = TRUE)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  lib <- alder_cache_lib()
  code <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths()))\n",
    "suppressPackageStartupMessages(library(alder))\n",
    'context <- alder:::mcp_backend(url = sprintf("http://%s:%d", host, port))\n',
    "on.exit(context$close(), add = TRUE)\n",
    "empty <- alder:::mcp_empty_object()\n",
    "request <- function(id, method, params) alder:::mcp_dispatch(context, list(\n",
    '  jsonrpc = "2.0", id = id, method = method, params = params))\n',
    "notification <- function(method, params) alder:::mcp_dispatch(context, list(\n",
    '  jsonrpc = "2.0", method = method, params = params))\n',
    'before_state <- context$request("GET", "/api/state")\n',
    "before <- before_state$cells[[1L]]\n",
    'blocked_methods <- c("tools/list", "resources/list", "shutdown")\n',
    "blocked <- vapply(blocked_methods, function(method) {\n",
    "  response <- request(2L, method, empty)\n",
    "  is.null(notification(method, empty)) && identical(response$error$code, -32600L)\n",
    "}, logical(1L))\n",
    'call_args <- list(body = list("x <- 2"), type = "code")\n',
    'blocked_call <- request(3L, "tools/call", list(name = "add_cell", arguments = call_args))\n',
    'blocked_call_notification <- is.null(notification("tools/call", list(\n',
    '  name = "add_cell", arguments = call_args)))\n',
    'after_state <- context$request("GET", "/api/state")\n',
    "after <- after_state$cells[[1L]]\n",
    'pre_ready <- identical(context$phase, "new") && all(blocked) &&\n',
    "  identical(blocked_call$error$code, -32600L) && blocked_call_notification &&\n",
    "  length(after_state$cells) == length(before_state$cells) &&\n",
    "  identical(before$body, after$body) && identical(before$revision, after$revision)\n",
    'bad_init <- request(4L, "initialize", list(protocolVersion = "2024-11-05"))\n',
    'bad_init_ok <- identical(bad_init$error$code, -32602L) && identical(context$phase, "new")\n',
    'initialized <- request(5L, "initialize", list(protocolVersion = "2024-11-05",\n',
    '  capabilities = empty, clientInfo = list(name = "url-test", version = "1.0")))\n',
    'awaiting <- identical(initialized$error, NULL) && identical(context$phase, "awaiting_initialized")\n',
    'gated <- request(6L, "tools/list", empty)\n',
    'expect_ready <- is.null(notification("notifications/initialized", empty)) &&\n',
    '  identical(context$phase, "ready") && identical(gated$error$code, -32600L)\n',
    'raw <- function(id, params) paste0("{\\"jsonrpc\\":\\"2.0\\",\\"id\\":", id,\n',
    '  ",\\"method\\":\\"tools/call\\",\\"params\\":", params, "}")\n',
    'invalid <- c("{\\"arguments\\":{}}", "{\\"name\\":null,\\"arguments\\":{}}",\n',
    '  "{\\"name\\":1,\\"arguments\\":{}}", "{\\"name\\":[],\\"arguments\\":{}}",\n',
    '  "{\\"name\\":\\"\\",\\"arguments\\":{}}", "{\\"name\\":\\"unknown\\",\\"arguments\\":{}}",\n',
    '  "{\\"name\\":\\"add_cell\\",\\"arguments\\":null}",\n',
    '  "{\\"name\\":\\"add_cell\\",\\"arguments\\":1}",\n',
    '  "{\\"name\\":\\"add_cell\\",\\"arguments\\":[]}")\n',
    "schema <- vapply(seq_along(invalid), function(index) {\n",
    "  response <- alder:::mcp_dispatch(context, raw(index, invalid[[index]]))\n",
    '  silent <- is.null(alder:::mcp_dispatch(context, sub(paste0("\\"id\\":", index, ","),\n',
    '    "", raw(index, invalid[[index]]), fixed = TRUE)))\n',
    "  identical(response$error$code, -32602L) && silent\n",
    "}, logical(1L))\n",
    'cat("url-mcp-contract", pre_ready, bad_init_ok, awaiting, expect_ready,\n',
    '  all(schema), "\\n")\n'
  )
  out <- trimws(http_child(port, code))
  expect_true(any(grepl(
    "^url-mcp-contract TRUE TRUE TRUE TRUE TRUE$", out
  )), info = paste(out, collapse = "\n"))
})

test_that("MCP URL backend reports the configured startup policy", {
  policies <- expand.grid(
    execution_mode = c("automatic", "lazy"),
    run_on_startup = c(FALSE, TRUE),
    stringsAsFactors = FALSE
  )
  lib <- alder_cache_lib()
  for (index in seq_len(nrow(policies))) {
    policy <- policies[index, , drop = FALSE]
    nb_path <- tempfile("alder-mcp-url-startup-policy-", fileext = ".R")
    marker <- tempfile("alder-mcp-url-startup-marker-")
    writeLines(c(
      "# ---", "# runtime:",
      paste0("#   execution_mode: ", policy$execution_mode),
      paste0("#   run_on_startup: ", tolower(policy$run_on_startup)),
      "# ---", "# %%",
      paste0("writeLines('started', ", encodeString(marker, quote = "'"), ")")
    ), nb_path, useBytes = TRUE)
    port <- httpuv::randomPort()
    srv <- expect_no_warning(start_alder(nb_path, port = port))
    on.exit({
      stop_alder(srv)
      unlink(c(nb_path, marker))
    }, add = TRUE)
    code <- paste0(
      ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths()))\n",
      "suppressPackageStartupMessages(library(alder))\n",
      'context <- alder:::mcp_backend(url = sprintf("http://%s:%d", host, port))\n',
      "on.exit(context$close(), add = TRUE)\n",
      "empty <- alder:::mcp_empty_object()\n",
      "init <- alder:::mcp_dispatch(context, list(jsonrpc = \"2.0\", id = 1L, method = \"initialize\", params = list(protocolVersion = \"2024-11-05\", capabilities = empty, clientInfo = list(name = \"policy\", version = \"1\"))))\n",
      "stopifnot(is.null(init$error))\n",
      "stopifnot(is.null(alder:::mcp_dispatch(context, list(jsonrpc = \"2.0\", method = \"notifications/initialized\", params = empty))))\n",
      "state <- alder:::mcp_dispatch(context, list(jsonrpc = \"2.0\", id = 2L, method = \"tools/call\", params = list(name = \"notebook_state\", arguments = empty)))\n",
      "payload <- jsonlite::fromJSON(state$result$content[[1L]]$text, simplifyVector = FALSE)\n",
      "cat('url-startup-policy', payload$runtime$execution_mode, payload$runtime$run_on_startup, payload$cells[[1L]]$status, '\\n')\n"
    )
    out <- trimws(http_child(port, code))
    expected <- paste(
      "url-startup-policy", policy$execution_mode,
      as.character(policy$run_on_startup),
      if (policy$run_on_startup) "done" else "idle"
    )
    expect_true(any(identical(out, expected)), info = paste(out, collapse = "\n"))
    expect_identical(file.exists(marker), policy$run_on_startup)
    stop_alder(srv)
    unlink(c(nb_path, marker))
  }
})

test_that("mcp_json preserves safe numeric precision for response correlation", {
  expect_identical(
    alder:::mcp_json(list(id = 123456789012345)),
    '{"id":123456789012345}'
  )
  expect_identical(
    alder:::mcp_json(list(id = 0.123456789012345)),
    '{"id":0.123456789012345}'
  )
  expect_identical(
    alder:::mcp_json(list(id = 9007199254740991)),
    '{"id":9007199254740991}'
  )
})

test_that("MCP rejects the retired SQL cell type", {
  context <- alder:::mcp_backend(NULL)
  on.exit(context$close(), add = TRUE)
  mcp_lifecycle_handshake(context)
  response <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 8, method = "tools/call",
    params = list(name = "add_cell", arguments = list(
      body = list("SELECT 1"), type = "sql"))))
  expect_true(isTRUE(response$result$isError))
  payload <- jsonlite::fromJSON(response$result$content[[1L]]$text,
                                simplifyVector = FALSE)
  expect_identical(payload$error$code, "invalid_request")
  expect_match(payload$error$message, "cell type must be code or markdown")
})

test_that("MCP edit, run, and get_value use the live Session", {
  nb_path <- tempfile("alder-mcp-", fileext = ".R")
  writeLines(c("# %%", "x <- 1", "# %%", "y <- x + 1"), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit(context$close(), add = TRUE)
  mcp_lifecycle_handshake(context)

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

test_that("local MCP cell revisions reject lossy numbers without mutation", {
  nb_path <- tempfile("alder-mcp-revision-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({ context$close(); unlink(nb_path) }, add = TRUE)
  edit <- function(id, revision, body = "x <- 2") call_mcp_tool(
    context, id, "edit_cell", list(cell = "cell-1", body = list(body),
                                    type = "code", expected_revision = revision)
  )
  initial <- context$session$state()$cells[[1L]]
  for (revision in c(0.5, -1, .Machine$integer.max + 1, Inf, -Inf, NaN)) {
    response <- expect_no_warning(edit(1L, revision))
    value <- mcp_tool_payload(response)
    expect_true(isTRUE(response$result$isError))
    expect_identical(value$error$code, "invalid_request")
    current <- context$session$state()$cells[[1L]]
    expect_identical(current$body, initial$body)
    expect_identical(current$revision, initial$revision)
  }
  current <- edit(2L, 0, "x <- 2")
  expect_false(isTRUE(current$result$isError))
  stale <- edit(3L, 0, "x <- 3")
  expect_true(isTRUE(stale$result$isError))
  expect_identical(mcp_tool_payload(stale)$error$code, "source_conflict")
  final <- context$session$state()$cells[[1L]]
  expect_identical(unclass(final$body), "x <- 2")
  expect_identical(final$revision, 1L)
})

test_that("URL MCP cell revision validation matches the local backend", {
  nb_path <- tempfile("alder-mcp-url-revision-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path)
  on.exit(unlink(nb_path), add = TRUE)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  lib <- alder_cache_lib()
  code <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths()))\n",
    'suppressPackageStartupMessages(library(alder))
    context <- alder:::mcp_backend(url = sprintf("http://%s:%d", host, port))
    on.exit(context$close(), add = TRUE)
    empty <- alder:::mcp_empty_object()
    initialized <- alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "url-revision-initialize", method = "initialize",
      params = list(protocolVersion = "2024-11-05", capabilities = empty,
                    clientInfo = list(name = "url-revision", version = "1.0"))))
    stopifnot(is.null(initialized$error))
    stopifnot(is.null(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized", params = empty))))
    payload <- function(response) jsonlite::fromJSON(
      response$result$content[[1L]]$text, simplifyVector = FALSE
    )
    tool <- function(id, arguments) alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = id, method = "tools/call",
      params = list(name = "edit_cell", arguments = arguments)
    ))
    args <- function(body = "x <- 2", revision = NULL) {
      value <- list(cell = "cell-1", body = list(body), type = "code")
      if (!is.null(revision)) value$expected_revision <- revision
      value
    }
    omitted <- tool(1L, args("x <- 1"))
    invalid <- lapply(c(0.5, -1, 2147483648), function(revision) {
      tool(2L, args(revision = revision))
    })
    bad <- all(vapply(invalid, function(response) {
      isTRUE(response$result$isError) &&
        identical(payload(response)$error$code, "invalid_request")
    }, logical(1L)))
    after_bad <- context$request("GET", "/api/state")$cells[[1L]]
    current <- tool(3L, args("x <- 2", 0))
    stale <- tool(4L, args("x <- 3", 0))
    final <- context$request("GET", "/api/state")$cells[[1L]]
    cat("url-revisions", !isTRUE(omitted$result$isError), bad,
        identical(after_bad$body[[1L]], "x <- 1"), after_bad$revision == 0,
        !isTRUE(current$result$isError), isTRUE(stale$result$isError),
        identical(payload(stale)$error$code, "source_conflict"),
        identical(final$body[[1L]], "x <- 2"), final$revision == 1, "\\n")'
  )
  out <- trimws(http_child(port, code))
  expect_true(any(grepl(
    "^url-revisions TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE$", out
  )), info = paste(out, collapse = "\n"))
})

test_that("MCP unknown tools return a protocol parameter error", {
  context <- alder:::mcp_backend(NULL)
  on.exit(context$close(), add = TRUE)
  mcp_lifecycle_handshake(context)
  response <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 7, method = "tools/call",
    params = list(
      name = "does_not_exist", arguments = alder:::mcp_empty_object()
    )))
  expect_identical(response$error$code, -32602L)
  expect_false("result" %in% names(response))
})

test_that("MCP source resource returns serialized notebook bytes", {
  nb_path <- tempfile("alder-mcp-", fileext = ".R")
  bytes <- c("# ---", "title: MCP", "# ---", "# %%", "x <- 1", "")
  writeLines(bytes, nb_path, useBytes = TRUE)
  expected <- rawToChar(readBin(nb_path, "raw", n = file.info(nb_path)$size))
  context <- alder:::mcp_backend(nb_path)
  on.exit(context$close(), add = TRUE)
  mcp_lifecycle_handshake(context)

  response <- alder:::mcp_dispatch(context, list(
    jsonrpc = "2.0", id = 9, method = "resources/read",
    params = list(uri = "alder://notebook/source")))
  expect_equal(response$result$contents[[1]]$mimeType, "text/plain")
  expect_equal(response$result$contents[[1]]$text, expected)
})

test_that("MCP preserves widget arrays and rejects named objects", {
  nb_path <- tempfile("alder-mcp-widgets-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "span <- ui$range_slider(0, 10, value = c(2, 8))", "span",
    "# %%", "multi <- ui$multiselect(c('a', 'b', 'c'), value = 'a')", "multi"
  ), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)
  mcp_lifecycle_handshake(context)

  wire_call <- function(id, arguments) {
    request <- jsonlite::fromJSON(jsonlite::toJSON(list(
      jsonrpc = "2.0", id = id, method = "tools/call",
      params = list(name = "set_widget", arguments = arguments)
    ), auto_unbox = TRUE, null = "null"), simplifyVector = FALSE)
    alder:::mcp_dispatch(context, request)
  }

  valid <- wire_call(1L, list(
    name = "span", value = c(3, 7), source = "editor"
  ))
  expect_false(isTRUE(valid$result$isError))
  valid_payload <- jsonlite::fromJSON(
    valid$result$content[[1L]]$text, simplifyVector = FALSE
  )
  operation <- context$session$widget_operation(valid_payload$token)
  expect_identical(operation$status, "done")
  span <- context$session$state()$cells[[2L]]$outputs[[1L]]$spec
  expect_equal(span$value, c(3, 7))

  invalid <- wire_call(2L, list(
    name = "multi", indices = list(first = 1L, third = 3L),
    source = "editor"
  ))
  expect_true(isTRUE(invalid$result$isError))
  payload <- jsonlite::fromJSON(
    invalid$result$content[[1L]]$text, simplifyVector = FALSE
  )
  expect_identical(payload$error$code, "invalid_request")
  expect_true(context$session$state()$runtime$worker_available)
})

test_that("MCP finds widget specs in layouts and resolved lazy outputs", {
  slider <- function(name, value) list(
    kind = "widget", name = name,
    spec = list(kind = "slider", value = value)
  )
  state <- list(cells = list(list(outputs = list(
    list(
      kind = "layout", layout = "hstack", children = list(
        slider("nested", 3),
        list(
          kind = "lazy", key = "loaded", child = list(
            kind = "layout", layout = "callout",
            children = list(slider("lazy_nested", 7))
          )
        )
      )
    )
  ))))
  expect_identical(
    alder:::mcp_widget_spec_from_state(state, "nested")$value, 3
  )
  expect_identical(
    alder:::mcp_widget_spec_from_state(state, "lazy_nested")$value, 7
  )
  expect_null(alder:::mcp_widget_spec_from_state(state, "missing"))
})

test_that("local and URL MCP settle composed widgets and button resets", {
  nb_path <- tempfile("alder-mcp-layout-widget-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "layout_slider <- ui$slider(1, 5, value = 2)",
    "layout_go <- ui$run_button('Run layout')",
    "out$hstack(layout_slider, layout_go)",
    "# %%", "layout_result <- layout_slider$value * 10L", "layout_result",
    "# %%", "layout_action <- paste(layout_go$value, 'layout')",
    "layout_action"
  ), nb_path)
  on.exit(unlink(nb_path), add = TRUE)

  local <- alder:::mcp_backend(nb_path)
  on.exit(local$close(), add = TRUE)
  local_slider <- call_mcp_tool(
    local, 1L, "set_widget",
    list(name = "layout_slider", value = 4, source = "editor")
  )
  expect_false(isTRUE(local_slider$result$isError))
  local_slider_state <- local$session$state()
  expect_identical(
    alder:::mcp_widget_spec_from_state(
      local_slider_state, "layout_slider")$value,
    4
  )
  expect_identical(
    local_slider_state$cells[[3L]]$outputs[[1L]]$text, "[1] 40"
  )

  local_first <- call_mcp_tool(
    local, 2L, "set_widget",
    list(name = "layout_go", value = TRUE, source = "editor")
  )
  local_second <- call_mcp_tool(
    local, 3L, "set_widget",
    list(name = "layout_go", value = TRUE, source = "editor")
  )
  expect_false(isTRUE(local_first$result$isError))
  expect_false(isTRUE(local_second$result$isError))
  expect_false(identical(
    mcp_tool_payload(local_first)$token,
    mcp_tool_payload(local_second)$token
  ))
  local_button_state <- local$session$state()
  expect_false(
    alder:::mcp_widget_spec_from_state(
      local_button_state, "layout_go")$value
  )
  expect_identical(
    local_button_state$cells[[4L]]$outputs[[1L]]$text,
    "[1] \"TRUE layout\""
  )
  expect_false(local_button_state$runtime$busy)
  local$close()

  lib <- alder_cache_lib()
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = TRUE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths()))\n",
    'suppressPackageStartupMessages(library(alder))
    context <- alder:::mcp_backend(url = sprintf("http://%s:%d", host, port))
    on.exit(context$close(), add = TRUE)
    empty <- alder:::mcp_empty_object()
    initialized <- alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "nested-url-initialize", method = "initialize",
      params = list(protocolVersion = "2024-11-05", capabilities = empty,
                    clientInfo = list(name = "nested-url", version = "1.0"))))
    stopifnot(is.null(initialized$error))
    stopifnot(is.null(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized", params = empty))))
    payload <- function(response) jsonlite::fromJSON(
      response$result$content[[1L]]$text, simplifyVector = FALSE
    )
    call <- function(id, name, value) alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = id, method = "tools/call",
      params = list(name = "set_widget", arguments = list(
        name = name, value = value, source = "editor"
      ))
    ))
    slider <- call(1L, "layout_slider", 3)
    slider_state <- context$request("GET", "/api/state")
    first <- call(2L, "layout_go", TRUE)
    second <- call(3L, "layout_go", TRUE)
    final <- context$request("GET", "/api/state")
    slider_spec <- alder:::mcp_widget_spec_from_state(
      slider_state, "layout_slider"
    )
    button_spec <- alder:::mcp_widget_spec_from_state(final, "layout_go")
    first_token <- payload(first)$token
    second_token <- payload(second)$token
    result <- final$cells[[3L]]$outputs[[1L]]$text
    action <- final$cells[[4L]]$outputs[[1L]]$text
    cat("nested-url", !isTRUE(slider$result$isError),
        identical(slider_spec$value, 3L), identical(result, "[1] 30"),
        !isTRUE(first$result$isError), !isTRUE(second$result$isError),
        !identical(first_token, second_token),
        identical(button_spec$value, FALSE),
        identical(action, "[1] \\"TRUE layout\\""),
        identical(final$runtime$busy, FALSE), "\\n")'
  )
  out <- trimws(http_child(port, code))
  expect_true(any(grepl(
    "^nested-url TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE$", out
  )), info = paste(out, collapse = "\n"))
})

test_that("local MCP set_widget settles its exact operation and consumers", {
  nb_path <- tempfile("alder-mcp-widget-wait-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "w <- ui$slider(1, 5, value = 2)", "w",
    "# %%",
    paste0(
      "result <- if (w$value == 5) stop('widget dependent failed') ",
      "else w$value * 10L"
    ),
    "result"
  ), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)

  updated <- call_mcp_tool(
    context, 1L, "set_widget",
    list(name = "w", value = 4, source = "editor")
  )
  expect_false(isTRUE(updated$result$isError))
  update_payload <- mcp_tool_payload(updated)
  update_operation <- context$session$widget_operation(update_payload$token)
  immediate <- context$session$state()
  expect_identical(update_operation$status, "done")
  expect_false(immediate$runtime$busy)
  expect_identical(immediate$cells[[3L]]$status, "done")
  expect_identical(immediate$cells[[3L]]$outputs[[1L]]$text, "[1] 40")

  value <- call_mcp_tool(
    context, 2L, "get_value", list(name = "result")
  )
  expect_false(isTRUE(value$result$isError))
  expect_identical(mcp_tool_payload(value)$value$text, "[1] 40")

  dependent_error <- call_mcp_tool(
    context, 3L, "set_widget",
    list(name = "w", value = 5, source = "editor")
  )
  expect_false(isTRUE(dependent_error$result$isError))
  error_state <- context$session$state()
  expect_false(error_state$runtime$busy)
  expect_identical(error_state$cells[[3L]]$status, "error")
  expect_match(error_state$cells[[3L]]$error$message,
               "widget dependent failed", fixed = TRUE)

  rejected <- call_mcp_tool(
    context, 4L, "set_widget",
    list(name = "w", value = 99, source = "editor")
  )
  expect_true(isTRUE(rejected$result$isError))
  expect_identical(mcp_tool_payload(rejected)$error$code,
                   "widget_update_failed")
  expect_equal(
    context$session$state()$cells[[2L]]$outputs[[1L]]$spec$value,
    5
  )

  context$session$set_runtime(execution_mode = "lazy")
  lazy_update <- call_mcp_tool(
    context, 5L, "set_widget",
    list(name = "w", value = 3, source = "editor")
  )
  expect_false(isTRUE(lazy_update$result$isError))
  lazy_state <- context$session$state()
  expect_false(lazy_state$runtime$busy)
  expect_identical(lazy_state$cells[[3L]]$status, "stale")
  expect_equal(lazy_state$cells[[2L]]$outputs[[1L]]$spec$value, 3)
})

test_that("local MCP set_widget settles with no consumers", {
  nb_path <- tempfile("alder-mcp-widget-no-consumer-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "go <- ui$run_button('Run')", "go"
  ), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)

  # Settle notebook startup before measuring widget operations.
  mcp_lifecycle_handshake(context)
  expect_null(context$startup_error)
  expect_true(context$startup_settled)
  context$timeout <- 2
  response <- call_mcp_tool(
    context, 1L, "set_widget",
    list(name = "go", value = TRUE, source = "editor")
  )
  expect_null(response$error)
  expect_false(isTRUE(response$result$isError))
  payload <- mcp_tool_payload(response)
  operation <- context$session$widget_operation(payload$token)
  expect_identical(operation$status, "done")
  expect_true(isTRUE(operation$reset_expected))
  expect_identical(
    context$session$widget_operation(operation$reset_token)$status,
    "done"
  )
  current <- context$session$state()$cells[[2L]]$outputs[[1L]]$operation
  expect_identical(current$token, operation$reset_token)
  expect_identical(current$status, "done")
  expect_false(context$session$state()$cells[[2L]]$outputs[[1L]]$spec$value)
  expect_false(context$session$state()$runtime$busy)

  repeated <- call_mcp_tool(
    context, 2L, "set_widget",
    list(name = "go", value = TRUE, source = "editor")
  )
  expect_null(repeated$error)
  expect_false(isTRUE(repeated$result$isError))
  repeated_payload <- mcp_tool_payload(repeated)
  expect_false(identical(repeated_payload$token, payload$token))
  repeated_operation <- context$session$widget_operation(
    repeated_payload$token)
  expect_identical(
    context$session$widget_operation(repeated_operation$reset_token)$status,
    "done"
  )
  repeated_output <- context$session$state()$cells[[2L]]$outputs[[1L]]
  expect_false(repeated_output$spec$value)
  expect_identical(repeated_output$operation$status, "done")
})

test_that("local MCP run buttons settle consumers and resets repeatedly", {
  nb_path <- tempfile("alder-mcp-run-button-consumer-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "go <- ui$run_button('Run')", "go",
    "# %%", "paste(go$value, 'consumer')"
  ), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)

  first <- call_mcp_tool(
    context, 1L, "set_widget",
    list(name = "go", value = TRUE, source = "editor")
  )
  expect_false(isTRUE(first$result$isError))
  first_payload <- mcp_tool_payload(first)
  first_operation <- context$session$widget_operation(first_payload$token)
  first_state <- context$session$state()
  expect_true(isTRUE(first_operation$reset_expected))
  expect_identical(
    context$session$widget_operation(first_operation$reset_token)$status,
    "done"
  )
  expect_false(first_state$runtime$busy)
  expect_identical(first_state$cells[[3L]]$status, "done")
  expect_identical(first_state$cells[[3L]]$outputs[[1L]]$text,
                   "[1] \"TRUE consumer\"")
  expect_false(first_state$cells[[2L]]$outputs[[1L]]$spec$value)
  expect_identical(first_state$cells[[2L]]$outputs[[1L]]$operation$status,
                   "done")

  second <- call_mcp_tool(
    context, 2L, "set_widget",
    list(name = "go", value = TRUE, source = "app")
  )
  expect_false(isTRUE(second$result$isError))
  second_payload <- mcp_tool_payload(second)
  expect_false(identical(second_payload$token, first_payload$token))
  second_operation <- context$session$widget_operation(second_payload$token)
  second_state <- context$session$state()
  expect_identical(
    context$session$widget_operation(second_operation$reset_token)$status,
    "done"
  )
  expect_false(second_state$runtime$busy)
  expect_identical(second_state$cells[[3L]]$status, "done")
  expect_false(second_state$cells[[2L]]$outputs[[1L]]$spec$value)
  expect_identical(second_state$cells[[2L]]$outputs[[1L]]$operation$status,
                   "done")
})

test_that("local MCP lazy run buttons defer their reset", {
  nb_path <- tempfile("alder-mcp-run-button-lazy-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "go <- ui$run_button('Run')", "go",
    "# %%", "go$value"
  ), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)
  context$session$set_runtime(execution_mode = "lazy")

  response <- call_mcp_tool(
    context, 1L, "set_widget",
    list(name = "go", value = TRUE, source = "editor")
  )
  expect_false(isTRUE(response$result$isError))
  payload <- mcp_tool_payload(response)
  operation <- context$session$widget_operation(payload$token)
  state <- context$session$state()
  expect_identical(operation$status, "done")
  expect_false(isTRUE(operation$reset_expected))
  expect_null(operation$reset_token)
  expect_false(state$runtime$busy)
  expect_identical(state$cells[[3L]]$status, "stale")
  expect_true(state$cells[[2L]]$outputs[[1L]]$spec$value)
})

test_that("local MCP run tools settle deferred lazy run-button resets", {
  nb_path <- tempfile("alder-mcp-lazy-run-settlement-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "go <- ui$run_button('Run')", "go",
    "# %%", "result <- { Sys.sleep(0.1); paste(go$value, 'consumer') }",
    "result",
    "# %%", "ordinary <- 1L", "ordinary"
  ), nb_path)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)
  context$session$set_runtime(execution_mode = "lazy")

  press <- function(id) {
    response <- call_mcp_tool(
      context, id, "set_widget",
      list(name = "go", value = TRUE, source = "editor")
    )
    expect_false(isTRUE(response$result$isError))
    state <- context$session$state()
    expect_true(state$cells[[2L]]$outputs[[1L]]$spec$value)
    expect_identical(state$cells[[3L]]$status, "stale")
  }
  run_and_expect_reset <- function(id, tool,
                                   arguments = alder:::mcp_empty_object(),
                                   expected_text = "[1] \"TRUE consumer\"") {
    response <- call_mcp_tool(context, id, tool, arguments)
    expect_false(isTRUE(response$result$isError))
    run_id <- mcp_tool_payload(response)$run_id
    operation <- context$session$run_operation(run_id)
    expect_identical(operation$status, "done")
    expect_length(operation$reset_tokens, 1L)
    expect_identical(
      context$session$widget_operation(operation$reset_tokens[[1L]])$status,
      "done"
    )
    state <- context$session$state()
    expect_false(state$runtime$busy)
    expect_false(state$cells[[2L]]$outputs[[1L]]$spec$value)
    expect_identical(state$cells[[3L]]$status, "done")
    expect_identical(state$cells[[3L]]$outputs[[1L]]$text, expected_text)
  }

  press(1L)
  run_and_expect_reset(2L, "run_cell", list(cell = "cell-3"))
  press(3L)
  run_and_expect_reset(4L, "run_stale")
  press(5L)
  # A full recompute intentionally re-runs the widget constructor before its
  # consumer; only run_cell/run_stale consume the pending lazy TRUE action.
  run_and_expect_reset(
    6L, "run_all", expected_text = "[1] \"FALSE consumer\""
  )

  ordinary <- call_mcp_tool(
    context, 7L, "run_cell", list(cell = "cell-4")
  )
  expect_false(isTRUE(ordinary$result$isError))
  ordinary_operation <- context$session$run_operation(
    mcp_tool_payload(ordinary)$run_id
  )
  expect_identical(ordinary_operation$status, "done")
  expect_length(ordinary_operation$reset_tokens, 0L)
})

test_that("MCP run waiters preserve exact reset errors", {
  reset_error <- list(
    run_id = 9L, status = "error", reset_tokens = I(12L),
    error = list(
      code = "widget_update_failed",
      message = "injected deferred reset failure"
    )
  )
  session <- new.env(parent = emptyenv())
  session$state <- function() list(runtime = list(busy = FALSE))
  session$run_operation <- function(run_id) reset_error
  local <- new.env(parent = emptyenv())
  local$session <- session
  local$pump <- function(done, timeout = NULL) {
    if (!isTRUE(done())) stop("injected run did not settle")
    invisible(TRUE)
  }
  local_error <- tryCatch(
    alder:::mcp_wait_local_run(local, 9L),
    error = identity
  )
  expect_s3_class(local_error, "alder_error")
  expect_identical(local_error$code, "widget_update_failed")
  expect_match(conditionMessage(local_error),
               "injected deferred reset failure", fixed = TRUE)

  remote <- new.env(parent = emptyenv())
  remote$timeout <- 1
  remote$request <- function(method, route, body = NULL) {
    expect_identical(method, "GET")
    expect_identical(route, "/api/run-operation?run_id=9")
    list(operation = reset_error)
  }
  remote_error <- tryCatch(
    alder:::mcp_wait_http_run(remote, 9L),
    error = identity
  )
  expect_s3_class(remote_error, "alder_error")
  expect_identical(remote_error$code, "widget_update_failed")
  expect_match(conditionMessage(remote_error),
               "injected deferred reset failure", fixed = TRUE)
})

test_that("local MCP propagates a causally generated reset error", {
  operations <- list(
    `1` = list(
      token = 1L, status = "done", error = NULL,
      reset_expected = TRUE, reset_token = 2L
    ),
    `2` = list(
      token = 2L, status = "error",
      error = list(
        code = "widget_update_failed",
        message = "injected button reset failure"
      )
    )
  )
  session <- new.env(parent = emptyenv())
  session$state <- function() list(runtime = list(busy = FALSE), cells = list())
  session$widget_operation <- function(token) {
    operations[[as.character(as.integer(token))]] %||% NULL
  }
  context <- new.env(parent = emptyenv())
  context$session <- session
  context$pump <- function(done, timeout = NULL) {
    if (!isTRUE(done())) stop("injected operation did not settle")
    invisible(TRUE)
  }

  error <- tryCatch(
    alder:::mcp_wait_local_widget(context, 1L, "go"),
    error = identity
  )
  expect_s3_class(error, "alder_error")
  expect_identical(error$code, "widget_update_failed")
  expect_match(conditionMessage(error), "injected button reset failure",
               fixed = TRUE)
})

test_that("stdio MCP set_widget returns only after reactive settlement", {
  nb_path <- tempfile("alder-mcp-stdio-widget-", fileext = ".R")
  input_path <- tempfile("alder-mcp-stdio-input-", fileext = ".jsonl")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "w <- ui$slider(1, 5, value = 2)", "w",
    "# %%",
    paste0(
      "result <- if (w$value == 5) stop('stdio dependent failed') ",
      "else w$value * 10L"
    ),
    "result",
    "# %%", "go <- ui$run_button('Run')", "go",
    "# %%", "paste(go$value, 'stdio consumer')"
  ), nb_path)
  on.exit(unlink(c(nb_path, input_path)), add = TRUE)

  requests <- list(
    list(jsonrpc = "2.0", id = 1L, method = "initialize",
         params = mcp_valid_initialize_params()),
    list(jsonrpc = "2.0", method = "notifications/initialized",
         params = alder:::mcp_empty_object()),
    list(jsonrpc = "2.0", id = 2L, method = "tools/call", params = list(
      name = "set_widget",
      arguments = list(name = "w", value = 4, source = "editor")
    )),
    list(jsonrpc = "2.0", id = 3L, method = "tools/call", params = list(
      name = "notebook_state", arguments = alder:::mcp_empty_object()
    )),
    list(jsonrpc = "2.0", id = 4L, method = "tools/call", params = list(
      name = "get_value", arguments = list(name = "result")
    )),
    list(jsonrpc = "2.0", id = 5L, method = "tools/call", params = list(
      name = "set_widget",
      arguments = list(name = "w", value = 5, source = "editor")
    )),
    list(jsonrpc = "2.0", id = 6L, method = "tools/call", params = list(
      name = "notebook_state", arguments = alder:::mcp_empty_object()
    )),
    list(jsonrpc = "2.0", id = 7L, method = "tools/call", params = list(
      name = "set_widget",
      arguments = list(name = "w", value = 99, source = "editor")
    )),
    list(jsonrpc = "2.0", id = 8L, method = "tools/call", params = list(
      name = "set_widget",
      arguments = list(name = "go", value = TRUE, source = "editor")
    )),
    list(jsonrpc = "2.0", id = 9L, method = "tools/call", params = list(
      name = "notebook_state", arguments = alder:::mcp_empty_object()
    )),
    list(jsonrpc = "2.0", id = 10L, method = "tools/call", params = list(
      name = "set_widget",
      arguments = list(name = "go", value = TRUE, source = "app")
    )),
    list(jsonrpc = "2.0", id = 11L, method = "tools/call", params = list(
      name = "notebook_state", arguments = alder:::mcp_empty_object()
    )),
    list(jsonrpc = "2.0", id = 12L, method = "shutdown",
         params = alder:::mcp_empty_object())
  )
  writeLines(vapply(requests, alder:::mcp_json, character(1L)), input_path)

  lib <- alder_cache_lib()
  library_path <- paste(c(lib, .libPaths()), collapse = .Platform$path.sep)
  expression <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths())); ",
    "alder::alder_mcp(path = ", encodeString(nb_path, quote = '"'), ")"
  )
  process <- processx::run(
    file.path(R.home("bin"), "Rscript"),
    c("--vanilla", "-e", expression),
    env = c(R_LIBS = library_path), stdin = input_path,
    stdout = "|", stderr = "|", timeout = 60000,
    error_on_status = FALSE
  )
  expect_identical(process$status, 0L)
  expect_identical(trimws(process$stderr), "")
  lines <- strsplit(trimws(process$stdout), "\n", fixed = TRUE)[[1L]]
  expect_length(lines, length(requests) - 1L)
  responses <- lapply(lines, jsonlite::fromJSON, simplifyVector = FALSE)

  first_update <- mcp_tool_payload(responses[[2L]])
  immediate_state <- mcp_tool_payload(responses[[3L]])
  immediate_value <- mcp_tool_payload(responses[[4L]])
  expect_true(isTRUE(first_update$ok))
  expect_false(immediate_state$runtime$busy)
  expect_identical(immediate_state$cells[[3L]]$status, "done")
  expect_identical(immediate_state$cells[[3L]]$outputs[[1L]]$text,
                   "[1] 40")
  expect_identical(immediate_value$value$text, "[1] 40")

  error_update <- mcp_tool_payload(responses[[5L]])
  error_state <- mcp_tool_payload(responses[[6L]])
  expect_true(isTRUE(error_update$ok))
  expect_false(error_state$runtime$busy)
  expect_identical(error_state$cells[[3L]]$status, "error")
  expect_match(error_state$cells[[3L]]$error$message,
               "stdio dependent failed", fixed = TRUE)
  expect_true(isTRUE(responses[[7L]]$result$isError))
  expect_identical(mcp_tool_payload(responses[[7L]])$error$code,
                   "widget_update_failed")

  first_button <- mcp_tool_payload(responses[[8L]])
  first_button_state <- mcp_tool_payload(responses[[9L]])
  second_button <- mcp_tool_payload(responses[[10L]])
  second_button_state <- mcp_tool_payload(responses[[11L]])
  expect_true(isTRUE(first_button$ok))
  expect_false(first_button_state$runtime$busy)
  expect_identical(first_button_state$cells[[5L]]$status, "done")
  expect_identical(first_button_state$cells[[5L]]$outputs[[1L]]$text,
                   "[1] \"TRUE stdio consumer\"")
  expect_false(first_button_state$cells[[4L]]$outputs[[1L]]$spec$value)
  expect_identical(
    first_button_state$cells[[4L]]$outputs[[1L]]$operation$status,
    "done"
  )
  expect_true(isTRUE(second_button$ok))
  expect_false(identical(second_button$token, first_button$token))
  expect_false(second_button_state$runtime$busy)
  expect_identical(second_button_state$cells[[5L]]$status, "done")
  expect_false(second_button_state$cells[[4L]]$outputs[[1L]]$spec$value)
  expect_identical(
    second_button_state$cells[[4L]]$outputs[[1L]]$operation$status,
    "done"
  )
})

test_that("stdio MCP rejects duplicate JSON members and preserves the source", {
  nb_path <- tempfile("alder-mcp-stdio-duplicate-", fileext = ".R")
  input_path <- tempfile("alder-mcp-stdio-duplicate-input-", fileext = ".jsonl")
  source <- charToRaw("# %%\n# duplicate-frame sentinel\nx <- 1\n")
  writeBin(source, nb_path)
  on.exit(unlink(c(nb_path, input_path)), add = TRUE)

  requests <- c(
    paste0(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":',
      alder:::mcp_json(mcp_valid_initialize_params()), "}"
    ),
    paste0(
      '{"jsonrpc":"2.0","method":"notifications/initialized",',
      '"params":', alder:::mcp_json(alder:::mcp_empty_object()), "}"
    ),
    paste0(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call",',
      '"params":{"name":"edit_cell","arguments":{',
      '"cell":"cell-1","body":["x <- 2"],"type":"code",',
      '"expected_revision":0,"expected_revision":1}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":3,"method":"tools/call",',
      '"params":{"name":"edit_cell","arguments":{',
      '"cell":"cell-1","expected_revision":1,"body":["x <- 3"],',
      '"type":"code","expected_revision":0}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":4,"method":"tools/call",',
      '"params":{"name":"edit_cell","name":"notebook_state",',
      '"arguments":{"cell":"cell-1","body":["x <- 4"],',
      '"type":"code"}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":5,"method":"tools/call",',
      '"params":{"name":"edit_cell","arguments":{',
      '"cell":"cell-1","body":["x <- 5"],"body":["x <- 6"],',
      '"type":"code"}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":6,"method":"tools/call",',
      '"params":{"name":"set_widget","arguments":{',
      '"name":"missing","value":1,"value":2}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":7,"method":"tools/call",',
      '"method":"ping","params":{"name":"edit_cell","arguments":{',
      '"cell":"cell-1","body":["x <- 7"],"type":"code",',
      '"expected_revision":0}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":8,"method":"resources/read",',
      '"params":{"uri":"alder://notebook/source"}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":9,"method":"tools/call",',
      '"params":{"name":"edit_cell","arguments":{',
      '"cell":"cell-1","body":["x <- 9"],"type":"code",',
      '"expected_revision":0}}}'
    ),
    paste0(
      '{"jsonrpc":"2.0","id":10,"method":"resources/read",',
      '"params":{"uri":"alder://notebook/source"}}'
    ),
    '{"jsonrpc":"2.0","id":11,"method":"shutdown","params":{}}'
  )
  writeBin(charToRaw(paste0(paste(requests, collapse = "\n"), "\n")),
           input_path)

  lib <- alder_cache_lib()
  library_path <- paste(c(lib, .libPaths()), collapse = .Platform$path.sep)
  expression <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths())); ",
    "alder::alder_mcp(path = ", encodeString(nb_path, quote = '"'), ")"
  )
  process <- processx::run(
    file.path(R.home("bin"), "Rscript"), c("--vanilla", "-e", expression),
    env = c(R_LIBS = library_path), stdin = input_path,
    stdout = "|", stderr = "|", timeout = 60000, error_on_status = FALSE
  )
  expect_identical(process$status, 0L)
  expect_identical(trimws(process$stderr), "")
  lines <- strsplit(trimws(process$stdout), "\n", fixed = TRUE)[[1L]]
  expect_length(lines, length(requests) - 1L)
  responses <- lapply(lines, jsonlite::fromJSON, simplifyVector = FALSE)
  for (index in 2:7) {
    expect_identical(responses[[index]]$error$code, -32600L)
    expect_identical(responses[[index]]$error$message,
                     "invalid JSON-RPC request")
  }
  expect_identical(
    charToRaw(responses[[8]]$result$contents[[1L]]$text),
    source
  )
  expect_false(isTRUE(responses[[9]]$result$isError))
  expect_identical(
    responses[[10]]$result$contents[[1L]]$text,
    "# %%\nx <- 9\n"
  )
  expect_identical(readBin(nb_path, "raw", n = file.info(nb_path)$size), source)
})

test_that("character MCP dispatch rejects duplicate members before mutation", {
  nb_path <- tempfile("alder-mcp-character-duplicate-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path, useBytes = TRUE)
  context <- alder:::mcp_backend(nb_path)
  on.exit({
    context$close()
    unlink(nb_path)
  }, add = TRUE)
  before <- context$session$state()$cells[[1L]]
  duplicate <- paste0(
    '{"jsonrpc":"2.0","id":1,"method":"tools/call",',
    '"params":{"name":"notebook_state","name":"list_cells",',
    '"arguments":{}}}'
  )
  response <- alder:::mcp_dispatch(context, duplicate)
  expect_identical(response$error$code, -32600L)
  expect_identical(response$error$message, "invalid JSON-RPC request")
  escaped_duplicate <- paste0(
    '{"jsonrpc":"2.0","id":2,"method":"tools/call",',
    '"params":{"name":"notebook_state",',
    '"na\\u006de":"list_cells","arguments":{}}}'
  )
  expect_identical(
    alder:::mcp_dispatch(context, escaped_duplicate)$error$code, -32600L
  )
  array_duplicate <- paste0(
    '{"jsonrpc":"2.0","id":3,"method":"tools/call",',
    '"params":{"name":"set_widget","arguments":{"name":"missing",',
    '"value":[{"choice":1,"choice":2}]}}}'
  )
  expect_identical(
    alder:::mcp_dispatch(context, array_duplicate)$error$code, -32600L
  )
  parsed <- list(
    jsonrpc = "2.0", id = 4L, method = "tools/call",
    params = list(name = "notebook_state", arguments = list())
  )
  names(parsed$params) <- c("name", "name")
  parsed_response <- alder:::mcp_dispatch(context, parsed)
  expect_identical(parsed_response$error$code, -32600L)
  after <- context$session$state()$cells[[1L]]
  expect_identical(after$body, before$body)
  expect_identical(after$revision, before$revision)
  valid <- alder:::mcp_dispatch(
    context,
    '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}'
  )
  expect_identical(valid$result, structure(list(), names = character()))
  oversized <- alder:::mcp_parse_json(strrep("x", 33L), max_bytes = 32L)
  expect_identical(oversized$error$code, -32600L)
})

test_that("stdio MCP reader bounds one line and recovers at the next frame", {
  pair <- processx::conn_create_pipepair(nonblocking = c(TRUE, TRUE))
  on.exit({
    try(processx::processx_conn_close(pair[[1L]]), silent = TRUE)
    try(processx::processx_conn_close(pair[[2L]]), silent = TRUE)
  }, add = TRUE)
  leftover <- processx::conn_write(
    pair[[1L]], charToRaw("12345\n123456\nok\ntail")
  )
  expect_length(leftover, 0L)
  processx::processx_conn_close(pair[[1L]])

  read_line <- alder:::mcp_stdio_reader(pair[[2L]], max_bytes = 5L)
  exact <- read_line()
  expect_false(exact$oversized)
  expect_identical(rawToChar(exact$bytes), "12345")
  expect_true(read_line()$oversized)
  recovered <- read_line()
  expect_false(recovered$oversized)
  expect_identical(rawToChar(recovered$bytes), "ok")
  final <- read_line()
  expect_false(final$oversized)
  expect_identical(rawToChar(final$bytes), "tail")
  expect_null(read_line())

  broken <- processx::conn_create_pipepair(nonblocking = c(TRUE, TRUE))
  on.exit({
    try(processx::processx_conn_close(broken[[1L]]), silent = TRUE)
    try(processx::processx_conn_close(broken[[2L]]), silent = TRUE)
  }, add = TRUE)
  broken_reader <- alder:::mcp_stdio_reader(broken[[2L]], max_bytes = 5L)
  processx::processx_conn_close(broken[[2L]])
  expect_error(broken_reader())
})

test_that("stdio MCP dispatches a live pipe before EOF", {
  nb_path <- tempfile("alder-mcp-stdio-live-", fileext = ".R")
  writeLines(c("# %%", "1 + 1"), nb_path, useBytes = TRUE)
  on.exit(unlink(nb_path), add = TRUE)
  lib <- alder_cache_lib()
  library_path <- paste(c(lib, .libPaths()), collapse = .Platform$path.sep)
  expression <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths())); ",
    "alder::alder_mcp(path = ", encodeString(nb_path, quote = '"'), ")"
  )
  child <- processx::process$new(
    file.path(R.home("bin"), "Rscript"), c("--vanilla", "-e", expression),
    env = c(R_LIBS = library_path), stdin = "|", stdout = "|", stderr = "|",
    cleanup_tree = TRUE
  )
  on.exit({
    if (child$is_alive()) child$kill()
    child$wait(5000)
  }, add = TRUE)
  write_frame <- function(bytes) {
    leftover <- processx::conn_write(
      child$get_input_connection(), c(bytes, as.raw(10L))
    )
    expect_length(leftover, 0L)
  }
  read_response <- function() {
    output <- character()
    deadline <- Sys.time() + 30
    repeat {
      output <- c(output, child$read_output_lines())
      if (length(output) || !child$is_alive() || Sys.time() >= deadline) break
      Sys.sleep(0.02)
    }
    expect_true(length(output) > 0L)
    jsonlite::fromJSON(output[[1L]], simplifyVector = FALSE)
  }

  write_frame(charToRaw(
    paste0(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":',
      alder:::mcp_json(mcp_valid_initialize_params()), "}"
    )
  ))
  expect_identical(read_response()$id, 1L)
  write_frame(charToRaw(
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  ))
  write_frame(charToRaw(
    '{"jsonrpc":"2.0","method":"ping","params":{}}'
  ))
  Sys.sleep(0.2)
  expect_length(child$read_output_lines(), 0L)
  write_frame(c(
    charToRaw('{"jsonrpc":"2.0","id":2,"method":"ping'),
    as.raw(0L), charToRaw('"}')
  ))
  expect_identical(read_response()$error$code, -32700L)
  write_frame(c(
    charToRaw('{"jsonrpc":"2.0","id":3,"method":"'),
    as.raw(c(0xc3L, 0x28L)), charToRaw('"}')
  ))
  expect_identical(read_response()$error$code, -32700L)
  write_frame(charToRaw(
    '{"jsonrpc":"2.0","id":4,"method":"ping","params":{}}'
  ))
  expect_identical(read_response()$id, 4L)
  write_frame(charToRaw(
    '{"jsonrpc":"2.0","id":5,"method":"shutdown","params":{}}'
  ))
  expect_identical(read_response()$id, 5L)
  processx::processx_conn_close(
    child$get_input_connection()
  )
  child$wait(30000)
  expect_identical(child$get_exit_status(), 0L)
  expect_identical(trimws(child$read_all_error()), "")
})

test_that("URL MCP preserves widget and run settlement parity", {
  nb_path <- tempfile("alder-mcp-url-settlement-", fileext = ".R")
  counter_path <- tempfile("alder-mcp-url-counter-")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "w <- ui$slider(1, 5, value = 2)", "w",
    "# %%",
    paste0(
      "result <- { Sys.sleep(0.2); if (w$value == 5) ",
      "stop('URL dependent failed'); w$value * 10L }"
    ),
    "result",
    "# %%", "go <- ui$run_button('Run')", "go",
    "# %%", "button_result <- { Sys.sleep(0.2); paste(go$value, 'URL consumer') }",
    "button_result",
    "# %%", "solo <- ui$run_button('Solo')", "solo",
    "# %%", "manual <- 1L", "manual",
    "# %%", paste0(
      "counter_file <- ", encodeString(counter_path, quote = '"')
    ),
    paste0(
      "counter <- if (file.exists(counter_file)) ",
      "as.integer(readLines(counter_file)) else 0L"
    ),
    "counter <- counter + 1L",
    "writeLines(as.character(counter), counter_file)",
    "counter"
  ), nb_path)
  lib <- alder_cache_lib()
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = TRUE)
  on.exit({
    stop_alder(srv)
    unlink(c(nb_path, counter_path))
  }, add = TRUE)
  code <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths()))\n",
    '    suppressPackageStartupMessages(library(alder))
    base <- sprintf("http://%s:%d", host, port)
    context <- alder:::mcp_backend(url = base)
    on.exit(context$close(), add = TRUE)
    empty <- alder:::mcp_empty_object()
    initialized <- alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "settlement-url-initialize", method = "initialize",
      params = list(protocolVersion = "2024-11-05", capabilities = empty,
                    clientInfo = list(name = "settlement-url", version = "1.0"))))
    stopifnot(is.null(initialized$error))
    stopifnot(is.null(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized", params = empty))))
    payload <- function(response) jsonlite::fromJSON(
      response$result$content[[1L]]$text, simplifyVector = FALSE
    )
    tool <- function(id, name,
                     arguments = alder:::mcp_empty_object()) alder:::mcp_dispatch(
      context,
      list(jsonrpc = "2.0", id = id, method = "tools/call",
           params = list(name = name, arguments = arguments))
    )
    cell <- function(state, id) state$cells[[which(vapply(
      state$cells, function(value) identical(value$id, id), logical(1L)
    ))]]
    widget <- function(state, name) {
      for (current in state$cells) for (output in rev(current$outputs)) {
        if (identical(output$kind, "widget") && identical(output$name, name)) {
          return(output)
        }
      }
      NULL
    }
    repeat {
      initial <- context$request("GET", "/api/state")
      if (!isTRUE(initial$runtime$busy)) break
      Sys.sleep(0.02)
    }

    started <- proc.time()[["elapsed"]]
    slider <- tool(1L, "set_widget", list(
      name = "w", value = 4, source = "editor"
    ))
    slider_elapsed <- proc.time()[["elapsed"]] - started
    slider_state <- context$request("GET", "/api/state")
    slider_operation <- context$request(
      "GET", paste0("/api/widget-operation?token=", payload(slider)$token)
    )$operation
    cat("slider", !isTRUE(slider$result$isError),
        slider_elapsed >= 0.15,
        identical(slider_operation$status, "done"),
        identical(widget(slider_state, "w")$spec$value, 4L),
        identical(cell(slider_state, "cell-3")$outputs[[1L]]$text, "[1] 40"),
        identical(slider_state$runtime$busy, FALSE), "\n")

    dependent <- tool(2L, "set_widget", list(
      name = "w", value = 5, source = "editor"
    ))
    dependent_state <- context$request("GET", "/api/state")
    cat("dependent", !isTRUE(dependent$result$isError),
        identical(cell(dependent_state, "cell-3")$status, "error"),
        grepl("URL dependent failed",
              cell(dependent_state, "cell-3")$error$message, fixed = TRUE),
        identical(dependent_state$runtime$busy, FALSE), "\n")

    rejected <- tool(3L, "set_widget", list(
      name = "w", value = 99, source = "editor"
    ))
    cat("rejected", isTRUE(rejected$result$isError),
        identical(payload(rejected)$error$code, "widget_update_failed"),
        nzchar(payload(rejected)$error$message), "\n")

    solo_first <- tool(4L, "set_widget", list(
      name = "solo", value = TRUE, source = "editor"
    ))
    solo_first_state <- context$request("GET", "/api/state")
    solo_second <- tool(5L, "set_widget", list(
      name = "solo", value = TRUE, source = "editor"
    ))
    solo_second_state <- context$request("GET", "/api/state")
    cat("solo", !isTRUE(solo_first$result$isError),
        !isTRUE(solo_second$result$isError),
        !identical(payload(solo_first)$token, payload(solo_second)$token),
        identical(widget(solo_first_state, "solo")$spec$value, FALSE),
        identical(widget(solo_first_state, "solo")$operation$status, "done"),
        identical(widget(solo_second_state, "solo")$spec$value, FALSE),
        identical(widget(solo_second_state, "solo")$operation$status, "done"),
        "\n")

    button_first <- tool(6L, "set_widget", list(
      name = "go", value = TRUE, source = "editor"
    ))
    button_first_state <- context$request("GET", "/api/state")
    button_second <- tool(7L, "set_widget", list(
      name = "go", value = TRUE, source = "app"
    ))
    button_second_state <- context$request("GET", "/api/state")
    cat("buttons", !isTRUE(button_first$result$isError),
        !isTRUE(button_second$result$isError),
        identical(cell(button_first_state, "cell-5")$status, "done"),
        identical(widget(button_first_state, "go")$spec$value, FALSE),
        identical(widget(button_first_state, "go")$operation$status, "done"),
        identical(cell(button_second_state, "cell-5")$status, "done"),
        identical(widget(button_second_state, "go")$spec$value, FALSE),
        identical(widget(button_second_state, "go")$operation$status, "done"),
        "\n")

    context$request("POST", "/api/runtime", list(execution_mode = "lazy"))
    lazy <- tool(8L, "set_widget", list(
      name = "go", value = TRUE, source = "editor"
    ))
    lazy_state <- context$request("GET", "/api/state")
    lazy_operation <- context$request(
      "GET", paste0("/api/widget-operation?token=", payload(lazy)$token)
    )$operation
    cat("lazy", !isTRUE(lazy$result$isError),
        identical(lazy_operation$status, "done"),
        identical(lazy_operation$reset_expected, FALSE),
        is.null(lazy_operation$reset_token),
        identical(widget(lazy_state, "go")$spec$value, TRUE),
        identical(cell(lazy_state, "cell-5")$status, "stale"),
        identical(lazy_state$runtime$busy, FALSE), "\n")

    lazy_app <- tool(9L, "set_widget", list(
      name = "go", value = TRUE, source = "app"
    ))
    lazy_app_state <- context$request("GET", "/api/state")
    cat("lazy-app", !isTRUE(lazy_app$result$isError),
        identical(cell(lazy_app_state, "cell-5")$status, "done"),
        identical(widget(lazy_app_state, "go")$spec$value, FALSE),
        identical(widget(lazy_app_state, "go")$operation$status, "done"),
        identical(lazy_app_state$runtime$busy, FALSE), "\n")

    context$request("POST", "/api/runtime", list(execution_mode = "automatic"))
    tool(10L, "edit_cell", list(
      cell = "cell-7",
      body = list("manual <- { Sys.sleep(0.2); 42L }", "manual"),
      type = "code"
    ))
    started <- proc.time()[["elapsed"]]
    run <- tool(11L, "run_cell", list(cell = "cell-7"))
    run_elapsed <- proc.time()[["elapsed"]] - started
    run_state <- context$request("GET", "/api/state")
    cat("run-cell", !isTRUE(run$result$isError), run_elapsed >= 0.15,
        identical(cell(run_state, "cell-7")$status, "done"),
        identical(run_state$runtime$busy, FALSE), "\n")

    tool(12L, "edit_cell", list(
      cell = "cell-7", body = list("stop(\\\"URL cell failed\\\")"),
      type = "code"
    ))
    failed_run <- tool(13L, "run_cell", list(cell = "cell-7"))
    failed_run_state <- context$request("GET", "/api/state")
    cat("run-error-state", !isTRUE(failed_run$result$isError),
        identical(cell(failed_run_state, "cell-7")$status, "error"),
        grepl("URL cell failed", cell(failed_run_state, "cell-7")$error$message,
              fixed = TRUE),
        identical(failed_run_state$runtime$busy, FALSE), "\n")

    tool(14L, "edit_cell", list(
      cell = "cell-7",
      body = list("manual <- { Sys.sleep(0.2); 84L }", "manual"),
      type = "code"
    ))
    started <- proc.time()[["elapsed"]]
    run_all <- tool(15L, "run_all")
    run_all_elapsed <- proc.time()[["elapsed"]] - started
    run_all_state <- context$request("GET", "/api/state")
    counter_after_all <- cell(run_all_state, "cell-8")$outputs[[1L]]$text
    cat("run-all", !isTRUE(run_all$result$isError), run_all_elapsed >= 0.15,
        identical(run_all_state$runtime$busy, FALSE), "\n")

    tool(16L, "edit_cell", list(
      cell = "cell-7",
      body = list("manual <- { Sys.sleep(0.2); 126L }", "manual"),
      type = "code"
    ))
    started <- proc.time()[["elapsed"]]
    run_stale <- tool(17L, "run_stale")
    run_stale_elapsed <- proc.time()[["elapsed"]] - started
    run_stale_state <- context$request("GET", "/api/state")
    cat("run-stale-auto", !isTRUE(run_stale$result$isError),
        run_stale_elapsed >= 0.15,
        identical(cell(run_stale_state, "cell-7")$status, "done"),
        identical(
          cell(run_stale_state, "cell-8")$outputs[[1L]]$text,
          counter_after_all
        ),
        identical(run_stale_state$runtime$busy, FALSE), "\n")

    context$request("POST", "/api/runtime", list(execution_mode = "lazy"))
    tool(18L, "edit_cell", list(
      cell = "cell-7",
      body = list("manual <- { Sys.sleep(0.2); 168L }", "manual"),
      type = "code"
    ))
    started <- proc.time()[["elapsed"]]
    lazy_stale <- tool(19L, "run_stale")
    lazy_stale_elapsed <- proc.time()[["elapsed"]] - started
    lazy_stale_state <- context$request("GET", "/api/state")
    cat("run-stale-lazy", !isTRUE(lazy_stale$result$isError),
        lazy_stale_elapsed >= 0.15,
        identical(cell(lazy_stale_state, "cell-7")$status, "done"),
        identical(lazy_stale_state$runtime$busy, FALSE), "\n")

    lazy_counter_before_all <-
      cell(lazy_stale_state, "cell-8")$outputs[[1L]]$text
    run_all_lazy <- tool(20L, "run_all")
    run_all_lazy_state <- context$request("GET", "/api/state")
    cat("run-all-lazy", !isTRUE(run_all_lazy$result$isError),
        !identical(
          cell(run_all_lazy_state, "cell-8")$outputs[[1L]]$text,
          lazy_counter_before_all
        ),
        identical(run_all_lazy_state$runtime$busy, FALSE), "\n")

    tool(21L, "edit_cell", list(
      cell = "cell-7", body = list("Sys.sleep(5)", "manual <- 999L"),
      type = "code"
    ))
    context$request("POST", "/api/run", list(cell = "cell-7"))
    interrupted <- tool(22L, "interrupt")
    interrupted_state <- context$request("GET", "/api/state")
    cat("interrupt", !isTRUE(interrupted$result$isError),
        identical(interrupted_state$runtime$busy, FALSE), "\n")'
  )
  child_path <- tempfile("alder-mcp-url-child-", fileext = ".R")
  writeLines(c(
    sprintf("port <- %d; host <- '127.0.0.1'", port), code
  ), child_path, useBytes = TRUE)
  on.exit(unlink(child_path), add = TRUE)
  child <- processx::process$new(
    file.path(R.home("bin"), "Rscript"),
    c("--vanilla", child_path), stdout = "|", stderr = "|"
  )
  out <- character()
  child_errors <- character()
  deadline <- Sys.time() + 60
  repeat {
    out <- c(out, child$read_output_lines())
    child_errors <- c(child_errors, child$read_error_lines())
    if (!child$is_alive()) {
      out <- c(out, child$read_output_lines())
      child_errors <- c(child_errors, child$read_error_lines())
      break
    }
    if (Sys.time() >= deadline) {
      child$kill()
      break
    }
    later::run_now(0.05)
  }
  child$wait(5000)
  out <- trimws(out)
  expect_identical(
    child$get_exit_status(), 0L,
    info = paste(child_errors, collapse = "\n")
  )
  expect_identical(trimws(paste(child_errors, collapse = "\n")), "")
  expect_true(
    any(grepl("^slider TRUE TRUE TRUE TRUE TRUE TRUE$", out)),
    info = paste(out, collapse = "\n")
  )
  expect_true(any(grepl("^dependent TRUE TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^rejected TRUE TRUE TRUE$", out)))
  expect_true(any(grepl(
    "^solo TRUE TRUE TRUE TRUE TRUE TRUE TRUE$", out
  )))
  expect_true(any(grepl(
    "^buttons TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE$", out
  )))
  expect_true(any(grepl("^lazy TRUE TRUE TRUE TRUE TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^lazy-app TRUE TRUE TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^run-cell TRUE TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^run-error-state TRUE TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^run-all TRUE TRUE TRUE$", out)))
  expect_true(any(grepl(
    "^run-stale-auto TRUE TRUE TRUE TRUE TRUE$", out
  )))
  expect_true(any(grepl("^run-stale-lazy TRUE TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^run-all-lazy TRUE TRUE TRUE$", out)))
  expect_true(any(grepl("^interrupt TRUE TRUE$", out)))
})

test_that("URL MCP run tools settle queued lazy run-button resets", {
  nb_path <- tempfile("alder-mcp-url-lazy-run-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "go <- ui$run_button('Run')", "go",
    "# %%", "result <- { Sys.sleep(0.1); paste(go$value, 'consumer') }",
    "result",
    "# %%", "sleeper <- { Sys.sleep(0.25); 1L }", "sleeper"
  ), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = TRUE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  lib <- alder_cache_lib()
  code <- paste0(
    ".libPaths(c(", encodeString(lib, quote = '"'), ", .libPaths()))\n",
    'suppressPackageStartupMessages(library(alder))
    context <- alder:::mcp_backend(url = sprintf("http://%s:%d", host, port))
    on.exit(context$close(), add = TRUE)
    empty <- alder:::mcp_empty_object()
    initialized <- alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", id = "lazy-run-url-initialize", method = "initialize",
      params = list(protocolVersion = "2024-11-05", capabilities = empty,
                    clientInfo = list(name = "lazy-run-url", version = "1.0"))))
    stopifnot(is.null(initialized$error))
    stopifnot(is.null(alder:::mcp_dispatch(context, list(
      jsonrpc = "2.0", method = "notifications/initialized", params = empty))))
    payload <- function(response) jsonlite::fromJSON(
      response$result$content[[1L]]$text, simplifyVector = FALSE
    )
    tool <- function(id, name,
                     arguments = alder:::mcp_empty_object()) alder:::mcp_dispatch(
      context,
      list(jsonrpc = "2.0", id = id, method = "tools/call",
           params = list(name = name, arguments = arguments))
    )
    cell <- function(state, id) state$cells[[which(vapply(
      state$cells, function(value) identical(value$id, id), logical(1L)
    ))]]
    repeat {
      initial <- context$request("GET", "/api/state")
      if (!isTRUE(initial$runtime$busy)) break
      Sys.sleep(0.02)
    }
    context$request("POST", "/api/runtime", list(execution_mode = "lazy"))

    context$request("POST", "/api/run", list(cell = "cell-4"))
    repeat {
      active <- context$request("GET", "/api/state")
      if (isTRUE(active$runtime$busy)) break
      Sys.sleep(0.01)
    }
    pressed <- tool(1L, "set_widget", list(
      name = "go", value = TRUE, source = "editor"
    ))
    pressed_state <- context$request("GET", "/api/state")
    run_one <- tool(2L, "run_cell", list(cell = "cell-3"))
    run_one_payload <- payload(run_one)
    run_one_operation <- context$request(
      "GET", paste0("/api/run-operation?run_id=", run_one_payload$run_id)
    )$operation
    run_one_state <- context$request("GET", "/api/state")
    reset <- context$request(
      "GET", paste0(
        "/api/widget-operation?token=",
        run_one_operation$reset_tokens[[1L]]
      )
    )$operation
    cat("queued-cell", !isTRUE(pressed$result$isError),
        identical(cell(pressed_state, "cell-3")$status, "stale"),
        identical(alder:::mcp_widget_spec_from_state(
          pressed_state, "go")$value, TRUE),
        !isTRUE(run_one$result$isError),
        identical(run_one_operation$status, "done"),
        identical(reset$status, "done"),
        identical(alder:::mcp_widget_spec_from_state(
          run_one_state, "go")$value, FALSE),
        identical(cell(run_one_state, "cell-3")$status, "done"),
        identical(run_one_state$runtime$busy, FALSE), "\n")

    press_stale <- tool(3L, "set_widget", list(
      name = "go", value = TRUE, source = "editor"
    ))
    run_stale <- tool(4L, "run_stale")
    stale_payload <- payload(run_stale)
    stale_operation <- context$request(
      "GET", paste0("/api/run-operation?run_id=", stale_payload$run_id)
    )$operation
    stale_state <- context$request("GET", "/api/state")
    cat("queued-stale", !isTRUE(press_stale$result$isError),
        !isTRUE(run_stale$result$isError),
        identical(stale_operation$status, "done"),
        length(stale_operation$reset_tokens) == 1L,
        identical(alder:::mcp_widget_spec_from_state(
          stale_state, "go")$value, FALSE), "\n")

    press_all <- tool(5L, "set_widget", list(
      name = "go", value = TRUE, source = "editor"
    ))
    run_all <- tool(6L, "run_all")
    all_payload <- payload(run_all)
    all_operation <- context$request(
      "GET", paste0("/api/run-operation?run_id=", all_payload$run_id)
    )$operation
    all_state <- context$request("GET", "/api/state")
    cat("queued-all", !isTRUE(press_all$result$isError),
        !isTRUE(run_all$result$isError),
        identical(all_operation$status, "done"),
        length(all_operation$reset_tokens) == 1L,
        identical(alder:::mcp_widget_spec_from_state(
          all_state, "go")$value, FALSE), "\n")

    ordinary <- tool(7L, "run_cell", list(cell = "cell-4"))
    ordinary_payload <- payload(ordinary)
    ordinary_operation <- context$request(
      "GET", paste0("/api/run-operation?run_id=", ordinary_payload$run_id)
    )$operation
    cat("ordinary", !isTRUE(ordinary$result$isError),
        identical(ordinary_operation$status, "done"),
        length(ordinary_operation$reset_tokens) == 0L, "\n")'
  )
  out <- trimws(http_child(port, code))
  expect_true(any(grepl(
    "^queued-cell TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE TRUE$", out
  )), info = paste(out, collapse = "\n"))
  expect_true(any(grepl("^queued-stale TRUE TRUE TRUE TRUE TRUE$", out)),
              info = paste(out, collapse = "\n"))
  expect_true(any(grepl("^queued-all TRUE TRUE TRUE TRUE TRUE$", out)),
              info = paste(out, collapse = "\n"))
  expect_true(any(grepl("^ordinary TRUE TRUE TRUE$", out)),
              info = paste(out, collapse = "\n"))
})

test_that("URL MCP propagates the causal reset operation error", {
  requests <- 0L
  context <- new.env(parent = emptyenv())
  context$timeout <- 1
  context$request <- function(method, route, body = NULL) {
    requests <<- requests + 1L
    if (identical(route, "/api/state")) {
      return(list(runtime = list(busy = FALSE), cells = list()))
    }
    if (grepl("token=1$", route)) {
      return(list(operation = list(
        token = 1L, status = "done", error = NULL,
        reset_expected = TRUE, reset_token = 2L
      )))
    }
    if (grepl("token=2$", route)) {
      return(list(operation = list(
        token = 2L, status = "error",
        error = list(
          code = "worker_unavailable",
          message = "injected URL reset failure"
        )
      )))
    }
    stop("unexpected fake request")
  }
  error <- tryCatch(
    alder:::mcp_wait_http_widget(context, 1L, "go"),
    error = identity
  )
  expect_s3_class(error, "alder_error")
  expect_identical(error$code, "worker_unavailable")
  expect_match(conditionMessage(error), "injected URL reset failure",
               fixed = TRUE)
  expect_gte(requests, 4L)
})
