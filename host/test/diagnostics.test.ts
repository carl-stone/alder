import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  StructuredDiagnostics,
  diagnosticError,
  exportDiagnosticBundle,
  persistEmergencyDiagnostic,
  pruneCorruptRecoveryCopies,
  queryDiagnostics,
  writeDiagnosticRecordSidecar,
} from "../src/diagnostics.js";

async function records(root: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith(".jsonl") && !/^diagnostics-record-.*\.json$/.test(name)) continue;
    for (const line of (await readFile(join(root, name), "utf8")).split("\n")) {
      if (line.trim()) values.push(JSON.parse(line));
    }
  }
  return values.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

test("raw source, output, paths, environment, identifiers and exact error causes survive persistence and queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-raw-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", flushDelayMs: 60_000, stderr: null });
  const cause = new Error("inner exact cause");
  cause.stack = "INNER_STACK_SENTINEL";
  const error = new Error("outer exact failure", { cause });
  error.stack = "OUTER_STACK_SENTINEL";
  const fields = {
    operationId: "operation-raw-123", clientId: "client-raw-456", path: "/private/project/notebook.R",
    source: ["secret_value <- 41", "secret_value + 1"], output: { text: "[1] 42" },
    environment: { ALDER_TEST_RAW_CONTEXT: "environment-value" }, error: diagnosticError(error),
  };
  logger.record("error", "operation.failed", fields);
  await logger.close();

  const text = JSON.stringify(await records(root));
  for (const expected of ["operation-raw-123", "client-raw-456", "/private/project/notebook.R", "secret_value <- 41", "[1] 42", "environment-value", "outer exact failure", "OUTER_STACK_SENTINEL", "inner exact cause", "INNER_STACK_SENTINEL"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const errors = await queryDiagnostics("errors", { rootDir: root, id: "operation-raw-123" });
  assert.equal((errors.records as unknown[]).length, 1);
  const incident = await queryDiagnostics("incident", { rootDir: root, id: "operation-raw-123" });
  assert.equal((incident.records as unknown[]).length, 1);
  assert.equal(JSON.stringify(incident).includes("OUTER_STACK_SENTINEL"), true);
});

test("rotation, concurrent writers and queue saturation retain bounded readable evidence and persisted health", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-bounds-"));
  const first = new StructuredDiagnostics({ rootDir: root, role: "desktop", segmentBytes: 1_200, totalBytes: 20_000, maxSegments: 16, queueLimit: 8, flushDelayMs: 60_000, stderr: null });
  const second = new StructuredDiagnostics({ rootDir: root, role: "backend", segmentBytes: 1_200, totalBytes: 20_000, maxSegments: 16, flushDelayMs: 60_000, stderr: null });
  for (let index = 0; index < 30; index++) first.record("info", "test.first", { writer: "first", index, payload: "x".repeat(80) });
  for (let index = 0; index < 12; index++) second.record("info", "test.second", { writer: "second", index, payload: "y".repeat(80) });
  await first.recordDurable("error", "operation.failed", { operationId: "durable-under-saturation", outcome: "error" });
  await Promise.all([first.close(), second.close()]);
  const status = await queryDiagnostics("status", { rootDir: root });
  assert.equal(Number(status.retainedBytes) <= 20_000, true);
  assert.equal(Number(status.segmentCount) <= 16, true);
  assert.equal(Number(status.droppedRecords) > 0, true);
  const text = JSON.stringify(await records(root));
  assert.match(text, /"writer":"first"/);
  assert.match(text, /"writer":"second"/);
  assert.match(text, /durable-under-saturation/);
});

test("queries ignore a malformed or truncated tail and never mutate diagnostic files", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-tail-"));
  const path = join(root, "diagnostics-recovered-tail.jsonl");
  const valid = { schemaVersion: 2, timestamp: "2026-09-19T12:00:00.000Z", severity: "error", event: "host.fatal", appLaunchId: "launch-tail", error: { message: "kept" } };
  await writeFile(path, JSON.stringify(valid) + "\n{\"timestamp\":\"truncated", { mode: 0o600 });
  const before = await readFile(path);
  const beforeStat = await stat(path);
  const result = await queryDiagnostics("incident", { rootDir: root, id: "launch-tail" });
  assert.equal(result.malformedRecords, 1);
  assert.equal((result.records as unknown[]).length, 1);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs);
  await assert.rejects(queryDiagnostics("incident", { rootDir: root, since: "bad-time" }), /valid ISO/);
  await assert.rejects(queryDiagnostics("incident", { rootDir: root, since: "2026-09-20T02:00:00Z", until: "2026-09-20T01:00:00Z" }), /must not be later/);
});

test("a segment pruned after the query snapshot cannot discard already readable evidence", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-query-prune-race-"));
  const vanished = join(root, "diagnostics-old.jsonl");
  const gate = join(root, "diagnostics-newest-gate.jsonl");
  await writeFile(vanished, JSON.stringify({
    schemaVersion: 2, timestamp: "2026-09-19T00:00:00.000Z", severity: "error", event: "operation.failed", operationId: "vanished",
  }) + "\n");
  const fifo = spawnSync("mkfifo", [gate], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const future = new Date(Date.now() + 10_000);
  await utimes(gate, future, future);

  const pending = queryDiagnostics("errors", { rootDir: root, limit: 10 });
  const writer = await open(gate, "w"); // Resolves only after readStore has snapshotted both paths and opened the newest one.
  await unlink(vanished);
  await writer.writeFile(JSON.stringify({
    schemaVersion: 2, timestamp: "2026-09-20T00:00:00.000Z", severity: "error", event: "host.fatal", error: { message: "retained after prune race" },
  }) + "\n");
  await writer.close();

  const result = await pending;
  assert.equal("readError" in result, false);
  assert.equal((result.records as unknown[]).length, 1);
  assert.equal(JSON.stringify(result).includes("retained after prune race"), true);
});

test("bounded queries select newest matching evidence beyond 200000 older records", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-query-cap-"));
  const oldPath = join(root, "diagnostics-older.jsonl");
  const newPath = join(root, "diagnostics-newer.jsonl");
  const oldLine = JSON.stringify({ schemaVersion: 2, timestamp: "2026-09-01T00:00:00.000Z", severity: "info", event: "host.ready" }) + "\n";
  await writeFile(oldPath, oldLine.repeat(200_100), { mode: 0o600 });
  await utimes(oldPath, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
  const latest = [
    { schemaVersion: 2, timestamp: "2026-09-20T01:00:00.000Z", severity: "info", event: "operation.accepted", appLaunchId: "latest-launch", backendInstanceId: "latest-backend", sessionEpoch: "latest-epoch", clientId: "client", operationId: "latest-incident", kind: "run" },
    { schemaVersion: 2, timestamp: "2026-09-20T01:00:01.000Z", severity: "warn", event: "operation.slow", appLaunchId: "latest-launch", backendInstanceId: "latest-backend", sessionEpoch: "latest-epoch", clientId: "client", operationId: "latest-incident", kind: "run", durationMs: 8000 },
    { schemaVersion: 2, timestamp: "2026-09-20T01:00:02.000Z", severity: "error", event: "operation.failed", appLaunchId: "latest-launch", backendInstanceId: "latest-backend", sessionEpoch: "latest-epoch", clientId: "client", operationId: "latest-error", error: { message: "latest retained failure" } },
  ];
  await writeFile(newPath, latest.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });

  const incident = await queryDiagnostics("incident", { rootDir: root, id: "latest-incident", limit: 10 });
  assert.equal((incident.records as unknown[]).length, 2);
  assert.equal(incident.scannedRecords, 2);
  const errors = await queryDiagnostics("errors", { rootDir: root, limit: 10 });
  assert.equal(JSON.stringify(errors).includes("latest retained failure"), true);
  const operations = await queryDiagnostics("operations", { rootDir: root, slowMs: 100, limit: 10 });
  assert.equal(JSON.stringify(operations).includes("latest-incident"), true);
  const recent = await queryDiagnostics("incident", { rootDir: root, since: "2026-09-20T00:00:00.000Z", limit: 10 });
  assert.equal((recent.records as unknown[]).length, 3);
  assert.equal(recent.examinedRecords, 3);
});

test("oversized failed operations use retained sidecars and remain visible through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-oversized-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", segmentBytes: 10 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, maxSegments: 8, flushDelayMs: 60_000, stderr: null });
  const output = "RAW_OVERSIZED_OUTPUT_" + "x".repeat(11 * 1024 * 1024);
  await logger.recordDurable("error", "operation.failed", {
    appLaunchId: "oversized-launch", sessionEpoch: "oversized-epoch", clientId: "client", operationId: "oversized-operation",
    error: { message: "oversized realistic failure", stack: "OVERSIZED_STACK" }, notebookContext: { cells: [{ id: "cell-1", source: ["stop('oversized')"], output }] },
  });
  await logger.close();
  const sidecars = (await readdir(root)).filter(name => /^diagnostics-record-.*\.json$/.test(name));
  assert.equal(sidecars.length, 1);
  const queried = await queryDiagnostics("errors", { rootDir: root, limit: 5 });
  assert.equal(JSON.stringify(queried).includes("RAW_OVERSIZED_OUTPUT_"), true);
  const cli = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", "diagnostics", "errors", "--limit", "5"], {
    cwd: resolve("."), env: { ...process.env, ALDER_DIAGNOSTICS_DIR: root }, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.includes("OVERSIZED_STACK"), true);
});

test("failed oversized sidecar commits remove their own temporary", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-sidecar-failure-"));
  const destination = join(root, `diagnostics-record-20260920000000000-host-${process.pid}-${randomUUID()}.json`);
  await mkdir(destination);
  await assert.rejects(writeDiagnosticRecordSidecar(destination, "oversized record"));
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith(".tmp")), []);
});

test("initialization removes crashed oversized temporaries, preserves a live writer, and enforces the retained cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-sidecar-orphans-"));
  const dead = `diagnostics-record-20260920000000000-host-99999999-${randomUUID()}.json.${randomUUID()}.tmp`;
  const live = `diagnostics-record-20260920000000001-host-${process.pid}-${randomUUID()}.json.${randomUUID()}.tmp`;
  await writeFile(join(root, dead), "d".repeat(16_384));
  await writeFile(join(root, live), "live writer");
  const logger = new StructuredDiagnostics({
    rootDir: root, role: "host", segmentBytes: 1_024, totalBytes: 4_096, maxSegments: 4,
    flushDelayMs: 60_000, stderr: null,
  });
  await logger.recordDurable("error", "operation.failed", { operationId: "after-orphan-cleanup", error: { message: "retained" } });
  await logger.close();

  const names = await readdir(root);
  assert.equal(names.includes(dead), false);
  assert.equal(names.includes(live), true);
  const status = await queryDiagnostics("status", { rootDir: root });
  assert.equal(Number(status.retainedBytes) <= 4_096, true);
  assert.equal(Number(status.segmentCount) <= 4, true);
});

test("unavailable storage never blocks callers and is observable in logger and query health", async () => {
  const parent = await mkdtemp(join(tmpdir(), "alder-diagnostics-unavailable-"));
  const root = join(parent, "not-a-directory");
  await writeFile(root, "occupied");
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", flushDelayMs: 0, stderr: null });
  logger.record("error", "host.fatal", { source: "still accepted by caller" });
  await logger.recordDurable("error", "host.fatal", { source: "durable caller also continues" });
  assert.equal(logger.status().available, false);
  assert.equal(logger.status().unavailableEvents >= 1, true);
  const status = await queryDiagnostics("status", { rootDir: root });
  assert.equal(status.available, false);
  assert.equal(status.degraded, true);
});

test("a durable terminal record survives immediate process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-durable-exit-"));
  const script = join(root, "durable-exit.mts");
  const diagnosticsUrl = pathToFileURL(resolve("src/diagnostics.ts")).href;
  await writeFile(script, `import { StructuredDiagnostics } from ${JSON.stringify(diagnosticsUrl)};\nconst logger = new StructuredDiagnostics({ rootDir: ${JSON.stringify(root)}, role: "host", flushDelayMs: 60000, stderr: null });\nawait logger.recordDurable("error", "operation.failed", { appLaunchId: "forced-exit-launch", sessionEpoch: "forced-exit-epoch", clientId: "client", operationId: "forced-exit-operation", error: { message: "forced exit terminal" } });\nprocess.exit(23);\n`);
  const child = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(child.status, 23, child.stderr);
  const result = await queryDiagnostics("incident", { rootDir: root, id: "forced-exit-operation" });
  assert.equal((result.records as unknown[]).length, 1);
  assert.equal(JSON.stringify(result).includes("forced exit terminal"), true);
});

test("slow and incomplete operations and performance summaries are scoped by raw identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-operations-"));
  let monotonic = 0;
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", slowThresholdMs: 60_000, monotonicNow: () => monotonic, flushDelayMs: 60_000, stderr: null });
  logger.record("info", "operation.accepted", { operationId: "complete", clientId: "client", kind: "run" });
  monotonic = 8_000;
  logger.record("info", "operation.settled", { operationId: "complete", clientId: "client", kind: "run", durationMs: 8_000 });
  logger.record("info", "operation.accepted", { operationId: "incomplete", clientId: "client", kind: "publish" });
  logger.record("info", "operation.accepted", { operationId: "other-client-operation", clientId: "other", kind: "save" });
  await logger.close();
  const operations = await queryDiagnostics("operations", { rootDir: root, slowMs: 5_000 });
  assert.equal((operations.operations as unknown[]).length, 3);
  const exact = await queryDiagnostics("incident", { rootDir: root, id: "incomplete" });
  assert.equal((exact.records as unknown[]).length, 1);
  assert.equal(JSON.stringify(exact).includes("other-client-operation"), false);
  const performance = await queryDiagnostics("performance", { rootDir: root });
  assert.equal((performance.summaries as Array<{ kind: string }>).some(summary => summary.kind === "run"), true);
});

test("operation reconstruction keeps reused identities separate across launches and sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-operation-scope-"));
  const writeOperation = async (appLaunchId: string, backendInstanceId: string, sessionEpoch: string, terminal?: "operation.settled" | "operation.failed") => {
    const logger = new StructuredDiagnostics({ rootDir: root, role: "backend", appLaunchId, backendInstanceId, flushDelayMs: 60_000, stderr: null });
    const identity = { sessionEpoch, clientId: "reused-client", operationId: "reused-operation", kind: "run" };
    logger.record("info", "operation.accepted", identity);
    if (terminal) logger.record(terminal === "operation.failed" ? "error" : "info", terminal, { ...identity, outcome: terminal === "operation.failed" ? "error" : "success", durationMs: 9_000 });
    await logger.close();
  };
  await writeOperation("launch-complete", "backend-complete", "epoch-complete", "operation.settled");
  await writeOperation("launch-failed", "backend-failed", "epoch-failed", "operation.failed");
  await writeOperation("launch-incomplete", "backend-incomplete", "epoch-incomplete");
  const result = await queryDiagnostics("operations", { rootDir: root, slowMs: 5_000, limit: 10 });
  const operations = result.operations as Array<{ accepted: { appLaunchId: string }; terminal?: { event: string } }>;
  assert.equal(operations.length, 3);
  assert.deepEqual(operations.map(item => [item.accepted.appLaunchId, item.terminal?.event ?? "incomplete"]), [
    ["launch-complete", "operation.settled"], ["launch-failed", "operation.failed"], ["launch-incomplete", "incomplete"],
  ]);
});

test("fatal emergency evidence is fsynced with raw stack and cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-emergency-"));
  const cause = new Error("emergency cause"); cause.stack = "EMERGENCY_CAUSE_STACK";
  const error = new Error("emergency outer", { cause }); error.stack = "EMERGENCY_OUTER_STACK";
  const path = await persistEmergencyDiagnostic({
    rootDir: root, role: "backend", event: "backend.uncaught_exception",
    fields: { error: diagnosticError(error), path: "/private/emergency/notebook.R", source: "stop('boom')" },
  });
  const text = await readFile(path, "utf8");
  for (const expected of ["EMERGENCY_OUTER_STACK", "EMERGENCY_CAUSE_STACK", "/private/emergency/notebook.R", "stop('boom')"]) assert.equal(text.includes(expected), true);
});

test("portable copies contain raw records and no privacy manifest or censored path", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-diagnostics-copy-"));
  const logger = new StructuredDiagnostics({ rootDir: root, role: "desktop", flushDelayMs: 60_000, stderr: null });
  logger.record("error", "renderer.error", { path: "/private/raw.R", source: "token <- 'raw-value'" });
  const destination = join(await mkdtemp(join(tmpdir(), "alder-diagnostics-copy-parent-")), "copy");
  await exportDiagnosticBundle(logger, destination, { runtime: { environment: { RAW_ENV: "raw-environment" } } });
  assert.equal((await readdir(destination)).includes("PRIVACY.txt"), false);
  assert.equal((await readFile(join(destination, "manifest.json"), "utf8")).includes("no fields are redacted"), true);
  assert.equal(JSON.stringify(await records(join(destination, "logs"))).includes("/private/raw.R"), true);
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
