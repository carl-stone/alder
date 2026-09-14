import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import {
  assertStrictReadyOutput,
  cleanupPartialOwner,
  cleanupScenarioResources,
  createHarness,
  createStrictReadyParser,
  loadWireCodec,
  openSession,
  query as canonicalQuery,
  releaseLease,
  requireAbsoluteRscript,
  sanitizedEnvironment,
  snapshot as fullSnapshot,
  spawnSmokeProcess,
  stopChild,
  waitForExecutionReady,
  waitForRegistry,
} from './_common.mjs';

async function resolveActualRExecutable(rscript, label) {
  assert.equal(typeof rscript, 'string', label + ' must report an Rscript path');
  const environment = { ...process.env };
  delete environment.R_HOME;
  const result = spawnSync(rscript, ['--vanilla', '-e', 'cat(R.home())'], {
    encoding: 'utf8',
    env: environment,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw new Error(label + ' RHOME failed: ' + result.error.message);
  assert.equal(result.status, 0, label + ' RHOME exited unsuccessfully: ' + String(result.stderr ?? ''));
  const rHome = String(result.stdout ?? '').trim();
  assert.equal(isAbsolute(rHome), true, label + ' RHOME must be absolute');
  const executable = join(await realpath(rHome), 'bin', 'exec', process.platform === 'win32' ? 'R.exe' : 'R');
  return realpath(executable);
}

/**
 * Exercise R selection through a staged launcher.  The selected executable is
 * always probed by the real host; the forwarding executable used below is only
 * a second, real Rscript path so that replacement can be observed without
 * requiring a second R installation on the smoke machine.
 */
export async function run(ctx) {
  const evidence = join(ctx.evidence, 'runtime-selection');
  await mkdir(evidence, { recursive: true });
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const selectedR = await requireAbsoluteRscript(ctx.rscript, 'runtime-selection Rscript');
  const selectedRExecutable = await resolveActualRExecutable(selectedR, 'selected Rscript');
  const alternateR = join(evidence, process.platform === 'win32' ? 'rscript-wrapper.cmd' : 'rscript-wrapper');
  await makeRWrapper(alternateR, selectedR);
  const alternateRExecutable = await resolveActualRExecutable(alternateR, 'alternate Rscript');

  const invalidR = join(evidence, process.platform === 'win32' ? 'not-r.cmd' : 'not-r');
  await makeNotR(invalidR);
  const missingR = join(evidence, 'does-not-exist-rscript');

  const invalidCases = {};
  for (const [name, rscript] of [['missing', missingR], ['nonR', invalidR]]) {
    const path = join(evidence, `${name}.R`);
    const launch = await startRaw(ctx, { id: `runtime-selection-${name}`, path, source: '# %%\n1 + 1\n', rscript });
    invalidCases[name] = await inspectInvalidLaunch(launch, name);
  }

  const hostilePath = join(evidence, 'hostile.R');
  const hostileHome = join(evidence, 'not-an-r-home');
  const hostile = await startRaw(ctx, {
    id: 'runtime-selection-hostile', path: hostilePath, source: '# %%\n1 + 1\n', rscript: selectedR,
    extraEnv: { R_HOME: hostileHome },
  });
  let hostileEvidence;
  try {
    assert.ok(hostile.ready, `hostile R_HOME must not prevent a valid explicit R: ${hostile.stderr}`);
    const snapshot = await waitForRuntimeResolution(hostile);
    assert.equal(await resolveActualRExecutable(snapshot.runtime.rEnvironment?.rscript, 'hostile runtime Rscript'), selectedRExecutable, 'hostile R_HOME must not change the selected R executable');
    assert.equal(snapshot.runtime.rEnvironment?.rHome === hostileHome, false, 'inherited R_HOME must not redirect explicit R');
    assert.equal(snapshot.runtime.executionReady, true, JSON.stringify(snapshot.runtime));
    hostileEvidence = {
      inheritedRHome: hostileHome,
      selectedR: snapshot.runtime.rEnvironment?.rscript,
      resolvedRHome: snapshot.runtime.rEnvironment?.rHome,
      identity: snapshot.runtime.rEnvironment?.identity,
    };
  } finally {
    await hostile.close();
  }

  const savedConfig = join(evidence, 'saved-default');
  await mkdir(join(savedConfig, 'config', 'alder'), { recursive: true });
  await writeFile(join(savedConfig, 'config', 'alder', 'settings.json'), '{"schemaVersion":1,"unexpected":true}\n');
  const saved = await startRaw(ctx, {
    id: 'runtime-selection-saved-default', path: join(evidence, 'saved-default.R'), source: '# %%\n1 + 1\n',
    rscript: selectedR,
    home: savedConfig,
    configHome: join(savedConfig, 'config'),
  });
  const savedEvidence = ctx.manifest.resources.electronEntry === null
    ? await inspectHeadlessSavedConfig(saved)
    : await inspectInvalidLaunch(saved, 'saved-default');

  const harness = await createHarness(ctx, {
    id: 'runtime-selection-main',
    source: '# %%\nx <- 1\n# %%\nx + 1\n',
    rscript: selectedR,
  });
  let second;
  try {
    const before = await waitForExecutionReady(harness);
    assert.ok(before.runtime.rEnvironment?.identity);
    assert.equal(await resolveActualRExecutable(before.runtime.rEnvironment?.rscript, 'selected runtime Rscript'), selectedRExecutable, 'initial runtime must use the selected R executable');
    assert.ok(Array.isArray(before.runtime.rEnvironment?.libraryPaths));
    assert.ok(before.runtime.rEnvironment.libraryPaths.length >= 2, 'selected runtime must expose helper and ordinary libraries');

    const edit = await harness.nextCommand({
      type: 'transaction', expectedDocumentRevision: before.documentRevision,
      changes: [{ type: 'edit', cell: { cellId: before.cells[0].id }, expectedRevision: before.cells[0].revision, body: ['x <- 2'], cellType: 'code' }],
    });
    const editOperation = await settle(harness, operationId(edit));
    assert.equal(editOperation.status, 'done');
    const dirtyBeforeSelect = await harness.snapshot();
    assert.equal(dirtyBeforeSelect.dirty, true);

    const selected = await harness.nextCommand({
      type: 'select-r', rscript: alternateR, persistDefault: false,
      expectedDocumentRevision: dirtyBeforeSelect.documentRevision,
    });
    const selectedOperation = await settle(harness, operationId(selected));
    assert.equal(selectedOperation.status, 'done', JSON.stringify(selectedOperation));
    const afterSelect = await harness.snapshot();
    assert.equal(afterSelect.documentRevision, dirtyBeforeSelect.documentRevision);
    assert.equal(afterSelect.dirty, true, 'R replacement must retain unsaved source');
    assert.equal(afterSelect.cells[0].body.join('\n'), 'x <- 2');
    assert.equal(await resolveActualRExecutable(afterSelect.runtime.rEnvironment?.rscript, 'alternate runtime Rscript'), alternateRExecutable, 'R replacement must use the alternate R executable');
    assert.notEqual(afterSelect.runtime.rEnvironment?.identity, before.runtime.rEnvironment?.identity, 'R replacement must retire the old environment identity');
    assert.notEqual(afterSelect.runtime.kernelEpoch, before.runtime.kernelEpoch, 'R replacement must retire old kernel values');
    assert.equal(afterSelect.runtime.analysisEnvironmentId === before.runtime.analysisEnvironmentId, false, 'R replacement must retire analysis values');
    assert.equal(afterSelect.runtime.executionReady, true);

    second = await openSession(harness.origin, harness.registry);
    const joined = await harness.snapshot();
    const joinedSecond = await secondSnapshot(harness, second);
    assert.equal(joinedSecond.documentRevision, joined.documentRevision);
    assert.equal(joinedSecond.dirty, true);
    assert.equal(joinedSecond.cells[0].body.join('\n'), 'x <- 2');

    const defaultBeforeFailure = afterSelect.runtime.rEnvironment?.identity;
    const failedSelection = await harness.nextCommand({
      type: 'select-r', rscript: missingR, persistDefault: false,
      expectedDocumentRevision: afterSelect.documentRevision,
    });
    const failedOperation = await settle(harness, operationId(failedSelection));
    assert.equal(failedOperation.status, 'error');
    assert.match(JSON.stringify(failedOperation.error ?? failedOperation), /r_not_found|r_invalid|not found|Rscript/i);
    const afterFailure = await harness.snapshot();
    assert.equal(afterFailure.runtime.rEnvironment?.identity, defaultBeforeFailure, 'failed replacement must retain selected R');
    assert.equal(afterFailure.cells[0].body.join('\n'), 'x <- 2');
    assert.equal(afterFailure.dirty, true);

    const longSource = ['# %%', 'Sys.sleep(2)', '99'].join('\n') + '\n';
    const longEdit = await harness.nextCommand({
      type: 'transaction', expectedDocumentRevision: afterFailure.documentRevision,
      changes: [{ type: 'edit', cell: { cellId: afterFailure.cells[0].id }, expectedRevision: afterFailure.cells[0].revision, body: longSource.split('\n').slice(1, -1), cellType: 'code' }],
    });
    assert.equal((await settle(harness, operationId(longEdit))).status, 'done');
    const longSnapshot = await harness.snapshot();
    const run = await harness.nextCommand({ type: 'run', scope: 'all', expectedDocumentRevision: longSnapshot.documentRevision });
    await waitForBusy(harness);
    const busySelect = await harness.nextCommand({
      type: 'select-r', rscript: alternateR, persistDefault: false,
      expectedDocumentRevision: longSnapshot.documentRevision,
    });
    const busyResult = await settle(harness, operationId(busySelect));
    assert.equal(busyResult.status, 'error');
    assert.match(JSON.stringify(busyResult.error ?? busyResult), /busy|operation|run|progress/i);
    const interrupt = await harness.nextCommand({ type: 'interrupt' });
    await settle(harness, operationId(interrupt));
    await settle(harness, operationId(run));

    const final = await harness.snapshot();
    assert.ok(final.runtime.rEnvironment?.identity);
    assert.equal(await resolveActualRExecutable(final.runtime.rEnvironment?.rscript, 'final runtime Rscript'), alternateRExecutable, 'failed R replacement must retain the alternate R executable');
    assert.ok(final.runtime.rEnvironment?.libraryPaths.length >= 2);
    return {
      id: 'runtime-selection',
      identity: {
        launcher,
        requestedRscript: { selected: selectedR, alternate: alternateR },
        actualRExecutable: { selected: selectedRExecutable, alternate: alternateRExecutable },
        selected: final.runtime.rEnvironment,
        analysisEnvironmentId: final.runtime.analysisEnvironmentId,
        kernelEpoch: final.runtime.kernelEpoch,
      },
      invalid: invalidCases,
      hostile: hostileEvidence,
      savedDefault: savedEvidence,
      replacement: {
        oldIdentity: before.runtime.rEnvironment?.identity,
        newIdentity: afterSelect.runtime.rEnvironment?.identity,
        sourceRetained: true,
        failedSelectionRetained: true,
      },
      busyRejected: true,
      evidence,
    };
  } finally {
    if (second) await releaseLease(harness.origin, second);
    await harness.close();
  }
}

async function inspectInvalidLaunch(launch, name) {
  if (launch.ready) {
    try {
      const value = await waitForRuntimeResolution(launch);
      assert.equal(value.runtime.executionReady, false, `${name} R selection must not fall back`);
      assert.equal(value.runtime.rEnvironment, null, `${name} must not expose a fallback R environment`);
      assert.match(JSON.stringify(value.runtime.executionBlockedReason ?? value.lastActionError ?? value), /r_not_found|r_invalid|not found|invalid|R/i);
      return { started: true, blocked: value.runtime.executionBlockedReason ?? value.lastActionError };
    } finally {
      await launch.close();
    }
  }
  assert.ok(launch.exit?.code !== 0 || launch.exit?.signal !== null, `${name} invalid R must fail nonzero`);
  assert.match(launch.stderr, /r_not_found|r_invalid|not found|invalid|Rscript|alder/i);
  return { started: false, exit: launch.exit, stderr: launch.stderr };
}

async function inspectHeadlessSavedConfig(launch) {
  try {
    const value = await waitForRuntimeResolution(launch);
    assert.equal(value.runtime.executionReady, true, 'headless startup must ignore desktop saved R settings');
    assert.ok(value.runtime.rEnvironment?.rscript, 'headless startup must still expose its PATH-selected R');
    return { started: true, ignoredInHeadless: true, selectedRscript: value.runtime.rEnvironment.rscript };
  } finally {
    await launch.close();
  }
}

async function waitForRuntimeResolution(launch, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await launch.snapshot();
    const runtime = value.runtime;
    if (runtime?.executionReady === true || runtime?.executionBlockedReason !== null && runtime?.executionBlockedReason !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('runtime_resolution_timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function startRaw(ctx, { id, path, source, rscript, extraEnv = {}, home, configHome } = {}) {
  const evidence = join(ctx.evidence, 'runtime-selection');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, source);
  const dataHome = join(evidence, id + '-data');
  const runtimeDirectory = join(dataHome, 'alder-nodejs', 'runtime');
  const actualHome = home ?? join(evidence, id + '-home');
  const actualConfig = configHome ?? join(actualHome, '.config');
  await mkdir(actualHome, { recursive: true });
  await mkdir(actualConfig, { recursive: true });
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(dataHome, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const cwd = join(evidence, 'cwd');
  await mkdir(cwd, { recursive: true });
  const env = sanitizedEnvironment({ HOME: actualHome, XDG_CONFIG_HOME: actualConfig, XDG_DATA_HOME: dataHome, ...extraEnv });
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const processObserverOptions = { supervisorExecutable: join(ctx.applicationRoot, ctx.manifest.resources.processSupervisorExecutable) };
  const args = [path, '--headless', '--no-run', '--port', '0'];
  assert.equal(typeof rscript, 'string', id + ' Rscript must be explicit');
  assert.equal(rscript.includes('/') || rscript.includes('\\'), true, id + ' Rscript must be absolute');
  args.push('--rscript', rscript);
  const child = spawnSmokeProcess(launcher, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const parser = createStrictReadyParser(child.stdout, { label: id });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 120_000;
  let result;
  while (parser.readyRecord === null && parser.error === null && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (parser.error !== null) {
    await stopChild(child).catch(() => undefined);
    result = { child, parser, stderr, exit: { code: child.exitCode, signal: child.signalCode }, protocolError: parser.error.message };
  } else if (parser.readyRecord !== null) {
    assertStrictReadyOutput(parser);
    result = { child, parser, ready: parser.readyRecord, stdout: parser.stdout, stderr };
  } else if (child.exitCode !== null || child.signalCode !== null) {
    await parser.done;
    assertStrictReadyOutput(parser, { requireReady: false });
    result = { child, parser, stdout: parser.stdout, stderr, exit: { code: child.exitCode, signal: child.signalCode } };
  } else {
    await stopChild(child).catch(() => undefined);
    await parser.done;
    assertStrictReadyOutput(parser, { requireReady: false });
    result = { child, parser, stdout: parser.stdout, stderr, exit: { code: child.exitCode, signal: child.signalCode } };
  }
  if (!result.ready) {
    await cleanupPartialOwner(null, runtimeDirectory, processObserverOptions);
    return result;
  }
  const canonical = await realpath(path);
  const registry = await waitForRegistry(canonical, runtimeDirectory, 120_000);
  const wire = await loadWireCodec(ctx.applicationRoot, ctx.manifest);
  const session = await openSession(result.ready.origin, registry);
  return {
    ...result,
    canonical,
    origin: result.ready.origin,
    registry,
    session,
    snapshot() { return fullSnapshot({ origin: this.origin, session: this.session, wire, query: value => canonicalQuery(this.origin, this.session, value, wire) }); },
    async close() {
      await cleanupScenarioResources(
        () => releaseLease(this.origin, this.session),
        () => stopChild(this.child),
        async () => { await this.parser.done; assertStrictReadyOutput(this.parser); },
        () => cleanupPartialOwner(this.canonical, runtimeDirectory, processObserverOptions),
      );
    },
  };
}



async function secondSnapshot(harness, session) {
  return fullSnapshot({
    origin: harness.origin,
    session,
    wire: harness.wire,
    query: value => canonicalQuery(harness.origin, session, value, harness.wire),
  });
}

async function settle(harness, operationId, timeout = 120_000) {
  assert.equal(typeof operationId, 'string');
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = snapshotOf(await harness.query({ type: 'operation', operationId, clientId: harness.session.clientId }));
    if (['done', 'error', 'interrupted', 'cancelled'].includes(value?.status)) return value;
    if (Date.now() >= deadline) throw new Error(`operation_timeout: ${operationId}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function waitForBusy(harness, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await harness.snapshot();
    if (value.runtime?.busy === true || value.runtime?.activeRunId !== null) return value;
    if (Date.now() >= deadline) throw new Error('run did not become busy');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function makeRWrapper(path, rscript) {
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${rscript.replaceAll('"', '""')}" %*\r\n`);
  } else {
    await writeFile(path, `#!/bin/sh\nexec "${rscript.replaceAll('"', '\\"')}" "$@"\n`);
    await chmod(path, 0o755);
  }
}

async function makeNotR(path) {
  if (process.platform === 'win32') {
    await writeFile(path, '@echo off\r\necho not-r 1>&2\r\nexit /b 0\r\n');
  } else {
    await writeFile(path, '#!/bin/sh\nprintf not-r >&2\nexit 0\n');
    await chmod(path, 0o755);
  }
}

function operationId(admission) { return admission.operationId ?? admission.operation?.id; }
function snapshotOf(value) { return value?.result ?? value; }
