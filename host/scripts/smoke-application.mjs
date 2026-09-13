import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHarness, spawnSmokeSync, waitForExecutionReady } from './smoke-scenarios/_common.mjs';
import { captureProcessTree, configureProcessObserver } from './smoke-scenarios/process-observer.mjs';
import { openInteractiveBrowser } from '../test-support/live-browser.mjs';

const SCENARIO_WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000;
const SCENARIOS = Object.freeze([
  ['launch-slice', ['artifact', 'UI', 'runtime', 'unavailable-R edit/save']],
  ['cli-status', ['artifact', 'runtime', 'argv/exit/stdout']],
  ['runtime-selection', ['artifact', 'both R identities', 'runtime']],
  ['codec-bytes', ['source', 'byte fixtures']],
  ['transaction', ['source', 'artifact', 'runtime']],
  ['durable-recovery', ['source', 'artifact', 'runtime', 'byte/log identity']],
  ['disk-conflicts', ['artifact', 'disk observations']],
  ['save-as', ['artifact', 'UI', 'runtime', 'disk']],
  ['configuration', ['source', 'artifact', 'byte fixtures']],
  ['sequence-replay', ['source', 'artifact', 'runtime']],
  ['protocol-bounds', ['source', 'artifact', 'packet/identity assertions']],
  ['large-source-output', ['artifact', 'runtime', 'bounds']],
  ['event-recovery', ['source', 'artifact', 'UI/runtime']],
  ['analysis', ['source', 'artifact', 'analyzer/R identity']],
  ['r-semantics', ['source', 'artifact', 'runtime']],
  ['ark-publisher', ['native build/source/patch/toolchain', 'artifact/runtime']],
  ['rich-outputs', ['artifact', 'UI', 'runtime', 'R fixture-library identity']],
  ['inline-sanitizer', ['source', 'artifact', 'UI']],
  ['sandbox-artifacts', ['artifact', 'UI', 'request assertions']],
  ['format-packages', ['artifact', 'Air/R/package-lock identities']],
  ['publish', ['artifact', 'Quarto/version', 'HTML/fixture digests']],
  ['session-races', ['source', 'artifact', 'PID/start/epoch sets']],
  ['mcp-couse', ['artifact', 'SDK/schema', 'runtime']],
  ['mcp-catalog', ['artifact', 'SDK/schema/operation identities']],
  ['authentication', ['artifact', 'sanitized HTTP/WS assertions']],
  ['tickets-secrets', ['artifact', 'UI', 'in-memory secret scan results']],
  ['remote-https', ['artifact', 'TLS/proxy', 'UI/runtime']],
  ['resource-integrity', ['archive/install/manifest/verifier/native identities']],
  ['browser-editing', ['artifact', 'browser/UI', 'runtime']],
  ['renderer-recovery', ['artifact', 'UI', 'runtime']],
  ['desktop-lifecycle', ['native artifact', 'screenshot/AX', 'actual Electron identity']],
  ['desktop-security', ['native artifact', 'screenshot/AX/CDP security evidence']],
  ['native-r-matrix', ['native artifact', 'both R/probe records']],
  ['interrupt-native', ['native artifact', 'runtime/PID/start identity']],
  ['process-lifecycle', ['native artifact', 'OS process snapshots']],
  ['distribution', ['native installed/archive/signature identities']],
  ['helper-artifact', ['helper source/install/R identity']],
  ['bundle-removal', ['source', 'rebuilt/shipped bundle and removal evidence']],
  ['performance', ['machine/power/container', 'all runtime/driver/artifact/baseline hashes']],
].map(([id, identity]) => Object.freeze({ id, identity: Object.freeze(identity) })));
const MATRIX_IDS = new Set(SCENARIOS.map(scenario => scenario.id));
const MANIFEST_RESOURCES = Object.freeze([
  ['cliLauncher', 'file'],
  ['hostEntry', 'file'],
  ['rendererDirectory', 'directory'],
  ['workerDirectory', 'directory'],
  ['rLibraryDirectory', 'directory'],
  ['arkExecutable', 'file'],
  ['airExecutable', 'file'],
  ['nodeExecutable', 'file'],
  ['processSupervisorExecutable', 'file'],
  ['electronEntry', 'file', true],
]);
const { values, positionals } = parseArgs({
  options: {
    evidence: { type: 'string' },
    rscript: { type: 'string' },
    'peer-rscript': { type: 'string' },
    'qualification-source': { type: 'string' },
    'trusted-keyring': { type: 'string' },
    'trusted-fingerprint': { type: 'string' },
    'expected-artifact-sha256': { type: 'string', multiple: true },
    'signature-file': { type: 'string', multiple: true },
    scenario: { type: 'string' },
    list: { type: 'boolean' },
  },
  allowPositionals: true,
});

if (values.list) {
  process.stdout.write(JSON.stringify(SCENARIOS) + '\n');
} else {
  await main();
}

async function main() {
  for (const option of ['trusted-keyring', 'signature-file']) {
    if (values[option] !== undefined && (typeof values[option] !== 'string' && !Array.isArray(values[option]))) throw new Error('--' + option + ' must be an absolute path');
    for (const value of (Array.isArray(values[option]) ? values[option] : values[option] === undefined ? [] : [values[option]])) {
      if (!isAbsolute(value)) throw new Error('--' + option + ' must be an absolute path');
    }
  }
  if (values['trusted-fingerprint'] !== undefined && typeof values['trusted-fingerprint'] !== 'string') throw new Error('--trusted-fingerprint must be a fingerprint');
  for (const value of (values['expected-artifact-sha256'] ?? [])) if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('--expected-artifact-sha256 must be a SHA-256 digest');
  if (typeof values.rscript !== 'string' || !isAbsolute(values.rscript)) throw new Error('--rscript must be supplied as an absolute executable path');
  if (values['peer-rscript'] !== undefined && (typeof values['peer-rscript'] !== 'string' || !isAbsolute(values['peer-rscript']))) throw new Error('--peer-rscript must be an absolute executable path');
  if (typeof values['qualification-source'] !== 'undefined' && (typeof values['qualification-source'] !== 'string' || !isAbsolute(values['qualification-source']))) throw new Error('--qualification-source must be an absolute frozen source path');
  const qualificationSource = values['qualification-source'] === undefined ? undefined : resolve(values['qualification-source']);
  const application = resolve(positionals[0] ?? 'host/.application');
  const requested = values.scenario ?? 'launch-slice';
  if (requested !== 'all' && !MATRIX_IDS.has(requested)) {
    throw new Error('Unknown smoke scenario ' + requested);
  }

  const manifestPath = await findManifest(application);
  const applicationRoot = dirname(dirname(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const verifiedResources = await verifyManifest(applicationRoot, manifest, manifestPath);

  const bundledNode = verifiedResources.nodeExecutable;
  const currentNode = await realpath(process.execPath);
  if (!process.env.ALDER_SMOKE_REEXEC && currentNode !== bundledNode) {
    const args = [
      fileURLToPath(import.meta.url),
      ...(values['trusted-keyring'] === undefined ? [] : ['--trusted-keyring', values['trusted-keyring']]),
      ...(values['trusted-fingerprint'] === undefined ? [] : ['--trusted-fingerprint', values['trusted-fingerprint']]),
      ...((values['expected-artifact-sha256'] ?? []).flatMap(value => ['--expected-artifact-sha256', value])),
      ...((values['signature-file'] ?? []).flatMap(value => ['--signature-file', value])),
      application,
      '--scenario', requested,
      ...(values.evidence === undefined ? [] : ['--evidence', values.evidence]),
      ...(values.rscript === undefined ? [] : ['--rscript', values.rscript]),
      ...(values['peer-rscript'] === undefined ? [] : ['--peer-rscript', values['peer-rscript']]),
      ...(qualificationSource === undefined ? [] : ['--qualification-source', qualificationSource]),
    ];
    const child = spawnSmokeSync(bundledNode, args, {
      cwd: process.cwd(),
      env: { ...process.env, ALDER_SMOKE_REEXEC: '1' },
      stdio: 'inherit',
      timeout: 10_800_000,
      windowsHide: true,
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  configureProcessObserver(verifiedResources.processSupervisorExecutable);

  const evidenceWasExplicit = values.evidence !== undefined;
  const evidence = resolve(values.evidence ?? await mkdtemp(join(tmpdir(), 'alder-application-smoke-' + process.pid + '-')));
  await mkdir(evidence, { recursive: true });
  if (evidenceWasExplicit && (await readdir(evidence)).length !== 0) {
    throw new Error('evidence_directory_must_be_empty');
  }
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const runAll = requested === 'all';
  const selected = runAll ? SCENARIOS : SCENARIOS.filter(scenario => scenario.id === requested);
  const results = [];
  const notApplicable = [];
  const blocked = [];
  const failed = [];

  for (const scenario of selected) {
    const scenarioEvidence = runAll ? join(evidence, 'scenarios', scenario.id) : evidence;
    await mkdir(scenarioEvidence, { recursive: true });
    const applicability = runAll ? scenarioApplicability(scenario, manifest) : null;
    if (applicability !== null) {
      const record = {
        id: scenario.id,
        status: 'NOT_APPLICABLE',
        reason: applicability,
        evidence: relative(evidence, scenarioEvidence).split(sep).join('/'),
      };
      results.push(record);
      notApplicable.push(record);
      await writeScenarioStatus(scenarioEvidence, record);
      continue;
    }

    try {
      let result;
      if (scenario.id === 'launch-slice') {
        result = await runScenarioWithWatchdog(scenario.id, () => runLaunchSlice({
          applicationRoot,
          manifest,
          evidence: scenarioEvidence,
          rscript: values.rscript,
          peerRscript: values['peer-rscript'],
        }));
      } else {
        const module = await loadScenarioModule(scenario.id);
        if (module === null || typeof module.run !== 'function') {
          const unavailable = new Error('scenario_unavailable: ' + scenario.id + ' requires its behavior owner smoke module');
          unavailable.code = 'scenario_unavailable';
          throw unavailable;
        }
        result = await runScenarioWithWatchdog(scenario.id, () => module.run({
          applicationRoot,
          manifest,
          evidence: scenarioEvidence,
          trustedKeyring: values['trusted-keyring'],
          trustedFingerprint: values['trusted-fingerprint'],
          expectedArtifactSha256: values['expected-artifact-sha256'],
          signatureFile: values['signature-file'],
          qualificationRoot: qualificationSource === undefined ? undefined : dirname(qualificationSource),
          rscript: values.rscript,
          peerRscript: values['peer-rscript'],
          sourceRoot: qualificationSource,
          matrix: scenario,
        }));
      }
      if (!result || result.id !== scenario.id || result.identity === undefined) {
        throw new Error('scenario_invalid_result: ' + scenario.id + ' must return its id and evidence identity');
      }
      const record = runAll
        ? { ...result, status: 'PASSED', evidence: relative(evidence, scenarioEvidence).split(sep).join('/') }
        : result;
      results.push(record);
      if (runAll) await writeScenarioStatus(scenarioEvidence, record);
    } catch (error) {
      if (!runAll) throw error;
      const reason = scenarioBlockedReason(error);
      const record = {
        id: scenario.id,
        status: reason === null ? 'FAILED' : 'BLOCKED',
        evidence: relative(evidence, scenarioEvidence).split(sep).join('/'),
        ...(reason === null ? { error: describeError(error) } : { reason }),
      };
      results.push(record);
      (reason === null ? failed : blocked).push(record);
      await writeScenarioStatus(scenarioEvidence, record);
    }
  }

  if (runAll) {
    assert.equal(SCENARIOS.length, 39, 'S(all) matrix must contain exactly 39 scenarios');
    assert.deepEqual(results.map(result => result.id), SCENARIOS.map(scenario => scenario.id), 'S(all) scenario IDs/order differ from the matrix');
  }
  const report = {
    applicationRoot,
    manifestSha256: await sha256(manifestPath),
    ...(runAll ? {
      summary: {
        total: selected.length,
        applicable: selected.length - notApplicable.length,
        passed: selected.length - notApplicable.length - blocked.length - failed.length,
        notApplicable: notApplicable.length,
        blocked: blocked.length,
        failed: failed.length,
      },
    } : {}),
    scenarios: results,
  };
  await writeFile(join(evidence, 'scenario-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
  if (runAll && (blocked.length > 0 || failed.length > 0)) process.exitCode = 1;
}

async function runScenarioWithWatchdog(id, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`scenario_timeout:${id}`));
    }, SCENARIO_WATCHDOG_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function scenarioApplicability(scenario, manifest) {
  if (scenario.id === 'distribution' && process.env.ALDER_DISTRIBUTION_ARCHIVE_SMOKE === '1') {
    return 'the enclosing distribution scenario already verifies this extracted archive';
  }
  if (manifest.kind !== 'desktop' && (scenario.id === 'desktop-lifecycle' || scenario.id === 'desktop-security')) {
    return 'requires a desktop artifact';
  }
  return null;
}

function scenarioBlockedReason(error, seen = new Set()) {
  if (error === null || error === undefined || seen.has(error)) return null;
  if (typeof error === 'object' || typeof error === 'function') seen.add(error);
  if (error?.code === 'scenario_unavailable') return String(error.message ?? 'scenario unavailable');
  const message = String(error?.message ?? error);
  if (message.startsWith('scenario_unavailable:')) return message;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const reason = scenarioBlockedReason(nested, seen);
      if (reason !== null) return reason;
    }
  }
  return scenarioBlockedReason(error?.cause, seen);
}

function describeError(error) {
  const value = {
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error),
  };
  if (error?.code !== undefined) value.code = String(error.code);
  return value;
}

async function writeScenarioStatus(directory, status) {
  await writeFile(join(directory, 'scenario-status.json'), JSON.stringify(status, null, 2) + '\n');
}

async function runLaunchSlice({ applicationRoot, manifest, evidence, rscript }) {
  const base = await realpath(applicationRoot);
  const source = '# %%\nx <- 40\nx\n# %%\nx + 2\n';
  const finalSource = '# %%\nx <- 41\nx\n# %%\nx + 2\n';
  let harness;
  let live;
  let result;
  try {
    harness = await createHarness({ applicationRoot: base, manifest, evidence, rscript }, {
      id: 'launch-slice',
      source,
      rscript,
    });

    const launcher = join(base, manifest.resources.cliLauncher);
    const launcherIdentity = await realpath(launcher);
    assert.equal(launcherIdentity.startsWith(base + sep), true, 'launcher must resolve inside staged application');
    assert.notEqual(dirname(harness.canonical), resolve(join(evidence, 'unrelated')), 'launch must use an unrelated working directory');
    const nodeIdentity = await realpath(join(base, manifest.resources.nodeExecutable));
    const arkIdentity = await realpath(join(base, manifest.resources.arkExecutable));
    assert.equal(nodeIdentity.startsWith(base + sep), true, 'Node must resolve inside staged application');
    assert.equal(arkIdentity.startsWith(base + sep), true, 'Ark must resolve inside staged application');
    await writeFile(join(evidence, 'launch-identity.json'), JSON.stringify(redact({
      applicationRoot: base,
      launcher: launcherIdentity,
      node: nodeIdentity,
      ark: arkIdentity,
      cwd: process.cwd(),
      notebook: harness.canonical,
    }), null, 2) + '\n');

    const preRuntime = await harness.snapshot();
    assert.equal(preRuntime.path, harness.canonical);
    assert.equal(preRuntime.runtime.runOnStartup, false, '--no-run must not evaluate cells at startup');
    assert.equal(preRuntime.runtime.busy, false);
    assert.equal(preRuntime.runtime.activeRunId, null);
    assert.equal(preRuntime.dirty, false);
    assert.equal(preRuntime.cells.every(cell => cell.outputs.length === 0), true, '--no-run must leave startup outputs empty');

    live = await openInteractiveBrowser(harness, { name: 'launch-slice', evidence: join(evidence, 'browser') });
    await live.wait("document.querySelector('#notebook') && document.querySelectorAll('#notebook > .cell[data-cell]').length === 2", 30_000);
    const initial = await waitForExecutionReady(harness);
    await live.wait("window.__alderHost?.client?.document?.snapshot?.runtime?.executionReady === true && document.querySelectorAll('#notebook > .cell[data-cell]').length === 2", 120_000);
    assert.equal(initial.path, harness.canonical);
    assert.equal(initial.runtime.executionReady, true);
    assert.equal(initial.runtime.runOnStartup, false, '--no-run must not evaluate cells at startup');
    assert.equal(initial.runtime.busy, false);
    assert.equal(initial.runtime.activeRunId, null);
    assert.equal(initial.dirty, false);
    assert.deepEqual(initial.cells.map(cell => cell.body.join('\n')), ['x <- 40\nx', 'x + 2']);
    assert.equal(initial.cells.every(cell => cell.outputs.length === 0), true, '--no-run must leave startup outputs empty');
    const before = await live.observe('before-run');
    assert.equal(before.state.ready, true);
    assert.equal(before.state.controls.notebook, true);
    assert.equal(before.state.controls.save, true);
    assert.equal(before.state.controls['run-all'], true);
    assert.equal(before.state.cells.every(cell => cell.output === ''), true, 'browser must expose no startup outputs');
    assert.match(before.state.source, /x <- 40/);
    assert.match(before.state.source, /x \+ 2/);
    await writeFile(join(evidence, 'browser-before-run.json'), JSON.stringify(redact(before.state), null, 2) + '\n');

    await live.click('#run-all');
    const afterFirst = await waitForSnapshot(harness, snapshot => !snapshot.runtime.busy
      && snapshot.runtime.activeRunId === null
      && cellHasText(snapshot, 'x <- 40\nx', '[1] 40')
      && cellHasText(snapshot, 'x + 2', '[1] 42'), 120_000);
    const firstRun = latestOperation(afterFirst, 'run');
    assert.equal(firstRun?.status, 'done', 'browser Run all must settle successfully');
    const afterFirstBrowser = await live.observe('after-first-run');
    assert.equal(afterFirstBrowser.state.busy, false);
    assert.equal(afterFirstBrowser.state.cells.some(cell => cell.output.includes('40')), true);
    assert.equal(afterFirstBrowser.state.cells.some(cell => cell.output.includes('42')), true);
    await writeFile(join(evidence, 'browser-after-first-run.json'), JSON.stringify(redact(afterFirstBrowser.state), null, 2) + '\n');

    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'Sys.sleep(30)\nx <- 40\nx');
    const edited = await waitForSnapshot(harness, snapshot => snapshot.dirty === true
      && snapshot.cells.find(cell => cell.id === 'cell-1')?.body.join('\n') === 'Sys.sleep(30)\nx <- 40\nx', 30_000);
    assert.equal(edited.dirty, true);
    await live.click('#run-all');
    const running = await waitForSnapshot(harness, snapshot => snapshot.runtime.busy === true
      && typeof snapshot.runtime.activeRunId === 'string', 30_000);
    const stoppedRunId = running.runtime.activeRunId;
    await live.wait("(() => { const runtime = window.__alderHost?.client?.document?.snapshot?.runtime; const stop = document.querySelector('#stop'); return runtime?.busy === true && stop instanceof HTMLButtonElement && stop.disabled === false; })()", 30_000);
    await live.click('#stop');
    const afterStop = await waitForSnapshot(harness, snapshot => {
      const interrupt = latestOperation(snapshot, 'interrupt');
      return snapshot.runtime.busy === false
        && snapshot.runtime.activeRunId === null
        && interrupt?.status === 'done'
        && interrupt.result?.runId === stoppedRunId;
    }, 120_000);
    const interrupt = latestOperation(afterStop, 'interrupt');
    assert.equal(interrupt.error, null);
    assert.equal(interrupt.result?.requested, true);
    const stoppedRun = latestOperation(afterStop, 'run', operation => operation.runId === stoppedRunId);
    assert.ok(stoppedRun, 'stopped run must remain in operation history');
    assert.ok(['cancelled', 'interrupted', 'error'].includes(stoppedRun.status), 'stopped run must settle as interrupted');
    await writeFile(join(evidence, 'browser-after-stop.json'), JSON.stringify(redact({ runtime: afterStop.runtime, interrupt, run: stoppedRun }), null, 2) + '\n');

    const identityBefore = await assertProcessIdentities(harness, base, manifest);
    const identityAfterStop = await assertProcessIdentities(harness, base, manifest);
    assert.equal(identityAfterStop.ark.pid, identityBefore.ark.pid, 'Stop must not replace Ark');
    assert.equal(identityAfterStop.ark.startIdentity, identityBefore.ark.startIdentity, 'Stop must preserve Ark identity');

    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'x <- 40\nx');
    await waitForSnapshot(harness, snapshot => snapshot.dirty === true
      && snapshot.cells.find(cell => cell.id === 'cell-1')?.body.join('\n') === 'x <- 40\nx', 30_000);
    await live.click('#run-all');
    const afterRestore = await waitForSnapshot(harness, snapshot => !snapshot.runtime.busy
      && snapshot.runtime.activeRunId === null
      && cellHasText(snapshot, 'x <- 40\nx', '[1] 40')
      && cellHasText(snapshot, 'x + 2', '[1] 42'), 120_000);
    assert.equal(latestOperation(afterRestore, 'run')?.status, 'done');
    const identityAfterRestore = await assertProcessIdentities(harness, base, manifest);
    assert.equal(identityAfterRestore.ark.pid, identityBefore.ark.pid, 'same-Ark rerun must retain Ark PID');
    assert.equal(identityAfterRestore.ark.startIdentity, identityBefore.ark.startIdentity, 'same-Ark rerun must retain Ark start identity');

    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'x <- 41\nx');
    await waitForSnapshot(harness, snapshot => snapshot.dirty === true
      && snapshot.cells.find(cell => cell.id === 'cell-1')?.body.join('\n') === 'x <- 41\nx', 30_000);
    await live.click('#run-all');
    const final = await waitForSnapshot(harness, snapshot => !snapshot.runtime.busy
      && snapshot.runtime.activeRunId === null
      && cellHasText(snapshot, 'x <- 41\nx', '[1] 41')
      && cellHasText(snapshot, 'x + 2', '[1] 43'), 120_000);
    assert.equal(latestOperation(final, 'run')?.status, 'done');
    const afterFinalBrowser = await live.observe('after-final-run');
    assert.equal(afterFinalBrowser.state.cells.some(cell => cell.output.includes('41')), true);
    assert.equal(afterFinalBrowser.state.cells.some(cell => cell.output.includes('43')), true);
    await writeFile(join(evidence, 'browser-after-final-run.json'), JSON.stringify(redact(afterFinalBrowser.state), null, 2) + '\n');

    await live.wait("document.querySelector('#save') instanceof HTMLButtonElement && !document.querySelector('#save').disabled", 30_000);
    await live.click('#save');
    const saved = await waitForSnapshot(harness, snapshot => snapshot.dirty === false
      && latestOperation(snapshot, 'save')?.status === 'done', 120_000);
    assert.equal(await readFile(harness.notebook, 'utf8'), finalSource, 'Save must preserve exact notebook bytes');
    await writeFile(join(evidence, 'browser-saved.json'), JSON.stringify(redact({ state: saved, bytes: finalSource }), null, 2) + '\n');

    await live.close();
    live = undefined;
    live = await openInteractiveBrowser(harness, { name: 'launch-slice-reopen', evidence: join(evidence, 'browser-reopen') });
    await live.wait("window.__alderHost?.client?.document?.snapshot?.runtime?.executionReady === true && document.querySelectorAll('#notebook > .cell[data-cell]').length === 2", 120_000);
    await live.wait("(() => { const cells = [...document.querySelectorAll('#notebook > .cell[data-cell]')]; const outputs = cells.map(cell => cell.querySelector('[data-role=outputs]')?.innerText ?? ''); return outputs.some(text => text.includes('41')) && outputs.some(text => text.includes('43')); })()", 120_000);
    const reopenedBrowser = await live.observe('reopened');
    assert.deepEqual(reopenedBrowser.state.cells.map(cell => cell.source), ['x <- 41\nx', 'x + 2']);
    assert.equal(reopenedBrowser.state.cells.some(cell => cell.output.includes('41')), true);
    assert.equal(reopenedBrowser.state.cells.some(cell => cell.output.includes('43')), true);
    await writeFile(join(evidence, 'browser-reopened.json'), JSON.stringify(redact(reopenedBrowser.state), null, 2) + '\n');
    const reopened = await harness.snapshot();
    assert.equal(reopened.dirty, false);
    assert.deepEqual(reopened.cells.map(cell => cell.body.join('\n')), ['x <- 41\nx', 'x + 2']);
    assert.equal(await readFile(harness.notebook, 'utf8'), finalSource);
    const identityFinal = await assertProcessIdentities(harness, base, manifest);
    assert.equal(identityFinal.ark.pid, identityBefore.ark.pid, 'reopen must retain Ark PID');
    assert.equal(identityFinal.ark.startIdentity, identityBefore.ark.startIdentity, 'reopen must retain Ark start identity');

    result = {
      id: 'launch-slice',
      identity: {
        artifact: manifest.sourceCommit,
        browser: 'interactive Chromium renderer',
        runtime: {
          rscript: harness.selectedR,
          epoch: harness.registry.epoch,
          processNonce: harness.registry.processNonce,
          node: identityFinal.node,
          ark: identityFinal.ark,
          r: identityFinal.r,
          sameArkAfterStopRerun: true,
        },
      },
      fixture: harness.notebook,
      result: 'installed relocated launcher with unrelated cwd, no-run startup, browser 40/42 run, Stop and same-Ark rerun, exact-byte 41/43 Save/reopen passed',
    };
  } finally {
    const cleanupErrors = [];
    try { await live?.close(); } catch (error) { cleanupErrors.push(error); }
    if (harness !== undefined) {
      try {
        const cleanup = await harness.close();
        assert.equal(cleanup.release?.released, true, 'launch lease must be released');
        assert.equal(cleanup.ownerRetired, true, 'launch owner must retire');
        if (result !== undefined) result.identity.runtime.cleanup = {
          released: cleanup.release.released,
          ownerRetired: cleanup.ownerRetired,
          forced: cleanup.forced,
        };
      } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'launch-slice cleanup failed');
  }

  const unavailableR = await runUnavailableRBrowserSlice({ applicationRoot: base, manifest, evidence, rscript });
  result.identity.runtime.unavailableR = unavailableR;
  return result;
}

async function runUnavailableRBrowserSlice({ applicationRoot, manifest, evidence, rscript }) {
  const phaseEvidence = join(evidence, 'launch-unavailable-r');
  await mkdir(phaseEvidence, { recursive: true });
  const missingRscript = join(phaseEvidence, 'owned-missing-rscript');
  await rm(missingRscript, { recursive: true, force: true });
  const source = '# %%\nx <- 10\nx\n# %%\nx + 5\n';
  const editedSource = '# %%\nx <- 20\nx\n# %%\nx + 5\n';
  let harness;
  let live;
  let details;
  try {
    harness = await createHarness({ applicationRoot, manifest, evidence: phaseEvidence, rscript }, {
      id: 'missing-r-browser',
      source,
      rscript: missingRscript,
    });
    const preRuntime = await harness.snapshot();
    assert.equal(preRuntime.runtime.executionReady, false, 'missing R must block execution readiness');
    assert.equal(preRuntime.runtime.rEnvironment, null, 'missing R must not report an environment');

    live = await openInteractiveBrowser(harness, { name: 'launch-unavailable-r', evidence: join(phaseEvidence, 'browser') });
    await live.wait("document.querySelector('#notebook') && document.querySelectorAll('#notebook > .cell[data-cell]').length === 2", 30_000);
    const initial = await waitForSnapshot(harness, snapshot => snapshot.runtime.executionReady === false
      && snapshot.runtime.rEnvironment === null
      && /r_(?:not_found|invalid)|runtime_unavailable|engine_not_ready/i.test(String(snapshot.runtime.executionBlockedReason?.code ?? snapshot.runtime.executionBlockedReason ?? '')), 120_000);
    await writeFile(join(phaseEvidence, 'initial.json'), JSON.stringify(redact(initial), null, 2) + '\n');
    const before = await live.observe('before-edit');
    assert.equal(before.state.ready, false);
    assert.equal(before.state.controls.notebook, true);
    assert.equal(before.state.controls.save, true, 'Save must remain available without R');
    assert.equal(before.state.cells.every(cell => cell.output === ''), true);
    assert.match(before.state.source, /x <- 10/);
    await writeFile(join(phaseEvidence, 'browser-before-edit.json'), JSON.stringify(redact(before.state), null, 2) + '\n');

    await live.replaceEditor('[data-cell="cell-1"] .cm-content', 'x <- 20\nx');
    const edited = await waitForSnapshot(harness, snapshot => snapshot.dirty === true
      && snapshot.cells.find(cell => cell.id === 'cell-1')?.body.join('\n') === 'x <- 20\nx', 120_000);
    assert.equal(edited.runtime.executionReady, false);
    assert.equal(edited.runtime.rEnvironment, null);
    assert.equal(edited.cells.every(cell => cell.outputs.length === 0), true);
    const editedBrowser = await live.observe('edited');
    assert.equal(editedBrowser.state.cells.find(cell => cell.id === 'cell-1')?.source, 'x <- 20\nx');
    await writeFile(join(phaseEvidence, 'browser-edited.json'), JSON.stringify(redact(editedBrowser.state), null, 2) + '\n');

    await live.click('#save');
    const saved = await waitForSnapshot(harness, snapshot => snapshot.dirty === false
      && latestOperation(snapshot, 'save')?.status === 'done', 120_000);
    assert.equal(saved.runtime.executionReady, false);
    assert.equal(saved.runtime.rEnvironment, null);
    assert.equal(saved.cells.every(cell => cell.outputs.length === 0), true, 'unavailable-R Save must not evaluate cells');
    assert.equal(await readFile(harness.notebook, 'utf8'), editedSource, 'unavailable-R Save must preserve exact bytes');
    const savedBrowser = await live.observe('saved');
    assert.equal(savedBrowser.state.ready, false);
    assert.equal(savedBrowser.state.cells.find(cell => cell.id === 'cell-1')?.source, 'x <- 20\nx');
    assert.equal(savedBrowser.state.cells.every(cell => cell.output === ''), true, 'unavailable-R browser Save must not evaluate cells');
    await writeFile(join(phaseEvidence, 'browser-saved.json'), JSON.stringify(redact(savedBrowser.state), null, 2) + '\n');
    details = {
      rscript: missingRscript,
      executionReady: saved.runtime.executionReady,
      executionBlockedReason: saved.runtime.executionBlockedReason,
      editedAndSaved: true,
      noEvaluation: true,
      bytes: editedSource,
    };
  } finally {
    const cleanupErrors = [];
    try { await live?.close(); } catch (error) { cleanupErrors.push(error); }
    if (harness !== undefined) {
      try {
        const cleanup = await harness.close();
        assert.equal(cleanup.release?.released, true, 'unavailable-R lease must be released');
        assert.equal(cleanup.ownerRetired, true, 'unavailable-R owner must retire');
        if (details !== undefined) details.cleanup = {
          released: cleanup.release.released,
          ownerRetired: cleanup.ownerRetired,
          forced: cleanup.forced,
        };
      } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'unavailable-R browser cleanup failed');
  }
  return details;
}

async function assertProcessIdentities(harness, applicationRoot, manifest) {
  const nodeExecutable = await realpath(join(applicationRoot, manifest.resources.nodeExecutable));
  const arkExecutable = await realpath(join(applicationRoot, manifest.resources.arkExecutable));
  const records = await captureProcessTree(harness.registry.pid, harness.registry.startIdentity);
  const node = records.find(record => record.pid === harness.registry.pid);
  assert.ok(node, 'process tree must contain the registered host');
  assert.equal(node.executable, nodeExecutable, 'registered host must be the staged Node executable');
  const arkMatches = records.filter(record => record.executable === arkExecutable);
  assert.equal(arkMatches.length, 1, 'process tree must contain one staged Ark process');
  const selectedR = String(harness.selectedR);
  const selectedRPath = await realpath(selectedR);
  const rLauncher = await realpath(join(dirname(selectedRPath), process.platform === 'win32' ? 'R.exe' : 'R'));
  const rHomeEnvironment = { ...process.env };
  delete rHomeEnvironment.R_HOME;
  const rHome = execFileSync(rLauncher, ['RHOME'], {
    encoding: 'utf8',
    env: rHomeEnvironment,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  assert.equal(isAbsolute(rHome), true, 'selected R installation RHOME must be absolute');
  const rHomePath = await realpath(rHome);
  const rExecutable = await realpath(join(rHomePath, 'bin', 'exec', process.platform === 'win32' ? 'R.exe' : 'R'));
  const rProcesses = records.filter(record => record.executable !== null
    && /^R(?:\.exe)?$/i.test(basename(record.executable)));
  assert.ok(rProcesses.length >= 1, 'process tree must contain an executable from the selected R installation');
  for (const processRecord of rProcesses) {
    assert.equal(processRecord.executable, rExecutable, 'every R process must use the selected R installation');
  }
  const ark = arkMatches[0];
  return {
    node: { pid: node.pid, startIdentity: node.startIdentity, executable: node.executable },
    ark: { pid: ark.pid, startIdentity: ark.startIdentity, executable: ark.executable },
    r: rProcesses.map(processRecord => ({ pid: processRecord.pid, startIdentity: processRecord.startIdentity, executable: processRecord.executable })),
  };
}

async function waitForSnapshot(harness, predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await harness.snapshot();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      const diagnostic = {
        dirty: last?.dirty ?? null,
        operations: Array.isArray(last?.operations) ? last.operations.slice(-12).map(operation => ({ kind: operation.kind, status: operation.status, sequence: operation.commandSequence, error: operation.error?.code ?? null })) : [],
        cells: last?.cells?.map(cell => ({ id: cell.id, body: cell.body, outputs: cell.outputs?.length ?? 0 })) ?? [],
        runtime: last?.runtime ?? null,
      };
      throw new Error('notebook_condition_timeout: ' + JSON.stringify(diagnostic).slice(0, 4096));
    }
    await delay(100);
  }
}

function latestOperation(snapshot, kind, predicate = () => true) {
  const operations = Array.isArray(snapshot?.operations) ? snapshot.operations : [];
  return [...operations].reverse().find(operation => operation.kind === kind && predicate(operation));
}

function cellHasText(snapshot, body, expected) {
  const cell = snapshot?.cells?.find(candidate => candidate.body.join('\n') === body);
  return cell?.outputs?.some(output => output.data?.kind === 'text' && output.data.text.trim() === expected) === true;
}

async function loadScenarioModule(id) {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'smoke-scenarios', id + '.mjs');
  if (!await exists(path)) return null;
  return import(pathToFileURL(path).href);
}

async function findManifest(base) {
  for (const path of [
    join(base, 'resources', 'manifest.json'),
    join(base, 'Resources', 'manifest.json'),
    join(base, 'Alder.app', 'Contents', 'Resources', 'manifest.json'),
  ]) {
    if (await exists(path)) return path;
  }
  throw new Error('resource_missing: application manifest under ' + base);
}

function isWithin(root, target) {
  return target === root || target.startsWith(root + sep);
}

function safeManifestPath(value, label) {
  assert.equal(typeof value, 'string', label + ' must be a relative path');
  assert.ok(value.length > 0 && !value.includes('\0'), label + ' must be nonempty and NUL-free');
  assert.equal(isAbsolute(value), false, label + ' must be relative');
  assert.equal(/^[A-Za-z]:[\\/]/.test(value), false, label + ' must not be a drive-absolute path');
  assert.equal(value.includes('\\'), false, label + ' must use canonical slash separators');
  const segments = value.split('/');
  assert.equal(segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..'), true, label + ' contains an unsafe path segment');
  return value;
}

async function verifyManifest(base, manifest, manifestPath) {
  assert.equal(manifest.schemaVersion, 1, 'application manifest schema must be 1');
  assert.ok(Array.isArray(manifest.files), 'application manifest must inventory files');
  assert.ok(manifest.resources && typeof manifest.resources === 'object', 'application manifest must declare resources');
  const root = resolve(base);
  const physicalRoot = await realpath(root);
  assert.equal((await stat(physicalRoot)).isDirectory(), true, 'application root must be a directory');
  const physicalManifest = await realpath(manifestPath);
  assert.equal(isWithin(physicalRoot, physicalManifest), true, 'manifest must resolve inside application');
  const declared = new Map();
  for (const file of manifest.files) {
    const pathValue = safeManifestPath(file?.path, 'manifest file path');
    const path = resolve(root, pathValue);
    assert.equal(isWithin(root, path), true, 'manifest file must stay inside application');
    assert.equal(declared.has(pathValue), false, 'manifest file paths must be unique');
    const physical = await realpath(path);
    assert.equal(isWithin(physicalRoot, physical), true, 'manifest file symlink must stay inside application');
    const info = await stat(physical);
    assert.equal(info.isFile(), true, pathValue);
    assert.equal(info.size, file.bytes, pathValue);
    assert.equal(await sha256(physical), file.sha256, pathValue);
    declared.set(pathValue, file);
  }
  const manifestRelative = safeManifestPath(relative(root, resolve(manifestPath)).split(sep).join('/'), 'manifest path');
  assert.equal(declared.has(manifestRelative), false, 'manifest must not inventory itself');

  const verifiedResources = {};
  for (const [name, kind, nullable] of MANIFEST_RESOURCES) {
    const value = manifest.resources[name];
    if (nullable && value === null) {
      verifiedResources[name] = null;
      continue;
    }
    const pathValue = safeManifestPath(value, 'manifest resource ' + name);
    const path = resolve(root, pathValue);
    assert.equal(isWithin(root, path), true, 'manifest resource ' + name + ' must stay inside application');
    const physical = await realpath(path);
    assert.equal(isWithin(physicalRoot, physical), true, 'manifest resource ' + name + ' symlink must stay inside application');
    const info = await stat(physical);
    assert.equal(kind === 'directory' ? info.isDirectory() : info.isFile(), true, 'manifest resource ' + name + ' has the wrong type');
    if (kind === 'file') assert.equal(declared.has(pathValue), true, 'manifest resource ' + name + ' must be inventoried');
    verifiedResources[name] = physical;
  }
  return verifiedResources;
}

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|cookie|csrf|ticket|authorization|bearer/i.test(key))
    .map(([key, entry]) => [key, redact(entry)]));
}

async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
