import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest, type ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer, type AlderMcpOptions, type McpControllerAdapter } from "./mcp-catalog.js";
import { MAX_MCP_REQUEST_BYTES, ProtocolError, decodeJsonFrame } from "./protocol.js";
import type { ArtifactStoreBinding, AuthContext, McpHttpHandler } from "./server.js";
import type { DiagnosticSink } from "./diagnostics.js";

export { createMcpServer } from "./mcp-catalog.js";
export type { AlderMcpOptions, McpControllerAdapter } from "./mcp-catalog.js";

export const MCP_MAX_MESSAGE_BYTES = MAX_MCP_REQUEST_BYTES;

export interface McpHttpOptions {
  readonly controller: McpControllerAdapter;
  readonly artifactStore: ArtifactStoreBinding;
  readonly version?: string;
  readonly capabilities?: ServerCapabilities;
  readonly commandTimeoutMs?: number;
  readonly startup?: AlderMcpOptions["startup"];
  readonly runtimeReady?: AlderMcpOptions["runtimeReady"];
  readonly onShutdown?: AlderMcpOptions["onShutdown"];
  readonly diagnostics?: DiagnosticSink;
}

interface HttpSession {
  readonly leaseId: string;
  readonly clientId: string;
  readonly authKind: AuthContext["kind"];
  readonly assertActive?: () => void;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly authToken: string;
  readonly closed: Promise<void>;
  closeStarted: boolean;
  connectPromise?: Promise<void>;
  resolveClosed: () => void;
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Create the authenticated Streamable HTTP endpoint for one host incarnation.
 * Every SDK session owns one McpServer/transport pair but shares the supplied
 * authoritative Controller and output store.
 */
export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  options.diagnostics?.record("info", "mcp.endpoint.ready", {});
  const sessions = new Map<string, HttpSession>();
  const allSessions = new Set<HttpSession>();
  const initializingLeases = new Set<string>();
  const activeBodies = new Map<IncomingMessage, string>();
  const closedLeases = new Map<string, number>();
  const leaseClosed = (leaseId: string): boolean => {
    const expiresAt = closedLeases.get(leaseId);
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    closedLeases.delete(leaseId);
    return false;
  };
  const rememberClosedLease = (leaseId: string): void => {
    closedLeases.delete(leaseId);
    while (closedLeases.size >= 4_096) closedLeases.delete(closedLeases.keys().next().value!);
    closedLeases.set(leaseId, Date.now() + 5 * 60_000);
  };
  let closing = false;
  const rejectRevoked = (response: ServerResponse, leaseId: string): boolean => {
    if (!closing && !leaseClosed(leaseId)) return false;
    if (!response.writableEnded && !response.destroyed) {
      jsonRpcError(response, 410, -32001, closing ? "MCP endpoint is closing" : "The host lease is closed");
    }
    return true;
  };
  const abortBodies = (leaseId?: string): void => {
    for (const [request, owner] of activeBodies) {
      if (leaseId !== undefined && owner !== leaseId) continue;
      activeBodies.delete(request);
      request.destroy();
      request.resume();
    }
  };

  const dispose = async (session: HttpSession): Promise<void> => {
    if (session.closeStarted) return session.closed;
    session.closeStarted = true;
    const sessionId = session.transport.sessionId;
    if (sessionId !== undefined && sessions.get(sessionId) === session) sessions.delete(sessionId);
    allSessions.delete(session);
    try {
      await session.connectPromise?.catch(() => undefined);
      await session.server.close().catch(() => undefined);
    } finally {
      options.diagnostics?.record("info", "mcp.session.closed", { clientId: session.clientId, outcome: "success" });
      session.resolveClosed();
    }
    return session.closed;
  };

  const handler: McpHttpHandler = async (request: IncomingMessage, response: ServerResponse, auth: AuthContext): Promise<void> => {
    if (closing) {
      jsonRpcError(response, 410, -32001, "MCP endpoint is closing");
      return;
    }
    if (auth.leaseId === null || auth.clientId === null) {
      jsonRpcError(response, 403, -32001, "An active host lease is required");
      return;
    }
    if (leaseClosed(auth.leaseId)) {
      jsonRpcError(response, 410, -32001, "The host lease is closed");
      return;
    }

    let parsedBody: unknown;
    if (request.method === "POST") {
      activeBodies.set(request, auth.leaseId);
      try {
        parsedBody = await readBoundedJson(request);
      } catch (error) {
        const bodyError = error instanceof RequestBodyError
          ? error
          : new RequestBodyError(400, -32700, "Invalid JSON request body");
        if (!response.writableEnded && !response.destroyed) jsonRpcError(response, bodyError.status, bodyError.rpcCode, bodyError.message);
        return;
      } finally {
        activeBodies.delete(request);
      }
    }

    if (rejectRevoked(response, auth.leaseId)) return;
    auth.assertActive?.();

    let requestedSessionId: string | null;
    try {
      requestedSessionId = oneHeader(request.headers["mcp-session-id"], "MCP-Session-Id");
    } catch (error) {
      jsonRpcError(response, 400, -32600, error instanceof Error ? error.message : "Invalid MCP-Session-Id");
      return;
    }
    let session: HttpSession | undefined;
    let initializingLease = false;
    if (requestedSessionId !== null) {
      session = sessions.get(requestedSessionId);
      if (session === undefined || session.closeStarted) {
        jsonRpcError(response, 404, -32001, "MCP session not found");
        return;
      }
      if (session.leaseId !== auth.leaseId || session.clientId !== auth.clientId || session.authKind !== auth.kind) {
        jsonRpcError(response, 403, -32001, "MCP session belongs to another authenticated lease");
        return;
      }
    } else {
      if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
        jsonRpcError(response, 400, -32000, "A valid MCP session ID or initialize request is required");
        return;
      }
      if (initializingLeases.has(auth.leaseId) || [...allSessions].some(candidate => !candidate.closeStarted && candidate.leaseId === auth.leaseId)) {
        jsonRpcError(response, 409, -32000, "The authenticated lease already owns an MCP session");
        return;
      }
      initializingLeases.add(auth.leaseId);
      initializingLease = true;
      try {
        session = await makeSession(options, { ...auth, leaseId: auth.leaseId, clientId: auth.clientId }, sessions, allSessions, dispose);
      } catch (error) {
        options.diagnostics?.record("error", "mcp.session.error", {
          clientId: auth.clientId, outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? "mcp_initialize_failed",
        });
        initializingLeases.delete(auth.leaseId);
        jsonRpcError(response, 500, -32603, "Internal MCP error");
        return;
      }
      if (closing || leaseClosed(auth.leaseId) || session.closeStarted) {
        await dispose(session);
        if (!response.writableEnded && !response.destroyed) {
          jsonRpcError(response, 410, -32001, closing ? "MCP endpoint is closing" : "The host lease is closed");
        }
        initializingLeases.delete(auth.leaseId);
        return;
      }
    }

    if (closing || leaseClosed(auth.leaseId) || session.closeStarted) {
      await dispose(session);
      if (!response.writableEnded && !response.destroyed) {
        jsonRpcError(response, 410, -32001, closing ? "MCP endpoint is closing" : "The host lease is closed");
      }
      if (initializingLease) initializingLeases.delete(auth.leaseId);
      return;
    }
    auth.assertActive?.();

    const authenticated = request as IncomingMessage & { auth?: AuthInfo };
    authenticated.auth = {
      token: session.authToken,
      clientId: auth.clientId,
      scopes: options.capabilities === undefined ? [] : Object.keys(options.capabilities),
      extra: { leaseId: auth.leaseId, sessionEpoch: options.controller.snapshot().epoch },
    };
    if (closing || leaseClosed(auth.leaseId) || session.closeStarted) {
      await dispose(session);
      if (!response.writableEnded && !response.destroyed) {
        jsonRpcError(response, 410, -32001, closing ? "MCP endpoint is closing" : "The host lease is closed");
      }
      if (initializingLease) initializingLeases.delete(auth.leaseId);
      return;
    }

    try {
      await session.transport.handleRequest(authenticated, response, parsedBody);
    } catch (error) {
      options.diagnostics?.record("error", "mcp.request.error", {
        clientId: auth.clientId, outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? "mcp_internal_error",
      });
      if (session.transport.sessionId === undefined) await dispose(session).catch(() => undefined);
      if (!response.headersSent && !response.writableEnded) {
        jsonRpcError(response, 500, -32603, "Internal MCP error");
      } else if (!response.writableEnded) {
        response.destroy();
      }
    } finally {
      if (initializingLease) initializingLeases.delete(auth.leaseId);
    }
  };

  handler.closeLease = async (leaseId: string): Promise<void> => {
    rememberClosedLease(leaseId);
    initializingLeases.delete(leaseId);
    abortBodies(leaseId);
    const owned = [...allSessions].filter(session => session.leaseId === leaseId);
    await Promise.allSettled(owned.map(dispose));
  };
  handler.closeAll = async (): Promise<void> => {
    closing = true;
    initializingLeases.clear();
    abortBodies();
    await Promise.allSettled([...allSessions].map(dispose));
    options.diagnostics?.record("info", "mcp.endpoint.closed", { outcome: "success" });
  };
  return handler;
}

async function makeSession(
  options: McpHttpOptions,
  auth: AuthContext & { leaseId: string; clientId: string },
  sessions: Map<string, HttpSession>,
  allSessions: Set<HttpSession>,
  dispose: (session: HttpSession) => Promise<void>,
): Promise<HttpSession> {
  let session!: HttpSession;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: sessionId => {
      // Lease cleanup may race transport initialization; never republish a closed session.
      if (session.closeStarted) return;
      if (sessions.has(sessionId)) throw new Error("MCP session identifier collision");
      if (session.closeStarted) return;
      sessions.set(sessionId, session);
    },
    onsessionclosed: () => { if (session) void dispose(session).catch(() => undefined); },
  });
  const catalogOptions: AlderMcpOptions = {
    controller: options.controller,
    artifactStore: options.artifactStore,
    clientId: auth.clientId,
    sessionEpoch: options.controller.snapshot().epoch,
    ...(auth.assertActive === undefined ? {} : { assertActive: auth.assertActive }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.startup === undefined ? {} : { startup: options.startup }),
    ...(options.runtimeReady === undefined ? {} : { runtimeReady: options.runtimeReady }),
    ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
  };
  const server = createMcpServer(catalogOptions);
  session = {
    leaseId: auth.leaseId,
    clientId: auth.clientId,
    authKind: auth.kind,
    ...(auth.assertActive === undefined ? {} : { assertActive: auth.assertActive }),
    transport,
    server,
    authToken: randomUUID(),
    closed,
    closeStarted: false,
    resolveClosed,
  };
  allSessions.add(session);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => { sdkOnClose?.(); void dispose(session).catch(() => undefined); };
  let resolveConnect!: () => void;
  let rejectConnect!: (error: unknown) => void;
  const connectPromise = new Promise<void>((resolve, reject) => { resolveConnect = resolve; rejectConnect = reject; });
  session.connectPromise = connectPromise;
  try {
    const established = server.connect(transport);
    established.then(resolveConnect, rejectConnect);
    await connectPromise;
    options.diagnostics?.record("info", "mcp.session.opened", { clientId: auth.clientId, sessionEpoch: options.controller.snapshot().epoch });
  } catch (error) {
    rejectConnect(error);
    await dispose(session);
    throw error;
  }
  return session;
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const declared = oneHeader(request.headers["content-length"]);
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new RequestBodyError(400, -32600, "Invalid Content-Length");
    if (length > MCP_MAX_MESSAGE_BYTES) {
      request.resume();
      throw new RequestBodyError(413, -32000, "MCP request exceeds the 16 MiB limit");
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > MCP_MAX_MESSAGE_BYTES) {
      request.resume();
      throw new RequestBodyError(413, -32000, "MCP request exceeds the 16 MiB limit");
    }
    chunks.push(chunk);
  }
  try {
    return decodeJsonFrame(Buffer.concat(chunks, bytes), MCP_MAX_MESSAGE_BYTES);
  } catch (error) {
    if (error instanceof ProtocolError) {
      const parseError = error.code === "invalid_json" || error.code === "invalid_utf8";
      throw new RequestBodyError(400, parseError ? -32700 : -32600, parseError ? "Invalid JSON request body" : error.message);
    }
    throw error;
  }
}

function oneHeader(value: string | string[] | undefined, name = "header"): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0] === undefined) throw new Error(`${name} must occur exactly once`);
    value = value[0];
  }
  if (value.includes(",") || value.length === 0) throw new Error(`${name} must occur exactly once`);
  return value;
}

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}
