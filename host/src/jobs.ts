import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

import type { ApplicationResources } from "./resources.js";
import type { REnvironment } from "./protocol.js";
import { rEnvironmentVariables } from "./r-environment.js";
import { parseStrictJson } from "./strict-json.js";
import type { OwnedProcess, ProcessScope } from "./processes.js";

/** A bounded progress notification emitted while a short-lived R worker runs. */
export interface JobProgress {
  readonly command: string;
  readonly operationId?: string;
  readonly phase: "started" | "output" | "finished";
  readonly stream?: "stdout" | "stderr";
  readonly text?: string;
  readonly data?: unknown;
}

export interface JobTerminal {
  readonly command: string;
  readonly operationId?: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string; details?: unknown };
}

export interface JobCallbacks {
  readonly onProgress?: (event: JobProgress) => void | Promise<void>;
  readonly onTerminal?: (event: JobTerminal) => void | Promise<void>;
  readonly onFailure?: (error: PackageJobError) => void | Promise<void>;
}

/** The immutable inputs every R package worker receives from application.ts. */
export interface JobOptions {
  readonly resources: ApplicationResources;
  readonly environment: REnvironment | null;
  readonly processScope: ProcessScope;
  readonly projectDirectory: string;
  readonly callbacks?: JobCallbacks;
  readonly timeoutMs?: number;
}

export interface JobRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const MAX_JOB_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const WORKER_NAME = "package-job.R";
const PROGRESS_PREFIX = "ALDER_PACKAGE_PROGRESS\t";

/** Errors from worker startup, transport, timeout, shutdown, or validation. */
export class PackageJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PackageJobError";
  }
}

/**
 * Runs the narrow, one-shot package worker. It never discovers R or starts an
 * R process outside the supplied ProcessScope; the resolved REnvironment is
 * the only executable/library identity used by this class.
 */
export class PackageJobs {
  private readonly children = new Set<OwnedProcess>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: JobOptions) {
    if (!options.resources || (!options.environment && options.environment !== null)) {
      throw new Error("R job resources and environment are required");
    }
    if (!isAbsoluteNonEmptyPath(options.projectDirectory)) {
      throw new Error("R job project directory must be an absolute path");
    }
    if (!isAbsoluteNonEmptyPath(options.resources.workerDirectory)
      || !isAbsoluteNonEmptyPath(options.resources.rLibraryDirectory)) {
      throw new Error("R job resource paths must be absolute");
    }
    validateTimeout(options.timeoutMs);
  }

  async run(
    command: "status" | "install",
    payload: Record<string, unknown>,
    runOptions: JobRunOptions = {},
  ): Promise<unknown> {
    if (this.closed) throw jobError("job_closed", "R job manager is closed");
    if (command !== "status" && command !== "install") {
      throw jobError("invalid_request", "unknown package worker command: " + command);
    }
    if (runOptions.timeoutMs !== undefined) validateTimeout(runOptions.timeoutMs);
    if (runOptions.signal?.aborted) throw jobError("cancelled", "R package job was cancelled");
    const operationId = typeof payload.operationId === "string" ? payload.operationId : undefined;
    if (this.options.environment === null) {
      throw jobError("r_not_found", "selected R environment is unavailable");
    }

    const directory = await mkdtemp(join(tmpdir(), "alder-package-job-"));
    let process: OwnedProcess | undefined;
    let failure: PackageJobError | undefined;
    try {
      const inputPath = join(directory, "input.json");
      const outputPath = join(directory, "result.json");
      const encoded = JSON.stringify({ command, payload });
      if (Buffer.byteLength(encoded, "utf8") > MAX_JOB_INPUT_BYTES) {
        throw jobError("invalid_request", "R package job input exceeds 16 MiB");
      }
      await writeFile(inputPath, encoded, { encoding: "utf8", mode: 0o600 });
      if (this.closed) throw jobError("job_closed", "R job manager is closed");

      const childEnvironment = workerEnvironment(this.options);
      const workerPath = join(this.options.resources.workerDirectory, WORKER_NAME);
      process = await this.options.processScope.spawn({
        executable: this.options.environment.rscript,
        args: ["--vanilla", workerPath, inputPath, outputPath],
        cwd: this.options.projectDirectory,
        environment: childEnvironment,
        stdio: "pipes",
      });
      this.children.add(process);
      if (this.closed) {
        await process.terminate().catch(() => undefined);
        throw jobError("job_closed", "R job manager is closed");
      }
      const diagnostics = new DiagnosticCapture(command, operationId, this.options.callbacks?.onProgress);
      const streams = [
        consumeStream(process.stdout, "stdout", diagnostics),
        consumeStream(process.stderr, "stderr", diagnostics),
      ];
      process.stdin?.end();
      await notify(this.options.callbacks?.onProgress, { command, operationId, phase: "started" });
      const exit = await waitForProcess(process, runOptions.signal, runOptions.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await Promise.all(streams);

      if (exit.kind !== "exit") {
        const code = exit.kind === "timeout" ? "job_timeout" : "cancelled";
        const message = exit.kind === "timeout" ? "R package job timed out" : "R package job was cancelled";
        throw jobError(code, message, { output: diagnostics.text });
      }
      if (exit.code !== 0) {
        throw jobError("job_failed", "R package job exited " + (exit.code ?? "without a status") + ": " + diagnostics.text, {
          status: exit.code,
          signal: exit.signal,
          output: diagnostics.text,
        });
      }

      let response: unknown;
      try {
        const bytes = await readBounded(outputPath, MAX_JOB_OUTPUT_BYTES);
        response = parseStrictJson(bytes, { maxBytes: MAX_JOB_OUTPUT_BYTES, maxDepth: 64 });
      } catch (error) {
        throw jobError("job_protocol_error", "R package worker returned an invalid response: " + messageOf(error), {
          output: diagnostics.text,
        });
      }
      if (!isRecord(response) || typeof response.ok !== "boolean") {
        throw jobError("job_protocol_error", "R package worker returned an invalid response", { output: diagnostics.text });
      }
      if (!response.ok) {
        const detail = isRecord(response.error) ? response.error : {};
        throw jobError(
          typeof detail.code === "string" ? detail.code : "job_failed",
          typeof detail.message === "string" ? detail.message : "R package worker failed",
          { ...(isRecord(detail.details) ? { details: detail.details } : {}), output: diagnostics.text },
        );
      }
      const result = command === "install" ? withDiagnostics(response.result, diagnostics.text) : response.result;
      const operationFailure = command === "install" ? nestedFailure(result) : undefined;
      await notify(this.options.callbacks?.onProgress, { command, operationId, phase: "finished" });
      await notify(this.options.callbacks?.onTerminal, operationFailure === undefined
        ? { command, operationId, ok: true, result }
        : { command, operationId, ok: false, error: operationFailure, result });
      return result;
    } catch (error) {
      failure = error instanceof PackageJobError ? error : jobError("job_failed", messageOf(error));
      await notify(this.options.callbacks?.onFailure, failure);
      await notify(this.options.callbacks?.onTerminal, {
        command,
        operationId,
        ok: false,
        error: { code: failure.code, message: failure.message, details: failure.details },
      });
      throw failure;
    } finally {
      if (process !== undefined) this.children.delete(process);
      await rm(directory, { recursive: true, force: true });
    }
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closing !== undefined) return this.closing;
    this.closing = (async () => {
      const children = [...this.children];
      await Promise.all(children.map(async (child) => {
        await child.terminate().catch(() => undefined);
      }));
      await Promise.all(children.map(child => child.exited.catch(() => ({ code: null, signal: "SIGKILL" }))));
    })();
    return this.closing;
  }
}

function workerEnvironment(options: JobOptions): Record<string, string> {
  const environment = options.environment;
  if (environment === null) throw jobError("r_not_found", "selected R environment is unavailable");
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) values[key] = value;
  }
  // Never let a parent-selected R_HOME or legacy Alder package override the
  // immutable application resources/environment supplied by application.ts.
  for (const key of [
    "R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE", "R_PROFILE", "R_PROFILE_USER",
    "ALDER_R_PACKAGE", "ALDER_R_PRIVATE_LIBRARY", "ALDER_R_LIBRARIES", "ALDER_RESOURCES_ROOT", "ALDER_WORKER_DIR",
    "ALDER_PROJECT_LIB", "ALDER_SANDBOX_LIB", "ALDER_PACKAGE_LIB", "ALDER_PACKAGE_MODE",
  ]) delete values[key];
  for (const key of Object.keys(values)) {
    if (key.startsWith("RENV_")) delete values[key];
  }
  Object.assign(values, rEnvironmentVariables(environment, options.resources));
  return values;
}

async function waitForProcess(
  child: OwnedProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ kind: "exit"; code: number | null; signal: string | null } | { kind: "timeout" | "cancelled" }> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const exit = child.exited.then(value => ({ kind: "exit" as const, ...value }));
  const timeout = new Promise<{ kind: "timeout" }>(resolve => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    timer.unref();
  });
  const cancellation = signal === undefined
    ? new Promise<never>(() => undefined)
    : new Promise<{ kind: "cancelled" }>(resolve => {
      abort = () => resolve({ kind: "cancelled" });
      if (signal.aborted) resolve({ kind: "cancelled" });
      else signal.addEventListener("abort", abort, { once: true });
    });
  try {
    const result = await Promise.race([exit, timeout, cancellation]);
    if (result.kind !== "exit") {
      await child.terminate().catch(() => undefined);
      await child.exited.catch(() => undefined);
      return result;
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

class DiagnosticCapture {
  private value = "";
  private progressBuffer = "";
  private readonly decoders: Record<"stdout" | "stderr", TextDecoder> = {
    stdout: new TextDecoder("utf-8"),
    stderr: new TextDecoder("utf-8"),
  };
  constructor(
    readonly command: string,
    readonly operationId: string | undefined,
    private readonly progress?: JobCallbacks["onProgress"],
  ) {}
  get text(): string { return this.value; }
  async append(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void> {
    await this.appendText(stream, this.decoders[stream].decode(bytes, { stream: true }));
  }
  async flush(stream: "stdout" | "stderr"): Promise<void> {
    await this.appendText(stream, this.decoders[stream].decode());
  }
  private async appendText(stream: "stdout" | "stderr", decoded: string): Promise<void> {
    if (!decoded) return;
    const text = boundedUtf8Tail(decoded, MAX_DIAGNOSTIC_BYTES);
    this.value = boundedUtf8Tail(this.value + text, MAX_DIAGNOSTIC_BYTES);
    await notify(this.progress, { command: this.command, operationId: this.operationId, phase: "output", stream, text });
    this.progressBuffer = boundedUtf8Tail(this.progressBuffer + text, MAX_DIAGNOSTIC_BYTES);
    const lines = this.progressBuffer.split(/\r?\n/);
    this.progressBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(PROGRESS_PREFIX)) continue;
      const json = line.slice(PROGRESS_PREFIX.length);
      try {
        await notify(this.progress, { command: this.command, operationId: this.operationId, phase: "output", stream, text: line, data: parseProgressJson(json) });
      } catch {
        // Worker progress is advisory; the result file remains authoritative.
      }
    }
  }
}

async function consumeStream(
  stream: NodeJS.ReadableStream | null,
  name: "stdout" | "stderr",
  capture: DiagnosticCapture,
): Promise<void> {
  if (stream === null) return;
  let pending = Promise.resolve();
  stream.on("data", (chunk: Uint8Array | string) => {
    pending = pending.then(() => capture.append(name, typeof chunk === "string" ? Buffer.from(chunk) : chunk));
  });
  await new Promise<void>((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  await pending;
  await capture.flush(name);
}
function boundedUtf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}


function parseProgressJson(value: string): unknown {
  try { return parseStrictJson(value, { maxBytes: 64 * 1024, maxDepth: 16 }); }
  catch { return undefined; }
}

function withDiagnostics(value: unknown, diagnostics: string): unknown {
  if (!diagnostics || !isRecord(value) || typeof value.output !== "string" || value.output.length > 0) {
    return value;
  }
  const error = isRecord(value.error) && typeof value.error.output === "string" && value.error.output.length === 0
    ? { ...value.error, output: diagnostics }
    : value.error;
  return { ...value, output: diagnostics, ...(error === undefined ? {} : { error }) };
}

function nestedFailure(value: unknown): { code: string; message: string; details?: unknown } | undefined {
  if (!isRecord(value) || value.ok !== false) return undefined;
  const error = isRecord(value.error) ? value.error : {};
  return {
    code: typeof error.code === "string" ? error.code : "job_failed",
    message: typeof error.message === "string" ? error.message : "package operation failed",
    details: error,
  };
}

async function notify<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  if (callback === undefined) return;
  try { await callback(value); } catch { /* callbacks cannot corrupt job settlement */ }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("worker result is not a regular file");
    if (info.size > maximum) throw new Error("worker result exceeds 8 MiB");
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) throw new Error("worker result ended unexpectedly");
      offset += read.bytesRead;
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 3_600_000)) {
    throw new Error("R job timeout must be an integer between 1 and 3600000 milliseconds");
  }
}

function isAbsoluteNonEmptyPath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

function jobError(code: string, message: string, details?: unknown): PackageJobError {
  return new PackageJobError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
