import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { assertCanonicalReady, assertStrictReadyOutput, captureProcessTree, cleanupOwnedProcessTree, cleanupPartialOwner, command, createHarness, createStrictReadyParser, delay, loadWireCodec, mergeProcessTrees, openSession, query, releaseLease, requestJson, sanitizedEnvironment, signalSmokeProcessGroup, snapshot as fullSnapshot, spawnSmokeProcess, stopChild, waitForExecutionReady, waitForRegistry } from './_common.mjs';
const ID = 'durable-recovery';
const TERMINAL = new Set(['done', 'error', 'interrupted', 'cancelled']);
const CHILD_EXIT_TIMEOUT_MS = 10_000;
const STREAM_END_TIMEOUT_MS = 5_000;
/**
 * Drive the durable source-commit path through a real staged launcher.  The
 * dirty source is never saved: its physical bytes are inspected in the
 * fsynced recovery baseline/log, the host is killed, and a new host must load
 * that projection from the same artifact generation.
 */
export async function run(ctx) {
  const source = '# %%\nlocal <- 1\nlocal\n# %%\n# durable recovery fixture\n';
  let harness;
  let restarted;
  let tornRestarted;
  try {
    harness = await createHarness(ctx, { id: ID, source, rscript: requireRscript(ctx) });
    const initial = await harness.snapshot();
    assert.ok(initial && Array.isArray(initial.cells), 'staged host must expose notebook cells');
    assert.equal(initial.cells.length, 2, 'durable recovery fixture must contain two cells');
    assert.equal(initial.documentRevision, 0);
    const first = initial.cells[0];
    const second = initial.cells[1];
    assert.ok(first && second, 'durable recovery fixture must expose its source cells');
    const originalBytes = Buffer.from(await readFile(harness.notebook));
    const originalDigest = digest(originalBytes);
    assert.equal(Buffer.from(source).equals(originalBytes), true, 'fixture bytes must be staged exactly');

    const command = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: first.id },
        expectedRevision: first.revision,
        cellType: first.type,
        body: ['local <- 7', 'local'],
      }],
    });
    const admission = assertAdmission(await harness.command(command), harness, command);
    assert.equal(admission.accepted, true, JSON.stringify(admission));
    const operation = await waitTerminal(harness, admission.operationId);
    assert.equal(operation.status, 'done', JSON.stringify(operation));

    const secondCommand = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision + 1,
      changes: [{
        type: 'edit',
        cell: { cellId: second.id },
        expectedRevision: second.revision,
        cellType: second.type,
        body: ['# durable recovery fixture', 'committed'],
      }],
    });
    const secondAdmission = assertAdmission(await harness.command(secondCommand), harness, secondCommand);
    assert.equal(secondAdmission.accepted, true, JSON.stringify(secondAdmission));
    const secondOperation = await waitTerminal(harness, secondAdmission.operationId);
    assert.equal(secondOperation.status, 'done', JSON.stringify(secondOperation));

    const dirty = await harness.snapshot();
    assert.equal(dirty.documentRevision, 2);
    assert.equal(dirty.dirty, true, 'the acknowledged edit must remain dirty until explicit Save');
    assert.deepEqual(dirty.cells.map(cell => cell.id), initial.cells.map(cell => cell.id));
    assert.deepEqual(dirty.cells[0].body, ['local <- 7', 'local']);
    assert.deepEqual(dirty.cells[1].body, ['# durable recovery fixture', 'committed']);
    assert.deepEqual(Buffer.from(await readFile(harness.notebook)), originalBytes, 'durable commit must not be source-only or an implicit Save');

    const beforeIdentity = await identity(harness);
    const beforeArtifact = await inspectArtifact(ctx, harness, originalBytes);
    assert.equal(beforeArtifact.records.length, 2, 'each source revision must produce one recovery record');
    assert.deepEqual(beforeArtifact.baseline.cells, initial.cells.map(cell => ({ id: cell.id, revision: cell.revision })));
    assert.deepEqual(beforeArtifact.materializedCells, dirty.cells.map(cell => ({ id: cell.id, revision: cell.revision })));
    const record = beforeArtifact.records.at(-1);
    assert.equal(record.fromRevision, 1);
    assert.equal(record.toRevision, 2);
    assert.equal(record.sha256, canonicalRecordDigest(record));
    assert.equal(record.delta.kind, 'source');
    assert.equal(record.delta.resultLength, beforeArtifact.materializedBytes.byteLength);
    const recoveredBytes = beforeArtifact.materializedBytes;
    assert.equal(record.delta.resultSha256, digest(recoveredBytes));
    assert.deepEqual(record.delta.cells, dirty.cells.map(cell => ({ id: cell.id, revision: cell.revision })));
    assert.notEqual(digest(recoveredBytes), originalDigest, 'recovery projection must differ from the unchanged source');
    assert.deepEqual(decodePhysicalBytes(beforeArtifact.baseline.physicalBytes), originalBytes, 'baseline must retain the exact source bytes');
    assert.equal(digest(recoveredBytes), digest(Buffer.from('# %%\nlocal <- 7\nlocal\n# %%\n# durable recovery fixture\ncommitted\n')));

    assert.equal(harness.child.exitCode, null, 'lease client must still be alive before the crash transition');
    assert.equal(harness.child.signalCode, null, 'lease client must still be alive before the crash transition');
    const hostPid = Number(harness.registry.pid);
    assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0, 'registry must expose the detached host PID');
    await crashHostHarness(harness);
    restarted = await createHarness(ctx, { id: ID, source, rscript: requireRscript(ctx) });
    const recovered = await restarted.snapshot();
    assert.equal(recovered.documentRevision, 2, 'restart must restore the durable revision');
    assert.equal(recovered.dirty, true, 'restored dirty source must remain dirty until explicit Save');
    assert.deepEqual(recovered.cells.map(cell => cell.id), initial.cells.map(cell => cell.id), 'recovery must retain physical cell IDs');
    assert.deepEqual(recovered.cells.map(cell => cell.body), dirty.cells.map(cell => cell.body), 'restart must materialize the durable source projection');
    assert.deepEqual(Buffer.from(await readFile(restarted.notebook)), originalBytes, 'recovery must not rewrite the source file');
    assert.equal(recovered.disk.digest, initial.disk.digest, 'recovery must retain the original disk observation');
    assert.equal(recovered.cells[0].body[0], 'local <- 7', 'recovery must materialize the acknowledged edit');

    const afterIdentity = await identity(restarted);
    assert.notEqual(afterIdentity.epoch, beforeIdentity.epoch, 'host restart must create a new session epoch');
    assert.notEqual(afterIdentity.processNonce, beforeIdentity.processNonce, 'host restart must create a new process nonce');
    assert.equal(afterIdentity.canonicalPath, beforeIdentity.canonicalPath);

    const afterArtifact = await inspectArtifact(ctx, restarted, originalBytes);
    assert.equal(afterArtifact.pointer.generation, beforeArtifact.pointer.generation, 'restart must reopen the same durable generation');
    assert.equal(afterArtifact.pointer.keyHash, beforeArtifact.pointer.keyHash);
    assert.equal(afterArtifact.pointerDigest, beforeArtifact.pointerDigest);
    assert.equal(afterArtifact.baselineDigest, beforeArtifact.baselineDigest);
    assert.equal(afterArtifact.logDigest, beforeArtifact.logDigest, 'restart must preserve the durable log identity');
    assert.deepEqual(afterArtifact.records, beforeArtifact.records, 'restart must preserve the complete durable record');

    const eventRecovery = await restarted.snapshot();
    assert.equal(eventRecovery.protocol, 'alder-host-v2');
    assert.equal(eventRecovery.epoch, restarted.session.epoch);
    assert.equal(eventRecovery.documentRevision, 2);
    assert.deepEqual(eventRecovery.cells.map(cell => cell.body), dirty.cells.map(cell => cell.body));
    const recoveryState = snapshotOf(await restarted.query({ type: 'recovery' }));
    assert.deepEqual(Object.keys(recoveryState).sort(), ['branches', 'corruption', 'pending']);
    assert.equal(recoveryState.pending, true);
    assert.equal(recoveryState.corruption, null);
    const faultEvidence = {};
    const interiorFault = await copyFaultArtifact(ctx, beforeArtifact, 'interior-corruption');
    const interiorOriginalLog = Buffer.from(await readFile(interiorFault.logPath));
    const interiorFirstFrame = frameAt(interiorOriginalLog, 0);
    assert.ok(interiorFirstFrame.nextOffset < interiorOriginalLog.length, 'interior corruption fixture must contain two complete frames');
    const interiorCorruptLog = Buffer.from(interiorOriginalLog);
    interiorCorruptLog[interiorFirstFrame.payloadStart] ^= 0xff;
    await writeFile(interiorFault.logPath, interiorCorruptLog);
    const interiorFailure = await runExpectedStartupFailure(ctx, {
      label: 'interior-corruption', dataHome: interiorFault.dataHome, notebook: restarted.notebook, rscript: requireRscript(ctx),
    });
    assert.equal(interiorFailure.exitCode !== 0, true);
    assert.equal(interiorFailure.signal, null);
    assert.equal(interiorFailure.stderr.includes('recovery record is invalid'), true, interiorFailure.stderr);
    assert.deepEqual(await readFile(interiorFault.logPath), interiorCorruptLog, 'interior corruption must preserve originals');
    assert.deepEqual(await readFile(interiorFault.baselinePath), beforeArtifact.baselineBytes);
    assert.deepEqual(await readFile(interiorFault.pointerPath), beforeArtifact.pointerBytes);
    faultEvidence.interiorCorruption = { exitCode: interiorFailure.exitCode, stderr: interiorFailure.stderr, originalsPreserved: true };
    const lengthFault = await copyFaultArtifact(ctx, beforeArtifact, 'interior-length');
    const lengthOriginalLog = Buffer.from(await readFile(lengthFault.logPath));
    const lengthFirstFrame = frameAt(lengthOriginalLog, 0);
    const lengthSecondFrame = frameAt(lengthOriginalLog, lengthFirstFrame.nextOffset);
    assert.ok(lengthSecondFrame.length > 1, 'second recovery frame must have a mutable payload length');
    const lengthCorruptLog = Buffer.from(lengthOriginalLog);
    lengthCorruptLog.writeUInt32BE(lengthSecondFrame.length - 1, lengthSecondFrame.start);
    await writeFile(lengthFault.logPath, lengthCorruptLog);
    const lengthFailure = await runExpectedStartupFailure(ctx, {
      label: 'interior-length', dataHome: lengthFault.dataHome, notebook: restarted.notebook, rscript: requireRscript(ctx),
    });
    assert.equal(lengthFailure.exitCode !== 0, true);
    assert.equal(lengthFailure.signal, null);
    assert.equal(lengthFailure.stderr.includes('recovery record is invalid'), true, lengthFailure.stderr);
    assert.deepEqual(await readFile(lengthFault.logPath), lengthCorruptLog, 'invalid frame length must preserve originals');
    assert.deepEqual(await readFile(lengthFault.baselinePath), beforeArtifact.baselineBytes);
    assert.deepEqual(await readFile(lengthFault.pointerPath), beforeArtifact.pointerBytes);

    faultEvidence.interiorLength = {
      exitCode: lengthFailure.exitCode,
      corruption: 'recovery record is invalid',
      stderr: lengthFailure.stderr,
      originalsPreserved: true,
    };
    const pointerFault = await copyFaultArtifact(ctx, beforeArtifact, 'pointer-repair');
    const pointerBefore = Buffer.from(await readFile(pointerFault.pointerPath));
    await writeFile(pointerFault.pointerPath, Buffer.from('{"malformed":', 'utf8'));
    const repaired = await startUntilReady(ctx, {
      label: 'pointer-repair', dataHome: pointerFault.dataHome, notebook: restarted.notebook, rscript: requireRscript(ctx),
    });
    await stopDirect(repaired.child, repaired.parser);
    const repairedPointer = JSON.parse(await readFile(pointerFault.pointerPath, 'utf8'));
    assert.deepEqual(repairedPointer, JSON.parse(pointerBefore.toString('utf8')), 'invalid pointer must be rebuilt from a complete candidate');
    faultEvidence.pointerRepair = { repaired: true, generation: repairedPointer.generation, hostReady: repaired.ready };

    const writeFault = await copyFaultArtifact(ctx, beforeArtifact, 'pointer-write-failure');
    const writeFaultBaseline = Buffer.from(await readFile(writeFault.baselinePath));
    const writeFaultLog = Buffer.from(await readFile(writeFault.logPath));
    await rm(writeFault.pointerPath, { force: true });
    await mkdir(writeFault.pointerPath, { recursive: false });
    const writeFailure = await runExpectedStartupFailure(ctx, {
      label: 'pointer-write-failure', dataHome: writeFault.dataHome, notebook: restarted.notebook, rscript: requireRscript(ctx),
    });
    assert.equal(writeFailure.exitCode !== 0, true);
    assert.equal(writeFailure.signal, null);
    assert.equal(writeFailure.stderr.includes('recovery pointer cannot be read'), true, writeFailure.stderr);
    assert.equal((await lstat(writeFault.pointerPath)).isDirectory(), true);
    assert.deepEqual(await readFile(writeFault.baselinePath), writeFaultBaseline);
    assert.deepEqual(await readFile(writeFault.logPath), writeFaultLog);
    faultEvidence.writeFailure = { exitCode: writeFailure.exitCode, stderr: writeFailure.stderr, originalsPreserved: true };


    const tornTail = Buffer.from([0, 0, 0, 20, 123, 34]);
    await appendFile(afterArtifact.logPath, tornTail);
    const tornHostPid = Number(restarted.registry.pid);
    await crashHostHarness(restarted);
    tornRestarted = await createHarness(ctx, { id: ID, source, rscript: requireRscript(ctx) });
    const tornArtifact = await inspectArtifact(ctx, tornRestarted, originalBytes);
    assert.deepEqual(tornArtifact.records, beforeArtifact.records, 'restart must discard only an incomplete tail frame');
    assert.deepEqual(tornArtifact.logBytes, beforeArtifact.logBytes, 'tail discard must restore the complete durable log');
    const tornRecovery = snapshotOf(await tornRestarted.query({ type: 'recovery' }));
    assert.equal(tornRecovery.pending, true);
    assert.equal(tornRecovery.corruption, null);
    const tornIdentity = await identity(tornRestarted);
    assert.notEqual(tornIdentity.epoch, afterIdentity.epoch, 'torn-tail recovery must start a fresh host epoch');
    const compactionCase = await runCompactionTriggerCase(ctx, tornRestarted, tornArtifact, source, requireRscript(ctx));
    tornRestarted = compactionCase.harness;
    const compaction = compactionCase.evidence;
    const compactionIdentity = compactionCase.identity;
    faultEvidence.compaction = compaction;
    const fsyncCases = await runTracedFsyncCases(ctx, source, requireRscript(ctx));
    faultEvidence.fsync = fsyncCases;
    const evidence = {
      protocol: 'alder-host-v2',
      launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher),
      fixture: restarted.notebook,
      source: {
        path: restarted.notebook,
        byteLength: originalBytes.byteLength,
        digest: originalDigest,
        unchangedAcrossCrash: true,
      },
      transaction: {
        operationId: admission.operationId,
        secondOperationId: secondAdmission.operationId,
        fromRevision: 0,
        toRevision: 2,
        cellIds: initial.cells.map(cell => cell.id),
        recoveredBodies: dirty.cells.map(cell => cell.body),
      },
      recovery: {
        rootDir: beforeArtifact.rootDir,
        directory: beforeArtifact.directory,
        keyHash: beforeArtifact.pointer.keyHash,
        generation: beforeArtifact.pointer.generation,
        pointerPath: beforeArtifact.pointerPath,
        baselinePath: beforeArtifact.baselinePath,
        logPath: beforeArtifact.logPath,
        pointerDigest: beforeArtifact.pointerDigest,
        baselineDigest: beforeArtifact.baselineDigest,
        logDigest: beforeArtifact.logDigest,
        baselineByteLength: beforeArtifact.baselineBytes.byteLength,
        logByteLength: beforeArtifact.logBytes.byteLength,
        schemaVersion: RECOVERY_SCHEMA_VERSION,
        baselineCells: beforeArtifact.baseline.cells,
        sourceDelta: sourceDeltaEvidence(record.delta),
        recordSha256: record.sha256,
        recordCount: beforeArtifact.records.length,
        recoveredPhysicalDigest: digest(recoveredBytes),
      },
      compaction,
      faults: faultEvidence,
      timing: {
        appendAwaitedBeforeArtifactRead: true,
        syscallFaultInjection: 'strace -d -f -yy -e trace=fsync -P <exact active recovery log> --inject=fsync:<mode>',
        preFsyncCrash: 'delay_enter=3000ms; observe on-enter worker delay under exact fsync filter; SIGKILL',
        postFsyncCrash: 'delay_exit=3000ms; observe fsync =0 (DELAYED) + delay_tcb worker stop; SIGKILL before publication',
        fsyncError: 'error=EIO',
      },
      tornTail: { appendedBytes: tornTail.byteLength, discarded: true, recordCount: tornArtifact.records.length, logDigest: digest(tornArtifact.logBytes) },
      runtime: {
        before: { epoch: beforeIdentity.epoch, processNonce: beforeIdentity.processNonce, pid: hostPid },
        after: { epoch: compactionIdentity.epoch, processNonce: compactionIdentity.processNonce, pid: tornRestarted.registry.pid },
        processRestarted: true,
      },
    };
    await writeEvidence(ctx.evidence, evidence);
    await writeFile(join(ctx.evidence, 'durable-recovery-baseline.json'), beforeArtifact.baselineBytes);
    await writeFile(join(ctx.evidence, 'durable-recovery-log.bin'), beforeArtifact.logBytes);

    return {
      id: ID,
      identity: {
        artifact: {
          sourceCommit: ctx.manifest.sourceCommit,
          hostProtocol: ctx.manifest.hostProtocol,
          engineProtocol: ctx.manifest.engineProtocol,
          launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher),
        },
        source: { canonicalPath: restarted.canonical, digest: originalDigest, byteLength: originalBytes.byteLength },
        recovery: {
          keyHash: beforeArtifact.pointer.keyHash,
          generation: beforeArtifact.pointer.generation,
          baselineDigest: beforeArtifact.baselineDigest,
          logDigest: beforeArtifact.logDigest,
          recordSha256: record.sha256,
          documentRevision: recovered.documentRevision,
          physicalBytesRestored: true,
          cellIdsRestored: true,
        },
        compaction,
        faults: faultEvidence,
        timing: {
          appendAwaitedBeforeArtifactRead: true,
          syscallFaultInjection: 'strace -d -f -yy -e trace=fsync -P <exact active recovery log> --inject=fsync:<mode>',
          preFsyncCrash: 'delay_enter=3000ms; observe on-enter worker delay under exact fsync filter; SIGKILL',
          postFsyncCrash: 'delay_exit=3000ms; observe fsync =0 (DELAYED) + delay_tcb worker stop; SIGKILL before publication',
          fsyncError: 'error=EIO',
        },
        runtime: {
          before: { epoch: beforeIdentity.epoch, processNonce: beforeIdentity.processNonce },
          after: { epoch: compactionIdentity.epoch, processNonce: compactionIdentity.processNonce },
        },
      },
      evidence: join(ctx.evidence, 'durable-recovery.json'),
    };
  } finally {
    await closeHarnesses(tornRestarted, restarted, harness);
  }
}
const RECOVERY_BASELINE_KEYS = new Set([
  'kind', 'schemaVersion', 'documentRevision', 'physicalBytes', 'cells', 'path', 'project', 'config', 'layout',
  'packageDeclarationIntent', 'notebookDiskObservation', 'sidecarObservations',
]);
const RECOVERY_DELTA_KEYS = new Set([
  'kind', 'baseLength', 'baseSha256', 'resultLength', 'resultSha256', 'pieces', 'cells', 'path', 'project',
  'config', 'layout', 'packageDeclarationIntent', 'notebookDiskObservation', 'sidecarObservations',
]);


const RECOVERY_SCHEMA_VERSION = 1;

async function inspectArtifact(ctx, harness, originalBytes) {
  const rootDir = join(ctx.evidence, 'runtime-data', harness.id, 'alder');
  const sessionKey = digest(Buffer.from('path:' + harness.canonical));
  const keyHash = digest(Buffer.from(JSON.stringify(sessionKey), 'utf8'));
  const directory = join(rootDir, 'recovery-' + keyHash);
  const pointerPath = join(directory, 'current.json');
  const pointerBytes = Buffer.from(await readFile(pointerPath));
  const pointer = JSON.parse(pointerBytes.toString('utf8'));
  assert.deepEqual(Object.keys(pointer).sort(), ['generation', 'keyHash', 'schemaVersion']);
  assert.equal(pointer.schemaVersion, RECOVERY_SCHEMA_VERSION);
  assert.equal(pointer.keyHash, keyHash);
  assert.equal(typeof pointer.generation, 'string');
  const baselinePath = join(directory, 'baseline-' + pointer.generation + '.json');
  const logPath = join(directory, 'log-' + pointer.generation + '.bin');
  const baselineBytes = Buffer.from(await readFile(baselinePath));
  const logBytes = Buffer.from(await readFile(logPath));
  assert.ok(logBytes.byteLength > 4, 'recovery log must contain a durable framed record');
  const baseline = JSON.parse(baselineBytes.toString('utf8'));
  assertRecoveryBaseline(baseline);
  assert.equal(baseline.documentRevision, 0);
  const baselinePhysicalBytes = decodePhysicalBytes(baseline.physicalBytes);
  assert.equal(digest(baselinePhysicalBytes), digest(originalBytes));
  const records = readFrames(logBytes);
  let materializedBytes = baselinePhysicalBytes;
  let materializedCells = baseline.cells;
  let materializedRevision = baseline.documentRevision;
  for (const record of records) {
    assertRecoveryRecord(record, materializedRevision);
    assert.equal(record.sha256, canonicalRecordDigest(record));
    materializedBytes = applySourceDelta(materializedBytes, record.delta);
    materializedCells = record.delta.cells;
    materializedRevision = record.toRevision;
  }
  return {
    rootDir,
    directory,
    pointerPath,
    baselinePath,
    logPath,
    pointer,
    pointerDigest: digest(pointerBytes),
    baselineDigest: digest(baselineBytes),
    logDigest: digest(logBytes),
    pointerBytes,
    baselineBytes,
    logBytes,
    baseline,
    records,
    materializedBytes,
    materializedCells,
    materializedRevision,
  };
}

function readFrames(bytes) {
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(bytes.length - offset >= 4, 'recovery log must contain complete frame lengths');
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    assert.ok(length > 0 && offset + length <= bytes.length, 'recovery log must contain complete frames');
    records.push(JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')));
    offset += length;
  }
  assert.equal(offset, bytes.length);
  return records;
}

function assertRecoveryBaseline(value) {
  for (const key of Object.keys(value)) assert.ok(RECOVERY_BASELINE_KEYS.has(key), 'unsupported baseline field ' + key);
  assert.equal(value.kind, 'baseline');
  assert.equal(value.schemaVersion, RECOVERY_SCHEMA_VERSION);
  assert.ok(Number.isSafeInteger(value.documentRevision) && value.documentRevision >= 0);
  assert.equal(typeof value.physicalBytes, 'string');
  assertRecoveryCells(value.cells, 'baseline.cells');
  assertRecoveryObservations(value.notebookDiskObservation, value.sidecarObservations, 'baseline');
}

function assertRecoveryRecord(value, expectedFromRevision) {
  assert.deepEqual(Object.keys(value).sort(), ['delta', 'fromRevision', 'schemaVersion', 'sha256', 'toRevision']);
  assert.equal(value.schemaVersion, RECOVERY_SCHEMA_VERSION);
  assert.equal(value.fromRevision, expectedFromRevision);
  assert.equal(value.toRevision, expectedFromRevision + 1);
  assert.equal(typeof value.sha256, 'string');
  assertRecoveryDelta(value.delta);
}

function assertRecoveryDelta(value) {
  for (const key of Object.keys(value)) assert.ok(RECOVERY_DELTA_KEYS.has(key), 'unsupported recovery delta field ' + key);
  assert.equal(value.kind, 'source');
  assert.ok(Number.isSafeInteger(value.baseLength) && value.baseLength >= 0);
  assert.ok(Number.isSafeInteger(value.resultLength) && value.resultLength >= 0);
  assert.equal(typeof value.baseSha256, 'string');
  assert.equal(typeof value.resultSha256, 'string');
  assert.ok(Array.isArray(value.pieces));
  assertRecoveryCells(value.cells, 'recovery delta.cells');
  assertRecoveryObservations(value.notebookDiskObservation, value.sidecarObservations, 'recovery delta');
}

function assertRecoveryCells(value, label) {
  assert.ok(Array.isArray(value), label + ' must be an array');
  const ids = new Set();
  for (const cell of value) {
    assert.deepEqual(Object.keys(cell).sort(), ['id', 'revision']);
    assert.equal(typeof cell.id, 'string');
    assert.ok(!ids.has(cell.id), label + ' contains duplicate cell IDs');
    ids.add(cell.id);
    assert.ok(Number.isSafeInteger(cell.revision) && cell.revision >= 0);
  }
}

function assertRecoveryObservations(notebookDiskObservation, sidecarObservations, label) {
  assert.ok(notebookDiskObservation && typeof notebookDiskObservation === 'object', label + '.notebookDiskObservation is required');
  assert.ok(sidecarObservations && typeof sidecarObservations === 'object', label + '.sidecarObservations is required');
  assert.deepEqual(Object.keys(sidecarObservations).sort(), ['config', 'layout', 'packages']);
}

function applySourceDelta(base, delta) {
  assertRecoveryDelta(delta);
  assert.equal(base.byteLength, delta.baseLength);
  assert.equal(digest(base), delta.baseSha256);
  const result = Buffer.alloc(delta.resultLength);
  let outputOffset = 0;
  for (const piece of delta.pieces) {
    if (piece.kind === 'copy') {
      assert.deepEqual(Object.keys(piece).sort(), ['kind', 'length', 'offset']);
      assert.ok(Number.isSafeInteger(piece.offset) && piece.offset >= 0);
      assert.ok(Number.isSafeInteger(piece.length) && piece.length >= 0);
      assert.ok(piece.offset <= base.byteLength && piece.length <= base.byteLength - piece.offset);
      assert.ok(outputOffset + piece.length <= result.byteLength);
      base.copy(result, outputOffset, piece.offset, piece.offset + piece.length);
      outputOffset += piece.length;
    } else {
      assert.deepEqual(Object.keys(piece).sort(), ['data', 'kind']);
      const literal = decodePhysicalBytes(piece.data);
      assert.ok(outputOffset + literal.byteLength <= result.byteLength);
      literal.copy(result, outputOffset);
      outputOffset += literal.byteLength;
    }
  }
  assert.equal(outputOffset, result.byteLength);
  assert.equal(digest(result), delta.resultSha256);
  return result;
}

function sourceDeltaEvidence(delta) {
  assertRecoveryDelta(delta);
  return {
    kind: delta.kind,
    baseLength: delta.baseLength,
    baseSha256: delta.baseSha256,
    resultLength: delta.resultLength,
    resultSha256: delta.resultSha256,
    pieces: delta.pieces.map(piece => piece.kind === 'copy'
      ? { kind: piece.kind, offset: piece.offset, length: piece.length }
      : { kind: piece.kind, byteLength: decodePhysicalBytes(piece.data).byteLength }),
    cells: delta.cells,
  };
}

function canonicalRecordDigest(record) {
  const unsigned = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    fromRevision: record.fromRevision,
    toRevision: record.toRevision,
    delta: record.delta,
  };
  return digest(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  assert.equal(typeof value, 'object');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function decodePhysicalBytes(value) {
  const encoded = typeof value === 'string' ? value : value?.$bytes;
  assert.equal(typeof encoded, 'string', 'recovery physicalBytes must be base64');
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'recovery physicalBytes must be canonical base64');
  return bytes;
}

async function waitTerminal(harness, operationId, timeout = 120_000) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + timeout;
  for (;;) {
    const operation = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (TERMINAL.has(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await delay(50);
  }
}

async function waitRunActive(harness, operationId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await harness.snapshot();
    const operation = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (current.runtime.busy === true && typeof operation.runId === 'string' && current.runtime.activeRunId === operation.runId && operation.status === 'running') return operation;
    if (TERMINAL.has(operation.status)) throw new Error('run_settled_before_fsync_probe: ' + JSON.stringify(operation));
    if (Date.now() >= deadline) throw new Error('run_did_not_become_active: ' + operationId);
    await delay(50);
  }
}

async function startActiveRun(harness, prepared) {
  const command = makeCommand(harness, {
    type: 'run',
    scope: 'cell',
    target: { cellId: prepared.cellId },
    expectedDocumentRevision: prepared.after.documentRevision,
  });
  const admission = assertAdmission(await harness.command(command), harness, command);
  assert.equal(admission.accepted, true, JSON.stringify(admission));
  const operation = await waitRunActive(harness, command.operationId);
  assert.equal(typeof operation.runId, 'string');
  return { command, admission, operation, runId: operation.runId };
}

async function interruptActiveRun(harness, activeRun) {
  const command = makeCommand(harness, { type: 'interrupt', runId: activeRun.runId });
  const admission = assertAdmission(await harness.command(command), harness, command);
  assert.equal(admission.accepted, true, JSON.stringify(admission));
  const operation = await waitTerminal(harness, admission.operationId, 30_000);
  assert.equal(operation.status, 'done', JSON.stringify(operation));
  assert.equal(operation.result?.requested, true, JSON.stringify(operation));
  const runOperation = await waitTerminal(harness, activeRun.command.operationId, 30_000);
  assert.ok(['cancelled', 'interrupted'].includes(runOperation.status), JSON.stringify(runOperation));
  const settled = await harness.snapshot();
  assert.equal(settled.runtime.busy, false);
  assert.equal(settled.runtime.activeRunId, null);
  assert.equal(settled.runtime.executionReady, true);
  return { command, admission, operation, runOperation, settled };
}

async function identity(harness) {
  return harness.request('/api/identity', { method: 'GET', cookie: harness.session.cookie, csrf: harness.session.csrf });
}

async function waitForExit(child, timeout = CHILD_EXIT_TIMEOUT_MS, label = 'child') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let timer;
    const finish = (error = null) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error === null) resolve();
      else reject(error);
    };
    const onExit = () => finish();
    const onError = error => finish(error);
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => finish(new Error(label + '_exit_timeout:' + String(child.pid ?? 'unknown'))), timeout);
  });
}

async function waitForStreamEnd(promise, timeout = STREAM_END_TIMEOUT_MS, label = 'stream') {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + '_end_timeout')), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function processTreeEvidence(tree) {
  return (tree ?? []).map(record => {
    const command = typeof record.command === 'string' ? record.command : '';
    return record.pid + '[' + (record.state ?? '?') + '] ' + command;
  }).join(' | ');
}

function cleanupEvidence(error, harness, phase) {
  const details = processTreeEvidence(harness?.ownedTree);
  return new Error(phase + ': ' + (error?.message ?? String(error)) + '; owned_processes=' + (details || 'none'));
}

async function processStartIdentity(pid) {
  const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
  const close = stat.lastIndexOf(')');
  assert.ok(close >= 0, 'host process stat record is malformed');
  const startTime = stat.slice(close + 2).trim().split(/\s+/)[19];
  assert.ok(startTime, 'host process stat record has no start identity');
  return 'linux:' + startTime;
}
async function assertOwnedHost(harness) {
  const registry = harness.registry;
  const pid = Number(registry?.pid);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'registry must expose the detached host PID');
  assert.equal(typeof registry.startIdentity, 'string', 'registry must expose the detached host start identity');
  const actualStartIdentity = await processStartIdentity(pid);
  assert.equal(actualStartIdentity, registry.startIdentity, 'refusing to signal a host PID with a changed start identity');
  const executable = await readlink('/proc/' + pid + '/exe');
  if (harness.hostExe === undefined) harness.hostExe = executable;
  assert.equal(executable, harness.hostExe, 'refusing to signal a host PID with a changed executable');
  return pid;
}

async function ownedHostExists(harness) {
  try {
    await assertOwnedHost(harness);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function signalOwnedHost(harness, signal) {
  const pid = await assertOwnedHost(harness);
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function readLinuxProcessState(pid) {
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) throw new Error('host process stat record is malformed');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const state = fields[0];
    const startTime = fields[19];
    if (!state || !startTime) throw new Error('host process stat record is incomplete');
    return { state, startIdentity: 'linux:' + startTime };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForPidExit(pid, timeout = 30_000, expectedStartIdentity = null) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const observed = await readLinuxProcessState(pid);
    if (observed === null || (expectedStartIdentity !== null && observed.startIdentity !== expectedStartIdentity) || observed.state === 'Z') return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error('host_process_exit_timeout: ' + pid);
    await delay(50);
  }
}

async function closeHarness(harness) {
  if (!harness) return;
  const cleanupErrors = [];
  if (!harness.hostCrashed) {
    try {
      await harness.close();
    } catch (error) {
      cleanupErrors.push(cleanupEvidence(error, harness, 'harness.close'));
    }
  }
  if (Array.isArray(harness.ownedTree) && harness.ownedTree.length > 0) {
    try {
      await cleanupOwnedProcessTree(harness.ownedTree);
    } catch (error) {
      cleanupErrors.push(cleanupEvidence(error, harness, 'owned_process_cleanup'));
    }
  }
  try {
    if (await ownedHostExists(harness)) await terminateProcess(harness);
  } catch (error) {
    cleanupErrors.push(cleanupEvidence(error, harness, 'host_process_cleanup'));
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'durable harness cleanup failed');
}

async function closeHarnesses(...harnesses) {
  const cleanupErrors = [];
  for (const harness of harnesses) {
    try {
      await closeHarness(harness);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'durable harness cleanup failed');
}

async function terminateProcess(harness) {
  if (!await ownedHostExists(harness)) return;
  const pid = Number(harness.registry.pid);
  const startIdentity = harness.registry.startIdentity;
  await signalOwnedHost(harness, 'SIGTERM');
  try {
    await waitForPidExit(pid, 5_000, startIdentity);
  } catch {
    if (await ownedHostExists(harness)) {
      await signalOwnedHost(harness, 'SIGKILL');
      await waitForPidExit(pid, CHILD_EXIT_TIMEOUT_MS, startIdentity);
    }
  }
}
async function writeEvidence(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${ID}.json`), `${JSON.stringify(value, null, 2)}\n`);
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

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string', 'durable-recovery Rscript must be supplied explicitly');
  assert.equal(isAbsolute(ctx.rscript), true, 'durable-recovery Rscript must be an absolute path');
  return ctx.rscript;
}

async function copyFaultArtifact(ctx, artifact, label) {
  const dataHome = join(ctx.evidence, 'faults', label, 'runtime-data');
  const directory = join(dataHome, 'alder', basename(artifact.directory));
  await mkdir(join(dataHome, 'alder'), { recursive: true });
  await cp(artifact.directory, directory, { recursive: true });
  const generation = artifact.pointer.generation;
  assert.equal(typeof generation, 'string');
  return {
    dataHome,
    directory,
    keyHash: artifact.pointer.keyHash,
    generation,
    pointerPath: join(directory, 'current.json'),
    baselinePath: join(directory, 'baseline-' + generation + '.json'),
    logPath: join(directory, 'log-' + generation + '.bin'),
  };
}

function directArgs(notebook, rscript) {
  return [notebook, '--headless', '--no-run', '--port', '0', '--rscript', rscript];
}

function directEnv(dataHome) {
  return sanitizedEnvironment({
    HOME: join(dataHome, 'home'),
    XDG_CONFIG_HOME: join(dataHome, 'config'),
    XDG_DATA_HOME: dataHome,
  });
}

function directLauncher(ctx) {
  return join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
}

async function runExpectedStartupFailure(ctx, { label, dataHome, notebook, rscript }) {
  const child = spawnSmokeProcess(directLauncher(ctx), directArgs(notebook, rscript), {
    cwd: join(ctx.evidence, 'unrelated'),
    env: directEnv(dataHome),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parser = createStrictReadyParser(child.stdout, { label: label + '_stdout' });
  const stderrChunks = [];
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  const result = await waitChildExit(child, 30_000, label + '_startup');
  await waitForStreamEnd(parser.done, STREAM_END_TIMEOUT_MS, label + '_stdout');
  assertStrictReadyOutput(parser, { requireReady: false });
  const stdoutBytes = Buffer.from(parser.stdout, 'utf8');
  const stderrBytes = Buffer.concat(stderrChunks);
  const stdout = decodeRaw(stdoutBytes);
  const stderr = decodeRaw(stderrBytes);
  assert.equal(result.signal, null, label + ' must exit by status, not signal');
  assert.equal(result.code !== 0, true, label + ' must fail startup');
  assert.equal(stderr.length > 0, true, label + ' must expose raw stderr');
  return { label, exitCode: result.code, signal: result.signal, stdout, stderr, stdoutBytes, stderrBytes };
}

async function startUntilReady(ctx, { label, dataHome, notebook, rscript }) {
  const child = spawnSmokeProcess(directLauncher(ctx), directArgs(notebook, rscript), {
    cwd: join(ctx.evidence, 'unrelated'),
    env: directEnv(dataHome),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parser = createStrictReadyParser(child.stdout, { label: label + '_stdout' });
  const stderrChunks = [];
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      const poll = () => {
        if (parser.error !== null) { reject(parser.error); return; }
        if (parser.readyRecord !== null) { resolve(parser.readyRecord); return; }
        if (child.exitCode !== null || child.signalCode !== null) { reject(new Error(label + '_exited_before_ready:' + String(child.exitCode) + ':' + String(child.signalCode))); return; }
        if (Date.now() >= deadline) { reject(new Error(label + '_ready_timeout')); return; }
        setTimeout(poll, 20);
      };
      poll();
    });
  } catch (error) {
    const cleanupErrors = [];
    if (child.exitCode === null && child.signalCode === null) {
      try { signalSmokeProcessGroup(child.pid, 'SIGKILL'); } catch (cause) { cleanupErrors.push(cause); }
    }
    try { await waitForExit(child, CHILD_EXIT_TIMEOUT_MS, label + '_cleanup'); } catch (cause) { cleanupErrors.push(cause); }
    try { await waitForStreamEnd(parser.done, STREAM_END_TIMEOUT_MS, label + '_stdout'); } catch (cause) { cleanupErrors.push(cause); }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], label + '_startup_cleanup_failed');
    throw error;
  }
  return { child, parser, ready, stdout: Buffer.from(parser.stdout, 'utf8'), stderr: Buffer.concat(stderrChunks) };
}


async function waitChildExit(child, timeout, label = 'child') {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  try {
    await waitForExit(child, timeout, label);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try { signalSmokeProcessGroup(child.pid, 'SIGKILL'); } catch (killError) { throw new AggregateError([error, killError], label + '_timeout'); }
      try {
        await waitForExit(child, CHILD_EXIT_TIMEOUT_MS, label + '_kill');
      } catch (killWaitError) {
        throw new AggregateError([error, killWaitError], label + '_timeout');
      }
    }
    throw error;
  }
  return { code: child.exitCode, signal: child.signalCode };
}
function decodeRaw(bytes) {
  return new TextDecoder('utf8', { fatal: true }).decode(bytes);
}

function frameAt(bytes, start) {
  assert.ok(Number.isSafeInteger(start) && start >= 0);
  assert.ok(bytes.length - start >= 4, 'recovery frame must include its length');
  const length = bytes.readUInt32BE(start);
  assert.ok(length > 0 && start + 4 + length <= bytes.length, 'recovery frame must be complete');
  return { start, length, payloadStart: start + 4, nextOffset: start + 4 + length };
}

async function stopDirect(child, parser = null) {
  await stopChild(child);
  if (parser !== null) {
    await waitForStreamEnd(parser.done, STREAM_END_TIMEOUT_MS, 'direct child stdout');
    assertStrictReadyOutput(parser);
  }
}


async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function runCompactionTriggerCase(ctx, initialHarness, initialArtifact, source, rscript) {
  const compactComment = '#'.repeat(900_000);
  const compactionThreshold = Math.max(initialArtifact.baselineBytes.byteLength, 64 * 1024);
  const pointerPath = initialArtifact.pointerPath;
  const oldGeneration = initialArtifact.pointer.generation;
  let harness = initialHarness;
  let current = await harness.snapshot();
  let documentRevision = current.documentRevision;
  let cellRevision = current.cells[0].revision;
  let operationCount = 0;
  for (let index = 0; index < 128; index += 1) {
    const beforeRevision = documentRevision;
    const beforeCellRevision = cellRevision;
    const body = [compactComment, 'compact_value <- ' + index, 'compact_value'];
    const command = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: beforeRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: current.cells[0].id },
        expectedRevision: beforeCellRevision,
        cellType: current.cells[0].type,
        body,
      }],
    });
    const admission = assertAdmission(await harness.command(command), harness, command);
    assert.equal(admission.accepted, true, JSON.stringify(admission));
    const operation = await waitTerminal(harness, admission.operationId, 180_000);
    assert.equal(operation.status, 'done', JSON.stringify(operation));
    assert.ok(operation.result && typeof operation.result === 'object');
    assert.equal(operation.result.documentRevision, beforeRevision + 1);
    const edited = operation.result.edited?.find(item => item.id === current.cells[0].id);
    assert.ok(edited && Number.isSafeInteger(edited.revision));
    documentRevision = operation.result.documentRevision;
    cellRevision = edited.revision;
    operationCount += 1;

    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    assert.equal(pointer.keyHash, initialArtifact.pointer.keyHash);
    assert.equal(pointer.generation, oldGeneration, 'the threshold fixture must remain in its old generation before the fault injection');
    const logInfo = await lstat(initialArtifact.logPath);
    if (logInfo.size < compactionThreshold) continue;

    const pointerBytes = Buffer.from(await readFile(pointerPath));
    const baselineBytes = Buffer.from(await readFile(initialArtifact.baselinePath));
    const logBytes = Buffer.from(await readFile(initialArtifact.logPath));
    await rm(pointerPath, { force: true });
    await mkdir(pointerPath, { recursive: false });
    const failureBody = [compactComment, 'compact_value <- 1001', 'compact_value'];
    const failureCommand = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: current.cells[0].id },
        expectedRevision: cellRevision,
        cellType: current.cells[0].type,
        body: failureBody,
      }],
    });
    const failureAdmission = assertAdmission(await harness.command(failureCommand), harness, failureCommand);
    assert.equal(failureAdmission.accepted, true, JSON.stringify(failureAdmission));
    const failureOperation = await waitTerminal(harness, failureAdmission.operationId, 180_000);
    assert.equal(failureOperation.status, 'error', JSON.stringify(failureOperation));
    assert.equal(failureOperation.error?.code, 'recovery_write_failed', JSON.stringify(failureOperation));
    assert.equal((await lstat(pointerPath)).isDirectory(), true);
    assert.deepEqual(await readFile(initialArtifact.baselinePath), baselineBytes);
    assert.deepEqual(await readFile(initialArtifact.logPath), logBytes);
    const failureEvidence = {
      operationId: failureCommand.operationId,
      errorCode: failureOperation.error.code,
      thresholdBytes: compactionThreshold,
      oldGeneration,
      originalsPreserved: true,
    };

    await rm(pointerPath, { recursive: true, force: true });
    await writeFile(pointerPath, pointerBytes, { mode: 0o600 });
    await closeHarness(harness);
    harness = await createHarness(ctx, { id: ID, source, rscript });
    const reloaded = await harness.snapshot();
    assert.equal(reloaded.documentRevision, documentRevision);
    assert.equal(reloaded.cells[0].revision, cellRevision);
    current = reloaded;
    const successBody = [compactComment, 'compact_value <- 1002', 'compact_value'];
    const successCommand = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: current.cells[0].id },
        expectedRevision: cellRevision,
        cellType: current.cells[0].type,
        body: successBody,
      }],
    });
    const successAdmission = assertAdmission(await harness.command(successCommand), harness, successCommand);
    assert.equal(successAdmission.accepted, true, JSON.stringify(successAdmission));
    const successOperation = await waitTerminal(harness, successAdmission.operationId, 180_000);
    assert.equal(successOperation.status, 'done', JSON.stringify(successOperation));
    assert.equal(successOperation.result.documentRevision, documentRevision + 1);
    const publishedPointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    assert.notEqual(publishedPointer.generation, oldGeneration, 'append threshold must publish a new generation');
    const newBaselinePath = join(initialArtifact.directory, 'baseline-' + publishedPointer.generation + '.json');
    const newLogPath = join(initialArtifact.directory, 'log-' + publishedPointer.generation + '.bin');
    assert.equal((await lstat(newBaselinePath)).isFile(), true);
    assert.equal((await lstat(newLogPath)).isFile(), true);
    const newBaseline = JSON.parse(await readFile(newBaselinePath, 'utf8'));
    const newRecords = readFrames(await readFile(newLogPath));
    assertRecoveryBaseline(newBaseline);
    assert.equal(newBaseline.documentRevision, documentRevision);
    assert.deepEqual(newBaseline.cells, current.cells.map(cell => ({ id: cell.id, revision: cell.revision })));
    assert.equal(newRecords.length, 1);
    assertRecoveryRecord(newRecords[0], documentRevision);
    assert.equal(newRecords[0].sha256, canonicalRecordDigest(newRecords[0]));
    const postCompaction = await harness.snapshot();
    assert.deepEqual(newRecords[0].delta.cells, postCompaction.cells.map(cell => ({ id: cell.id, revision: cell.revision })));
    const postCompactionBytes = applySourceDelta(decodePhysicalBytes(newBaseline.physicalBytes), newRecords[0].delta);
    assert.equal(postCompactionBytes.byteLength, newRecords[0].delta.resultLength);
    assert.equal(await exists(initialArtifact.baselinePath), false, 'old baseline must be removed only after pointer publication');
    assert.equal(await exists(initialArtifact.logPath), false, 'old log must be removed only after pointer publication');
    const identityAfter = await identity(harness);
    return {
      harness,
      identity: identityAfter,
      evidence: {
        status: 'triggered',
        trigger: 'RecoveryWriter.append',
        thresholdBytes: compactionThreshold,
        operationsBeforeThreshold: operationCount,
        oldGeneration,
        generation: publishedPointer.generation,
        pointerPublished: true,
        oldGenerationRemoved: true,
        baselineRevision: newBaseline.documentRevision,
        postCompactionRecords: newRecords.length,
        failure: failureEvidence,
      },
    };
  }
  throw new Error('recovery_compaction_threshold_not_reached');
}

async function runTracedFsyncCases(ctx, source, rscript) {
  const error = await runTracedFsyncErrorCase(ctx, source, rscript);
  const pre = await runTracedFsyncCrashCase(ctx, source, rscript, 'pre-fsync', 'delay_enter=3000ms');
  const post = await runTracedFsyncCrashCase(ctx, source, rscript, 'post-fsync', 'delay_exit=3000ms');
  return { error, pre, post };
}

async function prepareFsyncHarness(ctx, id, source, rscript, injection) {
  let harness = await createHarness(ctx, { id, source, rscript });
  try {
    const initial = await harness.snapshot();
    const cell = initial.cells[0];
    const command = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: cell.id },
        expectedRevision: cell.revision,
        cellType: cell.type,
        body: ['Sys.sleep(30)', 'fsync_value <- 1', 'fsync_value'],
      }],
    });
    const admission = assertAdmission(await harness.command(command), harness, command);
    assert.equal(admission.accepted, true, JSON.stringify(admission));
    const operation = await waitTerminal(harness, admission.operationId);
    assert.equal(operation.status, 'done', JSON.stringify(operation));
    const afterFirst = await harness.snapshot();
    const firstArtifact = await inspectArtifact(ctx, harness, Buffer.from(source));
    assert.equal(firstArtifact.records.length, 1);
    const notebook = harness.notebook;
    const canonical = harness.canonical;
    const dataHome = join(ctx.evidence, 'runtime-data', id);
    await crashHostHarness(harness);
    await closeHarness(harness);
    harness = await createTracedHarness(ctx, {
      id, notebook, canonical, dataHome, rscript, target: firstArtifact.logPath, injection,
    });
    await waitForExecutionReady(harness);
    const after = await harness.snapshot();
    assert.equal(after.documentRevision, afterFirst.documentRevision);
    assert.deepEqual(after.cells.map(item => item.body), afterFirst.cells.map(item => item.body));
    const artifact = await inspectArtifact(ctx, harness, Buffer.from(source));
    return { harness, initial, after, artifact, traced: harness.trace, cellId: cell.id, cellType: cell.type };
  } catch (error) {
    await closeHarness(harness);
    throw error;
  }
}

const MAX_TRACE_OUTPUT_BYTES = 4 * 1024 * 1024;

function appendBounded(value, text) {
  const combined = value + text;
  return combined.length <= MAX_TRACE_OUTPUT_BYTES ? combined : combined.slice(-MAX_TRACE_OUTPUT_BYTES);
}

const MAX_TRACE_DIAGNOSTIC_BYTES = 64 * 1024;

function appendDiagnostic(value, text) {
  const combined = value + text;
  return combined.length <= MAX_TRACE_DIAGNOSTIC_BYTES ? combined : combined.slice(-MAX_TRACE_DIAGNOSTIC_BYTES);
}

function appendTraceStderr(state, text, target) {
  const combined = state.stderrBuffer + text;
  const lines = combined.split('\n');
  state.stderrBuffer = lines.pop() ?? '';
  const selected = [];
  const diagnostic = [];
  for (const line of lines) {
    if (line.includes(target)
      || line.includes('fsync')
      || line.includes('delay_tcb')
      || line.includes('restart_delayed_tcb')
      || line.includes('(DELAYED)')
      || line.includes('<unfinished ...>')
      || line.includes('<... fsync resumed>')
      || line.includes('EIO')) {
      selected.push(line);
    } else if (!line.startsWith('strace:')) {
      diagnostic.push(line);
    }
  }
  if (selected.length > 0) state.stderr = appendBounded(state.stderr, selected.join('\n') + '\n');
  if (diagnostic.length > 0) state.traceDiagnostic = appendDiagnostic(state.traceDiagnostic, diagnostic.join('\n') + '\n');
}

function flushTraceStderr(state, target) {
  if (state.stderrBuffer.length > 0) appendTraceStderr(state, '\n', target);
}

async function createTracedHarness(ctx, { id, notebook, canonical, dataHome, rscript, target, injection }) {
  assert.equal(target.startsWith('/'), true);
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const wire = await loadWireCodec(ctx.applicationRoot, ctx.manifest);
  const debugArgs = injection.startsWith('delay_') ? ['-d'] : [];
  const args = [
    ...debugArgs, '-f', '-yy', '-e', 'trace=fsync', '-P', target,
    '--inject=fsync:' + injection,
    launcher, notebook, '--headless', '--no-run', '--port', '0', '--rscript', rscript,
  ];
  const trace = spawnSmokeProcess('strace', args, {
    cwd: join(ctx.evidence, 'unrelated'),
    env: sanitizedEnvironment({ XDG_DATA_HOME: dataHome }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parser = createStrictReadyParser(trace.stdout, { label: id + '_stdout' });
  const state = { stdout: '', stderr: '', stderrBuffer: '', traceDiagnostic: '', ready: null, parser };
  parser.ready.then(value => { state.ready = value; });
  trace.stderr.on('data', chunk => { appendTraceStderr(state, Buffer.from(chunk).toString('utf8'), target); });
  let traceStartIdentity;
  let ownedTree = [];
  let registry = null;
  try {
    traceStartIdentity = await processStartIdentity(trace.pid);
    ownedTree = await captureProcessTree(trace.pid, traceStartIdentity);
    await waitForTrace(trace, state, value => value.ready !== null || parser.readyRecord !== null, 120_000, 'traced_host_ready');
    state.ready = parser.readyRecord;
    assertCanonicalReady(state.ready);
    registry = await waitForRegistry(canonical, runtimeDirectory, 120_000);
    assert.equal(registry.state, 'ready');
    const registryTree = await captureProcessTree(registry.pid, registry.startIdentity);
    ownedTree = mergeProcessTrees(ownedTree, registryTree);
    const hostExe = await readlink('/proc/' + registry.pid + '/exe');
    const session = await openSession(state.ready.origin, registry);
    session.wire = wire;
    const harness = {
      id, notebook, selectedR: rscript, child: trace, stdout: state, stderr: state,
      ready: state.ready, registry, hostExe, origin: state.ready.origin, canonical, session, wire,
      ownedTree, traceStartIdentity,
      trace: { trace, state, target, injection },
      request: (path, options) => requestJson(state.ready.origin, path, options),
      query: value => query(state.ready.origin, session, value, wire),
      snapshot: () => fullSnapshot({ query: value => query(state.ready.origin, session, value, wire), session }),
      command: value => command(state.ready.origin, session, value, wire),
      awaitOperation: operationId => query(state.ready.origin, session, { type: 'operation', operationId, clientId: session.clientId }, wire),
      nextCommand: value => command(state.ready.origin, session, { ...value, operationId: value.operationId ?? randomUUID(), clientId: session.clientId, commandSequence: session.nextCommandSequence++, sessionEpoch: session.epoch }, wire),
      async close() {
        const cleanupErrors = [];
        try { await releaseLease(state.ready.origin, session); } catch (cause) { cleanupErrors.push(cause); }
        try { await stopChild(trace); } catch (cause) { cleanupErrors.push(cause); }
        try { await waitForStreamEnd(parser.done, STREAM_END_TIMEOUT_MS, id + '_stdout'); assertStrictReadyOutput(parser); state.stdout = parser.stdout; } catch (cause) { cleanupErrors.push(cause); }
        try { await cleanupOwnedProcessTree(ownedTree); } catch (cause) { cleanupErrors.push(cause); }
        try { await cleanupPartialOwner(canonical, runtimeDirectory); } catch (cause) { cleanupErrors.push(cause); }
        try { await writeFile(join(ctx.evidence, id + '.stdout.log'), state.stdout); } catch (cause) { cleanupErrors.push(cause); }
        try { await writeFile(join(ctx.evidence, id + '.stderr.log'), state.stderr); } catch (cause) { cleanupErrors.push(cause); }
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'traced harness cleanup failed');
      },
    };
    return harness;
  } catch (error) {
    const cleanupErrors = [];
    try { await stopChild(trace); } catch (cause) { cleanupErrors.push(cause); }
    try { await waitForStreamEnd(parser.done, STREAM_END_TIMEOUT_MS, id + '_stdout'); state.stdout = parser.stdout; assertStrictReadyOutput(parser, { requireReady: false }); } catch (cause) { cleanupErrors.push(cause); }
    try { await cleanupOwnedProcessTree(ownedTree); } catch (cause) { cleanupErrors.push(cause); }
    try { await cleanupPartialOwner(canonical, runtimeDirectory); } catch (cause) { cleanupErrors.push(cause); }
    try { await waitForExit(trace, CHILD_EXIT_TIMEOUT_MS, 'traced harness'); } catch (cause) { cleanupErrors.push(cause); }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'traced harness startup cleanup failed');
    throw error;
  }
}

async function waitForTrace(trace, state, predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (state.parser?.error !== null && state.parser?.error !== undefined) throw state.parser.error;
    if (predicate(state)) return;
    if (trace.exitCode !== null || trace.signalCode !== null) throw new Error(label + '_exited');
    if (Date.now() >= deadline) throw new Error(label + '_timeout');
    await delay(10);
  }
}



async function readThreadStatus(tid) {
  try {
    const text = await readFile('/proc/' + tid + '/status', 'utf8');
    const field = name => text.split('\n').find(line => line.startsWith(name + ':'))?.slice(name.length + 1).trim();
    return { tid, tgid: Number(field('Tgid')), tracerPid: Number(field('TracerPid')), state: field('State') ?? '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForTargetFsyncDelay(traced, target, harness, phase, timeout = 30_000) {
  const hostPid = await assertOwnedHost(harness);
  const tracerPid = Number(traced.trace.pid);
  assert.ok(Number.isSafeInteger(tracerPid) && tracerPid > 0, 'strace must expose a tracer PID');
  const deadline = Date.now() + timeout;
  const delayPattern = phase === 'exit'
    ? /strace: delay_tcb: delaying pid (\d+) on exit/g
    : /strace: delay_tcb: delaying pid (\d+) on enter(?:ing)?(?: syscall)?/g;
  const label = phase === 'exit' ? 'target_fsync_exit_delay' : 'target_fsync_entry_delay';
  for (;;) {
    const lines = traced.state.stderr.split('\n');
    const targetLine = phase === 'exit'
      ? lines.find(line => line.includes(target) && line.includes('fsync('))
      : null;
    const delayedLine = phase === 'exit'
      ? lines.find(line => /=\s*0\s+\(DELAYED\)/.test(line))
      : null;
    const delayed = [...traced.state.stderr.matchAll(delayPattern)].at(-1);
    if (delayed && (phase === 'enter' || (targetLine && delayedLine))) {
      const tid = Number(delayed[1]);
      const delayOffset = delayed.index ?? 0;
      const resumed = traced.state.stderr.indexOf('restart_delayed_tcb', delayOffset) >= 0;
      const status = await readThreadStatus(tid);
      if (!resumed && status?.tgid === hostPid && status.tracerPid === tracerPid && /^[tT]/.test(status.state)) {
        return { hostPid, tid, targetFilter: target, targetLine, delayLine: delayed[0], status, callbackWithheld: true, restartObserved: false, phase };
      }
    }
    if (traced.trace.exitCode !== null || traced.trace.signalCode !== null) throw new Error(label + '_exited');
    if (Date.now() >= deadline) throw new Error(label + '_timeout');
    await delay(10);
  }
}

async function waitForTargetFsyncExitDelay(traced, target, harness, timeout = 30_000) {
  return waitForTargetFsyncDelay(traced, target, harness, 'exit', timeout);
}

async function waitForTargetFsyncHeld(traced, target, harness, timeout = 30_000) {
  return waitForTargetFsyncDelay(traced, target, harness, 'enter', timeout);
}

async function stopFsyncTrace(traced) {
  const { trace, state } = traced;
  if (trace.exitCode === null && trace.signalCode === null) signalSmokeProcessGroup(trace.pid, 'SIGINT');
  try { await waitChildExit(trace, CHILD_EXIT_TIMEOUT_MS, 'strace'); } catch (error) {
    if (trace.exitCode === null && trace.signalCode === null) signalSmokeProcessGroup(trace.pid, 'SIGKILL');
    try {
      await waitForExit(trace, CHILD_EXIT_TIMEOUT_MS, 'strace kill');
    } catch (killError) {
      throw new AggregateError([error, killError], 'strace cleanup failed');
    }
  }
  flushTraceStderr(state, traced.trace.target);
  return { stdout: state.stdout, stderr: state.stderr + state.traceDiagnostic, exitCode: trace.exitCode, signal: trace.signalCode };
}

function assertFsyncPhase(traceResult, target, phase, phaseObservation) {
  if (phase === 'pre-fsync') {
    assert.equal(phaseObservation?.phase, 'enter');
    assert.equal(phaseObservation?.targetFilter, target);
    assert.equal(phaseObservation?.callbackWithheld, true);
    const line = traceResult.stderr.split('\n').find(value => /strace: delay_tcb: delaying pid \d+ on enter(?:ing)?(?: syscall)?/.test(value));
    assert.ok(line, 'strace must preserve target fsync entry-delay evidence: ' + traceResult.stderr);
    return line;
  }
  const targetLine = traceResult.stderr.split('\n').find(value => value.includes(target) && value.includes('fsync('));
  const delayedLine = traceResult.stderr.split('\n').find(value => /=\s*0\s+\(DELAYED\)/.test(value));
  assert.ok(targetLine && delayedLine, 'strace must observe target fsync exit phase: ' + traceResult.stderr);
  assert.equal(phaseObservation?.phase, 'exit');
  assert.equal(phaseObservation?.targetFilter, target);
  assert.equal(phaseObservation?.callbackWithheld, true);
  return targetLine + '\n' + delayedLine;
}

async function runTracedFsyncErrorCase(ctx, source, rscript) {
  const id = ID + '-fsync-error';
  let harness = null;
  let restarted = null;
  let traced = null;
  try {
    const prepared = await prepareFsyncHarness(ctx, id, source, rscript, 'error=EIO');
    harness = prepared.harness;
    const beforeIdentity = await identity(harness);
    traced = prepared.traced;
    const activeRun = await startActiveRun(harness, prepared);
    const command = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: prepared.after.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: prepared.cellId },
        expectedRevision: prepared.after.cells[0].revision,
        cellType: prepared.cellType,
        body: ['fsync_value <- 2', 'fsync_value'],
      }],
    });
    const admission = assertAdmission(await harness.command(command), harness, command);
    assert.equal(admission.accepted, true, JSON.stringify(admission));
    const operation = await waitTerminal(harness, admission.operationId);
    const interrupt = await interruptActiveRun(harness, activeRun);
    const traceResult = await stopFsyncTrace(traced);
    assert.equal(operation.status, 'error', JSON.stringify(operation));
    assert.equal(operation.error?.code, 'recovery_write_failed', JSON.stringify(operation));
    assert.equal(traceResult.stderr.includes(prepared.artifact.logPath), true, traceResult.stderr);
    assert.equal(/fsync\([^\n]*-1 EIO/.test(traceResult.stderr), true, traceResult.stderr);
    const cached = await harness.snapshot();
    assert.equal(cached.documentRevision, prepared.after.documentRevision);
    assert.deepEqual(cached.cells[0].body, prepared.after.cells[0].body);
    assert.equal(typeof cached.runtime.kernelEpoch, 'string');
    assert.equal(typeof prepared.after.runtime.kernelEpoch, 'string');
    assert.equal(cached.runtime.kernelEpoch, prepared.after.runtime.kernelEpoch);
    const afterLog = Buffer.from(await readFile(prepared.artifact.logPath));
    assert.equal(afterLog.subarray(0, prepared.artifact.logBytes.length).equals(prepared.artifact.logBytes), true);
    const failedFrame = afterLog.subarray(prepared.artifact.logBytes.length);
    assert.equal(failedFrame.length === 0 || failedFrame.length >= 4, true, 'an EIO frame must be absent or physically complete');
    const hostPid = Number(harness.registry.pid);
    await crashHostHarness(harness);
    await closeHarness(harness);
    harness = null;
    restarted = await createHarness(ctx, { id, source, rscript });
    const recovered = await restarted.snapshot();
    const recoveredArtifact = await inspectArtifact(ctx, restarted, Buffer.from(source));
    assert.equal(recoveredArtifact.records.length, recovered.documentRevision);
    assert.equal(recovered.documentRevision === 1 || recovered.documentRevision === 2, true);
    assert.equal(Buffer.from(await readFile(restarted.notebook)).equals(Buffer.from(source)), true);
    if (recovered.documentRevision === 1) assert.deepEqual(recovered.cells[0].body, prepared.after.cells[0].body);
    if (recovered.documentRevision === 2) {
      assert.equal(recovered.cells[0].body[0], 'fsync_value <- 2');
      assert.equal(recoveredArtifact.records.at(-1).toRevision, 2);
    }
    const afterIdentity = await identity(restarted);
    return {
      mode: 'error',
      operationId: command.operationId,
      target: prepared.artifact.logPath,
      injection: 'error=EIO',
      trace: traceResult,
      admissionAccepted: admission.accepted,
      operationStatus: operation.status,
      operationError: operation.error,
      cachedRevision: cached.documentRevision,
      hostPid,
      recoveredRevision: recovered.documentRevision,
      outcome: recovered.documentRevision === 1 ? 'record-not-replayed' : 'record-replayed',
      sourceUnchanged: true,
      publication: { sourceUnchanged: true, recoveryLogPrefixPreserved: true },
      physicalFrame: { present: failedFrame.byteLength > 0, byteLength: failedFrame.byteLength, complete: failedFrame.byteLength >= 4, recoveredRecords: recoveredArtifact.records.length, recoveredRevision: recovered.documentRevision },
      ack: { accepted: admission.accepted, status: operation.status, acknowledged: false, errorCode: operation.error?.code },
      cachedRead: { documentRevision: cached.documentRevision, firstCell: cached.cells[0].body[1] },
      sourceEventPublished: false,
      kernelEffect: false,
      interrupt: { runId: activeRun.runId, operationId: interrupt.command.operationId, status: interrupt.operation.status, runOperationId: activeRun.command.operationId, runStatus: interrupt.runOperation.status, hostSignal: 'SIGKILL', leaseClientKilled: true },
      epochChanged: beforeIdentity.epoch !== afterIdentity.epoch,
    };
  } finally {
    if (traced) await stopFsyncTrace(traced).catch(() => {});
    await closeHarnesses(restarted, harness);
  }
}

async function runTracedFsyncCrashCase(ctx, source, rscript, phase, injection) {
  const id = ID + '-' + phase;
  let harness = null;
  let restarted = null;
  let traced = null;
  try {
    const prepared = await prepareFsyncHarness(ctx, id, source, rscript, injection);
    harness = prepared.harness;
    const beforeIdentity = await identity(harness);
    traced = prepared.traced;
    const activeRun = await startActiveRun(harness, prepared);
    const command = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: prepared.after.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: prepared.cellId },
        expectedRevision: prepared.after.cells[0].revision,
        cellType: prepared.cellType,
        body: ['fsync_value <- 2', 'fsync_value'],
      }],
    });
    const admission = assertAdmission(await harness.command(command), harness, command);
    assert.equal(admission.accepted, true, JSON.stringify(admission));
    const hostPid = Number(harness.registry.pid);
    const phaseObservation = phase === 'post-fsync'
      ? await waitForTargetFsyncExitDelay(traced, prepared.artifact.logPath, harness)
      : await waitForTargetFsyncHeld(traced, prepared.artifact.logPath, harness);
    const interrupt = await interruptActiveRun(harness, activeRun);
    const cached = await harness.snapshot();
    assert.equal(cached.documentRevision, prepared.after.documentRevision);
    assert.deepEqual(cached.cells[0].body, prepared.after.cells[0].body);
    const pending = snapshotOf(await harness.query({ type: 'operation', operationId: command.operationId, clientId: harness.session.clientId }));
    assert.equal(typeof pending.status, 'string', 'source transaction operation must remain observable before crash');
    assert.equal(TERMINAL.has(pending.status), false, 'source transaction ACK must remain withheld while fsync is delayed');
    const heldAfterInterrupt = phase === 'post-fsync'
      ? await waitForTargetFsyncExitDelay(traced, prepared.artifact.logPath, harness)
      : await waitForTargetFsyncHeld(traced, prepared.artifact.logPath, harness);
    await crashHostHarness(harness);
    const traceResult = await stopFsyncTrace(traced);
    const phaseLine = assertFsyncPhase(traceResult, prepared.artifact.logPath, phase, phaseObservation);
    await closeHarness(harness);
    harness = null;
    restarted = await createHarness(ctx, { id, source, rscript });
    const recovered = await restarted.snapshot();
    const recoveredArtifact = await inspectArtifact(ctx, restarted, Buffer.from(source));
    assert.equal(Buffer.from(await readFile(restarted.notebook)).equals(Buffer.from(source)), true);
    assert.equal(recoveredArtifact.records.length, recovered.documentRevision);
    if (phase === 'post-fsync') {
      assert.equal(recovered.documentRevision, 2, 'post-fsync completion must leave a complete replay candidate');
      assert.equal(recoveredArtifact.records.at(-1).toRevision, 2);
      assert.equal(recovered.cells[0].body[0], 'fsync_value <- 2');
    } else {
      assert.equal(recovered.documentRevision === 1 || recovered.documentRevision === 2, true);
      if (recovered.documentRevision === 1) assert.deepEqual(recovered.cells[0].body, prepared.after.cells[0].body);
      if (recovered.documentRevision === 2) {
        assert.equal(recovered.cells[0].body[0], 'fsync_value <- 2');
        assert.equal(recoveredArtifact.records.at(-1).toRevision, 2);
      }
    }
    const afterIdentity = await identity(restarted);
    return {
      mode: 'crash',
      phase,
      operationId: command.operationId,
      target: prepared.artifact.logPath,
      injection,
      trace: traceResult,
      phaseTrace: phaseLine,
      admissionAccepted: admission.accepted,
      cachedRevision: prepared.after.documentRevision,
      killSignal: 'SIGKILL',
      hostPid,
      recoveredRevision: recovered.documentRevision,
      outcome: phase === 'post-fsync'
        ? 'complete-candidate-replayed'
        : recovered.documentRevision === 1 ? 'pre-fsync-record-not-replayed' : 'pre-fsync-page-cache-replayed',
      sourceUnchanged: true,
      fsyncPhaseObserved: { initial: phaseObservation, afterInterrupt: heldAfterInterrupt },
      ack: { accepted: admission.accepted, operationId: command.operationId, status: pending.status, acknowledged: false },
      cachedRead: { documentRevision: cached.documentRevision, body: cached.cells[0].body },
      interrupt: { runId: activeRun.runId, operationId: interrupt.command.operationId, status: interrupt.operation.status, runOperationId: activeRun.command.operationId, runStatus: interrupt.runOperation.status, hostSignal: 'SIGKILL', leaseClientKilled: true },
      epochChanged: beforeIdentity.epoch !== afterIdentity.epoch,
    };
  } finally {
    if (traced) await stopFsyncTrace(traced).catch(() => {});
    await closeHarnesses(restarted, harness);
  }
}

async function crashHostHarness(harness) {
  harness.hostCrashed = true;
  const pid = await assertOwnedHost(harness);
  const startIdentity = harness.registry.startIdentity;
  const cleanupErrors = [];
  try {
    await signalOwnedHost(harness, 'SIGKILL');
  } catch (error) {
    cleanupErrors.push(cleanupEvidence(error, harness, 'host crash signal'));
  }
  try {
    await waitForPidExit(pid, CHILD_EXIT_TIMEOUT_MS, startIdentity);
  } catch (error) {
    cleanupErrors.push(cleanupEvidence(error, harness, 'host crash wait'));
  }
  if (Array.isArray(harness.ownedTree) && harness.ownedTree.length > 0) {
    try {
      await cleanupOwnedProcessTree(harness.ownedTree);
    } catch (error) {
      cleanupErrors.push(cleanupEvidence(error, harness, 'host process-tree cleanup'));
    }
  }
  if (harness.child.exitCode === null && harness.child.signalCode === null) {
    try { signalSmokeProcessGroup(harness.child.pid, 'SIGKILL'); } catch (error) { cleanupErrors.push(cleanupEvidence(error, harness, 'crash client signal')); }
  }
  try {
    await waitForExit(harness.child, CHILD_EXIT_TIMEOUT_MS, 'crash client');
  } catch (error) {
    cleanupErrors.push(cleanupEvidence(error, harness, 'crash client wait'));
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'host crash cleanup failed');
}
