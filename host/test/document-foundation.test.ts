import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startHost, type RunningHost } from "../src/application.js";
import { encodeHostCommandWire, parseHostCommand, type CommandResult } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";

function resources(root: string): ApplicationResources {
  return { root, cliLauncher: join(root, "alder"), hostEntry: join(root, "host.mjs"),
    rendererDirectory: join(root, "renderer"), workerDirectory: join(root, "worker"),
    rLibraryDirectory: join(root, "r-library"), arkExecutable: join(root, "ark"), airExecutable: join(root, "air"),
    nodeExecutable: process.execPath, processSupervisorExecutable: join(root, "unused-supervisor"), electronEntry: null };
}
async function startDocument(path: string, directory: string): Promise<RunningHost> {
  return startHost({ path, resources: resources(directory), rscript: join(directory, "no-Rscript"), recoveryDirectory: join(directory, "recovery"),
    session: { runtimeDirectory: join(directory, "sessions") }, runOnStartup: false });
}
async function dispatch(app: RunningHost, value: Record<string, unknown>): Promise<CommandResult> {
  return app.controller.dispatch(parseHostCommand({ ...value, requestId: randomUUID(), clientId: "document-test",
    sessionEpoch: app.controller.snapshot().epoch, expectedDocumentRevision: app.controller.snapshot().documentRevision }));
}
async function command(app: RunningHost, value: Record<string, unknown>): Promise<CommandResult> {
  const result = await dispatch(app, value);
  if (result.error) throw Object.assign(new Error(result.error.message), result.error);
  return result;
}
async function edit(app: RunningHost, body: string): Promise<void> {
  const cell = app.controller.snapshot().cells[0]!;
  await command(app, { type: "transaction", changes: [{ type: "edit", cell: { cellId: cell.id }, expectedRevision: cell.revision, cellType: "code", body: [body] }] });
}
async function recoveryIdentity(app: RunningHost): Promise<string> {
  const ticketResponse = await fetch(app.ready.origin + "/api/ticket", {
    method: "POST",
    headers: { Authorization: "Bearer " + app.ownership.token, Origin: app.ready.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ origin: app.ready.origin }),
  });
  if (!ticketResponse.ok) assert.fail(await ticketResponse.text());
  const ticket = (await ticketResponse.json()) as { ticket: string };
  const sessionResponse = await fetch(app.ready.origin + "/api/session", {
    method: "POST",
    headers: { Origin: app.ready.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: ticket.ticket }),
  });
  if (!sessionResponse.ok) assert.fail(await sessionResponse.text());
  const session = (await sessionResponse.json()) as { recoveryId?: string };
  assert.equal(typeof session.recoveryId, "string");
  return session.recoveryId!;
}

const crashPath = process.env.ALDER_DOCUMENT_CRASH_PATH;
if (crashPath) {
  const directory = dirname(crashPath);
  const app = await startDocument(crashPath, directory);
  await edit(app, "x <- 42");
  process.send?.({ acknowledged: true });
  setInterval(() => {}, 60_000);
} else {
  test("an acknowledged edit survives backend death and reopen", { timeout: 15_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-acknowledged-crash-")));
    const path = join(directory, "notebook.R");
    await writeFile(path, "# %%\nx <- 1\n");
    const child = fork(fileURLToPath(import.meta.url), { execArgv: ["--import", "tsx"], cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, ALDER_DOCUMENT_CRASH_PATH: path }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let reopened: RunningHost | undefined;
    try {
      const ready = await Promise.race([once(child, "message"), once(child, "exit").then(value => { throw new Error("child exited before acknowledging: " + value); })]);
      assert.deepEqual(ready[0], { acknowledged: true });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 1\n");
      reopened = await startDocument(path, directory);
      assert.deepEqual(reopened.controller.snapshot().cells[0]!.body, ["x <- 42"]);
      assert.equal(reopened.controller.snapshot().dirty, true);
      assert.equal((await reopened.controller.query({ type: "recovery" })).result.candidate?.state, "restored");
    } finally {
      child.kill();
      await reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a source edit is not accepted when its recovery journal cannot be written", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-recovery-required-")));
    const path = join(directory, "notebook.R");
    const unavailable = join(directory, "not-a-directory");
    await writeFile(path, "# %%\nx <- 1\n");
    await writeFile(unavailable, "occupied");
    let app: RunningHost | undefined;
    try {
      app = await startHost({ path, resources: resources(directory), rscript: join(directory, "no-Rscript"), recoveryDirectory: unavailable,
        session: { runtimeDirectory: join(directory, "sessions") }, runOnStartup: false });
      const cell = app.controller.snapshot().cells[0]!;
      const result = await dispatch(app, { type: "transaction", changes: [{ type: "edit", cell: { cellId: cell.id },
        expectedRevision: cell.revision, cellType: "code", body: ["x <- 2"] }] });
      assert.equal(result.error?.code, "recovery_write_failed");
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 1"]);
      assert.equal(app.controller.snapshot().dirty, false);
    } finally { await app?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
  });

  test("GUI and agent edits share one revision and preserve the accepted winner", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-shared-edits-")));
    const path = join(directory, "notebook.R");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory);
      const address = app.server.address()!;
      const origin = "http://127.0.0.1:" + address.port;
      const headers = { Authorization: "Bearer " + app.ownership.token, "Content-Type": "application/json" };
      const attach = async () => {
        const response = await fetch(origin + "/api/lease", { method: "POST", headers, body: JSON.stringify({ action: "attach" }) });
        assert.equal(response.ok, true);
        return await response.json() as { leaseId: string; clientId: string; epoch: string };
      };
      const gui = await attach();
      const agent = await attach();
      const post = async (lease: typeof gui, value: number) => {
        const cell = app!.controller.snapshot().cells[0]!;
        const parsed = parseHostCommand({ requestId: randomUUID(), clientId: lease.clientId, sessionEpoch: lease.epoch, type: "transaction", expectedDocumentRevision: 0,
          changes: [{ type: "edit", cell: { cellId: cell.id }, cellType: "code", body: ["x <- " + value], expectedRevision: 0 }] });
        const response = await fetch(origin + "/api/command", { method: "POST", headers: { ...headers, "X-Alder-Lease-Id": lease.leaseId }, body: JSON.stringify(encodeHostCommandWire(parsed)) });
        assert.equal(response.status, 200);
        return await response.json() as CommandResult;
      };
      const replies = await Promise.all([post(gui, 2), post(agent, 3)]);
      assert.equal(replies.filter(reply => reply.error === null).length, 1);
      assert.equal(replies.find(reply => reply.error !== null)?.error?.code, "source_conflict");
      assert.equal(app.controller.snapshot().dirty, true);
      await app.close(); app = undefined;
      app = await startDocument(path, directory);
      assert.ok(["x <- 2", "x <- 3"].includes(app.controller.snapshot().cells[0]!.body[0]!));
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("external change keeps both the saved file and recovered edits available", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-recovery-conflict-")));
    const path = join(directory, "notebook.R");
    const copy = join(directory, "recovered-copy.R");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory);
      await edit(app, "x <- 2");
      await app.close(); app = undefined;
      await writeFile(path, "# %%\nx <- 99\n");
      app = await startDocument(path, directory);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 2"]);
      assert.equal((await app.controller.query({ type: "recovery" })).result.candidate?.state, "conflict");
      assert.equal((await dispatch(app, { type: "save" })).error?.code, "recovery_conflict");
      await command(app, { type: "save-as", path: copy, expectedDestination: "absent" });
      assert.equal(await readFile(path, "utf8"), "# %%\nx <- 99\n");
      assert.equal(await readFile(copy, "utf8"), "# %%\nx <- 2\n");
      await edit(app, "x <- 3");
      await command(app, { type: "save" });
      assert.equal(await readFile(copy, "utf8"), "# %%\nx <- 3\n");
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("Save As leaves the destination project policy untouched", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-save-as-project-")));
    const sourceDirectory = join(directory, "source");
    const destinationDirectory = join(directory, "destination");
    await mkdir(join(sourceDirectory, ".alder"), { recursive: true });
    await mkdir(join(destinationDirectory, ".alder"), { recursive: true });
    const source = join(sourceDirectory, "notebook.R");
    const destination = join(destinationDirectory, "copy.R");
    await writeFile(source, "# %%\nx <- 1\n");
    await writeFile(join(sourceDirectory, ".alder", "packages.yaml"), "packages:\n  - sourcePkg\n");
    await writeFile(join(sourceDirectory, ".alder", "layout.json"), "{\"source\":true}\n");
    const destinationPackages = "packages:\n  - destinationPkg\n";
    const destinationLayout = "null\n";
    await writeFile(join(destinationDirectory, ".alder", "packages.yaml"), destinationPackages);
    await writeFile(join(destinationDirectory, ".alder", "layout.json"), destinationLayout);
    let app: RunningHost | undefined;
    try {
      app = await startDocument(source, directory);
      await edit(app, "x <- 7");
      await command(app, { type: "save-as", path: destination, expectedDestination: "absent" });
      assert.equal(await readFile(destination, "utf8"), "# %%\nx <- 7\n");
      assert.equal(await readFile(join(destinationDirectory, ".alder", "packages.yaml"), "utf8"), destinationPackages);
      assert.equal(await readFile(join(destinationDirectory, ".alder", "layout.json"), "utf8"), destinationLayout);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("Save As refuses and preserves a destination with pending recovery", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-save-as-recovery-conflict-")));
    const source = join(directory, "source.R");
    const destination = join(directory, "destination.R");
    await writeFile(source, "# %%\nx <- 1\n");
    await writeFile(destination, "# %%\ny <- 1\n");
    let destinationApp: RunningHost | undefined;
    let sourceApp: RunningHost | undefined;
    try {
      destinationApp = await startDocument(destination, directory);
      const destinationDisk = destinationApp.controller.snapshot().disk;
      await edit(destinationApp, "y <- 9");
      await destinationApp.close(); destinationApp = undefined;

      sourceApp = await startDocument(source, directory);
      await edit(sourceApp, "x <- 2");
      const result = await dispatch(sourceApp, { type: "save-as", path: destination, expectedDestination: {
        expectedDiskDigest: destinationDisk.digest,
        expectedDiskVersion: destinationDisk.version,
      } });
      assert.equal(result.error?.code, "destination_recovery_conflict");
      assert.equal(await readFile(destination, "utf8"), "# %%\ny <- 1\n");
      await sourceApp.close(); sourceApp = undefined;

      destinationApp = await startDocument(destination, directory);
      assert.deepEqual(destinationApp.controller.snapshot().cells[0]!.body, ["y <- 9"]);
      assert.equal((await destinationApp.controller.query({ type: "recovery" })).result.candidate?.state, "restored");
    } finally {
      await sourceApp?.close().catch(() => {});
      await destinationApp?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Save As adopts one recovery identity for a clean previously opened destination", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-save-as-recovery-identity-")));
    const source = join(directory, "source.R");
    const destination = join(directory, "destination.R");
    await writeFile(source, "# %%\nx <- 1\n");
    await writeFile(destination, "# %%\ny <- 1\n");
    let destinationApp: RunningHost | undefined;
    let sourceApp: RunningHost | undefined;
    try {
      destinationApp = await startDocument(destination, directory);
      const oldDestinationId = await recoveryIdentity(destinationApp);
      const destinationDisk = destinationApp.controller.snapshot().disk;
      await destinationApp.close(); destinationApp = undefined;

      sourceApp = await startDocument(source, directory);
      const sourceId = await recoveryIdentity(sourceApp);
      assert.notEqual(sourceId, oldDestinationId);
      await command(sourceApp, { type: "save-as", path: destination, expectedDestination: {
        expectedDiskDigest: destinationDisk.digest,
        expectedDiskVersion: destinationDisk.version,
      } });
      assert.equal(await recoveryIdentity(sourceApp), sourceId);
      await sourceApp.close(); sourceApp = undefined;

      destinationApp = await startDocument(destination, directory);
      assert.equal(await recoveryIdentity(destinationApp), sourceId);
    } finally {
      await sourceApp?.close().catch(() => {});
      await destinationApp?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("corrupt journal falls back to saved source and can be discarded", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "alder-corrupt-journal-")));
    const path = join(directory, "notebook.R");
    await writeFile(path, "# %%\nx <- 1\n");
    let app: RunningHost | undefined;
    try {
      app = await startDocument(path, directory);
      await edit(app, "x <- 2");
      await app.close(); app = undefined;
      const recoveryRoot = join(directory, "recovery");
      const recoveryDirectory = join(recoveryRoot, (await readdir(recoveryRoot)).find(name => name.startsWith("recovery-"))!);
      await writeFile(join(recoveryDirectory, "journal.json"), "{damaged");
      app = await startDocument(path, directory);
      assert.deepEqual(app.controller.snapshot().cells[0]!.body, ["x <- 1"]);
      assert.equal((await app.controller.query({ type: "recovery" })).result.corruption?.code, "recovery_corrupt");
      const disk = app.controller.snapshot().disk;
      await command(app, { type: "reload-source", expectedDiskDigest: disk.digest, expectedDiskVersion: disk.version, discardRecovery: true });
      const recovery = await app.controller.query({ type: "recovery" });
      assert.equal(recovery.result.candidate, null);
      assert.equal(recovery.result.corruption, null);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
