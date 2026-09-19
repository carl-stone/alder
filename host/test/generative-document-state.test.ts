import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startHost, type RunningHost } from "../src/application.js";
import { parseHostCommand, type CommandResult } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";
import { SeededRandom, seedLabel } from "./seeded.js";

const SEED = 0xd0c52026;
const CASES = 4;
const ACTIONS = 12;
const ACTION_KINDS = ["edit", "save", "external", "crash-reopen", "save-copy", "discard", "detach"] as const;
type Action = typeof ACTION_KINDS[number];

const crashPath = process.env.ALDER_GENERATED_CRASH_PATH;
if (crashPath !== undefined) {
  const recoveryDirectory = process.env.ALDER_GENERATED_RECOVERY_DIRECTORY!;
  const resourceRoot = process.env.ALDER_GENERATED_RESOURCE_ROOT!;
  const body = process.env.ALDER_GENERATED_CRASH_BODY!;
  const app = await open(crashPath, resourceRoot, recoveryDirectory);
  const cell = app.controller.snapshot().cells[0]!;
  const result = await dispatch(app, { type: "transaction", changes: [{
    type: "edit", cell: { cellId: cell.id }, expectedRevision: cell.revision, cellType: "code", body: [body],
  }] });
  if (result.error !== null) throw new Error(`crash child edit failed: ${JSON.stringify(result.error)}`);
  const snapshot = app.controller.snapshot();
  process.send?.({ acknowledged: true, snapshot: {
    documentRevision: snapshot.documentRevision,
    path: snapshot.path,
    cells: snapshot.cells.map((value) => ({ id: value.id, revision: value.revision })),
    disk: snapshot.disk,
  } });
  setInterval(() => {}, 60_000);
} else test("seeded document and recovery sequences preserve accepted work, disk, revisions, and identity", { timeout: 45_000 }, async (context) => {
  context.diagnostic(`seed=${seedLabel(SEED)} cases=${CASES} actions=${ACTIONS} watcherTimeoutMs=2500`);
  const random = new SeededRandom(SEED);
  const sequences = Array.from({ length: CASES }, (_, caseIndex) => generateSequence(random, caseIndex));
  const coverage = new Set(sequences.flat());
  assert.deepEqual([...ACTION_KINDS].filter((action) => !coverage.has(action)), [], "generated run omitted required action coverage");
  context.diagnostic(`sequences=${JSON.stringify(sequences)}`);
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const sequence = sequences[caseIndex]!;
    const failure = await runSequence(sequence, caseIndex);
    if (failure === null) continue;
    const minimized = await minimize(sequence, caseIndex);
    assert.fail(`${failure}; seed=${seedLabel(SEED)} case=${caseIndex} minimized=${JSON.stringify(minimized)}`);
  }
});

async function runSequence(sequence: readonly Action[], caseIndex: number): Promise<string | null> {
  try {
    await verifySequence(sequence, caseIndex);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function verifySequence(sequence: readonly Action[], caseIndex: number): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `alder-state-${caseIndex}-`)));
  const primaryPath = join(directory, "primary.R");
  const secondaryPath = join(directory, "secondary.R");
  const recoveryDirectory = join(directory, "recovery");
  const initialPrimary = "value <- 0";
  const initialSecondary = "other <- 100";
  await writeFile(primaryPath, notebookSource(initialPrimary));
  await writeFile(secondaryPath, notebookSource(initialSecondary));
  let primary: RunningHost | undefined;
  let secondary: RunningHost | undefined;
  let working = initialPrimary;
  let disk = notebookSource(initialPrimary);
  let dirty = false;
  let conflict = false;
  const revisionsByEpoch = new Map<string, number>();
  let editNumber = 0;
  let externalNumber = 0;
  let copyNumber = 0;
  const savedAccepted = new Set<string>([working]);
  try {
    primary = await open(primaryPath, directory, recoveryDirectory);
    secondary = await open(secondaryPath, directory, recoveryDirectory);
    secondary.controller.registerClient("secondary-client");
    primary.controller.registerClient("primary-a");
    primary.controller.registerClient("primary-b");
    for (let step = 0; step < sequence.length; step += 1) {
      const action = sequence[step]!;
      const beforeDisk = await readFile(primaryPath, "utf8");
      if (action === "edit") {
        const next = `value <- ${caseIndex * 1000 + ++editNumber}`;
        const cell = primary.controller.snapshot().cells[0]!;
        const result = await dispatch(primary, { type: "transaction", changes: [{
          type: "edit", cell: { cellId: cell.id }, expectedRevision: cell.revision,
          cellType: "code", body: [next],
        }] });
        requireSuccess(result, action, step);
        working = next;
        dirty = true;
        assert.equal(primary.controller.snapshot().cells[0]!.body[0], working);
        assert.equal(await readFile(primaryPath, "utf8"), beforeDisk, label(action, step));
      } else if (action === "save") {
        const result = await dispatch(primary, { type: "save" });
        if (conflict) {
          assert.ok(result.error?.code === "recovery_conflict" || result.error?.code === "source_conflict", label(action, step));
          assert.equal(await readFile(primaryPath, "utf8"), beforeDisk, label(action, step));
        } else {
          requireSuccess(result, action, step);
          disk = notebookSource(working);
          savedAccepted.add(working);
          dirty = false;
          assert.equal(await readFile(primaryPath, "utf8"), disk, label(action, step));
        }
      } else if (action === "external") {
        const external = `external <- ${caseIndex * 1000 + ++externalNumber}`;
        const previousDigest = primary.controller.snapshot().disk.digest;
        disk = notebookSource(external);
        await writeFile(primaryPath, disk);
        if (dirty) {
          await awaitSnapshot(primary, (app) => app.controller.snapshot().disk.digest !== previousDigest);
          conflict = true;
          assert.equal(primary.controller.snapshot().cells[0]!.body[0], working, label(action, step));
        } else {
          await awaitSnapshot(primary, (app) => app.controller.snapshot().cells[0]?.body[0] === external);
          working = external;
          conflict = false;
        }
      } else if (action === "crash-reopen") {
        await primary.close();
        primary = undefined;
        const replacement = await crashAndReopen(primaryPath, directory, recoveryDirectory,
          `value <- ${caseIndex * 1000 + ++editNumber}`, step);
        primary = replacement.app;
        working = replacement.body;
        dirty = true;
        conflict = replacement.conflict;
        const snapshot = primary.controller.snapshot();
        assert.equal(snapshot.cells[0]!.body[0], working, label(action, step));
        assert.equal(await readFile(primaryPath, "utf8"), disk, label(action, step));
        const recovery = await primary.controller.query({ type: "recovery" });
        assert.ok(recovery.result.candidate !== null, label(action, step));
      } else if (action === "save-copy") {
        const copy = join(directory, `copy-${copyNumber++}.R`);
        const result = await dispatch(primary, { type: "save-as", path: copy, expectedDestination: "absent" });
        requireSuccess(result, action, step);
        assert.equal(await readFile(copy, "utf8"), notebookSource(working), label(action, step));
        assert.equal(await readFile(primaryPath, "utf8"), beforeDisk, label(action, step));
        savedAccepted.add(working);
        await primary.close();
        primary = await open(primaryPath, directory, recoveryDirectory);
        working = sourceBody(disk);
        dirty = false;
        conflict = false;
      } else if (action === "discard") {
        if (dirty) {
          const snapshot = primary.controller.snapshot();
          assert.equal(snapshot.disk.state, "present", label(action, step));
          const result = await dispatch(primary, {
            type: "reload-source", expectedDiskDigest: snapshot.disk.digest,
            expectedDiskVersion: snapshot.disk.version, discardRecovery: true,
          });
          requireSuccess(result, action, step);
          working = sourceBody(disk);
          dirty = false;
          conflict = false;
          assert.equal(primary.controller.snapshot().cells[0]!.body[0], working, label(action, step));
        }
      } else {
        const before = primary.controller.snapshot();
        primary.controller.releaseClient("primary-a");
        primary.controller.registerClient("primary-a");
        assert.equal(primary.controller.snapshot().cells[0]!.body[0], before.cells[0]!.body[0], label(action, step));
        assert.deepEqual(secondary.controller.snapshot().activeClientIds, ["secondary-client"], label(action, step));
      }

      const snapshot = primary.controller.snapshot();
      const priorRevision = revisionsByEpoch.get(snapshot.epoch) ?? 0;
      assert.ok(snapshot.documentRevision >= priorRevision, `revision regressed within epoch; ${label(action, step)}`);
      revisionsByEpoch.set(snapshot.epoch, snapshot.documentRevision);
      assert.equal(await readFile(secondaryPath, "utf8"), notebookSource(initialSecondary), `identity leaked; ${label(action, step)}`);
      assert.equal(secondary.controller.snapshot().cells[0]!.body[0], initialSecondary, `session leaked; ${label(action, step)}`);
      assert.equal(await readFile(primaryPath, "utf8"), disk, `implicit disk write; ${label(action, step)}`);
      if (dirty) assert.equal(snapshot.cells[0]!.body[0], working, `accepted edit lost; ${label(action, step)}`);
    }
    if (dirty && !conflict) {
      const result = await dispatch(primary, { type: "save" });
      requireSuccess(result, "save", sequence.length);
      savedAccepted.add(working);
      dirty = false;
    } else if (dirty) {
      await primary.close();
      primary = await open(primaryPath, directory, recoveryDirectory);
      assert.equal(primary.controller.snapshot().cells[0]!.body[0], working, "final accepted edit was not retained in recovery");
      assert.equal(await readFile(primaryPath, "utf8"), disk, "final recovery reopen overwrote disk");
    }
    assert.ok(dirty || savedAccepted.has(working) || working === sourceBody(disk), "final accepted work was neither retained, saved, nor explicitly discarded");
  } finally {
    await primary?.close().catch(() => {});
    await secondary?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function minimize(sequence: readonly Action[], caseIndex: number): Promise<Action[]> {
  let current = [...sequence];
  let attempts = 0;
  for (let index = current.length - 1; index >= 0 && attempts < 6; index -= 1, attempts += 1) {
    const candidate = current.filter((_, candidateIndex) => candidateIndex !== index);
    if (candidate.length > 0 && await runSequence(candidate, caseIndex) !== null) current = candidate;
  }
  return current;
}

function generateSequence(random: SeededRandom, caseIndex: number): Action[] {
  const requiredByCase: readonly (readonly Action[])[] = [
    ["edit", "crash-reopen", "save"],
    ["edit", "external", "save-copy"],
    ["detach", "edit", "external", "discard"],
    ["edit", "crash-reopen", "save", "detach"],
  ];
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const missing = new Set(requiredByCase[caseIndex] ?? []);
    const sequence: Action[] = [];
    let dirty = false, conflict = false, crashed = false;
    for (let step = 0; step < ACTIONS; step += 1) {
      const valid = ACTION_KINDS.filter((action) => {
        if (action === "save") return dirty && !conflict;
        if (action === "save-copy" || action === "discard") return dirty;
        if (action === "crash-reopen") return !crashed && missing.has(action);
        return true;
      });
      const required = valid.filter((action) => missing.has(action));
      const remaining = ACTIONS - step;
      const pool = required.length > 0 && (random.boolean(0.55) || remaining <= missing.size + 2) ? required : valid;
      const action = random.pick(pool);
      sequence.push(action);
      missing.delete(action);
      if (action === "edit" || action === "crash-reopen") dirty = true;
      if (action === "crash-reopen") crashed = true;
      if (action === "external") conflict = dirty;
      if (action === "save" || action === "save-copy" || action === "discard") { dirty = false; conflict = false; }
    }
    if (missing.size === 0) return sequence;
  }
  throw new Error(`could not generate a valid sequence for case ${caseIndex}`);
}

async function crashAndReopen(path: string, resourceRoot: string, recoveryDirectory: string, body: string, step: number): Promise<{
  app: RunningHost;
  body: string;
  conflict: boolean;
}> {
  const child = fork(fileURLToPath(import.meta.url), {
    execArgv: ["--import", "tsx"],
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      ALDER_GENERATED_CRASH_PATH: path,
      ALDER_GENERATED_RECOVERY_DIRECTORY: recoveryDirectory,
      ALDER_GENERATED_RESOURCE_ROOT: resourceRoot,
      ALDER_GENERATED_CRASH_BODY: body,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const diagnostics: Buffer[] = [];
  child.stderr?.on("data", (chunk) => diagnostics.push(Buffer.from(chunk)));
  const exit = once(child, "exit");
  try {
    const delivered = await Promise.race([
      once(child, "message").then(([message]) => message),
      exit.then(([code, signal]) => { throw new Error(`crash child exited before acknowledgement: ${code}/${signal}`); }),
    ]) as CrashAcknowledgement;
    assert.equal(delivered.acknowledged, true, label("crash-reopen", step));
    const journal = await recoveryJournalFor(recoveryDirectory, path);
    const expected = expectedCrashBaseline(delivered.snapshot, body);
    const expectedFingerprint = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
    assert.deepEqual(journal, { schemaVersion: 1, baseline: expected, fingerprint: expectedFingerprint },
      `acknowledged recovery was not durable before crash; ${label("crash-reopen", step)}`);
    child.kill("SIGKILL");
    await exit;
    const app = await open(path, resourceRoot, recoveryDirectory);
    const recovery = await app.controller.query({ type: "recovery" });
    assert.equal(app.controller.snapshot().cells[0]!.body[0], body, label("crash-reopen", step));
    assert.ok(recovery.result.candidate !== null, label("crash-reopen", step));
    return { app, body, conflict: recovery.result.candidate?.state === "conflict" };
  } catch (error) {
    const stderr = Buffer.concat(diagnostics).toString("utf8").trim();
    if (stderr) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit.catch(() => undefined);
    }
  }
}

interface CrashAcknowledgement {
  acknowledged: boolean;
  snapshot: {
    documentRevision: number;
    path: string | null;
    cells: Array<{ id: string; revision: number }>;
    disk: { state: "untitled" | "absent" | "present" | "unreadable"; digest: string | null; version: string | null };
  };
}

function expectedCrashBaseline(snapshot: CrashAcknowledgement["snapshot"], body: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    physicalBytes: Buffer.from(notebookSource(body)).toString("base64"),
    documentRevision: snapshot.documentRevision,
    cells: snapshot.cells,
    path: snapshot.path,
    notebookDiskObservation: snapshot.disk.state === "unreadable"
      ? { state: "unreadable", digest: null, version: null, error: { code: "disk_unreadable", message: "disk observation was unreadable" } }
      : { state: snapshot.disk.state, digest: snapshot.disk.digest, version: snapshot.disk.version, error: null },
  };
}

async function recoveryJournalFor(recoveryDirectory: string, path: string): Promise<Record<string, unknown>> {
  for (const entry of await readdir(recoveryDirectory)) {
    if (!entry.startsWith("recovery-")) continue;
    try {
      const journal = JSON.parse(await readFile(join(recoveryDirectory, entry, "journal.json"), "utf8")) as Record<string, unknown>;
      const baseline = journal.baseline as { path?: unknown } | undefined;
      if (baseline?.path === path) return journal;
    } catch { /* another session may not currently have a journal */ }
  }
  throw new Error(`no durable recovery journal found for ${path}`);
}

async function open(path: string, resourceRoot: string, recoveryDirectory: string): Promise<RunningHost> {
  return startHost({ path, resources: resources(resourceRoot), recoveryDirectory, runOnStartup: false });
}

function resources(root: string): ApplicationResources {
  return {
    root, cliLauncher: join(root, "alder"), hostEntry: join(root, "host.mjs"), rendererDirectory: join(root, "renderer"),
    workerDirectory: join(root, "worker"), rLibraryDirectory: join(root, "r-library"), arkExecutable: join(root, "ark"),
    airExecutable: join(root, "air"), quartoExecutable: join(root, "quarto"), nodeExecutable: process.execPath, electronEntry: null,
  };
}

async function dispatch(app: RunningHost, value: Record<string, unknown>): Promise<CommandResult> {
  const snapshot = app.controller.snapshot();
  return app.controller.dispatch(parseHostCommand({
    ...value, requestId: randomUUID(), clientId: "generated-client", sessionEpoch: snapshot.epoch,
    expectedDocumentRevision: snapshot.documentRevision,
  }));
}

function requireSuccess(result: CommandResult, action: Action, step: number): void {
  assert.equal(result.error, null, `${label(action, step)}: ${JSON.stringify(result.error)}`);
}

async function awaitSnapshot(app: RunningHost, predicate: (app: RunningHost) => boolean): Promise<void> {
  if (predicate(app)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("watcher state did not settle")); }, 2_500);
    const unsubscribe = app.controller.subscribe(() => {
      if (!predicate(app)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function notebookSource(body: string): string { return `# %%\n${body}\n`; }
function sourceBody(source: string): string { return source.split(/\r?\n/)[1] ?? ""; }
function label(action: Action, step: number): string { return `action=${action} step=${step}`; }
