import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const release = resolve(process.argv[2] ?? 'host/.release');
const node = join(release, 'host/runtime', process.platform === 'win32' ? 'node.exe' : 'node');
if (await realpath(process.execPath) !== await realpath(node)) {
  const child = spawnSync(node, [fileURLToPath(import.meta.url), release], { stdio: 'inherit', timeout: 180_000 });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
assert.equal(process.version, manifest.nodeVersion);
assert.equal(process.platform, manifest.platform);
assert.equal(process.arch, manifest.arch);
const actual = [];
async function files(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await files(join(directory, entry.name), `${name}/`);
    else if (name !== 'release.json') actual.push(name);
  }
}
await files(release);
assert.deepEqual(actual.sort(), Object.keys(manifest.files).sort());
for (const [path, hash] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(await readFile(join(release, path))).digest('hex'), hash, path);
}
const bundle = join(release, 'host/alder-host.mjs');
const identity = JSON.parse(execFileSync(node, [bundle, '--host-info'], { encoding: 'utf8', timeout: 10_000 }));
assert.equal(identity.protocol, manifest.protocol);
assert.equal(identity.packageVersion, manifest.packageVersion);
const ark = join(release, 'host/runtime', process.platform === 'win32' ? 'ark.exe' : 'ark');
assert.match(execFileSync(ark, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
  new RegExp(manifest.arkVersion.replaceAll('.', '\\.')));

const temporary = await mkdtemp(join(tmpdir(), 'alder-release-smoke-'));
let app;
try {
  const lib = join(temporary, 'library');
  await mkdir(lib);
  const archive = actual.find(path => /^alder_[^/]+\.tar\.gz$/.test(path));
  assert.ok(archive, 'Release must contain its R source archive');
  const rscript = process.env.ALDER_RSCRIPT ?? 'Rscript';
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('ALDER_')) delete environment[key];
  }
  const libraries = execFileSync(rscript, ['--vanilla', '-e',
    'cat(paste(.libPaths(), collapse = .Platform$path.sep))'], { encoding: 'utf8', env: environment }).trim();
  environment.R_LIBS = [lib, libraries].join(delimiter);
  execFileSync(rscript, ['--vanilla', '-e',
    'args <- commandArgs(TRUE); install.packages(args[[1]], lib = args[[2]], repos = NULL, type = "source")',
    join(release, archive), lib], { env: environment, stdio: 'inherit', timeout: 90_000 });
  const launcher = join(release, 'bin', process.platform === 'win32' ? 'alder.cmd' : 'alder');
  const cli = args => process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`],
      { env: environment, encoding: 'utf8', timeout: 15_000, windowsVerbatimArguments: true })
    : spawnSync(launcher, args, { env: environment, encoding: 'utf8', timeout: 15_000 });
  const version = cli(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `alder ${manifest.packageVersion}`);
  const invalid = cli(['--invalid-release-probe']);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /unknown option/);

  // The engine must locate native modules and Ark beside this release bundle.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ALDER_')) delete process.env[key];
  }
  process.env.R_LIBS = environment.R_LIBS;
  const path = join(temporary, 'notebook.R');
  await writeFile(path, '# %%\nx <- 40\nkernel_pid <- Sys.getpid()\nkernel_pid\n# %%\nx + 2\n');
  const { startHost } = await import(pathToFileURL(bundle).href);
  app = await startHost({ path, port: 0, runOnStartup: false, executionMode: 'lazy', rscript, packagePath: join(lib, 'alder') });
  const engineIdentity = app.engineIdentity;
  assert.equal(engineIdentity.kernel?.name, 'ark', 'Execution must use the packaged Ark backend');
  assert.equal(engineIdentity.kernel?.version, manifest.arkVersion);
  const controller = app.controller;
  assert.equal(controller.snapshot().runtime.executionReady, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomUUID();
    await controller.dispatch({ type: 'run', scope: 'all', operationId: id, sessionEpoch: controller.epoch });
    assert.equal((await controller.awaitOperation(id)).status, 'done');
    assert.deepEqual(controller.snapshot().cells.map(cell => cell.status), ['done', 'done']);
    assert.match(JSON.stringify(controller.snapshot().cells[1].outputs), /42/);
  }
  const kernelPid = Number(controller.snapshot().cells[0].outputs[0].text.match(/\[1\] (\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(kernelPid) && kernelPid > 0);
  const interruptedId = randomUUID();
  let stop;
  const unsubscribe = controller.subscribe(event => {
    if (event.type === 'cell-started' && event.operationId === interruptedId) {
      stop = controller.dispatch({ type: 'interrupt', operationId: randomUUID(), sessionEpoch: controller.epoch });
    }
  });
  try {
    await controller.dispatch({ type: 'run', scope: 'cell', cellId: 'cell-2',
      operationId: interruptedId, sessionEpoch: controller.epoch,
      edits: [{ cellId: 'cell-2', expectedRevision: 0, cellType: 'code', body: ['repeat Sys.sleep(1)'] }] });
    let timer;
    try {
      const interrupted = await Promise.race([controller.awaitOperation(interruptedId),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged kernel did not settle interruption')), 15_000); })]);
      assert.equal(interrupted.status, 'cancelled');
      assert.ok(stop, 'Stop must be sent after the kernel entered evaluation');
      await stop;
    } finally { clearTimeout(timer); }
  } finally { unsubscribe(); }
  const recoveryId = randomUUID();
  await controller.dispatch({ type: 'run', scope: 'cell', cellId: 'cell-2',
    operationId: recoveryId, sessionEpoch: controller.epoch,
    edits: [{ cellId: 'cell-2', expectedRevision: 1, cellType: 'code',
      body: ['stopifnot(identical(Sys.getpid(), kernel_pid))', '6 * 7'] }] });
  assert.equal((await controller.awaitOperation(recoveryId)).status, 'done');
  assert.match(JSON.stringify(controller.snapshot().cells[1].outputs), /42/);
  const response = await fetch(`${app.server.address().origin}/api/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).epoch, controller.epoch);
  await app.close();
  await app.closed;
  app = undefined;
  assert.throws(() => process.kill(kernelPid, 0), { code: 'ESRCH' }, 'Packaged kernel must exit before host closure settles');
  process.stdout.write(`${JSON.stringify({ release, node: process.version, ark: manifest.arkVersion,
    verifiedFiles: actual.length, firstAndWarmExecution: 'passed', interruptionAndRecovery: 'passed',
    kernelCleanup: 'passed', cliExitStatus: 'passed' })}\n`);
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
