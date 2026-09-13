# Opt-in developer timing. No source, values, bodies, paths or user output are
# recorded. Normal execution never opens a trace file or starts a profiler.
.alder_perf_state <- new.env(parent = emptyenv())
.alder_perf_state$initialized <- FALSE

.alder_perf_initialize <- function() {
  state <- .alder_perf_state
  if (state$initialized) return(invisible())
  state$path <- NULL
  state$counter <- 0L
  dir <- Sys.getenv("ALDER_PERF_TRACE_DIR", unset = "")
  if (!nzchar(dir)) {
    state$initialized <- TRUE
    return(invisible())
  }
  if (!dir.exists(dir) || file.access(dir, 2L) != 0L) {
    stop("ALDER_PERF_TRACE_DIR must be an existing writable directory",
         call. = FALSE)
  }
  state$origin_ms <- unname(proc.time()[["elapsed"]]) * 1000
  state$pid <- Sys.getpid()
  state$path <- file.path(dir, paste0("trace-", state$pid, ".jsonl"))
  if (identical(Sys.getenv("ALDER_PERF_RPROF"), "1")) {
    utils::Rprof(file.path(dir, paste0("cpu-", state$pid, ".Rprof")),
                 interval = 0.01)
  }
  state$initialized <- TRUE
  invisible()
}

.alder_perf_write <- function(record) {
  # Diagnostic writes belong only to profiling runs. Failed writes remain
  # failures instead of yielding apparently complete measurement evidence.
  cat(as.character(jsonlite::toJSON(record, auto_unbox = TRUE, null = "null",
                                   digits = NA)), "\n",
      file = .alder_perf_state$path, append = TRUE, sep = "")
  invisible()
}

.alder_perf_begin <- function(stage, fields = list()) {
  .alder_perf_initialize()
  state <- .alder_perf_state
  if (is.null(state$path)) return(NULL)
  state$counter <- state$counter + 1L
  span <- list(pid = state$pid, span = state$counter, stage = stage,
               clock = "proc.time.elapsed",
               start_ms = unname(proc.time()[["elapsed"]]) * 1000 - state$origin_ms,
               fields = fields)
  .alder_perf_write(c(list(event = "begin"), span))
  span
}

.alder_perf_end <- function(span, fields = list()) {
  if (is.null(span)) return(invisible())
  elapsed <- unname(proc.time()[["elapsed"]]) * 1000 - .alder_perf_state$origin_ms - span$start_ms
  .alder_perf_write(c(list(event = "end", duration_ms = elapsed),
                      span, list(result = fields)))
  invisible()
}
