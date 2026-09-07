import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { BrowserDocument } from "./browser/document.js";
import type { McpControllerAdapter } from "./mcp.js";
import {
  commandResultSchema,
  decodeJsonFrame,
  hostEventSchema,
  recoverySchema,
  SNAPSHOT_ENVELOPE_LIMIT,
  type CommandResult,
  type HostCommand,
  type HostEvent,
  type HostSnapshot,
  type OperationRecord,
  type Recovery,
} from "./protocol.js";

export interface RemoteController extends McpControllerAdapter {
  subscribe(listener: (event: HostEvent) => void): () => void;
  close(): Promise<void>;
}

interface PendingCommand {
  command: HostCommand;
  sent: boolean;
  resolve(result: CommandResult): void;
  reject(error: Error): void;
}

interface OperationWaiter {
  resolve(operation: OperationRecord): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class RemoteControllerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteControllerError";
  }
}

class WebSocketRemoteController implements RemoteController {
  private socket: WebSocket | null = null;
  private document: BrowserDocument | null = null;
  private readonly operations = new Map<string, OperationRecord>();
  private readonly waiters = new Map<string, Set<OperationWaiter>>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly pending = new Map<number, PendingCommand>();
  private sequence = 0;
  private recovered = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly clientId = `mcp-proxy-${randomUUID()}`;
  private resolveInitial!: () => void;
  private rejectInitial!: (error: Error) => void;
  readonly ready: Promise<void>;

  constructor(private readonly socketUrl: URL, private readonly origin: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveInitial = resolve;
      this.rejectInitial = reject;
    });
    this.open();
  }

  snapshot(): HostSnapshot {
    if (!this.document) throw new RemoteControllerError("not_ready", "remote notebook snapshot has not arrived");
    const snapshot = this.document.snapshot;
    return { ...snapshot, operations: [...this.operations.values()].map(clone) };
  }

  dispatch(command: HostCommand): Promise<CommandResult> {
    if (this.stopped) return Promise.reject(new RemoteControllerError("connection_closed", "remote controller is closed"));
    if (this.pending.size >= 1_000) return Promise.reject(new RemoteControllerError("client_backpressure", "too many remote commands are pending"));
    const sequence = ++this.sequence;
    return new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(sequence, { command, sent: false, resolve, reject });
      this.flush();
    });
  }

  operation(id: string): OperationRecord | undefined {
    const operation = this.operations.get(id);
    return operation ? clone(operation) : undefined;
  }

  awaitOperation(id: string, signal?: AbortSignal): Promise<OperationRecord> {
    const current = this.operations.get(id);
    if (current && settled(current)) return Promise.resolve(clone(current));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<OperationRecord>((resolve, reject) => {
      const waiter: OperationWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          this.removeWaiter(id, waiter);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      const entries = this.waiters.get(id) ?? new Set<OperationWaiter>();
      entries.add(waiter);
      this.waiters.set(id, entries);
    });
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const failure = new RemoteControllerError("connection_closed", "remote controller is closed");
    this.rejectInitial(failure);
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    this.rejectWaiters(failure);
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 500);
      timer.unref();
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close(1000, "MCP proxy closed");
    });
  }

  private open(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.socketUrl, {
      origin: this.origin,
      maxPayload: SNAPSHOT_ENVELOPE_LIMIT,
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
    });
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) return;
      const snapshot = this.document?.snapshot;
      socket.send(JSON.stringify({
        type: "connect",
        protocolVersion: 1,
        clientId: this.clientId,
        epoch: snapshot?.epoch ?? null,
        cursor: snapshot?.cursor ?? null,
      }));
    });
    socket.on("message", (data, binary) => {
      if (this.socket !== socket || this.stopped) return;
      try { this.receive(data, binary); }
      catch (error) {
        const failure = asError(error);
        if (!this.document) this.rejectInitial(failure);
        socket.close(1002, failure.message.slice(0, 120));
      }
    });
    socket.on("error", (error) => {
      if (!this.document) this.rejectInitial(error);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.recovered = false;
      for (const command of this.pending.values()) command.sent = false;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private receive(data: RawData, binary: boolean): void {
    if (binary) throw new RemoteControllerError("invalid_server_message", "remote host sent a binary frame");
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    let message: Record<string, unknown>;
    try {
      const parsed = decodeJsonFrame(bytes, SNAPSHOT_ENVELOPE_LIMIT);
      if (!isObject(parsed)) throw new Error("frame is not an object");
      message = parsed;
    } catch (error) {
      throw new RemoteControllerError("invalid_server_message", asError(error).message);
    }
    if (message.type === "recovery") {
      if (message.protocolVersion !== 1) throw new RemoteControllerError("protocol_mismatch", "MCP proxy and host protocol versions do not match");
      this.applyRecovery(parseRecovery(message.recovery));
      this.recovered = true;
      this.reconnectAttempt = 0;
      this.resolveInitial();
      this.flush();
      return;
    }
    if (!this.recovered) throw new RemoteControllerError("invalid_server_message", "remote host sent data before recovery");
    if (message.type === "event") {
      const event = parseEvent(message.event);
      if (!this.document || event.epoch !== this.document.epoch || event.cursor <= this.document.cursor) return;
      this.document.applyEvent(event);
      this.captureOperation(event.payload);
      for (const listener of this.listeners) listener(event);
      return;
    }
    if (message.type === "commandResult") {
      if (!Number.isSafeInteger(message.sequence)) throw new RemoteControllerError("invalid_server_message", "command result has no sequence");
      const sequence = message.sequence as number;
      const pending = this.pending.get(sequence);
      if (!pending) return;
      const result = parseResult(message.result);
      this.pending.delete(sequence);
      this.captureOperation(result.operation);
      pending.resolve(result);
      return;
    }
    if (message.type === "commandError") {
      const sequence = message.sequence;
      const detail = object(message.error);
      const error = new RemoteControllerError(string(detail.code) || "internal_error", string(detail.message) || "remote command failed");
      if (Number.isSafeInteger(sequence)) {
        const pending = this.pending.get(sequence as number);
        if (pending) {
          this.pending.delete(sequence as number);
          pending.reject(error);
        }
      }
      return;
    }
    if (message.type !== "pong") throw new RemoteControllerError("invalid_server_message", "unknown remote host frame");
  }

  private applyRecovery(recovery: Recovery): void {
    if (recovery.kind === "snapshot") {
      if (this.document !== null && this.document.epoch !== recovery.snapshot.epoch) {
        this.rejectWaiters(new RemoteControllerError(
          "session_replaced",
          "remote notebook session was replaced while the operation was pending",
        ));
      }
      this.document = new BrowserDocument(recovery.snapshot);
      this.operations.clear();
      recovery.snapshot.operations.forEach((operation) => this.captureOperation(operation));
      return;
    }
    if (!this.document) throw new RemoteControllerError("invalid_server_message", "remote replay has no base snapshot");
    if (this.document.epoch !== recovery.epoch) {
      throw new RemoteControllerError("invalid_server_message", "remote replay epoch does not match its base snapshot");
    }
    let cursor = this.document.cursor;
    for (const event of recovery.events) {
      if (event.epoch !== recovery.epoch || event.cursor !== cursor + 1) {
        throw new RemoteControllerError("invalid_server_message", "remote recovery events are not contiguous with the saved cursor");
      }
      this.document.applyEvent(event);
      this.captureOperation(event.payload);
      for (const listener of this.listeners) listener(event);
      cursor = event.cursor;
    }
    if (cursor !== recovery.cursor) {
      throw new RemoteControllerError("invalid_server_message", "remote recovery cursor does not match its events");
    }
  }

  private captureOperation(value: unknown): void {
    if (!isOperation(value)) return;
    this.operations.set(value.id, clone(value));
    if (!settled(value)) return;
    const waiters = this.waiters.get(value.id);
    if (!waiters) return;
    this.waiters.delete(value.id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(clone(value));
    }
  }

  private removeWaiter(id: string, waiter: OperationWaiter): void {
    const entries = this.waiters.get(id);
    entries?.delete(waiter);
    if (entries?.size === 0) this.waiters.delete(id);
  }

  private rejectWaiters(error: Error): void {
    for (const entries of this.waiters.values()) {
      for (const waiter of entries) {
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }

  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.recovered) return;
    for (const [sequence, pending] of [...this.pending].sort(([a], [b]) => a - b)) {
      if (pending.sent) continue;
      socket.send(JSON.stringify({ type: "command", sequence, command: pending.command }));
      pending.sent = true;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = Math.min(5_000, 100 * 2 ** Math.min(this.reconnectAttempt++, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
    this.reconnectTimer.unref();
  }
}

export async function connectRemoteController(input: string | URL): Promise<RemoteController> {
  const { socketUrl: url, origin } = remoteSocketTarget(input);
  const controller = new WebSocketRemoteController(url, origin);
  try {
    await controller.ready;
    return controller;
  } catch (error) {
    await controller.close();
    throw error;
  }
}

export function remoteSocketTarget(input: string | URL): { socketUrl: URL; origin: string } {
  const url = new URL(input);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new RemoteControllerError("invalid_url", "remote Alder URL must use http, https, ws, or wss");
  }
  if (url.username || url.password || url.hash) {
    throw new RemoteControllerError("invalid_url", "remote Alder URL cannot contain credentials or a fragment");
  }
  const parameters = [...url.searchParams.keys()];
  if (parameters.some((key) => key !== "nb" && key !== "view")
    || url.searchParams.getAll("nb").length > 1
    || url.searchParams.getAll("view").length > 1) {
    throw new RemoteControllerError("invalid_url", "remote Alder URL has unsupported or repeated query parameters");
  }
  const view = url.searchParams.get("view");
  if (view !== null && view !== "editor" && view !== "app") {
    throw new RemoteControllerError("invalid_url", "remote Alder view must be editor or app");
  }
  let notebook = url.searchParams.get("nb");
  const pathMatch = /^\/n\/([^/]+)$/.exec(url.pathname);
  if (pathMatch) {
    let selected: string;
    try { selected = decodeURIComponent(pathMatch[1]!); }
    catch { throw new RemoteControllerError("invalid_url", "gallery notebook path is malformed"); }
    if (notebook !== null && notebook !== selected) {
      throw new RemoteControllerError("invalid_url", "gallery path and query select different notebooks");
    }
    notebook = selected;
  } else if (url.pathname !== "/" && url.pathname !== "" && url.pathname !== "/api/socket") {
    throw new RemoteControllerError("invalid_url", "remote Alder URL path must be /, /api/socket, or /n/<notebook>");
  }
  if (notebook !== null && (!notebook || notebook === "." || notebook === ".."
    || notebook.length > 512 || /[\/\\\0\r\n]/.test(notebook))) {
    throw new RemoteControllerError("invalid_url", "gallery notebook identity is invalid");
  }
  const originProtocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  const origin = `${originProtocol}//${url.host}`;
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/api/socket";
  url.search = "";
  if (notebook !== null) url.searchParams.set("nb", notebook);
  return { socketUrl: url, origin };
}

function parseRecovery(value: unknown): Recovery {
  const parsed = recoverySchema.safeParse(value);
  if (!parsed.success) throw new RemoteControllerError("invalid_server_message", "invalid remote recovery frame");
  return parsed.data;
}

function parseEvent(value: unknown): HostEvent {
  const parsed = hostEventSchema.safeParse(value);
  if (!parsed.success) throw new RemoteControllerError("invalid_server_message", "invalid remote event");
  return parsed.data;
}

function parseResult(value: unknown): CommandResult {
  const parsed = commandResultSchema.safeParse(value);
  if (!parsed.success) throw new RemoteControllerError("invalid_server_message", "invalid remote command result");
  return parsed.data;
}

function isOperation(value: unknown): value is OperationRecord {
  return isObject(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.status === "string" && typeof value.acceptedAt === "number";
}

function settled(operation: OperationRecord): boolean {
  return operation.status === "done" || operation.status === "error" || operation.status === "cancelled";
}

function clone<T>(value: T): T { return structuredClone(value); }
function object(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function abortError(): Error { return Object.assign(new Error("operation wait was cancelled"), { name: "AbortError" }); }
