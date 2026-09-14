# Development

[ARCHITECTURE.md](ARCHITECTURE.md) describes the host, Ark integration and
remaining release acceptance criteria.
Runtime behavior is specified by the code, installed R help and tests.
Historical task specs, ADRs and release-review transcripts are in Git history.

## Checks

Edit files and use Git on the host. In this workspace, run the commands below
inside `codex-universal` at `/workspace/alder`:

```sh
sudo docker exec -i -w /workspace/alder codex-universal bash -lc '<command>'
```

The full toolchain includes R 4.6.1, package Suggests, Node/npm, Chrome, Quarto,
Pandoc, Python 3, ShellCheck and tini. Verification runs locally; GitHub Actions are removed.

```sh
npm ci --prefix js
npm run build --prefix js # type-check and bundle the CodeMirror adapter
Rscript -e 'roxygen2::roxygenise()'
tini -s -- bash dev/reviews/run-static-gate.sh
tini -s -- bash dev/reviews/run-package-check.sh
```

The static gate checks bundle reproducibility, syntax and lint.
The package gate builds, installs and runs `R CMD check` with the browser suite;
use a fresh `ALDER_CHECK_EVIDENCE` directory for each run. It can check a frozen
archive supplied as `ALDER_CHECK_ARTIFACT`. Source workers and browser tests need
a matching installed package; installing in a private library and exporting
`R_LIBS_USER` avoids accidentally testing another version.

For source package tests after installing that version:

```sh
tini -s -- Rscript -e 'testthat::test_local(stop_on_failure = TRUE)'
```

The application host has its own pinned toolchain and lockfile. Build one staged artifact in the prescribed container; the launcher, helper library, Ark/Air binaries, native supervisor, Node runtime and renderer are all relocated resources (no checkout discovery or first-use installation). Restore only `host/r-library.lock.json`; do not run a broad R dependency installer:

```sh
npm ci --prefix js && npm ci --prefix host
npm run build --prefix js && npm run build --prefix host
node host/scripts/fetch-ark.mjs --archive-output host/.runtime/ark.zip
node host/scripts/fetch-air.mjs
rscript461=/absolute/path/to/R-4.6.1/bin/Rscript
rscript460=/absolute/path/to/R-4.6.0/bin/Rscript
supervisor=/absolute/path/to/alder-process-supervisor
supervisor_provenance=/absolute/path/to/process-supervisor-provenance.json
node host/scripts/stage-application.mjs --output host/.application --kind headless \
  --rscript "$rscript461" --qualified-rscript "$rscript460" \
  --supervisor "$supervisor" --supervisor-provenance "$supervisor_provenance"
```

The stage command is strict: its output directory must be empty, both runtime locks and the application-only R lock must be present, the selected R helper closure must match `host/r-library.lock.json`, and every staged byte is recorded in `resources/manifest.json`. Use `--qualified-rscript` once per additional R 4.6.x interpreter.

Run every acceptance scenario against the actual relocated launcher and authenticated browser/session surface:

```sh
node host/scripts/smoke-application.mjs host/.application --scenario all \
  --evidence /tmp/alder-v1a-evidence --rscript "$rscript461" --peer-rscript "$rscript460"
```

Desktop staging is a separate Electron lane. Run Forge make to produce the unpacked application and native installer artifacts, then stage that exact root (including `resources/app.asar`):

```sh
npm run make --prefix desktop
node host/scripts/stage-application.mjs --output host/.application-desktop --kind desktop \
  --forge-output desktop/out/Alder-linux-x64 --electron-entry desktop/out/Alder-linux-x64/alder-desktop \
  --rscript "$rscript461" --qualified-rscript "$rscript460" \
  --supervisor "$supervisor" --supervisor-provenance "$supervisor_provenance"
```

Produce the required dual-variant release only after both staged trees qualify, then run the complete installed/relocated matrix for each variant:

```sh
node host/scripts/build-qualification-sidecar.mjs --output /tmp/alder-qualification \
  --application host/.application --source "$PWD"
node host/scripts/ci-package.mjs --output /tmp/alder-release --evidence /tmp/alder-package-evidence \
  --rscript "$rscript461" --qualified-rscript "$rscript460" \
  --forge-output desktop/out/Alder-linux-x64 --electron-entry desktop/out/Alder-linux-x64/alder-desktop \
  --forge-make-output desktop/out/make
node host/scripts/smoke-release.mjs /tmp/alder-release --evidence /tmp/alder-installed-evidence \
  --rscript "$rscript461" --peer-rscript "$rscript460" \
  --artifact-root "$artifact_root" \
  --qualification-driver /opt/alder-qualification/driver/scripts/smoke-application.mjs \
  --qualification-source /opt/alder-qualification/source \
  --qualification-manifest-sha256 "$qualification_manifest_sha256" \
  "${artifact_digest_args[@]}" "${native_identity_args[@]}" \
  "${installed_application_args[@]}" "${installation_receipt_args[@]}" \
  "${installation_receipt_digest_args[@]}"
```

The sidecar under `/opt` must be moved there and made recursively root-owned and
non-writable after its manifest digest is captured; qualification itself runs as
an unprivileged identity. Each native installable supplies repeated
`--installed-application variant/artifact=absolute-root`,
`--installation-receipt variant/artifact=absolute-json`, and
`--expected-installation-receipt-sha256 variant/artifact=digest` arguments. The
externally anchored receipt records the exact artifact name and SHA-256, native
installer command and exit status, inventoried installer actions, runner
identity, unique isolation identity, and unique resulting application root.
Release qualification fails closed until every installer has been installed in
its own fresh native target and that installed tree passes S(all).

The release inventory includes the application manifest, native dependency
locks, licensing and source-patch records, and every payload digest. Release
smoke launches the canonical relocated archives and every independently
installed native distributable, and fails closed on changed or unlisted
resources and missing trust evidence.

Keep one long-lived `tini -s` ancestor around suites and browser/host audits as
the suite-runner subreaper for launcher/orphan cleanup; it is not the production
containment implementation. `reviews/run-full-suite.R` remains the unfiltered
pure R source suite. Actual application children are owned by the bundled native
process supervisor. The cold-start driver accepts an already staged or installed
application, validates its manifest and bundled process supervisor, runs the static
gate, optionally runs the source suite, and then executes the canonical
process-lifecycle smoke scenario, whose evidence checks exact process birth
identity, whole-tree retirement, and pipe EOF. It does not inspect a checkout-wide
process list or require a source archive:

```sh
rscript="$(realpath -e "$(command -v Rscript)")"
tini -s -- bash dev/reviews/run-cold-start-validation.sh \
  --application host/.application \
  --evidence-dir /tmp/alder-cold-start \
  --rscript "$rscript" --source-suite
```

The application and evidence directories are separate; the evidence destination
must be empty. The caller owns any container restart. Screenshots still need
visual inspection. Generated `reviews/evidence/` runs stay local and are ignored
by Git; retain the evidence locally when comparing runs.

## Local development container

From the repository root, build and start the replacement Linux x64 environment:

```sh
sudo docker build --build-arg USER_UID="$(id -u)" --build-arg USER_GID="$(id -g)" \
  -t alder-dev:local dev/container
sudo docker run -d --name codex-universal --restart unless-stopped \
  --network host --shm-size 1g \
  --mount "type=bind,source=$PWD,target=/workspace/alder" alder-dev:local
```

Docker is managed by the host package manager; apt manages container system
dependencies, npm manages JavaScript dependencies, and pak/BiocManager manage R
dependencies. `sudo` is unnecessary if your session already has Docker access.
The container runs as your host UID/GID and mounts only this checkout. Host
networking makes Alder's loopback server accessible to the host browser. No
Docker socket or host home directory is mounted.

Install project dependencies inside the new container:

```sh
sudo docker exec -i -w /workspace/alder codex-universal Rscript - <<'RSCRIPT'
pak::local_install_deps(dependencies = TRUE, ask = FALSE, lib = Sys.getenv("R_LIBS_USER"))
BiocManager::install(c("edgeR", "statmod"), lib = Sys.getenv("R_LIBS_USER"),
                     ask = FALSE, update = FALSE)
RSCRIPT
```

Then use the staged application commands above. The stage owns the selected R
helper closure, native transport and pinned runtime bytes; it does not install or
discover Node, Ark, Air or R on first use. Keep any package-library cache outside
the application root and use a fresh evidence directory for each smoke run.

This recreates the toolchain, not the missing original image. R and Node match
the handoff; Quarto is pinned in `container/Dockerfile`, while Chrome and R
dependencies resolve from their current repositories. The tracked R lock and
staged manifest, not a handoff TSV, identify the shipped closure. Keep original
latency results separate from this environment's measurements.

## Resume the latency work on another machine

Optimization is paused at the user's request for migration from a 2-vCPU,
approximately 4-GB droplet. The target is not achieved. Keep this code fixed until
the replacement machine has its own warm and first-after-readiness baselines;
do not attribute differences between machines to product changes.

Use the pinned application toolchains and build commands above. R 4.6.1, bundled
Node 24.20.0, Ark 0.1.252-alder.1, Air 0.11.0, Electron 44.2.0, and every npm
dependency are frozen by repository locks. Restore the application-only dependency
closure from `host/r-library.lock.json`; do not install DESCRIPTION Suggests or use
`pak::local_install_deps(dependencies = TRUE)` for an application stage. The
standalone R helper source package has separate build/check commands and is not the
application installer. The container itself is not part of the Git checkout.

After building both JS projects and staging one application tree, use that tree for tests and benchmarks. Keep both qualified Rscript paths explicit:

```sh
application="$PWD/host/.application"
rscript461="$(realpath -e "$(command -v Rscript)")"
rscript460="/absolute/path/to/R-4.6.0/bin/Rscript"
export ALDER_BROWSER_TEST=1
export ALDER_BENCHMARK_MACHINE=new-machine-baseline
# Choose a stable, unique label for this hardware/configuration.
tini -s -- npm test --prefix host
tini -s -- npm run latency --prefix host -- --application "$application" /tmp/alder-new-warm 30 --rscript "$rscript461" \
  "--experiment=Unchanged migration checkpoint on replacement machine"
tini -s -- npm run latency --prefix host -- --application "$application" /tmp/alder-new-fresh 30 --fresh --rscript "$rscript461" \
  "--experiment=First-after-readiness baseline on replacement machine"
```

Use empty evidence directories and one benchmark at a time. Run commands inside
`codex-universal` with the checkout mounted at `/workspace/alder`, as described
above. Install paths under `/tmp` must be recreated.
For portable report links, use new directories under
`dev/reviews/evidence/latency-optimization/` instead of `/tmp`. Both full sets update
`reviews/latency-progress.html`. The plot now separates machine labels (falling
back to recorded platform/CPU/memory identity), browser configuration and mode;
older observations without sufficient identity are not joined for comparisons.

The stopped checkpoint retains native dependent-cell batching, guarded Ark JSON
encoding, native UI RPC inspection, analyzer identity reuse and pre-start
cancellation. The combined-render experiment was reverted. All 86 controller,
engine, Jupyter and installed-host tests plus five browser/observer tests passed
for the cancellation checkpoint. Both committed bundles were rebuilt at handoff.
This is not a new full R/package/platform release qualification.

The latest complete droplet warm control passed correctness but missed all six
scalar median targets; long edit-and-Run was 151.05ms median/461.50ms p95.
Fresh qualification on the final checkpoint is still outstanding. Automatic
inspection can still force promises/invoke user methods; queued cancellation is
fixed, but inspection ownership and bounded summaries remain unresolved.

Next follow the structured experiments in `reviews/INPUT-LATENCY.md`: separate
CPU-only profiling from synchronous trace logging, then investigate analyzer
framing/serialization and supported ways to avoid unused Ark prompt/LSP work.
The last analyzer diagnostic measured scalar round-trip 7.012ms and analyzer
thread CPU 5.963ms; isolated semantic analysis was 0.445ms CPU and response encoding
2.200ms. These measurements are droplet diagnostics, not portable performance
claims. The existing ignored `engine-probe.mts` and analyzer-stage script are in
the evidence archive; no experiment was left running at handoff.

Raw evidence stays out of Git. The separately supplied
`alder-evidence-20260907.tar.gz` contains `dev/reviews/evidence/`, including all
linked historical results, failed/reverted experiments and diagnostic scripts.
Extract it at the repository root to restore report links. Source, tests,
lockfiles, generated bundles, current statistics and the experiment plan are in
Git; regenerable node_modules, downloaded Ark and Python caches are not required.
## macOS release signing order

The application manifest records every nested code object and nested
`_CodeSignature` resource by its exact bytes. On macOS, stage with
`--prepare-macos-signing`, sign every nested code object, then run the same stage
command again against its non-empty `--output`; this manifest-only pass refreshes
all exact hashes and records the signed supervisor identity while preserving its
compiler provenance. Finally sign only the outer `.app` bundle. Do not recursively
re-sign nested code after the manifest refresh.

The two manifest-producing invocations are identical; the second intentionally
accepts the non-empty stage created by the first:

```sh
node host/scripts/stage-application.mjs --output host/.application-desktop --kind desktop \
  --prepare-macos-signing --forge-output "$forge_root" --electron-entry "$forge_entry" \
  --rscript "$rscript461" --qualified-rscript "$rscript460" \
  --supervisor "$supervisor" --supervisor-provenance "$supervisor_provenance"
# Sign every nested code object in host/.application-desktop/Alder.app, then repeat:
node host/scripts/stage-application.mjs --output host/.application-desktop --kind desktop \
  --prepare-macos-signing --forge-output "$forge_root" --electron-entry "$forge_entry" \
  --rscript "$rscript461" --qualified-rscript "$rscript460" \
  --supervisor "$supervisor" --supervisor-provenance "$supervisor_provenance"
# Now sign only host/.application-desktop/Alder.app itself.
```
Run `ci-package` only after the outer signature is complete. Final staging treats
an already-signed Forge bundle as immutable: it verifies the bundle with
`codesign --verify --deep --strict`, copies it verbatim, strictly re-inventories
the copied manifest, and launches only its contained regular CLI. Runtime and
packaging omit only the outer `Contents/_CodeSignature` envelope and the exact
main executable named by `resources.electronEntry`, after successful bundle
verification. Nested signatures remain exact-hashed, while the release manifest
hashes both outer-owned paths.


## Performance and examples

[reviews/INPUT-LATENCY.md](reviews/INPUT-LATENCY.md) contains the benchmark
command, measurement caveats and current baseline for the migration.

- `../inst/examples/iris.R`: installed base-R tutorial.
- `../demo.R`: small ggplot2 notebook.
- `parity-demo.R`: scientific output and interaction fixture.
- `examples/bulk-differential-expression.R`: simulated bulk RNA-seq analysis
  with 6,000 genes and 24 samples. Requires edgeR, statmod and ggplot2; install
  edgeR with `BiocManager::install("edgeR")`. Threshold widgets are downstream
  of the model fit. This is a software-validation example, not a biological finding.

The bulk-DE review runs the frozen `host/scripts/probe-bulk-de-scale.mjs`
workload against an already staged or installed application, then verifies the
probe result and clean, non-forced shutdown. It uses the same
`examples/bulk-differential-expression.R` fixture described above and requires
the fixture's R packages plus the staged application's browser prerequisites:

```sh
rscript="$(realpath -e "$(command -v Rscript)")"
tini -s -- bash dev/reviews/run-bulk-de-scale.sh \
  /tmp/alder-bulk-de host/.application "$rscript"
```
