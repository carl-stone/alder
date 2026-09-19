import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.platform !== 'darwin') throw new Error('Mac acceptance requires macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(process.argv[2] ?? join(root, 'host/.application-desktop/Alder.app'));
const resourcesRoot = join(app, 'Contents/Resources/alder');
const manifest = JSON.parse(await readFile(join(resourcesRoot, 'manifest.json'), 'utf8'));
const resources = Object.fromEntries(Object.entries(manifest.resources).map(([key, value]) => [key, value === null ? null : join(resourcesRoot, value)]));
const timings = {};

function run(name, executable, args, options = {}) {
  const started = performance.now();
  const output = execFileSync(executable, args, { encoding: 'utf8', timeout: 120_000, ...options });
  timings[name] = Math.round(performance.now() - started);
  return output;
}

run('signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'pipe' });
const plist = JSON.parse(run('plist', '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]));
for (const key of ['NSAppTransportSecurity', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription']) {
  if (key in plist) throw new Error(`unused Info.plist declaration remains: ${key}`);
}
const extensions = plist.CFBundleDocumentTypes?.flatMap(entry => entry.CFBundleTypeExtensions ?? []) ?? [];
if (extensions.some(value => String(value).toLowerCase() === 'rmd')) throw new Error('R Markdown is still declared as an Alder document type');
const entitlements = run('entitlements', '/usr/bin/codesign', ['-d', '--entitlements', '-', app], { stdio: ['ignore', 'pipe', 'pipe'] });
if (entitlements.includes('<key>')) throw new Error('the Alder app unexpectedly carries entitlements');

const arkVersion = run('ark', resources.arkExecutable, ['--version']).trim();
const airVersion = run('air', resources.airExecutable, ['--version']).trim();
const quartoVersion = run('quarto', resources.quartoExecutable, ['--version']).trim();
const packageMetadata = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8'));
const airLock = JSON.parse(await readFile(join(root, 'host/air-lock.json'), 'utf8'));
if (!arkVersion.includes(packageMetadata.config.ark.version)) throw new Error(`unexpected Ark version: ${arkVersion}`);
if (!airVersion.includes(airLock.version)) throw new Error(`unexpected Air version: ${airVersion}`);
if (quartoVersion !== packageMetadata.config.quarto.version) throw new Error(`unexpected Quarto version: ${quartoVersion}`);

const temporary = await mkdtemp(join(tmpdir(), 'alder-mac-accept-'));
const runtimeDirectory = join('/tmp', `alder-mac-accept-${process.pid}`);
try {
  const source = join(temporary, 'format.R');
  await writeFile(source, 'answer<-function(x){x+1}\n');
  run('air-format', resources.airExecutable, ['format', source]);
  if (!/answer <- function\(x\)/.test(await readFile(source, 'utf8'))) throw new Error('staged Air did not format R source');

  const qmd = join(temporary, 'accept.qmd');
  await writeFile(qmd, '---\ntitle: Alder acceptance\nformat:\n  html:\n    embed-resources: true\n---\n\nStaged Quarto is ready.\n');
  run('quarto-render', resources.quartoExecutable, ['render', 'accept.qmd', '--to', 'html', '--output', 'accept.html', '--no-execute'], { cwd: temporary });
  const html = await readFile(join(temporary, 'accept.html'), 'utf8');
  if (!html.includes('Staged Quarto is ready.')) throw new Error('staged Quarto did not render the acceptance document');

  await evaluatePackagedKernel(temporary, runtimeDirectory);
} finally {
  await rm(runtimeDirectory, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({ app, arkVersion, airVersion, quartoVersion, timings }) + '\n');

async function evaluatePackagedKernel(directory, runtimePath) {
  const started = performance.now();
  const notebook = join(directory, 'ark-accept.R');
  const configDirectory = join(directory, 'config');
  const rscript = await realpath(execFileSync('which', ['Rscript'], { encoding: 'utf8' }).trim());
  await rm(runtimePath, { recursive: true, force: true });
  await mkdir(join(configDirectory, 'alder'), { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  await writeFile(notebook, '# %%\nanswer <- 6L * 7L\nanswer\n');
  await writeFile(join(configDirectory, 'alder/preferences.yaml'), `rscript: ${JSON.stringify(rscript)}\n`);
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
  for (const key of Object.keys(environment)) {
    if (key.startsWith('ALDER_') || key === 'R_HOME' || key.startsWith('R_LIBS')) delete environment[key];
  }
  Object.assign(environment, {
    HOME: directory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: join(directory, 'data'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_STATE_HOME: join(directory, 'state'),
    ALDER_RUNTIME_DIRECTORY: runtimePath,
  });
  const transport = new StdioClientTransport({
    command: resources.cliLauncher,
    args: ['mcp', notebook],
    cwd: directory,
    env: environment,
    stderr: 'pipe',
    maxBufferSize: 16 * 1024 * 1024,
  });
  const client = new Client({ name: 'alder-mac-acceptance', version: '1' }, { capabilities: {} });
  const stderrChunks = [];
  transport.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  try {
    await client.connect(transport);
    const state = await client.callTool({ name: 'notebook_state', arguments: {} });
    if (state.isError) throw new Error('packaged notebook state failed');
    const snapshot = requireRecord(requireRecord(requireRecord(state.structuredContent).result).snapshot);
    const result = await client.callTool({ name: 'run_all', arguments: {
      requestId: randomUUID(),
      sessionEpoch: requireString(snapshot.epoch),
      expectedDocumentRevision: requireInteger(snapshot.documentRevision),
    } });
    if (result.isError) throw new Error(`packaged Ark evaluation failed: ${JSON.stringify(result.structuredContent)}`);
    const completed = await client.callTool({ name: 'notebook_state', arguments: {} });
    if (completed.isError) throw new Error('packaged notebook state failed after evaluation');
    const completedSnapshot = requireRecord(requireRecord(requireRecord(completed.structuredContent).result).snapshot);
    if (!JSON.stringify(completedSnapshot.cells).includes('42')) throw new Error('packaged Ark evaluation did not return scalar 42');
    const shutdown = await client.callTool({ name: 'shutdown', arguments: {
      requestId: randomUUID(),
      sessionEpoch: requireString(completedSnapshot.epoch),
      expectedDocumentRevision: requireInteger(completedSnapshot.documentRevision),
      expectedClientIds: Array.isArray(completedSnapshot.activeClientIds) ? completedSnapshot.activeClientIds : [],
      confirmed: true,
    } });
    if (shutdown.isError) throw new Error(`packaged host shutdown failed: ${JSON.stringify(shutdown.structuredContent)}`);
  } catch (error) {
    const diagnostics = Buffer.concat(stderrChunks).toString('utf8').trim();
    if (diagnostics) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`, { cause: error });
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  timings['ark-evaluation'] = Math.round(performance.now() - started);
  const cleanupStarted = performance.now();
  const cleanupDeadline = cleanupStarted + 10_000;
  while (ownedProcesses([directory, runtimePath]).length > 0 && performance.now() < cleanupDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const remaining = ownedProcesses([directory, runtimePath]);
  timings['child-cleanup'] = Math.round(performance.now() - cleanupStarted);
  if (remaining.length > 0) throw new Error(`packaged host left owned children running:\n${remaining.join('\n')}`);
}

function ownedProcesses(markers) {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(line => markers.some(marker => line.includes(marker)));
}

function requireRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected an object');
  return value;
}

function requireString(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('expected a non-empty string');
  return value;
}

function requireInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('expected a non-negative integer');
  return value;
}
