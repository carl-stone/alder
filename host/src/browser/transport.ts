import { z } from "zod";
import {
  HOST_CLIENT_PROTOCOL_VERSION, artifactHandleSchema, commandResultSchema,
  decodeHostEventWire, canonicalBase64ByteLength, decodeJsonFrame, decodeRecoveryWire,
  encodeHostCommandWire, hostEventSchema, recoverySchema, documentChangeSchema,
  SNAPSHOT_ENVELOPE_LIMIT, type ArtifactHandle, type CommandResult, type HostCommand,
  type HostEvent, type HostSnapshot, type Recovery, type DocumentChange,
} from "../protocol.js";
import { notebookSocketUrl, notebookUrl } from "./url.js";

export class BrowserTransportError extends Error {
  constructor(readonly code: string, message: string, readonly definitive = false) {
    super(message); this.name = "BrowserTransportError";
  }
}

const revision = z.number().int().nonnegative().safe();
const draftBaseSchema = z.object({
  epoch: z.string(), documentRevision: revision,
  cells: z.array(z.object({ id: z.string(), revision, type: z.enum(["code", "markdown"]), body: z.array(z.string()) })),
});
export const recoveryDraftSchema = z.object({
  schemaVersion: z.literal(2), draftId: z.string().min(1), updatedAt: z.number(),
  base: draftBaseSchema, changes: z.array(documentChangeSchema),
  pendingRun: z.object({ requestId: z.string(), epoch: z.string() }).nullable().default(null),
  submission: z.object({ requestId: z.string(), kind: z.enum(["transaction", "run"]), changes: z.array(documentChangeSchema) }).nullable(),
});
export type BrowserRecoveryDraft = z.infer<typeof recoveryDraftSchema>;

/** Old native drafts are read as source only; an interrupted run is never replayed. */
export function readRecoveryDraft(value: unknown, legacyId?: string): BrowserRecoveryDraft | null {
  const current = recoveryDraftSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = z.object({ schemaVersion: z.literal(1), clientId: z.string(), base: draftBaseSchema,
    changes: z.array(documentChangeSchema), operation: z.object({ operationId: z.string(), kind: z.enum(["transaction", "run"]), changes: z.array(documentChangeSchema).optional() }).nullable().optional(),
  }).safeParse(value);
  if (!legacy.success) return null;
  return { schemaVersion: 2, draftId: legacyId ?? legacy.data.clientId, updatedAt: 0,
    base: legacy.data.base, changes: legacy.data.changes,
    pendingRun: legacy.data.operation?.kind === "run" ? { requestId: legacy.data.operation.operationId, epoch: legacy.data.base.epoch } : null,
    submission: legacy.data.operation ? { requestId: legacy.data.operation.operationId, kind: legacy.data.operation.kind, changes: legacy.data.operation.changes ?? legacy.data.changes } : null };
}
export interface BrowserDraftStore {
  listDrafts(): Promise<BrowserRecoveryDraft[]>;
  saveDraft(draft: BrowserRecoveryDraft): Promise<void>;
  clearDraft(draftId: string): Promise<void>;
}
export class MemoryRecoveryStore implements BrowserDraftStore {
  private readonly drafts = new Map<string, BrowserRecoveryDraft>();
  async listDrafts(): Promise<BrowserRecoveryDraft[]> { return [...this.drafts.values()].map(value => structuredClone(value)); }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> { this.drafts.set(draft.draftId, structuredClone(draft)); }
  async clearDraft(draftId: string): Promise<void> { this.drafts.delete(draftId); }
}

/** Credentials never enter draft storage. Desktop uses its native store instead. */
export class IndexedDBRecoveryStore implements BrowserDraftStore {
  private database: Promise<IDBDatabase> | null = null;
  private memory = new MemoryRecoveryStore();
  constructor(private readonly identity: string) {}
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("alder-document-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    if (typeof indexedDB === "undefined") return this.memory.listDrafts();
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction("drafts").objectStore("drafts").openCursor();
      const drafts: BrowserRecoveryDraft[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(drafts); return; }
        if (String(cursor.key).startsWith(this.identity + ":")) {
          const draft = readRecoveryDraft(cursor.value); if (draft) drafts.push(draft);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    if (typeof indexedDB === "undefined") return this.memory.saveDraft(draft);
    await this.write(draft.draftId, draft);
  }
  async clearDraft(draftId: string): Promise<void> {
    if (typeof indexedDB === "undefined") return this.memory.clearDraft(draftId);
    await this.write(draftId, null);
  }
  private async write(draftId: string, draft: BrowserRecoveryDraft | null): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      const store = transaction.objectStore("drafts");
      if (draft === null) store.delete(this.identity + ":" + draftId); else store.put(draft, this.identity + ":" + draftId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
}

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface BrowserTransportOptions {
  url?: string;
  clientId?: string;
  leaseId?: string;
  csrf?: string;
  continuityProof?: string;
  recoveryStore?: BrowserDraftStore;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  maxQueuedCommands?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
  onSnapshot?: (snapshot: HostSnapshot) => void;
  onEvent?: (event: HostEvent) => void;
  onState?: (state: "connecting" | "open" | "recovering" | "closed", error?: Error) => void;
}

export type BrowserCommand = HostCommand;
interface PendingCommand {
  command: HostCommand;
  resolve(result: CommandResult): void;
  reject(error: BrowserTransportError): void;
  sent: boolean;
}
interface ConnectionAttempt {
  generation: number;
  socket: WebSocketLike;
  receiveChain: Promise<void>;
  handshakeTimer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Authenticated live updates, with a fresh snapshot after every connection. */
export class BrowserTransport {
  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private epochValue: string | null = null;
  private cursorValue: number | null = null;
  private recovered = false;
  private stopped = true;
  private generation = 0;
  private attempt: ConnectionAttempt | null = null;
  private connectPromise: Promise<Recovery> | null = null;
  private resolveConnect: ((recovery: Recovery) => void) | null = null;
  private rejectConnect: ((error: BrowserTransportError) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecovery: Recovery | null = null;
  readonly recoveryStore: BrowserDraftStore;

  constructor(private readonly options: BrowserTransportOptions = {}) {
    this.recoveryStore = options.recoveryStore ?? new MemoryRecoveryStore();
  }

  get id(): string { return this.options.clientId ?? ""; }
  get leaseId(): string { return this.options.leaseId ?? ""; }
  get csrf(): string { return this.options.csrf ?? ""; }
  get continuityProof(): string { return this.options.continuityProof ?? ""; }
  assertResponseContinuity(response: { headers: { get(name: string): string | null } }): void {
    const expected = this.options.continuityProof;
    if (expected !== undefined && response.headers.get("X-Alder-Continuity-Proof") !== expected) {
      throw new BrowserTransportError("host_identity_mismatch", "host HTTP continuity proof changed");
    }
  }
  get epoch(): string | null { return this.epochValue; }
  get cursor(): number | null { return this.cursorValue; }
  get url(): string { return this.options.url ?? notebookSocketUrl(); }

  connect(): Promise<Recovery> {
    this.stopped = false;
    if (this.recovered && this.socket?.readyState === OPEN && this.lastRecovery !== null) return Promise.resolve(this.lastRecovery);
    if (this.connectPromise !== null) return this.connectPromise;
    if (!this.id || !this.leaseId || !this.csrf || (!this.continuityProof && this.options.webSocketFactory === undefined)) return Promise.reject(new BrowserTransportError("session_credentials_missing", "browser session credentials are missing"));
    this.connectPromise = new Promise<Recovery>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.reconnectAttempts = 0;
    this.startAttempt();
    return this.connectPromise;
  }

  dispatch(command: BrowserCommand): Promise<CommandResult> {
    if (this.stopped || !this.recovered || this.socket?.readyState !== OPEN) return Promise.reject(new BrowserTransportError("transport_closed", "Reconnect before sending this request.", true));
    if (this.pending.size >= (this.options.maxQueuedCommands ?? 100)) return Promise.reject(new BrowserTransportError("client_backpressure", "Too many requests are pending.", true));
    if (this.pending.has(command.requestId)) return Promise.reject(new BrowserTransportError("request_pending", "This request is already pending.", true));
    if (command.sessionEpoch !== this.epochValue) return Promise.reject(new BrowserTransportError("session_replaced", "This request belongs to a previous backend session and cannot be repeated.", true));
    const wireCommand = { ...command, clientId: this.id } as HostCommand;
    return new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(command.requestId, { command: wireCommand, resolve, reject, sent: false });
      this.flush();
    });
  }

  async release(disposition: "normal" | "discard" = "normal"): Promise<void> {
    const response = await fetch(notebookUrl("/api/lease"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Alder-CSRF": this.csrf },
      body: JSON.stringify({ action: "release", leaseId: this.leaseId, disposition }),
    });
    this.assertResponseContinuity(response);
    if (!response.ok) throw new BrowserTransportError("lease_release_failed", "browser lease release failed (" + response.status + ")");
    this.close();
  }
  close(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    if (this.attempt !== null) clearTimeout(this.attempt.handshakeTimer);
    const socket = this.socket;
    this.socket = null;
    this.attempt = null;
    this.recovered = false;
    this.lastRecovery = null;
    if (socket !== null) socket.close();
    const error = new BrowserTransportError("transport_closed", "browser transport is closed");
    this.rejectConnect?.(error);
    this.clearConnectPromise();
    for (const pending of this.pending.values()) pending.reject(new BrowserTransportError(error.code, error.message, !pending.sent));
    this.pending.clear();
    this.options.onState?.("closed", error);
  }

  private startAttempt(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const generation = ++this.generation;
    let socket: WebSocketLike;
    try {
      const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
      socket = factory(this.url);
    } catch (error) {
      this.handleAttemptFailure(generation, asError(error, "browser WebSocket construction failed"));
      return;
    }
    socket.binaryType = "arraybuffer";
    let attempt: ConnectionAttempt;
    const handshakeTimer = setTimeout(() => {
      if (this.isCurrent(attempt)) this.handleAttemptFailure(generation, new BrowserTransportError("transport_closed", "host WebSocket recovery handshake timed out"));
    }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    attempt = { generation, socket, receiveChain: Promise.resolve(), handshakeTimer };
    this.attempt = attempt;
    this.socket = socket;
    this.recovered = false;
    this.options.onState?.("connecting");
    socket.onopen = () => {
      if (!this.isCurrent(attempt)) return;
      try {
        socket.send(JSON.stringify({ type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: this.leaseId, clientId: this.id, csrf: this.csrf }));
        this.options.onState?.("recovering");
      } catch (error) {
        this.handleAttemptFailure(generation, asError(error, "browser WebSocket handshake failed"));
      }
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(attempt)) return;
      attempt.receiveChain = attempt.receiveChain.then(async () => {
        if (this.isCurrent(attempt)) await this.receive(event.data, attempt);
      }).catch((error) => this.handleAttemptFailure(generation, asError(error, "invalid host message")));
    };
    socket.onerror = () => {
      // Close normally follows an error event. Handling only close avoids
      // tearing down a socket whose buffered recovery frame is still valid.
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(attempt)) return;
      const error = new BrowserTransportError("transport_closed", event.reason || "host WebSocket closed");
      this.handleAttemptFailure(generation, error);
    };
  }

  private isCurrent(attempt: ConnectionAttempt): boolean {
    return !this.stopped && this.attempt === attempt && this.generation === attempt.generation;
  }

  private handleAttemptFailure(generation: number, error: Error): void {
    if (this.stopped || generation !== this.generation) return;
    this.generation += 1;
    const socket = this.socket;
    if (this.attempt !== null) clearTimeout(this.attempt.handshakeTimer);
    this.socket = null;
    this.attempt = null;
    this.recovered = false;
    this.clearHeartbeat();
    if (socket !== null) socket.close();
    const interrupted = new BrowserTransportError("request_uncertain", "The connection was interrupted. The request may have completed; it has not been sent again.");
    for (const pending of this.pending.values()) pending.reject(interrupted);
    this.pending.clear();
    this.options.onState?.("closed", error);
    if (this.options.reconnect !== false) {
      this.scheduleReconnect();
      return;
    }
    const transportError = error instanceof BrowserTransportError ? error : new BrowserTransportError("transport_closed", error.message);
    this.rejectConnect?.(transportError);
    this.clearConnectPromise();
    for (const pending of this.pending.values()) pending.reject(transportError);
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const base = this.options.reconnectDelayMs ?? 100;
    const maximum = this.options.maxReconnectDelayMs ?? 5_000;
    const delay = Math.min(maximum, base * 2 ** Math.min(this.reconnectAttempts++, 8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.startAttempt();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearConnectPromise(): void {
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }

  private async receive(raw: unknown, attempt: ConnectionAttempt): Promise<void> {
    if (typeof raw !== "string" && !(raw instanceof Uint8Array)) throw new BrowserTransportError("invalid_server_message", "host message is not a JSON frame");
    const message = decodeJsonFrame(raw, SNAPSHOT_ENVELOPE_LIMIT) as Record<string, unknown>;
    if (!this.recovered && message.type !== "recovery") throw new BrowserTransportError("host_identity_mismatch", "host sent data before proving its process identity");
    if (message.type === "recovery") {
      if (message.protocolVersion !== HOST_CLIENT_PROTOCOL_VERSION) throw new BrowserTransportError("protocol_mismatch", "host and browser protocol versions differ");
      if (this.continuityProof && message.continuityProof !== this.continuityProof) throw new BrowserTransportError("host_identity_mismatch", "browser reconnected to a different host process");
      const recovery = await this.loadRecovery(message.recovery);
      if (!this.isCurrent(attempt)) return;
      await this.applyRecovery(recovery);
      this.recovered = true;
      if (this.attempt !== null) clearTimeout(this.attempt.handshakeTimer);
      this.lastRecovery = recovery;
      this.reconnectAttempts = 0;
      this.options.onState?.("open");
      this.resolveConnect?.(recovery);
      this.clearConnectPromise();
      this.startHeartbeat();
      this.flush();
      return;
    }
    if (message.type === "event") {
      const event = hostEventSchema.parse(decodeHostEventWire(message.event));
      if (event.epoch !== this.epochValue || event.cursor <= (this.cursorValue ?? -1)) return;
      this.options.onEvent?.(event);
      this.cursorValue = event.cursor;
      return;
    }
    if (message.type === "commandResult") {
      const result = commandResultSchema.parse(message.result);
      if (message.requestId !== result.requestId) throw new BrowserTransportError("invalid_server_message", "Request result identity differs.");
      const pending = this.pending.get(result.requestId);
      if (pending) { this.pending.delete(result.requestId); pending.resolve(result); }
      return;
    }
    if (message.type === "error") {
      const detail = asErrorDetail(message.error);
      const pending = typeof message.requestId === "string" ? this.pending.get(message.requestId) : undefined;
      if (!pending) throw new BrowserTransportError(detail.code, detail.message);
      this.pending.delete(message.requestId as string);
      pending.reject(new BrowserTransportError(detail.code, detail.message, message.definitive === true));
      return;
    }
    if (message.type === "heartbeat" || message.type === "pong") return;
    throw new BrowserTransportError("invalid_server_message", "unknown host WebSocket message");
  }

  private async loadRecovery(value: unknown): Promise<Recovery> {
    const descriptor = artifactHandleSchema.safeParse(value);
    if (descriptor.success) {
      const bytes = await this.loadArtifact(descriptor.data);
      const decoded = decodeJsonFrame(bytes, SNAPSHOT_ENVELOPE_LIMIT);
      return recoverySchema.parse(decodeRecoveryWire(decoded)) as unknown as Recovery;
    }
    return recoverySchema.parse(decodeRecoveryWire(value)) as unknown as Recovery;
  }

  private async loadArtifact(descriptor: ArtifactHandle): Promise<Uint8Array> {
    if (descriptor.byteLength > SNAPSHOT_ENVELOPE_LIMIT) throw new BrowserTransportError("invalid_server_message", "recovery artifact exceeds the transfer bound");
    const target = new Uint8Array(descriptor.byteLength);
    let offset = 0;
    while (offset < descriptor.byteLength || descriptor.byteLength === 0) {
      const response = await fetch(this.artifactQueryUrl(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Alder-CSRF": this.csrf },
        body: JSON.stringify({ type: "output", handle: descriptor.handle, offset, limit: descriptor.chunkBytes }),
      });
      this.assertResponseContinuity(response);
      if (!response.ok) throw new BrowserTransportError("artifact_read_failed", "recovery artifact page request failed (" + response.status + ")");
      const frame = decodeJsonFrame(await response.text(), SNAPSHOT_ENVELOPE_LIMIT);
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) throw new BrowserTransportError("invalid_server_message", "recovery artifact page is not an object");
      const result = (frame as Record<string, unknown>).result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) throw new BrowserTransportError("invalid_server_message", "recovery artifact page is missing its result");
      const page = result as Record<string, unknown>;
      if (page.encoding !== "base64" || page.offset !== offset || typeof page.nextOffset !== "number" || !Number.isSafeInteger(page.nextOffset) || page.nextOffset < offset || typeof page.eof !== "boolean" || typeof page.data !== "string") throw new BrowserTransportError("invalid_server_message", "recovery artifact page is invalid");
      if (canonicalBase64ByteLength(page.data) === null) throw new BrowserTransportError("invalid_server_message", "recovery artifact page is not canonical base64");
      let binary: string;
      try { binary = atob(page.data); } catch { throw new BrowserTransportError("invalid_server_message", "recovery artifact page is not decodable base64"); }
      if (binary.length > descriptor.chunkBytes || page.nextOffset !== offset + binary.length || page.nextOffset > descriptor.byteLength) throw new BrowserTransportError("invalid_server_message", "recovery artifact page length is invalid");
      for (let index = 0; index < binary.length; index += 1) target[offset + index] = binary.charCodeAt(index);
      offset = page.nextOffset;
      if (page.eof) {
        if (offset !== descriptor.byteLength) throw new BrowserTransportError("invalid_server_message", "recovery artifact ended before its descriptor length");
        break;
      }
      if (binary.length === 0 || offset >= descriptor.byteLength) throw new BrowserTransportError("invalid_server_message", "recovery artifact page sequence is invalid");
    }
    return target;
  }

  private artifactQueryUrl(): string {
    try {
      const current = new URL(this.url);
      current.protocol = current.protocol === "wss:" ? "https:" : "http:";
      current.pathname = "/api/query";
      current.search = "";
      current.hash = "";
      return current.href;
    } catch {
      return notebookUrl("/api/query");
    }
  }

  private async applyRecovery(recovery: Recovery): Promise<void> {
    this.epochValue = recovery.epoch;
    this.cursorValue = recovery.cursor;
    this.options.onSnapshot?.(recovery.snapshot);
  }

  private flush(): void {
    if (!this.recovered || this.socket?.readyState !== OPEN) return;
    for (const [requestId, pending] of this.pending) {
      if (pending.sent) continue;
      pending.sent = true;
      try { this.socket.send(JSON.stringify({ type: "command", requestId, command: encodeHostCommandWire(pending.command) })); }
      catch (error) { this.handleAttemptFailure(this.generation, asError(error, "Request could not be sent.")); return; }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.recovered && this.socket?.readyState === OPEN) {
        try { this.socket.send(JSON.stringify({ type: "heartbeat" })); } catch { /* close handler reconnects */ }
      }
    }, 10_000);
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function asErrorDetail(value: unknown): { code: string; message: string } {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") return { code: record.code, message: record.message };
  }
  return { code: "invalid_server_message", message: "host rejected the browser message" };
}
