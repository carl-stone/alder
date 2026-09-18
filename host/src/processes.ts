import { randomBytes } from "node:crypto";
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

interface ChildHandle extends OwnedProcess {
  child: ChildProcess;
  stop(): Promise<void>;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function stopGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (groupExists(pid)) signalGroup(pid, "SIGKILL");
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
  const stop = (): Promise<void> => stopping ??= stopGroup(pid);
  const terminate = async (): Promise<void> => {
    await stop();
    await exited;
    child.stdin?.destroy();
  };
  return {
    child, pid, startIdentity: `pid:${pid}:${options.environment.ALDER_PROCESS_NONCE ?? randomBytes(16).toString("hex")}`,
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
  pid: number; startIdentity: string; ready: Promise<void>;
}> {
  const timeout = options.readyTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new RangeError("invalid host readiness timeout");
  const processNonce = options.environment.ALDER_PROCESS_NONCE;
  const epoch = options.environment.ALDER_EPOCH;
  if (!processNonce || !epoch) throw new Error("host readiness requires process nonce and epoch");
  const nonce = randomBytes(32).toString("hex");
  const child = await spawnChild({
    executable: options.resources.nodeExecutable,
    args: [options.resources.hostEntry, "--internal-host", ...options.args],
    cwd: options.resources.root,
    environment: { ...options.environment, ALDER_PRIVATE_READY_NONCE: nonce },
    stdio: "pipes",
  });
  let diagnostics = "";
  child.stderr!.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-64 * 1024); });
  let timer: NodeJS.Timeout;
  const privateReady = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > 1024 * 1024) return reject(new Error("host readiness record is too large"));
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      child.stdout!.off("data", onData);
      try {
        const record = JSON.parse(buffered.slice(0, newline));
        if (record.type !== "alder.private.ready" || record.version !== 1 || record.nonce !== nonce ||
            record.pid !== child.pid || record.processNonce !== processNonce ||
            record.ready?.type !== "host.ready" || record.ready?.epoch !== epoch || typeof record.ready.origin !== "string") {
          throw new Error("host readiness authentication failed");
        }
        resolve(record.ready);
      } catch (error) { reject(error); }
    };
    child.stdout!.on("data", onData);
    child.stdout!.once("error", reject);
    void child.exited.then(() => reject(new Error("host exited before readiness")), reject);
  });
  const ready = Promise.race([
    privateReady.then(ready => options.authenticateReady({ ready, pid: child.pid, startIdentity: child.startIdentity, processNonce, epoch })),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host readiness timed out")), timeout); }),
  ]).then(() => {
    child.child.unref();
    child.stdout!.resume();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as typeof stream & { unref?: () => void })?.unref?.();
    }
  }).catch(async error => {
    await child.terminate();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostics.trim() ? "\n" + diagnostics.trim() : ""}`);
  }).finally(() => clearTimeout(timer));
  return { pid: child.pid, startIdentity: child.startIdentity, ready };
}
