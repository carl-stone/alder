import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8')).version;
execFileSync(process.execPath, [join(root, 'host/scripts/package.mjs'),
  '--output', join(root, 'host/.release'), '--r-package', join(root, `alder_${version}.tar.gz`),
  '--ark-archive', join(root, 'host/.runtime/ark.zip'),
], { stdio: 'inherit' });
