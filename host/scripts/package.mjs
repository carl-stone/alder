import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageNative } from './stage-native.mjs';
import { stageArk } from './fetch-ark.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'r-package': { type: 'string' },
  'node-license': { type: 'string' },
  'ark-archive': { type: 'string' },
} });
if (!values.output || !values['r-package'] || !values['ark-archive']) {
  throw new Error('Required: --output EMPTY_DIR --r-package ARCHIVE --ark-archive PINNED_ZIP [--node-license LICENSE]');
}
const output = resolve(values.output);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Release output directory must be empty');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pinnedNode = (await readFile(join(root, 'host/.node-version'), 'utf8')).trim();
if (process.versions.node !== pinnedNode) throw new Error(`Package with pinned Node ${pinnedNode}`);
const manifest = JSON.parse(await readFile(join(root, 'inst/host/manifest.json'), 'utf8'));
const extracted = await mkdtemp(join(tmpdir(), 'alder-package-verify-'));
try {
  execFileSync(process.env.ALDER_RSCRIPT ?? 'Rscript', ['--vanilla', '-e',
    `args <- commandArgs(TRUE)
utils::untar(args[[1]], files = c("alder/DESCRIPTION", "alder/NAMESPACE", "alder/R", "alder/inst"), exdir = args[[2]])
current <- read.dcf(file.path(args[[3]], "DESCRIPTION"))
archived <- read.dcf(file.path(args[[2]], "alder", "DESCRIPTION"))
normalize <- function(x) gsub("[[:space:]]+", " ", trimws(x))
for (field in colnames(current)) {
  if (!field %in% colnames(archived) || !identical(normalize(current[1, field]), normalize(archived[1, field]))) {
    stop("R archive DESCRIPTION mismatch: ", field)
  }
}
stopifnot(archived[1, "Version"] == args[[4]])`,
    resolve(values['r-package']), extracted, root, manifest.packageVersion], { stdio: 'inherit' });
  async function compare(relative) {
    const current = join(root, relative);
    if ((await stat(current)).isDirectory()) {
      const children = (await readdir(current)).sort();
      const archivedChildren = await readdir(join(extracted, 'alder', relative)).catch(() => []);
      if (JSON.stringify(children) !== JSON.stringify(archivedChildren.sort())) {
        throw new Error(`R archive file inventory differs: ${relative}; rebuild the R archive`);
      }
      for (const child of children) await compare(`${relative}/${child}`);
    } else {
      const archived = await readFile(join(extracted, 'alder', relative)).catch(() => undefined);
      if (!archived || !archived.equals(await readFile(current))) {
        throw new Error(`R archive does not match this build: ${relative}; rebuild the R archive`);
      }
    }
  }
  for (const path of ['NAMESPACE', 'R', 'inst/worker', 'inst/app', 'inst/host']) await compare(path);
} finally { await rm(extracted, { recursive: true, force: true }); }
await cp(join(root, 'inst/host'), join(output, 'host'), { recursive: true });
await mkdir(join(output, 'host/runtime'));
await cp(process.execPath, join(output, 'host/runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
const nodeLicense = await readFile(values['node-license'] ?? join(root, 'host/licenses/Node.txt'));
const nodeLicenseHash = createHash('sha256').update(nodeLicense).digest('hex');
const expectedLicense = JSON.parse(await readFile(join(root, 'host/licenses/node.json'), 'utf8'));
if (expectedLicense.version !== pinnedNode || expectedLicense.sha256 !== nodeLicenseHash) {
  throw new Error('Node license does not match the pinned runtime');
}
await writeFile(join(output, 'host/runtime/LICENSE'), nodeLicense);
const ark = await stageArk({ output: join(output, 'host/runtime'), archive: values['ark-archive'] });
await stageNative(join(output, 'host'));
await cp(values['r-package'], join(output, basename(values['r-package'])));
await cp(join(root, 'exec'), join(output, 'bin'), { recursive: true });
await writeFile(join(output, 'bin/alder'), `#!/bin/sh
set -eu
alder_release_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ALDER_HOST="$alder_release_root/host/alder-host.mjs"
export ALDER_NODE="$alder_release_root/host/runtime/node"
export ALDER_ARK="$alder_release_root/host/runtime/ark"
exec Rscript --vanilla -e 'status <- alder::alder_cli(commandArgs(trailingOnly = TRUE)); quit(save = "no", status = status, runLast = FALSE)' "$@"
`);
await chmod(join(output, 'bin/alder'), 0o755);
await writeFile(join(output, 'bin/alder.cmd'), `@echo off\r
setlocal\r
set "ALDER_HOST=%~dp0..\\host\\alder-host.mjs"\r
set "ALDER_NODE=%~dp0..\\host\\runtime\\node.exe"\r
set "ALDER_ARK=%~dp0..\\host\\runtime\\ark.exe"\r
Rscript --vanilla -e "status <- alder::alder_cli(commandArgs(trailingOnly = TRUE)); quit(save = 'no', status = status, runLast = FALSE)" %*\r
exit /b %errorlevel%\r
`);
const files = {};
async function hashes(directory, prefix = '') {
  for (const name of (await readdir(directory)).sort()) {
    const full = join(directory, name), relative = prefix + name;
    if ((await stat(full)).isDirectory()) await hashes(full, `${relative}/`);
    else files[relative] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
}
await hashes(output);
await writeFile(join(output, 'release.json'), `${JSON.stringify({
  ...manifest, platform: process.platform, arch: process.arch,
  nodeVersion: process.version, arkVersion: ark.version, files,
}, null, 2)}\n`);
