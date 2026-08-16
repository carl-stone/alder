# alder

alder is a modern reactive notebook for R: plain-text `.R` notebook files, statically analyzed into a dependency DAG, executed in dependency order, with a marimo-inspired UX and app mode.

```
alder/
├── LICENSE          # license text
├── README.md        # one-paragraph project summary
├── VISION.md        # product brief (the spec)
├── AGENTS.md        # this file
├── .gitignore       # ignore rules
└── dev/             # developer documentation (not docs/: reserved for pkgdown)
    ├── README.md                # navigation for dev docs
    ├── open-questions.md        # deferred Qs, become ADRs when decided
    └── decisions/               # accepted architecture decision records
        ├── index.md                       # ADR index + format link
        ├── template.md                    # blank ADR template
        ├── 0001-notebook-file-format.md   # plain .R + # %% cells
        ├── 0002-rerun-model.md            # manual run + stale marking
        ├── 0003-widget-value-semantics.md # S3 proxy is the value
        ├── 0004-execution-engine.md       # one serial R worker per notebook
        └── 0005-marimo-reference-not-reactor.md # marimo, not Reactor
```