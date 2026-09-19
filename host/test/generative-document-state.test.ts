import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { startHost, type RunningHost } from "../src/application.js";
import { parseHostCommand, type CommandResult } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";
import { SeededRandom, seedLabel } from "./seeded.js";

const SEED = 0xd0c52026;
const CASES = 3;
const ACTIONS = 16;
const ACTION_KINDS = ["edit", "save", "external", "crash-reopen", "save-copy", "discard", "detach"] as const;
type Action = typeof ACTION_KINDS[number];

test("seeded document and recovery sequences preserve accepted work, disk, revisions, and identity", { timeout: 30_000 }, async (context) => {
  context.diagnostic(`seed=${seedLabel(SEED)} cases=${CASES} actions=${ACTIONS} watcherTimeoutMs=2500`);
  const random = new SeededRandom(SEED);
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const required: Action[] = ["edit", "detach", "save", "edit", "external", "crash-reopen", "save-copy", "edit", "external", "discard"];
    const sequence = [...required, ...Array.from({ length: ACTIONS - required.length }, () => random.pick(ACTION_KINDS))];
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
        // Replace the process after its acknowledged recovery write, without saving source.
        await primary.close();
        primary = await open(primaryPath, directory, recoveryDirectory);
        const snapshot = primary.controller.snapshot();
        assert.equal(snapshot.cells[0]!.body[0], dirty ? working : sourceBody(disk), label(action, step));
        assert.equal(await readFile(primaryPath, "utf8"), disk, label(action, step));
        if (dirty) {
          const recovery = await primary.controller.query({ type: "recovery" });
          assert.ok(recovery.result.candidate !== null, label(action, step));
        }
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
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const candidate = current.filter((_, candidateIndex) => candidateIndex !== index);
    if (candidate.length > 0 && await runSequence(candidate, caseIndex) !== null) current = candidate;
  }
  return current;
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
