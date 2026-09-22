import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookBackend } from "../src/backend.js";
import { RecoveryWriter } from "../src/recovery.js";
import { connectBackendSession, type AcquireNotebookSessionOptions, type HostLaunchOptions } from "../src/sessions.js";
import { decodeHostQueryResultWire, encodeHostCommandWire, encodeHostQueryWire, hostIdentitySchema, hostQueryResultSchema, notebookQueryResultSchema, parseHostCommand, type SessionConnection } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";

async function fixture(context: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-shared-backend-")));
  const rendererDirectory = join(root, "renderer"), workerDirectory = join(root, "worker");
  await mkdir(rendererDirectory); await mkdir(workerDirectory);
  await writeFile(join(rendererDirectory, "index.html"), "<!doctype html><title>Alder</title>");
  const resources: ApplicationResources = {
    root, rendererDirectory, workerDirectory, nodeExecutable: process.execPath, hostEntry: join(root, "host.mjs"), cliLauncher: join(root, "alder"),
    rLibraryDirectory: join(root, "no-r-library"), arkExecutable: join(root, "no-ark"), airExecutable: join(root, "no-air"), quartoExecutable: join(root, "no-quarto"), electronEntry: null,
  };
  const openRecovery = RecoveryWriter.open.bind(RecoveryWriter);
  context.mock.method(RecoveryWriter, "open", options => openRecovery({ ...options, rootDir: join(root, "recovery") }));
  const options = (path: string): HostLaunchOptions => ({ path, sessionKey: createHash("sha256").update("path:" + path).digest("hex"), deferStartup: true, suppressStartup: true });
  const clientOptions = (path: string): AcquireNotebookSessionOptions => ({ path, resources });
  const connect = async (backend: NotebookBackend, path: string): Promise<SessionConnection> => connectBackendSession(await backend.open(options(path)), clientOptions(path));
  return { root, resources, options, connect };
}

async function notebook(connection: SessionConnection) {
  const query = { type: "notebook" } as const;
  const response = await connection.request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostQueryWire(query)) });
  assert.equal(response.status, 200);
  const envelope = hostQueryResultSchema.parse(decodeHostQueryResultWire(query, await response.json()));
  return notebookQueryResultSchema.parse(envelope.result);
}

async function editFirstCell(connection: SessionConnection, body: string): Promise<void> {
  const snapshot = await notebook(connection); const cell = snapshot.cells[0]!;
  const command = parseHostCommand({ requestId: randomUUID(), clientId: connection.clientId, sessionEpoch: connection.epoch,
    expectedDocumentRevision: snapshot.documentRevision, type: "transaction",
    changes: [{ type: "edit", cell: { cellId: cell.id }, expectedRevision: cell.revision, cellType: "code", body: [body] }] });
  const response = await connection.request("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostCommandWire(command)) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const result = JSON.parse(text) as { error?: unknown };
  assert.equal(result.error, null);
}

async function command(connection: SessionConnection, value: Record<string, unknown>) {
  const snapshot = await notebook(connection);
  const request = parseHostCommand({ ...value, requestId: randomUUID(), clientId: connection.clientId,
    sessionEpoch: connection.epoch, expectedDocumentRevision: snapshot.documentRevision });
  const response = await connection.request("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostCommandWire(request)) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body) as { error: { message: string } | null; result?: { durabilityWarning?: string } };
}

test("warned Save As keeps its source claim and backend host through a denied reopen", { timeout: 15_000 }, async context => {
  const value = await fixture(context);
  const source = join(value.root, "source.R"), destination = join(value.root, "destination.R");
  await writeFile(source, "# %%\nx <- 1\n");
  const backend = new NotebookBackend(value.resources);
  const clients: SessionConnection[] = [];
  try {
    const current = await value.connect(backend, source); clients.push(current);
    await editFirstCell(current, "x <- 7");
    const adopt = RecoveryWriter.prototype.adoptRecoveryId;
    let failIdentity = true;
    context.mock.method(RecoveryWriter.prototype, "adoptRecoveryId", async function (this: RecoveryWriter, id: string) {
      if (failIdentity) { failIdentity = false; throw new Error("identity sync fault"); }
      return adopt.call(this, id);
    });
    const warned = await command(current, { type: "save-as", path: destination, expectedDestination: "absent" });
    assert.equal(warned.error, null);
    assert.match(warned.result?.durabilityWarning ?? "", /identity sync fault/);
    await assert.rejects(backend.open(value.options(source)), /unfinished Save As.*Retry Save or close/);
    assert.equal(backend.idle, false);
    const destinationClient = await value.connect(backend, destination); clients.push(destinationClient);
    assert.equal((await notebook(destinationClient)).path, destination);
    const settled = await command(destinationClient, { type: "save" });
    assert.equal(settled.error, null);
    assert.equal(settled.result?.durabilityWarning, undefined);
    const reopened = await value.connect(backend, source); clients.push(reopened);
    assert.equal((await notebook(reopened)).path, source);
  } finally {
    await Promise.allSettled(clients.map(client => client.release()));
    await backend.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("same-notebook clients detach independently while different notebooks stay isolated", { timeout: 15_000 }, async context => {
  const value = await fixture(context); const firstPath = join(value.root, "first.R"), secondPath = join(value.root, "second.R");
  await writeFile(firstPath, "# %%\nfirst <- 1\n"); await writeFile(secondPath, "# %%\nsecond <- 2\n");
  const backend = new NotebookBackend(value.resources); const clients: SessionConnection[] = [];
  try {
    const first = await value.connect(backend, firstPath); const peer = await value.connect(backend, firstPath); const second = await value.connect(backend, secondPath);
    clients.push(first, peer, second);
    assert.equal(first.epoch, peer.epoch); assert.notEqual(first.leaseId, peer.leaseId); assert.notEqual(first.epoch, second.epoch);
    await first.release();
    assert.equal((await notebook(peer)).path, firstPath);
    await first.release();
    assert.equal((await notebook(peer)).path, firstPath);
    assert.equal((await notebook(second)).path, secondPath);
    await peer.release();
    assert.equal((await notebook(second)).path, secondPath);
  } finally { await Promise.allSettled(clients.map(client => client.release())); await backend.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("no-run suppresses a fresh opening and joins an existing session without changing its notebook setting", { timeout: 15_000 }, async context => {
  const value = await fixture(context);
  const path = join(value.root, "no-run.R");
  await writeFile(path, "# %%\nx <- 1\n");
  const backend = new NotebookBackend(value.resources);
  const clients: SessionConnection[] = [];
  const launch = { ...value.options(path), suppressStartup: true };
  const requested = { path, resources: value.resources, deferStartup: true, suppressStartup: true } satisfies AcquireNotebookSessionOptions;
  try {
    const fresh = await connectBackendSession(await backend.open(launch), requested);
    clients.push(fresh);
    const freshIdentity = hostIdentitySchema.parse(await (await fresh.request("/api/identity")).json());
    assert.equal(freshIdentity.configuration.runOnStartup, true);
    const beforeStartup = await notebook(fresh);
    const startup = parseHostCommand({
      requestId: randomUUID(), clientId: fresh.clientId, sessionEpoch: fresh.epoch,
      expectedDocumentRevision: beforeStartup.documentRevision, type: "run", scope: "all", startup: true,
    });
    const startupResponse = await fresh.request("/api/command", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostCommandWire(startup)),
    });
    assert.equal(startupResponse.status, 200);
    await startupResponse.json();
    let suppressed = await notebook(fresh);
    for (let attempts = 0; !suppressed.runtime.startupActivated && attempts < 20; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      suppressed = await notebook(fresh);
    }
    assert.equal(suppressed.runtime.startupActivated, true);
    assert.equal(suppressed.documentRevision, beforeStartup.documentRevision);
    assert.equal(suppressed.dirty, beforeStartup.dirty);

    const existing = await connectBackendSession(await backend.open(launch), requested);
    clients.push(existing);
    const existingIdentity = hostIdentitySchema.parse(await (await existing.request("/api/identity")).json());
    assert.equal(existing.epoch, fresh.epoch);
    assert.equal(existingIdentity.configuration.runOnStartup, true);
  } finally {
    await Promise.allSettled(clients.map(client => client.release()));
    await backend.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a replacement backend restores acknowledged work from the document journal", { timeout: 15_000 }, async context => {
  const value = await fixture(context); const path = join(value.root, "recovered.R"); await writeFile(path, "# %%\nx <- 1\n");
  let backend = new NotebookBackend(value.resources); let connection: SessionConnection | undefined;
  try {
    connection = await value.connect(backend, path); await editFirstCell(connection, "x <- 42"); await connection.release(); connection = undefined;
    await backend.close();
    backend = new NotebookBackend(value.resources); connection = await value.connect(backend, path);
    const sourceQuery = { type: "source" } as const;
    const response = await connection.request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostQueryWire(sourceQuery)) });
    const envelope = hostQueryResultSchema.parse(decodeHostQueryResultWire(sourceQuery, await response.json()));
    assert.match(JSON.stringify(envelope.result), /x <- 42/);
  } finally { await connection?.release().catch(() => {}); await backend.close(); await rm(value.root, { recursive: true, force: true }); }
});
