import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';
const { values } = parseArgs({ options: {
  output: { type: 'string' },
  application: { type: 'string' },
  kind: { type: 'string' },
  archive: { type: 'string' },
  'archive-format': { type: 'string' },
  'artifact-record': { type: 'string' },
  'signature-record': { type: 'string' },
  'signature-status': { type: 'string' },
  'target-platform': { type: 'string' },
  'target-arch': { type: 'string' },
  rscript: { type: 'string' },
  'qualified-rscript': { type: 'string', multiple: true },
  ark: { type: 'string' },
  air: { type: 'string' },
  supervisor: { type: 'string' },
  'supervisor-provenance': { type: 'string' },
  'electron-entry': { type: 'string' },
  'forge-output': { type: 'string' },
  'forge-make-output': { type: 'string' },
  'forge-artifact': { type: 'string', multiple: true },
  'forge-artifact-record': { type: 'string' },
  evidence: { type: 'string' },
  'source-commit': { type: 'string' },
  'internal-one': { type: 'boolean' },
}, allowPositionals: false });

if (!values.output) throw new Error('Usage: node scripts/ci-package.mjs --output EMPTY_DIR --rscript ABSOLUTE_RSCRIPT --forge-make-output FORGE_MAKE_DIR [--qualified-rscript ABSOLUTE_RSCRIPT]');
if (values.application && !values['internal-one']) throw new Error('ci-package produces the required dual-variant release; use scripts/package.mjs for a single staged tree');
if (values['internal-one'] && !values.application) throw new Error('internal single-variant packaging requires --application');
requireAbsoluteRscript(values.rscript);
for (const candidate of values['qualified-rscript'] ?? []) requireAbsoluteRscript(candidate);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { readApplicationManifest } = await tsImport('../src/resources.ts', { parentURL: import.meta.url });

if (!values.application) {
  const result = await packageBoth();
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const result = await packageOne({
    application: resolve(values.application),
    output: resolve(values.output),
    kind: values.kind ?? (values.application.includes('desktop') ? 'desktop' : 'headless'),
    target: requestedTarget(),
    archive: values.archive ? resolve(values.archive) : undefined,
    artifactRecord: values['artifact-record'] ? resolve(values['artifact-record']) : undefined,
    evidence: values.evidence ? resolve(values.evidence) : undefined,
    canonical: false,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function packageBoth() {
  if (values.kind || values.archive || values['artifact-record'] || values['forge-artifact-record']) {
    throw new Error('dual packaging does not accept --kind, --archive, --artifact-record, or --forge-artifact-record');
  }
  const target = requestedTarget();
  const output = resolve(values.output);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error(`Release qualification output directory must be empty: ${output}`);

  const headlessOutput = join(output, 'headless');
  const desktopOutput = join(output, 'desktop');
  const headlessRecord = join(output, 'headless-artifact-record.json');
  const desktopRecord = join(output, 'desktop-artifact-record.json');
  const archiveFormat = values['archive-format'] ?? (target.platform === 'win32' ? 'zip' : 'tar.gz');
  const archive = join(dirname(output), `${basename(output)}-headless-${target.platform}-${target.arch}.${archiveFormat}`);
  const headlessApplication = resolve(join(root, 'host/.application'));
  const desktopApplication = resolve(join(root, 'host/.application-desktop'));

  await runChildPackage({
    application: headlessApplication,
    output: headlessOutput,
    kind: 'headless',
    target,
    archive,
    artifactRecord: headlessRecord,
    evidence: values.evidence ? join(resolve(values.evidence), 'headless') : undefined,
  });
  if (!(await exists(headlessRecord))) throw new Error('headless packaging did not produce its artifact record');

  const forgeRequested = (values['forge-artifact'] ?? []).length > 0 || Boolean(values['forge-make-output']);
  if (!forgeRequested) throw new Error('desktop dual packaging requires --forge-make-output or --forge-artifact');
  await runChildPackage({
    application: desktopApplication,
    output: desktopOutput,
    kind: 'desktop',
    target,
    forgeArtifactRecord: desktopRecord,
    evidence: values.evidence ? join(resolve(values.evidence), 'desktop') : undefined,
  });
  if (!(await exists(desktopRecord))) throw new Error('desktop packaging did not produce its Forge artifact record');

  const headless = await readJsonRequired(headlessRecord, 'headless artifact record');
  const desktop = await readJsonRequired(desktopRecord, 'desktop artifact record');
  validateExternalRecord(headless, 'headless', target);
  validateExternalRecord(desktop, 'desktop', target);
  const aggregate = {
    schemaVersion: 1,
    target,
    variants: {
      headless: {
        kind: 'headless',
        root: 'headless',
        artifactRecord: relative(output, headlessRecord).split(sep).join('/'),
        record: headless,
      },
      desktop: {
        kind: 'desktop',
        root: 'desktop',
        artifactRecord: relative(output, desktopRecord).split(sep).join('/'),
        record: desktop,
      },
    },
  };
  const aggregatePath = join(output, 'release-record.json');
  await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2) + '\n');
  if (values.evidence) {
    const evidence = resolve(values.evidence);
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'package-identity.json'), JSON.stringify({
      output,
      releaseRecord: aggregatePath,
      target,
      variants: Object.fromEntries(Object.entries(aggregate.variants).map(([name, variant]) => [name, {
        kind: variant.kind,
        root: join(output, variant.root),
        artifactRecord: join(output, variant.artifactRecord),
        releaseManifestSha256: variant.record.releaseManifestSha256,
      }])),
    }, null, 2) + '\n');
  }
  return {
    output,
    target,
    releaseRecord: aggregatePath,
    variants: {
      headless: { output: headlessOutput, artifactRecord: headlessRecord, archive },
      desktop: { output: desktopOutput, artifactRecord: desktopRecord },
    },
  };
}

async function runChildPackage({ application, output, kind, target, archive, artifactRecord, forgeArtifactRecord, evidence }) {
  const args = [fileURLToPath(import.meta.url), '--application', application, '--kind', kind, '--output', output,
    '--target-platform', target.platform, '--target-arch', target.arch];
  args.push('--internal-one');
  if (archive) args.push('--archive', archive);
  if (artifactRecord) args.push('--artifact-record', artifactRecord);
  if (forgeArtifactRecord) args.push('--forge-artifact-record', forgeArtifactRecord);
  if (evidence) args.push('--evidence', evidence);
  for (const [option, value] of [
    ['--rscript', values.rscript],
    ['--signature-record', values['signature-record']],
    ['--signature-status', values['signature-status']],
    ['--source-commit', values['source-commit']],
    ['--ark', values.ark],
    ['--air', values.air],
    ['--supervisor', values.supervisor],
    ['--supervisor-provenance', values['supervisor-provenance']],
  ]) {
    if (value) args.push(option, value);
  }
  if (kind === 'desktop') {
    for (const [option, value] of [
      ['--electron-entry', values['electron-entry']],
      ['--forge-output', values['forge-output']],
      ['--forge-make-output', values['forge-make-output']],
    ]) {
      if (value) args.push(option, value);
    }
  }
  for (const value of values['qualified-rscript'] ?? []) args.push('--qualified-rscript', value);
  if (kind === 'desktop') for (const value of values['forge-artifact'] ?? []) args.push('--forge-artifact', value);
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
}

async function packageOne({ application, output, kind, target, archive, artifactRecord: requestedArtifactRecord, evidence }) {
  if (!['headless', 'desktop'].includes(kind)) throw new Error(`unsupported application kind: ${kind}`);
  if (kind === 'desktop' && requestedArtifactRecord) throw new Error('desktop packaging does not accept an archive artifact record');
  assertCurrentTarget(target);
  await stageApplication(application, kind);
  const actualArchive = archive ?? (kind === 'headless'
    ? resolve(join(dirname(output), `alder-${kind}-${target.platform}-${target.arch}.${target.platform === 'win32' ? 'zip' : 'tar.gz'}`))
    : null);
  const artifactRecord = actualArchive
    ? resolve(requestedArtifactRecord ?? join(dirname(actualArchive), 'artifact-record.json'))
    : null;
  const packageArgs = [join(root, 'host/scripts/package.mjs'), '--application', application, '--output', output,
    '--target-platform', target.platform, '--target-arch', target.arch, '--rscript', requireAbsoluteRscript(values.rscript)];
  for (const [option, value] of [
    ['--source-commit', values['source-commit']],
    ['--archive', actualArchive],
    ['--archive-format', values['archive-format']],
    ['--artifact-record', artifactRecord],
    ['--signature-record', values['signature-record']],
    ['--signature-status', values['signature-status']],
  ]) {
    if (value) packageArgs.push(option, value);
  }
  const packageStdout = execFileSync(process.execPath, packageArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    windowsHide: true,
  });
  process.stdout.write(packageStdout);
  const packageIdentity = parseLastJson(packageStdout);
  const applicationManifestPath = await findManifest(output);
  const applicationRoot = dirname(dirname(applicationManifestPath));
  const applicationManifest = await readApplicationManifest(applicationRoot);
  const packageRecord = artifactRecord ? await readJsonRequired(artifactRecord, 'artifact record') : null;
  const releaseManifest = packageRecord?.releaseManifest
    ?? await buildReleaseManifest(applicationManifestPath, output, kind, target, packageIdentity, applicationManifest);
  validateReleaseManifest(releaseManifest, kind, target);
  const forgeRecord = await writeForgeRecord(releaseManifest, output, applicationManifestPath);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'package-identity.json'), JSON.stringify({
      application,
      output,
      applicationManifest: applicationManifestPath,
      releaseManifestSha256: packageRecord?.releaseManifestSha256 ?? sha256Text(JSON.stringify(releaseManifest, null, 2) + '\n'),
      archiveRecord: artifactRecord,
      forgeRecord,
      signature: releaseManifest.signature,
    }, null, 2) + '\n');
  }
  return { application, output, kind, target, applicationManifest: applicationManifestPath, archive: actualArchive, artifactRecord, forgeRecord, signature: releaseManifest.signature };
}

async function stageApplication(application, kind) {
  await mkdir(application, { recursive: true });
  if ((await readdir(application)).length !== 0) {
    await findManifest(application);
    return;
  }
  if (kind === 'desktop' && (!values['electron-entry'] || !values['forge-output'])) {
    throw new Error('desktop CI packaging requires the actual Forge root via --forge-output and --electron-entry');
  }
  const args = [join(root, 'host/scripts/stage-application.mjs'), '--output', application, '--kind', kind];
  for (const [option, value] of [
    ['--rscript', values.rscript],
    ['--ark', values.ark],
    ['--air', values.air],
    ['--supervisor', values.supervisor],
    ['--supervisor-provenance', values['supervisor-provenance']],
    ['--electron-entry', values['electron-entry']],
    ['--forge-output', values['forge-output']],
    ['--source-commit', values['source-commit']],
  ]) {
    if (value) args.push(option, value);
  }
  for (const value of values['qualified-rscript'] ?? []) args.push('--qualified-rscript', value);
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
}

async function writeForgeRecord(releaseManifest, releaseRoot, applicationManifestPath) {
  const requested = [...(values['forge-artifact'] ?? [])];
  if (values['forge-make-output']) requested.push(resolve(values['forge-make-output']));
  if (requested.length === 0) return null;
  if (releaseManifest.kind !== 'desktop') throw new Error('Forge artifacts can only accompany a desktop release');
  const paths = [];
  for (const requestedPath of requested) {
    const path = resolve(requestedPath);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error('Forge artifact is missing: ' + path);
    if (info.isDirectory()) await collectFiles(path, paths);
    else if (info.isFile()) paths.push(path);
    else throw new Error('Forge artifact is not a file or directory: ' + path);
  }
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) throw new Error('Forge make output contains no files');
  const recordPath = resolve(values['forge-artifact-record'] ?? values['artifact-record'] ?? (releaseRoot + '-forge-artifacts.json'));
  if (isWithin(releaseRoot, recordPath)) throw new Error('Forge artifact record must be outside the release output directory');
  const artifacts = [];
  for (const path of unique) {
    if (isWithin(releaseRoot, path)) throw new Error('Forge artifacts must be outside the staged release root: ' + path);
    const info = await stat(path);
    artifacts.push({
      name: basename(path),
      path: relative(dirname(recordPath), path).split(sep).join('/'),
      format: artifactFormat(path),
      bytes: info.size,
      sha256: await sha256(path),
    });
  }
  assertForgeFormats(artifacts, releaseManifest.target.platform);
  const canonicalCandidates = artifacts.filter(artifact => artifact.format === 'zip');
  if (canonicalCandidates.length !== 1) throw new Error('Forge output must contain exactly one canonical zip artifact');
  const canonical = canonicalCandidates[0];
  const canonicalPath = resolve(dirname(recordPath), canonical.path);
  const prefix = await inspectZipPrefix(canonicalPath);
  const qualifiedManifest = {
    ...releaseManifest,
    archive: {
      format: canonical.format,
      name: canonical.name,
      record: basename(recordPath),
      prefix,
    },
  };
  const canonicalArtifact = { ...canonical, prefix };
  const record = {
    schemaVersion: 1,
    kind: 'desktop',
    target: qualifiedManifest.target,
    release: {
      root: relative(dirname(recordPath), releaseRoot).split(sep).join('/'),
      applicationManifest: relative(dirname(recordPath), applicationManifestPath).split(sep).join('/'),
      manifestSha256: await sha256(applicationManifestPath),
    },
    releaseManifest: qualifiedManifest,
    releaseManifestSha256: sha256Text(JSON.stringify(qualifiedManifest, null, 2) + '\n'),
    artifact: canonicalArtifact,
    artifacts,
    signature: qualifiedManifest.signature,
  };
  if (qualifiedManifest.signature?.verification) record.verification = qualifiedManifest.signature.verification;
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
  return recordPath;
}

function requireAbsoluteRscript(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('CI packaging requires --rscript as an absolute executable path');
  return resolve(value);
}
async function inspectZipPrefix(path) {
  const bytes = await readFile(path);
  const endOfCentralDirectory = findZipEnd(bytes);
  const entryCount = bytes.readUInt16LE(endOfCentralDirectory + 10);
  const centralDirectorySize = bytes.readUInt32LE(endOfCentralDirectory + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(endOfCentralDirectory + 16);
  if (entryCount === 0 || centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw new Error('Forge canonical zip has no valid central directory');
  }
  const names = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Forge canonical zip central directory is malformed');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error('Forge canonical zip entry is truncated');
    names.push(bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset = end;
  }
  if (offset > centralDirectoryOffset + centralDirectorySize) throw new Error('Forge canonical zip central directory is malformed');
  const roots = new Set();
  for (const name of names) {
    const normalized = validateArchiveEntryName(name);
    if (normalized.length === 0) continue;
    roots.add(normalized.split('/')[0]);
  }
  if (roots.size !== 1) throw new Error('Forge canonical zip must contain exactly one top-level root');
  const root = [...roots][0];
  if (!names.some(name => validateArchiveEntryName(name) === root + '/')) {
    throw new Error('Forge canonical zip top-level root is not a directory');
  }
  return root + '/';
}

function findZipEnd(bytes) {
  const minimum = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Forge canonical zip has no end-of-central-directory record');
}

function validateArchiveEntryName(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    throw new Error('Forge canonical zip contains an unsafe entry path');
  }
  const trimmed = name.replace(/\/+$/u, '');
  if (trimmed === '') return '';
  const parts = trimmed.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Forge canonical zip contains an unsafe entry path: ' + name);
  }
  return parts.join('/');
}

function isSafeArchivePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('\\')) return false;
  const trimmed = prefix.slice(0, -1);
  return trimmed.length > 0 && trimmed.split('/').every(part => part && part !== '.' && part !== '..');
}

function requestedTarget() {
  return {
    platform: values['target-platform'] ?? process.platform,
    arch: values['target-arch'] ?? process.arch,
  };
}

function assertCurrentTarget(target) {
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(`target ${target.platform}/${target.arch} does not match packaging host ${process.platform}/${process.arch}`);
  }
}

function validateExternalRecord(record, kind, target) {
  if (!record || record.schemaVersion !== 1 || record.kind !== kind
      || record.target?.platform !== target.platform || record.target?.arch !== target.arch) {
    throw new Error(`${kind} artifact record identity does not match the requested target`);
  }
  if (!record.release || typeof record.release.root !== 'string' || typeof record.release.applicationManifest !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.release.manifestSha256)
      || !record.releaseManifest || !/^[0-9a-f]{64}$/.test(record.releaseManifestSha256)) {
    throw new Error(`${kind} artifact record has an invalid release identity`);
  }
  validateReleaseManifest(record.releaseManifest, kind, target);
  if (kind === 'desktop') {
    if (!Array.isArray(record.artifacts) || !record.artifact) throw new Error('desktop artifact record must identify its canonical archive');
    const zipArtifacts = record.artifacts.filter(artifact => artifact?.format === 'zip');
    if (zipArtifacts.length !== 1 || zipArtifacts[0].path !== record.artifact.path
        || zipArtifacts[0].sha256 !== record.artifact.sha256 || record.artifact.prefix !== record.releaseManifest.archive.prefix) {
      throw new Error('desktop artifact record has an ambiguous canonical archive');
    }
  }
}

function validateReleaseManifest(manifest, kind, target) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== kind
      || manifest.target?.platform !== target.platform || manifest.target?.arch !== target.arch
      || typeof manifest.applicationManifest !== 'string' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('packaged release identity does not match requested kind/target');
  }
  if (kind === 'desktop') {
    const archive = manifest.archive;
    if (!archive || archive.format !== 'zip' || typeof archive.name !== 'string' || !archive.name
        || typeof archive.record !== 'string' || !archive.record || !isSafeArchivePrefix(archive.prefix)) {
      throw new Error('desktop release manifest has no exact archive descriptor');
    }
  }
}

async function buildReleaseManifest(applicationManifestPath, releaseRoot, kind, target, packageIdentity, manifest) {
  const rootPath = resolve(releaseRoot);
  if (!isWithin(rootPath, applicationManifestPath)) throw new Error('application manifest must be inside the release root');
  const files = {};
  await collectHashes(rootPath, '', files);
  const packageJson = await readJsonRequired(join(root, 'host/package.json'), 'host package metadata');
  return {
    schemaVersion: 1,
    platform: target.platform,
    arch: target.arch,
    nodeVersion: process.version,
    kind,
    applicationVersion: manifest.applicationVersion,
    sourceCommit: manifest.sourceCommit,
    sourceTreeSha256: manifest.sourceTreeSha256,
    hostProtocol: manifest.hostProtocol,
    engineProtocol: manifest.engineProtocol,
    target,
    rVersionRange: manifest.rVersionRange,
    qualifiedRPatchVersions: manifest.qualifiedRPatchVersions,
    rBuildVersion: manifest.rBuildVersion,
    runtimes: manifest.runtimes,
    packageVersion: packageJson.version,
    applicationManifest: relative(rootPath, applicationManifestPath).split(sep).join('/'),
    manifestSha256: packageIdentity.manifestSha256 ?? await sha256(applicationManifestPath),
    archive: null,
    signature: packageIdentity.signature ?? { status: 'unsigned-development', label: 'UNSIGNED DEVELOPMENT ARTIFACT', authenticated: false, verified: false, reason: 'No release signing credentials were supplied' },
    files,
  };
}

async function collectFiles(directory, result) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
}

async function collectHashes(directory, prefix, result) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collectHashes(path, `${relativePath}/`, result);
    else if (entry.isFile()) result[relativePath.split(sep).join('/')] = await sha256(path);
  }
}

function artifactFormat(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  const extension = lower.slice(lower.lastIndexOf('.') + 1);
  return extension || 'file';
}

function assertForgeFormats(artifacts, platform) {
  const formats = new Set(artifacts.map(artifact => artifact.format));
  const required = platform === 'linux' ? ['zip', 'deb', 'rpm']
    : platform === 'darwin' ? ['zip', 'dmg']
      : ['zip'];
  for (const format of required) if (!formats.has(format)) throw new Error(`Forge make output is missing required ${format} artifact for ${platform}`);
  if (platform === 'win32' && !artifacts.some(artifact => ['exe', 'msi', 'nupkg'].includes(artifact.format))) {
    throw new Error('Forge make output is missing a Windows installer artifact');
  }
}

async function findManifest(base) {
  const candidates = ['resources/manifest.json', 'Resources/manifest.json', 'Alder.app/Contents/Resources/manifest.json'];
  for (const candidate of candidates) if (await exists(join(base, candidate))) return join(base, candidate);
  throw new Error(`packaged application manifest is missing under ${base}`);
}

async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

async function readJsonRequired(path, label) {
  const text = await readFile(path, 'utf8').catch(error => {
    throw new Error(`${label} is unavailable at ${path}: ${error.message}`);
  });
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} is invalid JSON at ${path}: ${error.message}`); }
}

function parseLastJson(text) {
  const lines = String(text).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`packaging child must emit exactly one JSON record, received ${lines.length}`);
  try { return JSON.parse(lines[0]); }
  catch (error) { throw new Error(`packaging child emitted invalid JSON: ${error.message}`); }
}

function isWithin(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}