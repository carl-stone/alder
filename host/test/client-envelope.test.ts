import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserTransport, type WebSocketLike } from "../src/browser/transport.js";
import {
  HOST_PROTOCOL,
  ProtocolError,
  SNAPSHOT_ENVELOPE_LIMIT,
  decodeJsonFrame,
  type CommandResult,
  type HostCellState,
  type HostCommand,
  type HostEvent,
  type HostSnapshot,
  type Recovery,
} from "../src/protocol.js";
import { connectRemoteController } from "../src/remote.js";
import { createAlderServer, type ControllerAdapter } from "../src/server.js";

const MIB = 1024 * 1024;

test("browser and remote clients receive a worst-case escaped 32 MiB notebook snapshot", async () => {
  const source = sourceLines(32 * MIB);
  const state = snapshot(source);
  const recovery: Recovery = {
    kind: "snapshot",
    epoch: state.epoch,
    cursor: state.cursor,
    snapshot: state,
  };
  const envelope = JSON.stringify({ type: "recovery", protocolVersion: 1, recovery });
  const envelopeBytes = Buffer.byteLength(envelope);
  assert.ok(envelopeBytes > 64 * MIB, "escaped source must exercise more than twice the old 8 MiB frame cap");
  assert.ok(envelopeBytes < SNAPSHOT_ENVELOPE_LIMIT, "worst-case source must fit the authoritative envelope cap");

  await receiveInBrowser(envelope, source.length);

  const directory = await mkdtemp(join(tmpdir(), "alder-large-envelope-"));
  const controller = new SnapshotController(state);
  const server = createAlderServer({
    controller,
    host: "127.0.0.1",
    port: 0,
    staticDir: directory,
  });
  let remote: Awaited<ReturnType<typeof connectRemoteController>> | undefined;
  try {
    const address = await server.start();
    remote = await connectRemoteController(address.origin);
    await waitUntil(() => remote?.snapshot().cursor === 1);
    const received = remote.snapshot().cells[0]?.body;
    assert.equal(received?.length, source.length);
    assert.equal(received?.[0]?.length, source[0]?.length);
    assert.equal(received?.at(-1)?.length, source.at(-1)?.length);
  } finally {
    await remote?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative frame decoding rejects bytes beyond its selected receive bound", () => {
  assert.throws(
    () => decodeJsonFrame('{"value":"too large"}', 8),
    (error: unknown) => error instanceof ProtocolError && error.code === "frame_too_large",
  );
});

class SnapshotController implements ControllerAdapter {
  private subscribed = true;

  constructor(private readonly state: HostSnapshot) {}

  snapshot(): HostSnapshot { return this.state; }
  recover(): Recovery {
    return { kind: "snapshot", epoch: this.state.epoch, cursor: this.state.cursor, snapshot: this.state };
  }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.subscribed = true;
    queueMicrotask(() => {
      if (!this.subscribed) return;
      listener({
        protocol: HOST_PROTOCOL,
        epoch: this.state.epoch,
        cursor: 1,
        version: this.state.version,
        timestamp: 1,
        type: "runtime",
        payload: this.state.runtime,
      });
    });
    return () => { this.subscribed = false; };
  }
  async dispatch(_command: HostCommand): Promise<CommandResult> {
    throw new Error("large-envelope fixture does not dispatch commands");
  }
}

class FixtureSocket implements WebSocketLike {
  readyState = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send(_data: string): void {}
  close(): void { this.readyState = 3; }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(data: string): void { this.onmessage?.({ data } as MessageEvent); }
}

async function receiveInBrowser(envelope: string, expectedLines: number): Promise<void> {
  const socket = new FixtureSocket();
  let receivedLines = -1;
  const transport = new BrowserTransport({
    url: "ws://127.0.0.1/api/socket",
    reconnect: false,
    webSocketFactory: () => socket,
    onSnapshot: (value) => { receivedLines = value.cells[0]?.body.length ?? -1; },
  });
  const connected = transport.connect().then(() => undefined);
  socket.open();
  socket.receive(envelope);
  await connected;
  assert.equal(receivedLines, expectedLines);
  transport.close();
}

function sourceLines(totalBytes: number): string[] {
  const lineBytes = 512 * 1024;
  const fullLines = Math.floor(totalBytes / lineBytes);
  const newlineBytes = fullLines - 1;
  const contentBytes = totalBytes - newlineBytes;
  const common = "\\".repeat(lineBytes);
  const lines = Array.from({ length: fullLines - 1 }, () => common);
  lines.push("\\".repeat(contentBytes - (fullLines - 1) * lineBytes));
  assert.equal(lines.reduce((total, line) => total + Buffer.byteLength(line), lines.length - 1), totalBytes);
  return lines;
}

function snapshot(body: string[]): HostSnapshot {
  const cell: HostCellState = {
    id: "cell-1",
    type: "code",
    body,
    options: {},
    revision: 0,
    status: "idle",
    outputs: [],
    progress: null,
    log: [],
    error: null,
    defs: [],
    refs: [],
    selfRefs: [],
    locals: [],
    barrier: false,
    opaque: false,
    diagnostics: [],
    analysisPending: false,
  };
  return {
    protocol: HOST_PROTOCOL,
    epoch: "large-envelope-epoch",
    cursor: 0,
    version: 1,
    path: "/tmp/large.R",
    metadata: {},
    config: {},
    layout: null,
    changed: false,
    runtime: {
      executionMode: "automatic",
      runOnStartup: false,
      executionReady: true,
      analyzerAvailable: true,
      kernelAvailable: true,
      packageOperationActive: false,
      busy: false,
      activeRunId: null,
    },
    cells: [cell],
    graph: {
      nodes: [cell.id],
      edges: { [cell.id]: [] },
      reverseEdges: { [cell.id]: [] },
      duplicates: {},
      cycles: [],
      topologicalOrder: [cell.id],
    },
    variables: [],
    editorDiagnostics: {},
    serviceErrors: {},
    operations: [],
    lastValue: null,
    lastActionError: null,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
