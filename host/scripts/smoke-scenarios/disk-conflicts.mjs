import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createHarness, delay, redact, requestJson } from './_common.mjs';

const OPERATION_TIMEOUT_MS = 120_000;
const DISK_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_LIMIT = 512;

export async function run(ctx) {
  let harness;
  try {
    harness = await createHarness(ctx, {
      id: 'disk-conflicts',
      source: '# %%\nvalue <- 1\nvalue\n',
      rscript: requireRscript(ctx),
    });

    const initial = await harness.snapshot();
    assert.ok(Array.isArray(initial.cells) && initial.cells.length > 0, 'notebook must expose a cell');
    const cell = initial.cells[0];
    const initialCellIds = initial.cells.map(entry => entry.id);
    const initialBytes = await readFile(harness.notebook);
    const initialInfo = await lstat(harness.notebook);
    assert.equal(initial.disk.state, 'present');
    assert.equal(initial.disk.digest, digest(initialBytes));
    assert.equal(typeof initial.disk.version, 'string');

    const localBytes = Buffer.from('# %%\nvalue <- 2\nvalue\n', 'utf8');
    const edit = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: cell.id },
        expectedRevision: cell.revision,
        body: ['value <- 2', 'value'],
        cellType: cell.type,
      }],
    });
    const editAdmission = assertAdmission(await harness.command(edit), harness, edit);
    assert.equal(editAdmission.accepted, true, 'source edit must be admitted');
    const editOperation = await waitForTerminal(harness, edit.operationId);
    assert.equal(editOperation.status, 'done', describeOperation(editOperation));
    const dirty = await harness.snapshot();
    assert.equal(dirty.dirty, true);
    assert.deepEqual(dirty.cells.map(entry => entry.id), initialCellIds);
    assert.deepEqual(Buffer.from(serializeCellBody(dirty.cells[0]), 'utf8'), localBytes);

    const externalBytes = Buffer.from('# %%\nexternal <- 2\nexternal\n', 'utf8');
    const externalPath = `${harness.notebook}.external`;
    await writeFile(externalPath, externalBytes, { mode: 0o600 });
    await chmod(externalPath, 0o600);
    await rename(externalPath, harness.notebook);
    const externalInfo = await lstat(harness.notebook);
    assert.equal(externalInfo.isFile(), true);
    assert.equal(externalInfo.isSymbolicLink(), false);
    assert.notEqual(externalInfo.ino, initialInfo.ino, 'replacement must change the inode');
    assert.equal(externalInfo.mode & 0o777, 0o600, 'replacement mode must be observed exactly');
    const afterExternalSource = await waitForDisk(harness, digest(externalBytes));
    assert.equal(afterExternalSource.disk.state, 'present');
    assert.equal(afterExternalSource.disk.digest, digest(externalBytes));
    assert.equal(typeof afterExternalSource.disk.version, 'string');

    const save = makeCommand(harness, {
      type: 'save',
      expectedDocumentRevision: afterExternalSource.documentRevision,
    });
    const saveAdmission = assertAdmission(await harness.command(save), harness, save);
    assert.equal(saveAdmission.accepted, true, 'save must be admitted before disk conflict is observed');
    const saveOperation = await waitForTerminal(harness, save.operationId);
    assert.equal(saveOperation.status, 'error', describeOperation(saveOperation));
    assert.equal(saveOperation.error?.code, 'source_conflict', describeOperation(saveOperation));
    assert.deepEqual(await readFile(harness.notebook), externalBytes, 'source conflict must preserve external bytes');
    const afterSaveConflict = await harness.snapshot();
    assert.equal(afterSaveConflict.dirty, true);
    assert.deepEqual(afterSaveConflict.cells.map(entry => entry.id), initialCellIds);

    // An explicit reload while dirty follows the recovery branch: it updates
    // the disk observation, but retains the local draft and stable cell IDs.
    const reloadConflict = makeCommand(harness, {
      type: 'reload-source',
      expectedDocumentRevision: afterSaveConflict.documentRevision,
      expectedDiskDigest: afterExternalSource.disk.digest,
      expectedDiskVersion: afterExternalSource.disk.version,
    });
    const reloadConflictAdmission = assertAdmission(await harness.command(reloadConflict), harness, reloadConflict);
    assert.equal(reloadConflictAdmission.accepted, true);
    const reloadConflictOperation = await waitForTerminal(harness, reloadConflict.operationId);
    assert.equal(reloadConflictOperation.status, 'done', describeOperation(reloadConflictOperation));
    assert.equal(reloadConflictOperation.result?.conflict, true, describeOperation(reloadConflictOperation));
    const afterReloadConflict = await harness.snapshot();
    assert.equal(afterReloadConflict.dirty, true, 'dirty reload conflict must retain the local draft');
    assert.deepEqual(afterReloadConflict.cells, afterSaveConflict.cells);
    assert.deepEqual(afterReloadConflict.cells.map(entry => entry.id), initialCellIds);
    assert.equal(afterReloadConflict.disk.state, 'present');
    assert.equal(afterReloadConflict.disk.digest, digest(externalBytes));
    assert.equal(afterReloadConflict.disk.version, afterExternalSource.disk.version);
    const recoveryState = snapshotOf(await harness.query({ type: 'recovery' }));
    assert.deepEqual(Object.keys(recoveryState).sort(), ['branches', 'corruption', 'pending']);
    assert.equal(recoveryState.pending, true, 'dirty conflict must expose a pending recovery projection');
    assert.equal(recoveryState.corruption, null);
    const recoveryBranch = [...recoveryState.branches]
      .filter(branch => branch.state === 'conflict' && branch.documentRevision === afterReloadConflict.documentRevision)
      .at(-1);
    assert.ok(recoveryBranch, 'dirty conflict must expose its public recovery branch');
    assert.equal(recoveryBranch.baseDisk.digest, initial.disk.digest);
    assert.equal(recoveryBranch.baseDisk.version, initial.disk.version);
    const recoveryBytes = await readArtifactBytes(harness, recoveryBranch.sourceHandle);
    assert.deepEqual(recoveryBytes, localBytes, 'public recovery sourceHandle must materialize exact local draft bytes');
    const target = `${harness.notebook}.target`;
    const symlinkBytes = Buffer.from('# %%\nsymlink_external <- 3\nsymlink_external\n', 'utf8');
    await writeFile(target, symlinkBytes, { mode: 0o644 });
    await unlink(harness.notebook);
    await symlink(target, harness.notebook);
    const symlinkInfo = await lstat(harness.notebook);
    assert.equal(symlinkInfo.isSymbolicLink(), true);
    const symlinkAttempt = makeCommand(harness, {
      type: 'save',
      expectedDocumentRevision: afterReloadConflict.documentRevision,
    });
    const symlinkAdmission = assertAdmission(await harness.command(symlinkAttempt), harness, symlinkAttempt);
    assert.equal(symlinkAdmission.accepted, true);
    const symlinkOperation = await waitForTerminal(harness, symlinkAttempt.operationId);
    assert.equal(symlinkOperation.status, 'error', describeOperation(symlinkOperation));
    assert.equal(symlinkOperation.error?.code, 'source_conflict', describeOperation(symlinkOperation));
    assert.deepEqual(await readFile(target), symlinkBytes, 'symlink replacement must not overwrite its target');
    assert.equal((await lstat(harness.notebook)).isSymbolicLink(), true);

    await unlink(harness.notebook);
    const deletionAttempt = makeCommand(harness, {
      type: 'save',
      expectedDocumentRevision: afterReloadConflict.documentRevision,
    });
    const deletionAdmission = assertAdmission(await harness.command(deletionAttempt), harness, deletionAttempt);
    assert.equal(deletionAdmission.accepted, true);
    const deletionOperation = await waitForTerminal(harness, deletionAttempt.operationId);
    assert.equal(deletionOperation.status, 'error', describeOperation(deletionOperation));
    assert.equal(deletionOperation.error?.code, 'source_conflict', describeOperation(deletionOperation));
    await assertMissing(harness.notebook);
    const afterDeletion = await waitForDiskState(harness, 'absent');
    assert.equal(afterDeletion.dirty, true);
    assert.deepEqual(afterDeletion.cells.map(entry => entry.id), initialCellIds);

    const configSidecar = join(dirname(harness.notebook), '.alder', 'config.yaml');
    const beforeConfig = await harness.snapshot();
    const configWrite = makeCommand(harness, {
      type: 'set-config',
      patch: { theme: 'dark' },
      expectedSidecarVersion: beforeConfig.sidecars.config.version,
      expectedDocumentRevision: beforeConfig.documentRevision,
    });
    const configWriteAdmission = assertAdmission(await harness.command(configWrite), harness, configWrite);
    assert.equal(configWriteAdmission.accepted, true, 'initial sidecar write must be admitted');
    const configWriteOperation = await waitForTerminal(harness, configWrite.operationId);
    assert.equal(configWriteOperation.status, 'done', describeOperation(configWriteOperation));
    const configBeforeRace = await harness.snapshot();
    const configBytes = await readFile(configSidecar);
    const externalConfigBytes = Buffer.concat([configBytes, Buffer.from('\n# changed outside Alder\n', 'utf8')]);
    await writeFile(configSidecar, externalConfigBytes);
    const afterExternalConfig = await waitForSidecar(harness, digest(externalConfigBytes));
    assert.equal(afterExternalConfig.sidecars.config.digest, digest(externalConfigBytes));
    assert.equal(typeof afterExternalConfig.sidecars.config.version, 'string');

    const configConflict = makeCommand(harness, {
      type: 'set-config',
      patch: { theme: 'light' },
      expectedSidecarVersion: configBeforeRace.sidecars.config.version,
      expectedDocumentRevision: configBeforeRace.documentRevision,
    });
    const configConflictAdmission = assertAdmission(await harness.command(configConflict), harness, configConflict);
    assert.equal(configConflictAdmission.accepted, true, 'sidecar write must be admitted before conflict detection');
    const configConflictOperation = await waitForTerminal(harness, configConflict.operationId);
    assert.equal(configConflictOperation.status, 'error', describeOperation(configConflictOperation));
    assert.equal(configConflictOperation.error?.code, 'source_conflict', describeOperation(configConflictOperation));
    assert.deepEqual(await readFile(configSidecar), externalConfigBytes, 'sidecar conflict must preserve external bytes');
    const finalConfigInfo = await lstat(configSidecar);
    assert.equal(finalConfigInfo.isFile(), true);
    const finalSnapshot = await harness.snapshot();
    assert.equal(finalSnapshot.documentRevision, configBeforeRace.documentRevision);
    assert.equal(finalSnapshot.dirty, true);
    assert.deepEqual(finalSnapshot.cells.map(entry => entry.id), initialCellIds);
    assert.equal(finalSnapshot.sidecars.config.digest, digest(externalConfigBytes));
    assert.equal(typeof finalSnapshot.sidecars.config.version, 'string');

    const evidence = {
      protocol: 'alder-host-v2',
      source: {
        path: harness.notebook,
        initialDigest: digest(initialBytes),
        initialBytes: initialBytes.byteLength,
        externalDigest: digest(externalBytes),
        externalBytes: externalBytes.byteLength,
        externalDiskVersion: afterExternalSource.disk.version,
        localDraftRetained: true,
        stableCellIds: initialCellIds,
        saveOperation: summarizeOperation(saveOperation),
        reloadConflictOperation: summarizeOperation(reloadConflictOperation),
        recovery: {
          state: recoveryBranch.state,
          documentRevision: recoveryBranch.documentRevision,
          sourceHandleDigest: digest(recoveryBytes),
          sourceHandleBytes: recoveryBytes.byteLength,
        },
        symlinkOperation: summarizeOperation(symlinkOperation),
        deletionOperation: summarizeOperation(deletionOperation),
        finalState: finalSnapshot.disk.state,
      },
      sidecar: {
        path: configSidecar,
        originalDigest: digest(configBytes),
        externalDigest: digest(externalConfigBytes),
        externalVersion: afterExternalConfig.sidecars.config.version,
        operation: summarizeOperation(configConflictOperation),
      },
      documentRevision: finalSnapshot.documentRevision,
    };
    await writeEvidence(ctx.evidence, evidence);
    return {
      id: 'disk-conflicts',
      identity: {
        artifact: {
          sourceCommit: ctx.manifest.sourceCommit,
          hostProtocol: ctx.manifest.hostProtocol,
          engineProtocol: ctx.manifest.engineProtocol,
          launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher),
        },
        source: { path: harness.notebook, digest: digest(externalBytes), bytes: externalBytes.byteLength },
        disk: {
          sourceDigest: digest(externalBytes),
          sourceVersion: afterExternalSource.disk.version,
          sidecarDigest: digest(externalConfigBytes),
          sidecarVersion: afterExternalConfig.sidecars.config.version,
          sourceError: saveOperation.error.code,
          sidecarError: configConflictOperation.error.code,
        },
        runtime: { epoch: harness.session.epoch },
      },
    };
  } finally {
    await harness?.close();
  }
}

function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string');
  assert.equal(ctx.rscript.startsWith('/'), true);
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

async function waitForDiskState(harness, state) {
  const deadline = Date.now() + DISK_TIMEOUT_MS;
  for (;;) {
    const current = await harness.snapshot();
    if (current.disk.state === state) return current;
    if (Date.now() >= deadline) throw new Error(`disk_state_timeout: ${state}`);
    await delay(50);
  }
}

async function waitForSidecar(harness, expectedDigest) {
  const deadline = Date.now() + DISK_TIMEOUT_MS;
  for (;;) {
    const current = await harness.snapshot();
    if (current.sidecars.config.digest === expectedDigest && typeof current.sidecars.config.version === 'string') return current;
    if (Date.now() >= deadline) throw new Error(`sidecar_observation_timeout: ${expectedDigest}`);
    await delay(50);
  }
}

async function readArtifactBytes(harness, descriptor) {
  assert.equal(typeof descriptor?.handle, 'string');
  assert.equal(Number.isSafeInteger(descriptor?.byteLength) && descriptor.byteLength >= 0, true);
  assert.equal(Number.isSafeInteger(descriptor?.chunkBytes) && descriptor.chunkBytes > 0, true);
  const codec = harness.wire;
  const chunks = [];
  let offset = 0;
  for (;;) {
    const pageQuery = { type: 'output', handle: descriptor.handle, offset, limit: descriptor.chunkBytes };
    const response = await requestJson(harness.origin, '/api/query', {
      method: 'POST',
      cookie: harness.session.cookie,
      csrf: harness.session.csrf,
      body: codec.encodeHostQueryWire(pageQuery),
    });
    const envelope = codec.hostQueryResultSchema.parse(codec.decodeHostQueryResultWire(pageQuery, response));
    assert.equal(envelope.epoch, harness.session.epoch);
    const page = envelope.result;
    assert.ok(page && typeof page === 'object' && !Array.isArray(page));
    assert.equal(page.encoding, 'base64');
    assert.equal(typeof page.data, 'string');
    assert.equal(Number.isSafeInteger(page.offset), true);
    assert.equal(Number.isSafeInteger(page.nextOffset), true);
    assert.equal(typeof page.eof, 'boolean');
    const bytes = Buffer.from(page.data, 'base64');
    assert.equal(bytes.toString('base64'), page.data);
    assert.equal(page.offset, offset);
    assert.equal(page.nextOffset, offset + bytes.byteLength);
    assert.equal(page.nextOffset <= descriptor.byteLength, true);
    assert.equal(bytes.byteLength <= descriptor.chunkBytes, true);
    chunks.push(bytes);
    offset = page.nextOffset;
    if (page.eof) {
      assert.equal(offset, descriptor.byteLength);
      break;
    }
    assert.equal(bytes.byteLength > 0, true);
    assert.equal(offset < descriptor.byteLength, true);
  }
  return Buffer.concat(chunks);
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

async function writeEvidence(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'disk-conflicts.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serializeCellBody(cell) {
  return `# %%\n${cell.body.join('\n')}\n`;
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

function boundedText(value) {
  return value.length <= DIAGNOSTIC_LIMIT ? value : value.slice(-DIAGNOSTIC_LIMIT);
}
