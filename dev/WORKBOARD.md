# Alder workboard

Updated: 2026-09-18. Goal: a dependable Mac notebook for scientific R work.
Current work only. [Lead instructions](LEAD.md) define coordination and state
transitions; [architecture](ARCHITECTURE.md) holds product and design decisions.
Carl and the lead own this board; implementation and review tasks have read access.
Use the [canonical board](/Users/carlstone/alder/dev/WORKBOARD.md) for live coordination;
copies in other worktrees are snapshots.

## Current assignment

**Commands and reconnect recovery — Implementing.**

**Owner:** primary implementer, correcting checkpoint `c2c646b` after lead review.

Replace command receipts, sequence tracking and event replay with request IDs,
revision checks, a simple execution queue, snapshot reconnect and recovery of
unacknowledged edits.
Replace custom JSON parsing on the boundaries changed by this slice and delete
superseded paths. Settings and R integration are outside this assignment.

**Accept when:** ordinary edit/save/reopen still works; concurrent GUI/agent edits
apply at the expected revision or report a conflict; reconnect/restart preserves
unsent edits without applying them twice; an uncertain execution response never
silently causes a duplicate run. Preserve the accepted native document behavior.

**Next action:** separate Run's short interaction lock from execution completion.
The current view keeps Save and add/move/delete controls disabled for the entire
run. Verify those controls remain usable during a long run, then return the fixed
checkpoint for review. Other command/recovery checks found no concrete blockers.

**Blockers / decisions needed from Carl:** none reported.

## Work queue

Only the current assignment is active. Queued items are approved work in intended
order; their implementation details are settled when assigned.

| Work | State | Owner | Finish condition |
| --- | --- | --- | --- |
| Mac documents and runtime cleanup | Accepted | Primary implementer | `838e0ba`: native document workflows, shared backend, retired platform/tooling machinery removed |
| Commands and reconnect recovery | Implementing | Primary implementer | Current acceptance criteria above |
| Settings | Queued | Unassigned | Clear owners for app and project/notebook settings; remove the five-layer precedence system |
| Stock Ark and R adapter | Queued | Unassigned | Unmodified Ark; smaller adapter; project packages respected; outputs and interruption work |
| Reactive notebook behavior | Queued | Unassigned | Correct dependencies, stale results, widgets and useful R API behavior in real notebooks |
| Optional services and complete Mac experience | Queued | Unassigned | Assistance, inspection, formatting, packages and publishing work without blocking core use; responsive native workflows |

Remaining custom parsing and dependency-certification cleanup belongs with the
component being replaced. Outside the queue: other platforms are deferred;
public distribution/signing awaits a later discussion with Carl.

## Latest accepted checkpoint

`838e0ba` is the document checkpoint, **without R execution yet**. Lead and focused
independent review accepted the source changes and native results: save/reopen,
confirmed replacement, Cancel close/quit, crash/corrupt-snapshot recovery, an agent
remaining connected after GUI quit, and launch without a Keychain prompt.
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
