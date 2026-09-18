# alder

Alder is a reactive notebook for R. Notebooks are ordinary `.R` files split
into `# %%` cells. The application host owns persistence, dependency execution,
rendering, package operations, publishing, and the browser; the installed R
package supplies notebook values and ordinary `Rscript` helpers.

## Current Mac development

Alder is pre-release software undergoing a redesign of its internal architecture.
The accepted Mac build currently supports opening, editing, saving and recovering
notebooks without R. R execution and the related scientific workflows are being
reintegrated; the [workboard](dev/WORKBOARD.md) records exactly what is accepted,
under review and queued.

The active app source is in the implementation worktree identified on that board.
Follow [dev/README.md](dev/README.md) to choose the checkout, build and launch it.
The [architecture](dev/ARCHITECTURE.md) describes the intended finished behavior;
it is not a statement that every feature is already available in the reset build.

Mac is the current delivery target. Linux, Windows and public distribution are
deferred. The document app uses Electron for its window and a shared Node backend
for desktop and agent clients. Open notebooks with File > Open or **Open notebook…**.

## Install the R helpers

The helper package can be used independently of the desktop app. Its R version
and dependency requirements are in [DESCRIPTION](DESCRIPTION). From a clone:

```r
install.packages("pak")
pak::local_install(".")
```

The public R surface is deliberately small:

```r
library(alder)

threshold <- ui$slider(1, 5, value = 3)
threshold$value

out$md("**raw Markdown**")
cache$memory(function(x) x + 1)(41)
```

`ui` creates validated controls whose values are read explicitly through
`$value`. `out` creates raw rich-output records for text, Markdown, HTML,
media, tables, layouts, progress, lazy values, and inspection. `cache` provides
memory and disk-backed wrappers with dependency-aware invalidation and atomic
RDS replacement. These constructors also work in an ordinary `Rscript`
process. See `?ui`, `?out`, and `?cache` after installation.

## Notebook files

```r
# %%
library(alder)

# %%
cutoff <- ui$slider(1, 5, value = 3, label = "Minimum Sepal.Width")
cutoff

# %%
filtered <- subset(iris, Sepal.Width >= cutoff$value)
filtered
```

Use `# %% [markdown]` for Markdown cells and `#| key: value` for cell options.
The intended execution behavior is to run stale dependencies in dependency
order; lazy mode leaves descendants stale until requested. Widget changes are
reactive inputs, and unsupported dynamic dependencies produce a diagnostic.
These workflows and the R help describe the feature contracts being restored;
check the workboard for their implementation status.

## Contributing

Agents start with [AGENTS.md](AGENTS.md), which routes implementation, review and
coordination work to the relevant instructions. The [development guide](dev/README.md)
contains build commands and source/generated-file guidance. Application builds
and the standalone R helper package are separate.

The [demo](demo.R) and [Iris example](inst/examples/iris.R) provide ordinary R
workflows. [NEWS.md](NEWS.md) records earlier development features, not current
reset acceptance.
