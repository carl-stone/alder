test_that("layered config precedence and validation are deterministic", {
  root <- tempfile("alder-config-test-")
  dir.create(root)
  path <- file.path(root, "notebook.R")
  writeLines(c("# %%", "x <- 1"), path)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)

  cfg <- alder:::resolve_alder_config(
    path,
    user = list(theme = "dark", autosave = TRUE,
                editor = list(font_size = 12L, completions = FALSE)),
    project = list(
      theme = "light",
      editor = list(tab_size = 4L, signature_help = FALSE)
    ),
    metadata = list(runtime = list(on_cell_change = "lazy"))
  )
  expect_identical(cfg$theme, "light")
  expect_identical(cfg$autosave, TRUE)
  expect_identical(cfg$on_cell_change, "lazy")
  expect_identical(cfg$editor$font_size, 12L)
  expect_identical(cfg$editor$tab_size, 4L)
  expect_false(cfg$editor$completions)
  expect_false(cfg$editor$signature_help)
  expect_false(cfg$editor$live_diagnostics)

  unknown <- tryCatch(
    alder:::resolve_alder_config(path, user = list(unknown_key = TRUE)),
    error = identity
  )
  expect_s3_class(unknown, "alder_error")
  expect_identical(unknown$code, "config_invalid")
  expect_match(conditionMessage(unknown), "unknown_key", fixed = TRUE)

  bad_type <- tryCatch(
    alder:::resolve_alder_config(path, project = list(table = list(page_size = 2L))),
    error = identity
  )
  expect_s3_class(bad_type, "alder_error")
  expect_identical(bad_type$code, "config_invalid")
  expect_match(conditionMessage(bad_type), "page_size", fixed = TRUE)

  bad_editor_flag <- tryCatch(
    alder:::resolve_alder_config(
      path, project = list(editor = list(live_diagnostics = "yes"))
    ),
    error = identity
  )
  expect_s3_class(bad_editor_flag, "alder_error")
  expect_identical(bad_editor_flag$code, "config_invalid")
  expect_match(conditionMessage(bad_editor_flag), "editor.live_diagnostics",
               fixed = TRUE)
})

test_that("Session exposes and persists project config", {
  root <- tempfile("alder-session-config-test-")
  dir.create(root)
  path <- file.path(root, "notebook.R")
  writeLines(c("# %%", "x <- 1"), path)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)

  nb <- alder:::read_notebook(path)
  s <- alder:::Session$new(
    nb, worker = NULL, run_on_startup = FALSE,
    config = alder:::config_defaults()
  )
  on.exit(s$stop(), add = TRUE)
  expect_false(s$state()$config$autosave)
  result <- s$set_config(list(
    autosave = TRUE,
    theme = "dark",
    editor = list(
      completions = FALSE,
      signature_help = FALSE,
      live_diagnostics = FALSE
    )
  ))
  expect_true(result$config$autosave)
  expect_identical(s$state()$config$theme, "dark")
  expect_false(s$state()$config$editor$completions)
  expect_false(s$state()$config$editor$signature_help)
  expect_false(s$state()$config$editor$live_diagnostics)
  expect_true(file.exists(file.path(root, ".alder", "config.yaml")))
  expect_true(alder:::alder_config(path)$autosave)
  persisted <- alder:::alder_config(path)$editor
  expect_false(persisted$completions)
  expect_false(persisted$signature_help)
  expect_false(persisted$live_diagnostics)
})
