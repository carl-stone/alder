import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RecoveryWriter, type RecoveryBaseline } from "../src/recovery.js";
import { startHost, type RunningHost } from "../src/application.js";
import { parseHostCommand } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";

const absent = { state: "absent" as const, digest: null, version: null, error: null };
function baseline(text: string, revision = 0): RecoveryBaseline {
  return { schemaVersion: 1, documentRevision: revision, physicalBytes: Buffer.from(text),
    cells: [{ id: "cell-1", revision }], notebookDiskObservation: absent,
    sidecarObservations: { config: absent, layout: absent, packages: absent } };
}
const textOf = (value: RecoveryBaseline): string => Buffer.from(value.physicalBytes as string, "base64").toString("utf8");
function resources(root: string): ApplicationResources {
  return { root, cliLauncher: join(root, "alder"), hostEntry: join(root, "host.mjs"),
    rendererDirectory: join(root, "renderer"), workerDirectory: join(root, "worker"),
    rLibraryDirectory: join(root, "r-library"), arkExecutable: join(root, "ark"), airExecutable: join(root, "air"),
    nodeExecutable: process.execPath, processSupervisorExecutable: join(root, "unused-supervisor"), electronEntry: null };
}
async function startDocument(path: string, directory: string, recoveryDirectory = join(directory, "recovery"), idleTimeout = 0): Promise<RunningHost> {
  return startHost({ path, resources: resources(directory), rscript: join(directory, "no-Rscript"), recoveryDirectory, idleTimeout,
    session: { runtimeDirectory: join(directory, "sessions") }, runOnStartup: false });
}
const sequence = new WeakMap<object, number>();
async function command(app: RunningHost, value: Record<string, unknown>): Promise<void> {
  const commandSequence = (sequence.get(app) ?? 0) + 1;
  sequence.set(app, commandSequence);
  const admission = await app.controller.dispatch(parseHostCommand({ ...value, operationId: randomUUID(), clientId: "document-test",
    commandSequence, sessionEpoch: app.controller.snapshot().epoch, expectedDocumentRevision: app.controller.snapshot().documentRevision }));
  assert.ok(admission.operation);
  const result = await app.controller.awaitOperation(admission.operation.id, "document-test", AbortSignal.timeout(5_000));
  assert.equal(result.status, "done", JSON.stringify(result));
}
async function edit(app: RunningHost, body: string): Promise<void> {
  const cell = app.controller.snapshot().cells[0]!;
  await command(app, { type: "transaction", changes: [{ type: "edit", cell: { cellId: cell.id }, expectedRevision: cell.revision, cellType: "code", body: [body] }] });
}

async function releaseLastLease(app: RunningHost, discard = false): Promise<void> {
  const origin = app.server.address()!.origin;
  const ticketResponse = await fetch(origin + "/api/ticket", { method: "POST", headers: {
    Authorization: "Bearer " + app.ownership.token, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
  assert.equal(ticketResponse.ok, true);
  const ticket = await ticketResponse.json() as { ticket: string };
  const sessionResponse = await fetch(origin + "/api/session", { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: ticket.ticket }) });
  assert.equal(sessionResponse.ok, true);
  const session = await sessionResponse.json() as { csrf: string; leaseId: string };
  const cookie = sessionResponse.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const released = await fetch(origin + "/api/lease", { method: "POST", headers: {
    Origin: origin, Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "release", leaseId: session.leaseId, ...(discard ? { disposition: "discard" } : {}) }) });
  assert.equal(released.ok, true);
}

if (process.env.ALDER_RECOVERY_CHILD) {
  const writer = await RecoveryWriter.open({ rootDir: process.env.ALDER_RECOVERY_CHILD, key: "crashed", baseline: baseline("saved\n"), snapshotIntervalMs: 20 });
  writer.update(baseline("unsaved scientific work\n", 1));
  const check = setInterval(async () => {
    if (writer.currentBaselinePath !== null) {
      clearInterval(check);
      process.send?.({ saved: true });
    }
  }, 10);
  setInterval(() => {}, 60_000);
} else {
  test("corrupt newest snapshot retains its bytes and restores the preceding valid document", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-recovery-fallback-")));
    try {
      const writer = await RecoveryWriter.open({ rootDir: directory, key: "document", baseline: baseline("saved\n") });
      writer.update(baseline("first unsaved\n", 1));
      await writer.flush();
      writer.update(baseline("second unsaved\n", 2));
      await writer.flush();
      const damagedPath = writer.currentBaselinePath!;
      await writer.close();
      await writeFile(damagedPath, "{damaged snapshot");
      const recovered = await RecoveryWriter.open({ rootDir: directory, key: "document", baseline: baseline("saved\n") });
      assert.equal(textOf(await recovered.materializedBaseline()), "first unsaved\n");
      assert.equal(recovered.issue?.code, "recovery_corrupt");
      assert.equal((await recovered.load()).pending, true);
      recovered.update(baseline("continued work\n", 2));
      await recovered.close();
      assert.equal(await readFile(damagedPath, "utf8"), "{damaged snapshot");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("periodic snapshot restores unsaved work after its process is killed", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-recovery-crash-")));
    const child = fork(fileURLToPath(import.meta.url), { execArgv: ["--import", "tsx"], cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, ALDER_RECOVERY_CHILD: directory }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    try {
      const ready = await Promise.race([once(child, "message"), once(child, "exit").then(result => { throw new Error("Recovery child exited: " + result); })]);
      assert.deepEqual(ready[0], { saved: true });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const recovered = await RecoveryWriter.open({ rootDir: directory, key: "crashed", baseline: baseline("saved\n") });
      assert.equal(textOf(await recovered.materializedBaseline()), "unsaved scientific work\n");
      await recovered.close();
    } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
  });

  test("saved document opens, edits, saves and reopens while R and recovery storage are unavailable", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-offline-")));
    const path = join(directory, "notebook.R");
    const unavailable = join(directory, "not-a-directory");
    await writeFile(unavailable, "unavailable");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory, unavailable);
      assert.equal(app.ready.type, "host.ready");
      assert.equal(app.controller.snapshot().runtime.executionReady, false);
      await edit(app, "x <- 42");
      await command(app, { type: "save" });
      assert.equal(app.controller.snapshot().dirty, false);
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 42\n");
      const recovery = await app.controller.query({ type: "recovery" });
      assert.equal(recovery.result.corruption?.code, "recovery_write_failed");
      await app.close(); app = undefined;
      app = await startDocument(path, directory, unavailable);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 42"]);
      assert.equal(app.controller.snapshot().dirty, false);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("saved document opens with corrupt recovery and exposes the retained recovery problem", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-corrupt-")));
    const path = join(directory, "notebook.R");
    const recoveryDirectory = join(directory, "recovery");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory);
      await edit(app, "x <- 2");
      await app.close(); app = undefined;
      const recoveryPath = join(recoveryDirectory, (await readdir(recoveryDirectory)).find(name => name.startsWith("recovery-"))!);
      const newest = (await readdir(recoveryPath)).filter(name => name.startsWith("snapshot-")).sort().at(-1)!;
      await writeFile(join(recoveryPath, newest), "corrupt");
      app = await startDocument(path, directory);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 1"]);
      const recovery = await app.controller.query({ type: "recovery" });
      assert.equal(recovery.result.corruption?.code, "recovery_corrupt");
      await edit(app, "x <- 3");
      await command(app, { type: "save" });
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 3\n");
      assert.equal(await readFile(join(recoveryPath, newest), "utf8"), "corrupt");
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("last-client idle shutdown keeps the saved file unchanged and recovers its unsaved draft", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-idle-")));
    const path = join(directory, "notebook.R");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory, join(directory, "recovery"), 0.02);
      await edit(app, "x <- 2");
      await releaseLastLease(app);
      await app.closed; app = undefined;
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 1\n");
      app = await startDocument(path, directory);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 2"]);
      assert.equal(app.controller.snapshot().dirty, true);
      await releaseLastLease(app, true);
      await app.closed; app = undefined;
      app = await startDocument(path, directory);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 1"]);
      assert.equal(app.controller.snapshot().dirty, false);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("Don't Save closes an edited document when recovery storage is unavailable", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-discard-")));
    const path = join(directory, "notebook.R");
    const unavailable = join(directory, "unavailable");
    await writeFile(path, "# %%\nx <- 1\n");
    await writeFile(unavailable, "unavailable");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory, unavailable);
      await edit(app, "x <- 2");
      await releaseLastLease(app, true);
      await app.closed; app = undefined;
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 1\n");
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

}
