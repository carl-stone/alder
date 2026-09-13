import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, redact } from './_common.mjs';
import { normalizeHostBundleWhitespace } from '../bundle-normalization.mjs';

const REMOVED_PATHS = Object.freeze([
  'R/cli.R',
  'R/server.R',
  'R/host.R',
  'R/mcp.R',
  'R/host-services.R',
  'R/dataflow.R',
  'R/export.R',
  'R/convert.R',
  'R/publish.R',
  'R/format.R',
  'R/config.R',
  'R/layout.R',
  'R/app.R',
  'R/notebook.R',
  'R/packages.R',
  'R/host-jobs.R',
  'inst/worker/host-job.R',
  'host/src/gallery.ts',
  'host/src/remote.ts',
  'inst/host/manifest.json',
  'inst/host/release.json',
  'inst/host/ark-manifest.json',
  'inst/host/native-manifest.json',
  'exec/alder',
  'exec/alder.cmd',
  'host/src/services.ts',
  'inst/publishing/alder.css',
]);

export async function run(ctx) {
  const id = 'bundle-removal';
  const applicationRoot = resolve(ctx.applicationRoot);
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const sourceRoot = resolve(ctx.sourceRoot ?? checkoutRoot);
  const evidenceDirectory = join(ctx.evidence, id);
  const evidencePath = join(ctx.evidence, `${id}.json`);
  const rebuiltDirectory = join(evidenceDirectory, 'rebuilt');
  await mkdir(rebuiltDirectory, { recursive: true });

  const missing = [];
  for (const path of REMOVED_PATHS) if (await exists(join(sourceRoot, path))) missing.push(path);
  assert.deepEqual(missing, [], `removed source surfaces remain: ${missing.join(', ')}`);
  const retainedRFiles = (await readdir(join(sourceRoot, 'R'))).filter(name => name.endsWith('.R')).sort();
  assert.deepEqual(retainedRFiles, ['alder-package.R', 'analysis.R', 'cache.R', 'outputs.R', 'performance.R', 'runtime-protocol.R', 'ui-widgets.R', 'utils.R'], 'R helper source inventory contains a removed application module or omits a retained helper');
  const namespaceExports = (await readFile(join(sourceRoot, 'NAMESPACE'), 'utf8')).split(/\r?\n/u).filter(line => line.startsWith('export(')).sort();
  assert.deepEqual(namespaceExports, ['export(cache)', 'export(out)', 'export(ui)'], 'deprecated R application exports remain');

  const forbiddenSymbols = await scanForbiddenSymbols(sourceRoot);
  assert.deepEqual(forbiddenSymbols, [], 'legacy bundle symbols remain in source');

  const rebuiltHost = join(rebuiltDirectory, 'alder-host.mjs');
  const rebuiltBrowser = join(rebuiltDirectory, 'host-app.js');
  await build({
    absWorkingDir: join(sourceRoot, 'host'),
    entryPoints: ['src/main.ts'],
    outfile: rebuiltHost,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    legalComments: 'linked',
    external: ['zeromq'],
    banner: { js: "import { createRequire as __alderCreateRequire } from 'node:module'; const require = __alderCreateRequire(import.meta.url);" },
  });
  await normalizeHostBundleWhitespace(rebuiltHost);
  await build({
    absWorkingDir: join(sourceRoot, 'host'),
    entryPoints: ['src/browser/app.ts'],
    outfile: rebuiltBrowser,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    banner: { js: '//# allFunctionsCalledOnLoad' },
    legalComments: 'linked',
  });

  const hostSource = join(sourceRoot, 'inst/host/alder-host.mjs');
  const browserSource = join(sourceRoot, 'inst/app/static/host-app.js');
  const indexSource = join(sourceRoot, 'inst/app/index.html');
  const hostShipped = join(applicationRoot, ctx.manifest.resources.hostEntry);
  const browserShipped = join(applicationRoot, ctx.manifest.resources.rendererDirectory, 'host-app.js');
  const indexShipped = join(applicationRoot, dirname(ctx.manifest.resources.rendererDirectory), 'app', 'index.html');
  for (const path of [hostSource, browserSource, indexSource, hostShipped, browserShipped, indexShipped]) {
    assert.equal(await exists(path), true, `bundle missing: ${path}`);
  }
  const bundles = {
    host: await compareBundle('host', hostSource, rebuiltHost, hostShipped),
    browser: await compareBundle('browser', browserSource, rebuiltBrowser, browserShipped),
    index: await compareBundle('index', indexSource, null, indexShipped),
  };

  let harness;
  try {
    harness = await createHarness(ctx, { id, source: '# %%\n1 + 1\n', rscript: ctx.rscript });
    assert.equal(harness.registry.state, 'ready');
    assert.equal(harness.session.processNonce, harness.registry.processNonce);
    assert.equal(harness.session.epoch, harness.registry.epoch);
    const manifestPath = join(applicationRoot, dirname(ctx.manifest.resources.hostEntry), '..', 'manifest.json');
    const manifestSha256 = await sha256File(manifestPath);
    const sourceInventory = await collectSourceInventory(sourceRoot);
    const identity = {
      sourceCommit: ctx.manifest.sourceCommit,
      sourceTreeSha256: ctx.manifest.sourceTreeSha256,
      manifestSha256,
      bundles,
      sourceInventorySha256: inventoryDigest(sourceInventory),
      sourceFileCount: sourceInventory.length,
      removedPaths: REMOVED_PATHS,
      process: {
        pid: harness.registry.pid,
        processNonce: harness.registry.processNonce,
        startIdentity: harness.registry.startIdentity,
        epoch: harness.registry.epoch,
        origin: harness.origin,
      },
    };
    await writeFile(evidencePath, `${JSON.stringify(redact({ id, identity, sourceInventory, forbiddenSymbols, registry: harness.registry }), null, 2)}\n`, 'utf8');
    return { id, identity };
  } finally {
    await harness?.close();
  }
}

async function compareBundle(name, sourcePath, rebuiltPath, shippedPath) {
  const sourceSha256 = await sha256File(sourcePath);
  const shippedSha256 = await sha256File(shippedPath);
  assert.equal(shippedSha256, sourceSha256, `${name} shipped bundle differs from committed bundle`);
  const result = { source: sourcePath, shipped: shippedPath, sourceSha256, shippedSha256 };
  if (rebuiltPath) {
    const rebuiltSha256 = await sha256File(rebuiltPath);
    assert.equal(rebuiltSha256, sourceSha256, `${name} rebuild differs from committed bundle`);
    result.rebuilt = rebuiltPath;
    result.rebuiltSha256 = rebuiltSha256;
  }
  return result;
}

async function scanForbiddenSymbols(root) {
  const symbols = [
    'LegacyOperationAliases',
    'RemoteController',
    'legacy_operation',
    'host-job.R',
    'gallery.catalog',
    '/n/<notebook>',
    'ALDER_EVENT_V1',
    'inspectionComm',
    'positron.ui',
    'evaluate_code',
    '.ps.internal',
    '.ps.Call',
    'ps_to_json',
    'ps_html_display_data',
  ];
  const findings = [];
  const files = (await collectSourceInventory(root)).filter(file =>
    /^(?:R\/|host\/src\/|desktop\/src\/|inst\/worker\/)/u.test(file.path));
  for (const file of files) {
    if (!/\.(?:R|r|ts|tsx|mjs|js)$/u.test(file.path)) continue;
    const text = await readFile(join(root, file.path), 'utf8');
    for (const symbol of symbols) if (text.includes(symbol)) findings.push({ path: file.path, symbol });
  }
  return findings;
}

async function collectSourceInventory(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!shouldSkipSourceDirectory(relativePath)) await walk(path);
      } else if (entry.isFile() && !shouldSkipSourceFile(relativePath)) {
        files.push({ path: relativePath, bytes: (await stat(path)).size, sha256: await sha256File(path) });
      }
    }
  }
  await walk(root);
  return files;
}

const GENERATED_HOST_ROOT = /^(?:\.alder|\.application(?:[-_.].*)?|\.evidence(?:[-_.].*)?|\.release(?:[-_.].*)?|\.runtime(?:[-_.].*)?|\.stage(?:[-_.].*)?|\.staging(?:[-_.].*)?|\.output(?:[-_.].*)?|\.tmp(?:[-_.].*)?|\.manual(?:[-_.].*)?|dist|node_modules|evidence|output|release|staging)$/u;
const GENERATED_REVIEW_ROOT = /^(?:evidence|staging|output|release)(?:[-_.].*)?$/u;
const GENERATED_EVIDENCE_FILE = /^dev\/omp-restart-\d{4}-\d{2}-\d{2}\.json$/u;

function shouldSkipSourceDirectory(path) {
  const segments = path.split('/');
  if (path === '.git') return true;
  if (segments.length === 1 && GENERATED_HOST_ROOT.test(segments[0])) return true;
  if (segments[0] === 'host' && segments.length === 2 && GENERATED_HOST_ROOT.test(segments[1])) return true;
  if (segments[0] === 'dev' && segments[1] === 'reviews' && segments.length === 3 && GENERATED_REVIEW_ROOT.test(segments[2])) return true;
  if (path === 'host/native/process-supervisor/target' || path.startsWith('host/native/process-supervisor/target/')) return true;
  return false;
}
function shouldSkipSourceFile(path) {
  return GENERATED_EVIDENCE_FILE.test(path);
}
function inventoryDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return hash.digest('hex');
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
