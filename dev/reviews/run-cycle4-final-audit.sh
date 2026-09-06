#!/usr/bin/env bash
set -euo pipefail

# Reusable Cycle-4 final-release audit driver. This script is intentionally
# evidence-preserving: it never removes a caller-owned artifact, audit root, or
# evidence directory. Build/package creation is deliberately outside this
# driver; the caller supplies the immutable source tarball and its handoff hash.

usage() {
  cat >&2 <<'USAGE'
usage: run-cycle4-final-audit.sh \
  --artifact PATH --sha256 HEX64 --audit-root DIR --evidence-dir DIR

The four values may also be supplied with ALDER_FINAL_AUDIT_ARTIFACT,
ALDER_FINAL_AUDIT_SHA256, ALDER_FINAL_AUDIT_ROOT, and
ALDER_FINAL_AUDIT_EVIDENCE. Every destination must be new or empty.
USAGE
}

die() {
  printf 'run-cycle4-final-audit: %s\n' "$*" >&2
  exit 2
}

artifact=${ALDER_FINAL_AUDIT_ARTIFACT:-}
expected_sha=${ALDER_FINAL_AUDIT_SHA256:-}
audit_root=${ALDER_FINAL_AUDIT_ROOT:-}
evidence=${ALDER_FINAL_AUDIT_EVIDENCE:-}

while (($#)); do
  case "$1" in
    --artifact)
      (($# >= 2)) || die "--artifact requires a path"
      artifact=$2
      shift 2
      ;;
    --sha256)
      (($# >= 2)) || die "--sha256 requires a SHA-256 digest"
      expected_sha=$2
      shift 2
      ;;
    --audit-root)
      (($# >= 2)) || die "--audit-root requires a directory"
      audit_root=$2
      shift 2
      ;;
    --evidence-dir)
      (($# >= 2)) || die "--evidence-dir requires a directory"
      evidence=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$artifact" ]] || { usage; die "an immutable artifact is required"; }
[[ -n "$expected_sha" ]] || { usage; die "an expected SHA-256 is required"; }
[[ -n "$audit_root" ]] || { usage; die "an isolated audit root is required"; }
[[ -n "$evidence" ]] || { usage; die "an evidence directory is required"; }
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] ||
  die "expected SHA-256 must be exactly 64 hexadecimal characters"

# The driver is for the documented universal image. Requiring the release
# toolchain here makes accidental host execution fail before any destination
# is created, while avoiding a brittle hostname check (the image hostname is
# intentionally ephemeral).
for command_name in R Rscript quarto pandoc google-chrome tini ps ss sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "must run inside codex-universal; required command is missing: $command_name"
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/../.." && pwd -P)
[[ -d "$repo_root" ]] || die "repository root does not exist: $repo_root"

artifact=$(realpath -- "$artifact")
[[ -f "$artifact" ]] || die "artifact is not a regular file: $artifact"

# realpath -m permits a not-yet-created destination while still canonicalizing
# existing parents. The emptiness checks below prevent accidental evidence
# mixing and make the private library genuinely isolated for this run.
audit_root=$(realpath -m -- "$audit_root")
evidence=$(realpath -m -- "$evidence")
[[ "$audit_root" != "$evidence" ]] ||
  die "audit root and evidence directory must be different paths"
case "$audit_root/" in
  "$evidence/"*) die "audit root must not be inside the evidence directory" ;;
esac
case "$evidence/" in
  "$audit_root/"*) die "evidence directory must not be inside the audit root" ;;
esac

for required_path in \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/probe-api-docs.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/probe-broad-r.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/probe-cleanup.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/finalize-evidence.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-accepted-probe.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-diagnostic-probe.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-mcp-url-replay.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-signal-during-request-replay.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/probe-layout-boundary-final.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/probe-layout-accessibility.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/layout-widget-notebook-interaction.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/layout-accessibility-notebook.R" \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/security-boundary-before/probe-security-boundary.R" \
  "$repo_root/dev/reviews/probe-json-resilience.R" \
  "$repo_root/dev/reviews/probe-release-safety.R" \
  "$repo_root/dev/reviews/probe-mcp-framing.R"; do
  [[ -f "$required_path" ]] || die "required audit path is missing: $required_path"
done

prepare_empty_dir() {
  local directory=$1
  if [[ -e "$directory" && ! -d "$directory" ]]; then
    die "destination is not a directory: $directory"
  fi
  local first_entry
  if [[ -d "$directory" ]]; then
    first_entry=$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)
  else
    first_entry=
  fi
  if [[ -n "$first_entry" ]]; then
    die "refusing to mix evidence in nonempty directory: $directory"
  fi
  mkdir -p -- "$directory"
}

prepare_empty_dir "$audit_root"
prepare_empty_dir "$evidence"
review_lib=$audit_root/lib
mkdir -- "$review_lib"

actual_sha=$(sha256sum "$artifact" | awk '{print $1}')
[[ "$actual_sha" == "$expected_sha" ]] ||
  die "artifact SHA-256 mismatch: expected $expected_sha, received $actual_sha"
{
  printf 'artifact=%s\n' "$artifact"
  printf 'expected_sha256=%s\n' "$expected_sha"
  printf 'observed_sha256=%s\n' "$actual_sha"
} > "$evidence/00-artifact-sha256.txt"

zombie_baseline=$(ps -eo stat= | awk '$1 ~ /^Z/ { count++ } END { print count + 0 }')
printf '%s\n' "$zombie_baseline" > "$evidence/00-zombie-baseline.txt"
find /tmp -maxdepth 1 -mindepth 1 -type d -name 'alder-mcp-artifacts-*' \
  -print | sort > "$evidence/00-mcp-temp-baseline.txt"
ps -eo pid=,ppid=,stat=,args= > "$evidence/00-process-baseline.txt"
ss -H -ltn > "$evidence/00-sockets-baseline.txt"
{
  printf 'runtime='; Rscript --vanilla -e 'cat(R.version.string)'
  printf 'repo=%s\n' "$repo_root"
  printf 'audit_root=%s\n' "$audit_root"
  printf 'evidence=%s\n' "$evidence"
  printf 'private_library=%s\n' "$review_lib"
} > "$evidence/00-environment.log"

port_in_use() {
  local port=$1
  [[ -n "$(ss -H -ltn "sport = :$port" 2>/dev/null)" ]]
}

allocate_port() {
  local candidate=$1
  while ((candidate < 20000)); do
    if ! port_in_use "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  die "could not find a free TCP port in the audit range"
}

port_seed=$((18980 + ($$ % 1000)))
layout_port=$(allocate_port "$port_seed")
a11y_port=$(allocate_port "$((layout_port + 1))")
[[ "$layout_port" != "$a11y_port" ]] || die "layout and accessibility ports collided"
{
  printf 'layout_boundary_port=%s\n' "$layout_port"
  printf 'accessibility_port=%s\n' "$a11y_port"
} > "$evidence/00-ports.txt"

export ALDER_FINAL_AUDIT_ROOT="$audit_root"
export ALDER_FINAL_AUDIT_EVIDENCE="$evidence"
export ALDER_FINAL_AUDIT_REPO="$repo_root"
export ALDER_FINAL_AUDIT_ARTIFACT="$artifact"
export ALDER_FINAL_AUDIT_SHA256="$expected_sha"

run_probe() {
  local label=$1
  shift
  printf '\n===== %s =====\n' "$label"
  "$@" 2>&1 | tee "$evidence/$label.log"
}

cleanup_started=0
cleanup_status=0
finalize_started=0
finalize_status=0
finish_once() {
  local prior_status=$1
  local cleanup_exit=0
  local finalize_exit=0
  if ((cleanup_started == 0)); then
    cleanup_started=1
    set +e
    run_probe "99-cleanup" env \
      R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
      Rscript --vanilla \
      "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/probe-cleanup.R"
    cleanup_exit=$?
    set -e
    cleanup_status=$cleanup_exit
  fi
  if ((finalize_started == 0)); then
    finalize_started=1
    set +e
    run_probe "100-finalize-evidence" env \
      ALDER_FINALIZE_TRANSCRIPT=100-finalize-evidence.log \
      R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
      Rscript --vanilla \
      "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/finalize-evidence.R"
    finalize_exit=$?
    set -e
    finalize_status=$finalize_exit
  fi
  if ((prior_status == 0)); then
    if ((cleanup_status != 0)); then
      prior_status=$cleanup_status
    elif ((finalize_status != 0)); then
      prior_status=$finalize_status
    fi
  fi
  return "$prior_status"
}
# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap.
cleanup_on_exit() {
  local prior_status=$?
  local final_status=0
  set +e
  finish_once "$prior_status"
  final_status=$?
  set -e
  trap - EXIT
  exit "$final_status"
}
trap cleanup_on_exit EXIT

# Installing from the checked artifact into a newly created private library is
# the only package mutation this driver performs. Every probe receives that
# same library and the same artifact/hash environment.
run_probe "01-install" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  R CMD INSTALL --no-multiarch --with-keep.source --library="$review_lib" "$artifact"
[[ -d "$review_lib/alder" ]] || die "private Alder installation was not created"
actual_sha=$(sha256sum "$artifact" | awk '{print $1}')
[[ "$actual_sha" == "$expected_sha" ]] ||
  die "artifact changed during installation: received $actual_sha"
printf 'post_install_sha256=%s\n' "$actual_sha" >> "$evidence/00-artifact-sha256.txt"

# Several frozen release probes intentionally exercise the user-installed
# command at <audit-root>/bin/alder. Create it once from the exact private
# package and keep its installation transcript separate from package install.
run_probe "01b-install-main-cli" env \
  ALDER_FINAL_AUDIT_BIN="$audit_root/bin" \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla -e \
  'dir.create(Sys.getenv("ALDER_FINAL_AUDIT_BIN"), recursive = TRUE, showWarnings = FALSE); library(alder); alder_install_cli(Sys.getenv("ALDER_FINAL_AUDIT_BIN"))'
[[ -x "$audit_root/bin/alder" ]] || \
  die "canonical audit CLI was not installed: $audit_root/bin/alder"

# The frozen conversion/policy audit inspects the source package directly as
# well as the installed namespace. Extract this same checked tarball beneath
# the disposable audit root; a valid R source package has one `alder/` root.
run_probe "01c-extract-source" tar -xzf "$artifact" -C "$audit_root"
[[ -f "$audit_root/alder/DESCRIPTION" ]] || \
  die "artifact did not extract an alder source root"

run_probe "02-api-docs" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/probe-api-docs.R"
run_probe "03-broad-r" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/probe-broad-r.R"
diagnostic_evidence="$evidence/diagnostic-policy"
mkdir -- "$diagnostic_evidence"
run_probe "04-diagnostic-policy" env \
  ALDER_DIAGNOSTIC_LIB="$review_lib" \
  ALDER_DIAGNOSTIC_EVIDENCE="$diagnostic_evidence" \
  ALDER_DIAGNOSTIC_PROBE="$repo_root/dev/reviews/evidence/diagnostic-policy-cycle-2/probe.R" \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-diagnostic-probe.R"

# Accepted Cycle-3 replay set, then the corrected Cycle-4 release set. The
# wrapper scripts substitute the caller's root/evidence/artifact paths into
# their frozen scientific templates.
run_probe "05-accepted-cli-http" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-accepted-probe.R" cli-http
run_probe "06-accepted-publishing-source" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-accepted-probe.R" publishing-source
run_probe "07-accepted-report-visuals" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-accepted-probe.R" report-visuals
run_probe "08-cycle4-install-cli" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" install-cli
run_probe "09-cycle4-cache-renv" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" cache-renv
run_probe "10-cycle4-mcp-parity" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" mcp-parity
run_probe "11-cycle4-repeat-convert-policy" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" repeat-convert-policy
run_probe "12-cycle4-report-visuals" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" report-visuals
run_probe "13-cycle4-extract-report-images" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-cycle4-probe.R" extract-report-images

# B-86/B-89 replay the accepted MCP URL settlement and run-scope flows against
# this exact private install. Their wrappers substitute only caller paths,
# artifact/hash, and evidence destinations, then hard-fail every canonical
# assertion before the layout probes begin.
run_probe "14-b86-mcp-url-replay" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-mcp-url-replay.R" b86
run_probe "15-b89-mcp-url-replay" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-mcp-url-replay.R" b89
run_probe "16-b92-signal-during-request" env R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla \
  "$repo_root/dev/reviews/evidence/cycle-4/final-release-audit/run-signal-during-request-replay.R"

# B-87/B-88 and B-91 use disposable fixture copies and distinct ports, while
# still resolving the exact same installed package as every release probe.
layout_evidence="$evidence/b87-b88-layout-boundary"
a11y_evidence="$evidence/b91-accessibility"
mkdir -- "$layout_evidence" "$a11y_evidence"
cp -- \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/layout-widget-notebook-interaction.R" \
  "$layout_evidence/layout-widget-notebook-interaction.R"
cp -- \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/layout-accessibility-notebook.R" \
  "$a11y_evidence/layout-accessibility-notebook.R"

run_probe "17-b87-b88-layout-boundary" env \
  ALDER_LAYOUT_EVIDENCE="$layout_evidence" \
  ALDER_LAYOUT_LIB="$review_lib" \
  ALDER_LAYOUT_ARTIFACT="$artifact" \
  ALDER_LAYOUT_PORT="$layout_port" \
  ALDER_LAYOUT_REQUIRE_PASS=true \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/probe-layout-boundary-final.R"
run_probe "18-b91-accessibility" env \
  ALDER_A11Y_EVIDENCE="$a11y_evidence" \
  ALDER_A11Y_NOTEBOOK="$a11y_evidence/layout-accessibility-notebook.R" \
  ALDER_A11Y_ARTIFACT="$artifact" \
  ALDER_A11Y_LIB="$review_lib" \
  ALDER_A11Y_PORT="$a11y_port" \
  ALDER_A11Y_REQUIRE_PASS=true \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/layout-widget-after/probe-layout-accessibility.R"

# RS-01/RS-02 replay the exact Origin-less network and malformed client-log
# requests that compromised the prior immutable artifact. The corrected
# contract rejects non-loopback startup, strictly rejects malformed log
# objects, emits a valid multiline report as one physical record, and leaves
# its loopback process/port closed.
security_evidence="$evidence/security-boundary"
mkdir -- "$security_evidence"
run_probe "19-security-boundary" env \
  ALDER_SECURITY_ARTIFACT="$artifact" \
  ALDER_SECURITY_SHA256="$expected_sha" \
  ALDER_SECURITY_LIB="$review_lib" \
  ALDER_SECURITY_CLI="$audit_root/bin/alder" \
  ALDER_SECURITY_EVIDENCE="$security_evidence" \
  ALDER_SECURITY_EXPECT=after \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla \
  "$repo_root/dev/reviews/evidence/cycle-4/repairs/security-boundary-before/probe-security-boundary.R"

# B-102 exercises the installed private artifact directly. It keeps the
# original file-widget JSON shape while timing the complete body reader at
# upload-scale sizes and repeatedly checking bounded malformed inputs.
run_probe "20-b102-json-resilience" env \
  ALDER_JSON_RESILIENCE_ARTIFACT="$artifact" \
  ALDER_JSON_RESILIENCE_SHA256="$expected_sha" \
  ALDER_JSON_RESILIENCE_LIB="$review_lib" \
  ALDER_JSON_RESILIENCE_CLI="$audit_root/bin/alder" \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/probe-json-resilience.R"

# B-105 through B-108 replay the exact v6 test duplication, destructive
# output alias, malformed revision, and misleading upload-limit boundaries.
# B-120/B-121 extend the same installed-artifact probe to blocking diagnostics
# in direct Pandoc/Quarto and Session exports and inode-safe Pandoc/Quarto
# render aliases. The probe requires exactly 262 assertions.
run_probe "21-b105-b108-release-safety" env \
  ALDER_RELEASE_SAFETY_ARTIFACT="$artifact" \
  ALDER_RELEASE_SAFETY_SHA256="$expected_sha" \
  ALDER_RELEASE_SAFETY_LIB="$review_lib" \
  ALDER_RELEASE_SAFETY_CLI="$audit_root/bin/alder" \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/probe-release-safety.R"

# B-109--B-122 exercise raw live-pipe MCP framing, lifecycle, startup-policy,
# failed/abandoned negotiation, startup failure, early-EOF, and protocol
# envelopes against the exact installed artifact. The probe requires exactly
# 286 assertions, accepts the exact cap, and bounds RSS and response time while
# draining a much larger line, rejects ambiguous/hostile frames with exact
# errors, verifies notification/request kind, exact safe IDs, method params,
# initialization, and a valid request surviving while stdin is open through
# both local path and loopback URL contexts.
run_probe "22-b109-mcp-framing" env \
  ALDER_MCP_FRAMING_ARTIFACT="$artifact" \
  ALDER_MCP_FRAMING_SHA256="$expected_sha" \
  ALDER_MCP_FRAMING_LIB="$review_lib" \
  ALDER_MCP_FRAMING_ROOT="$audit_root" \
  ALDER_MCP_FRAMING_EVIDENCE="$evidence/b109-mcp-framing" \
  R_LIBS="$review_lib" R_LIBS_USER="$review_lib" R_TESTS= \
  Rscript --vanilla "$repo_root/dev/reviews/probe-mcp-framing.R"

# Run cleanup and finalization explicitly on the success path too; the EXIT
# trap is the failure-path guarantee. Removing it before returning avoids a
# second cleanup or finalization run.
actual_sha=$(sha256sum "$artifact" | awk '{print $1}')
[[ "$actual_sha" == "$expected_sha" ]] ||
  die "artifact changed during the final audit: received $actual_sha"
printf 'pre_cleanup_sha256=%s\n' "$actual_sha" >> "$evidence/00-artifact-sha256.txt"
final_status=0
set +e
finish_once 0
final_status=$?
set -e
trap - EXIT
if ((final_status == 0)); then
  printf '\nCycle-4 final-release audit completed. Evidence: %s\n' "$evidence"
fi
exit "$final_status"
