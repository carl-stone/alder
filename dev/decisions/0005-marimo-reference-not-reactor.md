# 0005 — marimo is the reference; Reactor is not

Status: Accepted  
Date: 2026-08-16

## Context

The vision names marimo as the primary product and UX reference, but explicitly forbids building on Reactor (historical prior art only) and forbids mechanically porting Python implementation choices. The design must ask what property marimo provides and implement the most natural equivalent for modern R.

## Decision

- Treat marimo as the behavioral reference for reactive execution, staleness, app mode, UI values, and serialization philosophy.
- Do not build on or depend on Reactor.
- Do not port marimo's implementation choices verbatim; derive from the property it provides and find the R-native equivalent (see ADR 0003 for one worked example).

## Consequences

Easier: a clear north star for UX without a foreign implementation dragging in Python idioms; R-native design choices fall out naturally. Harder: marimo behaviors must be re-derived into R semantics one at a time rather than copied.