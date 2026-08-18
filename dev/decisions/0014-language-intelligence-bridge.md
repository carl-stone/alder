# Language intelligence bridge

Status: Accepted  
Date: 2026-08-17

## Context

Completion, hover, definitions, references, and symbols should use R-aware semantics rather than browser-only heuristics.

## Decision

A parent-side R6 LSP client manages a `languageserver` process using framed JSON-RPC. Notebook positions map to physical file positions and responses map back to cell coordinates. Unsupported or unavailable language services return explicit diagnostics.

## Consequences

Editor intelligence follows the R language server and can be reused by other clients. Process lifetime, incremental framing, and unavailable-package handling are part of the runtime contract.

This decision is part of the full marimo parity implementation plan.
