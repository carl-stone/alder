import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { ApplicationResources } from "./resources.js";

import { rKernelEnvironmentVariables, rServiceEnvironmentVariables } from "./r-environment.js";
import type { OwnedProcess, ProcessScope } from "./processes.js";


import {
  artifactHandleSchema,
  analysisResultSchema,
  clearCellRequestSchema,
  cellSnapshotSchema,
  engineErrorSchema,
  rawEngineErrorSchema,
  engineEventSchema,
  engineHandshakeSchema,
  engineResponseSchema,
  evaluationPayloadSchema,
  releaseOutputsResponseSchema,
  protocolJsonSchema,
  progressOutputSchema,
  rEnvironmentSchema,
  ENGINE_PROTOCOL,
  DEFAULT_MAX_ENGINE_FRAME_BYTES,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  MAX_RELEASE_ARTIFACTS,
  type AnalysisResult,
  type CellSnapshot,
  type AnalyzerIdentity,
  type KernelIdentity,
  type EngineAdapter,
  type EngineEvent,
  type EngineHandshake,
  type EngineRestartOptions,
  type REnvironment,
  type EngineResponse,
  type EvaluationPayload,
  type ArtifactHandle,
  type OutputRecord,
  type EngineRequestOptions,
  type OutputScope,
} from "./protocol.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FrameDecoder,
  FrameProtocolError,
  encodeFrame,
} from "./framing.js";

import { parseStrictJson } from "./strict-json.js";
import { PerformanceTrace, type PerformanceSpan, type TraceFields } from "./performance.js";
import { OutputLog } from "./output-log.js";
import { OutputStore } from "./outputs.js";
import {
  ArkKernel,
  type ArkKernelInfo,
  type ArkExecution,
  type JupyterMessage,
} from "./jupyter.js";
export type { EngineHandshake };

type FailureRole = "kernel" | "analyzer";
type RPeerRole = "analyzer";
type PeerRole = FailureRole;
type EngineState = "new" | "starting" | "ready" | "degraded" | "restarting" | "closed";

const KERNEL_COMMANDS = new Set([
  "ping",
  "clear_cell",
  "release_outputs",
  "get_value",
  "env_snapshot",
  "set_widget",
  "lazy_eval",
  "table_page",
]);

const MAX_PENDING_REQUESTS = 1_024;
const MAX_OUTPUT_RECORDS = 4_096;
const MAX_LOG_BYTES = 1_048_576;
const LOG_TRUNCATION_MARKER = "[output truncated at 1048576 bytes]";
export interface EngineOptions {
  resources: ApplicationResources;
  processScope: ProcessScope;
  environment?: REnvironment;
  notebookDirectory?: string;
  artifactDirectory: string;
  cacheDirectory?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxFrameBytes?: number;
}



export class EngineTransportError extends Error {
  constructor(
    message: string,
    readonly role?: PeerRole,
  ) {
    super(message);
    this.name = "EngineTransportError";
  }
}

export class EngineRequestError extends Error {
  readonly code: string;

  constructor(
    message: string,
    readonly response: EngineResponse,
  ) {
    super(message);
    this.name = "EngineRequestError";
    this.code = response.error?.code ?? "engine_error";
  }
}

interface RawHandshake {
  protocol: typeof ENGINE_PROTOCOL;
  role: RPeerRole;
  packageVersion: string;
  rVersion: string;
  capabilities: string[];
}

interface PendingRRequest {
  id: number;
  role: RPeerRole;
  command: string;
  wire: Record<string, unknown>;
  resolve: (value: Record<string, unknown>) => void;
  generation: number;
  reject: (error: Error) => void;
}

interface ResolvedPaths {
  arkExecutable: string;
  arkStartupScript: string;
  analyzerScript: string;
  framingScript: string;
  notebookDirectory: string;
  artifactDirectory: string;
  cacheDirectory: string;
  ownedDirectories: string[];
  analyzerEnvironment: Record<string, string>;
  arkEnvironment: Record<string, string>;
}

interface RuntimePaths {
  captureDirectory: string;
  controlDirectory: string;
  ownedDirectories: string[];
}
interface ActiveEvaluation {
  requestId: number;
  payload: EvaluationPayload;
  onEvent?: (event: EngineEvent) => void;
  kernelGeneration: number;
  started: boolean;
  sequence: number;
  rSequence: number;
  outputs: OutputRecord[];
  outputBytes: number;
  log: string[];
  console: OutputLog;
  truncated: boolean;
  stopped: boolean;
  finished: boolean;
  kernelTerminal: boolean;
  interruptSent: boolean;
  clearPending: boolean;
  deferredArtifactReleases: Set<string>;
  error?: EngineResponse["error"];
  structuredError?: EngineResponse["error"];
  kernelStateInvalid?: EngineResponse["kernelStateInvalid"],
  messageTail: Promise<void>;
  messageError?: Error;
  eventStream: ArkEventStreamDecoder;
  batch?: ActiveBatch;
}

interface ActiveBatch {
  payloads: readonly EvaluationPayload[];
  states: ActiveEvaluation[];
  invalidated: Set<string>;
  cancelled: boolean;
  interrupted: boolean;
  permit?: string;
  current?: ActiveEvaluation;
}

class RPeer {
  private child: OwnedProcess | undefined;
  private readonly decoder: FrameDecoder;
  private writeTail: Promise<void> = Promise.resolve();
  private handshakeResolve: ((value: RawHandshake) => void) | undefined;
  private handshakeReject: ((error: Error) => void) | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private exitPromise: Promise<void> = Promise.resolve();
  private exitResolve: (() => void) | undefined;
  private handshake: RawHandshake | undefined;
  private failed = false;
  private intentionalExit = false;
  private childExited = false;
  private stderr = Buffer.alloc(0);

  constructor(
    readonly role: RPeerRole,
    private readonly rscript: string,
    private readonly script: string,
    private readonly cwd: string,
    private readonly environment: Record<string, string>,
    private readonly processScope: ProcessScope,
    private readonly maxFrameBytes: number,
    private readonly startupTimeoutMs: number,
    private readonly onFrame: (role: RPeerRole, frame: unknown) => void,
    private readonly onFailure: (
      role: RPeerRole,
      error: EngineTransportError,
      intentional: boolean,
    ) => void,
  ) {
    this.decoder = new FrameDecoder(maxFrameBytes);
  }

  get ready(): boolean {
    return this.handshake !== undefined && !this.failed &&
      this.child !== undefined && !this.childExited;
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }
  get info(): RawHandshake | undefined { return this.handshake; }
  async start(): Promise<RawHandshake> {
    if (this.child !== undefined) throw new Error(this.role + " peer was already started");
    const startup = new Promise<RawHandshake>((resolveHandshake, rejectHandshake) => {
      this.handshakeResolve = resolveHandshake;
      this.handshakeReject = rejectHandshake;
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.exitResolve = resolveExit;
    });
    let child: OwnedProcess;
    try {
      child = await this.processScope.spawn({
        executable: this.rscript,
        args: ["--vanilla", this.script],
        cwd: this.cwd,
        environment: this.environment,
        stdio: "pipes",
      });
    } catch (error) {
      const failure = new EngineTransportError(
        "could not start " + this.role + ": " + asError(error).message,
        this.role,
      );
      this.fail(failure);
      return await startup;
    }
    this.child = child;
    this.childExited = false;
    child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.recordStderr(chunk));
    child.stdin?.on("error", (error) => this.fail(new EngineTransportError(
      "could not write to " + this.role + ": " + error.message,
      this.role,
    )));
    void child.exited.then(({ code, signal }) => {
      this.childExited = true;
      this.exitResolve?.();
      if (!this.failed && !this.intentionalExit) {
        const reason = code === null ? "signal " + (signal ?? "unknown") : "exit status " + code;
        this.fail(new EngineTransportError(
          this.role + " exited (" + reason + ")" + this.stderrText(),
          this.role,
        ));
      }
    }, (error) => {
      this.childExited = true;
      this.exitResolve?.();
      if (!this.failed && !this.intentionalExit) {
        this.fail(new EngineTransportError(
          this.role + " process failed: " + asError(error).message,
          this.role,
        ));
      }
    });
    this.startupTimer = setTimeout(() => {
      this.fail(new EngineTransportError(
        this.role + " did not become ready within " + this.startupTimeoutMs + " ms" + this.stderrText(),
        this.role,
      ));
    }, this.startupTimeoutMs);
    return startup;
  }

  send(value: unknown): Promise<void> {
    if (!this.ready || this.child === undefined) {
      return Promise.reject(new EngineTransportError(this.role + " is unavailable", this.role));
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(value, this.maxFrameBytes);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const write = this.writeTail.then(async () => {
      const input = this.child?.stdin;
      if (input === undefined || input === null || input.destroyed) {
        throw new EngineTransportError(this.role + " input is closed", this.role);
      }
      await new Promise<void>((resolveWrite, rejectWrite) => {
        input.write(frame, (error) => {
          if (error !== null && error !== undefined) rejectWrite(error);
          else resolveWrite();
        });
      });
    });
    this.writeTail = write.catch(() => {});
    return write.catch((error) => {
      const transportError = new EngineTransportError(
        "could not write to " + this.role + ": " + asError(error).message,
        this.role,
      );
      this.fail(transportError);
      throw transportError;
    });
  }

  expectExit(): void {
    this.intentionalExit = true;
  }

  async terminate(timeoutMs: number): Promise<void> {
    this.intentionalExit = true;
    const child = this.child;
    if (child === undefined || this.childExited) return;
    await this.waitForExit(timeoutMs);
    if (!this.childExited) {
      await child.terminate().catch(() => {});
      await this.waitForExit(Math.max(250, timeoutMs));
    }
    if (!this.childExited) {
      throw new EngineTransportError(
        this.role + " did not exit after supervisor termination",
        this.role,
      );
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.childExited) return;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
    ]);
  }

  private receive(chunk: Buffer): void {
    if (this.failed) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(new EngineTransportError(
        "invalid " + this.role + " frame: " + asError(error).message + this.stderrText(),
        this.role,
      ));
      return;
    }
    for (const frame of frames) {
      if (this.failed) return;
      if (this.handshake === undefined) {
        try {
          this.handshake = parseHandshake(this.role, frame);
          clearTimeout(this.startupTimer);
          this.startupTimer = undefined;
          this.handshakeResolve?.(this.handshake);
          this.handshakeResolve = undefined;
          this.handshakeReject = undefined;
        } catch (error) {
          this.fail(new EngineTransportError(
            "invalid " + this.role + " handshake: " + asError(error).message,
            this.role,
          ));
        }
      } else {
        try {
          this.onFrame(this.role, frame);
        } catch (error) {
          this.fail(new EngineTransportError(
            "invalid " + this.role + " response: " + asError(error).message,
            this.role,
          ));
        }
      }
    }
  }

  private fail(error: EngineTransportError): void {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.handshakeReject?.(error);
    this.handshakeReject = undefined;
    this.handshakeResolve = undefined;
    if (this.child !== undefined && !this.childExited) void this.child.terminate().catch(() => {});
    this.onFailure(this.role, error, this.intentionalExit);
  }

  private recordStderr(chunk: Buffer): void {
    this.stderr = Buffer.concat([this.stderr, chunk]);
    if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.subarray(-64 * 1024);
  }

  private stderrText(): string {
    const text = this.stderr.toString("utf8").trim();
    return text.length === 0 ? "" : "; stderr: " + text;
  }
}
export class Engine extends EventEmitter implements EngineAdapter {
  private readonly trace: PerformanceTrace;
  private state: EngineState = "new";
  private lifecycleTail: Promise<void> = Promise.resolve();
  private startPromise: Promise<EngineHandshake> | undefined;
  private restartPromise: Promise<EngineHandshake> | undefined;
  private closePromise: Promise<void> | undefined;
  private startupAbort: AbortController | undefined;
  private handshake: EngineHandshake | undefined;
  private paths: ResolvedPaths | undefined;
  private readonly retiredPathDirectories = new Set<string>();
  private kernel: ArkKernel | undefined;
  private analyzer: RPeer | undefined;
  private analyzerInfo: RawHandshake | undefined;
  private kernelInfo: ArkKernelInfo | undefined;
  private requestCounter = 1;
  private readonly rPending = new Map<number, PendingRRequest>();
  private readonly evaluations = new Map<number, ActiveEvaluation>();
  private readonly batches = new Set<ActiveBatch>();
  private pendingKernelRequests = 0;
  private executingRequest: number | undefined;
  private interruptRequested: number | undefined;
  private readonly interruptDeliveries = new Map<number, Promise<void>>();
  private arkEventToken = "";
  private runtime: RuntimePaths | undefined;
  private outputStoreValue: OutputStore | undefined;
  private outputSessionEpoch: string | undefined;
  private outputDocumentRevision: number | undefined;
  private kernelEpoch: string | null = null;
  private peerGeneration = 0;
  private analyzerGeneration = 0;
  private kernelGeneration = 0;
  private environmentValue: REnvironment | undefined;
  get environment(): REnvironment | undefined { return this.environmentValue; }
  private analysisEnvironmentId: string | undefined;
  private analysisGeneration = 0;
  private pathOptions: Pick<EngineOptions, "notebookDirectory" | "cacheDirectory">;
  private restartContext: EngineRestartOptions | undefined;

  constructor(private readonly options: EngineOptions) {
    super();
    validatePositiveTimeout(options.startupTimeoutMs, "startupTimeoutMs");
    validatePositiveTimeout(options.shutdownTimeoutMs, "shutdownTimeoutMs");
    if (options.maxFrameBytes !== undefined && (
      !Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1 ||
      options.maxFrameBytes > DEFAULT_MAX_ENGINE_FRAME_BYTES
    )) {
      throw new RangeError(
        "maxFrameBytes must be an integer in 1.." + DEFAULT_MAX_ENGINE_FRAME_BYTES,
      );
    }
    this.environmentValue = options.environment === undefined ? undefined : freezeEnvironment(options.environment);
    this.pathOptions = {
      notebookDirectory: options.notebookDirectory,
      cacheDirectory: options.cacheDirectory,
    };

    this.trace = new PerformanceTrace();
  }
  get identity(): EngineHandshake | null { return this.handshake ?? null; }
  get outputStore(): OutputStore | undefined { return this.outputStoreValue; }
  connectArkLsp(): Promise<import("node:net").Socket> {
    if (this.kernel === undefined || !this.kernel.ready) throw new EngineTransportError("Ark kernel is unavailable");
    return this.kernel.connectLsp();
  }

  /** Prepare the host-owned artifact store before server publication. */
  prepareOutputStore(identity: Pick<OutputScope, "sessionEpoch" | "documentRevision">): OutputStore {
    if (this.isClosed()) throw new EngineTransportError("engine is closed");
    const artifactDirectory = this.options.artifactDirectory;
    if (typeof artifactDirectory !== "string" || artifactDirectory.length === 0) throw new EngineTransportError("output artifact directory is unavailable");
    const existing = this.outputStoreValue;
    if (existing === undefined) {
      const created = new OutputStore({
        artifactDirectory,
        sessionEpoch: identity.sessionEpoch,
        documentRevision: identity.documentRevision,
        kernelEpoch: this.kernelEpoch,
      });
      this.outputStoreValue = created;
      this.outputSessionEpoch = identity.sessionEpoch;
      this.outputDocumentRevision = identity.documentRevision;
      return created;
    }
    if (this.outputSessionEpoch !== identity.sessionEpoch) {
      throw new EngineTransportError("output store session epoch cannot change");
    }
    existing.setIdentity({ documentRevision: identity.documentRevision, kernelEpoch: this.kernelEpoch });
    this.outputDocumentRevision = identity.documentRevision;
    return existing;
  }
  setEnvironment(environment: REnvironment): void {
    const validated = rEnvironmentSchema.parse(environment);
    const fullyStopped = (this.state === "new" || this.state === "degraded") &&
      this.analyzer === undefined && this.kernel === undefined &&
      this.runtime === undefined && this.rPending.size === 0 &&
      this.evaluations.size === 0 && this.pendingKernelRequests === 0;
    if (!fullyStopped) {
      throw new EngineTransportError("R environment can only change while Engine is fully stopped");
    }
    const previousPaths = this.paths;
    this.paths = undefined;
    this.retirePaths(previousPaths);
    this.environmentValue = freezeEnvironment(validated);
    this.analysisEnvironmentId = undefined;
    this.analysisGeneration += 1;
  }
  private retirePaths(paths: ResolvedPaths | undefined): void {
    if (paths === undefined) return;
    for (const directory of paths.ownedDirectories) {
      if (directory !== paths.artifactDirectory) this.retiredPathDirectories.add(directory);
    }
  }
  private async drainRetiredPaths(): Promise<void> {
    const directories = [...this.retiredPathDirectories];
    this.retiredPathDirectories.clear();
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {})));
  }


  onFailure(
    listener: (role: FailureRole, error: Error) => void,
  ): () => void {
    this.on("failure", listener);
    return () => this.off("failure", listener);
  }

  start(): Promise<EngineHandshake> {
    if (this.state === "closed") {
      return Promise.reject(new EngineTransportError("engine is closed"));
    }
    if (this.restartPromise !== undefined) return this.restartPromise;
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.state === "ready" && this.handshake !== undefined &&
        this.kernel?.ready && this.analyzer?.ready) {
      return Promise.resolve(this.handshake);
    }
    const operation = this.enqueueLifecycle(() => this.startLocked());
    this.startPromise = operation;
    void operation.finally(() => {
      if (this.startPromise === operation) this.startPromise = undefined;
    }).catch(() => {});
    return operation;
  }
  startAnalyzer(): Promise<AnalyzerIdentity> {
    if (this.state === "closed") return Promise.reject(new EngineTransportError("engine is closed"));
    return this.enqueueLifecycle(async () => {
      if (this.analyzer?.ready) return this.analyzerIdentity();
      if (this.state === "restarting") throw new EngineTransportError("engine start was superseded by restart");
      this.state = "starting";
      try {
        await this.startAnalyzerLocked();
        if (this.kernel?.ready) this.state = "ready";
        return this.analyzerIdentity();
      } catch (error) {
        if (!this.isClosed() && (this.state as EngineState) !== "restarting") this.state = "degraded";
        throw error;
      }
    });
  }

  startKernel(): Promise<KernelIdentity> {
    if (this.state === "closed") return Promise.reject(new EngineTransportError("engine is closed"));
    return this.enqueueLifecycle(async () => {
      if (this.kernel?.ready) return this.kernelIdentity();
      if (this.state === "restarting") throw new EngineTransportError("engine start was superseded by restart");
      this.state = "starting";
      try {
        await this.startKernelLocked();
        if (this.analyzer?.ready) this.state = "ready";
        return this.kernelIdentity();
      } catch (error) {
        if (!this.isClosed() && (this.state as EngineState) !== "restarting") this.state = "degraded";
        throw error;
      }
    });
  }

  async analyze(
    cells: readonly CellSnapshot[],
    revision: number,
    analysisEnvironmentId?: string,
  ): Promise<AnalysisResult> {
    await this.ensureAnalyzer();
    const selectedAnalysisEnvironmentId = analysisEnvironmentId ?? this.analysisEnvironmentId;
    if (selectedAnalysisEnvironmentId === undefined) throw new EngineTransportError("analysis environment is unavailable", "analyzer");
    if (selectedAnalysisEnvironmentId !== this.analysisEnvironmentId) {
      throw new EngineTransportError("analysis targets a stale analyzer generation", "analyzer");
    }
    const analysisGeneration = this.analysisGeneration;
    const analyzerGeneration = this.analyzerGeneration;

    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError("analysis revision must be a non-negative safe integer");
    }
    if (cells.length > MAX_NOTEBOOK_CELLS) {
      throw new TypeError("analysis cells exceed the 10000 cell limit");
    }
    const snapshots = cells.map((cell) => cellSnapshotSchema.parse(cell));
    let sourceBytes = 0;
    const wireCells = snapshots.map((cell) => {
      const source = encodeSource(cell.source, "analysis source");
      sourceBytes += source.bytes;
      if (sourceBytes > MAX_NOTEBOOK_SOURCE_BYTES) {
        throw new TypeError("analysis source exceeds the 32 MiB notebook limit");
      }
      return {
        id: cell.id,
        revision: cell.revision,
        type: cell.type,
        source_base64: source.base64,
      };
    });
    const raw = await this.sendRRequest("analyzer", "analyze", {
      revision,
      analysisEnvironmentId: selectedAnalysisEnvironmentId,
      cells: wireCells,
    });
    if (raw.ok !== true) throw requestError(raw, "analysis failed");
    if (analysisGeneration !== this.analysisGeneration ||
        analyzerGeneration !== this.analyzerGeneration ||
        selectedAnalysisEnvironmentId !== this.analysisEnvironmentId) {
      throw new EngineTransportError("analysis result belongs to a stale analyzer generation", "analyzer");
    }
    return analysisResultSchema.parse(mapAnalysisResult(raw, new Map(
      snapshots.map((cell) => [cell.id, cell.source]),
    )));
  }

  async evaluate(
    payload: EvaluationPayload,
    onEvent?: (event: EngineEvent) => void,
    signal?: AbortSignal,
    duringStartup = false,
  ): Promise<EngineResponse> {
    const value = evaluationPayloadSchema.parse(payload);
    await this.ensureKernel(duringStartup);
    if (this.kernelEpoch === null || value.kernelEpoch !== this.kernelEpoch) {
      throw new EngineTransportError("evaluation targets a stale kernel epoch", "kernel");
    }
    const kernelGeneration = this.kernelGeneration;
    if (this.evaluations.size + this.pendingKernelRequests >= MAX_PENDING_REQUESTS) {
      throw new EngineTransportError("engine request queue is full", "kernel");
    }
    const requestId = this.nextRequestId();
    const wire = evaluationWire(value, this.runtime!.controlDirectory);
    const state = makeEvaluation(requestId, value, onEvent, kernelGeneration,
      this.arkEventToken, this.maxArkPayloadBytes());
    this.evaluations.set(requestId, state);
    const traceSpan = this.trace.begin("host.engine.request", requestTraceFields(
      "kernel", "eval_cell", { req: requestId, ...wire },
    ));
    try {
      const request = encodeArkRequest({ request: String(requestId), ...wire }, this.maxArkPayloadBytes());
      const execution = await this.kernel!.execute(arkCall("evaluate", request), {
        onMessage: (message) => {
          state.messageTail = state.messageTail.then(
            () => this.processEvaluationMessage(state, message),
          ).catch((error) => {
            state.messageError ??= asError(error);
          });
        },
        onSettled: async () => {
          await state.messageTail;
          state.kernelTerminal = true;
          await this.interruptDeliveries.get(requestId);
          if (this.executingRequest === requestId) this.executingRequest = undefined;
          if (this.interruptRequested === requestId) this.interruptRequested = undefined;
        },
      }, { storeHistory: true, signal });
      await state.messageTail;
      if (state.messageError !== undefined) throw state.messageError;
      state.eventStream.finish();
      if (state.deferredArtifactReleases.size > 0) {
        const artifacts = [...state.deferredArtifactReleases];
        await this.releaseDeferredArtifacts(artifacts);
        state.deferredArtifactReleases.clear();
      }
      this.finishLog(state);
      const response = this.finishEvaluationResponse(state, execution);
      if (!response.ok && state.outputs.length > 0) {
        await this.discardEvaluationOutputs(state.outputs);
      }
      this.emitEvaluationEvent(state, {
        type: "completed",
        sequence: state.sequence + 1,
        result: response,
      });
      this.trace.end(traceSpan, terminalTraceFields(response as Record<string, unknown>));
      return response;
    } catch (error) {
      if (signal?.aborted && error === signal.reason && !state.started) {
        const response: EngineResponse = {
          ok: false,
          cancelledBeforeStart: true,
          error: { code: "interrupted", message: "Cancelled before execution", interrupted: true },
        };
        this.trace.end(traceSpan, { outcome: "cancelled-before-start" });
        return response;
      }
      await state.messageTail;
      if (state.deferredArtifactReleases.size > 0) {
        const artifacts = [...state.deferredArtifactReleases];
        try {
          await this.releaseDeferredArtifacts(artifacts);
          state.deferredArtifactReleases.clear();
        } catch (cleanupError) {
          this.emit("failure", "kernel", new EngineTransportError(
            `deferred artifact release failed: ${asError(cleanupError).message}`, "kernel",
          ));
        }
      }
      if (state.outputs.length > 0) await this.discardEvaluationOutputs(state.outputs);
      this.trace.end(traceSpan, { outcome: "failure", error: asError(error).name });
      throw error;
    } finally {
      this.evaluations.delete(requestId);
      if (this.executingRequest === requestId) this.executingRequest = undefined;
      if (this.interruptRequested === requestId) this.interruptRequested = undefined;
      this.interruptDeliveries.delete(requestId);
    }
  }

  async evaluateBatch(
    payloads: readonly EvaluationPayload[],
    onEvent?: (event: EngineEvent) => void | Promise<void>,
    signal?: AbortSignal,
    duringStartup = false,
  ): Promise<Array<EngineResponse | undefined>> {
    if (payloads.length < 2 || payloads.length > 4) throw new RangeError("a batch needs 2..4 cells");
    const values = payloads.map((value) => evaluationPayloadSchema.parse(value));
    if (new Set(values.map((value) => value.cellId)).size !== values.length ||
        values.some((value) => value.runId !== values[0]!.runId ||
          value.operationId !== values[0]!.operationId || value.sessionEpoch !== values[0]!.sessionEpoch)) {
      throw new TypeError("batch cells must belong to one run");
    }
    const batch: ActiveBatch = {
      payloads: values, states: [], invalidated: new Set(), cancelled: false, interrupted: false,
    };
    // Register before readiness yields so an edit can revoke a not-yet-sent batch.
    this.batches.add(batch);
    const responses: Array<EngineResponse | undefined> = values.map(() => undefined);
    let requestId: number | undefined;
    let traceSpan: PerformanceSpan | undefined;
    let tail = Promise.resolve();
    let callbacks = Promise.resolve();
    let messageError: Error | undefined;
    let index = -1;
    let ended = false;
    try {
      if (signal?.aborted) throw signal.reason;
      await this.ensureKernel(duringStartup);
      if (batch.cancelled) return responses;
      const kernelGeneration = this.kernelGeneration;
      if (this.kernelEpoch === null || values.some((value) => value.kernelEpoch !== this.kernelEpoch)) {
        throw new EngineTransportError("evaluation targets a stale kernel epoch", "kernel");
      }
      if (this.evaluations.size + this.pendingKernelRequests >= MAX_PENDING_REQUESTS) {
        throw new EngineTransportError("engine request queue is full", "kernel");
      }
      requestId = this.nextRequestId();
      traceSpan = this.trace.begin("host.engine.request", {
        role: "kernel", cmd: "eval_batch", req: requestId, cells: values.length,
        session_epoch: values[0]!.sessionEpoch,
        operation_id: values[0]!.operationId, run_id: values[0]!.runId,
      });
      batch.permit = join(this.runtime!.controlDirectory, ".alder-batch-" + randomUUID());
      writeFileSync(batch.permit, "", { flag: "wx", mode: 0o600 });
      batch.states = values.map((value) => ({ ...makeEvaluation(requestId!, value, (event) => {
        callbacks = callbacks.then(() => onEvent?.(event));
      }, kernelGeneration, this.arkEventToken, this.maxArkPayloadBytes()), batch }));
      const eventStream = new ArkEventStreamDecoder(this.arkEventToken, this.maxArkPayloadBytes());
      this.evaluations.set(requestId, batch.states[0]!);
      const code = values.map((value, offset) => arkCall("evaluate", encodeArkRequest({
        request: String(requestId), ...evaluationWire(value, this.runtime!.controlDirectory),
        batch: { index: offset + 1, count: values.length, permit: batch.permit },
      }, this.maxArkPayloadBytes()))).join("\n");
      const complete = async (state: ActiveEvaluation, execution: ArkExecution): Promise<void> => {
        this.finishLog(state);
        const response = this.finishEvaluationResponse(state, execution);
        if (!response.ok && state.outputs.length > 0) await this.discardEvaluationOutputs(state.outputs);
        responses[batch.states.indexOf(state)] = response;
        this.emitEvaluationEvent(state, { type: "completed", sequence: state.sequence + 1, result: response });
        await callbacks;
      };
      const execution = await this.kernel!.execute(code, {
        onMessage: (message) => {
          tail = tail.then(async () => {
            const parts = message.header.msg_type === "stream"
              ? eventStream.push(streamText(message)).map((part) => part.event === undefined
                ? { text: part.text } : { event: part.event })
              : [{ message }];
            for (const part of parts) {
            const event = "event" in part ? part.event : undefined;
            if (event?.type === "batch_end") { ended = true; return; }
            if (event?.type === "started") {
              if (ended || (index >= 0 && !batch.states[index]!.finished) || ++index >= values.length) {
                throw new FrameProtocolError("invalid batch cell boundary");
              }
              batch.current = batch.states[index]!;
              this.evaluations.set(requestId!, batch.current);
            }
            const state = batch.current;
            if (state === undefined) {
              const beforeFirstCell = message.header.msg_type === "execute_input" ||
                (message.header.msg_type === "status" && message.content.execution_state === "busy");
              if (beforeFirstCell || ended) return;
              throw new FrameProtocolError(`batch output (${message.header.msg_type}) arrived before its first cell`);
            }
            if (ended && state.finished) return;
            if (event === undefined && "text" in part) {
              await this.applyPendingClear(state);
              this.appendLog(state, part.text!);
            } else if (event === undefined) await this.processEvaluationMessage(state, message);
            else await this.applyArkEvent(state, event);
            await callbacks;
            if (state.messageError !== undefined) throw state.messageError;
            // Nonfinal markers originate in the next native expression. The
            // final cell still waits for execute_reply + IOPub idle below.
            if (event?.type === "finished" && index < values.length - 1) {
              await complete(state, successfulExecution(message));
            }
            }
          }).catch((error) => {
            messageError ??= asError(error);
            this.revokeBatch(batch);
          });
        },
        onSettled: async () => {
          await tail;
          for (const state of batch.states) state.kernelTerminal = true;
          await this.interruptDeliveries.get(requestId!);
          if (this.executingRequest === requestId) this.executingRequest = undefined;
          if (this.interruptRequested === requestId) this.interruptRequested = undefined;
        },
      }, { storeHistory: true, signal });
      await tail;
      if (messageError !== undefined) throw messageError;
      eventStream.finish();
      for (const [offset, state] of batch.states.entries()) {
        if (!state.started || responses[offset] !== undefined) continue;
        if (ended && batch.interrupted && !state.finished) {
          state.structuredError ??= { code: "interrupted", message: "Interrupted", interrupted: true };
        }
        await complete(state, ended && state.finished ? successfulExecution(execution.reply) : execution);
      }
      this.trace.end(traceSpan, { outcome: "terminal", evaluated: responses.filter(Boolean).length });
      return responses;
    } catch (error) {
      this.trace.end(traceSpan, { outcome: "failure", error: asError(error).name });
      await tail;
      for (const [offset, state] of batch.states.entries()) {
        if (responses[offset] === undefined && state.outputs.length > 0) {
          await this.discardEvaluationOutputs(state.outputs);
        }
      }
      throw error;
    } finally {
      this.revokeBatch(batch);
      this.batches.delete(batch);
      if (requestId !== undefined) {
        this.evaluations.delete(requestId);
        this.interruptDeliveries.delete(requestId);
        if (this.executingRequest === requestId) this.executingRequest = undefined;
        if (this.interruptRequested === requestId) this.interruptRequested = undefined;
      }
      for (const state of batch.states) {
        if (state.deferredArtifactReleases.size > 0) {
          const artifacts = [...state.deferredArtifactReleases];
          try {
            await this.releaseDeferredArtifacts(artifacts);
            state.deferredArtifactReleases.clear();
          } catch (cleanupError) {
            this.emit("failure", "kernel", new EngineTransportError(
              `deferred artifact release failed: ${asError(cleanupError).message}`, "kernel",
            ));
          }
        }
      }
    }
  }

  invalidateBatch(cellIds?: ReadonlySet<string>): void {
    for (const batch of this.batches) {
      if (cellIds !== undefined && !batch.payloads.some((value) => cellIds.has(value.cellId))) continue;
      for (const value of batch.payloads) {
        if (cellIds === undefined || cellIds.has(value.cellId)) batch.invalidated.add(value.cellId);
      }
      this.revokeBatch(batch);
      const current = batch.current;
      if (current !== undefined && batch.invalidated.has(current.payload.cellId)) {
        void this.interrupt(current.requestId).catch((error) => { current.messageError ??= asError(error); });
      }
    }
  }

  private revokeBatch(batch: ActiveBatch): void {
    batch.cancelled = true;
    if (batch.permit !== undefined) rmSync(batch.permit, { force: true });
  }

  async request(
    command: string,
    payload: Record<string, unknown> = {},
    options?: EngineRequestOptions,
    duringStartup = false,
  ): Promise<EngineResponse> {
    await this.ensureKernel(duringStartup);
    if (!KERNEL_COMMANDS.has(command)) {
      throw new TypeError(`unsupported kernel command: ${command}`);
    }
    if (command === "release_outputs") return this.releaseOutputs(payload);
    if (command === "clear_cell") {
      const requestPayload = clearCellRequestSchema.parse(payload);
      return engineResponseSchema.parse(await this.runArkCommand(command, requestPayload));
    }
    const outputScope = command === "get_value" || command === "lazy_eval"
      ? requestOutputScope(options?.outputScope)
      : undefined;
    const response = await this.runArkCommand(command, payload, true, options?.signal);
    return engineResponseSchema.parse(await this.normalizeRequestResult(command, outputScope, response));
  }



  async interrupt(
    requestId?: number,
  ): Promise<{ requested: boolean; requestId?: number }> {
    await this.ensureKernel();
    const target = requestId ?? this.executingRequest ?? this.evaluations.keys().next().value;
    if (target === undefined) return { requested: false };
    if (!Number.isSafeInteger(target) || target < 1) return { requested: false };
    const pending = this.evaluations.get(target);
    if (pending === undefined) {
      return { requested: false };
    }
    if (pending.kernelTerminal || (pending.finished &&
        (pending.batch === undefined || pending === pending.batch.states.at(-1)))) return { requested: false };
    if (pending.batch !== undefined) this.revokeBatch(pending.batch);
    if (this.executingRequest === undefined) {
      if (this.interruptRequested === undefined) this.interruptRequested = target;
      return { requested: this.interruptRequested === target, requestId: target };
    }
    if (this.executingRequest !== target) return { requested: false };
    await this.deliverInterrupt(target);
    return { requested: true, requestId: target };
  }

  async restart(options?: EngineRestartOptions): Promise<EngineHandshake> {
    if (this.isClosed()) throw new EngineTransportError("engine is closed");
    const requestedContext: EngineRestartOptions = {
      environment: options?.environment === undefined
        ? this.environmentValue
        : freezeEnvironment(options.environment),
      notebookDirectory: options?.notebookDirectory === undefined
        ? this.pathOptions.notebookDirectory
        : options.notebookDirectory,
      cacheDirectory: options?.cacheDirectory === undefined
        ? this.pathOptions.cacheDirectory
        : options.cacheDirectory,
    };
    if (this.restartPromise !== undefined) {
      if (this.restartContext === undefined || !sameRestartContext(this.restartContext, requestedContext)) {
        throw new EngineTransportError("an Engine restart is already in progress");
      }
      return this.restartPromise;
    }
    const contextChanged = !sameRestartContext({
      environment: this.environmentValue,
      notebookDirectory: this.pathOptions.notebookDirectory,
      cacheDirectory: this.pathOptions.cacheDirectory,
    }, requestedContext);
    this.state = "restarting";
    this.startupAbort?.abort();
    const immediateStop = this.stopPeers("Engine restarted");
    void immediateStop.catch(() => {});
    const operation = this.enqueueLifecycle(async () => {
      if (this.isClosed()) throw new EngineTransportError("engine is closed");
      try {
        await immediateStop;
        if (contextChanged) {
          const previousPaths = this.paths;
          this.paths = undefined;
          for (const directory of previousPaths?.ownedDirectories ?? []) {
            if (directory === previousPaths?.artifactDirectory) continue;
            await rm(directory, { recursive: true, force: true }).catch(() => {});
          }
        }
        await this.stopPeers("Engine restarted");
        await this.outputStoreValue?.clear();
        if (this.isClosed()) throw new EngineTransportError("engine is closed");
        this.environmentValue = requestedContext.environment;
        this.pathOptions = {
          notebookDirectory: requestedContext.notebookDirectory,
          cacheDirectory: requestedContext.cacheDirectory,
        };
        this.analysisEnvironmentId = undefined;
        this.analysisGeneration += 1;
        this.state = "new";
        this.handshake = undefined;
        return await this.startLocked();
      } catch (error) {
        if (!this.isClosed()) this.state = "degraded";
        throw error;
      }
    });
    this.restartPromise = operation;
    this.restartContext = requestedContext;
    void operation.finally(() => {
      if (this.restartPromise === operation) {
        this.restartPromise = undefined;
        if (this.restartContext === requestedContext) this.restartContext = undefined;
      }
    }).catch(() => {});
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.isClosed()) return Promise.resolve();
    this.state = "closed";
    this.startupAbort?.abort();
    const immediateStop = this.stopPeers("Engine closed");
    void immediateStop.catch(() => {});
    const operation = this.enqueueLifecycle(async () => {
      let stopError: Error | undefined;
      try { await immediateStop; } catch (error) { stopError = asError(error); }
      try { await this.stopPeers("Engine closed"); }
      catch (error) { stopError ??= asError(error); }
      try {
        await this.outputStoreValue?.close();
      } catch (error) {
        stopError ??= asError(error);
      } finally {
        this.outputStoreValue = undefined;
        this.outputSessionEpoch = undefined;
        this.outputDocumentRevision = undefined;
      }
      for (const directory of this.paths?.ownedDirectories ?? []) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      await this.drainRetiredPaths();
      this.handshake = undefined;
      if (stopError !== undefined) throw stopError;
    });
    this.closePromise = operation;
    return operation;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(() => {}, () => {});
    return result;
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  private async startLocked(): Promise<EngineHandshake> {
    if (this.isClosed()) throw new EngineTransportError("engine is closed");
    if (this.state === "restarting") throw new EngineTransportError("engine start was superseded by restart");
    if (this.state === "ready" && this.handshake !== undefined && this.kernel?.ready && this.analyzer?.ready) {
      return this.handshake;
    }
    if (this.state === "degraded") await this.stopPeers("Engine recovering");
    if (this.isClosed()) throw new EngineTransportError("engine is closed");
    this.state = "starting";
    return this.startFresh();
  }

  private requireEnvironment(role: FailureRole = "analyzer"): REnvironment {
    if (this.environmentValue === undefined) {
      throw new EngineTransportError("an R environment must be selected before starting the " + role, role);
    }
    return this.environmentValue;
  }

  private async startAnalyzerLocked(): Promise<void> {
    const environment = this.requireEnvironment("analyzer");
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    let peer: RPeer | undefined;
    try {
      await this.drainRetiredPaths();
      this.paths ??= await resolvePaths(this.options, environment, startupAbort.signal, this.pathOptions);
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 45_000;
      const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_ENGINE_FRAME_BYTES;
      const generation = ++this.peerGeneration;
      peer = this.makeRPeer("analyzer", startupTimeoutMs, maxFrameBytes, generation);
      this.analyzer = peer;
      this.analyzerGeneration = generation;
      this.analyzerInfo = undefined;
      this.analysisEnvironmentId = undefined;
      this.analyzerInfo = await peer.start();
      this.analysisEnvironmentId = makeAnalysisEnvironmentId(environment, ++this.analysisGeneration);
    } catch (error) {
      if (peer !== undefined) await peer.terminate(this.options.shutdownTimeoutMs ?? 1_000).catch(() => {});
      if (this.analyzer === peer) this.analyzer = undefined;
      this.analyzerInfo = undefined;
      this.analysisEnvironmentId = undefined;
      await this.drainRetiredPaths();
      throw error;
    } finally {
      if (this.startupAbort === startupAbort) this.startupAbort = undefined;
    }
  }

  private async startKernelLocked(): Promise<void> {
    const environment = this.requireEnvironment("kernel");
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    let kernel: ArkKernel | undefined;
    try {
      await this.drainRetiredPaths();
      this.paths ??= await resolvePaths(this.options, environment, startupAbort.signal, this.pathOptions);
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 45_000;
      const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_ENGINE_FRAME_BYTES;
      this.arkEventToken = randomBytes(24).toString("base64url");
      const paths = this.paths;
      this.runtime ??= await prepareRuntime(paths);
      const generation = ++this.peerGeneration;
      this.kernelGeneration = generation;
      this.kernelEpoch = randomUUID();
      kernel = new ArkKernel({
        executable: paths.arkExecutable,
        startupFile: paths.arkStartupScript,
        connectionDirectory: this.runtime.controlDirectory,
        cwd: paths.notebookDirectory,
        environment: {
          ...paths.arkEnvironment,
          ...rKernelEnvironmentVariables(
            environment,
            this.options.resources,
            paths.notebookDirectory,
          ),
          ALDER_ARK_KERNEL: "1",
          ALDER_ARK_EVENT_TOKEN: this.arkEventToken,
          ALDER_CAPTURE_DIR: this.runtime.captureDirectory,
          ALDER_CONTROL_DIR: this.runtime.controlDirectory,
          ALDER_KERNEL_EPOCH: this.kernelEpoch,
        },
        startupTimeoutMs,
        shutdownTimeoutMs: this.options.shutdownTimeoutMs ?? 1_000,
        maxMessageBytes: Math.ceil(maxFrameBytes * 4 / 3) + 65_536,
        processScope: this.options.processScope,
      });
      this.kernel = kernel;
      this.kernelInfo = undefined;
      kernel.on("failed", (error: Error) => this.kernelFailed(generation, error));
      const info = await kernel.start();
      this.kernelInfo = info;
    } catch (error) {
      if (kernel !== undefined) await kernel.terminate().catch(() => {});
      if (this.kernel === kernel) this.kernel = undefined;
      this.kernelInfo = undefined;
      this.kernelEpoch = null;
      this.kernelGeneration = 0;
      const runtime = this.runtime;
      this.runtime = undefined;
      for (const directory of runtime?.ownedDirectories ?? []) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      await this.drainRetiredPaths();
      throw error;
    } finally {
      if (this.startupAbort === startupAbort) this.startupAbort = undefined;
    }
  }

  private async startFresh(): Promise<EngineHandshake> {
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    try {
      if (!this.analyzer?.ready) await this.startAnalyzerLocked();
      if (!this.kernel?.ready) await this.startKernelLocked();
      if (startupAbort.signal.aborted || this.isClosed()) {
        throw new EngineTransportError("engine startup was cancelled");
      }
      const analyzer = this.analyzerInfo;
      const kernel = this.kernelInfo;
      if (analyzer === undefined || kernel === undefined || this.kernelEpoch === null) {
        throw new EngineTransportError("Engine startup omitted a peer identity");
      }
      const ping = await this.runArkCommand("ping", {}, false);
      if (ping.ok !== true || ping.package_version !== analyzer.packageVersion ||
          ping.r_version !== analyzer.rVersion || !kernel.languageVersion.includes(analyzer.rVersion)) {
        throw new EngineTransportError("kernel and analyzer identities do not match");
      }
      const capabilities = [...new Set([
        "ark",
        "evaluation",
        "jupyter-iopub",
        "jupyter-control-interrupt",
        "native-graphics",
        "native-htmlwidgets",
        "variables",
        ...KERNEL_COMMANDS,
        ...analyzer.capabilities,
      ])].sort();
      this.handshake = engineHandshakeSchema.parse({
        protocol: ENGINE_PROTOCOL,
        packageVersion: analyzer.packageVersion,
        rVersion: analyzer.rVersion,
        capabilities,
        kernelReady: true,
        analyzerReady: true,
        captureReady: true,
        kernel: {
          name: "ark",
          version: kernel.implementationVersion,
          protocol: kernel.protocolVersion,
          kernelEpoch: this.kernelEpoch,
        },
      });
      this.state = "ready";
      return this.handshake;
    } catch (error) {
      if (this.state !== "closed" && this.state !== "restarting") this.state = "degraded";
      if (!startupAbort.signal.aborted) await this.stopPeers("Engine startup failed");
      throw error;
    } finally {
      if (this.startupAbort === startupAbort) this.startupAbort = undefined;
    }
  }
  private analyzerIdentity(): AnalyzerIdentity {
    const info = this.analyzerInfo;
    if (info === undefined || this.analysisEnvironmentId === undefined) {
      throw new EngineTransportError("analyzer identity is unavailable", "analyzer");
    }
    return {
      packageVersion: info.packageVersion,
      rVersion: info.rVersion,
      policy: info.capabilities.includes("analysis-policy:v1") ? "strict" : "default",
      analysisEnvironmentId: this.analysisEnvironmentId,
    };
  }

  private kernelIdentity(): KernelIdentity {
    const info = this.kernelInfo;
    if (info === undefined || this.kernelEpoch === null) {
      throw new EngineTransportError("kernel identity is unavailable", "kernel");
    }
    return { name: "ark", version: info.implementationVersion, protocol: info.protocolVersion, kernelEpoch: this.kernelEpoch };
  }
  private makeRPeer(
    role: RPeerRole,
    startupTimeoutMs: number,
    maxFrameBytes: number,
    generation: number,
  ): RPeer {
    const paths = this.paths!;
    const environment = this.requireEnvironment("analyzer");
    const peerEnvironment = { ...paths.analyzerEnvironment, ...rServiceEnvironmentVariables(environment, this.options.resources, this.analysisEnvironmentId), ALDER_HOST_ROLE: role };
    if (process.platform === "darwin") delete (peerEnvironment as Record<string, string>).R_HOME;
    return new RPeer(
      role,
      environment.rscript,
      paths.analyzerScript,
      paths.notebookDirectory,
      peerEnvironment,
      this.options.processScope,
      maxFrameBytes,
      startupTimeoutMs,
      (peerRole, frame) => this.handleRFrame(peerRole, frame, generation),
      (peerRole, error, intentional) => {
        if (generation === this.peerGeneration) this.peerFailed(peerRole, error, intentional);
      },
    );
  }

  private async ensureStarted(): Promise<void> {
    await this.ensureAnalyzer();
    await this.ensureKernel();
  }

  private async ensureAnalyzer(): Promise<void> {
    if (this.state === "closed") throw new EngineTransportError("engine is closed");
    if (this.restartPromise !== undefined) await this.restartPromise;
    if (this.analyzer?.ready !== true) await this.startAnalyzer();
    if (this.analyzer?.ready !== true) throw new EngineTransportError("analyzer is unavailable", "analyzer");
  }

  private async ensureKernel(duringStartup = false): Promise<void> {
    if (this.state === "closed") throw new EngineTransportError("engine is closed");
    if (!duringStartup && this.restartPromise !== undefined) await this.restartPromise;
    if (this.kernel?.ready !== true) await this.startKernel();
    if (this.kernel?.ready !== true) throw new EngineTransportError("kernel is unavailable", "kernel");
  }
  private sendRRequest(
    role: RPeerRole,
    command: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const peer = this.analyzer;
    if (peer?.ready !== true) {
      return Promise.reject(new EngineTransportError(`${role} is unavailable`, role));
    }
    const generation = this.analyzerGeneration;
    let queuedForRole = 0;
    for (const pending of this.rPending.values()) {
      if (pending.role === role) queuedForRole += 1;
    }
    if (queuedForRole >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new EngineTransportError("engine request queue is full", role));
    }
    for (const reserved of ["protocol", "req", "cmd"]) {
      if (Object.hasOwn(payload, reserved)) {
        return Promise.reject(new TypeError(`request payload cannot set ${reserved}`));
      }
    }
    const requestId = this.nextRequestId();
    const wire: Record<string, unknown> = {
      protocol: ENGINE_PROTOCOL,
      req: requestId,
      cmd: command,
      ...structuredClone(payload),
    };
    let traceSpan;
    try {
      traceSpan = this.trace.begin(
        "host.engine.request",
        requestTraceFields(role, command, wire),
      );
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
      const settle = (result: TraceFields): Error | undefined => {
        try {
          this.trace.end(traceSpan, result);
          return undefined;
        } catch (error) {
          return asError(error);
        }
      };
      const pending: PendingRRequest = {
        id: requestId,
        role,
        command,
        wire,
        generation,
        resolve: (value) => {
          const traceError = settle(terminalTraceFields(value));
          if (traceError === undefined) resolveRequest(value);
          else rejectRequest(traceError);
        },
        reject: (error) => {
          const traceError = settle({
            outcome: "failure",
            error: error.name,
          });
          rejectRequest(traceError ?? error);
        },
      };
      this.rPending.set(requestId, pending);
      void peer.send(wire).catch((error) => {
        if (this.rPending.delete(requestId)) pending.reject(asError(error));
      });
    });
  }

  private handleRFrame(role: RPeerRole, input: unknown, generation: number): void {
    const frame = asRecord(input, "engine response");
    const requestId = positiveSafeInteger(frame.req, "response req");
    const pending = this.rPending.get(requestId);
    if (pending === undefined) {
      throw new FrameProtocolError("response does not identify a pending request");
    }
    if (pending.generation !== generation) {
      throw new FrameProtocolError("response belongs to a stale analyzer generation");
    }
    if (pending.role !== role || frame.cmd !== pending.command) {
      throw new FrameProtocolError("response command identity does not match");
    }
    if (frame.ack !== undefined || frame.notify !== undefined) {
      throw new FrameProtocolError(`${role} emitted a streaming response`);
    }
    assertAnalyzerIdentity(pending.wire, frame);
    this.rPending.delete(pending.id);
    pending.resolve(frame);
  }

  private async deliverInterrupt(requestId: number): Promise<void> {
    const existing = this.interruptDeliveries.get(requestId);
    if (existing !== undefined) return existing;
    if (this.executingRequest !== requestId) return;
    const pending = this.evaluations.get(requestId);
    if (pending === undefined || pending.kernelTerminal || (pending.finished &&
        (pending.batch === undefined || pending === pending.batch.states.at(-1)))) return;
    pending.interruptSent = true;
    if (pending.batch !== undefined) pending.batch.interrupted = true;
    const delivery = (async () => {
      if (await this.kernel?.interrupt() !== true) {
        pending.interruptSent = false;
        throw new EngineTransportError("kernel interrupt could not be delivered", "kernel");
      }
    })();
    this.interruptDeliveries.set(requestId, delivery);
    return delivery;
  }

  private peerFailed(
    role: RPeerRole,
    error: EngineTransportError,
    intentional: boolean,
  ): void {
    this.rejectPending(role, error);
    if (this.state !== "closed") this.state = "degraded";
    if (!intentional && this.state !== "closed") this.emit("failure", role, error);
  }

  private rejectPending(role: PeerRole, error: Error): void {
    if (role === "analyzer") {
      for (const [requestId, pending] of this.rPending) {
        if (pending.role !== role) continue;
        this.rPending.delete(requestId);
        pending.reject(error);
      }
    }
    if (role === "kernel") {
      this.executingRequest = undefined;
      this.interruptRequested = undefined;
    }
  }

  private async stopPeers(reason: string): Promise<void> {
    const kernel = this.kernel;
    const analyzer = this.analyzer;
    const runtime = this.runtime;
    const oldKernelEpoch = this.kernelEpoch;
    this.peerGeneration += 1;
    analyzer?.expectExit();
    this.rejectPending("kernel", new EngineTransportError(reason, "kernel"));
    this.rejectPending("analyzer", new EngineTransportError(reason, "analyzer"));
    const timeout = this.options.shutdownTimeoutMs ?? 1_000;
    try {
      await Promise.all([kernel?.terminate(), analyzer?.terminate(timeout)]);
    } finally {
      for (const directory of runtime?.ownedDirectories ?? []) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (this.runtime === runtime) this.runtime = undefined;
      if (this.kernel === kernel) this.kernel = undefined;
      if (this.analyzer === analyzer) this.analyzer = undefined;
      this.analyzerInfo = undefined;
      this.kernelInfo = undefined;
      this.kernelEpoch = null;
      this.handshake = undefined;
      this.analyzerGeneration = 0;
      this.kernelGeneration = 0;
      if (oldKernelEpoch !== null) this.outputStoreValue?.invalidateRequests({ kernelEpoch: oldKernelEpoch });
      await this.drainRetiredPaths();
    }
  }

  private nextRequestId(): number {
    if (this.requestCounter > Number.MAX_SAFE_INTEGER) this.requestCounter = 1;
    while (this.rPending.has(this.requestCounter) ||
           this.evaluations.has(this.requestCounter)) this.requestCounter += 1;
    return this.requestCounter++;
  }

  private assertEvaluationCurrent(state: ActiveEvaluation): void {
    if (state.kernelGeneration !== this.kernelGeneration ||
        this.kernelEpoch === null || state.payload.kernelEpoch !== this.kernelEpoch) {
      throw new EngineTransportError("evaluation belongs to a stale kernel generation", "kernel");
    }
  }
  private startEvaluation(state: ActiveEvaluation): void {
    this.assertEvaluationCurrent(state);
    if (state.started || (this.executingRequest !== undefined &&
        (state.batch === undefined || this.executingRequest !== state.requestId))) {
      state.messageError ??= new FrameProtocolError("invalid Ark evaluation start state");
      return;
    }
    state.started = true;
    this.executingRequest = state.requestId;
    if (this.interruptRequested === state.requestId || state.batch?.invalidated.has(state.payload.cellId)) {
      this.interruptRequested = undefined;
      void this.deliverInterrupt(state.requestId).catch((error) => {
        state.messageError ??= asError(error);
      });
    }
    this.emitEvaluationEvent(state, { type: "started", sequence: 0 });
  }

  private async processEvaluationMessage(
    state: ActiveEvaluation,
    message: JupyterMessage,
  ): Promise<void> {
    this.assertEvaluationCurrent(state);
    const type = message.header.msg_type;
    if (type === "stream") {
      for (const part of state.eventStream.push(streamText(message))) {
        if (part.event !== undefined) await this.applyArkEvent(state, part.event);
        else if (part.text !== undefined && part.text.length > 0) {
          await this.applyPendingClear(state);
          this.appendLog(state, part.text);
        }
      }
      return;
    }
    if (type === "error") {
      await this.applyPendingClear(state);
      state.error = jupyterError(message.content);
      return;
    }
    if (type === "clear_output") {
      if (message.content.wait === true) state.clearPending = true;
      else await this.clearEvaluationOutputs(state);
      return;
    }
    if (type !== "execute_result" && type !== "display_data" && type !== "update_display_data") return;
    await this.applyPendingClear(state);
    const records = await this.ingestDisplay(state, message);
    for (const record of records) {
      if (this.addEvaluationOutput(state, record) === undefined) {
        this.outputStoreValue?.discardExact([record]);
        continue;
      }
      this.emitEvaluationEvent(state, {
        type: "output",
        sequence: ++state.sequence,
        kind: "append",
        payload: { output: record },
      });
    }
  }
  private async ingestDisplay(state: ActiveEvaluation, message: JupyterMessage): Promise<OutputRecord[]> {
    const paths = this.paths;
    if (paths === undefined || this.kernelEpoch === null) throw new EngineTransportError("output store is unavailable", "kernel");
    const store = this.prepareOutputStore({
      sessionEpoch: state.payload.sessionEpoch,
      documentRevision: state.payload.documentRevision,
    });
    const data = asRecord(message.content.data, "Ark display data");
    const metadata = optionalRecord(message.content.metadata) ?? {};
    return store.ingestDisplay(data as never, metadata as never, {
      runId: state.payload.runId,
      cellId: state.payload.cellId,
      revision: state.payload.revision,
      sessionEpoch: state.payload.sessionEpoch,
      documentRevision: state.payload.documentRevision,
      kernelEpoch: this.kernelEpoch,
    });
  }

  private async ingestAlderOutput(state: ActiveEvaluation, value: unknown): Promise<OutputRecord> {
    const paths = this.paths;
    if (paths === undefined || this.kernelEpoch === null) throw new EngineTransportError("output store is unavailable", "kernel");
    const store = this.prepareOutputStore({
      sessionEpoch: state.payload.sessionEpoch,
      documentRevision: state.payload.documentRevision,
    });
    return await Promise.resolve(store.ingestAlder(value as never, {
      sessionEpoch: state.payload.sessionEpoch,
      documentRevision: state.payload.documentRevision,
      kernelEpoch: this.kernelEpoch,
      runId: state.payload.runId,
      cellId: state.payload.cellId,
      revision: state.payload.revision,
    }, {} as never)) as OutputRecord;
  }

  private async applyArkEvent(state: ActiveEvaluation, input: Record<string, unknown>): Promise<void> {
    this.assertEvaluationCurrent(state);
    const type = input.type;
    const expectedRequest = String(state.requestId);
    if (type !== "command_result" && input.request !== expectedRequest) throw new FrameProtocolError("Alder Ark event request identity does not match");
    if (type !== "command_result" && (input.session_epoch !== state.payload.sessionEpoch || input.kernel_epoch !== this.kernelEpoch || input.run_id !== state.payload.runId || input.operation_id !== state.payload.operationId || input.cell_id !== state.payload.cellId || input.revision !== state.payload.revision)) {
      throw new FrameProtocolError("Alder Ark event execution identity does not match");
    }
    if (type !== "started" && type !== "batch_end" && type !== "command_result") {
      if (!state.started) throw new FrameProtocolError(`Alder Ark ${String(type)} event arrived before evaluation start`);
      const sequence = positiveSafeInteger(input.sequence, "Alder Ark output sequence");
      if (sequence <= state.rSequence) throw new FrameProtocolError("Alder Ark output sequence is not monotonic");
      state.rSequence = sequence;
    }
    if (type === "started") {
      if (input.sequence !== 0) throw new FrameProtocolError("invalid Alder evaluation start sequence");
      this.startEvaluation(state);
      return;
    }
    if (type === "batch_end") return;
    if (type === "append" || type === "progress" || type === "log") {
      await this.applyPendingClear(state);
      const payload = asRecord(input.payload, type + " output payload");
      validateOutputPayload(type, payload);
      if (type === "log") {
        const lines = payload.lines;
        if (!(typeof lines === "string" || (Array.isArray(lines) && lines.every((line) => typeof line === "string")))) throw new FrameProtocolError("invalid log output");
        this.appendLog(state, (Array.isArray(lines) ? lines.join("\n") : lines) + "\n");
        return;
      }
      if (type === "progress") {
        this.emitEvaluationEvent(state, { type: "output", sequence: ++state.sequence, kind: "progress", payload });
        return;
      }
      const record = await this.ingestAlderOutput(state, payload.output ?? payload);
      if (this.addEvaluationOutput(state, record) === undefined) {
        this.outputStoreValue?.discardExact([record]);
        return;
      }
      this.emitEvaluationEvent(state, { type: "output", sequence: ++state.sequence, kind: "append", payload: { output: record } });
      return;
    }
    if (type === "result") {
      await this.applyPendingClear(state);
      const payload = asRecord(input.payload, "result output payload");
      const record = await this.ingestAlderOutput(state, payload.output ?? payload);
      if (this.addEvaluationOutput(state, record) === undefined) {
        this.outputStoreValue?.discardExact([record]);
        return;
      }
      this.emitEvaluationEvent(state, { type: "output", sequence: ++state.sequence, kind: "append", payload: { output: record } });
      return;
    }
    if (type === "condition") {
      const payload = asRecord(input.payload, "condition payload");
      const error = engineErrorSchema.parse(canonicalizeEngineError(payload.error));
      const invalid = kernelStateInvalidMarker(error);
      if (invalid !== null) {
        state.kernelStateInvalid ??= invalid;
        if (state.structuredError === undefined) state.structuredError = error;
      } else {
        state.structuredError = error;
      }
      return;
    }
    if (type === "finished") {
      if (!state.started || state.finished) throw new FrameProtocolError("invalid Alder evaluation completion marker");
      state.finished = true;
      return;
    }
    if (type === "cell_meta") {
      const payload = asRecord(input.payload, "cell metadata payload");
      if (payload.stopped !== true) throw new FrameProtocolError("invalid Alder cell metadata");
      state.stopped = true;
      return;
    }
    if (type === "command_result") throw new FrameProtocolError("command result appeared during cell evaluation");
    throw new FrameProtocolError("unknown Alder Ark event type");
  }
  private appendLog(state: ActiveEvaluation, text: string): void {
    text = redactEngineSecrets(text, this.arkEventToken);
    const priorBytes = state.console.bytes;
    const delta = state.console.append(text);
    state.log = state.console.lines;
    state.truncated ||= state.console.truncated;
    if (delta === undefined) return;
    this.emitEvaluationEvent(state, {
      type: "output",
      sequence: ++state.sequence,
      kind: "log",
      payload: { ...delta, raw: Buffer.from(text, "utf8").subarray(0, state.console.bytes - priorBytes).toString("utf8") },
    });
  }

  private finishLog(state: ActiveEvaluation): void {
    const delta = state.console.finish(LOG_TRUNCATION_MARKER);
    state.log = state.console.lines;
    if (delta === undefined) return;
    this.emitEvaluationEvent(state, {
      type: "output",
      sequence: ++state.sequence,
      kind: "log",
      payload: { ...delta, raw: LOG_TRUNCATION_MARKER },
    });
  }

  private addEvaluationOutput(state: ActiveEvaluation, output: OutputRecord): number | undefined {
    const bytes = jsonByteSize(output);
    if (state.outputs.length >= MAX_OUTPUT_RECORDS ||
        state.outputBytes + bytes > this.maxOutputBytes()) {
      state.truncated = true;
      return undefined;
    }
    state.outputBytes += bytes;
    return state.outputs.push(output) - 1;
  }

  private async applyPendingClear(state: ActiveEvaluation): Promise<void> {
    if (!state.clearPending) return;
    await this.clearEvaluationOutputs(state);
  }

  private async clearEvaluationOutputs(state: ActiveEvaluation): Promise<void> {
    const outputs = state.outputs;
    state.outputs = [];
    state.outputBytes = 0;
    state.console = new OutputLog(MAX_LOG_BYTES);
    state.log = [];
    state.truncated = false;
    state.clearPending = false;
    await this.discardDuringEvaluation(state, outputs);
    this.emitEvaluationEvent(state, {
      type: "output",
      sequence: ++state.sequence,
      kind: "clear",
      payload: {},
    });
  }

  private finishEvaluationResponse(
    state: ActiveEvaluation,
    execution: ArkExecution,
  ): EngineResponse {
    if (!state.started) {
      throw new FrameProtocolError("Ark evaluation completed before the R acknowledgement");
    }
    const replyError = execution.reply.content.status === "error"
      ? jupyterError(execution.reply.content)
      : undefined;
    const requestedInterrupt = state.interruptSent;
    let error = state.structuredError ?? state.error ?? replyError;
    if (error === undefined && !state.finished) {
      if (requestedInterrupt) {
        error = { message: "Interrupted", code: "interrupted", interrupted: true };
      } else {
        throw new FrameProtocolError("Alder evaluation omitted its completion marker");
      }
    }
    const response = engineResponseSchema.parse(error === undefined
      ? {
          ok: true,
          outputs: state.outputs,
          stopped: state.stopped,
          log: state.log,
          truncated: state.truncated,
          ...(state.kernelStateInvalid === undefined ? {} : { kernelStateInvalid: state.kernelStateInvalid }),
        }
      : {
          ok: false,
          outputs: [],
          stopped: false,
          log: state.log,
          truncated: state.truncated,
          error,
          ...(state.kernelStateInvalid === undefined ? {} : { kernelStateInvalid: state.kernelStateInvalid }),
        });
    return error === undefined && response.outputs !== undefined
      ? { ...response, outputs: state.outputs.slice() }
      : response;
  }

  private emitEvaluationEvent(
    state: ActiveEvaluation,
    event: Record<string, unknown>,
  ): void {
    if (event.type === "output" && event.kind === "progress") {
      validateOutputPayload("progress", event.payload);
    }
    let canonicalOutput: OutputRecord | undefined;
    let canonicalResultOutputs: OutputRecord[] | undefined;
    if (event.type === "output" && event.kind === "append") {
      const appendPayload = asRecord(event.payload, "append output payload");
      const appendOutput = asRecord(appendPayload.output, "append output");
      const outputId = appendOutput.id;
      if (typeof outputId === "string") canonicalOutput = state.outputs.find((output) => output.id === outputId);
    }
    const completedResult = event.type === "completed" ? asRecord(event.result, "completed result") : undefined;
    const completedOutputs = completedResult?.outputs;
    if (Array.isArray(completedOutputs)) {
      const retained: OutputRecord[] = [];
      let allCanonical = completedOutputs.length <= state.outputs.length;
      if (allCanonical) {
        for (let index = 0; index < completedOutputs.length; index += 1) {
          const canonical = state.outputs[index];
          if (canonical === undefined || canonical !== completedOutputs[index]) {
            allCanonical = false;
            break;
          }
          retained.push(canonical);
        }
      }
      if (allCanonical) canonicalResultOutputs = retained;
    }
    const parsed = engineEventSchema.parse({
      ...event,
      requestId: state.requestId,
      sessionEpoch: state.payload.sessionEpoch,
      kernelEpoch: state.payload.kernelEpoch,
      operationId: state.payload.operationId,
      runId: state.payload.runId,
      cellId: state.payload.cellId,
      revision: state.payload.revision,
      documentRevision: state.payload.documentRevision,
    });
    if (canonicalOutput !== undefined && parsed.type === "output" && parsed.kind === "append") {
      const canonicalEvent: EngineEvent = { ...parsed, payload: { output: canonicalOutput } };
      state.onEvent?.(canonicalEvent);
      return;
    }
    if (canonicalResultOutputs !== undefined && parsed.type === "completed" && parsed.result.outputs !== undefined) {
      const canonicalEvent: EngineEvent = {
        ...parsed,
        result: { ...parsed.result, outputs: canonicalResultOutputs },
      };
      state.onEvent?.(canonicalEvent);
      return;
    }
    state.onEvent?.(parsed);
  }

  private async discardEvaluationOutputs(outputs: readonly OutputRecord[]): Promise<void> {
    this.outputStoreValue?.discardExact(outputs);
  }

  private async discardDuringEvaluation(_state: ActiveEvaluation, outputs: readonly OutputRecord[]): Promise<void> {
    this.outputStoreValue?.discardExact(outputs);
  }
  private async normalizeRequestResult(
    command: string,
    scope: OutputScope | undefined,
    response: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (response.ok !== true || (command !== "get_value" && command !== "lazy_eval")) return response;
    const field = command === "get_value" ? "value" : "output";
    if (!(field in response)) return response;
    if (scope === undefined) throw new FrameProtocolError("request output scope is required");
    const paths = this.paths;
    if (paths === undefined || this.kernelEpoch === null) {
      throw new EngineTransportError("output store is unavailable", "kernel");
    }
    const store = this.prepareOutputStore({
      sessionEpoch: scope.sessionEpoch,
      documentRevision: scope.documentRevision,
    });
    const normalized = await store.normalizeAlder(response[field], scope);
    return { ...response, [field]: normalized };
  }

  private async runArkCommand(
    command: string,
    payload: Record<string, unknown>,
    trace = true,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const kernel = this.kernel;
    if (kernel?.ready !== true) throw new EngineTransportError("kernel is unavailable", "kernel");
    if (this.pendingKernelRequests + this.evaluations.size >= MAX_PENDING_REQUESTS) {
      throw new EngineTransportError("engine request queue is full", "kernel");
    }
    const requestId = this.nextRequestId();
    const marker = randomUUID();
    const wire = { req: requestId, command, ...payload };
    const span = trace
      ? this.trace.begin("host.engine.request", requestTraceFields("kernel", command, wire))
      : undefined;
    this.pendingKernelRequests += 1;
    let result: Record<string, unknown> | undefined;
    let messageError: Error | undefined;
    let messageTail = Promise.resolve();
    const eventStream = new ArkEventStreamDecoder(this.arkEventToken, this.maxArkPayloadBytes());
    try {
      const request = encodeArkRequest({ request: marker, command, payload }, this.maxArkPayloadBytes());
      let started = false;
      const interrupt = (): void => {
        if (started) void kernel.interrupt().catch(() => undefined);
      };
      signal?.addEventListener("abort", interrupt, { once: true });
      const execution = await kernel.execute(arkCall("request", request), {
        onStarted: () => {
          started = true;
          if (signal?.aborted) void kernel.interrupt().catch(() => undefined);
        },
        onMessage: (message) => {
          messageTail = messageTail.then(() => {
            if (message.header.msg_type !== "stream") return;
            for (const part of eventStream.push(streamText(message))) {
            const event = part.event;
            if (event === undefined) continue;
            if (event.type !== "command_result" || event.request !== marker ||
                result !== undefined) {
              throw new FrameProtocolError("invalid Alder Ark command result");
            }
            const payload = asRecord(event.payload, "Alder Ark command result payload");
            const response = asRecord(payload.response, "Alder Ark command response");
            result = Object.prototype.hasOwnProperty.call(response, "error") && response.error !== undefined
              ? (() => {
                  const error = canonicalizeEngineError(response.error);
                  const marker = kernelStateInvalidMarker(engineErrorSchema.parse(error));
                  return marker === null ? { ...response, error } : { ...response, error, kernelStateInvalid: marker };
                })()
              : response;
            }
          }).catch((error) => { messageError ??= asError(error); });
        },
      }, { storeHistory: false, auxiliary: command === "env_snapshot", signal })
        .finally(() => signal?.removeEventListener("abort", interrupt));
      await messageTail;
      if (messageError !== undefined) throw messageError;
      eventStream.finish();
      if (execution.reply.content.status !== "ok") {
        throw new EngineTransportError(jupyterError(execution.reply.content).message, "kernel");
      }
      if (result === undefined) {
        throw new FrameProtocolError("Alder Ark command omitted its result");
      }
      if (span !== undefined) this.trace.end(span, terminalTraceFields(result));
      return result;
    } catch (error) {
      if (span !== undefined) {
        this.trace.end(span, { outcome: "failure", error: asError(error).name });
      }
      throw error;
    } finally {
      this.pendingKernelRequests -= 1;
    }
  }
  private async releaseDeferredArtifacts(artifacts: readonly string[]): Promise<void> {
    for (const artifact of artifacts) {
      if (!artifactHandle(artifact)) throw new FrameProtocolError("invalid deferred artifact handle");
    }
    for (let offset = 0; offset < artifacts.length; offset += MAX_RELEASE_ARTIFACTS) {
      const response = await this.releaseOutputs({
        artifacts: artifacts.slice(offset, offset + MAX_RELEASE_ARTIFACTS),
      });
      if (!response.ok) {
        throw new FrameProtocolError(response.error?.message ?? "deferred artifact release failed");
      }
      if (response.failed !== undefined && response.failed.length > 0) {
        throw new FrameProtocolError(
          "deferred artifact release failed for " + response.failed.length + " artifact(s)",
        );
      }
    }
  }

  private async releaseOutputs(payload: Record<string, unknown>): Promise<EngineResponse> {
    const values = payload.artifacts;
    if (!Array.isArray(values)) {
      const response = releaseOutputsResponseSchema.parse(
        await this.runArkCommand("release_outputs", payload),
      );
      return engineResponseSchema.parse(response);
    }
    if (values.length > MAX_RELEASE_ARTIFACTS) {
      throw new FrameProtocolError("release_outputs batch exceeds the wire limit");
    }
    const descriptors: ArtifactHandle[] = [];
    const worker: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value === "string") {
        if (!artifactHandle(value)) throw new FrameProtocolError("invalid artifact handle");
        if (seen.has(value)) throw new FrameProtocolError("release_outputs requires unique artifact handles");
        seen.add(value);
        worker.push(value);
        continue;
      }
      const jsonValue = protocolJsonSchema.safeParse(value);
      if (!jsonValue.success) throw new FrameProtocolError("invalid artifact descriptor");
      const parsed = artifactHandleSchema.safeParse(jsonValue.data);
      if (!parsed.success) throw new FrameProtocolError("invalid artifact descriptor");
      if (seen.has(parsed.data.handle)) throw new FrameProtocolError("release_outputs requires unique artifact handles");
      seen.add(parsed.data.handle);
      descriptors.push(parsed.data);
    }
    const local = this.outputStoreValue?.release(descriptors) ?? { released: [], missing: descriptors.map(value => value.handle), failed: [] };
    const response = releaseOutputsResponseSchema.parse(
      worker.length === 0
        ? { ok: true, released: [], missing: [], failed: [] }
        : await this.runArkCommand("release_outputs", { artifacts: worker }),
    );
    if (!response.ok) return engineResponseSchema.parse(response);
    return engineResponseSchema.parse({
      ...response,
      released: [...(response.released ?? []), ...local.released],
      missing: [...(response.missing ?? []), ...local.missing],
      failed: [...(response.failed ?? []), ...local.failed],
    });
  }
  private kernelFailed(generation: number, error: Error): void {
    if (generation !== this.peerGeneration) return;
    if (this.state !== "closed") this.state = "degraded";
    this.executingRequest = undefined;
    this.interruptRequested = undefined;
    if (this.state !== "closed") {
      this.emit("failure", "kernel", new EngineTransportError(error.message, "kernel"));
    }
  }

  private maxArkPayloadBytes(): number {
    return Math.ceil(
      (this.options.maxFrameBytes ?? DEFAULT_MAX_ENGINE_FRAME_BYTES) * 4 / 3,
    ) + 65_536;
  }

  private maxOutputBytes(): number {
    return Math.min(
      this.options.maxFrameBytes ?? DEFAULT_MAX_ENGINE_FRAME_BYTES,
      DEFAULT_MAX_FRAME_BYTES,
    );
  }
}

function parseHandshake(role: RPeerRole, input: unknown): RawHandshake {
  const value = asRecord(input, "handshake");
  if (value.kind !== "handshake" || value.protocol !== ENGINE_PROTOCOL ||
      value.role !== role) {
    throw new FrameProtocolError("handshake protocol or role does not match");
  }
  const engine = asRecord(value.engine, "handshake engine identity");
  if (typeof engine.name !== "string" || engine.name.length === 0 ||
      engine.version !== "1") {
    throw new FrameProtocolError("invalid engine identity");
  }
  if (typeof value.package_version !== "string" || value.package_version.length === 0 ||
      typeof value.r_version !== "string" || value.r_version.length === 0 ||
      !Array.isArray(value.capabilities) ||
      value.capabilities.some((capability) => typeof capability !== "string")) {
    throw new FrameProtocolError("invalid handshake identity or capabilities");
  }
  const readiness = asRecord(value.readiness, "handshake readiness");
  if (readiness.initialized !== true ||
      readiness.analysis !== true) {
    throw new FrameProtocolError(`${role} is not initialized`);
  }
  return {
    protocol: ENGINE_PROTOCOL,
    role,
    packageVersion: value.package_version,
    rVersion: value.r_version,
    capabilities: [...value.capabilities] as string[],
  };
}

function isTraceValue(value: unknown): value is TraceFields[string] {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function requestTraceFields(
  role: PeerRole,
  command: string,
  wire: Record<string, unknown>,
): TraceFields {
  const fields: TraceFields = {
    req: typeof wire.req === "number" ? wire.req : undefined,
    role,
    cmd: command,
  };
  const names = [
    "id",
    "revision",
    "run_id",
    "session_epoch",
    "operation_id",
  ] as const;
  for (const name of names) {
    const value = wire[name];
    if (isTraceValue(value)) {
      fields[name] = value;
    }
  }
  return fields;
}

function terminalTraceFields(value: Record<string, unknown>): TraceFields {
  const fields: TraceFields = {
    outcome: "terminal",
    ok: value.ok === true,
  };
  const error = value.error;
  if (typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "string") {
    fields.error_code = error.code;
  }
  return fields;
}

function mapAnalysisResult(
  raw: Record<string, unknown>,
  sources: ReadonlyMap<string, string>,
): unknown {
  if (!Array.isArray(raw.cells)) throw new FrameProtocolError("analysis cells are missing");
  const analyzer = asRecord(raw.analyzer, "analyzer identity");
  const analysisEnvironmentId = raw.analysisEnvironmentId;
  if (typeof analysisEnvironmentId !== "string" || analysisEnvironmentId.length === 0 ||
      analyzer.analysisEnvironmentId !== analysisEnvironmentId) {
    throw new FrameProtocolError("analysis environment identity is missing or inconsistent");
  }
  const cells = raw.cells.map((input) => {
    const cell = asRecord(input, "analysis cell");
    const source = typeof cell.id === "string" ? sources.get(cell.id) : undefined;
    const diagnostics = Array.isArray(cell.diagnostics)
      ? cell.diagnostics.map((diagnostic) => mapAnalysisDiagnostic(diagnostic, source))
      : cell.diagnostics;
    return {
      id: cell.id,
      revision: cell.revision,
      defs: cell.defs,
      refs: cell.refs,
      selfRefs: cell.selfRefs,
      locals: cell.locals,
      barrier: cell.barrier,
      opaque: cell.opaque,
      diagnostics,
      error: cell.error ?? null,
      ...(cell.ranges === undefined ? {} : { ranges: mapAnalysisRanges(cell.ranges, source) }),
    };
  });
  const packageVersion = analyzer.packageVersion ?? analyzer.package_version;
  const rVersion = analyzer.rVersion ?? analyzer.r_version;
  return {
    revision: raw.revision,
    analysisEnvironmentId,
    cells,
    analyzer: {
      packageVersion,
      rVersion,
      policy: analyzer.policy,
      analysisEnvironmentId,
    },
  };
}

function mapAnalysisDiagnostic(value: unknown, source: string | undefined): unknown {
  const diagnostic = asRecord(value, "analysis diagnostic");
  const mapped: Record<string, unknown> = { ...diagnostic };
  mapped.range = diagnostic.range === undefined || diagnostic.range === null
    ? null
    : mapRawRange(diagnostic.range, source);
  if (Object.prototype.hasOwnProperty.call(diagnostic, "occurrences")) {
    if (!Array.isArray(diagnostic.occurrences)) {
      throw new FrameProtocolError("analysis diagnostic occurrences must be an array");
    }
    mapped.occurrences = diagnostic.occurrences
      .map((range) => mapRawRange(range, source))
      .filter((range): range is Record<string, unknown> => range !== null);
  }
  return mapped;
}

function mapAnalysisRanges(value: unknown, source: string | undefined): Record<string, unknown> {
  const grouped: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
  const add = (entry: unknown, fallbackName?: string): void => {
    const rawRange = asRecord(entry, "analysis source range");
    const name = rawRange.name ?? fallbackName;
    if (typeof name !== "string" || name.length === 0) {
      throw new FrameProtocolError("analysis source range name is invalid");
    }
    const mapped = mapRawRange(rawRange, source);
    if (mapped === null) return;
    (grouped[name] ??= []).push(mapped);
  };
  if (Array.isArray(value)) {
    for (const entry of value) add(entry);
    return grouped;
  }
  const record = asRecord(value, "analysis ranges");
  for (const [name, entries] of Object.entries(record)) {
    if (!Array.isArray(entries)) throw new FrameProtocolError("analysis ranges must contain arrays");
    for (const entry of entries) add(entry, name);
  }
  return grouped;
}

function mapRawRange(value: unknown, source: string | undefined): Record<string, unknown> | null {
  const range = asRecord(value, "analysis source range");
  const start = mapRawPosition(range.start, source, "start");
  const end = mapRawPosition(range.end, source, "end");
  if (start === null || end === null) return null;
  return { start, end };
}

type RawPositionEndpoint = "start" | "end";

function mapRawPosition(
  value: unknown,
  source: string | undefined,
  endpoint: RawPositionEndpoint,
): Record<string, number> | null {
  const position = asRecord(value, "analysis source position");
  const line = position.line;
  const column = position.column;
  if (typeof line !== "number" || typeof column !== "number" ||
      !Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
    throw new FrameProtocolError("analysis source position is invalid");
  }
  if (source === undefined) return null;
  const lines = source.split("\n");
  const lineText = lines[line - 1];
  if (lineText === undefined) return null;
  const bytes = Buffer.byteLength(lineText, "utf8");
  // The analyzer emits a one-based byte start and an end byte count. The end
  // count is already the exclusive UTF-8 boundary; never round a split byte.
  const byteOffset = endpoint === "end" ? column : column - 1;
  if (byteOffset > bytes) return null;
  let consumed = 0;
  let utf16 = 0;
  for (const character of lineText) {
    const size = Buffer.byteLength(character, "utf8");
    if (consumed === byteOffset) return { line: line - 1, character: utf16 };
    if (consumed < byteOffset && byteOffset < consumed + size) return null;
    consumed += size;
    utf16 += character.length;
  }
  if (consumed !== byteOffset) return null;
  return { line: line - 1, character: utf16 };
}

function assertAnalyzerIdentity(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  for (const field of ["revision", "analysisEnvironmentId"] as const) {
    if (request[field] !== undefined && !Object.is(request[field], response[field])) {
      throw new FrameProtocolError(`response ${field} identity does not match`);
    }
  }
}

function validateOutputPayload(kind: "append" | "progress" | "log", input: unknown): void {
  const payload = asRecord(input, `${kind} output payload`);
  if (kind === "append") {
    const output = asRecord(payload.output, "append output");
    if (Object.keys(output).length === 0) throw new FrameProtocolError("append output is empty");
  } else if (kind === "progress") {
    const progress = asRecord(payload.progress, "progress output");
    try {
      progressOutputSchema.parse(progress);
    } catch (error) {
      throw new FrameProtocolError(`invalid progress output: ${asError(error).message}`);
    }
  } else {
    const lines = payload.lines;
    if (!(typeof lines === "string" ||
          (Array.isArray(lines) && lines.every((line) => typeof line === "string")))) {
      throw new FrameProtocolError("invalid log output");
    }
  }
}

function requestOutputScope(value: unknown): OutputScope {
  const raw = asRecord(value, "request output scope");
  const keys = ["sessionEpoch", "documentRevision", "kernelEpoch", "runId", "cellId", "revision"];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key)) ||
      !protocolJsonSchema.safeParse(raw).success) {
    throw new FrameProtocolError("request output scope is invalid");
  }
  const scope = raw as OutputScope;
  const validRevision = (entry: unknown): boolean => entry === null ||
    (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0);
  const validId = (entry: unknown): boolean => typeof entry === "string" && entry.length > 0 && entry.length <= 256;
  const validNullableId = (entry: unknown): boolean => entry === null || validId(entry);
  if (!validId(scope.sessionEpoch) || typeof scope.documentRevision !== "number" ||
      !Number.isSafeInteger(scope.documentRevision) || scope.documentRevision < 0 ||
      !validNullableId(scope.kernelEpoch) || scope.kernelEpoch === null ||
      !validNullableId(scope.runId) || !validNullableId(scope.cellId) ||
      !validRevision(scope.revision) || (scope.cellId === null) !== (scope.revision === null) ||
      (scope.kernelEpoch === null && scope.runId !== null)) {
    throw new FrameProtocolError("request output scope is invalid");
  }
  return {
    sessionEpoch: scope.sessionEpoch,
    documentRevision: scope.documentRevision,
    kernelEpoch: scope.kernelEpoch,
    runId: scope.runId,
    cellId: scope.cellId,
    revision: scope.revision,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function canonicalizeEngineError(value: unknown): Record<string, unknown> {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(rawEngineErrorSchema.parse(value), "Alder Ark error");
  } catch (error) {
    throw new FrameProtocolError(`invalid Alder Ark error: ${asError(error).message}`);
  }
  const hasCondition = ["class", "call", "trace"].some((key) =>
    Object.prototype.hasOwnProperty.call(raw, key),
  );
  if (!hasCondition) return raw;
  const canonical: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key !== "class" && key !== "call" && key !== "trace" && key !== "details") {
      canonical[key] = entry;
    }
  }
  const details: Record<string, unknown> = {
    condition: { class: raw.class, call: raw.call, trace: raw.trace },
  };
  if (Object.prototype.hasOwnProperty.call(raw, "details")) details.data = raw.details;
  canonical.details = details;
  return canonical;
}
function kernelStateInvalidMarker(
  error: EngineResponse["error"],
): NonNullable<EngineResponse["kernelStateInvalid"]> | null {
  if (error === undefined) return null;
  if (error.code === "kernel_state_invalid") return error;
  const details = optionalRecord(error.details);
  const data = optionalRecord(details?.data);
  const marker = data?.code === "kernel_state_invalid"
    ? data
    : details?.code === "kernel_state_invalid" ? details : undefined;
  if (marker === undefined) return null;
  return {
    code: "kernel_state_invalid",
    message: "Alder kernel state is invalid; restart the kernel",
  };
}
function redactEngineSecrets(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join("[REDACTED]");
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FrameProtocolError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requestError(raw: Record<string, unknown>, fallback: string): EngineRequestError {
  const response = engineResponseSchema.parse(raw);
  return new EngineRequestError(response.error?.message ?? fallback, response);
}

function arkCall(method: "evaluate" | "request", request: unknown): string {
  return `base::get(".__alder_app_bridge_v1", envir=base::globalenv(), inherits=FALSE)$${method}(${rLiteral(request)})`;
}

function evaluationWire(value: EvaluationPayload, controlDirectory: string): Record<string, unknown> {
  const encoded = encodeSource(value.source, "evaluation source");
  let source: Record<string, string>;
  if (encoded.bytes > 1024 * 1024) {
    const path = join(controlDirectory, ".alder-source-" + randomUUID());
    writeFileSync(path, encoded.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    source = { code_path: path };
  } else {
    source = { code: encoded.text };
  }
  return {
    id: value.cellId, revision: value.revision, run_id: value.runId,
    session_epoch: value.sessionEpoch, kernel_epoch: value.kernelEpoch,
    operation_id: value.operationId,
    ...source,
    defs: value.definitions, locals: value.locals, opaque: value.opaque,
  };
}

function makeEvaluation(
  requestId: number,
  payload: EvaluationPayload,
  onEvent: ((event: EngineEvent) => void) | undefined,
  kernelGeneration: number,
  token: string,
  maxBytes: number,
): ActiveEvaluation {
  return {
    requestId, payload, onEvent, kernelGeneration, started: false, sequence: 0, rSequence: 0,
    outputs: [], outputBytes: 0, log: [],
    console: new OutputLog(MAX_LOG_BYTES), truncated: false, stopped: false,
    finished: false, kernelTerminal: false, interruptSent: false, clearPending: false,
    deferredArtifactReleases: new Set(), messageTail: Promise.resolve(),
    eventStream: new ArkEventStreamDecoder(token, maxBytes),
  };
}

function successfulExecution(message: JupyterMessage): ArkExecution {
  return { id: message.parentHeader.msg_id ?? message.header.msg_id,
    reply: { ...message, content: { status: "ok" } }, messages: [] };
}

function encodeArkRequest(value: unknown, maxBytes: number): unknown {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`Ark request is not JSON serializable: ${asError(error).message}`);
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > maxBytes) {
    throw new FrameProtocolError("Alder Ark request exceeds the configured byte limit");
  }
  return value;
}

function rLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `base::list(${value.map(rLiteral).join(",")})`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `base::structure(base::list(${entries.map(([, child]) => rLiteral(child)).join(",")}),names=base::c(${entries.map(([name]) => JSON.stringify(name)).join(",")}))`;
  }
  throw new TypeError("Ark request contains an unsupported value");
}

function streamText(message: JupyterMessage): string {
  const text = message.content.text;
  if (typeof text !== "string") throw new FrameProtocolError("Ark stream text is invalid");
  return text;
}

type ArkStreamPart = { text: string; event?: never } | { event: Record<string, unknown>; text?: never };

class ArkEventStreamDecoder {
  private pending = "";
  private readonly prefix: string;
  private readonly end = ":\u001e\n";

  constructor(private readonly token: string, private readonly maxBytes: number) {
    this.prefix = `\u001eALDER:${token}:`;
  }

  push(text: string): ArkStreamPart[] {
    this.pending += text;
    const parts: ArkStreamPart[] = [];
    while (this.pending.length > 0) {
      const start = this.pending.indexOf(this.prefix);
      if (start > 0) {
        parts.push({ text: this.pending.slice(0, start) });
        this.pending = this.pending.slice(start);
      } else if (start < 0) {
        let retained = 0;
        for (let length = Math.min(this.pending.length, this.prefix.length - 1); length > 0; length--) {
          if (this.pending.endsWith(this.prefix.slice(0, length))) { retained = length; break; }
        }
        const ordinary = this.pending.slice(0, this.pending.length - retained);
        if (ordinary) parts.push({ text: ordinary });
        this.pending = this.pending.slice(this.pending.length - retained);
        break;
      }
      if (!this.pending.startsWith(this.prefix)) continue;
      const end = this.pending.indexOf(this.end, this.prefix.length);
      if (end < 0) {
        if (this.pending.length > Math.ceil(this.maxBytes * 4 / 3) + this.prefix.length + this.end.length + 4) {
          throw new FrameProtocolError("Alder Ark event exceeds the configured byte limit");
        }
        break;
      }
      const encoded = this.pending.slice(this.prefix.length, end);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new FrameProtocolError("invalid Alder Ark event base64");
      let event: Record<string, unknown>;
      try {
        event = asRecord(parseStrictJson(decodeBase64(encoded, this.maxBytes).toString("utf8")), "Alder Ark event");
      } catch (error) {
        throw new FrameProtocolError("invalid Alder Ark event: " + asError(error).message);
      }
      validateArkEvent(event, this.token);
      parts.push({ event });
      this.pending = this.pending.slice(end + this.end.length);
    }
    return parts;
  }

  finish(): void {
    if (this.pending.length > 0) throw new FrameProtocolError("incomplete Alder Ark event frame");
  }
}

function validateArkEvent(event: Record<string, unknown>, token: string): void {
  if (event.token !== token || typeof event.token !== "string") throw new FrameProtocolError("Alder Ark event token does not match");
  if (!(typeof event.request === "string" || (typeof event.request === "number" && Number.isSafeInteger(event.request)))) throw new FrameProtocolError("Alder Ark event request is invalid");
  if (typeof event.type !== "string" || !["started", "append", "progress", "log", "result", "condition", "finished", "cell_meta", "command_result", "batch_end"].includes(event.type)) throw new FrameProtocolError("Alder Ark event type is invalid");
  if (typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new FrameProtocolError("Alder Ark event sequence is invalid");
  for (const field of ["session_epoch", "kernel_epoch", "run_id", "operation_id", "cell_id"] as const) {
    if (typeof event[field] !== "string" && event[field] !== null) throw new FrameProtocolError("Alder Ark event identity is invalid");
  }
  if (event.type === "command_result") {
    if (event.revision !== null && (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision < 0)) throw new FrameProtocolError("Alder command event revision is invalid");
  } else if (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision < 0) {
    throw new FrameProtocolError("Alder Ark event revision is invalid");
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) throw new FrameProtocolError("Alder Ark event payload is invalid");
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  const normalized = value.replace(/[\r\n]/g, "");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  if (normalized.length === 0 || normalized.length > Math.ceil(maxBytes * 4 / 3) + 4 ||
      normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
      value.replace(/[A-Za-z0-9+/=\r\n]/g, "").length !== 0) {
    throw new FrameProtocolError("invalid or oversized base64 payload from Ark");
  }
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length > maxBytes ||
      bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new FrameProtocolError("invalid or oversized base64 payload from Ark");
  }
  return bytes;
}

function jupyterError(content: Record<string, unknown>): NonNullable<EngineResponse["error"]> {
  const name = typeof content.ename === "string" ? content.ename : "R error";
  const value = typeof content.evalue === "string" && content.evalue.length > 0
    ? content.evalue
    : name;
  const interrupted = /interrupt/i.test([name, value].join(" "));
  const jupyter: Record<string, unknown> = {};
  for (const field of ["ename", "evalue", "traceback"] as const) {
    if (Object.prototype.hasOwnProperty.call(content, field)) jupyter[field] = content[field];
  }
  const details = Object.keys(jupyter).length > 0
    ? protocolJsonSchema.parse({ jupyter })
    : undefined;
  return {
    message: interrupted ? "Interrupted" : value,
    code: interrupted ? "interrupted" : "evaluation_error",
    interrupted,
    ...(details === undefined ? {} : { details }),
  };
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}


function artifactHandle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    basename(value) === value && !value.startsWith(".") && !/[\\/]/.test(value) &&
    extname(value).length > 1;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new FrameProtocolError("artifact response contains an invalid list");
  }
  return [...value] as string[];
}


function jsonByteSize(value: unknown): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded ?? "null", "utf8");
}

function encodeSource(value: string, label: string): { text: string; base64: string; bytes: number } {
  if (value.includes("\0")) throw new TypeError(`${label} contains NUL`);
  const source = Buffer.from(value, "utf8");
  if (source.toString("utf8") !== value) {
    throw new TypeError(`${label} is not valid Unicode`);
  }
  if (source.length > MAX_NOTEBOOK_SOURCE_BYTES) {
    throw new TypeError(`${label} exceeds the 32 MiB notebook limit`);
  }
  return { text: value, base64: source.toString("base64"), bytes: source.length };
}

async function prepareRuntime(paths: ResolvedPaths): Promise<RuntimePaths> {
  const captureDirectory = await mkdtemp(join(paths.artifactDirectory, ".alder-capture-"));
  try {
    const controlDirectory = await mkdtemp(join(paths.artifactDirectory, ".alder-control-"));
    return { captureDirectory, controlDirectory, ownedDirectories: [captureDirectory, controlDirectory] };
  } catch (error) {
    await rm(captureDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function resolvePaths(
  options: EngineOptions,
  environment: REnvironment,
  signal?: AbortSignal,
  pathOptions: Pick<EngineOptions, "notebookDirectory" | "cacheDirectory"> = options,
): Promise<ResolvedPaths> {
  throwIfAborted(signal);
  const resources = options.resources;
  const workerDirectory = resolve(resources.workerDirectory);
  const arkStartupScript = join(workerDirectory, "host-ark.R");
  const analyzerScript = join(workerDirectory, "host-analyzer.R");
  const framingScript = join(workerDirectory, "host-framing.R");
  const arkExecutable = resolve(resources.arkExecutable);
  await Promise.all([
    requireFile(arkExecutable, "Ark executable"),
    requireFile(arkStartupScript, "Ark startup script"),
    requireFile(analyzerScript, "analyzer script"),
    requireFile(framingScript, "framing script"),
  ]);
  const notebookDirectory = resolve(pathOptions.notebookDirectory ?? options.notebookDirectory ?? process.cwd());
  const notebookInfo = await stat(notebookDirectory);
  if (!notebookInfo.isDirectory()) throw new Error("notebookDirectory is not a directory");
  const ownedDirectories: string[] = [];
  let artifactDirectory: string;
  let cacheDirectory: string;
  try {
    throwIfAborted(signal);
    artifactDirectory = resolve(options.artifactDirectory);
    await mkdir(artifactDirectory, { recursive: true });
    throwIfAborted(signal);
    cacheDirectory = pathOptions.cacheDirectory === undefined
      ? await mkdtemp(join(tmpdir(), "alder-engine-cache-"))
      : resolve(pathOptions.cacheDirectory);
    if (pathOptions.cacheDirectory === undefined) ownedDirectories.push(cacheDirectory);
    else await mkdir(cacheDirectory, { recursive: true });
  } catch (error) {
    await Promise.all(ownedDirectories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {})));
    throw error;
  }
  const base = strictEnvironment({
    ...process.env,
    ALDER_NOTEBOOK_DIR: notebookDirectory,
    ALDER_ARTIFACT_DIR: artifactDirectory,
    ALDER_CACHE_DIR: cacheDirectory,
  });
  const analyzerEnvironment = {
    ...base,
    ...rServiceEnvironmentVariables(environment, resources),
    ALDER_HOST_FRAMING: framingScript,
    ALDER_HOST_PROTOCOL: "framed-v2",
    ALDER_HOST_ROLE: "analyzer",
  };
  const arkEnvironment = {
    ...base,
    ...rKernelEnvironmentVariables(environment, resources, notebookDirectory),
  };
  delete arkEnvironment.ALDER_HOST_FRAMING;
  delete arkEnvironment.ALDER_HOST_PROTOCOL;
  delete arkEnvironment.ALDER_HOST_ROLE;
  return {
    arkExecutable, arkStartupScript, analyzerScript, framingScript,
    notebookDirectory, artifactDirectory, cacheDirectory, ownedDirectories,
    analyzerEnvironment, arkEnvironment,
  };
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineTransportError("engine startup was cancelled");
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
    if (!(await stat(path)).isFile()) throw new Error();
  } catch {
    throw new Error(label + " not found: " + path);
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
function strictEnvironment(value: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = entry;
  return result;
}

function freezeEnvironment(environment: REnvironment): REnvironment {
  return Object.freeze({ ...environment, libraryPaths: Object.freeze([...environment.libraryPaths]) });
}

function sameRestartContext(left: EngineRestartOptions, right: EngineRestartOptions): boolean {
  return left.notebookDirectory === right.notebookDirectory &&
    left.cacheDirectory === right.cacheDirectory &&
    left.environment?.identity === right.environment?.identity;
}

function makeAnalysisEnvironmentId(environment: REnvironment, generation: number): string {
  return createHash("sha256").update(environment.identity + "\\0" + String(generation)).digest("hex");
}

function validatePositiveTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError(name + " must be a positive finite number");
}

 function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
