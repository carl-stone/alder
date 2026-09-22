import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { cleanupOwnedProcesses, ownedProcessRows, waitForOwnedExit } from './native-process-cleanup.mjs';

if (process.platform !== 'darwin') throw new Error('Native app acceptance requires macOS.');
const app = resolve(process.argv[2] ?? 'host/.application-desktop/Alder.app');
const executable = join(app, 'Contents/MacOS/Alder');
const cleanupProbe = process.argv.includes('--cleanup-probe');
const reopenAfterLastWindow = process.argv.includes('--reopen-after-last-window');
const multiWindow = process.argv.includes('--multi-window') || reopenAfterLastWindow;
const backendCrash = process.argv.includes('--backend-crash');
const rendererCrash = process.argv.includes('--renderer-crash');
const draftHandoff = process.argv.includes('--draft-handoff');
const appCrash = process.argv.includes('--app-crash');
const externalPathChurn = process.argv.includes('--external-path-churn');
const saveAsBoundary = process.argv.includes('--save-as-boundary');
const saveIterations = Number(process.env.ALDER_NATIVE_SAVE_ITERATIONS ?? 20);
const temporary = await mkdtemp('/tmp/alder-native-accept-');
const workspace = join(temporary, 'workspace');
const notebook = join(workspace, 'native-accept.R');
const children = new Set();
const ownedPids = new Set();
const ownedArkGroups = new Set();
const sessions = new Set();
const started = performance.now();
let launchSequence = 0;
await mkdir(workspace);
const initialNotebook = backendCrash || rendererCrash || draftHandoff || appCrash || externalPathChurn
  ? `# ---\n# runtime:\n#   on_cell_change: lazy\n${appCrash ? '#   on_startup: true\n' : ''}# ---\n# %%\naccepted_value <- 0L\naccepted_value\n# %%\nlocal_value <- 0L\nlocal_value\n`
  : '# ---\n# runtime:\n#   on_cell_change: lazy\n# ---\n# %%\nvalue <- 0L\nvalue\n';
await writeFile(notebook, initialNotebook);
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

async function launch(name, allowRetainedRecovery = false, path = notebook) {
  const launchName = `${name}-${++launchSequence}`;
  const stderr = [];
  const child = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, name)}`, path,
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
    await cdp.wait(`document.querySelector('.cm-content') && (
      document.getElementById('r-state')?.textContent === 'R ready' && !document.querySelector('[data-act=run]')?.disabled
      ${allowRetainedRecovery ? "|| window.__alderHost?.client?.recoveryState?.retainedDrafts?.length > 0" : ''})`, 45_000);
    return { child, cdp, endpoint, stderr, ownedPids: new Set([child.pid]) };
  } catch (error) {
    throw new Error(`packaged app ${launchName} did not become usable`, { cause: error });
  }
}

async function replaceEditor(cdp, source, index = 0) {
  const point = await cdp.evaluate(`(() => { const node=document.querySelectorAll('.cm-content')[${index}]; node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.x+Math.min(40,r.width/2),y:r.y+Math.min(15,r.height/2)} })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await shortcut(cdp, 'a', 'KeyA', 65, 4);
  await cdp.send('Input.insertText', { text: source });
  await cdp.wait(`[...document.querySelectorAll('.cm-content')[${index}].querySelectorAll('.cm-line')].map(node => node.textContent).join('\\n') === ${JSON.stringify(source)}`, 10_000);
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

async function waitFileSource(path, source, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (savedSource(await readFile(path, 'utf8')) === source) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`native Save did not persist ${JSON.stringify(source)} to ${path}`);
}

function backendForWorkspace(excludedPid) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  const matches = rows.map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(match => match && Number(match[1]) !== excludedPid && match[3].includes(temporary) && match[3].includes('alder-backend.mjs'));
  if (matches.length !== 1) throw new Error(`expected one packaged backend, found ${matches.length}`);
  return Number(matches[0][1]);
}

function captureBackendArk(backendPid) {
  const arkPath = join(app, 'Contents/Resources/alder/runtime/ark');
  const descendants = ownedProcessRows(new Set([backendPid]), '');
  const kernels = descendants.filter(row => row.command.startsWith(arkPath + ' '));
  if (kernels.length !== 1) throw new Error(`expected one Ark owned by backend ${backendPid}, found ${kernels.length}`);
  const guardian = descendants.find(row => row.pid === kernels[0].ppid && row.command.includes('/host/ark-guardian.mjs'));
  if (!guardian) throw new Error(`Ark ${kernels[0].pid} has no backend-owned guardian`);
  const pid = kernels[0].pid;
  const pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  if (pgid !== pid) throw new Error(`Ark ${pid} is not its own process-group leader (group ${pgid})`);
  ownedPids.add(guardian.pid);
  ownedPids.add(pid);
  ownedArkGroups.add(pgid);
  return { pid, pgid };
}

function packagedRenderer(primary) {
  const descendants = ownedProcessRows(new Set([primary.child.pid]), '');
  const renderers = descendants.filter(row => row.command.includes('--type=renderer') && row.command.includes('Alder Helper'));
  if (renderers.length !== 1) throw new Error(`expected one packaged renderer, found ${renderers.length}: ${JSON.stringify(renderers)}`);
  return renderers[0].pid;
}

async function waitArkGroupGone(pgid, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(-pgid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`packaged Ark process group ${pgid} survived`);
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
  static async connect(endpoint, targetId) {
    const cdp = await Cdp.connectBrowser(endpoint);
    let target;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const targets = await cdp.send('Target.getTargets', {}, '');
      target = targets.targetInfos.find(candidate => candidate.type === 'page' && (!targetId || candidate.targetId === targetId));
      if (target) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    if (!target) throw new Error('packaged app did not publish a renderer target');
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, '');
    cdp.session = attached.sessionId;
    cdp.targetId = target.targetId;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return cdp;
  }
  static async connectBrowser(endpoint) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
    const cdp = new Cdp(socket);
    await cdp.send('Target.setDiscoverTargets', { discover: true }, '');
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
      snapshotSource: window.__alderHost?.client?.document?.snapshot?.cells?.[0]?.body,
      snapshotDirty: window.__alderHost?.client?.document?.snapshot?.dirty,
      saveState: document.getElementById('save-state')?.textContent,
      runtime: window.__alderHost?.client?.document?.snapshot?.runtime && {
        kernelState: window.__alderHost.client.document.snapshot.runtime.kernelState,
        executionReady: window.__alderHost.client.document.snapshot.runtime.executionReady,
        startupActivated: window.__alderHost.client.document.snapshot.runtime.startupActivated,
        rEnvironment: window.__alderHost.client.document.snapshot.runtime.rEnvironment,
      },
      actionError: window.__alderHost?.view?.actionError,
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

async function disableAutosave(cdp) {
  await cdp.evaluate("document.getElementById('settings-open').click()");
  await cdp.wait("document.getElementById('settings')?.open", 10_000);
  if (await cdp.evaluate("document.getElementById('settings-autosave')?.checked")) {
    await cdp.evaluate("document.getElementById('settings-autosave').click()");
    await cdp.evaluate("document.getElementById('settings-apply').click()");
    await cdp.wait("window.__alderHost.client.document.snapshot.config.autosave === false", 15_000);
  } else {
    await cdp.evaluate("document.getElementById('settings-cancel').click()");
  }
  await cdp.wait("!document.getElementById('settings')?.open", 10_000);
}

async function runExternalPathJourney() {
  const diskUnchanged = async expected => {
    if (expected === null) {
      try { await readFile(notebook); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      throw new Error('Save recreated the missing notebook path');
    }
    if (await readFile(notebook, 'utf8') !== expected) throw new Error('Save changed the independently edited notebook');
  };
  const exercise = async (label, value, mutate, expectedDisk) => {
    await disableAutosave(primary.cdp);
    const accepted = `accepted_value <- ${value}L\naccepted_value`;
    const local = `local_value <- ${value + 1}L\nlocal_value`;
    await replaceEditor(primary.cdp, accepted);
    await primary.cdp.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(accepted)} &&
      window.__alderHost.client.document.pendingSource().changes.length === 0`, 15_000);
    await replaceEditor(primary.cdp, local, 1);
    const before = await primary.cdp.evaluate("({server:window.__alderHost.client.document.snapshot.cells[1].body.join('\\n'),local:window.__alderHost.client.document.cells[1].desiredBody.join('\\n')})");
    if (before.server !== 'local_value <- 0L\nlocal_value' || before.local !== local) throw new Error(`${label} setup lost the renderer-local draft: ${JSON.stringify(before)}`);
    await mutate();
    await primary.cdp.wait("document.querySelector('#status')?.textContent.includes('external notebook state changed')", 20_000);
    const atConflict = await primary.cdp.evaluate("({server:window.__alderHost.client.document.snapshot.cells[1].body.join('\\n'),local:window.__alderHost.client.document.cells[1].desiredBody.join('\\n'),pending:window.__alderHost.client.document.pendingSource().changes.length})");
    if (atConflict.server !== 'local_value <- 0L\nlocal_value' || atConflict.local !== local || atConflict.pending === 0) throw new Error(`${label} external conflict did not retain a renderer-local draft: ${JSON.stringify(atConflict)}`);
    await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
    await primary.cdp.wait("document.getElementById('save-state')?.textContent === 'Save failed'", 20_000);
    await diskUnchanged(expectedDisk);
    const afterConflict = await primary.cdp.evaluate("({accepted:window.__alderHost.client.document.snapshot.cells[0].body.join('\\n'),local:window.__alderHost.client.document.cells[1].desiredBody.join('\\n'),error:window.__alderHost.view.actionError})");
    if (afterConflict.accepted !== accepted || afterConflict.local !== local || !afterConflict.error?.includes('Notebook changed on disk')) throw new Error(`${label} Save conflict lost source or feedback: ${JSON.stringify(afterConflict)}`);
    const recovered = join(workspace, `recovered-${label}.R`);
    await primary.cdp.evaluate(`window.__alderHost.client.saveAs(${JSON.stringify(recovered)})`);
    const expectedSource = `${accepted}\n# %%\n${local}`;
    await waitFileSource(recovered, expectedSource);
    const canonicalRecovered = await realpath(recovered);
    await primary.cdp.wait(`window.__alderHost.client.document.snapshot.path === ${JSON.stringify(canonicalRecovered)} && !window.__alderHost.client.document.snapshot.dirty`, 20_000);
    await diskUnchanged(expectedDisk);
    await stop(primary);
    primary = await launch(`electron-recovered-${label}`, false, recovered);
    await primary.cdp.wait(`window.__alderHost.client.document.snapshot.path === ${JSON.stringify(canonicalRecovered)} &&
      window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(accepted)} &&
      window.__alderHost.client.document.snapshot.cells[1].body.join('\\n') === ${JSON.stringify(local)}`, 30_000);
    await diskUnchanged(expectedDisk);
    await stop(primary);
    primary = undefined;
  };

  const atomic = '# %%\nexternal_atomic <- 901L\nexternal_atomic\n';
  await exercise('atomic', 41, async () => {
    const staged = join(workspace, 'external-atomic.R');
    await writeFile(staged, atomic);
    await rename(staged, notebook);
  }, atomic);

  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe',
  });
  const gitCommit = message => {
    git('add', 'native-accept.R');
    git('-c', 'user.name=Alder acceptance', '-c', 'user.email=alder@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  };
  await writeFile(notebook, initialNotebook);
  git('init', '-q');
  gitCommit('baseline');
  const gitReplacement = '# %%\nexternal_git <- 902L\nexternal_git\n';
  await writeFile(notebook, gitReplacement);
  gitCommit('external replacement');
  const replacementCommit = git('rev-parse', 'HEAD').toString().trim();
  git('reset', '--hard', 'HEAD~1');
  primary = await launch('electron-git', false, notebook);
  await exercise('git', 43, async () => git('reset', '--hard', replacementCommit), gitReplacement);

  await writeFile(notebook, initialNotebook);
  primary = await launch('electron-rename', false, notebook);
  const renamed = join(workspace, 'renamed-external.R');
  await exercise('rename', 45, async () => rename(notebook, renamed), null);
  if (await readFile(renamed, 'utf8') !== initialNotebook) throw new Error('external renamed file changed during recovery');

  await writeFile(notebook, initialNotebook);
  primary = await launch('electron-delete', false, notebook);
  await exercise('delete', 47, async () => unlink(notebook), null);
  process.stdout.write(JSON.stringify({ externalPathChurn: ['atomic-replace', 'git-reset', 'rename', 'delete'],
    saveConflicts: 4, acknowledgedAndLocalPreserved: true, saveAsCopiesRelaunched: 4,
    saveAsPresentation: 'renderer-command-without-native-panel' }) + '\n');
}

async function runSaveAsBoundaryJourney() {
  const destinationDirectory = join(workspace, 'destination-project');
  const projectSettings = join(destinationDirectory, '.alder', 'packages.yaml');
  const destination = join(destinationDirectory, 'saved-copy.R');
  await mkdir(dirname(projectSettings), { recursive: true });
  await writeFile(projectSettings, 'packages:\n  - stats\n');
  await replaceEditor(primary.cdp, 'value <- 17L\nvalue');
  await primary.cdp.wait("window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === 'value <- 17L\\nvalue'", 15_000);
  await primary.cdp.evaluate(`window.__alderHost.client.saveAs(${JSON.stringify(destination)})`);
  const canonicalDestination = await realpath(destination);
  await primary.cdp.wait(`window.__alderHost.client.document.snapshot.path === ${JSON.stringify(canonicalDestination)} && !window.__alderHost.client.document.snapshot.dirty`, 20_000);
  if (await readFile(destination, 'utf8') !== initialNotebook.replace('value <- 0L\nvalue', 'value <- 17L\nvalue')) throw new Error('Save As did not publish source and notebook metadata');
  if (await readFile(projectSettings, 'utf8') !== 'packages:\n  - stats\n') throw new Error('Save As changed destination project settings');
  await replaceEditor(primary.cdp, 'value <- 18L\nvalue');
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitFileSource(destination, 'value <- 18L\nvalue');
  if (await readFile(destination, 'utf8') !== initialNotebook.replace('value <- 0L\nvalue', 'value <- 18L\nvalue')) throw new Error('later Save changed notebook metadata');
  await stop(primary);
  primary = await launch('electron-save-as-reopened', false, destination);
  await primary.cdp.wait(`window.__alderHost.client.document.snapshot.path === ${JSON.stringify(canonicalDestination)} && window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === 'value <- 18L\\nvalue'`, 30_000);
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('Save As changed the original notebook');
  if (await readFile(projectSettings, 'utf8') !== 'packages:\n  - stats\n') throw new Error('Save As changed destination project settings after relaunch');
  process.stdout.write(JSON.stringify({ saveAsBoundary: true, destinationCommitted: true, originalPreserved: true, projectSettingsPreserved: true, laterSaveAndRelaunch: true, nativeChooser: 'not-exercised' }) + '\n');
}

async function runMultiWindowJourney(primary) {
  const notebookB = join(workspace, 'native-accept-b.R');
  await writeFile(notebookB, '# ---\n# runtime:\n#   on_cell_change: lazy\n# ---\n# %%\nb_window <- 2L\nb_window\n');
  const canonicalA = await realpath(notebook);
  const canonicalB = await realpath(notebookB);
  const profile = join(temporary, 'electron-primary');
  const secondaryError = [];
  const secondary = spawn(executable, ['--headless=new', `--user-data-dir=${profile}`, notebookB], {
    cwd: temporary, env: environment(), stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(secondary);
  ownedPids.add(secondary.pid);
  secondary.stderr.on('data', chunk => secondaryError.push(Buffer.from(chunk)));
  const secondExit = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('second packaged launch did not forward and exit')), 20_000);
    secondary.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
    secondary.once('error', error => { clearTimeout(timer); reject(error); });
  });
  if (secondExit.code !== 0 || secondExit.signal !== null) throw new Error(`second packaged launch failed: ${JSON.stringify(secondExit)} ${Buffer.concat(secondaryError)}`);
  children.delete(secondary);
  const deadline = Date.now() + 45_000;
  let secondTarget;
  while (Date.now() < deadline) {
    const targets = await primary.cdp.send('Target.getTargets', {}, '');
    secondTarget = targets.targetInfos.find(target => target.type === 'page' && target.targetId !== primary.cdp.targetId);
    if (secondTarget) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (!secondTarget) throw new Error('forwarded notebook did not create a second renderer window');
  const windowB = await Cdp.connect(primary.endpoint, secondTarget.targetId);
  sessions.add(windowB);
  try {
    await windowB.wait(`window.__alderHost?.client?.document?.snapshot?.path === ${JSON.stringify(canonicalB)} && document.getElementById('r-state')?.textContent === 'R ready'`, 45_000);
    await primary.cdp.wait(`window.__alderHost.client.document.snapshot.path === ${JSON.stringify(canonicalA)} && document.getElementById('r-state')?.textContent === 'R ready'`, 10_000);
    const pages = (await primary.cdp.send('Target.getTargets', {}, '')).targetInfos.filter(target => target.type === 'page');
    if (pages.length !== 2 || primary.child.exitCode !== null) throw new Error(`expected two renderer windows in one app: ${JSON.stringify(pages)}`);
    await disableAutosave(primary.cdp);
    await disableAutosave(windowB);

    const sourceA = 'a_window <- 11L\na_window';
    const sourceB = 'b_window <- 29L\nb_window';
    await replaceEditor(primary.cdp, sourceA);
    await primary.cdp.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(sourceA)} &&
      window.__alderHost.client.document.snapshot.dirty && document.getElementById('save-state')?.textContent === 'Edited'`, 15_000);
    await replaceEditor(windowB, sourceB);
    await windowB.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(sourceB)} &&
      window.__alderHost.client.document.snapshot.dirty && document.getElementById('save-state')?.textContent === 'Edited'`, 15_000);
    await primary.cdp.wait('window.__alderHost.client.document.snapshot.dirty', 10_000);
    if (savedSource(await readFile(notebook, 'utf8')) !== 'value <- 0L\nvalue'
      || savedSource(await readFile(notebookB, 'utf8')) !== 'b_window <- 2L\nb_window') throw new Error('one draft reached disk before Save');

    await click(primary.cdp, '[data-act=run]');
    await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('11') && document.getElementById('r-state')?.textContent === 'R ready'", 30_000);
    await click(windowB, '[data-act=run]');
    await windowB.wait("document.querySelector('[data-role=output]')?.textContent.includes('29') && document.getElementById('r-state')?.textContent === 'R ready'", 30_000);
    await primary.cdp.wait('window.__alderHost.client.document.snapshot.dirty', 10_000);
    await windowB.wait('window.__alderHost.client.document.snapshot.dirty', 10_000);
    await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('11') && !document.querySelector('[data-role=output]')?.textContent.includes('29')", 10_000);
    await windowB.wait("document.querySelector('[data-role=output]')?.textContent.includes('29') && !document.querySelector('[data-role=output]')?.textContent.includes('11')", 10_000);

    await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
    await waitFileSource(notebook, sourceA);
    await primary.cdp.wait('window.__alderHost.client.document.snapshot.dirty === false', 10_000);
    if (savedSource(await readFile(notebookB, 'utf8')) !== 'b_window <- 2L\nb_window') throw new Error('saving A changed B on disk');
    await windowB.wait('window.__alderHost.client.document.snapshot.dirty', 10_000);
    await shortcut(windowB, 's', 'KeyS', 83, 4);
    await waitFileSource(notebookB, sourceB);
    await windowB.wait('window.__alderHost.client.document.snapshot.dirty === false', 10_000);
    await windowB.evaluate('window.close()');
    const closeDeadline = Date.now() + 15_000;
    while (Date.now() < closeDeadline) {
      const targets = await primary.cdp.send('Target.getTargets', {}, '');
      if (!targets.targetInfos.some(target => target.targetId === secondTarget.targetId)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    const remaining = (await primary.cdp.send('Target.getTargets', {}, '')).targetInfos.filter(target => target.type === 'page');
    if (remaining.length !== 1 || remaining[0].targetId !== primary.cdp.targetId) throw new Error(`closing B did not retain only A: ${JSON.stringify(remaining)}`);
    await replaceEditor(primary.cdp, 'a_window <- 17L\na_window');
    await click(primary.cdp, '[data-act=run]');
    await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('17')", 30_000);
    await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
    await waitFileSource(notebook, 'a_window <- 17L\na_window');
    if (savedSource(await readFile(notebookB, 'utf8')) !== sourceB) throw new Error('closing B changed its saved notebook');
    if (reopenAfterLastWindow) {
      await primary.cdp.wait('window.__alderHost.client.document.snapshot.dirty === false', 10_000);
      const browser = await Cdp.connectBrowser(primary.endpoint);
      sessions.add(browser);
      try {
        await primary.cdp.evaluate('window.close()');
        const closedAt = Date.now() + 15_000;
        while (Date.now() < closedAt) {
          const targets = await browser.send('Target.getTargets', {}, '');
          if (!targets.targetInfos.some(target => target.type === 'page')) break;
          await new Promise(resolveWait => setTimeout(resolveWait, 50));
        }
        if ((await browser.send('Target.getTargets', {}, '')).targetInfos.some(target => target.type === 'page')
          || primary.child.exitCode !== null) throw new Error('closing the last window did not leave the Mac app running without pages');
        const reopenError = [];
        const reopenLaunch = spawn(executable, ['--headless=new', `--user-data-dir=${profile}`, notebookB], {
          cwd: temporary, env: environment(), stdio: ['ignore', 'ignore', 'pipe'],
        });
        children.add(reopenLaunch);
        ownedPids.add(reopenLaunch.pid);
        reopenLaunch.stderr.on('data', chunk => reopenError.push(Buffer.from(chunk)));
        const reopenedExit = await new Promise((resolveExit, reject) => {
          const timer = setTimeout(() => reject(new Error('launch after last window did not forward and exit')), 20_000);
          reopenLaunch.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
          reopenLaunch.once('error', error => { clearTimeout(timer); reject(error); });
        });
        if (reopenedExit.code !== 0 || reopenedExit.signal !== null) throw new Error(`launch after last window failed: ${JSON.stringify(reopenedExit)} ${Buffer.concat(reopenError)}`);
        children.delete(reopenLaunch);
        const reopenedAt = Date.now() + 45_000;
        let target;
        while (Date.now() < reopenedAt) {
          const targets = await browser.send('Target.getTargets', {}, '');
          target = targets.targetInfos.find(candidate => candidate.type === 'page');
          if (target) break;
          await new Promise(resolveWait => setTimeout(resolveWait, 50));
        }
        if (!target) throw new Error('forwarded notebook did not reopen after the last window closed');
        const reopened = await Cdp.connect(primary.endpoint, target.targetId);
        sessions.add(reopened);
        try {
          await reopened.wait(`window.__alderHost?.client?.document?.snapshot?.path === ${JSON.stringify(canonicalB)} &&
            window.__alderHost.client.document.snapshot.cells[0]?.body.join('\\n') === ${JSON.stringify(sourceB)} &&
            document.getElementById('r-state')?.textContent === 'R ready'`, 45_000);
          const pages = (await browser.send('Target.getTargets', {}, '')).targetInfos.filter(candidate => candidate.type === 'page');
          if (pages.length !== 1 || pages[0].targetId !== target.targetId) throw new Error(`forwarded reopen created unexpected windows: ${JSON.stringify(pages)}`);
          if (savedSource(await readFile(notebook, 'utf8')) !== 'a_window <- 17L\na_window'
            || savedSource(await readFile(notebookB, 'utf8')) !== sourceB) throw new Error('reopening after last close changed saved notebooks');
        } finally {
          reopened.close();
          sessions.delete(reopened);
        }
      } finally {
        browser.close();
        sessions.delete(browser);
      }
    }
    process.stdout.write(JSON.stringify({ multiWindow: true, forwardedExit: secondExit.code, rendererWindows: 2,
      notebooks: [notebook, notebookB], outputs: [11, 29, 17], closeRetainedPrimary: true,
      ...(reopenAfterLastWindow ? { reopenedAfterLastWindow: true } : {}) }) + '\n');
  } finally {
    windowB.close();
    sessions.delete(windowB);
  }
}

async function runBackendCrashJourney(primary) {
  await disableAutosave(primary.cdp);
  const accepted = 'accepted_value <- 43L\naccepted_value';
  const localDraft = 'local_value <- 44L\nlocal_value';
  await replaceEditor(primary.cdp, accepted);
  await primary.cdp.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(accepted)} &&
    window.__alderHost.client.document.snapshot.dirty && window.__alderHost.client.document.pendingSource().changes.length === 0`, 15_000);
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('accepted edit saved before explicit Save');
  const backendPid = backendForWorkspace();
  const oldArk = captureBackendArk(backendPid);
  await replaceEditor(primary.cdp, localDraft, 1);
  const beforeCrash = await primary.cdp.evaluate("({accepted:window.__alderHost.client.document.snapshot.cells[0].body.join('\\n'),serverDraft:window.__alderHost.client.document.snapshot.cells[1].body.join('\\n'),localDraft:window.__alderHost.client.document.cells[1].desiredBody.join('\\n')})");
  if (beforeCrash.accepted !== accepted || beforeCrash.serverDraft !== 'local_value <- 0L\nlocal_value'
    || beforeCrash.localDraft !== localDraft) throw new Error(`crash setup did not hold one accepted edit and one local draft: ${JSON.stringify(beforeCrash)}`);
  process.kill(backendPid, 'SIGKILL');
  await waitForOwnedExit(new Set([oldArk.pid]), '', 5_000);
  await waitArkGroupGone(oldArk.pgid);
  await primary.cdp.wait(`[...document.querySelectorAll('.cm-content')[1].querySelectorAll('.cm-line')].map(node => node.textContent).join('\\n') === ${JSON.stringify(localDraft)} &&
    window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(accepted)}`, 10_000);
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('backend crash changed notebook on disk');
  await primary.cdp.wait("window.__alderHost.view.transportState === 'closed' && document.querySelector('[data-status-action=retry-connection]')?.textContent === 'Restart host'", 15_000);
  await primary.cdp.evaluate("document.querySelector('[data-status-action=retry-connection]').click()");
  await primary.cdp.wait("[...document.querySelectorAll('[data-recovery-panel] button')].some(button => button.textContent === 'Continue recovered')", 60_000);
  await primary.cdp.evaluate("[...document.querySelectorAll('[data-recovery-panel] button')].find(button => button.textContent === 'Continue recovered').click()");
  await primary.cdp.wait("[...document.querySelectorAll('[data-recovery-panel] button')].some(button => button.textContent === 'Start R')", 10_000);
  await primary.cdp.evaluate("[...document.querySelectorAll('[data-recovery-panel] button')].find(button => button.textContent === 'Start R').click()");
  await primary.cdp.wait(`window.__alderHost?.client?.document?.snapshot?.cells[0]?.body.join('\\n') === ${JSON.stringify(accepted)} &&
    window.__alderHost.client.document.snapshot.cells[1]?.body.join('\\n') === ${JSON.stringify(localDraft)} &&
    window.__alderHost.view.transportState === 'open' && document.getElementById('r-state')?.textContent === 'R ready'`, 60_000);
  const recoveredArk = captureBackendArk(backendForWorkspace(backendPid));
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('host restart saved the draft without Save');
  await primary.cdp.evaluate("document.getElementById('save').click()");
  const expectedBody = `${accepted}\n# %%\n${localDraft}`;
  const deadline = Date.now() + 20_000;
  let saved = await readFile(notebook, 'utf8');
  while (savedSource(saved) !== expectedBody && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    saved = await readFile(notebook, 'utf8');
  }
  if (savedSource(saved) !== expectedBody) {
    const state = await primary.cdp.evaluate("({status:document.getElementById('status')?.textContent,saveState:document.getElementById('save-state')?.textContent,actionError:window.__alderHost.view.actionError,cells:window.__alderHost.client.document.snapshot.cells.map(cell=>cell.body),pending:window.__alderHost.client.document.pendingSource().changes})");
    throw new Error(`Save after host restart lost source: ${JSON.stringify({ saved, state })}`);
  }
  await primary.cdp.wait('window.__alderHost.client.document.snapshot.dirty === false', 10_000);
  const afterRecovery = 'local_value <- 45L\nlocal_value';
  await replaceEditor(primary.cdp, afterRecovery, 1);
  await primary.cdp.evaluate("document.querySelector('[data-cell=cell-2] [data-act=run]').click()");
  await primary.cdp.wait("document.querySelector('#notebook')?.textContent.includes('[1] 45') && document.getElementById('r-state')?.textContent === 'R ready'", 30_000);
  await primary.cdp.evaluate("document.getElementById('save').click()");
  const finalBody = `${accepted}\n# %%\n${afterRecovery}`;
  const finalDeadline = Date.now() + 20_000;
  while (savedSource(await readFile(notebook, 'utf8')) !== finalBody && Date.now() < finalDeadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  if (savedSource(await readFile(notebook, 'utf8')) !== finalBody) throw new Error('Run and Save after recovery did not persist the new source');
  process.stdout.write(JSON.stringify({ backendCrash: true, accepted, localDraft, recovered: true,
    oldArkPid: oldArk.pid, oldArkGroupGone: true, recoveredArkPid: recoveredArk.pid,
    outputAfterRecovery: 45, savedAfterRecovery: true }) + '\n');
}

async function runRendererCrashJourney(primary) {
  await disableAutosave(primary.cdp);
  const accepted = 'accepted_value <- 43L\naccepted_value';
  const localDraft = 'local_value <- 44L\nlocal_value';
  await replaceEditor(primary.cdp, accepted);
  await primary.cdp.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(accepted)} &&
    window.__alderHost.client.document.snapshot.dirty && window.__alderHost.client.document.pendingSource().changes.length === 0`, 15_000);
  const backendPid = backendForWorkspace();
  const ark = captureBackendArk(backendPid);
  const rendererPid = packagedRenderer(primary);
  await replaceEditor(primary.cdp, localDraft, 1);
  const before = await primary.cdp.evaluate(`(async () => {
    const client = window.__alderHost.client;
    const source = client.document.cells[1].desiredBody.join('\\n');
    const pending = client.document.pendingSource().changes.length;
    await client.flushDraftPersistence();
    return { source, pending, accepted: client.document.snapshot.cells[0].body.join('\\n'),
      serverDraft: client.document.snapshot.cells[1].body.join('\\n'),
      durableDraft: await client.transport.recoveryStore.readDraft(client.draftId) };
  })()`);
  if (before.accepted !== accepted || before.serverDraft !== 'local_value <- 0L\nlocal_value'
    || before.source !== localDraft || before.pending !== 1
    || before.durableDraft?.changes?.[0]?.body?.join('\n') !== localDraft) {
    throw new Error(`renderer crash setup did not durably hold both edits: ${JSON.stringify(before)}`);
  }
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('renderer crash setup saved before explicit Save');
  process.kill(rendererPid, 'SIGKILL');
  await waitForOwnedExit(new Set([rendererPid]), '', 5_000);
  const recovered = await Cdp.connect(primary.endpoint);
  sessions.add(recovered);
  primary.cdp.close();
  sessions.delete(primary.cdp);
  primary.cdp = recovered;
  await recovered.wait(`window.__alderHost?.client?.document?.snapshot?.cells[0]?.body.join('\\n') === ${JSON.stringify(accepted)} &&
    window.__alderHost.client.document.cells[1]?.desiredBody.join('\\n') === ${JSON.stringify(localDraft)} &&
    document.getElementById('r-state')?.textContent === 'R ready'`, 45_000);
  const restored = await recovered.evaluate("({serverDraft:window.__alderHost.client.document.snapshot.cells[1].body.join('\\n'),pending:window.__alderHost.client.document.pendingSource().changes.length})");
  if (restored.serverDraft !== 'local_value <- 0L\nlocal_value' || restored.pending !== 1) {
    throw new Error(`renderer recovery implicitly replayed the local draft: ${JSON.stringify(restored)}`);
  }
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('renderer recovery saved before explicit Save');
  if (backendForWorkspace() !== backendPid) throw new Error('renderer recovery replaced the live backend');
  const afterArk = captureBackendArk(backendPid);
  if (afterArk.pid !== ark.pid) throw new Error('renderer recovery replaced the live Ark');
  await recovered.evaluate("document.querySelector('[data-cell=cell-2] [data-act=run]').click()");
  await recovered.wait("document.querySelector('#notebook')?.textContent.includes('[1] 44') && document.getElementById('r-state')?.textContent === 'R ready'", 30_000);
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('running after renderer recovery saved without Save');
  await recovered.evaluate("document.getElementById('save').click()");
  const expectedBody = `${accepted}\n# %%\n${localDraft}`;
  const deadline = Date.now() + 20_000;
  while (savedSource(await readFile(notebook, 'utf8')) !== expectedBody && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  if (savedSource(await readFile(notebook, 'utf8')) !== expectedBody) throw new Error('Save after renderer recovery lost source');
  process.stdout.write(JSON.stringify({ rendererCrash: true, accepted, localDraft, recovered: true,
    backendPreserved: true, arkPreserved: true, outputAfterRecovery: 44, savedAfterRecovery: true }) + '\n');
}

async function runDraftHandoffJourney(wholeAppCrash = false) {
  await disableAutosave(primary.cdp);
  const accepted = 'accepted_value <- 43L\naccepted_value';
  const localDraft = wholeAppCrash ? 'local_value <- accepted_value + 14L\nlocal_value' : 'local_value <- 57L\nlocal_value';
  if (wholeAppCrash) {
    await replaceEditor(primary.cdp, accepted);
    await primary.cdp.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(accepted)} &&
      window.__alderHost.client.document.snapshot.dirty && window.__alderHost.client.document.pendingSource().changes.length === 0`, 15_000);
  }
  const oldBackendPid = wholeAppCrash ? backendForWorkspace() : null;
  const oldArk = wholeAppCrash ? captureBackendArk(oldBackendPid) : null;
  await replaceEditor(primary.cdp, localDraft, 1);
  const before = await primary.cdp.evaluate(`(async () => {
    const client = window.__alderHost.client;
    await client.flushDraftPersistence();
    return { draftId: client.draftId, accepted: client.document.snapshot.cells[0].body.join('\\n'),
      local: client.document.cells[1].desiredBody.join('\\n'),
      server: client.document.snapshot.cells[1].body.join('\\n'),
      activeClients: client.document.snapshot.activeClientIds?.length,
      durable: await client.transport.recoveryStore.readDraft(client.draftId) };
  })()`);
  if (before.accepted !== (wholeAppCrash ? accepted : 'accepted_value <- 0L\naccepted_value')
    || before.local !== localDraft || before.server !== 'local_value <- 0L\nlocal_value'
    || before.durable?.changes?.[0]?.body?.join('\n') !== localDraft) throw new Error(`draft handoff setup was not durable: ${JSON.stringify(before)}`);
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('draft handoff saved before explicit Save');
  ownedProcessRows(ownedPids, temporary);
  const oldPid = primary.child.pid;
  const oldOwned = wholeAppCrash ? new Set(ownedProcessRows(new Set([oldPid, oldBackendPid]), temporary).map(row => row.pid)) : null;
  process.kill(oldPid, 'SIGKILL');
  await new Promise((resolveExit, reject) => {
    if (primary.child.exitCode !== null || primary.child.signalCode !== null) return resolveExit();
    primary.child.once('exit', resolveExit);
    primary.child.once('error', reject);
  });
  primary.cdp.close(); sessions.delete(primary.cdp); children.delete(primary.child);
  primary = undefined;
  if (wholeAppCrash) {
    await waitForOwnedExit(oldOwned, temporary, 60_000);
    await waitArkGroupGone(oldArk.pgid);
  }
  const reopened = primary = await launch('electron-primary', wholeAppCrash);
  await reopened.cdp.wait(`window.__alderHost.client.recoveryState.retainedDrafts?.some(draft => draft.draftId === ${JSON.stringify(before.draftId)})`, 30_000);
  if (wholeAppCrash) {
    const recovered = await reopened.cdp.evaluate(`({accepted:window.__alderHost.client.document.snapshot.cells[0].body.join('\\n'),
      dirty:window.__alderHost.client.document.snapshot.dirty,
      freshRuns:window.__alderHost.client.document.snapshot.operations.filter(op => op.kind === 'run' && op.clientId === window.__alderHost.client.transport.id).length})`);
    if (recovered.accepted !== accepted || !recovered.dirty || recovered.freshRuns !== 0) throw new Error(`app relaunch did not offer accepted work without Run: ${JSON.stringify(recovered)}`);
  }
  await reopened.cdp.wait("[...document.querySelectorAll('[data-recovery-panel] button')].some(button => button.textContent?.startsWith('Restore draft'))", 10_000);
  await reopened.cdp.evaluate("[...document.querySelectorAll('[data-recovery-panel] button')].find(button => button.textContent?.startsWith('Restore draft')).click()");
  await reopened.cdp.wait(`window.__alderHost.client.draftId === ${JSON.stringify(before.draftId)} &&
    window.__alderHost.client.document.cells[1].desiredBody.join('\\n') === ${JSON.stringify(localDraft)}`, 15_000);
  const restored = await reopened.cdp.evaluate("({server:window.__alderHost.client.document.snapshot.cells[1].body.join('\\n'),pending:window.__alderHost.client.document.pendingSource().changes.length,freshRuns:window.__alderHost.client.document.snapshot.operations.filter(op => op.kind === 'run' && op.clientId === window.__alderHost.client.transport.id).length})");
  if (restored.server !== 'local_value <- 0L\nlocal_value' || restored.pending !== 1 || wholeAppCrash && restored.freshRuns !== 0) throw new Error(`reopened app replayed draft or ran without permission: ${JSON.stringify(restored)}`);
  if (await readFile(notebook, 'utf8') !== initialNotebook) throw new Error('reopened app saved before explicit Save');
  if (wholeAppCrash) {
    await reopened.cdp.wait("[...document.querySelectorAll('[data-recovery-panel] button')].some(button => button.textContent === 'Start R')", 10_000);
    await reopened.cdp.evaluate("[...document.querySelectorAll('[data-recovery-panel] button')].find(button => button.textContent === 'Start R').click()");
    await reopened.cdp.wait("document.getElementById('r-state')?.textContent === 'R ready'", 60_000);
    const implicitRuns = await reopened.cdp.evaluate("window.__alderHost.client.document.snapshot.operations.filter(op => op.kind === 'run' && op.clientId === window.__alderHost.client.transport.id).length");
    if (implicitRuns !== 0) throw new Error(`starting R implicitly ran recovered source: ${implicitRuns}`);
  }
  await reopened.cdp.evaluate("document.querySelector('[data-cell=cell-2] [data-act=run]').click()");
  await reopened.cdp.wait("document.querySelector('#notebook')?.textContent.includes('[1] 57') && document.getElementById('r-state')?.textContent === 'R ready'", 30_000);
  await reopened.cdp.evaluate("document.getElementById('save').click()");
  const expectedBody = `${wholeAppCrash ? accepted : 'accepted_value <- 0L\naccepted_value'}\n# %%\n${localDraft}`;
  const deadline = Date.now() + 20_000;
  while (savedSource(await readFile(notebook, 'utf8')) !== expectedBody && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 25));
  if (savedSource(await readFile(notebook, 'utf8')) !== expectedBody) throw new Error('reopened app Save lost selected draft');
  await reopened.cdp.evaluate("window.__alderHost.client.flushDraftPersistence()");
  if (await reopened.cdp.evaluate(`window.__alderHost.client.transport.recoveryStore.readDraft(${JSON.stringify(before.draftId)})`) !== null) throw new Error('Save retained the selected draft');
  await reopened.cdp.wait(`window.__alderHost.client.document.snapshot.activeClientIds?.length === ${before.activeClients}`, 45_000);
  process.stdout.write(JSON.stringify({ ...(wholeAppCrash ? { appCrash: true, oldBackendGone: true, oldArkGroupGone: true, acceptedRecovered: true }
    : { draftHandoff: true }), reopenedInNewProcess: true, selectedDraftRecovered: true, implicitReplay: false,
    implicitRun: false, outputAfterRecovery: 57, savedAfterRecovery: true }) + '\n');
}


let primary;
let peer;
let runError;
try {
  primary = await launch('electron-primary');
  if (cleanupProbe) throw new Error('intentional cleanup probe');
  if (multiWindow) await runMultiWindowJourney(primary);
  else if (externalPathChurn) await runExternalPathJourney();
  else if (saveAsBoundary) await runSaveAsBoundaryJourney();
  else if (backendCrash) await runBackendCrashJourney(primary);
  else if (rendererCrash) await runRendererCrashJourney(primary);
  else if (draftHandoff) await runDraftHandoffJourney();
  else if (appCrash) await runDraftHandoffJourney(true);
  else {

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

  await primary.cdp.evaluate("document.getElementById('settings-open').click()");
  await primary.cdp.wait("document.getElementById('settings')?.open", 10_000);
  if (await primary.cdp.evaluate("document.getElementById('settings-autosave')?.checked")) {
    await primary.cdp.evaluate("document.getElementById('settings-autosave').click()");
    await primary.cdp.evaluate("document.getElementById('settings-apply').click()");
    await primary.cdp.wait("window.__alderHost.client.document.snapshot.config.autosave === false", 15_000);
  } else {
    await primary.cdp.evaluate("document.getElementById('settings-cancel').click()");
  }

  const unsavedPeerSource = 'peer_pending <- 43L\npeer_pending';
  await replaceEditor(primary.cdp, unsavedPeerSource);
  await primary.cdp.wait(`window.__alderHost.client.document.cell('cell-1')?.desiredBody.join('\\n') === ${JSON.stringify(unsavedPeerSource)}`, 10_000);
  await click(primary.cdp, '[data-act=run]');
  await primary.cdp.wait("document.querySelector('[data-role=output]')?.textContent.includes('43')", 30_000);
  await primary.cdp.wait(`window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(unsavedPeerSource)}`, 20_000);
  if (savedSource(await readFile(notebook, 'utf8')) !== '6 * 7') throw new Error('unsaved source reached disk before Save');
  peer = await launch('electron-peer');
  await peer.cdp.wait(`[...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n') === ${JSON.stringify(unsavedPeerSource)}`, 20_000);
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitDiskSource(unsavedPeerSource);
  await peer.cdp.wait("window.__alderHost.client.document.snapshot.dirty === false", 10_000);
  await stop(peer); peer = undefined;
  if (primary.child.exitCode !== null) throw new Error('closing the second same-file client stopped the first app');
  await primary.cdp.wait(`document.getElementById('r-state')?.textContent === 'R ready' &&
    [...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\\n') === ${JSON.stringify(unsavedPeerSource)} &&
    window.__alderHost.client.document.snapshot.cells[0].body.join('\\n') === ${JSON.stringify(unsavedPeerSource)}`, 10_000);
  if (savedSource(await readFile(notebook, 'utf8')) !== unsavedPeerSource) throw new Error('peer close lost the saved primary source');
  await replaceEditor(primary.cdp, '6 * 7');
  await shortcut(primary.cdp, 's', 'KeyS', 83, 4);
  await waitDiskSource('6 * 7');

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
    journeys: ['open-reopen', 'editor-run', 'immediate-save', 'renderer-error', 'slow-run', 'ark-error', 'persistence-failure', 'interrupt-recovery', 'same-file-peer-draft-save-detach', 'ark-recovery', 'quit-relaunch', 'stopped-diagnostic-queries'],
    diagnostics: { retainedBytes: status.retainedBytes, launches: launches.records.length, errors: errors.records.length, operations: operations.operations.length, performance: performanceSummary.summaries.length },
  }) + '\n');
  }
} catch (error) {
  if (!(cleanupProbe && String(error?.message).includes('intentional cleanup probe'))) runError = error;
} finally {
  await chmod(workspace, 0o700).catch(() => undefined);
  const stopErrors = [];
  try { await stop(peer); } catch (error) { stopErrors.push(error); }
  if (!reopenAfterLastWindow) {
    try { await stop(primary); } catch (error) { stopErrors.push(error); }
  }
  for (const child of children) if (!reopenAfterLastWindow && child.exitCode === null && child.signalCode === null) {
    try { requestNativeQuit(child.pid); } catch (error) { stopErrors.push(error); }
  }
  let naturalExitError;
  try {
    if (!reopenAfterLastWindow) {
      await waitForOwnedExit(ownedPids, temporary);
      for (const pgid of ownedArkGroups) await waitArkGroupGone(pgid);
    }
  } catch (error) { naturalExitError = error; }
  // A macOS app stays resident without windows; this headless-only journey cannot invoke the foreground Quit menu.
  const cleanup = await cleanupOwnedProcesses(ownedPids, temporary);
  for (const cdp of sessions) cdp.close();
  await rm(temporary, { recursive: true, force: true });
  if (cleanupProbe) process.stdout.write(JSON.stringify({ cleanupProbe: true, naturalExit: naturalExitError === undefined, fallbackRequired: cleanup.fallbackRequired }) + '\n');
  else if (reopenAfterLastWindow) process.stdout.write(JSON.stringify({ headlessCleanup: 'forced-after-last-window', terminatedPids: cleanup.terminatedPids.length, killedPids: cleanup.killedPids.length }) + '\n');
  else if (cleanup.fallbackRequired) process.stderr.write(JSON.stringify({ nativeCleanup: true, naturalExit: naturalExitError === undefined, fallbackRequired: true }) + '\n');
  const failures = [runError, ...stopErrors, naturalExitError,
    cleanup.fallbackRequired && !reopenAfterLastWindow ? new Error('packaged app required forced process cleanup') : undefined].filter(Boolean);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'native acceptance and cleanup failed');
}
