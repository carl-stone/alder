import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertStrictReadyOutput,
  captureProcessTree,
  cleanupOwnedProcessTree,
  configureProcessObserver,
  createStrictReadyParser,
  mergeProcessTrees,
  openSession,
  processStartIdentity,
  readProcess,
  requestJson,
  requireAbsoluteRscript,
  sanitizedEnvironment,
  spawnSmokeProcess,
  stopChild,
  waitForOwnedProcessesGone,
  waitForOwnerExit,
  waitForRegistry,
} from './_common.mjs';
const PACKAGE_SCRIPT = fileURLToPath(new URL('../package.mjs', import.meta.url));
const DRIVER_TIMEOUT_MS = 60_000;
const PROCESS_TIMEOUT_MS = 15_000;
const LAUNCH_SOURCE = '# %%\n1 + 1\n';

export async function run(ctx) {
  const id = 'resource-integrity';
  requireSupportedProcessObserver(id);
  assert.ok(isAbsolute(ctx.applicationRoot), 'resource integrity requires an absolute staged root');
  const selectedR = await requireAbsoluteRscript(ctx.rscript, 'resource-integrity Rscript');

  const pristineRoot = await realpath(resolve(ctx.applicationRoot));
  const manifest = ctx.manifest;
  const processSupervisorExecutable = await realpath(join(pristineRoot, normalizeRelative(manifest.resources.processSupervisorExecutable)));
  assert.equal(processSupervisorExecutable.startsWith(pristineRoot + sep), true, 'process observer must resolve inside staged application');
  configureProcessObserver(processSupervisorExecutable);
  const processObserverOptions = { supervisorExecutable: processSupervisorExecutable };
  const packageScript = ctx.qualificationRoot === undefined
    ? PACKAGE_SCRIPT
    : join(ctx.qualificationRoot, 'source', 'host', 'scripts', 'package.mjs');
  assert.equal(await stat(packageScript).then(info => info.isFile()).catch(() => false), true, 'resource verifier package script is missing: ' + packageScript);
  const manifestPath = manifestPathFor(pristineRoot, manifest);
  const evidencePath = join(ctx.evidence, id + '.json');
  const launcherPath = normalizeRelative(manifest.resources.cliLauncher);
  const exactPayloadPath = normalizeRelative(manifest.resources.hostEntry);
  assert.ok(manifest.files.some(file => file.path === exactPayloadPath), 'manifest must inventory the exact host payload');
  const pristineLauncher = join(pristineRoot, launcherPath);
  const pristineLauncherIdentity = await realpath(pristineLauncher);
  assert.equal(pristineLauncherIdentity.startsWith(pristineRoot + sep), true, 'launcher must resolve inside staged application');
  const pristineLauncherSha256 = await sha256File(pristineLauncher);
  const trustedVerifier = {
    packageScript,
    packageScriptSha256: await sha256File(packageScript),
    launcherPath,
    launcherSha256: pristineLauncherSha256,
  };

  const pristinePackagePath = join(ctx.evidence, 'pristine-package');
  const pristineArchivePath = join(ctx.evidence, process.platform === 'win32' ? 'pristine-package.zip' : 'pristine-package.tar.gz');
  const pristineArtifactRecordPath = join(ctx.evidence, 'artifact-record.json');
  const pristinePackage = await runPackageVerifier(pristineRoot, pristinePackagePath, manifest.sourceCommit, pristineArchivePath, selectedR, packageScript);
  assert.equal(pristinePackage.status, 0, 'unchanged package verifier rejected pristine stage: ' + pristinePackage.stderr);
  const pristineArtifactRecord = JSON.parse(await readFile(pristineArtifactRecordPath, 'utf8'));
  assert.deepEqual(pristineArtifactRecord.target, { platform: process.platform, arch: process.arch });
  assert.equal(pristineArtifactRecord.release.root, 'pristine-package');
  const packagedRoot = resolve(ctx.evidence, pristineArtifactRecord.release.root);
  assert.equal(await realpath(packagedRoot), await realpath(pristinePackagePath));
  const packagedManifestPath = resolve(ctx.evidence, pristineArtifactRecord.release.applicationManifest);
  const packagedManifest = JSON.parse(await readFile(packagedManifestPath, 'utf8'));
  const releaseManifest = pristineArtifactRecord.releaseManifest;
  assert.equal(releaseManifest.sourceCommit, manifest.sourceCommit);
  assert.deepEqual(releaseManifest.target, { platform: process.platform, arch: process.arch });
  assert.equal(releaseManifest.applicationManifest, resourcePrefix(manifest) + '/manifest.json');
  assert.equal(packagedManifestPath, resolve(packagedRoot, releaseManifest.applicationManifest));
  assert.equal(packagedManifest.kind, manifest.kind);
  assert.deepEqual(packagedManifest.target, manifest.target);
  assert.deepEqual(packagedManifest.qualifiedRPatchVersions, manifest.qualifiedRPatchVersions);
  assert.equal(await sha256File(manifestPath), pristineArtifactRecord.release.manifestSha256);
  assert.equal(await sha256File(packagedManifestPath), pristineArtifactRecord.release.manifestSha256);
  assert.equal(pristineArtifactRecord.release.manifestSha256, releaseManifest.manifestSha256);
  assert.ok(releaseManifest.files && Object.keys(releaseManifest.files).length > 0, 'trusted verifier did not emit a complete external release inventory');
  assert.equal(releaseManifest.files[launcherPath], pristineLauncherSha256, 'external release digest does not cover the exact staged launcher');
  assert.equal(pristineArtifactRecord.releaseManifestSha256, sha256Text(JSON.stringify(releaseManifest, null, 2) + '\n'));
  assert.ok(pristineArtifactRecord.artifact && pristineArtifactRecord.signature, 'external artifact record is incomplete');
  const packagedArchivePath = resolve(ctx.evidence, pristineArtifactRecord.artifact.path);
  assert.equal(await sha256File(packagedArchivePath), pristineArtifactRecord.artifact.sha256);
  assert.equal((await stat(packagedArchivePath)).size, pristineArtifactRecord.artifact.bytes);

  const relocatedRoot = join(ctx.evidence, 'relocated read-only Space ü', 'application');
  await copyRoot(pristineRoot, relocatedRoot);
  await chmodTree(relocatedRoot);
  const relocatedEvidence = join(ctx.evidence, 'relocated-read-only-launch');
  const relocatedLaunch = await launchArtifact(relocatedRoot, relocatedEvidence, selectedR, manifest, true, processObserverOptions);
  assert.equal(relocatedLaunch.ready, true, 'read-only relocated artifact did not launch through its exact staged launcher');
  assert.ok(relocatedLaunch.runtimeProcessesBeforeCleanup.length > 0, 'positive-control launch must expose staged runtime identities before cleanup');
  assert.equal(relocatedLaunch.identity.canonicalPath.startsWith(relocatedRoot + sep), false, 'relocated fixture canonical path must remain outside the artifact root');

  const forgeRuntimePath = manifest.files
    .map(file => file.path)
    .find(path => path === 'chrome-sandbox' || path.endsWith('.pak') || path.endsWith('icudtl.dat') || path.startsWith('locales/') || /\.(?:so|dylib|dll)$/.test(path));
  const mutationSpecs = [
    {
      kind: 'same-size-payload',
      externalReject: true,
      mutate: async root => {
        const path = join(root, exactPayloadPath);
        const bytes = Buffer.from(await readFile(path));
        assert.ok(bytes.length > 0, 'payload is empty: ' + exactPayloadPath);
        bytes[0] ^= 0xff;
        await writeFile(path, bytes);
      },
    },
    ...(forgeRuntimePath === undefined ? [] : [{
      kind: 'forge-top-level-runtime-payload',
      externalReject: true,
      mutate: async root => {
        const path = join(root, forgeRuntimePath);
        const bytes = Buffer.from(await readFile(path));
        assert.ok(bytes.length > 0, 'Forge runtime payload is empty: ' + forgeRuntimePath);
        bytes[0] ^= 0xff;
        await writeFile(path, bytes);
      },
    }]),
    {
      kind: 'launcher',
      externalReject: true,
      mutate: async root => {
        const path = join(root, launcherPath);
        const text = await readFile(path, 'utf8');
        assert.equal(text.includes('set -eu'), true, 'staged launcher shape changed unexpectedly');
        await writeFile(path, text.replace('set -eu', 'set -ex'), 'utf8');
      },
    },
    {
      kind: 'unlisted-core-file',
      externalReject: true,
      mutate: async root => {
        await writeFile(join(root, dirname(manifest.resources.hostEntry), 'unlisted-integrity-core'), 'not in the signed inventory\n', 'utf8');
      },
    },
    {
      kind: 'escaping-symlink',
      externalReject: true,
      mutate: async root => {
        const outside = join(ctx.evidence, 'resource-integrity-outside.bin');
        await writeFile(outside, 'outside application root\n', 'utf8');
        await symlink(outside, join(root, dirname(manifest.resources.hostEntry), 'escaping-resource'));
      },
    },
    {
      kind: 'malformed-manifest',
      externalReject: true,
      mutate: async root => { await writeFile(manifestPathFor(root, manifest), '{\n', 'utf8'); },
    },
    {
      kind: 'deep-manifest',
      externalReject: false,
      mutate: async root => {
        const value = JSON.parse(await readFile(manifestPathFor(root, manifest), 'utf8'));
        let nested = true;
        for (let index = 0; index < 70; index += 1) nested = { nested };
        value.untrusted = nested;
        await writeFile(manifestPathFor(root, manifest), JSON.stringify(value) + '\n', 'utf8');
      },
    },
    {
      kind: 'duplicate-manifest-key',
      externalReject: false,
      mutate: async root => {
        const path = manifestPathFor(root, manifest);
        const text = await readFile(path, 'utf8');
        const open = text.indexOf('{');
        assert.ok(open >= 0, 'manifest object is missing');
        await writeFile(path, text.slice(0, open + 1) + '\n  "schemaVersion": 1,' + text.slice(open + 1), 'utf8');
      },
    },
    {
      kind: 'wrong-target',
      externalReject: false,
      mutate: async root => {
        const path = manifestPathFor(root, manifest);
        const value = JSON.parse(await readFile(path, 'utf8'));
        value.target = { ...value.target, platform: value.target.platform === 'linux' ? 'darwin' : 'linux' };
        await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
      },
    },
    {
      kind: 'partial-root-replacement',
      externalReject: true,
      mutate: async root => { await rm(join(root, exactPayloadPath), { force: true }); },
    },
  ];

  const mutations = [];
  for (const spec of mutationSpecs) {
    const mutationDirectory = join(ctx.evidence, 'resource-integrity-mutations', spec.kind);
    const root = join(mutationDirectory, 'application');
    let recorded = false;
    try {
      await copyRoot(pristineRoot, root);
      await spec.mutate(root);
      const packageOutput = join(mutationDirectory, 'package');
      const packageResult = await runPackageVerifier(root, packageOutput, manifest.sourceCommit, null, selectedR, packageScript);
      if (spec.externalReject) assert.notEqual(packageResult.status, 0, spec.kind + ' was accepted by unchanged external package verifier');
      const launchEvidence = join(mutationDirectory, 'launcher');
      const launch = await launchArtifact(root, launchEvidence, selectedR, manifest, false, processObserverOptions);
      assert.equal(launch.ready, false, spec.kind + ' reached host.ready through a mutated artifact');
      assert.equal(Number.isInteger(launch.status) && launch.status !== 0, true, spec.kind + ' rejected launcher must exit non-zero');
      const launchOutput = launch.stdout + '\n' + launch.stderr;
      assert.match(launchOutput, /manifest|resource|integrity|inventory|hash|schema|target|duplicate|json|nest/i, spec.kind + ' did not report an integrity-specific rejection');
      assert.doesNotMatch(launchOutput, /ENOENT|command not found|no such file or directory/i, spec.kind + ' only reported a missing executable/tool');
      assert.equal(launch.runtimeDescendantsBeforeCleanup.length, 0, spec.kind + ' started runtime descendants before rejection');
      assert.equal(launch.runtimeProcessesBeforeCleanup.length, 0, spec.kind + ' started staged runtime processes before rejection');
      assert.equal(launch.runtimeDescendants.length, 0, spec.kind + ' left runtime descendants after rejection');
      assert.equal(launch.runtimeProcesses.length, 0, spec.kind + ' left staged runtime processes after rejection');
      mutations.push({
        kind: spec.kind,
        packageStatus: packageResult.status,
        packageStderrSha256: sha256Text(packageResult.stderr),
        packageDiagnostic: packageResult.stderr,
        launcher: { path: launcherPath, sha256: await sha256File(join(root, launcherPath)) },
        launch: {
          ownedGraphBeforeCleanup: launch.ownedGraphBeforeCleanup,
          runtimeDescendantsBeforeCleanup: launch.runtimeDescendantsBeforeCleanup,
          runtimeProcessesBeforeCleanup: launch.runtimeProcessesBeforeCleanup,
          runtimeDescendantsAfter: launch.runtimeDescendantsAfter,
          runtimeDescendants: launch.runtimeDescendants,
          runtimeProcesses: launch.runtimeProcesses,
          status: launch.status, signal: launch.signal,
          stdoutSha256: sha256Text(launch.stdout), stderrSha256: sha256Text(launch.stderr),
          diagnostics: { stdout: launch.stdout, stderr: launch.stderr }, ready: launch.ready,
        },
        externalRejected: packageResult.status !== 0,
      });
      recorded = true;
    } finally {
      if (recorded) await rm(mutationDirectory, { recursive: true, force: true });
    }
  }

  const identity = {
    sourceCommit: manifest.sourceCommit,
    requestedR: ctx.rscript,
    selectedR,
    manifestSha256: await sha256File(manifestPath),
    target: manifest.target,
    artifact: { root: pristineRoot, manifestPath, payloadPath: exactPayloadPath, launcherPath, resourcePrefix: resourcePrefix(manifest) },
    trustedVerifier,
    package: {
      output: pristinePackagePath,
      archive: pristineArchivePath,
      artifactRecord: pristineArtifactRecordPath,
      applicationManifest: pristineArtifactRecord.release.applicationManifest,
      applicationManifestSha256: pristineArtifactRecord.release.manifestSha256,
      releaseManifestSha256: pristineArtifactRecord.releaseManifestSha256,
      fileCount: Object.keys(pristineArtifactRecord.releaseManifest.files).length,
    },
    relocated: { root: relocatedRoot, readOnlyResources: true, launcher: relocatedLaunch.launcher, identity: relocatedLaunch.identity },
    mutations,
  };
  await writeFile(evidencePath, JSON.stringify({ id, identity }, null, 2) + '\n');
  return { id, identity };
}

async function launchArtifact(applicationRoot, evidence, rscript, manifest, expectReady, processObserverOptions) {
  await rm(evidence, { recursive: true, force: true });
  const fixture = join(evidence, 'fixture');
  const cwd = join(evidence, 'cwd');
  const dataHome = join(evidence, 'data');
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  await mkdir(fixture, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(evidence, 'home'), { recursive: true });
  await mkdir(join(evidence, 'config'), { recursive: true });
  const notebook = join(fixture, 'sample.R');
  await writeFile(notebook, LAUNCH_SOURCE, 'utf8');
  const canonical = await realpath(notebook);
  const launcher = join(applicationRoot, normalizeRelative(manifest.resources.cliLauncher));
  const launcherIdentity = await realpath(launcher).catch(error => { throw new Error('launcher_identity:' + error.message); });
  assert.equal(launcherIdentity.startsWith(applicationRoot + sep), true, 'artifact launcher escaped staged root');
  const child = spawnSmokeProcess(launcher, [notebook, '--headless', '--no-run', '--port', '0', '--rscript', rscript], {
    cwd,
    env: sanitizedEnvironment({ HOME: join(evidence, 'home'), XDG_CONFIG_HOME: join(evidence, 'config'), XDG_DATA_HOME: dataHome }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parser = createStrictReadyParser(child.stdout, { label: 'resource-integrity' });
  let stderr = '';
  let exited = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', () => { exited = true; });
  const deadline = Date.now() + DRIVER_TIMEOUT_MS;
  while (parser.readyRecord === null && parser.error === null && !exited && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  const ready = parser.readyRecord;
  const childStartIdentity = await processStartIdentity(child.pid, processObserverOptions);
  let ownedGraphBeforeCleanup = [];
  if (childStartIdentity !== null) {
    try {
      ownedGraphBeforeCleanup = await captureProcessTree(child.pid, childStartIdentity, processObserverOptions);
    } catch (error) {
      if (expectReady || !(error instanceof Error) || error.message !== 'owned_process_root_missing:' + child.pid) throw error;
    }
  }
  let ownedGraph = ownedGraphBeforeCleanup;
  const registryPath = join(runtimeDirectory, createHash('sha256').update('path:' + canonical).digest('hex') + '.json');
  let registry = null;
  let identity = null;
  let session = null;
  let status = child.exitCode;
  let signal = child.signalCode;
  const cleanupErrors = [];
  if (ready !== null) {
    try {
      registry = await waitForRegistry(canonical, runtimeDirectory, 30_000);
      assert.equal(registry.address?.browserOrigin, ready.origin);
      const registryTree = await captureProcessTree(registry.pid, registry.startIdentity, processObserverOptions);
      ownedGraphBeforeCleanup = mergeProcessTrees(ownedGraphBeforeCleanup, registryTree);
      ownedGraph = ownedGraphBeforeCleanup;
      session = await openSession(ready.origin, registry);
      identity = await requestJson(ready.origin, '/api/identity', { cookie: session.cookie, csrf: session.csrf });
      assert.equal(identity.canonicalPath, canonical);
      assert.equal(identity.epoch, registry.epoch);
      assert.equal(identity.processNonce, registry.processNonce);
      await requestJson(ready.origin, '/api/lease', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: { action: 'release', leaseId: session.leaseId } });
      if (ownedGraph.length > 0) await cleanupOwnedProcessTree(ownedGraph, processObserverOptions);
      assert.equal(await waitForOwnerExit(registry.pid, registry.startIdentity, PROCESS_TIMEOUT_MS, processObserverOptions), true, 'released owner did not exit');
      const releasedRegistry = await readFile(registryPath, 'utf8').then(JSON.parse).catch(() => null);
      assert.equal(releasedRegistry, null, 'artifact release left an owner registry');
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try { if (!exited) await stopChild(child); }
  catch (error) { cleanupErrors.push(error); }
  await parser.done;
  try { assertStrictReadyOutput(parser, { requireReady: expectReady }); }
  catch (error) { cleanupErrors.push(error); }
  const stdout = parser.stdout;
  status = child.exitCode;
  signal = child.signalCode;
  try { if (ownedGraph.length > 0) await waitForOwnedProcessesGone(ownedGraph, PROCESS_TIMEOUT_MS, processObserverOptions); }
  catch (error) { cleanupErrors.push(error); }
  const isRuntimeProcess = record => record.executable === launcher || record.executable?.startsWith(applicationRoot + sep) || record.command.includes(applicationRoot);
  const runtimeDescendantsBeforeCleanup = ownedGraphBeforeCleanup.filter(record => record.pid !== child.pid);
  const runtimeProcessesBeforeCleanup = runtimeDescendantsBeforeCleanup.filter(isRuntimeProcess);
  const runtimeDescendantsAfter = (await inspectOwnedProcesses(ownedGraph, processObserverOptions)).filter(record => record.pid !== child.pid);
  const remainingOwned = runtimeDescendantsAfter.filter(record => record.present);
  const runtimeDescendants = remainingOwned;
  const runtimeProcesses = runtimeDescendants.filter(isRuntimeProcess);
  if (ready === null) {
    const lingeringRegistry = await readFile(registryPath, 'utf8').then(JSON.parse).catch(() => null);
    assert.equal(lingeringRegistry, null, 'artifact rejection left an owner registry without host.ready');
  }
  if (expectReady) assert.ok(ready !== null, 'expected exact staged launcher to emit host.ready');
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'artifact launcher cleanup failed');
  assert.equal(runtimeProcesses.length, 0, 'artifact launch left staged runtime processes: ' + JSON.stringify(runtimeProcesses));
  return {
    launcher: { path: launcher, identity: launcherIdentity, sha256: await sha256File(launcher) },
    ready: ready !== null, readyRecord: ready, identity, registry,
    status: status ?? -1, signal: signal ?? null, stdout, stderr, ownedGraphBeforeCleanup,
    runtimeDescendantsBeforeCleanup, runtimeProcessesBeforeCleanup, runtimeDescendantsAfter,
    runtimeDescendants, runtimeProcesses,
  };
}
async function inspectOwnedProcesses(records, processObserverOptions) {
  const observations = [];
  for (const record of records) {
    const observed = await readProcess(record.pid, processObserverOptions);
    if (observed !== null && observed.startIdentity !== record.startIdentity) {
      throw new Error('owned_process_identity_changed:' + record.pid);
    }
    observations.push({ ...record, present: observed !== null && observed.state !== 'Z', observedState: observed?.state ?? null });
  }
  return observations;
}

async function copyRoot(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
}

function manifestPathFor(root, manifest) { return join(root, resourcePrefix(manifest), 'manifest.json'); }
function resourcePrefix(manifest) { return dirname(manifest.resources.hostEntry).split('/')[0]; }

async function runPackageVerifier(applicationRoot, output, sourceCommit, archivePath = null, rscript, packageScript = PACKAGE_SCRIPT) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const args = ['--application', applicationRoot, '--output', output, '--source-commit', sourceCommit, '--rscript', rscript];
  if (archivePath !== null) {
    await rm(archivePath, { force: true });
    await rm(join(dirname(archivePath), 'artifact-record.json'), { force: true });
    args.push('--archive', archivePath);
  }
  return runNode(packageScript, args);
}
function runNode(script, args) {
  const child = spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), env: sanitizedEnvironment(), encoding: 'utf8', timeout: DRIVER_TIMEOUT_MS, windowsHide: true });
  return { status: child.status ?? -1, signal: child.signal ?? null, stdout: String(child.stdout ?? ''), stderr: String(child.stderr ?? '') + (child.error ? '\n' + child.error.message : '') };
}

async function chmodTree(directory) {
  const info = await stat(directory);
  assert.equal(info.isDirectory(), true, 'resource directory is missing: ' + directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await chmodTree(path); await chmod(path, 0o555); }
    else if (entry.isFile()) { const mode = (await stat(path)).mode & 0o111; await chmod(path, 0o444 | mode); }
    else throw new Error('resource_special_file:' + path);
  }
  await chmod(directory, 0o555);
}
function normalizeRelative(path) {
  const normalized = path.split(sep).join('/');
  assert.equal(normalized.startsWith('../') || normalized === '..', false, 'manifest path escapes root: ' + path);
  return normalized;
}
function requireSupportedProcessObserver(id) {
  if (['linux', 'darwin', 'win32'].includes(process.platform)) return;
  const error = new Error('scenario_unavailable: ' + id + ' requires a supported OS process observer');
  error.code = 'scenario_unavailable';
  throw error;
}
function sha256Text(value) { return createHash('sha256').update(value).digest('hex'); }
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
