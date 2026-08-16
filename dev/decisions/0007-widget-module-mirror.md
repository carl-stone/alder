# 0007 — Widget module mirrored into `inst/worker/`

Status: Accepted

## Context

Widget proxies (ADR 0003) must exist in two processes: the server's R
session (S3 registration, host-side helpers) and the worker process (cell
code binds `n <- ui$slider(...)`, worker serializes the spec). Keeping two
copies invites drift; the widget protocol must stay identical in both.

## Decision

- `R/ui-widgets.R` is the single source of truth; a copy lives at
  `inst/worker/ui-widgets.R` and is sourced by the worker.
- The worker receives the resolved path from the host
  (`ALDER_UI_WIDGETS`, ADR 0006), so the copy never depends on cwd.
- The copies must stay byte-identical. The approved sync procedure is:
  edit `R/ui-widgets.R`, then `cp R/ui-widgets.R inst/worker/ui-widgets.R`.

## Consequences

- One canonical definition; registration (S3 methods in `NAMESPACE`, package
  load) always matches what cells see.
- Drift is possible if a contributor edits only one copy; mitigated by the
  documented one-command sync and by round-trip tests exercising the worker
  copy end-to-end.

## Related

- ADR 0003 (widget value semantics), ADR 0006 (host-passed module path).