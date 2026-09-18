import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PROTOCOL, type SessionConnection } from "../src/protocol.js";
import { authenticatedNotebookUrl, ElectronMain, isLoopbackHttpOrigin, isTrustedApplicationOrigin, type ElectronRuntime, type ElectronWindow } from "../../desktop/src/main.js";

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
    processNonce: "process",
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
    processNonce: "process",
    continuityProof: "proof",
    leaseId: "lease-" + sessionKey,
    clientId: "client-" + sessionKey,
    nextCommandSequence: 1,
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

function windowWithLoad(loadURL: (url: string) => Promise<void> = async () => undefined): ElectronWindow & { destroyed: boolean; focusedCount: number; titles: string[] } {
  let destroyed = false;
  let focusedCount = 0;
  const titles: string[] = [];
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
    executeJavaScript: async () => false,
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
  };
  Object.defineProperty(window, "destroyed", { get: () => destroyed });
  Object.defineProperty(window, "focusedCount", { get: () => focusedCount });
  return Object.assign(window, { titles }) as ElectronWindow & { destroyed: boolean; focusedCount: number; titles: string[] };
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
  };
  window.once("closed", () => { void (main as any).disposeRecord(record); });
  (main as any).records.add(record);
  for (const key of record.keys) (main as any).byKey.set(key, record);
  return record;
}

test("desktop trusts only strict nonce localhost origins", () => {
  const ticket = "a".repeat(64);
  assert.equal(isLoopbackHttpOrigin(browserOrigin), true);
  assert.equal(isTrustedApplicationOrigin(browserOrigin + "/index.html", browserOrigin), true);
  assert.equal(authenticatedNotebookUrl(browserOrigin, ticket).startsWith(browserOrigin + "/index.html#ticket="), true);

  const invalidOrigins = [
    "http://127.0.0.1:43123",
    "http://localhost:43123",
    "http://" + "a".repeat(31) + ".localhost:43123",
    "http://" + "a".repeat(32).toUpperCase() + ".localhost:43123",
    "http://" + "a".repeat(32) + ".localhost.evil:43123",
    "https://" + "a".repeat(32) + ".localhost:43123",
  ];
  for (const invalid of invalidOrigins) {
    assert.equal(isLoopbackHttpOrigin(invalid), false, invalid);
    assert.equal(isTrustedApplicationOrigin(invalid + "/index.html", browserOrigin), false, invalid);
    assert.throws(() => authenticatedNotebookUrl(invalid, ticket), /loopback HTTP origin/);
  }
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
    assert.equal((main as any).byKey.get(newCanonicalPath), record);
    assert.deepEqual(record.keys, new Set([newCanonicalPath]));
    assert.equal(window.titles.at(-1), "after.R — Alder");

    let acquireCount = 0;
    (main as any).options = { resources, acquireSession: async () => { acquireCount += 1; throw new Error("must not acquire"); } };
    await main.openNotebook(newCanonicalPath);
    assert.equal(acquireCount, 0);
    assert.equal(window.focusedCount, 1);
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
  window.webContents.executeJavaScript = async () => false;
  const main = new ElectronMain(runtime(2), { resources });
  const record = recordFor(main, oldConnection, window);

  await (main as any).requestClose(record);

  assert.equal(record.dirty, true);
  assert.equal(record.closing, false);
  assert.equal(window.destroyed, false);
  assert.equal(oldConnection.releaseCount, 0);
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
  window.webContents.executeJavaScript = async () => true;
  const actions: unknown[] = [];
  window.webContents.send = (_channel, payload) => { actions.push(payload); };
  const main = new ElectronMain(runtime(1), { resources });
  const record = recordFor(main, hostConnection, window);

  await (main as any).requestClose(record);

  assert.deepEqual(actions, [{ action: "close" }]);
  assert.equal(releaseDisposition, "discard");
  assert.equal(window.destroyed, true);
  assert.equal(main.windows().length, 0);
});

test("cancelled quit preserves unsaved windows and a later quit can discard them", { timeout: 4_000 }, async () => {
  const hostConnection = connection("cancel-quit", null, async () => { throw new Error("host unavailable"); });
  const window = windowWithLoad();
  window.webContents.executeJavaScript = async () => true;
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
    window.webContents.send = (_channel, payload) => { actions.push(payload); };
    const electronRuntime = runtime();
    electronRuntime.BrowserWindow = Object.assign(function () { return window; }, { fromWebContents: () => window }) as unknown as ElectronRuntime["BrowserWindow"];
    const dialogOpened = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ response: number }>();
    let dialogs = 0;
    electronRuntime.dialog.showMessageBox = async () => { dialogs += 1; dialogOpened.resolve(); return answer.promise; };
    const main = new ElectronMain(electronRuntime, { resources, acquireSession: async () => hostConnection, closeSettlementTimeoutMs: 1_000 });
    (main as any).loadAuthenticatedNotebook = async () => undefined;
    let dirty = true;
    (main as any).readWindowState = async () => ({ path, dirty, platform: "darwin", sessionEpoch: "epoch" });
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
        assert.deepEqual(actions, [{ action: "save" }]);
        window.close();
        assert.equal(window.destroyed, false, "the window must remain open until saving finishes");
        dirty = false;
        while (!window.destroyed) await new Promise(resolve => setTimeout(resolve, 10));
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
    const keyId = "a".repeat(43);
    const name = "draft:client-one";
    const value = { source: "# %%\nx <- 42\n" };
    await recovery(event, { action: "write", keyId, name, value });
    assert.deepEqual(await recovery(event, { action: "read", keyId, name }), value);
    assert.deepEqual(await recovery(event, { action: "list", keyId, prefix: "draft:" }), [{ name, value }]);
    await assert.rejects(recovery({ ...event, senderFrame: { url: browserOrigin + "/" } }, { action: "read", keyId, name }), /main frame/);
    await assert.rejects(recovery({ sender: windowWithLoad().webContents }, { action: "read", keyId, name }), /active application window/);
    await assert.rejects(recovery(event, { action: "read", keyId: "b".repeat(43), name }), /identity changed/);
    await recovery(event, { action: "remove", keyId, name });
    assert.equal(await recovery(event, { action: "read", keyId, name }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
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
  (main as any).readWindowState = async () => ({ path: null, dirty: true, platform: process.platform, sessionEpoch: "epoch" });
  let applicationErrors = 0;
  (main as any).showApplicationError = async () => { applicationErrors += 1; };
  window.webContents.send = (_channel, payload) => {
    if ((payload as { action?: string }).action === "save") void handlers.get("alderDesktop:saveCancelled")?.({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
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
test("desktop host shutdown IPC retires its process tree and window", async () => {
  const notebookPath = "/tmp/alder-desktop-host-shutdown.R";
  const hostConnection = connection("session-shutdown", notebookPath, async () => {
    throw new Error("the stopped host cannot answer release requests");
  });
  const window = windowWithLoad();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const electronRuntime = runtime();
  let quitCount = 0;
  electronRuntime.app.quit = () => { quitCount += 1; };
  electronRuntime.BrowserWindow.fromWebContents = () => window;
  electronRuntime.ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); };
  const main = new ElectronMain(electronRuntime, { resources });
  const record = recordFor(main, hostConnection, window);
  (main as any).installIpcHandlers();

  const shutdown = handlers.get("alderDesktop:hostShutdown");
  assert.ok(shutdown);
  await shutdown({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(record.released, true);
  assert.equal(hostConnection.releaseCount, 1);
  assert.equal(main.windows().length, 0);
  assert.equal(window.destroyed, true);
  assert.equal(quitCount, 1);
});
test("opening a notebook replaces a clean untitled launch window", async () => {
  const openedPath = join(tmpdir(), "opened.R");
  const untitledConnection = connection("untitled", null, async () => { throw new Error("unexpected request"); });
  const window = windowWithLoad();
  const main = new ElectronMain(runtime(), { resources });
  const record = recordFor(main, untitledConnection, window);
  let opened: string | null = null;
  (main as any).openNotebook = async (path: string) => { opened = path; };
  (main as any).readWindowState = async () => ({ path: null, dirty: false, platform: process.platform, sessionEpoch: "epoch" });
  await (main as any).openReplacingPristineUntitled(record, openedPath);

  assert.equal(opened, openedPath);
  assert.equal(untitledConnection.releaseCount, 1);
  assert.deepEqual(untitledConnection.releaseDispositions, ["normal"]);
  assert.equal(record.released, true);
  assert.equal(window.destroyed, true);
  assert.equal(main.windows().length, 0);
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
