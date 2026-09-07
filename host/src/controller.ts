import { randomUUID } from "node:crypto";

import {
  analysisDiagnosticSchema,
  analysisResultSchema,
  cellEditSchema,
  engineEventSchema,
  engineHandshakeSchema,
  engineResponseSchema,
  HOST_PROTOCOL,
  MAX_DEPENDENCY_EDGES,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  notebookInputSchema,
  notebookSourceByteLength,
  parseHostCommand,
  type AnalysisCellResult,
  type AnalysisDiagnostic,
  type CellSnapshot,
  type CellCreation,
  type CellEdit,
  type CellStatus,
  type CommandResult,
  type ControllerServices,
  type EngineAdapter,
  type EngineEvent,
  type EngineHandshake,
  type EngineResponse,
  type EvaluationPayload,
  type HostCellState,
  type HostCommand,
  type HostError,
  type HostEvent,
  type HostEventType,
  type HostSnapshot,
  type NotebookInput,
  type OperationRecord,
  type Recovery,
  type RuntimeVariable,
} from "./protocol.js";
import { ReactiveGraph, type GraphCellInput } from "./graph.js";
import { tailLog } from "./output-log.js";

const OPERATION_JOURNAL_LIMIT = 256;
const COMMAND_DEDUPLICATION_LIMIT = 512;
const EVENT_JOURNAL_LIMIT = 2_048;
const MAX_LOG_BYTES = 65_536;
const MAX_COMPLETED_LOG_BYTES = 1_048_576;
const LOG_TRUNCATION_MARKER = "[output truncated at 1048576 bytes]";
const MAX_EDITOR_DIAGNOSTICS = 2_000;
const MAX_EDITOR_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_RUNTIME_VARIABLES = 2_000;
const MAX_ANALYSIS_CACHE_ENTRIES = 256;
const MAX_ANALYSIS_CACHE_BYTES = 32 * 1024 * 1024;

export interface ControllerOptions {
  engine: EngineAdapter;
  notebook: NotebookInput;
  services?: ControllerServices;
  config?: Record<string, unknown>;
  layout?: unknown;
  executionMode?: "automatic" | "lazy";
  runOnStartup?: boolean;
  deferStartup?: boolean;
  epoch?: string;
  journalLimit?: number;
  journalByteLimit?: number;
}

interface CellRecord {
  id: string;
  type: "code" | "markdown";
  body: string[];
  options: Record<string, unknown>;
  revision: number;
  status: Exclude<CellStatus, "disabled">;
  outputs: unknown[];
  outputsStale?: boolean;
  progress: unknown | null;
  log: string[];
  error: EngineResponse["error"] | null;
  analysis: AnalysisCellResult | null;
}

interface EvaluationJob {
  id: string;
  revision: number;
  source: string;
  definitions: string[];
  locals: string[];
  opaque: boolean;
  runId: string;
  operationId: string;
}

interface ActiveEvaluation {
  job: EvaluationJob;
  requestId?: number;
  queuedCancellation?: AbortController;
  lastSequence: number;
  cancelMode: "source" | "widget" | "stop" | null;
  interruptSent: boolean;
  streamedOutputs: unknown[];
  completion?: EngineResponse;
  protocolFailure?: ControllerError;
}

interface CommandEntry {
  fingerprint: string;
  promise: Promise<CommandResult>;
}

interface AnalysisCacheValue {
  defs: string[];
  refs: string[];
  selfRefs: string[];
  locals: string[];
  barrier: boolean;
  opaque: boolean;
  diagnostics: unknown[];
  error: string | null;
}

interface ChangeResult {
  edited: Array<{ id: string; revision: number }>;
  created: Array<{ clientOperationId: string; id: string; revision: number }>;
}

interface PendingButtonReset {
  key: string;
  name: string;
  path: string[];
  owner: string;
  revision: number;
  widget: Record<string, unknown>;
  triggerOperationId: string;
  directConsumers: string[];
  runId: string | null;
}

interface ActiveButtonReset {
  operationId: string;
  token: number;
  reset: PendingButtonReset;
}

type EventListener = (event: HostEvent) => void;

export class ControllerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = errorStatus(code), details?: unknown) {
    super(message);
    this.name = "ControllerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(operationId?: string): HostError {
    return {
      code: this.code,
      message: this.message,
      ...(operationId === undefined ? {} : { operationId }),
      ...(this.details === undefined ? {} : { details: clone(this.details) }),
    };
  }
}

export class Controller {
  private readonly engine: EngineAdapter;
  private readonly services: ControllerServices;
  private readonly epochValue: string;
  private readonly eventJournalLimit: number;
  private readonly eventJournalByteLimit: number;
  private readonly listeners = new Map<EventListener, readonly HostEventType[] | undefined>();
  private readonly eventJournal: HostEvent[] = [];
  private readonly operations = new Map<string, OperationRecord>();
  private readonly operationWaiters = new Map<
    string,
    Set<(operation: OperationRecord) => void>
  >();
  private readonly commandEntries = new Map<string, CommandEntry>();
  private readonly creationIds = new Map<string, string>();
  private readonly analysisCache = new Map<string, AnalysisCacheValue>();
  private analysisCacheBytes = 0;
  private readonly analysisNeeded = new Set<string>();
  private readonly barrierAnalysisCandidates = new Set<string>();
  private readonly clearBeforeEvaluation = new Set<string>();
  private readonly invalidatedDefinitionsByCell = new Map<string, Set<string>>();
  private readonly runOperationById = new Map<string, string>();
  private readonly causalRunFailures = new Map<string, HostError>();
  private readonly causalWidgetRunParents = new Map<string, string>();
  private readonly causalWidgetFailures = new Map<string, HostError>();
  private readonly obsoleteWidgetRequests = new Map<string, string>();
  private readonly widgetReconciliationRoots = new Map<string, number>();
  private readonly pendingButtonResets = new Map<string, PendingButtonReset>();
  private readonly activeButtonResets = new Map<string, ActiveButtonReset>();
  private readonly pendingWidgets = new Map<string, string>();
  private pendingInspection: {
    operationId: string;
    name: string;
    owner: string | null;
    revision: number | null;
  } | null = null;
  private readonly pendingLazyOutputs = new Map<
    string,
    { operationId: string; owner: string }
  >();
  private readonly pendingTablePages = new Map<
    string,
    { operationId: string; owner: string }
  >();
  private readonly pendingUploads = new Map<
    string,
    {
      name: string;
      path: string[];
      key: string;
      owner: string;
      revision: number;
      widget: Record<string, unknown>;
      uploadId: string | null;
      source: "editor" | "app" | "mcp" | "cli";
    }
  >();
  private eventJournalBytes = 0;
  private serviceMutationTail: Promise<void> = Promise.resolve();
  private readonly editorDiagnostics = new Map<string, AnalysisDiagnostic[]>();
  private readonly serviceErrors: HostSnapshot["serviceErrors"] = {};
  private variables: RuntimeVariable[] = [];
  private variableGeneration = 0;
  private variableRefreshRequested = false;
  private variableRefreshInFlight = false;
  private variableRefreshTimer: NodeJS.Timeout | undefined;

  private cells: CellRecord[];
  private graphValue = new ReactiveGraph([]);
  private pathValue: string | null;
  private metadata: Record<string, unknown>;
  private config: Record<string, unknown>;
  private layout: unknown;
  private executionMode: "automatic" | "lazy";
  private runOnStartup: boolean;
  private readonly deferStartup: boolean;
  private startupActivated = false;
  private changed = false;
  private version = 0;
  private cursorValue = 0;
  private runtimeSignature: string | undefined;
  private runCounter = 0;
  private widgetToken = 0;
  private analysisGeneration = 0;
  private analysisInFlight: Promise<void> | null = null;
  private analysisRestarting = false;
  private analyzerIdentity = "";
  private handshake: EngineHandshake | null = null;
  private started = false;
  private closed = false;
  private executionReady = false;
  private analyzerAvailable = false;
  private kernelAvailable = false;
  private queue: EvaluationJob[] = [];
  private activeEvaluation: ActiveEvaluation | null = null;
  private activeBatch: Map<string, ActiveEvaluation> | null = null;
  private readonly interruptedRuns = new Map<string, NonNullable<EngineResponse["error"]>>();
  private pumpPromise: Promise<void> | null = null;
  private barrierRestartRequired = false;
  private packageOperationActive = false;
  private runPreparationActive = false;
  private widgetReconciliationScheduled = false;
  private widgetReconciliationPreparing = false;
  private runtimeGeneration = 0;
  private lastValue: unknown | null = null;
  private lastActionError: HostError | null = null;
  private engineFailureUnsubscribe: (() => void) | null = null;
  private startPromise: Promise<HostSnapshot> | null = null;
  private engineRestarting = false;

  constructor(options: ControllerOptions) {
    this.engine = options.engine;
    this.services = options.services ?? {};
    this.epochValue = options.epoch ?? randomUUID();
    this.eventJournalLimit = boundedPositiveInteger(
      options.journalLimit,
      EVENT_JOURNAL_LIMIT,
    );
    this.eventJournalByteLimit = boundedPositiveInteger(
      options.journalByteLimit,
      4 * 1024 * 1024,
    );
    let notebook: ReturnType<typeof notebookInputSchema.parse>;
    try {
      notebook = notebookInputSchema.parse(options.notebook);
    } catch (error) {
      throw new ControllerError("invalid_notebook", messageOf(error), 400);
    }
    this.pathValue = notebook.path ?? null;
    this.metadata = clone(notebook.metadata);
    this.config = clone(options.config ?? {});
    this.layout = clone(options.layout ?? null);
    this.executionMode = options.executionMode
      ?? runtimeMode(this.metadata)
      ?? "automatic";
    this.runOnStartup = options.runOnStartup
      ?? runtimeStartup(this.metadata)
      ?? true;
    this.deferStartup = options.deferStartup ?? false;
    this.cells = notebook.cells.map((cell) => ({
      id: cell.id,
      type: cell.type,
      body: [...cell.body],
      options: clone(cell.options),
      revision: cell.revision,
      status: cell.type === "markdown" ? "done" : "idle",
      outputs: [],
      progress: null,
      log: [],
      error: null,
      analysis: cell.type === "markdown" ? emptyAnalysis(cell.id, cell.revision) : null,
    }));
    for (const cell of this.cells) {
      if (cell.type === "code") this.analysisNeeded.add(cell.id);
    }
    this.graphValue = this.rebuildGraph();
  }

  get epoch(): string {
    return this.epochValue;
  }

  get cursor(): number {
    return this.cursorValue;
  }

  async start(): Promise<HostSnapshot> {
    this.assertNotClosed();
    if (this.started) return this.snapshot();
    if (this.startPromise !== null) return this.startPromise;
    const promise = this.startOnce();
    this.startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  private async startOnce(): Promise<HostSnapshot> {
    const generation = this.runtimeGeneration;
    if (this.engineFailureUnsubscribe === null && this.engine.onFailure !== undefined) {
      this.engineFailureUnsubscribe = this.engine.onFailure((role, error) => {
        this.handleEngineFailure(role, error);
      });
    }
    let handshake: EngineHandshake;
    try {
      handshake = engineHandshakeSchema.parse(await this.engine.start());
    } catch (error) {
      if (this.closed || generation !== this.runtimeGeneration) {
        throw new ControllerError("session_stopped", "session is stopped", 409);
      }
      this.kernelAvailable = false;
      this.analyzerAvailable = false;
      this.replaceLastActionError(hostError("engine_start_failed", messageOf(error)));
      throw new ControllerError("engine_start_failed", messageOf(error), 503);
    }
    if (this.closed || generation !== this.runtimeGeneration) {
      throw new ControllerError("session_stopped", "session is stopped", 409);
    }
    this.handshake = handshake;
    this.started = true;
    this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
    this.analyzerAvailable = handshake.analyzerReady;
    if (!this.kernelAvailable || !this.analyzerAvailable) {
      this.replaceLastActionError(hostError(
        "engine_not_ready",
        "R kernel, analyzer, and capture services must be ready before execution",
      ));
      this.emit("runtime", this.runtimeSnapshot());
      return this.snapshot();
    }

    await this.renderMarkdownCells();
    this.assertStartCurrent(generation);
    try {
      await this.ensureCurrentAnalysis();
      this.assertStartCurrent(generation);
      this.executionReady = true;
      if (!this.graphValue.resourceLimited) this.replaceLastActionError(null);
    } catch (error) {
      this.assertStartCurrent(generation);
      const failure = asControllerError(error, "analysis_unavailable", 503);
      this.replaceLastActionError(failure.toJSON());
    }
    this.bump("notebook", { ready: this.executionReady });
    this.emit("runtime", this.runtimeSnapshot());
    this.emitGraph();
    if (!this.deferStartup) await this.activateStartup();
    return this.snapshot();
  }

  async activateStartup(): Promise<OperationRecord | null> {
    this.assertStarted();
    if (this.startupActivated) return null;
    this.startupActivated = true;
    if (!this.executionReady || !this.runOnStartup) return null;
    const operationId = `startup-${randomUUID()}`;
    this.createOperation(operationId, "run");
    try {
      this.assertGraphRunnable();
      this.launchRun(this.allCodePlan(), operationId);
    } catch (error) {
      const failure = asControllerError(error).toJSON(operationId);
      this.replaceLastActionError(failure, { operationId });
      this.failOperation(operationId, failure);
    }
    return clone(this.operations.get(operationId) ?? null);
  }

  snapshot(): HostSnapshot {
    const snapshot: HostSnapshot = {
      protocol: HOST_PROTOCOL,
      epoch: this.epochValue,
      cursor: this.cursorValue,
      version: this.version,
      path: this.pathValue,
      metadata: clone(this.metadata),
      config: clone(this.config),
      layout: clone(this.layout),
      changed: this.changed,
      runtime: this.runtimeSnapshot(),
      cells: this.cells.map((cell) => this.publicCell(cell)),
      graph: clone(this.graphValue.state),
      variables: clone(this.variables),
      editorDiagnostics: Object.fromEntries(
        [...this.editorDiagnostics].map(([id, diagnostics]) => [id, clone(diagnostics)]),
      ),
      serviceErrors: clone(this.serviceErrors),
      operations: [...this.operations.values()].map(clone),
      lastValue: clone(this.lastValue),
      lastActionError: clone(this.lastActionError),
    };
    return snapshot;
  }

  publishEditorDiagnostics(
    sourceSnapshots: readonly CellSnapshot[],
    byCell: Readonly<Record<string, readonly unknown[]>>,
  ): boolean {
    if (this.closed || !Array.isArray(sourceSnapshots) || !isRecord(byCell)
      || sourceSnapshots.length !== this.cells.length) return false;
    for (const [index, source] of sourceSnapshots.entries()) {
      const cell = this.cells[index];
      if (cell === undefined
        || source.id !== cell.id
        || source.revision !== cell.revision
        || source.type !== cell.type
        || source.source !== joinSource(cell.body)) return false;
    }

    const known = new Set(this.cells.map((cell) => cell.id));
    const next = new Map<string, AnalysisDiagnostic[]>();
    let count = 0;
    let bytes = 0;
    for (const [id, rawDiagnostics] of Object.entries(byCell)) {
      if (id !== ".document" && !known.has(id)) continue;
      if (!Array.isArray(rawDiagnostics)) continue;
      const diagnostics: AnalysisDiagnostic[] = [];
      if (id !== ".document" && this.cellById(id)?.options.disabled === true) {
        next.set(id, diagnostics);
        continue;
      }
      for (const raw of rawDiagnostics) {
        if (count >= MAX_EDITOR_DIAGNOSTICS) break;
        const parsed = analysisDiagnosticSchema.safeParse(raw);
        if (!parsed.success) continue;
        const diagnostic = { ...clone(parsed.data), source: "lsp" };
        const diagnosticBytes = jsonBytes(diagnostic);
        if (diagnosticBytes > MAX_EDITOR_DIAGNOSTIC_BYTES
          || bytes + diagnosticBytes > MAX_EDITOR_DIAGNOSTIC_BYTES) break;
        diagnostics.push(diagnostic);
        count += 1;
        bytes += diagnosticBytes;
      }
      if (diagnostics.length > 0 || this.editorDiagnostics.has(id)) next.set(id, diagnostics);
    }

    const changedIds = new Set<string>();
    for (const id of new Set([...this.editorDiagnostics.keys(), ...next.keys()])) {
      if (stableStringify(this.editorDiagnostics.get(id) ?? [])
        !== stableStringify(next.get(id) ?? [])) changedIds.add(id);
    }
    if (changedIds.size === 0) return true;
    this.editorDiagnostics.clear();
    for (const [id, diagnostics] of next) {
      if (diagnostics.length > 0) this.editorDiagnostics.set(id, diagnostics);
    }
    this.bump("editor-diagnostics", Object.fromEntries(
      [...this.editorDiagnostics].map(([id, diagnostics]) => [id, clone(diagnostics)]),
    ));
    for (const id of changedIds) {
      if (id === ".document") continue;
      const cell = this.cellById(id);
      if (cell === undefined) continue;
      this.emit("diagnostics", clone(this.publicCell(cell).diagnostics), {
        cellId: id,
        revision: cell.revision,
      });
    }
    return true;
  }

  publishServiceError(service: "lsp", error: HostError | null): boolean {
    if (this.closed) return false;
    const previous = this.serviceErrors[service] ?? null;
    const next = clone(error);
    if (stableStringify(previous) === stableStringify(next)) return false;
    if (next === null) delete this.serviceErrors[service];
    else this.serviceErrors[service] = next;
    this.bump("service-errors", clone(this.serviceErrors));
    return true;
  }

  recover(epoch: string | null, cursor: number | null): Recovery {
    if (
      epoch !== this.epochValue
      || cursor === null
      || !Number.isSafeInteger(cursor)
      || cursor < 0
      || cursor > this.cursorValue
    ) {
      return this.snapshotRecovery();
    }
    const earliest = this.eventJournal[0]?.cursor ?? this.cursorValue + 1;
    if (cursor < earliest - 1) return this.snapshotRecovery();
    return {
      kind: "replay",
      epoch: this.epochValue,
      cursor: this.cursorValue,
      events: this.eventJournal.filter((event) => event.cursor > cursor).map(clone),
    };
  }

  subscribe(listener: EventListener, types?: readonly HostEventType[]): () => void {
    this.assertNotClosed();
    this.listeners.set(listener, types?.slice());
    return () => {
      this.listeners.delete(listener);
    };
  }

  operation(id: string): OperationRecord | undefined {
    const operation = this.operations.get(id);
    return operation === undefined ? undefined : clone(operation);
  }

  recordActionError(message: string, code = "internal_error"): void {
    this.assertNotClosed();
    this.replaceLastActionError(hostError(code, message));
  }

  awaitOperation(id: string, signal?: AbortSignal): Promise<OperationRecord> {
    const current = this.operations.get(id);
    if (current === undefined) {
      return Promise.reject(new ControllerError("not_found", `no such operation: ${id}`, 404));
    }
    if (isTerminal(current.status)) return Promise.resolve(clone(current));
    return new Promise<OperationRecord>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const waiters = this.operationWaiters.get(id) ?? new Set();
      const finish = (operation: OperationRecord): void => {
        signal?.removeEventListener("abort", abort);
        resolve(clone(operation));
      };
      const abort = (): void => {
        waiters.delete(finish);
        if (waiters.size === 0) this.operationWaiters.delete(id);
        reject(abortError());
      };
      waiters.add(finish);
      this.operationWaiters.set(id, waiters);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  dispatch(input: HostCommand | unknown): Promise<CommandResult> {
    this.assertNotClosed();
    let command: HostCommand;
    try {
      command = parseHostCommand(input);
    } catch (error) {
      return Promise.reject(asControllerError(error, "invalid_request", 400));
    }
    if (command.sessionEpoch !== this.epochValue) {
      return Promise.reject(new ControllerError(
        "session_epoch_mismatch",
        "command belongs to a different session epoch",
        409,
      ));
    }
    const fingerprint = stableStringify(command);
    const prior = this.commandEntries.get(command.operationId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.reject(new ControllerError(
          "operation_id_conflict",
          `operation ${command.operationId} was already used for a different command`,
          409,
        ));
      }
      return prior.promise;
    }
    const promise = this.executeCommand(command);
    this.commandEntries.set(command.operationId, { fingerprint, promise });
    this.trimCommandEntries();
    return promise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.runtimeGeneration = nextRevision(this.runtimeGeneration);
    this.analysisGeneration = nextRevision(this.analysisGeneration);
    this.variableGeneration = nextRevision(this.variableGeneration);
    this.variableRefreshRequested = false;
    clearTimeout(this.variableRefreshTimer);
    this.variableRefreshTimer = undefined;
    this.variables = [];
    this.editorDiagnostics.clear();
    this.executionReady = false;
    this.kernelAvailable = false;
    this.analyzerAvailable = false;
    this.packageOperationActive = false;
    this.runPreparationActive = false;
    this.queue = [];
    this.activeEvaluation = null;
    this.activeBatch = null;
    this.interruptedRuns.clear();
    this.pendingWidgets.clear();
    this.pendingButtonResets.clear();
    this.activeButtonResets.clear();
    this.causalRunFailures.clear();
    this.causalWidgetRunParents.clear();
    this.causalWidgetFailures.clear();
    this.obsoleteWidgetRequests.clear();
    this.widgetReconciliationRoots.clear();
    this.pendingInspection = null;
    this.pendingLazyOutputs.clear();
    this.pendingTablePages.clear();
    for (const pending of this.pendingUploads.values()) {
      if (pending.uploadId !== null) void this.removeUpload(pending.uploadId);
    }
    this.pendingUploads.clear();
    for (const operation of this.operations.values()) {
      if (!isTerminal(operation.status)) {
        this.failOperation(
          operation.id,
          hostError("session_stopped", "session is stopped", operation.id),
        );
      }
    }
    this.emit("runtime", this.runtimeSnapshot());
    this.engineFailureUnsubscribe?.();
    this.engineFailureUnsubscribe = null;
    await this.engine.close();
    this.listeners.clear();
  }

  private async executeCommand(command: HostCommand): Promise<CommandResult> {
    const operation = this.createOperation(command.operationId, command.type);
    this.emit("receipt", { operation: clone(operation), commandType: command.type }, {
      operationId: command.operationId,
    });
    try {
      if (this.engineRestarting && command.type !== "restart") {
        throw new ControllerError(
          "operation_in_progress",
          "R engine restart is already in progress",
          409,
        );
      }
      let result: unknown;
      let deferred = false;
      switch (command.type) {
        case "edit":
          result = await this.applySourceChanges(command.edits, [], false, command.operationId);
          break;
        case "create":
          result = await this.applySourceChanges([], command.creations, false, command.operationId);
          break;
        case "delete":
          result = this.deleteCell(command.cellId, command.expectedRevision, command.operationId);
          break;
        case "move":
          result = this.moveCell(command.cellId, command.after, command.operationId);
          break;
        case "disable":
          result = await this.setCellDisabled(
            command.cellId,
            command.disabled,
            command.expectedRevision,
            command.operationId,
          );
          deferred = isRecord(result) && typeof result.runId === "string";
          break;
        case "run":
          result = await this.prepareRun(command);
          deferred = true;
          break;
        case "interrupt":
          result = await this.interruptActiveRun();
          break;
        case "restart":
          result = await this.restartEngine(command.replay, command.operationId);
          deferred = command.replay;
          break;
        case "widget":
          result = this.startWidgetOperation(command);
          deferred = true;
          break;
        case "inspect":
          result = this.startInspection(command.operationId, command.name);
          deferred = true;
          break;
        case "lazy-output":
          result = this.startLazyOutput(command.operationId, command.key);
          deferred = true;
          break;
        case "table-page":
          result = this.startTablePage(command);
          deferred = true;
          break;
        case "save":
          result = await this.saveNotebook();
          break;
        case "format":
          result = await this.formatSource(command.cellIds, command.expectedRevisions, command.operationId);
          break;
        case "set-runtime":
          result = this.setRuntime(command.executionMode, command.runOnStartup);
          break;
        case "set-config":
          result = await this.setConfig(command.patch);
          break;
        case "set-layout":
          result = await this.setLayout(command.layout);
          break;
        case "service":
          if (isLongService(command.command)) {
            result = this.startServiceOperation(command);
            deferred = true;
          } else {
            result = await this.callService(command.command, command.payload);
          }
          break;
        default:
          throw assertNever(command);
      }
      if (!deferred) this.completeOperation(command.operationId, result);
      return {
        operation: clone(this.operations.get(command.operationId) ?? operation),
        version: this.version,
        cursor: this.cursorValue,
        ...(result === undefined ? {} : { result: clone(result) }),
      };
    } catch (error) {
      const failure = asControllerError(error);
      const hostFailure = failure.toJSON(command.operationId);
      if (!this.closed) {
        this.replaceLastActionError(hostFailure, { operationId: command.operationId });
        this.failOperation(command.operationId, hostFailure);
      }
      throw failure;
    }
  }

  private async applySourceChanges(
    edits: readonly CellEdit[],
    creations: readonly CellCreation[],
    waitForAnalysis: boolean,
    operationId?: string,
  ): Promise<ChangeResult> {
    this.assertStartedForMutation();
    this.validateAtomicSourceChanges(edits, creations);

    const changedEdits = edits.filter((edit) => {
      const current = this.cellById(edit.cellId);
      return current !== undefined
        && (current.type !== edit.cellType || !arrayEqual(current.body, edit.body));
    });
    const oldGraph = this.graphValue;
    const structureChanged = creations.length > 0
      || changedEdits.some((edit) => this.requireCell(edit.cellId).type !== edit.cellType);
    const oldAffected = new Set<string>();
    const statusChanges = new Set<string>();
    let touchesBarrier = false;
    for (const edit of changedEdits) {
      oldAffected.add(edit.cellId);
      for (const descendant of oldGraph.descendants(edit.cellId)) oldAffected.add(descendant);
      if (this.cellById(edit.cellId)?.analysis?.barrier) touchesBarrier = true;
    }
    if (oldGraph.resourceLimited && changedEdits.length > 0) {
      for (const cell of this.cells) {
        if (cell.type === "code") oldAffected.add(cell.id);
      }
    }
    if (oldAffected.size > 0) {
      for (const id of this.cancelRunRegion(oldAffected, "source")) statusChanges.add(id);
    }
    if (changedEdits.length > 0 || creations.length > 0) {
      this.clearEditorDiagnostics();
      this.clearVariables();
    }

    const edited: ChangeResult["edited"] = [];
    for (const edit of edits) {
      const cell = this.requireCell(edit.cellId);
      if (cell.type === edit.cellType && arrayEqual(cell.body, edit.body)) {
        edited.push({ id: cell.id, revision: cell.revision });
        continue;
      }
      const previousType = cell.type;
      if (previousType === "code") {
        this.rememberInvalidatedDefinitions(cell);
        this.clearBeforeEvaluation.add(cell.id);
      }
      const cancelledWidgets = this.cancelOwnedOperations(cell.id);
      cell.revision = nextRevision(cell.revision);
      cell.type = edit.cellType;
      cell.body = [...edit.body];
      cell.analysis = edit.cellType === "markdown"
        ? emptyAnalysis(cell.id, cell.revision)
        : null;
      cell.progress = null;
      cell.error = null;
      if (edit.cellType === "markdown") {
        this.analysisNeeded.delete(cell.id);
        this.barrierAnalysisCandidates.delete(cell.id);
        cell.status = "done";
        cell.outputs = [markdownPlaceholder(cell.body)];
        cell.log = [];
      } else {
        cell.status = staleStatus(cell.status);
        if (previousType !== "code") cell.outputs = [];
        this.analysisNeeded.add(cell.id);
        this.barrierAnalysisCandidates.add(cell.id);
      }
      for (const operationId of cancelledWidgets) {
        this.obsoleteWidgetRequests.set(operationId, cell.id);
      }
      if (this.widgetReconciliationRoots.has(cell.id)) {
        this.widgetReconciliationRoots.set(cell.id, cell.revision);
      }
      edited.push({ id: cell.id, revision: cell.revision });
    }

    const created: ChangeResult["created"] = [];
    for (const creation of creations) {
      const id = this.nextCellId();
      const record: CellRecord = {
        id,
        type: creation.cellType,
        body: [...creation.body],
        options: clone(creation.options),
        revision: 0,
        status: creation.cellType === "markdown" ? "done" : "idle",
        outputs: creation.cellType === "markdown"
          ? [markdownPlaceholder(creation.body)]
          : [],
        progress: null,
        log: [],
        error: null,
        analysis: creation.cellType === "markdown" ? emptyAnalysis(id, 0) : null,
      };
      const afterIndex = creation.after === null
        ? this.cells.length - 1
        : this.cells.findIndex((cell) => cell.id === creation.after);
      this.cells.splice(afterIndex + 1, 0, record);
      this.creationIds.set(creation.clientOperationId, id);
      if (record.type === "code") {
        this.analysisNeeded.add(id);
        this.barrierAnalysisCandidates.add(id);
      }
      created.push({ clientOperationId: creation.clientOperationId, id, revision: 0 });
    }

    if (changedEdits.length === 0 && created.length === 0) return { edited, created };
    this.changed = true;
    this.analysisGeneration = nextRevision(this.analysisGeneration);
    // Keep the last validated dependency relation during body-only edits.
    // Analysis readiness still gates execution of every new source revision.
    if (structureChanged) this.graphValue = this.rebuildGraph();
    for (const id of this.invalidateForGraphLimit()) statusChanges.add(id);
    if (this.analysisNeeded.size === 0) this.refreshButtonResets();
    for (const id of oldAffected) {
      if (this.markStale(id)) statusChanges.add(id);
    }
    if (touchesBarrier) {
      for (const id of this.invalidateForBarrier()) statusChanges.add(id);
    }
    const sourceIdentity = operationId === undefined ? {} : { operationId };
    this.bump("notebook", {
      edited,
      created,
      order: this.cells.map((cell) => cell.id),
    }, sourceIdentity);
    if (structureChanged) this.emitGraph(sourceIdentity);
    this.emitCells([
      ...statusChanges,
      ...changedEdits.map((edit) => edit.cellId),
      ...created.map((item) => item.id),
    ], sourceIdentity);
    for (const id of [...changedEdits.map((edit) => edit.cellId), ...created.map((item) => item.id)]) {
      const cell = this.cellById(id);
      if (cell?.type === "markdown") this.scheduleMarkdownRender(cell);
    }

    if (this.analysisNeeded.size > 0) {
      if (waitForAnalysis) {
        await this.ensureCurrentAnalysis();
      } else {
        this.scheduleAnalysis();
      }
    }
    return { edited, created };
  }

  private validateAtomicSourceChanges(
    edits: readonly CellEdit[],
    creations: readonly CellCreation[],
  ): void {
    if (this.cells.length + creations.length > MAX_NOTEBOOK_CELLS) {
      throw new ControllerError(
        "invalid_request",
        `notebook exceeds ${MAX_NOTEBOOK_CELLS} cell limit`,
        400,
      );
    }
    const editedIds = new Set<string>();
    for (const edit of edits) {
      if (editedIds.has(edit.cellId)) {
        throw new ControllerError("invalid_request", `cell ${edit.cellId} is edited more than once`, 400);
      }
      editedIds.add(edit.cellId);
      const cell = this.cellById(edit.cellId);
      if (cell === undefined) throw new ControllerError("not_found", `no such cell: ${edit.cellId}`, 404);
      if (cell.revision !== edit.expectedRevision) {
        throw new ControllerError(
          "source_conflict",
          `cell ${edit.cellId} changed on the server`,
          409,
          { expectedRevision: edit.expectedRevision, actualRevision: cell.revision },
        );
      }
    }
    const creationOperations = new Set<string>();
    for (const creation of creations) {
      if (creationOperations.has(creation.clientOperationId)) {
        throw new ControllerError(
          "invalid_request",
          `creation operation ${creation.clientOperationId} occurs more than once`,
          400,
        );
      }
      creationOperations.add(creation.clientOperationId);
      if (this.creationIds.has(creation.clientOperationId)) {
        throw new ControllerError(
          "operation_id_conflict",
          `creation operation ${creation.clientOperationId} was already acknowledged`,
          409,
        );
      }
      if (creation.after !== null && this.cellById(creation.after) === undefined) {
        throw new ControllerError("not_found", `no such cell: ${creation.after}`, 404);
      }
    }
    const editedBodies = new Map(edits.map((edit) => [edit.cellId, edit.body]));
    const projectedSource = [
      ...this.cells.map((cell) => ({ body: editedBodies.get(cell.id) ?? cell.body })),
      ...creations.map((creation) => ({ body: creation.body })),
    ];
    if (notebookSourceByteLength(projectedSource) > MAX_NOTEBOOK_SOURCE_BYTES) {
      throw new ControllerError(
        "invalid_request",
        `notebook source exceeds ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
        400,
      );
    }
  }

  private deleteCell(id: string, expectedRevision: number, operationId: string): unknown {
    this.assertStartedForMutation();
    const cell = this.requireCell(id);
    if (cell.revision !== expectedRevision) {
      throw new ControllerError("source_conflict", `cell ${id} changed on the server`, 409);
    }
    const affected = this.graphValue.resourceLimited
      ? new Set(this.cells.filter((candidate) => candidate.type === "code").map((candidate) => candidate.id))
      : new Set([id, ...this.graphValue.descendants(id)]);
    const statusChanges = this.cancelRunRegion(affected, "source");
    const barrier = cell.analysis?.barrier === true;
    this.rememberInvalidatedDefinitions(cell);
    this.cancelOwnedOperations(id);
    this.clearEditorDiagnostics();
    this.clearVariables();
    this.cells = this.cells.filter((candidate) => candidate.id !== id);
    this.analysisNeeded.delete(id);
    this.barrierAnalysisCandidates.delete(id);
    this.clearBeforeEvaluation.add(id);
    this.graphValue = this.rebuildGraph();
    for (const changedId of this.invalidateForGraphLimit()) statusChanges.add(changedId);
    this.refreshButtonResets();
    for (const descendant of affected) {
      if (this.markStale(descendant)) statusChanges.add(descendant);
    }
    if (barrier) {
      for (const changedId of this.invalidateForBarrier()) statusChanges.add(changedId);
    }
    this.changed = true;
    this.analysisGeneration = nextRevision(this.analysisGeneration);
    this.bump("notebook", {
      deleted: id,
      order: this.cells.map((cell) => cell.id),
    }, { operationId });
    this.emitGraph({ operationId });
    this.emit("cell", { deleted: true }, { operationId, cellId: id, revision: expectedRevision });
    statusChanges.delete(id);
    this.emitCells(statusChanges, { operationId });
    return { id };
  }

  private moveCell(id: string, after: string | null, operationId: string): unknown {
    this.assertStartedForMutation();
    const from = this.cells.findIndex((cell) => cell.id === id);
    if (from < 0) throw new ControllerError("not_found", `no such cell: ${id}`, 404);
    if (after === id) throw new ControllerError("invalid_request", "cannot move a cell after itself", 400);
    if (after !== null && this.cellById(after) === undefined) {
      throw new ControllerError("not_found", `no such cell: ${after}`, 404);
    }
    const previousOrder = this.cells.map((cell) => cell.id);
    const oldGraph = this.graphValue;
    const oldAffected = oldGraph.resourceLimited
      ? new Set(this.cells.filter((cell) => cell.type === "code").map((cell) => cell.id))
      : new Set([id, ...oldGraph.descendants(id)]);
    const statusChanges = new Set<string>();
    const nextCells = [...this.cells];
    const [moved] = nextCells.splice(from, 1);
    if (moved === undefined) throw new ControllerError("internal_error", "cell move failed", 500);
    const target = after === null
      ? 0
      : nextCells.findIndex((cell) => cell.id === after) + 1;
    nextCells.splice(target, 0, moved);
    if (arrayEqual(previousOrder, nextCells.map((cell) => cell.id))) return { id, after };
    for (const changedId of this.cancelRunRegion(oldAffected, "source")) {
      statusChanges.add(changedId);
    }
    this.clearEditorDiagnostics();
    this.clearVariables();
    this.cells = nextCells;
    this.graphValue = this.rebuildGraph();
    for (const changedId of this.invalidateForGraphLimit()) statusChanges.add(changedId);
    for (const candidate of oldAffected) {
      if (this.markStale(candidate)) statusChanges.add(candidate);
    }
    for (const candidate of this.graphValue.descendants(id)) {
      if (this.markStale(candidate)) statusChanges.add(candidate);
    }
    if (moved.analysis?.barrier || moved.analysis?.opaque) {
      for (const changedId of this.invalidateForBarrier()) statusChanges.add(changedId);
    }
    this.changed = true;
    this.bump("notebook", {
      moved: id,
      after,
      order: this.cells.map((cell) => cell.id),
    }, { operationId });
    this.emitGraph({ operationId });
    this.emitCells(statusChanges, { operationId });
    return { id, after };
  }

  private async setCellDisabled(
    id: string,
    disabled: boolean,
    expectedRevision: number | undefined,
    operationId: string,
  ): Promise<unknown> {
    this.assertStartedForMutation();
    const cell = this.requireCell(id);
    if (expectedRevision !== undefined && cell.revision !== expectedRevision) {
      throw new ControllerError("source_conflict", `cell ${id} changed on the server`, 409);
    }
    const prior = cell.options.disabled === true;
    if (prior === disabled) return { id, disabled, runId: null };
    this.clearEditorDiagnostics();
    this.clearVariables();
    const affected = this.graphValue.resourceLimited
      ? new Set(this.cells.filter((candidate) => candidate.type === "code").map((candidate) => candidate.id))
      : new Set([id, ...this.graphValue.descendants(id)]);
    const statusChanges = disabled
      ? this.cancelRunRegion(affected, "source")
      : new Set<string>();
    cell.options = { ...cell.options, disabled };
    this.graphValue = this.rebuildGraph();
    for (const changedId of this.invalidateForGraphLimit()) statusChanges.add(changedId);
    for (const candidateId of affected) {
      const candidate = this.cellById(candidateId);
      if (candidate?.type === "code" && candidate.status !== "running") {
        const before = this.statusOf(candidateId);
        candidate.status = "stale";
        if (this.statusOf(candidateId) !== before) statusChanges.add(candidateId);
      }
      this.cancelRuntimeRequestsOwnedBy(candidateId, "stale_value");
    }
    this.refreshValueFreshness();
    this.changed = true;
    this.bump("graph", clone(this.graphValue.state), { operationId });
    this.publishGraphResourceError({ operationId });
    this.emit("cell", this.publicCell(cell), {
      operationId,
      cellId: id,
      revision: cell.revision,
    });
    statusChanges.delete(id);
    this.emitCells(statusChanges, { operationId });

    let runId: string | null = null;
    if (
      !disabled
      && cell.type === "code"
      && this.executionMode === "automatic"
      && this.activeEvaluation === null
      && this.queue.length === 0
    ) {
      await this.ensureCurrentAnalysis();
      const plan = this.planCellRun(id, "app");
      if (plan.length > 0) runId = this.launchRun(plan, operationId);
    }
    return { id, disabled, runId };
  }

  private async prepareRun(command: Extract<HostCommand, { type: "run" }>): Promise<unknown> {
    this.assertNoPackageOperation();
    this.assertExecutionPossible();
    if (this.runPreparationActive
      || (this.activeEvaluation !== null && this.activeEvaluation.cancelMode === null)
      || this.queue.length > 0) {
      throw new ControllerError(
        "run_in_progress",
        "cannot start a run: one is already active or queued",
        409,
      );
    }
    this.runPreparationActive = true;
    try {
      let changes: ChangeResult | undefined;
      if (command.edits.length > 0 || command.creations.length > 0) {
        changes = await this.applySourceChanges(
          command.edits,
          command.creations,
          true,
          command.operationId,
        );
      } else {
        await this.ensureCurrentAnalysis();
      }
      this.assertNoPackageOperation();
      this.assertExecutionPossible();
      this.assertGraphRunnable();

      let plan: string[];
      if (command.scope === "cell") {
        const targetId = command.cellId
          ?? (command.targetCreationId === undefined
            ? undefined
            : this.creationIds.get(command.targetCreationId));
        if (targetId === undefined) {
          throw new ControllerError(
            "not_found",
            `no acknowledged creation: ${command.targetCreationId ?? ""}`,
            404,
          );
        }
        plan = this.planCellRun(targetId, command.source);
      } else if (command.scope === "all") {
        plan = this.allCodePlan();
      } else {
        plan = this.graphValue.planStale((id) => this.statusOf(id));
      }
      const runId = this.launchRun(plan, command.operationId);
      return {
        runId,
        plan: [...plan],
        ...(changes === undefined ? {} : changes),
      };
    } finally {
      this.runPreparationActive = false;
      this.scheduleWidgetReconciliation();
    }
  }

  private planCellRun(
    id: string,
    source: "editor" | "app" | "mcp" | "cli",
  ): string[] {
    const cell = this.cellById(id);
    if (cell === undefined) throw new ControllerError("not_found", `no such cell: ${id}`, 404);
    return this.graphValue.planCell(
      id,
      (candidate) => this.statusOf(candidate),
      this.executionMode,
      source,
    );
  }

  private allCodePlan(): string[] {
    return (this.graphValue.state.topologicalOrder ?? []).filter(
      (id) => this.cellById(id)?.type === "code",
    );
  }

  private launchRun(
    plan: readonly string[],
    operationId: string,
    deferEmptySettlement = false,
  ): string {
    this.assertNoPackageOperation();
    this.assertExecutionPossible();
    const operation = this.operations.get(operationId);
    if (operation === undefined) throw new ControllerError("internal_error", "run operation missing", 500);
    this.runCounter += 1;
    const runId = `run-${this.runCounter}`;
    const blocked = this.graphValue.blockedByDisabled();
    const jobs: EvaluationJob[] = [];
    for (const id of this.graphValue.orderOf(plan)) {
      const cell = this.cellById(id);
      if (cell === undefined || cell.type !== "code" || blocked.has(id)) continue;
      const analysis = cell.analysis;
      if (analysis === null || analysis.revision !== cell.revision) {
        throw new ControllerError(
          "analysis_pending",
          `cell ${id} does not have current dependency analysis`,
          409,
        );
      }
      jobs.push({
        id,
        revision: cell.revision,
        source: joinSource(cell.body),
        definitions: [...analysis.defs],
        locals: [...analysis.locals],
        opaque: analysis.opaque,
        runId,
        operationId,
      });
    }
    operation.status = jobs.length === 0 && !deferEmptySettlement ? "done" : "accepted";
    operation.runId = runId;
    operation.cellIds = jobs.map((job) => job.id);
    operation.executionDone = jobs.length === 0;
    operation.resetOperationIds ??= [];
    if (jobs.length === 0 && !deferEmptySettlement) operation.settledAt = Date.now();
    this.rememberOperation(operation);
    this.runOperationById.set(runId, operationId);
    this.queue.push(...jobs);
    this.bump("runtime", this.runtimeSnapshot(), { operationId, runId });
    if (jobs.length === 0 && !deferEmptySettlement) this.notifyOperationWaiters(operation);
    this.startPump();
    return runId;
  }

  private startPump(): void {
    if (this.pumpPromise !== null || this.closed) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      if (!this.closed && this.activeEvaluation === null && this.queue.length > 0) {
        this.startPump();
      } else {
        if (!this.closed) this.emit("runtime", this.runtimeSnapshot());
        this.scheduleWidgetReconciliation();
      }
    });
  }

  private async pump(): Promise<void> {
    while (!this.closed && this.activeEvaluation === null && this.queue.length > 0) {
      if (!this.kernelAvailable) {
        this.failKernel("R kernel is unavailable");
        return;
      }
      if (this.barrierRestartRequired) {
        const generation = this.runtimeGeneration;
        try {
          this.kernelAvailable = false;
          this.executionReady = false;
          this.emit("runtime", this.runtimeSnapshot());
          const restarted = await this.engine.restart();
          if (this.closed || generation !== this.runtimeGeneration) return;
          const handshake = engineHandshakeSchema.parse(restarted);
          this.handshake = handshake;
          this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
          this.analyzerAvailable = handshake.analyzerReady;
          if (!this.kernelAvailable || !this.analyzerAvailable) {
            throw new ControllerError(
              "engine_not_ready",
              "R engine did not become ready after barrier restart",
              503,
            );
          }
          this.barrierRestartRequired = false;
          this.clearBeforeEvaluation.clear();
          this.invalidatedDefinitionsByCell.clear();
          this.executionReady = true;
          this.emit("runtime", this.runtimeSnapshot());
        } catch (error) {
          if (this.closed || generation !== this.runtimeGeneration) return;
          this.failKernel(`R kernel restart failed: ${messageOf(error)}`);
          return;
        }
      }
      // Evaluation clears its own prior definitions and locals, including on
      // interruption. Other invalidated cells must still be cleared before it
      // can observe their bindings.
      const next = this.queue[0];
      const nextCell = next === undefined ? undefined : this.cellById(next.id);
      if (next !== undefined && nextCell?.type === "code"
        && nextCell.revision === next.revision
        && !this.graphValue.blockedByDisabled().has(next.id)
        && this.clearBeforeEvaluation.size === 1 && this.clearBeforeEvaluation.has(next.id)) {
        this.clearBeforeEvaluation.delete(next.id);
        this.invalidatedDefinitionsByCell.delete(next.id);
      }
      if (this.clearBeforeEvaluation.size > 0) {
        const ids = [...this.clearBeforeEvaluation];
        this.clearBeforeEvaluation.clear();
        const generation = this.runtimeGeneration;
        try {
          const response = engineResponseSchema.parse(
            await this.engine.request("clear_cell", { ids }),
          );
          if (this.closed || generation !== this.runtimeGeneration) return;
          if (!response.ok) throw new Error(response.error?.message ?? "clear_cell failed");
          for (const id of ids) {
            if (!this.clearBeforeEvaluation.has(id)) {
              this.invalidatedDefinitionsByCell.delete(id);
            }
          }
        } catch (error) {
          if (this.closed || generation !== this.runtimeGeneration) return;
          this.failKernel(`could not clear old cell bindings: ${messageOf(error)}`);
          return;
        }
        if (this.barrierRestartRequired || this.clearBeforeEvaluation.size > 0) continue;
      }

      const job = this.queue.shift();
      if (job === undefined) return;
      const cell = this.cellById(job.id);
      if (
        cell === undefined
        || cell.revision !== job.revision
        || cell.type !== "code"
        || this.graphValue.blockedByDisabled().has(job.id)
      ) {
        if (this.markStale(job.id)) {
          this.emitCells([job.id], { operationId: job.operationId, runId: job.runId });
        }
        this.completeRunIfIdle(job.runId);
        continue;
      }
      const batch = this.selectBatch(job);
      if (batch.length > 1) {
        this.queue.unshift(job);
        await this.runBatch(batch);
        continue;
      }
      this.cancelOwnedOperations(job.id);
      this.clearVariables();
      cell.status = "running";
      cell.outputsStale = cell.outputs.length > 0;
      cell.progress = null;
      cell.log = [];
      cell.error = null;
      this.activeEvaluation = {
        queuedCancellation: new AbortController(),
        job,
        lastSequence: -1,
        cancelMode: null,
        interruptSent: false,
        streamedOutputs: [],
      };
      let response: EngineResponse;
      try {
        const result = await this.engine.evaluate(this.evaluationPayload(job),
          (event) => this.handleEngineEvent(event), this.activeEvaluation.queuedCancellation!.signal);
        response = engineResponseSchema.parse(result);
      } catch (error) {
        this.failKernel(`R kernel transport failed: ${messageOf(error)}`, job.id);
        return;
      }

      await this.settleEvaluation(job, response);
    }
  }

  private evaluationPayload(job: EvaluationJob): EvaluationPayload {
    return {
      sessionEpoch: this.epochValue, operationId: job.operationId, runId: job.runId,
      cellId: job.id, revision: job.revision, source: job.source,
      definitions: [...job.definitions], locals: [...job.locals], opaque: job.opaque,
    };
  }

  private selectBatch(first: EvaluationJob): EvaluationJob[] {
    const jobs = [first];
    if (this.engine.evaluateBatch === undefined || this.engine.invalidateBatch === undefined ||
        first.opaque || this.cellById(first.id)?.analysis?.barrier) return jobs;
    // A bounded dependency chain can stop as a unit on error or out$stop().
    // Independent cells and dynamic barriers retain ordinary serial scheduling.
    for (const job of this.queue.slice(0, 3)) {
      const cell = this.cellById(job.id);
      if (job.runId !== first.runId || job.operationId !== first.operationId ||
          job.opaque || cell?.type !== "code" || cell.revision !== job.revision ||
          cell.analysis?.barrier || this.graphValue.blockedByDisabled().has(job.id) ||
          !this.graphValue.descendants(jobs.at(-1)!.id).includes(job.id)) break;
      jobs.push(job);
    }
    return jobs;
  }

  private async runBatch(jobs: readonly EvaluationJob[]): Promise<void> {
    const states = new Map(jobs.map((job) => [job.id, {
      job, lastSequence: -1, cancelMode: null, interruptSent: false, streamedOutputs: [],
    } as ActiveEvaluation]));
    const deferred: Array<() => Promise<void>> = [];
    this.activeBatch = states;
    this.activeEvaluation = states.get(jobs[0]!.id)!;
    for (const job of jobs) this.cancelOwnedOperations(job.id);
    this.clearVariables();
    try {
      await this.engine.evaluateBatch!(jobs.map((job) => this.evaluationPayload(job)), async (event) => {
        const active = states.get(event.cellId);
        if (active === undefined) throw new Error("batch event identifies an unknown cell");
        if (this.closed || this.activeBatch !== states) return;
        this.activeEvaluation = active;
        if (event.type === "started") {
          this.queue = this.queue.filter((job) => !sameJob(job, active.job));
          const cell = this.cellById(active.job.id);
          if (cell?.revision === active.job.revision && active.cancelMode === null) {
            cell.status = "running";
            cell.outputsStale = cell.outputs.length > 0;
            cell.progress = null;
            cell.log = [];
            cell.error = null;
          }
        }
        this.handleEngineEvent(event);
        if (active.protocolFailure !== undefined) throw active.protocolFailure;
        if (event.type === "completed") {
          await this.settleEvaluation(active.job, event.result, true, deferred);
        }
      });
      // Native cleanup requests queued by stale results must wait until the
      // batch terminal, otherwise its message callback would await itself.
      for (const release of deferred) await release();
    } catch (error) {
      if (!this.closed && this.activeBatch === states) {
        this.failKernel(`R kernel transport failed: ${messageOf(error)}`, this.activeEvaluation?.job.id);
      }
    } finally {
      if (this.activeBatch === states) {
        this.activeBatch = null;
        this.activeEvaluation = null;
        this.scheduleVariableRefresh();
        this.checkPendingButtonResets(jobs[0]!.runId);
        this.completeRunIfIdle(jobs[0]!.runId);
      }
    }
  }

  private async settleEvaluation(
    job: EvaluationJob, response: EngineResponse, retainActive = false,
    deferred?: Array<() => Promise<void>>,
  ): Promise<void> {
    const active = this.activeEvaluation;
    if (active === null || !sameJob(active.job, job)) {
      if (deferred !== undefined) deferred.push(() => this.releaseLateArtifacts(response));
      else await this.releaseLateArtifacts(response);
      if (this.closed) return;
      return;
    }
    if (active.protocolFailure !== undefined) {
      this.failKernel(active.protocolFailure.message, job.id);
      return;
    }
    if (active.requestId === undefined && !(response.cancelledBeforeStart === true
      && active.cancelMode !== null && response.error?.interrupted === true)) {
      this.failKernel("R kernel completed without a started acknowledgement", job.id);
      return;
    }
    if (active.completion !== undefined) response = active.completion;
    if (response.error?.transport) {
      this.failKernel(response.error.message, job.id);
      return;
    }
    const current = this.cellById(job.id);
    const fresh = current !== undefined && current.revision === job.revision;
    if (active.cancelMode === "source" || active.cancelMode === "widget" || !fresh) {
      if (deferred !== undefined) deferred.push(() => this.releaseLateArtifacts(response));
      else await this.releaseLateArtifacts(response);
      if (this.closed || this.activeEvaluation !== active) return;
      if (current !== undefined && this.markStale(current.id)) {
        this.emitCells([current.id], { operationId: job.operationId, runId: job.runId });
      }
    } else if (response.ok) {
      this.commitSuccess(job, response, active.streamedOutputs);
    } else {
      this.commitFailure(job, response, active.cancelMode === null);
      const operation = this.operations.get(job.operationId);
      if (operation?.kind === "widget" || this.causalWidgetRunParents.has(job.operationId)) {
        this.causalRunFailures.set(job.operationId, hostError(
          "eval_error",
          response.error?.message ?? "widget consumer evaluation failed",
          job.operationId,
        ));
      }
    }
    if (active.cancelMode === "stop" && response.error?.interrupted === true) {
      this.interruptedRuns.set(job.runId, clone(response.error));
      const parentId = this.causalWidgetRunParents.get(job.operationId);
      if (parentId !== undefined) {
        this.causalWidgetFailures.set(parentId, hostError(
          response.error.code ?? "interrupted",
          response.error.message,
          parentId,
        ));
      }
    }
    if (response.ok && response.stopped) this.dropRunDescendants(job.id, job.runId);
    if (this.widgetReconciliationRoots.get(job.id) === job.revision) {
      this.widgetReconciliationRoots.delete(job.id);
    }
    if (!retainActive) this.activeEvaluation = null;
    if (!retainActive) this.scheduleVariableRefresh();
    const settledCell = this.cellById(job.id);
    this.bump("cell-completed", settledCell === undefined ? { deleted: true } : this.publicCell(settledCell), {
      operationId: job.operationId,
      cellId: job.id,
      runId: job.runId,
      revision: job.revision,
      sequence: Math.max(active.lastSequence, 1),
    });
    // The next serial cell starts in this pump turn. Publish idle when the
    // pump drains, so controls do not flicker between dependent cells.
    this.checkPendingButtonResets(job.runId);
    this.completeRunIfIdle(job.runId);
  }

  private handleEngineEvent(rawEvent: EngineEvent): void {
    const parsed = engineEventSchema.safeParse(rawEvent);
    const active = this.activeEvaluation;
    if (active === null) return;
    if (!parsed.success) {
      active.protocolFailure = new ControllerError(
        "invalid_engine_event",
        "R kernel returned an invalid event",
        503,
        parsed.error.issues,
      );
      return;
    }
    const event = parsed.data;
    const job = active.job;
    if (
      event.sessionEpoch !== this.epochValue
      || event.operationId !== job.operationId
      || event.runId !== job.runId
      || event.cellId !== job.id
      || event.revision !== job.revision
    ) {
      return;
    }
    if (event.type === "started") {
      if (active.requestId !== undefined || event.sequence !== 0) {
        active.protocolFailure = new ControllerError(
          "invalid_engine_sequence",
          "R kernel emitted more than one started event",
          503,
        );
        return;
      }
      active.requestId = event.requestId;
      active.lastSequence = 0;
      this.markRunRunning(job.runId);
      const cell = this.cellById(job.id);
      if (cell !== undefined && cell.revision === job.revision) {
        this.bump("cell-started", this.publicCell(cell), {
          operationId: job.operationId,
          cellId: job.id,
          runId: job.runId,
          revision: job.revision,
          sequence: 0,
        });
      }
      this.emit("runtime", this.runtimeSnapshot(), {
        operationId: job.operationId,
        runId: job.runId,
      });
      if (active.cancelMode !== null && !active.interruptSent) this.signalActiveInterrupt();
      return;
    }
    if (active.requestId !== event.requestId || event.sequence <= active.lastSequence) {
      active.protocolFailure = new ControllerError(
        "invalid_engine_sequence",
        "R kernel event sequence is not strictly increasing",
        503,
      );
      return;
    }
    active.lastSequence = event.sequence;
    if (event.type === "completed") {
      active.completion = event.result;
      return;
    }
    this.applyOutputEvent(event, active);
  }

  private applyOutputEvent(
    event: Extract<EngineEvent, { type: "output" }>,
    active: ActiveEvaluation,
  ): void {
    const cell = this.cellById(active.job.id);
    if (cell === undefined || cell.revision !== active.job.revision) return;
    if (event.kind === "clear") {
      active.streamedOutputs.length = 0;
      cell.outputs = [];
      cell.outputsStale = false;
      cell.progress = null;
      cell.log = [];
    } else if (event.kind === "append") {
      const payload = isRecord(event.payload) && "output" in event.payload
        ? event.payload.output
        : event.payload;
      if (cell.outputsStale) cell.outputs = [];
      cell.outputsStale = false;
      active.streamedOutputs.push(clone(payload));
      cell.outputs.push(clone(payload));
    } else if (event.kind === "progress") {
      cell.progress = isRecord(event.payload) && "progress" in event.payload
        ? clone(event.payload.progress)
        : clone(event.payload);
    } else {
      const value = isRecord(event.payload)
        ? event.payload.lines ?? event.payload.log ?? []
        : event.payload;
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      const prior = isRecord(event.payload) && event.payload.replaceLast === true
        ? cell.log.slice(0, -1)
        : cell.log;
      cell.log = boundedLog([...prior, ...lines]);
    }
    this.bump("cell-output", {
      kind: event.kind,
      payload: clone(event.payload),
    }, {
      operationId: active.job.operationId,
      cellId: active.job.id,
      runId: active.job.runId,
      revision: active.job.revision,
      sequence: event.sequence,
    });
  }

  private commitSuccess(
    job: EvaluationJob,
    response: EngineResponse,
    streamedOutputs: readonly unknown[],
  ): void {
    const cell = this.cellById(job.id);
    if (cell === undefined || cell.revision !== job.revision) return;
    cell.status = response.stopped ? "stopped" : "done";
    cell.outputs = clone(response.outputs ?? [...streamedOutputs]);
    cell.outputsStale = false;
    if (response.log !== undefined) cell.log = completedLog(response.log);
    cell.error = null;
    this.replaceLastActionError(null, {
      operationId: job.operationId,
      runId: job.runId,
    });
  }

  private commitFailure(
    job: EvaluationJob,
    response: EngineResponse,
    dropDescendants: boolean,
  ): void {
    const cell = this.cellById(job.id);
    if (cell === undefined || cell.revision !== job.revision) return;
    const error = response.error ?? { message: "Unknown error" };
    cell.status = "error";
    cell.outputs = [];
    cell.outputsStale = false;
    cell.progress = null;
    cell.error = clone(error);
    cell.log = [
      ...(response.log === undefined ? cell.log : completedLog(response.log)),
      error.interrupted ? "Error: Interrupted" : `Error: ${error.message}`,
    ];
    this.replaceLastActionError(
      hostError("eval_error", error.message, job.operationId),
      { operationId: job.operationId, runId: job.runId },
    );
    if (dropDescendants) this.dropRunDescendants(job.id, job.runId);
    if (cell.analysis?.barrier) {
      this.emitCells(this.invalidateForBarrier(job.id), {
        operationId: job.operationId,
        runId: job.runId,
      });
    }
  }

  private dropRunDescendants(id: string, runId: string): void {
    const descendants = new Set(this.graphValue.descendants(id));
    if (this.activeBatch !== null) this.engine.invalidateBatch?.(descendants);
    this.queue = this.queue.filter(
      (job) => job.runId !== runId || !descendants.has(job.id),
    );
  }

  private cancelRunRegion(
    ids: ReadonlySet<string>,
    mode: "source" | "widget",
  ): Set<string> {
    const changed = new Set<string>();
    this.engine.invalidateBatch?.(ids);
    for (const pending of this.activeBatch?.values() ?? []) {
      if (!ids.has(pending.job.id) || pending.cancelMode !== null) continue;
      pending.cancelMode = mode;
      if (this.markStale(pending.job.id)) changed.add(pending.job.id);
      if (pending.requestId !== undefined && pending.completion === undefined) {
        this.markOperationCancellationRequested(pending.job.operationId);
      }
    }
    const active = this.activeEvaluation;
    if (
      active !== null
      && ids.has(active.job.id)
      && active.cancelMode === null
    ) {
      active.cancelMode = mode;
      if (this.markStale(active.job.id)) changed.add(active.job.id);
      this.markOperationCancellationRequested(active.job.operationId);
      this.signalActiveInterrupt();
    }
    const removedRunIds = new Set<string>();
    this.queue = this.queue.filter((job) => {
      if (!ids.has(job.id)) return true;
      removedRunIds.add(job.runId);
      if (this.markStale(job.id)) changed.add(job.id);
      return false;
    });
    for (const runId of removedRunIds) this.completeRunIfIdle(runId);
    return changed;
  }

  private signalActiveInterrupt(): void {
    const active = this.activeEvaluation;
    if (active === null) return;
    active.queuedCancellation?.abort();
    if (active.interruptSent || active.requestId === undefined) return;
    active.interruptSent = true;
    void this.engine.interrupt(active.requestId).catch((error: unknown) => {
      if (this.activeEvaluation === active) {
        this.failKernel(`R kernel interrupt failed: ${messageOf(error)}`, active.job.id);
      }
    });
  }

  private async interruptActiveRun(): Promise<unknown> {
    this.assertStarted();
    const active = this.activeEvaluation;
    if (active === null || active.cancelMode !== null) {
      throw new ControllerError("no_run_in_progress", "no run in progress", 409);
    }
    active.cancelMode = "stop";
    this.engine.invalidateBatch?.();
    for (const pending of this.activeBatch?.values() ?? []) pending.cancelMode ??= "stop";
    const runId = active.job.runId;
    this.queue = this.queue.filter((job) => job.runId !== runId);
    this.markOperationCancellationRequested(active.job.operationId);
    this.signalActiveInterrupt();
    this.bump("runtime", this.runtimeSnapshot(), {
      operationId: active.job.operationId,
      runId,
    });
    return { runId, requested: true, requestId: active.requestId };
  }

  private async restartEngine(replay: boolean, operationId: string): Promise<unknown> {
    this.assertStarted();
    this.assertNoPackageOperation();
    if (this.engineRestarting) {
      throw new ControllerError("operation_in_progress", "R engine restart is already in progress", 409);
    }
    if (this.runPreparationActive || this.activeEvaluation !== null || this.queue.length > 0) {
      throw new ControllerError("run_in_progress", "cannot restart while a run is active", 409);
    }
    this.engineRestarting = true;
    try {
      const statusChanges = this.invalidateRuntimeView();
      const generation = this.runtimeGeneration;
      this.executionReady = false;
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
      this.emitCells(statusChanges, { operationId });
      let handshake: EngineHandshake;
      try {
        handshake = engineHandshakeSchema.parse(await this.engine.restart());
      } catch (error) {
        if (this.closed) throw new ControllerError("session_stopped", "session is stopped", 409);
        this.kernelAvailable = false;
        throw new ControllerError("worker_unavailable", messageOf(error), 503);
      }
      this.assertRuntimeGeneration(generation, "R runtime changed while restart was pending");
      this.handshake = handshake;
      this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
      this.analyzerAvailable = handshake.analyzerReady;
      if (!this.kernelAvailable || !this.analyzerAvailable) {
        throw new ControllerError("engine_not_ready", "R engine did not become ready", 503);
      }
      this.barrierRestartRequired = false;
      this.clearBeforeEvaluation.clear();
      this.invalidatedDefinitionsByCell.clear();
      await this.ensureCurrentAnalysis();
      this.assertRuntimeGeneration(generation, "R runtime changed while restart analysis was pending");
      this.executionReady = true;
      if (!this.graphValue.resourceLimited) {
        this.replaceLastActionError(null, { operationId });
      }
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
      if (!replay) return { runId: null };
      this.assertGraphRunnable();
      const runId = this.launchRun(this.allCodePlan(), operationId);
      return { runId };
    } finally {
      this.engineRestarting = false;
    }
  }

  private failKernel(message: string, activeCellId?: string): void {
    if (this.closed) return;
    if (!this.kernelAvailable && this.activeEvaluation === null && this.queue.length === 0) return;
    this.runtimeGeneration = nextRevision(this.runtimeGeneration);
    const active = this.activeEvaluation;
    this.kernelAvailable = false;
    this.executionReady = false;
    this.queue = [];
    this.activeEvaluation = null;
    this.activeBatch = null;
    this.interruptedRuns.clear();
    const statusChanges = new Set<string>();
    for (const cell of this.cells) {
      if (cell.type !== "code") continue;
      const before = this.statusOf(cell.id);
      if (cell.id === activeCellId) {
        cell.status = "error";
        cell.outputsStale = cell.outputs.length > 0;
        cell.error = { message, code: "worker_unavailable", transport: true };
        cell.log = boundedLog([...cell.log, `Error: ${message}`]);
      } else {
        cell.status = "stale";
        cell.outputsStale = cell.outputs.length > 0;
      }
      if (cell.id === activeCellId || this.statusOf(cell.id) !== before) {
        statusChanges.add(cell.id);
      }
    }
    for (const operation of this.operations.values()) {
      if (!isTerminal(operation.status) && operationDependsOnRuntime(operation.kind)) {
        this.failOperation(
          operation.id,
          hostError("worker_unavailable", message, operation.id),
        );
      }
    }
    this.lastValue = null;
    this.clearVariables();
    this.pendingInspection = null;
    this.pendingLazyOutputs.clear();
    this.pendingTablePages.clear();
    for (const pending of this.pendingUploads.values()) {
      if (pending.uploadId !== null) void this.removeUpload(pending.uploadId);
    }
    this.pendingUploads.clear();
    this.pendingWidgets.clear();
    this.obsoleteWidgetRequests.clear();
    this.widgetReconciliationRoots.clear();
    this.pendingButtonResets.clear();
    this.activeButtonResets.clear();
    const failure = hostError(
      "worker_unavailable",
      `${message}; outputs are stale. Restart R to replay the notebook`,
    );
    this.bump("runtime", this.runtimeSnapshot(), {
      operationId: active?.job.operationId,
      runId: active?.job.runId,
    });
    this.emitCells(statusChanges, {
      operationId: active?.job.operationId,
      runId: active?.job.runId,
    });
    this.replaceLastActionError(failure, {
      operationId: active?.job.operationId,
      runId: active?.job.runId,
    });
  }

  private handleEngineFailure(role: "kernel" | "analyzer" | "services", error: Error): void {
    if (this.closed) return;
    if (role === "kernel") {
      this.failKernel(error.message, this.activeEvaluation?.job.id);
      return;
    }
    if (role === "services") {
      this.replaceLastActionError(hostError("service_unavailable", error.message));
      return;
    }
    this.analyzerAvailable = false;
    this.executionReady = false;
    this.bump("runtime", this.runtimeSnapshot());
    this.replaceLastActionError(hostError("analysis_unavailable", error.message));
  }

  private invalidateRuntimeView(): Set<string> {
    const changed = new Set<string>();
    this.runtimeGeneration = nextRevision(this.runtimeGeneration);
    this.lastValue = null;
    this.clearVariables();
    for (const pending of this.pendingUploads.values()) {
      if (pending.uploadId !== null) void this.removeUpload(pending.uploadId);
    }
    this.pendingUploads.clear();
    this.pendingButtonResets.clear();
    this.activeButtonResets.clear();
    this.pendingWidgets.clear();
    this.interruptedRuns.clear();
    this.obsoleteWidgetRequests.clear();
    this.widgetReconciliationRoots.clear();
    this.pendingInspection = null;
    this.pendingLazyOutputs.clear();
    this.pendingTablePages.clear();
    for (const cell of this.cells) {
      if (cell.type !== "code") continue;
      const before = this.statusOf(cell.id);
      cell.status = "stale";
      if (this.statusOf(cell.id) !== before) changed.add(cell.id);
    }
    this.refreshValueFreshness();
    for (const operation of this.operations.values()) {
      if (!isTerminal(operation.status)
        && operation.kind !== "restart"
        && operationDependsOnRuntime(operation.kind)) {
        this.failOperation(
          operation.id,
          hostError("worker_unavailable", "R runtime was restarted", operation.id),
        );
      }
    }
    return changed;
  }

  private async releaseLateArtifacts(response: EngineResponse): Promise<void> {
    if (!response.ok || (response.outputs?.length ?? 0) === 0) return;
    const artifacts = collectArtifacts(response.outputs ?? []);
    if (artifacts.length === 0) return;
    try {
      await this.engine.request("release_outputs", { artifacts });
    } catch {
      // The kernel may already be gone. Artifact cleanup is best-effort here.
    }
  }

  private markRunRunning(runId: string): void {
    const operationId = this.runOperationById.get(runId);
    if (operationId === undefined) return;
    const operation = this.operations.get(operationId);
    if (operation === undefined || operation.status === "running" || isTerminal(operation.status)) return;
    operation.status = "running";
    this.rememberOperation(operation);
  }

  private completeRunIfIdle(runId: string): void {
    if (this.activeEvaluation?.job.runId === runId) return;
    if (this.queue.some((job) => job.runId === runId)) return;
    const operationId = this.runOperationById.get(runId);
    if (operationId === undefined) return;
    const operation = this.operations.get(operationId);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.executionDone = true;
    const resets = operation.resetOperationIds ?? [];
    const interruption = this.interruptedRuns.get(runId);
    if (interruption !== undefined) {
      if (resets.some((id) => !isTerminal(this.operations.get(id)?.status ?? "accepted"))) {
        this.rememberOperation(operation);
        return;
      }
      this.interruptedRuns.delete(runId);
      this.causalRunFailures.delete(operationId);
      this.causalWidgetRunParents.delete(operationId);
      operation.status = "cancelled";
      operation.error = hostError(
        interruption.code ?? "interrupted",
        interruption.message,
        operationId,
      );
      operation.settledAt = Date.now();
      this.rememberOperation(operation);
      this.notifyOperationWaiters(operation);
      return;
    }
    const failedReset = resets
      .map((id) => this.operations.get(id))
      .find((candidate) => candidate !== undefined && candidate.status !== "done" && isTerminal(candidate.status));
    if (failedReset !== undefined) {
      const error = failedReset.error;
      this.causalWidgetRunParents.delete(operationId);
      this.causalRunFailures.delete(operationId);
      this.failOperation(
        operationId,
        hostError(
          error?.code ?? "widget_update_failed",
          error?.message ?? "run button reset failed",
          operationId,
          error?.details,
        ),
      );
      return;
    }
    if (resets.some((id) => !isTerminal(this.operations.get(id)?.status ?? "accepted"))) {
      this.rememberOperation(operation);
      return;
    }
    const causalFailure = this.causalRunFailures.get(operationId);
    if (causalFailure !== undefined) {
      this.causalRunFailures.delete(operationId);
      const parentId = this.causalWidgetRunParents.get(operationId);
      this.causalWidgetRunParents.delete(operationId);
      this.failOperation(operationId, causalFailure);
      if (parentId !== undefined) {
        this.causalWidgetFailures.set(parentId, hostError(
          causalFailure.code,
          causalFailure.message,
          parentId,
          causalFailure.details,
        ));
      }
      return;
    }
    this.causalWidgetRunParents.delete(operationId);
    this.completeOperation(operationId, {
      runId,
      ...(operation.kind === "widget" && operation.token !== undefined
        ? { token: operation.token }
        : {}),
    });
  }

  private scheduleAnalysis(): void {
    if (this.analysisRestarting || this.closed) return;
    void this.ensureCurrentAnalysis().catch((error: unknown) => {
      const failure = asControllerError(error, "analysis_unavailable", 503);
      this.replaceLastActionError(failure.toJSON());
    });
  }

  private async ensureCurrentAnalysis(): Promise<void> {
    for (;;) {
      this.assertStarted();
      for (const cell of this.cells) {
        if (cell.type === "code" && (
          cell.analysis === null || cell.analysis.revision !== cell.revision
        )) {
          this.analysisNeeded.add(cell.id);
        }
      }
      if (this.analysisNeeded.size === 0) return;
      if (this.analysisInFlight !== null) {
        await this.analysisInFlight;
        continue;
      }
      const pending = this.cells.filter((cell) => this.analysisNeeded.has(cell.id));
      if (pending.length === 0) {
        this.analysisNeeded.clear();
        return;
      }
      const generation = this.analysisGeneration;
      const promise = this.analyzeBatch(pending, generation);
      this.analysisInFlight = promise;
      try {
        await promise;
      } finally {
        if (this.analysisInFlight === promise) this.analysisInFlight = null;
      }
    }
  }

  private async analyzeBatch(cells: readonly CellRecord[], generation: number): Promise<void> {
    if (!this.analyzerAvailable) {
      throw new ControllerError("analysis_unavailable", "R analyzer is unavailable", 503);
    }
    const submitted = cells.map((cell) => ({
      id: cell.id,
      revision: cell.revision,
      type: cell.type,
      source: joinSource(cell.body),
    }));
    const results = new Map<string, AnalysisCellResult>();
    const uncached: typeof submitted = [];
    for (const snapshot of submitted) {
      const cached = this.analyzerIdentity === ""
        ? undefined
        : this.cachedAnalysis(this.analysisCacheKey(snapshot.type, snapshot.source));
      if (cached === undefined) {
        uncached.push(snapshot);
      } else {
        results.set(snapshot.id, {
          id: snapshot.id,
          revision: snapshot.revision,
          ...clone(cached),
        });
      }
    }

    if (uncached.length > 0) {
      let parsed: ReturnType<typeof analysisResultSchema.parse>;
      try {
        parsed = analysisResultSchema.parse(await this.engine.analyze(uncached, generation));
      } catch (error) {
        this.analyzerAvailable = false;
        throw new ControllerError(
          "analysis_unavailable",
          `dependency analysis failed: ${messageOf(error)}`,
          503,
        );
      }
      if (parsed.revision !== generation) {
        throw new ControllerError(
          "obsolete_analysis",
          "analyzer response did not match the requested source generation",
          503,
        );
      }
      const identity = [
        parsed.analyzer.packageVersion,
        parsed.analyzer.rVersion,
        parsed.analyzer.policy,
      ].join("\0");
      if (this.analyzerIdentity !== "" && this.analyzerIdentity !== identity) {
        this.clearAnalysisCache();
      }
      this.analyzerIdentity = identity;
      if (parsed.cells.length !== uncached.length) {
        throw new ControllerError(
          "invalid_analysis_response",
          "analyzer response omitted or added cells",
          503,
        );
      }
      const expected = new Map(uncached.map((cell) => [cell.id, cell]));
      for (const result of parsed.cells) {
        const source = expected.get(result.id);
        if (source === undefined || results.has(result.id) || result.revision !== source.revision) {
          throw new ControllerError(
            "invalid_analysis_response",
            "analyzer response cell identity did not match the request",
            503,
          );
        }
        results.set(result.id, clone(result));
        this.rememberAnalysis(
          this.analysisCacheKey(source.type, source.source),
          analysisCacheValue(result),
        );
      }
    }

    if (this.closed || generation !== this.analysisGeneration) return;
    const invalidationRoots: string[] = [];
    for (const snapshot of submitted) {
      const cell = this.cellById(snapshot.id);
      const result = results.get(snapshot.id);
      if (
        cell === undefined
        || result === undefined
        || cell.revision !== snapshot.revision
        || cell.type !== snapshot.type
        || joinSource(cell.body) !== snapshot.source
      ) {
        continue;
      }
      cell.analysis = result;
      this.analysisNeeded.delete(cell.id);
      invalidationRoots.push(cell.id);
    }
    this.analyzerAvailable = true;
    const previousGraphState = this.graphValue.state;
    this.graphValue = this.rebuildGraph();
    const statusChanges = new Set<string>();
    for (const changedId of this.invalidateForGraphLimit()) statusChanges.add(changedId);
    for (const root of invalidationRoots) {
      for (const descendant of this.graphValue.descendants(root)) {
        if (this.markStale(descendant)) statusChanges.add(descendant);
      }
      if (this.barrierAnalysisCandidates.has(root)
        && this.cellById(root)?.analysis?.barrier) {
        for (const changedId of this.invalidateForBarrier()) statusChanges.add(changedId);
      }
      this.barrierAnalysisCandidates.delete(root);
    }
    this.refreshValueFreshness();
    this.refreshButtonResets();
    if (this.graphValue.state !== previousGraphState) this.bump("graph", clone(this.graphValue.state));
    this.publishGraphResourceError();
    for (const root of invalidationRoots) {
      const cell = this.cellById(root);
      if (cell === undefined) continue;
      this.emit("diagnostics", clone(this.publicCell(cell).diagnostics), {
        cellId: root,
        revision: cell.revision,
      });
    }
    this.emitCells([...statusChanges, ...invalidationRoots]);
    this.scheduleWidgetReconciliation();
  }

  private analysisCacheKey(type: string, source: string): string {
    return `${this.analyzerIdentity}\0${type}\0${source}`;
  }

  private cachedAnalysis(key: string): AnalysisCacheValue | undefined {
    const value = this.analysisCache.get(key);
    if (value === undefined) return undefined;
    this.analysisCache.delete(key);
    this.analysisCache.set(key, value);
    return value;
  }

  private rememberAnalysis(key: string, value: AnalysisCacheValue): void {
    const prior = this.analysisCache.get(key);
    if (prior !== undefined) {
      this.analysisCache.delete(key);
      this.analysisCacheBytes -= analysisCacheEntryBytes(key, prior);
    }
    const bytes = analysisCacheEntryBytes(key, value);
    if (bytes > MAX_ANALYSIS_CACHE_BYTES) return;
    this.analysisCache.set(key, value);
    this.analysisCacheBytes += bytes;
    while (
      this.analysisCache.size > MAX_ANALYSIS_CACHE_ENTRIES
      || this.analysisCacheBytes > MAX_ANALYSIS_CACHE_BYTES
    ) {
      const oldest = this.analysisCache.entries().next().value as
        | [string, AnalysisCacheValue]
        | undefined;
      if (oldest === undefined) break;
      this.analysisCache.delete(oldest[0]);
      this.analysisCacheBytes -= analysisCacheEntryBytes(oldest[0], oldest[1]);
    }
  }

  private clearAnalysisCache(): void {
    this.analysisCache.clear();
    this.analysisCacheBytes = 0;
  }

  private rebuildGraph(): ReactiveGraph {
    const graphCells: GraphCellInput[] = this.cells.map((cell) => ({
      ...(cell.analysis ?? emptyAnalysis(cell.id, cell.revision)),
      type: cell.type,
      disabled: cell.options.disabled === true,
    }));
    return this.graphValue.update(graphCells);
  }

  private assertGraphRunnable(): void {
    if (this.analysisNeeded.size > 0 || this.cells.some(
      (cell) => cell.type === "code" && cell.analysis === null,
    )) {
      throw new ControllerError(
        "analysis_pending",
        "cannot run until dependency analysis is current",
        409,
      );
    }
    const issues = this.graphValue.validate();
    if (issues.length > 0) {
      throw new ControllerError(
        "graph_invalid",
        issues.map((issue) => issue.message).join("\n"),
        409,
        { issues },
      );
    }
  }

  private invalidateForGraphLimit(): Set<string> {
    const changed = new Set<string>();
    if (!this.graphValue.resourceLimited) return changed;
    const ids = new Set(
      this.cells.filter((cell) => cell.type === "code").map((cell) => cell.id),
    );
    for (const id of this.cancelRunRegion(ids, "source")) changed.add(id);
    for (const id of ids) {
      const cell = this.cellById(id);
      if (cell === undefined) continue;
      const before = this.statusOf(id);
      if (cell.status !== "running") cell.status = "stale";
      if (this.statusOf(id) !== before) changed.add(id);
    }
    this.refreshValueFreshness();
    return changed;
  }

  private invalidateForBarrier(preserveErrorCellId?: string): Set<string> {
    const changed = new Set<string>();
    this.runtimeGeneration = nextRevision(this.runtimeGeneration);
    this.lastValue = null;
    this.clearVariables();
    for (const cell of this.cells) {
      if (cell.type !== "code") continue;
      this.cancelOwnedOperations(cell.id);
      if (cell.id !== preserveErrorCellId && cell.status !== "running") {
        const before = this.statusOf(cell.id);
        cell.status = "stale";
        if (this.statusOf(cell.id) !== before) changed.add(cell.id);
      }
    }
    if (this.pendingInspection !== null) {
      const pending = this.pendingInspection;
      this.pendingInspection = null;
      this.failOperation(
        pending.operationId,
        hostError("stale_value", staleValueMessage(pending.name), pending.operationId),
      );
    }
    this.refreshValueFreshness();
    this.barrierRestartRequired = true;
    return changed;
  }

  private startWidgetOperation(
    command: Extract<HostCommand, { type: "widget" }>,
  ): unknown {
    this.assertExecutionPossible();
    const location = this.findWidget(command.name);
    if (location === null) {
      throw new ControllerError("invalid_request", `no such widget: ${command.name}`, 400);
    }
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("widget_not_current", `widget ${command.name} is not current`, 409);
    }
    // Source edits make the owning cell stale synchronously, while dependency
    // analysis completes in the background. Report the invalid widget identity
    // before the broader graph readiness error so clients can discard it.
    this.assertGraphRunnable();
    const spec = isRecord(location.widget.spec) ? location.widget.spec : null;
    let target = spec === null ? null : widgetSpecAt(spec, command.path);
    if (target === null) {
      throw new ControllerError("invalid_request", "widget path does not exist", 400);
    }
    if (target.kind === "form" && command.update.submit !== true && isRecord(target.child)) {
      target = target.child;
    }
    const kind = String(target.kind ?? "");
    const update = validateWidgetUpdate(kind, command.update);
    const draft = widgetPathHasForm(spec ?? {}, command.path) && command.update.submit !== true;
    const key = widgetKey(command.name, command.path);
    const reservedUpload = [...this.pendingUploads.entries()].find(
      ([, pending]) => pending.key === key,
    );
    if (this.pendingWidgets.has(key)
      || (reservedUpload !== undefined && reservedUpload[0] !== command.operationId)) {
      throw new ControllerError(
        "operation_in_progress",
        `widget ${command.name} already has a pending update`,
        409,
      );
    }
    this.pendingWidgets.set(key, command.operationId);
    this.widgetToken += 1;
    const operation = this.operations.get(command.operationId);
    if (operation !== undefined) {
      operation.status = "running";
      operation.token = this.widgetToken;
      operation.cellIds = [owner.id];
      this.rememberOperation(operation);
    }
    setWidgetOperation(location.widget, key, {
      token: this.widgetToken,
      draft,
      operationId: command.operationId,
      status: "pending",
      error: null,
    });
    this.bump("cell", this.publicCell(owner), {
      operationId: command.operationId,
      cellId: owner.id,
      revision: owner.revision,
    });
    const identity = {
      owner: owner.id,
      revision: owner.revision,
      widget: location.widget,
      kind,
      key,
      token: this.widgetToken,
      draft,
      generation: this.runtimeGeneration,
    };
    void this.engine.request("set_widget", {
      name: command.name,
      path: [...command.path],
      op_id: identity.token,
      ...update,
    }).then(
      (response) => this.finishWidgetOperation(command, identity, response, update),
      (error: unknown) => this.failWidgetOperation(command, identity, "worker_unavailable", messageOf(error)),
    );
    return { token: identity.token, owner: owner.id };
  }

  private finishWidgetOperation(
    command: Extract<HostCommand, { type: "widget" }>,
    identity: {
      owner: string;
      revision: number;
      widget: Record<string, unknown>;
      kind: string;
      key: string;
      token: number;
      draft: boolean;
      generation: number;
    },
    rawResponse: EngineResponse,
    update: Record<string, unknown>,
  ): void {
    const reconciliationOwner = this.obsoleteWidgetRequests.get(command.operationId);
    this.obsoleteWidgetRequests.delete(command.operationId);
    if (this.closed || identity.generation !== this.runtimeGeneration) return;
    let response: EngineResponse;
    try {
      response = engineResponseSchema.parse(rawResponse);
    } catch (error) {
      this.failKernel(`invalid widget response: ${messageOf(error)}`);
      return;
    }
    if (reconciliationOwner !== undefined) {
      // The update was already submitted to the serialized kernel before its
      // owner changed. A successful obsolete request mutated live R state, so
      // replay the owner's current source after that request settles. Failed
      // requests made no state change and must not turn a source edit into an
      // evaluation.
      if (response.ok) this.queueWidgetReconciliation(reconciliationOwner);
      return;
    }
    const current = this.findWidget(command.name);
    const owner = this.cellById(identity.owner);
    if (
      this.pendingWidgets.get(identity.key) !== command.operationId
      || current === null
      || current.owner !== identity.owner
      || owner === undefined
      || owner.revision !== identity.revision
      || current.widget !== identity.widget
    ) {
      return;
    }
    if (!response.ok) {
      this.failWidgetOperation(
        command,
        identity,
        response.error?.transport ? "worker_unavailable" : "widget_update_failed",
        response.error?.message ?? "widget update failed",
      );
      return;
    }
    const selected = isRecord(response.selected)
      ? response.selected
      : update;
    if (isRecord(identity.widget.spec)) {
      identity.widget.spec = patchWidgetSpec(
        identity.widget.spec,
        command.path,
        selected,
        identity.kind,
        update,
      );
    }
    setWidgetOperation(identity.widget, identity.key, {
      token: identity.token,
      operationId: command.operationId,
      status: "done",
      error: null,
    });
    this.pendingWidgets.delete(identity.key);
    this.pendingUploads.delete(command.operationId);
    this.scheduleVariableRefresh();
    this.bump("cell", this.publicCell(owner), {
      operationId: command.operationId,
      cellId: owner.id,
      revision: owner.revision,
    });
    if (identity.draft) {
      this.completeOperation(command.operationId, { token: identity.token, draft: true });
    } else if (identity.kind === "run_button" && update.value === true) {
      this.scheduleRunButton(command, identity.owner, identity.revision, identity.widget);
    } else {
      const scheduled = this.scheduleWidgetConsumers(
        command.name,
        identity.owner,
        command.source,
        command.operationId,
      );
      if (!scheduled) this.completeOperation(command.operationId, { token: identity.token });
    }
  }

  private failWidgetOperation(
    command: Extract<HostCommand, { type: "widget" }>,
    identity: {
      owner: string;
      key: string;
      token: number;
      widget: Record<string, unknown>;
      generation: number;
    },
    code: string,
    message: string,
  ): void {
    if (this.obsoleteWidgetRequests.delete(command.operationId)) return;
    if (this.closed || identity.generation !== this.runtimeGeneration) return;
    if (this.pendingWidgets.get(identity.key) !== command.operationId) return;
    this.pendingWidgets.delete(identity.key);
    this.discardUpload(command.operationId);
    setWidgetOperation(identity.widget, identity.key, {
      token: identity.token,
      operationId: command.operationId,
      status: "error",
      error: { code, message },
    });
    const failure = hostError(code, message, command.operationId);
    this.replaceLastActionError(failure, {
      operationId: command.operationId,
      cellId: identity.owner,
    });
    this.failOperation(command.operationId, failure);
    const owner = this.cellById(identity.owner);
    if (owner !== undefined) {
      this.bump("cell", this.publicCell(owner), {
        operationId: command.operationId,
        cellId: owner.id,
        revision: owner.revision,
      });
    }
  }

  private scheduleWidgetConsumers(
    name: string,
    owner: string,
    source: "editor" | "app" | "mcp" | "cli",
    operationId: string,
  ): boolean {
    const references = this.cellsReferencing(name, owner);
    if (references.length === 0) return false;
    if (source === "app" || this.executionMode === "automatic") {
      const region = new Set(references);
      for (const reference of references) {
        for (const descendant of this.graphValue.descendants(reference)) region.add(descendant);
      }
      const statusChanges = this.cancelRunRegion(region, "widget");
      this.emitCells(statusChanges, { operationId });
      try {
        const plan = this.widgetClosure(references, owner);
        const runId = this.launchRun(plan, operationId, true);
        if (!this.runHasPendingJobs(runId)) this.completeRunIfIdle(runId);
      } catch (error) {
        this.failOperation(operationId, asControllerError(error).toJSON(operationId));
      }
      return true;
    } else {
      const stale = new Set<string>();
      for (const reference of references) {
        stale.add(reference);
        for (const descendant of this.graphValue.descendants(reference)) stale.add(descendant);
      }
      const changed: string[] = [];
      for (const id of this.graphValue.orderOf(stale)) {
        const before = this.statusOf(id);
        this.markStale(id);
        const cell = this.cellById(id);
        if (cell !== undefined && this.statusOf(id) !== before) {
          changed.push(id);
          this.emit("cell", this.publicCell(cell), { cellId: id, revision: cell.revision });
        }
      }
      this.bump("notebook", { stale: changed });
      return false;
    }
  }

  private scheduleRunButton(
    command: Extract<HostCommand, { type: "widget" }>,
    owner: string,
    revision: number,
    widget: Record<string, unknown>,
  ): void {
    const directConsumers = this.cellsReferencing(command.name, owner);
    const key = widgetKey(command.name, command.path);
    if (directConsumers.length === 0) {
      this.sendButtonReset({
        key,
        name: command.name,
        path: [...command.path],
        owner,
        revision,
        widget,
        triggerOperationId: command.operationId,
        directConsumers,
        runId: null,
      });
      return;
    }
    let runId: string | null = null;
    if (command.source === "app" || this.executionMode === "automatic") {
      const region = new Set(directConsumers);
      for (const reference of directConsumers) {
        for (const descendant of this.graphValue.descendants(reference)) region.add(descendant);
      }
      const statusChanges = this.cancelRunRegion(region, "widget");
      this.emitCells(statusChanges, { operationId: command.operationId });
      const runOperationId = `run-button-${command.operationId}`;
      this.createOperation(runOperationId, "run");
      this.causalWidgetRunParents.set(runOperationId, command.operationId);
      try {
        runId = this.launchRun(
          this.widgetClosure(directConsumers, owner),
          runOperationId,
          true,
        );
      } catch (error) {
        this.causalWidgetRunParents.delete(runOperationId);
        this.failOperation(runOperationId, asControllerError(error).toJSON(runOperationId));
        this.failOperation(
          command.operationId,
          hostError("widget_update_failed", "run button could not schedule consumers", command.operationId),
        );
        return;
      }
    } else {
      const stale = new Set<string>();
      for (const reference of directConsumers) {
        stale.add(reference);
        for (const descendant of this.graphValue.descendants(reference)) stale.add(descendant);
      }
      const changed: string[] = [];
      for (const id of this.graphValue.orderOf(stale)) {
        const before = this.statusOf(id);
        this.markStale(id);
        const cell = this.cellById(id);
        if (cell !== undefined && this.statusOf(id) !== before) {
          changed.push(id);
          this.emit("cell", this.publicCell(cell), { cellId: id, revision: cell.revision });
        }
      }
      this.bump("notebook", { stale: changed });
    }
    this.pendingButtonResets.set(key, {
      key,
      name: command.name,
      path: [...command.path],
      owner,
      revision,
      widget,
      triggerOperationId: command.operationId,
      directConsumers,
      runId,
    });
    if (runId !== null && !this.runHasPendingJobs(runId)) {
      this.checkPendingButtonResets(runId);
      this.completeRunIfIdle(runId);
    }
  }

  private checkPendingButtonResets(completedRunId: string): void {
    for (const reset of [...this.pendingButtonResets.values()]) {
      if (reset.runId !== null) {
        if (reset.runId !== completedRunId || this.runHasPendingJobs(reset.runId)) continue;
      } else {
        const settled = reset.directConsumers.every((id) =>
          ["done", "error", "stopped"].includes(this.statusOf(id)),
        );
        if (!settled) continue;
      }
      this.pendingButtonResets.delete(reset.key);
      this.sendButtonReset(reset.runId === null
        ? { ...reset, runId: completedRunId }
        : reset);
    }
  }

  private refreshButtonResets(): void {
    for (const [key, reset] of [...this.pendingButtonResets]) {
      const location = this.findWidget(reset.name);
      const owner = this.cellById(reset.owner);
      if (location === null
        || location.owner !== reset.owner
        || location.widget !== reset.widget
        || owner === undefined
        || owner.revision !== reset.revision) {
        this.pendingButtonResets.delete(key);
        this.failButtonResetParents(reset, "widget_not_current", "run button is no longer current");
        continue;
      }
      const directConsumers = this.cellsReferencing(reset.name, reset.owner);
      if (directConsumers.length === 0) {
        this.pendingButtonResets.delete(key);
        this.sendButtonReset({ ...reset, directConsumers });
      } else {
        reset.directConsumers = directConsumers;
      }
    }
  }

  private sendButtonReset(reset: PendingButtonReset): void {
    const location = this.findWidget(reset.name);
    const owner = this.cellById(reset.owner);
    const target = location !== null && isRecord(location.widget.spec)
      ? widgetSpecAt(location.widget.spec, reset.path)
      : null;
    if (location === null
      || location.owner !== reset.owner
      || location.widget !== reset.widget
      || owner === undefined
      || owner.revision !== reset.revision
      || this.statusOf(owner.id) !== "done"
      || target?.kind !== "run_button") {
      this.failButtonResetParents(reset, "widget_not_current", "run button is no longer current");
      return;
    }
    const resetOperationId = `${reset.triggerOperationId}:reset:${randomUUID()}`;
    const resetOperation = this.createOperation(resetOperationId, "widget-reset");
    resetOperation.status = "running";
    resetOperation.cellIds = [reset.owner];
    this.rememberOperation(resetOperation);
    const triggerOperation = this.operations.get(reset.triggerOperationId);
    if (triggerOperation !== undefined && !isTerminal(triggerOperation.status)) {
      triggerOperation.resetOperationIds = uniqueStrings([
        ...(triggerOperation.resetOperationIds ?? []),
        resetOperationId,
      ]);
      this.rememberOperation(triggerOperation);
    }
    const runOperationId = reset.runId === null
      ? undefined
      : this.runOperationById.get(reset.runId);
    if (runOperationId !== undefined) {
      const runOperation = this.operations.get(runOperationId);
      if (runOperation !== undefined && !isTerminal(runOperation.status)) {
        runOperation.resetOperationIds = uniqueStrings([
          ...(runOperation.resetOperationIds ?? []),
          resetOperationId,
        ]);
        this.rememberOperation(runOperation);
      }
    }
    const token = ++this.widgetToken;
    const generation = this.runtimeGeneration;
    this.pendingWidgets.set(reset.key, resetOperationId);
    this.activeButtonResets.set(resetOperationId, {
      operationId: resetOperationId,
      token,
      reset,
    });
    setWidgetOperation(reset.widget, reset.key, {
      token,
      operationId: resetOperationId,
      status: "pending",
      error: null,
    });
    this.bump("cell", this.publicCell(owner), {
      operationId: resetOperationId,
      cellId: owner.id,
      revision: owner.revision,
    });
    void this.engine.request("set_widget", {
      name: reset.name,
      path: [...reset.path],
      value: false,
      op_id: token,
    }).then((raw) => {
      if (!this.runtimeRequestCurrent(resetOperationId, generation)) return;
      const response = engineResponseSchema.parse(raw);
      if (!response.ok) {
        throw new ControllerError(
          response.error?.transport ? "worker_unavailable" : "widget_update_failed",
          response.error?.message ?? "button reset failed",
          response.error?.transport ? 503 : 400,
        );
      }
      const current = this.findWidget(reset.name);
      const currentOwner = this.cellById(reset.owner);
      if (this.pendingWidgets.get(reset.key) !== resetOperationId
        || this.activeButtonResets.get(resetOperationId)?.token !== token
        || current === null
        || current.owner !== reset.owner
        || current.widget !== reset.widget
        || currentOwner === undefined
        || currentOwner.revision !== reset.revision
        || this.statusOf(currentOwner.id) !== "done") {
        throw new ControllerError("widget_not_current", "run button is no longer current", 409);
      }
      if (isRecord(reset.widget.spec)) {
        reset.widget.spec = patchWidgetSpec(
          reset.widget.spec,
          reset.path,
          { value: false },
          "run_button",
          { value: false },
        );
      }
      setWidgetOperation(reset.widget, reset.key, {
        token,
        operationId: resetOperationId,
        status: "done",
        error: null,
      });
      this.pendingWidgets.delete(reset.key);
      this.activeButtonResets.delete(resetOperationId);
      this.scheduleVariableRefresh();
      this.completeOperation(resetOperationId, { token });
      const causalFailure = this.causalWidgetFailures.get(reset.triggerOperationId);
      this.causalWidgetFailures.delete(reset.triggerOperationId);
      if (causalFailure === undefined) {
        this.completeOperation(reset.triggerOperationId, {
          token: this.operations.get(reset.triggerOperationId)?.token,
          resetOperationId,
        });
      } else {
        this.failOperation(reset.triggerOperationId, causalFailure);
      }
      if (reset.runId !== null) this.completeRunIfIdle(reset.runId);
      this.bump("cell", this.publicCell(currentOwner), {
        operationId: resetOperationId,
        cellId: currentOwner.id,
        revision: currentOwner.revision,
      });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(resetOperationId, generation)) return;
      const failure = asControllerError(error, "widget_update_failed", 400);
      this.pendingWidgets.delete(reset.key);
      this.activeButtonResets.delete(resetOperationId);
      setWidgetOperation(reset.widget, reset.key, {
        token,
        operationId: resetOperationId,
        status: "error",
        error: { code: failure.code, message: failure.message },
      });
      this.failOperation(
        resetOperationId,
        hostError(failure.code, failure.message, resetOperationId),
      );
      this.failButtonResetParents(reset, failure.code, failure.message);
      if (reset.runId !== null) this.completeRunIfIdle(reset.runId);
      const currentOwner = this.cellById(reset.owner);
      if (currentOwner !== undefined
        && currentOwner.revision === reset.revision
        && this.findWidget(reset.name)?.widget === reset.widget) {
        this.bump("cell", this.publicCell(currentOwner), {
          operationId: resetOperationId,
          cellId: currentOwner.id,
          revision: currentOwner.revision,
        });
      }
    });
  }

  private failButtonResetParents(
    reset: PendingButtonReset,
    code: string,
    message: string,
  ): void {
    this.causalWidgetFailures.delete(reset.triggerOperationId);
    this.failOperation(
      reset.triggerOperationId,
      hostError(code, message, reset.triggerOperationId),
    );
    if (reset.runId === null) return;
    const runOperationId = this.runOperationById.get(reset.runId);
    if (runOperationId !== undefined) {
      this.causalWidgetRunParents.delete(runOperationId);
      this.causalRunFailures.delete(runOperationId);
      this.failOperation(runOperationId, hostError(code, message, runOperationId));
    }
  }

  private cellsReferencing(name: string, exclude?: string): string[] {
    return this.cells.filter((cell) =>
      cell.id !== exclude
      && cell.analysis !== null
      && [...cell.analysis.refs, ...cell.analysis.selfRefs].includes(name),
    ).map((cell) => cell.id);
  }

  private widgetClosure(roots: readonly string[], owner: string): string[] {
    const plan = new Set(roots);
    for (;;) {
      const before = plan.size;
      for (const id of [...plan]) {
        for (const descendant of this.graphValue.descendants(id)) plan.add(descendant);
      }
      for (const id of [...plan]) {
        for (const ancestor of this.graphValue.ancestors(id)) {
          if (["idle", "stale", "error", "stopped"].includes(this.statusOf(ancestor))) {
            plan.add(ancestor);
          }
        }
      }
      if (plan.size === before) break;
    }
    plan.delete(owner);
    return this.graphValue.orderOf(plan);
  }

  private queueWidgetReconciliation(owner: string): void {
    const cell = this.cellById(owner);
    if (cell === undefined) return;
    this.widgetReconciliationRoots.set(owner, cell.revision);
    this.scheduleWidgetReconciliation();
  }

  private scheduleWidgetReconciliation(): void {
    if (
      this.closed
      || this.widgetReconciliationRoots.size === 0
      || this.widgetReconciliationScheduled
      || this.widgetReconciliationPreparing
      || this.activeEvaluation !== null
      || this.queue.length > 0
      || this.runPreparationActive
      || this.packageOperationActive
    ) return;
    this.widgetReconciliationScheduled = true;
    queueMicrotask(() => {
      this.widgetReconciliationScheduled = false;
      void this.startWidgetReconciliation();
    });
  }

  private async startWidgetReconciliation(): Promise<void> {
    if (
      this.closed
      || this.widgetReconciliationPreparing
      || this.widgetReconciliationRoots.size === 0
      || this.activeEvaluation !== null
      || this.queue.length > 0
      || this.runPreparationActive
      || this.packageOperationActive
    ) return;
    this.widgetReconciliationPreparing = true;
    try {
      await this.ensureCurrentAnalysis();
      if (
        this.closed
        || this.activeEvaluation !== null
        || this.queue.length > 0
        || this.runPreparationActive
        || this.packageOperationActive
      ) return;

      const roots = [...this.widgetReconciliationRoots].filter(([id, revision]) => {
        const cell = this.cellById(id);
        return cell?.type === "code" && cell.revision === revision;
      });
      for (const [id] of [...this.widgetReconciliationRoots]) {
        if (!roots.some(([root]) => root === id)) this.widgetReconciliationRoots.delete(id);
      }
      if (roots.length === 0) return;

      this.assertGraphRunnable();
      const plan = new Set<string>();
      for (const [id] of roots) {
        for (const candidate of this.planCellRun(id, "app")) plan.add(candidate);
      }
      const operationId = `widget-reconcile-${randomUUID()}`;
      this.createOperation(operationId, "run");
      const runId = this.launchRun(this.graphValue.orderOf(plan), operationId);
      const scheduled = new Set(this.operations.get(operationId)?.cellIds ?? []);
      for (const [id, revision] of roots) {
        if (!scheduled.has(id) && this.widgetReconciliationRoots.get(id) === revision) {
          this.widgetReconciliationRoots.delete(id);
        }
      }
      if (!this.runHasPendingJobs(runId)) this.completeRunIfIdle(runId);
    } catch (error) {
      const failure = asControllerError(error);
      this.replaceLastActionError(failure.toJSON());
      // A graph or analyzer failure cannot be repaired by repeatedly launching
      // the same hidden run. The source remains visibly stale and a later user
      // run retains the queued clear_cell protection.
      this.widgetReconciliationRoots.clear();
    } finally {
      this.widgetReconciliationPreparing = false;
    }
  }

  private runHasPendingJobs(runId: string): boolean {
    return this.activeEvaluation?.job.runId === runId
      || this.queue.some((job) => job.runId === runId);
  }

  private startInspection(operationId: string, name: string): unknown {
    this.assertStarted();
    if (this.barrierRestartRequired) {
      throw new ControllerError(
        "stale_value",
        "values are not current until the R runtime restarts",
        409,
      );
    }
    const ownerId = this.graphValue.definitionOwner(name);
    const owner = ownerId === undefined ? undefined : this.cellById(ownerId);
    if ((owner !== undefined && this.statusOf(owner.id) !== "done")
      || this.definitionIsInvalidated(name)) {
      throw new ControllerError("stale_value", staleValueMessage(name), 409);
    }
    if (owner === undefined && this.analysisNeeded.size > 0) {
      throw new ControllerError(
        "analysis_pending",
        "cannot inspect an unowned value until dependency analysis is current",
        409,
      );
    }
    this.assertExecutionPossible();
    if (this.pendingInspection !== null
      && this.runtimeRequestCurrent(
        this.pendingInspection.operationId,
        this.runtimeGeneration,
      )) {
      throw new ControllerError(
        "operation_in_progress",
        "a value request is already pending",
        409,
      );
    }
    const operation = this.operations.get(operationId);
    if (operation !== undefined) {
      operation.status = "running";
      operation.cellIds = owner === undefined ? [] : [owner.id];
      this.rememberOperation(operation);
    }
    const identity = owner === undefined
      ? null
      : { id: owner.id, revision: owner.revision };
    this.pendingInspection = {
      operationId,
      name,
      owner: identity?.id ?? null,
      revision: identity?.revision ?? null,
    };
    const generation = this.runtimeGeneration;
    void this.engine.request("get_value", { name, token: operationId }).then((raw) => {
      if (!this.runtimeRequestCurrent(operationId, generation)) return;
      const response = engineResponseSchema.parse(raw);
      const currentOwner = this.graphValue.definitionOwner(name);
      const fresh = identity === null
        ? currentOwner === undefined
        : currentOwner === identity.id
          && this.cellById(identity.id)?.revision === identity.revision
          && this.statusOf(identity.id) === "done";
      if (!fresh) throw new ControllerError("stale_value", staleValueMessage(name), 409);
      if (!response.ok) {
        throw new ControllerError(
          response.error?.transport ? "worker_unavailable" : "value_request_failed",
          response.error?.message ?? "value request failed",
          response.error?.transport ? 503 : 400,
        );
      }
      this.lastValue = {
        operationId,
        name,
        value: clone(response.value),
        owner: identity?.id ?? null,
        revision: identity?.revision ?? null,
      };
      this.pendingInspection = null;
      this.completeOperation(operationId, this.lastValue);
      this.bump("notebook", { lastValue: clone(this.lastValue) }, { operationId });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(operationId, generation)) return;
      this.pendingInspection = null;
      const failure = asControllerError(error, "value_request_failed");
      this.failOperation(operationId, failure.toJSON(operationId));
    });
    return { name, owner: owner?.id ?? null, revision: owner?.revision ?? null };
  }

  private startLazyOutput(operationId: string, key: string): unknown {
    this.assertExecutionPossible();
    if (this.pendingLazyOutputs.has(key)) {
      throw new ControllerError(
        "operation_in_progress",
        "lazy output already has a pending evaluation",
        409,
      );
    }
    const location = this.findOutput((output) => output.kind === "lazy" && output.key === key);
    if (location === null) {
      throw new ControllerError(
        "lazy_expired",
        "this lazy output belongs to an earlier run of the cell",
        409,
      );
    }
    const operation = this.operations.get(operationId);
    if (operation !== undefined) {
      operation.status = "running";
      operation.cellIds = [location.owner];
      this.rememberOperation(operation);
    }
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("lazy_expired", "lazy output is no longer current", 409);
    }
    const revision = owner.revision;
    const original = location.output;
    const generation = this.runtimeGeneration;
    this.pendingLazyOutputs.set(key, { operationId, owner: owner.id });
    void this.engine.request("lazy_eval", {
      key,
      id: owner.id,
      token: operationId,
    }).then((raw) => {
      if (!this.runtimeRequestCurrent(operationId, generation)) return;
      const response = engineResponseSchema.parse(raw);
      const current = this.findOutput((output) => output.kind === "lazy" && output.key === key);
      if (
        current === null
        || current.owner !== owner.id
        || current.output !== original
        || this.cellById(owner.id)?.revision !== revision
        || this.statusOf(owner.id) !== "done"
      ) {
        throw new ControllerError("lazy_expired", "lazy output is no longer current", 409);
      }
      owner.log = boundedLog([...owner.log, ...(response.log ?? [])]);
      if (!response.ok) {
        original.state = "error";
        original.child = {
          kind: "error",
          message: response.error?.message ?? "lazy output failed",
        };
        this.bump("cell", this.publicCell(owner), {
          operationId,
          cellId: owner.id,
          revision,
        });
        throw new ControllerError(
          response.error?.transport ? "worker_unavailable" : "lazy_eval_failed",
          response.error?.message ?? "lazy output failed",
          response.error?.transport ? 503 : 400,
        );
      }
      original.child = clone(response.output ?? response.value ?? null);
      original.state = "loaded";
      this.pendingLazyOutputs.delete(key);
      this.scheduleVariableRefresh();
      this.completeOperation(operationId, { key, output: clone(original.child) });
      this.bump("cell", this.publicCell(owner), {
        operationId,
        cellId: owner.id,
        revision,
      });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(operationId, generation)) return;
      this.pendingLazyOutputs.delete(key);
      this.scheduleVariableRefresh();
      this.failOperation(operationId, asControllerError(error, "lazy_eval_failed").toJSON(operationId));
    });
    return { key, cellId: owner.id };
  }

  private startTablePage(
    command: Extract<HostCommand, { type: "table-page" }>,
  ): unknown {
    this.assertExecutionPossible();
    if (this.pendingTablePages.has(command.handle)) {
      throw new ControllerError(
        "operation_in_progress",
        "table paging request already pending",
        409,
      );
    }
    const location = this.findOutput(
      (output) => output.kind === "table" && output.handle === command.handle,
    );
    if (location === null) {
      throw new ControllerError("table_unavailable", "table is unavailable", 404);
    }
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("table_unavailable", "table is no longer current", 409);
    }
    const revision = owner.revision;
    const original = location.output;
    const generation = this.runtimeGeneration;
    this.pendingTablePages.set(command.handle, {
      operationId: command.operationId,
      owner: owner.id,
    });
    const operation = this.operations.get(command.operationId);
    if (operation !== undefined) {
      operation.status = "running";
      operation.cellIds = [owner.id];
      this.rememberOperation(operation);
    }
    void this.engine.request("table_page", {
      handle: command.handle,
      offset: command.offset,
      limit: command.limit,
      sort_by: command.sortBy,
      sort_desc: command.sortDescending,
      filter: command.filter,
      token: command.operationId,
    }).then((raw) => {
      if (!this.runtimeRequestCurrent(command.operationId, generation)) return;
      const response = engineResponseSchema.parse(raw);
      const current = this.findOutput(
        (output) => output.kind === "table" && output.handle === command.handle,
      );
      if (
        current === null
        || current.owner !== owner.id
        || current.output !== original
        || this.cellById(owner.id)?.revision !== revision
        || this.statusOf(owner.id) !== "done"
      ) {
        throw new ControllerError("table_unavailable", "table is no longer current", 409);
      }
      if (!response.ok) {
        throw new ControllerError(
          response.error?.transport ? "worker_unavailable" : "table_request_failed",
          response.error?.message ?? "table page failed",
          response.error?.transport ? 503 : 400,
        );
      }
      original.page = clone(response.page ?? response.value ?? null);
      this.pendingTablePages.delete(command.handle);
      this.completeOperation(command.operationId, {
        handle: command.handle,
        page: clone(original.page),
      });
      this.bump("cell", this.publicCell(owner), {
        operationId: command.operationId,
        cellId: owner.id,
        revision,
      });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(command.operationId, generation)) return;
      this.pendingTablePages.delete(command.handle);
      this.failOperation(
        command.operationId,
        asControllerError(error, "table_request_failed").toJSON(command.operationId),
      );
    });
    return { handle: command.handle, cellId: owner.id };
  }

  private async saveNotebook(): Promise<unknown> {
    this.assertStartedForMutation();
    if (this.services.save === undefined) {
      throw new ControllerError("service_unavailable", "notebook save service is unavailable", 503);
    }
    if (this.pathValue === null || this.pathValue.length === 0) {
      throw new ControllerError("notebook_has_no_path", "notebook has no path", 400);
    }
    const savedVersion = this.version;
    const result = await this.services.save(this.snapshot());
    this.assertNotClosed();
    if (this.version === savedVersion) this.changed = false;
    this.replaceLastActionError(null);
    this.bump("notebook", { saved: true, result: clone(result) });
    return result;
  }

  private async formatSource(
    requestedIds: readonly string[] | undefined,
    expectedRevisions: Readonly<Record<string, number>>,
    operationId: string,
  ): Promise<unknown> {
    this.assertStartedForMutation();
    if (this.services.format === undefined) {
      throw new ControllerError("service_unavailable", "source formatter is unavailable", 503);
    }
    const ids = requestedIds === undefined ? this.cells.map((cell) => cell.id) : [...requestedIds];
    if (new Set(ids).size !== ids.length || !setEqual(new Set(ids), new Set(Object.keys(expectedRevisions)))) {
      throw new ControllerError(
        "invalid_request",
        "expectedRevisions must name every selected cell exactly once",
        400,
      );
    }
    for (const id of ids) {
      const cell = this.cellById(id);
      if (cell === undefined) throw new ControllerError("not_found", `no such cell: ${id}`, 404);
      if (cell.revision !== expectedRevisions[id]) {
        throw new ControllerError("source_conflict", `cell ${id} changed on the server`, 409);
      }
    }
    const formatted = await this.services.format(ids.map((id) => {
      const cell = this.requireCell(id);
      return { id: cell.id, type: cell.type, body: [...cell.body], revision: cell.revision };
    }));
    this.assertNotClosed();
    if (!isRecord(formatted)
      || !setEqual(new Set(Object.keys(formatted)), new Set(ids))) {
      throw new ControllerError(
        "invalid_service_response",
        "formatter must return every selected cell exactly once",
        503,
      );
    }
    const edits: CellEdit[] = [];
    for (const id of Object.keys(formatted)) {
      const cell = this.requireCell(id);
      if (cell.revision !== expectedRevisions[id]) {
        throw new ControllerError("source_conflict", `cell ${id} changed while formatting`, 409);
      }
      const parsed = cellEditSchema.safeParse({
        cellId: id,
        body: formatted[id],
        cellType: cell.type,
        expectedRevision: cell.revision,
      });
      if (!parsed.success) {
        throw new ControllerError(
          "invalid_service_response",
          "formatter returned invalid physical source lines",
          503,
          parsed.error.issues,
        );
      }
      edits.push(parsed.data);
    }
    const result = await this.applySourceChanges(edits, [], false, operationId);
    return { changed: result.edited.filter((entry) => entry.revision !== expectedRevisions[entry.id]).length, ...result };
  }

  private setRuntime(
    executionMode: "automatic" | "lazy" | undefined,
    runOnStartup: boolean | undefined,
  ): unknown {
    this.assertStartedForMutation();
    if (executionMode !== undefined) this.executionMode = executionMode;
    if (runOnStartup !== undefined) this.runOnStartup = runOnStartup;
    this.metadata = {
      ...this.metadata,
      runtime: {
        ...(isRecord(this.metadata.runtime) ? this.metadata.runtime : {}),
        execution_mode: this.executionMode,
        run_on_startup: this.runOnStartup,
      },
    };
    this.config = {
      ...this.config,
      on_cell_change: this.executionMode,
      on_startup: this.runOnStartup,
    };
    this.changed = true;
    this.bump("notebook", { metadata: clone(this.metadata) });
    this.emit("runtime", this.runtimeSnapshot());
    return clone(this.runtimeSnapshot());
  }

  private async setConfig(patch: Record<string, unknown>): Promise<unknown> {
    this.assertStartedForMutation();
    if (this.services.service === undefined) {
      throw new ControllerError("service_unavailable", "config update service is unavailable", 503);
    }
    return this.withServiceMutation(async () => {
      const proposed = deepMerge(this.config, patch);
      const response = await this.services.service?.("config.update", { config: proposed });
      this.assertNotClosed();
      if (!isRecord(response) || !isRecord(response.config)) {
        throw new ControllerError("invalid_service_response", "config service returned invalid data", 503);
      }
      const mode = response.config.on_cell_change;
      const startup = response.config.on_startup;
      if (mode !== undefined && mode !== "automatic" && mode !== "lazy") {
        throw new ControllerError("invalid_service_response", "config service returned an invalid execution mode", 503);
      }
      if (startup !== undefined && typeof startup !== "boolean") {
        throw new ControllerError("invalid_service_response", "config service returned an invalid startup policy", 503);
      }
      const runtimeChanged = mode !== undefined || startup !== undefined;
      if (mode !== undefined) this.executionMode = mode;
      if (startup !== undefined) this.runOnStartup = startup;
      if (runtimeChanged) {
        this.metadata = {
          ...this.metadata,
          runtime: {
            ...(isRecord(this.metadata.runtime) ? this.metadata.runtime : {}),
            execution_mode: this.executionMode,
            run_on_startup: this.runOnStartup,
          },
        };
      }
      this.config = clone(response.config);
      this.changed = true;
      this.bump("notebook", {
        config: clone(this.config),
        ...(runtimeChanged ? { metadata: clone(this.metadata) } : {}),
      });
      if (runtimeChanged) this.emit("runtime", this.runtimeSnapshot());
      return { config: clone(this.config) };
    });
  }

  private async setLayout(layout: unknown): Promise<unknown> {
    this.assertStartedForMutation();
    if (this.services.service === undefined) {
      throw new ControllerError("service_unavailable", "layout update service is unavailable", 503);
    }
    return this.withServiceMutation(async () => {
      const response = await this.services.service?.("layout.update", { layout: clone(layout) });
      this.assertNotClosed();
      if (!isRecord(response) || !("layout" in response)) {
        throw new ControllerError("invalid_service_response", "layout service returned invalid data", 503);
      }
      this.layout = clone(response.layout);
      this.bump("notebook", { layout: clone(this.layout) });
      return { layout: clone(this.layout) };
    });
  }

  private async callService(command: string, payload: Record<string, unknown>): Promise<unknown> {
    this.assertStarted();
    if (command === "rename-cell") return this.renameCell(payload);
    if (command === "check") {
      await this.ensureCurrentAnalysis();
      return {
        ok: this.graphValue.validate().length === 0,
        issues: this.graphValue.validate(),
        cells: this.cells.map((cell) => ({
          id: cell.id,
          revision: cell.revision,
          diagnostics: this.cellDiagnostics(cell),
        })),
      };
    }
    if (command === "set-app") return this.setApp(payload);
    if (command === "source") {
      if (Object.keys(payload).length > 0) {
        throw new ControllerError("invalid_request", "source does not accept arguments", 400);
      }
      if (this.services.service === undefined) {
        throw new ControllerError("service_unavailable", "exact source service is unavailable", 503);
      }
      const result = await this.services.service("source", {});
      this.assertNotClosed();
      if (!isRecord(result) || typeof result.text !== "string") {
        throw new ControllerError(
          "invalid_service_response",
          "exact source service returned invalid data",
          503,
        );
      }
      return { text: result.text };
    }
    if (this.services.service !== undefined) {
      const result = await this.services.service(command, clone(payload));
      this.assertNotClosed();
      return result;
    }
    const response = engineResponseSchema.parse(await this.engine.request(command, clone(payload)));
    if (!response.ok) {
      throw new ControllerError(
        response.error?.transport ? "worker_unavailable" : response.error?.code ?? "service_error",
        response.error?.message ?? `${command} failed`,
        response.error?.transport ? 503 : 400,
      );
    }
    return response;
  }

  private startServiceOperation(
    command: Extract<HostCommand, { type: "service" }>,
  ): unknown {
    const normalized = this.normalizeLongService(command.command, command.payload);
    if (normalized.command === "upload") {
      return this.startUploadOperation(command, normalized.payload);
    }
    if (normalized.command === "packages.install") {
      this.assertPackageInstallCanStart();
      this.packageOperationActive = true;
      this.bump("runtime", this.runtimeSnapshot(), { operationId: command.operationId });
    }
    const operation = this.operations.get(command.operationId);
    if (operation !== undefined) {
      operation.status = "running";
      this.rememberOperation(operation);
    }
    void this.runLongService(normalized.command, normalized.payload, command.operationId)
      .then((result) => {
        if (this.closed) return;
        if (normalized.command === "packages.install") {
          this.packageOperationActive = false;
          this.bump("runtime", this.runtimeSnapshot(), { operationId: command.operationId });
          this.scheduleWidgetReconciliation();
        }
        this.completeOperation(command.operationId, result);
      }).catch((error: unknown) => {
        if (this.closed) return;
        if (normalized.command === "packages.install") {
          this.packageOperationActive = false;
          this.bump("runtime", this.runtimeSnapshot(), { operationId: command.operationId });
          this.scheduleWidgetReconciliation();
        }
        const failure = asControllerError(error, "service_error");
        const hostFailure = failure.toJSON(command.operationId);
        this.replaceLastActionError(hostFailure, { operationId: command.operationId });
        this.failOperation(command.operationId, hostFailure);
      });
    return { accepted: true, command: normalized.command };
  }

  private startUploadOperation(
    command: Extract<HostCommand, { type: "service" }>,
    payload: Record<string, unknown>,
  ): unknown {
    this.assertExecutionPossible();
    this.assertGraphRunnable();
    if (this.services.service === undefined) {
      throw new ControllerError("service_unavailable", "upload service is unavailable", 503);
    }
    const name = payload.name;
    const path = payload.path ?? [];
    const files = payload.files;
    const source = payload.source ?? "editor";
    if (typeof name !== "string" || name.length === 0 || name.length > 256) {
      throw new ControllerError("invalid_request", "upload widget name is required", 400);
    }
    if (!Array.isArray(path)
      || path.some((part) => typeof part !== "string" || part.length === 0 || part.length > 256)) {
      throw new ControllerError("invalid_request", "upload widget path is invalid", 400);
    }
    if (!Array.isArray(files)) {
      throw new ControllerError("invalid_request", "upload files must be an array", 400);
    }
    if (source !== "editor" && source !== "app" && source !== "mcp" && source !== "cli") {
      throw new ControllerError("invalid_request", "upload source is invalid", 400);
    }
    const location = this.findWidget(name);
    if (location === null) {
      throw new ControllerError("invalid_request", `no such widget: ${name}`, 400);
    }
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("widget_not_current", `widget ${name} is not current`, 409);
    }
    const spec = isRecord(location.widget.spec) ? location.widget.spec : null;
    const target = spec === null ? null : widgetSpecAt(spec, path as string[]);
    if (target === null || target.kind !== "file") {
      throw new ControllerError("invalid_request", "upload path is not a file widget", 400);
    }
    const key = widgetKey(name, path as string[]);
    if (this.pendingWidgets.has(key)
      || [...this.pendingUploads.values()].some((pending) => pending.key === key)) {
      throw new ControllerError(
        "operation_in_progress",
        `widget ${name} already has a pending update`,
        409,
      );
    }
    const operation = this.operations.get(command.operationId);
    if (operation !== undefined) {
      operation.kind = "widget";
      operation.status = "running";
      operation.cellIds = [owner.id];
      this.rememberOperation(operation);
    }
    this.pendingUploads.set(command.operationId, {
      name,
      path: [...path as string[]],
      key,
      owner: owner.id,
      revision: owner.revision,
      widget: location.widget,
      uploadId: null,
      source,
    });
    void this.storeAndApplyUpload(command, files).catch((error: unknown) => {
      if (this.closed) return;
      const failure = asControllerError(error, "upload_failed");
      const hostFailure = failure.toJSON(command.operationId);
      this.replaceLastActionError(hostFailure, { operationId: command.operationId });
      this.discardUpload(command.operationId);
      this.failOperation(command.operationId, hostFailure);
    });
    return { accepted: true, command: "upload", owner: owner.id };
  }

  private async storeAndApplyUpload(
    command: Extract<HostCommand, { type: "service" }>,
    files: unknown[],
  ): Promise<void> {
    const raw = await this.services.service?.("upload.store", { files: clone(files) });
    let response: { uploadId: string; value: Array<Record<string, unknown>> };
    try {
      response = parseStoredUpload(raw);
    } catch (error) {
      if (isRecord(raw) && typeof raw.uploadId === "string") {
        await this.removeUpload(raw.uploadId);
      }
      throw error;
    }
    const pending = this.pendingUploads.get(command.operationId);
    if (pending === undefined || this.closed || isTerminal(
      this.operations.get(command.operationId)?.status ?? "error",
    )) {
      await this.removeUpload(response.uploadId);
      return;
    }
    pending.uploadId = response.uploadId;
    const current = this.findWidget(pending.name);
    const owner = this.cellById(pending.owner);
    const target = current !== null && isRecord(current.widget.spec)
      ? widgetSpecAt(current.widget.spec, pending.path)
      : null;
    if (current === null
      || current.owner !== pending.owner
      || current.widget !== pending.widget
      || owner === undefined
      || owner.revision !== pending.revision
      || this.statusOf(owner.id) !== "done"
      || target?.kind !== "file") {
      throw new ControllerError("widget_not_current", "file widget is no longer current", 409);
    }
    this.startWidgetOperation({
      type: "widget",
      operationId: command.operationId,
      sessionEpoch: command.sessionEpoch,
      name: pending.name,
      path: [...pending.path],
      update: { value: clone(response.value) },
      source: pending.source,
    });
  }

  private discardUpload(operationId: string): void {
    const pending = this.pendingUploads.get(operationId);
    if (pending === undefined) return;
    this.pendingUploads.delete(operationId);
    if (pending.uploadId !== null) void this.removeUpload(pending.uploadId);
  }

  private async removeUpload(uploadId: string): Promise<void> {
    try {
      await this.services.service?.("upload.remove", { uploadId });
    } catch {
      // Session teardown also removes the upload workspace. Early cleanup is best-effort.
    }
  }

  private normalizeLongService(
    command: string,
    payload: Record<string, unknown>,
  ): { command: string; payload: Record<string, unknown> } {
    if (command !== "packages" && !command.startsWith("packages.")) {
      return { command, payload: clone(payload) };
    }
    let operation = command === "packages" ? payload.op : command.slice("packages.".length);
    if (operation !== "status" && operation !== "declare" && operation !== "install") {
      throw new ControllerError(
        "invalid_request",
        "package operation must be status, declare, or install",
        400,
      );
    }
    if (operation === "status") {
      if (payload.package !== undefined || payload.packages !== undefined) {
        throw new ControllerError("invalid_request", "status does not accept package names", 400);
      }
      return { command: "packages.status", payload: {} };
    }
    const packages = packageNames(payload, operation === "install");
    return { command: `packages.${operation}`, payload: { packages } };
  }

  private assertPackageInstallCanStart(): void {
    this.assertStarted();
    if (this.packageOperationActive) {
      throw new ControllerError(
        "operation_in_progress",
        "a package installation is already in progress",
        409,
      );
    }
    if (this.runPreparationActive || this.activeEvaluation !== null || this.queue.length > 0) {
      throw new ControllerError(
        "run_in_progress",
        "cannot install packages while a run is active or being prepared",
        409,
      );
    }
    if (this.engineRestarting) {
      throw new ControllerError(
        "operation_in_progress",
        "cannot install packages while the R engine is restarting",
        409,
      );
    }
  }

  private async runLongService(
    command: string,
    payload: Record<string, unknown>,
    operationId: string,
  ): Promise<unknown> {
    if (command === "packages.declare") {
      const declaration = await this.callService(command, payload);
      const status = await this.callService("packages.status", {});
      return { declaration: clone(declaration), status: clone(status) };
    }
    if (command === "packages.install") {
      return this.runPackageInstall(payload, operationId);
    }
    return this.callService(command, payload);
  }

  private async runPackageInstall(
    payload: Record<string, unknown>,
    operationId: string,
  ): Promise<unknown> {
    let packages = Array.isArray(payload.packages) ? [...payload.packages] as string[] : [];
    if (packages.length === 0) {
      const before = await this.callService("packages.status", {});
      packages = packageMissing(before);
    }

    let result: unknown;
    let installFailure: unknown;
    try {
      result = await this.callService("packages.install", { packages });
      const failure = serviceResultError(result, operationId);
      if (failure !== null) installFailure = failure;
    } catch (error) {
      installFailure = error;
    }

    await this.restartAfterPackageInstall(operationId);
    if (installFailure !== undefined) throw installFailure;
    const status = await this.callService("packages.status", {});
    return { result: clone(result), status: clone(status) };
  }

  private async restartAfterPackageInstall(operationId: string): Promise<void> {
    this.analysisRestarting = true;
    try {
      const pendingAnalysis = this.analysisInFlight;
      if (pendingAnalysis !== null) await pendingAnalysis.catch(() => {});
      this.assertNotClosed();

      const statusChanges = this.invalidateRuntimeView();
      this.analysisGeneration = nextRevision(this.analysisGeneration);
      this.clearAnalysisCache();
      this.analyzerIdentity = "";
      this.analysisNeeded.clear();
      for (const cell of this.cells) {
        if (cell.type !== "code") continue;
        cell.analysis = null;
        cell.status = "stale";
        this.analysisNeeded.add(cell.id);
      }
      this.graphValue = this.rebuildGraph();
      this.barrierRestartRequired = false;
      this.clearBeforeEvaluation.clear();
      this.invalidatedDefinitionsByCell.clear();
      this.executionReady = false;
      this.kernelAvailable = false;
      this.analyzerAvailable = false;
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
      this.emitGraph({ operationId });
      this.emitCells([
        ...statusChanges,
        ...this.cells.filter((cell) => cell.type === "code").map((cell) => cell.id),
      ], { operationId });

      let handshake: EngineHandshake;
      try {
        handshake = engineHandshakeSchema.parse(await this.engine.restart());
      } catch (error) {
        throw new ControllerError(
          "worker_unavailable",
          `R engine restart after package installation failed: ${messageOf(error)}`,
          503,
        );
      }
      this.assertNotClosed();
      this.handshake = handshake;
      this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
      this.analyzerAvailable = handshake.analyzerReady;
      if (!this.kernelAvailable || !this.analyzerAvailable) {
        throw new ControllerError(
          "engine_not_ready",
          "R engine did not become ready after package installation",
          503,
        );
      }
      await this.ensureCurrentAnalysis();
      this.executionReady = true;
      if (!this.graphValue.resourceLimited) {
        this.replaceLastActionError(null, { operationId });
      }
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
    } finally {
      this.analysisRestarting = false;
      if (!this.closed && this.analysisNeeded.size > 0 && this.analyzerAvailable) {
        this.scheduleAnalysis();
      }
    }
  }

  private renameCell(payload: Record<string, unknown>): unknown {
    const id = payload.cellId;
    const name = payload.name;
    if (typeof id !== "string") {
      throw new ControllerError("invalid_request", "cellId must be a string", 400);
    }
    if (name !== null && (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(name))) {
      throw new ControllerError(
        "invalid_request",
        "cell name must match ^[A-Za-z][A-Za-z0-9_.]*$",
        400,
      );
    }
    const cell = this.requireCell(id);
    if (cell.options.name === name || (name === null && cell.options.name === undefined)) {
      return { id, name: name ?? null };
    }
    const priorName = typeof cell.options.name === "string" ? cell.options.name : null;
    const options = { ...cell.options };
    if (name === null) delete options.name;
    else options.name = name;
    cell.options = options;
    this.changed = true;
    this.bump("cell", this.publicCell(cell), { cellId: cell.id, revision: cell.revision });
    const affectedNames = new Set([priorName, name].filter(
      (value): value is string => typeof value === "string",
    ));
    for (const candidate of this.cells) {
      if (candidate.id === cell.id || !affectedNames.has(String(candidate.options.name ?? ""))) {
        continue;
      }
      this.emit("cell", this.publicCell(candidate), {
        cellId: candidate.id,
        revision: candidate.revision,
      });
    }
    return { id, name: name ?? null };
  }

  private async setApp(payload: Record<string, unknown>): Promise<unknown> {
    if (this.services.service === undefined) {
      throw new ControllerError("service_unavailable", "app update service is unavailable", 503);
    }
    return this.withServiceMutation(async () => {
      const current = isRecord(this.metadata.app) ? this.metadata.app : {};
      const proposed = deepMerge(current, payload);
      const response = await this.services.service?.("app.update", { app: proposed });
      this.assertNotClosed();
      if (!isRecord(response) || !isRecord(response.app)) {
        throw new ControllerError("invalid_service_response", "app service returned invalid data", 503);
      }
      this.metadata = { ...this.metadata, app: clone(response.app) };
      this.changed = true;
      this.bump("notebook", { app: clone(response.app) });
      return { app: clone(response.app) };
    });
  }

  private async withServiceMutation<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.serviceMutationTail;
    let release!: () => void;
    this.serviceMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.assertNotClosed();
    try {
      return await work();
    } finally {
      release();
    }
  }

  private publicCell(cell: CellRecord): HostCellState {
    const analysis = cell.analysis ?? emptyAnalysis(cell.id, cell.revision);
    return {
      id: cell.id,
      type: cell.type,
      body: [...cell.body],
      options: clone(cell.options),
      revision: cell.revision,
      status: this.statusOf(cell.id),
      outputs: clone(cell.outputs),
      ...(cell.type === "code" && cell.outputsStale && cell.outputs.length ? { outputsStale: true } : {}),
      progress: clone(cell.progress),
      log: [...cell.log],
      error: clone(cell.error),
      defs: [...analysis.defs],
      refs: [...analysis.refs],
      selfRefs: [...analysis.selfRefs],
      locals: [...analysis.locals],
      barrier: analysis.barrier,
      opaque: analysis.opaque,
      diagnostics: this.cellDiagnostics(cell),
      analysisPending: cell.type === "code"
        && (cell.analysis === null || cell.analysis.revision !== cell.revision),
    };
  }

  private cellDiagnostics(cell: CellRecord): AnalysisDiagnostic[] {
    const diagnostics: AnalysisDiagnostic[] = [];
    const analysis = cell.analysis;
    if (analysis?.error !== null && analysis?.error !== undefined) {
      diagnostics.push({
        source: "alder",
        level: "error",
        code: "syntax-error",
        message: analysis.error,
        symbol: null,
      });
    }
    for (const raw of analysis?.diagnostics ?? []) {
      const parsed = analysisDiagnosticSchema.safeParse(raw);
      if (parsed.success) diagnostics.push(parsed.data);
    }
    if (this.graphValue.state.cycles.includes(cell.id)) {
      diagnostics.push({
        source: "alder",
        level: "error",
        code: "dependency-cycle",
        message: `dependency cycle: ${this.graphValue.state.cycles.join(", ")}`,
        symbol: null,
      });
    }
    const duplicateDefinitions = Object.keys(this.graphValue.state.duplicates)
      .filter((symbol) => analysis?.defs.includes(symbol));
    if (duplicateDefinitions.length > 0) {
      diagnostics.push({
        source: "alder",
        level: "error",
        code: "duplicate-definition",
        message: `duplicate definition: ${duplicateDefinitions.join(", ")}`,
        symbol: null,
      });
    }
    const name = typeof cell.options.name === "string" ? cell.options.name : null;
    if (name !== null) {
      if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) {
        diagnostics.push({
          source: "alder",
          level: "error",
          code: "invalid-cell-name",
          message: "cell name must match ^[A-Za-z][A-Za-z0-9_.]*$",
          symbol: null,
        });
      } else if (this.cells.filter((candidate) => candidate.options.name === name).length > 1) {
        diagnostics.push({
          source: "alder",
          level: "warning",
          code: "duplicate-cell-name",
          message: `duplicate cell name: ${name}`,
          symbol: null,
        });
      }
    }
    diagnostics.push(...clone(this.editorDiagnostics.get(cell.id) ?? []));
    return diagnostics;
  }

  private statusOf(id: string): CellStatus {
    const cell = this.cellById(id);
    if (cell === undefined) return "idle";
    if (cell.options.disabled === true && cell.status !== "running") return "disabled";
    return cell.status;
  }

  private cellById(id: string): CellRecord | undefined {
    return this.cells.find((cell) => cell.id === id);
  }

  private requireCell(id: string): CellRecord {
    const cell = this.cellById(id);
    if (cell === undefined) throw new ControllerError("not_found", `no such cell: ${id}`, 404);
    return cell;
  }

  private nextCellId(): string {
    const ids = new Set(this.cells.map((cell) => cell.id));
    let number = 1;
    for (const id of ids) {
      const match = /^cell-(\d+)$/.exec(id);
      if (match !== null) number = Math.max(number, Number(match[1]) + 1);
    }
    while (ids.has(`cell-${number}`)) number += 1;
    return `cell-${number}`;
  }

  private markStale(id: string): boolean {
    const cell = this.cellById(id);
    if (cell === undefined || cell.type !== "code") return false;
    const before = this.statusOf(id);
    cell.outputsStale = cell.outputs.length > 0;
    if (["done", "error", "stopped", "running"].includes(cell.status)) cell.status = "stale";
    this.refreshValueFreshness();
    return this.statusOf(id) !== before;
  }

  private emitCells(
    ids: Iterable<string>,
    identity: Partial<Pick<HostEvent, "operationId" | "runId">> = {},
  ): void {
    const selected = new Set(ids);
    for (const cell of this.cells) {
      if (!selected.has(cell.id)) continue;
      this.emit("cell", this.publicCell(cell), {
        ...identity,
        cellId: cell.id,
        revision: cell.revision,
      });
    }
  }

  private refreshValueFreshness(): void {
    this.refreshInspectionFreshness();
    if (!isRecord(this.lastValue) || typeof this.lastValue.name !== "string") return;
    const owner = typeof this.lastValue.owner === "string" ? this.lastValue.owner : null;
    const revision = typeof this.lastValue.revision === "number" ? this.lastValue.revision : undefined;
    const currentOwner = this.graphValue.definitionOwner(this.lastValue.name);
    const fresh = owner === null
      ? currentOwner === undefined && !this.definitionIsInvalidated(this.lastValue.name)
      : currentOwner === owner
        && this.cellById(owner)?.revision === revision
        && this.statusOf(owner) === "done";
    if (!fresh) {
      this.lastValue = null;
    }
  }

  private clearEditorDiagnostics(): void {
    if (this.editorDiagnostics.size === 0) return;
    const affected = [...this.editorDiagnostics.keys()];
    this.editorDiagnostics.clear();
    this.bump("editor-diagnostics", {});
    for (const id of affected) {
      if (id === ".document") continue;
      const cell = this.cellById(id);
      if (cell === undefined) continue;
      this.emit("diagnostics", clone(this.publicCell(cell).diagnostics), {
        cellId: id,
        revision: cell.revision,
      });
    }
  }

  private clearVariables(): void {
    clearTimeout(this.variableRefreshTimer);
    this.variableRefreshTimer = undefined;
    this.variableGeneration = nextRevision(this.variableGeneration);
    this.variableRefreshRequested = false;
    if (this.variables.length === 0) return;
    this.variables = [];
    this.bump("variables", []);
  }

  private scheduleVariableRefresh(): void {
    if (this.closed || !this.kernelAvailable
      || this.handshake?.capabilities.includes("variables") !== true) return;
    this.variableRefreshRequested = true;
    if (this.variableRefreshInFlight) return;
    // Environment inspection is optional and shares the serial kernel. Wait
    // for a pause in execution so it cannot occupy the kernel or browser while
    // a scalar result is reaching the screen or the next Run is arriving.
    clearTimeout(this.variableRefreshTimer);
    this.variableRefreshTimer = setTimeout(() => {
      this.variableRefreshTimer = undefined;
      void this.refreshVariables();
    }, 100);
    this.variableRefreshTimer.unref();
  }

  private async refreshVariables(): Promise<void> {
    if (this.closed || !this.kernelAvailable || !this.variableRefreshRequested
      || this.activeEvaluation !== null || this.queue.length > 0
      || this.packageOperationActive || this.variableRefreshInFlight) return;
    this.variableRefreshRequested = false;
    this.variableRefreshInFlight = true;
    const generation = this.variableGeneration;
    try {
      const response = engineResponseSchema.parse(await this.engine.request("env_snapshot", {}));
      if (this.closed || generation !== this.variableGeneration || !this.kernelAvailable) return;
      if (!response.ok) {
        if (response.error?.transport) this.failKernel(
          response.error.message || "R variable snapshot failed",
        );
        return;
      }
      const variables = parseRuntimeVariables(response.variables, this.graphValue, this.cells);
      if (stableStringify(variables) === stableStringify(this.variables)) return;
      this.variables = variables;
      this.bump("variables", clone(variables));
    } catch (error) {
      if (!this.closed && generation === this.variableGeneration && this.kernelAvailable) {
        this.failKernel(`invalid variable snapshot: ${messageOf(error)}`);
      }
    } finally {
      this.variableRefreshInFlight = false;
      if (this.variableRefreshRequested) this.scheduleVariableRefresh();
    }
  }

  private cancelOwnedOperations(id: string): string[] {
    const cancelledWidgetRequests: string[] = [];
    this.cancelRuntimeRequestsOwnedBy(id, "stale_value");
    for (const [key, operationId] of [...this.pendingWidgets]) {
      const operation = this.operations.get(operationId);
      if (operation?.cellIds?.includes(id)) {
        if (operation.kind === "widget") cancelledWidgetRequests.push(operationId);
        this.pendingWidgets.delete(key);
        this.discardUpload(operationId);
        const activeReset = this.activeButtonResets.get(operationId);
        if (activeReset !== undefined) {
          this.activeButtonResets.delete(operationId);
          setWidgetOperation(activeReset.reset.widget, activeReset.reset.key, {
            token: activeReset.token,
            operationId,
            status: "cancelled",
            error: { code: "widget_not_current", message: "widget owner changed" },
          });
        }
        if (!isTerminal(operation.status)) {
          operation.status = "cancelled";
          operation.error = hostError("widget_not_current", "widget owner changed", operationId);
          operation.settledAt = Date.now();
          this.rememberOperation(operation);
          this.notifyOperationWaiters(operation);
        }
        if (activeReset !== undefined) {
          this.failButtonResetParents(
            activeReset.reset,
            "widget_not_current",
            "run button is no longer current",
          );
          if (activeReset.reset.runId !== null) {
            this.completeRunIfIdle(activeReset.reset.runId);
          }
        }
      }
    }
    for (const [operationId, pending] of [...this.pendingUploads]) {
      if (pending.owner !== id) continue;
      this.discardUpload(operationId);
      const operation = this.operations.get(operationId);
      if (operation !== undefined && !isTerminal(operation.status)) {
        operation.status = "cancelled";
        operation.error = hostError("widget_not_current", "widget owner changed", operationId);
        operation.settledAt = Date.now();
        this.rememberOperation(operation);
        this.notifyOperationWaiters(operation);
      }
    }
    for (const [key, reset] of [...this.pendingButtonResets]) {
      if (reset.owner === id) {
        this.pendingButtonResets.delete(key);
        this.failButtonResetParents(reset, "widget_not_current", "widget owner changed");
      }
    }
    return cancelledWidgetRequests;
  }

  private rememberInvalidatedDefinitions(cell: CellRecord): void {
    const definitions = cell.analysis?.defs ?? [];
    if (definitions.length === 0) return;
    const known = this.invalidatedDefinitionsByCell.get(cell.id) ?? new Set<string>();
    for (const definition of definitions) known.add(definition);
    this.invalidatedDefinitionsByCell.set(cell.id, known);
  }

  private definitionIsInvalidated(name: string): boolean {
    for (const definitions of this.invalidatedDefinitionsByCell.values()) {
      if (definitions.has(name)) return true;
    }
    return false;
  }

  private refreshInspectionFreshness(): void {
    const pending = this.pendingInspection;
    if (pending === null) return;
    const currentOwner = this.graphValue.definitionOwner(pending.name);
    const fresh = pending.owner === null
      ? currentOwner === undefined && !this.definitionIsInvalidated(pending.name)
      : currentOwner === pending.owner
        && this.cellById(pending.owner)?.revision === pending.revision
        && this.statusOf(pending.owner) === "done";
    if (fresh) return;
    this.pendingInspection = null;
    this.failOperation(
      pending.operationId,
      hostError("stale_value", staleValueMessage(pending.name), pending.operationId),
    );
  }

  private cancelRuntimeRequestsOwnedBy(id: string, inspectionCode: string): void {
    if (this.pendingInspection?.owner === id) {
      const pending = this.pendingInspection;
      this.pendingInspection = null;
      this.failOperation(
        pending.operationId,
        hostError(inspectionCode, staleValueMessage(pending.name), pending.operationId),
      );
    }
    for (const [key, pending] of [...this.pendingLazyOutputs]) {
      if (pending.owner !== id) continue;
      this.pendingLazyOutputs.delete(key);
      this.failOperation(
        pending.operationId,
        hostError("lazy_expired", "lazy output is no longer current", pending.operationId),
      );
    }
    for (const [handle, pending] of [...this.pendingTablePages]) {
      if (pending.owner !== id) continue;
      this.pendingTablePages.delete(handle);
      this.failOperation(
        pending.operationId,
        hostError("table_unavailable", "table is no longer current", pending.operationId),
      );
    }
  }

  private findWidget(name: string): { owner: string; widget: Record<string, unknown> } | null {
    for (const cell of this.cells) {
      for (let index = cell.outputs.length - 1; index >= 0; index -= 1) {
        const widget = findOutputRecord(cell.outputs[index], (output) =>
          output.kind === "widget" && output.name === name,
        );
        if (widget !== null) return { owner: cell.id, widget };
      }
    }
    return null;
  }

  private findOutput(
    predicate: (output: Record<string, unknown>) => boolean,
  ): { owner: string; output: Record<string, unknown> } | null {
    for (const cell of this.cells) {
      for (const output of cell.outputs) {
        const found = findOutputRecord(output, predicate);
        if (found !== null) return { owner: cell.id, output: found };
      }
    }
    return null;
  }

  private createOperation(id: string, kind: OperationRecord["kind"]): OperationRecord {
    if (this.operations.has(id)) {
      throw new ControllerError("operation_id_conflict", `operation ${id} already exists`, 409);
    }
    const operation: OperationRecord = {
      id,
      kind,
      status: "accepted",
      acceptedAt: Date.now(),
      error: null,
    };
    this.operations.set(operation.id, operation);
    this.trimOperations();
    return operation;
  }

  private rememberOperation(operation: OperationRecord): void {
    this.operations.set(operation.id, operation);
    this.emit("operation", clone(operation), { operationId: operation.id, runId: operation.runId });
    this.trimOperations();
  }

  private completeOperation(id: string, result?: unknown): void {
    const operation = this.operations.get(id);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.status = "done";
    operation.result = clone(result);
    operation.error = null;
    operation.settledAt = Date.now();
    this.rememberOperation(operation);
    this.notifyOperationWaiters(operation);
  }

  private failOperation(id: string, error: HostError): void {
    const operation = this.operations.get(id);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.status = "error";
    operation.error = clone(error);
    operation.settledAt = Date.now();
    this.rememberOperation(operation);
    this.notifyOperationWaiters(operation);
  }

  private markOperationCancellationRequested(id: string): void {
    const operation = this.operations.get(id);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.status = "cancellation-requested";
    this.rememberOperation(operation);
  }

  private notifyOperationWaiters(operation: OperationRecord): void {
    if (!isTerminal(operation.status)) return;
    const waiters = this.operationWaiters.get(operation.id);
    if (waiters === undefined) return;
    this.operationWaiters.delete(operation.id);
    for (const waiter of waiters) waiter(operation);
  }

  private trimOperations(): void {
    if (this.operations.size <= OPERATION_JOURNAL_LIMIT) return;
    for (const [id, operation] of this.operations) {
      if (this.operations.size <= OPERATION_JOURNAL_LIMIT) break;
      if (isTerminal(operation.status)) this.operations.delete(id);
    }
  }

  private trimCommandEntries(): void {
    if (this.commandEntries.size <= COMMAND_DEDUPLICATION_LIMIT) return;
    for (const [id] of this.commandEntries) {
      if (this.commandEntries.size <= COMMAND_DEDUPLICATION_LIMIT) break;
      if (isTerminal(this.operations.get(id)?.status ?? "done")) this.commandEntries.delete(id);
    }
  }

  private replaceLastActionError(
    error: HostError | null,
    identity: Partial<Pick<HostEvent, "operationId" | "cellId" | "runId" | "revision">> = {},
  ): void {
    const next = clone(error);
    if (stableStringify(this.lastActionError) === stableStringify(next)) return;
    this.lastActionError = next;
    this.bump("service-error", clone(next), identity);
  }

  private bump(
    type: HostEventType,
    payload: unknown,
    identity: Partial<Pick<HostEvent, "operationId" | "cellId" | "runId" | "revision" | "sequence">> = {},
  ): void {
    this.version = nextRevision(this.version);
    this.emit(type, payload, identity);
  }

  private emitGraph(
    identity: Partial<Pick<HostEvent, "operationId" | "runId">> = {},
  ): void {
    this.emit("graph", clone(this.graphValue.state), identity);
    this.publishGraphResourceError(identity);
  }

  private publishGraphResourceError(
    identity: Partial<Pick<HostEvent, "operationId" | "runId">> = {},
  ): void {
    if (this.graphValue.resourceLimited) {
      this.replaceLastActionError(hostError(
        "graph_too_complex",
        `dependency graph exceeds the ${MAX_DEPENDENCY_EDGES} edge limit`,
      ), identity);
    } else if (
      this.lastActionError?.code === "graph_too_complex"
      && this.analysisNeeded.size === 0
    ) {
      this.replaceLastActionError(null, identity);
    }
  }

  private emit(
    type: HostEventType,
    payload: unknown,
    identity: Partial<Pick<HostEvent, "operationId" | "cellId" | "runId" | "revision" | "sequence">> = {},
  ): void {
    if (this.closed && type !== "runtime") return;
    if (type === "runtime") {
      const signature = JSON.stringify(payload);
      if (signature === this.runtimeSignature) return;
      this.runtimeSignature = signature;
    }
    this.cursorValue += 1;
    const event: HostEvent = {
      protocol: HOST_PROTOCOL,
      epoch: this.epochValue,
      cursor: this.cursorValue,
      version: this.version,
      timestamp: Date.now(),
      type,
      ...identity,
      payload: clone(payload),
    };
    const bytes = jsonBytes(event);
    this.eventJournal.push(event);
    this.eventJournalBytes += bytes;
    while (
      this.eventJournal.length > this.eventJournalLimit
      || this.eventJournalBytes > this.eventJournalByteLimit
    ) {
      const removed = this.eventJournal.shift();
      if (removed === undefined) break;
      this.eventJournalBytes -= jsonBytes(removed);
    }
    for (const [listener, types] of this.listeners) {
      // Source observers do not need copies of execution/output payloads.
      if (types && !types.includes(type)) continue;
      try {
        listener(clone(event));
      } catch {
        // A client adapter cannot corrupt controller ordering or execution.
      }
    }
  }

  private snapshotRecovery(): Recovery {
    return {
      kind: "snapshot",
      epoch: this.epochValue,
      cursor: this.cursorValue,
      snapshot: this.snapshot(),
    };
  }

  private runtimeSnapshot(): HostSnapshot["runtime"] {
    return {
      executionMode: this.executionMode,
      runOnStartup: this.runOnStartup,
      executionReady: this.executionReady,
      analyzerAvailable: this.analyzerAvailable,
      kernelAvailable: this.kernelAvailable,
      packageOperationActive: this.packageOperationActive,
      busy: this.activeEvaluation !== null,
      activeRunId: this.activeEvaluation?.job.runId ?? null,
    };
  }

  private async renderMarkdownCells(): Promise<void> {
    for (const cell of this.cells) {
      if (cell.type !== "markdown") continue;
      const output = await this.renderMarkdown(cell.body);
      this.assertNotClosed();
      cell.outputs = [output];
    }
  }

  private scheduleMarkdownRender(cell: CellRecord): void {
    const revision = cell.revision;
    const body = [...cell.body];
    void this.renderMarkdown(body).then((output) => {
      const current = this.cellById(cell.id);
      if (
        this.closed
        || current === undefined
        || current.type !== "markdown"
        || current.revision !== revision
        || !arrayEqual(current.body, body)
      ) return;
      current.outputs = [output];
      this.bump("cell", this.publicCell(current), {
        cellId: current.id,
        revision: current.revision,
      });
    }).catch((error: unknown) => {
      if (this.closed) return;
      this.replaceLastActionError(hostError("markdown_render_failed", messageOf(error)), {
        cellId: cell.id,
        revision,
      });
    });
  }

  private async renderMarkdown(lines: readonly string[]): Promise<unknown> {
    if (this.services.renderMarkdown !== undefined) {
      return clone(await this.services.renderMarkdown(lines));
    }
    return { kind: "markdown", source: [...lines] };
  }

  private assertNotClosed(): void {
    if (this.closed) throw new ControllerError("session_stopped", "session is stopped", 409);
  }

  private assertStartCurrent(generation: number): void {
    if (this.closed || generation !== this.runtimeGeneration) {
      throw new ControllerError("session_stopped", "session is stopped", 409);
    }
  }

  private assertRuntimeGeneration(generation: number, message: string): void {
    this.assertNotClosed();
    if (generation !== this.runtimeGeneration) {
      throw new ControllerError("worker_unavailable", message, 503);
    }
  }

  private assertStarted(): void {
    this.assertNotClosed();
    if (!this.started) throw new ControllerError("session_not_started", "session is not started", 409);
  }

  private assertStartedForMutation(): void {
    this.assertStarted();
    if (this.engineRestarting) {
      throw new ControllerError(
        "operation_in_progress",
        "R engine restart is already in progress",
        409,
      );
    }
  }

  private assertExecutionPossible(): void {
    this.assertStarted();
    if (!this.executionReady || !this.kernelAvailable) {
      throw new ControllerError("worker_unavailable", "R kernel is not ready", 503);
    }
    if (!this.analyzerAvailable) {
      throw new ControllerError("analysis_unavailable", "R analyzer is not ready", 503);
    }
  }

  private assertNoPackageOperation(): void {
    if (this.packageOperationActive) {
      throw new ControllerError(
        "package_operation_in_progress",
        "cannot start a run while package installation is in progress",
        409,
      );
    }
  }

  private runtimeRequestCurrent(operationId: string, generation: number): boolean {
    const operation = this.operations.get(operationId);
    return !this.closed
      && generation === this.runtimeGeneration
      && operation !== undefined
      && !isTerminal(operation.status);
  }
}

function emptyAnalysis(id: string, revision: number): AnalysisCellResult {
  return {
    id,
    revision,
    defs: [],
    refs: [],
    selfRefs: [],
    locals: [],
    barrier: false,
    opaque: false,
    diagnostics: [],
    error: null,
  };
}

function analysisCacheValue(result: AnalysisCellResult): AnalysisCacheValue {
  return {
    defs: [...result.defs],
    refs: [...result.refs],
    selfRefs: [...result.selfRefs],
    locals: [...result.locals],
    barrier: result.barrier,
    opaque: result.opaque,
    diagnostics: clone(result.diagnostics),
    error: result.error,
  };
}

function analysisCacheEntryBytes(key: string, value: AnalysisCacheValue): number {
  const keyBytes = new TextEncoder().encode(key).byteLength;
  const valueBytes = jsonBytes(value);
  return valueBytes > Number.MAX_SAFE_INTEGER - keyBytes
    ? Number.MAX_SAFE_INTEGER
    : keyBytes + valueBytes;
}

function runtimeMode(metadata: Record<string, unknown>): "automatic" | "lazy" | undefined {
  const runtime = isRecord(metadata.runtime) ? metadata.runtime : null;
  const value = runtime?.execution_mode ?? runtime?.executionMode;
  return value === "automatic" || value === "lazy" ? value : undefined;
}

function runtimeStartup(metadata: Record<string, unknown>): boolean | undefined {
  const runtime = isRecord(metadata.runtime) ? metadata.runtime : null;
  const value = runtime?.run_on_startup ?? runtime?.runOnStartup;
  return typeof value === "boolean" ? value : undefined;
}

function joinSource(lines: readonly string[]): string {
  return lines.join("\n");
}

function markdownPlaceholder(lines: readonly string[]): unknown {
  return { kind: "markdown", source: [...lines], pending: true };
}

function nextRevision(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= 2_147_483_647) {
    throw new ControllerError("revision_exhausted", "revision counter is exhausted", 500);
  }
  return value + 1;
}

function staleStatus(
  status: Exclude<CellStatus, "disabled">,
): Exclude<CellStatus, "disabled"> {
  return ["done", "error", "stopped", "running"].includes(status) ? "stale" : status;
}

function staleValueMessage(name: string): string {
  return `Value '${name}' is not current. Run its defining cell and required dependencies, then inspect it again.`;
}

function sameJob(left: EvaluationJob, right: EvaluationJob): boolean {
  return left.id === right.id
    && left.revision === right.revision
    && left.runId === right.runId
    && left.operationId === right.operationId;
}

function hostError(
  code: string,
  message: string,
  operationId?: string | null,
  details?: unknown,
): HostError {
  return {
    code,
    message,
    ...(operationId === undefined ? {} : { operationId }),
    ...(details === undefined ? {} : { details: clone(details) }),
  };
}

function errorStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "worker_unavailable" || code === "analysis_unavailable") return 503;
  if (
    code === "source_conflict"
    || code === "run_in_progress"
    || code === "operation_in_progress"
    || code === "package_operation_in_progress"
    || code === "session_epoch_mismatch"
    || code === "graph_invalid"
  ) return 409;
  return 400;
}

function asControllerError(
  error: unknown,
  fallbackCode = "internal_error",
  fallbackStatus = 500,
): ControllerError {
  if (error instanceof ControllerError) return error;
  if (isRecord(error) && typeof error.code === "string" && error instanceof Error) {
    return new ControllerError(error.code, error.message, errorStatus(error.code));
  }
  return new ControllerError(fallbackCode, messageOf(error), fallbackStatus);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

function abortError(): Error {
  const error = new Error("operation wait was aborted");
  error.name = "AbortError";
  return error;
}

function isTerminal(status: OperationRecord["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function arrayEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function setEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function boundedLog(lines: readonly string[]): string[] {
  return tailLog(lines, MAX_LOG_BYTES);
}

function completedLog(lines: readonly string[]): string[] {
  const output = lines.map(String);
  const alreadyMarked = output.at(-1) === LOG_TRUNCATION_MARKER;
  const content = alreadyMarked ? output.slice(0, -1) : output;
  const contentBytes = content.reduce(
    (total, line, index) => total + new TextEncoder().encode(line).byteLength + Number(index > 0),
    0,
  );
  if (contentBytes <= MAX_COMPLETED_LOG_BYTES) return output;

  const prefix: string[] = [];
  let bytes = 0;
  for (const line of content) {
    const separator = Number(prefix.length > 0);
    const addition = new TextEncoder().encode(line).byteLength + separator;
    if (bytes + addition > MAX_COMPLETED_LOG_BYTES) {
      const partial = utf8Prefix(line, MAX_COMPLETED_LOG_BYTES - bytes - separator);
      if (partial.length > 0) prefix.push(partial);
      break;
    }
    prefix.push(line);
    bytes += addition;
  }
  prefix.push(LOG_TRUNCATION_MARKER);
  return prefix;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = maximumBytes; length >= Math.max(0, maximumBytes - 3); length -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, length));
    } catch {
      // A UTF-8 scalar spans at most four bytes; retry at the prior boundary.
    }
  }
  return "";
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableStringify(value: unknown): string {
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!isRecord(candidate)) return candidate;
    return Object.fromEntries(
      Object.keys(candidate).sort().map((key) => [key, visit(candidate[key])]),
    );
  };
  return JSON.stringify(visit(value));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findOutputRecord(
  value: unknown,
  predicate: (output: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (predicate(value)) return value;
  if (value.kind === "layout" && Array.isArray(value.children)) {
    for (const child of value.children) {
      const found = findOutputRecord(child, predicate);
      if (found !== null) return found;
    }
  }
  if (value.kind === "lazy" && value.child !== undefined) {
    return findOutputRecord(value.child, predicate);
  }
  return null;
}

function widgetKey(name: string, path: readonly string[]): string {
  return [name, ...path].join("\u0001");
}

function widgetSpecAt(
  spec: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  if (path.length === 0) return spec;
  if (spec.kind === "form" && isRecord(spec.child)) return widgetSpecAt(spec.child, path);
  if (spec.kind !== "array" && spec.kind !== "dictionary") return null;
  if (!Array.isArray(spec.children)) return null;
  const child = spec.children.find(
    (candidate) => isRecord(candidate) && candidate.name === path[0],
  );
  return isRecord(child) ? widgetSpecAt(child, path.slice(1)) : null;
}

function widgetPathHasForm(
  spec: Record<string, unknown>,
  path: readonly string[],
): boolean {
  if (spec.kind === "form") return true;
  if (path.length === 0 || (spec.kind !== "array" && spec.kind !== "dictionary")) return false;
  if (!Array.isArray(spec.children)) return false;
  const child = spec.children.find(
    (candidate) => isRecord(candidate) && candidate.name === path[0],
  );
  return isRecord(child) && widgetPathHasForm(child, path.slice(1));
}

function validateWidgetUpdate(kind: string, update: Record<string, unknown>): Record<string, unknown> {
  if (kind === "dropdown" || kind === "radio") {
    if (!positiveInteger(update.index)) {
      throw new ControllerError("invalid_request", "choice index must be a positive integer", 400);
    }
    return { index: update.index };
  }
  if (kind === "multiselect") {
    if (!integerArray(update.indices, true)) {
      throw new ControllerError("invalid_request", "choice indices must be unique positive integers", 400);
    }
    return { indices: [...update.indices] };
  }
  if (kind === "slider" || kind === "number") {
    if (typeof update.value !== "number" || !Number.isFinite(update.value)) {
      throw new ControllerError("invalid_request", "numeric widget value required", 400);
    }
    return { value: update.value };
  }
  if (kind === "range_slider") {
    if (!Array.isArray(update.value) || update.value.length !== 2
      || update.value.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new ControllerError("invalid_request", "range widget value required", 400);
    }
    return { value: [...update.value] };
  }
  if (["text_input", "text_area", "code_editor"].includes(kind)) {
    if (typeof update.value !== "string") {
      throw new ControllerError("invalid_request", "text widget value required", 400);
    }
    return { value: update.value };
  }
  if (["checkbox", "switch", "run_button"].includes(kind)) {
    if (typeof update.value !== "boolean") {
      throw new ControllerError("invalid_request", "logical widget value required", 400);
    }
    return { value: update.value };
  }
  if (kind === "button" || kind === "refresh") {
    if (!nonnegativeInteger(update.value)) {
      throw new ControllerError("invalid_request", "counter widget value required", 400);
    }
    if (update.paused !== undefined && typeof update.paused !== "boolean") {
      throw new ControllerError("invalid_request", "refresh pause must be logical", 400);
    }
    return { value: update.value, ...(update.paused === undefined ? {} : { paused: update.paused }) };
  }
  if (kind === "date" || kind === "date_range" || kind === "datetime") {
    const values = Array.isArray(update.value) ? update.value : [update.value];
    const expected = kind === "date_range" ? 2 : 1;
    const pattern = kind === "datetime"
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
      : /^\d{4}-\d{2}-\d{2}$/;
    if (values.length !== expected || values.some((value) =>
      typeof value !== "string" || !pattern.test(value)
      || (kind === "datetime" && !canonicalUtcSecond(value)))) {
      throw new ControllerError("invalid_request", "temporal widget value required", 400);
    }
    return { value: values };
  }
  if (kind === "table") {
    if (!integerArray(update.selected, true)) {
      throw new ControllerError("invalid_request", "table selection must be unique positive indices", 400);
    }
    return { selected: [...update.selected] };
  }
  if (kind === "dataframe") {
    if (!Array.isArray(update.ops)) {
      throw new ControllerError("invalid_request", "dataframe ops must be an array", 400);
    }
    return { ops: clone(update.ops) };
  }
  if (kind === "form") {
    if (update.submit !== true) {
      throw new ControllerError("invalid_request", "form submit must be true", 400);
    }
    return { submit: true };
  }
  if (kind === "file") {
    if (!Array.isArray(update.value)
      || update.value.some((file) => !isRecord(file)
        || typeof file.name !== "string"
        || file.name.length === 0
        || typeof file.path !== "string"
        || file.path.length === 0
        || typeof file.size !== "number"
        || !Number.isSafeInteger(file.size)
        || file.size < 0)) {
      throw new ControllerError(
        "invalid_request",
        "file value must have name, size, and path columns",
        400,
      );
    }
    return { value: clone(update.value) };
  }
  throw new ControllerError("invalid_request", "unknown widget kind", 400);
}

function canonicalUtcSecond(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === `${value.slice(0, -1)}.000Z`;
}

function patchWidgetSpec(
  original: Record<string, unknown>,
  path: readonly string[],
  selected: Record<string, unknown>,
  kind: string,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const spec = clone(original);
  if (spec.kind === "form" && path.length === 0 && kind !== "form" && isRecord(spec.child)) {
    spec.child = patchWidgetSpec(spec.child, [], selected, kind, update);
    spec.dirty = true;
    return spec;
  }
  if (path.length === 0) {
    if (kind === "table") spec.selected = clone(selected.selected ?? selected.value ?? []);
    else if (kind === "dataframe") {
      spec.value = clone(selected.value);
      spec.ops = clone(update.ops ?? spec.ops);
    } else {
      spec.value = clone(selected.value);
    }
    if (selected.index !== undefined) spec.index = selected.index;
    if (selected.indices !== undefined) spec.indices = clone(selected.indices);
    if (update.paused !== undefined) spec.paused = update.paused;
    if (kind === "form") spec.dirty = false;
    return spec;
  }
  if (spec.kind === "form" && isRecord(spec.child)) {
    spec.child = patchWidgetSpec(spec.child, path, selected, kind, update);
    spec.dirty = true;
    return spec;
  }
  if (!Array.isArray(spec.children)) return spec;
  const children = spec.children.map((child) => {
    if (!isRecord(child) || child.name !== path[0]) return child;
    return patchWidgetSpec(child, path.slice(1), selected, kind, update);
  });
  spec.children = children;
  const values: Record<string, unknown> = {};
  for (const child of children) {
    if (isRecord(child) && typeof child.name === "string") values[child.name] = clone(child.value);
  }
  spec.value = values;
  return spec;
}

function setWidgetOperation(
  widget: Record<string, unknown>,
  key: string,
  operation: Record<string, unknown>,
): void {
  const operations = isRecord(widget.operations) ? widget.operations : {};
  operations[key] = clone(operation);
  widget.operations = operations;
  const name = typeof widget.name === "string" ? widget.name : "";
  if (key === widgetKey(name, [])) widget.operation = clone(operation);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function integerArray(value: unknown, positive: boolean): value is number[] {
  return Array.isArray(value)
    && value.every((candidate) => Number.isSafeInteger(candidate) && (!positive || candidate > 0))
    && new Set(value).size === value.length;
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const output = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    output[key] = isRecord(value) && isRecord(output[key])
      ? deepMerge(output[key], value)
      : clone(value);
  }
  return output;
}

function isLongService(command: string): boolean {
  return command === "export"
    || command === "publish"
    || command === "upload"
    || command === "packages"
    || command.startsWith("packages.");
}

function packageNames(payload: Record<string, unknown>, allowEmpty: boolean): string[] {
  const values: unknown[] = [];
  if (payload.package !== undefined) values.push(payload.package);
  if (payload.packages !== undefined) {
    if (!Array.isArray(payload.packages)) {
      throw new ControllerError(
        "invalid_request",
        "packages must be an array of package names",
        400,
      );
    }
    values.push(...payload.packages);
  }
  if (!values.every((value) => typeof value === "string")) {
    throw new ControllerError(
      "invalid_request",
      "packages must be an array of package names",
      400,
    );
  }
  const packages = uniqueStrings(values as string[]).sort();
  const invalid = packages.filter((name) => !/^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/.test(name));
  if (invalid.length > 0) {
    throw new ControllerError(
      "invalid_request",
      `invalid package name: ${invalid.join(", ")}`,
      400,
    );
  }
  if (!allowEmpty && packages.length === 0) {
    throw new ControllerError("invalid_request", "at least one package is required", 400);
  }
  return packages;
}

function packageMissing(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.missing)) return [];
  return value.missing.filter((item): item is string => typeof item === "string");
}

function parseStoredUpload(
  value: unknown,
): { uploadId: string; value: Array<Record<string, unknown>> } {
  if (!isRecord(value)
    || typeof value.uploadId !== "string"
    || value.uploadId.length === 0
    || !Array.isArray(value.value)
    || value.value.some((file) => !isRecord(file)
      || typeof file.name !== "string"
      || file.name.length === 0
      || typeof file.path !== "string"
      || file.path.length === 0
      || typeof file.size !== "number"
      || !Number.isSafeInteger(file.size)
      || file.size < 0)) {
    throw new ControllerError(
      "invalid_service_response",
      "upload service returned invalid data",
      503,
    );
  }
  return {
    uploadId: value.uploadId,
    value: clone(value.value as Array<Record<string, unknown>>),
  };
}

function parseRuntimeVariables(
  raw: unknown,
  graph: ReactiveGraph,
  cells: readonly CellRecord[],
): RuntimeVariable[] {
  if (!Array.isArray(raw) || raw.length > MAX_RUNTIME_VARIABLES) {
    throw new ControllerError("invalid_engine_response", "variable snapshot is invalid", 503);
  }
  const variables: RuntimeVariable[] = [];
  const names = new Set<string>();
  for (const candidate of raw) {
    if (!isRecord(candidate)
      || typeof candidate.name !== "string"
      || candidate.name.length === 0
      || new TextEncoder().encode(candidate.name).byteLength > 1_024
      || hasUnpairedSurrogate(candidate.name)
      || names.has(candidate.name)
      || typeof candidate.class !== "string"
      || candidate.class.length === 0
      || new TextEncoder().encode(candidate.class).byteLength > 1_024
      || hasUnpairedSurrogate(candidate.class)
      || typeof candidate.size !== "number"
      || !Number.isSafeInteger(candidate.size)
      || candidate.size < 0
      || typeof candidate.widget !== "boolean") {
      throw new ControllerError("invalid_engine_response", "variable snapshot is invalid", 503);
    }
    let dim: number[] | null = null;
    if (candidate.dim !== null && candidate.dim !== undefined) {
      if (!Array.isArray(candidate.dim) || candidate.dim.length > 64
        || candidate.dim.some((value) => typeof value !== "number"
          || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)) {
        throw new ControllerError("invalid_engine_response", "variable dimensions are invalid", 503);
      }
      dim = [...candidate.dim] as number[];
    }
    const summary = candidate.value_summary;
    if (summary !== undefined && summary !== null
      && (typeof summary !== "string"
        || new TextEncoder().encode(summary).byteLength > 160
        || hasUnpairedSurrogate(summary))) {
      throw new ControllerError("invalid_engine_response", "variable summary is invalid", 503);
    }
    names.add(candidate.name);
    const owner = graph.definitionOwner(candidate.name) ?? null;
    const ownerCell = owner === null ? undefined : cells.find((cell) => cell.id === owner);
    if (ownerCell !== undefined
      && (ownerCell.status !== "done" || ownerCell.options.disabled === true)) continue;
    const revision = ownerCell?.revision ?? null;
    variables.push({
      name: candidate.name,
      owner,
      revision,
      class: candidate.class,
      dim,
      size: candidate.size,
      widget: candidate.widget,
      ...(typeof summary === "string" ? { valueSummary: summary } : {}),
    });
  }
  return variables;
}

function collectArtifacts(outputs: readonly unknown[]): string[] {
  const artifacts = new Set<string>();
  const visit = (value: unknown): void => {
    if (artifacts.size >= 4_096) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.artifact === "string"
      && value.artifact.length > 0
      && value.artifact.length <= 1_024
      && !value.artifact.startsWith(".")
      && !/[\\/]/.test(value.artifact)) {
      artifacts.add(value.artifact);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(outputs);
  return [...artifacts];
}

function serviceResultError(value: unknown, operationId: string): ControllerError | null {
  if (!isRecord(value) || (value.ok !== false && value.status !== "error" && value.status !== "failed")) {
    return null;
  }
  const error = isRecord(value.error) ? value.error : {};
  const code = typeof error.code === "string" ? error.code : "service_error";
  const message = typeof error.message === "string"
    ? error.message
    : "package installation failed";
  return new ControllerError(code, message, errorStatus(code), {
    operationId,
    result: clone(value),
  });
}

function operationDependsOnRuntime(kind: OperationRecord["kind"]): boolean {
  return kind === "run"
    || kind === "widget"
    || kind === "widget-reset"
    || kind === "inspect"
    || kind === "lazy-output"
    || kind === "table-page"
    || kind === "interrupt";
}

function assertNever(value: never): never {
  throw new ControllerError("invalid_request", `unsupported command: ${String(value)}`, 400);
}
