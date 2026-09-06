pkgload::load_all(".", quiet = TRUE)

descriptions <- c(
  "browser makes lintr opt-in without hiding Alder diagnostics",
  "browser keeps dataflow available for incomplete R source",
  "browser Shut down distinguishes lifecycle from execution Stop"
)
requested <- Sys.getenv("ALDER_REVIEW_DESC", unset = "")
if (nzchar(requested)) descriptions <- requested
results <- lapply(descriptions, function(description) {
  testthat::test_file(
    "tests/testthat/test-browser.R",
    reporter = "summary",
    desc = description,
    stop_on_failure = FALSE,
    stop_on_warning = FALSE
  )
})

frame <- do.call(rbind, lapply(results, as.data.frame))
print(frame[, c("test", "nb", "failed", "error", "warning", "skipped")])
quit(status = as.integer(any(
  frame$failed > 0L | frame$error | frame$warning > 0L | frame$skipped > 0L
)))
