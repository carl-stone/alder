import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({ app, arkVersion, airVersion, quartoVersion, timings }) + '\n');
