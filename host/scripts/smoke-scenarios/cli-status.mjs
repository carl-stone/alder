import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertStrictReadyOutput,
  cleanupPartialOwner,
  cleanupScenarioResources,
  createHarness,
  createStrictReadyParser,
  openSession,
  query,
  releaseLease,
  requireAbsoluteRscript,
  sanitizedEnvironment,
  spawnSmokeProcess,
  snapshot as fullSnapshot,
  spawnSmokeSync,
  signalSmokeProcessGroup,
  stopChild,
  waitForExecutionReady,
  fetchLogicalOrigin,
} from './_common.mjs';

/**
 * Exercise the packaged command line boundary and the authenticated host
 * protocol.  This intentionally does not import the TypeScript host: every
 * document assertion comes from the staged launcher and its HTTP API.
 */
export async function run(ctx) {
  const evidence = join(ctx.evidence, 'cli-status');
  await mkdir(evidence, { recursive: true });
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const cwd = join(evidence, 'unrelated-cwd');
  await mkdir(cwd, { recursive: true });
  const env = sanitizedEnvironment({
    HOME: join(evidence, 'home'),
    XDG_CONFIG_HOME: join(evidence, 'config'),
    XDG_DATA_HOME: join(evidence, 'data'),
  });
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  await mkdir(env.XDG_DATA_HOME, { recursive: true });
  const cli = {
    launcher,
    cwd,
    env,
    runtimeDirectory: join(env.XDG_DATA_HOME, 'alder-nodejs', 'runtime'),
    processObserverOptions: { supervisorExecutable: join(ctx.applicationRoot, ctx.manifest.resources.processSupervisorExecutable) },
  };

  const documentFree = {};
  for (const [name, args] of [['help', ['--help']], ['version', ['--version']], ['hostInfo', ['--host-info']]]) {
    const result = runSync(launcher, args, { cwd, env });
    await writeFile(join(evidence, `${name}.stdout`), result.stdout);
    await writeFile(join(evidence, `${name}.stderr`), result.stderr);
    assert.equal(result.error, undefined, `${name} launcher failed to start`);
    assert.equal(result.status, 0, `${name} must exit successfully`);
    assert.equal(result.signal, null, `${name} must not be signalled`);
    assert.equal(result.stdout.includes('host.ready'), false, `${name} must not start a host`);
    if (name === 'hostInfo') {
      const info = JSON.parse(result.stdout);
      assert.equal(info.protocol, 'alder-host-v2', 'host-info must report the canonical host protocol');
      assert.equal(info.engineProtocol, 'alder-engine-v2', 'host-info must report the canonical engine protocol');
      assert.equal(typeof info.hostVersion, 'string');
      assert.equal(typeof info.packageVersion, 'string');
      documentFree.hostInfo = info;
    } else {
      if (name === 'version') {
        assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'version output must be semantic version');
      } else {
        assert.match(result.stdout, /Alder|alder|Usage|usage|version/i, name + ' output is not human-readable');
      }
      documentFree[name] = result.stdout.trim();
    }
  }

  const invalid = runSync(launcher, ['--definitely-not-an-alder-option'], { cwd, env });
  await writeFile(join(evidence, 'invalid-flag.stdout'), invalid.stdout);
  await writeFile(join(evidence, 'invalid-flag.stderr'), invalid.stderr);
  assert.equal(invalid.status === 0, false, 'an unknown CLI option must fail');
  assert.equal(invalid.signal, null);
  assert.equal(invalid.stdout.includes('host.ready'), false, 'invalid CLI must not start a host');
  assert.match(invalid.stderr, /option|argument|unknown|invalid|usage|alder/i);

  const pathCases = await pathStatusCases(cli, evidence);
  const commandCases = await commandStatusCases(ctx, cli, evidence);

  const harness = await createHarness(ctx, {
    id: 'cli-status-protocol',
    source: '# %%\nx <- 1\n# %%\nx + 1\n',
  });
  let joined;
  try {
    const second = await openSession(harness.origin, harness.registry);
    joined = second;

    const first = await harness.snapshot();
    assert.equal(first.path, harness.canonical);
    assert.equal(first.dirty, false);
    assert.equal(first.disk.state, 'present');
    assert.equal(first.documentRevision, 0);
    assert.equal(first.cells.length, 2);

    const cell = first.cells[0];
    const editAdmission = await harness.nextCommand({
      type: 'transaction',
      expectedDocumentRevision: first.documentRevision,
      changes: [{
        type: 'edit', cell: { cellId: cell.id }, expectedRevision: cell.revision,
        body: ['x <- 2'], cellType: 'code',
      }],
    });
    const editOperation = await settle(harness, editAdmission.operationId ?? editAdmission.operation?.id);
    assert.equal(editOperation.status, 'done');
    const dirty = await harness.snapshot();
    assert.equal(dirty.documentRevision, first.documentRevision + 1);
    assert.equal(dirty.dirty, true);
    assert.deepEqual(dirty.disk, first.disk, 'an unsaved edit must not change disk observation');

    const joinedDirty = await snapshotSession(harness.origin, second, harness.wire);
    assert.equal(joinedDirty.documentRevision, dirty.documentRevision);
    assert.equal(joinedDirty.dirty, true);
    assert.equal(joinedDirty.cells[0].body.join('\n'), 'x <- 2');
    assert.deepEqual(joinedDirty.disk, dirty.disk);

    const saveAdmission = await harness.nextCommand({
      type: 'save', expectedDocumentRevision: dirty.documentRevision,
    });
    const saveOperation = await settle(harness, saveAdmission.operationId ?? saveAdmission.operation?.id);
    assert.equal(saveOperation.status, 'done');
    const saved = await harness.snapshot();
    assert.equal(saved.dirty, false);
    assert.notEqual(saved.disk.digest, first.disk.digest, 'save must publish new source bytes');
    assert.match(await readFile(harness.notebook, 'utf8'), /x <- 2/);
    const joinedSaved = await snapshotSession(harness.origin, second, harness.wire);
    assert.equal(joinedSaved.dirty, false);
    assert.equal(joinedSaved.disk.digest, saved.disk.digest);

    const busyHarness = await createHarness(ctx, {
      id: 'cli-status-busy',
      source: '# %%\nSys.sleep(2)\n42\n',
    });
    await waitForExecutionReady(busyHarness);
    let busySecond;
    try {
      busySecond = await openSession(busyHarness.origin, busyHarness.registry);
      const beforeRun = await busyHarness.snapshot();
      const runAdmission = await busyHarness.nextCommand({
        type: 'run', scope: 'all', expectedDocumentRevision: beforeRun.documentRevision,
      });
      const busy = await waitForRuntime(busyHarness, value => value.runtime?.busy === true || value.runtime?.activeRunId !== null);
      assert.equal(busy, true, 'a long run must expose busy runtime state');
      const secondRunAdmission = await sendCommand(busyHarness.origin, busySecond, {
        type: 'run', scope: 'all', expectedDocumentRevision: beforeRun.documentRevision,
      });
      const secondRun = await settle(busyHarness, secondRunAdmission.operationId ?? secondRunAdmission.operation?.id, 30_000, busySecond);
      assert.ok(['error', 'cancelled'].includes(secondRun.status), 'a concurrent run must be rejected');
      assert.match(JSON.stringify(secondRun.error ?? secondRun), /busy|operation|run|progress/i);
      const interruptAdmission = await busyHarness.nextCommand({ type: 'interrupt' });
      const interrupt = await settle(busyHarness, interruptAdmission.operationId ?? interruptAdmission.operation?.id);
      assert.ok(['done', 'cancelled', 'error'].includes(interrupt.status));
      const run = await settle(busyHarness, runAdmission.operationId ?? runAdmission.operation?.id);
      assert.ok(['interrupted', 'cancelled', 'error', 'done'].includes(run.status));
    } finally {
      if (busySecond) await releaseLease(busyHarness.origin, busySecond);
      await busyHarness.close();
    }
  } finally {
    if (joined) await releaseLease(harness.origin, joined);
    await harness.close();
  }

  return {
    id: 'cli-status',
    identity: {
      launcher,
      hostProtocol: documentFree.hostInfo.protocol,
      cli: ['--help', '--version', '--host-info'],
      authenticatedOrigin: harness.origin,
      epoch: harness.registry.epoch,
    },
    documentFree,
    paths: pathCases,
    commands: commandCases,
    joined: { documentRevision: 1, dirtyBeforeSave: true, dirtyAfterSave: false },
    busyRun: true,
    evidence,
  };
}

async function pathStatusCases(cli, evidence) {
  const cases = {};
  const existing = join(evidence, 'existing.R');
  await writeFile(existing, '# %%\n1 + 1\n');
  cases.existing = await startAndStop(cli, [existing, '--headless', '--no-run', '--port', '0'], 'existing');

  const created = join(evidence, 'new.R');
  cases.new = await startAndStop(cli, [created, '--headless', '--no-run', '--port', '0'], 'new');
  assert.equal(await isFile(created), false, 'new notebook must not be created before Save');

  cases.untitled = await startAndStop(cli, ['--headless', '--no-run', '--port', '0'], 'untitled');

  const directory = join(evidence, "directory");
  await mkdir(directory, { recursive: true });
  cases.directory = await startAndStop(cli, [directory, "--headless", "--no-run", "--port", "0"], "directory", { expectFailure: true });
  assert.equal(cases.directory.started, false, "a directory input must be rejected");

  const wrongExtension = join(evidence, 'wrong.txt');
  await writeFile(wrongExtension, '# %%\n1 + 1\n');
  cases.wrongExtension = await startAndStop(cli, [wrongExtension, '--headless', '--no-run', '--port', '0'], 'wrong-extension');
  assert.equal(cases.wrongExtension.started, true, 'the host accepts notebook paths independent of filename extension');
  assert.equal(await readFile(wrongExtension, 'utf8'), '# %%\n1 + 1\n');

  const missingParent = join(evidence, 'missing-parent', 'missing.R');
  cases.missingParent = await startAndStop(cli, [missingParent, '--headless', '--no-run', '--port', '0'], 'missing-parent', { expectFailure: true });
  assert.equal(cases.missingParent.started, false);
  assert.equal(await isDirectory(join(evidence, 'missing-parent')), false, 'missing parent must not be created as a side effect');
  return cases;
}

async function commandStatusCases(ctx, cli, evidence) {
  const selectedR = await requireAbsoluteRscript(ctx.rscript, 'cli-status Rscript');
  const cases = {};

  const commandHarness = await createHarness(ctx, {
    id: 'cli-status-commands',
    source: '# %%\n1 + 1\n',
    rscript: selectedR,
  });
  try {
    await waitForExecutionReady(commandHarness);
    const commandCli = await scopedCli(cli, commandHarness, evidence, 'commands');
    const checkResult = await runAsync(commandCli.launcher, ['check', commandHarness.notebook, '--rscript', selectedR], {
      cwd: commandCli.cwd, env: commandCli.env, timeout: 120_000,
    });
    await writeCliResult(evidence, 'check-success', checkResult);
    assertCliExit(checkResult, 0, 'check success');
    const checkPayload = parseCliJson(checkResult, 'check success');
    assert.equal(checkPayload.error, null);
    assert.equal(checkPayload.operation, null);
    assert.ok(Array.isArray(checkPayload.result?.issues));
    assert.equal(checkPayload.result.issues.length, 0, 'a valid notebook check must have no blocking issues');
    cases.check = { success: { status: checkResult.status, issues: checkPayload.result.issues.length } };

    const runResult = await runAsync(commandCli.launcher, ['run', commandHarness.notebook, '--rscript', selectedR], {
      cwd: commandCli.cwd, env: commandCli.env, timeout: 120_000,
    });
    await writeCliResult(evidence, 'run-success', runResult);
    assertCliExit(runResult, 0, 'run success');
    const runPayload = parseCliJson(runResult, 'run success');
    assert.equal(runPayload.error, null);
    assert.equal(runPayload.operation?.status, 'done');
    cases.run = { success: { status: runResult.status, operation: runPayload.operation.status } };

    const published = join(evidence, 'cli-status-published.html');
    const publishResult = await runAsync(commandCli.launcher, [
      'publish', commandHarness.notebook, '--output', published, '--rscript', selectedR,
    ], { cwd: commandCli.cwd, env: commandCli.env, timeout: 120_000 });
    await writeCliResult(evidence, 'publish-success', publishResult);
    assertCliExit(publishResult, 0, 'publish success');
    const publishPayload = parseCliJson(publishResult, 'publish success');
    assert.equal(publishPayload.error, null);
    assert.equal(publishPayload.operation?.status, 'done');
    assert.equal(await isFile(published), true, 'publish must create the requested HTML artifact');
    cases.publish = { success: { status: publishResult.status, operation: publishPayload.operation.status, output: published } };

    await writeFile(published, 'destination sentinel\n');
    const publishFailure = await runAsync(commandCli.launcher, [
      'publish', commandHarness.notebook, '--output', published, '--rscript', selectedR,
    ], { cwd: commandCli.cwd, env: commandCli.env, timeout: 120_000 });
    await writeCliResult(evidence, 'publish-failure', publishFailure);
    assertCliExit(publishFailure, 1, 'publish failure');
    const publishFailurePayload = parseCliJson(publishFailure, 'publish failure');
    assert.notEqual(publishFailurePayload.error, null);
    assert.match(JSON.stringify(publishFailurePayload.error), /destination|exist|output/i);
    assert.equal(await readFile(published, 'utf8'), 'destination sentinel\n', 'failed publish must preserve an existing destination');
    cases.publish.failure = { status: publishFailure.status, error: publishFailurePayload.error?.code ?? null };
  } finally {
    await commandHarness.close();
  }

  const checkFailureHarness = await createHarness(ctx, {
    id: 'cli-status-check-failure',
    source: '# %%\nleft <- right\n# %%\nright <- left\n',
    rscript: selectedR,
  });
  try {
    const analyzed = await waitForRuntime(checkFailureHarness, value => (value.graph?.cycles?.length ?? 0) > 0, 30_000);
    assert.equal(analyzed, true, 'check failure fixture must expose a dependency cycle');
    const checkCli = await scopedCli(cli, checkFailureHarness, evidence, 'check-failure');
    const checkFailure = await runAsync(checkCli.launcher, ['check', checkFailureHarness.notebook, '--rscript', selectedR], {
      cwd: checkCli.cwd, env: checkCli.env, timeout: 120_000,
    });
    await writeCliResult(evidence, 'check-failure', checkFailure);
    assertCliExit(checkFailure, 1, 'check failure');
    const checkFailurePayload = parseCliJson(checkFailure, 'check failure');
    assert.equal(checkFailurePayload.error, null);
    assert.ok(checkFailurePayload.result?.issues?.length > 0);
    cases.check.failure = { status: checkFailure.status, issues: checkFailurePayload.result.issues.length };
  } finally {
    await checkFailureHarness.close();
  }

  const runFailureHarness = await createHarness(ctx, {
    id: 'cli-status-run-failure',
    source: '# %%\nstop(\"cli-status failure\")\n',
    rscript: selectedR,
  });
  try {
    await waitForExecutionReady(runFailureHarness);
    const failureCli = await scopedCli(cli, runFailureHarness, evidence, 'run-failure');
    const runFailure = await runAsync(failureCli.launcher, ['run', runFailureHarness.notebook, '--rscript', selectedR], {
      cwd: failureCli.cwd, env: failureCli.env, timeout: 120_000,
    });
    await writeCliResult(evidence, 'run-failure', runFailure);
    assertCliExit(runFailure, 1, 'run failure');
    const runFailurePayload = parseCliJson(runFailure, 'run failure');
    assert.notEqual(runFailurePayload.error, null);
    assert.ok(['error', 'cancelled'].includes(runFailurePayload.operation?.status) || runFailurePayload.error !== null);
    cases.run.failure = { status: runFailure.status, operation: runFailurePayload.operation?.status ?? null, error: runFailurePayload.error?.code ?? null };
  } finally {
    await runFailureHarness.close();
  }

  const usage = runSync(cli.launcher, ['run'], { cwd: cli.cwd, env: cli.env, timeout: 20_000 });
  await writeCliResult(evidence, 'usage-failure', usage);
  assertCliExit(usage, 2, 'usage failure');
  assert.match(usage.stderr, /requires NOTEBOOK\.R|usage|argument/i);
  cases.usage = { status: usage.status };

  const interruptHarness = await createHarness(ctx, {
    id: 'cli-status-interrupt',
    source: '# %%\nSys.sleep(30)\n42\n',
    rscript: selectedR,
  });
  let interruptProcess;
  try {
    await waitForExecutionReady(interruptHarness);
    const interruptCli = await scopedCli(cli, interruptHarness, evidence, 'interrupt');
    interruptProcess = spawnCli(interruptCli.launcher, ['run', interruptHarness.notebook, '--rscript', selectedR], {
      cwd: interruptCli.cwd, env: interruptCli.env,
    });
    const busy = await waitForRuntime(interruptHarness, value => value.runtime?.busy === true || value.runtime?.activeRunId !== null, 30_000);
    assert.equal(busy, true, 'CLI run must expose busy runtime state before interrupt');
    const interruptAdmission = await interruptHarness.nextCommand({ type: 'interrupt' });
    const interrupt = await settle(interruptHarness, interruptAdmission.operationId ?? interruptAdmission.operation?.id);
    assert.ok(['done', 'cancelled', 'error'].includes(interrupt.status));
    const interruptResult = await interruptProcess.exited;
    await writeCliResult(evidence, 'interrupt-130', interruptResult);
    assert.equal(interruptResult.error, undefined, 'interrupt CLI must start successfully');
    assert.equal(interruptResult.status, 130, 'an interrupted CLI run must exit 130');
    assert.equal(interruptResult.signal, null, 'an interrupted CLI run must settle normally');
    const interruptPayload = parseCliJson(interruptResult, 'interrupt');
    assert.equal(interruptPayload.operation?.status, 'cancelled');
    assert.equal(interruptPayload.error?.code, 'interrupted');
    cases.interrupt = { status: interruptResult.status, operation: interruptPayload.operation.status };
  } finally {
    await cleanupScenarioResources(
      () => interruptProcess ? stopChild(interruptProcess.child) : undefined,
      () => interruptHarness.close(),
    );
  }

  return cases;
}

async function scopedCli(cli, harness, evidence, name) {
  const home = join(evidence, 'command-home', name);
  const config = join(evidence, 'command-config', name);
  await mkdir(home, { recursive: true });
  await mkdir(config, { recursive: true });
  return {
    launcher: cli.launcher,
    cwd: cli.cwd,
    env: sanitizedEnvironment({ HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: harness.dataHome }),
  };
}

async function writeCliResult(evidence, name, result) {
  await Promise.all([
    writeFile(join(evidence, name + '.stdout'), result.stdout ?? ''),
    writeFile(join(evidence, name + '.stderr'), result.stderr ?? ''),
  ]);
}

function assertCliExit(result, status, name) {
  assert.equal(result.error, undefined, name + ' launcher failed to start');
  assert.equal(result.status, status, name + ' must exit ' + status);
  assert.equal(result.signal, null, name + ' must not be signalled');
  assert.equal((result.stdout ?? '').includes('host.ready'), false, name + ' must not expose host.ready on stdout');
}

function parseCliJson(result, name) {
  const lines = String(result.stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1, name + ' must emit exactly one JSON result record');
  try { return JSON.parse(lines[0]); } catch (error) { throw new Error(name + ' emitted invalid JSON: ' + (error instanceof Error ? error.message : String(error)) + '\n' + result.stdout); }
}

async function runAsync(launcher, args, options) {
  const { timeout = 120_000, ...spawnOptions } = options;
  const running = spawnCli(launcher, args, spawnOptions);
  const timer = setTimeout(() => {
    if (running.child.exitCode === null && running.child.signalCode === null) signalSmokeProcessGroup(running.child.pid, 'SIGKILL');
  }, timeout);
  timer.unref();
  try {
    return await running.exited;
  } finally {
    clearTimeout(timer);
  }
}
function spawnCli(launcher, args, options) {
  const child = spawnSmokeProcess(launcher, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  let error;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', cause => { error = cause; });
  const exited = new Promise(resolve => child.once('close', (status, signal) => resolve({ error, status, signal, stdout, stderr })));
  return { child, exited };
}


async function startAndStop(cli, args, name, { expectFailure = false } = {}) {
  try {
    const result = await launch(cli.launcher, args, cli);
    if (result.ready) {
      if (expectFailure) {
        await stop(result.child, result.parser);
        throw new Error(name + ' unexpectedly started a host');
      }
      await stop(result.child, result.parser);
      return { started: true, ready: result.ready };
    }
    await result.parser.done;
    assertStrictReadyOutput(result.parser, { requireReady: false });
    if (!expectFailure) throw new Error(name + ' failed before host.ready: ' + result.stderr);
    assert.notEqual(result.exit?.signal, 'timeout', name + ' must not be accepted after a launch timeout');
    assert.ok((Number.isInteger(result.exit?.code) && result.exit.code !== 0) || (typeof result.exit?.signal === 'string' && result.exit.signal !== 'timeout'), name + ' must fail with a non-zero status');
    return { started: false, exit: result.exit, stderr: result.stderr };
  } finally {
    await cleanupPartialOwner(null, cli.runtimeDirectory, cli.processObserverOptions);
  }
}

async function launch(launcher, args, { cwd, env }, timeout = 20_000) {
  const child = spawnSmokeProcess(launcher, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const parser = createStrictReadyParser(child.stdout, { label: 'cli-' + (args[0] ?? 'start') });
  let stderr = '';
  let settled = false;
  let timer;
  const outcome = await new Promise(resolve => {
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    parser.ready.then(ready => finish({ ready, child, parser, stdout: parser.stdout, stderr }));
    parser.done.then(() => {
      if (parser.error !== null && !settled) finish({ child, parser, stdout: parser.stdout, stderr, error: parser.error, exit: { code: child.exitCode, signal: child.signalCode } });
      else if (!settled && (child.exitCode !== null || child.signalCode !== null)) finish({ child, parser, stdout: parser.stdout, stderr, exit: { code: child.exitCode, signal: child.signalCode } });
    });
    child.once('exit', (code, signal) => parser.done.then(() => finish({ child, parser, stdout: parser.stdout, stderr, error: parser.error, exit: { code, signal } })));
    timer = setTimeout(() => {
      finish({ child, parser, stdout: parser.stdout, stderr, exit: { code: child.exitCode, signal: 'timeout' } });
      if (child.exitCode === null && child.signalCode === null) signalSmokeProcessGroup(child.pid, 'SIGKILL');
    }, timeout);
  });
  return { ...outcome, parser };
}
async function stop(child, parser) {
  await stopChild(child);
  await parser.done;
  assertStrictReadyOutput(parser, { requireReady: true });
}
function runSync(launcher, args, options) {
  const { timeout = 20_000, ...spawnOptions } = options;
  return spawnSmokeSync(launcher, args, { ...spawnOptions, encoding: 'utf8', timeout, windowsHide: true });
}

async function sendCommand(origin, session, value) {
  const command = {
    ...value,
    operationId: value.operationId ?? randomUUID(),
    clientId: session.clientId,
    commandSequence: session.nextCommandSequence++,
    sessionEpoch: session.epoch,
  };
  return (await fetchJson(origin, '/api/command', command, session));
}

async function fetchJson(origin, path, body, session) {
  const response = await fetchLogicalOrigin(new URL(path, origin), {
    method: 'POST',
    redirect: 'error',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const value = bytes.length ? JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function settle(harness, operationId, timeout = 30_000, session = harness.session) {
  assert.equal(typeof operationId, 'string', 'command must return an operation id');
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = snapshotOf(await query(harness.origin, session, { type: 'operation', operationId, clientId: session.clientId }, harness.wire));
    if (['done', 'error', 'interrupted', 'cancelled'].includes(value?.status)) return value;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function waitForRuntime(harness, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await harness.snapshot();
    if (predicate(value)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function snapshotSession(origin, session, wire) {
  return fullSnapshot({ origin, session, wire, query: value => query(origin, session, value, wire) });
}

function snapshotOf(value) { return value?.result ?? value; }
async function isFile(path) { return stat(path).then(info => info.isFile()).catch(() => false); }
async function isDirectory(path) { return stat(path).then(info => info.isDirectory()).catch(() => false); }
