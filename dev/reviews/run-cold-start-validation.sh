#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: run-cold-start-validation.sh --artifact PATH --sha256 HEX64 \
  --evidence-dir EMPTY_DIR --audit-root EMPTY_DIR [--source-suite]

Run in codex-universal below one long-lived `tini -s`, after the caller has
independently restarted the container. The default runs static validation,
exact source verification, the host suite against the frozen installed package,
and exact R CMD check (including the installed R/browser suite). --source-suite
also runs the unfiltered source suite. Both baseline and final process audits
require zero zombies. This driver never restarts the container or stops unrelated
processes.
USAGE
}

die() { printf 'cold-start validation: %s\n' "$*" >&2; exit 2; }
artifact=
expected_sha=
evidence=
audit_root=
source_suite=false
while (($#)); do
  case "$1" in
    --artifact|--sha256|--evidence-dir|--audit-root)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --artifact) artifact=$2 ;;
        --sha256) expected_sha=$2 ;;
        --evidence-dir) evidence=$2 ;;
        --audit-root) audit_root=$2 ;;
      esac
      shift 2 ;;
    --source-suite) source_suite=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[[ -n "$artifact" && -n "$evidence" && -n "$audit_root" ]] ||
  { usage >&2; die "artifact, evidence directory, and audit root are required"; }
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || die "SHA-256 must be 64 lowercase hexadecimal characters"
for value in "$artifact" "$evidence" "$audit_root"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* ]] ||
    die "paths must not contain control separators"
done
for command_name in R Rscript node npm quarto pandoc google-chrome tini ss python3 shellcheck sha256sum realpath; do
  command -v "$command_name" >/dev/null || die "required container command is missing: $command_name"
done
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/../.." && pwd -P)
cd -- "$repo"
artifact=$(realpath -e -- "$artifact")
[[ -f "$artifact" && $(basename -- "$artifact") == alder_*.tar.gz ]] ||
  die "artifact must be a regular alder_*.tar.gz source package"
actual_sha=$(sha256sum -- "$artifact" | cut -d ' ' -f 1)
[[ "$actual_sha" == "$expected_sha" ]] || die "artifact SHA-256 does not match"
evidence=$(realpath -m -- "$evidence")
audit_root=$(realpath -m -- "$audit_root")
[[ "$evidence" != "$audit_root" ]] || die "audit root and evidence directory must differ"
case "$audit_root/" in "$repo/"*|"$evidence/"*) die "private audit root must be outside the repository and evidence directory" ;; esac
case "$evidence/" in "$audit_root/"*) die "evidence must not be inside the audit root" ;; esac
for directory in "$evidence" "$audit_root"; do
  [[ ! -e "$directory" || -d "$directory" ]] || die "destination is not a directory: $directory"
  [[ ! -d "$directory" || -z $(find "$directory" -mindepth 1 -maxdepth 1 -print -quit) ]] ||
    die "refusing nonempty destination: $directory"
done
mkdir -p -- "$evidence" "$audit_root"
mkdir -- "$evidence/artifact"
pinned_artifact=$evidence/artifact/$(basename -- "$artifact")
cp -- "$artifact" "$pinned_artifact"
[[ $(sha256sum -- "$pinned_artifact" | cut -d ' ' -f 1) == "$expected_sha" ]] ||
  die "artifact changed while copying"

{
  printf 'started_utc=%s\nrepo=%s\nartifact_source=%s\nartifact_copy=%s\n' \
    "$(date -u +%FT%TZ)" "$repo" "$artifact" "$pinned_artifact"
  printf 'expected_sha256=%s\naudit_root=%s\nsource_suite_requested=%s\n' \
    "$expected_sha" "$audit_root" "$source_suite"
  printf 'inherited_ALDER_TEST_FILTER=%q\ninherited_ALDER_TEST_LIB=%q\n' \
    "${ALDER_TEST_FILTER:-}" "${ALDER_TEST_LIB:-}"
} > "$evidence/00-provenance.txt"
sha256sum -- \
  "$script_dir/run-cold-start-validation.sh" \
  "$script_dir/audit-cold-start-processes.py" \
  "$script_dir/run-static-gate.sh" "$script_dir/run-full-suite.R" \
  "$script_dir/verify-source-artifact.R" "$script_dir/run-package-check.sh" \
  > "$evidence/00-driver-sha256.txt"
printf 'phase\tstarted_utc\tfinished_utc\texit_code\n' > "$evidence/00-phases.tsv"

# tests/testthat.R deliberately supports a focused local filter. A release
# check must override inherited selectors and never reuse a stale test install.
export NOT_CRAN=true R_TESTS='' ALDER_TEST_FILTER='' ALDER_TEST_LIB=''
export ALDER_REVIEW_DESC='' TESTTHAT_FILTER=''
main_completed=false
current_phase=preflight
run_step() {
  local label=$1
  shift
  local started status
  current_phase=$label
  started=$(date -u +%FT%TZ)
  printf 'START %s %s\n' "$label" "$started"
  {
    printf '%s ' "$label"
    printf '%q ' "$@"
    printf '\n'
  } >> "$evidence/00-commands.txt"
  if "$@" > "$evidence/$label.log" 2>&1; then status=0; else status=$?; fi
  printf '%s\t%s\t%s\t%s\n' "$label" "$started" "$(date -u +%FT%TZ)" "$status" \
    >> "$evidence/00-phases.tsv"
  printf 'END %s exit=%s log=%s\n' "$label" "$status" "$evidence/$label.log"
  return "$status"
}

# shellcheck disable=SC2317 # Registered as the EXIT trap below.
finish() {
  local prior=$? final_status process_status=0 failed_phase=$current_phase
  trap - EXIT INT TERM HUP
  set +e
  run_step 98-process-final python3 "$script_dir/audit-cold-start-processes.py" \
    --phase final --evidence-dir "$evidence" --audit-root "$audit_root"
  process_status=$?
  final_status=$prior
  if ((final_status == 0 && process_status != 0)); then
    final_status=$process_status
    failed_phase=98-process-final
  fi
  if [[ "$main_completed" != true ]] && ((final_status == 0)); then final_status=1; fi
  local outcome=failed
  if ((final_status == 0)); then outcome=passed; failed_phase=none; fi
  printf '{"status":"%s","exit_code":%s,"main_gates_completed":%s,"source_suite_requested":%s,"resource_audit_exit":%s,"failed_phase":"%s","artifact_sha256":"%s"}\n' \
    "$outcome" "$final_status" "$main_completed" "$source_suite" "$process_status" \
    "$failed_phase" "$expected_sha" > "$evidence/99-result.json"
  printf 'Cold-start validation %s. Evidence: %s\n' "$outcome" "$evidence"
  exit "$final_status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

run_step 00-process-baseline python3 "$script_dir/audit-cold-start-processes.py" \
  --phase baseline --evidence-dir "$evidence" --audit-root "$audit_root"
run_step 01-static bash "$script_dir/run-static-gate.sh"
if [[ "$source_suite" == true ]]; then
  run_step 02-source-suite env \
    ALDER_SUITE_EVIDENCE="$evidence/02-source-totals.json" \
    NOT_CRAN=true \
    ALDER_TEST_HOST=1 \
    ALDER_NODE="$repo/host/node_modules/node/bin/node" \
    ALDER_ARK="$repo/host/.runtime/ark" \
    Rscript --vanilla "$script_dir/run-full-suite.R"
  run_step 02b-source-totals python3 - "$evidence/02-source-totals.json" <<'PY'
import json, sys
totals = json.load(open(sys.argv[1]))
if not (totals["tests"] > 0 and totals["expectations"] > 0):
    raise RuntimeError("source suite did not execute tests: " + repr(totals))
if any(totals[key] != 0 for key in ("failed", "errors", "warnings", "skips")):
    raise RuntimeError("source suite is not clean: " + repr(totals))
print(json.dumps(totals))
PY
fi
run_step 03-source-verification Rscript --vanilla "$script_dir/verify-source-artifact.R" \
  "$pinned_artifact" "$repo"
host_library="$audit_root/host-library"
mkdir -- "$host_library"
run_step 04-install-host-candidate R CMD INSTALL --library="$host_library" \
  "$pinned_artifact"
host_package="$host_library/alder"
host_node="$repo/host/node_modules/node/bin/node"
host_tsx="$repo/host/node_modules/tsx/dist/loader.mjs"
run_step 04a-stage-host-native "$host_node" "$repo/host/scripts/stage-native.mjs" \
  "$host_package/host"
run_step 04b-installed-host-suite env \
  ALDER_R_PACKAGE="$host_package" \
  ALDER_NODE="$host_node" \
  ALDER_ARK="$repo/host/.runtime/ark" \
  ALDER_BROWSER_TEST=1 \
  R_LIBS="$host_library" R_LIBS_USER="$host_library" \
  "$host_node" --import "$host_tsx" --test host/test/*.test.ts
run_step 05-package-check env ALDER_CHECK_ARTIFACT="$pinned_artifact" \
  ALDER_CHECK_EVIDENCE="$evidence/package-check" bash "$script_dir/run-package-check.sh"
run_step 06-source-verification-final Rscript --vanilla "$script_dir/verify-source-artifact.R" \
  "$pinned_artifact" "$repo"
run_step 07-driver-provenance sha256sum --check "$evidence/00-driver-sha256.txt"
run_step 08-artifact-provenance python3 - "$artifact" "$pinned_artifact" "$expected_sha" <<'PY'
import hashlib, json, sys
observed = {}
for path in sys.argv[1:3]:
    with open(path, "rb") as stream:
        observed[path] = hashlib.file_digest(stream, "sha256").hexdigest()
print(json.dumps(observed, indent=2))
if any(value != sys.argv[3] for value in observed.values()):
    raise RuntimeError("artifact hash changed: " + repr(observed))
PY
main_completed=true
