# Architecture Decision Records — index

Accepted design decisions for alder. Each record follows the same shape: Context, Decision, Consequences. See `template.md` for the format.

Only **accepted** decisions are ADRs. Undecided questions — including proposed ideas awaiting an opinion — are tracked in `../open-questions.md`, not here.

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
| 0012 | Accepted | SQL cells as R calls |
| 0013 | Accepted | CodeMirror 6 editor stack |
| 0014 | Accepted | Language intelligence bridge |
| 0015 | Accepted | App layouts and static export |
| 0016 | Accepted | Agent surface: MCP |
