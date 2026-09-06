# Language intelligence bridge

Status: Accepted  
Date: 2026-08-17

## Context

Completion, hover, definitions, references, and symbols should use R-aware semantics rather than browser-only heuristics.

## Decision

A parent-side R6 LSP client manages the required `languageserver` process using
framed JSON-RPC. Notebook positions map to physical file positions and responses
map back to cell coordinates. Cold initialization has a bounded 30-second
deadline; protocol output, asynchronous diagnostics, and idle process death are
continuously polled. Bounded stderr and exit details become persistent visible
service errors, and the HTTP surface provides a restart operation.

`languageserver` implements its diagnostic stream by running lintr. Alder
therefore disables that server task by default and exposes it only through the
explicit editor lint-diagnostics preference. Completion, signature help,
hover, navigation, and Alder's own parse/static-safety diagnostics do not
depend on lintr and remain available independently.

File URIs preserve native path separators, Windows drive/UNC structure, and
escaped filename characters. The language server can therefore resolve the
notebook's real project and its `.lintr` configuration.

Diagnostics whose range belongs to a single cell retain cell coordinates.
Delimiter, cross-cell, and other unmappable diagnostics are retained as
document-level editor diagnostics rather than assigned a false cell location.
The Session state exposes these through the `editor_diagnostics` array, with
`source = "lsp"`, the error/warning/information level, message, code, a null
cell `range`, and the original `file_range` when supplied. HTTP and both MCP
state backends expose the same Session contract. These editor diagnostics do
not become blocking dependency-graph errors.

State polling synchronizes ordinary notebook edits with the language server,
without requiring another editor-intelligence request. Changed source clears
the previous text's notes while fresh diagnostics are pending. Publications
that supply a document version different from the current version are ignored;
each accepted diagnostic publication replaces the previous set. Turning lint off
clears both cell and document lint diagnostics, including retained notes after
the language server has stopped. Failures inside lintr remain visible with
their original classification; this does not repair an upstream linter bug.

## Consequences

Editor intelligence follows the R language server and can be reused by other
clients. A language-server failure does not destroy notebook execution, but it
is never silently treated as an optional capability: users retain an actionable
status until that service recovers.

This decision is part of the full marimo parity implementation plan.
