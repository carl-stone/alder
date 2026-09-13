import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const NATIVE_NAMES = ['zeromq', 'cmake-ts', 'node-addon-api'];
const LICENSE_RE = /^(?:licen[cs]e|copying|notice)(?:[.\\-_]|$)/i;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

function normalizeRelative(path) {
  const normalized = String(path).replaceAll(String.fromCharCode(92), '/');
  const relativePath = normalized.startsWith('./') ? normalized.slice(2) : normalized;
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) throw new Error('Invalid native addon path ' + path);
  return relativePath;
}

async function targetLibc(platform) {
  if (platform === 'linux') return await exists('/etc/alpine-release') ? 'musl' : 'glibc';
  if (platform === 'darwin') return 'libc';
  if (platform === 'win32') return 'msvc';
  return 'unknown';
}

async function stagePackageLicense({ root, destination, name, pkg, packageJsonBytes }) {
  const source = join(root, 'node_modules', name);
  const identity = name + '@' + pkg.version;
  const licenseDirectory = join(destination, 'licenses', 'native', identity);
  await mkdir(licenseDirectory, { recursive: true });
  const entries = (await readdir(source, { withFileTypes: true }))
    .filter(entry => entry.isFile() && LICENSE_RE.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const files = [];
  for (const entry of entries) {
    const bytes = await readFile(join(source, entry));
    const path = identity + '/' + entry;
    await writeFile(join(licenseDirectory, entry), bytes, { mode: 0o644 });
    files.push({ path: 'native/' + path, sha256: sha256(bytes), source: 'node_modules/' + name + '/' + entry });
  }
  let metadata;
  const metadataPath = join(root, 'licenses', identity + '.json');
  if (await exists(metadataPath)) metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (!files.length && metadata?.noticeFile) {
    const noticePath = resolve(root, '..', metadata.noticeFile);
    const noticeBytes = await readFile(noticePath);
    if (metadata.noticeSha256 !== sha256(noticeBytes)) throw new Error('Pinned ' + identity + ' notice SHA-256 mismatch');
    const filename = 'LICENSE';
    await writeFile(join(licenseDirectory, filename), noticeBytes, { mode: 0o644 });
    files.push({ path: 'native/' + identity + '/' + filename, sha256: sha256(noticeBytes), source: metadata.noticeFile, provenance: metadata });
  }
  if (!files.length) throw new Error('No license or pinned notice is available for native package ' + identity);
  const record = {
    name,
    version: pkg.version,
    license: pkg.license,
    packageJsonSha256: sha256(packageJsonBytes),
    files,
  };
  if (metadata) record.provenance = metadata;
  return record;
}

async function selectAddon(source, destination, { platform, arch, libc, abi }) {
  const sourceManifestPath = join(source, 'build', 'manifest.json');
  const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
  const candidates = Object.entries(manifest).map(([key, addonPath]) => {
    let config;
    try { config = JSON.parse(key); } catch { throw new Error('zeromq native manifest contains invalid metadata'); }
    return { config, addonPath: normalizeRelative(addonPath) };
  }).filter(({ config }) => config.os === platform
    && config.arch === arch
    && config.runtime === 'node'
    && config.libc === libc
    && String(config.buildType).toLowerCase() === 'release'
    && config.dev !== true
    && Number.isInteger(config.abi)
    && config.abi <= abi)
    .sort((a, b) => b.config.abi - a.config.abi || a.addonPath.localeCompare(b.addonPath));
  const selected = candidates[0];
  if (!selected) throw new Error('zeromq has no staged ' + platform + '/' + arch + '/' + libc + ' Node ABI <= ' + abi + ' addon');
  const sourceAddon = join(source, 'build', ...selected.addonPath.split('/'));
  if (!await exists(sourceAddon)) throw new Error('zeromq native manifest points to missing addon ' + selected.addonPath);
  const destinationBuild = join(destination, 'node_modules', 'zeromq', 'build');
  await rm(destinationBuild, { recursive: true, force: true });
  await mkdir(dirname(join(destinationBuild, selected.addonPath)), { recursive: true });
  await cp(sourceAddon, join(destinationBuild, selected.addonPath));
  const selectedKey = JSON.stringify(selected.config);
  await writeFile(join(destinationBuild, 'manifest.json'), JSON.stringify({ [selectedKey]: selected.addonPath }) + '\n');
  return {
    package: 'zeromq',
    path: 'node_modules/zeromq/build/' + selected.addonPath,
    platform,
    arch,
    libc,
    abi: selected.config.abi,
    runtime: selected.config.runtime,
  };
}

export async function stageNative(output, options = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const destination = resolve(output);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const abi = options.abi ?? Number(process.versions.modules);
  const libc = options.libc ?? await targetLibc(platform);
  if (!Number.isInteger(abi) || abi < 1) throw new Error('Invalid Node ABI ' + abi);
  await mkdir(destination, { recursive: true });
  await rm(join(destination, 'node_modules'), { recursive: true, force: true });
  await rm(join(destination, 'native-manifest.json'), { force: true });

  const packageRecords = [];
  for (const name of NATIVE_NAMES) {
    const source = join(root, 'node_modules', name);
    const packageJsonBytes = await readFile(join(source, 'package.json'));
    const pkg = JSON.parse(packageJsonBytes);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (!NATIVE_NAMES.includes(dependency)) throw new Error('Unpackaged native dependency ' + dependency + ' of ' + name);
    }
    await mkdir(join(destination, 'node_modules'), { recursive: true });
    await cp(source, join(destination, 'node_modules', name), { recursive: true });
    packageRecords.push(await stagePackageLicense({ root, destination, name, pkg, packageJsonBytes }));
  }

  const addon = await selectAddon(join(root, 'node_modules', 'zeromq'), destination, { platform, arch, libc, abi });
  const licenseIndexPath = join(destination, 'licenses', 'index.json');
  const licenseIndex = await exists(licenseIndexPath) ? JSON.parse(await readFile(licenseIndexPath, 'utf8')) : {};
  for (const record of packageRecords) {
    const identity = record.name + '@' + record.version;
    licenseIndex[identity] = {
      license: record.license,
      files: record.files.map(file => file.path),
      packageJsonSha256: record.packageJsonSha256,
      target: { platform, arch, libc, abi: addon.abi },
      ...(record.provenance ? { provenance: record.provenance } : {}),
    };
  }
  await writeFile(licenseIndexPath, JSON.stringify(Object.fromEntries(Object.entries(licenseIndex).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');

  const nativeManifest = {
    schemaVersion: 1,
    target: { platform, arch, libc, abi },
    packages: packageRecords.map(({ name, version, license }) => ({ name, version, license })),
    addon,
    licenseIndex: 'licenses/index.json',
  };
  await writeFile(join(destination, 'native-manifest.json'), JSON.stringify(nativeManifest, null, 2) + '\n');
  const require = createRequire(join(destination, 'package.json'));
  const zeromq = require('zeromq');
  const probe = new zeromq.Dealer();
  probe.close();
  return nativeManifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/stage-native.mjs HOST_DIRECTORY');
  await stageNative(resolve(process.argv[2]));
}
