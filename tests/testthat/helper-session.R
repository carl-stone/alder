# Helper: locate or install Alder for production-host integration tests.
#
# The host's R subprocesses need the installed package (Rscript --vanilla
# cannot use pkgload::load_all), so source-tree tests install it once.
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
    # library while the host or one of its R subprocesses is still starting.
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
    if (identical(Sys.getenv("ALDER_TEST_HOST"), "1")) {
      node <- Sys.getenv("ALDER_NODE", unset = "")
      if (!nzchar(node) || !file.exists(node) || dir.exists(node)) {
        stop("ALDER_NODE must name the pinned Node executable for host tests")
      }
      stage_script <- file.path(repo, "host", "scripts", "stage-native.mjs")
      if (!file.exists(stage_script)) {
        stop("host/scripts/stage-native.mjs is required for host tests")
      }
      host <- file.path(lib, "alder", "host")
      if (!file.exists(file.path(host, "alder-host.mjs"))) {
        stop("installed Alder host is required for host tests")
      }
      staged <- system2(
        normalizePath(node, mustWork = TRUE),
        c(shQuote(stage_script), shQuote(host)),
        stdout = FALSE, stderr = FALSE
      )
      if (!identical(staged, 0L) ||
          !file.exists(file.path(host, "native-manifest.json"))) {
        stop("native host transport staging failed for test installation")
      }
    }
    cached <<- lib
    lib
  }
})

# Start the installed production host and Ark kernel for a temporary notebook.
make_test_session <- function(lines, execution_mode = "automatic",
                              run_on_startup = FALSE,
                              runtime_env = character()) {
  testthat::skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  if (!is.character(lines) || anyNA(lines)) {
    stop("`lines` must be a character vector without missing values")
  }
  if (!is.character(runtime_env) || anyNA(runtime_env) ||
      (length(runtime_env) &&
       (is.null(names(runtime_env)) || any(!nzchar(names(runtime_env)))))) {
    stop("`runtime_env` must be a named character vector")
  }

  root <- tempfile("alder-host-session-")
  dir.create(root)
  path <- file.path(root, "notebook.R")
  writeLines(lines, path, useBytes = TRUE)

  server <- tryCatch(
    withr::with_envvar(runtime_env, start_alder(
      path,
      port = httpuv::randomPort(),
      execution_mode = execution_mode,
      run_on_startup = run_on_startup
    )),
    error = function(error) {
      unlink(root, recursive = TRUE, force = TRUE)
      stop(error)
    }
  )
  closed <- FALSE
  close <- function() {
    if (closed) return(invisible())
    closed <<- TRUE
    try(stop_alder(server), silent = TRUE)
    unlink(root, recursive = TRUE, force = TRUE)
    invisible()
  }
  session <- server$session
  session$stop <- close
  list(session = session, boot = server$host_process, notebook = path,
       path = path, server = server, close = close)
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
  wait_for(session, function() {
    state <- session$state()
    isTRUE(state$runtime$executionReady) && !isTRUE(state$runtime$busy) &&
      !any(vapply(state$cells, function(cell)
        isTRUE(cell$analysisPending), logical(1)))
  }, timeout)
}

# Pump until every cell has reached a terminal state. Keep the default above
# the cold host/Ark startup envelope so a single-file test is reliable.
wait_until_settled <- function(session, receipt_or_id = NULL, timeout = 15) {
  operation_id <- if (is.character(receipt_or_id) &&
                      length(receipt_or_id) == 1L) {
    receipt_or_id
  } else if (is.list(receipt_or_id)) {
    receipt_or_id$run_id %||% receipt_or_id$operation$id %||%
      receipt_or_id$id %||% NULL
  } else {
    NULL
  }
  settled <- NULL
  wait_for(session, function() {
    if (!is.null(operation_id)) {
      settled <<- session$run_operation(operation_id)
      return(settled$status %in% c("done", "error", "cancelled"))
    }
    state <- session$state()
    isTRUE(state$runtime$executionReady) && !isTRUE(state$runtime$busy) &&
      !any(vapply(state$cells, function(cell)
        identical(cell$status, "running") || isTRUE(cell$analysisPending),
        logical(1)))
  }, timeout)
  invisible(settled)
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
