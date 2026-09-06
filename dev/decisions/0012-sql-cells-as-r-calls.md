# SQL cells as R calls

Status: Superseded by ADR 0019 (2026-09-02)
Date: 2026-08-17

## Context

SQL needs an editor-friendly cell type while preserving Rscript execution, static analysis, and the existing process worker.

## Historical decision

SQL cells persist as canonical R assignments calling `sql()` with a raw-string query. They analyze as their R source, use an explicit connection when supplied, and otherwise use DuckDB against notebook data frames.

## Historical consequences

SQL remains valid R source and participates in the normal DAG. Canonical serialization and an optional DuckDB dependency are required; malformed SQL cell bodies are blocking diagnostics.

This decision is part of the full marimo parity implementation plan.

ADR 0019 removed this user-facing surface. Legacy `# %% [sql]` delimiters are
read as ordinary R code and preserved byte-for-byte until edited; scientists can
use DBI, dbplyr, or another database package directly in an R cell.
