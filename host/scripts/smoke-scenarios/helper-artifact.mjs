import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact, sanitizedEnvironment, spawnSmokeProcess } from './_common.mjs';

export async function run(ctx) {
  const id = 'helper-artifact';
  const selectedRscript = normalizeRscript(ctx.rscript);
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const sourceRoot = resolve(ctx.sourceRoot ?? checkoutRoot);
  const evidenceDirectory = join(ctx.evidence, id);
  const buildDirectory = join(evidenceDirectory, 'build');
  const libraryDirectory = join(evidenceDirectory, 'library');
  const dependencyDirectory = join(evidenceDirectory, 'dependencies');
  const evidencePath = join(ctx.evidence, id + '.json');
  await mkdir(buildDirectory, { recursive: true });
  await mkdir(libraryDirectory, { recursive: true });
  await mkdir(dependencyDirectory, { recursive: true });

  const applicationRealpath = await realpath(resolve(ctx.applicationRoot));
  const prerequisiteLibrary = resolve(applicationRealpath, ctx.manifest.resources.rLibraryDirectory);
  const prerequisiteLibraryRealpath = await realpath(prerequisiteLibrary);
  assert.equal(isPathWithin(applicationRealpath, prerequisiteLibraryRealpath), true, 'prerequisite R library escaped application root');
  const dependencies = await stageDependencies(sourceRoot, prerequisiteLibraryRealpath, dependencyDirectory);
  const environment = sanitizedEnvironment({
    HOME: join(evidenceDirectory, 'home'),
    R_LIBS_USER: libraryDirectory,
    R_LIBS: dependencyDirectory,
    R_PROFILE_USER: '',
    R_ENVIRON_USER: '',
  });
  const rHomeBin = await resolveRHomeBin(selectedRscript, environment);
  const rCommand = join(rHomeBin, process.platform === 'win32' ? 'R.exe' : 'R');
  const build = await runProcess(rCommand, ['CMD', 'build', '--no-build-vignettes', '--no-manual', sourceRoot], {
    cwd: buildDirectory,
    env: environment,
  });
  const artifacts = (await readdir(buildDirectory)).filter(name => /^alder_[^/]+\.tar\.gz$/.test(name));
  assert.equal(artifacts.length, 1, `expected one helper source artifact, found ${artifacts.length}`);
  const sourceArtifact = join(buildDirectory, artifacts[0]);
  const artifactSha256 = await sha256File(sourceArtifact);
  const artifactBytes = (await stat(sourceArtifact)).size;
  const listing = await runProcess('tar', ['-tzf', sourceArtifact], { cwd: buildDirectory, env: environment });
  const artifactEntries = listing.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  assert.equal(artifactEntries.some(entry => entry.startsWith('alder/')), true, 'source artifact has no package members');
  const nonPackageEntries = artifactEntries.filter(entry => entry !== 'alder/' && !entry.startsWith('alder/'));
  assert.deepEqual(nonPackageEntries, [], 'source artifact contains files outside package root');
  const packageRootEntries = artifactEntries.map(entry => entry.replace(/^alder\//, ''));
  assert.equal(artifactEntries.includes('alder/DESCRIPTION'), true, 'source artifact has no alder/DESCRIPTION');
  const forbiddenEntries = packageRootEntries.filter(entry => ROOT_EVIDENCE_PATTERN.test(entry) || ROOT_ARCHIVE_PATTERN.test(entry) || /^(?:ALDER_ARCHITECTURE_PLAN[.]md|NEEDS_CARL[.]md|inst\/(?:app|host|worker|exec|publishing)(?:\/|$)|(?:\.tmp|\.alder|\.application|\.cache|\.coverage|coverage|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.quarto|\.renv|\.pak|\.air|evidence|handoff|artifacts?|cache|tmp|Rcheck|\.Rcheck|\.Rhistory|\.RData|Rplots[.]pdf)(?:\/|$))/.test(entry));
  assert.deepEqual(forbiddenEntries, [], 'helper artifact contains application or temporary payload');


  const install = await runProcess(rCommand, ['CMD', 'INSTALL', '--no-multiarch', `--library=${libraryDirectory}`, sourceArtifact], {
    cwd: evidenceDirectory,
    env: environment,
  });
  const helperDirectory = join(libraryDirectory, 'alder');
  const helperRealpath = await realpath(helperDirectory);
  const evidenceRealpath = await realpath(evidenceDirectory);
  const dependencyRealpath = await realpath(dependencyDirectory);
  assert.equal(isPathWithin(evidenceRealpath, helperRealpath), true, 'helper installed outside smoke evidence');
  assert.equal(isPathWithin(evidenceRealpath, dependencyRealpath), true, 'helper dependencies escaped smoke evidence');
  assert.equal(isPathWithin(applicationRealpath, helperRealpath), false, 'helper loaded from application resource root');
  const packageFiles = await collectFiles(helperDirectory);
  assert.equal(packageFiles.length > 0, true, 'installed helper has no files');
  const forbiddenInstalled = packageFiles.filter(path => ROOT_EVIDENCE_PATTERN.test(path) || ROOT_ARCHIVE_PATTERN.test(path) || /^(?:(?:ALDER_ARCHITECTURE_PLAN[.]md|NEEDS_CARL[.]md)$|(?:app|host|worker|exec|publishing)(?:\/|$)|inst\/(?:app|host|worker|exec|publishing)(?:\/|$)|(?:\.tmp|\.alder|\.application|\.cache|\.coverage|coverage|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.quarto|\.renv|\.pak|\.air|evidence|handoff|artifacts?|cache|tmp|Rcheck|\.Rcheck|\.Rhistory|\.RData|Rplots[.]pdf)(?:\/|$))/.test(path));
  assert.deepEqual(forbiddenInstalled, [], 'installed helper contains application or temporary payload');

  const probe = await runRProbe(selectedRscript, libraryDirectory, environment);
  assert.equal(probe.package, 'alder');
  assert.equal(typeof probe.version, 'string');
  assert.equal(typeof probe.rVersion, 'string');
  assert.equal(typeof probe.rPlatform, 'string');
  assert.deepEqual([...probe.exports].sort(), ['cache', 'out', 'ui'], 'helper exports changed');
  assert.equal(probe.behavior.markdownKind, 'markdown');
  assert.equal(probe.behavior.sliderKind, 'slider');
  assert.equal(probe.behavior.sliderValue, 0.5);
  assert.equal(probe.behavior.cacheKind, 'memory');
  const libraryRealpath = await realpath(libraryDirectory);
  assert.equal(resolve(probe.libraryDirectory), resolve(libraryRealpath), 'helper probe used the installed library root');
  assert.equal(resolve(probe.packageDirectory), resolve(helperRealpath), 'helper probe loaded the wrong package directory');
  assert.equal(probe.libraryPaths.some(path => resolve(path) === resolve(libraryRealpath)), true, 'helper probe omitted fresh helper library');
  assert.equal(probe.libraryPaths.some(path => resolve(path) === resolve(dependencyRealpath)), true, 'helper probe omitted dependency library');
  assert.equal(probe.libraryPaths.some(path => isPathWithin(prerequisiteLibraryRealpath, resolve(path))), false, 'helper probe used the application R library');
  assert.equal(probe.behavior.cacheValue, 3);
  const manifestPath = join(applicationRealpath, dirname(ctx.manifest.resources.hostEntry), '..', 'manifest.json');
  const manifestSha256 = await sha256File(manifestPath);
  const lockPath = join(applicationRealpath, ctx.manifest.resources.rLibraryDirectory, 'r-library.lock.json');
  const lockSha256 = await sha256File(lockPath);
  const identity = {
    sourceRoot,
    sourceCommit: ctx.manifest.sourceCommit,
    manifestSha256,
    helper: {
      version: probe.version,
      package: probe.package,
      selectedRscript,
      buildR: rCommand,
      rHomeBin,
      rVersion: probe.rVersion,
      rPlatform: probe.rPlatform,
      sourceArtifact,
      artifactSha256,
      artifactBytes,
      installedLibrary: helperRealpath,
      dependencyLibrary: dependencyRealpath,
      dependencies,
      libraryPaths: probe.libraryPaths,
      installedInventorySha256: inventoryDigest(packageFiles),
      lockSha256,
    },
    build: {
      command: rCommand,
      stdoutSha256: digestText(build.stdout),
      stderrSha256: digestText(build.stderr),
      status: build.status,
    },
    install: {
      stdoutSha256: digestText(install.stdout),
      stderrSha256: digestText(install.stderr),
      status: install.status,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(redact({ id, identity, probe, artifactEntries, packageFiles }), null, 2)}\n`, 'utf8');
  return { id, identity };
}

const ROOT_ARCHIVE_PATTERN = /^(?:[^/]+[.]tar(?:[.](?:gz|bz2|xz|zst))?|[^/]+[.](?:tgz|zip))$/;
const ROOT_EVIDENCE_PATTERN = /^alder-evidence(?:[-_.][^/]+)?(?:\/|$)/;

const STANDARD_R_PACKAGES = new Set([
  'R', 'base', 'compiler', 'datasets', 'graphics', 'grDevices', 'grid',
  'methods', 'parallel', 'splines', 'stats', 'stats4', 'tcltk', 'tools', 'utils',
]);

async function stageDependencies(sourceRoot, sourceLibrary, destination) {
  const sourceDescription = await readFile(join(sourceRoot, 'DESCRIPTION'), 'utf8');
  const sourceFields = parseDcf(sourceDescription);
  assert.equal(sourceFields.Package, 'alder', 'helper source package identity changed');
  const pending = dependencyNames(sourceFields);
  const metadata = new Map();
  while (pending.length > 0) {
    const name = pending.shift();
    if (STANDARD_R_PACKAGES.has(name)) continue;
    assert.notEqual(name, 'alder', 'helper dependency closure includes alder');
    if (metadata.has(name)) continue;
    const sourcePath = join(sourceLibrary, name);
    let sourceRealpath;
    try {
      sourceRealpath = await realpath(sourcePath);
    } catch {
      throw new Error('helper dependency missing: ' + name);
    }
    assert.equal(isPathWithin(sourceLibrary, sourceRealpath), true, 'helper dependency escaped source library: ' + name);
    let description;
    try {
      description = await readFile(join(sourceRealpath, 'DESCRIPTION'), 'utf8');
    } catch {
      throw new Error('helper dependency descriptor missing: ' + name);
    }
    const fields = parseDcf(description);
    assert.equal(fields.Package, name, 'helper dependency package identity changed: ' + name);
    metadata.set(name, { sourceRealpath, version: fields.Version ?? 'unknown' });
    for (const dependency of dependencyNames(fields)) {
      if (!STANDARD_R_PACKAGES.has(dependency)) pending.push(dependency);
    }
  }

  const records = [];
  for (const name of [...metadata.keys()].sort()) {
    const source = metadata.get(name);
    const destinationPath = join(destination, name);
    await cp(source.sourceRealpath, destinationPath, { recursive: true });
    const destinationRealpath = await realpath(destinationPath);
    assert.equal(isPathWithin(destination, destinationRealpath), true, 'helper dependency escaped evidence library: ' + name);
    assert.equal(destinationRealpath === source.sourceRealpath, false, 'helper dependency was not copied: ' + name);
    await collectFiles(destinationRealpath);
    records.push({ name, version: source.version, sourceRealpath: source.sourceRealpath, destinationRealpath });
  }
  const entries = await readdir(destination, { withFileTypes: true });
  assert.equal(entries.every(entry => entry.isDirectory()), true, 'dependency library contains a non-package entry');
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...metadata.keys()].sort(), 'dependency library closure changed');
  return records;
}

function dependencyNames(fields) {
  const values = ['Depends', 'Imports'].flatMap(key => String(fields[key] ?? '').split(','));
  return [...new Set(values.map(value => value.trim().replace(/\s*\(.*$/, '').trim()).filter(value => /^[A-Za-z][A-Za-z0-9.]*$/.test(value)))];
}

function parseDcf(text) {
  const fields = {};
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^ :]+):[ \t]*(.*)$/);
    if (match) {
      key = match[1];
      fields[key] = match[2];
    } else if (key && /^\s/.test(line)) {
      fields[key] += ' ' + line.trim();
    }
  }
  return fields;
}

function isPathWithin(root, target) {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}
function normalizeRscript(value) {
  const normalized = String(value);
  return normalized.includes('/') || normalized.includes('\\\\') ? resolve(normalized) : normalized;
}
async function resolveRHomeBin(rscript, env) {
  const probe = await runProcess(rscript, [
    '--vanilla', '--no-echo', '--no-restore', '--no-save', '-e',
    'cat(normalizePath(R.home("bin"), winslash = "/", mustWork = TRUE))',
  ], { cwd: process.cwd(), env });
  const rHomeBin = probe.stdout.trim();
  assert.equal(rHomeBin.length > 0, true, 'selected Rscript did not report R.home("bin")');
  return rHomeBin;
}

async function runRProbe(rscript, library, env) {
  const code = [
    `lib <- ${JSON.stringify(library)}`,
    'suppressPackageStartupMessages(library(alder, lib.loc = lib))',
    'md <- alder::out$md("smoke")',
    'slider <- alder::ui$slider(0, 1, value = 0.5, step = 0.5)',
    'cached <- alder::cache$memory(function(x) x + 1)',
    'cacheValue <- cached(2)',
    'loaded <- find.package("alder", lib.loc = lib)',
    'result <- list(package = as.character(packageDescription("alder", lib.loc = lib)[["Package"]]), libraryDirectory = normalizePath(lib, winslash = "/", mustWork = TRUE), packageDirectory = normalizePath(loaded, winslash = "/", mustWork = TRUE), libraryPaths = normalizePath(.libPaths(), winslash = "/", mustWork = FALSE), version = as.character(packageVersion("alder")), rVersion = R.version$version.string, rPlatform = R.version$platform, exports = getNamespaceExports("alder"), behavior = list(markdownKind = md$kind, sliderKind = slider$kind, sliderValue = slider$value, cacheKind = attr(cached, "cache"), cacheValue = cacheValue))',
    'cat(paste0("ALDER_HELPER_PROBE:", jsonlite::toJSON(result, auto_unbox = TRUE, null = "null"), "\\n"))',
  ].join('; ');
  const result = await runProcess(rscript, ['--vanilla', '--no-echo', '--no-restore', '--no-save', '-e', code], { cwd: library, env });
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('ALDER_HELPER_PROBE:'));
  assert.equal(typeof line, 'string', `helper probe did not emit identity: ${result.stderr}`);
  return JSON.parse(line.slice('ALDER_HELPER_PROBE:'.length));
}

async function collectFiles(root) {
  const result = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path.slice(root.length + 1).split('\\').join('/'));
      else throw new Error(`helper_special_file:${path}`);
    }
  }
  await walk(root);
  return result.sort();
}

function inventoryDigest(files) {
  return digestText(files.join('\n') + '\n');
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function runProcess(command, args, { cwd, env }) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawnSmokeProcess(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectResult);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        rejectResult(new Error(`command_failed:${command} ${args.join(' ')}:${code ?? signal ?? 'unknown'}:${stderr.slice(-2_048)}`));
      } else {
        resolveResult({ status: code, stdout, stderr });
      }
    });
  });
}
