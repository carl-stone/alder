import { execFileSync } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Engine } from "../src/engine.ts";
import { createProcessScope } from "../src/processes.ts";

const [rootArg, rscriptArg, notebookArg] = process.argv.slice(2);
if (!rootArg || !rscriptArg || !notebookArg) throw new Error("usage: ark-preflight ROOT RSCRIPT NOTEBOOK_DIR");
const root = resolve(rootArg);
const rscript = executableArgument(rscriptArg);
const notebookDirectory = resolve(notebookArg);
const resourcePrefix = await findResourcePrefix(root);
const resourceRoot = join(root, resourcePrefix);
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const resources = {
  root,
  cliLauncher: process.platform === "darwin"
    ? join(root, "MacOS", "alder")
    : join(root, "bin", process.platform === "win32" ? "alder.cmd" : "alder"),
  hostEntry: join(resourceRoot, "host", "alder-host.mjs"),
  rendererDirectory: join(resourceRoot, "app"),
  workerDirectory: join(resourceRoot, "worker"),
  rLibraryDirectory: join(resourceRoot, "r-library"),
  arkExecutable: join(resourceRoot, "runtime", `ark${executableSuffix}`),
  airExecutable: join(resourceRoot, "runtime", `air${executableSuffix}`),
  nodeExecutable: join(resourceRoot, "runtime", `node${executableSuffix}`),
  processSupervisorExecutable: join(resourceRoot, "runtime", `alder-process-supervisor${executableSuffix}`),
  electronEntry: null,
};
const requiredDirectories = [resources.rendererDirectory, resources.workerDirectory, resources.rLibraryDirectory];
const requiredFiles = [
  resources.hostEntry,
  join(resources.workerDirectory, "host-ark.R"),
  join(resources.workerDirectory, "host-analyzer.R"),
  join(resources.workerDirectory, "host-framing.R"),
  resources.arkExecutable,
  resources.airExecutable,
  resources.nodeExecutable,
  resources.processSupervisorExecutable,
];
for (const path of requiredDirectories) {
  if (!(await stat(path)).isDirectory()) throw new Error(`preflight directory invalid: ${path}`);
}
for (const path of requiredFiles) {
  if (!(await stat(path)).isFile()) throw new Error(`preflight resource invalid: ${path}`);
}
const rHome = execFileSync(rscript, ["--vanilla", "-e", "cat(normalizePath(R.home(), winslash='/', mustWork=TRUE))"], { encoding: "utf8", env: cleanEnvironment() }).trim();
const rIdentity = execFileSync(rscript, ["--vanilla", "-e", "cat(as.character(getRversion()), \"\\n\", R.version$platform, \"\\n\", R.version$arch, sep=\"\")"], { encoding: "utf8", env: cleanEnvironment() }).trim().split(/\r?\n/);
if (rIdentity.length < 3 || !rIdentity[0] || !rIdentity[1] || !rIdentity[2]) throw new Error(`r_invalid: Rscript did not report a complete identity: ${rIdentity.join("|")}`);
const normalLibraries = execFileSync(rscript, ["--vanilla", "-e", "writeLines(.libPaths())"], { encoding: "utf8", env: cleanEnvironment() }).trim().split(/\r?\n/).filter(Boolean);
const environment = {
  rscript,
  rHome,
  version: rIdentity[0],
  platform: process.platform,
  arch: rIdentity[2],
  libraryPaths: [...new Set([resources.rLibraryDirectory, ...normalLibraries])],
  identity: `stage-preflight:${rIdentity.join(":")}`,
};
const processScope = await createProcessScope(resources);
const artifacts = join(root, ".preflight-artifacts");
const cache = join(root, ".preflight-cache");
await mkdir(artifacts, { recursive: true });
await mkdir(cache, { recursive: true });
const engine = new Engine({ resources, processScope, environment, notebookDirectory, artifactDirectory: artifacts, cacheDirectory: cache, startupTimeoutMs: 90_000, shutdownTimeoutMs: 10_000 });
try {
  const handshake = await engine.start();
  if (handshake.kernel?.buildVersion !== "0.1.252-alder.1" || handshake.kernel?.mimePublisher !== "alder-json-v1") throw new Error("Ark build or public MIME publisher qualification missing");
  process.stdout.write(JSON.stringify({ rscript, rVersion: environment.version, kernel: handshake.kernel, analyzer: handshake.analyzer }) + "\n");
} finally {
  await engine.close().catch(() => {});
  await processScope.close().catch(() => {});
  await rm(artifacts, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
}

async function findResourcePrefix(rootDirectory: string): Promise<string> {
  for (const candidate of ["resources", "Resources"]) {
    try {
      if ((await stat(join(rootDirectory, candidate))).isDirectory()) return candidate;
    } catch {
      // Try the platform's alternate application-resource spelling.
    }
  }
  throw new Error(`preflight resource root missing under ${rootDirectory}`);
}

function executableArgument(value: string): string {
  return value.includes("/") || value.includes("\\") ? resolve(value) : value;
}


function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === "R_HOME" || key.startsWith("R_LIBS") || key.startsWith("ALDER_")) delete env[key];
  return env;
}
