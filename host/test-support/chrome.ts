import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const DEFAULT_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export async function resolveChromeExecutable(): Promise<string> {
  const configured = [process.env.CHROME_BIN, process.env.CHROME_PATH].filter((value): value is string => Boolean(value));
  const candidates = [...configured, ...DEFAULT_CHROME_CANDIDATES];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) {
      await access(candidate, constants.X_OK);
      return candidate;
    }
  }
  throw new Error('No Chrome/Chromium executable was provisioned for ' + process.platform + '/' + process.arch + '; set CHROME_BIN or CHROME_PATH');
}

export class Chrome {
  private counter = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly errors: unknown[] = [];
  readonly events: unknown[] = [];
  stderr = "";
  readonly cdpEndpoint: string;
  readonly pid: number;
  readonly executable: string;
  private constructor(private readonly child: ChildProcessWithoutNullStreams,
    private readonly directory: string, private readonly socket: WebSocket, readonly session: string,
    cdpEndpoint: string, executable: string) {
    this.cdpEndpoint = cdpEndpoint;
    this.pid = child.pid ?? -1;
    this.executable = executable;
    child.stderr.on('data', bytes => { this.stderr = (this.stderr + String(bytes)).slice(-65_536); });
    socket.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params);
      if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded') {
        this.events.push({ method: message.method, params: message.params });
      }
      if (message.method === 'Inspector.targetCrashed' || message.method === 'Target.targetCrashed') {
        this.errors.push({ method: message.method, params: message.params });
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(new Error('Chrome connection closed'));
      }
      this.pending.clear();
    });
  }

  static async open(url: string): Promise<Chrome> {
    const executable = await resolveChromeExecutable();
    const directory = await mkdtemp(join(tmpdir(), 'alder-chrome-'));
    const child = spawn(executable, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--disable-background-networking', '--disable-component-update',
      '--disable-extensions', '--disable-default-apps', '--disable-sync',
      '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + directory,
      'about:blank',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume();
    let socket: WebSocket | undefined;
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${text}`)), 15_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${text}`)); });
        child.stderr.on('data', bytes => {
          text = (text + String(bytes)).slice(-65_536);
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
          if (match) { clearTimeout(timer); resolve(match[1]!); }
        });
      });
      socket = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
      const cdpEndpoint = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/[^/]+$/, '');
      const browser = new Chrome(child, directory, socket, '', cdpEndpoint, executable);
      const browserVersion = await browser.send('Browser.getVersion', {}, '');
      const product = String(browserVersion?.product ?? '');
      if (!/Chrome|Chromium/u.test(product)) throw new Error('Provisioned browser is not Chromium: ' + product);
      const expectedToken = 'Macintosh';
      if (!String(browserVersion?.userAgent ?? '').includes(expectedToken)) throw new Error('Provisioned browser platform identity mismatch');

      const target = await browser.send('Target.createTarget', { url: 'about:blank' }, '');
      const attached = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, '');
      Object.defineProperty(browser, 'session', { value: attached.sessionId });
      await browser.send('Page.enable');
      await browser.send('Runtime.enable');
      await browser.send('Log.enable');
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await browser.send('Page.navigate', { url });
      return browser;
    } catch (error) {
      socket?.terminate();
      await stop(child);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId = this.session): Promise<any> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression: string): Promise<any> {
    const value = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  }

  async wait(expression: string, timeout = 15_000): Promise<any> {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const value = await this.evaluate(expression);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  }

  async click(selector: string): Promise<void> {
    const locate = `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('missing click target'); element.scrollIntoView({block:'center'}); const rect = element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`;
    const point = await this.evaluate(locate);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    // Hover can reveal controls or coincide with an application rerender. Use
    // the target's current geometry for the trusted press rather than stale
    // coordinates captured before that browser work completed.
    const current = await this.evaluate(locate);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...current });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...current, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...current, button: 'left', clickCount: 1 });
  }

  async activateVirtualEditor(cellId: string, timeout = 15_000): Promise<void> {
    const encodedId = JSON.stringify(cellId);
    await this.evaluate(`(() => {
      const matches = [...document.querySelectorAll('#notebook > .cell[data-cell]')]
        .filter(cell => cell.dataset.cell === ${encodedId});
      if (matches.length !== 1) throw new Error('expected one activation cell, found ' + matches.length);
      matches[0].scrollIntoView({block:'center'});
      window.__alderActivationTarget = matches[0];
      return true;
    })()`);
    const stateExpression = `(() => {
      const matches = [...document.querySelectorAll('#notebook > .cell[data-cell]')]
        .filter(cell => cell.dataset.cell === ${encodedId});
      const cell = matches[0];
      if (matches.length !== 1 || !cell || cell !== window.__alderActivationTarget || !cell.isConnected ||
          cell.parentElement?.id !== 'notebook') {
        return {kind:'invalid', reason:'requested cell was removed, replaced, or moved'};
      }
      const cellRect = cell.getBoundingClientRect();
      if (cellRect.bottom <= 0 || cellRect.top >= window.innerHeight) {
        return {kind:'invalid', reason:'requested cell is no longer anchored in the viewport'};
      }
      const editors = [...cell.querySelectorAll('.cm-content')];
      const placeholders = [...cell.querySelectorAll('[data-virtual-source]')];
      if (editors.length === 1 && placeholders.length === 0 && editors[0].closest('[data-cell]') === cell) {
        const rect = editors[0].getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          ? {kind:'mounted'}
          : {kind:'invalid', reason:'requested editor is not visible'};
      }
      if (placeholders.length === 1 && editors.length === 0 && placeholders[0].closest('[data-cell]') === cell) {
        const rect = placeholders[0].getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          ? {kind:'virtual', x:rect.x + rect.width / 2, y:rect.y + rect.height / 2}
          : {kind:'invalid', reason:'requested virtual source is not clickable'};
      }
      return {kind:'invalid', reason:'requested cell has neither one virtual source nor one mounted editor'};
    })()`;
    const readState = async (): Promise<{ kind: string; reason?: string; x?: number; y?: number }> => {
      const state = await this.evaluate(stateExpression);
      if (state.kind === 'invalid') throw new Error(`editor activation failed for ${cellId}: ${state.reason}`);
      return state;
    };
    const waitForMounted = async (): Promise<void> => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        const state = await readState();
        if (state.kind === 'mounted') return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`editor activation timed out for ${cellId}`);
    };

    let state = await readState();
    if (state.kind === 'mounted') return;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: state.x!, y: state.y! });
    state = await readState();
    if (state.kind === 'mounted') return;
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: state.x!, y: state.y!, button: 'left', clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: state.x!, y: state.y!, button: 'left', clickCount: 1,
    });
    await waitForMounted();
  }

  async close(): Promise<void> {
    await this.send('Browser.close', {}, '').catch(() => {});
    this.socket.terminate();
    await stop(this.child);
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
