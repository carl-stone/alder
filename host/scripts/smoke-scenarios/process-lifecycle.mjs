import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  assertCanonicalReady,
  assertStrictReadyOutput,
  captureProcessTree,
  command,
  configureProcessObserver,
  createStrictReadyParser,
  delay,
  loadWireCodec,
  mergeProcessTrees,
  openSession,
  ownerMatches,
  query,
  processStartIdentity,
  readProcess,
  requireAbsoluteRscript,
  snapshot as canonicalSnapshot,
  requestJson,
  sanitizedEnvironment,
  signalSmokeProcessGroup,
  spawnSmokeProcess,
  startIdentityMatches,
  stopChild,
  waitForCanonicalReady,
  waitForOwnedProcessesGone,
  waitForRegistry,
  waitForExecutionReady,
} from './_common.mjs';

const STARTUP_TIMEOUT_MS = 120_000;
const PROCESS_TIMEOUT_MS = 15_000;
const TERMINAL = new Set(['done', 'error', 'failed', 'interrupted', 'cancelled']);

export async function run(ctx) {
  const id = 'process-lifecycle';
  assert.ok(['linux', 'darwin', 'win32'].includes(process.platform), 'process-lifecycle qualification requires a supported OS process observer');
  const selectedR = await requireAbsoluteRscript(ctx.rscript, 'process-lifecycle Rscript');
  const requestedR = selectedR;
  const selectedRHome = await resolveRHome(selectedR);

  const applicationRoot = await realpath(resolve(ctx.applicationRoot));
  const launcher = join(applicationRoot, ctx.manifest.resources.cliLauncher);
  const arkExecutable = await realpath(join(applicationRoot, ctx.manifest.resources.arkExecutable));
  const processSupervisorExecutable = await realpath(join(applicationRoot, ctx.manifest.resources.processSupervisorExecutable));
  configureProcessObserver(processSupervisorExecutable);
  assert.equal(processSupervisorExecutable.startsWith(applicationRoot + sep), true, 'process observer must resolve inside staged application');
  const processObserverOptions = { supervisorExecutable: processSupervisorExecutable };
  assert.equal(arkExecutable.startsWith(applicationRoot + sep), true, 'Ark executable must resolve inside staged application');
  const wire = await loadWireCodec(applicationRoot, ctx.manifest);
  const dataHome = join(ctx.evidence, 'runtime-data-process-lifecycle');
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  const fixtureDirectory = join(ctx.evidence, 'fixtures', id);
  const notebook = join(fixtureDirectory, 'sample.R');
  const source = '# %%\nSys.sleep(30)\ninterrupted_value <- 99L\ninterrupted_value\n# %%\n1 + 1\n';
  await rm(dataHome, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(notebook, source, 'utf8');

  const clients = [];
  const sessions = [];
  const observed = { lsp: false, analyzer: false, package: false, r: false, ark: false, monitor: false, quarto: false };
  const driverIdentity = await readProcess(process.pid, processObserverOptions);
  assert.ok(driverIdentity, 'unrelated smoke driver identity is unavailable');
  let primaryRegistry;
  let primaryGraph;
  let hardRegistry;
  let hardGraph;
  try {
    const first = startClient({ launcher, notebook, cwd: fixtureDirectory, dataHome, selectedR, id: 'first' });
    clients.push(first);
    const readyFirst = await first.ready;
    assertCanonicalReady(readyFirst);
    const canonical = await realpath(notebook);
    primaryRegistry = await waitForRegistry(canonical, runtimeDirectory, STARTUP_TIMEOUT_MS);
    assertRegistry(primaryRegistry, canonical);
    const firstSession = await openSession(primaryRegistry.address.browserOrigin, primaryRegistry);
    firstSession.wire = wire;
    sessions.push({ origin: primaryRegistry.address.browserOrigin, session: firstSession, active: true });

    const second = startClient({ launcher, notebook, cwd: fixtureDirectory, dataHome, selectedR, id: 'second' });
    clients.push(second);
    const readySecond = await second.ready;
    assertCanonicalReady(readySecond);
    const secondSession = await openSession(primaryRegistry.address.browserOrigin, primaryRegistry);
    secondSession.wire = wire;
    sessions.push({ origin: primaryRegistry.address.browserOrigin, session: secondSession, active: true });
    assert.equal(readySecond.origin, readyFirst.origin);
    assert.equal(secondSession.epoch, firstSession.epoch);
    assert.equal(secondSession.processNonce, firstSession.processNonce);
    assert.notEqual(secondSession.clientId, firstSession.clientId);
    assert.notEqual(secondSession.leaseId, firstSession.leaseId);

    const sessionIdentity = await waitForExecutionReady({
      origin: primaryRegistry.address.browserOrigin,
      session: secondSession,
      wire,
      query: value => query(primaryRegistry.address.browserOrigin, secondSession, value, wire),
    });
    assert.equal(sessionIdentity.runtime?.executionReady, true, 'selected R runtime was not ready');
    const runtimeRscript = await realpath(sessionIdentity.runtime?.rEnvironment?.rscript ?? '');
    if (requestedR !== undefined) assert.equal(runtimeRscript, await resolveRequestedRscript(requestedR), 'explicit Rscript selection changed');
    assert.equal(sessionIdentity.epoch, primaryRegistry.epoch);
    assert.equal(sessionIdentity.path, canonical);

    const analyzerGraph = await waitForProcessMatch(primaryRegistry.pid, primaryRegistry.startIdentity, process => /host-analyzer\.R|analyzer/i.test(process.command), PROCESS_TIMEOUT_MS, processObserverOptions);
    observed.analyzer = true;

    const lspResponse = await requestJson(primaryRegistry.address.browserOrigin, '/api/lsp', {
      method: 'POST',
      cookie: secondSession.cookie,
      csrf: secondSession.csrf,
      body: {
        method: 'textDocument/hover',
        params: { textDocument: { uri: 'file://' + canonical, version: 1 }, position: { line: 0, character: 0 } },
      },
    });
    assert.equal(lspResponse.ok, true, 'real LSP child did not answer through the staged host');
    const lspGraph = await waitForProcessMatch(primaryRegistry.pid, primaryRegistry.startIdentity, process => /host-lsp\.R|languageserver|lsp/i.test(process.command), PROCESS_TIMEOUT_MS, processObserverOptions);
    observed.lsp = true;

    const packageBefore = await snapshotOf(primaryRegistry.address.browserOrigin, secondSession);
    const packageReceipt = await issue(secondSession, primaryRegistry.address.browserOrigin, {
      type: 'packages-install',
      packages: ['AlderSmokeNoSuchPackage'],
      expectedDocumentRevision: packageBefore.documentRevision,
      kernelEpoch: packageBefore.runtime.kernelEpoch,
    });
    const packageGraph = await waitForProcessMatch(primaryRegistry.pid, primaryRegistry.startIdentity, process => /package-job\.R|packages/i.test(process.command), PROCESS_TIMEOUT_MS, processObserverOptions);
    observed.package = true;
    const packageOperation = await waitOperation(primaryRegistry.address.browserOrigin, secondSession, operationId(packageReceipt));
    assert.ok(TERMINAL.has(packageOperation.status), 'package child did not settle');

    // Release the first client lease before its process exits. The second
    // client must keep the same detached host alive and retain its identity.
    await releaseStrict(primaryRegistry.address.browserOrigin, firstSession);
    sessions[0].active = false;
    await stopOwnedClient(first);
    assertProcessIdentity(await readProcess(primaryRegistry.pid, processObserverOptions), primaryRegistry, 'host survived first-spawner exit');
    const attachedAfterExit = await snapshotOf(primaryRegistry.address.browserOrigin, secondSession);
    assert.equal(attachedAfterExit.epoch, primaryRegistry.epoch);

    const firstCell = attachedAfterExit.cells[0];
    const longReceipt = await issue(secondSession, primaryRegistry.address.browserOrigin, {
      type: 'run', scope: 'cell', target: { cellId: firstCell.id }, expectedDocumentRevision: attachedAfterExit.documentRevision,
    });
    const longId = operationId(longReceipt);
    const runningOperation = await waitForRunning(primaryRegistry.address.browserOrigin, secondSession, longId, firstCell.id);
    assert.equal(typeof runningOperation.runId, 'string', 'running operation did not expose a run identity');
    const activeGraph = await waitForProcessMatch(primaryRegistry.pid, primaryRegistry.startIdentity, process => processMatches(process, selectedRHome, arkExecutable, applicationRoot), PROCESS_TIMEOUT_MS, processObserverOptions);
    observed.r = activeGraph.some(process => processMatchesR(process, selectedRHome));
    observed.ark = activeGraph.some(process => processMatchesArk(process, arkExecutable));
    const activeArk = activeGraph.find(process => processMatchesArk(process, arkExecutable));
    assert.ok(activeArk, 'active graph did not expose exact Ark executable identity');
    observed.monitor = activeGraph.some(process => processMatchesMonitor(process, processSupervisorExecutable));
    assert.equal(observed.r, true, 'active staged host graph has no owned R child');
    assert.equal(observed.ark, true, 'active staged host graph has no owned Ark child');
    assert.equal(observed.monitor, true, 'active staged host graph has no native monitor child');
    primaryGraph = activeGraph;

    const interrupted = await issue(secondSession, primaryRegistry.address.browserOrigin, { type: 'interrupt', runId: runningOperation.runId });
    const interruptOperation = await waitOperation(primaryRegistry.address.browserOrigin, secondSession, operationId(interrupted));
    assert.ok(['done', 'error'].includes(interruptOperation.status), 'cross-client interrupt command did not settle');
    const longOperation = await waitOperation(primaryRegistry.address.browserOrigin, secondSession, longId);
    assert.ok(['cancelled', 'interrupted'].includes(longOperation.status), 'host did not settle the targeted run after peer interrupt');

    const afterInterrupt = await snapshotOf(primaryRegistry.address.browserOrigin, secondSession);
    const secondCell = afterInterrupt.cells[1];
    const successor = await issue(secondSession, primaryRegistry.address.browserOrigin, {
      type: 'run', scope: 'cell', target: { cellId: secondCell.id }, expectedDocumentRevision: afterInterrupt.documentRevision,
    });
    const successorOperation = await waitOperation(primaryRegistry.address.browserOrigin, secondSession, operationId(successor));
    assert.equal(successorOperation.status, 'done', 'successor run did not settle on the same host');
    const afterSuccessor = await snapshotOf(primaryRegistry.address.browserOrigin, secondSession);
    assert.match(JSON.stringify(afterSuccessor.cells[1].outputs), /\[1\] 2/);
    assert.equal(afterSuccessor.runtime.kernelEpoch, afterInterrupt.runtime.kernelEpoch);
    const successorGraph = await readProcessGraph(primaryRegistry.pid, primaryRegistry.startIdentity, processObserverOptions);
    const successorArk = successorGraph.find(process => processMatchesArk(process, arkExecutable));
    assert.ok(successorArk, 'successor run replaced or lost the Ark process');
    assert.equal(successorArk.pid, activeArk.pid, 'successor run changed the Ark PID');
    assert.equal(successorArk.startIdentity, activeArk.startIdentity, 'successor run changed the Ark start identity');

    const quarto = process.env.QUARTO_PATH ?? 'quarto';
    const quartoVersion = spawnSync(quarto, ['--version'], { encoding: 'utf8', timeout: 30_000, env: sanitizedEnvironment(), windowsHide: true });
    assert.equal(quartoVersion.status, 0, 'Quarto is required to qualify the application-owned Quarto child');
    const beforePublish = await snapshotOf(primaryRegistry.address.browserOrigin, secondSession);
    const settleReceipt = await issue(secondSession, primaryRegistry.address.browserOrigin, {
      type: 'run', scope: 'all', expectedDocumentRevision: beforePublish.documentRevision,
    });
    const settleOperation = await waitOperation(primaryRegistry.address.browserOrigin, secondSession, operationId(settleReceipt));
    assert.equal(settleOperation.status, 'done', 'all cells did not settle before publish');
    const publishSnapshot = await waitForExecutionReady({
      origin: primaryRegistry.address.browserOrigin,
      session: secondSession,
      wire,
      query: value => query(primaryRegistry.address.browserOrigin, secondSession, value, wire),
    });
    const publishGraphPromise = waitForProcessMatch(primaryRegistry.pid, primaryRegistry.startIdentity, process => /quarto/i.test(process.command), PROCESS_TIMEOUT_MS, processObserverOptions);
    const publishReceipt = await issue(secondSession, primaryRegistry.address.browserOrigin, {
      type: 'publish', includeCode: false, outputPath: join(ctx.evidence, 'process-lifecycle-published.html'), expectedDocumentRevision: publishSnapshot.documentRevision,
    });
    const publishGraph = await publishGraphPromise;
    observed.quarto = true;
    const publishOperation = await waitOperation(primaryRegistry.address.browserOrigin, secondSession, operationId(publishReceipt));
    assert.ok(TERMINAL.has(publishOperation.status), 'Quarto child did not settle');

    await releaseStrict(primaryRegistry.address.browserOrigin, secondSession);
    sessions[1].active = false;
    await stopOwnedClient(second);
    await terminateIfOwned(primaryRegistry, processObserverOptions);
    await assertOwnedProcessesGone(mergeGraphs(primaryGraph, analyzerGraph, lspGraph, packageGraph, publishGraph), PROCESS_TIMEOUT_MS, processObserverOptions);

    // Hard host death is exercised against a fresh real staged host. Only the
    // recorded PID with the matching start identity may be killed.
    const hardFixture = join(ctx.evidence, 'fixtures', id + '-hard');
    const hardNotebook = join(hardFixture, 'sample.R');
    const hardDataHome = join(ctx.evidence, 'runtime-data-process-lifecycle-hard');
    const hardRuntime = join(hardDataHome, 'alder-nodejs', 'runtime');
    await mkdir(hardFixture, { recursive: true });
    await rm(hardDataHome, { recursive: true, force: true });
    await mkdir(hardRuntime, { recursive: true, mode: 0o700 });
    await writeFile(hardNotebook, '# %%\nSys.sleep(30)\n1 + 1\n', 'utf8');
    const hardClient = startClient({ launcher, notebook: hardNotebook, cwd: hardFixture, dataHome: hardDataHome, selectedR, id: 'hard' });
    clients.push(hardClient);
    await hardClient.ready;
    hardRegistry = await waitForRegistry(await realpath(hardNotebook), hardRuntime, STARTUP_TIMEOUT_MS);
    assertRegistry(hardRegistry, await realpath(hardNotebook));
    const hardSession = await openSession(hardRegistry.address.browserOrigin, hardRegistry);
    hardSession.wire = wire;
    const hardSnapshot = await waitForExecutionReady({
      origin: hardRegistry.address.browserOrigin,
      session: hardSession,
      wire,
      query: value => query(hardRegistry.address.browserOrigin, hardSession, value, wire),
    });
    assert.equal(hardSnapshot.runtime?.executionReady, true, 'hard-kill selected R runtime was not ready');
    const hardRscript = await realpath(hardSnapshot.runtime?.rEnvironment?.rscript ?? '');
    if (requestedR !== undefined) assert.equal(hardRscript, await resolveRequestedRscript(requestedR), 'hard host changed explicit Rscript selection');
    const hardRun = await issue(hardSession, hardRegistry.address.browserOrigin, { type: 'run', scope: 'all', expectedDocumentRevision: hardSnapshot.documentRevision });
    await waitForRunning(hardRegistry.address.browserOrigin, hardSession, operationId(hardRun), hardSnapshot.cells[0].id);
    hardGraph = await readProcessGraph(hardRegistry.pid, hardRegistry.startIdentity, processObserverOptions);
    assert.equal(hardGraph.some(process => processMatchesR(process, selectedRHome)), true, 'hard-kill graph omitted the owned R child');
    await killOwnedHost(hardRegistry, processObserverOptions);
    await assertOwnedProcessesGone(hardGraph, PROCESS_TIMEOUT_MS, processObserverOptions);
    assertProcessIdentity(await readProcess(process.pid, processObserverOptions), { pid: process.pid, startIdentity: driverIdentity.startIdentity }, 'unrelated smoke driver');
    await stopOwnedClient(hardClient);

    const startupFailure = await exerciseStartupFailure(launcher, fixtureDirectory, dataHome, ctx.evidence, processObserverOptions);
    const compromised = await exerciseCompromisedLock(launcher, fixtureDirectory, dataHome, runtimeDirectory, primaryRegistry ?? hardRegistry, selectedR);

    for (const key of Object.keys(observed)) assert.equal(observed[key], true, 'required process kind was not observed: ' + key);
    const identity = {
      platform: process.platform,
      applicationRoot,
      requestedR,
      runtimeRscript,
      arkExecutable,
      unrelatedSmokeDriver: { pid: driverIdentity.pid, startIdentity: driverIdentity.startIdentity, survivedHardKill: true },
      manifestSha256: await sha256File(join(applicationRoot, dirname(ctx.manifest.resources.hostEntry), '..', 'manifest.json')),
      host: {
        pid: primaryRegistry.pid,
        startIdentity: primaryRegistry.startIdentity,
        processNonce: primaryRegistry.processNonce,
        epoch: primaryRegistry.epoch,
        graphDuringRun: primaryGraph,
      },
      processKinds: observed,
      ark: { active: activeArk, successor: successorArk },
      analyzer: { graph: analyzerGraph },
      lsp: { response: lspResponse, graph: lspGraph },
      package: { graph: packageGraph, status: packageOperation.status },
      publish: { graph: publishGraph, status: publishOperation.status, quartoVersion: quartoVersion.stdout.trim() },
      hardKill: { host: hardRegistry, graph: hardGraph, clean: true },
      startupFailure,
      compromisedLock: compromised,
    };
    await writeFile(join(ctx.evidence, id + '.json'), JSON.stringify({ id, identity }, null, 2) + '\n');
    return { id, identity };
  } finally {
    const cleanupErrors = [];
    for (const entry of sessions) {
      if (!entry.active) continue;
      try { await releaseStrict(entry.origin, entry.session); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const client of clients) {
      try { await stopOwnedClient(client); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (primaryRegistry) {
      try { await terminateIfOwned(primaryRegistry, processObserverOptions); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (hardRegistry) {
      try { await terminateIfOwned(hardRegistry, processObserverOptions); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'process-lifecycle cleanup failed');
  }
}
function startClient({ launcher, notebook, cwd, dataHome, selectedR, id }) {
  const child = spawnSmokeProcess(launcher, [notebook, '--headless', '--no-run', '--port', '0', '--rscript', selectedR], {
    cwd, env: sanitizedEnvironment({ XDG_DATA_HOME: dataHome }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const parser = createStrictReadyParser(child.stdout, { label: 'host:' + id });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = waitForCanonicalReady(parser, child, STARTUP_TIMEOUT_MS, 'host:' + id);
  return { id, child, parser, ready, get stdout() { return parser.stdout; }, get stderr() { return stderr; } };
}

async function stopOwnedClient(client) {
  if (!client) return;
  if (client.child.exitCode === null && client.child.signalCode === null) await stopChild(client.child);
  assert.ok(client.child.exitCode !== null || client.child.signalCode !== null, 'owned client did not exit');
  await client.parser.done;
  assertStrictReadyOutput(client.parser, { requireReady: client.parser.readyRecord !== null });
}

async function issue(session, origin, value) {
  const receipt = await command(origin, session, {
    ...value,
    operationId: value.operationId ?? randomUUID(),
    clientId: session.clientId,
    commandSequence: session.nextCommandSequence++,
    sessionEpoch: session.epoch,
  });
  assert.equal(receipt.accepted, true, 'staged command was not admitted: ' + JSON.stringify(receipt));
  return receipt;
}

async function waitOperation(origin, session, id) {
  assert.equal(typeof id, 'string');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = unwrap(await query(origin, session, { type: 'operation', operationId: id, clientId: session.clientId }));
    if (value && TERMINAL.has(value.status)) return value;
    if (Date.now() >= deadline) throw new Error('operation_timeout:' + id);
    await delay(100);
  }
}

async function waitForRunning(origin, session, id, cellId) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await snapshotOf(origin, session);
    const operation = unwrap(await query(origin, session, { type: 'operation', operationId: id, clientId: session.clientId }));
    if (snapshot.runtime?.busy === true && typeof operation?.runId === 'string' && snapshot.runtime?.activeRunId === operation.runId && operation.status === 'running' && (!cellId || snapshot.cells.some(cell => cell.id === cellId && cell.status === 'running'))) return operation;
    if (operation && TERMINAL.has(operation.status)) throw new Error('run settled before process graph capture: ' + JSON.stringify(operation));
    if (Date.now() >= deadline) throw new Error('run did not become active: ' + id);
    await delay(50);
  }
}

async function snapshotOf(origin, session) {
  return canonicalSnapshot({ query: value => query(origin, session, value, session.wire), session });
}

function operationId(receipt) {
  const id = receipt?.operation?.id ?? receipt?.operationId ?? receipt?.id;
  assert.equal(typeof id, 'string', JSON.stringify(receipt));
  return id;
}

async function releaseStrict(origin, session) {
  const value = await requestJson(origin, '/api/lease', {
    method: 'POST', cookie: session.cookie, csrf: session.csrf,
    body: { action: 'release', leaseId: session.leaseId },
  });
  assert.equal(value.released, true, 'lease release was not acknowledged');
}

async function assertOwnedProcessesGone(graph, timeout, processObserverOptions) {
  await waitForOwnedProcessesGone(graph, timeout, processObserverOptions);
}

async function terminateIfOwned(registry, processObserverOptions) {
  const owner = await readProcess(registry.pid, processObserverOptions);
  if (owner === null) return;
  assertProcessIdentity(owner, registry, 'cleanup target');
  let graph;
  try {
    graph = await readProcessGraph(registry.pid, registry.startIdentity, processObserverOptions);
  } catch (error) {
    if (String(error?.message ?? '').startsWith('owned_process_root_missing:')) return;
    throw error;
  }
  if (!await ownerMatches(registry.pid, registry.startIdentity, processObserverOptions)) return;
  globalThis.process.kill(registry.pid, 'SIGKILL');
  await assertOwnedProcessesGone(graph, PROCESS_TIMEOUT_MS, processObserverOptions);
}

function killOwnedHost(registry, processObserverOptions) {
  return readProcess(registry.pid, processObserverOptions).then(async process => {
    assertProcessIdentity(process, registry, 'hard-kill target');
    if (!await ownerMatches(registry.pid, registry.startIdentity, processObserverOptions)) return;
    globalThis.process.kill(registry.pid, 'SIGKILL');
  });
}

function assertProcessIdentity(process, registry, label) {
  assert.ok(process, label + ' is absent');
  assert.equal(process.pid, registry.pid, label + ' PID changed');
  assert.equal(startIdentityMatches(process.startIdentity, registry.startIdentity), true, label + ' start identity changed');
  assert.notEqual(process.state, 'Z', label + ' is a zombie');
}

async function readProcessGraph(rootPid, expectedStartIdentity, processObserverOptions) {
  return captureProcessTree(rootPid, expectedStartIdentity, processObserverOptions);
}

async function waitForProcessMatch(rootPid, expectedStartIdentity, predicate, timeout = PROCESS_TIMEOUT_MS, processObserverOptions) {
  const deadline = Date.now() + timeout;
  let lastGraph;
  for (;;) {
    lastGraph = await readProcessGraph(rootPid, expectedStartIdentity, processObserverOptions);
    const match = lastGraph.find(predicate);
    if (match) return lastGraph;
    if (Date.now() >= deadline) throw new Error('owned process kind was not observed under host ' + rootPid + ': ' + JSON.stringify(lastGraph));
    await delay(5);
  }
}

function mergeGraphs(...graphs) {
  return mergeProcessTrees(...graphs);
}
async function resolveRequestedRscript(value) {
  assert.equal(isAbsolute(value), true, 'explicit Rscript must be absolute');
  return realpath(value);
}

async function resolveRHome(rscript) {
  const result = spawnSync(rscript, ['-e', 'cat(R.home())'], { encoding: 'utf8', env: sanitizedEnvironment(), windowsHide: true });
  assert.equal(result.status, 0, 'selected Rscript R_HOME query failed');
  const rHome = String(result.stdout ?? '').trim();
  assert.ok(rHome.length > 0, 'selected Rscript returned no R_HOME');
  return realpath(rHome);
}

function processMatches(process, selectedRHome, arkExecutable, applicationRoot) {
  return processMatchesR(process, selectedRHome) || processMatchesArk(process, arkExecutable) || process.command.includes('--monitor') || process.command.includes(applicationRoot);
}
function processMatchesR(process, selectedRHome) {
  if (typeof process.executable !== 'string' || !isAbsolute(process.executable)) return false;
  const candidates = [
    join(selectedRHome, 'bin', 'exec', 'R'),
    join(selectedRHome, 'bin', 'exec', 'R.exe'),
    join(selectedRHome, 'bin', 'R'),
    join(selectedRHome, 'bin', 'R.exe'),
  ];
  return candidates.includes(process.executable);
}
function processMatchesArk(process, arkExecutable) {
  return process.executable === arkExecutable;
}

function processMatchesMonitor(process, supervisorExecutable) {
  return process.executable === supervisorExecutable && process.command.includes('--anchor');
}
function assertRegistry(registry, canonical) {
  assert.equal(registry.state, 'ready');
  assert.equal(registry.canonicalPath, canonical);
  assert.equal(typeof registry.pid, 'number');
  assert.equal(typeof registry.startIdentity, 'string');
  assert.equal(typeof registry.processNonce, 'string');
  assert.equal(typeof registry.epoch, 'string');
  assert.equal(typeof registry.address?.origin, 'string');
  assert.equal(typeof registry.address?.browserOrigin, 'string');
}

async function waitForSpawnIdentity(pid, options, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await processStartIdentity(pid, options);
    } catch (error) {
      if (!String(error?.message ?? '').startsWith('process_observer_candidate_missing:')) throw error;
    }
    if (Date.now() >= deadline) throw new Error('startup child identity unavailable');
    await delay(50);
  }
}

async function exerciseStartupFailure(launcher, cwd, dataHome, evidence, processObserverOptions) {
  const startupNotebook = join(cwd, 'sample.R');
  const startupCanonical = await realpath(startupNotebook);
  const startupDataHome = join(dataHome, 'startup-failure');
  const startupRegistryPath = join(startupDataHome, 'alder-nodejs', 'runtime', createHash('sha256').update('path:' + startupCanonical).digest('hex') + '.json');
  const invalid = spawnSmokeProcess(launcher, [startupNotebook, '--headless', '--no-run', '--port', '0', '--rscript', join(evidence, 'missing-rscript')], {
    cwd, env: sanitizedEnvironment({ XDG_DATA_HOME: startupDataHome }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exitPromise = once(invalid, 'exit');
  const parser = createStrictReadyParser(invalid.stdout, { label: 'startup-failure' });
  let stderr = '';
  invalid.stderr.setEncoding('utf8');
  invalid.stderr.on('data', value => { stderr += value; });
  const invalidStartIdentity = await waitForSpawnIdentity(invalid.pid, processObserverOptions);
  const [code, signal] = await Promise.race([
    exitPromise,
    delay(30_000).then(async () => {
      const observed = await readProcess(invalid.pid, processObserverOptions);
      const stillOwned = observed !== null
        && startIdentityMatches(observed.startIdentity, invalidStartIdentity)
        && observed.state !== 'Z';
      if (stillOwned) signalSmokeProcessGroup(invalid.pid, 'SIGKILL');
      return exitPromise;
    }),
  ]);
  await parser.done;
  assertStrictReadyOutput(parser, { requireReady: false });
  const stdout = parser.stdout;
  assert.ok((Number.isInteger(code) && code !== 0) || signal !== null, 'invalid R startup must terminate unsuccessfully');
  const startupRegistryText = await readFile(startupRegistryPath, 'utf8').catch(() => null);
  if (startupRegistryText !== null) {
    await terminateIfOwned(JSON.parse(startupRegistryText), processObserverOptions);
    await rm(startupRegistryPath, { force: true });
  }
  const hostReady = /"type"\s*:\s*"host\.ready"/.test(stdout);
  return { code, signal, hostReady, stdoutSha256: sha256Text(stdout), stderrSha256: sha256Text(stderr) };
}

async function exerciseCompromisedLock(launcher, cwd, dataHome, runtimeDirectory, template, selectedR) {
  const notebook = join(cwd, 'compromised.R');
  await writeFile(notebook, '# %%\n1 + 1\n', 'utf8');
  const canonical = await realpath(notebook);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const registryPath = join(runtimeDirectory, createHash('sha256').update('path:' + canonical).digest('hex') + '.json');
  const forged = {
    ...template,
    state: 'ready',
    pid: process.pid,
    startIdentity: 'forged-start-identity',
    canonicalPath: canonical,
    origin: 'http://127.0.0.1:1',
    address: { host: '127.0.0.1', port: 1, origin: 'http://127.0.0.1:1' },
  };
  await writeFile(registryPath, JSON.stringify(forged), { mode: 0o600 });
  const client = startClient({ launcher, notebook, cwd, dataHome, selectedR, id: 'compromised' });
  try {
    await assert.rejects(client.ready, /host_(exited_before_ready|ready_timeout|spawn_failed)|compromised_ready_timeout/);
    await stopOwnedClient(client);
    return { rejected: true, registryPath, pid: forged.pid, startIdentity: forged.startIdentity };
  } finally {
    await rm(registryPath, { force: true });
    await stopOwnedClient(client).catch(() => undefined);
  }
}

function unwrap(value) { return value?.result ?? value; }
function sha256Text(value) { return createHash('sha256').update(value).digest('hex'); }
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
