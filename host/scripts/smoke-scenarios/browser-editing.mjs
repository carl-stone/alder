import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupScenarioResources, createHarness, delay, waitForExecutionReady } from './_common.mjs';
import { openInteractiveBrowser } from '../../test-support/live-browser.mjs';

const ID = 'browser-editing';

async function ensureLauncher(ctx) {
  const relative = ctx.manifest?.resources?.cliLauncher;
  if (typeof relative !== 'string' || !await access(join(ctx.applicationRoot, relative)).then(() => true).catch(() => false)) {
    const error = new Error('scenario_unavailable: ' + ID + ': staged CLI launcher is unavailable');
    error.code = 'scenario_unavailable';
    throw error;
  }
}

/**
 * Exercise the installed browser renderer through the authenticated host.
 * This is deliberately a real staged-application smoke: a missing R, host,
 * or browser is an error, never a successful no-op result.
 */
export async function run(ctx) {
  const source = [
    '# %%',
    'answer<-40',
    'answer+2',
    '# %% [markdown]',
    '# Browser editing smoke',
    '# %%',
    'seed <- 3',
    'seed',
    ...Array.from({ length: 87 }, (_value, index) => `# %%\nvalue_${index + 4} <- ${index + 4}\nvalue_${index + 4}`),
    '',
  ].join('\n');

  let harness;
  let live;
  try {
    await ensureLauncher(ctx);
    harness = await createHarness(ctx, { id: ID, source });
    const initial = await harness.snapshot();
    assert.equal(initial.cells?.length, 90, 'browser fixture must contain the long notebook');

    live = await openInteractiveBrowser(harness, { name: ID, evidence: ctx.evidence });
    await live.wait("window.__alderHost?.client?.document?.snapshot?.cells?.length >= 90");
    try {
      await waitForExecutionReady(harness);
    } catch (error) {
      const diagnostics = { snapshot: await harness.snapshot().catch(cause => ({ error: String(cause) })), browser: await live.observe('startup-timeout').catch(cause => ({ error: String(cause) })) };
      await writeFile(join(ctx.evidence, 'browser-startup-timeout.json'), `${JSON.stringify(diagnostics, null, 2)}\n`);
      throw new AggregateError([error], `browser startup did not become execution-ready: ${JSON.stringify(diagnostics)}`);
    }
    await live.wait("document.querySelector('[data-cell=\"cell-90\"]') !== null");
    const initialDom = await live.browser.evaluate("document.documentElement.outerHTML");
    assertDomControls(initialDom);

    await live.wait("document.querySelectorAll('#notebook > .cell[data-cell]').length === 90 && document.querySelectorAll('#notebook .cm-editor').length > 0 && document.querySelectorAll('#notebook .cm-editor').length < 90", 30_000);
    const virtualization = await live.browser.evaluate(`(() => ({
      cells: document.querySelectorAll('#notebook > .cell[data-cell]').length,
      editors: document.querySelectorAll('#notebook .cm-editor').length
    }))()`);
    assert.equal(virtualization.cells, 90, 'every long-notebook cell must remain addressable');
    assert.ok(virtualization.editors > 0 && virtualization.editors < virtualization.cells, 'long notebook must virtualize CodeMirror editors');

    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'answer <- 41\nanswer + 1');
    await live.wait("window.__alderHost.client.document.cell('cell-1').desiredBody.join('\\n').includes('41')");
    await live.browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await live.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await live.wait("!window.__alderHost.client.document.cell('cell-1').desiredBody.join('\\n').includes('41')");
    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'answer <- 40\nanswer + 2');
    await live.browser.click('[data-cell="cell-90"] [data-virtual-source]');
    await live.wait("document.querySelector('[data-cell=\"cell-90\"] .cm-editor') !== null");
    await live.browser.click('[data-cell="cell-90"] .cm-content');
    const focus = await live.browser.evaluate("document.activeElement?.closest('[data-cell]')?.dataset.cell");
    assert.equal(focus, 'cell-90', 'virtualized last cell must accept editor focus');
    const retained = await live.browser.evaluate("window.__alderHost.client.document.cell('cell-1').desiredBody.join('\\n')");
    assert.match(retained, /answer <- 40/, 'virtualization must preserve edited source');

    const created = await live.browser.evaluate(`(async () => {
      const client = window.__alderHost.client;
      const markdown = client.createCell(client.document.cell('cell-1').key, 'markdown', ['# Created from the browser smoke']);
      const code = client.createCell(markdown.key, 'code', ['created <- 7', 'created']);
      await client.commitEdits();
      return { markdown: markdown.key, code: code.key };
    })()`);
    await live.wait("window.__alderHost.client.document.snapshot.cells.length === 92");
    await live.browser.evaluate(`(async () => {
      const client = window.__alderHost.client;
      await client.moveCell(${JSON.stringify(created.code)}, ${JSON.stringify(created.markdown)});
      await client.deleteCell(${JSON.stringify(created.code)});
      await client.formatCells(['cell-1']);
      await client.save();
    })()`);

    let notebook = await harness.snapshot();
    assert.equal(notebook.cells.length, 91, 'renderer create and delete must leave one created Markdown cell');
    assert.ok(notebook.cells.some(cell => cell.type === 'markdown' && cell.body?.[0] === '# # Created from the browser smoke'), 'created Markdown cell must preserve its physical R source');
    const disk = await readFile(harness.notebook, 'utf8');
    assert.match(disk, /answer\s*<-\s*40/, 'renderer Save must write edited executable source');
    assert.match(disk, /Created from the browser smoke/, 'renderer Save must retain created Markdown source');

    const run = await live.browser.evaluate(`window.__alderHost.client.runCell('cell-1')`);
    assert.ok(['accepted', 'running', 'done'].includes(run.operation.status), JSON.stringify(run));
    await live.wait("document.querySelector('[data-cell=\"cell-1\"] [data-run-id]')?.textContent?.includes('42')");

    await live.browser.evaluate(`document.querySelector('[data-cell="cell-1"] [data-virtual-source]')?.focus()`);
    await live.wait("document.querySelector('[data-cell=\"cell-1\"] .cm-editor') !== null");
    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'Sys.sleep(3)\nanswer <- 40\nanswer + 2');
    const runningOperationId = await live.browser.evaluate(`(async () => {
      const operationId = new Promise(resolve => {
        const listener = event => {
          if (event.detail.command.type !== 'run') return;
          removeEventListener('alder:host-command', listener);
          resolve(event.detail.command.operationId);
        };
        addEventListener('alder:host-command', listener);
      });
      void window.__alderHost.client.runCell('cell-1');
      return operationId;
    })()`);
    assert.equal(typeof runningOperationId, 'string', 'public renderer run must expose its operation identity');
    const running = await waitForRunning(live, runningOperationId);
    assert.ok(running.runId, 'renderer run must expose a run identity before Stop');
    const interrupted = await live.browser.evaluate(`(async () => {
      const client = window.__alderHost.client;
      const admission = await client.interrupt(${JSON.stringify(running.runId)});
      return client.awaitOperation(admission.operation.id);
    })()`);
    assert.equal(interrupted.status, 'done', JSON.stringify(interrupted));
    const stoppedRun = await live.browser.evaluate(`window.__alderHost.client.awaitOperation(${JSON.stringify(runningOperationId)})`);
    assert.ok(['cancelled', 'interrupted'].includes(stoppedRun.status), JSON.stringify(stoppedRun));

    const finalDom = await live.browser.evaluate("document.documentElement.outerHTML");
    assert.match(finalDom, /id="settings-keymap"/, 'settings must expose the keymap control');
    assert.match(finalDom, /value="vim"/, 'Vim keymap must be an accessible option');
    assert.match(finalDom, /data-act="add"/, 'accessible create controls must remain rendered');

    return {
      id: ID,
      identity: {
        artifact: ctx.manifest.sourceCommit,
        browser: 'headless Chromium renderer interactions',
        runtime: { rscript: harness.selectedR, epoch: harness.registry.epoch, processNonce: harness.registry.processNonce },
      },
      fixture: harness.notebook,
      result: 'real CodeMirror edit/undo/focus/virtualization plus renderer create/move/delete/format/save/run/stop passed',
    };
  } catch (error) {
    throw normalizeUnavailable(ID, error);
  } finally {
    await cleanupScenarioResources(() => live?.close(), () => harness?.close());
  }
}



async function waitForRunning(live, operationId) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const operation = await live.browser.evaluate(
      `(async () => {
        const client = window.__alderHost.client;
        const envelope = await client.query({ type: 'operation', operationId: ${JSON.stringify(operationId)}, clientId: client.transport.id });
        return envelope?.result ?? envelope;
      })()`,
    );
    if (operation?.status === 'running') return operation;
    if (['done', 'error', 'interrupted', 'cancelled'].includes(operation?.status)) return operation;
    if (Date.now() >= deadline) throw new Error(`run_never_started: ${operationId}`);
    await delay(50);
  }
}


function assertDomControls(dom) {
  assert.match(dom, /id="notebook"/, 'browser renderer must expose the notebook landmark');
  assert.match(dom, /id="save"/, 'browser renderer must expose Save');
  assert.match(dom, /id="run-all"/, 'browser renderer must expose Run all');
  assert.match(dom, /id="stop"/, 'browser renderer must expose Stop');
  assert.match(dom, /aria-label="Notebook cells"/, 'notebook must be accessible');
  assert.match(dom, /id="settings"/, 'settings dialog must be present');
}

function normalizeUnavailable(id, error) {
  if (error?.code === 'scenario_unavailable' || String(error?.message ?? '').startsWith('scenario_unavailable:')) return error;
  if (/browser_(unavailable|failed)|host_ready_timeout|session_registry_timeout|r_(invalid|not_found)/.test(String(error?.message ?? error))) {
    const unavailable = new Error(`scenario_unavailable: ${id}: ${error.message ?? error}`);
    unavailable.code = 'scenario_unavailable';
    return unavailable;
  }
  return error;
}
