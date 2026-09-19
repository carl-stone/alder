import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ApplicationResources } from "./resources.js";
import type { DiagnosticSink } from "./diagnostics.js";

export interface ProcessSpawnOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
  stdio: "pipes" | "ignore";
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

async function spawnChild(options: ProcessSpawnOptions, diagnostics?: DiagnosticSink): Promise<ChildHandle> {
  // A process group lets normal shutdown include children started by R or a helper.
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd, env: options.environment, detached: true,
    stdio: options.stdio === "pipes" ? ["pipe", "pipe", "pipe"] : "ignore",
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  await once(child, "spawn");
  const pid = child.pid!;
  const childInstanceId = randomUUID();
  const childRole = basename(options.executable).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "child";
  diagnostics?.record("info", "child.spawn", { childInstanceId, childRole, childPid: pid });
  void exited.then(result => diagnostics?.record(result.code === 0 ? "info" : "warn", "child.exit", {
    childInstanceId, childRole, childPid: pid, exitCode: result.code, signal: result.signal,
    outcome: result.code === 0 ? "success" : "error",
  }), error => diagnostics?.record("error", "child.exit", {
    childInstanceId, childRole, childPid: pid, outcome: "error",
    errorCode: (error as NodeJS.ErrnoException)?.code ?? "child_exit_failed",
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
      });
      throw error;
    }
    if (!await waitForExit(exited, 1_000)) {
      throw new Error(`owned process ${pid} remained alive after termination`);
    }
    child.stdin?.destroy();
  };
  return {
    child, pid, diagnosticId: childInstanceId, diagnosticRole: childRole,
    stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, terminate, stop,
  };
}

export async function createProcessScope(_resources?: ApplicationResources, diagnostics?: DiagnosticSink): Promise<ProcessScope> {
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
        const child = await spawnChild(options, diagnostics);
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
        });
        if (errors.length) throw new AggregateError(errors, "could not stop owned processes");
      })();
    },
  };
}
