import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookBackend } from "../src/backend.js";
import { RecoveryWriter } from "../src/recovery.js";
import { acquireNotebookOwnership, acquireNotebookSession, SessionUnavailableError, type HostLaunchOptions } from "../src/sessions.js";
import type { SessionConnection } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";

function sessionKey(path: string): string {
  return createHash("sha256").update("path:" + path).digest("hex");
}

test("shared backend deduplicates simultaneous opens and owns distinct documents in one process", { timeout: 15_000 }, async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-shared-backend-")));
  const runtimeDirectory = join(root, "runtime");
  const rendererDirectory = join(root, "renderer");
  const workerDirectory = join(root, "worker");
  await mkdir(rendererDirectory);
  await mkdir(workerDirectory);
  await writeFile(join(rendererDirectory, "index.html"), "<!doctype html><title>Alder</title>");
  const firstPath = join(root, "first.R"), secondPath = join(root, "second.R");
  await writeFile(firstPath, "# %%\nfirst <- 1\n");
  await writeFile(secondPath, "# %%\nsecond <- 2\n");
  const resources: ApplicationResources = {
    root, rendererDirectory, workerDirectory,
    nodeExecutable: process.execPath,
    hostEntry: join(root, "host.mjs"),
    cliLauncher: join(root, "alder"),
    rLibraryDirectory: join(root, "no-r-library"),
    arkExecutable: join(root, "no-ark"),
    airExecutable: join(root, "no-air"),
    electronEntry: null,
    processSupervisorExecutable: "",
  };
  // Keep the real recovery writer inside this fixture's temporary directory.
  const openRecovery = RecoveryWriter.open.bind(RecoveryWriter);
  context.mock.method(RecoveryWriter, "open", options => openRecovery({ ...options, rootDir: join(root, "recovery") }));
  const backend = new NotebookBackend(resources);
  const connections: SessionConnection[] = [];
  const options = (path: string): HostLaunchOptions => ({
    path, sessionKey: sessionKey(path), runtimeDirectory,
    rscript: join(root, "no-Rscript"), deferStartup: true, runOnStartup: false,
  });
  const attach = async (path: string): Promise<SessionConnection> => {
    const connection = await acquireNotebookSession({
      path, runtimeDirectory, resources, startupTimeoutMs: 2_000,
      launchHost: async () => { throw new Error("backend document should already be open"); },
    });
    connections.push(connection);
    return connection;
  };
  try {
    await Promise.all([backend.open(options(firstPath)), backend.open(options(firstPath)), backend.open(options(firstPath))]);
    const first = await attach(firstPath);
    const same = await attach(firstPath);
    assert.equal(first.epoch, same.epoch);
    assert.equal(first.sessionKey, same.sessionKey);
    assert.notEqual(first.leaseId, same.leaseId);
    await assert.rejects(acquireNotebookOwnership({ path: firstPath, runtimeDirectory }), SessionUnavailableError);

    await backend.open(options(secondPath));
    const second = await attach(secondPath);
    const firstRegistry = JSON.parse(await readFile(join(runtimeDirectory, sessionKey(firstPath) + ".json"), "utf8"));
    const secondRegistry = JSON.parse(await readFile(join(runtimeDirectory, sessionKey(secondPath) + ".json"), "utf8"));
    assert.equal(firstRegistry.pid, process.pid);
    assert.equal(secondRegistry.pid, firstRegistry.pid);
    assert.notEqual(first.epoch, second.epoch);
    assert.notEqual(first.origin, second.origin);
    assert.deepEqual((await readdir(runtimeDirectory)).filter(name => name.endsWith(".json")).sort(), [sessionKey(firstPath) + ".json", sessionKey(secondPath) + ".json"].sort());
    for (const [connection, path] of [[first, firstPath], [second, secondPath]] as const) {
      const identityResponse = await connection.request("/api/identity");
      assert.equal(identityResponse.status, 200);
      const identity = await identityResponse.json() as { canonicalPath: string; documentReady: boolean };
      assert.equal(identity.canonicalPath, path);
      assert.equal(identity.documentReady, true);
    }
  } finally {
    await Promise.allSettled(connections.map(connection => connection.release()));
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});
