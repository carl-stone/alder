import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { ApplicationResources } from "./resources.js";

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

async function stopChild(child: ChildProcess, exited: OwnedProcess["exited"], termFirst: boolean): Promise<void> {
  if (termFirst) {
    signalChild(child, "SIGTERM");
    if (await waitForExit(exited, 1_000)) return;
  }
  signalChild(child, "SIGKILL");
  if (!await waitForExit(exited, 1_000)) {
    throw new Error(`owned process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
}

async function stopGroup(pid: number, child: ChildProcess, exited: OwnedProcess["exited"]): Promise<void> {
  const term = signalGroup(pid, "SIGTERM");
  if (term === "gone") return;
  if (term === "denied") return stopChild(child, exited, true);
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const state = signalGroup(pid, 0);
    if (state === "gone") return;
    if (state === "denied") return stopChild(child, exited, true);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (signalGroup(pid, "SIGKILL") === "denied") return stopChild(child, exited, false);
}

async function spawnChild(options: ProcessSpawnOptions): Promise<ChildHandle> {
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
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= stopGroup(pid, child, exited);
  const terminate = async (): Promise<void> => {
    await stop();
    if (!await waitForExit(exited, 1_000)) {
      throw new Error(`owned process ${pid} remained alive after termination`);
    }
    child.stdin?.destroy();
  };
  return {
    child, pid,
    stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, terminate, stop,
  };
}

export async function createProcessScope(_resources?: ApplicationResources): Promise<ProcessScope> {
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
        const child = await spawnChild(options);
        children.add(child);
        if (closing) {
          await child.terminate();
          children.delete(child);
          throw new Error("process scope is closed");
        }
        // A completed helper must not leave its ordinary descendants running.
        void child.exited.finally(async () => {
          await child.stop();
          children.delete(child);
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
        if (errors.length) throw new AggregateError(errors, "could not stop owned processes");
      })();
    },
  };
}
