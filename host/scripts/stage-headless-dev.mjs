import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: {
  output: { type: 'string', default: join(root, 'host/.application-dev') },
  ark: { type: 'string' },
  'r-library': { type: 'string' },
} });
const output = resolve(values.output);
const ark = values.ark === undefined ? null : await realpath(resolve(values.ark));
const rLibrary = values['r-library'] === undefined ? null : await realpath(resolve(values['r-library']));
if (ark !== null) {
  const info = await stat(ark);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error(`Ark is not executable: ${ark}`);
}
if (rLibrary !== null && !(await stat(rLibrary)).isDirectory()) throw new Error(`R library is not a directory: ${rLibrary}`);
const marker = '.alder-headless-development';
const previous = await lstat(output).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (previous && (!previous.isDirectory() || !(await stat(join(output, marker)).catch(() => null))?.isFile())) {
  throw new Error(`Output is not a staged Alder development root: ${output}`);
}
for (const path of [
  join(root, 'inst/host/alder-host.mjs'),
  join(root, 'inst/host/alder-backend.mjs'),
  join(root, 'inst/app/index.html'),
  join(root, 'inst/app/static'),
  join(root, 'inst/worker'),
  join(root, 'host/node_modules/zeromq'),
]) {
  if (!await stat(path).catch(() => null)) throw new Error(`Build the host and install its dependencies before staging: ${path}`);
}

await mkdir(dirname(output), { recursive: true });
const temporary = await mkdtemp(output + '.building-');
try {
  await mkdir(join(temporary, 'bin'));
  await mkdir(join(temporary, 'host'));
  await mkdir(join(temporary, 'runtime'));
  if (rLibrary === null) await mkdir(join(temporary, 'r-library'));
  else await cp(rLibrary, join(temporary, 'r-library'), { recursive: true });
  await cp(join(root, 'inst/host'), join(temporary, 'host'), { recursive: true });
  await symlink(join(root, 'host/node_modules'), join(temporary, 'host/node_modules'));
  await symlink(join(root, 'inst/app'), join(temporary, 'app'));
  await cp(join(root, 'inst/worker'), join(temporary, 'worker'), { recursive: true });
  await symlink(process.execPath, join(temporary, 'bin/node'));
  if (ark !== null) await symlink(ark, join(temporary, 'runtime/ark'));

  const version = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8')).version;
  const manifest = {
    schemaVersion: 1, kind: 'headless', applicationVersion: version,
    resources: {
      cliLauncher: 'bin/alder', hostEntry: 'host/alder-host.mjs', rendererDirectory: 'app',
      workerDirectory: 'worker', rLibraryDirectory: 'r-library', arkExecutable: 'runtime/ark',
      airExecutable: 'runtime/air', quartoExecutable: 'runtime/quarto/bin/quarto',
      nodeExecutable: 'bin/node', electronEntry: null,
    },
  };
  await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(temporary, marker), 'Development root; resources come from the checkout and installed tools.\n');
  await writeFile(join(temporary, 'bin/alder'),
    '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/bin/node" "$root/host/alder-host.mjs" "$@"\n',
    { mode: 0o755 });

  if (previous) await rm(output, { recursive: true });
  await rename(temporary, output);
  process.stdout.write(join(output, 'bin/alder') + '\n');
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
