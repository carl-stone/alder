# 0002 — Cell rerun model: manual run with stale marking

Status: Accepted  
Date: 2026-08-16

## Context

The vision requires "notebook state always corresponds to the source currently visible on screen" and "no hidden execution-order state." The core UX question is when edits trigger recomputation. Marimo marks affected downstream cells stale and waits for an explicit Run; a fully live model auto-reruns on edit but is expensive for heavy R cells and can recompute mid-edit.

## Decision

Adopt the marimo rerun model, not a live-editing model.

- Editing a cell marks that cell and every cell that depends on it as stale.
- No values are removed and nothing runs until the user explicitly runs a cell.
- Running a cell executes it and, by default, run only that cell's stale downstream cells in dependency order (or nothing below, per user preference on a per-run basis).
- Notebook state changes only on an explicit Run action.

This keeps state deterministic and cheap with expensive R computations, and satisfies both "state corresponds to source" and "no hidden execution state."

## Consequences

Easier: deterministic state, low recompute cost, predictable for expensive cells, agent-friendly (agents control exactly when execution happens). Harder: users must manage staleness explicitly rather than getting live feedback; stale badges must be accurate and clearly communicated.

Clarifications required by the implementation:

- **Widget changes mark stale but never run.** Setting a control's value
  invalidates every executed cell that reads it; recomputation happens only
  on an explicit Run.
- **Stale outputs persist.** Marking a cell stale never clears its previous
  output, log, or widget specs — the last computed result stays visible
  until the cell is rerun.
- **Cancellation is per explicit run.** Editing or deleting an upstream
  cell interrupts the running cell (if affected) and removes that run's
  queued dependent jobs; jobs belonging to another explicit run survive.