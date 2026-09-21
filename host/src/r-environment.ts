import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  verifiedApplicationManifest,
  type ApplicationManifest,
  type ApplicationResources,
} from "./resources.js";
import { rEnvironmentSchema, type REnvironment } from "./protocol.js";
import { rLoaderEnvironment, rPlatform, type RPlatform } from "./r-platform.js";
const execFileAsync = promisify(execFile);
const R_VERSION_RANGE = ">=4.6.0 <4.7.0";
const R_PROBE_TIMEOUT_MS = 10_000;


export interface ResolveREnvironmentOptions {
  signal?: AbortSignal;
  rscript?: string;
  projectDirectory: string;
  resources: ApplicationResources;
  resolveProjectLibrary?: (base: REnvironment) => Promise<string | null>;
}

export type REnvironmentErrorCode = "r_not_found" | "r_invalid" | "r_unsupported";

export class REnvironmentError extends Error {
  constructor(
    readonly code: REnvironmentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "REnvironmentError";
  }
}

interface RProbe {
  rHome: string;
  version: string;
  platform: string;
  arch: string;
  libraryPaths: string[];
  baseLibrary: string;
}

export async function resolveREnvironment(options: ResolveREnvironmentOptions): Promise<REnvironment> {
  options.signal?.throwIfAborted();
  const platformServices = currentRPlatform();
  const resources = options.resources;
  const manifest = await verifiedApplicationManifest(resources).catch((error) => {
    if (error instanceof REnvironmentError) throw error;
    throw invalid(`application manifest cannot be read while selecting R: ${messageOf(error)}`);
  });
  await validateHelperLibrary(resources);
  const selected = await selectRscript(options.rscript, resources.electronEntry !== null, platformServices);
  const probe = await probeR(selected, options.signal);
  const version = normalizeVersion(probe.version);
  if (!/^4\.6\./.test(version)) throw unsupported(version);
  const rHome = await existingDirectory(probe.rHome, "selected R_HOME");
  await validateSharedLibrary(rHome, platformServices);
  validateRPlatform(probe.platform, platformServices);
  validateRArchitecture(probe.arch);
  const platformResult = rEnvironmentSchema.shape.platform.safeParse(process.platform);
  if (!platformResult.success) throw invalid(`unsupported host platform ${process.platform}`);
  const platform = platformResult.data;
  const normalLibraries = await normalizeDirectories(
    await probeProjectLibraries(selected, options.projectDirectory, options.signal),
    "R project library path",
  );
  const baseLibrary = await existingDirectory(probe.baseLibrary, "R base library");
  const helperLibrary = await existingDirectory(resources.rLibraryDirectory, "Alder R library");
  const environmentFields = { rscript: selected, rHome, version, platform, arch: process.arch };
  const helperAbi = `${manifest.applicationVersion}:${R_VERSION_RANGE}`;
  const baseLibraryPaths = uniquePaths([...normalLibraries, helperLibrary, baseLibrary]);
  const baseEnvironment = makeEnvironment(environmentFields, helperAbi, baseLibraryPaths);
  await validateHelperLoad(baseEnvironment, manifest, helperLibrary, options.signal);
  const requestedProjectLibrary = options.resolveProjectLibrary === undefined
    ? null
    : await options.resolveProjectLibrary(baseEnvironment);
  if (requestedProjectLibrary !== null && typeof requestedProjectLibrary !== "string") {
    throw invalid("project package library resolver must return a path or null");
  }
  const projectLibrary = requestedProjectLibrary === null
    ? null
    : await optionalDirectory(requestedProjectLibrary, "project package library");
  const libraryPaths = uniquePaths([
    ...normalLibraries,
    ...(projectLibrary === null ? [] : [projectLibrary]),
    helperLibrary,
    baseLibrary,
  ]);
  options.signal?.throwIfAborted();
  const environment = makeEnvironment(environmentFields, helperAbi, libraryPaths);
  return environment;
}

export function rServiceEnvironmentVariables(
  environment: REnvironment,
  resources: ApplicationResources,
  analysisEnvironmentId?: string,
): Record<string, string> {
  const values: Record<string, string> = {
    R_HOME: environment.rHome,
    ALDER_R_PRIVATE_LIBRARY: resources.rLibraryDirectory,
    ALDER_RESOURCES_ROOT: resources.root,
    ALDER_R_LIBRARIES: JSON.stringify([resources.rLibraryDirectory]),
    ALDER_WORKER_DIR: resources.workerDirectory,
    R_LIBS: resources.rLibraryDirectory,
    R_LIBS_SITE: "",
    R_LIBS_USER: "",
  };
  Object.assign(values, rLoaderEnvironment(environment.rHome));
  if (analysisEnvironmentId !== undefined) values.ALDER_ANALYSIS_ENVIRONMENT_ID = analysisEnvironmentId;
  return values;
}

export function rAnalyzerEnvironmentVariables(
  base: Record<string, string>,
  environment: REnvironment,
  resources: ApplicationResources,
  analysisEnvironmentId?: string,
): Record<string, string> {
  const values = { ...base, ...rServiceEnvironmentVariables(environment, resources, analysisEnvironmentId) };
  if (!rPlatform().analyzerNeedsRHome) delete values.R_HOME;
  return values;
}

/** Kernel processes retain ordinary R startup/profile semantics. */
export function rKernelEnvironmentVariables(
  environment: REnvironment,
  resources: ApplicationResources,
  projectDirectory?: string,
): Record<string, string> {
  const projectLibrary = projectDirectory === undefined
    ? undefined
    : join(projectDirectory, ".alder", "library");
  return {
    R_HOME: environment.rHome,
    ALDER_R_PRIVATE_LIBRARY: resources.rLibraryDirectory,
    ALDER_RESOURCES_ROOT: resources.root,
    ALDER_WORKER_DIR: resources.workerDirectory,
    ...(projectLibrary !== undefined && environment.libraryPaths.includes(projectLibrary)
      ? { ALDER_PROJECT_LIBRARY: projectLibrary }
      : {}),
    ...rLoaderEnvironment(environment.rHome),
  };
}

async function selectRscript(
  requested: string | undefined,
  desktop: boolean,
  platform: RPlatform,
): Promise<string> {
  if (requested !== undefined) return resolveSelectedPath(requested, "selected Rscript");
  const discovered = await findOnPath("Rscript");
  if (discovered !== null) return discovered;
  if (desktop && platform.desktopRscriptFallback !== null) {
    const framework = await resolveExecutableCandidate(platform.desktopRscriptFallback);
    if (framework !== null) return framework;
    throw notFound("Rscript was not found on PATH or at the standard macOS R framework location");
  }
  throw notFound("Rscript was not found on PATH");
}

async function findOnPath(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidates = [join(directory, command)];
    for (const candidate of candidates) {
      const resolved = await resolveExecutableCandidate(candidate);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

async function resolveExecutableCandidate(candidate: string): Promise<string | null> {
  if (!await isExecutable(candidate)) return null;
  try {
    return await realpath(candidate);
  } catch {
    // A candidate can disappear between stat and realpath.
    return null;
  }
}

async function resolveSelectedPath(value: string, label: string): Promise<string> {
  if (!value || value.includes("\0")) throw notFound(`${label} is empty or invalid`);
  const candidate = resolve(value);
  if (!(await isExecutable(candidate))) throw notFound(`${label} was not found: ${value}`);
  try {
    return await realpath(candidate);
  } catch (error) {
    throw notFound(`${label} cannot be resolved: ${messageOf(error)}`);
  }
}

async function probeR(rscript: string, signal?: AbortSignal): Promise<RProbe> {
  const script = [
    "cat(R.home(), '\\n', sep = '')",
    "cat(R.version$version.string, intToUtf8(10), sep = '')",
    "cat(R.version$platform, '\\n', sep = '')",
    "cat(R.version$arch, '\\n', sep = '')",
    "cat(paste(.libPaths(), collapse = '\\n'), '\\n--ALDER-LIBS-END--\\n', sep = '')",
    "cat(R.home('library'), '\\n', sep = '')",
  ].join("; ");
  try {
    const result = await execFileAsync(rscript, ["--vanilla", "--slave", "-e", script], {
      signal,
      env: withoutRHome(process.env),
      timeout: R_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    const lines = result.stdout.split("\n");
    const marker = lines.indexOf("--ALDER-LIBS-END--");
    if (marker < 5) throw new Error("selected R returned incomplete identity");
    const rHome = lines[0]!.trim();
    const version = lines[1]!.trim();
    const platform = lines[2]!.trim();
    const arch = lines[3]!.trim();
    const libraryPaths = lines.slice(4, marker).map((line) => line.trim()).filter(Boolean);
    const baseLibrary = lines[marker + 1]!.trim();
    if (!rHome || !version || !platform || !arch || !baseLibrary || libraryPaths.length === 0) {
      throw new Error("selected R returned incomplete identity");
    }
    return { rHome, version, platform, arch, libraryPaths, baseLibrary };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound(`selected Rscript could not be started: ${rscript}`);
    if (error instanceof REnvironmentError) throw error;
    throw invalid(`selected Rscript failed identity validation: ${messageOf(error)}`);
  }
}

async function probeProjectLibraries(rscript: string, projectDirectory: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const result = await execFileAsync(rscript, ["--slave", "-e", "writeLines(.libPaths())"], {
      signal,
      cwd: projectDirectory,
      env: withoutRHome(process.env),
      timeout: R_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    const paths = result.stdout.split("\n").map(value => value.trim()).filter(Boolean);
    if (paths.length === 0) throw new Error("selected R returned no project library paths");
    return paths;
  } catch (error) {
    throw invalid(`selected R failed project startup: ${messageOf(error)}`);
  }
}

async function validateHelperLibrary(resources: ApplicationResources): Promise<void> {
  const description = join(resources.rLibraryDirectory, "alder", "DESCRIPTION");

  try {
    const info = await stat(description);
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw invalid("The R execution helpers are not installed in this build.");
  }
}

async function validateHelperLoad(environment: REnvironment, manifest: ApplicationManifest, helperLibrary: string, signal?: AbortSignal): Promise<void> {
  const script = [
    `invisible(loadNamespace('alder', lib.loc=${JSON.stringify(helperLibrary)}))`,
    `description <- packageDescription('alder', lib.loc=${JSON.stringify(helperLibrary)})`,
    "cat(as.character(description$Version), '\\n', description$Built, '\\n', sep = '')",
  ].join("; ");
  try {
    const result = await execFileAsync(environment.rscript, ["--vanilla", "--slave", "-e", script], {
      signal,
      env: {
        ...withoutRHome(process.env),
        R_LIBS: helperLibrary,
        R_LIBS_SITE: "",
        R_LIBS_USER: "",
        ...rLoaderEnvironment(environment.rHome),
      },
      timeout: R_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    const [packageVersion, built] = result.stdout.trim().split("\n");
    const [major, minor] = environment.version.split(".");
    if (packageVersion !== manifest.applicationVersion || !built?.startsWith("R " + major + "." + minor + ".")) {
      throw new Error(`helper package version or Built R ABI does not match the selected runtime (package ${packageVersion ?? "missing"}, Built ${built ?? "missing"}, expected package ${manifest.applicationVersion} built with R ${major}.${minor}.x)`);
    }
  } catch (error) {
    throw invalid(`Alder helper package cannot load under selected R: ${messageOf(error)}`);
  }
}

async function validateSharedLibrary(rHome: string, platform: RPlatform): Promise<void> {
  const candidates = [join(rHome, "lib", platform.sharedLibrary), join(rHome, "lib", "R", platform.sharedLibrary)];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return;
  }
  throw invalid(`selected R has no loadable shared library under ${rHome}`);
}
function validateRPlatform(value: string, platform: RPlatform): void {
  if (!platform.matchesRPlatform(value)) {
    throw invalid(`selected R platform ${value} does not match ${platform.name}`);
  }
}

function currentRPlatform(): RPlatform {
  try { return rPlatform(); }
  catch (error) { throw invalid(messageOf(error)); }
}

function validateRArchitecture(arch: string): void {
  const expected = process.arch === "x64" ? ["x86_64", "x64", "amd64"]
    : process.arch === "arm64" ? ["aarch64", "arm64"]
      : [process.arch];
  if (!expected.some((value) => arch.toLowerCase().includes(value.toLowerCase()))) {
    throw invalid(`selected R architecture ${arch} does not match ${process.arch}`);
  }
}

async function normalizeDirectories(paths: readonly string[], label: string): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) result.push(await existingDirectory(path, label));
  return result;
}

function makeEnvironment(
  fields: Pick<REnvironment, "rscript" | "rHome" | "version" | "platform" | "arch">,
  helperAbi: string,
  paths: readonly string[],
): REnvironment {
  const libraryPaths = uniquePaths(paths);
  return Object.freeze({
    ...fields,
    libraryPaths: Object.freeze(libraryPaths),
    identity: createIdentity({ ...fields, helperAbi, libraryPaths }),
  });
}

async function optionalDirectory(path: string, label: string): Promise<string | null> {
  if (!path || !isAbsolute(path)) throw invalid(`${label} must be an absolute path`);
  let physical: string;
  try {
    physical = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid(`${label} is unavailable: ${path}: ${messageOf(error)}`);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(physical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid(`${label} is unavailable: ${path}: ${messageOf(error)}`);
  }
  if (!info.isDirectory()) throw invalid(`${label} is not a directory: ${path}`);
  return physical;
}

async function existingDirectory(path: string, label: string): Promise<string> {
  if (!path || !isAbsolute(path)) throw invalid(`${label} must be an absolute path`);
  const physical = await realpath(path).catch((error) => {
    throw invalid(`${label} is unavailable: ${path}: ${messageOf(error)}`);
  });
  const info = await stat(physical);
  if (!info.isDirectory()) throw invalid(`${label} is not a directory: ${path}`);
  return physical;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    return (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

function normalizeVersion(value: string): string {
  const match = /^(?:R version\s+)?(\d+\.\d+\.\d+)(?:\s.*|[-+].*)?$/.exec(value.trim());
  if (!match) throw invalid(`selected R reported an invalid version: ${value}`);
  return match[1]!;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Map(paths.map((path) => [path, path])).values()];
}

function createIdentity(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withoutRHome(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.R_HOME;
  return result;
}

function notFound(message: string): REnvironmentError {
  return new REnvironmentError("r_not_found", message);
}

function invalid(message: string): REnvironmentError {
  return new REnvironmentError("r_invalid", message);
}

function unsupported(version: string): REnvironmentError {
  return new REnvironmentError("r_unsupported", `R ${version} does not match the helper ABI ${R_VERSION_RANGE}`, { detectedVersion: version });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
