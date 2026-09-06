# Explicit external publishing engines.
#
# The two paths intentionally have different execution contracts:
# - Quarto renders generated qmd with `engine: knitr` and executes its R cells.
# - Pandoc receives static Markdown whose outputs were evaluated once by Alder.
#
# Keeping these contracts separate makes it possible to diagnose which engine
# ran and prevents a nominal "Pandoc" export from executing R a second time.

alder_render_tool <- function(engine) {
  option <- getOption(paste0("alder.", engine, "_path"), NULL)
  path <- if (is.null(option)) Sys.which(engine) else option
  if (!is.character(path) || length(path) != 1L || is.na(path) ||
      !nzchar(path) || !file.exists(path)) {
    alder_abort(
      "render_tool_unavailable",
      paste0(engine, " executable is unavailable; install ", engine,
             " or set option(alder.", engine, "_path = '/path/to/", engine, "')")
    )
  }
  normalizePath(path, mustWork = TRUE)
}

alder_render_strip_ansi <- function(text) {
  gsub("\033\\[[0-?]*[ -/]*[@-~]", "", text, perl = TRUE)
}

alder_render_dedupe_condition_blocks <- function(text) {
  if (!is.character(text) || length(text) != 1L || !nzchar(text)) return(text)
  lines <- strsplit(text, "\n", fixed = TRUE)[[1L]]
  boundary <- "^~{20,}[[:space:]]*$"
  output <- character()
  index <- 1L
  while (index <= length(lines)) {
    if (!grepl(boundary, lines[[index]])) {
      output <- c(output, lines[[index]])
      index <- index + 1L
      next
    }
    if (index >= length(lines)) {
      output <- c(output, lines[[index]])
      break
    }
    candidates <- seq.int(index + 1L, length(lines))
    candidates <- candidates[grepl(boundary, lines[candidates])]
    if (!length(candidates)) {
      output <- c(output, lines[[index]])
      index <- index + 1L
      next
    }
    closing <- candidates[[1L]]
    block <- trimws(lines[index:closing])
    content <- if (length(block) > 2L) {
      block[seq.int(2L, length(block) - 1L)]
    } else {
      character()
    }
    condition_class <- grepl("^<error(?:/[^>]+)?>$", content, perl = TRUE)
    error_line <- which(content == "Error:")
    bang_line <- if (length(error_line) && error_line[[1L]] < length(content)) {
      error_line[[1L]] + 1L
    } else {
      NA_integer_
    }
    allowed <- !nzchar(content) | condition_class | content == "Error:" |
      startsWith(content, "!")
    simple_error <- any(condition_class) && length(error_line) &&
      !is.na(bang_line) && startsWith(content[[bang_line]], "!") &&
      all(allowed)
    signature <- if (simple_error) {
      paste("Error:", content[[bang_line]], sep = "\n")
    } else {
      ""
    }
    prior <- paste(trimws(output), collapse = "\n")
    if (nzchar(signature) && grepl(signature, prior, fixed = TRUE)) {
      index <- closing + 1L
      next
    }
    output <- c(output, lines[index:closing])
    index <- closing + 1L
  }
  paste(output, collapse = "\n")
}

alder_render_run <- function(engine, command, args, wd, timeout) {
  render_env <- NULL
  if (identical(engine, "quarto")) {
    package_path <- getNamespaceInfo(asNamespace("alder"), "path")
    installed_library <- if (file.exists(file.path(package_path, "Meta", "package.rds"))) {
      dirname(package_path)
    } else character()
    inherited <- strsplit(Sys.getenv("R_LIBS", ""), .Platform$path.sep,
                          fixed = TRUE)[[1L]]
    libraries <- unique(c(installed_library, inherited[nzchar(inherited)], .libPaths()))
    render_env <- c(QUARTO_R = file.path(R.home("bin"), "Rscript"),
                    R_LIBS = paste(libraries, collapse = .Platform$path.sep),
                    Sys.getenv())
    render_env <- render_env[!duplicated(names(render_env))]
  }
  result <- tryCatch(
    processx::run(
      command, args = args, wd = wd, error_on_status = FALSE,
      echo = FALSE, timeout = timeout,
      env = render_env
    ),
    error = function(error) {
      alder_abort("render_failed", paste0(engine, " failed: ",
                                            conditionMessage(error)))
    }
  )
  stdout <- enc2utf8(result$stdout %||% "")
  stderr <- enc2utf8(result$stderr %||% "")
  # External-engine diagnostics are always relayed without terminal control
  # codes. The raw streams remain attached to a successful return value, so
  # noninteractive callers can still retain the exact subprocess transcript.
  visible_stdout <- alder_render_strip_ansi(stdout)
  visible_stderr <- alder_render_strip_ansi(stderr)
  if (!identical(as.integer(result$status), 0L)) {
    streams <- c(visible_stdout, visible_stderr)
    detail <- alder_render_dedupe_condition_blocks(
      paste(streams[nzchar(streams)], collapse = "\n")
    )
    alder_abort(
      "render_failed",
      paste0(engine, " exited with status ", as.integer(result$status),
             if (nzchar(detail)) paste0(":\n", detail) else "")
    )
  }
  if (nzchar(trimws(visible_stdout))) message(trimws(visible_stdout))
  if (nzchar(trimws(visible_stderr))) message(trimws(visible_stderr))
  list(stdout = stdout, stderr = stderr, status = as.integer(result$status))
}

alder_render_front_matter <- function(metadata, format, css) {
  quote_yaml <- function(value) as.character(jsonlite::toJSON(
    as.character(value), auto_unbox = TRUE
  ))
  # yaml::as.yaml emits YAML-1.1 `yes`/`no` booleans, which Quarto correctly
  # rejects under YAML 1.2. Emit this small schema directly with JSON-quoted
  # strings and canonical true/false scalars.
  c(
    "---",
    paste0("title: ", quote_yaml(metadata$title %||% "Alder notebook")),
    "format:", paste0("  ", format, ":"),
    "    embed-resources: true",
    "    code-overflow: wrap",
    paste0("    css: ", quote_yaml(normalizePath(css, mustWork = TRUE))),
    "engine: knitr",
    "df-print: kable",
    "execute:",
    "  warning: true",
    "  error: false",
    "  message: true",
    "---", ""
  )
}

# Called only inside Quarto's R process. Native values composed inside Alder
# layouts pass through knitr's normal renderer in a private child environment;
# this prints the already-created value without re-evaluating notebook code.
alder_knitr_setup <- function(files_dir) {
  dir.create(files_dir, recursive = TRUE, showWarnings = FALSE)
  RUNTIME$artifact_dir <- tempfile("alder-quarto-artifacts-")
  dir.create(RUNTIME$artifact_dir)
  RUNTIME$cell_id <- function() knitr::opts_current$get("alder_cell")
  print_output <- function(x, options = NULL, ...) {
    alt <- paste0("Plot generated by R in cell ",
                  knitr::opts_current$get("label") %||% "unnamed")
    markdown <- export_output_markdown(
      x, RUNTIME$artifact_dir, files_dir,
      files_dir_name = files_dir, alt_fallback = alt
    )
    knitr::asis_output(paste(markdown, collapse = "\n"))
  }
  emitted <- new.env(parent = emptyenv())
  progress_records <- new.env(parent = emptyenv())
  emit_sequence <- 0L
  prefix <- paste0("ALDER_KNIT_", basename(tempfile()), "_")
  output_hook <- knitr::knit_hooks$get("output")
  knitr::knit_hooks$set(output = function(output, options) {
    if (!any(grepl(prefix, output, fixed = TRUE))) return(output_hook(output, options))
    lines <- strsplit(paste(output, collapse = "\n"), "\n", fixed = TRUE)[[1L]]
    pending <- character()
    result <- character()
    flush <- function() {
      if (length(pending) && any(nzchar(trimws(pending)))) {
        result <<- c(result, output_hook(paste0(paste(pending, collapse = "\n"), "\n"), options))
      }
      pending <<- character()
    }
    for (line in lines) {
      token <- trimws(line)
      comment <- export_scalar_chr(options$comment, "")
      if (nzchar(comment) && startsWith(token, comment)) {
        token <- trimws(substring(token, nchar(comment) + 1L))
      }
      if (startsWith(token, prefix) && exists(token, envir = emitted, inherits = FALSE)) {
        flush()
        result <- c(result, emitted[[token]])
      } else pending <- c(pending, line)
    }
    flush()
    paste(result, collapse = "\n\n")
  })
  RUNTIME$emit <- function(type, payload) {
    output <- if (identical(type, "append")) payload$output else payload$progress
    if (is.null(output)) return(invisible(NULL))
    emit_sequence <<- emit_sequence + 1L
    token <- paste0(prefix, emit_sequence)
    if (identical(type, "progress")) {
      cell <- RUNTIME$cell_id() %||% "unnamed"
      previous <- get0(cell, envir = progress_records, inherits = FALSE)
      if (!is.null(previous)) emitted[[previous]] <- ""
      assign(cell, token, envir = progress_records)
    }
    emitted[[token]] <- paste0("\n\n", as.character(print_output(output)), "\n\n")
    cat("\n", token, "\n", sep = "")
    invisible(NULL)
  }
  registerS3method("knit_print", "alder_output", print_output,
                   envir = asNamespace("knitr"))
  registerS3method("knit_print", "alder_widget", function(x, ...) {
    print_output(output_widget(x))
  }, envir = asNamespace("knitr"))
  sequence <- 0L
  RUNTIME$render <- function(value) {
    sequence <<- sequence + 1L
    label <- paste0("alder-native-", sequence)
    alt <- paste0("Plot generated by R in cell ",
                  knitr::opts_current$get("label") %||% "unnamed")
    environment <- list2env(list(.alder_value = value),
                            parent = knitr::knit_global())
    markdown <- knitr::knit_child(
      text = c("```{r}", paste0("#| label: ", label),
               paste0("#| fig-alt: ", encodeString(alt, quote = '"')),
               ".alder_value", "```"),
      envir = environment, quiet = TRUE,
      options = list(echo = FALSE, include = TRUE, error = FALSE,
                     warning = TRUE, message = TRUE, alder_cell = NULL,
                     alder_present = FALSE)
    )
    new_output("markdown", text = paste(markdown, collapse = "\n"), html = "")
  }
  invisible(NULL)
}

alder_render_qmd <- function(nb, out, format, include_code, css) {
  graph <- export_source_graph_or_stop(nb)
  literal <- function(text) encodeString(text, quote = '"')
  lines <- alder_render_front_matter(nb$metadata %||% list(), format, css)
  # evaluate::evaluate stops immediately when knitr's error option is false.
  # Its prior message/warning results therefore never reach ordinary output
  # hooks. Calling handlers run when each condition is signalled, so teeing
  # the otherwise-lost messages and warnings to stderr preserves their order.
  # Errors stay with Quarto's native fatal reporter so each condition appears
  # exactly once and the render still exits nonzero.
  lines <- c(
    lines,
    "```{r}",
    "#| include: false",
    paste0("alder:::alder_knitr_setup(", literal(paste0(
      tools::file_path_sans_ext(out), "_files/alder")), ")"),
    "knitr::opts_chunk$set(calling.handlers = list(",
    "  message = function(condition) {",
    "    text <- sub(\"[\\r\\n]+$\", \"\", conditionMessage(condition))",
    "    cat(text, \"\\n\", sep = \"\", file = stderr())",
    "    flush(stderr())",
    "  },",
    "  warning = function(condition) {",
    "    text <- sub(\"[\\r\\n]+$\", \"\", conditionMessage(condition))",
    "    cat(\"Warning: \", text, \"\\n\", sep = \"\", file = stderr())",
    "    flush(stderr())",
    "  }",
    "))",
    "base::local({",
    "  state <- base::new.env(parent = base::baseenv())",
    "  state$outputs <- list()",
    "  state$hook <- knitr::knit_hooks$get(\"chunk\")",
    "  knitr::opts_knit$set(alder.render = state)",
    "  knitr::knit_hooks$set(chunk = function(output, options) {",
    "    if (base::isTRUE(options$alder_present)) return(output)",
    "    rendered <- state$hook(output, options)",
    "    id <- options$alder_cell",
    "    if (base::is.null(id)) return(rendered)",
    "    state$outputs[[id]] <- rendered",
    "    \"\"",
    "  })",
    "})",
    "```",
    ""
  )
  # Let Quarto/knitr execute real chunks in the same order as Alder. The
  # native chunk hook renders each result exactly once into private storage;
  # a final as-is chunk restores authored presentation order. Keeping the
  # storage in a hook closure avoids introducing names into notebook state.
  for (id in graph$topo) {
    cell <- nb_cell(nb, id)
    if (identical(cell$type, "markdown")) next
    lines <- c(lines, "```{r}", paste0("#| alder_cell: ", literal(id)))
    name <- cell$options$name %||% NULL
    if (!is.null(name)) lines <- c(lines, paste0("#| label: ", name))
    if (!isTRUE(include_code) || isTRUE(cell$options$hide_code)) {
      lines <- c(lines, "#| echo: false")
    }
    if (id %in% graph$blocked) lines <- c(lines, "#| eval: false")
    label <- name %||% cell$id %||% "unnamed"
    plot_alt <- paste0("Plot generated by R in cell ", label)
    lines <- c(lines, paste0(
      "#| fig-alt: ",
      as.character(jsonlite::toJSON(plot_alt, auto_unbox = TRUE))
    ))
    # Alder never asks knitr to hide conditions: warnings and messages remain
    # visible and an error stops the render with Quarto's full diagnostics.
    lines <- c(lines, "#| warning: true", "#| message: true",
               cell$body %||% character(), "```", "")
  }
  lines <- c(lines,
             "```{r}", "#| echo: false", "#| results: asis",
             "#| alder_present: true", "base::local({",
             "  state <- knitr::opts_knit$get(\"alder.render\")")
  for (cell in nb$cells %||% list()) {
    expression <- if (identical(cell$type, "markdown")) {
      literal(paste(export_markdown_body(cell$body %||% character()),
                    collapse = "\n"))
    } else {
      paste0("state$outputs[[", literal(cell$id), "]]")
    }
    lines <- c(lines, paste0("  base::cat(", expression, ", \"\\n\\n\", sep = \"\")"))
  }
  lines <- c(lines, "})", "```", "")
  writeLines(lines, out, useBytes = TRUE)
  invisible(out)
}

alder_render_static_markdown <- function(state, artifact_dir, out,
                                         include_code) {
  files_dir <- file.path(
    dirname(out), paste0(tools::file_path_sans_ext(basename(out)), "_files")
  )
  lines <- character()
  for (cell in state$cells %||% list()) {
    if (identical(cell$status, "error")) {
      detail <- paste(cell$log %||% character(), collapse = "\n")
      alder_abort(
        "render_failed",
        paste0("Alder execution failed in ", cell$id,
               if (nzchar(detail)) paste0(":\n", detail) else "")
      )
    }
    if (identical(cell$type, "markdown")) {
      lines <- c(lines, export_markdown_body(cell$body %||% character()), "")
      # Session output contains the same Markdown a second time. The source is
      # the canonical document representation for the direct-Pandoc path.
      next
    } else if (isTRUE(include_code)) {
      lines <- c(lines, "```r", cell$body %||% character(), "```", "")
    }
    alt <- paste0("Plot generated by R in cell ", cell$id)
    for (output in export_cell_transcript(cell)) {
      lines <- c(lines,
                 export_output_markdown(
                   output, artifact_dir, files_dir, alt_fallback = alt
                 ), "")
    }
  }
  writeLines(lines, out, useBytes = TRUE)
  invisible(list(markdown = out, files = files_dir))
}

alder_render_provenance <- function(path, engine) {
  lines <- readLines(path, warn = FALSE, encoding = "UTF-8")
  index <- grep("<head(?:[ >])", lines, ignore.case = TRUE, perl = TRUE)
  meta <- paste0('<meta name="alder-render-engine" content="', engine, '">')
  if (length(index)) {
    i <- index[[1L]]
    lines[[i]] <- sub("<head([^>]*)>", paste0("<head\\1>", meta),
                      lines[[i]], ignore.case = TRUE, perl = TRUE)
  } else {
    lines <- c(meta, lines)
  }
  writeLines(lines, path, useBytes = TRUE)
  invisible(path)
}

alder_render_replace <- function(from, to) {
  if (!file.exists(from) || dir.exists(from)) {
    alder_abort("render_failed", "render engine did not create its output file")
  }
  tryCatch(
    fs::file_move(from, to),
    error = function(error) alder_abort(
      "render_failed",
      paste0("could not atomically replace `", to, "`: ", conditionMessage(error))
    )
  )
  invisible(to)
}

#' Render an Alder notebook with Quarto/knitr or direct Pandoc
#'
#' Blocking syntax, duplicate-definition, dependency-cycle, and dynamic
#' analysis diagnostics are reported before execution or destination change.
#' The output must not identify the input notebook, including through a
#' symlink or hard link.
#' `engine = "quarto"` creates a temporary qmd document with an explicit
#' knitr engine and lets Quarto execute the R cells once in dependency order,
#' while presenting the resulting chunks in notebook order. Disabled cells
#' and their transitive descendants do not execute in either engine.
#' Alder Markdown and layouts retain their content, composed native values
#' use the engine's scientific renderers, and Alder input widget values are static
#' snapshots. Tabs and accordions show all sections, progress shows its final
#' state, and unresolved lazy outputs retain their label without evaluation.
#' Console output, conditions, and appended results retain execution order.
#' `engine = "pandoc"`
#' executes the reactive notebook once through Alder, creates static Markdown
#' containing its visible conditions and outputs, and invokes Pandoc directly;
#' Pandoc never executes R code.
#'
#' @param path Path to an Alder `.R` notebook.
#' @param engine Either `"quarto"` or `"pandoc"`.
#' @param format Output format. HTML is currently supported by both engines.
#' @param out Optional output file. Defaults beside the notebook.
#' @param include_code Include source code in the rendered report.
#' @param timeout Maximum external-render time in milliseconds.
#' @return The normalized output path invisibly, with engine and command-output
#'   attributes for provenance.
#' @examples
#' \dontrun{
#' alder_render("analysis.R", engine = "quarto")
#' alder_render("analysis.R", engine = "pandoc")
#' }
#' @export
alder_render <- function(path, engine = c("quarto", "pandoc"),
                         format = "html", out = NULL,
                         include_code = TRUE, timeout = 300000L) {
  engine <- match.arg(engine)
  if (!is.character(format) || length(format) != 1L || is.na(format) ||
      !identical(format, "html")) {
    alder_abort("render_failed", "format must currently be `html`")
  }
  if (!is.character(path) || length(path) != 1L || is.na(path) ||
      !nzchar(path) || !file.exists(path) || dir.exists(path)) {
    alder_abort("render_failed", paste0("notebook file not found: ", path))
  }
  if (!is.logical(include_code) || length(include_code) != 1L ||
      is.na(include_code)) {
    alder_abort("render_failed", "include_code must be TRUE or FALSE")
  }
  if (!is.numeric(timeout) || length(timeout) != 1L || is.na(timeout) ||
      !is.finite(timeout) || timeout <= 0) {
    alder_abort("render_failed", "timeout must be a positive number")
  }
  path <- normalizePath(path, mustWork = TRUE)
  if (is.null(out)) {
    stem <- tools::file_path_sans_ext(basename(path))
    out <- file.path(dirname(path), paste0(stem, "-", engine, ".html"))
  }
  if (!is.character(out) || length(out) != 1L || is.na(out) || !nzchar(out) ||
      dir.exists(out) || !dir.exists(dirname(out))) {
    alder_abort("render_failed", "out must be a file in an existing directory")
  }
  out <- normalizePath(out, mustWork = FALSE)
  if (alder_same_file(path, out)) {
    alder_abort("render_failed", "render output must not overwrite the notebook")
  }

  nb <- tryCatch(read_notebook(path), error = function(error) {
    alder_abort("render_failed", conditionMessage(error))
  })
  # Validate before any headless execution, temporary render files, or
  # destination replacement.  Session startup deliberately records a
  # graph_invalid action for interactive repair; publishing must surface the
  # complete actionable diagnostic instead of serializing an idle state.
  tryCatch(export_source_graph_or_stop(nb), error = function(error) {
    alder_abort("render_failed", conditionMessage(error),
                messages = error$messages %||% NULL)
  })
  command <- alder_render_tool(engine)
  css <- system.file("publishing", "alder.css", package = "alder",
                     mustWork = TRUE)
  # Quarto requires --output to be a bare filename and writes it beside the
  # input document. Pandoc accepts an absolute output path. Both are moved to
  # the requested destination only after a successful render.
  temporary_output <- tempfile(
    pattern = paste0("alder-", engine, "-"),
    tmpdir = if (identical(engine, "quarto")) dirname(path) else dirname(out),
    fileext = ".html"
  )
  on.exit(unlink(temporary_output, recursive = TRUE, force = TRUE), add = TRUE)
  transcript <- NULL

  if (identical(engine, "quarto")) {
    qmd <- tempfile(pattern = ".alder-quarto-", tmpdir = dirname(path),
                    fileext = ".qmd")
    on.exit(unlink(c(qmd, paste0(tools::file_path_sans_ext(qmd), "_files")),
                    recursive = TRUE, force = TRUE), add = TRUE)
    alder_render_qmd(nb, qmd, format, include_code, css)
    transcript <- alder_render_run(
      engine, command,
      c("render", qmd, "--to", format, "--execute",
        "--execute-dir", dirname(path), "--output", basename(temporary_output)),
      wd = dirname(path), timeout = timeout
    )
  } else {
    boot <- tryCatch(export_headless_session(nb), error = function(error) {
      alder_abort("render_failed", conditionMessage(error))
    })
    on.exit(boot$cleanup(), add = TRUE)
    state <- tryCatch(export_wait_idle(boot$session), error = function(error) {
      alder_abort("render_failed", conditionMessage(error))
    })
    markdown <- tempfile(pattern = ".alder-pandoc-", tmpdir = dirname(path),
                         fileext = ".md")
    on.exit({
      unlink(markdown, force = TRUE)
      unlink(file.path(dirname(markdown), paste0(
        tools::file_path_sans_ext(basename(markdown)), "_files")),
        recursive = TRUE, force = TRUE)
    }, add = TRUE)
    alder_render_static_markdown(state, boot$artifact_dir, markdown,
                                 include_code)
    title <- export_scalar_chr(nb$metadata$title, "Alder notebook")
    transcript <- alder_render_run(
      engine, command,
      c(markdown, "--from", "markdown", "--to", "html5", "--standalone",
        "--embed-resources", "--css", css, "--metadata", paste0("title=", title),
        "--output", temporary_output),
      wd = dirname(path), timeout = timeout
    )
  }

  alder_render_provenance(temporary_output, engine)
  alder_render_replace(temporary_output, out)
  result <- normalizePath(out, mustWork = TRUE)
  attr(result, "engine") <- engine
  attr(result, "stdout") <- transcript$stdout
  attr(result, "stderr") <- transcript$stderr
  invisible(result)
}
