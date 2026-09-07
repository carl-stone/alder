import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Native dependencies stay in the platform distribution, outside the R source
// archive. This copies installed, lockfile-resolved modules without installing.
export async function stageNative(output) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const names = new Set(['zeromq', 'cmake-ts', 'node-addon-api']);
  const versions = {};
  for (const name of names) {
    const source = join(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (!names.has(dependency)) throw new Error(`Unpackaged native dependency: ${dependency}`);
    }
    await mkdir(join(output, 'node_modules'), { recursive: true });
    await cp(source, join(output, 'node_modules', name), { recursive: true });
    versions[name] = pkg.version;
  }
  const require = createRequire(join(output, 'package.json'));
  const zeromq = require('zeromq');
  const probe = new zeromq.Dealer();
  probe.close();
  await writeFile(join(output, 'native-manifest.json'), `${JSON.stringify({
    platform: process.platform, arch: process.arch, nodeVersion: process.version, modules: versions,
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/stage-native.mjs HOST_DIRECTORY');
  await stageNative(resolve(process.argv[2]));
}
