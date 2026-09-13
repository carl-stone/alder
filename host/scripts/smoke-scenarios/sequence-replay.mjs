import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { command as sendCommand, createHarness, delay, openSession, query as querySession, redact, releaseLease, snapshot as fullSnapshot } from './_common.mjs';

export async function run(ctx) {
  let harness;
  let secondSession;
  try {
    harness = await createHarness(ctx, {
      id: 'sequence-replay',
      source: '# %%\nsequence_value <- 1\nsequence_value\n',
      rscript: requireRscript(ctx),
    });
    const initial = await harness.snapshot();
    const cell = initial.cells[0];
    assert.ok(cell, 'sequence fixture must expose a source cell');

    const transaction = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: cell.id },
        expectedRevision: cell.revision,
        body: ['sequence_value <- 2', 'sequence_value'],
        cellType: cell.type,
      }],
    });
    const firstAdmission = assertAdmission(await harness.command(transaction), harness, transaction);
    assert.equal(firstAdmission.accepted, true, 'first command must be admitted');
    const firstOperation = await waitForTerminal(harness, transaction.operationId);
    assert.equal(firstOperation.status, 'done', JSON.stringify(firstOperation));

    const replayAdmission = assertAdmission(await harness.command(transaction), harness, transaction);
    assert.deepEqual(replayAdmission, firstAdmission, 'identical retry must return the original receipt');
    const replayOperation = await waitForTerminal(harness, transaction.operationId);
    assert.deepEqual(replayOperation, firstOperation, 'identical retry must return the original operation');

    const conflict = {
      ...transaction,
      changes: [{
        ...transaction.changes[0],
        body: ['sequence_value <- 99', 'sequence_value'],
      }],
    };
    const conflictAdmission = assertAdmission(await commandAllowConflict(harness, conflict), harness, conflict);
    assert.equal(conflictAdmission.accepted, false, JSON.stringify(conflictAdmission));
    assert.equal(conflictAdmission.sequenceConsumed, false);
    assert.equal(conflictAdmission.error.code, 'operation_id_conflict', JSON.stringify(conflictAdmission));

    const gap = makeIdentity(harness, {
      type: 'transaction',
      expectedDocumentRevision: firstOperation.documentRevision,
      changes: [],
    });
    gap.commandSequence = harness.session.nextCommandSequence + 1;
    const gapAdmission = assertAdmission(await commandAllowConflict(harness, gap), harness, gap);
    assert.equal(gapAdmission.accepted, false, JSON.stringify(gapAdmission));
    assert.equal(gapAdmission.sequenceConsumed, false);
    assert.equal(gapAdmission.error.code, 'command_sequence_gap', JSON.stringify(gapAdmission));
    assert.deepEqual(gapAdmission.error.details, {
      expectedCommandSequence: harness.session.nextCommandSequence,
      nextCommandSequence: gap.commandSequence,
      sequenceConsumed: false,
    });

    const noop = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: firstOperation.documentRevision,
      changes: [],
    });
    const noopAdmission = assertAdmission(await harness.command(noop), harness, noop);
    assert.equal(noopAdmission.accepted, true, 'the next contiguous sequence must remain available');
    const noopOperation = await waitForTerminal(harness, noop.operationId);
    assert.equal(noopOperation.status, 'done', JSON.stringify(noopOperation));
    assert.equal(noopOperation.documentRevision, firstOperation.documentRevision);

    const semanticFailure = makeCommand(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [],
    });
    const semanticAdmission = assertAdmission(await harness.command(semanticFailure), harness, semanticFailure);
    assert.equal(semanticAdmission.accepted, true);
    const semanticOperation = await waitForTerminal(harness, semanticFailure.operationId);
    assert.equal(semanticOperation.status, 'error', JSON.stringify(semanticOperation));
    assert.equal(semanticOperation.error.code, 'source_conflict');

    secondSession = await openSession(harness.origin, harness.registry);
    const secondInitial = await fullSnapshot({ origin: harness.origin, wire: harness.wire, query: value => querySession(harness.origin, secondSession, value), session: secondSession });
    assert.equal(secondInitial.documentRevision, firstOperation.documentRevision);
    const secondNoop = makeSessionCommand(secondSession, {
      type: 'transaction',
      expectedDocumentRevision: secondInitial.documentRevision,
      changes: [],
    });
    const secondAdmission = assertAdmission(await sendCommand(harness.origin, secondSession, secondNoop), { session: secondSession }, secondNoop);
    assert.equal(secondAdmission.accepted, true, 'second client must receive its own sequence space');
    const secondOperation = await waitForSessionTerminal(harness.origin, secondSession, secondNoop.operationId);
    assert.equal(secondOperation.status, 'done');
    assert.equal(secondOperation.documentRevision, firstOperation.documentRevision);

    const evictionOperations = [];
    for (let index = 0; index < 512; index += 1) {
      const evict = makeCommand(harness, {
        type: 'transaction',
        expectedDocumentRevision: firstOperation.documentRevision,
        changes: [],
      });
      const evictAdmission = assertAdmission(await harness.command(evict), harness, evict);
      assert.equal(evictAdmission.accepted, true);
      const evictOperation = await waitForTerminal(harness, evict.operationId);
      assert.equal(evictOperation.status, 'done');
      evictionOperations.push(evictOperation.id);
    }
    assert.equal(evictionOperations.length, 512);
    const expiredAdmission = assertAdmission(await commandAllowConflict(harness, transaction), harness, transaction);
    assert.equal(expiredAdmission.accepted, false, JSON.stringify(expiredAdmission));
    assert.equal(expiredAdmission.sequenceConsumed, false);
    assert.equal(expiredAdmission.error.code, 'operation_expired', JSON.stringify(expiredAdmission));
    assert.deepEqual(expiredAdmission.error.details, {
      expectedCommandSequence: 516,
      nextCommandSequence: transaction.commandSequence,
      sequenceConsumed: false,
    });

    const recovery = snapshotOf(await harness.query({ type: 'events', epoch: initial.epoch, cursor: initial.cursor }));
    assert.deepEqual(Object.keys(recovery).sort(), ['cursor', 'epoch', 'events', 'kind']);
    assert.equal(recovery.kind, 'replay', JSON.stringify(recovery));
    assert.ok(Array.isArray(recovery.events) && recovery.events.length > 0, 'event cursor must replay committed events');
    assert.equal(recovery.events.every(event => event.cursor > initial.cursor), true);
    assert.equal(recovery.events.some(event => event.operationId === transaction.operationId), true);

    const after = await harness.snapshot();
    assert.deepEqual(after.cells[0].body, ['sequence_value <- 2', 'sequence_value']);
    const evidence = {
      protocol: 'alder-host-v2',
      initial: redact({ epoch: initial.epoch, cursor: initial.cursor, documentRevision: initial.documentRevision }),
      first: { command: redact(transaction), admission: redact(firstAdmission), operation: redact(firstOperation) },
      replay: redact(replayAdmission),
      operationConflict: redact(conflictAdmission),
      sequenceGap: redact(gapAdmission),
      semanticFailure: redact(semanticOperation),
      secondClient: redact(secondAdmission),
      evictionCount: evictionOperations.length,
      expired: redact(expiredAdmission),
      recovery: redact(recovery),
    };
    await writeEvidence(ctx.evidence, evidence);
    return {
      id: 'sequence-replay',
      identity: {
        artifact: { sourceCommit: ctx.manifest.sourceCommit, hostProtocol: ctx.manifest.hostProtocol, engineProtocol: ctx.manifest.engineProtocol, launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher) },
        source: { digest: digestBytes(after.cells[0].body), documentRevision: after.documentRevision },
        protocol: {
          epoch: harness.session.epoch,
          replayOperationId: transaction.operationId,
          replaySequence: transaction.commandSequence,
          recoveredEvents: recovery.events.length,
          evictedCommands: evictionOperations.length,
        },
      },
    };
  } finally {
    if (secondSession) await releaseLease(harness.origin, secondSession);
    await harness?.close();
  }
}

async function commandAllowConflict(harness, command) {
  const response = await fetch(new URL('/api/command', harness.origin), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Origin: harness.origin,
      'Content-Type': 'application/json',
      Cookie: harness.session.cookie,
      'X-CSRF-Token': harness.session.csrf,
    },
    body: JSON.stringify(harness.wire.encodeHostCommandWire(command)),
  });
  const value = await response.json();
  const expectedStatus = value?.error?.code === 'operation_expired' ? 410 : 409;
  if (response.status !== expectedStatus) throw new Error('expected HTTP ' + expectedStatus + ' command rejection, got HTTP ' + response.status + ': ' + JSON.stringify(value));
  return value;
}

function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string');
  assert.equal(ctx.rscript.startsWith('/'), true);
  return ctx.rscript;
}

function makeIdentity(harness, value) {
  return {
    ...value,
    operationId: randomUUID(),
    clientId: harness.session.clientId,
    commandSequence: harness.session.nextCommandSequence,
    sessionEpoch: harness.session.epoch,
  };
}

function makeCommand(harness, value) {
  const command = makeIdentity(harness, value);
  harness.session.nextCommandSequence += 1;
  return command;
}

function makeSessionCommand(session, value) {
  return {
    ...value,
    operationId: randomUUID(),
    clientId: session.clientId,
    commandSequence: session.nextCommandSequence++,
    sessionEpoch: session.epoch,
  };
}

function assertAdmission(value, owner, command) {
  const session = owner.session;
  assert.deepEqual(Object.keys(value).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
  assert.equal(value.epoch, session.epoch);
  assert.equal(value.clientId, command.clientId);
  assert.equal(value.commandSequence, command.commandSequence);
  assert.equal(value.operationId, command.operationId);
  if (value.accepted) {
    assert.equal(value.error, null);
    assert.equal(value.operation.id, command.operationId);
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
  return waitForSessionTerminal(harness.origin, harness.session, operationId, harness);
}

async function waitForSessionTerminal(origin, session, operationId, harness = null) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const current = snapshotOf(await querySession(origin, session, { type: 'operation', operationId, clientId: session.clientId }));
    if (['done', 'error', 'cancelled', 'interrupted'].includes(current.status)) return current;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await delay(100);
  }
}

async function writeEvidence(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'sequence-replay.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function digestBytes(lines) {
  return createHash('sha256').update(Buffer.from(lines.join('\n') + '\n', 'utf8')).digest('hex');
}
