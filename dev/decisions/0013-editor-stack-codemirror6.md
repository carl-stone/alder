# CodeMirror 6 editor stack

Status: Accepted  
Date: 2026-08-17

## Context

The editor needs reliable editing, language modes, diagnostics, completion, keymaps, and reactive decorations without install-time frontend builds.

## Decision

A committed CodeMirror 6 bundle is built from `js/` with esbuild. The runtime
loads the bundle from `inst/app/static/vendor/`; executable cells use the R
language mode and Markdown cells use Markdown-aware editing. Autocompletion's
StateField remains installed for an editor's lifetime: settings gate its stable
source and close it through CodeMirror APIs instead of removing live state.
The server supplies a per-process CSP nonce through `EditorView.cspNonce` for
CodeMirror's generated stylesheet; required geometry style attributes are
allowed separately while scripts remain same-origin only.

## Consequences

The repository carries generated JavaScript and must rebuild it when editor
sources change. Package installation remains offline and deterministic because
no install-time build is required. Browser release tests collect Chrome's
security Log domain in addition to ordinary console/network failures.

This decision is part of the full marimo parity implementation plan.
