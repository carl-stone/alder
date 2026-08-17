# alder

A modern reactive notebook for R.

Cells are statically analyzed into a dependency DAG, execute in dependency
order, and update when upstream code changes. Notebooks are plain-text `.R`
files you can run with `Rscript`. The UI is a local web app served by
`start_alder()`.

## Quickstart

Install alder and its dependencies first, then run the demo notebook or
serve it as a web app. Do not use `pkgload::load_all()` as the production
path — ordinary execution requires the installed package.

```r
install.packages(c("httpuv", "jsonlite", "later", "processx", "R6",
                   "commonmark", "fs", "xml2", "yaml"))
```

```sh
R CMD INSTALL .                          # production install of the package
```

Development: `pkgload::load_all(".")` may be used to run the suite, but it
is not the production path — ordinary execution requires the installed
package.

```sh
Rscript demo.R                              # runs the notebook as ordinary R
```

```r
alder::start_alder("demo.R", port = 8899)   # open http://127.0.0.1:8899/
alder::stop_alder(srv)
```

## Behavior

- `# %%` cells in plain `.R` files, `#| key: value` cell options, `# ---`
  YAML front matter — saved byte-for-byte as you typed it (ADR 0001). A
  notebook must load alder and every package it uses explicitly, exactly as
  ordinary R source; the served worker injects no bindings that would make
  the same source fail under `Rscript`.
- Dependency DAG from static analysis: unique globals, cycle and
  render-blocking diagnostics, dependency-first execution (ADRs 0002, 0005).
- Reactive execution, automatic by default with an optional lazy mode:
  editing marks the edited cell and its descendants stale; running a cell
  reruns its ancestors, the target, and all descendants (automatic) or the
  ancestors and target only (lazy). Source edits never execute code — Run
  is the change boundary.
- Widgets are ordinary notebook values with an **explicit** `$value`:
  `ui$slider(...)`, `ui$dropdown(...)`, `ui$text_input(...)`,
  `ui$number(...)`, `ui$checkbox(...)`, and one-shot `ui$run_button(...)`.
  Widget interactions rerun referencing cells and their descendants
  automatically, and in every app view (ADR 0003).
- Rich outputs: ggplot images, htmlwidgets, bounded data-frame previews,
  text, and logs.
- An output-only app view (`/?view=app`) renders Markdown, logs, values,
  and widgets in notebook order with no editor controls (ADR 0008).
- Interruptible execution (Stop), save/reopen round-trip with atomic
  saves, and a JSON API (`/api/state`, `/api/run`, `/api/cell`,
  `/api/widget`, `/api/interrupt`, `/api/value`, `/api/save`,
  `/api/runtime`).

## Security and execution model

- The R worker is a separate process for **process isolation**, not a
  security sandbox: arbitrary trusted R code runs in the worker and can
  inspect its process and call stack. You must run only trusted notebook
  code.
- Ordinary `Rscript` execution has ordinary top-level printing/device
  effects; worker rendering does not duplicate them (a rendered plot, for
  example, does not also write `Rplots.pdf`). R's reference-object and
  external side effects are not transactional — as with marimo, mutating
  shared state from a cell is a documented limitation.

See `VISION.md` for the full product brief and `dev/` for design decisions.
The test suite covers parser round-trips, analysis, widget semantics, the
reactive schedule, the HTTP boundary, and browser behavior.
