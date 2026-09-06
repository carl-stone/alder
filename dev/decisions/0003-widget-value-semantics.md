# 0003 — Widget values: explicit `$value`

Status: Accepted  
Date: 2026-08-16

## Context

The vision requires reactive UI controls to be ordinary notebook values —
`n <- ui$slider(10, 1000)` should invalidate calculations depending on `n`.
Marimo elements expose an explicit `.value` attribute, so user code reads
`n.value`. R has no operator overloading that can make a plain scalar
"react", so alder must choose a representation. The first implementation
used an S3 proxy that claimed to *be* its value through coercion, Ops,
Math/Summary, subsetting, and formatting methods; that object model fell
short of R's semantics (internal `[[`/`attr<-` paths bypass S3 dispatch,
tidy-eval data masks do not consistently route through it, and the
"interchangeable with its value" claim is not true).

## Decision

A control is a plain classed list, class `alder_widget`, with public fields
`kind`, `label`, `value`, and kind-specific constraint fields. The value is
**explicit**: notebook code reads `n$value`. There is no `$ .value`
protocol field, no S3 coercion, arithmetic, comparison, subsetting,
formatting, or aggregation promise, and no claim that the object is
interchangeable with its value.

- `ui$slider(min, max, value = min, step = 1, label = NULL)` returns a
  slider control.
- `ui$dropdown(choices, value = choices[[1L]], label = NULL)` returns a
  dropdown control; user code reads the selected choice through `$value`.
- `ui$text_input(value = "", label = NULL)`, `ui$number(...)`,
  `ui$checkbox(value = FALSE, label = NULL)` return the corresponding
  controls.
- `ui$run_button(label = "Run")` returns a Boolean one-shot input: it is
  set to `TRUE` when clicked and resets to `FALSE` after its consumers
  finish (or once, immediately, when it has no consumers).
- `ui$button(label = "Click", value = 0L)` returns a button whose validated
  integer `$value` increments when clicked.

The widget value is exchanged over the worker/JSON protocol by explicit
typed values. Choice controls validate their values against their choices;
`range_slider()` and `date_range()` expose length-two vectors, and
`multiselect()` exposes a vector containing the selected choices. Other
controls expose their documented scalar, tabular, or nested value. The
client carries only the validated representation required by each control.

## Consequences

Easier: one unambiguous data model, no silent unwrapping that can produce
wrong results on S3-bypassing paths, explicit `n$value` reads that work
identically inside and outside the notebook, and a small surface to
validate. Harder: author code must write `min_wt$value` (explicit), and the
worker must retain an owned named widget record before it can render an
interactive control. That record may be a bare global or may be nested in a
supported layout or resolved lazy-output tree; unsupported anonymous widget
expressions fail with a structured render error.
