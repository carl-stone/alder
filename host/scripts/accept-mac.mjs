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
const DIFFERENTIAL_SEED = 0xa1de46;
const DIFFERENTIAL_TIMEOUT_MS = 60_000;

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
let differential;
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

  differential = await evaluatePackagedKernel(temporary, runtimeDirectory);
} finally {
  await rm(runtimeDirectory, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({ app, arkVersion, airVersion, quartoVersion, differential, timings }) + '\n');

async function evaluatePackagedKernel(directory, runtimePath) {
  const started = performance.now();
  const notebook = join(directory, 'ark-accept.R');
  const configDirectory = join(directory, 'config');
  const rscript = await realpath(execFileSync('which', ['Rscript'], { encoding: 'utf8' }).trim());
  await rm(runtimePath, { recursive: true, force: true });
  await mkdir(join(configDirectory, 'alder'), { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  const corpus = differentialCorpus(DIFFERENTIAL_SEED);
  const source = corpus.map((entry, index) => `# %%\n${wrappedExpression(index, entry.source)}\n`).join('');
  if (Buffer.byteLength(source) > 65_536) throw new Error('ordinary R differential corpus exceeds 64 KiB');
  await writeFile(notebook, source);
  const referenceScript = join(directory, 'rscript-reference.R');
  await writeFile(referenceScript, source);
  const referenceOutput = run('rscript-differential', rscript, ['--vanilla', referenceScript], { cwd: directory, timeout: DIFFERENTIAL_TIMEOUT_MS });
  const reference = extractDifferential(referenceOutput, corpus.length, 'Rscript');
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
    await bounded(client.connect(transport), 'packaged client connection');
    const state = await bounded(client.callTool({ name: 'notebook_state', arguments: {} }), 'initial packaged state');
    if (state.isError) throw new Error('packaged notebook state failed');
    const snapshot = requireRecord(requireRecord(requireRecord(state.structuredContent).result).snapshot);
    const result = await bounded(client.callTool({ name: 'run_all', arguments: {
      requestId: randomUUID(),
      sessionEpoch: requireString(snapshot.epoch),
      expectedDocumentRevision: requireInteger(snapshot.documentRevision),
    } }), 'packaged differential execution');
    if (result.isError) throw new Error(`packaged Ark evaluation failed: ${JSON.stringify(result.structuredContent)}`);
    const completed = await bounded(client.callTool({ name: 'notebook_state', arguments: {} }), 'completed packaged state');
    if (completed.isError) throw new Error('packaged notebook state failed after evaluation');
    const completedSnapshot = requireRecord(requireRecord(requireRecord(completed.structuredContent).result).snapshot);
    const actualText = completedSnapshot.cells.map(cell => [
      ...(Array.isArray(cell.log) ? cell.log : []),
      ...(Array.isArray(cell.outputs) ? cell.outputs.map(output => output?.data?.text).filter(value => typeof value === 'string') : []),
    ].join('\n')).join('\n');
    const actual = extractDifferential(actualText, corpus.length, 'packaged Ark');
    for (let index = 0; index < corpus.length; index += 1) {
      if (actual[index] !== reference[index]) {
        throw new Error(`ordinary R differs at case ${index} (${corpus[index].name}); seed=0x${DIFFERENTIAL_SEED.toString(16)} expected=${reference[index]} actual=${actual[index]}`);
      }
    }
    const shutdown = await bounded(client.callTool({ name: 'shutdown', arguments: {
      requestId: randomUUID(),
      sessionEpoch: requireString(completedSnapshot.epoch),
      expectedDocumentRevision: requireInteger(completedSnapshot.documentRevision),
      expectedClientIds: Array.isArray(completedSnapshot.activeClientIds) ? completedSnapshot.activeClientIds : [],
      confirmed: true,
    } }), 'packaged shutdown');
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
  return { seed: `0x${DIFFERENTIAL_SEED.toString(16)}`, cases: corpus.length, maxSourceBytes: 65_536, timeoutMs: DIFFERENTIAL_TIMEOUT_MS };
}

function differentialCorpus(seed) {
  let state = seed >>> 0;
  const integer = limit => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    return state % limit;
  };
  const left = 2 + integer(8), right = 2 + integer(8), unicode = ['café', 'λ', '🧬'][integer(3)];
  return [
    { name: 'scalar integer', source: `scalar <- ${left}L; scalar * ${right}L` },
    { name: 'scalar dependency', source: 'scalar + 1L' },
    { name: 'numeric vector', source: 'c(1, 2.5, -3, Inf, NA_real_)' },
    { name: 'named list', source: 'list(alpha=1L, beta=c(TRUE, FALSE), text="ok")' },
    { name: 'data frame', source: 'data.frame(id=1:3, label=c("a","b","c"), stringsAsFactors=FALSE)' },
    { name: 'quoting and unicode', source: JSON.stringify(`${unicode} "quoted" \\ slash`) },
    { name: 'function local', source: 'f <- function(x) { local_value <- x * 2L; local_value + 1L }; f(4L)' },
    { name: 'dot global definition', source: '.dot_global <- 8L; .dot_global' },
    { name: 'dot global dependency', source: '.dot_global + 2L' },
    { name: 'dynamic get', source: 'dynamic_value <- 9L; get("dynamic_value") + 1L' },
    { name: 'dynamic assign', source: 'assign("assigned_value", 11L, envir=.GlobalEnv); assigned_value' },
    { name: 'do call', source: 'do.call(sum, list(c(1L, 2L, 3L)))' },
    { name: 'quoted evaluation', source: 'eval(quote(3L * 5L))' },
    { name: 'matrix', source: 'matrix(1:6, nrow=2L, dimnames=list(c("r1","r2"), c("a","b","c")))' },
    { name: 'language object', source: 'quote(mean(c(1, 2, 3)))' },
    { name: 'subset', source: 'subset(data.frame(x=1:4, y=letters[1:4]), x %% 2L == 0L)' },
    { name: 'list indexing', source: 'structure(list(a=1L, b=list(2L, 3L)), class="generated")$b[[2L]]' },
    { name: 'ordinary error', source: `stop(${JSON.stringify(`expected ${unicode}`)})` },
  ];
}

function wrappedExpression(index, source) {
  const value = `.alder_diff_value_${index}`;
  const text = `.alder_diff_text_${index}`;
  const hex = `.alder_diff_hex_${index}`;
  return `${value} <- tryCatch({ ${source} }, error=function(e) structure(conditionMessage(e), class="alder_diff_error"))\n` +
    `${text} <- if (inherits(${value}, "alder_diff_error")) paste0("error:", unclass(${value})) else paste(capture.output(dput(${value}, control=c("keepNA","keepInteger","niceNames"))), collapse="\\n")\n` +
    `${hex} <- paste(sprintf("%02x", as.integer(charToRaw(enc2utf8(${text})))), collapse="")\n` +
    `cat("@@ALDER_DIFF_${index}@@", ${hex}, "\\n", sep="")`;
}

function extractDifferential(text, count, label) {
  const values = new Array(count);
  const pattern = /@@ALDER_DIFF_([0-9]+)@@([0-9a-f]*)/g;
  for (const match of text.matchAll(pattern)) {
    const index = Number(match[1]);
    if (index >= 0 && index < count && match[2].length > 0) values[index] = match[2];
  }
  for (let index = 0; index < count; index += 1) if (typeof values[index] !== 'string') {
    throw new Error(`${label} omitted differential case ${index}; seed=0x${DIFFERENTIAL_SEED.toString(16)}`);
  }
  return values;
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${DIFFERENTIAL_TIMEOUT_MS} ms`)), DIFFERENTIAL_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
