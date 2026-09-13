import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  cleanupScenarioResources,
  assertCanonicalReady,
  assertStrictReadyOutput,
  createStrictReadyParser,
  exchangeTicket,
  mintTicket,
  openSession,
  redact,
  releaseLease,
  requireAbsoluteRscript,
  sanitizedEnvironment,
  spawnSmokeProcess,
  stopChild,
  waitForCanonicalReady,
  waitForRegistry,
} from './_common.mjs';
import { waitForOwnerExit } from './process-observer.mjs';

const STARTUP_TIMEOUT_MS = 120_000;
const CONCURRENT_STARTERS = 8;

export async function run(ctx) {
  const id = 'session-races';
  const selectedR = await requireAbsoluteRscript(ctx.rscript, 'session-races Rscript');
  const applicationRoot = resolve(ctx.applicationRoot);
  const launcher = join(applicationRoot, ctx.manifest.resources.cliLauncher);
  const dataHome = join(ctx.evidence, 'runtime-data-session-races');
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const fixtureDirectory = join(ctx.evidence, 'fixtures', id);
  const aliasDirectory = join(ctx.evidence, 'fixtures', `${id}-aliases`);
  const canonical = join(fixtureDirectory, 'sample.R');
  const evidencePath = join(ctx.evidence, `${id}.json`);
  const children = [];
  const sessions = [];
  const untitledChildren = [];
  let staleOwnerProcessNonce;

  await mkdir(fixtureDirectory, { recursive: true });
  await mkdir(join(fixtureDirectory, 'nested'), { recursive: true });
  await mkdir(aliasDirectory, { recursive: true });
  await writeFile(canonical, '# %%\nx <- 40\n# %%\nx + 2\n', 'utf8');
  const alias = join(aliasDirectory, 'sample.R');
  await symlink(canonical, alias).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });

  const aliases = [
    canonical,
    join(fixtureDirectory, '.', 'sample.R'),
    join(fixtureDirectory, 'nested', '..', 'sample.R'),
    alias,
    join(aliasDirectory, '.', 'sample.R'),
    join(aliasDirectory, '..', id, 'sample.R'),
    resolve(fixtureDirectory, 'nested', '..', 'sample.R'),
    `${fixtureDirectory}/nested/../sample.R`,
  ];
  const canonicalPaths = await Promise.all(aliases.map(path => realpath(path)));
  for (const path of canonicalPaths) assert.equal(path, canonical);

  const candidate = path => startCandidate({ launcher, notebook: path, cwd: fixtureDirectory, dataHome, selectedR, id: randomUUID() });
  try {
    // Kill a real Ark owner after readiness, then force its lock stale. Two
    // subsequent Ark candidates must serialize reclamation and publish one
    // new owner instead of racing over the dead claim.
    const staleCandidate = candidate(canonical);
    try {
      const staleReady = await staleCandidate.ready;
      assertCanonicalReady(staleReady);
      const staleRegistry = await waitForRegistry(canonical, runtimeDirectory, STARTUP_TIMEOUT_MS);
      process.kill(staleRegistry.pid, 'SIGKILL');
      assert.equal(await waitForOwnerExit(staleRegistry.pid, staleRegistry.startIdentity, 10_000), true, 'stale host owner must exit before reclaim');
      await stopChild(staleCandidate.child);
      const staleRegistryPath = join(runtimeDirectory, createHash('sha256').update(canonical).digest('hex') + '.json');
      const staleLockPath = staleRegistryPath + '.lock';
      const staleAt = new Date(Date.now() - 120_000);
      await utimes(staleLockPath, staleAt, staleAt);
      children.push(staleCandidate);
      staleOwnerProcessNonce = staleRegistry.processNonce;
    } catch (error) {
      await stopChild(staleCandidate.child);
      throw error;
    }
    // All eight candidates are started before any readiness result is consumed.
    for (const path of aliases) children.push(candidate(path));
    const ready = await Promise.all(children.map(entry => entry.ready));
    for (const value of ready) assertCanonicalReady(value);

    const registry = await waitForRegistry(canonical, runtimeDirectory, STARTUP_TIMEOUT_MS);
    assert.equal(registry.state, 'ready');
    assert.equal(registry.canonicalPath, canonical);
    assert.equal(typeof registry.pid, 'number');
    assert.equal(typeof registry.processNonce, 'string');
    assert.equal(typeof registry.startIdentity, 'string');
    assert.equal(typeof registry.epoch, 'string');
    assert.equal(typeof registry.address?.origin, 'string');
    assertProcessAlive(registry.pid);

    const origin = registry.address.origin;
    const attached = await Promise.all(Array.from({ length: CONCURRENT_STARTERS }, () => openSession(origin, registry)));
    assert.notEqual(registry.processNonce, staleOwnerProcessNonce);
    sessions.push(...attached);
    const sessionKeys = new Set(attached.map(value => value.sessionKey));
    assert.equal(sessionKeys.size, 1);
    const epochs = new Set(attached.map(value => value.epoch));
    const processNonces = new Set(attached.map(value => value.processNonce));
    assert.equal(epochs.size, 1);
    assert.equal(processNonces.size, 1);
    assert.equal(attached[0].canonicalPath, canonical);
    assert.equal(attached[0].epoch, registry.epoch);
    assert.equal(attached[0].processNonce, registry.processNonce);
    for (const value of attached) assert.equal(value.origin, origin);

    // Untitled sessions have no canonical path and must never share the path
    // lease, process identity, or origin of the named notebook.
    for (let index = 0; index < 2; index += 1) {
      untitledChildren.push(startCandidate({ launcher, cwd: fixtureDirectory, dataHome, selectedR, id: `untitled-${index}` }));
    }
    const untitledReady = await Promise.all(untitledChildren.map(entry => entry.ready));
    for (const value of untitledReady) assertCanonicalReady(value);
    const untitledOrigins = untitledReady.map(value => value.origin);
    assert.equal(untitledOrigins.every(value => typeof value === 'string'), true);
    assert.equal(new Set(untitledOrigins).size, untitledOrigins.length);
    assert.equal(untitledOrigins.includes(origin), false);

    const manifestPath = join(applicationRoot, dirname(ctx.manifest.resources.hostEntry), '..', 'manifest.json');
    const manifestSha256 = await sha256File(manifestPath);
    const identity = {
      sourceCommit: ctx.manifest.sourceCommit,
      manifestSha256,
      canonicalPath: canonical,
      aliasCount: aliases.length,
      owner: {
        pid: registry.pid,
        processNonce: registry.processNonce,
        reclaimedFromProcessNonce: staleOwnerProcessNonce,
        startIdentity: registry.startIdentity,
        epoch: registry.epoch,
        origin,
      },
      leases: {
        requested: CONCURRENT_STARTERS,
        attached: attached.length,
        sessionKey: attached[0].sessionKey,
        epoch: attached[0].epoch,
        processNonce: attached[0].processNonce,
      },
      untitled: {
        count: untitledReady.length,
        independentOrigins: untitledOrigins,
      },
    };
    await writeFile(evidencePath, `${JSON.stringify(redact({ id, identity, registry, ready, untitledReady }), null, 2)}\n`, 'utf8');
    return { id, identity };
  } finally {
    await cleanupScenarioResources(
      ...sessions.map(session => () => releaseLease(originFromSession(session), session)),
      ...children.concat(untitledChildren).map(entry => () => stopCandidate(entry)),
    );
  }
}

function startCandidate({ launcher, notebook, cwd, dataHome, selectedR, id }) {
  const args = [];
  if (notebook) args.push(notebook);
  args.push('--headless', '--no-run', '--port', '0', '--rscript', selectedR);
  const child = spawnSmokeProcess(launcher, args, {
    cwd,
    env: sanitizedEnvironment({ XDG_DATA_HOME: dataHome }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parser = createStrictReadyParser(child.stdout, { label: 'session-races:' + id });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = waitForCanonicalReady(parser, child, STARTUP_TIMEOUT_MS, 'session-races:' + id);
  return { id, child, parser, ready, get stderr() { return stderr; } };
}

async function stopCandidate(entry) {
  if (entry.child.exitCode === null && entry.child.signalCode === null) await stopChild(entry.child);
  await entry.parser.done;
  assertStrictReadyOutput(entry.parser, { requireReady: entry.parser.readyRecord !== null });
}

function originFromSession(session) {
  return session.origin;
}


function assertProcessAlive(pid) {
  assert.equal(Number.isInteger(pid) && pid > 0, true);
  try {
    process.kill(pid, 0);
  } catch (error) {
    throw new Error(`session_owner_not_alive:${pid}:${error.message}`);
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
