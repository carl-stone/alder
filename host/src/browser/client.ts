import { BrowserDocument, type BrowserRunCommand, type BrowserTransactionCommand, type LocalCell, type SourceCommitOutcome } from "./document.js";
import { BrowserTransport, BrowserTransportError, type BrowserCommand, type BrowserDraftStore, type BrowserRecoveryBranch, type BrowserRecoveryDraft, type BrowserTransportOptions } from "./transport.js";
import { notebookUrl } from "./url.js";
import type {
  CellType,
  DocumentChange,
  JsonValue,
  CommandAdmission,
  CommandResult,
  HostCommand,
  HostEvent,
  HostQuery,
  HostQueryResult,
  HostSnapshot,
  OperationRecord,
  ArtifactHandle,
  Recovery,
  RecoveryBranch,
  RecoveryState,
  HostError,
} from "../protocol.js";
import {
  ARTIFACT_DESCRIPTOR_HEADER,
  ARTIFACT_RESOLUTION_MEDIA_TYPE,
  MAX_ARTIFACT_DESCRIPTOR_HEADER_BYTES,
  artifactHandleSchema,
  artifactResolutionSchema,
  decodeHostQueryResultWire,
  decodeJsonFrame,
  encodeArtifactDescriptor,
  encodeHostQueryWire,
  hostQueryResultSchema,
  recoveryStateSchema,
  sameArtifactHandle,
} from "../protocol.js";

export interface VisibleResultObservation {
  operationId: string;
  runId: string | null;
  cellId: string;
  revision: number;
  inputTimestamp: number;
  handlerTimestamp: number;
  presentedTimestamp: number;
  proxy: "two-animation-frames";
}

export interface NotebookClientOptions extends Omit<BrowserTransportOptions, "onSnapshot" | "onEvent"> {
  onVisibleResult?: (observation: VisibleResultObservation) => void;
  onCommand?: (command: HostCommand, result: CommandResult) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  now?: () => number;
}

interface RunIntent {
  operationId: string;
  targetKey: string;
  inputTimestamp: number;
  handlerTimestamp: number;
}

interface OperationWaiter {
  resolve(operation: OperationRecord): void;
  reject(error: BrowserTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}
interface SourceCommitWaiter {
  resolve(): void;
  reject(error: BrowserTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ArtifactCacheEntry {
  url: string;
  expiresAt: number;
}

type DocumentListener = (
  document: BrowserDocument,
  event?: HostEvent,
  localCellKeys?: readonly string[],
) => void;

export type BrowserRecoveryStatus = "none" | "restored" | "conflict" | "resubmitting" | "kept";
export interface BrowserRecoveryState {
  status: BrowserRecoveryStatus;
  local: BrowserRecoveryDraft | null;
  branches: RecoveryBranch[];
  keptBranches: BrowserRecoveryBranch[];
  foreignDrafts: number;
  pending: boolean;
  corruption: HostError | null;
  persistenceError: HostError | null;
}

type RecoveryListener = (state: BrowserRecoveryState) => void;

type SourceCommand = BrowserTransactionCommand | BrowserRunCommand;
type ServiceName = "publish" | "packages.status" | "packages.declare" | "packages.install" | "upload" | "check";

export class BrowserNotebookClient {
  readonly transport: BrowserTransport;
  private documentValue: BrowserDocument | null = null;
  private listeners = new Set<DocumentListener>();
  private runs = new Map<string, RunIntent>();
  private operations = new Map<string, OperationRecord>();
  private operationWaiters = new Map<string, Set<OperationWaiter>>();
  private sourceCommitWaiters = new Map<string, SourceCommitWaiter>();
  private sourceQueue: Promise<void> = Promise.resolve();
  private readonly frame: (callback: FrameRequestCallback) => number;
  private readonly now: () => number;
  private artifactCache = new Map<string, ArtifactCacheEntry>();
  private recoveryStateValue: BrowserRecoveryState = { status: "none", local: null, branches: [], keptBranches: [], foreignDrafts: 0, pending: false, corruption: null, persistenceError: null };
  private recoveryListeners = new Set<RecoveryListener>();
  private draftOperation: BrowserRecoveryDraft["operation"] = null;
  private draftPersistence: Promise<void> = Promise.resolve();
  private draftGeneration = 0;
  private draftPersistenceError: Error | null = null;
  private recoveryAttempted = false;
  private releaseDraftOwnership: (() => void) | null = null;
  private browserRecoveryInspected = false;
  private hostRecoveryInspected = false;
  private keptRecoveryInspected = false;
  private startupActivated = false;
  private draftOwnershipReady: Promise<void> = Promise.resolve();

  constructor(private readonly options: NotebookClientOptions = {}) {
    this.frame = options.requestAnimationFrame ?? ((callback) => requestAnimationFrame(callback));
    this.now = options.now ?? (() => performance.now());
    this.transport = new BrowserTransport({
      ...options,
      onSnapshot: (snapshot) => this.receiveSnapshot(snapshot),
      onEvent: (event) => this.receiveEvent(event),
      onState: (state, error) => {
        options.onState?.(state, error);
        if (state === "open" && this.recoveryAttempted) void this.refreshRecoveryState();
      },
    });
    this.draftOwnershipReady = this.holdDraftOwnership();
  }

  get document(): BrowserDocument | null { return this.documentValue; }

  async connect(): Promise<BrowserDocument> {
    const recovery = await this.transport.connect();
    if (!this.documentValue && recovery.kind === "snapshot") this.receiveSnapshot(recovery.snapshot);
    if (!this.documentValue) throw new BrowserTransportError("recovery_requires_snapshot", "browser has no base snapshot for replay recovery");
    if (!this.recoveryAttempted) this.recoveryAttempted = true;
    if (!this.browserRecoveryInspected) {
      try {
        await this.restoreBrowserRecovery();
        this.browserRecoveryInspected = true;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.recoveryStateValue = { ...this.recoveryStateValue, persistenceError: { code: "recovery_inventory_failed", message: failure.message } };
        this.notifyRecovery();
      }
    }
    if (!this.hostRecoveryInspected) this.hostRecoveryInspected = await this.refreshRecoveryState();
    if (!this.keptRecoveryInspected) this.keptRecoveryInspected = await this.refreshKeptBranches();
    await this.activateStartupIfSafe();
    return this.documentValue;
  }

  async discardAndClose(): Promise<void> {
    await this.discardRecovery();
    await this.transport.release("discard");
    this.finishClose();
  }
  close(): void {
    this.transport.close();
    this.finishClose();
  }

  private finishClose(): void {
    this.rejectOperationWaiters(new BrowserTransportError("transport_closed", "browser transport is closed"));
    this.rejectSourceCommitWaiters(new BrowserTransportError("transport_closed", "browser transport is closed"));
    this.operations.clear();
    this.runs.clear();
    this.artifactCache.clear();
    this.releaseDraftOwnership?.();
    this.releaseDraftOwnership = null;
  }

  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    if (this.documentValue) listener(this.documentValue);
    return () => this.listeners.delete(listener);
  }

  get recoveryState(): BrowserRecoveryState { return this.recoveryStateValue; }

  subscribeRecovery(listener: RecoveryListener): () => void {
    this.recoveryListeners.add(listener);
    listener(this.recoveryStateValue);
    return () => this.recoveryListeners.delete(listener);
  }

  async flushDraftPersistence(): Promise<void> {
    await this.draftPersistence;
    this.queueDraftPersistence();
    await this.draftPersistence;
    if (this.draftPersistenceError) throw this.draftPersistenceError;
  }

  async keepAsRecovery(): Promise<void> {
    await this.beginDraftMutation();
    const store = this.draftStore();
    const draft = this.documentValue?.recoveryDraft(this.transport.id, null) ?? await store?.loadDraft(this.transport.id).catch(() => null) ?? null;
    if (draft && store) {
      await store.saveBranch("browser-" + operationId("branch"), draft);
      await store.clearDraft(this.transport.id);
    }
    this.draftGeneration += 1;
    this.resetAuthoritativeDocument();
    await this.refreshKeptBranches();
    this.recoveryStateValue = { ...this.recoveryStateValue, status: "kept", local: null };
    this.notifyRecovery();
    this.notify();
    await this.activateStartupIfSafe();
  }

  async restoreKeptRecovery(branchId: string): Promise<void> {
    await this.beginDraftMutation();
    const store = this.draftStore();
    const branch = this.recoveryStateValue.keptBranches.find((candidate) => candidate.id === branchId);
    if (!store || !branch) return;
    const active = this.documentValue?.recoveryDraft(this.transport.id, null) ?? null;
    if (active) await store.saveBranch("browser-" + operationId("swap"), active);
    let recovered = branch.draft;
    let acknowledgedRevision: number | null = null;
    if (recovered.operation) {
      try {
        const owner = recovered.operation.clientId ?? recovered.clientId;
        const queried = await this.query({ type: "operation", operationId: recovered.operation.operationId, clientId: owner });
        if (isOperation(queried.result) && queried.result.clientId === owner && queried.result.status === "done") {
          acknowledgedRevision = recovered.operation.expectedDocumentRevision;
          recovered = this.reconcileAcknowledgedCreations(recovered, queried.result);
        }
      } catch {}
    }
    this.draftGeneration += 1;
    this.resetAuthoritativeDocument();
    const conflict = acknowledgedRevision === null
      ? !this.recoveryBaseMatches(recovered)
      : this.requireDocument().snapshot.documentRevision > acknowledgedRevision + 1;
    this.requireDocument().restoreDraft(recovered, conflict);
    if (!conflict) this.requireDocument().rebaseDraftToSnapshot();
    const local = this.requireDocument().recoveryDraft(this.transport.id, null);
    if (local) await store.saveDraft(local); else await store.clearDraft(this.transport.id);
    await store.deleteBranch(branchId);
    await this.refreshKeptBranches();
    this.recoveryStateValue = { ...this.recoveryStateValue, status: local === null ? "none" : conflict ? "conflict" : "restored", local };
    this.notifyRecovery();
    this.notify();
    await this.activateStartupIfSafe();
  }

  async discardKeptRecovery(branchId: string): Promise<void> {
    const store = this.draftStore();
    if (!store) return;
    await store.deleteBranch(branchId);
    await this.refreshKeptBranches();
    await this.activateStartupIfSafe();
  }

  async discardRecovery(): Promise<void> {
    await this.beginDraftMutation();
    await this.draftStore()?.clearDraft(this.transport.id);
    this.draftGeneration += 1;
    this.resetAuthoritativeDocument();
    this.recoveryStateValue = { ...this.recoveryStateValue, status: "none", local: null };
    this.notifyRecovery();
    this.notify();
    await this.activateStartupIfSafe();
  }

  async reloadAuthoritativeRecovery(): Promise<void> {
    const snapshot = this.requireDocument().snapshot;
    if (snapshot.disk.digest === null || snapshot.disk.version === null) throw new Error("authoritative source is not reloadable");
    const result = await this.dispatchSettled({
      type: "reload-source",
      ...this.base("reload-source"),
      expectedDiskDigest: snapshot.disk.digest,
      expectedDiskVersion: snapshot.disk.version,
    });
    if (isRecord(result.result) && result.result.conflict === true) {
      throw new BrowserTransportError("document_conflict", "Authoritative reload was refused because the host document has unsaved changes", true);
    }
    await this.discardRecovery();
  }

  cancelRecovery(): void {
    if (this.recoveryStateValue.local === null) return;
    this.recoveryStateValue = { ...this.recoveryStateValue, status: this.recoveryStateValue.status === "resubmitting" ? "resubmitting" : "conflict" };
    this.notifyRecovery();
  }

  createCell(afterKey: string | null, type: CellType = "code", body: readonly string[] = []): LocalCell {
    const document = this.requireDocument();
    const cell = document.create(operationId("create"), afterKey, type, body);
    document.focus(cell.key);
    this.notify();
    this.queueDraftPersistence();
    return cell;
  }

  editCell(key: string, source: string | readonly string[], type?: CellType): LocalCell {
    const lines = typeof source === "string" ? splitSource(source) : [...source];
    const cell = this.requireDocument().edit(key, lines, type);
    this.notify(undefined, [key]);
    this.queueDraftPersistence();
    return cell;
  }

  async commitEdits(): Promise<CommandResult | null> {
    return this.withSourceLock(() => this.commitEditsUnlocked());
  }

  private async commitEditsUnlocked(): Promise<CommandResult | null> {
    const document = this.requireDocument();
    if (document.hasSourceConflicts) throw new BrowserTransportError("source_conflict", "resolve deleted or conflicting local source before continuing");
    const command = document.buildTransactionCommand(operationId("transaction"), this.transport.id);
    if (command === null) return null;
    return this.dispatchSource(command, true);
  }

  async runCell(key: string, input?: Event | { timeStamp: number }): Promise<CommandResult> {
    const id = operationId("run");
    this.runs.set(id, {
      operationId: id,
      targetKey: key,
      inputTimestamp: normalizeInputTimestamp(input?.timeStamp, this.now()),
      handlerTimestamp: this.now(),
    });
    try {
      return await this.withSourceLock(() => {
        const command = this.requireDocument().buildRunCommand({ operationId: id, clientId: this.transport.id, scope: "cell", targetKey: key });
        return this.dispatchSource(command, false);
      });
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
  }

  async runAll(scope: "all" | "stale" = "all", input?: Event | { timeStamp: number }): Promise<CommandResult> {
    const id = operationId("run");
    void input;
    return this.withSourceLock(() => {
      const command = this.requireDocument().buildRunCommand({ operationId: id, clientId: this.transport.id, scope });
      return this.dispatchSource(command, false);
    });
  }

  async interrupt(runId?: string): Promise<CommandResult> {
    return this.dispatch({ type: "interrupt", ...this.base("interrupt", false), ...(runId ? { runId } : {}) });
  }

  async restart(replay = true): Promise<CommandResult> {
    const command = { type: "restart", replay, ...this.base("restart"), ...(replay ? { expectedDocumentRevision: this.requireDocument().snapshot.documentRevision } : {}) } as Omit<Extract<HostCommand, { type: "restart" }>, "commandSequence">;
    return replay ? this.dispatchSettled(command) : this.dispatch(command);
  }

  async save(): Promise<CommandResult> {
    await this.commitEdits();
    return this.dispatchSettled({ type: "save", ...this.base("save") });
  }

  async saveAs(path: string): Promise<CommandResult> {
    await this.commitEdits();
    const result = await this.dispatchSettled({ type: "save-as", path, expectedDestination: "absent", ...this.base("save-as") });
    await this.refreshRecoveryState();
    return result;
  }

  async selectR(rscript: string, persistDefault = true): Promise<CommandResult> {
    await this.commitEdits();
    return this.dispatchSettled({
      type: "select-r",
      ...this.base("select-r"),
      rscript,
      persistDefault,
      expectedDocumentRevision: this.requireDocument().snapshot.documentRevision,
    });
  }
  async shutdown(): Promise<CommandResult> {
    const document = this.requireDocument();
    const expectedClientIds = document.snapshot.activeClientIds ?? [this.transport.id];
    // The accepted response is the final message that this host can guarantee:
    // successful shutdown closes the transport before an operation update arrives.
    return this.dispatch({ type: "shutdown", ...this.base("shutdown"), expectedClientIds });
  }

  async deleteCell(key: string): Promise<CommandResult | null> {
    return this.withSourceLock(async () => {
      const document = this.requireDocument();
      const cell = this.requireCell(key);
      if (!cell.id || cell.tombstone) {
        document.discardLocal(key);
        this.notify();
        this.queueDraftPersistence();
        return null;
      }
      const command: BrowserTransactionCommand = {
        type: "transaction", ...this.base("delete"), changes: [{ type: "delete", cell: { cellId: cell.id }, expectedRevision: cell.serverRevision }],
      };
      return this.dispatchSource(command, true);
    });
  }

  async restoreDeletedCell(key: string): Promise<CommandResult | null> {
    return this.withSourceLock(() => {
      this.requireDocument().restoreDeleted(key, operationId("create"));
      this.notify(undefined, [key]);
      this.queueDraftPersistence();
      return this.commitEditsUnlocked();
    });
  }

  discardLocalCell(key: string): void {
    this.requireDocument().discardLocal(key);
    this.notify();
    this.queueDraftPersistence();
  }

  useServerVersion(key: string): void {
    this.requireDocument().useServerVersion(key);
    this.notify(undefined, [key]);
    this.queueDraftPersistence();
  }

  async moveCell(key: string, afterKey: string | null): Promise<CommandResult> {
    return this.withSourceLock(() => {
      const cell = this.requireCell(key);
      const after = afterKey === null ? null : this.requireCell(afterKey).id;
      if (!cell.id || (afterKey !== null && !after)) throw new BrowserTransportError("invalid_request", "cells must be acknowledged before moving");
      const command: BrowserTransactionCommand = {
        type: "transaction", ...this.base("move"), changes: [{ type: "move", cell: { cellId: cell.id }, after: after ? { cellId: after } : null }],
      };
      return this.dispatchSource(command, true);
    });
  }

  async setDisabled(key: string, disabled: boolean): Promise<CommandResult> {
    return this.withSourceLock(() => {
      const cell = this.requireCell(key);
      if (!cell.id) throw new BrowserTransportError("invalid_request", "cell must be acknowledged before changing disabled state");
      const command: BrowserTransactionCommand = {
        type: "transaction", ...this.base("options"), changes: [{ type: "options", cell: { cellId: cell.id }, expectedRevision: cell.serverRevision, patch: { disabled } }],
      };
      return this.dispatchSource(command, true);
    });
  }

  async setWidget(name: string, path: readonly string[], update: Record<string, unknown>, source: "editor" | "app" = "editor"): Promise<CommandResult> {
    const owner = this.findWidgetOwner(name);
    if (!owner) throw new BrowserTransportError("not_found", `widget owner is unavailable: ${name}`);
    const kernelEpoch = this.kernelEpoch();
    return this.dispatchSettled({ type: "widget", ...this.base("widget", false), name, path: [...path], update, source, kernelEpoch, expectedRevision: owner.serverRevision });
  }

  async requestLazy(key: string): Promise<CommandResult> {
    return this.dispatchSettled({ type: "lazy-output", ...this.base("lazy", false), key, kernelEpoch: this.kernelEpoch() });
  }

  async requestTable(options: { handle: string; offset?: number; limit?: number; sortBy?: string; sortDescending?: boolean; filter?: string }): Promise<CommandResult> {
    return this.dispatchSettled({ type: "table-page", ...this.base("table", false), handle: options.handle, offset: options.offset ?? 0, limit: options.limit ?? 25, sortBy: options.sortBy ?? "", sortDescending: options.sortDescending ?? false, filter: options.filter ?? "", kernelEpoch: this.kernelEpoch() });
  }

  async inspect(name: string): Promise<CommandResult> {
    return this.dispatchSettled({ type: "inspect", ...this.base("inspect", false), name, kernelEpoch: this.kernelEpoch() });
  }

  async setRuntime(update: { executionMode?: "automatic" | "lazy"; runOnStartup?: boolean }): Promise<CommandResult> {
    const change: { on_cell_change?: "automatic" | "lazy"; on_startup?: boolean } = {};
    if (update.executionMode !== undefined) change.on_cell_change = update.executionMode;
    if (update.runOnStartup !== undefined) change.on_startup = update.runOnStartup;
    if (change.on_cell_change === undefined && change.on_startup === undefined) throw new BrowserTransportError("invalid_request", "runtime update is empty");
    return this.dispatch({ type: "set-runtime", ...this.base("runtime"), ...change });
  }

  async setConfig(patch: Record<string, unknown>): Promise<CommandResult> {
    return this.dispatch({ type: "set-config", ...this.base("config"), patch: jsonRecord(patch), expectedSidecarVersion: this.requireDocument().snapshot.sidecars.config.version });
  }

  async setLayout(layout: unknown): Promise<CommandResult> {
    return this.dispatch({ type: "set-layout", ...this.base("layout"), layout: layout as Extract<HostCommand, { type: "set-layout" }>["layout"], expectedSidecarVersion: this.requireDocument().snapshot.sidecars.layout.version });
  }

  async formatCells(keys?: readonly string[]): Promise<CommandResult> {
    await this.commitEdits();
    const cells = keys?.map((key) => this.requireCell(key)) ?? [...this.requireDocument().cells];
    const acknowledged = cells.filter((cell): cell is LocalCell & { id: string } => cell.id !== null);
    return this.dispatchSettled({ type: "format", ...this.base("format"), ...(keys ? { cellIds: acknowledged.map((cell) => cell.id) } : {}), expectedRevisions: Object.fromEntries(acknowledged.map((cell) => [cell.id, cell.serverRevision])) });
  }

  async resolveArtifact(descriptor: ArtifactHandle): Promise<string> {
    const parsedDescriptor = artifactHandleSchema.safeParse(descriptor);
    if (!parsedDescriptor.success) throw new BrowserTransportError("output_invalid", "artifact descriptor is invalid");
    const requested = parsedDescriptor.data;
    const cacheKey = encodeArtifactDescriptor(requested);
    const cached = this.artifactCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return cached.url;
      this.artifactCache.delete(cacheKey);
    }
    if (typeof fetch !== "function" || typeof location === "undefined") throw new BrowserTransportError("artifact_unavailable", "artifact loading is unavailable");
    const descriptorHeader = cacheKey;
    const query: HostQuery = { type: "output", handle: requested.handle, offset: 0, limit: requested.chunkBytes };
    const response = await fetch(notebookUrl("/api/query"), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: ARTIFACT_RESOLUTION_MEDIA_TYPE,
        [ARTIFACT_DESCRIPTOR_HEADER]: descriptorHeader,
        "X-CSRF-Token": this.transport.csrf,
      },
      body: JSON.stringify(encodeHostQueryWire(query)),
    });
    this.transport.assertResponseContinuity(response);
    if (!response.ok) throw new BrowserTransportError("output_expired", "artifact resolution failed (" + response.status + ")");
    if (response.headers.get("Content-Type") !== ARTIFACT_RESOLUTION_MEDIA_TYPE) {
      throw new BrowserTransportError("output_invalid", "artifact resolution returned an unexpected content type");
    }
    let value: unknown;
    try { value = decodeJsonFrame(await response.text(), MAX_ARTIFACT_DESCRIPTOR_HEADER_BYTES); }
    catch { throw new BrowserTransportError("output_invalid", "artifact resolution is not valid bounded JSON"); }
    let resolution;
    try { resolution = artifactResolutionSchema.parse(value); }
    catch { throw new BrowserTransportError("output_invalid", "artifact resolution is invalid"); }
    if (!sameArtifactHandle(resolution.artifact, requested)) {
      throw new BrowserTransportError("stale_value", "artifact resolution identity is stale");
    }
    const url = safeArtifactPath(resolution.url);
    if (resolution.expiresAt <= Date.now()) throw new BrowserTransportError("output_expired", "artifact capability has expired");
    this.artifactCache.set(cacheKey, { url, expiresAt: resolution.expiresAt });
    return url;
  }
  async service(command: ServiceName, payload: Record<string, unknown> = {}, onAccepted?: (operationId: string) => void): Promise<CommandResult | HostQueryResult> {
    switch (command) {
      case "publish":
        return this.dispatchSettled({ type: "publish", ...this.base("publish"), includeCode: payload.include_code === true, ...(typeof payload.output_path === "string" ? { outputPath: payload.output_path } : {}) }, onAccepted);
      case "packages.declare":
        return this.dispatchSettled({ type: "packages-declare", ...this.base("packages-declare"), packages: stringArray(payload.packages), expectedSidecarVersion: this.requireDocument().snapshot.sidecars.packages.version }, onAccepted);
      case "packages.install":
        return this.dispatchSettled({ type: "packages-install", ...this.base("packages-install"), packages: stringArray(payload.packages), kernelEpoch: this.kernelEpoch() }, onAccepted);
      case "upload":
        return this.dispatchSettled({ type: "upload", ...this.base("upload", false), name: stringValue(payload.name), path: stringArray(payload.path), files: fileArray(payload.files), kernelEpoch: this.kernelEpoch() }, onAccepted);
      case "packages.status":
        return this.query({ type: "packages-status" });
      case "check":
        return this.query({ type: "check" });
    }
  }
  async query(query: HostQuery): Promise<HostQueryResult> {
    if (typeof fetch !== "function" || typeof location === "undefined") throw new BrowserTransportError("query_unavailable", "typed host queries are unavailable");
    const response = await fetch(notebookUrl("/api/query"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Alder-CSRF": this.transport.csrf }, body: JSON.stringify(encodeHostQueryWire(query)) });
    this.transport.assertResponseContinuity(response);
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new BrowserTransportError(response.status === 404 && query.type === "operation" ? "query_not_found" : "query_failed", "typed host query failed (" + response.status + ")");
    return hostQueryResultSchema.parse(decodeHostQueryResultWire(query, value));
  }
  private async activateStartupIfSafe(): Promise<void> {
    if (this.startupActivated) return;
    const state = this.recoveryStateValue;
    if (!this.browserRecoveryInspected || !this.hostRecoveryInspected || !this.keptRecoveryInspected) return;
    if (state.local !== null || (state.keptBranches.length > 0 && state.status !== 'kept') || state.foreignDrafts > 0 || state.branches.some(branch => branch.state !== 'clean') || state.pending || state.corruption !== null) return;
    const snapshot = this.requireDocument().snapshot;
    if (snapshot.runtime.startupActivated) {
      this.startupActivated = true;
      return;
    }
    if (!snapshot.runtime.documentReady || snapshot.runtime.rEnvironment === null) return;
    this.startupActivated = true;
    try {
      await this.dispatchSettled({ type: 'run', ...this.base('startup'), scope: 'all', startup: true });
    } catch (error) {
      if (error instanceof BrowserTransportError && error.code === 'startup_already_activated') return;
      this.startupActivated = false;
      throw error;
    }
  }

  awaitOperation(id: string, timeoutMs = 120_000): Promise<OperationRecord> {
    const current = this.operations.get(id);
    if (current && operationSettled(current)) return Promise.resolve(current);
    return new Promise<OperationRecord>((resolve, reject) => {
      const waiter: OperationWaiter = {
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          this.removeOperationWaiter(id, waiter);
          reject(new BrowserTransportError("operation_timeout", `operation ${id} did not settle in time`));
        }, timeoutMs),
      };
      const waiters = this.operationWaiters.get(id) ?? new Set<OperationWaiter>();
      waiters.add(waiter);
      this.operationWaiters.set(id, waiters);
    });
  }

  private holdDraftOwnership(): Promise<void> {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return Promise.resolve();
    return new Promise((ready) => {
      void locks.request("alder-draft:" + this.transport.id, async () => {
        await new Promise<void>((release) => {
          this.releaseDraftOwnership = release;
          ready();
        });
      }).catch(() => ready());
    });
  }

  private tryClaimDraftOwnership(clientId: string): Promise<(() => void) | null> {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      void locks.request("alder-draft:" + clientId, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          settled = true;
          resolve(null);
          return;
        }
        await new Promise<void>((release) => {
          settled = true;
          resolve(release);
        });
      }).catch(() => {
        if (!settled) resolve(null);
      });
    });
  }

  private draftStore(): BrowserDraftStore | null {
    const store = this.transport.recoveryStore;
    return isBrowserDraftStore(store) ? store : null;
  }

  private queueDraftPersistence(): void {
    const store = this.draftStore();
    if (!store) return;
    const generation = this.draftGeneration;
    this.draftPersistence = this.draftPersistence.catch(() => undefined).then(async () => {
      if (generation !== this.draftGeneration) return;
      const draft = this.documentValue?.recoveryDraft(this.transport.id, this.draftOperation) ?? null;
      if (draft) await store.saveDraft(draft);
      else await store.clearDraft(this.transport.id);
      this.draftPersistenceError = null;
      if (this.recoveryStateValue.persistenceError !== null) {
        this.recoveryStateValue = { ...this.recoveryStateValue, persistenceError: null };
        this.notifyRecovery();
      }
    }).catch((error) => {
      this.draftPersistenceError = error instanceof Error ? error : new Error(String(error));
      this.recoveryStateValue = { ...this.recoveryStateValue, persistenceError: { code: "draft_persistence_failed", message: this.draftPersistenceError.message } };
      this.notifyRecovery();
    });
  }

  private async beginDraftMutation(): Promise<void> {
    this.draftGeneration += 1;
    await this.draftPersistence.catch(() => undefined);
  }

  private async restoreBrowserRecovery(): Promise<void> {
    const store = this.draftStore();
    if (!store || !this.documentValue) throw new BrowserTransportError("recovery_store_unavailable", "browser recovery store is unavailable");
    await this.draftOwnershipReady;
    const drafts = await store.listDrafts();
    let draft = drafts.find((candidate) => candidate.clientId === this.transport.id) ?? null;
    let selectedOriginalId = this.transport.id;
    if (draft === null) {
      for (const candidate of drafts) {
        const release = await this.tryClaimDraftOwnership(candidate.clientId);
        if (release === null) continue;
        try {
          selectedOriginalId = candidate.clientId;
          draft = { ...candidate, clientId: this.transport.id };
          await store.saveDraft(draft);
          await store.clearDraft(candidate.clientId);
        } finally {
          release();
        }
        break;
      }
    }
    if (!draft) {
      this.recoveryStateValue = { ...this.recoveryStateValue, foreignDrafts: drafts.length };
      this.notifyRecovery();
      return;
    }
    for (const candidate of drafts) {
      if (candidate.clientId === selectedOriginalId || candidate.clientId === this.transport.id) continue;
      const release = await this.tryClaimDraftOwnership(candidate.clientId);
      if (release === null) continue;
      try {
        await store.saveBranch("browser-" + operationId("orphan"), candidate);
        await store.clearDraft(candidate.clientId);
      } finally {
        release();
      }
    }
    const remainingDrafts = await store.listDrafts();
    this.recoveryStateValue = { ...this.recoveryStateValue, foreignDrafts: remainingDrafts.filter((candidate) => candidate.clientId !== this.transport.id).length };
    this.notifyRecovery();
    let receipt: OperationRecord | null = null;
    if (draft.operation) {
      try {
        const receiptClientId = draft.operation.clientId ?? selectedOriginalId;
        const queryResult = await this.query({ type: "operation", operationId: draft.operation.operationId, clientId: receiptClientId });
        receipt = isOperation(queryResult.result) && queryResult.result.clientId === receiptClientId ? queryResult.result : null;
      } catch (error) {
        if (!(error instanceof BrowserTransportError) || error.code !== "query_not_found") {
          await this.restoreLocalDraft(store, draft, true, "conflict");
          return;
        }
      }
      if (receipt !== null) {
        if (receipt.status === "done") {
          const submitted = draft.operation.changes;
          if (submitted !== undefined && sameChanges(draft.changes, submitted)) {
            await store.clearDraft(draft.clientId);
            this.resetAuthoritativeDocument();
            this.recoveryStateValue = { ...this.recoveryStateValue, status: "none", local: null };
            this.notifyRecovery();
            this.notify();
            return;
          }
          this.resetAuthoritativeDocument();
          const recovered = this.reconcileAcknowledgedCreations(draft, receipt);
          const conflict = submitted === undefined || this.requireDocument().snapshot.documentRevision > draft.operation.expectedDocumentRevision + 1;
          await this.restoreLocalDraft(store, recovered, conflict, conflict ? "conflict" : "restored");
          return;
        }
        await this.restoreLocalDraft(store, draft, true, "conflict");
        return;
      }
    }
    const conflict = !this.recoveryBaseMatches(draft);
    await this.restoreLocalDraft(store, draft, conflict, conflict ? "conflict" : draft.operation ? "resubmitting" : "restored");
    if (draft.operation && !conflict) await this.resubmitRecoveredDraft();
  }
  private reconcileAcknowledgedCreations(draft: BrowserRecoveryDraft, receipt: OperationRecord): BrowserRecoveryDraft {
    const result = isRecord(receipt.result) ? receipt.result : {};
    const created = isRecord(result.created) ? result.created : {};
    const submitted = draft.operation?.changes ?? [];
    const changes: DocumentChange[] = [];
    for (const change of draft.changes) {
      if (change.type === "create") {
        const cellId = created[change.creationId];
        if (typeof cellId === "string") {
          changes.push({
            type: "edit",
            cell: { cellId },
            body: [...change.body],
            cellType: change.cellType,
            expectedRevision: this.requireDocument().cell(cellId)?.serverRevision ?? 0,
          });
        } else {
          changes.push(cloneChange(change));
        }
        continue;
      }
      if (submitted.some((sent) => sameChanges([change], [sent]))) continue;
      changes.push(cloneChange(change));
    }
    return { ...draft, changes, operation: null };
  }


  private async restoreLocalDraft(store: BrowserDraftStore, draft: BrowserRecoveryDraft, conflict: boolean, status: BrowserRecoveryStatus): Promise<void> {
    this.requireDocument().restoreDraft(draft, conflict);
    if (!conflict) this.requireDocument().rebaseDraftToSnapshot();
    const local = this.requireDocument().recoveryDraft(this.transport.id, null);
    if (local) await store.saveDraft(local); else await store.clearDraft(this.transport.id);
    if (draft.clientId !== this.transport.id) await store.clearDraft(draft.clientId);
    this.recoveryStateValue = { ...this.recoveryStateValue, status: local === null ? "none" : status, local };
    this.notifyRecovery();
    this.notify();
  }
  private recoveryBaseMatches(draft: BrowserRecoveryDraft): boolean {
    const snapshot = this.requireDocument().snapshot;
    if (snapshot.epoch !== draft.base.epoch || snapshot.documentRevision !== draft.base.documentRevision || snapshot.cells.length !== draft.base.cells.length) return false;
    return draft.base.cells.every((baseCell, index) => {
      const current = snapshot.cells[index];
      return current !== undefined && current.id === baseCell.id && current.revision === baseCell.revision && current.type === baseCell.type && sameLines(current.body, baseCell.body);
    });
  }

  private async resubmitRecoveredDraft(): Promise<void> {
    const document = this.requireDocument();
    let command: BrowserTransactionCommand | null;
    try {
      command = document.buildTransactionCommand(operationId("recovery"), this.transport.id);
    } catch {
      this.recoveryStateValue = { ...this.recoveryStateValue, status: "conflict" };
      this.notifyRecovery();
      return;
    }
    if (command === null) {
      await this.draftStore()?.clearDraft(this.transport.id);
      this.recoveryStateValue = { ...this.recoveryStateValue, status: "none", local: null };
      this.notifyRecovery();
      return;
    }
    const submitted = { ...command, commandSequence: this.transport.commandSequence } as HostCommand;
    this.draftOperation = {
      operationId: command.operationId,
      clientId: this.transport.id,
      kind: "transaction",
      commandSequence: this.transport.commandSequence,
      expectedDocumentRevision: command.expectedDocumentRevision,
      changes: document.recoveryDraft(this.transport.id, null)?.changes ?? [],
    };
    document.noteSubmitted(command.operationId, submitted);
    this.queueDraftPersistence();
    let accepted: CommandResult;
    try {
      accepted = await this.dispatch(command);
    } catch (error) {
      this.handleSourceFailure(command, error);
      return;
    }
    this.recoveryStateValue = { ...this.recoveryStateValue, status: "resubmitting", local: document.recoveryDraft(this.transport.id, this.draftOperation) };
    this.notifyRecovery();
    void this.finishRecoveredDraft(command, accepted);
  }

  private async finishRecoveredDraft(command: BrowserTransactionCommand, accepted: CommandResult): Promise<void> {
    const document = this.requireDocument();
    try {
      const operation = operationSettled(accepted.operation) ? accepted.operation : await this.awaitOperation(accepted.operation.id);
      if (operation.status === "error" || operation.status === "cancelled") throw new BrowserTransportError(operation.error?.code ?? "recovery_failed", operation.error?.message ?? "recovered source could not be committed", true);
      document.acknowledge(settledCommandResult(accepted, operation));
      this.draftOperation = null;
      this.queueDraftPersistence();
      this.recoveryStateValue = { ...this.recoveryStateValue, status: "none", local: null };
      this.notifyRecovery();
      this.notify(undefined, sourceCellKeys(command, document));
    } catch (error) {
      this.handleSourceFailure(command, error);
    }
  }

  private resetAuthoritativeDocument(): void {
    if (!this.documentValue) return;
    this.documentValue = new BrowserDocument(this.documentValue.snapshot);
    this.draftOperation = null;
  }

  private async refreshRecoveryState(): Promise<boolean> {
    try {
      const result = await this.query({ type: "recovery" });
      const parsed = recoveryStateSchema.safeParse(result.result);
      if (!parsed.success) {
        this.recoveryStateValue = { ...this.recoveryStateValue, corruption: { code: "invalid_recovery_state", message: parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; ") } };
        this.notifyRecovery();
        return false;
      }
      const state = parsed.data as RecoveryState;
      this.recoveryStateValue = { ...this.recoveryStateValue, branches: state.branches, pending: state.pending, corruption: state.corruption };
      this.notifyRecovery();
      return true;
    } catch {
      return false;
    }
  }

  private async refreshKeptBranches(): Promise<boolean> {
    const store = this.draftStore();
    if (!store) return false;
    try {
      const keptBranches = await store.listBranches();
      this.recoveryStateValue = { ...this.recoveryStateValue, keptBranches };
      this.notifyRecovery();
      return true;
    } catch {
      return false;
    }
  }

  private notifyRecovery(): void {
    for (const listener of this.recoveryListeners) listener(this.recoveryStateValue);
  }

  private async dispatchSource(command: SourceCommand, waitForSettlement: boolean): Promise<CommandResult> {
    if (this.draftOperation !== null) {
      throw new BrowserTransportError("recovery_receipt_pending", "source changes are blocked until the previous operation receipt is reconciled");
    }
    const document = this.requireDocument();
    const submitted = { ...command, commandSequence: this.transport.commandSequence } as HostCommand;
    const commandChanges = command.changes ?? [];
    document.stageRecoveryIntent(commandChanges);
    const draftOperation: BrowserRecoveryDraft["operation"] = {
      operationId: command.operationId,
      clientId: this.transport.id,
      kind: command.type,
      commandSequence: this.transport.commandSequence,
      expectedDocumentRevision: command.expectedDocumentRevision,
      changes: commandChanges.map((change) => cloneChange(change)),
    };
    this.draftOperation = draftOperation;
    const recoveryDraft = document.recoveryDraft(this.transport.id, draftOperation);
    if (recoveryDraft) {
      const store = this.draftStore();
      if (!store) throw new BrowserTransportError("recovery_store_unavailable", "source intent cannot be sent without durable browser recovery storage");
      try {
        await store.saveDraft(recoveryDraft);
      } catch (error) {
        document.markStructuralRecoveryConflict();
        this.draftOperation = null;
        const failure = error instanceof Error ? error : new Error(String(error));
        this.draftPersistenceError = failure;
        this.recoveryStateValue = { ...this.recoveryStateValue, status: "conflict", local: document.recoveryDraft(this.transport.id, null), persistenceError: { code: "draft_persistence_failed", message: failure.message } };
        this.notifyRecovery();
        this.notify();
        throw failure;
      }
    }
    document.noteSubmitted(command.operationId, submitted);
    const sourceCommit = command.type === "run" && (command.changes?.length ?? 0) > 0
      ? this.awaitSourceCommit(command.operationId)
      : null;
    try {
      const accepted = await this.dispatch(command);
      if (sourceCommit !== null) {
        await sourceCommit;
        this.draftOperation = null;
        this.queueDraftPersistence();
        this.notify(undefined, sourceCellKeys(command, document));
        return { ...accepted, documentRevision: document.snapshot.documentRevision, version: document.snapshot.version, cursor: document.cursor };
      }
      const operation = waitForSettlement && !operationSettled(accepted.operation)
        ? await this.awaitOperation(accepted.operation.id)
        : accepted.operation;
      if (operation.status === "error" || operation.status === "cancelled") {
        throw new BrowserTransportError(operation.error?.code ?? (command.type + "_failed"), operation.error?.message ?? (command.type + " operation failed"), true);
      }
      const result = settledCommandResult(accepted, operation);
      document.acknowledge(result);
      this.draftOperation = null;
      this.queueDraftPersistence();
      this.notify(undefined, sourceCellKeys(command, document));
      return result;
    } catch (error) {
      this.removeSourceCommitWaiter(command.operationId);
      this.handleSourceFailure(command, error);
      throw error;
    }

  }

  private handleSourceFailure(command: SourceCommand, error: unknown): void {
    const document = this.requireDocument();
    if (this.draftOperation === null) {
      this.queueDraftPersistence();
      const local = document.recoveryDraft(this.transport.id, null);
      this.recoveryStateValue = { ...this.recoveryStateValue, status: local === null ? "none" : "conflict", local };
      this.notifyRecovery();
      this.notify();
      return;
    }
    const definitive = error instanceof BrowserTransportError && error.definitive;
    if (definitive) {
      document.reject(command.operationId, error.code);
      this.draftOperation = null;
    } else if ((command.changes ?? []).some((change) => !["create", "edit", "text-edit"].includes(change.type))) {
      document.markStructuralRecoveryConflict();
    }
    this.queueDraftPersistence();
    this.recoveryStateValue = {
      ...this.recoveryStateValue,
      status: "conflict",
      local: document.recoveryDraft(this.transport.id, this.draftOperation),
    };
    this.notifyRecovery();
    this.notify();
  }

  private async dispatch(command: BrowserCommand): Promise<CommandResult> {
    const admission = await this.transport.dispatch(command);
    const commandWithSequence = { ...command, clientId: this.transport.id, sessionEpoch: this.requireDocument().epoch, commandSequence: admission.commandSequence } as HostCommand;
    const admitted = admission.operation;
    if (admitted && !this.operations.has(admitted.id)) this.captureOperation(admitted);
    const retained = admitted ? this.operations.get(admitted.id) ?? admitted : null;
    const result = admissionResult(admission, this.requireDocument().snapshot, this.transport.cursor, commandWithSequence, retained);
    this.options.onCommand?.(commandWithSequence, result);
    if (!admission.accepted || admission.operation === null) {
      throw new BrowserTransportError(admission.error?.code ?? "command_rejected", admission.error?.message ?? (command.type + " command was rejected"), true);
    }
    return result;
  }

  private async dispatchSettled(command: BrowserCommand, onAccepted?: (operationId: string) => void): Promise<CommandResult> {
    const accepted = await this.dispatch(command);
    onAccepted?.(accepted.operation.id);
    const operation = operationSettled(accepted.operation) ? accepted.operation : await this.awaitOperation(accepted.operation.id);
    if (operation.status === "error" || operation.status === "cancelled") throw new BrowserTransportError(operation.error?.code ?? (command.type + "_failed"), operation.error?.message ?? (command.type + " operation failed"));
    return settledCommandResult(accepted, operation);
  }

  private receiveSnapshot(snapshot: HostSnapshot): void {
    if (this.documentValue !== null && this.documentValue.epoch !== snapshot.epoch) {
      const error = new BrowserTransportError("session_replaced", "notebook session was replaced while the operation was pending");
      this.rejectOperationWaiters(error);
      this.rejectSourceCommitWaiters(error);
      this.operations.clear();
      this.runs.clear();
      this.artifactCache.clear();
      this.draftOperation = null;
      this.queueDraftPersistence();
    }
    if (this.documentValue) this.documentValue.applySnapshot(snapshot);
    else this.documentValue = new BrowserDocument(snapshot);
    snapshot.operations.forEach((operation) => this.captureOperation(operation));
    this.notify();
  }

  private receiveEvent(event: HostEvent): void {
    const document = this.documentValue;
    if (!document) throw new BrowserTransportError("invalid_server_message", "received event without a notebook snapshot");
    document.applyEvent(event);
    if (event.type === "transaction" && event.operationId) {
      const outcome = sourceCommitOutcome(event.payload);
      if (outcome !== null) this.acknowledgeSourceCommit(event.operationId, outcome);
    }
    if (event.type === "receipt" || event.type === "operation") {
      const operation = operationFromEventPayload(event.payload);
      if (operation) this.captureOperation(operation);
    }
    this.notify(event);
    if (event.type === "runtime") void this.activateStartupIfSafe().catch(() => {});
    if (event.type === "cell-completed" && event.operationId) this.observeCompletion(event);
  }
  private observeCompletion(event: HostEvent): void {
    const intent = this.runs.get(event.operationId!);
    if (!intent || !event.cellId || typeof event.revision !== "number") return;
    const cell = this.requireDocument().cell(intent.targetKey);
    if (!cell || cell.id !== event.cellId || cell.serverRevision !== event.revision || !sameLines(cell.desiredBody, cell.serverBody)) return;
    this.runs.delete(intent.operationId);
    this.frame(() => this.frame(() => {
      this.options.onVisibleResult?.({ operationId: intent.operationId, runId: event.runId ?? null, cellId: event.cellId!, revision: event.revision!, inputTimestamp: intent.inputTimestamp, handlerTimestamp: intent.handlerTimestamp, presentedTimestamp: this.now(), proxy: "two-animation-frames" });
    }));
  }

  private base(label: string): { operationId: string; clientId: string; sessionEpoch: string; expectedDocumentRevision: number };
  private base(label: string, documentRevision: false): { operationId: string; clientId: string; sessionEpoch: string };
  private base(label: string, documentRevision = true): { operationId: string; clientId: string; sessionEpoch: string; expectedDocumentRevision?: number } {
    const document = this.requireDocument();
    return { operationId: operationId(label), clientId: this.transport.id, sessionEpoch: document.epoch, ...(documentRevision ? { expectedDocumentRevision: document.snapshot.documentRevision } : {}) };
  }

  private kernelEpoch(): string {
    const epoch = this.requireDocument().snapshot.runtime.kernelEpoch;
    if (!epoch) throw new BrowserTransportError("stale_kernel", "kernel is not ready");
    return epoch;
  }

  private findWidgetOwner(name: string): LocalCell & { id: string } | null {
    const document = this.requireDocument();
    for (const cell of document.cells) {
      if (!cell.id || !cell.server) continue;
      if (cell.server.outputs.some((record) => containsNamedWidget(record.data, name))) return cell as LocalCell & { id: string };
    }
    return null;
  }

  private requireCell(key: string): LocalCell {
    const cell = this.requireDocument().cell(key);
    if (!cell) throw new BrowserTransportError("not_found", `no such cell: ${key}`);
    return cell;
  }

  private requireDocument(): BrowserDocument {
    if (!this.documentValue) throw new BrowserTransportError("not_ready", "notebook snapshot has not arrived");
    return this.documentValue;
  }

  private notify(event?: HostEvent, localCellKeys?: readonly string[]): void {
    if (!this.documentValue) return;
    if (!event && localCellKeys?.length === 0) return;
    for (const listener of this.listeners) listener(this.documentValue, event, localCellKeys);
  }

  private captureOperation(operation: OperationRecord): void {
    this.operations.set(operation.id, operation);
    this.trySourceCommitFromOperation(operation);
    if (!operationSettled(operation)) return;
    const waiters = this.operationWaiters.get(operation.id);
    if (!waiters) return;
    this.operationWaiters.delete(operation.id);
    for (const waiter of waiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve(operation);
    }
  }
  private removeOperationWaiter(id: string, waiter: OperationWaiter): void {
    const waiters = this.operationWaiters.get(id);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.operationWaiters.delete(id);
  }

  private rejectOperationWaiters(error: BrowserTransportError): void {
    for (const waiters of this.operationWaiters.values()) {
      for (const waiter of waiters) {
        globalThis.clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.operationWaiters.clear();
  }
  private acknowledgeSourceCommit(operationId: string, outcome: SourceCommitOutcome): void {
    const document = this.documentValue;
    if (!document || !this.sourceCommitWaiters.has(operationId)) return;
    if (document.acknowledgeSourceCommit(operationId, outcome)) this.resolveSourceCommit(operationId);
  }

  private trySourceCommitFromOperation(operation: OperationRecord): void {
    const document = this.documentValue;
    const waiter = this.sourceCommitWaiters.get(operation.id);
    if (!document || !waiter) return;
    const outcome = sourceCommitOutcome(operation.result);
    if (outcome !== null) {
      if (document.acknowledgeSourceCommit(operation.id, outcome)) this.resolveSourceCommit(operation.id);
      return;
    }
    if (operationSettled(operation)) {
      this.rejectSourceCommit(operation.id, new BrowserTransportError(operation.error?.code ?? "source_commit_unconfirmed", operation.error?.message ?? "run source changes were not committed"));
    }
  }
  private awaitSourceCommit(operationId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.removeSourceCommitWaiter(operationId);
        reject(new BrowserTransportError("source_commit_timeout", "run source changes did not receive a commit acknowledgement in time"));
      }, 120_000);
      this.sourceCommitWaiters.set(operationId, { resolve, reject, timer });
    });
  }

  private removeSourceCommitWaiter(operationId: string): void {
    const waiter = this.sourceCommitWaiters.get(operationId);
    if (!waiter) return;
    globalThis.clearTimeout(waiter.timer);
    this.sourceCommitWaiters.delete(operationId);
  }

  private resolveSourceCommit(operationId: string): void {
    const waiter = this.sourceCommitWaiters.get(operationId);
    if (!waiter) return;
    this.removeSourceCommitWaiter(operationId);
    waiter.resolve();
  }

  private rejectSourceCommit(operationId: string, error: BrowserTransportError): void {
    const waiter = this.sourceCommitWaiters.get(operationId);
    if (!waiter) return;
    this.removeSourceCommitWaiter(operationId);
    waiter.reject(error);
  }

  private rejectSourceCommitWaiters(error: BrowserTransportError): void {
    for (const [operationId, waiter] of this.sourceCommitWaiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(error);
      this.sourceCommitWaiters.delete(operationId);
    }
  }

  private async withSourceLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.sourceQueue;
    let release!: () => void;
    this.sourceQueue = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try { return await operation(); }
    finally { release(); }
  }
}

function admissionResult(admission: CommandAdmission, snapshot: HostSnapshot, cursor: number | null, command: HostCommand, operation: OperationRecord | null = admission.operation): CommandResult {
  if (operation === null) throw new BrowserTransportError(admission.error?.code ?? "command_rejected", admission.error?.message ?? `${command.type} command was rejected`, true);
  return {
    epoch: admission.epoch,
    operation,
    documentRevision: operation.documentRevision,
    version: snapshot.version,
    cursor: cursor ?? snapshot.cursor,
    nextCommandSequence: admission.nextCommandSequence,
    result: operation.result,
    error: operation.error,
  };
}
function settledCommandResult(accepted: CommandResult, operation: OperationRecord): CommandResult {
  return { ...accepted, operation, documentRevision: operation.documentRevision, result: operation.result, error: operation.error };
}
function sourceCellKeys(command: SourceCommand, document: BrowserDocument): string[] {
  const changes = command.changes ?? [];
  return changes.flatMap((change) => {
    if (!((change.type === "edit" || change.type === "text-edit") && "cellId" in change.cell)) return [];
    const cell = document.cell(change.cell.cellId);
    return cell ? [cell.key] : [];
  });
}
function sourceCommitOutcome(value: unknown): SourceCommitOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const edited = "edited" in record ? record.edited : record.updated;
  if (
    !("created" in record)
    || !("deleted" in record)
    || (!("edited" in record) && !("updated" in record))
    || !Number.isSafeInteger(record.documentRevision)
    || (record.documentRevision as number) < 0
  ) return null;
  return {
    created: record.created,
    edited,
    deleted: record.deleted,
    documentRevision: record.documentRevision as number,
  };
}
function containsNamedWidget(value: unknown, name: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "widget" && record.name === name) return true;
  if (record.kind === "layout" && Array.isArray(record.children)) return record.children.some((child) => containsNamedWidget(child, name));
  if (record.kind === "lazy" && record.child !== null && record.child !== undefined) return containsNamedWidget(record.child, name);
  return false;
}

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function fileArray(value: unknown): Array<{ name: string; content_base64: string }> {
  return Array.isArray(value) ? value.filter((item): item is { name: string; content_base64: string } => typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).content_base64 === "string") : [];
}
function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function safeArtifactPath(path: string): string {
  try {
    const current = new URL(location.href);
    const target = new URL(path, current.origin);
    if (target.origin !== current.origin || target.pathname !== path || target.search !== "" || target.hash !== "") throw new Error("unsafe artifact path");
  } catch {
    throw new BrowserTransportError("output_invalid", "artifact resolution returned an unsafe URL");
  }
  return path;
}

function splitSource(source: string): string[] {
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized === "" ? [] : normalized.split("\n");
}
function normalizeInputTimestamp(timestamp: number | undefined, now: number): number {
  if (!Number.isFinite(timestamp)) return now;
  if (timestamp! > 1e12 && typeof performance.timeOrigin === "number") return timestamp! - performance.timeOrigin;
  return timestamp!;
}
function cloneChange(change: DocumentChange): DocumentChange { return JSON.parse(JSON.stringify(change)) as DocumentChange; }
function operationId(label: string): string {
  try { return `${label}-${crypto.randomUUID()}`; } catch { return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}
function sameLines(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((line, index) => line === right[index]); }
function operationSettled(operation: OperationRecord): boolean { return operation.status === "done" || operation.status === "error" || operation.status === "interrupted" || operation.status === "cancelled"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isOperation(value: unknown): value is OperationRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === "string" && typeof (value as Record<string, unknown>).status === "string";
}

function operationFromEventPayload(value: unknown): OperationRecord | null {
  if (isOperation(value)) return value;
  if (isRecord(value) && isOperation(value.operation)) return value.operation;
  return null;
}

function isBrowserDraftStore(value: { load(): Promise<unknown>; save(epoch: string, cursor: number): Promise<void>; clear(): Promise<void> }): value is BrowserDraftStore {
  const candidate = value as Partial<BrowserDraftStore>;
  return typeof candidate.loadDraft === "function" && typeof candidate.listDrafts === "function" && typeof candidate.saveDraft === "function" && typeof candidate.clearDraft === "function" && typeof candidate.saveBranch === "function" && typeof candidate.listBranches === "function" && typeof candidate.deleteBranch === "function";
}
function sameChanges(left: BrowserRecoveryDraft["changes"], right: BrowserRecoveryDraft["changes"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export type { Recovery };
