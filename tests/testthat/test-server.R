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

test_that("json_dup_key finds duplicated keys at any depth", {
  expect_null(alder:::json_dup_key('{"a": 1}'))
  expect_null(alder:::json_dup_key('{"a": {"b": 1, "c": 2}}'))
  expect_equal(alder:::json_dup_key('{"a": 1, "a": 2}'), "a")
  expect_equal(alder:::json_dup_key('{"a": {"b": 1, "b": 2}}'), "b")
  expect_equal(alder:::json_dup_key('{"x": [1, 2], "x": 3}'), "x")
  # strings containing braces/colons are not objects or keys
  expect_null(alder:::json_dup_key('{"a": "x: {y}", "b": 2}'))
  expect_null(alder:::json_dup_key('{"a": "\\"quoted\\": value"}'))
  # duplicates in sibling objects are independent
  expect_null(alder:::json_dup_key('{"a": {"k": 1}, "b": {"k": 2}}'))
  expect_equal(alder:::json_dup_key('{"a": {"k": 1, "k": 2}, "b": {"k": 3}}'),
               "k")
  # escaped keys decode before comparison
  expect_equal(alder:::json_dup_key('{"a": 1, "\\u0061": 2}'), "a")
  expect_equal(alder:::json_dup_key('{"\\u0062": 1, "b": 2}'), "b")
  # unterminated strings bail out without looping
  expect_null(alder:::json_dup_key('{"a": "unterminated'))
  expect_null(alder:::json_dup_key('{"a\\'))
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
  # NUL bytes in the raw body (built as bytes: R strings drop NULs)
  nulbody <- c(charToRaw('{"a": "x'), as.raw(0), charToRaw('y"}'))
  r <- alder:::read_json_body(mkreq("application/json", rawbody = nulbody))
  expect_equal(r$error$code, "invalid_request")
  expect_match(r$error$message, "NUL")
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

test_that("start_alder validates its arguments", {
  expect_error(start_alder(path = character()), "`path`")
  expect_error(start_alder(path = NA_character_), "`path`")
  expect_error(start_alder(port = 0L), "`port`")
  expect_error(start_alder(port = 70000L), "`port`")
  expect_error(start_alder(port = "8899"), "`port`")
  expect_error(start_alder(host = ""), "`host`")
  expect_error(start_alder(open = NA), "`open`")
  expect_error(start_alder(run_on_startup = "yes"), "`run_on_startup`")
  expect_error(start_alder(execution_mode = "weird"), "one of")
  expect_error(start_alder(allowed_origins = "not a url"), "invalid origin")
  # nonexistent path: parent must exist
  expect_error(start_alder(path = file.path(tempfile(), "x.R")),
               "parent directory")
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
  # non-loopback bind requires explicit origins
  expect_error(alder:::build_origins("0.0.0.1", 8899L, NULL),
               "non-loopback")
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
    cat("csp", h$`content-security-policy`, "\n")
    cat("xfo", h$`x-frame-options`, "\n")
    cat("sniff", h$`x-content-type-options`, "\n")
    cat("ref", h$`referrer-policy`, "\n")
    cat("cache", h$`cache-control`, "\n")
  '
  out <- http_child(port, code)
  expect_true(any(grepl("^csp .*default-src 'self'", out)))
  expect_true(any(grepl("^csp .*frame-ancestors 'none'", out)))
  expect_true(any(grepl("^xfo DENY", out)))
  expect_true(any(grepl("^sniff nosniff", out)))
  expect_true(any(grepl("^ref no-referrer", out)))
  expect_true(any(grepl("^cache no-store", out)))
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
    # unknown field is rejected
    post("/api/run", list(cell = "cell-1", extra = 1))
    # all must be exactly true
    post("/api/run", list(all = FALSE))
    post("/api/run", list(all = 1))
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
  expect_true(any(grepl("^ ?400 \\| .*unknown field: extra", out)))
  expect_true(any(grepl("^ ?400 \\| .*must be exactly TRUE", out)))
  expect_true(any(grepl("^ ?400 \\| .*must be a boolean", out)))
  expect_true(any(grepl("^ ?400 \\| .*missing required field: expected_revision", out)))
  expect_true(any(grepl("^ ?400 \\| .*missing required field: after", out)))
  expect_true(any(grepl("^add 200 \\| .*\"ok\" *: *true.*\"id\"", out)))
  # the edit round-trip itself must 200 with a server revision
  expect_true(any(grepl("^edit 200 \\| .*\"ok\" *: *true.*\"revision\"", out)))
  expect_true(any(grepl("^ ?202 \\| .*\"ok\" *: *true", out)))
  expect_true(any(grepl("^state 200", out)))
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
test_that("wrong methods are 405 with Allow; removed endpoints are 404", {
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
    # removed endpoints: /api/stop and /api/version are unknown routes
    h <- curl::new_handle(postfields = "{}", customrequest = "POST",
                          httpheader = c("Content-Type" = "application/json"))
    stopr <- curl::curl_fetch_memory(paste0(base, "/api/stop"), handle = h)
    cat("stop", stopr$status_code, "|", rawToChar(stopr$content), "\n")
    verr <- curl::curl_fetch_memory(paste0(base, "/api/version"))
    cat("version", verr$status_code, "|", rawToChar(verr$content), "\n")'
  out <- http_child(port, code)
  expect_true(any(grepl("^getrun 405 \\| .*method not allowed.*Allow: POST", out)))
  expect_true(any(grepl("^putstate 405 \\| .*Allow: GET", out)))
  expect_true(any(grepl("^stop 404 \\| .*not found", out)))
  expect_true(any(grepl("^version 404 \\| .*not found", out)))
})
test_that("widget route enforces exact value/index schemas", {
  nb_path <- tempfile("alder-nb-", fileext = ".R")
  writeLines(c(
    "# %%", "library(alder)",
    "min_wt <- ui$slider(0, 10, value = 5)",
  "min_wt",
    "# %%", "pick <- ui$dropdown(c(\"a\", \"b\"))", "pick",
    "# %%", "go <- ui$run_button()", "go"
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
  expect_true(any(grepl("^ ?400 \\| .*missing required field: source", out)))
  expect_true(any(grepl("^ ?400 \\| .*exactly one of.*value.*index", out)))
  expect_true(any(grepl("^ ?400 \\| .*no such widget: nope", out)))
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
