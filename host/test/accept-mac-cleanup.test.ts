import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cleanupOwnedProcesses, waitForOwnedExit } from "../scripts/native-process-cleanup.mjs";

test("packaged Mac check failure exits owned runtime before removing temporary files", {
  skip: process.platform !== "darwin" || !process.env.ALDER_ACCEPT_MAC_APP, timeout: 120_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alder-accept-failure-test-"));
  const app = resolve(process.env.ALDER_ACCEPT_MAC_APP!);
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/accept-mac.mjs");
  const child = spawn(process.execPath, [script, app], {
    cwd: resolve(dirname(script), "../.."),
    env: { ...process.env, TMPDIR: temporary, ALDER_ACCEPT_MAC_FAIL_AFTER_START: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtimeDirectory = join("/tmp", `alder-mac-accept-${child.pid}`);
  const stderr: Buffer[] = [];
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); rejectExit(new Error("packaged Mac failure check timed out")); }, 90_000);
      child.once("error", error => { clearTimeout(timer); rejectExit(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
    });
    assert.notEqual(exit.code, 0);
    assert.match(Buffer.concat(stderr).toString("utf8"), /injected packaged check failure after runtime startup/);
    await waitForOwnedExit(new Set([child.pid!]), runtimeDirectory, 1_000);
    assert.deepEqual((await readdir(temporary)).filter(name => name.startsWith("alder-mac-accept-")), []);
    await assert.rejects(stat(runtimeDirectory), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await cleanupOwnedProcesses(new Set([child.pid!]), runtimeDirectory);
    await rm(temporary, { recursive: true, force: true });
  }
});
