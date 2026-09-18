# Development

[ARCHITECTURE.md](ARCHITECTURE.md) is the accepted reset direction.
[LEAD.md](LEAD.md) records the active assignment and accepted progress.
These commands describe the current implementation and must be updated by the
implementation task as it replaces that implementation. Mac is the only active
platform. GitHub Actions are disabled; verification runs locally. The reset
deletes obsolete CI and platform tooling instead of maintaining inactive gates.

## Execution environments

Edit files and use Git on the host. Native Mac builds, staging, signing, app
launches and interaction checks run on macOS. Linux and Windows code and tooling
are authorized for deletion; their future qualification is separate from this
Mac reset. Keep the useful local checks small and tied to application behavior.

The lead task may edit documentation and run read-only or documentation checks.
Application builds, tests, installs and runs belong to the implementation task
unless Carl directly assigns that work to the lead.

## Mac build and focused checks

The current checkout pins its tools in the npm, Ark, native-runtime and R library
locks. It currently uses Node 24.20.0 and R 4.6.1 of matching architecture.
These are current build inputs; runtime compatibility is part of the reset.

Run from the repository root with an existing npm installation:

```sh
npm ci --prefix host
export PATH="$PWD/host/node_modules/node/bin:$PATH"
npm ci --prefix js
npm ci --prefix desktop
npm run build --prefix js
npm run build --prefix host
npm run build --prefix desktop
```

For focused source checks, choose the affected test files:

```sh
npm run check --prefix host
npm run typecheck --prefix desktop
(cd host && node --import tsx --test test/persistence.test.ts test/desktop-main.test.ts)
```

`npm test --prefix host` runs the host source suite. Installed-runtime and browser
cases have additional prerequisites; inspect the relevant test setup before using
them as acceptance. Source tests and the lifecycle driver complement actual
typing, menus, file dialogs, interruption and recovery checks in the built Mac app.

## Local arm64 Mac application

The following is the existing staging recipe, not a claim that a fresh checkout
has been rebuilt or the reset accepted. Build the host and Forge shell first.
It also requires native Ark, Air, and supervisor artifacts and their current
metadata at the paths below. The implementation task must make acquisition and
building of these inputs repeatable as part of the first slice.

Run from the repository root on macOS with physical absolute paths.
The two staging passes are intentional: the first pass prepares the bundle for
signing, and the second records the signed nested code in the manifest.

```sh
rscript=/Library/Frameworks/R.framework/Versions/4.6/Resources/bin/Rscript
node24=$PWD/host/node_modules/node/bin/node
forge=$PWD/desktop/out/Alder-darwin-arm64/Alder.app/Contents
supervisor=$PWD/host/.runtime/supervisor-build/release/alder-process-supervisor
supervisor_provenance=$PWD/host/.runtime/supervisor-provenance.json
output=$(mktemp -d "$PWD/host/.application-mac-XXXXXX")
evidence=$(mktemp -d /tmp/alder-mac-evidence-XXXXXX)
stage() {
  "$node24" host/scripts/stage-application.mjs \
    --output "$output" --kind desktop --prepare-macos-signing \
    --rscript "$rscript" --development-single-r \
    --ark "$PWD/host/.runtime/ark" --air "$PWD/host/.runtime/air" \
    --supervisor "$supervisor" \
    --supervisor-provenance "$supervisor_provenance" \
    --forge-output "$forge" --electron-entry "$forge/MacOS/Alder"
}
stage
codesign --force --deep --sign - "$output/Alder.app"
stage
codesign --force --sign - "$output/Alder.app"
codesign --verify --deep --strict --verbose=2 "$output/Alder.app"

"$node24" host/scripts/smoke-application.mjs "$output" \
  --scenario desktop-lifecycle --evidence "$evidence" \
  --rscript "$rscript"
open -a "$output/Alder.app"
```

The Open notebook… control is visible in the top bar. Use it to select
`inst/examples/iris.R` or another `.R` notebook.
Finder and Spotlight launches do not inherit the Terminal `PATH`. Alder uses a
saved R choice, then `PATH`, then the standard macOS R framework location.

Earlier local builds were installed at `~/Applications/Alder.app`. This recipe
opens its new staged build directly. Install the accepted build there after native
checks, preserving the previous build until the replacement works. An ad hoc
signature is for local development; it is not Developer ID signing or notarization.
The existing release packager rejects `development-single-r` manifests. That is
current tooling behavior, not a new requirement for the reset.

## R helper development

R help and exports are generated from comments in `R/`:

```sh
Rscript -e 'roxygen2::roxygenise()'
Rscript -e 'testthat::test_local(stop_on_failure = TRUE)'
```

Tests and installed-runtime checks need the matching helper version. Use a
private test library where needed to avoid testing an unrelated installation.
The application stage restores `host/r-library.lock.json`; installing all package
Suggests is a separate R helper development operation.

## Packaging and performance

The existing scripts are `host/scripts/stage-application.mjs`,
`host/scripts/package.mjs`, `host/scripts/ci-package.mjs` and
`host/scripts/smoke-release.mjs`. They still enforce parts of the superseded
release plan, including dual-R and exhaustive inventory requirements. The
implementation task should simplify them at the owning slice. Removing those
requirements from the design does not make existing scripts stop enforcing them.

For the current Mac signing flow, sign nested code, refresh the staging manifest
with the same stage command, and then sign the outer bundle without recursively
changing nested code again. Public signing and notarization are separate from
local development and will need Carl's distribution decision when relevant.

[reviews/INPUT-LATENCY.md](reviews/INPUT-LATENCY.md) describes the existing
measurement tools. Historical results are not current acceptance; measure the
actual Mac interactions affected by a change and keep generated evidence local.

## Example notebooks

- [Iris](../inst/examples/iris.R): installed base-R example.
- [Demo](../demo.R): small ggplot2 notebook.
- [Output parity](parity-demo.R): scientific output and interaction fixture.
- [Bulk differential expression](examples/bulk-differential-expression.R):
  simulated data with edgeR, statmod and ggplot2.

Use these as starting material for representative acceptance examples, with
expected behavior established independently of the implementation.
