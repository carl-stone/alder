#!/usr/bin/env Rscript

# Replay the immutable Cycle-2 idle-loss probe against a newly installed
# package while routing every output to a distinct post-fix evidence folder.
# The original script and its before artifacts remain byte-for-byte untouched.

evidence <- Sys.getenv("ALDER_RUNTIME_EVIDENCE", unset = "")
snapshot <- Sys.getenv("ALDER_RUNTIME_SNAPSHOT_ROOT", unset = "")
if (!nzchar(evidence) || !nzchar(snapshot)) {
  stop("ALDER_RUNTIME_EVIDENCE and ALDER_RUNTIME_SNAPSHOT_ROOT are required")
}
dir.create(evidence, recursive = TRUE, showWarnings = FALSE)
chrome_tmp <- file.path(snapshot, "idle-chrome-tmp")
dir.create(chrome_tmp, recursive = TRUE, showWarnings = FALSE)

probe <- file.path(
  dirname(evidence), "runtime-observability-cycle-2", "probe-idle-unsaved.R"
)
lines <- readLines(probe, warn = FALSE)
quoted <- function(path) encodeString(normalizePath(path, mustWork = TRUE),
                                      quote = '"')
lines <- sub(
  '^  evidence <- "/workspace/alder/dev/reviews/evidence/runtime-observability-cycle-2"$',
  paste0("  evidence <- ", quoted(evidence)), lines
)
lines <- sub(
  '^  snapshot <- readLines\\(file.path\\(evidence, "snapshot-root.txt"\\), warn = FALSE\\)\\[\\[1L\\]\\]$',
  paste0("  snapshot <- ", quoted(snapshot)), lines
)
lines <- gsub('"/tmp/a-c2-idle-chrome"', quoted(chrome_tmp), lines,
              fixed = TRUE)
eval(parse(text = paste(lines, collapse = "\n")),
     envir = new.env(parent = globalenv()))
