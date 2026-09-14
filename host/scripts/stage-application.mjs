
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageAir } from './fetch-air.mjs';
import { stageNative } from './stage-native.mjs';
import { readLockedRSourceArchives, validateRLibraryLock, verifyInstalledRLibrary } from './r-package-provenance.mjs';
import { tsImport } from 'tsx/esm/api';
const HELPER_BUILD_VERSION = '4.6.1';
const SUPERVISOR_PROVENANCE_RELATIVE_PATH = 'host/locks/process-supervisor-provenance.json';
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { validateApplicationManifest } = await tsImport('../src/resources.ts', { parentURL: import.meta.url });
const { values } = parseArgs({ options: {
  output: { type: 'string' },
  kind: { type: 'string' },
  rscript: { type: 'string' },
  ark: { type: 'string' },
  air: { type: 'string' },
  'air-archive': { type: 'string' },
  supervisor: { type: 'string' },
  'supervisor-provenance': { type: 'string' },
  'electron-entry': { type: 'string' },
  'prepare-macos-signing': { type: 'boolean', default: false },
  'forge-output': { type: 'string' },
  'source-commit': { type: 'string' },
  'qualified-rscript': { type: 'string', multiple: true },
  'r-source-cache': { type: 'string' },
}, allowPositionals: false });

if (!values.output || !values.kind || !['headless', 'desktop'].includes(values.kind)) {
  throw new Error('Usage: node scripts/stage-application.mjs --output EMPTY_DIR --kind headless|desktop --rscript ABSOLUTE_RSCRIPT [--qualified-rscript ABSOLUTE_RSCRIPT] [--r-source-cache DIRECTORY]');
}
if (typeof values.rscript !== 'string' || !isAbsolute(values.rscript)) throw new Error('--rscript must be supplied as an absolute executable path');
if (typeof values.supervisor !== 'string' || !isAbsolute(values.supervisor)) throw new Error('--supervisor must be supplied as an absolute verified artifact path');
if (typeof values['supervisor-provenance'] !== 'string' || !isAbsolute(values['supervisor-provenance'])) throw new Error('--supervisor-provenance must be supplied as an absolute producer descriptor path');
for (const candidate of values['qualified-rscript'] ?? []) {
  if (!isAbsolute(candidate)) throw new Error('--qualified-rscript values must be absolute executable paths');
}
const selectedRscript = resolve(values.rscript);
const qualifiedPaths = [selectedRscript, ...(values['qualified-rscript'] ?? []).map(candidate => resolve(candidate))];
if (!values['prepare-macos-signing']) {
  const physicalQualifiedPaths = await Promise.all(qualifiedPaths.map(candidate => realpath(candidate).catch(() => candidate)));
  if (new Set(physicalQualifiedPaths).size < 2) throw new Error('r_qualification_required: normal staging requires two independently installed Rscript paths');
}
const output = resolve(values.output);
await mkdir(output, { recursive: true });
await requireRealDirectory(output, 'application output directory');
const existingOutput = await readdir(output);
if (existingOutput.length !== 0) {
  if (values['prepare-macos-signing'] && values.kind === 'desktop' && process.platform === 'darwin') {
    const existingBundle = join(output, 'Alder.app');
    const existingApplicationRoot = join(existingBundle, 'Contents');
    const existingResources = join(existingApplicationRoot, 'Resources');
    await requireRealDirectory(existingBundle, 'existing macOS application bundle');
    await requireRealDirectory(existingApplicationRoot, 'existing macOS Contents directory');
    await requireRealDirectory(existingResources, 'existing macOS Resources directory');
    const [physicalOutput, physicalApplicationRoot] = await Promise.all([realpath(output), realpath(existingApplicationRoot)]);
    if (!physicalApplicationRoot.startsWith(physicalOutput + sep)) throw new Error('existing macOS application escapes its output directory');
    const existingManifestPath = join(existingResources, 'manifest.json');
    await requireRegularContained(existingApplicationRoot, existingManifestPath, 'existing macOS application manifest');
    const existingManifest = validateApplicationManifest(JSON.parse(await readFile(existingManifestPath, 'utf8')));
    const outerExecutable = existingManifest.resources.electronEntry;
    if (existingManifest.kind !== 'desktop' || existingManifest.target.platform !== 'darwin'
      || !outerExecutable || outerExecutable.includes('\\') || outerExecutable.startsWith('/')
      || outerExecutable.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('existing macOS application manifest cannot be prepared for outer signing');
    }
    const preSigningFiles = (await inventory(existingApplicationRoot, new Set(['Resources/manifest.json', outerExecutable])))
      .filter(file => !file.path.startsWith('_CodeSignature/'));
    const signedSupervisor = preSigningFiles.find(file => file.path === existingManifest.resources.processSupervisorExecutable);
    if (!signedSupervisor) throw new Error('signed process supervisor is missing from the refreshed application inventory');
    const descriptorPath = join(existingResources, SUPERVISOR_PROVENANCE_RELATIVE_PATH);
    await requireRegularContained(existingApplicationRoot, descriptorPath, 'process supervisor provenance');
    const descriptor = await readJsonRequired(descriptorPath, 'process supervisor provenance');
    descriptor.artifact.sha256 = signedSupervisor.sha256;
    await validateSupervisorProvenance(descriptor, join(existingApplicationRoot, existingManifest.resources.processSupervisorExecutable));
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const refreshedFiles = (await inventory(existingApplicationRoot, new Set(['Resources/manifest.json', outerExecutable])))
      .filter(file => !file.path.startsWith('_CodeSignature/'));
    existingManifest.files = refreshedFiles;
    validateApplicationManifest(existingManifest);
    await writeFile(existingManifestPath, `${JSON.stringify(existingManifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ kind: 'desktop', applicationRoot: existingApplicationRoot, manifest: existingManifestPath, preparedForOuterSigning: true })}\n`);
    process.exit(0);
  }
  throw new Error(`Application output directory must be empty: ${output}`);
}
const kind = values.kind;
if (values['prepare-macos-signing'] && (values.kind !== 'desktop' || process.platform !== 'darwin')) throw new Error('--prepare-macos-signing requires a macOS desktop stage');
const darwinDesktop = process.platform === 'darwin' && kind === 'desktop';
const applicationRoot = darwinDesktop ? join(output, 'Alder.app', 'Contents') : output;
const resourcePrefix = darwinDesktop ? 'Resources' : 'resources';
const resourceRoot = join(applicationRoot, resourcePrefix);
const source = {
  hostEntry: join(root, 'inst/host/alder-host.mjs'),
  hostLegal: join(root, 'inst/host/alder-host.mjs.LEGAL.txt'),
  rendererDirectory: join(root, 'inst/app/static'),
  rendererIndex: join(root, 'inst/app/index.html'),
  workerDirectory: join(root, 'inst/worker'),
  ark: resolve(values.ark ?? join(root, 'host/.runtime', process.platform === 'win32' ? 'ark.exe' : 'ark')),
  air: resolve(values.air ?? join(root, 'host/.runtime', process.platform === 'win32' ? 'air.exe' : 'air')),
  supervisor: resolve(values.supervisor),
  supervisorProvenance: resolve(values['supervisor-provenance']),
  licenses: join(root, 'inst/host/licenses'),
  nodeLicense: join(root, 'host/licenses/Node.txt'),
  nodeLicenseMeta: join(root, 'host/licenses/node.json'),
  airManifest: join(root, 'host/.runtime/air-manifest.json'),
  arkLock: join(root, 'host/ark-lock.json'),
  airLock: join(root, 'host/air-lock.json'),
  packageLock: join(root, 'host/package-lock.json'),
  rLock: join(root, 'host/r-library.lock.json'),
};
source.arkProvenance = join(dirname(source.ark), 'ark-provenance.json');
source.arkLicense = await exists(join(dirname(source.ark), 'LICENSE')) ? join(dirname(source.ark), 'LICENSE') : join(dirname(source.ark), 'ARK_LICENSE');
source.arkNotice = await exists(join(dirname(source.ark), 'NOTICE')) ? join(dirname(source.ark), 'NOTICE') : join(dirname(source.ark), 'ARK_NOTICE');
if (!await exists(source.air)) await stageAir({ output: join(root, 'host/.runtime'), archive: values['air-archive'] });
for (const path of [source.hostEntry, source.hostLegal, source.rendererDirectory, source.rendererIndex, source.workerDirectory,
  source.ark, source.arkProvenance, source.arkLicense, source.arkNotice, source.air, source.airManifest, source.supervisor, source.supervisorProvenance, source.licenses, source.nodeLicense, source.nodeLicenseMeta, source.arkLock, source.airLock, source.packageLock, source.rLock]) {
  if (!await exists(path)) throw new Error(`resource_missing: ${path}`);
}
const supervisorProvenance = await readJsonRequired(source.supervisorProvenance, 'supervisor provenance');
await validateSupervisorProvenance(supervisorProvenance, source.supervisor);
const forgeRoot = kind === 'desktop' ? resolve(values['forge-output'] ?? '') : null;
const forgeEntry = kind === 'desktop' ? resolve(values['electron-entry'] ?? '') : null;
if (kind === 'desktop' && (!values['electron-entry'] || !values['forge-output'])) {
  throw new Error('desktop_unavailable: --forge-output and --electron-entry are required for desktop staging');
}
const entryRelative = kind === 'desktop' ? relative(forgeRoot, forgeEntry) : null;
if (kind === 'desktop') {
  if (!await exists(forgeRoot)) throw new Error('desktop_unavailable: Forge output directory is missing: ' + forgeRoot);
  if (!entryRelative || entryRelative === '.' || entryRelative.startsWith('..' + sep) || entryRelative.split(sep).includes('..')) {
    throw new Error('desktop_unavailable: Forge executable must be inside --forge-output');
  }
}
const signatureManagedDesktop = darwinDesktop && isCodeSignedBundle(dirname(forgeRoot));
const signedManifest = signatureManagedDesktop ? join(forgeRoot, 'Resources', 'manifest.json') : null;
if (signedManifest && await exists(signedManifest)) {
  await cp(forgeRoot, applicationRoot, { recursive: true, verbatimSymlinks: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dirname(applicationRoot)], { stdio: 'ignore' });
  const signatureDirectory = await lstat(join(applicationRoot, '_CodeSignature')).catch(() => null);
  const codeResources = signatureDirectory && signatureDirectory.isDirectory() && !signatureDirectory.isSymbolicLink()
    ? await lstat(join(applicationRoot, '_CodeSignature', 'CodeResources')).catch(() => null)
    : null;
  if (!codeResources?.isFile() || codeResources.isSymbolicLink() || codeResources.nlink !== 1) throw new Error('signed macOS outer signature envelope is invalid');
  const copiedManifestPath = join(applicationRoot, 'Resources', 'manifest.json');
  const embeddedManifest = JSON.parse(await readFile(copiedManifestPath, 'utf8'));
  if (embeddedManifest?.schemaVersion !== 1 || embeddedManifest.kind !== 'desktop' || embeddedManifest.target?.platform !== 'darwin'
    || embeddedManifest.resources?.cliLauncher !== 'MacOS/alder' || embeddedManifest.resources?.electronEntry !== entryRelative || !Array.isArray(embeddedManifest.files)) {
    throw new Error('signed macOS application manifest identity is invalid');
  }
  const outerExecutable = join(applicationRoot, embeddedManifest.resources.electronEntry);
  const outerExecutableInfo = await lstat(outerExecutable).catch(() => null);
  const physicalApplicationRoot = await realpath(applicationRoot);
  const physicalOuterExecutable = outerExecutableInfo?.isFile() && !outerExecutableInfo.isSymbolicLink() && outerExecutableInfo.nlink === 1 ? await realpath(outerExecutable).catch(() => null) : null;
  if (!physicalOuterExecutable || !physicalOuterExecutable.startsWith(physicalApplicationRoot + sep)) throw new Error('signed macOS outer executable is not a contained regular, singly-linked file');
  const signedBoundary = new Set(['Resources/manifest.json', embeddedManifest.resources.electronEntry]);
  const copiedFiles = (await inventory(applicationRoot, new Set(['Resources/manifest.json']))).filter(file => !file.path.startsWith('_CodeSignature/') && !signedBoundary.has(file.path));
  if (JSON.stringify(copiedFiles) !== JSON.stringify(embeddedManifest.files)) throw new Error('signed macOS application manifest inventory mismatch');
  const launcher = join(applicationRoot, 'MacOS', 'alder');
  const launcherInfo = await lstat(launcher).catch(() => null);
  const launcherPhysical = launcherInfo?.isFile() && !launcherInfo.isSymbolicLink() && launcherInfo.nlink === 1 ? await realpath(launcher).catch(() => null) : null;
  if (!launcherPhysical || !launcherPhysical.startsWith(physicalApplicationRoot + sep)) throw new Error('signed macOS CLI launcher is not a contained regular file');
  execFileSync(launcher, ['--help'], { cwd: output, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ALDER_'))), stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ output, applicationRoot, manifest: copiedManifestPath, kind, finalizedSignedBundle: true }) + '\n');
  process.exit(0);
}


const electronEntry = kind === 'desktop' ? entryRelative.split(sep).join('/') : null;

const paths = {
  cliLauncher: process.platform === 'win32' ? 'bin/alder.cmd' : darwinDesktop ? 'MacOS/alder' : 'bin/alder',
  hostEntry: resourcePrefix + '/host/alder-host.mjs',
  rendererDirectory: resourcePrefix + '/app',
  workerDirectory: resourcePrefix + '/worker',
  rLibraryDirectory: resourcePrefix + '/r-library',
  arkExecutable: resourcePrefix + '/runtime/' + (process.platform === 'win32' ? 'ark.exe' : 'ark'),
  airExecutable: resourcePrefix + '/runtime/' + (process.platform === 'win32' ? 'air.exe' : 'air'),
  nodeExecutable: resourcePrefix + '/runtime/' + (process.platform === 'win32' ? 'node.exe' : 'node'),
  processSupervisorExecutable: resourcePrefix + '/runtime/' + (process.platform === 'win32' ? 'alder-process-supervisor.exe' : 'alder-process-supervisor'),
  electronEntry,
};

if (kind === 'desktop') {
  // Forge owns the Electron runtime. Alder owns every directory it populates;
  // reset those paths before writing so copied links cannot redirect staging.
  await mkdir(applicationRoot, { recursive: true });
  await cp(forgeRoot, applicationRoot, { recursive: true, verbatimSymlinks: true });
  await requireContainedDirectory(applicationRoot, applicationRoot, 'staged application root');
  await requireContainedDirectory(applicationRoot, resourceRoot, 'Forge resources directory');
  await requireRegularContained(forgeRoot, forgeEntry, 'Forge executable');
  await requireRegularContained(applicationRoot, join(applicationRoot, paths.electronEntry), 'staged Electron executable');
  const launcherParent = join(applicationRoot, dirname(paths.cliLauncher));
  await mkdir(launcherParent, { recursive: true });
  await requireContainedDirectory(applicationRoot, launcherParent, 'CLI launcher directory');
  const ownedDirectories = [...new Set([dirname(paths.hostEntry), paths.rendererDirectory, paths.workerDirectory, paths.rLibraryDirectory, dirname(paths.arkExecutable)])];
  for (const relativeDirectory of ownedDirectories) {
    const destination = join(applicationRoot, relativeDirectory);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await requireContainedDirectory(applicationRoot, destination, 'staging-owned directory');
  }
  await rm(join(applicationRoot, paths.cliLauncher), { force: true });
  if (darwinDesktop) await rm(join(applicationRoot, '_CodeSignature'), { recursive: true, force: true });
}

await mkdir(join(applicationRoot, dirname(paths.cliLauncher)), { recursive: true });
await mkdir(join(resourceRoot, 'runtime'), { recursive: true });
await mkdir(join(resourceRoot, 'host'), { recursive: true });
await cp(source.hostEntry, join(applicationRoot, paths.hostEntry));
await cp(source.hostLegal, join(resourceRoot, 'host/alder-host.mjs.LEGAL.txt'));
await cp(source.rendererDirectory, join(resourceRoot, 'app'), { recursive: true, verbatimSymlinks: true });
await cp(source.rendererIndex, join(resourceRoot, 'app', 'index.html'));
await cp(source.workerDirectory, join(applicationRoot, paths.workerDirectory), { recursive: true, verbatimSymlinks: true });
await cp(source.ark, join(applicationRoot, paths.arkExecutable));
await cp(source.air, join(applicationRoot, paths.airExecutable));
await cp(source.supervisor, join(applicationRoot, paths.processSupervisorExecutable));
await chmod(join(applicationRoot, paths.arkExecutable), 0o755);
await chmod(join(applicationRoot, paths.airExecutable), 0o755);
await chmod(join(applicationRoot, paths.processSupervisorExecutable), 0o755);
await cp(process.execPath, join(applicationRoot, paths.nodeExecutable));
await chmod(join(applicationRoot, paths.nodeExecutable), 0o755);
await cp(source.licenses, join(resourceRoot, 'host/licenses'), { recursive: true, verbatimSymlinks: true });
await cp(source.nodeLicense, join(resourceRoot, 'host/licenses/Node.txt'));
await cp(source.nodeLicenseMeta, join(resourceRoot, 'host/licenses/node.json'));
await mkdir(join(resourceRoot, 'host/locks'), { recursive: true });
await cp(source.arkLock, join(resourceRoot, 'host/locks/ark-lock.json'));
await cp(source.airLock, join(resourceRoot, 'host/locks/air-lock.json'));
await cp(source.packageLock, join(resourceRoot, 'host/locks/package-lock.json'));
await cp(source.airManifest, join(resourceRoot, 'host/locks/air-artifact.json'));
await cp(source.arkProvenance, join(resourceRoot, 'host/locks/ark-provenance.json'));
await cp(source.supervisorProvenance, join(resourceRoot, SUPERVISOR_PROVENANCE_RELATIVE_PATH));
await cp(source.arkLicense, join(resourceRoot, 'host/licenses/Ark-LICENSE'));
await cp(source.arkNotice, join(resourceRoot, 'host/licenses/Ark-NOTICE'));
const airArtifact = JSON.parse(await readFile(source.airManifest, 'utf8'));
if (!Array.isArray(airArtifact.licenseFiles)) throw new Error('resource_invalid: Air artifact licenseFiles must be an array');
for (const name of airArtifact.licenseFiles) {
  if (typeof name !== 'string' || basename(name) !== name || name.length === 0) throw new Error('resource_invalid: Air artifact license filename is invalid');
  const notice = join(dirname(source.airManifest), name);
  if (!await exists(notice)) throw new Error('resource_missing: ' + notice);
  await cp(notice, join(resourceRoot, 'host/licenses', name));
}
await stageNative(join(resourceRoot, 'host'));

if (kind === 'desktop') {
  const entry = forgeEntry;
  const destination = join(applicationRoot, paths.electronEntry);
  await requireRegularContained(forgeRoot, entry, 'Forge executable');
  if (resolve(entry) !== resolve(destination)) await cp(entry, destination, { recursive: true, verbatimSymlinks: true });
  await requireRegularContained(applicationRoot, destination, 'staged Electron executable');
  await chmod(destination, 0o755);
}

const rLibrary = join(applicationRoot, paths.rLibraryDirectory);
const rLock = JSON.parse(await readFile(source.rLock, 'utf8'));
const rIdentity = await installHelper(rLibrary, selectedRscript, rLock, values['r-source-cache']);
if (rIdentity.version !== HELPER_BUILD_VERSION) {
  throw new Error(`r_build_required: helper must be built with R ${HELPER_BUILD_VERSION}, got ${rIdentity.version}`);
}
await cp(source.rLock, join(rLibrary, 'r-library.lock.json'));
const qualified = [];
for (const candidate of qualifiedPaths) {
  const identity = await probeR(candidate, rLibrary);
  if (!qualified.includes(identity.version)) qualified.push(identity.version);
}
qualified.sort();
if (qualified.some(version => !/^4\.6\.[0-9]+$/.test(version))) {
  throw new Error(`r_unsupported: qualified R patches must be 4.6.x, got ${qualified.join(', ')}`);
}
if (!qualified.includes('4.6.0') || !qualified.includes('4.6.1')) {
  throw new Error(`r_qualification_required: both R 4.6.0 and 4.6.1 must be independently qualified, got ${qualified.join(', ')}`);
}
await writeLaunchers(applicationRoot, paths);
await runtimePreflight(applicationRoot, paths, selectedRscript, rLibrary);
await arkQualificationPreflight(applicationRoot, paths, qualifiedPaths);
const manifest = await makeManifest(applicationRoot, paths, kind, values['source-commit'], rIdentity, qualified, Boolean(values['prepare-macos-signing']));
await writeFile(join(resourceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const manifestSha256 = await sha256(join(resourceRoot, 'manifest.json'));
process.stdout.write(`${JSON.stringify({ kind, applicationRoot, cliLauncher: join(applicationRoot, paths.cliLauncher), manifestSha256 })}\n`);

async function installHelper(destination, rscript, lock, sourceCacheDirectory = null) {
  validateRLibraryLock(lock);
  const { order, archives } = await readLockedRSourceArchives(lock, {
    sourceCacheDirectory: sourceCacheDirectory ? resolve(sourceCacheDirectory) : null,
  });
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  // Resolve R from the selected Rscript itself. A wrapper may live away from
  // its installation, so deriving a sibling R binary can select the wrong
  // interpreter or fail before the helper is installed.
  const cleanEnv = cleanREnvironment();
  const rHomeBin = execFileSync(rscript, ['--vanilla', '-e', 'cat(normalizePath(R.home("bin"), winslash="/", mustWork=TRUE))'], { encoding: 'utf8', env: cleanEnv }).trim();
  if (!rHomeBin) throw new Error('r_invalid: selected Rscript did not report R.home("bin")');
  const r = join(rHomeBin, process.platform === 'win32' ? 'R.exe' : 'R');
  // Install only into the staged library and never expose configured user/site
  // libraries to R CMD INSTALL. Every non-base dependency was fetched and
  // verified from the lock before this first install starts.
  const installEnv = { ...cleanEnv, R_LIBS: destination, R_LIBS_USER: destination, R_LIBS_SITE: destination };
  const archiveDirectory = await mkdtemp(join(tmpdir(), 'alder-stage-r-source-' + process.pid + '-'));
  const buildDirectory = await mkdtemp(join(tmpdir(), 'alder-stage-helper-' + process.pid + '-'));
  try {
    const archivePaths = new Map();
    for (const [name, bytes] of archives) {
      const archivePath = join(archiveDirectory, name + '.tar.gz');
      await writeFile(archivePath, bytes, { mode: 0o644 });
      archivePaths.set(name, archivePath);
    }
    for (const name of order) {
      if (name === 'alder') continue;
      const archivePath = archivePaths.get(name);
      if (!archivePath) throw new Error('r_dependency_source_missing: ' + name);
      execFileSync(r, ['CMD', 'INSTALL', '-l', destination, '--no-multiarch', '--with-keep.source', archivePath], {
        stdio: 'inherit',
        env: installEnv,
      });
    }
    // Build first so R applies the package's existing .Rbuildignore. Direct
    // source INSTALL does not apply that exclusion convention.
    execFileSync(r, ['CMD', 'build', '--no-build-vignettes', '--no-manual', root], {
      cwd: buildDirectory,
      stdio: 'inherit',
      env: installEnv,
    });
    const artifacts = (await readdir(buildDirectory)).filter(name => name.startsWith('alder_') && name.endsWith('.tar.gz'));
    if (artifacts.length !== 1) throw new Error('r_source_artifact_invalid: expected one alder source artifact, found ' + artifacts.length);
    execFileSync(r, ['CMD', 'INSTALL', '-l', destination, '--no-multiarch', '--with-keep.source', join(buildDirectory, artifacts[0])], {
      stdio: 'inherit',
      env: installEnv,
    });
  } finally {
    await rm(archiveDirectory, { recursive: true, force: true });
    await rm(buildDirectory, { recursive: true, force: true });
  }
  const helper = join(destination, 'alder');
  if (!await exists(helper)) throw new Error('r_library_invalid: source helper did not install');
  // The application tree owns these resources; they cannot be smuggled into
  // the ordinary helper artifact or loaded from a checkout at first use.
  for (const name of ['app', 'host', 'worker', 'exec', 'publishing']) {
    if (await exists(join(helper, name))) throw new Error('r_helper_payload: installed helper contains ' + name);
  }
  await verifyInstalledRLibrary(destination, lock);
  return parseRIdentity(execFileSync(rscript, ['--vanilla', '-e', 'cat(as.character(getRversion()), "\\n", R.version$platform, "\\n", sep="")'], { encoding: 'utf8', env: cleanEnv }));
}

async function probeR(rscript, library) {
  const code = [
    'args <- commandArgs(TRUE)',
    'lib <- normalizePath(args[[1]], winslash="/", mustWork=TRUE)',
    // Keep only the staged library and R's base library; never resolve an
    // application dependency from an ambient user/site library.
    '.libPaths(c(lib, .Library))',
    'suppressPackageStartupMessages(library(alder, lib.loc=lib))',
    'stopifnot(as.character(getRversion()) >= "4.6.0", as.character(getRversion()) < "4.7.0")',
    'cat(as.character(getRversion()), "\\n", R.version$platform, "\\n", sep="")',
  ].join(';');
  const text = execFileSync(rscript, ['--vanilla', '-e', code, library], { encoding: 'utf8', env: { ...cleanREnvironment(), R_LIBS: library, R_LIBS_USER: library } });
  return parseRIdentity(text);
}

async function runtimePreflight(base, paths, rscript, library) {
  execFileSync(join(base, paths.nodeExecutable), ['--version'], { stdio: 'ignore' });
  execFileSync(join(base, paths.arkExecutable), ['--version'], { stdio: 'ignore' });
  execFileSync(join(base, paths.airExecutable), ['--version'], { stdio: 'ignore' });
  await probeR(rscript, library);
}

function cleanREnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'R_HOME' || key === 'R_USER' || key.startsWith('R_LIBS') || key.startsWith('R_PROFILE') || key.startsWith('R_ENVIRON') || key.startsWith('ALDER_')) delete env[key];
  }
  return env;
}


function parseRIdentity(text) {
  const [version, platform] = text.trim().split(/\r?\n/);
  if (!version || !platform) throw new Error('r_invalid: Rscript did not report a complete identity');
  return { version, platform };
}

async function writeLaunchers(base, paths) {
  const launcher = join(base, paths.cliLauncher);
  await mkdir(dirname(launcher), { recursive: true });
  const launcherDir = dirname(paths.cliLauncher);
  const rootRelative = launcherDir === '.' ? '.' : '..';
  if (process.platform === 'win32') {
    const cmd = `@echo off\r\nsetlocal\r\nset "ALDER_LAUNCHER=%~f0"\r\nfor /f "usebackq delims=" %%I in (\`powershell.exe -NoProfile -NonInteractive -Command "$p=$env:ALDER_LAUNCHER; while ($true) { $i=Get-Item -LiteralPath $p; if (-not $i.LinkType) { $p=$i.FullName; break }; $t=$i.Target; if (-not [IO.Path]::IsPathRooted($t)) { $t=Join-Path $i.DirectoryName $t }; $p=$t }; [IO.Path]::GetFullPath($p)"\`) do set "ALDER_LAUNCHER=%%I"\r\nfor %%I in ("%ALDER_LAUNCHER%") do set "ROOT=%%~dpI${rootRelative}"\r\n"%ROOT%\\${paths.nodeExecutable.replaceAll('/', '\\\\')}" "%ROOT%\\${paths.hostEntry.replaceAll('/', '\\\\')}" %*\r\nexit /b %errorlevel%\r\n`;
    await writeFile(launcher, cmd);
  } else {
    const posix = `#!/bin/sh\nset -eu\nscript=$0\nwhile [ -h "$script" ]; do\n  script_dir=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd -P)\n  link=$(readlink "$script")\n  case "$link" in\n    /*) script=$link ;;\n    *) script=$script_dir/$link ;;\n  esac\ndone\nscript_dir=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd -P)\nroot=$(CDPATH= cd -- "$script_dir/${rootRelative}" && pwd -P)\nexec "$root/${paths.nodeExecutable}" "$root/${paths.hostEntry}" "$@"\n`;
    await writeFile(launcher, posix, { mode: 0o755 });
    await chmod(launcher, 0o755);
  }
}

async function arkQualificationPreflight(base, paths, candidates) {
  const tsx = join(root, 'host/node_modules/tsx/dist/cli.mjs');
  const script = join(root, 'host/scripts/ark-preflight.ts');
  if (!await exists(tsx)) throw new Error('ark_preflight_missing: tsx is required for shared ArkKernel probe');
  for (const [index, candidate] of candidates.entries()) {
    const probe = join(tmpdir(), `alder-stage-ark-probe-${process.pid}-${index}`);
    await rm(probe, { recursive: true, force: true });
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, 'probe.R'), '# %%\n1 + 1\n');
    try {
      execFileSync(process.execPath, [tsx, script, base, candidate, probe], { stdio: 'inherit', timeout: 180_000, env: cleanREnvironment() });
    } catch (error) {
      throw new Error(`ark_preflight_failed: ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
}

async function makeManifest(base, paths, stageKind, sourceCommit, rIdentity, qualified, excludeOuterExecutable = false) {
  const packageJson = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8'));
  const arkLock = JSON.parse(await readFile(source.arkLock, 'utf8'));
  const airLock = JSON.parse(await readFile(source.airLock, 'utf8'));
  const electronRuntime = stageKind === 'desktop' ? probeElectronRuntime(join(base, paths.electronEntry)) : null;
  if (arkLock.schemaVersion !== 1 || !arkLock.baseCommit || !arkLock.patch?.sha256 || !arkLock.version) throw new Error('runtime_lock_missing: Ark lock metadata is required before staging');
  const resolvedSourceCommit = sourceCommit ?? gitSourceCommit();
  if (!SOURCE_COMMIT.test(resolvedSourceCommit)) {
    throw new Error('source_commit_invalid: staging requires a full lowercase 40-hex commit ID');
  }
  if (airLock.schemaVersion !== 1 || !airLock.version) throw new Error('runtime_lock_missing: Air lock metadata is required before staging');
  const manifest = {
    schemaVersion: 1,
    kind: stageKind,
    applicationVersion: packageJson.version,
    sourceCommit: resolvedSourceCommit,
    sourceTreeSha256: await sourceTreeSha256(),
    hostProtocol: 'alder-host-v2',
    engineProtocol: 'alder-engine-v2',
    target: { platform: process.platform, arch: process.arch },
    rVersionRange: '>=4.6.0 <4.7.0',
    qualifiedRPatchVersions: qualified,
    rBuildVersion: rIdentity.version,
    resources: paths,
    runtimes: {
      node: process.version,
      ark: { upstreamVersion: arkLock.upstreamVersion ?? arkLock.version, buildVersion: arkLock.version, baseCommit: arkLock.baseCommit, patchSha256: arkLock.patch.sha256, mimePublisher: 'alder-json-v1' },
      air: airLock.version,
      electron: electronRuntime?.electron ?? null,
      chromium: electronRuntime?.chrome ?? null,
      electronNode: electronRuntime?.node ?? null,
    },
    files: (await inventory(base, new Set([`${resourcePrefix}/manifest.json`, ...(excludeOuterExecutable ? [paths.electronEntry] : [])])))
      .filter(file => !excludeOuterExecutable || !file.path.startsWith('_CodeSignature/')),
    rPackages: await inventoryRPackages(join(base, paths.rLibraryDirectory)),
  };
  validateApplicationManifest(manifest);
  return manifest;
}

function probeElectronRuntime(entry) {
  let raw;
  try {
    raw = execFileSync(entry, [
      '--alder-runtime-probe',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ALDER_DESKTOP_RUNTIME_PROBE: '1' },
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`desktop_runtime_probe_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const versions = JSON.parse(raw);
  if (typeof versions?.electron !== 'string' || typeof versions?.chrome !== 'string' || typeof versions?.node !== 'string') {
    throw new Error('desktop_runtime_probe_failed: Electron, Chromium, and embedded Node identities are required');
  }
  return versions;
}

function gitSourceCommit() {
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (SOURCE_COMMIT.test(commit)) return commit;
  } catch {}
  throw new Error('source_commit_unavailable: git HEAD is required when --source-commit is omitted');
}

async function sourceTreeSha256() {
  const files = [];
  await walk(root, async path => {
    if (!excludedPath(path)) return;
    const rel = relative(root, path).split(sep).join('/');
    files.push([rel, await sha256(path)]);
  }, async path => excludedPath(path));
  const hash = createHash('sha256');
  for (const [path, digest] of files.sort(([a], [b]) => a.localeCompare(b))) hash.update(`${path}\0${digest}\n`);
  return hash.digest('hex');
}

async function inventory(base, skip) {
  const files = [];
  const seen = new Set();
  const absoluteBase = resolve(base);
  const onFile = async path => {
    const rel = relative(absoluteBase, resolve(path)).split(sep).join('/');
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('application inventory path escaped staged root: ' + rel);
    const info = await lstat(path);
    const skipped = skip.has(rel);
    if (seen.has(rel)) throw new Error('application inventory found duplicate path: ' + rel);
    seen.add(rel);
    if (info.isSymbolicLink()) {
      const target = await realpath(path).catch(() => null);
      if (!target || (target !== absoluteBase && !target.startsWith(absoluteBase + sep))) throw new Error('application inventory symlink escapes staged root: ' + rel);
      const targetInfo = await stat(path).catch(() => null);
      if (!targetInfo?.isFile() || targetInfo.nlink !== 1) throw new Error('application inventory rejects non-regular or hard-linked symlink target: ' + rel);
      if (skipped) return;
      const bytes = await readFile(path);
      files.push({ path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
      return;
    }
    if (!info.isFile()) throw new Error('application inventory rejects non-regular file: ' + rel);
    if (info.nlink !== 1) throw new Error('application inventory rejects hard-linked file: ' + rel);
    const physical = await realpath(path);
    if (physical !== absoluteBase && !physical.startsWith(absoluteBase + sep)) throw new Error('application inventory file escapes staged root: ' + rel);
    if (skipped) return;
    const bytes = await readFile(path);
    files.push({ path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  await walkStrict(absoluteBase, onFile);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkStrict(directory, onFile) {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('application inventory rejects non-directory staged root: ' + directory);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) await walkStrict(path, onFile);
    else if (info.isFile() || info.isSymbolicLink()) await onFile(path);
    else throw new Error('application inventory rejects special file: ' + path);
  }
}

function isCodeSignedBundle(bundle) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
async function requireRegularContained(rootDirectory, path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${label} must be a regular, non-symlink, singly-linked file`);
  const [physicalRoot, physicalPath] = await Promise.all([realpath(rootDirectory), realpath(path)]);
  if (physicalPath !== physicalRoot && !physicalPath.startsWith(physicalRoot + sep)) throw new Error(`${label} escapes its application root`);
}
async function requireRealDirectory(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function requireContainedDirectory(rootDirectory, path, label) {
  await requireRealDirectory(path, label);
  const [physicalRoot, physicalPath] = await Promise.all([realpath(rootDirectory), realpath(path)]);
  if (physicalPath !== physicalRoot && !physicalPath.startsWith(physicalRoot + sep)) throw new Error(`${label} escapes its application root`);
}

async function inventoryRPackages(directory) {
  const packages = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const description = await readFile(join(directory, entry.name, 'DESCRIPTION'), 'utf8').catch(() => null);
    if (!description) continue;
    const fields = parseDcf(description);
    packages.push({ name: fields.Package ?? entry.name, version: fields.Version ?? 'unknown', builtR: fields.Built ?? 'unknown', platform: fields.Platform ?? process.platform, license: fields.License ?? 'unspecified' });
  }
  return packages;
}

function parseDcf(text) {
  const fields = {};
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^ :]+):[ \t]*(.*)$/);
    if (match) { key = match[1]; fields[key] = match[2]; }
    else if (key && /^\s/.test(line)) fields[key] += ` ${line.trim()}`;
  }
  return fields;
}

async function walk(directory, onFile, onDirectory = async () => true) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!await onDirectory(path)) continue;
      await walk(path, onFile, onDirectory);
    } else if (entry.isFile()) await onFile(path);
  }
}

function excludedPath(path) {
  const rel = relative(root, path).split(sep).join('/');
  const generatedDesktop = ['desktop/out', 'desktop/.vite', 'desktop/staging', 'desktop/build']
    .some(prefix => rel === prefix || rel.startsWith(prefix + '/'));
  const generatedRoot = /^(?:[.]tmp|[.]evidence|alder-evidence|evidence|handoff|artifacts?|cache|tmp|Rcheck|[.]Rcheck|[.]application|[.]cache|coverage|Rplots[.]pdf|[.]Rhistory|[.]RData(?:Tmp)?)(?:[-_./]|$)/.test(rel);
  const generatedHost = /^(?:host\/(?:[.]application|[.]runtime|[.]release|[.]evidence|[.]staging|dist)(?:[-_./]|$)|host\/native\/process-supervisor\/target(?:\/|$))/.test(rel);
  return !(rel === '.git' || rel.startsWith('.git/') || rel === 'node_modules' || rel.startsWith('node_modules/') || rel.includes('/node_modules/') || rel === 'dev/reviews/evidence' || rel.startsWith('dev/reviews/evidence/') || generatedDesktop || generatedRoot || generatedHost);
}

async function readJsonRequired(path, label) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { throw new Error(label + ' is unavailable: ' + error.message); }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(label + ' is invalid JSON: ' + error.message); }
}

async function validateSupervisorProvenance(provenance, artifactPath) {
  const producer = provenance?.producer;
  if (provenance?.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(provenance?.artifact?.sha256 ?? '')
      || !producer || producer.toolchain !== 'rust-1.95.0'
      || typeof producer.rustc !== 'string' || !/^rustc 1\.95\.0(?:\s|$)/.test(producer.rustc)
      || typeof producer.cargo !== 'string' || !/^cargo 1\.95\.0(?:\s|$)/.test(producer.cargo)
      || producer.command !== 'cargo +1.95.0 build --locked --release --manifest-path host/native/process-supervisor/Cargo.toml') {
    throw new Error('supervisor provenance is not a verified Rust 1.95.0 locked build');
  }
  const info = await lstat(artifactPath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error('supervisor artifact must be a regular, non-linked file');
  }
  const digest = await sha256(artifactPath);
  if (digest !== provenance.artifact.sha256) throw new Error('supervisor artifact digest does not match its producer descriptor');
}

async function exists(path) { return stat(path).then(() => true).catch(() => false); }
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
