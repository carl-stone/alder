# alder

Alder is a reactive notebook for R. Notebooks are ordinary `.R` files split
into `# %%` cells. The application host owns persistence, dependency execution,
rendering, package operations, publishing, and the browser; the installed R
package supplies notebook values and ordinary `Rscript` helpers.

## Mac development and reset

Alder is a pre-release application undergoing an architectural reset. The current
code and local builds are starting points, not acceptance of the redesigned app.
The [product requirements and working design](dev/ARCHITECTURE.md) describe the
reset; [dev/LEAD.md](dev/LEAD.md) records coordination and accepted progress.

Builds and checks run locally. Mac is the only active platform during the reset;
Linux and Windows support will be rebuilt and qualified separately later.
Follow [dev/README.md](dev/README.md) for native Mac development. The current
development stage uses R 4.6.1 with
the same architecture as the Mac. Public signing and notarization remain separate
from local development.

The existing app exposes **Open notebook…** for selecting a notebook and searches
a saved R choice, `PATH`, then the standard macOS R framework installation.
Use [the Iris example](inst/examples/iris.R) to exercise ordinary notebook behavior.

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

## Application development

The implementation includes the editor and output view, saving, HTML publishing,
language assistance, package operations and MCP access. The reset preserves useful
notebook functionality while simplifying the surrounding ownership and lifecycle.

The current development tools include Node, Ark, Air, Electron and a native process
supervisor. Commands and current staging prerequisites are maintained in
[dev/README.md](dev/README.md). Application builds and the standalone R helper
package are separate.

The [demo](demo.R) and [Iris example](inst/examples/iris.R) are useful starting points
for acceptance notebooks. Historical changes are recorded in [NEWS.md](NEWS.md).
