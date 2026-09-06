# alder

Alder is a reactive notebook built for R. It keeps notebooks as ordinary
plain-text `.R` files, analyzes `# %%` cells into a dependency graph, executes
them in dependency order in a dedicated R process, and presents the results in
a local web editor or output-only app.

Alder requires R 4.6.0 or newer. Local release validation uses Linux with
R 4.6.1; repository CI also covers R-devel and Windows launcher/MCP checks.

## Install

From a clone of this repository, install Alder and all required imports from
the package metadata:

```r
install.packages("pak")
pak::local_install(".")
```

Or use base R package tooling after resolving `DESCRIPTION` dependencies:

```sh
R CMD INSTALL .
```

Scientific and development integrations are optional. Install only those used
by your notebooks or workflow:

```r
pak::pkg_install(c(
  "ggplot2", "htmlwidgets", "DBI",           # notebook outputs and data access
  "renv", "pak",                              # project environments
  "styler",                                    # optional code formatting
  "testthat", "chromote", "lintr"             # package development
))
```

The [repository demo notebook](https://github.com/carl-stone/alder/blob/main/demo.R)
uses ggplot2, so install it before running that notebook.
R completion and argument help are installed with Alder through its required
`languageserver` dependency. Continuous lintr notes are off by default and can
be enabled explicitly in Settings; Alder's own parse and safety diagnostics
remain visible. Linting uses the notebook's native file path and the project's
`.lintr` settings. Diagnostics that cannot be located within one cell appear
above the notebook as editor diagnostics, including failures inside lintr.
Their error, warning, or information level is retained without blocking
notebook execution. After editing, existing lint notes clear while fresh results
are pending. Switching lint off clears its notes.
Formatting remains an optional styler integration.

Hover over an R symbol for its documentation, or place the cursor on it and
press F1 to open and focus the help panel. Long help pages scroll within the
panel; Escape or Close returns focus to your code. Use Ctrl-F (Cmd-F on macOS)
to search the current cell. Ctrl-click (Cmd-click on macOS) a reactive reference
to jump to the cell that defines it; the Dataflow panel also links variables,
references, and descendants to their cells.

A fully clean source installation must compile the language-server stack and
may resolve roughly 50 transitive packages; on a small Linux builder this can
take several minutes. This cost keeps completion and signature help available
in every supported installation. Prefer a trusted binary package repository
when one is available for your R version and platform.

Install the packaged command into a directory you choose (the default is
`~/.local/bin` on both Unix-like systems and Windows):

```r
alder::alder_install_cli("~/.local/bin")
```

The installer atomically stages the Unix `alder` script or Windows
`alder.cmd`, never replaces an existing command unless `overwrite = TRUE`, and
prints a PATH instruction when the selected directory is not already available
to the shell. With that directory on PATH, invoke the command as `alder` on
either platform.

## First notebook

An interactive Iris notebook is included with the installed package. Copy it
into your working directory from R:

```r
file.copy(system.file("examples", "iris.R", package = "alder"), "iris.R")
```

Then run `alder iris.R` in your terminal. Change the slider to update the table,
base graphics plot, and fitted model. This example uses only Alder and base R.
The [release notes](NEWS.md) describe the first release's capabilities.

An Alder notebook remains valid R source:

```r
# %%
library(alder)
library(ggplot2)

# %%
cutoff <- ui$slider(1, 5, value = 3, label = "Minimum sepal width")
cutoff

# %%
filtered <- subset(iris, Sepal.Width >= cutoff$value)

# %%
ggplot(filtered, aes(Sepal.Length, Petal.Length, colour = Species)) +
  geom_point()
```

Save it as `analysis.R`, then launch the editor, server, and R worker with one
shell command:

```sh
alder analysis.R
```

The browser opens by default. `alder edit analysis.R` is an equivalent explicit
editor form. The command owns the complete process lifecycle, so no interactive
R process needs to remain open. Press Ctrl-C in the launching terminal or use
the editor's Shutdown action to stop the server and worker. After a browser has
connected, Alder also stops automatically after 30 seconds without state polls.
Before an idle shutdown, Alder atomically saves any server-acknowledged edits.
If that save conflicts or fails, shutdown is paused, the process remains
available, and the failure is shown when the browser reconnects.

To create a notebook, pass a new `.R` path whose parent directory already
exists:

```sh
alder new-analysis.R
```

Alder announces that this is a new notebook and serves an empty editor. It does
not create the file until the first successful Save, so leaving an unchanged
new session does not leave an empty file behind. If another process creates the
path first, the normal save-conflict protection preserves that external file.
Rendering remains stricter: `alder render` requires an existing notebook.

Useful launch controls include:

```sh
alder analysis.R --no-open --port 8080
alder analysis.R --lazy --no-run
alder analysis.R --sandbox
alder analysis.R --idle-timeout 120
alder analysis.R --no-idle-timeout
```

`--host` accepts only the loopback addresses `127.0.0.1`, `localhost`, and
`::1`. Any non-loopback bind is rejected until Alder has a real authentication
design. `--allowed-origin` is an exact browser-origin control, not
authentication, and must not be used to share Alder over a network. Run
`alder --help` for the complete usage and `alder --version` for the installed
package version.

Rendering is also available without an interactive R process:

```sh
alder render analysis.R --engine quarto --output report-quarto.html
alder render analysis.R --engine pandoc --output report-pandoc.html --no-code
```

Both engines execute enabled cells once in dependency order and present results
in notebook order. Disabled cells and their dependent cells do not execute.
Quarto uses native knitr chunks; Pandoc converts the results evaluated by Alder.

The programmatic R lifecycle remains available when embedding Alder:

```r
srv <- alder::start_alder("analysis.R", open = TRUE)
alder::stop_alder(srv)
alder::stop_alder(srv) # safely idempotent
```

The R API leaves browser-idle shutdown disabled unless `idle_timeout` is set.
Add `?view=app` to the URL for an output-and-widget app without editor controls.
`Rscript analysis.R` still runs as ordinary R.

## Reactive model

- Running a cell executes stale dependencies before it. In automatic mode,
  descendants then rerun in dependency order; lazy mode leaves descendants
  visibly stale until requested.
- Top-level definitions must be unique, and dependency cycles are rejected.
  Function-local names, formulas, namespaces, data masks, pipes, S3/S4 objects,
  and ordinary modern R syntax are analyzed with R-specific rules.
- Literal default-environment `eval(quote(...))` is analyzed normally.
  `assign("name", value)` and `rm("name")` (or bare-name `rm(name)`) are
  analyzed as definitions/removals when they use the default evaluation
  environment.
  `source("literal-file.R", local = TRUE)` is permitted and conservatively
  ordered as an opaque cell. Computed environment mutation or lookup that cannot
  be bounded safely receives a precise diagnostic before execution.
- Messages and warnings remain visible. Errors include the condition class,
  failing call, and a bounded traceback. A lost worker marks all outputs stale;
  **Restart R** creates a fresh process and replays the notebook.
  If that restart fails, prior outputs remain visible as stale and old inspected
  values are cleared. You can still edit and save the notebook before retrying.
- A cell marked `#| disabled: true` and every transitive descendant are excluded
  consistently from interactive runs, `alder_source()`, and `alder_test()`;
  independent runnable cells still execute in dependency order.
- Source edits never execute code by themselves. Run, a widget interaction, or
  startup configuration is the explicit change boundary.

## Widgets, output, and data

`ui` provides sliders, ranges, dropdowns, multiselects, text/code inputs,
numbers, checkboxes, switches, dates, files, buttons, refresh controls, tables,
data-frame transforms, forms, and arrays. A widget is an ordinary R object; read
its current value explicitly through `$value`. Datetime widgets represent UTC
instants at whole-second precision; the editor labels the timezone and keeps
their JSON values unambiguous across browsers and machines.

`out` provides Markdown, HTML, image/audio/video/PDF media, callouts, stacks,
tabs, accordions, sidebars, progress, appended output, lazy output, bounded
inspection, and early cell stop. Base graphics, recorded plots, ggplot2,
htmlwidgets, messages, warnings, model output, and bounded tabular previews have
native renderers. Bare named widgets remain fully reactive when placed inside
any layout or a resolved lazy output, including one-shot button reset and
repeat use. Layouts and appended outputs retain native plot, HTML widget,
table, and model rendering; scalar text stays readable, and `out$inspect()`
explicitly displays an object's internal structure.
Notebook code can use ordinary DBI connections directly; optional
dependency failures include installation advice.

## Reproducible projects

The Packages panel records project declarations in
`.alder/packages.yaml` and installs without blocking the editor. Packages
installed there are available after the worker restarts.

`alder_env()` integrates with ordinary renv paths and a project-level
`renv.lock`:

```r
alder::alder_env("snapshot", "analysis.R",
                 packages = c("ggplot2", "dplyr"))
alder::alder_env("status", "analysis.R")
alder::alder_env("restore", "analysis.R")
```

For a worker whose notebook package lookup is restricted to that restored
project library plus base/recommended R packages:

```r
srv <- alder::start_alder("analysis.R", sandbox = TRUE)
```

This is dependency isolation, not a security boundary. Notebook code is trusted
R code and can access the process, filesystem, and network with the user's
permissions.

`cache$memory()` and `cache$disk()` include function code, arguments, and
serializable captured dependencies in cache identity. Reference-like captured
state is recomputed rather than reused unsafely; corrupt disk entries are
discarded and replaced atomically.

## Noninteractive and interoperability tools

| Function | Purpose |
|---|---|
| `alder_cli()`, `alder_install_cli()` | Run or install the one-command shell lifecycle |
| `start_alder()`, `stop_alder()` | Start and stop the editor/app server and worker |
| `ui`, `out`, `cache` | Interactive inputs, rich output, and safe computation caching |
| `alder_config()` | Resolve built-in, user, project, notebook, and environment configuration |
| `alder_check()` | Print static diagnostics and fail on blocking errors |
| `alder_source()` | Execute enabled cells headlessly in dependency order |
| `alder_test()` | Run setup and marked `#| test: true` cells exactly once in dependency order |
| `alder_export()` | Export HTML, Markdown, R script, ipynb, qmd, or session data |
| `alder_render()` | Render through an explicit Quarto or Pandoc engine |
| `alder_convert()` | Convert ipynb, R Markdown, or Quarto input to an Alder `.R` notebook |
| `alder_env()` | Inspect, snapshot, and restore a standard renv environment |
| `alder_mcp()` | Serve the same notebook model over bounded, duplicate-safe JSON-RPC stdin/stdout |

Examples:

```r
alder::alder_check("analysis.R")
env <- alder::alder_source("analysis.R")
alder::alder_export("analysis.R", "html")
alder::alder_convert("report.qmd")
alder::alder_test("analysis.R")
alder::alder_render("analysis.R", engine = "quarto")
alder::alder_render("analysis.R", engine = "pandoc")
```

## File and safety guarantees

- Notebook parsing and saving preserve source bytes and cell boundaries; saves
  use an atomic same-directory replacement and detect external-file conflicts.
- Value inspection requires a current defining cell. After an edit, failure, or
  disable action, HTTP and MCP return `stale_value` until the cell and its
  dependencies rerun. Pending and previous inspector results are invalidated;
  retained notebook outputs keep their visible stale state.
- Export, conversion, and rendering reject direct, canonical, symlink, and
  hard-link output aliases of their input before execution. Headless export and
  rendering also reject blocking syntax, duplicate-definition, dependency-cycle,
  and dynamic-analysis diagnostics before user code or an external renderer can
  run. Runtime failures also preserve export destinations and return cell logs
  and condition details. HTML and Markdown retain console output, conditions,
  and appended results in execution order; session JSON keeps structured logs.
  Results are staged beside the destination and replace it only after complete
  execution, serialization, and validation.
- The web boundary is loopback-only and enforces exact origin checks, content
  security policy, bounded JSON, safe artifact paths, and upload limits. Client
  log reports are schema-validated, bounded, and normalized to one physical
  server-log record.
- Stdio MCP accepts one UTF-8 JSON object per line up to 16 MiB and rejects
  malformed, structurally excessive, or duplicate-key messages before dispatch;
  rejected frames cannot select a conflicting tool/revision or mutate state.
  MCP requests use exact scalar string or safe-integer IDs and named parameter
  objects; initialization validates its required negotiation fields. Normal
  operations are unavailable until the client follows the initialize response
  with `notifications/initialized`; before then, only ping may execute.
  Local MCP resolves runtime metadata and layered configuration identically to
  the web server, and defers any configured startup run until that lifecycle
  handshake is complete.
  Invalid IDs/params are rejected before effects. Notifications never produce
  a response, and invalid or out-of-phase notifications are effect-free.
  Tool calls require a known, nonempty name and object-valued arguments;
  malformed calls fail at the JSON-RPC boundary before tool execution.
  Value inspection rejects stale bindings until their defining cells rerun;
  historical cell outputs remain visibly marked stale.
- One serial R worker owns notebook state. Stop interrupts only the active
  request; server shutdown waits for the worker to exit.
- R reference objects and external side effects are not transactional. Alder
  exposes this limitation rather than claiming rollback it cannot guarantee.

## Development

Repository navigation is in the
[developer guide](https://github.com/carl-stone/alder/blob/main/dev/README.md),
and accepted architecture decisions are in the
[decision index](https://github.com/carl-stone/alder/blob/main/dev/decisions/index.md).
The release gate includes JavaScript bundle reproducibility, lint, the complete
testthat/browser suite, source build, and `R CMD check`; CI also installs and
exercises the packaged command on Windows R 4.6.1. In a repository source checkout,
`USER_FLOWS.md` and `NORTH_STAR_RUBRIC.md` define the observable
acceptance criteria; they are release-review inputs rather than installed
package documentation.
