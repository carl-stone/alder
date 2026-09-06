# dev

Developer documentation for alder. Named `dev/` rather than `docs/` because `docs/` is the pkgdown site directory in R packages.

Review scripts and written reports are versioned. Generated
`reviews/evidence/` runs (logs, screenshots, profiles, fixture notebooks, package
archives and caches) are retained locally and ignored by Git. Evidence links in
these documents refer to those local runs; a fresh checkout can generate new
evidence using the documented drivers. CI uploads its latency evidence as a
workflow artifact.

- `VISION.md` (repo root) — the product brief (the spec).
- `ARCHITECTURE.md` — accepted target architecture, responsiveness requirements,
  ownership boundaries and phased migration from the current R host to TypeScript.
- `reviews/INPUT-LATENCY.md` — input-to-visible-result benchmark and profiling
  contract, reproduction commands and baseline evidence.
- `USER_FLOWS.md` and `NORTH_STAR_RUBRIC.md` (repo root) — observable release
  flows and the North Star scoring/gate contract.
- `decisions/` — accepted architecture decision records (ADRs). Start at `decisions/index.md`.
- `open-questions.md` — unresolved questions and deferred decisions, tracked separately because only accepted decisions are ADRs.
- `reviews/RELEASE-0.1.0.md` — current release decision and final gate evidence.
- `reviews/` — repeatable review probes, evidence artifacts, and the finding
  ledger used by the four-cycle release gate. Its shared drivers run the exact
  static, unfiltered-suite, and source-package-check gates used for integrated
  and cold-start validation.
- `reviews/evidence/release-completion/environment-restore/README.md` — recorded
  recovery of the Ubuntu/R 4.6.1 validation toolchain, including verified
  Quarto 1.10.18 installation, retained package sources/version receipts, and
  the login-shell PATH required by the base image's Node/npm installation.
- `reviews/run-package-check.sh` rebuilds the source package by default. To run
  the same manifest, `R CMD check`, and installed test-summary gates against an
  existing exact artifact, set `ALDER_CHECK_ARTIFACT` to an existing
  `alder_*.tar.gz` path. The artifact is copied into the empty evidence
  directory and source/copy SHA-256 digests are recorded before copying and
  again after the package check.
- `reviews/run-cold-start-validation.sh` runs one complete automated cold-start
  cycle against a supplied source artifact and SHA-256. It requires a new or
  empty evidence directory, a separate private audit root outside the repository,
  and one long-lived `tini -s` ancestor. The caller restarts the container before
  each cycle. The driver runs static checks, source/artifact verification, all
  22 installed audit phases, and exact `R CMD check` with its full installed
  browser/test suite. Add `--source-suite` when the unfiltered source suite has
  not already passed for the frozen source; omit it for subsequent cycles.
  Test filters and stale test-library overrides are cleared. Each phase retains
  its command, log, timestamps, and exit status; `99-result.json` reports the
  combined outcome. Failures still run the final resource observer and remain
  failures. Generated screenshots require the separate visual review.
- `reviews/audit-cold-start-processes.py` is the driver's read-only resource
  observer. Baseline and final snapshots require zero zombies and no remaining
  R/Alder/LSP/Chrome/processx workloads. The final snapshot additionally rejects
  newly created live processes, newly opened TCP listeners, and any still-open
  port recorded in validation evidence. It never kills processes or restarts
  the container.
- `reviews/verify-source-artifact.R` — read-only source-package verifier. Run
  `Rscript dev/reviews/verify-source-artifact.R ARTIFACT REPO [OUTPUT_LOG]` to
  check the single `alder/` archive root, regular-file inventory, repository
  byte identity, normalized DESCRIPTION DCF semantics, required package-facing
  files, and exclusion of task/review/CI/JavaScript/debris files. `R CMD build`
  metadata (`Packaged`, `NeedsCompilation`, `Author`, and `Maintainer`) is
  reported separately and validated as build-added metadata.
- `reviews/regression-verify-source-artifact.R` — isolated verifier regression.
  It checks the preserved cycle-4 candidate v5 and deliberate first/middle/last
  byte-candidate mutations, including exact mismatch paths and exit statuses.
- `reviews/probe-json-resilience.R` — installed-artifact B-102 probe. With
  `ALDER_JSON_RESILIENCE_ARTIFACT`, `ALDER_JSON_RESILIENCE_SHA256`, and
  `ALDER_JSON_RESILIENCE_LIB` (and optionally the installed
  `ALDER_JSON_RESILIENCE_CLI`), it times the complete JSON body reader across
  file-widget uploads through just under 16 MiB and repeats bounded malformed
  JSON cases, then replays a near-ceiling production `/api/upload` through a
  separate installed CLI/server with operation settlement and teardown checks.
  Cycle-4 phase 20 runs it against the audit's exact private library and
  artifact.
- `reviews/probe-release-safety.R` — installed-artifact B-105--B-108 and
  B-120--B-121 replay. Cycle-4 phase 21 verifies single-pass `alder_test()`
  execution; rejects canonical/symlink/hard-link export, conversion, and render
  aliases without touching source bytes or invoking an engine; rejects blocking
  headless diagnostics before effects or destination replacement; checks staged
  replacement and failure preservation; enforces exact revision integers through
  local MCP, URL MCP, real HTTP, and Session; and verifies both 1 MiB and 16 MiB
  overflow diagnostics. The probe owns and cleans its fixtures and records a
  compact JSON summary beside its transcript.
- `parity-demo.R` — a broad, runnable notebook fixture for scientific-output
  and interaction reviews.
- `examples/bulk-differential-expression.R` — a substantial, self-contained
  bulk RNA-seq notebook: 6,000 simulated genes, 24 independent samples, batch-adjusted
  edgeR quasi-likelihood testing, QC and interactive results. Optional dependencies
  are `edgeR`, `statmod` and `ggplot2`; install edgeR with
  `BiocManager::install("edgeR")` and the CRAN packages with `install.packages()`.
  Launch with `alder dev/examples/bulk-differential-expression.R` from the repository.
  This is a synthetic software-validation example, not a biological finding.
  The opt-in audit is `reviews/run-bulk-de-scale.sh`; it compares full result
  tables with ordinary R, drives the installed browser, and checks cleanup.
  Run inside `codex-universal` under `tini -s`, with an empty evidence directory
  and an explicitly supplied source archive matching the current package:
  `tini -s -- bash dev/reviews/run-bulk-de-scale.sh /tmp/bulk-de-evidence /path/to/alder_0.1.0.tar.gz`.
  The audit additionally requires `chromote`, Chrome, `curl` and `digest`.
  See [the scale review](reviews/BULK-DE-SCALE.md) for measurements and evidence.
- `../inst/examples/iris.R` — the installed Iris tutorial, using Alder and base
  R only; the README explains how to copy and launch it from any installation.
- `../NEWS.md` — package release notes.

After the caller's independent container restart, one cold-start invocation is:

```sh
docker exec -i -w /workspace/alder codex-universal bash -lc \
  'tini -s -- bash dev/reviews/run-cold-start-validation.sh \
    --artifact /workspace/alder/dev/reviews/evidence/CANDIDATE/alder_0.1.0.tar.gz \
    --sha256 RECORDED_64_CHARACTER_SHA256 \
    --evidence-dir /workspace/alder/dev/reviews/evidence/cold-start-1 \
    --audit-root /tmp/alder-cold-start-1 --source-suite'
```

Use new paths for the second independently restarted cycle. Both cycles always
run the complete installed suite through package check.
