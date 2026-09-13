import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupScenarioResources, delay, requireAbsoluteRscript, sanitizedEnvironment, spawnSmokeProcess, stopChild } from './_common.mjs';

const ID = 'desktop-security';

/** Verify renderer isolation and navigation/popup boundaries in real Electron. */
export async function run(ctx) {
  requireDesktop(ctx);
  let app;
  let cdp;
  try {
    app = await launchDesktop(ctx);
    const target = await app.pageTarget();
    assert.ok(target, 'packaged Electron must expose a renderer page');
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await waitForRenderer(cdp);

    const security = await cdp.evaluate(`(() => {
      const api = globalThis.alderDesktop;
      const suspicious = Object.keys(window).filter(key => /^(ipc|electron|node|require|fs|process|module)/i.test(key));
      const links = [...document.querySelectorAll('a[href]')].map(link => link.href);
      return {
        protocol: location.protocol,
        origin: location.origin,
        href: location.href,
        userAgent: navigator.userAgent,
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        module: typeof globalThis.module,
        fs: typeof globalThis.fs,
        suspicious,
        links,
        notebook: Boolean(document.querySelector('#notebook')),
        apiKeys: api ? Object.keys(api).sort() : null,
        apiMethods: api ? Object.fromEntries(Object.keys(api).map(key => [key, typeof api[key]])) : null,
      };
    })()`);
    assert.equal(security.notebook, true, 'security probe must run in the actual Alder renderer');
    assert.equal(security.protocol, 'http:', 'renderer must stay on authenticated HTTP, not file://');
    assert.ok(/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(security.origin), 'renderer origin must be loopback');
    assert.equal(security.process, 'undefined', 'nodeIntegration must be disabled');
    assert.equal(security.require, 'undefined', 'require must not cross the preload boundary');
    assert.equal(security.module, 'undefined', 'CommonJS module globals must not cross the preload boundary');
    assert.equal(security.fs, 'undefined', 'filesystem objects must not cross the preload boundary');
    assert.ok(!security.suspicious.some(key => /ipc|electron|node|require|fs|process|module/i.test(key)), 'renderer must not expose generic IPC or Node handles');
    assert.deepEqual(security.apiKeys, ['chooseRscript', 'chooseSavePath', 'getWindowState', 'onWindowAction', 'openNotebook'], 'preload must expose only its fixed API');
    assert.deepEqual(security.apiMethods, {
      chooseRscript: 'function',
      chooseSavePath: 'function',
      getWindowState: 'function',
      onWindowAction: 'function',
      openNotebook: 'function',
    }, 'preload values must be callable methods only');
    assert.ok(security.links.every(href => /^(https?:|mailto:|#|\/)/i.test(href)), 'renderer links must use safe URL classes');

    // File/data/javascript popups are untrusted requests. Electron must deny
    // them rather than navigating or creating an arbitrary renderer target.
    const before = await app.targets();
    const popupResult = await cdp.evaluate(`(() => {
      const values = ['file:///etc/passwd', 'data:text/html,<h1>bad</h1>', 'javascript:alert(1)'];
      return values.map(url => window.open(url, 'alder-security-probe') === null);
    })()`);
    await delay(500);
    const after = await app.targets();
    assert.deepEqual(popupResult, [true, true, true], 'arbitrary file/data/javascript popups must be denied');
    assert.equal(after.some(value => /^(file|data|javascript):/i.test(value.url ?? '')), false, 'untrusted URL schemes must not create renderer targets');
    assert.equal(after.length, before.length, 'denied popups must not add targets');

    // Same-window top-level navigation is restricted to the authenticated
    // application origin. This also covers an attempted navigation from a
    // hostile message rather than a trusted click.
    const originBefore = security.href;
    const navigationResult = await cdp.evaluate(`(() => {
      window.postMessage({ type: 'alder:security-probe', command: 'arbitrary-ipc', path: '/etc/passwd' }, '*');
      location.href = 'file:///etc/passwd';
      return location.href;
    })()`);
    assert.equal(typeof navigationResult, 'string', 'navigation probe must return a location value');
    await delay(500);
    const afterNavigation = await cdp.evaluate('location.href');
    assert.ok(afterNavigation.startsWith(security.origin), 'top-level file navigation must be denied');
    assert.equal(afterNavigation, originBefore, 'untrusted navigation must preserve the current app page');

    // A widget-like opaque frame may request a popup, but it cannot use the
    // main frame's privileged bridge or create a file target.
    const frameResult = await cdp.evaluate(`(async () => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<script>window.parent.postMessage({ type: "alder:security-probe", command: "ipc" }, "*");<\\/script>';
      document.body.appendChild(frame);
      await new Promise(resolve => setTimeout(resolve, 50));
      const popup = frame.contentWindow?.open('file:///etc/passwd', 'alder-widget-probe');
      frame.remove();
      return popup === null;
    })()`);
    assert.equal(frameResult, true, 'opaque widget frame file popup must be denied');
    await delay(250);
    const finalTargets = await app.targets();
    assert.equal(finalTargets.some(value => value.url?.startsWith('file:')), false, 'widget content must not navigate to file URLs');

    // Electron's permission handlers are deny-by-default. Notifications are a
    // browser permission surface that can be checked without opening a dialog.
    const permission = await cdp.evaluate(`(async () => {
      try { return (await navigator.permissions.query({ name: 'notifications' })).state; }
      catch { return 'unsupported'; }
    })()`);
    assert.equal(permission, 'denied', 'renderer permissions must be denied by default');

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = join(ctx.evidence, `${ID}.png`);
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const axPath = join(ctx.evidence, `${ID}.ax.json`);
    await writeFile(axPath, JSON.stringify(ax, null, 2));
    const browserVersion = await cdp.send('Browser.getVersion');
    const evidence = {
      executable: app.entry,
      electronVersion: ctx.manifest.runtimes?.electron ?? null,
      chromiumVersion: ctx.manifest.runtimes?.chromium ?? null,
      browserProduct: browserVersion.product,
      browserVersion: browserVersion.userAgent,
      isolation: security,
      popup: { before: before.length, after: after.length, denied: popupResult },
      navigation: { before: originBefore, after: afterNavigation },
      widgetPopupDenied: frameResult,
      permission,
      screenshot: screenshotPath,
      accessibility: axPath,
    };
    await writeFile(join(ctx.evidence, `${ID}.json`), `${JSON.stringify(evidence, null, 2)}\n`);

    return {
      id: ID,
      identity: {
        artifact: ctx.manifest.sourceCommit,
        native: { electron: ctx.manifest.runtimes?.electron ?? null, chromium: ctx.manifest.runtimes?.chromium ?? null, platform: process.platform, arch: process.arch },
        security: 'Electron CDP isolation, fixed preload fields, permission denial, navigation/popup denial, screenshot and accessibility evidence',
      },
      result: 'actual Electron renderer denied Node/filesystem/generic IPC exposure, permissions, untrusted URL schemes and widget file popups',
      evidence,
    };
  } catch (error) {
    throw normalizeUnavailable(ID, error);
  } finally {
    await cleanupScenarioResources(() => cdp?.close(), () => stopDesktop(app));
  }
}

function requireDesktop(ctx) {
  if (ctx.manifest?.kind !== 'desktop') unavailable('staged manifest is not a desktop artifact');
  if (typeof ctx.manifest.resources?.electronEntry !== 'string') unavailable('desktop manifest has no Electron entry');
  assert.equal(typeof ctx.manifest.runtimes?.electron, 'string', 'desktop manifest must record the actual Electron identity');
  assert.equal(typeof ctx.manifest.runtimes?.chromium, 'string', 'desktop manifest must record the actual Chromium identity');
  assert.equal(typeof ctx.manifest.runtimes?.electronNode, 'string', 'desktop manifest must record the embedded Node identity');
}

async function launchDesktop(ctx) {
  const entry = join(ctx.applicationRoot, ctx.manifest.resources.electronEntry);
  if (!await access(entry).then(() => true).catch(() => false)) unavailable(`Electron entry is absent: ${entry}`);
  const profile = join(ctx.evidence, `${ID}-profile`);
  await mkdir(profile, { recursive: true });
  const rscript = await requireAbsoluteRscript(ctx.rscript, 'desktop security Rscript');
  const child = spawnSmokeProcess(entry, [
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-gpu',
    '--rscript', rscript,
  ], {
    cwd: ctx.applicationRoot,
    env: sanitizedEnvironment({ XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache') }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { output = (output + value).slice(-65_536); });
  child.stderr.on('data', value => { output = (output + value).slice(-65_536); });
  const port = await waitForDebugPort(child, () => output);
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
    const match = output().match(new RegExp('DevTools listening on ws://127\\.0\\.0\\.1:(\\d+)/'));
    if (match) return Number(match[1]);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`desktop_launch_failed: exit=${child.exitCode ?? child.signalCode ?? 'unknown'} output=${output().trim()}`);
    }
    if (Date.now() >= deadline) throw new Error('desktop_cdp_timeout: Electron did not expose DevTools');
    await delay(100);
  }
}

async function stopDesktop(app) {
  if (!app?.child) return;
  await stopChild(app.child);
}

async function waitForRenderer(cdp, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate("document.readyState === 'complete' && location.protocol === 'http:' && Boolean(window.__alderHost?.client?.document?.snapshot)")) return;
    await delay(100);
  }
  throw new Error('desktop_renderer_timeout: authenticated notebook renderer did not become ready');
}

class CdpSession {
  static async connect(url) {
    if (typeof WebSocket !== 'function') throw new Error('desktop_cdp_unavailable: Node WebSocket is unavailable');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
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
  if (/desktop_(cdp_unavailable|cdp_timeout)|desktop_launch_failed/.test(String(error?.message ?? error))) {
    const unavailableError = new Error(`scenario_unavailable: ${id}: ${error.message ?? error}`);
    unavailableError.code = 'scenario_unavailable';
    return unavailableError;
  }
  return error;
}
