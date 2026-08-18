# Layered notebook configuration.
#
# Configuration is deliberately kept as ordinary R lists so it can travel over
# the existing JSON state/API without an additional object model.  The four
# layers are merged in order: built-ins, the user file, the project file, and
# notebook runtime metadata.

config_defaults <- function() {
  list(
    theme = "system",
    keymap = "default",
    on_cell_change = "automatic",
    on_startup = TRUE,
    autosave = FALSE,
    format = list(on_save = FALSE),
    editor = list(font_size = 14L, tab_size = 2L, line_numbers = TRUE),
    table = list(page_size = 25L),
    cache = list(enabled = TRUE, dir = NULL),
    gallery = list(max_sessions = 4L)
  )
}

config_invalid <- function(key, message) {
  key <- as.character(key %||% "config")
  alder_abort(
    "config_invalid",
    paste0("config_invalid: key `", key, "` ", as.character(message))
  )
}

config_scalar_char <- function(value, key, choices = NULL) {
  if (!is.character(value) || length(value) != 1L || is.na(value) ||
      !nzchar(value)) {
    config_invalid(key, "must be a non-empty string")
  }
  if (!is.null(choices) && !(value %in% choices)) {
    config_invalid(key, paste0("must be one of ", paste(choices, collapse = ", ")))
  }
  value
}

config_scalar_logical <- function(value, key) {
  if (!is.logical(value) || length(value) != 1L || is.na(value)) {
    config_invalid(key, "must be TRUE or FALSE")
  }
  isTRUE(value)
}

config_scalar_integer <- function(value, key, min, max) {
  if (!is.numeric(value) || length(value) != 1L || is.na(value) ||
      !is.finite(value) || value != as.integer(value) ||
      value < min || value > max) {
    config_invalid(key, paste0("must be an integer from ", min, " to ", max))
  }
  as.integer(value)
}

config_unknown_keys <- function(value, allowed, prefix) {
  keys <- names(value)
  if (is.null(keys)) keys <- character()
  bad <- setdiff(keys, allowed)
  if (length(bad)) {
    config_invalid(if (nzchar(prefix)) paste0(prefix, ".", bad[[1L]]) else bad[[1L]],
                   "is not a recognized configuration key")
  }
}

# Validate one mapping.  `partial = TRUE` is used for user/project/API
# overlays, where omitted fields are expected.  The returned values are
# normalized to the same scalar types as the built-in defaults.
validate_config_layer <- function(value, prefix = "", partial = TRUE) {
  if (!is.list(value) || (length(value) && is.null(names(value)))) {
    config_invalid(if (nzchar(prefix)) prefix else "config", "must be a mapping")
  }
  keys <- names(value) %||% character()
  if (anyNA(keys) || any(!nzchar(keys)) || anyDuplicated(keys)) {
    config_invalid(if (nzchar(prefix)) prefix else "config",
                   "must have unique named keys")
  }
  allowed <- c("theme", "keymap", "on_cell_change", "on_startup",
               "autosave", "format", "editor", "table", "cache",
               "gallery")
  if (!nzchar(prefix) || identical(prefix, "runtime")) {
    config_unknown_keys(value, allowed, prefix)
  }

  out <- list()
  if ("theme" %in% keys) {
    out$theme <- config_scalar_char(value$theme, "theme",
                                    c("light", "dark", "system"))
  }
  if ("keymap" %in% keys) {
    out$keymap <- config_scalar_char(value$keymap, "keymap",
                                     c("default", "vim"))
  }
  if ("on_cell_change" %in% keys) {
    out$on_cell_change <- config_scalar_char(
      value$on_cell_change, "on_cell_change", c("automatic", "lazy"))
  }
  if ("on_startup" %in% keys) {
    out$on_startup <- config_scalar_logical(value$on_startup, "on_startup")
  }
  if ("autosave" %in% keys) {
    out$autosave <- config_scalar_logical(value$autosave, "autosave")
  }

  if ("format" %in% keys) {
    x <- value$format
    if (!is.list(x) || (length(x) && is.null(names(x)))) {
      config_invalid("format", "must be a mapping")
    }
    config_unknown_keys(x, "on_save", "format")
    if ("on_save" %in% names(x)) {
      out$format <- list(on_save = config_scalar_logical(x$on_save,
                                                         "format.on_save"))
    } else if (!partial) {
      out$format <- list(on_save = FALSE)
    } else {
      out$format <- list()
    }
  }

  if ("editor" %in% keys) {
    x <- value$editor
    if (!is.list(x) || (length(x) && is.null(names(x)))) {
      config_invalid("editor", "must be a mapping")
    }
    config_unknown_keys(x, c("font_size", "tab_size", "line_numbers"), "editor")
    out$editor <- list()
    if ("font_size" %in% names(x)) {
      out$editor$font_size <- config_scalar_integer(x$font_size,
                                                    "editor.font_size", 10, 32)
    }
    if ("tab_size" %in% names(x)) {
      out$editor$tab_size <- config_scalar_integer(x$tab_size,
                                                   "editor.tab_size", 1, 8)
    }
    if ("line_numbers" %in% names(x)) {
      out$editor$line_numbers <- config_scalar_logical(x$line_numbers,
                                                       "editor.line_numbers")
    }
  }

  if ("table" %in% keys) {
    x <- value$table
    if (!is.list(x) || (length(x) && is.null(names(x)))) {
      config_invalid("table", "must be a mapping")
    }
    config_unknown_keys(x, "page_size", "table")
    out$table <- list()
    if ("page_size" %in% names(x)) {
      out$table$page_size <- config_scalar_integer(x$page_size,
                                                   "table.page_size", 5, 200)
    }
  }

  if ("cache" %in% keys) {
    x <- value$cache
    if (!is.list(x) || (length(x) && is.null(names(x)))) {
      config_invalid("cache", "must be a mapping")
    }
    config_unknown_keys(x, c("enabled", "dir"), "cache")
    out$cache <- list()
    if ("enabled" %in% names(x)) {
      out$cache$enabled <- config_scalar_logical(x$enabled, "cache.enabled")
    }
    if ("dir" %in% names(x)) {
      dir <- x$dir
      if (is.null(dir)) {
        out$cache$dir <- NULL
      } else {
        out$cache$dir <- config_scalar_char(dir, "cache.dir")
      }
    }
  }

  if ("gallery" %in% keys) {
    x <- value$gallery
    if (!is.list(x) || (length(x) && is.null(names(x)))) {
      config_invalid("gallery", "must be a mapping")
    }
    config_unknown_keys(x, "max_sessions", "gallery")
    out$gallery <- list()
    if ("max_sessions" %in% names(x)) {
      out$gallery$max_sessions <- config_scalar_integer(x$max_sessions,
                                                        "gallery.max_sessions", 1, 32)
    }
  }

  # Keep a complete mapping's shape stable when used for final validation.
  if (!partial) {
    defaults <- config_defaults()
    out <- merge_config(defaults, out)
  }
  out
}

merge_config <- function(base, overlay) {
  if (!length(overlay)) return(base)
  for (key in names(overlay)) {
    value <- overlay[[key]]
    if (is.list(value) && is.list(base[[key]]) && !is.null(value)) {
      base[[key]] <- merge_config(base[[key]], value)
    } else {
      # `base[key] <- list(value)` preserves a named NULL (cache.dir).
      base[key] <- list(value)
    }
  }
  base
}

config_project_dir <- function(path) {
  if (is.null(path) || !length(path) || is.na(path) || !nzchar(path)) return(NULL)
  if (dir.exists(path)) normalizePath(path, mustWork = TRUE) else dirname(path)
}

config_project_file <- function(path) {
  dir <- config_project_dir(path)
  if (is.null(dir)) NULL else file.path(dir, ".alder", "config.yaml")
}

read_config_file <- function(path) {
  if (is.null(path) || !file.exists(path)) return(list())
  if (dir.exists(path) || file.access(path, 4) != 0L) {
    alder_abort("config_invalid",
                paste0("config_invalid: cannot read configuration file `", path, "`"))
  }
  value <- tryCatch(
    withCallingHandlers(yaml::yaml.load_file(path, eval.expr = FALSE),
                         warning = function(w) stop(conditionMessage(w), call. = FALSE)),
    error = function(e) {
      alder_abort("config_invalid",
                  paste0("config_invalid: malformed configuration file `", path,
                         "`: ", conditionMessage(e)))
    }
  )
  if (is.null(value)) return(list())
  validate_config_layer(value, partial = TRUE)
}

runtime_config_layer <- function(metadata) {
  if (is.null(metadata)) return(list())
  runtime <- metadata$runtime %||% list()
  if (is.null(runtime)) return(list())
  if (!is.list(runtime) || (length(runtime) && is.null(names(runtime)))) {
    config_invalid("runtime", "must be a mapping")
  }
  # Older notebooks use execution_mode/run_on_startup.  They are aliases for
  # the canonical config names and remain accepted for byte-compatible reloads.
  if ("execution_mode" %in% names(runtime) &&
      !"on_cell_change" %in% names(runtime)) {
    runtime$on_cell_change <- runtime$execution_mode
  }
  if ("run_on_startup" %in% names(runtime) &&
      !"on_startup" %in% names(runtime)) {
    runtime$on_startup <- runtime$run_on_startup
  }
  runtime$execution_mode <- NULL
  runtime$run_on_startup <- NULL
  validate_config_layer(runtime, prefix = "runtime", partial = TRUE)
}

resolve_alder_config <- function(path = NULL, metadata = NULL,
                                 project = NULL, user = NULL) {
  if (is.null(metadata) && !is.null(path) && file.exists(path) && !dir.exists(path)) {
    metadata <- tryCatch(read_notebook(path)$metadata, error = function(e) NULL)
  }
  user_file <- file.path(tools::R_user_dir("alder", "config"), "config.yaml")
  if (is.null(user)) user <- read_config_file(user_file)
  if (is.null(project)) project <- read_config_file(config_project_file(path))
  runtime <- runtime_config_layer(metadata)
  config <- config_defaults()
  config <- merge_config(config, user)
  config <- merge_config(config, project)
  config <- merge_config(config, runtime)
  validate_config_layer(config, partial = FALSE)
}

#' Resolve alder's layered configuration.
#'
#' @param path Optional notebook path.  When supplied, project configuration
#'   and notebook runtime metadata are included in the result.
#' @export
alder_config <- function(path = NULL) {
  if (!is.null(path) && (!is.character(path) || length(path) != 1L ||
                         is.na(path) || !nzchar(path))) {
    config_invalid("path", "must be NULL or a non-empty string")
  }
  resolve_alder_config(path)
}

write_project_config <- function(path, project) {
  file <- config_project_file(path)
  if (is.null(file)) {
    alder_abort("notebook_has_no_path", "configuration requires a notebook path")
  }
  dir <- dirname(file)
  if (!dir.exists(dir) && !dir.create(dir, recursive = TRUE, showWarnings = FALSE) &&
      !dir.exists(dir)) {
    alder_abort("config_invalid", paste0("config_invalid: cannot create `", dir, "`"))
  }
  text <- yaml::as.yaml(project)
  tmp <- tempfile("alder-config-", tmpdir = dir)
  on.exit(unlink(tmp, force = TRUE), add = TRUE)
  writeBin(charToRaw(text), tmp)
  if (!file.rename(tmp, file)) {
    # file.rename can fail across mounts; both paths are in the same directory,
    # but retain a deterministic fallback for unusual filesystems.
    ok <- file.copy(tmp, file, overwrite = TRUE)
    if (!ok) alder_abort("config_invalid", paste0("cannot write `", file, "`"))
    unlink(tmp, force = TRUE)
  }
  invisible(file)
}
