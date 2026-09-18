# Alder lead: mandate and current state

Lead task ID: `01a0b55f-feaf-7c03-9964-b448891e33d5`.

This is the persistent coordination record for Carl's ongoing conversation.
Read it at the start of lead work turns and after compaction or resumption.
Keep it short and update it in place; detailed behavior belongs in
[ARCHITECTURE.md](ARCHITECTURE.md), and implementation detail belongs in the code
and primary implementation task.

## Standing mandate

Carl delegates engineering leadership to this task. The lead translates his
wishes into observable product outcomes, makes routine engineering decisions,
delegates implementation, inspects results and decides acceptance. Bring Carl
questions that affect his notebook experience, scientific semantics or scope.
Handle routine technical choices without requiring him to supervise coding.

The lead can read files, inspect diffs and reports, and manage other tasks.
It may always edit documentation, including this record and agent guidance.
It may edit code, tests, configuration or other implementation files only when
Carl directly instructs it to do that work. Builds, tests, application runs and
implementation investigations requiring execution otherwise go to the primary
implementation task. A direct exception is scoped to that request.

One primary implementation task owns the integrated application. Separate tasks
may handle bounded work or independent review. Those tasks can implement; the
lead's restrictions are specific to the lead task. Only Carl may change this
mandate. These instructions are a working agreement, not a verified tool-level
write restriction.

Keep one bounded current assignment stable until its checkpoint. Record new
accepted work in the queued backlog here; a decision or documentation update is
not itself an instruction to expand the active slice. Batch the next assignment
after reviewing the current result. Interrupt work only for a correction that
materially changes the current slice, a blocker, or Carl's explicit reprioritization;
state what changes and what it replaces. Avoid overlapping follow-up briefs.

Keep exploratory ideas separate from accepted decisions. Worker reports are
reported results until the lead checks and accepts them. Reviewers can challenge
requirements and complexity; they cannot create new product obligations by
declaring them necessary. The lead owns updates to this record; workers report
changes to the lead.

## Resume procedure

1. Restore the role boundary above and read the current state below.
2. Read the current product requirements when relevant to the next decision.
3. Check the primary task's live status before relying on its progress or sending
   overlapping work. Use its recorded ID to resume coordination.
4. Reconcile Carl's latest instructions, update decisions or assignments, and
   continue. Do not turn a summary of a discussion into authorization.
5. Keep these checks internal unless they reveal something Carl needs to know.

## Current state

Updated: 2026-09-18.

- **Decided:** Controlled architectural reset, delivered as working Mac slices.
  Carl accepted the direction in [ARCHITECTURE.md](ARCHITECTURE.md). Preserve
  useful notebook features while simplifying document ownership, persistence,
  R integration, optional-service failures, runtime policy and tests.
- **Decided:** This conversation remains the lead; one primary implementation
  task owns execution, with separate review or bounded tasks when useful.
- **Decided:** The lead may always edit docs; other direct edits require Carl's
  explicit instruction. This supersedes the earlier blanket no-edit wording.
- **Decided by Carl:** Ark must remain unmodified upstream, without exceptions
  made by the lead or workers. No fork, source/binary patches or runtime
  replacement of its internals. Alder owns its adapter and R helpers outside
  that boundary. This supersedes the earlier conditional preference: replace
  and remove the existing MIME publisher patch in the execution slice.
- **Decided by Carl:** Mac is the only active platform. Delete Linux/Windows
  code, packaging and platform-only checks now; qualify other platforms later.
  Maximize the useful OS-independent core and keep OS adapters small.
- **Decided by Carl:** Languages are engineering choices based on fit and real
  performance, with no Rust mandate. Whole-component rewrites are authorized;
  migration difficulty, time estimates and sunk cost must not preserve a worse
  design. Prefer deletion of obsolete CI, checks and release machinery.
- **Decided by Carl:** Remove bespoke dependency certification, the oversized
  command/recovery framework, handwritten JSON parsing/repeated validation,
  five-layer settings and excess R-adapter machinery. The replacement direction
  is recorded in ARCHITECTURE.md. These are implementation targets, not optional
  cleanup; preserve notebook behavior rather than old internal protocols.
- **Primary implementation task:** `01a0b5a6-22ac-7480-9394-5cc4c1ba807d`, local
  host. Worktree: `/Users/carlstone/.codex/worktrees/ebd6/alder`;
  branch `codex/mac-document-foundation`. Accepted checkpoint: `838e0ba`.
- **Assigned now:** Replace the oversized command and reconnect/recovery protocol
  with request IDs, document revision checks, a simple execution queue, snapshot
  reconnect and straightforward recovery of unacknowledged edits. Replace custom
  JSON parsing/repeated validation on the boundaries changed by this slice. Own
  the integrated desktop/host/agent behavior and remove replaced paths and tests.
  Preserve the accepted Mac document behavior; settings and R integration stay
  queued. Report one complete runnable checkpoint or a material blocker.
  The original checkout remains the lead's documentation workspace.
- **Resolved in document slice:** The `@alder/Safe Storage` prompt was addressed
  with ephemeral window partitions and no encrypted cookie persistence. Native
  launches and recovery showed no prompt; existing recovery and browser databases
  were retained. Local API authentication remains enabled.
- **Decided by Carl:** Remove persistence of temporary desktop session credentials;
  keep them in memory and regenerate as needed. Notebook recovery stays independent
  of Keychain. Merely saving the same credentials unencrypted is not the solution.
- **Queued, approved but not assigned now:** Collapse settings ownership;
  right-size the R adapter and replace patched Ark in the execution slice. Remove
  custom parsing/validation and dependency certification remaining outside the
  active slice as their owning components are replaced. The lead assigns the next
  slice after review; this backlog does not expand the active assignment.
- **Completed now:** Lead routing and resumption record; replacement product and
  development guidance; retirement of obsolete architectural mandates; current
  checkout imported and checkpointed in the primary worktree.
- **Engineering direction accepted:** Ordinary Node process/process-group
  lifecycle and compact Forge Mac staging; one shared Node backend owns notebook
  sessions. R/kernel readiness stays optional for document use. Existing notebook
  endpoints may remain simple routing surfaces; frontend lifetime must not
  become ownership of another attached client's work.
- **Implementation accepted:** Mac document slice at `838e0ba`, after lead source
  and native-result review plus a focused independent persistence/recovery review
  with no blockers. Native typing/save/reopen, confirmed Save As replacement,
  Cancel close/quit, recovery across backend restart/corrupt snapshots, no Keychain
  prompt, and an agent connection surviving GUI quit were demonstrated. Shared
  backend ownership and ordinary child cleanup replace the Rust supervisor;
  retired platform and verification machinery was removed. Focused tests passed.
  App: `host/.application-desktop/Alder.app` in the implementation worktree.
  This is a document checkpoint, without an R execution runtime. Old pre-reset
  recovery journals remain on disk but are not imported by the new snapshots.
- **Next checkpoint:** Review the simplified command/recovery slice for ordinary
  editing/save, concurrent GUI/agent changes, reconnect with unsent edits, and
  uncertain execution retries without duplicate runs. Recheck relevant native
  behavior; do not rebuild an exhaustive gate suite.
- **Unresolved engineering work:** Separate kernel dependencies from service dependencies.
  Choose and implement an unpatched Ark integration in the execution slice,
  preserving output ordering, widgets and interruption. The transport remains
  open; whether to retain the patch does not. Detailed protocols and
  compatibility policy are not frozen.
- **Current user decision needed:** None. Public signing/notarization is deferred
  from local development; revisit distribution with Carl when it becomes relevant.
