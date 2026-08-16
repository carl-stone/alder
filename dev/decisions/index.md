# Architecture Decision Records — index

Accepted design decisions for alder. Each record follows the same shape: Context, Decision, Consequences. See `template.md` for the format.

Only **accepted** decisions are ADRs. Undecided questions — including proposed ideas awaiting an opinion — are tracked in `../open-questions.md`, not here.

| # | Status | Title |
|---|--------|-------|
| 0001 | Accepted | Notebook file format: plain-text `.R` with `# %%` cells |
| 0002 | Accepted | Cell rerun model: manual run with stale marking |
| 0003 | Accepted | Widget values: S3 proxy that is its value |
| 0004 | Accepted | Execution engine: one serial R worker per notebook |
| 0005 | Accepted | marimo is the behavioral reference; not Reactor |