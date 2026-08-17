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
    if (!is.null(cached)) return(cached)
    # Already running against an installed alder (test_local load_package =
    # "installed"): system.file resolves installed paths, no extra lib.
    if (!is.null(utils::packageDescription("alder")$Built)) {
      cached <<- ""
      return("")
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
    on.exit(unlink(build_root, recursive = TRUE), add = TRUE)
    lib <- file.path(build_root, "lib")
    dir.create(lib)
    old <- setwd(build_root)
    on.exit(setwd(old), add = TRUE)
    system2(file.path(R.home("bin"), "R"), c("CMD", "build", repo),
            stdout = FALSE, stderr = FALSE)
    tarball <- list.files(build_root, pattern = "alder_.*\\.tar\\.gz$",
                          full.names = TRUE)
    if (!length(tarball)) stop("alder tarball not found after R CMD build")
    system2(file.path(R.home("bin"), "R"),
            c("CMD", "INSTALL", "--library", shQuote(lib), shQuote(tarball[1])),
            stdout = FALSE, stderr = FALSE)
    cached <<- lib
    lib
  }
})

# Spawn a real worker process and return a configured Worker R6 object.
# The alder package must be installed (alder_cache_lib() ensures it; when it
# returns "" the current package already is installed). R_LIBS stays set for
# the whole testthat process so Worker$restart() respawns inherit it.
make_test_worker <- function() {
  lib <- alder_cache_lib()
  if (nzchar(lib)) {
    old_libs <- Sys.getenv("R_LIBS", unset = "")
    if (!grepl(paste0("(^|:)", lib, "(:|$)"), old_libs)) {
      Sys.setenv(R_LIBS = paste(lib, old_libs, sep = ":"))
    }
  }
  art <- tempfile("alder-artifacts-")
  dir.create(art)
  ws <- system.file("worker", "worker.R", package = "alder", mustWork = TRUE)
  ad <- system.file("app", package = "alder", mustWork = TRUE)
  proc <- .spawn_worker_process(ws, ad, art)
  Worker$new(proc, ws, ad, art)
}

# Create a Session with a real worker for a notebook built from lines.
make_test_session <- function(lines, execution_mode = "automatic",
                              run_on_startup = FALSE) {
  nb <- parse_notebook_lines(path = NA_character_, lines = lines)
  w <- make_test_worker()
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

# Compare two lists, ignoring any fields that differ by a single I() wrapper.
expect_equal_ignoring_i <- function(actual, expected, ...) {
  expect_equal(actual, expected, ...)
}

# Assert that a cell in the session state has a specific status.
expect_cell_status <- function(session, cell_id, status) {
  st <- session$state()
  for (c in st$cells) {
    if (identical(c$id, cell_id)) {
      expect_equal(c$status, status)
      return(invisible())
    }
  }
  fail("cell not found: ", cell_id)
}