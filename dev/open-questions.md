# Open questions / deferred decisions

Questions not yet decided. These are **not** ADRs — `decisions/` holds only accepted design decisions (see `decisions/index.md`). When something here is decided, conclude it by (1) writing an accepted ADR file in `decisions/`, (2) updating `dev/decisions/index.md` with its row, and (3) removing the question here — all three are required: write an accepted ADR, update `dev/decisions/index.md`, and remove the question.

| ID | Question | Latest position | Status |
|----|----------|-----------------|--------|
| Q2 | Async worker execution: may independent cells ever run concurrently (mirai/future)? | Serial single-process model is adopted (ADR 0004). Parallelism is not the default; an explicit per-cell async flag is a possible addition. | Deferred — not a decision yet |
| Q3 | Notebook persistence of UI control states across restarts | Not specified in VISION; no recommendation yet. | Open |
