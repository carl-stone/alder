# Input-to-visible-result benchmark

This is phase 0 of the [architecture migration](../ARCHITECTURE.md). It measures
the current implementation and retains unmet performance targets. It does not
implement the TypeScript host or claim console-like latency has been achieved.

The harness and this report are versioned. Generated `evidence/` directories
are retained locally and ignored by Git; links below identify those local
records. CI evidence is uploaded as a workflow artifact.

## Run

Use an empty evidence directory. In this workspace, run under a single
long-lived subreaper inside `codex-universal`:

```sh
docker exec -i -w /workspace/alder codex-universal bash -lc \
  'tini -s -- bash dev/reviews/run-input-latency.sh /tmp/alder-latency-run 30 2 3'
```

Arguments are evidence directory, measured repetitions per scenario (default
30), warm-ups (2), and separately profiled repetitions (3). Add
`--enforce-budget` as the fifth argument for a latency acceptance gate. That
gate exits 3 if any scenario has fewer than 30 samples, median >50 ms or p95
>100 ms. Default report mode still records `budget_met: false`; it does not
relabel a slow result as performance acceptance. A quick harness smoke run uses
`1 0 1`; it cannot establish tail-latency acceptance.

Correctness, teardown or missing-evidence failures exit 1 regardless of the
budget option. A failed fixture is recorded, then independent fixtures and the
separate profiling mode are still attempted. The failed report retains completed
sample distributions and available stage attribution as partial diagnostics;
it cannot establish latency acceptance. The failing action is retained separately
and is never converted into a fast sample or silently dropped.

The driver builds an exact source artifact, verifies correspondence, installs
it privately, runs observer/report/trace regressions, then launches the installed
CLI for each workload. Dependencies are the existing R test/browser stack,
the optional `microbenchmark` package for its platform timer, Chrome, Node (for
observer unit tests), and Python 3. No scientific packages or
network service are required. Linux resource audits require `ss`, `/proc` and
`tini`; this driver is currently Linux-specific. The architecture's Windows and
macOS benchmark ports remain migration work.

## Workloads and independent correctness checks

- **single:** `x <- 1L; x * 2L` in one cell, expected `[1] 2`.
- **chain:** separate `x <- 1L`, `y <- x + 1L`, `z <- y * 2L; z` cells,
  expected `[1] 4`. Run the first cell to propagate through the chain.
- **long:** the identical chain followed by 100 unrelated scalar code cells.
  Those cells must stay idle; they are not included in the execution plan.
- **create:** native click on Add code through a visible, focused CodeMirror
  editor. Reset the fixture between repetitions outside the measured interval.

Each execution fixture records an unchanged Run and an immediate edit-and-Run.
Edits alternate the literal 1/2 with native CDP keyboard input, followed directly
by Ctrl-Enter without waiting for debounce or edit acknowledgment. Expected
results are independently specified as 2/4 (single) and 4/6 (chain). Focus and
selection setup are outside timing; source mutation and execution are not.
First execution and warm-up records are kept but excluded from warm statistics.

The browser clock starts at `event.timeStamp` for the trusted keydown (first edit
key for edit-and-Run, Run key for unchanged Run) or trusted Add click. Handler
entry is recorded separately, so input queued behind a busy main thread is
included. The two timestamps must share the document's time origin (with up to
1 ms tolerance for timer precision); an incompatible clock fails the sample.
See the [event timestamp contract](https://developer.mozilla.org/en-US/docs/Web/API/Event/timeStamp).
Both input-to-result and
Run-key-to-result durations are retained. The observer intercepts the app's
existing fetch/JSON consumption without issuing additional requests. It requires
an accepted run, acknowledged matching source/revision, a newer completed state,
the app's acknowledgment that it rendered that state version, exact visible
output text, and two animation frames with a final visibility/freshness check.
After timing ends, the driver independently checks the exact run-operation
journal and unrelated-cell statuses. This assumes one benchmark client owns
the isolated fixture; it is not a general attribution scheme for concurrent
mutating clients.

The endpoint is a **paint-opportunity proxy**. Two animation frames establish a
rendering opportunity with current visible DOM, not the instant physical pixels
hit a display. Screenshots preserve final appearance. No early spinner, retained
old output, hidden DOM, synthetic event or mere HTTP success counts as completion.

## Evidence and profiling

Each fixture retains its source/config, startup timings, Chrome version, every
sample and request timestamp, input trust, edit/run receipts, final screenshot,
CLI channels and teardown result. Failure retains the active partial sample and
a screenshot. No timeout or wrong result is discarded from a successful report.
The outer driver records hardware, exact source/harness hashes, source/build
logs and independent baseline/final process, zombie and port audits.

Baseline CLI/worker processes do not enable server tracing or CPU profiling.
The small browser observer is present in both modes and its overhead is not
subtracted. Profile mode starts separate fresh processes with
`ALDER_PERF_TRACE_DIR` and `ALDER_PERF_RPROF=1`. Synchronous JSONL trace writes
and 10-ms Rprof sampling intentionally affect that run; its latencies never enter
the baseline distribution.

Stage spans include source edit, analysis, run planning, worker dispatch and
response handling, kernel evaluation, graphics setup, complete cell execution,
protocol output, result commit, HTTP handling and state encoding. HTTP responses
include `X-Alder-Perf-Span` only when tracing is enabled. Requests join to those
spans; run/cell/request IDs join host and worker events. Per-process elapsed
clocks compute durations using `microbenchmark::get_nanotime()` and a local
origin. The verified Linux build uses `CLOCK_MONOTONIC_RAW`; retain the timer
package version/build evidence when qualifying other platforms. R's
`proc.time()` elapsed field can follow wall-clock adjustments and is not used
for accepted spans. Host dispatch-to-response uses one host clock.
Browser request/JSON/render/presentation timings use one browser clock.
Absolute cross-process times are not subtracted. Spans are inclusive/nested and
must not be added as mutually exclusive costs. CPU summaries retain the top
functions by total/self time; short runs may have few samples, so stage spans
provide the primary small-operation evidence.

`state.encode` includes generation of the state being encoded. `run.plan`
covers `launch_run(plan)`, including queue preparation and initial dispatch;
earlier target selection remains within the surrounding HTTP/CPU measurements.
`kernel.evaluate` wraps the bounded evaluator and its ordinary value handling,
so it is not a bare-R arithmetic microbenchmark. The complete input-to-result
duration remains the acceptance measure even when a cost has no finer span.

The generated `summary.md` and `summary.json` separate correctness and latency
acceptance, report n/median/nearest-rank p95/max, retain cold startup separately,
and attribute each profile sample. Missing scenarios, profiling fixtures, CPU
summaries, trace spans or operation correlations are fatal. A failed report
labels all surviving distributions as partial and lists the failure receipts.
Full snapshots exist only in isolated fixture inspection;
production timing spans contain no source bodies, values or output text.

## Regression and negative controls

`test-input-latency.mjs` rejects stale snapshots, wrong/unacknowledged source,
old API output, wrong visible DOM, missing run receipts, hidden results and
synthetic input. It requires two frames, rechecks the result afterward, and
includes time queued before the input handler runs.
`test_input_latency.py` checks p95 retains slow samples, missing evidence fails,
operation correlation is exact, and failed runs retain useful partial evidence
without passing acceptance. `tests/testthat/test-performance.R` checks
disabled tracing is inert, nested process-local spans correlate, and an invalid
trace destination fails visibly.

To demonstrate that observer regressions detect their intended defects, the
test loader supports three in-memory mutations (no product source is changed):

```sh
ALDER_LATENCY_MUTATION=stale node --test dev/reviews/test-input-latency.mjs
ALDER_LATENCY_MUTATION=wrong-dom node --test dev/reviews/test-input-latency.mjs
ALDER_LATENCY_MUTATION=input-delay node --test dev/reviews/test-input-latency.mjs
```

All three commands must fail at their named assertion. Run installation, tests,
benchmarks and profiling inside `codex-universal`. Performance gates should run
on recorded reference hardware without concurrent workloads; ordinary correctness
CI should run the smoke benchmark without enforcing a machine-specific deadline.
The Linux R 4.6.1 quality workflow runs this smoke/profiling driver and uploads
its evidence even on failure. It does not enforce the latency budget on shared
CI hardware. Native Windows/macOS equivalents remain migration work.

## Current measurement: failed correctness, partial timings

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

## Retained attempts and validation

The first smoke attempt completed all scalar scenarios, then its creation reset
externally deleted a focused cell. The browser correctly retained protected
source as a tombstone, and the next overly broad Add selector referenced that
deleted cell. The attempt remains failed evidence in `evidence/input-latency/smoke-01`.
The harness now releases focus during the untimed reset and waits for both empty
server state and empty cell DOM. Its independent resource audit passed.

Smoke 02 completed baseline correctness, then rejected a profiler warning that
the requested 5-ms sampling interval was below this platform's 10-ms minimum.
The configured interval is now 10 ms. That attempt remains failed evidence;
its resource audit also passed.

Smoke 03 completed all browser actions and profiling, then the report caught a
network warning caused by keeping a polling browser open during server shutdown.
The harness now closes the client before requesting native server shutdown and
still rejects every captured warning. Report validation also exposed jsonlite's
empty-list metadata encoding; the reader now normalizes only that empty case,
with a specific regression. Smoke 03 remains failed evidence with clean resources.

Baseline 01 completed 30 measured repetitions of both single and chain flows,
then failed during long-notebook edit-and-Run: `/api/lsp` returned HTTP 504 for
`textDocument/completion`. Its CLI and browser channels retain the failure;
completion remains enabled in the benchmark. This is an observed product
failure, not a successful latency run. Cleanup passed. Earlier smoke R stage
spans used `proc.time()` elapsed time; they are diagnostic history only and do
not satisfy the corrected monotonic-clock requirement. Browser timing already
used `performance.now()`.

Baseline 02's observer tests (6), report tests (5), and R tracing tests (3 tests,
16 expectations) passed. Additional validation confirmed that the stale-state,
wrong-DOM, empty-metadata and adjustable-clock mutations are rejected at their
intended checks. The budget gate returned 3 and produced the identical report
with `budget_met: false`. Package/probe lint reported zero lints and shell/JS
syntax checks passed. The first static validation stopped at ShellCheck's
single-quote notice for literal R `$` expressions; an explanatory suppression
was the only driver change at that validation point, with no change in execution
logic. Later harness corrections below have their own tests and evidence.

The full source/browser suite in `evidence/input-latency/validation-02/`
completed **4,163 expectations across 407 tests: 4,161 passing, two failures,
zero errors, warnings or skips**. Both failures were waits in the existing
`browser source conflicts offer server recovery` test, for the recovery control
and server source. The independent resource audit passed. Subsequent isolated
replays of that unchanged test passed twice against the prior artifact and twice
against the instrumented artifact (`conflict-comparison-02/`, resource audit
passed). These replays do not establish the cause of the full-suite failures;
the broader suite remains a failed validation result.

Review then identified that the browser observer started at handler entry,
omitting main-thread input queuing. The corrected observer starts at the event
timestamp, retains handler time, and has a specific queued-input regression and
mutation control. The report rejects old samples lacking that contract. The
earlier observer/report sources are retained under
`evidence/input-latency/observer-before-event-timestamp/` so the earlier evidence
can still be interpreted. Packaged runtime code did not change for this correction.

Baseline 03 used the corrected event timestamp and reproduced the long-notebook
completion HTTP 504 after completing the small fixtures. Its execution failed
and its independent resource audit passed. The driver now continues independent
fixtures and both modes after such a failure, and emits an explicitly failed
report with partial evidence. Completion remains enabled.

Final static/harness validation is retained in `validation-03/`: seven browser
observer tests, eight report tests, zero package/probe lints, shell/JS syntax,
and exact source/artifact correspondence passed. Two additional mutations prove
that missing profiles and falsely accepting a failed run fail their intended
assertions. The validation execution and resource audit both exited zero.
The exact commands and tested hashes are retained there. The subsequent
benchmark driver also runs the three R tracing tests (16 expectations) against
its private installed artifact. No packaged runtime changed after the full suite.
