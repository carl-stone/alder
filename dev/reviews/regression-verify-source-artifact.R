#!/usr/bin/env Rscript

# Regression coverage for verify-source-artifact.R.  It keeps the real cycle-4
# candidate in the check, then uses a tiny package fixture so deliberate byte
# mutations can be checked without changing the working tree or artifact.

args <- commandArgs()
file_arg <- grep("^--file=", args, value = TRUE)
if (!length(file_arg)) stop("run this file with Rscript", call. = FALSE)
script <- normalizePath(sub("^--file=", "", file_arg[[1L]]), mustWork = TRUE)
reviews_dir <- dirname(script)
repo <- normalizePath(file.path(reviews_dir, "../.."), mustWork = TRUE)
verifier <- file.path(reviews_dir, "verify-source-artifact.R")

run_verifier <- function(artifact, repository) {
  output <- suppressWarnings(system2(
    "Rscript", c(verifier, artifact, repository), stdout = TRUE, stderr = TRUE
  ))
  status <- attr(output, "status") %||% 0L
  list(status = as.integer(status), output = output)
}

`%||%` <- function(x, y) if (is.null(x)) y else x
expect <- function(condition, message) {
  if (!isTRUE(condition)) stop(message, call. = FALSE)
}

candidate_v5 <- file.path(
  repo, "dev/reviews/evidence/cycle-4/integrated/candidate-final-release-v5",
  "alder_0.1.0.tar.gz"
)
expect(file.exists(candidate_v5), paste("missing current candidate v5:", candidate_v5))
v5_repo_parent <- tempfile("alder-v5-source-snapshot-")
dir.create(v5_repo_parent)
on.exit(unlink(v5_repo_parent, recursive = TRUE, force = TRUE), add = TRUE)
utils::untar(candidate_v5, exdir = v5_repo_parent)
v5 <- run_verifier(candidate_v5, file.path(v5_repo_parent, "alder"))
expect(identical(v5$status, 0L),
       paste("current candidate v5 did not pass (status", v5$status, ")"))
expect(any(v5$output == "RESULT=PASS"),
       "current candidate v5 did not report RESULT=PASS")
cat("PASS current-candidate-v5 | RESULT=PASS\n")

fixture <- tempfile("alder-verifier-regression-")
dir.create(fixture)
on.exit(unlink(fixture, recursive = TRUE, force = TRUE), add = TRUE)
fixture_repo <- file.path(fixture, "repo")
stage <- file.path(fixture, "stage")
dir.create(fixture_repo, recursive = TRUE)
dir.create(file.path(stage, "alder", "R"), recursive = TRUE)

write_utf8 <- function(path, text) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  writeBin(charToRaw(enc2utf8(text)), path)
}

write_utf8(file.path(fixture_repo, "DESCRIPTION"), paste0(
  "Package: alder\n",
  "Title: Verifier Fixture\n",
  "Version: 0.0.1\n",
  "Authors@R: person(\"Test\", \"User\", email = \"test@example.org\", role = c(\"aut\", \"cre\"))\n",
  "Description: A controlled source-artifact verifier fixture.\n",
  "License: MIT\n",
  "Encoding: UTF-8\n"
))
write_utf8(file.path(fixture_repo, "NAMESPACE"), "exportPattern(\"^[[:alpha:]]+\")\n")
write_utf8(file.path(fixture_repo, "README.md"), "# verifier fixture\n")
write_utf8(file.path(fixture_repo, "R", "a.R"), "fixture_a <- function() 'a'\n")
write_utf8(file.path(fixture_repo, "R", "b.R"), "fixture_b <- function() 'middle'\n")
write_utf8(file.path(fixture_repo, "R", "c.R"), "fixture_c <- function() 'last'\n")

copy_fixture <- function(destination) {
  dir.create(destination, recursive = TRUE, showWarnings = FALSE)
  files <- list.files(fixture_repo, recursive = TRUE, all.files = TRUE,
                      include.dirs = FALSE, no.. = TRUE)
  for (rel in files) {
    target <- file.path(destination, rel)
    dir.create(dirname(target), recursive = TRUE, showWarnings = FALSE)
    file.copy(file.path(fixture_repo, rel), target, overwrite = TRUE)
  }
}

copy_fixture(file.path(stage, "alder"))
fixture_artifact <- file.path(fixture, "fixture.tar.gz")
tar_fixture <- function(source_dir, artifact) {
  result <- system2("tar", c("-czf", artifact, "-C", dirname(source_dir),
                             basename(source_dir)), stdout = TRUE, stderr = TRUE)
  status <- attr(result, "status") %||% 0L
  expect(identical(as.integer(status), 0L), "could not create fixture artifact")
}
tar_fixture(file.path(stage, "alder"), fixture_artifact)

baseline <- run_verifier(fixture_artifact, fixture_repo)
expect(identical(baseline$status, 0L), "unmutated fixture did not pass")
expect(any(baseline$output == "RESULT=PASS"),
       "unmutated fixture did not report RESULT=PASS")
cat("PASS fixture-baseline | RESULT=PASS\n")

mutated_artifact <- function(relative_path, byte_position) {
  mutation_dir <- tempfile("alder-verifier-mutation-")
  dir.create(mutation_dir)
  on.exit(unlink(mutation_dir, recursive = TRUE, force = TRUE), add = TRUE)
  utils::untar(fixture_artifact, exdir = mutation_dir)
  path <- file.path(mutation_dir, "alder", relative_path)
  bytes <- readBin(path, "raw", n = file.info(path)$size)
  expect(length(bytes) >= byte_position, paste("fixture too short:", relative_path))
  bytes[[byte_position]] <- as.raw(bitwXor(as.integer(bytes[[byte_position]]), 1L))
  writeBin(bytes, path)
  artifact <- file.path(fixture, paste0(gsub("/", "-", relative_path), ".tar.gz"))
  tar_fixture(file.path(mutation_dir, "alder"), artifact)
  artifact
}

byte_candidates <- sort(c("NAMESPACE", "README.md", "R/a.R", "R/b.R", "R/c.R"))
expect(length(byte_candidates) == 5L,
       "fixture must retain five byte-comparison candidates")
middle_index <- ceiling(length(byte_candidates) / 2)
cases <- list(
  list(label = "first-candidate", path = byte_candidates[[1L]], byte = 1L),
  list(label = "middle-candidate", path = byte_candidates[[middle_index]],
       byte = ceiling(file.info(file.path(fixture_repo,
                                         byte_candidates[[middle_index]]))$size / 2)),
  list(label = "last-candidate", path = byte_candidates[[length(byte_candidates)]],
       byte = file.info(file.path(fixture_repo,
                                 byte_candidates[[length(byte_candidates)]]))$size)
)
for (case in cases) {
  artifact <- mutated_artifact(case$path, case$byte)
  result <- run_verifier(artifact, fixture_repo)
  mismatch_line <- paste0("BYTE_MISMATCH_FILES=", case$path)
  expect(identical(result$status, 1L),
         paste(case$label, "mutation unexpectedly passed"))
  expect(any(result$output == mismatch_line),
         paste(case$label, "mutation did not report exact path; expected", mismatch_line))
  expect(any(result$output == "BYTE_CANDIDATE_FILES=5"),
         paste(case$label, "mutation reported an unreliable candidate count"))
  expect(any(result$output == "BYTE_IDENTICAL_FILES=4"),
         paste(case$label, "mutation reported an unreliable identical count"))
  cat("PASS ", case$label, "-byte-mismatch | ", mismatch_line, " | exit=1\n", sep = "")
}

cat("RESULT=PASS\n")
