# Input-to-visible-result benchmark

The [running HTML experiment log](latency-progress.html) contains historical
statistics, one-line experiment descriptions, diagnostic ideas and interactive
median/p95 plots. Every completed benchmark or full profile set updates it.
Pass `--experiment="One-line description of this experiment"` to the latency
command; the directory name is used if omitted. The page refreshes every minute.

Build and install matching source as described in [the development guide](../README.md),
then run the host observer against that installed package. Use an empty evidence
directory for each mode:

```sh
ALDER_R_PACKAGE=/tmp/alder-host-library/alder R_LIBS_USER=/tmp/alder-host-library \
  tini -s -- npm run latency --prefix host -- /tmp/alder-host-warm 30
ALDER_R_PACKAGE=/tmp/alder-host-library/alder R_LIBS_USER=/tmp/alder-host-library \
  tini -s -- npm run latency --prefix host -- /tmp/alder-host-first 30 --fresh
ALDER_R_PACKAGE=/tmp/alder-host-library/alder R_LIBS_USER=/tmp/alder-host-library \
  tini -s -- npm run latency --prefix host -- /tmp/alder-host-profiles 3 --profile
```

Normal runs remove inherited profiling variables. `--profile` enables separate
Node, browser and R CPU profiles plus correlated monotonic spans, and rejects
missing evidence. `--fresh` measures each scenario as the first interaction in
a new host/browser session, with no throwaway evaluation. Warm and fresh
qualification are separate results. Runs exit 1 for correctness or evidence
failures, 3 for an unmet or unqualified latency budget, and 0 only when every
scenario has at least 30 samples with median at most 50 ms and p95 at most
100 ms. Instrumented samples cannot qualify either budget.

`results.json` records fixture failures, samples, source/run/operation receipts,
startup measurements, installed runtime hashes, browser version and driver identity,
distributions and qualification
status. CI runs one instrumented smoke repetition and retains its evidence; it
does not claim reference-machine latency qualification. The observer's negative
controls run in [latency-observer.test.ts](../../host/test/latency-observer.test.ts).

The test browser disables background networking, component updates, extensions,
default apps and sync using [Chrome's automation flags](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md).
This prevents unrelated downloads in disposable profiles; it does not change
page rendering, input dispatch or the two-frame endpoint. The driver hash records
this environment change. Measurements below through `profile-fresh-batch-trace`
predate these flags and must not be treated as a paired product comparison.

## Interpreting measurements

- Fixtures cover unchanged Run and immediate edit-and-Run for one scalar cell,
  a three-cell chain, and that chain among 100 unrelated cells. Cell creation
  measures a visible, usable focused editor. Startup is recorded separately.
- Timing starts at trusted `event.timeStamp`, including time queued before the
  handler. The observer listens to command receipts and pushed completion events;
  it does not poll during a measured interval.
- Completion requires matching source revision, operation and run identities,
  current visible results, and two animation frames. This is a paint-opportunity
  proxy, not a physical display timestamp. Timeouts and wrong results cannot
  become samples.
- Profiling runs use separate processes. Synchronous trace writes and CPU
  sampling affect those runs, so they never enter baseline distributions.
- R spans use process-local monotonic origins. Never subtract timestamps from
  different processes or browser/R clocks, and do not add nested inclusive spans
  as independent costs.

## Profiling audit and experiment sequence (2026-09-07)

The remaining gap requires reducing work and serial waits across the whole path,
not repeatedly tuning whichever function appeared in the last sample. This audit
covers the observer and runner, controller, browser client/render queue, analyzer
adapter, Ark queue and the recorded experiment history. The qualification target
and two-frame endpoint remain unchanged.

### What the measurements establish—and what they do not

The observer starts at trusted click creation, retains handler delay, verifies
acknowledged source and matching terminal identities, and checks the final visible
output after two animation frames. Negative controls reject old operations, wrong
output and synthetic clicks. Fresh qualification creates a new host/browser for
each first interaction. These are useful correctness and end-to-end foundations.
However, the edit scenario times the Run click after trusted editing; it does not
measure typing-to-result. Keep that definition explicit. The warm creation fixture
accumulates cells: its measured observations span growing notebook sizes rather
than repeated creation from an identical empty state. Retain that workload, label
its cell count, and use a separate fixed-size diagnostic for causal comparisons.

`receiptDelayMs` historically means the browser command response, not the host's
receipt event. `completionDelayMs` is the point when both the command response and
all matching cell-completed events have arrived. It cannot identify which side
was late. New observations additionally retain `commandResponseDelayMs` and
`terminalEventsDelayMs`, with regression coverage for both arrival orders. The old
fields and qualification endpoint are preserved. No cross-process clocks are
subtracted. A command response precedes source acknowledgment in the browser's
promise chain; the final visible check still validates the reconciled source.

Full `--profile` enables CPU sampling and synchronous R JSON trace writes.
Analyzer samples often land in trace serialization, and startup compilation
pollutes aggregate profiles. Use it to establish call paths and identity coverage,
not to rank production costs by elapsed span alone. The profile validator checks
presence, span completion and execution identities; it does not prove clock
alignment, causal attribution, per-edit analyzer linkage or negligible overhead.
The browser CPU profiler also starts after page opening and may miss early startup.

Use three distinct measurement levels:

1. Uninstrumented installed-browser qualification: all six scalar scenarios,
   creation, all failures, at least 30 samples each, warm and fresh separately.
2. Lightweight diagnostics: bounded in-memory operation/request timestamps,
   event counts/bytes, queue admission/start/end, R thread CPU and browser render
   counts; export after the interaction. Measure their overhead against an
   otherwise identical control. Never call elapsed-minus-CPU scheduler contention.
3. Isolated CPU profiles: one process/stage at a time, separate startup from
   steady state, avoid enabling synchronous tracing merely to obtain CPU samples.
   Correlate by epoch/operation/run/source revision and request identity.
   CPU-only is a setup task: the current R initializer couples Rprof to the trace
   directory and enables span writes too. Add an explicit diagnostic mode in
   that existing initializer/runner before treating this comparison as available.

Missing evidence to collect before architectural changes: analyzer CPU versus
round-trip time; enqueue versus execution time behind inspection; per-operation
projection counts/bytes and repeated cell updates; first-use work after readiness;
and distributions of paired differences rather than isolated block medians.
The existing lightweight native wrapper reads R CPU before `kernel.execute()`,
which can wait behind another request in `executeTail`. Its CPU delta can include
inspection, and overlapping wrappers can count the same work twice. Do not label
those deltas request-exclusive evaluation CPU. Add enqueue, native-send, busy,
private-started, reply, idle and settlement boundaries before using them to
attribute removable CPU. Historical paired CPU figures remain interval deltas,
not a proof of exclusive stage attribution. The queue-aware diagnostic now starts
CPU sampling inside native admission and records queue/busy/idle/settlement.
In 30 chain edits, median evaluation queue wait was 0.179ms (maximum 3.676ms),
and admitted elapsed/CPU were 32.093/14.600ms. Two 64-Run calibration sessions
with reversed 16-Run blocks did not resolve a stable hook overhead: enabled
block medians ranged 78.5–121.8ms, disabled 81.2–124.7ms. Use these boundaries
for causal ordering; shorten paired blocks and isolate CPU sampling before
claiming small timing improvements.

Record CPU/cgroup pressure, free disk, concurrent work, browser version and all
artifact hashes around each set. The current container reports no CPU quota and
zero cgroup throttling, but that does not rule out shared-machine contention.
Disk currently has about 9.6 GB free; earlier ENOSPC runs remain invalid.

The runner writes the growing results file between interactions. That is outside
the click endpoint but can alter cadence and overlap with the 100-ms inspection
and autosave timers. Measure this cadence effect explicitly; do not silently
remove inter-sample work or introduce idle waits to improve qualification.

The optional-inspection upper-bound experiment used 128 edits in two fresh
host/browser sessions, counterbalanced 8-Run blocks with the first 2 omitted per
block and timing hooks disabled. Suppression eliminated recorded inspections,
but improved four paired block comparisons and worsened four. It did not establish
a repeatable scalar gain. Do not ship suppression or infer that inspection is
always harmless: the user-method/cancellation concerns are correctness issues,
and different binding sizes/cadences remain separate workloads. Proceed to the
predeclared dirty-cell projection experiment rather than retuning the 100-ms timer.

### Architecture and historical lessons

The ownership split is sound: one authoritative controller, a serial persistent
Ark kernel, independent static analysis, and a separate pure-service process.
Collapsing analysis into the evaluating kernel would sacrifice editing during
long computations. A second browser analyzer would introduce another semantic
authority. Neither is justified by the current evidence. Rust alone is not a
reason to move the controller: synchronous controller work measured in the recent
diagnostic is small compared with the full input-to-result interval.

The strongest demonstrated gains removed repeated native boundaries. Native
batching reduced chain R CPU from roughly 37–43 ms to 20 ms in its paired trial;
UI RPC reduced optional inspection from roughly 12 ms CPU to 3.5 ms. Guarded Ark
encoding became useful after those changes, although an earlier trial did not
show browser improvement. These effects interact: historical rejections can be
revisited only when the changed architecture gives a specific new hypothesis.
Native RPC is not a drop-in notebook evaluator: prior probes exposed console,
.Last.value and interruption differences. Preserve native evaluation semantics.

Small encoding, marker, auto-print and rendering experiments repeatedly showed
microbenchmark gains without robust browser gains. Immediate completion rendering
was inconsistent across 128 paired Runs and increased rendering work. Retain
frame batching. Recent edit diagnostics measured about 13 ms analysis round trip,
7.6–10.6 ms browser rendering and 16 render calls per operation; cell updates were
roughly half the rendering total. They did not remount editors or reconcile order.
This points toward reducing repeated projections, not replacing CodeMirror.

Presentation commonly consumes about 20–30 ms of the fixed 50-ms budget. This
leaves little room for analysis, native execution, transport and rendering together.
Optimizations must reduce the critical path substantially; a 1-ms isolated saving
is insufficient. Presentation is a measured component, not a hard lower bound or
permission to weaken the endpoint.

The independent Astra review also identified two smaller testable issues: the
creation observer kept requesting animation frames after timeout (now fixed and
covered by a retry-then-timeout regression), and product
visible-result telemetry does not recheck freshness after its two-frame wait
(the qualification observer does). Add settled/cancellation guards and an
edit/restart-during-presentation regression. These are separate from the confirmed
queued-execution bug. Extend diagnostic coverage to unrelated cells with retained
outputs and large bindings; the stated 103-cell scalar fixture has no executed
outputs in its 100 unrelated cells.

Ark also refreshes prompt/LSP inputs while Alder uses its own language server.
Locally inspected upstream code calls `.packages(all.available=TRUE)` on that
path. The recorded package-scan cost makes this worth checking against the pinned
binary and supported upstream configuration before another serializer rewrite.
A diagnostic suppression may bound the cost, but patched base R functions and an
Alder-maintained Ark fork are not acceptable implementation conclusions.

### Predeclared experiments

A production-controller reproduction from the independent review changes the
priority: automatic inspection invoked a custom `dim()` method twice (3 seconds
each). While inspection was active, Stop returned `no_run_in_progress`. A new
single-cell Run queued behind it accepted Stop, but after about 6 seconds executed
its file-writing side effect and settled `done`; Restart had been rejected as
`run_in_progress`. See [bounded reproduction](evidence/latency-optimization/review-inspection-stop.jsonl).
This is a confirmed correctness bug, not just a latency hypothesis. The candidate
now revokes single evaluations before native dispatch using an AbortSignal and
settles explicitly without a started event. The installed-host regression fails
on the old build and passes on the candidate, including no external effect and
subsequent execution. All86 controller/engine/Jupyter/installed-host tests and five installed
browser/observer tests passed, including terminal, late-Stop and batch checks. Independently address optional
inspection forcing promises/invoking user methods and its missing cancellation
ownership. Do not fix it by weakening Run/Stop acknowledgment or bypassing the
serial kernel queue.

Run these in order. Use the existing diagnostic and qualification harnesses;
extend their modes rather than create new probe modules. Keep each candidate
separate, freeze the installed artifacts, and log failed setup as well as results.

| Order | Hypothesis and controlled experiment | Decision and correctness gate |
| --- | --- | --- |
| 1. Measurement calibration | Compare unchanged build with instrumentation off, lightweight timings, CPU-only, and full tracing. Use single/chain Run and chain edit, counterbalanced blocks across fresh browser sessions. Separate command-response and terminal arrivals. | Choose the least intrusive setup that resolves the missing stages. Report overhead; do not use instrumented timings for acceptance. Verify both arrival orders and existing observer negative controls. |
| 2. Optional work and cadence | Correlate every new Run with an already-running env_snapshot. Compare normal cadence with controlled user pauses around the 100-ms timer; use diagnostic inspection suppression only to estimate its upper bound. Then test demand-driven/coalesced refresh with unchanged visible variable semantics. | Proceed only if inspection queue wait explains a material share of slow Runs. Never bypass a running R request or interrupt user inspection methods merely for speed. Test open/closed variable views, repeated Run, slow inspection, Stop and recovery. Suppression is not a shippable candidate. |
| 3. Repeated projections | Count which source, analysis, runtime and terminal events cause each render. Prototype one dirty-cell projection pass per frame, with separate dirty flags for global controls, instead of invoking full view.render for each queued event. Apply every document event immediately and preserve observer event delivery. | Seek at least 50% fewer render/update calls and a repeatable visible improvement. Reject if event ordering, local draft acknowledgment, diagnostics, focus, streaming logs, stale labels, Stop controls or reconnect behavior changes. Test 1/3/103-cell notebooks and rapid output. |
| 4. Analyzer boundary | Measure parse/walk CPU, validation/encoding CPU and transport separately for fresh unique edits, including nonnumeric changes and syntax errors. If boundary overhead dominates, prototype a narrower response/codec or maintained native transport; if semantic analysis dominates, optimize the existing parser/walker path. | Preserve arbitrary R source, exact diagnostics, policy/version invalidation, stale-response rejection and analysis during long execution. No literal-normalized benchmark cache. Require improvement on several source shapes before integration. |
| 5. Native execution boundary | Re-profile R CPU after projection/inspection changes. Attribute capture/rendering, private event encoding and Ark prompt work separately. Test reducing duplicate internal records or using an existing Ark native representation only where exact semantics match. | Preserve .Last.value, task callbacks, conditions, output order, plots, error rollback, permit revocation and final reply/idle settlement. No extra expression or maintained Ark fork. Stop if native execution leaves insufficient measurable removable work. |
| 6. First-use path | Compare fresh readiness-to-first-input with later Runs using CPU-only startup recording and lightweight stages. Locate lazy module/schema/editor/capture work and competing readiness tasks. Initialize only proven internal work before readiness. | No throwaway notebook execution or artificial post-readiness sleep. Validate first edit as well as first Run. Run small fresh diagnostics for every retained architectural candidate, then full 30-per-scenario fresh qualification. |

For screening, use counterbalanced A/B blocks with a predeclared warm-up exclusion,
then reverse order in another session. Keep all samples and report paired deltas,
spread and failures; blocks in one session are not independent fresh sessions.
Promote a candidate when its predicted work reduction is observed and it produces
at least about 5 ms or 10% repeatable end-to-end improvement in its affected flow,
without an unexplained regression elsewhere. This is a screening rule, not a
relaxed release target. If noisy, repeat the same experiment rather than change
another variable. Reject semantic shortcuts even when their timings improve.

After each retained change: targeted semantic tests, installed browser tests,
full warm set with automatic HTML update, and fresh diagnostics. Final completion
still requires both full warm and full fresh sets to meet every scalar median and
p95 target on the same final artifacts. Audit the combined candidate again because
individually beneficial changes can interfere.

## Host and Ark measurement (2026-09-07)

The [current warm checkpoint](evidence/latency-optimization/warm-projection-control/results.json)
uses the restored per-event renderer, pre-start cancellation and audited observer.
All 30 samples per scenario passed correctness and teardown. All six scalar medians
still exceed 50ms; edit-and-Run in every fixture, unchanged long-notebook Run and
creation also exceed 100ms p95. The combined-render candidate was reverted after
paired long-notebook results failed to establish a clear gain. The control also
showed substantial long-notebook variability, so the candidate's prior full-set
slowdown cannot be attributed entirely to rendering. All earlier native batching,
inspection, encoding and analyzer-identity changes remain.

The encoder passed all 22 engine tests, an additional contract check,
five browser/observer tests and type checking. The
[preceding serial checkpoint](evidence/latency-optimization/warm-guarded-autoprint-control/results.json)
had chain medians of 81.35 ms unchanged and 113.85 ms after editing, and long-
notebook medians of 98.90 and 149.80 ms. Single-cell results vary across runs.
The preceding fresh-session measurement below also missed the targets;
the new host has not yet been qualified across fresh sessions.

The [native-batch fresh run](evidence/latency-optimization/fresh-native-batch/results.json)
was stopped after 167 recorded sessions because Chrome exhausted disk space,
followed by input/evaluation timeouts and screenshot failures. Eight sessions
recorded failures; the run is incomplete and cannot qualify latency. Before
those failures, the five completed 30-sample groups measured 97.20/124.50 ms
(single Run), 118.80/162.50 ms (single edit and Run), 126.95/172.30 ms (chain
Run), 183.30/293.90 ms (chain edit and Run), and 114.60/226.90 ms (long-notebook
Run), reported as median/p95. Each missed both targets. Old temporary installed
package copies were removed to recover space; saved benchmark artifacts and
the active installation were retained.

| Input-to-visible-result flow | n | Median ms | p95 ms |
| --- | ---: | ---: | ---: |
| Unchanged single cell | 30 | 50.20 | 67.30 |
| Immediate single-cell edit and Run | 30 | 78.70 | 107.40 |
| Unchanged three-cell chain | 30 | 68.80 | 86.10 |
| Immediate chain edit and Run | 30 | 97.55 | 139.00 |
| Chain within 100 unrelated cells | 30 | 79.80 | 223.20 |
| Immediate edit and Run within 100 unrelated cells | 30 | 151.05 | 461.50 |
| Create a usable code editor | 30 | 45.15 | 140.40 |

This used two Linux vCPUs, R 4.6.1, pinned Node 24.20.0, Ark 0.1.252 and
Chrome 152.0.7977.82. The
[starting measurement](evidence/latency-optimization/warm-before/results.json)
had single-cell medians of 115.85 ms (Run) and 125.95 ms (edit and Run).

The checkpoint avoids redundant binding cleanup, defers optional inspection,
coalesces DOM projections while applying every ordered event, and keeps runtime
controls busy through chains. The scalar fixtures edit only the root
cell, whose prior bindings are already cleared inside evaluation; those paths
do not issue a separate `clear_cell` request. The controller regression covers
this through a three-cell edit-and-Run. Body-only edits retain the last validated
dependency graph while replacement analysis gates execution. Revisions,
diagnostics and execution preconditions still advance. The browser skips
unchanged control properties and empty acknowledgment projections. Running
projections wait up to 100 ms; output cancels that delay, while Stop remains
available through runtime controls.

Private R helpers compile before readiness. Browser bundles now request eager
function compilation during loading; V8 function-event logs confirmed compilation
before first use. Automatic completion shares the source-edit pause, and explicit
source actions cancel pending and active completion requests. Explicit Tab
remains immediate. Variables show runtime bindings, without temporary rows for
unexecuted source definitions. The build and five installed browser/observer
checks passed, including exact results, focus, recovery and stale-result rejection.

The [preceding fresh-session measurement](evidence/latency-optimization/fresh-compile-hint/results.json)
used 210 new host/browser sessions, 30 per scenario, with no notebook warm-up.
It predates the host subscription filter, capture-size change and native batching
described below.
All results and teardown checks passed. Every scenario missed the combined
median/p95 targets. CLI and browser startup remain separate measurements.

| First input after readiness | n | Median ms | p95 ms |
| --- | ---: | ---: | ---: |
| Unchanged single cell | 30 | 89.80 | 160.30 |
| Immediate single-cell edit and Run | 30 | 119.30 | 179.10 |
| Unchanged three-cell chain | 30 | 148.20 | 183.90 |
| Immediate chain edit and Run | 30 | 179.50 | 292.50 |
| Chain within 100 unrelated cells | 30 | 160.55 | 261.50 |
| Immediate edit and Run within 100 unrelated cells | 30 | 192.10 | 379.10 |
| Create a usable code editor | 30 | 55.70 | 95.30 |

Compared with the
[preceding fresh measurement](evidence/latency-optimization/fresh-disabled-guards/results.json),
creation improved from 96.65/149.80 ms to 55.70/95.30 ms median/p95. Scalar
changes were mixed. These measurements do not establish scalar qualification.

The LSP subscriber now requests only cell and notebook events. The controller
filters before cloning a subscriber's payload, while retaining every event in
its recovery journal and isolating each receiving subscriber's copy. All 55
controller tests, five installed browser/observer tests, and the installed LSP
synchronization test passed. Alternating diagnostics of the compiled host bundles
measured about 4.0–4.1 ms of emission CPU time per chain with filtering, versus
4.6–4.9 ms without it. They use Node's per-thread CPU counter, separate from
elapsed time. Its [adjacent control run](evidence/latency-optimization/warm-source-subscriber-control/results.json)
and [candidate warm run](evidence/latency-optimization/warm-source-subscriber/results.json)
had mixed end-to-end results; reduced emission CPU does not
establish latency qualification. The installed host's artifact hashes identify
the current warm measurement.

Bounded text capture now uses `file.size()` because it only needs the byte count.
This preserves `file.info()`'s size result without requesting owner/group metadata.
The existing renderer-condition and print-failure/rollback engine tests passed.
The current warm checkpoint includes this change.

A [pre-batch R profile](evidence/latency-optimization/browser-chain-steady.Rprof)
started after kernel readiness and sampled 30 diagnostic chain executions.
At the effective 10-ms sampling interval, it attributed roughly 29% of sampled
CPU time to Ark's package-directory scan and 28% to Alder event emission.
Native-request diagnostics also record R-thread CPU time separately from elapsed
time. Scheduler wait accounting was disabled, so the remaining elapsed time
cannot be attributed specifically to CPU contention.

An [Ark boundary diagnostic](evidence/latency-optimization/ark-batch-boundary-probe-retry.jsonl)
compared serial cell requests with multiple top-level expressions in one native
execution, checking a host cancellation file before each cell. After excluding
three initial diagnostic samples per block, guarded blocks had kernel-only
medians of 37.46 and 26.85 ms, versus 94.74 and 56.15 ms in the surrounding serial
blocks (27 samples each). Exact scalar results and intermediate `.Last.value`
checks passed, as did edit/Stop boundary and kernel-recovery probes.
The production candidate now batches up to four dependent cells, revokes a
host permit on invalidation, and preserves native expression boundaries for
callbacks, plots, `.Last.value` and per-cell completion. All 26 engine/Jupyter
tests, 55 controller tests and seven installed host/browser/observer checks
passed. Additional installed regressions cover queued-source edits, run-button
reset settlement and permit cleanup. An
[alternating browser diagnostic](evidence/latency-optimization/browser-native-batch-abba.jsonl)
reduced median R CPU from 36.53–42.59 ms to 19.63–20.60 ms and visible-result
medians from 136.20–149.90 ms to 92.80–102.80 ms (13 retained diagnostic samples
per block). These diagnostics support retaining batching; the complete warm
measurement above still does not qualify latency.
The host subsequently reused already-decoded private batch events and added
operation/run/session identities to batch request traces. The two native-batch
regressions, trace-correlation assertion, profile validator and build/type check
passed. A [fresh diagnostic run](evidence/latency-optimization/profile-fresh-batch-trace/results.json)
then completed all seven scenarios with valid profiles, correct results and
clean teardown. It has one instrumented sample per scenario and does not
qualify latency.
The [native input-channel experiment](evidence/latency-optimization/ark-batch-input-probe-terminal.jsonl)
was slower and allowed a queued expression after interruption. The
[UI RPC probe](evidence/latency-optimization/ark-ui-rpc-probe.jsonl) left
`.Last.value` unchanged and omitted captured output on errors, so neither is a
drop-in replacement for notebook execution.

A later [auxiliary-inspection diagnostic](evidence/latency-optimization/ark-ui-inspection-abba.jsonl)
used that UI RPC only for the existing `env_snapshot` command. All 64 snapshots
matched the ordinary execution path, and `.Last.value` remained 42. With three
initial samples excluded from each block, native RPC medians were 6.85–7.46 ms
elapsed and 3.42–3.52 ms R CPU, versus 16.58–18.55 ms elapsed and 11.66–12.98 ms
CPU for ordinary requests. A [boundary probe](evidence/latency-optimization/ark-ui-inspection-boundaries.jsonl)
interrupted a slow inspection method, received the structured interruption
response, preserved `.Last.value` and recovered. A queued native execution
verified that inspection finished first. Variable snapshots now use this RPC through the existing bounded serial queue,
including channel setup, matching IOPub replies/idle and settlement hooks.
The live transport regression covers queued execution, RPC errors, callback
errors and recovery. The complete warm measurement above includes this change;
notebook execution continues to use the native REPL boundary.

Ark's native JSON encoder matched ordinary control and text records in a
[compatibility diagnostic](evidence/latency-optimization/ark-native-json-compatibility.jsonl),
but differed for empty arrays, forced singleton arrays, missing values and
fractional precision. It used 69–70 ms of CPU for 3,000 encodes, versus
1,328–1,368 ms for jsonlite. A guarded prototype used it only for compatible
control/text records and retained the existing encoder for other messages.
Its [alternating browser diagnostic](evidence/latency-optimization/browser-ark-json-abba.jsonl)
did not improve visible-result medians: native blocks measured 91.60 and
74.80 ms, versus 74.80 and 67.10 ms for the surrounding controls, with 13
retained samples per block. That prototype was not adopted at that checkpoint.
After native inspection and browser background controls, a
[128-Run comparison](evidence/latency-optimization/browser-ark-json-with-native-inspection.jsonl)
showed lower evaluation CPU and visible medians in the matched native blocks.
The runtime now uses Ark encoding for exact control records and plain, valid
UTF-8 text records only. The contract regression checks Unicode, Latin-1,
missing values, forced/empty arrays and fractional precision against jsonlite;
other payloads retain the original encoder. The current warm measurement
includes this guarded path and still misses the scalar targets.

A native C encoder prototype handled small ASCII status/text payloads and fell
back to jsonlite for other values. It passed comparison checks, including 1,000
random ASCII strings, and all 24 engine/Jupyter tests. Alternating three-cell
diagnostics reduced median R CPU time from roughly 35–38 ms to 31–32 ms, but its
[full warm run](evidence/latency-optimization/warm-native-json/results.json)
missed every budget and was slower overall than its
[adjacent restored control](evidence/latency-optimization/warm-native-json-control/results.json).
The prototype remains outside production; cheaper serialization
did not establish an end-to-end gain sufficient to justify another implementation.

Guarded Ark auto-print prototypes returned ordinary numeric/logical scalars to
the native printer and deferred ownership cleanup until printing completed.
R task callbacks ran after successful printing but were skipped on print errors,
requiring host recovery after the native execution terminal. Focused state,
print-error and late-Stop tests passed, with native printing explicitly observed.
Both the [initial version](evidence/latency-optimization/warm-guarded-autoprint/results.json)
and a [version without an extra control message](evidence/latency-optimization/warm-guarded-autoprint-no-marker/results.json)
passed all 30 warm samples per scenario for correctness. Neither established a
consistent browser improvement over their
[restored control](evidence/latency-optimization/warm-guarded-autoprint-control/results.json): unchanged chain
medians were 84.15 and 127.85 ms versus 81.35 ms. Both prototypes were removed
from production; Ark reuse remains preferred where it preserves behavior and
reduces code or demonstrates an end-to-end gain.

Caching the constant started/finished records reduced R CPU costs in alternating
diagnostics, but the
[complete warm measurement](evidence/latency-optimization/warm-cached-markers-space/results.json)
did not improve end-to-end latency: chain medians were 129.80 ms unchanged and
180.35 ms after editing. That R change was reverted. It had passed all 24
engine/Jupyter and five browser/observer tests; correctness alone was insufficient
to retain the optimization. The original R runtime was restored before the host
subscription work; `DESCRIPTION` reflects the subsequent reinstall. One
[diagnostic trial](evidence/latency-optimization/browser-markers-7-cached.jsonl)
missed the trusted input event and remains a failed comparison, not a qualifying
sample. The subsequent comparison recorded control state before each click and
completed without missed input. Skipping additional unchanged DOM attributes
also failed to improve its paired diagnostic and was not implemented.

Storage failures remain in the evidence. The initial
[compile-hint warm attempt](evidence/latency-optimization/warm-compile-hint/results.json)
timed out in Chrome during creation; a
[creation reproduction](evidence/latency-optimization/create-compile-hint-diagnostic/results.json)
then hit `ENOSPC`. The first
[cached-marker warm attempt](evidence/latency-optimization/warm-cached-markers/results.json)
also hit `ENOSPC` during long-notebook evidence writing. These incomplete runs
cannot qualify latency. Reclaiming disposable test installations and build caches
allowed the complete reruns; source archives, release images and raw evidence
were retained. The browser driver now retains stderr and crash events in failure
records.

[Earlier profiles](evidence/latency-optimization/profile-deferred/results.json)
identified layout/paint costs and first-use compilation of inspection helpers.
Earlier CSS diagnostics without the editor's CSP nonce were ignored by Chrome;
they cannot establish CSS performance effects. A
[shared-memory comparison](evidence/latency-optimization/warm-runtime-variables-shm/results.json)
removing Chrome's disk-backed shared-memory flag worsened long-notebook medians,
so the driver retains its existing configuration. The
[original migration baseline](evidence/host-migration/ark-candidate-11/latency-warm-n30/results.json)
is retained for comparison, not qualification of subsequent builds.
