# Architecture Decision Records — index

Accepted design decisions for alder. Each record follows the same shape: Context, Decision, Consequences. See `template.md` for the format.

Only **accepted** decisions are ADRs. Undecided questions — including proposed ideas awaiting an opinion — are tracked in `../open-questions.md`, not here.
Every decision is subordinate to the North Star in `VISION.md`.

[The responsive architecture migration](../ARCHITECTURE.md) defines the accepted
target and phase-by-phase replacements. The ADRs below continue to describe the
current implementation until those replacements land; the target is not a claim
that the TypeScript host already exists.

| # | Status | Title |
|---|--------|-------|
| 0001 | Accepted | Notebook file format: plain-text `.R` with `# %%` cells |
| 0002 | Accepted | Reactive execution: automatic by default, optional lazy mode |
| 0003 | Accepted | Widget values: explicit `$value` |
| 0004 | Accepted | Execution engine: one serial R worker per notebook |
| 0005 | Accepted | marimo is the behavioral reference; not Reactor |
| 0006 | Accepted | Process transport: processx worker + `later` event loop |
| 0007 | Accepted | Widget module mirrored into `inst/worker/` |
| 0008 | Accepted | Product form: local web application |
| 0009 | Accepted | Streaming worker notifications |
| 0010 | Accepted | Multi-output cells |
| 0011 | Accepted | Dot-name cell locals |
| 0012 | Superseded by 0019 | SQL cells as R calls |
| 0013 | Accepted | CodeMirror 6 editor stack |
| 0014 | Accepted | Language intelligence bridge |
| 0015 | Accepted | App layouts and static export |
| 0016 | Accepted | Agent surface: MCP |
| 0017 | Accepted | Bounded dynamic R: analyze literals, conservatively order source |
| 0018 | Accepted | Reproducible environments: standard renv lockfiles and libraries |
| 0019 | Accepted | Product surface: R-first cells, CLI lifecycle, editor help, dual publishing |
| 0020 | Accepted | Explicit Quarto/knitr and direct-Pandoc publishing |
| 0021 | Accepted | Recursive widget identity in output trees |
