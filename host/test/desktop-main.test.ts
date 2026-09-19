import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PROTOCOL, type SessionConnection } from "../src/protocol.js";
import { StructuredDiagnostics } from "../src/diagnostics.js";
import { ElectronMain, type ElectronRuntime, type ElectronWindow } from "../../desktop/src/main.js";

type RequestHandler = (path: string, init?: RequestInit) => Promise<Response>;

const origin = "http://127.0.0.1:43123";
const browserOrigin = "http://" + "a".repeat(32) + ".localhost:43123";
const resources = {
  root: "/tmp/alder-test-resources",
  nodeExecutable: "/usr/bin/node",
  hostEntry: "/tmp/alder-host.mjs",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function identity(sessionKey: string, canonicalPath: string | null): Record<string, unknown> {
  return {
    protocol: HOST_PROTOCOL,
    epoch: "epoch",
    continuityProof: "proof",
    sessionKey,
    canonicalPath,
    capabilities: [],
    origin,
    browserOrigin,
    address: { host: "127.0.0.1", port: 43123, origin, browserOrigin },
    documentReady: true,
    configuration: { rscript: null, executionMode: "automatic", runOnStartup: true, deferStartup: true },
  };
}

function connection(
  sessionKey: string,
  canonicalPath: string | null,
  request: RequestHandler,
): SessionConnection & { releaseCount: number; releaseDispositions: string[] } {
  const value = {
    sessionKey,
    canonicalPath,
    origin,
    browserOrigin,
    epoch: "epoch",
    continuityProof: "proof",
    leaseId: "lease-" + sessionKey,
    clientId: "client-" + sessionKey,
    capabilities: [],
    request,
    heartbeat: async () => undefined,
    releaseCount: 0,
    releaseDispositions: [] as string[],
    release: async (disposition = "normal") => {
      value.releaseCount += 1;
      value.releaseDispositions.push(disposition);
    },
  };
  return value as SessionConnection & { releaseCount: number; releaseDispositions: string[] };
}

function windowWithLoad(loadURL: (url: string) => Promise<void> = async () => undefined): ElectronWindow & { destroyed: boolean; focusedCount: number; titles: string[]; documentEdits: boolean[]; representedFiles: string[] } {
  let destroyed = false;
  let focusedCount = 0;
  const titles: string[] = [];
  const documentEdits: boolean[] = [];
  const representedFiles: string[] = [];
  const closedListeners: Array<() => void> = [];
  const closeListeners: Array<(event: { preventDefault: () => void }) => void> = [];
  const webRequest = {
    onBeforeSendHeaders: () => undefined,
    onHeadersReceived: () => undefined,
  };
  const webContents = {
    session: { webRequest },
    mainFrame: { url: browserOrigin + "/" },
    getURL: () => browserOrigin + "/",
    send: () => undefined,
    setWindowOpenHandler: () => undefined,
    on: () => webContents,
    once: () => webContents,
    isDestroyed: () => destroyed,
  };
  const window = {
    webContents,
    on: (event: string, listener: (...args: any[]) => void) => {
      if (event === "closed") closedListeners.push(listener);
      if (event === "close") closeListeners.push(listener);
      return window;
    },
    once: (event: string, listener: (...args: any[]) => void) => {
      if (event === "closed") closedListeners.push(listener);
      if (event === "close") closeListeners.push(listener);
      return window;
    },
    isDestroyed: () => destroyed,
    focus: () => { focusedCount += 1; },
    show: () => undefined,
    close: () => {
      let prevented = false;
      for (const listener of closeListeners) listener({ preventDefault: () => { prevented = true; } });
      if (!prevented) window.destroy();
    },
    destroy: () => { if (!destroyed) { destroyed = true; for (const listener of closedListeners) listener(); } },
    loadURL,
    setTitle: (title: string) => { titles.push(title); },
    setDocumentEdited: (edited: boolean) => { documentEdits.push(edited); },
    setRepresentedFilename: (path: string) => { representedFiles.push(path); },
  };
  Object.defineProperty(window, "destroyed", { get: () => destroyed });
  Object.defineProperty(window, "focusedCount", { get: () => focusedCount });
  return Object.assign(window, { titles, documentEdits, representedFiles }) as ElectronWindow & { destroyed: boolean; focusedCount: number; titles: string[]; documentEdits: boolean[]; representedFiles: string[] };
}

function runtime(messageResponse = 2): ElectronRuntime {
  return {
    app: { addRecentDocument: () => undefined },
    BrowserWindow: { fromWebContents: () => null },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
      showMessageBox: async () => ({ response: messageResponse }),
    },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
    shell: { openExternal: async () => undefined },
    session: { defaultSession: {} },
    ipcMain: { handle: () => undefined },
  } as unknown as ElectronRuntime;
}

function recordFor(
  main: ElectronMain,
  connectionValue: SessionConnection,
  window: ElectronWindow,
): any {
  const record = {
    window,
    keys: new Set<string>(connectionValue.canonicalPath ? [connectionValue.canonicalPath] : ["session:" + connectionValue.sessionKey]),
    connection: connectionValue,
    origin: browserOrigin,
    dirty: false,
    closing: false,
    released: false,
    reloadInProgress: false,
    monitorInProgress: false,
    hostFailureShown: false,
    loadGeneration: 0,
    rendererReadyGeneration: 0,
    windowState: null,
    pendingCommands: new Map(),
  };
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, value) => {
    send(channel, value);
    const command = value as { requestId?: string; action?: string };
    if (command.requestId) queueMicrotask(() => record.pendingCommands.get(command.requestId!)?.resolve({ requestId: command.requestId!, status: "ok" }));
  };
  window.once("closed", () => { void (main as any).disposeRecord(record); });
  (main as any).records.add(record);
  for (const key of record.keys) (main as any).addRecordKey(key, record);
  return record;
}

test("typed desktop commands cover Save, Save As, reload preparation, and close without DOM control", async () => {
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, connection("typed-commands", "/tmp/typed-commands.R", async () => jsonResponse({})), window);
  const actions: string[] = [];
  window.webContents.send = (_channel, payload) => {
    const command = payload as { requestId: string; action: string };
    actions.push(command.action);
    queueMicrotask(() => record.pendingCommands.get(command.requestId)?.resolve({ requestId: command.requestId, status: "ok" }));
  };
  await (main as any).dispatchAction(record, "save");
  await (main as any).dispatchAction(record, "save-as");
  await (main as any).prepareRendererUnload(record);
  await (main as any).dispatchAction(record, "close");
  assert.deepEqual(actions, ["save", "save-as", "prepare-unload", "close"]);
});

test("native menus expose the notebook command hierarchy and keyboard flow", () => {
  const electronRuntime = runtime();
  let template: readonly Record<string, any>[] = [];
  electronRuntime.Menu.buildFromTemplate = value => { template = value; return value; };
  const main = new ElectronMain(electronRuntime, { resources });
  (main as any).rebuildMenu();
  assert.deepEqual(template.map(item => item.label), ["Alder", "File", "Edit", "View", "Run", "Window", "Help"]);
  const run = template.find(item => item.label === "Run")!.submenu as Record<string, any>[];
  const shortcuts = Object.fromEntries(run.filter(item => item.label).map(item => [item.label, item.accelerator]));
  assert.equal(shortcuts["Run Cell"], "CmdOrCtrl+Enter");
  assert.equal(shortcuts["Run and Advance"], "Shift+Enter");
  assert.equal(shortcuts["Run All"], "CmdOrCtrl+Shift+Enter");
  assert.equal(shortcuts["Interrupt R"], "CmdOrCtrl+.");
  const file = template.find(item => item.label === "File")!.submenu as Record<string, any>[];
  assert.ok(file.some(item => item.label === "New Window for Notebook…"));
  assert.ok(file.some(item => item.label === "Publish HTML…"));
  const application = template.find(item => item.label === "Alder")!.submenu as Record<string, any>[];
  for (const role of ["about", "services", "hide", "hideOthers", "unhide"]) {
    assert.ok(application.some(item => item.role === role), role);
  }
  const view = template.find(item => item.label === "View")!.submenu as Record<string, any>[];
  assert.equal(view.some(item => item.role === "reload" || item.role === "toggleDevTools"), false);
  const help = template.find(item => item.label === "Help")!.submenu as Record<string, any>[];
  assert.equal(help.find(item => item.label === "R Documentation")?.accelerator, "F1");
  assert.ok(help.some(item => item.label === "Alder Diagnostics…"));
});

test("diagnostic menu cancellation is quiet and export failures use a bounded native error", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-desktop-diagnostic-menu-"));
  const diagnostics = new StructuredDiagnostics({ rootDir: join(root, "logs"), role: "desktop", flushDelayMs: 60_000, stderr: null });
  const electronRuntime = runtime(0);
  const dialogs: string[] = [];
  let saveCancelled = true;
  electronRuntime.dialog.showMessageBox = async (...args: any[]) => {
    const options = args.at(-1) as { title?: string; type?: string };
    dialogs.push(`${options.title}:${options.type}`);
    return { response: 0 };
  };
  electronRuntime.dialog.showSaveDialog = async () => saveCancelled
    ? ({ canceled: true, filePath: undefined })
    : ({ canceled: false, filePath: join(root, "bundle") });
  const main = new ElectronMain(electronRuntime, { resources, diagnostics });
  await (main as any).showDiagnostics();
  assert.deepEqual(dialogs, ["Alder Diagnostics:info"]);

  const window = windowWithLoad();
  recordFor(main, connection("diagnostic-export", "/tmp/diagnostic-export.R", async path => {
    if (path === "/api/snapshot") return jsonResponse({ runtime: {} });
    if (path === "/api/diagnostics/flush") return jsonResponse({ error: "failed" }, 500);
    return jsonResponse({});
  }), window);
  saveCancelled = false;
  await assert.rejects((main as any).showDiagnostics(), /diagnostic flush failed/);
  await (main as any).showDiagnosticsError();
  assert.equal(dialogs.at(-1), "Alder Diagnostics:error");
  await diagnostics.close();
  await rm(root, { recursive: true, force: true });
});

test("diagnostic menu reports unavailable logging without throwing from its click handler", async () => {
  const electronRuntime = runtime(0);
  let template: readonly Record<string, any>[] = [];
  const dialogs: string[] = [];
  electronRuntime.Menu.buildFromTemplate = value => { template = value; return value; };
  electronRuntime.dialog.showMessageBox = async (...args: any[]) => {
    dialogs.push((args.at(-1) as { type?: string }).type ?? "unknown");
    return { response: 0 };
  };
  const main = new ElectronMain(electronRuntime, { resources });
  (main as any).rebuildMenu();
  const help = template.find(item => item.label === "Help")!.submenu as Record<string, any>[];
  help.find(item => item.label === "Alder Diagnostics…")!.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dialogs, ["error"]);
});

test("Open and startup errors use ownerless native dialogs", async () => {
  const electronRuntime = runtime();
  const notebookPath = "/tmp/ownerless-open.R";
  const dialogCalls: unknown[][] = [];
  electronRuntime.dialog.showOpenDialog = async (...args: unknown[]) => { dialogCalls.push(args); return { canceled: false, filePaths: [notebookPath] }; };
  electronRuntime.dialog.showMessageBox = async (...args: unknown[]) => { dialogCalls.push(args); return { response: 0 }; };
  const main = new ElectronMain(electronRuntime, { resources });
  let opened: string | null = null;
  (main as any).openNotebook = async (path: string) => { opened = path; };
  await (main as any).openNotebookFromDialog(undefined);
  await (main as any).showApplicationError("Startup failed", "backend unavailable");
  assert.equal(opened, notebookPath);
  assert.equal(dialogCalls[0]!.length, 1);
  assert.equal(dialogCalls[1]!.length, 1);
});

test("desktop identity polling adopts an authoritative Save As and preserves one window", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-desktop-identity-"));
  try {
    const oldPath = join(root, "before.R");
    const newPath = join(root, "after.R");
    await writeFile(oldPath, "old\n");
    await writeFile(newPath, "new\n");
    const newCanonicalPath = await realpath(newPath);
    const oldConnection = connection("session-before", oldPath, async path => {
      assert.equal(path, "/api/identity");
      return jsonResponse(identity("session-after", newCanonicalPath));
    });
    const window = windowWithLoad();
    const main = new ElectronMain(runtime(), { resources });
    const record = recordFor(main, oldConnection, window);

    await (main as any).assertHostContinuity(record);

    assert.equal(record.connection.sessionKey, "session-after");
    assert.equal(record.connection.canonicalPath, newCanonicalPath);
    assert.equal((main as any).byKey.get(oldPath), undefined);
    assert.equal((main as any).byKey.get(newCanonicalPath)?.has(record), true);
    assert.deepEqual(record.keys, new Set([newCanonicalPath]));
    assert.equal(window.titles.at(-1), "after.R — Alder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled close keeps the editor open when the host is unavailable", async () => {
  const oldPath = "/tmp/alder-desktop-dirty-query-failure.R";
  const oldConnection = connection("session-dirty", oldPath, async path => {
    if (path === "/api/identity") return jsonResponse(identity("session-dirty", oldPath));
    throw new Error("authoritative query unavailable");
  });
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(2), { resources });
  const record = recordFor(main, oldConnection, window);

  await (main as any).requestClose(record);

  assert.equal(record.dirty, true);
  assert.equal(record.closing, false);
  assert.equal(window.destroyed, false);
  assert.equal(oldConnection.releaseCount, 0);
});

test("native close waits for the renderer to persist its latest draft", async () => {
  const hostConnection = connection("close-flush", "/tmp/alder-close-flush.R", async () => { throw new Error("unexpected host request"); });
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, hostConnection, window);
  (main as any).readWindowState = async () => ({ path: hostConnection.canonicalPath, dirty: false, saveState: "saved", sessionEpoch: "epoch" });
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  window.webContents.send = (_channel, payload) => {
    const command = payload as { requestId?: string; action?: string };
    if (command.action === "prepare-unload" && command.requestId) void acknowledged.then(() => record.pendingCommands.get(command.requestId!)?.resolve({ requestId: command.requestId!, status: "ok" }));
  };

  const closing = (main as any).requestClose(record);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.destroyed, false);
  acknowledge();
  await closing;
  assert.equal(window.destroyed, true);
});

test("discard closes within a bounded time when the host is unavailable and lease release stalls", { timeout: 4_000 }, async () => {
  const hostConnection = connection("offline-discard", null, async () => {
    throw new Error("host is unavailable");
  });
  let releaseDisposition: string | undefined;
  hostConnection.release = async disposition => {
    releaseDisposition = disposition;
    await new Promise<void>(() => undefined);
  };
  const window = windowWithLoad();
  const actions: unknown[] = [];
  window.webContents.send = (_channel, payload) => { actions.push(payload); };
  const main = new ElectronMain(runtime(1), { resources });
  const record = recordFor(main, hostConnection, window);

  await (main as any).requestClose(record);

  assert.deepEqual(actions.map(value => (value as { action: string }).action), ["prepare-unload", "close"]);
  assert.equal(releaseDisposition, "discard");
  assert.equal(window.destroyed, true);
  assert.equal(main.windows().length, 0);
});

test("cancelled quit preserves unsaved windows and a later quit can discard them", { timeout: 4_000 }, async () => {
  const hostConnection = connection("cancel-quit", null, async () => { throw new Error("host unavailable"); });
  const window = windowWithLoad();
  const actions: unknown[] = [];
  window.webContents.send = (_channel, payload) => { actions.push(payload); };
  const electronRuntime = runtime();
  const events = new Map<string, (...args: any[]) => unknown>();
  electronRuntime.app.requestSingleInstanceLock = () => true;
  electronRuntime.app.whenReady = async () => undefined;
  electronRuntime.app.on = (event, handler) => { events.set(event, handler); return electronRuntime.app; };
  let quits = 0;
  electronRuntime.app.quit = () => { quits += 1; };
  let response = 2;
  let dialogs = 0;
  electronRuntime.dialog.showMessageBox = async () => { dialogs += 1; return { response }; };
  const main = new ElectronMain(electronRuntime, { resources, initialPath: null });
  main.openNotebook = async () => undefined;
  recordFor(main, hostConnection, window);
  await main.start();
  let prevented = 0;
  const beforeQuit = events.get("before-quit")!;
  beforeQuit({ preventDefault: () => { prevented += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialogs, 1);
  assert.equal(prevented, 1);
  assert.equal(quits, 0);
  assert.equal(window.destroyed, false);
  assert.equal(hostConnection.releaseCount, 0);
  assert.deepEqual(actions, []);

  response = 1;
  beforeQuit({ preventDefault: () => { prevented += 1; } });
  while (quits === 0) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(dialogs, 2);
  assert.equal(window.destroyed, true);
  assert.deepEqual(hostConnection.releaseDispositions, ["discard"]);
});

for (const decision of ["Cancel", "Save"] as const) {
  test(`repeated native Close events cannot bypass a pending ${decision} decision`, { timeout: 3_000 }, async () => {
    const path = "/tmp/alder-repeated-close.R";
    const hostConnection = connection("repeated-close", path, async endpoint => {
      assert.equal(endpoint, "/api/ticket");
      return jsonResponse({ ticket: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
    });
    const window = windowWithLoad();
    const actions: unknown[] = [];
    window.webContents.send = (_channel, payload) => {
      actions.push(payload);
      const command = payload as { requestId?: string };
      if (command.requestId) queueMicrotask(() => ([...(main as any).records][0] as any)?.pendingCommands.get(command.requestId)?.resolve({ requestId: command.requestId, status: "ok" }));
    };
    const electronRuntime = runtime();
    electronRuntime.BrowserWindow = Object.assign(function () { return window; }, { fromWebContents: () => window }) as unknown as ElectronRuntime["BrowserWindow"];
    const dialogOpened = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ response: number }>();
    let dialogs = 0;
    electronRuntime.dialog.showMessageBox = async () => { dialogs += 1; dialogOpened.resolve(); return answer.promise; };
    const main = new ElectronMain(electronRuntime, { resources, acquireSession: async () => hostConnection, closeSettlementTimeoutMs: 1_000 });
    (main as any).loadAuthenticatedNotebook = async () => undefined;
    let dirty = true;
    (main as any).readWindowState = async () => ({ path, dirty, saveState: dirty ? "edited" : "saved", sessionEpoch: "epoch" });
    try {
      await main.openNotebook(path);
      window.close();
      await dialogOpened.promise;
      window.close();
      window.close();
      assert.equal(window.destroyed, false);
      assert.equal(dialogs, 1);
      assert.equal(hostConnection.releaseCount, 0);
      answer.resolve({ response: decision === "Cancel" ? 2 : 0 });
      await new Promise(resolve => setImmediate(resolve));
      if (decision === "Cancel") {
        assert.equal(window.destroyed, false);
        assert.deepEqual(actions, []);
        assert.equal(hostConnection.releaseCount, 0);
      } else {
        assert.deepEqual(actions.map(value => (value as { action: string }).action), ["save"]);
        window.close();
        assert.equal(window.destroyed, false, "the window must remain open until saving finishes");
        dirty = false;
        while (!window.destroyed) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(actions.map(value => (value as { action: string }).action), ["save", "prepare-unload"]);
        assert.equal(hostConnection.releaseCount, 1);
      }
    } finally {
      answer.resolve({ response: 2 });
      await main.stop();
    }
  });
}

test("native recovery IPC accepts the owning main frame and keeps its recovery identity scoped", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-desktop-recovery-ipc-")));
  try {
    const window = windowWithLoad();
    const hostConnection = connection("native-recovery", null, async () => { throw new Error("unexpected request"); });
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const electronRuntime = runtime();
    electronRuntime.app.getPath = () => root;
    electronRuntime.BrowserWindow.fromWebContents = sender => sender === window.webContents ? window : null;
    electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
    const main = new ElectronMain(electronRuntime, { resources });
    recordFor(main, hostConnection, window);
    (main as any).installIpcHandlers();
    const recovery = handlers.get("alderDesktop:recovery")!;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const recoveryId = "a".repeat(43);
    const name = "draft:client-one";
    const value = { source: "# %%\nx <- 42\n" };
    await recovery(event, { action: "write", recoveryId, name, value });
    assert.deepEqual(await recovery(event, { action: "read", recoveryId, name }), value);
    await assert.rejects(recovery({ ...event, senderFrame: { url: browserOrigin + "/" } }, { action: "read", recoveryId, name }), /main frame/);
    await assert.rejects(recovery({ sender: windowWithLoad().webContents }, { action: "read", recoveryId, name }), /active application window/);
    await assert.rejects(recovery(event, { action: "read", recoveryId: "b".repeat(43), name }), /identity changed/);
    await recovery(event, { action: "remove", recoveryId, name });
    assert.equal(await recovery(event, { action: "read", recoveryId, name }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("typed renderer state drives native edited state and represented filename", async () => {
  const path = "/tmp/alder-native-document.R";
  const window = windowWithLoad();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow.fromWebContents = sender => sender === window.webContents ? window : null;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const main = new ElectronMain(electronRuntime, { resources });
  recordFor(main, connection("native-document", path, async () => { throw new Error("unexpected request"); }), window);
  (main as any).installIpcHandlers();
  const update = handlers.get("alderDesktop:windowState")!;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await update(event, { path, dirty: true, saveState: "edited", sessionEpoch: "epoch" });
  await update(event, { path, dirty: false, saveState: "saved", sessionEpoch: "epoch" });
  assert.deepEqual(window.documentEdits, [true, false]);
  assert.deepEqual(window.representedFiles, [path, path]);
  assert.match(window.titles.at(-1) ?? "", /^alder-native-document\.R — Alder$/);
});

test("Save As returns an absent target or the exact explicitly confirmed destination", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-desktop-save-as-")));
  try {
    const destination = join(root, "copy.R");
    const hostConnection = connection("save-as-dialog", null, async () => { throw new Error("unexpected request"); });
    const window = windowWithLoad();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const electronRuntime = runtime();
    electronRuntime.BrowserWindow.fromWebContents = () => window;
    electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
    electronRuntime.dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    electronRuntime.dialog.showMessageBox = async () => { throw new Error("the native save panel already confirms replacement"); };
    const main = new ElectronMain(electronRuntime, { resources });
    recordFor(main, hostConnection, window);
    (main as any).installIpcHandlers();
    const choose = handlers.get("alderDesktop:chooseSavePath")!;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    assert.deepEqual(await choose(event), { path: destination, expectedDestination: "absent" });

    const previous = "# %%\nprevious <- 1\n";
    await writeFile(destination, previous);
    const info = await stat(destination, { bigint: true });
    const digest = createHash("sha256").update(previous).digest("hex");
    assert.deepEqual(await choose(event), {
      path: destination,
      expectedDestination: {
        expectedDiskDigest: digest,
        expectedDiskVersion: `${info.dev}:${info.ino}:${Number(info.mode & 0o777n).toString(8)}:${digest}`,
      },
    });
    electronRuntime.dialog.showSaveDialog = async () => ({ canceled: true });
    assert.equal(await choose(event), null);
    assert.equal(await readFile(destination, "utf8"), previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop close returns immediately when untitled Save As is cancelled", async () => {
  const notebookPath = "/tmp/alder-desktop-save-cancelled.R";
  const hostConnection = connection("session-save-cancelled", notebookPath, async () => {
    throw new Error("unexpected host request");
  });
  const window = windowWithLoad();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const electronRuntime = runtime(0);
  electronRuntime.BrowserWindow.fromWebContents = () => window;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const main = new ElectronMain(electronRuntime, { resources, closeSettlementTimeoutMs: 30_000 });
  const record = recordFor(main, hostConnection, window);
  (main as any).readWindowState = async () => ({ path: null, dirty: true, saveState: "edited", sessionEpoch: "epoch" });
  let applicationErrors = 0;
  (main as any).showApplicationError = async () => { applicationErrors += 1; };
  window.webContents.send = (_channel, payload) => {
    const command = payload as { requestId?: string; action?: string };
    if (command.action === "save" && command.requestId) void handlers.get("alderDesktop:commandResult")?.({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { requestId: command.requestId, status: "cancelled" });
  };
  (main as any).installIpcHandlers();

  await (main as any).requestClose(record);

  assert.equal(record.closing, false);
  assert.equal(window.destroyed, false);
  assert.equal(applicationErrors, 0);
});
test("desktop restart failure preserves the existing editor and releases only the replacement", async () => {
  const oldPath = "/tmp/alder-desktop-restart-failure.R";
  const oldConnection = connection("session-old", oldPath, async path => {
    assert.equal(path, "/api/ticket");
    return jsonResponse({ ticket: "a".repeat(64), expiresAt: "2026-01-01T00:00:00.000Z" });
  });
  const nextConnection = connection("session-next", oldPath, async path => {
    assert.equal(path, "/api/ticket");
    return jsonResponse({ ticket: "b".repeat(64), expiresAt: "2026-01-01T00:00:00.000Z" });
  });
  let loadCount = 0;
  const window = windowWithLoad(async () => {
    loadCount += 1;
    throw new Error("authenticated page load failed");
  });
  const main = new ElectronMain(runtime(0), {
    resources,
    acquireSession: async () => nextConnection,
  });
  const record = recordFor(main, oldConnection, window);
  (main as any).showApplicationError = async () => undefined;

  await (main as any).restartHost(record);

  assert.equal(loadCount, 2);
  assert.equal(nextConnection.releaseCount, 1);
  assert.equal(oldConnection.releaseCount, 0);
  assert.equal(record.released, false);
  assert.equal(main.windows().length, 1);
  assert.equal(window.destroyed, false);
});
test("opening a notebook replaces a clean untitled launch window", async () => {
  const openedPath = join(tmpdir(), "opened.R");
  const untitledConnection = connection("untitled", null, async () => { throw new Error("unexpected request"); });
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, untitledConnection, window);
  let opened: string | null = null;
  (main as any).openNotebook = async (path: string) => { opened = path; };
  (main as any).readWindowState = async () => ({ path: null, dirty: false, saveState: "saved", sessionEpoch: "epoch" });
  await (main as any).openReplacingPristineUntitled(record, openedPath);

  assert.equal(opened, openedPath);
  assert.equal(untitledConnection.releaseCount, 1);
  assert.deepEqual(untitledConnection.releaseDispositions, ["normal"]);
  assert.equal(record.released, true);
  assert.equal(window.destroyed, true);
  assert.equal(main.windows().length, 0);
});

test("opening the same notebook focuses its existing window unless a new window is explicit", async () => {
  const diagnosticRoot = await mkdtemp(join(tmpdir(), "alder-window-diagnostics-"));
  const diagnostics = new StructuredDiagnostics({ rootDir: diagnosticRoot, role: "desktop", flushDelayMs: 0, stderr: null });
  const path = "/tmp/alder-shared-gui.R";
  const ticket = async (endpoint: string) => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  };
  const first = connection("shared-session", path, ticket);
  const second = connection("shared-session", path, ticket);
  second.leaseId = "lease-shared-second";
  const windows = [windowWithLoad(), windowWithLoad()];
  let windowIndex = 0;
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow = Object.assign(function () { return windows[windowIndex++]!; }, { fromWebContents: () => null }) as unknown as ElectronRuntime["BrowserWindow"];
  const connections = [first, second];
  const main = new ElectronMain(electronRuntime, { resources, diagnostics, acquireSession: async () => connections.shift()! });
  (main as any).loadAuthenticatedNotebook = async () => undefined;
  await main.openNotebook(path);
  await main.openNotebook(path);
  assert.equal(main.windows().length, 1);
  assert.equal(windows[0]!.focusedCount, 1);
  await main.openNotebook(path, { newWindow: true });
  assert.equal(main.windows().length, 2);
  windows[0]!.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.releaseCount, 1);
  assert.equal(second.releaseCount, 0);
  assert.equal(main.windows().length, 1);
  await main.stop();
  const diagnosticFiles = (await readdir(diagnosticRoot)).filter(name => name.endsWith(".jsonl"));
  const diagnosticText = (await Promise.all(diagnosticFiles.map(name => readFile(join(diagnosticRoot, name), "utf8")))).join("");
  const opens = diagnosticText.trim().split("\n").map(line => JSON.parse(line) as { event: string; cold?: boolean }).filter(item => item.event === "window.open");
  assert.deepEqual(opens.map(item => item.cold), [true, false]);
  await rm(diagnosticRoot, { recursive: true, force: true });
});

test("opening a notebook retains an untitled window with uncertain state", async () => {
  const openedPath = join(tmpdir(), "opened.R");
  const untitledConnection = connection("untitled", null, async () => { throw new Error("unexpected request"); });
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, untitledConnection, window);
  (main as any).openNotebook = async () => undefined;
  (main as any).readWindowState = async () => { throw new Error("renderer state unavailable"); };

  await (main as any).openReplacingPristineUntitled(record, openedPath);

  assert.equal(untitledConnection.releaseCount, 0);
  assert.equal(record.released, false);
  assert.equal(window.destroyed, false);
  assert.equal(main.windows().length, 1);
});

test("approved notebook reload can leave an unsaved renderer while ordinary navigation cannot", () => {
  const window = windowWithLoad();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  window.webContents.on = (event, handler) => { handlers.set(event, handler); return window.webContents; };
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, connection("reload", "/tmp/reload.R", async () => jsonResponse({})), window);
  (main as any).installWindowPolicy(record);
  let allowed = false;
  const event = { preventDefault: () => { allowed = true; } };
  handlers.get("will-prevent-unload")!(event);
  assert.equal(allowed, false);
  record.loadingOrigin = browserOrigin;
  handlers.get("will-prevent-unload")!(event);
  assert.equal(allowed, true);
});

test("host restart preserves the live editor when its current draft cannot be stored", async () => {
  const window = windowWithLoad();
  let acquired = false;
  const main = new ElectronMain(runtime(), { resources, acquireSession: async () => { acquired = true; throw new Error("should not replace editor"); } });
  const record = recordFor(main, connection("restart-draft", "/tmp/restart-draft.R", async () => jsonResponse({})), window);
  window.webContents.send = () => undefined;
  await (main as any).restartHost(record);
  assert.equal(acquired, false);
  assert.equal(window.destroyed, false);
  assert.equal(record.loadingOrigin, undefined);
});


test("saving recovered source clears the native unsaved prompt despite an older snapshot dirty flag", async () => {
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, connection("recovered-save", "/tmp/recovered-save.R", async () => jsonResponse({})), window);
  record.windowState = { path: "/tmp/recovered-save.R", dirty: false, saveState: "saved", sessionEpoch: "epoch" };
  assert.equal((await (main as any).readWindowState(record)).dirty, false);
});
