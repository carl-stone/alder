import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

import { buildArk } from './build-ark.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '../..');
const LOCK_PATH = join(ROOT, 'host/ark-lock.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} failed (${code ?? `signal ${signal}`})`));
    });
  });
}

function targetKeyFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (key === 'linux-x64' || key === 'linux-arm64' || key === 'darwin-x64' || key === 'darwin-arm64' || key === 'win32-x64') return key;
  throw new Error(`No pinned Ark target for ${key}`);
}

async function readLock() {
  const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.version !== '0.1.252-alder.1' || lock.mimePublisher !== 'alder-json-v1') {
    throw new Error('Ark lock is not the pinned 0.1.252-alder.1 producer lock');
  }
  return lock;
}

async function extractArtifact(archive, destination) {
  await mkdir(destination, { recursive: true });
  await run('tar', ['--extract', '--gzip', '--file', archive, '--directory', destination, '--no-same-owner']);
}

async function requireRegularFile(directory, name) {
  const path = join(directory, name);
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Ark artifact entry ${name} is not a regular file`);
  return path;
}

export async function stageArk({
  output,
  archive,
  archiveOutput,
  platform = process.platform,
  arch = process.arch,
}) {
  const lock = await readLock();
  const target = targetKeyFor(platform, arch);
  const targetLock = lock.targets[target];
  if (!targetLock) throw new Error(`No pinned Ark target ${target}`);
  const expectedArtifact = targetLock.artifactSha256;
  if (typeof expectedArtifact !== 'string' || !/^[0-9a-f]{64}$/.test(expectedArtifact)) {
    throw new Error(`No verified patched Ark artifact is recorded for ${target}; an external pinned producer artifact is required`);
  }
  // verified release artifacts are checked against the target lock below

  let artifactPath;
  let artifactBytes;
  let producerManifest;
  if (archive) {
    artifactPath = resolve(archive);
    artifactBytes = await readFile(artifactPath);
    const actual = sha256(artifactBytes);
    if (actual !== expectedArtifact) throw new Error(`Patched Ark artifact SHA-256 mismatch: expected ${expectedArtifact}, got ${actual}`);
  } else {
    const buildDir = join(ROOT, 'host/.runtime/ark-build', target);
    producerManifest = await buildArk({ target, output: buildDir });
    artifactPath = join(buildDir, producerManifest.artifactFile);
    artifactBytes = await readFile(artifactPath);
    if (sha256(artifactBytes) !== expectedArtifact) {
      throw new Error(`Locally produced Ark artifact is not the pinned release artifact for ${target}; use the externally produced archive recorded in ark-lock.json`);
    }
    if (sha256(artifactBytes) !== producerManifest.artifactSha256) {
      throw new Error('Ark producer artifact changed after it was written');
    }
  }

  if (archiveOutput) {
    await mkdir(dirname(resolve(archiveOutput)), { recursive: true });
    await writeFile(resolve(archiveOutput), artifactBytes, { mode: 0o644 });
  }

  const staging = await mkdtemp(join(tmpdir(), 'alder-ark-stage-'));
  try {
    await extractArtifact(artifactPath, staging);
    const executable = platform === 'win32' ? 'ark.exe' : 'ark';
    const executablePath = await requireRegularFile(staging, executable);
    const licensePath = await requireRegularFile(staging, 'LICENSE');
    const noticePath = await requireRegularFile(staging, 'NOTICE');
    const provenancePath = await requireRegularFile(staging, 'ark-provenance.json');
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    const expectedProvenance = {
      schemaVersion: 1,
      implementation: 'ark',
      version: lock.version,
      upstreamVersion: lock.upstreamVersion,
      baseCommit: lock.baseCommit,
      mimePublisher: lock.mimePublisher,
      target,
      rustTarget: targetLock.rustTarget,
      sourceArchiveSha256: lock.sourceArchive.sha256,
      cargoLockSha256: lock.cargoLockSha256,
      patchSha256: lock.patch.sha256,
    };
    if (Object.entries(expectedProvenance).some(([key, value]) => provenance?.[key] !== value)
        || Object.entries(lock.rustToolchain).some(([key, value]) => provenance?.rustToolchain?.[key] !== value)) {
      throw new Error('Patched Ark artifact provenance does not match ark-lock.json');
    }
    const executableBytes = await readFile(executablePath);
    const executableSha256 = sha256(executableBytes);
    const expectedExecutable = targetLock.executableSha256;
    if (typeof expectedExecutable !== 'string' || executableSha256 !== expectedExecutable) {
      throw new Error('Patched Ark executable SHA-256 does not match the verified producer');
    }
    const destination = resolve(output ?? join(ROOT, 'host/.runtime'));
    await mkdir(destination, { recursive: true });
    const hashes = {};
    for (const [source, targetName] of [[executable, executable], ['LICENSE', 'ARK_LICENSE'], ['NOTICE', 'ARK_NOTICE']]) {
      const sourcePath = source === executable ? executablePath : source === 'LICENSE' ? licensePath : noticePath;
      const content = source === executable ? executableBytes : await readFile(sourcePath);
      await writeFile(join(destination, targetName), content, { mode: source === executable ? 0o755 : 0o644 });
      hashes[targetName] = source === executable ? executableSha256 : sha256(content);
    }

    const manifest = {
      schemaVersion: 1,
      implementation: 'ark',
      version: lock.version,
      upstreamVersion: lock.upstreamVersion,
      baseCommit: lock.baseCommit,
      mimePublisher: lock.mimePublisher,
      platform,
      arch,
      target,
      artifactSha256: sha256(artifactBytes),
      sourceArchiveSha256: lock.sourceArchive.sha256,
      cargoLockSha256: lock.cargoLockSha256,
      patchSha256: lock.patch.sha256,
      files: hashes,
    };
    await writeFile(join(destination, 'ark-provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      archive: { type: 'string' },
      'archive-output': { type: 'string' },
      platform: { type: 'string' },
      arch: { type: 'string' },
    },
  });
  const manifest = await stageArk({
    output: values.output,
    archive: values.archive,
    archiveOutput: values['archive-output'],
    platform: values.platform,
    arch: values.arch,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
