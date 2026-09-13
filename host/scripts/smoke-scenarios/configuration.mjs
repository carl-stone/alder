import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';

import { createHarness, delay, redact } from './_common.mjs';

export async function run(ctx) {
  let harness;
  try {
    harness = await createHarness(ctx, {
      id: 'configuration',
      source: '# %%\nconfiguration_value <- 3\nconfiguration_value\n',
      rscript: requireRscript(ctx),
    });
    const initial = await harness.snapshot();
    const patch = {
      theme: 'dark',
      keymap: 'vim',
      on_cell_change: 'lazy',
      on_startup: false,
      editor: { font_size: 16, line_numbers: false },
      table: { page_size: 50 },
    };
    const update = makeCommand(harness, {
      type: 'set-config',
      patch,
      expectedSidecarVersion: initial.sidecars.config.version,
      expectedDocumentRevision: initial.documentRevision,
    });
    const admission = assertAdmission(await harness.command(update), harness, update);
    assert.equal(admission.accepted, true, 'configuration update must be admitted');
    const operation = await waitForTerminal(harness, update.operationId);
    assert.equal(operation.status, 'done', JSON.stringify(operation));

    const after = await harness.snapshot();
    const configQuery = snapshotOf(await harness.query({ type: 'config' }));
    assert.deepEqual(Object.keys(configQuery).sort(), ['effective', 'layers', 'provenance', 'sidecar']);
    const effective = configQuery.effective;
    assert.deepEqual(Object.keys(effective).sort(), ['autosave', 'cache', 'editor', 'format', 'keymap', 'on_cell_change', 'on_startup', 'table', 'theme']);
    assert.equal(effective.theme, 'dark');
    assert.equal(effective.keymap, 'vim');
    assert.equal(effective.on_cell_change, 'lazy');
    assert.equal(effective.on_startup, false);
    assert.equal(effective.editor.font_size, 16);
    assert.equal(effective.editor.line_numbers, false);
    assert.equal(effective.table.page_size, 50);

    const sidecarPath = join(dirname(harness.notebook), '.alder', 'config.yaml');
    const sidecarBytes = await readFile(sidecarPath);
    const sidecarInfo = await stat(sidecarPath);
    assert.equal(sidecarInfo.isFile(), true);
    const sidecarDocument = parseDocument(sidecarBytes.toString('utf8'), { uniqueKeys: true });
    assert.equal(sidecarDocument.errors.length, 0, 'written config must be valid YAML');
    const sidecarConfig = sidecarDocument.toJS();
    assert.deepEqual(sidecarConfig, patch, 'sidecar must contain exactly the validated project overlay');
    assert.equal(after.sidecars.config.state, 'present');
    assert.equal(after.sidecars.config.digest, digest(sidecarBytes));
    assert.equal(typeof after.sidecars.config.version, 'string');

    const invalid = makeCommand(harness, {
      type: 'set-config',
      patch: { editor: { font_size: 99 } },
      expectedSidecarVersion: after.sidecars.config.version,
      expectedDocumentRevision: after.documentRevision,
    });
    const invalidAdmission = assertAdmission(await harness.command(invalid), harness, invalid);
    assert.equal(invalidAdmission.accepted, true, 'invalid configuration reaches host validation');
    const invalidOperation = await waitForTerminal(harness, invalid.operationId);
    assert.equal(invalidOperation.status, 'error', JSON.stringify(invalidOperation));
    assert.equal(invalidOperation.error.code, 'config_invalid', JSON.stringify(invalidOperation));
    const unchangedSidecar = await readFile(sidecarPath);
    assert.deepEqual(unchangedSidecar, sidecarBytes, 'invalid configuration must not replace the sidecar');
    const afterInvalid = await harness.snapshot();
    assert.equal(afterInvalid.documentRevision, after.documentRevision);
    assert.deepEqual(snapshotOf(await harness.query({ type: 'config' })).effective, effective);

    const evidence = {
      protocol: 'alder-host-v2',
      sidecar: { path: sidecarPath, digest: digest(sidecarBytes), bytes: sidecarBytes.byteLength },
      patch,
      effective: redact(effective),
      operation: redact(operation),
      invalidOperation: redact(invalidOperation),
      documentRevision: after.documentRevision,
    };
    await writeEvidence(ctx.evidence, evidence);
    const runtime = await identity(harness);
    return {
      id: 'configuration',
      identity: {
        artifact: { sourceCommit: ctx.manifest.sourceCommit, hostProtocol: ctx.manifest.hostProtocol, engineProtocol: ctx.manifest.engineProtocol, launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher) },
        source: { sidecar: sidecarPath, digest: evidence.sidecar.digest },
        runtime: { epoch: runtime.epoch, processNonce: runtime.processNonce },
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
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const current = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (['done', 'error', 'cancelled', 'interrupted'].includes(current.status)) return current;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await delay(100);
  }
}

async function identity(harness) {
  return harness.request('/api/identity', { method: 'GET', cookie: harness.session.cookie, csrf: harness.session.csrf });
}

async function writeEvidence(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'configuration.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
