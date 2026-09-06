evidence <- Sys.getenv(
  "ALDER_SUITE_EVIDENCE",
  unset = "dev/reviews/evidence/full-suite-totals.json"
)
dir.create(dirname(evidence), recursive = TRUE, showWarnings = FALSE)

cat("R ", as.character(getRversion()), "\n", sep = "")
cat("repository ", normalizePath(".", mustWork = TRUE), "\n", sep = "")
reporter <- testthat::SummaryReporter$new(max_reports = Inf)
results <- testthat::test_local(
  ".",
  reporter = reporter,
  load_package = "source",
  stop_on_failure = FALSE,
  stop_on_warning = FALSE
)
frame <- as.data.frame(results)
totals <- list(
  expectations = sum(frame$nb),
  failed = sum(frame$failed),
  errors = sum(frame$error),
  warnings = sum(frame$warning),
  skips = sum(frame$skipped),
  tests = nrow(frame)
)
jsonlite::write_json(
  totals, evidence,
  auto_unbox = TRUE, pretty = TRUE, null = "null"
)
print(totals)
quit(status = as.integer(
  totals$failed + totals$errors + totals$warnings + totals$skips > 0L
))
