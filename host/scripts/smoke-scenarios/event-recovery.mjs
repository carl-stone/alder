import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHarness, delay } from './_common.mjs';

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


function snapshotOf(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Number.isSafeInteger(value.documentRevision));
  assert.ok(Number.isSafeInteger(value.cursor));
  return value.result;
}

export async function run(ctx) {
  const source = [
    "# %%", "x <- 40", "x",
    "# %%", "x + 2",
    "# %%", "message <- 'event recovery'", "message",
  ].join("\n") + "\n";
  const harness = await createHarness(ctx, { id: "event-recovery", source, rscript: requireRscript(ctx) });
  try {
    const baseline = await harness.snapshot();
    const first = baseline.cells[0];
    const second = baseline.cells[1];
    assert.ok(first && second);
    const transaction = await issue(harness, {
      type: "transaction", expectedDocumentRevision: baseline.documentRevision,
      changes: [
        { type: "edit", cell: { cellId: first.id }, expectedRevision: first.revision, cellType: "code", body: ["x <- 41", "x"] },
        { type: "edit", cell: { cellId: second.id }, expectedRevision: second.revision, cellType: "code", body: ["x + 3"] },
      ],
    });
    assert.equal(transaction.status, "done", JSON.stringify(transaction));
    let current = await harness.snapshot();
    assert.equal(current.documentRevision, baseline.documentRevision + 1);
    assert.equal(current.cells[0].body[0], "x <- 41");
    assert.equal(current.cells[1].body[0], "x + 3");

    const replay = snapshotOf(await harness.query({ type: "events", epoch: baseline.epoch, cursor: baseline.cursor }));
    assert.deepEqual(Object.keys(replay).sort(), ["cursor", "epoch", "events", "kind"]);
    assert.equal(replay.kind, "replay", JSON.stringify(replay));
    const transactionEvent = replay.events.find(event => event.type === "transaction");
    assert.ok(transactionEvent);
    assert.equal(transactionEvent.documentRevision, current.documentRevision);
    assert.equal(transactionEvent.payload.updated.length, 2);
    assert.equal(transactionEvent.payload.order.length, current.cells.length);

    const browserHtml = await harness.browser(await harness.mintTicket());
    assert.equal(browserHtml.includes('event recovery'), true);
    assert.equal(browserHtml.includes('x + 3'), true);

    for (let index = 0; index < 1_040; index += 1) {
      const noOp = await issue(harness, { type: "transaction", expectedDocumentRevision: current.documentRevision, changes: [] });
      assert.equal(noOp.status, "done", JSON.stringify(noOp));
    }
    current = await harness.snapshot();
    const expired = snapshotOf(await harness.query({ type: "events", epoch: baseline.epoch, cursor: baseline.cursor }));
    assert.equal(expired.kind, "snapshot", JSON.stringify(expired));
    assert.equal(expired.snapshot.documentRevision, current.documentRevision);
    assert.deepEqual(expired.snapshot.cells.map(cell => cell.body), current.cells.map(cell => cell.body));

    const noBase = snapshotOf(await harness.query({ type: "events", epoch: null, cursor: null }));
    assert.equal(noBase.kind, "snapshot");
    assert.equal(noBase.snapshot.documentRevision, current.documentRevision);
    assert.equal(noBase.snapshot.cells.length, current.cells.length);

    const oldKernel = current.runtime.kernelEpoch;
    const restarted = await issue(harness, { type: "restart", replay: false, expectedDocumentRevision: current.documentRevision });
    assert.equal(restarted.status, "done", JSON.stringify(restarted));
    current = await harness.snapshot();
    assert.notEqual(current.runtime.kernelEpoch, oldKernel);
    assert.equal(current.runtime.kernelState, "ready");
    const postRestart = snapshotOf(await harness.query({ type: "events", epoch: current.epoch, cursor: current.cursor }));
    assert.equal(postRestart.kind, "replay");

    const identity = await harness.request("/api/identity", { method: 'GET', cookie: harness.session.cookie, csrf: harness.session.csrf });
    return {
      id: "event-recovery",
      identity: {
        artifact: { sourceCommit: ctx.manifest.sourceCommit, hostProtocol: ctx.manifest.hostProtocol, engineProtocol: ctx.manifest.engineProtocol },
        runtime: { rscript: harness.selectedR, epoch: current.epoch, kernelEpoch: current.runtime.kernelEpoch, processNonce: identity.processNonce },
        recovery: { matchingBase: "replay", expiredBase: "snapshot", noBase: "snapshot", retainedEventLimit: 2_048 },
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
