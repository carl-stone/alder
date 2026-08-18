# SQL cells as R calls

Status: Accepted  
Date: 2026-08-17

## Context

SQL needs an editor-friendly cell type while preserving Rscript execution, static analysis, and the existing process worker.

## Decision

SQL cells persist as canonical R assignments calling `sql()` with a raw-string query. They analyze as their R source, use an explicit connection when supplied, and otherwise use DuckDB against notebook data frames.

## Consequences

SQL remains valid R source and participates in the normal DAG. Canonical serialization and an optional DuckDB dependency are required; malformed SQL cell bodies are blocking diagnostics.

This decision is part of the full marimo parity implementation plan.
