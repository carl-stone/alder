# Alder workboard

Updated: 2026-09-21. Goal: a dependable Mac notebook for scientific R work,
developed through a portable core with explicit platform boundaries.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Native Mac reliability — Implementing on Mac.**

The shared portable-core checkpoint is accepted on pushed main `42cfda8`. Current main
`e9293e5` also passed fresh full signed Mac acceptance and packaged native journeys.
The staged signed app is refreshed; the installed user copy was left untouched. Preserve
upstream unmodified Ark.

**Finish condition:** ordinary Mac launch, document/window use, recovery and owned-child cleanup
remain dependable through native failures. Exercise real user journeys through the packaged app
while keeping Carl's visible desktop free. Record scenarios that genuinely require foreground
interaction for a later supervised pass; do not infer them from headless checks.

**Accepted subcheckpoint:** `f086e40` packages the R helper from its actual source files rather
than copying the generated checkout, removing the disk-exhaustion path. Full signed-app acceptance,
strict signing and natural child cleanup passed. A packaged second client saw an executed unsaved
draft while disk still held the old source, then observed Save and detached without stopping the
primary app. This was two app processes, not two windows in one process.

**Accepted subcheckpoint:** `e9293e5` fixes transaction-event dirty state so Save and the native
unsaved indicator match edited source. A packaged second-instance launch forwarded notebook B
into the running app; two windows edited, ran and saved separate notebooks without cross-talk,
and window A remained usable after B closed. Focused checks and full signed-app acceptance
passed with natural cleanup. Native unsaved-close choices remain unqualified.

**Current bounded slice:** exercise an actual packaged backend process crash while a notebook
has an acknowledged unsaved edit, and preserve any still-local editor draft where feasible.
Verify recovery or actionable failure, explicit Save semantics, post-recovery execution and
child cleanup without taking over the visible desktop.

**Correction in progress:** clean `093e1cf` makes the native recovery dialog appear
after failed replacement and rollback, and its discarded-lease cleanup passed review.
One retry path remains: the native Restart action still waits for an IPC response
from a renderer that failed to load. The primary implementer owns this focused fix
and a regression without a fake renderer acknowledgement. Review the next clean
candidate before one full signed-app acceptance.

The release README and three feature GIFs remain on `main`. The separate Ark source repository
is untouched.

**Testing constraint:** do not take over Carl's visible desktop. Use background or
isolated Mac checks for native behavior.

## Work queue

One item is active. New approved work is added here before assignment.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac architecture reset and complete app | Accepted | Primary implementer | `8a1381ce`: accepted document, execution, reactivity, services, Mac delivery, tests and UI/UX foundation; detailed slice history lives in Git |
| Local diagnostics and observability | Accepted | Primary implementer | `ea21b96`: bounded private local diagnostics, safe export, durable fatal evidence, truthful timings and full signed-app acceptance |
| Dead code and dependency removal | Accepted | Primary implementer | `1080f153`: removed confirmed unreachable code, five obsolete files and eight unused dependencies; independent reachability and behavior reviews passed |
| Production-path simplification | Accepted | Primary implementer | `a334513` plus `21f678c`: clearer live ownership with launch-scoped no-run restored; architecture and focused behavior reviews passed |
| Simplification verification and acceptance | Accepted | Primary implementer and independent reviewers | `818a95d`: focused correction review and complete signed-app acceptance passed |
| Full-fidelity automatic diagnostics and agent inspection | Accepted | Primary implementer and independent reviewers | `b1887eb`: full raw automatic evidence, agent query boundary, focused reviews and complete signed-app acceptance passed |
| Differential R execution generator | Accepted | Primary implementer and independent reviewers | `597e6f9`: packaged Rscript differential generator, corrected failed-cell semantics, focused reviews and full signed-app acceptance passed |
| Automatic diagnostic triage | Accepted | Orchestration implementation task and independent reviewers | Corrected ten-file shadow controller: deterministic public-CLI triage, full evidence, bounded retention, silent idle ticks and no model/task delivery; 38 tests, real installed integration and combined demo passed |
| Mac UI/UX polish | Accepted | Primary implementer and independent reviewers | `1e5af1b`: daily-use correctness, content-first layout, stable virtualization, deterministic native cleanup and complete signed-app acceptance passed |
| Accepted Mac build local delivery | Accepted | Primary implementer | Exact accepted signed app installed at `/Users/carlstone/Applications/Alder.app`; background ready/quit smoke passed with natural cleanup |
| Release README and feature demo | Accepted | Primary implementer and independent reviewers | `b316bc3`: release-facing install/use guide and three compact real-app feature captures; media and factual reviews passed |
| Repository integration and cleanup | Accepted | Primary implementer and focused cleanup reviewers | `554da34`: canonical docs and accepted app fast-forwarded to remote `main`; obsolete worktrees, branches and safety stashes removed after review |
| Platform-boundary extraction | Accepted | Primary implementer and focused reviewers | `42cfda8`: shared Linux R 34/34, browser 12/12 and reviewed localized Mac/Linux seams; no duplicated product or Ark fork |
| Native Mac reliability qualification | Implementing | Primary implementer | Sleep/wake, real Finder/dialog/window flows, packaged crash recovery and supported-filesystem behavior work through visible installed-app paths without lost work or stranded processes |
| Scientific workflow qualification | Queued | Unassigned | A realistic scientific notebook, real CRAN/Bioconductor packages, representative R reactivity idioms, two live notebooks under load and rich publishing are independently qualified through packaged Alder |
| Product completion and public Mac delivery | Queued | Unassigned | Project/Git ownership, notebook-wide search, agent presence, accessibility, scale, upgrade state, release identity, architecture support and signed/notarized distribution have explicit accepted behavior |

## Queued real-use qualification

These checkpoints are recorded for later assignment. None is active.

1. **Native Mac reliability.** Exercise laptop sleep/wake with clean and unsaved notebooks,
   active execution and multiple windows. Use LaunchServices and Finder, File > Open, New,
   Save As and replacement sheets, dirty close choices, dock reactivation, second-instance
   forwarding and two distinct notebook windows. Kill the renderer, backend and entire app in
   turn with acknowledged and still-local edits. Qualify iCloud Drive and case-sensitive APFS;
   define clear behavior for network and removable volumes, external rename/move, Git checkout
   and disappearing or permission-changing paths. Include multi-monitor window restoration,
   recent documents, upgrade/reinstall state and cleanup of retained application data.
2. **Scientific workflow qualification.** Run the bulk differential-expression example as a
   real packaged-app workflow with independently checked scientific results, upstream edits,
   interruption, restart, retained outputs and diagnostics. Install an ordinary CRAN package and
   a mixed CRAN/Bioconductor stack through the product, including cancellation, compiler or
   network failure, partial library mutation and retry. Build a hand-authored reactivity corpus
   covering data.table, tidy evaluation, formulas, purrr lambdas, S4, R6, replacement functions,
   namespaced mask verbs and user wrappers; classify genuinely opaque code visibly rather than
   inferring expected dependencies from Alder's analyzer. Exercise two active R kernels under
   sustained CPU, memory, plot, table, log and widget load. Inspect rich Preview/published HTML
   offline and sustain Ark language assistance through realistic editing and R restarts.
3. **Product completion and public delivery.** Define project-root discovery instead of assuming
   the notebook directory, decide which `.alder` state is versioned, and ensure generated package
   libraries and caches do not pollute Git. Add notebook-wide search across virtualized cells.
   Show attached-agent presence and useful attribution for remote edits or runs. Qualify keyboard-
   only use, VoiceOver, focus retention, contrast and reduced motion, then explore research-scale
   notebooks, large data and output pressure. Finalize the app icon, bundle identity and update
   policy; choose Apple-silicon-only, separate Intel artifacts or a universal build; exercise the
   supported macOS floor; and produce a quarantined-download, Developer ID signed, notarized and
   stapled release artifact with an install, upgrade and reinstall journey.

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

`e9293e5` is the latest accepted Mac application source. Fresh full final acceptance passed:
signed build, R and host checks, installed services, twelve production browser journeys, packaged
recovery journeys, license notices and natural owned-child cleanup. The focused packaged
two-window journey separately qualified second-instance forwarding, isolated notebook drafts,
execution, dirty state and Save. Earlier UI/UX and diagnostics acceptance detail lives in Git
and the implementation task.

The staged app at `host/.application-desktop/Alder.app` follows the implementation
checkout and may contain newer, unaccepted changes. Acceptance is tied to the commit
above, not that mutable app path. Build and launch commands are in
[README.md](README.md). Older checkpoint detail lives in Git and the implementation
task rather than this board.

## Coordination tooling

The standing orchestration implementation task owns the ignored project-local
`.tmp-orchestrator` prototype. This work is separate from the
Alder application queue and cannot change product code, the application worktree or
this canonical board.

**Current state: GitHub issue triage accepted and scheduled on the Mac.** The reviewed
one-shot Sol Medium runner rewrote Carl's rough syntax-diagnostic
[issue #10](https://github.com/carl-stone/alder/issues/10) with the expected product behavior,
posted one interpretation comment and applied `triaged`. Unchanged replay made no changes;
clarification, retry and stale-claim cases passed focused review. The per-user launchd service
`dev.alder.issue-triage` runs every ten minutes from the ignored `.tmp-orchestrator` workspace.
It baselines old issues at #13, processes new Carl-authored reports and answers without a model
wake on idle ticks, and lets other work proceed while a failed issue backs off. Its first two
real runs exited successfully with empty logs and left #10 unchanged. The poller tests and
independent final review passed; no new live issue was created solely for testing.

The accepted ten-file stdlib Python and SQLite shadow controller retains the reviewed
task-lifecycle foundation and
consumes only Alder's installed read-only diagnostic commands. It creates bounded,
content-bound incident candidates from actionable evidence, rejects unhealthy sources and
inconsistent replay, retries atomically, and leaves empty or unchanged ticks silent and
mutation-free. Thirty-eight tests, a real installed-app read-only check and a fresh combined
demo passed independent review on Mac. The unchanged copy on Linux currently reproduces one
SQLite lock failure in its concurrent workflow test (37/38 pass); this remains a separate
orchestration concern and does not expand the active Alder assignment. No hooks, scheduler,
notification, delivery or model wake were installed at the prior accepted checkpoint. The
standing task remains owner of this separate prototype.

## Task locations

| Role | Location |
| --- | --- |
| Lead task | `01a0b55f-feaf-7c03-9964-b448891e33d5` on `local` |
| Primary implementation task | `01a0b5a6-22ac-7480-9394-5cc4c1ba807d` on `local` |
| Implementation worktree | `/Users/carlstone/.codex/worktrees/ebd6/alder` |
| Implementation branch | `codex/native-backend-crash`; current correction checkpoint |
| Linux inventory task | `01a0bf49-f444-7042-a6ee-8be9c7d2cd79` on `droplet`; interrupted without tracked changes |
| Orchestration implementation task | `01a0bbd7-8b7e-7712-9fb4-b1c0f3289e41` on `local` |
| Ignored orchestration workspace | `/Users/carlstone/alder/.tmp-orchestrator` |
| Prior droplet orchestration task | `01a0bf4a-93d6-7672-869a-85c8318cf5d0` archived after failed Mac handoff; no pilot edits |
| Lead documentation checkout | `/Users/carlstone/alder` |
