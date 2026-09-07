# Alder's Ark startup hook. Ark remains the notebook evaluator and owns its
# Jupyter lifecycle, streams, conditions, native graphics and interruption.
# The sourced runtime only adds Alder's reactive ownership and output helpers.

suppressPackageStartupMessages(library(alder))

# Start opt-in profiling before Ark announces readiness. This records startup
# work even when a profiling fixture creates a kernel without evaluating a
# notebook cell; with tracing disabled this only flips private in-memory state.
get(".alder_perf_initialize", envir = asNamespace("alder"))()

local({
  package_path <- find.package("alder", quiet = FALSE)
  runtime_path <- file.path(package_path, "worker", "host-ark-runtime.R")
  if (!file.exists(runtime_path)) {
    stop("installed Alder Ark runtime not found", call. = FALSE)
  }

  # These values are part of the persistent notebook runtime contract. Ark may
  # update its own device option, so Alder protects only unrelated user state.
  protected <- getOption("ark.protected_options", character())
  options(ark.protected_options = unique(c(
    protected, "alder.format", "alder.engine", "max.print"
  )))

  runtime <- new.env(parent = globalenv())
  sys.source(runtime_path, envir = runtime, keep.source = FALSE)
  api <- get("RUNTIME", envir = asNamespace("alder"), inherits = FALSE)
  if (!is.environment(api) || !is.function(api$ark_evaluate) ||
      !is.function(api$ark_request)) {
    stop("Alder Ark runtime is incomplete", call. = FALSE)
  }
})
