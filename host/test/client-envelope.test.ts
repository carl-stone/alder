import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";

import { BrowserTransport, type WebSocketLike } from "../src/browser/transport.js";
import {
  HOST_PROTOCOL,
  HOST_CLIENT_PROTOCOL_VERSION,
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
import { createAlderServer, type ControllerAdapter } from "../src/server.js";
import { OutputStore } from "../src/outputs.js";

const MIB = 1024 * 1024;

test("browser clients receive a worst-case escaped 32 MiB notebook snapshot", async () => {
  const source = sourceLines(32 * MIB);
  const state = snapshot(source);
  const recovery: Recovery = {
    kind: "snapshot",
    epoch: state.epoch,
    cursor: state.cursor,
    snapshot: state,
  };
  const envelope = JSON.stringify({ type: "recovery", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, recovery });
  const envelopeBytes = Buffer.byteLength(envelope);
  assert.ok(envelopeBytes > 64 * MIB, "escaped source must exercise more than twice the old 8 MiB frame cap");
  assert.ok(envelopeBytes < SNAPSHOT_ENVELOPE_LIMIT, "worst-case source must fit the authoritative envelope cap");

  const directory = await mkdtemp(join(tmpdir(), "alder-large-envelope-"));
  const controller = new SnapshotController(state);
  const serverToken = "a".repeat(64);
  const artifactStore = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: state.epoch,
    documentRevision: state.documentRevision,
    kernelEpoch: state.runtime.kernelEpoch ?? null,
  });
  const server = createAlderServer({
    controller,
    host: "127.0.0.1",
    port: 0,
    staticDir: directory,
    artifactStore,
    session: {
      sessionKey: "large-envelope-session", canonicalPath: null, epoch: state.epoch,
      token: serverToken, documentReady: true,
    },
  });
  try {
    const address = await server.start();
    await receiveInBrowser(address.origin, serverToken, source.length);
  } finally {
    await server.close();
    await artifactStore.close();
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

  snapshot(_clientId?: string): HostSnapshot { return this.state; }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.subscribed = true;
    queueMicrotask(() => {
      if (!this.subscribed) return;
      listener({
        protocol: HOST_PROTOCOL,
        epoch: this.state.epoch,
        cursor: 1,
        version: this.state.version,
        documentRevision: this.state.documentRevision,
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

class AuthenticatedSocket implements WebSocketLike {
  private readonly socket: WebSocket;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string, origin: string, host: string, cookie: string) {
    this.socket = new WebSocket(url, { origin, headers: { Cookie: cookie, Host: host } });
    this.socket.on("open", () => this.onopen?.({} as Event));
    this.socket.on("message", data => {
      let value: string | Uint8Array;
      if (typeof data === "string") value = data;
      else if (Buffer.isBuffer(data)) value = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data instanceof ArrayBuffer) value = new Uint8Array(data);
      else {
        const joined = Buffer.concat(data);
        value = new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
      }
      this.onmessage?.({ data: value } as MessageEvent);
    });
    this.socket.on("error", () => this.onerror?.({} as Event));
    this.socket.on("close", (code, reason) => this.onclose?.({ code, reason } as unknown as CloseEvent));
  }

  get readyState(): number { return this.socket.readyState; }
  send(data: string): void { this.socket.send(data); }
  close(): void { this.socket.close(); }
}

async function requestBrowser(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  connectionOrigin: string,
  browserOrigin: string,
  browserHost: string,
): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const rawUrl = request?.url ?? (input instanceof URL ? input.href : String(input));
  const url = new URL(rawUrl, connectionOrigin);
  const headers = new Headers(request?.headers);
  for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
  headers.set("Host", browserHost);
  headers.set("Origin", browserOrigin);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => { requestHeaders[key] = value; });
  const body = typeof init?.body === "string" ? init.body : undefined;
  const method = init?.method ?? request?.method ?? "GET";
  return await new Promise<Response>((resolve, reject) => {
    const pending = httpRequest({
      hostname: "127.0.0.1",
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: requestHeaders,
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    pending.on("error", reject);
    pending.end(body);
  });
}

async function receiveInBrowser(browserOrigin: string, token: string, expectedLines: number): Promise<void> {
  const browser = new URL(browserOrigin);
  const connectionOrigin = "http://127.0.0.1:" + browser.port;
  const browserHost = browser.host;
  const ticketResponse = await requestBrowser(connectionOrigin + "/api/ticket", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ origin: browserOrigin }),
  }, connectionOrigin, browserOrigin, browserHost);
  assert.equal(ticketResponse.ok, true, "browser ticket issuance must succeed");
  const ticketValue = await ticketResponse.json() as { ticket?: unknown };
  assert.equal(typeof ticketValue.ticket, "string");

  const sessionResponse = await requestBrowser(connectionOrigin + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: ticketValue.ticket }),
  }, connectionOrigin, browserOrigin, browserHost);
  assert.equal(sessionResponse.ok, true, "browser session exchange must succeed");
  const session = await sessionResponse.json() as {
    leaseId?: unknown; clientId?: unknown; epoch?: unknown; continuityProof?: unknown; csrf?: unknown;
  };
  assert.equal(typeof session.leaseId, "string");
  assert.equal(typeof session.clientId, "string");
  assert.equal(typeof session.epoch, "string");
  assert.equal(typeof session.continuityProof, "string");
  assert.equal(typeof session.csrf, "string");
  const setCookie = typeof sessionResponse.headers.getSetCookie === "function"
    ? sessionResponse.headers.getSetCookie()[0]
    : sessionResponse.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  assert.ok(cookie, "browser session exchange must set a cookie");

  let receivedLines = -1;
  const transport = new BrowserTransport({
    url: connectionOrigin.replace(/^http/, "ws") + "/api/socket",
    reconnect: false,
    clientId: session.clientId as string,
    leaseId: session.leaseId as string,
    csrf: session.csrf as string,
    continuityProof: session.continuityProof as string,
    webSocketFactory: url => new AuthenticatedSocket(url, browserOrigin, browserHost, cookie),
    onSnapshot: value => { receivedLines = value.cells[0]?.body.length ?? -1; },
  });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", cookie);
    return requestBrowser(input, { ...init, headers }, connectionOrigin, browserOrigin, browserHost);
  }) as typeof fetch;
  try {
    await transport.connect();
  } finally {
    globalThis.fetch = nativeFetch;
  }
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
    diagnostics: [],
    analysisPending: false,
  };
  return {
    protocol: HOST_PROTOCOL,
    epoch: "large-envelope-epoch",
    cursor: 0,
    version: 1,
    documentRevision: 0,
    path: "/tmp/large.R",
    metadata: {},
    config: {},
    layout: null,
    dirty: false,
    changed: false,
    disk: { state: "untitled", digest: null, version: null, error: null },
    sidecars: {
      config: { state: "untitled", digest: null, version: null, error: null },
      layout: { state: "untitled", digest: null, version: null, error: null },
      packages: { state: "untitled", digest: null, version: null, error: null },
    },
    runtime: {
      documentReady: true,
      analyzerState: "ready",
      kernelState: "ready",
      executionReady: true,
      executionBlockedReason: null,
      startupActivated: false,
      kernelEpoch: "large-envelope-kernel",
      rEnvironment: null,
      analysisEnvironmentId: "large-envelope-analysis",
      executionMode: "automatic",
      runOnStartup: false,
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
