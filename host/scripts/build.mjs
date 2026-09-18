import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { normalizeHostBundleWhitespace } from './bundle-normalization.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, '../inst/host');
await mkdir(destination, { recursive: true });
const hostBundle = resolve(destination, 'alder-host.mjs');
const hostBuild = await build({
  absWorkingDir: root,
  entryPoints: { 'alder-host': 'src/main.ts', 'alder-backend': 'src/backend.ts' },
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
await normalizeHostBundleWhitespace(hostBundle);
await normalizeHostBundleWhitespace(resolve(destination, 'alder-backend.mjs'));
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
const pinnedLicenseRoot = resolve(root, 'licenses');
const packageTarget = identity => identity.replaceAll('/', '__');
const readPinnedLicense = async (identity, pkg) => {
  const target = packageTarget(identity);
  const metadataPath = resolve(pinnedLicenseRoot, target + '.json');
  const metadata = await readFile(metadataPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return null;
  const sourceFile = resolve(pinnedLicenseRoot, metadata.file);
  const sourceRelative = relative(pinnedLicenseRoot, sourceFile);
  if (!sourceRelative || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) {
    throw new Error('Pinned license path escapes input directory: ' + identity);
  }
  return { metadata, sourceFile, fileName: sourceRelative.split(/[\\/]/).pop() };
};
const missing = [];
for (const [identity, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  let names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(name));
  const pinned = names.length ? null : await readPinnedLicense(identity, pkg);
  if (pinned) names = [pinned.fileName];
  if (!names.length) {
    missing.push(identity);
    continue;
  }
  const target = packageTarget(identity);
  await mkdir(resolve(licenses, target));
  if (pinned) {
    await cp(pinned.sourceFile, resolve(licenses, target, pinned.fileName));
  } else {
    for (const name of names) await cp(resolve(directory, name), resolve(licenses, target, name), { recursive: true });
  }
  notices[identity] = {
    license: pkg.license,
    files: names.map(name => target + '/' + name),
    ...(pinned ? {
      source: pinned.metadata.noticeSource,
    } : {}),
  };
}
if (missing.length) throw new Error('Bundled dependencies lack license text: ' + missing.join(', '));
await writeFile(resolve(licenses, 'index.json'), `${JSON.stringify(notices, null, 2)}\n`);
