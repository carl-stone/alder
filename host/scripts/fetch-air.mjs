import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function stageAir({ output = join(root, 'host/.runtime'), archive, cacheDirectory = join(root, 'host/.runtime/air-build') } = {}) {
  const lock = JSON.parse(await readFile(join(root, 'host/air-lock.json'), 'utf8'));
  const target = `${process.platform}-${process.arch}`;
  const asset = lock.assets[target];
  if (!asset) throw new Error(`No Air download for ${target}`);
  const archivePath = resolve(archive ?? process.env.ALDER_AIR_ARCHIVE ?? join(cacheDirectory, asset.file));
  await mkdir(dirname(archivePath), { recursive: true });
  if (!await stat(archivePath).catch(() => null)) {
    const response = await fetch(`${lock.baseUrl}/${asset.file}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Air download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, asset.file, asset.sha256);
    await writeFile(archivePath, bytes);
  }
  verifyArchive(await readFile(archivePath), asset.file, asset.sha256);
  const staging = await mkdtemp(join(tmpdir(), 'alder-air-stage-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', staging]);
    const executable = await findFile(staging, 'air');
    if (!executable) throw new Error('Air archive does not contain air');
    const destination = resolve(output);
    await mkdir(destination, { recursive: true });
    await cp(executable, join(destination, 'air'));
    await chmod(join(destination, 'air'), 0o755);
    await cp(join(root, lock.license.file), join(destination, 'AIR_LICENSE'));
    return { executable: join(destination, 'air'), version: lock.version };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function verifyArchive(bytes, file, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error(`Air archive checksum is missing: ${file}`);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) throw new Error(`Air archive checksum mismatch: ${file}`);
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    } else if (entry.isFile() && entry.name === name) return path;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await stageAir({ archive: process.argv[2] })) + '\n');
}
