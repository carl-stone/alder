import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createHarness, waitForExecutionReady } from './_common.mjs';

/**
 * Drive the v2 transaction protocol against a staged host.  The assertions
 * compare source snapshots, physical bytes, revisions, and the event stream;
 * no controller implementation is imported or mocked here.
 */
export async function run(ctx) {
  const evidence = join(ctx.evidence, 'transaction');
  await mkdir(evidence, { recursive: true });
  const harness = await createHarness(ctx, {
    id: 'transaction-main',
    source: '# %%\nx <- 40\n# %%\nx + 2\n# %%\nz <- 7\n',
    rscript: requireRscript(ctx),
  });
  try {
    const initial = await harness.snapshot();
    assert.equal(initial.cells.length, 3);
    assert.equal(initial.documentRevision, 0);
    const [first, second, third] = initial.cells;
    const initialBytes = Buffer.from(await readFile(harness.notebook));

    const invalidBatch = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: initial.documentRevision,
      changes: [
        { type: 'edit', cell: { cellId: first.id }, expectedRevision: first.revision, body: ['x <- 41'], cellType: 'code' },
        { type: 'edit', cell: { cellId: second.id }, expectedRevision: second.revision + 1, body: ['x + 3'], cellType: 'code' },
      ],
    });
    const invalidResult = await settle(harness, operationId(invalidBatch));
    assert.equal(invalidResult.status, 'error');
    assert.equal(invalidResult.error.code, 'source_conflict');
    assert.equal(invalidResult.error.message, `cell revision mismatch for ${second.id}: expected ${second.revision + 1}, actual ${second.revision}`);
    const afterInvalid = await harness.snapshot();
    assert.equal(afterInvalid.documentRevision, initial.documentRevision);
    assert.deepEqual(sourceProjection(afterInvalid), sourceProjection(initial), 'invalid later change must roll back the whole candidate');
    assert.deepEqual(Buffer.from(await readFile(harness.notebook)), initialBytes);
    const invalidEvents = eventValues(await harness.query({ type: 'events', epoch: initial.epoch, cursor: initial.cursor }));
    assert.equal(invalidEvents.some(event => event.type === 'transaction'), false);

    const valid = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: initial.documentRevision,
      changes: [
        { type: 'edit', cell: { cellId: first.id }, expectedRevision: first.revision, body: ['x <- 41'], cellType: 'code' },
        { type: 'create', creationId: 'created-cell', after: { cellId: first.id }, cellType: 'code', body: ['y <- 1'], options: { echo: false } },
        { type: 'options', cell: { creationId: 'created-cell' }, patch: { label: 'created' } },
        { type: 'text-edit', cell: { cellId: second.id }, expectedRevision: second.revision, edits: [{ start: { line: 0, character: 5 }, end: { line: 0, character: 5 }, text: ' + 0' }] },
        { type: 'move', cell: { creationId: 'created-cell' }, after: { cellId: second.id } },
        { type: 'delete', cell: { cellId: third.id }, expectedRevision: third.revision },
      ],
    });
    const validResult = await settle(harness, operationId(valid));
    assert.equal(validResult.status, 'done', JSON.stringify(validResult));
    const committed = await harness.snapshot();
    assert.equal(committed.documentRevision, 1);
    assert.equal(committed.cells.length, 3);
    assert.deepEqual(committed.cells.map(cell => cell.id), [first.id, second.id, committed.cells.find(cell => cell.options.label === 'created')?.id]);
    const created = committed.cells.find(cell => cell.options.label === 'created');
    assert.ok(created, 'creation reference must resolve to a durable cell id');
    assert.equal(created.revision, 0);
    assert.equal(created.body.join('\n'), 'y <- 1');
    assert.equal(created.options.echo, false);
    assert.equal(committed.cells.find(cell => cell.id === first.id).revision, first.revision + 1);
    assert.equal(committed.cells.find(cell => cell.id === second.id).revision, second.revision + 1);
    assert.equal(committed.cells.some(cell => cell.id === third.id), false);
    assert.equal(committed.cells[1].body.join('\n'), 'x + 2 + 0');
    const transactionEvents = eventValues(await harness.query({ type: 'events', epoch: initial.epoch, cursor: initial.cursor })).filter(event => event.type === 'transaction');
    assert.equal(transactionEvents.length, 1, 'one valid transaction must produce one transaction event');
    assert.deepEqual(Object.keys(transactionEvents[0].payload).sort(), ['analysisPending', 'config', 'created', 'deleted', 'documentRevision', 'graph', 'layout', 'metadata', 'order', 'updated']);
    assert.deepEqual(transactionEvents[0].payload.updated.map(entry => entry.id), [first.id, second.id]);
    assert.deepEqual(transactionEvents[0].payload.deleted, [third.id]);
    assert.deepEqual(transactionEvents[0].payload.order, committed.cells.map(cell => cell.id));
    assert.equal(transactionEvents[0].payload.created['created-cell'], created.id);

    await waitForExecutionReady(harness);
    const run = await nextCommand(harness, { type: 'run', scope: 'all', expectedDocumentRevision: committed.documentRevision });
    const runResult = await settle(harness, operationId(run));
    assert.equal(runResult.status, 'done', JSON.stringify(runResult));
    const afterRun = await harness.snapshot();
    assert.equal(afterRun.documentRevision, committed.documentRevision, 'outputs must not advance source revision');
    assert.deepEqual(sourceProjection(afterRun), sourceProjection(committed));

    const postOutputEdit = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: afterRun.documentRevision,
      changes: [{ type: 'edit', cell: { cellId: first.id }, expectedRevision: first.revision + 1, body: ['x <- 43'], cellType: 'code' }],
    });
    assert.equal((await settle(harness, operationId(postOutputEdit)).then(value => value.status)), 'done');
    const afterOutputEdit = await harness.snapshot();
    assert.equal(afterOutputEdit.documentRevision, 2);

    const noOpBytes = Buffer.from(await readFile(harness.notebook));
    const noOp = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: afterOutputEdit.documentRevision,
      changes: [{ type: 'edit', cell: { cellId: first.id }, expectedRevision: first.revision + 2, body: ['x <- 43'], cellType: 'code' }],
    });
    const noOpResult = await settle(harness, operationId(noOp));
    assert.equal(noOpResult.status, 'done');
    const afterNoOp = await harness.snapshot();
    assert.equal(afterNoOp.documentRevision, afterOutputEdit.documentRevision, 'semantic no-op must not consume a source revision');
    assert.deepEqual(Buffer.from(await readFile(harness.notebook)), noOpBytes);

    const overlap = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: afterNoOp.documentRevision,
      changes: [{ type: 'text-edit', cell: { cellId: second.id }, expectedRevision: second.revision + 1, edits: [
        { start: { line: 0, character: 0 }, end: { line: 0, character: 2 }, text: 'x ' },
        { start: { line: 0, character: 1 }, end: { line: 0, character: 3 }, text: '+ ' },
      ] }],
    });
    const overlapResult = await settle(harness, operationId(overlap));
    assert.equal(overlapResult.status, 'error');
    assert.equal(overlapResult.error?.code, 'invalid_document');
    assert.equal(overlapResult.error?.message, 'text edits overlap');
    const afterOverlap = await harness.snapshot();
    assert.deepEqual(sourceProjection(afterOverlap), sourceProjection(afterNoOp));

    const staleDocument = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: 0,
      changes: [{ type: 'edit', cell: { cellId: first.id }, expectedRevision: first.revision + 2, body: ['x <- 44'], cellType: 'code' }],
    });
    const staleResult = await settle(harness, operationId(staleDocument));
    assert.equal(staleResult.status, 'error');
    assert.equal(staleResult.error?.code, 'source_conflict');
    assert.deepEqual(staleResult.error?.details, { kind: 'document', expectedDocumentRevision: 0, actualDocumentRevision: afterNoOp.documentRevision });
    assert.deepEqual(sourceProjection(await harness.snapshot()), sourceProjection(afterNoOp));

    const graphBlock = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: afterNoOp.documentRevision,
      changes: [{ type: 'create', creationId: 'duplicate-definition', after: null, cellType: 'code', body: ['x <- 99'], options: {} }],
    });
    assert.equal((await settle(harness, operationId(graphBlock))).status, 'done');
    const blocked = await harness.snapshot();
    assert.equal(blocked.documentRevision, afterNoOp.documentRevision + 1);
    assert.equal(Object.keys(blocked.graph.duplicates).length > 0, true, 'graph-blocked source must still commit a duplicate definition');
    const kernelBeforeBlockedRun = blocked.runtime.kernelEpoch;
    const blockedRun = await nextCommand(harness, { type: 'run', scope: 'all', expectedDocumentRevision: blocked.documentRevision });
    const blockedRunResult = await settle(harness, operationId(blockedRun));
    assert.equal(blockedRunResult.status, 'error');
    assert.equal(blockedRunResult.error?.code, 'graph_invalid');
    assert.ok(Array.isArray(blockedRunResult.error?.details?.issues));
    assert.equal(blockedRunResult.error.details.issues.some(issue => issue.code === 'duplicate-definition'), true);
    const afterBlockedRun = await harness.snapshot();
    assert.equal(afterBlockedRun.runtime.kernelEpoch, kernelBeforeBlockedRun, 'graph-blocked run must not touch Ark');
    assert.equal(afterBlockedRun.documentRevision, blocked.documentRevision);
    await writeFile(join(evidence, 'transaction.source'), await readFile(harness.notebook));
    return {
      id: 'transaction',
      identity: { launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher), epoch: harness.session.epoch, canonicalPath: harness.canonical },
      invalidCandidateRolledBack: true,
      committed: { documentRevision: 1, createdId: created.id, deletedId: third.id, transactionEvents: transactionEvents.length },
      outputsDoNotConflict: true,
      noOpUnchanged: true,
      overlappingRangesRejected: true,
      staleRevisionRejected: true,
      graphBlockedCommit: { documentRevision: blocked.documentRevision, runError: blockedRunResult.error },
      evidence,
    };
  } finally {
    await harness.close();
  }
}

async function nextCommand(harness, value) {
  const command = {
    ...value,
    operationId: randomUUID(),
    clientId: harness.session.clientId,
    commandSequence: harness.session.nextCommandSequence++,
    sessionEpoch: harness.session.epoch,
  };
  const admission = await harness.command(command);
  assert.deepEqual(Object.keys(admission).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
  assert.equal(admission.epoch, harness.session.epoch);
  assert.equal(admission.clientId, harness.session.clientId);
  assert.equal(admission.operationId, command.operationId);
  assert.equal(admission.operation.id, command.operationId);
  assert.equal(admission.error, null);
  assert.equal(admission.accepted, true);
  return admission;
}



async function settle(harness, operationId, timeout = 120_000) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (['done', 'error', 'interrupted', 'cancelled'].includes(value.status)) return value;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function operationId(admission) {
  assert.equal(typeof admission.operationId, 'string');
  assert.equal(admission.operationId, admission.operation.id);
  return admission.operationId;
}
function snapshotOf(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Number.isSafeInteger(value.documentRevision));
  assert.ok(Number.isSafeInteger(value.cursor));
  return value.result;
}
function sourceProjection(snapshot) {
  return {
    documentRevision: snapshot.documentRevision,
    dirty: snapshot.dirty,
    path: snapshot.path,
    cells: snapshot.cells.map(cell => ({ id: cell.id, type: cell.type, body: cell.body, options: cell.options, revision: cell.revision })),
  };
}
function eventValues(value) {
  const result = snapshotOf(value);
  return result.events;
}
function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string');
  assert.equal(ctx.rscript.startsWith('/'), true);
  return ctx.rscript;
}
