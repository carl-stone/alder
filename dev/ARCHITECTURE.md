# Responsive notebook architecture and migration

Status: accepted target architecture; migration not yet implemented. 2026-09-06.
The first migration deliverable is the input-to-result benchmark described in
[INPUT-LATENCY.md](reviews/INPUT-LATENCY.md). Earlier ADRs describe the shipping
implementation until their individual replacements land. Historical release
reviews are evidence for their exact artifacts, not acceptance of this target.

## Product requirement

Creating and running a few cells of assignments and arithmetic must feel like
using an already-open R console. Correct visible results, acknowledged source,
and preserved R semantics are the requirement. An early spinner is insufficient.

On a recorded reference machine, after notebook readiness, each scalar execution
scenario must have median input-to-visible-result latency at most 50 ms and p95
at most 100 ms. These are release targets, not claims about today's code. Measure
the single-cell case, a three-cell dependency chain, and the same chain embedded
in 100 unrelated code cells. Measure unchanged Run and immediate edit-and-Run
separately. Collect at least 30 measured repetitions per scenario, after explicit
warm-up; retain every sample, timeout and failure. Record cold CLI readiness,
browser readiness and first execution separately; never bury them in warm-up.
Also measure native cell creation through a visible, usable focused editor.

Execution readiness means internal evaluation/capture machinery is initialized;
users must not run throwaway cells to obtain the fast path. The same latency
targets apply to the first scalar interaction after that readiness signal.
Qualify that separately across fresh sessions; the phase-0 harness retains a
first execution per fixture, which diagnoses this cost but is insufficient to
establish its p95. CLI/browser startup remains a separate measurement.

The browser endpoint is a visible current result after a rendering opportunity,
with the exact source revision and run identity reconciled. A DOM write or a
successful HTTP response alone is insufficient. The current benchmark uses a
two-animation-frame presentation opportunity, explicitly reported as a proxy
for paint rather than a hardware display timestamp. Reference-machine latency
gates are separate from portable correctness tests.
Start timing at the trusted input event's creation timestamp and retain handler
entry separately; a blocked main thread's input delay must not disappear from
the result merely because JavaScript could not start its own timer sooner.

## Ownership and processes

```mermaid
flowchart LR
  Browser[TypeScript browser editor] <-->|Versioned commands and events| Host[TypeScript application host]
  CLI[CLI, MCP and R entry points] --> Host
  Host <-->|Engine requests and output events| Kernel[One warm serial R kernel per notebook]
  Host <-->|Source snapshots and analysis| Analysis[Warm R analysis service]
  Host --> Jobs[Isolated R publishing and background jobs]
```

The TypeScript host owns source revisions, notebook structure, the dependency
graph, execution plans, stale-state transitions, operation journals, persistence
coordination, artifact lifetime, browser connections, HTTP and MCP adapters, and
the LSP client. One controller implements operations for every client. The
browser maintains local editing intent and acknowledged revisions; it is not a
second execution authority.

The R package owns R parsing and semantic analysis, the byte-preserving notebook
codec, evaluation, R objects and environments, widget constructors and R-side
validation, condition/graphics capture, object rendering, package/renv work,
and R publishing integrations. Interactive and Session-backed export entry points
call the same host controller. File conversion and analysis helpers stay local.
`alder_source(path, env)` retains its explicit in-process environment semantics,
as does the one-shot `alder_test()` utility: each walks a fixed analyzed plan in
R, with no reactive Session, transport or event loop. Port graph parity tests so
these utilities and the host agree on ordering, disabled descendants and
diagnostics. There must not be a second reactive controller for headless exports.

The evaluation kernel retains one notebook environment. Packages, closures,
database connections, external pointers and large data remain in this process.
Messages carry code, identifiers, bounded descriptions and artifact handles,
not snapshots of every R binding. Kernel death invalidates all runtime handles;
retained output bytes remain available with explicit stale status.

Analysis runs outside the evaluating kernel so editing and dependency diagnostics
remain available during a long computation. It analyzes immutable source
snapshots, never evaluates notebook code, and returns revision-tagged results.
The host discards obsolete analysis and cannot dispatch against an unvalidated
source revision. LSP assistance and optional lintr diagnostics are independent
of the required dependency/syntax validation.

The final host uses Node and TypeScript, with shared browser/host types and
runtime schemas. Use maintained MCP and JSON-RPC/LSP libraries, retaining Alder's
stricter limits and lifecycle contracts where library defaults differ. Go/Rust
are not additional application languages. A small native adapter is acceptable
for a demonstrated platform/capture requirement.

## Fast execution path

1. Create the local cell/editor immediately with a stable client operation ID;
   reconcile its server identity without replacing a focused editor. Persisted
   source and execution results become authoritative only on acknowledgment.
2. Run sends the requested target plus pending source edits and their revision
   preconditions in one ordered command. Validate every precondition before any
   edit or execution effect. An explicit Run bypasses typing debounce. Source
   conflicts remain conflicts; never silently run old or guessed source.
3. Analyze only changed cell bodies. Cache analysis by source and analysis
   policy/version, maintaining symbol ownership indexes. Recompute affected
   edges, duplicate definitions, cycles and descendants, including deletions,
   moves, changed ownership and bounded dynamic/package barriers.
4. Dispatch immediately to the warm kernel over a persistent connection. Keep
   execution serial and deterministic. Read responses on readiness events;
   do not insert a polling timer or deliberate sleep between cheap cells.
   Batching is optional, and must still process cancellation/invalidation at
   cell boundaries before obsolete queued source can produce effects.
5. Commit each matching result and push its bounded delta immediately. The
   browser updates only the affected cell/output and renders on the next frame.
   Expensive variable inspection, graph layout, help, autosave and reporting
   cannot delay that result. Required validation and output conditions cannot
   be deferred past a successful completion event.

One persistent browser connection carries ordered commands/events. WebSocket is
the target transport; HTTP remains appropriate for immutable assets, downloads
and initial connection setup. Reconnect uses an event cursor and session epoch:
replay retained events when possible, otherwise send one authoritative snapshot.
Full snapshots are for initialization/recovery/explicit inspection, not each
cell completion. Per-client backpressure coalesces superseded state, preserves
ordered logs/terminal events, bounds memory and disconnects unrecoverable clients.

Keep output infrastructure lightweight for nonplotting code. Install reusable
capture machinery once where possible; create graphics artifacts when graphics
occur. Preserve plots produced inside functions and arbitrary packages using
runtime capture, not source-text guesses. Avoid opening a raster device and
creating scratch files for each scalar assignment. Refresh variable metadata
incrementally or on demand; never serialize whole live objects just to refresh
the sidebar. Render only changed records; virtualize long notebooks while
preserving editor state, focus, selection, scroll and accessibility navigation.

## Engine contract and correctness

Version the protocol independently of package versions. A handshake advertises
protocol, engine/package identity, supported capabilities and readiness. Reject
incompatible versions visibly before user-code execution. Frame sizes, nesting,
UTF-8, JSON shapes and duplicate-key rules are explicit and tested.

Every operation carries session epoch, operation ID and relevant source
revisions; execution adds run ID and cell ID. Each output event carries a
monotonic sequence within its execution. ACK means accepted, started means the
kernel entered that evaluation, and completed means evaluation, required output
capture and cleanup reached a terminal state. Cancellation-requested is a
separate state. A cancelled promise is not proof that R stopped.

Commands cover analysis, run, interrupt, restart, widget operations, inspection,
lazy output/table requests, package jobs and shutdown. Events cover receipts,
diagnostics, cell started/output/conditions/completed, runtime availability and
operation settlement. Widgets and inspections preserve owner/path/revision
identity, exact causal run-button resets and `stale_value` errors. Error payloads
preserve Alder codes and complete bounded conditions. All clients use these
same operations, including MCP calls that wait for exact operation settlement.

Source edits invalidate old/new affected regions. Late results cannot become
current. A late Stop after successful completion commits success. Worker
interrupts are request-scoped and must not hit idle reads or subsequent work.
Recoverable interruption and process termination are different operations on
every platform. Node's Windows signal API is not sufficient by itself; retain
or implement a proven platform adapter and test native Windows recovery.
R RNG, options, search paths, `.libPaths()`, reference semantics and error-side
effects must match the existing documented contracts. No rollback is promised
for arbitrary external or reference-object effects.

The host starts the kernel and analyzer when opening a notebook, before declaring
execution ready. Analysis services use the selected R installation and project
policy; key caches by those identities as well as source. An analyzer failure
keeps source editable, invalidates unconfirmed analysis and exposes recovery;
it never converts missing analysis into permission to execute. Queue/cancel
obsolete analysis requests independently of kernel interrupts. Ordinary editing
and rendering must remain responsive while either R process is busy.

Atomic saves retain same-file/symlink/hard-link and external-edit protections.
Formatting is a revision-checked transaction coordinated with local typing.
Loopback binding, origin checks, CSP, sanitization, artifact paths, resource
limits, source confidentiality and shutdown ownership remain release gates.

## mirai decision

Async task management and parallel notebook evaluation are separate decisions.
Keep one dedicated serial kernel regardless of executor. Evaluate mirai during
the engine prototype for persistent state (`cleanup = FALSE` with an explicit
notebook environment), streamed events, cancellation/completion distinction,
RNG/library preservation and native Windows behavior. Use it for the kernel
only if it deletes more lifecycle/transport machinery than the R bridge and
additional event channel introduce. Otherwise retain a direct persistent
kernel transport. This is a bounded implementation decision, not an open
question about the ownership architecture.

The fit test must explicitly account for mirai's dispatcher requirement for
`stop_mirai()` and its immediately resolved cancellation result: that result
does not establish actual R completion. See the
[cancellation contract](https://mirai.r-lib.org/reference/stop_mirai.html) and
[daemon cleanup settings](https://mirai.r-lib.org/reference/daemon.html).

Independent source analysis, render jobs and explicit user background tasks are
natural pool candidates. They require revision-tagged inputs/results and cannot
mutate the live notebook environment. The first migration does not add automatic
parallel cell semantics or a new public async-cell API.

## Distribution

Ship a versioned application host and built browser assets; end users do not
build JavaScript or install npm dependencies when opening a notebook. Platform
release archives/installers include the supported Node runtime. The R package
locates an explicitly configured or installed compatible host, reports a clear
installation/version error, and never silently downloads executables while
running notebook code. Support the existing CLI and R entry points; preserve
R selection and private/project libraries. CI must validate Linux, macOS and
Windows packages, startup, first/warm execution, interruption and cleanup.
Source-development builds use a pinned Node toolchain and lockfile.

## Component migration inventory

| Current component | Destination and concrete work |
| --- | --- |
| `R/session.R` | Port the reactive controller to TypeScript: revision transactions, invalidation, execution/run/widget journals, scheduling and freshness. First extract R-specific metadata/rendering calls behind the engine adapter. Keep the existing implementation selectable only during isolated parity tests, then remove it from production. |
| `R/analysis.R`, `R/notebook.R` | Retain the R parser, scoping walk and lossless codec. Expose revision-tagged per-cell analysis and file-codec services. Move interactive ownership indexes and incremental graph maintenance to the host. Retain fixed-plan R graph helpers for `alder_source()`/`alder_test()` and compare their results with the host on the same analysis fixtures. |
| `R/worker.R`, `inst/worker/worker.R` | Replace the R process supervisor and 20-ms pipe polling with the host engine adapter. Retain and modularize R evaluation, environments, native output capture and request-scoped interruption. Implement the versioned handshake, framed messages, ordered events and true completion acknowledgments. |
| `R/server.R`, `R/mcp.R`, `R/lsp.R` | Move networking, transport framing, connection lifecycle and dispatch into host libraries. Port origin/CSP/path/error and native LSP URI contracts. Local and URL MCP adapters call the same controller methods and operation journals. |
| `R/dataflow.R` | Put interactive graph/outline/status projections in the host and update affected records only. Keep R object summarization in the kernel. Preserve the public pure snapshot helpers and test compatibility with the new projections. |
| `inst/app/static/app.js`, `js/src/editor.js` | Split into typed document, command, event and view modules. Replace state polling with push/recovery, send pending edits with Run, create editors immediately, reconcile changed cells and virtualize offscreen editors. Keep trusted keyboard, focus, scroll, source-conflict and diagnostic behavior. |
| `R/outputs.R`, `R/ui-widgets.R`, `R/cache.R` | Keep R APIs, validation, renderers and cached computation semantics. Reuse or lazily initialize capture infrastructure; return bounded metadata/artifact handles. Make one installed widget implementation accessible to the kernel, then remove the byte-mirrored module and its build step once bootstrap parity passes. |
| `R/config.R`, `R/layout.R`, `R/app.R` | Move session configuration, layout persistence and app presentation coordination into the host; preserve the documented R configuration/construction APIs and sidecar formats. Avoid two independently mutating sources of configuration. |
| `R/packages.R`, `R/format.R`, `R/convert.R`, `R/publish.R`, `R/export.R` | Retain R ecosystem work and pure converters. The host coordinates revision checks, file transactions, jobs and artifacts; Session-backed exports use its controller. Package changes invalidate relevant engine/analysis state. Preserve caller-environment behavior of the fixed-plan source/test utilities. |
| `R/cli.R`, `exec/`, `inst/worker/server.R` | Make R and shell entry points locate the packaged compatible host and selected R. Port exit codes, signals, library/bootstrap settings and shutdown ownership; retire the R HTTP launcher after installed parity. |
| `tests/testthat/`, `dev/reviews/` | Keep R semantics tests in R; port controller/transport contracts to TypeScript and retain installed browser/API/MCP acceptance. Adapt the latency observer to command/event receipts without moving its trusted-input or visible-result endpoints. Carry forward raw baseline artifacts for comparison. |

Maintain a contract checklist as each component moves: original regression,
new regression, old component removed, and installed evidence. Do not replace
an entire module merely because its filename appears in this inventory: R
semantics and public pure helpers have explicit owners above.

## Migration work and exit criteria

| Phase | Work | Required evidence before cutover |
| --- | --- | --- |
| 0: measurement | Add trusted input-to-result fixtures, latency distributions, opt-in stage traces and CPU profiles. Record current baseline and unmet targets. | Exact results/source/run receipts, all samples retained, negative controls reject old/wrong results and missing traces; clean teardown. |
| 1: contracts and host scaffold | Create TypeScript host/shared-schema packages, version handshake, engine adapter interface, event cursor/snapshot rules and packaged launchers. Specify commands above as executable schemas. | Schema/compatibility tests, no execution before readiness, installed host/R discovery on every platform. |
| 2: complete vertical slice | Implement create/edit/analyze/run/stream/interrupt/recover using one persistent kernel and the new host. Make the mirai/direct-adapter decision using the same scenarios. | Correct three-cell flow, immediate edit-and-Run, serial state/RNG, streamed output, late Stop, worker death and restart; benchmark includes all process hops. |
| 3: single controller | Port Session's graph scheduling, invalidation, revision transactions, run/widget journals and value freshness. Extract remaining R-only helpers. | Existing Session, HTTP and MCP contracts through the new controller; no shadow execution of user code. Remove the old production scheduler after parity. |
| 4: services and clients | Move HTTP, MCP and LSP transport to host libraries; make interactive R/CLI and Session-backed export entry points use the host; migrate save/format, config, packages, layout, publishing and artifacts. | Browser/API/MCP agreement, native paths/lint, conflicts, output fidelity, caller-environment source/test semantics, startup/shutdown and platform tests. Delete duplicated local/URL MCP dispatch and settlement logic. |
| 5: latency and long notebooks | Push deltas, incremental analysis/projections, reusable/lazy capture, bounded previews, selective rendering and editor virtualization. Initialize internal machinery before execution readiness without executing notebook source. | Warm median <=50 ms/p95 <=100 ms for every scalar scenario, measured from real input; first-after-readiness interactions meet the same targets across fresh sessions. Unrelated cells do not dominate. Scientific/graphics and trusted browser flows still pass. |
| 6: release | Remove transitional adapters and obsolete production code, revise ADRs/docs, ship host/runtime/R packages and run full installed/cold gates. | Exact artifact identities, all supported platforms, complete correctness/latency gates and no orphan processes. Historical release evidence is not reused as proof for changed artifacts. |

Phases may overlap behind the engine interface, but there is only one execution
owner for a notebook at any time. Differential tests use isolated notebooks and
processes; never evaluate effectful user code twice to compare backends. Existing
regressions are specifications to port, not code to discard merely because the
implementation language changes. The current task implements phase 0 and this
specification, not the host migration itself.

## Measurement rules and references

Measure elapsed durations with monotonic clocks in each process. Correlate by
identifiers; do not subtract unrelated process/browser clock origins. Record
inclusive stage spans, so nested spans must not be added as disjoint costs.
Separate instrumented traces/CPU profiles from latency acceptance; profiler and
observer overhead are not subtracted to manufacture a faster result. Keep
timeouts, missing stage events, wrong results and resource failures fatal.
Performance-budget failure is an explicit outcome even in baseline/report mode.

References checked 2026-09-06: [RAIL response guidance](https://web.dev/articles/rail),
[Node event-loop work](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop),
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[LSP/JSON-RPC libraries](https://github.com/microsoft/vscode-languageserver-node),
[mirai daemon configuration](https://mirai.r-lib.org/reference/daemon.html),
[mirai cancellation](https://mirai.r-lib.org/reference/stop_mirai.html),
[Node process signals](https://nodejs.org/api/child_process.html).
