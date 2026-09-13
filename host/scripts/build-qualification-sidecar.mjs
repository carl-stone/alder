import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  output: { type: 'string' },
  application: { type: 'string' },
  source: { type: 'string' },
}, allowPositionals: false });
if (typeof values.output !== 'string' || typeof values.application !== 'string') {
  throw new Error('Usage: node scripts/build-qualification-sidecar.mjs --output ABSOLUTE_DIR --application APPLICATION_DIR [--source CHECKOUT_ROOT]');
}
const root = resolve(values.source ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const output = resolve(values.output);
const application = resolve(values.application);
if ((await exists(output)) && (await readdir(output)).length !== 0) throw new Error('qualification sidecar output must be empty: ' + output);
await mkdir(output, { recursive: true });
const applicationManifestPath = await findManifest(application);
const applicationManifest = JSON.parse(await readFile(applicationManifestPath, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(applicationManifest.sourceCommit) || !/^[0-9a-f]{64}$/.test(applicationManifest.sourceTreeSha256)) {
  throw new Error('application manifest has no valid source identity');
}
const sourceOutput = join(output, 'source');
const driverOutput = join(output, 'driver');
const files = {};
await mkdir(sourceOutput, { recursive: true });
await snapshotSource(root, sourceOutput, output, '', files);
const actualSourceTreeSha256 = sourceTreeSha256(files);
if (actualSourceTreeSha256 !== applicationManifest.sourceTreeSha256) {
  throw new Error('qualification source tree identity mismatch: expected ' + applicationManifest.sourceTreeSha256 + ', got ' + actualSourceTreeSha256);
}
await copyRequired(join(root, 'host/scripts/smoke-application.mjs'), join(driverOutput, 'scripts/smoke-application.mjs'));
await copyRequired(join(root, 'host/scripts/bundle-normalization.mjs'), join(driverOutput, 'scripts/bundle-normalization.mjs'));
await copyRequired(join(root, 'host/scripts/package.mjs'), join(driverOutput, 'scripts/package.mjs'));
await copyRequired(join(root, 'host/scripts/smoke-scenarios'), join(driverOutput, 'scripts/smoke-scenarios'));
await copyRequired(join(root, 'host/test-support'), join(driverOutput, 'test-support'));
await copyRequired(join(root, 'host/node_modules'), join(output, 'node_modules'));
const dependencyFiles = {};
await hashDependencyTree(join(output, 'node_modules'), '', dependencyFiles);
const driverFiles = {};
await hashTree(driverOutput, '', driverFiles);
const tsxRelative = 'node_modules/.bin/' + (process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const tsxPath = join(output, tsxRelative);
const tsxInfo = await stat(tsxPath).catch(() => null);
if (!tsxInfo || !tsxInfo.isFile()) throw new Error('qualification sidecar is missing its frozen tsx dependency');
const dependencies = {
  packageLockSha256: files['host/package-lock.json'],
  tsx: { path: tsxRelative, sha256: await sha256(tsxPath) },
  nodeModules: {
    path: 'node_modules',
    files: dependencyFiles,
    filesSha256: sha256Text(JSON.stringify(dependencyFiles, null, 2) + '\n'),
  },
};
const descriptor = {
  schemaVersion: 1,
  sourceCommit: applicationManifest.sourceCommit,
  sourceTreeSha256: applicationManifest.sourceTreeSha256,
  files,
  filesSha256: sha256Text(JSON.stringify(files, null, 2) + '\n'),
  driver: {
    entry: 'scripts/smoke-application.mjs',
    files: driverFiles,
    filesSha256: sha256Text(JSON.stringify(driverFiles, null, 2) + '\n'),
  },
  dependencies,
};
const manifestPath = join(sourceOutput, 'qualification-manifest.json');
await writeFile(manifestPath, JSON.stringify(descriptor, null, 2) + '\n');
const result = {
  schemaVersion: 1,
  sourceCommit: descriptor.sourceCommit,
  sourceTreeSha256: descriptor.sourceTreeSha256,
  driver: join(driverOutput, 'scripts/smoke-application.mjs'),
  source: sourceOutput,
  manifest: manifestPath,
  manifestSha256: await sha256(manifestPath),
  filesSha256: descriptor.filesSha256,
};
process.stdout.write(JSON.stringify(result) + '\n');

async function snapshotSource(directory, destination, qualificationOutput, prefix, files) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = join(directory, entry.name);
    const relativePath = prefix + entry.name;
    if (excludedPath(relativePath) || isQualificationOutput(sourcePath, qualificationOutput)) continue;

    if (entry.isDirectory()) {
      await snapshotSource(sourcePath, join(destination, entry.name), qualificationOutput, relativePath + '/', files);
    } else if (entry.isFile()) {
      const destinationPath = join(destination, entry.name);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      files[relativePath.split(sep).join('/')] = await sha256(destinationPath);
    }
  }
}

async function hashTree(directory, prefix, files) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) await hashTree(path, relativePath + '/', files);
    else if (entry.isFile()) files[relativePath.split(sep).join('/')] = await sha256(path);
    else throw new Error('qualification driver contains unsupported entry: ' + path);
  }
}

async function hashDependencyTree(directory, prefix, files, root = directory) {
  const physicalRoot = await realpath(root);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) await hashDependencyTree(path, relativePath + '/', files, root);
    else if (entry.isFile()) files[relativePath.split(sep).join('/')] = await sha256(path);
    else if (entry.isSymbolicLink()) {
      const target = await realpath(path).catch(() => null);
      if (target === null || !isWithin(physicalRoot, target)) throw new Error('qualification dependency symlink escapes node_modules: ' + relativePath);
      files[relativePath.split(sep).join('/')] = sha256Text('link\0' + await readlink(path));
    } else throw new Error('qualification dependency contains unsupported entry: ' + path);
  }
}

function isWithin(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath + sep);
}
function sourceTreeSha256(files) {
  const hash = createHash('sha256');
  for (const [path, digest] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) hash.update(path + '\0' + digest + '\n');
  return hash.digest('hex');
}

function excludedPath(relativePath) {
  const generatedDesktop = ['desktop/out', 'desktop/.vite', 'desktop/staging', 'desktop/build']
    .some(prefix => relativePath === prefix || relativePath.startsWith(prefix + '/'));
  const generatedRoot = /^(?:[.]tmp|[.]evidence|alder-evidence|evidence|handoff|artifacts?|cache|tmp|Rcheck|[.]Rcheck|[.]application|[.]cache|coverage|Rplots[.]pdf|[.]Rhistory|[.]RData(?:Tmp)?)(?:[-_./]|$)/.test(relativePath);
  const generatedHost = /^(?:host\/(?:[.]application|[.]runtime|[.]release|[.]evidence|[.]staging|dist)(?:[-_./]|$)|host\/native\/process-supervisor\/target(?:\/|$))/.test(relativePath);
  return relativePath === '.git' || relativePath.startsWith('.git/') || relativePath === 'node_modules'
    || relativePath.startsWith('node_modules/') || relativePath.includes('/node_modules/')
    || relativePath === 'dev/reviews/evidence' || relativePath.startsWith('dev/reviews/evidence/')
    || generatedDesktop || generatedRoot || generatedHost;
}

function isQualificationOutput(path, qualificationOutput) {
  const relativePath = relative(qualificationOutput, path);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..' + sep));
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function copyRequired(from, to) {
  const info = await stat(from).catch(() => null);
  if (!info) throw new Error('qualification source missing: ' + from);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true, verbatimSymlinks: true });
}

async function findManifest(applicationRoot) {
  const candidates = [
    join(applicationRoot, 'resources', 'manifest.json'),
    join(applicationRoot, 'Resources', 'manifest.json'),
    join(applicationRoot, 'Alder.app', 'Contents', 'Resources', 'manifest.json'),
  ];
  for (const path of candidates) if (await exists(path)) return path;
  throw new Error('application manifest is missing: ' + applicationRoot);
}
