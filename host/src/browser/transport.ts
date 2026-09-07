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
  type Recovery,
} from "../protocol.js";
import { notebookSocketUrl } from "./url.js";

export interface RecoveryStore {
  load(): { epoch: string | null; cursor: number | null };
  save(epoch: string, cursor: number): void;
  clear(): void;
}

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface BrowserTransportOptions {
  url?: string | (() => string);
  clientId?: string;
  recoveryStore?: RecoveryStore;
  /** Use a persisted cursor only when the caller also restored its base document state. */
  resumeFromStore?: boolean;
  webSocketFactory?: WebSocketFactory;
  reconnect?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxQueuedCommands?: number;
  onSnapshot?: (snapshot: HostSnapshot) => void;
  onEvent?: (event: HostEvent) => void;
  onState?: (state: "connecting" | "open" | "recovering" | "closed", error?: Error) => void;
}

interface PendingCommand {
  sequence: number;
  command: HostCommand;
  sent: boolean;
  resolve: (result: CommandResult) => void;
  reject: (error: BrowserTransportError) => void;
}

export class BrowserTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserTransportError";
  }
}

export class SessionRecoveryStore implements RecoveryStore {
  constructor(private readonly key = "alder.host.recovery") {}

  load(): { epoch: string | null; cursor: number | null } {
    try {
      const value = sessionStorage.getItem(this.key);
      if (!value) return { epoch: null, cursor: null };
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return {
        epoch: typeof parsed.epoch === "string" ? parsed.epoch : null,
        cursor: Number.isSafeInteger(parsed.cursor) && (parsed.cursor as number) >= 0 ? parsed.cursor as number : null,
      };
    } catch {
      return { epoch: null, cursor: null };
    }
  }

  save(epoch: string, cursor: number): void {
    try { sessionStorage.setItem(this.key, JSON.stringify({ epoch, cursor })); } catch { /* private browsing */ }
  }

  clear(): void {
    try { sessionStorage.removeItem(this.key); } catch { /* private browsing */ }
  }
}

export class BrowserTransport {
  private socket: WebSocketLike | null = null;
  private pending = new Map<number, PendingCommand>();
  private sequence = 0;
  private openPromise: Promise<Recovery> | null = null;
  private resolveOpen: ((recovery: Recovery) => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;
  private stopped = false;
  private recovered = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private epoch: string | null;
  private cursor: number | null;
  private readonly clientId: string;
  private readonly store: RecoveryStore;
  private readonly persistRecovery: boolean;
  private readonly webSocketFactory: WebSocketFactory;

  constructor(private readonly options: BrowserTransportOptions = {}) {
    this.store = options.recoveryStore ?? new SessionRecoveryStore();
    // A cursor is useful after a page reload only when the caller also restores
    // the document it describes. The browser app deliberately requests a fresh
    // snapshot, so synchronous Web Storage writes on every streamed event buy it
    // no recovery and can block visible output for tens of milliseconds.
    this.persistRecovery = options.recoveryStore !== undefined || options.resumeFromStore === true;
    const saved = options.resumeFromStore ? this.store.load() : { epoch: null, cursor: null };
    this.epoch = saved.epoch;
    this.cursor = saved.cursor;
    this.clientId = options.clientId ?? browserId();
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  get sessionEpoch(): string | null { return this.epoch; }
  get eventCursor(): number | null { return this.cursor; }
  get id(): string { return this.clientId; }

  connect(): Promise<Recovery> {
    if (this.openPromise) return this.openPromise;
    this.stopped = false;
    this.recovered = false;
    this.options.onState?.("connecting");
    this.openPromise = new Promise<Recovery>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.openSocket();
    return this.openPromise;
  }

  dispatch(command: HostCommand): Promise<CommandResult> {
    if (this.stopped) return Promise.reject(new BrowserTransportError("transport_closed", "browser transport is closed"));
    if (this.pending.size >= (this.options.maxQueuedCommands ?? 1_000)) {
      return Promise.reject(new BrowserTransportError("client_backpressure", "too many browser commands are pending"));
    }
    const sequence = ++this.sequence;
    return new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(sequence, { sequence, command, sent: false, resolve, reject });
      this.flushCommands();
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "browser client closed");
    this.socket = null;
    const error = new BrowserTransportError("transport_closed", "browser transport is closed");
    this.rejectOpen?.(error);
    this.rejectOpen = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.options.onState?.("closed");
  }

  private openSocket(): void {
    if (this.stopped) return;
    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(this.socketUrl());
    } catch (error) {
      this.scheduleReconnect(asError(error));
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (socket !== this.socket || this.stopped) return;
      this.options.onState?.("recovering");
      socket.send(JSON.stringify({
        type: "connect",
        protocolVersion: 1,
        clientId: this.clientId,
        epoch: this.epoch,
        cursor: this.cursor,
      }));
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || this.stopped) return;
      try {
        this.receive(event.data);
      } catch (error) {
        this.protocolFailure(error instanceof BrowserTransportError
          ? error
          : new BrowserTransportError("invalid_server_message", asError(error).message));
      }
    };
    socket.onerror = () => {
      // close supplies the actionable lifecycle signal and reconnect path.
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.recovered = false;
      for (const pending of this.pending.values()) pending.sent = false;
      if (this.stopped) return;
      this.scheduleReconnect(new BrowserTransportError(
        "connection_lost",
        event.reason || `WebSocket closed (${event.code})`,
      ));
    };
  }

  private receive(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      const encoded = typeof raw === "string"
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : null;
      if (encoded === null) throw new Error("message is not UTF-8 JSON text");
      const parsed = decodeJsonFrame(encoded, SNAPSHOT_ENVELOPE_LIMIT);
      if (!isRecord(parsed)) throw new Error("message is not an object");
      message = parsed;
    } catch (error) {
      this.protocolFailure(new BrowserTransportError("invalid_server_message", asError(error).message));
      return;
    }
    if (message.type === "recovery") {
      if (message.protocolVersion !== 1) {
        throw new BrowserTransportError("protocol_mismatch", "browser and host protocol versions do not match");
      }
      const recovery = parseRecovery(message.recovery);
      this.applyRecovery(recovery);
      this.recovered = true;
      this.reconnectAttempts = 0;
      this.resolveOpen?.(recovery);
      this.resolveOpen = null;
      this.rejectOpen = null;
      this.options.onState?.("open");
      this.flushCommands();
      return;
    }
    if (!this.recovered) {
      this.protocolFailure(new BrowserTransportError("invalid_server_message", "server sent data before recovery"));
      return;
    }
    if (message.type === "event") {
      const event = parseEvent(message.event);
      if (event.epoch !== this.epoch || (this.cursor !== null && event.cursor <= this.cursor)) return;
      this.options.onEvent?.(event);
      this.epoch = event.epoch;
      this.cursor = event.cursor;
      if (this.persistRecovery) this.store.save(this.epoch, this.cursor);
      return;
    }
    if (message.type === "commandResult") {
      const sequence = message.sequence;
      if (!Number.isSafeInteger(sequence)) return this.protocolFailure(new BrowserTransportError("invalid_server_message", "invalid command sequence"));
      const pending = this.pending.get(sequence as number);
      if (!pending) return;
      const result = parseCommandResult(message.result);
      this.pending.delete(sequence as number);
      pending.resolve(result);
      return;
    }
    if (message.type === "commandError") {
      const sequence = message.sequence;
      const detail = isRecord(message.error) ? message.error : {};
      const error = new BrowserTransportError(
        typeof detail.code === "string" ? detail.code : "internal_error",
        typeof detail.message === "string" ? detail.message : "command failed",
      );
      if (Number.isSafeInteger(sequence)) {
        const pending = this.pending.get(sequence as number);
        if (pending) {
          this.pending.delete(sequence as number);
          pending.reject(error);
        }
      }
      return;
    }
    if (message.type !== "pong") this.protocolFailure(new BrowserTransportError("invalid_server_message", "unknown server message"));
  }

  private applyRecovery(recovery: Recovery): void {
    if (recovery.kind === "snapshot") {
      this.options.onSnapshot?.(recovery.snapshot);
    } else {
      let cursor = this.cursor;
      if (this.epoch !== recovery.epoch || cursor === null) {
        throw new BrowserTransportError("invalid_server_message", "replay recovery has no matching base snapshot");
      }
      for (const event of recovery.events) {
        if (event.epoch !== recovery.epoch || event.cursor !== cursor + 1) {
          throw new BrowserTransportError("invalid_server_message", "recovery events are not contiguous with the saved cursor");
        }
        this.options.onEvent?.(event);
        cursor = event.cursor;
      }
      if (cursor !== recovery.cursor) {
        throw new BrowserTransportError("invalid_server_message", "recovery cursor does not match its events");
      }
    }
    this.epoch = recovery.epoch;
    this.cursor = recovery.cursor;
    if (this.persistRecovery) this.store.save(recovery.epoch, recovery.cursor);
  }

  private flushCommands(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.recovered) return;
    for (const pending of [...this.pending.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (pending.sent) continue;
      socket.send(JSON.stringify({ type: "command", sequence: pending.sequence, command: pending.command }));
      pending.sent = true;
    }
  }

  private protocolFailure(error: BrowserTransportError): void {
    this.options.onState?.("closed", error);
    this.socket?.close(1002, error.message.slice(0, 120));
  }

  private scheduleReconnect(error: Error): void {
    this.options.onState?.("closed", error);
    if (this.options.reconnect === false) {
      this.rejectOpen?.(error);
      this.rejectOpen = null;
      const failure = new BrowserTransportError("connection_lost", error.message);
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
      return;
    }
    const base = this.options.reconnectBaseMs ?? 100;
    const maximum = this.options.reconnectMaxMs ?? 5_000;
    const delay = Math.min(maximum, base * 2 ** Math.min(this.reconnectAttempts++, 8));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private socketUrl(): string {
    const supplied = typeof this.options.url === "function" ? this.options.url() : this.options.url;
    if (supplied) return supplied;
    return notebookSocketUrl();
  }
}

function parseRecovery(value: unknown): Recovery {
  const parsed = recoverySchema.safeParse(value);
  if (!parsed.success) throw new BrowserTransportError("invalid_server_message", "invalid recovery response");
  return parsed.data;
}

function parseEvent(value: unknown): HostEvent {
  const parsed = hostEventSchema.safeParse(value);
  if (!parsed.success) throw new BrowserTransportError("invalid_server_message", "invalid notebook event");
  return parsed.data;
}

function parseCommandResult(value: unknown): CommandResult {
  const parsed = commandResultSchema.safeParse(value);
  if (!parsed.success) throw new BrowserTransportError("invalid_server_message", "invalid command result");
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function browserId(): string {
  try { return `browser-${crypto.randomUUID()}`; } catch { return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}
