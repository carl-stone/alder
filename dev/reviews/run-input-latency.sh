#!/usr/bin/env bash
set -euo pipefail
# Run in codex-universal under one long-lived tini -s. Positional arguments:
# EMPTY_EVIDENCE_DIR [SAMPLES=30] [WARMUPS=2] [PROFILE_SAMPLES=3] [--enforce-budget]
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$repo"
evidence=$(realpath -m -- "${1:?empty evidence directory required}")
samples=${2:-30}
warmups=${3:-2}
profile_samples=${4:-3}
budget=${5:-}
if [[ -e "$evidence" ]] && [[ ! -d "$evidence" || -n $(find "$evidence" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo "refusing nonempty evidence destination: $evidence" >&2
  exit 2
fi
mkdir -p -- "$evidence" "$evidence/baseline" "$evidence/profile" "$evidence/build"
audit_root=$(mktemp -d /tmp/alder-input-latency.XXXXXX)
mkdir -- "$audit_root/lib"
finish() {
  local status=$? resource=0
  trap - EXIT
  python3 dev/reviews/audit-cold-start-processes.py --phase final \
    --evidence-dir "$evidence" --audit-root "$audit_root" \
    > "$evidence/98-process-final.log" 2>&1 || resource=$?
  printf '{"execution_exit":%s,"resource_exit":%s}\n' "$status" "$resource" > "$evidence/99-driver-result.json"
  if ((status == 0 && resource != 0)); then status=$resource; fi
  exit "$status"
}
trap finish EXIT
python3 dev/reviews/audit-cold-start-processes.py --phase baseline \
  --evidence-dir "$evidence" --audit-root "$audit_root" > "$evidence/00-process-baseline.log"
uname -a > "$evidence/machine.txt"
lscpu >> "$evidence/machine.txt"
free -b >> "$evidence/machine.txt"
for limit in cpu.max memory.max cpuset.cpus.effective; do
  if [[ -f "/sys/fs/cgroup/$limit" ]]; then
    printf '%s=' "$limit" >> "$evidence/machine.txt"
    cat "/sys/fs/cgroup/$limit" >> "$evidence/machine.txt"
  fi
done
node --version >> "$evidence/machine.txt"
sha256sum dev/reviews/{probe-input-latency.R,input-latency-browser.js,summarize-input-latency.py,run-input-latency.sh} > "$evidence/harness-sha256.txt"
(cd -- "$evidence/build" && R CMD build "$repo" --no-build-vignettes) > "$evidence/build.log" 2>&1
artifact=$(realpath -e -- "$evidence"/build/alder_*.tar.gz)
sha256sum "$artifact" > "$evidence/artifact-sha256.txt"
Rscript dev/reviews/verify-source-artifact.R "$artifact" "$repo" > "$evidence/source-correspondence.log" 2>&1
R CMD INSTALL --library="$audit_root/lib" "$artifact" > "$evidence/install.log" 2>&1
export R_LIBS="$audit_root/lib${R_LIBS:+:$R_LIBS}"
unset ALDER_TEST_LIB ALDER_TEST_FILTER ALDER_PERF_TRACE_DIR ALDER_PERF_RPROF
node --test dev/reviews/test-input-latency.mjs > "$evidence/browser-observer-tests.log" 2>&1
python3 -m unittest discover -s dev/reviews -p 'test_input_latency.py' > "$evidence/report-tests.log" 2>&1
Rscript -e 'testthat::test_dir("tests/testthat", filter = "performance", package = "alder", reporter = "summary", stop_on_failure = TRUE)' > "$evidence/trace-tests.log" 2>&1
if Rscript dev/reviews/probe-input-latency.R "$evidence/baseline" "$samples" "$warmups" baseline > "$evidence/baseline.log" 2>&1; then baseline_status=0; else baseline_status=$?; fi
if Rscript dev/reviews/probe-input-latency.R "$evidence/profile" "$profile_samples" 1 profile > "$evidence/profile.log" 2>&1; then profile_status=0; else profile_status=$?; fi
# shellcheck disable=SC2016 # R field access must remain literal inside this expression.
if Rscript -e 'root <- commandArgs(TRUE)[[1]]; paths <- list.files(root, pattern = "[.]Rprof$", recursive = TRUE, full.names = TRUE); for (path in paths) { p <- summaryRprof(path); jsonlite::write_json(list(sampling_seconds = p$sampling.time, sample_interval = p$sample.interval, by_total = utils::head(p$by.total, 30), by_self = utils::head(p$by.self, 30)), paste0(path, ".json"), dataframe = "columns", pretty = TRUE, auto_unbox = TRUE) }' "$evidence/profile" > "$evidence/cpu-summary.log" 2>&1; then cpu_status=0; else cpu_status=$?; fi
printf '{"baseline":%s,"profile":%s,"cpu_summary":%s}\n' "$baseline_status" "$profile_status" "$cpu_status" > "$evidence/stage-status.json"
sha256sum --check "$evidence/harness-sha256.txt" > "$evidence/final-harness-correspondence.log"
if [[ "$budget" == "--enforce-budget" ]]; then
  python3 dev/reviews/summarize-input-latency.py "$evidence" --enforce-budget > "$evidence/summary.log"
elif [[ -z "$budget" ]]; then
  python3 dev/reviews/summarize-input-latency.py "$evidence" > "$evidence/summary.log"
else
  echo "unknown option: $budget" >&2
  exit 2
fi
