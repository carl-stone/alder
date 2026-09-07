import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile, rm, symlink, link, readdir, lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore, sameFile, type RServices } from '../src/services.js';

function codec(beforeEncode?: () => Promise<void>): RServices {
  return { async service(command, payload = {}) {
    if (command === 'codec.decode') return { notebook: { cells: [] } };
    if (command === 'codec.encode') {
      await beforeEncode?.();
      return { bytes: Buffer.from('saved\n').toString('base64'), ids: [] };
    }
    throw new Error(`Unexpected ${command}`);
  } };
}

test('saves existing and new files atomically and rejects external changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-store-'));
  try {
    const path = join(dir, 'notebook.R');
    const { store } = await DocumentStore.open(path, codec());
    await store.save({ cells: [] });
    assert.equal(await readFile(path, 'utf8'), 'saved\n');
    await writeFile(path, 'external');
    await assert.rejects(store.save({ cells: [] }), { code: 'source_conflict' });
    assert.equal(await readFile(path, 'utf8'), 'external');
    assert.deepEqual(await readdir(dir), ['notebook.R']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sidecar saves preserve symlinks and reject retargeted aliases', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-sidecar-'));
  try {
    const path = join(dir, 'notebook.R'), layout = `${path}.alder-layout.json`;
    const target = join(dir, 'layout.json'), replacement = join(dir, 'replacement.json');
    await writeFile(path, '');
    await writeFile(target, '{}');
    await writeFile(replacement, '{}');
    await symlink(target, layout);
    const base = codec();
    const { store } = await DocumentStore.open(path, { service: async (command, payload) =>
      command === 'layout.encode' ? { layout: payload?.layout, text: '{"ok":true}' } : base.service(command, payload) });
    await store.updateLayout({ ok: true });
    assert.equal((await lstat(layout)).isSymbolicLink(), true);
    assert.equal(await readFile(target, 'utf8'), '{"ok":true}');
    await rm(layout);
    await symlink(replacement, layout);
    await assert.rejects(store.updateLayout({ ok: true }), { code: 'source_conflict' });
    assert.equal(await readFile(replacement, 'utf8'), '{}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checks bytes again after slow codec and cleans its staged file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-store-'));
  try {
    const path = join(dir, 'notebook.R');
    await writeFile(path, 'original');
    const { store } = await DocumentStore.open(path, codec(() => writeFile(path, 'external')));
    await assert.rejects(store.save({ cells: [] }), { code: 'source_conflict' });
    assert.equal(await readFile(path, 'utf8'), 'external');
    assert.deepEqual(await readdir(dir), ['notebook.R']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('resolves symlinks and recognizes hard link aliases', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-store-'));
  try {
    const path = join(dir, 'notebook.R'), alias = join(dir, 'alias.R'), hard = join(dir, 'hard.R');
    await writeFile(path, 'original');
    await symlink(path, alias);
    await link(path, hard);
    assert.equal(await sameFile(path, alias), true);
    assert.equal(await sameFile(path, hard), true);
    const { store } = await DocumentStore.open(alias, codec());
    await store.save({ cells: [] });
    assert.equal(await readFile(alias, 'utf8'), 'saved\n');
    assert.equal(await readFile(path, 'utf8'), 'saved\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('codec responses are validated before source bytes can be replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-codec-boundary-'));
  try {
    const path = join(dir, 'notebook.R');
    await writeFile(path, 'original');
    await assert.rejects(DocumentStore.open(path, { async service() {
      return { notebook: { cells: [{ id: 'same', type: 'code', body: [], revision: 0 },
        { id: 'same', type: 'code', body: [], revision: 0 }] } };
    } }), { code: 'invalid_service_response' });

    for (const encoded of [
      { bytes: 'not base64', ids: ['cell-1'] },
      { bytes: Buffer.from('replacement').toString('base64'), ids: ['wrong-cell'] },
    ]) {
      const { store } = await DocumentStore.open(path, { async service(command) {
        if (command === 'codec.decode') return { notebook: { cells: [
          { id: 'cell-1', type: 'code', body: ['original'], options: {}, revision: 0 },
        ] } };
        if (command === 'codec.encode') return encoded;
        throw new Error(`Unexpected ${command}`);
      } });
      await assert.rejects(store.save({ cells: [
        { id: 'cell-1', type: 'code', body: ['replacement'], options: {}, revision: 1 },
      ] }), { code: 'invalid_service_response' });
      assert.equal(await readFile(path, 'utf8'), 'original');
      assert.deepEqual(await readdir(dir), ['notebook.R']);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('save preserves exact permissions and treats an external chmod as a conflict', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-store-mode-'));
  try {
    const path = join(dir, 'notebook.R');
    await writeFile(path, 'original');
    await chmod(path, 0o660);
    const { store } = await DocumentStore.open(path, codec());
    await store.save({ cells: [] });
    assert.equal((await stat(path)).mode & 0o777, 0o660);

    const changed = await DocumentStore.open(path, codec(() => chmod(path, 0o600)));
    await assert.rejects(changed.store.save({ cells: [] }), { code: 'source_conflict' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, 'utf8'), 'saved\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('retargeting the opened source symlink during serialization cannot replace either target', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-source-link-'));
  try {
    const first = join(dir, 'first.R'), second = join(dir, 'second.R'), alias = join(dir, 'notebook.R');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    await symlink(first, alias);
    const { store } = await DocumentStore.open(alias, codec(async () => {
      await rm(alias);
      await symlink(second, alias);
    }));
    await assert.rejects(store.save({ cells: [] }), { code: 'source_conflict' });
    assert.equal(await readFile(first, 'utf8'), 'first');
    assert.equal(await readFile(second, 'utf8'), 'second');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expected source accepts only its canonical base64 representation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-expected-source-'));
  try {
    const path = join(dir, 'notebook.R');
    await writeFile(path, 'source');
    const { store } = await DocumentStore.open(path, codec());
    assert.equal(store.matchesSource(Buffer.from('source').toString('base64')), true);
    assert.equal(store.matchesSource('c291cmNl\n'), false);
    assert.equal(store.matchesSource('!!!!'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('document snapshots reuse source work without leaking runtime values or stale edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-document-'));
  const requests: Record<string, unknown>[] = [];
  let rejectNext = false;
  try {
    const { store } = await DocumentStore.open(join(dir, 'notebook.R'), {
      async service(command, payload = {}) {
        if (command === 'codec.decode') return { notebook: { cells: [] } };
        assert.equal(command, 'codec.document');
        requests.push(payload);
        await new Promise(resolve => setImmediate(resolve));
        if (rejectNext) { rejectNext = false; throw new Error('codec failed'); }
        const cells = payload.cells as Array<{ id: string; body_base64: string[] }>;
        assert.equal(JSON.stringify(cells).includes('"body"'), false);
        const decoded = cells.map(cell => ({
          id: cell.id,
          body: cell.body_base64.map(line => Buffer.from(line, 'base64').toString('utf8')),
        }));
        return { text: decoded.map(cell => cell.body.join('\n')).join('\n'), cells: decoded };
      },
    });
    const first = { cells: [{ id: 'one', type: 'code' as const, body: ['x <- 1'], revision: 0, options: {}, outputs: [{ secret: 'large live value' }] }] };
    const [a, b] = await Promise.all([store.document(first), store.document({ cells: first.cells.map(cell => ({ ...cell, outputs: [] })) })]) as any[];
    assert.equal(requests.length, 1, 'identical source requests must share in-flight work');
    assert.equal(JSON.stringify(requests).includes('secret'), false);
    assert.equal(a.text, 'x <- 1');
    a.cells[0].body[0] = 'mutated response';
    assert.equal(b.cells[0].body[0], 'x <- 1');
    const next = { cells: [{ ...first.cells[0]!, body: ['x <- 2'], revision: 1 }] };
    rejectNext = true;
    await assert.rejects(store.document(next), /codec failed/);
    assert.equal((await store.document(next) as { text: string }).text, 'x <- 2');
    assert.equal((await store.document(first) as { text: string }).text, 'x <- 1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compact codec records reconstruct physical text and reject noncanonical bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alder-compact-codec-'));
  const path = join(dir, 'notebook.R');
  const line = (value: string) => Buffer.from(value).toString('base64');
  let invalid = false;
  try {
    await writeFile(path, '# %%\r\nx <- 1\n');
    const { store, notebook } = await DocumentStore.open(path, { async service(command) {
      if (command === 'codec.decode') return { notebook: {
        encoding: 'base64-lines-v1', path, metadata: {}, cells: [{
          id: 'cell-1', type: 'code', body_base64: [line('x <- 1')], options: {}, revision: 0,
        }],
      } };
      if (command === 'codec.document') return {
        encoding: 'base64-lines-v1', path,
        headerRecords: [{ text_base64: line('# %%'), eol: '\r\n', kind: 'marker' }],
        cells: [{ id: 'cell-1', type: 'code', records: [{
          text_base64: invalid ? 'eA' : line('x <- 2'), eol: '\n', kind: 'body',
        }] }],
      };
      throw new Error(`Unexpected ${command}`);
    } });
    assert.deepEqual(notebook.cells[0]?.body, ['x <- 1']);
    const document = await store.document({ cells: [{
      id: 'cell-1', type: 'code', body: ['x <- 2'], options: {}, revision: 1,
    }] }) as { text: string; cells: Array<{ body: string[] }> };
    assert.equal(document.text, '# %%\r\nx <- 2\n');
    assert.deepEqual(document.cells[0]?.body, ['x <- 2']);

    invalid = true;
    await assert.rejects(store.document({ cells: [{
      id: 'cell-1', type: 'code', body: ['x <- 3'], options: {}, revision: 2,
    }] }), { code: 'invalid_service_response' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
