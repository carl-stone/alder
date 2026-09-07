import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";

import {
  analysisResultSchema,
  cellSnapshotSchema,
  engineErrorSchema,
  engineEventSchema,
  engineHandshakeSchema,
  engineResponseSchema,
  evaluationPayloadSchema,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  type AnalysisResult,
  type CellSnapshot,
  type EngineAdapter,
  type EngineEvent,
  type EngineHandshake,
  type EngineResponse,
  type EvaluationPayload,
} from "./protocol.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_ENGINE_FRAME_BYTES,
  ENGINE_PROTOCOL,
  FrameDecoder,
  FrameProtocolError,
  encodeFrame,
  parseStrictJson,
} from "./framing.js";
import { PerformanceTrace, type PerformanceSpan, type TraceFields } from "./performance.js";
import { OutputLog } from "./output-log.js";
import {
  ArkKernel,
  type ArkExecution,
  type JupyterMessage,
} from "./jupyter.js";

type FailureRole = "kernel" | "analyzer" | "services";
type RPeerRole = "analyzer" | "service";
type PeerRole = FailureRole | "service";
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

const SERVICE_COMMANDS = new Set([
  "codec.decode",
  "codec.document",
  "codec.encode",
  "config.resolve",
  "config.validate",
  "config.encode",
  "layout.validate",
  "layout.read",
  "layout.encode",
  "markdown.render",
  "help.render",
  "app.validate",
  "format",
  "graph",
  "export.render",
]);

const MAX_PENDING_REQUESTS = 1_024;
const MAX_OUTPUT_RECORDS = 4_096;
const MAX_LOG_BYTES = 1_048_576;
const LOG_TRUNCATION_MARKER = "[output truncated at 1048576 bytes]";
const ARK_EVENT_PREFIX = "<!--ALDER_EVENT_V1:";

export interface EngineOptions {
  rscript?: string;
  packagePath?: string;
  notebookDirectory?: string;
  artifactDirectory?: string;
  cacheDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxFrameBytes?: number;
  arkExecutable?: string;
  arkStartupScript?: string;
  analyzerScript?: string;
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
  reject: (error: Error) => void;
}

interface ResolvedPaths {
  packagePath: string;
  arkExecutable: string;
  arkStartupScript: string;
  analyzerScript: string;
  framingScript: string;
  notebookDirectory: string;
  artifactDirectory: string;
  cacheDirectory: string;
  ownedDirectories: string[];
  analyzerEnvironment: NodeJS.ProcessEnv;
  arkEnvironment: NodeJS.ProcessEnv;
}

interface RuntimePaths {
  captureDirectory: string;
  ownedDirectories: string[];
}

interface ActiveEvaluation {
  requestId: number;
  payload: EvaluationPayload;
  onEvent?: (event: EngineEvent) => void;
  started: boolean;
  sequence: number;
  rSequence: number;
  outputs: unknown[];
  outputBytes: number;
  displayOutputs: Map<string, number>;
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
  messageTail: Promise<void>;
  messageError?: Error;
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
  private child: ChildProcessWithoutNullStreams | undefined;
  private decoder: FrameDecoder;
  private writeTail: Promise<void> = Promise.resolve();
  private handshakeResolve: ((value: RawHandshake) => void) | undefined;
  private handshakeReject: ((error: Error) => void) | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private exitPromise: Promise<void> = Promise.resolve();
  private exitResolve: (() => void) | undefined;
  private handshake: RawHandshake | undefined;
  private failed = false;
  private intentionalExit = false;
  private stderr = Buffer.alloc(0);

  constructor(
    readonly role: RPeerRole,
    private readonly rscript: string,
    private readonly script: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
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
      this.child !== undefined && childRunning(this.child);
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<RawHandshake> {
    if (this.child !== undefined) throw new Error(`${this.role} peer was already started`);
    this.exitPromise = new Promise((resolveExit) => {
      this.exitResolve = resolveExit;
    });
    const child = spawn(this.rscript, ["--vanilla", this.script], {
      cwd: this.cwd,
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.recordStderr(chunk));
    child.stdin.on("error", (error) => {
      this.fail(new EngineTransportError(
        `could not write to ${this.role}: ${error.message}`,
        this.role,
      ));
    });
    child.once("error", (error) => {
      this.fail(new EngineTransportError(
        `could not start ${this.role}: ${error.message}`,
        this.role,
      ));
    });
    child.once("exit", (code, signal) => {
      this.exitResolve?.();
      if (!this.failed) {
        const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit status ${code}`;
        this.fail(new EngineTransportError(
          `${this.role} exited (${reason})${this.stderrText()}`,
          this.role,
        ));
      }
    });
    const startup = new Promise<RawHandshake>((resolveHandshake, rejectHandshake) => {
      this.handshakeResolve = resolveHandshake;
      this.handshakeReject = rejectHandshake;
    });
    this.startupTimer = setTimeout(() => {
      this.fail(new EngineTransportError(
        `${this.role} did not become ready within ${this.startupTimeoutMs} ms${this.stderrText()}`,
        this.role,
      ));
    }, this.startupTimeoutMs);
    return startup;
  }

  send(value: unknown): Promise<void> {
    if (!this.ready || this.child === undefined) {
      return Promise.reject(new EngineTransportError(`${this.role} is unavailable`, this.role));
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(value, this.maxFrameBytes);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const write = this.writeTail.then(async () => {
      const input = this.child?.stdin;
      if (input === undefined || input.destroyed) {
        throw new EngineTransportError(`${this.role} input is closed`, this.role);
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
        `could not write to ${this.role}: ${asError(error).message}`,
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
    if (child === undefined || !childRunning(child)) return;
    child.stdin.end();
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
    ]);
    if (childRunning(child)) {
      child.kill("SIGTERM");
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 250)),
      ]);
    }
    if (childRunning(child)) {
      child.kill("SIGKILL");
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
      ]);
    }
    if (childRunning(child)) {
      throw new EngineTransportError(
        `${this.role} did not exit after SIGKILL`,
        this.role,
      );
    }
  }

  private receive(chunk: Buffer): void {
    if (this.failed) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(new EngineTransportError(
        `invalid ${this.role} frame: ${asError(error).message}${this.stderrText()}`,
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
            `invalid ${this.role} handshake: ${asError(error).message}`,
            this.role,
          ));
        }
      } else {
        try {
          this.onFrame(this.role, frame);
        } catch (error) {
          this.fail(new EngineTransportError(
            `invalid ${this.role} response: ${asError(error).message}`,
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
    const child = this.child;
    if (child !== undefined && childRunning(child)) child.kill("SIGKILL");
    this.onFailure(this.role, error, this.intentionalExit);
  }

  private recordStderr(chunk: Buffer): void {
    this.stderr = Buffer.concat([this.stderr, chunk]);
    if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.subarray(-64 * 1024);
  }

  private stderrText(): string {
    const text = this.stderr.toString("utf8").trim();
    return text.length === 0 ? "" : `; stderr: ${text}`;
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
  private kernel: ArkKernel | undefined;
  private analyzer: RPeer | undefined;
  private servicePeer: RPeer | undefined;
  private requestCounter = 1;
  private readonly rPending = new Map<number, PendingRRequest>();
  private readonly evaluations = new Map<number, ActiveEvaluation>();
  private readonly batches = new Set<ActiveBatch>();
  private pendingKernelRequests = 0;
  private executingRequest: number | undefined;
  private interruptRequested: number | undefined;
  private readonly interruptDeliveries = new Map<number, Promise<void>>();
  private arkEventToken = "";
  private readonly nativeArtifacts = new Set<string>();
  private runtime: RuntimePaths | undefined;
  private peerGeneration = 0;

  constructor(private readonly options: EngineOptions = {}) {
    super();
    validatePositiveTimeout(options.startupTimeoutMs, "startupTimeoutMs");
    validatePositiveTimeout(options.shutdownTimeoutMs, "shutdownTimeoutMs");
    if (options.maxFrameBytes !== undefined && (
      !Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1 ||
      options.maxFrameBytes > DEFAULT_MAX_ENGINE_FRAME_BYTES
    )) {
      throw new RangeError(
        `maxFrameBytes must be an integer in 1..${DEFAULT_MAX_ENGINE_FRAME_BYTES}`,
      );
    }
    this.trace = new PerformanceTrace({ ...process.env, ...options.environment });
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

  async analyze(
    cells: readonly CellSnapshot[],
    revision: number,
  ): Promise<AnalysisResult> {
    await this.ensureStarted();
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
      cells: wireCells,
    });
    if (raw.ok !== true) throw requestError(raw, "analysis failed");
    return analysisResultSchema.parse(mapAnalysisResult(raw));
  }

  async evaluate(
    payload: EvaluationPayload,
    onEvent?: (event: EngineEvent) => void,
    signal?: AbortSignal,
  ): Promise<EngineResponse> {
    await this.ensureStarted();
    const value = evaluationPayloadSchema.parse(payload);
    if (this.evaluations.size + this.pendingKernelRequests >= MAX_PENDING_REQUESTS) {
      throw new EngineTransportError("engine request queue is full", "kernel");
    }
    const requestId = this.nextRequestId();
    const wire = evaluationWire(value);
    const state = makeEvaluation(requestId, value, onEvent);
    this.evaluations.set(requestId, state);
    const traceSpan = this.trace.begin("host.engine.request", requestTraceFields(
      "kernel", "eval_cell", { req: requestId, ...wire },
    ));
    try {
      const encoded = encodeArkRequest({ request: requestId, ...wire }, this.maxArkPayloadBytes());
      const execution = await this.kernel!.execute(arkCall("evaluate", encoded), {
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
      if (state.deferredArtifactReleases.size > 0) {
        const artifacts = [...state.deferredArtifactReleases];
        state.deferredArtifactReleases.clear();
        void this.releaseOutputs({ artifacts }).catch(() => {});
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
          ok: false, cancelledBeforeStart: true,
          error: { code: "interrupted", message: "Cancelled before execution", interrupted: true },
        };
        this.trace.end(traceSpan, { outcome: "cancelled-before-start" });
        return response;
      }
      await state.messageTail;
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
      await this.ensureStarted();
      if (batch.cancelled) return responses;
      if (this.evaluations.size + this.pendingKernelRequests >= MAX_PENDING_REQUESTS) {
        throw new EngineTransportError("engine request queue is full", "kernel");
      }
      requestId = this.nextRequestId();
      traceSpan = this.trace.begin("host.engine.request", {
        role: "kernel", cmd: "eval_batch", req: requestId, cells: values.length,
        session_epoch: values[0]!.sessionEpoch,
        operation_id: values[0]!.operationId, run_id: values[0]!.runId,
      });
      batch.permit = join(this.paths!.cacheDirectory, `.alder-batch-${randomUUID()}`);
      writeFileSync(batch.permit, "", { flag: "wx", mode: 0o600 });
      batch.states = values.map((value) => ({ ...makeEvaluation(requestId!, value, (event) => {
        callbacks = callbacks.then(() => onEvent?.(event));
      }), batch }));
      this.evaluations.set(requestId, batch.states[0]!);
      const code = values.map((value, offset) => arkCall("evaluate", encodeArkRequest({
        request: requestId, ...evaluationWire(value),
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
            const event = decodeArkEvent(message, this.arkEventToken, this.maxArkPayloadBytes());
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
              if (message.header.msg_type === "execute_input" || ended) return;
              throw new FrameProtocolError("batch output arrived before its first cell");
            }
            if (ended && state.finished) return;
            if (event === undefined) await this.processEvaluationMessage(state, message);
            else await this.applyArkEvent(state, event);
            await callbacks;
            if (state.messageError !== undefined) throw state.messageError;
            // Nonfinal markers originate in the next native expression. The
            // final cell still waits for execute_reply + IOPub idle below.
            if (event?.type === "finished" && index < values.length - 1) {
              await complete(state, successfulExecution(message));
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
      }, { storeHistory: true });
      await tail;
      if (messageError !== undefined) throw messageError;
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
          void this.releaseOutputs({ artifacts: [...state.deferredArtifactReleases] }).catch(() => {});
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
  ): Promise<EngineResponse> {
    await this.ensureStarted();
    if (!KERNEL_COMMANDS.has(command)) {
      throw new TypeError(`unsupported kernel command: ${command}`);
    }
    if (command === "release_outputs") return this.releaseOutputs(payload);
    return engineResponseSchema.parse(await this.runArkCommand(command, payload));
  }

  async service(
    command: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.ensureStarted();
    if (!SERVICE_COMMANDS.has(command)) {
      throw new TypeError(`unsupported Alder host service: ${command}`);
    }
    const raw = await this.sendRRequest("service", "service", { command, payload });
    if (raw.ok !== true) throw requestError(raw, `Alder host service ${command} failed`);
    if (!("result" in raw)) {
      throw new EngineTransportError("service response omitted its result", "service");
    }
    return raw.result;
  }

  async interrupt(
    requestId?: number,
  ): Promise<{ requested: boolean; requestId?: number }> {
    await this.ensureStarted();
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

  async restart(): Promise<EngineHandshake> {
    if (this.isClosed()) throw new EngineTransportError("engine is closed");
    if (this.restartPromise !== undefined) return this.restartPromise;
    this.state = "restarting";
    this.startupAbort?.abort();
    const immediateStop = this.stopPeers("Engine restarted");
    void immediateStop.catch(() => {});
    const operation = this.enqueueLifecycle(async () => {
      if (this.isClosed()) throw new EngineTransportError("engine is closed");
      try {
        await immediateStop;
        await this.stopPeers("Engine restarted");
        if (this.isClosed()) throw new EngineTransportError("engine is closed");
        this.state = "new";
        this.handshake = undefined;
        return await this.startLocked();
      } catch (error) {
        if (!this.isClosed()) this.state = "degraded";
        throw error;
      }
    });
    this.restartPromise = operation;
    void operation.finally(() => {
      if (this.restartPromise === operation) this.restartPromise = undefined;
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
      for (const directory of this.paths?.ownedDirectories ?? []) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
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
    if (this.state === "restarting") {
      throw new EngineTransportError("engine start was superseded by restart");
    }
    if (this.state === "ready" && this.handshake !== undefined &&
        this.kernel?.ready && this.analyzer?.ready) {
      return this.handshake;
    }
    if (this.state === "degraded") await this.stopPeers("Engine recovering");
    if (this.isClosed()) throw new EngineTransportError("engine is closed");
    this.state = "starting";
    return this.startFresh();
  }

  private async startFresh(): Promise<EngineHandshake> {
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    try {
      this.paths ??= await resolvePaths(this.options, startupAbort.signal);
      if (startupAbort.signal.aborted || this.isClosed()) {
        throw new EngineTransportError("engine startup was cancelled");
      }
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 45_000;
      const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_ENGINE_FRAME_BYTES;
      this.arkEventToken = randomBytes(24).toString("base64url");
      const paths = this.paths;
      const runtime = await prepareRuntime(paths);
      if (startupAbort.signal.aborted || this.isClosed()) {
        for (const directory of runtime.ownedDirectories) {
          await rm(directory, { recursive: true, force: true }).catch(() => {});
        }
        throw new EngineTransportError("engine startup was cancelled");
      }
      this.runtime = runtime;
      const generation = ++this.peerGeneration;
      this.kernel = new ArkKernel({
        executable: paths.arkExecutable,
        startupFile: paths.arkStartupScript,
        connectionDirectory: join(paths.cacheDirectory, "ark-connections"),
        cwd: paths.notebookDirectory,
        environment: {
          ...paths.arkEnvironment,
          ALDER_ARK_KERNEL: "1",
          ALDER_ARK_EVENT_TOKEN: this.arkEventToken,
          ALDER_CAPTURE_DIR: this.runtime.captureDirectory,
        },
        startupTimeoutMs,
        shutdownTimeoutMs: this.options.shutdownTimeoutMs ?? 1_000,
        maxMessageBytes: Math.ceil(maxFrameBytes * 4 / 3) + 65_536,
      });
      this.kernel.on("failed", (error: Error) => this.kernelFailed(generation, error));
      this.analyzer = this.makeRPeer("analyzer", startupTimeoutMs, maxFrameBytes, generation);
      this.servicePeer = this.makeRPeer("service", startupTimeoutMs, maxFrameBytes, generation);
      const [kernel, analyzer, service] = await Promise.all([
        this.kernel.start(),
        this.analyzer.start(),
        this.servicePeer.start(),
      ]);
      if (this.isClosed()) {
        throw new EngineTransportError("engine was closed during startup");
      }
      const ping = await this.runArkCommand("ping", {}, false);
      if (ping.ok !== true || ping.package_version !== analyzer.packageVersion ||
          ping.r_version !== analyzer.rVersion ||
          service.packageVersion !== analyzer.packageVersion ||
          service.rVersion !== analyzer.rVersion ||
          this.servicePeer?.ready !== true ||
          !kernel.languageVersion.includes(analyzer.rVersion)) {
        throw new EngineTransportError(
          "kernel, analyzer, and service identities do not match",
        );
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
        ...service.capabilities,
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
        },
      });
      if (this.isClosed()) {
        throw new EngineTransportError("engine was closed during startup");
      }
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

  private makeRPeer(
    role: RPeerRole,
    startupTimeoutMs: number,
    maxFrameBytes: number,
    generation: number,
  ): RPeer {
    const paths = this.paths!;
    return new RPeer(
      role,
      this.options.rscript ?? process.env.ALDER_RSCRIPT ?? "Rscript",
      paths.analyzerScript,
      paths.notebookDirectory,
      { ...paths.analyzerEnvironment, ALDER_HOST_ROLE: role },
      maxFrameBytes,
      startupTimeoutMs,
      (peerRole, frame) => this.handleRFrame(peerRole, frame),
      (peerRole, error, intentional) => {
        if (generation === this.peerGeneration) {
          this.peerFailed(peerRole, error, intentional);
        }
      },
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.state === "closed") throw new EngineTransportError("engine is closed");
    if (this.restartPromise !== undefined) await this.restartPromise;
    if (this.state !== "ready") await this.start();
    if (this.state !== "ready") throw new EngineTransportError("engine is unavailable");
  }

  private sendRRequest(
    role: RPeerRole,
    command: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const peer = role === "analyzer" ? this.analyzer : this.servicePeer;
    if (peer?.ready !== true) {
      return Promise.reject(new EngineTransportError(`${role} is unavailable`, role));
    }
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

  private handleRFrame(role: RPeerRole, input: unknown): void {
    const frame = asRecord(input, "engine response");
    const requestId = positiveSafeInteger(frame.req, "response req");
    const pending = this.rPending.get(requestId);
    if (pending === undefined) {
      throw new FrameProtocolError("response does not identify a pending request");
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
    if (role === "service") {
      if (!intentional && this.state !== "closed") {
        this.emit("failure", "services", error);
      }
      return;
    }
    if (this.state !== "closed") this.state = "degraded";
    if (!intentional && this.state !== "closed") {
      this.emit("failure", role, error);
    }
  }

  private rejectPending(role: PeerRole, error: Error): void {
    if (role === "analyzer" || role === "service") {
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
    const service = this.servicePeer;
    const runtime = this.runtime;
    this.peerGeneration += 1;
    analyzer?.expectExit();
    service?.expectExit();
    this.rejectPending("kernel", new EngineTransportError(reason, "kernel"));
    this.rejectPending("analyzer", new EngineTransportError(reason, "analyzer"));
    this.rejectPending("service", new EngineTransportError(reason, "service"));
    const timeout = this.options.shutdownTimeoutMs ?? 1_000;
    try {
      await Promise.all([
        kernel?.terminate(),
        analyzer?.terminate(timeout),
        service?.terminate(timeout),
      ]);
    } finally {
      for (const directory of runtime?.ownedDirectories ?? []) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      if (this.runtime === runtime) this.runtime = undefined;
      if (this.kernel === kernel) this.kernel = undefined;
      if (this.analyzer === analyzer) this.analyzer = undefined;
      if (this.servicePeer === service) this.servicePeer = undefined;
    }
  }

  private nextRequestId(): number {
    if (this.requestCounter > Number.MAX_SAFE_INTEGER) this.requestCounter = 1;
    while (this.rPending.has(this.requestCounter) ||
           this.evaluations.has(this.requestCounter)) this.requestCounter += 1;
    return this.requestCounter++;
  }

  private startEvaluation(state: ActiveEvaluation): void {
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
    const type = message.header.msg_type;
    if (type === "stream") {
      const text = message.content.text;
      if (typeof text !== "string") throw new FrameProtocolError("Ark stream text is invalid");
      await this.applyPendingClear(state);
      this.appendLog(state, text);
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
    if (type !== "execute_result" && type !== "display_data" &&
        type !== "update_display_data") return;
    const event = decodeArkEvent(message, this.arkEventToken, this.maxArkPayloadBytes());
    if (event !== undefined) {
      await this.applyArkEvent(state, event);
      return;
    }
    await this.applyPendingClear(state);
    const native = await this.nativeOutput(message);
    if (native === undefined) return;
    let output = { ...asRecord(native, "native output"), log_offset: state.console.characters };
    const transient = optionalRecord(message.content.transient);
    const displayId = typeof transient?.display_id === "string"
      ? transient.display_id
      : undefined;
    if (type === "update_display_data" && displayId !== undefined) {
      const index = state.displayOutputs.get(displayId);
      if (index !== undefined) {
        output = { ...output, log_offset: Number(asRecord(state.outputs[index], "display output").log_offset) };
        const oldBytes = jsonByteSize(state.outputs[index]);
        const newBytes = jsonByteSize(output);
        if (state.outputBytes - oldBytes + newBytes <= this.maxOutputBytes()) {
          await this.discardNativeOutput(state.outputs[index]);
          state.outputs[index] = output;
          state.outputBytes = state.outputBytes - oldBytes + newBytes;
        } else {
          state.truncated = true;
          await this.discardNativeOutput(output);
        }
        return;
      }
    }
    const index = this.addEvaluationOutput(state, output);
    if (index === undefined) {
      await this.discardNativeOutput(output);
      return;
    }
    if (displayId !== undefined) state.displayOutputs.set(displayId, index);
  }

  private async applyArkEvent(
    state: ActiveEvaluation,
    input: Record<string, unknown>,
  ): Promise<void> {
    const type = input.type;
    if (type === "started") {
      this.startEvaluation(state);
      return;
    }
    if (type === "append" || type === "progress" || type === "log") {
      await this.applyPendingClear(state);
      const sequence = positiveSafeInteger(input.sequence, "Alder Ark output sequence");
      if (sequence <= state.rSequence) {
        throw new FrameProtocolError("Alder Ark output sequence is not monotonic");
      }
      state.rSequence = sequence;
      validateOutputPayload(type, input.payload);
      let eventPayload = input.payload;
      if (type === "append") {
        const payload = asRecord(input.payload, "append output payload");
        const output = { ...asRecord(payload.output, "append output"), log_offset: state.console.characters };
        if (this.addEvaluationOutput(state, output) === undefined) {
          await this.discardDuringEvaluation(state, [output]);
          return;
        }
        eventPayload = { ...payload, output };
      }
      if (type === "log") {
        const payload = asRecord(input.payload, "log output payload");
        const lines = payload.lines;
        this.appendLog(state, (Array.isArray(lines) ? lines.join("\n") : String(lines)) + "\n");
        return;
      }
      this.emitEvaluationEvent(state, {
        type: "output",
        sequence: ++state.sequence,
        kind: type,
        payload: eventPayload,
      });
      return;
    }
    if (type === "result") {
      await this.applyPendingClear(state);
      if (!("output" in input)) throw new FrameProtocolError("Alder result omitted output");
      const output = {
        ...asRecord(input.output, "result output"), log_offset: state.console.characters,
      };
      if (this.addEvaluationOutput(state, output) === undefined) {
        await this.discardDuringEvaluation(state, [output]);
      }
      return;
    }
    if (type === "condition") {
      state.structuredError = engineErrorSchema.parse(input.error);
      return;
    }
    if (type === "finished") {
      if (!state.started || state.finished) {
        throw new FrameProtocolError("invalid Alder evaluation completion marker");
      }
      state.finished = true;
      return;
    }
    if (type === "cell_meta") {
      if (input.stopped !== true) throw new FrameProtocolError("invalid Alder cell metadata");
      state.stopped = true;
      return;
    }
    if (type === "command_result") {
      throw new FrameProtocolError("command result appeared during cell evaluation");
    }
    throw new FrameProtocolError("unknown Alder Ark event type");
  }

  private appendLog(state: ActiveEvaluation, text: string): void {
    const delta = state.console.append(text);
    state.log = state.console.lines;
    state.truncated ||= state.console.truncated;
    if (delta === undefined) return;
    this.emitEvaluationEvent(state, {
      type: "output",
      sequence: ++state.sequence,
      kind: "log",
      payload: delta,
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
      payload: delta,
    });
  }

  private addEvaluationOutput(state: ActiveEvaluation, output: unknown): number | undefined {
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
    state.displayOutputs.clear();
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
    return engineResponseSchema.parse(error === undefined
      ? {
          ok: true,
          outputs: state.outputs,
          stopped: state.stopped,
          log: state.log,
          truncated: state.truncated,
        }
      : {
          ok: false,
          outputs: [],
          stopped: false,
          log: state.log,
          truncated: state.truncated,
          error,
        });
  }

  private emitEvaluationEvent(
    state: ActiveEvaluation,
    event: Record<string, unknown>,
  ): void {
    const parsed = engineEventSchema.parse({
      ...event,
      requestId: state.requestId,
      sessionEpoch: state.payload.sessionEpoch,
      operationId: state.payload.operationId,
      runId: state.payload.runId,
      cellId: state.payload.cellId,
      revision: state.payload.revision,
    });
    state.onEvent?.(parsed);
  }

  private async nativeOutput(message: JupyterMessage): Promise<unknown | undefined> {
    const data = asRecord(message.content.data, "Ark display data");
    if (typeof data["image/png"] === "string") {
      const bytes = decodeBase64(data["image/png"], this.maxArkPayloadBytes());
      return { kind: "image", artifact: await this.writeNativeArtifact(bytes, ".png") };
    }
    if (typeof data["image/svg+xml"] === "string") {
      return {
        kind: "image",
        artifact: await this.writeNativeArtifact(data["image/svg+xml"], ".svg"),
      };
    }
    if (typeof data["text/html"] === "string") {
      return {
        kind: "html",
        artifact: await this.writeNativeArtifact(data["text/html"], ".html"),
      };
    }
    if (typeof data["text/plain"] === "string") {
      return { kind: "text", text: data["text/plain"] };
    }
    return undefined;
  }

  private async writeNativeArtifact(
    content: string | Buffer,
    extension: ".png" | ".svg" | ".html",
  ): Promise<string> {
    const name = `ark-${randomUUID()}${extension}`;
    await writeFile(join(this.paths!.artifactDirectory, name), content, {
      flag: "wx",
      mode: 0o600,
    });
    this.nativeArtifacts.add(name);
    return name;
  }

  private async discardNativeOutput(output: unknown): Promise<void> {
    const record = optionalRecord(output);
    const artifact = record?.artifact;
    if (typeof artifact !== "string" || !this.nativeArtifacts.has(artifact)) return;
    await rm(join(this.paths!.artifactDirectory, artifact), { force: true }).catch(() => {});
    this.nativeArtifacts.delete(artifact);
  }

  private async discardEvaluationOutputs(outputs: readonly unknown[]): Promise<void> {
    const artifacts = [...collectArtifactHandles(outputs)];
    if (artifacts.length === 0) return;
    await this.discardArtifactFiles(artifacts);
    void this.releaseOutputs({ artifacts }).catch(() => {});
  }

  private async discardDuringEvaluation(
    state: ActiveEvaluation,
    outputs: readonly unknown[],
  ): Promise<void> {
    const artifacts = [...collectArtifactHandles(outputs)];
    if (artifacts.length === 0) return;
    for (const artifact of artifacts) state.deferredArtifactReleases.add(artifact);
    await this.discardArtifactFiles(artifacts);
  }

  private async discardArtifactFiles(artifacts: readonly string[]): Promise<void> {
    const directory = this.paths?.artifactDirectory;
    if (directory === undefined) return;
    await Promise.all(artifacts.map(async (artifact) => {
      if (!artifactHandle(artifact)) return;
      await rm(join(directory, artifact), { force: true }).catch(() => {});
      this.nativeArtifacts.delete(artifact);
    }));
  }

  private async runArkCommand(
    command: string,
    payload: Record<string, unknown>,
    trace = true,
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
    try {
      const encoded = encodeArkRequest({ request: marker, command, payload }, this.maxArkPayloadBytes());
      const execution = await kernel.execute(arkCall("request", encoded), {
        onMessage: (message) => {
          messageTail = messageTail.then(() => {
            const event = decodeArkEvent(message, this.arkEventToken, this.maxArkPayloadBytes());
            if (event === undefined) return;
            if (event.type !== "command_result" || event.request !== marker ||
                result !== undefined) {
              throw new FrameProtocolError("invalid Alder Ark command result");
            }
            result = asRecord(event.response, "Alder Ark command response");
          }).catch((error) => { messageError ??= asError(error); });
        },
      }, { storeHistory: false, auxiliary: command === "env_snapshot" });
      await messageTail;
      if (messageError !== undefined) throw messageError;
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

  private async releaseOutputs(payload: Record<string, unknown>): Promise<EngineResponse> {
    const values = payload.artifacts;
    if (!Array.isArray(values) || values.length > MAX_OUTPUT_RECORDS ||
        values.some((value) => !artifactHandle(value)) ||
        new Set(values).size !== values.length) {
      return engineResponseSchema.parse(await this.runArkCommand("release_outputs", payload));
    }
    const native = values.filter((value): value is string =>
      typeof value === "string" && this.nativeArtifacts.has(value));
    const worker = values.filter((value) => !native.includes(value as string));
    const released: string[] = [];
    const failed: string[] = [];
    for (const artifact of native) {
      try {
        await rm(join(this.paths!.artifactDirectory, artifact), { force: true });
        this.nativeArtifacts.delete(artifact);
        released.push(artifact);
      } catch {
        failed.push(artifact);
      }
    }
    const response = worker.length === 0
      ? { ok: true, released: [], missing: [], failed: [] }
      : await this.runArkCommand("release_outputs", { artifacts: worker });
    const workerReleased = stringArray(response.released);
    const missing = stringArray(response.missing);
    const workerFailed = stringArray(response.failed);
    const allFailed = [...failed, ...workerFailed];
    return engineResponseSchema.parse({
      ...response,
      ok: response.ok === true && allFailed.length === 0,
      released: [...released, ...workerReleased],
      missing,
      failed: allFailed,
      ...(allFailed.length > 0 ? { error: {
        code: "artifact_release_failed",
        message: "one or more output artifacts could not be released",
      } } : {}),
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
      (role === "analyzer" && readiness.analysis !== true) ||
      (role === "service" && readiness.services !== true)) {
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
    if (typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean" || value === null) {
      fields[name] = value;
    }
  }
  if (command === "service" && typeof wire.command === "string") {
    fields.service = wire.command;
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

function mapAnalysisResult(raw: Record<string, unknown>): unknown {
  if (!Array.isArray(raw.cells)) throw new FrameProtocolError("analysis cells are missing");
  const analyzer = asRecord(raw.analyzer, "analyzer identity");
  return {
    revision: raw.revision,
    cells: raw.cells.map((input) => {
      const cell = asRecord(input, "analysis cell");
      return {
        id: cell.id,
        revision: cell.revision,
        defs: cell.defs,
        refs: cell.refs,
        selfRefs: cell.self_refs,
        locals: cell.locals,
        barrier: cell.barrier,
        opaque: cell.opaque,
        diagnostics: cell.diagnostics,
        error: cell.error ?? null,
      };
    }),
    analyzer: {
      packageVersion: analyzer.package_version,
      rVersion: analyzer.r_version,
      policy: analyzer.policy,
    },
  };
}

function assertAnalyzerIdentity(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  for (const field of ["revision"] as const) {
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
    if (progress.kind !== "progress") throw new FrameProtocolError("invalid progress output");
  } else {
    const lines = payload.lines;
    if (!(typeof lines === "string" ||
          (Array.isArray(lines) && lines.every((line) => typeof line === "string")))) {
      throw new FrameProtocolError("invalid log output");
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function arkCall(method: "evaluate" | "request", encoded: string): string {
  return `get("RUNTIME", envir=asNamespace("alder"), inherits=FALSE)$ark_${method}("${encoded}")`;
}

function evaluationWire(value: EvaluationPayload): Record<string, unknown> {
  return {
    id: value.cellId, revision: value.revision, run_id: value.runId,
    session_epoch: value.sessionEpoch, operation_id: value.operationId,
    code_base64: encodeSource(value.source, "evaluation source").base64,
    defs: value.definitions, locals: value.locals, opaque: value.opaque,
  };
}

function makeEvaluation(
  requestId: number, payload: EvaluationPayload, onEvent?: (event: EngineEvent) => void,
): ActiveEvaluation {
  return {
    requestId, payload, onEvent, started: false, sequence: 0, rSequence: 0,
    outputs: [], outputBytes: 0, displayOutputs: new Map(), log: [],
    console: new OutputLog(MAX_LOG_BYTES), truncated: false, stopped: false,
    finished: false, kernelTerminal: false, interruptSent: false, clearPending: false,
    deferredArtifactReleases: new Set(), messageTail: Promise.resolve(),
  };
}

function successfulExecution(message: JupyterMessage): ArkExecution {
  return { id: message.parentHeader.msg_id ?? message.header.msg_id,
    reply: { ...message, content: { status: "ok" } }, messages: [] };
}

function encodeArkRequest(value: unknown, maxBytes: number): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`Ark request is not JSON serializable: ${asError(error).message}`);
  }
  const bytes = Buffer.from(text, "utf8");
  const encoded = bytes.toString("base64");
  if (encoded.length > maxBytes) {
    throw new FrameProtocolError("Alder Ark request exceeds the configured byte limit");
  }
  return encoded;
}

function decodeArkEvent(
  message: JupyterMessage,
  token: string,
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (message.header.msg_type !== "display_data" &&
      message.header.msg_type !== "update_display_data") return undefined;
  const data = optionalRecord(message.content.data);
  const html = data?.["text/html"];
  if (typeof html !== "string") return undefined;
  const prefix = `${ARK_EVENT_PREFIX}${token}:`;
  if (!html.startsWith(prefix)) return undefined;
  if (!html.endsWith("-->") || html.indexOf(prefix, prefix.length) >= 0) {
    throw new FrameProtocolError("invalid Alder Ark event envelope");
  }
  const encoded = html.slice(prefix.length, -3);
  const bytes = decodeBase64(encoded, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FrameProtocolError("Alder Ark event is not valid UTF-8");
  }
  try {
    return asRecord(parseStrictJson(text), "Alder Ark event");
  } catch (error) {
    throw new FrameProtocolError(`invalid Alder Ark event: ${asError(error).message}`);
  }
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
  const interrupted = /interrupt/i.test(`${name} ${value}`);
  return {
    message: interrupted ? "Interrupted" : value,
    code: interrupted ? "interrupted" : "evaluation_error",
    interrupted,
    ...(Array.isArray(content.traceback) ? { traceback: content.traceback.filter(
      (line): line is string => typeof line === "string",
    ).slice(-40) } : {}),
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

function collectArtifactHandles(
  value: unknown,
  result: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactHandles(entry, result);
    return result;
  }
  const record = optionalRecord(value);
  if (record === undefined) return result;
  if (artifactHandle(record.artifact)) result.add(record.artifact);
  for (const entry of Object.values(record)) collectArtifactHandles(entry, result);
  return result;
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

function encodeSource(value: string, label: string): { base64: string; bytes: number } {
  if (value.includes("\0")) throw new TypeError(`${label} contains NUL`);
  const source = Buffer.from(value, "utf8");
  if (source.toString("utf8") !== value) {
    throw new TypeError(`${label} is not valid Unicode`);
  }
  if (source.length > MAX_NOTEBOOK_SOURCE_BYTES) {
    throw new TypeError(`${label} exceeds the 32 MiB notebook limit`);
  }
  return { base64: source.toString("base64"), bytes: source.length };
}

async function prepareRuntime(paths: ResolvedPaths): Promise<RuntimePaths> {
  const captureDirectory = await mkdtemp(join(paths.artifactDirectory, ".alder-capture-"));
  return { captureDirectory, ownedDirectories: [captureDirectory] };
}

async function resolvePaths(
  options: EngineOptions,
  signal?: AbortSignal,
): Promise<ResolvedPaths> {
  throwIfAborted(signal);
  const configured = options.packagePath ?? process.env.ALDER_R_PACKAGE;
  const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const packagePath = await findPackagePath(configured ?? repository);
  const workerDirectory = await findWorkerDirectory(packagePath);
  const arkStartupScript = resolve(
    options.arkStartupScript ?? join(workerDirectory, "host-ark.R"),
  );
  const analyzerScript = resolve(options.analyzerScript ?? join(workerDirectory, "host-analyzer.R"));
  const framingScript = resolve(join(workerDirectory, "host-framing.R"));
  const arkExecutable = await findArkExecutable(options, packagePath);
  await Promise.all([
    requireFile(arkExecutable, "Ark executable"),
    requireFile(arkStartupScript, "Ark startup script"),
    requireFile(analyzerScript, "analyzer script"),
    requireFile(framingScript, "framing script"),
  ]);

  const notebookDirectory = resolve(options.notebookDirectory ?? process.cwd());
  const notebookInfo = await stat(notebookDirectory);
  if (!notebookInfo.isDirectory()) throw new Error("notebookDirectory is not a directory");

  const selectionBaseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.environment,
    ALDER_NOTEBOOK_DIR: notebookDirectory,
  };
  delete selectionBaseEnvironment.ALDER_ARTIFACT_DIR;
  delete selectionBaseEnvironment.ALDER_CACHE_DIR;
  delete selectionBaseEnvironment.ALDER_CAPTURE_DIR;
  const installed = await isFile(join(packagePath, "Meta", "package.rds"));
  if (installed) {
    selectionBaseEnvironment.R_LIBS = prependPath(
      dirname(packagePath),
      selectionBaseEnvironment.R_LIBS,
    );
  }
  const selectedRscript = options.rscript ?? process.env.ALDER_RSCRIPT ?? "Rscript";
  // The selected executable owns the R installation. An inherited R_HOME can
  // otherwise silently redirect both that executable and Ark to another R.
  const selectionEnvironment = { ...selectionBaseEnvironment };
  delete selectionEnvironment.R_HOME;
  throwIfAborted(signal);
  const rHome = await discoverRHome(selectedRscript, selectionEnvironment, signal);
  let rHomeInfo;
  try { rHomeInfo = await stat(rHome); }
  catch { throw new Error(`selected R reported an invalid R_HOME: ${rHome}`); }
  if (!rHomeInfo.isDirectory()) {
    throw new Error(`selected R reported an invalid R_HOME: ${rHome}`);
  }

  const ownedDirectories: string[] = [];
  let artifactDirectory: string;
  let cacheDirectory: string;
  try {
    throwIfAborted(signal);
    artifactDirectory = options.artifactDirectory === undefined
      ? await mkdtemp(join(tmpdir(), "alder-engine-artifacts-"))
      : resolve(options.artifactDirectory);
    if (options.artifactDirectory === undefined) ownedDirectories.push(artifactDirectory);
    else await mkdir(artifactDirectory, { recursive: true });
    throwIfAborted(signal);
    cacheDirectory = options.cacheDirectory === undefined
      ? await mkdtemp(join(tmpdir(), "alder-engine-cache-"))
      : resolve(options.cacheDirectory);
    if (options.cacheDirectory === undefined) ownedDirectories.push(cacheDirectory);
    else await mkdir(cacheDirectory, { recursive: true });
  } catch (error) {
    for (const directory of ownedDirectories) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  const baseEnvironment: NodeJS.ProcessEnv = {
    ...selectionBaseEnvironment,
    ALDER_ARTIFACT_DIR: artifactDirectory,
    ALDER_CACHE_DIR: cacheDirectory,
    R_HOME: rHome,
  };
  const analyzerEnvironment = {
    ...baseEnvironment,
    ALDER_HOST_FRAMING: framingScript,
    ALDER_HOST_PROTOCOL: "framed-v1",
  };
  const arkEnvironment: NodeJS.ProcessEnv = { ...baseEnvironment, R_HOME: rHome };
  delete arkEnvironment.ALDER_HOST_FRAMING;
  delete arkEnvironment.ALDER_HOST_PROTOCOL;
  delete arkEnvironment.ALDER_HOST_ROLE;
  return {
    packagePath,
    arkExecutable,
    arkStartupScript,
    analyzerScript,
    framingScript,
    notebookDirectory,
    artifactDirectory,
    cacheDirectory,
    ownedDirectories,
    analyzerEnvironment,
    arkEnvironment,
  };
}

async function findArkExecutable(
  options: EngineOptions,
  packagePath: string,
): Promise<string> {
  const explicit = options.arkExecutable ?? options.environment?.ALDER_ARK ??
    process.env.ALDER_ARK;
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const executable = process.platform === "win32" ? "ark.exe" : "ark";
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "runtime", executable),
    join(moduleDirectory, "..", "runtime", executable),
    join(moduleDirectory, "..", ".runtime", executable),
    join(packagePath, "host", "runtime", executable),
    join(packagePath, "host", ".runtime", executable),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return resolve(candidate);
  }
  throw new Error(
    `Ark executable not found; set ALDER_ARK or stage runtime/${executable} beside the host`,
  );
}

async function discoverRHome(
  rscript: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  return new Promise<string>((resolveHome, rejectHome) => {
    const child = spawn(rscript, ["--vanilla", "--slave", "-e", "cat(R.home())"], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal,
      killSignal: "SIGKILL",
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectHome(new Error("selected R did not report R_HOME within 10 seconds"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > 65_536) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 65_536) stderr = stderr.subarray(-65_536);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectHome(new Error(`could not start selected R: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const value = stdout.toString("utf8").trim();
      if (code === 0 && value.length > 0) resolveHome(value);
      else rejectHome(new Error(
        `selected R could not report R_HOME${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`,
      ));
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineTransportError("engine startup was cancelled");
}

async function findPackagePath(configured: string): Promise<string> {
  const direct = resolve(configured);
  for (const candidate of [direct, join(direct, "alder")]) {
    if (await isFile(join(candidate, "DESCRIPTION"))) return candidate;
  }
  throw new Error(`Alder package was not found at ${direct}`);
}

async function findWorkerDirectory(packagePath: string): Promise<string> {
  for (const candidate of [
    join(packagePath, "worker"),
    join(packagePath, "inst", "worker"),
  ]) {
    if (await isFile(join(candidate, "host-framing.R"))) return candidate;
  }
  throw new Error(`Alder host worker files were not found under ${packagePath}`);
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
    if (!(await stat(path)).isFile()) throw new Error();
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function prependPath(path: string, current: string | undefined): string {
  return current === undefined || current.length === 0
    ? path
    : `${path}${process.platform === "win32" ? ";" : ":"}${current}`;
}

function validatePositiveTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function childRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
