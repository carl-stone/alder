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

function groupExists(pid: number): boolean {
  return signalGroup(pid, 0) === "signalled";
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try { child.kill(signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

async function stopGroup(pid: number, child: ChildProcess): Promise<void> {
  if (signalGroup(pid, "SIGTERM") === "denied") signalChild(child, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (groupExists(pid) && signalGroup(pid, "SIGKILL") === "denied") {
    signalChild(child, "SIGKILL");
  }
}

async function settleExit(exited: OwnedProcess["exited"]): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited.then(() => undefined, () => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); timer.unref(); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const stop = (): Promise<void> => stopping ??= stopGroup(pid, child);
  const terminate = async (): Promise<void> => {
    await stop();
    await settleExit(exited);
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
