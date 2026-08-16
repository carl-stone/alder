# alder

A modern reactive notebook for R.

Cells are statically analyzed into a dependency DAG, execute in dependency
order, and update when upstream code changes. Notebooks are plain-text `.R`
files you can run with `Rscript`. The UI is a local web app served by
`start_alder()`.

```r
# install dependencies, then:
pkgload::load_all(".")
alder::start_alder("demo.R", port = 8899)   # open http://127.0.0.1:8899/
```

What works today (v1):

- `# %%` cells in plain `.R` files, `#| key: value` cell options, `# ---`
  YAML front matter — saved byte-for-byte as you typed it (ADR 0001).
- Dependency DAG from static analysis: duplicate-definition and cycle
  diagnostics, dependency-first execution (ADR 0002).
- Manual run model: editing marks a cell and its transitive dependents
  stale; running a cell reruns exactly the stale dependents in order.
- `ui$slider(...)`, `ui$dropdown(...)`, `ui$text_input(...)`,
  `ui$number(...)`, `ui$button(...)`, `ui$checkbox(...)` — S3 proxies whose
  value is `.value`; coercion (`as.numeric`/`as.character`/`as.logical`/
  `as.matrix`/`as.data.frame`), arithmetic/comparison (Ops), Math/Summary,
  `mean()`, subsetting, and formatting all unwrap the underlying value
  (ADR 0003).
- Rich outputs: ggplot images, htmlwidgets, data-frame previews, text.
- Interruptible execution (Stop), app mode (UI hides code), save/reopen
  round-trip, and a JSON API (`/api/state`, `/api/run`, `/api/cell`,
  `/api/widget`, `/api/interrupt`, `/api/value`, `/api/save`).

See `VISION.md` for the full product brief and `dev/` for design decisions.
The test suite covers parser round-trips, analysis, widget semantics, and
the rerun model; `R CMD check` is clean.
