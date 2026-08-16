# 0006 — Process transport: processx worker + `later` event loop

Status: Accepted

## Context

ADR 0004 chose one long-lived R worker process per notebook, owned by the
server, running cells serially. The remaining decision was the transport:
how the server and worker communicate without the server blocking, and
whether to hand-roll any of the machinery.

Rejected alternatives: (a) `callr::r_session` — a maintained wrapper that
still exposes raw connections plus its own event loop; it would replace
`processx` (the primitive it itself uses) without removing any
product-specific state handling. (b) A blocking read loop — cells run for
arbitrary durations; blocking the server on the worker's stdout would freeze
the editor UI and the interrupt path. (c) Socket-based transports (zmq,
websockets) — more moving parts for no benefit at JSON-lines scale.

The "state machine" (queue, statuses, stale marking, dependents) is product
logic owned by `Session` (ADR 0002). Using a primitive for I/O is not
reinventing that machine.

## Decision

- Spawn with `processx::process$new(stdin="|", stdout="|", stderr="|",
  supervise=TRUE)`; stdin/stdout carry a JSON-lines RPC (`eval_cell`,
  `set_widget`, `get_value`, ping/reply); stderr is a diagnostic channel.
- One `poll_cycle` callback scheduled on `later` pumps the connections
  non-blockingly on every loop turn; nothing in the browser request path
  ever blocks on the worker.
- SIGINT via `proc$interrupt()` is the stop mechanism (worker catches
  interrupts inside cell evaluation and reports `Interrupted`; the process
  stays alive for the next cell).
- Widget proxy module resolution is host-side: the server passes the
  resolved `ui-widgets.R` path to the worker via `ALDER_UI_WIDGETS`
  (cwd-independent; testing harnesses move the cwd).
- The host also passes `ALDER_APP_DIR`; the worker keeps probe fallbacks but
  must not rely on its own cwd.

## Consequences

- No blocking paths in the server; the UI stays responsive during long
  cells; Stop works because the interrupt write reaches the worker while it
  is busy.
- JSON-lines is trivial to replay in tests and to reimplement for future
  clients (Positron/VS Code adapter, per VISION).
- `callr::r_session` stays a possible future swap: the seam is `Worker`
  (R6), whose public surface (`send`, `poll`, `interrupt`, `kill`, `alive`)
  is the only interface the session uses.

Clarifications required by the implementation:

- **Protocol stdout is exclusive.** The worker's stdout carries protocol
  JSON only; all user-code output (`cat`, prints, visible-value rendering)
  is captured into the cell log, and `Rscript --vanilla`'s non-interactive
  SIGINT behavior is handled by acknowledging evaluation before any
  interrupt is sent, so Stop never kills the process.