import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PROTOCOL, type SessionConnection } from "../src/protocol.js";
import { StructuredDiagnostics } from "../src/diagnostics.js";
import { connectBackendSession, sessionKeyFor } from "../src/sessions.js";
import { ElectronMain, type ElectronRuntime, type ElectronWindow } from "../../desktop/src/main.js";
import { NativeRecoveryStore } from "../../desktop/src/recovery-store.js";

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
    abandon: () => undefined,
    releaseCount: 0,
    releaseDispositions: [] as string[],
    release: async (disposition = "normal") => {
      value.releaseCount += 1;
      value.releaseDispositions.push(disposition);
    },
  };
  return value as SessionConnection & { releaseCount: number; releaseDispositions: string[] };
}

async function fetchedConnection(context: test.TestContext, release: (init: RequestInit) => Promise<Response>): Promise<SessionConnection> {
  const sessionKey = "d".repeat(64);
  const canonicalPath = "/tmp/alder-real-release.R";
  const continuityProof = "proof";
  context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { action?: string };
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "Content-Type": "application/json", "X-Alder-Continuity-Proof": continuityProof },
    });
    if (init?.method === "GET") return response(identity(sessionKey, canonicalPath));
    if (body?.action === "attach") return response({ leaseId: "lease-real", clientId: "client-real", epoch: "epoch" });
    return release(init ?? {});
  });
  return connectBackendSession({
    sessionKey, canonicalPath, origin, browserOrigin, epoch: "epoch", continuityProof,
    token: "a".repeat(64), capabilities: [],
  }, { path: canonicalPath, resources });
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
    draftId: randomUUID(),
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

test("created notebook windows keep the native renderer sandbox boundary", async () => {
  const window = windowWithLoad();
  const electronRuntime = runtime();
  let creationOptions: Record<string, unknown> | undefined;
  electronRuntime.BrowserWindow = Object.assign(function (options: Record<string, unknown>) {
    creationOptions = options;
    return window;
  }, { fromWebContents: () => null }) as unknown as ElectronRuntime["BrowserWindow"];
  const hostConnection = connection("sandbox-window", "/tmp/sandbox-window.R", async endpoint => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  const main = new ElectronMain(electronRuntime, { resources, acquireSession: async () => hostConnection });
  (main as any).loadAuthenticatedNotebook = async () => undefined;
  try {
    await main.openNotebook("/tmp/sandbox-window.R");
    const webPreferences = creationOptions?.webPreferences as Record<string, unknown> | undefined;
    assert.deepEqual({
      nodeIntegration: webPreferences?.nodeIntegration,
      contextIsolation: webPreferences?.contextIsolation,
      sandbox: webPreferences?.sandbox,
    }, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  } finally {
    window.destroy();
    await new Promise(resolve => setImmediate(resolve));
    await main.stop();
  }
});

test("privileged IPC accepts only the owning main frame at the authenticated nonce origin", async () => {
  const window = windowWithLoad();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow.fromWebContents = sender => sender === window.webContents ? window : null;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const main = new ElectronMain(electronRuntime, { resources });
  recordFor(main, connection("origin-policy", "/tmp/origin-policy.R", async () => jsonResponse({})), window);
  (main as any).installIpcHandlers();
  const getDraftId = handlers.get("alderDesktop:getDraftId")!;
  const mainFrame = window.webContents.mainFrame as { url?: string };
  const event = { sender: window.webContents, senderFrame: mainFrame };

  mainFrame.url = browserOrigin + "/index.html";
  assert.match(String(await getDraftId(event)), /^[0-9a-f-]{36}$/);

  for (const invalid of [
    "http://127.0.0.1:43123/index.html",
    "http://localhost:43123/index.html",
    "http://" + "b".repeat(32) + ".localhost:43123/index.html",
    "http://" + "a".repeat(31) + ".localhost:43123/index.html",
    "http://" + "a".repeat(32) + ".localhost.evil:43123/index.html",
    "https://" + "a".repeat(32) + ".localhost:43123/index.html",
  ]) {
    mainFrame.url = invalid;
    await assert.rejects(Promise.resolve().then(() => getDraftId(event)), /origin is not trusted/, invalid);
  }
});

test("native navigation and opener hooks keep the window on its authenticated origin", async () => {
  const window = windowWithLoad();
  const listeners = new Map<string, (...args: any[]) => unknown>();
  let openHandler: ((details: { url: string; disposition?: string; referrer?: { url?: string } }) => { action: "allow" | "deny" }) | undefined;
  window.webContents.on = (event, handler) => { listeners.set(event, handler); return window.webContents; };
  window.webContents.setWindowOpenHandler = handler => { openHandler = handler; };
  const opened: string[] = [];
  const electronRuntime = runtime();
  electronRuntime.shell.openExternal = async url => { opened.push(url); };
  const main = new ElectronMain(electronRuntime, { resources });
  const record = recordFor(main, connection("navigation-policy", "/tmp/navigation-policy.R", async () => jsonResponse({})), window);
  (main as any).installWindowPolicy(record);

  for (const eventName of ["will-navigate", "will-frame-navigate"]) {
    let prevented = false;
    listeners.get(eventName)!({ preventDefault: () => { prevented = true; } }, browserOrigin + "/notebook");
    assert.equal(prevented, false, `${eventName} should allow the owned application origin`);
    listeners.get(eventName)!({ preventDefault: () => { prevented = true; } }, "https://example.com/unowned");
    assert.equal(prevented, true, `${eventName} should block an unowned origin`);
  }

  assert.deepEqual(openHandler!({
    url: "https://example.com/reference",
    disposition: "foreground-tab",
    referrer: { url: browserOrigin + "/index.html" },
  }), { action: "deny" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ["https://example.com/reference"]);

  assert.deepEqual(openHandler!({
    url: "https://example.com/rejected",
    disposition: "foreground-tab",
    referrer: { url: "http://127.0.0.1:43123/index.html" },
  }), { action: "deny" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ["https://example.com/reference"]);
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

test("renderer Save As report immediately updates native identity and restart target without notebook polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-desktop-identity-"));
  try {
    const oldPath = join(root, "before.R");
    const newPath = join(root, "after.R");
    await writeFile(oldPath, "old\n");
    await writeFile(newPath, "new\n");
    const newCanonicalPath = await realpath(newPath);
    const newSessionKey = sessionKeyFor(newCanonicalPath);
    let identityRequests = 0;
    const oldConnection = connection("session-before", oldPath, async path => {
      assert.equal(path, "/api/identity");
      identityRequests += 1;
      return jsonResponse(identity(newSessionKey, newCanonicalPath));
    });
    const window = windowWithLoad();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const electronRuntime = runtime();
    electronRuntime.BrowserWindow.fromWebContents = () => window;
    electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
    let restartPath: string | null | undefined;
    const nextConnection = connection(newSessionKey, newCanonicalPath, async path => {
      assert.equal(path, "/api/ticket");
      return jsonResponse({ ticket: "c".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
    });
    const main = new ElectronMain(electronRuntime, { resources, acquireSession: async options => {
      restartPath = options.path;
      return nextConnection;
    } });
    const record = recordFor(main, oldConnection, window);
    record.loadGeneration = 1;
    record.authenticatedRendererGeneration = 1;
    (main as any).installIpcHandlers();
    (main as any).loadAuthenticatedNotebook = async () => undefined;
    await (main as any).monitorHost(record);
    assert.equal(identityRequests, 0);
    const update = handlers.get("alderDesktop:windowState")!;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const reported = update(event, { path: newCanonicalPath, dirty: false, saveState: "saved", sessionEpoch: "epoch" });
    assert.equal(identityRequests, 0);
    assert.equal(record.connection.canonicalPath, newCanonicalPath);
    assert.equal(record.connection.sessionKey, newSessionKey);
    const restarting = (main as any).restartHost(record);
    await Promise.all([reported, restarting]);

    assert.equal(restartPath, newCanonicalPath);
    assert.equal(record.connection, nextConnection);
    assert.equal(record.connection.canonicalPath, newCanonicalPath);
    assert.ok(identityRequests > 0);
    assert.equal((main as any).byKey.get(oldPath), undefined);
    assert.equal((main as any).byKey.get(newCanonicalPath)?.has(record), true);
    assert.deepEqual(record.keys, new Set([newCanonicalPath]));
    assert.equal(window.titles.at(-1), "after.R — Alder");
    await main.openNotebook(newCanonicalPath);
    assert.equal(window.focusedCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old identity reply cannot rewrite a replacement connection", async () => {
  const oldPath = "/tmp/alder-old-identity.R";
  const newPath = "/tmp/alder-new-identity.R";
  const delayed = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const old = connection(sessionKeyFor(oldPath), oldPath, async () => { started.resolve(); return delayed.promise; });
  const next = connection(sessionKeyFor(newPath), newPath, async () => jsonResponse(identity(sessionKeyFor(newPath), newPath)));
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, old, window);
  const check = (main as any).assertHostContinuity(record);
  await started.promise;
  (main as any).replaceConnection(record, next);
  delayed.resolve(jsonResponse(identity(sessionKeyFor(oldPath), oldPath)));
  await check;
  assert.equal(record.connection, next);
  assert.equal(record.connection.canonicalPath, newPath);
  assert.equal((main as any).byKey.get(oldPath), undefined);
  assert.equal((main as any).byKey.get(newPath)?.has(record), true);
  assert.equal(window.titles.at(-1), "alder-new-identity.R — Alder");
});

test("a newer renderer Save As report wins over an in-flight older identity reply", async () => {
  const oldPath = "/tmp/alder-before-identity.R";
  const newPath = "/tmp/alder-after-identity.R";
  const delayed = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const old = connection(sessionKeyFor(oldPath), oldPath, async () => { started.resolve(); return delayed.promise; });
  const window = windowWithLoad();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow.fromWebContents = () => window;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const main = new ElectronMain(electronRuntime, { resources });
  const record = recordFor(main, old, window);
  (main as any).installIpcHandlers();
  const check = (main as any).assertHostContinuity(record);
  await started.promise;
  handlers.get("alderDesktop:windowState")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { path: newPath, dirty: true, saveState: "edited", sessionEpoch: "epoch" });
  delayed.resolve(jsonResponse(identity(sessionKeyFor(oldPath), oldPath)));
  await check;
  assert.equal(record.connection.canonicalPath, newPath);
  assert.equal(record.connection.sessionKey, sessionKeyFor(newPath));
  assert.equal(record.windowState.path, newPath);
  assert.equal(record.windowState.dirty, true);
  assert.equal((main as any).byKey.get(oldPath), undefined);
  assert.equal((main as any).byKey.get(newPath)?.has(record), true);
});

test("a reported Save As survives backend death and restarts at its destination with the native draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-dead-save-as-"));
  try {
    const oldPath = join(root, "before.R");
    const newPath = join(root, "after.R");
    const recoveryId = "r".repeat(43);
    const native = new NativeRecoveryStore(join(root, "native-drafts"));
    const old = connection(sessionKeyFor(oldPath), oldPath, async () => { throw new Error("backend exited"); });
    const next = connection(sessionKeyFor(newPath), newPath, async endpoint => {
      assert.equal(endpoint, "/api/ticket");
      return jsonResponse({ ticket: "c".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
    });
    const window = windowWithLoad();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const electronRuntime = runtime();
    electronRuntime.BrowserWindow.fromWebContents = () => window;
    electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
    let acquiredPath: string | null | undefined;
    const main = new ElectronMain(electronRuntime, { resources, acquireSession: async options => {
      acquiredPath = options.path;
      return next;
    } });
    const record = recordFor(main, old, window);
    record.loadGeneration = 1;
    record.authenticatedRendererGeneration = 1;
    (main as any).installIpcHandlers();
    (main as any).loadAuthenticatedNotebook = async () => undefined;
    window.webContents.send = (_channel, value) => {
      const command = value as { requestId: string; action: string };
      const settle = () => record.pendingCommands.get(command.requestId)?.resolve({ requestId: command.requestId, status: "ok" });
      if (command.action === "prepare-unload") void native.write(recoveryId, "draft:" + record.draftId, { body: "unsubmitted edit" }).then(settle);
      else queueMicrotask(settle);
    };
    handlers.get("alderDesktop:windowState")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame },
      { path: newPath, dirty: true, saveState: "edited", sessionEpoch: "epoch" });
    const draftId = record.draftId;
    await (main as any).restartHost(record);
    assert.equal(acquiredPath, newPath);
    assert.equal(record.connection, next);
    assert.equal(record.draftId, draftId);
    assert.deepEqual(await native.read(recoveryId, "draft:" + draftId), { body: "unsubmitted edit" });
    assert.equal((main as any).byKey.get(newPath)?.has(record), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native restart requests a fresh notebook document response on the same host origin", async () => {
  const urls: URL[] = [];
  let response: ((details: { resourceType: string; responseHeaders: Record<string, string[]> }, callback: (result: { cancel?: boolean }) => void) => void) | undefined;
  let record: any;
  const window = windowWithLoad(async url => {
    urls.push(new URL(url));
    response!({ resourceType: "mainFrame", responseHeaders: { "X-Alder-Continuity-Proof": ["proof"] } }, result => assert.equal(result.cancel, undefined));
    queueMicrotask(() => record.rendererReady.resolve());
  });
  window.webContents.session!.webRequest!.onHeadersReceived = (_filter, callback) => { response = callback as typeof response; };
  const main = new ElectronMain(runtime(), { resources });
  record = recordFor(main, connection("same-origin-reload", "/tmp/same-origin-reload.R", async () => jsonResponse({})), window);
  await (main as any).loadAuthenticatedNotebook(record, "a".repeat(64));
  await (main as any).loadAuthenticatedNotebook(record, "b".repeat(64));
  assert.equal(urls.length, 2);
  assert.equal(urls[0]!.pathname, "/index.html");
  assert.equal(urls[1]!.pathname, "/index.html");
  assert.notEqual(urls[0]!.search, urls[1]!.search);
  assert.equal(urls[0]!.hash, "#ticket=" + "a".repeat(64));
  assert.equal(urls[1]!.hash, "#ticket=" + "b".repeat(64));
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

test("unreachable host cannot veto a clean local Close", { timeout: 3_000 }, async () => {
  const hostConnection = connection("offline-close", "/tmp/alder-offline-close.R", async () => jsonResponse({}));
  let abandoned = 0;
  hostConnection.release = async () => { hostConnection.releaseCount += 1; throw new Error("host offline"); };
  hostConnection.abandon = () => { abandoned += 1; };
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, hostConnection, window);
  record.windowState = { path: hostConnection.canonicalPath, dirty: false, saveState: "saved", sessionEpoch: "epoch" };
  await (main as any).requestClose(record);
  assert.equal(window.destroyed, true);
  assert.equal(main.windows().length, 0);
  assert.equal(hostConnection.releaseCount, 1);
  assert.equal(abandoned, 1);
});

test("dirty responsive renderer can Close and Keep Recovery after host command failure", { timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-keep-recovery-"));
  const recoveryId = randomUUID();
  const store = new NativeRecoveryStore(directory);
  const path = "/tmp/alder-dirty-offline.R";
  const hostConnection = connection("dirty-offline", path, async endpoint => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  const window = windowWithLoad();
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow = Object.assign(function () { return window; }, { fromWebContents: () => window }) as unknown as ElectronRuntime["BrowserWindow"];
  const dialogs: string[][] = [];
  electronRuntime.dialog.showMessageBox = async (_window, options) => {
    dialogs.push(options.buttons ?? []);
    return { response: dialogs.length === 1 ? 1 : 0 };
  };
  const main = new ElectronMain(electronRuntime, { resources, acquireSession: async () => hostConnection });
  (main as any).loadAuthenticatedNotebook = async () => undefined;
  await main.openNotebook(path);
  const record = [...(main as any).records][0];
  record.recoveryId = recoveryId;
  record.windowState = { path: hostConnection.canonicalPath, dirty: true, saveState: "edited", sessionEpoch: "epoch" };
  const actions: string[] = [];
  window.webContents.send = (_channel, payload) => {
    const command = payload as { requestId: string; action: string };
    actions.push(command.action);
    if (command.action === "prepare-unload") {
      void store.write(recoveryId, "draft:" + record.draftId, { body: "typing retained" })
        .then(() => record.pendingCommands.get(command.requestId)?.resolve({ requestId: command.requestId, status: "ok" }));
    } else {
      queueMicrotask(() => record.pendingCommands.get(command.requestId)?.resolve({
        requestId: command.requestId, status: "error", message: "host command unavailable",
      }));
    }
  };
  try {
    await (main as any).requestClose(record);
    assert.equal(window.destroyed, true);
    assert.equal(main.windows().length, 0);
    assert.equal(hostConnection.releaseCount, 1);
    assert.deepEqual(actions, ["prepare-unload", "close", "prepare-unload"]);
    assert.deepEqual(dialogs[1], ["Close and Keep Recovery", "Keep Window Open"]);
    const reopenedStore = new NativeRecoveryStore(directory);
    assert.deepEqual(await reopenedStore.read(recoveryId, "draft:" + record.draftId), { body: "typing retained" });
    assert.deepEqual((await reopenedStore.listDrafts(recoveryId)).draftIds, [record.draftId]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("quit joins one in-flight detach", { timeout: 3_000 }, async () => {
  const hostConnection = connection("quit-detach", "/tmp/alder-quit-detach.R", async () => jsonResponse({}));
  const finish = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  hostConnection.release = async () => { hostConnection.releaseCount += 1; started.resolve(); await finish.promise; };
  const window = windowWithLoad();
  const electronRuntime = runtime();
  const events = new Map<string, (...args: any[]) => unknown>();
  electronRuntime.app.requestSingleInstanceLock = () => true;
  electronRuntime.app.whenReady = async () => undefined;
  electronRuntime.app.on = (event, handler) => { events.set(event, handler); return electronRuntime.app; };
  let quits = 0;
  electronRuntime.app.quit = () => { quits += 1; };
  const main = new ElectronMain(electronRuntime, { resources, initialPath: null });
  main.openNotebook = async () => undefined;
  await main.start();
  const record = recordFor(main, hostConnection, window);
  record.windowState = { path: hostConnection.canonicalPath, dirty: false, saveState: "saved", sessionEpoch: "epoch" };
  const closing = (main as any).requestClose(record);
  await started.promise;
  events.get("before-quit")!({ preventDefault: () => undefined });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 0);
  assert.equal(window.destroyed, false);
  finish.resolve();
  await closing;
  const deadline = Date.now() + 2_000;
  while (quits === 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(hostConnection.releaseCount, 1);
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
  const quitDeadline = Date.now() + 2_000;
  while (quits === 0 && Date.now() < quitDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(quits, 1, "Quit did not finish after the second close choice");
  assert.equal(dialogs, 2);
  assert.equal(window.destroyed, true);
  assert.deepEqual(hostConnection.releaseDispositions, ["normal"]);
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
    // A committed Save As warning reports saved bytes but still needs a retry.
    (main as any).readWindowState = async () => ({ path, dirty, saveState: "saved", sessionEpoch: "epoch" });
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
        const closeDeadline = Date.now() + 2_000;
        while (!window.destroyed && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(window.destroyed, true, "saved notebook did not close");
        assert.deepEqual(actions.map(value => (value as { action: string }).action), ["save", "prepare-unload"]);
        assert.equal(hostConnection.releaseCount, 1);
      }
    } finally {
      answer.resolve({ response: 2 });
      await main.stop();
    }
  });
}

test("native Close keeps a warned Save As open on Cancel, then closes after retry", { timeout: 3_000 }, async () => {
  const path = "/tmp/alder-save-as-warning-close.R";
  const hostConnection = connection("save-as-warning-close", path, async endpoint => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  const window = windowWithLoad();
  const actions: string[] = [];
  let dirty = true;
  let dialogs = 0;
  let main: ElectronMain;
  window.webContents.send = (_channel, payload) => {
    const command = payload as { requestId?: string; action: string };
    actions.push(command.action);
    if (command.action === "save") dirty = false;
    if (command.requestId) queueMicrotask(() => ([...(main as any).records][0] as any)?.pendingCommands.get(command.requestId)?.resolve({ requestId: command.requestId, status: "ok" }));
  };
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow = Object.assign(function () { return window; }, { fromWebContents: () => window }) as unknown as ElectronRuntime["BrowserWindow"];
  electronRuntime.dialog.showMessageBox = async () => ({ response: dialogs++ === 0 ? 2 : 0 });
  main = new ElectronMain(electronRuntime, { resources, acquireSession: async () => hostConnection, closeSettlementTimeoutMs: 1_000 });
  (main as any).loadAuthenticatedNotebook = async () => undefined;
  (main as any).readWindowState = async () => ({ path, dirty, saveState: "saved", sessionEpoch: "epoch" });
  try {
    await main.openNotebook(path);
    const record = [...(main as any).records][0];
    await (main as any).requestClose(record);
    assert.equal(window.destroyed, false);
    assert.equal(hostConnection.releaseCount, 0);
    assert.deepEqual(actions, []);
    await (main as any).requestClose(record);
    assert.equal(window.destroyed, true);
    assert.equal(hostConnection.releaseCount, 1);
    assert.deepEqual(actions, ["save", "prepare-unload"]);
    assert.equal(dialogs, 2);
  } finally { await main.stop(); }
});

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

test("same-document windows keep active drafts separate and a new app process can claim one orphan", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-desktop-draft-handoff-")));
  try {
    const windows = [windowWithLoad(), windowWithLoad()];
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const electronRuntime = runtime();
    electronRuntime.app.getPath = () => root;
    electronRuntime.BrowserWindow.fromWebContents = sender => windows.find(window => window.webContents === sender) ?? null;
    electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
    const main = new ElectronMain(electronRuntime, { resources });
    const records = windows.map((window, index) => recordFor(main, connection(`same-document-${index}`, "/tmp/same-document.R", async () => jsonResponse({})), window));
    const notifications: string[] = [];
    const sendFirst = windows[0]!.webContents.send.bind(windows[0]!.webContents);
    windows[0]!.webContents.send = (channel, value) => {
      notifications.push(channel);
      sendFirst(channel, value);
    };
    (main as any).installIpcHandlers();
    const recovery = handlers.get("alderDesktop:recovery")!;
    const event = (window: ElectronWindow) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    const recoveryId = "document-recovery-id";
    for (const [index, window] of windows.entries()) {
      await recovery(event(window), { action: "write", recoveryId, name: "draft:" + records[index].draftId, value: { source: `window ${index}` } });
    }
    assert.deepEqual((await recovery(event(windows[0]!), { action: "list", recoveryId }) as { draftIds: string[] }).draftIds, []);
    await (main as any).disposeRecord(records[1]);
    windows[1]!.destroy();
    assert.ok(notifications.includes("alderDesktop:recoveryChanged"));
    assert.deepEqual((await recovery(event(windows[0]!), { action: "list", recoveryId }) as { draftIds: string[] }).draftIds, [records[1].draftId]);
    await (main as any).disposeRecord(records[0]);
    windows[0]!.destroy();

    const reopened = windowWithLoad();
    const newHandlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const nextRuntime = runtime();
    nextRuntime.app.getPath = () => root;
    nextRuntime.BrowserWindow.fromWebContents = sender => sender === reopened.webContents ? reopened : null;
    nextRuntime.ipcMain.handle = (channel, handler) => { newHandlers.set(channel, handler); };
    const nextMain = new ElectronMain(nextRuntime, { resources });
    const nextRecord = recordFor(nextMain, connection("reopened-document", "/tmp/same-document.R", async () => jsonResponse({})), reopened);
    (nextMain as any).installIpcHandlers();
    const nextRecovery = newHandlers.get("alderDesktop:recovery")!;
    const candidates = (await nextRecovery(event(reopened), { action: "list", recoveryId }) as { draftIds: string[] }).draftIds;
    assert.deepEqual(candidates.sort(), records.map(record => record.draftId).sort());
    await nextRecovery(event(reopened), { action: "claim", recoveryId, name: "draft:" + records[1].draftId });
    assert.equal(nextRecord.draftId, records[1].draftId);
    assert.deepEqual((await nextRecovery(event(reopened), { action: "list", recoveryId }) as { draftIds: string[] }).draftIds, [records[0].draftId]);
    await nextRecovery(event(reopened), { action: "remove", recoveryId, name: "draft:" + records[1].draftId });
    assert.deepEqual((await nextRecovery(event(reopened), { action: "list", recoveryId }) as { draftIds: string[] }).draftIds, [records[0].draftId]);
    assert.deepEqual(await nextRecovery(event(reopened), { action: "read", recoveryId, name: "draft:" + records[0].draftId }), { source: "window 0" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("renderer failures retain their exact stack, cause, and source location", async () => {
  const diagnosticRoot = await mkdtemp(join(tmpdir(), "alder-renderer-diagnostics-"));
  const diagnostics = new StructuredDiagnostics({ rootDir: diagnosticRoot, role: "desktop", flushDelayMs: 0, stderr: null });
  const window = windowWithLoad();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const electronRuntime = runtime();
  electronRuntime.BrowserWindow.fromWebContents = sender => sender === window.webContents ? window : null;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const main = new ElectronMain(electronRuntime, { resources, diagnostics });
  recordFor(main, connection("renderer-failure", "/Users/carl/notebooks/raw.R", async () => jsonResponse({})), window);
  (main as any).installIpcHandlers();
  const report = handlers.get("alderDesktop:diagnostic")!;
  await report({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, {
    event: "renderer.error", category: "script-error",
    error: { name: "Error", message: "renderer exploded", stack: "RAW_RENDERER_STACK\n at /Users/carl/notebooks/raw.R:14:9", cause: { message: "RAW_CAUSE", code: "E_RENDER" } },
    filename: "/Users/carl/notebooks/raw.R", line: 14, column: 9,
  });
  await diagnostics.flush();
  const diagnosticFiles = (await readdir(diagnosticRoot)).filter(name => name.endsWith(".jsonl"));
  const records = (await Promise.all(diagnosticFiles.map(name => readFile(join(diagnosticRoot, name), "utf8"))))
    .join("").trim().split("\n").map(line => JSON.parse(line));
  const failure = records.find(record => record.event === "renderer.error");
  assert.deepEqual(failure.error, { name: "Error", message: "renderer exploded", stack: "RAW_RENDERER_STACK\n at /Users/carl/notebooks/raw.R:14:9", cause: { message: "RAW_CAUSE", code: "E_RENDER" } });
  assert.deepEqual({ filename: failure.filename, line: failure.line, column: failure.column }, { filename: "/Users/carl/notebooks/raw.R", line: 14, column: 9 });
  await main.stop();
  await rm(diagnosticRoot, { recursive: true, force: true });
});

test("a failed renderer load offers a native retry and restores the existing notebook connection", async () => {
  const host = connection("renderer-retry", "/tmp/renderer-retry.R", async endpoint => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "e".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  let loaded = 0;
  let responseHeaders: ((details: { resourceType: string; responseHeaders: Record<string, string[]> }, callback: (decision: { cancel?: boolean }) => void) => void) | undefined;
  let record: any;
  const window = windowWithLoad(async () => {
    loaded += 1;
    if (loaded === 1) throw new Error("page navigation failed");
    assert.ok(responseHeaders);
    responseHeaders({ resourceType: "mainFrame", responseHeaders: { "X-Alder-Continuity-Proof": ["proof"] } }, decision => assert.equal(decision.cancel, undefined));
    queueMicrotask(() => record.rendererReady.resolve());
  });
  window.webContents.session!.webRequest!.onHeadersReceived = (_filter, callback) => { responseHeaders = callback as typeof responseHeaders; };
  const electronRuntime = runtime();
  let offers = 0;
  electronRuntime.dialog.showMessageBox = async (_owner, options) => {
    offers += 1;
    assert.equal(loaded, 1);
    assert.equal(record.authenticatedRendererGeneration, undefined);
    assert.deepEqual(options.buttons, ["Retry Reload", "Close Window"]);
    return { response: 0 };
  };
  const main = new ElectronMain(electronRuntime, { resources });
  record = recordFor(main, host, window);
  const draftId = record.draftId;
  await (main as any).recoverRenderer(record);
  assert.equal(loaded, 2);
  assert.equal(offers, 1);
  assert.equal(record.authenticatedRendererGeneration, record.loadGeneration);
  assert.equal(record.draftId, draftId);
  assert.equal(record.connection, host);
  assert.equal(host.releaseCount, 0);
  assert.equal(window.destroyed, false);
});

test("Close Window after failed renderer reload leaves its draft selectable on reopen", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-renderer-close-reopen-")));
  try {
    const host = connection("renderer-close", "/tmp/renderer-close.R", async () => { throw new Error("ticket unavailable"); });
    const window = windowWithLoad();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const electronRuntime = runtime();
    electronRuntime.app.getPath = () => root;
    electronRuntime.BrowserWindow.fromWebContents = sender => sender === window.webContents ? window : null;
    electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
    electronRuntime.dialog.showMessageBox = async (_owner, options) => {
      assert.deepEqual(options.buttons, ["Retry Reload", "Close Window"]);
      return { response: 1 };
    };
    const main = new ElectronMain(electronRuntime, { resources });
    const record = recordFor(main, host, window);
    (main as any).installIpcHandlers();
    const recoveryId = "renderer-close-recovery";
    const name = "draft:" + record.draftId;
    const value = { source: "local edit before crash" };
    await handlers.get("alderDesktop:recovery")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { action: "write", recoveryId, name, value });
    await (main as any).recoverRenderer(record);
    assert.equal(window.destroyed, true);
    assert.deepEqual(host.releaseDispositions, ["normal"]);

    const reopened = windowWithLoad();
    const nextHandlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const nextRuntime = runtime();
    nextRuntime.app.getPath = () => root;
    nextRuntime.BrowserWindow.fromWebContents = sender => sender === reopened.webContents ? reopened : null;
    nextRuntime.ipcMain.handle = (channel, handler) => { nextHandlers.set(channel, handler); };
    const nextMain = new ElectronMain(nextRuntime, { resources });
    const nextRecord = recordFor(nextMain, connection("renderer-reopened", "/tmp/renderer-close.R", async () => jsonResponse({})), reopened);
    (nextMain as any).installIpcHandlers();
    const event = { sender: reopened.webContents, senderFrame: reopened.webContents.mainFrame };
    const recovery = nextHandlers.get("alderDesktop:recovery")!;
    assert.deepEqual((await recovery(event, { action: "list", recoveryId }) as { draftIds: string[] }).draftIds, [record.draftId]);
    await recovery(event, { action: "claim", recoveryId, name });
    assert.equal(nextRecord.draftId, record.draftId);
    assert.deepEqual(await recovery(event, { action: "read", recoveryId, name }), value);
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
test("desktop host restart stays retryable after acquisition fails, including a monitor race", async () => {
  const path = "/tmp/alder-desktop-restart-retry.R";
  const oldConnection = connection("restart-retry-old", path, async () => jsonResponse({}));
  const replacement = connection("restart-retry-new", path, async endpoint => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "b".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const electronRuntime = runtime();
  const window = windowWithLoad();
  electronRuntime.BrowserWindow.fromWebContents = () => window;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const firstAcquisition = Promise.withResolvers<SessionConnection>();
  const acquisitionStarted = Promise.withResolvers<void>();
  let acquisitions = 0;
  const main = new ElectronMain(electronRuntime, {
    resources, acquireSession: async () => {
      acquisitions += 1;
      acquisitionStarted.resolve();
      return acquisitions === 1 ? firstAcquisition.promise : replacement;
    },
  });
  const record = recordFor(main, oldConnection, window);
  record.loadGeneration = 1;
  record.authenticatedRendererGeneration = 1;
  let errors = 0;
  (main as any).showApplicationError = async () => { errors += 1; };
  (main as any).loadAuthenticatedNotebook = async () => undefined;
  (main as any).querySnapshot = async () => { throw new Error("backend stopped"); };
  (main as any).installIpcHandlers();
  const invoke = () => handlers.get("alderDesktop:restartHost")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  await (main as any).monitorHost(record);
  const first = invoke();
  const concurrent = invoke();
  await acquisitionStarted.promise;
  await (main as any).monitorHost(record);
  assert.equal(acquisitions, 1);
  firstAcquisition.reject(new Error("temporary session acquisition failure"));
  await Promise.all([first, concurrent]);
  assert.equal(errors, 1);
  assert.equal(record.connection, oldConnection);
  assert.equal(window.destroyed, false);
  await invoke();
  assert.equal(acquisitions, 2);
  assert.equal(record.connection, replacement);
  assert.equal(oldConnection.releaseCount, 1);
});
test("desktop replacement abandons a dead old lease when its HTTP release fails", async () => {
  const path = "/tmp/alder-desktop-dead-lease.R";
  const oldConnection = connection("dead-old", path, async () => jsonResponse({}));
  const replacement = connection("dead-new", path, async endpoint => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "c".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  let abandoned = 0;
  oldConnection.release = async () => { throw new Error("backend is gone"); };
  oldConnection.abandon = () => { abandoned += 1; };
  const main = new ElectronMain(runtime(), { resources, acquireSession: async () => replacement });
  const record = recordFor(main, oldConnection, windowWithLoad());
  (main as any).loadAuthenticatedNotebook = async () => undefined;
  await (main as any).restartHost(record);
  assert.equal(record.connection, replacement);
  assert.equal(abandoned, 1);
  assert.equal(replacement.releaseCount, 0);
});
test("failed replacement and rollback loads offer native restart, then a later retry succeeds", async () => {
  const path = "/tmp/alder-desktop-restart-both-loads.R";
  const ticket = async (endpoint: string) => {
    assert.equal(endpoint, "/api/ticket");
    return jsonResponse({ ticket: "d".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  };
  const oldConnection = connection("both-loads-old", path, ticket);
  const failedReplacement = connection("both-loads-failed", path, ticket);
  const workingReplacement = connection("both-loads-working", path, ticket);
  const replacements = [failedReplacement, workingReplacement];
  let acquisitions = 0;
  const electronRuntime = runtime(0);
  let recoveryOffers = 0;
  electronRuntime.dialog.showMessageBox = async () => { recoveryOffers += 1; return { response: 0 }; };
  const main = new ElectronMain(electronRuntime, { resources, acquireSession: async () => {
    acquisitions += 1;
    return replacements.shift()!;
  } });
  let headersCallback: ((details: { resourceType: string; responseHeaders: Record<string, string[]> }, callback: (decision: { cancel?: boolean }) => void) => void) | undefined;
  let record: any;
  let loads = 0;
  const window = windowWithLoad(async () => {
    loads += 1;
    if (loads <= 2) throw new Error("authenticated load failed");
    assert.ok(headersCallback);
    headersCallback({ resourceType: "mainFrame", responseHeaders: { "X-Alder-Continuity-Proof": ["proof"] } }, decision => assert.equal(decision.cancel, undefined));
    queueMicrotask(() => record.rendererReady.resolve());
  });
  window.webContents.session!.webRequest!.onHeadersReceived = (_filter, callback) => { headersCallback = callback as typeof headersCallback; };
  record = recordFor(main, oldConnection, window);
  record.loadGeneration = 1;
  record.authenticatedRendererGeneration = 1;
  const acknowledgeCommand = window.webContents.send.bind(window.webContents);
  let draftFlushes = 0;
  window.webContents.send = (channel, value) => {
    if ((value as { action?: string }).action === "prepare-unload") {
      draftFlushes += 1;
      if (loads > 0) return;
    }
    acknowledgeCommand(channel, value);
  };
  const draftId = record.draftId;
  (main as any).querySnapshot = async () => { throw new Error("backend stopped"); };
  (main as any).showApplicationError = async () => undefined;

  await (main as any).restartHost(record);
  assert.equal(failedReplacement.releaseCount, 1);
  assert.equal(record.connection, oldConnection);
  assert.equal(record.draftId, draftId);
  assert.equal(window.destroyed, false);
  await (main as any).monitorHost(record);
  assert.equal(recoveryOffers, 1);
  assert.equal(acquisitions, 2);
  assert.equal(draftFlushes, 1);
  assert.equal(record.connection, workingReplacement);
  assert.equal(oldConnection.releaseCount, 1);
  await (main as any).monitorHost(record);
  assert.equal(recoveryOffers, 1);
});
test("discarded replacement stops its local lease after failed release", async () => {
  const path = "/tmp/alder-desktop-discarded-replacement.R";
  const oldConnection = connection("discard-old", path, async () => jsonResponse({}));
  const next = connection("discard-next", path, async () => { throw new Error("ticket unavailable"); });
  let abandoned = 0;
  next.release = async () => { throw new Error("discard release unavailable"); };
  next.abandon = () => { abandoned += 1; };
  const main = new ElectronMain(runtime(), { resources, acquireSession: async () => next });
  const record = recordFor(main, oldConnection, windowWithLoad());
  (main as any).showApplicationError = async () => undefined;

  await (main as any).restartHost(record);
  assert.equal(record.connection, oldConnection);
  assert.equal(abandoned, 1);
  assert.equal(oldConnection.releaseCount, 0);
  assert.equal(record.released, false);
});
test("window closed during ticket acquisition abandons a discarded replacement if release fails", async () => {
  const path = "/tmp/alder-desktop-closed-restart.R";
  const oldConnection = connection("closed-old", path, async () => jsonResponse({}));
  let record: any;
  const next = connection("closed-next", path, async () => {
    record.released = true;
    return jsonResponse({ ticket: "e".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" });
  });
  let abandoned = 0;
  next.release = async () => { throw new Error("discard release unavailable"); };
  next.abandon = () => { abandoned += 1; };
  const main = new ElectronMain(runtime(), { resources, acquireSession: async () => next });
  record = recordFor(main, oldConnection, windowWithLoad());
  await (main as any).restartHost(record);
  assert.equal(abandoned, 1);
  assert.equal(record.connection, oldConnection);
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
  record.loadGeneration = 1;
  record.authenticatedRendererGeneration = 1;
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
