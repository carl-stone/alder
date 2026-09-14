import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  processSupervisorExecutable: "/tmp/alder-supervisor",
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
): SessionConnection & { releaseCount: number } {
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
    release: async () => { value.releaseCount += 1; },
  };
  return value as SessionConnection & { releaseCount: number };
}

function windowWithLoad(loadURL: (url: string) => Promise<void> = async () => undefined): ElectronWindow & { destroyed: boolean; focusedCount: number; titles: string[] } {
  let destroyed = false;
  let focusedCount = 0;
  const titles: string[] = [];
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
    on: () => window,
    once: () => window,
    isDestroyed: () => destroyed,
    focus: () => { focusedCount += 1; },
    show: () => undefined,
    close: () => undefined,
    destroy: () => { destroyed = true; },
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
      showSaveDialog: async () => ({ canceled: true, filePaths: [] }),
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

test("desktop close remains open when the authoritative dirty-state query fails", async () => {
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
});

test("desktop restart releases replacement and closes when replacement and rollback loads fail", async () => {
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
  assert.equal(oldConnection.releaseCount, 1);
  assert.equal(record.released, true);
  assert.equal(main.windows().length, 0);
  assert.equal(window.destroyed, true);
});
