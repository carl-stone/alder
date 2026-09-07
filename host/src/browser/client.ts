import { BrowserDocument, type LocalCell } from "./document.js";
import { BrowserTransport, BrowserTransportError, type BrowserTransportOptions } from "./transport.js";
import type { CellType, CommandResult, HostCommand, HostEvent, HostSnapshot, OperationRecord, Recovery } from "../protocol.js";

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

type DocumentListener = (
  document: BrowserDocument,
  event?: HostEvent,
  localCellKeys?: readonly string[],
) => void;

export class BrowserNotebookClient {
  readonly transport: BrowserTransport;
  private documentValue: BrowserDocument | null = null;
  private listeners = new Set<DocumentListener>();
  private runs = new Map<string, RunIntent>();
  private operations = new Map<string, OperationRecord>();
  private operationWaiters = new Map<string, Set<OperationWaiter>>();
  private sourceQueue: Promise<void> = Promise.resolve();
  private readonly frame: (callback: FrameRequestCallback) => number;
  private readonly now: () => number;

  constructor(private readonly options: NotebookClientOptions = {}) {
    this.frame = options.requestAnimationFrame ?? ((callback) => requestAnimationFrame(callback));
    this.now = options.now ?? (() => performance.now());
    this.transport = new BrowserTransport({
      ...options,
      onSnapshot: (snapshot) => this.receiveSnapshot(snapshot),
      onEvent: (event) => this.receiveEvent(event),
    });
  }

  get document(): BrowserDocument | null { return this.documentValue; }

  async connect(): Promise<BrowserDocument> {
    const recovery = await this.transport.connect();
    if (!this.documentValue && recovery.kind === "snapshot") this.receiveSnapshot(recovery.snapshot);
    if (!this.documentValue) {
      throw new BrowserTransportError("recovery_requires_snapshot", "browser has no base snapshot for replay recovery");
    }
    return this.documentValue;
  }

  close(): void {
    this.transport.close();
    this.rejectOperationWaiters(new BrowserTransportError("transport_closed", "browser transport is closed"));
    this.operations.clear();
    this.runs.clear();
  }

  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    if (this.documentValue) listener(this.documentValue);
    return () => this.listeners.delete(listener);
  }

  createCell(afterKey: string | null, type: CellType = "code", body: readonly string[] = []): LocalCell {
    const document = this.requireDocument();
    const cell = document.create(operationId("create"), afterKey, type, body);
    document.focus(cell.key);
    this.notify();
    return cell;
  }

  editCell(key: string, source: string | readonly string[], type?: CellType): LocalCell {
    const lines = typeof source === "string" ? splitSource(source) : [...source];
    const cell = this.requireDocument().edit(key, lines, type);
    this.notify(undefined, [key]);
    return cell;
  }

  async commitEdits(): Promise<CommandResult | null> {
    return this.withSourceLock(() => this.commitEditsUnlocked());
  }

  private async commitEditsUnlocked(): Promise<CommandResult | null> {
    const document = this.requireDocument();
    if (document.hasSourceConflicts) {
      throw new BrowserTransportError("source_conflict", "resolve deleted or conflicting local source before continuing");
    }
    const id = operationId("edit");
    const pending = document.pendingSource();
    if (!pending.edits.length && !pending.creations.length) return null;
    let last: CommandResult | null = null;
    if (pending.edits.length) {
      last = await this.dispatchSource({
        type: "edit", operationId: id, clientId: this.transport.id,
        sessionEpoch: document.epoch, edits: pending.edits,
      });
    }
    if (pending.creations.length) {
      last = await this.dispatchSource({
        type: "create", operationId: operationId("create"),
        clientId: this.transport.id, sessionEpoch: document.epoch,
        creations: pending.creations,
      });
    }
    return last;
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
        const command = this.requireDocument().buildRunCommand({
          operationId: id,
          clientId: this.transport.id,
          scope: "cell",
          targetKey: key,
        });
        return this.dispatchSource(command);
      });
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
  }

  async runAll(scope: "all" | "stale" = "all", input?: Event | { timeStamp: number }): Promise<CommandResult> {
    const id = operationId("run");
    // All-run latency is still correlated by operation; per-cell presentation
    // observers are created only for explicit targeted runs.
    void input;
    return this.withSourceLock(() => {
      const command = this.requireDocument().buildRunCommand({ operationId: id, clientId: this.transport.id, scope });
      return this.dispatchSource(command);
    });
  }

  async interrupt(): Promise<CommandResult> {
    return this.dispatch({ type: "interrupt", ...this.base("interrupt") });
  }

  async restart(replay = true): Promise<CommandResult> {
    const command = { type: "restart", replay, ...this.base("restart") } as const;
    return replay ? this.dispatchSettled(command) : this.dispatch(command);
  }

  async save(): Promise<CommandResult> {
    await this.commitEdits();
    return this.dispatch({ type: "save", ...this.base("save") });
  }

  async deleteCell(key: string): Promise<CommandResult | null> {
    const cell = this.requireCell(key);
    if (!cell.id || cell.tombstone) {
      this.requireDocument().discardLocal(key);
      this.notify();
      return null;
    }
    const result = await this.dispatch({
      type: "delete", ...this.base("delete"), cellId: cell.id,
      expectedRevision: cell.serverRevision,
    });
    return result;
  }

  async restoreDeletedCell(key: string): Promise<CommandResult | null> {
    this.requireDocument().restoreDeleted(key, operationId("create"));
    this.notify(undefined, [key]);
    return this.commitEdits();
  }

  discardLocalCell(key: string): void {
    this.requireDocument().discardLocal(key);
    this.notify();
  }

  useServerVersion(key: string): void {
    this.requireDocument().useServerVersion(key);
    this.notify(undefined, [key]);
  }

  async moveCell(key: string, afterKey: string | null): Promise<CommandResult> {
    const cell = this.requireCell(key);
    const after = afterKey === null ? null : this.requireCell(afterKey).id;
    if (!cell.id || (afterKey !== null && !after)) throw new BrowserTransportError("invalid_request", "cells must be acknowledged before moving");
    return this.dispatch({ type: "move", ...this.base("move"), cellId: cell.id, after });
  }

  async setDisabled(key: string, disabled: boolean): Promise<CommandResult> {
    const cell = this.requireCell(key);
    if (!cell.id) throw new BrowserTransportError("invalid_request", "cell must be acknowledged before changing disabled state");
    return this.dispatch({ type: "disable", ...this.base("disable"), cellId: cell.id,
      expectedRevision: cell.serverRevision, disabled });
  }

  async setWidget(name: string, path: readonly string[], update: Record<string, unknown>, source: "editor" | "app" = "editor"): Promise<CommandResult> {
    return this.dispatchSettled({ type: "widget", ...this.base("widget"), name, path: [...path], update, source });
  }

  async requestLazy(key: string): Promise<CommandResult> {
    return this.dispatchSettled({ type: "lazy-output", ...this.base("lazy"), key });
  }

  async requestTable(options: { handle: string; offset?: number; limit?: number; sortBy?: string; sortDescending?: boolean; filter?: string }): Promise<CommandResult> {
    return this.dispatchSettled({ type: "table-page", ...this.base("table"), handle: options.handle,
      offset: options.offset ?? 0, limit: options.limit ?? 25, sortBy: options.sortBy ?? "",
      sortDescending: options.sortDescending ?? false, filter: options.filter ?? "" });
  }

  async inspect(name: string): Promise<CommandResult> {
    return this.dispatchSettled({ type: "inspect", ...this.base("inspect"), name });
  }

  async setRuntime(update: { executionMode?: "automatic" | "lazy"; runOnStartup?: boolean }): Promise<CommandResult> {
    return this.dispatch({ type: "set-runtime", ...this.base("runtime"), ...update });
  }

  async setConfig(patch: Record<string, unknown>): Promise<CommandResult> {
    return this.dispatch({ type: "set-config", ...this.base("config"), patch });
  }

  async setLayout(layout: unknown): Promise<CommandResult> {
    return this.dispatch({ type: "set-layout", ...this.base("layout"), layout });
  }

  async formatCells(keys?: readonly string[]): Promise<CommandResult> {
    await this.commitEdits();
    const cells = keys?.map((key) => this.requireCell(key)) ?? [...this.requireDocument().cells];
    const acknowledged = cells.filter((cell): cell is LocalCell & { id: string } => cell.id !== null);
    return this.dispatch({
      type: "format", ...this.base("format"),
      ...(keys ? { cellIds: acknowledged.map((cell) => cell.id) } : {}),
      expectedRevisions: Object.fromEntries(acknowledged.map((cell) => [cell.id, cell.serverRevision])),
    });
  }

  async service(command: Extract<HostCommand, { type: "service" }>["command"], payload: Record<string, unknown> = {}): Promise<CommandResult> {
    const request = { type: "service", ...this.base(command), command, payload } as const;
    return ["export", "publish", "packages", "packages.status", "packages.declare", "packages.install", "upload"].includes(command)
      ? this.dispatchSettled(request)
      : this.dispatch(request);
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

  private async dispatchSource(command: Extract<HostCommand, { type: "run" | "edit" | "create" }>): Promise<CommandResult> {
    const document = this.requireDocument();
    const edits = command.type === "create" ? [] : command.edits;
    const creations = command.type === "edit" ? [] : command.creations;
    const affectedKeys = edits.map((edit) => document.cell(edit.cellId)?.key)
      .filter((key): key is string => key !== undefined);
    document.noteSubmitted(command.operationId, command);
    try {
      const result = await this.dispatch(command);
      document.acknowledge(result);
      this.notify(undefined, creations.length > 0 ? undefined : affectedKeys);
      return result;
    } catch (error) {
      document.reject(command.operationId, error instanceof BrowserTransportError ? error.code : "internal_error");
      this.notify(undefined, creations.length > 0 ? undefined : affectedKeys);
      throw error;
    }
  }

  private dispatch(command: HostCommand): Promise<CommandResult> {
    return this.transport.dispatch(command).then((result) => {
      this.captureOperation(result.operation);
      this.options.onCommand?.(command, result);
      return result;
    });
  }

  private async dispatchSettled(command: HostCommand): Promise<CommandResult> {
    const accepted = await this.dispatch(command);
    const operation = operationSettled(accepted.operation)
      ? accepted.operation
      : await this.awaitOperation(accepted.operation.id);
    if (operation.status === "error" || operation.status === "cancelled") {
      throw new BrowserTransportError(operation.error?.code ?? `${command.type}_failed`, operation.error?.message ?? `${command.type} operation failed`);
    }
    return { ...accepted, operation };
  }

  private receiveSnapshot(snapshot: HostSnapshot): void {
    if (this.documentValue !== null && this.documentValue.epoch !== snapshot.epoch) {
      this.rejectOperationWaiters(new BrowserTransportError(
        "session_replaced",
        "notebook session was replaced while the operation was pending",
      ));
      this.operations.clear();
      this.runs.clear();
    }
    snapshot.operations.forEach((operation) => this.captureOperation(operation));
    if (this.documentValue) this.documentValue.applySnapshot(snapshot);
    else this.documentValue = new BrowserDocument(snapshot);
    this.notify();
  }

  private receiveEvent(event: HostEvent): void {
    const document = this.documentValue;
    if (!document) throw new BrowserTransportError("invalid_server_message", "received event without a notebook snapshot");
    document.applyEvent(event);
    if (event.type === "operation" && isOperation(event.payload)) this.captureOperation(event.payload);
    this.notify(event);
    if (event.type === "cell-completed" && event.operationId) this.observeCompletion(event);
  }

  private observeCompletion(event: HostEvent): void {
    const intent = this.runs.get(event.operationId!);
    if (!intent || !event.cellId || typeof event.revision !== "number") return;
    const cell = this.requireDocument().cell(intent.targetKey);
    if (!cell || cell.id !== event.cellId || cell.serverRevision !== event.revision || !sameLines(cell.desiredBody, cell.serverBody)) return;
    this.runs.delete(intent.operationId);
    this.frame(() => this.frame(() => {
      this.options.onVisibleResult?.({
        operationId: intent.operationId,
        runId: event.runId ?? null,
        cellId: event.cellId!,
        revision: event.revision!,
        inputTimestamp: intent.inputTimestamp,
        handlerTimestamp: intent.handlerTimestamp,
        presentedTimestamp: this.now(),
        proxy: "two-animation-frames",
      });
    }));
  }

  private base(label: string): { operationId: string; clientId: string; sessionEpoch: string } {
    const document = this.requireDocument();
    return { operationId: operationId(label), clientId: this.transport.id, sessionEpoch: document.epoch };
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
    // An unchanged Run ACK advances bookkeeping without changing local cells.
    // It must not force queued server projections into a synchronous render.
    if (!event && localCellKeys?.length === 0) return;
    for (const listener of this.listeners) listener(this.documentValue, event, localCellKeys);
  }

  private captureOperation(operation: OperationRecord): void {
    this.operations.set(operation.id, operation);
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

  private async withSourceLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.sourceQueue;
    let release!: () => void;
    this.sourceQueue = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function splitSource(source: string): string[] {
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized === "" ? [] : normalized.split("\n");
}

function normalizeInputTimestamp(timestamp: number | undefined, now: number): number {
  if (!Number.isFinite(timestamp)) return now;
  // Modern browsers use the performance time origin. Epoch-valued timestamps
  // are translated without discarding main-thread input delay.
  if (timestamp! > 1e12 && typeof performance.timeOrigin === "number") return timestamp! - performance.timeOrigin;
  return timestamp!;
}

function operationId(label: string): string {
  try { return `${label}-${crypto.randomUUID()}`; } catch { return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function operationSettled(operation: OperationRecord): boolean {
  return operation.status === "done" || operation.status === "error" || operation.status === "cancelled";
}

function isOperation(value: unknown): value is OperationRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).status === "string";
}

export type { Recovery };
