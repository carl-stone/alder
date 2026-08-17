# 0001 — Notebook file format: plain-text `.R` with `# %%` cells

Status: Accepted  
Date: 2026-08-16

## Context

Notebooks must be readable, diffable, mergeable source files, not opaque JSON. They must remain useful as ordinary source code outside the notebook app, work well in Git, and be safely editable by humans and coding agents. Quarto remains the canonical publishing path; `.qmd` interoperability is a future property of the plain-text format, not an export command in this plan. Runner decides the format architecture.

## Decision

A notebook is a plain R source file runnable with `Rscript`.

- A notebook must explicitly load alder and every other package it uses
  (e.g. `library(alder)`, `library(ggplot2)`) exactly as ordinary R source
  does; the served worker must not inject bindings that make the same
  source fail under `Rscript`. The worker sets notebook evaluation in the
  global environment and injects no runtime helpers into ordinary name
  lookup.
- Cells are delimited by `# %%` comment lines. `# %%` opens a code cell;
  `# %% [markdown]` opens a markdown cell.
- Cell metadata is written as `#| key: value` comments (Quarto's
  code-option syntax).
- Notebook metadata lives in a YAML block inside `# ---` comment fences at
  the top of the file.
- There is no notebook-specific primary format. Future `.qmd` interop is a
  property of the plain-text format, but this plan does not add an export
  command.

`# %%` is already the de-facto interactive-R cell marker (Positron, VS Code R extension), so the file is a normal R script in any editor; only the comments convey cell structure.

## Consequences

Easier: git diffs and merges, agent edits, running with `Rscript`, coexistence with Positron/VS Code/RStudio. Harder: no native distinction between exposition and code (markdown lives in comment cells); the parser must be exact about comment placement to stay round-trip safe; notebook code that omits `library(alder)` will not find `ui$` widgets under `Rscript` without the package loaded.