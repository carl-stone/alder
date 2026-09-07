test_that("cancelled service calls fail while operation waits retain their status", {
  cancelled <- list(id = "operation", status = "cancelled",
                    error = list(code = "interrupted", message = "Interrupted"))
  local_mocked_bindings(
    alder_host_command = function(...) list(operation = cancelled),
    alder_host_request = function(...) list(operation = cancelled),
    .package = "alder"
  )
  expect_identical(alder_host_wait(list(), "operation"), cancelled)
  expect_error(alder_host_request_service(list(), "packages.install"),
               "Interrupted", class = "alder_error")
})

test_that("headless export stops its host when execution is cancelled", {
  stopped <- FALSE
  server <- list(session = list(
    run_all = function() list(operation = list(id = "operation")),
    await_operation = function(id) list(status = "cancelled",
      error = list(code = "interrupted", message = "Interrupted"))
  ))
  local_mocked_bindings(
    alder_start_host = function(...) server,
    stop_alder = function(...) { stopped <<- TRUE },
    .package = "alder"
  )
  expect_error(export_headless_session(list(path = "unused.R")),
               "Interrupted", class = "alder_error")
  expect_true(stopped)
})

test_that("installed R entry points use the host controller and clean up", {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  path <- tempfile(fileext = ".R")
  writeLines(c("# %%", "x <- 41", "x + 1"), path)
  on.exit(unlink(path), add = TRUE)
  server <- start_alder(path, port = httpuv::randomPort(), run_on_startup = FALSE)
  on.exit(stop_alder(server), add = TRUE)
  state <- server$session$state()
  expect_true(state$runtime$executionReady)
  expect_identical(state$cells[[1]]$status, "idle")
  receipt <- server$session$run_all()
  expect_identical(receipt$operation$kind, "run")
  operation <- server$session$await_operation(receipt$operation$id)
  expect_identical(operation$status, "done")
  state <- server$session$state()
  expect_identical(state$cells[[1]]$status, "done")
  expect_match(state$cells[[1]]$outputs[[1]]$text, "42", fixed = TRUE)
  stop_alder(server)
  expect_false(server$host_process$process$is_alive())
  expect_true(server$lifecycle$stopped)
  expect_true(server$lifecycle$shutdown_requested)
  expect_identical(server$lifecycle$shutdown_reason, "stop_alder")
  expect_identical(as.integer(server$lifecycle$exit_status), 0L)
})

test_that("the R host facade maps interactive Session operations", {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  root <- tempfile("alder-host-facade-")
  dir.create(root)
  path <- file.path(root, "notebook.R")
  writeLines(c("# %%", "x<-1"), path, useBytes = TRUE)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)
  server <- start_alder(path, port = httpuv::randomPort(),
                        execution_mode = "lazy", run_on_startup = FALSE)
  on.exit(stop_alder(server), add = TRUE)

  initial <- server$session$state()
  expect_identical(initial$runtime$execution_mode, "lazy")
  edited <- server$session$set_cell(
    "cell-1", c("x <- 2", "x"), "code",
    initial$cells[[1L]]$revision
  )
  expect_identical(edited$revision, 1L)
  added <- server$session$add_cell("cell-1", "y <- x + 1", "code")
  expect_match(added$id, "^cell-")
  expect_identical(server$session$set_cell_name(added$id, "answer")$name,
                   "answer")
  expect_true(server$session$set_cell_disabled(added$id, TRUE)$disabled)
  expect_false(server$session$set_cell_disabled(added$id, FALSE)$disabled)
  expect_identical(server$session$move_cell(added$id, "cell-1")$after,
                   "cell-1")
  expect_null(server$session$validate_graph())

  app <- server$session$set_app(list(width = "compact"))
  expect_identical(app$app$width, "compact")
  layout <- list(version = 1L, cells = setNames(list(
    list(x = 0L, y = 0L, w = 12L, h = 1L)
  ), added$id))
  expect_identical(server$session$set_layout(layout)$layout$version, 1L)
  expect_identical(server$session$set_config(list(theme = "dark"))$config$theme,
                   "dark")

  receipt <- server$session$run_stale()
  expect_identical(receipt$run_id, receipt$operation$id)
  expect_identical(server$session$await_operation(receipt$run_id)$status,
                   "done")
  value_token <- server$session$request_value("y")
  expect_identical(server$session$await_operation(value_token)$status, "done")
  expect_false(is.null(server$session$state()$last_value))
  expect_true(is.character(server$session$state_json()))
  expect_identical(server$session$notebook_snapshot()$cells[[2L]]$body,
                   "y <- x + 1")
  expect_false(is.null(server$session$save()$path))
  expect_true(server$session$worker_available())
  expect_identical(server$session$restart_worker(FALSE)$operation$status,
                   "done")
})

test_that("host-backed headless export evaluates notebook effects once", {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  root <- tempfile("alder-host-export-")
  dir.create(root)
  path <- file.path(root, "effect.R")
  marker <- file.path(root, "effect.log")
  output <- file.path(root, "effect.alder-session.json")
  literal <- paste(deparse(marker), collapse = "")
  writeLines(c(
    "# %%", paste0("cat('tick\\n', file = ", literal, ", append = TRUE)"),
    "# %%", paste0("length(readLines(", literal, "))")
  ), path, useBytes = TRUE)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)

  expect_identical(alder_export(path, "session", out = output),
                   invisible(normalizePath(output, mustWork = FALSE)))
  expect_identical(readLines(marker, warn = FALSE), "tick")
  exported <- jsonlite::fromJSON(output, simplifyVector = FALSE)
  expect_identical(exported$cells[[2L]]$status, "done")
  expect_match(exported$cells[[2L]]$outputs[[1L]]$text, "1", fixed = TRUE)
})

test_that("host sandbox selects the resolved renv library", {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  skip_if_not_installed("renv")
  root <- tempfile("alder-host-sandbox-")
  dir.create(root)
  path <- file.path(root, "sandbox.R")
  sandbox <- .alder_renv_paths(root)$library
  literal <- paste(deparse(sandbox), collapse = "")
  writeLines(c(
    "# %%",
    paste0("identical(normalizePath(.libPaths()[[1L]], winslash = '/'), ",
           "normalizePath(", literal, ", winslash = '/'))")
  ), path, useBytes = TRUE)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)
  server <- start_alder(path, port = httpuv::randomPort(), sandbox = TRUE,
                        run_on_startup = FALSE)
  on.exit(stop_alder(server), add = TRUE)

  receipt <- server$session$run_all()
  expect_identical(server$session$await_operation(receipt$operation$id)$status,
                   "done")
  expect_match(server$session$state()$cells[[1L]]$outputs[[1L]]$text,
               "TRUE", fixed = TRUE)
  installed <- server$session$install_packages(c("base", "stats"))
  expect_identical(installed$status, "installed")
  expect_identical(normalizePath(installed$lib), normalizePath(sandbox))
})

test_that("host supports unsaved sessions and gallery lifecycle", {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  unsaved <- start_alder(NULL, port = httpuv::randomPort(),
                         run_on_startup = FALSE)
  expect_null(unsaved$session$state()$path)
  error <- expect_error(unsaved$session$save(), class = "alder_error")
  expect_identical(error$code, "notebook_has_no_path")
  stop_alder(unsaved)
  expect_false(unsaved$host_process$process$is_alive())

  root <- tempfile("alder-host-gallery-")
  dir.create(root)
  writeLines(c("# %%", "1 + 1"), file.path(root, "one.R"))
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)
  gallery <- start_alder(root, port = httpuv::randomPort(),
                         run_on_startup = FALSE)
  on.exit(stop_alder(gallery), add = TRUE)
  expect_true(gallery$gallery)
  expect_null(gallery$session)
  page <- curl::curl_fetch_memory(
    paste0(gallery$host_process$ready$address$origin, "/"))
  expect_identical(page$status_code, 200L)
  expect_match(rawToChar(page$content), "one.R", fixed = TRUE)
  stop_alder(gallery)
  expect_true(gallery$lifecycle$stopped)
  expect_identical(as.integer(gallery$lifecycle$exit_status), 0L)
})
