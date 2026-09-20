import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { cleanupOwnedProcesses, waitForOwnedExit } from "../scripts/native-process-cleanup.mjs";

test("native cleanup reports a synthetic survivor before exact fallback teardown", async () => {
  const temporary = await mkdtemp("/tmp/alder-native-cleanup-test-");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", temporary], { stdio: "ignore" });
  const ownedPids = new Set([child.pid!]);
  try {
    await assert.rejects(waitForOwnedExit(ownedPids, temporary, 100), error => {
      assert.match((error as Error).message, new RegExp(String(child.pid)));
      return true;
    });
    const cleanup = await cleanupOwnedProcesses(ownedPids, temporary);
    assert.equal(cleanup.fallbackRequired, true);
    assert.ok(cleanup.terminatedPids.includes(child.pid!));
    await waitForOwnedExit(ownedPids, temporary, 1_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(temporary, { recursive: true, force: true });
  }
});
