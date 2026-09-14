import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createHarness, delay } from './_common.mjs';

async function waitTerminal(harness, operationId, timeout = 120_000) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + timeout;
  for (;;) {
    const operation = await harness.awaitOperation(operationId);
    if (['done', 'error', 'interrupted', 'cancelled'].includes(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error('operation_timeout: ' + operationId);
    await delay(50);
  }
}

async function issue(harness, value) {
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
  assert.equal(admission.clientId, command.clientId);
  assert.equal(admission.commandSequence, command.commandSequence);
  assert.equal(admission.operationId, command.operationId);
  assert.equal(admission.accepted, true, JSON.stringify(admission));
  assert.equal(admission.error, null);
  assert.equal(admission.operation.id, command.operationId);
  return waitTerminal(harness, admission.operationId);
}


async function waitForNotebookExecutionReady(harness, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const envelope = await harness.query({ type: 'notebook' });
    assert.deepEqual(Object.keys(envelope).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
    assert.equal(envelope.epoch, harness.session.epoch);
    const notebook = envelope.result;
    assert.ok(notebook && typeof notebook === 'object' && !Array.isArray(notebook));
    const runtime = notebook.runtime;
    assert.ok(runtime && typeof runtime === 'object' && !Array.isArray(runtime));
    if (runtime.kernelState === 'failed' || runtime.analyzerState === 'failed') {
      throw new Error('runtime_not_ready: ' + JSON.stringify({ epoch: notebook.epoch, kernelState: runtime.kernelState, analyzerState: runtime.analyzerState, executionBlockedReason: runtime.executionBlockedReason }));
    }
    if (runtime.executionReady === true && runtime.documentReady === true
      && runtime.kernelState === 'ready' && runtime.analyzerState === 'ready'
      && typeof runtime.kernelEpoch === 'string' && runtime.kernelEpoch.length > 0) return notebook;
    if (Date.now() >= deadline) {
      throw new Error('runtime_ready_timeout: ' + JSON.stringify({ epoch: notebook.epoch, kernelState: runtime.kernelState, analyzerState: runtime.analyzerState, documentReady: runtime.documentReady, executionReady: runtime.executionReady, executionBlockedReason: runtime.executionBlockedReason, kernelEpoch: runtime.kernelEpoch }));
    }
    await delay(100);
  }
}
export async function run(ctx) {
  const filler = '#\t' + 'x'.repeat(999_996) + 'λ';
  assert.equal(filler.includes('\t'), true, 'large legal source fixture must include a control byte');
  const lines = ['# %%', 'value <- 40', 'value'];
  for (let index = 0; index < 33; index += 1) lines.push(filler);
  lines.push('# %%', 'value + 2', '# %%', 'cat(strrep("λ", 1100000)); 7L');
  const source = lines.join('\n') + '\n';
  const harness = await createHarness(ctx, { id: 'large-source-output', source, rscript: requireRscript(ctx) });
  try {
    const sourceBytes = (await stat(harness.notebook)).size;
    assert.equal(sourceBytes > 31 * 1024 * 1024, true);
    assert.equal(sourceBytes < 32 * 1024 * 1024, true);
    const initial = await waitForNotebookExecutionReady(harness);
    assert.equal(initial.runtime.analyzerState, 'ready');
    assert.equal(initial.runtime.kernelState, 'ready');
    assert.equal(initial.runtime.executionReady, true);
    assert.equal(initial.cells.length, 3);
    const first = initial.cells[0];
    const second = initial.cells[1];
    assert.ok(first && second);
    assert.equal(first.revision, 0);
    assert.equal(second.revision, 0);
    const graph = (await harness.query({ type: 'graph' })).result;
    assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph));
    assert.deepEqual(graph.nodes, initial.cells.map(cell => cell.id));
    assert.ok(Array.isArray(graph.edges?.[second.id]));
    assert.equal(graph.edges[second.id].includes(first.id), true);

    const run = await issue(harness, {
      type: 'run', scope: 'all', expectedDocumentRevision: initial.documentRevision,
    });
    assert.equal(run.status, 'done', JSON.stringify(run));
    const firstOutputs = (await harness.query({ type: 'outputs' })).result;
    const firstOutputsText = firstOutputs.map(output => JSON.stringify(output)).join('\n');
    assert.equal(firstOutputsText.includes('40'), true, JSON.stringify(firstOutputs));
    assert.equal(firstOutputsText.includes('42'), true, JSON.stringify(firstOutputs));

    const oldLine = 'value <- 40';
    const edited = await issue(harness, {
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'text-edit', cell: { cellId: first.id },
        expectedRevision: first.revision,
        edits: [{ start: { line: 0, character: 0 }, end: { line: 0, character: oldLine.length }, text: 'value <- 41' }],
      }],
    });
    assert.equal(edited.status, 'done', JSON.stringify(edited));
    const afterEdit = (await harness.query({ type: 'notebook' })).result;
    assert.equal(afterEdit.documentRevision, initial.documentRevision + 1);
    assert.equal(afterEdit.cells[0].revision, first.revision + 1);
    const rerun = await issue(harness, { type: 'run', scope: 'all', expectedDocumentRevision: afterEdit.documentRevision });
    assert.equal(rerun.status, 'done', JSON.stringify(rerun));
    const rerunOutputs = (await harness.query({ type: 'outputs' })).result;
    const rerunOutputsText = rerunOutputs.map(output => JSON.stringify(output)).join('\n');
    assert.equal(rerunOutputsText.includes('41'), true, JSON.stringify(rerunOutputs));
    assert.equal(rerunOutputsText.includes('43'), true, JSON.stringify(rerunOutputs));

    const snapshot = await harness.snapshot();
    assert.equal(snapshot.cells[2].log.includes('[output truncated at 1048576 bytes]'), true, JSON.stringify({ status: snapshot.cells[2].status, logTail: snapshot.cells[2].log.slice(-3), logChars: snapshot.cells[2].log.join('\n').length }));
    const captured = snapshot;
    assert.equal(captured.cells[0].body[0], 'value <- 41');
    assert.equal(captured.cells[0].body.at(-1).includes('\t'), true);
    assert.equal(captured.cells[0].body.at(-1), filler);
    const identity = await harness.request('/api/identity', { method: 'GET', cookie: harness.session.cookie, csrf: harness.session.csrf });
    return {
      id: 'large-source-output',
      identity: {
        bounds: { sourceBytes, sourceLimit: 32 * 1024 * 1024, sourceControlByte: 'tab', outputChunkBytes: 262_144, capturedBytes: 'canonical-output-store-snapshot' },
        runtime: { rscript: harness.selectedR, rHome: snapshot.runtime.rEnvironment?.rHome, rVersion: snapshot.runtime.rEnvironment?.version, kernelEpoch: snapshot.runtime.kernelEpoch, processNonce: identity.processNonce },
      },
    };
  } finally {
    await harness.close();
  }
}

function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string');
  assert.equal(ctx.rscript.startsWith('/'), true);
  return ctx.rscript;
}
