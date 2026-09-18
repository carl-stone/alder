import {
  HOST_CLIENT_PROTOCOL_VERSION,
  artifactHandleSchema,
  commandAdmissionSchema,
  decodeHostEventWire,
  canonicalBase64ByteLength,
  decodeJsonFrame,
  decodeRecoveryWire,
  encodeHostCommandWire,
  hostEventSchema,
  recoverySchema,
  documentChangeSchema,
  SNAPSHOT_ENVELOPE_LIMIT,
  type ArtifactHandle,
  type CommandAdmission,
  type HostCommand,
  type HostEvent,
  type HostSnapshot,
  type Recovery,
  type DocumentChange,
} from "../protocol.js";
import { notebookSocketUrl, notebookUrl } from "./url.js";

export class BrowserTransportError extends Error {
  constructor(readonly code: string, message: string, readonly definitive = false) {
    super(message);
    this.name = "BrowserTransportError";
  }
}

export interface RecoveryStore {
  load(): Promise<{ epoch: string; cursor: number } | null>;
  save(epoch: string, cursor: number): Promise<void>;
  clear(): Promise<void>;
}

/**
 * A renderer-local draft contains only logical source intent and the
 * authoritative identity it was based on. Session credentials deliberately
 * do not belong in this value: a fresh browser ticket is required after a
 * renderer restart.
 */
export interface BrowserRecoveryDraft {
  schemaVersion: 1;
  clientId: string;
  base: {
    epoch: string;
    cursor: number;
    version: number;
    documentRevision: number;
    cells: Array<{ id: string; revision: number; type: "code" | "markdown"; body: string[] }>;
  };
  changes: DocumentChange[];
  operation: {
    operationId: string;
    clientId?: string;
    kind: "transaction" | "run";
    commandSequence: number;
    expectedDocumentRevision: number;
    changes?: DocumentChange[];
  } | null;
}
export interface BrowserRecoveryBranch { id: string; draft: BrowserRecoveryDraft; }

export interface BrowserDraftStore extends RecoveryStore {
  loadDraft(clientId?: string): Promise<BrowserRecoveryDraft | null>;
  listDrafts(): Promise<BrowserRecoveryDraft[]>;
  saveDraft(draft: BrowserRecoveryDraft): Promise<void>;
  clearDraft(clientId: string): Promise<void>;
  saveBranch(branchId: string, draft: BrowserRecoveryDraft): Promise<void>;
  listBranches(): Promise<BrowserRecoveryBranch[]>;
  deleteBranch(branchId: string): Promise<void>;
}

export class MemoryRecoveryStore implements BrowserDraftStore {
  private value: { epoch: string; cursor: number } | null = null;
  private readonly drafts = new Map<string, BrowserRecoveryDraft>();
  private readonly branches = new Map<string, BrowserRecoveryDraft>();

  async load(): Promise<{ epoch: string; cursor: number } | null> {
    return this.value === null ? null : { ...this.value };
  }

  async save(epoch: string, cursor: number): Promise<void> {
    this.value = { epoch, cursor };
  }

  async clear(): Promise<void> {
    this.value = null;
  }

  async loadDraft(clientId?: string): Promise<BrowserRecoveryDraft | null> {
    const draft = clientId === undefined ? this.drafts.values().next().value : this.drafts.get(clientId);
    return draft === undefined ? null : cloneDraft(draft);
  }

  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    return [...this.drafts.values()].map(cloneDraft);
  }

  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    this.drafts.set(draft.clientId, cloneDraft(draft));
  }

  async clearDraft(clientId: string): Promise<void> {
    this.drafts.delete(clientId);
  }

  async saveBranch(branchId: string, draft: BrowserRecoveryDraft): Promise<void> {
    this.branches.set(branchId, cloneDraft(draft));
  }

  async listBranches(): Promise<BrowserRecoveryBranch[]> {
    return [...this.branches].map(([id, draft]) => ({ id, draft: cloneDraft(draft) }));
  }

  async deleteBranch(branchId: string): Promise<void> {
    this.branches.delete(branchId);
  }
}

/**
 * Browser durable storage for reconnect cursors and renderer-local drafts.
 * The database is keyed by a notebook URL identity, while the record itself
 * contains no lease, CSRF, ticket, or bearer credential.
 */
interface EncryptedRecoveryValue {
  schemaVersion: 1;
  keyId: string;
  algorithm: "AES-256-GCM";
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

const RECOVERY_ENVELOPE_VERSION = 1 as const;
const RECOVERY_ALGORITHM = "AES-256-GCM" as const;
const RECOVERY_IV_BYTES = 12;
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function decodeRecoveryKey(value: string | undefined): Uint8Array | null {
  if (value === undefined || !RECOVERY_KEY_PATTERN.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = globalThis.atob(normalized);
    if (binary.length !== RECOVERY_KEY_BYTES) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isEncryptedRecoveryValue(value: unknown): value is EncryptedRecoveryValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 5 && keys[0] === "algorithm" && keys[1] === "ciphertext" && keys[2] === "iv" && keys[3] === "keyId" && keys[4] === "schemaVersion" &&
    record.schemaVersion === RECOVERY_ENVELOPE_VERSION && record.algorithm === RECOVERY_ALGORITHM && typeof record.keyId === "string" &&
    RECOVERY_KEY_PATTERN.test(record.keyId) && record.iv instanceof Uint8Array && record.iv.byteLength === RECOVERY_IV_BYTES &&
    record.ciphertext instanceof Uint8Array && record.ciphertext.byteLength > 16;
}

function recoveryAad(recordKey: string): Uint8Array {
  return new TextEncoder().encode("alder-browser-recovery:v1:" + recordKey);
}

export class IndexedDBRecoveryStore implements BrowserDraftStore {
  private static readonly databaseName = "alder-browser-recovery";
  private static readonly databaseVersion = 2;
  private static readonly objectStoreName = "state";
  private readonly memory = new MemoryRecoveryStore();
  private readonly key: string;
  private readonly recoveryKey: Uint8Array | null;
  private readonly recoveryKeyId: string | null;
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private disabled: boolean;
  private cryptoKeyPromise: Promise<CryptoKey | null> | null = null;

  constructor(key: string, recoveryKey?: string, recoveryKeyId?: string) {
    this.key = key || "/";
    this.recoveryKey = decodeRecoveryKey(recoveryKey);
    this.recoveryKeyId = recoveryKey !== undefined && recoveryKeyId !== undefined && RECOVERY_KEY_PATTERN.test(recoveryKeyId) ? recoveryKeyId : null;
    this.disabled = typeof globalThis.indexedDB === "undefined" || this.recoveryKey === null || this.recoveryKeyId === null || globalThis.crypto?.subtle === undefined;
  }

  async load(): Promise<{ epoch: string; cursor: number } | null> {
    const stored = await this.read("cursor");
    if (isCursorState(stored)) return stored;
    return this.memory.load();
  }

  async save(epoch: string, cursor: number): Promise<void> {
    await this.memory.save(epoch, cursor);
    await this.write("cursor", { epoch, cursor });
  }

  async clear(): Promise<void> {
    await this.memory.clear();
    await this.remove("cursor");
  }

  async loadDraft(clientId?: string): Promise<BrowserRecoveryDraft | null> {
    if (clientId !== undefined) {
      const stored = await this.read("draft:" + clientId);
      if (isRecoveryDraft(stored)) return cloneDraft(stored);
      return this.memory.loadDraft(clientId);
    }
    const drafts = await this.listDrafts();
    return drafts[0] ?? null;
  }

  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    const stored = await this.readDrafts();
    return stored.length > 0 ? stored : this.memory.listDrafts();
  }

  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    await this.memory.saveDraft(draft);
    await this.write("draft:" + draft.clientId, cloneDraft(draft));
  }

  async clearDraft(clientId: string): Promise<void> {
    await this.memory.clearDraft(clientId);
    await this.remove("draft:" + clientId);
  }

  async saveBranch(branchId: string, draft: BrowserRecoveryDraft): Promise<void> {
    if (!branchId) return;
    await this.memory.saveBranch(branchId, draft);
    await this.write("branch:" + branchId, cloneDraft(draft));
  }

  async listBranches(): Promise<BrowserRecoveryBranch[]> {
    const stored = await this.readBranches();
    return stored.length > 0 ? stored : this.memory.listBranches();
  }

  async deleteBranch(branchId: string): Promise<void> {
    await this.memory.deleteBranch(branchId);
    await this.remove("branch:" + branchId);
  }

  private database(): Promise<IDBDatabase | null> {
    if (this.disabled) return Promise.resolve(null);
    if (this.databasePromise !== null) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = globalThis.indexedDB.open(IndexedDBRecoveryStore.databaseName, IndexedDBRecoveryStore.databaseVersion);
      } catch {
        this.disabled = true;
        resolve(null);
        return;
      }
      request.onupgradeneeded = (event) => {
        if (!request.result.objectStoreNames.contains(IndexedDBRecoveryStore.objectStoreName)) {
          request.result.createObjectStore(IndexedDBRecoveryStore.objectStoreName);
        }
        if ((event as IDBVersionChangeEvent).oldVersion < 2) request.transaction?.objectStore(IndexedDBRecoveryStore.objectStoreName).clear();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { this.disabled = true; resolve(null); };
      request.onblocked = () => { this.disabled = true; resolve(null); };
    });
    return this.databasePromise;
  }

  private cryptoKey(): Promise<CryptoKey | null> {
    if (this.recoveryKey === null || this.recoveryKeyId === null || this.disabled) return Promise.resolve(null);
    if (this.cryptoKeyPromise !== null) return this.cryptoKeyPromise;
    this.cryptoKeyPromise = globalThis.crypto.subtle.importKey("raw", this.recoveryKey as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
      .catch(() => { this.disabled = true; return null; });
    return this.cryptoKeyPromise;
  }

  private async encrypt(name: string, value: unknown): Promise<EncryptedRecoveryValue | null> {
    if (this.disabled || this.recoveryKeyId === null) return null;
    const key = await this.cryptoKey();
    if (key === null) return null;
    try {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(RECOVERY_IV_BYTES));
      const plaintext = new TextEncoder().encode(JSON.stringify(value));
      const ciphertext = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: recoveryAad(this.recordKey(name)) as BufferSource, tagLength: 128 }, key, plaintext as BufferSource);
      return { schemaVersion: RECOVERY_ENVELOPE_VERSION, keyId: this.recoveryKeyId, algorithm: RECOVERY_ALGORITHM, iv, ciphertext: new Uint8Array(ciphertext) };
    } catch {
      this.disabled = true;
      return null;
    }
  }

  private async decrypt(name: string, value: unknown): Promise<unknown | null> {
    if (!isEncryptedRecoveryValue(value) || this.recoveryKeyId === null || value.keyId !== this.recoveryKeyId) return null;
    const key = await this.cryptoKey();
    if (key === null) return null;
    try {
      const plaintext = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: value.iv as BufferSource, additionalData: recoveryAad(this.recordKey(name)) as BufferSource, tagLength: 128 }, key, value.ciphertext as BufferSource);
      return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
      return null;
    }
  }

  private async read(name: string): Promise<unknown> {
    const database = await this.database();
    if (database === null) return null;
    return new Promise((resolve) => {
      try {
        const transaction = database.transaction(IndexedDBRecoveryStore.objectStoreName, "readonly");
        const request = transaction.objectStore(IndexedDBRecoveryStore.objectStoreName).get(this.recordKey(name));
        request.onsuccess = () => {
          const raw = request.result;
          void this.decrypt(name, raw).then((value) => {
            if (raw !== undefined && value === null) void this.remove(name).catch(() => undefined);
            resolve(value);
          });
        };
        request.onerror = () => { this.disabled = true; resolve(null); };
      } catch {
        this.disabled = true;
        resolve(null);
      }
    });
  }
  private async write(name: string, value: unknown): Promise<void> {
    const encrypted = await this.encrypt(name, value);
    if (encrypted === null) return;
    const database = await this.database();
    if (database === null) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const transaction = database.transaction(IndexedDBRecoveryStore.objectStoreName, "readwrite");
        transaction.objectStore(IndexedDBRecoveryStore.objectStoreName).put(encrypted, this.recordKey(name));
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write transaction aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write transaction failed"));
      } catch (error) {
        reject(error);
      }
    });
  }

  private async remove(name: string): Promise<void> {
    const database = await this.database();
    if (database === null) return;
    await new Promise<void>((resolve, reject) => {
      try {
        const transaction = database.transaction(IndexedDBRecoveryStore.objectStoreName, "readwrite");
        transaction.objectStore(IndexedDBRecoveryStore.objectStoreName).delete(this.recordKey(name));
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB delete transaction aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB delete transaction failed"));
      } catch (error) {
        reject(error);
      }
    });
  }
  private async readDrafts(): Promise<BrowserRecoveryDraft[]> {
    const database = await this.database();
    if (database === null) return [];
    return new Promise((resolve, reject) => {
      try {
        const transaction = database.transaction(IndexedDBRecoveryStore.objectStoreName, "readonly");
        const store = transaction.objectStore(IndexedDBRecoveryStore.objectStoreName);
        const keys = store.getAllKeys();
        const values = store.getAll();
        transaction.oncomplete = () => {
          const entries = keys.result.map((key, index) => ({ key, value: values.result[index] }));
          void Promise.all(entries.map(async (entry) => {
            if (typeof entry.key !== "string") return null;
            const name = this.recordName(entry.key);
            if (name === null || !name.startsWith("draft:")) return null;
            const decoded = await this.decrypt(name, entry.value);
            if (decoded === null) {
              void this.remove(name).catch(() => undefined);
              return null;
            }
            return isRecoveryDraft(decoded) ? cloneDraft(decoded) : null;
          })).then((drafts) => {
            const unique = new Map<string, BrowserRecoveryDraft>();
            for (const draft of drafts) if (draft !== null) unique.set(draft.clientId, draft);
            resolve([...unique.values()]);
          }).catch(() => resolve([]));
        };
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB draft inventory transaction aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB draft inventory transaction failed"));
      } catch (error) {
        reject(error);
      }
    });
  }

  private async readBranches(): Promise<BrowserRecoveryBranch[]> {
    const database = await this.database();
    if (database === null) return [];
    return new Promise((resolve, reject) => {
      try {
        const transaction = database.transaction(IndexedDBRecoveryStore.objectStoreName, "readonly");
        const store = transaction.objectStore(IndexedDBRecoveryStore.objectStoreName);
        const keys = store.getAllKeys();
        const values = store.getAll();
        transaction.oncomplete = () => {
          const entries = keys.result.map((key, index) => ({ key, value: values.result[index] }));
          void Promise.all(entries.map(async (entry) => {
            if (typeof entry.key !== "string") return null;
            const name = this.recordName(entry.key);
            if (name === null || !name.startsWith("branch:")) return null;
            const decoded = await this.decrypt(name, entry.value);
            if (decoded === null) {
              void this.remove(name).catch(() => undefined);
              return null;
            }
            return isRecoveryDraft(decoded) ? { id: name.slice("branch:".length), draft: cloneDraft(decoded) } : null;
          })).then((branches) => resolve(branches.filter((branch): branch is BrowserRecoveryBranch => branch !== null))).catch(() => resolve([]));
        };
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB branch inventory transaction aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB branch inventory transaction failed"));
      } catch (error) {
        reject(error);
      }
    });
  }

  private recordKey(name: string): string {
    return this.key + ":" + name;
  }

  private recordName(value: string): string | null {
    const prefix = this.key + ":";
    return value.startsWith(prefix) ? value.slice(prefix.length) : null;
  }
}

function cloneDraft(draft: BrowserRecoveryDraft): BrowserRecoveryDraft {
  return JSON.parse(JSON.stringify(draft)) as BrowserRecoveryDraft;
}

function isCursorState(value: unknown): value is { epoch: string; cursor: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.epoch === "string" && record.epoch.length > 0 && Number.isSafeInteger(record.cursor) && (record.cursor as number) >= 0;
}

function isRecoveryDraft(value: unknown): value is BrowserRecoveryDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const base = record.base;
  if (record.schemaVersion !== 1 || typeof record.clientId !== "string" || record.clientId.length === 0 || !Array.isArray(record.changes) ||
    typeof base !== "object" || base === null || Array.isArray(base) || !Array.isArray((base as Record<string, unknown>).cells)) return false;
  const identity = base as Record<string, unknown>;
  if (typeof identity.epoch !== "string" || !Number.isSafeInteger(identity.cursor) || (identity.cursor as number) < 0 ||
    !Number.isSafeInteger(identity.version) || (identity.version as number) < 0 || !Number.isSafeInteger(identity.documentRevision) ||
    (identity.documentRevision as number) < 0) return false;
  if (!(identity.cells as unknown[]).every((cell) => {
    if (typeof cell !== "object" || cell === null || Array.isArray(cell)) return false;
    const item = cell as Record<string, unknown>;
    return typeof item.id === "string" && item.id.length > 0 && Number.isSafeInteger(item.revision) && (item.revision as number) >= 0 &&
      (item.type === "code" || item.type === "markdown") && Array.isArray(item.body) && (item.body as unknown[]).every((line) => typeof line === "string");
  })) return false;
  if (!(record.changes as unknown[]).every((change) => documentChangeSchema.safeParse(change).success)) return false;
  const operation = record.operation;
  if (operation !== null && operation !== undefined) {
    if (typeof operation !== "object" || Array.isArray(operation)) return false;
    const item = operation as Record<string, unknown>;
    if (typeof item.operationId !== "string" || item.operationId.length === 0 || (item.kind !== "transaction" && item.kind !== "run") ||
      !Number.isSafeInteger(item.commandSequence) || (item.commandSequence as number) < 1 || !Number.isSafeInteger(item.expectedDocumentRevision) ||
      (item.expectedDocumentRevision as number) < 0) return false;
    if (item.clientId !== undefined && (typeof item.clientId !== "string" || item.clientId.length === 0)) return false;
    if (item.changes !== undefined && (!Array.isArray(item.changes) || !item.changes.every((change) => documentChangeSchema.safeParse(change).success))) return false;
  }
  return true;
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
  nextCommandSequence?: number;
  recoveryStore?: RecoveryStore;
  resumeFromStore?: boolean;
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

export type BrowserCommand = {
  [Kind in HostCommand["type"]]: Omit<Extract<HostCommand, { type: Kind }>, "commandSequence">
}[HostCommand["type"]];

interface PendingCommand {
  command: HostCommand;
  resolve(admission: CommandAdmission): void;
  reject(error: BrowserTransportError): void;
  sentGeneration: number;
}
interface ConnectionAttempt {
  generation: number;
  socket: WebSocketLike;
  receiveChain: Promise<void>;
  handshakeTimer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Authenticated browser transport for the host v2 protocol. Commands retain
 * their assigned commandSequence across reconnects; only the host admission
 * advances the lease high-water mark.
 */
export class BrowserTransport {
  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<number, PendingCommand>();
  private nextSequence: number;
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
  readonly recoveryStore: RecoveryStore;

  constructor(private readonly options: BrowserTransportOptions = {}) {
    const sequence = options.nextCommandSequence ?? 1;
    this.nextSequence = Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 1;
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
  get commandSequence(): number { return this.nextSequence; }
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

  dispatch(command: BrowserCommand): Promise<CommandAdmission> {
    if (this.stopped) return Promise.reject(new BrowserTransportError("transport_closed", "browser transport is closed", true));
    if (this.pending.size >= (this.options.maxQueuedCommands ?? 1_000)) return Promise.reject(new BrowserTransportError("client_backpressure", "too many browser commands are pending", true));
    if (!this.id || !this.leaseId || !this.csrf) return Promise.reject(new BrowserTransportError("session_credentials_missing", "browser session credentials are missing", true));
    const sequence = this.nextSequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) return Promise.reject(new BrowserTransportError("command_sequence_exhausted", "browser command sequence is exhausted", true));
    const sessionEpoch = this.epochValue ?? command.sessionEpoch;
    if (!sessionEpoch) return Promise.reject(new BrowserTransportError("not_ready", "browser session epoch is not known", true));
    const wireCommand = {
      ...command,
      operationId: command.operationId,
      clientId: this.id,
      commandSequence: sequence,
      sessionEpoch,
    } as HostCommand;
    this.nextSequence = sequence + 1;
    return new Promise<CommandAdmission>((resolve, reject) => {
      this.pending.set(sequence, { command: wireCommand, resolve, reject, sentGeneration: -1 });
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
    for (const pending of this.pending.values()) pending.reject(new BrowserTransportError(error.code, error.message, pending.sentGeneration < 0));
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
        socket.send(JSON.stringify({ type: "connect", protocolVersion: HOST_CLIENT_PROTOCOL_VERSION, leaseId: this.leaseId, clientId: this.id, csrf: this.csrf, epoch: this.epochValue, cursor: this.cursorValue }));
        this.options.onState?.("recovering");
      } catch (error) {
        this.handleAttemptFailure(generation, asError(error, "browser WebSocket handshake failed"));
      }
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(attempt)) return;
      if (this.recovered) {
        attempt.receiveChain = this.receive(event.data).catch((error) => this.handleAttemptFailure(generation, asError(error, "invalid host message")));
        return;
      }
      attempt.receiveChain = attempt.receiveChain.then(async () => {
        if (this.isCurrent(attempt)) await this.receive(event.data);
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

  private async receive(raw: unknown): Promise<void> {
    if (typeof raw !== "string" && !(raw instanceof Uint8Array)) throw new BrowserTransportError("invalid_server_message", "host message is not a JSON frame");
    const message = decodeJsonFrame(raw, SNAPSHOT_ENVELOPE_LIMIT) as Record<string, unknown>;
    if (!this.recovered && message.type !== "recovery") throw new BrowserTransportError("host_identity_mismatch", "host sent data before proving its process identity");
    if (message.type === "recovery") {
      if (message.protocolVersion !== HOST_CLIENT_PROTOCOL_VERSION) throw new BrowserTransportError("protocol_mismatch", "host and browser protocol versions differ");
      if (this.continuityProof && message.continuityProof !== this.continuityProof) throw new BrowserTransportError("host_identity_mismatch", "browser reconnected to a different host process");
      const recovery = await this.loadRecovery(message.recovery);
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
      await this.recoveryStore.save(event.epoch, event.cursor);
      return;
    }
    if (message.type === "commandResult") {
      if (!Number.isSafeInteger(message.sequence)) throw new BrowserTransportError("invalid_server_message", "command result has no sequence");
      const sequence = message.sequence as number;
      const pending = this.pending.get(sequence);
      if (!pending) return;
      const admission = commandAdmissionSchema.safeParse(message.result);
      if (!admission.success) throw new BrowserTransportError("invalid_server_message", "invalid command admission");
      this.pending.delete(sequence);
      this.nextSequence = Math.max(this.nextSequence, admission.data.nextCommandSequence);
      pending.resolve(admission.data);
      return;
    }
    if (message.type === "error") {
      const sequence = Number.isSafeInteger(message.sequence) ? message.sequence as number : null;
      const detail = asErrorDetail(message.error);
      if (sequence === null) throw new BrowserTransportError(detail.code, detail.message);
      const pending = this.pending.get(sequence);
      if (pending) {
        this.pending.delete(sequence);
        pending.reject(new BrowserTransportError(detail.code, detail.message, message.definitive === true));
      }
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
    const priorEpoch = this.epochValue;
    if (recovery.kind === "snapshot") {
      this.epochValue = recovery.epoch;
      this.cursorValue = recovery.cursor;
      if (priorEpoch !== null && priorEpoch !== recovery.epoch) {
        const error = new BrowserTransportError("session_replaced", "notebook session was replaced while reconnecting");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      }
      this.options.onSnapshot?.(recovery.snapshot);
      await this.recoveryStore.save(recovery.epoch, recovery.cursor);
      return;
    }
    if (this.epochValue !== null && recovery.epoch !== this.epochValue) throw new BrowserTransportError("recovery_base_mismatch", "replay recovery belongs to another session epoch");
    const stored = this.options.resumeFromStore === false ? null : await this.recoveryStore.load();
    if (stored !== null && (stored.epoch !== recovery.epoch || stored.cursor > recovery.cursor)) throw new BrowserTransportError("recovery_base_mismatch", "stored browser recovery cursor does not match host replay");
    this.epochValue = recovery.epoch;
    let cursor = this.cursorValue ?? -1;
    for (const event of recovery.events) {
      if (event.epoch !== this.epochValue || event.cursor <= cursor) continue;
      this.options.onEvent?.(event);
      cursor = event.cursor;
      this.cursorValue = cursor;
    }
    this.cursorValue = Math.max(cursor, recovery.cursor);
    await this.recoveryStore.save(this.epochValue, this.cursorValue);
  }

  private flush(): void {
    if (!this.recovered || this.socket?.readyState !== OPEN) return;
    for (const [sequence, pending] of this.pending) {
      if (pending.sentGeneration === this.generation) continue;
      pending.sentGeneration = this.generation;
      try {
        this.socket.send(JSON.stringify({ type: "command", sequence, command: encodeHostCommandWire(pending.command) }));
      } catch (error) {
        this.handleAttemptFailure(this.generation, asError(error, "browser command send failed"));
        return;
      }
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
