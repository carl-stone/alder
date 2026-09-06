#!/usr/bin/env bash
set -euo pipefail

evidence=${ALDER_CHECK_EVIDENCE:-dev/reviews/evidence/package-check}
if [[ -d "$evidence" ]] &&
    [[ -n $(find "$evidence" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo "refusing to mix package-check evidence in nonempty directory: $evidence" >&2
  exit 1
fi
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
check_root=$(mktemp -d /tmp/alder-check.XXXXXX)
trap 'rm -rf -- "$check_root"' EXIT

if [[ -n ${ALDER_CHECK_ARTIFACT:-} ]]; then
  if [[ ! -f "$ALDER_CHECK_ARTIFACT" ]]; then
    echo "ALDER_CHECK_ARTIFACT must name an existing file: $ALDER_CHECK_ARTIFACT" >&2
    exit 1
  fi
  artifact_source=$(realpath -- "$ALDER_CHECK_ARTIFACT")
  artifact=$(basename -- "$artifact_source")
  if [[ "$artifact" != alder_*.tar.gz ]]; then
    echo "ALDER_CHECK_ARTIFACT must name an alder_*.tar.gz source artifact: $ALDER_CHECK_ARTIFACT" >&2
    exit 1
  fi
fi

Rscript --vanilla -e 'version <- as.character(getRversion()); cat("R ", version, "\n", sep = ""); stopifnot(identical(version, "4.6.1"))' \
  | tee "$evidence/00-runtime.log"

if [[ -n ${ALDER_CHECK_ARTIFACT:-} ]]; then
  tarball=$artifact_source
  artifact_sha_before=$(sha256sum "$tarball" | cut -d ' ' -f 1)
  cp "$tarball" "$evidence/"
  artifact_sha_after=$(sha256sum "$evidence/$artifact" | cut -d ' ' -f 1)
  if [[ "$artifact_sha_before" != "$artifact_sha_after" ]]; then
    echo "source artifact changed while copying: $ALDER_CHECK_ARTIFACT" >&2
    exit 1
  fi
  {
    printf 'before=%s\n' "$artifact_sha_before"
    printf 'after=%s\n' "$artifact_sha_after"
  } > "$evidence/02-artifact-sha256.txt"
else
  (
    cd "$check_root"
    R CMD build --no-build-vignettes /workspace/alder
  ) 2>&1 | tee "$evidence/01-build.log"

  tarball=$(find "$check_root" -maxdepth 1 -type f -name 'alder_*.tar.gz' -print)
  if [[ $(wc -l <<<"$tarball") -ne 1 ]]; then
    echo "expected exactly one source tarball" >&2
    exit 1
  fi
  cp "$tarball" "$evidence/"
  artifact=$(basename "$tarball")
  (
    cd "$evidence"
    sha256sum "$artifact"
  ) > "$evidence/02-artifact-sha256.txt"
fi
tar -tzf "$tarball" | sort > "$evidence/02-source-manifest.txt"

grep -Fx 'alder/exec/alder' "$evidence/02-source-manifest.txt"
grep -Fx 'alder/exec/alder.cmd' "$evidence/02-source-manifest.txt"
grep -Fx 'alder/inst/publishing/alder.css' \
  "$evidence/02-source-manifest.txt"
if grep -Eq '^alder/(AGENTS\.md|ALDER_TASK\.md|TASK_STATE\.md|SUBAGENTS\.md|USER_FLOWS\.md|NORTH_STAR_RUBRIC\.md|tests/AGENTS\.md|dev/)' \
    "$evidence/02-source-manifest.txt"; then
  echo "internal task or review files leaked into source package" >&2
  exit 1
fi

set +e
(
  cd "$check_root"
  NOT_CRAN=true \
  _R_CHECK_CRAN_INCOMING_REMOTE_=false \
  _R_CHECK_FORCE_SUGGESTS_=true \
    R CMD check --as-cran --no-manual "$tarball"
) 2>&1 | tee "$evidence/03-R-CMD-check.log"
check_status=${PIPESTATUS[0]}
set -e

if [[ -n ${ALDER_CHECK_ARTIFACT:-} ]]; then
  artifact_sha_source_post_check=$(sha256sum "$tarball" | cut -d ' ' -f 1)
  artifact_sha_copy_post_check=$(sha256sum "$evidence/$artifact" | cut -d ' ' -f 1)
  {
    printf 'source_post_check=%s\n' "$artifact_sha_source_post_check"
    printf 'copy_post_check=%s\n' "$artifact_sha_copy_post_check"
  } >> "$evidence/02-artifact-sha256.txt"
  if [[ "$artifact_sha_source_post_check" != "$artifact_sha_before" ||
    "$artifact_sha_copy_post_check" != "$artifact_sha_before" ]]; then
    echo "source artifact changed during package check: $ALDER_CHECK_ARTIFACT" >&2
    exit 1
  fi
fi

if [[ -f "$check_root/alder.Rcheck/00check.log" ]]; then
  cp "$check_root/alder.Rcheck/00check.log" "$evidence/04-00check.log"
fi
for suffix in Rout Rout.fail; do
  test_log="$check_root/alder.Rcheck/tests/testthat.$suffix"
  if [[ -f "$test_log" ]]; then
    cp "$test_log" "$evidence/05-testthat.$suffix"
  fi
done
if [[ $check_status -ne 0 ]]; then
  exit "$check_status"
fi

grep -Fx 'Status: OK' "$evidence/03-R-CMD-check.log"
if [[ ! -f "$evidence/05-testthat.Rout" ]]; then
  echo "successful package check did not preserve an installed test transcript" >&2
  exit 1
fi
grep -E '^\[ FAIL [0-9]+ \| WARN [0-9]+ \| SKIP [0-9]+ \| PASS [0-9]+ \]$' \
  "$evidence/05-testthat.Rout" > "$evidence/06-test-summary.txt"
if [[ $(wc -l < "$evidence/06-test-summary.txt") -ne 1 ]]; then
  echo "expected exactly one installed test summary" >&2
  exit 1
fi
grep -Eq '^\[ FAIL 0 \| WARN 0 \| SKIP 0 \| PASS [1-9][0-9]* \]$' \
  "$evidence/06-test-summary.txt"
