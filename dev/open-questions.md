# Open questions / deferred decisions

Questions not yet decided. These are **not** ADRs — `decisions/` holds only accepted design decisions (see `decisions/index.md`). When something here is decided, conclude it by writing an ADR and removing the entry.

| ID | Question | Latest position | Status |
|----|----------|-----------------|--------|
| Q1 | Product form: web app, desktop, or editor extension (Positron/VS Code)? | Recommendation on the table: a local web application (editor + app mode, marimo-style), with the runtime/protocol designed so a Positron/VS Code client can reuse the backend later. Not yet approved. | Open |
| Q2 | Async worker execution: may independent cells ever run concurrently (mirai/future)? | Serial single-process model is adopted (ADR 0004). Parallelism is not the default; an explicit per-cell async flag is a possible addition. | Deferred — not a decision yet |
| Q3 | Notebook persistence of UI control states across restarts | Not specified in VISION; no recommendation yet. | Open |
| Q4 | What does staleness show for outputs (badge only vs dimmed render) | Not specified; marimo reference is a badge. | Open |

To resolve a row: decide, add an ADR under `decisions/NNNN-title.md`, update `decisions/index.md`, then delete the row here.