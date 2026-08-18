# App layouts and static export

Status: Accepted  
Date: 2026-08-17

## Context

Alder needs publishable app views and interchange formats while execution remains process-based and cannot run in WebAssembly.

## Decision

App layout, width, code visibility, gallery, and grid sidecar state are server-managed. HTML export is static and embeds rendered artifacts as data URIs; Markdown, script, IPython, Quarto, and session exports use the same state snapshot. No browser kernel is introduced.

## Consequences

Published HTML is portable and safe to serve, but not interactive. Exporters must preserve output ordering and artifact bytes, and layout state has both notebook metadata and sidecar persistence paths.

This decision is part of the full marimo parity implementation plan.
