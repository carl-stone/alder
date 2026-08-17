# R-Native Reactive Notebook

Build a **modern reactive notebook environment for R**, inspired by marimo’s product model but designed natively around contemporary R.

## Product vision

The goal is to make the best possible interactive computational environment for R: a notebook that feels as fluid as Jupyter, as reproducible as a well-structured script, as reactive as Shiny, as publishable as Quarto, and as friendly to Git and coding agents as ordinary source code.

Ordinary R code should automatically form a dependency graph:

```
raw <- readr::read_csv("counts.csv")
filtered <- raw |> dplyr::filter(count > 100)
ggplot(filtered, aes(gene, count)) + geom_point()
```

should naturally behave as:

```
raw → filtered → plot
```

When upstream code changes, everything affected should update correctly. Notebook state should always correspond to the source currently visible on screen. There should be no hidden execution-order state.

## Core principles

Use **marimo as the primary product and UX reference**, but do not mechanically port Python implementation choices. Ask what property marimo provides, then implement the most natural equivalent for modern R.

Do **not** build on Reactor. It is useful historical prior art only.

Prefer existing high-quality R ecosystem components where appropriate. The product should feel at home alongside tidyverse, ggplot2, Shiny, Quarto, renv/pak, and modern R language tooling rather than creating a parallel ecosystem.

The notebook should remain useful as ordinary source code outside the notebook application.

## Perfect product

### Reactive execution

Cells are statically analyzed to determine top-level definitions and references and assembled into a dependency DAG.

The runtime should:

- execute cells in dependency order;
- rerun or mark stale downstream cells automatically: running a cell is the
  change boundary, after which all descendants rerun by default
  (`automatic` execution mode), with an optional `lazy` mode that leaves
  descendants stale and runs stale ancestors before a requested cell;
- remove values whose definitions disappear;
- prevent contradictory definitions and cyclic dependencies (globals are
  unique);
- distinguish notebook globals from function-local names and data-masked expressions;
- handle normal modern R syntax, pipes, formulas, namespaces, functions, S3/S4/R7 objects, and common tidy-evaluation patterns intelligently;
- provide understandable diagnostics when code is too dynamic to analyze safely;
- support eager and lazy execution;
- support caching for expensive computations;
- support interruption and cancellation;
- never allow notebook state to silently diverge from notebook source.

### First-class R experience

This should not feel like R running inside a generic foreign notebook frontend.

Provide excellent support for:

- tidyverse workflows;
- base R;
- ggplot2;
- base graphics;
- htmlwidgets;
- data.table;
- Bioconductor;
- statistical models;
- scientific and computational biology workflows;
- rich R object inspection;
- package documentation and help;
- R-specific errors, warnings, messages, conditions, and tracebacks.

Objects should render appropriately rather than falling back to plain text whenever richer representations are possible.

### Excellent editor

The editor should be good enough to function as a serious R development environment.

Include:

- modern syntax highlighting;
- completion;
- hover information;
- go-to-definition;
- references;
- diagnostics;
- formatting;
- rename/refactoring where supported;
- signature help;
- documentation lookup;
- command palette;
- keyboard-first cell manipulation;
- multiple cursors and normal modern editing affordances.

Integrate with current R language tooling rather than inventing an inferior editor-specific implementation.

### Rich outputs and data exploration

Data frames, tibbles, matrices, model objects, plots, and other common objects should have rich interactive representations.

The dataframe experience should support things such as:

- sorting;
- filtering;
- searching;
- column inspection;
- summary statistics;
- missingness inspection;
- pagination/virtualization for large datasets;
- copying/exporting;
- easy transition from interactive operations back to reproducible R code.

Plots should render crisply and support useful inspection/export behavior.

### Interactive UI and app mode

Reactive UI values should be ordinary notebook values.

Users should be able to add sliders, dropdowns, text inputs, buttons,
selectors, and other controls without manually constructing a Shiny-style
callback graph. Widget values are explicit — a control binds as an object
whose current value is read through `$value`:

```
n <- ui$slider(10, 1000)
heavy <- subset(peng, Sepal.Length >= n$value)
```

Changing a control should naturally invalidate calculations depending on
that widget value — rerunning its referencing cells and their descendants
automatically, and in every app view.

Any suitable notebook should be runnable as a clean interactive application
with code hidden, similar to marimo app mode: an output-only view that
renders Markdown, logs, values, and widgets in notebook order and exposes
no editor controls.

Where useful, interoperate with Shiny rather than competing unnecessarily with it.

### Plain-text, Git-native notebooks

Notebook files should be readable, diffable, mergeable source files rather than opaque JSON documents.

They should:

- work well in Git;
- be understandable to humans;
- be editable by ordinary text editors;
- be editable safely by coding agents;
- preserve cell boundaries and notebook metadata without dominating the source;
- run or degrade sensibly outside the notebook application.

Avoid an `.ipynb`-style serialization format.

### Reproducible environments

A notebook should be able to capture enough environment information to run reproducibly elsewhere.

Integrate naturally with modern R package/environment tooling such as `pak`, `renv`, lockfiles, and project metadata rather than inventing a package manager.

Opening someone else's notebook should make it straightforward to understand and reproduce its required R/package environment.

### Quarto interoperability

Quarto remains the canonical publishing system for polished scientific documents.

Make it easy to move between notebook exploration and publication:

- render notebooks through Quarto where sensible;
- export or embed notebook results into Quarto;
- preserve citations, figures, tables, and computational outputs;
- make the notebook and Quarto complementary rather than competing formats.

### AI and agent-native design

Treat coding agents as first-class clients.

Agents should be able to:

- inspect notebook structure;
- read individual cells;
- understand the dependency graph;
- inspect variables and metadata without dumping enormous objects blindly;
- inspect errors and execution state;
- edit/create/delete/reorder cells;
- execute targeted portions of the notebook;
- obtain structured representations of tables, plots, and outputs;
- query diagnostics;
- reason about stale/downstream cells.

Expose these capabilities through a stable programmatic interface, ideally including MCP.

The underlying file format should also remain straightforward enough that general coding agents can work with notebooks directly in a repository.

### Scientific workflow features

The product should work particularly well for real exploratory scientific analysis, including large datasets and expensive computations.

Support:

- long-running cells;
- progress reporting;
- cached computations;
- lazy reruns;
- reproducible random seeds/workflows;
- variable/object explorer;
- memory-awareness;
- useful handling of large objects;
- background-independent deterministic state;
- connection/database objects where practical;
- SQL cells or equivalent database workflows where useful.

### Notebook navigation and organization

Large notebooks should remain manageable.

Provide:

- headings and Markdown;
- outline/navigation;
- collapsible sections;
- cell names;
- search;
- dependency visualization;
- easy navigation to definitions and dependents;
- clear stale/running/error states;
- optional hiding/collapsing of implementation-heavy cells.

### Compatibility

Import existing `.ipynb`/R notebooks where practical and provide sensible export paths, but do not constrain the internal design around Jupyter compatibility.

The product should be able to coexist with RStudio, Positron, VS Code, Quarto, and ordinary command-line R workflows.

## Design standard

The target is **not** “a working R notebook.”

The target is:

> **If marimo had originated in the R ecosystem today, what would the best version of it look like?**

Optimize for that product.

Study marimo closely for behaviors worth reproducing, but feel free to improve on them where R's language semantics or ecosystem allow something better.

Keep the implementation modular enough that parsing/static analysis, dependency management, execution, rich rendering, persistence, editor integration, and frontend UI can evolve independently.

Favor correctness, clarity, responsiveness, and excellent R ergonomics over preserving compatibility with historical notebook conventions.
