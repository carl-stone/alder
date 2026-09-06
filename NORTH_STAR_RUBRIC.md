# North Star quality rubric

North Star: **What if marimo had originally been designed from the ground up to
focus on R?** All reviews score observable behavior against this rubric. A release
candidate requires every gate to pass and no Critical or High finding to remain.

## Scoring

- **4 — Release quality:** accurate, polished, documented, resilient, and verified.
- **3 — Complete:** correct normal and boundary behavior; only minor polish remains.
- **2 — Partial:** useful but important behavior, resilience, or ergonomics is missing.
- **1 — Prototype:** narrow happy path or unreliable behavior.
- **0 — Absent/unsafe:** missing, misleading, loses work, or produces incorrect state.

## Criteria

1. **Reactive correctness:** execution order, invalidation, stale state, cleanup, and
   source/runtime agreement are deterministic across success, failure, and recovery.
2. **R-language breadth:** ordinary modern R works; analyzer restrictions are minimal,
   bounded, explained, and demonstrably necessary.
3. **Condition fidelity:** errors, warnings, messages, tracebacks, and process failures
   are complete, visible, correctly classified, and never silently ignored.
4. **Scientific outputs:** base graphics, ggplot2, tables, models, HTML, Markdown,
   streams, and large outputs render accurately and usefully.
5. **Interaction integrity:** every visible button, keyboard action, editor command,
   widget, and app-mode control reacts once and exposes progress/failure.
6. **Data and work safety:** saves are atomic, conflicts explicit, source round-trips,
   interruption recovers, and no hidden state or silent data loss is possible.
7. **Reproducibility:** environments, declared packages, cache identity, seeds, export,
   and noninteractive execution support repeatable analyses.
8. **R-native ergonomics:** installation, one-command lifecycle-owned launch,
   RStudio-like completion/signature help, help, editing, diagnostics, and common
   scientific workflows feel natural to regular R users.
9. **Visual and accessibility quality:** notebook hierarchy, states, focus, keyboard
   access, responsive layouts, contrast, and output presentation are polished.
10. **Security and resource resilience:** local boundaries, input validation, process
    lifecycle, large data, and failure modes are explicit and safe.
11. **Agent/API parity:** programmatic clients can inspect and modify notebooks without
    bypassing correctness, security, or diagnostic contracts.
12. **Delivery maturity:** tests are deterministic, regression-focused, warning-free;
    build/check/CI/documentation support repeatable installation and maintenance,
    including both knitr/Quarto and direct Pandoc render paths.

## Non-negotiable gates

- No suppressed or ignored errors or warnings.
- No visible control that fails to react to interaction.
- No arbitrary R-code prohibition except a documented, carefully bounded static-
  analysis restriction with an actionable diagnostic.
- Full test, browser, lint, build, package-check, and user-flow validation is green.
- Four documented full review cycles and two final cold-start cycles are complete.
- A clean start resolves dependencies and leaves no unexpected warnings or processes.
