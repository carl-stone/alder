# alder

Alder is a reactive notebook for R. Notebooks are ordinary `.R` files split
into `# %%` cells. The application host owns persistence, dependency execution,
rendering, package operations, publishing, and the browser; the installed R
package supplies notebook values and ordinary `Rscript` helpers.

## Mac development and testing

GitHub Actions are disabled: builds and verification run locally. Pull `main`
on the Mac and follow the development commands in [dev/README.md](dev/README.md).
Native Mac packaging and the notebook launch/edit/save/reopen loop still need
verification on that machine; there is no verified downloadable Mac testing kit.

Use R 4.6.1 with the same architecture as the Mac. Packaged application
qualification also requires an independent R 4.6.0 installation. Keep real
notebooks outside the app bundle and test with copies. The runnable example is
`inst/examples/iris.R`.

Builds are development builds, not signed/notarized releases. Latency remains
above the architecture targets, and full release qualification is unfinished.
When reporting a problem, include the commit, macOS version, architecture, R
version, reproduction steps, and relevant logs or screenshots. Review these
for private data before sharing.

## Install the R helpers

From a clone of this repository:

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
The host keeps source bytes and analysis diagnostics separate from captured
outputs. Explicit runs execute stale dependencies in dependency order; lazy
runs leave descendants stale until requested. Widget changes are explicit
reactive inputs, and dynamic R lookup that cannot be bounded statically is
reported before execution.

## Host development

The host requires Node.js 24, Ark, and explicit compatible R 4.6.x interpreters.
From this checkout, using absolute interpreter paths:

```sh
rscript461=/absolute/path/to/R-4.6.1/bin/Rscript
rscript460=/absolute/path/to/R-4.6.0/bin/Rscript
npm ci --prefix host
npm run check --prefix host
npm run build --prefix host
npm run stage --prefix host -- --rscript "$rscript461" --qualified-rscript "$rscript460"
npm run smoke --prefix host -- --scenario all --evidence /tmp/alder-evidence \
  --rscript "$rscript461" --peer-rscript "$rscript460"
```

The host provides the local editor and output view, Save and Save As, one HTML
Publish action, R language-server assistance, package inspection/install jobs,
and MCP transports. Publishing consumes a frozen captured snapshot, never
executes notebook code or overwrites an existing destination, and produces an
offline HTML document.

Optional notebook packages such as ggplot2, HTML widgets, and database clients
come from the selected project environment. The [demo](demo.R) shows a small
plotting notebook; `inst/examples/iris.R` is an ordinary runnable example.

Development commands are in [dev/README.md](dev/README.md), architecture notes
in [dev/ARCHITECTURE.md](dev/ARCHITECTURE.md), and release changes in
[NEWS.md](NEWS.md).
