import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { Chrome } from '../test-support/chrome.js';
import { observerSource } from '../test-support/latency-observer.js';
import { validateProfileEvidence } from '../test-support/profile-evidence.js';

type ProcessIdentity = { pid: number; startTimeTicks?: string };

async function readStagedManifest(applicationPath: string) {
  const candidates = [join(applicationPath, 'resources', 'manifest.json'), join(applicationPath, 'Resources', 'manifest.json')];
  let manifestPath: string | undefined;
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) { manifestPath = candidate; break; } } catch { /* try the other layout */ }
  }
  if (!manifestPath) throw new Error('Staged application manifest not found under resources/ or Resources/');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as any;
  if (manifest.schemaVersion !== 1 || !manifest.resources || !manifest.target || !['headless', 'desktop'].includes(manifest.kind)) throw new Error('Invalid staged application manifest');
  if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch) throw new Error('Staged application target does not match this host');
  if (!Array.isArray(manifest.qualifiedRPatchVersions) || manifest.qualifiedRPatchVersions.length === 0 || manifest.qualifiedRPatchVersions.some(version => !/^4\.6\.[01]$/.test(version))) throw new Error('Staged application must qualify a supported R 4.6.x patch version');
  if (manifest.kind === 'desktop' && typeof manifest.resources.electronEntry !== 'string') throw new Error('Desktop staged application has no Electron executable');
  if (manifest.kind === 'headless' && manifest.resources.electronEntry !== null) throw new Error('Headless staged application declares an Electron executable');
  return { applicationRoot: dirname(dirname(manifestPath)), manifestPath, manifest };
}

async function sha256(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function inventoryDigest(files: any[]) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => String(a.path).localeCompare(String(b.path)))) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return hash.digest('hex');
}
async function verifyStagedInventory(root: string, manifest: any) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Staged application manifest has no file inventory');
  for (const expected of manifest.files) {
    if (typeof expected?.path !== 'string' || isAbsolute(expected.path)) throw new Error('Invalid staged inventory path');
    const path = resolve(root, expected.path);
    if (!(path === root || path.startsWith(root + sep))) throw new Error(`Staged inventory escapes application root: ${expected.path}`);
    const info = await stat(path);
    if (!info.isFile() || info.size !== expected.bytes || await sha256(path) !== expected.sha256) throw new Error(`Staged resource integrity mismatch: ${expected.path}`);
  }
  return manifest.files.length;
}
async function isExecutable(path: string) {
  try { const info = await stat(path); return info.isFile() && (process.platform === 'win32' || (info.mode & 0o111) !== 0); } catch { return false; }
}
async function resolveExecutable(requested: string) {
  if (isAbsolute(requested)) return await isExecutable(requested) ? requested : null;
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) for (const suffix of suffixes) {
    if (!directory) continue;
    const candidate = join(directory, requested + suffix);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
async function processIdentity(pid: number | undefined): Promise<ProcessIdentity | null> {
  if (!pid || pid < 0) return null;
  const result: ProcessIdentity = { pid };
  if (process.platform === 'linux') {
    try {
      const value = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (fields[19]) result.startTimeTicks = fields[19];
    } catch { /* process may have exited during teardown */ }
  }
  return result;
}
async function powerIdentity() {
  const result: Record<string, string | null> = {};
  for (const path of ['/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', '/sys/class/power_supply/AC/online']) {
    try { result[path] = (await readFile(path, 'utf8')).trim(); } catch { result[path] = null; }
  }
  return result;
}
function envWithoutHarness(extra: Record<string, string> = {}) {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of Object.keys(env)) if (key.startsWith('ALDER_') || key === 'R_HOME' || key.startsWith('R_LIBS')) delete env[key];
  Object.assign(env, extra);
  return env;
}
function delay(milliseconds: number) { return new Promise<void>(resolveDelay => setTimeout(resolveDelay, milliseconds)); }
async function stopChild(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let forced = false;
  await new Promise<void>(resolveStop => {
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 2_000);
    child.once('close', () => { clearTimeout(timer); resolveStop(); });
    child.kill('SIGTERM');
  });
  if (forced) throw new Error('Electron teardown required SIGKILL');
}

interface CdpTarget { id: string; type: string; url?: string; webSocketDebuggerUrl?: string }
class ElectronRenderer {
  private counter = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly errors: unknown[] = [];
  readonly events: unknown[] = [];
  readonly pid: number;
  readonly cdpEndpoint: string;
  readonly browserVersion: any;
  readonly targetId: string;
  readonly debugPortMs: number;
  readonly windowMs: number;
  stderr: string;
  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly profileDirectory: string, private readonly socket: WebSocket, options: any) {
    Object.assign(this, options); this.stderr = options.stderr;
    socket.on('message', bytes => {
      const message = JSON.parse(String(bytes));
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params);
      if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded') this.events.push({ method: message.method, params: message.params });
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
    });
    socket.on('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Electron CDP connection closed')); } this.pending.clear(); });
  }
  static async open(entry: string, root: string, notebook: string, profileDirectory: string, rscript: string, environment: Record<string, string | undefined>) {
    await mkdir(profileDirectory, { recursive: true });
    const args = ['--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`, '--disable-gpu', '--rscript', rscript, notebook];
    const child = spawn(entry, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.setEncoding('utf8');
    let stderr = ''; child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-65_536); });
    const started = performance.now();
    try {
      const endpoint = await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
        const timer = setTimeout(() => rejectEndpoint(new Error(`Electron CDP startup timed out: ${stderr}`)), 120_000);
        const poll = () => {
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
          if (match) { clearTimeout(timer); resolveEndpoint(match[1]!); return; }
          if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); rejectEndpoint(new Error(`Electron exited before CDP startup: ${child.exitCode ?? child.signalCode}\n${stderr}`)); return; }
          setTimeout(poll, 25);
        }; poll();
      });
      const httpEndpoint = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/[^/]+$/, '');
      const debugPortMs = performance.now() - started;
      const browserVersion = await fetch(`${httpEndpoint}/json/version`).then(async response => { if (!response.ok) throw new Error(`Electron CDP version request failed: ${response.status}`); return await response.json(); });
      let target: CdpTarget | undefined;
      const deadline = Date.now() + 120_000;
      while (!target && Date.now() < deadline) {
        const targets = await fetch(`${httpEndpoint}/json/list`).then(async response => { if (!response.ok) throw new Error(`Electron CDP target request failed: ${response.status}`); return await response.json() as CdpTarget[]; });
        target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/.test(value.url ?? ''));
        if (!target) await delay(50);
      }
      if (!target?.webSocketDebuggerUrl) throw new Error(`Electron renderer target did not appear: ${stderr}`);
      const windowMs = performance.now() - started;
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolveSocket, rejectSocket) => { socket.once('open', resolveSocket); socket.once('error', rejectSocket); });
      const renderer = new ElectronRenderer(child, profileDirectory, socket, { pid: child.pid ?? -1, cdpEndpoint: httpEndpoint, browserVersion, targetId: target.id, debugPortMs, windowMs, stderr });
      await renderer.send('Page.enable'); await renderer.send('Runtime.enable'); await renderer.send('Log.enable');
      return renderer;
    } catch (error) { await stopChild(child); await rm(profileDirectory, { recursive: true, force: true }); throw error; }
  }
  send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.counter;
    return new Promise<any>((resolveSend, rejectSend) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectSend(new Error(`Electron CDP timed out: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string) { const value = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value?.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value?.result?.value; }
  async wait(expression: string, timeout = 120_000) { const deadline = performance.now() + timeout; while (performance.now() < deadline) { if (await this.evaluate(expression)) return true; await delay(50); } throw new Error(`Electron condition timed out: ${expression}`); }
  async click(selector: string) {
    const point = await this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('missing click target'); element.scrollIntoView({block:'center'}); const rect = element.getBoundingClientRect(); return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}; })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async close() { try { await this.send('Page.close'); } catch { /* window may already be gone */ } this.socket.terminate(); await stopChild(this.child); await rm(this.profileDirectory, { recursive: true, force: true }); }
}

const { values, positionals } = parseArgs({ options: { application: { type: 'string' }, rscript: { type: 'string' }, profile: { type: 'boolean' }, fresh: { type: 'boolean' }, frontend: { type: 'string' }, fixture: { type: 'string' }, experiment: { type: 'string' }, 'no-progress': { type: 'boolean' } }, allowPositionals: true });
const applicationValue = values.application ?? process.env.ALDER_APPLICATION;
const application = resolve(applicationValue ?? '');
const directory = resolve(positionals[0] ?? '');
const selectedRscript = values.rscript;
if (!applicationValue || !positionals[0] || !selectedRscript) throw new Error('Usage: npm run latency -- --application STAGED_APPLICATION EVIDENCE_DIRECTORY [REPETITIONS] --rscript ABSOLUTE_RSCRIPT --frontend browser|electron');
if (!isAbsolute(selectedRscript) || !await isExecutable(selectedRscript)) throw new Error('--rscript must identify an executable absolute path: ' + selectedRscript);
const frontend = values.frontend ?? 'browser';
if (frontend !== 'browser' && frontend !== 'electron') throw new Error('--frontend must be browser or electron');
const repetitions = Number(positionals[1] ?? 30);
const instrumented = values.profile === true;
const freshSessions = values.fresh === true;
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be positive');
await mkdir(directory, { recursive: true });
if ((await readdir(directory)).length) throw new Error('Evidence directory must be empty');
await mkdir(join(directory, 'unrelated'), { recursive: true });
const integrityStarted = performance.now();
const { applicationRoot, manifestPath, manifest } = await readStagedManifest(application);
if (frontend === 'electron' && manifest.resources.electronEntry === null) throw new Error('--frontend electron requires a desktop staged application');
const filesVerified = await verifyStagedInventory(applicationRoot, manifest);
const integrityVerificationMs = performance.now() - integrityStarted;
const launcher = join(applicationRoot, manifest.resources.cliLauncher);
const hostEntry = join(applicationRoot, manifest.resources.hostEntry);
const arkPath = join(applicationRoot, manifest.resources.arkExecutable);
const electronPath = manifest.resources.electronEntry === null ? null : join(applicationRoot, manifest.resources.electronEntry);
const manifestSha256 = await sha256(manifestPath);
const browserExecutableRequest = process.env.CHROME_BIN ?? 'google-chrome';
const browserExecutablePath = frontend === 'browser' ? await resolveExecutable(browserExecutableRequest) : null;
const resourceEntries: Array<[string, string]> = [['cliLauncher', launcher], ['hostEntry', hostEntry], ['arkExecutable', arkPath], ['airExecutable', join(applicationRoot, manifest.resources.airExecutable)], ['nodeExecutable', join(applicationRoot, manifest.resources.nodeExecutable)], ['processSupervisorExecutable', join(applicationRoot, manifest.resources.processSupervisorExecutable)]];
if (electronPath !== null) resourceEntries.push(['electronEntry', electronPath]);
const resources = Object.fromEntries(await Promise.all(resourceEntries.map(async ([name, path]) => [name, { path, sha256: await sha256(path) }])));
const appAsarCandidates = [join(applicationRoot, 'resources', 'app.asar'), join(applicationRoot, 'Resources', 'app.asar')];
let appAsar: { path: string; sha256: string } | null = null;
for (const candidate of appAsarCandidates) if (await stat(candidate).then(info => info.isFile()).catch(() => false)) { appAsar = { path: candidate, sha256: await sha256(candidate) }; break; }
const machineDetails = { hostname: hostname(), platform: platform(), arch: arch(), release: release(), cpus: cpus().map(cpu => cpu.model), totalmem: totalmem(), power: await powerIdentity() };
const machine = process.env.ALDER_BENCHMARK_MACHINE || JSON.stringify(machineDetails);
const artifactInventorySha256 = inventoryDigest(manifest.files);
const identity: any = {
  startedAt: new Date().toISOString(), experiment: values.experiment ?? basename(directory).replaceAll('-', ' '), machine, machineDetails, containerImage: process.env.ALDER_CONTAINER_IMAGE_DIGEST ?? null, frontend,
  application: applicationRoot, manifest: manifestPath, manifestSha256, artifactInventorySha256, sourceCommit: manifest.sourceCommit, target: manifest.target, runtimes: manifest.runtimes,
  rscript: selectedRscript, rscriptSha256: await sha256(selectedRscript), qualifiedRPatchVersions: manifest.qualifiedRPatchVersions, resources,
  resourceDirectories: { rendererDirectory: manifest.resources.rendererDirectory, workerDirectory: manifest.resources.workerDirectory, rLibraryDirectory: manifest.resources.rLibraryDirectory },
  integrity: { verificationMs: integrityVerificationMs, filesVerified, manifestSha256, artifactInventorySha256 }, hostSha256: await sha256(hostEntry), arkSha256: await sha256(arkPath),
  observerSha256: createHash('sha256').update(await readFile(new URL('../test-support/latency-observer.ts', import.meta.url))).digest('hex'), browserDriverSha256: createHash('sha256').update(await readFile(new URL('../test-support/chrome.ts', import.meta.url))).digest('hex'),
  browserExecutable: frontend === 'browser' ? { requested: browserExecutableRequest, path: browserExecutablePath, sha256: browserExecutablePath === null ? null : await sha256(browserExecutablePath) } : null,
  electron: frontend === 'electron' ? { path: electronPath, sha256: electronPath === null ? null : await sha256(electronPath), appAsar } : null,
  repetitions, instrumented, freshSessions, warmups: freshSessions ? 0 : 2, thresholds: { medianMs: 50, p95Ms: 100 }, endpoint: 'trusted event.timeStamp through acknowledged source, matching operation/run identities, visible result, and two animation frames',
};
if (frontend === 'browser' && browserExecutablePath === null) throw new Error(`Chrome executable not found: ${browserExecutableRequest}`);
const results: any[] = [];
const record = async (value: unknown) => writeFile(join(directory, 'results.json'), JSON.stringify(value, null, 2) + '\n');
let failed = false;
const availableFixtures = ['scalar', 'chain', '100-unrelated', 'create'];
if (values.fixture !== undefined && !availableFixtures.includes(values.fixture)) throw new Error('--fixture must be scalar, chain, 100-unrelated, or create');
const fixtures = values.fixture === undefined ? availableFixtures : [values.fixture];
const sessions = fixtures.flatMap(fixture => freshSessions ? (fixture === 'create' ? ['create'] : ['run', 'edit-and-run']).flatMap(scenario => Array.from({ length: repetitions }, (_, session) => ({ fixture, scenario, session }))) : [{ fixture, scenario: 'warm', session: 0 }]);
for (const { fixture, scenario: firstScenario, session } of sessions) {
  const name = freshSessions ? `${fixture}-${firstScenario}-${session}` : fixture;
  const source = fixtureSource(fixture);
  const row: any = { fixture, fixtureSha256: digestText(source), session, firstScenario, frontend, samples: [], failures: [], startup: { integrityVerificationMs, frontend, hostProcessMs: null, desktopWindowMs: null, documentReadyMs: null, executionReadyMs: null, browserReadyMs: null } };
  results.push(row);
  let child: ChildProcessWithoutNullStreams | undefined; let chrome: Chrome | undefined; let electron: ElectronRenderer | undefined; let readyOutput: Awaited<ReturnType<typeof waitForHostReady>> | undefined; let browserProfiling = false;
  try {
    const count = fixture === 'scalar' ? 1 : 3;
    const notebook = join(directory, `${name}.R`); await writeFile(notebook, source);
    const traceDirectory = join(directory, name + '-profiles'); if (instrumented) await mkdir(traceDirectory);
    const profilingEnvironment = instrumented ? {
      ALDER_PERF_TRACE_DIR: traceDirectory,
      ALDER_PERF_RPROF: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--cpu-prof', '--cpu-prof-dir=' + JSON.stringify(traceDirectory)].filter(Boolean).join(' '),
    } : {};
    if (frontend === 'browser') {
      const dataHome = join(directory, `${name}-runtime-data`); const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime'); await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
      const start = performance.now(); const environment = envWithoutHarness({ XDG_DATA_HOME: dataHome, ...profilingEnvironment });
      child = spawn(launcher, [notebook, '--headless', '--no-run', '--port', '0', '--rscript', selectedRscript], { stdio: ['pipe', 'pipe', 'pipe'], env: environment, cwd: join(directory, 'unrelated'), shell: process.platform === 'win32', detached: process.platform !== 'win32' });
      readyOutput = await waitForHostReady(child); const ready = readyOutput.ready; row.ready = ready; row.cliStderr = readyOutput.stderr; row.startup.hostProcessMs = performance.now() - start; row.hostProcess = await processIdentity(child.pid);
      const registry = await waitForRegistry(notebook, runtimeDirectory, 120_000);
      if (registry.address === undefined || typeof registry.address.origin !== 'string' || typeof registry.address.browserOrigin !== 'string') throw new Error('session registry is missing split-origin address');
      row.registry = { state: registry.state, pid: registry.pid, startIdentity: registry.startIdentity, epoch: registry.epoch, canonicalPath: registry.canonicalPath, address: registry.address };
      const ticket = await mintTicket(registry.address.origin, registry.address.browserOrigin, registry.token);
      const browserStart = performance.now(); chrome = await Chrome.open(`${registry.address.browserOrigin}/#ticket=${encodeURIComponent(ticket)}`); row.browserProcess = await processIdentity(chrome.pid); row.startup.browserProcessMs = performance.now() - browserStart;
      await chrome.wait('document.readyState === "complete"'); row.startup.documentReadyMs = performance.now() - start;
      await chrome.wait('window.__alderHost?.client?.document?.snapshot?.runtime?.documentReady === true', 120_000); row.startup.executionReadyMs = performance.now() - start;
      await chrome.wait('window.__alderHost?.client?.document?.snapshot?.runtime?.executionReady === true', 120_000); row.startup.browserReadyMs = performance.now() - start;
      await chrome.wait('window.__alderHost?.client?.document?.snapshot?.runtime?.busy === false && window.__alderHost?.client?.document?.snapshot?.runtime?.activeRunId === null', 120_000);
      row.epoch = await chrome.evaluate('window.__alderHost.client.document.snapshot.epoch'); row.runtime = await chrome.evaluate('window.__alderHost.client.document.snapshot.runtime');
      if (row.runtime?.kernelState !== 'ready' || row.runtime?.executionReady !== true) throw new Error(`Ark execution was not ready: ${JSON.stringify(row.runtime)}`);
      row.browser = await chrome.send('Browser.getVersion', {}, '');
    } else {
      if (electronPath === null) throw new Error('Electron executable is absent from staged desktop resources');
      const desktopEnvironment = envWithoutHarness(profilingEnvironment); const start = performance.now();
      electron = await ElectronRenderer.open(electronPath, applicationRoot, notebook, join(directory, `${name}-desktop-profile`), selectedRscript, desktopEnvironment); row.desktopProcess = await processIdentity(electron.pid); row.startup.desktopWindowMs = electron.windowMs; row.startup.desktopDebugPortMs = electron.debugPortMs; row.startup.browserProcessMs = electron.windowMs;
      await electron.wait('document.readyState === "complete"'); row.startup.documentReadyMs = performance.now() - start; await electron.wait('window.__alderHost?.client?.document?.snapshot?.runtime?.documentReady === true'); row.startup.executionReadyMs = performance.now() - start; await electron.wait('window.__alderHost?.client?.document?.snapshot?.runtime?.executionReady === true'); row.startup.browserReadyMs = performance.now() - start;
      await electron.wait('window.__alderHost?.client?.document?.snapshot?.runtime?.busy === false && window.__alderHost?.client?.document?.snapshot?.runtime?.activeRunId === null');
      row.epoch = await electron.evaluate('window.__alderHost.client.document.snapshot.epoch'); row.runtime = await electron.evaluate('window.__alderHost.client.document.snapshot.runtime'); if (row.runtime?.kernelState !== 'ready' || row.runtime?.executionReady !== true) throw new Error(`Ark execution was not ready: ${JSON.stringify(row.runtime)}`); row.browser = electron.browserVersion;
    }
    if (row.runtime?.rEnvironment?.rscript !== selectedRscript) throw new Error(`runtime selected ${row.runtime?.rEnvironment?.rscript ?? 'no Rscript'} instead of ${selectedRscript}`);
    const driver: any = frontend === 'browser' ? chrome : electron;
    await driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const initialTarget = fixture === 'create' ? '[data-act=add][data-type=code]' : '[data-cell="cell-1"] [data-act=run]';
    await driver.wait(`(() => { const element = document.querySelector(${JSON.stringify(initialTarget)}); if (!(element instanceof HTMLButtonElement) || element.disabled) return false; const rect = element.getBoundingClientRect(); const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return rect.width > 0 && rect.height > 0 && target !== null && element.contains(target); })()`);
    if (instrumented) { await driver.send('Profiler.enable'); await driver.send('Profiler.start'); browserProfiling = true; }
    await driver.evaluate(observerSource());
    if (fixture === 'create') {
      for (let iteration = -3; iteration < (freshSessions ? -2 : repetitions); iteration++) { await driver.evaluate('window.__observeCreate()'); await driver.click('[data-act=add][data-type=code]'); const sample = await driver.evaluate('window.__observation'); sample.phase = phaseFor(iteration); sample.scenario = 'create'; sample.session = session; row.samples.push(sample); await record({ identity, fixtures: results }); await driver.wait('window.__alderHost.client.document.cells.every(cell => cell.id !== null)'); }
    } else {
      for (let iteration = -3; iteration < (freshSessions ? -2 : repetitions); iteration++) for (const edit of [false, true]) {
        if (freshSessions ? edit !== (firstScenario === 'edit-and-run') : iteration === -3 && edit) continue;
        const value = edit ? iteration + 10 : (row.lastValue ?? 1); if (edit) await trustedEdit(driver, value); await driver.evaluate(`window.__observeRun(${JSON.stringify({ count, value })})`); await driver.click('[data-cell="cell-1"] [data-act=run]'); const sample = await driver.evaluate('window.__observation'); sample.phase = phaseFor(iteration); sample.scenario = edit ? 'edit-and-run' : 'run'; sample.session = session; row.samples.push(sample); if (edit) row.lastValue = value; await record({ identity, fixtures: results });
      }
    }
    if (driver.errors.length) throw new Error(`${frontend} renderer errors: ${JSON.stringify(driver.errors)}`);
    const screenshot = await driver.send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(directory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    row.stderr = frontend === 'browser' ? chrome?.stderr : electron?.stderr; row.cdp = frontend === 'browser' ? { endpoint: chrome?.cdpEndpoint, pid: chrome?.pid } : { endpoint: electron?.cdpEndpoint, targetId: electron?.targetId, pid: electron?.pid };
  } catch (error) {
    failed = true; row.failures.push(String(error)); row.browserErrors = frontend === 'browser' ? chrome?.errors : electron?.errors; row.browserEvents = frontend === 'browser' ? chrome?.events : electron?.events; row.browserStderr = frontend === 'browser' ? chrome?.stderr : electron?.stderr;
  } finally {
    if (browserProfiling) try { const profile = await (frontend === 'browser' ? chrome : electron)?.send('Profiler.stop'); await writeFile(join(directory, `${name}-profiles`, 'browser.cpuprofile'), JSON.stringify(profile?.profile ?? profile)); } catch (error) { failed = true; row.failures.push(`browser profiling: ${error}`); }
    if (frontend === 'browser') await chrome?.close().catch(error => { failed = true; row.failures.push(`browser teardown: ${error}`); }); else await electron?.close().catch(error => { failed = true; row.failures.push(`electron teardown: ${error}`); });
    if (row.registry?.pid) await stopRegistryProcess(row.registry.pid).catch(error => { failed = true; row.failures.push(`host teardown: ${error}`); });
    if (child) { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolveClose => { let forced = false; const timer = setTimeout(() => { forced = true; try { if (child!.pid) process.kill(-child!.pid, 'SIGKILL'); } catch { child!.kill('SIGKILL'); } }, 10_000); child!.once('exit', () => { clearTimeout(timer); if (forced) { row.cleanupForced = true; failed = true; row.failures.push('host teardown required SIGKILL'); } resolveClose(); }); try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); } }); row.exitCode = child.exitCode; row.signalCode = child.signalCode; if (child.exitCode !== 0 && child.signalCode === null) failed = true; }
    if (readyOutput) { await readyOutput.done; try { readyOutput.assertFinal(); } catch (error) { failed = true; row.failures.push(`host stdout: ${error}`); } }
    if (instrumented) try { const traces = join(directory, `${name}-profiles`); const files = await readdir(traces); const records = (await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(async file => (await readFile(join(traces, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))))).flat(); validateProfileEvidence(files, records, row.samples); row.profiles = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(traces, file))).digest('hex')]))); } catch (error) { failed = true; row.failures.push(`profile evidence: ${String(error)}`); }
    await record({ identity, fixtures: results });
  }
}
const distributions: any[] = [];
for (const fixture of fixtures) for (const scenario of fixture === 'create' ? ['create'] : ['run', 'edit-and-run']) {
  const samples = results.filter(row => row.fixture === fixture).flatMap(row => row.samples).filter(sample => sample.scenario === scenario && sample.phase === (freshSessions ? 'first' : 'measured')).map(sample => sample.durationMs).filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
  const median = samples.length === 0 ? null : samples.length % 2 ? samples[Math.floor(samples.length / 2)] : (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2; const p95 = samples.length === 0 ? null : samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]; const passed = samples.length >= 30 && median !== null && p95 !== null && median <= 50 && p95 <= 100;
  distributions.push({ frontend, mode: freshSessions ? 'fresh-first-after-ready' : 'warm', fixture, scenario, n: samples.length, median, p95, passed, target: identity.thresholds });
}
const budgetMet = failed === false && instrumented === false && distributions.every(distribution => distribution.passed);
const qualification = { eligible: instrumented === false, passed: budgetMet, mode: freshSessions ? 'fresh-first-after-ready' : 'warm', target: identity.thresholds, distributions };
await record({ identity, fixtures: results, correctnessPassed: failed === false, budgetMet, qualification, firstInteractionQualified: freshSessions && budgetMet && failed === false, warmInteractionQualified: !freshSessions && budgetMet && failed === false, distributions, cold: { integrityVerificationMs, startup: results.map(row => ({ fixture: row.fixture, scenario: row.firstScenario, session: row.session, startup: row.startup })) } });
if (values['no-progress'] !== true) await updateProgress();
process.stdout.write(`${JSON.stringify({ correctnessPassed: failed === false, budgetMet, distributions }, null, 2)}\n`); process.exitCode = failed ? 1 : budgetMet ? 0 : 3;

function fixtureSource(fixture: string) { if (fixture === 'create') return ''; let source = '# %%\na <- 1\na\n'; if (fixture === 'chain' || fixture === '100-unrelated') source += '# %%\nb <- a + 1\nb\n# %%\nc <- b + 1\nc\n'; if (fixture === '100-unrelated') for (let i = 0; i < 100; i++) source += `# %%\nu${i} <- ${i}\nu${i}\n`; return source; }
function digestText(value: string) { return createHash('sha256').update(value).digest('hex'); }
function phaseFor(iteration: number) { return iteration === -3 ? 'first' : iteration < 0 ? 'warmup' : 'measured'; }
async function trustedEdit(driver: any, value: number) { await driver.click('[data-cell="cell-1"] .cm-content'); const modifiers = process.platform === 'darwin' ? 4 : 2; await driver.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers }); await driver.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers }); const source = `a <- ${value}\na`; await driver.send('Input.insertText', { text: source }); await driver.wait(`window.__alderHost?.client?.document?.snapshot?.cells?.find(cell => cell.id === 'cell-1')?.body?.join('\\n') === ${JSON.stringify(source)}`, 120_000); }
async function waitForHostReady(child: ChildProcessWithoutNullStreams): Promise<{ ready: any; stderr: string; done: Promise<void>; assertFinal: () => void }> {
  const maxBytes = 64 * 1024;
  let pending = '';
  let rawBytes = 0;
  let stderr = '';
  let ready: any = null;
  let recordCount = 0;
  let protocolError: Error | null = null;
  const fail = (reason: string) => { if (protocolError === null) protocolError = new Error('host_stdout_protocol:' + reason); };
  const validateReady = (value: any) => {
    assert.deepEqual(Object.keys(value).sort(), ['capabilities', 'epoch', 'origin', 'type']);
    assert.equal(value.type, 'host.ready');
    const origin = new URL(value.origin);
    assert.equal(origin.protocol, 'http:');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || /^[0-9a-f]{32}\.localhost$/.test(origin.hostname));
    assert.notEqual(origin.port, '');
    assert.equal(typeof value.epoch, 'string');
    assert.ok(Array.isArray(value.capabilities));
  };
  const processLine = (line: string) => {
    recordCount += 1;
    if (line.length === 0) { fail('blank_record'); return; }
    let value: any;
    try { value = JSON.parse(line); } catch { fail('malformed_record'); return; }
    if (recordCount !== 1) { fail('multiple_records'); return; }
    try { validateReady(value); } catch { fail('noncanonical_record'); return; }
    ready = value;
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-1_048_576); });
  const done = new Promise<void>(resolveDone => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolveDone(); } };
    child.stdout.once('end', finish);
    child.stdout.once('close', finish);
  });
  const readyPromise = new Promise<any>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('CLI readiness timed out: ' + stderr)), 120_000);
    const finishError = (error: Error) => { clearTimeout(timer); rejectReady(error); };
    child.once('error', finishError);
    child.once('exit', code => { if (ready === null) finishError(new Error('CLI exited ' + code + ': ' + stderr)); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      const text = String(data);
      rawBytes += Buffer.byteLength(text, 'utf8');
      if (rawBytes > maxBytes) { fail('output_limit_exceeded'); return; }
      pending += text;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        processLine(line);
        if (ready !== null && protocolError === null) { clearTimeout(timer); resolveReady(ready); }
        if (protocolError !== null) { clearTimeout(timer); finishError(protocolError); return; }
      }
    });
  });
  ready = await readyPromise;
  return {
    ready,
    stderr,
    done,
    assertFinal: () => {
      if (pending.length > 0) fail('unterminated_record');
      if (protocolError !== null) throw protocolError;
      if (recordCount !== 1 || ready === null) throw new Error('host_stdout_protocol:expected_one_ready_record');
    },
  };
}
async function stopRegistryProcess(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch (error: any) { if (error?.code !== 'ESRCH') throw error; return; }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!await stat(`/proc/${pid}`).then(() => true).catch(() => false)) return;
    await delay(100);
  }
  try { process.kill(pid, 'SIGKILL'); } catch (error: any) { if (error?.code !== 'ESRCH') throw error; }
  throw new Error('host registry teardown required SIGKILL');
}

async function waitForRegistry(canonicalPath: string, runtimeDirectory: string, timeout: number) {
  const path = join(runtimeDirectory, createHash('sha256').update('path:' + canonicalPath).digest('hex') + '.json');
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    if (value?.state === 'ready' && value.canonicalPath === canonicalPath) return value;
    if (Date.now() >= deadline) throw new Error(`session registry timeout: ${path}`);
    await delay(100);
  }
}
async function mintTicket(connectionOrigin: string, browserOrigin: string, token: string) {
  const response = await fetch(`${connectionOrigin}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: browserOrigin }) });
  const value = await response.json().catch(() => null) as any;
  if (!response.ok || typeof value?.ticket !== 'string') throw new Error(`Browser session ticket exchange failed: ${response.status} ${JSON.stringify(value)}`);
  return value.ticket as string;
}

async function updateProgress() {
  const report = fileURLToPath(new URL('../../dev/reviews/latency-progress.html', import.meta.url));
  const html = await readFile(report, 'utf8');
  const block = /(<script id="observations" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const match = html.match(block);
  if (!match) throw new Error('latency progress report is missing its observations block');
  const observations = JSON.parse(match[2]!) as Array<{ id: string }>;
  const href = relative(resolve(report, '..'), join(directory, 'results.json')).split('\\').join('/');
  const entry = { id: href, href, time: identity.startedAt, description: identity.experiment,
    mode: `${instrumented ? 'profile-' : ''}${freshSessions ? 'fresh' : 'warm'}-${frontend}`,
    complete: true, correctnessPassed: failed === false, machine: identity.machine,
    browserDriver: identity.browserDriverSha256, node: process.version, ark: identity.arkSha256,
    metrics: distributions.map(value => ({ key: `${value.fixture}/${value.scenario}`, n: value.n, median: value.median, p95: value.p95 })),
    notes: failed ? results.flatMap(row => row.failures).join('; ') : '' };
  const index = observations.findIndex(value => value.id === href);
  if (index < 0) observations.push(entry); else observations[index] = entry;
  const data = JSON.stringify(observations).replaceAll('<', '\\u003c');
  await writeFile(report, html.replace(block, () => `${match[1]}${data}${match[3]}`));
}
