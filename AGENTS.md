# alder

alder is a modern reactive notebook for R: plain-text `.R` notebook files, statically analyzed into a dependency DAG, executed in dependency order, with a marimo-inspired UX and app mode.

```
alder/
├── LICENSE                  # Apache License 2.0 text
├── README.md                # project summary + quickstart
├── NEWS.md                  # package release notes
├── VISION.md                # product brief (the spec)
├── AGENTS.md                # this file
├── ALDER_TASK.md            # historical release brief/reference (excluded from package)
├── TASK_STATE.md            # durable checkpoint/evidence ledger (excluded from package)
├── USER_FLOWS.md            # observable acceptance flows (excluded from package)
├── NORTH_STAR_RUBRIC.md     # release scoring and non-negotiable gates
├── SUBAGENTS.md             # specialist review personas and evidence rules
├── DESCRIPTION              # package metadata and R/system dependencies
├── NAMESPACE                # generated public API exports
├── .Rbuildignore            # non-package files excluded from R CMD build
├── .gitignore               # ignore rules
├── .lintr                   # lintr config (R-idiomatic name styles, no line-length)
├── .github/workflows/       # Linux R 4.6.1/R-devel quality + Windows CLI CI
├── exec/                     # canonical packaged CLI launchers
│   ├── alder                 #   Unix foreground launcher + signal lifecycle
│   └── alder.cmd             #   Windows batch launcher with exit propagation
├── demo.R                   # runnable demo notebook (iris + slider + ggplot)
├── js/                      # CodeMirror 6 source, npm lockfile, and bundle tooling
│   └── src/editor.js        # editor extension assembly; builds vendored browser asset
├── R/                       # package sources (runtime, analysis, tooling, publishing, UI)
│   ├── alder-package.R      #   package-level documentation
│   ├── notebook.R           #   # %% parser/serializer; byte-identical round-trip
│   ├── analysis.R           #   eval-order scoping walk per cell -> DAG, blocking/warning diagnostics
│   ├── app.R                #   output-only app configuration helpers
│   ├── cache.R              #   dependency-aware computation cache
│   ├── config.R             #   layered configuration
│   ├── convert.R            #   ipynb/Rmd/qmd conversion
│   ├── dataflow.R           #   projected DAG, variables, and outline data
│   ├── export.R             #   publishing and noninteractive execution
│   ├── format.R             #   cell-aware R formatting
│   ├── layout.R             #   app presentation/layout sidecars
│   ├── lsp.R                #   R language-server bridge
│   ├── mcp.R                #   agent-facing MCP transport
│   ├── outputs.R            #   output/layout helpers + shared native worker rendering hook
│   ├── packages.R           #   project packages and renv lifecycle
│   ├── performance.R        #   opt-in process-local timing spans and CPU profiling
│   ├── publish.R            #   DAG-ordered Quarto/knitr and direct-Pandoc rendering
│   ├── cli.R                #   one-command CLI, argument parsing, launcher install
│   ├── ui-widgets.R         #   ui$ alder_widget module (explicit $value) — SINGLE SOURCE OF TRUTH
│   ├── session.R            #   Session R6: cell_state records, reactive schedule, widget ops
│   ├── worker.R             #   Worker R6: processx + later pipes, JSON-lines RPC, restart/release
│   ├── server.R             #   httpuv app: static + JSON API, origin/CSP boundary, start/stop
│   └── utils.R              #   package-internal helpers (%||%)
├── inst/
│   ├── examples/iris.R       # installed base-R reactive tutorial
│   ├── app/                 # frontend assets
│   │   ├── index.html       #   single page (editor chrome + templates)
│   │   └── static/          #   app.js (state render, edit/widget coalescers, app view), style.css
│   ├── publishing/          # standalone report styling for external render engines
│   └── worker/              # worker-side runtime
│       ├── worker.R         #   Rscript worker: JSON-lines stdin/stdout protocol (local() runtime)
│       ├── ui-widgets.R     #   MIRROR of R/ui-widgets.R (cp to sync, ADR 0007; byte-identity test)
│       └── server.R         #   installed-package launcher: main(args), start_alder, later pump
├── man/                     # generated Rd documentation for the public API
├── tests/
│   └── testthat/            # notebook round-trip, analysis, widgets, session schedule, server, browser
│       ├── helper-session.R #   session/worker setup + deadline polling
│       ├── helper-http.R    #   subprocess + later pumping HTTP harness
│       ├── test-notebook.R  #   byte-fidelity parser boundaries
│       ├── test-analysis.R  #   R scoping/diagnostic contracts
│       ├── test-app.R       #   app-mode configuration
│       ├── test-browser.R   #   installed launcher + real Chrome acceptance suite
│       ├── test-cache.R     #   cache identity/invalidation/corruption
│       ├── test-config.R    #   layered settings and editor preferences
│       ├── test-dataflow.R  #   DAG/variable/outline projections
│       ├── test-export-convert.R # publishing/conversion/source APIs
│       ├── test-export-conditions.R # retained conditions and failed-export destination safety
│       ├── test-format.R    #   cell-aware formatting
│       ├── test-layout.R    #   app layout persistence
│       ├── test-lsp.R       #   language-server framing and translation
│       ├── test-lsp-hover.R #   native help structure and hostile Markdown sanitization
│       ├── test-lsp-paths.R #   native URI identity and notebook-local lint policy
│       ├── test-markdown-safety.R # inert unknown HTML wrappers and nested-content sanitization
│       ├── test-mcp.R       #   MCP schemas and live-session parity
│       ├── test-packages.R  #   renv and sandbox isolation
│       ├── test-performance.R # opt-in tracing and process-local span contracts
│       ├── test-publish.R   #   real Quarto/knitr and direct-Pandoc engine contracts
│       ├── test-outputs.R   #   rich output constructors and fallback behavior
│       ├── test-output-composition.R # native plot/model/table/layout parity + renderer conditions
│       ├── test-widgets.R   #   mirror byte-identity + constructor/validation ($value)
│       ├── test-session.R   #   reactive execution, widget ops, worker failures
│       ├── test-worker-library.R # installed parent/worker package-library parity
│       ├── test-worker-bootstrap.R # quoted paths, R settings, and startup failures
│       ├── test-server.R    #   HTTP boundary, atomic save, security headers
│       ├── test-cli.R       #   platform launchers, signals, idle/API shutdown
│       ├── test-streaming.R #   ordered streaming logs/progress/append output
│       └── test-carlstone-review.R # requester-named deterministic regression file
└── dev/                     # developer documentation (not docs/: reserved for pkgdown)
    ├── README.md            # navigation for dev docs
    ├── ARCHITECTURE.md      # target TypeScript/R architecture and migration gates
    ├── examples/bulk-differential-expression.R # substantial simulated bulk RNA-seq notebook
    ├── parity-demo.R        # broad scientific/interaction review notebook
    ├── inbox/               # user-observed issue scratchpad (preserved verbatim)
    ├── reviews/             # cycle probes, evidence, finding log, and flow matrix
    ├── open-questions.md    # deferred Qs, become ADRs when decided
    └── decisions/           # accepted architecture decision records
        ├── index.md                    # ADR index + format link
        ├── template.md                  # blank ADR template
        ├── 0001-notebook-file-format.md # plain .R + # %% cells (explicit library(alder))
        ├── 0002-rerun-model.md          # reactive execution: automatic default, optional lazy
        ├── 0003-widget-value-semantics.md # explicit $value; no coercion promises
        ├── 0004-execution-engine.md     # one serial R worker per notebook; request-scoped interrupt
        ├── 0005-marimo-reference-not-reactor.md # marimo, not Reactor; source-verified behavior
        ├── 0006-process-transport.md    # processx + later event loop; strict response identity
        ├── 0007-widget-module-mirror.md # widget module mirrored into inst/worker/ (byte-identity)
        ├── 0008-product-form.md         # local web app; output-only app view
        ├── 0009…0016                    # streaming, outputs, editor, app, and agent decisions
        ├── 0017-bounded-dynamic-r.md    # bounded literal eval/source behavior
        ├── 0018-renv-environments.md    # standard renv locks and project libraries
        ├── 0019-product-surface-priorities.md # R-first/CLI/editor/publishing direction
        ├── 0020-explicit-publishing-engines.md # Quarto/knitr vs static Pandoc
        └── 0021-recursive-widget-output-identity.md # nested layout/lazy widgets
```
## Documentation
All agents must update AGENTS.md and all repo documentation immediately after making changes that would render those documents stale or incorrect.

Value inspection is owned by `Session`: HTTP and both MCP backends reject
noncurrent definitions with `stale_value` (HTTP 409), including responses that
become stale while pending. Dataflow variables expose primitive values only
for completed cells; retained notebook outputs remain available with their
explicit stale status.

LSP file URIs preserve native notebook paths so the language server resolves
project `.lintr` settings. Diagnostics outside a single cell are retained in
the Session `editor_diagnostics` array, exposed unchanged through HTTP and
both MCP state backends. They retain `source = "lsp"`, their error/warning/info
level, message, code, a null cell `range`, and the original `file_range` when
supplied. They do not block graph execution or acquire a false cell location.
State polling synchronizes ordinary edits with the language server and clears
notes for the previous source while fresh diagnostics are pending. Diagnostic
publications with an obsolete supplied document version are ignored; accepted
publications replace the previous set. Turning lint off clears both cell and
document lint diagnostics even after language-server failure.

Browser diagnostics must match the displayed and acknowledged cell source;
an idle typing timer cannot make an older snapshot current. Formatting returns
authoritative cell body/type/revision receipts and accepts an optional complete
revision precondition map. The client serializes explicit formatting with source
edits, adopts confirmed changes in focused editors, and preserves newer typing
and genuine external conflicts. All target revisions are checked before any
formatting mutation.

Retained client/server action errors remain complete and are labelled
`Last failed action:` in the status area so an earlier run failure is distinct
from diagnostics for the current source. This label does not clear backend
`last_action_error` state or replace its normal success/retry lifecycle.

Keyboard Save invokes the shared save operation directly, even before a state
poll enables the toolbar button. Keyboard, button and autosave requests share
a serialized queue that flushes source edits and optional formatting before
writing; failure remains visible and source conflicts remain explicit.

Markdown sanitization removes dangerous descendants and unknown-wrapper
attributes before retaining inert text. Hover help uses a separately extended
safe structural allowlist and unwraps unknown elements after sanitizing their
children; upstream raw help remains available in the response.

Explicit F1 help fetches independently of CodeMirror's pending mouse-hover
lifecycle, so ordinary state polls cannot discard requested help. Delivery
requires the same source, complete selection and editor focus; Escape, edits,
selection changes, blur, mouse interaction and destruction cancel pending
intent. Mouse retries cannot abort pending F1 help or replace an open panel.

For a final automated cold-start cycle, use
`dev/reviews/run-cold-start-validation.sh` inside `codex-universal` below one
long-lived `tini -s`, supplying the frozen artifact, its SHA-256, an empty
evidence directory, and a separate empty audit root. The caller owns the
independent container restart; the driver only observes cleanup. It clears test
filters, runs static/source-verification/installed-audit/package-check gates,
optionally runs the unfiltered source suite, and rejects nonzero zombie counts
or remaining review workloads/ports. Its successful exit does not replace the
separate screenshot and specialist review.
The installed MCP audit retains pre-URL results and startup source, process,
HTTP and pipe observations. Startup remains subject to the original deadline;
observation failures are fatal, and a successful replay does not explain an
earlier failure whose startup diagnostics were not retained.

Worker startup parses the complete runtime before evaluating its private scope.
The bootstrap preserves notebook R options, JIT selection, library resolution and
empty trailing arguments; paths are encoded as R literals in process arguments.

Worker protocol reads, parsing and response writes retain request identity across
late interrupts. A delayed start acknowledgement cannot make a completed eval's
SIGINT kill the worker or interrupt the next request; actual eval interruption
remains enabled from its own start acknowledgement through evaluation.

Explicit Restart R invalidates retained runtime values and marks code-cell outputs
stale before replacing the worker. Spawn/readiness failure retains output bytes
and editable source with stale status; old callbacks cannot restore inspections.

Dataflow navigation retains existing control and container identities across state
polls. Variable owners, dependency links, graph controls/nodes, outline entries and
the minimap update their current labels, targets, status and geometry in place.
Reconciliation keeps a retained focused branch stationary when siblings change
order; graph canvas scrolling survives ordinary refreshes. Removed entries and
unavailable projections are still removed or replaced by their current error.
Browser regressions deliver held real state responses and wait for the next
serialized poll to prove rendering, then check current DOM identity, focus,
scrolling and trusted keyboard navigation. They cover unchanged state, renaming,
moving a focused target, inserting a target and removing retained targets.

The no-consumer MCP run-button test completes the normal lifecycle/startup
handshake before applying its two-second widget wait budget. Keep the separate
intentional startup-timeout regression and all reset/repeated-click assertions;
the short budget applies per local wait, not to total MCP call elapsed time.

The optional bulk-DE scale fixture lives in `dev/examples/` so its Bioconductor
dependencies do not become Alder imports. It contains the analysis itself,
uses simulated integer counts with known truth, and keeps interactive result
thresholds downstream of the model fit. Its separate scale audit must compare
ordinary R execution with Alder and verify actual long-notebook browser behavior;
line counts alone are not execution evidence.

Session caches editor reference ranges by ordered cell IDs, source bodies,
definitions and references. Runtime-only updates reuse those ranges; changing
source, symbol ownership or cell structure recomputes them. Dynamic dataflow
status, values, diagnostics and graph projections remain refreshed per state.
HTTP state encoding also reuses encoder-produced JSON for both compatibility
copies of these ranges. Ordinary R state remains structured. Cached transport
encoding must decode to the same complete state, including after source edits;
projection errors fall back to ordinary encoding.

The accepted migration target is `dev/ARCHITECTURE.md`; existing ADRs describe
the current R host until their replacements land. Input-to-result evidence uses
`dev/reviews/run-input-latency.sh` under one long-lived `tini -s` in
`codex-universal`. Baseline latency and instrumented profiling are separate
processes. `ALDER_PERF_TRACE_DIR` enables private JSONL stage traces; optional
`ALDER_PERF_RPROF=1` enables CPU sampling. Neither changes the normal state
payload. Opt-in spans use `microbenchmark::get_nanotime()` (an optional Suggests
dependency); ordinary execution neither loads it nor starts a profiler.
The browser observer records trusted input, exact source/result and
run receipts, acknowledged render versions and a two-frame paint-opportunity
proxy. Input starts at `event.timeStamp`; handler entry is retained separately
so time queued on the browser main thread remains part of the measurement.
No extra state polling is allowed in a measured interval. Timings from
different monotonic clock origins must never be subtracted. Baseline/report
mode can succeed with unmet budgets; `summary.json` must retain that failure,
and `--enforce-budget` exits nonzero. Historical release acceptance does not
establish the new responsiveness requirements.
Failed fixtures do not stop independent benchmark fixtures or the separate
profiling pass. Their errors remain fatal to the overall run; the report labels
surviving timings as partial diagnostics and retains failed-action receipts.
Missing profiling fixtures, CPU summaries or correlated stages cannot pass.

Generated `dev/reviews/evidence/` contents and Python bytecode caches stay local
and are ignored by Git. Commit the review scripts and written reports; their
evidence paths identify retained local runs, not files included in a checkout.
CI uploads its input-latency evidence as a workflow artifact.
