# Input-to-visible-result benchmark

Phase 0 of [the architecture migration](../ARCHITECTURE.md). Run on an idle
reference machine inside `codex-universal`, using a fresh evidence directory:

```sh
docker exec -i -w /workspace/alder codex-universal bash -lc \
  'tini -s -- bash dev/reviews/run-input-latency.sh /tmp/alder-latency-run 30 2 3'
```

Arguments are evidence directory, measured repetitions, warm-ups and separately
profiled repetitions. Append `--enforce-budget` to require at least 30 samples
per scenario, median ≤50 ms and p95 ≤100 ms (exit 3 on an unmet budget).
Default report mode records unmet budgets without failing. Correctness,
teardown or missing-evidence failures exit 1 in either mode; independent
fixtures and profiling still run, with surviving measurements labelled partial.
Use `1 0 1` for a smoke run; it cannot qualify performance.

The driver builds and privately installs matching source, then runs observer,
report and tracing regressions before the installed browser workloads. It needs
the R test/browser dependencies, microbenchmark, Chrome, Node, Python 3, `ss`,
`/proc` and tini. This driver is Linux-specific. CI runs smoke/profiling and
uploads evidence without enforcing reference-machine latency budgets.

## Interpreting measurements

- Fixtures cover unchanged Run and immediate edit-and-Run for one scalar cell,
  a three-cell chain, and that chain among 100 unrelated cells; cell creation
  measures a visible, usable focused editor. Startup and first execution are
  recorded separately from warm repetitions.
- Timing starts at trusted `event.timeStamp`, including time queued before the
  handler. The observer consumes existing app requests; extra polling within
  a measured interval would change the workload.
- Completion requires matching source/revision/run receipts, current visible
  results and two animation frames. This is a paint-opportunity proxy, not a
  physical display timestamp. Timeouts and wrong results cannot become samples.
- Baseline and profiling use separate fresh processes. Profiling enables
  `ALDER_PERF_TRACE_DIR` and `ALDER_PERF_RPROF=1`; synchronous JSONL writes and
  10-ms CPU sampling affect those runs. They never enter baseline distributions.
- R spans use `microbenchmark::get_nanotime()` with process-local origins.
  Never subtract timestamps from different processes or browser/R clocks.
  Nested inclusive spans cannot be added as independent costs. `state.encode`
  includes state generation; `kernel.evaluate` includes bounded value capture.
- `summary.json` retains correctness, budgets, distributions, failures and
  correlated profiles. Missing profiling fixtures, CPU summaries or correlated
  stages fail validation. Generated evidence stays local and is ignored by Git.

Observer negative controls can be replayed with
`ALDER_LATENCY_MUTATION=stale`, `wrong-dom` or `input-delay` before
`node --test dev/reviews/test-input-latency.mjs`; each must fail its intended
assertion. Report tests are in `test_input_latency.py`; tracing tests are in
`../../tests/testthat/test-performance.R`.

## Current baseline (2026-09-06)


[Baseline 04](evidence/input-latency/baseline-04/summary.md) finished on
2026-09-06 with the corrected event-creation timer. It **failed** when `/api/lsp`
returned HTTP 504 for `textDocument/completion` during long-notebook edit-and-Run.
The failed action and CLI diagnostics are retained. Independent fixtures and
all seven separately profiled scenarios completed. The driver exited 1; the
resource audit exited 0, with no remaining workloads, zombies or open observed
ports. The failed long fixture required forced cleanup; the other seven
baseline/profile fixtures shut down normally.

The following are the **165 completed measured actions only**, not a successful
latency qualification. The unfinished action is recorded separately. Long-flow
sample counts are below the required 30, and every observed median/p95 exceeds
the 50/100-ms targets. No performance acceptance is claimed.

| Input-to-visible-result flow | Completed n | Median ms | p95 of completed samples ms |
| --- | ---: | ---: | ---: |
| Unchanged single cell | 30 | 523.7 | 1038.5 |
| Immediate single-cell edit and Run | 30 | 380.0 | 1165.6 |
| Unchanged three-cell chain | 30 | 633.9 | 1268.2 |
| Immediate chain edit and Run | 30 | 1114.1 | 1449.6 |
| Chain within 100 unrelated cells | 8 | 3499.8 | 4952.6 |
| Immediate edit and Run within 100 unrelated cells | 7 | 5626.3 | 6281.8 |
| Create a usable code editor | 30 | 161.8 | 283.0 |

This measurement used Linux, R 4.6.1, Chrome 152, two virtual DO-Regular CPUs
and approximately 4 GB RAM, with no other test/benchmark workload running.
Completions and signature help were enabled; autosave, format-on-save and lint
were off, matching their current defaults. The installed source artifact is
`baseline-04/build/alder_0.1.0.tar.gz`, SHA-256
`391b6f7856fde338f4d72c23ae77632b3086eae6ca39c8503280575b03bd82cd`.
Exact source correspondence and final harness hashes passed. These observations
characterize this environment, not every developer machine or supported platform.

Run/edit-and-Run are interleaved in a fixed order. Browser polling phase can
affect their comparison; these values do not imply that editing makes R faster.
First interactions were 1.85 seconds (single), 3.20 seconds (chain), 6.25 seconds
(long), and 0.72 seconds (create). Baseline CLI readiness was 5.84–6.53 seconds,
recorded separately from browser startup and first execution. First interactions
are diagnostic single observations, not a qualified first-interaction p95.

The separate profiles completed three measured repetitions per scenario. For
long edit-and-Run, median summed `kernel.evaluate` spans were **17.8 ms** across
three cells, versus **223 ms** of analysis and **3925 ms** of state generation/
encoding across the observed state requests. Complete kernel execution was
262 ms, including 31 ms of graphics setup. These are **inclusive, instrumented
stage durations**; they are not additive independent costs or a decomposition
of the partial baseline table. They support prioritizing incremental state and
analysis, pushed results, and lighter scalar capture. They do not measure the
benefit of a TypeScript rewrite by itself.

[summary.json](evidence/input-latency/baseline-04/summary.json) retains partial
distributions, failure receipts and correlated profiles. Per-fixture records
retain startup, CPU summaries and screenshots. Captured browser console/error/
dialog arrays are empty, but the failing HTTP response remains fatal. Raw probe
logs also retain Chromote close-handshake warnings (`got non-close frame while
closing`); no blanket zero-warning claim is made for this attempt.
The creation fixture's final screenshot is taken after its untimed reset and
therefore shows an empty notebook; focused-editor completion is established by
the retained per-action observer checks. Single/chain final screenshots show
their completed results. Replaying this failed report with `--enforce-budget`
returned 1 and produced identical JSON (`baseline-04/budget-gate.json`), preserving
the correctness failure before evaluating latency acceptance.

The earlier [Baseline 02](evidence/input-latency/baseline-02/summary.md) completed
210 samples and separate profiles with clean resources, with all budgets unmet.
Its timer began at handler entry and omitted queued input delay, so those
durations are superseded for latency acceptance. Its exact artifact and old
observer sources remain retained. The earlier bulk-DE audit describes a
different workload and is not used as a scalar latency baseline.
