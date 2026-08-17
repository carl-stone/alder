# 0002 — Reactive execution: automatic by default, optional lazy mode

Status: Accepted  
Date: 2026-08-16

## Context

The vision requires "notebook state always corresponds to the source
currently visible on screen" and "no hidden execution-order state." The core
UX question is when edits trigger recomputation. Marimo runs downstream
cells automatically after a Run by default, offers an optional lazy mode,
runs stale ancestors before a requested cell, and exposes widget values
explicitly. The first implementation used a purely manual run model (run
target plus only the stale descendant subgraph); the product reference
executes the full affected region by default and leaves descendants stale
only in lazy mode.

## Decision

Adopt marimo-style reactive execution: **automatic by default, with an
optional lazy mode**.

- Editing source marks the edited cell and its descendants stale. Source
  edits alone never execute code; **Run is the semantic change boundary**,
  as in marimo.
- In `automatic` mode, running a cell first runs every idle/stale/error
  ancestor in topological order, then the target, then **all** descendants
  (not only stale descendants).
- In `lazy` mode, running a cell first runs every idle/stale/error ancestor
  and the target, then leaves its descendants stale; the global Run action
  executes all stale cells.
- A widget interaction automatically executes referencing cells and their
  descendants in `automatic` mode and in every app view; in lazy editor mode
  it only marks them stale.
- Server startup runs all cells once by default in either mode;
  `run_on_startup = FALSE` suppresses startup execution in both editor and
  app views, and opening an app URL never triggers code.
- Stale outputs remain visible. Stop cancels queued descendants of that
  explicit run.
- Edits retain stale outputs but enqueue removal of the edited code cell's
  old worker bindings before any later evaluation. A successful rerun
  recreates only the new declared definitions; unresolved old names cannot
  leak into a cell after their defining source was removed.
- Editing/deleting a package-attach barrier, or failing/interruption after
  one begins evaluation, invalidates the full worker state and requires a
  clean worker restart before later execution; other reference-object and
  external side effects remain R-specific non-transactional limitations.

## Consequences

Easier: matches the marimo reference — a Run refreshes the whole affected
region, lazy mode keeps expensive recomputation opt-in, and R-specific
limitations (reference objects, superassignment, search-path mutation) are
documented rather than hidden. Harder: automatic mode must retain a
correct topological plan across mixed stale/error/idle states, and the
worker must enforce strict binding ownership so removed definitions cannot
leak and package-attach barriers force a clean restart.

Clarifications required by the implementation:

- **Widget changes run in automatic/app, stale only in lazy.** Setting a
  control's value invalidates every executed cell that references it plus
  its descendants; recomputation follows the active mode. The defining cell
  never reruns on its own widget change.
- **Stale outputs persist.** Marking a cell stale never clears its previous
  output, log, or widget specs — the last computed result stays visible
  until the cell is rerun.
- **Cancellation is per explicit run.** Editing or deleting an upstream
  cell interrupts the running cell (if affected) and removes that run's
  queued dependent jobs; jobs belonging to another explicit run survive.
