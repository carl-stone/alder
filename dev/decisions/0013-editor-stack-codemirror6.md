# CodeMirror 6 editor stack

Status: Accepted  
Date: 2026-08-17

## Context

The editor needs reliable editing, language modes, diagnostics, completion, keymaps, and reactive decorations without install-time frontend builds.

## Decision

A committed CodeMirror 6 bundle is built from `js/` with esbuild. The runtime loads the bundle from `inst/app/static/vendor/`; R cells use the legacy R stream mode and SQL uses the SQL stream mode.

## Consequences

The repository carries generated JavaScript and must rebuild it when editor sources change. Package installation remains offline and deterministic because no install-time build is required.

This decision is part of the full marimo parity implementation plan.
