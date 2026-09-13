import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import {
  cleanupScenarioResources,
  createHarness,
  mintTicket,
  redact,
  sanitizedEnvironment,
  spawnSmokeProcess,
  spawnSmokeSync,
  stopChild,
} from './_common.mjs';
export async function run(ctx) {
  const proxyPort = await reservePort();
  const external = `https://localhost:${proxyPort}`;
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(ctx.evidence, 'remote-token');
  await writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const harness = await createHarness(ctx, {
    id: 'remote-https',
    source: ['# %%', 'x <- 40', '# %%', 'x + 2', ''].join('\n'),
    args: ['--external-origin', external, '--token-file', tokenFile],
  });
  assert.equal(harness.registry.token, token);
  let proxy;
  try {
    const tls = await createCertificate(ctx.evidence);
    proxy = await startCaddy(harness.origin, tls, proxyPort, ctx.evidence);
    const ticketProbe = await httpsJson(external, '/api/ticket', {
      method: 'POST', authorization: harness.registry.token, body: { origin: external },
    });
    assert.equal(ticketProbe.status, 200, JSON.stringify(redact(ticketProbe.body)));
    assert.equal(typeof ticketProbe.body.ticket, 'string');
    const ticket = ticketProbe.body.ticket;
    const exchange = await httpsJson(external, '/api/session', {
      method: 'POST', body: { ticket },
    });
    assert.equal(exchange.status, 200, JSON.stringify(redact(exchange.body)));
    const cookie = exchange.headers['set-cookie']?.[0]?.split(';', 1)[0];
    assert.ok(cookie);
    const setCookie = exchange.headers['set-cookie']?.[0] ?? '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Secure/i);

    const stateResponse = await httpsJson(external, '/api/query', {
      method: 'POST', cookie, csrf: exchange.body.csrf, body: { type: 'notebook' },
    });
    assert.equal(stateResponse.status, 200, JSON.stringify(redact(stateResponse.body)));
    const state = stateResponse.body.result ?? stateResponse.body;
    const editOperationId = randomUUID();
    const editResponse = await httpsJson(external, '/api/command', {
      method: 'POST', cookie, csrf: exchange.body.csrf,
      body: {
        type: 'transaction', expectedDocumentRevision: state.documentRevision,
        changes: [{ type: 'edit', cell: { cellId: state.cells[0].id }, expectedRevision: state.cells[0].revision, body: encodeWireLines(['x <- 41']), cellType: state.cells[0].type }],
        operationId: editOperationId, clientId: exchange.body.clientId, commandSequence: exchange.body.nextCommandSequence, sessionEpoch: exchange.body.epoch,
      },
    });
    assert.equal(editResponse.status, 200, JSON.stringify(redact(editResponse.body)));
    const editResult = await waitForHttpsOperation(external, exchange.body.csrf, cookie, editOperationId, exchange.body.clientId);
    assert.equal(editResult.status, 'done', JSON.stringify(redact(editResult)));
    const after = await httpsJson(external, '/api/query', {
      method: 'POST', cookie, csrf: exchange.body.csrf, body: { type: 'cell', cellId: state.cells[0].id },
    });
    const source = after.body?.result?.body;
    assert.ok(source && typeof source === 'object' && source.encoding === 'base64' && typeof source.data === 'string');
    assert.match(Buffer.from(source.data, 'base64').toString('utf8'), /x\s*<-\s*41/);

    const browser = await runBrowser(external, await mintViaHttps(external, harness.registry.token, external), ctx.evidence);
    assert.match(browser, /x\s*<-\s*41/);
    const badHost = await httpsJson(external, '/api/query', {
      method: 'POST', host: `evil.invalid:${proxyPort}`, cookie, csrf: exchange.body.csrf, body: { type: 'notebook' },
    });
    assert.equal(badHost.status, 403);
    const badOrigin = await httpsJson(external, '/api/query', {
      method: 'POST', origin: 'https://evil.invalid', cookie, csrf: exchange.body.csrf, body: { type: 'notebook' },
    });
    assert.equal(badOrigin.status, 403);

    const proxyPid = proxy.pid;
    await proxy.close();
    proxy = undefined;
    const certDigest = createHash('sha256').update(await readFile(tls.cert)).digest('hex');
    const identity = {
      protocol: 'alder-host-v2',
      externalOrigin: external,
      backendOrigin: harness.origin,
      tls: { certificateSha256: certDigest, proxy: 'caddy', proxyPid },
      cookie: { secure: true, httpOnly: true, sameSite: 'Strict' },
      effect: 'transaction-edit-over-https',
      badHost: badHost.status,
      badOrigin: badOrigin.status,
      pid: harness.registry.pid,
    };
    await writeFile(join(ctx.evidence, 'remote-https.json'), `${JSON.stringify(redact(identity), null, 2)}\n`);
    return { id: 'remote-https', identity };
  } finally {
    await cleanupScenarioResources(() => proxy?.close(), () => harness.close());
  }
}

async function reservePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function createCertificate(evidence) {
  const directory = join(evidence, 'tls');
  await mkdir(directory, { recursive: true });
  const key = join(directory, 'localhost.key');
  const cert = join(directory, 'localhost.crt');
  const generated = spawnSmokeSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert,
  ], { encoding: 'utf8', timeout: 30_000, env: sanitizedEnvironment() });
  if (generated.status !== 0) throw new Error(`openssl failed: ${generated.stderr}`);
  return { key, cert };
}

async function startCaddy(backend, tls, port, evidence) {
  const directory = join(evidence, 'caddy');
  await mkdir(directory, { recursive: true });
  const config = join(directory, 'Caddyfile');
  const backendUrl = new URL(backend);
  await writeFile(config, [
    '{',
    '  auto_https off',
    '  admin off',
    '}',
    `https://:${port} {`,
    `  tls ${JSON.stringify(tls.cert)} ${JSON.stringify(tls.key)}`,
    '  handle /__alder_proxy_health {',
    '    respond 204',
    '  }',
    '  handle {',
    `    reverse_proxy http://${backendUrl.hostname}:${backendUrl.port} {`,
    '      header_up Host {http.request.hostport}',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'));
  const validation = spawnSmokeSync('caddy', ['validate', '--config', config, '--adapter', 'caddyfile'], { encoding: 'utf8', timeout: 30_000, env: sanitizedEnvironment(), windowsHide: true });
  if (validation.error || validation.status !== 0) {
    throw new Error(`caddy_validate_failed: ${validation.error?.message ?? validation.stderr ?? 'unknown validation failure'}`);
  }
  const child = spawnSmokeProcess('caddy', ['run', '--config', config, '--adapter', 'caddyfile'], {
    cwd: directory,
    env: sanitizedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await waitForCaddy(`https://localhost:${port}`, child);
  } catch (error) {
    await stopProcess(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; caddy_stderr=${stderr.trim()}`, { cause: error });
  }
  return {
    pid: child.pid,
    close: () => stopProcess(child),
  };
}

async function waitForCaddy(origin, child) {
  const target = new URL(origin);
  const probeOrigin = `https://127.0.0.1:${target.port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`caddy_exited: ${child.exitCode}`);
    try {
      const response = await httpsJson(probeOrigin, '/__alder_proxy_health', { method: 'GET', host: target.host, origin: target.origin });
      if (response.status === 204) return;
    } catch {
      // Caddy may need a few milliseconds to bind its listener and load TLS.
    }
    if (Date.now() >= deadline) throw new Error('caddy_start_timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function stopProcess(child) {
  await stopChild(child);
}

async function waitForHttpsOperation(origin, csrf, cookie, operationId, clientId) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const response = await httpsJson(origin, '/api/query', { method: 'POST', cookie, csrf, body: { type: 'operation', operationId, clientId } });
    assert.equal(response.status, 200, JSON.stringify(redact(response.body)));
    const result = response.body?.result;
    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    if (['done', 'cancelled', 'interrupted', 'error'].includes(result.status)) return result;
    if (Date.now() >= deadline) throw new Error(`remote operation timeout: ${operationId}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function mintViaHttps(origin, token, ticketOrigin) {
  const value = await httpsJson(origin, '/api/ticket', { method: 'POST', authorization: token, body: { origin: ticketOrigin } });
  assert.equal(value.status, 200, JSON.stringify(redact(value.body)));
  return value.body.ticket;
}

async function httpsJson(origin, path, { method = 'GET', body, authorization, cookie, csrf, host, origin: requestOrigin = origin } = {}) {
  const target = new URL(path, origin);
  const headers = { Host: host ?? target.host, Origin: requestOrigin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authorization) headers.Authorization = `Bearer ${authorization}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return await new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:', hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      method, headers, rejectUnauthorized: false,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let value = null;
        if (bytes.length) {
          try { value = JSON.parse(bytes.toString('utf8')); }
          catch { value = bytes.toString('utf8'); }
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: value });
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error(`HTTPS request timeout: ${method} ${path}`)));
    request.on('error', reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

function encodeWireLines(lines) {
  const text = lines.join('\n');
  return { encoding: 'base64', data: Buffer.from(text, 'utf8').toString('base64'), lines: lines.length };
}

async function runBrowser(origin, ticket, evidence) {
  const cwd = join(evidence, 'https-browser');
  await mkdir(cwd, { recursive: true });
  const executable = process.env.CHROME_PATH ?? 'google-chrome';
  const profile = join(cwd, `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(profile, { recursive: true });
  const child = spawnSmokeProcess(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, origin + '/#ticket=' + encodeURIComponent(ticket),
  ], { cwd, env: sanitizedEnvironment({ HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data') }), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', value => { stderr = (stderr + value).slice(-65_536); });
  let cdp;
  try {
    const port = await waitForDebugPort(child, () => stderr);
    let target;
    const targetDeadline = Date.now() + 20_000;
    while (!target) {
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
      target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl);
      if (Date.now() >= targetDeadline) throw new Error('browser_cdp_timeout: no page target');
      if (!target) await new Promise(resolve => setTimeout(resolve, 100));
    }
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const deadline = Date.now() + 30_000;
    for (;;) {
      const view = await cdp.evaluate("(() => ({ text: document.querySelector('#notebook')?.textContent ?? '', error: document.querySelector('#status')?.classList.contains('poll-error') ? document.querySelector('#status')?.textContent : null }))()");
      if (view.text.includes('x <- 41')) return view.text;
      if (Date.now() >= deadline) throw new Error('browser_render_timeout: expected x <- 41; status=' + (view.error ?? 'pending') + '; stderr=' + stderr);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    await cleanupScenarioResources(() => cdp?.close(), () => stopChild(child));
  }
}

async function waitForDebugPort(child, output, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const match = output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('browser_failed: ' + output());
    if (Date.now() >= deadline) throw new Error('browser_cdp_timeout: Chrome did not expose DevTools');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

class CdpSession {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    return new CdpSession(socket);
  }
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.code + ': ' + message.error.message));
      else pending.resolve(message.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
    return result.result?.value;
  }
  async close() { this.socket.close(); }
}
