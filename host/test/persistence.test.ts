import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, writeFile, rm, symlink, rename, readdir, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DocumentStore, FileConflict, diskVersion, observeSaveAsDestination } from '../src/persistence.js';
import { observeFile, writeAtomicText } from '../src/configuration.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

test('persists physical notebook bytes atomically and preserves no-op bytes/mode', async () => {
  const dir = await temporaryDirectory('alder-store-');
  try {
    const path = join(dir, 'notebook.R');
    const source = '# header\r\n# %% [markdown]\r\n# title';
    await writeFile(path, source);
    await chmod(path, 0o640);
    const { store, notebook } = await DocumentStore.open(path);
    const noop = await store.save(notebook);
    assert.equal(noop.changed, false);
    assert.equal(await readFile(path, 'utf8'), source);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    const changed = { ...notebook, cells: [{ ...notebook.cells[0]!, body: ['# changed'] }] };
    assert.equal((await store.save(changed)).changed, true);
    assert.equal(await readFile(path, 'utf8'), '# header\r\n# %% [markdown]\r\n# changed');
    assert.equal((await stat(path)).mode & 0o777, 0o640);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('header-only no-op saves preserve missing final newline bytes', async () => {
  const dir = await temporaryDirectory('alder-store-header-only-');
  try {
    const path = join(dir, 'notebook.R');
    const source = '# header';
    await writeFile(path, source);
    const { store, notebook } = await DocumentStore.open(path);
    const result = await store.save(notebook);
    assert.equal(result.changed, false);
    assert.deepEqual(await readFile(path), Buffer.from(source));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleting all cells still normalizes the deleted-cell boundary', async () => {
  const dir = await temporaryDirectory('alder-store-delete-all-');
  try {
    const path = join(dir, 'notebook.R');
    const source = '# header\n# %%\nvalue';
    await writeFile(path, source);
    const { store, notebook } = await DocumentStore.open(path);
    const result = await store.save({ ...notebook, cells: [] });
    assert.equal(result.changed, true);
    assert.deepEqual(await readFile(path), Buffer.from('# header'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('new source save and external replacement preserve source_conflict and dirty bytes', async () => {
  const dir = await temporaryDirectory('alder-store-new-');
  try {
    const path = join(dir, 'notebook.R');
    const { store } = await DocumentStore.open(path);
    const source = { path, cells: [{ id: 'cell-1', type: 'code' as const, body: ['x <- 1'], options: {} }] };
    assert.equal((await store.save(source)).changed, true);
    assert.equal(await readFile(path, 'utf8'), '# %%\nx <- 1\n');
    await writeFile(path, '# %%\npeer <- 2\n');
    await assert.rejects(store.save({ ...source, cells: [{ ...source.cells[0]!, body: ['local <- 3'] }] }), (error) => error instanceof FileConflict && error.code === 'source_conflict');
    assert.equal(await readFile(path, 'utf8'), '# %%\npeer <- 2\n');
    assert.deepEqual(await readdir(dir), ['notebook.R']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source symlink aliases are canonical and retargeting cannot replace another target', async () => {
  const dir = await temporaryDirectory('alder-source-link-');
  try {
    const first = join(dir, 'first.R'), second = join(dir, 'second.R'), alias = join(dir, 'notebook.R');
    await writeFile(first, '# %%\nfirst\n'); await writeFile(second, '# %%\nsecond\n'); await symlink(first, alias);
    const { store, notebook } = await DocumentStore.open(alias);
    await rm(alias); await symlink(second, alias);
    await assert.rejects(store.save({ ...notebook, cells: [{ ...notebook.cells[0]!, body: ['local'] }] }), { code: 'source_conflict' });
    assert.equal(await readFile(first, 'utf8'), '# %%\nfirst\n'); assert.equal(await readFile(second, 'utf8'), '# %%\nsecond\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sidecar staged write rechecks replacement and leaves external partial save intact', async () => {
  const dir = await temporaryDirectory('alder-sidecar-');
  try {
    const sidecar = join(dir, '.alder', 'config.yaml');
    await mkdir(join(dir, '.alder')); await writeFile(sidecar, 'cache:\n  dir: cache-a\n');
    const expected = await observeFile(sidecar);
    await assert.rejects(writeAtomicText(sidecar, 'cache:\n  dir: cache-b\n', { expected, beforeReplace: async (file) => { await writeFile(file, 'cache:\n  dir: external-cache\n'); } }), { code: 'source_conflict' });
    assert.equal(await readFile(sidecar, 'utf8'), 'cache:\n  dir: external-cache\n');
    assert.deepEqual((await readdir(join(dir, '.alder'))).sort(), ['config.yaml']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Save As preserves exact bytes and leaves a successful save durable', async () => {
  const dir = await temporaryDirectory('alder-save-as-');
  try {
    const path = join(dir, 'source.R'), destination = join(dir, 'copy.R');
    const bytes = Buffer.from('\ufeff# header\r\n# %%\r\nx <- "café"');
    await writeFile(path, bytes);
    const { store } = await DocumentStore.open(path);
    const discarded = await store.prepareSaveAs(destination, store.currentDocument);
    await discarded.abort();
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    assert.deepEqual(await readdir(dir), ['source.R']);
    const prepared = await store.prepareSaveAs(destination, store.currentDocument);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    const published = await prepared.publish();
    assert.equal(published.result.changed, true);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(await readFile(destination), bytes);
    const reopened = await DocumentStore.open(destination);
    assert.deepEqual(Buffer.from(reopened.store.sourceVersion.bytes), bytes);
    assert.equal((await published.store.save(published.store.currentDocument)).changed, false);
    await assert.rejects(store.prepareSaveAs(destination, store.currentDocument), { code: 'destination_exists' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Save As replaces only the exact destination explicitly confirmed by the caller', async () => {
  const dir = await temporaryDirectory('alder-save-as-replace-');
  try {
    const path = join(dir, 'source.R'), destination = join(dir, 'copy.R');
    await writeFile(path, '# %%\nsource\n');
    await writeFile(destination, '# %%\nprevious\n');
    await chmod(destination, 0o640);
    const { store } = await DocumentStore.open(path);
    await assert.rejects(store.prepareSaveAs(destination, store.currentDocument), { code: 'destination_exists' });
    const observed = await observeSaveAsDestination(destination);
    const replacement = { expectedDiskDigest: observed.digest!, expectedDiskVersion: observed.version! };
    const prepared = await store.prepareSaveAs(destination, store.currentDocument, replacement);
    assert.equal(await readFile(destination, 'utf8'), '# %%\nprevious\n');
    const published = await prepared.publish();
    assert.equal(await readFile(destination, 'utf8'), '# %%\nsource\n');
    assert.equal((await stat(destination)).mode & 0o777, 0o640);
    assert.equal(await readFile(path, 'utf8'), '# %%\nsource\n');
    await assert.rejects(store.prepareSaveAs(destination, store.currentDocument, replacement), { code: 'source_conflict' });
    assert.deepEqual((await readdir(dir)).sort(), ['copy.R', 'source.R']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Save As rejects destination edits and inode replacement between confirmation and commit', async () => {
  const dir = await temporaryDirectory('alder-save-as-conflict-');
  try {
    const path = join(dir, 'source.R'), destination = join(dir, 'copy.R');
    await writeFile(path, '# %%\nsource\n');
    const { store } = await DocumentStore.open(path);
    for (const change of ['edit', 'replace', 'delete', 'create'] as const) {
      await rm(destination, { force: true });
      if (change !== 'create') await writeFile(destination, '# %%\nprevious\n');
      const observed = await observeSaveAsDestination(destination);
      const replacement = observed.state === 'present'
        ? { expectedDiskDigest: observed.digest!, expectedDiskVersion: observed.version! }
        : undefined;
      const prepared = await store.prepareSaveAs(destination, store.currentDocument, replacement);
      if (change === 'replace') {
        await writeFile(join(dir, 'external.R'), '# %%\nprevious\n');
        await rename(join(dir, 'external.R'), destination);
      } else if (change === 'delete') {
        await rm(destination);
      } else {
        await writeFile(destination, '# %%\nexternal\n');
      }
      await assert.rejects(prepared.publish(), { code: 'source_conflict' });
      await prepared.abort();
      if (change === 'delete') await assert.rejects(readFile(destination), { code: 'ENOENT' });
      else assert.equal(await readFile(destination, 'utf8'), change === 'replace' ? '# %%\nprevious\n' : '# %%\nexternal\n');
      assert.equal((await readdir(dir)).some(file => file.startsWith('.alder-')), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed save leaves the original file and a later save can succeed', async () => {
  const dir = await temporaryDirectory('alder-save-failure-');
  const path = join(dir, 'source.R');
  try {
    const original = '# %%\noriginal\n';
    await writeFile(path, original);
    const { store, notebook } = await DocumentStore.open(path);
    const changed = { ...notebook, cells: [{ ...notebook.cells[0]!, body: ['changed'] }] };
    await chmod(dir, 0o500);
    await assert.rejects(store.save(changed), { code: 'EACCES' });
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await readdir(dir), ['source.R']);
    await chmod(dir, 0o700);
    assert.equal((await store.save(changed)).changed, true);
    assert.equal(await readFile(path, 'utf8'), '# %%\nchanged\n');
  } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});

test('failed Save As rename preserves the destination and staging can be cancelled', async () => {
  const dir = await temporaryDirectory('alder-save-as-failure-');
  try {
    const path = join(dir, 'source.R'), destination = join(dir, 'copy.R');
    await writeFile(path, '# %%\nsource\n');
    await writeFile(destination, '# %%\nprevious\n');
    const { store } = await DocumentStore.open(path);
    const observed = await observeSaveAsDestination(destination);
    const prepared = await store.prepareSaveAs(destination, store.currentDocument, {
      expectedDiskDigest: observed.digest!, expectedDiskVersion: observed.version!,
    });
    await chmod(dir, 0o500);
    await assert.rejects(prepared.publish(), { code: 'EACCES' });
    assert.equal(await readFile(destination, 'utf8'), '# %%\nprevious\n');
    await chmod(dir, 0o700);
    await prepared.abort();
    assert.deepEqual((await readdir(dir)).sort(), ['copy.R', 'source.R']);
  } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});

test('saving a new empty document creates an openable empty file', async () => {
  const dir = await temporaryDirectory('alder-save-empty-');
  try {
    const path = join(dir, 'empty.R');
    const { store, notebook } = await DocumentStore.open(path);
    assert.equal((await store.save(notebook)).changed, true);
    assert.deepEqual(await readFile(path), Buffer.alloc(0));
    const reopened = await DocumentStore.open(path);
    assert.equal((await reopened.store.save(reopened.notebook)).changed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent readers always see one complete version throughout repeated saves', async () => {
  const dir = await temporaryDirectory('alder-save-atomic-');
  try {
    const path = join(dir, 'source.R');
    const values = ['a', 'b'].map(char => char.repeat(100_000));
    const versions = new Set(values.map(value => '# %%\n' + value + '\n'));
    await writeFile(path, '# %%\n' + values[0] + '\n');
    const { store, notebook } = await DocumentStore.open(path);
    let finished = false;
    let observations = 0;
    const reader = (async () => {
      while (!finished) {
        assert.equal(versions.has(await readFile(path, 'utf8')), true);
        observations += 1;
      }
    })();
    try {
      for (let index = 0; index < 12; index += 1) {
        await store.save({ ...notebook, cells: [{ ...notebook.cells[0]!, body: [values[(index + 1) % 2]!] }] });
      }
    } finally {
      finished = true;
      await reader;
    }
    assert.ok(observations > 0);
    assert.deepEqual(await readdir(dir), ['source.R']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('prepared package sidecars normalize declarations and reject stale versions', async () => {
  const dir = await temporaryDirectory('alder-package-prepared-');
  try {
    const path = join(dir, 'notebook.R');
    await writeFile(path, '# %%\nvalue <- 1\n');
    const { store } = await DocumentStore.open(path);
    const metadata = join(dir, '.alder', 'packages.yaml');
    const expectedVersion = store.sidecarObservation('packages').version;
    const prepared = await store.preparePackages(['yaml', 'jsonlite', 'yaml'], expectedVersion);
    assert.deepEqual(prepared.value, ['jsonlite', 'yaml']);
    await assert.rejects(readFile(metadata), { code: 'ENOENT' });
    const published = await prepared.publish();
    assert.deepEqual(published.value, ['jsonlite', 'yaml']);
    assert.equal(await readFile(metadata, 'utf8'), 'packages:\n  - jsonlite\n  - yaml\n');
    await assert.rejects(
      store.preparePackages(['withr'], expectedVersion),
      (error) => error instanceof FileConflict && error.code === 'source_conflict',
    );
    assert.equal(await readFile(metadata, 'utf8'), 'packages:\n  - jsonlite\n  - yaml\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('prepared sidecar publication preserves an external edit', async () => {
  const dir = await temporaryDirectory('alder-sidecar-conflict-');
  try {
    const path = join(dir, 'notebook.R');
    await writeFile(path, '# %%\nx <- 1\n');
    const { store } = await DocumentStore.open(path);
    const prepared = await store.preparePackages(['yaml'], null);
    const metadata = store.sidecarPath('packages');
    await writeFile(metadata, 'packages:\n  - withr\n');
    await assert.rejects(prepared.publish(), error => error instanceof FileConflict && error.kind === 'sidecar');
    await prepared.abort();
    assert.equal(await readFile(metadata, 'utf8'), 'packages:\n  - withr\n');
    assert.deepEqual(await readdir(join(dir, '.alder')), ['packages.yaml']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('prepareReload enforces the observed disk version and preserves Controller document identities', async () => {
  const dir = await temporaryDirectory('alder-reload-');
  try {
    const path = join(dir, 'notebook.R');
    const nl = String.fromCharCode(10);
    await writeFile(path, ['# %%', 'one', '# %%', 'two', ''].join(nl));
    const { store } = await DocumentStore.open(path);
    const original = store.currentDocument;
    const controllerDocument = {
      ...original,
      cells: original.cells.map((cell, index) => index === 1 ? { ...cell, id: 'controller-two' } : cell),
    };
    await writeFile(path, ['# %%', 'one', '# %%', 'inserted', '# %%', 'two', ''].join(nl));
    const current = await diskVersion(path);
    const expectedDiskVersion = current.identity + ':' + current.mode.toString(8) + ':' + current.digest;
    const aborted = await store.prepareReload({ expectedDiskDigest: current.digest, expectedDiskVersion }, controllerDocument);
    assert.equal(aborted.observation.digest, current.digest);
    assert.equal(store.currentDocument.cells.length, 2);
    const prepared = await store.prepareReload({ expectedDiskDigest: current.digest, expectedDiskVersion }, controllerDocument);
    const reloaded = prepared.notebook;
    assert.equal(reloaded.cells.length, 3);
    assert.equal(reloaded.cells[0]!.id, original.cells[0]!.id);
    assert.equal(reloaded.cells[2]!.id, 'controller-two');
    prepared.adopt();
    assert.equal(store.currentDocument.cells[2]!.id, 'controller-two');
    assert.equal(Buffer.from(await readFile(path)).toString(), ['# %%', 'one', '# %%', 'inserted', '# %%', 'two', ''].join(nl));
    await writeFile(path, ['# %%', 'external', '# %%', 'two', ''].join(nl));
    await assert.rejects(store.prepareReload({ expectedDiskDigest: current.digest, expectedDiskVersion }, controllerDocument), (error) => error instanceof FileConflict && error.code === 'source_conflict');
    assert.equal(store.currentDocument.cells[1]!.body[0], 'inserted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refreshes external source observations without moving the save baseline', async () => {
  const dir = await temporaryDirectory('alder-refresh-');
  try {
    const path = join(dir, 'notebook.R');
    const external = join(dir, 'external.R');
    await writeFile(path, '# %%\nlocal\n');
    const { store, notebook } = await DocumentStore.open(path);
    const baseline = store.sourceVersion;
    await writeFile(external, '# %%\nexternal\n');
    await rename(external, path);
    const replaced = await store.refreshObservations();
    assert.equal(replaced.source.state, 'present');
    assert.equal(replaced.source.digest, sha256(Buffer.from('# %%\nexternal\n')));
    assert.notEqual(store.observation().digest, baseline.digest);
    assert.equal(store.sourceVersion.identity, baseline.identity);
    assert.equal(store.sourceVersion.digest, baseline.digest);
    await assert.rejects(store.save(notebook), error => error instanceof FileConflict && error.code === 'source_conflict');
    await rm(path);
    const absent = await store.refreshObservations();
    assert.equal(absent.source.state, 'absent');
    assert.equal(store.observation().state, 'absent');
    assert.equal(store.sourceVersion.identity, baseline.identity);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
