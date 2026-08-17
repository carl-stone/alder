# 0005 — marimo is the reference; Reactor is not

Status: Accepted  
Date: 2026-08-16

## Context

The vision names marimo as the primary product and UX reference, but
explicitly forbids building on Reactor (historical prior art only) and
forbids mechanically porting Python implementation choices. The design must
ask what property marimo provides and implement the most natural equivalent
for modern R.

## Decision

- Treat marimo as the behavioral reference for reactive execution,
  staleness, app mode, UI values, and serialization philosophy.
- Do not build on or depend on Reactor.
- Do not port marimo's implementation choices verbatim; derive from the
  property it provides and find the R-native equivalent (see ADR 0003 for
  the worked example: explicit `$value`).

### Source-verified reference behavior

The following marimo behaviors are authoritative and shape alder's
contracts (ADR 0002, 0003, 0008):

- **Running a changed cell automatically runs descendants by default.**
  marimo runs a cell and, by default, all cells that depend on it
  ("automatic execution mode"); an optional "lazy" execution mode reruns
  only the cell you request and marks dependents stale.
- **Optional lazy mode runs stale ancestors before a request.** In lazy
  mode, running any cell first runs every stale ancestor it depends on, so
  the requested cell sees current inputs.
- **Source keystrokes alone do not execute.** marimo separates editing
  (which marks cells stale) from execution; Run is the semantic change
  boundary. alder applies the same rule: source edits never execute code.
- **Widget values are explicit.** marimo elements expose a `.value`
  attribute; alder's R equivalent exposes `n$value` explicitly (ADR 0003).
- **Globals are unique.** marimo prevents a variable from being defined in
  more than one cell; contradictory definitions are an error that blocks
  execution. alder reports duplicate definitions the same way.
- **Apps are output-oriented views.** marimo app mode presents the
  notebook as a clean interactive application with code hidden. alder app
  view is output-only: it renders Markdown, logs, visible values, and
  widgets in notebook order and removes every editor control from the
  active surface.
- **Only cells referencing a widget rerun, not the cell that defines it.**
  Defining `n <- ui$slider(...)` does not re-execute its own cell when the
  slider moves; alder schedules the referencing cells and their
  descendants.

References: <https://docs.marimo.io/guides/reactivity/>,
<https://docs.marimo.io/guides/configuration/runtime_configuration/>,
<https://docs.marimo.io/guides/interactivity/>, and
<https://docs.marimo.io/guides/apps/>.

## Consequences

Easier: a clear north star for UX without a foreign implementation dragging
in Python idioms; R-native design choices fall out naturally (explicit
`$value`, eager-then-lazy run plans, output-only app view). Harder: marimo
behaviors must be re-derived into R semantics one at a time rather than
copied, and the automatic/lazy run planner plus output-only app DOM must be
tested as observable contracts.
