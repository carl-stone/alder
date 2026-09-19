import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PackageWorker, PackageWorkerError } from "../src/jobs.js";
import { createProcessScope } from "../src/processes.js";
import type { ApplicationResources } from "../src/resources.js";

test("a package operation cancelled as its worker starts terminates the selected R process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-package-cancel-"));
  const rscript = join(directory, "Rscript");
  await writeFile(rscript, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  await chmod(rscript, 0o755);
  const resources: ApplicationResources = {
    root: directory,
    cliLauncher: join(directory, "alder"),
    hostEntry: join(directory, "host.mjs"),
    rendererDirectory: directory,
    workerDirectory: directory,
    rLibraryDirectory: directory,
    arkExecutable: join(directory, "ark"),
    airExecutable: join(directory, "air"),
    nodeExecutable: process.execPath,
    processSupervisorExecutable: join(directory, "supervisor"),
    electronEntry: null,
  };
  const processScope = await createProcessScope();
  const cancellation = new AbortController();
  const worker = new PackageWorker({
    resources,
    environment: {
      rscript,
      rHome: directory,
      version: "4.6.0",
      platform: process.platform,
      arch: process.arch,
      libraryPaths: [directory],
      identity: "cancel-fixture",
    },
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
