# Alder architectural reset

Status: approved direction, 2026-09-18; implementation is proceeding in slices.
This document supersedes the old architecture plan, migration freeze and review
matrix. Current assignments and acceptance live in
[WORKBOARD.md](WORKBOARD.md); commands live in [README.md](README.md).

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

Temporary desktop session credentials live in memory and are regenerated as
needed. Do not persist them through Keychain or an unencrypted cookie store.
Ordinary notebook launch, editing and draft recovery require no Keychain approval;
recovery persistence is independent of credential storage.

**User constraint: unmodified Ark.** Use upstream Ark without a fork, source or
binary patches, or runtime replacement of Ark internals. Ark is the R kernel
that evaluates code; Alder owns its notebook adapter
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
so recoverable document state must survive that failure. Verify that closing one
client preserves work for another attached client.
Use ordinary Node child processes and process groups for lifecycle management.
Notebook endpoints are routing boundaries; closing a frontend must not end work
owned by another attached client.

**Documents.** Maintain an in-memory working document, a saved baseline, an
external-file fingerprint and a recovery snapshot. Stage saves and atomically
replace the destination. Offer an understandable external-edit conflict choice.
Snapshot unsaved work periodically; recovery durability is not a prerequisite
for every edit or execution. Retain revision checks for concurrent edits and
stale execution results. Provide a bounded close path when the host is unhealthy.

**Commands and recovery.** Replace the general command admission/receipt,
per-client sequence and event-replay framework with simple request IDs, document
revision checks, an execution queue and current-state synchronization. Reconnect
from a current snapshot. Keep the narrow duplicate-request handling needed to
avoid executing an uncertain retry twice. Preserve local edits not yet accepted
by the backend and useful crash recovery through simple snapshots; replace the
renderer draft-branch/encryption-key machinery rather than recreating it.

**Parsing and validation.** Use standard JSON parsers and existing libraries.
Remove handwritten JSON parsers/scanners and serialize-parse-validation cycles
on trusted in-process values. Validate incoming data at the actual I/O boundary
with appropriate schema and size limits; internally use typed values. Existing
tests for stricter custom parser behavior do not define product requirements.

**Settings.** Remove the five-layer defaults/user/project/runtime/launch overlay
system, per-key provenance and shadowed-setting errors. Use application
preferences and notebook/project settings with one clear writable owner for
each setting. Defaults are ordinary fallbacks. Editing a setting must predictably
change the effective value; do not recreate arbitrary override stacks.

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

Right-size the R adapter around the notebook's actual needs and Ark's existing
execution/output facilities. Remove duplicated runtime policy, blanket helper
compilation and synthetic warm-up execution. Add performance optimizations only
when measurements of the redesigned app demonstrate a benefit. Preserve useful
widgets, rich outputs and scientific semantics through a small helper layer.

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

**Build and runtime policy.** Delete bespoke dependency certification and source
lineage/provenance gates. Keep ordinary lockfiles, standard package-manager
integrity checks and required license notices. Startup resolves necessary
resources and checks actual compatibility. Separate local development from public
distribution and signing. Existing script restrictions describe the current
implementation; they do not freeze the redesigned runtime contract.
Stage the Mac app with a compact Forge build and bundled Node/shared resources.

Prefer deleting obsolete build and verification machinery to preserving it in
disabled form. Keep a small local Mac build/check workflow with focused behavior
tests and native interaction checks. Retire cross-platform release matrices,
duplicate qualification layers and tests that only pin superseded designs. Do
not recreate their scope under new names. Use ordinary process cleanup through
platform facilities; retire the former custom supervisor and containment framework.

## Delivery and acceptance

These are capability areas, not an assignment sequence. The workboard determines
what is active, queued and accepted. A slice is one bounded implementation change
with observable completion criteria and a runnable Mac build.

| Capability area | Observable outcome |
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
