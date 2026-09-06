# alder 0.1.0

* Added an opt-in developer input-to-result benchmark and process-local timing
  and CPU profiling. The target architecture and migration phases now specify
  explicit warm scalar latency requirements; these targets are not yet met
  merely by the earlier release acceptance.

First complete release of Alder, a reactive notebook for R.

* Plain-text `.R` notebooks with dependency-ordered execution, automatic and
  lazy reruns, interruption, and explicit stale/error states.
* A local web editor with R completion and signature help, scrollable native
  R documentation with F1 keyboard access, keyboard cell commands, project-aware
  opt-in lint diagnostics with visible tool failures, data and dependency
  explorers, light/dark themes, and app mode. Diagnostics match current source.
  Dataflow navigation keeps keyboard focus and graph scrolling through state
  updates while refreshing names, values, status and graph geometry.
  Unchanged source reference ranges and their transport encoding are reused
  across polls, avoiding repeated full-notebook scans and JSON encoding while
  long analyses execute.
* Reactive inputs and composed layouts, base and ggplot2 graphics, interactive
  tables, model summaries, HTML widgets, and ordered conditions and progress.
* Atomic saves with conflict detection and optional formatting that preserves
  source selections and newer typing, reproducible renv environments,
  dependency-aware caches, and headless execution and notebook tests.
* Quarto/knitr and direct Pandoc publishing, static exports, notebook conversion,
  and MCP access to the same execution and editing model.
* Lifecycle-owning Unix and Windows launchers and an installed Iris example.
* Faster worker startup and barrier recovery while preserving notebook R options,
  JIT settings, library selection, and environment isolation. Failed Restart R
  keeps retained outputs explicitly stale and clears old inspected values.
  Late interrupts after completed evaluations preserve the worker and queued
  requests, including rapid reactive widget updates.
* Sanitized Markdown and native help, isolated HTML widgets, bounded local API
  inputs, and explicit browser, worker, and language-service failure reporting.

Alder requires R 4.6.0 or newer. It serves the local machine only and executes
trusted R code with the user's permissions. Reference-object mutations and
external side effects cannot be rolled back. The README and installed help
describe the bounded static-analysis restrictions and optional integrations.
