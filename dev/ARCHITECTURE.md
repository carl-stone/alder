# Alder architectural reset

Status: approved direction for implementation, 2026-09-18. The reset is not yet
implemented or accepted. This document supersedes the old architecture plan,
migration freeze and review matrix. Current assignments and acceptance live in
[LEAD.md](LEAD.md); commands live in [README.md](README.md).

## Product requirements

Alder should feel like a dependable notebook for scientific R work. Opening,
editing and saving must remain usable independently of R, dependency analysis,
inspection, language assistance or an agent connection.

- Keep ordinary `.R` notebooks with `# %%` cells and runnable R examples.
- Preserve useful editor, reactive execution, output, widget and `ui`/`out`/`cache`
  behavior. Changes to R semantics or user workflows are product decisions, not
  incidental consequences of an implementation.
- Execute dependencies correctly, reject stale results, and preserve edits when
  clients act concurrently. Stop should interrupt the work the user sees as busy,
  and the user should be able to continue or recover after failure.
- Respect the project's R environment. Application service dependencies must not
  silently override project package versions in the notebook kernel.
- Keep desktop and agent access to the same notebook. An agent disconnect must
  not terminate the user's desktop session.
- Save with conventional atomic replacement and external-change detection.
  Save As supports explicit confirmation before replacing an existing file.
- Recovery preserves unsaved work. Corrupt recovery material is retained, while
  a valid saved notebook remains openable with useful recovery choices.
- Show the Mac application promptly with actionable progress or errors.
  Users should not need a terminal to understand a failed launch.
- Keep ordinary editing, running, saving and closing responsive. Measure real
  interactions on identified hardware; choose performance acceptance against
  representative workflows rather than treating old universal timing gates as
  requirements.

The app runs trusted R code with the user's permissions. Keep renderer isolation,
authenticated local APIs and ordinary child-process cleanup. Deliberate escape
by hostile R code is outside this product's containment promise.

**User constraint: unmodified Ark.** Use upstream Ark without a fork, source or
binary patches, or runtime replacement of Ark internals. Alder owns its adapter
and ordinary R helpers outside that boundary. Do not replace the current patch
with reliance on private Ark hooks. This constraint is Carl's decision and is
not subject to the lead's discretion over the working design below.

**Platform scope.** Mac is the sole active delivery target. Delete Linux and
Windows implementations, installers, container tooling and platform-only checks
now; those platforms will be implemented and qualified separately later. Keep
the application core OS-independent wherever practical and put necessary Mac
differences behind small adapters. Do not build speculative adapters for future
platforms or turn the shared core into a separate Mac application.

**Rewrite authority.** This is pre-release software. Whole components may be
rewritten or deleted. Choose languages for their fit and measured performance
needs; no component must stay in Rust or any other language. Migration complexity,
estimated effort and sunk implementation cost are not reasons to retain a worse
design. Preserve useful notebook behavior and user work, not internal compatibility
with discarded implementations.

## Working design

These are engineering decisions to prove in working slices. The lead can revise
them when a simpler design meets the product requirements; workers bring shared
boundary changes to the lead.

**Session ownership.** Use one local backend service managing notebook sessions,
with one Ark kernel per notebook. Desktop, browser and agent clients use the same
document and execution owner. Concentrate connection and operation lifetime
decisions in the session manager. A backend crash can affect multiple notebooks,
so recoverable document state must survive that failure. The first slices must
demonstrate these boundaries before broad migration.

**Documents.** Maintain an in-memory working document, a saved baseline, an
external-file fingerprint and a recovery snapshot. Stage saves and atomically
replace the destination. Offer an understandable external-edit conflict choice.
Snapshot unsaved work periodically; recovery durability is not a prerequisite
for every edit or execution. Retain revision checks for concurrent edits and
stale execution results. Provide a bounded close path when the host is unhealthy.

**R execution.** Let Ark own execution, interruption and native output facilities.
Keep only the kernel adapter and R helpers required for observable notebook
behavior, including widgets and necessary cell bookkeeping. Dependency analysis
runs outside the evaluating kernel. Keep the kernel's dependency footprint small;
language assistance, formatting and package management use service processes.
Account for already-loaded namespaces when isolating project packages.

The execution slice replaces the current patched MIME publisher with an
integration that works with unmodified Ark, then removes the patch and its
exclusive build, readiness and test machinery. Verify output ordering, widgets
and interruption through the replacement. Keep the adapter small; the exact
transport is an implementation decision within the unmodified-Ark constraint.

**Optional services.** Automatic inspection must not invoke arbitrary user methods
or force promises. Rich inspection is explicit, cancellable work. Optional service
failure should have the following effects:

| Failure | Required remaining behavior |
| --- | --- |
| R missing or crashed | Open, edit, save, select or restart R |
| Dependency analysis unavailable | Edit and save; execution explains the blocker |
| Variable inspection fails | Notebook execution and editing remain usable |
| Language assistance fails | Editing and execution remain usable |
| Recovery snapshot corrupt | Open the saved notebook and offer recovery choices |
| Agent disconnects | Desktop work continues |
| Backend unresponsive | Preserve local unsaved work and provide an explicit close path |

**Build and runtime policy.** Keep package inventories, source hashes, compiler
metadata and release records in build tooling. Startup resolves necessary
resources and checks actual compatibility. Separate local development from public
distribution and signing. Existing script restrictions describe the current
implementation; they do not freeze the redesigned runtime contract.

Prefer deleting obsolete build and verification machinery to preserving it in
disabled form. Keep a small local Mac build/check workflow with focused behavior
tests and native interaction checks. Retire cross-platform release matrices,
duplicate qualification layers and tests that only pin superseded designs. Do
not recreate their scope under new names. Process cleanup remains necessary;
the current custom Rust supervisor and its containment policy are replaceable.

## Delivery and acceptance

| Slice | Observable outcome |
| --- | --- |
| Document foundation | Launch, open, edit, save, confirmed replacement, close and recovery with R unavailable |
| Execution foundation | Ark execution, outputs, interruption and recovery in the project environment |
| Reactive notebook | Correct dependencies, stale states, widgets and useful public R API behavior |
| Shared access | Desktop and agents coordinate correctly through the same owner |
| Optional services and distribution | Assistance, inspection, formatting, packages, publishing and Mac packaging work without compromising the core |

Each slice ends with a runnable native Mac build and checks of the affected user
journey and failure behavior. Preserve a recoverable checkpoint of existing
uncommitted work before implementation. Remove replaced production paths as their
replacements land. An intermediate slice does not complete the overhaul.

Build representative acceptance notebooks before the associated implementation.
Use ordinary R as an independent comparison for R semantics; specify expected
reactive results explicitly. Carl judges scientific behavior and usability; the
lead owns engineering decisions and acceptance. A worker may propose changed
criteria but cannot silently redefine success.

Keep tests for lost edits, incorrect dependency execution, stale output,
cancellation, conflicting clients, plots, widgets and project package behavior.
Replace implementation-specific tests when they prevent an accepted improvement.
A native interaction check should exercise typing, menus and dialogs where those
are the behavior under test. Private client calls alone do not verify them.

Review consequential integrated changes for both correctness and unnecessary
complexity. Require concrete failure examples for new protections, and reuse
valid checks for unchanged scope. Do not invent an extra review hierarchy or
treat historical benchmark reports as current qualification.
