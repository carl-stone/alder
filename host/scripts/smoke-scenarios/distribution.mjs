import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireAbsoluteRscript, sanitizedEnvironment } from './_common.mjs';

export async function run(ctx) {
  const selectedR = await requireAbsoluteRscript(ctx.rscript, 'distribution Rscript');
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const packageScript = join(sourceRoot, 'scripts', 'package.mjs');
  const smokeApplicationScript = join(sourceRoot, 'scripts', 'smoke-application.mjs');
  const release = join(ctx.evidence, `distribution-release-${process.platform}-${process.arch}`);
  const format = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archive = join(ctx.evidence, `distribution-release-${process.platform}-${process.arch}.${format}`);
  const qualification = ctx.qualificationRoot ? resolve(ctx.qualificationRoot) : join(ctx.evidence, 'qualification');
  const qualificationScript = join(qualification, 'driver', 'scripts', 'smoke-application.mjs');
  const qualificationSource = join(qualification, 'source');
  const artifactRecord = join(ctx.evidence, 'artifact-record.json');
  const extracted = join(ctx.evidence, `distribution-archive-${process.platform}-${process.arch}`);
  const relocated = join(ctx.evidence, `distribution-relocated Space ü-${process.platform}-${process.arch}`);
  await Promise.all([
    rm(release, { recursive: true, force: true }),
    ...(ctx.qualificationRoot ? [] : [rm(qualification, { recursive: true, force: true })]),
    rm(extracted, { recursive: true, force: true }),
    rm(relocated, { recursive: true, force: true }),
    rm(archive, { force: true }),
    rm(artifactRecord, { force: true }),
  ]);
  await mkdir(release, { recursive: true });
  const packageResult = runNode(packageScript, [
    '--application', ctx.applicationRoot,
    '--output', release,
    '--target-platform', process.platform,
    '--target-arch', process.arch,
    '--rscript', selectedR,
    '--archive', archive,
    '--archive-format', format,
    '--artifact-record', artifactRecord,
    '--source-commit', ctx.manifest.sourceCommit,
  ], 300_000);
  assert.equal(packageResult.status, 0, `application packaging failed: ${packageResult.stderr}`);
  if (!ctx.qualificationRoot) {
    const qualificationResult = runNode(join(sourceRoot, 'scripts', 'build-qualification-sidecar.mjs'), [
      '--output', qualification,
      '--application', ctx.applicationRoot,
    ], 300_000);
    assert.equal(qualificationResult.status, 0, 'qualification sidecar build failed: ' + qualificationResult.stderr);
  }
  assert.equal(await stat(qualificationScript).then(info => info.isFile()), true);
  assert.equal(await stat(join(qualificationSource, 'qualification-manifest.json')).then(info => info.isFile()), true);
  const artifact = JSON.parse(await readFile(artifactRecord, 'utf8'));
  const releaseManifest = artifact.releaseManifest;
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(resolve(dirname(artifactRecord), artifact.release.root), release);
  assert.equal(releaseManifest.schemaVersion, 1);
  assert.equal(releaseManifest.platform, process.platform);
  assert.equal(releaseManifest.arch, process.arch);
  assert.equal(releaseManifest.target.platform, process.platform);
  assert.equal(releaseManifest.target.arch, process.arch);
  assert.equal(releaseManifest.nodeVersion, process.version);
  assert.equal(releaseManifest.applicationVersion, ctx.manifest.applicationVersion);
  assert.equal(releaseManifest.sourceCommit, ctx.manifest.sourceCommit);
  assert.equal(releaseManifest.archive.format, format);
  assert.equal(artifact.artifact.format, format);
  assert.equal(artifact.release.manifestSha256, releaseManifest.manifestSha256);
  assert.equal(artifact.releaseManifestSha256, sha256Text(`${JSON.stringify(releaseManifest, null, 2)}\n`));
  assert.equal(artifact.artifact.sha256, await sha256(archive));
  assert.equal(artifact.artifact.bytes, (await stat(archive)).size);

  const actual = {};
  await collectHashes(release, '', actual);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(releaseManifest.files).sort(), 'release inventory differs from release descriptor');
  for (const [path, digest] of Object.entries(releaseManifest.files)) assert.equal(actual[path], digest, path);
  const applicationManifestPath = resolve(dirname(artifactRecord), artifact.release.applicationManifest);
  const applicationManifest = JSON.parse(await readFile(applicationManifestPath, 'utf8'));
  assert.equal(await sha256(applicationManifestPath), releaseManifest.manifestSha256);
  assert.equal(applicationManifest.kind, ctx.manifest.kind);
  assert.deepEqual(applicationManifest.target, { platform: process.platform, arch: process.arch });
  assert.deepEqual(applicationManifest.qualifiedRPatchVersions, ctx.manifest.qualifiedRPatchVersions);
  assert.ok(applicationManifest.qualifiedRPatchVersions.includes('4.6.0'), 'distribution is missing R 4.6.0 qualification');
  assert.ok(applicationManifest.qualifiedRPatchVersions.includes('4.6.1'), 'distribution is missing R 4.6.1 qualification');
  const supervisorPath = applicationManifest.resources.processSupervisorExecutable;
  const supervisorFile = applicationManifest.files.find(file => file.path === supervisorPath);
  assert.ok(supervisorFile, 'packaged native supervisor is not in the application inventory');
  assert.equal(actual[supervisorPath], supervisorFile.sha256, 'release changed the native supervisor digest');
  assert.equal(await stat(join(dirname(dirname(applicationManifestPath)), supervisorPath)).then(info => info.isFile()), true);
  await extractArchive(archive, extracted, format);
  const packagedApplicationRoot = dirname(dirname(applicationManifestPath));
  assert.equal(await sha256(join(extracted, releaseManifest.applicationManifest)), await sha256(join(release, releaseManifest.applicationManifest)));
  assert.equal(await sha256(join(extracted, supervisorPath)), supervisorFile.sha256);

  await cp(extracted, relocated, { recursive: true, verbatimSymlinks: true });
  const installedApplication = resolve(relocated, relative(release, packagedApplicationRoot));
  const installedNode = join(installedApplication, applicationManifest.resources.nodeExecutable);
  const releaseSmokeArgs = [
    qualificationScript,
    installedApplication,
    '--scenario', 'all',
    '--evidence', join(ctx.evidence, 'distribution-application'),
    '--rscript', selectedR,
    '--qualification-source', qualificationSource,
  ];
  if (ctx.peerRscript) releaseSmokeArgs.push('--peer-rscript', await requireAbsoluteRscript(ctx.peerRscript, 'distribution peer Rscript'));
  const releaseSmoke = runCommand(installedNode, releaseSmokeArgs, 10_800_000, { ALDER_DISTRIBUTION_ARCHIVE_SMOKE: '1', ALDER_RELEASE_QUALIFICATION: '1' });
  assert.equal(releaseSmoke.status, 0, 'relocated installed S(all) smoke failed: ' + releaseSmoke.stderr);
  const releaseSmokeOutput = parseLastJson(releaseSmoke.stdout);
  assert.equal(releaseSmokeOutput.summary?.total, 39);
  assert.equal(releaseSmokeOutput.summary?.failed, 0);
  assert.equal(releaseSmokeOutput.summary?.blocked, 0);
  assert.equal(releaseSmokeOutput.summary?.passed + releaseSmokeOutput.summary?.notApplicable, 39);
  assert.equal(releaseSmokeOutput.manifestSha256, releaseManifest.manifestSha256);

  const identity = {
    package: {
      root: release,
      releaseManifestSha256: artifact.releaseManifestSha256,
      applicationManifest: releaseManifest.applicationManifest,
      applicationManifestSha256: releaseManifest.manifestSha256,
      files: Object.keys(releaseManifest.files).length,
    },
    archive: { path: archive, format, sha256: await sha256(archive), bytes: (await stat(archive)).size, artifactRecord, extractedRoot: extracted },
    relocated: { root: relocated, smoke: 'extracted installed S(all) passed' },
    native: { path: supervisorPath, sha256: supervisorFile.sha256, bytes: supervisorFile.bytes },
    r: {
      qualifiedRPatchVersions: applicationManifest.qualifiedRPatchVersions,
      rBuildVersion: applicationManifest.rBuildVersion,
      rVersionRange: applicationManifest.rVersionRange,
    },
    signature: releaseManifest.signature,
  };
  await writeFile(join(ctx.evidence, 'distribution.json'), `${JSON.stringify(identity, null, 2)}\n`);
  return { id: 'distribution', identity };
}

function runNode(script, args, timeout, extraEnvironment = {}) { return runCommand(process.execPath, [script, ...args], timeout, extraEnvironment); }
function runCommand(command, args, timeout, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: sanitizedEnvironment(extraEnvironment),
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('command_timeout: ' + command + ' ' + args.join(' '));
  return {
    ...result,
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '') + (result.error ? '\n' + result.error.message : ''),
  };
}
function parseLastJson(text) {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1, 'release smoke must emit exactly one JSON record');
  try { return JSON.parse(lines[0]); } catch (error) { throw new Error('release smoke emitted invalid JSON: ' + (error instanceof Error ? error.message : String(error))); }
}
async function extractArchive(archive, destination, format) {
  await mkdir(destination, { recursive: true });
  if (format === 'tar.gz') execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit', windowsHide: true });
  else if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:ALDER_ARCHIVE_INPUT -DestinationPath $env:ALDER_ARCHIVE_DESTINATION -Force'], {
      env: { ...process.env, ALDER_ARCHIVE_INPUT: archive, ALDER_ARCHIVE_DESTINATION: destination },
      stdio: 'inherit',
      windowsHide: true,
    });
  } else execFileSync('unzip', ['-q', archive, '-d', destination], { stdio: 'inherit', windowsHide: true });
}
async function collectHashes(directory, prefix, result, root = directory) {
  const physicalRoot = await realpath(root);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${prefix}${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectHashes(path, `${child}/`, result, root);
    else if (entry.isFile()) result[child.split(sep).join('/')] = await sha256(path);
    else if (entry.isSymbolicLink()) {
      const physical = await realpath(path).catch(() => null);
      if (!physical || (physical !== physicalRoot && !physical.startsWith(physicalRoot + sep))) throw new Error('distribution inventory symlink escapes root: ' + child);
      result[child.split(sep).join('/')] = sha256Text(await readlink(path));
    } else throw new Error('distribution inventory contains unsupported entry: ' + path);
  }
}
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function sha256Text(text) { return createHash('sha256').update(text).digest('hex'); }