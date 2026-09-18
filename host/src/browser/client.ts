import { BrowserDocument, reconcileDraft, type BrowserRunCommand, type BrowserTransactionCommand, type LocalCell, type SourceCommitOutcome } from "./document.js";
import { BrowserTransport, BrowserTransportError, type BrowserCommand, type BrowserDraftStore, type BrowserRecoveryDraft, type BrowserTransportOptions } from "./transport.js";
import { notebookUrl } from "./url.js";
import type {
  CellType,
  DocumentChange,
  JsonValue,
  CommandResult,
  HostCommand,
  HostEvent,
  HostQuery,
  HostQueryResult,
  HostSnapshot,
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
  draftId?: string;
  restoreSingleDraft?: boolean;
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
  drafts: BrowserRecoveryDraft[];
  branches: RecoveryBranch[];
  pending: boolean;
  uncertainRun: boolean;
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
  private sourceQueue: Promise<void> = Promise.resolve();
  private readonly frame: (callback: FrameRequestCallback) => number;
  private readonly now: () => number;
  private artifactCache = new Map<string, ArtifactCacheEntry>();
  private recoveryStateValue: BrowserRecoveryState = { status: "none", local: null, branches: [], drafts: [], pending: false, uncertainRun: false, corruption: null, persistenceError: null };
  private recoveryListeners = new Set<RecoveryListener>();
  private readonly activeRuns = new Map<string, { requestId: string; epoch: string }>();
  private uncertainRun: BrowserRecoveryDraft["pendingRun"] = null;
  private pendingRun: BrowserRecoveryDraft["pendingRun"] = null;
  private draftSubmission: BrowserRecoveryDraft["submission"] = null;
  private draftPersistence: Promise<void> = Promise.resolve();
  private draftGeneration = 0;
  private draftPersistenceError: Error | null = null;
  private recoveryAttempted = false;
  private browserRecoveryInspected = false;
  private hostRecoveryInspected = false;
  private startupActivated = false;

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
  }

  get draftId(): string { return this.options.draftId ?? this.transport.id; }

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
    await this.discardRecovery();
    await this.transport.release("discard");
    this.finishClose();
  }
  close(): void {
    this.transport.close();
    this.finishClose();
  }

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
    await this.draftPersistence;
    this.queueDraftPersistence();
    await this.draftPersistence;
    if (this.draftPersistenceError) throw this.draftPersistenceError;
  }

  async restoreSavedDraft(draftId: string): Promise<void> {
    const store = this.draftStore();
    const draft = this.recoveryStateValue.drafts.find(candidate => candidate.draftId === draftId);
    if (!draft) return;
    await this.beginDraftMutation();
    const current = this.documentValue?.recoveryDraft(this.draftId, this.draftSubmission, this.pendingRun);
    // Choosing another draft must not erase the text currently on screen.
    if (current) await store.saveDraft({ ...current, draftId: operationId("saved") });
    this.resetAuthoritativeDocument();
    this.restoreDraft(draft);
    await this.flushDraftPersistence();
    if (draftId !== this.draftId) await store.clearDraft(draftId);
    await this.refreshSavedDrafts();
  }

  async discardSavedDraft(draftId: string): Promise<void> {
    await this.draftStore().clearDraft(draftId);
    await this.refreshSavedDrafts();
  }

  async discardRecovery(): Promise<void> {
    await this.beginDraftMutation();
    await this.draftStore().clearDraft(this.draftId);
    this.draftGeneration += 1;
    this.resetAuthoritativeDocument();
    this.recoveryStateValue = { ...this.recoveryStateValue, status: "none", local: null };
    this.notifyRecovery();
    this.notify();
    this.queueDraftPersistence();
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
      const { completed } = await this.withSourceLock(() => this.startRun(
        this.requireDocument().buildRunCommand({ requestId: id, clientId: this.transport.id, scope: "cell", targetKey: key }),
      ));
      return await completed;
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
  }

  async runAll(scope: "all" | "stale" = "all", input?: Event | { timeStamp: number }): Promise<CommandResult> {
    const id = operationId("run");
    void input;
    const { completed } = await this.withSourceLock(() => this.startRun(
      this.requireDocument().buildRunCommand({ requestId: id, clientId: this.transport.id, scope }),
    ));
    return completed;
  }

  async interrupt(runId?: string): Promise<CommandResult> {
    return this.dispatch({ type: "interrupt", ...this.base("interrupt", false), ...(runId ? { runId } : {}) });
  }

  async restart(replay = true): Promise<CommandResult> {
    const command = { type: "restart", replay, ...this.base("restart"), ...(replay ? { expectedDocumentRevision: this.requireDocument().snapshot.documentRevision } : {}) } as Extract<HostCommand, { type: "restart" }>;
    return replay ? this.dispatchSettled(command) : this.dispatch(command);
  }

  async save(): Promise<CommandResult> {
    await this.commitEdits();
    return this.dispatchSettled({ type: "save", ...this.base("save") });
  }

  async saveAs(destination: string | import("../protocol.js").SaveDestination): Promise<CommandResult> {
    await this.commitEdits();
    const target = typeof destination === "string" ? { path: destination, expectedDestination: "absent" as const } : destination;
    const result = await this.dispatchSettled({ type: "save-as", ...target, ...this.base("save-as") });
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
    if (this.startupActivated || !this.browserRecoveryInspected || !this.hostRecoveryInspected) return;
    const state = this.recoveryStateValue;
    if (this.pendingRun || state.local || state.drafts.length || state.branches.some(branch => branch.state !== "clean") || state.pending || state.corruption) return;
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
    const generation = this.draftGeneration;
    this.draftPersistence = this.draftPersistence.catch(() => undefined).then(async () => {
      if (generation !== this.draftGeneration) return;
      const draft = this.documentValue?.recoveryDraft(this.draftId, this.draftSubmission, this.pendingRun) ?? null;
      if (draft) await store.saveDraft(draft);
      else await store.clearDraft(this.draftId);
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
    const drafts = await this.draftStore().listDrafts();
    const own = drafts.find(draft => draft.draftId === this.draftId);
    const selected = own ?? (this.options.restoreSingleDraft && drafts.length === 1 ? drafts[0] : undefined);
    this.recoveryStateValue = { ...this.recoveryStateValue, drafts: drafts.filter(draft => draft !== selected) };
    if (selected) {
      this.restoreDraft(selected);
      await this.flushDraftPersistence();
      if (selected.draftId !== this.draftId) await this.draftStore().clearDraft(selected.draftId);
    }
    this.notifyRecovery();
  }

  private restoreDraft(draft: BrowserRecoveryDraft): void {
    const document = this.requireDocument();
    this.uncertainRun ??= draft.pendingRun;
    this.pendingRun ??= draft.pendingRun;
    const reconciled = reconcileDraft(draft, document.snapshot);
    if (reconciled.draft.changes.length) document.restoreDraft(reconciled.draft, reconciled.conflict);
    if (!reconciled.conflict) document.rebaseDraftToSnapshot();
    this.draftSubmission = null;
    const local = document.recoveryDraft(this.draftId);
    this.recoveryStateValue = { ...this.recoveryStateValue, local, uncertainRun: this.pendingRun !== null, status: local ? reconciled.conflict ? "conflict" : "restored" : "none" };
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
      this.recoveryStateValue = { ...this.recoveryStateValue, branches: state.branches, pending: state.pending, corruption: state.corruption };
      this.notifyRecovery();
      return true;
    } catch {
      return false;
    }
  }

  private async refreshSavedDrafts(): Promise<void> {
    this.recoveryStateValue = { ...this.recoveryStateValue, drafts: (await this.draftStore().listDrafts()).filter(draft => draft.draftId !== this.draftId) };
    this.notifyRecovery();
  }

  private notifyRecovery(): void {
    for (const listener of this.recoveryListeners) listener(this.recoveryStateValue);
  }

  private startRun(command: BrowserRunCommand): { completed: Promise<CommandResult> } {
    // The backend checks this source revision when queued execution begins.
    // Waiting here would let an earlier long run hold up subsequent edits and Save.
    return { completed: command.changes?.length ? this.dispatchSource(command) : this.dispatch(command) };
  }

  private async dispatchSource(command: SourceCommand, _waitForSettlement = true): Promise<CommandResult> {
    const document = this.requireDocument();
    const changes = command.changes ?? [];
    document.stageRecoveryIntent(changes);
    this.draftSubmission = { requestId: command.requestId, kind: command.type, changes: changes.map(change => structuredClone(change)) };
    document.noteSubmitted(command.requestId, command);
    this.queueDraftPersistence();
    try {
      const result = await this.dispatch(command);
      document.acknowledge(result);
      if (this.draftSubmission?.requestId === command.requestId) this.draftSubmission = null;
      this.queueDraftPersistence();
      this.recoveryStateValue = { ...this.recoveryStateValue, local: document.recoveryDraft(this.draftId), status: "none" };
      this.notifyRecovery();
      this.notify(undefined, sourceCellKeys(command, document));
      return result;
    } catch (error) {
      if (error instanceof BrowserTransportError && error.definitive) {
        document.reject(command.requestId, error.code);
        if (this.draftSubmission?.requestId === command.requestId) this.draftSubmission = null;
      }
      this.queueDraftPersistence();
      const local = document.recoveryDraft(this.draftId, this.draftSubmission);
      this.recoveryStateValue = { ...this.recoveryStateValue, status: local ? "conflict" : "none", local };
      this.notifyRecovery(); this.notify();
      throw error;
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

  private async withSourceLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const predecessor = this.sourceQueue;
    let release!: () => void;
    this.sourceQueue = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try { return await operation(); }
    finally { release(); }
  }
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
  return value as Record<string, JsonValue>;
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
