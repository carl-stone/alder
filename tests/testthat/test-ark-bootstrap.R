ark_bootstrap_cell <- function(session, id) {
  cells <- session$state()$cells
  matches <- which(vapply(cells, function(cell) identical(cell$id, id), FALSE))
  cells[[matches[[1L]]]]
}

with_ark_bootstrap_notebook <- function(path, env = character(), check) {
  skip_if_not(identical(Sys.getenv("ALDER_TEST_HOST"), "1"))
  server <- withr::with_envvar(env, start_alder(
    path,
    port = httpuv::randomPort(),
    execution_mode = "lazy",
    run_on_startup = FALSE
  ))
  on.exit(stop_alder(server), add = TRUE)
  check(server$session, server$host_process)
}

test_that("Ark starts in the notebook directory without polluting user state", {
  project <- tempfile("alder-host ' \u00e9-")
  dir.create(project)
  withr::defer(unlink(project, recursive = TRUE, force = TRUE))
  writeLines("relative notebook value", file.path(project, "relative.txt"))
  filename <- if (.Platform$OS.type == "windows") {
    "notebook ' \u00e9.R"
  } else {
    "notebook \" \\ \u00e9.R"
  }
  path <- file.path(project, filename)
  writeLines(c(
    "# %%", "local({",
    "  record <- list(",
    "    cwd = normalizePath(getwd()),",
    "    relative = readLines('relative.txt', warn = FALSE),",
    "    args = I(commandArgs(trailingOnly = TRUE)),",
    "    globals = I(ls(.GlobalEnv, all.names = TRUE)))",
    "  cat(jsonlite::toJSON(record, auto_unbox = TRUE, null = 'null'), '\\n')",
    "})",
    "# %%", "identical(environment(function() 1), .GlobalEnv)",
    "# %%", "local({",
    "  inner_failure <- function() stop('bootstrap nested failure')",
    "  outer_failure <- function() inner_failure()",
    "  outer_failure()",
    "})"
  ), path, useBytes = TRUE)

  with_ark_bootstrap_notebook(path, check = function(session, boot) {
    run <- session$run_all()
    expect_identical(session$await_operation(run$run_id)$status, "done")

    record <- jsonlite::fromJSON(paste(
      ark_bootstrap_cell(session, "cell-1")$log,
      collapse = "\n"
    ))
    expect_identical(record$cwd, normalizePath(project))
    expect_identical(record$relative, "relative notebook value")
    expect_length(record$args, 0L)
    expect_length(record$globals, 0L)
    expect_identical(
      ark_bootstrap_cell(session, "cell-2")$outputs[[1L]]$text,
      "[1] TRUE"
    )

    failure <- ark_bootstrap_cell(session, "cell-3")
    expect_identical(failure$status, "error")
    expect_identical(failure$error$message, "bootstrap nested failure")
    expect_true("simpleError" %in% unlist(failure$error$class, use.names = FALSE))
    expect_identical(failure$error$call, "inner_failure()")
    trace <- paste(unlist(failure$error$trace, use.names = FALSE), collapse = "\n")
    expect_match(trace, "outer_failure()", fixed = TRUE)
    expect_match(trace, "inner_failure()", fixed = TRUE)
    session$set_cell("cell-3", "7", "code", failure$revision)
    wait_for(session, function()
      !isTRUE(session$state()$runtime$analysisPending), timeout = 10)
    expect_identical(
      session$await_operation(session$run_cell("cell-3")$run_id)$status,
      "done"
    )
    expect_identical(
      ark_bootstrap_cell(session, "cell-3")$outputs[[1L]]$text,
      "[1] 7"
    )
    expect_true(session$state()$runtime$kernelAvailable)
    expect_true(boot$process$is_alive())
  })
})

test_that("Ark preserves requested JIT and notebook option changes", {
  check_level <- function(level) {
    next_level <- (level + 1L) %% 4L
    m <- make_test_session(c(
      "# %%", "local({",
      "  level <- compiler::enableJIT(0L)",
      "  compiler::enableJIT(level)",
      "  record <- list(",
      "    jit = level,",
      "    keep_source = getOption('keep.source'),",
      "    keep_parse_data = getOption('keep.parse.data'),",
      "    args = I(commandArgs(trailingOnly = TRUE)),",
      "    globals = I(ls(.GlobalEnv, all.names = TRUE)))",
      sprintf("  next_level <- %dL", next_level),
      "  expected <- list(",
      "    jit = next_level,",
      "    keep_source = !isTRUE(record$keep_source),",
      "    keep_parse_data = !isTRUE(record$keep_parse_data))",
      paste0("  cat(jsonlite::toJSON(list(record = record, expected = expected), ",
             "auto_unbox = TRUE, null = 'null'), '\\n')"),
      "  compiler::enableJIT(next_level)",
      "  options(keep.source = expected$keep_source,",
      "          keep.parse.data = expected$keep_parse_data,",
      "          topLevelEnvironment = .GlobalEnv)",
      "})",
      "# %%", "local({",
      "  level <- compiler::enableJIT(0L)",
      "  compiler::enableJIT(level)",
      "  record <- list(",
      "    jit = level,",
      "    keep_source = getOption('keep.source'),",
      "    keep_parse_data = getOption('keep.parse.data'),",
      "    top_level_global = identical(getOption('topLevelEnvironment'), .GlobalEnv),",
      "    args = I(commandArgs(trailingOnly = TRUE)),",
      "    globals = I(ls(.GlobalEnv, all.names = TRUE)))",
      "  cat(jsonlite::toJSON(record, auto_unbox = TRUE, null = 'null'), '\\n')",
      "})"
    ), execution_mode = "lazy", runtime_env = c(
      R_ENABLE_JIT = as.character(level)
    ))
    withr::defer(m$close())
    session <- m$session
    expect_identical(session$await_operation(session$run_all()$run_id)$status,
                     "done")
    before <- jsonlite::fromJSON(paste(
      ark_bootstrap_cell(session, "cell-1")$log,
      collapse = "\n"
    ))
    after <- jsonlite::fromJSON(paste(
      ark_bootstrap_cell(session, "cell-2")$log,
      collapse = "\n"
    ))
    expect_identical(before$record$jit, level)
    expect_identical(after$jit, before$expected$jit)
    expect_identical(after$keep_source, before$expected$keep_source)
    expect_identical(after$keep_parse_data, before$expected$keep_parse_data)
    expect_true(after$top_level_global)
    expect_length(before$record$args, 0L)
    expect_length(before$record$globals, 0L)
    expect_length(after$args, 0L)
    expect_length(after$globals, 0L)
  }
  for (level in 0:3) check_level(level)
})
