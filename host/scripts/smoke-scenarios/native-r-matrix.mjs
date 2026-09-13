import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { createHarness, sanitizedEnvironment, waitForExecutionReady } from './_common.mjs';

const SELECTED_VERSION = '4.6.1';
const PEER_VERSION = '4.6.0';
const REQUIRED_VERSIONS = Object.freeze([PEER_VERSION, SELECTED_VERSION]);
const ARK_MIME = 'alder-json-v1';

export async function run(ctx) {
  const id = 'native-r-matrix';
  const selected = await resolveExplicitRscript(ctx.rscript, 'selected', SELECTED_VERSION, '--rscript');
  const peer = await resolveExplicitRscript(ctx.peerRscript, 'peer', PEER_VERSION, '--peer-rscript');
  assert.notEqual(selected.resolved, peer.resolved, 'selected and peer Rscript identities must be distinct');

  assert.equal(ctx.manifest.rBuildVersion, SELECTED_VERSION, 'application helper closure must be built with R 4.6.1');
  assert.ok(Array.isArray(ctx.manifest.qualifiedRPatchVersions), 'application manifest has no qualified R patch set');
  for (const version of REQUIRED_VERSIONS) {
    assert.ok(ctx.manifest.qualifiedRPatchVersions.includes(version), 'application manifest is not qualified for R ' + version);
  }
  assert.equal(ctx.manifest.runtimes?.ark?.mimePublisher, ARK_MIME, 'application manifest does not identify the Alder Ark publisher');

  const applicationRoot = await realpath(resolve(ctx.applicationRoot));
  const helperLibrary = await realpath(join(applicationRoot, ctx.manifest.resources.rLibraryDirectory));
  const arkExecutable = await realpath(join(applicationRoot, ctx.manifest.resources.arkExecutable));
  const supervisorPath = await realpath(join(applicationRoot, ctx.manifest.resources.processSupervisorExecutable));
  assert.equal(arkExecutable.startsWith(applicationRoot + sep), true, 'Ark executable must resolve inside staged application');
  assert.equal(supervisorPath.startsWith(applicationRoot + sep), true, 'process supervisor must resolve inside staged application');

  const probes = [
    await qualifyR(selected, SELECTED_VERSION, 'selected', helperLibrary),
    await qualifyR(peer, PEER_VERSION, 'peer', helperLibrary),
  ];
  assert.equal(probes[0].probe.platform, probes[1].probe.platform, 'selected and peer R platforms differ');
  assert.equal(probes[0].probe.arch, probes[1].probe.arch, 'selected and peer R architectures differ');
  assert.notEqual(probes[0].probe.rHome, probes[1].probe.rHome, 'selected and peer R homes must be distinct');

  const records = [];
  for (const qualified of probes) {
    let harness;
    try {
      harness = await createHarness(ctx, {
        id: `${id}-${qualified.expectedVersion.replaceAll('.', '-')}`,
        rscript: qualified.input.resolved,
        source: matrixSource(),
      });
      const identity = await harness.request('/api/identity', {
        cookie: harness.session.cookie,
        csrf: harness.session.csrf,
      });
      const initial = await waitForExecutionReady(harness);
      const runtime = initial.runtime;
      assert.equal(runtime.executionReady, true, qualified.role + ': runtime is not ready');
      assert.equal(runtime.rEnvironment?.version, qualified.expectedVersion, qualified.role + ': host selected a different R version');
      assert.equal(runtime.rEnvironment?.rscript, qualified.input.resolved, qualified.role + ': selected Rscript path changed');
      assert.equal(runtime.rEnvironment?.platform, process.platform, qualified.role + ': host platform identity changed');
      assert.equal(runtime.rEnvironment?.arch, process.arch, qualified.role + ': host architecture identity changed');
      assert.equal(typeof runtime.rEnvironment?.identity, 'string', qualified.role + ': R environment identity is missing');
      assert.equal(await realpath(runtime.rEnvironment?.rHome ?? ''), qualified.probe.rHome, qualified.role + ': selected R home changed');
      assert.equal(await realpath(runtime.rEnvironment?.libraryPaths?.[0] ?? ''), helperLibrary, qualified.role + ': helper library is not first in the R library path');
      assert.equal(typeof runtime.analysisEnvironmentId, 'string', qualified.role + ': analyzer environment identity is missing');
      assert.deepEqual(initial.cells[1]?.defs, ['r_value_40'], qualified.role + ': analyzer did not define the R probe value');
      assert.deepEqual(initial.cells[2]?.refs, ['r_value_40'], qualified.role + ': analyzer did not retain the R probe dependency');
      const admission = await harness.nextCommand({
        type: 'run',
        scope: 'all',
        expectedDocumentRevision: initial.documentRevision,
      });
      assert.equal(admission.accepted, true, qualified.role + ': run was not admitted');
      const operationId = admission.operation?.id ?? admission.operationId;
      assert.equal(typeof operationId, 'string', qualified.role + ': run did not receive an operation identity');
      const operation = await harness.awaitOperation(operationId);
      assert.equal(operation.status, 'done', qualified.role + ': R/Ark probe did not settle successfully');

      const settled = await harness.snapshot();
      assert.equal(settled.runtime.rEnvironment?.version, qualified.expectedVersion);
      assert.equal(settled.runtime.rEnvironment?.rscript, qualified.input.resolved);
      assert.equal(await realpath(settled.runtime.rEnvironment?.rHome ?? ''), qualified.probe.rHome);
      assert.equal(settled.runtime.kernelEpoch, initial.runtime.kernelEpoch, qualified.role + ': probe replaced the Ark kernel');

      const outputs = settled.cells.flatMap(cell => cell.outputs ?? []);
      const serializedOutputs = JSON.stringify(outputs);
      assert.match(serializedOutputs, /40/, qualified.role + ': 40 execution result is missing');
      assert.match(serializedOutputs, /42/, qualified.role + ': 42 execution result is missing');
      assert.match(serializedOutputs, /markdown/, qualified.role + ': Alder helper behavior is missing from Ark execution');
      assert.match(serializedOutputs, /3/, qualified.role + ': Alder cache helper behavior is missing from Ark execution');
      const publisherOutputs = outputs.filter(output => output.data?.mime === 'application/json');
      assert.equal(publisherOutputs.length, 1, qualified.role + ': Ark publisher did not emit exactly one public JSON output');
      assert.deepEqual(publisherOutputs[0].data.value, {
        empty_array: [],
        empty_object: {},
        scalar: 1e20,
        unicode: 'λ',
      }, qualified.role + ': Ark publisher changed JSON fidelity');

      records.push({
        role: qualified.role,
        expectedVersion: qualified.expectedVersion,
        requestedRscript: qualified.input.requested,
        rscript: qualified.input.resolved,
        probe: qualified.probe,
        helper: {
          ...qualified.helper,
          applicationLibrary: helperLibrary,
          runtimeLibraryPaths: runtime.rEnvironment.libraryPaths,
        },
        ark: {
          executable: arkExecutable,
          sha256: await sha256(arkExecutable),
          mimePublisher: ARK_MIME,
          kernelEpoch: settled.runtime.kernelEpoch,
          publisherJson: true,
        },
        host: {
          pid: harness.registry.pid,
          startIdentity: harness.registry.startIdentity,
          processNonce: identity.processNonce,
          epoch: identity.epoch,
        },
        runtime: {
          identity: runtime.rEnvironment.identity,
          rHome: runtime.rEnvironment.rHome,
          platform: runtime.rEnvironment.platform,
          arch: runtime.rEnvironment.arch,
          analyzerState: settled.runtime.analyzerState,
          kernelState: settled.runtime.kernelState,
          executionReady: settled.runtime.executionReady,
        },
      });
    } finally {
      await harness?.close();
    }
  }

  const identity = {
    requiredVersions: REQUIRED_VERSIONS,
    selected: records.find(record => record.role === 'selected'),
    peer: records.find(record => record.role === 'peer'),
    selectedRscript: selected,
    peerRscript: peer,
    helperBuildVersion: ctx.manifest.rBuildVersion,
    candidatePolicy: 'explicit absolute --rscript=4.6.1 and --peer-rscript=4.6.0 only; no discovery or fallback',
    qualifiedRPatchVersions: ctx.manifest.qualifiedRPatchVersions,
    supervisor: { path: supervisorPath, sha256: await sha256(supervisorPath) },
    runtimes: records,
  };
  assert.ok(identity.selected && identity.peer, 'native-r-matrix did not record both R identities');
  await writeFile(join(ctx.evidence, `${id}.json`), JSON.stringify(identity, null, 2) + '\n');
  return { id, identity };
}

async function resolveExplicitRscript(value, role, expectedVersion, option) {
  if (typeof value !== 'string' || value.length === 0) unavailable(`${option} is required for ${role} R ${expectedVersion}`);
  if (value.includes('\0') || !isAbsolute(value)) unavailable(`${option} must be an absolute executable path for ${role} R ${expectedVersion}: ${value}`);
  const requested = resolve(value);
  let resolved;
  try {
    resolved = await realpath(requested);
    const info = await stat(resolved);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o111) === 0)) throw new Error('not an executable file');
  } catch (error) {
    unavailable(`${role} R ${expectedVersion} is unavailable at ${requested}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { requested, resolved };
}

async function qualifyR(input, expectedVersion, role, helperLibrary) {
  const probe = probeR(input.resolved);
  if (probe.state === 'unavailable') unavailable(`${role} R ${expectedVersion} could not be started at ${input.resolved}: ${probe.reason}`);
  if (probe.state !== 'ready') qualificationFailure(`${role} R ${expectedVersion} failed identity qualification at ${input.resolved}: ${probe.reason}`);
    assert.equal(probe.version, expectedVersion, `${role} Rscript reported R ${probe.version}; expected R ${expectedVersion}`);
    try {
      probe.rHome = await realpath(probe.rHome);
    } catch (error) {
      qualificationFailure(`${role} R ${expectedVersion} reported an unavailable R_HOME: ${error instanceof Error ? error.message : String(error)}`);
    }
  const helper = probeHelper(input.resolved, helperLibrary, expectedVersion, role);
  return { input, expectedVersion, role, probe, helper };
}

function probeR(candidate) {
  const result = spawnSync(candidate, [
    '--vanilla', '--slave', '-e',
    'cat(as.character(getRversion()), "\\n", R.version$platform, "\\n", R.version$arch, "\\n", normalizePath(R.home("home"), winslash = "/", mustWork = FALSE), "\\n", sep = "")',
  ], {
    encoding: 'utf8',
    env: cleanREnvironment(),
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    return { state: result.error.code === 'ENOENT' ? 'unavailable' : 'invalid', reason };
  }
  if (result.status !== 0) return { state: 'invalid', reason: `exit=${result.status ?? result.signal ?? 'unknown'} stderr=${String(result.stderr).trim().slice(-1_024)}` };
  const [version, platform, arch, rHome] = String(result.stdout).trim().split(/\r?\n/);
  if (!version || !platform || !arch || !isAbsolute(rHome ?? '')) return { state: 'invalid', reason: 'probe returned an incomplete R identity' };
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { state: 'invalid', reason: `probe returned an invalid version: ${version}` };
  return { state: 'ready', version, platform, arch, rHome };
}

function probeHelper(rscript, helperLibrary, expectedVersion, role) {
  const code = [
    'suppressPackageStartupMessages(library(alder))',
    'md <- alder::out$md("native-r-matrix")',
    'slider <- alder::ui$slider(0, 1, value = 0.5, step = 0.5)',
    'cached <- alder::cache$memory(function(x) x + 1)',
    'cacheValue <- cached(2)',
    'stopifnot(inherits(md, "alder_output"), identical(md$kind, "markdown"), identical(slider$kind, "slider"), isTRUE(all.equal(slider$value, 0.5)), identical(attr(cached, "cache"), "memory"), isTRUE(all.equal(cacheValue, 3)))',
    'cat("ALDER_NATIVE_HELPER_V1|", as.character(packageVersion("alder")), "|", as.character(getRversion()), "|", md$kind, "|", slider$kind, "|", as.character(slider$value), "|", attr(cached, "cache"), "|", as.character(cacheValue), "\\n", sep = "")',
  ].join('; ');
  const result = spawnSync(rscript, ['--vanilla', '--no-echo', '--no-restore', '--no-save', '-e', code], {
    cwd: helperLibrary,
    env: cleanREnvironment({ R_LIBS: helperLibrary }),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) qualificationFailure(`${role} R ${expectedVersion} helper probe failed to start: ${result.error.message}`);
  if (result.status !== 0) qualificationFailure(`${role} R ${expectedVersion} helper probe failed: ${String(result.stderr).trim().slice(-2_048)}`);
  const line = String(result.stdout).split(/\r?\n/).find(value => value.startsWith('ALDER_NATIVE_HELPER_V1|'));
  if (!line) qualificationFailure(`${role} R ${expectedVersion} helper probe emitted no identity: ${String(result.stderr).trim().slice(-2_048)}`);
  const [, packageVersion, rVersion, markdownKind, sliderKind, sliderValue, cacheKind, cacheValue] = line.split('|');
  assert.equal(typeof packageVersion, 'string');
  assert.equal(rVersion, expectedVersion, `${role} helper probe used the wrong R version`);
  assert.equal(markdownKind, 'markdown', `${role} helper markdown behavior changed`);
  assert.equal(sliderKind, 'slider', `${role} helper slider behavior changed`);
  assert.equal(sliderValue, '0.5', `${role} helper slider value changed`);
  assert.equal(cacheKind, 'memory', `${role} helper cache behavior changed`);
  assert.equal(cacheValue, '3', `${role} helper cache result changed`);
  return { packageVersion, rVersion, markdownKind, sliderKind, sliderValue: Number(sliderValue), cacheKind, cacheValue: Number(cacheValue) };
}

function matrixSource() {
  const publisherPayload = JSON.stringify({ 'application/json': { empty_array: [], empty_object: {}, scalar: 1e20, unicode: 'λ' } });
  const publisherMetadata = JSON.stringify({ publisher: 'ark' });
  return [
    '# %%',
    'helper_output <- alder::out$md("native-r-matrix")',
    'helper_kind <- helper_output$kind',
    'cached <- alder::cache$memory(function(x) x + 1)',
    'helper_value <- cached(2)',
    'list(helper_kind = helper_kind, helper_value = helper_value)',
    '# %%',
    'r_value_40 <- 40',
    'r_value_40',
    '# %%',
    'r_value_40 + 2',
    '# %%',
    `as.environment("tools:positron")[["ark_publish_mimebundle"]](${JSON.stringify(publisherPayload)}, ${JSON.stringify(publisherMetadata)}, ${JSON.stringify('{}')})`,
  ].join('\n') + '\n';
}

function cleanREnvironment(extra = {}) {
  const env = sanitizedEnvironment();
  for (const key of Object.keys(env)) {
    if (/^R_(?:HOME|USER|LIBS|ENVIRON|PROFILE)/.test(key)) delete env[key];
  }
  Object.assign(env, extra);
  return env;
}

function unavailable(reason) {
  const error = new Error(`scenario_unavailable: native-r-matrix: ${reason}`);
  error.code = 'scenario_unavailable';
  throw error;
}

function qualificationFailure(reason) {
  const error = new Error(`native-r-matrix qualification failed: ${reason}`);
  error.code = 'native_r_qualification_failed';
  throw error;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
