import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Native app acceptance requires macOS.');
const app = resolve(process.argv[2] ?? 'host/.application-desktop/Alder.app');
const executable = join(app, 'Contents/MacOS/Alder');
const temporary = await mkdtemp('/tmp/alder-native-accept-');
const notebook = join(temporary, 'native-accept.R');
const resultPath = join(temporary, 'result.json');
await writeFile(notebook, '# %%\na <- 1\na\n');

const environment = { ...process.env,
  HOME: temporary,
  XDG_CONFIG_HOME: join(temporary, 'config'),
  XDG_DATA_HOME: join(temporary, 'data'),
  XDG_CACHE_HOME: join(temporary, 'cache'),
  XDG_STATE_HOME: join(temporary, 'state'),
  ALDER_ACCEPTANCE_HIDDEN: '1',
  ALDER_ACCEPTANCE_NOTEBOOK: notebook,
  ALDER_ACCEPTANCE_RESULT: resultPath,
};
for (const key of Object.keys(environment)) {
  if (key.startsWith('ALDER_') && !['ALDER_ACCEPTANCE_HIDDEN', 'ALDER_ACCEPTANCE_NOTEBOOK', 'ALDER_ACCEPTANCE_RESULT'].includes(key)) delete environment[key];
}

const stderr = [];
const child = spawn(executable, [`--user-data-dir=${join(temporary, 'electron')}`], {
  cwd: temporary, env: environment, stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
const exit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
const started = performance.now();
try {
  const deadline = Date.now() + 60_000;
  let snapshot;
  while (Date.now() < deadline) {
    try {
      snapshot = JSON.parse(await readFile(resultPath, 'utf8'));
      break;
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (!snapshot) throw new Error(`packaged app did not complete its hidden journey: ${Buffer.concat(stderr).toString('utf8')}`);
  if (snapshot.error) throw new Error(`packaged app hidden journey failed: ${snapshot.error}`);
  const saved = await readFile(notebook, 'utf8');
  if (!saved.includes('a <- 40') || !saved.includes('a + 2')) throw new Error('native Save did not persist the edited CodeMirror source');
  const stopped = await Promise.race([exit, new Promise(resolveStop => setTimeout(() => resolveStop(null), 15_000))]);
  if (stopped === null) throw new Error('packaged app did not exit after hidden acceptance');
  if (stopped.code !== 0) throw new Error(`packaged app exited with ${JSON.stringify(stopped)}: ${Buffer.concat(stderr).toString('utf8')}`);
  process.stdout.write(JSON.stringify({ app, elapsedMs: Math.round(performance.now() - started), snapshot, cleanExit: stopped }) + '\n');
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 5_000))]);
  await rm(temporary, { recursive: true, force: true });
}
