# Helper: install alder into a temp library and set up a live worker for
# session/server integration tests.
#
# The worker subprocess needs the installed package (Rscript --vanilla cannot
# use pkgload::load_all), so we build and install once per testthat session.
# The cached library path is stored in ALDER_TEST_LIB; subsequent tests reuse
# it without rebuilding.

alder_cache_lib <- local({
  cached <- NULL
  function() {
    if (!is.null(cached) &&
        (!nzchar(cached) || dir.exists(file.path(cached, "alder")))) {
      return(cached)
    }
    cached <<- NULL
    # Already running against an installed alder (including R CMD check):
    # return the library containing the *loaded* package. The check-only
    # library is injected into the parent through startup.Rs rather than
    # R_LIBS, so returning "" here lets vanilla child processes silently load
    # an older site-library Alder.
    if (!is.null(utils::packageDescription("alder")$Built)) {
      package_path <- getNamespaceInfo(asNamespace("alder"), "path")
      cached <<- dirname(normalizePath(package_path, mustWork = TRUE))
      return(cached)
    }
    lib <- Sys.getenv("ALDER_TEST_LIB", unset = "")
    if (nzchar(lib) && file.exists(file.path(lib, "alder"))) {
      cached <<- lib
      return(lib)
    }
    # Build and install once per process
    repo <- normalizePath(testthat::test_path("..", ".."))
    build_root <- tempfile("alder-build-")
    dir.create(build_root)
    # Keep the cached installation for the whole R process. R removes its
    # session temp directory at exit; a per-test teardown can delete this
    # library while a real launcher or worker is still starting from it.
    lib <- file.path(build_root, "lib")
    dir.create(lib)
    old <- setwd(build_root)
    on.exit(setwd(old), add = TRUE)
    built <- system2(file.path(R.home("bin"), "R"), c("CMD", "build", repo),
                     stdout = FALSE, stderr = FALSE)
    if (!identical(built, 0L)) stop("R CMD build failed for test installation")
    tarball <- list.files(build_root, pattern = "alder_.*\\.tar\\.gz$",
                          full.names = TRUE)
    if (!length(tarball)) stop("alder tarball not found after R CMD build")
    installed <- system2(
      file.path(R.home("bin"), "R"),
      c("CMD", "INSTALL", paste0("--library=", shQuote(lib)),
        shQuote(tarball[1])),
      stdout = FALSE, stderr = FALSE
    )
    if (!identical(installed, 0L) || !dir.exists(file.path(lib, "alder"))) {
      stop("R CMD INSTALL failed for test installation")
    }
    cached <<- lib
    lib
  }
})

# Spawn a real worker process and return a configured Worker R6 object.
# The alder package must be installed (alder_cache_lib() ensures it). R_LIBS
# stays set so source-loaded tests and their restarted workers use the cached
# installation. Installed Alder propagates its own library during bootstrap.
make_test_worker <- function(env = character()) {
  lib <- alder_cache_lib()
  if (nzchar(lib)) {
    old_libs <- Sys.getenv("R_LIBS", unset = "")
    old_paths <- if (nzchar(old_libs)) {
      strsplit(old_libs, .Platform$path.sep, fixed = TRUE)[[1L]]
    } else {
      character()
    }
    if (!lib %in% old_paths) {
      Sys.setenv(R_LIBS = paste(c(lib, old_paths),
                                collapse = .Platform$path.sep))
    }
  }
  art <- tempfile("alder-artifacts-")
  dir.create(art)
  ws <- system.file("worker", "worker.R", package = "alder", mustWork = TRUE)
  ad <- system.file("app", package = "alder", mustWork = TRUE)
  proc <- .spawn_worker_process(ws, ad, art, env = env)
  worker <- Worker$new(proc, ws, ad, art, env = env)
  tryCatch(
    .wait_for_worker(worker),
    error = function(e) {
      if (worker$alive()) worker$kill()
      stop(e)
    }
  )
  worker
}

# Create a Session with a real worker for a notebook built from lines.
make_test_session <- function(lines, execution_mode = "automatic",
                              run_on_startup = FALSE,
                              worker_env = character()) {
  nb <- parse_notebook_lines(path = NA_character_, lines = lines)
  w <- make_test_worker(env = worker_env)
  s <- Session$new(nb, worker = w, execution_mode = execution_mode,
                   run_on_startup = run_on_startup)
  list(session = s, worker = w)
}

# Pump the later event loop until a condition is met or timeout.
wait_for <- function(session, condition, timeout = 5) {
  deadline <- Sys.time() + timeout
  while (Sys.time() < deadline) {
    later::run_now(0.01)
    if (isTRUE(condition())) return(invisible(TRUE))
    Sys.sleep(0.001)
  }
  stop("wait_for timed out after ", timeout, "s")
}

# Pump until the session is not busy (no active eval request).
wait_until_idle <- function(session, timeout = 5) {
  wait_for(session, function() !session$state()$runtime$busy, timeout)
}

# Pump until every cell has reached a terminal state. Keep the default above
# the cold-worker startup envelope so a single-file test run is as reliable as
# the complete suite.
wait_until_settled <- function(session, timeout = 15) {
  wait_for(session, function() {
    !any(vapply(session$state()$cells,
                function(cell) identical(cell$status, "running"),
                logical(1)))
  }, timeout)
}

# Compare two lists, ignoring any fields that differ by a single I() wrapper.
expect_equal_ignoring_i <- function(actual, expected, ...) {
  testthat::expect_equal(actual, expected, ...)
}

# Assert that a cell in the session state has a specific status.
expect_cell_status <- function(session, cell_id, status) {
  st <- session$state()
  for (c in st$cells) {
    if (identical(c$id, cell_id)) {
      testthat::expect_equal(c$status, status)
      return(invisible())
    }
  }
  testthat::fail("cell not found: ", cell_id)
}
