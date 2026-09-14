import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, writeFile, rm, symlink, link, rename, readdir, stat, mkdir, utimes, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentStore, FileConflict, sameFile, diskVersion } from '../src/persistence.js';
import { observeFile, writeAtomicText } from '../src/configuration.js';
import { RecoveryError, RecoveryWriter } from '../src/recovery.js';
import { createHash } from 'node:crypto';
import { secureWindowsPath } from './windows-fixtures.js';

const recoveryOptions = process.platform === 'win32'
  ? { processSupervisorExecutable: resolve(fileURLToPath(new URL('../.application/resources/runtime/alder-process-supervisor.exe', import.meta.url))) }
  : {};
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await secureWindowsPath("directory", directory);
  return directory;
}

const recoveryObservation = { state: 'absent' as const, digest: null, version: null, error: null };
const recoverySidecars = { config: recoveryObservation, layout: recoveryObservation, packages: recoveryObservation };
function recoverySha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function recoveryBaseline(documentRevision: number, bytes: Uint8Array, cells: readonly { id: string; revision: number }[] = [{ id: 'cell-1', revision: 0 }]) {
  return { schemaVersion: 1 as const, documentRevision, physicalBytes: Buffer.from(bytes).toString('base64'), cells, notebookDiskObservation: recoveryObservation, sidecarObservations: recoverySidecars };
}
function recoveryDelta(
  base: Uint8Array,
  result: Uint8Array,
  cells: readonly { id: string; revision: number }[],
  pieces: readonly ({ kind: 'copy'; offset: number; length: number } | { kind: 'literal'; data: string })[] = [{ kind: 'literal', data: Buffer.from(result).toString('base64') }],
) {
  return { kind: 'source' as const, baseLength: base.byteLength, baseSha256: recoverySha256(base), resultLength: result.byteLength, resultSha256: recoverySha256(result), pieces, cells, notebookDiskObservation: recoveryObservation, sidecarObservations: recoverySidecars };
}

test('persists physical notebook bytes atomically and preserves no-op bytes/mode', { skip: process.platform === 'win32' }, async () => {
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

test('header-only no-op saves preserve missing final newline bytes', { skip: process.platform === 'win32' }, async () => {
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

test('deleting all cells still normalizes the deleted-cell boundary', { skip: process.platform === 'win32' }, async () => {
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

test('source symlink aliases are canonical and retargeting cannot replace another target', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-source-link-');
  try {
    const first = join(dir, 'first.R'), second = join(dir, 'second.R'), alias = join(dir, 'notebook.R'), hard = join(dir, 'hard.R');
    await writeFile(first, '# %%\nfirst\n'); await writeFile(second, '# %%\nsecond\n'); await symlink(first, alias); await link(first, hard);
    assert.equal(await sameFile(first, alias), true); assert.equal(await sameFile(first, hard), true);
    const { store, notebook } = await DocumentStore.open(alias);
    await rm(alias); await symlink(second, alias);
    await assert.rejects(store.save({ ...notebook, cells: [{ ...notebook.cells[0]!, body: ['local'] }] }), { code: 'source_conflict' });
    assert.equal(await readFile(first, 'utf8'), '# %%\nfirst\n'); assert.equal(await readFile(second, 'utf8'), '# %%\nsecond\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sidecar staged write rechecks replacement and leaves external partial save intact', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-sidecar-');
  try {
    const sidecar = join(dir, '.alder', 'config.yaml');
    await mkdir(join(dir, '.alder')); await writeFile(sidecar, 'theme: dark\n');
    const expected = await observeFile(sidecar);
    await assert.rejects(writeAtomicText(sidecar, 'theme: light\n', { expected, beforeReplace: async (file) => { await writeFile(file, 'external: true\n'); } }), { code: 'source_conflict' });
    assert.equal(await readFile(sidecar, 'utf8'), 'external: true\n');
    assert.deepEqual((await readdir(join(dir, '.alder'))).sort(), ['config.yaml']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Save As publishes exclusively to an absent destination', async () => {
  const dir = await temporaryDirectory('alder-save-as-');
  try {
    const path = join(dir, 'source.R'), destination = join(dir, 'copy.R'); await writeFile(path, '# %%\nsource\n');
    const { store } = await DocumentStore.open(path);
    const prepared = await store.prepareSaveAs(destination, store.currentDocument);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    const published = await prepared.publish();
    assert.equal(published.result.changed, true);
    assert.equal(await readFile(destination, 'utf8'), '# %%\nsource\n');
    if (process.platform !== 'win32') await chmod(destination, 0o640);
    await published.abort();
    assert.equal(await readFile(destination, 'utf8'), '# %%\nsource\n');
    await rm(destination);
    const adopted = await (await store.prepareSaveAs(destination, store.currentDocument)).publish();
    adopted.adopt();
    await adopted.abort();
    assert.equal(await readFile(destination, 'utf8'), '# %%\nsource\n');
    await assert.rejects(store.prepareSaveAs(destination, store.currentDocument), { code: 'destination_exists' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recovery keys are stable, private, and transferred only after Save As adoption', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-recovery-key-');
  const base = recoveryBaseline(0, Buffer.from([0]));
  let source: RecoveryWriter | undefined;
  let reopened: RecoveryWriter | undefined;
  let target: RecoveryWriter | undefined;
  try {
    source = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'source', baseline: base });
    const sourceKeyPath = join(source.directory, 'recovery.key');
    const sourceKeyBytes = await readFile(sourceKeyPath);
    assert.equal(sourceKeyBytes.byteLength, 32);
    assert.match(source.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(sourceKeyPath)).mode & 0o777, 0o600);
    const sourceKey = source.recoveryKey;
    await source.close();
    source = undefined;
    reopened = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'source', baseline: base });
    assert.equal(reopened.recoveryKey, sourceKey);
    await reopened.close();
    reopened = undefined;
    await writeFile(sourceKeyPath, Buffer.from('malformed'), { mode: 0o600 });
    await assert.rejects(
      RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'source', baseline: base }),
      error => error instanceof RecoveryError && error.code === 'recovery_corrupt',
    );
    await writeFile(sourceKeyPath, sourceKeyBytes, { mode: 0o600 });
    await chmod(sourceKeyPath, 0o640);
    await assert.rejects(
      RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'source', baseline: base }),
      error => error instanceof RecoveryError && error.code === 'recovery_corrupt',
    );
    await chmod(sourceKeyPath, 0o600);
    source = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'source', baseline: base });
    const prepared = await source.prepareRebind({ rootDir: dir, key: 'destination', baseline: base });
    const targetKeyPath = join(prepared.writer.directory, 'recovery.key');
    await assert.rejects(readFile(targetKeyPath), { code: 'ENOENT' });
    await prepared.publish();
    assert.equal((await readFile(targetKeyPath)).equals(sourceKeyBytes), true);
    assert.equal((await readFile(sourceKeyPath)).equals(sourceKeyBytes), true);
    prepared.adopt();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(sourceKeyPath);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
        break;
      }
      if (attempt === 99) assert.fail('source recovery key was not retired after adoption');
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
    }
    target = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'destination', baseline: base });
    assert.equal(target.recoveryKey, sourceKey);
  } finally {
    await target?.close().catch(() => undefined);
    await reopened?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing or invalid recovery pointers fail on a corrupt newest generation', async () => {
  for (const pointerKind of ['missing', 'invalid'] as const) {
    const dir = await temporaryDirectory('alder-recovery-pointer-' + pointerKind + '-');
    const baseBytes = Buffer.from([0]);
    const base = recoveryBaseline(0, baseBytes);
    try {
      const writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'pointer-' + pointerKind, baseline: base });
      const directory = writer.directory;
      const baselinePath = writer.currentBaselinePath!;
      const logPath = writer.currentLogPath!;
      const baselineBytes = await readFile(baselinePath);
      const logBytes = await readFile(logPath);
      await writer.close();
      const newest = 'newest-' + pointerKind;
      const newestBaselinePath = join(directory, 'baseline-' + newest + '.json');
      const newestLogPath = join(directory, 'log-' + newest + '.bin');
      await writeFile(newestBaselinePath, baselineBytes, { mode: 0o600 });
      await secureWindowsPath('file', newestBaselinePath);
      await writeFile(newestLogPath, logBytes, { mode: 0o600 });
      await secureWindowsPath('file', newestLogPath);
      await writeFile(newestBaselinePath, Buffer.from('{'), { mode: 0o600 });
      await secureWindowsPath('file', newestBaselinePath);
      const newestTime = new Date(Date.now() + 1000);
      await utimes(newestBaselinePath, newestTime, newestTime);
      const pointerPath = join(directory, 'current.json');
      if (pointerKind === 'missing') await rm(pointerPath);
      else await writeFile(pointerPath, Buffer.from('{not-json'), { mode: 0o600 });
      if (pointerKind !== 'missing') await secureWindowsPath('file', pointerPath);
      await assert.rejects(
        RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'pointer-' + pointerKind, baseline: base }),
        error => error instanceof RecoveryError && error.code === 'recovery_corrupt',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('recovery source frames preserve exact bytes, cell identity, torn tails, and tampering', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-recovery-'); const dirs = [dir];
  const baseBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x25, 0x25, 0x0d, 0x0a, 0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a]);
  const nextBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x25, 0x25, 0x0d, 0x0a, 0x42, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]);
  const baseCells = [{ id: 'cell-1', revision: 0 }, { id: 'cell-2', revision: 0 }];
  const nextCells = [{ id: 'cell-2', revision: 8 }, { id: 'cell-1', revision: 9 }];
  const pieces = [
    { kind: 'copy' as const, offset: 0, length: 9 },
    { kind: 'copy' as const, offset: 12, length: 3 },
    { kind: 'copy' as const, offset: 9, length: 3 },
  ];
  try {
    const base = recoveryBaseline(0, baseBytes, baseCells);
    const writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base });
    const next = recoveryBaseline(1, nextBytes, nextCells);
    const record = await writer.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, nextBytes, nextCells, pieces) });
    assert.deepEqual(record.delta.pieces, pieces);
    await assert.rejects(
      writer.append({ schemaVersion: 1, fromRevision: 1, toRevision: 2, delta: recoveryDelta(baseBytes, Buffer.from([0]), nextCells) }),
      error => error instanceof RecoveryError && error.code === 'recovery_write_failed',
    );
    const log = writer.currentLogPath!; await writer.close();
    const restored = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base });
    const materialized = await restored.materializedBaseline();
    assert.equal(materialized.physicalBytes, next.physicalBytes);
    assert.deepEqual(materialized.cells, next.cells);
    await restored.close();
    const tornDir = await temporaryDirectory('alder-recovery-tail-'); dirs.push(tornDir);
    const torn = await RecoveryWriter.open({ ...recoveryOptions, rootDir: tornDir, key: 'notebook', baseline: base }); const tornLog = torn.currentLogPath!; await torn.close();
    const tail = await openFile(tornLog, 'a'); await tail.write(Buffer.from([0, 0, 0, 20, 123, 34])); await tail.close();
    const tailState = await RecoveryWriter.open({ ...recoveryOptions, rootDir: tornDir, key: 'notebook', baseline: base }); assert.equal((await tailState.load()).status, 'tail-discarded'); await tailState.close();
    const tamperDir = await temporaryDirectory('alder-recovery-tamper-'); dirs.push(tamperDir);
    const tamper = await RecoveryWriter.open({ ...recoveryOptions, rootDir: tamperDir, key: 'notebook', baseline: base });
    const tamperRecord = await tamper.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, nextBytes, nextCells, pieces) });
    const tamperLog = tamper.currentLogPath!; await tamper.close();
    const tampered = Buffer.from(await readFile(tamperLog));
    const tamperHash = Buffer.from(tamperRecord.sha256, 'ascii');
    const tamperHashOffset = tampered.indexOf(tamperHash);
    assert.notEqual(tamperHashOffset, -1);
    tampered[tamperHashOffset] = tampered[tamperHashOffset] === 0x30 ? 0x31 : 0x30;
    await writeFile(tamperLog, tampered);
    const tailTampered = await RecoveryWriter.open({ ...recoveryOptions, rootDir: tamperDir, key: 'notebook', baseline: base });
    const tailTamperedState = await tailTampered.load();
    assert.equal(tailTamperedState.status, 'tail-discarded');
    assert.equal((await readFile(tamperLog)).byteLength, 0);
    const tailTamperedBaseline = await tailTampered.materializedBaseline();
    assert.equal(tailTamperedBaseline.physicalBytes, base.physicalBytes);
    assert.deepEqual(tailTamperedBaseline.cells, base.cells);
    await tailTampered.close();

    const interiorDir = await temporaryDirectory('alder-recovery-interior-'); dirs.push(interiorDir);
    const interior = await RecoveryWriter.open({ ...recoveryOptions, rootDir: interiorDir, key: 'notebook', baseline: base });
    const interiorFirst = await interior.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, nextBytes, nextCells, pieces) });
    const secondBytes = Buffer.concat([nextBytes, Buffer.from([0x43])]);
    await interior.append({ schemaVersion: 1, fromRevision: 1, toRevision: 2, delta: recoveryDelta(nextBytes, secondBytes, nextCells) });
    const interiorLog = interior.currentLogPath!; await interior.close();
    const interiorBytes = Buffer.from(await readFile(interiorLog));
    const interiorHash = Buffer.from(interiorFirst.sha256, 'ascii');
    const interiorHashOffset = interiorBytes.indexOf(interiorHash);
    assert.notEqual(interiorHashOffset, -1);
    interiorBytes[interiorHashOffset] = interiorBytes[interiorHashOffset] === 0x30 ? 0x31 : 0x30;
    await writeFile(interiorLog, interiorBytes);
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: interiorDir, key: 'notebook', baseline: base }), error => error instanceof RecoveryError && error.code === 'recovery_corrupt');

    assert.equal(record.toRevision, 1); assert.equal(tamperRecord.toRevision, 1); assert.equal(log.endsWith('.bin'), true);
  } finally { for (const item of dirs) await rm(item, { recursive: true, force: true }); }
});

test('recovery rejects legacy schemas and incomplete sidecar maps', async () => {
  const dir = await temporaryDirectory('alder-recovery-sidecars-');
  const bytes = Buffer.from([0]);
  const base = recoveryBaseline(0, bytes);
  try {
    const writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base }); await writer.close();
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'legacy', baseline: { ...base, schemaVersion: 2 } as never }), error => error instanceof RecoveryError && error.code === 'recovery_invalid');
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'missing', baseline: { ...base, sidecarObservations: { config: recoveryObservation, layout: recoveryObservation } } as never }), error => error instanceof RecoveryError && error.code === 'recovery_invalid');
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'alias', baseline: { ...base, sidecarDiskObservation: { config: recoveryObservation } } as never }), error => error instanceof RecoveryError && error.code === 'recovery_invalid');
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook-alias', baseline: { ...base, notebookObservation: recoveryObservation } as never }), error => error instanceof RecoveryError && error.code === 'recovery_invalid');
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'present-without-identity', baseline: { ...base, notebookDiskObservation: { state: 'present', digest: null, version: null, error: null } } as never }), error => error instanceof RecoveryError && error.code === 'recovery_invalid');
    await assert.rejects(RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'unreadable-without-error', baseline: { ...base, notebookDiskObservation: { state: 'unreadable', digest: null, version: null, error: null } } as never }), error => error instanceof RecoveryError && error.code === 'recovery_invalid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('prepared package sidecars normalize declarations and reject stale versions', { skip: process.platform === 'win32' }, async () => {
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

test('recovery compacts source patches and retains the prior generation on failed publication', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-recovery-compaction-');
  const failureDir = await temporaryDirectory('alder-recovery-compaction-failure-');
  const oversizedDir = await temporaryDirectory('alder-recovery-compaction-oversized-');
  const initialFailureDir = await temporaryDirectory('alder-initial-failure-');
  const dirs = [dir, failureDir, oversizedDir, initialFailureDir];
  const baseBytes = Buffer.from([0]);
  const base = recoveryBaseline(0, baseBytes, [{ id: 'cell-0', revision: 0 }]);
  const limits = { maxLogBytes: 4096, maxRecordBytes: 2048, maxRecords: 2 };
  const revisionBytes = (revision: number) => Buffer.from('revision-' + revision);
  const revisionCells = (revision: number) => [{ id: 'cell-' + revision, revision }];
  try {
    const oversized = await RecoveryWriter.open({ ...recoveryOptions, rootDir: oversizedDir, key: 'oversized-notebook', baseline: base, limits: { ...limits, maxLogBytes: 64 } });
    const oversizedGeneration = oversized.currentGeneration;
    const oversizedFiles = await readdir(oversized.directory);
    await assert.rejects(
      oversized.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, revisionBytes(1), revisionCells(1)) }),
      error => error instanceof RecoveryError && error.code === 'recovery_write_failed',
    );
    assert.equal(oversized.currentGeneration, oversizedGeneration);
    assert.deepEqual(await readdir(oversized.directory), oversizedFiles);
    await oversized.close();

    const initialProbe = await RecoveryWriter.open({ ...recoveryOptions, rootDir: initialFailureDir, key: 'initial-failure', baseline: base, limits });
    const initialRecoveryDir = initialProbe.directory;
    const initialState = await initialProbe.load();
    assert.notEqual(initialState.generation, null);
    assert.equal(await initialProbe.clearIfMatch({ documentRevision: 0, fingerprint: initialState.fingerprint! }), true);
    assert.equal(initialProbe.currentGeneration, null);
    const initialPointerPath = join(initialRecoveryDir, 'current.json');
    await rm(initialPointerPath);
    await mkdir(initialPointerPath);
    await assert.rejects(
      initialProbe.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, revisionBytes(1), revisionCells(1)) }),
      error => error instanceof RecoveryError && error.code === 'recovery_write_failed',
    );
    assert.throws(
      () => initialProbe.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, revisionBytes(1), revisionCells(1)) }),
      error => error instanceof RecoveryError && error.code === 'recovery_write_failed',
    );
    const stagedInitialFiles = (await readdir(initialRecoveryDir)).filter(name => name.startsWith('baseline-') || name.startsWith('log-')).sort();
    assert.equal(stagedInitialFiles.length, 2);
    await initialProbe.close();
    await rm(initialPointerPath, { recursive: true, force: true });
    const initialRestored = await RecoveryWriter.open({ ...recoveryOptions, rootDir: initialFailureDir, key: 'initial-failure', baseline: base, limits });
    const initialBaseline = await initialRestored.materializedBaseline();
    assert.equal(initialBaseline.documentRevision, 0);
    assert.equal(initialBaseline.physicalBytes, base.physicalBytes);
    assert.deepEqual(initialBaseline.cells, base.cells);
    await initialRestored.close();

    const writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base, limits });
    const initialGeneration = writer.currentGeneration;
    assert.notEqual(initialGeneration, null);
    let priorBytes = baseBytes;
    let rolloverRevision: number | null = null;
    for (let revision = 1; revision <= 8; revision += 1) {
      const nextBytes = revisionBytes(revision);
      await writer.append({ schemaVersion: 1, fromRevision: revision - 1, toRevision: revision, delta: recoveryDelta(priorBytes, nextBytes, revisionCells(revision)) });
      priorBytes = nextBytes;
      if (writer.currentGeneration !== initialGeneration) {
        rolloverRevision = revision;
        break;
      }
    }
    assert.notEqual(rolloverRevision, null);
    const expected = recoveryBaseline(rolloverRevision!, revisionBytes(rolloverRevision!), revisionCells(rolloverRevision!));
    const materialized = await writer.materializedBaseline();
    assert.equal(materialized.documentRevision, expected.documentRevision);
    assert.equal(materialized.physicalBytes, expected.physicalBytes);
    assert.deepEqual(materialized.cells, expected.cells);
    const rolledGeneration = writer.currentGeneration;
    assert.notEqual(rolledGeneration, null);
    assert.notEqual(rolledGeneration, initialGeneration);
    const generationFiles = (await readdir(writer.directory)).filter(name => name.startsWith('baseline-') || name.startsWith('log-')).sort();
    assert.deepEqual(generationFiles, ['baseline-' + rolledGeneration + '.json', 'log-' + rolledGeneration + '.bin'].sort());
    await writer.close();

    const restored = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base, limits });
    const restoredBaseline = await restored.materializedBaseline();
    assert.equal(restored.currentGeneration, rolledGeneration);
    assert.equal(restoredBaseline.documentRevision, expected.documentRevision);
    assert.equal(restoredBaseline.physicalBytes, expected.physicalBytes);
    assert.deepEqual(restoredBaseline.cells, expected.cells);
    await restored.close();

    const failed = await RecoveryWriter.open({ ...recoveryOptions, rootDir: failureDir, key: 'failed-notebook', baseline: base, limits: { ...limits, maxRecords: 1 } });
    await failed.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, revisionBytes(1), revisionCells(1)) });
    const priorGeneration = failed.currentGeneration;
    const priorBaselinePath = failed.currentBaselinePath;
    const priorLogPath = failed.currentLogPath;
    assert.notEqual(priorGeneration, null);
    assert.notEqual(priorBaselinePath, null);
    assert.notEqual(priorLogPath, null);
    const pointerPath = join(failed.directory, 'current.json');
    const pointerBytes = await readFile(pointerPath);
    await rm(pointerPath);
    await mkdir(pointerPath);
    await assert.rejects(
      failed.append({ schemaVersion: 1, fromRevision: 1, toRevision: 2, delta: recoveryDelta(revisionBytes(1), revisionBytes(2), revisionCells(2)) }),
      error => error instanceof RecoveryError && error.code === 'recovery_write_failed',
    );
    assert.equal(failed.currentGeneration, priorGeneration);
    assert.equal((await stat(priorBaselinePath!)).isFile(), true);
    assert.equal((await stat(priorLogPath!)).isFile(), true);
    assert.equal((await readFile(priorBaselinePath!)).length > 0, true);
    assert.equal((await readFile(priorLogPath!)).length > 0, true);
    assert.deepEqual((await readdir(failed.directory)).sort(), ['baseline-' + priorGeneration + '.json', 'current.json', 'log-' + priorGeneration + '.bin', 'recovery.key'].sort());
    await failed.close();
    await rm(pointerPath, { recursive: true, force: true });
    await writeFile(pointerPath, pointerBytes, { mode: 0o600 });
    const failedRestored = await RecoveryWriter.open({ ...recoveryOptions, rootDir: failureDir, key: 'failed-notebook', baseline: base, limits: { ...limits, maxRecords: 1 } });
    const failedBaseline = await failedRestored.materializedBaseline();
    assert.equal(failedBaseline.documentRevision, 1);
    assert.equal(failedBaseline.physicalBytes, recoveryBaseline(1, revisionBytes(1), revisionCells(1)).physicalBytes);
    assert.deepEqual(failedBaseline.cells, revisionCells(1));
    await failedRestored.close();
  } finally {
    for (const item of dirs) await rm(item, { recursive: true, force: true });
  }
});

test('prepareReload requires bounded disk preconditions and preserves Controller document identities', { skip: process.platform === 'win32' }, async () => {
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
    aborted.abort();
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

test('recovery branches are bounded, durable, and prepared rebinds separate publication from adoption', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-branch-');
  let targetDir = await temporaryDirectory('alder-rebind-target-');
  let targetOnSeparateDevice = false;
  if (process.platform === 'linux') {
    let candidate: string | undefined;
    try {
      candidate = await mkdtemp('/dev/shm/alder-rebind-target-');
      if ((await stat(candidate)).dev !== (await stat(dir)).dev) {
        await rm(targetDir, { recursive: true, force: true });
        targetDir = candidate;
        targetOnSeparateDevice = true;
        candidate = undefined;
      }
    } catch {
      // A container may not expose a second filesystem; the same-filesystem
      // branch assertions still exercise the hard-link publication path.
    } finally {
      if (candidate !== undefined) await rm(candidate, { recursive: true, force: true });
    }
  }
  const abandonedDir = await realpath(await mkdtemp(join(tmpdir(), 'alder-rebind-abandoned-')));
  try {
    const nl = String.fromCharCode(10);
    if (targetOnSeparateDevice) assert.notEqual((await stat(dir)).dev, (await stat(targetDir)).dev);
    const baseBytes = Buffer.from(['# %%', 'base', ''].join(nl));
    const nextBytes = Buffer.from(['# %%', 'next', ''].join(nl));
    const base = recoveryBaseline(0, baseBytes);
    let writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base });
    await writer.append({ schemaVersion: 1, fromRevision: 0, toRevision: 1, delta: recoveryDelta(baseBytes, nextBytes, [{ id: 'cell-1', revision: 1 }]) });
    const branch = await writer.forkBranch({ id: 'draft' });
    assert.deepEqual(Object.keys(branch).sort(), ['documentRevision', 'fingerprint', 'id', 'status']);
    await writer.close();
    writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'notebook', baseline: base });
    assert.deepEqual(await writer.listBranches(), [branch]);
    const loaded = await writer.load();
    assert.deepEqual(loaded.branches, [branch]);
    const materialized = await writer.materializeBranch('draft');
    assert.equal(materialized.documentRevision, 1);
    assert.equal(materialized.physicalBytes, Buffer.from(nextBytes).toString('base64'));
    assert.equal(await writer.dropBranch('draft', { documentRevision: 0, fingerprint: branch.fingerprint }), false);
    assert.equal(await writer.dropBranch('draft', { documentRevision: branch.documentRevision, fingerprint: branch.fingerprint }), true);
    assert.deepEqual(await writer.listBranches(), []);
    const transferred = await writer.forkBranch({ id: 'draft-transfer' });
    const abandoned = await writer.prepareRebind({ rootDir: abandonedDir, key: 'notebook-abandoned', baseline: materialized });
    await assert.rejects(readFile(abandoned.writer.pointerPath), { code: 'ENOENT' });
    await abandoned.writer.close();
    const abandonedRestored = await RecoveryWriter.open({ ...recoveryOptions, rootDir: abandonedDir, key: 'notebook-abandoned', baseline: base });
    assert.equal((await abandonedRestored.materializedBaseline()).physicalBytes, base.physicalBytes);
    await abandonedRestored.close();
    const prepared = await writer.prepareRebind({ rootDir: targetDir, key: 'notebook-copy', baseline: materialized });
    await assert.rejects(readFile(prepared.writer.pointerPath), { code: 'ENOENT' });
    await assert.rejects(readFile(prepared.writer.branchIndexPath), { code: 'ENOENT' });
    await prepared.publish();
    await prepared.adopt();
        assert.equal((await prepared.writer.materializedBaseline()).documentRevision, 1);
    assert.deepEqual(await writer.listBranches(), []);
    await prepared.abort();
    await prepared.writer.close();
    const restored = await RecoveryWriter.open({ ...recoveryOptions, rootDir: targetDir, key: 'notebook-copy', baseline: base });
    assert.deepEqual(await restored.listBranches(), [transferred]);
    assert.equal((await restored.materializeBranch('draft-transfer')).physicalBytes, materialized.physicalBytes);
    assert.equal((await restored.materializedBaseline()).physicalBytes, materialized.physicalBytes);
    await restored.close();
    await writer.close();
  } finally { await rm(dir, { recursive: true, force: true }); await rm(targetDir, { recursive: true, force: true }); await rm(abandonedDir, { recursive: true, force: true }); }
});

test('refreshes external source observations without moving the save baseline', { skip: process.platform === 'win32' }, async () => {
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
    assert.equal(replaced.source.digest, recoverySha256(Buffer.from('# %%\nexternal\n')));
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

test('repairs a mode-only recovery root before discarding corrupt tails', { skip: process.platform === 'win32' }, async () => {
  const dir = await temporaryDirectory('alder-recovery-root-');
  try {
    const baseBytes = Buffer.from('# %%\nbase\n');
    const baseline = recoveryBaseline(0, baseBytes);
    await chmod(dir, 0o755);
    const writer = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'root-repair', baseline });
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const log = writer.currentLogPath!;
    await writer.close();
    const invalidPayload = Buffer.from('{invalid\n');
    const invalidFrame = Buffer.allocUnsafe(4 + invalidPayload.length);
    invalidFrame.writeUInt32BE(invalidPayload.length, 0);
    invalidPayload.copy(invalidFrame, 4);
    await writeFile(log, invalidFrame);
    await chmod(dir, 0o755);
    const recovered = await RecoveryWriter.open({ ...recoveryOptions, rootDir: dir, key: 'root-repair', baseline });
    assert.equal((await recovered.load()).status, 'tail-discarded');
    assert.equal((await readFile(log)).byteLength, 0);
    await recovered.close();
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
