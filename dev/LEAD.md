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
- **Primary implementation task:** Creation dispatched on the local Alder
  project in an isolated worktree; setup pending. Creation ID:
  `client-new-thread:4d82f069-41eb-49d6-9b37-c87b19f3398e`.
- **Assigned now:** Import and checkpoint the current dirty checkout in the
  implementation worktree; delete retired platform/verification machinery;
  simplify lifecycle/build infrastructure and deliver the Mac document slice.
  The original checkout remains the lead's documentation workspace.
- **Completed now:** Lead routing and resumption record; replacement product and
  development guidance; retirement of obsolete architectural mandates.
- **Implementation acceptance:** No reset implementation slice has been accepted.
- **Next checkpoint:** Confirm the imported baseline and lifecycle/build
  direction, then review the runnable first slice. Continue with unmodified
  Ark execution after accepting that slice. Keep focused checks for behavior.
- **First slice acceptance:** A real Mac window can open and edit a plain `.R`
  notebook, save atomically, confirm replacement on Save As, reopen exact contents,
  close, and offer useful recovery after a crash or corrupt recovery snapshot.
- **Unresolved engineering work:** Prove the shared backend ownership design in
  the first slices; separate kernel dependencies from service dependencies.
  Choose and implement an unpatched Ark integration in the execution slice,
  preserving output ordering, widgets and interruption. The transport remains
  open; whether to retain the patch does not. Detailed protocols and
  compatibility policy are not frozen.
- **Current user decision needed:** None. Public signing/notarization is deferred
  from local development; revisit distribution with Carl when it becomes relevant.
