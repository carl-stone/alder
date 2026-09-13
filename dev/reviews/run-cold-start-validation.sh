#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: run-cold-start-validation.sh --application PATH --evidence-dir EMPTY_DIR \
  --rscript ABSOLUTE_RSCRIPT [--source-suite]

Run the static/source gates and the process-lifecycle scenario against one
already staged application. The application manifest and native supervisor
are the only runtime inputs; process evidence is produced by the canonical
Node smoke driver. The caller owns any container restart and should keep one
long-lived `tini -s` ancestor around the invocation.
USAGE
}

die() { printf 'cold-start validation: %s\n' "$*" >&2; exit 2; }
application=
evidence=
rscript=
source_suite=false
while (($#)); do
  case "$1" in
    --application|--evidence-dir|--rscript)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --application) application=$2 ;;
        --evidence-dir) evidence=$2 ;;
        --rscript) rscript=$2 ;;
      esac
      shift 2
      ;;
    --source-suite) source_suite=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[[ -n "$application" && -n "$evidence" && -n "$rscript" ]] || {
  usage >&2
  die "application, evidence directory, and Rscript are required"
}
for value in "$application" "$evidence" "$rscript"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* ]] ||
    die "paths must not contain control separators"
done
[[ "$rscript" == /* ]] || die "--rscript must be an absolute path"
for command_name in node Rscript sha256sum realpath shellcheck; do
  command -v "$command_name" >/dev/null || die "required container command is missing: $command_name"
done
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/../.." && pwd -P)
cd -- "$repo"
application=$(realpath -e -- "$application")
evidence=$(realpath -m -- "$evidence")
rscript=$(realpath -e -- "$rscript")
[[ -d "$application" ]] || die "application must be a directory"
[[ -x "$rscript" ]] || die "Rscript must be executable: $rscript"
manifest="$application/resources/manifest.json"
if [[ ! -f "$manifest" ]]; then manifest="$application/Resources/manifest.json"; fi
[[ -f "$manifest" ]] || die "staged application manifest is missing: $manifest"
node_binary=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.argv[1];
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!manifest.resources || typeof manifest.resources.nodeExecutable !== "string" || typeof manifest.resources.processSupervisorExecutable !== "string") process.exit(1);
process.stdout.write(resolve(root, manifest.resources.nodeExecutable));
' "$application" "$manifest") || die "manifest does not expose native application resources"
supervisor_binary=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.argv[1];
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(resolve(root, manifest.resources.processSupervisorExecutable));
' "$application" "$manifest") || die "manifest supervisor resource is invalid"
[[ -x "$node_binary" ]] || die "bundled Node executable is missing or not executable: $node_binary"
[[ -x "$supervisor_binary" ]] || die "bundled process supervisor is missing or not executable: $supervisor_binary"
manifest_sha=$(sha256sum -- "$manifest" | cut -d ' ' -f 1)
[[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || die "manifest SHA-256 could not be recorded"
if [[ -e "$evidence" ]] && [[ ! -d "$evidence" || -n $(find "$evidence" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  die "refusing nonempty evidence destination: $evidence"
fi
mkdir -p -- "$evidence"
smoke_evidence="$evidence/application-smoke"
mkdir -- "$smoke_evidence"
{
  printf 'started_utc=%s\nrepo=%s\napplication=%s\nmanifest=%s\nmanifest_sha256=%s\n' \
    "$(date -u +%FT%TZ)" "$repo" "$application" "$manifest" "$manifest_sha"
  printf 'process_supervisor=%s\nrscript=%s\nsource_suite_requested=%s\n' \
    "$supervisor_binary" "$rscript" "$source_suite"
  printf 'inherited_ALDER_TEST_FILTER=%q\ninherited_ALDER_TEST_LIB=%q\n' \
    "${ALDER_TEST_FILTER:-}" "${ALDER_TEST_LIB:-}"
} > "$evidence/00-provenance.txt"
sha256sum -- \
  "$script_dir/run-cold-start-validation.sh" \
  "$script_dir/run-static-gate.sh" "$script_dir/run-full-suite.R" \
  > "$evidence/00-driver-sha256.txt"
printf 'phase\tstarted_utc\tfinished_utc\texit_code\n' > "$evidence/00-phases.tsv"

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
  local prior=$? final_status=0 process_status=0 failed_phase=$current_phase
  trap - EXIT INT TERM HUP
  set +e
  if [[ -f "$smoke_evidence/process-lifecycle.json" ]]; then
    run_step 98-process-evidence node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const path = process.argv[1];
      const payload = JSON.parse(readFileSync(path, "utf8"));
      const identity = payload?.identity;
      if (payload?.id !== "process-lifecycle" || !identity) throw new Error("invalid process-lifecycle evidence identity");
      for (const key of ["lsp", "analyzer", "package", "r", "ark", "monitor", "quarto"]) {
        if (identity.processKinds?.[key] !== true) throw new Error("required process kind was not observed: " + key);
      }
      if (identity.hardKill?.clean !== true || identity.unrelatedSmokeDriver?.survivedHardKill !== true) throw new Error("process containment proof is incomplete");
      const graphs = [identity.host?.graphDuringRun, identity.analyzer?.graph, identity.lsp?.graph, identity.package?.graph, identity.publish?.graph, identity.hardKill?.graph];
      if (graphs.some(graph => !Array.isArray(graph) || graph.length === 0)) throw new Error("owned process evidence graph is missing");
      for (const graph of graphs) for (const record of graph) {
        if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || !Number.isSafeInteger(record?.ppid) || record.ppid < 0 || typeof record.startIdentity !== "string" || record.startIdentity.length === 0) throw new Error("owned process record lacks exact identity");
        if (record.startIdentity.startsWith("ps:") || record.startIdentity.startsWith("cim:")) throw new Error("rounded process identity persisted");
      }
    ' "$smoke_evidence/process-lifecycle.json"
    process_status=$?
  else
    printf 'process-lifecycle evidence is missing: %s\n' "$smoke_evidence/process-lifecycle.json" > "$evidence/98-process-evidence.log"
    process_status=1
  fi
  final_status=$prior
  if ((final_status == 0 && process_status != 0)); then
    final_status=$process_status
    failed_phase=98-process-evidence
  fi
  if [[ "$main_completed" != true ]] && ((final_status == 0)); then final_status=1; failed_phase=$current_phase; fi
  local outcome=failed
  if ((final_status == 0)); then outcome=passed; failed_phase=none; fi
  printf '{"status":"%s","exit_code":%s,"main_gates_completed":%s,"source_suite_requested":%s,"process_evidence_exit":%s,"failed_phase":"%s","application":"%s","manifest_sha256":"%s"}\n' \
    "$outcome" "$final_status" "$main_completed" "$source_suite" "$process_status" \
    "$failed_phase" "$application" "$manifest_sha" > "$evidence/99-result.json"
  printf 'Cold-start validation %s. Evidence: %s\n' "$outcome" "$evidence"
  exit "$final_status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

run_step 01-static bash "$script_dir/run-static-gate.sh"
if [[ "$source_suite" == true ]]; then
  run_step 02-source-suite env \
    ALDER_SUITE_EVIDENCE="$evidence/02-source-totals.json" \
    NOT_CRAN=true \
    "$rscript" --vanilla "$script_dir/run-full-suite.R"
  run_step 02b-source-totals node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const totals = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!(totals.tests > 0 && totals.expectations > 0)) throw new Error("source suite did not execute tests");
    if (["failed", "errors", "warnings", "skips"].some(key => totals[key] !== 0)) throw new Error("source suite is not clean: " + JSON.stringify(totals));
  ' "$evidence/02-source-totals.json"
fi
run_step 03-process-lifecycle "$node_binary" "$repo/host/scripts/smoke-application.mjs" \
  "$application" --scenario process-lifecycle --evidence "$smoke_evidence" --rscript "$rscript"
run_step 04-manifest-provenance node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  const path = process.argv[1];
  const expected = process.argv[2];
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw new Error("staged application manifest changed during review");
' "$manifest" "$manifest_sha"
run_step 05-driver-provenance sha256sum --check "$evidence/00-driver-sha256.txt"
main_completed=true
