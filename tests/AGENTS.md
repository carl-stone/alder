# Tests

- Test observable behavior with independently derived expected results. Use
  plain R comparisons for ordinary R semantics and explicit expected results
  for reactive behavior.
- Existing tests describe past behavior. Keep guarantees that protect user work;
  rewrite or remove assertions that enforce superseded product decisions,
  source layouts or private implementation details. Explain that change in the
  owning implementation task; never change an expectation merely to hide a bug.
- Prefer small, deterministic tests with precise assertions. Use mocks where
  they isolate a useful boundary; verify integration against the actual app.
- Mac is the sole active platform. Delete Linux/Windows-only tests and obsolete
  release/CI matrices. Prefer removing duplicate or implementation-pinning checks
  to maintaining compatibility with retired code. Keep the useful suite small;
  a clean start does not require rebuilding the old verification machinery.
- Retain coverage of lost edits, external-file conflicts, concurrent clients,
  stale outputs, interruption, widgets, plots and project package behavior.
- Exercise native Mac typing, menus and dialogs when those are the acceptance
  criteria. Internal method calls do not substitute for native interactions.
- Review code before running tests. Reuse useful cases and run checks relevant
  to the change. Broaden or repeat for new changes, failures or unresolved risks.
- Keep performance measurements separate from portable correctness assertions;
  interpret timings on known hardware and representative user interactions.
- Report results and material gaps to the lead. A passing suite or worker report
  does not approve a slice. Lead-only execution restrictions are in
  [../AGENTS.md](../AGENTS.md).
