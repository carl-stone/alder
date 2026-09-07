# Development

[ARCHITECTURE.md](ARCHITECTURE.md) describes the host, Ark integration and
remaining release acceptance criteria.
Runtime behavior is specified by the code, installed R help and tests.
Historical task specs, ADRs and release-review transcripts are in Git history.

## Checks

Edit files and use Git on the host. In this workspace, run the commands below
inside `codex-universal` at `/workspace/alder`:

```sh
docker exec -i -w /workspace/alder codex-universal bash -lc '<command>'
```

The full toolchain includes R 4.6.1, package Suggests, Node/npm, Chrome, Quarto,
Pandoc, Python 3, ShellCheck and tini. CI also covers R-devel and Windows CLI/MCP.

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

For a focused source test after installing that version:

```sh
tini -s -- Rscript -e 'testthat::test_local(filter = "notebook", stop_on_failure = TRUE)'
```

The application host has its own pinned toolchain and lockfile:

```sh
npm ci --prefix host
host/node_modules/.bin/node host/scripts/fetch-ark.mjs
npm run build --prefix host
R CMD INSTALL --library=/tmp/alder-host-library .
host/node_modules/.bin/node host/scripts/stage-native.mjs /tmp/alder-host-library/alder/host
export ALDER_ARK="$PWD/host/.runtime/ark"
ALDER_R_PACKAGE=/tmp/alder-host-library/alder ALDER_BROWSER_TEST=1 \
  R_LIBS_USER=/tmp/alder-host-library tini -s -- npm test --prefix host
ALDER_NODE="$PWD/host/node_modules/node/bin/node" \
  R_LIBS_USER=/tmp/alder-host-library Rscript -e 'alder::alder_cli()' notebook.R
```

Create the private library directory before installation. The host build updates
the committed application and browser bundles under `inst/`. R interactive,
MCP and headless export entry points use the same host. R semantics remain in
the R suite; host, transport and browser contracts run against the TypeScript
host and installed package.
Native platform and latency qualification remain release gates.
Set `ALDER_TEST_HOST=1` for installed R launch tests and `ALDER_BROWSER_TEST=1`
for trusted Chrome tests. Opening notebooks never invokes npm or downloads Node
or Ark. Use `ark.exe` in the `ALDER_ARK` setting on Windows.

With a built R archive, platform packaging is:

```sh
cd host
node_modules/.bin/node scripts/package.mjs --output /tmp/alder-release \
  --r-package /path/to/alder_0.1.0.tar.gz \
  --ark-archive /path/to/ark-0.1.252-linux-x64.zip
```

The output directory must be empty. The package command copies the running Node
executable and its pinned license, verifies the Ark archive, stages native transport modules,
and records every release file's SHA-256; run it on each target
platform. It rejects an R archive whose runtime source or browser/host assets
do not match the build. Run `node scripts/smoke-release.mjs /tmp/alder-release`
to install that archive into a temporary library and verify its packaged
runtime, CLI status codes, Ark identity, first/warm execution and shutdown.
Native platform acceptance is required in addition to these files.

Keep one long-lived `tini -s` ancestor around suites and browser/host audits
so their child processes are reaped. `reviews/run-full-suite.R` runs the
unfiltered source suite. The cold-start driver additionally checks a frozen
archive's hash, runs the host suite against that installed package, and checks
resource cleanup:

```sh
tini -s -- bash dev/reviews/run-cold-start-validation.sh \
  --artifact /path/to/alder_0.1.0.tar.gz --sha256 RECORDED_SHA256 \
  --evidence-dir /tmp/alder-cold-start --audit-root /tmp/alder-audit --source-suite
```

Both directories must be empty and separate; the audit root is outside the
repository. The caller owns any container restart. Screenshots still need
visual inspection. Generated `reviews/evidence/` runs stay local and are ignored
by Git; CI uploads latency evidence as a workflow artifact.

## Resume the latency work on another machine

Optimization is paused at the user's request for migration from a 2-vCPU,
approximately 4-GB droplet. The target is not achieved. Keep this code fixed until
the replacement machine has its own warm and first-after-readiness baselines;
do not attribute differences between machines to product changes.

Use the toolchain/build/install commands above. R 4.6.1, Node 24.20.0 and
Ark 0.1.252 were used on Linux x64; Ark download URLs/checksums and npm dependency
versions are pinned in the repository. Install the R Imports and Suggests from
DESCRIPTION (for example with `pak::local_install_deps(dependencies = TRUE)`),
plus Chrome and the external tools listed above. The evidence archive includes
`handoff-r-packages.tsv` and `handoff-environment.txt` with the observed package
versions and toolchain. The container itself is not part of the Git checkout.

After creating a private R library, building both JS projects, installing Alder
and running `stage-native.mjs`, use the same environment for tests and benchmarks:

```sh
export ALDER_ARK="$PWD/host/.runtime/ark"
export ALDER_R_PACKAGE=/tmp/alder-host-library/alder
export R_LIBS_USER=/tmp/alder-host-library
export ALDER_NODE="$PWD/host/node_modules/.bin/node"
export ALDER_BROWSER_TEST=1
export ALDER_BENCHMARK_MACHINE=new-machine-baseline
# Choose a stable, unique label for this hardware/configuration.
tini -s -- npm test --prefix host
tini -s -- npm run latency --prefix host -- /tmp/alder-new-warm 30 \
  "--experiment=Unchanged migration checkpoint on replacement machine"
tini -s -- npm run latency --prefix host -- /tmp/alder-new-fresh 30 --fresh \
  "--experiment=First-after-readiness baseline on replacement machine"
```

Use empty evidence directories and one benchmark at a time. Run commands inside
`codex-universal` when working under `/root/workspace`, as described above; its
project path is `/workspace/alder`. Install paths under `/tmp` must be recreated.
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

The bulk-DE audit compares ordinary R and Alder results, then exercises the
installed browser, save/reload and cleanup. It additionally needs chromote,
Chrome, curl and digest, plus an archive matching the current source:

```sh
tini -s -- bash dev/reviews/run-bulk-de-scale.sh \
  /tmp/alder-bulk-de /path/to/alder_0.1.0.tar.gz
```
