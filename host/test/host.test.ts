import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startHost } from '../src/main.js';
import { parseHostCommand } from '../src/protocol.js';

test('editor help synchronizes source only on request or for enabled diagnostics', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-help-idle-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# %%\ninitial_symbol <- function() 1\n');
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const installed = await import(pathToFileURL(join(process.env.ALDER_R_PACKAGE!, 'host', 'alder-host.mjs')).href);
    app = await (installed.startHost as typeof startHost)({ path, port: 0, runOnStartup: false,
      packagePath: process.env.ALDER_R_PACKAGE });
    const symbols = async () => {
      const response = await fetch(`${app!.server.address()!.origin}/api/lsp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'textDocument/documentSymbol', params: {} }),
      });
      assert.equal(response.status, 200);
      return response.text();
    };
    await symbols();
    let documentRequests = 0;
    let requestedSource: string[] = [];
    const service = app.engine.service.bind(app.engine);
    app.engine.service = (command, payload) => {
      if (command === 'codec.document') {
        documentRequests += 1;
        const cells = payload?.cells as Array<{ body_base64: string[] }>;
        requestedSource = cells[0]!.body_base64.map(line => Buffer.from(line, 'base64').toString('utf8'));
      }
      return service(command, payload);
    };
    const edit = async (name: string) => {
      const state = app!.controller.snapshot();
      await app!.controller.dispatch(parseHostCommand({
        type: 'edit', operationId: randomUUID(), sessionEpoch: state.epoch,
        edits: [{ cellId: 'cell-1', expectedRevision: state.cells[0]!.revision,
          cellType: 'code', body: [`${name} <- function() 2`] }],
      }));
    };
    await edit('fresh_symbol');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(documentRequests, 0, 'disabled diagnostics must not serialize edited source in the background');
    await symbols();
    assert.equal(documentRequests, 1);
    assert.deepEqual(requestedSource, ['fresh_symbol <- function() 2']);
    await app.controller.dispatch(parseHostCommand({
      type: 'set-config', operationId: randomUUID(), sessionEpoch: app.controller.snapshot().epoch,
      patch: { editor: { live_diagnostics: true } },
    }));
    await edit('diagnostic_symbol');
    const deadline = performance.now() + 5_000;
    while (documentRequests < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(documentRequests, 2, 'enabled diagnostics must still synchronize changed source');
    assert.deepEqual(requestedSource, ['diagnostic_symbol <- function() 2']);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('installed host runs exact edited source, saves bytes and exports committed results', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-host-integration-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# title\r\n# %%\r\na <- 1\r\na\r\n# %%\nb <- a + 1\nb\n# %%\nc <- b + 1\nc');
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const installed = await import(pathToFileURL(join(process.env.ALDER_R_PACKAGE!, 'host', 'alder-host.mjs')).href);
    app = await (installed.startHost as typeof startHost)({ path, port: 0, runOnStartup: false,
      packagePath: process.env.ALDER_R_PACKAGE });
    const controller = app.controller, snapshot = controller.snapshot();
    assert.equal(snapshot.runtime.executionReady, true);
    assert.equal(snapshot.cells.length, 3);
    const id = randomUUID();
    const receipt = await controller.dispatch(parseHostCommand({
      type: 'run', scope: 'all', operationId: id, sessionEpoch: snapshot.epoch,
      edits: [{ cellId: 'cell-1', expectedRevision: 0, cellType: 'code', body: ['a <- 40', 'a'] }],
    }));
    assert.equal(receipt.operation.id, id);
    const operation = await controller.awaitOperation(id);
    assert.equal(operation.status, 'done');
    const completed = controller.snapshot();
    assert.equal(completed.cells[0]!.revision, 1);
    assert.deepEqual(completed.cells.map(cell => cell.status), ['done', 'done', 'done']);
    assert.match(JSON.stringify(completed.cells[2]!.outputs), /42/);
    const url = app.server.address()!.origin;
    const http = await fetch(`${url}/api/state`);
    assert.equal(http.status, 200);
    const viaHttp = await http.json() as { cells: unknown[]; epoch: string };
    assert.equal(viaHttp.epoch, completed.epoch);
    assert.deepEqual(viaHttp.cells, completed.cells);
    await controller.dispatch(parseHostCommand({ type: 'save', operationId: randomUUID(), sessionEpoch: snapshot.epoch }));
    assert.equal(await readFile(path, 'utf8'), '# title\r\n# %%\r\na <- 40\r\na\r\n# %%\nb <- a + 1\nb\n# %%\nc <- b + 1\nc');
    const exported = await controller.dispatch(parseHostCommand({ type: 'service', command: 'export',
      payload: { format: 'html', include_code: true }, operationId: randomUUID(), sessionEpoch: snapshot.epoch }));
    const settled = await controller.awaitOperation(exported.operation.id);
    assert.equal(settled.status, 'done');
    const result = settled.result as { artifact: string };
    assert.match(await readFile(join(app.artifactDirectory, result.artifact), 'utf8'), /42/);
    await assert.rejects(controller.dispatch(parseHostCommand({
      type: 'run', scope: 'cell', cellId: 'cell-1', operationId: randomUUID(), sessionEpoch: snapshot.epoch,
      edits: [{ cellId: 'cell-1', expectedRevision: 0, cellType: 'code', body: ['a <- -1'] }],
    })), { code: 'source_conflict' });
    assert.equal(controller.snapshot().cells[0]!.body[0], 'a <- 40');
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('editing a queued batch cell prevents its old effects and retains unaffected work', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-host-batch-edit-'));
  const path = join(directory, 'notebook.R');
  const marker = join(directory, 'obsolete-source');
  await writeFile(path, '# %%\nSys.sleep(0.3); a <- 1; a\n# %%\nb <- a + 1; b\n# %%\n' +
    `writeLines('obsolete', ${JSON.stringify(marker)}); c <- b + 1; c\n`);
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const installed = await import(pathToFileURL(join(process.env.ALDER_R_PACKAGE!, 'host', 'alder-host.mjs')).href);
    app = await (installed.startHost as typeof startHost)({ path, port: 0, runOnStartup: false,
      executionMode: 'lazy', packagePath: process.env.ALDER_R_PACKAGE });
    const controller = app.controller;
    const evaluateBatch = app.engine.evaluateBatch.bind(app.engine);
    let batches = 0;
    app.engine.evaluateBatch = (...args) => { batches++; return evaluateBatch(...args); };
    let edited: Promise<unknown> | undefined;
    controller.subscribe(event => {
      if (event.type !== 'cell-started' || event.cellId !== 'cell-1' || edited !== undefined) return;
      edited = controller.dispatch(parseHostCommand({
        type: 'edit', operationId: randomUUID(), sessionEpoch: controller.snapshot().epoch,
        edits: [{ cellId: 'cell-3', expectedRevision: 0, cellType: 'code', body: ['c <- b + 20; c'] }],
      }));
    });
    const run = async () => {
      const id = randomUUID();
      await controller.dispatch(parseHostCommand({
        type: 'run', scope: 'all', operationId: id, sessionEpoch: controller.snapshot().epoch,
      }));
      return controller.awaitOperation(id);
    };
    assert.equal((await run()).status, 'done');
    await edited;
    assert.equal(batches, 1);
    await assert.rejects(access(marker));
    assert.deepEqual(controller.snapshot().cells.slice(0, 2).map(cell => cell.status), ['done', 'done']);
    assert.deepEqual(controller.snapshot().cells[2]!.body, ['c <- b + 20; c']);
    assert.equal((await run()).status, 'done');
    assert.equal(batches, 2);
    assert.match(JSON.stringify(controller.snapshot().cells[2]!.outputs), /22/);
    assert.equal(controller.snapshot().runtime.busy, false);
    await assert.rejects(access(marker));
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a batched consumer run settles its run-button reset', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-host-batch-button-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# %%\nbtn <- ui$run_button(); btn\n# %%\nseen <- btn$value; seen\n# %%\nresult <- as.integer(seen); result\n');
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const installed = await import(pathToFileURL(join(process.env.ALDER_R_PACKAGE!, 'host', 'alder-host.mjs')).href);
    app = await (installed.startHost as typeof startHost)({ path, port: 0, runOnStartup: false,
      executionMode: 'lazy', packagePath: process.env.ALDER_R_PACKAGE });
    const controller = app.controller;
    const dispatch = (value: Record<string, unknown>) => controller.dispatch(parseHostCommand({
      ...value, operationId: randomUUID(), sessionEpoch: controller.snapshot().epoch,
    }));
    const initial = await dispatch({ type: 'run', scope: 'all', source: 'editor' });
    assert.equal((await controller.awaitOperation(initial.operation.id, AbortSignal.timeout(10_000))).status, 'done');
    const widget = await dispatch({ type: 'widget', name: 'btn', path: [], update: { value: true }, source: 'editor' });
    const deadline = performance.now() + 5_000;
    while (controller.snapshot().cells[2]!.status !== 'stale' && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(controller.snapshot().cells[2]!.status, 'stale');
    const explicit = await dispatch({ type: 'run', scope: 'cell', cellId: 'cell-3', source: 'editor' });
    const run = await controller.awaitOperation(explicit.operation.id, AbortSignal.timeout(10_000));
    assert.equal(run.status, 'done');
    assert.equal(run.resetOperationIds?.length, 1);
    assert.equal((await controller.awaitOperation(widget.operation.id, AbortSignal.timeout(10_000))).status, 'done');
    const state = controller.snapshot();
    assert.equal((state.cells[0]!.outputs[0] as { spec: { value: boolean } }).spec.value, false);
    assert.match(JSON.stringify(state.cells[2]!.outputs), /\[1\] 1/);
    assert.equal(state.runtime.busy, false);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Stop cancels a single evaluation queued behind automatic inspection before side effects', {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-queued-stop-'));
  const path = join(directory, 'notebook.R');
  const entered = join(directory, 'inspection-entered');
  const release = join(directory, 'inspection-release');
  const effect = join(directory, 'must-not-exist');
  await writeFile(path, `# %%\ndim.alder_stop_probe <- function(x) { writeLines('entered', ${JSON.stringify(entered)}); deadline <- Sys.time() + 10; while (!file.exists(${JSON.stringify(release)}) && Sys.time() < deadline) Sys.sleep(0.01); NULL }\nz <- structure(1, class='alder_stop_probe')\ninvisible(NULL)\n# %%\nwriteLines('executed', ${JSON.stringify(effect)})\n42L\n# %%\n43L\n`);
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const installed = await import(pathToFileURL(join(process.env.ALDER_R_PACKAGE!, 'host', 'alder-host.mjs')).href);
    app = await (installed.startHost as typeof startHost)({ path, port: 0, runOnStartup: false,
      packagePath: process.env.ALDER_R_PACKAGE });
    const controller = app.controller;
    const dispatch = (value: Record<string, unknown>) => controller.dispatch(parseHostCommand({
      operationId: randomUUID(), clientId: 'queued-stop-test', sessionEpoch: controller.snapshot().epoch,
      ...value,
    }));
    const first = await dispatch({ type: 'run', scope: 'cell', cellId: 'cell-1', source: 'editor' });
    assert.equal((await controller.awaitOperation(first.operation.id, AbortSignal.timeout(15_000))).status, 'done');
    const deadline = performance.now() + 5_000;
    while (!await access(entered).then(() => true, () => false)) {
      assert.ok(performance.now() < deadline, 'automatic inspection did not begin');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const queued = await dispatch({ type: 'run', scope: 'cell', cellId: 'cell-2', source: 'editor' });
    await dispatch({ type: 'interrupt' });
    const operation = await controller.awaitOperation(queued.operation.id, AbortSignal.timeout(2_000));
    await writeFile(release, 'release');
    await assert.rejects(access(effect), 'cancelled source must not execute');
    assert.equal(operation.status, 'cancelled');
    const recovery = await dispatch({ type: 'run', scope: 'cell', cellId: 'cell-3', source: 'editor' });
    assert.equal((await controller.awaitOperation(recovery.operation.id, AbortSignal.timeout(15_000))).status, 'done');
    assert.equal(controller.snapshot().runtime.kernelAvailable, true);
  } finally {
    await writeFile(release, 'release');
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
