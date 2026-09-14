import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  cleanupScenarioResources,
  createHarness,
  exchangeTicket,
  openSession,
  redact,
  sanitizedEnvironment,
  spawnSmokeSync,
  fetchLogicalOrigin,
  openLogicalWebSocket,
} from './_common.mjs';
export async function run(ctx) {
  const harness = await createHarness(ctx, {
    id: 'authentication',
    source: ['# %%', 'x <- 40', '# %%', 'x + 2', ''].join('\n'),
  });
  try {
    const baseline = await harness.query({ type: 'notebook' });
    const session = harness.session;
    const missingBearer = await probe(harness.origin, '/api/ticket', {
      method: 'POST', body: { origin: harness.origin },
    });
    assert.ok(missingBearer.status === 401 || missingBearer.status === 403, JSON.stringify(missingBearer));
    const badBearer = await probe(harness.origin, '/api/ticket', {
      method: 'POST', authorization: 'not-a-real-registry-token', body: { origin: harness.origin },
    });
    assert.ok(badBearer.status === 401 || badBearer.status === 403, JSON.stringify(badBearer));

    const noCsrf = await probe(harness.origin, '/api/query', {
      method: 'POST', cookie: session.cookie, body: { type: 'notebook' },
    });
    assert.ok(noCsrf.status === 401 || noCsrf.status === 403, JSON.stringify(noCsrf));
    const identityWithoutCsrf = await probe(harness.origin, '/api/identity', { cookie: session.cookie });
    assert.ok(identityWithoutCsrf.status === 401 || identityWithoutCsrf.status === 403, JSON.stringify(identityWithoutCsrf));
    const noCredentials = await probe(harness.origin, '/api/identity');
    assert.ok(noCredentials.status === 401 || noCredentials.status === 403, JSON.stringify(noCredentials));
    const badOrigin = await probe(harness.origin, '/api/query', {
      method: 'POST', origin: 'https://evil.invalid', cookie: session.cookie, csrf: session.csrf,
      body: { type: 'notebook' },
    });
    assert.equal(badOrigin.status, 403, JSON.stringify(badOrigin));
    const badHost = await probe(harness.origin, '/api/query', {
      method: 'POST', host: 'evil.invalid', cookie: session.cookie, csrf: session.csrf,
      body: { type: 'notebook' },
    });
    assert.equal(badHost.status, 403, JSON.stringify(badHost));
    const nullOrigin = await probe(harness.origin, '/api/query', {
      method: 'POST', origin: 'null', cookie: session.cookie, csrf: session.csrf,
      body: { type: 'notebook' },
    });
    assert.equal(nullOrigin.status, 403, JSON.stringify(nullOrigin));

    const websocket = await unauthorizedWebSocket(harness.origin);
    assert.equal(websocket.recovery, false, JSON.stringify(websocket));
    assert.equal(websocket.commandResult, false, JSON.stringify(websocket));
    const forgedWebSocket = await forgedCsrfWebSocket(harness.origin, session);
    assert.equal(forgedWebSocket.recovery, false, JSON.stringify(forgedWebSocket));

    const second = await openSession(harness.origin, harness.registry);
    try {
      assert.notEqual(second.leaseId, session.leaseId);
      const crossCsrf = await probe(harness.origin, '/api/query', {
        method: 'POST', cookie: second.cookie, csrf: session.csrf, body: { type: 'notebook' },
      });
      assert.ok(crossCsrf.status === 401 || crossCsrf.status === 403, JSON.stringify(crossCsrf));
      const identityA = await harness.request('/api/identity', { cookie: session.cookie, csrf: session.csrf });
      const identityB = await harness.request('/api/identity', { cookie: second.cookie, csrf: second.csrf });
      assert.equal(identityA.epoch, identityB.epoch);
      assert.notEqual(identityA.leaseId, identityB.leaseId);
      assert.notEqual(identityA.clientId, identityB.clientId);
      const heartbeat = await harness.request('/api/lease', {
        method: 'POST', cookie: second.cookie, csrf: second.csrf,
        body: { action: 'heartbeat', leaseId: second.leaseId },
      });
      assert.equal(heartbeat.leaseId, second.leaseId);
    } finally {
      await harness.request('/api/lease', {
        method: 'POST', cookie: second.cookie, csrf: second.csrf,
        body: { action: 'release', leaseId: second.leaseId },
      }).catch(() => undefined);
    }

    const after = await harness.query({ type: 'notebook' });
    assert.deepEqual(withoutTransportProgress(after), withoutTransportProgress(baseline));
    const registryPath = join(harness.dataHome, 'alder-nodejs', 'runtime', `${createHash('sha256').update('path:' + harness.canonical).digest('hex')}.json`);
    const registryInfo = await lstat(registryPath);
    assert.equal(registryInfo.isSymbolicLink(), false);
    assert.equal(registryInfo.mode & 0o777, 0o600);

    const invalidHostNotebook = join(ctx.evidence, 'fixtures', 'authentication-invalid-host.R');
    await mkdir(join(ctx.evidence, 'fixtures'), { recursive: true });
    await writeFile(invalidHostNotebook, '# %%\n1 + 1\n');
    const invalidHost = spawnSmokeSync(join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher), [
      invalidHostNotebook, '--headless', '--no-run', '--host', '0.0.0.0', '--port', '0', '--rscript', harness.selectedR,
    ], { encoding: 'utf8', timeout: 30_000, env: sanitizedEnvironment({ XDG_DATA_HOME: join(ctx.evidence, 'invalid-host-data') }) });
    assert.equal(Number.isInteger(invalidHost.status) && invalidHost.status !== 0, true, 'invalid host must be rejected with a non-zero status');
    assert.equal(invalidHost.signal, null, 'invalid host must not be terminated by a signal');
    assert.doesNotMatch(String(invalidHost.stdout ?? ''), /\"type\"\s*:\s*\"host\.ready\"/, 'invalid host must not publish host.ready');
    assert.match(String(invalidHost.stderr ?? ''), /127\.0\.0\.1|loopback|invalid/i, 'invalid host rejection must identify the rejected bind');

    const evidence = {
      rejected: {
        missingBearer: missingBearer.status,
        badBearer: badBearer.status,
        noCsrf: noCsrf.status,
        noCredentials: noCredentials.status,
        badOrigin: badOrigin.status,
        badHost: badHost.status,
        nullOrigin: nullOrigin.status,
      },
      websocket: { closeCode: websocket.closeCode, recovery: websocket.recovery, commandResult: websocket.commandResult, forgedCsrf: forgedWebSocket.closeCode },
      identity: { epoch: harness.registry.epoch, pid: harness.registry.pid },
      registry: { mode: registryInfo.mode & 0o777, symlink: registryInfo.isSymbolicLink() },
      invalidHost: { status: invalidHost.status, signal: invalidHost.signal },
    };
    await writeFile(join(ctx.evidence, 'authentication.json'), `${JSON.stringify(redact(evidence), null, 2)}\n`);
    return { id: 'authentication', identity: evidence };
  } finally {
    await cleanupScenarioResources(() => harness.close());
  }
 }

function withoutTransportProgress(value) {
  const copy = structuredClone(value);
  delete copy.cursor;
  if (copy.result && typeof copy.result === 'object') delete copy.result.cursor;
  return copy;
}

async function probe(origin, path, { method = 'GET', body, authorization, cookie, csrf, host, origin: requestOrigin = origin } = {}) {
  const headers = { Origin: requestOrigin };
  if (host) headers.Host = host;
  const payload = body === undefined ? null : JSON.stringify(body);
  if (payload !== null) headers['Content-Type'] = 'application/json';
  if (authorization) headers.Authorization = `Bearer ${authorization}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  try {
    let status;
    let bytes;
    if (host) {
      ({ status, bytes } = await rawProbe(new URL(path, origin), method, headers, payload));
    } else {
      const response = await fetchLogicalOrigin(new URL(path, origin), { method, redirect: 'error', headers, body: payload });
      status = response.status;
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    let value = null;
    if (bytes.length) {
      try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
      catch { value = new TextDecoder().decode(bytes); }
    }
    return { status, body: redact(value) };
  } catch (error) {
    return { status: 0, transportError: error instanceof Error ? error.message : String(error) };
  }
}

function rawProbe(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: Number(url.port),
      path: url.pathname + url.search,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, bytes: new Uint8Array(Buffer.concat(chunks)) }));
    });
    request.on('error', reject);
    request.end(body ?? undefined);
  });
}

async function unauthorizedWebSocket(origin) {
  const target = new URL('/api/socket', origin);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return await new Promise((resolve) => {
    const result = { closeCode: null, recovery: false, commandResult: false };
    const socket = openLogicalWebSocket(WebSocket, target, { origin });
    const timer = setTimeout(() => { socket.terminate(); resolve(result); }, 5_000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'command', sequence: 1, command: { type: 'ping' } }));
    });
    socket.on('message', (data) => {
      try {
        const value = JSON.parse(String(data));
        if (value.type === 'recovery') result.recovery = true;
        if (value.type === 'commandResult') result.commandResult = true;
      } catch { /* malformed auth failures are still a rejection */ }
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      result.closeCode = code;
      resolve(result);
    });
    socket.on('error', () => { /* close/error is the expected unauthenticated outcome */ });
  });
}

async function forgedCsrfWebSocket(origin, session) {
  const target = new URL('/api/socket', origin);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return await new Promise((resolve) => {
    const result = { closeCode: null, recovery: false };
    const socket = openLogicalWebSocket(WebSocket, target, { origin, headers: { Cookie: session.cookie } });
    const timer = setTimeout(() => { socket.terminate(); resolve(result); }, 5_000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'connect', protocolVersion: 2, leaseId: session.leaseId, clientId: session.clientId, csrf: 'forged', epoch: null, cursor: null }));
    });
    socket.on('message', (data) => {
      try { if (JSON.parse(String(data)).type === 'recovery') result.recovery = true; } catch { /* rejection may close before a valid frame */ }
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      result.closeCode = code;
      resolve(result);
    });
    socket.on('error', () => { /* forged CSRF is expected to fail closed */ });
  });
}
