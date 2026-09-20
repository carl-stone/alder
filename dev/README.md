# Development

[WORKBOARD.md](WORKBOARD.md) identifies the active implementation checkout and
latest accepted build. [ARCHITECTURE.md](ARCHITECTURE.md) describes the intended
product and design. An assignment is a bounded change ending in a runnable build.

## Choose the right checkout

During the reset, the lead's documentation checkout and the implementation
worktree contain different code. Use the implementation worktree listed on the
canonical workboard for app development and the commands below. The lead checkout
still contains older source; do not use its retired staging recipes as requirements.
Independent workers use the worktree assigned in their own brief.

## Build and open the Mac app

Run on macOS from the implementation checkout's repository root. Start with an
available npm installation; the host lockfile then supplies the pinned Node runtime.

```sh
npm ci --prefix host
export PATH="$PWD/host/node_modules/node/bin:$PATH"
npm ci --prefix js
npm ci --prefix desktop
npm run build:mac --prefix desktop
open "$PWD/host/.application-desktop/Alder.app"
```

The Mac command builds the editor, shared Node backend and Electron shell, stages
resources and license notices, and signs the local app. Quit the staged app before
rebuilding it. Local signing is separate from public notarization.

The app opens, edits, saves and recovers notebooks without R. With R 4.6.x
available, it runs cells through the unchanged, pinned Ark kernel and the Alder
R helper installed in the staged app. Open a notebook with File > Open or
**Open notebook…**.

## Final Mac acceptance

Run the bounded final acceptance from the repository root:

```sh
npm run accept:final --prefix host
```

This removes only Alder's generated staging directories, builds and signs a fresh
app, verifies its packaged tools and Ark behavior, runs the R, host, generative,
installed-runtime and production-browser suites serially where required, then
launches the packaged Electron binary without showing or activating its window.
The packaged-app journey edits real CodeMirror content, runs it through Ark,
saves it through the native command path, closes cleanly, and removes its
temporary profile. Each phase has a timeout and the command fails if a packaged
child process remains.

## Focused checks

Choose checks for the behavior being changed. For example:

```sh
npm run check --prefix host
npm run typecheck --prefix desktop
(cd host && node --import tsx --test test/persistence.test.ts test/desktop-main.test.ts)
```

`npm test --prefix host` runs the broader host suite. Runtime-dependent tests need
their R packages and external tools; report missing prerequisites separately from
behavior actually checked. A skipped execution test does not qualify R execution.
Verify actual Mac typing, menus, dialogs, save/reopen and recovery where relevant.
See [host/test/AGENTS.md](../host/test/AGENTS.md) for host, browser and desktop
tests, and [tests/AGENTS.md](../tests/AGENTS.md) for R helper tests.

The installed R semantics generator runs in final acceptance and can be replayed
against a staged application root. Its defaults are two fixed seeds with fourteen
cases each. `ALDER_R_SEMANTICS_SEED` accepts up to sixteen comma-separated
unsigned 32-bit integer seeds,
`ALDER_R_SEMANTICS_CASES` expands the corpus up to 256 cases per seed, and
`ALDER_R_SEMANTICS_CASE` replays one generated case by zero-based corpus index.
`ALDER_R_SEMANTICS_SHRINK_ATTEMPTS` bounds mismatch minimization (default 16).

```sh
(cd host && ALDER_APPLICATION_ROOT="$PWD/.application" \
  ALDER_RSCRIPT="$(which Rscript)" \
  node --import tsx --test --test-concurrency=1 test/generative-r-semantics.test.ts)
```

## Inspect local diagnostics

The installed `alder` command locates Alder's automatic local diagnostic store;
callers do not need to find or name JSONL segments. Every query is read-only and
prints one machine-readable JSON object. It works while Alder is running or after
the app and backend have stopped.

```sh
alder diagnostics status
alder diagnostics launches --limit 20
alder diagnostics errors --since 2026-09-19T00:00:00Z --limit 100
alder diagnostics operations --slow-ms 5000 --limit 100
alder diagnostics performance --since 2026-09-19T00:00:00Z
alder diagnostics incident --id OPERATION_OR_SESSION_ID --limit 500
alder diagnostics incident --since 2026-09-19T14:00:00Z --until 2026-09-19T14:05:00Z --limit 1000
```

`status` reports retained bytes, segment and active-writer counts, malformed
records, dropped records and writer health. `launches` returns app, backend, host,
session and window starts. `errors` returns raw error and fatal records.
`operations` reconstructs slow and incomplete work. `performance` summarizes
recorded durations and resource snapshots. `incident` returns the chronological
raw records in a time range or records containing an exact correlation identifier.
Local records contain full paths, source, output, environment, commands and raw
errors; a Help-menu raw copy is optional and contains the same uncensored data.
Queries inspect newest retained evidence first while returning selected records in
chronological order. Records larger than a normal JSONL segment are retained as
bounded raw sidecars and reconstructed transparently. Invalid time ranges and
query-specific flags fail with a JSON error and nonzero exit status.

## Generated files and R helpers

- After changing editor sources in `js/`, run `npm run build --prefix js`.
- After changing host/browser sources in `host/`, run `npm run build --prefix host`.
- Rebuild committed bundles from their sources. The Mac build does both steps.
- Widget constructors live in `R/ui-widgets.R`; the execution integration uses
  the installed Alder package. R help in `man/` and exports are generated from
  roxygen comments in `R/`.

For R helper development, use the R version and dependencies declared in
[DESCRIPTION](../DESCRIPTION). From the implementation checkout:

```sh
Rscript -e 'roxygen2::roxygenise()'
Rscript -e 'testthat::test_local(stop_on_failure = TRUE)'
```

Install development tools such as roxygen2 and testthat in the development
library when needed. Tests using an installed helper package must use the version
being edited; a private test library avoids picking up an unrelated installation.

## Example notebooks

- [Iris](../inst/examples/iris.R): base-R example.
- [Demo](../demo.R): small ggplot2 notebook.
- [Outputs and widgets](parity-demo.R): scientific output and interaction fixture.
- [Ark execution examples](examples/ark-scalar-dependency.R): scalar dependencies,
  errors, plots, Stop and project packages in ordinary R scripts.
- [Bulk differential expression](examples/bulk-differential-expression.R):
  simulated data with edgeR, statmod and ggplot2.

These are candidate workflows, not claims that every feature is already accepted
in the reset. Keep them runnable as ordinary R scripts and establish expected
behavior independently of the implementation.
