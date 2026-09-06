# Server boundary: strict JSON bodies, origin/Host validation, HTTP error
# mapping, route validation, static/artifact serving, and lifecycle teardown.

mk_root <- function() {
  root <- tempfile("alder-root-")
  dir.create(file.path(root), recursive = TRUE)
  writeLines("var x = 1;", file.path(root, "app.js"))
  writeLines("body { }", file.path(root, "style.css"))
  writeLines("secret", file.path(root, "secret.txt"))
  root
}

test_that("safe_child_path serves only contained allowlisted files", {
  root <- mk_root()
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  expect_equal(alder:::safe_child_path(root, "app.js", c("js", "css")),
               normalizePath(file.path(root, "app.js")))
  expect_equal(alder:::safe_child_path(root, "style.css", c("js", "css")),
               normalizePath(file.path(root, "style.css")))
  expect_null(alder:::safe_child_path(root, "secret.txt", c("js", "css")))
  expect_null(alder:::safe_child_path(root, "app.md", c("js", "css")))
  expect_null(alder:::safe_child_path(root, "nope.js", c("js", "css")))
  expect_null(alder:::safe_child_path(root, "", c("js", "css")))
})

test_that("safe_child_path rejects traversal, separators, and escapes", {
  root <- mk_root()
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  bad <- c(
    "../DESCRIPTION",                       # direct traversal
    "..%2F..%2FDESCRIPTION",                # percent-encoded traversal
    "%2e%2e%2f%2e%2e%2fDESCRIPTION",        # fully encoded traversal
    "..%5CDESCRIPTION",                     # encoded backslash
    "/private/etc/passwd.js",               # absolute
    "C:%5Cwindows%5Cwin.ini",               # windows drive
    "a%00b.js",                              # NUL byte
    ".hidden.js",                            # dotfile
    "..",                                    # parent segment
    "app.js%3Fextra",                        # query bits in name
    "sibling-root2%2Fapp.js"                 # nested path
  )
  for (p in bad) {
    expect_null(alder:::safe_child_path(root, p, c("js", "css")), info = p)
  }
  sibling <- tempfile(paste0(basename(root), "-"))
  dir.create(sibling)
  on.exit(unlink(sibling, recursive = TRUE), add = TRUE)
  writeLines("nope", file.path(sibling, "x.js"))
  expect_null(alder:::safe_child_path(root, "x.js", c("js", "css")))
})

test_that("artifact_content_type maps the fixed artifact kinds", {
  expect_equal(alder:::artifact_content_type("png"), "image/png")
  expect_equal(alder:::artifact_content_type("html"), "text/html; charset=utf-8")
  expect_equal(alder:::artifact_content_type("PNG"), "image/png")
  expect_null(alder:::artifact_content_type("txt"))
  expect_null(alder:::artifact_content_type(""))
})

test_that("json_dup_key finds duplicated parsed-object names at any depth", {
  parse_json <- function(text) {
    jsonlite::fromJSON(text, simplifyVector = FALSE)
  }
  expect_null(alder:::json_dup_key(parse_json('{"a": 1}')))
  expect_null(alder:::json_dup_key(parse_json('{"a": {"b": 1, "c": 2}}')))
  expect_equal(alder:::json_dup_key(parse_json('{"a": 1, "a": 2}')), "a")
  expect_equal(alder:::json_dup_key(
    parse_json('{"a": {"b": 1, "b": 2}}')
  ), "b")
  expect_equal(alder:::json_dup_key(parse_json('{"x": [1, 2], "x": 3}')), "x")
  # strings containing braces/colons are not objects or keys
  expect_null(alder:::json_dup_key(parse_json('{"a": "x: {y}", "b": 2}')))
  expect_null(alder:::json_dup_key(parse_json('{"a": "\\"quoted\\": value"}')))
  # duplicates in sibling objects are independent
  expect_null(alder:::json_dup_key(
    parse_json('{"a": {"k": 1}, "b": {"k": 2}}')
  ))
  expect_equal(alder:::json_dup_key(
    parse_json('{"a": {"k": 1, "k": 2}, "b": {"k": 3}}')
  ), "k")
  # escaped keys decode before comparison
  parsed <- parse_json('{"a": 1, "\\u0061": 2}')
  expect_identical(names(parsed), c("a", "a"))
  expect_equal(alder:::json_dup_key(parsed), "a")
  expect_equal(alder:::json_dup_key(
    parse_json('{"\\u0062": 1, "b": 2}')
  ), "b")
  # nested keys are scoped to their own object and decode JSON escapes before
  # comparison, including a UTF-16 surrogate pair against literal UTF-8.
  expect_null(alder:::json_dup_key(parse_json(
    '{"left": {"\\u006b": 1}, "right": {"k": 2}}'
  )))
  expect_equal(alder:::json_dup_key(parse_json(
    '{"outer": {"\\u006b": 1, "k": 2}}'
  )), "k")
  expect_equal(alder:::json_dup_key(parse_json(
    '{"\\uD83D\\uDE00": 1, "😀": 2}'
  )), "😀")
  # The traversal is total for invalid caller input; HTTP input is parsed
  # before this helper is reached.
  expect_null(alder:::json_dup_key("not a parsed object"))
})

test_that("read_json_body bounds large upload and dense scalar-array preflight", {
  make_upload <- function(size) paste0(
    '{"name":"file_widget","files":[{"name":"x.bin",',
    '"content_base64":"', strrep("A", size), '"}]}'
  )
  mkreq <- function(body) {
    rawbody <- charToRaw(body)
    list(
      CONTENT_TYPE = "application/json",
      CONTENT_LENGTH = as.character(length(rawbody)),
      rook.input = list(read_bytes = function(n) rawbody[seq_len(min(n, length(rawbody)))])
    )
  }
  check_body <- function(body, limit = 5) {
    bytes <- length(charToRaw(body))
    elapsed <- system.time({
      result <- alder:::read_json_body(mkreq(body), max_bytes = bytes)
    })[["elapsed"]]
    expect_null(result$error)
    expect_lt(unname(elapsed), limit)
  }
  prefix_bytes <- nchar(paste0(
    '{"name":"file_widget","files":[{"name":"x.bin",',
    '"content_base64":"'
  ),
                        type = "bytes")
  suffix_bytes <- nchar('"}]}', type = "bytes")
  for (size in c(1024L * 1024L, 16L * 1024L * 1024L -
                 prefix_bytes - suffix_bytes)) {
    # This exercises the actual parse + duplicate-check API path, not only the
    # post-parse helper. The prior scanner exceeded ten seconds at 50 KiB.
    check_body(make_upload(size))
  }
  # Stay below the structural separator cap while checking that scalar array
  # members are not revisited one-by-one by the parsed-tree traversal.
  check_body(paste0('{"values":[', strrep("0,", 50000L), "0]}"))
})

test_that("read_json_body rejects bad media type, size, root, NULs, dups", {
  mkreq <- function(ct, body = "{}", clen = NULL, rawbody = NULL) {
    if (is.null(rawbody)) rawbody <- charToRaw(body)
    list(CONTENT_TYPE = ct, CONTENT_LENGTH = clen,
         rook.input = list(read_bytes = function(n) {
           if (length(rawbody) <= n) rawbody else rawbody[seq_len(n)]
         }))
  }
  r <- alder:::read_json_body(mkreq("text/plain"))
  expect_equal(r$error$code, "unsupported_media_type")
  expect_equal(r$error$status, 415L)
  r <- alder:::read_json_body(mkreq("application/json", "", "0"))
  expect_equal(r$error$code, "invalid_request")
  expect_equal(r$error$status, 400L)
  r <- alder:::read_json_body(mkreq("application/json", "[1, 2]"))
  expect_equal(r$error$code, "invalid_request")
  r <- alder:::read_json_body(mkreq("application/json", '{"a": 1, "a": 2}'))
  expect_equal(r$error$code, "invalid_request")
  expect_match(r$error$message, "duplicate")
  r <- alder:::read_json_body(mkreq("application/json", '{"a": {"b": 1, "b": 2}}'))
  expect_equal(r$error$code, "invalid_request")
  # declared size above limit
  r <- alder:::read_json_body(mkreq("application/json", "{}", "2000000"))
  expect_equal(r$error$code, "payload_too_large")
  expect_equal(r$error$status, 413L)
  # Both the declared-length preflight and the bounded read report the active
  # route limit rather than a stale generic 1 MiB string.
  for (limit in c(1024 * 1024, 16 * 1024 * 1024)) {
    label <- paste("request body exceeds", limit / (1024 * 1024), "MiB")
    declared <- alder:::read_json_body(mkreq(
      "application/json", "{}", as.character(limit + 1)
    ), max_bytes = limit)
    observed <- alder:::read_json_body(mkreq(
      "application/json", rawbody = raw(limit + 1)
    ), max_bytes = limit)
    expect_identical(declared$error$message, label)
    expect_identical(observed$error$message, label)
    expect_identical(declared$error$status, 413L)
    expect_identical(observed$error$status, 413L)
  }
  # NUL bytes in the raw body (built as bytes: R strings drop NULs)
  nulbody <- c(charToRaw('{"a": "x'), as.raw(0), charToRaw('y"}'))
  r <- alder:::read_json_body(mkreq("application/json", rawbody = nulbody))
  expect_equal(r$error$code, "invalid_request")
  expect_match(r$error$message, "NUL")
  invalid_utf8 <- c(charToRaw('{"a":"'), as.raw(255L), charToRaw('"}'))
  r <- alder:::read_json_body(mkreq("application/json", rawbody = invalid_utf8))
  expect_equal(r$error$code, "invalid_request")
  expect_match(r$error$message, "invalid JSON")
  # malformed JSON (unterminated string) is a plain 400
  r <- alder:::read_json_body(mkreq("application/json", '{"a": "x'))
  expect_equal(r$error$code, "invalid_request")
  expect_equal(r$error$status, 400L)
  # escaped-key duplicate reaches the 400 response
  r <- alder:::read_json_body(mkreq("application/json",
                                    '{"a": 1, "\\u0061": 2}'))
  expect_equal(r$error$code, "invalid_request")
  # valid object parses
  r <- alder:::read_json_body(mkreq("application/json", '{"a": 1, "b": [2]}'))
  expect_null(r$error)
  expect_equal(r$body$a, 1)
})

test_that("read_json_body rejects structural floods before JSON parsing", {
  mkreq <- function(body) {
    rawbody <- charToRaw(body)
    list(
      CONTENT_TYPE = "application/json",
      CONTENT_LENGTH = as.character(length(rawbody)),
      rook.input = list(read_bytes = function(n) rawbody[seq_len(min(n, length(rawbody)))])
    )
  }
  read <- function(body) alder:::read_json_body(
    mkreq(body), max_bytes = length(charToRaw(body))
  )
  deep <- function(depth) paste0(
    '{"x":', strrep("[", depth), "0", strrep("]", depth), "}"
  )
  dense <- function(count) paste0(
    '{"x":[', paste(rep("{}", count), collapse = ","), "]}"
  )
  # Braces and escaped quotes inside scalar strings do not contribute.
  expect_null(read('{"x":""}')$error)
  expect_null(read('{"source":"\\n"}')$error)
  expect_null(read(paste0(
    '{"name":"files","files":[{"name":"empty.bin",',
    '"content_base64":""}]}'
  ))$error)
  # The fixed-size structural scanner must retain counts and nesting across
  # chunk boundaries, including punctuation immediately after a long string.
  chunk_edge <- strrep("a", 65536L - nchar('{"x":"', type = "bytes"))
  expect_null(read(paste0('{"x":"', chunk_edge, '","y":[]}'))$error)
  expect_equal(read(paste0('{"x":"', chunk_edge,
                           '","y":', strrep("[", 1024L), "0",
                           strrep("]", 1024L), "}"))$error$code,
               "invalid_request")
  post_strip_edge <- strrep(
    " ", 65536L - nchar('{"x":', type = "bytes")
  )
  expect_null(read(paste0('{"x":', post_strip_edge,
                          strrep("[", 1023L), "0",
                          strrep("]", 1023L), "}"))$error)
  expect_equal(read(paste0('{"x":', post_strip_edge,
                           strrep("[", 1024L), "0",
                           strrep("]", 1024L), "}"))$error$code,
               "invalid_request")
  expect_match(read('{"":1,"":2}')$error$message, "duplicate object key")
  expect_null(read('{"x":"{ [ ] \\" {", "y":[]}')$error)
  expect_null(read(paste0('{"x":"', intToUtf8(127L), '[]"}'))$error)
  expect_null(read('{"x":"\\uD83D\\uDE00"}')$error)
  expect_null(read('{"x":"\\\\u0000"}')$error)
  for (unsafe in c('{"x":"\\u0000"}', '{"\\u0000":1}',
                   '{"x":"\\uD800"}', '{"x":"\\uDC00"}')) {
    expect_equal(read(unsafe)$error$code, "invalid_request")
  }
  # An unsafe token followed by safe fields must not let the matcher restart at
  # the unsafe closing quote and consume through later JSON syntax.
  expect_equal(read('{"bad":"\\u0000", "safe":"ok", "n":1}')$error$code,
               "invalid_request")
  expect_null(read(deep(1023L))$error)
  expect_equal(read(deep(1024L))$error$code, "invalid_request")
  expect_null(read(dense(9998L))$error)
  expect_equal(read(dense(9999L))$error$code, "invalid_request")
  # Scalar/member complexity is separately bounded before jsonlite builds a
  # huge list for an otherwise shallow numeric or string array.
  expect_equal(read(paste0('{"x":[', strrep("0,", 100001L), "0]}"))$error$code,
               "invalid_request")
  expect_equal(read(paste0('{"x":[', strrep('"v",', 100001L), '"v"]}'))$error$code,
               "invalid_request")
  empty_values <- paste(rep('""', 99999L), collapse = ",")
  expect_null(read(paste0('{"x":[', empty_values, "]}"))$error)
  expect_equal(read(paste0('{"x":[', empty_values, ',""]}'))$error$code,
               "invalid_request")
  # Both would otherwise reach jsonlite's recursive parser; they must fail at
  # the cheap pre-parse guard instead of risking a protection-stack overflow.
  for (depth in c(40000L, 50000L)) {
    result <- read(deep(depth))
    expect_equal(result$error$code, "invalid_request")
    expect_match(result$error$message, "structural complexity")
  }
})

test_that("start_alder validates its arguments", {
  expect_error(start_alder(path = character()), "`path`")
  expect_error(start_alder(path = NA_character_), "`path`")
  expect_error(start_alder(port = 0L), "`port`")
  expect_error(start_alder(port = 70000L), "`port`")
  expect_error(start_alder(port = "8899"), "`port`")
  expect_error(start_alder(host = ""), "`host`")
  for (non_loopback in c("0.0.0.0", "127.0.0.2", "::", "example.com")) {
    expect_error(start_alder(host = non_loopback), "non-loopback binds")
    expect_error(
      start_alder(host = non_loopback,
                  allowed_origins = "http://example.com:8899"),
      "non-loopback binds"
    )
  }
  expect_error(start_alder(open = NA), "`open`")
  expect_error(start_alder(idle_timeout = -1), "`idle_timeout`")
  expect_error(start_alder(idle_timeout = Inf), "`idle_timeout`")
  expect_error(start_alder(run_on_startup = "yes"), "`run_on_startup`")
  expect_error(start_alder(execution_mode = "weird"), "one of")
  expect_error(start_alder(allowed_origins = "not a url"), "invalid origin")
  # nonexistent path: parent must exist
  expect_error(start_alder(path = file.path(tempfile(), "x.R")),
               "parent directory")
})

test_that("start_alder uses runtime metadata unless arguments are explicit", {
  root <- tempfile("alder-runtime-default-")
  dir.create(root)
  nb_path <- file.path(root, "notebook.R")
  writeLines(c(
    "# ---",
    "# runtime:",
    "#   execution_mode: lazy",
    "#   run_on_startup: false",
    "# ---",
    "# %%",
    "x <- 1"
  ), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port)
  on.exit({
    stop_alder(srv)
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  expect_true(dir.exists(srv$cache_dir))
  expect_true(any(grepl("^\\.alder/", readLines(file.path(root, ".gitignore")))))
  expect_identical(srv$session$state()$runtime$execution_mode, "lazy")
  expect_false(srv$session$state()$runtime$run_on_startup)
  stop_alder(srv)

  srv <- start_alder(
    nb_path, port = httpuv::randomPort(),
    execution_mode = "automatic", run_on_startup = FALSE
  )
  expect_identical(srv$session$state()$runtime$execution_mode, "automatic")
  expect_false(srv$session$state()$runtime$run_on_startup)
})

test_that("invalid layout sidecars have public state and route diagnostics", {
  root <- tempfile("alder-invalid-layout-")
  dir.create(root)
  notebook <- file.path(root, "notebook.R")
  sidecar <- paste0(notebook, ".alder-layout.json")
  writeLines(c("# %%", "x <- 1"), notebook)
  writeBin(charToRaw("{ this is deliberately malformed layout JSON\n"),
           sidecar)
  port <- httpuv::randomPort()
  expect_message(
    srv <- start_alder(notebook, port = port, run_on_startup = FALSE),
    "invalid layout JSON"
  )
  on.exit({
    stop_alder(srv)
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)

  code <- '    base <- sprintf("http://%s:%d", host, port)
    state <- curl::curl_fetch_memory(paste0(base, "/api/state"))
    parsed <- jsonlite::fromJSON(rawToChar(state$content), simplifyVector = FALSE)
    cat("state", state$status_code, parsed$layout_error$code,
        parsed$last_action_error$code, "|", parsed$layout_error$message, "\\n")
    layout <- curl::curl_fetch_memory(paste0(base, "/api/layout"))
    cat("layout", layout$status_code, "|", rawToChar(layout$content), "\\n")'
  out <- http_child(port, code)
  expect_true(any(grepl(
    "^state 200 invalid_layout invalid_layout .*invalid layout JSON", out
  )))
  expect_true(any(grepl(
    '^layout 400 \\|.*"code":"invalid_layout".*invalid layout JSON', out
  )))
  expect_identical(
    readBin(sidecar, "raw", n = file.info(sidecar)$size),
    charToRaw("{ this is deliberately malformed layout JSON\n")
  )
})

test_that("gallery surfaces malformed Alder files with a specific 400", {
  gallery <- tempfile("alder-invalid-gallery-")
  dir.create(gallery)
  writeLines(c("# %% [markdown]", "# Valid gallery notebook", "# %%", "1 + 1"),
             file.path(gallery, "good.R"))
  writeLines(c(
    "# ---", "# title: [unterminated", "# ---", "# %%", "1 + 1"
  ), file.path(gallery, "bad.R"))
  writeLines("ordinary R file with no Alder cell delimiter",
             file.path(gallery, "plain.R"))
  port <- httpuv::randomPort()
  expect_message(
    srv <- start_alder(gallery, port = port, run_on_startup = FALSE),
    "Could not load bad.R: malformed YAML metadata"
  )
  on.exit({
    stop_alder(srv)
    unlink(gallery, recursive = TRUE, force = TRUE)
  }, add = TRUE)

  code <- '    base <- sprintf("http://%s:%d", host, port)
    index <- curl::curl_fetch_memory(paste0(base, "/"))
    html <- rawToChar(index$content)
    cat("index", index$status_code,
        "bad", lengths(regmatches(html, gregexpr("bad.R", html, fixed = TRUE))),
        "plain", grepl("plain.R", html, fixed = TRUE),
        "alert", grepl("role=\\\"alert\\\"", html, fixed = TRUE), "\\n")
    bad <- curl::curl_fetch_memory(paste0(base, "/n/bad.R"))
    cat("bad", bad$status_code, "|", rawToChar(bad$content), "\\n")
    good <- curl::curl_fetch_memory(paste0(base, "/n/good.R"))
    cat("good", good$status_code, "\\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^index 200 bad 1 plain FALSE alert TRUE", out)))
  expect_true(any(grepl(
    '^bad 400 \\|.*"code":"invalid_notebook".*malformed YAML metadata', out
  )))
  expect_true(any(grepl("^good 200", out)))
})

test_that("origin validation: Host required, Origin exact, loopback defaults", {
  origins <- alder:::build_origins("127.0.0.1", 8899L, NULL)
  expect_setequal(origins,
                  c("http://127.0.0.1:8899", "http://localhost:8899",
                    "http://[::1]:8899"))
  hosts <- alder:::origin_hosts(origins)
  ok <- list(HTTP_HOST = "127.0.0.1:8899")
  expect_true(alder:::validate_origin(ok, origins, hosts))
  expect_true(alder:::validate_origin(list(HTTP_HOST = "localhost:8899",
                                           HTTP_ORIGIN = "http://localhost:8899"),
                                      origins, hosts))
  expect_false(alder:::validate_origin(list(HTTP_HOST = "evil.example.com"),
                                       origins, hosts))
  expect_false(alder:::validate_origin(list(HTTP_HOST = "127.0.0.1:8899",
                                            HTTP_ORIGIN = "http://evil.example.com"),
                                       origins, hosts))
  expect_false(alder:::validate_origin(list(), origins, hosts))
  # explicit origins override the loopback defaults
  o2 <- alder:::build_origins("127.0.0.1", 8899L, "http://app.example.com:9")
  expect_identical(o2, "http://app.example.com:9")
  # Non-loopback binds are rejected even with an explicit origin.
  expect_error(alder:::build_origins("0.0.0.1", 8899L, NULL),
               "non-loopback binds")
  expect_error(alder:::build_origins(
    "0.0.0.1", 8899L, "http://app.example.com:9"
  ), "non-loopback binds")
})

test_that("error mapping covers the plan boundary codes", {
  m <- alder:::alder_error_status
  expect_equal(m("invalid_request"), 400L)
  expect_equal(m("notebook_has_no_path"), 400L)
  expect_equal(m("forbidden_origin"), 403L)
  expect_equal(m("not_found"), 404L)
  expect_equal(m("method_not_allowed"), 405L)
  expect_equal(m("graph_invalid"), 409L)
  expect_equal(m("source_conflict"), 409L)
  expect_equal(m("alder_save_conflict"), 409L)
  expect_equal(m("run_in_progress"), 409L)
  expect_equal(m("operation_in_progress"), 409L)
  expect_equal(m("widget_not_current"), 409L)
  expect_equal(m("no_run_in_progress"), 409L)
  expect_equal(m("payload_too_large"), 413L)
  expect_equal(m("unsupported_media_type"), 415L)
  expect_equal(m("worker_unavailable"), 503L)
  expect_equal(m("lsp_unavailable"), 503L)
  expect_equal(m("lsp_timeout"), 504L)
  expect_equal(m("format_unavailable"), 501L)
  expect_equal(m("format_failed"), 500L)
  expect_equal(m("internal_error"), 500L)
  expect_equal(m("bogus_code"), 500L)
})

test_that(".spawn_worker rejects invalid artifact directories", {
  script <- alder:::alder_worker_script()
  expect_error(alder:::.spawn_worker(script, getwd(), "/no/such/dir"),
               "does not exist")
  f <- tempfile()
  writeLines("x", f)
  on.exit(unlink(f), add = TRUE)
  expect_error(alder:::.spawn_worker(script, getwd(), f), "directory")
  expect_error(alder:::.spawn_worker(script, getwd(), NA_character_),
               "artifact directory")
  expect_error(alder:::.spawn_worker(script, getwd(), ""), "artifact directory")
})

test_that("worker readiness uses one request and reports startup diagnostics", {
  ready <- new.env(parent = emptyenv())
  ready$sent <- 0L
  ready$send <- function(command, on_response) {
    ready$sent <- ready$sent + 1L
    later::later(function() on_response(
      list(cmd = command), list(ok = TRUE, cmd = command)
    ), 0.01)
    ready$sent
  }
  ready$alive <- function() TRUE
  ready$diagnostics <- function() list(exit_status = NULL, stderr = "")
  expect_no_error(alder:::.wait_for_worker(ready, timeout = 1))
  expect_identical(ready$sent, 1L)

  failed <- new.env(parent = emptyenv())
  failed$is_alive <- TRUE
  failed$send <- function(command, on_response) {
    later::later(function() failed$is_alive <- FALSE, 0.01)
    1L
  }
  failed$alive <- function() failed$is_alive
  failed$diagnostics <- function() {
    list(exit_status = 7L, stderr = "fatal startup detail")
  }
  expect_error(
    alder:::.wait_for_worker(failed, timeout = 1),
    "exit status 7; stderr: fatal startup detail",
    fixed = TRUE
  )
})

test_that("package installation route returns while state stays responsive", {
  root <- tempfile("alder-package-route-")
  dir.create(root)
  nb_path <- file.path(root, "notebook.R")
  writeLines(c("# %%", "1"), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    h <- curl::new_handle()
    body <- jsonlite::toJSON(list(op = "install", packages = "DefinitelyMissingAlderPackage999999"), auto_unbox = TRUE)
    curl::handle_setopt(h, postfields = body, customrequest = "POST")
    curl::handle_setheaders(h, "Content-Type" = "application/json")
    started <- proc.time()[["elapsed"]]
    response <- curl::curl_fetch_memory(paste0(base, "/api/packages"), handle = h)
    install_elapsed <- proc.time()[["elapsed"]] - started
    started <- proc.time()[["elapsed"]]
    state <- curl::curl_fetch_memory(paste0(base, "/api/state"))
    state_elapsed <- proc.time()[["elapsed"]] - started
    parsed <- jsonlite::fromJSON(rawToChar(state$content), simplifyVector = FALSE)
    cat("install", response$status_code, "elapsed", install_elapsed, "\n")
    cat("state", state$status_code, "elapsed", state_elapsed, "\n")
    cat("installing", paste(unlist(parsed$packages$installing), collapse = ","), "\n")'
  out <- http_child(port, code)
  install <- out[grepl("^install ", out)]
  state <- out[grepl("^state ", out)]
  expect_match(install, "^install 202 elapsed ")
  expect_lt(as.numeric(sub(".* elapsed ", "", install)), 5)
  expect_match(state, "^state 200 elapsed ")
  expect_lt(as.numeric(sub(".* elapsed ", "", state)), 5)
  expect_true(any(grepl("DefinitelyMissingAlderPackage999999", out,
                        fixed = TRUE)))

  project_key <- normalizePath(root, mustWork = TRUE)
  stop_alder(srv)
  expect_false(exists(project_key, envir = alder:::ALDER_PACKAGE_JOBS,
                      inherits = FALSE))
})

test_that("start_alder/stop_alder teardown kills the worker and artifacts", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  expect_true(dir.exists(srv$artifact_dir))
  expect_true(srv$session$worker_available())
  artifact_dir <- srv$artifact_dir
  stop_alder(srv)
  expect_false(srv$session$worker_available())
  expect_false(dir.exists(artifact_dir))
  # repeated stop is a no-op
  stop_alder(srv)
  expect_false(dir.exists(artifact_dir))
})

test_that("state API keeps every dependency adjacency value as an array", {
  nb_path <- tempfile("alder-adjacency-route-", fileext = ".R")
  writeLines(c(
    "# %%", "x <- 1",
    "# %%", "y <- x + 1",
    "# %%", "z <- x + y",
    "# %%", "result <- z * 2"
  ), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '
    base <- sprintf("http://%s:%d", host, port)
    response <- curl::curl_fetch_memory(paste0(base, "/api/state"))
    state <- jsonlite::fromJSON(rawToChar(response$content), simplifyVector = FALSE)
    ids <- vapply(state$cells, `[[`, "", "id")
    base_arrays <- all(vapply(state$dag$edges, is.list, logical(1)))
    projected_edges <- state$dataflow$dag$edges
    projected_reverse <- state$dataflow$dag$reverse_edges
    projected_arrays <- all(vapply(projected_edges, is.list, logical(1))) &&
      all(vapply(projected_reverse, is.list, logical(1)))
    exact <- length(projected_edges[[ids[[1]]]]) == 0L &&
      identical(projected_edges[[ids[[2]]]], list(ids[[1]])) &&
      identical(projected_edges[[ids[[3]]]], list(ids[[1]], ids[[2]])) &&
      identical(projected_reverse[[ids[[4]]]], list())
    cat("status", response$status_code, "base", base_arrays,
        "projected", projected_arrays, "exact", exact, "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl(
    "^status 200 base TRUE projected TRUE exact TRUE$", trimws(out)
  )), info = paste(out, collapse = " | "))
})

test_that("static route serves assets with exact MIME and security headers", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '
    base <- sprintf("http://%s:%d", host, port)
    f <- function(url) {
      h <- curl::new_handle(nobody = FALSE)
      r <- curl::curl_fetch_memory(url, handle = h)
      cat(r$status_code, "|", r$type, "|", length(r$content), "\n")
    }
    f(paste0(base, "/static/app.js"))
    f(paste0(base, "/static/style.css"))
    f(paste0(base, "/static/../DESCRIPTION"))
    f(paste0(base, "/static/app.js/..%%252FDESCRIPTION"))
    f(paste0(base, "/index.html"))
  '
  out <- http_child(port, code)
  expect_true(any(grepl("^200 \\| text/javascript; charset=utf-8 \\|", out)))
  expect_true(any(grepl("^200 \\| text/css; charset=utf-8 \\|", out)))
  expect_true(any(grepl("^404 \\| application/json", out)))
  expect_true(any(grepl("^200 \\| text/html; charset=utf-8 \\|", out)))
})

test_that("editor document carries CSP and frame protection headers", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '
    base <- sprintf("http://%s:%d", host, port)
    r <- curl::curl_fetch_memory(paste0(base, "/"))
    h <- curl::parse_headers_list(r$headers)
    html <- rawToChar(r$content)
    cat("csp", h$`content-security-policy`, "\n")
    cat("nonce-meta", grepl(
      "name=\\\"alder-csp-nonce\\\" content=\\\"[A-Za-z0-9]{32}\\\"",
      html
    ), "\n")
    cat("nonce-marker", grepl("__ALDER_CSP_NONCE__", html, fixed = TRUE), "\n")
    cat("xfo", h$`x-frame-options`, "\n")
    cat("sniff", h$`x-content-type-options`, "\n")
    cat("ref", h$`referrer-policy`, "\n")
    cat("cache", h$`cache-control`, "\n")
  '
  out <- http_child(port, code)
  expect_true(any(grepl("^csp .*default-src 'self'", out)))
  expect_true(any(grepl("^csp .*frame-ancestors 'none'", out)))
  expect_true(any(grepl("^csp .*style-src-elem 'self' 'nonce-[A-Za-z0-9]{32}'", out)))
  expect_true(any(grepl("^csp .*style-src-attr 'unsafe-inline'", out)))
  expect_true(any(grepl("^nonce-meta TRUE", out)))
  expect_true(any(grepl("^nonce-marker FALSE", out)))
  expect_true(any(grepl("^xfo DENY", out)))
  expect_true(any(grepl("^sniff nosniff", out)))
  expect_true(any(grepl("^ref no-referrer", out)))
  expect_true(any(grepl("^cache no-store", out)))
})
test_that("/api/log strictly validates and emits one line per client report", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '    base <- sprintf("http://127.0.0.1:%d/api/log", port)
    post_raw <- function(label, payload) {
      h <- curl::new_handle()
      curl::handle_setopt(h,
        postfields = payload, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(base, handle = h)
      content <- rawToChar(r$content)
      cat(label, r$status_code,
          grepl("\\\"code\\\":\\\"invalid_request\\\"", content), "\n")
    }
    post <- function(label, obj) post_raw(
      label, jsonlite::toJSON(obj, auto_unbox = TRUE, null = "null")
    )
    post("normal", list(level = "error", message = "boom",
                        source = "window.error", stack = "line 1\\nline 2"))
    post("multiline", list(
      level = "error\\r\\nforged-level",
      message = "head\\r\\nforged-message",
      source = "window.error\\nforged-source",
      url = "http://localhost/first\\rsecond",
      stack = "line 1\\nline 2"
    ))
    post_raw("unknown", "{\\\"level\\\":\\\"error\\\",\\\"message\\\":\\\"x\\\",\\\"extra\\\":1}")
    post_raw("shape", "{\\\"level\\\":\\\"error\\\",\\\"message\\\":\\\"x\\\",\\\"source\\\":[\\\"a\\\",\\\"b\\\"]}")
    post_raw("null-message", "{\\\"level\\\":\\\"error\\\",\\\"message\\\":null}")
    post_raw("null-source", "{\\\"level\\\":\\\"error\\\",\\\"message\\\":\\\"x\\\",\\\"source\\\":null}")
    post("too-long", list(level = "error", message = strrep("x", 8193L)))
    nul <- c(charToRaw("{\\\"level\\\":\\\"error\\\",\\\"message\\\":\\\"a"),
             as.raw(0), charToRaw("b\\\"}"))
    post_raw("raw-nul", nul)
    healthy <- curl::curl_fetch_memory(
      sprintf("http://127.0.0.1:%d/api/state", port)
    )
    cat("healthy", healthy$status_code, "\n")'
  server_log <- capture.output(out <- http_child(port, code), type = "message")
  out <- trimws(out)
  expect_true(any(grepl("^normal 200 FALSE$", out)))
  expect_true(any(grepl("^multiline 200 FALSE$", out)))
  for (label in c("unknown", "shape", "null-message", "null-source",
                  "too-long", "raw-nul")) {
    expect_true(any(grepl(paste0("^", label, " 400 TRUE$"), out)))
  }
  expect_true(any(grepl("^healthy 200$", out)))
  client_lines <- grep("^\\[client:", server_log, value = TRUE)
  expect_length(client_lines, 2L)
  expect_true(any(grepl(
    "^\\[client:error forged-level\\] head forged-message.*",
    client_lines
  )))
  expect_true(any(grepl(
    "source=window.error forged-source.*stack=line 1 line 2",
    client_lines
  )))
  expect_false(any(grepl("^forged-(level|message|source)", server_log)))
})

test_that("client API failures retain bounded error codes and HTTP status", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '
    post <- function(label, code, status) {
      h <- curl::new_handle()
      body <- jsonlite::toJSON(list(
        level = "error", message = "API /api/lsp: language server exited",
        source = "api", code = code, status = status
      ), auto_unbox = TRUE, null = "null")
      curl::handle_setopt(h, postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(
        sprintf("http://127.0.0.1:%d/api/log", port), handle = h)
      cat(label, r$status_code, "\\n")
    }
    post("lsp", "lsp_unavailable", 503L)
    post("network", "internal_error", 0L)
    post("code-object", list(nested = "bad"), 503L)
    post("code-long", strrep("x", 129L), 503L)
    post("code-control", "bad\\ncode", 503L)
    post("status-string", "bad", "503")
    post("status-fraction", "bad", 503.5)
    post("status-negative", "bad", -1L)
    post("status-outside-http", "bad", 99L)
    post("status-too-large", "bad", 600L)
    post("status-null", "bad", NULL)
  '
  server_log <- capture.output(out <- http_child(port, code), type = "message")
  out <- trimws(out)
  expect_true("lsp 200" %in% out)
  expect_true("network 200" %in% out)
  for (label in c("code-object", "code-long", "code-control", "status-string",
                  "status-fraction", "status-negative", "status-outside-http", "status-too-large",
                  "status-null")) {
    expect_true(paste(label, "400") %in% out, info = label)
  }
  client_lines <- grep("^\\[client:", server_log, value = TRUE)
  expect_length(client_lines, 2L)
  expect_true(any(grepl("source=api code=lsp_unavailable status=503$", client_lines)))
  expect_true(any(grepl("source=api code=internal_error status=0$", client_lines)))
})

test_that("forbidden Host and Origin are rejected before any route", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  # handle_setheaders, not httpheader=: the latter mangles Host/Origin
  code <- '    getcode <- function(hdrs = character()) {
      h <- curl::new_handle()
      curl::handle_setheaders(h, .list = as.list(hdrs))
      r <- curl::curl_fetch_memory(
        sprintf("http://127.0.0.1:%d/api/state", port), handle = h)
      r$status_code
    }
    cat("badhost", getcode(c(Host = "evil.example.com")), "\\n")
    cat("badhostport", getcode(c(Host = "127.0.0.1:9999")), "\\n")
    cat("badorigin", getcode(c(Origin = "http://evil.example.com")), "\\n")
    cat("goodorigin", getcode(c(Origin = sprintf("http://127.0.0.1:%d", port))), "\\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^badhost 403", out)))
  expect_true(any(grepl("^badhostport 403", out)))
  expect_true(any(grepl("^badorigin 403", out)))
  expect_true(any(grepl("^goodorigin 200", out)))
})

test_that("API routes validate bodies and map Session errors", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    post <- function(url, obj, tag = "", ctype = "application/json") {
      body <- jsonlite::toJSON(obj, auto_unbox = TRUE)
      h <- curl::new_handle()
      curl::handle_setopt(h, postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = ctype)
      r <- curl::curl_fetch_memory(paste0(base, url), handle = h)
      cat(tag, r$status_code, "|", rawToChar(r$content), "\n")
    }
    # missing content type
    post("/api/run", list(cell = "cell-1"), ctype = "text/plain")
    # invalid body: both cell and all
    post("/api/run", list(cell = "cell-1", all = TRUE))
    # missing cell id
    post("/api/run", list(cell = "nope"))
    # cell edit with bad type
    post("/api/cell", list(op = "edit", id = "cell-1",
                           expected_revision = 0,
                           body = list("1"), type = "bad"))
    # retired SQL cells are rejected at the route schema
    post("/api/cell", list(op = "sql", id = "cell-1",
                           expected_revision = 0))
    # unknown field is rejected
    post("/api/run", list(cell = "cell-1", extra = 1))
    # all must be exactly true
    post("/api/run", list(all = FALSE))
    post("/api/run", list(all = 1))
    # the MCP scope discriminator is enum-bounded and global-only
    post("/api/run", list(all = TRUE, scope = "current"))
    post("/api/run", list(cell = "cell-1", scope = "stale"))
    # edit requires expected_revision
    post("/api/cell", list(op = "edit", id = "cell-1",
                           body = list("1"), type = "code"))
    # delete requires expected_revision
    post("/api/cell", list(op = "delete", id = "cell-1"))
    # add requires after (may be null)
    post("/api/cell", list(op = "add", body = list("1"), type = "code"))
    # empty notebook starts with zero cells: add a cell, then edit it
    h <- curl::new_handle()
    curl::handle_setopt(h,
      postfields = jsonlite::toJSON(list(op = "add", after = NULL,
                                         body = list("x <- 1"), type = "code"),
                                    auto_unbox = TRUE, null = "null"),
      customrequest = "POST")
    curl::handle_setheaders(h, "Content-Type" = "application/json")
    ar <- curl::curl_fetch_memory(paste0(base, "/api/cell"), handle = h)
    cat("add", ar$status_code, "|", rawToChar(ar$content), "\n")
    st <- jsonlite::fromJSON(rawToChar(ar$content), simplifyVector = FALSE)
    newid <- st$id
    newrev <- st$revision
    post("/api/cell", list(op = "edit", id = newid,
                           expected_revision = newrev,
                           body = list("x <- 2"), type = "code"), "edit")
    # valid run all
    post("/api/run", list(all = TRUE))
    # state after run
    h <- curl::new_handle()
    r <- curl::curl_fetch_memory(paste0(base, "/api/state"), handle = h)
    cat("state", r$status_code, "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^ ?415 \\|", out)))
  expect_true(any(grepl("^ ?400 \\| .*must provide exactly one", out)))
  expect_true(any(grepl("^ ?404 \\| .*no such cell", out)))
  expect_true(any(grepl("^ ?400 \\| .*cell type must be", out)))
  expect_true(any(grepl("^ ?400 \\| .*field op must be one of", out)))
  expect_true(any(grepl("^ ?400 \\| .*unknown field: extra", out)))
  expect_true(any(grepl("^ ?400 \\| .*must be exactly TRUE", out)))
  expect_true(any(grepl("^ ?400 \\| .*must be a boolean", out)))
  expect_true(any(grepl("^ ?400 \\| .*scope must be one of", out)))
  expect_true(any(grepl("^ ?400 \\| .*scope is valid only", out)))
  expect_true(any(grepl("^ ?400 \\| .*missing required field: expected_revision", out)))
  expect_true(any(grepl("^ ?400 \\| .*missing required field: after", out)))
  expect_true(any(grepl("^add 200 \\| .*\"ok\" *: *true.*\"id\"", out)))
  # the edit round-trip itself must 200 with a server revision
  expect_true(any(grepl("^edit 200 \\| .*\"ok\" *: *true.*\"revision\"", out)))
  expect_true(any(grepl("^ ?202 \\| .*\"ok\" *: *true", out)))
  expect_true(any(grepl("^state 200", out)))
})

test_that("HTTP cell revisions reject lossy numeric preconditions", {
  # JSON itself cannot encode non-finite values, but this direct route-schema
  # check protects embedders and verifies it never warns while validating.
  for (revision in c(0.5, -1, .Machine$integer.max + 1, Inf, -Inf, NaN)) {
    validation <- expect_no_warning(alder:::validate_body(
      list(expected_revision = revision),
      list(expected_revision = list(type = "scalar_revision", required = TRUE))
    ))
    expect_identical(validation$code, "invalid_request")
  }
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  srv$session$add_cell(NULL, "x <- 1", "code")
  code <- 'base <- sprintf("http://%s:%d", host, port)
    post <- function(expected, body = "x <- 2") {
      h <- curl::new_handle()
      curl::handle_setopt(h, customrequest = "POST", postfields =
        jsonlite::toJSON(list(op = "edit", id = "cell-1", body = list(body),
          type = "code", expected_revision = expected), auto_unbox = TRUE))
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(paste0(base, "/api/cell"), handle = h)
      cat(expected, r$status_code, "|", rawToChar(r$content), "\\n")
    }
    post(0.5); post(-1); post(2147483648)
    post(0, "x <- 2")
    post(0, "x <- 3")'
  out <- http_child(port, code)
  expect_true(all(vapply(c("0.5", "-1", "2147483648"), function(value) {
    any(grepl(paste0("^", value,
                     " 400 \\| .*expected_revision must be a non-negative integer"),
              out))
  }, logical(1))), info = paste(out, collapse = "\n"))
  expect_true(any(grepl("^0 200 \\| .*\\\"revision\\\" *: *1", out)),
              info = paste(out, collapse = "\n"))
  expect_true(any(grepl("^0 409 \\| .*changed on the server", out)),
              info = paste(out, collapse = "\n"))
  cell <- srv$session$state()$cells[[1L]]
  expect_identical(unclass(cell$body), "x <- 2")
  expect_identical(cell$revision, 1L)
})

test_that("save on a pathless notebook is 400 notebook_has_no_path", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    h <- curl::new_handle(customrequest = "POST")
    r <- curl::curl_fetch_memory(paste0(base, "/api/save"), handle = h)
    cat(r$status_code, "|", rawToChar(r$content), "\n")
    # a non-empty body is rejected even with valid JSON
    h2 <- curl::new_handle(postfields = "{}", customrequest = "POST",
                           httpheader = c("Content-Type" = "application/json"))
    r2 <- curl::curl_fetch_memory(paste0(base, "/api/save"), handle = h2)
    cat(r2$status_code, "|", rawToChar(r2$content), "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^ ?400 \\| .*notebook has no path", out)))
  expect_true(any(grepl("^ ?400 \\| .*zero-byte body", out)))
})
test_that("save writes the notebook and reports etag/version", {
  nb_path <- tempfile("alder-nb-", fileext = ".R")
  writeLines(c("# %%", "x <- 1"), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    h <- curl::new_handle(customrequest = "POST")
    r <- curl::curl_fetch_memory(paste0(base, "/api/save"), handle = h)
    cat(r$status_code, "|", rawToChar(r$content), "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^ ?200 \\| .*\"ok\" *: *true.*\"etag\"", out)))
})
test_that("wrong methods are 405 and shutdown requires authentication", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    getr <- curl::curl_fetch_memory(paste0(base, "/api/run"))
    cat("getrun", getr$status_code, "|", rawToChar(getr$content), "| Allow:",
        curl::parse_headers_list(getr$headers)$allow, "\n")
    h <- curl::new_handle(postfields = "{}", customrequest = "PUT")
    putr <- curl::curl_fetch_memory(paste0(base, "/api/state"), handle = h)
    cat("putstate", putr$status_code, "| Allow:",
        curl::parse_headers_list(putr$headers)$allow, "\n")
    # shutdown is present but a request without its state token is forbidden
    h <- curl::new_handle(postfields = "{}", customrequest = "POST",
                          httpheader = c("Content-Type" = "application/json"))
    stopr <- curl::curl_fetch_memory(paste0(base, "/api/shutdown"), handle = h)
    cat("stop", stopr$status_code, "|", rawToChar(stopr$content), "\n")
    verr <- curl::curl_fetch_memory(paste0(base, "/api/version"))
    cat("version", verr$status_code, "|", rawToChar(verr$content), "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^getrun 405 \\| .*method not allowed.*Allow: POST", out)))
  expect_true(any(grepl("^putstate 405 \\| .*Allow: GET", out)))
  expect_true(any(grepl("^stop 403 \\| .*shutdown token is invalid", out)))
  expect_true(any(grepl("^version 404 \\| .*not found", out)))
})
test_that("widget route enforces exact value/index schemas", {
  nb_path <- tempfile("alder-nb-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "min_wt <- ui$slider(0, 10, value = 5)",
  "min_wt",
    "# %%", "pick <- ui$dropdown(c(\"a\", \"b\"))", "pick",
    "# %%", "go <- ui$run_button()", "go",
    "# %%", "span <- ui$range_slider(0, 10, value = c(2, 8))", "span",
    "# %%", "multi <- ui$multiselect(c('a', 'b', 'c'), value = 'a')", "multi",
    "# %%", "rows <- ui$table(head(iris, 3), selection = 'multi')", "rows"
  ), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    post <- function(url, obj, tag = "", ctype = "application/json") {
      body <- jsonlite::toJSON(obj, auto_unbox = TRUE)
      h <- curl::new_handle()
      curl::handle_setopt(h, postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = ctype)
      r <- curl::curl_fetch_memory(paste0(base, url), handle = h)
      cat(tag, r$status_code, "|", rawToChar(r$content), "\n")
    }
    # run the notebook first so widgets are visible
    post("/api/run", list(all = TRUE))
    repeat {
      st <- jsonlite::fromJSON(
        rawToChar(curl::curl_fetch_memory(paste0(base, "/api/state"))$content),
        simplifyVector = FALSE)
      if (identical(st$runtime$busy, FALSE)) break
      Sys.sleep(0.1)
    }
    # slider scalar value
    post("/api/widget", list(name = "min_wt", value = 7, source = "editor"),
         "slider")
    # dropdown integer index
    post("/api/widget", list(name = "pick", index = 2, source = "app"), "pick")
    # run button value:true
    post("/api/widget", list(name = "go", value = TRUE, source = "app"), "go")
    # vector updates arrive from JSON as unnamed lists and remain arrays
    post("/api/widget", list(name = "span", value = c(3, 7), source = "editor"),
         "range")
    post("/api/widget", list(name = "multi", indices = c(1, 3),
                              source = "editor"), "multi")
    post("/api/widget", list(name = "rows", selected = c(1, 3),
                              source = "editor"), "table")
    # named JSON objects must not be flattened into array-typed fields
    post("/api/widget", list(name = "span", value = list(lower = 3, upper = 7),
                              source = "editor"), "range-object")
    post("/api/widget", list(name = "multi", indices = list(first = 1, third = 3),
                              source = "editor"), "multi-object")
    post("/api/widget", list(name = "rows", selected = list(first = 1, third = 3),
                              source = "editor"), "table-object")
    # missing source
    post("/api/widget", list(name = "min_wt", value = 3))
    # both value and index
    post("/api/widget", list(name = "min_wt", value = 3, index = 1,
                             source = "editor"))
    # unknown widget
    post("/api/widget", list(name = "nope", value = 1, source = "editor"))'
  out <- http_child(port, code)
  # each valid widget post must return 202 with a commit token
  expect_true(any(grepl("^slider 202 \\|.*\"token\"", out)))
  expect_true(any(grepl("^pick 202 \\|.*\"token\"", out)))
  expect_true(any(grepl("^go 202 \\|.*\"token\"", out)))
  expect_true(any(grepl("^range 202 \\|.*\"token\"", out)))
  expect_true(any(grepl("^multi 202 \\|.*\"token\"", out)))
  expect_true(any(grepl("^table 202 \\|.*\"token\"", out)))
  expect_true(any(grepl("^range-object 400 \\|", out)))
  expect_true(any(grepl("^multi-object 400 \\|", out)))
  expect_true(any(grepl("^table-object 400 \\|", out)))
  expect_true(any(grepl("^ ?400 \\| .*missing required field: source", out)))
  expect_true(any(grepl("^ ?400 \\| .*exactly one widget update field", out)))
  expect_true(any(grepl("^ ?400 \\| .*no such widget: nope", out)))
})

test_that("widget operation route is read-only, narrow, and strictly validated", {
  nb_path <- tempfile("alder-widget-operation-route-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "w <- ui$slider(1, 5, value = 2)", "w"
  ), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    get <- function(route, headers = character()) {
      h <- curl::new_handle()
      if (length(headers)) curl::handle_setheaders(h, .list = as.list(headers))
      curl::curl_fetch_memory(paste0(base, route), handle = h)
    }
    post <- function(route, object) {
      body <- jsonlite::toJSON(object, auto_unbox = TRUE)
      h <- curl::new_handle(postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      curl::curl_fetch_memory(paste0(base, route), handle = h)
    }
    parsed <- function(response) jsonlite::fromJSON(
      rawToChar(response$content), simplifyVector = FALSE
    )
    post("/api/run", list(all = TRUE))
    repeat {
      state <- parsed(get("/api/state"))
      if (identical(state$runtime$busy, FALSE)) break
      Sys.sleep(0.02)
    }
    accepted <- parsed(post(
      "/api/widget", list(name = "w", value = 4, source = "editor")
    ))
    route <- paste0("/api/widget-operation?token=", accepted$token)
    repeat {
      operation_response <- get(route)
      operation <- parsed(operation_response)$operation
      if (!identical(operation$status, "pending")) break
      Sys.sleep(0.02)
    }
    cat("done", operation_response$status_code, operation$status,
        paste(sort(names(operation)), collapse = ","), "\n")
    rejected <- parsed(post(
      "/api/widget", list(name = "w", value = 99, source = "editor")
    ))
    rejected_route <- paste0(
      "/api/widget-operation?token=", rejected$token
    )
    repeat {
      rejected_operation <- parsed(get(rejected_route))$operation
      if (!identical(rejected_operation$status, "pending")) break
      Sys.sleep(0.02)
    }
    cat("error", rejected_operation$status,
        rejected_operation$error$code, "|",
        rejected_operation$error$message, "\n")
    invalid <- c(
      "/api/widget-operation",
      "/api/widget-operation?token=",
      "/api/widget-operation?token=0",
      "/api/widget-operation?token=-1",
      "/api/widget-operation?token=1.5",
      "/api/widget-operation?token=abc",
      "/api/widget-operation?token=1&token=2",
      "/api/widget-operation?token=1&extra=2",
      "/api/widget-operation?extra=1",
      "/api/widget-operation?token=99999999999999999999"
    )
    for (route in invalid) {
      response <- get(route)
      value <- parsed(response)
      cat("invalid", response$status_code, value$error$code, "\n")
    }
    missing <- get("/api/widget-operation?token=2147483647")
    missing_value <- parsed(missing)
    cat("missing", missing$status_code, missing_value$error$code, "|",
        missing_value$error$message, "\n")
    wrong_method <- post("/api/widget-operation?token=1", list())
    cat("method", wrong_method$status_code,
        curl::parse_headers_list(wrong_method$headers)$allow, "\n")
    forbidden <- get(
      "/api/widget-operation?token=1",
      c(Origin = "http://evil.example.com")
    )
    cat("origin", forbidden$status_code,
        parsed(forbidden)$error$code, "\n")'
  out <- http_child(port, code)
  out <- trimws(out)
  expect_true(any(grepl(
    "^done 200 done error,reset_expected,status,token$", out
  )))
  expect_true(any(grepl(
    "^error error widget_update_failed \\| .+", out
  )))
  expect_length(grep("^invalid 400 invalid_request$", out), 10L)
  expect_true(any(grepl(
    "^missing 404 not_found \\| widget operation token was not found$", out
  )))
  expect_true(any(grepl("^method 405 GET$", out)))
  expect_true(any(grepl("^origin 403 forbidden_origin$", out)))
})

test_that("run operation route is read-only, narrow, and strictly validated", {
  nb_path <- tempfile("alder-run-operation-route-", fileext = ".R")
  writeLines(c("# %%", "Sys.sleep(0.1)", "value <- 1L", "value"), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    get <- function(route, headers = character()) {
      h <- curl::new_handle()
      if (length(headers)) curl::handle_setheaders(h, .list = as.list(headers))
      curl::curl_fetch_memory(paste0(base, route), handle = h)
    }
    post <- function(route, object) {
      body <- jsonlite::toJSON(object, auto_unbox = TRUE)
      h <- curl::new_handle(postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      curl::curl_fetch_memory(paste0(base, route), handle = h)
    }
    parsed <- function(response) jsonlite::fromJSON(
      rawToChar(response$content), simplifyVector = FALSE
    )
    accepted_response <- post("/api/run", list(all = TRUE))
    accepted <- parsed(accepted_response)
    route <- paste0("/api/run-operation?run_id=", accepted$run_id)
    repeat {
      operation_response <- get(route)
      operation <- parsed(operation_response)$operation
      if (!identical(operation$status, "pending")) break
      Sys.sleep(0.02)
    }
    cat("accepted", accepted_response$status_code,
        is.numeric(accepted$run_id), "\n")
    cat("done", operation_response$status_code, operation$status,
        length(operation$reset_tokens),
        paste(sort(names(operation)), collapse = ","), "\n")
    invalid <- c(
      "/api/run-operation",
      "/api/run-operation?run_id=",
      "/api/run-operation?run_id=0",
      "/api/run-operation?run_id=-1",
      "/api/run-operation?run_id=1.5",
      "/api/run-operation?run_id=abc",
      "/api/run-operation?run_id=1&run_id=2",
      "/api/run-operation?run_id=1&extra=2",
      "/api/run-operation?extra=1",
      "/api/run-operation?run_id=99999999999999999999"
    )
    for (invalid_route in invalid) {
      response <- get(invalid_route)
      value <- parsed(response)
      cat("invalid", response$status_code, value$error$code, "\n")
    }
    missing <- get("/api/run-operation?run_id=2147483647")
    missing_value <- parsed(missing)
    cat("missing", missing$status_code, missing_value$error$code, "|",
        missing_value$error$message, "\n")
    wrong_method <- post("/api/run-operation?run_id=1", list())
    cat("method", wrong_method$status_code,
        curl::parse_headers_list(wrong_method$headers)$allow, "\n")
    forbidden <- get(
      "/api/run-operation?run_id=1",
      c(Origin = "http://evil.example.com")
    )
    cat("origin", forbidden$status_code,
        parsed(forbidden)$error$code, "\n")'
  out <- trimws(http_child(port, code))
  expect_true(any(grepl("^accepted 202 TRUE$", out)),
              info = paste(out, collapse = "\n"))
  expect_true(any(grepl(
    "^done 200 done 0 error,reset_tokens,run_id,status$", out
  )), info = paste(out, collapse = "\n"))
  expect_length(grep("^invalid 400 invalid_request$", out), 10L)
  expect_true(any(grepl(
    "^missing 404 not_found \\| run operation id was not found$", out
  )))
  expect_true(any(grepl("^method 405 GET$", out)))
  expect_true(any(grepl("^origin 403 forbidden_origin$", out)))
})

test_that("/api/upload stores validated files for file widgets", {
  nb_path <- tempfile("alder-upload-route-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "# %%", "files <- ui$file()", "files",
    "# %%", "files$value"
  ), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    post <- function(url, obj, tag = "") {
      body <- jsonlite::toJSON(obj, auto_unbox = TRUE)
      h <- curl::new_handle(postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(paste0(base, url), handle = h)
      cat(tag, r$status_code, "|", rawToChar(r$content), "\n")
    }
    get_state <- function() jsonlite::fromJSON(
      rawToChar(curl::curl_fetch_memory(paste0(base, "/api/state"))$content),
      simplifyVector = FALSE)
    post("/api/run", list(all = TRUE), "run")
    repeat {
      st <- get_state()
      if (identical(st$runtime$busy, FALSE)) break
      Sys.sleep(0.1)
    }
    post("/api/upload", list(
      name = "files",
      files = list(list(name = "hello.txt", content_base64 = "aGVsbG8="))
    ), "upload")'
  out <- http_child(port, code)
  expect_true(any(grepl("^run 202 \\|", out)))
  expect_true(any(grepl("^upload 202 \\|.*\"token\"", out)))
  deadline <- Sys.time() + 10
  repeat {
    later::run_now(0.05)
    state <- srv$session$state()
    widget <- state$cells[[2L]]$outputs[[length(state$cells[[2L]]$outputs)]]
    operation <- if (is.null(widget$operation)) NULL else widget$operation
    if (!is.null(operation) && !identical(operation$status, "pending")) break
    if (Sys.time() >= deadline) break
  }
  expect_equal(widget$kind, "widget")
  file_row <- widget$spec$value[[1L]]
  expect_equal(file_row$name, "hello.txt")
  expect_equal(file_row$size, 5)
  expect_true(file.exists(file_row$path))
  expect_identical(readBin(file_row$path, "raw", 5L),
                   charToRaw("hello"))
})

test_that("/api/cell disables and re-enables a cell", {
  nb_path <- tempfile("alder-disable-route-", fileext = ".R")
  writeLines(c("# %%", "x <- 1", "# %%", "x + 1"), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    post <- function(value) {
      body <- jsonlite::toJSON(list(
        op = "disable", cell = "cell-1", disabled = value
      ), auto_unbox = TRUE)
      h <- curl::new_handle(postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(paste0(base, "/api/cell"), handle = h)
      cat(r$status_code, "|", rawToChar(r$content), "\n")
    }
    post_name <- function(value) {
      body <- jsonlite::toJSON(list(
        op = "name", cell = "cell-1", name = value
      ), auto_unbox = TRUE, null = "null")
      h <- curl::new_handle(postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(paste0(base, "/api/cell"), handle = h)
      cat("name", r$status_code, "|", rawToChar(r$content), "\n")
    }
    post_move <- function(after) {
      body <- jsonlite::toJSON(list(
        op = "move", cell = "cell-2", after = after
      ), auto_unbox = TRUE, null = "null")
      h <- curl::new_handle(postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(paste0(base, "/api/cell"), handle = h)
      cat("move", r$status_code, "|", rawToChar(r$content), "\n")
    }
    post(TRUE)
    post(FALSE)
    post_name("named_1")
    post_name("not valid")
    post_move(NULL)'
  out <- http_child(port, code)
  expect_true(any(grepl('^200 \\|.*"disabled":true', out)))
  expect_true(any(grepl('^200 \\|.*"disabled":false', out)))
  expect_false(srv$session$state()$cells[[1L]]$disabled)
  expect_true(any(grepl('^name 200 \\|.*"name":"named_1"', out)))
  expect_true(any(grepl("^name 400 \\|.*cell name must match", out)))
  expect_true(any(grepl('^move 200 \\|.*"id":"cell-2"', out)))
  expect_identical(
    vapply(srv$session$state()$cells, function(cell) cell$id, ""),
    c("cell-2", "cell-1")
  )
  expect_equal(
    srv$session$state()$cells[[which(vapply(
      srv$session$state()$cells, function(cell) cell$id, "") == "cell-1"
    )]]$options$name,
    "named_1"
  )
})

test_that("/api/value returns a token and the matching state last_value", {
  nb_path <- tempfile("alder-nb-", fileext = ".R")
  writeLines(c("# %%", "x <- 41 + 1"), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    post <- function(url, obj, ctype = "application/json") {
      body <- jsonlite::toJSON(obj, auto_unbox = TRUE)
      h <- curl::new_handle()
      curl::handle_setopt(h, postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = ctype)
      r <- curl::curl_fetch_memory(paste0(base, url), handle = h)
      cat(r$status_code, "|", rawToChar(r$content), "\n")
    }
    post("/api/run", list(all = TRUE))
    repeat {
      st <- jsonlite::fromJSON(
        rawToChar(curl::curl_fetch_memory(paste0(base, "/api/state"))$content),
        simplifyVector = FALSE)
      if (identical(st$runtime$busy, FALSE)) break
      Sys.sleep(0.1)
    }
    post("/api/value", list(name = "x"))
    repeat {
      st <- jsonlite::fromJSON(
        rawToChar(curl::curl_fetch_memory(paste0(base, "/api/state"))$content),
        simplifyVector = FALSE)
      vop <- st$value_operation
      if (is.null(vop) || !identical(vop$status, "pending")) break
      Sys.sleep(0.1)
    }
    cat("vop", vop$status, "|", vop$token, "\n")
    cat("last", st$last_value$value$kind, "|", st$last_value$value$text, "\n")
    post("/api/value", list(name = "nope"))
    repeat {
      st <- jsonlite::fromJSON(
        rawToChar(curl::curl_fetch_memory(paste0(base, "/api/state"))$content),
        simplifyVector = FALSE)
      vop <- st$value_operation
      if (is.null(vop) || !identical(vop$status, "pending")) break
      Sys.sleep(0.1)
    }
    cat("vop2", vop$status, "|", vop$error$message, "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^ ?202 \\| .*\"token\"", out)))
  expect_true(any(grepl("^vop done \\| [0-9]+", out)))
  expect_true(any(grepl("^last text \\| \\[1\\] 42", out)))
  expect_true(any(grepl("^vop2 error \\| no such name: nope", out)))
})
test_that("table paging route returns an asynchronous bounded page", {
  nb_path <- tempfile("alder-table-route-", fileext = ".R")
  writeLines(c("# %%",
               "df <- data.frame(x = 1:100, group = paste0(\"g\", 1:100))",
               "df"), nb_path)
  port <- httpuv::randomPort()
  srv <- start_alder(nb_path, port = port, run_on_startup = FALSE)
  on.exit({
    stop_alder(srv)
    unlink(nb_path)
  }, add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    post <- function(url, obj, tag = "") {
      body <- jsonlite::toJSON(obj, auto_unbox = TRUE)
      h <- curl::new_handle()
      curl::handle_setopt(h, postfields = body, customrequest = "POST")
      curl::handle_setheaders(h, "Content-Type" = "application/json")
      r <- curl::curl_fetch_memory(paste0(base, url), handle = h)
      parsed <- tryCatch(jsonlite::fromJSON(rawToChar(r$content),
                                            simplifyVector = FALSE),
                         error = function(e) list())
      token <- if (!is.null(parsed$token)) parsed$token else ""
      cat(tag, r$status_code, "|", token, "\n")
      parsed
    }
    get_state <- function() jsonlite::fromJSON(
      rawToChar(curl::curl_fetch_memory(paste0(base, "/api/state"))$content),
      simplifyVector = FALSE)
    post("/api/run", list(all = TRUE), "run")
    repeat {
      st <- get_state()
      if (identical(st$runtime$busy, FALSE)) break
      Sys.sleep(0.1)
    }
    out <- st$cells[[1]]$outputs[[length(st$cells[[1]]$outputs)]]
    cat("kind", out$kind, "| handle", out$handle, "\n")
    post("/api/table", list(handle = out$handle, offset = 10,
                            limit = 5, sort_by = "x", sort_desc = TRUE,
                            filter = ""), "page")
    repeat {
      st <- get_state()
      current <- st$cells[[1]]$outputs[[length(st$cells[[1]]$outputs)]]
      if (!is.null(current$page) && as.numeric(current$page$offset) == 10) break
      Sys.sleep(0.1)
    }
    cat("page", current$page$offset, current$page$limit,
        current$page$preview[[1]][[1]], "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^run 202 \\|", out)))
  expect_true(any(grepl("^kind table \\| handle ", out)))
  expect_true(any(grepl("^page 10 5 90", out)))
})
test_that("unknown routes are 404 JSON", {
  port <- httpuv::randomPort()
  srv <- start_alder(NULL, port = port, run_on_startup = FALSE)
  on.exit(stop_alder(srv), add = TRUE)
  code <- '    base <- sprintf("http://%s:%d", host, port)
    r <- curl::curl_fetch_memory(paste0(base, "/api/nope"))
    cat("get", r$status_code, "|", rawToChar(r$content), "\n")
    h <- curl::new_handle(postfields = "{}", customrequest = "POST",
                          httpheader = c("Content-Type" = "application/json"))
    r2 <- curl::curl_fetch_memory(paste0(base, "/api/nope"), handle = h)
    cat("post", r2$status_code, "|", rawToChar(r2$content), "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^get 404 \\| .*not found", out)))
  expect_true(any(grepl("^post 404 \\| .*not found", out)))
})
