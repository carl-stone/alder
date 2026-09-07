# Installed command-line lifecycle: cross-platform launchers, parsing,
# HTTP shutdown, browser-idle teardown, and foreground Unix signals.

cli_test_env <- function() {
  env <- Sys.getenv()
  # R CMD check intentionally shadows bare `Rscript` with a failing wrapper.
  # The packaged shell launcher resolves Rscript from an ordinary user's PATH,
  # so give it the actual runtime first and do not leak the check harness's
  # relative startup file into the nested process.
  existing_path <- unname(env["PATH"])
  if (is.na(existing_path)) existing_path <- ""
  env[["PATH"]] <- paste(
    c(dirname(file.path(R.home("bin"), "Rscript")),
      existing_path[nzchar(existing_path)]),
    collapse = .Platform$path.sep
  )
  env <- env[names(env) != "R_TESTS"]
  # Defined in helper-session.R, which testthat sources before this file.
  lib <- alder_cache_lib() # nolint: object_usage_linter
  if (nzchar(lib)) {
    existing <- unname(env["R_LIBS"])
    if (is.na(existing)) existing <- ""
    env[["R_LIBS"]] <- paste(c(lib, existing[nzchar(existing)]),
                              collapse = .Platform$path.sep)
  }
  env
}

cli_install_for_test <- function(root) {
  bin <- file.path(root, "bin")
  suppressMessages(alder_install_cli(bin))
}

cli_launcher_process <- function(launcher, args) {
  command <- launcher
  command_args <- args
  if (.Platform$OS.type == "windows") {
    command <- Sys.getenv("COMSPEC", unset = "cmd.exe")
    command_args <- c("/d", "/s", "/c", "call", launcher, args)
  }
  processx::process$new(
    command, command_args, env = cli_test_env(), stdout = "|", stderr = "|",
    cleanup_tree = TRUE
  )
}

cli_wait_ready <- function(process, timeout = 60) {
  deadline <- Sys.time() + timeout
  output <- character()
  errors <- character()
  repeat {
    output <- c(output, process$read_output_lines())
    errors <- c(errors, process$read_error_lines())
    if (any(grepl("alder running at ", output, fixed = TRUE))) {
      return(list(output = output, errors = errors))
    }
    if (!process$is_alive() || Sys.time() >= deadline) {
      if (process$is_alive()) process$kill()
      process$wait(5000)
      stop("CLI did not become ready: ",
           paste(c(output, errors), collapse = " | "), call. = FALSE)
    }
    Sys.sleep(0.02)
  }
}

cli_wait_exit <- function(process, timeout = 15) {
  deadline <- Sys.time() + timeout
  while (process$is_alive() && Sys.time() < deadline) Sys.sleep(0.02)
  if (process$is_alive()) {
    process$kill()
    process$wait(5000)
    stop("CLI did not exit before its deadline", call. = FALSE)
  }
  process$wait(5000)
  process$get_exit_status()
}

cli_descendants <- function(parent) {
  if (.Platform$OS.type == "windows") {
    return(tryCatch(
      vapply(ps::ps_children(ps::ps_handle(parent), recursive = TRUE),
             ps::ps_pid, integer(1L)),
      error = function(condition) integer()
    ))
  }
  result <- processx::run("ps", c("-e", "-o", "pid=,ppid="),
                          error_on_status = FALSE)
  if (result$status != 0L) return(integer())
  lines <- strsplit(trimws(result$stdout), "\n", fixed = TRUE)[[1L]]
  fields <- strsplit(trimws(lines), "[[:space:]]+", perl = TRUE)
  rows <- fields[vapply(fields, length, integer(1L)) >= 2L]
  if (!length(rows)) return(integer())
  pid <- vapply(rows, function(row) as.integer(row[[1L]]), integer(1L))
  ppid <- vapply(rows, function(row) as.integer(row[[2L]]), integer(1L))
  found <- integer()
  frontier <- as.integer(parent)
  repeat {
    children <- pid[ppid %in% frontier]
    children <- setdiff(children, found)
    if (!length(children)) break
    found <- c(found, children)
    frontier <- children
  }
  found
}

cli_port_open <- function(port) {
  tryCatch({
    handle <- curl::new_handle(connecttimeout_ms = 200L,
                               timeout_ms = 400L)
    curl::curl_fetch_memory(sprintf("http://127.0.0.1:%d/api/state", port),
                            handle = handle)
    TRUE
  }, error = function(condition) FALSE)
}

cli_json_post <- function(port, path, body) {
  handle <- curl::new_handle(
    customrequest = "POST",
    postfields = jsonlite::toJSON(
      body, auto_unbox = TRUE, null = "null", force = TRUE
    )
  )
  curl::handle_setheaders(handle, "Content-Type" = "application/json")
  curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d%s", port, path), handle = handle
  )
}

cli_expect_closed <- function(port, descendants, timeout = 5) {
  deadline <- Sys.time() + timeout
  repeat {
    live <- descendants[vapply(descendants, function(pid) {
      isTRUE(tryCatch(ps::ps_is_running(ps::ps_handle(pid)),
                      error = function(condition) FALSE))
    }, logical(1L))]
    if (!cli_port_open(port) && !length(live)) break
    if (Sys.time() >= deadline) {
      testthat::fail(paste0("port or child process remained after shutdown: ",
                           paste(live, collapse = ", ")))
      return(invisible(FALSE))
    }
    Sys.sleep(0.02)
  }
  testthat::expect_false(cli_port_open(port))
}

cli_start <- function(root, extra = character()) {
  dir.create(root, recursive = TRUE, showWarnings = FALSE)
  path <- file.path(root, "notebook.R")
  writeLines(c("# %%", "x <- 1"), path, useBytes = TRUE)
  port <- httpuv::randomPort()
  launcher <- cli_install_for_test(root)
  process <- cli_launcher_process(
    launcher, c("edit", path, "--no-open", "--port", as.character(port),
                extra)
  )
  cli_wait_ready(process)
  list(process = process, port = port, path = path,
       descendants = cli_descendants(process$get_pid()))
}

testthat::test_that("child processes pin the exact installed Alder library", {
  child_env <- cli_test_env()
  lib <- alder_cache_lib()
  child_path <- strsplit(child_env[["PATH"]], .Platform$path.sep,
                         fixed = TRUE)[[1L]]
  testthat::expect_identical(
    normalizePath(child_path[[1L]], mustWork = TRUE),
    normalizePath(R.home("bin"), mustWork = TRUE)
  )
  testthat::expect_false("R_TESTS" %in% names(child_env))
  testthat::expect_true(nzchar(lib))
  testthat::expect_true(dir.exists(file.path(lib, "alder")))
  if (!is.null(utils::packageDescription("alder")$Built)) {
    loaded <- getNamespaceInfo(asNamespace("alder"), "path")
    testthat::expect_identical(
      normalizePath(file.path(lib, "alder"), mustWork = TRUE),
      normalizePath(loaded, mustWork = TRUE)
    )
  }
})

testthat::test_that("CLI parsing exposes explicit lifecycle controls", {
  root <- tempfile("alder-cli-parse-")
  dir.create(root)
  path <- file.path(root, "note.R")
  writeLines(c("# %%", "1"), path)
  parsed <- alder:::alder_cli_parse(c(
    "edit", path, "--host=localhost", "--port", "4321", "--lazy",
    "--no-run", "--sandbox", "--idle-timeout=2.5", "--no-open"
  ))
  testthat::expect_identical(parsed$path, path)
  testthat::expect_identical(parsed$host, "localhost")
  testthat::expect_identical(parsed$port, 4321L)
  testthat::expect_identical(parsed$execution_mode, "lazy")
  testthat::expect_false(parsed$run_on_startup)
  testthat::expect_true(parsed$sandbox)
  testthat::expect_identical(parsed$idle_timeout, 2.5)
  testthat::expect_false(parsed$open)
  testthat::expect_false(parsed$new_notebook)

  new_path <- file.path(root, "new.R")
  new_notebook <- alder:::alder_cli_parse(c("edit", new_path, "--no-open"))
  testthat::expect_true(new_notebook$new_notebook)
  testthat::expect_identical(new_notebook$path, new_path)

  rendered <- alder:::alder_cli_parse(c(
    "render", path, "--engine", "pandoc", "--output",
    file.path(root, "report.html"), "--no-code"
  ))
  testthat::expect_identical(rendered$command, "render")
  testthat::expect_identical(rendered$engine, "pandoc")
  testthat::expect_identical(rendered$output, file.path(root, "report.html"))
  testthat::expect_false(rendered$include_code)

  testthat::expect_error(alder:::alder_cli_parse(character()),
                         "exactly one")
  testthat::expect_error(alder:::alder_cli_parse(c(path, "--port", "0")),
                         "valid range")
  testthat::expect_error(alder:::alder_cli_parse(c(path, "--wat")),
                         "unknown option")
  testthat::expect_error(alder:::alder_cli_parse(c(path, "--host", "0.0.0.0")),
                         "non-loopback binds")
  testthat::expect_error(alder:::alder_cli_parse(c(
    path, "--host", "0.0.0.0", "--allowed-origin", "http://example.com:4321"
  )), "non-loopback binds")
  testthat::expect_identical(
    alder:::alder_cli_parse(c(path, "--host", "::1"))$host,
    "::1"
  )
  testthat::expect_error(alder:::alder_cli_parse(c("render", path)),
                         "requires --engine")
  testthat::expect_error(alder:::alder_cli_parse(
    c("render", new_path, "--engine", "pandoc")),
    "render notebook file does not exist")
  testthat::expect_error(alder:::alder_cli_parse(
    c("render", path, "--engine", "pandoc", "--no-open")),
    "not valid for `alder render`", fixed = TRUE)
})

testthat::test_that("CLI installer selects its platform launcher atomically", {
  root <- tempfile("alder-cli-install-")
  old_path <- Sys.getenv("PATH", unset = NA_character_)
  on.exit(if (is.na(old_path)) Sys.unsetenv("PATH") else
    Sys.setenv(PATH = old_path), add = TRUE)
  Sys.setenv(PATH = "/path-not-containing-test-bin")
  expected <- if (.Platform$OS.type == "windows") "alder.cmd" else "alder"
  testthat::expect_message(
    launcher <- alder_install_cli(file.path(root, "chosen", "bin")),
    "Add .* to PATH"
  )
  testthat::expect_identical(basename(launcher), expected)
  if (.Platform$OS.type == "unix") {
    testthat::expect_identical(unname(file.access(launcher, 1L)), 0L)
  }
  testthat::expect_error(alder_install_cli(dirname(launcher)),
                         "refusing to replace")
  testthat::expect_message(
    replaced <- alder_install_cli(dirname(launcher), overwrite = TRUE),
    "Installed Alder CLI"
  )
  testthat::expect_identical(replaced, launcher)
  testthat::expect_false(any(grepl("^[.]alder-launcher-",
                                   list.files(dirname(launcher)))))

  simulated <- tempfile("alder-cli-windows-")
  testthat::expect_message(
    windows <- alder:::alder_install_cli_impl(
      simulated, overwrite = FALSE, os_type = "windows"
    ),
    "Installed Alder CLI"
  )
  testthat::expect_identical(basename(windows), "alder.cmd")
  packaged <- system.file("exec", "alder.cmd", package = "alder",
                          mustWork = TRUE)
  testthat::expect_identical(readBin(windows, "raw", file.info(windows)$size),
                             readBin(packaged, "raw", file.info(packaged)$size))
})

testthat::test_that("packaged Windows launcher is a bounded batch entry point", {
  launcher <- system.file("exec", "alder.cmd", package = "alder",
                          mustWork = TRUE)
  lines <- readLines(launcher, warn = FALSE)
  testthat::expect_identical(lines[[1L]], "@echo off")
  testthat::expect_true(any(grepl("where Rscript", lines, fixed = TRUE)))
  testthat::expect_true(any(grepl("exit /b 127", lines, fixed = TRUE)))
  testthat::expect_true(any(grepl("Rscript --vanilla", lines, fixed = TRUE)))
  testthat::expect_true(any(grepl("alder::alder_cli", lines, fixed = TRUE)))
  testthat::expect_true(any(grepl('runLast = FALSE)" %*', lines, fixed = TRUE)))
  testthat::expect_false(any(grepl("--args %*", lines, fixed = TRUE)))
  testthat::expect_true(any(grepl("exit /b %alder_status%", lines,
                                  fixed = TRUE)))
})

testthat::test_that("installed launcher reports help, version, and usage status", {
  if (.Platform$OS.type == "unix") {
    root <- tempfile("alder-cli-meta-")
    dir.create(root)
    launcher <- cli_install_for_test(root)
    help <- processx::run(launcher, "--help", env = cli_test_env(),
                          error_on_status = FALSE)
    testthat::expect_identical(help$status, 0L)
    testthat::expect_match(help$stdout, "Usage: alder")
    testthat::expect_match(help$stdout, "--idle-timeout")
    testthat::expect_match(help$stdout, "Loopback bind only")
    testthat::expect_match(help$stdout, "alder render NOTEBOOK[.]R")
    testthat::expect_match(help$stdout, "created only when you first Save")
    version <- processx::run(launcher, "--version", env = cli_test_env(),
                             error_on_status = FALSE)
    testthat::expect_identical(version$status, 0L)
    testthat::expect_match(version$stdout, "^alder 0[.]1[.]0")
    usage <- processx::run(launcher, character(), env = cli_test_env(),
                           error_on_status = FALSE)
    testthat::expect_identical(usage$status, 2L)
    testthat::expect_match(usage$stderr, "NOTEBOOK[.]R path is required")
  }
})

testthat::test_that("CLI announces a new notebook without creating it", {
  root <- tempfile("alder-cli-new-")
  dir.create(root)
  path <- file.path(root, "new-analysis.R")
  port <- httpuv::randomPort()
  launcher <- cli_install_for_test(root)
  process <- cli_launcher_process(
    launcher, c(path, "--no-open", "--no-run", "--port", as.character(port),
                "--no-idle-timeout")
  )
  on.exit({
    if (process$is_alive()) process$kill()
    process$wait(5000)
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  ready <- cli_wait_ready(process)
  testthat::expect_true(any(grepl(
    "alder new notebook at .*file will be created on Save",
    ready$output
  )))
  testthat::expect_false(file.exists(path))

  response <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/state", port)
  )
  state <- jsonlite::fromJSON(rawToChar(response$content),
                              simplifyVector = FALSE)
  accepted <- curl::new_handle(customrequest = "POST")
  curl::handle_setheaders(accepted,
    "X-Alder-Shutdown-Token" = state$shutdown_token)
  stopped <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/shutdown", port), handle = accepted
  )
  testthat::expect_identical(stopped$status_code, 202L)
  testthat::expect_identical(cli_wait_exit(process), 0L)
  testthat::expect_false(file.exists(path))
})

testthat::test_that("new notebook saves and reopens through installed launcher", {
  root <- tempfile("alder-cli-new-save-")
  dir.create(root)
  path <- file.path(root, "saved-analysis.R")
  launcher <- cli_install_for_test(root)
  port <- httpuv::randomPort()
  process <- cli_launcher_process(
    launcher, c(path, "--no-open", "--no-run", "--port", as.character(port),
                "--no-idle-timeout")
  )
  process2 <- NULL
  on.exit({
    if (process$is_alive()) process$kill()
    process$wait(5000)
    if (!is.null(process2)) {
      if (process2$is_alive()) process2$kill()
      process2$wait(5000)
    }
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  cli_wait_ready(process)
  testthat::expect_false(file.exists(path))

  added <- cli_json_post(port, "/api/cell", list(
    op = "add", after = NULL, body = I(c("x <- 41", "x + 1")), type = "code"
  ))
  testthat::expect_identical(added$status_code, 200L)
  saved <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/save", port),
    handle = curl::new_handle(customrequest = "POST")
  )
  testthat::expect_identical(saved$status_code, 200L)
  testthat::expect_identical(readLines(path, warn = FALSE),
                             c("# %%", "x <- 41", "x + 1"))

  state_response <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/state", port)
  )
  state <- jsonlite::fromJSON(rawToChar(state_response$content),
                              simplifyVector = FALSE)
  accepted <- curl::new_handle(customrequest = "POST")
  curl::handle_setheaders(accepted,
    "X-Alder-Shutdown-Token" = state$shutdown_token)
  stopped <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/shutdown", port), handle = accepted
  )
  testthat::expect_identical(stopped$status_code, 202L)
  testthat::expect_identical(cli_wait_exit(process), 0L)

  port2 <- httpuv::randomPort()
  process2 <- cli_launcher_process(
    launcher, c(path, "--no-open", "--no-run", "--port", as.character(port2),
                "--no-idle-timeout")
  )
  reopened <- cli_wait_ready(process2)
  testthat::expect_false(any(grepl("alder new notebook at", reopened$output,
                                   fixed = TRUE)))
  reopened_response <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/state", port2)
  )
  reopened_state <- jsonlite::fromJSON(rawToChar(reopened_response$content),
                                       simplifyVector = FALSE)
  testthat::expect_identical(
    unlist(reopened_state$cells[[1L]]$body, use.names = FALSE),
    c("x <- 41", "x + 1")
  )
  accepted2 <- curl::new_handle(customrequest = "POST")
  curl::handle_setheaders(accepted2,
    "X-Alder-Shutdown-Token" = reopened_state$shutdown_token)
  stopped2 <- curl::curl_fetch_memory(
    sprintf("http://127.0.0.1:%d/api/shutdown", port2), handle = accepted2
  )
  testthat::expect_identical(stopped2$status_code, 202L)
  testthat::expect_identical(cli_wait_exit(process2), 0L)
  testthat::expect_identical(readLines(path, warn = FALSE),
                             c("# %%", "x <- 41", "x + 1"))
})

testthat::test_that("authenticated shutdown exits cleanly and releases children", {
  root <- tempfile("alder-cli-shutdown-")
  context <- cli_start(root, c("--lazy", "--no-run", "--no-idle-timeout"))
  on.exit({
    if (context$process$is_alive()) context$process$kill()
    context$process$wait(5000)
    unlink(root, recursive = TRUE, force = TRUE)
  }, add = TRUE)
  base <- sprintf("http://127.0.0.1:%d", context$port)
  response <- curl::curl_fetch_memory(paste0(base, "/api/state"))
  state <- jsonlite::fromJSON(rawToChar(response$content),
                              simplifyVector = FALSE)
  testthat::expect_identical(state$runtime$execution_mode, "lazy")
  testthat::expect_false(state$runtime$run_on_startup)
  testthat::expect_match(state$shutdown_token, "^[A-Za-z0-9]{48}$")

  invalid <- curl::new_handle(customrequest = "POST")
  curl::handle_setheaders(invalid,
    "X-Alder-Shutdown-Token" = "not-the-token")
  denied <- curl::curl_fetch_memory(paste0(base, "/api/shutdown"),
                                    handle = invalid)
  testthat::expect_identical(denied$status_code, 403L)
  testthat::expect_true(context$process$is_alive())

  accepted <- curl::new_handle(customrequest = "POST")
  curl::handle_setheaders(accepted,
    "X-Alder-Shutdown-Token" = state$shutdown_token)
  stopped <- curl::curl_fetch_memory(paste0(base, "/api/shutdown"),
                                     handle = accepted)
  testthat::expect_identical(stopped$status_code, 202L)
  testthat::expect_identical(cli_wait_exit(context$process), 0L)
  cli_expect_closed(context$port, context$descendants)
})

testthat::test_that("browser-idle timeout starts only after a browser poll", {
  if (.Platform$OS.type == "unix") {
    root <- tempfile("alder-cli-idle-")
    context <- cli_start(root, c("--no-run", "--idle-timeout", "0.4"))
    on.exit({
      if (context$process$is_alive()) context$process$kill()
      context$process$wait(5000)
      unlink(root, recursive = TRUE, force = TRUE)
    }, add = TRUE)
    Sys.sleep(0.6)
    testthat::expect_true(context$process$is_alive())
    browser <- curl::new_handle()
    curl::handle_setheaders(browser,
      "User-Agent" = "Mozilla/5.0 Alder lifecycle test",
      "Sec-Fetch-Site" = "same-origin")
    state <- curl::curl_fetch_memory(
      sprintf("http://127.0.0.1:%d/api/state", context$port),
      handle = browser)
    testthat::expect_identical(state$status_code, 200L)
    testthat::expect_identical(cli_wait_exit(context$process), 0L)
    cli_expect_closed(context$port, context$descendants)
  }
})

testthat::test_that("browser-idle shutdown atomically saves acknowledged edits", {
  if (.Platform$OS.type == "unix") {
    root <- tempfile("alder-cli-idle-save-")
    # The server timer advances in a separate process while R CMD check may
    # deschedule this client. Keep ample time between its presence poll and
    # mutation; the assertion still waits for and verifies the idle shutdown.
    idle_window <- 5
    context <- cli_start(root, c("--no-run", "--idle-timeout",
                                 as.character(idle_window)))
    on.exit({
      if (context$process$is_alive()) context$process$kill()
      context$process$wait(5000)
      unlink(root, recursive = TRUE, force = TRUE)
    }, add = TRUE)
    browser <- curl::new_handle()
    curl::handle_setheaders(browser,
      "User-Agent" = "Mozilla/5.0 Alder idle-save test",
      "Sec-Fetch-Site" = "same-origin")
    response <- curl::curl_fetch_memory(
      sprintf("http://127.0.0.1:%d/api/state", context$port),
      handle = browser
    )
    state <- jsonlite::fromJSON(rawToChar(response$content),
                                simplifyVector = FALSE)
    edited <- "x <- 999 # persisted before idle shutdown"
    changed <- cli_json_post(context$port, "/api/cell", list(
      op = "edit", id = state$cells[[1L]]$id, body = I(c(edited)),
      type = "code", expected_revision = state$cells[[1L]]$revision
    ))
    testthat::expect_identical(changed$status_code, 200L)
    testthat::expect_identical(cli_wait_exit(context$process), 0L)
    testthat::expect_identical(
      readLines(context$path, warn = FALSE), c("# %%", edited)
    )
    cli_expect_closed(context$port, context$descendants)
  }
})

testthat::test_that("idle shutdown pauses visibly when a dirty save conflicts", {
  if (.Platform$OS.type == "unix") {
    root <- tempfile("alder-cli-idle-conflict-")
    idle_window <- 5
    context <- cli_start(root, c("--no-run", "--idle-timeout",
                                 as.character(idle_window)))
    on.exit({
      if (context$process$is_alive()) context$process$kill()
      context$process$wait(5000)
      unlink(root, recursive = TRUE, force = TRUE)
    }, add = TRUE)
    browser <- curl::new_handle()
    curl::handle_setheaders(browser,
      "User-Agent" = "Mozilla/5.0 Alder idle-conflict test",
      "Sec-Fetch-Site" = "same-origin")
    response <- curl::curl_fetch_memory(
      sprintf("http://127.0.0.1:%d/api/state", context$port),
      handle = browser
    )
    state <- jsonlite::fromJSON(rawToChar(response$content),
                                simplifyVector = FALSE)
    changed <- cli_json_post(context$port, "/api/cell", list(
      op = "edit", id = state$cells[[1L]]$id,
      body = I(c("x <- 999 # retained in server")), type = "code",
      expected_revision = state$cells[[1L]]$revision
    ))
    testthat::expect_identical(changed$status_code, 200L)
    external <- c("# %%", "x <- 2 # external edit")
    writeLines(external, context$path, useBytes = TRUE)
    Sys.sleep(idle_window + 0.5)
    testthat::expect_true(context$process$is_alive())

    response <- curl::curl_fetch_memory(
      sprintf("http://127.0.0.1:%d/api/state", context$port),
      handle = browser
    )
    blocked <- jsonlite::fromJSON(rawToChar(response$content),
                                  simplifyVector = FALSE)
    testthat::expect_true(blocked$changed)
    testthat::expect_identical(
      blocked$last_action_error$code, "idle_save_failed"
    )
    testthat::expect_match(
      blocked$last_action_error$message, "Automatic idle shutdown is paused"
    )
    testthat::expect_identical(readLines(context$path, warn = FALSE), external)
  }
})

testthat::test_that("foreground INT TERM and HUP produce clean teardown", {
  if (.Platform$OS.type == "unix") {
    # R catches foreground SIGINT and alder_cli() returns its documented 130.
    # TERM/HUP retain their native disposition; processx represents a process
    # killed by a signal as the negative signal number (a calling shell would
    # conventionally expose 128 + signal instead).
    cases <- list(INT = c(2L, 130L), TERM = c(15L, -15L), HUP = c(1L, -1L))
    for (name in names(cases)) {
      root <- tempfile(paste0("alder-cli-signal-", tolower(name), "-"))
      context <- cli_start(root, c("--no-run", "--no-idle-timeout"))
      context$process$signal(cases[[name]][[1L]])
      status <- cli_wait_exit(context$process)
      testthat::expect_identical(status, cases[[name]][[2L]], info = name)
      cli_expect_closed(context$port, context$descendants)
      unlink(root, recursive = TRUE, force = TRUE)
    }
  }
})

testthat::test_that(
  "SIGINT around a large state response tears down the installed CLI",
  {
    if (.Platform$OS.type == "unix") {
      root <- tempfile("alder-cli-active-signal-")
      dir.create(root)
      notebook <- file.path(root, "active-state.R")
      # Keep a large response in flight while stopping the R launcher. The
      # separate Node host may finish serialization before it receives Stop.
      source_line <- paste0("# ", strrep("x", 4093L))
      writeLines(c("# %%", "x <- 1", rep(source_line, 2048L)), notebook,
                 useBytes = TRUE)
      launcher <- cli_install_for_test(root)
      port <- httpuv::randomPort()
      process <- cli_launcher_process(
        launcher, c("edit", notebook, "--no-open", "--no-run", "--port",
                    as.character(port), "--no-idle-timeout")
      )
      client <- NULL
      on.exit({
        if (!is.null(client) && client$is_alive()) client$kill()
        if (!is.null(client)) client$wait(5000)
        if (process$is_alive()) process$kill()
        process$wait(5000)
        unlink(root, recursive = TRUE, force = TRUE)
      }, add = TRUE)
      cli_wait_ready(process)
      descendants <- cli_descendants(process$get_pid())
      header_path <- file.path(root, "response-headers.log")
      body_path <- file.path(root, "response-body.json")
      error_path <- file.path(root, "client-stderr.log")
      client <- processx::process$new(
        "curl", c("--http1.1", "--silent", "--show-error", "--max-time",
                  "20", "--dump-header", header_path, "--output",
                  body_path, sprintf("http://127.0.0.1:%d/api/state", port)),
        stdout = "|", stderr = error_path, cleanup = TRUE,
        cleanup_tree = TRUE
      )

      # The HTTP owner is Node; the R launcher can be sleeping throughout a
      # complete response. Synchronize with the client instead of /proc state.
      deadline <- Sys.time() + 15
      response_started <- function() {
        file.exists(header_path) && isTRUE(file.info(header_path)$size > 0)
      }
      while (Sys.time() < deadline && client$is_alive() &&
             process$is_alive() && !response_started()) {
        Sys.sleep(0.005)
      }
      testthat::expect_true(response_started())
      testthat::expect_true(process$signal(2L))
      testthat::expect_identical(cli_wait_exit(process, 20), 130L)
      client$wait(20000)
      testthat::expect_false(client$is_alive())
      testthat::expect_identical(client$get_exit_status(), 0L)
      testthat::expect_false(any(grepl("An exception occurred|HTTP 500",
                                       readLines(error_path, warn = FALSE))))
      headers <- if (file.exists(header_path)) {
        readLines(header_path, warn = FALSE)
      } else {
        character()
      }
      testthat::expect_false(any(grepl("^HTTP/.* 500", headers)))
      completed <- any(grepl("^HTTP/.* 200", headers))
      stopped <- any(grepl("^HTTP/.* 410", headers))
      testthat::expect_true(xor(completed, stopped))
      testthat::expect_true(file.exists(body_path))
      body <- readLines(body_path, warn = FALSE)
      testthat::expect_false(any(grepl("An exception occurred.", body,
                                       fixed = TRUE)))
      payload <- jsonlite::fromJSON(paste(body, collapse = "\n"),
                                    simplifyVector = FALSE)
      if (stopped) {
        testthat::expect_identical(payload$error$code, "session_stopped")
      } else {
        testthat::expect_null(payload$error)
        testthat::expect_identical(length(payload$cells), 1L)
        testthat::expect_identical(payload$cells[[1L]]$body[[1L]], "x <- 1")
        testthat::expect_identical(length(payload$cells[[1L]]$body), 2049L)
        testthat::expect_identical(payload$cells[[1L]]$body[[2049L]], source_line)
      }
      testthat::expect_false(cli_port_open(port))
      cli_expect_closed(port, descendants)
    }
  }
)

testthat::test_that("stop_alder shares idempotence state across copied handles", {
  lib <- alder_cache_lib()
  if (nzchar(lib)) {
    existing <- Sys.getenv("R_LIBS", unset = "")
    withr::local_envvar(R_LIBS = paste(c(lib, existing[nzchar(existing)]),
                                      collapse = .Platform$path.sep))
  }
  port <- httpuv::randomPort()
  server <- start_alder(NULL, port = port, run_on_startup = FALSE)
  copy <- server
  artifact_dir <- server$artifact_dir
  stop_alder(server)
  testthat::expect_true(copy$lifecycle$stopped)
  testthat::expect_true(copy$lifecycle$shutdown_requested)
  testthat::expect_identical(copy$lifecycle$shutdown_reason, "stop_alder")
  testthat::expect_false(dir.exists(artifact_dir))
  testthat::expect_no_error(stop_alder(copy))
  testthat::expect_false(cli_port_open(port))
})
