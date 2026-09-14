import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { captureProcessTree, cleanupOwnedProcessTree, configureProcessObserver, mergeProcessTrees, ownerMatches, processStartIdentity, readProcess, startIdentityMatches, waitForOwnedProcessesGone, waitForOwnerExit } from './process-observer.mjs';
export { captureProcessTree, cleanupOwnedProcessTree, configureProcessObserver, mergeProcessTrees, ownerMatches, processStartIdentity, readProcess, startIdentityMatches, waitForOwnedProcessesGone, waitForOwnerExit } from './process-observer.mjs';
import { pathToFileURL } from 'node:url';
const MAX_RAW_LOG_BYTES = 1_048_576;
const LEASE_HEARTBEAT_INTERVAL_MS = 10_000;
const CLEANUP_STREAM_TIMEOUT_MS = 5_000;
const PROCESS_GROUP_FLAG = '__alderSmokeProcessGroup';
const wireCodecCache = new Map();
const wireCodecByOrigin = new Map();
export async function fetchLogicalOrigin(input, init = {}) {
  const requestInput = input instanceof Request ? input : null;
  const logical = new URL(requestInput?.url ?? input);
  if (!logical.hostname.endsWith('.localhost')) return fetch(input, init);
  const headers = new Headers(requestInput?.headers);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.set('Host', logical.host);
  const method = init.method ?? requestInput?.method ?? 'GET';
  const body = init.body !== undefined
    ? init.body
    : requestInput?.body === null || requestInput === null
      ? undefined
      : Buffer.from(await requestInput.arrayBuffer());
  return await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: Number(logical.port),
      path: logical.pathname + logical.search,
      method,
      headers: Object.fromEntries(headers),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', rejectPromise);
      response.once('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolvePromise(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.once('error', rejectPromise);
    if (body === undefined || body === null) request.end();
    else if (typeof body === 'string' || body instanceof Uint8Array) request.end(body);
    else request.destroy(new TypeError('loopback smoke fetch accepts only string or byte bodies'));
  });
}

export function openLogicalWebSocket(WebSocketImpl, input, options = {}) {
  const logical = new URL(input);
  if (!logical.hostname.endsWith('.localhost')) return new WebSocketImpl(input, options);
  const target = new URL(logical);
  target.hostname = '127.0.0.1';
  return new WebSocketImpl(target.href, {
    ...options,
    headers: { ...options.headers, Host: logical.host },
  });
}
/** Launch a smoke child in its own process group so timeouts cannot orphan descendants. */
export function spawnSmokeProcess(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true });
  Object.defineProperty(child, PROCESS_GROUP_FLAG, { value: true });
  return child;
}

/** Synchronous smoke commands use the same group boundary and clean up on timeout. */
export function spawnSmokeSync(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, detached: true });
  if (result.error?.code === 'ETIMEDOUT' && Number.isSafeInteger(result.pid) && result.pid > 0) {
    signalSmokeProcessGroup(result.pid, 'SIGKILL');
  }
  return result;
}

export function signalSmokeProcessGroup(pid, signal = 'SIGTERM') {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('smoke process pid must be a positive integer');
  if (process.platform === 'win32') {
    const force = signal === 'SIGKILL';
    const result = spawnSync('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.error && result.error.code !== 'ESRCH') throw result.error;
    if ((result.status ?? 0) !== 0 && !String(result.stderr ?? '').toLowerCase().includes('not found')) {
      throw new Error('smoke process-tree signal failed: ' + String(result.stderr ?? result.stdout ?? '').trim());
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function signalSmokeProcess(child, signal) {
  if (child?.[PROCESS_GROUP_FLAG] === true && Number.isSafeInteger(child.pid) && child.pid > 0) {
    signalSmokeProcessGroup(child.pid, signal);
    return true;
  }
  return child.kill(signal);
}
function smokeProcessGroupMembers(pid) {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-eo', 'pid=,pgid='], {
    encoding: 'utf8', windowsHide: true, timeout: CLEANUP_STREAM_TIMEOUT_MS, env: { ...process.env },
  });
  if (result.error) throw new Error('smoke process-group inspection failed: ' + result.error.message);
  if (result.status !== 0) throw new Error('smoke process-group inspection failed: ' + String(result.stderr ?? '').trim());
  const members = [];
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) continue;
    const memberPid = Number(fields[0]);
    const groupPid = Number(fields[1]);
    if (Number.isSafeInteger(memberPid) && memberPid > 0 && groupPid === pid) members.push(memberPid);
  }
  return [...new Set(members)];
}

async function cleanupExitedSmokeProcessGroup(pid, timeout = CLEANUP_STREAM_TIMEOUT_MS) {
  if (process.platform === 'win32') return { forced: false };
  const deadline = Date.now() + timeout;
  let forced = false;
  for (;;) {
    // The group leader has already exited. Never use kill(-pid, ...) here: the
    // numeric group id can be reused after the leader's exit. Re-discover each
    // current member and signal only its positive PID instead.
    const members = smokeProcessGroupMembers(pid).filter(memberPid => memberPid !== pid);
    if (members.length === 0) return { forced };
    forced = true;
    for (const memberPid of members) {
      try { process.kill(memberPid, 'SIGKILL'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    if (Date.now() >= deadline) throw new Error('smoke process group did not disappear after leader exit: ' + pid);
    await delay(25);
  }
}
/** Run every finalizer and surface all cleanup failures to the scenario driver. */
export async function cleanupScenarioResources(...cleanups) {
  const errors = [];
  for (const cleanup of cleanups) {
    if (cleanup === undefined || cleanup === null) continue;
    try {
      await (typeof cleanup === 'function' ? cleanup() : cleanup);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'smoke scenario cleanup failed');
}

export async function loadWireCodec(applicationRoot, manifest) {
  const entry = join(applicationRoot, manifest.resources.hostEntry);
  let loading = wireCodecCache.get(entry);
  if (loading === undefined) {
    loading = import(pathToFileURL(entry).href).then(codec => {
      for (const name of ['encodeHostCommandWire', 'encodeHostQueryWire', 'decodeHostQueryResultWire']) {
        if (typeof codec[name] !== 'function') throw new Error('staged host does not expose canonical ' + name);
      }
      if (typeof codec.artifactHandleSchema?.safeParse !== 'function' || typeof codec.hostQueryResultSchema?.parse !== 'function' || typeof codec.hostSnapshotSchema?.parse !== 'function') throw new Error('staged host does not expose canonical query schemas');
      return codec;
    });
    wireCodecCache.set(entry, loading);
  }
  return loading;
}
export async function createHarness(ctx, { id, source = '# %%\n1 + 1\n', extension = '.R', args = [], rscript } = {}) {
  const fixtureDirectory = join(ctx.evidence, 'fixtures', id);
  await mkdir(fixtureDirectory, { recursive: true });
  const notebook = source === null ? null : join(fixtureDirectory, 'sample' + extension);
  if (notebook !== null) await writeFile(notebook, source);
  const applicationRoot = await realpath(resolve(ctx.applicationRoot));
  const launcher = join(applicationRoot, ctx.manifest.resources.cliLauncher);
  const processSupervisorExecutable = await realpath(join(applicationRoot, ctx.manifest.resources.processSupervisorExecutable));
  assert.equal(processSupervisorExecutable.startsWith(applicationRoot + sep), true, 'process supervisor must resolve inside staged application');
  configureProcessObserver(processSupervisorExecutable);
  const processObserverOptions = { supervisorExecutable: processSupervisorExecutable };
  const selectedR = rscript ?? ctx.rscript;
  assert.equal(typeof selectedR, 'string', 'Rscript must be supplied explicitly');
  assert.equal(isAbsolute(selectedR), true, 'Rscript must be an absolute path');
  const wire = await loadWireCodec(applicationRoot, ctx.manifest);
  const dataHome = join(ctx.evidence, 'runtime-data', id);
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(dataHome, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const env = sanitizedEnvironment({ XDG_DATA_HOME: dataHome });
  const canonical = notebook === null ? null : await realpath(notebook);
  await mkdir(join(ctx.evidence, 'unrelated'), { recursive: true });
  const childArgs = [
    ...(notebook === null ? [] : [notebook]),
    '--headless', '--no-run', '--port', '0', '--rscript', selectedR, ...args,
  ];
  const child = spawnSmokeProcess(launcher, childArgs, {
    cwd: join(ctx.evidence, 'unrelated'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const stdout = collectLines(child.stdout, { strictReady: true });
  const stderr = collectLines(child.stderr);
  let childStartIdentity = null;
  let registry;
  let launchTree = [];
  try {
    childStartIdentity = await processStartIdentity(child.pid, processObserverOptions);
    if (childStartIdentity === null) throw new Error('harness child process identity unavailable');
    const ready = await waitForCanonicalReady(stdout, child, 120_000);
    assertCanonicalReady(ready);
    try { launchTree = await captureProcessTree(child.pid, childStartIdentity, processObserverOptions); } catch (cause) { throw new AggregateError([cause], 'harness ownership capture failed'); }
    const origin = ready.origin;
    assert.equal(typeof origin, 'string', 'host.ready must expose loopback origin');
    wireCodecByOrigin.set(origin, wire);
    registry = await waitForRegistry(canonical, runtimeDirectory, 120_000);
    assert.equal(registry.state, 'ready');
    assert.equal(registry.canonicalPath, canonical);
    assert.match(registry.continuityProof, /^[0-9a-f]{64}$/);
    const registryTree = await captureProcessTree(registry.pid, registry.startIdentity, processObserverOptions);
    launchTree = mergeProcessTrees(launchTree, registryTree);
    const session = await openSession(origin, registry);
    session.wire = wire;
    const leaseHeartbeat = startLeaseHeartbeat(origin, session);
    return {
      id, notebook, selectedR, dataHome, child, stdout, stderr, ready, registry, origin, canonical, session, wire, ownedTree: launchTree,
      request: (path, options) => requestJson(origin, path, options),
      query: value => query(origin, session, value, wire),
      snapshot: () => snapshot({ query: value => query(origin, session, value, wire), session }),
      notebookMetadata: () => notebookMetadata({ query: value => query(origin, session, value, wire), session }),
      command: value => command(origin, session, value, wire),
      awaitOperation: operationId => awaitOperation(origin, session, operationId, wire),
      nextCommand: value => command(origin, session, { ...value, operationId: value.operationId ?? randomUUID(), clientId: session.clientId, commandSequence: session.nextCommandSequence++, sessionEpoch: session.epoch }, wire),
      browser: ticket => runBrowser(origin, ticket, join(ctx.evidence, 'browser')),
      mintTicket: () => mintTicket(origin, registry.token),
      async close() {
        const cleanupErrors = [];
        let ownedTree = [];
        let releaseResponse = null;
        let stopResult = { signal: null, forced: false };
        let treeResult = { forced: false, records: 0 };
        let ownerRetired = false;
        ownedTree = launchTree;
        try { await leaseHeartbeat.stop(); } catch (cause) { cleanupErrors.push(cause); }
        try { releaseResponse = await releaseLease(origin, session); } catch (cause) { cleanupErrors.push(cause); }
        try { stopResult = await stopChild(child); } catch (cause) { cleanupErrors.push(cause); }
        try { ownerRetired = await waitForOwnerExit(registry.pid, registry.startIdentity, 5_000, processObserverOptions); } catch (cause) { cleanupErrors.push(cause); }
        try {
          treeResult = await cleanupOwnedProcessTree(ownedTree, processObserverOptions);
        } catch (cause) {
          cleanupErrors.push(cause);
        } finally {
          try { await cleanupPartialOwner(canonical, runtimeDirectory, processObserverOptions); } catch (cause) { cleanupErrors.push(cause); }
          try { if (!ownerRetired) ownerRetired = await waitForOwnerExit(registry.pid, registry.startIdentity, 5_000, processObserverOptions); } catch (cause) { cleanupErrors.push(cause); }
          try { await waitForPromise(stdout.done, CLEANUP_STREAM_TIMEOUT_MS, id + '_stdout'); assertStrictReadyOutput(stdout); } catch (cause) { cleanupErrors.push(cause); }
          try { await writeHarnessLogs(ctx.evidence, id, stdout, stderr); } catch (cause) { cleanupErrors.push(cause); }
          wireCodecByOrigin.delete(origin);
        }
        if (!ownerRetired) cleanupErrors.push(new Error('smoke harness owner did not retire before fixture cleanup'));
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'smoke harness cleanup failed');
        return { release: releaseResponse, ownerRetired, stop: stopResult, descendants: treeResult, forced: stopResult.forced || treeResult.forced };
      },
    };
  } catch (error) {
    const cleanupErrors = [];
    let ownedTree = [];
    try {
      const launchSnapshot = launchTree;
      const registrySnapshot = registry === undefined
        ? await captureProcessTree(child.pid, childStartIdentity, processObserverOptions)
        : await captureProcessTree(registry.pid, registry.startIdentity, processObserverOptions);
      ownedTree = mergeProcessTrees(launchSnapshot, registrySnapshot);
    } catch (cause) { cleanupErrors.push(cause); }
    try { await stopChild(child); } catch (cause) { cleanupErrors.push(cause); }
    try {
      await cleanupOwnedProcessTree(ownedTree, processObserverOptions);
    } catch (cause) {
      cleanupErrors.push(cause);
    } finally {
      try { await cleanupPartialOwner(canonical, runtimeDirectory, processObserverOptions); } catch (cause) { cleanupErrors.push(cause); }
      try { await waitForPromise(stdout.done, CLEANUP_STREAM_TIMEOUT_MS, id + '_stdout'); assertStrictReadyOutput(stdout); } catch (cause) { cleanupErrors.push(cause); }
      try { await writeHarnessLogs(ctx.evidence, id, stdout, stderr); } catch (cause) { cleanupErrors.push(cause); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'smoke harness cleanup failed');
    throw error;
  }
}

export async function cleanupPartialOwner(canonicalPath, runtimeDirectory, processObserverOptions = {}) {
  const names = canonicalPath === null
    ? await readdir(runtimeDirectory).catch(error => { if (error?.code === 'ENOENT') return []; throw error; })
    : [];
  const paths = canonicalPath === null
    ? names.filter(name => name.endsWith('.json')).map(name => join(runtimeDirectory, name))
    : [join(runtimeDirectory, createHash('sha256').update('path:' + canonicalPath).digest('hex') + '.json')];
  for (const registryPath of paths) await cleanupOwnerRecord(registryPath, canonicalPath, processObserverOptions);
  if (canonicalPath === null) {
    for (const name of names.filter(name => name.endsWith('.json.lock'))) await rm(join(runtimeDirectory, name), { recursive: true, force: true });
  }
}



async function cleanupOwnerRecord(registryPath, canonicalPath, processObserverOptions = {}) {
  const lockPath = registryPath + '.lock';
  let metadata;
  try {
    metadata = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await rm(lockPath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
      || !['starting', 'ready', 'stopping'].includes(metadata.state)
      || (canonicalPath !== null && metadata.canonicalPath !== canonicalPath)
      || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0
      || typeof metadata.startIdentity !== 'string') return;
  const pid = metadata.pid;
  const identity = metadata.startIdentity;
  const matches = await ownerMatches(pid, identity, processObserverOptions);
  if (!matches) {
    await rm(registryPath, { force: true });
    await rm(lockPath, { recursive: true, force: true });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  let exited = await waitForOwnerExit(pid, identity, 5_000, processObserverOptions);
  if (!exited && await ownerMatches(pid, identity, processObserverOptions) === true) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    exited = await waitForOwnerExit(pid, identity, 5_000, processObserverOptions);
  }
  if (!exited) throw new Error('partial_owner_cleanup_timeout: ' + pid);
  await rm(registryPath, { force: true });
  await rm(lockPath, { recursive: true, force: true });
}
export async function openSession(origin, registry) {
  const ticket = await mintTicket(origin, registry.token);
  const session = await exchangeTicket(origin, ticket);
  assert.equal(session.continuityProof, registry.continuityProof);
  return session;
}
export async function mintTicket(origin, token) {
  const value = await requestJson(origin, '/api/ticket', { method: 'POST', authorization: token, body: { origin } });
  assert.deepEqual(Object.keys(value).sort(), ['expiresAt', 'ticket']);
  assert.equal(typeof value.ticket, 'string');
  assert.ok(value.ticket.length > 0);
  assert.equal(typeof value.expiresAt, 'string');
  return value.ticket;
}
export async function exchangeTicket(origin, ticket) {
  const response = await fetchLogicalOrigin(new URL('/api/session', origin), { method: 'POST', redirect: 'error', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const value = await parseResponse(response);
  assert.equal(response.ok, true, JSON.stringify(value));
  assert.deepEqual(Object.keys(value).sort(), ['clientId', 'continuityProof', 'csrf', 'epoch', 'leaseId', 'nextCommandSequence', 'recoveryKey', 'recoveryKeyId']);
  assert.equal(typeof value.clientId, 'string');
  assert.equal(typeof value.csrf, 'string');
  assert.equal(typeof value.continuityProof, 'string');
  assert.match(value.continuityProof, /^[0-9a-f]{64}$/);
  assert.equal(typeof value.epoch, 'string');
  assert.equal(typeof value.leaseId, 'string');
  assert.equal(Number.isSafeInteger(value.nextCommandSequence) && value.nextCommandSequence > 0, true);
  assert.match(value.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(value.recoveryKeyId, /^[A-Za-z0-9_-]{43}$/);
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  const cookie = cookies[0]?.split(';', 1)[0];
  assert.ok(cookie, 'session exchange must return an HttpOnly session cookie');
  const identity = await requestJson(origin, '/api/identity', { cookie, csrf: value.csrf });
  assert.deepEqual(Object.keys(identity).sort(), ['address', 'browserOrigin', 'canonicalPath', 'capabilities', 'clientId', 'configuration', 'continuityProof', 'documentReady', 'epoch', 'leaseId', 'nextCommandSequence', 'origin', 'processNonce', 'protocol', 'sessionKey']);
  assert.equal(identity.protocol, 'alder-host-v2');
  assert.match(identity.origin, /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+$/);
  assert.equal(new URL(identity.origin).port, new URL(origin).port);
  assert.equal(identity.browserOrigin, origin);
  assert.equal(identity.epoch, value.epoch);
  assert.equal(identity.continuityProof, value.continuityProof);
  assert.match(identity.continuityProof, /^[0-9a-f]{64}$/);
  assert.equal(identity.documentReady, true, 'authenticated identity must be document-ready');
  assert.equal(typeof identity.sessionKey, 'string');
  assert.equal(typeof identity.processNonce, 'string');
  assert.equal(typeof identity.leaseId, 'string');
  assert.equal(identity.leaseId, value.leaseId);
  assert.equal(typeof identity.clientId, 'string');
  assert.equal(identity.clientId, value.clientId);
  assert.equal(Number.isSafeInteger(identity.nextCommandSequence) && identity.nextCommandSequence > 0, true);
  assert.deepEqual(identity.configuration && Object.keys(identity.configuration).sort(), ['deferStartup', 'executionMode', 'rscript', 'runOnStartup']);
  assert.equal(identity.configuration.rscript === null || typeof identity.configuration.rscript === 'string', true);
  assert.equal(['automatic', 'lazy'].includes(identity.configuration.executionMode), true);
  assert.equal(typeof identity.configuration.runOnStartup, 'boolean');
  assert.equal(typeof identity.configuration.deferStartup, 'boolean');
  assert.deepEqual(identity.address && Object.keys(identity.address).sort(), ['browserOrigin', 'host', 'origin', 'port']);
  assert.equal(typeof identity.address.host, 'string');
  assert.equal(identity.address.origin, identity.origin);
  assert.equal(identity.address.browserOrigin, identity.browserOrigin);
  assert.equal(Number.isSafeInteger(identity.address.port) && identity.address.port >= 0 && identity.address.port <= 65_535, true);
  assert.ok(Array.isArray(identity.capabilities));
  assert.ok(identity.canonicalPath === null || typeof identity.canonicalPath === 'string');
  return { ...value, sessionKey: identity.sessionKey, canonicalPath: identity.canonicalPath, origin: identity.origin, processNonce: identity.processNonce, continuityProof: identity.continuityProof, capabilities: identity.capabilities, cookie };
}
export async function requestJson(origin, path, { method = 'GET', body, authorization, cookie, csrf } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authorization) headers.Authorization = `Bearer ${authorization}`;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetchLogicalOrigin(new URL(path, origin), { method, redirect: 'error', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await parseResponse(response);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(redact(value))}`);
  return value;
}
function canonicalWire(origin, session, wire) {
  const codec = wire ?? session?.wire ?? wireCodecByOrigin.get(origin);
  assert.ok(codec, 'smoke transport must use the canonical staged wire codec');
  return codec;
}
async function readArtifactBytes(origin, session, descriptor, codec) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const pageQuery = { type: 'output', handle: descriptor.handle, offset, limit: descriptor.chunkBytes };
    const pageResponse = await requestJson(origin, '/api/query', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: codec.encodeHostQueryWire(pageQuery) });
    const pageEnvelope = codec.hostQueryResultSchema.parse(codec.decodeHostQueryResultWire(pageQuery, pageResponse));
    const page = pageEnvelope.result;
    if (codec.artifactHandleSchema.safeParse(page).success
        || page === null || typeof page !== 'object' || Array.isArray(page)
        || page.encoding !== 'base64' || typeof page.data !== 'string'
        || !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.nextOffset) || typeof page.eof !== 'boolean') {
      throw new Error('artifact page has an invalid shape');
    }
    const bytes = Buffer.from(page.data, 'base64');
    if (bytes.toString('base64') !== page.data || page.offset !== offset
        || page.nextOffset !== offset + bytes.byteLength || page.nextOffset > descriptor.byteLength
        || bytes.byteLength > descriptor.chunkBytes) throw new Error('artifact page is not canonical');
    chunks.push(bytes);
    offset = page.nextOffset;
    if (page.eof) {
      if (offset !== descriptor.byteLength) throw new Error('artifact ended before its descriptor length');
      break;
    }
    if (bytes.byteLength === 0 || offset >= descriptor.byteLength) throw new Error('artifact page made no progress');
  }
  return Buffer.concat(chunks);
}
export async function query(origin, session, value, wire) {
  const codec = canonicalWire(origin, session, wire);
  const response = await requestJson(origin, '/api/query', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: codec.encodeHostQueryWire(value) });
  const decoded = codec.hostQueryResultSchema.parse(codec.decodeHostQueryResultWire(value, response));
  const artifact = codec.artifactHandleSchema.safeParse(decoded.result);
  if (!artifact.success) return decoded;
  const bytes = await readArtifactBytes(origin, session, artifact.data, codec);
  const hydrated = { ...response, result: JSON.parse(bytes.toString('utf8')) };
  return codec.hostQueryResultSchema.parse(codec.decodeHostQueryResultWire(value, hydrated));
}
export async function command(origin, session, value, wire) {
  const codec = canonicalWire(origin, session, wire);
  return requestJson(origin, '/api/command', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: codec.encodeHostCommandWire(value) });
}
async function fullSnapshotEnvelope(harness) {
  const queryValue = { type: 'events', epoch: null, cursor: null };
  const envelope = await harness.query(queryValue);
  assert.deepEqual(Object.keys(envelope).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(envelope.epoch, harness.session.epoch);
  assert.equal(Number.isSafeInteger(envelope.cursor) && envelope.cursor >= 0, true);
  assert.equal(Number.isSafeInteger(envelope.documentRevision) && envelope.documentRevision >= 0, true);
  const recovery = envelope.result;
  assert.ok(recovery && typeof recovery === 'object' && !Array.isArray(recovery));
  assert.equal(recovery.kind, 'snapshot');
  assert.equal(recovery.epoch, envelope.epoch);
  assert.equal(Number.isSafeInteger(recovery.cursor) && recovery.cursor >= 0, true);
  const codec = canonicalWire(harness.origin, harness.session, harness.wire);
  const snapshotValue = codec.hostSnapshotSchema.parse(recovery.snapshot);
  return { envelope, snapshot: snapshotValue };
}
export async function snapshot(harness) {
  return (await fullSnapshotEnvelope(harness)).snapshot;
}
export async function notebookMetadata(harness) {
  const envelope = await harness.query({ type: 'notebook' });
  assert.deepEqual(Object.keys(envelope).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
  assert.equal(envelope.epoch, harness.session.epoch);
  assert.equal(Number.isSafeInteger(envelope.cursor) && envelope.cursor >= 0, true);
  assert.equal(Number.isSafeInteger(envelope.documentRevision) && envelope.documentRevision >= 0, true);
  const metadata = envelope.result;
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
  return metadata;
}
export async function waitForExecutionReady(harness, { timeout = 120_000 } = {}) {
  assert.equal(Number.isSafeInteger(timeout) && timeout > 0, true);
  assert.equal(typeof harness?.query, 'function');
  assert.equal(typeof harness?.session?.epoch, 'string');
  const deadline = Date.now() + timeout;
  for (;;) {
    const { snapshot: snapshotValue } = await fullSnapshotEnvelope(harness);
    assert.equal(snapshotValue.protocol, 'alder-host-v2');
    assert.equal(snapshotValue.epoch, harness.session.epoch);
    assert.ok(snapshotValue.runtime && typeof snapshotValue.runtime === 'object' && !Array.isArray(snapshotValue.runtime));
    const runtime = snapshotValue.runtime;
    if (runtime.kernelState === 'failed' || runtime.analyzerState === 'failed') {
      throw new Error('runtime_not_ready: ' + JSON.stringify({ epoch: snapshotValue.epoch, kernelState: runtime.kernelState, analyzerState: runtime.analyzerState, executionBlockedReason: runtime.executionBlockedReason }));
    }
    if (runtime.executionReady === true
        && runtime.documentReady === true
        && runtime.kernelState === 'ready'
        && runtime.analyzerState === 'ready'
        && typeof runtime.kernelEpoch === 'string'
        && runtime.kernelEpoch.length > 0) return snapshotValue;
    if (Date.now() >= deadline) throw new Error('runtime_ready_timeout: ' + JSON.stringify({ epoch: snapshotValue.epoch, kernelState: runtime.kernelState, analyzerState: runtime.analyzerState, documentReady: runtime.documentReady, executionReady: runtime.executionReady, executionBlockedReason: runtime.executionBlockedReason, kernelEpoch: runtime.kernelEpoch }));
    await delay(100);
  }
}
export async function awaitOperation(origin, session, operationId, wire) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const envelope = await query(origin, session, { type: 'operation', operationId, clientId: session.clientId }, wire);
    assert.deepEqual(Object.keys(envelope).sort(), ['cursor', 'documentRevision', 'epoch', 'result']);
    assert.equal(envelope.epoch, session.epoch);
    assert.equal(Number.isSafeInteger(envelope.cursor) && envelope.cursor >= 0, true);
    assert.equal(Number.isSafeInteger(envelope.documentRevision) && envelope.documentRevision >= 0, true);
    const value = envelope.result;
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(value.id, operationId);
    if (['done', 'cancelled', 'interrupted', 'error'].includes(value.status)) return value;
    if (Date.now() >= deadline) throw new Error('operation_timeout: ' + operationId);
    await delay(100);
  }
}
async function heartbeatLease(origin, session) {
  const value = await requestJson(origin, '/api/lease', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: { action: 'heartbeat', leaseId: session.leaseId } });
  assert.deepEqual(Object.keys(value).sort(), ['clientId', 'epoch', 'leaseId', 'nextCommandSequence']);
  assert.equal(typeof value.clientId, 'string');
  assert.equal(value.clientId, session.clientId);
  assert.equal(typeof value.epoch, 'string');
  assert.equal(value.epoch, session.epoch);
  assert.equal(typeof value.leaseId, 'string');
  assert.equal(value.leaseId, session.leaseId);
  assert.equal(Number.isSafeInteger(value.nextCommandSequence) && value.nextCommandSequence > 0, true);
  session.nextCommandSequence = Math.max(session.nextCommandSequence, value.nextCommandSequence);
  return value;
}
function startLeaseHeartbeat(origin, session) {
  let stopped = false;
  let failure = null;
  let inFlight = null;
  let stopPromise;
  const renew = () => {
    if (stopped || failure !== null || inFlight !== null) return;
    const pending = heartbeatLease(origin, session).catch(error => { failure ??= error; }).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
  };
  const interval = setInterval(renew, LEASE_HEARTBEAT_INTERVAL_MS);
  interval.unref();
  return {
    stop() {
      if (stopPromise === undefined) {
        stopPromise = (async () => {
          stopped = true;
          clearInterval(interval);
          const pending = inFlight;
          if (pending !== null) await pending;
          if (failure !== null) throw failure;
        })();
      }
      return stopPromise;
    },
  };
}
export async function releaseLease(origin, session) {
  const value = await requestJson(origin, '/api/lease', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: { action: 'release', leaseId: session.leaseId } });
  assert.deepEqual(Object.keys(value).sort(), ['released']);
  assert.equal(value.released, true);
  return value;
}
export function sanitizedEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('ALDER_') || key === 'R_HOME' || key.startsWith('R_LIBS')) delete env[key];
  Object.assign(env, extra);
  return env;
}
export async function waitForRegistry(canonicalPath, runtimeDirectory, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const names = await readdir(runtimeDirectory).catch(() => []);
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const value = await readFile(join(runtimeDirectory, name), 'utf8').then(JSON.parse).catch(() => null);
      if (value?.state === 'ready' && value.canonicalPath === canonicalPath) return value;
    }
    if (Date.now() >= deadline) {
      throw new Error('session_registry_timeout: ' + (canonicalPath ?? 'untitled session in ' + runtimeDirectory));
    }
    await delay(100);
  }
}
export async function runBrowser(origin, ticket, cwd) {
  await mkdir(cwd, { recursive: true });
  const executable = process.env.CHROME_PATH ?? 'google-chrome';
  const profile = join(cwd, 'profile-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  await mkdir(profile, { recursive: true });
  const child = spawnSmokeProcess(executable, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, origin + '/#ticket=' + encodeURIComponent(ticket),
  ], { cwd, env: sanitizedEnvironment({ HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data') }), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-65_536); });
  let cdp = null;
  try {
    const port = await waitForDebugPort(child, () => stderr);
    let target;
    const targetDeadline = Date.now() + 20_000;
    while (!target) {
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
      target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl);
      if (Date.now() >= targetDeadline) throw new Error('browser_cdp_timeout: no page target');
      if (!target) await delay(100);
    }
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const deadline = Date.now() + 30_000;
    for (;;) {
      const view = await cdp.evaluate("(() => ({ ready: Boolean(window.__alderHost?.client?.document?.snapshot), html: document.documentElement.outerHTML, error: document.querySelector('#status')?.classList.contains('poll-error') ? document.querySelector('#status')?.textContent : null }))()");
      if (view.ready) return view.html;
      if (view.error) throw new Error('browser_failed: ' + view.error);
      if (Date.now() >= deadline) throw new Error('browser_render_timeout: browser client did not recover; status=' + (view.error ?? 'pending'));
      await delay(100);
    }
  } finally {
    await cleanupScenarioResources(
      () => cdp?.close(),
      () => terminateBrowser(child),
    );
  }
}
async function waitForDebugPort(child, output, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const match = output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('browser_failed: ' + output());
    if (Date.now() >= deadline) throw new Error('browser_cdp_timeout: Chrome did not expose DevTools');
    await delay(100);
  }
}
async function waitForBrowserExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}
async function terminateBrowser(child) {
  try { signalSmokeProcess(child, 'SIGTERM'); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (await waitForBrowserExit(child, 2_000)) return;
  try { signalSmokeProcess(child, 'SIGKILL'); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!await waitForBrowserExit(child, 5_000)) throw new Error('browser did not exit after SIGTERM/SIGKILL');
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
    return result.result?.value;
  }
  async close() { this.socket.close(); }
}
export function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|cookie|csrf|ticket|authorization|bearer/i.test(key)).map(([key, entry]) => [key, redact(entry)]));
}
export function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForPromise(promise, timeout, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + '_timeout')), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function parseResponse(response) { const bytes = new Uint8Array(await response.arrayBuffer()); if (!bytes.length) return null; try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { return new TextDecoder().decode(bytes); } }
function collectLines(stream, { strictReady = false } = {}) {
  if (strictReady) return createStrictReadyParser(stream);
  let text = '';
  let history = '';
  let historyBytes = 0;
  let historyTruncated = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    text += chunk;
    if (historyTruncated) return;
    const bytes = Buffer.from(chunk, 'utf8');
    const remaining = MAX_RAW_LOG_BYTES - historyBytes;
    if (bytes.byteLength <= remaining) {
      history += chunk;
      historyBytes += bytes.byteLength;
      return;
    }
    history += bytes.subarray(0, Math.max(0, remaining)).toString('utf8');
    history += '\n[raw output truncated at 1048576 bytes]\n';
    historyBytes = MAX_RAW_LOG_BYTES;
    historyTruncated = true;
  });
  stream.on('end', () => resolveDone());
  return {
    done,
    async next() {
      const start = text.indexOf('\n');
      if (start >= 0) {
        const value = text.slice(0, start).replace(/\r$/, '');
        text = text.slice(start + 1);
        return { done: false, value };
      }
      if (stream.readableEnded) return { done: true, value: null };
      await delay(20);
      return this.next();
    },
    async text() { await done; return history.split(/(?<=\n)/); },
  };
}

export function createStrictReadyParser(stream, { label = 'host', maxBytes = MAX_RAW_LOG_BYTES } = {}) {
  let buffer = '';
  let history = Buffer.alloc(0);
  let rawBytes = 0;
  let error = null;
  let readyRecord = null;
  let recordCount = 0;
  let ended = false;
  let resolveReady;
  let resolveDone;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const done = new Promise(resolve => { resolveDone = resolve; });
  const lines = [];
  const waiters = [];
  const violation = reason => {
    if (error === null) error = new Error(label + '_stdout_protocol:' + reason);
  };
  const publishLine = line => {
    recordCount += 1;
    lines.push(line);
    while (waiters.length > 0) waiters.shift()({ done: false, value: line });
    if (line.length === 0) { violation('blank_record'); return; }
    let value;
    try { value = JSON.parse(line); } catch { violation('malformed_record'); return; }
    if (readyRecord !== null) { violation('multiple_records'); return; }
    try { assertCanonicalReady(value); } catch { violation('noncanonical_record'); return; }
    readyRecord = value;
    resolveReady(value);
  };
  const append = chunk => {
    const bytes = Buffer.from(chunk, 'utf8');
    rawBytes += bytes.byteLength;
    if (rawBytes > maxBytes) violation('output_limit_exceeded');
    if (history.byteLength < maxBytes) {
      const remaining = maxBytes - history.byteLength;
      history = Buffer.concat([history, bytes.subarray(0, remaining)]);
    }
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      publishLine(line);
    }
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    if (buffer.length > 0) violation('unterminated_record');
    while (waiters.length > 0) waiters.shift()({ done: true, value: null });
    resolveDone();
  };
  stream.setEncoding('utf8');
  stream.on('data', append);
  stream.on('end', finish);
  stream.on('close', finish);
  return {
    ready,
    done,
    get error() { return error; },
    get readyRecord() { return readyRecord; },
    get recordCount() { return recordCount; },
    get ended() { return ended; },
    get stdout() { return history.toString('utf8'); },
    async next() {
      if (lines.length > 0) return { done: false, value: lines.shift() };
      if (ended) return { done: true, value: null };
      return new Promise(resolve => waiters.push(resolve));
    },
    async text() { await done; return [history.toString('utf8')]; },
  };
}

export function assertStrictReadyOutput(parser, { requireReady = true } = {}) {
  if (parser.error !== null) throw parser.error;
  if (parser.recordCount === 0) {
    if (requireReady) throw new Error('host_stdout_protocol:missing_record');
    return null;
  }
  if (parser.recordCount !== 1 || parser.readyRecord === null) throw new Error('host_stdout_protocol:expected_one_ready_record');
  assertCanonicalReady(parser.readyRecord);
  return parser.readyRecord;
}
export function assertCanonicalReady(value) {
  assert.deepEqual(Object.keys(value).sort(), ['capabilities', 'epoch', 'origin', 'type']);
  assert.equal(value.type, 'host.ready');
  const origin = new URL(value.origin);
  assert.equal(origin.protocol, 'http:');
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || /^[0-9a-f]{32}\.localhost$/.test(origin.hostname),
  );
  assert.notEqual(origin.port, '');
  assert.equal(typeof value.epoch, 'string');
  assert.ok(Array.isArray(value.capabilities));
}
export async function waitForCanonicalReady(lines, child, timeout, label = 'host') {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (lines.error !== null) throw lines.error;
    if (lines.readyRecord !== null) return assertStrictReadyOutput(lines, { requireReady: true });
    if (lines.ended || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(label + '_ready_timeout: ' + (child.exitCode ?? child.signalCode ?? 'exited'));
    }
    if (Date.now() >= deadline) throw new Error(label + '_ready_timeout');
    await delay(20);
  }
}

export async function requireAbsoluteRscript(value, label = 'Rscript') {
  assert.equal(typeof value, 'string', label + ' must be provided as an absolute executable path');
  assert.equal(isAbsolute(value), true, label + ' must be an absolute executable path');
  const path = resolve(value);
  const info = await stat(path).catch(error => { throw new Error(label + ' is unavailable: ' + path + ': ' + error.message); });
  assert.equal(info.isFile(), true, label + ' must be a regular file: ' + path);
  if (process.platform !== 'win32') assert.notEqual(info.mode & 0o111, 0, label + ' must be executable: ' + path);
  return path;
}
async function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = value => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); resolve(value); };
    child.once('exit', () => finish(true));
    timer = setTimeout(() => finish(false), timeout);
    timer.unref?.();
  });
}
export async function stopChild(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw new RangeError('smoke child pid must be a positive integer');
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (exited) {
    const cleanup = child?.[PROCESS_GROUP_FLAG] === true
      ? await cleanupExitedSmokeProcessGroup(child.pid)
      : { forced: false };
    return { signal: null, forced: cleanup.forced };
  }
  signalSmokeProcess(child, 'SIGTERM');
  if (await waitForExit(child, 5_000)) {
    const cleanup = child?.[PROCESS_GROUP_FLAG] === true
      ? await cleanupExitedSmokeProcessGroup(child.pid)
      : { forced: false };
    return { signal: 'SIGTERM', forced: cleanup.forced };
  }
  if (child.exitCode === null && child.signalCode === null) signalSmokeProcess(child, 'SIGKILL');
  if (!await waitForExit(child, 5_000)) throw new Error('smoke child did not exit after SIGTERM/SIGKILL');
  if (child?.[PROCESS_GROUP_FLAG] === true) await cleanupExitedSmokeProcessGroup(child.pid);
  return { signal: 'SIGKILL', forced: true };
}
async function writeHarnessLogs(root, id, stdout, stderr) {
  await writeFile(join(root, id + '.stdout.log'), (await stdout.text()).join(''));
  await writeFile(join(root, id + '.stderr.log'), (await stderr.text()).join(''));
}
