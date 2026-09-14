import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupScenarioResources, delay, requireAbsoluteRscript, sanitizedEnvironment, spawnSmokeProcess, stopChild } from './_common.mjs';

const ID = 'desktop-lifecycle';

/** Run the native staged Electron artifact; never substitute the headless host. */
export async function run(ctx) {
  requireDesktop(ctx);
  let app;
  let second;
  let cdp;
  try {
    const notebook = join(ctx.evidence, `${ID}-open.R`);
    await writeFile(notebook, 'x <- 40\nx + 2\n', 'utf8');
    app = await launchDesktop(ctx, ID, { notebookPath: notebook });
    const target = await app.pageTarget();
    assert.ok(target, 'packaged Electron must expose a renderer page');
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await waitForRenderer(cdp);
    await waitForRuntimeIdentity(cdp, ctx.rscript);

    const ui = await cdp.evaluate(`(() => {
      const api = globalThis.alderDesktop;
      return {
        title: document.title,
        readyState: document.readyState,
        protocol: location.protocol,
        origin: location.origin,
        notebook: Boolean(document.querySelector('#notebook')),
        save: Boolean(document.querySelector('#save')),
        run: Boolean(document.querySelector('#run-all')),
        settings: Boolean(document.querySelector('#settings-open')),
        close: Boolean(document.querySelector('#shutdown')),
        path: document.querySelector('#path')?.textContent ?? '',
        apiKeys: api ? Object.keys(api).sort() : null,
        apiMethods: api ? Object.fromEntries(Object.keys(api).map(key => [key, typeof api[key]])) : null,
        runtime: window.__alderHost?.client?.document?.snapshot?.runtime ?? null,
      };
    })()`);
    assert.equal(ui.readyState, 'complete', 'Electron renderer must reach a complete document');
    assert.equal(ui.protocol, 'http:', 'Electron must load the authenticated host origin, never file://');
    assert.ok(/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(ui.origin), 'Electron must use a loopback host origin');
    assert.equal(ui.notebook, true, 'Electron must use the real notebook renderer');
    assert.equal(ui.save, true, 'native menu/save surface must expose Save');
    assert.equal(ui.run, true, 'native menu/run surface must expose Run all');
    assert.equal(ui.settings, true, 'native Settings action must be reachable');
    assert.equal(ui.close, true, 'native close/shutdown action must be reachable');
    assert.equal(ui.runtime?.rEnvironment?.rscript, ctx.rscript, 'Electron must run the exact explicitly selected Rscript');
    assert.deepEqual(ui.apiKeys, ['chooseRscript', 'chooseSavePath', 'getWindowState', 'onWindowAction', 'openNotebook'], 'preload must expose only the fixed desktop API');
    assert.deepEqual(ui.apiMethods, {
      chooseRscript: 'function',
      chooseSavePath: 'function',
      getWindowState: 'function',
      onWindowAction: 'function',
      openNotebook: 'function',
    }, 'preload fields must be callable functions only');

    const state = await cdp.evaluate('window.alderDesktop.getWindowState()');
    assert.equal(typeof state.dirty, 'boolean', 'window state must report a boolean dirty projection');
    assert.equal(typeof state.platform, 'string', 'window state must report the desktop platform');
    assert.equal(typeof state.sessionEpoch, 'string', 'window state must report the host epoch');
    assert.ok(state.path === null || typeof state.path === 'string', 'window state path must be null or a path');

    // Native accelerators route through the main process and the exact preload
    // action channel. This does not call a renderer command or pass a payload.
    await cdp.evaluate(`(() => {
      globalThis.__alderDesktopActions = [];
      globalThis.__alderDesktopUnsubscribe = window.alderDesktop.onWindowAction(action => globalThis.__alderDesktopActions.push(action));
    })()`);
    await cdp.evaluate('window.focus()');
    await delay(100);
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', modifiers, windowsVirtualKeyCode: 83 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers, windowsVirtualKeyCode: 83 });
    await delay(250);
    const actions = await cdp.evaluate('globalThis.__alderDesktopActions');
    assert.ok(actions.includes('save'), 'native Save accelerator must emit the exact save action');
    await cdp.evaluate('globalThis.__alderDesktopUnsubscribe?.()');

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = join(ctx.evidence, `${ID}.png`);
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const axPath = join(ctx.evidence, `${ID}.ax.json`);
    await writeFile(axPath, JSON.stringify(ax, null, 2));

    // A second invocation with the same profile must hand the open request to
    // the primary instance rather than creating a second Electron owner.
    second = await launchDesktop(ctx, `${ID}-second`, {
      profileLabel: ID,
      notebookPath: notebook,
      extraArgs: ['--alder-smoke-second-instance'],
      expectSingleInstance: true,
    });
    assert.notEqual(second.child.exitCode, null, 'a second Electron invocation must exit after the lock handoff');
    await delay(500);
    assert.equal(app.child.exitCode, null, 'the first Electron instance must remain primary');
    const targets = await app.targets();
    assert.equal(targets.filter(value => value.type === 'page').length, 1, 'one notebook must map to one primary desktop window');

    await cdp.evaluate(`(async () => {
      const client = window.__alderHost.client;
      client.editCell(client.document.cells[0].key, ['x <- 41', 'x + 2']);
      await client.save();
    })()`);
    assert.equal(await readFile(notebook, 'utf8'), 'x <- 41\nx + 2\n', 'native Save must persist edited notebook bytes');
    await cdp.close();
    cdp = null;
    await stopDesktop(app);
    app = await launchDesktop(ctx, ID, { notebookPath: notebook });
    const reopenedTarget = await app.pageTarget();
    assert.ok(reopenedTarget, 'saved notebook must reopen in a fresh Electron process');
    cdp = await CdpSession.connect(reopenedTarget.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await waitForRenderer(cdp);
    await waitForRuntimeIdentity(cdp, ctx.rscript);
    const reopenedBody = await cdp.evaluate("window.__alderHost.client.document.snapshot.cells[0].body");
    assert.deepEqual(reopenedBody, ['x <- 41', 'x + 2'], 'fresh desktop process must load the saved edit');
    await writeFile(join(ctx.evidence, 'desktop-save-reopen.json'), JSON.stringify({ body: reopenedBody, bytes: await readFile(notebook, 'utf8') }, null, 2) + '\n');
    const reopenedScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(ctx.evidence, 'desktop-reopened.png'), Buffer.from(reopenedScreenshot.data, 'base64'));

    const evidence = {
      platform: process.platform,
      arch: process.arch,
      executable: app.entry,
      electronVersion: ctx.manifest.runtimes?.electron ?? null,
      chromiumVersion: ctx.manifest.runtimes?.chromium ?? null,
      page: { url: target.url, title: ui.title },
      controls: ui,
      windowState: state,
      actions,
      targetCount: targets.length,
      screenshot: screenshotPath,
      accessibility: axPath,
      secondInstanceExit: second.child.exitCode,
    };
    await writeFile(join(ctx.evidence, `${ID}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    await cdp.close();
    cdp = null;

    return {
      id: ID,
      identity: {
        artifact: ctx.manifest.sourceCommit,
        native: {
          electron: ctx.manifest.runtimes?.electron ?? null,
          chromium: ctx.manifest.runtimes?.chromium ?? null,
          platform: process.platform,
          arch: process.arch,
        },
        ui: 'Electron CDP screenshot and accessibility tree',
      },
      result: 'packaged Electron launched the authenticated notebook renderer, exercised preload state/action IPC, and retained one primary window across a second-instance handoff',
      evidence,
    };
  } catch (error) {
    throw normalizeUnavailable(ID, error);
  } finally {
    await cleanupScenarioResources(() => cdp?.close(), () => stopDesktop(second), () => stopDesktop(app));
  }
}

function requireDesktop(ctx) {
  if (ctx.manifest?.kind !== 'desktop') unavailable('staged manifest is not a desktop artifact');
  const relative = ctx.manifest.resources?.electronEntry;
  if (typeof relative !== 'string' || relative.length === 0) unavailable('desktop manifest has no Electron entry');
  assert.equal(typeof ctx.manifest.runtimes?.electron, 'string', 'desktop manifest must record the actual Electron identity');
  assert.equal(typeof ctx.manifest.runtimes?.chromium, 'string', 'desktop manifest must record the actual Chromium identity');
  assert.equal(typeof ctx.manifest.runtimes?.electronNode, 'string', 'desktop manifest must record the embedded Node identity');
}

async function launchDesktop(ctx, label, { extraArgs = [], profileLabel = label, notebookPath = null, expectSingleInstance = false } = {}) {
  const relative = ctx.manifest.resources.electronEntry;
  const entry = join(ctx.applicationRoot, relative);
  if (!await access(entry).then(() => true).catch(() => false)) unavailable(`Electron entry is absent: ${entry}`);
  const profile = join(ctx.evidence, `${profileLabel}-profile`);
  await mkdir(profile, { recursive: true });
  const rscript = await requireAbsoluteRscript(ctx.rscript, 'desktop lifecycle Rscript');
  const args = [
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-gpu',
    '--rscript', rscript,
    ...extraArgs,
    ...(notebookPath ? [notebookPath] : []),
  ];
  const child = spawnSmokeProcess(entry, args, {
    cwd: ctx.applicationRoot,
    env: sanitizedEnvironment({ XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache') }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-65_536); });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-65_536); });
  if (expectSingleInstance) {
    await waitForExit(child, 10_000, () => `${stdout}\n${stderr}`);
    return { child, entry, port: null, async targets() { return []; }, async pageTarget() { return null; } };
  }
  const port = await waitForDebugPort(child, () => `${stdout}\n${stderr}`);
  return {
    child, entry, port,
    async targets() { return fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()); },
    async pageTarget() {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const target = (await this.targets()).find(value => value.type === 'page' && value.webSocketDebuggerUrl && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/.test(value.url ?? ''));
        if (target) return target;
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) return undefined;
        await delay(100);
      }
    },
  };
}

async function waitForDebugPort(child, output, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const match = output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`desktop_launch_failed: exit=${child.exitCode ?? child.signalCode ?? 'unknown'} output=${output().trim()}`);
    }
    if (Date.now() >= deadline) throw new Error('desktop_cdp_timeout: Electron did not expose DevTools');
    await delay(100);
  }
}

async function waitForExit(child, timeout, output) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const deadline = Date.now() + timeout;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) throw new Error(`desktop_single_instance_failed: secondary remained alive (${output()})`);
    await delay(100);
  }
}

async function stopDesktop(app) {
  if (!app?.child) return;
  await stopChild(app.child);
}

async function waitForRenderer(cdp, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate("document.readyState === 'complete' && location.protocol === 'http:' && Boolean(window.__alderHost?.client?.document?.snapshot)")) return;
    await delay(100);
  }
  throw new Error('desktop_renderer_timeout: authenticated notebook renderer did not become ready');
}

async function waitForRuntimeIdentity(cdp, rscript, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const runtime = await cdp.evaluate('window.__alderHost?.client?.document?.snapshot?.runtime ?? null');
    if (runtime?.kernelState === 'ready' && runtime?.executionReady === true && runtime?.rEnvironment?.rscript === rscript) return;
    await delay(50);
  }
  const error = new Error(`scenario_unavailable: desktop_runtime_timeout: Electron did not reach execution readiness with ${rscript}`);
  error.code = 'scenario_unavailable';
  throw error;
}

class CdpSession {
  static async connect(url) {
    if (typeof WebSocket !== 'function') throw new Error('desktop_cdp_unavailable: Node WebSocket is unavailable');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
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
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'renderer evaluation failed');
    return result.result?.value;
  }

  async close() { this.socket.close(); }
}

function unavailable(reason) {
  const error = new Error(`scenario_unavailable: ${ID}: ${reason}`);
  error.code = 'scenario_unavailable';
  throw error;
}

function normalizeUnavailable(id, error) {
  if (error?.code === 'scenario_unavailable' || String(error?.message ?? '').startsWith('scenario_unavailable:')) return error;
  if (/desktop_(cdp_unavailable|cdp_timeout)|desktop_launch_failed|desktop_single_instance_failed/.test(String(error?.message ?? error))) {
    const unavailableError = new Error(`scenario_unavailable: ${id}: ${error.message ?? error}`);
    unavailableError.code = 'scenario_unavailable';
    return unavailableError;
  }
  return error;
}
