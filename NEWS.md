# alder 0.1.0

First release of Alder, a reactive notebook for R.

* Plain-text `.R` notebooks, dependency-ordered execution, automatic and lazy
  reruns, interruption, and explicit stale/error states.
* Local web editor with R completion, signature help, F1 documentation,
  opt-in project linting, dataflow navigation, themes, and output-only app mode.
* Reactive widgets and layouts; native plots, tables, models, HTML widgets,
  ordered conditions and progress.
* Atomic saves with conflict detection, optional formatting, renv integration,
  dependency-aware caches, headless execution and notebook tests.
* Quarto/knitr and direct Pandoc publishing, static exports, conversion and MCP.
* Unix and Windows launchers and an installed base-R Iris tutorial.
* Opt-in input-to-result benchmarks and process-local profiling. The planned
  architecture's latency targets remain unmet.

Requires R 4.6.0 or newer. Runs locally with the user's permissions.
