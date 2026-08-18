test_that("layered config precedence and validation are deterministic", {
  root <- tempfile("alder-config-test-")
  dir.create(root)
  path <- file.path(root, "notebook.R")
  writeLines(c("# %%", "x <- 1"), path)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)

  cfg <- alder:::resolve_alder_config(
    path,
    user = list(theme = "dark", autosave = TRUE,
                editor = list(font_size = 12L)),
    project = list(theme = "light", editor = list(tab_size = 4L)),
    metadata = list(runtime = list(on_cell_change = "lazy"))
  )
  expect_identical(cfg$theme, "light")
  expect_identical(cfg$autosave, TRUE)
  expect_identical(cfg$on_cell_change, "lazy")
  expect_identical(cfg$editor$font_size, 12L)
  expect_identical(cfg$editor$tab_size, 4L)

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
  result <- s$set_config(list(autosave = TRUE, theme = "dark"))
  expect_true(result$config$autosave)
  expect_identical(s$state()$config$theme, "dark")
  expect_true(file.exists(file.path(root, ".alder", "config.yaml")))
  expect_true(alder:::alder_config(path)$autosave)
})
