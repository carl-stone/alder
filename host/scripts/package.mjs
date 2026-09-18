import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';
const { values } = parseArgs({ options: {
  application: { type: 'string' },
  output: { type: 'string' },
  archive: { type: 'string' },
  'archive-format': { type: 'string' },
  'artifact-record': { type: 'string' },
  'signature-record': { type: 'string' },
  'signature-status': { type: 'string' },
  'target-platform': { type: 'string' },
  'target-arch': { type: 'string' },
  rscript: { type: 'string' },
  'source-commit': { type: 'string' },
}, allowPositionals: false });

if (!values.application || !values.output) {
  throw new Error('Usage: node scripts/package.mjs --application STAGED_ROOT --output EMPTY_DIR --rscript ABSOLUTE_RSCRIPT [--archive ARCHIVE]');
}
if (typeof values.rscript !== 'string' || !isAbsolute(values.rscript)) throw new Error('--rscript must be supplied as an absolute executable path');
if (values['archive-format'] && !values.archive) throw new Error('--archive-format requires --archive');
if (values['artifact-record'] && !values.archive) throw new Error('--artifact-record requires --archive');

const application = resolve(values.application);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) throw new Error(`Release output directory must be empty: ${output}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { readApplicationManifest } = await tsImport('../src/resources.ts', { parentURL: import.meta.url });
const sourceManifest = await findManifest(application);
const applicationRoot = dirname(dirname(sourceManifest));
const manifest = await readApplicationManifest(applicationRoot);
if (manifest.rQualificationMode !== 'dual-r') throw new Error('release packaging rejects development-single-r manifests');
const target = {
  platform: values['target-platform'] ?? process.platform,
  arch: values['target-arch'] ?? process.arch,
};
if (target.platform !== process.platform || target.arch !== process.arch) {
  throw new Error(`target ${target.platform}/${target.arch} does not match packaging host ${process.platform}/${process.arch}`);
}
if (manifest.target.platform !== target.platform || manifest.target.arch !== target.arch) {
  throw new Error(`application manifest target does not match ${target.platform}/${target.arch}`);
}

const copyRoot = process.platform === 'darwin' && manifest.kind === 'desktop' && basename(applicationRoot) === 'Contents'
  ? dirname(dirname(applicationRoot))
  : applicationRoot;
await cp(copyRoot, output, { recursive: true, verbatimSymlinks: true });
const legacyRuntimeManifest = join(output, 'release' + '.json');
if (await exists(legacyRuntimeManifest)) throw new Error('legacy runtime release manifest is not permitted in packaged output');
const copiedManifest = join(output, relative(copyRoot, sourceManifest));
const copiedApplicationRoot = join(output, relative(copyRoot, applicationRoot));
const copiedManifestValue = await readApplicationManifest(copiedApplicationRoot);
if (JSON.stringify(copiedManifestValue) !== JSON.stringify(manifest)) throw new Error('copied application manifest identity changed during packaging');
const manifestSha256 = await sha256(copiedManifest);
const files = {};
await collectHashes(output, '', files);
const packageJson = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8'));
const signature = await readSignature();
const archivePath = values.archive ? resolve(values.archive) : null;
const archiveFormat = archivePath ? archiveFormatFor(values['archive-format'], archivePath, target.platform) : null;
const artifactRecord = archivePath
  ? resolve(values['artifact-record'] ?? join(dirname(archivePath), 'artifact-record.json'))
  : null;
if (archivePath && isWithin(output, archivePath)) throw new Error('archive must be outside the release output directory');
const releaseSourceCommit = values['source-commit'] ?? manifest.sourceCommit;
if (!/^[0-9a-f]{40}$/.test(releaseSourceCommit)) throw new Error('release sourceCommit must be a full lowercase 40-hex commit ID');
if (artifactRecord && isWithin(output, artifactRecord)) throw new Error('artifact record must be outside the release output directory');

const releaseManifest = {
  schemaVersion: 1,
  platform: target.platform,
  arch: target.arch,
  nodeVersion: process.version,
  kind: manifest.kind,
  applicationVersion: manifest.applicationVersion,
  sourceCommit: releaseSourceCommit,
  sourceTreeSha256: manifest.sourceTreeSha256,
  hostProtocol: manifest.hostProtocol,
  engineProtocol: manifest.engineProtocol,
  target,
  rVersionRange: manifest.rVersionRange,
  rQualificationMode: manifest.rQualificationMode,
  qualifiedRPatchVersions: manifest.qualifiedRPatchVersions,
  rBuildVersion: manifest.rBuildVersion,
  runtimes: manifest.runtimes,
  packageVersion: packageJson.version,
  applicationManifest: relative(output, copiedManifest).split(sep).join('/'),
  manifestSha256,
  archive: archivePath ? { format: archiveFormat, name: basename(archivePath), record: basename(artifactRecord) } : null,
  signature,
  files,
};

let artifactIdentity = null;
if (archivePath) {
  await mkdir(dirname(archivePath), { recursive: true });
  await mkdir(dirname(artifactRecord), { recursive: true });
  await createArchive(output, archivePath, archiveFormat);
  const archiveInfo = await stat(archivePath);
  const releaseManifestSha256 = sha256Text(`${JSON.stringify(releaseManifest, null, 2)}\n`);
  artifactIdentity = {
    schemaVersion: 1,
    kind: manifest.kind,
    target,
    release: {
      root: relative(dirname(artifactRecord), output).split(sep).join('/'),
      applicationManifest: relative(dirname(artifactRecord), copiedManifest).split(sep).join('/'),
      manifestSha256,
    },
    releaseManifest,
    releaseManifestSha256,
    artifact: {
      type: manifest.kind + '-' + archiveFormat,
      name: basename(archivePath),
      path: relative(dirname(artifactRecord), archivePath).split(sep).join('/'),
      format: archiveFormat,
      bytes: archiveInfo.size,
      sha256: await sha256(archivePath),
    },
    signature,
  };
  if (signature.verification) artifactIdentity.verification = signature.verification;
  await writeFile(artifactRecord, JSON.stringify(artifactIdentity, null, 2) + '\n');
}

process.stdout.write(`${JSON.stringify({
  output,
  kind: manifest.kind,
  target,
  applicationManifest: copiedManifest,
  manifestSha256,
  files: Object.keys(files).length,
  archive: artifactIdentity?.artifact ?? null,
  artifactRecord,
  signature,
})}\n`);

async function findManifest(base) {
  const candidates = [join(base, 'resources/manifest.json'), join(base, 'Resources/manifest.json'), join(base, 'Alder.app/Contents/Resources/manifest.json')];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error(`application manifest is missing under ${base}`);
}

async function collectHashes(directory, prefix, result, root = directory) {
  const physicalRoot = await realpath(root);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const relativePath = prefix + entry.name;
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const physical = await realpath(path).catch(() => null);
      if (!physical || (physical !== physicalRoot && !physical.startsWith(physicalRoot + sep))) throw new Error('packaged output symlink escapes root: ' + relativePath);
      const targetInfo = await stat(path).catch(() => null);
      if (!targetInfo?.isDirectory() && (!targetInfo?.isFile() || targetInfo.nlink !== 1)) {
        throw new Error('packaged output symlink target is not a directory or regular, singly-linked file: ' + relativePath);
      }
      result[relativePath.split(sep).join('/')] = sha256Text(await readlink(path));
    } else if (info.isDirectory()) await collectHashes(path, relativePath + '/', result, root);
    else if (info.isFile()) {
      if (info.nlink !== 1) throw new Error('packaged output contains a hard-linked file: ' + relativePath);
      result[relativePath.split(sep).join('/')] = await sha256(path);
    } else throw new Error('packaged output contains a non-regular entry: ' + relativePath);
  }
}
async function readSignature() {
  const requested = values['signature-status'] ?? 'unsigned-development';
  if (!['unsigned-development', 'signed'].includes(requested)) throw new Error(`unsupported signature status: ${requested}`);
  if (!values['signature-record']) {
    if (requested === 'signed') throw new Error('signed packaging requires --signature-record');
    return { status: 'unsigned-development', label: 'UNSIGNED DEVELOPMENT ARTIFACT', authenticated: false, verified: false, reason: 'No release signing credentials were supplied' };
  }
  const record = JSON.parse(await readFile(resolve(values['signature-record']), 'utf8'));
  const candidate = record.signature ?? record;
  if (!candidate || candidate.status !== requested) throw new Error('signature record status does not match requested packaging status');
  if (requested === 'unsigned-development') {
    const reason = typeof candidate.reason === 'string' && candidate.reason ? candidate.reason : 'No release signing credentials were supplied';
    return { status: 'unsigned-development', label: 'UNSIGNED DEVELOPMENT ARTIFACT', authenticated: false, verified: false, reason };
  }
  if (typeof candidate.algorithm !== 'string' || !candidate.algorithm) {
    throw new Error('signed packaging requires an external signing algorithm');
  }
  return { status: 'signed', label: 'SIGNED RELEASE ARTIFACT', algorithm: candidate.algorithm };
}

function archiveFormatFor(requested, archivePath, platform) {
  const lower = archivePath.toLowerCase();
  const suffix = lower.endsWith('.tar.gz') || lower.endsWith('.tgz') ? 'tar.gz'
    : lower.endsWith('.zip') ? 'zip' : null;
  const format = requested ?? suffix ?? (platform === 'win32' ? 'zip' : 'tar.gz');
  if (!['tar.gz', 'zip'].includes(format)) throw new Error(`unsupported archive format: ${format}`);
  if (suffix && suffix !== format) throw new Error(`archive extension does not match format ${format}`);
  const expected = platform === 'win32' ? 'zip' : 'tar.gz';
  if (format !== expected) throw new Error(`${platform} headless archive must use ${expected}`);
  return format;
}

async function createArchive(source, destination, format) {
  if (await exists(destination)) throw new Error(`archive output already exists: ${destination}`);
  try {
    if (format === 'tar.gz') {
      execFileSync('tar', ['-czf', destination, '-C', source, '.'], { stdio: 'inherit', windowsHide: true });
    } else if (process.platform === 'win32') {
      const command = '$ErrorActionPreference = "Stop"; Compress-Archive -Path (Join-Path -Path $env:ALDER_ARCHIVE_SOURCE -ChildPath "*") -DestinationPath $env:ALDER_ARCHIVE_DESTINATION -CompressionLevel Optimal';
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        env: { ...process.env, ALDER_ARCHIVE_SOURCE: source, ALDER_ARCHIVE_DESTINATION: destination },
        stdio: 'inherit', windowsHide: true,
      });
    } else {
      execFileSync('zip', ['-q', '-r', destination, '.'], { cwd: source, stdio: 'inherit', windowsHide: true });
    }
  } catch (error) {
    throw new Error(`archive_creation_failed (${format}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isWithin(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + sep);
}

async function exists(path) { return stat(path).then(() => true).catch(() => false); }
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function sha256Text(text) { return createHash('sha256').update(text).digest('hex'); }
