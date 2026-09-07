import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BrowserNotebookClient } from "../src/browser/client.js";
import { BrowserDocument } from "../src/browser/document.js";
import { BrowserTransport, BrowserTransportError, type WebSocketLike } from "../src/browser/transport.js";
import { notebookSocketUrl, notebookUrl, notebookViewUrl } from "../src/browser/url.js";
import { defaultRLanguageServerOptions, encodeFilePathUri, fileUri, fromFilePosition, layoutNotebook, LspClient, toFilePosition, translateLspResult, type DiagnosticsByCell, type NotebookDocument } from "../src/lsp.js";
import { connectMcpStdio, createMcpServer, invokeMcpTool, validateMcpMessage, type McpControllerAdapter } from "../src/mcp.js";
import { HOST_PROTOCOL, type CommandResult, type HostCellState, type HostCommand, type HostEvent, type HostSnapshot, type OperationRecord, type Recovery } from "../src/protocol.js";
import { connectRemoteController, remoteSocketTarget } from "../src/remote.js";
import { createAlderServer, type ControllerAdapter } from "../src/server.js";

function cell(id: string, body: string[] = [], revision = 0): HostCellState {
  return {
    id, body, revision, type: "code", options: {}, status: "idle", outputs: [],
    progress: null, log: [], error: null, defs: [], refs: [], selfRefs: [],
    locals: [], barrier: false, opaque: false, diagnostics: [], analysisPending: false,
  };
}

function snapshot(cells: HostCellState[] = [cell("c1", ["x <- 1"]), cell("c2", ["x + 1"])]): HostSnapshot {
  return {
    protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 0, version: 1, path: "/tmp/book.R",
    metadata: {}, config: {}, layout: null, changed: false,
    runtime: {
      executionMode: "automatic", runOnStartup: false, executionReady: true,
      analyzerAvailable: true, kernelAvailable: true, packageOperationActive: false,
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

function operation(id: string, status: OperationRecord["status"] = "done", result?: unknown): OperationRecord {
  return { id, kind: "save", status, acceptedAt: 1, ...(status === "done" ? { settledAt: 2 } : {}), ...(result === undefined ? {} : { result }) };
}

test("browser document sends local edits and optimistic creations atomically with Run", () => {
  const document = new BrowserDocument(snapshot());
  const first = document.cell("c1")!;
  document.focus(first.key);
  document.updateSelection(first.key, { anchor: 3, head: 3, scrollTop: 12 });
  document.edit(first.key, ["x <- 40"]);
  const createdA = document.create("create-a", first.key, "code", ["y <- x + 1"]);
  const createdB = document.create("create-b", createdA.key, "code", ["y + 1"]);
  const command = document.buildRunCommand({
    operationId: "run-1", clientId: "browser-1", scope: "cell", targetKey: createdB.key,
  });
  assert.equal(command.targetCreationId, "create-b");
  assert.deepEqual(command.edits, [{ cellId: "c1", body: ["x <- 40"], cellType: "code", expectedRevision: 0 }]);
  // Both insert after c1 on the wire, so the controller's immediate-after
  // insertion receives the local group in reverse order.
  assert.deepEqual(command.creations.map((value) => value.clientOperationId), ["create-b", "create-a"]);
  document.noteSubmitted(command.operationId, command);
  const identity = createdB;
  document.acknowledge({
    operation: operation("run-1", "accepted"), version: 2, cursor: 1,
    result: {
      edited: [{ id: "c1", revision: 1 }],
      created: [
        { clientOperationId: "create-a", id: "c3", revision: 0 },
        { clientOperationId: "create-b", id: "c4", revision: 0 },
      ],
    },
  });
  assert.strictEqual(document.cell("c4"), identity);
  assert.equal(document.focusedKey, first.key);
  assert.deepEqual(first.selection, { anchor: 3, head: 3, scrollTop: 12 });
  assert.deepEqual(document.cells.map((value) => value.id), ["c1", "c3", "c4", "c2"]);
});

test("browser document applies ordered output deltas without replacing cell identity", () => {
  const previous = { ...cell("c1", ["message('a')"]),
    outputs: [{ kind: "text", text: "previous run" }], outputsStale: true };
  const document = new BrowserDocument(snapshot([previous]));
  const local = document.cell("c1")!;
  const event = (cursor: number, sequence: number, payload: unknown): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, timestamp: cursor,
    type: "cell-output", operationId: "run", runId: "r1", cellId: "c1",
    revision: 0, sequence, payload,
  });
  document.applyEvent(event(1, 1, { kind: "log", payload: { lines: ["a"] } }));
  document.applyEvent(event(2, 2, { kind: "log", payload: { lines: ["ab"], replaceLast: true } }));
  document.applyEvent(event(3, 3, { kind: "log", payload: { lines: ["next"] } }));
  document.applyEvent(event(4, 4, { kind: "append", payload: { output: { kind: "text", text: "1" } } }));
  document.applyEvent(event(4, 4, { kind: "append", payload: { output: { kind: "text", text: "duplicate" } } }));
  assert.strictEqual(document.cell("c1"), local);
  assert.deepEqual(local.server?.log, ["ab", "next"]);
  assert.deepEqual(local.server?.outputs, [{ kind: "text", text: "1" }]);
  assert.equal(local.server?.outputsStale, false);
  assert.equal(document.cursor, 4);
  document.applyEvent(event(5, 5, { kind: "clear", payload: {} }));
  assert.deepEqual(local.server?.log, []);
  assert.deepEqual(local.server?.outputs, []);
  assert.equal(local.server?.progress, null);
  assert.equal(document.cursor, 5);
});

test("browser document retains and restores a local draft after remote deletion", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"]), cell("c2", ["x + 1"])]));
  const local = document.cell("c2")!;
  document.focus(local.key);
  document.updateSelection(local.key, { anchor: 5, head: 5, scrollTop: 24 });
  document.edit(local.key, ["x + 41"]);
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, timestamp: 1,
    type: "notebook", payload: { deleted: "c2", order: ["c1"] },
  });
  assert.strictEqual(document.cell(local.key), local);
  assert.equal(local.tombstone, true);
  assert.deepEqual(local.desiredBody, ["x + 41"]);
  assert.deepEqual(local.selection, { anchor: 5, head: 5, scrollTop: 24 });
  assert.deepEqual(document.pendingSource(), { edits: [], creations: [] });

  // A repeated authoritative deletion event must not discard the retained draft.
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 2, version: 2, timestamp: 2,
    type: "cell", cellId: "c2", payload: { deleted: true },
  });
  assert.strictEqual(document.cell(local.key), local);
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 3, version: 2, timestamp: 3,
    type: "notebook", payload: { saved: true },
  });
  assert.equal(document.snapshot.changed, true, "saving the server source cannot clear an unresolved local draft");
  document.applySnapshot({
    ...snapshot([cell("c1", ["x <- 1"])]), cursor: 4, version: 2, changed: false,
  });
  assert.strictEqual(document.cell(local.key), local);
  assert.equal(local.tombstone, true);
  assert.equal(document.snapshot.changed, true, "snapshot fallback cannot clear a retained deletion draft");

  document.restoreDeleted(local.key, "restore-c2");
  assert.strictEqual(document.cell(local.key), local);
  assert.equal(local.id, null);
  assert.equal(local.tombstone, false);
  assert.deepEqual(document.pendingSource().creations, [{
    clientOperationId: "restore-c2", after: "c1", body: ["x + 41"], cellType: "code", options: {},
  }]);
});

test("snapshot fallback retains an optimistic creation and its dirty state", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const created = document.create("create-local", document.cell("c1")!.key, "code", ["x + 1"]);
  document.applySnapshot({
    ...snapshot([cell("c1", ["x <- 1"])]), cursor: 1, version: 2, changed: false,
  });
  assert.strictEqual(document.cell(created.key), created);
  assert.equal(created.id, null);
  assert.equal(document.snapshot.changed, true);
  assert.equal(document.pendingSource().creations[0]?.clientOperationId, "create-local");
});

test("a replayed creation result merges a snapshot cell into its optimistic identity", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const created = document.create("create-recovered", document.cell("c1")!.key, "code", ["x + 1"]);
  const command = document.buildEditCommand("create-command", "browser-1")!;
  document.noteSubmitted(command.operationId, command);
  document.applySnapshot({
    ...snapshot([cell("c1", ["x <- 1"]), cell("c2", ["x + 1"])]), cursor: 1, version: 2,
  });
  assert.equal(document.cells.filter((candidate) => candidate.id === "c2").length, 1);
  assert.notStrictEqual(document.cell("c2"), created, "causal identity is unknown until the command result returns");
  document.acknowledge({
    operation: operation(command.operationId), version: 2, cursor: 1,
    result: { edited: [], created: [{ clientOperationId: "create-recovered", id: "c2", revision: 0 }] },
  });
  assert.strictEqual(document.cell("c2"), created);
  assert.equal(document.cells.filter((candidate) => candidate.id === "c2").length, 1);
  assert.deepEqual(document.pendingSource(), { edits: [], creations: [] });
});

test("browser document never silently rebases a source conflict", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const local = document.cell("c1")!;
  document.edit(local.key, ["x <- 2"]);
  const command = document.buildEditCommand("edit-conflict", "browser-1")!;
  document.noteSubmitted("edit-conflict", command);
  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, timestamp: 1,
    type: "cell", cellId: "c1", revision: 1, payload: cell("c1", ["x <- 9"], 1),
  });
  document.reject("edit-conflict", "source_conflict");
  document.edit(local.key, ["x <- 10"]);
  assert.equal(local.conflict, true, "continued typing must retain the explicit conflict choice");
  assert.throws(() => document.buildRunCommand({
    operationId: "unsafe-run", clientId: "browser-1", scope: "cell", targetKey: local.key,
  }), /resolve deleted or conflicting local source/);

  document.useServerVersion(local.key);
  assert.equal(local.conflict, false);
  assert.deepEqual(local.desiredBody, ["x <- 9"]);
  assert.deepEqual(document.pendingSource(), { edits: [], creations: [] });
});

test("browser document accepts only its causally identified source event while retaining newer typing", () => {
  const document = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const local = document.cell("c1")!;
  document.edit(local.key, ["x <- 2"]);
  const submitted = document.buildEditCommand("edit-own", "browser-1")!;
  document.noteSubmitted(submitted.operationId, submitted);
  document.edit(local.key, ["x <- 3"]);

  document.applyEvent({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor: 1, version: 2, timestamp: 1,
    type: "cell", operationId: submitted.operationId, cellId: "c1", revision: 1,
    payload: cell("c1", ["x <- 2"], 1),
  });
  assert.equal(local.conflict, false);
  assert.deepEqual(local.serverBody, ["x <- 2"]);
  assert.deepEqual(local.desiredBody, ["x <- 3"]);
  assert.deepEqual(document.pendingSource().edits, [{
    cellId: "c1", body: ["x <- 3"], cellType: "code", expectedRevision: 1,
  }]);

  document.acknowledge({
    operation: operation(submitted.operationId), version: 2, cursor: 1,
    result: { edited: [{ id: "c1", revision: 1 }], created: [] },
  });
  assert.equal(local.conflict, false);
  assert.deepEqual(document.pendingSource().edits, [{
    cellId: "c1", body: ["x <- 3"], cellType: "code", expectedRevision: 1,
  }]);

  const peer = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const peerLocal = peer.cell("c1")!;
  peer.edit(peerLocal.key, ["x <- 2"]);
  const stale = peer.buildEditCommand("edit-stale", "browser-1")!;
  peer.noteSubmitted(stale.operationId, stale);
  peer.edit(peerLocal.key, ["x <- 3"]);
  peer.applyEvent({
    protocol: HOST_PROTOCOL, epoch: peer.epoch, cursor: 1, version: 2, timestamp: 1,
    type: "cell", operationId: "peer-edit", cellId: "c1", revision: 1,
    payload: cell("c1", ["x <- 2"], 1),
  });
  assert.equal(peerLocal.conflict, true, "matching bytes from another operation must not rebase the newer draft");
  peer.reject(stale.operationId, "source_conflict");
  assert.equal(peerLocal.conflict, true);
});

test("epoch recovery replaces authoritative source and preserves a conflicting local draft", () => {
  const clean = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const cleanCell = clean.cell("c1")!;
  clean.applySnapshot({
    ...snapshot([cell("c1", ["x <- 2"])]), epoch: "epoch-2", cursor: 2,
  });
  assert.strictEqual(clean.cell("c1"), cleanCell);
  assert.deepEqual(cleanCell.desiredBody, ["x <- 2"]);
  assert.deepEqual(cleanCell.serverBody, ["x <- 2"]);
  assert.equal(cleanCell.conflict, false);

  const pending = new BrowserDocument(snapshot([cell("c1", ["x <- 1"])]));
  const pendingCell = pending.cell("c1")!;
  pending.edit(pendingCell.key, ["x <- 40"]);
  pending.applySnapshot({
    ...snapshot([cell("c1", ["x <- 2"])]), epoch: "epoch-2", cursor: 2,
  });
  assert.deepEqual(pendingCell.desiredBody, ["x <- 40"]);
  assert.deepEqual(pendingCell.serverBody, ["x <- 2"]);
  assert.equal(pendingCell.conflict, true);
  assert.equal(pending.snapshot.changed, true, "a replacement snapshot cannot clear a retained local draft");
});

test("browser document projects structural and configuration deltas without polling", () => {
  const document = new BrowserDocument(snapshot());
  const event = (cursor: number, type: HostEvent["type"], payload: unknown, cellId?: string): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: document.epoch, cursor, version: cursor + 1, timestamp: cursor, type, payload, ...(cellId ? { cellId } : {}),
  });
  document.applyEvent(event(1, "notebook", {
    created: [{ clientOperationId: "from-peer", id: "c3", revision: 0 }],
    order: ["c1", "c3", "c2"],
  }));
  document.applyEvent(event(2, "cell", cell("c3", ["middle <- TRUE"]), "c3"));
  assert.deepEqual(document.cells.map((value) => value.id), ["c1", "c3", "c2"]);
  assert.deepEqual(document.snapshot.cells.map((value) => value.id), ["c1", "c3", "c2"]);

  document.applyEvent(event(3, "notebook", { moved: "c2", after: null }));
  assert.deepEqual(document.cells.map((value) => value.id), ["c2", "c1", "c3"]);
  document.applyEvent(event(4, "notebook", { config: { theme: "dark" } }));
  assert.deepEqual(document.snapshot.config, { theme: "dark" });
  assert.equal(document.snapshot.changed, true);
  document.applyEvent(event(5, "diagnostics", [{ level: "warning", code: "style", message: "style" }], "c1"));
  assert.equal(document.cell("c1")?.server?.diagnostics[0]?.code, "style");
  document.applyEvent(event(6, "operation", operation("peer-operation")));
  assert.equal(document.snapshot.operations.at(-1)?.id, "peer-operation");
  document.applyEvent(event(7, "notebook", { saved: true }));
  assert.equal(document.snapshot.changed, false);
  document.applyEvent(event(8, "notebook", { layout: { kind: "tabs", children: ["c1", "c2"] } }));
  assert.deepEqual(document.snapshot.layout, { kind: "tabs", children: ["c1", "c2"] });
  assert.equal(document.snapshot.changed, false, "layout is session state and does not dirty notebook source");
  document.applyEvent(event(9, "notebook", { metadata: { execution: "lazy", custom: 1 } }));
  assert.deepEqual(document.snapshot.metadata, { execution: "lazy", custom: 1 });
  assert.equal(document.snapshot.changed, true);
  document.applyEvent(event(10, "variables", [{
    name: "x", owner: "c1", revision: 0, class: "numeric", dim: null,
    size: 56, widget: false, valueSummary: "1",
  }]));
  assert.equal(document.snapshot.variables[0]?.valueSummary, "1");
  document.applyEvent(event(11, "editor-diagnostics", {
    ".document": [{ level: "warning", code: "header", message: "header warning", source: "lsp" }],
  }));
  assert.equal(document.snapshot.editorDiagnostics[".document"]?.[0]?.code, "header");
  assert.equal(document.snapshot.version, 12, "each projected event carries the controller version");
  document.applyEvent(event(12, "service-error", { code: "failed", message: "action failed" }));
  assert.equal(document.snapshot.lastActionError?.code, "failed");
  document.applyEvent(event(13, "service-error", null));
  assert.equal(document.snapshot.lastActionError, null, "the nullable replacement clears an obsolete action error");
  assert.equal(document.snapshot.version, 14);
  document.edit(document.cell("c1")!.key, ["x <- 2"]);
  assert.equal(document.snapshot.changed, true);
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
  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "test disconnect" } as CloseEvent);
  }
}

test("browser transport handshakes before sending sequential commands", async () => {
  const socket = new FakeSocket();
  const events: HostEvent[] = [];
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-test",
    webSocketFactory: () => socket, onEvent: (event) => events.push(event),
    recoveryStore: { load: () => ({ epoch: null, cursor: null }), save: () => {}, clear: () => {} },
  });
  const connected = transport.connect();
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    type: "connect", protocolVersion: 1, clientId: "browser-test", epoch: null, cursor: null,
  });
  socket.receive({ type: "recovery", protocolVersion: 1, recovery: { kind: "snapshot", epoch: "epoch-1", cursor: 0, snapshot: snapshot() } });
  assert.equal((await connected).kind, "snapshot");
  const one = transport.dispatch({ type: "save", operationId: "one", clientId: "browser-test", sessionEpoch: "epoch-1" });
  const two = transport.dispatch({ type: "interrupt", operationId: "two", clientId: "browser-test", sessionEpoch: "epoch-1" });
  assert.deepEqual(socket.sent.slice(1).map((raw) => JSON.parse(raw).sequence), [1, 2]);
  socket.receive({ type: "commandResult", sequence: 1, result: { operation: operation("one"), version: 2, cursor: 1 } });
  socket.receive({ type: "commandResult", sequence: 2, result: { operation: operation("two"), version: 2, cursor: 1 } });
  assert.equal((await one).operation.id, "one");
  assert.equal((await two).operation.id, "two");
  const output = { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 2, version: 2, timestamp: 1, type: "cell-output", cellId: "c1", payload: { kind: "log", payload: "x" } };
  socket.receive({ type: "event", event: output });
  socket.receive({ type: "event", event: output });
  assert.equal(events.length, 1);
  transport.close();
});

test("same-page reconnect keeps its cursor in memory without synchronous storage writes", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let writes = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => { writes += 1; },
      removeItem: () => {},
    },
  });
  const sockets: FakeSocket[] = [];
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket", clientId: "browser-memory-recovery",
    reconnectBaseMs: 1, reconnectMaxMs: 1,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  try {
    const connected = transport.connect();
    sockets[0]!.open();
    sockets[0]!.receive({
      type: "recovery", protocolVersion: 1,
      recovery: { kind: "snapshot", epoch: "epoch-1", cursor: 0, snapshot: snapshot() },
    });
    await connected;
    sockets[0]!.receive({
      type: "event",
      event: { protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2, timestamp: 1, type: "runtime", payload: snapshot().runtime },
    });
    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), {
      type: "connect", protocolVersion: 1, clientId: "browser-memory-recovery", epoch: "epoch-1", cursor: 1,
    });
    assert.equal(writes, 0);
  } finally {
    transport.close();
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an epoch replacement rejects old operation waiters before accepting reused IDs", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const sockets: FakeSocket[] = [];
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", clientId: "browser-epoch-replacement",
    reconnectBaseMs: 1, reconnectMaxMs: 1,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    recoveryStore: { load: () => ({ epoch: null, cursor: null }), save: () => {}, clear: () => {} },
  });
  try {
    const connected = client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({
      type: "recovery", protocolVersion: 1,
      recovery: { kind: "snapshot", epoch: "epoch-1", cursor: 0, snapshot: snapshot() },
    });
    await connected;
    const staleWaiter = assert.rejects(
      client.awaitOperation("shared-operation", 5_000),
      (error: unknown) => error instanceof BrowserTransportError
        && error.code === "session_replaced",
    );

    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    const replacement = {
      ...snapshot(), epoch: "epoch-2", operations: [operation("shared-operation", "done", { epoch: 2 })],
    };
    sockets[1]!.receive({
      type: "recovery", protocolVersion: 1,
      recovery: { kind: "snapshot", epoch: "epoch-2", cursor: 0, snapshot: replacement },
    });
    await staleWaiter;
    const current = await client.awaitOperation("shared-operation", 50);
    assert.deepEqual(current.result, { epoch: 2 });
  } finally {
    client.close();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("gallery browser URLs retain their explicit notebook identity", () => {
  assert.equal(notebookUrl("/api/lsp", "http://127.0.0.1:8899/n/a%20b?view=editor"), "/api/lsp?nb=a+b");
  assert.equal(notebookSocketUrl("https://example.test/n/a%20b"), "wss://example.test/api/socket?nb=a+b");
  assert.equal(notebookViewUrl("app", "http://127.0.0.1:8899/n/a%20b"), "/n/a%20b?nb=a+b&view=app");
  assert.equal(notebookUrl("/plot/a.png", "http://127.0.0.1:8899/?nb=other"), "/plot/a.png?nb=other");
  assert.equal(remoteSocketTarget("https://example.test/n/a%20b?view=app").socketUrl.href,
    "wss://example.test/api/socket?nb=a+b");
  assert.equal(remoteSocketTarget("ws://127.0.0.1:8899/api/socket?nb=other").socketUrl.href,
    "ws://127.0.0.1:8899/api/socket?nb=other");
  assert.throws(() => remoteSocketTarget("http://example.test/n/one?nb=two"), /different notebooks/);
});

test("Run waits for an in-flight source commit before deriving its revision", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket",
    reconnect: false,
    clientId: "browser-race",
    webSocketFactory: () => socket,
    recoveryStore: { load: () => ({ epoch: null, cursor: null }), save: () => {}, clear: () => {} },
    requestAnimationFrame: () => 0,
  });
  const connected = client.connect();
  socket.open();
  socket.receive({ type: "recovery", protocolVersion: 1, recovery: { kind: "snapshot", epoch: "epoch-1", cursor: 0, snapshot: snapshot() } });
  const document = await connected;
  const first = document.cell("c1")!;
  client.editCell(first.key, "x <- 40");
  const localProjections: Array<readonly string[] | undefined> = [];
  client.subscribe((_document, event, keys) => {
    if (!event) localProjections.push(keys);
  });

  const committing = client.commitEdits();
  await waitUntil(() => socket.sent.length === 2);
  const editFrame = JSON.parse(socket.sent[1]!) as { sequence: number; command: Extract<HostCommand, { type: "edit" }> };
  assert.equal(editFrame.command.type, "edit");
  assert.equal(editFrame.command.edits[0]?.expectedRevision, 0);

  const running = client.runCell(first.key, { timeStamp: 10 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.sent.length, 2, "Run must remain behind the unresolved edit acknowledgement");

  socket.receive({
    type: "commandResult",
    sequence: editFrame.sequence,
    result: {
      operation: operation(editFrame.command.operationId), version: 2, cursor: 0,
      result: { edited: [{ id: "c1", revision: 1 }] },
    },
  });
  await committing;
  assert.deepEqual(localProjections, [undefined, [first.key]], "source acknowledgements must update the affected editor");
  await waitUntil(() => socket.sent.length === 3);
  const runFrame = JSON.parse(socket.sent[2]!) as { sequence: number; command: Extract<HostCommand, { type: "run" }> };
  assert.equal(runFrame.command.type, "run");
  assert.equal(runFrame.command.cellId, "c1");
  assert.deepEqual(runFrame.command.edits, [], "Run must not repeat the source revision just acknowledged");

  socket.receive({
    type: "commandResult",
    sequence: runFrame.sequence,
    result: { operation: operation(runFrame.command.operationId, "accepted"), version: 2, cursor: 0 },
  });
  assert.equal((await running).operation.id, runFrame.command.operationId);
  assert.deepEqual(localProjections, [undefined, [first.key]], "unchanged Run acknowledgements must not force local projections");
  client.close();
});

test("interactive deferred requests expose their exact terminal operation", async () => {
  const socket = new FakeSocket();
  const client = new BrowserNotebookClient({
    url: "ws://127.0.0.1/api/socket", reconnect: false, clientId: "browser-deferred",
    webSocketFactory: () => socket,
    recoveryStore: { load: () => ({ epoch: null, cursor: null }), save: () => {}, clear: () => {} },
  });
  const connected = client.connect();
  socket.open();
  socket.receive({ type: "recovery", protocolVersion: 1, recovery: { kind: "snapshot", epoch: "epoch-1", cursor: 0, snapshot: snapshot() } });
  await connected;

  let settled = false;
  const requested = client.requestLazy("lazy-1").then((result) => { settled = true; return result; });
  await waitUntil(() => socket.sent.length === 2);
  const frame = JSON.parse(socket.sent[1]!) as { sequence: number; command: HostCommand };
  socket.receive({
    type: "commandResult", sequence: frame.sequence,
    result: { operation: operation(frame.command.operationId, "accepted"), version: 2, cursor: 0 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "an accepted request must not unlock its control before the kernel settles it");
  socket.receive({
    type: "event",
    event: {
      protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 1, version: 2, timestamp: 1,
      type: "operation", operationId: frame.command.operationId,
      payload: operation(frame.command.operationId, "done", { key: "lazy-1" }),
    },
  });
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
  assert.deepEqual(fromFilePosition(notebook, { line: 6, character: 2 }), { cell: "b", line: 0, character: 2 });
  const uri = "file:///tmp/notebook.R";
  assert.deepEqual(translateLspResult([
    { uri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } },
    { uri: "file:///tmp/other.R", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ], "textDocument/definition", notebook, uri), [{
    uri, range: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 1 } },
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
    }],
  });
  assert.deepEqual(translateLspResult({
    contents: [{ kind: "markdown", value: "### Help" }, { language: "r", value: "x < 2" }],
    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
  }, "textDocument/hover", notebook, uri), {
    contents: [{ kind: "markdown", value: "### Help" }, { language: "r", value: "x < 2" }],
    range: { start: { cell: "a", line: 0, character: 0 }, end: { cell: "a", line: 0, character: 1 } },
  });
  const options = defaultRLanguageServerOptions({ path: "/tmp/alder-project/unsaved.R", cells: [] }, "/opt/R/bin/Rscript");
  assert.equal(options.command, "/opt/R/bin/Rscript");
  assert.equal(options.cwd, "/tmp/alder-project");
  assert.deepEqual(options.args, ["--vanilla", "-e", "languageserver::run()"]);
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
    spawnProcess: (() => process) as unknown as typeof import("node:child_process").spawn,
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
    spawnProcess: (() => process) as unknown as typeof import("node:child_process").spawn,
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
    spawnProcess: (() => process) as unknown as typeof import("node:child_process").spawn,
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

test("LSP client completes a live installed languageserver lifecycle", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-lsp-live-"));
  const path = join(directory, "notebook.R");
  const document = {
    path,
    cells: [{ id: "cell-1", type: "code" as const, body: ["x <- 1", "x"] }],
  };
  await writeFile(path, "# %%\nx <- 1\nx\n");
  const client = new LspClient({
    ...defaultRLanguageServerOptions(document),
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

test("MCP strict framing rejects ambiguous JSON and settled tools expose exact results", async () => {
  assert.throws(() => validateMcpMessage('{"jsonrpc":"2.0","method":"ping","method":"tools/call"}'), /duplicate/i);
  assert.throws(() => validateMcpMessage("[]"), /must be an object/);
  assert.throws(() => validateMcpMessage(`${"[".repeat(65)}0${"]".repeat(65)}`), /nesting/i);
  const state = snapshot();
  let effects = 0;
  const adapter: McpControllerAdapter = {
    snapshot: () => state,
    dispatch: async (command) => {
      effects += 1;
      return { operation: operation(command.operationId, "accepted"), version: 1, cursor: 0 };
    },
    awaitOperation: async (id) => operation(id, "done", { artifact: "out.html", url: "/download/out.html" }),
  };
  const result = await invokeMcpTool(adapter, "export", { format: "html", include_code: true });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    ok: true, operation_id: JSON.parse(result.content[0]!.text).operation_id,
    artifact: "out.html", url: "/download/out.html",
  });
  const invalid = await invokeMcpTool(adapter, "set_widget", { name: "x", value: 1, index: 1 });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0]!.text, /provide exactly one widget update field/);
  assert.equal(effects, 1, "invalid widget arguments must not reach the controller");
});

test("MCP stdio enforces initialization and survives an ambiguous frame", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffered = "";
  output.on("data", (bytes) => {
    buffered += String(bytes);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      messages.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      buffered = buffered.slice(newline + 1);
    }
  });
  let activations = 0;
  let effects = 0;
  const exactSource = "# exact header\r\n# %% code   \r\nx <- 1";
  const state = snapshot();
  const adapter: McpControllerAdapter = {
    snapshot: () => state,
    dispatch: async (command) => {
      effects += 1;
      return {
        operation: operation(command.operationId), version: 1, cursor: 0,
        ...(command.type === "service" && command.command === "source"
          ? { result: { text: exactSource } }
          : {}),
      };
    },
    awaitOperation: async (id) => operation(id),
    activateStartup: async () => { activations += 1; return null; },
  };
  const server = createMcpServer({ controller: adapter });
  const transport = await connectMcpStdio(server, { input, output });
  try {
    input.write("\n \t\r\n");
    input.write('{"jsonrpc":"2.0","id":null,"method":"ping","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":true,"method":"ping","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":9007199254740992,"method":"ping","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
    await waitUntil(() => messages.length === 4);
    assert.deepEqual(messages.slice(0, 3), Array.from({ length: 3 }, () => ({
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC request" },
    })));
    assert.deepEqual(messages[3], { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "server not initialized" } });
    for (const id of [-9007199254740991, 9007199254740991, "", "☃"] as const) {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: {} })}\n`);
    }
    await waitUntil(() => messages.length === 8);
    assert.deepEqual(messages.slice(4).map((message) => message.id), [-9007199254740991, 9007199254740991, "", "☃"]);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } })}\n`);
    await waitUntil(() => messages.some((message) => message.id === 2));
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n');
    await waitUntil(() => activations === 1);
    input.write('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"unknown","arguments":{}}}\n');
    input.write('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"run_all","arguments":[]}}\n');
    for (const expected_revision of [0.5, -1, 2_147_483_648]) {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: {
        name: "edit_cell", arguments: {
          cell: "cell-1", body: ["x <- 999"], type: "code", expected_revision,
        },
      } })}\n`);
    }
    input.write('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"run_all","arguments":{}}}\n');
    input.write('{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}\n');
    await waitUntil(() => messages.some((message) => message.id === 7));
    assert.equal(effects, 1, "only the valid effectful notification may dispatch");
    input.write('{"jsonrpc":"2.0","id":3,"method":"tools/list","method":"tools/call","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":4,"method":"ping","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}\n');
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "resources/read", params: {
      uri: "alder://notebook/source",
    } })}\n`);
    await waitUntil(() => messages.some((message) => message.id === 5)
      && messages.some((message) => message.id === 6));
    const ambiguous = messages.find((message) => message.id === 3)!;
    assert.deepEqual(ambiguous.error, { code: -32600, message: "invalid JSON-RPC request" });
    assert.deepEqual(messages.find((message) => message.id === 4)?.result, {});
    const tools = (messages.find((message) => message.id === 5)?.result as {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, Record<string, unknown>> } }>;
    }).tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "notebook_state", "list_cells", "read_cell", "add_cell", "edit_cell",
      "delete_cell", "move_cell", "rename_cell", "disable_cell", "run_cell",
      "run_all", "run_stale", "interrupt", "get_value", "set_widget", "save",
      "export", "check",
    ]);
    const addSchema = tools.find((tool) => tool.name === "add_cell")!.inputSchema;
    assert.deepEqual(addSchema.properties?.type?.enum, ["code", "markdown"]);
    const editRevision = tools.find((tool) => tool.name === "edit_cell")!.inputSchema.properties?.expected_revision;
    assert.equal(editRevision?.type, "integer");
    assert.equal(editRevision?.minimum, 0);
    assert.equal(editRevision?.maximum, 2_147_483_647);
    assert.deepEqual(messages.find((message) => message.id === 6)?.result, {
      contents: [{ uri: "alder://notebook/source", mimeType: "text/plain", text: exactSource }],
    });
    assert.equal(messages.length, 14, "blank lines and notifications must not emit responses");
    assert.equal(messages.filter((message) => message.id === null).length, 3,
      "each invalid request identifier must receive one null-id error");
  } finally {
    await transport.close();
    input.destroy();
    output.destroy();
  }
});

class FakeController implements ControllerAdapter {
  readonly listeners = new Set<(event: HostEvent) => void>();
  readonly state = snapshot();
  snapshot(): HostSnapshot { return structuredClone(this.state); }
  recover(): Recovery { return { kind: "snapshot", epoch: this.state.epoch, cursor: this.state.cursor, snapshot: this.snapshot() }; }
  subscribe(listener: (event: HostEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async dispatch(command: HostCommand): Promise<CommandResult> {
    const result = { operation: operation(command.operationId), version: ++this.state.version, cursor: this.state.cursor };
    return result;
  }
  operation(id: string): OperationRecord | undefined { return operation(id); }
  async awaitOperation(id: string): Promise<OperationRecord> { return operation(id, "done", { saved: true }); }
}

test("HTTP security boundaries and remote MCP proxy share one WebSocket controller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-adapters-"));
  const staticDir = join(directory, "static");
  const artifacts = join(directory, "artifacts");
  const publicDir = join(directory, "public");
  await mkdir(staticDir);
  await mkdir(artifacts);
  await mkdir(publicDir);
  await writeFile(join(directory, "index.html"), '<meta name="alder-csp-nonce" content="__ALDER_CSP_NONCE__"><script type="module" src="/static/host-app.js"></script>');
  await writeFile(join(staticDir, "host-app.js"), "export {};");
  await writeFile(join(artifacts, "active.html"), "<script>top.fetch('/api/state')</script>");
  await writeFile(join(publicDir, "active.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>top.fetch('/api/state')</script></svg>");
  const controller = new FakeController();
  const counts: number[] = [];
  const server = createAlderServer({ controller, host: "127.0.0.1", port: 0, staticDir, artifactDir: artifacts,
    publicDir, onClientCount: (count) => counts.push(count) });
  let remote: Awaited<ReturnType<typeof connectRemoteController>> | undefined;
  try {
    const address = await server.start();
    const index = await fetch(address.origin);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /<script type="module" src="\/static\/host-app\.js"><\/script>/);
    assert.doesNotMatch(html, /src="\/static\/app\.js"/);
    assert.match(index.headers.get("content-security-policy") ?? "", /script-src/);
    const forbidden = await fetch(`${address.origin}/api/state`, { headers: { Origin: "http://example.test" } });
    assert.equal(forbidden.status, 403);
    const artifact = await fetch(`${address.origin}/plot/active.html`);
    assert.match(artifact.headers.get("content-security-policy") ?? "", /(?:^|; )sandbox allow-scripts(?:;|$)/);
    const publicSvg = await fetch(`${address.origin}/public/active.svg`);
    assert.match(publicSvg.headers.get("content-security-policy") ?? "", /(?:^|; )sandbox allow-scripts(?:;|$)/);
    const waited = await fetch(`${address.origin}/api/operation/wait?operation_id=wait-one`);
    assert.deepEqual(await waited.json(), { ok: true, operation: operation("wait-one", "done", { saved: true }) });
    remote = await connectRemoteController(address.origin);
    assert.equal(remote.snapshot().epoch, controller.state.epoch);
    const result = await remote.dispatch({ type: "save", operationId: "remote-save", sessionEpoch: controller.state.epoch, clientId: "ignored" });
    assert.equal(result.operation.id, "remote-save");
    assert.equal((await remote.awaitOperation("remote-save")).status, "done");
    const obsoleteWait = remote.awaitOperation("old-epoch-operation");
    controller.state.epoch = "epoch-2";
    controller.state.cursor = 0;
    (remote as unknown as { socket: { terminate(): void } | null }).socket?.terminate();
    let staleTimer: NodeJS.Timeout | undefined;
    try {
      await assert.rejects(Promise.race([
        obsoleteWait,
        new Promise<never>((_, reject) => {
          staleTimer = setTimeout(() => reject(new Error("old remote operation waiter was retained")), 1_000);
        }),
      ]), (error: unknown) => error instanceof Error
        && "code" in error && error.code === "session_replaced");
    } finally {
      clearTimeout(staleTimer);
    }
    await waitUntil(() => remote?.snapshot().epoch === "epoch-2");
    assert.deepEqual(counts, [1, 0, 1]);
    await remote.close();
    remote = undefined;
    assert.deepEqual(counts, [1, 0, 1, 0]);
  } finally {
    await remote?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
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
