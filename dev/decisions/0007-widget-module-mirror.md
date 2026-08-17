# 0007 — Widget module mirrored into `inst/worker/`

Status: Accepted

## Context

Widgets (ADR 0003) must exist in two processes: the server's R session
(constructor validation, host-side helpers) and the worker process (cell
code binds `n <- ui$slider(...)`, the worker validates and serializes the
spec). Keeping two copies invites drift; the widget protocol must stay
identical in both.

## Decision

- `R/ui-widgets.R` is the single source of truth; a byte-identical copy
  lives at `inst/worker/ui-widgets.R`.
- The worker receives the resolved path from the host
  (`ALDER_UI_WIDGETS`, ADR 0006) and sources it into a private
  `UI_ENV`, so the copy never depends on cwd and never injects `ui` into
  notebook name lookup.
- The approved sync procedure is: edit `R/ui-widgets.R`, then
  `cp R/ui-widgets.R inst/worker/ui-widgets.R`.
- A **permanent raw-byte identity test** asserts
  `testthat::expect_identical(readBin(R/ui-widgets.R), readBin(inst/worker/ui-widgets.R))`
  so drift breaks the suite immediately, not only at release time.

## Consequences

- One canonical definition; the package and worker always agree.
- `ALDER_UI_WIDGETS` must point at the package-resolved mirrored copy
  (`inst/worker/ui-widgets.R`), never `R/ui-widgets.R`, so the worker always
  runs the same bytes the identity test guards.

## Related

- ADR 0003 (widget value semantics), ADR 0006 (host-passed module path).
