import { createRequire as __alderCreateRequire } from 'node:module'; const require = __alderCreateRequire(import.meta.url);

// src/ark-guardian.ts
import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";
var executable = process.argv[2];
if (!executable) throw new Error("Ark guardian requires an executable");
var arkPid;
var ownerGone = false;
var stopping;
function signalGroup(signal) {
  if (arkPid === void 0) return false;
  try {
    process.kill(-arkPid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function stopGroup() {
  return stopping ??= (async () => {
    if (!signalGroup("SIGTERM")) return;
    const deadline = Date.now() + 1e3;
    while (Date.now() < deadline) {
      if (!signalGroup(0)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    signalGroup("SIGKILL");
  })();
}
var liveness = process.stdin;
var ownerExited = () => {
  ownerGone = true;
  if (arkPid !== void 0) void stopGroup().catch(() => {
    process.exitCode = 1;
  });
};
liveness.once("end", ownerExited);
liveness.once("error", ownerExited);
liveness.resume();
process.on("SIGTERM", ownerExited);
process.on("SIGINT", ownerExited);
var ark = spawn(executable, process.argv.slice(3), {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: [3, "inherit", "inherit"]
});
ark.once("spawn", () => {
  arkPid = ark.pid;
  try {
    writeSync(4, JSON.stringify({ pid: arkPid }) + "\n");
  } catch {
    ownerGone = true;
    void stopGroup().catch(() => {
      process.exitCode = 1;
    });
  } finally {
    closeSync(4);
  }
  if (ownerGone) void stopGroup().catch(() => {
    process.exitCode = 1;
  });
});
ark.once("error", (error) => {
  try {
    writeSync(4, JSON.stringify({ error: error.message }) + "\n");
  } catch {
  }
  try {
    closeSync(4);
  } catch {
  }
  liveness.destroy();
  process.exitCode = 1;
});
ark.once("exit", (code, signal) => {
  liveness.destroy();
  void stopGroup().then(() => {
    process.exitCode = code ?? (signal ? 1 : 0);
  }, () => {
    process.exitCode = 1;
  });
});
