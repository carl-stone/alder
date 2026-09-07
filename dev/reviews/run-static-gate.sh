#!/usr/bin/env bash
set -euo pipefail

required_r_version=4.6.1
actual_r_version=$(Rscript --vanilla -e 'cat(as.character(getRversion()))')
printf 'R %s\n' "$actual_r_version"
if [[ "$actual_r_version" != "$required_r_version" ]]; then
  printf 'expected R %s, received R %s\n' \
    "$required_r_version" "$actual_r_version" >&2
  exit 1
fi

node --version
npm --version
quarto --version
pandoc --version | sed -n '1p'
google-chrome --version
shellcheck --version | sed -n '1,2p'
tini --version
python3 --version

npm ci --prefix js
npm audit --prefix js

bundle=inst/app/static/vendor/alder-editor.js
bundle_before=$(sha256sum "$bundle" | cut -d ' ' -f 1)
npm run build --prefix js
bundle_after=$(sha256sum "$bundle" | cut -d ' ' -f 1)
printf 'bundle_before=%s\n' "$bundle_before"
printf 'bundle_after=%s\n' "$bundle_after"
test "$bundle_before" = "$bundle_after"

npm ci --prefix host
npm audit --prefix host
host_bundle=inst/host/alder-host.mjs
host_browser=inst/app/static/host-app.js
host_bundle_before=$(sha256sum "$host_bundle" | cut -d ' ' -f 1)
host_browser_before=$(sha256sum "$host_browser" | cut -d ' ' -f 1)
npm run build --prefix host
test "$host_bundle_before" = "$(sha256sum "$host_bundle" | cut -d ' ' -f 1)"
test "$host_browser_before" = "$(sha256sum "$host_browser" | cut -d ' ' -f 1)"
host/node_modules/.bin/node --check "$host_bundle"
host/node_modules/.bin/node --check "$host_browser"

node --check "$bundle"
sh -n exec/alder
bash -n dev/reviews/run-static-gate.sh dev/reviews/run-package-check.sh \
  dev/reviews/run-cold-start-validation.sh dev/reviews/run-bulk-de-scale.sh
shellcheck \
  exec/alder \
  dev/reviews/run-static-gate.sh \
  dev/reviews/run-package-check.sh \
  dev/reviews/run-cold-start-validation.sh \
  dev/reviews/run-bulk-de-scale.sh
python3 -c 'import ast, pathlib; ast.parse(pathlib.Path("dev/reviews/audit-cold-start-processes.py").read_text())'

Rscript --vanilla - <<'RSCRIPT'
r_files <- c(
  list.files("R", pattern = "[.][Rr]$", recursive = TRUE, full.names = TRUE),
  list.files("inst/worker", pattern = "[.][Rr]$", recursive = TRUE,
             full.names = TRUE),
  list.files("inst/examples", pattern = "[.][Rr]$", recursive = TRUE,
             full.names = TRUE),
  "tests/testthat.R",
  list.files(
    "tests/testthat",
    pattern = "[.][Rr]$",
    recursive = TRUE,
    full.names = TRUE
  )
)
invisible(lapply(r_files, parse))
cat("parsed ", length(r_files), " R files\n", sep = "")

workflow_files <- list.files(
  ".github/workflows",
  pattern = "[.]ya?ml$",
  recursive = TRUE,
  full.names = TRUE
)
invisible(lapply(workflow_files, yaml::read_yaml))
cat("parsed ", length(workflow_files), " workflow files\n", sep = "")

batch <- readLines("exec/alder.cmd", warn = FALSE)
stopifnot(
  identical(batch[[1L]], "@echo off"),
  any(grepl("where Rscript", batch, fixed = TRUE)),
  any(grepl("exit /b 127", batch, fixed = TRUE)),
  any(grepl("alder::alder_cli", batch, fixed = TRUE)),
  any(grepl('runLast = FALSE)" %*', batch, fixed = TRUE)),
  !any(grepl("--args %*", batch, fixed = TRUE)),
  any(grepl("exit /b %alder_status%", batch, fixed = TRUE))
)
cat("Windows launcher static contract: OK\n")

# Resolve the source namespace before linting. A clean checkout must not rely
# on an unrelated globally installed Alder package for object-usage analysis.
pkgload::load_all(quiet = TRUE)
lints <- lintr::lint_package()
print(lints)
if (length(lints) > 0L) {
  quit(status = 1L)
}
RSCRIPT

printf 'static gate: OK\n'
