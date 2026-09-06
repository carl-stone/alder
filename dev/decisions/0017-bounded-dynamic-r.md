# 0017 — Bounded dynamic R: analyze literals, conservatively order source

Status: Accepted

Date: 2026-09-02

## Context

R makes metaprogramming and file sourcing ordinary language features. Blocking
every call named `eval` or `source` makes common R code unusable and conflicts
with the North Star. Executing an expression whose target environment or source
path is computed can still make notebook definitions unknowable, allowing
runtime state to diverge silently from the dependency graph.

## Decision

- Analyze `eval(quote(expr))`, `eval(expression(...))`, and `evalq(expr)` in the
  default environment as if their literal expressions appeared at that point.
  An explicit computed environment remains a blocking diagnostic.
- Analyze `assign("name", value)` as a definition and `rm("name")` / `rm(name)`
  as a bounded removal when they use the default evaluation environment. The
  `base::` spellings and `remove()` alias have the same rules. Computed names,
  `list=` removal, and explicit environment/position arguments remain blocked.
- Permit `source()` when its file argument is a literal string. Execute it from
  the notebook project directory and mark the cell opaque.
- Order an opaque source cell after every earlier executable cell and order
  every later executable cell after it. At runtime, compare notebook bindings
  before and after success so new or replaced names belong to that cell and can
  be cleaned on a later rerun. Restore prior bindings after failure.
- Continue to block computed lookup/mutation operations when their affected
  bindings cannot be statically bounded. Diagnostics name the operation and
  explain the restriction.

## Consequences

Ordinary literal metaprogramming and helper files work without weakening the
source/runtime agreement. Opaque cells trade parallelism and fine-grained
invalidation for correctness. External changes to a sourced file require an
explicit rerun because the notebook does not watch arbitrary filesystem inputs.
