#!/usr/bin/env bash
set -euo pipefail

# Run inside codex-universal under one long-lived `tini -s`.
# Bioconductor/plotting dependencies must already be installed.
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$repo"
evidence=${1:?usage: run-bulk-de-scale.sh EMPTY_EVIDENCE_DIR [ALDER_SOURCE_ARCHIVE]}
artifact=${2:-dev/reviews/evidence/bulk-de-scale/candidate-v19/alder_0.1.0.tar.gz}
evidence=$(realpath -m -- "$evidence")
artifact=$(realpath -e -- "$artifact")
if [[ -e "$evidence" ]] && [[ ! -d "$evidence" || -n $(find "$evidence" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo "refusing nonempty evidence destination: $evidence" >&2
  exit 2
fi
mkdir -p -- "$evidence"
audit_root=$(mktemp -d /tmp/alder-bulk-scale.XXXXXX)
mkdir -- "$audit_root/lib"
finish() {
  local status=$? resource=0
  trap - EXIT
  python3 dev/reviews/audit-cold-start-processes.py --phase final \
    --evidence-dir "$evidence" --audit-root "$audit_root" \
    > "$evidence/98-process-final.log" 2>&1 || resource=$?
  printf '{"execution_exit":%s,"resource_exit":%s}\n' "$status" "$resource" \
    > "$evidence/99-driver-result.json"
  if ((status == 0 && resource != 0)); then status=$resource; fi
  exit "$status"
}
trap finish EXIT
python3 dev/reviews/audit-cold-start-processes.py --phase baseline \
  --evidence-dir "$evidence" --audit-root "$audit_root" \
  > "$evidence/00-process-baseline.log"
sha256sum "$artifact" dev/examples/bulk-differential-expression.R \
  dev/reviews/probe-bulk-de-scale.R dev/reviews/run-bulk-de-scale.sh \
  > "$evidence/input-sha256.txt"
Rscript dev/reviews/verify-source-artifact.R "$artifact" "$repo" \
  > "$evidence/source-correspondence.log" 2>&1
R CMD INSTALL --library="$audit_root/lib" "$artifact" \
  > "$evidence/install.log" 2>&1
export R_LIBS="$audit_root/lib${R_LIBS:+:$R_LIBS}"
Rscript -e 'stopifnot(all(vapply(c("edgeR", "statmod", "ggplot2", "chromote", "curl", "digest"), requireNamespace, logical(1), quietly = TRUE)))'
Rscript dev/reviews/probe-bulk-de-scale.R "$evidence" \
  > "$evidence/probe.log" 2>&1
Rscript -e 'p <- commandArgs(TRUE)[[1]]; r <- jsonlite::fromJSON(file.path(p, "result.json")); c <- jsonlite::fromJSON(file.path(p, "complete.json")); stopifnot(isTRUE(r$passed), isTRUE(c$complete), !isTRUE(r$cleanup$forced))' "$evidence"
sha256sum --check "$evidence/input-sha256.txt" > "$evidence/final-input-correspondence.log"
