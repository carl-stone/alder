# Jobs consume immutable host snapshots. Rendering an export must never create
# a second reactive Session or evaluate the notebook's source again.
alder_host_job <- function(command, payload, library_policy = NULL) {
  if (identical(command, "sandbox.resolve")) return(alder_sandbox(payload$path))
  if (identical(command, "gallery.catalog")) {
    return(list(entries = alder_gallery_index(payload$path),
                 config = resolve_alder_config(file.path(payload$path, "__gallery__.R"), list())))
  }
  if (command %in% c("packages.status", "packages.declare", "packages.install")) {
    packages <- unlist(payload$packages, use.names = FALSE) %||% character()
    sandbox <- if (is.list(library_policy)) library_policy[["sandbox"]] else NULL
    if (is.null(sandbox)) sandbox <- Sys.getenv("ALDER_SANDBOX_LIB", unset = "")
    return(switch(command,
      packages.status = {
        result <- alder_packages(payload$path)
        if (!file.exists(result$metadata)) {
          result$declared <- .alder_validate_package_names(
            unlist(payload$metadata$packages, use.names = FALSE) %||% character())
        }
        if (nzchar(sandbox)) result$lib <- c(sandbox, .Library)
        result$status <- alder_package_status(result$declared, lib.loc = result$lib)
        result$missing <- result$status$package[result$status$status == "missing"]
        result$installed <- result$status$package[result$status$status == "installed"]
        result
      },
      packages.declare = alder_declare(packages, payload$path),
      packages.install = {
        result <- alder_install(packages, payload$path,
                                  lib = if (nzchar(sandbox)) sandbox else NULL)
        if (!isTRUE(result$ok)) {
          alder_abort(result$error$code %||% "install_failed",
                       result$error$message %||% "package installation failed",
                       result = result)
        }
        result
      }
    ))
  }
  if (!command %in% c("export", "publish")) {
    alder_abort("invalid_request", paste("unknown host job:", command))
  }
  state <- payload$state
  format <- if (identical(command, "publish")) "html" else payload$format
  if (!format %in% export_formats) alder_abort("invalid_request", "unsupported export format")
  if (!is.list(state) || !is.list(state$cells)) {
    alder_abort("invalid_request", "export requires an authoritative snapshot")
  }
  out <- payload$out
  artifacts <- payload$artifact_dir
  include <- isTRUE(payload$include_code)
  state$topo <- unlist(state$graph$topologicalOrder, use.names = FALSE)
  state$dag <- state$graph
  for (i in seq_along(state$cells)) {
    state$cells[[i]]$body <- unlist(state$cells[[i]]$body, use.names = FALSE) %||% character()
    state$cells[[i]]$log <- unlist(state$cells[[i]]$log, use.names = FALSE) %||% character()
  }
  state$app <- alder_app_config(list(metadata = state$metadata))
  if (identical(command, "publish")) {
    engine <- match.arg(payload$engine, c("pandoc", "quarto"))
    executable <- alder_render_tool(engine)
    markdown <- tempfile("alder-publish-", tmpdir = dirname(out), fileext = ".md")
    files <- paste0(tools::file_path_sans_ext(markdown), "_files")
    on.exit(unlink(c(markdown, files), recursive = TRUE, force = TRUE), add = TRUE)
    alder_render_static_markdown(state, artifacts, markdown, include)
    css <- system.file("publishing", "alder.css", package = "alder", mustWork = TRUE)
    args <- if (identical(engine, "pandoc")) {
      c(markdown, "--standalone", "--embed-resources", "--css", css, "--output", out)
    } else {
      c("render", markdown, "--to", "html", "--no-execute", "--embed-resources",
        "--css", css, "--output", basename(out))
    }
    transcript <- alder_render_run(engine, executable, args, dirname(out), 300)
    return(list(path = out, engine = engine, transcript = transcript))
  }
  switch(format,
    html = export_html_file(state, artifacts, out, include),
    md = export_markdown_file(state, artifacts, out, include),
    script = export_script_file(state, out, state$path),
    ipynb = export_ipynb_file(state, artifacts, out, include),
    qmd = export_qmd_file(state, out, include),
    session = export_session_file(state, out)
  )
  list(path = out, format = format)
}
