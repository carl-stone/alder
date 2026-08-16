# Artifact/static serving boundary (ADR 0006's safe surface): path
# containment, extension allowlists, MIME mapping, spawn validation, and the
# stop_alder lifecycle teardown order (worker -> httpuv -> artifacts).

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
  # extension allowlist
  expect_null(alder:::safe_child_path(root, "secret.txt", c("js", "css")))
  expect_null(alder:::safe_child_path(root, "app.md", c("js", "css")))
  # missing files
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
    "C:%5Cwindows%5Cwin.ini",               # windows drive (colon+slash not allowed)
    "a%00b.js",                              # NUL byte
    ".hidden.js",                            # dotfile
    "..",                                    # parent segment
    "app.js%3Fextra",                        # extra query bits in name
    "sibling-root2%2Fapp.js"                 # nested path
  )
  for (p in bad) {
    expect_null(alder:::safe_child_path(root, p, c("js", "css")), info = p)
  }
  # sibling-prefix root confusion: a root whose name is a prefix of another
  # directory must not be reachable through normalization tricks
  sibling <- tempfile(paste0(basename(root), "-"))
  dir.create(sibling)
  on.exit(unlink(sibling, recursive = TRUE), add = TRUE)
  writeLines("nope", file.path(sibling, "x.js"))
  expect_null(alder:::safe_child_path(root, "x.js", c("js", "css")))
  expect_null(alder:::safe_child_path(root, paste0(basename(sibling), "/x.js"),
                                      c("js", "css")))
})

test_that("artifact_content_type maps the fixed artifact kinds", {
  expect_equal(alder:::artifact_content_type("png"), "image/png")
  expect_equal(alder:::artifact_content_type("html"), "text/html; charset=utf-8")
  expect_equal(alder:::artifact_content_type("PNG"), "image/png")
  expect_null(alder:::artifact_content_type("txt"))
  expect_null(alder:::artifact_content_type(""))
  expect_null(alder:::artifact_content_type("js"))
})

test_that(".spawn_worker rejects invalid artifact directories", {
  script <- alder:::alder_worker_script()
  expect_error(alder:::.spawn_worker(script, getwd(), "/no/such/dir"),
               "does not exist")
  f <- tempfile()
  writeLines("x", f)
  on.exit(unlink(f), add = TRUE)
  expect_error(alder:::.spawn_worker(script, getwd(), f), "directory")
  expect_error(alder:::.spawn_worker(script, getwd(), NA_character_), "artifact directory")
  expect_error(alder:::.spawn_worker(script, getwd(), ""), "artifact directory")
})

test_that("start_alder/stop_alder teardown kills the worker and artifacts", {
  port <- httpuv::randomPort()
  srv <- alder:::start_alder(NULL, port = port)
  expect_true(dir.exists(srv$artifact_dir))
  expect_true(srv$session$worker$alive())
  artifact_dir <- srv$artifact_dir
  alder::stop_alder(srv)
  expect_false(srv$session$worker$alive())
  expect_false(dir.exists(artifact_dir))
})
test_that("static route serves assets from app_dir/static with exact MIME", {
  port <- httpuv::randomPort()
  srv <- alder:::start_alder(NULL, port = port)
  on.exit(alder::stop_alder(srv), add = TRUE)
  # HTTP requests from a subprocess while this process pumps the server loop.
  code <- sprintf('
    httr_fetch <- function(url, what) {
      h <- curl::curl_fetch_memory(url)
      cat(what, " ", h$status_code, " ", h$type, "\\n", sep = "")
    }
    base <- "http://127.0.0.1:%d"
    httr_fetch(paste0(base, "/static/app.js"), "appjs")
    httr_fetch(paste0(base, "/static/style.css"), "css")
    httr_fetch(paste0(base, "/static/../DESCRIPTION"), "traversal")
    httr_fetch(paste0(base, "/static/app.js/..%%252FDESCRIPTION"), "encoded")
  ', port)
  child <- processx::process$new(file.path(R.home("bin"), "Rscript"),
                                 c("-e", code),
                                 stdout = "|", stderr = "|")
  results <- character()
  deadline <- Sys.time() + 30
  repeat {
    if (child$is_alive() || length(results) > 0L) {
      results <- c(results, child$read_output_lines())
    }
    if (!child$is_alive() && (length(results) > 0L || length(child$read_output_lines()) > 0L)) {
      results <- c(results, child$read_output_lines())
      break
    }
    if (Sys.time() > deadline) {
      child$kill()
      stop("static route probe timed out: ", paste(results, collapse = "; "))
    }
    later::run_now(0.05)
  }
  child$wait(5000)
  expect_length(results, 4L)
  expect_true(any(results == paste0("appjs 200 text/javascript; charset=utf-8")))
  expect_true(any(results == paste0("css 200 text/css; charset=utf-8")))
  expect_true(any(results == paste0("traversal 404 application/json; charset=utf-8")))
  expect_true(any(results == paste0("encoded 404 application/json; charset=utf-8")))
})

test_that("/api/value acks JSON and state exposes the fetched value", {
  port <- httpuv::randomPort()
  srv <- alder:::start_alder(NULL, port = port)
  on.exit(alder::stop_alder(srv), add = TRUE)
  code <- sprintf('
    cat("STARTED\\n")
    base <- "http://127.0.0.1:%d"
    h <- curl::new_handle(postfields = "{\\"name\\":\\"nope\\"}",
      customrequest = "POST", httpheader = c("Content-Type" = "application/json"))
    r <- curl::curl_fetch_memory(paste0(base, "/api/value"), handle = h)
    cat("[ack ", r$status_code, "|", r$type, "|", rawToChar(r$content), "]\\n", sep = "")
  ', port)
  child <- processx::process$new(file.path(R.home("bin"), "Rscript"),
                                 c("-e", code), stdout = "|", stderr = "|")
  results <- character()
  child_err <- character()
  deadline <- Sys.time() + 30
  repeat {
    results <- c(results, child$read_output_lines())
    child_err <- c(child_err, child$read_error_lines())
    if (!child$is_alive()) {
      results <- c(results, child$read_output_lines())
      child_err <- c(child_err, child$read_error_lines())
      break
    }
    if (Sys.time() > deadline) { child$kill(); stop("value probe timed out") }
    later::run_now(0.05)
  }
  child$wait(5000)
  if (!any(grepl("STARTED", results))) {
    stop("value probe child produced no output; exit: ",
         paste(child$get_exit_status(), collapse = ","),
         " stderr: ", paste(child_err, collapse = " | "))
  }
  if (!any(grepl("^\\[ack 200.+application/json", results))) {
    stop("value probe failed; stderr: ", paste(child_err, collapse = " | "))
  }
  expect_true(any(grepl("^\\[ack 200.+application/json", results)))
  expect_true(any(grepl('\\"ok\\" *: *true', results)))
})
