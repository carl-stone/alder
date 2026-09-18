import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

  test("periodic snapshot restores unsaved work after its process is killed", { timeout: 10_000 }, async () => {
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


  test("external changes keep the saved notebook authoritative and the unsaved draft recoverable", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-conflict-")));
    const path = join(directory, "notebook.R");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory);
      await edit(app, "x <- 2");
      await app.close(); app = undefined;
      await writeFile(path, "# %%\nx <- 99\n");
      app = await startDocument(path, directory);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 99"]);
      assert.equal(app.controller.snapshot().dirty, false);
      const recovery = await app.controller.query({ type: "recovery" });
      assert.equal(recovery.result.branches.length, 1);
      assert.equal(recovery.result.branches[0]!.state, "conflict");
      await edit(app, "x <- 100");
      await command(app, { type: "save" });
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 100\n");
      assert.equal((await app.controller.query({ type: "recovery" })).result.branches.length, 1);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("slow R discovery does not block editing and is canceled when the document closes", { timeout: 10_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-r-start-")));
    const path = join(directory, "notebook.R");
    const rscript = join(directory, "slow-Rscript");
    const pidPath = join(directory, "probe.pid");
    await writeFile(path, "# %%\nx <- 1\n");
    await mkdir(join(directory, "r-library/alder"), { recursive: true });
    await writeFile(join(directory, "r-library/alder/DESCRIPTION"), "Package: alder\n");
    await writeFile(rscript, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const applicationResources = resources(directory);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, kind: "headless", applicationVersion: "0.1.0",
      resources: { cliLauncher: "alder", hostEntry: "host.mjs", rendererDirectory: "renderer", workerDirectory: "worker", rLibraryDirectory: "r-library",
        arkExecutable: "ark", airExecutable: "air", nodeExecutable: "node", electronEntry: null } }));
    let app: RunningHost | undefined;
    let probePid: number | undefined;
    try {
      app = await startHost({ path, resources: applicationResources, rscript, recoveryDirectory: join(directory, "recovery"),
        session: { runtimeDirectory: join(directory, "sessions") }, runOnStartup: false });
      const deadline = Date.now() + 3_000;
      while (probePid === undefined && Date.now() < deadline) {
        probePid = await readFile(pidPath, "utf8").then(Number).catch(() => undefined);
        if (probePid === undefined) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(probePid);
      await edit(app, "x <- 42");
      await command(app, { type: "save" });
      await app.close(); app = undefined;
      const stopped = Date.now() + 1_000;
      const alive = () => { try { process.kill(probePid!, 0); return true; } catch { return false; } };
      while (alive() && Date.now() < stopped) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(alive(), false);
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 42\n");
    } finally {
      await app?.close();
      if (probePid !== undefined) { try { process.kill(probePid); } catch {} }
      await rm(directory, { recursive: true, force: true });
    }
  });


  test("Save As transfers the active recovery identity only when adopted and isolates its source", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-recovery-rebind-")));
    try {
      const source = await RecoveryWriter.open({ rootDir: directory, key: "source", baseline: baseline("source\n") });
      const destination = await RecoveryWriter.open({ rootDir: directory, key: "destination", baseline: baseline("destination\n") });
      const activeKey = source.recoveryKey;
      const destinationKey = destination.recoveryKey;
      await destination.close();
      const target = { rootDir: directory, key: "destination", baseline: baseline("source saved as destination\n", 1) };
      const canceled = await source.prepareRebind(target);
      await canceled.publish();
      assert.equal(source.recoveryKey, activeKey);
      await canceled.abort();
      const afterAbort = await RecoveryWriter.open(target);
      assert.equal(afterAbort.recoveryKey, destinationKey);
      assert.equal(source.recoveryKey, activeKey);
      await afterAbort.close();
      const committed = await source.prepareRebind(target);
      await committed.publish();
      assert.equal(source.recoveryKey, activeKey);
      committed.adopt();
      assert.equal(committed.writer.recoveryKey, activeKey);
      const rotated = source.recoveryKey;
      assert.notEqual(rotated, activeKey);
      committed.adopt();
      await committed.abort();
      assert.equal(source.recoveryKey, rotated, "repeated adoption and late abort do not rotate again");
      await source.close();
      await committed.writer.close();
      const reopenedSource = await RecoveryWriter.open({ rootDir: directory, key: "source", baseline: baseline("source\n") });
      const reopenedDestination = await RecoveryWriter.open(target);
      assert.equal(reopenedSource.recoveryKey, rotated);
      assert.equal(reopenedDestination.recoveryKey, activeKey);
      await reopenedSource.close();
      await reopenedDestination.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });


  test("immediately reopening the Save As source gives it a separate recovery identity", { timeout: 10_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-document-save-as-identity-")));
    const sourcePath = join(directory, "source.R");
    const destinationPath = join(directory, "destination.R");
    await writeFile(sourcePath, "# %%\nx <- 1\n");
    const recoveryIdentity = async (app: RunningHost): Promise<string> => {
      const origin = app.server.address()!.origin;
      const ticketResponse = await fetch(origin + "/api/ticket", { method: "POST", headers: {
        Authorization: "Bearer " + app.ownership.token, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
      assert.equal(ticketResponse.ok, true);
      const ticket = await ticketResponse.json() as { ticket: string };
      const response = await fetch(origin + "/api/session", { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: ticket.ticket }) });
      assert.equal(response.ok, true);
      const session = await response.json() as { recoveryKeyId?: string };
      assert.equal(typeof session.recoveryKeyId, "string");
      return session.recoveryKeyId!;
    };
    let active: RunningHost | undefined;
    let reopenedSource: RunningHost | undefined;
    let delayedFlush: ReturnType<typeof mock.method> | undefined;
    try {
      active = await startDocument(sourcePath, directory);
      const sourceKey = active.ownership.sessionKey;
      const flush = RecoveryWriter.prototype.flush;
      // Slow recovery storage exposes release-before-persistence without delaying the source reopen.
      delayedFlush = mock.method(RecoveryWriter.prototype, "flush", async function(this: RecoveryWriter) {
        if (this.key === sourceKey) await new Promise(resolve => setTimeout(resolve, 500));
        return flush.call(this);
      });
      const originalIdentity = await recoveryIdentity(active);
      await edit(active, "x <- 42");
      await command(active, { type: "save-as", path: destinationPath, expectedDestination: "absent" });
      // Reopen in the same runtime as soon as Save As completes; no recovery flush or close is awaited here.
      reopenedSource = await startDocument(sourcePath, directory);
      const [destinationIdentity, sourceIdentity] = await Promise.all([recoveryIdentity(active), recoveryIdentity(reopenedSource)]);
      assert.equal(destinationIdentity, originalIdentity, "the active renderer's drafts follow Save As");
      assert.notEqual(sourceIdentity, destinationIdentity, "reopened source must not share the destination's renderer drafts");
      assert.equal(await readFile(sourcePath, "utf8"), "# %%\nx <- 1\n");
      assert.equal(await readFile(destinationPath, "utf8"), "# %%\nx <- 42\n");
    } finally {
      await reopenedSource?.close();
      await active?.close();
      delayedFlush?.mock.restore();
      await rm(directory, { recursive: true, force: true });
    }
  });

}
