# App layouts and static export

Status: Accepted; publishing-engine details refined by ADR 0020
Date: 2026-08-17

## Context

Alder needs publishable app views and interchange formats while execution remains process-based and cannot run in WebAssembly.

## Decision

App layout, width, code visibility, gallery, and grid sidecar state are server-managed. HTML export is static and embeds rendered artifacts as data URIs; Markdown, script, IPython, Quarto, and session exports use the same state snapshot. No browser kernel is introduced.

Malformed layout sidecars remain untouched and are exposed as persistent
`invalid_layout` state/API diagnostics until an explicit valid layout write.
Gallery discovery omits ordinary delimiter-free `.R` files, but a malformed
Alder candidate remains visible as an unavailable entry with its bounded parse
cause and a specific `invalid_notebook` response.

## Consequences

Published HTML is portable and safe to serve, but not interactive. Exporters must preserve output ordering and artifact bytes, and layout state has both notebook metadata and sidecar persistence paths. Editable qmd export is distinct from ADR 0020's executable Quarto/knitr and static direct-Pandoc rendering paths.

Interactive artifact URLs are immutable for a rendered output generation. When
a reactive commit supersedes an image, HTML widget, or media record, Alder keeps
the prior artifact for a short bounded fetch grace before retiring it; complete
session shutdown removes the temporary artifact directory. This prevents a
delivered state snapshot from racing its browser fetch without allowing
session-long artifact growth.

This decision is part of the full marimo parity implementation plan.
