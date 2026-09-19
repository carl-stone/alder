# Alder workboard

Updated: 2026-09-18. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Document truth and recovery — Implementing.**

**Owner:** primary implementer in the listed implementation worktree.

Replace the overlapping backend, browser and native recovery state machines with
one understandable document-truth model.

**Accept when:** an accepted source mutation is durable in backend recovery before
success is acknowledged; the backend owns accepted source, disk owns the last
saved baseline, one backend journal owns accepted-unsaved source and the renderer
stores only typing not yet accepted by the backend. Coalesce native draft writes
and flush the latest draft before submission, reload and close. Startup offers at
most one backend recovery candidate and one renderer draft with clear restore,
discard or save-copy behavior. Save As carries notebook bytes and notebook-owned
metadata without copying project package or settings policy. Preserve atomic save,
external-edit conflicts, concurrent GUI/agent revisions, stale-result rejection
and bounded unhealthy-host close. Delete branch inventories, recovery artifacts,
rebind transactions, historical-generation protocols, structural-patch replay and
their implementation-pinning tests once the smaller path works. Deliver focused
crash/reopen/shared-owner journeys and a runnable signed Mac build without taking
over Carl's desktop.

**Checkpoint:** `9ab60b5` (`Simplify document recovery ownership`) on accepted
`2c4e020`.

**Correction target:** retain the simplified backend journal, but make renderer
draft persistence genuinely coalesced with a bounded debounce and maximum delay.
Await its serialized flush at submission, reload and native-close boundaries, and
make the native atomic rename crash-durable. Save As must never delete a pending
destination journal and must establish one authoritative document identity across
the backend, server and native draft store, including when the destination was
previously opened. Add behavior checks for bounded writes during typing, close or
reload preserving the latest draft, and Save As to clean and pending recovered
destinations. Stop integration tests from silently selecting a stale ignored
`.application`; require an explicit current staged root or validate compatibility.

**Next action:** primary implementer corrects `9ab60b5` from the consolidated
fresh-context review, then returns one commit for focused re-review.

**Testing constraint:** do not take over Carl's visible desktop. Use background
or isolated Mac GUI checks where native interaction matters. The in-app browser
blocked Alder's localhost URL, so it did not establish native behavior.

**Blocker:** none.

## Work queue

Only the current assignment is active. Queued items are approved work in intended
order; their implementation details are settled when assigned.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac documents and runtime cleanup | Accepted | Primary implementer | `838e0ba`: native document workflows, shared backend, retired platform/tooling machinery removed |
| Commands and reconnect recovery | Accepted | Primary implementer | `c58f4a9`: simpler commands and snapshot reconnect; edits/Save remain usable during pending runs |
| Settings | Accepted | Primary implementer | `83fc0c7`: shared app preferences, notebook execution metadata, project cache path; native save/reopen and malformed-file behavior |
| Stock Ark and R adapter | Accepted | Primary implementer | `a6a784e`: stock Ark, right-sized R adapter, native Run/output/Stop/restart and responsive Save |
| Reactive dependencies and stale results | Accepted | Primary implementer | `cb78c73`: affected-cell execution, stale-result suppression, barrier restart and recovery |
| Widget interactions | Accepted | Primary implementer | `253eb67`: slider/form/button events reach R, rerun affected cells once and reject stale output events |
| Output and cache helpers | Accepted | Primary implementer | `67d92c9`: ordered output, lazy/progress lifecycle, memory/disk reuse and invalidation through helper and NULL dependencies |
| Ark language assistance | Accepted | Primary implementer | `d4217c8`: stock Ark LSP supplies live completion, hover, diagnostics and navigation across restart/failure; separate `languageserver` path removed |
| Optional services and R boundary | Accepted | Primary implementer | `2c4e020`: clean R roles, retained optional services, project/user package precedence, isolated service dependencies, cancellable inspection, packaged Air and race-safe child cleanup |
| Document truth and recovery | Implementing | Primary implementer | Correct renderer draft batching/flush durability and Save As recovery identity at `9ab60b5`; remove stale staged-root auto-detection, then re-review |
| Session and desktop boundary | Queued | Unassigned | Replace per-notebook registry/lock/PID choreography with the shared backend's session map and one socket owner; use one typed Electron/renderer command and dirty-state bridge; fix ownerless dialogs and startup errors |
| Ordinary R and reactive analysis | Queued | Unassigned | Build the graph from statically established definitions and references; require one defining cell per notebook global and an acyclic graph with clear, locally blocking diagnostics; execute other valid dynamic R normally and document that hidden dependencies require explicit reruns, without opaque barriers, runtime tracing or conservative replay |
| Publishing and optional-service simplification | Queued | Unassigned | Publish an immutable saved source/output snapshot without live R/analyzer/graph gates; remove bespoke shortcode/resource/marker machinery and global UI action locking |
| Mac runtime and settings cleanup | Queued | Unassigned | Fix installed-kernel ordinary project-profile/library activation, stage and exercise Air, unify R selection with app preferences, remove false Rmd ownership and unused permission declarations, and keep a compact packaged acceptance path |
| Residual architecture and test cleanup | Queued | Unassigned | Split oversized state owners where required by the preceding slices; remove remaining source-lineage/provenance gates and obsolete platform/build/CI/performance machinery; freely delete or replace whole implementation-pinning test files, leaving a small behavior-led suite, Mac build/check path and small OS adapters |
| Complete Mac app and final acceptance | Queued | Unassigned | Deliver a usable Mac app; exercise the packaged native app through launch/open/type/run/interrupt/save/Save As/reopen/recover/close, multiple notebooks, concurrent GUI/agent edits, client detach and backend failure/recovery; check optional-service failures and observable stalls |

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
  smoke set. Keep the ordinary fast unit command separate.
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

## Latest accepted checkpoint

`2c4e020` is the optional-services and R-boundary checkpoint. Lead accepted the
four-role R design after repeated fresh-context review: ordinary notebook startup
and project/user package precedence, a sealed stock-Ark adapter, profile-free
app-private services and project-only package installation. The public R package
is limited to notebook-facing UI, output and cache helpers. Selected formatting,
package installation, publishing and passive/explicit inspection journeys passed;
explicit inspection cancels cleanly and later execution remains usable. Fresh
staging includes Air and the private service dependencies. The signed Mac build,
focused R/host/engine checks and installed project/profile/package journeys passed.
Process cleanup review additionally closed macOS group-signal races: descendants
are terminated, denied group signals escalate the owned child directly, concurrent
close is idempotent and failed exit observation propagates instead of reporting
false success.

`d4217c8` is the Ark language-assistance checkpoint. Lead accepted the stock-Ark
Jupyter comm adapter and removal of the separate `languageserver` process after
source and fresh-context review. Live-object completion, hover, diagnostics,
definition/F12 navigation, close/reopen, kernel restart and forced-kernel-failure
behavior passed; editing and saving remained usable without assistance. The
focused client, Ark, installed-host and headless-browser checks passed, as did the
signed Mac build. Native foreground interaction remains for final acceptance in
an isolated GUI session.

It retains `67d92c9`, the output/cache checkpoint. Lead accepted ordered Markdown,
log, table, text and plot output; progress cleanup, lazy detail and rejection of
late streamed results; and memory/disk cache reuse, helper/dependency invalidation
and project cache directory behavior. Ordinary R examples, focused R and stock-Ark
tests, a headless browser notebook check and signed Mac build passed. Native
foreground interaction remains for final acceptance in an isolated GUI session.

It retains `253eb67`, the widget interaction checkpoint. Lead accepted scalar, composite
form and button behavior through stock Ark after source and fresh-context review.
Trusted headless browser interactions confirmed one affected rerun, draft form
submission and stale-event rejection; live Ark R values, focused checks and the
signed Mac app passed. Native foreground interaction remains for final acceptance
in an isolated GUI session.

It retains `cb78c73`, the reactive dependency checkpoint. Lead accepted affected-branch
automatic execution, lazy explicit execution, stale-result suppression, barrier
rebuilds and independent recovery Runs after source and fresh-context review.
Five ordinary-R examples have stated expected results; focused controller checks
passed 110/110, the staged CLI exercised live R, and the signed Mac build passed
strict signature verification. Native widget interaction remains in the queue.

It retains `a6a784e`, the stock-Ark execution checkpoint. Lead accepted
the corrected unmodified Ark integration after source and independent review.
The signed Mac app ran scalar dependencies, a table and plot, Stop/next Run and
kernel restart; editing and saving worked with a stalled R process. Targeted
live tests against the bundled runtime covered project library precedence,
malformed output and unavailable R. The native GUI check for R entirely absent
was covered by headless browser/controller tests rather than a foreground window.

It retains `83fc0c7`, the settings checkpoint. Lead accepted
the owned application/notebook/project settings after source and independent review.
Native checks confirmed shared preferences across two notebooks, isolated execution
and project settings, persistence over relaunch, and Save/Quit/reopen without a
false unsaved prompt. Malformed settings and failed writes leave document editing
and saving usable. Affected host checks passed 189 with two existing live-R skips;
Mac build, typechecks and strict signature verification passed.

It retains accepted `c58f4a9` command/recovery behavior: Save and edit controls
remain usable during pending runs, and uncertain retries do not silently rerun.

It retains the accepted `838e0ba` document foundation: save/reopen, confirmed
replacement, Cancel close/quit, crash/corrupt-snapshot recovery, an agent remaining
connected after GUI quit, and launch without a Keychain prompt.
Temporary window credentials stay in memory; recovery is independent of Keychain.
Old pre-reset recovery journals remain on disk but are not imported.

The staged app at `host/.application-desktop/Alder.app` follows the implementation
checkout and may contain newer, unaccepted changes. Acceptance is tied to the
commit above, not that mutable app path.
Build and launch commands: [implementation README](/Users/carlstone/.codex/worktrees/ebd6/alder/dev/README.md).

## Task locations

| Role | Location |
| --- | --- |
| Lead task | `01a0b55f-feaf-7c03-9964-b448891e33d5` |
| Primary implementation task | `01a0b5a6-22ac-7480-9394-5cc4c1ba807d` on `local` |
| Implementation worktree | `/Users/carlstone/.codex/worktrees/ebd6/alder` |
| Implementation branch | `codex/mac-document-foundation` |
| Lead documentation checkout | `/Users/carlstone/alder` |
