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
See [tests/AGENTS.md](../tests/AGENTS.md) for test guidance and
[responsiveness guidance](reviews/INPUT-LATENCY.md) when performance is involved.

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
- [Output parity](parity-demo.R): scientific output and interaction fixture.
- [Ark execution examples](examples/ark-scalar-dependency.R): scalar dependencies,
  errors, plots, Stop and project packages in ordinary R scripts.
- [Bulk differential expression](examples/bulk-differential-expression.R):
  simulated data with edgeR, statmod and ggplot2.

These are candidate workflows, not claims that every feature is already accepted
in the reset. Keep them runnable as ordinary R scripts and establish expected
behavior independently of the implementation.
