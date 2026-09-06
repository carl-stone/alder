# alder

Alder is a reactive notebook for R. Notebooks are ordinary `.R` files split
into `# %%` cells, executed in dependency order in a dedicated R process and
presented in a local web editor or output-only app. Requires R 4.6.0 or newer.

## Install and launch

From a clone of this repository:

```r
install.packages("pak")
pak::local_install(".")
alder::alder_install_cli("~/.local/bin")
```

Add that directory to PATH as instructed by the installer. The command works
on Unix and Windows (`alder.cmd`). To try the included base-R tutorial:

```r
file.copy(system.file("examples", "iris.R", package = "alder"), "iris.R")
```

```sh
alder iris.R
```

The browser opens automatically. A new `.R` path opens an empty notebook;
its parent directory must exist, and the file is created on the first Save.
Ctrl-C in the terminal or Shutdown in the editor stops the server and worker.
After a browser has connected, 30 seconds without state polls triggers idle
shutdown. Acknowledged edits are saved first; a save conflict or failure pauses
shutdown and preserves the session.

```sh
alder analysis.R --no-open --port 8080
alder analysis.R --lazy --no-run
alder analysis.R --no-idle-timeout
alder --help
```

For programmatic use:

```r
srv <- alder::start_alder("analysis.R", open = TRUE)
alder::stop_alder(srv)
```

The R API enables idle shutdown only when `idle_timeout` is set. Add
`?view=app` to the browser URL to show outputs and widgets without the editor.

## Write a notebook

```r
# %%
library(alder)

# %%
cutoff <- ui$slider(1, 5, value = 3, label = "Minimum sepal width")
cutoff

# %%
filtered <- subset(iris, Sepal.Width >= cutoff$value)
summary(filtered)
```

Save as `analysis.R` and open with `alder analysis.R`. It also runs with
`Rscript analysis.R`. Load every package explicitly and read widget values
through `$value`. Use `# %% [markdown]` for Markdown cells, with their text
written as R comments; `#| key: value` lines supply cell options.

- Editing marks affected results stale. Source edits alone never execute code.
- Run executes stale dependencies, the requested cell, then its descendants.
  Lazy mode leaves descendants stale until requested.
- Widget changes rerun consumers in automatic mode and app view; in lazy
  editor mode they mark consumers stale. The widget's defining cell stays put.
- Top-level definitions must be unique; dependency cycles block execution.
  Dot-prefixed names defined in a cell are private to that cell.
- `#| disabled: true` excludes a cell and its descendants from execution.
- Old outputs stay visible with a stale label. Inspection requires current
  values. Restart R replaces the worker and invalidates its values.

Literal metaprogramming such as `eval(quote(...))` and `assign("name", value)`
is supported in the default environment. `source("file.R", local = TRUE)`
acts as a conservative ordering barrier; changes to that file require an
explicit rerun. Dynamic lookup or mutation that cannot be bounded statically
produces a diagnostic before execution.

## Editor and outputs

R completion, signature help and hover documentation use the required
`languageserver` dependency. F1 opens help for the symbol at the cursor;
Escape returns to code. Ctrl-F (Cmd-F on macOS) searches the cell, and
Ctrl-click (Cmd-click) on a reactive reference jumps to its definition.
Optional lint diagnostics use the notebook project's `.lintr` settings and
are off by default. Formatting requires `styler`.

`ui` supplies inputs, buttons, tables, forms and composite controls. `out`
supplies Markdown, media, layouts, lazy output, inspection and progress.
Base graphics, ggplot2, HTML widgets, tables, model summaries, messages and
warnings have native renderers. Install optional packages as needed; the
[demo](demo.R) uses ggplot2. Use ordinary DBI or dbplyr calls for database work.
See `?alder::ui`, `?alder::out` and `?alder::cache` for API details.

## Projects and publishing

The Packages panel records declarations in `.alder/packages.yaml`; installed
packages become available after the worker restarts. Standard renv environments
are available through:

```r
alder::alder_env("snapshot", "analysis.R", packages = c("ggplot2", "dplyr"))
alder::alder_env("status", "analysis.R")
alder::alder_env("restore", "analysis.R")
```

`--sandbox` restricts notebook package lookup to the restored renv library plus
base/recommended R packages. This is dependency isolation; notebook code still
has the user's filesystem, process and network permissions.

```sh
alder render analysis.R --engine quarto --output report-quarto.html
alder render analysis.R --engine pandoc --output report-pandoc.html --no-code
```

Install the selected external renderer. Quarto executes native knitr chunks;
Pandoc converts Alder's evaluated outputs. Both execute enabled cells once in
dependency order and present results in notebook order. Rendered HTML is static.

Other entry points have installed R help:

| API | Purpose |
| --- | --- |
| `alder_check()` | Static diagnostics |
| `alder_source()` | Headless execution in dependency order |
| `alder_test()` | Run setup and `#| test: true` cells |
| `alder_export()` | HTML, Markdown, R script, ipynb, qmd or session export |
| `alder_convert()` | Import ipynb, R Markdown or Quarto |
| `alder_config()` | Layered settings |
| `alder_mcp()` | Notebook operations over stdin/stdout MCP |

Saves preserve source bytes and detect external edits. Export and render stage
results before replacing destinations and reject aliases of the input file.
The server binds only to loopback; origin controls are not authentication.
Alder executes trusted R code. Reference-object mutations and external side
effects cannot be rolled back.

Development commands are in [dev/README.md](dev/README.md), planned work in
[dev/ARCHITECTURE.md](dev/ARCHITECTURE.md), and release changes in [NEWS.md](NEWS.md).
