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

Clarifications required by the implementation:

- **App view is output-only.** It renders Markdown, logs, visible values,
  and widgets in notebook order and removes source textareas, cell
  headers, empty outputs, and every editor control (add/save/delete/run/
  runtime selector) from the active surface; it retains Stop, the status
  region, nonempty stdout/message/error logs as output, and an accessible
  Edit-mode link. Rendering Markdown is a first-class app-view behavior.
- **App view always uses automatic widget reactivity.** A widget
  interaction in app view automatically executes referencing cells and
  their descendants, regardless of the editor's runtime mode; the defining
  cell never reruns on its own widget change.
- **An app URL never triggers code.** Serving `/?view=app` is read-only;
  it never auto-runs cells (startup execution is governed only by the
  Session's `run_on_startup` setting, ADR 0002).