# ---
# title: Ordered output and an intentional error
# ---

# %%
emit_then_fail <- function() {
  old <- options(warn = 1)
  on.exit(options(old), add = TRUE)
  cat("first: text\n")
  flush(stdout())
  message("second: message")
  warning("third: warning", call. = FALSE)
  cat("fourth: text\n")
  flush(stdout())
  stop("fifth: expected error", call. = FALSE)
}
emit_then_fail()

# %%
"kernel remains usable after the failed cell"

# The first cell intentionally fails. Its five outputs/conditions should appear
# in the labeled order above. Rscript exits nonzero at the error; in Alder the
# second cell can still run and display its string.
