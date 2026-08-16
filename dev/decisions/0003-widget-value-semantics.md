# 0003 — Widget values: S3 proxy that is its value

Status: Accepted  
Date: 2026-08-16

## Context

The vision requires reactive UI controls to be ordinary notebook values — `n <- ui$slider(10, 1000)` should invalidate calculations depending on `n`, with no explicit value unwrapping. Marimo achieves this by rewriting references to UI elements into value lookups and by Python's object model. R's data masking (dplyr::filter, ggplot) makes silent source rewriting fragile, because `n` resolution happens inside an evaluation environment that we do not control.

## Decision

`ui$slider()` (and other controls) return an S3 proxy object that IS the value.

- The object has a `.value` field holding the current value.
- It registers S3 methods (arithmetic, comparison, coercion `as.numeric`, `[i`, vector ops, subscripting) so that downstream code sees the underlying value when used in computations, plots, and tidy-eval predicates.
- When shown in the notebook UI, the object renders as the interactive control instead of a plain value; user interaction updates `.value` and invalidates dependents.
- Outside the notebook, the object is still a plain structured list with `$value` fully accessible.

This is the closest native-R analogue to marimo's model: code uses the control as if it were the value, with no explicit unwrap and no fragile source rewriting.

## Consequences

Easier: idiomatic R usage (`df |> filter(x > n)`), no magic string rewriting, obvious fallback outside the notebook. Harder: the proxy must implement a broad, careful set of S3 dispatch to behave naturally everywhere; some R constructs that bypass methods (e.g. certain internal `[[` usage or `attr<-` paths) may see the raw object.