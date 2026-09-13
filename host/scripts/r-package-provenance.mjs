import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';


const MAX_R_SOURCE_BYTES = 128 * 1024 * 1024;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]*$/;
const BASE_R_PACKAGES = new Set([
  'R', 'base', 'compiler', 'datasets', 'graphics', 'grDevices', 'grid',
  'methods', 'parallel', 'splines', 'stats', 'stats4', 'tcltk', 'tools', 'utils',
]);
const DEPENDENCY_FIELDS = ['Depends', 'Imports', 'LinkingTo'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function dependencyName(specification) {
  return String(specification).trim().split(/[ (]/, 1)[0];
}

export function validateRLibraryLock(lock) {
  if (lock?.ProvenanceSchemaVersion !== 1
      || !Array.isArray(lock.Roots)
      || lock.Roots.length === 0
      || !lock.Packages
      || typeof lock.Packages !== 'object'
      || Array.isArray(lock.Packages)) {
    throw new Error('r_dependency_lock_invalid: provenance schema, roots, and packages are required');
  }

  const packages = lock.Packages;
  if (!packages.alder) throw new Error('r_dependency_lock_invalid: alder package is required');
  const packageNames = Object.keys(packages);
  for (const name of packageNames) {
    if (!PACKAGE_NAME.test(name)) throw new Error('r_dependency_lock_invalid: invalid package name ' + name);
    const pkg = packages[name];
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || pkg.Package !== name
        || typeof pkg.Version !== 'string' || pkg.Version.length === 0
        || typeof pkg.License !== 'string'
        || !pkg.NativeDependencies || typeof pkg.NativeDependencies !== 'object'
        || typeof pkg.NativeDependencies.needsCompilation !== 'boolean'
        || !(pkg.NativeDependencies.systemRequirements === null
          || typeof pkg.NativeDependencies.systemRequirements === 'string')) {
      throw new Error('r_dependency_lock_invalid: ' + name + ' lacks identity or native dependency metadata');
    }
    for (const field of DEPENDENCY_FIELDS) {
      if (pkg[field] !== undefined && (!Array.isArray(pkg[field]) || pkg[field].some(value => typeof value !== 'string'))) {
        throw new Error('r_dependency_lock_invalid: ' + name + ' has malformed ' + field);
      }
      for (const dependency of pkg[field] ?? []) {
        const dependencyPackage = dependencyName(dependency);
        if (!dependencyPackage || !PACKAGE_NAME.test(dependencyPackage)) {
          throw new Error('r_dependency_lock_invalid: ' + name + ' has malformed dependency ' + dependency);
        }
      }
    }

    if (name === 'alder') {
      if (pkg.Source !== 'Local' || pkg.SourcePath !== '.') {
        throw new Error('r_dependency_lock_invalid: alder must identify the local source tree');
      }
    } else {
      if (pkg.Source !== 'Repository' || typeof pkg.SourceArchive !== 'string') {
        throw new Error('r_dependency_lock_invalid: ' + name + ' lacks repository source provenance');
      }
      let sourceUrl;
      try {
        sourceUrl = new URL(pkg.SourceArchive);
      } catch {
        throw new Error('r_dependency_lock_invalid: ' + name + ' has an invalid source archive URL');
      }
      if (sourceUrl.protocol !== 'https:' || !sourceUrl.hostname || sourceUrl.username || sourceUrl.password) {
        throw new Error('r_dependency_lock_invalid: ' + name + ' source archive must use HTTPS');
      }
      if (typeof pkg.SourceSHA256 !== 'string' || !/^[0-9a-f]{64}$/.test(pkg.SourceSHA256)
          || !Number.isSafeInteger(pkg.SourceBytes) || pkg.SourceBytes <= 0 || pkg.SourceBytes > MAX_R_SOURCE_BYTES) {
        throw new Error('r_dependency_lock_invalid: ' + name + ' lacks bounded pinned source archive provenance');
      }
      const archiveName = basename(sourceUrl.pathname);
      if (!archiveName || archiveName === '.' || archiveName === '..' || archiveName.includes('\\') || !archiveName.endsWith('.tar.gz')) {
        throw new Error('r_dependency_lock_invalid: ' + name + ' source archive has no safe tarball name');
      }
    }
  }

  const closure = new Set();
  const pending = [...lock.Roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
      throw new Error('r_dependency_lock_invalid: roots must contain package names');
    }
    if (BASE_R_PACKAGES.has(name) || closure.has(name)) continue;
    const pkg = packages[name];
    if (!pkg) throw new Error('r_dependency_lock_invalid: missing transitive package ' + name);
    closure.add(name);
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of pkg[field] ?? []) pending.push(dependencyName(dependency));
    }
  }
  if (packageNames.length !== closure.size || packageNames.some(name => !closure.has(name))) {
    throw new Error('r_dependency_lock_invalid: package inventory is not the exact root dependency closure');
  }
  return lock;
}

export function lockedRPackageOrder(lock) {
  validateRLibraryLock(lock);
  const packages = lock.Packages;
  const state = new Map();
  const order = [];
  const visit = name => {
    if (BASE_R_PACKAGES.has(name)) return;
    const status = state.get(name);
    if (status === 'done') return;
    if (status === 'visiting') throw new Error('r_dependency_lock_invalid: dependency cycle at ' + name);
    const pkg = packages[name];
    if (!pkg) throw new Error('r_dependency_lock_invalid: missing transitive package ' + name);
    state.set(name, 'visiting');
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of pkg[field] ?? []) visit(dependencyName(dependency));
    }
    state.set(name, 'done');
    order.push(name);
  };

  // Install repository packages before the local Alder package. This keeps
  // every local package dependency available without asking R to resolve it
  // from a host library path.
  for (const name of Object.keys(packages).filter(name => name !== 'alder').sort()) visit(name);
  if (packages.alder) visit('alder');
  return order;
}

function sourceCachePath(sourceCacheDirectory, sourceUrl) {
  const archiveName = basename(new URL(sourceUrl).pathname);
  if (!archiveName || archiveName === '.' || archiveName === '..' || archiveName.includes('\\')) {
    throw new Error('r_dependency_source_invalid: source archive has no safe cache name');
  }
  return join(resolve(sourceCacheDirectory), archiveName);
}

async function readResponseBytes(response, packageName) {
  if (!response || response.ok !== true || typeof response.arrayBuffer !== 'function') {
    const status = response && Number.isInteger(response.status) ? 'HTTP ' + response.status : 'invalid response';
    throw new Error('r_dependency_source_unavailable: ' + packageName + ': ' + status);
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error('r_dependency_source_unavailable: ' + packageName + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

export async function readVerifiedRSource(packageName, pkg, {
  sourceCacheDirectory = null,
  fetcher = globalThis.fetch,
} = {}) {
  if (!PACKAGE_NAME.test(packageName) || !pkg || pkg.Package !== packageName) {
    throw new Error('r_dependency_source_invalid: package identity is malformed');
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(pkg.SourceArchive);
  } catch {
    throw new Error('r_dependency_source_invalid: ' + packageName + ' has an invalid source archive URL');
  }
  if (sourceUrl.protocol !== 'https:' || !sourceUrl.hostname || sourceUrl.username || sourceUrl.password) {
    throw new Error('r_dependency_source_invalid: ' + packageName + ' source archive must use HTTPS');
  }
  const expectedBytes = pkg.SourceBytes;
  const expectedSha256 = pkg.SourceSHA256;
  let bytes;
  if (sourceCacheDirectory !== null) {
    const cachePath = sourceCachePath(sourceCacheDirectory, pkg.SourceArchive);
    try {
      bytes = await readFile(cachePath);
    } catch (error) {
      throw new Error('r_dependency_source_unavailable: ' + packageName + ': cache artifact is unavailable at ' + cachePath + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  } else {
    if (typeof fetcher !== 'function') throw new Error('r_dependency_source_unavailable: ' + packageName + ': fetch is unavailable');
    let response;
    try {
      response = await fetcher(pkg.SourceArchive, { signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new Error('r_dependency_source_unavailable: ' + packageName + ': ' + (error instanceof Error ? error.message : String(error)));
    }
    bytes = await readResponseBytes(response, packageName);
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('r_dependency_source_mismatch: ' + packageName + ' expected ' + expectedBytes + ' bytes, got ' + bytes.byteLength);
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error('r_dependency_source_mismatch: ' + packageName + ' expected SHA-256 ' + expectedSha256 + ', got ' + actualSha256);
  }
  return bytes;
}

export async function readLockedRSourceArchives(lock, options = {}) {
  const order = lockedRPackageOrder(lock);
  const archives = new Map();
  for (const name of order) {
    if (name === 'alder') continue;
    archives.set(name, await readVerifiedRSource(name, lock.Packages[name], options));
  }
  return { order, archives };
}

export function parseDcf(text) {
  const fields = {};
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^ :]+):[ \t]*(.*)$/);
    if (match) {
      key = match[1];
      fields[key] = match[2];
    } else if (key && /^\s/.test(line)) {
      fields[key] += ' ' + line.trim();
    }
  }
  return fields;
}

export async function verifyInstalledRLibrary(directory, lock) {
  validateRLibraryLock(lock);
  const expectedNames = Object.keys(lock.Packages).sort();
  const actual = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) throw new Error('r_dependency_closure_mismatch: non-directory entry in R library ' + entry.name);
    const descriptionPath = join(directory, entry.name, 'DESCRIPTION');
    let description;
    try {
      description = await readFile(descriptionPath, 'utf8');
    } catch {
      throw new Error('r_dependency_closure_mismatch: package directory has no DESCRIPTION: ' + entry.name);
    }
    const fields = parseDcf(description);
    const expected = lock.Packages[entry.name];
    if (!expected || fields.Package !== entry.name || fields.Package !== expected.Package || fields.Version !== expected.Version) {
      throw new Error('r_dependency_identity_mismatch: ' + entry.name + ' expected ' + (expected?.Package ?? entry.name) + '@' + (expected?.Version ?? 'unknown') + ', got ' + (fields.Package ?? 'unknown') + '@' + (fields.Version ?? 'unknown'));
    }
    actual.push(entry.name);
  }
  actual.sort();
  if (actual.length !== expectedNames.length || actual.some((name, index) => name !== expectedNames[index])) {
    throw new Error('r_dependency_closure_mismatch: expected ' + expectedNames.join(',') + ', got ' + actual.sort().join(','));
  }
  return actual;
}
