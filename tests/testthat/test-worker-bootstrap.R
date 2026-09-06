# Bootstrap compatibility is checked through the real worker transport. The
# retained barrier replay covers the startup regression without adding a
# machine-dependent performance threshold to this file.

bootstrap_eval <- function(worker, code) {
  response <- NULL
  worker$send(
    "eval_cell", id = "bootstrap-cell", code = code,
    revision = 0L, run_id = 1L, defs = list(), locals = list(), opaque = FALSE,
    on_response = function(context, value) response <<- value
  )
  wait_for(NULL, function() !is.null(response), timeout = 15)
  response
}

bootstrap_record <- function(worker, fields) {
  response <- bootstrap_eval(worker, c(
    "local({",
    "  level <- compiler::enableJIT(0L)",
    "  compiler::enableJIT(level)",
    paste0("  record <- list(", paste(fields, collapse = ", "), ")"),
    "  cat(jsonlite::toJSON(record, auto_unbox = TRUE, null = 'null'), '\\n')",
    "  invisible(NULL)",
    "})"
  ))
  expect_true(response$ok, info = response$error$message)
  jsonlite::fromJSON(paste(unlist(response$log, use.names = FALSE),
                          collapse = "\n"))
}

test_that("worker bootstrap handles quoted paths and notebook-relative files", {
  project <- tempfile("alder-worker ' \u00e9-")
  dir.create(project)
  withr::defer(unlink(project, recursive = TRUE))
  writeLines("relative notebook value", file.path(project, "relative.txt"))
  worker <- make_test_worker(env = c(ALDER_NOTEBOOK_DIR = project))
  withr::defer(worker$stop())
  filename <- if (.Platform$OS.type == "windows") {
    "worker ' \u00e9.R"
  } else {
    "worker \" \\ \u00e9.R"
  }
  copied_script <- file.path(project, filename)
  expect_true(file.copy(worker$worker_script, copied_script))
  worker$worker_script <- copied_script
  worker$restart()
  alder:::.wait_for_worker(worker)

  record <- bootstrap_record(worker, c(
    "cwd = normalizePath(getwd())",
    "relative = readLines('relative.txt', warn = FALSE)",
    "args = I(commandArgs(trailingOnly = TRUE))",
    "globals = I(ls(.GlobalEnv, all.names = TRUE))"
  ))
  expect_identical(record$cwd, normalizePath(project))
  expect_identical(record$relative, "relative notebook value")
  expect_length(record$args, 0L)
  expect_length(record$globals, 0L)
  # Inspect a function created by an actual top-level notebook expression.
  response <- bootstrap_eval(worker,
    "identical(environment(function() 1), .GlobalEnv)")
  expect_true(response$ok)
  expect_identical(response$outputs[[1L]]$text, "[1] TRUE")

  failed <- bootstrap_eval(worker, c(
    "local({",
    "  inner_failure <- function() stop('bootstrap nested failure')",
    "  outer_failure <- function() inner_failure()",
    "  outer_failure()",
    "})"
  ))
  expect_false(failed$ok)
  expect_identical(failed$error$message, "bootstrap nested failure")
  expect_true("simpleError" %in% unlist(failed$error$class, use.names = FALSE))
  expect_identical(failed$error$call, "inner_failure()")
  trace <- paste(unlist(failed$error$trace, use.names = FALSE), collapse = "\n")
  expect_match(trace, "outer_failure()", fixed = TRUE)
  expect_match(trace, "inner_failure()", fixed = TRUE)
  recovered <- bootstrap_eval(worker, "7")
  expect_true(recovered$ok)
  expect_identical(recovered$outputs[[1L]]$text, "[1] 7")
})

test_that("worker bootstrap preserves JIT and notebook option changes", {
  fields <- c(
    "jit = level",
    "keep_source = getOption('keep.source')",
    "keep_parse_data = getOption('keep.parse.data')",
    "top_level_null = is.null(getOption('topLevelEnvironment'))",
    "top_level_global = identical(getOption('topLevelEnvironment'), .GlobalEnv)",
    "args = I(commandArgs(trailingOnly = TRUE))",
    "globals = I(ls(.GlobalEnv, all.names = TRUE))"
  )
  check_level <- function(level) {
    worker <- make_test_worker(env = c(R_ENABLE_JIT = as.character(level)))
    withr::defer(worker$stop())
    before <- bootstrap_record(worker, fields)
    expect_identical(before$jit, level)
    expect_false(before$keep_source)
    expect_true(before$keep_parse_data)
    expect_true(before$top_level_null)
    expect_false(before$top_level_global)
    expect_length(before$args, 0L)
    expect_length(before$globals, 0L)

    next_level <- (level + 1L) %% 4L
    changed <- bootstrap_eval(worker, c(
      sprintf("compiler::enableJIT(%dL)", next_level),
      "options(keep.source = TRUE, keep.parse.data = FALSE,",
      "        topLevelEnvironment = .GlobalEnv)",
      "invisible(NULL)"
    ))
    expect_true(changed$ok)
    after <- bootstrap_record(worker, fields)
    expect_identical(after$jit, next_level)
    expect_true(after$keep_source)
    expect_false(after$keep_parse_data)
    expect_false(after$top_level_null)
    expect_true(after$top_level_global)
    expect_length(after$args, 0L)
    expect_length(after$globals, 0L)
  }
  for (level in 0:3) check_level(level)
})

test_that("malformed worker bootstrap reports its parse error and exits", {
  worker <- make_test_worker()
  withr::defer(worker$stop())
  script <- tempfile("alder-malformed-worker-", fileext = ".R")
  withr::defer(unlink(script))
  writeLines("local({", script)
  worker$worker_script <- script
  worker$restart()

  # Readiness can observe process death before the next transport poll, or
  # send() can discover an already-dead process and reply synchronously.
  # Both paths must deliver the tracked request's error exactly once.
  sent <- list()
  callbacks <- list()
  original_send <- worker$send
  if (bindingIsLocked("send", worker)) unlockBinding("send", worker)
  worker$send <- function(cmd, ..., on_response = NULL) {
    req <- original_send(cmd, ..., on_response = function(context, value) {
      callbacks[[length(callbacks) + 1L]] <<- list(
        context = context, response = value
      )
      if (!is.null(on_response)) on_response(context, value)
    })
    sent[[length(sent) + 1L]] <<- list(cmd = cmd, req = req)
    req
  }

  error <- expect_error(alder:::.wait_for_worker(worker), "worker failed to start")
  expect_match(conditionMessage(error), "unexpected end of input", fixed = TRUE)
  expect_false(worker$alive())
  diagnostics <- worker$diagnostics()
  expect_match(diagnostics$stderr, "unexpected end of input", fixed = TRUE)
  expect_true(is.numeric(diagnostics$exit_status))
  expect_true(diagnostics$exit_status != 0L)

  wait_for(NULL, function() length(callbacks) >= 1L)
  expect_length(sent, 1L)
  expect_identical(sent[[1L]]$cmd, "ping")
  expect_length(callbacks, 1L)
  callback <- callbacks[[1L]]
  expect_identical(callback$context$cmd, "ping")
  expect_equal(callback$context$req, sent[[1L]]$req)
  expect_identical(callback$response$cmd, "ping")
  expect_equal(callback$response$req, sent[[1L]]$req)
  expect_false(callback$response$ok)
  expect_true(callback$response$error$transport)
  expect_match(callback$response$error$message,
               "Worker exited before responding", fixed = TRUE)
  expect_length(ls(worker$pending, all.names = TRUE), 0L)
  # A later polling turn cannot deliver the same failure a second time.
  later::run_now(0.05)
  expect_length(callbacks, 1L)
  expect_length(ls(worker$pending, all.names = TRUE), 0L)
})

test_that("late eval interrupts preserve the next parsed worker request", {
  check_next_request <- function(next_cmd) {
    directory <- tempfile("alder-late-interrupt-")
    dir.create(directory)
    withr::defer(unlink(directory, recursive = TRUE))
    marker <- file.path(directory, "entered")
    release <- file.path(directory, "release")
    worker <- make_test_worker(env = c(
      ALDER_TEST_GAP_MARKER = marker, ALDER_TEST_GAP_RELEASE = release
    ))
    withr::defer({
      writeLines("release", release)
      worker$stop()
    })

    # Widen the real post-read parser boundary without replacing its interrupt
    # guards. The preceding eval has emitted both ACK and terminal response
    # before this marker appears; the parent intentionally has read neither.
    # Do not sleep in this worker-side gap: R's nonzero sleep enters a select
    # path that enables interrupts independently of suspendInterrupts().
    source <- paste(readLines(worker$worker_script, warn = FALSE), collapse = "\n")
    anchor <- "      eof_count <- 0L\n      # NUL rejection"
    matches <- gregexpr(anchor, source, fixed = TRUE)[[1L]]
    stopifnot(sum(matches > 0L) == 1L)
    widened <- sub(anchor, paste0(
      "      eof_count <- 0L\n",
      "      if (grepl('\"late_interrupt_probe\":true', line[[1L]], fixed = TRUE)) {\n",
      "        local({\n",
      "          writeLines(as.character(Sys.getpid()), Sys.getenv('ALDER_TEST_GAP_MARKER'))\n",
      "          deadline <- Sys.time() + 10\n",
      "          while (!file.exists(Sys.getenv('ALDER_TEST_GAP_RELEASE'))) {\n",
      "            if (Sys.time() >= deadline) stop('Test gap release timed out')\n",
      "          }\n",
      "        })\n",
      "      }\n",
      "      # NUL rejection"
    ), source, fixed = TRUE)
    script <- file.path(directory, "worker.R")
    writeLines(widened, script, useBytes = TRUE)
    invisible(parse(file = script, keep.source = FALSE))
    worker$worker_script <- script
    worker$restart()
    alder:::.wait_for_worker(worker)
    pid <- worker$proc$get_pid()
    responses <- list()
    failures <- character()
    worker$set_on_failure(function(message) failures <<- c(failures, message))
    receive <- function(label) {
      force(label)
      function(context, response) {
        responses[[label]] <<- c(responses[[label]], list(response))
      }
    }
    read_one <- function(timeout = 5) {
      deadline <- Sys.time() + timeout
      repeat {
        pipes <- processx::poll(list(worker$proc$get_output_connection(),
                                     worker$proc$get_error_connection()), 20)
        if (pipes[[2L]] %in% c("ready", "silent")) {
          worker$record_stderr(worker$proc$read_error_lines(1000L))
        }
        if (pipes[[1L]] %in% c("ready", "silent")) {
          lines <- worker$proc$read_output_lines(1L)
          if (length(lines)) return(lines[[1L]])
        }
        if (!worker$alive() || Sys.time() >= deadline) return(NULL)
      }
    }
    drain <- function() {
      while (length(ls(worker$pending, all.names = TRUE))) {
        line <- read_one()
        if (is.null(line)) break
        worker$handle_line(line)
      }
      if (!worker$alive()) worker$poll_cycle()
    }
    first_text <- function(response) {
      if (!length(response$outputs)) return(NULL)
      response$outputs[[1L]]$text
    }

    # Hold only parent delivery; registration, writes and SIGINT use the real
    # Worker methods. Do not pump later until the controlled gap is released.
    worker$poll_active <- TRUE
    first_req <- worker$send(
      "eval_cell", id = "completed", revision = 0L, run_id = 1L,
      code = list("41L + 1L"), defs = list(), locals = list(),
      on_response = receive("completed")
    )
    next_req <- worker$send(
      next_cmd, id = "queued", revision = 0L, run_id = 2L,
      code = list("42L + 1L"), defs = list(), locals = list(),
      late_interrupt_probe = TRUE, on_response = receive("queued")
    )
    deadline <- Sys.time() + 5
    marker_written <- function() {
      file.exists(marker) && file.info(marker)$size > 0L
    }
    while (!marker_written() && worker$alive() && Sys.time() < deadline) {
      Sys.sleep(0.01)
    }
    stopifnot(marker_written(),
              identical(as.integer(readLines(marker)), pid),
              is.null(worker$executing_req), !length(responses))
    worker$interrupt(first_req)
    ack_line <- read_one()
    stopifnot(!is.null(ack_line))
    ack <- jsonlite::fromJSON(ack_line)
    stopifnot(identical(ack$ack, "started"),
              identical(as.integer(ack$req), first_req))
    worker$handle_line(ack_line)
    expect_identical(worker$interrupt_sent, as.character(first_req))
    worker$proc$wait(200L)
    expect_true(worker$alive(), info = next_cmd)
    writeLines("release", release)
    drain()

    completed <- responses$completed[[1L]]
    expect_true(completed$ok)
    expect_equal(completed$req, first_req)
    expect_identical(first_text(completed), "[1] 42")
    queued <- responses$queued[[1L]]
    expect_true(queued$ok, info = next_cmd)
    expect_identical(queued$cmd, next_cmd)
    expect_equal(queued$req, next_req)
    if (identical(next_cmd, "eval_cell")) {
      expect_identical(first_text(queued), "[1] 43")
    }
    worker$send(
      "eval_cell", id = "fresh", revision = 0L, run_id = 3L,
      code = list("43L + 1L"), defs = list(), locals = list(),
      on_response = receive("fresh")
    )
    drain()
    expect_true(worker$alive())
    expect_identical(worker$proc$get_pid(), pid)
    expect_true(responses$fresh[[1L]]$ok)
    expect_identical(first_text(responses$fresh[[1L]]), "[1] 44")
    expect_identical(unname(vapply(responses, length, 0L)), rep(1L, 3L))
    expect_length(failures, 0L)
    expect_length(ls(worker$pending, all.names = TRUE), 0L)
  }
  for (next_cmd in c("ping", "eval_cell")) check_next_request(next_cmd)
})

test_that("active pure R evaluation remains interruptible inside the worker loop", {
  worker <- make_test_worker()
  withr::defer(worker$stop())
  # Exercise the configured script, including an isolated diagnostic override.
  worker$restart()
  alder:::.wait_for_worker(worker)
  warm <- bootstrap_eval(worker, "1L")
  expect_true(warm$ok)
  pid <- worker$proc$get_pid()
  marker <- tempfile("alder-cpu-entered-")
  withr::defer(unlink(marker))
  callbacks <- list()
  req <- worker$send(
    "eval_cell", id = "cpu-active", revision = 2L, run_id = 7L,
    code = c(
      "local({",
      sprintf("  writeLines('entered', %s)", encodeString(marker, quote = '"')),
      "  deadline <- proc.time()[['elapsed']] + 4",
      "  value <- 0",
      "  repeat {",
      "    value <- (value + 1) %% 1000000",
      "    if (proc.time()[['elapsed']] >= deadline) break",
      "  }",
      "  value",
      "})"
    ), defs = list(), locals = list(),
    on_response = function(context, response) {
      callbacks[[length(callbacks) + 1L]] <<- list(context = context,
                                                 response = response)
    }
  )
  # The marker proves that user evaluation has begun. Its loop performs only
  # arithmetic/time reads: a nonzero sleep would independently enable SIGINT
  # inside R's select implementation and could hide a broken eval guard.
  wait_for(NULL, function() identical(worker$executing_req, as.character(req)) &&
    file.exists(marker) && file.info(marker)$size > 0L)
  started <- Sys.time()
  worker$interrupt(req)
  wait_for(NULL, function() length(callbacks) > 0L)
  elapsed <- as.numeric(difftime(Sys.time(), started, units = "secs"))
  expect_lt(elapsed, 1.5)
  expect_length(callbacks, 1L)
  response <- callbacks[[1L]]$response
  expect_false(response$ok)
  expect_identical(response$error$message, "Interrupted")
  expect_true(response$error$interrupted)
  expect_identical(response$cmd, "eval_cell")
  expect_equal(response$req, req)
  expect_identical(response$id, "cpu-active")
  expect_equal(response$revision, 2L)
  expect_equal(response$run_id, 7L)
  expect_length(response$outputs, 0L)
  expect_true(worker$alive())
  expect_identical(worker$proc$get_pid(), pid)
  recovered <- bootstrap_eval(worker, "6L * 7L")
  expect_true(recovered$ok)
  expect_identical(recovered$outputs[[1L]]$text, "[1] 42")
  expect_identical(worker$proc$get_pid(), pid)
  expect_length(callbacks, 1L)
  expect_length(ls(worker$pending, all.names = TRUE), 0L)
})
