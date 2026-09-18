import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHost } from '../src/application.js';
import { resolveApplicationResources } from '../src/resources.js';
import type { HostCommand } from '../src/protocol.js';
import { Chrome } from '../test-support/chrome.js';

type RunningHost = Awaited<ReturnType<typeof startHost>>;

let stagedResources: Awaited<ReturnType<typeof resolveApplicationResources>> | undefined;
let browserDataHome: string | undefined;
async function startInstalledHost(path: string, options: {
  executionMode?: 'automatic' | 'lazy';
  runOnStartup?: boolean;
} = {}): Promise<RunningHost> {
  stagedResources ??= await resolveApplicationResources(join(process.cwd(), '.application'));
  browserDataHome ??= await mkdtemp(join(tmpdir(), 'alder-browser-data-'));
  process.env.XDG_DATA_HOME = browserDataHome;
  return startHost({
    path,
    port: 0,
    runOnStartup: options.runOnStartup ?? false,
    executionMode: options.executionMode,
    resources: stagedResources,
    preferencesPath: join(dirname(path), '.test-preferences.yaml'),
    session: { runtimeDirectory: path + '-runtime' },
  });
}

async function replaceFocusedEditor(browser: Chrome, text: string): Promise<void> {
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
  });
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
  });
  await browser.send('Input.insertText', { text });
}

async function openAuthenticatedBrowser(app: RunningHost): Promise<Chrome> {
  const origin = app.server.address()!.origin;
  const response = await fetch(origin + '/api/ticket', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + app.ownership.token, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin }),
  });
  assert.equal(response.ok, true, 'browser ticket issuance must be accepted');
  const value = await response.json() as { ticket?: unknown };
  assert.equal(typeof value.ticket, 'string', 'browser ticket issuance must return a ticket');
  return Chrome.open(origin + '/#ticket=' + encodeURIComponent(value.ticket as string));
}

function peerCommand(app: RunningHost, command: Record<string, unknown>): HostCommand {
  return {
    ...command,
    requestId: typeof command.requestId === 'string' ? command.requestId : 'browser-peer-' + randomUUID(),
    clientId: 'browser-peer',
    sessionEpoch: app.controller.epoch,
  } as HostCommand;
}
test('trusted browser edit-and-Run presents the current chain and creation retains focus', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# %%\na <- 1\na\n# %%\nb <- a + 1\nb\n# %%\nc <- b + 1\nc\n');
  let app: Awaited<ReturnType<typeof startHost>> | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && document.querySelectorAll('.cm-content').length === 3");
    await browser.evaluate(`(() => {
      const view = window.__alderHost.view;
      const completion = view.lspCompletion.bind(view);
      window.__typingCompletions = [];
      view.lspCompletion = (...args) => {
        window.__typingCompletions.push(args[2].explicit);
        return completion(...args);
      };
    })()`);
    await browser.click('[data-cell="cell-1"] .cm-content');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await browser.send('Input.insertText', { text: 'a <- 40\na' });
    await browser.evaluate(`(() => {
      const measurement = window.__measurement = {input: null, handler: null, command: null, completed: null, editor: document.activeElement};
      document.addEventListener('click', event => { if (event.target.closest('[data-act=run]')) {
        if (!event.isTrusted) throw new Error('Run event was not trusted');
        measurement.input = event.timeStamp; measurement.handler = performance.now();
      } }, {capture:true, once:true});
      window.addEventListener('alder:host-command', event => { if (event.detail.command.type === 'run') { measurement.command = event.detail.command; measurement.result = event.detail.result; } });
      measurement.done = new Promise((resolve,reject) => {
        const cleanup = () => { clearTimeout(timer); unsubscribe(); window.removeEventListener('alder:host-command', onResult); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('no current chain result')); }, 15000);
        const finish = () => {
          if (!measurement.command || !measurement.completed) return;
          const event = measurement.completed;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            try {
              const document = window.__alderHost.client.document;
              const output = window.document.querySelector('[data-cell="cell-3"] [data-role=outputs]');
              if (event.operationId !== measurement.command.requestId) throw new Error('wrong request');
              if (measurement.result.error !== null) throw new Error('Run failed: ' + JSON.stringify(measurement.result.error));
              if (!output || !output.textContent.includes('42') || output.dataset.runId !== event.runId) throw new Error('wrong visible result');
              if (document.snapshot.cells[0].revision !== 1 || document.snapshot.cells[0].body[0] !== 'a <- 40') throw new Error('wrong source');
              if (output.getBoundingClientRect().height <= 0) throw new Error('result hidden');
              cleanup();
              resolve({duration:performance.now()-measurement.input, inputDelay:measurement.handler-measurement.input, runId:event.runId, revision:document.snapshot.cells[0].revision});
            } catch(error) { cleanup(); reject(error); }
          }));
        };
        const onResult = event => { if (event.detail.command.type === 'run') finish(); };
        window.addEventListener('alder:host-command', onResult);
        const unsubscribe = window.__alderHost.client.subscribe((_document,event) => {
          if (event?.type !== 'cell-completed' || event.cellId !== 'cell-3') return;
          measurement.completed = event;
          finish();
        });
      });
    })()`);
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    const result = await browser.evaluate('window.__measurement.done');
    assert.equal(result.revision, 1);
    assert.equal(await browser.evaluate('document.activeElement === window.__measurement.editor'), true, 'pointer Run must preserve editor focus');
    assert.deepEqual(await browser.evaluate(`window.__measurement.command.changes.filter(change => change.type === 'edit').map(change => change.body)`), [['a <- 40', 'a']]);
    assert.ok(result.duration >= result.inputDelay && result.inputDelay >= 0);
    assert.equal(app.controller.snapshot().cells[2]!.status, 'done');
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 450))');
    assert.deepEqual(await browser.evaluate('window.__typingCompletions'), [], 'Run must cancel completion scheduled by the preceding edit');
    await browser.click('[data-cell="cell-3"] [data-act=add][data-type=code]');
    await browser.wait("document.querySelectorAll('#notebook > .cell').length === 4 && document.activeElement?.classList.contains('cm-content')");
    const focused = await browser.evaluate("window.__focusedEditor = document.activeElement; true");
    assert.equal(focused, true);
    await browser.wait('window.__alderHost.client.document.cells.every(cell => cell.id !== null)');
    assert.equal(await browser.evaluate('document.activeElement === window.__focusedEditor'), true);
    await browser.evaluate(`(() => {
      const view = window.__alderHost.view;
      window.__completionKinds = [];
      const completion = view.lspCompletion.bind(view);
      view.lspCompletion = (cell, editor, context) => {
        window.__completionKinds.push(context.explicit);
        return completion(cell, editor, context);
      };
      view.lsp = async (_method, params) => {
        window.__completionParams = params;
        return [{
          label: 'mean',
          textEdit: {
            newText: 'mean()',
            range: {
              start: {cell: params.position.cell, line: 0, character: 0},
              end: {cell: params.position.cell, line: 0, character: 3},
            },
          },
          additionalTextEdits: [{
            newText: 'library(stats)\\n',
            range: {
              start: {cell: params.position.cell, line: 0, character: 0},
              end: {cell: params.position.cell, line: 0, character: 0},
            },
          }],
        }];
      };
    })()`);
    await browser.send('Input.insertText', { text: 'mea' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await browser.wait('window.__completionKinds.includes(true)');
    await browser.wait("document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('mean')");
    await browser.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    try {
      await browser.wait("[...window.__alderEditors.values()].some(editor => editor.getDoc() === 'library(stats)\\nmean()')");
    } catch (error) {
      const documents = await browser.evaluate("({documents:[...window.__alderEditors.entries()].map(([key, editor]) => ({key, source: editor.getDoc()})), params:window.__completionParams, active:document.activeElement?.outerHTML})");
      throw new AggregateError([error], 'completion documents: ' + JSON.stringify(documents));
    }
    await browser.evaluate(`(() => {
      const view = window.__alderHost.view;
      view.lsp = (_method, _params, signal) => new Promise((_resolve, reject) => {
        window.__pendingCompletionSignal = signal;
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once:true});
      });
      for (const editor of window.__alderEditors.values()) editor.closeCompletion();
    })()`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 });
    await browser.wait('window.__pendingCompletionSignal && !window.__pendingCompletionSignal.aborted');
    const priorRunRequestId = await browser.evaluate("window.__measurement.command.requestId");
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    assert.equal(await browser.evaluate('window.__pendingCompletionSignal.aborted'), true,
      'Run must also abort a completion request that already started');
    await browser.wait(`window.__measurement.command.requestId !== ${JSON.stringify(priorRunRequestId)} &&
      window.__measurement.result.error === null`);
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'Sys.sleep(5)\na <- 40\na');
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait(`document.querySelector('[data-cell="cell-1"]').classList.contains('running') &&
      document.querySelector('#stop').disabled === false`);
    await browser.click('#stop');
    await browser.wait(`window.__alderHost.client.document.snapshot.runtime.busy === false &&
      !document.querySelector('[data-cell="cell-1"]').classList.contains('running')`);
    assert.equal(app.controller.snapshot().cells[0]?.error?.interrupted, true,
      'long evaluations must show running feedback and remain stoppable');
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'a <- 40\na');
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.slice(0,3).every(cell => cell.status === 'done') &&
      document.querySelector('[data-cell="cell-3"] [data-role=outputs]').textContent.includes('42')`);
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))');
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="cell-1"]').classList.contains('done')`), true,
      'a deferred started projection must not replace a completed result');
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ host: app?.controller.snapshot(), browser: await browser?.evaluate(
      "({status:document.querySelector('#status')?.textContent, measurement:window.__measurement && {input:__measurement.input, command:__measurement.command,completed:__measurement.completed},cells:window.__alderHost?.client.document?.snapshot.cells})"
    ).catch(() => null), errors: browser?.errors }));
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('long notebooks virtualize editors while preserving focused source through recovery', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-long-'));
  const path = join(directory, 'notebook.R');
  const source = Array.from({ length: 90 }, (_value, index) =>
    `# %%\nvalue_${index + 1} <- ${index + 1}\nvalue_${index + 1}`
  ).join('\n');
  await writeFile(path, `${source}\n`);
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && document.querySelectorAll('#notebook > .cell').length === 90", 30_000);
    await browser.wait("document.querySelectorAll('[data-virtual-source]').length > 50 && document.querySelectorAll('.cm-content').length < 25");
    assert.equal(await browser.evaluate("document.querySelectorAll('#panel-variables .variable-row').length"), 0,
      'unexecuted source definitions are not runtime variables');

    await browser.click('[data-cell="cell-75"] [data-virtual-source]');
    await browser.wait("document.activeElement?.classList.contains('cm-content') && document.activeElement.closest('[data-cell=\"cell-75\"]') !== null");
    await browser.evaluate(`(() => {
      const view = window.__alderHost.view;
      window.__typingRenderedCellIds = [];
      window.__typingRenderCell = view.renderCell.bind(view);
      view.renderCell = (cell, ...args) => {
        window.__typingRenderedCellIds.push(cell.id || cell.key);
        return window.__typingRenderCell(cell, ...args);
      };
    })()`);
    await replaceFocusedEditor(browser, 'value_75 <- 7500\nvalue_75');
    const typingRender = await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__alderHost.view.renderCell = window.__typingRenderCell;
      resolve([...new Set(window.__typingRenderedCellIds)]);
    })))`);
    assert.deepEqual(typingRender, ['cell-75']);
    assert.equal(await browser.evaluate(`(() => {
      const cell = document.querySelector('[data-cell="cell-75"]');
      const handle = window.__alderEditors.get('cell:cell-75');
      if (!cell || !handle || handle.getDoc() !== 'value_75 <- 7500\\nvalue_75') return false;
      window.__longCell = cell;
      window.__longEditorNode = document.activeElement;
      window.__longEditorHandle = handle;
      window.scrollTo(0, 0);
      return true;
    })()`), true);
    await browser.wait(`window.scrollY === 0 &&
      document.querySelectorAll('.cm-content').length < 25 &&
      document.querySelector('[data-cell="cell-75"]') === window.__longCell &&
      document.activeElement === window.__longEditorNode &&
      window.__alderEditors.get('cell:cell-75') === window.__longEditorHandle &&
      window.__longEditorHandle.getDoc() === 'value_75 <- 7500\\nvalue_75'`);

    await browser.send('Network.enable');
    await browser.evaluate(`(() => {
      window.__transportStates = [];
      const view = window.__alderHost.view;
      const original = view.setTransportState.bind(view);
      view.setTransportState = (state, error) => {
        window.__transportStates.push({state, message:error?.message || ''});
        return original(state, error);
      };
      return true;
    })()`);
    await browser.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await browser.evaluate("window.__alderHost.client.transport.socket.close(4001, 'test recovery')");
    await browser.wait("window.__transportStates.some(entry => entry.state === 'closed')");
    const peer80Snapshot = app.controller.snapshot();
    const peer80 = peer80Snapshot.cells.find(cell => cell.id === 'cell-80');
    assert.ok(peer80);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: peer80Snapshot.documentRevision, changes: [{
        type: 'edit', cell: { cellId: 'cell-80' }, expectedRevision: peer80.revision, cellType: 'code',
        body: ['value_80 <- 8000', 'value_80'],
      }],
    }))).error, null);
    await browser.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await browser.wait(`window.__transportStates.some(entry => entry.state === 'open') &&
      window.__alderHost.client.document.cell('cell-80').serverRevision === 1 &&
      window.__alderHost.client.document.cell('cell-80').desiredBody[0] === 'value_80 <- 8000'`, 30_000);
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="cell-75"]') === window.__longCell &&
      window.__alderEditors.get('cell:cell-75') === window.__longEditorHandle &&
      window.__longEditorHandle.getDoc() === 'value_75 <- 7500\\nvalue_75'`), true);
    assert.equal(app.controller.snapshot().cells[79]!.body[0], 'value_80 <- 8000');

    await browser.evaluate('window.__alderHost.client.commitEdits()');
    await browser.wait(`window.__alderHost.client.document.cell('cell-75').serverRevision === 1 &&
      window.__alderHost.client.document.snapshot.cells.every(cell => !cell.analysisPending)`, 30_000);
    // Reconciled source is rendered on the next frame. Finish that earlier
    // edit's projection before observing which cells the new Run renders.
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

    assert.equal(await browser.evaluate(`(() => {
      const unrelated = document.querySelector('[data-cell="cell-90"] [data-role=diagnostics]');
      const view = window.__alderHost.view;
      const renderCell = view.renderCell.bind(view);
      const render = view.render.bind(view);
      window.__renderedCellIds = [];
      window.__renderedEvents = [];
      view.renderCell = (cell, ...args) => {
        if (window.__renderEvent?.runId) window.__renderedCellIds.push(cell.id || cell.key);
        return renderCell(cell, ...args);
      };
      view.render = (document, event, ...args) => {
        window.__renderedEvents.push({type:event?.type || 'local', payload:event?.payload});
        // Recovery/help can settle independent source requests during a Run.
        // Attribute cell rendering to the controller's actual run events.
        window.__renderEvent = event;
        try { return render(document, event, ...args); }
        finally { window.__renderEvent = null; }
      };
      window.__longGraph = document.querySelector('#panel-graph .dag-graph');
      window.__longMinimap = [...document.querySelectorAll('#minimap [data-target-cell]')]
        .find(node => node.dataset.targetCell === 'cell-90');
      window.__unrelatedMutations = 0;
      window.__unrelatedObserver = new MutationObserver(records => {
        window.__unrelatedMutations += records.length;
      });
      window.__unrelatedObserver.observe(unrelated, {childList:true,subtree:true,characterData:true});
      return Boolean(unrelated && window.__longGraph && window.__longMinimap);
    })()`), true);
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells[0].status === 'done' &&
      document.querySelector('[data-cell="cell-1"] [data-role=outputs]')?.textContent.trim() === '[1] 1'`, 30_000);
    const selectiveRender = await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__unrelatedObserver.disconnect();
      resolve({
        unrelatedMutations: window.__unrelatedMutations,
        graphPreserved: document.querySelector('#panel-graph .dag-graph') === window.__longGraph,
        minimapPreserved: [...document.querySelectorAll('#minimap [data-target-cell]')]
          .find(node => node.dataset.targetCell === 'cell-90') === window.__longMinimap,
        renderedCellIds: [...new Set(window.__renderedCellIds)],
        orderPreserved: [...document.querySelectorAll('#notebook > .cell[data-cell]')]
          .every((node, index) => node.dataset.cell === 'cell-' + (index + 1)),
        editorPreserved: document.querySelector('[data-cell="cell-75"]') === window.__longCell &&
          window.__alderEditors.get('cell:cell-75') === window.__longEditorHandle &&
          window.__longEditorHandle.getDoc() === 'value_75 <- 7500\\nvalue_75',
      });
    })))`);
    assert.deepEqual(selectiveRender, {
      unrelatedMutations: 0,
      graphPreserved: true,
      minimapPreserved: true,
      renderedCellIds: ['cell-1'],
      orderPreserved: true,
      editorPreserved: true,
    });
    await browser.wait(`document.querySelector('#panel-variables .variable-row[data-target-cell="cell-1"] .variable-name')?.textContent === 'value_1'`);
    const renameSnapshot = app.controller.snapshot();
    const renameCell = renameSnapshot.cells.find(cell => cell.id === 'cell-90');
    assert.ok(renameCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: renameSnapshot.documentRevision, changes: [{
        type: 'options', cell: { cellId: 'cell-90' }, expectedRevision: renameCell.revision, patch: { name: 'tail' },
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('#panel-graph [data-target-cell="cell-90"]')?.textContent.includes('tail') &&
      document.querySelector('#minimap [data-target-cell="cell-90"]')?.getAttribute('aria-label').includes('tail')`);
    await browser.wait(`document.querySelector('#panel-outline [data-target-cell="cell-90"]')?.textContent === 'tail'`);
    const peer90Snapshot = app.controller.snapshot();
    const peer90 = peer90Snapshot.cells.find(cell => cell.id === 'cell-90');
    assert.ok(peer90);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: peer90Snapshot.documentRevision, changes: [{
        type: 'edit', cell: { cellId: 'cell-90' }, expectedRevision: peer90.revision, cellType: 'markdown', body: ['# # Current heading'],
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('#panel-outline .outline-heading[data-target-cell="cell-90"]')?.textContent === 'Current heading' &&
      window.__alderHost.client.document.cell('cell-90').desiredType === 'markdown'`);
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="cell-75"]') === window.__longCell &&
      window.__alderEditors.get('cell:cell-75') === window.__longEditorHandle &&
      window.__longEditorHandle.getDoc() === 'value_75 <- 7500\\nvalue_75'`), true);
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ host: app?.controller.snapshot(), browser: await browser?.evaluate(
      "({states:window.__transportStates,cells:window.__alderHost?.client.document?.cells.map(c=>({id:c.id,revision:c.serverRevision,conflict:c.conflict,tombstone:c.tombstone,body:c.desiredBody})),renderedCellIds:window.__renderedCellIds,renderedEvents:window.__renderedEvents,editors:window.__alderEditors?.size,status:document.querySelector('#status')?.textContent})"
    ).catch(() => null), errors: browser?.errors }));
    throw error;
  } finally {
    await browser?.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => {});
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('source conflicts and peer deletion retain the exact local draft until explicit recovery', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-conflict-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# %%\nx <- 1\nx\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && document.querySelector('[data-cell=\"cell-1\"] .cm-content') !== null");
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'local <- 2\nlocal');
    await browser.evaluate(`(() => {
      window.__conflictCell = document.querySelector('[data-cell="cell-1"]');
      window.__conflictEditor = window.__alderEditors.get('cell:cell-1');
      return window.__conflictEditor?.getDoc() === 'local <- 2\\nlocal';
    })()`);
    const conflictSnapshot = app.controller.snapshot();
    const conflictCell = conflictSnapshot.cells.find(cell => cell.id === 'cell-1');
    assert.ok(conflictCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: conflictSnapshot.documentRevision, changes: [{
        type: 'edit', cell: { cellId: 'cell-1' }, expectedRevision: 0, cellType: 'code', body: ['peer <- 9', 'peer'],
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('[data-cell="cell-1"]')?.classList.contains('source-conflict') &&
      window.__conflictEditor.getDoc() === 'local <- 2\\nlocal'`);
    await browser.send('Input.insertText', { text: '\n# retained' });
    await browser.wait(`window.__conflictEditor.getDoc() === 'local <- 2\\nlocal\\n# retained' &&
      window.__alderHost.client.document.cell('cell-1').conflict === true`);
    const conflictRevision = app.controller.snapshot().documentRevision;
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait("document.querySelector('#status')?.textContent.includes('resolve deleted or conflicting local source')");
    assert.equal(app.controller.snapshot().documentRevision, conflictRevision);
    assert.deepEqual(app.controller.snapshot().cells[0]!.body, ['peer <- 9', 'peer']);
    assert.equal(app.controller.snapshot().cells[0]!.revision, 1);

    await browser.click('[data-cell="cell-1"] [data-recovery]');
    await browser.wait(`!document.querySelector('[data-cell="cell-1"]')?.classList.contains('source-conflict') &&
      window.__conflictEditor.getDoc() === 'peer <- 9\\npeer'`);
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'draft <- 123\ndraft');
    assert.equal(await browser.evaluate(`(() => {
      window.__draftEditorNode = document.activeElement;
      return window.__conflictEditor.getDoc() === 'draft <- 123\\ndraft';
    })()`), true);
    const deleteSnapshot = app.controller.snapshot();
    const deleteCell = deleteSnapshot.cells.find(cell => cell.id === 'cell-1');
    assert.ok(deleteCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: deleteSnapshot.documentRevision, changes: [{
        type: 'delete', cell: { cellId: 'cell-1' }, expectedRevision: deleteCell.revision,
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('[data-cell="cell-1"]')?.classList.contains('tombstone') &&
      window.__conflictEditor.getDoc() === 'draft <- 123\\ndraft' &&
      document.activeElement === window.__draftEditorNode`);
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="cell-1"]') === window.__conflictCell &&
      window.__alderEditors.get('cell:cell-1') === window.__conflictEditor &&
      document.querySelector('[data-cell="cell-1"] [role=alert]')?.textContent.includes('local draft')`), true);

    await browser.click('[data-cell="cell-1"] [data-recovery]');
    await browser.wait(`window.__alderHost.client.document.cells.length === 1 &&
      window.__alderHost.client.document.cells[0].id !== null &&
      window.__alderHost.client.document.cells[0].tombstone === false`, 30_000);
    const restoredId = await browser.evaluate('window.__alderHost.client.document.cells[0].id');
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="${restoredId}"]') === window.__conflictCell &&
      window.__alderEditors.get('cell:cell-1') === window.__conflictEditor &&
      window.__conflictEditor.getDoc() === 'draft <- 123\\ndraft'`), true);
    assert.deepEqual(app.controller.snapshot().cells[0]!.body, ['draft <- 123', 'draft']);
    await browser.click(`[data-cell="${restoredId}"] .cm-content`);
    await replaceFocusedEditor(browser, 'discarded <- 456');
    const restored = app.controller.snapshot().cells[0]!;
    const deleteRestoredSnapshot = app.controller.snapshot();
    const deleteRestoredCell = deleteRestoredSnapshot.cells.find(cell => cell.id === restored.id);
    assert.ok(deleteRestoredCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: deleteRestoredSnapshot.documentRevision, changes: [{
        type: 'delete', cell: { cellId: restored.id }, expectedRevision: deleteRestoredCell.revision,
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('[data-cell="${restoredId}"]')?.classList.contains('tombstone')`);
    await browser.click(`[data-cell="${restoredId}"] [data-recovery]:last-child`);
    await browser.wait("window.__alderHost.client.document.cells.length === 0 && document.querySelectorAll('.cell').length === 0");
    assert.equal(app.controller.snapshot().cells.length, 0);

    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ host: app?.controller.snapshot(), browser: await browser?.evaluate(
      "({status:document.querySelector('#status')?.textContent,cell:window.__alderHost?.client.document?.cells[0] && ((c)=>({id:c.id,body:c.desiredBody,serverBody:c.serverBody,revision:c.serverRevision,conflict:c.conflict,tombstone:c.tombstone}))(window.__alderHost.client.document.cells[0]),dom:document.querySelector('#notebook')?.innerText})"
    ).catch(() => null), errors: browser?.errors }));
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('scientific outputs support lazy evaluation, table paging, and a trusted widget update', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-science-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, [
    '# %%', 'library(alder)',
    '# %%', "control <- ui$slider(1, 8, value = 3, step = 1, label = 'Point count')", 'control',
    '# %%', "sprintf('VALUE=%d', control$value)",
    '# %%', "plot(seq_len(control$value), main = sprintf('n=%d', control$value))",
    '# %%', "df <- data.frame(x = 1:60, group = paste0('g', 1:60))", 'df',
    '# %%', "out$lazy(function() out$vstack(out$md('**lazy ready**'), data.frame(z = 26:55)))",
  ].join('\n') + '\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: 'automatic' });
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && !window.__alderHost.client.document.snapshot.runtime.busy && !document.querySelector('#run-all')?.disabled && document.querySelectorAll('#notebook > .cell[data-cell]').length === 6", 30_000);
    await browser.click('#run-all');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.every(cell => cell.status === 'done') &&
      document.querySelector('[data-cell="cell-3"] [data-role=outputs]')?.textContent.includes('VALUE=3') &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.complete &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.naturalWidth > 0 &&
      document.querySelector('[data-cell="cell-5"] .table-page-label')?.textContent.includes('1..25 of 60') &&
      document.querySelector('[data-cell="cell-6"] .out-lazy') !== null`, 45_000);
    await browser.evaluate("window.__alderHost.client.setRuntime({executionMode:'lazy'})");
    await browser.wait("window.__alderHost.client.document.snapshot.runtime.executionMode === 'lazy' && !document.querySelector('#run-all')?.disabled");

    await browser.click('[data-cell="cell-5"] .table-pager button:last-child');
    await browser.wait("document.querySelector('[data-cell=\"cell-5\"] .table-page-label')?.textContent.includes('26..50 of 60')");
    await browser.click('[data-cell="cell-5"] [data-role=table-filter]');
    await replaceFocusedEditor(browser, 'g59');
    await browser.wait(`document.querySelector('[data-cell="cell-5"] .table-page-label')?.textContent.includes('1..1 of 1') &&
      document.querySelector('[data-cell="cell-5"] .table-preview tbody')?.textContent.includes('g59')`, 30_000);

    await browser.click('[data-cell="cell-6"] .out-lazy');
    await browser.wait(`document.querySelector('[data-cell="cell-6"] .markdown-output')?.textContent.includes('lazy ready') &&
      document.querySelector('[data-cell="cell-6"] .table-page-label')?.textContent.includes('1..25 of 30')`, 30_000);

    const initialPlot = await browser.evaluate("document.querySelector('[data-cell=\"cell-4\"] img.plot').getAttribute('src')");
    assert.equal(await browser.evaluate(`(() => {
      const control = document.querySelector('[data-cell="cell-2"] [data-role=widget][data-name=control]');
      if (!control || control.value !== '3') return false;
      window.__trustedWidgetEvents = [];
      control.addEventListener('input', event => window.__trustedWidgetEvents.push(event.isTrusted));
      control.focus();
      return document.activeElement === control;
    })()`), true);
    await browser.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39,
    });
    await browser.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39,
    });
    await browser.wait(`window.__alderHost.client.document.snapshot.cells[2].status === 'stale' &&
      window.__alderHost.client.document.snapshot.cells[3].status === 'stale' &&
      document.querySelector('[data-cell="cell-2"] [data-role=widget][data-name=control]').value === '4' &&
      document.activeElement === document.querySelector('[data-cell="cell-2"] [data-role=widget][data-name=control]') &&
      window.__trustedWidgetEvents.length === 1 && window.__trustedWidgetEvents[0] === true`, 30_000);
    await browser.wait("!document.querySelector('#run-all')?.disabled");
    await browser.click('#run-all');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells[2].status === 'done' &&
      window.__alderHost.client.document.snapshot.cells[3].status === 'done' &&
      document.querySelector('[data-cell="cell-3"] [data-role=outputs]')?.textContent.includes('VALUE=4') &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.complete &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.naturalWidth > 0 &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.getAttribute('src') !== ${JSON.stringify(initialPlot)}`, 45_000);
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ host: app?.controller.snapshot(), browser: await browser?.evaluate(
      "({status:document.querySelector('#status')?.textContent,cells:window.__alderHost?.client.document?.snapshot.cells.map(c=>({id:c.id,status:c.status,outputs:c.outputs,log:c.log,error:c.error})),dom:document.querySelector('#notebook')?.innerText})"
    ).catch(() => null), errors: browser?.errors }));
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('scalar, form, and button controls drive the intended reactive cells once', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-widgets-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, [
    '# %%', 'library(alder)',
    '# %%', 'gain <- ui$slider(0, 10, value = 2, step = 1); gain',
    '# %%', 'scaled <- gain$value * 7; scaled',
    '# %%', 'unrelated <- 100L; unrelated',
    '# %%', 'settings <- ui$form(ui$array(factor = ui$slider(0, 10, value = 2), enabled = ui$checkbox(FALSE))); settings',
    '# %%', 'form_result <- if (is.null(settings$value)) "not submitted" else if (settings$value$enabled) settings$value$factor * 7 else 0; form_result',
    '# %%', 'clicks <- ui$button(); clicks',
    '# %%', 'seen <- clicks$value; seen',
  ].join('\n') + '\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: 'automatic' });
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && !window.__alderHost.client.document.snapshot.runtime.busy && !document.querySelector('#run-all')?.disabled && document.querySelectorAll('#notebook > .cell[data-cell]').length === 8", 30_000);
    await browser.evaluate("window.__alderHost.client.runAll('all')");
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.every(cell => cell.status === 'done') &&
      document.querySelector('[data-cell="cell-3"] [data-role=outputs]')?.textContent.includes('14') &&
      document.querySelector('[data-cell="cell-6"] [data-role=outputs]')?.textContent.includes('not submitted') &&
      document.querySelector('[data-cell="cell-8"] [data-role=outputs]')?.textContent.includes('0')`, 45_000);
    const doneRuns = new Map<string, Set<string>>();
    const unsubscribe = app.controller.subscribe((event) => {
      if (event.type !== 'cell-completed' || event.payload.status !== 'done' || !event.payload.outputs?.length) return;
      const runs = doneRuns.get(event.payload.id) ?? new Set<string>();
      runs.add(event.payload.outputs[0].runId ?? '');
      doneRuns.set(event.payload.id, runs);
    }, ['cell-completed']);
    const arrowRight = async () => {
      await browser!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    };
    try {
      assert.equal(await browser.evaluate(`(() => {
        const control = document.querySelector('[data-cell="cell-2"] [data-role=widget][data-name=gain]');
        control?.focus();
        window.__oldGainOrigin = { ...window.__alderHost.view.output.controlOrigins.get(control) };
        return control?.value === '2' && document.activeElement === control;
      })()`), true);
      await arrowRight();
      await browser.wait(`document.querySelector('[data-cell="cell-3"] [data-role=outputs]')?.textContent.includes('21') &&
        window.__alderHost.client.document.snapshot.cells[2].status === 'done'`, 30_000);
      assert.equal(doneRuns.get('cell-3')?.size, 1);
      assert.equal(doneRuns.get('cell-4')?.size ?? 0, 0);
      assert.equal(await browser.evaluate(`window.__alderHost.client.setWidget('gain', [], {value:9}, 'editor', window.__oldGainOrigin)
        .then(() => 'accepted', error => error.code)`), 'widget_not_current');
      assert.equal((app.controller.snapshot().cells[1]!.outputs[0]!.data as { spec: { value: number } }).spec.value, 3);
      doneRuns.clear();

      assert.equal(await browser.evaluate(`(() => {
        const control = document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=slider]');
        control?.focus();
        return control?.value === '2' && document.activeElement === control;
      })()`), true);
      await arrowRight();
      await browser.click('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]');
      await browser.wait(`document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]')?.checked === true &&
        window.__alderHost.client.document.snapshot.cells[4].outputs[0]?.data?.spec?.child?.value?.enabled === true &&
        document.querySelector('[data-cell="cell-5"] [data-form-submit=true]')?.disabled === false`, 30_000);
      assert.equal(doneRuns.get('cell-6')?.size ?? 0, 0);
      assert.match(String(await browser.evaluate("document.querySelector('[data-cell=\"cell-6\"] [data-role=outputs]').textContent")), /not submitted/);
      await browser.evaluate(`(() => {
        window.__formClicks = [];
        const submit = document.querySelector('[data-cell="cell-5"] [data-form-submit=true]');
        submit.addEventListener('click', event => window.__formClicks.push({trusted:event.isTrusted,disabled:submit.disabled}));
      })()`);
      await browser.click('[data-cell="cell-5"] [data-form-submit=true]');
      await browser.wait('window.__formClicks.length > 0', 3_000);
      assert.equal((await browser.evaluate('window.__formClicks'))[0].trusted, true);
      await browser.wait(`document.querySelector('[data-cell="cell-6"] [data-role=outputs]')?.textContent.includes('21') &&
        window.__alderHost.client.document.snapshot.cells[5].status === 'done'`, 8_000);
      assert.equal(doneRuns.get('cell-6')?.size, 1);
      doneRuns.clear();

      await browser.click('[data-cell="cell-7"] [data-role=widget][data-name=clicks]');
      await browser.wait(`document.querySelector('[data-cell="cell-8"] [data-role=outputs]')?.textContent.includes('[1] 1') &&
        window.__alderHost.client.document.snapshot.cells[7].status === 'done'`, 30_000);
      assert.equal(doneRuns.get('cell-8')?.size, 1);
      assert.equal(doneRuns.get('cell-4')?.size ?? 0, 0);
      assert.deepEqual(browser.errors, []);
    } finally {
      unsubscribe();
    }
  } catch (error) {
    console.error(JSON.stringify({ runtime: app?.controller.snapshot().runtime, browser: await browser?.evaluate(`(() => {
      const output = window.__alderHost?.view?.output;
      const submit = document.querySelector('[data-cell="cell-5"] [data-form-submit=true]');
      return { formClicks:window.__formClicks, submitDisabled:submit?.disabled, origin:submit && output?.controlOrigins?.get(submit),
        pendingWidgets:[...(output?.pendingWidgets?.keys() ?? [])], pendingForms:[...(output?.pendingForms?.keys() ?? [])],
        lastFailure:String(output?.lastFailure?.error ?? ''), status:document.querySelector('#status')?.textContent };
    })()`).catch(() => null), cells: app?.controller.snapshot().cells.map((cell) => ({
      id: cell.id, status: cell.status, data: cell.outputs.map((output) => output.data), error: cell.error,
    })), errors: browser?.errors }));
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
