# Development

[ARCHITECTURE.md](ARCHITECTURE.md) is the next implementation target.
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
npm run build --prefix js
Rscript -e 'devtools::document()'
tini -s -- bash dev/reviews/run-static-gate.sh
tini -s -- bash dev/reviews/run-package-check.sh
```

The static gate checks bundle reproducibility, syntax, widget mirror and lint.
The package gate builds, installs and runs `R CMD check` with the browser suite;
use a fresh `ALDER_CHECK_EVIDENCE` directory for each run. It can check a frozen
archive supplied as `ALDER_CHECK_ARTIFACT`. Source workers and browser tests need
a matching installed package; installing in a private library and exporting
`R_LIBS_USER` avoids accidentally testing another version.

For a focused source test after installing that version:

```sh
tini -s -- Rscript -e 'testthat::test_local(filter = "notebook", stop_on_failure = TRUE)'
```

Keep one long-lived `tini -s` ancestor around suites and browser/worker audits
so their child processes are reaped. `reviews/run-full-suite.R` runs the
unfiltered source suite. The cold-start driver additionally checks a frozen
archive's hash, installed audits and resource cleanup:

```sh
tini -s -- bash dev/reviews/run-cold-start-validation.sh \
  --artifact /path/to/alder_0.1.0.tar.gz --sha256 RECORDED_SHA256 \
  --evidence-dir /tmp/alder-cold-start --audit-root /tmp/alder-audit --source-suite
```

Both directories must be empty and separate; the audit root is outside the
repository. The caller owns any container restart. Screenshots still need
visual inspection. Generated `reviews/evidence/` runs stay local and are ignored
by Git; CI uploads latency evidence as a workflow artifact.

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
