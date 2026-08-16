# 0004 — Execution engine: one serial R worker per notebook

Status: Accepted  
Date: 2026-08-16

## Context

R is single-threaded within a process. The vision calls for dependency-ordered execution, interruption/cancellation, progress reporting, deterministic state, and a UI that stays responsive while a cell runs. The concurrency question — whether independent cells may run in parallel — interacts directly with R's mutable globals, random seeds, side effects, and shared state.

## Decision

Execute notebook cells serially inside a single dedicated R worker process per notebook.

- Cells run in dependency order.
- The editor/server UI never blocks: the R worker is a separate process, so the notebook stays interactive while a cell runs.
- A Stop control sends `SIGINT` to the worker process; R surfaces an interrupt condition.
- Async/parallel worker execution is deferred and, when added, is opt-in via an explicit per-cell flag.

Serial single-process execution is deterministic, matches R's own semantics (global state, seeds, side effects behave predictably), and keeps notebook state unambiguous. Mirai/future workers would speed independent subgraphs but make shared-mutable state, side effects, and caching ambiguous — a cost not justified for the primary model.

## Consequences

Easier: deterministic, understandable state; safe with R globals/seeds; UI responsiveness via process separation. Harder: serial throughput bound by slow cells; `SIGINT` may be ignored by long-running compiled code paths (data.table, BLAS) until they return — a limitation shared with other R kernels. Known item: an explicit background/async cell mechanism remains an open option.