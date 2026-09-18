import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost } from "../src/application.js";
import { resolveApplicationResources } from "../src/resources.js";
import { parseHostCommand, widgetOutputSchema, type HostCommand } from "../src/protocol.js";

type RunningHost = Awaited<ReturnType<typeof startHost>>;
const APPLICATION_ROOT = process.env.ALDER_APPLICATION_ROOT;
let stagedResources: Awaited<ReturnType<typeof resolveApplicationResources>> | undefined;
const commandSequences = new WeakMap<object, number>();

async function startInstalledHost(path: string, options: { executionMode?: "automatic" | "lazy"; runOnStartup?: boolean; idleTimeout?: number } = {}): Promise<RunningHost> {
  if (!APPLICATION_ROOT) throw new Error("ALDER_APPLICATION_ROOT is required for installed host tests");
  stagedResources ??= await resolveApplicationResources(APPLICATION_ROOT);
  const app = await startHost({
    path,
    port: 0,
    runOnStartup: options.runOnStartup ?? false,
    executionMode: options.executionMode,
    idleTimeout: options.idleTimeout,
    resources: stagedResources,
    session: { runtimeDirectory: path + "-runtime" },
  });
  const deadline = performance.now() + 15_000;
  while (!app.controller.snapshot().runtime.executionReady && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return app;
}

function nextCommandSequence(controller: object): number {
  const next = (commandSequences.get(controller) ?? 0) + 1;
  commandSequences.set(controller, next);
  return next;
}

function hostCommand(app: RunningHost, value: Record<string, unknown>): HostCommand {
  const snapshot = app.controller.snapshot();
  const type = String(value.type);
  const needsRevision = ["transaction", "run", "publish", "save", "save-as", "reload-source", "format", "set-app", "set-config", "set-layout", "set-runtime"].includes(type);
  return parseHostCommand({
    ...value,
    operationId: typeof value.operationId === "string" ? value.operationId : randomUUID(),
    clientId: typeof value.clientId === "string" ? value.clientId : "host-tests",
    commandSequence: nextCommandSequence(app.controller),
    sessionEpoch: snapshot.epoch,
    ...(needsRevision && value.expectedDocumentRevision === undefined ? { expectedDocumentRevision: snapshot.documentRevision } : {}),
    ...(type === "set-config" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.config.version } : {}),
    ...(type === "set-layout" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.layout.version } : {}),
  });
}

async function dispatchHost(app: RunningHost, value: Record<string, unknown>) {
  return app.controller.dispatch(hostCommand(app, value));
}

async function settledHost(app: RunningHost, admission: { operation?: { id: string } | null }, signal?: AbortSignal) {
  assert.ok(admission.operation);
  return app.controller.awaitOperation(admission.operation.id, "host-tests", signal);
}
type HttpSession = { origin: string; cookie: string; csrf: string; leaseId: string };

async function openHttpSession(app: RunningHost): Promise<HttpSession> {
  const origin = app.server.address()!.origin;
  const ticketResponse = await fetch(origin + "/api/ticket", {
    method: "POST",
    headers: { Authorization: "Bearer " + app.ownership.token, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ origin }),
  });
  assert.equal(ticketResponse.ok, true, "host test ticket issuance must succeed");
  const ticketValue = await ticketResponse.json() as { ticket?: unknown };
  assert.equal(typeof ticketValue.ticket, "string");
  const sessionResponse = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: ticketValue.ticket }),
  });
  assert.equal(sessionResponse.ok, true, "host test session exchange must succeed");
  const session = await sessionResponse.json() as { leaseId?: unknown; csrf?: unknown };
  assert.equal(typeof session.leaseId, "string");
  assert.equal(typeof session.csrf, "string");
  const setCookie = typeof sessionResponse.headers.getSetCookie === "function"
    ? sessionResponse.headers.getSetCookie()[0]
    : sessionResponse.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  assert.ok(cookie, "host test session exchange must set a cookie");
  return { origin, cookie, csrf: session.csrf as string, leaseId: session.leaseId as string };
}

async function closeHttpSession(session: HttpSession, disposition?: "discard"): Promise<void> {
  const response = await fetch(session.origin + "/api/lease", {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "release", leaseId: session.leaseId, ...(disposition === undefined ? {} : { disposition }) }),
  });
  assert.equal(response.ok, true, "host test lease release must succeed");
}
test("discarding the last lease removes unsaved recovery", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-discard-"));
  const path = join(directory, "notebook.R");
  const original = "# %%\nx <- 1\n";
  await writeFile(path, original);
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path);
    const before = app.controller.snapshot();
    const edit = await dispatchHost(app, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: before.cells[0]!.id }, expectedRevision: before.cells[0]!.revision,
        cellType: "code", body: ["x <- 2"] }],
    });
    assert.equal((await settledHost(app, edit)).status, "done");
    assert.equal(app.controller.snapshot().dirty, true);

    session = await openHttpSession(app);
    await closeHttpSession(session, "discard");
    session = undefined;
    await app.closed;
    app = undefined;
    assert.equal(await readFile(path, "utf8"), original);

    app = await startInstalledHost(path);
    assert.equal(app.controller.snapshot().cells[0]!.body[0], "x <- 1");
    assert.equal(app.controller.snapshot().dirty, false);
    const recovery = await app.controller.query({ type: "recovery" });
    assert.equal(recovery.result.pending, false);
    assert.deepEqual(recovery.result.branches, []);
  } finally {
    if (session !== undefined) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function requestSymbols(session: HttpSession): Promise<string> {
  const response = await fetch(session.origin + "/api/lsp", {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "textDocument/documentSymbol", params: {} }),
  });
  const body = await response.text();
  let diagnostic = body;
  try { diagnostic = JSON.stringify(JSON.parse(body)); } catch {}
  assert.equal(response.status, 200, "LSP response " + response.status + ": " + diagnostic);
  return body;
}

test("editor help synchronizes source only on request or for enabled diagnostics", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-help-idle-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# %%\ninitial_symbol <- function() 1\n");
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path);
    session = await openHttpSession(app);
    assert.match(await requestSymbols(session), /initial_symbol/);

    const before = app.controller.snapshot();
    const edited = await dispatchHost(app, {
      type: "transaction",
      expectedDocumentRevision: before.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: before.cells[0]!.revision,
        cellType: "code", body: ["fresh_symbol <- function() 2"] }],
    });
    assert.equal((await settledHost(app, edited)).status, "done");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(await requestSymbols(session), /fresh_symbol/);

    const config = app.controller.snapshot();
    const diagnostics = await dispatchHost(app, {
      type: "set-config",
      patch: { editor: { live_diagnostics: true } },
      expectedSidecarVersion: config.sidecars.config.version,
      expectedDocumentRevision: config.documentRevision,
    });
    assert.equal((await settledHost(app, diagnostics)).status, "done");
    const diagnosticBefore = app.controller.snapshot();
    const diagnosticEdit = await dispatchHost(app, {
      type: "transaction",
      expectedDocumentRevision: diagnosticBefore.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: diagnosticBefore.cells[0]!.revision,
        cellType: "code", body: ["diagnostic_symbol <- function() 2"] }],
    });
    assert.equal((await settledHost(app, diagnosticEdit)).status, "done");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(await requestSymbols(session), /diagnostic_symbol/);
  } finally {
    if (session !== undefined) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clean external reload does not create recovery startup deferral", {
  skip: !APPLICATION_ROOT, timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-clean-reload-"));
  const path = join(directory, "notebook.R");
  let app: RunningHost | undefined;
  let restarted: RunningHost | undefined;
  try {
    await writeFile(path, "# %%\nx <- 1\n");
    app = await startInstalledHost(path, { runOnStartup: true, idleTimeout: 0 });
    const originalDigest = app.controller.snapshot().disk.digest;
    writeFileSync(path, "# %%\nx <- 2\n");
    let observed = app.controller.snapshot();
    const deadline = Date.now() + 5_000;
    while ((observed.disk.digest === originalDigest || observed.disk.digest === null || observed.disk.version === null)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      observed = app.controller.snapshot();
    }
    assert.notEqual(observed.disk.digest, originalDigest);
    assert.notEqual(observed.disk.digest, null);
    assert.notEqual(observed.disk.version, null);

    const admission = await dispatchHost(app, {
      type: "reload-source",
      expectedDocumentRevision: observed.documentRevision,
      expectedDiskDigest: observed.disk.digest!,
      expectedDiskVersion: observed.disk.version!,
    });
    const result = await settledHost(app, admission);
    assert.equal(result.status, "done", JSON.stringify(result));
    const clean = app.controller.snapshot();
    assert.equal(clean.dirty, false);
    assert.equal(clean.runtime.startupActivated, true);
    assert.equal(app.controller.configuration().deferStartup, false);
    const recovery = await app.controller.query({ type: "recovery" });
    assert.equal(recovery.result.pending, false);
    assert.deepEqual(recovery.result.branches, []);

    await app.close();
    app = undefined;
    restarted = await startInstalledHost(path, { runOnStartup: true, idleTimeout: 0 });
    const afterRestart = restarted.controller.snapshot();
    assert.equal(afterRestart.dirty, false);
    assert.equal(afterRestart.runtime.startupActivated, true);
    assert.equal(restarted.controller.configuration().deferStartup, false);
    const restartedRecovery = await restarted.controller.query({ type: "recovery" });
    assert.equal(restartedRecovery.result.pending, false);
    assert.deepEqual(restartedRecovery.result.branches, []);
  } finally {
    await app?.close();
    await restarted?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("installed host runs exact edited source, saves bytes and publishes committed results", {
  skip: !APPLICATION_ROOT, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-integration-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# title\r\n# %%\r\na <- 1\r\na\r\n# %%\r\nb <- a + 1\nb\r\n# %%\r\nc <- b + 1\nc");
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path);
    const controller = app.controller;
    const snapshot = controller.snapshot();
    assert.equal(snapshot.runtime.executionReady, true);
    assert.equal(snapshot.cells.length, 3);
    const receipt = await dispatchHost(app, {
      type: "run", scope: "all",
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0,
        cellType: "code", body: ["a <- 40", "a"] }],
      expectedDocumentRevision: snapshot.documentRevision,
    });
    const operation = await settledHost(app, receipt);
    assert.equal(operation.status, "done");
    const completed = controller.snapshot();
    assert.equal(completed.cells[0]!.revision, 1);
    assert.deepEqual(completed.cells.map(cell => cell.status), ["done", "done", "done"]);
    assert.match(JSON.stringify(completed.cells[2]!.outputs), /42/);


    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: completed.documentRevision });
    assert.equal((await settledHost(app, save)).status, "done");
    assert.equal(controller.snapshot().dirty, false, 'a successful Save must clear the durable recovery draft');
    assert.equal(await readFile(path, "utf8"), "# title\r\n# %%\r\na <- 40\r\na\r\n# %%\r\nb <- a + 1\nb\r\n# %%\r\nc <- b + 1\nc");

    const publishedPath = join(directory, "published.html");
    const publishDocumentRevision = controller.snapshot().documentRevision;
    const publish = await dispatchHost(app, { type: "publish", includeCode: true, outputPath: publishedPath,
      expectedDocumentRevision: publishDocumentRevision });
    const published = await settledHost(app, publish);
    assert.equal(published.status, "done");
    assert.deepEqual(published.result, { path: publishedPath, documentRevision: publishDocumentRevision });
    assert.match(await readFile(publishedPath, "utf8"), /42/);

    const stale = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-1" },
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0,
        cellType: "code", body: ["a <- -1"] }],
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    const staleResult = await settledHost(app, stale);
    assert.equal(staleResult.status, "error");
    assert.equal(staleResult.error?.code, 'source_conflict', JSON.stringify(staleResult.error));
    assert.equal(controller.snapshot().cells[0]!.body[0], 'a <- 40');
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("runtime and app metadata survive recovery restart, Save, and Save As", {
  skip: !APPLICATION_ROOT, timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-metadata-recovery-"));
  const path = join(directory, "notebook.R");
  const destination = join(directory, "copy.R");
  const original = [
    "# ---",
    "# runtime:",
    "#   on_cell_change: automatic",
    "#   on_startup: true",
    "# app:",
    "#   layout: vertical",
    "#   width: medium",
    "# ---",
    "# %%",
    "x <- 1",
    "",
  ].join("\r\n");
  await writeFile(path, original);
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path);
    let snapshot = app.controller.snapshot();
    const runtime = await dispatchHost(app, {
      type: "set-runtime", on_cell_change: "lazy", on_startup: false,
      expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal((await settledHost(app, runtime)).status, "done");
    snapshot = app.controller.snapshot();
    const appUpdate = await dispatchHost(app, {
      type: "set-app", patch: { layout: "grid" }, expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal((await settledHost(app, appUpdate)).status, "done");
    assert.equal(await readFile(path, "utf8"), original);
    await app.close();
    app = undefined;

    app = await startInstalledHost(path);
    snapshot = app.controller.snapshot();
    assert.deepEqual(snapshot.metadata?.runtime, { on_cell_change: "lazy", on_startup: false });
    assert.deepEqual(snapshot.metadata?.app, { layout: "grid", width: "medium" });

    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: snapshot.documentRevision });
    assert.equal((await settledHost(app, save)).status, "done");
    const saved = await readFile(path, "utf8");
    assert.match(saved, /on_cell_change: lazy/);
    assert.match(saved, /on_startup: false/);
    assert.match(saved, /layout: grid/);
    assert.doesNotMatch(saved, /on_cell_change: automatic/);
    assert.doesNotMatch(saved, /on_startup: true/);
    assert.doesNotMatch(saved, /layout: vertical/);

    snapshot = app.controller.snapshot();
    const nextRuntime = await dispatchHost(app, {
      type: "set-runtime", on_cell_change: "automatic", expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal((await settledHost(app, nextRuntime)).status, "done");
    snapshot = app.controller.snapshot();
    const nextApp = await dispatchHost(app, {
      type: "set-app", patch: { width: "full" }, expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal((await settledHost(app, nextApp)).status, "done");
    snapshot = app.controller.snapshot();
    const saveAs = await dispatchHost(app, {
      type: "save-as", path: destination, expectedDestination: "absent", expectedDocumentRevision: snapshot.documentRevision,
    });
    const settledSaveAs = await settledHost(app, saveAs);
    assert.equal(settledSaveAs.status, "done", JSON.stringify(settledSaveAs.error));
    const copied = await readFile(destination, "utf8");
    assert.match(copied, /on_cell_change: automatic/);
    assert.match(copied, /on_startup: false/);
    assert.match(copied, /layout: grid/);
    assert.match(copied, /width: full/);
    assert.equal(app.controller.snapshot().dirty, false, "a successful Save As must clear the durable recovery draft");
    const saveAsRecovery = await app.controller.query({ type: "recovery" });
    assert.equal(saveAsRecovery.result.pending, false);
    assert.deepEqual(saveAsRecovery.result.branches, []);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle shutdown waits for a real save before closing", {
  skip: !APPLICATION_ROOT, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-idle-save-"));
  const path = join(directory, "notebook.R");
  const originalBytes = "# %%\nx <- 1\n";
  const savedBytes = "# %%\nx <- 2\n";
  await writeFile(path, originalBytes);
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path, { idleTimeout: 0.25 });
    const controller = app.controller;
    assert.equal(controller.snapshot().runtime.executionReady, true);

    const originalCommitSource = controller.commitSource.bind(controller);
    let resolveSaveBegan!: () => void;
    const saveBegan = new Promise<void>(resolve => { resolveSaveBegan = resolve; });
    const mutable = controller as unknown as {
      commitSource(request: { kind: string }, prepare?: unknown): Promise<unknown>;
    };
    mutable.commitSource = async (request, prepare) => {
      if (request.kind === "save") {
        resolveSaveBegan();
        await new Promise<void>(resolve => setTimeout(resolve, 750));
      }
      return originalCommitSource(request as never, prepare as never);
    };

    const before = controller.snapshot();
    const edit = await dispatchHost(app, {
      type: "transaction",
      expectedDocumentRevision: before.documentRevision,
      changes: [{ type: "edit", cell: { cellId: before.cells[0]!.id }, expectedRevision: before.cells[0]!.revision,
        cellType: "code", body: ["x <- 2"] }],
    });
    assert.equal((await settledHost(app, edit)).status, "done");
    assert.equal(controller.snapshot().dirty, true);

    session = await openHttpSession(app);
    await closeHttpSession(session);
    session = undefined;

    await saveBegan;
    assert.equal(await readFile(path, "utf8"), originalBytes, "idle shutdown must not close while the real save is pending");
    const closedWhilePending = await Promise.race([
      app.closed.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(closedWhilePending, false);

    const readSavedBytes = async (): Promise<string | null> => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    let finalBytes = await readSavedBytes();
    const deadline = performance.now() + 5_000;
    while (finalBytes !== savedBytes && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      finalBytes = await readSavedBytes();
    }
    assert.equal(finalBytes, savedBytes);
    const closedAfterSave = await Promise.race([
      app.closed.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.equal(closedAfterSave, true, "idle shutdown must close automatically after the real save settles");
  } finally {
    if (session !== undefined) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("editing a queued batch cell prevents its old effects and retains unaffected work", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-batch-edit-"));
  const path = join(directory, "notebook.R");
  const marker = join(directory, "obsolete-source");
  await writeFile(path, "# %%\nSys.sleep(0.3); a <- 1; a\n# %%\nb <- a + 1; b\n# %%\n" +
    "writeLines('obsolete', " + JSON.stringify(marker) + "); c <- b + 1; c\n");
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: "lazy" });
    const controller = app.controller;
    let edited: Promise<unknown> | undefined;
    controller.subscribe(event => {
      if (event.type !== "cell-started" || event.cellId !== "cell-1" || edited !== undefined) return;
      const state = controller.snapshot();
      edited = dispatchHost(app!, {
        type: "transaction",
        expectedDocumentRevision: state.documentRevision,
        changes: [{ type: "edit", cell: { cellId: "cell-3" }, expectedRevision: state.cells[2]!.revision,
          cellType: "code", body: ["c <- b + 20; c"] }],
      });
    });
    const run = async () => {
      const receipt = await dispatchHost(app!, { type: "run", scope: "all", expectedDocumentRevision: controller.snapshot().documentRevision });
      return settledHost(app!, receipt);
    };
    assert.equal((await run()).status, "done");
    await edited;
    await assert.rejects(access(marker));
    assert.deepEqual(controller.snapshot().cells.slice(0, 2).map(cell => cell.status), ["done", "done"]);
    assert.deepEqual(controller.snapshot().cells[2]!.body, ["c <- b + 20; c"]);
    assert.equal((await run()).status, "done");
    assert.match(JSON.stringify(controller.snapshot().cells[2]!.outputs), /22/);
    assert.equal(controller.snapshot().runtime.busy, false);
    await assert.rejects(access(marker));
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("a batched consumer run settles its run-button reset", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-batch-button-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# %%\nbtn <- ui$run_button(); btn\n# %%\nseen <- btn$value; seen\n# %%\nresult <- as.integer(seen); result\n");
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: "lazy" });
    const controller = app.controller;
    const initial = await dispatchHost(app, { type: "run", scope: "all", expectedDocumentRevision: controller.snapshot().documentRevision });
    assert.equal((await settledHost(app, initial)).status, "done");
    const beforeWidget = controller.snapshot();
    const widget = await dispatchHost(app, {
      type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
      kernelEpoch: beforeWidget.runtime.kernelEpoch!, expectedRevision: beforeWidget.cells[0]!.revision,
    });
    const deadline = performance.now() + 5_000;
    while (controller.snapshot().cells[2]!.status !== "stale" && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(controller.snapshot().cells[2]!.status, "stale");
    const explicit = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-3" },
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    const run = await settledHost(app, explicit);
    assert.equal(run.status, "done");
    assert.equal(run.resetOperationIds?.length, 1);
    assert.equal((await settledHost(app, widget)).status, "done");
    const state = controller.snapshot();
    const widgetRecord = state.cells[0]!.outputs.find(record => widgetOutputSchema.safeParse(record.data).success);
    if (widgetRecord === undefined) {
      assert.fail("button widget output missing: outputs=" + JSON.stringify(state.cells[0]!.outputs) + " error=" + JSON.stringify(state.cells[0]!.error) + " operation=" + JSON.stringify(state.operations.find(operation => operation.id === widget.operation?.id)?.error ?? null));
    }
    const widgetData = widgetOutputSchema.parse(widgetRecord.data);
    assert.equal(widgetData.name, "btn");
    assert.equal(widgetData.spec.kind, "run_button");
    assert.equal(widgetData.spec.value, false);
    assert.match(JSON.stringify(state.cells[2]!.outputs), /\[1\] 1/);
    assert.equal(state.runtime.busy, false);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stop cancels a single evaluation queued behind automatic inspection before side effects", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-queued-stop-"));
  const path = join(directory, "notebook.R");
  const entered = join(directory, "inspection-entered");
  const release = join(directory, "inspection-release");
  const effect = join(directory, "must-not-exist");
  await writeFile(path, [
    "# %%",
    "dim.alder_stop_probe <- function(x) { writeLines('entered', " + JSON.stringify(entered) + "); deadline <- Sys.time() + 10; while (!file.exists(" + JSON.stringify(release) + ") && Sys.time() < deadline) Sys.sleep(0.01); NULL }",
    "z <- structure(1, class='alder_stop_probe')",
    "invisible(NULL)",
    "# %%",
    "writeLines('executed', " + JSON.stringify(effect) + ")",
    "42L",
    "# %%",
    "43L",
    "",
  ].join("\n"));
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path);
    const controller = app.controller;
    const first = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-1" },
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    assert.equal((await settledHost(app, first, AbortSignal.timeout(15_000))).status, "done");
    const deadline = performance.now() + 5_000;
    while (!await access(entered).then(() => true, () => false)) {
      assert.ok(performance.now() < deadline, "automatic inspection did not begin");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const queued = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-2" },
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    await dispatchHost(app, { type: "interrupt" });
    const operation = await settledHost(app, queued, AbortSignal.timeout(2_000));
    await writeFile(release, "release");
    await assert.rejects(access(effect), "cancelled source must not execute");
    assert.equal(operation.status, "cancelled", "queued stop status=" + operation.status + " error=" + JSON.stringify(operation.error) + " cell=" + JSON.stringify(controller.snapshot().cells[1]));
    const recovery = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-3" },
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    assert.equal((await settledHost(app, recovery, AbortSignal.timeout(15_000))).status, "done");
    assert.equal(controller.snapshot().runtime.executionReady, true);
  } finally {
    await writeFile(release, "release");
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
