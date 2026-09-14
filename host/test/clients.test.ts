import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { BrowserNotebookClient } from "../src/browser/client.js";
import { BrowserDocument } from "../src/browser/document.js";
import { NotebookView } from "../src/browser/view.js";
import { parseHTML } from "linkedom";
import { BrowserTransport, BrowserTransportError, IndexedDBRecoveryStore, MemoryRecoveryStore, type BrowserRecoveryDraft, type WebSocketLike } from "../src/browser/transport.js";

import { encodeFilePathUri, fileUri, LspClient, translateLspResult, trustedRLanguageServerEnvironment, validatedRLanguageServerOptions, type DiagnosticsByCell } from "../src/lsp.js";
import { fromFilePosition, layoutNotebook, toFilePosition, type NotebookDocument } from "../src/notebook.js";
import { encodeRecoveryWire, HOST_PROTOCOL, HOST_CLIENT_PROTOCOL_VERSION, type CommandResult, type HostCellState, type HostCommand, type HostEvent, type HostSnapshot, type OperationRecord, type Recovery } from "../src/protocol.js";
import { ARTIFACT_DESCRIPTOR_HEADER, ARTIFACT_RESOLUTION_MEDIA_TYPE, encodeArtifactDescriptor, type ArtifactHandle } from "../src/protocol.js";
import { blocksNotebookNavigation } from "../src/browser/url.js";
import type { OwnedProcess, ProcessScope } from "../src/processes.js";

function cell(id: string, body: string[] = [], revision = 0): HostCellState {
  return {
    id, body, revision, type: "code", options: {}, status: "idle", outputs: [],
    progress: null, log: [], error: null, defs: [], refs: [], selfRefs: [],
    locals: [], barrier: false, opaque: false, diagnostics: [], analysisPending: false,
  };
}

function snapshot(cells: HostCellState[] = [cell("c1", ["x <- 1"]), cell("c2", ["x + 1"])]): HostSnapshot {
  const disk = { state: "untitled" as const, digest: null, version: null, error: null };
  return {
    protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 0, version: 1, documentRevision: 0, path: "/tmp/book.R",
    metadata: {}, config: {}, layout: null, dirty: false, changed: false, disk,
    sidecars: { config: disk, layout: disk, packages: disk },
    runtime: {
      documentReady: true, analyzerState: "ready", kernelState: "ready", executionReady: true,
      executionBlockedReason: null, startupActivated: false, kernelEpoch: "kernel-1", rEnvironment: null, analysisEnvironmentId: "analysis-1",
      executionMode: "automatic", runOnStartup: false, packageOperationActive: false,
      busy: false, activeRunId: null,
    },
    cells,
    graph: {
      nodes: cells.map((value) => value.id),
      edges: Object.fromEntries(cells.map((value) => [value.id, []])),
      reverseEdges: Object.fromEntries(cells.map((value) => [value.id, []])),
      duplicates: {}, cycles: [], topologicalOrder: cells.map((value) => value.id),
    },
    variables: [], editorDiagnostics: {}, serviceErrors: {},
    operations: [], lastValue: null, lastActionError: null,
  };
}

async function withViewDom<T>(callback: (dom: Document, domWindow: Window) => T | PromiseLike<T>): Promise<T> {
  const { window: domWindow, document: dom } = parseHTML('<!doctype html><html><body><div id="topbar"></div><div id="notebook"></div><div id="status" role="status"></div><div id="path"></div><button id="run-all">Run all</button><button id="stop">Stop</button><button id="save">Save</button></body></html>');
  Object.defineProperty(domWindow, "requestAnimationFrame", { configurable: true, value: () => 0 });
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    customEvent: Object.getOwnPropertyDescriptor(globalThis, "CustomEvent"),
  };
  const location = { search: "?view=app", href: "http://notebook.test/book.R?view=app", origin: "http://notebook.test" };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom });
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: location });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, writable: true, value: domWindow.CustomEvent });
  try {
    return await callback(dom, domWindow);
  } finally {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function operation(id: string, status: OperationRecord["status"] = "done", result?: unknown): OperationRecord {
  return { id, clientId: "test-client", commandSequence: 1, kind: "save", status, documentRevision: 0, runId: null, result: result === undefined ? null : result as never, error: null, acceptedAt: 1, ...(status === "done" ? { settledAt: 2 } : {}) };
}

function artifactDescriptor(overrides: Partial<ArtifactHandle> = {}): ArtifactHandle {
  return {
    handle: "artifact-1.html",
    mimeType: "text/html",
    byteLength: 1,
    chunkBytes: 262_144,
    epoch: "epoch-1",
    documentRevision: 0,
    kernelEpoch: "kernel-1",
    ...overrides,
  };
}

function artifactResolutionResponse(
  descriptor: ArtifactHandle,
  url: string,
  expiresAt: number,
  options: { body?: string; status?: number; contentType?: string } = {},
): Response {
  const headers = new Headers({ "Content-Type": options.contentType ?? ARTIFACT_RESOLUTION_MEDIA_TYPE });
  return new Response(options.body ?? JSON.stringify({ artifact: descriptor, url, expiresAt }), { status: options.status ?? 200, headers });
}

type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withBrowserFetch<T>(fetchImpl: BrowserFetch, callback: () => Promise<T>): Promise<T> {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetchImpl });
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { href: "http://notebook.test/book.R?notebook=private-id", origin: "http://notebook.test" } });
  try {
    return await callback();
  } finally {
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
}
type FakeRequestHandler = () => void;

class FakeRequest {
  result: unknown;
  error: Error | null = null;
  onsuccess: FakeRequestHandler | null = null;
  onerror: FakeRequestHandler | null = null;
  constructor(result: unknown = undefined) { this.result = result; }
}

interface FakeDatabaseState { version: number; records: Map<string, unknown>; hasStore: boolean; }

class FakeTransaction {
  oncomplete: FakeRequestHandler | null = null;
  onabort: FakeRequestHandler | null = null;
  onerror: FakeRequestHandler | null = null;
  error: Error | null = null;
  private pending = 0;
  constructor(private readonly records: Map<string, unknown>) {}
  objectStore(_name: string): FakeObjectStore { return new FakeObjectStore(this, this.records); }
  enqueue(run: () => void): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      try { run(); request.onsuccess?.(); }
      catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); request.error = this.error; request.onerror?.(); this.onerror?.(); }
      this.pending -= 1;
      if (this.pending === 0) queueMicrotask(() => this.oncomplete?.());
    });
    return request;
  }
}

class FakeObjectStore {
  constructor(private readonly transaction: FakeTransaction, private readonly records: Map<string, unknown>) {}
  get(key: IDBValidKey): FakeRequest {
    const request = new FakeRequest();
    this.transaction.enqueue(() => { request.result = this.records.get(String(key)); request.onsuccess?.(); });
    return request;
  }
  put(value: unknown, key: IDBValidKey): FakeRequest { return this.transaction.enqueue(() => { this.records.set(String(key), value); }); }
  delete(key: IDBValidKey): FakeRequest { return this.transaction.enqueue(() => { this.records.delete(String(key)); }); }
  clear(): FakeRequest { return this.transaction.enqueue(() => { this.records.clear(); }); }
  getAllKeys(): FakeRequest {
    const request = new FakeRequest();
    this.transaction.enqueue(() => { request.result = [...this.records.keys()]; request.onsuccess?.(); });
    return request;
  }
  getAll(): FakeRequest {
    const request = new FakeRequest();
    this.transaction.enqueue(() => { request.result = [...this.records.values()]; request.onsuccess?.(); });
    return request;
  }
}

class FakeDatabase {
  readonly objectStoreNames = { contains: (name: string): boolean => this.state.hasStore && name === "state" };
  constructor(private readonly state: FakeDatabaseState) {}
  createObjectStore(_name: string): FakeObjectStore { this.state.hasStore = true; return new FakeObjectStore(new FakeTransaction(this.state.records), this.state.records); }
  transaction(_name: string, _mode: IDBTransactionMode): FakeTransaction { return new FakeTransaction(this.state.records); }
  close(): void {}
}

class FakeOpenRequest {
  result!: FakeDatabase;
  transaction: FakeTransaction | null = null;
  onsuccess: FakeRequestHandler | null = null;
  onerror: FakeRequestHandler | null = null;
  onblocked: FakeRequestHandler | null = null;
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null = null;
}

class FakeIndexedDB {
  readonly databases = new Map<string, FakeDatabaseState>();
  open(name: string, version: number): IDBOpenDBRequest {
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      const state = this.databases.get(name) ?? { version: 0, records: new Map<string, unknown>(), hasStore: false };
      this.databases.set(name, state);
      const oldVersion = state.version;
      request.result = new FakeDatabase(state);
      if (oldVersion < version) {
        state.version = version;
        request.transaction = new FakeTransaction(state.records);
        request.onupgradeneeded?.({ oldVersion });
      }
      queueMicrotask(() => request.onsuccess?.());
    });
    return request as unknown as IDBOpenDBRequest;
  }
}
test("browser navigation blocks same-host cross-origin destinations", () => {
  const current = "http://127.0.0.1:4100/notebook";
  assert.equal(blocksNotebookNavigation("http://127.0.0.1:4200/capture", current), true);
  assert.equal(blocksNotebookNavigation("https://127.0.0.1:4100/capture", current), true);
  assert.equal(blocksNotebookNavigation("/same-origin", current), false);
  assert.equal(blocksNotebookNavigation("https://example.com/docs", current), false);
  assert.equal(blocksNotebookNavigation("http://[", current), true);
});

test("IndexedDB recovery drafts stay encrypted and survive store instances", async () => {
  assert.ok(globalThis.crypto?.subtle, "Web Crypto is required for encrypted recovery storage");
  const indexedDB = new FakeIndexedDB();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: indexedDB });
  const key = Buffer.alloc(32, 0x31).toString("base64url");
  const keyId = Buffer.alloc(32, 0x32).toString("base64url");
  const notebookKey = "http://0123456789abcdef0123456789abcdef.localhost:4312/book";
  const draft: BrowserRecoveryDraft = {
    schemaVersion: 1, clientId: "client-1",
    base: { epoch: "epoch-1", cursor: 4, version: 1, documentRevision: 2, cells: [{ id: "c1", revision: 2, type: "code", body: ["secret source"] }] },
    changes: [], operation: null,
  };
  try {
    const first = new IndexedDBRecoveryStore(notebookKey, key, keyId);
    await first.saveDraft(draft);
    await first.save("epoch-1", 4);
    const database = indexedDB.databases.get("alder-browser-recovery");
    assert.ok(database);
    const draftRecord = database.records.get(notebookKey + ":draft:client-1");
    assert.equal(typeof draftRecord, "object");
    assert.equal((draftRecord as { algorithm: string }).algorithm, "AES-256-GCM");
    assert.equal((draftRecord as { keyId: string }).keyId, keyId);
    assert.doesNotMatch(JSON.stringify(draftRecord), /secret source/);

    const reload = new IndexedDBRecoveryStore(notebookKey, key, keyId);
    assert.deepEqual(await reload.loadDraft("client-1"), draft);
    assert.deepEqual(await reload.load(), { epoch: "epoch-1", cursor: 4 });

    const wrongKey = new IndexedDBRecoveryStore(notebookKey, Buffer.alloc(32, 0x33).toString("base64url"), keyId);
    assert.equal(await wrongKey.loadDraft("client-1"), null);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(database.records.has(notebookKey + ":draft:client-1"), false);

    database.records.set(notebookKey + ":draft:client-1", draft);
    const malformed = new IndexedDBRecoveryStore(notebookKey, key, keyId);
    assert.equal(await malformed.loadDraft("client-1"), null);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(database.records.has(notebookKey + ":draft:client-1"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
function artifactClient(): BrowserNotebookClient {
  return new BrowserNotebookClient({
    clientId: "browser-artifact-test",
    leaseId: "lease-artifact-test",
    csrf: "csrf-artifact-test",
    reconnect: false,
    requestAnimationFrame: () => 0,
  });
}

test("browser artifact resolution negotiates capabilities and renews expired cache entries", async () => {
  const descriptor = artifactDescriptor();
  const path1 = "/artifacts/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/artifact-1.html";
  const path2 = "/artifacts/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/artifact-1.html";
  const path3 = "/artifacts/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC/artifact-1.html";
  let requests = 0;
  let now = 10_000;
  const responses = [
    artifactResolutionResponse(descriptor, path1, now + 100),
    artifactResolutionResponse(descriptor, path2, now + 500),
    artifactResolutionResponse(descriptor, path3, now + 1_000),
  ];
  const fetchImpl: BrowserFetch = async () => {
    requests += 1;
    const response = responses.shift();
    assert.ok(response, "unexpected artifact resolution request");
    return response;
  };
  const dateNow = Object.getOwnPropertyDescriptor(Date, "now");
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => now });
  const client = artifactClient();
  try {
    await withBrowserFetch(fetchImpl, async () => {
      assert.equal(await client.resolveArtifact(descriptor), path1);
      assert.equal(requests, 1);

      assert.equal(await client.resolveArtifact(descriptor), path1);
      assert.equal(requests, 1);
      now += 100;
      assert.equal(await client.resolveArtifact(descriptor), path2);
      assert.equal(requests, 2);
      assert.equal(await client.resolveArtifact(descriptor), path2);
      assert.equal(requests, 2);
      client.close();
      assert.equal(await client.resolveArtifact(descriptor), path3);
      assert.equal(requests, 3);
    });
  } finally {
    client.close();
    if (dateNow) Object.defineProperty(Date, "now", dateNow);
    else Reflect.deleteProperty(Date, "now");
  }
});

test("browser artifact resolution rejects malformed, stale, wrongly typed, and expired capabilities", async () => {
  const descriptor = artifactDescriptor();
  const staleDescriptor = artifactDescriptor({ documentRevision: 1 });
  const path = "/artifacts/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/artifact-1.html";
  const expiresAt = Date.now() + 10_000;
  const duplicateBody = "{\"artifact\":" + JSON.stringify(descriptor) + ",\"artifact\":" + JSON.stringify(descriptor) + ",\"url\":" + JSON.stringify(path) + ",\"expiresAt\":" + expiresAt + "}";
  const responses = [
    artifactResolutionResponse(descriptor, path, expiresAt, { body: duplicateBody }),
    artifactResolutionResponse(descriptor, path, expiresAt, { body: JSON.stringify({ artifact: staleDescriptor, url: path, expiresAt }) }),
    artifactResolutionResponse(descriptor, path, expiresAt, { contentType: "application/json" }),
    artifactResolutionResponse(descriptor, path, 1),
  ];
  let calls = 0;
  const fetchImpl: BrowserFetch = async () => {
    calls += 1;
    const response = responses.shift();
    assert.ok(response, "unexpected artifact resolution request");
    return response;
  };
  const client = artifactClient();
  const code = (expected: string) => (error: unknown) => error instanceof BrowserTransportError && error.code === expected;
  try {
    await withBrowserFetch(fetchImpl, async () => {
      await assert.rejects(client.resolveArtifact({ ...descriptor, documentRevision: -1 } as unknown as ArtifactHandle), code("output_invalid"));
      assert.equal(calls, 0);
      await assert.rejects(client.resolveArtifact(descriptor), code("output_invalid"));
      await assert.rejects(client.resolveArtifact(descriptor), code("stale_value"));
      await assert.rejects(client.resolveArtifact(descriptor), code("output_invalid"));
      await assert.rejects(client.resolveArtifact(descriptor), code("output_expired"));
      assert.equal(calls, 4);
    });
  } finally {
    client.close();
  }
});

test("browser document builds one canonical transaction for edits and optimistic creations", () => {
  const document = new BrowserDocument(snapshot());
  const first = document.cell("c1")!;
  document.focus(first.key);
  document.updateSelection(first.key, { anchor: 3, head: 3, scrollTop: 12 });
  document.edit(first.key, ["x <- 40"]);
  const createdA = document.create("create-a", first.key, "code", ["y <- x + 1"]);
  const createdB = document.create("create-b", createdA.key, "code", ["y + 1"]);
  const command = document.buildRunCommand({ operationId: "run-1", clientId: "browser-1", scope: "cell", targetKey: createdB.key });
  assert.deepEqual(command.target, { creationId: "create-b" });
  assert.deepEqual(command.changes, [
    { type: "edit", cell: { cellId: "c1" }, body: ["x <- 40"], cellType: "code", expectedRevision: 0 },
    { type: "create", creationId: "create-a", after: { cellId: "c1" }, body: ["y <- x + 1"], cellType: "code", options: {} },
    { type: "create", creationId: "create-b", after: { creationId: "create-a" }, body: ["y + 1"], cellType: "code", options: {} },
  ]);
  document.noteSubmitted(command.operationId, { ...command, commandSequence: 1 } as HostCommand);
  const identity = createdB;
  document.acknowledge(resultFor("run-1", {
    edited: [{ id: "c1", revision: 1 }], created: { "create-a": "c3", "create-b": "c4" }, deleted: [], documentRevision: 1,
  }, "done", 1));
  assert.strictEqual(document.cell("c4"), identity);
  assert.equal(document.focusedKey, first.key);
  assert.deepEqual(first.selection, { anchor: 3, head: 3, scrollTop: 12 });
  assert.deepEqual(document.cells.map((value) => value.id), ["c1", "c3", "c4", "c2"]);
  assert.deepEqual(document.pendingSource().changes, []);
});

test("browser document never resubmits a rejected structural intent", () => {
  const document = new BrowserDocument(snapshot());
  const deletion = { type: "delete" as const, cell: { cellId: "c2" }, expectedRevision: 0 };
  document.stageRecoveryIntent([deletion]);
  document.noteSubmitted("delete-1", {
    type: "transaction", operationId: "delete-1", clientId: "browser-1", sessionEpoch: document.epoch,
    commandSequence: 1, expectedDocumentRevision: 0, changes: [deletion],
  });
  document.reject("delete-1", "source_conflict");
  document.edit("c1", ["x <- 2"]);
  assert.deepEqual(document.pendingSource().changes, [
    { type: "edit", cell: { cellId: "c1" }, body: ["x <- 2"], cellType: "code", expectedRevision: 0 },
  ]);
});

test("browser document tracks authoritative active client changes", () => {
  const initial = snapshot();
  initial.activeClientIds = ["browser-1", "peer-1"];
  const document = new BrowserDocument(initial);
  const event = (cursor: number, payload: unknown): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, documentRevision: 0, timestamp: cursor,
    type: "active_clients_changed", payload: payload as never,
  });
  document.applyEvent(event(1, { activeClientIds: ["browser-1", "peer-2"] }));
  assert.deepEqual(document.snapshot.activeClientIds, ["browser-1", "peer-2"]);
  document.applyEvent(event(2, { activeClientIds: ["browser-1", "browser-1"] }));
  assert.deepEqual(document.snapshot.activeClientIds, ["browser-1", "peer-2"]);
  document.applyEvent(event(3, { activeClientIds: ["browser-1", 7] }));
  assert.deepEqual(document.snapshot.activeClientIds, ["browser-1", "peer-2"]);
});

test("browser document keeps a blocked runtime visible across source and save events", () => {
  const initial = snapshot();
  const reason = { code: "worker_unavailable", message: "R engine is unavailable", details: { retryable: true } };
  initial.runtime = { ...initial.runtime, executionReady: false, kernelState: "failed", executionBlockedReason: reason };
  const document = new BrowserDocument(initial);
  const event = (cursor: number, type: HostEvent["type"], payload: unknown, documentRevision: number): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, documentRevision, timestamp: cursor, type, payload: payload as never,
  });
  document.applyEvent(event(1, "transaction", { updated: [{ id: "c1", revision: 1 }] }, 1));
  assert.deepEqual(document.snapshot.runtime.executionBlockedReason, reason);
  document.applyEvent(event(2, "notebook", { saved: true }, 1));
  assert.deepEqual(document.snapshot.runtime.executionBlockedReason, reason);
  document.applyEvent(event(3, "runtime", { ...initial.runtime, executionReady: true, kernelState: "ready", executionBlockedReason: null }, 1));
  assert.equal(document.snapshot.runtime.executionBlockedReason, null);
});

test("browser view surfaces a blocked runtime and keeps recovery guidance through edits and saves", async () => {
  await withViewDom(async (dom, domWindow) => {
    const initial = snapshot([]);
    const reason = { code: "worker_unavailable", message: "R engine is unavailable", details: { retryable: true } };
    initial.runtime = { ...initial.runtime, executionReady: false, kernelState: "failed", executionBlockedReason: reason };
    const document = new BrowserDocument(initial);
    let restartCalls = 0;
    const client = {
      recoveryState: { status: "none", local: null, branches: [], keptBranches: [], foreignDrafts: 0, pending: false, corruption: null, persistenceError: null },
      subscribeRecovery(listener: () => void) { listener(); return () => {}; },
      restart: async () => { restartCalls += 1; },
    } as unknown as BrowserNotebookClient;
    let view: NotebookView | null = null;
    try {
      view = new NotebookView(client, dom);
      view.render(document);
      const status = dom.getElementById("status")!;
      assert.match(status.textContent ?? "", /R execution is blocked: R engine is unavailable/);
      assert.match(status.textContent ?? "", /Your edits and saves are preserved/);
      const restart = status.querySelector<HTMLButtonElement>("[data-status-action=restart-runtime]");
      assert.ok(restart);
      restart.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      assert.equal(restartCalls, 1);

      const transaction: HostEvent = {
        protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1,
        type: "transaction", payload: { updated: [{ id: "c1", revision: 1 }] },
      };
      document.applyEvent(transaction);
      view.render(document, transaction);
      assert.match(status.textContent ?? "", /R execution is blocked: R engine is unavailable/);
      const saved: HostEvent = { ...transaction, cursor: 2, version: 3, type: "notebook", payload: { saved: true } };
      document.applyEvent(saved);
      view.render(document, saved);
      assert.match(status.textContent ?? "", /Your edits and saves are preserved/);

      const recovered: HostEvent = {
        ...saved, cursor: 3, version: 4, type: "runtime",
        payload: { ...initial.runtime, executionReady: true, kernelState: "ready", executionBlockedReason: null },
      };
      document.applyEvent(recovered);
      view.render(document, recovered);
      assert.equal(status.querySelector("[data-runtime-recovery]"), null);
      assert.doesNotMatch(status.textContent ?? "", /R execution is blocked/);
    } finally {
      view?.destroy();
    }
  });
});

test('browser view targets nonstructural transaction updates despite repeated config', async () => {
  await withViewDom(async (dom) => {
    const initial = snapshot([cell('c1', ['x <- 1']), cell('c2', ['x + 1'])]);
    const document = new BrowserDocument(initial);
    const client = {
      recoveryState: { status: 'none', local: null, branches: [], keptBranches: [], foreignDrafts: 0, pending: false, corruption: null, persistenceError: null },
      subscribeRecovery() { return () => {}; },
    } as unknown as BrowserNotebookClient;
    const view = new NotebookView(client, dom);
    try {
      view.render(document);
      const rendered: string[] = [];
      const instrumented = view as unknown as { renderCell: (...args: unknown[]) => void };
      const renderCell = instrumented.renderCell.bind(view);
      instrumented.renderCell = (...args) => {
        rendered.push((args[0] as { id: string }).id);
        renderCell(...args);
      };
      const transaction: HostEvent = {
        protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1,
        type: 'transaction',
        payload: { updated: [{ id: 'c1' }], created: {}, deleted: [], order: ['c1', 'c2'], config: initial.config },
      };
      document.applyEvent(transaction);
      view.render(document, transaction);
      assert.deepEqual(rendered, ['c1']);

      rendered.length = 0;
      const moved: HostEvent = {
        ...transaction, cursor: 2, version: 3, documentRevision: 2,
        payload: { updated: [{ id: 'c2' }], created: {}, deleted: [], order: ['c2', 'c1'], config: initial.config },
      };
      document.applyEvent(moved);
      view.render(document, moved);
      assert.deepEqual(rendered, ['c2']);
      const renderedOrder = [...dom.querySelectorAll<HTMLElement>('#notebook > .cell')].map((element) => element.dataset.key);
      assert.deepEqual(renderedOrder, document.cells.map((value) => value.key));
    } finally {
      view.destroy();
    }
  });
});

test("browser view reports typed check issues", async () => {
  await withViewDom(async (dom, domWindow) => {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { search: "?view=editor", href: "http://notebook.test/book.R?view=editor", origin: "http://notebook.test" } });
    const document = new BrowserDocument(snapshot([]));
    let checkCalls = 0;
    const client = {
      recoveryState: { status: "none", local: null, branches: [], keptBranches: [], foreignDrafts: 0, pending: false, corruption: null, persistenceError: null },
      subscribeRecovery() { return () => {}; },
      commitEdits: async () => {},
      service: async (command: string) => {
        checkCalls += 1;
        assert.equal(command, "check");
        return { epoch: document.epoch, documentRevision: 0, cursor: 0, result: { issues: [{ code: "cycle", message: "cycle" }], executionBlockedReason: null } };
      },
    } as unknown as BrowserNotebookClient;
    const view = new NotebookView(client, dom);
    try {
      view.render(document);
      const actions = [...dom.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Actions");
      assert.ok(actions);
      actions.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
      const button = [...dom.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Check notebook");
      assert.ok(button);
      button.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
      const status = dom.getElementById("status");
      assert.ok(status);
      await waitUntil(() => checkCalls === 1 && status.classList.contains("error"));
      assert.equal(checkCalls, 1);
      assert.equal(status.getAttribute("role"), "status");
      assert.equal(status.classList.contains("error"), true);
      assert.ok(status.querySelector(".status-message"));
    } finally {
      view.destroy();
    }
  });
});

test("explicit runs flush output and keep stop independent while preparing", async () => {
  await withViewDom(async (dom, domWindow) => {
    const initial = snapshot([]);
    initial.changed = true;
    const document = new BrowserDocument(initial);
    const order: string[] = [];
    let interruptCalls = 0;
    let releaseRun!: () => void;
    const runPending = new Promise<void>((resolve) => { releaseRun = resolve; });
    const client = {
      recoveryState: { status: "none", local: null, branches: [], keptBranches: [], foreignDrafts: 0, pending: false, corruption: null, persistenceError: null },
      subscribeRecovery() { return () => {}; },
      runAll: async () => { order.push("run"); await runPending; },
      interrupt: async () => { interruptCalls += 1; },
    } as unknown as BrowserNotebookClient;
    let view: NotebookView | null = null;
    let pending: Promise<unknown> | null = null;
    try {
      view = new NotebookView(client, dom);
      view.render(document);
      const output = (view as unknown as { output: { flush: () => Promise<void> } }).output;
      output.flush = async () => { order.push("flush"); };
      pending = view.runExplicit(() => client.runAll("all"));
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(order, ["flush", "run"]);
      assert.equal(dom.getElementById("run-all")?.disabled, true);
      assert.equal(dom.getElementById("save")?.disabled, true);
      assert.equal(dom.getElementById("stop")?.disabled, false);
      dom.getElementById("stop")!.dispatchEvent(new domWindow.Event("click"));
      await Promise.resolve();
      assert.equal(interruptCalls, 1);
      releaseRun();
      await pending;
      assert.equal(dom.getElementById("stop")?.disabled, true);
      assert.equal(dom.getElementById("save")?.disabled, false);
    } finally {
      releaseRun?.();
      await pending?.catch(() => undefined);
      view?.destroy();
    }
  });
});

test("browser document applies canonical output deltas without replacing cell identity", () => {
  const previous = { ...cell("c1", ["message('a')"]), outputsStale: true };
  const document = new BrowserDocument(snapshot([previous]));
  const local = document.cell("c1")!;
  const event = (cursor: number, sequence: number, payload: unknown): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, documentRevision: cursor, timestamp: cursor,
    type: "cell-output", operationId: "run", runId: "r1", cellId: "c1", revision: 0, sequence, payload: payload as never,
  });
  const output = { id: "o1", sessionEpoch: document.epoch, kernelEpoch: "kernel-1", runId: "r1", cellId: "c1", revision: 0, sequence: 1, data: { kind: "text", text: "1" }, metadata: { presentation: "inline" }, truncated: false };
  document.applyEvent(event(1, 1, { kind: "append", payload: { output } }));
  document.applyEvent(event(1, 1, { kind: "append", payload: { output: { ...output, id: "duplicate" } } }));
  assert.strictEqual(document.cell("c1"), local);
  assert.deepEqual(local.server?.outputs, [output]);
  assert.equal(local.server?.outputsStale, false);
  document.applyEvent(event(2, 2, { kind: "clear", payload: {} }));
  assert.deepEqual(local.server?.outputs, []);
  assert.equal(local.server?.progress, null);
});

test("browser document keeps Markdown logical in the editor and canonical on the wire", () => {
  const physicalBody = ["# # Heading", "#   indented", "", "#     ## Nested"];
  const markdownCell = { ...cell("m1", physicalBody, 7), type: "markdown" as const };
  const document = new BrowserDocument(snapshot([markdownCell]));
  const local = document.cell("m1")!;
  const logicalBody = ["# Heading", "  indented", "", "    ## Nested"];
  assert.deepEqual(local.desiredBody, logicalBody);
  assert.deepEqual(local.serverBody, logicalBody);
  assert.deepEqual(local.server?.body, physicalBody);

  const editedBody = ["## Updated", "  indented", "", "    ### Nested"];
  document.edit(local.key, editedBody);
  document.create("draft-md", local.key, "markdown", ["# Created", "  body", ""]);
  assert.deepEqual(document.pendingSource().changes, [
    { type: "edit", cell: { cellId: "m1" }, body: ["# ## Updated", "#   indented", "", "#     ### Nested"], cellType: "markdown", expectedRevision: 7 },
    { type: "create", creationId: "draft-md", after: { cellId: "m1" }, body: ["# # Created", "#   body", ""], cellType: "markdown", options: {} },
  ]);

  const command = document.buildTransactionCommand("markdown-edit", "browser-1")!;
  document.noteSubmitted(command.operationId, { ...command, commandSequence: 1 } as HostCommand);
  const editedPhysical = ["# ## Updated", "#   indented", "", "#     ### Nested"];
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1,
    type: "cell", operationId: command.operationId, cellId: "m1", revision: 8, payload: { ...markdownCell, body: editedPhysical, revision: 8 },
  } as never);
  assert.deepEqual(local.desiredBody, editedBody);
  assert.deepEqual(local.serverBody, editedBody);
  assert.equal(local.conflict, false);
  assert.deepEqual(local.server?.body, editedPhysical);
});


test("browser Markdown edits preserve untouched physical prefixes", () => {
  const physicalBody = ["#hello", "# hello", "  # note", "", "# old"];
  const markdownCell = { ...cell("m-prefix", physicalBody, 3), type: "markdown" as const };
  const document = new BrowserDocument(snapshot([markdownCell]));
  const local = document.cell("m-prefix")!;
  document.edit(local.key, ["hello", "hello", "  note", "", "changed"]);
  assert.deepEqual(document.pendingSource().changes, [{
    type: "edit",
    cell: { cellId: "m-prefix" },
    body: ["#hello", "# hello", "  # note", "", "# changed"],
    cellType: "markdown",
    expectedRevision: 3,
  }]);
});

test("browser document retains a local draft after remote deletion and emits a canonical restore", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"]), cell("c2", ["x + 1"])]));
  const local = document.cell("c2")!;
  document.focus(local.key);
  document.updateSelection(local.key, { anchor: 5, head: 5, scrollTop: 24 });
  document.edit(local.key, ["x + 41"]);
  document.applyEvent({ protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1, type: "cell", operationId: "peer-delete", cellId: "c2", revision: 1, payload: { deleted: true } });
  assert.equal(local.tombstone, true);
  assert.equal(local.conflict, true);
  assert.deepEqual(document.pendingSource().changes, []);
  document.restoreDeleted(local.key, "restore-c2");
  assert.equal(local.tombstone, false);
  assert.deepEqual(document.pendingSource().changes, [{
    type: "create", creationId: "restore-c2", after: { cellId: "c1" }, body: ["x + 41"], cellType: "code", options: {},
  }]);
});

test("browser document accepts only its causally identified source event while retaining newer typing", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const local = document.cell("c1")!;
  document.edit(local.key, ["x <- 2"]);
  const command = document.buildTransactionCommand("edit-1", "browser-1")!;
  document.noteSubmitted(command.operationId, { ...command, commandSequence: 1 } as HostCommand);
  document.edit(local.key, ["x <- 3"]);
  document.applyEvent({ protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1, type: "cell", operationId: command.operationId, cellId: "c1", revision: 1, payload: cell("c1", ["x <- 2"], 1) as never });
  assert.deepEqual(local.desiredBody, ["x <- 3"]);
  assert.equal(local.conflict, false);
  assert.deepEqual(document.pendingSource().changes, [{ type: "edit", cell: { cellId: "c1" }, body: ["x <- 3"], cellType: "code", expectedRevision: 1 }]);
});

test("browser document applies only complete authoritative sidecar observations", () => {
  const document = new BrowserDocument(snapshot());
  const event = (cursor: number, payload: unknown): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, documentRevision: cursor, timestamp: cursor,
    type: "notebook", payload: payload as never,
  });
  const packages = { state: "present" as const, digest: "a".repeat(64), version: "packages-v2", error: null };
  document.applyEvent(event(1, { sidecars: { config: snapshot().sidecars.config, layout: snapshot().sidecars.layout, packages }, dirty: true }));
  assert.equal(document.snapshot.sidecars.packages.version, "packages-v2");
  const authoritative = document.snapshot.sidecars;
  document.applyEvent(event(2, { sidecars: { packages } }));
  assert.strictEqual(document.snapshot.sidecars, authoritative);
});

test("browser document applies canonical transaction ordering and metadata deltas", () => {
  const document = new BrowserDocument(snapshot());
  const event = (cursor: number, type: HostEvent["type"], payload: unknown, cellId?: string): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, documentRevision: cursor, timestamp: cursor, type, payload: payload as never, ...(cellId ? { cellId } : {}),
  });
  document.applyEvent(event(1, "transaction", { created: { "from-peer": "c3" }, updated: [{ id: "c1", revision: 1 }], deleted: [], order: ["c1", "c3", "c2"] }));
  document.applyEvent(event(2, "cell", cell("c3", ["middle <- TRUE"]), "c3"));
  assert.deepEqual(document.cells.map((value) => value.id), ["c1", "c3", "c2"]);
  assert.deepEqual(document.snapshot.cells.map((value) => value.id), ["c1", "c3", "c2"]);
  document.applyEvent(event(3, "notebook", { moved: "c2", after: null }));
  assert.deepEqual(document.cells.map((value) => value.id), ["c2", "c1", "c3"]);
  document.applyEvent(event(4, "notebook", { config: { theme: "dark" } }));
  assert.deepEqual(document.snapshot.config, { theme: "dark" });
  assert.equal(document.snapshot.changed, true);
  document.applyEvent(event(5, "operation", operation("peer-operation")));
  assert.equal(document.snapshot.operations.at(-1)?.id, "peer-operation");
  document.applyEvent(event(6, "notebook", { saved: true }));
  assert.equal(document.snapshot.changed, false);
});

test("browser document consumes authoritative reload cells, order, and clean state", () => {
  const document = new BrowserDocument(snapshot());
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1,
    type: "notebook",
    payload: {
      sourceCommit: "reload-source",
      updated: [cell("c1", ["external <- 1"], 1), cell("c3", ["added <- TRUE"], 0)],
      deleted: ["c2"],
      order: ["c3", "c1"],
      dirty: false,
    },
  });
  assert.deepEqual(document.cells.map((value) => [value.id, value.serverRevision, value.serverBody]), [
    ["c3", 0, ["added <- TRUE"]],
    ["c1", 1, ["external <- 1"]],
  ]);
  assert.deepEqual(document.snapshot.cells.map((value) => value.id), ["c3", "c1"]);
  assert.equal(document.snapshot.changed, false);
});

test("browser document records accepted operations from receipt envelopes", () => {
  const document = new BrowserDocument(snapshot());
  const accepted = operation("receipt-operation", "accepted");
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 0, timestamp: 1,
    type: "receipt", payload: { operation: accepted, commandType: "save" },
  });
  assert.deepEqual(document.snapshot.operations, [accepted]);
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  disconnect(): void { this.readyState = 3; this.onclose?.({ code: 1006, reason: "test disconnect" } as CloseEvent); }
}

function resultFor(id: string, result: unknown, status: OperationRecord["status"] = "done", sequence = 1): CommandResult {
  const operationValue = { ...operation(id, status, result), clientId: "browser-test", commandSequence: sequence };
  return { epoch: "epoch-1", operation: operationValue, documentRevision: 1, version: 2, cursor: sequence, nextCommandSequence: sequence + 1, result: result as never, error: null };
}

function admissionFor(clientId: string, id: string, sequence: number, status: OperationRecord["status"] = "done", result: unknown = null): unknown {
  return {
    epoch: "epoch-1", clientId, operationId: id, commandSequence: sequence, accepted: true, sequenceConsumed: true,
    operation: { ...operation(id, status, result), clientId, commandSequence: sequence }, error: null, nextCommandSequence: sequence + 1,
  };
}
function recoverySnapshot(snapshotValue: HostSnapshot): unknown {
  return {
    type: "recovery",
    protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
    recovery: encodeRecoveryWire({ kind: "snapshot", epoch: snapshotValue.epoch, cursor: snapshotValue.cursor, snapshot: snapshotValue }),
  };
}

test("browser transport handshakes before sending canonical sequential commands", async () => {
  const socket = new FakeSocket();
  const events: HostEvent[] = [];
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-test", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, onEvent: (event) => events.push(event),
    recoveryStore: new MemoryRecoveryStore(),
  });
  const connected = transport.connect();
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]!), { type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: "lease-1", clientId: "browser-test", csrf: "csrf-1", epoch: null, cursor: null });
  socket.receive(recoverySnapshot(snapshot()));
  assert.equal((await connected).kind, "snapshot");
  const one = transport.dispatch({ type: "save", operationId: "one", clientId: "browser-test", sessionEpoch: "epoch-1", expectedDocumentRevision: 0 });
  const two = transport.dispatch({ type: "interrupt", operationId: "two", clientId: "browser-test", sessionEpoch: "epoch-1" });
  assert.deepEqual(socket.sent.slice(1).map((raw) => JSON.parse(raw).sequence), [1, 2]);
  socket.receive({ type: "commandResult", sequence: 1, result: admissionFor("browser-test", "one", 1) });
  socket.receive({ type: "commandResult", sequence: 2, result: admissionFor("browser-test", "two", 2) });
  assert.equal((await one).operation?.id, "one");
  assert.equal((await two).operation?.id, "two");
  const output = { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 2, version: 2, documentRevision: 0, timestamp: 1, type: "runtime", payload: snapshot().runtime };
  socket.receive({ type: "event", event: output });
  socket.receive({ type: "event", event: output });
  assert.equal(events.length, 1);
  transport.close();
});

test('browser submits a startup marker when host startup execution is disabled', async () => {
  const socket = new FakeSocket();
  const store = new MemoryRecoveryStore();
  const clientId = 'browser-no-startup-run';
  const client = new BrowserNotebookClient({
    url: 'ws://127.0.0.1/api/socket', reconnect: false, clientId, leaseId: 'lease-1', csrf: 'csrf-1',
    webSocketFactory: () => socket, recoveryStore: store, requestAnimationFrame: () => 0,
  });
  const baseSnapshot = snapshot();
  const stoppedRuntime = { ...baseSnapshot.runtime, kernelState: 'stopped' as const, executionReady: false, startupActivated: false, kernelEpoch: null };
  const selectedRuntime = { ...stoppedRuntime, rEnvironment: { rscript: '/usr/bin/Rscript', rHome: '/usr/lib/R', version: '4.6.1', platform: 'linux', arch: 'x64', libraryPaths: ['/tmp/alder-r-library'], identity: 'a'.repeat(64) } };
  const noRunSnapshot = { ...baseSnapshot, config: { on_startup: false }, runtime: stoppedRuntime };
  try {
    await withBrowserFetch(async () => new Response(JSON.stringify({
      epoch: 'epoch-1', documentRevision: 0, cursor: 0, result: { branches: [], pending: false, corruption: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }), async () => {
      const connected = client.connect();
      socket.open();
      socket.receive(recoverySnapshot(noRunSnapshot));
      await connected;
      assert.equal(socket.sent.length, 1, 'startup must wait for the selected R environment');
      socket.receive({ type: 'event', event: { protocol: HOST_PROTOCOL, epoch: 'epoch-1', cursor: 1, version: 2, documentRevision: 0, timestamp: 1, type: 'runtime', payload: selectedRuntime } });
      await waitUntil(() => socket.sent.length === 2);
      const frame = JSON.parse(socket.sent[1]!) as { sequence: number; command: Extract<HostCommand, { type: 'run' }> };
      assert.equal(frame.command.type, 'run');
      assert.equal(frame.command.startup, true);
      assert.equal(frame.command.clientId, clientId);
      socket.receive({
        type: 'commandResult',
        sequence: frame.sequence,
        result: admissionFor(clientId, frame.command.operationId, frame.sequence, 'done', { startupActivated: true, run: false }),
      });
    });
  } finally {
    client.close();
  }
});

test("browser transport rejects a stalled recovery handshake on its finite deadline", async () => {
  const socket = new FakeSocket();
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-timeout", leaseId: "lease-1", csrf: "csrf-1",
    handshakeTimeoutMs: 5, webSocketFactory: () => socket,
  });
  try {
    const connected = transport.connect();
    socket.open();
    await assert.rejects(connected, (error: unknown) => error instanceof BrowserTransportError && error.code === "transport_closed" && /timed out/.test(error.message));
    assert.equal(socket.readyState, 3, "a timed-out recovery socket must be closed before the attempt is discarded");
  } finally {
    transport.close();
  }
});

test("browser transport rejects a rebound host before applying its recovery snapshot", async () => {
  const socket = new FakeSocket();
  let snapshots = 0;
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-continuity", leaseId: "lease-1", csrf: "csrf-1",
    continuityProof: "trusted-proof", webSocketFactory: () => socket, onSnapshot: () => { snapshots += 1; },
  });
  try {
    const connected = transport.connect();
    socket.open();
    socket.receive({ ...recoverySnapshot(snapshot()), continuityProof: "replacement-proof" });
    await assert.rejects(connected, (error: unknown) => error instanceof BrowserTransportError && error.code === "host_identity_mismatch");
    assert.equal(snapshots, 0, "an unauthenticated replacement snapshot must never reach the renderer");
  } finally {
    transport.close();
  }
});

test("browser transport reconnects with its in-memory recovery cursor", async () => {
  const sockets: FakeSocket[] = [];
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket", clientId: "browser-memory-recovery", leaseId: "lease-1", csrf: "csrf-1",
    reconnectDelayMs: 1, maxReconnectDelayMs: 1, webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    recoveryStore: new MemoryRecoveryStore(),
  });
  try {
    const connected = transport.connect();
    sockets[0]!.open();
    sockets[0]!.receive(recoverySnapshot(snapshot()));
    await connected;
    sockets[0]!.receive({ type: "event", event: { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2, documentRevision: 0, timestamp: 1, type: "runtime", payload: snapshot().runtime } });
    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), { type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: "lease-1", clientId: "browser-memory-recovery", csrf: "csrf-1", epoch: "epoch-1", cursor: 1 });
  } finally {
    transport.close();
  }
});

test("an epoch replacement rejects old operation waiters before accepting reused IDs", async () => {
  const sockets: FakeSocket[] = [];
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", clientId: "browser-epoch-replacement", leaseId: "lease-1", csrf: "csrf-1",
    reconnectDelayMs: 1, maxReconnectDelayMs: 1, webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    recoveryStore: new MemoryRecoveryStore(),
  });
  try {
    const connected = client.connect();
    sockets[0]!.open();
    sockets[0]!.receive(recoverySnapshot(snapshot()));
    await connected;
    const staleWaiter = assert.rejects(client.awaitOperation("shared-operation", 5_000), (error: unknown) => error instanceof BrowserTransportError && error.code === "session_replaced");
    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    const replacement = { ...snapshot(), epoch: "epoch-2", operations: [{ ...operation("shared-operation"), clientId: "browser-test", commandSequence: 1, result: { epoch: 2 } as never }] };
    sockets[1]!.receive(recoverySnapshot(replacement));
    await staleWaiter;
    const current = await client.awaitOperation("shared-operation", 50);
    assert.deepEqual(current.result, { epoch: 2 });
  } finally {
    client.close();
  }
});

test("ambiguous structural transport failure retains durable receipt recovery", async () => {
  const socket = new FakeSocket();
  const store = new MemoryRecoveryStore();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-ambiguous", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: store,
  });
  try {
    const connected = client.connect();
    socket.open();
    socket.receive(recoverySnapshot(snapshot()));
    const document = await connected;
    const changing = client.setDisabled(document.cell("c1")!.key, true);
    await waitUntil(() => socket.sent.length === 2);
    socket.disconnect();
    await assert.rejects(changing, (error: unknown) => error instanceof BrowserTransportError && !error.definitive);
    await client.flushDraftPersistence();
    const draft = await store.loadDraft("browser-ambiguous");
    assert.equal(draft?.operation?.clientId, "browser-ambiguous");
    assert.deepEqual(draft?.operation?.changes, [{ type: "options", cell: { cellId: "c1" }, expectedRevision: 0, patch: { disabled: true } }]);
    assert.equal(document.hasSourceConflicts, true);
  } finally {
    client.close();
  }
});



test("ambiguous edit receipt blocks later source dispatch without losing newer typing", async () => {
  const socket = new FakeSocket();
  const store = new MemoryRecoveryStore();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-edit-ambiguous", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: store,
  });
  try {
    const connected = client.connect();
    socket.open();
    socket.receive(recoverySnapshot(snapshot()));
    const document = await connected;
    const key = document.cell("c1")!.key;
    client.editCell(key, "x <- 2");
    const committing = client.commitEdits();
    await waitUntil(() => socket.sent.length === 2);
    socket.disconnect();
    await assert.rejects(committing, (error: unknown) => error instanceof BrowserTransportError && !error.definitive);
    client.editCell(key, "x <- 3");
    await assert.rejects(client.commitEdits(), (error: unknown) => error instanceof BrowserTransportError && error.code === "recovery_receipt_pending");
    await client.flushDraftPersistence();
    const draft = await store.loadDraft("browser-edit-ambiguous");
    assert.equal(typeof draft?.operation?.operationId, "string");
    assert.deepEqual(draft?.operation?.changes, [{ type: "edit", cell: { cellId: "c1" }, body: ["x <- 2"], cellType: "code", expectedRevision: 0 }]);
    assert.deepEqual(draft?.changes, [{ type: "edit", cell: { cellId: "c1" }, body: ["x <- 3"], cellType: "code", expectedRevision: 0 }]);
  } finally {
    client.close();
  }
});
test("authoritative host rejection clears the receipt gate for later source edits", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-rejected", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: new MemoryRecoveryStore(),
  });
  try {
    const connected = client.connect();
    socket.open();
    socket.receive(recoverySnapshot(snapshot()));
    const document = await connected;
    const key = document.cell("c1")!.key;
    client.editCell(key, "x <- 2");
    const rejected = client.commitEdits();
    await waitUntil(() => socket.sent.length === 2);
    const frame = JSON.parse(socket.sent[1]!) as { sequence: number };
    socket.receive({ type: "error", sequence: frame.sequence, definitive: true, error: { code: "source_conflict", message: "stale source" } });
    await assert.rejects(rejected, (error: unknown) => error instanceof BrowserTransportError && error.definitive);
    client.useServerVersion(key);
    client.editCell(key, "x <- 3");
    const later = client.commitEdits();
    await waitUntil(() => socket.sent.length === 3);
    later.catch(() => undefined);
  } finally {
    client.close();
  }
});


test("Run waits for an in-flight source transaction before deriving its revision", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-race", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: new MemoryRecoveryStore(), requestAnimationFrame: () => 0,
  });
  const connected = client.connect();
  socket.open();
  socket.receive(recoverySnapshot(snapshot()));
  const document = await connected;
  const first = document.cell("c1")!;
  client.editCell(first.key, "x <- 40");
  const localProjections: Array<readonly string[] | undefined> = [];
  client.subscribe((_document, event, keys) => { if (!event) localProjections.push(keys); });
  const committing = client.commitEdits();
  await waitUntil(() => socket.sent.length === 2);
  const editFrame = JSON.parse(socket.sent[1]!) as { sequence: number; command: Extract<HostCommand, { type: "transaction" }> };
  assert.equal(editFrame.command.type, "transaction");
  assert.equal(editFrame.command.changes[0]?.type, "edit");
  assert.equal((editFrame.command.changes[0] as { expectedRevision?: number }).expectedRevision, 0);
  const running = client.runCell(first.key, { timeStamp: 10 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.sent.length, 2, "Run must remain behind the unresolved source acknowledgement");
  const txResult = { edited: [{ id: "c1", revision: 1 }], created: {}, deleted: [], documentRevision: 1 };
  socket.receive({ type: "commandResult", sequence: editFrame.sequence, result: admissionFor("browser-race", editFrame.command.operationId, editFrame.sequence, "accepted") });
  const committed: OperationRecord = {
    ...operation(editFrame.command.operationId, "done", txResult),
    kind: "transaction",
    clientId: "browser-race",
    commandSequence: editFrame.sequence,
    documentRevision: 1,
  };
  socket.receive({ type: "event", event: { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2, documentRevision: 1, timestamp: 1, type: "operation", operationId: editFrame.command.operationId, payload: committed } });
  await committing;
  assert.deepEqual(localProjections, [undefined, [first.key]], "source acknowledgements must update the affected editor");
  await waitUntil(() => socket.sent.length === 3);
  const runFrame = JSON.parse(socket.sent[2]!) as { sequence: number; command: Extract<HostCommand, { type: "run" }> };
  assert.equal(runFrame.command.type, "run");
  assert.deepEqual(runFrame.command.target, { cellId: "c1" });
  assert.equal(runFrame.command.changes, undefined, "Run must not repeat the source just acknowledged");
  socket.receive({ type: "commandResult", sequence: runFrame.sequence, result: admissionFor("browser-race", runFrame.command.operationId, runFrame.sequence, "accepted", { runId: "run-1", plan: [] }) });
  assert.equal((await running).operation.id, runFrame.command.operationId);
  assert.deepEqual(localProjections, [undefined, [first.key]]);
  client.close();
});
test("run source outcome events can arrive before command admission", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-source-event", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: new MemoryRecoveryStore(),
  });
  try {
    const connected = client.connect();
    socket.open();
    socket.receive(recoverySnapshot(snapshot()));
    const document = await connected;
    const target = document.cell("c1")!;
    client.editCell(target.key, "x <- 2");
    const running = client.runCell(target.key);
    await waitUntil(() => socket.sent.length === 2);
    const frame = JSON.parse(socket.sent[1]!) as { sequence: number; command: Extract<HostCommand, { type: "run" }> };
    const outcome = { created: {}, edited: [{ id: "c1", revision: 1 }], deleted: [], documentRevision: 1 };
    const committed: OperationRecord = {
      ...operation(frame.command.operationId, "accepted", outcome),
      kind: "run",
      clientId: "browser-source-event",
      commandSequence: frame.sequence,
      runId: null,
    };
    socket.receive({ type: "event", event: { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2, documentRevision: 1, timestamp: 1, type: "operation", operationId: frame.command.operationId, payload: committed } });
    assert.deepEqual(document.pendingSource().changes, [], "the same operation's outcome must acknowledge source before admission");
    socket.receive({ type: "commandResult", sequence: frame.sequence, result: admissionFor("browser-source-event", frame.command.operationId, frame.sequence, "accepted") });
    assert.equal((await running).operation.id, frame.command.operationId);
  } finally {
    client.close();
  }
});

test("recovered run source outcome preserves newer drafts and rejects foreign convergence", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-source-recovery", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: new MemoryRecoveryStore(),
  });
  try {
    const connected = client.connect();
    socket.open();
    socket.receive(recoverySnapshot(snapshot()));
    const document = await connected;
    const target = document.cell("c1")!;
    client.editCell(target.key, "x <- 2");
    let settled = false;
    const running = client.runCell(target.key).then((result) => { settled = true; return result; });
    await waitUntil(() => socket.sent.length === 2);
    const frame = JSON.parse(socket.sent[1]!) as { sequence: number; command: Extract<HostCommand, { type: "run" }> };
    socket.receive({ type: "commandResult", sequence: frame.sequence, result: admissionFor("browser-source-recovery", frame.command.operationId, frame.sequence, "accepted") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false, "admission alone must not release the source lane");

    const identicalForeign = { ...snapshot([cell("c1", ["x <- 2"], 1), cell("c2", ["x + 1"]) ]), cursor: 1, version: 2, documentRevision: 1 };
    socket.receive(recoverySnapshot(identicalForeign));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false, "a foreign snapshot with identical bytes cannot acknowledge our run");

    client.editCell(target.key, "x <- 3");
    const failedOperation: OperationRecord = {
      ...operation(frame.command.operationId, "error", { created: {}, edited: [{ id: "c1", revision: 1 }], deleted: [], documentRevision: 1 }),
      kind: "run",
      clientId: "browser-source-recovery",
      commandSequence: frame.sequence,
      runId: null,
      documentRevision: 2,
      error: { code: "analysis_failed", message: "analysis failed" },
    };
    const recovered = { ...snapshot([cell("c1", ["foreign"], 2), cell("c2", ["x + 1"]) ]), cursor: 2, version: 3, documentRevision: 2, operations: [failedOperation] };
    socket.receive(recoverySnapshot(recovered));
    await running;
    assert.deepEqual(target.desiredBody, ["x <- 3"]);
    assert.deepEqual(target.serverBody, ["foreign"]);
    assert.equal(target.serverRevision, 2);
    assert.equal(target.conflict, true);
    assert.deepEqual(document.pendingSource().changes, [{ type: "edit", cell: { cellId: "c1" }, body: ["x <- 3"], cellType: "code", expectedRevision: 2 }]);
    assert.equal((await client.awaitOperation(frame.command.operationId, 50)).status, "error");
  } finally {
    client.close();
  }
});

test("source outcome accepts an exact same-revision no-op", () => {
  const document = new BrowserDocument(snapshot());
  const command = {
    type: "run", operationId: "run-no-op", clientId: "browser-no-op", sessionEpoch: document.epoch, scope: "all",
    changes: [{ type: "edit", cell: { cellId: "c1" }, body: ["x <- 1"], cellType: "code", expectedRevision: 0 }], expectedDocumentRevision: 0,
  } as Extract<HostCommand, { type: "run" }>;
  document.noteSubmitted(command.operationId, command);
  assert.equal(document.acknowledgeSourceCommit(command.operationId, { created: {}, edited: [], deleted: [], documentRevision: 0 }), true);
  assert.deepEqual(document.pendingSource().changes, []);
});

test("interactive deferred requests expose their exact terminal operation", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-deferred", leaseId: "lease-1", csrf: "csrf-1",
    webSocketFactory: () => socket, recoveryStore: new MemoryRecoveryStore(),
  });
  const connected = client.connect();
  socket.open();
  socket.receive(recoverySnapshot(snapshot()));
  await connected;
  let settled = false;
  const requested = client.requestLazy("lazy-1").then((result) => { settled = true; return result; });
  await waitUntil(() => socket.sent.length === 2);
  const frame = JSON.parse(socket.sent[1]!) as { sequence: number; command: HostCommand };
  socket.receive({ type: "commandResult", sequence: frame.sequence, result: admissionFor("browser-deferred", frame.command.operationId, frame.sequence, "accepted") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "an accepted request must not unlock its control before the kernel settles it");
  socket.receive({ type: "event", event: { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2, documentRevision: 0, timestamp: 1, type: "operation", operationId: frame.command.operationId, payload: { ...operation(frame.command.operationId, "done", { key: "lazy-1" }), clientId: "browser-deferred", commandSequence: frame.sequence } } });
  assert.equal((await requested).operation.status, "done");
  client.close();
});

test("LSP mapping preserves native file URIs and excludes delimiter lines", () => {
  assert.equal(encodeFilePathUri("C:\\Users\\A B\\café #?%20.R", "win32"), "file:///C:/Users/A%20B/caf%C3%A9%20%23%3F%2520.R");
  assert.equal(encodeFilePathUri("C:/", "win32"), "file:///C:/");
  assert.equal(encodeFilePathUri("\\\\server\\share\\a b%20.R", "win32"), "file://///server/share/a%20b%2520.R");
  assert.equal(encodeFilePathUri("/tmp/café #?%20\\name.R", "linux"), "file:///tmp/caf%C3%A9%20%23%3F%2520%5Cname.R");
  assert.equal(encodeFilePathUri("/", "linux"), "file:///");
  assert.equal(fileUri("unsaved # %20.R", "/tmp/alder project", "linux"), "file:///tmp/alder%20project/unsaved%20%23%20%2520.R");
  const notebook = {
    path: "/tmp/notebook.R", header: ["# title"], cells: [
      { id: "a", type: "code" as const, options: { label: "one" }, body: ["x <- 1", "x"] },
      { id: "b", type: "markdown" as const, body: ["# heading"] },
    ],
  };
  const layout = layoutNotebook(notebook);
  assert.equal(layout.text, "# title\n# %%\n#| label: one\nx <- 1\nx\n# %% [markdown]\n# heading\n");
  assert.deepEqual(toFilePosition(notebook, { cell: "a", line: 1, character: 1 }), { line: 4, character: 1 });
  assert.equal(fromFilePosition(notebook, { line: 2, character: 0 }), null);
  assert.deepEqual(fromFilePosition(notebook, { line: 6, character: 2 }), { cell: "b", line: 0, character: 0 });
  const markdownNotebook = {
    path: "/tmp/markdown.R", cells: [{
      id: "m", type: "markdown" as const, body: ["# heading", "#hello", "  # indented", ""],
    }],
  };
  assert.deepEqual(toFilePosition(markdownNotebook, { cell: "m", line: 0, character: 0 }), { line: 1, character: 2 });
  assert.deepEqual(fromFilePosition(markdownNotebook, { line: 1, character: 2 }), { cell: "m", line: 0, character: 0 });
  assert.deepEqual(toFilePosition(markdownNotebook, { cell: "m", line: 1, character: 2 }), { line: 2, character: 3 });
  assert.deepEqual(fromFilePosition(markdownNotebook, { line: 2, character: 3 }), { cell: "m", line: 1, character: 2 });
  assert.deepEqual(toFilePosition(markdownNotebook, { cell: "m", line: 2, character: 1 }), { line: 3, character: 1 });
  assert.deepEqual(toFilePosition(markdownNotebook, { cell: "m", line: 2, character: 2 }), { line: 3, character: 4 });
  assert.deepEqual(fromFilePosition(markdownNotebook, { line: 3, character: 3 }), { cell: "m", line: 2, character: 2 });
  assert.deepEqual(toFilePosition(markdownNotebook, { cell: "m", line: 3, character: 0 }), { line: 4, character: 0 });
  const uri = "file:///tmp/notebook.R";
  assert.deepEqual(translateLspResult([
    { uri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } },
    { uri: "file:///tmp/other.R", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ], "textDocument/definition", notebook, uri), [{
    uri, range: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 1 } },
  }]);
  assert.deepEqual(translateLspResult({
    targetUri: uri,
    targetRange: { start: { line: 3, character: 0 }, end: { line: 4, character: 1 } },
    targetSelectionRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
    originSelectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
  }, "textDocument/definition", notebook, uri), {
    targetUri: uri,
    targetRange: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 1, character: 1 } },
    targetSelectionRange: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 1 } },
    originSelectionRange: { start: { cell: "a", line: 1, character: 0 }, end: { cell: "a", line: 1, character: 1 } },
  });
  assert.deepEqual(translateLspResult([{
    name: "initial_symbol", kind: 12,
    location: { uri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 14 } } },
  }], "textDocument/documentSymbol", notebook, uri), [{
    name: "initial_symbol", kind: 12,
    location: { uri, range: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 14 } } },
  }]);
  assert.deepEqual(translateLspResult({
    isIncomplete: false,
    items: [{
      label: "x11", kind: 6,
      textEdit: {
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
        newText: "x11",
      },
    }, {
      label: "replacement", kind: 6,
      textEdit: {
        insert: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
        replace: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
        newText: "replacement",
      },
      additionalTextEdits: [{
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
        newText: "x",
      }],
    }, {
      label: "delimiter",
      textEdit: {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
        newText: "ignored",
      },
    }],
  }, "textDocument/completion", notebook, uri), {
    isIncomplete: false,
    items: [{
      label: "x11", kind: 6,
      textEdit: {
        range: { start: { cell: "a", line: 1, character: 0 }, end: { cell: "a", line: 1, character: 1 } },
        newText: "x11",
      },
    }, {
      label: "replacement", kind: 6,
      textEdit: {
        insert: { start: { cell: "a", line: 1, character: 0 }, end: { cell: "a", line: 1, character: 1 } },
        replace: { start: { cell: "a", line: 1, character: 0 }, end: { cell: "a", line: 1, character: 1 } },
        newText: "replacement",
      },
      additionalTextEdits: [{
        range: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 1 } },
        newText: "x",
      }],
    }],
  });
  assert.deepEqual(translateLspResult({
    contents: [{ kind: "markdown", value: "### Help" }, { language: "r", value: "x < 2" }],
    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
  }, "textDocument/hover", notebook, uri), {
    contents: [{ kind: "markdown", value: "### Help" }, { language: "r", value: "x < 2" }],
    range: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 1 } },
  });
  const options = validatedRLanguageServerOptions({ path: "/tmp/alder-project/unsaved.R", cells: [] }, "/opt/R/bin/Rscript", "/opt/alder/worker", { spawn: async () => { throw new Error("mapping test must not spawn"); } });
  assert.equal(options.command, "/opt/R/bin/Rscript");
  assert.equal(options.cwd, dirname(resolve("/tmp/alder-project/unsaved.R")));
  assert.deepEqual(options.args, ["--vanilla", join("/opt/alder/worker", "host-lsp.R")]);
});
test("LSP child environment excludes project and user R libraries", () => {
  const environment = trustedRLanguageServerEnvironment({
    ALDER_R_LIBRARIES: JSON.stringify(["/tmp/project-library"]),
    R_LIBS_USER: "/tmp/user-library",
    ALDER_RESOURCES_ROOT: "/tmp/attacker-root",
    TEST_ENV: "preserved",
  }, ["/opt/alder/r-library", "/usr/lib/R/library"], "/opt/alder");
  assert.deepEqual(JSON.parse(environment.ALDER_R_LIBRARIES!), [
    "/opt/alder/r-library", "/usr/lib/R/library",
  ]);
  assert.equal(environment.R_LIBS, ["/opt/alder/r-library", "/usr/lib/R/library"].join(delimiter));
  assert.equal(environment.R_LIBS_USER, "");
  assert.equal(environment.R_LIBS_SITE, "");
  assert.equal(environment.TEST_ENV, "preserved");
  assert.equal(environment.ALDER_RESOURCES_ROOT, "/opt/alder");
  assert.throws(() => trustedRLanguageServerEnvironment({}, ["relative/library"], "/opt/alder"), /absolute trusted R library paths/);
});
test("LSP diagnostics publish bounded exact-source replacements and reject obsolete versions", async () => {
  const process = fakeLanguageServer();
  const initial: NotebookDocument = {
    path: "/tmp/lsp-source-identity.R",
    cells: [{ id: "cell-1", revision: 1, type: "code", body: ["x <- 1"] }],
  };
  const publications: Array<{ document: NotebookDocument; diagnostics: DiagnosticsByCell }> = [];
  const client = new LspClient({
    command: "fake-language-server",
    document: initial,
    diagnostics: true,
    processScope: fakeProcessScope(process),
    onDiagnostics: (document, diagnostics) => publications.push({ document, diagnostics }),
  });
  try {
    await client.start();
    await waitUntil(() => publications.some(({ diagnostics }) => diagnostics["cell-1"]?.[0]?.message === "initial"));
    await waitUntil(() => publications.some(({ diagnostics }) => diagnostics[".document"]?.[0]?.code === "document"));
    const documentDiagnostic = publications.find(({ diagnostics }) => diagnostics[".document"]?.[0]?.code === "document")!;
    assert.equal(documentDiagnostic.diagnostics[".document"]![0]!.range, null);
    assert.deepEqual(documentDiagnostic.diagnostics[".document"]![0]!.fileRange, {
      start: { line: 0, character: 0 }, end: { line: 1, character: 1 },
    });
    const changed: NotebookDocument = {
      ...initial,
      cells: [{ id: "cell-1", revision: 2, type: "code", body: ["x <- 2"] }],
    };
    assert.equal(await client.syncDocument(changed), true);
    await waitUntil(() => publications.some(({ diagnostics }) => diagnostics["cell-1"]?.[0]?.code === "current"));

    const messages = publications.flatMap(({ diagnostics }) => Object.values(diagnostics).flat().map((item) => item.message));
    assert.equal(messages.includes("stale"), false);
    assert.equal(messages.includes("versionless"), false);
    const current = publications.findLast(({ diagnostics }) => diagnostics["cell-1"]?.[0]?.code === "current")!;
    assert.equal(current.document.cells[0]?.revision, 2);
    assert.deepEqual(current.document.cells[0]?.body, ["x <- 2"]);
    assert.ok(Buffer.byteLength(current.diagnostics["cell-1"]![0]!.message, "utf8") <= 4_096);

    assert.equal(await client.setDiagnostics(false), true);
    assert.deepEqual(publications.at(-1)?.diagnostics, {});
  } finally {
    await client.stop();
  }
});

test("LSP stop interrupts an initialize request in flight", { timeout: 5_000 }, async () => {
  let observed!: () => void;
  const initialized = new Promise<void>((resolve) => { observed = resolve; });
  const process = fakeLanguageServer({ respondToInitialize: false, onInitialize: observed });
  const client = new LspClient({
    command: "fake-language-server",
    document: { path: "/tmp/lsp-stopping.R", cells: [{ id: "cell-1", body: ["x <- 1"] }] },
    initializeTimeoutMs: 30_000,
    processScope: fakeProcessScope(process),
  });
  const starting = client.start();
  await initialized;
  const rejected = assert.rejects(starting);
  await client.stop();
  await rejected;
  assert.equal(client.alive(), false);
});

test("LSP reports an idle language-server exit without waiting for another request", async () => {
  const process = fakeLanguageServer();
  const failures: string[] = [];
  const client = new LspClient({
    command: "fake-language-server",
    document: { path: "/tmp/lsp-idle-exit.R", cells: [{ id: "cell-1", body: ["x <- 1"] }] },
    processScope: fakeProcessScope(process),
    onFailure: (message) => failures.push(message),
  });
  try {
    await client.start();
    Object.assign(process, { exitCode: 9 });
    process.emit("exit", 9, null);
    await waitUntil(() => failures.length === 1);
    assert.match(failures[0]!, /language server exited with status 9/);
    assert.equal(client.alive(), false);
  } finally {
    await client.stop();
  }
});

const liveRscript = process.env.ALDER_TEST_RSCRIPT;
const liveWorkerDirectory = process.env.ALDER_TEST_WORKER_DIR ?? process.env.ALDER_WORKER_DIR;
test("LSP deferred diagnostics ignore project .lintr and package startup side effects", {
  timeout: 60_000,
  skip: liveRscript === undefined || liveWorkerDirectory === undefined,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-lsp-security-"));
  const projectLibrary = join(directory, "library");
  const packageDirectory = join(directory, "hostile-package");
  const notebookPath = join(directory, "notebook.R");
  const markerPath = join(directory, "package-loaded");
  await mkdir(projectLibrary, { recursive: true });
  await mkdir(join(packageDirectory, "R"), { recursive: true });
  await writeFile(join(packageDirectory, "DESCRIPTION"), [
    "Package: alderhostile",
    "Type: Package",
    "Title: Alder hostile LSP fixture",
    "Version: 0.0.1",
    "Authors@R: person(\"Alder\", \"Test\", role = c(\"aut\", \"cre\"), email = \"test@example.com\")",
    "Description: Alder hostile LSP fixture.",
    "License: MIT",
    "",
  ].join("\n"));
  await writeFile(join(packageDirectory, "NAMESPACE"), "");
  await writeFile(join(packageDirectory, "R", "zzz.R"), [
    ".onLoad <- function(libname, pkgname) {",
    "  marker <- Sys.getenv(\"ALDER_HOSTILE_MARKER\", unset = \"\")",
    "  if (nzchar(marker)) writeLines(\"package-loaded\", marker)",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(directory, ".lintr"), [
    "linters: {",
    " library(\"alderhostile\")",
    " lintr::linters_with_defaults()",
    " }",
    "",
  ].join("\n"));
  await writeFile(notebookPath, "x == NA\n");
  const rExecutable = join(dirname(liveRscript!), process.platform === "win32" ? "R.exe" : "R");
  const installerResult = Promise.withResolvers<void>();
  const installer = spawn(rExecutable, ["CMD", "INSTALL", "--no-test-load", "--library=" + projectLibrary, packageDirectory], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let installerStderr = "";
  installer.stderr.on("data", (chunk: Buffer) => { installerStderr += chunk.toString("utf8"); });
  installer.once("error", installerResult.reject);
  installer.once("close", (code) => code === 0 ? installerResult.resolve() : installerResult.reject(new Error("hostile fixture install failed (" + code + "): " + installerStderr)));
  await installerResult.promise;
  const inheritedLibraries = (() => {
    try {
      const parsed = JSON.parse(process.env.ALDER_R_LIBRARIES ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  })();
  const resourcesRoot = process.env.ALDER_TEST_RESOURCES_ROOT ?? process.env.ALDER_RESOURCES_ROOT ?? dirname(liveWorkerDirectory!);
  const privateLibrary = process.env.ALDER_TEST_R_LIBRARY_DIR ?? process.env.ALDER_R_PRIVATE_LIBRARY ?? join(dirname(liveWorkerDirectory!), "r-library");
  const baseLibrary = process.env.ALDER_TEST_R_BASE_LIBRARY ?? inheritedLibraries.at(-1) ?? await (() => {
    const probeResult = Promise.withResolvers<string>();
    const probe = spawn(liveRscript!, ["--vanilla", "-e", "cat(file.path(R.home(), \"library\"))"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    probe.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    probe.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    probe.once("error", probeResult.reject);
    probe.once("close", (code) => code === 0 && output.trim() ? probeResult.resolve(output.trim()) : probeResult.reject(new Error("R base-library probe failed (" + code + "): " + stderr)));
    return probeResult.promise;
  })();
  const environment = {
    ...process.env,
    ALDER_R_LIBRARIES: JSON.stringify([privateLibrary, projectLibrary, baseLibrary]),
    ALDER_RESOURCES_ROOT: resourcesRoot,
    ALDER_WORKER_DIR: liveWorkerDirectory,
    ALDER_R_PRIVATE_LIBRARY: privateLibrary,
    ALDER_HOSTILE_MARKER: markerPath,
  };
  const document = {
    path: notebookPath,
    cells: [{ id: "cell-1", type: "code" as const, body: ["x == NA"] }],
  };
  const publications: DiagnosticsByCell[] = [];
  const client = new LspClient({
    ...validatedRLanguageServerOptions(document, liveRscript!, liveWorkerDirectory!, directProcessScope()),
    diagnostics: true,
    env: environment,
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 10_000,
    onDiagnostics: (_changed, diagnostics) => publications.push(diagnostics),
  });
  try {
    await client.start();
    await waitUntil(() => publications.some((diagnostics) => diagnostics["cell-1"]?.length), 15_000);
    assert.equal(await readFile(markerPath, "utf8").catch(() => null), null,
      "project package .onLoad must not run during deferred LSP diagnostics");
    assert.ok(publications.some((diagnostics) => diagnostics["cell-1"]?.some((diagnostic) => diagnostic.code.includes("equals_na"))),
      "trusted diagnostics must still be published");
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
test("LSP client completes a live installed languageserver lifecycle", {
  timeout: 45_000,
  skip: liveRscript === undefined || liveWorkerDirectory === undefined,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-lsp-live-"));
  const path = join(directory, "notebook.R");
  const document = {
    path,
    cells: [{ id: "cell-1", type: "code" as const, body: ["x <- 1", "x"] }],
  };
  await writeFile(path, "# %%\nx <- 1\nx\n");
  const client = new LspClient({
    ...validatedRLanguageServerOptions(document, liveRscript!, liveWorkerDirectory!, directProcessScope()),
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 10_000,
  });
  try {
    await client.start();
    assert.equal(client.alive(), true);
    const completion = await client.requestDocument("textDocument/completion", {
      position: { cell: "cell-1", line: 1, character: 1 },
    }, document);
    const items = Array.isArray(completion) ? completion : completion && typeof completion === "object"
      ? (completion as { items?: unknown[] }).items ?? [] : [];
    const labels = items.flatMap((item) => item && typeof item === "object"
      && typeof (item as { label?: unknown }).label === "string"
      ? [(item as { label: string }).label]
      : []);
    assert.ok(labels.includes("x11"),
      `expected a live R completion result, received ${JSON.stringify(labels.slice(0, 20))}`);
    const changed = { ...document, cells: [{ ...document.cells[0]!, body: ["x <- 2", "x"] }] };
    assert.equal(await client.syncDocument(changed), true);
    assert.equal(client.documentVersion, 2);
    await client.didSave();
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(client.alive(), false);
});



async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeLanguageServer(options: {
  respondToInitialize?: boolean;
  onInitialize?: () => void;
} = {}): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffered = Buffer.alloc(0);
  const send = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message));
    stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  stdin.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = buffered.subarray(0, boundary).toString("ascii");
      const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header);
      if (!match) throw new Error("fake language server received invalid framing");
      const length = Number(match[1]);
      if (buffered.length < boundary + 4 + length) return;
      const message = JSON.parse(buffered.subarray(boundary + 4, boundary + 4 + length).toString("utf8")) as {
        id?: string | number; method?: string; params?: Record<string, unknown>;
      };
      buffered = buffered.subarray(boundary + 4 + length);
      if (message.method === "initialize" && message.id !== undefined) {
        options.onInitialize?.();
        if (options.respondToInitialize !== false) {
          send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
        }
      } else if (message.method === "textDocument/didOpen") {
        const textDocument = message.params?.textDocument as { uri: string; version: number };
        sendDiagnostic(send, textDocument.uri, textDocument.version, "initial", "initial");
        sendDiagnostic(send, textDocument.uri, textDocument.version, "document", "document-level", {
          start: { line: 0, character: 0 }, end: { line: 1, character: 1 },
        });
      } else if (message.method === "textDocument/didChange") {
        const textDocument = message.params?.textDocument as { uri: string; version: number };
        sendDiagnostic(send, textDocument.uri, textDocument.version - 1, "stale", "stale");
        sendDiagnostic(send, textDocument.uri, undefined, "versionless", "versionless");
        sendDiagnostic(send, textDocument.uri, textDocument.version, "current", "😀".repeat(2_500));
      } else if (message.method === "shutdown" && message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, result: null });
      }
    }
  });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr, pid: 42_424, exitCode: null as number | null,
    signalCode: null, killed: false,
    kill(this: EventEmitter & { exitCode: number | null; killed: boolean }): boolean {
      if (this.exitCode !== null) return false;
      this.killed = true;
      this.exitCode = 0;
      this.emit("exit", 0, null);
      return true;
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}
function fakeProcessScope(child: ChildProcessWithoutNullStreams): Pick<ProcessScope, "spawn"> {
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    spawn: async () => ({
      pid: child.pid!,
      startIdentity: "lsp-test",
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      terminate: async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        await exited;
      },
    }),
  };
}

function directProcessScope(): Pick<ProcessScope, "spawn"> {
  return {
    spawn: async (options) => {
      const child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      return {
        pid: child.pid!,
        startIdentity: "lsp-live-test",
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        terminate: async () => {
          if (child.exitCode === null) child.kill("SIGTERM");
          await exited;
        },
      };
    },
  };
}
function sendDiagnostic(
  send: (message: unknown) => void,
  uri: string,
  version: number | undefined,
  code: string,
  message: string,
  range = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
): void {
  send({
    jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
    params: {
      uri, ...(version === undefined ? {} : { version }),
      diagnostics: [{
        range,
        severity: 2, code, message,
      }],
    },
  });
}
