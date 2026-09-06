# Product surface priorities: R-first cells, CLI lifecycle, editor help, and dual publishing

Status: Accepted (2026-09-02). This decision supersedes ADR 0012's decision to
expose a dedicated SQL cell type. It remains subordinate to the North Star.

## Context

The user reviewed the cycle-1 implementation and clarified four product
priorities. A special SQL cell surface was not requested and distracts from an
R-first notebook; ordinary R can already use DBI, dbplyr, or any database client.
The current launch path requires an R process to call `start_alder()`. Language
intelligence exists but does not yet provide a complete, settings-controlled
RStudio-like editing experience. Publishing also needs explicit engine choices
rather than an ambiguous generic export path.

## Decision

- Remove the user-facing SQL cell type, add controls, parser/analyzer special
  cases, and SQL-specific public notebook helper. Backend implementation may use
  SQL where useful. Ordinary database code in R cells remains fully supported.
- Provide a one-command `alder` CLI as the primary interactive launch path, with
  packaged Unix and Windows launchers selected atomically by
  `alder_install_cli()`. The command owns server and worker startup, browser
  opening, signal handling, shutdown, and meaningful exit status. A missing
  `.R` edit path is an announced new notebook and is created only by the first
  successful Save; render inputs must already exist. Automatic idle shutdown
  first uses the normal atomic/conflict-checked save for acknowledged changes;
  a failed save pauses shutdown instead of discarding work. Keep the R API for
  programmatic use. On Unix the launcher replaces itself with the R CLI process
  instead of backgrounding it: this retains normal foreground `SIGINT`
  handling in the CLI and every worker it spawns, while preserving the
  launcher's PID and exit status. If `SIGINT` arrives while httpuv is executing
  a request callback, the callback returns a structured shutdown response,
  latches exit status 130, and defers teardown to the next event-loop turn so
  httpuv cannot translate and swallow the interrupt as a generic HTTP 500.
- Provide normal R completion and signature/argument help, with independent
  settings controls and persistent configuration.
- Provide and test distinct knitr-backed Quarto and direct Pandoc publishing
  paths. Engine selection and missing-tool errors must be explicit.

## Consequences

ADR 0012 is superseded. Its dedicated cell/helper implementation, tests, docs,
and user flow were removed in one deliberate change; legacy delimiters remain
byte-preserving ordinary code. Cross-platform CLI lifecycle, editor assistance,
and both publishing engines are release gates. Existing green cycle-1 behavior
is the baseline, not a reason to retain out-of-scope surface area.
