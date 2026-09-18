# Development

[ARCHITECTURE.md](ARCHITECTURE.md) describes the reset direction;
[LEAD.md](LEAD.md) records the current assignment and accepted progress.
Mac is the active platform. Builds, tests and app interaction checks run natively.

## Build and open the Mac app

From the repository root:

```sh
npm ci --prefix host
export PATH="$PWD/host/node_modules/node/bin:$PATH"
npm ci --prefix js
npm ci --prefix desktop
npm run build:mac --prefix desktop
open "$PWD/host/.application-desktop/Alder.app"
```

This builds the editor, shared backend and Electron shell, stages their runtime
files and license notices, and signs the local app. Node is installed through the
host npm lockfile. The local signature does not provide public notarization.

Open, edit, Save, Save As and recovery work independently of an R installation.
The document checkpoint does not bundle an execution runtime; stock Ark and R
integration is the next execution slice. The app retains source editing when R
startup fails. Open a notebook from File > Open or the **Open notebook…** button.

All attached desktop and agent clients use the same local backend. Closing a
window releases that window's connection; other clients keep their documents
alive. Unsaved documents are recovered separately from the saved `.R` file.

## Focused checks

Choose the tests relevant to the changed behavior:

```sh
npm run check --prefix host
npm run typecheck --prefix desktop
(cd host && node --import tsx --test test/persistence.test.ts test/document-foundation.test.ts test/desktop-recovery.test.ts test/shared-backend.test.ts test/desktop-main.test.ts)
```

Verify native typing, File menus, replacement confirmation, Cancel during close,
reopening and crash recovery in the staged Mac application. Automated tests
complement those interactions. Runtime-dependent tests need their own R setup.

After editing `js/src/editor.ts`, rebuild with `npm run build --prefix js`.
After changing host or browser source, rebuild with `npm run build --prefix host`.
The Mac build command does both and replaces the staged app; quit that app first.

## R helper development

R help and exports are generated from comments in `R/`:

```sh
Rscript -e 'roxygen2::roxygenise()'
Rscript -e 'testthat::test_local(stop_on_failure = TRUE)'
```

Use a private test library when testing a modified helper package so the tests
exercise that package. Helper installation is separate from the document app.

## Example notebooks

- [Iris](../inst/examples/iris.R): base-R example.
- [Demo](../demo.R): small ggplot2 notebook.
- [Output parity](parity-demo.R): scientific output and interaction fixture.
- [Bulk differential expression](examples/bulk-differential-expression.R):
  simulated data with edgeR, statmod and ggplot2.

Keep notebooks runnable as ordinary R scripts.
