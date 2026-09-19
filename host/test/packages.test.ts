import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PackageManager,
  readPackageDeclarations,
} from "../src/packages.js";
import { PackageJobs } from "../src/jobs.js";
import type { ApplicationResources } from "../src/resources.js";
import type { ProcessScope } from "../src/processes.js";

const execFile = promisify(execFileCallback);
test("package metadata rejects invalid mapping without mutation", async () => {
  const fixture = await packageFixture();
  try {
    const metadata = join(fixture.directory, ".alder", "packages.yaml");
    await mkdir(join(fixture.directory, ".alder"), { recursive: true });
    for (const source of ["packages: [jsonlite]\nextra: true\n", "packages: !evil [jsonlite]\n", "packages: [jsonlite]\npackages: [yaml]\n"]) {
      await writeFile(metadata, source);
      await assert.rejects(readPackageDeclarations(fixture.directory), { code: "package_metadata_error" });
      assert.equal(await readFile(metadata, "utf8"), source);
    }
  } finally {
    await fixture.remove();
  }
});

test("unresolved R fails package installation before creating a project library", async () => {
  const fixture = await packageFixture();
  try {
    let spawned = 0;
    const processScope: ProcessScope = {
      spawn: async () => { spawned += 1; throw new Error("must not spawn"); },
      close: async () => undefined,
    };
    const manager = new PackageManager({ ...fixture.options, processScope, environment: null });
    const result = await manager.install(["jsonlite"], { operationId: "op-packages" });
    assert.equal(result.ok, false);
    assert.equal(result.mutatedLibrary, false);
    assert.equal(result.result, null);
    assert.equal(result.error?.code, "r_not_found");
    assert.equal(spawned, 0);
    await assert.rejects(stat(join(fixture.directory, ".alder", "library")), { code: "ENOENT" });
    await manager.close();
  } finally {
    await fixture.remove();
  }
});

test("package status does not advertise an absent project library", async () => {
  const fixture = await packageFixture();
  try {
    const manager = new PackageManager({ ...fixture.options, environment: null });
    manager.jobs.run = async (_kind, payload) => {
      assert.equal(payload.libraryPath, null);
      return { ok: true, status: "installed", records: [], library: null };
    };
    const result = await manager.status();
    assert.equal(result.library, null);
    await assert.rejects(stat(join(fixture.directory, ".alder", "library")), { code: "ENOENT" });
    await manager.close();
  } finally {
    await fixture.remove();
  }
});

test("package job input rejects invalid timeout before any process starts", () => {
  const processScope: ProcessScope = {
    spawn: async () => { throw new Error("must not spawn"); },
    close: async () => undefined,
  };
  assert.throws(() => new PackageJobs({
    resources: resourceFixture("/tmp/alder-jobs"),
    environment: null,
    processScope,
    projectDirectory: "/tmp/alder-project",
    timeoutMs: 0,
  }), /timeout must be an integer/);
});
test("package worker rejects an outside worker before sourcing its bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-worker-containment-"));
  try {
    const resourcesRoot = join(root, "resources");
    const workerDirectory = join(resourcesRoot, "worker");
    const privateLibrary = join(root, "r-library");
    const outsideDirectory = join(root, "outside");
    const markerPath = join(root, "bootstrap-sourced");
    await mkdir(workerDirectory, { recursive: true });
    await mkdir(privateLibrary, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, "host-bootstrap.R"),
      "writeLines(\"sourced\", " + JSON.stringify(markerPath) + ")\n");
    const packageJob = fileURLToPath(new URL("../../inst/worker/package-job.R", import.meta.url));
    const inputPath = join(root, "input.json");
    const resultPath = join(root, "result.json");
    await writeFile(inputPath, JSON.stringify({ command: "status", payload: {} }));
    await assert.rejects(execFile(process.env.RSCRIPT ?? "Rscript", [
      "--vanilla", packageJob, inputPath, resultPath,
    ], {
      cwd: root,
      env: {
        ...process.env,
        ALDER_RESOURCES_ROOT: resourcesRoot,
        ALDER_WORKER_DIR: outsideDirectory,
        ALDER_R_PRIVATE_LIBRARY: privateLibrary,
      },
    }), error => {
      assert.match(String((error as { stderr?: string }).stderr ?? ""),
        /contained inside application resources/);
      return true;
    });
    await assert.rejects(stat(markerPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package status runs in the selected project R environment without changing the host", async () => {
  const fixture = await packageFixture();
  try {
    await mkdir(join(fixture.directory, ".alder"), { recursive: true });
    await writeFile(join(fixture.directory, ".alder", "packages.yaml"), "packages: [jsonlite]\n");
    const environment = {
      rscript: "/selected/R/bin/Rscript",
      rHome: "/selected/R/lib/R",
      version: "4.6.1",
      platform: process.platform,
      arch: process.arch,
      libraryPaths: ["/selected/R/library"],
      identity: "selected-r",
    };
    const originalRHome = process.env.R_HOME;
    let spawnOptions: Parameters<ProcessScope["spawn"]>[0] | undefined;
    const processScope: ProcessScope = {
      spawn: async (options) => {
        spawnOptions = options;
        const outputPath = String(options.args.at(-1));
        await writeFile(outputPath, JSON.stringify({ ok: true, result: {
          ok: true,
          status: "installed",
          library: null,
          records: [{ package: "jsonlite", status: "installed", version: "2.0.0", library: "/selected/R/library" }],
        }}));
        return {
          pid: 1,
          startIdentity: "selected-r-fixture",
          stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
          stdout: Readable.from([]),
          stderr: null,
          exited: Promise.resolve({ code: 0, signal: null }),
          terminate: async () => undefined,
        };
      },
      close: async () => undefined,
    };
    const manager = new PackageManager({ ...fixture.options, processScope, environment });
    const status = await manager.status();
    assert.equal(status.installed[0], "jsonlite");
    assert.equal(spawnOptions?.executable, environment.rscript);
    assert.equal(spawnOptions?.cwd, fixture.directory);
    assert.equal(spawnOptions?.environment.R_HOME, environment.rHome);
    assert.equal(spawnOptions?.environment.ALDER_R_LIBRARIES, JSON.stringify(environment.libraryPaths));
    assert.equal(process.env.R_HOME, originalRHome);
    await manager.close();
  } finally {
    await fixture.remove();
  }
});

test("renv lock rejects an undeclared package before starting the worker", async () => {
  const fixture = await packageFixture();
  try {
    await writeFile(join(fixture.directory, "renv.lock"), JSON.stringify({
      R: { Version: "4.6.1", Repositories: [] },
      Packages: { jsonlite: { Package: "jsonlite", Version: "2.0.0", Source: "Repository", Repository: "CRAN" } },
    }));
    let spawned = 0;
    const processScope: ProcessScope = {
      spawn: async () => { spawned += 1; throw new Error("must not spawn"); },
      close: async () => undefined,
    };
    const manager = new PackageManager({ ...fixture.options, processScope, environment: null });
    await assert.rejects(manager.install(["yaml"]), { code: "package_metadata_error" });
    assert.equal(spawned, 0);
    await assert.rejects(stat(join(fixture.directory, ".alder", "library")), { code: "ENOENT" });
    await manager.close();
  } finally {
    await fixture.remove();
  }
});

interface WorkerPackageResponse {
  readonly ok: boolean;
  readonly result: {
    readonly ok: boolean;
    readonly status: string;
    readonly library: string | null;
    readonly records: Array<{
      readonly package: string;
      readonly status: string;
      readonly version: string | null;
      readonly library: string | null;
    }>;
  };
}

async function runPackageWorker(projectDirectory: string, request: unknown): Promise<WorkerPackageResponse> {
  const workerDirectory = join(projectDirectory, "worker");
  const helperLibrary = fileURLToPath(new URL("../.application/resources/r-library", import.meta.url));
  await mkdir(workerDirectory, { recursive: true });
  const packageJob = fileURLToPath(new URL("../../inst/worker/package-job.R", import.meta.url));
  const framing = fileURLToPath(new URL("../../inst/worker/host-framing.R", import.meta.url));
  await writeFile(join(workerDirectory, "host-framing.R"), await readFile(framing, "utf8"));
  await writeFile(join(workerDirectory, "host-bootstrap.R"),
    ".alder_worker_bootstrap <- function() list(workerDirectory = normalizePath(Sys.getenv(\"ALDER_WORKER_DIR\"), mustWork = TRUE))\n");
  const inputPath = join(projectDirectory, "worker-input.json");
  const resultPath = join(projectDirectory, "worker-result.json");
  await writeFile(inputPath, JSON.stringify(request));
  try {
    await execFile(process.env.RSCRIPT ?? "Rscript", ["--vanilla", packageJob, inputPath, resultPath], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        ALDER_RESOURCES_ROOT: projectDirectory,
        ALDER_WORKER_DIR: workerDirectory,
        ALDER_R_PRIVATE_LIBRARY: join(projectDirectory, "r-library"),
        R_LIBS: helperLibrary,
        R_LIBS_USER: helperLibrary,
        R_LIBS_SITE: helperLibrary,
        RENV_PATHS_CACHE: join(projectDirectory, "renv-cache"),
        RENV_CONFIG_AUTOLOADER_ENABLED: "FALSE",
        RENV_CONFIG_PAK_ENABLED: "FALSE",
      },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw error;
  }
  const result = JSON.parse(await readFile(resultPath, "utf8")) as WorkerPackageResponse;
  return result;
}
test("package worker accepts ordinary JSON object keys", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "alder-package-worker-json-"));
  try {
    const response = await runPackageWorker(projectDirectory, {
      command: "status",
      payload: {
        projectDirectory,
        packages: [],
        mode: "pak",
        lockfilePath: null,
        libraryPath: null,
        libraryPaths: [],
      },
    });
    assert.equal(response.ok, true);
    assert.equal(response.result.ok, true);
    assert.equal(response.result.status, "installed");
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

async function packageFixture(): Promise<{
  directory: string;
  options: {
    resources: ApplicationResources;
    processScope: ProcessScope;
    projectDirectory: string;
  };
  remove: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "alder-packages-"));
  const processScope: ProcessScope = {
    spawn: async () => { throw new Error("package metadata must not spawn"); },
    close: async () => undefined,
  };
  return {
    directory,
    options: { resources: resourceFixture(directory), processScope, projectDirectory: directory },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

function resourceFixture(root: string): ApplicationResources {
  return {
    root,
    cliLauncher: join(root, "bin", "alder"),
    hostEntry: join(root, "host.mjs"),
    rendererDirectory: join(root, "renderer"),
    workerDirectory: join(root, "worker"),
    rLibraryDirectory: join(root, "r-library"),
    arkExecutable: join(root, "bin", "ark"),
    airExecutable: join(root, "bin", "air"),
    nodeExecutable: join(root, "bin", "node"),
    processSupervisorExecutable: join(root, "bin", "alder-process-supervisor"),
    electronEntry: null,
  };
}
