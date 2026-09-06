library(testthat)
library(alder)

filter <- Sys.getenv("ALDER_TEST_FILTER", unset = "")
if (nzchar(filter)) {
  test_check("alder", filter = filter)
} else {
  test_check("alder")
}
