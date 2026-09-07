import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket, type RawData } from 'ws';
import { startGallery } from '../src/gallery.js';
import { startHost } from '../src/main.js';

test('gallery isolates notebook controllers and preserves selection across API requests', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-gallery-'));
  let gallery: Awaited<ReturnType<typeof startGallery>> | undefined;
  const hosts: Awaited<ReturnType<typeof startHost>>[] = [];
  const opened = new Map<string, number>();
  try {
    await writeFile(join(directory, 'one.R'), '# %%\nx <- 1\nx\n');
    await writeFile(join(directory, 'two.R'), '# %%\nx <- 2\nx\n');
    gallery = await startGallery({ path: directory, packagePath: process.env.ALDER_R_PACKAGE!,
      port: 0, runOnStartup: false }, async options => {
      const key = options.path!;
      opened.set(key, (opened.get(key) ?? 0) + 1);
      const host = await startHost(options);
      hosts.push(host);
      return host;
    });
    const origin = gallery.server.address().origin;
    const listing = await fetch(origin);
    assert.equal(listing.status, 200);
    assert.match(await listing.text(), /one\.R/);
    const firstResponses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${origin}/api/state?nb=one.R`)));
    assert.deepEqual(firstResponses.map(response => response.status), [200, 200, 200, 200]);
    const first = await firstResponses[0]!.json() as { epoch: string; cells: { body: string[]; status: string }[] };
    assert.equal([...opened.values()].reduce((sum, value) => sum + value, 0), 1,
      'concurrent requests share one controller for a notebook');
    const second = await (await fetch(`${origin}/api/state?nb=two.R`)).json() as typeof first;
    assert.notEqual(first.epoch, second.epoch);
    assert.equal(first.cells[0]!.body[0], 'x <- 1');
    assert.equal(second.cells[0]!.body[0], 'x <- 2');
    assert.equal(first.cells[0]!.status, 'idle');
    assert.equal((await fetch(`${origin}/n/one.R?nb=two.R`)).status, 400,
      'path and query cannot identify different controllers');
    assert.equal((await fetch(`${origin}/api/state?nb=..%2Foutside.R`)).status, 400);
    assert.equal((await fetch(`${origin}/api/state?nb=missing.R`)).status, 404);
    assert.equal((await fetch(`${origin}/api/state?nb=one.R`, { headers: { Origin: 'https://example.com' } })).status, 403);
    const oneSocket = await connect(`${origin}/api/socket?nb=one.R`, origin, 'alder_nb=two.R');
    const twoSocket = await connect(`${origin}/api/socket?nb=two.R`, origin, 'alder_nb=one.R');
    assert.equal(oneSocket.snapshot.epoch, first.epoch,
      'an explicit socket query overrides the process-wide fallback cookie');
    assert.equal(twoSocket.snapshot.epoch, second.epoch);
    assert.equal(oneSocket.snapshot.cells[0]!.body[0], 'x <- 1');
    assert.equal(twoSocket.snapshot.cells[0]!.body[0], 'x <- 2');
    assert.equal(hosts.length, 2);

    const socketClosures = [once(oneSocket.socket, 'close'), once(twoSocket.socket, 'close')];
    await gallery.close();
    await gallery.closed;
    await Promise.all([...socketClosures, ...hosts.map(host => host.closed)]);
  } finally { await gallery?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('gallery shutdown cannot activate notebook source after a pending open', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 15_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-gallery-opening-'));
  const path = join(directory, 'one.R');
  const opening = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let activated = false;
  let retired = false;
  let gallery: Awaited<ReturnType<typeof startGallery>> | undefined;
  try {
    await writeFile(path, '# %%\nx <- 1\n');
    gallery = await startGallery({ path: directory, packagePath: process.env.ALDER_R_PACKAGE!, port: 0 }, async () => {
      opening.resolve();
      await release.promise;
      return {
        controller: {
          snapshot: () => ({ path }),
          activateStartup: async () => { activated = true; },
        },
        close: async () => { retired = true; },
      } as unknown as Awaited<ReturnType<typeof startHost>>;
    });
    const pending = fetch(`${gallery.server.address().origin}/n/one.R`).catch(() => undefined);
    await opening.promise;
    const closing = gallery.close();
    release.resolve();
    await closing;
    await pending;
    assert.equal(activated, false);
    assert.equal(retired, true);
  } finally {
    release.resolve();
    await gallery?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function connect(url: string, origin: string, cookie: string): Promise<{
  socket: WebSocket;
  snapshot: { epoch: string; cells: { body: string[] }[] };
}> {
  const socket = new WebSocket(url, { origin, headers: { Cookie: cookie } });
  await once(socket, 'open');
  socket.send(JSON.stringify({
    type: 'connect', protocolVersion: 1,
    clientId: `gallery-test-${new URL(url).searchParams.get('nb')}`,
    epoch: null, cursor: null,
  }));
  const [raw] = await once(socket, 'message') as [RawData];
  const message = JSON.parse(raw.toString()) as {
    type: string;
    recovery?: { kind: string; snapshot?: { epoch: string; cells: { body: string[] }[] } };
  };
  assert.equal(message.type, 'recovery');
  assert.equal(message.recovery?.kind, 'snapshot');
  const snapshot = message.recovery?.snapshot;
  assert.ok(snapshot);
  return { socket, snapshot };
}
