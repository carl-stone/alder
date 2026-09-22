import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { basename, dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ApplicationResources } from "./resources.js";
import { DIAGNOSTIC_CHILD_TAIL_BYTES, diagnosticError, type DiagnosticSink } from "./diagnostics.js";

export interface ProcessSpawnOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
  stdio: "pipes" | "ignore";
  /** Keep this child group owned even if the shared backend is killed outright. */
  guardOnOwnerDeath?: boolean;
}

export interface OwnedProcess {
  readonly pid: number;
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

interface ChildHandle extends OwnedProcess {
  child: ChildProcess;
  diagnosticId: string;
  diagnosticRole: string;
  stop(): Promise<void>;
}

type SignalResult = "signalled" | "gone" | "denied";

function signalGroup(pid: number, signal: NodeJS.Signals | 0): SignalResult {
  try { process.kill(-pid, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "denied";
    throw error;
  }
  return "signalled";
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try { child.kill(signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

async function waitForExit(exited: OwnedProcess["exited"], timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref(); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcess, exited: OwnedProcess["exited"], termFirst: boolean, onSignal: (signal: "SIGTERM" | "SIGKILL") => void): Promise<void> {
  if (termFirst) {
    onSignal("SIGTERM");
    signalChild(child, "SIGTERM");
    if (await waitForExit(exited, 1_000)) return;
  }
  onSignal("SIGKILL");
  signalChild(child, "SIGKILL");
  if (!await waitForExit(exited, 1_000)) {
    throw new Error(`owned process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
}

async function stopGroup(pid: number, child: ChildProcess, exited: OwnedProcess["exited"], onSignal: (signal: "SIGTERM" | "SIGKILL") => void): Promise<void> {
  onSignal("SIGTERM");
  const term = signalGroup(pid, "SIGTERM");
  if (term === "gone") return;
  if (term === "denied") return stopChild(child, exited, true, onSignal);
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const state = signalGroup(pid, 0);
    if (state === "gone") return;
    if (state === "denied") return stopChild(child, exited, true, onSignal);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  onSignal("SIGKILL");
  if (signalGroup(pid, "SIGKILL") === "denied") return stopChild(child, exited, false, onSignal);
}

async function guardianProcessId(child: ChildProcess): Promise<number> {
  const control = child.stdio[4];
  if (!control || typeof control.on !== "function") throw new Error("Ark guardian control pipe is unavailable");
  return new Promise<number>((resolve, reject) => {
    let input = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Ark guardian did not report its child")), 5_000);
    const finish = (error?: Error, pid?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.off("data", onData);
      control.off("end", onEnd);
      control.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(pid!);
    };
    const onEnd = (): void => finish(new Error("Ark guardian closed its control pipe before reporting its child"));
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error("Ark guardian exited before reporting its child"));
    const onData = (chunk: Buffer): void => {
      input += chunk.toString("utf8");
      if (input.length > 1024) return finish(new Error("Ark guardian response is too large"));
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(input.slice(0, newline)) as { pid?: unknown; error?: unknown };
        if (typeof value.error === "string") return finish(new Error(value.error));
        if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return finish(new Error("Ark guardian returned an invalid child ID"));
        finish(undefined, value.pid as number);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    control.on("data", onData);
    control.once("end", onEnd);
    control.once("error", onError);
    child.once("exit", onExit);
  });
}

async function spawnChild(options: ProcessSpawnOptions, resources?: ApplicationResources, diagnostics?: DiagnosticSink): Promise<ChildHandle> {
  // A process group lets normal shutdown include children started by R or a helper.
  if (options.guardOnOwnerDeath && (!resources?.hostEntry || !resources.nodeExecutable || options.stdio !== "pipes")) {
    throw new Error("guarded Ark launch requires packaged Node, host resources, and pipes");
  }
  const child = options.guardOnOwnerDeath
    ? spawn(resources!.nodeExecutable, [join(dirname(resources!.hostEntry), "ark-guardian.mjs"), options.executable, ...options.args], {
      cwd: options.cwd, env: options.environment, detached: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    })
    : spawn(options.executable, [...options.args], {
      cwd: options.cwd, env: options.environment, detached: true,
      stdio: options.stdio === "pipes" ? ["pipe", "pipe", "pipe"] : "ignore",
    });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  await once(child, "spawn");
  let pid: number;
  try { pid = options.guardOnOwnerDeath ? await guardianProcessId(child) : child.pid!; }
  catch (error) {
    if (options.guardOnOwnerDeath) signalChild(child, "SIGTERM");
    throw error;
  }
  const ownedStdin = options.guardOnOwnerDeath ? child.stdio[3] as Writable | null : child.stdin;
  const childInstanceId = randomUUID();
  const childRole = basename(options.executable).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "child";
  let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0), stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const retainTail = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    const next = Buffer.concat([current, Buffer.from(chunk)]);
    return next.byteLength <= DIAGNOSTIC_CHILD_TAIL_BYTES ? next : next.subarray(next.byteLength - DIAGNOSTIC_CHILD_TAIL_BYTES);
  };
  setImmediate(() => {
    child.stdout?.on("data", (chunk: Buffer) => { stdoutTail = retainTail(stdoutTail, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrTail = retainTail(stderrTail, chunk); });
  });
  diagnostics?.record("info", "child.spawn", {
    childInstanceId, childRole, childPid: pid,
    executable: options.executable, argv: [...options.args], cwd: options.cwd,
    environment: { ...options.environment }, stdio: options.stdio,
  });
  void exited.then(result => diagnostics?.record(result.code === 0 ? "info" : "warn", "child.exit", {
    childInstanceId, childRole, childPid: pid, exitCode: result.code, signal: result.signal,
    outcome: result.code === 0 ? "success" : "error",
    stdoutTail: stdoutTail.toString("utf8"), stderrTail: stderrTail.toString("utf8"),
    stdoutTailBytes: stdoutTail.byteLength, stderrTailBytes: stderrTail.byteLength,
  }), error => diagnostics?.record("error", "child.exit", {
    childInstanceId, childRole, childPid: pid, outcome: "error",
    errorCode: (error as NodeJS.ErrnoException)?.code ?? "child_exit_failed",
    error: diagnosticError(error), stdoutTail: stdoutTail.toString("utf8"), stderrTail: stderrTail.toString("utf8"),
  }));
  let stopping: Promise<void> | undefined;
  const onSignal = (signal: "SIGTERM" | "SIGKILL"): void => diagnostics?.record(signal === "SIGKILL" ? "warn" : "info", signal === "SIGKILL" ? "child.kill" : "child.term", {
    childInstanceId, childRole, childPid: pid, signal,
  });
  const stop = (): Promise<void> => stopping ??= stopGroup(pid, child, exited, onSignal);
  const terminate = async (): Promise<void> => {
    diagnostics?.record("info", "child.cancel", { childInstanceId, childRole, childPid: pid });
    try { await stop(); }
    catch (error) {
      diagnostics?.record("error", "child.cleanup_failed", {
        childInstanceId, childRole, childPid: pid, outcome: "error",
        errorCode: (error as NodeJS.ErrnoException)?.code ?? "child_cleanup_failed",
        error: diagnosticError(error),
      });
      throw error;
    }
    if (!await waitForExit(exited, 1_000)) {
      throw new Error(`owned process ${pid} remained alive after termination`);
    }
    ownedStdin?.destroy();
    if (options.guardOnOwnerDeath) child.stdin?.destroy();
  };
  if (options.guardOnOwnerDeath) {
    void exited.finally(() => { ownedStdin?.destroy(); child.stdin?.destroy(); }).catch(() => {});
  }
  return {
    child, pid, diagnosticId: childInstanceId, diagnosticRole: childRole,
    stdin: ownedStdin, stdout: child.stdout, stderr: child.stderr, exited, terminate, stop,
  };
}

export async function createProcessScope(resources?: ApplicationResources, diagnostics?: DiagnosticSink): Promise<ProcessScope> {
  const children = new Set<ChildHandle>();
  const pending = new Set<Promise<OwnedProcess>>();
  let closing: Promise<void> | undefined;
  const onExit = (): void => {
    for (const child of children) {
      try { signalGroup(child.pid, "SIGTERM"); } catch { /* best effort during process exit */ }
    }
  };
  process.once("exit", onExit);
  return {
    spawn(options) {
      if (closing) return Promise.reject(new Error("process scope is closed"));
      const operation = (async () => {
        const child = await spawnChild(options, resources, diagnostics);
        children.add(child);
        if (closing) {
          await child.terminate();
          children.delete(child);
          throw new Error("process scope is closed");
        }
        // A completed helper must not leave its ordinary descendants running.
        void child.exited.finally(async () => {
          try { await child.stop(); }
          catch (error) {
            diagnostics?.record("error", "child.cleanup_failed", {
              childInstanceId: child.diagnosticId, childRole: child.diagnosticRole, childPid: child.pid, outcome: "error",
              errorCode: (error as NodeJS.ErrnoException)?.code ?? "ordinary_exit_cleanup_failed",
              error: diagnosticError(error),
            });
          } finally { children.delete(child); }
        }).catch(() => {});
        return child;
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => {});
      return operation;
    },
    close() {
      return closing ??= (async () => {
        await Promise.allSettled([...pending]);
        const stopped = await Promise.allSettled([...children].map(child => child.terminate()));
        children.clear();
        process.off("exit", onExit);
        const errors = stopped.filter(result => result.status === "rejected").map(result => result.reason);
        if (errors.length) diagnostics?.record("error", "process_scope.cleanup_failed", {
          count: errors.length, outcome: "error", errorCode: "process_cleanup_failed",
          errors: errors.map(error => diagnosticError(error)),
        });
        if (errors.length) throw new AggregateError(errors, "could not stop owned processes");
      })();
    },
  };
}
