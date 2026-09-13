import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '../..');
const LOCK_PATH = join(ROOT, 'host/ark-lock.json');
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetKeyFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (key === 'win32-x64') return key;
  if (key === 'linux-x64' || key === 'linux-arm64') return key;
  if (key === 'darwin-x64' || key === 'darwin-arm64') return key;
  throw new Error(`No pinned Ark target for ${key}`);
}

async function downloadVerified(url, expectedSha256, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Ark source download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('Ark source archive exceeds the maximum size');
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`Ark source archive SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
  }
  await writeFile(destination, bytes, { mode: 0o644 });
  return bytes;
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} failed (${code ?? `signal ${signal}`})`));
    });
  });
}

function findRHome(environment) {
  if (environment.R_HOME) return environment.R_HOME;
  try {
    return execFileSync('R', ['RHOME'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Cannot locate R_HOME for Ark build: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadLock() {
  const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.version !== '0.1.252-alder.1') {
    throw new Error('Ark lock is not the pinned 0.1.252-alder.1 producer lock');
  }
  if (lock.mimePublisher !== 'alder-json-v1') {
    throw new Error('Ark lock does not declare mimePublisher alder-json-v1');
  }
  return lock;
}

export function archiveExtractionPlan(archive, destination, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const cwd = path.dirname(archive);
  const relativeDestination = path.relative(cwd, destination);
  if (!relativeDestination || path.isAbsolute(relativeDestination)) {
    throw new Error('Ark extraction directory must be reachable from the archive directory');
  }
  return {
    cwd,
    archive: path.basename(archive),
    destination: relativeDestination.split(path.sep).join('/'),
  };
}

async function extractSource(archive, destination) {
  await mkdir(destination, { recursive: true });
  const plan = archiveExtractionPlan(archive, destination);
  await run('tar', ['--extract', '--gzip', '--file', plan.archive, '--directory', plan.destination, '--strip-components=1', '--no-same-owner'], { cwd: plan.cwd });
}
export function archivePackagingPlan(packageDirectory, artifact, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const cwd = path.dirname(packageDirectory);
  const relativeArtifact = path.relative(cwd, artifact);
  if (!relativeArtifact || path.isAbsolute(relativeArtifact)) {
    throw new Error('Ark artifact must be reachable from the package directory parent');
  }
  return {
    cwd,
    packageDirectory: path.basename(packageDirectory),
    artifact: relativeArtifact.split(path.sep).join('/'),
  };
}

async function packageArtifact(packageDir, artifactPath, executableName) {
  await mkdir(dirname(artifactPath), { recursive: true });
  const tarCommand = process.platform === 'darwin' ? 'gtar' : 'tar';
  const plan = archivePackagingPlan(packageDir, artifactPath);
  await run(tarCommand, [
    '--create',
    '--gzip',
    '--file', plan.artifact,
    '--directory', plan.packageDirectory,
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    executableName,
    'LICENSE',
    'NOTICE',
    'ark-provenance.json',
  ], { cwd: plan.cwd });
  return readFile(artifactPath);
}

export function patchApplicationPlan(sourceDirectory, patch, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const input = path.relative(sourceDirectory, patch);
  if (!input || path.isAbsolute(input)) {
    throw new Error('Ark patch must be reachable from the extracted source directory');
  }
  return {
    cwd: sourceDirectory,
    input: input.split(path.sep).join('/'),
  };
}

/**
 * Build Ark from the exact source archive and patch recorded in ark-lock.json.
 *
 * The output directory is intentionally ignored runtime state. No upstream
 * binary is ever downloaded or patched in place.
 */
export async function buildArk({
  target = targetKeyFor(),
  output = join(ROOT, 'host/.runtime/ark-build', target),
  sourceArchive,
  archiveOutput,
} = {}) {
  const lock = await loadLock();
  const targetLock = lock.targets[target];
  if (!targetLock) throw new Error(`No pinned Ark target ${target}`);
  const outputDir = resolve(output);
  const sourcePath = join(outputDir, 'source.tar.gz');
  const sourceDir = join(outputDir, 'source');
  const packageDir = join(outputDir, 'package');
  const artifactPath = resolve(archiveOutput ?? join(outputDir, `ark-${lock.version}-${target}.tar.gz`));
  const patchPath = resolve(ROOT, lock.patch.path);

  await mkdir(outputDir, { recursive: true });
  const patchBytes = await readFile(patchPath);
  const patchSha256 = sha256(patchBytes);
  if (patchSha256 !== lock.patch.sha256) {
    throw new Error(`Ark patch SHA-256 mismatch: expected ${lock.patch.sha256}, got ${patchSha256}`);
  }

  if (sourceArchive) {
    const sourceBytes = await readFile(resolve(sourceArchive));
    if (sourceBytes.byteLength > MAX_SOURCE_BYTES) throw new Error('Ark source archive exceeds the maximum size');
    if (sha256(sourceBytes) !== lock.sourceArchive.sha256) {
      throw new Error(`Ark source archive SHA-256 mismatch: expected ${lock.sourceArchive.sha256}`);
    }
    await writeFile(sourcePath, sourceBytes, { mode: 0o644 });
  } else {
    await downloadVerified(lock.sourceArchive.url, lock.sourceArchive.sha256, sourcePath);
  }

  await rm(sourceDir, { recursive: true, force: true });
  await rm(packageDir, { recursive: true, force: true });
  await extractSource(sourcePath, sourceDir);

  const cargoLock = await readFile(join(sourceDir, 'Cargo.lock'));
  const cargoLockSha256 = sha256(cargoLock);
  if (cargoLockSha256 !== lock.cargoLockSha256) {
    throw new Error(`Ark Cargo.lock SHA-256 mismatch: expected ${lock.cargoLockSha256}, got ${cargoLockSha256}`);
  }

  const patchPlan = patchApplicationPlan(sourceDir, patchPath);
  await run('patch', ['--batch', '--forward', '--strip=1', '--input', patchPlan.input], { cwd: patchPlan.cwd });

  const environment = {
    ...process.env,
    ALDER_ARK_GIT_HASH: lock.baseCommit.slice(0, 7),
    ARK_BUILD_VERSION: lock.version,
    CARGO_INCREMENTAL: '0',
    CARGO_TARGET_DIR: join(outputDir, 'target'),
    R_HOME: findRHome(process.env),
    SOURCE_DATE_EPOCH: '0',
  };
  const cargoHome = resolve(environment.CARGO_HOME ?? join(homedir(), '.cargo'));
  delete environment.RUSTFLAGS;
  environment.CARGO_ENCODED_RUSTFLAGS = [
    '--remap-path-prefix=' + ROOT + '=/alder/source',
    '--remap-path-prefix=' + outputDir + '=/alder/build',
    '--remap-path-prefix=' + sourceDir + '=/alder/ark-source',
    '--remap-path-prefix=' + cargoHome + '=/alder/cargo',
    ...(target === 'win32-x64' ? ['-C', 'link-arg=/STACK:8000000', '-C', 'link-arg=/Brepro'] : []),
  ].join('\x1f');
  const nativePathRemaps = target === 'win32-x64'
    ? [
        '/d1trimfile:' + ROOT,
        '/d1trimfile:' + outputDir,
        '/d1trimfile:' + sourceDir,
        '/d1trimfile:' + cargoHome,
      ]
    : [
        '-ffile-prefix-map=' + ROOT + '=/alder/source',
        '-ffile-prefix-map=' + outputDir + '=/alder/build',
        '-ffile-prefix-map=' + sourceDir + '=/alder/ark-source',
        '-ffile-prefix-map=' + cargoHome + '=/alder/cargo',
      ];
  environment.CFLAGS = [environment.CFLAGS, ...nativePathRemaps].filter(Boolean).join(' ');
  environment.CXXFLAGS = [environment.CXXFLAGS, ...nativePathRemaps].filter(Boolean).join(' ');
  const rLib = join(environment.R_HOME, 'lib');
  environment.LD_LIBRARY_PATH = environment.LD_LIBRARY_PATH
    ? `${rLib}${process.platform === 'win32' ? ';' : ':'}${environment.LD_LIBRARY_PATH}`
    : rLib;
  const rustVersion = execFileSync('rustc', ['--version'], { encoding: 'utf8', env: environment, cwd: sourceDir }).trim();
  if (rustVersion.split(' ')[1] !== lock.rustToolchain.version) {
    throw new Error('Ark requires Rust ' + lock.rustToolchain.version + '; got ' + rustVersion);
  }

  await run('cargo', ['build', '--locked', '--release', '--package', 'ark', '--target', targetLock.rustTarget], {
    cwd: sourceDir,
    env: environment,
  });

  const builtArk = join(environment.CARGO_TARGET_DIR, targetLock.rustTarget, 'release', target.startsWith('win32-') ? 'ark.exe' : 'ark');
  const executableName = target.startsWith('win32-') ? 'ark.exe' : 'ark';
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, executableName), await readFile(builtArk), { mode: 0o755 });
  await writeFile(join(packageDir, 'LICENSE'), await readFile(join(sourceDir, 'LICENSE')), { mode: 0o644 });
  await writeFile(join(packageDir, 'NOTICE'), [
    `Ark ${lock.upstreamVersion} built for Alder as ${lock.version}.`,
    `Upstream commit: ${lock.baseCommit}.`,
    `Source archive SHA-256: ${lock.sourceArchive.sha256}.`,
    `Alder patch SHA-256: ${lock.patch.sha256}.`,
    '',
  ].join('\n'), { mode: 0o644 });

  const artifact = {
    schemaVersion: 1,
    implementation: 'ark',
    version: lock.version,
    upstreamVersion: lock.upstreamVersion,
    baseCommit: lock.baseCommit,
    mimePublisher: lock.mimePublisher,
    rustToolchain: lock.rustToolchain,
    target,
    rustTarget: targetLock.rustTarget,
    sourceArchiveSha256: lock.sourceArchive.sha256,
    cargoLockSha256: lock.cargoLockSha256,
    patchSha256,
  };
  await writeFile(join(packageDir, 'ark-provenance.json'), `${JSON.stringify(artifact, null, 2)}\n`);

  const artifactBytes = await packageArtifact(packageDir, artifactPath, executableName);
  const artifactSha256 = sha256(artifactBytes);
  const manifest = {
    ...artifact,
    artifactFile: basename(artifactPath),
    artifactSha256,
    executableSha256: sha256(await readFile(join(packageDir, executableName))),
  };
  await writeFile(join(outputDir, 'ark-artifact.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      output: { type: 'string' },
      'source-archive': { type: 'string' },
      'archive-output': { type: 'string' },
    },
  });
  const manifest = await buildArk({
    target: values.target,
    output: values.output,
    sourceArchive: values['source-archive'],
    archiveOutput: values['archive-output'],
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
