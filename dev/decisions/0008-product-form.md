# ADR 0008 — Product form: local web application

Status: **Accepted**
Date: 2026-08-16

## Context

VISION describes alder's notebook experience (editor, dependency graph,
stale marking, app mode) but not the delivery shape: a local web
application, a desktop wrapper, a Positron/VS Code extension, or several of
them. The question (Q1) was deliberately left open in VISION and the
technical design was kept transport-agnostic.

## Decision

alder's first full product is a **local web application**: the notebook
editor and app mode run in a browser against a local `httpuv` server with a
JSON protocol, exactly as the reference marimo-style workflow describes.
That choice lands the whole scope — project creation, editing, execution,
state, rendering — on one known-good surface today.

A desktop wrapper and an editor extension are **not** the current product.
The R runtime, the worker process model, and the JSON protocol keep
browser-specific coupling out of the notebook format, the analysis engine,
and the worker, so a future Positron/VS Code client can reuse them, but no
such client is planned now.

## Consequences

- The frontend is plain browser JS served from `inst/app`; there is no
  bundler or Node build step.
- UI behavior (widgets, editor interaction, app mode) is developed and
  tested against the JSON API, which keeps every UI feature on the same
  surface a future editor client would use.
- No desktop-shell (Electron/Tauri) or editor-extension work is planned;
  the "local web application" answer resolves packaging to "serve
  locally", and the plain-text `.R` notebook format keeps interoperability.
- Adopting a desktop shell or an editor extension later does not change
  the notebook format, the execution engine, or the transport — it only
  starts reusing them.