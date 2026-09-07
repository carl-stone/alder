import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, '../inst/host');
const ark = JSON.parse(await readFile(resolve(root, 'ark-lock.json'), 'utf8'));
await mkdir(destination, { recursive: true });
const hostBuild = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: resolve(destination, 'alder-host.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  packages: 'bundle', legalComments: 'linked',
  external: ['zeromq'],
  metafile: true,
  banner: { js: "import { createRequire as __alderCreateRequire } from 'node:module'; const require = __alderCreateRequire(import.meta.url);" },
});
const browserBuild = await build({
  absWorkingDir: root,
  entryPoints: ['src/browser/app.ts'],
  outfile: resolve(root, '../inst/app/static/host-app.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  // Compile browser handlers during loading instead of their first interaction.
  banner: { js: '//# allFunctionsCalledOnLoad' },
  legalComments: 'linked',
  metafile: true,
});
const licenses = resolve(destination, 'licenses');
await rm(licenses, { recursive: true, force: true });
await mkdir(licenses);
const packages = new Map();
for (const input of [...Object.keys(hostBuild.metafile.inputs), ...Object.keys(browserBuild.metafile.inputs)]) {
  if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== root && dirname(directory) !== directory) {
    const pkg = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (pkg?.name && pkg?.version) {
      packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg });
      break;
    }
    directory = dirname(directory);
  }
}
const notices = {};
for (const [identity, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(name));
  if (!names.length) throw new Error(`Bundled dependency lacks license text: ${identity}`);
  const target = identity.replaceAll('/', '__');
  await mkdir(resolve(licenses, target));
  for (const name of names) await cp(resolve(directory, name), resolve(licenses, target, name), { recursive: true });
  notices[identity] = { license: pkg.license, files: names.map(name => `${target}/${name}`) };
}
await writeFile(resolve(licenses, 'index.json'), `${JSON.stringify(notices, null, 2)}\n`);
await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify({
  hostVersion: '0.1.0', protocol: 1, packageVersion: '0.1.0',
  minimumNodeVersion: '24.20.0', entrypoint: 'alder-host.mjs',
  kernel: { name: 'ark', version: ark.version },
}, null, 2)}\n`);
