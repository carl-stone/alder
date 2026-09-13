import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  cleanupScenarioResources,
  assertCanonicalReady,
  assertStrictReadyOutput,
  captureProcessTree,
  cleanupOwnedProcessTree,
  cleanupPartialOwner,
  createHarness,
  createStrictReadyParser,
  delay,
  openSession,
  query,
  redact,
  releaseLease,
  sanitizedEnvironment,
  snapshot,
  spawnSmokeProcess,
  stopChild,
  waitForCanonicalReady,
  waitForExecutionReady,
  waitForRegistry,
} from './_common.mjs';

const OPERATION_TIMEOUT_MS = 120_000;
const DISK_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_LIMIT = 512;

export async function run(ctx) {
  let untitledHarness;
  let harness;
  let liveDestination;
  let liveDestinationSession;
  const saveAsDirectory = join(ctx.evidence, 'save-as');
  let migratedDestination;
  const occupied = join(saveAsDirectory, 'occupied-notebook.R');
  const untitledDestination = join(saveAsDirectory, 'untitled-saved-notebook.R');
  const destination = join(saveAsDirectory, 'saved-notebook.R');
  const runtimeDirectory = join(ctx.evidence, 'runtime-data', 'save-as', 'alder-nodejs', 'runtime');
  const occupiedBytes = Buffer.from('user-owned destination\n', 'utf8');
  const sourceBytes = Buffer.from('# %%\nsource <- 1\nsource\n# %%\nsource + 1\n', 'utf8');
  const editedBytes = Buffer.from('# %%\nsource <- 7\nsource\n# %%\nsource + 1\n', 'utf8');
  const reloadedBytes = Buffer.from('# %%\nsource <- 9\nsource\n# %%\nsource + 1\n', 'utf8');
  const evidence = { protocol: 'alder-host-v2', id: 'save-as' };
  try {
    await mkdir(saveAsDirectory, { recursive: true });
    await writeFile(occupied, occupiedBytes, { flag: 'wx' });

    // Keep the untitled Save As path as a distinct contract: it must establish
    // a path and retain the authenticated lease without an original source.
    untitledHarness = await createHarness(ctx, {
      id: 'save-as-untitled',
      source: null,
      rscript: requireRscript(ctx),
    });
    const untitled = await runUntitledSaveAs(untitledHarness, occupied, untitledDestination, occupiedBytes);
    evidence.untitled = {
      destination: untitledDestination,
      digest: digest(untitled.destinationBytes),
      bytes: untitled.destinationBytes.byteLength,
      operation: summarizeOperation(untitled.operation),
      occupiedOperation: summarizeOperation(untitled.occupiedOperation),
      identity: summarizeIdentity(untitled.afterIdentity),
    };
    await untitledHarness.close();
    untitledHarness = undefined;

    // The named source is used for old-original preservation and for proving
    // the real registry owner blocks an absent destination path.
    harness = await createHarness(ctx, {
      id: 'save-as',
      source: sourceBytes.toString('utf8'),
      rscript: requireRscript(ctx),
    });
    await waitForExecutionReady(harness);
    const initial = await harness.snapshot();
    assert.equal(initial.path, harness.canonical, 'named fixture must expose its canonical source path');
    assert.equal(initial.disk.state, 'present');
    assert.equal(initial.disk.digest, digest(sourceBytes));
    assert.equal(typeof initial.disk.version, 'string');
    assert.ok(initial.cells.length >= 2, 'named fixture must expose both source cells');
    const initialCellIds = initial.cells.map(cell => cell.id);
    const sourceCanonical = harness.canonical;
    const sourceRegistryPath = registryPath(runtimeDirectory, sourceCanonical);
    const originalRegistry = { ...harness.registry };
    let originalIdentity;

    const sourceCell = initial.cells[0];
    const edit = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: sourceCell.id },
        expectedRevision: sourceCell.revision,
        body: ['source <- 7', 'source'],
        cellType: sourceCell.type,
      }],
    });
    const editAdmission = assertAdmission(await harness.command(edit), harness, edit);
    assert.equal(editAdmission.accepted, true, 'named source edit must be admitted');
    const editOperation = await waitForTerminal(harness, edit.operationId);
    assert.equal(editOperation.status, 'done', describeOperation(editOperation));
    const dirty = await harness.snapshot();
    assert.equal(dirty.path, sourceCanonical);
    assert.equal(dirty.dirty, true);
    originalIdentity = await identity(harness);
    assert.deepEqual(dirty.cells.map(cell => cell.id), initialCellIds);

    // Start a genuine second host in the same runtime directory. Removing its
    // file leaves an absent disk observation while its live registry claim stays.
    const openFixture = join(ctx.evidence, 'fixtures', 'save-as-open-session', 'sample.R');
    const openBytes = Buffer.from('# %%\nopen_owner <- 1\nopen_owner\n', 'utf8');
    await mkdir(dirname(openFixture), { recursive: true });
    await writeFile(openFixture, openBytes);
    liveDestination = await startLiveHost({
      launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher),
      notebook: openFixture,
      cwd: join(ctx.evidence, 'unrelated'),
      dataHome: join(ctx.evidence, 'runtime-data', 'save-as'),
      selectedR: requireRscript(ctx),
      id: 'save-as-open-session',
    });
    const openReady = await liveDestination.ready;
    assertCanonicalReady(openReady);
    const openCanonical = await realpath(openFixture);
        liveDestination.canonical = openCanonical;
        liveDestination.origin = openReady.origin;
    liveDestination.registry = await waitForRegistry(openCanonical, runtimeDirectory, OPERATION_TIMEOUT_MS);
    assert.equal(liveDestination.registry.state, 'ready');
    assert.equal(liveDestination.registry.canonicalPath, openCanonical);
    liveDestination.tree = await captureProcessTree(liveDestination.registry.pid, liveDestination.registry.startIdentity);
    liveDestinationSession = await openSession(openReady.origin, liveDestination.registry);
    const openView = {
      origin: openReady.origin,
      wire: harness.wire,
      session: liveDestinationSession,
      query: value => query(openReady.origin, liveDestinationSession, value, harness.wire),
    };
    const openInitial = await snapshot(openView);
    assert.equal(openInitial.path, openCanonical);
    assert.equal(openInitial.disk.state, 'present');
    await unlink(openFixture);
    const openAbsent = await waitForAbsentDisk(openView);
    assert.equal(openAbsent.path, openCanonical, 'live owner must retain the canonical path after file removal');
    assert.equal(openAbsent.disk.state, 'absent');
    assert.equal(openAbsent.disk.digest, null);
    assert.equal(openAbsent.disk.version, null);

    const openAttempt = makeCommand(harness, {
      type: 'save-as',
      path: openFixture,
      expectedDestination: 'absent',
      expectedDocumentRevision: dirty.documentRevision,
    });
    const openAdmission = assertAdmission(await harness.command(openAttempt), harness, openAttempt);
    assert.equal(openAdmission.accepted, true, 'owned absent destination Save As must be admitted before conflict detection');
    const openOperation = await waitForTerminal(harness, openAttempt.operationId);
    assert.equal(openOperation.status, 'error', describeOperation(openOperation));
    assert.equal(openOperation.error?.code, 'session_unavailable', describeOperation(openOperation));
    await assertMissing(openFixture);
    const afterOpenRejected = await harness.snapshot();
    assert.equal(afterOpenRejected.path, sourceCanonical);
    assert.equal(afterOpenRejected.documentRevision, dirty.documentRevision);
    assert.equal(afterOpenRejected.dirty, true);
    assert.deepEqual(stableCells(afterOpenRejected.cells), stableCells(dirty.cells));
    assert.deepEqual(await readFile(harness.notebook), sourceBytes, 'owned destination rejection must preserve original source bytes');

    await closeLiveHost(liveDestination, liveDestinationSession, runtimeDirectory, openCanonical);
    liveDestination = undefined;
    liveDestinationSession = undefined;

    await assertMissing(destination);
    const saveAs = makeCommand(harness, {
      type: 'save-as',
      path: destination,
      expectedDestination: 'absent',
      expectedDocumentRevision: dirty.documentRevision,
    });
    const admission = assertAdmission(await harness.command(saveAs), harness, saveAs);
    assert.equal(admission.accepted, true, 'named Save As command must be admitted');
    const operation = await waitForTerminal(harness, saveAs.operationId);
    assert.equal(operation.status, 'done', describeOperation(operation));

    const canonicalDestination = await realpath(destination);
    migratedDestination = canonicalDestination;
    const destinationBytes = await readFile(destination);
    assert.deepEqual(destinationBytes, editedBytes, 'Save As must preserve exact serialized bytes');
    const destinationInfo = await lstat(destination);
    assert.equal(destinationInfo.isFile(), true, 'Save As destination must be a regular file');
    assert.equal(destinationInfo.isSymbolicLink(), false, 'Save As must not publish a symlink');
    assert.deepEqual(await readFile(harness.notebook), sourceBytes, 'Save As must preserve the old original source');
    const after = await harness.snapshot();
    assert.equal(after.path, canonicalDestination, 'successful Save As must establish the destination session path');
    assert.deepEqual(after.cells.map(cell => cell.id), initialCellIds, 'Save As must preserve cell identities');
    assert.equal(after.disk.state, 'present');
    assert.equal(after.disk.digest, digest(destinationBytes));
    assert.equal(typeof after.disk.version, 'string');

    const afterIdentity = await identity(harness);
    assert.equal(afterIdentity.canonicalPath, canonicalDestination);
    assert.equal(afterIdentity.epoch, originalIdentity.epoch, 'Save As must preserve the host epoch');
    assert.equal(afterIdentity.processNonce, originalIdentity.processNonce, 'Save As must preserve process identity');
    assert.equal(afterIdentity.clientId, originalIdentity.clientId, 'Save As must preserve client identity');
    assert.equal(afterIdentity.leaseId, originalIdentity.leaseId, 'Save As must preserve the authenticated lease');
    assert.equal(afterIdentity.nextCommandSequence, originalIdentity.nextCommandSequence + 2);

    const destinationRegistryPath = registryPath(runtimeDirectory, canonicalDestination);
    const destinationRegistry = JSON.parse(await readFile(destinationRegistryPath, 'utf8'));
    assert.equal(destinationRegistry.state, 'ready');
    assert.equal(destinationRegistry.canonicalPath, canonicalDestination);
    for (const field of ['pid', 'processNonce', 'startIdentity', 'epoch', 'token', 'protocol', 'origin']) {
      assert.equal(destinationRegistry[field], originalRegistry[field], `Save As must preserve registry ${field}`);
    }
    assert.equal(destinationRegistry.address?.origin, originalRegistry.address?.origin);
    await assertMissing(sourceRegistryPath);

    // A subsequent save clears the dirty state on the new source, then an
    // explicit reload uses the observed digest and version preconditions.
    const followupSave = makeCommand(harness, {
      type: 'save',
      expectedDocumentRevision: after.documentRevision,
    });
    const followupSaveAdmission = assertAdmission(await harness.command(followupSave), harness, followupSave);
    assert.equal(followupSaveAdmission.accepted, true);
    const followupSaveOperation = await waitForTerminal(harness, followupSave.operationId);
    assert.equal(followupSaveOperation.status, 'done', describeOperation(followupSaveOperation));
    const clean = await harness.snapshot();
    assert.equal(clean.path, canonicalDestination);
    assert.equal(clean.dirty, false);
    assert.equal(clean.disk.digest, digest(editedBytes));
    assert.equal(typeof clean.disk.version, 'string');

    await writeFile(destination, reloadedBytes);
    const observedReloadDisk = await waitForDisk(harness, digest(reloadedBytes));
    assert.equal(observedReloadDisk.disk.state, 'present');
    assert.equal(typeof observedReloadDisk.disk.version, 'string');
    const reload = makeCommand(harness, {
      type: 'reload-source',
      expectedDocumentRevision: observedReloadDisk.documentRevision,
      expectedDiskDigest: observedReloadDisk.disk.digest,
      expectedDiskVersion: observedReloadDisk.disk.version,
    });
    const reloadAdmission = assertAdmission(await harness.command(reload), harness, reload);
    assert.equal(reloadAdmission.accepted, true);
    const reloadOperation = await waitForTerminal(harness, reload.operationId);
    assert.equal(reloadOperation.status, 'done', describeOperation(reloadOperation));
    const reloaded = await harness.snapshot();
    assert.equal(reloaded.path, canonicalDestination);
    assert.equal(reloaded.dirty, false);
    assert.deepEqual(reloaded.cells.map(cell => cell.id), initialCellIds, 'reload must preserve stable cell identities');
    assert.deepEqual(await readFile(destination), reloadedBytes, 'reload must retain exact external bytes');
    assert.equal(reloaded.disk.digest, digest(reloadedBytes));
    const finalIdentity = await identity(harness);
    assert.equal(finalIdentity.epoch, afterIdentity.epoch);
    assert.equal(finalIdentity.processNonce, afterIdentity.processNonce);
    assert.equal(finalIdentity.clientId, afterIdentity.clientId);
    assert.equal(finalIdentity.leaseId, afterIdentity.leaseId);
    assert.equal(finalIdentity.nextCommandSequence, afterIdentity.nextCommandSequence + 2);

    evidence.source = {
      canonicalPath: sourceCanonical,
      initialDigest: digest(sourceBytes),
      initialBytes: sourceBytes.byteLength,
      preservedAfterSaveAs: true,
      operation: summarizeOperation(operation),
      openSessionOperation: summarizeOperation(openOperation),
    };
    evidence.destination = {
      canonicalPath: canonicalDestination,
      editedDigest: digest(editedBytes),
      editedBytes: editedBytes.byteLength,
      reloadedDigest: digest(reloadedBytes),
      reloadedBytes: reloadedBytes.byteLength,
      saveOperation: summarizeOperation(followupSaveOperation),
      reloadOperation: summarizeOperation(reloadOperation),
    };
    evidence.identity = {
      original: summarizeIdentity(originalIdentity),
      afterSaveAs: summarizeIdentity(afterIdentity),
      final: summarizeIdentity(finalIdentity),
      owner: {
        pid: destinationRegistry.pid,
        processNonce: destinationRegistry.processNonce,
        startIdentity: destinationRegistry.startIdentity,
        epoch: destinationRegistry.epoch,
      },
    };
    await writeEvidence(ctx.evidence, evidence);
    return {
      id: 'save-as',
      identity: {
        artifact: {
          sourceCommit: ctx.manifest.sourceCommit,
          hostProtocol: ctx.manifest.hostProtocol,
          engineProtocol: ctx.manifest.engineProtocol,
          launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher),
        },
        source: { canonicalPath: sourceCanonical, digest: digest(sourceBytes), bytes: sourceBytes.byteLength },
        destination: { canonicalPath: canonicalDestination, digest: digest(reloadedBytes), bytes: reloadedBytes.byteLength },
        runtime: {
          pid: destinationRegistry.pid,
          epoch: finalIdentity.epoch,
          processNonce: finalIdentity.processNonce,
          startIdentity: destinationRegistry.startIdentity,
        },
      },
    };
  } finally {
    await cleanupScenarioResources(
      () => liveDestination === undefined ? undefined : closeLiveHost(liveDestination, liveDestinationSession, runtimeDirectory, liveDestination.canonical),
      () => harness === undefined ? undefined : harness.close(),
      () => migratedDestination === undefined ? undefined : cleanupPartialOwner(migratedDestination, runtimeDirectory),
      () => untitledHarness?.close(),
    );
  }
}

async function runUntitledSaveAs(harness, occupied, destination, occupiedBytes) {
  await assertMissing(destination);
  const initial = await harness.snapshot();
  assert.equal(initial.path, null, 'untitled acquisition must have no canonical path');
  let editBase = initial;
  let cell = initial.cells[0];
  if (cell === undefined) {
    const create = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{ type: 'create', creationId: 'untitled-initial-cell', after: null, cellType: 'code', body: [], options: {} }],
    });
    assert.equal(assertAdmission(await harness.command(create), harness, create).accepted, true);
    const createOperation = await waitForTerminal(harness, create.operationId);
    assert.equal(createOperation.status, 'done', describeOperation(createOperation));
    editBase = await harness.snapshot();
    cell = editBase.cells[0];
  }
  assert.ok(cell, 'untitled fixture must expose a source cell after initialization');
  const edit = makeCommand(harness, {
    type: 'transaction',
    expectedDocumentRevision: editBase.documentRevision,
    changes: [{
      type: 'edit',
      cell: { cellId: cell.id },
      expectedRevision: cell.revision,
      body: ['save_as_marker <- 7', 'save_as_marker'],
      cellType: cell.type,
    }],
  });
  assert.equal(assertAdmission(await harness.command(edit), harness, edit).accepted, true);
  const editOperation = await waitForTerminal(harness, edit.operationId);
  assert.equal(editOperation.status, 'done', describeOperation(editOperation));
  const dirty = await harness.snapshot();
  assert.equal(dirty.path, null);
  assert.equal(dirty.dirty, true);
  const originalIdentity = await identity(harness);

  const occupiedAttempt = makeCommand(harness, {
    type: 'save-as',
    path: occupied,
    expectedDestination: 'absent',
    expectedDocumentRevision: dirty.documentRevision,
  });
  assert.equal(assertAdmission(await harness.command(occupiedAttempt), harness, occupiedAttempt).accepted, true);
  const occupiedOperation = await waitForTerminal(harness, occupiedAttempt.operationId);
  assert.equal(occupiedOperation.status, 'error', describeOperation(occupiedOperation));
  assert.ok(['destination_exists', 'session_unavailable'].includes(occupiedOperation.error?.code), describeOperation(occupiedOperation));
  assert.deepEqual(await readFile(occupied), occupiedBytes);
  const afterOccupied = await harness.snapshot();
  assert.equal(afterOccupied.path, null);
  assert.equal(afterOccupied.documentRevision, dirty.documentRevision);
  assert.equal(afterOccupied.dirty, true);
  assert.deepEqual(stableCells(afterOccupied.cells), stableCells(dirty.cells));

  const saveAs = makeCommand(harness, {
    type: 'save-as',
    path: destination,
    expectedDestination: 'absent',
    expectedDocumentRevision: dirty.documentRevision,
  });
  assert.equal(assertAdmission(await harness.command(saveAs), harness, saveAs).accepted, true);
  const operation = await waitForTerminal(harness, saveAs.operationId);
  assert.equal(operation.status, 'done', describeOperation(operation));
  const destinationBytes = await readFile(destination);
  const destinationInfo = await lstat(destination);
  const expected = Buffer.from('# %%\nsave_as_marker <- 7\nsave_as_marker\n', 'utf8');
  assert.deepEqual(destinationBytes, expected);
  assert.equal(destinationInfo.isFile(), true);
  assert.equal(destinationInfo.isSymbolicLink(), false);
  const after = await harness.snapshot();
  const canonicalDestination = await realpath(destination);
  assert.equal(after.path, canonicalDestination);
  assert.deepEqual(stableCells(after.cells), stableCells(dirty.cells));
  const afterIdentity = await identity(harness);
  assert.equal(afterIdentity.canonicalPath, canonicalDestination);
  assert.equal(afterIdentity.epoch, originalIdentity.epoch);
  assert.equal(afterIdentity.processNonce, originalIdentity.processNonce);
  assert.equal(afterIdentity.clientId, originalIdentity.clientId);
  assert.equal(afterIdentity.leaseId, originalIdentity.leaseId);
  assert.equal(afterIdentity.nextCommandSequence, originalIdentity.nextCommandSequence + 2);
  assert.equal(after.disk.state, 'present');
  assert.equal(after.disk.digest, digest(destinationBytes));
  return { destinationBytes, operation, occupiedOperation, afterIdentity };
}

function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string', 'rscript must be explicit');
  assert.equal(ctx.rscript.startsWith('/'), true, 'rscript must be absolute');
  return ctx.rscript;
}

function makeCommand(harness, value) {
  return {
    ...value,
    operationId: randomUUID(),
    clientId: harness.session.clientId,
    commandSequence: harness.session.nextCommandSequence++,
    sessionEpoch: harness.session.epoch,
  };
}

function assertAdmission(value, harness, command) {
  assert.deepEqual(Object.keys(value).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
  assert.equal(value.epoch, harness.session.epoch);
  assert.equal(value.clientId, command.clientId);
  assert.equal(value.commandSequence, command.commandSequence);
  assert.equal(value.operationId, command.operationId);
  if (value.accepted) {
    assert.equal(value.error, null);
    assert.equal(value.operation?.id, command.operationId);
  } else {
    assert.equal(value.operation, null);
    assert.notEqual(value.error, null);
  }
  return value;
}

function snapshotOf(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Number.isSafeInteger(value.documentRevision));
  assert.ok(Number.isSafeInteger(value.cursor));
  return value.result;
}

async function waitForTerminal(harness, operationId) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  for (;;) {
    const current = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (['done', 'error', 'cancelled', 'interrupted'].includes(current?.status)) return current;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await delay(100);
  }
}

async function waitForDisk(harness, expectedDigest) {
  const deadline = Date.now() + DISK_TIMEOUT_MS;
  for (;;) {
    const current = await harness.snapshot();
    if (current.disk.state === 'present' && current.disk.digest === expectedDigest && typeof current.disk.version === 'string') return current;
    if (Date.now() >= deadline) throw new Error(`disk_observation_timeout: ${expectedDigest}`);
    await delay(50);
  }
}

async function waitForAbsentDisk(view) {
  const deadline = Date.now() + DISK_TIMEOUT_MS;
  for (;;) {
    const current = await snapshot(view);
    if (current.disk.state === 'absent' && current.disk.digest === null && current.disk.version === null) return current;
    if (Date.now() >= deadline) throw new Error('disk_absent_observation_timeout');
    await delay(50);
  }
}

async function identity(harness) {
  return harness.request('/api/identity', { method: 'GET', cookie: harness.session.cookie, csrf: harness.session.csrf });
}

async function writeEvidence(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'save-as.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function stableCells(cells) {
  return cells.map(cell => ({ id: cell.id, type: cell.type, body: cell.body, options: cell.options, revision: cell.revision }));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function registryPath(runtimeDirectory, canonicalPath) {
  return join(runtimeDirectory, `${createHash('sha256').update('path:' + canonicalPath).digest('hex')}.json`);
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`expected_missing_path: ${path}`);
}

async function waitForMissing(path) {
  const deadline = Date.now() + DISK_TIMEOUT_MS;
  for (;;) {
    try {
      await lstat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`registry_cleanup_timeout: ${path}`);
    await delay(50);
  }
}

async function closeLiveHost(host, session, runtimeDirectory, canonicalPath) {
  const path = canonicalPath === undefined ? undefined : registryPath(runtimeDirectory, canonicalPath);
  await cleanupScenarioResources(
    () => session !== undefined ? releaseLease(host.origin, session) : undefined,
    () => stopChild(host.child),
    () => host.tree !== undefined ? cleanupOwnedProcessTree(host.tree) : undefined,
    async () => {
      if (host.parser !== undefined) {
        await host.parser.done;
        assertStrictReadyOutput(host.parser);
      }
    },
    () => path === undefined ? undefined : waitForMissing(path),
    () => canonicalPath === undefined ? undefined : cleanupPartialOwner(canonicalPath, runtimeDirectory),
    () => path === undefined ? undefined : assertMissing(path),
  );
}

function startLiveHost({ launcher, notebook, cwd, dataHome, selectedR, id }) {
  const child = spawnSmokeProcess(launcher, [notebook, '--headless', '--no-run', '--port', '0', '--rscript', selectedR], {
    cwd,
    env: sanitizedEnvironment({ XDG_DATA_HOME: dataHome }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parser = createStrictReadyParser(child.stdout, { label: `save-as:${id}` });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = boundedText(stderr + chunk); });
  const ready = waitForCanonicalReady(parser, child, OPERATION_TIMEOUT_MS, `save-as:${id}`);
  return {
    id,
    child,
    parser,
    ready,
    get stdout() { return parser.stdout; },
    get stderr() { return stderr; },
  };
}
function boundedText(value) {
  return value.length <= DIAGNOSTIC_LIMIT ? value : value.slice(-DIAGNOSTIC_LIMIT);
}

function describeOperation(operation) {
  return JSON.stringify(summarizeOperation(operation));
}

function summarizeOperation(operation) {
  const result = operation?.result;
  return redact({
    id: operation?.id,
    type: operation?.type,
    status: operation?.status,
    error: operation?.error === undefined || operation.error === null
      ? null
      : { code: operation.error.code, message: boundedText(String(operation.error.message ?? '')) },
    result: result === undefined || result === null || typeof result !== 'object'
      ? result
      : {
        conflict: result.conflict,
        reloaded: result.reloaded,
        path: result.path,
        disk: result.disk === undefined ? undefined : {
          state: result.disk.state,
          digest: result.disk.digest,
          version: result.disk.version,
        },
      },
  });
}

function summarizeIdentity(value) {
  return value === undefined ? undefined : {
    canonicalPath: value.canonicalPath,
    epoch: value.epoch,
    processNonce: value.processNonce,
    clientId: value.clientId,
    leaseId: value.leaseId,
    nextCommandSequence: value.nextCommandSequence,
  };
}
