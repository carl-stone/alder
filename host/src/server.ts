import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  parseHostCommand,
  SNAPSHOT_ENVELOPE_LIMIT,
  type CommandResult,
  type HostCommand,
  type HostCellState,
  type HostEvent,
  type HostSnapshot,
  type OperationRecord,
  type Recovery,
} from "./protocol.js";

export const HTTP_JSON_LIMIT = 1024 * 1024;
export const HTTP_UPLOAD_LIMIT = 16 * 1024 * 1024;
export const WEBSOCKET_MESSAGE_LIMIT = 1024 * 1024;
export const DEFAULT_OUTBOX_LIMIT = 2 * SNAPSHOT_ENVELOPE_LIMIT;
export const BROWSER_PROTOCOL_VERSION = 1;

const SHUTDOWN_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CONNECTION_CLOSE_TIMEOUT_MS = 1_000;

export interface ControllerAdapter {
  snapshot(): HostSnapshot;
  recover(epoch: string | null, cursor: number | null): Recovery;
  subscribe(listener: (event: HostEvent) => void): () => void;
  dispatch(command: HostCommand): Promise<CommandResult>;
  operation?(id: string): OperationRecord | undefined;
  awaitOperation?(id: string, signal?: AbortSignal): Promise<OperationRecord>;
}

export interface LspAdapter {
  requestDocument(method: string, params: Record<string, unknown>, notebook: unknown): Promise<unknown>;
  restart?(notebook: unknown): Promise<unknown>;
}

export interface AlderServerOptions {
  controller: ControllerAdapter;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  staticDir: string;
  indexFile?: string;
  artifactDir?: string;
  publicDir?: string;
  shutdownToken?: string;
  lsp?: LspAdapter;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  onClientCount?: (count: number) => void;
  onBrowserActivity?: () => void;
  onShutdown?: () => void | Promise<void>;
  maxJsonBytes?: number;
  maxUploadBytes?: number;
  maxWebSocketBytes?: number;
  maxOutboxBytes?: number;
  operationWaitTimeoutMs?: number;
}

export interface AlderServerAddress {
  host: string;
  port: number;
  origin: string;
  shutdownToken: string;
}

export interface AlderServer {
  readonly httpServer: HttpServer;
  start(): Promise<AlderServerAddress>;
  close(): Promise<void>;
  address(): AlderServerAddress | null;
}

export class HttpBoundaryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpBoundaryError";
  }
}

class StrictJsonParser {
  private index = 0;
  private containers = 0;
  private separators = 0;

  constructor(
    private readonly source: string,
    private readonly maxDepth = 128,
    private readonly maxContainers = 10_000,
    private readonly maxSeparators = 100_000,
  ) {}

  parseObjectRoot(): Record<string, unknown> {
    this.space();
    if (this.source[this.index] !== "{") this.fail("JSON body must be an object");
    const value = this.object(1);
    this.space();
    if (this.index !== this.source.length) this.fail("invalid JSON body");
    return value;
  }

  private value(depth: number): unknown {
    if (depth > this.maxDepth) this.fail("JSON body exceeds structural complexity limits");
    this.space();
    const ch = this.source[this.index];
    if (ch === "{") return this.object(depth);
    if (ch === "[") return this.array(depth);
    if (ch === '"') return this.string();
    if (ch === "t") return this.literal("true", true);
    if (ch === "f") return this.literal("false", false);
    if (ch === "n") return this.literal("null", null);
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.container();
    this.index += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.space();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.index] !== '"') this.fail("invalid JSON body");
      const key = this.string();
      if (keys.has(key)) this.fail(`duplicate object key: ${key}`);
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ":") this.fail("invalid JSON body");
      this.index += 1;
      result[key] = this.value(depth + 1);
      this.space();
      const next = this.source[this.index++];
      if (next === "}") return result;
      if (next !== ",") this.fail("invalid JSON body");
      this.separator();
    }
  }

  private array(depth: number): unknown[] {
    this.container();
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth + 1));
      this.space();
      const next = this.source[this.index++];
      if (next === "]") return result;
      if (next !== ",") this.fail("invalid JSON body");
      this.separator();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (!escaped && code === 0x22) {
        this.index += 1;
        let decoded: unknown;
        try {
          decoded = JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.fail("invalid JSON body");
        }
        if (typeof decoded !== "string" || decoded.includes("\0") || hasUnpairedSurrogate(decoded)) {
          this.fail("invalid JSON body");
        }
        return decoded;
      }
      if (!escaped && code < 0x20) this.fail("invalid JSON body");
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    this.fail("invalid JSON body");
  }

  private number(): number {
    const remaining = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (!match) this.fail("invalid JSON body");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("invalid JSON body");
    return value;
  }

  private literal<T>(text: string, value: T): T {
    if (!this.source.startsWith(text, this.index)) this.fail("invalid JSON body");
    this.index += text.length;
    return value;
  }

  private space(): void {
    while (this.index < this.source.length && /[\x20\t\r\n]/.test(this.source[this.index]!)) {
      this.index += 1;
    }
  }

  private container(): void {
    this.containers += 1;
    if (this.containers > this.maxContainers) {
      this.fail("JSON body exceeds structural complexity limits");
    }
  }

  private separator(): void {
    this.separators += 1;
    if (this.separators > this.maxSeparators) {
      this.fail("JSON body exceeds structural complexity limits");
    }
  }

  private fail(message: string): never {
    throw new HttpBoundaryError("invalid_request", message, 400);
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function parseStrictJsonObject(bytes: Uint8Array | string): Record<string, unknown> {
  let source: string;
  if (typeof bytes === "string") {
    source = bytes;
  } else {
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HttpBoundaryError("invalid_request", "invalid JSON body", 400);
    }
  }
  if (source.includes("\0")) {
    throw new HttpBoundaryError("invalid_request", "request body contains NUL bytes", 400);
  }
  return new StrictJsonParser(source).parseObjectRoot();
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = HTTP_JSON_LIMIT,
): Promise<Record<string, unknown>> {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpBoundaryError(
      "unsupported_media_type",
      "Content-Type must be application/json",
      415,
    );
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes) {
      throw new HttpBoundaryError("payload_too_large", bodyLimitMessage(maxBytes), 413);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      request.destroy();
      throw new HttpBoundaryError("payload_too_large", bodyLimitMessage(maxBytes), 413);
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    throw new HttpBoundaryError("invalid_request", "empty request body", 400);
  }
  return parseStrictJsonObject(Buffer.concat(chunks, total));
}

function bodyLimitMessage(maxBytes: number): string {
  return maxBytes % (1024 * 1024) === 0
    ? `request body exceeds ${maxBytes / (1024 * 1024)} MiB`
    : `request body exceeds ${maxBytes} bytes`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function validateLoopbackHost(host: string): string {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("host must be exactly 127.0.0.1, localhost, or ::1");
  }
  return host;
}

export function buildAllowedOrigins(
  port: number,
  origins?: readonly string[],
): readonly string[] {
  if (!origins) {
    return [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ];
  }
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new Error("allowedOrigins must be a nonempty unique array");
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`invalid origin: ${origin}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" ||
      parsed.search !== "" || parsed.hash !== "" || parsed.origin !== origin
    ) {
      throw new Error(`invalid origin: ${origin}`);
    }
  }
  return [...origins];
}

export function validateRequestOrigin(
  headers: IncomingMessage["headers"],
  origins: readonly string[],
): boolean {
  const host = singleHeader(headers.host);
  if (!host) return false;
  const authorities = new Set(origins.map((origin) => new URL(origin).host));
  if (!authorities.has(host)) return false;
  const origin = singleHeader(headers.origin);
  return origin === null || origins.includes(origin);
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isBrowserActivity(headers: IncomingMessage["headers"]): boolean {
  const userAgent = singleHeader(headers["user-agent"]) ?? "";
  const fetchSite = singleHeader(headers["sec-fetch-site"]) ?? "";
  return userAgent.startsWith("Mozilla/")
    || fetchSite === "same-origin"
    || fetchSite === "same-site"
    || fetchSite === "none";
}

export function editorContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: http: https:",
    "script-src 'self'",
    "style-src 'self'",
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ipynb: "application/json",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  qmd: "text/plain; charset=utf-8",
  r: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff2: "font/woff2",
};

const ARTIFACT_CSP = [
  "default-src 'none'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' data: blob: http: https:",
  "font-src 'self' data: http: https:",
  "style-src 'self' 'unsafe-inline' http: https:",
  "script-src 'self' 'unsafe-inline' http: https:",
  "connect-src http: https:",
  "frame-src http: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

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
  if (!relative || relative.includes("\0") || relative.includes("\\") || relative.startsWith("/")) {
    return null;
  }
  const segments = relative.split("/");
  if ((!allowNested && segments.length !== 1) || segments.some((item) => !item || item === "." || item === ".." || item.startsWith("."))) {
    return null;
  }
  const extension = extname(relative).slice(1).toLowerCase();
  if (!allowedExtensions.map((item) => item.toLowerCase()).includes(extension)) return null;
  try {
    const [rootPath, candidatePath] = await Promise.all([
      realpath(root),
      realpath(resolve(root, relative)),
    ]);
    if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${sep}`)) return null;
    const info = await lstat(candidatePath);
    if (!info.isFile()) return null;
    return candidatePath;
  } catch {
    return null;
  }
}

function publicErrorStatus(code: string): number {
  const statuses: Record<string, number> = {
    invalid_request: 400,
    invalid_notebook: 400,
    config_invalid: 400,
    invalid_layout: 400,
    notebook_has_no_path: 400,
    forbidden: 403,
    forbidden_origin: 403,
    not_found: 404,
    method_not_allowed: 405,
    source_conflict: 409,
    save_conflict: 409,
    graph_invalid: 409,
    run_in_progress: 409,
    operation_in_progress: 409,
    operation_id_conflict: 409,
    package_operation_in_progress: 409,
    no_run_in_progress: 409,
    stale_value: 409,
    widget_not_current: 409,
    table_unavailable: 409,
    lazy_expired: 409,
    analysis_pending: 409,
    session_epoch_mismatch: 409,
    alder_save_conflict: 409,
    payload_too_large: 413,
    unsupported_media_type: 415,
    session_stopped: 410,
    format_unavailable: 501,
    worker_unavailable: 503,
    engine_not_ready: 503,
    service_unavailable: 503,
    invalid_service_response: 503,
    lsp_unavailable: 503,
    lsp_timeout: 504,
    operation_timeout: 504,
  };
  return statuses[code] ?? 500;
}

function errorPayload(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof HttpBoundaryError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "internal_error";
    const message = error instanceof Error ? error.message : typeof record.message === "string" ? record.message : "internal server error";
    return { code, message, status: publicErrorStatus(code) };
  }
  return { code: "internal_error", message: "internal server error", status: 500 };
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

function failResponse(response: ServerResponse, error: unknown): void {
  const detail = errorPayload(error);
  jsonResponse(response, detail.status, { ok: false, error: { code: detail.code, message: detail.message } });
}

function method(response: ServerResponse, actual: string, allowed: string): boolean {
  if (actual === allowed) return true;
  response.setHeader("Allow", allowed);
  jsonResponse(response, 405, {
    ok: false,
    error: { code: "method_not_allowed", message: `method not allowed: ${actual}` },
  });
  return false;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function zeroByteBody(request: IncomingMessage, label: string): Promise<void> {
  return new Promise((resolveBody, reject) => {
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
    });
    request.on("end", () => length === 0
      ? resolveBody()
      : reject(new HttpBoundaryError("invalid_request", `${label} requires a zero-byte body`, 400)));
    request.on("error", reject);
  });
}

function commandBase(controller: ControllerAdapter, body: Record<string, unknown>): Pick<HostCommand, "operationId" | "clientId" | "sessionEpoch"> {
  return {
    operationId: typeof body.operationId === "string" ? body.operationId : randomUUID(),
    clientId: typeof body.clientId === "string" ? body.clientId : "http",
    sessionEpoch: typeof body.sessionEpoch === "string" ? body.sessionEpoch : controller.snapshot().epoch,
  };
}

function assertExactFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  const fields = new Set(allowed);
  const extra = Object.keys(body).find((field) => !fields.has(field));
  if (extra !== undefined) {
    throw new HttpBoundaryError("invalid_request", `unknown field: ${extra}`, 400);
  }
  const missing = required.find((field) => !(field in body));
  if (missing !== undefined) {
    throw new HttpBoundaryError("invalid_request", `missing required field: ${missing}`, 400);
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be a string array`, 400);
  }
  if (value.some((item) => typeof item !== "string" || item.includes("\0") || /[\r\n]/.test(item))) {
    throw new HttpBoundaryError("invalid_request", `field ${field} contains invalid strings`, 400);
  }
  return value as string[];
}

function stringArrayOrScalar(value: unknown, field: string): string[] {
  return typeof value === "string" ? [requiredString(value, field)] : stringArray(value, field);
}

function requiredString(value: unknown, field: string, allowControls = false): string {
  if (typeof value !== "string" || !value || value.includes("\0") || (!allowControls && /[\r\n]/.test(value))) {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be a nonempty string`, 400);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be a boolean`, 400);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be a number`, 400);
  }
  return value;
}

function integerField(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (!Number.isSafeInteger(number)) {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be an integer`, 400);
  }
  return number;
}

function revision(value: unknown, field = "expected_revision"): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) {
    throw new HttpBoundaryError("invalid_request", `field ${field} must be a non-negative integer`, 400);
  }
  return value as number;
}

function cellType(value: unknown): "code" | "markdown" {
  if (value !== "code" && value !== "markdown") {
    throw new HttpBoundaryError("invalid_request", "cell type must be code or markdown", 400);
  }
  return value;
}

function legacyCommand(controller: ControllerAdapter, path: string, body: Record<string, unknown>): HostCommand {
  const base = commandBase(controller, {});
  if (path === "/api/cell") {
    const op = requiredString(body.op, "op");
    if (op === "add") {
      assertExactFields(body, ["op", "after", "body", "type"], ["op", "after", "body", "type"]);
      return parseHostCommand({ ...base, type: "create", creations: [{
        clientOperationId: base.operationId,
        after: optionalNullableString(body.after, "after"),
        body: stringArray(body.body, "body"),
        cellType: cellType(body.type),
      }] });
    }
    if (op === "edit") {
      assertExactFields(body, ["op", "id", "body", "type", "expected_revision"], ["op", "id", "body", "type", "expected_revision"]);
      return parseHostCommand({ ...base, type: "edit", edits: [{
        cellId: requiredString(body.id, "id"), body: stringArray(body.body, "body"),
        cellType: cellType(body.type), expectedRevision: revision(body.expected_revision),
      }] });
    }
    if (op === "delete") {
      assertExactFields(body, ["op", "id", "expected_revision"], ["op", "id", "expected_revision"]);
      return parseHostCommand({ ...base, type: "delete", cellId: requiredString(body.id, "id"), expectedRevision: revision(body.expected_revision) });
    }
    if (op === "move") {
      assertExactFields(body, ["op", "cell", "after"], ["op", "cell", "after"]);
      return parseHostCommand({ ...base, type: "move", cellId: requiredString(body.cell, "cell"), after: optionalNullableString(body.after, "after") });
    }
    if (op === "disable") {
      assertExactFields(body, ["op", "cell", "disabled"], ["op", "cell", "disabled"]);
      return parseHostCommand({ ...base, type: "disable", cellId: requiredString(body.cell, "cell"), disabled: booleanField(body.disabled, "disabled") });
    }
    if (op === "name") {
      assertExactFields(body, ["op", "cell", "name"], ["op", "cell", "name"]);
      return parseHostCommand({ ...base, type: "service", command: "rename-cell", payload: {
        cellId: requiredString(body.cell, "cell"), name: optionalNullableString(body.name, "name"),
      } });
    }
    throw new HttpBoundaryError("invalid_request", "field op must be one of edit, add, delete, move, disable, name", 400);
  }
  if (path === "/api/run") {
    const hasCell = "cell" in body;
    const hasAll = "all" in body;
    if (hasCell === hasAll) {
      throw new HttpBoundaryError("invalid_request", "must provide exactly one of `cell` or `all`", 400);
    }
    assertExactFields(body, hasCell ? ["cell", "scope"] : ["all", "scope"], hasCell ? ["cell"] : ["all"]);
    if (hasCell && "scope" in body) {
      throw new HttpBoundaryError("invalid_request", "scope is valid only with `all`", 400);
    }
    if (hasCell) {
      return parseHostCommand({ ...base, type: "run", scope: "cell", cellId: requiredString(body.cell, "cell"), edits: [], creations: [], source: "editor" });
    }
    if (body.all !== true) {
      if (typeof body.all !== "boolean") throw new HttpBoundaryError("invalid_request", "field all must be a boolean", 400);
      throw new HttpBoundaryError("invalid_request", "field all must be exactly TRUE", 400);
    }
    if (body.scope !== undefined && body.scope !== "all" && body.scope !== "stale") {
      throw new HttpBoundaryError("invalid_request", "field scope must be one of all, stale", 400);
    }
    const scope = body.scope === "stale"
      || (body.scope === undefined && controller.snapshot().runtime.executionMode === "lazy")
      ? "stale"
      : "all";
    return parseHostCommand({ ...base, type: "run", scope, edits: [], creations: [], source: "editor" });
  }
  if (path === "/api/interrupt") return parseHostCommand({ ...base, type: "interrupt" });
  if (path === "/api/restart") return parseHostCommand({ ...base, type: "restart", replay: true });
  if (path === "/api/save") return parseHostCommand({ ...base, type: "save" });
  if (path === "/api/widget") {
    assertExactFields(body, ["name", "path", "value", "index", "indices", "selected", "ops", "submit", "paused", "source"], ["name", "source"]);
    const updateFields = ["value", "index", "indices", "selected", "ops", "submit"].filter((key) => key in body);
    if (updateFields.length !== 1) throw new HttpBoundaryError("invalid_request", "provide exactly one widget update field", 400);
    requiredString(body.name, "name");
    if (body.path !== undefined) stringArray(body.path, "path").forEach((item) => requiredString(item, "path"));
    if (updateFields[0] === "index") integerField(body.index, "index");
    if (updateFields[0] === "submit") booleanField(body.submit, "submit");
    if (body.paused !== undefined) booleanField(body.paused, "paused");
    if (body.source !== "editor" && body.source !== "app") {
      throw new HttpBoundaryError("invalid_request", "source must be editor or app", 400);
    }
    const update: Record<string, unknown> = { [updateFields[0]!]: body[updateFields[0]!] };
    if ("paused" in body) update.paused = body.paused;
    return parseHostCommand({ ...base, type: "widget", name: body.name, path: body.path ?? [], update, source: body.source });
  }
  if (path === "/api/value") {
    assertExactFields(body, ["name"], ["name"]);
    return parseHostCommand({ ...base, type: "inspect", name: requiredString(body.name, "name") });
  }
  if (path === "/api/lazy") {
    assertExactFields(body, ["key"], ["key"]);
    return parseHostCommand({ ...base, type: "lazy-output", key: requiredString(body.key, "key") });
  }
  if (path === "/api/table") {
    assertExactFields(body, ["handle", "offset", "limit", "sort_by", "sort_desc", "filter"], ["handle"]);
    const offset = body.offset === undefined ? 0 : finiteNumber(body.offset, "offset");
    const limit = body.limit === undefined ? 25 : finiteNumber(body.limit, "limit");
    if (body.sort_desc !== undefined) booleanField(body.sort_desc, "sort_desc");
    return parseHostCommand({ ...base, type: "table-page", handle: requiredString(body.handle, "handle"),
      offset, limit, sortBy: body.sort_by ?? "", sortDescending: body.sort_desc ?? false,
      filter: body.filter ?? "" });
  }
  if (path === "/api/runtime") {
    assertExactFields(body, ["execution_mode", "run_on_startup"]);
    const executionMode = body.execution_mode === null ? undefined : body.execution_mode;
    const runOnStartup = body.run_on_startup === null ? undefined : body.run_on_startup;
    if (executionMode === undefined && runOnStartup === undefined) {
      throw new HttpBoundaryError("invalid_request", "provide execution_mode or run_on_startup", 400);
    }
    if (executionMode !== undefined && executionMode !== "automatic" && executionMode !== "lazy") {
      throw new HttpBoundaryError("invalid_request", "execution_mode must be automatic or lazy", 400);
    }
    if (runOnStartup !== undefined) booleanField(runOnStartup, "run_on_startup");
    return parseHostCommand({ ...base, type: "set-runtime",
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(runOnStartup === undefined ? {} : { runOnStartup }) });
  }
  if (path === "/api/config") return parseHostCommand({ ...base, type: "set-config", patch: body });
  if (path === "/api/layout") {
    assertExactFields(body, ["version", "layout", "cells", "slides"], ["cells"]);
    if (body.version !== undefined) finiteNumber(body.version, "version");
    if (body.layout !== undefined) requiredString(body.layout, "layout");
    return parseHostCommand({ ...base, type: "set-layout", layout: {
      version: body.version ?? 1,
      cells: body.cells,
      ...(body.layout === undefined ? {} : { layout: body.layout }),
      ...(body.slides === undefined ? {} : { slides: body.slides }),
    } });
  }
  if (path === "/api/format") {
    assertExactFields(body, ["cell", "expected_revisions"]);
    const cell = body.cell === undefined ? undefined : requiredString(body.cell, "cell");
    const selected = cell === undefined
      ? controller.snapshot().cells
      : controller.snapshot().cells.filter((candidate) => candidate.id === cell);
    if (cell !== undefined && selected.length === 0) {
      throw new HttpBoundaryError("not_found", `no such cell: ${cell}`, 404);
    }
    const expectedRevisions = body.expected_revisions === undefined
      ? Object.fromEntries(selected.map((candidate) => [candidate.id, candidate.revision]))
      : body.expected_revisions;
    if (!isPlainObject(expectedRevisions)) {
      throw new HttpBoundaryError("invalid_request", "field expected_revisions must be an object", 400);
    }
    for (const [id, value] of Object.entries(expectedRevisions)) revision(value, `expected_revisions.${id}`);
    return parseHostCommand({ ...base, type: "format", expectedRevisions,
      ...(cell === undefined ? {} : { cellIds: [cell] }) });
  }
  if (path === "/api/app") {
    assertExactFields(body, ["layout", "width", "include_code"]);
    if (Object.keys(body).length === 0) throw new HttpBoundaryError("invalid_request", "app update is empty", 400);
    if (body.layout !== undefined) requiredString(body.layout, "layout");
    if (body.width !== undefined) requiredString(body.width, "width");
    if (body.include_code !== undefined) booleanField(body.include_code, "include_code");
    return parseHostCommand({ ...base, type: "service", command: "set-app", payload: body });
  }
  if (path === "/api/packages") {
    assertExactFields(body, ["op", "package", "packages"], ["op"]);
    const op = requiredString(body.op, "op");
    if (!new Set(["status", "declare", "install"]).has(op)) {
      throw new HttpBoundaryError("invalid_request", "op must be status, declare, or install", 400);
    }
    if (body.package !== undefined) requiredString(body.package, "package");
    const packages = body.packages === undefined
      ? undefined
      : stringArrayOrScalar(body.packages, "packages");
    packages?.forEach((item) => requiredString(item, "packages"));
    if (op === "status" && (body.package !== undefined || body.packages !== undefined)) {
      throw new HttpBoundaryError("invalid_request", "status does not accept package names", 400);
    }
    return parseHostCommand({ ...base, type: "service", command: "packages", payload: {
      ...body,
      ...(packages === undefined ? {} : { packages }),
    } });
  }
  if (path === "/api/export") {
    assertExactFields(body, ["format", "include_code"], ["format"]);
    const format = requiredString(body.format, "format");
    const formats = ["html", "md", "script", "ipynb", "qmd", "session"];
    if (!formats.includes(format)) {
      throw new HttpBoundaryError("invalid_request", `format must be one of ${formats.join(", ")}`, 400);
    }
    if (body.include_code !== undefined) booleanField(body.include_code, "include_code");
    return parseHostCommand({ ...base, type: "service", command: "export", payload: {
      format,
      include_code: body.include_code ?? false,
    } });
  }
  if (path === "/api/check") {
    assertExactFields(body, []);
    return parseHostCommand({ ...base, type: "service", command: "check", payload: {} });
  }
  if (path === "/api/upload") {
    assertExactFields(body, ["name", "path", "files"], ["name", "files"]);
    const name = requiredString(body.name, "name");
    const widgetPath = body.path === undefined ? [] : stringArray(body.path, "path");
    widgetPath.forEach((item) => requiredString(item, "path"));
    if (!Array.isArray(body.files)) throw new HttpBoundaryError("invalid_request", "field files must be an array", 400);
    return parseHostCommand({ ...base, type: "service", command: "upload", payload: {
      name, path: widgetPath, files: body.files, source: "editor",
    } });
  }
  throw new HttpBoundaryError("not_found", "not found", 404);
}

type LegacyAliasKind = "run" | "widget" | "value" | "lazy" | "table" | "upload" | "reset";

interface LegacyOperationAlias {
  publicId: number;
  operationId: string;
  kind: LegacyAliasKind;
  request: Record<string, unknown>;
  resetExpected: boolean;
}

/**
 * The host protocol deliberately uses opaque string operation identities. The
 * retired HTTP API exposed two independent positive-integer namespaces, so
 * this adapter retains bounded aliases instead of leaking or coercing host IDs.
 */
class LegacyOperationAliases {
  private nextRun = 0;
  private nextToken = 0;
  private readonly runs = new Map<number, LegacyOperationAlias>();
  private readonly tokens = new Map<number, LegacyOperationAlias>();
  private readonly byOperation = new Map<string, LegacyOperationAlias>();

  addRun(operationId: string, request: Record<string, unknown> = {}): LegacyOperationAlias {
    return this.add("run", operationId, request, false, true);
  }

  addToken(
    kind: Exclude<LegacyAliasKind, "run">,
    operationId: string,
    request: Record<string, unknown> = {},
    resetExpected = false,
  ): LegacyOperationAlias {
    return this.add(kind, operationId, request, resetExpected, false);
  }

  run(publicId: number): LegacyOperationAlias | undefined {
    return this.runs.get(publicId);
  }

  token(publicId: number): LegacyOperationAlias | undefined {
    return this.tokens.get(publicId);
  }

  forOperation(operationId: string): LegacyOperationAlias | undefined {
    return this.byOperation.get(operationId);
  }

  forHostRun(runId: string): LegacyOperationAlias | undefined {
    for (const alias of this.runs.values()) {
      if (alias.request.runId === runId) return alias;
    }
    return undefined;
  }

  ensureReset(operationId: string): LegacyOperationAlias {
    return this.byOperation.get(operationId)
      ?? this.addToken("reset", operationId);
  }

  private add(
    kind: LegacyAliasKind,
    operationId: string,
    request: Record<string, unknown>,
    resetExpected: boolean,
    run: boolean,
  ): LegacyOperationAlias {
    const existing = this.byOperation.get(operationId);
    if (existing !== undefined) return existing;
    const map = run ? this.runs : this.tokens;
    let publicId = run ? ++this.nextRun : ++this.nextToken;
    if (publicId > 2_147_483_647) {
      if (run) this.nextRun = 1;
      else this.nextToken = 1;
      publicId = 1;
      while (map.has(publicId)) publicId += 1;
    }
    const alias = { publicId, operationId, kind, request: structuredClone(request), resetExpected };
    map.set(publicId, alias);
    this.byOperation.set(operationId, alias);
    while (map.size > 256) {
      const oldest = map.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const removed = map.get(oldest);
      map.delete(oldest);
      if (removed !== undefined && this.byOperation.get(removed.operationId) === removed) {
        this.byOperation.delete(removed.operationId);
      }
    }
    return alias;
  }
}

function positiveIntegerQuery(url: URL, key: "run_id" | "token"): number {
  const message = `query must contain exactly one positive integer ${key}`;
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!raw || /%(?![0-9a-f]{2})/i.test(raw)) {
    throw new HttpBoundaryError("invalid_request", message, 400);
  }
  const parts = raw.split("&");
  if (parts.length !== 1) throw new HttpBoundaryError("invalid_request", message, 400);
  const pair = parts[0]!.split("=");
  if (pair.length !== 2) throw new HttpBoundaryError("invalid_request", message, 400);
  let decodedKey: string;
  let decodedValue: string;
  try {
    decodedKey = decodeURIComponent(pair[0]!);
    decodedValue = decodeURIComponent(pair[1]!);
  } catch {
    throw new HttpBoundaryError("invalid_request", message, 400);
  }
  if (decodedKey !== key || !/^[1-9][0-9]*$/.test(decodedValue)) {
    throw new HttpBoundaryError("invalid_request", message, 400);
  }
  const value = Number(decodedValue);
  if (!Number.isSafeInteger(value) || value > 2_147_483_647) {
    throw new HttpBoundaryError("invalid_request", message, 400);
  }
  return value;
}

function commandPayload(result: CommandResult): Record<string, unknown> {
  return isPlainObject(result.result) ? result.result : {};
}

function legacyOperationStatus(status: OperationRecord["status"]): "pending" | "done" | "error" {
  if (status === "done") return "done";
  if (status === "error" || status === "cancelled") return "error";
  return "pending";
}

function isTerminalOperation(status: OperationRecord["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function legacyRunOperation(
  alias: LegacyOperationAlias,
  operation: OperationRecord,
  aliases: LegacyOperationAliases,
): Record<string, unknown> {
  const resetTokens = (operation.resetOperationIds ?? []).map((id) => aliases.ensureReset(id).publicId);
  return {
    run_id: alias.publicId,
    status: legacyOperationStatus(operation.status),
    reset_tokens: resetTokens,
    error: operation.error ?? null,
  };
}

function legacyWidgetOperation(
  alias: LegacyOperationAlias,
  operation: OperationRecord,
  aliases: LegacyOperationAliases,
): Record<string, unknown> {
  const resets = operation.resetOperationIds ?? [];
  return {
    token: alias.publicId,
    status: legacyOperationStatus(operation.status),
    error: operation.error ?? null,
    reset_expected: alias.resetExpected || resets.length > 0,
    ...(resets.length === 0
      ? {}
      : { reset_token: aliases.ensureReset(resets[resets.length - 1]!).publicId }),
  };
}

function defaultLegacyApp(snapshot: HostSnapshot): Record<string, unknown> {
  const configured = isPlainObject(snapshot.metadata.app) ? snapshot.metadata.app : {};
  return {
    layout: typeof configured.layout === "string" ? configured.layout : "vertical",
    width: typeof configured.width === "string" ? configured.width : "medium",
    include_code: configured.include_code === true,
  };
}

function legacyOutline(snapshot: HostSnapshot): unknown[] {
  return snapshot.cells.map((cell) => ({
    id: cell.id,
    name: typeof cell.options.name === "string" ? cell.options.name : null,
    label: typeof cell.options.name === "string" ? cell.options.name : cell.id,
    type: cell.type,
    status: cell.status,
    defs: [...cell.defs],
    headings: cell.type === "markdown" ? cell.body.flatMap((line, index) => {
      const source = line.replace(/^\s*#\s?/, "");
      const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(source);
      if (!match || !(match[2] ?? "").trim()) return [];
      return [{ cell: cell.id, level: match[1]!.length, text: match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim(), line: index }];
    }) : [],
    diagnostics: structuredClone(cell.diagnostics),
  }));
}

function legacyOutputValue(
  value: unknown,
  aliases: LegacyOperationAliases,
  operationKinds: ReadonlyMap<string, OperationRecord["kind"]>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => legacyOutputValue(item, aliases, operationKinds));
  }
  if (!isPlainObject(value)) return structuredClone(value);
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    projected[key] = legacyOutputValue(child, aliases, operationKinds);
  }
  if (typeof value.operationId === "string"
    && typeof value.status === "string"
    && typeof value.token === "number") {
    let alias = aliases.forOperation(value.operationId);
    if (alias === undefined && operationKinds.get(value.operationId) === "widget-reset") {
      alias = aliases.ensureReset(value.operationId);
    }
    if (alias?.kind === "widget" || alias?.kind === "reset") {
      projected.token = alias.publicId;
      delete projected.operationId;
    }
  }
  return projected;
}

function findLegacyWidget(value: unknown, name: string): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (value.kind === "widget" && value.name === name) return value;
  if (value.kind === "layout" && Array.isArray(value.children)) {
    for (const child of value.children) {
      const widget = findLegacyWidget(child, name);
      if (widget !== null) return widget;
    }
  }
  if (value.kind === "lazy" && value.child !== undefined) {
    return findLegacyWidget(value.child, name);
  }
  return null;
}

function legacyWidgetSpecAt(
  spec: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  if (path.length === 0) return spec;
  if (spec.kind === "form" && isPlainObject(spec.child)) return legacyWidgetSpecAt(spec.child, path);
  if ((spec.kind !== "array" && spec.kind !== "dictionary") || !Array.isArray(spec.children)) return null;
  const child = spec.children.find((candidate) => isPlainObject(candidate) && candidate.name === path[0]);
  return isPlainObject(child) ? legacyWidgetSpecAt(child, path.slice(1)) : null;
}

function legacyWidgetPathHasForm(spec: Record<string, unknown>, path: readonly string[]): boolean {
  if (spec.kind === "form") return true;
  if (path.length === 0
    || (spec.kind !== "array" && spec.kind !== "dictionary")
    || !Array.isArray(spec.children)) return false;
  const child = spec.children.find((candidate) => isPlainObject(candidate) && candidate.name === path[0]);
  return isPlainObject(child) && legacyWidgetPathHasForm(child, path.slice(1));
}

function legacyWidgetResetExpected(snapshot: HostSnapshot, body: Record<string, unknown>): boolean {
  if (typeof body.name !== "string") return false;
  let owner: HostCellState | undefined;
  let widget: Record<string, unknown> | null = null;
  for (const cell of snapshot.cells) {
    for (let index = cell.outputs.length - 1; index >= 0; index -= 1) {
      widget = findLegacyWidget(cell.outputs[index], body.name);
      if (widget !== null) {
        owner = cell;
        break;
      }
    }
    if (widget !== null) break;
  }
  if (owner === undefined || widget === null || !isPlainObject(widget.spec)) return false;
  const path = Array.isArray(body.path) && body.path.every((item) => typeof item === "string")
    ? body.path as string[]
    : [];
  const draft = legacyWidgetPathHasForm(widget.spec, path) && body.submit !== true;
  let target = legacyWidgetSpecAt(widget.spec, path);
  if (target?.kind === "form" && body.submit !== true && isPlainObject(target.child)) target = target.child;
  if (target?.kind !== "run_button" || draft) return false;
  const hasConsumers = snapshot.cells.some((cell) => cell.id !== owner.id
    && [...cell.refs, ...cell.selfRefs].includes(body.name as string));
  return body.source === "app" || snapshot.runtime.executionMode === "automatic" || !hasConsumers;
}

function legacyState(
  snapshot: HostSnapshot,
  aliases: LegacyOperationAliases,
  shutdownToken: string,
  packages: Record<string, unknown>,
): Record<string, unknown> {
  const edges: Record<string, string[]> = Object.fromEntries(snapshot.graph.nodes.map((id) => [id, [...(snapshot.graph.edges[id] ?? [])]]));
  const reverseEdges = Object.fromEntries(snapshot.graph.nodes.map((id) => [id, [...(snapshot.graph.reverseEdges[id] ?? [])]]));
  const nodeInfo = Object.fromEntries(snapshot.cells.map((cell) => [cell.id, {
    id: cell.id,
    name: typeof cell.options.name === "string" ? cell.options.name : null,
    type: cell.type,
    status: cell.status,
    defs: [...cell.defs],
    refs: [...cell.refs],
    diagnostics: structuredClone(cell.diagnostics),
    cycle: snapshot.graph.cycles.includes(cell.id),
  }]));
  const dag = {
    nodes: [...snapshot.graph.nodes],
    node_info: nodeInfo,
    edges,
    reverse_edges: reverseEdges,
    edge_records: snapshot.graph.nodes.flatMap((to) => (edges[to] ?? []).map((from) => ({ from, to }))),
    duplicates: structuredClone(snapshot.graph.duplicates),
    cycles: [...snapshot.graph.cycles],
    cycle_nodes: [...snapshot.graph.cycles],
    topo: snapshot.graph.topologicalOrder === null ? null : [...snapshot.graph.topologicalOrder],
  };
  const cellStatus = new Map(snapshot.cells.map((cell) => [cell.id, cell.status]));
  const variables = snapshot.variables.map((variable) => {
    const summary = variable.valueSummary ?? `${variable.class}${variable.dim === null ? "" : `[${variable.dim.join("x")}]`}`;
    return {
      name: variable.name,
      owner: variable.owner,
      cell: variable.owner,
      revision: variable.revision,
      status: variable.owner === null ? "unbound" : cellStatus.get(variable.owner) ?? "unbound",
      class: variable.class,
      dim: variable.dim,
      size: variable.size,
      widget: variable.widget,
      value_summary: summary,
      summary,
    };
  });
  const outline = legacyOutline(snapshot);
  const reactiveRanges = Object.fromEntries(snapshot.cells.map((cell) => [cell.id, []]));
  const lastValue = isPlainObject(snapshot.lastValue) && typeof snapshot.lastValue.operationId === "string"
    ? {
        ...structuredClone(snapshot.lastValue),
        token: aliases.forOperation(snapshot.lastValue.operationId)?.publicId ?? null,
      }
    : structuredClone(snapshot.lastValue);
  const valueAlias = [...snapshot.operations].reverse().map((operation) => ({
    operation,
    alias: aliases.forOperation(operation.id),
  })).find(({ alias }) => alias?.kind === "value");
  const valueOperation = valueAlias?.alias === undefined ? null : {
    token: valueAlias.alias.publicId,
    name: valueAlias.alias.request.name ?? null,
    owner: commandResultField(valueAlias.operation, "owner") ?? null,
    revision: commandResultField(valueAlias.operation, "revision") ?? null,
    status: legacyOperationStatus(valueAlias.operation.status),
    error: valueAlias.operation.error ?? null,
  };
  const activeRunAlias = snapshot.runtime.activeRunId === null
    ? undefined
    : aliases.forOperation(snapshot.operations.find((operation) => operation.runId === snapshot.runtime.activeRunId)?.id ?? "");
  const activeRun = activeRunAlias?.kind === "run" ? activeRunAlias.publicId : null;
  const operationKinds = new Map(snapshot.operations.map((operation) => [operation.id, operation.kind]));
  const cells = snapshot.cells.map((cell) => ({
    ...structuredClone(cell),
    outputs: legacyOutputValue(cell.outputs, aliases, operationKinds),
    // Keep ordinary host cells byte-for-byte compatible with the typed
    // projection. The retired client only needs this alias for the true case.
    ...(cell.options.disabled === true ? { disabled: true } : {}),
  }));
  return {
    ...structuredClone(snapshot),
    etag: null,
    shutdown_token: shutdownToken,
    runtime: {
      ...structuredClone(snapshot.runtime),
      execution_mode: snapshot.runtime.executionMode,
      run_on_startup: snapshot.runtime.runOnStartup,
      worker_available: snapshot.runtime.kernelAvailable,
      active_run_id: activeRun,
    },
    cells,
    app: defaultLegacyApp(snapshot),
    packages: structuredClone(packages),
    dag: {
      nodes: [...snapshot.graph.nodes], edges,
      duplicates: structuredClone(snapshot.graph.duplicates), cycles: [...snapshot.graph.cycles],
    },
    topo: snapshot.graph.topologicalOrder === null ? null : [...snapshot.graph.topologicalOrder],
    variables,
    editor_diagnostics: structuredClone(snapshot.editorDiagnostics[".document"] ?? []),
    layout_error: null,
    service_errors: structuredClone(snapshot.serviceErrors),
    last_value: lastValue,
    value_operation: valueOperation,
    last_action_error: structuredClone(snapshot.lastActionError),
    outline,
    reactive_ranges: reactiveRanges,
    dataflow: { variables, dag, outline, reactive_ranges: reactiveRanges },
  };
}

function commandResultField(operation: OperationRecord, field: string): unknown {
  return isPlainObject(operation.result) ? operation.result[field] : undefined;
}

function operationFailure(operation: OperationRecord): HttpBoundaryError {
  const code = operation.error?.code ?? "internal_error";
  return new HttpBoundaryError(
    code,
    operation.error?.message ?? "operation failed",
    publicErrorStatus(code),
  );
}

function defaultLegacyPackages(): Record<string, unknown> {
  return {
    declared: [],
    missing: [],
    installing: [],
    installed: [],
    log: "",
    error: {},
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

function packageStateFrom(
  value: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(value)) return structuredClone(fallback);
  const nested = isPlainObject(value.status)
    ? value.status
    : isPlainObject(value.packages)
      ? value.packages
      : value;
  return {
    declared: stringList(nested.declared ?? fallback.declared),
    missing: stringList(nested.missing ?? fallback.missing),
    installing: stringList(nested.installing ?? fallback.installing),
    installed: stringList(nested.installed ?? fallback.installed),
    log: typeof nested.log === "string" ? nested.log : typeof fallback.log === "string" ? fallback.log : "",
    error: isPlainObject(nested.error) ? structuredClone(nested.error) : {},
    ...(typeof nested.lib === "string" || Array.isArray(nested.lib) ? { lib: structuredClone(nested.lib) } : {}),
  };
}

function byteBoundedString(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { allowEmpty?: boolean; allowControls?: boolean } = {},
): string {
  if (typeof value !== "string"
    || (!options.allowEmpty && value.length === 0)
    || value.includes("\0")
    || (!options.allowControls && /[\r\n]/.test(value))
    || Buffer.byteLength(value) > maxBytes) {
    throw new HttpBoundaryError("invalid_request", `field ${field} is invalid`, 400);
  }
  return value;
}

function sanitizeClientLogText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\0/g, " ");
}

function legacyCheckResult(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return { diagnostics: [] };
  if (Array.isArray(value.diagnostics)) return { diagnostics: structuredClone(value.diagnostics) };
  const diagnostics = Array.isArray(value.cells)
    ? value.cells.flatMap((cell) => isPlainObject(cell) && Array.isArray(cell.diagnostics)
      ? cell.diagnostics.map((diagnostic) => ({
          ...(isPlainObject(diagnostic) ? structuredClone(diagnostic) : { message: String(diagnostic) }),
          cell: typeof cell.id === "string" ? cell.id : null,
        }))
      : [])
    : [];
  return { diagnostics };
}

function eventCursor(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const cursor = (event as Record<string, unknown>).cursor;
  return Number.isSafeInteger(cursor) && (cursor as number) >= 0 ? cursor as number : null;
}

function coalesceKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  if (["state", "runtime", "graph", "outline", "variables", "editor-diagnostics", "service-errors"].includes(type)) return type;
  if (type === "diagnostics") {
    const cell = event.cellId;
    return typeof cell === "string" ? `diagnostics:${cell}` : "diagnostics";
  }
  if (["cell", "cellChanged", "cellState", "cellOutputState"].includes(type)) {
    const cell = event.cellId ?? event.id;
    if (isPlainObject(event.payload) && event.payload.deleted === true) return null;
    return typeof cell === "string" ? `${type}:${cell}` : null;
  }
  return null;
}

class SocketOutbox {
  private queue: Array<{ text: string; bytes: number; coalesce: string | null }> = [];
  private queuedBytes = 0;
  private sendingBytes = 0;
  private sending = false;
  private closed = false;
  private terminationTimer: NodeJS.Timeout | null = null;

  constructor(private readonly socket: WebSocket, private readonly maxBytes: number) {}

  send(value: unknown, coalesce: string | null = null): boolean {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    if (bytes > SNAPSHOT_ENVELOPE_LIMIT || bytes > this.maxBytes) return this.fail();
    if (coalesce) {
      let prior = -1;
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index]!.coalesce === null) break;
        if (this.queue[index]!.coalesce === coalesce) {
          prior = index;
          break;
        }
      }
      if (prior >= 0) {
        this.queuedBytes -= this.queue[prior]!.bytes;
        this.queue.splice(prior, 1);
      }
    }
    if (this.sendingBytes + this.queuedBytes + bytes > this.maxBytes) return this.fail();
    this.queue.push({ text, bytes, coalesce });
    this.queuedBytes += bytes;
    this.flush();
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.sendingBytes = 0;
  }

  private fail(): false {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.sendingBytes = 0;
    this.socket.close(1013, "client cannot keep up with notebook events");
    this.terminationTimer = setTimeout(() => this.socket.terminate(), 500);
    this.terminationTimer.unref();
    return false;
  }

  private flush(): void {
    if (this.sending || this.closed || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.queuedBytes -= next.bytes;
    this.sendingBytes = next.bytes;
    this.sending = true;
    this.socket.send(next.text, (error) => {
      this.sending = false;
      this.sendingBytes = 0;
      if (error) {
        this.closed = true;
        this.socket.terminate();
        return;
      }
      this.flush();
    });
  }
}

interface BrowserConnect {
  type: "connect";
  protocolVersion: number;
  clientId: string;
  epoch: string | null;
  cursor: number | null;
}

function parseBrowserConnect(value: unknown): BrowserConnect {
  if (!value || typeof value !== "object") throw new HttpBoundaryError("invalid_request", "first WebSocket message must be connect", 400);
  const row = value as Record<string, unknown>;
  if (
    row.type !== "connect" || row.protocolVersion !== BROWSER_PROTOCOL_VERSION ||
    typeof row.clientId !== "string" || row.clientId.length === 0 || row.clientId.length > 128 ||
    !(row.epoch === null || typeof row.epoch === "string") ||
    !(row.cursor === null || (Number.isSafeInteger(row.cursor) && (row.cursor as number) >= 0))
  ) {
    throw new HttpBoundaryError("invalid_request", "invalid WebSocket connect message", 400);
  }
  return row as unknown as BrowserConnect;
}

function parseSocketJson(data: RawData, isBinary: boolean, maxBytes: number): Record<string, unknown> {
  if (isBinary) throw new HttpBoundaryError("invalid_request", "WebSocket messages must be UTF-8 JSON text", 400);
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buffer.length > maxBytes) throw new HttpBoundaryError("payload_too_large", "WebSocket message is too large", 413);
  return parseStrictJsonObject(buffer);
}

function socketError(outbox: SocketOutbox, sequence: unknown, error: unknown): void {
  const detail = errorPayload(error);
  outbox.send({
    type: "commandError",
    sequence: Number.isSafeInteger(sequence) ? sequence : null,
    error: { code: detail.code, message: detail.message },
  });
}

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

function createShutdownToken(): string {
  let token = "";
  for (let index = 0; index < 48; index += 1) {
    token += SHUTDOWN_TOKEN_ALPHABET[randomInt(SHUTDOWN_TOKEN_ALPHABET.length)];
  }
  return token;
}

export function createAlderServer(options: AlderServerOptions): AlderServer {
  const host = validateLoopbackHost(options.host ?? "127.0.0.1");
  const requestedPort = options.port ?? 8899;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const shutdownToken = options.shutdownToken ?? createShutdownToken();
  const nonce = randomBytes(24).toString("base64url");
  const logger = options.logger ?? (() => undefined);
  const maxJson = options.maxJsonBytes ?? HTTP_JSON_LIMIT;
  const maxUpload = options.maxUploadBytes ?? HTTP_UPLOAD_LIMIT;
  const maxSocket = options.maxWebSocketBytes ?? WEBSOCKET_MESSAGE_LIMIT;
  const maxOutbox = options.maxOutboxBytes ?? DEFAULT_OUTBOX_LIMIT;
  const operationWaitTimeout = options.operationWaitTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(operationWaitTimeout) || operationWaitTimeout <= 0 || operationWaitTimeout > 600_000) {
    throw new Error("operationWaitTimeoutMs must be an integer between 1 and 600000");
  }
  const sockets = new Set<WebSocket>();
  const legacyAliases = new LegacyOperationAliases();
  let legacyPackages = defaultLegacyPackages();
  let currentAddress: AlderServerAddress | null = null;
  let closing: Promise<void> | null = null;
  const pendingApiResponses = new Set<ServerResponse>();
  const shutdown = new AbortController();

  const server = createHttpServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      pendingApiResponses.add(response);
      response.once("close", () => pendingApiResponses.delete(response));
    }
    void handleHttp(request, response).catch((error) => {
      if (response.writableEnded || response.destroyed) return;
      logger("error", `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) failResponse(response, error);
      else response.destroy();
    });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: maxSocket, perMessageDeflate: false });

  function origins(): readonly string[] {
    if (!currentAddress) return [];
    return buildAllowedOrigins(currentAddress.port, options.allowedOrigins);
  }

  async function awaitLegacyOperation(result: CommandResult): Promise<OperationRecord> {
    let operation = result.operation;
    if (!isTerminalOperation(operation.status)) {
      if (!options.controller.awaitOperation) {
        throw new HttpBoundaryError("service_unavailable", "operation waiting is unavailable", 503);
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), operationWaitTimeout);
      timer.unref();
      try {
        operation = await options.controller.awaitOperation(operation.id,
          AbortSignal.any([abort.signal, shutdown.signal]));
      } catch (error) {
        if (shutdown.signal.aborted) throw stoppedError();
        if (abort.signal.aborted) {
          throw new HttpBoundaryError("operation_timeout", "operation wait timed out", 504);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (operation.status === "error" || operation.status === "cancelled") {
      throw operationFailure(operation);
    }
    return operation;
  }

  function trackPackageSettlement(operationId: string): void {
    if (!options.controller.awaitOperation) return;
    void options.controller.awaitOperation(operationId).then((operation) => {
      if (operation.status === "done") {
        legacyPackages = packageStateFrom(operation.result, legacyPackages);
      } else if (operation.error !== null && operation.error !== undefined) {
        legacyPackages = {
          ...legacyPackages,
          installing: [],
          error: structuredClone(operation.error),
        };
      }
    }).catch(() => {});
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (shutdown.signal.aborted) throw stoppedError();
    if (!currentAddress || !validateRequestOrigin(request.headers, origins())) {
      failResponse(response, new HttpBoundaryError("forbidden_origin", "origin not allowed", 403));
      return;
    }
    const actualMethod = request.method ?? "";
    let url: URL;
    try {
      url = new URL(request.url ?? "/", currentAddress.origin);
    } catch {
      failResponse(response, new HttpBoundaryError("not_found", "not found", 404));
      return;
    }
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      if (!method(response, actualMethod, "GET")) return;
      const index = options.indexFile ?? join(options.staticDir, "..", "index.html");
      let html = await import("node:fs/promises").then(({ readFile }) => readFile(index, "utf8"));
      if (!html.includes("__ALDER_CSP_NONCE__")) {
        throw new HttpBoundaryError("internal_error", "editor document is missing its CSP nonce marker", 500);
      }
      html = html.replaceAll("__ALDER_CSP_NONCE__", nonce);
      const body = Buffer.from(html);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": editorContentSecurityPolicy(nonce),
      });
      response.end(body);
      return;
    }
    if (path.startsWith("/static/")) {
      if (!method(response, actualMethod, "GET")) return;
      const relative = path.slice("/static/".length);
      const file = await safeChildPath(options.staticDir, relative, ["js", "css"], relative.startsWith("vendor/"));
      if (!file) throw new HttpBoundaryError("not_found", "not found", 404);
      await serveFile(response, file, MIME_TYPES[extname(file).slice(1).toLowerCase()]!);
      return;
    }
    if (path.startsWith("/public/")) {
      if (!method(response, actualMethod, "GET")) return;
      const file = options.publicDir && await safeChildPath(options.publicDir, path.slice(8), ["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "mp4", "webm", "pdf", "css", "js", "json", "txt", "woff2"], true);
      if (!file) throw new HttpBoundaryError("not_found", "not found", 404);
      const extension = extname(file).toLowerCase();
      await serveFile(response, file, MIME_TYPES[extension.slice(1)]!, {
        ...(extension === ".svg" ? { "Content-Security-Policy": ARTIFACT_CSP, "X-Frame-Options": "SAMEORIGIN" } : {}),
      });
      return;
    }
    if (path.startsWith("/plot/")) {
      if (!method(response, actualMethod, "GET")) return;
      const file = options.artifactDir && await safeChildPath(options.artifactDir, path.slice(6), ["png", "jpg", "jpeg", "gif", "webp", "svg", "html", "mp3", "wav", "ogg", "mp4", "webm", "pdf"]);
      if (!file) throw new HttpBoundaryError("not_found", "not found", 404);
      const extension = extname(file).toLowerCase();
      const activeArtifact = extension === ".html" || extension === ".svg";
      await serveFile(response, file, MIME_TYPES[extension.slice(1)]!, {
        ...(extension === ".svg" ? { "Content-Disposition": "inline" } : {}),
        ...(activeArtifact ? { "Content-Security-Policy": ARTIFACT_CSP, "X-Frame-Options": "SAMEORIGIN" } : {}),
      });
      return;
    }
    if (path.startsWith("/download/")) {
      if (!method(response, actualMethod, "GET")) return;
      const file = options.artifactDir && await safeChildPath(options.artifactDir, path.slice(10), ["html", "md", "r", "ipynb", "qmd", "json"]);
      if (!file) throw new HttpBoundaryError("not_found", "not found", 404);
      await serveFile(response, file, MIME_TYPES[extname(file).slice(1).toLowerCase()]!, { "Content-Disposition": `attachment; filename="${basename(file).replace(/["\r\n]/g, "")}"` });
      return;
    }
    if (path === "/api/state") {
      if (!method(response, actualMethod, "GET")) return;
      if (isBrowserActivity(request.headers)) options.onBrowserActivity?.();
      jsonResponse(response, 200, legacyState(
        options.controller.snapshot(),
        legacyAliases,
        shutdownToken,
        legacyPackages,
      ));
      return;
    }
    if (path === "/api/version") {
      if (!method(response, actualMethod, "GET")) return;
      jsonResponse(response, 200, { ok: true, protocolVersion: BROWSER_PROTOCOL_VERSION, host: "0.1.0" });
      return;
    }
    if (path === "/api/recover") {
      if (!method(response, actualMethod, "GET")) return;
      const epoch = url.searchParams.get("epoch");
      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? null : Number(rawCursor);
      if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) {
        throw new HttpBoundaryError("invalid_request", "cursor must be a non-negative safe integer", 400);
      }
      jsonResponse(response, 200, options.controller.recover(epoch, cursor));
      return;
    }
    if (path === "/api/shutdown") {
      if (!method(response, actualMethod, "POST")) return;
      const supplied = singleHeader(request.headers["x-alder-shutdown-token"]);
      if (!supplied || !constantTimeEqual(supplied, shutdownToken)) {
        throw new HttpBoundaryError("forbidden", "shutdown token is invalid", 403);
      }
      await zeroByteBody(request, "shutdown");
      if (shutdown.signal.aborted) throw stoppedError();
      jsonResponse(response, 202, { ok: true, stopping: true });
      queueMicrotask(() => {
        // The acknowledgement must be flushed before teardown starts, while a
        // rejected asynchronous callback must not become an unhandled process
        // rejection after the response is already committed.
        void Promise.resolve()
          .then(() => options.onShutdown?.())
          .catch((error: unknown) => logger(
            "error",
            `Shutdown callback failed: ${error instanceof Error ? error.message : String(error)}`,
          ));
      });
      return;
    }
    if (path === "/api/operation/wait") {
      if (!method(response, actualMethod, "GET")) return;
      const id = url.searchParams.get("operation_id");
      if (!id || url.searchParams.size !== 1 || !options.controller.awaitOperation) {
        throw new HttpBoundaryError("invalid_request", "query must identify exactly one waitable operation", 400);
      }
      const abort = new AbortController();
      let timeout = false;
      let complete = false;
      const cancel = () => { if (!complete) abort.abort(); };
      request.once("aborted", cancel);
      response.once("close", cancel);
      const timer = setTimeout(() => { timeout = true; abort.abort(); }, operationWaitTimeout);
      timer.unref();
      try {
        const operation = await options.controller.awaitOperation(id, abort.signal);
        complete = true;
        jsonResponse(response, 200, { ok: true, operation });
      } catch (error) {
        if (timeout) throw new HttpBoundaryError("operation_timeout", "operation wait timed out", 504);
        throw error;
      } finally {
        complete = true;
        clearTimeout(timer);
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
      return;
    }
    if (path === "/api/run-operation") {
      if (!method(response, actualMethod, "GET")) return;
      const alias = legacyAliases.run(positiveIntegerQuery(url, "run_id"));
      if (alias === undefined || !options.controller.operation) {
        throw new HttpBoundaryError("not_found", "run operation id was not found", 404);
      }
      const operation = options.controller.operation(alias.operationId);
      if (operation === undefined) throw new HttpBoundaryError("not_found", "run operation id was not found", 404);
      jsonResponse(response, 200, { ok: true, operation: legacyRunOperation(alias, operation, legacyAliases) });
      return;
    }
    if (path === "/api/widget-operation") {
      if (!method(response, actualMethod, "GET")) return;
      const alias = legacyAliases.token(positiveIntegerQuery(url, "token"));
      if (alias === undefined
        || (alias.kind !== "widget" && alias.kind !== "reset")
        || !options.controller.operation) {
        throw new HttpBoundaryError("not_found", "widget operation token was not found", 404);
      }
      const operation = options.controller.operation(alias.operationId);
      if (operation === undefined) throw new HttpBoundaryError("not_found", "widget operation token was not found", 404);
      jsonResponse(response, 200, { ok: true, operation: legacyWidgetOperation(alias, operation, legacyAliases) });
      return;
    }
    if (path === "/api/operation") {
      if (!method(response, actualMethod, "GET")) return;
      const id = url.searchParams.get("operation_id");
      if (!id || url.searchParams.size !== 1 || !options.controller.operation) {
        throw new HttpBoundaryError("invalid_request", "query must identify exactly one operation", 400);
      }
      const operation = options.controller.operation(id);
      if (!operation) throw new HttpBoundaryError("not_found", "operation was not found", 404);
      jsonResponse(response, 200, { ok: true, operation });
      return;
    }
    if (["/api/config", "/api/app", "/api/layout"].includes(path) && actualMethod === "GET") {
      const key = path.slice(5);
      const snapshot = options.controller.snapshot();
      const value = key === "app" ? defaultLegacyApp(snapshot) : snapshot[key as "config" | "layout"];
      jsonResponse(response, 200, { ok: true, [key]: value });
      return;
    }
    if (path === "/api/interrupt" || path === "/api/restart" || path === "/api/save") {
      if (!method(response, actualMethod, "POST")) return;
      await zeroByteBody(request, path.slice(5));
      if (shutdown.signal.aborted) throw stoppedError();
      const result = await options.controller.dispatch(legacyCommand(options.controller, path, {}));
      const payload = commandPayload(result);
      if (path === "/api/save") {
        jsonResponse(response, 200, { ok: true, ...payload, version: result.version });
        return;
      }
      const hostRunId = typeof payload.runId === "string"
        ? payload.runId
        : result.operation.runId;
      let alias = hostRunId === undefined ? undefined : legacyAliases.forHostRun(hostRunId);
      if (alias === undefined && hostRunId !== undefined) {
        const owner = options.controller.snapshot().operations.find((operation) => operation.runId === hostRunId);
        alias = legacyAliases.addRun(owner?.id ?? result.operation.id, { runId: hostRunId });
      }
      jsonResponse(response, 202, { ok: true, run_id: alias?.publicId ?? null });
      return;
    }
    if (path === "/api/lsp") {
      if (!method(response, actualMethod, "POST")) return;
      if (!options.lsp) throw new HttpBoundaryError("lsp_unavailable", "language server is unavailable", 503);
      const body = await readJsonBody(request, maxJson);
      if (shutdown.signal.aborted) throw stoppedError();
      assertExactFields(body, ["method", "params"], ["method", "params"]);
      const requestedMethod = body.method;
      const params = body.params;
      const allowed = new Set(["textDocument/completion", "textDocument/hover", "textDocument/definition", "textDocument/references", "textDocument/documentSymbol", "textDocument/signatureHelp", "alder/restart"]);
      if (typeof requestedMethod !== "string" || !allowed.has(requestedMethod) || !isPlainObject(params)) {
        throw new HttpBoundaryError("invalid_request", "unsupported language-server request", 400);
      }
      const result = requestedMethod === "alder/restart" && options.lsp.restart
        ? await options.lsp.restart(options.controller.snapshot())
        : await options.lsp.requestDocument(requestedMethod, params, options.controller.snapshot());
      jsonResponse(response, 200, { ok: true, result });
      return;
    }
    if (path === "/api/log") {
      if (!method(response, actualMethod, "POST")) return;
      const body = await readJsonBody(request, maxJson);
      if (shutdown.signal.aborted) throw stoppedError();
      assertExactFields(body, ["level", "message", "source", "code", "status", "url", "stack"], ["level", "message"]);
      const level = byteBoundedString(body.level, "level", 32, { allowControls: true });
      const message = byteBoundedString(body.message, "message", 8192, { allowControls: true });
      const source = body.source === undefined
        ? ""
        : byteBoundedString(body.source, "source", 256, { allowEmpty: true, allowControls: true });
      const code = body.code === undefined
        ? null
        : byteBoundedString(body.code, "code", 128);
      const urlValue = body.url === undefined
        ? ""
        : byteBoundedString(body.url, "url", 4096, { allowEmpty: true, allowControls: true });
      const stack = body.stack === undefined
        ? ""
        : byteBoundedString(body.stack, "stack", 16_384, { allowEmpty: true, allowControls: true });
      let status: number | null = null;
      if (body.status !== undefined) {
        status = integerField(body.status, "status");
        if (status !== 0 && (status < 100 || status > 599)) {
          throw new HttpBoundaryError("invalid_request", "field status must be 0 or an HTTP status from 100 to 599", 400);
        }
      }
      const attributes = [
        ...(source ? [`source=${sanitizeClientLogText(source)}`] : []),
        ...(code === null ? [] : [`code=${sanitizeClientLogText(code)}`]),
        ...(status === null ? [] : [`status=${status}`]),
        ...(urlValue ? [`url=${sanitizeClientLogText(urlValue)}`] : []),
        ...(stack ? [`stack=${sanitizeClientLogText(stack)}`] : []),
      ];
      process.stderr.write(
        `[client:${sanitizeClientLogText(level)}] ${sanitizeClientLogText(message)}`
        + (attributes.length === 0 ? "" : ` | ${attributes.join(" ")}`)
        + "\n",
      );
      jsonResponse(response, 200, { ok: true, logged: true });
      return;
    }
    const postRoutes = new Set(["/api/command", "/api/run", "/api/lazy", "/api/table", "/api/cell", "/api/widget", "/api/upload", "/api/value", "/api/runtime", "/api/config", "/api/app", "/api/layout", "/api/packages", "/api/format", "/api/export", "/api/check"]);
    if (!postRoutes.has(path)) throw new HttpBoundaryError("not_found", "not found", 404);
    if (!method(response, actualMethod, "POST")) return;
    const body = await readJsonBody(request, path === "/api/upload" ? maxUpload : maxJson);
    if (shutdown.signal.aborted) throw stoppedError();
    const command = path === "/api/command" ? parseHostCommand(body) : legacyCommand(options.controller, path, body);
    const result = await options.controller.dispatch(command);
    if (path === "/api/command") {
      jsonResponse(response, acceptedStatus(result), { ok: true, ...result });
      return;
    }
    const payload = commandPayload(result);
    if (path === "/api/run") {
      const runId = typeof payload.runId === "string" ? payload.runId : result.operation.runId;
      if (runId === undefined) throw new HttpBoundaryError("internal_error", "run did not return an identity", 500);
      const alias = legacyAliases.addRun(result.operation.id, { runId });
      jsonResponse(response, 202, { ok: true, run_id: alias.publicId });
      return;
    }
    if (["/api/widget", "/api/value", "/api/lazy", "/api/table", "/api/upload"].includes(path)) {
      const kind: Exclude<LegacyAliasKind, "run" | "reset"> = path === "/api/widget"
        ? "widget"
        : path === "/api/value"
          ? "value"
          : path === "/api/lazy"
            ? "lazy"
            : path === "/api/table"
              ? "table"
              : "upload";
      // Alias records outlive the request. Retain only the small identity
      // fields needed by legacy state; upload contents can approach 16 MiB.
      const aliasRequest = {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.key === "string" ? { key: body.key } : {}),
        ...(typeof body.handle === "string" ? { handle: body.handle } : {}),
        ...(typeof payload.owner === "string" ? { owner: payload.owner } : {}),
        ...(typeof payload.revision === "number" ? { revision: payload.revision } : {}),
      };
      const resetExpected = kind === "widget"
        && legacyWidgetResetExpected(options.controller.snapshot(), body);
      const alias = legacyAliases.addToken(kind, result.operation.id, aliasRequest, resetExpected);
      jsonResponse(response, 202, { ok: true, token: alias.publicId });
      return;
    }
    if (path === "/api/cell") {
      const op = body.op;
      let projection: Record<string, unknown>;
      if (op === "add") {
        const created = Array.isArray(payload.created) && isPlainObject(payload.created[0]) ? payload.created[0] : {};
        projection = { id: created.id, revision: created.revision };
      } else if (op === "edit") {
        const edited = Array.isArray(payload.edited) && isPlainObject(payload.edited[0]) ? payload.edited[0] : {};
        projection = { id: edited.id, revision: edited.revision };
      } else if (op === "disable") {
        const runId = typeof payload.runId === "string" ? payload.runId : null;
        const runAlias = runId === null
          ? null
          : legacyAliases.addRun(result.operation.id, { runId }).publicId;
        projection = { id: payload.id, disabled: payload.disabled, run_id: runAlias };
      } else {
        projection = structuredClone(payload);
      }
      jsonResponse(response, 200, { ok: true, ...projection, version: result.version });
      return;
    }
    if (path === "/api/runtime") {
      jsonResponse(response, 200, {
        ok: true,
        execution_mode: payload.executionMode,
        run_on_startup: payload.runOnStartup,
        version: result.version,
      });
      return;
    }
    if (path === "/api/config" || path === "/api/app" || path === "/api/layout") {
      const key = path.slice(5);
      jsonResponse(response, 200, { ok: true, [key]: payload[key], version: result.version });
      return;
    }
    if (path === "/api/format") {
      jsonResponse(response, 200, {
        ok: true,
        changed: payload.changed ?? 0,
        version: result.version,
        cells: payload.cells ?? payload.edited ?? [],
      });
      return;
    }
    if (path === "/api/check") {
      jsonResponse(response, 200, { ok: true, ...legacyCheckResult(payload) });
      return;
    }
    if (path === "/api/export") {
      const operation = await awaitLegacyOperation(result);
      const completed = isPlainObject(operation.result) ? operation.result : {};
      jsonResponse(response, 200, {
        ok: true,
        download: typeof completed.url === "string" ? completed.url : completed.download,
        format: completed.format ?? body.format,
      });
      return;
    }
    if (path === "/api/packages") {
      const packageOperation = body.op;
      if (packageOperation === "install") {
        const supplied = [
          ...(typeof body.package === "string" ? [body.package] : []),
          ...(typeof body.packages === "string" ? [body.packages] : stringList(body.packages)),
        ];
        const packages = [...new Set(supplied.length === 0 ? stringList(legacyPackages.missing) : supplied)].sort();
        legacyPackages = { ...legacyPackages, installing: packages, error: {} };
        trackPackageSettlement(result.operation.id);
        jsonResponse(response, 202, {
          ok: true,
          packages,
          installed: stringList(legacyPackages.installed),
          missing: stringList(legacyPackages.missing),
          installing: packages,
          ...(legacyPackages.lib === undefined ? {} : { lib: structuredClone(legacyPackages.lib) }),
        });
        return;
      }
      const operation = await awaitLegacyOperation(result);
      legacyPackages = packageStateFrom(operation.result, legacyPackages);
      if (packageOperation === "status") {
        jsonResponse(response, 200, { ok: true, packages: structuredClone(legacyPackages) });
        return;
      }
      const settled = isPlainObject(operation.result) ? operation.result : {};
      const declaration = isPlainObject(settled.declaration) ? settled.declaration : settled;
      jsonResponse(response, 200, {
        ok: true,
        packages: stringList(declaration.declared ?? body.packages ?? (body.package === undefined ? [] : [body.package])),
        path: declaration.metadata ?? null,
      });
      return;
    }
    throw new HttpBoundaryError("not_found", "not found", 404);
  }

  server.on("upgrade", (request, socket, head) => {
    if (shutdown.signal.aborted) {
      socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!currentAddress || !validateRequestOrigin(request.headers, origins())) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    let path = "";
    try {
      path = new URL(request.url ?? "/", currentAddress.origin).pathname;
    } catch {
      // handled below
    }
    if (path !== "/api/socket") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
  });

  webSockets.on("connection", (socket) => {
    sockets.add(socket);
    options.onClientCount?.(sockets.size);
    let forceCloseTimer: NodeJS.Timeout | null = null;
    const closePeer = (code: number, reason: string): void => {
      socket.close(code, reason);
      if (forceCloseTimer) return;
      forceCloseTimer = setTimeout(() => socket.terminate(), 500);
      forceCloseTimer.unref();
    };
    const outbox = new SocketOutbox(socket, maxOutbox);
    let connected = false;
    let clientId = "";
    let lastSequence = -1;
    let commandChain = Promise.resolve();
    let unsubscribe: (() => void) | null = null;
    const pendingEvents: HostEvent[] = [];
    let pendingEventBytes = 0;
    const handshakeTimer = setTimeout(() => {
      if (!connected) closePeer(1008, "connection handshake timed out");
    }, 5_000);
    handshakeTimer.unref();
    const listener = (event: HostEvent) => {
      if (!connected) {
        const key = coalesceKey(event);
        if (key) {
          for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {
            const candidateKey = coalesceKey(pendingEvents[index]);
            if (candidateKey === null) break;
            if (candidateKey === key) {
              pendingEventBytes -= Buffer.byteLength(JSON.stringify(pendingEvents[index]));
              pendingEvents.splice(index, 1);
              break;
            }
          }
        }
        pendingEvents.push(event);
        pendingEventBytes += Buffer.byteLength(JSON.stringify(event));
        if (pendingEventBytes > maxOutbox) {
          pendingEvents.length = 0;
          pendingEventBytes = 0;
          unsubscribe?.();
          unsubscribe = null;
          closePeer(1013, "recovery event buffer exceeded");
        }
        return;
      }
      outbox.send({ type: "event", event }, coalesceKey(event));
    };
    unsubscribe = options.controller.subscribe(listener);
    socket.on("message", (data, isBinary) => {
      let message: Record<string, unknown>;
      try {
        message = parseSocketJson(data, isBinary, maxSocket);
      } catch (error) {
        socketError(outbox, null, error);
        closePeer(1007, "invalid WebSocket message");
        return;
      }
      if (!connected) {
        try {
          const connect = parseBrowserConnect(message);
          clientId = connect.clientId;
          const recovery = options.controller.recover(connect.epoch, connect.cursor);
          connected = true;
          clearTimeout(handshakeTimer);
          outbox.send({ type: "recovery", protocolVersion: BROWSER_PROTOCOL_VERSION, recovery });
          const recoveredCursor = recovery && typeof recovery === "object" ? eventCursor(recovery) : null;
          for (const event of pendingEvents.splice(0)) {
            const cursor = eventCursor(event);
            if (recoveredCursor === null || cursor === null || cursor > recoveredCursor) {
              outbox.send({ type: "event", event }, coalesceKey(event));
            }
          }
        } catch (error) {
          socketError(outbox, null, error);
          closePeer(1008, "connection handshake rejected");
        }
        return;
      }
      if (message.type === "ping") {
        outbox.send({ type: "pong" });
        return;
      }
      const sequence = message.sequence;
      const command = message.command;
      if (message.type !== "command" || !Number.isSafeInteger(sequence) || (sequence as number) <= lastSequence || !isPlainObject(command)) {
        socketError(outbox, sequence, new HttpBoundaryError("invalid_request", "invalid or out-of-order WebSocket command", 400));
        return;
      }
      lastSequence = sequence as number;
      let enriched: HostCommand;
      try {
        enriched = parseHostCommand({ ...command, clientId });
      } catch (error) {
        socketError(outbox, sequence, error);
        return;
      }
      commandChain = commandChain.then(async () => {
        try {
          const result = await options.controller.dispatch(enriched);
          outbox.send({ type: "commandResult", sequence, result });
        } catch (error) {
          socketError(outbox, sequence, error);
        }
      });
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      forceCloseTimer = null;
      const removed = sockets.delete(socket);
      unsubscribe?.();
      unsubscribe = null;
      outbox.close();
      if (removed) options.onClientCount?.(sockets.size);
    });
    socket.on("error", (error) => logger("warn", `WebSocket error: ${error.message}`));
  });

  return {
    httpServer: server,
    start: async () => {
      if (currentAddress) return currentAddress;
      await new Promise<void>((resolveStart, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(requestedPort, host, () => {
          server.off("error", onError);
          resolveStart();
        });
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("server did not expose a TCP address");
      const originHost = host === "::1" ? "[::1]" : host;
      currentAddress = { host, port: bound.port, origin: `http://${originHost}:${bound.port}`, shutdownToken };
      buildAllowedOrigins(bound.port, options.allowedOrigins);
      return currentAddress;
    },
    close: async () => {
      if (closing) return closing;
      shutdown.abort();
      for (const response of pendingApiResponses) {
        if (!response.headersSent) {
          response.setHeader("Connection", "close");
          failResponse(response, stoppedError());
        }
      }
      closing = (async () => {
        for (const socket of sockets) socket.close(1001, "server shutting down");
        await new Promise<void>((resolveClose) => {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          const done = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolveClose();
          };
          webSockets.close(done);
          timer = setTimeout(() => {
            for (const socket of sockets) socket.terminate();
            done();
          }, CONNECTION_CLOSE_TIMEOUT_MS);
          timer.unref();
        });
        if (server.listening) await new Promise<void>((resolveClose, reject) => {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          const done = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (error) reject(error);
            else resolveClose();
          };
          // Stop accepting first, then force any client that is no longer
          // reading a streamed artifact after the bounded drain interval.
          server.close((error) => done(error ?? undefined));
          timer = setTimeout(() => {
            server.closeAllConnections();
            done();
          }, CONNECTION_CLOSE_TIMEOUT_MS);
          timer.unref();
        });
        currentAddress = null;
      })();
      return closing;
    },
    address: () => currentAddress,
  };
}

function stoppedError(): HttpBoundaryError {
  return new HttpBoundaryError("session_stopped", "Alder session has stopped", 410);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acceptedStatus(value: unknown): number {
  if (!isPlainObject(value)) return 200;
  const status = value.status;
  return status === "accepted" || status === "pending" || status === 202 ? 202 : 200;
}
