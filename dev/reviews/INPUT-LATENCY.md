# Measuring notebook responsiveness

Performance work serves the product requirements in
[../ARCHITECTURE.md](../ARCHITECTURE.md). There is no active code freeze or
requirement to resume the old sequence of optimization experiments.

The [historical dashboard](latency-progress.html) retains measurements for older
artifacts and machines. Some underlying evidence was stored separately and may
be unavailable. Its results and old qualification thresholds do not establish
current Mac performance or completion of the reset. The detailed experiment
narrative remains in Git history.

## Existing measurement tools

After obtaining a working staged app, run the existing observer with an explicit
Rscript and descriptive machine label. This example selects the actual Electron
frontend on the Mac:

```sh
export ALDER_BENCHMARK_MACHINE=local-mac
application=/absolute/path/to/stage/Alder.app/Contents
rscript=/Library/Frameworks/R.framework/Versions/4.6/Resources/bin/Rscript
npm run latency --prefix host -- --application "$application" /tmp/alder-warm 30 \
  --rscript "$rscript" --frontend electron
npm run latency --prefix host -- --application "$application" /tmp/alder-fresh 30 \
  --rscript "$rscript" --frontend electron --fresh
```

Use separate empty output directories. The existing driver still embeds
50 ms median / 100 ms p95 thresholds and can exit nonzero for an unmet budget.
That is current driver behavior, not a universal correctness gate. The
implementation task should separate measurement and calibrated performance
acceptance when it updates these tools.

## Useful measurement boundaries

- Measure startup, editing, running and cell creation separately. Include a
  dependency chain, unrelated cells and representative scientific notebooks.
- Start interaction timing at the real input event. Verify the correct current
  result is visible, including a rendering opportunity. The existing observer's
  two animation frames are a paint proxy, not a display timestamp.
- Retain failures and timeouts; do not hide them by dropping samples.
- Compare changes under comparable hardware, power and runtime conditions.
  Separate instrumented profiling from ordinary interaction measurements.
- Prefer removing unnecessary work before adding batching, caches or protocols.
  Verify R semantics, cancellation and outputs after changing the measured path.
