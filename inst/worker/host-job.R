local({
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 2L) stop("host job requires input and result paths")
  suppressPackageStartupMessages(library(alder))
  library_policy <- get("alder_host_apply_library_policy",
                        asNamespace("alder"))()
  request <- jsonlite::read_json(args[[1L]], simplifyVector = FALSE)
  result <- tryCatch({
    value <- get("alder_host_job", asNamespace("alder"))(
      request$command, request$payload, library_policy)
    list(ok = TRUE, result = value)
  }, error = function(error) {
    list(ok = FALSE, error = list(
      code = if (is.null(error$code)) "job_failed" else error$code,
      message = conditionMessage(error)))
  })
  jsonlite::write_json(result, args[[2L]], auto_unbox = TRUE, null = "null")
})
