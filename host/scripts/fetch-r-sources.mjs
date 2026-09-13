import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLockedRSourceArchives } from './r-package-provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2];
if (!output || !isAbsolute(output)) {
  throw new Error('Usage: node host/scripts/fetch-r-sources.mjs ABSOLUTE_EMPTY_DIRECTORY');
}

await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) {
  throw new Error(`R source cache must be empty: ${output}`);
}

const lock = JSON.parse(await readFile(join(root, 'host/r-library.lock.json'), 'utf8'));
const { archives } = await readLockedRSourceArchives(lock);
for (const [packageName, bytes] of archives) {
  const archiveName = basename(new URL(lock.Packages[packageName].SourceArchive).pathname);
  await writeFile(join(output, archiveName), bytes, { flag: 'wx', mode: 0o644 });
}

process.stdout.write(`${archives.size} verified R source archives cached\n`);
