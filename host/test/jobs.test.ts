import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PackageWorker, PackageWorkerError } from "../src/jobs.js";
import { createProcessScope, type OwnedProcess, type ProcessScope } from "../src/processes.js";
import type { ApplicationResources } from "../src/resources.js";

function resources(directory: string): ApplicationResources {
  return {
    root: directory,
    cliLauncher: join(directory, "alder"),
    hostEntry: join(directory, "host.mjs"),
    rendererDirectory: directory,
    workerDirectory: directory,
    rLibraryDirectory: directory,
    arkExecutable: join(directory, "ark"),
    airExecutable: join(directory, "air"),
    quartoExecutable: join(directory, "quarto"),
    nodeExecutable: process.execPath,
    electronEntry: null,
  };
}

function environment(rscript: string, directory: string) {
  return {
    rscript,
    rHome: directory,
    version: "4.6.0",
    platform: process.platform,
    arch: process.arch,
    libraryPaths: [directory],
    identity: "package-fixture",
  };
}

test("a package operation cancelled as its worker starts terminates the selected R process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-package-cancel-"));
  const rscript = join(directory, "Rscript");
  await writeFile(rscript, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  await chmod(rscript, 0o755);
  const processScope = await createProcessScope();
  const cancellation = new AbortController();
  const worker = new PackageWorker({
    resources: resources(directory),
    environment: environment(rscript, directory),
    processScope,
    projectDirectory: directory,
    onProgress: event => {
      if (event.phase === "started") cancellation.abort();
    },
  });
  try {
    await assert.rejects(
      worker.run("install", { packages: ["fixture"] }, { signal: cancellation.signal }),
      (error: unknown) => error instanceof PackageWorkerError && error.code === "cancelled",
    );
  } finally {
    await worker.close();
    await processScope.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing during a delayed package spawn waits for and terminates the eventual child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-package-close-race-"));
  let releaseSpawn!: (child: OwnedProcess) => void;
  let spawnStarted!: () => void;
  const started = new Promise<void>(resolve => { spawnStarted = resolve; });
  const delayed = new Promise<OwnedProcess>(resolve => { releaseSpawn = resolve; });
  let finishExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    finishExit = () => resolve({ code: null, signal: "SIGTERM" });
  });
  let terminations = 0;
  const child: OwnedProcess = {
    pid: 101,
    stdin: null,
    stdout: null,
    stderr: null,
    exited,
    terminate: async () => { terminations += 1; finishExit(); },
  };
  const processScope: ProcessScope = {
    spawn: async () => { spawnStarted(); return delayed; },
    close: async () => undefined,
  };
  const worker = new PackageWorker({
    resources: resources(directory),
    environment: environment(join(directory, "Rscript"), directory),
    processScope,
    projectDirectory: directory,
  });
  try {
    const running = worker.run("status", { packages: [] });
    await started;
    const closing = worker.close();
    releaseSpawn(child);
    await closing;
    await assert.rejects(running, (error: unknown) => error instanceof PackageWorkerError && error.code === "job_closed");
    assert.equal(terminations, 1);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a progress callback failure terminates and awaits the spawned package child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-package-progress-failure-"));
  let finishExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    finishExit = () => resolve({ code: null, signal: "SIGTERM" });
  });
  let terminated = false;
  const child: OwnedProcess = {
    pid: 102,
    stdin: null,
    stdout: null,
    stderr: null,
    exited,
    terminate: async () => { terminated = true; finishExit(); },
  };
  const worker = new PackageWorker({
    resources: resources(directory),
    environment: environment(join(directory, "Rscript"), directory),
    processScope: { spawn: async () => child, close: async () => undefined },
    projectDirectory: directory,
    onProgress: () => { throw new Error("progress unavailable"); },
  });
  try {
    await assert.rejects(worker.run("status", { packages: [] }), /progress unavailable/);
    assert.equal(terminated, true);
    await exited;
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
