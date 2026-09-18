# Alder workboard

Updated: 2026-09-18. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Stock Ark and R adapter — Implementing.**

**Owner:** primary implementer, correcting checkpoint `fdfa3d0` after lead review.

Restore R execution in the Mac app using unmodified upstream Ark. Replace the
patched MIME publisher and its build/staging machinery. Right-size the adapter
around Ark's public execution, output and interruption facilities, plus the
small R helpers the notebook actually needs. Keep project packages in control of
the kernel environment; isolate optional service dependencies.

**Accept when:** a native Mac notebook can select R, run ordinary cells through
stock Ark, show correctly ordered text/errors/plots and representative rich output,
interrupt a long run, restart after kernel failure and run against its project R
packages. Preserve responsive edit/save/recovery while R is absent or unhealthy.
Output/widget transport needs no Ark patch or private hook. The replaced runtime
policy/warm-up/validation paths and patched-Ark tooling are removed.

**Next action:** remove the remaining `ark.protected_options` integration; make
automatic variable refresh inspect names without forcing promises or calling user
methods, and keep an inspection failure from failing a healthy kernel. Collapse
the redundant recursive validation in the output adapter into one boundary pass.
Run affected checks and native execution, then return a corrected checkpoint.

**Lead documentation sync:** wording updates to the architecture and output
example are copied into the implementation checkout at this checkpoint. The
development README will be reconciled when execution is accepted.

**Blockers / decisions needed from Carl:** none reported.

## Work queue

Only the current assignment is active. Queued items are approved work in intended
order; their implementation details are settled when assigned.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac documents and runtime cleanup | Accepted | Primary implementer | `838e0ba`: native document workflows, shared backend, retired platform/tooling machinery removed |
| Commands and reconnect recovery | Accepted | Primary implementer | `c58f4a9`: simpler commands and snapshot reconnect; edits/Save remain usable during pending runs |
| Settings | Accepted | Primary implementer | `83fc0c7`: shared app preferences, notebook execution metadata, project cache path; native save/reopen and malformed-file behavior |
| Stock Ark and R adapter | Implementing | Primary implementer | Current acceptance criteria above |
| Reactive notebook behavior | Queued | Unassigned | Separate dependency analysis; correct execution, stale results, widgets and `ui`/`out`/`cache` behavior against ordinary R and representative notebooks |
| Optional services | Queued | Unassigned | Assistance, formatting, packages and publishing work; automatic inspection avoids forcing promises or user methods, and rich inspection is explicit/cancellable; service failures leave core use available |
| Complete Mac app and final acceptance | Queued | Unassigned | Deliver a usable Mac app; exercise launch/open/type/run/interrupt/save/reopen/recover/close, multiple notebooks and GUI/agent access; check service failures and real interaction performance; resolve remaining defects and obsolete machinery |

The following requirements apply to the relevant slices and are checked again
when accepting the complete app:

- Delete replaced production paths, handwritten parsing, redundant validation,
  bespoke dependency certification and the Ark patch/build/readiness machinery.
  Retain ordinary locks, package integrity and license notices.
- Replace tests that pin discarded implementations with focused behavior checks.
  Keep CI/build/check tooling small; remove obsolete platform and release gates.
- Keep the shared core OS-independent with small Mac adapters. No Rust mandate,
  speculative portability framework or retained Linux/Windows implementation.
- Preserve document/recovery behavior, shared GUI/agent ownership, renderer
  isolation, authenticated local APIs and child cleanup. Core editing and saving
  must remain usable through R, analysis and optional-service failures, with no
  Keychain prompt for ordinary use.

Representative R notebooks and expected results belong to their implementation
slices; final Mac acceptance exercises the integrated app. Other platforms and
public distribution/notarization remain deferred. Local runnable Mac delivery is
part of this queue.

## Latest accepted checkpoint

`83fc0c7` is the settings checkpoint, **without R execution yet**. Lead accepted
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
