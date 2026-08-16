# alder

alder is a modern reactive notebook for R: plain-text `.R` notebook files, statically analyzed into a dependency DAG, executed in dependency order, with a marimo-inspired UX and app mode.

```
alder/
├── LICENSE                  # full Apache License 2.0 text
├── README.md                # project summary + quickstart
├── VISION.md                # product brief (the spec)
├── AGENTS.md                # this file
├── DESCRIPTION              # package metadata (Imports: httpuv, jsonlite, later, processx, R6)
├── NAMESPACE                # exports: ui, start_alder, stop_alder; S3 registrations
├── .Rbuildignore            # non-package files excluded from R CMD build
├── .gitignore               # ignore rules
├── .lintr                   # lintr config (R-idiomatic name styles, no line-length)
├── demo.R                   # runnable demo notebook (iris + slider + ggplot)
├── R/                       # package sources (server, session, worker control, analysis, notebook, widgets)
│   ├── notebook.R           #   # %% parser/serializer; byte-identical round-trip
│   ├── analysis.R           #   static defs/refs per cell -> DAG, dup/cycle diagnostics
│   ├── ui-widgets.R         #   ui$ S3 proxy module — SINGLE SOURCE OF TRUTH
│   ├── session.R            #   Session R6: queue, statuses, stale model, outputs
│   ├── worker.R             #   Worker R6: processx + later pipes, JSON-lines RPC
│   ├── server.R             #   httpuv app: static + JSON API, start/stop
├── inst/
│   ├── app/                 # frontend assets
│   │   ├── index.html       #   single page (editor chrome + templates)
│   │   └── static/          #   app.js (state render, widgets, debounced edits), style.css
│   └── worker/              # worker-side runtime
│       ├── worker.R         #   Rscript worker: JSON-lines stdin/stdout protocol
│       ├── ui-widgets.R     #   MIRROR of R/ui-widgets.R (cp to sync, ADR 0007)
│       └── server.R         #   launcher: source R/ files + serve (repeat run_now)
├── man/                     # Rd docs (start_alder, stop_alder, ui)
├── tests/
│   └── testthat/            # notebook round-trip, analysis, widgets, session rerun model
└── dev/                     # developer documentation (not docs/: reserved for pkgdown)
    ├── README.md            # navigation for dev docs
    ├── open-questions.md    # deferred Qs, become ADRs when decided
    └── decisions/           # accepted architecture decision records
        ├── index.md                    # ADR index + format link
        ├── template.md                  # blank ADR template
        ├── 0001-notebook-file-format.md # plain .R + # %% cells
        ├── 0002-rerun-model.md          # manual run + stale marking
        ├── 0003-widget-value-semantics.md # S3 proxy is the value
        ├── 0004-execution-engine.md     # one serial R worker per notebook
        ├── 0005-marimo-reference-not-reactor.md # marimo, not Reactor
        ├── 0006-process-transport.md    # processx + later event loop
        ├── 0007-widget-module-mirror.md # widget module mirrored into inst/worker/
        └── 0008-product-form.md         # product form: local web application
```
