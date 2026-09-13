import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHarness, delay, waitForExecutionReady } from './_common.mjs';

async function waitTerminal(harness, operationId, timeout = 120_000) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + timeout;
  for (;;) {
    const operation = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (["done", "error", "interrupted", "cancelled"].includes(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error("operation_timeout: " + operationId);
    await delay(40);
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

async function snapshot(harness) {
  return harness.snapshot();
}

async function waitFor(harness, predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await snapshot(harness);
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('analysis_wait_timeout');
    await delay(50);
  }
}

function snapshotOf(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Number.isSafeInteger(value.documentRevision));
  assert.ok(Number.isSafeInteger(value.cursor));
  return value.result;
}

export async function run(ctx) {
  const marker = ctx.evidence + '/analysis-side-effect-marker';
  const source = [
    '# %%', 'alpha <- 40', 'alpha',
    '# %%', 'alpha + 2',
    '# %%', 'writeLines(\'analyzer-must-not-run\', ' + JSON.stringify(marker) + ')',
  ].join('\n') + '\n';
  const diagnosticHarness = await createHarness(ctx, { id: 'analysis-diagnostic', source: '# %%\nλ <-\n', rscript: requireRscript(ctx) });
  try {
    await waitForExecutionReady(diagnosticHarness);
    const diagnosticSnapshot = await snapshot(diagnosticHarness);
    const syntaxDiagnostic = diagnosticSnapshot.cells[0].diagnostics.find(diagnostic => diagnostic.code === 'syntax-error');
    assert.ok(syntaxDiagnostic, `Unicode parse diagnostic must be reported: ${JSON.stringify(diagnosticSnapshot.cells[0].diagnostics)}`);
    assert.equal(syntaxDiagnostic.range ?? null, null, 'unprojectable parser positions must use null-range semantics');
    assert.match(syntaxDiagnostic.message, /λ/, 'syntax diagnostic must retain the Unicode source context');
  } finally {
    await diagnosticHarness.close();
  }
  const staticHarness = await createHarness(ctx, { id: 'analysis-static', source, rscript: requireRscript(ctx) });
  try {
    await waitForExecutionReady(staticHarness);
    const initial = await snapshot(staticHarness);
    assert.equal(initial.runtime.analyzerState, 'ready');
    assert.equal(initial.runtime.executionReady, true);
    assert.equal(typeof initial.runtime.analysisEnvironmentId, 'string');
    assert.deepEqual(initial.cells[0].defs, ['alpha']);
    assert.deepEqual(initial.cells[1].refs, ['alpha']);
    assert.deepEqual(Object.keys(initial.graph).sort(), ['cycles', 'duplicates', 'edges', 'nodes', 'reverseEdges', 'topologicalOrder']);
    assert.deepEqual([...initial.graph.nodes].sort(), initial.cells.map(cell => cell.id).sort());
    assert.deepEqual(initial.graph.cycles, []);
    assert.deepEqual(initial.graph.duplicates, {});
    assert.equal(initial.graph.topologicalOrder !== null, true);
    assert.equal(initial.cells[2].analysisPending, false);
    const markerCheck = await staticHarness.request('/api/identity', { method: 'GET', cookie: staticHarness.session.cookie, csrf: staticHarness.session.csrf });
    assert.equal(typeof markerCheck.processNonce, 'string');
    assert.ok(markerCheck.processNonce.length > 0);
    const run = await issue(staticHarness, {
      type: 'run', scope: 'cell', target: { cellId: initial.cells[1].id }, expectedDocumentRevision: initial.documentRevision,
    });
    assert.equal(run.status, 'done', JSON.stringify(run));
    let afterRun = await snapshot(staticHarness);
    const outputs = afterRun.cells.slice(0, 2).flatMap(cell => cell.outputs).map(output => JSON.stringify(output)).join('\n');
    assert.equal(outputs.includes('40'), true);
    assert.equal(outputs.includes('42'), true);
    await assert.rejects(access(marker));

    const barrierEdit = await issue(staticHarness, {
      type: 'transaction', expectedDocumentRevision: afterRun.documentRevision,
      changes: [{ type: 'edit', cell: { cellId: afterRun.cells[2].id }, expectedRevision: afterRun.cells[2].revision, cellType: 'code', body: ["source('dynamic-analysis-fixture.R')"] }],
    });
    assert.equal(barrierEdit.status, 'done', JSON.stringify(barrierEdit));
    afterRun = await waitFor(staticHarness, value => value.cells[2].revision === 1 && value.cells[2].diagnostics.some(diagnostic => diagnostic.code === 'opaque-dependency'));
    assert.equal(afterRun.cells[2].barrier, true, 'literal source() must be an explicit conservative barrier');

    const concurrentSource = [
      '# %%', 'Sys.sleep(5)', 'alpha <- 40', 'alpha',
      '# %%', 'alpha + 2',
      '# %%', "z <- 'λ'", 'z',
    ].join('\n') + '\n';
    const concurrentHarness = await createHarness(ctx, { id: 'analysis-concurrent', source: concurrentSource, rscript: requireRscript(ctx) });
    try {
      await waitForExecutionReady(concurrentHarness);
      const before = await snapshot(concurrentHarness);
      const first = before.cells[0];
      const second = before.cells[1];
      assert.ok(first && second);
      const command = {
        type: 'run', scope: 'cell', target: { cellId: first.id }, expectedDocumentRevision: before.documentRevision,
        operationId: randomUUID(), clientId: concurrentHarness.session.clientId,
        commandSequence: concurrentHarness.session.nextCommandSequence++, sessionEpoch: concurrentHarness.session.epoch,
      };
      const admission = await concurrentHarness.command(command);
      assert.deepEqual(Object.keys(admission).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
      assert.equal(admission.accepted, true, JSON.stringify(admission));
      assert.equal(admission.operationId, command.operationId);
      await waitFor(concurrentHarness, value => value.runtime.busy === true && value.cells[0].status === 'running');
      const editStarted = Date.now();
      const edited = await issue(concurrentHarness, {
        type: 'transaction', expectedDocumentRevision: before.documentRevision,
        changes: [{ type: 'edit', cell: { cellId: second.id }, expectedRevision: second.revision, cellType: 'code', body: ['alpha + 3'] }],
      });
      assert.equal(edited.status, 'done', JSON.stringify(edited));
      const analyzed = await waitFor(concurrentHarness, value => value.cells[1].revision === 1 && value.cells[1].analysisPending === false, 4_500);
      assert.ok(Date.now() - editStarted < 4_500);
      const running = await waitTerminal(concurrentHarness, admission.operationId);
      assert.equal(running.status, 'done', JSON.stringify(running));
      const rerun = await issue(concurrentHarness, { type: 'run', scope: 'cell', target: { cellId: analyzed.cells[1].id }, expectedDocumentRevision: analyzed.documentRevision });
      assert.equal(rerun.status, 'done', JSON.stringify(rerun));
      const finished = await snapshot(concurrentHarness);
      const finishedOutput = finished.cells[1].outputs.map(output => JSON.stringify(output)).join('\n');
      assert.equal(finishedOutput.includes('43'), true);

      return {
        id: 'analysis',
        identity: {
          artifact: { sourceCommit: ctx.manifest.sourceCommit, hostProtocol: ctx.manifest.hostProtocol, engineProtocol: ctx.manifest.engineProtocol },
          analyzer: { environmentId: finished.runtime.analysisEnvironmentId, state: finished.runtime.analyzerState, rVersion: finished.runtime.rEnvironment?.version, rscript: concurrentHarness.selectedR },
          runtime: { kernelEpoch: finished.runtime.kernelEpoch, executionReady: finished.runtime.executionReady, concurrentDiagnosticsBeforeSleep: true },
        },
      };
    } finally {
      await concurrentHarness.close();
    }
  } finally {
    await staticHarness.close();
  }
}

function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string');
  assert.equal(ctx.rscript.startsWith('/'), true);
  return ctx.rscript;
}
