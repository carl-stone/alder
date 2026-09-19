import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplicationResources } from "./resources.js";
import type { REnvironment } from "./protocol.js";
import { rServiceEnvironmentVariables } from "./r-environment.js";
import type { OwnedProcess, ProcessScope } from "./processes.js";

export interface PackageProgress {
  readonly command: "status" | "install";
  readonly operationId?: string;
  readonly phase: "started" | "output" | "finished";
  readonly text?: string;
}

export interface PackageWorkerOptions {
  readonly resources: ApplicationResources;
  readonly environment: REnvironment | null;
  readonly processScope: ProcessScope;
  readonly projectDirectory: string;
  readonly onProgress?: (event: PackageProgress) => void | Promise<void>;
  readonly timeoutMs?: number;
}

export interface PackageRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class PackageWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "PackageWorkerError";
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** One short-lived R process for project package status or installation. */
export class PackageWorker {
  private readonly children = new Set<OwnedProcess>();
  private readonly pending = new Set<Promise<OwnedProcess>>();
  private readonly stopping = new Map<OwnedProcess, Promise<void>>();
  private closed = false;

  constructor(private readonly options: PackageWorkerOptions) {
    if (options.timeoutMs !== undefined) validateTimeout(options.timeoutMs);
  }

  async run(command: "status" | "install", payload: Record<string, unknown>, runOptions: PackageRunOptions = {}): Promise<unknown> {
    if (this.closed) throw failure("job_closed", "package service is closed");
    if (runOptions.timeoutMs !== undefined) validateTimeout(runOptions.timeoutMs);
    runOptions.signal?.throwIfAborted();
    const environment = this.options.environment;
    if (environment === null) throw failure("r_not_found", "selected R environment is unavailable");
    const operationId = typeof payload.operationId === "string" ? payload.operationId : undefined;
    const directory = await mkdtemp(join(tmpdir(), "alder-package-"));
    let child: OwnedProcess | undefined;
    try {
      const inputPath = join(directory, "input.json");
      const outputPath = join(directory, "result.json");
      await writeFile(inputPath, JSON.stringify({ command, ...payload }), { mode: 0o600 });
      if (this.closed) throw failure("job_closed", "package service is closed");
      const spawning = this.options.processScope.spawn({
        executable: environment.rscript,
        args: ["--vanilla", join(this.options.resources.workerDirectory, "package-job.R"), inputPath, outputPath],
        cwd: this.options.projectDirectory,
        environment: workerEnvironment(environment, this.options.resources),
        stdio: "pipes",
      }).then(value => {
        this.children.add(value);
        return value;
      });
      this.pending.add(spawning);
      try { child = await spawning; }
      finally { this.pending.delete(spawning); }
      if (this.closed) throw failure("job_closed", "package service is closed");
      child.stdin?.end();
      await this.options.onProgress?.({ command, operationId, phase: "started" });
      const outputPromise = collect(child.stdout, child.stderr);
      const exit = await waitForExit(child, runOptions.signal, runOptions.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const output = await outputPromise;
      if (exit === "cancelled") throw failure("cancelled", "R package operation was cancelled");
      if (exit === "timeout") throw failure("job_timeout", "R package operation timed out");
      if (output.length > 0) await this.options.onProgress?.({ command, operationId, phase: "output", text: output });
      if (exit.code !== 0) throw failure("install_failed", output || `R package operation exited ${exit.code ?? "without status"}`);
      const bytes = await readFile(outputPath);
      if (bytes.byteLength > MAX_OUTPUT_BYTES) throw failure("job_failed", "R package result is too large");
      const result = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!isRecord(result) || typeof result.ok !== "boolean") throw failure("job_failed", "R package service returned an invalid result");
      await this.options.onProgress?.({ command, operationId, phase: "finished" });
      return result;
    } catch (error) {
      if (error instanceof PackageWorkerError) throw error;
      if (runOptions.signal?.aborted) throw failure("cancelled", "R package operation was cancelled");
      throw failure("job_failed", messageOf(error));
    } finally {
      if (child !== undefined) await this.stopChild(child);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    const children = [...this.children];
    await Promise.all(children.map(child => this.stopChild(child)));
  }

  private stopChild(child: OwnedProcess): Promise<void> {
    const current = this.stopping.get(child);
    if (current !== undefined) return current;
    const stopping = (async () => {
      await child.terminate().catch(() => undefined);
      await child.exited.catch(() => ({ code: null, signal: "SIGKILL" }));
      this.children.delete(child);
    })().finally(() => this.stopping.delete(child));
    this.stopping.set(child, stopping);
    return stopping;
  }
}

function workerEnvironment(environment: REnvironment, resources: ApplicationResources): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) values[key] = value;
  for (const key of ["R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE", "R_PROFILE", "R_PROFILE_USER"]) delete values[key];
  Object.assign(values, rServiceEnvironmentVariables(environment, resources));
  return values;
}

async function collect(...streams: Array<NodeJS.ReadableStream | null>): Promise<string> {
  let output = "";
  await Promise.all(streams.map(stream => stream === null ? undefined : new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Uint8Array | string) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES / 2);
    });
    stream.once("end", resolve);
    stream.once("error", reject);
  })));
  return output.trim();
}

async function waitForExit(child: OwnedProcess, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ code: number | null; signal: string | null } | "cancelled" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); timer.unref(); });
  const cancelled = signal === undefined ? new Promise<never>(() => undefined) : new Promise<"cancelled">(resolve => {
    abort = () => resolve("cancelled");
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([child.exited, timeout, cancelled]);
    if (result === "cancelled" || result === "timeout") {
      await child.terminate().catch(() => undefined);
      await child.exited.catch(() => undefined);
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("package timeout must be a positive integer");
}

function failure(code: string, message: string, details?: unknown): PackageWorkerError {
  return new PackageWorkerError(code, message, details);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
