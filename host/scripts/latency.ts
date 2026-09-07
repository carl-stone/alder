import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome } from '../test-support/chrome.js';
import { observerSource } from '../test-support/latency-observer.js';
import { validateProfileEvidence } from '../test-support/profile-evidence.js';

const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !process.env.ALDER_R_PACKAGE) throw new Error('Usage: ALDER_R_PACKAGE=INSTALLED_PACKAGE npm run latency -- EVIDENCE_DIRECTORY [REPETITIONS]');
const repetitions = Number(process.argv[3] ?? 30);
const instrumented = process.argv.includes('--profile');
const freshSessions = process.argv.includes('--fresh');
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be positive');
await mkdir(directory, { recursive: true });
if ((await readdir(directory)).length) throw new Error('Evidence directory must be empty');
const packagePath = process.env.ALDER_R_PACKAGE;
const entry = join(packagePath, 'host', 'alder-host.mjs');
const arkPath = process.env.ALDER_ARK ?? join(packagePath, 'host', 'runtime', process.platform === 'win32' ? 'ark.exe' : 'ark');
const results: any[] = [];
const record = async (value: unknown) => writeFile(join(directory, 'results.json'), `${JSON.stringify(value, null, 2)}\n`);
const identity = { startedAt: new Date().toISOString(),
  experiment: process.argv.find(arg => arg.startsWith('--experiment='))?.slice('--experiment='.length)
    ?? basename(directory).replaceAll('-', ' '),
  machine: process.env.ALDER_BENCHMARK_MACHINE ?? "",
  node: process.version, platform: platform(), release: release(), cpus: cpus(), totalmem: totalmem(),
  hostSha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
  arkSha256: createHash('sha256').update(await readFile(arkPath)).digest('hex'),
  installedFiles: Object.fromEntries(await Promise.all(['DESCRIPTION', 'R/alder.rdb', 'R/alder.rdx',
    ...(await readdir(join(packagePath, 'worker'))).filter(file => file.endsWith('.R')).map(file => `worker/${file}`),
    'app/static/host-app.js', 'app/static/vendor/alder-editor.js'].map(async file => [file,
      createHash('sha256').update(await readFile(join(packagePath, file))).digest('hex')]))),
  observerSha256: createHash('sha256').update(await readFile(new URL('../test-support/latency-observer.ts', import.meta.url))).digest('hex'),
  browserDriverSha256: createHash('sha256').update(await readFile(new URL('../test-support/chrome.ts', import.meta.url))).digest('hex'),
  browserExecutable: process.env.CHROME_BIN ?? 'google-chrome',
  repetitions, instrumented, freshSessions, warmups: freshSessions ? 0 : 2, endpoint: 'trusted click event.timeStamp through exact final-cell result and two animation frames (paint opportunity proxy)' };
let failed = false;
const fixtures = ['single', 'chain', 'long', 'create'];
const sessions = fixtures.flatMap(fixture => freshSessions
  ? (fixture === 'create' ? ['create'] : ['run', 'edit-and-run']).flatMap(scenario =>
    Array.from({ length: repetitions }, (_, session) => ({ fixture, scenario, session })))
  : [{ fixture, scenario: 'warm', session: 0 }]);
for (const { fixture, scenario: firstScenario, session } of sessions) {
  const name = freshSessions ? `${fixture}-${firstScenario}-${session}` : fixture;
  const row: any = { fixture, session, firstScenario, samples: [], failures: [] };
  results.push(row);
  let child: ChildProcessWithoutNullStreams | undefined, chrome: Chrome | undefined;
  let browserProfiling = false;
  try {
    const count = fixture === 'single' ? 1 : 3;
    const notebook = join(directory, `${name}.R`);
    let source = fixture === 'create' ? '' : '# %%\na <- 1\na\n';
    if (fixture === 'chain' || fixture === 'long') source += '# %%\nb <- a + 1\nb\n# %%\nc <- b + 1\nc\n';
    if (fixture === 'long') for (let i = 0; i < 100; i++) source += `# %%\nu${i} <- ${i}\nu${i}\n`;
    await writeFile(notebook, source);
    const config = join(directory, `${name}-config.json`);
    await writeFile(config, JSON.stringify({ path: notebook, port: 0, runOnStartup: false, packagePath }));
    const start = performance.now();
    const traceDirectory = join(directory, `${name}-profiles`);
    if (instrumented) await mkdir(traceDirectory);
    const profileArgs = instrumented ? ['--cpu-prof', `--cpu-prof-dir=${traceDirectory}`] : [];
    const environment = { ...process.env };
    delete environment.ALDER_PERF_TRACE_DIR;
    delete environment.ALDER_PERF_RPROF;
    if (instrumented) Object.assign(environment, { ALDER_PERF_TRACE_DIR: traceDirectory, ALDER_PERF_RPROF: '1' });
    child = spawn(process.execPath, [...profileArgs, entry, '--config', config], { stdio: ['pipe', 'pipe', 'pipe'], env: environment });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-1_048_576); });
    const ready = await new Promise<any>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`CLI readiness timed out: ${stderr}`)), 45_000);
      child!.once('error', error => { clearTimeout(timer); reject(error); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${stderr}`)); });
      child!.stdout.on('data', data => {
        output += String(data);
        for (;;) {
          const end = output.indexOf('\n'); if (end < 0) break;
          const line = output.slice(0, end); output = output.slice(end + 1);
          try { const value = JSON.parse(line); if (value.type === 'host.ready') { clearTimeout(timer); resolve(value); } }
          catch { /* startup log is retained in the process stream */ }
        }
      });
    });
    if (ready.engine?.kernel?.name !== 'ark') throw new Error('Latency qualification requires the Ark backend');
    row.engine = ready.engine;
    row.cliReadinessMs = performance.now() - start;
    row.epoch = ready.epoch;
    const browserStart = performance.now();
    chrome = await Chrome.open(ready.address.origin);
    if (instrumented) {
      await chrome.send('Profiler.enable');
      await chrome.send('Profiler.start');
      browserProfiling = true;
    }
    await chrome.wait('window.__alderHost?.client.document?.snapshot.runtime.executionReady');
    row.browserReadinessMs = performance.now() - browserStart;
    await chrome.evaluate(observerSource());
    if (fixture === 'create') {
      for (let iteration = -3; iteration < (freshSessions ? -2 : repetitions); iteration++) {
        await chrome.evaluate('window.__observeCreate()');
        await chrome.click('[data-act=add][data-type=code]');
        const sample = await chrome.evaluate('window.__observation');
        sample.phase = iteration === -3 ? 'first' : iteration < 0 ? 'warmup' : 'measured';
        sample.scenario = 'create'; row.samples.push(sample);
        await record({ identity, fixtures: results });
        await chrome.wait('window.__alderHost.client.document.cells.every(cell => cell.id !== null)');
      }
    } else {
      for (let iteration = -3; iteration < (freshSessions ? -2 : repetitions); iteration++) {
        for (const edit of [false, true]) {
          if (freshSessions ? edit !== (firstScenario === 'edit-and-run') : iteration === -3 && edit) continue;
          const value = edit ? iteration + 10 : (row.lastValue ?? 1);
          if (edit) {
            await chrome.click('[data-cell="cell-1"] .cm-content');
            await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
            await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
            await chrome.send('Input.insertText', { text: `a <- ${value}\na` });
            row.lastValue = value;
          }
          await chrome.evaluate(`window.__observeRun(${JSON.stringify({ count, value })})`);
          await chrome.click('[data-cell="cell-1"] [data-act=run]');
          const sample = await chrome.evaluate('window.__observation');
          sample.phase = iteration === -3 ? 'first' : iteration < 0 ? 'warmup' : 'measured';
          sample.scenario = edit ? 'edit-and-run' : 'run'; row.samples.push(sample);
          await record({ identity, fixtures: results });
        }
      }
    }
    if (chrome.errors.length) throw new Error(`Browser errors: ${JSON.stringify(chrome.errors)}`);
    const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(directory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    row.browser = await chrome.send('Browser.getVersion');
    row.stderr = stderr;
  } catch (error) {
    failed = true; row.failures.push(String(error));
    row.browserErrors = chrome?.errors;
    row.browserStderr = chrome?.stderr;
  } finally {
    if (browserProfiling && chrome) {
      try {
        const { profile } = await chrome.send('Profiler.stop');
        await writeFile(join(directory, `${name}-profiles`, 'browser.cpuprofile'), JSON.stringify(profile));
      } catch (error) { failed = true; row.failures.push(`browser profiling: ${error}`); }
    }
    await chrome?.close().catch(error => { failed = true; row.failures.push(`browser teardown: ${error}`); });
    if (child) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { failed = true; row.failures.push('forced CLI cleanup'); child!.kill('SIGKILL'); }, 10_000);
        child!.once('close', () => { clearTimeout(timer); resolve(); });
      });
      row.exitCode = child.exitCode; row.signalCode = child.signalCode;
      if (child.exitCode !== 0) failed = true;
    }
    if (instrumented) {
      try {
        const traces = join(directory, `${name}-profiles`);
        const files = await readdir(traces);
        const records = (await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(async file =>
          (await readFile(join(traces, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))))).flat();
        validateProfileEvidence(files, records, row.samples);
        row.profiles = Object.fromEntries(await Promise.all(files.map(async file => [file,
          createHash('sha256').update(await readFile(join(traces, file))).digest('hex')])));
      } catch (error) { failed = true; row.failures.push(`profile evidence: ${String(error)}`); }
    }
    await record({ identity, fixtures: results });
  }
}
let budgetMet = repetitions >= 30 && !instrumented;
const distributions = [];
for (const fixture of fixtures) for (const scenario of (fixture === 'create' ? ['create'] : ['run', 'edit-and-run'])) {
  const samples = results.filter(row => row.fixture === fixture).flatMap(row => row.samples)
    .filter((sample: any) => sample.scenario === scenario && sample.phase === (freshSessions ? 'first' : 'measured'))
    .map((sample: any) => sample.durationMs).sort((a: number,b: number) => a-b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length === 0 ? null : samples.length % 2 ? samples[middle] : (samples[middle-1] + samples[middle]) / 2;
  const p95 = samples[Math.ceil(samples.length * 0.95)-1] ?? null;
  const passed = samples.length >= 30 && median <= 50 && p95 <= 100;
  budgetMet &&= passed;
  distributions.push({ fixture, scenario, n: samples.length, median, p95, passed });
}
await record({ identity, fixtures: results, correctnessPassed: !failed, budgetMet,
  firstInteractionQualified: freshSessions && budgetMet && !failed,
  warmInteractionQualified: !freshSessions && budgetMet && !failed, distributions });
await updateProgress();
process.stdout.write(`${JSON.stringify({ correctnessPassed: !failed, budgetMet, distributions }, null, 2)}\n`);
process.exitCode = failed ? 1 : budgetMet ? 0 : 3;

async function updateProgress(): Promise<void> {
  const report = fileURLToPath(new URL('../../dev/reviews/latency-progress.html', import.meta.url));
  const html = await readFile(report, 'utf8');
  const block = /(<script id="observations" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const match = html.match(block);
  if (!match) throw new Error('latency progress report is missing its observations block');
  const observations = JSON.parse(match[2]!) as Array<{ id: string }>;
  const href = relative(resolve(report, '..'), join(directory, 'results.json')).split('\\').join('/');
  const entry = {
    id: href, href, time: identity.startedAt, description: identity.experiment,
    mode: `${instrumented ? 'profile-' : ''}${freshSessions ? 'fresh' : 'warm'}`,
    complete: true, correctnessPassed: !failed,
    machine: identity.machine || JSON.stringify([identity.platform, identity.cpus.map(cpu => cpu.model), identity.totalmem]),
    browserDriver: identity.browserDriverSha256, node: identity.node, ark: identity.arkSha256,
    metrics: distributions.map(value => ({ key: `${value.fixture}/${value.scenario}`,
      n: value.n, median: value.median, p95: value.p95 })),
    notes: failed ? results.flatMap(row => row.failures).join('; ') : '',
  };
  const index = observations.findIndex(value => value.id === href);
  if (index < 0) observations.push(entry); else observations[index] = entry;
  const data = JSON.stringify(observations).replaceAll('<', '\\u003c');
  await writeFile(report, html.replace(block, () => `${match[1]}${data}${match[3]}`));
}
