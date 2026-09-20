import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { cleanupOwnedProcesses, ownedProcessRows, waitForOwnedExit } from './native-process-cleanup.mjs';

if (process.platform !== 'darwin') throw new Error('Native app acceptance requires macOS.');
const app = resolve(process.argv[2] ?? 'host/.application-desktop/Alder.app');
const executable = join(app, 'Contents/MacOS/Alder');
const cleanupProbe = process.argv.includes('--cleanup-probe');
const saveIterations = Number(process.env.ALDER_NATIVE_SAVE_ITERATIONS ?? 20);
const temporary = await mkdtemp('/tmp/alder-native-accept-');
const workspace = join(temporary, 'workspace');
const notebook = join(workspace, 'native-accept.R');
const children = new Set();
const ownedPids = new Set();
const sessions = new Set();
const started = performance.now();
let launchSequence = 0;
await mkdir(workspace);
await writeFile(notebook, '# ---\n# runtime:\n#   on_cell_change: lazy\n# ---\n# %%\nvalue <- 0L\nvalue\n');
function environment() {
  const result = { ...process.env,
    HOME: temporary,
    XDG_CONFIG_HOME: join(temporary, 'config'),
    XDG_DATA_HOME: join(temporary, 'data'),
    XDG_CACHE_HOME: join(temporary, 'cache'),
    XDG_STATE_HOME: join(temporary, 'state'),
  };
  for (const key of Object.keys(result)) if (key.startsWith('ALDER_')) delete result[key];
  return result;
}

async function launch(name) {
  const launchName = `${name}-${++launchSequence}`;
  const stderr = [];
  const child = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, name)}`, notebook,
  ], { cwd: temporary, env: environment(), stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  ownedPids.add(child.pid);
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`packaged app ${launchName} startup timed out: ${Buffer.concat(stderr)}`)), 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`packaged app ${launchName} exited ${code}: ${Buffer.concat(stderr)}`)); });
    child.stderr.on('data', () => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(Buffer.concat(stderr).toString('utf8'));
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  try {
    const cdp = await Cdp.connect(endpoint);
    sessions.add(cdp);
    await cdp.wait("document.querySelector('.cm-content') && document.getElementById('r-state')?.textContent === 'R ready' && !document.querySelector('[data-act=run]')?.disabled", 45_000);
    return { child, cdp, stderr, ownedPids: new Set([child.pid]) };
  } catch (error) {
    throw new Error(`packaged app ${launchName} did not become usable`, { cause: error });
  }
}

async function replaceEditor(cdp, source) {
  const point = await cdp.evaluate(`(() => { const node=document.querySelector('.cm-content'); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.x+Math.min(40,r.width/2),y:r.y+Math.min(15,r.height/2)} })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await shortcut(cdp, 'a', 'KeyA', 65, 4);
  await cdp.send('Input.insertText', { text: source });
  await cdp.wait(`[...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n') === ${JSON.stringify(source)}`, 10_000);
}

async function shortcut(cdp, key, code, windowsVirtualKeyCode, modifiers = 4) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}

async function click(cdp, selector) {
  const point = await cdp.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('missing click target'); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

function savedSource(disk) {
  const marker = disk.indexOf('# %%');
  if (marker < 0) return disk.replace(/\n$/, '');
  const body = disk.indexOf('\n', marker);
  return disk.slice(body < 0 ? disk.length : body + 1).replace(/\n$/, '');
}

async function waitDiskSource(source, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const disk = await readFile(notebook, 'utf8');
    if (savedSource(disk) === source) return disk;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`native Save did not persist ${JSON.stringify(source)}`);
}

async function stop(instance) {
  if (!instance) return;
  ownedProcessRows(ownedPids, temporary);
  ownedProcessRows(instance.ownedPids, '');
  requestNativeQuit(instance.child.pid);
  try { await waitForOwnedExit(instance.ownedPids, '', 10_000); }
  catch (error) { throw new Error(`packaged Electron ${instance.child.pid} process tree survived native quit`, { cause: error }); }
  instance.cdp.close();
  sessions.delete(instance.cdp);
  children.delete(instance.child);
}

function requestNativeQuit(pid) {
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', [
    'ObjC.import("AppKit")',
    `const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})`,
    'if (!application || !application.terminate) throw new Error("native quit request failed")',
  ].join('; ')], { stdio: 'pipe' });
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.counter = 0; this.pending = new Map(); this.session = ''; this.events = [];
    socket.on('message', data => {
      const message = JSON.parse(String(data));
      const pending = this.pending.get(message.id);
      if (!pending) { if (message.method) this.events.push(message.method); return; }
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP connection closed')); }
      this.pending.clear();
    });
  }
  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
    const cdp = new Cdp(socket);
    await cdp.send('Target.setDiscoverTargets', { discover: true }, '');
    let target;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const targets = await cdp.send('Target.getTargets', {}, '');
      target = targets.targetInfos.find(candidate => candidate.type === 'page');
      if (target) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    if (!target) throw new Error('packaged app did not publish a renderer target');
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, '');
    cdp.session = attached.sessionId;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return cdp;
  }
  send(method, params = {}, sessionId = this.session) {
    const id = ++this.counter;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 60_000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression) {
    const value = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  }
  async wait(expression, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await this.evaluate(`Boolean(${expression})`)) return; } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    const diagnostic = await this.evaluate(`(() => ({
      title: document.title,
      rState: document.getElementById('r-state')?.textContent,
      status: document.getElementById('status')?.textContent,
      runAllDisabled: document.getElementById('run-all')?.disabled,
      cellRuns: [...document.querySelectorAll('[data-act=run]')].map(node => ({ disabled: node.disabled, cell: node.closest('[data-cell]')?.getAttribute('data-cell') })),
      source: [...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n'),
      output: document.querySelector('[data-role=output]')?.textContent,
    }))()`).catch(() => null);
    throw new Error(`packaged app condition timed out: ${expression}; state=${JSON.stringify(diagnostic)}`);
  }
  async waitEvent(methods, after, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.events.slice(after).some(method => methods.includes(method))) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    throw new Error(`packaged app emitted no ${methods.join(' or ')}`);
  }
  close() { this.socket.terminate(); }
}


let primary;
let peer;
let runError;
try {
  primary = await launch('electron-primary');
  if (cleanupProbe) throw new Error('intentional cleanup probe');

  await primary.cdp.evaluate(`(() => { const cause = new Error('PACKAGED_RENDERER_CAUSE'); const error = new Error('PACKAGED_RENDERER_FAILURE', { cause }); error.stack = 'PACKAGED_RENDERER_STACK'; window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, filename: '/packaged/native-accept-renderer.js', lineno: 14, colno: 9 })) })()`);
  await new Promise(resolveWait => setTimeout(resolveWait, 250));

  for (let iteration = 1; iteration <= saveIterations; iteration += 1) {
    const source = `value <- ${iteration}L\nvalue`;
    await replaceEditor(primary.cdp, source);
    if (iteration === 10) await click(primary.cdp, '[data-act=run]');
    await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
    await waitDiskSource(source);
    await primary.cdp.wait("!document.title.includes('Edited')", 20_000);
  }

  await replaceEditor(primary.cdp, 'Sys.sleep(0.25)\nslow_value <- 42L\nslow_value');
  await primary.cdp.wait("!document.querySelector('[data-act=run]')?.disabled", 30_000);
  await click(primary.cdp, '[data-act=run]');
  await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('42')", 30_000);

  await replaceEditor(primary.cdp, `stop('PACKAGED_ARK_FAILURE')`);
  await primary.cdp.wait("!document.querySelector('[data-act=run]')?.disabled", 30_000);
  await click(primary.cdp, '[data-act=run]');
  await primary.cdp.wait("document.getElementById('status')?.textContent.includes('PACKAGED_ARK_FAILURE')", 30_000);

  await replaceEditor(primary.cdp, 'persistence_value <- 99L\npersistence_value');
  await chmod(workspace, 0o500);
  try {
    await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
    await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
  } finally {
    await chmod(workspace, 0o700);
  }
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitDiskSource('persistence_value <- 99L\npersistence_value');

  await replaceEditor(primary.cdp, 'a <- 40\na + 2');
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitDiskSource('a <- 40\na + 2');
  await primary.cdp.wait("!document.querySelector('[data-act=run]')?.disabled && document.getElementById('r-state')?.textContent === 'R ready'", 45_000);
  await click(primary.cdp, '[data-act=run]');
  await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('42') && document.getElementById('r-state')?.textContent === 'R ready'", 45_000);

  await replaceEditor(primary.cdp, 'Sys.sleep(30)');
  await primary.cdp.wait("!document.querySelector('[data-act=run]')?.disabled", 30_000);
  await click(primary.cdp, '[data-act=run]');
  await primary.cdp.wait("document.getElementById('r-state')?.textContent === 'R running'", 10_000);
  await click(primary.cdp, '#stop');
  await primary.cdp.wait("document.getElementById('r-state')?.textContent === 'R ready'", 20_000);
  await replaceEditor(primary.cdp, '6 * 7');
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitDiskSource('6 * 7');
  await primary.cdp.wait("!document.querySelector('[data-act=run]')?.disabled && document.getElementById('r-state')?.textContent === 'R ready'", 45_000);
  await click(primary.cdp, '[data-act=run]');
  await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('42')", 30_000);
  await primary.cdp.wait("!document.title.includes('Edited')", 15_000);

  peer = await launch('electron-peer');
  await peer.cdp.wait("[...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n') === '6 * 7'", 20_000);
  await stop(peer); peer = undefined;
  if (primary.child.exitCode !== null) throw new Error('closing the second same-file client stopped the first app');
  await primary.cdp.wait("document.getElementById('r-state')?.textContent === 'R ready'", 10_000);

  const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    }).filter(Boolean);
  const backend = processRows.find(row => row.command.includes(temporary) && row.command.includes('alder-backend.mjs'));
  const ark = backend && processRows.find(row => row.ppid === backend.pid && row.command.includes('/runtime/ark'));
  if (!ark) throw new Error('could not identify the packaged Ark kernel for recovery acceptance');
  process.kill(ark.pid, 'SIGKILL');
  await primary.cdp.wait("document.getElementById('r-state')?.textContent !== 'R ready' && !document.getElementById('restart')?.hidden", 20_000);
  await stop(primary); primary = undefined;
  primary = await launch('electron-primary');
  const recoveredSource = await primary.cdp.evaluate("[...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n')");
  if (recoveredSource !== '6 * 7') throw new Error(`Ark recovery replaced current source: ${JSON.stringify(recoveredSource)}`);
  await replaceEditor(primary.cdp, 'recovered <- 42L\nrecovered');
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitDiskSource('recovered <- 42L\nrecovered');
  await primary.cdp.wait("!document.title.includes('Edited')", 20_000);
  await stop(primary); primary = undefined;

  primary = await launch('electron-primary');
  await primary.cdp.wait("[...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n') === 'recovered <- 42L\\nrecovered'", 30_000);
  if (savedSource(await readFile(notebook, 'utf8')) !== 'recovered <- 42L\nrecovered') throw new Error('quit and relaunch did not preserve exact source');
  await stop(primary); primary = undefined;

  const diagnosticRoot = join(temporary, 'electron-primary', 'diagnostics');
  const cli = join(app, 'Contents/Resources/alder/bin/alder');
  const query = (name, args = []) => JSON.parse(execFileSync(cli, ['diagnostics', name, ...args], {
    cwd: temporary, env: { ...environment(), ALDER_DIAGNOSTICS_DIR: diagnosticRoot }, encoding: 'utf8',
  }));
  const status = query('status');
  const launches = query('launches', ['--limit', '100']);
  const errors = query('errors', ['--limit', '500']);
  const operations = query('operations', ['--slow-ms', '100', '--limit', '500']);
  const performanceSummary = query('performance', ['--limit', '100']);
  const errorText = JSON.stringify(errors);
  if (!status.available || status.retainedBytes <= 0 || status.droppedRecords !== 0) throw new Error(`packaged diagnostic status is unhealthy: ${JSON.stringify(status)}`);
  if (launches.records.length < 4) throw new Error(`packaged launches are incomplete: ${JSON.stringify(launches)}`);
  for (const expected of ['PACKAGED_RENDERER_FAILURE', 'PACKAGED_RENDERER_STACK', 'PACKAGED_ARK_FAILURE', 'persistence.failure', 'child.exit']) {
    if (!errorText.includes(expected)) throw new Error(`packaged diagnostic errors omit ${expected}: ${errorText}`);
  }
  if (!JSON.stringify(operations).includes('slow_value') || !operations.operations.length) throw new Error(`packaged slow operation is absent: ${JSON.stringify(operations)}`);
  if (!performanceSummary.summaries.length) throw new Error(`packaged performance summary is empty: ${JSON.stringify(performanceSummary)}`);
  process.stdout.write(JSON.stringify({ app, elapsedMs: Math.round(performance.now() - started), immediateSaveIterations: saveIterations,
    journeys: ['open-reopen', 'editor-run', 'immediate-save', 'renderer-error', 'slow-run', 'ark-error', 'persistence-failure', 'interrupt-recovery', 'same-file-peer-detach', 'ark-recovery', 'quit-relaunch', 'stopped-diagnostic-queries'],
    diagnostics: { retainedBytes: status.retainedBytes, launches: launches.records.length, errors: errors.records.length, operations: operations.operations.length, performance: performanceSummary.summaries.length },
  }) + '\n');
} catch (error) {
  if (!(cleanupProbe && String(error?.message).includes('intentional cleanup probe'))) runError = error;
} finally {
  await chmod(workspace, 0o700).catch(() => undefined);
  const stopErrors = [];
  try { await stop(peer); } catch (error) { stopErrors.push(error); }
  try { await stop(primary); } catch (error) { stopErrors.push(error); }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    try { requestNativeQuit(child.pid); } catch (error) { stopErrors.push(error); }
  }
  let naturalExitError;
  try { await waitForOwnedExit(ownedPids, temporary); } catch (error) { naturalExitError = error; }
  const cleanup = await cleanupOwnedProcesses(ownedPids, temporary);
  for (const cdp of sessions) cdp.close();
  await rm(temporary, { recursive: true, force: true });
  if (cleanupProbe) process.stdout.write(JSON.stringify({ cleanupProbe: true, naturalExit: naturalExitError === undefined, fallbackRequired: cleanup.fallbackRequired }) + '\n');
  else if (cleanup.fallbackRequired) process.stderr.write(JSON.stringify({ nativeCleanup: true, naturalExit: naturalExitError === undefined, fallbackRequired: true }) + '\n');
  const failures = [runError, ...stopErrors, naturalExitError].filter(Boolean);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'native acceptance and cleanup failed');
}
