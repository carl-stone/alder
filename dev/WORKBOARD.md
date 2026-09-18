# Alder workboard

Updated: 2026-09-18. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Settings — Implementing.**

**Owner:** primary implementer, starting from accepted checkpoint `c58f4a9`.

Replace the five-layer settings system with the owners defined in the architecture:
application preferences, notebook metadata and project-specific settings. Remove
override stacks, per-key provenance, shadowed-setting errors, redundant parsing
and tests that pin those mechanisms. Wire the actual Settings dialog and existing
execution controls through the new owners. R integration remains outside this slice.

**Accept when:** an application preference changes all open notebooks and survives
relaunch; notebook execution settings persist with that notebook without changing
another notebook; project paths stay project-specific. Each edit changes the
effective value without a hidden override. Invalid or unwritable settings preserve
authored files and leave ordinary notebook editing/saving usable with a clear
error. Preserve existing conflict handling and accepted document/command behavior.

**Next action:** implement one complete settings slice, delete the replaced paths,
exercise the native settings/reopen workflow with two notebooks, and return a
reviewable checkpoint with focused checks and a runnable Mac build.

**Blockers / decisions needed from Carl:** none reported.

## Work queue

Only the current assignment is active. Queued items are approved work in intended
order; their implementation details are settled when assigned.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac documents and runtime cleanup | Accepted | Primary implementer | `838e0ba`: native document workflows, shared backend, retired platform/tooling machinery removed |
| Commands and reconnect recovery | Accepted | Primary implementer | `c58f4a9`: simpler commands and snapshot reconnect; edits/Save remain usable during pending runs |
| Settings | Implementing | Primary implementer | Current acceptance criteria above |
| Stock Ark and R adapter | Queued | Unassigned | Unmodified Ark; smaller adapter; project packages respected; outputs and interruption work |
| Reactive notebook behavior | Queued | Unassigned | Correct dependencies, stale results, widgets and useful R API behavior in real notebooks |
| Optional services and complete Mac experience | Queued | Unassigned | Assistance, inspection, formatting, packages and publishing work without blocking core use; responsive native workflows |

Remaining custom parsing and dependency-certification cleanup belongs with the
component being replaced. Outside the queue: other platforms are deferred;
public distribution/signing awaits a later discussion with Carl.

## Latest accepted checkpoint

`c58f4a9` is the command/recovery checkpoint, **without R execution yet**. Lead
accepted the simplified protocol and recovery after fresh review and a correction
to the view's Run lock. A controlled executor with the actual view/client/controller
verified editing, Save, Add and Stop while execution was pending; preparation and
execution errors release controls. The correction passed 52 focused checks, host
typecheck, native build/signature verification and native editing/save/reopen checks.

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
