import { z } from "zod";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DiagnosticSink } from "./diagnostics.js";
import {
  ARTIFACT_DESCRIPTOR_HEADER,
  ARTIFACT_RESOLUTION_MEDIA_TYPE,
  HOST_CLIENT_PROTOCOL_VERSION,
  HOST_PROTOCOL,
  MAX_EVENT_BYTES,
  SNAPSHOT_ENVELOPE_LIMIT,
  artifactResourceNameSchema,
  artifactResolutionSchema,
  ticketMintRequestSchema,
  ticketExchangeRequestSchema,
  attachLeaseRequestSchema,
  leaseActionRequestSchema,
  decodeJsonFrame,
  decodeHostCommandWire,
  decodeHostQueryWire,
  encodeHostEventWire,
  encodeHostQueryResultWire,
  encodeRecoveryWire,
  mimeEssence,
  parseHostCommand,
  parseArtifactDescriptor,
  parseHostQuery,
  sameArtifactHandle,
  type ArtifactHandle,
  type CommandResult,
  type HostCommand,
  type HostEvent,
  type HostQuery,
  type HostQueryResult,
  type HostSnapshot,
  type OutputScope,
  type Recovery,
  type OperationRecord,
  type HostConfiguration,
} from "./protocol.js";
import type { ArtifactManifest, ArtifactResourceRead } from "./outputs.js";
import type { UploadStore } from "./uploads.js";
import { readPrivateFile } from "./private-paths.js";
export const HTTP_JSON_LIMIT = 1024 * 1024;
export const HTTP_UPLOAD_LIMIT = 16 * 1024 * 1024;
export const HTTP_SOURCE_LIMIT = SNAPSHOT_ENVELOPE_LIMIT;
export const WEBSOCKET_MESSAGE_LIMIT = SNAPSHOT_ENVELOPE_LIMIT;
export const DEFAULT_OUTBOX_LIMIT = 2 * SNAPSHOT_ENVELOPE_LIMIT;
export const BROWSER_PROTOCOL_VERSION = HOST_CLIENT_PROTOCOL_VERSION;
export const TICKET_TTL_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const LEASE_EXPIRY_MS = 30_000;
export const MAX_ACTIVE_LEASES = 128;
export const MAX_LIVE_TICKETS = 128;
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const OUTPUT_CHUNK_BYTES = 262_144;
const ARTIFACT_LEASE_TTL_MS = 10 * 60_000;
const CONNECTION_CLOSE_TIMEOUT_MS = 1_000;
const SOCKET_COMMAND_QUEUE_LIMIT = 256;
const SOCKET_EVENT_QUEUE_LIMIT = 1_024;
const AUTH_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const BEARER_PATTERN = /^Bearer ([0-9a-f]{64})$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1"]);
const ORIGIN_HOST_PATTERN = /^[0-9a-f]{32}\.localhost$/;

export interface ControllerAdapter {
  snapshot(clientId?: string): HostSnapshot;
  subscribe(listener: (event: HostEvent) => void): () => void;
  dispatch(command: HostCommand): Promise<CommandResult>;
  registerClient?(clientId: string): void;
  releaseClient?(clientId: string): void;
  query?(query: HostQuery, callerClientId?: string): Promise<HostQueryResult> | HostQueryResult;

  operation?(id: string, clientId?: string): OperationRecord | undefined;
  awaitOperation?(id: string, clientId?: string, signal?: AbortSignal): Promise<OperationRecord>;
  configuration?(): HostConfiguration;
}

export interface LspAdapter {
  requestDocument(method: string, params: Record<string, unknown>, notebook: unknown): Promise<unknown>;
  restart?(notebook: unknown): Promise<unknown>;
}

export interface AlderServerSession {
  readonly sessionKey: string;
  readonly canonicalPath: string | null;
  readonly epoch: string;
  readonly continuityProof?: string;
  readonly recoveryId?: string;
  readonly token: string;
  readonly documentReady?: boolean;
}


export interface AuthContext {
  readonly kind: "bearer" | "cookie";
  readonly leaseId: string | null;
  readonly clientId: string | null;
  readonly csrf: string | null;
  /** Authoritative registry check for work that crossed an async boundary. */
  readonly assertActive?: () => void;
}

export interface McpHttpHandler {
  (request: IncomingMessage, response: ServerResponse, auth: AuthContext): Promise<void> | void;
  closeLease?: (leaseId: string) => Promise<void> | void;
  closeAll?: () => Promise<void> | void;
}

export interface ArtifactStoreBinding {
  writeArtifact(bytes: Uint8Array, mimeType: string, extension: string, scope: OutputScope): Promise<ArtifactHandle>;
  artifactManifest(descriptor: ArtifactHandle | string): ArtifactManifest;
  retainArtifactRead(descriptor: ArtifactHandle, expiresAt: number): void;
  openArtifactResource(descriptor: ArtifactHandle | string, relative?: string): ArtifactResourceRead;
  pin(handles: readonly ArtifactHandle[]): void;
  unpin(handles: readonly ArtifactHandle[]): void;
  release(handles: readonly ArtifactHandle[]): void;
}

export interface AlderServerOptions {
  controller: ControllerAdapter;
  host?: string;
  /** Fresh per-incarnation hostname used for browser HTTP authority and origin checks. */
  originHost?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  externalOrigin?: string;
  tokenFile?: string;
  externalBearerValidated?: boolean;
  session?: AlderServerSession;
  staticDir: string;
  indexFile?: string;

  uploads?: UploadStore;
  artifactStore: ArtifactStoreBinding;
  lsp?: LspAdapter;
  mcpHandler?: McpHttpHandler;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  diagnostics?: DiagnosticSink;
  flushDiagnostics?: () => Promise<void>;
  onClientCount?: (count: number) => void;
  onLeaseCount?: (count: number) => void;
  onLastLeaseDiscard?: () => void | Promise<void>;
  acceptingLeases?: () => boolean;
  onBrowserActivity?: () => void;
  onShutdown?: () => void | Promise<void>;
  onCompromised?: (reason: string) => void | Promise<void>;
  documentReady?: boolean;
  maxJsonBytes?: number;
  maxUploadBytes?: number;
  maxSourceBytes?: number;
  maxWebSocketBytes?: number;
  maxOutboxBytes?: number;
  operationWaitTimeoutMs?: number;
  leaseExpiryMs?: number;
  leaseSweepIntervalMs?: number;
}

export interface AlderServerAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

export interface AlderServer {
  readonly httpServer: HttpServer;
  start(): Promise<AlderServerAddress>;
  close(): Promise<void>;
  address(): AlderServerAddress | null;
  retainArtifact(descriptor: ArtifactHandle): ArtifactHandle;
  compromise(reason: string): Promise<void>;
}

export class HttpBoundaryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "HttpBoundaryError";
  }
}

export function parseJsonObject(bytes: Uint8Array | string, maxBytes = HTTP_JSON_LIMIT): Record<string, unknown> {
  try {
    const value = decodeJsonFrame(bytes, maxBytes);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HttpBoundaryError("invalid_request", "JSON body must be an object", 400);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    const message = error instanceof Error ? error.message : "invalid JSON body";
    throw new HttpBoundaryError("invalid_request", message, 400);
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = HTTP_JSON_LIMIT,
): Promise<Record<string, unknown>> {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpBoundaryError("unsupported_media_type", "Content-Type must be application/json", 415);
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (typeof declared !== "string" || !/^[0-9]+$/.test(declared) || Number(declared) > maxBytes) {
      request.resume();
      throw new HttpBoundaryError("payload_too_large", bodyLimitMessage(maxBytes), 413);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let oversized = false;
  for await (const chunk of request) {
    if (oversized) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (oversized) throw new HttpBoundaryError("payload_too_large", bodyLimitMessage(maxBytes), 413);
  if (total === 0) throw new HttpBoundaryError("invalid_request", "empty request body", 400);
  try {
    return parseJsonObject(Buffer.concat(chunks, total), maxBytes);
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    throw new HttpBoundaryError("invalid_request", "invalid JSON body", 400);
  }
}

function bodyLimitMessage(maxBytes: number): string {
  return maxBytes % (1024 * 1024) === 0
    ? `request body exceeds ${maxBytes / (1024 * 1024)} MiB`
    : `request body exceeds ${maxBytes} bytes`;
}
export function validateOriginHost(host: string): string {
  if (!ORIGIN_HOST_PATTERN.test(host)) throw new Error("origin host must be a 128-bit lowercase hex nonce under .localhost");
  return host;
}

export function createOriginHost(): string {
  return randomBytes(16).toString("hex") + ".localhost";
}

export function validateLoopbackHost(host: string): string {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("host must be exactly 127.0.0.1");
  return host;
}

export function buildAllowedOrigins(port: number, origins?: readonly string[], originHost?: string): readonly string[] {
  if (!origins && originHost === undefined) return ["http://127.0.0.1:" + port, "http://[::1]:" + port];
  if (origins !== undefined && (origins.length === 0 || new Set(origins).size !== origins.length)) throw new Error("allowedOrigins must be a nonempty unique array");
  for (const origin of origins ?? []) validateOrigin(origin);
  if (originHost === undefined) return [...(origins ?? [])];
  const fresh = publicOrigin(validateOriginHost(originHost), port);
  return origins === undefined ? [fresh] : [fresh, ...origins.filter(origin => origin !== fresh)];
}

export function validateRequestHost(headers: IncomingMessage["headers"], origins: readonly string[]): boolean {
  const host = singleHeader(headers.host);
  if (host === null) return false;
  const authorities = new Set(origins.map(origin => new URL(origin).host));
  return authorities.has(host);
}

export function validateRequestOrigin(headers: IncomingMessage["headers"], origins: readonly string[]): boolean {
  if (!validateRequestHost(headers, origins)) return false;
  const origin = singleHeader(headers.origin);
  return origin === null || origins.includes(origin);
}

function validateOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid origin: ${value}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.origin !== value) {
    throw new Error(`invalid origin: ${value}`);
  }
  return parsed.origin;
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredString(value: unknown, field: string, maxBytes = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || /[\r\n]/.test(value)
    || Buffer.byteLength(value) > maxBytes) {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be a bounded nonempty string`, 400);
  }
  return value;
}

function assertExactFields(body: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  const permitted = new Set(allowed);
  const extra = Object.keys(body).find(field => !permitted.has(field));
  if (extra !== undefined) throw new HttpBoundaryError("invalid_request", `unknown field: ${extra}`, 400);
  const missing = required.find(field => !(field in body));
  if (missing !== undefined) throw new HttpBoundaryError("invalid_request", `missing required field: ${missing}`, 400);
}

export async function safeChildPath(
  root: string,
  encodedRelative: string,
  allowedExtensions: readonly string[],
  allowNested = false,
): Promise<string | null> {
  if (!encodedRelative || /%(?![0-9a-f]{2})/i.test(encodedRelative)) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(encodedRelative);
  } catch {
    return null;
  }
  if (!relative || relative.includes("\0") || relative.includes("\\") || relative.startsWith("/")) return null;
  const segments = relative.split("/");
  if ((!allowNested && segments.length !== 1)
    || segments.some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("."))) return null;
  const extension = extname(relative).slice(1).toLowerCase();
  const extensions = new Set(allowedExtensions.map(item => item.toLowerCase()));
  if (!extensions.has("*") && !extensions.has(extension)) return null;
  try {
    const rootPath = await realpath(root);
    const candidatePath = await realpath(resolve(root, relative));
    if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${sep}`)) return null;
    const info = await lstat(candidatePath);
    return info.isFile() ? candidatePath : null;
  } catch {
    return null;
  }
}

export function editorContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:", "script-src 'self'",
    "style-src 'self'", `style-src-elem 'self' 'nonce-${nonce}'`, "style-src-attr 'unsafe-inline'", "frame-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join("; ");
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8", gif: "image/gif", html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  json: "application/json", md: "text/markdown; charset=utf-8", jpeg: "image/jpeg", jpg: "image/jpeg", mp3: "audio/mpeg",
  mp4: "video/mp4", ogg: "audio/ogg", pdf: "application/pdf", png: "image/png", qmd: "text/plain; charset=utf-8",
  r: "text/plain; charset=utf-8", svg: "image/svg+xml", txt: "text/plain; charset=utf-8", wav: "audio/wav",
  webm: "video/webm", webp: "image/webp", woff2: "font/woff2", ipynb: "application/json",
};

const STATIC_EXTENSIONS = Object.keys(MIME_TYPES);

async function serveFile(response: ServerResponse, path: string, contentType: string, headers: Record<string, string> = {}): Promise<void> {
  const info = await stat(path);
  if (response.destroyed) return;
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(info.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  await pipeline(createReadStream(path), response);
}

function errorStatus(code: string): number {
  const statuses: Record<string, number> = {
    invalid_request: 400, invalid_notebook: 400, config_invalid: 400, invalid_layout: 400, forbidden: 403,
    forbidden_origin: 403, auth_configuration_invalid: 500, not_found: 404, method_not_allowed: 405,
    source_conflict: 409, save_conflict: 409, graph_invalid: 409, graph_blocked: 409, kernel_state_invalid: 409, run_in_progress: 409, operation_in_progress: 409,
    request_id_conflict: 409, request_expired: 409, package_operation_in_progress: 409, no_run_in_progress: 409, stale_value: 409, active_clients_changed: 409,
    operation_expired: 410, session_epoch_mismatch: 409, session_not_started: 409, session_stopped: 410, payload_too_large: 413, unsupported_media_type: 415,
    client_limit: 429, ticket_limit: 429, operation_timeout: 504, lsp_unavailable: 503, service_unavailable: 503,
    engine_not_ready: 503, output_expired: 410, output_invalid: 400, output_quota: 503,
  };
  return statuses[code] ?? 500;
}

function errorPayload(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof HttpBoundaryError) return error;
  if (error instanceof z.ZodError) return { code: "invalid_request", message: z.prettifyError(error), status: 400 };
  const errorWithCode = error instanceof Error ? error as Error & { readonly code?: unknown } : null;
  const record = errorWithCode ?? (isPlainObject(error) ? error : null);
  if (record !== null) {
    const code = typeof record.code === "string" ? record.code : "internal_error";
    const message = typeof record.message === "string" && !/[0-9a-f]{64}/i.test(record.message)
      ? record.message
      : "internal server error";
    return { code, message, status: errorStatus(code) };
  }
  return { code: "internal_error", message: "internal server error", status: 500 };
}

function jsonResponse(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  if (response.writableEnded || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length), "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extraHeaders,
  });
  response.end(body);
}

function failResponse(response: ServerResponse, error: unknown): void {
  const detail = errorPayload(error);
  jsonResponse(response, detail.status, { ok: false, error: { code: detail.code, message: detail.message } });
}

function method(response: ServerResponse, actual: string, expected: string): boolean {
  if (actual === expected) return true;
  response.setHeader("Allow", expected);
  jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: `method not allowed: ${actual}` } });
  return false;
}

function parseBearer(headers: IncomingMessage["headers"]): string | null {
  const value = singleHeader(headers.authorization);
  if (!value) return null;
  const match = BEARER_PATTERN.exec(value);
  return match?.[1] ?? null;
}

function cookieValue(headers: IncomingMessage["headers"], name: string): string | null {
  const value = singleHeader(headers.cookie);
  if (!value) return null;
  for (const item of value.split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    if (key === name) return item.slice(index + 1).trim() || null;
  }
  return null;
}

function csrfHeader(headers: IncomingMessage["headers"]): string | null {
  return singleHeader(headers["x-alder-csrf"])
    ?? singleHeader(headers["x-csrf-token"]);
}

function leaseHeader(headers: IncomingMessage["headers"]): string | null {
  return singleHeader(headers["x-alder-lease-id"]);
}

function clientHeader(headers: IncomingMessage["headers"]): string | null {
  return singleHeader(headers["x-alder-client-id"]);
}

function setDifference(value: unknown, allowed: readonly string[]): string | null {
  if (!isPlainObject(value)) return "body must be an object";
  const permitted = new Set(allowed);
  return Object.keys(value).find(key => !permitted.has(key)) ?? null;
}

function eventCursor(value: unknown): number | null {
  if (isPlainObject(value) && typeof value.cursor === "number" && Number.isSafeInteger(value.cursor)) return value.cursor;
  return null;
}

function coalesceKey(event: HostEvent): string | null {
  if (event.type === "runtime" || event.type === "graph") return event.type;
  if ((event.type === "cell" || event.type === "diagnostics") && event.cellId !== undefined) return event.type + ":" + event.cellId;
  return null;
}

function serializedEventBytes(event: HostEvent): number {
  try { return Buffer.byteLength(JSON.stringify({ type: "event", event: encodeHostEventWire(event) })); }
  catch { return MAX_EVENT_BYTES + 1; }
}
class SocketOutbox {
  private queue: Array<{ text: string; bytes: number; key: string | null }> = [];
  private queuedBytes = 0;
  private sending = false;
  private closed = false;
  private terminationTimer: NodeJS.Timeout | null = null;

  constructor(private readonly socket: WebSocket, private readonly maxBytes: number) {}

  send(value: unknown, key: string | null = null): boolean {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    if (bytes > SNAPSHOT_ENVELOPE_LIMIT || bytes > this.maxBytes) return this.fail();
    if (key !== null) {
      const prior = this.queue.findIndex(item => item.key === key);
      if (prior >= 0) {
        this.queuedBytes -= this.queue[prior]!.bytes;
        this.queue.splice(prior, 1);
      }
    }
    if (bytes + this.queuedBytes > this.maxBytes) return this.fail();
    this.queue.push({ text, bytes, key });
    this.queuedBytes += bytes;
    this.flush();
    return true;
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = null;
  }

  private fail(): false {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.socket.close(1013, "client cannot keep up with notebook events");
    this.terminationTimer = setTimeout(() => this.socket.terminate(), 500);
    this.terminationTimer.unref();
    return false;
  }

  private flush(): void {
    if (this.sending || this.closed || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    this.queuedBytes -= item.bytes;
    this.sending = true;
    this.socket.send(item.text, error => {
      this.sending = false;
      if (error) {
        this.closed = true;
        this.socket.terminate();
        return;
      }
      this.flush();
    });
  }
}

interface Lease {
  parentLeaseId?: string;
  readonly leaseId: string;
  readonly clientId: string;
  readonly csrf: string;
  lastSeen: number;
  reserved: boolean;
}

interface Ticket {
  readonly ticket: string;
  readonly origin: string;
  readonly expiresAt: number;
  readonly lease: Lease;
}


interface ArtifactCapabilityEntry {
  readonly descriptor: ArtifactHandle;
  readonly manifest: ArtifactManifest;
  expiresAt: number;
}

const ARTIFACT_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function acceptsArtifactResolution(headers: IncomingMessage["headers"]): boolean {
  const value = headers.accept;
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  for (const header of values) {
    for (const item of header.split(",")) {
      const parts = item.split(";");
      if (parts.shift()?.trim().toLowerCase() !== ARTIFACT_RESOLUTION_MEDIA_TYPE) continue;
      let acceptable = true;
      for (const parameter of parts) {
        const [name, rawValue] = parameter.split("=", 2);
        if (name?.trim().toLowerCase() !== "q" || rawValue === undefined) continue;
        const quality = Number(rawValue.trim());
        acceptable = Number.isFinite(quality) && quality > 0 && quality <= 1;
      }
      if (acceptable) return true;
    }
  }
  return false;
}

function parseArtifactDescriptorHeader(headers: IncomingMessage["headers"]): ArtifactHandle {
  const encoded = singleHeader(headers[ARTIFACT_DESCRIPTOR_HEADER]);
  if (encoded === null) throw new HttpBoundaryError("invalid_request", "artifact descriptor header is required", 400);
  try {
    return parseArtifactDescriptor(encoded);
  } catch {
    throw new HttpBoundaryError("invalid_request", "artifact descriptor header is invalid", 400);
  }
}

function manifestResource(manifest: ArtifactManifest, name: string): ArtifactHandle | undefined {
  return Object.hasOwn(manifest.resources, name) ? manifest.resources[name] : undefined;
}

function parseArtifactTarget(target: string): { capability: string; resource: string } | null {
  if (!target.startsWith("/artifacts/") || target.includes("?") || target.includes("#")) return null;
  const segments = target.split("/");
  if (segments.length !== 4 || segments[0] !== "" || segments[1] !== "artifacts") return null;
  const capability = segments[2]!;
  const resource = segments[3]!;
  if (!ARTIFACT_CAPABILITY_PATTERN.test(capability)) return null;
  if (!artifactResourceNameSchema.safeParse(resource).success) return null;
  return { capability, resource };
}

function artifactChildContentSecurityPolicy(capability: string, origins: readonly string[]): string {
  const resources = origins.map((origin) => origin + "/artifacts/" + capability + "/");
  const scoped = resources.length === 0 ? "'none'" : resources.join(" ");
  return [
    "default-src 'none'",
    "sandbox allow-scripts",
    "script-src 'unsafe-inline' " + scoped,
    "style-src 'unsafe-inline' " + scoped,
    "style-src-attr 'unsafe-inline'",
    "img-src " + scoped + " data: blob:",
    "font-src " + scoped + " data:",
    "media-src " + scoped + " blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
  ].join("; ");
}

function artifactNeedsChildSandbox(mimeType: string): boolean {
  const essence = mimeEssence(mimeType);
  return essence === "text/html" || essence === "application/xhtml+xml" || essence === "text/xml" ||
    essence === "application/xml" || essence.endsWith("+xml");
}

function waitForResponseDrain(response: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("artifact response was aborted")); };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
  });
}

async function serveArtifactResource(
  response: ServerResponse,
  reader: ArtifactResourceRead,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const descriptor = reader.descriptor;
    if (response.destroyed) return;
    response.writeHead(200, {
      "Content-Type": descriptor.mimeType,
      "Content-Length": String(descriptor.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    });
    let offset = 0;
    while (offset < descriptor.byteLength) {
      if (response.destroyed) return;
      const limit = Math.min(descriptor.chunkBytes, descriptor.byteLength - offset);
      const bytes = await reader.read(offset, limit);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > limit
        || offset + bytes.byteLength > descriptor.byteLength) {
        throw new HttpBoundaryError("service_unavailable", "artifact reader returned an invalid page", 503);
      }
      offset += bytes.byteLength;
      if (!response.write(Buffer.from(bytes)) && !response.destroyed) await waitForResponseDrain(response);
    }
    if (offset !== descriptor.byteLength) throw new HttpBoundaryError("service_unavailable", "artifact reader ended before its descriptor", 503);
    if (!response.destroyed && !response.writableEnded) response.end();
  } finally {
    reader.close();
  }
}

type ArtifactPageRead = { readonly descriptor: ArtifactHandle; readonly bytes: Uint8Array };

async function readPublicArtifactPage(
  artifactStore: Pick<ArtifactStoreBinding, "openArtifactResource">,
  handle: string,
  offset: number,
  limit: number,
): Promise<ArtifactPageRead> {
  const reader = artifactStore.openArtifactResource(handle);
  try {
    const descriptor = reader.descriptor;
    if (offset > descriptor.byteLength) throw new HttpBoundaryError("stale_value", "artifact offset is outside the retained value", 409);
    const bytes = await reader.read(offset, limit);
    const remaining = descriptor.byteLength - offset;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit || bytes.byteLength > remaining) {
      throw new HttpBoundaryError("service_unavailable", "artifact reader returned an invalid page", 503);
    }
    return { descriptor, bytes };
  } finally {
    reader.close();
  }
}

function tokenFileError(message: string): HttpBoundaryError {
  return new HttpBoundaryError("auth_configuration_invalid", message, 500);
}

async function readTokenFile(path: string): Promise<string> {
  try {
    const bytes = await readPrivateFile(path, { maxBytes: 65 });
    let contents = bytes.toString("utf8");
    if (contents.endsWith("\n")) contents = contents.slice(0, -1);
    if (contents.includes("\n") || !AUTH_TOKEN_PATTERN.test(contents)) {
      throw tokenFileError("token file must contain exactly one lowercase 64-hex bearer token");
    }
    return contents;
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    throw tokenFileError("token file is unavailable or insecure");
  }
}

function validateToken(token: string): string {
  if (!AUTH_TOKEN_PATTERN.test(token)) throw tokenFileError("session bearer token must be a lowercase 64-hex value");
  return token;
}
function publicOrigin(host: string, port: number): string {
  return `http://${host === "::1" ? "[::1]" : host}:${port}`;
}

function authFailure(message = "authentication failed"): HttpBoundaryError {
  return new HttpBoundaryError("forbidden", message, 403);
}

function parseSocketObject(data: RawData, binary: boolean, maxBytes: number): Record<string, unknown> {
  if (binary) throw new HttpBoundaryError("invalid_request", "WebSocket messages must be UTF-8 JSON text", 400);
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buffer.length > maxBytes) throw new HttpBoundaryError("payload_too_large", "WebSocket message is too large", 413);
  return parseJsonObject(buffer, maxBytes);
}

const socketConnectSchema = z.object({
  type: z.literal("connect"), protocolVersion: z.literal(HOST_CLIENT_PROTOCOL_VERSION),
  leaseId: z.string().min(1).max(256), clientId: z.string().min(1).max(256), csrf: z.string().min(1).max(256),
}).strict();

export function createAlderServer(options: AlderServerOptions): AlderServer {
  const host = validateLoopbackHost(options.host ?? "127.0.0.1");
  const originHost = validateOriginHost(options.originHost ?? createOriginHost());
  const requestedPort = options.port ?? 8899;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new Error("port must be an integer between 0 and 65535");
  const logger = options.logger ?? (() => undefined);
  const maxJson = options.maxJsonBytes ?? HTTP_JSON_LIMIT;
  const maxUpload = options.maxUploadBytes ?? HTTP_UPLOAD_LIMIT;
  const maxSource = options.maxSourceBytes ?? HTTP_SOURCE_LIMIT;
  const maxSocket = options.maxWebSocketBytes ?? WEBSOCKET_MESSAGE_LIMIT;
  const maxOutbox = options.maxOutboxBytes ?? DEFAULT_OUTBOX_LIMIT;
  const leaseExpiryMs = options.leaseExpiryMs ?? LEASE_EXPIRY_MS;
  const leaseSweepIntervalMs = options.leaseSweepIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  if (![maxJson, maxUpload, maxSource, maxSocket, maxOutbox].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("server body and outbox limits must be positive safe integers");
  if (maxJson > HTTP_JSON_LIMIT || maxUpload > HTTP_UPLOAD_LIMIT || maxSource > HTTP_SOURCE_LIMIT || maxSocket > WEBSOCKET_MESSAGE_LIMIT || maxOutbox > 256 * 1024 * 1024) throw new RangeError("server limits exceed their hard bounds");
  if (![leaseExpiryMs, leaseSweepIntervalMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("lease timing limits must be positive safe integers");
  const session = options.session ?? {
    sessionKey: randomUUID(), canonicalPath: null, epoch: randomUUID(), token: randomBytes(32).toString("hex"),
  };
  const bearer = validateToken(session.token);
  const cookieName = `alder_session_${session.epoch}`;
  const nonce = randomBytes(24).toString("base64url");
  const continuityProof = session.continuityProof ?? randomBytes(32).toString("hex");
  const shutdown = new AbortController();
  const sockets = new Set<WebSocket>();
  const socketsByLease = new Map<string, WebSocket>();
  const leases = new Map<string, Lease>();
  const tickets = new Map<string, Ticket>();
  const artifactLeases = new Map<string, { descriptor: ArtifactHandle; expiresAt: number }>();
  const capabilities = new Map<string, ArtifactCapabilityEntry>();
  let externalOrigin: string | null = options.externalOrigin === undefined ? null : validateOrigin(options.externalOrigin);
  if (externalOrigin !== null && !externalOrigin.startsWith("https://")) throw tokenFileError("external-origin must use HTTPS");
  if (externalOrigin !== null && options.tokenFile === undefined && options.externalBearerValidated !== true) throw tokenFileError("external-origin requires token-file");
  let configuredBearer: string | null = null;
  let currentAddress: AlderServerAddress | null = null;
  let closing: Promise<void> | null = null;
  let compromised = false;
  const pendingResponses = new Set<ServerResponse>();
  const activeMcpLeases = new Map<string, number>();
  const leaseTimer = setInterval(() => {
    const now = Date.now();
    const cutoff = now - leaseExpiryMs;
    for (const [id, lease] of leases) {
      if (activeMcpLeases.has(id)) continue;
      if (lease.lastSeen >= cutoff) continue;
      // Re-read both identity and active-operation state immediately before eviction.
      const current = leases.get(id);
      if (current !== lease || activeMcpLeases.has(id) || current.lastSeen >= cutoff) continue;
      removeLease(id);
    }
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
    for (const [id, lease] of artifactLeases) {
      if (lease.expiresAt > now) continue;
      artifactLeases.delete(id);
      options.artifactStore.unpin([lease.descriptor]);
      options.artifactStore.release([lease.descriptor]);
    }
    for (const [capability, entry] of capabilities) {
      const lease = artifactLeases.get(entry.descriptor.handle);
      if (entry.expiresAt <= now || (lease !== undefined && lease.expiresAt <= now)) capabilities.delete(capability);
    }
  }, leaseSweepIntervalMs);
  leaseTimer.unref();

  function retainArtifactLease(descriptor: ArtifactHandle, expiresAt: number): ArtifactHandle {
    const existing = artifactLeases.get(descriptor.handle);
    if (existing !== undefined && !sameArtifactHandle(existing.descriptor, descriptor)) {
      throw new HttpBoundaryError("stale_value", "artifact handle identity is stale", 409);
    }
    options.artifactStore.retainArtifactRead(descriptor, expiresAt);
    if (existing !== undefined) {
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
      return existing.descriptor;
    }
    try {
      options.artifactStore.pin([descriptor]);
    } catch (error) {
      options.artifactStore.release([descriptor]);
      throw error;
    }
    artifactLeases.set(descriptor.handle, { descriptor, expiresAt });
    return descriptor;
  }

  function retainArtifact(descriptor: ArtifactHandle): ArtifactHandle {
    if (shutdown.signal.aborted) throw new HttpBoundaryError("session_stopped", "session has stopped", 410);
    if (compromised) throw new HttpBoundaryError("session_stopped", "session is unavailable", 410);
    retainArtifactLease(descriptor, Date.now() + ARTIFACT_LEASE_TTL_MS);
    return descriptor;
  }

  function issueArtifactCapability(descriptor: ArtifactHandle, manifest: ArtifactManifest): { capability: string; expiresAt: number } {
    const now = Date.now();
    const retained = artifactLeases.get(descriptor.handle);
    if (retained !== undefined && !sameArtifactHandle(retained.descriptor, descriptor)) {
      throw new HttpBoundaryError("stale_value", "artifact handle identity is stale", 409);
    }
    if (retained !== undefined && retained.expiresAt <= now) {
      throw new HttpBoundaryError("output_expired", "artifact result lease has expired", 410);
    }
    const expiresAt = retained === undefined ? now + ARTIFACT_LEASE_TTL_MS : Math.min(now + ARTIFACT_LEASE_TTL_MS, retained.expiresAt);
    for (const [capability, entry] of capabilities) {
      if (entry.expiresAt > now && sameArtifactHandle(entry.descriptor, descriptor)) return { capability, expiresAt: entry.expiresAt };
    }
    let capability: string;
    do capability = randomBytes(32).toString("base64url"); while (capabilities.has(capability));
    capabilities.set(capability, { descriptor, manifest, expiresAt });
    return { capability, expiresAt };
  }
  function closeLeaseTransports(leaseId: string): void {
    const socket = socketsByLease.get(leaseId);
    if (socket !== undefined) {
      socketsByLease.delete(leaseId);
      socket.close(1008, "session lease ended");
      socket.terminate();
    }
    try {
      void Promise.resolve(options.mcpHandler?.closeLease?.(leaseId)).catch(() => logger("warn", "MCP lease cleanup failed"));
    } catch {
      logger("warn", "MCP lease cleanup failed");
    }
  }

  function retainMcpLease(lease: Lease): () => void {
    activeMcpLeases.set(lease.leaseId, (activeMcpLeases.get(lease.leaseId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = activeMcpLeases.get(lease.leaseId) ?? 0;
      if (count <= 1) activeMcpLeases.delete(lease.leaseId);
      else activeMcpLeases.set(lease.leaseId, count - 1);
      const current = leases.get(lease.leaseId);
      if (current === lease) current.lastSeen = Date.now();
    };
  }

  function leaseExpired(lease: Lease): boolean {
    return !activeMcpLeases.has(lease.leaseId) && lease.lastSeen + leaseExpiryMs <= Date.now();
  }

  function removeLease(leaseId: string): Lease | undefined {
    const lease = leases.get(leaseId);
    if (lease === undefined) return undefined;
    leases.delete(leaseId);
    for (const child of [...leases.values()]) if (child.parentLeaseId === leaseId) removeLease(child.leaseId);
    for (const [key, ticket] of tickets) if (ticket.lease.parentLeaseId === leaseId) tickets.delete(key);
    activeMcpLeases.delete(leaseId);
    closeLeaseTransports(leaseId);
    try {
      options.controller.releaseClient?.(lease.clientId);
    } catch {
      logger("warn", "controller client lease cleanup failed");
    }
    options.onLeaseCount?.(leases.size);
    return lease;
  }
  function assertCurrentHttpLease(lease: Lease): Lease {
    const current = leases.get(lease.leaseId);
    if (current !== lease || leaseExpired(lease)) {
      if (current === lease) removeLease(lease.leaseId);
      throw authFailure("session lease has expired or ended");
    }
    if (compromised) throw new HttpBoundaryError("session_stopped", "session is unavailable", 410);
    return current;
  }

  async function readHttpLeaseBody(lease: Lease, request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
    try {
      const body = await readJsonBody(request, maxBytes);
      assertCurrentHttpLease(lease);
      return body;
    } catch (error) {
      const current = leases.get(lease.leaseId);
      if (current !== lease || leaseExpired(lease)) {
        if (current === lease) removeLease(lease.leaseId);
        throw authFailure("session lease has expired or ended");
      }
      throw error;
    }
  }
  function releaseArtifacts(): void {
    for (const { descriptor } of artifactLeases.values()) {
      options.artifactStore.unpin([descriptor]);
      options.artifactStore.release([descriptor]);
    }
    artifactLeases.clear();
    capabilities.clear();
  }


  function origins(): readonly string[] {
    if (!currentAddress) return [];
    const local = buildAllowedOrigins(currentAddress.port, options.allowedOrigins, originHost);
    return externalOrigin === null ? local : [...new Set([...local, externalOrigin])];
  }

  function connectionOrigin(): string {
    return publicOrigin(host, currentAddress?.port ?? requestedPort);
  }

  function assertBrowserAuthority(request: IncomingMessage, requireOrigin = false): void {
    const allowed = origins();
    const origin = singleHeader(request.headers.origin);
    const requestHost = singleHeader(request.headers.host);
    const connectionHost = currentAddress === null ? null : new URL(connectionOrigin()).host;
    if (!currentAddress || requestHost === connectionHost || !validateRequestHost(request.headers, allowed)
      || (origin === null ? requireOrigin : !allowed.includes(origin))) {
      throw new HttpBoundaryError("forbidden_origin", "browser origin not allowed", 403);
    }
  }

  function assertAuthority(request: IncomingMessage, requireOrigin = false): void {
    const allowed = origins();
    const origin = singleHeader(request.headers.origin);
    const requestHost = singleHeader(request.headers.host);
    const native = currentAddress !== null && requestHost === new URL(connectionOrigin()).host && origin === null;
    const browser = currentAddress !== null && !native && validateRequestHost(request.headers, allowed)
      && (origin === null ? !requireOrigin : allowed.includes(origin));
    if (!browser && !native) throw new HttpBoundaryError("forbidden_origin", "origin not allowed", 403);
  }

  function assertArtifactAuthority(request: IncomingMessage): void {
    const allowed = origins();
    const requestHost = singleHeader(request.headers.host);
    const connectionHost = currentAddress === null ? null : new URL(connectionOrigin()).host;
    if (!currentAddress || requestHost === connectionHost || !validateRequestHost(request.headers, allowed)) throw new HttpBoundaryError("forbidden_origin", "host authority is not allowed", 403);
    const origin = singleHeader(request.headers.origin);
    if (origin !== null && origin !== "null" && !allowed.includes(origin)) throw new HttpBoundaryError("forbidden_origin", "origin not allowed", 403);
  }

  function currentIdentity(lease: Lease | null): Record<string, unknown> {
    const browserOrigin = currentAddress?.origin ?? externalOrigin ?? publicOrigin(originHost, 0);
    const address = { host: currentAddress?.host ?? host, port: currentAddress?.port ?? 0, origin: connectionOrigin(), browserOrigin };
    const snapshot = options.controller.snapshot(lease?.clientId);
    const configuration = options.controller.configuration?.() ?? {
      rscript: snapshot.runtime.rEnvironment?.rscript ?? null,
      executionMode: snapshot.runtime.executionMode,
      runOnStartup: snapshot.runtime.runOnStartup,
      deferStartup: false,
    };
    return {
      protocol: HOST_PROTOCOL, epoch: session.epoch, continuityProof, sessionKey: session.sessionKey,
      canonicalPath: session.canonicalPath, capabilities: [...(snapshot.capabilities ?? [])], origin: address.origin,
      browserOrigin: address.browserOrigin,
      address: { host: address.host, port: address.port, origin: address.origin, browserOrigin: address.browserOrigin },
      documentReady: options.documentReady !== false, configuration,
      ...(lease === null ? {} : { leaseId: lease.leaseId, clientId: lease.clientId }),
    };
  }

  function findLease(request: IncomingMessage): { auth: AuthContext; lease: Lease | null } {
    const suppliedBearer = parseBearer(request.headers);
    const cookie = cookieValue(request.headers, cookieName);
    let lease: Lease | null = null;
    let kind: "bearer" | "cookie";
    if (cookie !== null) {
      lease = leases.get(cookie) ?? null;
      if (lease === null || lease.reserved) throw authFailure();
      kind = "cookie";
      if (suppliedBearer !== null && !constantTimeEqual(suppliedBearer, bearer)) throw authFailure();
    } else {
      if (suppliedBearer === null || !constantTimeEqual(suppliedBearer, configuredBearer ?? bearer)) throw authFailure();
      kind = "bearer";
      const suppliedLease = leaseHeader(request.headers);
      if (suppliedLease !== null) lease = leases.get(suppliedLease) ?? null;
    }
    if (lease !== null) {
      const now = Date.now();
      if (lease.lastSeen + leaseExpiryMs <= now) {
        removeLease(lease.leaseId);
        throw authFailure("session lease has expired");
      }
      if (clientHeader(request.headers) !== null && clientHeader(request.headers) !== lease.clientId) throw authFailure("client identity does not match lease");
      lease.lastSeen = now;
    }
    const authenticatedLease = lease;
    return {
      auth: {
        kind,
        leaseId: authenticatedLease?.leaseId ?? null,
        clientId: authenticatedLease?.clientId ?? null,
        csrf: authenticatedLease?.csrf ?? null,
        ...(authenticatedLease === null ? {} : {
          assertActive: () => { assertCurrentHttpLease(authenticatedLease); },
        }),
      },
      lease: authenticatedLease,
    };
  }

  function requireLease(request: IncomingMessage, csrf = true): { auth: AuthContext; lease: Lease } {
    const resolved = findLease(request);
    if (resolved.lease === null) throw authFailure("an active session lease is required");
    if (resolved.auth.kind === "cookie" && csrf) {
      const supplied = csrfHeader(request.headers);
      if (supplied === null || !constantTimeEqual(supplied, resolved.lease.csrf)) throw authFailure("CSRF validation failed");
    }
    if (compromised) throw new HttpBoundaryError("session_stopped", "session is unavailable", 410);
    return { auth: resolved.auth, lease: resolved.lease };
  }

  function createLease(reserved = false): Lease {
    return { leaseId: randomUUID(), clientId: randomUUID(), csrf: randomBytes(32).toString("hex"), lastSeen: Date.now(), reserved };
  }

  function activateLease(lease: Lease): Lease {
    if (leases.size >= MAX_ACTIVE_LEASES) throw new HttpBoundaryError("client_limit", "too many active client leases", 429);
    options.controller.registerClient?.(lease.clientId);
    lease.reserved = false;
    lease.lastSeen = Date.now();
    leases.set(lease.leaseId, lease);
    options.onLeaseCount?.(leases.size);
    return lease;
  }
  function cleanupTicket(ticket: string): void {
    tickets.delete(ticket);
  }

  function mintTicket(origin: string, parentLeaseId?: string): Ticket {
    if (tickets.size >= MAX_LIVE_TICKETS) throw new HttpBoundaryError("ticket_limit", "too many live bootstrap tickets", 429);
    const lease = createLease(true);
    lease.parentLeaseId = parentLeaseId;
    const ticket: Ticket = { ticket: randomBytes(32).toString("hex"), origin, expiresAt: Date.now() + TICKET_TTL_MS, lease };
    tickets.set(ticket.ticket, ticket);
    return ticket;
  }

  function exchangeTicket(ticketValue: string): { ticket: Ticket; lease: Lease } {
    const ticket = tickets.get(ticketValue);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      if (ticket) cleanupTicket(ticketValue);
      throw authFailure("ticket is invalid or expired");
    }
    cleanupTicket(ticketValue);
    if (ticket.lease.parentLeaseId !== undefined) {
      if (!leases.has(ticket.lease.parentLeaseId)) throw authFailure("desktop window is closed");
      for (const previous of [...leases.values()]) {
        if (previous.parentLeaseId === ticket.lease.parentLeaseId) removeLease(previous.leaseId);
      }
    }
    const lease = activateLease(ticket.lease);
    return { ticket, lease };
  }

  function scheduleShutdown(result: CommandResult): void {
    if (result.error || !isPlainObject(result.result) || result.result.closing !== true) return;
    setImmediate(() => {
      void Promise.resolve().then(() => options.onShutdown?.()).catch(error => logger("error", "shutdown callback failed: " + (error instanceof Error ? error.message : "unknown")));
    });
  }

  async function responseEnvelope(value: unknown, snapshot: HostSnapshot): Promise<unknown> {
    const text = JSON.stringify(value);
    const envelopeBytes = Buffer.byteLength(text);
    if (envelopeBytes <= MAX_ENVELOPE_BYTES) return value;
    if (envelopeBytes > SNAPSHOT_ENVELOPE_LIMIT) throw new HttpBoundaryError("payload_too_large", "response envelope exceeds 128 MiB", 413);
    if (!isPlainObject(value)) throw new HttpBoundaryError("payload_too_large", "response envelope exceeds 1 MiB", 413);
    if (value.result === undefined) throw new HttpBoundaryError("payload_too_large", "response envelope exceeds 1 MiB", 413);
    const bytes = Buffer.from(JSON.stringify(value.result));
    const artifact = retainArtifact(await options.artifactStore.writeArtifact(bytes, "application/json", ".json", {
      sessionEpoch: session.epoch,
      documentRevision: snapshot.documentRevision,
      kernelEpoch: null,
      runId: null,
      cellId: null,
      revision: null,
    }));
    return { ...value, result: artifact };
  }

  async function handleArtifact(request: IncomingMessage, response: ServerResponse, target: string): Promise<void> {
    assertArtifactAuthority(request);
    if (request.method !== "GET") { method(response, request.method ?? "", "GET"); return; }
    const requested = parseArtifactTarget(target);
    if (requested === null) throw new HttpBoundaryError("not_found", "not found", 404);
    const entry = capabilities.get(requested.capability);
    if (entry === undefined) throw new HttpBoundaryError("not_found", "not found", 404);
    const now = Date.now();
    const lease = artifactLeases.get(entry.descriptor.handle);
    if (entry.expiresAt <= now || (lease !== undefined && (lease.expiresAt <= now || !sameArtifactHandle(lease.descriptor, entry.descriptor)))) {
      capabilities.delete(requested.capability);
      throw new HttpBoundaryError("output_expired", "artifact capability has expired", 404);
    }
    let currentManifest: ArtifactManifest;
    try {
      currentManifest = options.artifactStore.artifactManifest(entry.descriptor);
    } catch (error) {
      const code = errorPayload(error).code;
      if (code !== "output_expired" && code !== "not_found" && code !== "stale_value") throw error;
      capabilities.delete(requested.capability);
      throw new HttpBoundaryError("output_expired", "artifact capability is no longer valid", 404);
    }
    if (!artifactResourceNameSchema.safeParse(currentManifest.entry).success) {
      throw new HttpBoundaryError("not_found", "not found", 404);
    }
    const issuedRoot = manifestResource(entry.manifest, entry.manifest.entry);
    const currentRoot = manifestResource(currentManifest, currentManifest.entry);
    if (issuedRoot === undefined || currentRoot === undefined || !sameArtifactHandle(issuedRoot, entry.descriptor)
      || !sameArtifactHandle(currentRoot, entry.descriptor)) {
      throw new HttpBoundaryError("output_expired", "artifact capability is no longer valid", 404);
    }
    const issuedMember = manifestResource(entry.manifest, requested.resource);
    const currentMember = manifestResource(currentManifest, requested.resource);
    if (issuedMember === undefined || currentMember === undefined || !sameArtifactHandle(issuedMember, currentMember)) {
      throw new HttpBoundaryError("not_found", "not found", 404);
    }
    let reader: ArtifactResourceRead;
    try {
      reader = options.artifactStore.openArtifactResource(entry.descriptor, requested.resource);
    } catch (error) {
      const code = errorPayload(error).code;
      if (code !== "output_expired" && code !== "not_found" && code !== "stale_value") throw error;
      capabilities.delete(requested.capability);
      throw new HttpBoundaryError("output_expired", "artifact resource is no longer valid", 404);
    }
    if (!sameArtifactHandle(reader.descriptor, currentMember)) {
      reader.close();
      throw new HttpBoundaryError("output_expired", "artifact resource is no longer valid", 404);
    }
    const origin = singleHeader(request.headers.origin);
    const headers: Record<string, string> = {
      "Access-Control-Allow-Origin": origin === "null" ? "null" : (origin ?? "*"),
      "Access-Control-Allow-Credentials": "false",
      "Cache-Control": "no-store",
    };
    if (artifactNeedsChildSandbox(reader.descriptor.mimeType)) {
      headers["Content-Security-Policy"] = artifactChildContentSecurityPolicy(requested.capability, origins());
    }
    await serveArtifactResource(response, reader, headers);
  }

  async function recoveryTransfer(recovery: Recovery, snapshot: HostSnapshot): Promise<Recovery | ArtifactHandle> {
    const wire = encodeRecoveryWire(recovery);
    const bytes = Buffer.from(JSON.stringify(wire));
    if (bytes.byteLength <= MAX_EVENT_BYTES) return wire as Recovery;
    if (bytes.byteLength > SNAPSHOT_ENVELOPE_LIMIT) throw new HttpBoundaryError("payload_too_large", "recovery exceeds 128 MiB", 413);
    return retainArtifact(await options.artifactStore.writeArtifact(bytes, "application/json", ".json", {
      sessionEpoch: session.epoch,
      documentRevision: snapshot.documentRevision,
      kernelEpoch: null,
      runId: null,
      cellId: null,
      revision: null,
    }));
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (shutdown.signal.aborted) throw new HttpBoundaryError("session_stopped", "session has stopped", 410);
    pendingResponses.add(response);
    const target = request.url ?? "/";
    const artifactRequest = target.startsWith("/artifacts/");
    const suppliedBearer = parseBearer(request.headers);
    if (!artifactRequest && suppliedBearer !== null
      && constantTimeEqual(suppliedBearer, configuredBearer ?? bearer)) {
      response.setHeader("X-Alder-Continuity-Proof", continuityProof);
    }
    const suppliedCookie = cookieValue(request.headers, cookieName);
    // Artifact capabilities authenticate the resource independently. Keep
    // opaque-origin artifact loads on that boundary without exposing session
    // continuity material or requiring a browser Origin.
    if (suppliedCookie !== null && !artifactRequest) {
      assertBrowserAuthority(request, request.method !== "GET");
    }
    const cookieLease = suppliedCookie === null ? undefined : leases.get(suppliedCookie);
    if (!artifactRequest && cookieLease !== undefined && !cookieLease.reserved) {
      response.setHeader("X-Alder-Continuity-Proof", continuityProof);
    }
    const suppliedBootstrapTicket = singleHeader(request.headers["x-alder-bootstrap-ticket"]);
    const bootstrapTicket = suppliedBootstrapTicket === null ? undefined : tickets.get(suppliedBootstrapTicket);
    if (!artifactRequest && bootstrapTicket !== undefined && bootstrapTicket.expiresAt > Date.now()) {
      response.setHeader("X-Alder-Continuity-Proof", continuityProof);
    }
    response.once("close", () => pendingResponses.delete(response));
    if (artifactRequest) {
      assertArtifactAuthority(request);
      await handleArtifact(request, response, target);
      return;
    }
    assertAuthority(request);
    let url: URL;
    try { url = new URL(target, currentAddress?.origin ?? publicOrigin(originHost, requestedPort)); }
    catch { throw new HttpBoundaryError("not_found", "not found", 404); }
    const path = url.pathname;
    if (path.startsWith("/artifacts/")) {
      assertArtifactAuthority(request);
      await handleArtifact(request, response, target);
      return;
    }
    if (path === "/" || path === "/index.html") {
      assertBrowserAuthority(request);
      if (!method(response, request.method ?? "", "GET")) return;
      const index = options.indexFile ?? join(options.staticDir, "..", "index.html");
      let html = await readFile(index, "utf8");
      if (!html.includes("__ALDER_CSP_NONCE__")) throw new HttpBoundaryError("internal_error", "bootstrap shell is missing its CSP nonce marker", 500);
      html = html.replaceAll("__ALDER_CSP_NONCE__", nonce);
      const body = Buffer.from(html);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(body.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": editorContentSecurityPolicy(nonce) });
      response.end(body);
      return;
    }
    if (path.startsWith("/static/")) {
      assertBrowserAuthority(request);
      if (!method(response, request.method ?? "", "GET")) return;
      const file = await safeChildPath(options.staticDir, path.slice("/static/".length), STATIC_EXTENSIONS, true);
      if (!file) throw new HttpBoundaryError("not_found", "not found", 404);
      await serveFile(response, file, MIME_TYPES[extname(file).slice(1).toLowerCase()]!);
      return;
    }
    if (path === "/api/ticket") {
      // Native SessionConnection requests use the bound numeric connection
      // origin and bearer from their private request closure. The ticket is
      // nevertheless reserved for the explicitly supplied browser origin.
      assertAuthority(request, true);
      if (!method(response, request.method ?? "", "POST")) return;
      const supplied = parseBearer(request.headers);
      if (supplied === null || !constantTimeEqual(supplied, configuredBearer ?? bearer)) throw authFailure();
      const body = ticketMintRequestSchema.parse(await readJsonBody(request, maxJson));
      const parentLeaseId = body.parentLeaseId;
      if (parentLeaseId !== undefined && requireLease(request, true).lease.leaseId !== parentLeaseId) throw authFailure("desktop lease does not match request");
      const origin = body.origin;
      if (!origins().includes(origin)) throw new HttpBoundaryError("forbidden_origin", "ticket origin is not configured", 403);
      const ticket = mintTicket(origin, parentLeaseId);
      jsonResponse(response, 200, { ticket: ticket.ticket, expiresAt: new Date(ticket.expiresAt).toISOString() });
      return;
    }
    if (path === "/api/session") {
      assertBrowserAuthority(request, true);
      if (!method(response, request.method ?? "", "POST")) return;
      const requestOrigin = singleHeader(request.headers.origin);
      if (requestOrigin === null || !origins().includes(requestOrigin)) throw new HttpBoundaryError("forbidden_origin", "exact session Origin is required", 403);
      const { ticket: ticketValue } = ticketExchangeRequestSchema.parse(await readJsonBody(request, maxJson));
      const ticket = tickets.get(ticketValue);
      if (!ticket || ticket.origin !== requestOrigin) throw authFailure("ticket is invalid or reserved for another origin");
      if (options.acceptingLeases?.() === false) throw new HttpBoundaryError("session_stopping", "notebook host is stopping", 503);
      const exchanged = exchangeTicket(ticketValue);
      const secure = requestOrigin.startsWith("https://");
      const cookie = `${cookieName}=${exchanged.lease.leaseId}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
      const credentials = {
        leaseId: exchanged.lease.leaseId,
        clientId: exchanged.lease.clientId,
        epoch: session.epoch,
        continuityProof,
        csrf: exchanged.lease.csrf,
        ...(session.recoveryId === undefined ? {} : { recoveryId: session.recoveryId }),
      };
      jsonResponse(response, 200, credentials, { "Set-Cookie": cookie });
      return;
    }
    if (path === "/api/identity") {
      if (!method(response, request.method ?? "", "GET")) return;
      const resolved = findLease(request);
      if (resolved.auth.kind === "cookie") requireLease(request, true);
      jsonResponse(response, 200, currentIdentity(resolved.lease));
      return;
    }
    if (path === "/api/lease") {
      if (!method(response, request.method ?? "", "POST")) return;
      const body = await readJsonBody(request, maxJson);
      const action = body.action;
      if (action === "attach") {
        attachLeaseRequestSchema.parse(body);
        const supplied = parseBearer(request.headers);
        if (options.acceptingLeases?.() === false) throw new HttpBoundaryError("session_stopping", "notebook host is stopping", 503);
        if (supplied === null || !constantTimeEqual(supplied, configuredBearer ?? bearer)) throw authFailure();
        const lease = activateLease(createLease());
        jsonResponse(response, 200, { leaseId: lease.leaseId, clientId: lease.clientId, epoch: session.epoch });
        return;
      }
      if (action !== "heartbeat" && action !== "release") throw new HttpBoundaryError("invalid_request", "lease action must be attach, heartbeat, or release", 400);
      const leaseAction = leaseActionRequestSchema.parse(body);
      const resolved = requireLease(request, true);
      if (body.leaseId !== resolved.lease.leaseId) throw authFailure("lease identity does not match request");
      if (action === "release") {
        const disposition = leaseAction.disposition ?? "normal";
        removeLease(resolved.lease.leaseId);
        jsonResponse(response, 200, { released: true });
        if (disposition === "discard" && leases.size === 0) {
          setImmediate(() => { void Promise.resolve(options.onLastLeaseDiscard?.()).catch(error => logger("error", "discard shutdown callback failed: " + (error instanceof Error ? error.message : "unknown"))); });
        }
      } else {
        resolved.lease.lastSeen = Date.now();
        jsonResponse(response, 200, { leaseId: resolved.lease.leaseId, clientId: resolved.lease.clientId, epoch: session.epoch });
      }
      return;
    }

    if (path === "/api/command") {
      if (!method(response, request.method ?? "", "POST")) return;
      const resolved = requireLease(request, true);
      const body = await readHttpLeaseBody(resolved.lease, request, maxSource);
      const command = parseHostCommand(decodeHostCommandWire(body));
      if (command.clientId !== resolved.lease.clientId) throw authFailure("command clientId does not match lease");
      if (command.sessionEpoch !== session.epoch) throw new HttpBoundaryError("session_epoch_mismatch", "command belongs to a different session epoch", 409);
      assertCurrentHttpLease(resolved.lease);
      const release = retainMcpLease(resolved.lease);
      try {
        const result = await options.controller.dispatch(command);
        assertCurrentHttpLease(resolved.lease);
        const bounded = await responseEnvelope(result, options.controller.snapshot(resolved.lease.clientId));
        jsonResponse(response, 200, bounded);
        if (command.type === "shutdown") scheduleShutdown(result);
      } finally { release(); }
      return;
    }
    if (path === "/api/diagnostics/flush") {
      if (!method(response, request.method ?? "", "POST")) return;
      requireLease(request, true);
      await options.flushDiagnostics?.();
      jsonResponse(response, 200, { flushed: true });
      return;
    }
    if (path === "/api/diagnostics/phase") {
      if (!method(response, request.method ?? "", "POST")) return;
      const resolved = requireLease(request, true);
      const body = z.object({
        operationId: z.string().min(1).max(256), runId: z.string().min(1).max(256).nullable(),
        cellId: z.string().min(1).max(256), revision: z.number().int().nonnegative(),
        phase: z.literal("visible-result"), durationMs: z.number().finite().nonnegative().max(24 * 60 * 60 * 1000),
      }).strict().parse(await readJsonBody(request, maxJson));
      options.diagnostics?.record("info", "operation.phase", {
        clientId: resolved.lease.clientId, operationId: body.operationId, runId: body.runId,
        cellId: body.cellId, cellRevision: body.revision, phase: body.phase, durationMs: Math.round(body.durationMs), kind: "run",
      });
      jsonResponse(response, 200, { recorded: true });
      return;
    }
    if (path === "/api/query") {
      if (!method(response, request.method ?? "", "POST")) return;
      const resolved = requireLease(request, true);
      const body = await readHttpLeaseBody(resolved.lease, request, maxJson);
      const query = parseHostQuery(decodeHostQueryWire(body));
      // The notebook lease authorizes this lookup; the controller still requires any clientId to match the execution owner.
      if (query.type === "output") {
        if (acceptsArtifactResolution(request.headers)) {
          assertAuthority(request, true);
          requireLease(request, true);
          const requestedDescriptor = parseArtifactDescriptorHeader(request.headers);
          if (requestedDescriptor.handle !== query.handle) {
            throw new HttpBoundaryError("stale_value", "artifact descriptor does not match the requested handle", 409);
          }
          const manifest = options.artifactStore.artifactManifest(query.handle);
          if (!artifactResourceNameSchema.safeParse(manifest.entry).success) {
            throw new HttpBoundaryError("service_unavailable", "artifact manifest entry is invalid", 503);
          }
          const descriptor = manifestResource(manifest, manifest.entry);
          if (descriptor === undefined || descriptor.handle !== query.handle || !sameArtifactHandle(requestedDescriptor, descriptor)) {
            throw new HttpBoundaryError("stale_value", "artifact descriptor does not match the requested handle", 409);
          }
          assertCurrentHttpLease(resolved.lease);
          const issued = issueArtifactCapability(descriptor, manifest);
          const resolution = artifactResolutionSchema.parse({
            artifact: descriptor,
            url: "/artifacts/" + issued.capability + "/" + manifest.entry,
            expiresAt: issued.expiresAt,
          });
          jsonResponse(response, 200, resolution, {
            "Content-Type": ARTIFACT_RESOLUTION_MEDIA_TYPE,
          });
          return;
        }
        const offset = query.offset ?? 0;
        const limit = query.limit ?? OUTPUT_CHUNK_BYTES;
        assertCurrentHttpLease(resolved.lease);
        const { descriptor, bytes } = await readPublicArtifactPage(options.artifactStore, query.handle, offset, limit);
        assertCurrentHttpLease(resolved.lease);
        const snapshot = options.controller.snapshot(resolved.lease.clientId);
        jsonResponse(response, 200, {
          epoch: session.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor,
          result: { encoding: "base64", offset, nextOffset: offset + bytes.byteLength, eof: offset + bytes.byteLength >= descriptor.byteLength, data: Buffer.from(bytes).toString("base64") },
        });
        return;
      }
      if (!options.controller.query) throw new HttpBoundaryError("service_unavailable", "typed host queries are unavailable", 503);
      if (query.type === "operation" && query.clientId !== undefined && query.clientId !== resolved.lease.clientId) throw authFailure("operation query clientId does not match lease");
      assertCurrentHttpLease(resolved.lease);
      const result = await options.controller.query(query, resolved.lease.clientId);
      assertCurrentHttpLease(resolved.lease);
      const wireResult = encodeHostQueryResultWire(query, result);
      const bounded = await responseEnvelope(wireResult, options.controller.snapshot(resolved.lease.clientId));
      jsonResponse(response, 200, bounded);
      return;
    }

    if (path === "/api/lsp") {
      if (!method(response, request.method ?? "", "POST")) return;
      const resolved = requireLease(request, true);
      void resolved;
      if (!options.lsp) throw new HttpBoundaryError("lsp_unavailable", "language server is unavailable", 503);
      const body = await readHttpLeaseBody(resolved.lease, request, maxJson);
      assertExactFields(body, ["method", "params"], ["method", "params"]);
      const requestedMethod = requiredString(body.method, "method", 128);
      const params = body.params;
      if (!isPlainObject(params)) throw new HttpBoundaryError("invalid_request", "LSP params must be an object", 400);
      const allowed = new Set(["textDocument/completion", "textDocument/hover", "textDocument/definition", "textDocument/references", "textDocument/documentSymbol", "textDocument/signatureHelp", "alder/restart"]);
      if (!allowed.has(requestedMethod)) throw new HttpBoundaryError("invalid_request", "unsupported language-server request", 400);
      const requestSnapshot = options.controller.snapshot();
      assertCurrentHttpLease(resolved.lease);
      const result = requestedMethod === "alder/restart" && options.lsp.restart
        ? await options.lsp.restart(requestSnapshot)
        : await options.lsp.requestDocument(requestedMethod, params, requestSnapshot);
      if (options.controller.snapshot().documentRevision !== requestSnapshot.documentRevision) {
        throw new HttpBoundaryError("document_conflict", "notebook changed during language-server request", 409);
      }
      assertCurrentHttpLease(resolved.lease);
      jsonResponse(response, 200, {
        ok: true,
        epoch: session.epoch,
        documentRevision: requestSnapshot.documentRevision,
        result,
      });
      return;
    }
    if (path === "/api/log") {
      if (!method(response, request.method ?? "", "POST")) return;
      const resolved = requireLease(request, true);
      const body = await readHttpLeaseBody(resolved.lease, request, Math.min(maxJson, 64 * 1024));
      assertExactFields(body, ["level", "message"], ["level", "message"]);
      const level = requiredString(body.level, "level", 32).replace(/[^a-zA-Z0-9_.-]/g, "_");
      const message = requiredString(body.message, "message", 8_192).replace(/[\r\n\0]/g, " ").replace(/[0-9a-f]{64}/gi, "[redacted]");
      assertCurrentHttpLease(resolved.lease);
      logger("warn", `[client:${level}] ${message}`);
      jsonResponse(response, 200, { ok: true });
      return;
    }
    if (path === "/mcp") {
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        response.setHeader("Allow", "POST, GET, DELETE");
        jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: `method not allowed: ${request.method ?? ""}` } });
        return;
      }
      // Require exact host authority and validate an Origin when a client supplies one.
      // Standard bearer Streamable HTTP clients may legitimately omit Origin.
      assertAuthority(request);
      const resolved = requireLease(request, request.method !== "GET");
      if (resolved.auth.kind !== "bearer") throw authFailure("MCP requires bearer authentication");
      if (!options.mcpHandler) throw new HttpBoundaryError("not_found", "not found", 404);
      const releaseMcpLease = retainMcpLease(resolved.lease);
      const release = (): void => {
        response.off("finish", release);
        response.off("close", release);
        request.off("aborted", release);
        releaseMcpLease();
      };
      response.once("finish", release);
      response.once("close", release);
      request.once("aborted", release);
      try {
        await options.mcpHandler(request, response, resolved.auth);
      } finally {
        if (response.writableEnded || response.destroyed) release();
      }
      return;
    }
    throw new HttpBoundaryError("not_found", "not found", 404);
  }

  const server = createHttpServer((request, response) => {
    void handleHttp(request, response).catch(error => {
      const detail = errorPayload(error);
      const pathname = (() => { try { return new URL(request.url ?? "/", "http://localhost").pathname; } catch { return "/"; } })();
      const kind = pathname.startsWith("/artifacts/") ? "artifact"
        : pathname.startsWith("/api/upload") ? "upload"
          : pathname === "/api/query" ? "query"
            : pathname === "/mcp" ? "mcp" : "request";
      const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0]!.toLowerCase();
      const family = /^(text|image|audio|video|application)\//.exec(contentType)?.[1] ?? (contentType ? "other" : "none");
      const declaredBytes = Number(request.headers["content-length"]);
      options.diagnostics?.record(detail.status < 500 ? "warn" : "error", "boundary.rejected", {
        kind, mimeFamily: family, bytes: Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 ? declaredBytes : null,
        status: detail.status, errorCode: detail.code,
        outcome: "error",
      });
      if (response.writableEnded || response.destroyed) return;
      if (!response.headersSent) failResponse(response, error);
      else response.destroy();
    });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: maxSocket, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    if (shutdown.signal.aborted || !currentAddress) { socket.destroy(); return; }
    try { assertBrowserAuthority(request, true); } catch { socket.destroy(); return; }
    let url: URL;
    try { url = new URL(request.url ?? "/", currentAddress.origin); } catch { socket.destroy(); return; }
    if (url.pathname !== "/api/socket") { socket.destroy(); return; }
    let resolved: { auth: AuthContext; lease: Lease };
    try { resolved = requireLease(request, false); } catch { socket.destroy(); return; }
    if (socketsByLease.has(resolved.lease.leaseId)) { socket.destroy(); return; }
    webSockets.handleUpgrade(request, socket, head, webSocket => webSockets.emit("connection", webSocket, request, resolved));
  });

  webSockets.on("connection", (socket: WebSocket, request: IncomingMessage, resolved: { auth: AuthContext; lease: Lease }) => {
    sockets.add(socket);
    socketsByLease.set(resolved.lease.leaseId, socket);
    options.onClientCount?.(sockets.size);
    options.onBrowserActivity?.();
    const outbox = new SocketOutbox(socket, maxOutbox);
    let connected = false;
    let transportClosing = false;
    let closeTimer: NodeJS.Timeout | null = null;
    let unsubscribed = false;
    let unsubscribe: (() => void) | null = null;
    let commandPendingCount = 0;
    let commandPendingBytes = 0;
    const pendingEvents: HostEvent[] = [];
    let pendingEventBytes = 0;
    let eventChain = Promise.resolve();
    let eventPendingCount = 0;
    let eventPendingBytes = 0;
    const handshakeTimer = setTimeout(() => { if (!connected) { socket.close(1008, "connection handshake timed out"); socket.terminate(); } }, 5_000);
    handshakeTimer.unref();
    const closeForBackpressure = (): void => {
      if (transportClosing) return;
      transportClosing = true;
      clearTimeout(handshakeTimer);
      outbox.close();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1013, "transport backpressure");
      closeTimer = setTimeout(() => socket.terminate(), CONNECTION_CLOSE_TIMEOUT_MS);
      closeTimer.unref();
    };
    const requireCurrentLease = (): Lease => {
      const current = leases.get(resolved.lease.leaseId);
      if (current !== resolved.lease || leaseExpired(resolved.lease)) {
        if (current === resolved.lease) {
          removeLease(current.leaseId);
        }
        throw authFailure("session lease has expired or ended");
      }
      return current;
    };
    const sendError = (requestId: unknown, error: unknown, definitive = false): void => {
      const detail = error instanceof HttpBoundaryError ? error : errorPayload(error);
      outbox.send({ type: "error", requestId: typeof requestId === "string" ? requestId : null, definitive, error: { code: detail.code, message: detail.message } });
    };
    const sendCurrentError = (requestId: unknown, error: unknown, definitive = false): void => {
      try {
        requireCurrentLease();
        sendError(requestId, error, definitive);
      } catch {
        // Lease revocation closes the socket; do not publish stale failures.
      }
    };
    const sendEvent = (event: HostEvent): void => {
      if (transportClosing) return;
      const eventBytes = serializedEventBytes(event);
      const accountedBytes = Math.min(eventBytes, maxOutbox);
      if (eventPendingCount >= SOCKET_EVENT_QUEUE_LIMIT || eventPendingBytes + accountedBytes > maxOutbox) {
        closeForBackpressure();
        return;
      }
      eventPendingCount += 1;
      eventPendingBytes += accountedBytes;
      const releaseMcpLease = retainMcpLease(resolved.lease);
      eventChain = eventChain.then(async () => {
        try {
          if (!connected || transportClosing) return;
          requireCurrentLease();
          if (eventBytes > MAX_EVENT_BYTES) {
            const snapshot = options.controller.snapshot(resolved.lease.clientId);
            requireCurrentLease();
            const recovery = await recoveryTransfer({ kind: "snapshot", epoch: snapshot.epoch, cursor: snapshot.cursor, snapshot }, snapshot);
            requireCurrentLease();
            outbox.send({ type: "recovery", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, continuityProof, recovery });
            return;
          }
          requireCurrentLease();
          outbox.send({ type: "event", event: encodeHostEventWire(event) }, coalesceKey(event));
        } finally {
          eventPendingCount -= 1;
          eventPendingBytes -= accountedBytes;
          releaseMcpLease();
        }
      }).catch(error => sendCurrentError(null, error));
    };
    const listener = (event: HostEvent): void => {
      if (transportClosing) return;
      const eventBytes = serializedEventBytes(event);
      if (!connected) {
        if (eventBytes > MAX_EVENT_BYTES) {
          pendingEvents.length = 0;
          pendingEventBytes = 0;
          return;
        }
        if (pendingEvents.length >= SOCKET_EVENT_QUEUE_LIMIT || pendingEventBytes + eventBytes > maxOutbox) {
          closeForBackpressure();
          return;
        }
        pendingEvents.push(event);
        pendingEventBytes += eventBytes;
        return;
      }
      sendEvent(event);
    };
    socket.on("message", (data, binary) => {
      try { requireCurrentLease(); }
      catch (error) { sendError(null, error); socket.close(1008, "session lease ended"); return; }
      let message: Record<string, unknown>;
      try { message = parseSocketObject(data, binary, maxSocket); }
      catch (error) { sendError(null, error); socket.close(1007, "invalid WebSocket message"); return; }
      if (!connected) {
        try {
          const connect = socketConnectSchema.parse(message);
          if (connect.leaseId !== resolved.lease.leaseId || connect.clientId !== resolved.lease.clientId || !constantTimeEqual(connect.csrf, resolved.lease.csrf)) throw authFailure("WebSocket lease or CSRF identity mismatch");
          requireCurrentLease().lastSeen = Date.now();
          unsubscribe = options.controller.subscribe(listener);
          const snapshot = options.controller.snapshot(resolved.lease.clientId);
          const recovery: Recovery = { kind: "snapshot", epoch: snapshot.epoch, cursor: snapshot.cursor, snapshot };
          connected = true;
          clearTimeout(handshakeTimer);
          const releaseMcpLease = retainMcpLease(resolved.lease);
          eventChain = eventChain.then(async () => {
            try {
              requireCurrentLease();
              const transfer = await recoveryTransfer(recovery, snapshot);
              requireCurrentLease();
              outbox.send({ type: "recovery", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, continuityProof, recovery: transfer });
              const cursor = eventCursor(recovery);
              requireCurrentLease();
              for (const event of pendingEvents.splice(0)) {
                pendingEventBytes -= serializedEventBytes(event);
                if (cursor === null || event.cursor > cursor) {
                  requireCurrentLease();
                  outbox.send({ type: "event", event: encodeHostEventWire(event) }, coalesceKey(event));
                }
              }
            } finally {
              releaseMcpLease();
            }
          }).catch(error => sendCurrentError(null, error));
        } catch (error) { sendError(null, error); socket.close(1008, "connection handshake rejected"); }
        return;
      }
      try {
        if (message.type === "ping") { outbox.send({ type: "pong" }); return; }
        if (message.type === "heartbeat") { const lease = requireCurrentLease(); lease.lastSeen = Date.now(); outbox.send({ type: "heartbeat", leaseId: lease.leaseId, epoch: session.epoch }); return; }
        if (message.type === "query") {
          const query = parseHostQuery(decodeHostQueryWire(message.query));
          if (query.type === "output") {
            const offset = query.offset ?? 0;
            const limit = query.limit ?? OUTPUT_CHUNK_BYTES;
            const releaseMcpLease = retainMcpLease(resolved.lease);
            void readPublicArtifactPage(options.artifactStore, query.handle, offset, limit).then(({ descriptor, bytes }) => {
              requireCurrentLease();
              const snapshot = options.controller.snapshot(resolved.lease.clientId);
              requireCurrentLease();
              outbox.send({ type: "queryResult", result: { epoch: session.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor, result: { encoding: "base64", offset, nextOffset: offset + bytes.byteLength, eof: offset + bytes.byteLength >= descriptor.byteLength, data: Buffer.from(bytes).toString("base64") } } });
            }).catch(error => sendCurrentError(null, error)).finally(releaseMcpLease);
            return;
          }
          if (!options.controller.query) throw new HttpBoundaryError("service_unavailable", "typed host queries are unavailable", 503);
          if (query.type === "operation" && query.clientId !== undefined && query.clientId !== resolved.lease.clientId) throw authFailure("operation query clientId does not match lease");
          const queryHandler = options.controller.query;
          if (queryHandler === undefined) throw new HttpBoundaryError("service_unavailable", "typed host queries are unavailable", 503);
          const releaseMcpLease = retainMcpLease(resolved.lease);
          void Promise.resolve().then(() => {
            requireCurrentLease();
            return queryHandler.call(options.controller, query, resolved.lease.clientId);
          }).then(async result => {
            requireCurrentLease();
            const wireResult = encodeHostQueryResultWire(query, result);
            requireCurrentLease();
            const bounded = await responseEnvelope(wireResult, options.controller.snapshot(resolved.lease.clientId));
            requireCurrentLease();
            outbox.send({ type: "queryResult", result: bounded });
          }).catch(error => sendCurrentError(null, error)).finally(releaseMcpLease);
          return;
        }
        if (message.type !== "command" || !isPlainObject(message.command)) throw new HttpBoundaryError("invalid_request", "invalid WebSocket message", 400);
        const command = parseHostCommand(decodeHostCommandWire(message.command));
        if (command.clientId !== resolved.lease.clientId || command.sessionEpoch !== session.epoch) throw authFailure("WebSocket command identity mismatch");
        if (message.requestId !== command.requestId) throw new HttpBoundaryError("invalid_request", "WebSocket request ID mismatch", 400);
        const commandBytes = Buffer.byteLength(JSON.stringify(message.command));
        if (commandPendingCount >= SOCKET_COMMAND_QUEUE_LIMIT || commandPendingBytes + commandBytes > maxOutbox) {
          closeForBackpressure();
          return;
        }
        commandPendingCount += 1;
        commandPendingBytes += commandBytes;
        const releaseMcpLease = retainMcpLease(resolved.lease);
        // Dispatch independently: an outstanding run must not block edit or interrupt.
        void (async () => {
          try {
            if (transportClosing) return;
            requireCurrentLease();
            const result = await options.controller.dispatch(command);
            requireCurrentLease();
            const bounded = await responseEnvelope(result, options.controller.snapshot(resolved.lease.clientId));
            // The result acknowledges its cursor; deliver those source updates first.
            await eventChain;
            requireCurrentLease();
            outbox.send({ type: "commandResult", requestId: command.requestId, result: bounded });
            if (command.type === "shutdown") scheduleShutdown(result);
          } catch (error) {
            sendCurrentError(command.requestId, error);
          } finally {
            commandPendingCount -= 1;
            commandPendingBytes -= commandBytes;
            releaseMcpLease();
          }
        })();
      } catch (error) { sendError(message.requestId, error); }
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (closeTimer !== null) { clearTimeout(closeTimer); closeTimer = null; }
      transportClosing = true;
      outbox.close();
      if (unsubscribe !== null && !unsubscribed) { unsubscribed = true; unsubscribe(); unsubscribe = null; }
      const removed = sockets.delete(socket);
      if (socketsByLease.get(resolved.lease.leaseId) === socket) socketsByLease.delete(resolved.lease.leaseId);
      if (removed) options.onClientCount?.(sockets.size);
    });
    socket.on("error", error => logger("warn", `WebSocket error: ${error.message}`));
    void request;
  });

  async function loadAuthToken(): Promise<void> {
    configuredBearer = options.session?.token !== undefined
      ? validateToken(options.session.token)
      : options.tokenFile === undefined
        ? bearer
        : await readTokenFile(options.tokenFile);
    if (externalOrigin !== null && options.tokenFile === undefined && options.externalBearerValidated === true && options.session?.token === undefined) throw tokenFileError("prevalidated external bearer is missing");
  }

  async function compromise(reason: string): Promise<void> {
    if (compromised) return;
    compromised = true;
    releaseArtifacts();
    try {
      await options.onCompromised?.(reason);
    } finally {
      for (const lease of leases.values()) lease.lastSeen = 0;
      for (const socket of sockets) socket.close(1011, "session compromised");
    }
  }

  return {
    httpServer: server,
    start: async (): Promise<AlderServerAddress> => {
      if (currentAddress) return currentAddress;
      await loadAuthToken();
      await new Promise<void>((resolveStart, rejectStart) => {
        const onError = (error: Error) => rejectStart(error);
        server.once("error", onError);
        server.listen(requestedPort, host, () => { server.off("error", onError); resolveStart(); });
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("host server did not bind");
      currentAddress = { host, port: bound.port, origin: publicOrigin(originHost, bound.port) };
      buildAllowedOrigins(bound.port, options.allowedOrigins, originHost);
      if (externalOrigin !== null) validateOrigin(externalOrigin);
      return currentAddress;
    },
    close: async (): Promise<void> => {
      if (closing) return closing;
      closing = (async () => {
        shutdown.abort();
        try {
          await options.mcpHandler?.closeAll?.();
        } catch {
          logger("warn", "MCP session cleanup failed");
        }
        clearInterval(leaseTimer);
        for (const socket of sockets) { socket.close(1001, "server shutting down"); socket.terminate(); }
        for (const response of pendingResponses) response.destroy();
        releaseArtifacts();
        tickets.clear();
        activeMcpLeases.clear();
        for (const lease of leases.values()) {
          try {
            options.controller.releaseClient?.(lease.clientId);
          } catch {
            logger("warn", "controller client lease cleanup failed");
          }
        }
        leases.clear();
        options.onLeaseCount?.(0);
        if (server.listening) await new Promise<void>(resolveClose => {
          let timer: NodeJS.Timeout | undefined;
          const done = () => { if (timer) clearTimeout(timer); resolveClose(); };
          server.close(() => done());
          timer = setTimeout(() => { server.closeAllConnections(); done(); }, CONNECTION_CLOSE_TIMEOUT_MS);
          timer.unref();
        });
        currentAddress = null;
      })();
      return closing;
    },
    address: () => currentAddress,
    retainArtifact,
    compromise,
  };
}
