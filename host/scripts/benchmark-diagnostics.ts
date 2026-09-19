import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { StructuredDiagnostics, type DiagnosticsStatus, type DiagnosticSink } from "../src/diagnostics.js";

const iterations = Number.parseInt(process.env.ALDER_DIAGNOSTIC_BENCHMARK_ITERATIONS ?? "5000", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1_000 || iterations > 1_000_000) {
  throw new Error("ALDER_DIAGNOSTIC_BENCHMARK_ITERATIONS must be between 1000 and 1000000");
}

const disabled: DiagnosticSink = { record() {}, child() { return this; } };

function percentile(values: number[], fraction: number): number {
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
}
function counts(status: DiagnosticsStatus): Record<string, number> {
  return {
    generated: status.generatedEvents, accepted: status.acceptedEvents, dropped: status.droppedEvents,
    persisted: status.persistedEvents, queued: status.queuedEvents, unavailable: status.unavailableEvents,
  };
}

async function ordinary(label: string, sink: DiagnosticSink): Promise<Record<string, unknown>> {
  const samples: number[] = [];
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const operationId = `operation-${index}`;
    const before = performance.now();
    sink.record("info", "operation.accepted", { clientId: "benchmark-client", operationId, kind: "run", documentRevision: index });
    for (const phase of ["analysis-ready", "kernel-dispatch", "kernel-completion", "authoritative-completion"]) {
      sink.record("info", "operation.phase", { clientId: "benchmark-client", operationId, phase });
    }
    sink.record("info", "operation.settled", { clientId: "benchmark-client", operationId, kind: "run", outcome: "success", durationMs: 1 });
    samples.push((performance.now() - before) * 1_000);
    if (sink instanceof StructuredDiagnostics && index % 250 === 249) await sink.flush();
  }
  if (sink instanceof StructuredDiagnostics) await sink.flush();
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  samples.sort((a, b) => a - b);
  return {
    label, operations: iterations, callerEvents: iterations * 6,
    wallMs, operationMicros: { p50: percentile(samples, 0.50), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99) },
    callMicros: { p50: percentile(samples, 0.50) / 6, p95: percentile(samples, 0.95) / 6, p99: percentile(samples, 0.99) / 6 },
    cpuMicros: { user: cpu.user, system: cpu.system },
    ...(sink instanceof StructuredDiagnostics ? { counts: counts(sink.status()) } : {}),
  };
}

async function retainedBytes(root: string): Promise<number> {
  const names = (await readdir(root)).filter(name => name.endsWith(".jsonl"));
  return (await Promise.all(names.map(name => stat(join(root, name))))).reduce((sum, item) => sum + item.size, 0);
}

async function retainedFiles(root: string): Promise<number> {
  return (await readdir(root)).filter(name => name.endsWith(".jsonl")).length;
}

const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-benchmark-"));
const ordinaryRoot = join(root, "ordinary"), saturationRoot = join(root, "saturation"), rotationRoot = join(root, "rotation");
const enabled = new StructuredDiagnostics({
  rootDir: ordinaryRoot, role: "host", component: "host", queueLimit: 4_096,
  segmentBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, maxSegments: 16, flushDelayMs: 60_000, stderr: null,
});
const saturated = new StructuredDiagnostics({
  rootDir: saturationRoot, role: "host", component: "host", queueLimit: 128,
  segmentBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, maxSegments: 16, flushDelayMs: 60_000, stderr: null,
});
const rotating = new StructuredDiagnostics({
  rootDir: rotationRoot, role: "host", component: "host", queueLimit: 4_096,
  segmentBytes: 24 * 1024, totalBytes: 48 * 1024, maxSegments: 2, flushDelayMs: 60_000, stderr: null,
});

try {
  await ordinary("warmup", disabled);
  const off = await ordinary("disabled", disabled);
  const on = { ...(await ordinary("ordinary-enabled", enabled)), retainedDirectoryBytes: await retainedBytes(ordinaryRoot) };

  const saturationCpu = process.cpuUsage(), saturationStarted = performance.now();
  for (let index = 0; index < iterations; index++) saturated.record("info", "host.ready", { count: index });
  const saturationBeforeDrain = counts(saturated.status());
  await saturated.flush();
  const saturationCpuUsed = process.cpuUsage(saturationCpu);
  const saturation = {
    label: "saturated-enabled", wallMs: performance.now() - saturationStarted,
    cpuMicros: { user: saturationCpuUsed.user, system: saturationCpuUsed.system },
    beforeDrain: saturationBeforeDrain, afterDrain: counts(saturated.status()),
    retainedDirectoryBytes: await retainedBytes(saturationRoot),
  };

  const rotationCpu = process.cpuUsage(), rotationStarted = performance.now();
  for (let index = 0; index < iterations; index++) {
    rotating.record("info", "host.ready", { count: index });
    if (index % 250 === 249) await rotating.flush();
  }
  await rotating.flush();
  const rotationCpuUsed = process.cpuUsage(rotationCpu);
  const rotationRetainedBytes = await retainedBytes(rotationRoot);
  const rotationRetainedFiles = await retainedFiles(rotationRoot);
  const rotation = {
    label: "rotation-and-pruning", wallMs: performance.now() - rotationStarted,
    cpuMicros: { user: rotationCpuUsed.user, system: rotationCpuUsed.system }, counts: counts(rotating.status()),
    retainedDirectoryBytes: rotationRetainedBytes, retainedFiles: rotationRetainedFiles,
    retentionCaps: { bytes: 48 * 1024, files: 2 },
  };
  if (rotationRetainedBytes > rotation.retentionCaps.bytes || rotationRetainedFiles > rotation.retentionCaps.files) {
    throw new Error("rotation benchmark exceeded retention caps");
  }

  process.stdout.write(JSON.stringify({ benchmark: "alder-diagnostics", off, on, saturation, rotation }, null, 2) + "\n");
} finally {
  await Promise.all([enabled.close(), saturated.close(), rotating.close()]);
  await rm(root, { recursive: true, force: true });
}
