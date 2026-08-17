# alder

alder is a modern reactive notebook for R: plain-text `.R` notebook files, statically analyzed into a dependency DAG, executed in dependency order, with a marimo-inspired UX and app mode.

```
alder/
├── LICENSE                  # license stub (YEAR / COPYRIGHT HOLDER)
├── README.md                # project summary + quickstart
├── VISION.md                # product brief (the spec)
├── AGENTS.md                # this file
├── DESCRIPTION              # package metadata (Imports: commonmark, fs, httpuv, jsonlite, later, processx, R6, xml2, yaml)
├── NAMESPACE                # exports: ui, start_alder, stop_alder
├── .Rbuildignore            # non-package files excluded from R CMD build
├── .gitignore               # ignore rules
├── .lintr                   # lintr config (R-idiomatic name styles, no line-length)
├── demo.R                   # runnable demo notebook (iris + slider + ggplot)
├── R/                       # package sources (server, session, worker control, analysis, notebook, widgets)
│   ├── notebook.R           #   # %% parser/serializer; byte-identical round-trip
│   ├── analysis.R           #   eval-order scoping walk per cell -> DAG, blocking/warning diagnostics
│   ├── ui-widgets.R         #   ui$ alder_widget module (explicit $value) — SINGLE SOURCE OF TRUTH
│   ├── session.R            #   Session R6: cell_state records, reactive schedule, widget ops
│   ├── worker.R             #   Worker R6: processx + later pipes, JSON-lines RPC, restart/release
│   ├── server.R             #   httpuv app: static + JSON API, origin/CSP boundary, start/stop
│   ├── utils.R              #   package-internal helpers (%||%)
│   └── zzz.R                #   package load hooks
├── inst/
│   ├── app/                 # frontend assets
│   │   ├── index.html       #   single page (editor chrome + templates)
│   │   └── static/          #   app.js (state render, edit/widget coalescers, app view), style.css
│   └── worker/              # worker-side runtime
│       ├── worker.R         #   Rscript worker: JSON-lines stdin/stdout protocol (local() runtime)
│       ├── ui-widgets.R     #   MIRROR of R/ui-widgets.R (cp to sync, ADR 0007; byte-identity test)
│       └── server.R         #   installed-package launcher: main(args), start_alder, later pump
├── man/                     # Rd docs (start_alder, stop_alder, ui)
├── tests/
│   └── testthat/            # notebook round-trip, analysis, widgets, session schedule, server, browser
│       ├── helper-session.R #   session/worker setup + deadline polling
│       ├── helper-http.R    #   subprocess + later pumping HTTP harness
│       ├── test-notebook.R  #   byte-fidelity parser boundaries
│       ├── test-analysis.R  #   R scoping/diagnostic contracts
│       ├── test-widgets.R   #   mirror byte-identity + constructor/validation ($value)
│       ├── test-session.R   #   reactive execution, widget ops, worker failures
│       ├── test-server.R    #   HTTP boundary, atomic save, security headers
│       ├── test-browser.R   #   chromote browser suite against an installed launcher (zero skips)
│       └── test-carlstone-review.R # requester-named deterministic regression file
└── dev/                     # developer documentation (not docs/: reserved for pkgdown)
    ├── README.md            # navigation for dev docs
    ├── open-questions.md    # deferred Qs, become ADRs when decided
    └── decisions/           # accepted architecture decision records
        ├── index.md                    # ADR index + format link
        ├── template.md                  # blank ADR template
        ├── 0001-notebook-file-format.md # plain .R + # %% cells (explicit library(alder))
        ├── 0002-rerun-model.md          # reactive execution: automatic default, optional lazy
        ├── 0003-widget-value-semantics.md # explicit $value; no coercion promises
        ├── 0004-execution-engine.md     # one serial R worker per notebook; request-scoped interrupt
        ├── 0005-marimo-reference-not-reactor.md # marimo, not Reactor; source-verified behavior
        ├── 0006-process-transport.md    # processx + later event loop; strict response identity
        ├── 0007-widget-module-mirror.md # widget module mirrored into inst/worker/ (byte-identity)
        └── 0008-product-form.md         # local web app; output-only app view
```
