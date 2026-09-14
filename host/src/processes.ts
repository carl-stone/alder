import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { parseStrictJson } from "./strict-json.js";
import type { ApplicationResources } from "./resources.js";

const CONTROL_VERSION = 1;
const MAX_CONTROL_FRAME_BYTES = 1_048_576;
const MAX_QUEUED_CONTROL_EVENTS = 256;
const MAX_QUEUED_CONTROL_EVENT_BYTES = 4 * 1024 * 1024;

const SUPERVISOR_MODES = { child: "--child", detached: "--detached-host" } as const;
const SUPERVISOR_START_TIMEOUT_MS = 10_000;
const SUPERVISOR_CLOSE_TIMEOUT_MS = 5_000;
const MAX_DETACHED_READY_TIMEOUT_MS = 120_000;
const DEFAULT_DETACHED_READY_TIMEOUT_MS = 120_000;
const MAX_READY_RECORD_BYTES = 1_048_576;
const MAX_STARTUP_DIAGNOSTIC_BYTES = 64 * 1024;
const PRIVATE_READY_NONCE = "ALDER_PRIVATE_READY_NONCE";
const PROCESS_NONCE_ENV = "ALDER_PROCESS_NONCE";
const EPOCH_ENV = "ALDER_EPOCH";

export interface ProcessSpawnOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
  stdio: "pipes" | "ignore";
}

export interface OwnedProcess {
  readonly pid: number;
  readonly startIdentity: string;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  terminate(): Promise<void>;
}

export interface ProcessScope {
  spawn(options: ProcessSpawnOptions): Promise<OwnedProcess>;
  close(): Promise<void>;
}

interface SupervisorEvent {
  v: number;
  type: string;
  id?: number;
  requestId?: number | null;
  pid?: number;
  startIdentity?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
  [key: string]: unknown;
}

interface SupervisorHandle {
  process: ChildProcess;
  input: Writable;
  output: Readable;
  events: AsyncEventQueue;
  mode: "child" | "detached";
  closed: Promise<void>;
  closing?: Promise<void>;
}

/**
 * Detached host readiness is consumed on a private supervisor stream and
 * authenticated by the ownership layer before native handoff.
 */
export interface DetachedHostReadyContext {
  readonly ready: Record<string, unknown>;
  readonly pid: number;
  readonly startIdentity: string;
  readonly processNonce: string;
  readonly epoch: string;
}

export interface DetachedHostOptions {
  resources: ApplicationResources;
  args: readonly string[];
  environment: Record<string, string>;
  readyTimeoutMs?: number;
  authenticateReady(context: DetachedHostReadyContext): Promise<void>;
}

export async function spawnDetachedHost(options: DetachedHostOptions): Promise<{
  pid: number;
  startIdentity: string;
  ready: Promise<void>;
}> {
  const timeoutMs = validateReadyTimeout(options.readyTimeoutMs);
  if (typeof options.authenticateReady !== "function") {
    throw new Error("detached host readiness authentication is required");
  }
  const nonce = randomBytes(32).toString("hex");
  const processNonce = options.environment[PROCESS_NONCE_ENV];
  const epoch = options.environment[EPOCH_ENV];
  if (!processNonce || !epoch) {
    throw new Error("detached host readiness requires process nonce and epoch");
  }
  const supervisor = await startSupervisor(
    options.resources.processSupervisorExecutable,
    "detached",
    "pipes",
    options.resources.root,
  );
  const startupDiagnostic = new BoundedStartupDiagnostic(supervisor.process.stderr);
  const request = {
    v: CONTROL_VERSION,
    op: "spawn",
    id: 1,
    executable: options.resources.nodeExecutable,
    args: [options.resources.hostEntry, "--internal-host", ...options.args],
    cwd: options.resources.root,
    environment: { ...options.environment, [PRIVATE_READY_NONCE]: nonce },
    stdio: "pipes",
  };
  try {
    await sendFrame(supervisor.input, request);
    const spawned = await waitForSpawn(supervisor.events, 1);
    // The detached supervisor remains private until the internal host proves
    // document readiness. A target exit is consumed by this one watcher.
    const lifecycle = waitForEvent(
      supervisor.events,
      event => event.type === "closed" || event.type === "exited",
      null,
    );
    const privateReady = waitForPrivateReady(supervisor.process.stdout as Readable, {
      expectedPid: spawned.pid,
      expectedNonce: nonce,
      expectedProcessNonce: processNonce,
      expectedEpoch: epoch,
      timeoutMs,
      lifecycle,
    });
    const ready = withTimeout(privateReady.then(async privateRecord => {
      await options.authenticateReady({
        ready: privateRecord.ready,
        pid: spawned.pid,
        startIdentity: spawned.startIdentity,
        processNonce,
        epoch,
      });
      await sendFrame(supervisor.input, { v: CONTROL_VERSION, op: "handoff", id: 2 });
      const event = await lifecycle;
      if (event.type !== "closed") {
        throw new Error("detached host exited before readiness handoff");
      }
      releaseDetachedSupervisor(supervisor);
    }), timeoutMs, "detached host readiness authentication timed out").catch(async error => {
      // Invalid/late private readiness must terminate before the rejection is
      // observed. Native containment owns all descendants; there is no direct-
      // spawn fallback.
      await sendFrame(supervisor.input, { v: CONTROL_VERSION, op: "terminate", id: 3 }).catch(() => {});
      await closeSupervisor(supervisor).catch(() => {});
      throw appendStartupDiagnostic(error, startupDiagnostic.text());
    }).finally(() => startupDiagnostic.dispose());
    void lifecycle.then(
      event => {
        if (event.type === "closed") releaseDetachedSupervisor(supervisor);
        return event.type === "exited" ? closeSupervisor(supervisor) : supervisor.closed;
      },
      () => closeSupervisor(supervisor),
    ).catch(() => {});
    return { pid: spawned.pid, startIdentity: spawned.startIdentity, ready };
  } catch (error) {
    await sendFrame(supervisor.input, { v: CONTROL_VERSION, op: "terminate", id: 3 }).catch(() => {});
    await closeSupervisor(supervisor).catch(() => {});
    const diagnostic = startupDiagnostic.text();
    startupDiagnostic.dispose();
    throw appendStartupDiagnostic(error, diagnostic);
  }
}
function validateReadyTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DETACHED_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_DETACHED_READY_TIMEOUT_MS) {
    throw new RangeError(`detached host readiness timeout must be an integer from 1 to ${MAX_DETACHED_READY_TIMEOUT_MS} ms`);
  }
  return timeout;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function createProcessScope(resources?: ApplicationResources): Promise<ProcessScope> {
  const supervisorExecutable = resources?.processSupervisorExecutable;
  if (!supervisorExecutable) throw new Error("process supervisor resource is required");
  const handles = new Set<SupervisorHandle>();
  const pendingSpawns = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  return {
    spawn: (options) => {
      if (closing) return Promise.reject(new Error("process scope is closed"));
      const operation = (async (): Promise<OwnedProcess> => {
        const supervisor = await startSupervisor(
          supervisorExecutable,
          "child",
          options.stdio,
          options.cwd,
        );
        // close() gates new work synchronously but may have been called while
        // the supervisor was still starting. Do not publish a late handle to
        // a scope whose ownership has already been released.
        if (closing) {
          await closeSupervisor(supervisor).catch(() => {});
          throw new Error("process scope is closed");
        }
        handles.add(supervisor);
        try {
          const request = {
            v: CONTROL_VERSION,
            op: "spawn",
            id: 1,
            executable: options.executable,
            args: [...options.args],
            cwd: options.cwd,
            environment: options.environment,
            stdio: options.stdio,
          };
          await sendFrame(supervisor.input, request);
          const spawned = await waitForSpawn(supervisor.events, 1);
          let exitResolve!: (value: { code: number | null; signal: string | null }) => void;
          let exitReject!: (reason: unknown) => void;
          const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
            exitResolve = resolve;
            exitReject = reject;
          });
          // The public promise must remain rejected on a lost supervisor guard,
          // but an owner may attach its rejection handler after the supervisor
          // has already failed. Observe it eagerly without changing its result.
          void exited.catch(() => {});
          let terminated: Promise<void> | undefined;
          void (async () => {
            try {
              const event = await waitForEvent(
                supervisor.events,
                value => value.type === "exited" && value.id === 1,
                null,
              );
              exitResolve({ code: event.code ?? null, signal: event.signal ?? null });
            } catch (error) {
              exitReject(error);
            } finally {
              // A completed target no longer needs a scope-held supervisor.
              // Closing it runs native containment cleanup and releases the
              // control/data-plane descriptors even when scope.close() is
              // never called. terminate() shares this idempotent close path.
              await closeSupervisor(supervisor).catch(() => {});
              handles.delete(supervisor);
              if (!supervisor.closing) supervisor.events.dispose();
            }
          })();
          const owned: OwnedProcess = {
            pid: spawned.pid,
            startIdentity: spawned.startIdentity,
            stdin: options.stdio === "pipes" ? supervisor.process.stdin : null,
            stdout: options.stdio === "pipes" ? supervisor.process.stdout : null,
            stderr: options.stdio === "pipes" ? supervisor.process.stderr : null,
            exited,
            terminate: () => terminated ??= terminateSupervisor(supervisor, exited),
          };
          return owned;
        } catch (error) {
          handles.delete(supervisor);
          await closeSupervisor(supervisor).catch(() => {});
          throw error;
        }
      })();
      pendingSpawns.add(operation);
      // Keep cleanup independent from the caller's attachment timing while
      // preserving the operation's original fulfillment/rejection.
      void operation.finally(() => pendingSpawns.delete(operation)).catch(() => {});
      return operation;
    },
    close: () => closing ??= (async () => {
      // Await every spawn already in the ownership boundary, including a
      // supervisor that is still handshaking. The loop also covers a spawn
      // that settles while this barrier is being observed.
      while (pendingSpawns.size > 0) {
        await Promise.allSettled([...pendingSpawns]);
      }
      const results = await Promise.allSettled([...handles].map(handle => closeSupervisor(handle)));
      handles.clear();
      const failures = results
        .filter(result => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "process scope close failed");
    })(),
  };
}

async function startSupervisor(
  executable: string,
  mode: "child" | "detached",
  stdioMode: "pipes" | "ignore",
  cwd: string,
): Promise<SupervisorHandle> {
  const stdio: Array<"pipe" | "ignore" | "inherit"> = stdioMode === "pipes"
    ? ["pipe", "pipe", "pipe", "pipe", "pipe"]
    : ["ignore", "ignore", "ignore", "pipe", "pipe"];
  const controlArguments = process.platform === "win32"
    ? []
    : ["--control-in=3", "--control-out=4"];
  const child = spawn(executable, [SUPERVISOR_MODES[mode], ...controlArguments], {
    cwd,
    env: process.env,
    stdio,
    windowsHide: true,
  });
  const input = child.stdio[3] as Writable | null;
  const output = child.stdio[4] as Readable | null;
  if (!input || !output) {
    try { child.kill(); } catch { /* spawn failed */ }
    throw new Error("process supervisor did not provide control pipes");
  }
  let supervisor!: SupervisorHandle;
  const events = new AsyncEventQueue(output, () => {
    if (supervisor !== undefined) {
      // A protocol failure must close through the native supervisor so its
      // containment cleanup runs before the wrapper is released.
      void closeSupervisor(supervisor).catch(() => {});
    } else {
      input.destroy();
      output.destroy();
      try { child.kill(); } catch { /* spawn failed */ }
    }
  });
  child.once("error", error => events.fail(error));
  input.on("error", () => {});
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const handle = { process: child, input, output, events, mode, closed } satisfies SupervisorHandle;
  supervisor = handle;
  try {
    const hello = await waitForEvent(events, event => event.type === "hello", SUPERVISOR_START_TIMEOUT_MS);
    if (hello.v !== CONTROL_VERSION) throw new Error("unsupported process supervisor protocol");
    return handle;
  } catch (error) {
    await closeSupervisor(supervisor).catch(() => {});
    throw error;
  }
}

function releaseDetachedSupervisor(supervisor: SupervisorHandle): void {
  // The target inherited the detached wrapper's data-plane descriptors. Once
  // the native handoff has committed, no JS-side stream or child handle is
  // needed to keep the host alive; only the target and its transferred
  // containment remain authoritative.
  supervisor.events.dispose();
  supervisor.process.unref();
  supervisor.input.destroy();
  supervisor.output.destroy();
  for (const stream of [supervisor.process.stdin, supervisor.process.stdout, supervisor.process.stderr]) {
    (stream as (typeof stream & { unref?: () => void }) | null)?.unref?.();
  }
}

interface PrivateReadyRecord {
  readonly ready: Record<string, unknown>;
}

async function waitForPrivateReady(
  output: Readable,
  options: {
    expectedPid: number;
    expectedNonce: string;
    expectedProcessNonce: string;
    expectedEpoch: string;
    timeoutMs: number;
    lifecycle: Promise<SupervisorEvent>;
  },
): Promise<PrivateReadyRecord> {
  let resolveReady!: (value: PrivateReadyRecord) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<PrivateReadyRecord>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let buffer = Buffer.alloc(0);
  const finish = (error: unknown, value?: PrivateReadyRecord): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    output.off("data", onData);
    output.off("error", onError);
    output.off("end", onEnd);
    if (error !== undefined) rejectReady(error);
    else {
      // stdout is private to this supervisor until handoff. Drain it after
      // parsing so an internal host cannot block on a full inherited pipe.
      output.resume();
      resolveReady(value!);
    }
  };
  const onError = (error: unknown): void => finish(error);
  const onEnd = (): void => finish(new Error("host exited before private readiness"));
  const onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.byteLength > MAX_READY_RECORD_BYTES) {
      finish(new Error("private readiness record exceeds 1 MiB"));
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    let line = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
    try {
      const value = parseStrictJson(line, { maxBytes: MAX_READY_RECORD_BYTES, maxDepth: 64 });
      if (!isRecord(value) || value.type !== "alder.private.ready" || value.version !== CONTROL_VERSION) {
        throw new Error("private readiness record has an invalid type or version");
      }
      const privateKeys = Object.keys(value).sort();
      if (privateKeys.length !== 6 || privateKeys.some((key, index) => key !== ["nonce", "pid", "processNonce", "ready", "type", "version"][index])) {
        throw new Error("private readiness record has unexpected fields");
      }
      if (value.nonce !== options.expectedNonce || value.pid !== options.expectedPid) {
        throw new Error("private readiness record failed process authentication");
      }
      if (value.processNonce !== options.expectedProcessNonce) {
        throw new Error("private readiness record failed registry authentication");
      }
      const publicReady = value.ready;
      if (!isRecord(publicReady) || publicReady.type !== "host.ready" ||
          typeof publicReady.origin !== "string" || publicReady.origin.length === 0 ||
          publicReady.epoch !== options.expectedEpoch) {
        throw new Error("private readiness record has an invalid public ready record");
      }
      finish(undefined, { ready: publicReady });
    } catch (error) {
      finish(error);
    }
  };
  output.on("data", onData);
  output.once("error", onError);
  output.once("end", onEnd);
  timer = setTimeout(
    () => finish(new Error(`host did not become document-ready within ${options.timeoutMs} ms`)),
    options.timeoutMs,
  );
  void options.lifecycle.then(
    () => finish(new Error("host exited before private readiness")),
    error => finish(error),
  );
  void ready.catch(() => undefined);
  return ready;
}

async function waitForSpawn(events: AsyncEventQueue, id: number): Promise<{ pid: number; startIdentity: string }> {
  const event = await waitForEvent(
    events,
    value => value.type === "spawned" && value.id === id,
    SUPERVISOR_START_TIMEOUT_MS,
  );
  if (!Number.isInteger(event.pid) || typeof event.startIdentity !== "string" || event.startIdentity.length === 0) {
    throw new Error("process supervisor returned an invalid identity");
  }
  return { pid: event.pid!, startIdentity: event.startIdentity };
}

async function waitForEvent(
  events: AsyncEventQueue,
  predicate: (event: SupervisorEvent) => boolean,
  timeoutMs: number | null,
): Promise<SupervisorEvent> {
  const read = (async (): Promise<SupervisorEvent> => {
    while (true) {
      const event = await events.next();
      if (event.v !== CONTROL_VERSION) throw new Error("unsupported process supervisor event protocol");
      if (event.type === "error") {
        throw new Error(`${String(event.code ?? "process_supervisor_error")}: ${event.message ?? "process supervisor error"}`);
      }
      if (predicate(event)) return event;
    }
  })();
  if (timeoutMs === null) return read;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<SupervisorEvent>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`process supervisor event timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendFrame(input: Writable, value: object): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new Error("process supervisor request is too large");
  }
  const candidate = input as Writable & { destroyed?: boolean; writableEnded?: boolean };
  if (candidate.destroyed || candidate.writableEnded) throw new Error("process supervisor control pipe is closed");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, 4);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      input.off("error", onError);
      reject(error);
    };
    input.once("error", onError);
    try {
      input.write(frame, error => {
        if (settled) return;
        settled = true;
        input.off("error", onError);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function terminateSupervisor(
  supervisor: SupervisorHandle,
  exited: Promise<{ code: number | null; signal: string | null }>,
): Promise<void> {
  await sendFrame(supervisor.input, { v: CONTROL_VERSION, op: "terminate", id: 1 }).catch(() => {});
  await exited.catch(() => {});
  await closeSupervisor(supervisor);
}

async function closeSupervisor(supervisor: SupervisorHandle): Promise<void> {
  if (supervisor.closing) return supervisor.closing;
  supervisor.closing = (async () => {
    await sendFrame(supervisor.input, { v: CONTROL_VERSION, op: "close", id: 1 }).catch(() => {});
    supervisor.input.end();
    await Promise.race([
      supervisor.closed,
      new Promise<void>(resolve => setTimeout(resolve, SUPERVISOR_CLOSE_TIMEOUT_MS)),
    ]);
    if (!supervisor.process.killed) {
      try { supervisor.process.kill(); } catch { /* already gone */ }
    }
    await Promise.race([
      supervisor.closed,
      new Promise<void>(resolve => setTimeout(resolve, 1_000)),
    ]);
    if (!supervisor.events.closedCleanly) {
      throw supervisor.events.failureError ?? new Error("process supervisor closed without acknowledgement");
    }
    supervisor.events.dispose();
  })();
  return supervisor.closing;
}

class AsyncEventQueue {
  private readonly pending: Array<{
    resolve: (event: SupervisorEvent) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly events: Array<{
    event: SupervisorEvent;
    byteLength: number;
  }> = [];
  private buffer = Buffer.alloc(0);
  private queuedEventBytes = 0;
  private failure: Error | undefined;
  private didClose = false;
  private disposed = false;
  private readonly onData = (chunk: Buffer | string): void => this.push(chunk);
  private readonly onError = (error: unknown): void => this.fail(error);
  private readonly onEnd = (): void => {
    if (this.didClose) this.dispose();
    else this.fail(new Error("process supervisor control channel closed"));
  };

  get failureError(): Error | undefined {
    return this.failure;
  }

  get closedCleanly(): boolean {
    return this.didClose;
  }

  constructor(
    private readonly output: Readable,
    private readonly onFailure?: (error: Error) => void,
  ) {
    output.on("data", this.onData);
    output.once("error", this.onError);
    output.once("end", this.onEnd);
  }

  next(): Promise<SupervisorEvent> {
    const queued = this.events.shift();
    if (queued) {
      this.queuedEventBytes -= queued.byteLength;
      return Promise.resolve(queued.event);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new Error("process supervisor event queue is disposed"));
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  fail(error: unknown): void {
    if (this.failure || this.disposed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.didClose = false;
    this.events.length = 0;
    this.queuedEventBytes = 0;
    this.buffer = Buffer.alloc(0);
    this.output.off("data", this.onData);
    this.output.off("error", this.onError);
    this.output.off("end", this.onEnd);
    this.output.destroy();
    for (const waiter of this.pending.splice(0)) waiter.reject(this.failure);
    this.onFailure?.(this.failure);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.events.length = 0;
    this.queuedEventBytes = 0;
    this.buffer = Buffer.alloc(0);
    this.output.off("data", this.onData);
    this.output.off("error", this.onError);
    this.output.off("end", this.onEnd);
    this.output.destroy();
    const error = new Error("process supervisor event queue is disposed");
    for (const waiter of this.pending.splice(0)) waiter.reject(error);
  }

  private push(chunk: Buffer | string): void {
    if (this.failure || this.disposed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_CONTROL_FRAME_BYTES) {
        this.fail(new Error("invalid process supervisor control frame"));
        return;
      }
      if (this.buffer.byteLength < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value: unknown;
      try {
        value = parseStrictJson(body, { maxBytes: MAX_CONTROL_FRAME_BYTES, maxDepth: 64 });
      } catch (error) {
        this.fail(new Error("invalid process supervisor event: " + String(error)));
        return;
      }
      if (!isRecord(value)) {
        this.fail(new Error("invalid process supervisor event object"));
        return;
      }
      this.enqueue(value as SupervisorEvent, length);
      if (this.failure) return;
    }
  }

  private enqueue(event: SupervisorEvent, byteLength: number): void {
    if (this.failure || this.disposed) return;
    if (event.v === CONTROL_VERSION && event.type === "closed") this.didClose = true;
    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve(event);
      return;
    }
    if (this.events.length >= MAX_QUEUED_CONTROL_EVENTS ||
        this.queuedEventBytes + byteLength > MAX_QUEUED_CONTROL_EVENT_BYTES) {
      this.fail(new Error("process supervisor event queue overflow"));
      return;
    }
    this.events.push({ event, byteLength });
    this.queuedEventBytes += byteLength;
  }

}

class BoundedStartupDiagnostic {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private truncated = false;
  private accepting = true;
  private readonly onData = (chunk: Buffer | string): void => {
    if (!this.accepting || this.byteLength >= MAX_STARTUP_DIAGNOSTIC_BYTES) {
      this.truncated = true;
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_STARTUP_DIAGNOSTIC_BYTES - this.byteLength;
    const captured = bytes.subarray(0, remaining);
    if (captured.byteLength > 0) {
      this.chunks.push(Buffer.from(captured));
      this.byteLength += captured.byteLength;
    }
    if (captured.byteLength < bytes.byteLength) this.truncated = true;
  };

  constructor(private readonly stream: Readable | null) {
    stream?.on("data", this.onData);
  }

  text(): string {
    if (this.chunks.length === 0) return "";
    const text = Buffer.concat(this.chunks).toString("utf8").trim();
    return this.truncated ? text + "\n[supervisor stderr truncated]" : text;
  }

  dispose(): void {
    this.accepting = false;
    this.stream?.off("data", this.onData);
    this.stream?.resume();
    this.chunks.length = 0;
    this.byteLength = 0;
  }
}

function appendStartupDiagnostic(error: unknown, diagnostic: string): Error {
  if (diagnostic.length === 0) return error instanceof Error ? error : new Error(String(error));
  const message = error instanceof Error ? error.message : String(error);
  const combined = message.length === 0 ? diagnostic : message + "; detached host stderr: " + diagnostic;
  if (error instanceof Error) {
    error.message = combined;
    return error;
  }
  return new Error(combined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
