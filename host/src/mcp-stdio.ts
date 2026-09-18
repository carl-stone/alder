import { Transform, type TransformCallback } from "node:stream";
import type { Readable, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  InitializedNotificationSchema,
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  PingRequestSchema,
  ResultSchema,
  isJSONRPCRequest,
  type ClientCapabilities,
  type Implementation,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  MAX_MCP_REQUEST_BYTES,
  ProtocolError,
  decodeJsonFrame,
} from "./protocol.js";

const STDIO_BUFFER_BYTES = MAX_MCP_REQUEST_BYTES + 1;
const STDIO_MAX_PENDING_REQUESTS = 128;
const STDIO_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const STDIO_QUEUE_FULL_CODE = -32029;
const REQUEST_TIMEOUT_MS = 120_000;
const UPSTREAM_TIMEOUT_MESSAGE = "MCP upstream connection timed out";
const STDIO_CLOSED_MESSAGE = "MCP stdio transport closed";
const CANCELLED_CODE = -32800;

type McpRequestId = Extract<RequestId, string | number>;
type MessageHandler = (message: JSONRPCMessage) => Promise<void>;

export interface McpInitializationMetadata {
  readonly clientId: string;
  readonly sessionEpoch: string;
  readonly documentRevision: number;
  readonly capabilities: string[];
}

export interface McpStdioOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly alder?: McpInitializationMetadata;
  readonly upstreamTimeoutMs?: number;
}

export interface McpInitialization {
  readonly protocolVersion: string;
  readonly capabilities: ClientCapabilities;
  readonly clientInfo: Implementation;
}

export interface McpUpstream {
  readonly client: Client;
  readonly transport: Transport;
}

export type McpUpstreamFactory = (initialization: McpInitialization) => McpUpstream | Promise<McpUpstream>;

const drains = new WeakMap<StdioServerTransport, () => Promise<void>>();

/**
 * Attach a bounded MCP stdio endpoint. The upstream SDK Client and transport
 * are created and connected only after the downstream initialize request has
 * supplied its client identity and capabilities.
 */
export async function connectMcpStdio(
  createUpstream: McpUpstreamFactory,
  options: McpStdioOptions = {},
): Promise<StdioServerTransport> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new RangeError("upstreamTimeoutMs must be a positive safe integer");
  }
  const validated = new StrictMcpInput(output);
  const transport = new StdioServerTransport(validated, output, { maxBufferSize: STDIO_BUFFER_BYTES });
  const pending = new Set<Promise<void>>();
  const pendingRequests = new Map<McpRequestId, PendingRequest>();
  const upstreamRequests = new Map<McpRequestId, McpRequestId>();
  const upstreamRequestSizes = new Map<McpRequestId, number>();
  const progressRequests = new Map<McpRequestId, PendingRequest>();
  const wireToClient = new Map<McpRequestId, McpRequestId>();
  const clientToWire = new Map<McpRequestId, McpRequestId>();
  const wireRequestSizes = new Map<McpRequestId, number>();
  let pendingRequestBytes = 0;
  let upstreamRequestBytes = 0;
  let wireRequestBytes = 0;
  let outputInFlightBytes = 0;
  let nextWireId = 0;
  let nextDownstreamId = 0;
  let closed = false;
  let client: Client | undefined;
  let upstream: (Transport & { protocolVersion?: string }) | undefined;
  let sendUpstream: ((message: JSONRPCMessage, options?: TransportSendOptions) => Promise<void>) | undefined;
  let upstreamReady: Promise<void> | undefined;
  let activeRequest: PendingRequest | undefined;
  const lifecycleAbort = new AbortController();
  let upstreamGeneration = 0;
  let cancelUpstreamAttempt: (() => void) | undefined;

  const sendDownstream = async (message: JSONRPCMessage): Promise<void> => {
    if (closed) return;
    const bytes = messageBytes(message);
    if (outputInFlightBytes + bytes > STDIO_MAX_IN_FLIGHT_BYTES) {
      throw Object.assign(new Error("MCP stdio output queue is full"), { code: STDIO_QUEUE_FULL_CODE });
    }
    outputInFlightBytes += bytes;
    try {
      await transport.send(message);
    } finally {
      outputInFlightBytes -= bytes;
    }
  };
  const messageBytes = (message: JSONRPCMessage): number => Buffer.byteLength(JSON.stringify(message)) + 1;

  const allocateId = (prefix: string, used: Map<McpRequestId, unknown>): McpRequestId => {
    let id: McpRequestId;
    do { id = prefix + (++nextDownstreamId); } while (used.has(id));
    return id;
  };

  const connectUpstream = async (initialization: McpInitialization): Promise<void> => {
    const generation = ++upstreamGeneration;
    let candidate: McpUpstream;
    let disposeCandidate: (() => void) | undefined;
    const invalidate = (): void => {
      if (upstreamGeneration === generation) upstreamGeneration++;
      if (cancelUpstreamAttempt === disposeCandidate) cancelUpstreamAttempt = undefined;
    };
    const factoryPromise = Promise.resolve().then(() => createUpstream(initialization));
    try {
      try {
        candidate = await awaitWithTimeoutAndAbort(factoryPromise, upstreamTimeoutMs, new Error(UPSTREAM_TIMEOUT_MESSAGE), lifecycleAbort.signal);
      } catch (error) {
        void factoryPromise.then(value => disposeUpstream(value), () => undefined);
        invalidate();
        throw error;
      }
      if (closed || lifecycleAbort.signal.aborted || upstreamGeneration !== generation) {
        disposeUpstream(candidate);
        invalidate();
        throw new Error(STDIO_CLOSED_MESSAGE);
      }
      const candidateClient = candidate.client;
      const candidateTransport = candidate.transport as Transport & { protocolVersion?: string };
      const candidateClose = candidateTransport.close.bind(candidateTransport);
      let disposed = false;
      disposeCandidate = () => {
        if (disposed) return;
        disposed = true;
        void Promise.resolve().then(() => candidateClient.close()).catch(() => undefined);
        void Promise.resolve().then(() => candidateClose()).catch(() => undefined);
      };
      cancelUpstreamAttempt = disposeCandidate;
      const source = candidateTransport;
      const sourceSend = source.send.bind(source);
      const sourceClose = candidateClose;
      const sourceOnclose = source.onclose;
      const sourceOnerror = source.onerror;
      let clientOnmessage: Transport["onmessage"];
      let clientOnclose: Transport["onclose"];
      let clientOnerror: Transport["onerror"];
      const active = (): boolean => !closed && upstreamGeneration === generation;
      const bridge = {} as Transport & { protocolVersion?: string };
      bridge.start = source.start.bind(source);
      bridge.send = async (message: JSONRPCMessage, sendOptions?: TransportSendOptions): Promise<void> => {
        if (!active()) throw new Error(STDIO_CLOSED_MESSAGE);
        if (isJSONRPCRequest(message)) {
          const bytes = messageBytes(message);
          if (wireToClient.size >= STDIO_MAX_PENDING_REQUESTS || wireRequestBytes + bytes > STDIO_MAX_IN_FLIGHT_BYTES) throw Object.assign(new Error("MCP stdio request queue is full"), { code: STDIO_QUEUE_FULL_CODE });
          const internalId = message.id;
          const wireId = allocateWireId();
          wireToClient.set(wireId, internalId);
          clientToWire.set(internalId, wireId);
          wireRequestSizes.set(wireId, bytes);
          wireRequestBytes += bytes;
          const token = requestProgressToken(message);
          if (token !== undefined && activeRequest !== undefined) progressRequests.set(token, activeRequest);
          try {
            await sourceSend({ ...message, id: wireId }, sendOptions);
          } catch (error) {
            wireToClient.delete(wireId);
            clientToWire.delete(internalId);
            wireRequestSizes.delete(wireId);
            wireRequestBytes -= bytes;
            throw error;
          }
          return;
        }
        if ("method" in message && message.method === "notifications/cancelled") {
          const params = message.params as Record<string, unknown> | undefined;
          const requestId = params?.requestId;
          const wireId = isRequestId(requestId) ? clientToWire.get(requestId) : undefined;
          if (wireId !== undefined) {
            await sourceSend({ ...message, params: { ...params, requestId: wireId } }, sendOptions);
            return;
          }
        }
        await sourceSend(message, sendOptions);
      };
      bridge.close = sourceClose;
      bridge.setProtocolVersion = version => source.setProtocolVersion?.(version);
      Object.defineProperty(bridge, "protocolVersion", { configurable: true, get: () => source.protocolVersion });
      Object.defineProperty(bridge, "sessionId", { configurable: true, get: () => source.sessionId });
      Object.defineProperty(bridge, "onmessage", {
        configurable: true,
        get: () => clientOnmessage,
        set: (handler: Transport["onmessage"] | undefined) => { clientOnmessage = handler; },
      });
      Object.defineProperty(bridge, "onclose", {
        configurable: true,
        get: () => clientOnclose,
        set: (handler: Transport["onclose"] | undefined) => { clientOnclose = handler; },
      });
      Object.defineProperty(bridge, "onerror", {
        configurable: true,
        get: () => clientOnerror,
        set: (handler: Transport["onerror"] | undefined) => { clientOnerror = handler; },
      });
      source.onclose = () => { sourceOnclose?.(); clientOnclose?.(); };
      source.onerror = error => { sourceOnerror?.(error); clientOnerror?.(error); };
      source.onmessage = (message, extra) => {
        if (!active()) return;
        if (isJSONRPCRequest(message)) {
          const bytes = messageBytes(message);
          if (upstreamRequests.size >= STDIO_MAX_PENDING_REQUESTS || upstreamRequestBytes + bytes > STDIO_MAX_IN_FLIGHT_BYTES) {
            void sendDownstream({ jsonrpc: "2.0", id: message.id, error: { code: STDIO_QUEUE_FULL_CODE, message: "MCP stdio request queue is full" } } as JSONRPCResponse).catch(() => undefined);
            return;
          }
          const downstreamId = allocateId("alder-proxy-server-", upstreamRequests);
          upstreamRequests.set(downstreamId, message.id);
          upstreamRequestSizes.set(downstreamId, bytes);
          upstreamRequestBytes += bytes;
          void sendDownstream({ ...message, id: downstreamId }).catch(() => {
            upstreamRequests.delete(downstreamId);
            const requestBytes = upstreamRequestSizes.get(downstreamId);
            upstreamRequestSizes.delete(downstreamId);
            if (requestBytes !== undefined) upstreamRequestBytes -= requestBytes;
          });
          return;
        }
        if (isResponse(message)) {
          const wireId = message.id;
          if (!isRequestId(wireId)) return;
          const internalId = wireToClient.get(wireId);
          if (internalId !== undefined) {
            wireToClient.delete(wireId);
            clientToWire.delete(internalId);
            const requestBytes = wireRequestSizes.get(wireId);
            wireRequestSizes.delete(wireId);
            if (requestBytes !== undefined) wireRequestBytes -= requestBytes;
            clientOnmessage?.({ ...message, id: internalId }, extra);
            return;
          }
        }
        if ("method" in message && message.method === "notifications/progress") {
          const params = message.params as Record<string, unknown> | undefined;
          const token = params?.progressToken;
          const owner = isRequestId(token) ? progressRequests.get(token) : undefined;
          clientOnmessage?.(message, extra);
          if (owner === undefined) void sendDownstream(message).catch(() => undefined);
          return;
        }
        clientOnmessage?.(message, extra);
        if (!isResponse(message)) void sendDownstream(message).catch(() => undefined);
      };
      try {
        await awaitWithTimeoutAndAbort(
          Promise.resolve().then(() => candidateClient.connect(bridge, { signal: lifecycleAbort.signal, timeout: upstreamTimeoutMs, maxTotalTimeout: upstreamTimeoutMs })),
          upstreamTimeoutMs,
          new Error(UPSTREAM_TIMEOUT_MESSAGE),
          lifecycleAbort.signal,
        );
        if (!active()) throw new Error(STDIO_CLOSED_MESSAGE);
        client = candidateClient;
        upstream = bridge;
        sendUpstream = sourceSend;
      } catch (error) {
        invalidate();
        disposeCandidate();
        throw error;
      } finally {
        if (cancelUpstreamAttempt === disposeCandidate) cancelUpstreamAttempt = undefined;
      }
    } catch (error) {
      disposeCandidate?.();
      throw error;
    }
  };

  const handleMessage: MessageHandler = async message => {
    if (isResponse(message)) {
      const downstreamId = message.id;
      if (!isRequestId(downstreamId)) return;
      const upstreamId = upstreamRequests.get(downstreamId);
      if (upstreamId !== undefined && sendUpstream !== undefined) {
        await sendUpstream({ ...message, id: upstreamId });
        const requestBytes = upstreamRequestSizes.get(downstreamId);
        upstreamRequestSizes.delete(downstreamId);
        if (requestBytes !== undefined) upstreamRequestBytes -= requestBytes;
        upstreamRequests.delete(downstreamId);
      }
      return;
    }
    if (isJSONRPCRequest(message)) {
      if (message.method === "ping" && upstreamReady === undefined) {
        await sendDownstream({ jsonrpc: "2.0", id: message.id, result: {} } as JSONRPCResponse);
        return;
      }
      if (message.method === "initialize") {
        try {
          const params = message.params as unknown as McpInitialization;
          upstreamReady ??= connectUpstream(params);
          await upstreamReady;
          await sendDownstream(initializeResponse(message.id));
        } catch (error) {
          await sendDownstream({ jsonrpc: "2.0", id: message.id, error: errorResponse(error) } as JSONRPCResponse);
        }
        return;
      }
      try {
        if (upstreamReady === undefined) throw new Error("MCP server not initialized");
        await upstreamReady;
        if (client === undefined) throw new Error("MCP upstream client is unavailable");
      } catch (error) {
        await sendDownstream({ jsonrpc: "2.0", id: message.id, error: errorResponse(error) } as JSONRPCResponse);
        return;
      }
      const connectedClient = client;
      const requestBytes = messageBytes(message);
      if (pendingRequests.has(message.id) || pendingRequests.size >= STDIO_MAX_PENDING_REQUESTS || pendingRequestBytes + requestBytes > STDIO_MAX_IN_FLIGHT_BYTES) {
        await sendDownstream({ jsonrpc: "2.0", id: message.id, error: { code: STDIO_QUEUE_FULL_CODE, message: "MCP stdio request queue is full" } } as JSONRPCResponse);
        return;
      }
      const controller = new AbortController();
      const request: PendingRequest = {
        controller,
        progressToken: requestProgressToken(message),
        bytes: requestBytes,
      };
      pendingRequests.set(message.id, request);
      pendingRequestBytes += requestBytes;
      const task = (async () => {
        try {
          const requestBody = { method: message.method, ...(message.params === undefined ? {} : { params: message.params }) } as never;
          const requestOptions = {
            signal: controller.signal,
            timeout: REQUEST_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
            ...(request.progressToken === undefined ? {} : {
              onprogress: (progress: Record<string, unknown>) => {
                if (request.progressToken === undefined) return;
                void sendDownstream({ jsonrpc: "2.0", method: "notifications/progress", params: { ...progress, progressToken: request.progressToken } }).catch(() => undefined);
              },
            }),
          } as never;
          activeRequest = request;
          const result = await connectedClient.request(requestBody, ResultSchema, requestOptions);
          await sendDownstream({ jsonrpc: "2.0", id: message.id, result } as JSONRPCResponse);
        } catch (error) {
          const responseError = controller.signal.aborted ? { code: CANCELLED_CODE, message: "Request cancelled" } : errorResponse(error);
          await sendDownstream({ jsonrpc: "2.0", id: message.id, error: responseError } as JSONRPCResponse);
        } finally {
          if (activeRequest === request) activeRequest = undefined;
          pendingRequests.delete(message.id);
          pendingRequestBytes -= request.bytes;
          removeProgressRequest(progressRequests, request);
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => undefined);
      return;
    }
    if ("method" in message && message.method === "notifications/cancelled") {
      const params = message.params as Record<string, unknown> | undefined;
      const requestId = params?.requestId;
      const request = isRequestId(requestId) ? pendingRequests.get(requestId) : undefined;
      if (request !== undefined) {
        request.controller.abort();
        return;
      }
    }
    if ("method" in message && message.method === "ping") return;
    if ("method" in message && message.method === "notifications/initialized") return;
    try {
      if (upstreamReady === undefined) throw new Error("MCP server not initialized");
      await upstreamReady;
      if (client === undefined) throw new Error("MCP upstream client is unavailable");
      await client.notification(message as never);
    } catch {
      await sendUpstream?.(message);
    }
  };
  transport.onmessage = message => {
    if (closed) return;
    if (pending.size >= STDIO_MAX_PENDING_REQUESTS && isJSONRPCRequest(message)) {
      void sendDownstream({ jsonrpc: "2.0", id: message.id, error: { code: STDIO_QUEUE_FULL_CODE, message: "MCP stdio request queue is full" } } as JSONRPCResponse).catch(() => undefined);
      return;
    }
    const task = handleMessage(message);
    pending.add(task);
    void task.catch(error => transport.onerror?.(error instanceof Error ? error : new Error(String(error)))).finally(() => pending.delete(task)).catch(() => undefined);
  };
  const close = transport.close.bind(transport);
  transport.close = async () => {
    if (closed) return;
    closed = true;
    upstreamGeneration++;
    lifecycleAbort.abort(new Error(STDIO_CLOSED_MESSAGE));
    cancelUpstreamAttempt?.();
    cancelUpstreamAttempt = undefined;
    const connectedClient = client;
    client = undefined;
    upstream = undefined;
    sendUpstream = undefined;
    for (const request of pendingRequests.values()) request.controller.abort();
    input.unpipe(validated);
    pendingRequests.clear();
    input.pause();
    pendingRequestBytes = 0;
    progressRequests.clear();
    activeRequest = undefined;
    upstreamRequests.clear();
    upstreamRequestSizes.clear();
    upstreamRequestBytes = 0;
    wireToClient.clear();
    clientToWire.clear();
    wireRequestSizes.clear();
    wireRequestBytes = 0;
    validated.destroy();
    await close();
    await connectedClient?.close().catch(() => undefined);
  };
  drains.set(transport, async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  });
  await transport.start();
  input.once("end", () => { void transport.close().catch(error => transport.onerror?.(error instanceof Error ? error : new Error(String(error)))); });
  input.pipe(validated);
  return transport;

  function allocateWireId(): McpRequestId {
    let id: McpRequestId;
    do { id = "alder-proxy-client-" + (++nextWireId); } while (wireToClient.has(id) || upstreamRequests.has(id));
    return id;
  }

  function initializeResponse(id: McpRequestId): JSONRPCResponse {
    if (client === undefined || upstream === undefined) throw new Error("MCP upstream client is unavailable");
    const result: Record<string, unknown> = {
      protocolVersion: upstream.protocolVersion ?? "2025-03-26",
      capabilities: client.getServerCapabilities() ?? {},
      serverInfo: client.getServerVersion() ?? { name: "alder", version: "0.1.0" },
    };
    const instructions = client.getInstructions();
    if (instructions !== undefined) result.instructions = instructions;
    if (options.alder !== undefined) result._meta = { alder: { ...options.alder, capabilities: [...options.alder.capabilities] } };
    return { jsonrpc: "2.0", id, result } as JSONRPCResponse;
  }
}

export async function drainMcpStdio(transport: StdioServerTransport): Promise<void> {
  await drains.get(transport)?.();
}

interface PendingRequest {
  readonly controller: AbortController;
  readonly progressToken: string | number | undefined;
  readonly bytes: number;
}

class StrictMcpInput extends Transform {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private oversized = false;
  private phase: "new" | "awaiting-initialized" | "ready" | "shutdown" = "new";

  constructor(private readonly output: Writable) { super(); }

  _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(offset, end);
        if (!this.oversized) {
          if (this.buffered.length + part.length > MAX_MCP_REQUEST_BYTES) {
            this.buffered = Buffer.alloc(0);
            this.oversized = true;
          } else if (part.length > 0) {
            this.buffered = this.buffered.length === 0 ? part : Buffer.concat([this.buffered, part]);
          }
        }
        if (newline < 0) break;
        this.finishLine();
        offset = newline + 1;
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  _flush(callback: TransformCallback): void {
    if (this.buffered.length === 0 && !this.oversized) { callback(); return; }
    this.finishLine();
    callback();
  }

  private finishLine(): void {
    if (this.phase === "shutdown") { this.buffered = Buffer.alloc(0); this.oversized = false; return; }
    const line = this.buffered;
    this.buffered = Buffer.alloc(0);
    if (this.oversized) {
      this.oversized = false;
      this.respond(null, -32600, "invalid JSON-RPC request");
      return;
    }
    if (line.every(byte => byte === 0x09 || byte === 0x0d || byte === 0x20)) return;
    let value: unknown;
    try {
      value = decodeJsonFrame(line, MAX_MCP_REQUEST_BYTES);
    } catch (error) {
      const protocol = error instanceof ProtocolError;
      const parse = protocol && ((error as ProtocolError).code === "invalid_json" || (error as ProtocolError).code === "invalid_utf8");
      const id = protocol && (error as ProtocolError).code === "duplicate_key" ? recoverRequestId(line) : null;
      this.respond(id, parse ? -32700 : -32600, parse ? "parse error" : "invalid JSON-RPC request");
      return;
    }
    if (!isRecord(value) || !JSONRPCMessageSchema.safeParse(isResponse(value as JSONRPCMessage) ? value : { ...value, params: undefined }).success) {
      this.respond(recoverRequestId(line), -32600, "invalid JSON-RPC request");
      return;
    }
    if (isResponse(value as JSONRPCMessage)) {
      this.forward(line);
      return;
    }
    if (typeof value.method !== "string") {
      this.respond(recoverRequestId(line), -32600, "invalid JSON-RPC request");
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    const id = isRequestId(value.id) ? value.id : null;
    if (hasId && id === null) { this.respond(null, -32600, "invalid JSON-RPC request"); return; }
    if (value.method === "ping") {
      if (!PingRequestSchema.safeParse(value).success) { if (hasId) this.respond(id, -32602, "ping params must be empty"); return; }
      this.forward(line);
      return;
    }
    if (value.method === "initialize") {
      if (!hasId || this.phase !== "new") { if (hasId) this.respond(id, -32600, this.phase === "new" ? "invalid JSON-RPC request" : "server already initialized"); return; }
      if (!InitializeRequestSchema.safeParse(value).success) { this.respond(id, -32602, "invalid initialize params"); return; }
      this.phase = "awaiting-initialized";
      this.forward(line);
      return;
    }
    if (value.method === "notifications/initialized") {
      if (hasId) { this.respond(id, -32600, "invalid JSON-RPC request"); return; }
      if (!InitializedNotificationSchema.safeParse(value).success) return;
      if (this.phase === "awaiting-initialized") { this.phase = "ready"; this.forward(line); }
      return;
    }
    if (this.phase !== "ready") { if (hasId) this.respond(id, -32600, "server not initialized"); return; }
    if (!hasId && value.method === "tools/call") { this.respond(null, -32600, "effectful notifications require a request id"); return; }
    if (value.method === "shutdown") this.phase = "shutdown";
    this.forward(line);
  }

  private forward(line: Uint8Array): void { this.push(line); this.push(Buffer.from("\n")); }
  private respond(id: unknown, code: number, message: string): void { this.output.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isRequestId(value: unknown): value is McpRequestId { return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)); }
function isResponse(value: JSONRPCMessage): value is JSONRPCResponse { return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "id") && (Object.prototype.hasOwnProperty.call(value, "result") || Object.prototype.hasOwnProperty.call(value, "error")); }
function requestProgressToken(message: JSONRPCRequest): string | number | undefined {
  const params = message.params as Record<string, unknown> | undefined;
  const meta = params?._meta;
  if (!isRecord(meta) || !isRequestId(meta.progressToken)) return undefined;
  return meta.progressToken;
}
function removeProgressRequest(progress: Map<McpRequestId, PendingRequest>, request: PendingRequest): void {
  for (const [token, owner] of progress) if (owner === request) progress.delete(token);
}
function disposeUpstream(upstream: McpUpstream): void {
  void Promise.resolve().then(() => upstream.client.close()).catch(() => undefined);
  void Promise.resolve().then(() => upstream.transport.close()).catch(() => undefined);
}

async function awaitWithTimeoutAndAbort<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = signal.reason;
      settle(() => reject(reason instanceof Error ? reason : new Error(STDIO_CLOSED_MESSAGE)));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => settle(() => reject(timeoutError)), timeoutMs);
    timer.unref?.();
    void promise.then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
  });
}

function errorResponse(error: unknown): { code: number; message: string; data?: unknown } {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "number" && Number.isInteger((error as { code: number }).code) ? (error as { code: number }).code : -32603;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message || "MCP request failed" };
}
function recoverRequestId(input: Uint8Array): McpRequestId | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as unknown;
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "id") || !isRequestId(value.id)) return null;
    return value.id;
  } catch { return null; }
}
