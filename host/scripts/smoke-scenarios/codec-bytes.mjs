import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { captureProcessTree, cleanupOwnedProcessTree, cleanupPartialOwner, createHarness, mergeProcessTrees, sanitizedEnvironment, spawnSmokeProcess, stopChild } from './_common.mjs';

const MAX_INVALID_LAUNCH_OUTPUT_BYTES = 64 * 1024;

/**
 * Verify byte preservation through the real staged host.  The fixture contains
 * every line-ending form, a BOM, Unicode, duplicate/unknown options, Markdown
 * tags, and no final newline; all observations are made from disk and HTTP.
 */
export async function run(ctx) {
  const evidence = join(ctx.evidence, 'codec-bytes');
  await mkdir(evidence, { recursive: true });
  const source = [
    '\ufeff# ---\r\n',
    '# title: Café\n',
    '# nested:\r',
    '#   answer: 42\r\n',
    '# ---\n',
    '# preamble without a final newline\r\n',
    '# %%\r\n',
    '#| echo: true\n',
    '#| echo: false\r',
    '#| unknown-option: naïve\r\n',
    'x <- "héllo"\n',
    '# %% [markdown]\r\n',
    '# Markdown café\r',
    '# second line\n',
    '# %%\n',
    'y <- 2',
  ].join('');
  const harness = await createHarness(ctx, { id: 'codec-bytes-main', source, rscript: requireRscript(ctx) });
  try {
    const beforeBytes = await readFile(harness.notebook);
    assert.deepEqual(Buffer.from(source), beforeBytes, 'fixture bytes must reach the staged host unchanged');
    const initial = await harness.snapshot();
    assert.equal(initial.path, harness.canonical);
    assert.equal(initial.cells.length, 3);
    assert.equal(initial.cells[0].options.echo, false, 'duplicate option resolution must be deterministic');
    assert.equal(initial.cells[0].options['unknown-option'], 'naïve');
    assert.equal(initial.cells[1].type, 'markdown');
    assert.equal(initial.dirty, false);

    const noOp = await nextCommand(harness, { type: 'save', expectedDocumentRevision: initial.documentRevision });
    const noOpOperation = await settle(harness, operationId(noOp));
    const noOpDetails = JSON.stringify({
      status: noOpOperation.status,
      error: noOpOperation.error ?? null,
      result: noOpOperation.result ?? null,
    });
    assert.equal(noOpOperation.status, 'done', 'no-op save operation failed: ' + noOpDetails.slice(0, 4096));
    const noOpBytes = await readFile(harness.notebook);
    assert.deepEqual(noOpBytes, beforeBytes, 'open/save with no source change must be byte-identical');
    assert.equal((await harness.snapshot()).documentRevision, initial.documentRevision);

    const first = initial.cells[0];
    const changed = await nextCommand(harness, {
      type: 'transaction', expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'text-edit', cell: { cellId: first.id }, expectedRevision: first.revision,
        edits: [{ start: { line: 0, character: 11 }, end: { line: 0, character: 11 }, text: ' world' }],
      }],
    });
    const changedOperation = await settle(harness, operationId(changed));
    assert.equal(changedOperation.status, 'done');
    const dirty = await harness.snapshot();
    assert.equal(dirty.documentRevision, initial.documentRevision + 1);
    assert.equal(dirty.dirty, true);
    const actualBody = dirty.cells[0].body.join('\n');
    assert.equal(actualBody.includes('x <- "héllo world"'), true, 'targeted UTF-16 edit body: ' + actualBody.slice(0, 512));
    assert.equal(dirty.cells[1].body.join('\n'), initial.cells[1].body.join('\n'));

    const saved = await nextCommand(harness, { type: 'save', expectedDocumentRevision: dirty.documentRevision });
    assert.equal((await settle(harness, operationId(saved))).status, 'done');
    const afterBytes = await readFile(harness.notebook);
    assert.equal(afterBytes[0], 0xef, 'UTF-8 BOM must survive a targeted edit');
    assert.equal(afterBytes[1], 0xbb);
    assert.equal(afterBytes[2], 0xbf);
    const beforeText = Buffer.from(beforeBytes).toString('utf8');
    const afterText = Buffer.from(afterBytes).toString('utf8');
    assert.equal(afterText.includes('# Markdown café\r# second line\n'), true, 'untouched Markdown physical EOLs must survive');
    assert.equal(afterText.endsWith('y <- 2'), true, 'no-final-newline policy must survive');
    assert.equal(afterText.includes('#| echo: true\n#| echo: false\r'), true, 'untouched duplicate option records must survive');
    const expectedBytes = Buffer.from(source.replace('x <- "héllo"', 'x <- "héllo world"'));
    assert.deepEqual(afterBytes, expectedBytes, 'only the targeted physical record may change');
    assert.notEqual(afterText, beforeText);
    const afterSave = await harness.snapshot();
    assert.deepEqual(afterSave.cells.map(cell => cell.id), initial.cells.map(cell => cell.id), 'save must retain cell identities');

    const malformed = await malformedInput(ctx, evidence, 'invalid-utf8.R', 'invalid_utf8', Uint8Array.from([0x23, 0x20, 0xff, 0x0a]));
    const nul = await malformedInput(ctx, evidence, 'embedded-nul.R', 'embedded_nul', Uint8Array.from([0x23, 0x20, 0x25, 0x25, 0x0a, 0x00]));
    assert.equal(malformed.unchanged, true);
    assert.equal(nul.unchanged, true);

    await writeFile(join(evidence, 'before.bin'), beforeBytes);
    await writeFile(join(evidence, 'after.bin'), afterBytes);
    return {
      id: 'codec-bytes',
      identity: {
        launcher: join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher),
        canonicalPath: harness.canonical,
        cells: initial.cells.map(cell => ({ id: cell.id, type: cell.type, revision: cell.revision })),
        byteLengthBefore: beforeBytes.byteLength,
        byteLengthAfter: afterBytes.byteLength,
      },
      noOpByteEquality: true,
      targetedPhysicalChange: true,
      malformed,
      nul,
      evidence,
    };
  } finally {
    await harness.close();
  }
}

async function malformedInput(ctx, evidence, name, expectedCode, bytes) {
  const path = join(evidence, name);
  await writeFile(path, bytes);
  const original = await readFile(path);
  const canonical = await realpath(path);
  const dataHome = join(evidence, 'invalid-data', name);
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  const registryPath = join(runtimeDirectory, createHash('sha256').update(canonical).digest('hex') + '.json');
  const cwd = join(evidence, 'invalid-cwd', name);
  const env = sanitizedEnvironment({
    HOME: join(evidence, 'invalid-home', name),
    XDG_CONFIG_HOME: join(evidence, 'invalid-config', name),
    XDG_DATA_HOME: dataHome,
  });
  await mkdir(cwd, { recursive: true });
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const child = spawnSmokeProcess(launcher, [path, '--headless', '--no-run', '--port', '0', '--rscript', requireRscript(ctx)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stdout = captureBoundedOutput(child.stdout);
  const stderr = captureBoundedOutput(child.stderr);
  const launchTreeBefore = await captureProcessTree(child.pid);
  let launchTreeAtTimeout = [];
  let candidateTreeAtTimeout = [];
  let ownershipAtTimeout = null;
  try {
    const exit = await waitExit(child, 30_000);
    const registryAtTimeout = await readRegistry(registryPath);
    ownershipAtTimeout = ownershipIdentity(registryAtTimeout);
    launchTreeAtTimeout = await captureTreeAfterExit(child.pid, exit);
    candidateTreeAtTimeout = ownershipAtTimeout === null
      ? []
      : await captureProcessTree(ownershipAtTimeout.pid, ownershipAtTimeout.startIdentity);
    const timeoutDiagnostic = JSON.stringify({ registryPath, runtimeDirectory,
      exit: { code: exit.code, signal: exit.signal, timedOut: exit.timedOut },
      owner: ownershipAtTimeout,
      candidateAlive: candidateTreeAtTimeout.length > 0,
      launchTree: launchTreeAtTimeout,
      candidateTree: candidateTreeAtTimeout,
    });
    await writeFile(join(evidence, name + '.stdout'), stdout.text);
    await writeFile(join(evidence, name + '.stderr'), stderr.text);
    await writeFile(join(evidence, name + '.timeout.json'), timeoutDiagnostic.slice(0, 16 * 1024) + '\n');
    assert.equal(exit.timedOut, false, name + ' malformed launch timed out: ' + timeoutDiagnostic.slice(0, 4096));
    assert.equal(exit.error, undefined, name + ' malformed launch failed to spawn: ' + String(exit.error));
    assert.ok(exit.code !== 0 || exit.signal !== null, name + ' must be rejected by the real parser');
    const unchanged = (await readFile(path)).equals(original);
    assert.equal(unchanged, true, name + ' must remain untouched after parse failure');
    assert.equal(stderr.text.includes(expectedCode), true, name + ' must report ' + expectedCode + ': ' + stderr.text.slice(0, 512));
    return {
      path,
      exit: { code: exit.code, signal: exit.signal, timedOut: exit.timedOut },
      ownershipAtTimeout: { owner: ownershipAtTimeout, candidateAlive: candidateTreeAtTimeout.length > 0, launchTree: launchTreeAtTimeout, candidateTree: candidateTreeAtTimeout },
      unchanged,
      stdout: stdout.text,
      stderr: stderr.text,
    };
  } finally {
    const cleanupErrors = [];
    try { await stopChild(child); } catch (error) { cleanupErrors.push(error); }
    const ownedTree = mergeProcessTrees(launchTreeBefore, launchTreeAtTimeout, candidateTreeAtTimeout);
    try { await cleanupOwnedProcessTree(ownedTree); } catch (error) { cleanupErrors.push(error); }
    try { await cleanupPartialOwner(canonical, runtimeDirectory); } catch (error) { cleanupErrors.push(error); }
    try {
      if (await readFile(registryPath).then(() => true).catch(() => false)) cleanupErrors.push(new Error(name + ' malformed launch left an ownership registry'));
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, name + ' malformed launch cleanup failed');
  }
}

async function captureTreeAfterExit(pid, exit) {
  try {
    return await captureProcessTree(pid);
  } catch (error) {
    if (exit.timedOut === false && exit.error === undefined
      && error instanceof Error && error.message === 'owned_process_root_missing:' + pid) return [];
    throw error;
  }
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

async function nextCommand(harness, value) {
  const command = { ...value, operationId: randomUUID(), clientId: harness.session.clientId, commandSequence: harness.session.nextCommandSequence++, sessionEpoch: harness.session.epoch };
  const admission = await harness.command(command);
  assert.deepEqual(Object.keys(admission).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
  assert.equal(admission.epoch, harness.session.epoch);
  assert.equal(admission.clientId, harness.session.clientId);
  assert.equal(admission.operationId, command.operationId);
  assert.equal(admission.operation.id, command.operationId);
  assert.equal(admission.accepted, true);
  assert.equal(admission.error, null);
  return admission;
}
function operationId(admission) { assert.equal(typeof admission.operationId, 'string'); assert.equal(admission.operationId, admission.operation.id); return admission.operationId; }
function requireRscript(ctx) {
  assert.equal(typeof ctx.rscript, 'string');
  assert.equal(ctx.rscript.startsWith('/'), true);
  return ctx.rscript;
}
function snapshotOf(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Number.isSafeInteger(value.documentRevision));
  assert.ok(Number.isSafeInteger(value.cursor));
  return value.result;
}
function captureBoundedOutput(stream) {
  const state = { text: '', bytes: 0, truncated: false };
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    if (state.truncated) return;
    const bytes = Buffer.from(chunk, 'utf8');
    const remaining = MAX_INVALID_LAUNCH_OUTPUT_BYTES - state.bytes;
    if (bytes.byteLength <= remaining) {
      state.text += chunk;
      state.bytes += bytes.byteLength;
      return;
    }
    if (remaining > 0) state.text += bytes.subarray(0, remaining).toString('utf8');
    state.text += '\n[output truncated]\n';
    state.truncated = true;
  });
  return state;
}
async function readRegistry(path) {
  const text = await readFile(path, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function ownershipIdentity(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.pid) || typeof value.startIdentity !== 'string') return null;
  return {
    state: typeof value.state === 'string' ? value.state : null,
    pid: value.pid,
    startIdentity: value.startIdentity,
    processNonce: typeof value.processNonce === 'string' ? value.processNonce : null,
    epoch: typeof value.epoch === 'string' ? value.epoch : null,
    canonicalPath: value.canonicalPath === null || typeof value.canonicalPath === 'string' ? value.canonicalPath : null,
    origin: typeof value.origin === 'string' ? value.origin : null,
    protocol: typeof value.protocol === 'string' ? value.protocol : null,
  };
}
function waitExit(child, timeout) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish({ code: child.exitCode, signal: 'timeout', timedOut: true }), timeout);
    timer.unref?.();
    child.once('exit', (code, signal) => finish({ code, signal, timedOut: false }));
    child.once('error', error => finish({ code: child.exitCode, signal: null, timedOut: false, error }));
  });
}
