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

Clarifications required by the implementation:

- **Request-scoped interrupt identity.** Instead of a global
  acknowledgement Boolean, the worker tracks the active eval request in a
  request-scoped `executing_req`. An eval emits exactly one start
  acknowledgement, after which the host may send one SIGINT gated on that
  same request's ack; the host never retries a SIGINT against an idle read
  or another request. A SIGINT received while the worker is blocked on the
  (next) stdin read is caught and ignored by the outer loop.
- **Late Stop commits.** A Stop arriving after a successful response is too
  late: the already-completed successful result commits as `done` rather
  than becoming a false `Error: Interrupted`. Only a matching response with
  `error$interrupted = TRUE` becomes `Error: Interrupted`.
- **Worker exit is a terminal, deterministic failure.** If the worker
  process dies, the active cell receives `Error: Worker exited before
  responding`, the queue is dropped (no worker remains to drain it), and
  every later worker-dependent request fails with `worker is not running`
  until a new session is started.
- **R side effects are not transactional.** Reference-object mutation,
  superassignment, and external side effects cannot be rolled back on
  error; a failed cell removes only the bindings it declared (owned
  definitions). The one search-path exception: a package-attach barrier
  (`library()`/`require()`) that is edited, deleted, or fails/interrupts
  during evaluation invalidates the whole worker state and forces a clean
  worker restart before the next Run, because the search path may already
  have changed. See ADR 0002.
