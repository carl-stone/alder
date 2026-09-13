import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { createHarness, redact } from './_common.mjs';

const MAX_ID_BYTES = 256;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_SOURCE_LINE_BYTES = 1_048_576;
const HTTP_JSON_LIMIT = 1_048_576;
const WEBSOCKET_MESSAGE_LIMIT = 128 * 1024 * 1024;

export async function run(ctx) {
  let harness;
  try {
    harness = await createHarness(ctx, {
      id: 'protocol-bounds',
      source: '# %%\nprotocol_value <- 4\nprotocol_value\n',
      rscript: requireRscript(ctx),
    });
    const initial = await harness.snapshot();
    const cellsAtLimit = snapshotOf(await harness.query({ type: 'cells', offset: 0, limit: 1_000 }));
    assert.ok(Array.isArray(cellsAtLimit), 'the maximum valid cell query limit must be accepted');

    const queryOverflow = await rawPost(harness, '/api/query', { type: 'cells', offset: 0, limit: 1_001 });
    assertHttpError(queryOverflow, 'invalid_request');

    const idOverflow = await rawPost(harness, '/api/command', {
      operationId: 'i'.repeat(MAX_ID_BYTES + 1),
      clientId: harness.session.clientId,
      commandSequence: harness.session.nextCommandSequence,
      sessionEpoch: harness.session.epoch,
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [],
    });
    assertHttpError(idOverflow, 'invalid_request');

    const pathOverflow = await rawPost(harness, '/api/command', {
      operationId: randomUUID(),
      clientId: harness.session.clientId,
      commandSequence: harness.session.nextCommandSequence,
      sessionEpoch: harness.session.epoch,
      type: 'save-as',
      path: 'p'.repeat(MAX_PATH_BYTES + 1),
      expectedDestination: 'absent',
      expectedDocumentRevision: initial.documentRevision,
    });
    assertHttpError(pathOverflow, 'invalid_request');

    const longLine = 's'.repeat(MAX_SOURCE_LINE_BYTES + 1);
    const sourceOverflowCommand = {
      operationId: randomUUID(),
      clientId: harness.session.clientId,
      commandSequence: harness.session.nextCommandSequence,
      sessionEpoch: harness.session.epoch,
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: initial.cells[0].id },
        expectedRevision: initial.cells[0].revision,
        body: [longLine],
        cellType: initial.cells[0].type,
      }],
    };
    const sourceOverflowWire = harness.wire.encodeHostCommandWire(sourceOverflowCommand);
    assertWireSource(sourceOverflowWire.changes[0].body, 1);
    const sourceOverflow = await rawPost(harness, '/api/command', sourceOverflowWire);
    assertHttpError(sourceOverflow, 'invalid_request');

    const duplicateKeys = await rawPostBytes(harness, '/api/query', Buffer.from('{"type":"cells","offset":0,"limit":1,"limit":2}', 'utf8'));
    assertHttpError(duplicateKeys, 'invalid_request');
    const duplicateEscapedKeys = await rawPostBytes(harness, '/api/query', Buffer.from('{"type":"cells","offset":0,"limit":1,"\\u006cimit":2}', 'utf8'));
    assertHttpError(duplicateEscapedKeys, 'invalid_request');
    const invalidUtf8 = await rawPostBytes(harness, '/api/query', Uint8Array.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 99, 101, 108, 108, 115, 34, 44, 34, 111, 102, 102, 115, 101, 116, 34, 58, 0xff, 125]));
    assertHttpError(invalidUtf8, 'invalid_request');
    const unpairedSurrogate = await rawPostBytes(harness, '/api/query', Buffer.from('{"type":"cells","offset":0,"limit":1,"x":"\\ud800"}', 'utf8'));
    assertHttpError(unpairedSurrogate, 'invalid_request');
    const depth65 = `{"type":"cells","offset":0,"limit":1,"x":${'['.repeat(65)}0${']'.repeat(65)}}`;
    const depthOverflow = await rawPostBytes(harness, '/api/query', Buffer.from(depth65, 'utf8'));
    assertHttpError(depthOverflow, 'invalid_request');
    const finiteOverflow = await rawPostBytes(harness, '/api/command', Buffer.from(`{"operationId":"${randomUUID()}","clientId":"${harness.session.clientId}","commandSequence":1e20,"sessionEpoch":"${harness.session.epoch}","type":"transaction","expectedDocumentRevision":0,"changes":[]}`, 'utf8'));
    assertHttpError(finiteOverflow, 'invalid_request');
    const v1Alias = await rawPost(harness, '/api/query', { protocolVersion: 1, type: 'cells', offset: 0, limit: 1 });
    assertHttpError(v1Alias, 'invalid_request');
    const forgedEpoch = await rawPost(harness, '/api/command', {
      operationId: randomUUID(),
      clientId: harness.session.clientId,
      commandSequence: harness.session.nextCommandSequence,
      sessionEpoch: randomUUID(),
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [],
    });
    assertHttpError(forgedEpoch, 'session_epoch_mismatch');
    const unsafeCounter = await rawPost(harness, '/api/command', {
      operationId: randomUUID(),
      clientId: harness.session.clientId,
      commandSequence: Number.MAX_SAFE_INTEGER,
      sessionEpoch: harness.session.epoch,
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [],
    });
    assertRejectedCommand(unsafeCounter, 'command_sequence_exhausted');
    const forgedMime = await rawPost(harness, '/api/query', { type: 'cells', offset: 0, limit: 1 }, { contentType: 'text/plain' });
    assertHttpError(forgedMime, 'unsupported_media_type');
    const lspUnsupported = await rawPost(harness, '/api/lsp', { method: 'not-supported', params: {} });
    assertHttpError(lspUnsupported, 'invalid_request');
    const logOverflow = await rawPost(harness, '/api/log', { level: 'warn', message: 'x'.repeat(8_193) });
    assertHttpError(logOverflow, 'invalid_request');
    const requestBudget = await rawPostBytes(harness, '/api/query', Buffer.from(`{"type":"cells","offset":0,"limit":1}${' '.repeat(HTTP_JSON_LIMIT)}`, 'utf8'));
    assertHttpError(requestBudget, 'payload_too_large');

    const websocketPong = await websocketProbe(harness, socket => socket.send(JSON.stringify({ type: 'ping' })), value => value.type === 'pong');
    assert.equal(websocketPong.recovery.type, 'recovery');
    assert.equal(websocketPong.messages.some(value => value.type === 'pong'), true);
    const websocketBinary = await websocketProbe(harness, socket => socket.send(Buffer.from([0xff])), value => value.type === 'error');
    assert.equal(websocketBinary.error.error.code, 'invalid_request');
    assert.equal(websocketBinary.closeCode, 1007);
    const websocketDuplicate = await websocketProbe(harness, socket => socket.send(Buffer.from('{"type":"ping","type":"pong"}', 'utf8')), value => value.type === 'error');
    assert.equal(websocketDuplicate.error.error.code, 'invalid_request');
    assert.equal(websocketDuplicate.closeCode, 1007);
    const websocketOversize = await websocketOversizeProbe(harness);
    assert.equal(websocketOversize.closeCode, 1009);
    assert.equal(websocketOversize.payloadBytes, WEBSOCKET_MESSAGE_LIMIT + 1);
    assert.ok(websocketOversize.fragments > 1);
    assert.ok(Number.isSafeInteger(websocketOversize.rssDelta) && websocketOversize.rssDelta >= 0);

    const httpSource = ['protocol_value <- 5\t# HTTP', 'protocol_value'];
    const httpCommand = {
      operationId: randomUUID(),
      clientId: harness.session.clientId,
      commandSequence: harness.session.nextCommandSequence++,
      sessionEpoch: harness.session.epoch,
      type: 'transaction',
      expectedDocumentRevision: initial.documentRevision,
      changes: [{
        type: 'text-edit',
        cell: { cellId: initial.cells[0].id },
        expectedRevision: initial.cells[0].revision,
        edits: [{
          start: { line: 0, character: 0 },
          end: { line: 0, character: initial.cells[0].body[0].length },
          text: httpSource[0],
        }],
      }],
    };
    const httpWire = harness.wire.encodeHostCommandWire(httpCommand);
    assertWireSource(httpWire.changes[0].edits[0].text, null);
    const httpPositive = await rawPost(harness, '/api/command', httpWire);
    assertRawCommandAccepted(httpPositive, httpCommand);
    const httpOperation = await harness.awaitOperation(httpCommand.operationId);
    assert.equal(httpOperation.status, 'done', JSON.stringify(httpOperation));
    const afterHttp = await harness.snapshot();
    assert.deepEqual(afterHttp.cells[0].body, httpSource);

    const websocketSource = ['protocol_value <- 6\t# WebSocket', 'protocol_value'];
    const websocketCommand = {
      operationId: randomUUID(),
      clientId: harness.session.clientId,
      commandSequence: harness.session.nextCommandSequence++,
      sessionEpoch: harness.session.epoch,
      type: 'transaction',
      expectedDocumentRevision: afterHttp.documentRevision,
      changes: [{
        type: 'edit',
        cell: { cellId: afterHttp.cells[0].id },
        expectedRevision: afterHttp.cells[0].revision,
        body: websocketSource,
        cellType: afterHttp.cells[0].type,
      }],
    };
    const websocketWire = harness.wire.encodeHostCommandWire(websocketCommand);
    assertWireSource(websocketWire.changes[0].body, websocketSource.length);
    const websocketSourceResult = await websocketProbe(
      harness,
      socket => socket.send(JSON.stringify({ type: 'command', sequence: websocketCommand.commandSequence, command: websocketWire })),
      value => value.type === 'commandResult' && value.sequence === websocketCommand.commandSequence,
    );
    assert.equal(websocketSourceResult.recovery.type, 'recovery');
    const websocketCommandResult = websocketSourceResult.messages.find(value => value.type === 'commandResult' && value.sequence === websocketCommand.commandSequence);
    assert.ok(websocketCommandResult, JSON.stringify(websocketSourceResult));
    assertRawCommandAccepted({ status: 200, ok: true, value: websocketCommandResult.result }, websocketCommand);
    const websocketOperation = await harness.awaitOperation(websocketCommand.operationId);
    assert.equal(websocketOperation.status, 'done', JSON.stringify(websocketOperation));
    const afterWebsocket = await harness.snapshot();
    assert.deepEqual(afterWebsocket.cells[0].body, websocketSource);

    const hostEntry = join(ctx.applicationRoot, ctx.manifest.resources.hostEntry);
    const hostEntryBytes = await readFile(hostEntry);
    const hostEntryInfo = await stat(hostEntry);
    const evidence = {
      protocol: 'alder-host-v2',
      valid: {
        cellsLimit: 1_000,
        returnedCells: cellsAtLimit.length,
        httpSource: { lines: httpSource.length, controlByte: httpSource[0].includes('\t'), documentRevision: afterHttp.documentRevision },
        websocketSource: { lines: websocketSource.length, controlByte: websocketSource[0].includes('\t'), documentRevision: afterWebsocket.documentRevision },
      },
      rejected: {
        queryLimit: summarize(queryOverflow),
        identifier: summarize(idOverflow),
        path: summarize(pathOverflow),
        sourceLine: summarize(sourceOverflow),
        duplicateKeys: summarize(duplicateKeys),
        duplicateEscapedKeys: summarize(duplicateEscapedKeys),
        invalidUtf8: summarize(invalidUtf8),
        unpairedSurrogate: summarize(unpairedSurrogate),
        depth: summarize(depthOverflow),
        finite: summarize(finiteOverflow),
        v1Alias: summarize(v1Alias),
        forgedEpoch: summarize(forgedEpoch),
        unsafeCounter: summarize(unsafeCounter),
        forgedMime: summarize(forgedMime),
        lsp: summarize(lspUnsupported),
        log: summarize(logOverflow),
        requestBudget: summarize(requestBudget),
      },
      websocket: {
        binary: { error: websocketBinary.error.error.code, closeCode: websocketBinary.closeCode },
        duplicate: { error: websocketDuplicate.error.error.code, closeCode: websocketDuplicate.closeCode },
        oversize: {
          closeCode: websocketOversize.closeCode,
          limit: WEBSOCKET_MESSAGE_LIMIT,
          payloadBytes: websocketOversize.payloadBytes,
          fragments: websocketOversize.fragments,
          memoryBefore: websocketOversize.memoryBefore,
          peakRss: websocketOversize.peakRss,
          rssDelta: websocketOversize.rssDelta,
        },
      },
      artifact: {
        path: hostEntry,
        bytes: hostEntryInfo.size,
        sha256: digest(hostEntryBytes),
      },
    };
    await writeEvidence(ctx.evidence, evidence);
    return {
      id: 'protocol-bounds',
      identity: {
        artifact: { sourceCommit: ctx.manifest.sourceCommit, hostEntry: evidence.artifact.sha256 },
        packet: {
          protocol: 'alder-host-v2',
          validCellsLimit: evidence.valid.cellsLimit,
          rejected: Object.fromEntries(Object.entries(evidence.rejected).map(([key, value]) => [key, value.status])),
          websocket: evidence.websocket,
        },
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

async function rawPost(harness, path, body, options = {}) {
  return rawPostBytes(harness, path, Buffer.from(JSON.stringify(body), 'utf8'), options);
}

async function rawPostBytes(harness, path, body, { contentType = 'application/json' } = {}) {
  const response = await fetch(new URL(path, harness.origin), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Origin: harness.origin,
      'Content-Type': contentType,
      Cookie: harness.session.cookie,
      'X-CSRF-Token': harness.session.csrf,
    },
    body,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 0, `${path} must return a JSON response`);
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  return { status: response.status, ok: response.ok, value };
}

function assertHttpError(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.status >= 400, true, JSON.stringify(response));
  assert.deepEqual(Object.keys(response.value).sort(), ['error', 'ok']);
  assert.equal(response.value.ok, false);
  assert.deepEqual(Object.keys(response.value.error).sort(), ['code', 'message']);
  assert.equal(response.value.error.code, code, JSON.stringify(response));
}

function assertRejectedCommand(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.status, 409, JSON.stringify(response));
  const value = response.value;
  assert.deepEqual(Object.keys(value).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
  assert.equal(value.accepted, false, JSON.stringify(response));
  assert.equal(value.operation, null, JSON.stringify(response));
  assert.equal(value.sequenceConsumed, false, JSON.stringify(response));
  assert.equal(value.error?.code, code, JSON.stringify(response));
}

function assertWireSource(value, lines) {
  assert.deepEqual(Object.keys(value).sort(), ['data', 'encoding', 'lines']);
  assert.equal(value.encoding, 'base64');
  assert.equal(value.lines, lines);
  assert.equal(typeof value.data, 'string');
  assert.equal(value.data.length % 4, 0, 'WireSource data must use padded base64');
  assert.match(value.data, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
}

function assertRawCommandAccepted(response, command) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.status, 200, JSON.stringify(response));
  const value = response.value;
  assert.deepEqual(Object.keys(value).sort(), ['accepted', 'clientId', 'commandSequence', 'epoch', 'error', 'nextCommandSequence', 'operation', 'operationId', 'sequenceConsumed']);
  assert.equal(value.accepted, true, JSON.stringify(response));
  assert.equal(value.clientId, command.clientId);
  assert.equal(value.commandSequence, command.commandSequence);
  assert.equal(value.operationId, command.operationId);
  assert.equal(value.sequenceConsumed, true);
  assert.equal(value.error, null);
  assert.equal(value.operation?.id, command.operationId);
}

async function websocketProbe(harness, sendPayload, done) {
  const target = new URL('/api/socket', harness.origin);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(target, { origin: harness.origin, headers: { Cookie: harness.session.cookie } });
    const result = { messages: [], recovery: null, error: null, closeCode: null };
    let sent = false;
    let settled = false;
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, 10_000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'connect', protocolVersion: 2, leaseId: harness.session.leaseId, clientId: harness.session.clientId, csrf: harness.session.csrf, epoch: null, cursor: null }));
    });
    socket.on('message', data => {
      try {
        const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(data)));
        result.messages.push(value);
        if (value.type === 'recovery') result.recovery = value;
        if (value.type === 'error') result.error = value;
        if (!sent && (result.recovery !== null || result.error !== null)) {
          sent = true;
          sendPayload(socket);
        }
        if (done(value)) {
          if (value.type !== 'recovery') socket.close();
        }
      } catch (error) {
        reject(error);
        socket.terminate();
      }
    });
    socket.on('close', code => { result.closeCode = code; finish(); });
    socket.on('error', error => { if (!settled && result.error === null) { reject(error); socket.terminate(); } });
  });
}

async function websocketOversizeProbe(harness) {
  const target = new URL('/api/socket', harness.origin);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(target, { origin: harness.origin, headers: { Cookie: harness.session.cookie } });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('websocket_oversize_timeout')); }, 30_000);
    const fragment = Buffer.alloc(64 * 1024, 0x20);
    const memoryBefore = process.memoryUsage().rss;
    let peakRss = memoryBefore;
    let remaining = WEBSOCKET_MESSAGE_LIMIT + 1;
    let payloadBytes = 0;
    let fragments = 0;
    let settled = false;
    let socketError = null;
    const sampleMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sampleMemory();
      resolve({
        closeCode: code,
        error: socketError === null ? null : socketError.message,
        payloadBytes,
        fragments,
        memoryBefore,
        peakRss,
        rssDelta: peakRss - memoryBefore,
      });
    };
    const sendFragment = () => {
      if (settled) return;
      const size = Math.min(fragment.length, remaining);
      const fin = size === remaining;
      try {
        socket._sender.send(fragment.subarray(0, size), { binary: true, compress: false, fin, mask: true }, error => {
          if (error) {
            socketError = error;
            socket.terminate();
            return;
          }
          payloadBytes += size;
          fragments += 1;
          remaining -= size;
          sampleMemory();
          if (remaining > 0) sendFragment();
        });
      } catch (error) {
        socketError = error;
        socket.terminate();
      }
    };
    socket.on('open', sendFragment);
    socket.on('error', error => { socketError = error; });
    socket.on('close', finish);
  });
}

function summarize(response) {
  return { status: response.status, ok: response.ok, body: redact(response.value) };
}

function snapshotOf(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Number.isSafeInteger(value.documentRevision));
  assert.ok(Number.isSafeInteger(value.cursor));
  return value.result;
}

async function writeEvidence(root, value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'protocol-bounds.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
