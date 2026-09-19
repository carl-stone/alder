import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost } from "../src/application.js";
import { resolveApplicationResources } from "../src/resources.js";
import { widgetOutputSchema, type CommandResult, type HostCommand } from "../src/protocol.js";

type RunningHost = Awaited<ReturnType<typeof startHost>>;
const APPLICATION_ROOT = process.env.ALDER_APPLICATION_ROOT;
let stagedResources: Awaited<ReturnType<typeof resolveApplicationResources>> | undefined;

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
    preferencesPath: join(dirname(path), ".test-preferences.yaml"),
    session: { runtimeDirectory: path + "-runtime" },
  });
  const deadline = performance.now() + 15_000;
  while (!app.controller.snapshot().runtime.executionReady && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return app;
}

function hostCommand(app: RunningHost, value: Record<string, unknown>): HostCommand {
  const snapshot = app.controller.snapshot();
  const type = String(value.type);
  const needsRevision = ["transaction", "run", "publish", "save", "save-as", "reload-source", "format", "set-app", "set-config", "set-layout", "set-runtime"].includes(type);
  return {
    ...value,
    requestId: typeof value.requestId === "string" ? value.requestId : randomUUID(),
    clientId: typeof value.clientId === "string" ? value.clientId : "host-tests",
    sessionEpoch: snapshot.epoch,
    ...(needsRevision && value.expectedDocumentRevision === undefined ? { expectedDocumentRevision: snapshot.documentRevision } : {}),
    ...(type === "set-config" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.config.version } : {}),
    ...(type === "set-layout" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.layout.version } : {}),
  } as HostCommand;
}

async function dispatchHost(app: RunningHost, value: Record<string, unknown>) {
  return app.controller.dispatch(hostCommand(app, value));
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
    assert.equal(edit.error, null);
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

async function requestLsp(session: HttpSession, method: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(session.origin + "/api/lsp", {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() };
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
    assert.equal(edited.error, null);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(await requestSymbols(session), /fresh_symbol/);

    const config = app.controller.snapshot();
    const diagnostics = await dispatchHost(app, {
      type: "set-preferences",
      patch: { editor: { live_diagnostics: true } },
      expectedPreferencesVersion: config.preferencesVersion ?? null,
    });
    assert.equal(diagnostics.error, null);
    const diagnosticBefore = app.controller.snapshot();
    const diagnosticEdit = await dispatchHost(app, {
      type: "transaction",
      expectedDocumentRevision: diagnosticBefore.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: diagnosticBefore.cells[0]!.revision,
        cellType: "code", body: ["diagnostic_symbol <- function() 2"] }],
    });
    assert.equal(diagnosticEdit.error, null);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(await requestSymbols(session), /diagnostic_symbol/);
  } finally {
    if (session !== undefined) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed Ark editor help follows live R values, source edits and kernel restart", {
  skip: !APPLICATION_ROOT, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-help-ark-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# %%\nmy_table <- data.frame(long_column = 1L)\n# %%\nmy_table$lo\n# %%\nmissing_symbol\n");
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path);
    const first = await dispatchHost(app, { type: "run", scope: "cell", target: { cellId: "cell-1" } });
    assert.equal(first.error, null);
    session = await openHttpSession(app);
    const completion = await requestLsp(session, "textDocument/completion", { position: { cell: "cell-2", line: 0, character: 11 } });
    assert.equal(completion.status, 200);
    assert.match(JSON.stringify(completion.body), /long_column/);
    const hover = await requestLsp(session, "textDocument/hover", { position: { cell: "cell-1", line: 0, character: 15 } });
    assert.equal(hover.status, 200);
    assert.match(JSON.stringify(hover.body), /Data Frames/);
    const definition = await requestLsp(session, "textDocument/definition", { position: { cell: "cell-2", line: 0, character: 2 } });
    assert.equal(definition.status, 200);
    assert.match(JSON.stringify(definition.body), /"cell-1"/);

    const preference = await dispatchHost(app, { type: "set-preferences", patch: { editor: { live_diagnostics: true } },
      expectedPreferencesVersion: app.controller.snapshot().preferencesVersion ?? null });
    assert.equal(preference.error, null);
    const deadline = Date.now() + 5_000;
    while (!JSON.stringify(app.controller.snapshot().editorDiagnostics).includes("missing_symbol") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(JSON.stringify(app.controller.snapshot().editorDiagnostics), /missing_symbol/);
    const restart = await dispatchHost(app, { type: "restart", replay: false });
    assert.equal(restart.error, null);
    const afterRestart = await requestLsp(session, "textDocument/definition", { position: { cell: "cell-2", line: 0, character: 2 } });
    assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
    assert.match(JSON.stringify(afterRestart.body), /"cell-1"/);

    const kernelPid = (app.engine as unknown as { kernel?: { processId?: number } }).kernel?.processId;
    assert.ok(kernelPid);
    process.kill(kernelPid, "SIGKILL");
    const failureDeadline = Date.now() + 5_000;
    while (app.controller.snapshot().runtime.kernelState !== "failed" && Date.now() < failureDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(app.controller.snapshot().runtime.kernelState, "failed");
    const unavailable = await requestLsp(session, "textDocument/completion", { position: { cell: "cell-2", line: 0, character: 11 } });
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
    const beforeEdit = app.controller.snapshot();
    const edit = await dispatchHost(app, { type: "transaction", expectedDocumentRevision: beforeEdit.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-3" }, expectedRevision: beforeEdit.cells[2]!.revision,
        cellType: "code", body: ['offline_note <- "saved"'] }] });
    assert.equal(edit.error, null);
    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: app.controller.snapshot().documentRevision });
    assert.equal(save.error, null);
    assert.match(await readFile(path, "utf8"), /offline_note <- "saved"/);
  } finally {
    if (session) await closeHttpSession(session);
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

    const result = await dispatchHost(app, {
      type: "reload-source",
      expectedDocumentRevision: observed.documentRevision,
      expectedDiskDigest: observed.disk.digest!,
      expectedDiskVersion: observed.disk.version!,
    });
    assert.equal(result.error, null, JSON.stringify(result));
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
    const run = await dispatchHost(app, {
      type: "run", scope: "all",
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0,
        cellType: "code", body: ["a <- 40", "a"] }],
      expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(run.error, null);
    const completed = controller.snapshot();
    assert.equal(completed.cells[0]!.revision, 1);
    assert.deepEqual(completed.cells.map(cell => cell.status), ["done", "done", "done"]);
    assert.match(JSON.stringify(completed.cells[2]!.outputs), /42/);


    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: completed.documentRevision });
    assert.equal(save.error, null);
    assert.equal(controller.snapshot().dirty, false, 'a successful Save must clear the durable recovery draft');
    assert.equal(await readFile(path, "utf8"), "# title\r\n# %%\r\na <- 40\r\na\r\n# %%\r\nb <- a + 1\nb\r\n# %%\r\nc <- b + 1\nc");

    const publishedPath = join(directory, "published.html");
    const publishDocumentRevision = controller.snapshot().documentRevision;
    const publish = await dispatchHost(app, { type: "publish", includeCode: true, outputPath: publishedPath,
      expectedDocumentRevision: publishDocumentRevision });
    assert.equal(publish.error, null);
    assert.deepEqual(publish.result, { path: publishedPath, documentRevision: publishDocumentRevision });
    assert.match(await readFile(publishedPath, "utf8"), /42/);

    const stale = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-1" },
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0,
        cellType: "code", body: ["a <- -1"] }],
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    assert.equal(stale.error?.code, 'source_conflict', JSON.stringify(stale.error));
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
    "#   vendor_note: keep me",
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
    assert.equal(runtime.error, null);
    snapshot = app.controller.snapshot();
    const appUpdate = await dispatchHost(app, {
      type: "set-app", patch: { layout: "grid" }, expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(appUpdate.error, null);
    assert.equal(await readFile(path, "utf8"), original);
    await app.close();
    app = undefined;

    app = await startInstalledHost(path);
    snapshot = app.controller.snapshot();
    assert.deepEqual(snapshot.metadata?.runtime, { on_cell_change: "lazy", on_startup: false });
    assert.deepEqual(snapshot.metadata?.app, { layout: "grid", width: "medium", vendor_note: "keep me" });

    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: snapshot.documentRevision });
    assert.equal(save.error, null);
    const saved = await readFile(path, "utf8");
    assert.match(saved, /on_cell_change: lazy/);
    assert.match(saved, /on_startup: false/);
    assert.match(saved, /layout: grid/);
    assert.match(saved, /vendor_note: keep me/);
    assert.doesNotMatch(saved, /on_cell_change: automatic/);
    assert.doesNotMatch(saved, /on_startup: true/);
    assert.doesNotMatch(saved, /layout: vertical/);

    snapshot = app.controller.snapshot();
    const nextRuntime = await dispatchHost(app, {
      type: "set-runtime", on_cell_change: "automatic", expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(nextRuntime.error, null);
    snapshot = app.controller.snapshot();
    const nextApp = await dispatchHost(app, {
      type: "set-app", patch: { width: "full" }, expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(nextApp.error, null);
    snapshot = app.controller.snapshot();
    const saveAs = await dispatchHost(app, {
      type: "save-as", path: destination, expectedDestination: "absent", expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(saveAs.error, null, JSON.stringify(saveAs.error));
    const copied = await readFile(destination, "utf8");
    assert.match(copied, /on_cell_change: automatic/);
    assert.match(copied, /on_startup: false/);
    assert.match(copied, /layout: grid/);
    assert.match(copied, /width: full/);
    assert.match(copied, /vendor_note: keep me/);
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
    assert.equal(edit.error, null);
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
    let edited: Promise<CommandResult> | undefined;
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
    const run = () => dispatchHost(app!, { type: "run", scope: "all", expectedDocumentRevision: controller.snapshot().documentRevision });
    assert.equal((await run()).error, null);
    assert.ok(edited, "the source edit must occur while the batch is running");
    assert.equal((await edited).error, null);
    await assert.rejects(access(marker));
    assert.deepEqual(controller.snapshot().cells.slice(0, 2).map(cell => cell.status), ["done", "done"]);
    assert.deepEqual(controller.snapshot().cells[2]!.body, ["c <- b + 20; c"]);
    assert.equal((await run()).error, null);
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
    assert.equal(initial.error, null);
    const beforeWidget = controller.snapshot();
    const widget = dispatchHost(app, {
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
    assert.equal(explicit.error, null);
    assert.equal((await widget).error, null);
    const state = controller.snapshot();
    const widgetRecord = state.cells[0]!.outputs.find(record => widgetOutputSchema.safeParse(record.data).success);
    if (widgetRecord === undefined) {
      assert.fail("button widget output missing: outputs=" + JSON.stringify(state.cells[0]!.outputs) + " error=" + JSON.stringify(state.cells[0]!.error));
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
