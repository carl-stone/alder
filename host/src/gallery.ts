import { createServer, request as proxyRequest, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { type Socket } from 'node:net';
import { buildAllowedOrigins, validateLoopbackHost, validateRequestOrigin, type AlderServerAddress } from './server.js';
import { RJobs } from './jobs.js';
import type { HostOptions, startHost } from './main.js';

type NotebookHost = Awaited<ReturnType<typeof startHost>>;
interface Entry { basename: string; title?: string; description?: string; error?: unknown; }

export async function startGallery(options: HostOptions & { path: string; packagePath: string },
  openNotebook: (options: HostOptions) => Promise<NotebookHost>) {
  if (options.sandbox) throw new Error('sandbox mode requires a notebook file path');
  const root = await realpath(options.path), host = validateLoopbackHost(options.host ?? '127.0.0.1');
  if (!(await stat(root)).isDirectory()) throw new Error('gallery path must be a directory');
  const jobs = new RJobs({ rscript: options.rscript ?? process.env.ALDER_RSCRIPT ?? 'Rscript', packagePath: options.packagePath,
    environment: options.environment });
  const sessions = new Map<string, { app: NotebookHost; used: number; sockets: number }>();
  const sockets = new Set<Socket>();
  const epoch = randomUUID(), shutdownToken = randomUUID();
  let address: AlderServerAddress, stopped = false, clock = 0, queue = Promise.resolve();
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const origins = () => buildAllowedOrigins(address.port, options.allowedOrigins);
  let catalogPending: Promise<{ entries: Entry[]; config: { gallery?: { max_sessions?: number } } }> | undefined;
  const catalog = () => catalogPending ??= (jobs.run('gallery.catalog', { path: root }) as
    Promise<{ entries: Entry[]; config: { gallery?: { max_sessions?: number } } }>).finally(() => { catalogPending = undefined; });

  function select(request: IncomingMessage): string | null {
    const url = new URL(request.url ?? '/', address.origin);
    const pathKey = url.pathname.startsWith('/n/') ? decodeURIComponent(url.pathname.slice(3)) : null;
    const queryKeys = url.searchParams.getAll('nb');
    if (queryKeys.length > 1 || (pathKey !== null && queryKeys.length === 1 && pathKey !== queryKeys[0])) {
      throw Object.assign(new Error('ambiguous notebook selection'), { status: 400 });
    }
    let key = pathKey ?? queryKeys[0] ?? null;
    if (key === null) {
      const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('alder_nb='));
      if (cookies.length > 1) throw Object.assign(new Error('ambiguous notebook cookie'), { status: 400 });
      if (cookies[0]) key = decodeURIComponent(cookies[0].slice(9));
    }
    if (key !== null && (!key || basename(key) !== key || /[\\/\u0000]/.test(key) || key === '.' || key === '..')) {
      throw Object.assign(new Error('invalid notebook selection'), { status: 400 });
    }
    return key;
  }

  async function context(key: string) {
    let result!: { app: NotebookHost; used: number; sockets: number };
    const next = queue.then(async () => {
      if (stopped) throw new Error('gallery is closing');
      const existing = sessions.get(key);
      if (existing) { existing.used = ++clock; result = existing; return; }
      const current = await catalog();
      if (stopped) throw new Error('gallery is closing');
      const entry = current.entries.find(entry => entry.basename === key);
      if (!entry) throw Object.assign(new Error('notebook was not found'), { status: 404 });
      if (entry.error) throw Object.assign(new Error(typeof entry.error === 'object' && 'message' in entry.error
        ? String(entry.error.message) : 'notebook could not be parsed'), { status: 400 });
      const path = await realpath(join(root, key));
      if (resolve(path) !== join(root, key) || !(await stat(path)).isFile()) throw Object.assign(new Error('notebook is outside the gallery'), { status: 404 });
      if (stopped) throw new Error('gallery is closing');
      const configuredMaximum = current.config.gallery?.max_sessions;
      const maximum = typeof configuredMaximum === 'number' && Number.isSafeInteger(configuredMaximum)
        ? Math.min(32, Math.max(1, configuredMaximum)) : 4;
      if (sessions.size >= maximum) {
        const oldest = [...sessions].filter(([, value]) => value.sockets === 0 && !value.app.controller.snapshot().runtime.busy)
          .sort((a, b) => a[1].used - b[1].used)[0];
        if (!oldest) throw Object.assign(new Error('all gallery sessions are in use'), { status: 503 });
        if (oldest[1].app.controller.snapshot().changed) await oldest[1].app.controller.dispatch({ type: 'save', operationId: randomUUID(), sessionEpoch: oldest[1].app.controller.epoch });
        await oldest[1].app.close(); sessions.delete(oldest[0]);
      }
      if (stopped) throw new Error('gallery is closing');
      // Defer source execution until the opened store confirms the same
      // canonical file selected above. This also closes the final symlink-swap
      // window before a gallery notebook can execute.
      const app = await openNotebook({ ...options, path, port: 0, idleTimeout: 0, deferStartup: true,
        allowedOrigins: [...new Set([...origins(), address.origin])] });
      try {
        if (stopped) throw new Error('gallery is closing');
        if (app.controller.snapshot().path !== path) {
          throw Object.assign(new Error('notebook is outside the gallery'), { status: 404 });
        }
        if (!options.deferStartup) await app.controller.activateStartup();
      } catch (error) {
        await app.close();
        throw error;
      }
      result = { app, used: ++clock, sockets: 0 }; sessions.set(key, result);
    });
    queue = next.catch(() => {});
    await next;
    return result;
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (!validateRequestOrigin(request.headers, origins())) {
        response.writeHead(403).end(); return;
      }
      const url = new URL(request.url ?? '/', address.origin);
      if (url.pathname === '/api/shutdown') {
        if (request.method !== 'POST' || request.headers['x-alder-shutdown-token'] !== shutdownToken ||
          request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) {
          response.writeHead(403).end(); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        void close().catch(error => {
          process.stderr.write(`${String(error)}\n`);
          process.exitCode = 1;
        });
        return;
      }
      if (url.pathname === '/' && !url.searchParams.has('nb')) {
        if (request.method !== 'GET') { response.writeHead(405).end(); return; }
        const current = await catalog();
        const cards = current.entries.map(entry => `<article><h2>${escape(entry.title ?? entry.basename)}</h2>${entry.error
          ? '<p role="alert">This notebook could not be parsed.</p>'
          : `<a href="/n/${encodeURIComponent(entry.basename)}">Open ${escape(entry.basename)}</a>`}</article>`).join('');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
        response.end(`<!doctype html><html><head><title>Alder notebooks</title><style>body{font:16px system-ui;max-width:800px;margin:3rem auto;padding:0 1rem}article{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}</style></head><body><h1>Alder notebooks</h1>${cards || '<p>No Alder notebooks found.</p>'}</body></html>`); return;
      }
      const key = select(request);
      if (!key) { response.writeHead(400).end('Select a notebook'); return; }
      const selected = await context(key);
      if (url.pathname.startsWith('/n/')) {
        url.pathname = '/'; url.searchParams.set('nb', key);
        response.setHeader('Set-Cookie', `alder_nb=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict`);
      }
      const destination = selected.app.server.address()!;
      const upstream = proxyRequest(`${destination.origin}${url.pathname}${url.search}`, {
        method: request.method, headers: request.headers, timeout: 310_000,
      }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('notebook request timed out')));
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    })().catch(error => {
      if (response.writableEnded || response.destroyed) return;
      if (!response.headersSent) response.writeHead(typeof error.status === 'number' ? error.status : 400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'gallery_error', message: String(error.message ?? error) } }));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.maxConnections = 128;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('upgrade', (request, socket, head) => {
    socket.pause();
    const handshakeTimeout = setTimeout(() => socket.destroy(), 45_000);
    socket.once('close', () => clearTimeout(handshakeTimeout));
    void (async () => {
      if (!validateRequestOrigin(request.headers, origins())) throw new Error('origin not allowed');
      const url = new URL(request.url ?? '/', address.origin);
      if (url.pathname !== '/api/socket') throw new Error('unknown socket endpoint');
      const key = select(request); if (!key) throw new Error('select a notebook');
      const selected = await context(key);
      const upstream = proxyRequest(`${selected.app.server.address()!.origin}${url.pathname}${url.search}`, { headers: request.headers, timeout: 15_000 });
      upstream.on('upgrade', (incoming, peer, peerHead) => {
        clearTimeout(handshakeTimeout);
        selected.sockets++;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (peerHead.length) socket.write(peerHead);
        if (head.length) peer.write(head);
        socket.pipe(peer); peer.pipe(socket); socket.resume();
        socket.once('close', () => { selected.sockets--; peer.destroy(); });
        peer.once('close', () => socket.destroy());
        peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      });
      upstream.on('response', incoming => { incoming.resume(); socket.destroy(); });
      upstream.on('timeout', () => { upstream.destroy(); socket.destroy(); });
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy()); upstream.end();
    })().catch(() => socket.destroy());
  });
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      const failures: unknown[] = [];
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(error => {
        if (error) failures.push(error);
        resolve();
      }));
      try { await jobs.close(); } catch (error) { failures.push(error); }
      try { await queue; } catch (error) { failures.push(error); }
      const settled = await Promise.allSettled([...sessions.values()].map(value => value.app.close()));
      sessions.clear();
      for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, 'gallery did not close cleanly');
    })().finally(finish);
    return closing;
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8899, host, () => resolve()); });
    const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('gallery did not bind');
    address = { host, port: bound.port, origin: `http://${host === '::1' ? '[::1]' : host}:${bound.port}`, shutdownToken };
    origins();
    return { epoch, close, closed, server: { address: () => address } };
  } catch (error) { await close(); throw error; }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
