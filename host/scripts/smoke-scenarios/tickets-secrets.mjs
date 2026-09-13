import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupScenarioResources,
  createHarness,
  exchangeTicket,
  mintTicket,
  openSession,
  redact,
  sanitizedEnvironment,
  waitForExecutionReady,
} from './_common.mjs';

export async function run(ctx) {
  const first = await createHarness(ctx, {
    id: 'tickets-secrets-one',
    source: ['# %%', 'secret_value <- 42', '# %%', 'secret_value + 1', ''].join('\n'),
  });
  await waitForExecutionReady(first);
  let firstSession;
  let second;
  let secondSession;
  let firstClosed = false;
  let secondClosed = false;
  try {
    const ticket = await mintTicket(first.origin, first.registry.token);
    const expiresAt = Date.parse((await raw(first.origin, '/api/ticket', {
      method: 'POST', authorization: first.registry.token, body: { origin: first.origin },
    })).body?.expiresAt ?? '');
    assert.ok(Number.isFinite(expiresAt));
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 61_000);
    firstSession = await exchangeTicket(first.origin, ticket);
    const replay = await raw(first.origin, '/api/session', { method: 'POST', body: { ticket } });
    assert.ok(replay.status === 401 || replay.status === 403, JSON.stringify(replay));
    const cookieMint = await raw(first.origin, '/api/ticket', {
      method: 'POST', cookie: firstSession.cookie, csrf: firstSession.csrf, body: { origin: first.origin },
    });
    assert.ok(cookieMint.status === 401 || cookieMint.status === 403, JSON.stringify(cookieMint));
    const wrongOrigin = await raw(first.origin, '/api/ticket', {
      method: 'POST', origin: 'https://wrong.invalid', authorization: first.registry.token,
      body: { origin: first.origin },
    });
    assert.equal(wrongOrigin.status, 403, JSON.stringify(wrongOrigin));
    const wrongTicketOrigin = await raw(first.origin, '/api/session', {
      method: 'POST', origin: 'https://wrong.invalid', body: { ticket: await mintTicket(first.origin, first.registry.token) },
    });
    assert.equal(wrongTicketOrigin.status, 403, JSON.stringify(wrongTicketOrigin));

    const initial = await first.query({ type: 'notebook' });
    const dom = await browserDump(first.origin, await mintTicket(first.origin, first.registry.token), join(ctx.evidence, 'browser-tickets-secrets'));
    for (const secret of [first.registry.token, firstSession.cookie, firstSession.csrf, ticket]) {
      assert.equal(dom.includes(secret), false, `secret leaked into rendered browser output: ${secret.slice(0, 6)}`);
    }

    second = await createHarness(ctx, {
      id: 'tickets-secrets-two',
      source: ['# %%', 'other_value <- 9', ''].join('\n'),
    });
    assert.notEqual(first.origin, second.origin);
    secondSession = await openSession(second.origin, second.registry);
    assert.notEqual(firstSession.cookie, secondSession.cookie);
    assert.notEqual(firstSession.csrf, secondSession.csrf);
    const secondIdentity = await second.request('/api/identity', { cookie: secondSession.cookie, csrf: secondSession.csrf });
    assert.equal(secondIdentity.epoch, second.registry.epoch);

    const destination = join(ctx.evidence, 'fixtures', 'saved-as.R');
    const saved = await first.nextCommand({
      type: 'save-as', path: destination, expectedDestination: 'absent',
      expectedDocumentRevision: (initial.result ?? initial).documentRevision,
    });
    const savedOperation = await first.awaitOperation(saved.operation?.id ?? saved.id);
    assert.ok(['done', 'completed'].includes(savedOperation.status), JSON.stringify(redact(savedOperation)));
    assert.equal((await stat(destination)).isFile(), true);
    const savedSource = await readFile(destination, 'utf8');
    assert.match(savedSource, /secret_value\s*<-\s*42/);
    const saveAsIdentity = await first.request('/api/identity', { cookie: firstSession.cookie, csrf: firstSession.csrf });
    assert.equal(saveAsIdentity.canonicalPath, destination);
    const secretValues = [first.registry.token, second.registry.token, ticket, firstSession.cookie, firstSession.csrf, secondSession.cookie, secondSession.csrf];
    await first.request('/api/lease', {
      method: 'POST', cookie: firstSession.cookie, csrf: firstSession.csrf,
      body: { action: 'release', leaseId: firstSession.leaseId },
    });
    firstSession = undefined;
    await second.request('/api/lease', {
      method: 'POST', cookie: secondSession.cookie, csrf: secondSession.csrf,
      body: { action: 'release', leaseId: secondSession.leaseId },
    });
    secondSession = undefined;
    await first.close();
    firstClosed = true;
    await second.close();
    secondClosed = true;
    const logs = await Promise.all([
      readFile(join(ctx.evidence, 'tickets-secrets-one.stdout.log'), 'utf8').catch(() => ''),
      readFile(join(ctx.evidence, 'tickets-secrets-one.stderr.log'), 'utf8').catch(() => ''),
      readFile(join(ctx.evidence, 'tickets-secrets-two.stdout.log'), 'utf8').catch(() => ''),
      readFile(join(ctx.evidence, 'tickets-secrets-two.stderr.log'), 'utf8').catch(() => ''),
    ]);
    for (const log of logs) for (const secret of secretValues) assert.equal(log.includes(secret), false);
    const identity = {
      protocol: 'alder-host-v2',
      ports: [new URL(first.origin).port, new URL(second.origin).port],
      ticketLifetimeMs: expiresAt - Date.now() + 1,
      replay: replay.status,
      cookieMint: cookieMint.status,
      wrongOrigin: wrongOrigin.status,
      wrongTicketOrigin: wrongTicketOrigin.status,
      saveAs: { path: destination, epoch: saveAsIdentity.epoch },
      secretScan: 'clean',
    };
    await writeFile(join(ctx.evidence, 'tickets-secrets.json'), `${JSON.stringify(redact(identity), null, 2)}\n`);
    return { id: 'tickets-secrets', identity };
  } finally {
    await cleanupScenarioResources(
      () => firstSession ? first.request('/api/lease', { method: 'POST', cookie: firstSession.cookie, csrf: firstSession.csrf, body: { action: 'release', leaseId: firstSession.leaseId } }) : undefined,
      () => secondSession ? second?.request('/api/lease', { method: 'POST', cookie: secondSession.cookie, csrf: secondSession.csrf, body: { action: 'release', leaseId: secondSession.leaseId } }) : undefined,
      () => !firstClosed ? first.close() : undefined,
      () => !secondClosed ? second?.close() : undefined,
    );
  }
}

async function raw(origin, path, { method = 'GET', body, authorization, cookie, csrf, origin: requestOrigin = origin } = {}) {
  const headers = { Origin: requestOrigin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authorization) headers.Authorization = `Bearer ${authorization}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(new URL(path, origin), {
    method, redirect: 'error', headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let bodyValue = null;
  if (bytes.length) {
    try { bodyValue = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { bodyValue = new TextDecoder().decode(bytes); }
  }
  return { status: response.status, body: redact(bodyValue) };
}

async function browserDump(origin, ticket, cwd) {
  await mkdir(cwd, { recursive: true });
  const executable = browserExecutable();
  const result = spawnSync(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', '--virtual-time-budget=10000',
    origin + '/#ticket=' + encodeURIComponent(ticket),
  ], { cwd, encoding: 'utf8', timeout: 60_000, env: sanitizedEnvironment({ HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data') }) });
  if (result.error) throw new Error('browser_unavailable: ' + result.error.message);
  if (result.status !== 0) throw new Error('browser_failed: ' + result.stderr);
  return result.stdout;
 }

function browserExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(existsSync) ?? 'chromium';
}
