# Alder workboard

Updated: 2026-09-18. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Complete Mac app and final acceptance — Implementing.**

**Owner:** primary implementer in the listed implementation worktree.

Qualify the signed Mac application as one integrated scientific notebook and fix
any remaining user-visible failure before release readiness.

**Accept when:** a clean signed app launches, creates and opens notebooks, edits by
mouse and keyboard, runs ordinary/reactive R, interrupts and recovers, renders all
supported outputs/widgets, supplies language help, saves atomically, Save As keeps
project ownership correct, closes/reopens without false dirty state, and restores
accepted work after renderer/backend/process failure. Two notebooks remain isolated;
two clients on one notebook share revisions without lost work and either can detach.
External edits and source/recovery conflicts preserve inspectable copies. Missing/
invalid R and failed Ark/Air/Quarto/package/publish/inspection operations leave core
editing and saving usable. Settings, menus, shortcuts, Preview, narrow/dark UI and
native document state behave as accepted. The fast suite, generative checks and one
documented final installed-app command all exit within bounds, clean every owned
child and verify the current signed package. No known P1 product defect, hanging
process, false passing test or unclassified failure remains.

**Final candidate:** `5e9b5ff` (`Complete Mac app acceptance`) on accepted UI/UX
checkpoint `dd9d60f`.

**Correction target:** restore ordinary project/user/bundled package precedence and
remove all notebook AST rewriting for `library/require/loadNamespace`; isolate the
app-private Ark adapter without occupying or forcing the public `alder` namespace.
Make native Save first submit and acknowledge the latest CodeMirror draft, then
await authoritative disk save; repeated immediate edit/run/Save must never observe
stale clean state. Eliminate the flaky browser widget input race. Remove the
acceptance-only driver/private-global/DOM automation from production Electron and
drive the packaged app externally through normal CDP/user/native seams. Expand the
installed journey honestly across reopen, interruption/recovery, multiple windows/
clients, conflicts and optional-service failures where Electron integration adds
risk; retain layered lower-seam coverage without claiming it is native. Add an
installed empty-cell regression. Every failure path must clean backend/analyzer/
Ark/Electron children within bounds. Pass repeated stress cases and one clean
uninterrupted final command.

**Next action:** primary implementer corrects `5e9b5ff`, returns a clean candidate
with stress and end-to-end evidence, then both independent release reviewers rerun
the final acceptance.

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
| Document truth and recovery | Accepted | Primary implementer | `09cfaa5`: one durable backend journal, bounded renderer draft persistence, safe Save As recovery identity and explicit staged-root integration checks |
| Session and desktop boundary | Accepted | Primary implementer | `e0b42f1`: one shared backend session map, independent client leases, typed native bridge and ownerless lifecycle behavior |
| Ordinary R and reactive analysis | Accepted | Primary implementer | `c7763ff`: rebuilt static graph, ordinary dynamic R, global/cycle restrictions, correct dot globals and invalid-descendant blocking |
| Publishing and optional-service simplification | Accepted | Primary implementer | `3680fbf`: immutable saved-snapshot publishing, independent cancellable optional services, safe package restart admission and bounded process cleanup |
| Mac runtime and settings cleanup | Accepted | Primary implementer | `cc80261`: one R preference path, canonical project recovery, verified/staged Ark/Air/Quarto, accurate Mac claims and real packaged acceptance |
| Residual architecture and test cleanup | Accepted | Primary implementer | `8990292`: removed trace/strict-JSON/platform/state debris, retained cohesive owners and rebuilt a five-second behavior-led host suite |
| Targeted generative verification | Accepted | Primary implementer | `d88ca7d`: bounded independent graph/document/recovery/state/R verification with real crash durability and replayable failures |
| UI/UX review and polish | Accepted | Primary implementer | `dd9d60f`: coherent Mac interaction and visual system, real responsive/accessibility behavior, truthful production evidence and safe native harness |
| Complete Mac app and final acceptance | Implementing | Primary implementer | Restore R precedence, fix immediate native Save and widget races, externalize/broaden packaged-app acceptance and guarantee failure cleanup at `5e9b5ff` |

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

## Latest accepted checkpoint

`dd9d60f` is the complete UI/UX checkpoint. Lead accepted the interaction structure
from `dbfa1df` plus a cohesive light/dark Mac workspace, real CodeMirror theme,
code-first cells and outputs, truthful production-renderer state matrix, fixed
responsive inspector with correct focus/inert/scroll behavior, accessible dialogs/
controls/live regions, actual 200% reflow and reduced-motion behavior. Production
Electron state/menu evidence shares the real shell and uses a safe unique temporary
directory with bounded teardown; no sample/fake native menu remains. The full host
suite passes 414 tests, the signed package contains current assets, strict signing
passes and no children leak.

It retains `dbfa1df`, the UI/UX interaction-structure checkpoint. Lead accepted typed native
document/save state, conventional production Mac menus and accelerators, same-file
focus with explicit shared-session windows, a compact document/cell command
hierarchy, Shift-Enter creation, exact positional Undo, separated document/R/
connection/recovery/service state, product-language R and reconnect actions,
non-destructive conflict/recovery choices, dirty-publish decisions, Notebook/
Outline and Preview semantics, and visible independently cancellable service
dialogs. The full host suite passes 407 tests in under five seconds, the signed Mac
package verifies and no children leak.

It retains `d88ca7d`, the targeted generative-verification checkpoint. Lead accepted a
seeded independent graph oracle, bounded notebook/recovery mutation, varied
state-machine recovery sequences and packaged Alder-versus-`Rscript` differential
checks. Recovery durability is inspected on disk after acknowledgement and before
SIGKILL; replacement restores source without implicit disk writes. Valid journals
compare full normalized baselines, corrupt cases have compact reproducers and
generated sequences cover required actions with bounded reduction. The host suite
passes 397 tests in under five seconds, packaged differential acceptance and strict
signing pass, and no children leak.

It retains `8990292`, the residual architecture and test-cleanup checkpoint. Lead accepted
removal of the performance trace subsystem, handwritten strict JSON parser,
non-Mac desktop branch, duplicate dirty snapshot state and their mechanism-pinning
tests. Native JSON remains behind fatal UTF-8, byte and schema boundaries. The
renderer has one local pending-source overlay over authoritative server dirty state.
The remaining Controller is a cohesive notebook execution orchestrator; durable
document, session, output, package, publishing, formatting, recovery and desktop
owners are separate. The behavior-led host suite passes 393 tests in under five
seconds, R helpers pass 164, packaged Engine passes 19/19, Mac acceptance and strict
signing pass, and no children leak.

It retains `cc80261`, the Mac runtime and settings checkpoint. Lead accepted one persisted
R selection path, canonical clean and recovery project startup, verified native
Ark/Air/Quarto staging and accurate format/permission/package claims. Untitled
recovery through symlinked projects preserves identity and physical project
profiles/libraries. Air archives for both Mac architectures are hash-verified.
The compact signed-app acceptance performs real packaged Ark evaluation, Air
formatting and self-contained Quarto rendering with typed shutdown and no leaked
children. The broad suite passed 398 with 39 explicit prerequisite skips in 24
seconds and strict signing passed.

It retains `3680fbf`, the publishing and optional-service checkpoint. Lead accepted one
immutable last-saved source/output snapshot rendered through static self-contained
Quarto without live R, analyzer or graph gates. Dirty edits are authoritatively
excluded and reported; old shortcode/resource/marker certification is gone.
Formatting, publishing and package work have scoped duplicate prevention and
cancellation while editing, Save and unrelated execution remain usable. Package
restart admission closes atomically after installation mutation. Broad checks
passed 396 with 38 prerequisite skips in under 25 seconds, focused checks passed
175/175, packaged journeys passed and no owned child leaked. Independent clean-path
comparison also proved the earlier project-profile/jsonlite failure was recovery
fixture contamination, so no runtime defect remains there.

It retains `c7763ff`, the ordinary-R and reactive-analysis checkpoint. Lead accepted a
fully rebuilt static graph with one defining cell per known notebook global and
an acyclic known dependency graph. Duplicate/cycle roots and their known
descendants block while independent branches remain usable; repairs unblock the
chain. Top-level dot-prefixed names are ordinary globals, function locals remain
local, and the old name-mangling protocol is gone. Valid dynamic R executes
normally without barriers, tracing or invented edges; hidden dependencies may
require explicit reruns. Focused checks passed 167/167, the broad host suite passed
398 with 38 explicit integration skips, installed Engine behavior and ordinary-R
examples passed, and the signed app passed strict verification.

It retains `e0b42f1`, the shared session and desktop-boundary checkpoint. Lead accepted one
desktop-owned control socket and in-memory canonical-path session map with
independent client leases, notebook isolation and journal recovery after backend
replacement. Electron uses one typed command/result and renderer-pushed window
state bridge; the per-notebook registry/lock/PID/nonce discovery system, DOM and
private-global control, and duplicate lifecycle IPC are gone. Focused lifecycle
and recovery checks passed 31/31, host typecheck passed and the signed Mac build
passed strict deep verification. Ownerless Open/startup dialogs and bounded
unhealthy close are covered. The project-profile/jsonlite regression remains
visible.

It retains `09cfaa5`, the document-truth and recovery checkpoint. Lead accepted one
fsynced backend journal for accepted source and one bounded, coalesced renderer
draft for unsubmitted typing. Submission, reload, native close and host restart
await the latest draft through a typed handshake. Save As preserves pending or
corrupt destination recovery and establishes one recovery identity for clean
destinations. The focused suite passed 99/99, the ordinary host suite passed 414
with 38 explicit integration skips, current staged Engine startup passed, and the
signed Mac build passed strict deep verification. Installed integration tests now
require an explicit current staged root. The separate installed-kernel project
profile/jsonlite regression remains queued and its expectation remains intact.

It retains `2c4e020`, the optional-services and R-boundary checkpoint. Lead accepted the
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
