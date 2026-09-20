import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StructuredDiagnostics,
  diagnosticError,
  exportDiagnosticBundle,
  persistEmergencyDiagnostic,
  pruneCorruptRecoveryCopies,
  queryDiagnostics,
} from "../src/diagnostics.js";

async function records(root: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith(".jsonl")) continue;
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
  await Promise.all([first.close(), second.close()]);
  const status = await queryDiagnostics("status", { rootDir: root });
  assert.equal(Number(status.retainedBytes) <= 20_000, true);
  assert.equal(Number(status.segmentCount) <= 16, true);
  assert.equal(Number(status.droppedRecords) > 0, true);
  const text = JSON.stringify(await records(root));
  assert.match(text, /"writer":"first"/);
  assert.match(text, /"writer":"second"/);
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
});

test("unavailable storage never blocks callers and is observable in logger and query health", async () => {
  const parent = await mkdtemp(join(tmpdir(), "alder-diagnostics-unavailable-"));
  const root = join(parent, "not-a-directory");
  await writeFile(root, "occupied");
  const logger = new StructuredDiagnostics({ rootDir: root, role: "host", flushDelayMs: 0, stderr: null });
  logger.record("error", "host.fatal", { source: "still accepted by caller" });
  await logger.flush();
  assert.equal(logger.status().available, false);
  assert.equal(logger.status().unavailableEvents, 1);
  const status = await queryDiagnostics("status", { rootDir: root });
  assert.equal(status.available, false);
  assert.equal(status.degraded, true);
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
