import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureProcessTree, cleanupOwnedProcessTree, cleanupPartialOwner, cleanupScenarioResources, readProcess, signalSmokeProcessGroup, spawnSmokeProcess } from './_common.mjs';

const DEFAULT_REPETITIONS = 30;

export async function run(ctx) {
  throwIfAborted(ctx.signal);
  const id = 'performance';
  const repetitions = Number(process.env.ALDER_SMOKE_PERFORMANCE_REPETITIONS ?? DEFAULT_REPETITIONS);
  assert.equal(Number.isSafeInteger(repetitions) && repetitions >= DEFAULT_REPETITIONS, true, `performance requires at least ${DEFAULT_REPETITIONS} repetitions`);
  const applicationRoot = resolve(ctx.applicationRoot);
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const sourceRoot = resolve(ctx.sourceRoot ?? checkoutRoot);
  const evidenceDirectory = join(ctx.evidence, id);
  const evidencePath = join(ctx.evidence, `${id}.json`);
  await mkdir(evidenceDirectory, { recursive: true });
  const frontend = process.env.ALDER_SMOKE_PERFORMANCE_FRONTEND ?? (ctx.manifest.kind === 'desktop' ? 'electron' : 'browser');
  assert.ok(frontend === 'browser' || frontend === 'electron', 'performance frontend must be browser or electron');
  const selectedRscript = await selectRscript(ctx.rscript);

  const manifestPath = join(applicationRoot, dirname(ctx.manifest.resources.hostEntry), '..', 'manifest.json');
  const baseline = {
    sourceCommit: ctx.manifest.sourceCommit,
    sourceTreeSha256: ctx.manifest.sourceTreeSha256,
    manifestSha256: await sha256File(manifestPath),
    artifactInventorySha256: inventoryDigest(ctx.manifest.files ?? []),
    driverSha256: await sha256File(fileURLToPath(import.meta.url)),
    machine: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      power: await readPowerIdentity(),
    },
    frontend,
    applicationRoot,
    selectedRscript,
  };
  const dependencyRoot = resolve(ctx.qualificationRoot ?? join(sourceRoot, 'host'));
  const processObserverOptions = { supervisorExecutable: join(applicationRoot, ctx.manifest.resources.processSupervisorExecutable) };
  assert.notEqual(baseline.machine.hostname, '', 'performance requires a machine identity');
  await writeFile(join(evidenceDirectory, 'baseline.json'), `${JSON.stringify(redact(baseline), null, 2)}\n`, 'utf8');

  const warm = await runLatency({ sourceRoot, dependencyRoot, applicationRoot, selectedRscript, frontend, repetitions, evidence: join(evidenceDirectory, 'warm'), signal: ctx.signal, processObserverOptions });
  const fresh = await runLatency({ sourceRoot, dependencyRoot, applicationRoot, selectedRscript, frontend, repetitions, fresh: true, evidence: join(evidenceDirectory, 'fresh'), signal: ctx.signal, processObserverOptions });
  assert.equal(fresh.identity.frontend, frontend);
  assert.equal(warm.identity.repetitions, repetitions);
  assert.equal(fresh.identity.repetitions, repetitions);

  const fixtures = ['scalar', 'chain', '100-unrelated', 'create'];
  const gateFailures = [];
  const scenarios = {};
  for (const fixture of fixtures) {
    const names = fixture === 'create' ? ['create'] : ['run', 'edit-and-run'];
    scenarios[fixture] = {
      fixtureSha256: fixtureDigest(warm, fixture),
      warm: {},
      fresh: {},
      identities: {
        warm: sessionIdentities(warm, fixture),
        fresh: sessionIdentities(fresh, fixture),
      },
      startup: {
        warm: startupEvidence(warm, fixture),
        fresh: startupEvidence(fresh, fixture),
      },
    };
    for (const scenario of names) {
      const warmDistribution = distribution(warm, fixture, scenario, repetitions);
      const freshDistribution = distribution(fresh, fixture, scenario, repetitions);
      scenarios[fixture].warm[scenario] = warmDistribution;
      scenarios[fixture].fresh[scenario] = freshDistribution;
      assert.equal(warmDistribution.count, repetitions);
      assert.equal(freshDistribution.count, repetitions);
      if (!(warmDistribution.medianMs <= 50)) gateFailures.push(`${fixture}/${scenario} warm median ${warmDistribution.medianMs}ms > 50ms`);
      if (!(warmDistribution.p95Ms <= 100)) gateFailures.push(`${fixture}/${scenario} warm p95 ${warmDistribution.p95Ms}ms > 100ms`);
      if (!(freshDistribution.medianMs <= 50)) gateFailures.push(`${fixture}/${scenario} fresh median ${freshDistribution.medianMs}ms > 50ms`);
      if (!(freshDistribution.p95Ms <= 100)) gateFailures.push(`${fixture}/${scenario} fresh p95 ${freshDistribution.p95Ms}ms > 100ms`);
    }
  }

  const identity = {
    sourceCommit: baseline.sourceCommit,
    sourceTreeSha256: baseline.sourceTreeSha256,
    manifestSha256: baseline.manifestSha256,
    artifactInventorySha256: baseline.artifactInventorySha256,
    driverSha256: baseline.driverSha256,
    frontend,
    applicationRoot,
    selectedRscript,
    repetitions,
    thresholds: { medianMs: 50, p95Ms: 100 },
    machine: baseline.machine,
    scenarios,
    cold: {
      warm: warm.cold,
      fresh: fresh.cold,
    },
    latencyIdentities: {
      warm: warm.identity,
      fresh: fresh.identity,
    },
  };
  await writeFile(evidencePath, `${JSON.stringify(redact({ id, identity, baseline, warm, fresh, gateFailures }), null, 2)}\n`, 'utf8');
  if (gateFailures.length) throw new Error(`performance latency gate failed: ${gateFailures.join('; ')}`);
  return { id, identity };
}

async function runLatency({ sourceRoot, dependencyRoot, applicationRoot, selectedRscript, frontend, repetitions, fresh = false, evidence, signal, processObserverOptions }) {
  throwIfAborted(signal);
  await mkdir(evidence, { recursive: true });
  const tsx = join(dependencyRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const script = join(sourceRoot, 'host', 'scripts', 'latency.ts');
  if (!await isFile(tsx)) throw new Error(`performance latency runner is missing: ${tsx}`);
  const args = [tsx, script, '--application', applicationRoot, evidence, String(repetitions), '--rscript', selectedRscript, '--frontend', frontend, '--no-progress'];
  if (fresh) args.push('--fresh');
  let result;
  await cleanupScenarioResources(
    async () => { result = await spawnAndCollect(process.execPath, args, sourceRoot, signal); },
    () => cleanupLatencyOwners(evidence, processObserverOptions),
  );
  throwIfAborted(signal);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(evidence, 'results.json'), 'utf8'));
  } catch (error) {
    throw new Error(`latency ${fresh ? 'fresh' : 'warm'} evidence is unavailable: ${result.stderr}\n${error}`);
  }
  if (result.code !== 0 && result.code !== 3) throw new Error(`latency ${fresh ? 'fresh' : 'warm'} failed with ${result.code}: ${result.stderr}`);
  assert.equal(parsed.correctnessPassed, true, `latency ${fresh ? 'fresh' : 'warm'} correctness failed`);
  return parsed;
}

async function cleanupLatencyOwners(evidence, processObserverOptions) {
  const recorded = await readFile(join(evidence, 'results.json'), 'utf8').then(JSON.parse).catch(() => null);
  const launchers = Array.isArray(recorded?.fixtures) ? recorded.fixtures.map(row => row?.hostProcess).filter(Boolean) : [];
  const entries = await readdir(evidence, { withFileTypes: true }).catch(() => []);
  await cleanupScenarioResources(
    ...launchers.map(identity => async () => {
      const observed = await readProcess(identity.pid, processObserverOptions);
      if (observed === null || !observed.command.includes(evidence)) return;
      if (identity.startTimeTicks !== undefined && observed.startIdentity !== 'linux:' + identity.startTimeTicks) return;
      const tree = await captureProcessTree(identity.pid, observed.startIdentity, processObserverOptions);
      await cleanupOwnedProcessTree(tree, processObserverOptions);
    }),
    ...entries
      .filter(entry => entry.isDirectory() && entry.name.endsWith('-runtime-data'))
      .map(entry => () => cleanupPartialOwner(null, join(evidence, entry.name, 'alder-nodejs', 'runtime'), processObserverOptions)),
  );
}

function spawnAndCollect(command, args, cwd, signal) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawnSmokeProcess(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let settled = false;
    let killTimer;
    const onAbort = () => {
      if (aborted || child.exitCode !== null || child.signalCode !== null) return;
      aborted = true;
      try {
        signalSmokeProcessGroup(child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* process already exited */ }
      }
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          signalSmokeProcessGroup(child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* process already exited */ }
        }
      }, 2_000);
      killTimer.unref?.();
    };
    const cleanup = () => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    child.stdout.on('data', value => { stdout = (stdout + String(value)).slice(-1_048_576); });
    child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-1_048_576); });
    child.once('error', error => settle(rejectResult, aborted ? cancellationReason(signal) : error));
    child.once('close', (code, signalCode) => {
      if (aborted) {
        settle(rejectResult, cancellationReason(signal));
      } else {
        settle(resolveResult, { code: code ?? (signalCode ? 1 : 0), signal: signalCode, stdout, stderr });
      }
    });
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function cancellationReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('performance latency run aborted');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancellationReason(signal);
}

function distribution(record, fixture, scenario, repetitions) {
  const match = record.distributions.find(value => value.fixture === fixture && value.scenario === scenario);
  assert.ok(match, `missing ${fixture}/${scenario} distribution`);
  const samples = record.fixtures.filter(row => row.fixture === fixture).flatMap(row => row.samples)
    .filter(sample => sample.scenario === scenario && sample.phase === (record.identity.freshSessions ? 'first' : 'measured'))
    .map(sample => sample.durationMs).sort((a, b) => a - b);
  assert.equal(samples.length, repetitions, `missing ${fixture}/${scenario} samples`);
  return {
    count: match.n,
    minMs: samples[0],
    medianMs: match.median,
    p95Ms: match.p95,
    maxMs: samples[samples.length - 1],
    samples,
    passed: match.passed,
    target: { medianMs: 50, p95Ms: 100 },
  };
}

function sessionIdentities(record, fixture) {
  return record.fixtures.filter(row => row.fixture === fixture).map(row => ({
    session: row.session,
    firstScenario: row.firstScenario,
    epoch: row.epoch,
    hostProcess: row.hostProcess ?? null,
    browserProcess: row.browserProcess ?? null,
    desktopProcess: row.desktopProcess ?? null,
    cdp: row.cdp ?? null,
  }));
}

function startupEvidence(record, fixture) {
  return record.fixtures.filter(row => row.fixture === fixture).map(row => ({
    session: row.session,
    firstScenario: row.firstScenario,
    startup: row.startup,
  }));
}

function fixtureDigest(record, fixture) {
  const row = record.fixtures.find(value => value.fixture === fixture);
  assert.ok(row?.fixtureSha256, `missing ${fixture} fixture identity`);
  return row.fixtureSha256;
}

async function selectRscript(requested) {
  if (requested) {
    const selected = resolve(requested);
    if (!await isExecutable(selected)) throw new Error(`performance Rscript is not an executable file: ${selected}`);
    return selected;
  }
  const candidates = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map(path => join(path, process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'));
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate;
  throw new Error('performance requires an explicit Rscript or Rscript on PATH');
}

async function isFile(path) {
  return await stat(path).then(value => value.isFile()).catch(() => false);
}
async function isExecutable(path) {
  return await stat(path).then(value => value.isFile() && (process.platform === 'win32' || (value.mode & 0o111) !== 0)).catch(() => false);
}

async function readPowerIdentity() {
  const paths = ['/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', '/sys/class/power_supply/AC/online'];
  const result = {};
  for (const path of paths) {
    try {
      result[path] = (await readFile(path, 'utf8')).trim();
    } catch {
      result[path] = null;
    }
  }
  return result;
}

function inventoryDigest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return hash.digest('hex');
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function redact(value) {
  return value;
}
