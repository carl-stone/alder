import { BrowserDocument, reconcileDraft, type BrowserRunCommand, type BrowserTransactionCommand, type LocalCell, type SourceCommitOutcome } from "./document.js";
import { BrowserTransport, BrowserTransportError, type BrowserCommand, type BrowserDraftStore, type BrowserRecoveryDraft, type BrowserTransportOptions } from "./transport.js";
import { notebookUrl } from "./url.js";
import type { WidgetOrigin } from "../output-renderer.js";
import type { PreferencesPatch, ProjectSettingsPatch } from "../settings.js";
import type {
  CellType,
  DocumentChange,
  CommandResult,
  HostCommand,
  HostEvent,
  HostQuery,
  HostQueryResult,
  HostSnapshot,
  ArtifactHandle,
  Recovery,
  RecoveryCandidate,
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
  draftId?: string;
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

interface ArtifactCacheEntry {
  url: string;
  expiresAt: number;
}

type DocumentListener = (
  document: BrowserDocument,
  event?: HostEvent,
  localCellKeys?: readonly string[],
) => void;

export interface BrowserRecoveryState {
  status: "none" | "restored" | "conflict";
  local: BrowserRecoveryDraft | null;
  candidate: RecoveryCandidate | null;
  uncertainRun: boolean;
  corruption: HostError | null;
  persistenceError: HostError | null;
  retainedDrafts?: readonly { draftId: string; updatedAt: number; preview: string }[];
  selectingRetainedDraft?: boolean;
}

type RecoveryListener = (state: BrowserRecoveryState) => void;

type SourceCommand = BrowserTransactionCommand | BrowserRunCommand;
type ServiceName = "publish" | "packages.status" | "packages.declare" | "packages.install" | "upload" | "check";

export class BrowserNotebookClient {
  readonly transport: BrowserTransport;
  private documentValue: BrowserDocument | null = null;
  private listeners = new Set<DocumentListener>();
  private runs = new Map<string, RunIntent>();
  private sourceQueue: Promise<void> = Promise.resolve();
  private sourceAcceptances = new Map<string, {
    deferred: { promise: Promise<void>; resolve: () => void };
    changes: readonly DocumentChange[];
  }>();
  private readonly frame: (callback: FrameRequestCallback) => number;
  private readonly now: () => number;
  private artifactCache = new Map<string, ArtifactCacheEntry>();
  private recoveryStateValue: BrowserRecoveryState = { status: "none", local: null, candidate: null, uncertainRun: false, corruption: null, persistenceError: null };
  private recoveryListeners = new Set<RecoveryListener>();
  private readonly activeRuns = new Map<string, { requestId: string; epoch: string }>();
  private uncertainRun: BrowserRecoveryDraft["pendingRun"] = null;
  private pendingRun: BrowserRecoveryDraft["pendingRun"] = null;
  private draftSubmission: BrowserRecoveryDraft["submission"] = null;
  private draftPersistence: Promise<void> = Promise.resolve();
  private draftPersistenceQueued = false;
  private draftPersistenceRunning = false;
  private draftPersistenceTimer: ReturnType<typeof setTimeout> | undefined;
  private draftPersistenceQueuedAt: number | undefined;
  private draftPersistenceError: Error | null = null;
  private recoveryAttempted = false;
  private browserRecoveryInspected = false;
  private hostRecoveryInspected = false;
  private startupActivated = false;
  private selectedDraftId: string;
  private selectingRetainedDraft = false;
  private retainedDraftsDismissed = false;

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
    this.selectedDraftId = options.draftId ?? this.transport.id;
  }

  get draftId(): string { return this.selectedDraftId; }

  get document(): BrowserDocument | null { return this.documentValue; }

  async connect(): Promise<BrowserDocument> {
    const recovery = await this.transport.connect();
    if (!this.documentValue && recovery.kind === "snapshot") this.receiveSnapshot(recovery.snapshot);
    if (!this.documentValue) throw new BrowserTransportError("recovery_requires_snapshot", "Notebook snapshot has not arrived.");
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
    void this.activateStartupIfSafe();
    return this.documentValue;
  }

  async discardAndClose(): Promise<void> {
    await this.withSourceLock(async () => {
      await this.flushDraftPersistence();
      const result = await this.dispatchSettled({ type: "discard-document", ...this.base("discard-document") });
      if (result.error !== null) throw new BrowserTransportError(result.error.code, result.error.message);
      if (this.draftPersistenceTimer !== undefined) clearTimeout(this.draftPersistenceTimer);
      this.draftPersistenceTimer = undefined;
      this.draftPersistenceQueued = false;
      await this.beginDraftMutation();
      await this.draftStore().clearDraft(this.draftId);
    });
    try { await this.transport.release().catch(() => undefined); }
    finally { this.finishClose(); }
  }
  async close(): Promise<void> {
    await this.flushDraftPersistence();
    this.transport.close();
    this.finishClose();
  }
  retryConnection(): void { this.transport.reconnectNow(); }

  private finishClose(): void {
    this.runs.clear();
    this.artifactCache.clear();
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
    this.queueDraftPersistence();
    if (this.draftPersistenceTimer !== undefined) {
      clearTimeout(this.draftPersistenceTimer);
      this.draftPersistenceTimer = undefined;
    }
    while (this.draftPersistenceRunning || this.draftPersistenceQueued) {
      if (!this.draftPersistenceRunning) this.startDraftPersistence();
      await this.draftPersistence;
    }
    if (this.draftPersistenceError) throw this.draftPersistenceError;
  }

  async restoreRetainedDraft(draftId: string): Promise<void> {
    const store = this.draftStore();
    if (!store.claimDraft) throw new Error("This draft cannot be claimed by the current window");
    if (this.selectingRetainedDraft) throw new Error("A draft is already being restored");
    if (!this.recoveryStateValue.retainedDrafts?.some(draft => draft.draftId === draftId)) throw new Error("The selected draft is not available");
    if (this.requireDocument().pendingSource().changes.length || this.recoveryStateValue.local || this.draftSubmission) throw new Error("Finish the current local edits before restoring another draft");
    this.selectingRetainedDraft = true;
    this.recoveryStateValue = { ...this.recoveryStateValue, selectingRetainedDraft: true };
    this.notifyRecovery();
    let claimed = false;
    try {
      await this.withSourceLock(async () => {
        if (this.requireDocument().pendingSource().changes.length || this.recoveryStateValue.local || this.draftSubmission) throw new Error("Finish the current local edits before restoring another draft");
        await this.flushDraftPersistence();
        const draft = await store.readDraft(draftId);
        if (!draft) throw new Error("The selected draft is no longer available");
        await store.claimDraft!(draftId);
        claimed = true;
        this.selectedDraftId = draftId;
        this.retainedDraftsDismissed = true;
        this.recoveryStateValue = { ...this.recoveryStateValue, retainedDrafts: [] };
        this.restoreDraft(draft);
        await this.flushDraftPersistence();
      }, true);
    } catch (error) {
      if (!claimed) {
        this.recoveryStateValue = { ...this.recoveryStateValue, retainedDrafts: await this.discoverRetainedDrafts().catch(() => this.recoveryStateValue.retainedDrafts ?? []) };
        this.notifyRecovery();
      }
      throw error;
    } finally {
      this.selectingRetainedDraft = false;
      this.recoveryStateValue = { ...this.recoveryStateValue, selectingRetainedDraft: false };
      this.notifyRecovery();
    }
  }

  dismissRetainedDrafts(): void {
    if (this.selectingRetainedDraft) throw new Error("Wait for the selected draft to open before using the saved notebook");
    this.retainedDraftsDismissed = true;
    this.recoveryStateValue = { ...this.recoveryStateValue, retainedDrafts: [] };
    this.notifyRecovery();
    void this.activateStartupIfSafe();
  }

  async refreshRetainedDrafts(): Promise<void> {
    if (!this.browserRecoveryInspected || this.retainedDraftsDismissed || this.selectingRetainedDraft || this.recoveryStateValue.local
      || this.requireDocument().pendingSource().changes.length || !this.draftStore().listDrafts) return;
    const drafts = await this.discoverRetainedDrafts();
    if (this.retainedDraftsDismissed || this.selectingRetainedDraft || this.recoveryStateValue.local
      || this.requireDocument().pendingSource().changes.length) return;
    this.recoveryStateValue = { ...this.recoveryStateValue, retainedDrafts: drafts };
    this.notifyRecovery();
  }

  async discardRecovery(): Promise<void> {
    return this.withSourceLock(() => this.discardRecoveryUnlocked());
  }

  private async discardRecoveryUnlocked(): Promise<void> {
    await this.beginDraftMutation();
    if (this.recoveryStateValue.candidate !== null || this.recoveryStateValue.corruption !== null) {
      const result = await this.dispatchSettled({ type: "discard-document", ...this.base("discard-document") });
      if (isRecord(result.result) && result.result.peerActive === true) throw new BrowserTransportError("peer_active", "Close other notebook windows before opening the saved copy.");
      this.recoveryStateValue = { ...this.recoveryStateValue, candidate: null, corruption: null };
    }
    await this.draftStore().clearDraft(this.draftId);
    this.resetAuthoritativeDocument();
    this.recoveryStateValue = { ...this.recoveryStateValue, status: "none", local: null };
    this.notifyRecovery();
    this.notify();
    this.queueDraftPersistence();
    await this.activateStartupIfSafe();
  }

  continueRecovered(): void {
    this.recoveryStateValue = {
      ...this.recoveryStateValue,
      candidate: null,
      corruption: null,
      status: this.recoveryStateValue.local ? "restored" : "none",
    };
    this.notifyRecovery();
  }

  async reloadAuthoritativeRecovery(): Promise<void> {
    return this.withSourceLock(async () => {
      await this.flushDraftPersistence();
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
      await this.discardRecoveryUnlocked();
    });
  }

  createCell(afterKey: string | null, type: CellType = "code", body: readonly string[] = []): LocalCell {
    this.assertCanMutateSource();
    const document = this.requireDocument();
    const cell = document.create(operationId("create"), afterKey, type, body);
    document.focus(cell.key);
    this.notify();
    this.queueDraftPersistence();
    return cell;
  }

  async restoreCellAt(index: number, type: CellType, body: readonly string[]): Promise<CommandResult | null> {
    return this.withSourceLock(() => {
      const document = this.requireDocument();
      const cell = document.createAt(operationId("create"), index, type, body);
      document.focus(cell.key);
      this.notify();
      this.queueDraftPersistence();
      return this.commitEditsUnlocked();
    });
  }

  editCell(key: string, source: string | readonly string[], type?: CellType): LocalCell {
    this.assertCanMutateSource();
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
    const pending = document.pendingSource().changes;
    const submitted = [...this.sourceAcceptances.values()];
    if (pending.length > 0 && submitted.length > 0 && pending.every((change) =>
      submitted.some((acceptance) => acceptance.changes.some((candidate) => sameSourceChange(candidate, change))))) {
      await Promise.all(submitted.map((acceptance) => acceptance.deferred.promise));
    }
    const command = document.buildTransactionCommand(operationId("transaction"), this.transport.id);
    if (command === null) return null;
    return this.dispatchSource(command);
  }

  async runCell(key: string, input?: Event | { timeStamp: number }): Promise<CommandResult> {
    const { completed } = await this.startRunCell(key, input);
    return completed;
  }

  async startRunCell(key: string, input?: Event | { timeStamp: number }): Promise<{ completed: Promise<CommandResult> }> {
    const id = operationId("run");
    this.runs.set(id, {
      operationId: id,
      targetKey: key,
      inputTimestamp: normalizeInputTimestamp(input?.timeStamp, this.now()),
      handlerTimestamp: this.now(),
    });
    try {
      const { completed } = await this.withSourceLock(() => this.startRun(
        this.requireDocument().buildRunCommand({ requestId: id, clientId: this.transport.id, scope: "cell", targetKey: key }),
      ));
      return { completed: completed.catch((error) => { this.runs.delete(id); throw error; }) };
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
  }

  async runAll(scope: "all" | "stale" = "all", input?: Event | { timeStamp: number }): Promise<CommandResult> {
    const { completed } = await this.startRunAll(scope, input);
    return completed;
  }

  async startRunAll(scope: "all" | "stale" = "all", input?: Event | { timeStamp: number }): Promise<{ completed: Promise<CommandResult> }> {
    const id = operationId("run");
    void input;
    return this.withSourceLock(() => this.startRun(
      this.requireDocument().buildRunCommand({ requestId: id, clientId: this.transport.id, scope }),
    ));
  }

  async interrupt(runId?: string): Promise<CommandResult> {
    return this.dispatch({ type: "interrupt", ...this.base("interrupt", false), ...(runId ? { runId } : {}) });
  }

  async cancelOperation(targetOperationId: string): Promise<CommandResult> {
    return this.dispatch({ type: "cancel-operation", ...this.base("cancel-operation", false), operationId: targetOperationId });
  }

  async restart(replay = true): Promise<CommandResult> {
    const command = { type: "restart", replay, ...this.base("restart"), ...(replay ? { expectedDocumentRevision: this.requireDocument().snapshot.documentRevision } : {}) } as Extract<HostCommand, { type: "restart" }>;
    return replay ? this.dispatchSettled(command) : this.dispatch(command);
  }

  async save(): Promise<CommandResult> {
    await this.commitEdits();
    this.assertCanMutateSource();
    return this.dispatchSettled({ type: "save", ...this.base("save") });
  }

  async saveAs(destination: string | import("../protocol.js").SaveDestination): Promise<CommandResult> {
    await this.commitEdits();
    this.assertCanMutateSource();
    const target = typeof destination === "string" ? { path: destination, expectedDestination: "absent" as const } : destination;
    const result = await this.dispatchSettled({ type: "save-as", ...target, ...this.base("save-as") });
    await this.refreshRecoveryState();
    return result;
  }

  async selectR(rscript: string): Promise<CommandResult> {
    await this.commitEdits();
    this.assertCanMutateSource();
    return this.dispatchSettled({
      type: "select-r",
      ...this.base("select-r"),
      rscript,
      expectedDocumentRevision: this.requireDocument().snapshot.documentRevision,
    });
  }
  async shutdown(): Promise<CommandResult> {
    const document = this.requireDocument();
    const expectedClientIds = document.snapshot.activeClientIds ?? [this.transport.id];
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
      return this.dispatchSource(command);
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

  async keepLocalVersion(key: string): Promise<CommandResult | null> {
    return this.withSourceLock(() => {
      this.requireDocument().keepLocalVersion(key);
      this.notify(undefined, [key]);
      this.queueDraftPersistence();
      return this.commitEditsUnlocked();
    });
  }

  async restoreConflictAsNewCell(key: string): Promise<CommandResult | null> {
    return this.withSourceLock(() => {
      const document = this.requireDocument();
      const cell = this.requireCell(key);
      const body = [...cell.desiredBody];
      const type = cell.desiredType;
      document.useServerVersion(key);
      document.create(operationId("create"), key, type, body);
      this.notify();
      this.queueDraftPersistence();
      return this.commitEditsUnlocked();
    });
  }

  discardLocalCell(key: string): void {
    this.assertCanMutateSource();
    this.requireDocument().discardLocal(key);
    this.notify();
    this.queueDraftPersistence();
  }

  useServerVersion(key: string): void {
    this.assertCanMutateSource();
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
      return this.dispatchSource(command);
    });
  }

  async setDisabled(key: string, disabled: boolean): Promise<CommandResult> {
    return this.withSourceLock(() => {
      const cell = this.requireCell(key);
      if (!cell.id) throw new BrowserTransportError("invalid_request", "cell must be acknowledged before changing disabled state");
      const command: BrowserTransactionCommand = {
        type: "transaction", ...this.base("options"), changes: [{ type: "options", cell: { cellId: cell.id }, expectedRevision: cell.serverRevision, patch: { disabled } }],
      };
      return this.dispatchSource(command);
    });
  }

  async setWidget(name: string, path: readonly string[], update: Record<string, unknown>, source: "editor" | "app" = "editor", origin?: WidgetOrigin): Promise<CommandResult> {
    const owner = this.findWidgetOwner(name);
    if (!owner) throw new BrowserTransportError("not_found", `widget owner is unavailable: ${name}`);
    if (origin && origin.owner !== owner.id) throw new BrowserTransportError("widget_not_current", `widget output is no longer current: ${name}`);
    const kernelEpoch = origin?.kernelEpoch ?? this.kernelEpoch();
    return this.dispatchSettled({ type: "widget", ...this.base("widget", false), name, path: [...path], update, source, kernelEpoch, expectedRevision: origin?.revision ?? owner.serverRevision, ...(origin ? { expectedOutputId: origin.outputId, expectedOutputGeneration: origin.outputGeneration } : {}) });
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

  async setRuntime(update: { executionMode?: "automatic" | "lazy"; runOnStartup?: boolean; cacheEnabled?: boolean }, expectedDocumentRevision = this.requireDocument().snapshot.documentRevision): Promise<CommandResult> {
    const change: { on_cell_change?: "automatic" | "lazy"; on_startup?: boolean; cache_enabled?: boolean } = {};
    if (update.executionMode !== undefined) change.on_cell_change = update.executionMode;
    if (update.runOnStartup !== undefined) change.on_startup = update.runOnStartup;
    if (update.cacheEnabled !== undefined) change.cache_enabled = update.cacheEnabled;
    if (Object.keys(change).length === 0) throw new BrowserTransportError("invalid_request", "runtime update is empty");
    return this.dispatch({ type: "set-runtime", ...this.base("runtime"), expectedDocumentRevision, ...change });
  }

  async setPreferences(patch: PreferencesPatch, expectedPreferencesVersion: string | null): Promise<CommandResult> {
    return this.dispatch({ type: "set-preferences", ...this.base("preferences", false), patch, expectedPreferencesVersion });
  }

  async setConfig(patch: ProjectSettingsPatch, expectedSidecarVersion = this.requireDocument().snapshot.sidecars.config.version, expectedDocumentRevision = this.requireDocument().snapshot.documentRevision): Promise<CommandResult> {
    return this.dispatch({ type: "set-config", ...this.base("config"), patch, expectedSidecarVersion, expectedDocumentRevision });
  }

  async setLayout(layout: unknown): Promise<CommandResult> {
    return this.dispatch({ type: "set-layout", ...this.base("layout"), layout: layout as Extract<HostCommand, { type: "set-layout" }>["layout"], expectedSidecarVersion: this.requireDocument().snapshot.sidecars.layout.version });
  }

  async formatCells(keys?: readonly string[], onAccepted?: (operationId: string) => void): Promise<CommandResult> {
    await this.commitEdits();
    this.assertCanMutateSource();
    const cells = keys?.map((key) => this.requireCell(key)) ?? [...this.requireDocument().cells];
    const acknowledged = cells.filter((cell): cell is LocalCell & { id: string } => cell.id !== null);
    return this.dispatchSettled({ type: "format", ...this.base("format"), ...(keys ? { cellIds: acknowledged.map((cell) => cell.id) } : {}), expectedRevisions: Object.fromEntries(acknowledged.map((cell) => [cell.id, cell.serverRevision])) }, onAccepted);
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
    if (this.startupActivated || this.selectingRetainedDraft || !this.browserRecoveryInspected || !this.hostRecoveryInspected) return;
    const state = this.recoveryStateValue;
    if (this.pendingRun || state.local || state.candidate || state.corruption || state.retainedDrafts?.length) return;
    const snapshot = this.requireDocument().snapshot;
    if (snapshot.runtime.startupActivated) { this.startupActivated = true; return; }
    if (!snapshot.runtime.documentReady || snapshot.runtime.rEnvironment === null) return;
    this.startupActivated = true;
    try { await this.dispatch({ type: "run", ...this.base("startup"), scope: "all", startup: true }); }
    catch (error) {
      // An uncertain startup run must never be automatically repeated.
      if (error instanceof BrowserTransportError && error.definitive && error.code !== "startup_already_activated") this.startupActivated = false;
    }
  }

  private draftStore(): BrowserDraftStore { return this.transport.recoveryStore; }

  private queueDraftPersistence(): void {
    const store = this.draftStore();
    if (!store) return;
    this.draftPersistenceQueued = true;
    if (this.draftPersistenceRunning) return;
    const now = Date.now();
    this.draftPersistenceQueuedAt ??= now;
    if (this.draftPersistenceTimer !== undefined) clearTimeout(this.draftPersistenceTimer);
    const delay = Math.min(150, Math.max(0, this.draftPersistenceQueuedAt + 750 - now));
    this.draftPersistenceTimer = setTimeout(() => {
      this.draftPersistenceTimer = undefined;
      this.startDraftPersistence();
    }, delay);
  }

  private startDraftPersistence(): void {
    const store = this.draftStore();
    if (!store || this.draftPersistenceRunning || !this.draftPersistenceQueued) return;
    if (this.draftPersistenceTimer !== undefined) {
      clearTimeout(this.draftPersistenceTimer);
      this.draftPersistenceTimer = undefined;
    }
    this.draftPersistenceQueuedAt = undefined;
    this.draftPersistenceRunning = true;
    this.draftPersistence = (async () => {
      this.draftPersistenceQueued = false;
      const draft = this.documentValue?.recoveryDraft(this.draftId, this.draftSubmission, this.pendingRun) ?? null;
      if (draft) await store.saveDraft(draft);
      else await store.clearDraft(this.draftId);
      this.draftPersistenceError = null;
      if (this.recoveryStateValue.persistenceError !== null) {
        this.recoveryStateValue = { ...this.recoveryStateValue, persistenceError: null };
        this.notifyRecovery();
      }
    })().catch((error) => {
      this.draftPersistenceError = error instanceof Error ? error : new Error(String(error));
      this.recoveryStateValue = { ...this.recoveryStateValue, persistenceError: { code: "draft_persistence_failed", message: this.draftPersistenceError.message } };
      this.notifyRecovery();
    }).finally(() => {
      this.draftPersistenceRunning = false;
      if (this.draftPersistenceQueued) this.queueDraftPersistence();
    });
  }

  private async beginDraftMutation(): Promise<void> {
    await this.draftPersistence.catch(() => undefined);
  }

  private async restoreBrowserRecovery(): Promise<void> {
    const selected = await this.draftStore().readDraft(this.draftId);
    if (selected) {
      this.restoreDraft(selected);
      await this.flushDraftPersistence();
    } else if (this.draftStore().listDrafts) {
      this.recoveryStateValue = { ...this.recoveryStateValue, retainedDrafts: await this.discoverRetainedDrafts() };
    }
    this.notifyRecovery();
  }

  private async discoverRetainedDrafts(): Promise<NonNullable<BrowserRecoveryState["retainedDrafts"]>> {
    const drafts = await this.draftStore().listDrafts?.() ?? [];
    return drafts.filter(draft => draft.draftId !== this.draftId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(draft => ({ draftId: draft.draftId, updatedAt: draft.updatedAt,
        preview: draft.changes.find(change => "body" in change)?.body.join(" ").trim().slice(0, 80) || "Unsaved edits" }));
  }

  private restoreDraft(draft: BrowserRecoveryDraft): void {
    const document = this.requireDocument();
    const recordedRun = draft.pendingRun === null ? undefined
      : document.snapshot.operations.find((operation) => operation.id === draft.pendingRun!.requestId);
    const runAlreadySettled = recordedRun !== undefined
      && (recordedRun.status === "done" || recordedRun.status === "error"
        || recordedRun.status === "interrupted" || recordedRun.status === "cancelled");
    const pendingRun = runAlreadySettled ? null : draft.pendingRun;
    if (pendingRun && !this.activeRuns.has(pendingRun.requestId)) this.uncertainRun ??= pendingRun;
    this.pendingRun ??= pendingRun;
    const reconciled = reconcileDraft(draft, document.snapshot);
    if (reconciled.draft.changes.length) document.restoreDraft(reconciled.draft, reconciled.conflict);
    if (!reconciled.conflict) document.rebaseDraftToSnapshot();
    this.draftSubmission = null;
    const local = document.recoveryDraft(this.draftId);
    this.recoveryStateValue = { ...this.recoveryStateValue, local, uncertainRun: this.uncertainRun !== null, status: local ? reconciled.conflict ? "conflict" : "restored" : "none" };
    this.queueDraftPersistence();
    this.notifyRecovery();
    this.notify();
  }

  private resetAuthoritativeDocument(): void {
    if (!this.documentValue) return;
    this.documentValue = new BrowserDocument(this.documentValue.snapshot);
    this.draftSubmission = null;
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
      this.recoveryStateValue = { ...this.recoveryStateValue, candidate: state.candidate, corruption: state.corruption };
      this.notifyRecovery();
      return true;
    } catch {
      return false;
    }
  }

  private notifyRecovery(): void {
    for (const listener of this.recoveryListeners) listener(this.recoveryStateValue);
  }

  private startRun(command: BrowserRunCommand): { completed: Promise<CommandResult> } {
    // The backend checks this source revision when queued execution begins.
    // Waiting here would let an earlier long run hold up subsequent edits and Save.
    return { completed: command.changes?.length ? this.dispatchSource(command) : this.dispatch(command) };
  }

  private async dispatchSource(command: SourceCommand): Promise<CommandResult> {
    this.assertCanMutateSource();
    const document = this.requireDocument();
    const changes = command.changes ?? [];
    const acceptance = changes.length > 0 ? deferredPromise() : null;
    if (acceptance) this.sourceAcceptances.set(command.requestId, {
      deferred: acceptance,
      changes: changes.map((change) => structuredClone(change)),
    });
    document.stageRecoveryIntent(changes);
    this.draftSubmission = { requestId: command.requestId, kind: command.type, changes: changes.map(change => structuredClone(change)) };
    document.noteSubmitted(command.requestId, command);
    this.queueDraftPersistence();
    let dispatched = false;
    try {
      await this.flushDraftPersistence();
      dispatched = true;
      const result = await this.dispatch(command);
      document.acknowledge(result);
      if (this.draftSubmission?.requestId === command.requestId) this.draftSubmission = null;
      this.queueDraftPersistence();
      this.recoveryStateValue = { ...this.recoveryStateValue, local: document.recoveryDraft(this.draftId), status: "none" };
      this.notifyRecovery();
      this.notify(undefined, sourceCellKeys(command, document));
      return result;
    } catch (error) {
      if (!dispatched || error instanceof BrowserTransportError && error.definitive) {
        const reason = !dispatched ? "draft_persistence_failed"
          : error instanceof BrowserTransportError ? error.code : "source_rejected";
        document.reject(command.requestId, reason);
        if (this.draftSubmission?.requestId === command.requestId) this.draftSubmission = null;
      }
      this.queueDraftPersistence();
      const local = document.recoveryDraft(this.draftId, this.draftSubmission);
      this.recoveryStateValue = { ...this.recoveryStateValue, status: local ? "conflict" : "none", local };
      this.notifyRecovery(); this.notify();
      throw error;
    } finally {
      this.resolveSourceAcceptance(command.requestId);
    }
  }

  private async dispatch(command: BrowserCommand): Promise<CommandResult> {
    const executes = command.type === "run" || command.type === "restart" && command.replay;
    if (executes) {
      this.uncertainRun = null;
      this.activeRuns.set(command.requestId, { requestId: command.requestId, epoch: command.sessionEpoch });
      this.updatePendingRun();
    }
    try {
      const result = await this.transport.dispatch(command);
      this.activeRuns.delete(command.requestId);
      if (this.uncertainRun?.requestId === command.requestId) this.uncertainRun = null;
      if (executes) this.updatePendingRun();
      this.options.onCommand?.(command, result);
      if (result.error) throw new BrowserTransportError(result.error.code, result.error.message, true);
      return result;
    } catch (error) {
      if (executes) {
        this.activeRuns.delete(command.requestId);
        if (!(error instanceof BrowserTransportError) || !error.definitive) this.uncertainRun = { requestId: command.requestId, epoch: command.sessionEpoch };
        this.updatePendingRun();
      }
      throw error;
    }
  }

  private updatePendingRun(): void {
    this.pendingRun = this.uncertainRun ?? this.activeRuns.values().next().value ?? null;
    this.recoveryStateValue = { ...this.recoveryStateValue, uncertainRun: this.uncertainRun !== null };
    this.queueDraftPersistence(); this.notifyRecovery();
  }

  private dispatchSettled(command: BrowserCommand, onStarted?: (requestId: string) => void): Promise<CommandResult> {
    onStarted?.(command.requestId);
    return this.dispatch(command);
  }

  private receiveSnapshot(snapshot: HostSnapshot): void {
    const draft = this.documentValue?.recoveryDraft(this.draftId, this.draftSubmission, this.pendingRun);
    if (this.documentValue?.epoch !== snapshot.epoch) { this.runs.clear(); this.artifactCache.clear(); }
    this.documentValue = new BrowserDocument(snapshot);
    if (draft) this.restoreDraft(draft);
    else this.notify();
  }

  private receiveEvent(event: HostEvent): void {
    const document = this.documentValue;
    if (!document) throw new BrowserTransportError("invalid_server_message", "Received an update before the notebook.");
    document.applyEvent(event);
    // Live source acknowledgment preserves typing made after the request was sent.
    if (event.type === "transaction" && event.operationId) {
      const outcome = sourceCommitOutcome(event.payload);
      if (outcome && document.acknowledgeSourceCommit(event.operationId, outcome)) {
        this.resolveSourceAcceptance(event.operationId);
        if (this.draftSubmission?.requestId === event.operationId) this.draftSubmission = null;
        this.queueDraftPersistence();
      }
    }
    this.notify(event);
    if (event.type === "runtime") void this.activateStartupIfSafe();
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

  private base(label: string): { requestId: string; clientId: string; sessionEpoch: string; expectedDocumentRevision: number };
  private base(label: string, documentRevision: false): { requestId: string; clientId: string; sessionEpoch: string };
  private base(label: string, documentRevision = true): { requestId: string; clientId: string; sessionEpoch: string; expectedDocumentRevision?: number } {
    const document = this.requireDocument();
    return { requestId: operationId(label), clientId: this.transport.id, sessionEpoch: document.epoch, ...(documentRevision ? { expectedDocumentRevision: document.snapshot.documentRevision } : {}) };
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

  private assertCanMutateSource(): void {
    if (this.selectingRetainedDraft) throw new Error("Wait for the selected draft to open before editing");
  }

  private async withSourceLock<T>(operation: () => Promise<T> | T, selectingDraft = false): Promise<T> {
    if (!selectingDraft) this.assertCanMutateSource();
    const predecessor = this.sourceQueue;
    let release!: () => void;
    this.sourceQueue = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      if (!selectingDraft) this.assertCanMutateSource();
      return await operation();
    }
    finally { release(); }
  }

  private resolveSourceAcceptance(operationId: string): void {
    const acceptance = this.sourceAcceptances.get(operationId);
    if (!acceptance) return;
    this.sourceAcceptances.delete(operationId);
    acceptance.deferred.resolve();
  }
}

function sameSourceChange(left: DocumentChange, right: DocumentChange): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deferredPromise(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
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
function operationId(label: string): string {
  try { return `${label}-${crypto.randomUUID()}`; } catch { return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}
function sameLines(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((line, index) => line === right[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export type { Recovery };
