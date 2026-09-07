import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';

export async function stageArk({ output, archive, archiveOutput, platform = process.platform, arch = process.arch }) {
  const lock = JSON.parse(await readFile(new URL('../ark-lock.json', import.meta.url), 'utf8'));
  const asset = lock.assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`No pinned Ark binary for ${platform}-${arch}`);
  let bytes;
  if (archive) bytes = await readFile(archive);
  else {
    const response = await fetch(new URL(asset.file, lock.baseUrl), { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Ark download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Ark archive SHA-256 mismatch');
  if (archiveOutput) {
    await mkdir(dirname(archiveOutput), { recursive: true });
    await writeFile(archiveOutput, bytes);
  }
  const executable = platform === 'win32' ? 'ark.exe' : 'ark';
  const wanted = new Set([executable, 'LICENSE', 'NOTICE']);
  const files = unzipSync(bytes, { filter: file => wanted.has(basename(file.name)) });
  await mkdir(output, { recursive: true });
  const hashes = {};
  for (const name of wanted) {
    const matches = Object.entries(files).filter(([path]) => basename(path) === name);
    if (matches.length !== 1) throw new Error(`Ark archive must contain exactly one ${name}`);
    const content = matches[0][1], destination = name === executable ? name : `ARK_${name}`;
    await writeFile(join(output, destination), content, { mode: name === executable ? 0o755 : 0o644 });
    hashes[destination] = createHash('sha256').update(content).digest('hex');
  }
  const manifest = { version: lock.version, platform, arch, archiveSha256: asset.sha256, files: hashes };
  await writeFile(join(output, 'ark-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, archive: { type: 'string' }, 'archive-output': { type: 'string' } } });
  const output = resolve(values.output ?? join(dirname(fileURLToPath(import.meta.url)), '../.runtime'));
  process.stdout.write(`${JSON.stringify(await stageArk({ output, archive: values.archive, archiveOutput: values['archive-output'] }), null, 2)}\n`);
}
