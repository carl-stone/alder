import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import {
  createAlderServer,
  readJsonBody,
  type ControllerAdapter,
  type McpHttpHandler,
  type AlderServerOptions,
} from "../src/server.js";
import {
  ARTIFACT_RESOLUTION_MEDIA_TYPE,
  HOST_CLIENT_PROTOCOL_VERSION,
  HOST_PROTOCOL,
  encodeArtifactDescriptor,
  artifactHandleSchema,
  hostIdentitySchema,
  type ArtifactHandle,
  type HostEvent,
  type HostSnapshot,
} from "../src/protocol.js";
import { OutputStore } from "../src/outputs.js";
import type { DiagnosticFields, DiagnosticSeverity, DiagnosticSink } from "../src/diagnostics.js";

const TOKEN = "a".repeat(64);
const BODY = new TextEncoder().encode("<html><script>document.body.textContent='ok'</script></html>");

class CollectingDiagnostics implements DiagnosticSink {
  readonly events: Array<{ severity: DiagnosticSeverity; event: string; fields: DiagnosticFields }> = [];
  record(severity: DiagnosticSeverity, event: string, fields: DiagnosticFields = {}): void { this.events.push({ severity, event, fields }); }
  child(_fields: DiagnosticFields): DiagnosticSink { return this; }
}


function commandResult(requestId: string) {
  return { requestId, epoch: "server-test-epoch", documentRevision: 0, version: 0, cursor: 0, result: null, error: null };
}

function makeController(): ControllerAdapter {
  const snapshot = {
    epoch: "server-test-epoch",
    documentRevision: 0,
    cursor: 0,
    capabilities: [],
    cells: [],
  } as unknown as HostSnapshot;
  return {
    snapshot: (_clientId?: string) => snapshot,
    configuration: () => ({ rscript: null, executionMode: "automatic", runOnStartup: false, deferStartup: false }),
    subscribe: () => () => {},
    dispatch: async command => commandResult(command.requestId),
  };
}

async function startFixture(
  mcpHandler?: McpHttpHandler,
  auth: Pick<AlderServerOptions, "externalOrigin" | "externalBearerValidated"> = {},
  controller: ControllerAdapter = makeController(),
  timing: Pick<AlderServerOptions, "leaseExpiryMs" | "leaseSweepIntervalMs" | "onShutdown" | "onLastLeaseDiscard" | "diagnostics" | "flushDiagnostics"> = {},
  recoveryIdentity: { recoveryId: string } | undefined = undefined,
  port = 0,
) {
  const root = await mkdtemp(join(tmpdir(), "alder-server-test-"));
  const staticDir = join(root, "static");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<!doctype html>");
  await writeFile(join(root, "index.html"), "<!doctype html>__ALDER_CSP_NONCE__");
  const store = new OutputStore({
    artifactDirectory: join(root, "artifacts"),
    sessionEpoch: "server-test-epoch",
    documentRevision: 0,
    kernelEpoch: "server-test-kernel",
  });
  const [record] = await store.ingestDisplay({ "text/html": new TextDecoder().decode(BODY) }, {}, {
    sessionEpoch: "server-test-epoch", documentRevision: 0, kernelEpoch: "server-test-kernel",
    runId: "server-test-run", cellId: "server-test-cell", revision: 0,
  });
  const descriptor = artifactHandleSchema.parse(record!.data.artifact);
  const fixture = { store, descriptor, record: record! };
  const server = createAlderServer({
    controller,
    artifactStore: store,
    mcpHandler,
    staticDir,
    session: {
      sessionKey: "server-test-session",
      canonicalPath: null,
      epoch: "server-test-epoch",
      token: TOKEN,
      ...recoveryIdentity,
    },
    port,
    ...auth,
    ...timing,
  });
  const address = await server.start();
  return { server, fixture, origin: address.origin, root };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function bearerHeaders(origin: string, leaseId?: string): Record<string, string> {
  return {
    Authorization: "Bearer " + TOKEN,
    Origin: origin,
    "Content-Type": "application/json",
    ...(leaseId === undefined ? {} : { "X-Alder-Lease-Id": leaseId }),
  };
}

async function attachBearerSession(origin: string): Promise<{ leaseId: string; clientId: string }> {
  const response = await fetch(origin + "/api/lease", {
    method: "POST",
    headers: bearerHeaders(origin),
    body: JSON.stringify({ action: "attach" }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as { leaseId: string; clientId: string };
}

async function attachBearerLease(origin: string): Promise<string> { return (await attachBearerSession(origin)).leaseId; }

async function requestResolution(origin: string, leaseId: string, descriptor: ArtifactHandle, extra: Record<string, string> = {}): Promise<Response> {
  return await fetch(origin + "/api/query", {
    method: "POST",
    headers: {
      ...bearerHeaders(origin, leaseId),
      Accept: ARTIFACT_RESOLUTION_MEDIA_TYPE,
      "x-alder-artifact": encodeArtifactDescriptor(descriptor),
      ...extra,
    },
    body: JSON.stringify({ type: "output", handle: descriptor.handle, offset: 0, limit: descriptor.chunkBytes }),
  });
}
async function requestWithHost(target: string, host: string, extraHeaders: Record<string, string> = {}): Promise<number> {
  const parsed = new URL(target);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { Host: host, Origin: "null", ...extraHeaders },
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("authenticated diagnostic endpoints flush and accept only bounded visible-result records", async () => {
  const diagnostics = new CollectingDiagnostics();
  let flushes = 0;
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {
    diagnostics, flushDiagnostics: async () => { flushes++; },
  });
  try {
    const leaseId = await attachBearerLease(origin);
    const headers = bearerHeaders(origin, leaseId);
    const flushed = await fetch(origin + "/api/diagnostics/flush", { method: "POST", headers });
    assert.equal(flushed.status, 200);
    assert.equal(flushes, 1);
    const visible = await fetch(origin + "/api/diagnostics/phase", {
      method: "POST", headers,
      body: JSON.stringify({ operationId: "operation", runId: "run", cellId: "cell", revision: 2, phase: "visible-result", durationMs: 12.5 }),
    });
    assert.equal(visible.status, 200);
    assert.ok(diagnostics.events.some(item => item.event === "operation.phase" && item.fields.phase === "visible-result" && item.fields.operationId === "operation"));
    const extra = await fetch(origin + "/api/diagnostics/phase", {
      method: "POST", headers,
      body: JSON.stringify({ operationId: "operation", runId: "run", cellId: "cell", revision: 2, phase: "visible-result", durationMs: 12.5, source: "secret" }),
    });
    assert.equal(extra.status, 400);
    const unauthenticated = await fetch(origin + "/api/diagnostics/flush", { method: "POST", headers: { Origin: origin } });
    assert.equal(unauthenticated.status, 403);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
async function fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const logical = new URL(input.toString());
  if (!logical.hostname.endsWith(".localhost")) return globalThis.fetch(input, init);
  const headers = Object.fromEntries(new Headers(init.headers));
  headers.Host = logical.host;
  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(logical.port),
      path: logical.pathname + logical.search,
      method: init.method ?? "GET",
      headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.once("error", reject);
    if (init.body === undefined || init.body === null) request.end();
    else if (typeof init.body === "string" || init.body instanceof Uint8Array) request.end(init.body);
    else reject(new TypeError("loopback test fetch accepts only string or byte bodies"));
  });
}

function loopbackSocketTarget(origin: string): { url: string; host: string } {
  const logical = new URL(origin.replace(/^http/, "ws") + "/api/socket");
  const host = logical.host;
  logical.hostname = "127.0.0.1";
  return { url: logical.href, host };
}

type CookieSession = { leaseId: string; clientId: string; csrf: string; epoch: string; continuityProof: string; cookie: string; recoveryId?: string };

async function createCookieSession(origin: string, parentLeaseId?: string): Promise<CookieSession> {
  const ticketResponse = await fetch(origin + "/api/ticket", {
    method: "POST",
    headers: bearerHeaders(origin, parentLeaseId),
    body: JSON.stringify({ origin, ...(parentLeaseId === undefined ? {} : { parentLeaseId }) }),
  });
  const ticketText = await ticketResponse.text();
  assert.equal(ticketResponse.status, 200, ticketText);
  const ticket = (JSON.parse(ticketText) as { ticket?: unknown }).ticket;
  assert.equal(typeof ticket, "string");
  const sessionResponse = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const sessionText = await sessionResponse.text();
  assert.equal(sessionResponse.status, 200, sessionText);
  const session = JSON.parse(sessionText) as Record<string, unknown>;
  const cookieHeader = typeof sessionResponse.headers.getSetCookie === "function"
    ? sessionResponse.headers.getSetCookie()[0]
    : sessionResponse.headers.get("set-cookie");
  assert.ok(cookieHeader);
  assert.equal(typeof session.leaseId, "string");
  assert.equal(typeof session.clientId, "string");
  assert.equal(typeof session.csrf, "string");
  assert.equal(typeof session.epoch, "string");
  assert.equal(typeof session.continuityProof, "string");
  const cookie = cookieHeader.split(";", 1)[0]!;
  const identityResponse = await fetch(origin + "/api/identity", { headers: { Origin: origin, Cookie: cookie, "X-Alder-CSRF": session.csrf as string } });
  assert.equal(identityResponse.status, 200);
  assert.equal(identityResponse.headers.get("X-Alder-Continuity-Proof"), session.continuityProof);
  const leasedIdentity = hostIdentitySchema.parse(await identityResponse.json());
  assert.equal(leasedIdentity.leaseId, session.leaseId);
  assert.equal(leasedIdentity.clientId, session.clientId);
  assert.equal("nextCommandSequence" in leasedIdentity, false);
  const ownerIdentityResponse = await fetch(origin + "/api/identity", { headers: { Authorization: "Bearer " + TOKEN } });
  assert.equal(ownerIdentityResponse.status, 200);
  const identity = hostIdentitySchema.parse(await ownerIdentityResponse.json());
  assert.equal(identity.documentReady, true);
  assert.equal(identity.continuityProof, session.continuityProof);
  return {
    leaseId: session.leaseId as string,
    clientId: session.clientId as string,
    csrf: session.csrf as string,
    epoch: session.epoch as string,
    continuityProof: session.continuityProof as string,
    ...(typeof session.recoveryId === "string" ? { recoveryId: session.recoveryId } : {}),
    cookie,
  };
}

function decodeSocketMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function waitForSocketMessage(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: RawData): void => {
      try {
        const value = decodeSocketMessage(data);
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("WebSocket closed before expected message")); };
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function openAuthenticatedSocket(origin: string, session: CookieSession): Promise<WebSocket> {
  const socketTarget = loopbackSocketTarget(origin);
  const socket = new WebSocket(socketTarget.url, { origin, headers: { Cookie: session.cookie, Host: socketTarget.host } });
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("WebSocket closed during handshake")); };
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  socket.send(JSON.stringify({
    type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: session.leaseId,
    clientId: session.clientId, csrf: session.csrf,
  }));
  await waitForSocketMessage(socket, value => value.type === "recovery");
  return socket;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref();
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.close();
  });
}

function makeMcpBoundaryHandler(closedLeases: string[], onCloseAll: () => void): McpHttpHandler {
  const handler: McpHttpHandler = async (request, response, auth) => {
    if (request.method === "POST") await readJsonBody(request, 16 * 1024 * 1024);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, method: request.method, auth }));
  };
  handler.closeLease = leaseId => { closedLeases.push(leaseId); };
  handler.closeAll = onCloseAll;
  return handler;
}
test("server uses a fresh localhost origin and rejects the loopback alias", async () => {
  const first = await startFixture();
  const firstPort = Number(new URL(first.origin).port);
  const firstHost = new URL(first.origin).hostname;
  await first.server.close();
  await rm(first.root, { recursive: true, force: true });
  const second = await startFixture(undefined, {}, makeController(), {}, undefined, firstPort);
  try {
    const secondUrl = new URL(second.origin);
    assert.match(secondUrl.hostname, /^[0-9a-f]{32}\.localhost$/);
    assert.notEqual(secondUrl.hostname, firstHost);
    assert.equal(secondUrl.port, String(firstPort));
    assert.equal(await requestWithHost(second.origin, `127.0.0.1:${firstPort}`), 403);
  } finally {
    await second.server.close();
    await rm(second.root, { recursive: true, force: true });
  }
});

test("native numeric bearer can mint a browser ticket", async () => {
  const { server, origin, root } = await startFixture();
  try {
    const address = server.address();
    assert.ok(address);
    const numericOrigin = `http://${address.host}:${address.port}`;
    const response = await fetch(numericOrigin + "/api/ticket", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ origin }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(typeof (JSON.parse(text) as { ticket?: unknown }).ticket, "string");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cookie navigation requires the exact browser authority", async () => {
  const { server, origin, root } = await startFixture();
  try {
    const session = await createCookieSession(origin);
    const navigation = await fetch(origin + "/", { headers: { Cookie: session.cookie } });
    const navigationText = await navigation.text();
    assert.equal(navigation.status, 200, navigationText);

    const address = server.address();
    assert.ok(address);
    const numericOrigin = `http://${address.host}:${address.port}`;
    const numericNavigation = await fetch(numericOrigin + "/", { headers: { Cookie: session.cookie } });
    assert.equal(numericNavigation.status, 403);

    const wrongHost = await requestWithHost(origin, "evil.invalid", { Cookie: session.cookie });
    assert.equal(wrongHost, 403);
    const wrongOrigin = await fetch(origin + "/", { headers: { Cookie: session.cookie, Origin: "http://evil.invalid" } });
    assert.equal(wrongOrigin.status, 403);

    const cookieMutation = await fetch(origin + "/api/lease", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat", leaseId: session.leaseId }),
    });
    assert.equal(cookieMutation.status, 403);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated session exposes a non-secret recovery identity without encryption keys", async () => {
  const recoveryId = "recovered-document";
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {}, { recoveryId });
  try {
    const session = await createCookieSession(origin);
    assert.equal(session.recoveryId, recoveryId);
    assert.equal("recoveryKey" in session, false);
    assert.equal("recoveryKeyId" in session, false);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
test("prevalidated read-once bearer starts an externally published host without rereading a token file", async () => {
  const { server, origin, root } = await startFixture(undefined, {
    externalOrigin: "https://alder.example",
    externalBearerValidated: true,
  });
  try {
    assert.match(new URL(origin).hostname, /^[0-9a-f]{32}\.localhost$/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP HTTP boundary authenticates leases, origins, CSRF, limits, and DELETE", { timeout: 45_000 }, async () => {
  const closedLeases: string[] = [];
  let closeAllCalls = 0;
  const { server, origin, root } = await startFixture(makeMcpBoundaryHandler(closedLeases, () => { closeAllCalls++; }));
  try {
    const unauthenticated = await fetch(origin + "/mcp", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthenticated.status, 403);
    const attach = async (): Promise<{ leaseId: string; clientId: string }> => {
      const response = await fetch(origin + "/api/lease", { method: "POST", headers: bearerHeaders(origin), body: JSON.stringify({ action: "attach" }) });
      const value = await response.json() as { leaseId: string; clientId: string };
      assert.equal(response.status, 200);
      return value;
    };
    const first = await attach();
    const second = await attach();
    const wrongClient = await fetch(origin + "/mcp", { method: "POST", headers: { ...bearerHeaders(origin, first.leaseId), "X-Alder-Client-Id": second.clientId }, body: "{}" });
    assert.equal(wrongClient.status, 403);
    const wrongOrigin = await fetch(origin + "/mcp", { method: "GET", headers: { ...bearerHeaders(origin, first.leaseId), Origin: "http://evil.invalid" } });
    assert.equal(wrongOrigin.status, 403);
    const noOriginHeaders = bearerHeaders(origin, first.leaseId);
    delete noOriginHeaders.Origin;
    const noOrigin = await fetch(origin + "/mcp", { method: "GET", headers: noOriginHeaders });
    assert.equal(noOrigin.status, 200);
    const accepted = await fetch(origin + "/mcp", { method: "POST", headers: bearerHeaders(origin, first.leaseId), body: "{}" });
    assert.equal(accepted.status, 200);
    const acceptedAuth = (await responseJson(accepted)).auth as { kind: string; leaseId: string; clientId: string; csrf: unknown };
    assert.deepEqual({ kind: acceptedAuth.kind, leaseId: acceptedAuth.leaseId, clientId: acceptedAuth.clientId }, { kind: "bearer", leaseId: first.leaseId, clientId: first.clientId });
    assert.equal(typeof acceptedAuth.csrf, "string");
    const deleted = await fetch(origin + "/mcp", { method: "DELETE", headers: bearerHeaders(origin, first.leaseId) });
    assert.equal(deleted.status, 200);
    assert.equal((await responseJson(deleted)).method, "DELETE");
    const released = await fetch(origin + "/api/lease", { method: "POST", headers: bearerHeaders(origin, first.leaseId), body: JSON.stringify({ action: "release", leaseId: first.leaseId }) });
    assert.equal(released.status, 200);
    const afterRelease = await fetch(origin + "/mcp", { method: "GET", headers: bearerHeaders(origin, first.leaseId) });
    assert.equal(afterRelease.status, 403);
    assert.deepEqual(closedLeases, [first.leaseId]);
    const cookieSession = await createCookieSession(origin);
    const cookieHeaders = { Origin: origin, Cookie: cookieSession.cookie, "Content-Type": "application/json" };
    const csrfMissing = await fetch(origin + "/mcp", { method: "POST", headers: cookieHeaders, body: "{}" });
    assert.equal(csrfMissing.status, 403);
    const cookiePost = await fetch(origin + "/mcp", { method: "POST", headers: { ...cookieHeaders, "X-Alder-CSRF": cookieSession.csrf }, body: "{}" });
    assert.equal(cookiePost.status, 403);
    const cookieDeleteMissing = await fetch(origin + "/mcp", { method: "DELETE", headers: cookieHeaders });
    assert.equal(cookieDeleteMissing.status, 403);
    const cookieDelete = await fetch(origin + "/mcp", { method: "DELETE", headers: { ...cookieHeaders, "X-Alder-CSRF": cookieSession.csrf } });
    assert.equal(cookieDelete.status, 403);
    const third = await attach();
    const unsupported = await fetch(origin + "/mcp", { method: "PUT", headers: bearerHeaders(origin, third.leaseId) });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "POST, GET, DELETE");
    const oversized = await fetch(origin + "/mcp", { method: "POST", headers: bearerHeaders(origin, third.leaseId), body: "x".repeat(16 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
  } finally {
    await server.close();
    assert.equal(closeAllCalls, 1);
    await rm(root, { recursive: true, force: true });
  }
});

test("browser lease owns one WebSocket and release revokes it", { timeout: 30_000 }, async () => {
  const { server, origin, root } = await startFixture();
  let socket: WebSocket | undefined;
  try {
    const session = await createCookieSession(origin);
    socket = await openAuthenticatedSocket(origin, session);
    await assert.rejects(openAuthenticatedSocket(origin, session));

    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("released lease WebSocket remained open")), 5_000);
      timer.unref();
      socket!.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const released = await fetch(origin + "/api/lease", {
      method: "POST",
      headers: { Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", leaseId: session.leaseId }),
    });
    assert.equal(released.status, 200, await released.text());
    await closed;
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    if (socket !== undefined) await closeSocket(socket);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("discarding the final browser lease requests host shutdown", { timeout: 30_000 }, async () => {
  let discardCalls = 0;
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {
    onLastLeaseDiscard: async () => { discardCalls += 1; },
  });
  try {
    const session = await createCookieSession(origin);
    const released = await fetch(origin + "/api/lease", {
      method: "POST",
      headers: { Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", leaseId: session.leaseId, disposition: "discard" }),
    });
    assert.equal(released.status, 200, await released.text());
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a confirmed normal bearer release can be escalated once to final discard", { timeout: 5_000 }, async () => {
  let discardCalls = 0;
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {
    onLastLeaseDiscard: () => { discardCalls += 1; },
  });
  try {
    const session = await attachBearerSession(origin);
    const release = (leaseId: string, clientId: string, disposition: "normal" | "discard") => fetch(origin + "/api/lease", {
      method: "POST", headers: { ...bearerHeaders(origin, leaseId), "X-Alder-Client-Id": clientId },
      body: JSON.stringify({ action: "release", leaseId, disposition }),
    });
    const arbitrary = await release(randomUUID(), session.clientId, "discard");
    assert.equal(arbitrary.status, 403);
    assert.equal((await release(session.leaseId, session.clientId, "normal")).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 0);
    assert.equal((await release(session.leaseId, randomUUID(), "discard")).status, 403);
    assert.equal((await release(randomUUID(), session.clientId, "discard")).status, 403);
    assert.equal((await release(session.leaseId, session.clientId, "discard")).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 1);
    assert.equal((await release(session.leaseId, session.clientId, "discard")).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 1);
    assert.equal((await release(session.leaseId, randomUUID(), "discard")).status, 403);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
test("normal-release escalation is consumed without stopping another bearer peer", { timeout: 5_000 }, async () => {
  let discardCalls = 0;
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {
    onLastLeaseDiscard: () => { discardCalls += 1; },
  });
  try {
    const released = await attachBearerSession(origin);
    const peer = await attachBearerSession(origin);
    const release = (session: { leaseId: string; clientId: string }, disposition: "normal" | "discard") => fetch(origin + "/api/lease", {
      method: "POST", headers: { ...bearerHeaders(origin, session.leaseId), "X-Alder-Client-Id": session.clientId },
      body: JSON.stringify({ action: "release", leaseId: session.leaseId, disposition }),
    });
    assert.equal((await release(released, "normal")).status, 200);
    assert.equal((await release(released, "discard")).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 0);
    const heartbeat = await fetch(origin + "/api/lease", {
      method: "POST", headers: { ...bearerHeaders(origin, peer.leaseId), "X-Alder-Client-Id": peer.clientId },
      body: JSON.stringify({ action: "heartbeat", leaseId: peer.leaseId }),
    });
    assert.equal(heartbeat.status, 200);
    assert.equal((await release(peer, "discard")).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discardCalls, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
test("native window reload retires the previous browser lease and final discard closes the document", { timeout: 5_000 }, async () => {
  let discarded = 0;
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {
    onLastLeaseDiscard: () => { discarded += 1; },
  });
  try {
    const parentLeaseId = await attachBearerLease(origin);
    const initial = await createCookieSession(origin, parentLeaseId);
    const reloaded = await createCookieSession(origin, parentLeaseId);
    assert.notEqual(initial.leaseId, reloaded.leaseId);
    const heartbeat = (session: CookieSession) => fetch(origin + "/api/lease", {
      method: "POST", headers: { Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat", leaseId: session.leaseId }),
    });
    assert.equal((await heartbeat(initial)).status, 403);
    assert.equal((await heartbeat(reloaded)).status, 200);
    const released = await fetch(origin + "/api/lease", {
      method: "POST", headers: bearerHeaders(origin, parentLeaseId),
      body: JSON.stringify({ action: "release", leaseId: parentLeaseId, disposition: "discard" }),
    });
    assert.equal(released.status, 200, await released.text());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discarded, 1);
    assert.equal((await heartbeat(reloaded)).status, 403);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("native parent discard revokes only its browser children and keeps an attached agent alive", { timeout: 5_000 }, async () => {
  let discarded = 0;
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), {
    onLastLeaseDiscard: () => { discarded += 1; },
  });
  try {
    const parentLeaseId = await attachBearerLease(origin);
    const agentLeaseId = await attachBearerLease(origin);
    const browser = await createCookieSession(origin, parentLeaseId);
    const unexchanged = await fetch(origin + "/api/ticket", {
      method: "POST", headers: bearerHeaders(origin, parentLeaseId),
      body: JSON.stringify({ origin, parentLeaseId }),
    });
    assert.equal(unexchanged.status, 200);
    const { ticket } = await unexchanged.json() as { ticket: string };
    const release = (leaseId: string) => fetch(origin + "/api/lease", {
      method: "POST", headers: bearerHeaders(origin, leaseId),
      body: JSON.stringify({ action: "release", leaseId, disposition: "discard" }),
    });
    assert.equal((await release(parentLeaseId)).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discarded, 0);
    const revokedBrowser = await fetch(origin + "/api/lease", {
      method: "POST", headers: { Origin: origin, Cookie: browser.cookie, "X-CSRF-Token": browser.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat", leaseId: browser.leaseId }),
    });
    assert.equal(revokedBrowser.status, 403);
    const staleTicket = await fetch(origin + "/api/session", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }),
    });
    assert.equal(staleTicket.status, 403);
    const agentHeartbeat = await fetch(origin + "/api/lease", {
      method: "POST", headers: bearerHeaders(origin, agentLeaseId),
      body: JSON.stringify({ action: "heartbeat", leaseId: agentLeaseId }),
    });
    assert.equal(agentHeartbeat.status, 200);
    assert.equal((await release(agentLeaseId)).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discarded, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("WebSocket command pin survives idle sweep and still honors release", { timeout: 30_000 }, async () => {
  let releaseDispatch: (() => void) | undefined;
  let dispatchStartedResolve!: () => void;
  const dispatchStarted = new Promise<void>(resolve => { dispatchStartedResolve = resolve; });
  const controller: ControllerAdapter = {
    ...makeController(),
    dispatch: async command => {
      dispatchStartedResolve();
      await new Promise<void>(resolve => { releaseDispatch = resolve; });
      return {
        ...commandResult(command.requestId),
      } as never;
    },
  };
  const { server, origin, root } = await startFixture(undefined, {}, controller, {
    leaseExpiryMs: 100,
    leaseSweepIntervalMs: 10,
  });
  let socket: WebSocket | undefined;
  try {
    const session = await createCookieSession(origin);
    socket = await openAuthenticatedSocket(origin, session);
    const closed = new Promise<void>(resolve => { socket!.once("close", () => resolve()); });
    const command = {
      type: "interrupt", requestId: "server-test-operation", clientId: session.clientId, sessionEpoch: session.epoch,
    };
    socket.send(JSON.stringify({ type: "command", requestId: command.requestId, command }));
    await dispatchStarted;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 250);
      timer.unref();
    });
    assert.equal(socket.readyState, WebSocket.OPEN);
    releaseDispatch!();
    const result = await waitForSocketMessage(socket, value => value.type === "commandResult");
    assert.equal(result.requestId, command.requestId);
    const released = await fetch(origin + "/api/lease", {
      method: "POST",
      headers: { Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", leaseId: session.leaseId }),
    });
    assert.equal(released.status, 200, await released.text());
    await closed;
  } finally {
    releaseDispatch?.();
    if (socket !== undefined) await closeSocket(socket);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("command completion follows every preceding document event on the socket", { timeout: 5_000 }, async () => {
  let listener: (event: HostEvent) => void = () => {};
  const controller: ControllerAdapter = { ...makeController(), subscribe: callback => { listener = callback; return () => {}; },
    dispatch: async command => {
      for (let cursor = 1; cursor <= 8; cursor++) listener({ protocol: HOST_PROTOCOL, epoch: "server-test-epoch", cursor,
        version: cursor, documentRevision: 1, timestamp: Date.now(), type: "transaction", payload: {} });
      return { ...commandResult(command.requestId), cursor: 8, version: 8, documentRevision: 1 };
    } };
  const { server, origin, root } = await startFixture(undefined, {}, controller);
  let socket: WebSocket | undefined;
  try {
    const session = await createCookieSession(origin);
    socket = await openAuthenticatedSocket(origin, session);
    const order: string[] = [];
    socket.on("message", data => {
      const value = decodeSocketMessage(data);
      order.push(value.type === "event" ? "event:" + (value.event as HostEvent).cursor : String(value.type));
    });
    const complete = waitForSocketMessage(socket, value => value.type === "commandResult");
    socket.send(JSON.stringify({ type: "command", requestId: "ordered", command: { type: "interrupt", requestId: "ordered",
      clientId: session.clientId, sessionEpoch: session.epoch } }));
    await complete;
    assert.deepEqual(order, [...Array.from({ length: 8 }, (_, i) => "event:" + (i + 1)), "commandResult"]);
  } finally { if (socket) await closeSocket(socket); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("an outstanding WebSocket run does not block Stop or a source edit", { timeout: 5_000 }, async () => {
  let finishRun!: () => void;
  let started!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  const seen: string[] = [];
  const controller: ControllerAdapter = { ...makeController(), dispatch: async command => {
    seen.push(command.type);
    if (command.type === "run") {
      started();
      await new Promise<void>(resolve => { finishRun = resolve; });
    }
    return commandResult(command.requestId);
  } };
  const { server, origin, root } = await startFixture(undefined, {}, controller);
  let socket: WebSocket | undefined;
  try {
    const session = await createCookieSession(origin);
    socket = await openAuthenticatedSocket(origin, session);
    const send = (requestId: string, details: object) => socket!.send(JSON.stringify({ type: "command", requestId,
      command: { requestId, clientId: session.clientId, sessionEpoch: session.epoch, ...details } }));
    send("pending-run", { type: "run", scope: "all", expectedDocumentRevision: 0 });
    await runStarted;
    const interrupted = waitForSocketMessage(socket, value => value.requestId === "stop");
    send("stop", { type: "interrupt" });
    assert.equal((await interrupted).type, "commandResult");
    const edited = waitForSocketMessage(socket, value => value.requestId === "edit");
    send("edit", { type: "transaction", changes: [], expectedDocumentRevision: 0 });
    assert.equal((await edited).type, "commandResult");
    assert.deepEqual(seen, ["run", "interrupt", "transaction"]);
    const finished = waitForSocketMessage(socket, value => value.requestId === "pending-run");
    finishRun();
    assert.equal((await finished).type, "commandResult");
  } finally { finishRun?.(); if (socket) await closeSocket(socket); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("WebSocket shutdown schedules host closure after command response", { timeout: 30_000 }, async () => {
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve; });
  const controller: ControllerAdapter = {
    ...makeController(),
    dispatch: async command => ({
      ...commandResult(command.requestId), result: { closing: true },
    }) as never,
  };
  const { server, origin, root } = await startFixture(undefined, {}, controller, { onShutdown: () => { resolveShutdown(); } });
  let socket: WebSocket | undefined;
  try {
    const session = await createCookieSession(origin);
    socket = await openAuthenticatedSocket(origin, session);
    const command = {
      type: "shutdown", requestId: "server-test-shutdown", clientId: session.clientId, sessionEpoch: session.epoch, expectedDocumentRevision: 0,
      expectedClientIds: [session.clientId],
    };
    socket.send(JSON.stringify({ type: "command", requestId: command.requestId, command }));
    const result = await waitForSocketMessage(socket, value => value.type === "commandResult");
    assert.equal(result.requestId, command.requestId);
    await shutdown;
  } finally {
    if (socket !== undefined) await closeSocket(socket);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("socket preserves ordered cell lifecycle events", { timeout: 30_000 }, async () => {
  const event = (type: HostEvent["type"], cursor: number, payload: unknown): HostEvent => ({
    protocol: HOST_PROTOCOL, epoch: "server-test-epoch", cursor, version: cursor,
    documentRevision: 0, timestamp: cursor, type, cellId: "server-test-cell", payload: payload as never,
  });
  const events = [
    event("cell-started", 1, {}),
    event("cell-output", 2, { text: "first" }),
    event("cell-output", 3, { text: "second" }),
    event("cell-completed", 4, {}),
  ];
  const controller: ControllerAdapter = {
    ...makeController(),
    subscribe: listener => {
      for (const value of events) listener(value);
      return () => {};
    },
  };
  const { server, origin, root } = await startFixture(undefined, {}, controller);
  let socket: WebSocket | undefined;
  try {
    const session = await createCookieSession(origin);
    const socketTarget = loopbackSocketTarget(origin);
    socket = new WebSocket(socketTarget.url, { origin, headers: { Cookie: session.cookie, Host: socketTarget.host } });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onClose = (): void => { cleanup(); reject(new Error("WebSocket closed during handshake")); };
      const cleanup = (): void => {
        socket!.off("open", onOpen);
        socket!.off("error", onError);
        socket!.off("close", onClose);
      };
      socket!.once("open", onOpen);
      socket!.once("error", onError);
      socket!.once("close", onClose);
    });
    const expected = events.map(value => value.type);
    const received = await new Promise<string[]>((resolve, reject) => {
      const values: string[] = [];
      let recoverySeen = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for ordered socket events")); }, 5_000);
      timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        socket!.off("message", onMessage);
        socket!.off("error", onError);
        socket!.off("close", onClose);
      };
      const onMessage = (data: RawData): void => {
        try {
          const value = decodeSocketMessage(data);
          if (value.type === "recovery") recoverySeen = true;
          if (value.type === "event" && typeof value.event === "object" && value.event !== null) {
            const type = (value.event as { type?: unknown }).type;
            if (typeof type === "string") values.push(type);
          }
          if (recoverySeen && values.length === expected.length) {
            cleanup();
            resolve(values);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onClose = (): void => { cleanup(); reject(new Error("WebSocket closed before ordered events")); };
      socket!.on("message", onMessage);
      socket!.once("error", onError);
      socket!.once("close", onClose);
      socket!.send(JSON.stringify({
        type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: session.leaseId,
        clientId: session.clientId, csrf: session.csrf,
      }));
    });
    assert.deepEqual(received, expected);
  } finally {
    if (socket !== undefined) await closeSocket(socket);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("released lease cannot dispatch a partially received command", { timeout: 30_000 }, async () => {
  let dispatchCalls = 0;
  const controller: ControllerAdapter = {
    ...makeController(),
    dispatch: async command => {
      dispatchCalls += 1;
      return {
        ...commandResult(command.requestId),
      } as never;
    },
  };
  const { server, origin, root } = await startFixture(undefined, {}, controller);
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    const session = await createCookieSession(origin);
    const command = {
      type: "interrupt", requestId: "server-test-operation", clientId: session.clientId, sessionEpoch: session.epoch,
    };
    const text = JSON.stringify(command);
    const split = Math.floor(text.length / 2);
    const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(origin + "/api/command");
      const clientRequest = httpRequest({
        hostname: "127.0.0.1", port: Number(parsed.port), path: parsed.pathname, method: "POST",
        headers: {
          Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf,
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request = clientRequest;
      clientRequest.once("error", reject);
      clientRequest.write(text.slice(0, split));
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const released = await fetch(origin + "/api/lease", {
      method: "POST",
      headers: { Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", leaseId: session.leaseId }),
    });
    assert.equal(released.status, 200, await released.text());
    request!.end(text.slice(split));
    const result = await responsePromise;
    assert.equal(result.status, 403, result.body);
    assert.equal(dispatchCalls, 0);
  } finally {
    request?.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("command completion carries execution failures", { timeout: 30_000 }, async () => {
  const controller: ControllerAdapter = {
    ...makeController(),
    dispatch: async command => ({
      ...commandResult(command.requestId), error: { code: "session_not_started", message: "session has not started" },
    }) as never,
  };
  const { server, origin, root } = await startFixture(undefined, {}, controller);
  try {
    const session = await createCookieSession(origin);
    const response = await fetch(origin + "/api/command", {
      method: "POST",
      headers: { Origin: origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "interrupt", requestId: "server-test-operation", clientId: session.clientId, sessionEpoch: session.epoch,
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal((JSON.parse(text) as { error?: { code?: unknown } }).error?.code, "session_not_started");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("artifact resolver issues a descriptor-bound capability and serves opaque-origin resources", { timeout: 30_000 }, async () => {
  const { server, fixture, origin, root } = await startFixture();
  let socket: WebSocket | undefined;
  try {
    const leaseId = await attachBearerLease(origin);
    const resolutionResponse = await requestResolution(origin, leaseId, fixture.descriptor);
    const resolutionText = await resolutionResponse.text();
    assert.equal(resolutionResponse.status, 200, resolutionText);
    assert.equal(resolutionResponse.headers.get("content-type"), ARTIFACT_RESOLUTION_MEDIA_TYPE);
    const resolution = JSON.parse(resolutionText) as { artifact: ArtifactHandle; url: string; expiresAt: number };
    assert.deepEqual(Object.keys(resolution).sort(), ["artifact", "expiresAt", "url"]);
    assert.deepEqual(resolution.artifact, fixture.descriptor);
    assert.ok(Number.isSafeInteger(resolution.expiresAt));
    assert.ok(resolution.expiresAt > Date.now());
    assert.match(resolution.url, /^\/artifacts\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

    const missingDescriptor = await fetch(origin + "/api/query", {
      method: "POST",
      headers: { ...bearerHeaders(origin, leaseId), Accept: ARTIFACT_RESOLUTION_MEDIA_TYPE },
      body: JSON.stringify({ type: "output", handle: fixture.descriptor.handle, offset: 0, limit: fixture.descriptor.chunkBytes }),
    });
    const missingText = await missingDescriptor.text();
    assert.equal(missingDescriptor.status, 400, missingText);
    const missingBody = JSON.parse(missingText) as { error?: { code?: string } };
    assert.equal(missingBody.error?.code, "invalid_request");

    const exactPageResponse = await fetch(origin + "/api/query", {
      method: "POST",
      headers: bearerHeaders(origin, leaseId),
      body: JSON.stringify({ type: "output", handle: fixture.descriptor.handle, offset: 0, limit: BODY.byteLength }),
    });
    const exactPageText = await exactPageResponse.text();
    assert.equal(exactPageResponse.status, 200, exactPageText);
    const exactPage = JSON.parse(exactPageText) as { result: { eof: boolean; nextOffset: number } };
    assert.deepEqual(exactPage.result, { encoding: "base64", offset: 0, nextOffset: BODY.byteLength, eof: true, data: Buffer.from(BODY).toString("base64") });

    const mismatched = await requestResolution(origin, leaseId, { ...fixture.descriptor, byteLength: fixture.descriptor.byteLength + 1 });
    assert.equal(mismatched.status, 409);

    const wrongOrigin = await requestResolution(origin, leaseId, fixture.descriptor, { Origin: "http://evil.invalid" });
    assert.equal(wrongOrigin.status, 403);

    const capabilityUrl = origin + resolution.url;
    const opaque = await fetch(capabilityUrl, { headers: { Origin: "null", Authorization: "Bearer invalid", Cookie: "invalid=ambient" } });
    const opaqueText = await opaque.text();
    assert.equal(opaque.status, 200, opaqueText);
    assert.equal(opaqueText, new TextDecoder().decode(BODY));
    const realCookieSession = await createCookieSession(origin);
    const cookieOpaque = await fetch(capabilityUrl, { headers: { Origin: "null", Cookie: realCookieSession.cookie } });
    const cookieOpaqueText = await cookieOpaque.text();
    assert.equal(cookieOpaque.status, 200, cookieOpaqueText);
    assert.equal(cookieOpaqueText, new TextDecoder().decode(BODY));
    assert.equal(opaque.headers.get("X-Alder-Continuity-Proof"), null);
    assert.equal(cookieOpaque.headers.get("X-Alder-Continuity-Proof"), null);
    assert.equal(opaque.headers.get("access-control-allow-origin"), "null");
    assert.equal(opaque.headers.get("access-control-allow-credentials"), "false");
    const csp = opaque.headers.get("content-security-policy") ?? "";
    assert.match(csp, /sandbox allow-scripts/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, new RegExp("/artifacts/" + resolution.url.split("/")[2] + "/"));

    const wrongResource = await fetch(new URL("other.js", capabilityUrl), { headers: { Origin: "null" } });
    assert.equal(wrongResource.status, 404);
    const queryString = await fetch(capabilityUrl + "?ignored=1", { headers: { Origin: "null" } });
    assert.equal(queryString.status, 404);
    const wrongCap = await fetch(origin + "/artifacts/" + "b".repeat(43) + "/artifact.html", { headers: { Origin: "null" } });
    assert.equal(wrongCap.status, 404);
    const wrongHost = await requestWithHost(capabilityUrl, "evil.invalid");
    assert.equal(wrongHost, 403);

    const socketSession = await createCookieSession(origin);
    socket = await openAuthenticatedSocket(origin, socketSession);
    fixture.store.pin([fixture.descriptor]);
    try {
      fixture.store.discardExact([fixture.record]);
      const revoked = await fetch(capabilityUrl, { headers: { Origin: "null" } });
      assert.equal(revoked.status, 404);
      assert.equal((await revoked.json() as { error?: { code?: string } }).error?.code, "output_expired");
      const revokedResolution = await requestResolution(origin, leaseId, fixture.descriptor);
      assert.equal(revokedResolution.status, 410);
      const ordinaryRange = await fetch(origin + "/api/query", {
        method: "POST",
        headers: bearerHeaders(origin, leaseId),
        body: JSON.stringify({ type: "output", handle: fixture.descriptor.handle, offset: 0, limit: fixture.descriptor.chunkBytes }),
      });
      const ordinaryText = await ordinaryRange.text();
      assert.equal(ordinaryRange.status, 410, ordinaryText);
      assert.ok(socket);
      socket.send(JSON.stringify({ type: "query", query: { type: "output", handle: fixture.descriptor.handle, offset: 0, limit: fixture.descriptor.chunkBytes } }));
      const websocketError = await waitForSocketMessage(socket, value => value.type === "error");
      const error = websocketError.error as Record<string, unknown>;
      assert.equal(error.code, "output_expired");
      assert.deepEqual(await fixture.store.readArtifact(fixture.descriptor, 0, BODY.length), BODY);
    } finally {
      fixture.store.unpin([fixture.descriptor]);
    }

    await server.compromise("server test");
    assert.throws(() => server.retainArtifact(fixture.descriptor), { code: "session_stopped" });
  } finally {
    if (socket !== undefined) await closeSocket(socket);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("active document MIME resources receive child sandbox policy", { timeout: 30_000 }, async () => {
  const { server, fixture, origin, root } = await startFixture();
  const scope = {
    sessionEpoch: "server-test-epoch", documentRevision: 0, kernelEpoch: null,
    runId: null, cellId: null, revision: null,
  };
  try {
    const leaseId = await attachBearerLease(origin);
    for (const [mimeType, extension] of [["application/xhtml+xml", ".xhtml"], ["application/xml", ".xml"], ["application/atom+xml", ".atom"]] as const) {
      const descriptor = server.retainArtifact(await fixture.store.writeArtifact(new TextEncoder().encode("<?xml version=\"1.0\"?><root/>"), mimeType, extension, scope));
      const resolutionResponse = await requestResolution(origin, leaseId, descriptor);
      const resolutionText = await resolutionResponse.text();
      assert.equal(resolutionResponse.status, 200, resolutionText);
      const resolution = JSON.parse(resolutionText) as { url: string };
      const resource = await fetch(origin + resolution.url, { headers: { Origin: "null" } });
      const resourceText = await resource.text();
      assert.equal(resource.status, 200, resourceText);
      assert.equal(resource.headers.get("content-type"), mimeType);
      assert.match(resource.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
    }

    const pdf = server.retainArtifact(await fixture.store.writeArtifact(Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]), "application/pdf", ".pdf", scope));
    const pdfResolutionResponse = await requestResolution(origin, leaseId, pdf);
    const pdfResolutionText = await pdfResolutionResponse.text();
    assert.equal(pdfResolutionResponse.status, 200, pdfResolutionText);
    const pdfResolution = JSON.parse(pdfResolutionText) as { url: string };
    const pdfResponse = await fetch(origin + pdfResolution.url, { headers: { Origin: "null" } });
    assert.equal(pdfResponse.status, 200, await pdfResponse.text());
    assert.equal(pdfResponse.headers.get("content-security-policy"), null);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("negotiated resolver enforces cookie CSRF after exact-origin validation", { timeout: 30_000 }, async () => {
  const { server, fixture, origin, root } = await startFixture();
  try {
    const ticketResponse = await fetch(origin + "/api/ticket", {
      method: "POST",
      headers: bearerHeaders(origin),
      body: JSON.stringify({ origin }),
    });
    const ticketText = await ticketResponse.text();
    assert.equal(ticketResponse.status, 200, ticketText);
    const ticket = (JSON.parse(ticketText) as { ticket?: unknown }).ticket as string;
    const sessionResponse = await fetch(origin + "/api/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    const sessionText = await sessionResponse.text();
    assert.equal(sessionResponse.status, 200, sessionText);
    const session = JSON.parse(sessionText) as Record<string, unknown>;
    const setCookie = sessionResponse.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = setCookie.split(";", 1)[0]!;
    const leaseId = session.leaseId as string;
    const csrf = session.csrf as string;
    const missingCsrf = await fetch(origin + "/api/query", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-Alder-Lease-Id": leaseId,
        Accept: ARTIFACT_RESOLUTION_MEDIA_TYPE,
        "x-alder-artifact": encodeArtifactDescriptor(fixture.descriptor),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "output", handle: fixture.descriptor.handle, offset: 0, limit: fixture.descriptor.chunkBytes }),
    });
    const missingCsrfText = await missingCsrf.text();
    assert.equal(missingCsrf.status, 403, missingCsrfText);

    const validCsrf = await fetch(origin + "/api/query", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-Alder-Lease-Id": leaseId,
        "X-CSRF-Token": csrf,
        Accept: ARTIFACT_RESOLUTION_MEDIA_TYPE,
        "x-alder-artifact": encodeArtifactDescriptor(fixture.descriptor),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "output", handle: fixture.descriptor.handle, offset: 0, limit: fixture.descriptor.chunkBytes }),
    });
    const validText = await validCsrf.text();
    assert.equal(validCsrf.status, 200, validText);
    assert.equal(validCsrf.headers.get("content-type"), ARTIFACT_RESOLUTION_MEDIA_TYPE);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("capability resolution cannot renew a published result's read lease", { timeout: 30_000 }, async (context) => {
  const { server, fixture, origin, root } = await startFixture();
  let reader: ReturnType<OutputStore["openArtifactResource"]> | undefined;
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  try {
    const publication = server.retainArtifact(await fixture.store.writeArtifact(BODY, "text/html", ".html", {
      sessionEpoch: "server-test-epoch", documentRevision: 0, kernelEpoch: null,
      runId: null, cellId: null, revision: null,
    }));
    const leaseId = await attachBearerLease(origin);
    const response = await requestResolution(origin, leaseId, publication);
    assert.equal(response.status, 200);
    const resolution = await response.json() as { url: string; expiresAt: number };
    reader = fixture.store.openArtifactResource(publication);

    now = resolution.expiresAt - 1;
    const renewedSession = await attachBearerLease(origin);
    const repeatedResolution = await requestResolution(origin, renewedSession, publication);
    assert.equal(repeatedResolution.status, 200);
    await repeatedResolution.arrayBuffer();

    now = resolution.expiresAt;
    const expired = await fetch(origin + resolution.url, { headers: { Origin: "null" } });
    assert.equal(expired.status, 404);
    const currentSession = await attachBearerLease(origin);
    const noRenewal = await requestResolution(origin, currentSession, publication);
    assert.equal(noRenewal.status, 410);
    assert.deepEqual(await reader.read(0, BODY.length), BODY);
  } finally {
    reader?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("output queries reject malformed identifiers before artifact storage access", async () => {
  const diagnostics = new CollectingDiagnostics();
  const { server, origin, root } = await startFixture(undefined, {}, makeController(), { diagnostics });
  try {
    const leaseId = await attachBearerLease(origin);
    for (const handle of ["../manifest.json", "é".repeat(65)]) {
      const response = await fetch(origin + "/api/query", {
        method: "POST", headers: bearerHeaders(origin, leaseId),
        body: JSON.stringify({ type: "output", handle, offset: 0, limit: 1 }),
      });
      assert.equal(response.status, 400);
      const failure = await response.json() as { error: { code: string } };
      assert.equal(failure.error.code, "invalid_request");
    }
    const unknown = await fetch(origin + "/api/query", {
      method: "POST", headers: bearerHeaders(origin, leaseId),
      body: JSON.stringify({ type: "output", handle: "é".repeat(64), offset: 0, limit: 1 }),
    });
    assert.equal(unknown.status, 404);
    assert.ok(diagnostics.events.some(item => item.event === "boundary.rejected" && item.fields.kind === "query"
      && item.fields.errorCode === "invalid_request" && item.fields.status === 400));
    assert.ok(diagnostics.events.some(item => item.event === "boundary.rejected" && item.fields.kind === "query"
      && item.fields.status === 404 && typeof item.fields.bytes === "number"));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
