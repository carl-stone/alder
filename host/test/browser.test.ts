import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const inheritedRLibsUser = process.env.R_LIBS_USER;
const inheritedXdgDataHome = process.env.XDG_DATA_HOME;
const isolatedRLibsUser = await mkdtemp(join(tmpdir(), 'alder-browser-r-library-'));
process.env.R_LIBS_USER = isolatedRLibsUser;
test.after(async () => {
  if (inheritedRLibsUser === undefined) delete process.env.R_LIBS_USER;
  else process.env.R_LIBS_USER = inheritedRLibsUser;
  if (inheritedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = inheritedXdgDataHome;
  await rm(isolatedRLibsUser, { recursive: true, force: true });
  if (browserDataHome !== undefined) await rm(browserDataHome, { recursive: true, force: true });
});
async function startInstalledHost(path: string, options: {
  executionMode?: 'automatic' | 'lazy';
  runOnStartup?: boolean;
} = {}): Promise<RunningHost> {
  stagedResources ??= await resolveApplicationResources(
    process.env.ALDER_APPLICATION_ROOT ?? join(process.cwd(), '.application'),
  );
  browserDataHome ??= await mkdtemp(join(tmpdir(), 'alder-browser-data-'));
  process.env.XDG_DATA_HOME = browserDataHome;
  return startHost({
    path,
    suppressStartup: options.runOnStartup !== true,
    executionMode: options.executionMode,
    resources: stagedResources,
    preferencesPath: join(dirname(path), '.test-preferences.yaml'),
  });
}

async function replaceFocusedEditor(browser: Chrome, text: string): Promise<void> {
  const commandModifier = process.platform === 'darwin' ? 4 : 2;
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: commandModifier,
  });
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: commandModifier,
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

test('an immediate Save captures the current CodeMirror source', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-immediate-save-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# %%\nvalue <- 0L\nvalue\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("Boolean(window.__alderHost?.client.document?.snapshot.runtime.executionReady && document.querySelector('.cm-content'))");
    const shortcut = async (key: string, code: string, virtualKeyCode: number, modifiers = 4) => {
      await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, modifiers });
      await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, modifiers });
    };
    for (let iteration = 1; iteration <= 20; iteration += 1) {
      const source = `value <- ${iteration}L\nvalue`;
      await browser.evaluate("(() => { document.querySelector('.cm-content')?.focus(); return true; })()");
      await replaceFocusedEditor(browser, source);
      if (iteration === 10) await shortcut('Enter', 'Enter', 13);
      await shortcut('s', 'KeyS', 83);
      await browser.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(source)} &&
        window.__alderHost.client.document.snapshot.dirty === false`, 15_000);
      const expected = `# %%\n${source}\n`;
      const deadline = Date.now() + 15_000;
      let saved = await readFile(path, 'utf8');
      while (saved !== expected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        saved = await readFile(path, 'utf8');
      }
      assert.equal(saved, expected);
    }
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production editor themes render real tokens and the inspector owns narrow focus', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-theme-'));
  const path = join(directory, 'theme.R');
  await writeFile(path, Array.from({ length: 18 }, (_, index) =>
    `# %% Cell ${index + 1}\nvalue_${index + 1} <- if (TRUE) "sample" else ${index}\nvalue_${index + 1}\n`,
  ).join(''));
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("Boolean(window.__alderHost?.client.document && document.querySelector('.cm-line span'))");
    const tokenColors = async (theme: 'light' | 'dark') => {
      await browser!.evaluate(`(async () => {
        const client = window.__alderHost.client;
        await client.setPreferences({theme:${JSON.stringify(theme)}}, client.document.snapshot.preferencesVersion);
      })()`);
      await browser!.wait(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
      return await browser!.evaluate(`Array.from(document.querySelectorAll('.cm-line span')).slice(0,12).map(node => getComputedStyle(node).color)`);
    };
    const light = await tokenColors('light');
    const dark = await tokenColors('dark');
    assert.ok(new Set(light).size >= 3, JSON.stringify(light));
    assert.ok(new Set(dark).size >= 3, JSON.stringify(dark));
    assert.notDeepEqual(light, dark);

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.wait("matchMedia('(max-width: 900px)').matches === false");
    await browser.evaluate(`(() => { const toggle = document.getElementById('panel-toggle'); toggle.focus(); toggle.click(); })()`);
    await browser.wait("document.getElementById('dataflow-panel').hidden === false && document.getElementById('dataflow-panel').getAttribute('role') === 'complementary'");
    assert.equal(await browser.evaluate(`document.activeElement === document.getElementById('panel-toggle')`), true,
      'opening the wide inspector must not steal focus');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.wait("document.getElementById('dataflow-panel').getAttribute('role') === 'dialog' && document.getElementById('notebook').inert");
    const geometry = await browser.evaluate(`(() => {
      const panel = document.getElementById('dataflow-panel');
      const rect = panel.getBoundingClientRect();
      const topbar = document.getElementById('topbar').getBoundingClientRect();
      return {position:getComputedStyle(panel).position, top:rect.top, bottom:rect.bottom, width:rect.width,
        innerHeight, topbarBottom:topbar.bottom, overflow:getComputedStyle(document.body).overflow,
        focused:panel.contains(document.activeElement), modal:panel.getAttribute('aria-modal')};
    })()`);
    assert.equal(geometry.position, 'fixed');
    assert.equal(geometry.modal, 'true');
    assert.equal(geometry.focused, true);
    assert.equal(geometry.overflow, 'hidden');
    assert.ok(geometry.top >= geometry.topbarBottom - 1, JSON.stringify(geometry));
    assert.ok(geometry.bottom <= 901, JSON.stringify(geometry));
    assert.ok(geometry.width <= 716, JSON.stringify(geometry));

    await browser.evaluate(`(() => {
      const panel = document.getElementById('dataflow-panel');
      const items = Array.from(panel.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])')).filter(node => !node.closest('[hidden], [aria-hidden=true]'));
      window.__drawerFocus = {first:items[0], last:items.at(-1)};
      items[0].focus();
    })()`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    assert.equal(await browser.evaluate(`document.activeElement === window.__drawerFocus.last`), true);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await browser.evaluate(`document.activeElement === window.__drawerFocus.first`), true);

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.wait("document.getElementById('dataflow-panel').getAttribute('role') === 'complementary' && !document.getElementById('notebook').inert");
    assert.equal(await browser.evaluate(`document.activeElement === document.getElementById('panel-toggle')`), true);
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Settings keeps context and actions visible while its body scrolls', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-settings-layout-'));
  const path = join(directory, 'settings.R');
  await writeFile(path, '# %%\nx <- 1\nx\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("Boolean(window.__alderHost?.client.document?.snapshot.runtime.executionReady && document.querySelector('.cm-content'))");
    for (const viewport of [{ width: 1280, height: 820 }, { width: 760, height: 700 }]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
      await browser.evaluate("document.getElementById('panel-toggle').focus(); window.__alderHost.view.performDesktopAction('settings')");
      await browser.wait("document.getElementById('settings').open");
      assert.equal(await browser.evaluate("document.getElementById('settings').contains(document.activeElement)"), true,
        `Settings must take focus at ${viewport.width}x${viewport.height}`);
      const top = await browser.evaluate(`(() => {
        const dialog = document.getElementById('settings').getBoundingClientRect();
        const head = document.querySelector('#settings .settings-head').getBoundingClientRect();
        const body = document.getElementById('settings-body');
        const actions = document.querySelector('#settings .settings-actions').getBoundingClientRect();
        return {dialog:{top:dialog.top,bottom:dialog.bottom,left:dialog.left,right:dialog.right},
          head:{top:head.top,bottom:head.bottom}, actions:{top:actions.top,bottom:actions.bottom},
          body:{top:body.getBoundingClientRect().top,bottom:body.getBoundingClientRect().bottom,
            clientHeight:body.clientHeight,scrollHeight:body.scrollHeight,scrollTop:body.scrollTop}};
      })()`);
      assert.ok(top.dialog.top >= 7 && top.dialog.bottom <= viewport.height - 7, JSON.stringify(top));
      assert.ok(top.head.bottom <= top.body.top + 1 && top.actions.top >= top.body.bottom - 1, JSON.stringify(top));
      assert.ok(top.body.scrollHeight > top.body.clientHeight, JSON.stringify(top));
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert.equal(await browser.evaluate("document.getElementById('settings').contains(document.activeElement)"), true);
      const scrolled = await browser.evaluate(`(() => {
        const body = document.getElementById('settings-body');
        const head = document.querySelector('#settings .settings-head').getBoundingClientRect();
        const actions = document.querySelector('#settings .settings-actions').getBoundingClientRect();
        body.scrollTop = body.scrollHeight;
        return new Promise(resolve => requestAnimationFrame(() => resolve({scrollTop:body.scrollTop,
          headTop:head.top, currentHeadTop:document.querySelector('#settings .settings-head').getBoundingClientRect().top,
          actionsBottom:actions.bottom, currentActionsBottom:document.querySelector('#settings .settings-actions').getBoundingClientRect().bottom})));
      })()`);
      assert.ok(scrolled.scrollTop > 0, JSON.stringify(scrolled));
      assert.ok(Math.abs(scrolled.headTop - scrolled.currentHeadTop) < 1, JSON.stringify(scrolled));
      assert.ok(Math.abs(scrolled.actionsBottom - scrolled.currentActionsBottom) < 1, JSON.stringify(scrolled));
      if (viewport.width === 1280) {
        await browser.click('#settings-cancel');
      } else {
        await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      await browser.wait("!document.getElementById('settings').open");
      assert.equal(await browser.evaluate("document.activeElement === document.getElementById('panel-toggle')"), true);
    }
    await browser.evaluate("document.getElementById('panel-toggle').focus(); window.__alderHost.view.performDesktopAction('settings')");
    await browser.wait("document.getElementById('settings').open");
    await browser.evaluate("document.getElementById('settings-table-page-size').value = '30'");
    await browser.click('#settings-apply');
    await browser.wait("!document.getElementById('settings').open && window.__alderHost.client.document.snapshot.config.table.page_size === 30");
    assert.equal(await browser.evaluate("document.activeElement === document.getElementById('panel-toggle')"), true);
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
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
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'a <- 40\na');
    await browser.evaluate(`(() => {
      const journey = window.__journey = {command: null, completed: null, editor: document.activeElement};
      document.addEventListener('click', event => { if (event.target.closest('[data-act=run]')) {
        if (!event.isTrusted) throw new Error('Run event was not trusted');
      } }, {capture:true, once:true});
      window.addEventListener('alder:host-command', event => { if (event.detail.command.type === 'run') { journey.command = event.detail.command; journey.result = event.detail.result; } });
      journey.done = new Promise((resolve,reject) => {
        const cleanup = () => { clearTimeout(timer); unsubscribe(); window.removeEventListener('alder:host-command', onResult); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('no current chain result')); }, 15000);
        const finish = () => {
          if (!journey.command || !journey.completed) return;
          const event = journey.completed;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            try {
              const document = window.__alderHost.client.document;
              if (event.operationId !== journey.command.requestId) throw new Error('wrong request');
              if (journey.result.error !== null) throw new Error('Run failed: ' + JSON.stringify(journey.result.error));
              if (document.snapshot.cells[0].revision !== 1 || document.snapshot.cells[0].body[0] !== 'a <- 40') throw new Error('wrong source');
              cleanup();
              resolve({runId:event.runId, revision:document.snapshot.cells[0].revision});
            } catch(error) { cleanup(); reject(error); }
          }));
        };
        const onResult = event => { if (event.detail.command.type === 'run') finish(); };
        window.addEventListener('alder:host-command', onResult);
        const unsubscribe = window.__alderHost.client.subscribe((_document,event) => {
          if (event?.type !== 'cell-completed' || event.cellId !== 'cell-3') return;
          journey.completed = event;
          finish();
        });
      });
    })()`);
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    const result = await browser.evaluate('window.__journey.done');
    assert.equal(await browser.evaluate('document.activeElement === window.__journey.editor'), true, 'pointer Run must preserve editor focus');
    await browser.evaluate(`document.querySelector('[data-cell="cell-3"]').scrollIntoView({block:'center'})`);
    await browser.wait(`(() => {
      const output = document.querySelector('[data-cell="cell-3"] [data-role=output]');
      return output?.textContent.includes('42');
    })()`);
    assert.equal(result.revision, 1);
    assert.deepEqual(await browser.evaluate(`window.__journey.command.changes.filter(change => change.type === 'edit').map(change => change.body)`), [['a <- 40', 'a']]);
    assert.equal(app.controller.snapshot().cells[2]!.status, 'done');
    const targets = await browser.evaluate(`(() => {
      const run = document.querySelector('[data-cell="cell-3"] [data-act=run]').getBoundingClientRect();
      const menu = document.querySelector('[data-cell="cell-3"] details.cell-overflow > summary').getBoundingClientRect();
      const insert = document.querySelector('[data-cell="cell-3"] [data-act=add]').getBoundingClientRect();
      const bottom = document.querySelector('.empty-bar [data-act=add]').getBoundingClientRect();
      return {run:[run.width,run.height],menu:[menu.width,menu.height],insert:[insert.width,insert.height],bottom:[bottom.width,bottom.height]};
    })()`);
    for (const size of Object.values(targets) as number[][]) assert.ok(size[0]! >= 28 && size[1]! >= 28, JSON.stringify(targets));
    await browser.click('[data-cell="cell-3"] [data-act=add][data-type=code]');
    await browser.wait("document.querySelectorAll('#notebook > .cell').length === 4 && document.activeElement?.classList.contains('cm-content')");
    await browser.wait('window.__alderHost.client.document.cells.every(cell => cell.id !== null)');
    assert.equal(await browser.evaluate("document.activeElement?.classList.contains('cm-content')"), true);
    await browser.click('[data-cell="cell-3"] details.cell-overflow > summary');
    await browser.wait("document.querySelector('[data-cell=\"cell-3\"] details.cell-overflow').open");
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.wait("!document.querySelector('[data-cell=\"cell-3\"] details.cell-overflow').open && document.activeElement === document.querySelector('[data-cell=\"cell-3\"] details.cell-overflow > summary')");
    await browser.click('#notebook > .cell:nth-of-type(4) .cm-content');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    await browser.wait("document.querySelectorAll('#notebook > .cell').length === 5 && document.activeElement?.closest('.cell') === document.querySelector('#notebook > .cell:nth-of-type(5)')");
    await browser.click('.empty-bar [data-act=add]');
    await browser.wait("document.querySelectorAll('#notebook > .cell').length === 6 && document.activeElement?.closest('.cell') === document.querySelector('#notebook > .cell:nth-of-type(6)')");
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'Sys.sleep(5)\na <- 40\na');
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait(`document.querySelector('[data-cell="cell-1"]').classList.contains('running') &&
      document.querySelector('#stop').disabled === false`);
    await browser.click('#stop');
    await browser.wait(`(() => {
      const snapshot = window.__alderHost.client.document.snapshot;
      const cell = document.querySelector('[data-cell="cell-1"]');
      const run = cell?.querySelector('[data-act=run]');
      return snapshot.runtime.busy === false && snapshot.cells[0].status === 'stopped' &&
        snapshot.cells[0].error === null && cell?.classList.contains('stopped') &&
        !cell.classList.contains('error') && cell.querySelector('[data-role=badge]')?.textContent === 'stopped' &&
        run?.disabled === false && !document.querySelector('#status')?.classList.contains('error');
    })()`);
    assert.equal(app.controller.snapshot().cells[0]?.status, 'stopped',
      'long evaluations must show running feedback and remain stoppable');
    assert.equal(app.controller.snapshot().cells[0]?.error, null);
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'a <- 40\na');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 4 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 4 });
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.slice(0,3).every(cell => cell.status === 'done') &&
      document.querySelector('[data-cell="cell-3"] [data-role=output]').textContent.includes('42')`);
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))');
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="cell-1"]').classList.contains('done')`), true,
      'a deferred started projection must not replace a completed result');
    assert.equal(app.controller.snapshot().cells[0]?.status, 'done');
    assert.equal(app.controller.snapshot().cells[0]?.error, null);
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ host: app?.controller.snapshot(), browser: await browser?.evaluate(
      "({status:document.querySelector('#status')?.textContent, journey:window.__journey && {command:__journey.command,completed:__journey.completed},cells:window.__alderHost?.client.document?.snapshot.cells})"
    ).catch(() => null), errors: browser?.errors }));
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('long notebooks virtualize editors and preserve edited source through recovery', {
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
    await replaceFocusedEditor(browser, 'value_75 <- 7500\nvalue_75');
    assert.equal(await browser.evaluate(`(() => {
      const cell = document.querySelector('[data-cell="cell-75"]');
      const handle = window.__alderEditors.get('cell:cell-75');
      if (!cell || !handle || handle.getDoc() !== 'value_75 <- 7500\\nvalue_75') return false;
      window.scrollTo(0, 0);
      return true;
    })()`), true);
    await browser.wait(`(() => {
      const first = document.querySelector('[data-cell="cell-1"]');
      const rect = first?.getBoundingClientRect();
      return rect && rect.bottom > 0 && rect.top < window.innerHeight;
    })() && document.querySelectorAll('.cm-content').length < 25 &&
      window.__alderHost.client.document.cell('cell-75').desiredBody.join('\\n') === 'value_75 <- 7500\\nvalue_75'`);

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
    assert.deepEqual(await browser.evaluate(`window.__alderHost.client.document.cell('cell-75').desiredBody`), ['value_75 <- 7500', 'value_75']);
    assert.equal(app.controller.snapshot().cells[79]!.body[0], 'value_80 <- 8000');

    await browser.evaluate('window.__alderHost.client.commitEdits()');
    await browser.wait(`window.__alderHost.client.document.cell('cell-75').serverRevision === 1 &&
      window.__alderHost.client.document.snapshot.cells.every(cell => !cell.analysisPending) &&
      window.__alderHost.client.document.snapshot.runtime.busy === false`, 30_000);
    await browser.activateVirtualEditor('cell-1');
    await browser.wait(`!document.querySelector('[data-cell="cell-1"] [data-act=run]')?.disabled &&
      document.querySelector('[data-cell="cell-1"] .cm-content') !== null`);
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells[0].status === 'done' &&
      document.querySelector('[data-cell="cell-1"] [data-role=output]')?.textContent.trim() === '[1] 1'`, 30_000);
    assert.deepEqual(await browser.evaluate(`({
      orderPreserved: [...document.querySelectorAll('#notebook > .cell[data-cell]')]
        .every((node, index) => node.dataset.cell === 'cell-' + (index + 1)),
      sourcePreserved: window.__alderHost.client.document.cell('cell-75').desiredBody.join('\\n') === 'value_75 <- 7500\\nvalue_75',
    })`), { orderPreserved: true, sourcePreserved: true });
    await browser.click('#panel-toggle');
    await browser.wait("document.getElementById('dataflow-panel').hidden === false && document.getElementById('dataflow-panel').getAttribute('role') === 'complementary'");
    await browser.click('#panel-tab-variables');
    await browser.wait(`document.querySelector('#panel-variables .variable-row[data-target-cell="cell-1"] .variable-name')?.textContent === 'value_1'`);
    const renameSnapshot = app.controller.snapshot();
    const renameCell = renameSnapshot.cells.find(cell => cell.id === 'cell-90');
    assert.ok(renameCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: renameSnapshot.documentRevision, changes: [{
        type: 'options', cell: { cellId: 'cell-90' }, expectedRevision: renameCell.revision, patch: { name: 'tail' },
      }],
    }))).error, null);
    await browser.click('#panel-tab-outline');
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
    assert.deepEqual(await browser.evaluate(`window.__alderHost.client.document.cell('cell-75').desiredBody`), ['value_75 <- 7500', 'value_75']);
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ host: app?.controller.snapshot(), browser: await browser?.evaluate(
      "({states:window.__transportStates,cells:window.__alderHost?.client.document?.cells.map(c=>({id:c.id,revision:c.serverRevision,conflict:c.conflict,tombstone:c.tombstone,body:c.desiredBody})),editors:window.__alderEditors?.size,status:document.querySelector('#status')?.textContent})"
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

test('virtualized short and mixed-output notebooks keep requested cells anchored', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-geometry-'));
  const path = join(directory, 'geometry.R');
  const source = Array.from({ length: 45 }, (_value, index) => {
    const cell = index + 1;
    const body = cell === 8 ? "data.frame(group = letters[1:8], value = seq_len(8))"
      : cell === 24 ? "plot(1:12, (1:12)^2, type = 'b', col = 'steelblue')"
      : cell === 39 ? "warning('review this result'); 39L"
      : `value_${cell} <- ${cell}L\nvalue_${cell}`;
    return `# %%\n${body}\n`;
  }).join('');
  await writeFile(path, source);
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: 'lazy' });
    browser = await openAuthenticatedBrowser(app);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && document.querySelectorAll('#notebook > .cell').length === 45", 30_000);
    await browser.wait("document.querySelectorAll('[data-virtual-source]').length > 15 && document.querySelectorAll('.cm-content').length < 25");
    await browser.evaluate(`window.__measureCellAnchor = async id => {
      const cell = document.querySelector('[data-cell="cell-' + id + '"]');
      if (!cell) throw new Error('missing cell ' + id);
      cell.scrollIntoView({block:'center'});
      const initialTop = cell.getBoundingClientRect().top;
      const initialHeight = document.documentElement.scrollHeight;
      let previousTop = initialTop, previousHeight = initialHeight, stable = 0;
      for (let frame = 0; frame < 30 && stable < 3; frame += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const top = cell.getBoundingClientRect().top;
        const height = document.documentElement.scrollHeight;
        if (Math.abs(top - previousTop) < .25 && Math.abs(height - previousHeight) < .25) stable += 1;
        else stable = 0;
        previousTop = top;
        previousHeight = height;
      }
      return {id, drift:Math.abs(previousTop - initialTop), heightDrift:Math.abs(previousHeight - initialHeight),
        top:previousTop, height:previousHeight, stable};
    }`);
    const measureSequence = async () => await browser!.evaluate(`(async () => {
      const results = [];
      for (const id of [1, 28, 45, 1]) results.push(await window.__measureCellAnchor(id));
      return results;
    })()`);
    const shortCells = await measureSequence();
    for (const result of shortCells) {
      assert.ok(result.stable >= 3, JSON.stringify(shortCells));
      assert.ok(result.drift <= 8, JSON.stringify(shortCells));
      assert.ok(result.heightDrift <= 8, JSON.stringify(shortCells));
    }

    await browser.evaluate(`(async () => {
      const client = window.__alderHost.client;
      for (const id of ['cell-8', 'cell-24', 'cell-39']) {
        const started = await client.startRunCell(client.document.cell(id).key);
        await started.completed;
      }
    })()`);
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.filter(cell => ['cell-8','cell-24','cell-39'].includes(cell.id)).every(cell => cell.status === 'done') &&
      document.querySelector('[data-cell="cell-24"] [data-role=output] img')?.complete`, 30_000);
    await browser.evaluate(`(async () => {
      let previous = document.documentElement.scrollHeight, stable = 0;
      for (let frame = 0; frame < 30 && stable < 3; frame += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const height = document.documentElement.scrollHeight;
        if (Math.abs(height - previous) < .25) stable += 1; else stable = 0;
        previous = height;
      }
      if (stable < 3) throw new Error('mixed-output notebook geometry did not settle');
    })()`);
    const mixedOutput = await measureSequence();
    for (const result of mixedOutput) {
      assert.ok(result.stable >= 3, JSON.stringify(mixedOutput));
      assert.ok(result.drift <= 8, JSON.stringify(mixedOutput));
      assert.ok(result.heightDrift <= 8, JSON.stringify(mixedOutput));
    }
    assert.deepEqual(browser.errors, []);
  } finally {
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
    await browser.wait(`window.__alderEditors.get('cell:cell-1')?.getDoc() === 'local <- 2\\nlocal'`);
    const conflictSnapshot = app.controller.snapshot();
    const conflictCell = conflictSnapshot.cells.find(cell => cell.id === 'cell-1');
    assert.ok(conflictCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: conflictSnapshot.documentRevision, changes: [{
        type: 'edit', cell: { cellId: 'cell-1' }, expectedRevision: 0, cellType: 'code', body: ['peer <- 9', 'peer'],
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('[data-cell="cell-1"]')?.classList.contains('source-conflict') &&
      window.__alderEditors.get('cell:cell-1')?.getDoc() === 'local <- 2\\nlocal'`);
    await browser.send('Input.insertText', { text: '\n# retained' });
    await browser.wait(`window.__alderEditors.get('cell:cell-1')?.getDoc() === 'local <- 2\\nlocal\\n# retained' &&
      window.__alderHost.client.document.cell('cell-1').conflict === true`);
    const conflictRevision = app.controller.snapshot().documentRevision;
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait("document.querySelector('#status')?.textContent.includes('resolve deleted or conflicting local source')");
    assert.equal(app.controller.snapshot().documentRevision, conflictRevision);
    assert.deepEqual(app.controller.snapshot().cells[0]!.body, ['peer <- 9', 'peer']);
    assert.equal(app.controller.snapshot().cells[0]!.revision, 1);

    await browser.click('[data-cell="cell-1"] [data-recovery-action="use-incoming"]');
    await browser.wait(`!document.querySelector('[data-cell="cell-1"]')?.classList.contains('source-conflict') &&
      window.__alderEditors.get('cell:cell-1')?.getDoc() === 'peer <- 9\\npeer'`);
    await browser.click('[data-cell="cell-1"] .cm-content');
    await replaceFocusedEditor(browser, 'draft <- 123\ndraft');
    await browser.wait(`window.__alderEditors.get('cell:cell-1')?.getDoc() === 'draft <- 123\\ndraft'`);
    const deleteSnapshot = app.controller.snapshot();
    const deleteCell = deleteSnapshot.cells.find(cell => cell.id === 'cell-1');
    assert.ok(deleteCell);
    assert.equal((await app.controller.dispatch(peerCommand(app, {
      type: 'transaction', expectedDocumentRevision: deleteSnapshot.documentRevision, changes: [{
        type: 'delete', cell: { cellId: 'cell-1' }, expectedRevision: deleteCell.revision,
      }],
    }))).error, null);
    await browser.wait(`document.querySelector('[data-cell="cell-1"]')?.classList.contains('tombstone') &&
      window.__alderEditors.get('cell:cell-1')?.getDoc() === 'draft <- 123\\ndraft' &&
      document.activeElement?.closest('[data-cell="cell-1"]') !== null`);
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="cell-1"] [role=alert]')?.textContent.includes('local draft')`), true);

    await browser.click('[data-cell="cell-1"] [data-recovery-action="restore-new"]');
    await browser.wait(`window.__alderHost.client.document.cells.length === 1 &&
      window.__alderHost.client.document.cells[0].id !== null &&
      window.__alderHost.client.document.cells[0].tombstone === false &&
      window.__alderHost.client.document.cells[0].desiredBody.join('\\n') === 'draft <- 123\\ndraft'`, 30_000);
    const restoredId = await browser.evaluate('window.__alderHost.client.document.cells[0].id');
    assert.equal(await browser.evaluate(`document.querySelector('[data-cell="${restoredId}"]') !== null`), true);
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
    await browser.click(`[data-cell="${restoredId}"] [data-recovery-action="discard-local"]`);
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
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 8000, deviceScaleFactor: 1, mobile: false });
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && !window.__alderHost.client.document.snapshot.runtime.busy && !document.querySelector('#run-all')?.disabled && document.querySelectorAll('#notebook > .cell[data-cell]').length === 6", 30_000);
    await browser.click('#run-all');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.every(cell => cell.status === 'done')`, 45_000);
    await browser.evaluate(`document.querySelector('[data-cell="cell-3"]').scrollIntoView({block:'center'})`);
    await browser.wait(`document.querySelector('[data-cell="cell-3"] [data-role=output]')?.textContent.includes('VALUE=3')`);
    await browser.evaluate(`document.querySelector('[data-cell="cell-4"]').scrollIntoView({block:'center'})`);
    await browser.wait(`document.querySelector('[data-cell="cell-4"] img.plot')?.complete && document.querySelector('[data-cell="cell-4"] img.plot')?.naturalWidth > 0`, 30_000);
    await browser.evaluate(`document.querySelector('[data-cell="cell-5"]').scrollIntoView({block:'center'})`);
    await browser.wait(`document.querySelector('[data-cell="cell-5"] .table-page-label')?.textContent.includes('1..25 of 60')`);
    await browser.evaluate(`document.querySelector('[data-cell="cell-6"]').scrollIntoView({block:'center'})`);
    await browser.wait(`document.querySelector('[data-cell="cell-6"] .out-lazy') !== null`);
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
      document.querySelector('[data-cell="cell-3"] [data-role=output]')?.textContent.includes('VALUE=4') &&
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
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 8000, deviceScaleFactor: 1, mobile: false });
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && !window.__alderHost.client.document.snapshot.runtime.busy && !document.querySelector('#run-all')?.disabled && document.querySelectorAll('#notebook > .cell[data-cell]').length === 8", 30_000);
    await browser.evaluate("window.__alderHost.client.runAll('all')");
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.every(cell => cell.status === 'done')`, 45_000);
    for (const [cell, text] of [['cell-3', '14'], ['cell-6', 'not submitted'], ['cell-8', '0']]) {
      await browser.evaluate(`document.querySelector('[data-cell=${JSON.stringify(cell)}]').scrollIntoView({block:'center'})`);
      await browser.wait(`document.querySelector('[data-cell=${JSON.stringify(cell)}] [data-role=output]')?.textContent.includes(${JSON.stringify(text)})`);
    }
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
      await browser.wait(`document.querySelector('[data-cell="cell-3"] [data-role=output]')?.textContent.includes('21') &&
        window.__alderHost.client.document.snapshot.cells[2].status === 'done'`, 30_000);
      assert.equal(doneRuns.get('cell-3')?.size, 1);
      assert.equal(doneRuns.get('cell-4')?.size ?? 0, 0);
      assert.equal(await browser.evaluate(`window.__alderHost.client.setWidget('gain', [], {value:9}, 'editor', window.__oldGainOrigin)
        .then(() => 'accepted', error => error.code)`), 'widget_not_current');
      assert.equal((app.controller.snapshot().cells[1]!.outputs[0]!.data as { spec: { value: number } }).spec.value, 3);
      doneRuns.clear();

      assert.equal(await browser.evaluate(`(() => {
        const control = document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=slider]');
        window.__formEvents = [];
        for (const target of document.querySelectorAll('[data-cell="cell-5"] [data-role=widget]')) {
          for (const type of ['keydown', 'keyup', 'input', 'change', 'mousedown', 'mouseup', 'click']) {
            target.addEventListener(type, event => window.__formEvents.push({type, kind:target.dataset.kind,
              value:target.value, checked:target.checked, trusted:event.isTrusted,
              active:document.activeElement?.dataset?.kind || document.activeElement?.tagName}));
          }
        }
        control?.focus();
        return control?.value === '2' && document.activeElement === control;
      })()`), true);
      await arrowRight();
      await browser.wait(`document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=slider]')?.value === '3' &&
        window.__alderHost.client.document.snapshot.cells[4].outputs[0]?.data?.spec?.child?.value?.factor === 3`, 30_000);
      await browser.click('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]');
      await browser.wait(`document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]')?.checked === true &&
        window.__alderHost.client.document.snapshot.cells[4].outputs[0]?.data?.spec?.child?.value?.enabled === true &&
        window.__alderHost.client.document.snapshot.cells[4].outputs[0]?.data?.spec?.child?.value?.factor === 3 &&
        document.querySelector('[data-cell="cell-5"] [data-form-submit=true]')?.disabled === false`, 30_000);
      assert.deepEqual(await browser.evaluate(`window.__formEvents.map(event => [event.type, event.kind, event.trusted])`), [
        ['keydown', 'slider', true], ['input', 'slider', true], ['change', 'slider', true], ['keyup', 'slider', true],
        ['mousedown', 'checkbox', true], ['mouseup', 'checkbox', true], ['click', 'checkbox', true],
        ['input', 'checkbox', true], ['change', 'checkbox', true],
      ]);
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const expected = iteration % 2 === 1;
        await browser.click('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]');
        await browser.wait(`document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]')?.checked === ${expected} &&
          window.__alderHost.client.document.snapshot.cells[4].outputs[0]?.data?.spec?.child?.value?.enabled === ${expected} &&
          document.querySelector('[data-cell="cell-5"] [data-role=widget][data-name=settings][data-kind=checkbox]')?.disabled === false`, 8_000);
      }
      assert.equal(doneRuns.get('cell-6')?.size ?? 0, 0);
      assert.match(String(await browser.evaluate("document.querySelector('[data-cell=\"cell-6\"] [data-role=output]').textContent")), /not submitted/);
      await browser.evaluate(`(() => {
        window.__formClicks = [];
        const submit = document.querySelector('[data-cell="cell-5"] [data-form-submit=true]');
        submit.addEventListener('click', event => window.__formClicks.push({trusted:event.isTrusted,disabled:submit.disabled}));
      })()`);
      await browser.click('[data-cell="cell-5"] [data-form-submit=true]');
      await browser.wait('window.__formClicks.length > 0', 3_000);
      assert.equal((await browser.evaluate('window.__formClicks'))[0].trusted, true);
      await browser.wait(`document.querySelector('[data-cell="cell-6"] [data-role=output]')?.textContent.includes('21') &&
        window.__alderHost.client.document.snapshot.cells[5].status === 'done'`, 8_000);
      assert.equal(doneRuns.get('cell-6')?.size, 1);
      doneRuns.clear();

      await browser.click('[data-cell="cell-7"] [data-role=widget][data-name=clicks]');
      await browser.wait(`document.querySelector('[data-cell="cell-8"] [data-role=output]')?.textContent.includes('[1] 1') &&
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
      return { formClicks:window.__formClicks, formEvents:window.__formEvents, submitDisabled:submit?.disabled, origin:submit && output?.controlOrigins?.get(submit),
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

test('ordered outputs, lazy detail, progress, and project disk cache appear in the notebook', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-output-cache-'));
  const path = join(directory, 'notebook.R');
  await mkdir(join(directory, '.alder'));
  await writeFile(join(directory, '.alder', 'config.yaml'), 'cache:\n  dir: project-cache\n');
  await writeFile(path, [
    '# %%', 'library(alder)',
    '# %%', 'out$append(out$md("**First**: six observations")); cat("Second: calculated table\\n"); out$append(data.frame(group=c("a","b"), total=c(6L,15L))); "Fourth: complete"',
    '# %%', 'p <- out$progress(total=3, label="Rows"); for (i in 1:3) p$update(i); p$close(); sum(1:3)',
    '# %%', 'plot(1:3, c(2,4,6), type="b", main="Three points")',
    '# %%', 'out$lazy(function() out$vstack(out$md("**Deferred**: six"), data.frame(i=1:3, doubled=c(2L,4L,6L))), label="Show detail")',
    '# %%', 'multiplier <- 2L',
    '# %%', 'saved <- cache$disk(function(x) { message("compute disk"); x * multiplier }); saved(4L)',
  ].join('\n') + '\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: 'automatic' });
    assert.equal(app.controller.snapshot().config.cache.dir, 'project-cache');
    browser = await openAuthenticatedBrowser(app);
    await browser.wait("window.__alderHost?.client.document?.snapshot.runtime.executionReady && !window.__alderHost.client.document.snapshot.runtime.busy && !document.querySelector('#run-all')?.disabled && document.querySelectorAll('#notebook > .cell[data-cell]').length === 7", 30_000);
    await browser.click('#run-all');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells.every(cell => cell.status === 'done') &&
      document.querySelector('[data-cell="cell-2"] .markdown-output')?.textContent.includes('First') &&
      document.querySelector('[data-cell="cell-2"] .table-preview')?.textContent.includes('15') &&
      document.querySelector('[data-cell="cell-3"] [data-role=output]')?.textContent.includes('[1] 6') &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.complete &&
      document.querySelector('[data-cell="cell-4"] img.plot')?.naturalWidth > 0 &&
      document.querySelector('[data-cell="cell-5"] .out-lazy')?.textContent.includes('Show detail') &&
      document.querySelector('[data-cell="cell-7"] [data-role=output]')?.textContent.includes('[1] 8')`, 45_000);
    assert.deepEqual(await browser.evaluate(`Array.from(document.querySelector('[data-cell="cell-2"] [data-role=output]').children)
      .filter(child => child.classList.contains('out-record') || child.classList.contains('ordered-log'))
      .map(child => child.classList.contains('ordered-log') ? 'log' : child.querySelector('.markdown-output') ? 'markdown' :
        child.querySelector('.table-preview') ? 'table' : 'text')`), ['markdown', 'log', 'table', 'text']);
    assert.equal(await browser.evaluate("document.querySelector('[data-cell=\"cell-3\"] .progress-row') === null"), true);
    assert.equal((await readdir(join(directory, 'project-cache'))).filter((name) => name.endsWith('.rds')).length, 1);

    await browser.click('[data-cell="cell-5"] .out-lazy');
    await browser.wait(`document.querySelector('[data-cell="cell-5"] .markdown-output')?.textContent.includes('Deferred') &&
      document.querySelector('[data-cell="cell-5"] .table-preview')?.textContent.includes('6')`, 30_000);

    const firstRun = app.controller.snapshot().cells[6]!.outputs[0]!.runId;
    await browser.click('[data-cell="cell-7"] [data-act=run]');
    await browser.wait(`window.__alderHost.client.document.snapshot.cells[6].status === 'done' &&
      window.__alderHost.client.document.snapshot.cells[6].outputs[0]?.runId !== ${JSON.stringify(firstRun)}`, 30_000);
    assert.equal(app.controller.snapshot().cells[6]!.log.some((line) => line.includes('compute disk')), false);

    await browser.evaluate(`(async () => {
      const client = window.__alderHost.client;
      client.editCell(client.document.cells[5].key, 'multiplier <- 3L');
      await client.commitEdits();
    })()`);
    await browser.wait(`window.__alderHost.client.document.snapshot.cells[5].body[0] === 'multiplier <- 3L' &&
      window.__alderHost.client.document.snapshot.cells[6].status === 'done' &&
      document.querySelector('[data-cell="cell-7"] [data-role=output]')?.textContent.includes('[1] 12')`, 10_000);
    assert.equal(app.controller.snapshot().cells[6]!.log.some((line) => line.includes('compute disk')), true);
    assert.equal((await readdir(join(directory, 'project-cache'))).filter((name) => name.endsWith('.rds')).length, 2);
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ cells: app?.controller.snapshot().cells.map((cell) => ({
      id: cell.id, body: cell.body, status: cell.status, outputs: cell.outputs.map((output) => output.data), log: cell.log, error: cell.error,
    })), browser: await browser?.evaluate("({status:document.querySelector('#status')?.textContent,active:document.activeElement?.outerHTML?.slice(0,200)})").catch(() => null) }));
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Ark language help shows live completion and diagnostics in notebook editors', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-browser-ark-help-'));
  const path = join(directory, 'notebook.R');
  await writeFile(path, '# %%\nmy_table <- data.frame(long_column = 1L)\n# %%\nmy_table$lo\n# %%\nmissing_symbol\n');
  let app: RunningHost | undefined, browser: Chrome | undefined;
  try {
    app = await startInstalledHost(path);
    browser = await openAuthenticatedBrowser(app);
    await browser.wait(`window.__alderHost?.client.document?.snapshot.runtime.executionReady &&
      !window.__alderHost.client.document.snapshot.cells[0].analysisPending &&
      document.querySelectorAll('#notebook > .cell[data-cell]').length === 3 &&
      !document.querySelector('[data-cell="cell-1"] [data-act=run]')?.disabled`, 30_000);
    await browser.click('[data-cell="cell-1"] [data-act=run]');
    await browser.wait("window.__alderHost.client.document.snapshot.cells[0].status === 'done'", 30_000);
    await browser.evaluate(`(() => {
      const editor = [...window.__alderEditors.values()][1];
      editor.focus();
      const end = editor.view.state.doc.length;
      editor.view.dispatch({ selection: { anchor: end, head: end } });
    })()`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await browser.wait("document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('long_column')", 15_000);
    await browser.evaluate(`(() => {
      const editor = [...window.__alderEditors.values()][1];
      editor.closeCompletion();
      editor.view.dispatch({ selection: { anchor: 2, head: 2 } });
    })()`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
    await browser.wait("document.activeElement?.closest('[data-cell=\"cell-1\"]') !== null", 15_000);

    const snapshot = app.controller.snapshot();
    const preference = await app.controller.dispatch(peerCommand(app, {
      type: 'set-preferences', patch: { editor: { live_diagnostics: true } },
      expectedPreferencesVersion: snapshot.preferencesVersion ?? null,
    }));
    assert.equal(preference.error, null);
    await browser.wait("window.__alderHost.client.document.snapshot.editorDiagnostics['cell-3']?.some(d => d.message.includes('missing_symbol'))", 15_000);
    await browser.wait("document.querySelector('[data-cell=\"cell-3\"] .cm-lintRange') !== null", 15_000);
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
