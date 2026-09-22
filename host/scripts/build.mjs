import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, '../inst/host');
await mkdir(destination, { recursive: true });
const hostBuild = await build({
  absWorkingDir: root,
  entryPoints: { 'alder-host': 'src/main.ts', 'alder-backend': 'src/backend.ts', 'ark-guardian': 'src/ark-guardian.ts' },
  outdir: destination, outExtension: { '.js': '.mjs' },
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
const supplementalLicenseRoot = resolve(root, 'licenses');
const packageTarget = identity => identity.replaceAll('/', '__');
const licenseNames = async directory => (await readdir(directory).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
})).filter(name => /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(name));
const missing = [];
for (const [identity, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  let source = directory;
  let names = await licenseNames(source);
  if (!names.length) {
    source = resolve(supplementalLicenseRoot, packageTarget(identity));
    names = await licenseNames(source);
  }
  if (!names.length) {
    missing.push(identity);
    continue;
  }
  const target = packageTarget(identity);
  await mkdir(resolve(licenses, target));
  for (const name of names) await cp(resolve(source, name), resolve(licenses, target, name), { recursive: true });
  notices[identity] = {
    license: pkg.license,
    files: names.map(name => target + '/' + name),
  };
}
if (missing.length) throw new Error('Bundled dependencies lack license text: ' + missing.join(', '));
await writeFile(resolve(licenses, 'index.json'), `${JSON.stringify(notices, null, 2)}\n`);
