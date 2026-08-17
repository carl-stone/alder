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
  `clear_cell`, `set_widget`, `get_value`, ping/reply); stderr is a
  diagnostic channel.
- One `poll_cycle` callback scheduled on `later` pumps the connections
  non-blockingly on every loop turn; nothing in the browser request path
  ever blocks on the worker.
- SIGINT via `proc$interrupt()` is the stop mechanism (worker catches
  interrupts inside cell evaluation and reports `Interrupted`; the process
  stays alive for the next cell).
- The widget module resolution is host-side: the server passes the resolved
  `ui-widgets.R` path to the worker via `ALDER_UI_WIDGETS`
  (cwd-independent; testing harnesses move the cwd). The worker consumes
  the `ALDER_UI_WIDGETS`/`ALDER_ARTIFACT_DIR` transport variables and
  immediately unsets them so notebook code cannot see them.
- The host also passes `ALDER_APP_DIR`; the worker has no cwd-dependent
  probes.

## Consequences

- No blocking paths in the server; the UI stays responsive during long
  cells; Stop works because the interrupt write reaches the worker while it
  is busy.
- JSON-lines is trivial to replay in tests and to reimplement for future
  clients (Positron/VS Code adapter, per VISION).
- `callr::r_session` stays a possible future swap: the seam is `Worker`
  (R6), whose public surface (`send`, `poll`, `interrupt`, `kill`, `alive`,
  `restart`) is the only interface the session uses.

Clarifications required by the implementation:

- **Protocol stdout is exclusive and request-scoped.** The worker's stdout
  carries protocol JSON only. Explicit user output (`print`, `cat`,
  warnings, messages) becomes the cell **log**; visible-value rendering is a
  **separate output** and is never auto-printed into the log. Every
  response echoes `req` and `cmd`; eval responses also echo `id`,
  `revision`, and `run_id`; a worker that emits malformed JSON, a response
  with no pending request, or a mismatched identity is treated as a
  terminal transport failure.
- **Ack-gated interrupt.** Eval emits one start acknowledgement, then the
  host may send exactly one SIGINT gated on that request's ack
  (`executing_req`, ADR 0004). A SIGINT that lands on the blocking read is
  caught and ignored by the outer loop. A Stop arriving after a successful
  response is too late: the success commits (ADR 0004).
- **Worker transport failures fail closed.** If the worker dies, every
  pending callback fires exactly once with a synthetic transport error, the
  active cell errors, queued jobs are dropped, and a single terminal
  `on_failure` callback drives the Session's worker-unavailable transition.
