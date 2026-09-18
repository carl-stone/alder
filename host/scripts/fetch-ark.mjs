import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const release = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8')).config.ark;

export async function stageArk({ output = join(root, 'host/.runtime'), arch = process.arch } = {}) {
  if (process.platform !== 'darwin') throw new Error('Ark staging requires macOS');
  const platform = `darwin-${arch}`;
  const expectedHash = release.sha256[platform];
  if (!expectedHash) throw new Error(`No Ark release asset for ${platform}`);
  const asset = `ark-${release.version}-${platform}.zip`;
  const archive = join(root, 'host/.runtime/downloads', asset);
  await mkdir(dirname(archive), { recursive: true });

  let bytes = await readFile(archive).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    const response = await fetch(`https://github.com/posit-dev/ark/releases/download/${release.version}/${asset}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Ark release download failed (${response.status}): ${asset}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      throw new Error(`Ark release checksum mismatch: ${asset}`);
    }
    await writeFile(archive, bytes);
  }

  const staging = await mkdtemp(join(tmpdir(), 'alder-ark-'));
  try {
    execFileSync('unzip', ['-q', archive, '-d', staging], { stdio: 'inherit' });
    const destination = resolve(output);
    await mkdir(destination, { recursive: true });
    for (const [source, target] of [['ark', 'ark'], ['LICENSE', 'ARK_LICENSE'], ['NOTICE', 'ARK_NOTICE']]) {
      await copyFile(join(staging, source), join(destination, target));
    }
    await chmod(join(destination, 'ark'), 0o755);
    return { executable: join(destination, 'ark'), version: release.version };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, arch: { type: 'string' },
  } });
  process.stdout.write(JSON.stringify(await stageArk({ output: values.output, arch: values.arch })) + '\n');
}
