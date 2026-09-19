import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserNotebookClient } from "../src/browser/client.js";
import { BrowserDocument, reconcileDraft } from "../src/browser/document.js";
import { NotebookView } from "../src/browser/view.js";
import { parseHTML } from "linkedom";
import { BrowserTransport, BrowserTransportError, IndexedDBRecoveryStore, MemoryRecoveryStore, type BrowserRecoveryDraft, type WebSocketLike } from "../src/browser/transport.js";

import { encodeFilePathUri, fileUri, translateLspResult } from "../src/lsp.js";
import { fromFilePosition, layoutNotebook, parseNotebook, serializeNotebook, toFilePosition, type NotebookDocument } from "../src/notebook.js";
import { Controller } from "../src/controller.js";
import { resolveSettings } from "../src/settings.js";
import { OutputStore } from "../src/outputs.js";
import type { EngineAdapter, EngineHandshake, EngineResponse } from "../src/protocol.js";
import { decodeHostCommandWire, encodeHostEventWire, encodeRecoveryWire, HOST_PROTOCOL, HOST_CLIENT_PROTOCOL_VERSION, type CommandResult, type HostCellState, type HostCommand, type HostEvent, type HostSnapshot, type OperationRecord, type Recovery } from "../src/protocol.js";
import { ARTIFACT_DESCRIPTOR_HEADER, ARTIFACT_RESOLUTION_MEDIA_TYPE, encodeArtifactDescriptor, type ArtifactHandle } from "../src/protocol.js";
import { blocksNotebookNavigation } from "../src/browser/url.js";
import { createFormattingService } from "../src/formatting.js";
import { createProcessScope } from "../src/processes.js";

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
  // Linkedom exposes only the getter; editor controls need the browser setter.
  const selectValue = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, "value")!;
  Object.defineProperty(domWindow.HTMLSelectElement.prototype, "value", { ...selectValue, set(value: string) {
    for (const option of this.options) option.selected = false;
    const selected = [...this.options].find(option => option.value === value);
    if (selected) selected.selected = true;
  } });
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
    Object.defineProperty(domWindow.HTMLSelectElement.prototype, "value", selectValue);
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function operation(id: string, status: OperationRecord["status"] = "done", result?: unknown): OperationRecord {
  return { id, clientId: "test-client", kind: "save", status, documentRevision: 0, runId: null, result: result === undefined ? null : result as never, error: null, acceptedAt: 1, ...(status === "done" ? { settledAt: 2 } : {}) };
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
test("browser navigation blocks same-host cross-origin destinations", () => {
  const current = "http://127.0.0.1:4100/notebook";
  assert.equal(blocksNotebookNavigation("http://127.0.0.1:4200/capture", current), true);
  assert.equal(blocksNotebookNavigation("https://127.0.0.1:4100/capture", current), true);
  assert.equal(blocksNotebookNavigation("/same-origin", current), false);
  assert.equal(blocksNotebookNavigation("https://example.com/docs", current), false);
  assert.equal(blocksNotebookNavigation("http://[", current), true);
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
      await client.close();
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
  const responses = [
    artifactResolutionResponse(descriptor, path, expiresAt, { body: "{ malformed JSON" }),
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
  const command = document.buildRunCommand({ requestId: "run-1", clientId: "browser-1", scope: "cell", targetKey: createdB.key });
  assert.deepEqual(command.target, { creationId: "create-b" });
  assert.deepEqual(command.changes, [
    { type: "edit", cell: { cellId: "c1" }, body: ["x <- 40"], cellType: "code", expectedRevision: 0 },
    { type: "create", creationId: "create-a", after: { cellId: "c1" }, body: ["y <- x + 1"], cellType: "code", options: {} },
    { type: "create", creationId: "create-b", after: { creationId: "create-a" }, body: ["y + 1"], cellType: "code", options: {} },
  ]);
  document.noteSubmitted(command.requestId, { ...command } as HostCommand);
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
    type: "transaction", requestId: "delete-1", clientId: "browser-1", sessionEpoch: document.epoch,
    expectedDocumentRevision: 0, changes: [deletion],
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
      recoveryState: { status: "none", local: null, candidate: null, corruption: null, persistenceError: null },
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
      recoveryState: { status: 'none', local: null, candidate: null, corruption: null, persistenceError: null },
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
      recoveryState: { status: "none", local: null, candidate: null, corruption: null, persistenceError: null },
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

test("Publish HTML retains the draft and does not publish when Save fails", async () => {
  await withViewDom(async (dom, domWindow) => {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { search: "?view=editor", href: "http://notebook.test/book.R?view=editor", origin: "http://notebook.test" } });
    const initial = snapshot([cell("c1", ["current <- 42"])]);
    initial.dirty = true;
    initial.changed = true;
    const document = new BrowserDocument(initial);
    let publishes = 0;
    const client = settingsClient({
      save: async () => { throw new Error("source changed on disk"); },
      service: async () => { publishes += 1; return resultFor("publish", null); },
    });
    const view = new NotebookView(client, dom);
    try {
      view.render(document);
      const button = [...dom.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent === "Publish HTML");
      assert.ok(button);
      button.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
      await waitUntil(() => dom.getElementById("status")!.textContent!.includes("source changed"));
      assert.equal(publishes, 0);
      assert.deepEqual(document.cells[0]!.desiredBody, ["current <- 42"]);
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
    let releaseFlush!: () => void;
    const flushPending = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const client = {
      recoveryState: { status: "none", local: null, candidate: null, corruption: null, persistenceError: null },
      subscribeRecovery() { return () => {}; },
      startRunAll: async () => { order.push("run"); return { completed: runPending }; },
      interrupt: async () => { interruptCalls += 1; },
    } as unknown as BrowserNotebookClient;
    let view: NotebookView | null = null;
    let pending: Promise<unknown> | null = null;
    try {
      view = new NotebookView(client, dom);
      view.render(document);
      const output = (view as unknown as { output: { flush: () => Promise<void> } }).output;
      output.flush = async () => { order.push("flush"); await flushPending; };
      pending = view.runExplicit(() => client.startRunAll("all"));
      assert.deepEqual(order, ["flush"]);
      assert.equal(dom.getElementById("run-all")?.disabled, true);
      assert.equal(dom.getElementById("save")?.disabled, true);
      assert.equal(dom.getElementById("stop")?.disabled, false);
      dom.getElementById("stop")!.dispatchEvent(new domWindow.Event("click"));
      await Promise.resolve();
      assert.equal(interruptCalls, 1);
      releaseFlush();
      await waitUntil(() => dom.getElementById("save")?.disabled === false);
      assert.deepEqual(order, ["flush", "run"]);
      assert.equal(dom.getElementById("run-all")?.disabled, true);
      assert.equal(dom.getElementById("stop")?.disabled, false);
      releaseRun();
      await pending;
      assert.equal(dom.getElementById("stop")?.disabled, true);
      assert.equal(dom.getElementById("save")?.disabled, false);
    } finally {
      releaseFlush?.();
      releaseRun?.();
      await pending?.catch(() => undefined);
      view?.destroy();
    }
  });
});

for (const failure of ["preparation", "execution"] as const) {
  test(`view releases controls and surfaces a run ${failure} failure`, async () => {
    await withViewDom(async (dom, domWindow) => {
      const initial = snapshot([]);
      initial.changed = true;
      const client = {
        recoveryState: { status: "none", local: null, candidate: null, corruption: null, persistenceError: null },
        subscribeRecovery() { return () => {}; },
        startRunAll: async () => {
          const error = new Error(`${failure} failed`);
          if (failure === "preparation") throw error;
          return { completed: Promise.reject(error) };
        },
      } as unknown as BrowserNotebookClient;
      const view = new NotebookView(client, dom);
      try {
        view.render(new BrowserDocument(initial));
        dom.getElementById("run-all")!.dispatchEvent(new domWindow.Event("click"));
        await waitUntil(() => dom.getElementById("status")!.textContent!.includes(`${failure} failed`));
        assert.equal(view.runPending, false);
        assert.equal(dom.querySelector<HTMLButtonElement>("#run-all")!.disabled, false);
        assert.equal(dom.querySelector<HTMLButtonElement>("#save")!.disabled, false);
        assert.equal(dom.querySelector<HTMLButtonElement>("#stop")!.disabled, true);
      } finally { view.destroy(); }
    });
  });
}

for (const runControl of ["toolbar", "cell"] as const) {
  test(`view keeps Save and source controls usable during a pending ${runControl} run`, async () => {
    await withViewDom(async (dom, domWindow) => {
      Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { search: "", href: "http://notebook.test/book.R", origin: "http://notebook.test" } });
      const markup = await readFile(new URL("../../inst/app/index.html", import.meta.url), "utf8");
      dom.body.insertAdjacentHTML("beforeend", parseHTML(markup).document.getElementById("cell-tpl")!.outerHTML);
      const directory = await mkdtemp(join(tmpdir(), "alder-view-run-"));
      const evaluation = Promise.withResolvers<EngineResponse>();
      let executing = false;
      let interrupts = 0;
      let savedSource = "";
      const handshake: EngineHandshake = { protocol: "alder-engine-v2", packageVersion: "test", rVersion: "test", capabilities: [], kernelReady: true, analyzerReady: true, captureReady: true };
      const engine: EngineAdapter = {
        start: async () => handshake,
        restart: async () => handshake,
        analyze: async (cells, revision) => ({ revision, analysisEnvironmentId: "analysis-test", analyzer: { packageVersion: "test", rVersion: "test", policy: "test", analysisEnvironmentId: "analysis-test" }, cells: cells.map(value => ({ id: value.id, revision: value.revision, defs: [], refs: [], selfRefs: [], locals: [], barrier: false, opaque: false, diagnostics: [], error: null })) }),
        evaluate: async (payload, onEvent) => {
          executing = true;
          onEvent?.({ type: "started", requestId: 1, sessionEpoch: payload.sessionEpoch, kernelEpoch: payload.kernelEpoch, documentRevision: payload.documentRevision, operationId: payload.operationId, runId: payload.runId, cellId: payload.cellId, revision: payload.revision, sequence: 0 });
          return evaluation.promise;
        },
        request: async () => ({ ok: true }),
        interrupt: async () => { interrupts += 1; evaluation.resolve({ ok: true, stopped: true }); return { requested: true }; },
        close: async () => {},
      };
      const controller = new Controller({ engine, epoch: "epoch-1", outputStore: new OutputStore({ artifactDirectory: directory, sessionEpoch: "epoch-1", documentRevision: 0, kernelEpoch: null }),
        notebook: parseNotebook(new TextEncoder().encode("# %%\nx <- 1\n# %%\ny <- 2\n"), "/tmp/book.R"),
        config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "lazy" } }),
        sourceCommit: async (request, context) => {
          const document = request.document ?? context.document;
          if (request.kind === "save") savedSource = new TextDecoder().decode(serializeNotebook(document));
          context.preparePublication({ ...context, document, dirty: request.kind !== "save", advanceRevision: request.kind !== "save" })();
          return { saved: request.kind === "save" };
        },
      });
      await controller.start();
      const { client, socket } = await browserClient(undefined, controller.snapshot());
      const view = new NotebookView(client, dom);
      const unsubscribe = client.subscribe((document, event, keys) => view.render(document, event, keys));
      const unwatch = controller.subscribe(event => socket.receive({ type: "event", event: encodeHostEventWire(event) }));
      const dispatches = new Set<Promise<unknown>>();
      socket.send = data => {
        socket.sent.push(data);
        const frame = JSON.parse(data);
        if (frame.type !== "command") return;
        const command = decodeHostCommandWire(frame.command) as HostCommand;
        const dispatched = controller.dispatch(command).then(result => socket.receive({ type: "commandResult", requestId: command.requestId, result }));
        dispatches.add(dispatched);
        void dispatched.finally(() => dispatches.delete(dispatched));
      };
      const click = (button: HTMLButtonElement | null) => {
        assert.ok(button);
        assert.equal(button.disabled, false, `${button.textContent} must be usable`);
        button.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
      };
      try {
        view.render(client.document!);
        click(runControl === "toolbar" ? dom.querySelector("#run-all") : dom.querySelector("[data-act=run]"));
        await waitUntil(() => executing && dom.querySelector<HTMLButtonElement>("[data-act=delete]")?.disabled === false);
        assert.equal(view.runPending, true);
        assert.equal(dom.querySelector<HTMLButtonElement>("#run-all")!.disabled, true);
        assert.equal(dom.querySelector<HTMLButtonElement>("[data-act=run]")!.disabled, true);
        for (const selector of ["[data-act=add]", "[data-act=move-down]", "[data-act=delete]", "[data-act=disable]"]) {
          assert.equal(dom.querySelector<HTMLButtonElement>(selector)!.disabled, false, selector);
        }
        const editor = dom.querySelectorAll<HTMLTextAreaElement>("textarea")[1]!;
        editor.value = "y <- 42";
        editor.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
        click(dom.querySelector("#save"));
        await waitUntil(() => savedSource.includes("y <- 42") && dom.querySelector<HTMLButtonElement>("[data-act=add]")?.disabled === false);
        assert.equal(view.runPending, true, "Save finishes before execution does");
        click(dom.querySelector("[data-act=add]"));
        await waitUntil(() => client.document!.cells.length === 3);
        assert.equal(view.runPending, true);
        click(dom.querySelector("#stop"));
        await waitUntil(() => !view.runPending && interrupts > 0);
        assert.equal(dom.querySelector<HTMLButtonElement>("#stop")!.disabled, true);
        assert.equal(dom.querySelector<HTMLButtonElement>("#run-all")!.disabled, false);
        assert.equal(dom.querySelector<HTMLButtonElement>("[data-act=delete]")!.disabled, false);
      } finally {
        evaluation.resolve({ ok: true });
        await Promise.allSettled(dispatches);
        unsubscribe(); unwatch(); view.destroy(); client.close(); await controller.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}

async function installSettingsDom(dom: Document): Promise<void> {
  const markup = parseHTML(await readFile(new URL("../../inst/app/index.html", import.meta.url), "utf8")).document;
  for (const id of ["settings-open", "settings", "runtime-select"]) {
    dom.body.insertAdjacentHTML("beforeend", markup.getElementById(id)!.outerHTML);
  }
}

function settingsClient(overrides: Partial<BrowserNotebookClient> = {}): BrowserNotebookClient {
  return {
    recoveryState: { status: "none", local: null, candidate: null, corruption: null, persistenceError: null },
    subscribeRecovery() { return () => {}; },
    setPreferences: async () => { throw new Error("unexpected application preference write"); },
    setRuntime: async () => { throw new Error("unexpected notebook settings write"); },
    setConfig: async () => { throw new Error("unexpected project settings write"); },
    ...overrides,
  } as unknown as BrowserNotebookClient;
}

test("Settings sends only changed application preferences and preserves the captured version", async () => {
  await withViewDom(async (dom, domWindow) => {
    await installSettingsDom(dom);
    const initial = snapshot([]);
    initial.preferencesVersion = "preferences-before-open";
    const notebook = new BrowserDocument(initial);
    const writes: unknown[] = [];
    const client = settingsClient({ setPreferences: async (patch, version) => {
      writes.push({ patch, version });
      throw new Error("Preferences changed in another notebook. Close and reopen Settings to try again.");
    } });
    const view = new NotebookView(client, dom);
    try {
      view.render(notebook);
      dom.getElementById("settings-open")!.dispatchEvent(new domWindow.Event("click"));
      dom.querySelector<HTMLSelectElement>("#settings-theme")!.value = "dark";
      dom.querySelector<HTMLInputElement>("#settings-font-size")!.value = "18";
      const event: HostEvent = { protocol: HOST_PROTOCOL, epoch: initial.epoch, cursor: 1, version: 2, documentRevision: 0, timestamp: 1,
        type: "notebook", payload: { config: { theme: "light", keymap: "vim" }, preferencesVersion: "preferences-from-peer" } };
      notebook.applyEvent(event);
      view.render(notebook, event);
      assert.equal(dom.documentElement.dataset.theme, "light", "shared preferences apply to the notebook immediately");
      assert.equal(dom.querySelector<HTMLSelectElement>("#settings-theme")!.value, "dark", "open dialog keeps the user's choice");
      assert.equal(notebook.snapshot.preferencesVersion, "preferences-from-peer");
      assert.equal(notebook.snapshot.changed, false, "application changes do not dirty notebook source");
      dom.getElementById("settings-form")!.dispatchEvent(new domWindow.Event("submit", { cancelable: true }));
      await waitUntil(() => Boolean(dom.getElementById("settings-error")!.textContent));
      assert.deepEqual(writes, [{ patch: { theme: "dark", editor: { font_size: 18 } }, version: "preferences-before-open" }]);
      assert.equal(dom.getElementById("settings")!.hasAttribute("open"), true);
      assert.match(dom.getElementById("settings-error")!.textContent!, /Close and reopen Settings/);
      assert.equal(dom.querySelector<HTMLSelectElement>("#settings-theme")!.value, "dark");
      dom.getElementById("settings-cancel")!.dispatchEvent(new domWindow.Event("click"));
      dom.getElementById("settings-open")!.dispatchEvent(new domWindow.Event("click"));
      assert.equal(dom.querySelector<HTMLSelectElement>("#settings-theme")!.value, "light");
      assert.equal(dom.querySelector<HTMLSelectElement>("#settings-keymap")!.value, "vim");
    } finally { view.destroy(); }
  });
});

test("Settings saves only notebook execution choices while R is unavailable", async () => {
  await withViewDom(async (dom, domWindow) => {
    await installSettingsDom(dom);
    const initial = snapshot([]);
    initial.runtime.kernelState = "stopped";
    initial.runtime.executionReady = false;
    initial.runtime.executionBlockedReason = { code: "engine_unavailable", message: "R is not installed" };
    const notebook = new BrowserDocument(initial);
    let writes = 0;
    const client = settingsClient({ setRuntime: async (patch, revision) => {
      writes += 1;
      assert.deepEqual(patch, { executionMode: "lazy", runOnStartup: true, cacheEnabled: false });
      assert.equal(revision, 0);
      notebook.applySnapshot({ ...initial, documentRevision: 1, changed: true,
        config: { cache: { enabled: false } }, runtime: { ...initial.runtime, executionMode: "lazy", runOnStartup: true } });
      view.render(notebook);
      return resultFor("settings-runtime", null);
    } });
    const view = new NotebookView(client, dom);
    try {
      view.render(notebook);
      assert.equal(dom.querySelector<HTMLSelectElement>("#runtime-select")!.disabled, false);
      dom.getElementById("settings-open")!.dispatchEvent(new domWindow.Event("click"));
      dom.querySelector<HTMLSelectElement>("#settings-execution-mode")!.value = "lazy";
      dom.querySelector<HTMLInputElement>("#settings-run-on-startup")!.checked = true;
      dom.querySelector<HTMLInputElement>("#settings-cache-enabled")!.checked = false;
      dom.getElementById("settings-form")!.dispatchEvent(new domWindow.Event("submit", { cancelable: true }));
      await waitUntil(() => !dom.getElementById("settings")!.hasAttribute("open"));
      assert.equal(writes, 1);
      assert.equal(dom.querySelector<HTMLSelectElement>("#runtime-select")!.value, "lazy");
      assert.equal(dom.querySelector<HTMLButtonElement>("#save")!.disabled, false);
      assert.equal(dom.querySelector<HTMLButtonElement>("#run-all")!.disabled, true);
    } finally { view.destroy(); }
  });
});

test("Settings keeps failed project writes and malformed-file errors visible without disabling Save", async () => {
  await withViewDom(async (dom, domWindow) => {
    await installSettingsDom(dom);
    const initial = snapshot([]);
    initial.changed = true;
    initial.sidecars.config = { ...initial.sidecars.config, version: "project-version" };
    initial.serviceErrors.settings = { code: "config_invalid", message: "Fix the YAML in /project/.alder/config.yaml, then try again." };
    const notebook = new BrowserDocument(initial);
    let writes = 0;
    const client = settingsClient({ setConfig: async (patch, version, revision) => {
      writes += 1;
      assert.deepEqual(patch, { cache: { dir: "cache-here" } });
      assert.equal(version, "project-version");
      assert.equal(revision, 0);
      throw new Error("Cannot write /project/.alder/config.yaml. Check its permissions and try again.");
    } });
    const view = new NotebookView(client, dom);
    try {
      view.render(notebook);
      assert.match(dom.getElementById("status")!.textContent!, /Fix the YAML/);
      assert.equal(dom.querySelector<HTMLButtonElement>("#save")!.disabled, false);
      dom.getElementById("settings-open")!.dispatchEvent(new domWindow.Event("click"));
      assert.match(dom.getElementById("settings-error")!.textContent!, /Fix the YAML/);
      dom.querySelector<HTMLInputElement>("#settings-cache-directory")!.value = "cache-here";
      dom.getElementById("settings-form")!.dispatchEvent(new domWindow.Event("submit", { cancelable: true }));
      await waitUntil(() => dom.getElementById("settings-error")!.textContent!.includes("Cannot write"));
      assert.equal(writes, 1);
      assert.equal(dom.getElementById("settings")!.hasAttribute("open"), true);
      assert.equal(dom.querySelector<HTMLInputElement>("#settings-cache-directory")!.value, "cache-here");
      assert.equal(dom.querySelector<HTMLButtonElement>("#settings-apply")!.disabled, false);
      assert.equal(dom.querySelector<HTMLButtonElement>("#save")!.disabled, false);
    } finally { view.destroy(); }
  });
});

test("Settings retries only the owner whose write failed", async () => {
  await withViewDom(async (dom, domWindow) => {
    await installSettingsDom(dom);
    const notebook = new BrowserDocument(snapshot([]));
    let preferenceWrites = 0;
    let projectWrites = 0;
    const client = settingsClient({
      setPreferences: async (patch) => {
        preferenceWrites += 1;
        assert.deepEqual(patch, { theme: "dark" });
        notebook.applySnapshot({ ...notebook.snapshot, config: { theme: "dark" }, preferencesVersion: "saved-preferences" });
        view.render(notebook);
        return resultFor("preferences", null);
      },
      setConfig: async () => {
        projectWrites += 1;
        if (projectWrites === 1) throw new Error("Project settings are not writable.");
        return resultFor("project-settings", null);
      },
    });
    const view = new NotebookView(client, dom);
    try {
      view.render(notebook);
      dom.getElementById("settings-open")!.dispatchEvent(new domWindow.Event("click"));
      dom.querySelector<HTMLSelectElement>("#settings-theme")!.value = "dark";
      dom.querySelector<HTMLInputElement>("#settings-cache-directory")!.value = "cache-here";
      dom.getElementById("settings-form")!.dispatchEvent(new domWindow.Event("submit", { cancelable: true }));
      await waitUntil(() => dom.getElementById("settings-error")!.textContent!.includes("not writable"));
      assert.equal(dom.getElementById("settings")!.hasAttribute("open"), true);
      assert.equal(dom.documentElement.dataset.theme, "dark");
      dom.getElementById("settings-form")!.dispatchEvent(new domWindow.Event("submit", { cancelable: true }));
      await waitUntil(() => !dom.getElementById("settings")!.hasAttribute("open"));
      assert.equal(preferenceWrites, 1);
      assert.equal(projectWrites, 2);
      assert.equal(dom.getElementById("settings-error")!.hidden, true);
    } finally { view.destroy(); }
  });
});

test("format-on-save still saves the notebook when R is unavailable", async () => {
  await withViewDom(async (dom, domWindow) => {
    const initial = snapshot([]);
    initial.changed = true;
    initial.config = { format: { on_save: true } };
    initial.runtime.executionReady = false;
    initial.runtime.kernelState = "stopped";
    let saves = 0;
    const client = settingsClient({
      save: async () => { saves += 1; return resultFor("save", null); },
      formatCells: async () => { throw new Error("Formatting must not block Save without R."); },
    });
    const view = new NotebookView(client, dom);
    try {
      view.render(new BrowserDocument(initial));
      dom.getElementById("save")!.dispatchEvent(new domWindow.Event("click"));
      await waitUntil(() => saves === 1 && dom.querySelector<HTMLButtonElement>("#save")!.disabled === false);
      assert.equal(dom.getElementById("status")!.classList.contains("error"), false);
    } finally { view.destroy(); }
  });
});

test("format-on-save still saves the current draft when Air fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-save-format-failure-"));
  const path = join(directory, "notebook.R");
  const processScope = await createProcessScope();
  try {
    await withViewDom(async (dom, domWindow) => {
      const initial = snapshot([cell("c1", ["current <- 42"])]);
      initial.changed = true;
      initial.config = { format: { on_save: true } };
      const document = new BrowserDocument(initial);
      const formatter = createFormattingService("/usr/bin/false", processScope);
      const formattingDocument = parseNotebook(Buffer.from("# %%\ncurrent <- 42\n", "utf8"));
      const client = settingsClient({
        formatCells: async () => {
          await formatter.formatCells(formattingDocument, [formattingDocument.cells[0]!.id]);
          return resultFor("format", null);
        },
        save: async () => {
          await writeFile(path, document.cells[0]!.desiredBody.join("\n") + "\n", "utf8");
          return resultFor("save", null);
        },
      });
      const view = new NotebookView(client, dom);
      try {
        view.render(document);
        dom.getElementById("save")!.dispatchEvent(new domWindow.Event("click"));
        await waitUntil(() => dom.getElementById("status")!.textContent!.includes("Saved; formatting failed:"));
        assert.equal(await readFile(path, "utf8"), "current <- 42\n");
        assert.match(dom.getElementById("status")!.textContent!, /Saved; formatting failed: air could not format the cell/);
        assert.equal(dom.getElementById("status")!.classList.contains("error"), false);
      } finally { view.destroy(); }
    });
  } finally {
    await processScope.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("notebook execution control restores the stored value after a failed write", async () => {
  await withViewDom(async (dom, domWindow) => {
    await installSettingsDom(dom);
    const initial = snapshot([]);
    initial.runtime.executionReady = false;
    initial.runtime.kernelState = "stopped";
    const view = new NotebookView(settingsClient({ setRuntime: async () => { throw new Error("Notebook changed; try again."); } }), dom);
    try {
      view.render(new BrowserDocument(initial));
      const runtime = dom.querySelector<HTMLSelectElement>("#runtime-select")!;
      runtime.value = "lazy";
      runtime.dispatchEvent(new domWindow.Event("change"));
      await waitUntil(() => dom.getElementById("status")!.textContent!.includes("Notebook changed"));
      assert.equal(runtime.value, "automatic");
      assert.equal(runtime.disabled, false);
    } finally { view.destroy(); }
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
  document.noteSubmitted(command.requestId, { ...command } as HostCommand);
  const editedPhysical = ["# ## Updated", "#   indented", "", "#     ### Nested"];
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1,
    type: "cell", operationId: command.requestId, cellId: "m1", revision: 8, payload: { ...markdownCell, body: editedPhysical, revision: 8 },
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
  document.noteSubmitted(command.requestId, { ...command } as HostCommand);
  document.edit(local.key, ["x <- 3"]);
  document.applyEvent({ protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, documentRevision: 1, timestamp: 1, type: "cell", operationId: command.requestId, cellId: "c1", revision: 1, payload: cell("c1", ["x <- 2"], 1) as never });
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

class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
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
  commands(): HostCommand[] { return this.sent.map(raw => JSON.parse(raw)).filter(frame => frame.type === "command").map(frame => decodeHostCommandWire(frame.command) as HostCommand); }
  reply(command: HostCommand, result: unknown = null, revision = 1): void {
    this.receive({ type: "commandResult", requestId: command.requestId, result: { ...resultFor(command.requestId, result), documentRevision: revision } });
  }
}
function resultFor(id: string, result: unknown, _status = "done", cursor = 1): CommandResult {
  return { requestId: id, epoch: "epoch-1", documentRevision: 1, version: 2, cursor, result: result as never, error: null };
}
function recoverySnapshot(value: HostSnapshot): unknown {
  return { type: "recovery", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, recovery: encodeRecoveryWire({ kind: "snapshot", epoch: value.epoch, cursor: value.cursor, snapshot: value }) };
}
async function browserClient(store = new MemoryRecoveryStore(), initial = snapshot(), options: { reconnect?: boolean; draftId?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new BrowserNotebookClient({ url: "ws://127.0.0.1/api/socket", clientId: "browser-test", draftId: options.draftId ?? "window-1", leaseId: "lease-1", csrf: "csrf-1", reconnect: options.reconnect ?? false,
    reconnectDelayMs: 1, recoveryStore: store, requestAnimationFrame: () => 0,
    webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  const connected = client.connect();
  sockets[0]!.open(); sockets[0]!.receive(recoverySnapshot(initial));
  await connected;
  return { client, socket: sockets[0]!, sockets };
}
const edited = (body: string, revision = 1) => {
  const value = snapshot([cell("c1", [body], revision), cell("c2", ["x + 1"])]);
  value.documentRevision = revision; value.cursor = revision; value.version += revision;
  return value;
};

test("browser sends request identities and reconnects from a snapshot without replaying a lost run", async () => {
  const { client, socket, sockets } = await browserClient(undefined, snapshot(), { reconnect: true });
  try {
    assert.deepEqual(JSON.parse(socket.sent[0]!), { type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: "lease-1", clientId: "browser-test", csrf: "csrf-1" });
    const running = client.runAll();
    await waitUntil(() => socket.commands().length === 1);
    assert.equal(socket.commands()[0]!.type, "run");
    const rejected = assert.rejects(running, { code: "request_uncertain" });
    socket.disconnect(); await rejected;
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    const next = snapshot(); next.epoch = "epoch-replaced";
    sockets[1]!.receive(recoverySnapshot(next));
    await waitUntil(() => client.document?.epoch === "epoch-replaced");
    assert.equal(sockets[1]!.commands().length, 0);
    await assert.rejects(client.transport.dispatch(socket.commands()[0]!), { code: "session_replaced" });
    assert.equal(sockets[1]!.commands().length, 0, "an explicit retry cannot give an old run a new epoch");
  } finally { client.close(); }
});

test("a lost edit response reconciles accepted text while preserving typing made after submission", async () => {
  const { client, socket, sockets } = await browserClient(undefined, snapshot(), { reconnect: true });
  try {
    client.editCell("c1", "x <- 2");
    const committing = client.commitEdits();
    await waitUntil(() => socket.commands().length === 1);
    client.editCell("c1", "x <- 3");
    const rejected = assert.rejects(committing, { code: "request_uncertain" });
    socket.disconnect(); await rejected;
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open(); sockets[1]!.receive(recoverySnapshot(edited("x <- 2")));
    await waitUntil(() => client.document!.snapshot.documentRevision === 1);
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 3"]);
    assert.equal(client.document!.hasSourceConflicts, false);
    assert.equal(sockets[1]!.commands().length, 0);
    const retry = client.commitEdits();
    await waitUntil(() => sockets[1]!.commands().length === 1);
    const command = sockets[1]!.commands()[0]!;
    assert.equal(command.expectedDocumentRevision, 1);
    assert.equal(command.type, "transaction");
    sockets[1]!.reply(command, { edited: [{ id: "c1", revision: 2 }], created: {}, deleted: [] }, 2);
    await retry;
  } finally { client.close(); }
});

test("a lost create response resolves by stable cell ID without creating a duplicate", async () => {
  const document = new BrowserDocument(snapshot());
  const local = document.create("new-cell", "cell:c1", "code", ["y <- 1"]);
  const command = document.buildTransactionCommand("create-request", "client")!;
  document.edit(local.key, ["y <- 2"]);
  const draft = document.recoveryDraft("window", { requestId: command.requestId, kind: "transaction", changes: command.changes })!;
  const current = snapshot([cell("c1", ["x <- 1"]), cell("new-cell", ["y <- 1"]), cell("c2", ["x + 1"])]);
  current.documentRevision = 1;
  const recovered = reconcileDraft(draft, current);
  assert.equal(recovered.conflict, false);
  assert.deepEqual(recovered.draft.changes, [{ type: "edit", cell: { cellId: "new-cell" }, cellType: "code", body: ["y <- 2"], expectedRevision: 0 }]);
});

test("concurrent changed source remains visible as a conflict instead of being overwritten", async () => {
  const { client, socket, sockets } = await browserClient(undefined, snapshot(), { reconnect: true });
  try {
    client.editCell("c1", "local <- 7");
    socket.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open(); sockets[1]!.receive(recoverySnapshot(edited("remote <- 9")));
    await waitUntil(() => client.document!.snapshot.documentRevision === 1);
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["local <- 7"]);
    assert.equal(client.document!.hasSourceConflicts, true);
    await assert.rejects(client.commitEdits(), { code: "source_conflict" });
    assert.equal(sockets[1]!.commands().length, 0);
    client.useServerVersion("c1");
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["remote <- 9"]);
  } finally { client.close(); }
});

test("new backend restores only pending text from an interrupted run draft", async () => {
  const store = new MemoryRecoveryStore();
  const document = new BrowserDocument(snapshot()); document.edit("c1", ["x <- 42"]);
  const draft = document.recoveryDraft("old-window", { requestId: "uncertain-run", kind: "run", changes: document.pendingSource().changes })!;
  await store.saveDraft(draft);
  const next = snapshot(); next.epoch = "new-backend";
  const { client, socket } = await browserClient(store, next, { draftId: "old-window" });
  try {
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 42"]);
    assert.equal(client.document!.hasSourceConflicts, false);
    assert.equal(socket.commands().length, 0);
    await client.flushDraftPersistence();
    const saved = await store.readDraft("old-window");
    assert.equal(saved?.draftId, "old-window");
    assert.equal(saved?.submission, null);
  } finally { client.close(); }
});

test("unsubmitted typing survives renderer close and reload", async () => {
  const store = new MemoryRecoveryStore();
  const first = await browserClient(store, snapshot(), { draftId: "window-reload" });
  first.client.editCell("c1", "typed but not submitted");
  await first.client.close();
  assert.equal(first.socket.commands().length, 0);
  const next = snapshot(); next.epoch = "reloaded-renderer";
  const second = await browserClient(store, next, { draftId: "window-reload" });
  try {
    assert.deepEqual(second.client.document!.cell("c1")!.desiredBody, ["typed but not submitted"]);
    assert.equal(second.client.recoveryState.status, "restored");
  } finally { await second.client.close(); }
});

test("rapid and spaced typing coalesces bounded draft writes with the latest text", async () => {
  const store = new MemoryRecoveryStore();
  const saved: BrowserRecoveryDraft[] = [];
  const saveDraft = store.saveDraft.bind(store);
  store.saveDraft = async draft => { saved.push(structuredClone(draft)); await saveDraft(draft); };
  const { client } = await browserClient(store);
  try {
    await client.flushDraftPersistence();
    saved.length = 0;
    for (let index = 0; index < 6; index += 1) {
      client.editCell("c1", `x <- ${index + 2}`);
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    await waitUntil(() => saved.length > 0);
    await client.flushDraftPersistence();
    assert.ok(saved.length <= 2, `expected at most two coalesced writes, received ${saved.length}`);
    assert.deepEqual(saved.at(-1)?.changes[0]?.type === "edit" ? saved.at(-1)!.changes[0]!.body : null, ["x <- 7"]);
  } finally { await client.close(); }
});

test("authoritative reload waits for the latest renderer draft", async () => {
  const store = new MemoryRecoveryStore();
  let release!: () => void;
  const persisted = new Promise<void>(resolve => { release = resolve; });
  const saveDraft = store.saveDraft.bind(store);
  store.saveDraft = async draft => { await persisted; await saveDraft(draft); };
  const current = snapshot();
  current.disk = { state: "present", digest: "a".repeat(64), version: "version-1", error: null };
  const { client, socket } = await browserClient(store, current);
  try {
    client.editCell("c1", "x <- 8");
    const reloading = client.reloadAuthoritativeRecovery();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(socket.commands().length, 0);
    release();
    await waitUntil(() => socket.commands().length === 1);
    socket.reply(socket.commands()[0]!, { reloaded: true });
    await reloading;
  } finally { await client.close(); }
});

test("source submission waits until the latest renderer draft is durable", async () => {
  const store = new MemoryRecoveryStore();
  let release!: () => void;
  const persisted = new Promise<void>(resolve => { release = resolve; });
  const saveDraft = store.saveDraft.bind(store);
  store.saveDraft = async draft => { await persisted; await saveDraft(draft); };
  const { client, socket } = await browserClient(store);
  try {
    client.editCell("c1", "x <- 2");
    const committed = client.commitEdits();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(socket.commands().length, 0);
    release();
    await waitUntil(() => socket.commands().length === 1);
    socket.reply(socket.commands()[0]!, { edited: [{ id: "c1", revision: 1 }], created: {}, deleted: [] });
    await committed;
  } finally { await client.close(); }
});

test("queued Run cannot hold up newer edits and Save behind an active run", async () => {
  const store = new MemoryRecoveryStore();
  const { client, socket } = await browserClient(store);
  try {
    const firstRun = client.runAll();
    await waitUntil(() => socket.commands().length === 1);
    client.editCell("c1", "x <- 2");
    const queuedRun = client.runAll();
    const rejectedRun = assert.rejects(queuedRun, { code: "source_conflict" });
    await waitUntil(() => socket.commands().length === 2);
    const queued = socket.commands()[1]!;
    assert.equal(queued.type, "run"); assert.equal(queued.changes?.length, 1);
    client.editCell("c1", "x <- 3");
    const saving = client.save();
    await waitUntil(() => socket.commands().length === 3);
    const edit = socket.commands()[2]!;
    assert.equal(edit.type, "transaction"); assert.equal(edit.expectedDocumentRevision, 0);
    socket.reply(edit, { edited: [{ id: "c1", revision: 1 }], created: {}, deleted: [] }, 1);
    await waitUntil(() => socket.commands().length === 4);
    const save = socket.commands()[3]!; assert.equal(save.type, "save");
    socket.reply(save, { saved: true }); await saving;
    socket.receive({ type: "commandResult", requestId: queued.requestId, result: { ...resultFor(queued.requestId, null), error: { code: "source_conflict", message: "The document changed before this run began." } } });
    await rejectedRun;
    await client.flushDraftPersistence();
    assert.ok((await store.readDraft("window-1"))!.pendingRun, "rejecting run2 cannot clear the still-running run1 marker");
    socket.reply(socket.commands()[0]!, { runId: "first" }); await firstRun;
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 3"]);
    assert.equal(client.document!.hasSourceConflicts, false, "rejecting old work cannot mark newer acknowledged edits conflicting");
  } finally { client.close(); }
});

test("a current snapshot during a live run does not turn its known completion into an uncertain run", async () => {
  const store = new MemoryRecoveryStore();
  const { client, socket } = await browserClient(store);
  try {
    const running = client.runAll();
    await waitUntil(() => socket.commands().length === 1);
    const current = snapshot(); current.cursor = 1; current.version = 2;
    socket.receive(recoverySnapshot(current));
    await waitUntil(() => client.document!.snapshot.cursor === 1);
    assert.equal(client.recoveryState.uncertainRun, false);
    socket.reply(socket.commands()[0]!, { runId: "completed" });
    await running;
    await client.flushDraftPersistence();
    assert.equal(client.recoveryState.uncertainRun, false);
    assert.equal(await store.readDraft("window-1"), null);
  } finally { client.close(); }
});

test("an older run result cannot clear a newer in-flight edit's recovery comparison", async () => {
  const { client, socket, sockets } = await browserClient(undefined, snapshot(), { reconnect: true });
  try {
    client.editCell("c1", "x <- 2");
    const running = client.runAll();
    await waitUntil(() => socket.commands().length === 1);
    const run = socket.commands()[0]!;
    client.editCell("c1", "x <- 3");
    const editing = client.commitEdits();
    await waitUntil(() => socket.commands().length === 2);
    socket.receive({ type: "event", event: encodeHostEventWire({ protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2,
      documentRevision: 1, timestamp: 1, type: "transaction", operationId: run.requestId,
      payload: { updated: [cell("c1", ["x <- 2"], 1)], edited: [{ id: "c1", revision: 1 }], created: {}, deleted: [], documentRevision: 1 } as never,
    }) });
    socket.reply(run, { runId: "first" }); await running;
    client.editCell("c1", "x <- 4");
    const rejected = assert.rejects(editing, { code: "request_uncertain" });
    socket.disconnect(); await rejected;
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open(); sockets[1]!.receive(recoverySnapshot(edited("x <- 3", 2)));
    await waitUntil(() => client.document!.snapshot.documentRevision === 2);
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 4"]);
    assert.equal(client.document!.hasSourceConflicts, false);
  } finally { client.close(); }
});

test("Save As carries confirmed destination fingerprint and discard releases the lease", async () => {
  const { client, socket } = await browserClient();
  try {
    const expectedDestination = { expectedDiskDigest: "a".repeat(64), expectedDiskVersion: "old-version" };
    const saving = client.saveAs({ path: "/tmp/replacement.R", expectedDestination });
    await waitUntil(() => socket.commands().length === 1);
    const command = socket.commands()[0]!;
    assert.equal(command.type, "save-as");
    assert.deepEqual(command.expectedDestination, expectedDestination);
    socket.reply(command); await saving;
    await withBrowserFetch(async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { action: "release", leaseId: "lease-1", disposition: "discard" });
      return new Response("{}", { status: 200 });
    }, () => client.discardAndClose());
    assert.equal(socket.readyState, 3);
  } finally { client.close(); }
});

function startupSnapshot(): HostSnapshot {
  const value = snapshot();
  value.runtime.runOnStartup = true;
  value.runtime.rEnvironment = { rscript: "/usr/bin/Rscript", rHome: "/usr/lib/R", version: "4.6.1", platform: "darwin", arch: "arm64", libraryPaths: ["/tmp/library"], identity: "a".repeat(64) };
  return value;
}
const recoveryResponse = () => new Response(JSON.stringify({ epoch: "epoch-1", documentRevision: 0, cursor: 0, result: { candidate: null, corruption: null } }), { status: 200 });

for (const replayRestart of [false, true]) test(`renderer reload suppresses startup after uncertain ${replayRestart ? "restart" : "run"} even without edits`, async () => {
  const store = new MemoryRecoveryStore();
  const first = await browserClient(store);
  try {
    const running = replayRestart ? first.client.restart(true) : first.client.runAll();
    await waitUntil(() => first.socket.commands().length === 1);
    await first.client.flushDraftPersistence();
    const draft = await store.readDraft("window-1");
    assert.equal(draft!.changes.length, 0);
    assert.equal(draft!.pendingRun?.requestId, first.socket.commands()[0]!.requestId);
    const rejected = assert.rejects(running, { code: "request_uncertain" });
    first.socket.disconnect(); await rejected;
    await first.client.flushDraftPersistence();
  } finally { first.client.close(); }
  const next = startupSnapshot(); next.epoch = "replacement-backend";
  await withBrowserFetch(async () => recoveryResponse(), async () => {
    const { client, socket } = await browserClient(store, next, { draftId: "window-1" });
    try {
      assert.equal(client.recoveryState.uncertainRun, true);
      assert.equal(socket.commands().length, 0, "startup never repeats a possibly completed run");
      const explicit = client.runAll();
      await waitUntil(() => socket.commands().length === 1);
      socket.reply(socket.commands()[0]!); await explicit;
      assert.equal(client.recoveryState.uncertainRun, false);
    } finally { client.close(); }
  });
});

test("opening returns while a startup run is still executing", async () => {
  await withBrowserFetch(async () => recoveryResponse(), async () => {
    const { client, socket } = await browserClient(undefined, startupSnapshot());
    try {
      assert.equal(socket.commands().length, 1);
      assert.equal(socket.commands()[0]!.type, "run");
      client.editCell("c1", "editing while startup runs");
      assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["editing while startup runs"]);
      socket.reply(socket.commands()[0]!);
    } finally { client.close(); }
  });
});

test("a renderer only restores its own draft", async () => {
  const store = new MemoryRecoveryStore();
  const document = new BrowserDocument(snapshot()); document.edit("c1", ["other window"]);
  await store.saveDraft(document.recoveryDraft("other-window")!);
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({ url: "ws://notebook.test/api/socket", clientId: "new-window", leaseId: "lease", csrf: "csrf", recoveryStore: store, reconnect: false,
    webSocketFactory: () => socket, requestAnimationFrame: () => 0 });
  try {
    const connected = client.connect(); socket.open(); socket.receive(recoverySnapshot(snapshot())); await connected;
    assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 1"]);
    assert.equal(client.recoveryState.local, null);
    assert.equal((await store.readDraft("other-window"))!.draftId, "other-window");
  } finally { client.close(); }
});

for (const replaced of [false, true]) {
  test(`an awaited snapshot artifact ${replaced ? "cannot overwrite its replacement connection" : "precedes later live events"}`, async () => {
    const { client, socket, sockets } = await browserClient(undefined, snapshot(), { reconnect: true });
    const older = edited("x <- 2");
    const bytes = Buffer.from(JSON.stringify(encodeRecoveryWire({ kind: "snapshot", epoch: older.epoch, cursor: older.cursor, snapshot: older })));
    let finish!: (response: Response) => void;
    let reading = false;
    try {
      await withBrowserFetch(async (_input, init) => {
        if (JSON.parse(String(init?.body)).type !== "output") return recoveryResponse();
        reading = true;
        return new Promise<Response>(resolve => { finish = resolve; });
      }, async () => {
        socket.receive({ type: "recovery", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, recovery: artifactDescriptor({ mimeType: "application/json", byteLength: bytes.length }) });
        await waitUntil(() => reading);
        if (replaced) {
          socket.disconnect();
          await waitUntil(() => sockets.length === 2);
          const newer = edited("x <- 9", 2); newer.epoch = "new-epoch";
          sockets[1]!.open(); sockets[1]!.receive(recoverySnapshot(newer));
          await waitUntil(() => client.document!.epoch === "new-epoch");
        } else {
          socket.receive({ type: "event", event: encodeHostEventWire({ protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 2, version: 3,
            documentRevision: 2, timestamp: 2, type: "cell", cellId: "c1", revision: 2, payload: cell("c1", ["x <- 3"], 2) as never }) });
        }
        finish(new Response(JSON.stringify({ result: { encoding: "base64", offset: 0, nextOffset: bytes.length, eof: true, data: bytes.toString("base64") } })));
        if (replaced) {
          await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(client.document!.epoch, "new-epoch");
          assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 9"]);
        } else {
          await waitUntil(() => client.document!.cursor === 2);
          assert.deepEqual(client.document!.cell("c1")!.desiredBody, ["x <- 3"]);
        }
      });
    } finally { client.close(); }
  });
}

test("LSP mapping preserves native file URIs and excludes delimiter lines", () => {
  assert.equal(encodeFilePathUri("/tmp/café #?%20\\name.R"), "file:///tmp/caf%C3%A9%20%23%3F%2520%5Cname.R");
  assert.equal(encodeFilePathUri("/"), "file:///");
  assert.equal(fileUri("unsaved # %20.R", "/tmp/alder project"), "file:///tmp/alder%20project/unsaved%20%23%20%2520.R");
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
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
