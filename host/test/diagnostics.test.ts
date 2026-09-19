import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  StructuredDiagnostics,
  DIAGNOSTIC_EVENTS,
  exportDiagnosticBundle,
  persistEmergencyDiagnostic,
  pruneCorruptRecoveryCopies,
} from "../src/diagnostics.js";

async function logText(root: string): Promise<string> {
  const names = (await readdir(root)).filter(name => name.endsWith(".jsonl"));
  return (await Promise.all(names.map(name => readFile(join(root, name), "utf8")))).join("");
}

async function records(root: string): Promise<Array<Record<string, unknown>>> {
  return (await logText(root)).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

test("structured diagnostics rotate, retain bounded segments, and drop a saturated queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-bounds-"));
  const logger = new StructuredDiagnostics({
    rootDir: root, role: "backend", queueLimit: 3, segmentBytes: 420,
    totalBytes: 1_260, maxSegments: 3, flushDelayMs: 60_000, stderr: null,
  });
  for (let index = 0; index < 20; index++) logger.record("info", "operation.phase", { operationId: `op-${index}`, phase: "bounded" });
  assert.equal(logger.status().droppedEvents, 17);
  await logger.flush();
  for (let index = 0; index < 18; index++) {
    logger.record("info", "operation.phase", { operationId: `later-${index}`, phase: "rotate", count: index });
    await logger.flush();
  }
  const segments = (await readdir(root)).filter(name => name.endsWith(".jsonl"));
  assert.ok(segments.length <= 3);
  const bytes = (await Promise.all(segments.map(name => stat(join(root, name))))).reduce((sum, info) => sum + info.size, 0);
  assert.ok(bytes <= 1_680, `retained ${bytes} bytes`);
  await logger.close();
});

test("diagnostic storage failure is non-blocking and reported once", async () => {
  const parent = await mkdtemp(join(tmpdir(), "alder-diagnostics-failure-"));
  const root = join(parent, "not-a-directory");
  await writeFile(root, "occupied");
  const fallback: string[] = [];
  const logger = new StructuredDiagnostics({ rootDir: root, role: "backend", flushDelayMs: 0, stderr: { write: value => { fallback.push(String(value)); return true; } } as never });
  assert.doesNotThrow(() => logger.record("info", "backend.launch", {}));
  await logger.flush();
  assert.equal(logger.status().available, false);
  assert.equal(fallback.length, 1);
  logger.record("info", "backend.ready", {});
  assert.equal(fallback.length, 1);
});

test("operation records are sequenced, expose missing timing phases, and emit one bounded slow warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-timing-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", slowThresholdMs: 10, flushDelayMs: 0, stderr: null });
  logger.record("info", "operation.accepted", { operationId: "run-1", kind: "run" });
  logger.record("info", "operation.phase", { operationId: "run-1", phase: "analysis" });
  await new Promise(resolve => setTimeout(resolve, 25));
  logger.record("info", "operation.settled", { operationId: "run-1", kind: "run", outcome: "success" });
  await logger.close();
  const values = await records(root);
  assert.deepEqual(values.map(value => value.eventSequence), values.map((_value, index) => index + 1));
  assert.equal(values.filter(value => value.event === "operation.slow").length, 1);
  const timing = values.find(value => value.event === "operation.timing");
  assert.ok(timing);
  assert.deepEqual(timing.missingPhases, ["analysis-ready", "kernel-dispatch", "kernel-completion", "authoritative-completion"]);
});

test("flush and close drain every queued batch through their call boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-drain-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", queueLimit: 4_000, flushDelayMs: 60_000, stderr: null });
  for (let index = 0; index < 250; index++) {
    const operationId = `run-${index}`;
    logger.record("info", "operation.accepted", { clientId: "client-a", operationId, kind: "run" });
    for (const phase of ["analysis-ready", "kernel-dispatch", "kernel-completion", "authoritative-completion"]) {
      logger.record("info", "operation.phase", { clientId: "client-a", operationId, phase });
    }
    logger.record("info", "operation.settled", { clientId: "client-a", operationId, kind: "run", outcome: "success" });
  }
  assert.equal(logger.status().generatedEvents, 1_750);
  await logger.flush();
  assert.equal(logger.status().acceptedEvents, 1_750);
  assert.equal(logger.status().persistedEvents, 1_750);
  assert.equal(logger.status().droppedEvents, 0);
  assert.equal(logger.status().unavailableEvents, 0);
  assert.equal(logger.status().queuedEvents, 0);
  assert.equal((await records(root)).length, 1_750);

  for (let index = 0; index < 1_100; index++) logger.record("info", "backend.launch", { count: index });
  await logger.close();
  assert.equal(logger.status().queuedEvents, 0);
  assert.equal(logger.status().persistedEvents, 2_850);
  assert.equal((await records(root)).length, 2_850);
});

test("dropped terminal records still clear lifecycle timers under sustained saturation", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-lifecycle-saturation-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", queueLimit: 1, flushDelayMs: 60_000, slowThresholdMs: 10, stderr: null });
  for (let index = 0; index < 1_000; index++) {
    const operationId = `saturated-${index}`;
    logger.record("info", "operation.accepted", { clientId: "client", operationId, kind: "run" });
    logger.record("info", "operation.settled", { clientId: "client", operationId, kind: "run", outcome: "success" });
  }
  const afterTerminals = logger.status();
  assert.equal(afterTerminals.generatedEvents, 3_000);
  assert.equal(afterTerminals.acceptedEvents, 1);
  assert.equal(afterTerminals.droppedEvents, 2_999);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(logger.status(), afterTerminals);
  await logger.close();
});

test("fresh separate processes converge on one complete install identity key", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-key-race-"));
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "diagnostics.ts")).href;
  const source = `import(${JSON.stringify(moduleUrl)}).then(async ({StructuredDiagnostics}) => { const logger = new StructuredDiagnostics({rootDir:${JSON.stringify(root)},role:"host",flushDelayMs:60000,stderr:null}); const hash = await logger.hashIdentity("shared-identity"); logger.record("info","host.ready",{}); await logger.close(); process.stdout.write(hash); }).catch(error => { console.error(error); process.exit(1); });`;
  const outputs = await Promise.all(Array.from({ length: 12 }, () => new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", rejectOutput);
    child.once("exit", code => code === 0 ? resolveOutput(stdout) : rejectOutput(new Error(stderr || `identity child exited ${code}`)));
  })));
  assert.equal(new Set(outputs).size, 1);
  assert.match(outputs[0]!, /^id-[0-9a-f]{24}$/);
  assert.equal((await readFile(join(root, "identity.key"))).length, 32);
});

test("emergency fatal persistence bypasses the retention lock and stores only fixed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-emergency-"));
  await mkdir(join(root, ".retention-lock"));
  const started = performance.now();
  await persistEmergencyDiagnostic({
    rootDir: root, role: "backend", event: "backend.unhandled_rejection",
    fields: { outcome: "error", errorCode: "unhandled_rejection", errorType: "Error", ...({ reason: "PLANTED_FATAL_SECRET" } as Record<string, string>) },
  });
  assert.ok(performance.now() - started < 250);
  const text = await logText(root);
  assert.equal(text.includes("PLANTED_FATAL_SECRET"), false);
  assert.equal(JSON.parse(text).event, "backend.unhandled_rejection");
  await rm(join(root, ".retention-lock"), { recursive: true });
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", maxSegments: 1, flushDelayMs: 60_000, stderr: null });
  logger.record("info", "host.ready", {});
  await logger.flush();
  assert.equal((await readdir(root)).filter(name => name.endsWith(".jsonl")).length, 1);
  await logger.close();
});

test("the typed event taxonomy contains every dynamic production event", () => {
  for (const event of [
    "child.kill", "operation.cancelled", "r.runtime.start", "r.runtime.restart", "persistence.conflict",
    "renderer.unhandled_rejection", "renderer.bootstrap_failed",
  ]) assert.ok((DIAGNOSTIC_EVENTS as readonly string[]).includes(event), event);
});

test("operation timing is scoped by client when operation ids collide", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-client-scope-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", flushDelayMs: 60_000, stderr: null });
  for (const clientId of ["client-one", "client-two"]) logger.record("info", "operation.accepted", { clientId, operationId: "same-operation", kind: "inspect" });
  for (const clientId of ["client-one", "client-two"]) logger.record("info", "operation.settled", { clientId, operationId: "same-operation", kind: "inspect", outcome: "success" });
  await logger.close();
  const timing = (await records(root)).filter(value => value.event === "operation.timing");
  assert.equal(timing.length, 2);
  assert.equal(new Set(timing.map(value => value.clientId)).size, 2);
  assert.equal(new Set(timing.map(value => value.operationId)).size, 1);
});

test("install pseudonyms are stable and caller-controlled strings cannot enter logs or exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-adversarial-"));
  const secret = "PLANTED-secret-/Users/person/private.R-Bearer-abc123";
  const fields = {
    appLaunchId: secret, backendInstanceId: secret, sessionId: secret, sessionEpoch: secret, documentId: secret,
    clientId: secret, operationId: secret, runId: secret, cellId: secret, childInstanceId: secret, windowId: secret,
    requestId: secret, activeRunId: secret, childRole: secret, phase: secret, kind: secret, outcome: secret,
    status: secret, reason: secret, errorCode: secret, errorType: secret, version: secret, runtimeVersion: secret,
    signal: secret, mode: secret, missingPhases: [secret], observedPhases: [secret], notApplicablePhases: [secret],
    ...({ source: secret, output: secret, token: secret, path: secret, stack: secret, environment: secret } as Record<string, string>),
  };
  const first = new StructuredDiagnostics({ rootDir: root, role: "host", appLaunchId: secret, processInstanceId: "process-a", flushDelayMs: 60_000, stderr: null });
  first.record("error", "planted.secret.event", fields);
  await first.close();
  const second = new StructuredDiagnostics({ rootDir: root, role: "backend", appLaunchId: secret, processInstanceId: "process-b", flushDelayMs: 60_000, stderr: null });
  second.record("error", "operation.failed", fields);
  await second.flush();
  const values = await records(root);
  assert.ok(values.some(value => value.event === "diagnostic.unknown_event"));
  assert.equal(new Set(values.map(value => value.appLaunchId)).size, 1);
  assert.match(String(values[0]!.appLaunchId), /^id-[0-9a-f]{24}$/);
  assert.equal((await logText(root)).includes(secret), false);
  const destination = join(await mkdtemp(join(tmpdir(), "alder-diagnostics-adversarial-export-")), "bundle");
  await exportDiagnosticBundle(second, destination, { runtime: fields, state: fields });
  const bundleText = (await readFile(join(destination, "manifest.json"), "utf8")) + await logText(join(destination, "logs"));
  assert.equal(bundleText.includes(secret), false);
  await second.close();
});

test("concurrent writers retain their live segments and enforce one hard directory cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-multiwriter-"));
  const options = { rootDir: root, queueLimit: 500, segmentBytes: 1_600, totalBytes: 10_000, maxSegments: 4, flushDelayMs: 60_000, stderr: null } as const;
  const first = new StructuredDiagnostics({ ...options, role: "host", processInstanceId: "writer-one" });
  const second = new StructuredDiagnostics({ ...options, role: "backend", processInstanceId: "writer-two" });
  for (let index = 0; index < 80; index++) { first.record("info", "host.ready", { count: index }); second.record("info", "backend.launch", { count: index }); }
  await Promise.all([first.flush(), second.flush()]);
  const names = (await readdir(root)).filter(name => name.endsWith(".jsonl"));
  const active = names.filter(name => name.includes("diagnostics-active-"));
  assert.equal(active.length, 2);
  assert.ok(names.length <= 4, names.join(","));
  const bytes = (await Promise.all(names.map(name => stat(join(root, name))))).reduce((sum, info) => sum + info.size, 0);
  assert.ok(bytes <= 10_000, String(bytes));
  for (const logger of [first, second]) {
    const status = logger.status();
    assert.equal(status.queuedEvents, 0);
    assert.equal(status.persistedEvents + status.droppedEvents + status.unavailableEvents, status.generatedEvents);
  }
  await Promise.all([first.close(), second.close()]);
});

test("export flushes peers, drains more than one batch, and cleans failed partial destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-export-drain-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "desktop", queueLimit: 2_000, flushDelayMs: 60_000, stderr: null });
  for (let index = 0; index < 1_001; index++) logger.record("info", "desktop.launch", { count: index });
  let peerFlushes = 0;
  const parent = await mkdtemp(join(tmpdir(), "alder-diagnostics-export-drain-parent-"));
  const destination = join(parent, "bundle");
  await exportDiagnosticBundle(logger, destination, { flushPeers: async () => { peerFlushes++; } });
  assert.equal(peerFlushes, 1);
  assert.equal(logger.status().queuedEvents, 0);
  assert.equal((await records(join(destination, "logs"))).length, 1_001);
  await assert.rejects(exportDiagnosticBundle(logger, destination), /EEXIST/);
  assert.ok((await readdir(destination)).includes("manifest.json"));
  const failedDestination = join(parent, "vanishing", "bundle");
  await mkdir(join(parent, "vanishing"));
  await assert.rejects(exportDiagnosticBundle(logger, failedDestination, { flushPeers: async () => { await rm(join(parent, "vanishing"), { recursive: true }); } }));
  await assert.rejects(stat(failedDestination));
  await logger.close();
});

test("logs and exported bundle exclude planted source, tokens, paths, environment values and raw payload fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-privacy-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "desktop", flushDelayMs: 0, stderr: null });
  const plantedSource = "PLANTED_SOURCE_secret_value <- 41";
  const plantedToken = "Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK";
  const plantedEnvironment = "PLANTED_ENV_SECRET";
  const plantedArbitraryPath = "/opt/alder-private/notebook.R";
  logger.record("error", "operation.failed", {
    operationId: "safe-operation", errorCode: "safe_error",
    reason: `${plantedToken} ${homedir()}/private.R ${tmpdir()}/draft ${plantedArbitraryPath}`,
    ...({ sourceText: plantedSource, environment: plantedEnvironment, mcpArguments: plantedSource } as Record<string, string>),
  });
  await logger.flush();
  const text = await logText(root);
  for (const secret of [plantedSource, plantedToken, plantedEnvironment, plantedArbitraryPath, homedir(), tmpdir()]) assert.equal(text.includes(secret), false, secret);
  const destination = join(await mkdtemp(join(tmpdir(), "alder-diagnostics-export-parent-")), "bundle");
  const bundle = await exportDiagnosticBundle(logger, destination, { cacheRoot: join(root, "missing-cache") });
  assert.ok(bundle.files >= 2);
  const manifest = await readFile(join(destination, "manifest.json"), "utf8");
  const privacy = await readFile(join(destination, "PRIVACY.txt"), "utf8");
  assert.match(privacy, /notebook and Markdown source/);
  assert.match(manifest, /"cache"/);
  assert.equal(manifest.includes(root), false);
  for (const secret of [plantedSource, plantedToken, plantedEnvironment, plantedArbitraryPath, homedir(), tmpdir()]) {
    assert.equal((manifest + privacy + await logText(join(destination, "logs"))).includes(secret), false, secret);
  }
  await logger.close();
});

test("corrupt recovery pruning retains the newest evidence and bounds older copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-recovery-prune-"));
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < 9; index++) {
    const path = join(directory, `corrupt-${index}.json`);
    await writeFile(path, String(index));
    const time = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    await utimes(path, time, time);
  }
  assert.equal(await pruneCorruptRecoveryCopies(directory, { retain: 5, maxAgeMs: 2 * 24 * 60 * 60 * 1000 }), 6);
  const retained = (await readdir(directory)).filter(name => name.startsWith("corrupt-"));
  assert.deepEqual(retained.sort(), ["corrupt-0.json", "corrupt-1.json", "corrupt-2.json"]);
});
