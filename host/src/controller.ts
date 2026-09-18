import { randomUUID } from "node:crypto";

import {
  analysisDiagnosticSchema,
  analysisResultSchema,
  commandAdmissionSchema,
  documentChangeSchema,
  engineEventSchema,
  engineHandshakeSchema,
  engineResponseSchema,
  HOST_PROTOCOL,
  MAX_DEPENDENCY_EDGES,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  notebookInputSchema,
  notebookSourceByteLength,
  operationProgressSchema,
  rEnvironmentSchema,
  parseHostCommand,
  type AnalysisCellResult,
  type AnalyzerIdentity,
  type AnalysisDiagnostic,
  type CellRef,
  type CellSnapshot,
  outputRecordSchema,
  richOutputPayloadSchema,
  type CellStatus,
  type CommandAdmission,
  type CommandResult,
  type ControllerServices,
  type DocumentChange,
  type EngineAdapter,
  type EngineEvent,
  type EngineHandshake,
  type EngineRestartOptions,
  type EngineResponse,
  type EvaluationPayload,
  type HostCellState,
  type HostCommand,
  type HostConfiguration,
  type JsonValue,
  type HostError,
  type HostEvent,
  type HostEventType,
  type HostQuery,
  type HostQueryResult,
  type HostSnapshot,
  type OperationRecord,
  type WidgetOperation,
  type OutputScope,
  type RuntimeVariable,
  type Recovery,
  type RecoveryState,
  type OutputRecord,
} from "./protocol.js";
import type { ConfigResolution } from "./configuration.js";
import {
  reconcileNotebook,
  stageDocumentChanges,
  type NotebookDocument,
} from "./notebook.js";
import { toLogicalCellBody } from "./cell-body.js";
import { ReactiveGraph, type GraphCellInput } from "./graph.js";
import { tailLog } from "./output-log.js";
import { OutputStore, OutputStoreError, OUTPUT_ARTIFACT_CHUNK_BYTES } from "./outputs.js";
const INTERNAL_CLIENT_ID = "internal";

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
const R_INTEGER_MAX = 2_147_483_647;
export interface ControllerOptions {
  engine: EngineAdapter;
  outputStore: OutputStore;
  /**
   * The complete in-memory source document. Semantic-only callers remain
   * structurally compatible; physical records are retained when supplied.
   */
  notebook: NotebookDocument;
  services?: ControllerServices;
  configResolution: ConfigResolution;
  layout?: unknown;
  deferStartup?: boolean;
  initialDirty?: boolean;
  epoch?: string;
  journalLimit?: number;
  journalByteLimit?: number;
  disk?: HostSnapshot["disk"];
  sidecars?: HostSnapshot["sidecars"];
  rEnvironment?: HostSnapshot["runtime"]["rEnvironment"];
  requestedRscript?: string;
  initialDocumentRevision?: number;
  durableCommit?: (input: DurableCommitInput) => Promise<void>;
  sourceCommit?: SourceCommitHandler;
  getRecoveryState?: () => Promise<RecoveryState>;
}

export interface DurableCommitInput {
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly delta: {
    readonly document: NotebookDocument;
    readonly created: Record<string, string>;
    readonly edited: ReadonlyArray<{ id: string; revision: number }>;
    readonly deleted: readonly string[];
  };
  readonly fingerprint: string;
}
export type SourceCommitKind = "transaction" | "runtime" | "sidecar" | "save" | "save-as" | "reload-source" | "watcher";

export interface SourceDiskExpectation {
  readonly digest: string | null;
  readonly version: string | null;
}

export interface SourceCommitRequest {
  readonly kind: SourceCommitKind;
  readonly expectedDocumentRevision: number;
  readonly expectedDisk?: SourceDiskExpectation;
  readonly expectedDestination?: { expectedDiskDigest: string; expectedDiskVersion: string };
  readonly expectedSidecarVersion?: string | null;
  readonly sidecar?: "config" | "layout" | "packages";
  readonly operationId?: string;
  readonly fingerprint?: string;
  readonly path?: string;
  readonly patch?: Record<string, unknown>;
  readonly packages?: readonly string[];
  readonly layout?: JsonValue;
  readonly document?: NotebookDocument;
  readonly delta?: DurableCommitInput["delta"];
}
export interface SourcePublication {
  readonly document: NotebookDocument;
  readonly path: string | null;
  readonly configResolution: ConfigResolution;
  readonly layout: JsonValue;
  readonly disk: HostSnapshot["disk"];
  readonly sidecars: HostSnapshot["sidecars"];
  readonly dirty: boolean;
  readonly advanceRevision: boolean;
  readonly invalidateRuntime?: boolean;
  readonly rEnvironment?: HostSnapshot["runtime"]["rEnvironment"];
}

export interface SourceCommitContext {
  readonly kind: SourceCommitKind;
  readonly fromRevision: number;
  readonly expectedDocumentRevision: number;
  readonly operationId?: string;
  readonly document: NotebookDocument;
  readonly path: string | null;
  readonly configResolution: ConfigResolution;
  readonly layout: JsonValue;
  readonly disk: HostSnapshot["disk"];
  readonly sidecars: HostSnapshot["sidecars"];
  readonly dirty: boolean;
  readonly preparePublication: (publication: SourcePublication) => SourcePublicationBinder;
}

/** Applies a prepared publication atomically for observable source state. */
export type SourcePublicationBinder = () => void;
export type SourceCommitHandler = (
  request: SourceCommitRequest,
  context: SourceCommitContext,
) => Promise<unknown>;
export interface RuntimeContextReservation {
  readonly release: () => void;
}

interface PreparedSourcePublication {
  readonly publication: SourcePublication;
  readonly staged: ReturnType<typeof stageDocumentChanges>;
}

interface CellRecord {
  id: string;
  type: "code" | "markdown";
  body: string[];
  options: Record<string, unknown>;
  revision: number;
  status: Exclude<CellStatus, "disabled">;
  outputs: OutputRecord[];
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
  clientId: string;
}

interface ActiveEvaluation {
  job: EvaluationJob;
  requestId?: number;
  queuedCancellation?: AbortController;
  lastSequence: number;
  cancelMode: "source" | "widget" | "stop" | null;
  interruptSent: boolean;
  streamedOutputs: OutputRecord[];
  completion?: EngineResponse;
  protocolFailure?: ControllerError;
}

interface CommandEntry {
  operationId: string;
  clientId: string;
  commandSequence: number;
  fingerprint: string;
  admission: Promise<CommandAdmission>;
  terminal: Promise<unknown>;
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
  created: Array<{ creationId: string; id: string; revision: number }>;
}


interface PendingButtonReset {
  key: string;
  name: string;
  path: string[];
  owner: string;
  revision: number;
  record: OutputRecord;
  triggerOperationId: string;
  triggerClientId: string;
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
    } as HostError;
  }
}

export class Controller {
  private readonly engine: EngineAdapter;
  private readonly outputStore: OutputStore;
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
  private readonly clientHighWater = new Map<string, number>();
  private readonly activeClients = new Set<string>();
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
    clientId: string;
    name: string;
    owner: string | null;
    revision: number | null;
  } | null = null;
  private readonly pendingLazyOutputs = new Map<
    string,
    { operationId: string; clientId: string; owner: string; recordId: string; revision: number; kernelEpoch: string }
  >();
  private readonly pendingTablePages = new Map<
    string,
    { operationId: string; clientId: string; owner: string; recordId: string; revision: number; kernelEpoch: string }
  >();
  private readonly pendingUploads = new Map<
    string,
    {
      name: string;
      path: string[];
      key: string;
      owner: string;
      revision: number;
      record: OutputRecord;
      uploadId: string | null;
      source: "editor" | "app" | "mcp" | "cli";
      clientId: string;
    }
  >();
  private eventJournalBytes = 0;
  private sourceCommitTail: Promise<void> = Promise.resolve();
  private durableCommit?: ControllerOptions["durableCommit"];
  private sourceCommit?: ControllerOptions["sourceCommit"];
  private getRecoveryState?: ControllerOptions["getRecoveryState"];
  private readonly editorDiagnostics = new Map<string, AnalysisDiagnostic[]>();
  private readonly serviceErrors: HostSnapshot["serviceErrors"] = {};
  private variableGeneration = 0;
  private variables: RuntimeVariable[] = [];
  private variableRefreshRequested = false;
  private variableRefreshInFlight = false;
  private variableRefreshTimer: NodeJS.Timeout | undefined;

  private sourceDocument: NotebookDocument;
  private cells: CellRecord[];
  private graphValue = new ReactiveGraph([]);
  private pathValue: string | null;
  private metadata: Record<string, unknown>;
  private configResolution: ConfigResolution;
  private layout: unknown;
  private executionMode: "automatic" | "lazy";
  private runOnStartup: boolean;
  private readonly deferStartup: boolean;
  private startupActivated = false;
  private changed: boolean;
  private documentRevisionValue = 0;
  private version = 0;
  private cursorValue = 0;
  private runtimeSignature: string | undefined;
  private runCounter = 0;
  private widgetToken = 0;
  private analysisGeneration = 0;
  private analysisInFlight: Promise<void> | null = null;
  private analysisRestarting = false;
  private analyzerIdentity = "";
  private analysisEnvironmentIdValue: string | null = null;
  private kernelEpochValue: string | null = null;
  private rEnvironmentValue: HostSnapshot["runtime"]["rEnvironment"] = null;
  private readonly requestedRscript: string | undefined;
  private diskValue: HostSnapshot["disk"] = { state: "untitled", digest: null, version: null, error: null };
  private sidecarsValue: HostSnapshot["sidecars"] = {
    config: { state: "absent", digest: null, version: null, error: null },
    layout: { state: "absent", digest: null, version: null, error: null },
    packages: { state: "absent", digest: null, version: null, error: null },
  };
  private handshake: EngineHandshake | null = null;
  private documentReady = false;
  private started = false;
  private starting = false;
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
  private packageOperationClientId: string | undefined;
  private runPreparationActive = false;
  private runPreparationCancellation: {
    operationId: string;
    clientId: string;
    cancelled: boolean;
  } | null = null;
  private widgetReconciliationScheduled = false;
  private widgetReconciliationPreparing = false;
  private runtimeGeneration = 0;
  private lastValue: unknown | null = null;
  private runtimeAvailabilityError: HostError | null = null;
  private lastActionError: HostError | null = null;
  private engineFailureUnsubscribe: (() => void) | null = null;
  private startPromise: Promise<HostSnapshot> | null = null;
  private analyzerStartupAttempted = false;
  private kernelStartupAttempted = false;
  private engineRestarting = false;
  private runtimeContextReservation: string | undefined;

  constructor(options: ControllerOptions) {
    this.engine = options.engine;
    this.outputStore = options.outputStore;
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
    let sourceDocument: NotebookDocument;
    try {
      const semantic = {
        ...(options.notebook.path === undefined ? {} : { path: options.notebook.path }),
        ...(options.notebook.metadata === undefined ? {} : { metadata: options.notebook.metadata }),
        cells: options.notebook.cells.map((cell) => ({
          id: cell.id,
          type: cell.type ?? "code",
          body: [...cell.body],
          options: cell.options === undefined ? {} : { ...cell.options },
          revision: cell.revision,
        })),
      };
      notebook = notebookInputSchema.parse(semantic);
      sourceDocument = reconcileNotebook(options.notebook, notebook);
    } catch (error) {
      throw new ControllerError("invalid_notebook", messageOf(error), 400);
    }
    this.sourceDocument = sourceDocument;
    this.pathValue = notebook.path ?? null;
    const initialDocumentRevision = options.initialDocumentRevision ?? 0;
    if (!Number.isSafeInteger(initialDocumentRevision) || initialDocumentRevision < 0) {
      throw new ControllerError("invalid_request", "initial document revision must be a non-negative safe integer", 400);
    }
    this.documentRevisionValue = initialDocumentRevision;
    this.durableCommit = options.durableCommit;
    this.sourceCommit = options.sourceCommit;
    this.getRecoveryState = options.getRecoveryState;
    this.rEnvironmentValue = options.rEnvironment ?? null;
    this.requestedRscript = options.requestedRscript;
    this.diskValue = options.disk ?? {
      state: this.pathValue === null ? "untitled" : "absent", digest: null, version: null, error: null,
    };
    this.sidecarsValue = options.sidecars ?? this.sidecarsValue;
    this.metadata = clone(notebook.metadata);
    this.configResolution = clone(options.configResolution);
    this.layout = clone(options.layout ?? null);
    this.executionMode = this.effectiveConfig.on_cell_change;
    this.runOnStartup = this.effectiveConfig.on_startup;
    this.deferStartup = options.deferStartup ?? false;
    this.changed = options.initialDirty ?? false;
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
    this.installInitialMarkdownOutputs();
    this.documentReady = true;
  }

  private get effectiveConfig(): ConfigResolution["effective"] {
    return this.configResolution.effective;
  }
  get epoch(): string {
    return this.epochValue;
  }

  get cursor(): number {
    return this.cursorValue;
  }

  async startAnalyzer(): Promise<HostSnapshot> {
    this.assertNotClosed();
    if (this.analyzerAvailable) return this.snapshot();
    if (this.startPromise !== null) {
      await this.startPromise;
      if (this.analyzerAvailable) return this.snapshot();
    }
    this.starting = true;
    const promise = this.startAnalyzerOnce();
    this.startPromise = promise;
    this.emit("runtime", this.runtimeSnapshot());
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
      if (!this.started) this.starting = false;
    }
  }

  async start(): Promise<HostSnapshot> {
    this.assertNotClosed();
    if (this.kernelAvailable && this.analyzerAvailable) return this.snapshot();
    if (this.startPromise !== null) {
      await this.startPromise;
      if (this.kernelAvailable && this.analyzerAvailable) return this.snapshot();
    }
    this.starting = true;
    const promise = this.startOnce();
    this.startPromise = promise;
    this.emit("runtime", this.runtimeSnapshot());
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
      if (!this.started) this.starting = false;
    }
  }

  private async startAnalyzerOnce(): Promise<HostSnapshot> {
    const generation = this.runtimeGeneration;
    if (this.engineFailureUnsubscribe === null && this.engine.onFailure !== undefined) {
      this.engineFailureUnsubscribe = this.engine.onFailure((role, error) => {
        this.handleEngineFailure(role, error);
      });
    }
    this.analyzerStartupAttempted = true;
    let analyzer: AnalyzerIdentity;
    try {
      if (this.engine.startAnalyzer === undefined) {
        throw new Error("engine does not support analyzer-only startup");
      }
      analyzer = await this.engine.startAnalyzer();
      if (this.engine.environment !== undefined) this.rEnvironmentValue = clone(this.engine.environment);
    } catch (error) {
      this.starting = false;
      const failure = hostError("analysis_unavailable", messageOf(error));
      this.recordRuntimeAvailabilityError(failure);
      this.replaceLastActionError(failure);
      throw new ControllerError(failure.code, failure.message, 503);
    }
    this.assertStartCurrent(generation);
    this.starting = false;
    this.started = true;
    this.analyzerAvailable = true;
    this.analysisEnvironmentIdValue = analyzer.analysisEnvironmentId;
    this.clearRuntimeAvailabilityError();
    try {
      await this.ensureCurrentAnalysis();
      if (!this.graphValue.resourceLimited) this.replaceLastActionError(null);
    } catch (error) {
      const failure = asControllerError(error, "analysis_unavailable", 503);
      this.replaceLastActionError(failure.toJSON());
    }
    this.bump("notebook", { ready: false });
    this.emit("runtime", this.runtimeSnapshot());
    this.emitGraph();
    return this.snapshot();
  }

  private async startOnce(): Promise<HostSnapshot> {
    const generation = this.runtimeGeneration;
    if (this.engineFailureUnsubscribe === null && this.engine.onFailure !== undefined) {
      this.engineFailureUnsubscribe = this.engine.onFailure((role, error) => {
        this.handleEngineFailure(role, error);
      });
    }
    this.analyzerStartupAttempted = true;
    this.kernelStartupAttempted = true;
    let handshake: EngineHandshake;
    try {
      handshake = engineHandshakeSchema.parse(await this.engine.start());
      if (this.engine.environment !== undefined) this.rEnvironmentValue = clone(this.engine.environment);
    } catch (error) {
      this.starting = false;
      if (this.closed || generation !== this.runtimeGeneration) {
        throw new ControllerError("session_stopped", "session is stopped", 409);
      }
      this.kernelAvailable = false;
      this.analyzerAvailable = false;
      const failure = hostError("engine_start_failed", messageOf(error));
      this.recordRuntimeAvailabilityError(failure);
      this.replaceLastActionError(failure);
      throw new ControllerError("engine_start_failed", messageOf(error), 503);
    }
    if (this.closed || generation !== this.runtimeGeneration) {
      throw new ControllerError("session_stopped", "session is stopped", 409);
    }
    this.starting = false;
    this.handshake = handshake;
    this.kernelEpochValue = handshake.kernel?.kernelEpoch ?? (handshake.kernelReady ? randomUUID() : null);
    this.outputStore.setIdentity({ documentRevision: this.documentRevisionValue, kernelEpoch: this.kernelEpochValue });
    this.started = true;
    this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
    this.analyzerAvailable = handshake.analyzerReady;
    if (!this.kernelAvailable || !this.analyzerAvailable) {
      const failure = hostError(
        "engine_not_ready",
        "R kernel, analyzer, and capture services must be ready before execution",
      );
      this.recordRuntimeAvailabilityError(failure);
      this.replaceLastActionError(failure);
      this.emit("runtime", this.runtimeSnapshot());
      return this.snapshot();
    }

    this.clearRuntimeAvailabilityError();
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
    return clone(this.operationFor(operationId, INTERNAL_CLIENT_ID) ?? null);
  }

  snapshot(clientId?: string): HostSnapshot {
    const snapshot: HostSnapshot = {
      protocol: HOST_PROTOCOL,
      epoch: this.epochValue,
      cursor: this.cursorValue,
      version: this.version,
      documentRevision: this.documentRevisionValue,
      path: this.pathValue,
      metadata: clone(this.metadata) as HostSnapshot["metadata"],
      config: clone(this.effectiveConfig) as HostSnapshot["config"],
      layout: clone(this.layout) as HostSnapshot["layout"],
      dirty: this.changed,
      changed: this.changed,
      disk: clone(this.diskValue),
      sidecars: clone(this.sidecarsValue),
      runtime: this.runtimeSnapshot(),
      cells: this.cells.map((cell) => this.publicCell(cell)),
      graph: clone(this.graphValue.state),
      variables: clone(this.variables),
      editorDiagnostics: Object.fromEntries(
        [...this.editorDiagnostics].map(([id, diagnostics]) => [id, clone(diagnostics)]),
      ),
      serviceErrors: clone(this.serviceErrors),
      operations: [...this.operations.values()].map(clone),
      lastValue: clone(this.lastValue) as HostSnapshot["lastValue"],
      lastActionError: clone(this.lastActionError),
      capabilities: [...(this.handshake?.capabilities ?? [])],
      activeClientIds: [...this.activeClients],
      ...(clientId === undefined ? {} : { nextCommandSequence: (this.clientHighWater.get(clientId) ?? 0) + 1 }),
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

  private operationKey(clientId: string, operationId: string): string {
    return commandKey(clientId, operationId);
  }

  private operationFor(operationId: string, clientId: string): OperationRecord | undefined {
    return this.operations.get(this.operationKey(clientId, operationId));
  }

  private operationForKey(key: string): OperationRecord | undefined {
    return this.operations.get(key);
  }

  configuration(): HostConfiguration {
    return {
      rscript: this.rEnvironmentValue?.rscript ?? this.requestedRscript ?? null,
      executionMode: this.executionMode,
      runOnStartup: this.runOnStartup,
      deferStartup: this.deferStartup,
    };
  }

  operation(id: string, clientId: string): OperationRecord | undefined {
    const operation = this.operationFor(id, clientId);
    return operation === undefined ? undefined : clone(operation);
  }

  hasActiveOperations(): boolean {
    for (const operation of this.operations.values()) if (!isTerminal(operation.status)) return true;
    return false;
  }

  publishPackageProgress(operationId: string, progress: unknown, clientId?: string): void {
    if (this.closed) return;
    const owner = clientId ?? this.packageOperationClientId ?? INTERNAL_CLIENT_ID;
    const operation = this.operationFor(operationId, owner);
    if (operation === undefined || operation.kind !== "packages-install" || operation.status !== "running") return;
    const parsed = operationProgressSchema.safeParse(progress);
    if (!parsed.success) return;
    const value = parsed.data;
    operation.progress = {
      phase: value.phase,
      ...(value.stream === undefined ? {} : { stream: value.stream }),
      ...(value.text === undefined ? {} : { text: value.text }),
      ...(value.data === undefined ? {} : { data: value.data }),
    };
    this.rememberOperation(operation);
  }

  recordActionError(message: string, code = "internal_error"): void {
    this.assertNotClosed();
    this.replaceLastActionError(hostError(code, message));
  }

  recordRuntimeAvailabilityError(error: HostError): void {
    this.assertNotClosed();
    if (!this.setRuntimeAvailabilityError(error)) return;
    this.bump("runtime", this.runtimeSnapshot());
  }

  private setRuntimeAvailabilityError(error: HostError): boolean {
    const next = clone(error);
    if (stableStringify(this.runtimeAvailabilityError) === stableStringify(next)) return false;
    this.runtimeAvailabilityError = next;
    return true;
  }

  private clearRuntimeAvailabilityError(): void {
    this.runtimeAvailabilityError = null;
  }

  awaitOperation(id: string, clientId: string, signal?: AbortSignal): Promise<OperationRecord> {
    const key = this.operationKey(clientId, id);
    const current = this.operationFor(id, clientId);
    if (current === undefined) {
      return Promise.reject(new ControllerError("not_found", `no such operation: ${id}`, 404));
    }
    if (isTerminal(current.status)) return Promise.resolve(clone(current));
    return new Promise<OperationRecord>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const waiters = this.operationWaiters.get(key) ?? new Set();
      const finish = (operation: OperationRecord): void => {
        signal?.removeEventListener("abort", abort);
        resolve(clone(operation));
      };
      const abort = (): void => {
        waiters.delete(finish);
        if (waiters.size === 0) this.operationWaiters.delete(key);
        reject(abortError());
      };
      waiters.add(finish);
      this.operationWaiters.set(key, waiters);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  dispatch(input: HostCommand | unknown): Promise<CommandAdmission> {
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
    const key = commandKey(command.clientId, command.operationId);
    const fingerprint = stableStringify(command);
    const prior = this.commandEntries.get(key);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint || prior.commandSequence !== command.commandSequence) {
        return Promise.resolve(this.rejectedAdmission(command, hostError(
          "operation_id_conflict",
          "operation " + command.operationId + " was already used for a different command",
          command.operationId,
        )));
      }
      return prior.admission;
    }
    if (command.commandSequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.resolve(this.rejectedAdmission(command, hostError(
        'command_sequence_exhausted', 'command sequence counter is exhausted', command.operationId,
      )));
    }
    const previous = this.clientHighWater.get(command.clientId) ?? 0;
    const expected = previous + 1;
    if (command.commandSequence <= previous) {
      return Promise.resolve(this.rejectedAdmission(command, hostError(
        "operation_expired",
        "command sequence " + command.commandSequence + " is no longer retained",
        command.operationId,
        { expectedCommandSequence: previous + 1, nextCommandSequence: command.commandSequence, sequenceConsumed: false },
      )));
    }
    if (command.commandSequence !== expected) {
      return Promise.resolve(this.rejectedAdmission(command, hostError(
        "command_sequence_gap",
        "expected command sequence " + expected + ", received " + command.commandSequence,
        command.operationId,
        { expectedCommandSequence: expected, nextCommandSequence: command.commandSequence, sequenceConsumed: false },
      )));
    }
    if (!this.clientHighWater.has(command.clientId) && this.activeClients.size >= 128) {
      return Promise.resolve(this.rejectedAdmission(command, hostError(
        "client_limit", "too many active client sessions", command.operationId,
      )));
    }
    this.registerClient(command.clientId);
    this.clientHighWater.set(command.clientId, command.commandSequence);
    if (command.type === "run" && command.startup === true && this.startupActivated) {
      const admission = Promise.resolve(this.rejectedAdmission(command, hostError(
        "startup_already_activated",
        "startup activation was already claimed by another client",
        command.operationId,
        { sequenceConsumed: true },
      ), true));
      this.commandEntries.set(key, {
        operationId: command.operationId,
        clientId: command.clientId,
        commandSequence: command.commandSequence,
        fingerprint,
        admission,
        terminal: Promise.resolve(undefined),
      });
      this.trimCommandEntries();
      return admission;
    }
    let operation: OperationRecord;
    try {
      operation = this.createOperation(command.operationId, command.type, command.clientId, command.commandSequence);
    } catch (error) {
      return Promise.reject(error);
    }
    if (command.type === "run" && !this.startupActivated) {
      this.startupActivated = true;
      this.emit("runtime", this.runtimeSnapshot(), { operationId: command.operationId, clientId: command.clientId, commandSequence: command.commandSequence });
    }
    this.emit("receipt", { operation: clone(operation), commandType: command.type }, {
      operationId: command.operationId, clientId: command.clientId, commandSequence: command.commandSequence,
    });
    const terminal = Promise.resolve().then(() => this.executeCommand(command));
    void terminal.catch(() => undefined);
    const admission = Promise.resolve({
      epoch: this.epochValue, clientId: command.clientId, operationId: command.operationId,
      commandSequence: command.commandSequence, accepted: true, sequenceConsumed: true,
      operation: clone(operation), error: null, nextCommandSequence: command.commandSequence + 1,
    });
    this.commandEntries.set(key, { operationId: command.operationId, clientId: command.clientId, commandSequence: command.commandSequence, fingerprint, admission, terminal });
    this.trimCommandEntries();
    return admission;
  }
  /** Register an authenticated client lease exactly once. */
  registerClient(clientId: string): void {
    this.assertNotClosed();
    if (this.activeClients.has(clientId)) return;
    if (this.activeClients.size >= 128) {
      throw new ControllerError("client_limit", "too many active client sessions", 429);
    }
    this.activeClients.add(clientId);
    this.emitActiveClientsChanged(clientId);
  }

  /** Release an authenticated lease without rewinding its high-water mark. */
  releaseClient(clientId: string): void {
    if (!this.activeClients.delete(clientId)) return;
    this.emitActiveClientsChanged(clientId);
  }

  async query(input: HostQuery, callerClientId?: string): Promise<HostQueryResult> {
    this.assertNotClosed();
    const query = input;
    let result: unknown;
    switch (query.type) {
      case "notebook":
        result = {
          protocol: HOST_PROTOCOL,
          epoch: this.epochValue,
          cursor: this.cursorValue,
          version: this.version,
          documentRevision: this.documentRevisionValue,
          path: this.pathValue,
          metadata: clone(this.metadata),
          config: clone(this.effectiveConfig),
          dirty: this.changed,
          changed: this.changed,
          disk: clone(this.diskValue),
          sidecars: clone(this.sidecarsValue),
          runtime: this.runtimeSnapshot(),
          capabilities: [...(this.handshake?.capabilities ?? [])],
          nextCommandSequence: (this.clientHighWater.get(callerClientId ?? "internal") ?? 0) + 1,
          activeClientIds: [...this.activeClients],
          cells: this.cells.map((cell) => ({ id: cell.id, type: cell.type, options: clone(cell.options), revision: cell.revision })),
        };
        break;
      case "cells": {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        result = this.cells.slice(offset, offset + limit).map((cell) => this.publicCell(cell));
        break;
      }
      case "cell": {
        const cell = this.cellById(query.cellId);
        if (cell === undefined) throw new ControllerError("not_found", "no such cell: " + query.cellId, 404);
        result = this.publicCell(cell);
        break;
      }
      case "graph": result = clone(this.graphValue.state); break;
      case "outputs": {
        const cells = query.cellId === undefined ? this.cells : [this.requireCell(query.cellId)];
        result = cells.flatMap((cell) => clone(cell.outputs));
        break;
      }
      case "output": result = await this.readOutputPage(query); break;
      case "operation": {
        if (callerClientId !== undefined && query.clientId !== undefined && query.clientId !== callerClientId) {
          throw new ControllerError("not_found", "no such operation: " + query.operationId, 404);
        }
        const owner = callerClientId ?? query.clientId;
        if (owner === undefined) throw new ControllerError("not_found", "operation owner is required", 404);
        const operation = this.operations.get(commandKey(owner, query.operationId));
        if (operation === undefined) throw new ControllerError("not_found", "no such operation: " + query.operationId, 404);
        result = clone(operation);
        break;
      }
      case "events": result = this.recover(query.epoch, query.cursor); break;
      case "config": result = {
        effective: clone(this.effectiveConfig),
        layers: clone(this.configResolution.layers),
        provenance: clone(this.configResolution.provenance),
        sidecar: clone(this.sidecarsValue.config),
      }; break;
      case "layout": result = { layout: clone(this.layout), sidecar: clone(this.sidecarsValue.layout) }; break;
      case "recovery": result = this.getRecoveryState === undefined
        ? { branches: [], pending: false, corruption: null }
        : await this.getRecoveryState(); break;
      case "packages-status": result = await this.callService("packages.status", {}); break;
      case "check":
        await this.ensureCurrentAnalysis();
        result = { documentRevision: this.documentRevisionValue, issues: this.graphValue.validate(), executionBlockedReason: this.runtimeSnapshot().executionBlockedReason };
        break;
      case "source": result = this.cells.map((cell) => ({ id: cell.id, type: cell.type, body: [...cell.body], revision: cell.revision, options: clone(cell.options) })); break;
      case "help": result = await this.callService("help", { contents: query.contents }); break;
      default: throw assertNever(query);
    }
    return { epoch: this.epochValue, documentRevision: this.documentRevisionValue, cursor: this.cursorValue, result: clone(result) as HostQueryResult["result"] };
  }

  private async readOutputPage(query: Extract<HostQuery, { type: "output" }>): Promise<Record<string, unknown>> {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? OUTPUT_ARTIFACT_CHUNK_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ControllerError("invalid_request", "output offset must be a non-negative safe integer", 400);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > OUTPUT_ARTIFACT_CHUNK_BYTES) {
      throw new ControllerError("invalid_request", "output limit exceeds the bounded page size", 400);
    }
    let resource;
    try {
      resource = this.outputStore.openArtifactResource(query.handle);
    } catch (error) {
      if (!(error instanceof OutputStoreError)) throw error;
      const code = error.code === "not_found" ? "not_found" : error.code === "output_expired" ? "output_expired" : "invalid_request";
      const status = code === "not_found" ? 404 : code === "output_expired" ? 410 : 400;
      throw new ControllerError(code, error.message, status);
    }
    try {
      const descriptor = resource.descriptor;
      const readLimit = Math.min(OUTPUT_ARTIFACT_CHUNK_BYTES, Math.max(7, limit + 6));
      const essence = descriptor.mimeType.split(";", 1)[0]!.trim().toLowerCase();
      const textual = essence.startsWith("text/")
        || essence === "application/json"
        || essence.endsWith("+json")
        || essence === "application/javascript"
        || essence === "application/xml";
      const bytes = await resource.read(offset, readLimit);
      const binaryPage = () => {
        const page = bytes.subarray(0, limit);
        return {
          encoding: "base64",
          offset,
          nextOffset: offset + page.byteLength,
          eof: offset + page.byteLength >= descriptor.byteLength,
          data: Buffer.from(page).toString("base64"),
        };
      };
      if (!textual) return binaryPage();
      if (bytes.byteLength === 0) {
        if (offset < descriptor.byteLength) {
          throw new ControllerError("output_expired", "artifact reader returned no bytes before end of artifact", 410);
        }
        return { encoding: "utf8", offset, nextOffset: offset, eof: true, data: "" };
      }
      if ((bytes[0]! & 0xc0) === 0x80) return binaryPage();
      const start = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let end = Math.min(bytes.length, start + limit);
      let data: string | undefined;
      while (end > start) {
        try {
          data = decoder.decode(bytes.subarray(start, end));
          break;
        } catch {
          end--;
        }
      }
      if (data === undefined) {
        for (let candidate = Math.max(start + limit, start + 1); candidate <= bytes.length; candidate++) {
          try {
            data = decoder.decode(bytes.subarray(start, candidate));
            end = candidate;
            break;
          } catch {
            // Extend a tiny requested page until its first complete code point fits.
          }
        }
      }
      if (data === undefined) return binaryPage();
      const nextOffset = offset + end;
      if (nextOffset <= offset && nextOffset < descriptor.byteLength) {
        throw new ControllerError("output_expired", "artifact reader did not advance", 410);
      }
      return { encoding: "utf8", offset: offset + start, nextOffset, eof: nextOffset >= descriptor.byteLength, data };
    } finally {
      resource.close();
    }
  }

  private rejectedAdmission(command: HostCommand, error: HostError, sequenceConsumed = false): CommandAdmission {
    const previous = this.clientHighWater.get(command.clientId) ?? 0;
    return {
      epoch: this.epochValue,
      clientId: command.clientId,
      operationId: command.operationId,
      commandSequence: command.commandSequence,
      accepted: false,
      sequenceConsumed,
      operation: null,
      error: clone(error),
      nextCommandSequence: sequenceConsumed ? command.commandSequence + 1 : previous + 1,
    };
  }


  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.activeClients.clear();
    await this.sourceCommitTail;
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
    this.runPreparationCancellation = null;
    this.runtimeContextReservation = undefined;
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
          operation.clientId,
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
    try {
      if (this.engineRestarting && ["run", "widget", "inspect", "lazy-output", "table-page", "format", "packages-install"].includes(command.type)) {
        throw new ControllerError(
          "operation_in_progress",
          "R engine restart is already in progress",
          409,
        );
      }
      if (!this.kernelAvailable && (command.type === 'run' || command.type === 'widget'
        || command.type === 'inspect' || command.type === 'lazy-output' || command.type === 'table-page')) {
        const availability = this.runtimeAvailabilityError;
        if (availability?.code === 'kernel_state_invalid') throw new ControllerError(availability.code, availability.message, 409);
        await this.start();
      }
      if (this.runtimeContextReservation !== undefined
        && (command.type === "run" || command.type === "widget" || command.type === "restart")) {
        this.assertNoRuntimeContextReservation();
      }
      let result: unknown;
      let deferred = false;
      switch (command.type) {
        case "transaction":
          result = await this.applyTransaction(command.changes, command.expectedDocumentRevision, command.operationId, false);
          break;
        case "run":
          if (command.startup === true && !this.runOnStartup) {
            result = { startupActivated: true, run: false };
          } else {
            result = await this.prepareRun(command);
            deferred = true;
          }
          break;
        case "interrupt":
          result = await this.interruptActiveRun(command.runId);
          break;
        case "restart":
          result = await this.restartEngine(undefined, command.replay, command.operationId, command.clientId, true);
          deferred = command.replay;
          break;
        case "widget":
          this.assertKernelEpoch(command.kernelEpoch);
          result = this.startWidgetOperation(command);
          deferred = true;
          break;
        case "inspect":
          this.assertKernelEpoch(command.kernelEpoch);
          result = this.startInspection(command.operationId, command.name, command.clientId);
          deferred = true;
          break;
        case "lazy-output":
          this.assertKernelEpoch(command.kernelEpoch);
          result = this.startLazyOutput(command.operationId, command.key, command.clientId);
          deferred = true;
          break;
        case "table-page":
          this.assertKernelEpoch(command.kernelEpoch);
          result = this.startTablePage(command);
          deferred = true;
          break;
        case "save":
          result = await this.saveNotebook(command.expectedDocumentRevision, command.operationId);
          break;
        case "save-as":
        case "reload-source":
        case "select-r":
        case "set-app":
        case "packages-declare":
        case "packages-install":
        case "publish":
          result = await this.executeTypedService(command);
          break;
        case "upload":
          result = this.startUploadOperation(command);
          deferred = true;
          break;
        case "format":
          this.assertDocumentRevision(command.expectedDocumentRevision);
          result = await this.formatSource(command.cellIds, command.expectedRevisions, command.operationId);
          break;
        case "set-runtime":
          result = await this.setRuntime(command.on_cell_change, command.on_startup, command.expectedDocumentRevision, command.operationId);
          break;
        case "set-config":
          result = await this.setConfig(command.patch, command.expectedDocumentRevision, command.expectedSidecarVersion, command.operationId);
          break;
        case "set-layout":
          result = await this.setLayout(command.layout, command.expectedDocumentRevision, command.expectedSidecarVersion, command.operationId);
          break;
        case "shutdown":
          this.assertDocumentRevision(command.expectedDocumentRevision);
          const expectedClientIds = new Set(command.expectedClientIds);
          const actualClientIds = new Set(this.activeClients);
          if (!setEqual(expectedClientIds, actualClientIds)) {
            throw new ControllerError("active_clients_changed", "active client set changed while shutdown was waiting", 409, {
              expectedClientIds: [...expectedClientIds],
              actualClientIds: [...actualClientIds],
            });
          }
          result = { closing: true, expectedClientIds: [...actualClientIds] };
          break;
        default:
          throw assertNever(command);
      }
      if (deferred) {
        const operation = this.operationFor(command.operationId, command.clientId);
        if (operation !== undefined && result !== undefined) operation.result = clone(result) as OperationRecord["result"];
      }
      if (!deferred) this.completeOperation(command.operationId, result, command.clientId);
      const settled = this.operationFor(command.operationId, command.clientId);
      if (settled === undefined) throw new ControllerError("internal_error", "operation missing after execution", 500);
      return {
        epoch: this.epochValue, operation: clone(settled), documentRevision: this.documentRevisionValue,
        version: this.version, cursor: this.cursorValue, nextCommandSequence: (this.clientHighWater.get(command.clientId) ?? command.commandSequence) + 1,
        result: result === undefined ? null : clone(result) as CommandResult["result"], error: settled.error,
      };
    } catch (error) {
      const failure = asControllerError(error);
      const hostFailure = failure.toJSON(command.operationId);
      if (!this.closed) {
        this.replaceLastActionError(hostFailure, { operationId: command.operationId });
        this.failOperation(command.operationId, hostFailure, command.clientId);
      }
      throw failure;
    }
  }

  /** Return the authoritative physical document with current semantic state applied. */
  notebookDocument(): NotebookDocument {
    const source = {
      path: this.pathValue,
      metadata: clone(this.metadata),
      cells: this.cells.map((cell) => ({
        id: cell.id,
        type: cell.type,
        body: [...cell.body],
        options: clone(cell.options),
        revision: cell.revision,
      })),
    };
    return reconcileNotebook(this.sourceDocument, source);
  }

  private stageDocument(changes: readonly DocumentChange[]): ReturnType<typeof stageDocumentChanges> {
    try {
      return stageDocumentChanges(this.notebookDocument(), changes);
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code: string }).code)
        : 'invalid_request';
      const mappedCode = code === 'cell_not_found' ? 'not_found' : code === 'stale_revision' ? 'source_conflict' : code;
      throw new ControllerError(mappedCode, messageOf(error), mappedCode === 'not_found' ? 404 : mappedCode === 'source_conflict' ? 409 : 400);
    }
  }

  /** Serialize durable source, sidecar, save, reload, and watcher mutations. */
  private assertExpectedDisk(expected: SourceDiskExpectation | undefined): void {
    if (expected === undefined) return;
    if (this.diskValue.digest !== expected.digest || this.diskValue.version !== expected.version) {
      throw new ControllerError("source_conflict", "source changed on disk while the operation was waiting", 409, {
        kind: "disk",
        expectedDigest: expected.digest,
        expectedVersion: expected.version,
        actualDigest: this.diskValue.digest,
        actualVersion: this.diskValue.version,
      });
    }
  }

  private assertExpectedSidecar(
    kind: SourceCommitRequest["sidecar"],
    expectedVersion: string | null | undefined,
  ): void {
    if (kind === undefined || expectedVersion === undefined) return;
    const actual = this.sidecarsValue[kind].version;
    if (actual !== expectedVersion) {
      throw new ControllerError("source_conflict", String(kind) + " sidecar changed while the operation was waiting", 409, {
        kind: "sidecar", sidecar: kind, expectedVersion, actualVersion: actual,
      });
    }
  }

  private prepareSourcePublication(
    publication: SourcePublication,
    request: SourceCommitRequest,
  ): PreparedSourcePublication {
    if (publication === null || typeof publication !== "object") {
      throw new ControllerError("invalid_service_response", "source publication must be an object", 503);
    }
    if (typeof publication.path !== "string" && publication.path !== null) {
      throw new ControllerError("invalid_service_response", "source publication path is invalid", 503);
    }
    if (!Array.isArray(publication.document?.cells)) {
      throw new ControllerError("invalid_service_response", "source publication document is invalid", 503);
    }
    if (typeof publication.dirty !== "boolean" || typeof publication.advanceRevision !== "boolean") {
      throw new ControllerError("invalid_service_response", "source publication flags are invalid", 503);
    }
    if (publication.advanceRevision && request.kind === "save-as" && !publication.dirty) {
      throw new ControllerError("invalid_service_response", "Save As cannot advance a clean source revision", 503);
    }
    if (
      publication.configResolution === null
      || typeof publication.configResolution !== "object"
      || !isRecord(publication.configResolution.effective)
      || !isRecord(publication.configResolution.layers)
      || !isRecord(publication.configResolution.provenance)
    ) {
      throw new ControllerError("invalid_service_response", "source publication config resolution is invalid", 503);
    }
    const document = clone({ ...publication.document, path: publication.path });
    const configResolution = clone(publication.configResolution);
    const layout = clone(publication.layout) as JsonValue;
    const disk = clone(publication.disk);
    const sidecars = clone(publication.sidecars);
    const prepared: SourcePublication = {
      document,
      path: publication.path,
      configResolution,
      layout,
      disk,
      sidecars,
      dirty: publication.dirty,
      advanceRevision: publication.advanceRevision,
      ...(publication.invalidateRuntime === undefined ? {} : { invalidateRuntime: publication.invalidateRuntime }),
      ...(Object.hasOwn(publication, "rEnvironment") ? { rEnvironment: clone(publication.rEnvironment) } : {}),
    };
    return { publication: prepared, staged: this.publishedDocumentStage(prepared.document) };
  }

  private publishedDocumentStage(document: NotebookDocument): ReturnType<typeof stageDocumentChanges> {
    const current = this.notebookDocument();
    const prior = new Map(current.cells.map((cell) => [cell.id, cell]));
    const next = new Map(document.cells.map((cell) => [cell.id, cell]));
    const changed = new Set<string>();
    const created = new Map<string, string>();
    const deleted = new Set<string>();
    for (const cell of document.cells) {
      const old = prior.get(cell.id);
      if (old === undefined) {
        created.set(cell.id, cell.id);
        changed.add(cell.id);
      } else if (old.type !== cell.type || !arrayEqual(old.body, cell.body)
        || stableStringify(old.options) !== stableStringify(cell.options)
        || old.revision !== (cell.revision ?? old.revision)) {
        changed.add(cell.id);
      }
    }
    for (const cell of current.cells) if (!next.has(cell.id)) deleted.add(cell.id);
    return { document, created, changed, deleted };
  }

  private applySourcePublication(
    preparedPublication: PreparedSourcePublication,
    request: SourceCommitRequest,
  ): void {
    const { publication, staged } = preparedPublication;
    const operationId = request.operationId ?? randomUUID();
    const currentOrder = this.cells.map((cell) => cell.id);
    const currentGraph = this.graphValue.state;
    const publishedOrder = publication.document.cells.map((cell) => cell.id);
    const orderChanged = !arrayEqual(currentOrder, publishedOrder);
    if (staged.changed.size > 0 || staged.created.size > 0 || staged.deleted.size > 0 || orderChanged) {
      this.applyStagedDocument(publication.document, staged, operationId);
    } else {
      this.sourceDocument = publication.document;
    }
    this.pathValue = publication.path;
    this.metadata = clone(publication.document.metadata ?? this.metadata);
    this.configResolution = clone(publication.configResolution);
    const graphChanged = this.graphValue.state !== currentGraph;
    const configuredMode = this.effectiveConfig.on_cell_change;
    if (configuredMode === "automatic" || configuredMode === "lazy") this.executionMode = configuredMode;
    if (typeof this.effectiveConfig.on_startup === "boolean") this.runOnStartup = this.effectiveConfig.on_startup;
    this.layout = clone(publication.layout);
    this.diskValue = clone(publication.disk);
    this.sidecarsValue = clone(publication.sidecars);
    if (Object.hasOwn(publication, "rEnvironment")) this.rEnvironmentValue = clone(publication.rEnvironment ?? null);
    if (publication.invalidateRuntime === true) {
      const statusChanges = this.invalidateRuntimeView();
      if (statusChanges.size > 0) this.emitCells(statusChanges, { operationId });
      this.emit("runtime", this.runtimeSnapshot(), { operationId });
    }
    if (publication.advanceRevision) this.commitDocumentRevision();
    for (const id of staged.changed) {
      const cell = this.cellById(id);
      if (cell?.type === "markdown") this.scheduleMarkdownRender(cell);
    }
    this.changed = publication.dirty;
    if (request.kind === "transaction") {
      const delta = request.delta;
      this.bump("transaction", {
        documentRevision: this.documentRevisionValue,
        created: delta?.created ?? {},
        updated: (delta?.edited ?? []).flatMap(({ id }) => {
          const cell = this.cellById(id);
          return cell === undefined ? [] : [this.publicCell(cell)];
        }),
        deleted: delta?.deleted ?? [],
        order: this.cells.map((cell) => cell.id),
        metadata: clone(this.metadata),
        config: clone(this.effectiveConfig),
        layout: clone(this.layout),
        analysisPending: this.analysisNeeded.size > 0,
        ...(graphChanged ? { graph: clone(this.graphValue.state) } : {}),
      }, { operationId });
    } else {
      const authoritativeReload = request.kind === "reload-source" || request.kind === "watcher";
      this.bump("notebook", {
        sourceCommit: request.kind,
        documentRevision: this.documentRevisionValue,
        path: this.pathValue,
        config: clone(this.effectiveConfig),
        layout: clone(this.layout),
        disk: clone(this.diskValue),
        sidecars: clone(this.sidecarsValue),
        dirty: this.changed,
        ...(authoritativeReload ? {
          created: Object.fromEntries(staged.created),
          updated: this.cells.map((cell) => this.publicCell(cell)),
          deleted: [...staged.deleted],
          order: this.cells.map((cell) => cell.id),
          metadata: clone(this.metadata),
          analysisPending: this.analysisNeeded.size > 0,
        } : {}),
        ...(graphChanged ? { graph: clone(this.graphValue.state) } : {}),
      }, { operationId });
      if (authoritativeReload && this.analysisNeeded.size > 0) this.scheduleAnalysis();
    }
  }


  public commitSource<T>(
    request: SourceCommitRequest,
    prepare?: (context: SourceCommitContext) => Promise<T>,
  ): Promise<T> {
    const work = prepare ?? (this.sourceCommit === undefined
      ? undefined
      : async (context: SourceCommitContext) => this.sourceCommit!(request, context) as T);
    if (work === undefined) {
      return Promise.reject(new ControllerError("service_unavailable", "durable source service is unavailable", 503));
    }
    const previous = this.sourceCommitTail;
    const commit = previous.then(async () => {
      this.assertStartedForMutation();
      if (request.kind !== "watcher") this.assertDocumentRevision(request.expectedDocumentRevision);
      if (request.kind !== "reload-source" && request.kind !== "watcher") {
        this.assertExpectedDisk(request.expectedDisk);
      }
      this.assertExpectedSidecar(request.sidecar, request.expectedSidecarVersion);
      let published = false;
      const context: SourceCommitContext = {
        kind: request.kind,
        fromRevision: this.documentRevisionValue,
        expectedDocumentRevision: this.documentRevisionValue,
        operationId: request.operationId,
        document: this.notebookDocument(),
        path: this.pathValue,
        configResolution: clone(this.configResolution),
        layout: clone(this.layout) as JsonValue,
        disk: clone(this.diskValue),
        sidecars: clone(this.sidecarsValue),
        dirty: this.changed,
        preparePublication: (publication) => {
          const prepared = this.prepareSourcePublication(publication, request);
          let adopted = false;
          return () => {
            if (adopted || published) return;
            // Save As publication can cross an ownership boundary. Restore the
            // observable source state if a synchronous observer fails after a
            // publication has begun but before it is adopted.
            const previousSourceDocument = this.sourceDocument;
            const previousCells = clone(this.cells);
            const previousPath = this.pathValue;
            const previousMetadata = this.metadata;
            const previousConfigResolution = this.configResolution;
            const previousLayout = this.layout;
            const previousDisk = this.diskValue;
            const previousSidecars = this.sidecarsValue;
            const previousREnvironment = this.rEnvironmentValue;
            const previousChanged = this.changed;
            const previousDocumentRevision = this.documentRevisionValue;
            const previousVersion = this.version;
            const previousCursor = this.cursorValue;
            const previousEventJournalLength = this.eventJournal.length;
            const previousEventJournalBytes = this.eventJournalBytes;
            const previousRuntimeSignature = this.runtimeSignature;
            try {
              this.applySourcePublication(prepared, request);
            } catch (error) {
              this.sourceDocument = previousSourceDocument;
              this.cells = previousCells;
              this.pathValue = previousPath;
              this.metadata = previousMetadata;
              this.configResolution = previousConfigResolution;
              this.layout = previousLayout;
              this.diskValue = previousDisk;
              this.sidecarsValue = previousSidecars;
              this.rEnvironmentValue = previousREnvironment;
              this.changed = previousChanged;
              this.documentRevisionValue = previousDocumentRevision;
              this.outputStore.setIdentity({ documentRevision: this.documentRevisionValue, kernelEpoch: this.kernelEpochValue });
              this.version = previousVersion;
              this.cursorValue = previousCursor;
              this.eventJournal.length = previousEventJournalLength;
              this.eventJournalBytes = previousEventJournalBytes;
              this.runtimeSignature = previousRuntimeSignature;
              throw error;
            }
            adopted = true;
            published = true;
          };
        },
      };
      const result = await work(context);
      if (!published) {
        throw new ControllerError("source_commit_incomplete", "durable source commit did not publish", 503);
      }
      return result;
    });
    this.sourceCommitTail = commit.then(() => undefined, () => undefined);
    return commit;
  }


  private async applyTransaction(
    changes: readonly DocumentChange[],
    expectedDocumentRevision: number,
    operationId: string,
    waitForAnalysis: boolean,
    prepared?: ReturnType<typeof stageDocumentChanges>,
  ): Promise<{
    created: Record<string, string>;
    edited: Array<{ id: string; revision: number }>;
    deleted: string[];
    documentRevision: number;
  }> {
    this.assertStartedForMutation();
    this.assertDocumentRevision(expectedDocumentRevision);
    const staged = prepared ?? this.stageDocument(changes);
    const changed = new Set(staged.changed);
    const created: Record<string, string> = Object.fromEntries(staged.created);
    const deleted = [...staged.deleted];
    const edited = [...changed]
      .filter((id) => !staged.deleted.has(id))
      .map((id) => ({ id, revision: staged.document.cells.find((cell) => cell.id === id)?.revision ?? 0 }));
    const hasSourceChange = changed.size > 0 || staged.created.size > 0 || staged.deleted.size > 0;
    if (!hasSourceChange) {
      this.assertDocumentRevision(expectedDocumentRevision);
      return { created, edited, deleted, documentRevision: this.documentRevisionValue };
    }
    const fingerprint = stableStringify({ expectedDocumentRevision, changes });
    const request: SourceCommitRequest = {
      kind: "transaction",
      expectedDocumentRevision,
      operationId,
      fingerprint,
      document: staged.document,
      delta: { document: staged.document, created, edited, deleted },
    };
    let committed: {
      created: Record<string, string>;
      edited: Array<{ id: string; revision: number }>;
      deleted: string[];
      documentRevision: number;
    };
    try {
      committed = await this.commitSource(request, async (context) => {
      if (this.sourceCommit !== undefined) {
        await this.sourceCommit(request, context);
      } else if (this.durableCommit !== undefined) {
        try {
          await this.durableCommit({
            fromRevision: context.fromRevision,
            toRevision: nextRevision(context.fromRevision),
            delta: { document: staged.document, created, edited, deleted },
            fingerprint,
          });
        } catch (error) {
          throw new ControllerError("recovery_write_failed", "durable recovery commit failed: " + messageOf(error), 503);
        }
        context.preparePublication({
          document: staged.document,
          path: staged.document.path ?? context.path,
          configResolution: context.configResolution,
          layout: context.layout,
          disk: context.disk,
          sidecars: context.sidecars,
          dirty: true,
          advanceRevision: true,
        })();
      } else {
        context.preparePublication({
          document: staged.document,
          path: staged.document.path ?? context.path,
          configResolution: context.configResolution,
          layout: context.layout,
          disk: context.disk,
          sidecars: context.sidecars,
          dirty: true,
          advanceRevision: true,
        })();
      }
      return { created, edited, deleted, documentRevision: this.documentRevisionValue };
      });
    } catch (error) {
      throw error;
    }
    if (this.engineRestarting) {
      if (waitForAnalysis) {
        throw new ControllerError("operation_in_progress", "R engine restart is already in progress", 409);
      }
    } else if (waitForAnalysis) {
      await this.ensureCurrentAnalysis();
    } else if (this.analysisNeeded.size > 0) this.scheduleAnalysis();
    return committed;
  }

  private applyStagedDocument(
    document: NotebookDocument,
    staged: ReturnType<typeof stageDocumentChanges>,
    operationId: string,
  ): void {
    const nextIds = new Set(document.cells.map(cell => cell.id));
    const priorIds = new Set(this.cells.map(cell => cell.id));
    const priorRetainedOrder = this.cells.filter(cell => nextIds.has(cell.id)).map(cell => cell.id);
    const nextRetainedOrder = document.cells.filter(cell => priorIds.has(cell.id)).map(cell => cell.id);
    const orderChanged = !arrayEqual(priorRetainedOrder, nextRetainedOrder);
    const priorOrder = new Map(priorRetainedOrder.map((id, index) => [id, index]));
    const nextOrder = new Map(nextRetainedOrder.map((id, index) => [id, index]));
    const movedIds = new Set(nextRetainedOrder.filter(id => priorOrder.get(id) !== nextOrder.get(id)));
    const movedBarrier = [...movedIds].some(id => { const analysis = this.cellById(id)?.analysis; return analysis?.barrier === true || analysis?.opaque === true; });
    const prior = new Map(this.cells.map((cell) => [cell.id, cell]));
    const changedIds = new Set(staged.changed);
    const affected = new Set<string>();
    for (const id of changedIds) {
      affected.add(id);
      for (const descendant of this.graphValue.descendants(id)) affected.add(descendant);
    }
    for (const id of staged.deleted) {
      const removed = this.cellById(id);
      if (removed?.analysis?.barrier || removed?.analysis?.opaque) {
        const removedIndex = this.cells.findIndex(cell => cell.id === id);
        const successor = this.cells.slice(removedIndex + 1).find(cell => cell.type === "code");
        if (successor !== undefined) for (const descendant of this.graphValue.descendants(successor.id)) affected.add(descendant);
      } else {
        for (const descendant of this.graphValue.descendants(id)) affected.add(descendant);
      }
    }
    if (orderChanged && !movedBarrier) {
      for (const id of movedIds) {
        affected.add(id);
        for (const descendant of this.graphValue.descendants(id)) affected.add(descendant);
      }
    }
    for (const id of affected) this.cancelRunRegion(new Set([id]), "source");
    this.clearEditorDiagnostics(true);
    this.clearVariables(true);
    for (const id of staged.deleted) {
      const removed = prior.get(id);
      if (removed === undefined) continue;
      this.rememberInvalidatedDefinitions(removed);
      for (const operation of this.cancelOwnedOperations(id)) this.obsoleteWidgetRequests.set(operation, id);
      this.outputStore.discardExact(removed.outputs);
      this.analysisNeeded.delete(id);
      this.barrierAnalysisCandidates.delete(id);
      this.clearBeforeEvaluation.add(id);
    }
    const nextCells: CellRecord[] = [];
    for (const source of document.cells) {
      const old = prior.get(source.id);
      const changedCell = old === undefined || changedIds.has(source.id)
        || old.type !== source.type
        || !arrayEqual(old.body, source.body)
        || stableStringify(old.options) !== stableStringify(source.options);
      if (old !== undefined && !changedCell) {
        nextCells.push(old);
        continue;
      }
      if (old?.type === 'code') {
        this.rememberInvalidatedDefinitions(old);
        this.clearBeforeEvaluation.add(old.id);
        for (const widgetOperation of this.cancelOwnedOperations(old.id)) this.obsoleteWidgetRequests.set(widgetOperation, old.id);
      }
      const type = source.type ?? 'code';
      const body = [...source.body];
      if (old !== undefined && old.type !== type) this.outputStore.discardExact(old.outputs);
      nextCells.push({
        id: source.id,
        type,
        body,
        options: clone(source.options ?? {}),
        revision: source.revision ?? 0,
        status: type === 'markdown' ? 'stale' : staleStatus(old?.status ?? 'idle'),
        outputs: type === 'markdown' ? (old?.type === 'markdown' ? old.outputs : []) : (old?.type === 'code' ? old.outputs : []),
        outputsStale: type === 'code' && old?.type === 'code' && old.outputs.length > 0,
        progress: null,
        log: type === 'markdown' ? [] : (old?.log ?? []),
        error: null,
        analysis: type === 'markdown' ? emptyAnalysis(source.id, source.revision ?? 0) : null,
      });
    }
    this.cells = nextCells;
    for (const cell of this.cells) {
      if (cell.type !== 'code') {
        this.analysisNeeded.delete(cell.id);
        this.barrierAnalysisCandidates.delete(cell.id);
        continue;
      }
      const old = prior.get(cell.id);
      if (old === undefined || changedIds.has(cell.id) || old.type !== 'code') {
        this.analysisNeeded.add(cell.id);
        this.barrierAnalysisCandidates.add(cell.id);
      }
    }
    this.analysisGeneration = nextRevision(this.analysisGeneration);
    const cellTypeChanged = this.cells.some((cell) => prior.get(cell.id)?.type !== cell.type);
    if (staged.created.size > 0 || staged.deleted.size > 0 || orderChanged || cellTypeChanged) {
      this.graphValue = this.rebuildGraph();
    }
    if (movedBarrier) this.invalidateForBarrier();
    else {
      if (orderChanged) for (const id of movedIds) for (const descendant of this.graphValue.descendants(id)) affected.add(descendant);
      for (const id of affected) if (this.cellById(id) !== undefined) this.markStale(id);
    }
    this.changed = true;
    this.refreshValueFreshness();
    this.publishGraphResourceError({ operationId }, true);
    this.sourceDocument = document;
  }


  private async applySourceChanges(
    changes: readonly DocumentChange[],
    waitForAnalysis: boolean,
    operationId?: string,
  ): Promise<ChangeResult> {
    const result = await this.applyTransaction(changes, this.documentRevisionValue, operationId ?? randomUUID(), waitForAnalysis);
    return {
      edited: result.edited,
      created: Object.entries(result.created).map(([creationId, id]) => ({ creationId, id, revision: 0 })),
    };
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
    this.assertNoRuntimeContextReservation();
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
    this.assertDocumentRevision(command.expectedDocumentRevision);
    let preflightTargetId: string | null = null;
    let preflightStaged: ReturnType<typeof stageDocumentChanges> | undefined;
    if (command.scope === "cell") {
      const target = command.target;
      if (target === undefined) throw new ControllerError("invalid_request", "cell runs require a target", 400);
      if ((command.changes?.length ?? 0) > 0) {
        const staged = this.stageDocument(command.changes ?? []);
        preflightStaged = staged;
        if ("cellId" in target) {
          if (!staged.document.cells.some((cell) => cell.id === target.cellId)) throw new ControllerError("not_found", "no such cell: " + target.cellId, 404);
          preflightTargetId = target.cellId;
        } else {
          const created = staged.created.get(target.creationId);
          if (created === undefined || !staged.document.cells.some((cell) => cell.id === created)) throw new ControllerError("not_found", "no such transaction creation: " + target.creationId, 404);
          preflightTargetId = created;
        }
      } else {
        preflightTargetId = this.resolveCellRef(target);
      }
    }
    this.runPreparationActive = true;
    const preparation = {
      operationId: command.operationId,
      clientId: command.clientId,
      cancelled: false,
    };
    this.runPreparationCancellation = preparation;
    try {
      let changes: Record<string, unknown> | undefined;
      if ((command.changes?.length ?? 0) > 0) {
        changes = await this.applyTransaction(command.changes ?? [], command.expectedDocumentRevision, command.operationId, false, preflightStaged) as Record<string, unknown>;
        if (this.cancelRunPreparation(preparation)) return undefined;
        const operation = this.operationFor(command.operationId, command.clientId);
        if (operation !== undefined && !isTerminal(operation.status)) {
          operation.result = clone(changes) as OperationRecord["result"];
          this.rememberOperation(operation);
        }
        await this.ensureCurrentAnalysis();
      } else {
        this.assertDocumentRevision(command.expectedDocumentRevision);
        await this.ensureCurrentAnalysis();
      }
      if (this.cancelRunPreparation(preparation)) return undefined;
      this.assertNoPackageOperation();
      this.assertExecutionPossible();
      this.assertGraphRunnable();

      let plan: string[];
      if (command.scope === "cell") {
        if (preflightTargetId === null) throw new ControllerError("invalid_request", "cell runs require a target", 400);
        plan = this.planCellRun(preflightTargetId, "app");
      } else if (command.scope === "all") {
        plan = this.allCodePlan();
      } else {
        plan = this.graphValue.planStale((id) => this.statusOf(id));
      }
      const runId = this.launchRun(plan, command.operationId, false, command.clientId);
      const result = { runId, plan: [...plan], ...(changes === undefined ? {} : changes) };
      const operation = this.operationFor(command.operationId, command.clientId);
      if (operation !== undefined && !isTerminal(operation.status)) operation.result = clone(result) as OperationRecord["result"];
      return result;
    } finally {
      this.runPreparationActive = false;
      if (this.runPreparationCancellation === preparation) this.runPreparationCancellation = null;
      this.scheduleWidgetReconciliation();
    }
  }

  private cancelRunPreparation(preparation: {
    operationId: string;
    clientId: string;
    cancelled: boolean;
  }): boolean {
    if (!preparation.cancelled) return false;
    const operation = this.operationFor(preparation.operationId, preparation.clientId);
    if (operation !== undefined && !isTerminal(operation.status)) {
      operation.status = "cancelled";
      operation.error = hostError("interrupted", "Interrupted", operation.id);
      operation.documentRevision = this.documentRevisionValue;
      operation.settledAt = Date.now();
      this.rememberOperation(operation);
      this.notifyOperationWaiters(operation);
    }
    return true;
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
      (id) => this.cellById(id)?.type === "code" && this.cellById(id)?.options.disabled !== true,
    );
  }

  private launchRun(
    plan: readonly string[],
    operationId: string,
    deferEmptySettlement = false,
    clientId = "internal",
  ): string {
    this.assertNoRuntimeContextReservation();
    this.assertNoPackageOperation();
    this.assertExecutionPossible();
    const operation = this.operationFor(operationId, clientId);
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
        clientId,
      });
    }
    operation.status = jobs.length === 0 && !deferEmptySettlement ? "done" : "accepted";
    operation.runId = runId;
    operation.cellIds = jobs.map((job) => job.id);
    operation.executionDone = jobs.length === 0;
    operation.resetOperationIds ??= [];
    if (jobs.length === 0 && !deferEmptySettlement) operation.settledAt = Date.now();
    this.rememberOperation(operation);
    this.runOperationById.set(runId, this.operationKey(clientId, operationId));
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
          this.analysisEnvironmentIdValue = null;
          this.emit("runtime", this.runtimeSnapshot());
          const restarted = await this.engine.restart();
          if (this.closed || generation !== this.runtimeGeneration) return;
          const handshake = engineHandshakeSchema.parse(restarted);
          this.handshake = handshake;
          this.kernelEpochValue = handshake.kernel?.kernelEpoch ?? (handshake.kernelReady ? randomUUID() : null);
          this.outputStore.setIdentity({ documentRevision: this.documentRevisionValue, kernelEpoch: this.kernelEpochValue });
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
          this.clearRuntimeAvailabilityError();
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
          if (!response.ok) {
            if (response.kernelStateInvalid !== undefined) {
              this.failKernel(response.kernelStateInvalid.message, undefined, response.error, "kernel_state_invalid");
              return;
            }
            throw new Error(response.error?.message ?? "clear_cell failed");
          }
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
        response = this.canonicalEngineResponse(result, engineResponseSchema.parse(result), job);
      } catch (error) {
        this.failKernel(`R kernel transport failed: ${messageOf(error)}`, job.id);
        return;
      }
      await this.settleEvaluation(job, response);
    }
  }

  private evaluationPayload(job: EvaluationJob): EvaluationPayload {
    const kernelEpoch = this.kernelEpochValue;
    if (kernelEpoch === null) throw new ControllerError("stale_kernel", "R kernel incarnation is unavailable", 503);
    return {
      sessionEpoch: this.epochValue, kernelEpoch, operationId: job.operationId, runId: job.runId,
      cellId: job.id, revision: job.revision, documentRevision: this.documentRevisionValue, source: job.source,
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
          await this.settleEvaluation(active.job, active.completion ?? event.result, true, deferred);
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
    if (response.kernelStateInvalid !== undefined) {
      this.failKernel(response.kernelStateInvalid.message, job.id, response.error, "kernel_state_invalid");
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
      const runOperationKey = this.operationKey(job.clientId, job.operationId);
      if (!this.causalRunFailures.has(runOperationKey)) {
        this.causalRunFailures.set(runOperationKey, hostError(
          "eval_error",
          response.error?.message ?? "cell evaluation failed",
          job.operationId,
        ));
      }
    }
    if (active.cancelMode === "stop" && !response.ok) {
      const interruption = response.error?.interrupted === true
        ? clone(response.error)
        : { code: "interrupted", message: "Interrupted", interrupted: true };
      this.interruptedRuns.set(job.runId, interruption);
      const parentId = this.causalWidgetRunParents.get(this.operationKey(job.clientId, job.operationId));
      if (parentId !== undefined) {
        this.causalWidgetFailures.set(parentId, hostError(
          interruption.code ?? "interrupted",
          interruption.message,
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
    try {
      if (event.type === "started") {
        if (active.requestId !== undefined || event.sequence !== 0) {
          throw new ControllerError(
            "invalid_engine_sequence",
            "R kernel emitted more than one started event",
            503,
          );
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
        throw new ControllerError(
          "invalid_engine_sequence",
          "R kernel event sequence is not strictly increasing",
          503,
        );
      }
      active.lastSequence = event.sequence;
      if (event.type === "completed") {
        const rawResult = rawEvent.type === "completed" ? rawEvent.result : undefined;
        active.completion = this.canonicalEngineResponse(rawResult, event.result, job);
        return;
      }
      if (event.type !== "output") return;
      const rawPayload = rawEvent.type === "output" ? rawEvent.payload : undefined;
      const output = event.kind === "append"
        ? this.canonicalEngineRecord(
          isRecord(rawPayload) && "output" in rawPayload ? rawPayload.output : rawPayload,
          job,
        )
        : undefined;
      this.applyOutputEvent(event, active, output);
    } catch (error) {
      active.protocolFailure = asControllerError(error, "invalid_engine_event", 503);
    }
  }

  private canonicalEngineRecord(value: unknown, job: EvaluationJob): OutputRecord {
    const checked = outputRecordSchema.safeParse(value);
    if (!checked.success) {
      throw new ControllerError("invalid_engine_event", "R kernel returned a non-canonical output record", 503);
    }
    const record = this.outputStore.getRecord(checked.data.id);
    if (record === undefined || !Object.is(record, value)) {
      throw new ControllerError("invalid_engine_event", "R kernel returned an output record not owned by the store", 503);
    }
    if (
      record.sessionEpoch !== this.epochValue
      || record.kernelEpoch !== this.kernelEpochValue
      || record.runId !== job.runId
      || record.cellId !== job.id
      || record.revision !== job.revision
    ) {
      throw new ControllerError("invalid_engine_event", "R kernel returned an output record with stale identity", 503);
    }
    return record;
  }

  private canonicalEngineResponse(
    raw: unknown,
    parsed: EngineResponse,
    job: EvaluationJob,
  ): EngineResponse {
    if (!isRecord(raw) || raw.outputs === undefined) return parsed;
    if (!Array.isArray(raw.outputs)) {
      throw new ControllerError("invalid_engine_event", "R kernel returned invalid output records", 503);
    }
    return {
      ...parsed,
      outputs: raw.outputs.map((value) => this.canonicalEngineRecord(value, job)),
    };
  }

  private applyOutputEvent(
    event: Extract<EngineEvent, { type: "output" }>,
    active: ActiveEvaluation,
    canonicalOutput?: OutputRecord,
  ): void {
    const cell = this.cellById(active.job.id);
    if (cell === undefined || cell.revision !== active.job.revision) return;
    if (event.kind === "clear") {
      active.streamedOutputs.length = 0;
      this.outputStore.discardExact(cell.outputs);
      cell.outputs = [];
      cell.outputsStale = false;
      cell.progress = null;
      cell.log = [];
    } else if (event.kind === "append") {
      if (canonicalOutput === undefined) {
        throw new ControllerError("invalid_engine_event", "R kernel append omitted its canonical output", 503);
      }
      if (cell.outputsStale) {
        this.outputStore.discardExact(cell.outputs);
        cell.outputs = [];
      }
      cell.outputsStale = false;
      active.streamedOutputs.push(canonicalOutput);
      cell.outputs.push(canonicalOutput);
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
    streamedOutputs: readonly OutputRecord[],
  ): void {
    const cell = this.cellById(job.id);
    if (cell === undefined || cell.revision !== job.revision) return;
    const nextOutputs = (response.outputs ?? [...streamedOutputs]) as OutputRecord[];
    const retainedIds = new Set(nextOutputs.map((record) => record.id));
    this.outputStore.discardExact(cell.outputs.filter((record) => !retainedIds.has(record.id)));
    cell.outputs = nextOutputs;
    cell.status = response.stopped ? "stopped" : "done";
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
    this.outputStore.discardExact(cell.outputs);
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

  private async interruptActiveRun(targetRunId?: string): Promise<unknown> {
    this.assertStarted();
    const preparation = this.runPreparationCancellation;
    if (preparation !== null && this.runPreparationActive) {
      if (targetRunId !== undefined) {
        throw new ControllerError("not_found", "no such active run: " + targetRunId, 404);
      }
      preparation.cancelled = true;
      this.markOperationCancellationRequested(preparation.operationId, preparation.clientId);
      this.bump("runtime", this.runtimeSnapshot(), { operationId: preparation.operationId });
      return { runId: null, requested: true };
    }
    const active = this.activeEvaluation;
    if (active === null) {
      const queued = this.queue[0];
      if (queued !== undefined) {
        if (targetRunId !== undefined && targetRunId !== queued.runId) {
          throw new ControllerError("not_found", "no such active run: " + targetRunId, 404);
        }
        const runId = queued.runId;
        this.queue = this.queue.filter((job) => job.runId !== runId);
        this.interruptedRuns.set(runId, { code: "interrupted", message: "Interrupted", interrupted: true });
        this.markOperationCancellationRequested(queued.operationId, queued.clientId);
        this.completeRunIfIdle(runId);
        this.bump("runtime", this.runtimeSnapshot(), {
          operationId: queued.operationId,
          runId,
        });
        return { runId, requested: true };
      }
      throw new ControllerError("no_run_in_progress", "no run in progress", 409);
    }
    if (active.cancelMode !== null) {
      throw new ControllerError("no_run_in_progress", "no run in progress", 409);
    }
    if (targetRunId !== undefined && targetRunId !== active.job.runId) {
      throw new ControllerError("not_found", "no such active run: " + targetRunId, 404);
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
    return { runId, requested: true, ...(active.requestId === undefined ? {} : { requestId: active.requestId }) };
  }
  public assertRuntimeContextTransitionReady(): void {
    this.assertDocumentReady();
    if (this.startPromise !== null) {
      throw new ControllerError("operation_in_progress", "R engine startup is already in progress", 409);
    }
    this.assertNoPackageOperation();
    if (this.engineRestarting) {
      throw new ControllerError("operation_in_progress", "R engine restart is already in progress", 409);
    }
    if (this.pendingWidgets.size > 0 || this.activeButtonResets.size > 0
      || this.widgetReconciliationScheduled || this.widgetReconciliationPreparing
      || this.widgetReconciliationRoots.size > 0) {
      throw new ControllerError("operation_in_progress", "cannot restart while a widget operation is active", 409);
    }
    if (this.pendingLazyOutputs.size > 0) {
      throw new ControllerError("operation_in_progress", "cannot restart while a lazy output evaluation is active", 409);
    }
    if (this.runPreparationActive || this.activeEvaluation !== null || this.queue.length > 0) {
      throw new ControllerError("run_in_progress", "cannot restart while a run is active", 409);
    }
  }

  public reserveRuntimeContext(): RuntimeContextReservation {
    this.assertRuntimeContextTransitionReady();
    if (this.runtimeContextReservation !== undefined) {
      throw new ControllerError("operation_in_progress", "runtime context transition is already reserved", 409);
    }
    const token = randomUUID();
    this.runtimeContextReservation = token;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.runtimeContextReservation === token) {
          this.runtimeContextReservation = undefined;
          this.scheduleWidgetReconciliation();
        }
      },
    };
  }

  private assertNoRuntimeContextReservation(): void {
    if (this.runtimeContextReservation !== undefined) {
      throw new ControllerError("operation_in_progress", "runtime context transition is pending", 409);
    }
  }

  public async restartRuntimeContext(
    options: EngineRestartOptions,
    operationId: string = randomUUID(),
  ): Promise<unknown> {
    this.assertRuntimeContextTransitionReady();
    return this.restartEngine(options, false, operationId);
  }

  private async restartEngine(
    options: EngineRestartOptions | undefined,
    replay: boolean,
    operationId: string,
    clientId = "internal",
    waitForSourceLane = false,
  ): Promise<unknown> {
    this.assertRuntimeContextTransitionReady();
    this.engineRestarting = true;
    try {
      if (waitForSourceLane) await this.sourceCommitTail;
      this.assertNotClosed();
      const priorAnalysis = this.analysisInFlight;
      const statusChanges = this.invalidateRuntimeView();
      const analysisResetIds: string[] = [];
      if (options?.environment !== undefined) {
        this.analysisGeneration = nextRevision(this.analysisGeneration);
        this.clearAnalysisCache();
        this.analyzerIdentity = "";
        this.analysisNeeded.clear();
        for (const cell of this.cells) {
          if (cell.type !== "code") continue;
          cell.analysis = null;
          cell.status = "stale";
          this.analysisNeeded.add(cell.id);
          analysisResetIds.push(cell.id);
        }
        this.graphValue = this.rebuildGraph();
      }
      const generation = this.runtimeGeneration;
      this.executionReady = false;
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
      if (analysisResetIds.length > 0) this.emitGraph({ operationId });
      this.emitCells([...statusChanges, ...analysisResetIds], { operationId });
      let handshake: EngineHandshake;
      try {
        handshake = engineHandshakeSchema.parse(await this.engine.restart(options));
      } catch (error) {
        if (this.closed) throw new ControllerError("session_stopped", "session is stopped", 409);
        this.kernelAvailable = false;
        const failure = hostError("worker_unavailable", messageOf(error));
        this.recordRuntimeAvailabilityError(failure);
        throw new ControllerError("worker_unavailable", failure.message, 503);
      }
      await priorAnalysis?.catch(() => {});
      this.assertRuntimeGeneration(generation, "R runtime changed while restart was pending");
      this.handshake = handshake;
      this.started = true;
      if (options?.environment !== undefined) this.rEnvironmentValue = clone(options.environment);
      this.kernelEpochValue = handshake.kernel?.kernelEpoch ?? (handshake.kernelReady ? randomUUID() : null);
      this.outputStore.setIdentity({ documentRevision: this.documentRevisionValue, kernelEpoch: this.kernelEpochValue });
      this.analysisEnvironmentIdValue = null;
      this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
      this.analyzerAvailable = handshake.analyzerReady;
      if (!this.kernelAvailable || !this.analyzerAvailable) {
        const failure = hostError("engine_not_ready", "R engine did not become ready");
        this.recordRuntimeAvailabilityError(failure);
        throw new ControllerError("engine_not_ready", failure.message, 503);
      }
      this.barrierRestartRequired = false;
      this.clearBeforeEvaluation.clear();
      this.invalidatedDefinitionsByCell.clear();
      this.clearRuntimeAvailabilityError();
      await this.ensureCurrentAnalysis();
      this.assertRuntimeGeneration(generation, "R runtime changed while restart analysis was pending");
      this.executionReady = true;
      if (!this.graphValue.resourceLimited) {
        this.replaceLastActionError(null, { operationId });
      }
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
      if (!replay) return { runId: null };
      this.assertGraphRunnable();
      const runId = this.launchRun(this.allCodePlan(), operationId, false, clientId);
      return { runId };
    } finally {
      this.engineRestarting = false;
    }
  }

  private failKernel(
    message: string,
    activeCellId?: string,
    cellError?: EngineResponse["error"],
    failureCode: string = "worker_unavailable",
  ): void {
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
        cell.error = cellError ?? { message, code: failureCode, transport: failureCode === "worker_unavailable" };
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
        if (operation.kind === "run" && operation.runId === null && operation.result === null) continue;
        this.failOperation(
          operation.id,
          hostError(failureCode, message, operation.id),
          operation.clientId,
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
      failureCode,
      `${message}; outputs are stale. Restart R to replay the notebook`,
    );
    this.setRuntimeAvailabilityError(failure);
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
    const failure = hostError("analysis_unavailable", error.message);
    this.setRuntimeAvailabilityError(failure);
    this.bump("runtime", this.runtimeSnapshot());
    this.replaceLastActionError(failure);
  }

  private invalidateRuntimeView(): Set<string> {
    const changed = new Set<string>();
    this.runtimeGeneration = nextRevision(this.runtimeGeneration);
    const preparation = this.runPreparationCancellation;
    if (preparation !== null) {
      preparation.cancelled = true;
      this.markOperationCancellationRequested(preparation.operationId, preparation.clientId);
    }
    if (this.activeEvaluation !== null || this.activeBatch !== null || this.queue.length > 0) {
      for (const id of this.cancelRunRegion(
        new Set(this.cells.map((cell) => cell.id)),
        "source",
      )) changed.add(id);
    }
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
      cell.outputsStale = cell.outputs.length > 0;
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
          operation.clientId,
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
    const operationKey = this.runOperationById.get(runId);
    if (operationKey === undefined) return;
    const operation = this.operationForKey(operationKey);
    if (operation === undefined || operation.status === "running" || isTerminal(operation.status)) return;
    operation.status = "running";
    this.rememberOperation(operation);
  }

  private completeRunIfIdle(runId: string): void {
    if (this.activeEvaluation?.job.runId === runId) return;
    if (this.queue.some((job) => job.runId === runId)) return;
    const operationKey = this.runOperationById.get(runId);
    if (operationKey === undefined) return;
    const operation = this.operationForKey(operationKey);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.executionDone = true;
    const operationId = operation.id;
    const operationClientId = operation.clientId;
    const resets = operation.resetOperationIds ?? [];
    const interruption = this.interruptedRuns.get(runId);
    if (interruption !== undefined) {
      if (resets.some((id) => !isTerminal(this.operationFor(id, operationClientId)?.status ?? "accepted"))) {
        this.rememberOperation(operation);
        return;
      }
      this.interruptedRuns.delete(runId);
      this.causalRunFailures.delete(operationKey);
      this.causalWidgetRunParents.delete(operationKey);
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
      .map((id) => this.operationFor(id, operationClientId))
      .find((candidate) => candidate !== undefined && candidate.status !== "done" && isTerminal(candidate.status));
    if (failedReset !== undefined) {
      const error = failedReset.error;
      this.causalWidgetRunParents.delete(operationKey);
      this.causalRunFailures.delete(operationKey);
      this.failOperation(
        operationId,
        hostError(
          error?.code ?? "widget_update_failed",
          error?.message ?? "run button reset failed",
          operationId,
          error?.details,
        ),
        operationClientId,
      );
      return;
    }
    if (resets.some((id) => !isTerminal(this.operationFor(id, operationClientId)?.status ?? "accepted"))) {
      this.rememberOperation(operation);
      return;
    }
    const causalFailure = this.causalRunFailures.get(operationKey);
    if (causalFailure !== undefined) {
      this.causalRunFailures.delete(operationKey);
      const parentId = this.causalWidgetRunParents.get(operationKey);
      this.causalWidgetRunParents.delete(operationKey);
      this.failOperation(operationId, causalFailure, operationClientId);
      if (parentId !== undefined) {
        const parent = this.operationForKey(parentId);
        if (parent !== undefined) {
          this.causalWidgetFailures.set(parentId, hostError(
            causalFailure.code,
            causalFailure.message,
            parent.id,
            causalFailure.details,
          ));
        }
      }
      return;
    }
    this.causalWidgetRunParents.delete(operationKey);
    this.completeOperation(operationId, {
      ...(isRecord(operation.result) ? operation.result : {}),
      runId,
      ...(operation.kind === "widget" && operation.token !== undefined
        ? { token: operation.token }
        : {}),
    }, operationClientId);
  }

  private scheduleAnalysis(): void {
    if (this.analysisRestarting || this.engineRestarting || this.closed) return;
    if (!this.started || !this.analyzerAvailable) {
      this.replaceLastActionError({
        code: "analysis_unavailable",
        message: "R analyzer is unavailable",
      });
      return;
    }
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

  private async analyzeBatch(
    cells: readonly Pick<CellRecord, "id" | "revision" | "type" | "body">[],
    generation: number,
  ): Promise<void> {
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
        } as AnalysisCellResult);
      }
    }

    if (uncached.length > 0) {
      let parsed: ReturnType<typeof analysisResultSchema.parse>;
      try {
        parsed = analysisResultSchema.parse(await this.engine.analyze(
          uncached,
          generation,
          this.analysisEnvironmentIdValue ?? undefined,
        ));
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
      if (parsed.analyzer.analysisEnvironmentId !== parsed.analysisEnvironmentId) {
        throw new ControllerError(
          "invalid_analysis_response",
          "analyzer identity does not match the analysis environment",
          503,
        );
      }
      this.analysisEnvironmentIdValue = parsed.analysisEnvironmentId;
      const identity = [
        parsed.analysisEnvironmentId,
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
    const refreshedCells = invalidationRoots.flatMap((id): GraphCellInput[] => {
      const cell = this.cellById(id);
      return cell === undefined ? [] : [{
        ...(cell.analysis ?? emptyAnalysis(cell.id, cell.revision)),
        type: cell.type,
        disabled: cell.options.disabled === true,
      }];
    });
    if (!this.graphValue.refreshCellsIfTopologyUnchanged(refreshedCells)) {
      this.graphValue = this.rebuildGraph();
    }
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
      const blocked = issues.some((issue) => issue.code === "graph_blocked");
      throw new ControllerError(
        blocked ? "graph_blocked" : "graph_invalid",
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
        pending.clientId,
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
      throw new ControllerError("invalid_request", "no such widget: " + command.name, 400);
    }
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("widget_not_current", "widget " + command.name + " is not current", 409);
    }
    this.assertLiveOutput(owner, location.record, "widget_not_current");
    this.assertGraphRunnable();
    const spec = isRecord(location.widget.spec) ? location.widget.spec : null;
    let target = spec === null ? null : widgetSpecAt(spec, command.path);
    if (target === null) throw new ControllerError("invalid_request", "widget path does not exist", 400);
    if (target.kind === "form" && command.update.submit !== true && isRecord(target.child)) target = target.child;
    const kind = String(target.kind ?? "");
    const update = validateWidgetUpdate(kind, command.update);
    const draft = widgetPathHasForm(spec ?? {}, command.path) && command.update.submit !== true;
    const key = widgetKey(command.name, command.path);
    const reservedUpload = [...this.pendingUploads.entries()].find(([, pending]) => pending.key === key);
    const operationKey = this.operationKey(command.clientId, command.operationId);
    if (this.pendingWidgets.has(key)
      || (reservedUpload !== undefined && reservedUpload[0] !== operationKey)) {
      throw new ControllerError("operation_in_progress", "widget " + command.name + " already has a pending update", 409);
    }
    this.pendingWidgets.set(key, this.operationKey(command.clientId, command.operationId));
    this.widgetToken += 1;
    const operation = this.operationFor(command.operationId, command.clientId);
    if (operation !== undefined) {
      operation.status = "running";
      operation.token = this.widgetToken;
      operation.cellIds = [owner.id];
      this.rememberOperation(operation);
    }
    const identity = {
      owner: owner.id,
      revision: owner.revision,
      record: location.record,
      recordId: location.record.id,
      name: command.name,
      kind,
      key,
      token: this.widgetToken,
      draft,
      generation: this.runtimeGeneration,
    };
    void this.updateOutputRecord(owner, location.record, (data) => {
      const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === command.name);
      if (widget === null) throw new ControllerError("widget_not_current", "widget is no longer current", 409);
      setWidgetOperation(widget, key, {
        token: identity.token,
        draft,
        operationId: command.operationId,
        status: "pending",
        error: null,
      });
    }).then((record) => {
      identity.record = record;
      this.bump("cell", this.publicCell(owner), {
        operationId: command.operationId,
        cellId: owner.id,
        revision: owner.revision,
      });
      return this.engine.request("set_widget", {
        name: command.name,
        path: [...command.path],
        op_id: identity.token,
        ...update,
      });
    }).then((response) => this.finishWidgetOperation(command, identity, response, update)).catch((error: unknown) => {
      const failure = asControllerError(error, "widget_update_failed");
      void this.failWidgetOperation(command, identity, failure.code, failure.message);
    });
    return { token: identity.token, owner: owner.id };
  }

  private async finishWidgetOperation(
    command: Extract<HostCommand, { type: "widget" }>,
    identity: {
      owner: string;
      revision: number;
      record: OutputRecord;
      recordId: string;
      name: string;
      kind: string;
      key: string;
      token: number;
      draft: boolean;
      generation: number;
    },
    rawResponse: EngineResponse,
    update: Record<string, unknown>,
  ): Promise<void> {
    const reconciliationOwner = this.obsoleteWidgetRequests.get(command.operationId);
    this.obsoleteWidgetRequests.delete(command.operationId);
    if (this.closed || identity.generation !== this.runtimeGeneration) return;
    let response: EngineResponse;
    try {
      response = engineResponseSchema.parse(rawResponse);
    } catch (error) {
      await this.failWidgetOperation(command, identity, "invalid_engine_response", messageOf(error));
      return;
    }
    if (reconciliationOwner !== undefined) {
      if (response.ok) this.queueWidgetReconciliation(reconciliationOwner);
      return;
    }
    const current = this.findWidget(command.name);
    const owner = this.cellById(identity.owner);
    if (
      this.pendingWidgets.get(identity.key) !== this.operationKey(command.clientId, command.operationId)
      || current === null
      || current.owner !== identity.owner
      || current.record.id !== identity.recordId
      || owner === undefined
      || owner.revision !== identity.revision
      || this.statusOf(owner.id) !== "done"
    ) {
      await this.failWidgetOperation(command, identity, "widget_not_current", "widget is no longer current");
      return;
    }
    if (!response.ok) {
      await this.failWidgetOperation(
        command,
        identity,
        response.error?.transport ? "worker_unavailable" : "widget_update_failed",
        response.error?.message ?? "widget update failed",
      );
      return;
    }
    identity.record = current.record;
    const responsePayload = response as unknown as Record<string, unknown>;
    const selected = isRecord(responsePayload.selected) ? responsePayload.selected : update;
    const next = await this.updateOutputRecord(owner, identity.record, (data) => {
      const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === command.name);
      if (widget === null) throw new ControllerError("widget_not_current", "widget is no longer current", 409);
      if (isRecord(widget.spec)) {
        widget.spec = patchWidgetSpec(widget.spec, command.path, selected, identity.kind, update);
      }
      setWidgetOperation(widget, identity.key, {
        token: identity.token,
        operationId: command.operationId,
        status: "done",
        error: null,
      });
    });
    identity.record = next;
    this.pendingWidgets.delete(identity.key);
    const operationKey = this.operationKey(command.clientId, command.operationId);
    const pendingUpload = this.pendingUploads.get(operationKey);
    this.pendingUploads.delete(operationKey);
    if (pendingUpload !== undefined && pendingUpload.uploadId !== null) {
      const uploadId = pendingUpload.uploadId;
      pendingUpload.uploadId = null;
      await this.removeUpload(uploadId);
    }
    this.scheduleVariableRefresh();
    this.bump("cell", this.publicCell(owner), {
      operationId: command.operationId,
      cellId: owner.id,
      revision: owner.revision,
    });
    if (identity.draft) {
      this.completeOperation(command.operationId, { token: identity.token, draft: true }, command.clientId);
    } else if (identity.kind === "run_button" && update.value === true) {
      this.scheduleRunButton(command, identity.owner, identity.revision, identity.record);
    } else {
      const scheduled = this.scheduleWidgetConsumers(command.name, identity.owner, command.source, command.operationId, command.clientId);
      if (!scheduled) this.completeOperation(command.operationId, { token: identity.token }, command.clientId);
    }
  }

  private async failWidgetOperation(
    command: Extract<HostCommand, { type: "widget" }>,
    identity: {
      owner: string;
      revision: number;
      record: OutputRecord;
      recordId: string;
      name: string;
      key: string;
      token: number;
      generation: number;
    },
    code: string,
    message: string,
  ): Promise<void> {
    if (this.obsoleteWidgetRequests.delete(command.operationId)) return;
    if (this.closed || identity.generation !== this.runtimeGeneration) return;
    if (this.pendingWidgets.get(identity.key) !== this.operationKey(command.clientId, command.operationId)) return;
    this.pendingWidgets.delete(identity.key);
    this.discardUpload(this.operationKey(command.clientId, command.operationId));
    const owner = this.cellById(identity.owner);
    if (owner !== undefined && owner.revision === identity.revision && this.statusOf(owner.id) === "done") {
      const current = this.findWidget(identity.name);
      if (current !== null && current.record.id === identity.recordId) {
        identity.record = current.record;
        try {
          identity.record = await this.updateOutputRecord(owner, current.record, (data) => {
            const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === identity.name);
            if (widget !== null) setWidgetOperation(widget, identity.key, {
              token: identity.token,
              operationId: command.operationId,
              status: "error",
              error: { code, message },
            });
          });
          this.bump("cell", this.publicCell(owner), {
            operationId: command.operationId,
            cellId: owner.id,
            revision: owner.revision,
          });
        } catch {
          // The owning output was replaced while reporting the failure.
        }
      }
    }
    const failure = hostError(code, message, command.operationId);
    this.replaceLastActionError(failure, { operationId: command.operationId, cellId: identity.owner });
    this.failOperation(command.operationId, failure, command.clientId);
  }


  private scheduleWidgetConsumers(
    name: string,
    owner: string,
    source: "editor" | "app" | "mcp" | "cli",
    operationId: string,
    clientId: string,
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
        const runId = this.launchRun(plan, operationId, true, clientId);
        if (!this.runHasPendingJobs(runId)) this.completeRunIfIdle(runId);
      } catch (error) {
        this.failOperation(operationId, asControllerError(error).toJSON(operationId), clientId);
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
    record: OutputRecord,
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
        record,
        triggerOperationId: command.operationId,
        triggerClientId: command.clientId,
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
      const runOperationId = "run-button-" + command.operationId;
      this.createOperation(runOperationId, "run", command.clientId);
      this.causalWidgetRunParents.set(
        this.operationKey(command.clientId, runOperationId),
        this.operationKey(command.clientId, command.operationId),
      );
      try {
        runId = this.launchRun(this.widgetClosure(directConsumers, owner), runOperationId, true, command.clientId);
      } catch (error) {
        this.causalWidgetRunParents.delete(this.operationKey(command.clientId, runOperationId));
        this.failOperation(runOperationId, asControllerError(error).toJSON(runOperationId), command.clientId);
        this.failOperation(command.operationId, hostError("widget_update_failed", "run button could not schedule consumers", command.operationId), command.clientId);
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
      record,
      triggerOperationId: command.operationId,
      triggerClientId: command.clientId,
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
        const settled = reset.directConsumers.every((id) => ["done", "error", "stopped"].includes(this.statusOf(id)));
        if (!settled) continue;
      }
      this.pendingButtonResets.delete(reset.key);
      this.sendButtonReset(reset.runId === null ? { ...reset, runId: completedRunId } : reset);
    }
  }

  private refreshButtonResets(): void {
    for (const [key, reset] of [...this.pendingButtonResets]) {
      const location = this.findWidget(reset.name);
      const owner = this.cellById(reset.owner);
      if (location === null
        || location.owner !== reset.owner
        || location.record.id !== reset.record.id
        || owner === undefined
        || owner.revision !== reset.revision) {
        this.pendingButtonResets.delete(key);
        this.failButtonResetParents(reset, "widget_not_current", "run button is no longer current");
        continue;
      }
      reset.record = location.record;
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
      || location.record.id !== reset.record.id
      || owner === undefined
      || owner.revision !== reset.revision
      || this.statusOf(owner.id) !== "done"
      || target?.kind !== "run_button") {
      this.failButtonResetParents(reset, "widget_not_current", "run button is no longer current");
      return;
    }
    reset.record = location.record;
    const resetOperationId = reset.triggerOperationId + ":reset:" + randomUUID();
    const resetOperation = this.createOperation(resetOperationId, "widget-reset", reset.triggerClientId);
    resetOperation.status = "running";
    resetOperation.cellIds = [reset.owner];
    this.rememberOperation(resetOperation);
    const triggerOperation = this.operationFor(reset.triggerOperationId, reset.triggerClientId);
    if (triggerOperation !== undefined && !isTerminal(triggerOperation.status)) {
      triggerOperation.resetOperationIds = uniqueStrings([...(triggerOperation.resetOperationIds ?? []), resetOperationId]);
      this.rememberOperation(triggerOperation);
    }
    const runOperationId = reset.runId === null ? undefined : this.runOperationById.get(reset.runId);
    if (runOperationId !== undefined) {
      const runOperation = this.operationForKey(runOperationId);
      if (runOperation !== undefined && !isTerminal(runOperation.status)) {
        runOperation.resetOperationIds = uniqueStrings([...(runOperation.resetOperationIds ?? []), resetOperationId]);
        this.rememberOperation(runOperation);
      }
    }
    const token = ++this.widgetToken;
    const generation = this.runtimeGeneration;
    this.pendingWidgets.set(reset.key, this.operationKey(reset.triggerClientId, resetOperationId));
    this.activeButtonResets.set(resetOperationId, { operationId: resetOperationId, token, reset });
    void this.updateOutputRecord(owner, reset.record, (data) => {
      const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === reset.name);
      if (widget === null) throw new ControllerError("widget_not_current", "run button is no longer current", 409);
      setWidgetOperation(widget, reset.key, { token, operationId: resetOperationId, status: "pending", error: null });
    }).then((record) => {
      reset.record = record;
      this.bump("cell", this.publicCell(owner), {
        operationId: resetOperationId,
        cellId: owner.id,
        revision: owner.revision,
      });
      return this.engine.request("set_widget", {
        name: reset.name,
        path: [...reset.path],
        value: false,
        op_id: token,
      });
    }).then(async (raw) => {
      if (!this.runtimeRequestCurrent(resetOperationId, generation, reset.triggerClientId)) return;
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
      if (this.pendingWidgets.get(reset.key) !== this.operationKey(reset.triggerClientId, resetOperationId)
        || this.activeButtonResets.get(resetOperationId)?.token !== token
        || current === null
        || current.owner !== reset.owner
        || current.record.id !== reset.record.id
        || currentOwner === undefined
        || currentOwner.revision !== reset.revision
        || this.statusOf(currentOwner.id) !== "done") {
        throw new ControllerError("widget_not_current", "run button is no longer current", 409);
      }
      const next = await this.updateOutputRecord(currentOwner, current.record, (data) => {
        const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === reset.name);
        if (widget === null) throw new ControllerError("widget_not_current", "run button is no longer current", 409);
        if (isRecord(widget.spec)) widget.spec = patchWidgetSpec(widget.spec, reset.path, { value: false }, "run_button", { value: false });
        setWidgetOperation(widget, reset.key, { token, operationId: resetOperationId, status: "done", error: null });
      });
      reset.record = next;
      this.pendingWidgets.delete(reset.key);
      this.activeButtonResets.delete(resetOperationId);
      this.scheduleVariableRefresh();
      this.completeOperation(resetOperationId, { token }, reset.triggerClientId);
      const triggerKey = this.operationKey(reset.triggerClientId, reset.triggerOperationId);
      const causalFailure = this.causalWidgetFailures.get(triggerKey);
      this.causalWidgetFailures.delete(triggerKey);
      if (causalFailure === undefined) {
        this.completeOperation(reset.triggerOperationId, { token: this.operationForKey(triggerKey)?.token, resetOperationId }, reset.triggerClientId);
      } else {
        this.failOperation(reset.triggerOperationId, causalFailure, reset.triggerClientId);
      }
      if (reset.runId !== null) this.completeRunIfIdle(reset.runId);
      this.bump("cell", this.publicCell(currentOwner), { operationId: resetOperationId, cellId: currentOwner.id, revision: currentOwner.revision });
    }).catch(async (error: unknown) => {
      if (!this.runtimeRequestCurrent(resetOperationId, generation, reset.triggerClientId)) return;
      const failure = asControllerError(error, "widget_update_failed", 400);
      const ownsPending = this.pendingWidgets.get(reset.key) === this.operationKey(reset.triggerClientId, resetOperationId);
      if (ownsPending) this.pendingWidgets.delete(reset.key);
      this.activeButtonResets.delete(resetOperationId);
      const currentOwner = this.cellById(reset.owner);
      const current = this.findWidget(reset.name);
      if (ownsPending && currentOwner !== undefined && currentOwner.revision === reset.revision
        && current !== null && current.record.id === reset.record.id) {
        try {
          reset.record = await this.updateOutputRecord(currentOwner, current.record, (data) => {
            const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === reset.name);
            if (widget !== null) setWidgetOperation(widget, reset.key, { token, operationId: resetOperationId, status: "error", error: { code: failure.code, message: failure.message } });
          });
          this.bump("cell", this.publicCell(currentOwner), { operationId: resetOperationId, cellId: currentOwner.id, revision: currentOwner.revision });
        } catch {
          // The reset target was replaced while reporting the failure.
        }
      }
      this.failOperation(resetOperationId, hostError(failure.code, failure.message, resetOperationId), reset.triggerClientId);
      this.failButtonResetParents(reset, failure.code, failure.message);
      if (reset.runId !== null) this.completeRunIfIdle(reset.runId);
    });
  }


  private failButtonResetParents(
    reset: PendingButtonReset,
    code: string,
    message: string,
  ): void {
    const triggerKey = this.operationKey(reset.triggerClientId, reset.triggerOperationId);
    this.causalWidgetFailures.delete(triggerKey);
    this.failOperation(
      reset.triggerOperationId,
      hostError(code, message, reset.triggerOperationId),
      reset.triggerClientId,
    );
    if (reset.runId === null) return;
    const runKey = this.runOperationById.get(reset.runId);
    if (runKey !== undefined) {
      this.causalWidgetRunParents.delete(runKey);
      this.causalRunFailures.delete(runKey);
      const runOperation = this.operationForKey(runKey);
      if (runOperation !== undefined) {
        this.failOperation(runOperation.id, hostError(code, message, runOperation.id), runOperation.clientId);
      }
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
      || this.runtimeContextReservation !== undefined
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
      || this.runtimeContextReservation !== undefined
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
        || this.runtimeContextReservation !== undefined
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
      const scheduled = new Set(this.operationFor(operationId, INTERNAL_CLIENT_ID)?.cellIds ?? []);
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

  private startInspection(operationId: string, name: string, clientId: string): unknown {
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
        this.pendingInspection.clientId,
      )) {
      throw new ControllerError(
        "operation_in_progress",
        "a value request is already pending",
        409,
      );
    }
    const operation = this.operationFor(operationId, clientId);
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
      clientId,
      name,
      owner: identity?.id ?? null,
      revision: identity?.revision ?? null,
    };
    const outputScope: OutputScope = {
      sessionEpoch: this.epochValue,
      documentRevision: this.documentRevisionValue,
      kernelEpoch: this.runtimeSnapshot().kernelEpoch,
      runId: null,
      cellId: identity?.id ?? null,
      revision: identity?.revision ?? null,
    };
    const generation = this.runtimeGeneration;
    void this.engine.request("get_value", {
      name,
      token: operationId,
    }, { outputScope }).then((raw) => {
      if (!this.runtimeRequestCurrent(operationId, generation, clientId)) return;
      const response = engineResponseSchema.parse(raw);
      const responsePayload = response as unknown as Record<string, unknown>;
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
        value: clone(responsePayload.value as JsonValue),
        owner: identity?.id ?? null,
        revision: identity?.revision ?? null,
      };
      this.pendingInspection = null;
      this.completeOperation(operationId, this.lastValue, clientId);
      this.bump("notebook", { lastValue: clone(this.lastValue) }, { operationId });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(operationId, generation, clientId)) return;
      this.pendingInspection = null;
      const failure = asControllerError(error, "value_request_failed");
      this.failOperation(operationId, failure.toJSON(operationId), clientId);
    });
    return { name, owner: owner?.id ?? null, revision: owner?.revision ?? null };
  }

  private startLazyOutput(operationId: string, key: string, clientId: string): unknown {
    this.assertExecutionPossible();
    if (this.pendingLazyOutputs.has(key)) {
      throw new ControllerError("operation_in_progress", "lazy output already has a pending evaluation", 409);
    }
    const location = this.findOutput((output) => output.kind === "lazy" && output.key === key);
    if (location === null) {
      throw new ControllerError("lazy_expired", "this lazy output belongs to an earlier run of the cell", 409);
    }
    const operation = this.operationFor(operationId, clientId);
    if (operation !== undefined) {
      operation.status = "running";
      operation.cellIds = [location.owner];
      this.rememberOperation(operation);
    }
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("lazy_expired", "lazy output is no longer current", 409);
    }
    this.assertLiveOutput(owner, location.record, "lazy_expired");
    const revision = owner.revision;
    const kernelEpoch = this.runtimeSnapshot().kernelEpoch;
    if (kernelEpoch === null) throw new ControllerError("stale_kernel", "R kernel incarnation is unavailable", 503);
    const runId = typeof location.record.runId === "string" ? location.record.runId : null;
    const outputScope: OutputScope = {
      sessionEpoch: this.epochValue,
      documentRevision: this.documentRevisionValue,
      kernelEpoch,
      runId,
      cellId: owner.id,
      revision,
    };
    const generation = this.runtimeGeneration;
    this.pendingLazyOutputs.set(key, {
      operationId,
      clientId,
      owner: owner.id,
      recordId: location.record.id,
      revision,
      kernelEpoch,
    });
    void this.engine.request("lazy_eval", {
      key,
      id: owner.id,
      token: operationId,
    }, { outputScope }).then(async (raw) => {
      if (!this.runtimeRequestCurrent(operationId, generation, clientId)) return;
      const response = engineResponseSchema.parse(raw);
      const pending = this.pendingLazyOutputs.get(key);
      const current = this.findOutput((output) => output.kind === "lazy" && output.key === key);
      if (
        pending === undefined
        || pending.operationId !== operationId
        || pending.owner !== owner.id
        || pending.recordId !== location.record.id
        || pending.revision !== revision
        || pending.kernelEpoch !== kernelEpoch
        || current === null
        || current.owner !== owner.id
        || current.record.id !== location.record.id
        || this.cellById(owner.id)?.revision !== revision
        || this.runtimeSnapshot().kernelEpoch !== kernelEpoch
        || this.statusOf(owner.id) !== "done"
      ) {
        throw new ControllerError("lazy_expired", "lazy output is no longer current", 409);
      }
      owner.log = boundedLog([...owner.log, ...(response.log ?? [])]);
      if (!response.ok) {
        await this.updateOutputRecord(owner, current.record, (data) => {
          const lazy = findRichOutputRecord(data, (output) => output.kind === "lazy" && output.key === key);
          if (lazy === null) throw new ControllerError("lazy_expired", "lazy output is no longer current", 409);
          lazy.state = "error";
          lazy.child = { kind: "error", message: response.error?.message ?? "lazy output failed" };
        });
        this.pendingLazyOutputs.delete(key);
        this.bump("cell", this.publicCell(owner), { operationId, cellId: owner.id, revision });
        throw new ControllerError(
          response.error?.transport ? "worker_unavailable" : "lazy_eval_failed",
          response.error?.message ?? "lazy output failed",
          response.error?.transport ? 503 : 400,
        );
      }
      const child = clone(response.output ?? null);
      await this.updateOutputRecord(owner, current.record, (data) => {
        const lazy = findRichOutputRecord(data, (output) => output.kind === "lazy" && output.key === key);
        if (lazy === null) throw new ControllerError("lazy_expired", "lazy output is no longer current", 409);
        lazy.child = child;
        lazy.state = "ready";
      });
      this.pendingLazyOutputs.delete(key);
      this.scheduleVariableRefresh();
      this.completeOperation(operationId, { key, output: clone(child) }, clientId);
      this.bump("cell", this.publicCell(owner), { operationId, cellId: owner.id, revision });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(operationId, generation, clientId)) return;
      if (this.pendingLazyOutputs.get(key)?.operationId === operationId) this.pendingLazyOutputs.delete(key);
      this.scheduleVariableRefresh();
      this.failOperation(operationId, asControllerError(error, "lazy_eval_failed").toJSON(operationId), clientId);
    });
    return { key, cellId: owner.id };
  }

  private startTablePage(
    command: Extract<HostCommand, { type: "table-page" }>,
  ): unknown {
    this.assertExecutionPossible();
    if (this.pendingTablePages.has(command.handle)) {
      throw new ControllerError("operation_in_progress", "table paging request already pending", 409);
    }
    const location = this.findOutput((output) => output.kind === "table" && output.handle === command.handle);
    if (location === null) throw new ControllerError("table_unavailable", "table is unavailable", 404);
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("table_unavailable", "table is no longer current", 409);
    }
    this.assertLiveOutput(owner, location.record, "table_unavailable");
    const revision = owner.revision;
    const kernelEpoch = this.runtimeSnapshot().kernelEpoch;
    if (kernelEpoch === null) throw new ControllerError("stale_kernel", "R kernel incarnation is unavailable", 503);
    const generation = this.runtimeGeneration;
    this.pendingTablePages.set(command.handle, {
      operationId: command.operationId,
      clientId: command.clientId,
      owner: owner.id,
      recordId: location.record.id,
      revision,
      kernelEpoch,
    });
    const operation = this.operationFor(command.operationId, command.clientId);
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
    }).then(async (raw) => {
      if (!this.runtimeRequestCurrent(command.operationId, generation, command.clientId)) return;
      const response = engineResponseSchema.parse(raw);
      const responsePayload = response as unknown as Record<string, unknown>;
      const pending = this.pendingTablePages.get(command.handle);
      const current = this.findOutput((output) => output.kind === "table" && output.handle === command.handle);
      if (
        pending === undefined
        || pending.operationId !== command.operationId
        || pending.owner !== owner.id
        || pending.recordId !== location.record.id
        || pending.revision !== revision
        || pending.kernelEpoch !== kernelEpoch
        || current === null
        || current.owner !== owner.id
        || current.record.id !== location.record.id
        || this.cellById(owner.id)?.revision !== revision
        || this.runtimeSnapshot().kernelEpoch !== kernelEpoch
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
      const page = clone(responsePayload.page ?? responsePayload.value ?? null);
      await this.updateOutputRecord(owner, current.record, (data) => {
        const table = findRichOutputRecord(data, (output) => output.kind === "table" && output.handle === command.handle);
        if (table === null) throw new ControllerError("table_unavailable", "table is no longer current", 409);
        table.page = page;
      });
      this.pendingTablePages.delete(command.handle);
      this.completeOperation(command.operationId, { handle: command.handle, page: clone(page) }, command.clientId);
      this.bump("cell", this.publicCell(owner), { operationId: command.operationId, cellId: owner.id, revision });
    }).catch((error: unknown) => {
      if (!this.runtimeRequestCurrent(command.operationId, generation, command.clientId)) return;
      if (this.pendingTablePages.get(command.handle)?.operationId === command.operationId) {
        this.pendingTablePages.delete(command.handle);
      }
      this.failOperation(command.operationId, asControllerError(error, "table_request_failed").toJSON(command.operationId), command.clientId);
    });
    return { handle: command.handle, cellId: owner.id };
  }


  private async saveNotebook(expectedDocumentRevision: number, operationId: string): Promise<unknown> {
    this.assertStartedForMutation();
    if (this.pathValue === null || this.pathValue.length === 0) {
      throw new ControllerError("notebook_has_no_path", "notebook has no path", 400);
    }
    const request: SourceCommitRequest = {
      kind: "save",
      expectedDocumentRevision,
      operationId,
    };
    if (this.sourceCommit === undefined) {
      throw new ControllerError("service_unavailable", "durable notebook save service is unavailable", 503);
    }
    const result = await this.commitSource(request);
    this.assertNotClosed();
    this.replaceLastActionError(null);
    this.bump("notebook", { saved: true, result: clone(result) }, { operationId });
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
    const selected = ids.map((id) => {
      const cell = this.requireCell(id);
      return { id: cell.id, type: cell.type, body: [...cell.body], revision: cell.revision };
    });
    const codeCells = selected.filter((cell) => cell.type === "code");
    if (codeCells.length === 0) return { changed: 0, edited: [], created: [] };
    const formatted = await this.services.format(codeCells);
    this.assertNotClosed();
    for (const selectedCell of selected) {
      const current = this.requireCell(selectedCell.id);
      if (current.revision !== expectedRevisions[selectedCell.id]) {
        throw new ControllerError("source_conflict", "cell " + selectedCell.id + " changed while formatting", 409);
      }
    }
    if (!isRecord(formatted)
      || !setEqual(new Set(Object.keys(formatted)), new Set(codeCells.map((cell) => cell.id)))) {
      throw new ControllerError(
        "invalid_service_response",
        "formatter must return every selected code cell exactly once",
        503,
      );
    }
    const changes: DocumentChange[] = [];
    for (const selectedCell of codeCells) {
      const id = selectedCell.id;
      const cell = this.requireCell(id);
      const parsed = documentChangeSchema.safeParse({
        type: "edit",
        cell: { cellId: id },
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
      changes.push(parsed.data);
    }
    const result = await this.applySourceChanges(changes, false, operationId);
    return { changed: result.edited.filter((entry) => entry.revision !== expectedRevisions[entry.id]).length, ...result };
  }

  private async setRuntime(
    executionMode: "automatic" | "lazy" | undefined,
    runOnStartup: boolean | undefined,
    expectedDocumentRevision: number,
    operationId: string,
  ): Promise<unknown> {
    this.assertStartedForMutation();
    const patch: Record<string, unknown> = {};
    if (executionMode !== undefined) patch.on_cell_change = executionMode;
    if (runOnStartup !== undefined) patch.on_startup = runOnStartup;
    if (Object.keys(patch).length === 0) {
      throw new ControllerError("invalid_request", "runtime update is empty", 400);
    }
    if (this.sourceCommit === undefined) {
      throw new ControllerError("service_unavailable", "durable runtime service is unavailable", 503);
    }
    return this.commitSource({
      kind: "runtime",
      expectedDocumentRevision,
      operationId,
      patch,
    });
  }

  private async setConfig(
    patch: Record<string, unknown>,
    expectedDocumentRevision: number,
    expectedSidecarVersion: string | null,
    operationId: string,
  ): Promise<unknown> {
    this.assertStartedForMutation();
    const request: SourceCommitRequest = {
      kind: "sidecar",
      sidecar: "config",
      expectedDocumentRevision,
      expectedSidecarVersion,
      operationId,
      patch,
    };
    if (this.sourceCommit === undefined) {
      throw new ControllerError("service_unavailable", "durable config service is unavailable", 503);
    }
    return this.commitSource(request);
  }

  private async setLayout(
    layout: unknown,
    expectedDocumentRevision: number,
    expectedSidecarVersion: string | null,
    operationId: string,
  ): Promise<unknown> {
    this.assertStartedForMutation();
    const request: SourceCommitRequest = {
      kind: "sidecar",
      sidecar: "layout",
      expectedDocumentRevision,
      expectedSidecarVersion,
      operationId,
      layout: layout as JsonValue,
    };
    if (this.sourceCommit === undefined) {
      throw new ControllerError("service_unavailable", "durable layout service is unavailable", 503);
    }
    return this.commitSource(request);
  }

  private async callService(command: string, payload: Record<string, unknown>): Promise<unknown> {
    if (command === "check" || command === "packages.install") this.assertStarted();
    else this.assertDocumentReady();
    if (command === "r.select") this.assertNoRuntimeContextReservation();
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
    if (command === "set-app") return this.setApp(payload, this.documentRevisionValue, randomUUID());
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
    this.assertStarted();
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


  private assertPackageInstallCanStart(): void {
    this.assertStarted();
    this.assertNoRuntimeContextReservation();
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
    clientId: string,
  ): Promise<unknown> {
    if (command !== "packages.install") {
      throw new ControllerError("invalid_request", "unsupported long-running service", 400);
    }
    const operation = this.operationFor(operationId, clientId);
    if (operation !== undefined && operation.status === "accepted") operation.status = "running";
    if (operation !== undefined) this.rememberOperation(operation);
    this.packageOperationActive = true;
    this.packageOperationClientId = clientId;
    this.bump("runtime", this.runtimeSnapshot(), { operationId });
    try {
      return await this.runPackageInstall(payload, operationId, clientId);
    } finally {
      this.packageOperationActive = false;
      this.packageOperationClientId = undefined;
      this.bump("runtime", this.runtimeSnapshot(), { operationId });
    }
  }

  private async runPackageInstall(
    payload: Record<string, unknown>,
    operationId: string,
    clientId: string,
  ): Promise<unknown> {
    let packages = Array.isArray(payload.packages) ? [...payload.packages] as string[] : [];
    if (packages.length === 0) {
      const before = await this.callService("packages.status", { operationId });
      packages = packageMissing(before);
    }
    let result: unknown;
    let installFailure: unknown;
    try {
      result = await this.callService("packages.install", { ...payload, packages, operationId });
      const failure = serviceResultError(result, operationId);
      if (failure !== null) installFailure = failure;
    } catch (error) {
      installFailure = error;
    }

    let restartFailure: ControllerError | undefined;
    const restartRequired = !isRecord(result) || result.mutatedLibrary !== false;
    if (restartRequired) {
      try {
        await this.restartAfterPackageInstall(operationId, clientId);
      } catch (error) {
        restartFailure = asControllerError(error, "worker_unavailable", 503);
      }
    }
    if (installFailure !== undefined) {
      if (restartFailure !== undefined) {
        const installError = asControllerError(installFailure, "install_failed", 500);
        const restartDetails = restartFailure.toJSON(operationId);
        const details = isRecord(installError.details)
          ? { ...installError.details, restartFailure: restartDetails }
          : { installFailure: installError.details ?? null, restartFailure: restartDetails };
        throw new ControllerError(installError.code, installError.message, installError.status, details);
      }
      throw installFailure;
    }
    if (restartFailure !== undefined) throw restartFailure;
    const status = await this.callService("packages.status", { operationId });
    return { result: clone(result), status: clone(status) };
  }

  private async restartAfterPackageInstall(operationId: string, clientId: string): Promise<void> {
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
      let refreshedEnvironment = this.rEnvironmentValue;
      try {
        if (this.services.refreshPackageEnvironment !== undefined) {
          refreshedEnvironment = rEnvironmentSchema.parse(await this.services.refreshPackageEnvironment());
        }
        handshake = engineHandshakeSchema.parse(await this.engine.restart(
          refreshedEnvironment === null ? undefined : { environment: refreshedEnvironment },
        ));
      } catch (error) {
        const restartFailure = asControllerError(error, "worker_unavailable", 503);
        const failure = hostError(
          "worker_unavailable",
          `R engine restart after package installation failed: ${restartFailure.message}`,
        );
        this.setRuntimeAvailabilityError(failure);
        this.bump("runtime", this.runtimeSnapshot(), { operationId });
        throw new ControllerError("worker_unavailable", failure.message, 503, restartFailure.toJSON(operationId));
      }
      this.assertNotClosed();
      this.handshake = handshake;
      this.kernelEpochValue = handshake.kernel?.kernelEpoch ?? (handshake.kernelReady ? randomUUID() : null);
      this.outputStore.setIdentity({ documentRevision: this.documentRevisionValue, kernelEpoch: this.kernelEpochValue });
      this.analysisEnvironmentIdValue = null;
      this.kernelAvailable = handshake.kernelReady && handshake.captureReady;
      this.analyzerAvailable = handshake.analyzerReady;
      if (!this.kernelAvailable || !this.analyzerAvailable) {
        const failure = hostError("engine_not_ready", "R engine did not become ready after package installation");
        this.setRuntimeAvailabilityError(failure);
        this.bump("runtime", this.runtimeSnapshot(), { operationId });
        throw new ControllerError("engine_not_ready", failure.message, 503);
      }
      if (refreshedEnvironment !== null) this.rEnvironmentValue = clone(refreshedEnvironment);
      this.clearRuntimeAvailabilityError();
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

  private async setApp(payload: Record<string, unknown>, expectedDocumentRevision: number, operationId: string): Promise<unknown> {
    this.assertStartedForMutation();
    const request: SourceCommitRequest = {
      kind: "sidecar",
      expectedDocumentRevision,
      operationId,
      patch: payload,
    };
    if (this.sourceCommit === undefined) {
      throw new ControllerError("service_unavailable", "durable app service is unavailable", 503);
    }
    return this.commitSource(request);
  }

  private publicCell(cell: CellRecord): HostCellState {
    const analysis = cell.analysis ?? emptyAnalysis(cell.id, cell.revision);
    return {
      id: cell.id,
      type: cell.type,
      body: [...cell.body],
      options: clone(cell.options) as unknown as HostCellState["options"],
      revision: cell.revision,
      status: this.statusOf(cell.id),
      outputs: clone(cell.outputs) as unknown as HostCellState["outputs"],
      ...(cell.type === "code" && cell.outputsStale && cell.outputs.length ? { outputsStale: true } : {}),
      progress: clone(cell.progress) as HostCellState["progress"],
      log: [...cell.log],
      error: clone(cell.error) as unknown as HostCellState["error"],
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
    if (cell.type === "code" && this.graphValue.resourceLimited) {
      diagnostics.push({
        source: "alder",
        level: "error",
        code: "graph_blocked",
        message: `cannot run: dependency graph exceeds ${MAX_DEPENDENCY_EDGES} edge limit`,
        symbol: null,
        range: null,
      });
    }
    const analysis = cell.analysis;
    if (analysis?.error !== null && analysis?.error !== undefined) {
      diagnostics.push({
        source: "alder",
        level: "error",
        code: "syntax-error",
        message: analysis.error,
        symbol: null,
        range: null,
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
        range: null,
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
        range: null,
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
          range: null,
        });
      } else if (this.cells.filter((candidate) => candidate.options.name === name).length > 1) {
        diagnostics.push({
          source: "alder",
          level: "warning",
          code: "duplicate-cell-name",
          message: `duplicate cell name: ${name}`,
          symbol: null,
          range: null,
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

  private clearEditorDiagnostics(silent = false): void {
    if (this.editorDiagnostics.size === 0) return;
    const affected = [...this.editorDiagnostics.keys()];
    this.editorDiagnostics.clear();
    if (!silent) this.bump("editor-diagnostics", {});
    if (silent) return;
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

  private clearVariables(silent = false): void {
    clearTimeout(this.variableRefreshTimer);
    this.variableRefreshTimer = undefined;
    this.variableGeneration = nextRevision(this.variableGeneration);
    this.variableRefreshRequested = false;
    if (this.variables.length === 0) return;
    this.variables = [];
    if (!silent) this.bump("variables", []);
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
    for (const [key, operationKey] of [...this.pendingWidgets]) {
      const operation = this.operationForKey(operationKey);
      if (operation?.cellIds?.includes(id)) {
        const operationId = operation.id;
        if (operation.kind === "widget") cancelledWidgetRequests.push(operationId);
        this.pendingWidgets.delete(key);
        this.discardUpload(operationKey);
        const activeReset = this.activeButtonResets.get(operationId);
        if (activeReset !== undefined) {
          this.activeButtonResets.delete(operationId);
          const reset = activeReset.reset;
          const owner = this.cellById(reset.owner);
          const current = this.findWidget(reset.name);
          if (owner !== undefined && owner.revision === reset.revision
            && current !== null && current.record.id === reset.record.id
            && this.pendingWidgets.get(reset.key) === undefined) {
            void this.updateOutputRecord(owner, current.record, (data) => {
              const widget = findRichOutputRecord(data, (output) => output.kind === "widget" && output.name === reset.name);
              if (widget !== null) setWidgetOperation(widget, reset.key, {
                token: activeReset.token,
                operationId,
                status: "cancelled",
                error: { code: "widget_not_current", message: "widget owner changed" },
              });
            }).then((record) => {
              reset.record = record;
              this.bump("cell", this.publicCell(owner), { operationId, cellId: owner.id, revision: owner.revision });
            }).catch(() => undefined);
          }
        }
        if (!isTerminal(operation.status)) {
          operation.status = "cancelled";
          operation.error = hostError("widget_not_current", "widget owner changed", operation.id);
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
    for (const [operationKey, pending] of [...this.pendingUploads]) {
      if (pending.owner !== id) continue;
      this.discardUpload(operationKey);
      const operation = this.operationForKey(operationKey);
      if (operation !== undefined && !isTerminal(operation.status)) {
        operation.status = "cancelled";
        operation.error = hostError("widget_not_current", "widget owner changed", operation.id);
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
      pending.clientId,
    );
  }

  private cancelRuntimeRequestsOwnedBy(id: string, inspectionCode: string): void {
    if (this.pendingInspection?.owner === id) {
      const pending = this.pendingInspection;
      this.pendingInspection = null;
      this.failOperation(
        pending.operationId,
        hostError(inspectionCode, staleValueMessage(pending.name), pending.operationId),
        pending.clientId,
      );
    }
    for (const [key, pending] of [...this.pendingLazyOutputs]) {
      if (pending.owner !== id) continue;
      this.pendingLazyOutputs.delete(key);
      this.failOperation(
        pending.operationId,
        hostError("lazy_expired", "lazy output is no longer current", pending.operationId),
        pending.clientId,
      );
    }
    for (const [handle, pending] of [...this.pendingTablePages]) {
      if (pending.owner !== id) continue;
      this.pendingTablePages.delete(handle);
      this.failOperation(
        pending.operationId,
        hostError("table_unavailable", "table is no longer current", pending.operationId),
        pending.clientId,
      );
    }
  }

  private findWidget(name: string): { owner: string; widget: Record<string, unknown>; record: OutputRecord } | null {
    for (const cell of this.cells) {
      for (let index = cell.outputs.length - 1; index >= 0; index -= 1) {
        const record = cell.outputs[index]!;
        if (this.outputStore.getRecord(record.id) !== record) continue;
        const widget = findRichOutputRecord(record.data, (output) =>
          output.kind === "widget" && output.name === name,
        );
        if (widget !== null) return { owner: cell.id, widget, record };
      }
    }
    return null;
  }

  private findOutput(
    predicate: (output: Record<string, unknown>) => boolean,
  ): { owner: string; output: Record<string, unknown>; record: OutputRecord } | null {
    for (const cell of this.cells) {
      for (const record of cell.outputs) {
        if (this.outputStore.getRecord(record.id) !== record) continue;
        const found = findRichOutputRecord(record.data, predicate);

        if (found !== null) return { owner: cell.id, output: found, record };
      }
    }
    return null;
  }
  private findCanonicalOutputById(id: string): OutputRecord | null {
    for (const cell of this.cells) {
      const record = cell.outputs.find((candidate) => candidate.id === id);
      if (record !== undefined && this.outputStore.getRecord(record.id) === record) return record;
    }
    return null;
  }


  private async updateOutputRecord(
    owner: CellRecord,
    expected: OutputRecord,
    update: (data: Record<string, unknown>) => void,
  ): Promise<OutputRecord> {
    if (this.outputStore.getRecord(expected.id) !== expected) {
      throw new ControllerError("stale_value", "output is no longer current", 409);
    }
    const data = clone(expected.data);
    if (!isRecord(data)) throw new ControllerError("invalid_engine_response", "output data is invalid", 503);
    update(data);
    const checked = richOutputPayloadSchema.safeParse(data);
    if (!checked.success) {
      throw new ControllerError("invalid_engine_response", "output data is invalid", 503);
    }
    const next = await this.outputStore.updateRecord(expected, checked.data);
    const index = owner.outputs.findIndex((record) => record === expected);
    if (index < 0 || this.outputStore.getRecord(expected.id) !== next) {
      this.outputStore.discardExact([next]);
      throw new ControllerError("stale_value", "output is no longer current", 409);
    }
    owner.outputs[index] = next;
    return next;
  }

  private assertLiveOutput(owner: CellRecord, record: OutputRecord, error: string): void {
    if (
      this.outputStore.getRecord(record.id) !== record
      || record.sessionEpoch !== this.epochValue
      || record.kernelEpoch !== this.kernelEpochValue
      || record.runId === null
      || record.cellId !== owner.id
      || record.revision !== owner.revision
      || this.statusOf(owner.id) !== "done"
    ) {
      throw new ControllerError(error, "output is no longer current", 409);
    }
  }


  private createOperation(
    id: string,
    kind: OperationRecord["kind"],
    clientId = "internal",
    commandSequence = 1,
  ): OperationRecord {
    if (this.operations.has(this.operationKey(clientId, id))) {
      throw new ControllerError("operation_id_conflict", "operation " + id + " already exists", 409);
    }
    const operation: OperationRecord = {
      id,
      clientId,
      commandSequence,
      kind,
      status: "accepted",
      documentRevision: this.documentRevisionValue,
      runId: null,
      result: null,
      error: null,
      acceptedAt: Date.now(),
    };
    this.operations.set(this.operationKey(operation.clientId, operation.id), operation);
    this.trimOperations();
    return operation;
  }

  private rememberOperation(operation: OperationRecord): void {
    this.operations.set(this.operationKey(operation.clientId, operation.id), operation);
    this.emit("operation", clone(operation), { operationId: operation.id, runId: operation.runId ?? undefined });
    this.trimOperations();
  }

  private completeOperation(id: string, result?: unknown, clientId = "internal"): void {
    const operation = this.operationFor(id, clientId);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.status = "done";
    operation.result = (result === undefined ? null : clone(result)) as OperationRecord["result"];
    operation.error = null;
    operation.documentRevision = this.documentRevisionValue;
    operation.settledAt = Date.now();
    this.rememberOperation(operation);
    this.notifyOperationWaiters(operation);
  }

  private failOperation(id: string, error: HostError, clientId = "internal"): void {
    const operation = this.operationFor(id, clientId);
    if (operation === undefined || isTerminal(operation.status)) return;
    operation.status = "error";
    if (operation.kind !== "run") operation.result = null;
    operation.error = clone(error);
    operation.documentRevision = this.documentRevisionValue;
    operation.settledAt = Date.now();
    this.rememberOperation(operation);
    this.notifyOperationWaiters(operation);
  }

  private markOperationCancellationRequested(id: string, clientId = "internal"): void {
    const operation = this.operationFor(id, clientId);
    if (operation === undefined || isTerminal(operation.status)) return;
    if (operation.status === "accepted") operation.status = "running";
    this.rememberOperation(operation);
  }

  private notifyOperationWaiters(operation: OperationRecord): void {
    if (!isTerminal(operation.status)) return;
    const key = this.operationKey(operation.clientId, operation.id);
    const waiters = this.operationWaiters.get(key);
    if (waiters === undefined) return;
    this.operationWaiters.delete(key);
    for (const waiter of waiters) waiter(operation);
  }

  private trimOperations(): void {
    if (this.operations.size <= OPERATION_JOURNAL_LIMIT) return;
    for (const [id, operation] of this.operations) {
      if (this.operations.size <= OPERATION_JOURNAL_LIMIT) break;
      if (isTerminal(operation.status)) this.operations.delete(id);
    }
  }
  private assertDocumentRevision(expected: number): void {
    if (expected !== this.documentRevisionValue) {
      throw new ControllerError("source_conflict", "document revision is stale", 409, {
        kind: "document", expectedDocumentRevision: expected, actualDocumentRevision: this.documentRevisionValue,
      });
    }
  }

  private assertKernelEpoch(expected: string | null): void {
    if (expected === null || this.kernelEpochValue === null || expected !== this.kernelEpochValue) {
      throw new ControllerError("stale_kernel", "kernel incarnation is stale", 409, {
        expectedKernelEpoch: expected, actualKernelEpoch: this.kernelEpochValue,
      });
    }
  }

  private resolveCellRef(ref: CellRef, transaction?: unknown): string {
    if (ref !== null && typeof ref === "object" && "cellId" in ref && typeof ref.cellId === "string") {
      if (this.cellById(ref.cellId) === undefined) throw new ControllerError("not_found", "no such cell: " + ref.cellId, 404);
      return ref.cellId;
    }
    if (ref !== null && typeof ref === "object" && "creationId" in ref && typeof ref.creationId === "string") {
      const mapping = isRecord(transaction) && isRecord(transaction.created) ? transaction.created : null;
      const candidate = mapping === null ? undefined : mapping[ref.creationId];
      const created = typeof candidate === "string" ? candidate : undefined;
      if (created === undefined || this.cellById(created) === undefined) throw new ControllerError("not_found", "no such transaction creation: " + ref.creationId, 404);
      return created;
    }
    throw new ControllerError("invalid_request", "cell reference is invalid", 400);
  }

  private startUploadOperation(command: Extract<HostCommand, { type: "upload" }>): unknown {
    this.assertExecutionPossible();
    this.assertGraphRunnable();
    this.assertKernelEpoch(command.kernelEpoch);
    if (this.services.service === undefined) {
      throw new ControllerError("service_unavailable", "upload service is unavailable", 503);
    }
    const location = this.findWidget(command.name);
    if (location === null) throw new ControllerError("invalid_request", "no such widget: " + command.name, 400);
    const owner = this.requireCell(location.owner);
    if (this.statusOf(owner.id) !== "done") {
      throw new ControllerError("widget_not_current", "widget " + command.name + " is not current", 409);
    }
    this.assertLiveOutput(owner, location.record, "widget_not_current");
    const spec = isRecord(location.widget.spec) ? location.widget.spec : null;
    const target = spec === null ? null : widgetSpecAt(spec, command.path);
    if (target === null || target.kind !== "file") {
      throw new ControllerError("invalid_request", "upload path is not a file widget", 400);
    }
    const key = widgetKey(command.name, command.path);
    if (this.pendingWidgets.has(key) || [...this.pendingUploads.values()].some((pending) => pending.key === key)) {
      throw new ControllerError("operation_in_progress", "widget " + command.name + " already has a pending update", 409);
    }
    const operation = this.operationFor(command.operationId, command.clientId);
    if (operation !== undefined) {
      operation.kind = "widget";
      operation.status = "running";
      operation.cellIds = [owner.id];
      this.rememberOperation(operation);
    }
    this.pendingUploads.set(this.operationKey(command.clientId, command.operationId), {
      clientId: command.clientId,
      name: command.name,
      path: [...command.path],
      key,
      owner: owner.id,
      revision: owner.revision,
      record: location.record,
      uploadId: null,
      source: "app",
    });
    void this.storeAndApplyUpload(command).catch((error: unknown) => {
      if (this.closed) return;
      const failure = asControllerError(error, "upload_failed");
      const hostFailure = failure.toJSON(command.operationId);
      this.replaceLastActionError(hostFailure, { operationId: command.operationId });
      this.discardUpload(this.operationKey(command.clientId, command.operationId));
      this.failOperation(command.operationId, hostFailure, command.clientId);
    });
    return { accepted: true, command: "upload", owner: owner.id };
  }

  private async storeAndApplyUpload(command: Extract<HostCommand, { type: "upload" }>): Promise<void> {
    const raw = await this.services.service?.("upload.store", { files: clone(command.files) });
    const response = parseStoredUpload(raw);
    const pending = this.pendingUploads.get(this.operationKey(command.clientId, command.operationId));
    if (pending === undefined || this.closed || isTerminal(this.operationFor(command.operationId, command.clientId)?.status ?? "error")) {
      await this.removeUpload(response.uploadId);
      return;
    }
    pending.uploadId = response.uploadId;
    const current = this.findWidget(pending.name);
    const owner = this.cellById(pending.owner);
    const target = current !== null && isRecord(current.widget.spec) ? widgetSpecAt(current.widget.spec, pending.path) : null;
    if (current === null || current.owner !== pending.owner || current.record.id !== pending.record.id
      || owner === undefined || owner.revision !== pending.revision || this.statusOf(owner.id) !== "done"
      || target?.kind !== "file") {
      throw new ControllerError("widget_not_current", "file widget is no longer current", 409);
    }
    pending.record = current.record;
    this.startWidgetOperation({
      type: "widget",
      operationId: command.operationId,
      clientId: command.clientId,
      commandSequence: command.commandSequence,
      sessionEpoch: command.sessionEpoch,
      name: pending.name,
      path: [...pending.path],
      update: { value: clone(response.value) as JsonValue },
      source: pending.source,
      kernelEpoch: command.kernelEpoch,
      expectedRevision: pending.revision,
    });
  }


  private executeSourceService(request: SourceCommitRequest): Promise<unknown> {
    if (this.sourceCommit === undefined) {
      return Promise.reject(new ControllerError("service_unavailable", "durable source service is unavailable", 503));
    }
    return this.commitSource(request);
  }

  private async declarePackages(
    packages: readonly string[],
    expectedDocumentRevision: number,
    expectedSidecarVersion: string | null,
    operationId: string,
  ): Promise<unknown> {
    const request: SourceCommitRequest = {
      kind: "sidecar",
      sidecar: "packages",
      expectedDocumentRevision,
      expectedSidecarVersion,
      operationId,
      packages,
    };
    if (this.sourceCommit === undefined) {
      throw new ControllerError("service_unavailable", "durable package declaration service is unavailable", 503);
    }
    return this.commitSource(request);
  }

  private async executeTypedService(command: Extract<HostCommand, { type: "save-as" | "reload-source" | "select-r" | "set-app" | "packages-declare" | "packages-install" | "publish" | "upload" }>): Promise<unknown> {
    switch (command.type) {
      case "select-r":
        this.assertDocumentRevision(command.expectedDocumentRevision);
        return this.callService("r.select", { rscript: command.rscript, persistDefault: command.persistDefault });
      case "set-app":
        return this.setApp(command.patch, command.expectedDocumentRevision, command.operationId);
      case "packages-declare":
        return this.declarePackages(command.packages, command.expectedDocumentRevision, command.expectedSidecarVersion, command.operationId);
      case "packages-install":
        this.assertDocumentRevision(command.expectedDocumentRevision);
        this.assertKernelEpoch(command.kernelEpoch);
        this.assertPackageInstallCanStart();
        this.assertExecutionPossible();
        return this.runLongService("packages.install", { packages: command.packages }, command.operationId, command.clientId);
      case "publish": {
        this.assertDocumentRevision(command.expectedDocumentRevision);
        const reservation = this.reserveRuntimeContext();
        try {
          return await this.callService("publish", { includeCode: command.includeCode, outputPath: command.outputPath });
        } finally {
          reservation.release();
        }
      }
      case "save-as":
        return this.executeSourceService({
          kind: "save-as",
          expectedDocumentRevision: command.expectedDocumentRevision,
          operationId: command.operationId,
          path: command.path,
          expectedDestination: command.expectedDestination === "absent" ? undefined : command.expectedDestination,
          fingerprint: stableStringify({ path: command.path, expectedDestination: command.expectedDestination }),
        });
      case "reload-source":
        return this.executeSourceService({
          kind: "reload-source",
          expectedDocumentRevision: command.expectedDocumentRevision,
          expectedDisk: { digest: command.expectedDiskDigest, version: command.expectedDiskVersion },
          operationId: command.operationId,
          fingerprint: stableStringify({ expectedDiskDigest: command.expectedDiskDigest, expectedDiskVersion: command.expectedDiskVersion }),
        });
      case "upload":
        this.assertKernelEpoch(command.kernelEpoch);
        return this.callService("upload", { name: command.name, path: command.path, files: command.files });
      default:
        throw assertNever(command);
    }
  }
  private trimCommandEntries(): void {
    if (this.commandEntries.size <= COMMAND_DEDUPLICATION_LIMIT) return;
    for (const [key, entry] of this.commandEntries) {
      if (this.commandEntries.size <= COMMAND_DEDUPLICATION_LIMIT) break;
      if (isTerminal(this.operationForKey(this.operationKey(entry.clientId, entry.operationId))?.status ?? "done")) this.commandEntries.delete(key);
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

  private commitDocumentRevision(): number {
    this.documentRevisionValue = nextRevision(this.documentRevisionValue);
    this.outputStore.setIdentity({ documentRevision: this.documentRevisionValue, kernelEpoch: this.kernelEpochValue });
    return this.documentRevisionValue;
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
    silent = false,
  ): void {
    if (this.graphValue.resourceLimited) {
      const error = hostError("graph_blocked", "dependency graph exceeds the " + MAX_DEPENDENCY_EDGES + " edge limit");
      if (silent) this.lastActionError = error;
      else this.replaceLastActionError(error, identity);
    } else if (this.lastActionError?.code === "graph_blocked" && this.analysisNeeded.size === 0) {
      if (silent) this.lastActionError = null;
      else this.replaceLastActionError(null, identity);
    }
  }
  private emitActiveClientsChanged(clientId: string): void {
    this.emit("active_clients_changed", { activeClientIds: [...this.activeClients] }, { clientId });
  }

  private emit(
    type: HostEventType,
    payload: unknown,
    identity: Partial<Pick<HostEvent, "operationId" | "clientId" | "commandSequence" | "cellId" | "runId" | "kernelEpoch" | "revision" | "sequence">> = {},
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
      documentRevision: this.documentRevisionValue,
      timestamp: Date.now(),
      type,
      payload: clone(payload) as HostEvent["payload"],
    };
    if (identity.operationId !== undefined) event.operationId = identity.operationId;
    if (identity.clientId !== undefined) event.clientId = identity.clientId;
    if (identity.commandSequence !== undefined) event.commandSequence = identity.commandSequence;
    if (identity.cellId !== undefined) event.cellId = identity.cellId;
    if (identity.runId !== undefined) event.runId = identity.runId;
    if (identity.kernelEpoch !== undefined) event.kernelEpoch = identity.kernelEpoch;
    if (identity.revision !== undefined) event.revision = identity.revision;
    if (identity.sequence !== undefined) event.sequence = identity.sequence;
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
    const queuedRunId = this.queue[0]?.runId ?? null;
    return {
      documentReady: this.documentReady,
      analyzerState: this.starting && !this.analyzerAvailable ? "starting" : this.analyzerAvailable ? "ready" : (this.analyzerStartupAttempted ? "failed" : "stopped"),
      kernelState: this.starting && !this.kernelAvailable ? "starting" : this.kernelAvailable ? "ready" : (this.kernelStartupAttempted ? "failed" : "stopped"),
      executionReady: this.executionReady,
      startupActivated: this.startupActivated,
      executionBlockedReason: this.runtimeAvailabilityError,
      kernelEpoch: this.kernelEpochValue,
      rEnvironment: this.rEnvironmentValue,
      analysisEnvironmentId: this.analysisEnvironmentIdValue,
      executionMode: this.executionMode,
      runOnStartup: this.runOnStartup,
      packageOperationActive: this.packageOperationActive,
      busy: this.activeEvaluation !== null || this.queue.length > 0 || this.runPreparationActive,
      activeRunId: this.activeEvaluation?.job.runId ?? queuedRunId,
    };
  }

  private markdownPayload(cell: CellRecord): unknown {
    return {
      kind: "markdown",
      text: toLogicalCellBody("markdown", cell.body).join("\n"),
    };
  }

  private ingestMarkdown(cell: CellRecord): OutputRecord | Promise<OutputRecord> {
    return this.outputStore.ingestAlder(this.markdownPayload(cell), {
      sessionEpoch: this.epochValue,
      documentRevision: this.documentRevisionValue,
      kernelEpoch: null,
      runId: null,
      cellId: cell.id,
      revision: cell.revision,
    });
  }

  private installInitialMarkdownOutputs(): void {
    for (const cell of this.cells) {
      if (cell.type !== "markdown") continue;
      const result = this.ingestMarkdown(cell);
      if (result instanceof Promise) {
        void result.then((record) => {
          const current = this.cellById(cell.id);
          if (current === undefined || current !== cell || current.type !== "markdown") {
            this.outputStore.discardExact([record]);
            return;
          }
          current.outputs = [record];
          current.status = "done";
        }).catch((error: unknown) => {
          this.replaceLastActionError(hostError("markdown_render_failed", messageOf(error)), {
            cellId: cell.id,
            revision: cell.revision,
          });
        });
      } else {
        cell.outputs = [result];
      }
    }
  }

  private scheduleMarkdownRender(cell: CellRecord): void {
    const revision = cell.revision;
    const body = [...cell.body];
    const install = (record: OutputRecord): void => {
      const current = this.cellById(cell.id);
      if (
        this.closed
        || current === undefined
        || current.type !== "markdown"
        || current.revision !== revision
        || !arrayEqual(current.body, body)
      ) {
        this.outputStore.discardExact([record]);
        return;
      }
      const previous = current.outputs;
      current.outputs = [record];
      current.status = "done";
      current.outputsStale = false;
      this.outputStore.discardExact(previous);
      this.bump("cell", this.publicCell(current), {
        cellId: current.id,
        revision: current.revision,
      });
    };
    const fail = (error: unknown): void => {
      if (this.closed) return;
      this.replaceLastActionError(hostError("markdown_render_failed", messageOf(error)), {
        cellId: cell.id,
        revision,
      });
    };
    try {
      const result = this.ingestMarkdown(cell);
      if (result instanceof Promise) void result.then(install).catch(fail);
      else install(result);
    } catch (error) {
      fail(error);
    }
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

  private assertDocumentReady(): void {
    this.assertNotClosed();
    if (!this.documentReady) {
      throw new ControllerError("session_not_started", "document is not ready", 409);
    }
  }

  private assertStarted(): void {
    this.assertDocumentReady();
    if (!this.started) throw new ControllerError("session_not_started", "session is not started", 409);
  }

  private assertStartedForMutation(): void {
    this.assertDocumentReady();
  }

  private assertExecutionPossible(): void {
    this.assertStarted();
    const availability = this.runtimeAvailabilityError;
    if (availability?.code === "kernel_state_invalid") {
      throw new ControllerError(availability.code, availability.message, 409);
    }
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

  private runtimeRequestCurrent(operationId: string, generation: number, clientId = "internal"): boolean {
    const operation = this.operationFor(operationId, clientId);
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


function joinSource(lines: readonly string[]): string {
  return lines.join("\n");
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
  } as HostError;
}

function commandKey(clientId: string, operationId: string): string {
  return clientId + "\u0000" + operationId;
}

function errorStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "worker_unavailable" || code === "analysis_unavailable") return 503;
  if (
    code === "source_conflict"
    || code === "config_shadowed"
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
    const details = Object.hasOwn(error, "details") ? error.details : undefined;
    return new ControllerError(error.code, error.message, errorStatus(error.code), details);
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
  return status === "done" || status === "error" || status === "interrupted" || status === "cancelled";
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
function findRichOutputRecord(
  value: unknown,
  predicate: (output: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (predicate(value)) return value;
  if (value.kind === "layout" && Array.isArray(value.children)) {
    for (const child of value.children) {
      const found = findRichOutputRecord(child, predicate);
      if (found !== null) return found;
    }
  }
  if (value.kind === "lazy" && value.child !== null && value.child !== undefined) {
    return findRichOutputRecord(value.child, predicate);
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
      || ((kind === "date" || kind === "date_range") && !canonicalCalendarDate(value))
      || (kind === "datetime" && !canonicalUtcSecond(value)))) {
      throw new ControllerError("invalid_request", "temporal widget value required", 400);
    }
    const first = values[0] as string;
    const last = values[1] as string;
    if (kind === "date_range" && first > last) {
      throw new ControllerError("invalid_request", "date range must be non-decreasing", 400);
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

function canonicalCalendarDate(value: string): boolean {
  const milliseconds = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().slice(0, 10) === value;
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
  operation: WidgetOperation,
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= R_INTEGER_MAX;
}

function integerArray(value: unknown, positive: boolean): value is number[] {
  return Array.isArray(value)
    && value.every((candidate) => Number.isSafeInteger(candidate) && (!positive || candidate > 0))
    && new Set(value).size === value.length;
}


function isLongService(command: string): boolean {
  return command === "publish"
    || command === "upload"
    || command === "packages.install";
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
