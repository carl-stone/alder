# Alder workboard

Updated: 2026-09-20. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Repository integration and cleanup — Accepted.**

Integrated commit `554da34d0d3faf9bb0822100ff50cc9703a2745f` was pushed to `main` by
strict fast-forward and independently verified on the remote. Local `main` and the standing
implementation worktree are clean at that checkpoint. Twelve obsolete temporary Alder worktrees
and their merged branches were removed after exact comparison and focused review; no unique useful
work was discarded. The separate Ark source repository was untouched.

The accepted app, release README and three feature GIFs are now on `main`. Only `main` and the clean
standing implementation branch remain locally, with no unmerged branches or safety stashes.

**Testing constraint:** do not take over Carl's visible desktop. Use background or
isolated Mac checks for native behavior.

## Work queue

No item is active. New approved work is added here before assignment.

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

`1e5af1b` is the accepted Mac application after the UI/UX polish and deterministic native
cleanup campaign. One uninterrupted final acceptance passed in 373.78 seconds with no skipped
phase: R helpers 164; host/generative 477 with 49 classified skips; installed Engine 21,
Jupyter 5, Host 12, MCP 1 and differential generator 12; browser journeys 12; packaged app
journeys 12 with 20 immediate saves; strict signing, staged notices and zero owned children.
The native cleanup probe observed natural Electron/backend/R/Ark exit with no fallback. The
app now has truthful recovery, composed plots, stopped/warning/error states, actionable service
failures, quieter notebook chrome, stable long-notebook geometry, responsive inspector and
viewport-bounded Settings. The bounded R differential generator, full-fidelity local
diagnostics and installed read-only agent queries remain included.

The staged app at `host/.application-desktop/Alder.app` follows the implementation
checkout and may contain newer, unaccepted changes. Acceptance is tied to the commit
above, not that mutable app path. Build and launch commands are in
[README.md](README.md). Older checkpoint detail lives in Git and the implementation
task rather than this board.

## Coordination tooling

The standing orchestration implementation task owns the ignored
`/Users/carlstone/alder/.tmp-orchestrator` prototype. This work is separate from the
Alder application queue and cannot change product code, the application worktree or
this canonical board.

**Current state: Accepted shadow controller with automatic diagnostic triage.** The ignored
ten-file stdlib Python and SQLite prototype retains the reviewed task-lifecycle foundation and
consumes only Alder's installed read-only diagnostic commands. It creates bounded,
content-bound incident candidates from actionable evidence, rejects unhealthy sources and
inconsistent replay, retries atomically, and leaves empty or unchanged ticks silent and
mutation-free. Thirty-eight tests, a real installed-app read-only check and a fresh combined
demo passed independent review. No hooks, scheduler, notification, delivery or model wake are
installed. The standing task remains owner of this separate prototype.

## Task locations

| Role | Location |
| --- | --- |
| Lead task | `01a0b55f-feaf-7c03-9964-b448891e33d5` |
| Primary implementation task | `01a0b5a6-22ac-7480-9394-5cc4c1ba807d` on `local` |
| Implementation worktree | `/Users/carlstone/.codex/worktrees/ebd6/alder` |
| Implementation branch | `codex/mac-document-foundation` |
| Orchestration implementation task | `01a0bbd7-8b7e-7712-9fb4-b1c0f3289e41` on `local` |
| Ignored orchestration workspace | `/Users/carlstone/alder/.tmp-orchestrator` |
| Lead documentation checkout | `/Users/carlstone/alder` |
