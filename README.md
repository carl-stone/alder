# alder

Alder is a reactive notebook for R. Notebooks are ordinary `.R` files split
into `# %%` cells. The application host owns persistence, dependency execution,
rendering, package operations, publishing, and the browser; the installed R
package supplies notebook values and ordinary `Rscript` helpers.

## Mac testing build

These are private-use development builds, not signed/notarized releases. The
Mac testing workflow checks a relocated copy of the exact app ZIP before making
its testing kit available. Full release qualification and other platforms are
not prerequisites for this testing milestone.

1. Download the `alder-mac-testing-arm64-<commit>` artifact for an Apple Silicon
   Mac (M-series), or `alder-mac-testing-x64-<commit>` for an Intel Mac, from the
   linked GitHub Actions run. Unzip the downloaded testing kit.
2. In Terminal, change to that folder and run `shasum -a 256 -c SHA256SUMS`.
   Then unzip the inner `Alder-0.1.0-…zip` and move `Alder.app` to Applications.
3. Install **R 4.6.1** for the same architecture from
   [CRAN](https://cran.r-project.org/bin/macosx/). The app also qualifies R 4.6.0;
   other R versions are not accepted by this build. Node, Ark, Air, and Alder's
   R helpers are bundled; do not install the source checkout to use the app.
4. Open Alder. If macOS blocks this development app, use **System Settings →
   Privacy & Security → Open Anyway** for this specific app after checking its
   source and checksum. Do not disable Gatekeeper globally.
5. Choose **Alder → Select R…** and select the installed `Rscript` executable.
   In the file dialog, Command-Shift-G can open
   `/Library/Frameworks/R.framework/Resources/bin`. This selection is saved.
6. Copy the included `iris.R` to a working folder, open it with **File → Open…**,
   and choose **Run → Run All**. Move the slider, inspect the table and plot,
   edit a cell, save, quit, and reopen. Start with copies of your real notebooks.

If launch fails, quit Alder and capture a Terminal launch (adjust the R path if
needed):

```sh
/Applications/Alder.app/Contents/MacOS/Alder \
  --rscript /Library/Frameworks/R.framework/Resources/bin/Rscript \
  > "$HOME/Desktop/alder-launch.log" 2>&1
```

For bug reports, include `BUILD.txt`, macOS version, Mac architecture, R version,
reproduction steps, expected versus actual behavior, and a screenshot or relevant
log excerpt. Review logs and notebooks for private data before sharing. Known
limitations: development-app approval is manual, latency remains above the
architecture targets, and this build has not passed full release qualification.
Publishing additionally requires Quarto; extra notebook packages belong to the
project's R environment.

To produce a replacement kit from a reviewed commit:

```sh
gh workflow run host.yaml --ref <branch> -f mac-testing=true
```

Keep the previous ZIP for rollback. Quit Alder before replacing the app; keep
notebooks outside the application bundle. Testing artifacts expire after 30 days.

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
