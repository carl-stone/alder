import type { OwnedProcess, ProcessScope } from "./processes.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { TextDecoder } from "node:util";

import type {
  Dealer,
  Socket,
  Subscriber,
} from "zeromq";

import {
  DEFAULT_MAX_FRAME_BYTES,
  FrameProtocolError,
} from "./framing.js";
import { DEFAULT_STRICT_JSON_LIMITS, parseStrictJson } from "./strict-json.js";

const ARK_BUILD_VERSION = "0.1.252-alder.1" as const;
const ARK_VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_ARK_VERSION_OUTPUT_BYTES = 64 * 1024;

const MESSAGE_DELIMITER = Buffer.from("<IDS|MSG>");
const JUPYTER_VERSION = "5.3";
const MAX_PENDING_REQUESTS = 1_024;
type Channel = "shell" | "control" | "iopub" | "stdin" | "registration";
type ReceiveSocket = Pick<Socket, "close"> & {
  receive(): Promise<Buffer[]>;
};
type MultipartSocket = ReceiveSocket & {
  send(parts: (Buffer | string)[]): Promise<void>;
};

export interface JupyterHeader {
  msg_id: string;
  username: string;
  session: string;
  date: string;
  msg_type: string;
  version: string;
}

export interface JupyterMessage {
  identities: readonly Buffer[];
  header: JupyterHeader;
  parentHeader: Partial<JupyterHeader>;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  buffers: readonly Buffer[];
}

export interface ArkKernelInfo {
  implementation: string;
  implementationVersion: string;
  buildVersion: typeof ARK_BUILD_VERSION;
  languageVersion: string;
  protocolVersion: string;
  mimePublisher: "alder-json-v1";
}

export interface ArkExecution {
  id: string;
  reply: JupyterMessage;
  messages: readonly JupyterMessage[];
}

export interface ArkExecuteCallbacks {
  onStarted?: () => void;
  onMessage?: (message: JupyterMessage) => void;
  onSettled?: () => void | Promise<void>;
}

export interface ArkKernelOptions {
  executable: string;
  startupFile: string;
  connectionDirectory: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxMessageBytes?: number;
  processScope: ProcessScope;
}

interface ConnectionPorts {
  control_port: number;
  shell_port: number;
  stdin_port: number;
  iopub_port: number;
  hb_port: number;
}

interface PendingReply {
  expectedType: string;
  resolve: (message: JupyterMessage) => void;
  reject: (error: Error) => void;
}

interface PendingExecution extends PendingReply {
  messages: JupyterMessage[];
  retainedBytes: number;
  callbacks: ArkExecuteCallbacks;
  reply?: JupyterMessage;
  idle: boolean;
  started: boolean;
  callbackError?: Error;
  executionResolve: (value: ArkExecution) => void;
}

interface ZeroMqModule {
  Dealer: new (options?: Record<string, unknown>) => Dealer;
  Subscriber: new (options?: Record<string, unknown>) => Subscriber;
}

/**
 * Minimal Jupyter client for Ark. Ark owns R evaluation, condition/stream
 * capture, graphics, interruption and kernel lifecycle; this class only maps
 * the signed local Jupyter channels into bounded request promises.
 */
export class ArkKernel extends EventEmitter {
  private readonly maxMessageBytes: number;
  private readonly session = randomUUID();
  private readonly key = randomBytes(32).toString("hex");
  private child: OwnedProcess | undefined;
  private shell: Dealer | undefined;
  private control: Dealer | undefined;
  private iopub: Subscriber | undefined;
  private stdin: Dealer | undefined;
  private readonly shellPending = new Map<string, PendingReply>();
  private readonly controlPending = new Map<string, PendingReply>();
  private readonly executions = new Map<string, PendingExecution>();
  private executeTail: Promise<void> = Promise.resolve();
  private queuedExecutions = 0;
  private stopped = false;
  private intentionalExit = false;
  private stderr = Buffer.alloc(0);
  private connectionFile: string | undefined;
  private logFile: string | undefined;
  private welcomed = false;
  private failure: Error | undefined;
  private exitPromise: Promise<void> = Promise.resolve();
  private exitResolve: (() => void) | undefined;
  private terminationPromise: Promise<void> | undefined;
  private childSpawnPromise: Promise<OwnedProcess> | undefined;
  private startPromise: Promise<ArkKernelInfo> | undefined;
  private stopRequested = false;
  private childExited = false;
  private publisherReady = false;

  constructor(private readonly options: ArkKernelOptions) {
    super();
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxMessageBytes)
      || this.maxMessageBytes < 1
      || this.maxMessageBytes > 2_147_483_647) {
      throw new RangeError("maxMessageBytes must be an integer between 1 and 2147483647");
    }
    validateTimeout(options.startupTimeoutMs, "startupTimeoutMs");
    validateTimeout(options.shutdownTimeoutMs, "shutdownTimeoutMs");
    for (const [name, value] of [
      ["executable", options.executable],
      ["startupFile", options.startupFile],
      ["connectionDirectory", options.connectionDirectory],
      ["cwd", options.cwd],
    ] as const) {
      if (value.length === 0) throw new TypeError(`${name} must be non-empty`);
    }
  }

  get ready(): boolean {
    return !this.stopped && this.child !== undefined && !this.childExited &&
      this.shell !== undefined && this.control !== undefined && this.iopub !== undefined;
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }
  get publicMimePublisherReady(): boolean {
    return this.publisherReady;
  }
  start(): Promise<ArkKernelInfo> {
    if (this.stopRequested || this.stopped) {
      return Promise.reject(new Error("Ark kernel is closed"));
    }
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.child !== undefined) return Promise.reject(new Error("Ark kernel was already started"));
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<ArkKernelInfo> {
    try {
      await Promise.all([
        requireExecutable(this.options.executable),
        requireFile(this.options.startupFile, "Ark startup file"),
        requireDirectory(this.options.cwd, "Ark working directory"),
        mkdir(this.options.connectionDirectory, { recursive: true }),
      ]);
      this.assertStartAllowed();
      const buildVersion = await probeArkBuildVersion(this.options);

      let zmq: ZeroMqModule;
      try {
        // Keep the native module out of the single-file host bundle. Release
        // staging installs its closure beside the bundled host.
        const moduleName = "zeromq";
        zmq = await import(moduleName) as unknown as ZeroMqModule;
      } catch (error) {
        throw new Error(
          `Ark transport dependency zeromq@6.7.0 is unavailable: ${messageOf(error)}`,
        );
      }
      this.assertStartAllowed();

      const ports = await reserveConnectionPorts();
      this.assertStartAllowed();
      this.connectionFile = join(
        this.options.connectionDirectory,
        `ark-${process.pid}-${randomUUID()}.json`,
      );
      this.logFile = this.connectionFile + ".log";
      await writeFile(this.logFile, "", { mode: 0o600 });
      await writeFile(this.connectionFile, `${JSON.stringify({
        ...ports,
        transport: "tcp",
        signature_scheme: "hmac-sha256",
        ip: "127.0.0.1",
        key: this.key,
      })}\n`, { mode: 0o600 });
      await chmod(this.connectionFile, 0o600).catch(() => {});

      this.assertStartAllowed();
      await this.spawnArk();
      this.assertStartAllowed();
      await this.connect(zmq, ports);
      const infoMessage = await this.requestShell(
        "kernel_info_request",
        {},
        "kernel_info_reply",
        this.options.startupTimeoutMs,
      );
      const content = infoMessage.content;
      const implementation = requiredString(content.implementation, "kernel implementation");
      if (implementation.toLowerCase() !== "ark") {
        throw new FrameProtocolError(`expected Ark kernel, received ${implementation}`);
      }
      const info = {
        implementation,
        implementationVersion: requiredString(
          content.implementation_version,
          "kernel implementation version",
        ),
        buildVersion,
        languageVersion: requiredString(
          asRecord(content.language_info, "kernel language info").version,
          "R language version",
        ),
        protocolVersion: requiredString(content.protocol_version, "Jupyter protocol version"),
        mimePublisher: "alder-json-v1" as const,
      };
      this.assertStartAllowed();
      await this.probePublicPublisher();
      await this.initializeStartup();
      this.publisherReady = true;
      return info;
    } catch (error) {
      await this.terminate().catch(() => {});
      const detail = this.failure ?? asError(error);
      throw new Error(`${detail.message}${this.diagnosticText()}`);
    }
  }
  private async probePublicPublisher(): Promise<void> {
    this.assertStartAllowed();
    const nonce = randomUUID();
    const dataJson = JSON.stringify({
      "application/vnd.alder.probe+json": { nonce },
    });
    const code = 'get("ark_publish_mimebundle", envir=as.environment("tools:positron"), inherits=FALSE)' +
      '(' + JSON.stringify(dataJson) + ')';
    let matches = 0;
    const execution = await withTimeout(this.executeOnce(code, {
      onMessage: (message) => {
        if (message.header.msg_type !== "display_data" &&
            message.header.msg_type !== "update_display_data") return;
        const data = message.content.data;
        if (typeof data !== "object" || data === null || Array.isArray(data)) return;
        const probe = (data as Record<string, unknown>)["application/vnd.alder.probe+json"];
        if (probe === undefined) return;
        matches += 1;
        if (matches > 1) throw new FrameProtocolError("Ark publisher probe emitted duplicate replies");
        if (typeof probe !== "object" || probe === null || Array.isArray(probe) ||
            (probe as Record<string, unknown>).nonce !== nonce) {
          throw new FrameProtocolError("Ark publisher probe nonce does not match");
        }
      },
    }, { silent: false, storeHistory: false }), this.options.startupTimeoutMs,
    "Ark public MIME publisher probe");
    if (execution.reply.content.status !== "ok") {
      throw new FrameProtocolError("Ark public MIME publisher probe failed");
    }
    if (matches !== 1) {
      throw new FrameProtocolError("Ark public MIME publisher probe reply was missing");
    }
  }
  private async initializeStartup(): Promise<void> {
    this.assertStartAllowed();
    const source = "base::sys.source(" + JSON.stringify(this.options.startupFile) +
      ", envir=baseenv())";
    const execution = await withTimeout(
      this.execute(source, {}, { silent: true, storeHistory: false }),
      this.options.startupTimeoutMs,
      "Ark startup initialization",
    );
    if (execution.reply.content.status !== "ok") {
      throw new FrameProtocolError("Ark startup initialization failed");
    }
  }
  execute(
    code: string,
    callbacks: ArkExecuteCallbacks = {},
    options: { silent?: boolean; storeHistory?: boolean; auxiliary?: boolean; signal?: AbortSignal } = {},
  ): Promise<ArkExecution> {
    if (!this.ready || this.shell === undefined) {
      return Promise.reject(new Error("Ark kernel is unavailable"));
    }
    if (Buffer.byteLength(code, "utf8") > this.maxMessageBytes) {
      return Promise.reject(new FrameProtocolError("Ark execution source exceeds message limit"));
    }
    if (this.queuedExecutions >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Ark execution queue is full"));
    }
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    let cancelQueued: (() => void) | undefined;
    const cancelled = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
      cancelQueued = () => reject(signal.reason);
      signal.addEventListener("abort", cancelQueued, { once: true });
    });
    this.queuedExecutions += 1;
    const queued = this.executeTail.then(async () => {
      // Cancellation only revokes work that has not entered the native queue.
      // Once dispatched, interruption must follow the normal reply/idle contract.
      if (cancelQueued !== undefined) signal!.removeEventListener("abort", cancelQueued);
      signal?.throwIfAborted();
      // Auxiliary RPCs use the same serial tail, including channel setup and
      // settlement hooks. They must never bypass an in-flight notebook cell.
      // Auxiliary requests use the same serial tail and ordinary Jupyter
      // execute_request path; private comm targets are intentionally absent.
      return this.executeOnce(code, callbacks, options);

    });
    this.executeTail = queued.then(() => {}, () => {});
    const settled = queued.finally(() => {
      this.queuedExecutions -= 1;
      if (cancelQueued !== undefined) signal!.removeEventListener("abort", cancelQueued);
    });
    return cancelled === undefined ? settled : Promise.race([settled, cancelled]);
  }

  private async executeOnce(
    code: string, callbacks: ArkExecuteCallbacks,
    options: { silent?: boolean; storeHistory?: boolean },
  ): Promise<ArkExecution> {
    if (!this.ready || this.shell === undefined) throw new Error("Ark kernel is unavailable");
    const id = newMessageId();
    const result = new Promise<ArkExecution>((resolve, reject) => {
      const pending: PendingExecution = {
        expectedType: "execute_reply",
        messages: [],
        retainedBytes: 0,
        callbacks,
        idle: false,
        started: false,
        executionResolve: resolve,
        resolve: (reply) => {
          pending.reply = reply;
          this.finishExecution(id);
        },
        reject,
      };
      this.executions.set(id, pending);
      this.shellPending.set(id, pending);
    });
    // A native send can fail before this promise becomes the awaited branch.
    // Keep its rejection observed while preserving the result for callers.
    void result.catch(() => {});
    try {
      await sendMessage(
        this.shell,
        this.key,
        this.session,
        "execute_request",
        {
          code,
          silent: options.silent ?? false,
          store_history: options.storeHistory ?? !(options.silent ?? false),
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: false,
        },
        undefined,
        this.maxMessageBytes,
        id,
      );
      let execution: ArkExecution | undefined;
      let executionError: Error | undefined;
      try {
        execution = await result;
      } catch (error) {
        executionError = asError(error);
      }
      // A consumer callback error is deliberately reported only after the
      // matching shell reply and IOPub idle. Run the settlement hook on that
      // rejected path too, so callers can release request-scoped state before
      // the serial tail admits the next execution.
      let settlementError: Error | undefined;
      try {
        await callbacks.onSettled?.();
      } catch (error) {
        settlementError = asError(error);
      }
      if (executionError !== undefined) throw executionError;
      if (settlementError !== undefined) throw settlementError;
      return execution!;
    } catch (error) {
      const pending = this.executions.get(id);
      this.executions.delete(id);
      this.shellPending.delete(id);
      pending?.reject(asError(error));
      throw error;
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.ready) return false;
    const reply = await this.requestControl(
      "interrupt_request",
      {},
      "interrupt_reply",
      this.options.startupTimeoutMs,
    );
    return reply.content.status === "ok";
  }

  async terminate(): Promise<void> {
    this.stopRequested = true;
    this.terminationPromise ??= this.terminateOnce();
    return this.terminationPromise;
  }

  private async terminateOnce(): Promise<void> {
    if (this.stopped) {
      await this.finishProcessCleanup();
      return;
    }
    this.intentionalExit = true;
    // A process scope spawn can be suspended in native startup. Wait for the
    // ownership boundary to resolve before taking the child snapshot; taking
    // it first would memoize a successful termination while the eventual Ark
    // process remains unowned and alive.
    await this.childSpawnPromise?.catch(() => {});
    const child = this.child;
    if (child !== undefined && !this.childExited && this.control !== undefined) {
      await this.requestControl(
        "shutdown_request",
        { restart: false },
        "shutdown_reply",
        Math.min(this.options.shutdownTimeoutMs, 1_000),
        true,
      ).catch(() => {});
    }
    await this.waitForExit(this.options.shutdownTimeoutMs);
    if (child !== undefined && !this.childExited) {
      await child.terminate().catch(() => {});
      await this.waitForExit(Math.max(250, this.options.shutdownTimeoutMs));
    }
    const survived = child !== undefined && !this.childExited;
    this.stopped = true;
    this.closeSockets();
    this.rejectAll(new Error("Ark kernel closed"));
    await this.removeConnectionFile();
    if (survived) throw new Error("Ark kernel did not exit after supervisor termination");
  }

  private async finishProcessCleanup(): Promise<void> {
    const child = this.child;
    if (child !== undefined && !this.childExited) {
      await child.terminate().catch(() => {});
      await this.waitForExit(Math.max(250, this.options.shutdownTimeoutMs));
    }
    this.closeSockets();
    await this.removeConnectionFile();
  }

  private async removeConnectionFile(): Promise<void> {
    if (this.connectionFile !== undefined) {
      await rm(this.connectionFile, { force: true }).catch(() => {});
      this.connectionFile = undefined;
    }
    if (this.logFile !== undefined) {
      await rm(this.logFile, { force: true }).catch(() => {});
      this.logFile = undefined;
    }
  }

  private async spawnArk(): Promise<void> {
    const processScope = this.options.processScope;
    if (processScope === undefined) throw new Error("Ark process scope is required");
    const args = [
      "--connection_file", this.connectionFile!,
      "--log", this.logFile!,
      "--session-mode", "notebook",
      "--default-repos", "none",
      "--",
      "--interactive",
      "--no-environ",
      "--no-site-file",
      "--no-init-file",
      "--no-save",
      "--no-restore-data",
      "--quiet",
    ];
    this.exitPromise = new Promise((resolveExit) => {
      this.exitResolve = resolveExit;
    });
    const spawnPromise = processScope.spawn({
      executable: this.options.executable,
      args,
      cwd: this.options.cwd,
      environment: { ...this.options.environment, RUST_LOG: "off", RUST_LOG_STYLE: "never" },
      stdio: "pipes",
    });
    this.childSpawnPromise = spawnPromise;
    try {
      const child = await spawnPromise;
      this.child = child;
      this.childExited = false;
      child.stdout?.on("data", (chunk: Buffer) => this.recordDiagnostic(chunk));
      child.stderr?.on("data", (chunk: Buffer) => this.recordDiagnostic(chunk));
      child.stdin?.on("error", (error) => this.fail(
        new Error("could not write to Ark: " + error.message + this.diagnosticText()),
      ));
      void child.exited.then(({ code, signal }) => {
        this.childExited = true;
        this.exitResolve?.();
        if (!this.stopped && !this.intentionalExit) {
          const reason = code === null ? "signal " + (signal ?? "unknown") : "exit status " + code;
          this.fail(new Error("Ark exited (" + reason + ")" + this.diagnosticText()));
        }
      }, (error) => {
        this.childExited = true;
        this.exitResolve?.();
        if (!this.stopped && !this.intentionalExit) this.fail(asError(error));
      });
      // terminate() may have won while processScope.spawn was pending. The
      // child must be terminated before startup returns it to the caller.
      if (this.stopRequested || this.stopped) {
        await child.terminate().catch(() => {});
        await child.exited.catch(() => {});
        throw new Error("Ark kernel is closed");
      }
    } finally {
      if (this.childSpawnPromise === spawnPromise) this.childSpawnPromise = undefined;
    }
  }

  private async connect(zmq: ZeroMqModule, ports: ConnectionPorts): Promise<void> {
    const routingId = randomUUID();
    const bounded = { maxMessageSize: this.maxMessageBytes, receiveHighWaterMark: 256 };
    this.control = new zmq.Dealer({ routingId, ...bounded });
    this.shell = new zmq.Dealer({ routingId, ...bounded });
    this.stdin = new zmq.Dealer({ routingId, ...bounded });
    this.iopub = new zmq.Subscriber(bounded);
    // An explicit empty prefix is interoperable with Ark's XPUB welcome
    // handshake across zeromq builds; it subscribes to every IOPub topic.
    this.iopub.subscribe("");
    this.control.connect(endpoint(ports.control_port));
    this.shell.connect(endpoint(ports.shell_port));
    this.stdin.connect(endpoint(ports.stdin_port));
    this.iopub.connect(endpoint(ports.iopub_port));

    void this.readLoop("shell", this.shell, (message) => this.receiveReply(
      this.shellPending,
      message,
      "shell",
    ));
    void this.readLoop("control", this.control, (message) => this.receiveReply(
      this.controlPending,
      message,
      "control",
    ));
    void this.readLoop("iopub", this.iopub, (message) => this.receiveIOPub(message));
    void this.readLoop("stdin", this.stdin, (message) => this.receiveStdin(message));

    await this.waitForWelcome();
  }

  private async waitForWelcome(): Promise<void> {
    if (this.welcomed) return;
    if (this.failure !== undefined) throw this.failure;
    await withTimeout(new Promise<void>((resolve, reject) => {
      const onWelcome = (): void => {
        cleanup();
        resolve();
      };
      const onFailure = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        this.off("welcome", onWelcome);
        this.off("failed", onFailure);
      };
      this.on("welcome", onWelcome);
      this.on("failed", onFailure);
    }), this.options.startupTimeoutMs, "Ark IOPub subscription");
  }

  private assertStartAllowed(): void {
    if (this.stopRequested || this.stopped) throw new Error("Ark kernel is closed");
  }

  private async readLoop(
    channel: Channel,
    socket: ReceiveSocket,
    receive: (message: JupyterMessage) => void,
  ): Promise<void> {
    try {
      while (!this.stopped) {
        const frames = await socket.receive();
        const message = decodeMessage(frames, this.key, this.maxMessageBytes);
        receive(message);
      }
    } catch (error) {
      if (!this.stopped) this.fail(new Error(
        `Ark ${channel} channel failed: ${messageOf(error)}`,
      ));
    }
  }

  private receiveReply(
    pendingMap: Map<string, PendingReply>,
    message: JupyterMessage,
    channel: Channel,
  ): void {
    const parentId = message.parentHeader.msg_id;
    if (typeof parentId !== "string") {
      throw new FrameProtocolError(`orphan reply on Ark ${channel} channel`);
    }
    const pending = pendingMap.get(parentId);
    if (pending === undefined) return;
    if (message.header.msg_type !== pending.expectedType) {
      pendingMap.delete(parentId);
      if (channel === "shell") this.executions.delete(parentId);
      pending.reject(new FrameProtocolError(
        `expected ${pending.expectedType}, received ${message.header.msg_type}`,
      ));
      return;
    }
    pendingMap.delete(parentId);
    pending.resolve(message);
  }

  private receiveIOPub(message: JupyterMessage): void {
    if (message.header.msg_type === "iopub_welcome") {
      this.welcomed = true;
      this.emit("welcome");
      return;
    }
    const parentId = message.parentHeader.msg_id;
    if (typeof parentId !== "string") {
      if (message.header.msg_type === "stream" && message.content.name === "stderr" &&
          typeof message.content.text === "string") {
        this.recordDiagnostic(Buffer.from(message.content.text, "utf8"));
      }
      return;
    }
    const pending = this.executions.get(parentId);
    if (pending === undefined) return;

    const type = message.header.msg_type;
    if (type === "status") {
      const state = message.content.execution_state;
      if (state === "busy" && !pending.started) {
        pending.started = true;
        try {
          pending.callbacks.onStarted?.();
        } catch (error) {
          pending.callbackError = asError(error);
        }
      } else if (state === "idle") {
        if (!pending.started) {
          pending.reject(new FrameProtocolError("Ark execution became idle before busy"));
          this.executions.delete(parentId);
          this.shellPending.delete(parentId);
          return;
        }
        pending.idle = true;
        this.finishExecution(parentId);
      } else if (state !== "busy") {
        pending.reject(new FrameProtocolError("Ark execution status is invalid"));
        this.executions.delete(parentId);
        this.shellPending.delete(parentId);
      }
      return;
    }
    const safeMessage = this.sanitizeMessage(message);
    const retainedBytes = messageSize(safeMessage);
    if (pending.retainedBytes + retainedBytes <= this.maxMessageBytes) {
      pending.messages.push(safeMessage);
      pending.retainedBytes += retainedBytes;
    }
    if (pending.callbackError === undefined) {
      try {
        pending.callbacks.onMessage?.(safeMessage);
      } catch (error) {
        pending.callbackError = asError(error);
      }
    }
  }
  private sanitizeMessage(message: JupyterMessage): JupyterMessage {
    const content: Record<string, unknown> = { ...message.content };
    for (const field of ["text", "evalue", "ename"] as const) {
      if (typeof content[field] === "string") content[field] = redactText(content[field] as string, [this.key]);
    }
    if (Array.isArray(content.traceback)) {
      content.traceback = content.traceback.map((line) =>
        typeof line === "string" ? redactText(line, [this.key]) : line);
    }
    return { ...message, content };
  }


  private receiveStdin(message: JupyterMessage): void {
    if (message.header.msg_type !== "input_request" || this.stdin === undefined) return;
    // Alder cells are deliberately non-interactive. Replying with an empty
    // value prevents a blocked kernel if a package ignores allow_stdin.
    void sendMessage(
      this.stdin,
      this.key,
      this.session,
      "input_reply",
      { value: "" },
      message.header,
      this.maxMessageBytes,
    ).catch((error) => this.fail(asError(error)));
  }

  private finishExecution(
    id: string,
  ): void {
    const pending = this.executions.get(id);
    if (pending?.reply === undefined || !pending.idle) return;
    this.executions.delete(id);
    this.shellPending.delete(id);
    if (pending.callbackError !== undefined) {
      pending.reject(pending.callbackError);
      return;
    }
    const execution = { id, reply: pending.reply, messages: pending.messages };
    pending.executionResolve(execution);
  }

  private requestShell(
    type: string,
    content: Record<string, unknown>,
    expectedType: string,
    timeoutMs: number,
  ): Promise<JupyterMessage> {
    return this.requestOn(this.shell, this.shellPending, type, content, expectedType, timeoutMs);
  }

  private requestControl(
    type: string,
    content: Record<string, unknown>,
    expectedType: string,
    timeoutMs: number,
    allowStopped = false,
  ): Promise<JupyterMessage> {
    if (!allowStopped && this.stopped) return Promise.reject(new Error("Ark kernel is closed"));
    return this.requestOn(this.control, this.controlPending, type, content, expectedType, timeoutMs);
  }

  private async requestOn(
    socket: MultipartSocket | undefined,
    pendingMap: Map<string, PendingReply>,
    type: string,
    content: Record<string, unknown>,
    expectedType: string,
    timeoutMs: number,
  ): Promise<JupyterMessage> {
    if (socket === undefined) throw new Error("Ark channel is unavailable");
    if (pendingMap.size >= MAX_PENDING_REQUESTS) throw new Error("Ark request queue is full");
    const id = newMessageId();
    const response = new Promise<JupyterMessage>((resolve, reject) => {
      pendingMap.set(id, { expectedType, resolve, reject });
    });
    try {
      await sendMessage(
        socket,
        this.key,
        this.session,
        type,
        content,
        undefined,
        this.maxMessageBytes,
        id,
      );
      return await withTimeout(response, timeoutMs, `Ark ${type}`);
    } finally {
      pendingMap.delete(id);
    }
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.failure = error;
    this.stopped = true;
    this.rejectAll(error);
    this.closeSockets();

    if (!this.intentionalExit) this.emit("failed", error);
    this.terminationPromise ??= this.finishProcessCleanup();
  }

  private rejectAll(error: Error): void {
    const seen = new Set<PendingReply>();
    for (const pending of [
      ...this.shellPending.values(),
      ...this.controlPending.values(),
      ...this.executions.values(),
    ]) {
      if (!seen.has(pending)) pending.reject(error);
      seen.add(pending);
    }
    this.shellPending.clear();
    this.controlPending.clear();
    this.executions.clear();
  }

  private closeSockets(): void {
    for (const socket of [this.shell, this.control, this.iopub, this.stdin]) {
      try {
        socket?.close();
      } catch {
        // Socket shutdown is best effort after the process has terminated.
      }
    }
    this.shell = undefined;
    this.control = undefined;
    this.iopub = undefined;
    this.stdin = undefined;
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.child === undefined || this.childExited) return;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
    ]);
  }

  private recordDiagnostic(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderr, chunk]);
    this.stderr = Buffer.from(redactText(combined.toString("utf8"), [this.key]), "utf8");
    if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.subarray(-64 * 1024);
  }

  private diagnosticText(): string {
    const text = redactText(this.stderr.toString("utf8").trim(), [this.key]);
    return text.length === 0 ? "" : `; Ark diagnostics: ${text}`;
  }
}

export async function probeArkPublicPublisher(options: ArkKernelOptions): Promise<ArkKernelInfo> {
  const kernel = new ArkKernel(options);
  try {
    return await kernel.start();
  } finally {
    await kernel.terminate();
  }
}

export function decodeMessage(
  frames: readonly Buffer[],
  key: string,
  maxMessageBytes = DEFAULT_MAX_FRAME_BYTES,
): JupyterMessage {
  let total = 0;
  for (const frame of frames) {
    total += frame.length;
    if (total > maxMessageBytes) {
      throw new FrameProtocolError("Jupyter message exceeds the configured byte limit");
    }
  }
  const delimiter = frames.findIndex((frame) => frame.equals(MESSAGE_DELIMITER));
  if (delimiter < 0) throw new FrameProtocolError("Jupyter message delimiter is missing");
  const body = frames.slice(delimiter + 1);
  if (body.length < 5) {
    throw new FrameProtocolError(`Jupyter message has ${body.length} body frames, expected at least 5`);
  }
  const [signature, headerBytes, parentBytes, metadataBytes, contentBytes] = body as
    [Buffer, Buffer, Buffer, Buffer, Buffer, ...Buffer[]];
  verifySignature(key, signature, [headerBytes, parentBytes, metadataBytes, contentBytes]);
  const header = parseHeader(parseJsonFrame(headerBytes, "header"));
  const parentHeaderValue = parseJsonFrame(parentBytes, "parent header");
  const parentHeader = asRecord(parentHeaderValue, "Jupyter parent header") as Partial<JupyterHeader>;
  const metadata = asRecord(parseJsonFrame(metadataBytes, "metadata"), "Jupyter metadata");
  const content = asRecord(parseJsonFrame(contentBytes, "content", maxMessageBytes), "Jupyter content");
  return {
    identities: frames.slice(0, delimiter),
    header,
    parentHeader,
    metadata,
    content,
    buffers: body.slice(5),
  };
}

async function sendMessage(
  socket: MultipartSocket,
  key: string,
  session: string,
  type: string,
  content: Record<string, unknown>,
  parentHeader: Partial<JupyterHeader> | undefined,
  maxMessageBytes: number,
  messageId = newMessageId(),
): Promise<string> {
  const header: JupyterHeader = {
    msg_id: messageId,
    username: "alder",
    session,
    date: new Date().toISOString(),
    msg_type: type,
    version: JUPYTER_VERSION,
  };
  const jsonFrames = [header, parentHeader ?? {}, {}, content].map((value) =>
    Buffer.from(JSON.stringify(value), "utf8"));
  const signature = sign(key, jsonFrames);
  const frames = [MESSAGE_DELIMITER, signature, ...jsonFrames];
  const bytes = frames.reduce((sum, frame) => sum + frame.length, 0);
  if (bytes > maxMessageBytes) {
    throw new FrameProtocolError("outgoing Jupyter message exceeds the configured byte limit");
  }
  await socket.send(frames);
  return messageId;
}

function sign(key: string, frames: readonly Buffer[]): Buffer {
  if (key.length === 0) return Buffer.alloc(0);
  const hmac = createHmac("sha256", key);
  for (const frame of frames) hmac.update(frame);
  return Buffer.from(hmac.digest("hex"), "ascii");
}

function verifySignature(
  key: string,
  actual: Buffer,
  frames: readonly Buffer[],
): void {
  const expected = sign(key, frames);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new FrameProtocolError("Jupyter message signature does not match");
  }
}

function parseJsonFrame(
  frame: Buffer,
  label: string,
  maxBytes = DEFAULT_MAX_FRAME_BYTES,
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    throw new FrameProtocolError(`Jupyter ${label} is not valid UTF-8`);
  }
  try {
    return parseStrictJson(text, {
      maxBytes,
      maxDepth: DEFAULT_STRICT_JSON_LIMITS.maxDepth,
    });
  } catch (error) {
    throw new FrameProtocolError(`invalid Jupyter ${label}: ${messageOf(error)}`);
  }
}

function parseHeader(input: unknown): JupyterHeader {
  const value = asRecord(input, "Jupyter header");
  return {
    msg_id: requiredString(value.msg_id, "Jupyter message id"),
    username: requiredString(value.username, "Jupyter username"),
    session: requiredString(value.session, "Jupyter session"),
    date: requiredString(value.date, "Jupyter date"),
    msg_type: requiredString(value.msg_type, "Jupyter message type"),
    version: requiredString(value.version, "Jupyter protocol version"),
  };
}

function endpoint(portNumber: number): string {
  return `tcp://127.0.0.1:${portNumber}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FrameProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

async function probeArkBuildVersion(options: ArkKernelOptions): Promise<typeof ARK_BUILD_VERSION> {
  if (options.processScope === undefined) {
    throw new FrameProtocolError("Ark build probe requires a process scope");
  }
  let child: OwnedProcess;
  try {
    child = await options.processScope.spawn({
      executable: options.executable,
      args: ["--version"],
      cwd: options.cwd,
      environment: childEnvironment(options.environment),
      stdio: "pipes",
    });
  } catch (error) {
    throw new FrameProtocolError("Ark build probe could not start: " + messageOf(error));
  }
  if (child.stdout === null || child.stderr === null) {
    await child.terminate().catch(() => {});
    throw new FrameProtocolError("Ark build probe did not provide output pipes");
  }
  let exit: { code: number | null; signal: string | null } | undefined;
  try {
    const stdout = readBoundedArkOutput(child.stdout);
    const stderr = readBoundedArkOutput(child.stderr);
    const result = await withTimeout(
      Promise.all([stdout, stderr, child.exited]),
      ARK_VERSION_PROBE_TIMEOUT_MS,
      "Ark build probe",
    );
    exit = result[2];
    if (exit.code !== 0) {
      throw new FrameProtocolError("Ark build probe exited unsuccessfully");
    }
    const output = result[0].trim();
    const match = /^Ark\s+([^\s,]+)(?:,\s+an R Kernel\.)?\s*$/.exec(output);
    if (match === null || match[1] !== ARK_BUILD_VERSION) {
      throw new FrameProtocolError("Ark build version is not the qualified Alder build");
    }
    return ARK_BUILD_VERSION;
  } finally {
    await child.terminate().catch(() => {});
  }
}

async function readBoundedArkOutput(
  stream: NonNullable<OwnedProcess["stdout"]>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_ARK_VERSION_OUTPUT_BYTES) {
      throw new FrameProtocolError("Ark build probe output exceeds the limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `${label} did not complete within ${timeoutMs} ms`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reserveConnectionPorts(): Promise<ConnectionPorts> {
  const servers = Array.from({ length: 5 }, () => createServer());
  try {
    const ports = await Promise.all(servers.map((server) => new Promise<number>(
      (resolvePort, rejectPort) => {
        server.once("error", rejectPort);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (typeof address === "object" && address !== null) resolvePort(address.port);
          else rejectPort(new Error("could not reserve a Jupyter port"));
        });
      },
    )));
    return {
      control_port: ports[0]!,
      shell_port: ports[1]!,
      stdin_port: ports[2]!,
      iopub_port: ports[3]!,
      hb_port: ports[4]!,
    };
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolveClose) => {
      if (!server.listening) resolveClose();
      else server.close(() => resolveClose());
    })));
  }
}

async function requireExecutable(path: string): Promise<void> {
  try {
    await access(path, process.platform === "win32" ? undefined : 1);
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Ark executable not found or not executable: ${path}`);
  }
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new RangeError(`${name} must be an integer between 1 and 3600000`);
  }
}

function newMessageId(): string {
  return randomUUID();
}
function redactText(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function childEnvironment(value: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
function messageOf(error: unknown): string {
  return asError(error).message;
}



function messageSize(message: JupyterMessage): number {
  return Buffer.byteLength(JSON.stringify({
    header: message.header,
    parent_header: message.parentHeader,
    metadata: message.metadata,
    content: message.content,
  }), "utf8") + message.buffers.reduce((total, buffer) => total + buffer.length, 0);
}
