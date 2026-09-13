import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  captureProcessTree,
  command,
  configureProcessObserver,
  createHarness,
  delay,
  openSession,
  query,
  readProcess,
  requestJson,
  snapshot as canonicalSnapshot,
  startIdentityMatches,
  waitForExecutionReady,
  waitForOwnedProcessesGone,
} from './_common.mjs';
import { realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const PROCESS_TIMEOUT_MS = 15_000;
const TERMINAL = new Set(['done', 'error', 'failed', 'interrupted', 'cancelled']);

export async function run(ctx) {
  const id = 'interrupt-native';
  requireSupportedProcessObserver(id);
  const harness = await createHarness(ctx, {
    id,
    source: '# %%\nSys.sleep(30)\ninterrupted_value <- 99L\ninterrupted_value\n# %%\n1 + 1\n',
    rscript: ctx.rscript,
  });
  let peer;
  let peerReleased = false;
  let ownedGraph = [];
  let processObserverOptions = {};
  try {
    const beforeIdentity = await harness.request('/api/identity', { cookie: harness.session.cookie, csrf: harness.session.csrf });
    await waitForExecutionReady(harness);
    const initial = await harness.snapshot();
    assert.equal(initial.runtime.executionReady, true, 'runtime was not ready before interrupt probe');
    assert.equal(typeof initial.runtime.kernelEpoch, 'string', 'runtime did not expose a kernel incarnation');
    assert.equal(typeof beforeIdentity.processNonce, 'string');
    assert.equal(typeof beforeIdentity.epoch, 'string');
    assert.equal(typeof harness.registry.pid, 'number');
    assert.equal(typeof harness.registry.startIdentity, 'string');
    const stagedRoot = await realpath(resolve(ctx.applicationRoot));
    const arkPath = await realpath(join(stagedRoot, ctx.manifest.resources.arkExecutable));
    assert.equal(arkPath.startsWith(stagedRoot + sep), true, 'Ark executable must resolve inside staged application');
    const processSupervisorPath = await realpath(join(stagedRoot, ctx.manifest.resources.processSupervisorExecutable));
    assert.equal(processSupervisorPath.startsWith(stagedRoot + sep), true, 'process supervisor must resolve inside staged application');
    configureProcessObserver(processSupervisorPath);
    processObserverOptions = { supervisorExecutable: processSupervisorPath };
    const beforeHost = await readProcess(harness.registry.pid, processObserverOptions);
    assertProcessIdentity(beforeHost, harness.registry, 'registered host');
    const beforeGraph = await captureProcessTree(harness.registry.pid, harness.registry.startIdentity, processObserverOptions);
    ownedGraph = beforeGraph;
    const arkBefore = findArk(beforeGraph, arkPath);
    assert.ok(arkBefore, 'Ark process was not present before the cross-client interrupt');

    peer = await openSession(harness.origin, harness.registry);
    peer.wire = harness.wire;
    assert.notEqual(peer.clientId, harness.session.clientId);
    assert.notEqual(peer.leaseId, harness.session.leaseId);

    const longCell = initial.cells[0];
    const runAdmission = await issue(harness.origin, harness.session, {
      type: 'run', scope: 'cell', target: { cellId: longCell.id }, expectedDocumentRevision: initial.documentRevision,
    });
    const operationId = operationIdOf(runAdmission);
    const runningOperation = await waitForRunning(harness.origin, harness.session, operationId);
    const runId = runningOperation.runId;
    assert.equal(typeof runId, 'string', 'long-running operation did not receive a run identity');
    const activeGraph = await waitForProcess(harness.registry.pid, harness.registry.startIdentity, process => processMatchesArk(process, arkPath), PROCESS_TIMEOUT_MS, processObserverOptions);
    const activeArk = findArk(activeGraph, arkPath);
    assert.ok(activeArk, 'active run did not retain an Ark process identity');
    assert.equal(activeArk.pid, arkBefore.pid);
    assert.equal(startIdentityMatches(activeArk.startIdentity, arkBefore.startIdentity), true);

    // The peer lease, not the submitting client, controls the actual stop.
    const interruptAdmission = await issue(harness.origin, peer, { type: 'interrupt', runId });
    const interruptOperation = await waitOperation(harness.origin, peer, operationIdOf(interruptAdmission));
    assert.equal(interruptOperation.status, 'done', 'cross-client interrupt admission did not settle');
    assert.equal(interruptOperation.result?.requested, true);
    const runOperation = await waitOperation(harness.origin, harness.session, operationId);
    assert.ok(['cancelled', 'interrupted'].includes(runOperation.status), 'targeted run was not interrupted');
    assert.match(JSON.stringify(runOperation.error ?? runOperation.result ?? runOperation), /interrupt|cancel/i, 'interrupt lost the original terminal condition');

    const settled = await snapshotFor(harness.origin, peer);
    assert.equal(settled.runtime.busy, false);
    assert.equal(settled.runtime.activeRunId, null);
    assert.equal(settled.runtime.executionReady, true);
    assert.equal(settled.runtime.kernelEpoch, initial.runtime.kernelEpoch, 'interrupt replaced the kernel incarnation');
    const afterIdentity = await harness.request('/api/identity', { cookie: peer.cookie, csrf: peer.csrf });
    assert.equal(afterIdentity.processNonce, beforeIdentity.processNonce);
    assert.equal(afterIdentity.epoch, beforeIdentity.epoch);
    const afterHost = await readProcess(harness.registry.pid, processObserverOptions);
    assertProcessIdentity(afterHost, harness.registry, 'host after interrupt');
    const afterGraph = await waitForProcess(harness.registry.pid, harness.registry.startIdentity, process => processMatchesArk(process, arkPath), PROCESS_TIMEOUT_MS, processObserverOptions);
    const afterArk = findArk(afterGraph, arkPath);
    assert.equal(afterArk.pid, activeArk.pid);
    assert.equal(startIdentityMatches(afterArk.startIdentity, activeArk.startIdentity), true);

    const successorCell = settled.cells[1];
    const successorAdmission = await issue(harness.origin, peer, {
      type: 'run', scope: 'cell', target: { cellId: successorCell.id }, expectedDocumentRevision: settled.documentRevision,
    });
    const successorOperation = await waitOperation(harness.origin, peer, operationIdOf(successorAdmission));
    assert.equal(successorOperation.status, 'done', 'successor 1+1 did not settle after interrupt');
    const afterSuccessor = await snapshotFor(harness.origin, peer);
    assert.match(JSON.stringify(afterSuccessor.cells[1].outputs), /\[1\] 2/);
    assert.equal(afterSuccessor.runtime.kernelEpoch, initial.runtime.kernelEpoch);
    const successorGraph = await captureProcessTree(harness.registry.pid, harness.registry.startIdentity, processObserverOptions);
    ownedGraph = successorGraph;
    const successorArk = findArk(successorGraph, arkPath);
    assert.ok(successorArk, 'successor run lost the Ark process');
    assert.equal(successorArk.pid, arkBefore.pid);
    assert.equal(startIdentityMatches(successorArk.startIdentity, arkBefore.startIdentity), true);

    const identity = {
      platform: process.platform,
      host: {
        pid: beforeHost.pid,
        startIdentity: beforeHost.startIdentity,
        processNonce: beforeIdentity.processNonce,
        epoch: beforeIdentity.epoch,
      },
      kernel: {
        kernelEpoch: initial.runtime.kernelEpoch,
        ark: { before: arkBefore, active: activeArk, afterInterrupt: afterArk, afterSuccessor: successorArk },
      },
      clients: { submitter: harness.session.clientId, interrupter: peer.clientId },
      run: { operationId, runId, status: runOperation.status, error: runOperation.error },
      interrupt: { operationId: operationIdOf(interruptAdmission), status: interruptOperation.status, result: interruptOperation.result },
      successor: { operationId: operationIdOf(successorAdmission), status: successorOperation.status, value: 2 },
    };
    await writeFile(ctx.evidence + '/' + id + '.json', JSON.stringify({ id, identity }, null, 2) + '\n');
    return { id, identity };
  } finally {
    const cleanupErrors = [];
    if (peer && !peerReleased) {
      try { await releaseStrict(harness.origin, peer); peerReleased = true; }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await harness.close(); }
    catch (error) { cleanupErrors.push(error); }
    try { await waitForOwnedProcessesGone(ownedGraph, PROCESS_TIMEOUT_MS, processObserverOptions); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'interrupt-native cleanup failed');
  }
}

async function snapshotFor(origin, session) {
  return canonicalSnapshot({ query: value => query(origin, session, value, session.wire), session });
}

async function issue(origin, session, value) {
  const receipt = await command(origin, session, {
    ...value,
    operationId: value.operationId ?? randomUUID(),
    clientId: session.clientId,
    commandSequence: session.nextCommandSequence++,
    sessionEpoch: session.epoch,
  });
  assert.equal(receipt.accepted, true, 'cross-client command was not admitted: ' + JSON.stringify(receipt));
  return receipt;
}

async function waitOperation(origin, session, id) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const operation = unwrap(await query(origin, session, { type: 'operation', operationId: id, clientId: session.clientId }));
    if (operation && TERMINAL.has(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error('operation_timeout:' + id);
    await delay(100);
  }
}

async function waitForRunning(origin, session, id) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await snapshotFor(origin, session);
    const operation = unwrap(await query(origin, session, { type: 'operation', operationId: id, clientId: session.clientId }));
    if (snapshot.runtime.busy === true && typeof operation?.runId === 'string' && snapshot.runtime.activeRunId === operation.runId && operation.status === 'running') return operation;
    if (operation && TERMINAL.has(operation.status)) throw new Error('run settled before peer interrupt: ' + JSON.stringify(operation));
    if (Date.now() >= deadline) throw new Error('run did not become active:' + id);
    await delay(50);
  }
}

async function waitForProcess(rootPid, expectedStartIdentity, predicate, timeout, processObserverOptions) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const graph = await captureProcessTree(rootPid, expectedStartIdentity, processObserverOptions);
    const match = graph.find(predicate);
    if (match) return graph;
    if (Date.now() >= deadline) throw new Error('owned process was not observed under host ' + rootPid);
    await delay(50);
  }
}

async function releaseStrict(origin, session) {
  const value = await requestJson(origin, '/api/lease', {
    method: 'POST', cookie: session.cookie, csrf: session.csrf,
    body: { action: 'release', leaseId: session.leaseId },
  });
  assert.equal(value.released, true);
}

function assertProcessIdentity(process, registry, label) {
  assert.ok(process, label + ' was not observed');
  assert.equal(process.pid, registry.pid, label + ' PID changed');
  assert.equal(startIdentityMatches(process.startIdentity, registry.startIdentity), true, label + ' start identity changed');
  assert.notEqual(process.state, 'Z', label + ' is a zombie');
}

function findArk(graph, executable) {
  return graph.find(process => processMatchesArk(process, executable));
}
function processMatchesArk(process, executable) {
  return sameExecutable(process.executable, executable) || sameExecutable(commandExecutable(process.command), executable);
}
function commandExecutable(command) {
  const value = typeof command === 'string' ? command.trim() : '';
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    return end > 1 ? value.slice(1, end) : null;
  }
  return value.split(/\s+/, 1)[0] || null;
}
function sameExecutable(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const normalize = value => value.replaceAll('\\', '/');
  const left = normalize(actual);
  const right = normalize(expected);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function operationIdOf(value) {
  const id = value?.operation?.id ?? value?.operationId ?? value?.id;
  assert.equal(typeof id, 'string', JSON.stringify(value));
  return id;
}
function unwrap(value) { return value?.result ?? value; }
function requireSupportedProcessObserver(id) {
  if (['linux', 'darwin', 'win32'].includes(process.platform)) return;
  const error = new Error('scenario_unavailable: ' + id + ' requires a supported OS process observer');
  error.code = 'scenario_unavailable';
  throw error;
}
