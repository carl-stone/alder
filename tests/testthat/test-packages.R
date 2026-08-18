# Focused package/environment-management tests.  Installation tests never
# contact a repository: when pak is present, only the child diagnostic parser is
# exercised; when it is absent, the isolated child fails before package lookup.

pkg_fn <- function(name) getFromNamespace(name, "alder")

make_package_project <- function() {
  root <- tempfile("alder-packages-")
  dir.create(root)
  notebook <- file.path(root, "demo.R")
  writeLines(c("# %%", "1 + 1"), notebook, useBytes = TRUE)
  list(root = root, notebook = notebook)
}

testthat::test_that("declarations are validated, canonical, and atomic", {
  project <- make_package_project()
  declare <- pkg_fn("alder_declare")
  packages <- pkg_fn("alder_packages")

  first <- declare(c("utils", "base"), project$notebook)
  testthat::expect_true(isTRUE(first$ok))
  testthat::expect_equal(first$declared, c("base", "utils"))
  metadata <- file.path(project$root, ".alder", "packages.yaml")
  testthat::expect_true(file.exists(metadata))
  testthat::expect_equal(
    yaml::yaml.load_file(metadata, eval.expr = FALSE)$packages,
    c("base", "utils")
  )

  second <- declare(c("base", "stats"), project$notebook)
  testthat::expect_equal(second$declared, c("base", "stats", "utils"))
  testthat::expect_equal(
    paste(readLines(metadata, warn = FALSE), collapse = "\n"),
    "packages:\n- base\n- stats\n- utils"
  )
  state <- packages(project$notebook)
  testthat::expect_equal(state$declared, c("base", "stats", "utils"))
  testthat::expect_length(state$installing, 0L)
})

testthat::test_that("status reports installed and missing without changing libraries", {
  status <- pkg_fn("alder_package_status")
  packages <- pkg_fn("alder_packages")
  project <- make_package_project()
  declare <- pkg_fn("alder_declare")
  declare(c("base", "DefinitelyMissingAlderPackage"), project$notebook)

  before <- .libPaths()
  result <- status(c("base", "DefinitelyMissingAlderPackage"), before)
  testthat::expect_identical(.libPaths(), before)
  testthat::expect_equal(
    result$status[match(c("base", "DefinitelyMissingAlderPackage"), result$package)],
    c("installed", "missing")
  )
  testthat::expect_true(is.character(result$version[[1L]]) ||
                          is.na(result$version[[1L]]))

  state <- packages(project$notebook)
  testthat::expect_true("base" %in% state$installed)
  testthat::expect_true("DefinitelyMissingAlderPackage" %in% state$missing)
})

testthat::test_that("invalid package names fail with an alder error", {
  declare <- pkg_fn("alder_declare")
  status <- pkg_fn("alder_package_status")
  project <- make_package_project()
  invalid <- c("../escape", "not/a-package", "1startsWithNumber", "")
  for (name in invalid) {
    err <- testthat::expect_error(
      declare(name, project$notebook),
      class = "alder_error"
    )
    testthat::expect_equal(err$code, "invalid_request")
    err <- testthat::expect_error(status(name), class = "alder_error")
    testthat::expect_equal(err$code, "invalid_request")
  }
})

testthat::test_that("installation stays isolated and returns actionable failures", {
  install <- pkg_fn("alder_install")
  parse_error <- pkg_fn(".alder_install_error")
  project <- make_package_project()
  target <- file.path(project$root, "project-library")
  before <- .libPaths()

  # A package already supplied by R is a no-op and must not launch a network
  # install.  The explicit target is created without changing .libPaths().
  result <- install("base", project$notebook, target)
  testthat::expect_true(isTRUE(result$ok))
  testthat::expect_equal(result$status, "installed")
  testthat::expect_identical(.libPaths(), before)
  testthat::expect_true(dir.exists(target))

  diagnostic <- parse_error(
    "",
    paste0("ALDER_PACKAGE_ERROR\tinstall_failed\tunable to resolve package\n"),
    17L
  )
  testthat::expect_equal(diagnostic$code, "install_failed")
  testthat::expect_match(diagnostic$message, "unable to resolve package")

  # Do not contact a repository in the test suite.  Without pak the child
  # exits before resolving packages and returns its documented alder error.
  if (!requireNamespace("pak", quietly = TRUE)) {
    failed <- install("DefinitelyMissingAlderPackage", project$notebook, target)
    testthat::expect_false(failed$ok)
    testthat::expect_equal(failed$status, "error")
    testthat::expect_equal(failed$error$code, "invalid_request")
    testthat::expect_match(failed$error$message, "requires the pak package")
  } else {
    testthat::skip("pak is installed; network installation intentionally skipped")
  }
})

testthat::test_that("sandbox resolution is deterministic and does not mutate libraries", {
  sandbox <- pkg_fn("alder_sandbox")
  project <- make_package_project()
  before <- .libPaths()
  result <- sandbox(project$notebook)
  expected <- file.path(
    project$root, ".alder", "renv", "library", R.version$platform,
    paste(R.version$major, R.version$minor, sep = ".")
  )
  testthat::expect_equal(normalizePath(result$lib), normalizePath(expected))
  testthat::expect_true(startsWith(result$env[["R_LIBS_USER"]], result$lib))
  # A parent R_LIBS must not outrank the sandbox in the worker.
  if (nzchar(Sys.getenv("R_LIBS", unset = ""))) {
    testthat::expect_true(startsWith(result$env[["R_LIBS"]], result$lib))
  }
  testthat::expect_true(dir.exists(result$lib))
  testthat::expect_identical(.libPaths(), before)

  err <- testthat::expect_error(sandbox(NULL), class = "alder_error")
  testthat::expect_equal(err$code, "invalid_request")
})

testthat::test_that("start_alder sandbox isolates the worker package library", {
  project <- make_package_project()
  writeLines(c("# %%", "1 + 1", "# %%", ".libPaths()[[1L]]"),
             project$notebook, useBytes = TRUE)
  sandbox_lib <- file.path(
    project$root, ".alder", "renv", "library", R.version$platform,
    paste(R.version$major, R.version$minor, sep = ".")
  )

  # A sandboxed server requires a notebook path: NULL and gallery paths are
  # rejected before any process or server starts.
  err <- testthat::expect_error(
    alder::start_alder(sandbox = TRUE),
    class = "alder_error"
  )
  testthat::expect_equal(err$code, "invalid_request")
  err <- testthat::expect_error(
    alder::start_alder(project$root, sandbox = TRUE),
    class = "alder_error"
  )
  testthat::expect_equal(err$code, "invalid_request")

  srv <- alder::start_alder(project$notebook, port = 8933L,
                            run_on_startup = TRUE, sandbox = TRUE)
  withr::defer(alder::stop_alder(srv), testthat::teardown_env())
  wait_until_idle(srv$session, timeout = 30)

  st <- srv$session$state()
  c2 <- NULL
  for (c in st$cells) {
    if (identical(c$id, "cell-2")) {
      c2 <- if (length(c$outputs)) c$outputs[[length(c$outputs)]] else NULL
      break
    }
  }
  testthat::expect_false(is.null(c2))
  testthat::expect_match(
    c2$text,
    paste0("\\[1\\] \"", gsub("([.\\\\])", "\\\\\\1",
                               normalizePath(sandbox_lib))),
    perl = TRUE
  )

  # The sandbox library is also the declared-package install target: the
  # session resolves installs into the sandbox instead of the default
  # project library.
  result <- srv$session$install_packages(c("base", "stats"))
  testthat::expect_equal(result$status, "installed")
  testthat::expect_equal(normalizePath(result$lib),
                         normalizePath(sandbox_lib))
})
