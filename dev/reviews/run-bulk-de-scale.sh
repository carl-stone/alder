#!/usr/bin/env bash
set -euo pipefail

# Run the frozen host/scripts/probe-bulk-de-scale.mjs workload against one
# already staged application. The probe owns the browser/controller lifecycle
# and writes result.json, complete.json, and cleanup.json in the evidence tree.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/../.." && pwd -P)
cd -- "$repo"
if (($# < 2 || $# > 3)); then
  echo "usage: run-bulk-de-scale.sh EMPTY_EVIDENCE_DIR APPLICATION_ROOT [ABSOLUTE_RSCRIPT]" >&2
  exit 2
fi
evidence=$1
application=$2
rscript=${3:-${ALDER_RSCRIPT:-}}
for value in "$evidence" "$application" "$rscript"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* ]] || {
    echo "paths must not contain control separators" >&2
    exit 2
  }
done
evidence=$(realpath -m -- "$evidence")
application=$(realpath -e -- "$application")
if [[ -n "$rscript" && "$rscript" != /* ]]; then
  echo "Rscript must be an absolute path: $rscript" >&2
  exit 2
fi
if [[ -n "$rscript" ]]; then rscript=$(realpath -e -- "$rscript"); fi
[[ -d "$application" ]] || { echo "application must be a directory: $application" >&2; exit 2; }
if [[ -n "$rscript" && ! -x "$rscript" ]]; then
  echo "Rscript must be executable: $rscript" >&2
  exit 2
fi
for command_name in node sha256sum realpath; do
  command -v "$command_name" >/dev/null || { echo "required container command is missing: $command_name" >&2; exit 2; }
done
manifest="$application/resources/manifest.json"
if [[ ! -f "$manifest" ]]; then manifest="$application/Resources/manifest.json"; fi
[[ -f "$manifest" ]] || { echo "staged application manifest is missing: $manifest" >&2; exit 2; }
node_binary=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.argv[1];
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!manifest.resources || typeof manifest.resources.nodeExecutable !== "string" || typeof manifest.resources.processSupervisorExecutable !== "string") process.exit(1);
process.stdout.write(resolve(root, manifest.resources.nodeExecutable));
' "$application" "$manifest") || { echo "manifest does not expose native application resources" >&2; exit 2; }
supervisor_binary=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.argv[1];
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(resolve(root, manifest.resources.processSupervisorExecutable));
' "$application" "$manifest") || { echo "manifest supervisor resource is invalid" >&2; exit 2; }
[[ -x "$node_binary" ]] || { echo "bundled Node executable is missing or not executable: $node_binary" >&2; exit 2; }
[[ -x "$supervisor_binary" ]] || { echo "bundled process supervisor is missing or not executable: $supervisor_binary" >&2; exit 2; }
if [[ -e "$evidence" ]] && [[ ! -d "$evidence" || -n $(find "$evidence" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo "refusing nonempty evidence destination: $evidence" >&2
  exit 2
fi
mkdir -p -- "$evidence"
source_fixture="$repo/dev/examples/bulk-differential-expression.R"
probe="$repo/host/scripts/probe-bulk-de-scale.mjs"
[[ -f "$source_fixture" && -f "$probe" ]] || { echo "bulk workload source or probe is missing" >&2; exit 2; }
manifest_sha=$(sha256sum -- "$manifest" | cut -d ' ' -f 1)
{
  printf 'started_utc=%s\nrepo=%s\napplication=%s\nmanifest=%s\nmanifest_sha256=%s\n' \
    "$(date -u +%FT%TZ)" "$repo" "$application" "$manifest" "$manifest_sha"
  printf 'process_supervisor=%s\nrscript=%s\n' "$supervisor_binary" "${rscript:-environment-selected}"
} > "$evidence/00-provenance.txt"
sha256sum -- "$source_fixture" "$probe" "$script_dir/run-bulk-de-scale.sh" "$manifest" > "$evidence/input-sha256.txt"

probe_status=0
probe_args=("$probe" --application "$application" --evidence "$evidence")
if [[ -n "$rscript" ]]; then probe_args+=(--rscript "$rscript"); fi
if "$node_binary" "${probe_args[@]}" > "$evidence/probe.log" 2>&1; then
  probe_status=0
else
  probe_status=$?
fi

finish() {
  local prior=$? final_status=$prior proof_status=0 hash_status=0
  trap - EXIT INT TERM HUP
  set +e
  if [[ -f "$evidence/result.json" && -f "$evidence/complete.json" && -f "$evidence/cleanup.json" ]]; then
    "$node_binary" --input-type=module -e '
      import { readFileSync } from "node:fs";
      const [resultPath, completePath, cleanupPath] = process.argv.slice(1);
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const complete = JSON.parse(readFileSync(completePath, "utf8"));
      const cleanup = JSON.parse(readFileSync(cleanupPath, "utf8"));
      if (result?.id !== "bulk-de-scale" || result.passed !== true) throw new Error("bulk probe did not pass");
      if (complete?.complete !== true) throw new Error("bulk probe did not write complete evidence");
      if (!cleanup || typeof cleanup !== "object" || (Object.hasOwn(cleanup, "error") && cleanup.error !== null)) throw new Error("bulk cleanup evidence is incomplete");
      const details = result.cleanup;
      if (!details || typeof details !== "object" || details.forced === true) throw new Error("bulk cleanup was forced or absent");
      if (details.stop?.forced === true || details.descendants?.forced === true) throw new Error("bulk cleanup forced process termination");
      if (details.ownerRetired !== true && details.shutdown !== true) throw new Error("bulk owner retirement was not proven");
    ' "$evidence/result.json" "$evidence/complete.json" "$evidence/cleanup.json" > "$evidence/98-process-evidence.log" 2>&1
    proof_status=$?
  else
    printf 'bulk probe evidence is incomplete\n' > "$evidence/98-process-evidence.log"
    proof_status=1
  fi
  sha256sum --check "$evidence/input-sha256.txt" > "$evidence/final-input-correspondence.log" 2>&1
  hash_status=$?
  if ((final_status == 0 && probe_status != 0)); then final_status=$probe_status; fi
  if ((final_status == 0 && proof_status != 0)); then final_status=$proof_status; fi
  if ((final_status == 0 && hash_status != 0)); then final_status=$hash_status; fi
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const [path, execution, probe, proof, hash, application, manifest] = process.argv.slice(1);
    const status = Number(execution) || Number(probe) || Number(proof) || Number(hash);
    writeFileSync(path, JSON.stringify({ execution_exit: Number(execution), probe_exit: Number(probe), process_evidence_exit: Number(proof), correspondence_exit: Number(hash), application, manifest_sha256: manifest, status }, null, 2) + "\n");
  ' "$evidence/99-driver-result.json" "$prior" "$probe_status" "$proof_status" "$hash_status" "$application" "$manifest_sha"
  if ((final_status != 0)); then exit "$final_status"; fi
  printf 'Bulk differential-expression review passed. Evidence: %s\n' "$evidence"
  exit 0
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Keep the process result as the command's status while allowing finish() to
# persist cleanup/provenance evidence and report the first failing gate.
if ((probe_status != 0)); then exit "$probe_status"; fi
