# Alder workboard

Updated: 2026-09-19. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Local diagnostics and observability — Accepted.**

**Owner:** primary implementer; independently reviewed and accepted by the lead.

Assess whether the accepted Mac app records enough bounded, local evidence to
diagnose bugs, hangs, crashes, latency, resource growth and child-process failures
without slowing ordinary notebook work, filling the disk or retaining notebook
content and secrets unnecessarily.

**Accept when:** desktop and backend write private structured lifecycle and terminal
diagnostics with app/backend/session/operation/run/child correlation; the detached
backend can no longer lose fatal evidence; coarse edit/save/run/startup/service timing
and long-running phases are reconstructable; cleanup, renderer, MCP and subprocess
failures have bounded metadata; logs rotate under a fixed total cap; corrupt recovery
copies are pruned; and Help can export a local previewable diagnostic bundle. Default
records and exports contain no notebook source/output/value/widget/upload content,
credentials, environment values or absolute user paths. Logging failure never blocks
open, edit, run, save, close, recovery or cleanup. No remote telemetry, per-keystroke/
stream-chunk tracing, duplicated recovery history or fixed latency release gate is added.

**Baseline:** accepted app `8a1381ce`; docs-only workboard commit `3345823`.

**Accepted checkpoint:** `ea21b96` (`Add bounded local diagnostics`). It supersedes
rejected candidates `1e75e27` and `5bef3df`.

**Original review findings:** the accepted baseline discarded detached backend stderr; desktop and
renderer crashes have no durable evidence; strong host IDs and terminal operation state
remain in memory only; useful child stderr disappears or is too sensitive to persist;
cleanup and MCP failures can be swallowed; Quarto has no deadline; the existing
input-to-visible timing seam is test-only; there is no diagnostic export; and corrupt
recovery copies can accumulate. Existing output, artifact, operation and recovery bounds
are useful and must remain separate from diagnostics.

**Next action:** begin the queued dead-code and dependency-removal checkpoint after the
lead/user process retrospective establishes any changes to the working method.

**Testing constraint:** do not take over Carl's visible desktop. Use background
or isolated Mac GUI checks where native interaction matters. The in-app browser
blocked Alder's localhost URL, so it did not establish native behavior.

**Acceptance evidence:** runtime/privacy and performance/storage reviewers both pass
`ea21b96`. Staged fatal evidence survives indefinite retention-lock contention without
raw error content; 40 concurrent first-run writers converge on one private identity;
1,500 saturated operation lifecycles leave no active timers; a 2,500-record close drains
fully; two concurrent writers remain under the shared cap; production events retain
their typed categories; batching materially reduces persistence cost; and the simplified
benchmark reports reconciled event counts, retained size and wall/CPU timing.
One uninterrupted signed-app acceptance passed in 347.96 seconds: R helpers 164; fast
suite 441 with 41 classified source-only skips; installed Engine 19, Jupyter 5, Host 11
and MCP 1; browser journeys 9; native cleanup and full packaged journey; strict signing,
62 dependency licenses and required runtime notices; no owned children. A separate
hidden packaged journey exported private diagnostics from 543 events with none of the
planted source, output, path, filename, identifier, token, cookie or environment secrets.

## Work queue

Only the current assignment is active. Queued items are approved work in intended
order; their implementation details are settled when assigned.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac architecture reset and complete app | Accepted | Primary implementer | `8a1381ce`: accepted document, execution, reactivity, services, Mac delivery, tests and UI/UX foundation; detailed slice history lives in Git |
| Local diagnostics and observability | Accepted | Primary implementer | `ea21b96`: bounded private local diagnostics, safe export, durable fatal evidence, truthful timings and full signed-app acceptance |
| Dead code and dependency removal | Queued | Unassigned | After observability, delete unreachable production code, unused exports/files/assets/scripts and unused dependencies across TypeScript, native and R surfaces; retain a runnable signed Mac app |
| Production-path simplification | Queued | Unassigned | Replace pass-through layers, duplicate ownership and unnecessary policy machinery in the remaining live paths with the smallest cohesive implementation that preserves accepted notebook behavior |
| Simplification verification and acceptance | Queued | Unassigned | Rebuild affected tests around user-visible behavior, remove obsolete fixtures/tooling, and pass focused workflows plus the complete signed-app acceptance on the simplified tree |

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

`ea21b96` is the accepted Mac application with bounded local diagnostics; `41ccbfd`
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
