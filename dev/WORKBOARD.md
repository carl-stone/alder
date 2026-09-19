# Alder workboard

Updated: 2026-09-19. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Simplification verification and acceptance — Implementing.**

**Owner:** primary implementer in the listed implementation worktree.

Finish the simplification campaign by aligning the supporting tests and tooling with the
smaller production design, then produce the exact Mac release candidate. Remove tests,
fixtures, mocks, scripts and dependencies that exist only for deleted mechanisms; replace
implementation-pinning assertions with concise checks of preserved user-visible behavior
and important failure boundaries. Fill only material gaps exposed by the simplification
reviews, including launch-scoped `--no-run` acquisition.

**Accept when:** the remaining verification suite clearly protects documents/sessions,
execution/reactivity, outputs/widgets/cache, optional services, publishing, recovery,
diagnostics/privacy, native lifecycle and child cleanup without duplicating internal
call-count or layer-shape assertions. Fast checks remain proportionate and terminate
normally. One exact clean candidate then passes independent test-quality review and one
complete uninterrupted signed-app acceptance, including installed Host/Browser journeys,
strict signing/notices, hidden packaged diagnostics export/privacy and zero owned children.

**Baseline:** accepted production simplification through
`21f678ca1bda44d27d4debb1101f1eb87c59a767`. Architecture review passed `a334513`; the
focused correction review passed fresh/existing `--no-run`, Host 11/11, Browser 9/9,
strict unknown-option validation and cleanup.

**Non-goals:** do not preserve test count or suite layout; do not delete a behavior test
merely to shorten the suite; do not add coverage quotas, checksum inventories, benchmark
gates, qualification frameworks or tests whose only assertion is that the current
implementation remains arranged the same way.

**Next action:** primary implementer performs the final behavior-led test/tooling sweep,
runs focused checks and returns one exact clean candidate. The lead holds the turn through
independent review; only after that passes does the final reviewer run `accept:final` on
the same commit.

**Testing constraint:** do not take over Carl's visible desktop. Use background or
isolated Mac checks for native behavior.

## Work queue

Only the current assignment is active. Queued items are approved work in intended
order; their implementation details are settled when assigned.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac architecture reset and complete app | Accepted | Primary implementer | `8a1381ce`: accepted document, execution, reactivity, services, Mac delivery, tests and UI/UX foundation; detailed slice history lives in Git |
| Local diagnostics and observability | Accepted | Primary implementer | `ea21b96`: bounded private local diagnostics, safe export, durable fatal evidence, truthful timings and full signed-app acceptance |
| Dead code and dependency removal | Accepted | Primary implementer | `1080f153`: removed confirmed unreachable code, five obsolete files and eight unused dependencies; independent reachability and behavior reviews passed |
| Production-path simplification | Accepted | Primary implementer | `a334513` plus `21f678c`: clearer live ownership with launch-scoped no-run restored; architecture and focused behavior reviews passed |
| Simplification verification and acceptance | Implementing | Primary implementer | Rebuild affected tests around user-visible behavior, remove obsolete fixtures/tooling, and pass focused workflows plus the complete signed-app acceptance on the simplified tree |

The following requirements apply to the relevant slices and are checked again
when accepting the complete app:

- Delete replaced production paths, handwritten parsing, redundant validation,
  bespoke dependency certification, source-lineage/provenance gates and the Ark
  patch/build/readiness machinery. Retain ordinary locks, package integrity and
  license notices.
- Replace tests that pin discarded implementations with focused behavior checks.
  No test count, file or suite structure must be preserved; delete whole suites
  when rebuilding a smaller behavior-led set is clearer. Keep CI/build/check
  tooling small; remove obsolete platform and release gates.
- Replace overcomplicated components outright when their ownership model is
  wrong. Do not create compatibility adapters, migrations or parallel paths for
  pre-release internals being removed; delete the old production path with its
  tests once the smaller behavioral replacement works.
- In residual cleanup, remove custom strict-JSON expectations, old latency tracing,
  exact Ark-version assertions, pre-reset migration coverage, private registry/lock/
  nonce choreography, exact controller event and restart counts, renderer/DOM
  identity checks, fake language-service methods and forged private R events.
  Consolidate duplicate schema, settings, MCP catalog, barrier and publishing
  matrices. Preserve checks for lost edits, atomic save and recovery, external
  conflicts, stale results, interruption, reactive semantics, output/widgets/cache,
  passive inspection and child cleanup.
- Fill the behavior gaps with real shared-owner journeys: desktop and agent edit
  the same notebook, conflict without lost work, either client detaches while the
  other continues, backend failure and reopen preserve work, and two notebooks
  remain isolated. Optional-service acceptance must exercise real selected-cell
  formatting and format-on-save, project-local package declaration/install/use,
  dirty-document publishing, cancellation and post-failure usability.
- Provide one documented Mac acceptance command that typechecks, runs R tests,
  builds and verifies the signed app, and runs a focused installed-host/browser
  smoke set. Keep the ordinary fast unit command separate. Both commands must
  terminate normally and clean up owned Node, R, Ark, Quarto and Electron children;
  assertion success followed by a hung process is a failure.
- After the production seams and behavior suite stabilize, add small targeted
  generators with strict per-case bounds: property-check random dependency graphs;
  fuzz malformed notebook and recovery inputs; exercise edit/save/crash/reopen as
  stateful action sequences; and differentially compare a constrained corpus of
  ordinary R expressions through `Rscript` and packaged Alder. Assert durable
  product invariants such as no lost accepted edits, monotonic revisions, notebook
  isolation, stale-output rejection and dependency-order correctness. Minimize and
  retain useful failures as ordinary regression cases; do not build a bespoke
  fuzzing platform or use case counts as a quality metric.
- Keep the shared core OS-independent with small Mac adapters. No Rust mandate,
  speculative portability framework or retained Linux/Windows implementation,
  installer or container workflow.
- Preserve document/recovery behavior, shared GUI/agent ownership, renderer
  isolation, authenticated local APIs and child cleanup. Core editing and saving
  must remain usable through R, analysis and optional-service failures, with no
  Keychain prompt for ordinary use.

Representative R notebooks and expected results belong to their implementation
slices; final Mac acceptance exercises the integrated app. Other platforms and
public distribution/notarization remain deferred. Local runnable Mac delivery is
part of this queue.

## Dead-code and simplification campaign

Begin this campaign only after local diagnostics and observability is accepted.
Work through it as three runnable checkpoints rather than one unreviewable rewrite.

1. **Remove code that has no live responsibility.** Establish the real packaged,
   development, test and generated entry points. Use language-native compiler and
   linter checks plus project-level import/export, file and dependency reachability
   analysis to find candidates. Include stale feature flags, unreachable error and
   compatibility branches, unused protocol members, orphaned assets and scripts,
   obsolete R helpers, unused packages and source files represented only by generated
   copies. Classify reflection, Electron IPC, native menu, worker/child entry points
   and string-addressed protocol handlers before deletion. Delete confirmed dead code
   and its mechanism-only tests and dependencies; do not add suppressions merely to
   make an analyzer quiet.
2. **Simplify the code that remains live.** Review the surviving paths by product
   responsibility: document/session ownership, renderer/native bridge, execution and
   output, optional services, persistence/recovery, diagnostics and packaging. Remove
   pass-through wrappers, duplicate state and validation, speculative extension
   points, one-implementation interfaces, obsolete configuration, unnecessary retry
   and fallback layers, and abstractions whose only callers can be expressed directly.
   Prefer deleting or rewriting a confused component over preserving its internal API.
   Do not use line count or a complexity score as a target; require fewer owners and
   fewer state transitions for the same behavior.
3. **Rebuild verification around the smaller product.** Replace tests that refer to
   deleted symbols, call counts or internal layer boundaries with checks of observable
   behavior. Remove redundant mocks, fixtures, snapshots, scripts and dependencies.
   Keep the focused invariants already named on this board, exercise representative
   native Mac workflows and failure recovery, and finish with the exact signed-app
   acceptance command. Compare startup, edit/save/run responsiveness, diagnostic
   overhead, bundle size and owned-child cleanup with the accepted observability
   checkpoint; investigate material regressions without imposing arbitrary numeric
   gates.

Static reachability, coverage and diagnostics are evidence, not independent product
requirements. Public or dynamically addressed code is retained only when a real Alder
entry point or accepted behavior needs it. Each checkpoint must remove replaced paths
completely, leave generated artifacts reproducible from source, and end with a clean
commit that the next stage can safely simplify.

## Latest accepted checkpoint

`21f678c` is the accepted Mac application after production-path simplification; `1080f153` removed dead code and dependencies, `ea21b96` supplies bounded local diagnostics and `41ccbfd`
records the synchronized architecture and workboard state. Independent runtime/privacy
and performance/storage reviews passed, followed by one uninterrupted signed-app
acceptance in 347.96 seconds. The run passed R helpers 164, fast host/generative 441
with 41 classified source-only skips, installed Engine 19, Jupyter 5, Host 11 and MCP 1,
browser journeys 9, native cleanup and the full packaged journey. A separate hidden
packaged run exported private diagnostics from 543 events without any planted notebook
content, path, caller identifier or secret. Strict signing, dependency notices and owned-
child cleanup passed.

The staged app at `host/.application-desktop/Alder.app` follows the implementation
checkout and may contain newer, unaccepted changes. Acceptance is tied to the commit
above, not that mutable app path. Build and launch commands are in
[README.md](README.md). Older checkpoint detail lives in Git and the implementation
task rather than this board.

## Task locations

| Role | Location |
| --- | --- |
| Lead task | `01a0b55f-feaf-7c03-9964-b448891e33d5` |
| Primary implementation task | `01a0b5a6-22ac-7480-9394-5cc4c1ba807d` on `local` |
| Implementation worktree | `/Users/carlstone/.codex/worktrees/ebd6/alder` |
| Implementation branch | `codex/mac-document-foundation` |
| Lead documentation checkout | `/Users/carlstone/alder` |
