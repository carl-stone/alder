import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = join(root, 'host/air-lock.json');

export async function stageAir({ output = join(root, 'host/.runtime'), archive } = {}) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.schemaVersion !== 1 || typeof lock.version !== 'string' || !lock.assets) throw new Error('Air lock is not schema version 1');
  const pinnedLicense = lock.license;
  if (!pinnedLicense || pinnedLicense.spdx !== 'MIT' || typeof pinnedLicense.file !== 'string' || typeof pinnedLicense.source !== 'string' || typeof pinnedLicense.sourceTag !== 'string' || !/^[0-9a-f]{40}$/.test(pinnedLicense.sourceCommit ?? '') || !/^[0-9a-f]{64}$/.test(pinnedLicense.sha256 ?? '')) {
    throw new Error('Air lock is missing pinned official license provenance');
  }
  const pinnedLicensePath = resolve(root, pinnedLicense.file);
  const pinnedLicenseRelative = relative(root, pinnedLicensePath);
  if (!pinnedLicenseRelative || pinnedLicenseRelative.startsWith('..') || isAbsolute(pinnedLicenseRelative)) throw new Error('Air pinned license path escapes the repository');
  const pinnedLicenseBytes = await readFile(pinnedLicensePath);
  if (sha256Bytes(pinnedLicenseBytes) !== pinnedLicense.sha256) throw new Error('Air pinned license SHA-256 mismatch');
  const target = `${process.platform}-${process.arch}`;
  const targetLock = lock.assets[target];
  if (!targetLock?.file || !/^[0-9a-f]{64}$/.test(targetLock.sha256)) throw new Error(`No pinned Air target ${target}`);
  const archivePath = resolve(archive ?? process.env.ALDER_AIR_ARCHIVE ?? join(root, 'host/.runtime/air-build', target, targetLock.file));
  await mkdir(dirname(archivePath), { recursive: true });
  if (!await exists(archivePath)) {
    const url = `${String(lock.baseUrl).replace(/\/$/, '')}/${targetLock.file}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Air download failed (${response.status}): ${url}`);
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()), { mode: 0o644 });
  }
  const archiveSha256 = await sha256(archivePath);
  if (archiveSha256 !== targetLock.sha256) throw new Error(`Air archive SHA-256 mismatch: expected ${targetLock.sha256}, got ${archiveSha256}`);

  const staging = await mkdtemp(join(tmpdir(), 'alder-air-stage-'));
  try {
    if (targetLock.file.endsWith('.zip')) execFileSync('unzip', ['-q', archivePath, '-d', staging]);
    else execFileSync('tar', ['--extract', '--gzip', '--file', archivePath, '--directory', staging, '--no-same-owner']);
    const executableName = 'air';
    const executable = await findFile(staging, executableName);
    const destination = resolve(output);
    await mkdir(destination, { recursive: true });
    await cp(executable, join(destination, executableName));
    await chmod(join(destination, executableName), 0o755);
    await writeFile(join(destination, 'AIR_LICENSE'), pinnedLicenseBytes, { mode: 0o644 });
    const manifest = {
      schemaVersion: 1,
      implementation: 'air',
      version: lock.version,
      releaseTag: lock.releaseTag,
      target,
      archive: targetLock.file,
      archiveSha256,
      executable: executableName,
      executableSha256: await sha256(executable),
      licenseFiles: ['AIR_LICENSE'],
      license: {
        spdx: pinnedLicense.spdx,
        source: pinnedLicense.source,
        sourceTag: pinnedLicense.sourceTag,
        sourceCommit: pinnedLicense.sourceCommit,
        sha256: pinnedLicense.sha256,
      },
    };
    await writeFile(join(destination, 'air-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { executable: join(destination, executableName), manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    } else if (entry.isFile() && entry.name === name) return path;
  }
  throw new Error(`Air archive does not contain ${name}`);
}
async function exists(path) { return stat(path).then(() => true).catch(() => false); }
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await stageAir({ archive: process.argv[2] });
  process.stdout.write(`${JSON.stringify(result.manifest)}\n`);
}
