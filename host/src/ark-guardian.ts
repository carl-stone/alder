import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";

// The backend holds stdin open as the liveness pipe. Its hard death closes that
// pipe even though an ordinary exit hook cannot run. fd 3 carries Ark stdin;
// fd 4 reports the exact Ark group leader.
const executable = process.argv[2];
if (!executable) throw new Error("Ark guardian requires an executable");
let arkPid: number | undefined;
let ownerGone = false;
let stopping: Promise<void> | undefined;

function signalGroup(signal: NodeJS.Signals | 0): boolean {
  if (arkPid === undefined) return false;
  try { process.kill(-arkPid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function stopGroup(): Promise<void> {
  return stopping ??= (async () => {
    if (!signalGroup("SIGTERM")) return;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (!signalGroup(0)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    signalGroup("SIGKILL");
  })();
}

const liveness = process.stdin;
const ownerExited = (): void => {
  ownerGone = true;
  if (arkPid !== undefined) void stopGroup().catch(() => { process.exitCode = 1; });
};
liveness.once("end", ownerExited);
liveness.once("error", ownerExited);
liveness.resume();
process.on("SIGTERM", ownerExited);
process.on("SIGINT", ownerExited);

const ark = spawn(executable, process.argv.slice(3), {
  cwd: process.cwd(), env: process.env, detached: true, stdio: [3, "inherit", "inherit"],
});
ark.once("spawn", () => {
  arkPid = ark.pid!;
  try { writeSync(4, JSON.stringify({ pid: arkPid }) + "\n"); }
  catch {
    ownerGone = true;
    void stopGroup().catch(() => { process.exitCode = 1; });
  } finally { closeSync(4); }
  if (ownerGone) void stopGroup().catch(() => { process.exitCode = 1; });
});
ark.once("error", error => {
  try { writeSync(4, JSON.stringify({ error: error.message }) + "\n"); } catch { /* backend may be gone */ }
  try { closeSync(4); } catch { /* already closed */ }
  liveness.destroy();
  process.exitCode = 1;
});
ark.once("exit", (code, signal) => {
  liveness.destroy();
  void stopGroup().then(() => { process.exitCode = code ?? (signal ? 1 : 0); }, () => { process.exitCode = 1; });
});
