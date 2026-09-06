# Recursive widget identity in output trees

Status: Accepted
Date: 2026-09-03

## Context

Alder permits a bare named widget to be composed inside `out$hstack()`,
`out$vstack()`, `out$tabs()`, `out$accordion()`, `out$callout()`, and
`out$sidebar()`, including a layout returned by a resolved `out$lazy()` output.
These controls are visible and therefore must have the same reactive behavior
as a top-level widget. Treating only a cell's last top-level output as a widget
made composed controls look interactive while their updates were rejected.

## Decision

The Session recursively locates widget records through layout children and the
loaded child of a lazy output. The output-tree location is internal and remains
distinct from a composite widget's public `path`. A commit, error, cancellation,
worker failure, or one-shot reset is applied to every rendered occurrence of
the matching named widget in its owner cell while unrelated siblings remain
byte-for-byte equivalent in state.

The browser resolves operation waiters with the same recursive traversal. It
patches matching widget nodes in place while a structural signature confirms
that layout, lazy, non-widget, and immutable widget-spec content is unchanged;
otherwise it rebuilds the output record. Mutable values, selections, form
dirty state, and operation metadata do not cause a rebuild. Native slider
bounds and steps are applied before values so the browser cannot clamp an R
value against HTML's default range. Local and URL MCP adapters use the same
layout/resolved-lazy lookup when verifying one-shot reset state, so a composed
control has one settlement contract at every public interaction boundary.

## Consequences

Composed widgets and loaded lazy widgets retain focus, tab selection, and DOM
identity across polling and operation transitions. Run buttons can execute,
reset, and execute again in any supported layout. Removing or editing an owner
and worker transport failures terminalize pending operations instead of leaving
client waiters or controls locked. Every rendered tabs/accordion instance uses
unique linked control/panel identifiers; tabs expose tablist/tab/tabpanel roles
and selected state, while accordions expose expanded state that tracks panel
visibility. Changes to labels, choices, bounds, layout structure, or non-widget
siblings still rebuild deliberately so stale content is never preserved merely
to keep focus.
