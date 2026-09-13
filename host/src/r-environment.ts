import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import envPaths from "env-paths";

import { parseStrictJson } from "./strict-json.js";
import {
  verifiedApplicationManifest,
  type ApplicationManifest,
  type ApplicationResources,
} from "./resources.js";
import { rEnvironmentSchema, type REnvironment } from "./protocol.js";
import { readPrivateFile } from "./private-paths.js";
const execFileAsync = promisify(execFile);
const R_VERSION_RANGE = ">=4.6.0 <4.7.0";
const R_PROBE_TIMEOUT_MS = 10_000;
const PRIVATE_SETTINGS_SCHEMA_VERSION = 1;


export interface ResolveREnvironmentOptions {
  rscript?: string;
  projectDirectory: string;
  resources: ApplicationResources;
  sandbox?: boolean;
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
  const resources = options.resources;
  const manifest = await verifiedApplicationManifest(resources).catch((error) => {
    if (error instanceof REnvironmentError) throw error;
    throw invalid(`application manifest cannot be read while selecting R: ${messageOf(error)}`);
  });
  if (manifest.rVersionRange !== R_VERSION_RANGE) {
    throw invalid(`unsupported helper R ABI range ${manifest.rVersionRange}`);
  }
  await validateHelperLibrary(resources, manifest);
  const selected = await selectRscript(options.rscript, resources.electronEntry !== null, resources.processSupervisorExecutable);
  const probe = await probeR(selected);
  const version = normalizeVersion(probe.version);
  if (!manifest.qualifiedRPatchVersions.includes(version)) {
    throw unsupported(version, manifest.qualifiedRPatchVersions);
  }
  const rHome = await existingDirectory(probe.rHome, "selected R_HOME");
  await validateSharedLibrary(rHome);
  validateRPlatform(probe.platform);
  validateRArchitecture(probe.arch);
  const platformResult = rEnvironmentSchema.shape.platform.safeParse(process.platform);
  if (!platformResult.success) throw invalid(`unsupported host platform ${process.platform}`);
  const platform = platformResult.data;
  const normalLibraries = await normalizeDirectories(probe.libraryPaths, "R library path");
  const baseLibrary = await existingDirectory(probe.baseLibrary, "R base library");
  const helperLibrary = await existingDirectory(resources.rLibraryDirectory, "Alder R library");
  const environmentFields = { rscript: selected, rHome, version, platform, arch: process.arch };
  const helperAbi = `${manifest.applicationVersion}:${manifest.rBuildVersion}:${manifest.rVersionRange}`;
  const baseLibraryPaths = uniquePaths([
    helperLibrary,
    ...(options.sandbox === true ? [] : normalLibraries),
    baseLibrary,
  ]);
  const baseEnvironment = makeEnvironment(environmentFields, helperAbi, baseLibraryPaths);
  await validateHelperLoad(baseEnvironment, manifest);
  const requestedProjectLibrary = options.resolveProjectLibrary === undefined
    ? options.sandbox === true ? join(options.projectDirectory, ".alder", "library") : null
    : await options.resolveProjectLibrary(baseEnvironment);
  if (requestedProjectLibrary !== null && typeof requestedProjectLibrary !== "string") {
    throw invalid("project package library resolver must return a path or null");
  }
  const projectLibrary = requestedProjectLibrary === null
    ? null
    : await optionalDirectory(requestedProjectLibrary, "project package library");
  const libraryPaths = uniquePaths([
    helperLibrary,
    ...(projectLibrary === null ? [] : [projectLibrary]),
    ...(options.sandbox === true ? [] : normalLibraries),
    baseLibrary,
  ]);
  const environment = makeEnvironment(environmentFields, helperAbi, libraryPaths);
  return environment;
}

export function rEnvironmentVariables(
  environment: REnvironment,
  resources: ApplicationResources,
  analysisEnvironmentId?: string,
): Record<string, string> {
  const values: Record<string, string> = {
    R_HOME: environment.rHome,
    ALDER_R_PRIVATE_LIBRARY: resources.rLibraryDirectory,
    ALDER_RESOURCES_ROOT: resources.root,
    ALDER_R_LIBRARIES: JSON.stringify(environment.libraryPaths),
    ALDER_WORKER_DIR: resources.workerDirectory,
  };
  const loaderDirectories = [join(environment.rHome, "lib"), join(environment.rHome, "lib", "R")];
  if (process.platform === "linux") values.LD_LIBRARY_PATH = prependPath(loaderDirectories, process.env.LD_LIBRARY_PATH);
  if (process.platform === "darwin") values.DYLD_LIBRARY_PATH = prependPath(loaderDirectories, process.env.DYLD_LIBRARY_PATH);
  if (analysisEnvironmentId !== undefined) values.ALDER_ANALYSIS_ENVIRONMENT_ID = analysisEnvironmentId;
  return values;
}

async function selectRscript(
  requested: string | undefined,
  desktop: boolean,
  processSupervisorExecutable: string,
): Promise<string> {
  if (requested !== undefined) return resolveSelectedPath(requested, "explicit Rscript");
  if (desktop) {
    const saved = await savedRscript(processSupervisorExecutable);
    if (saved !== null) return resolveSelectedPath(saved, "saved Rscript");
  }
  const discovered = await findOnPath("Rscript");
  if (discovered === null) throw notFound("Rscript was not found on PATH");
  return discovered;
}

async function savedRscript(processSupervisorExecutable: string): Promise<string | null> {
  const paths = envPaths("alder", { suffix: "" });
  const settingsPath = join(paths.config, "settings.json");
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(settingsPath, { maxBytes: 64 * 1024, processSupervisorExecutable });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw invalid("saved R selection cannot be read: " + messageOf(error));
  }
  let value: unknown;
  try {
    value = parseStrictJson(bytes, { maxBytes: 64 * 1024, maxDepth: 16 });
  } catch (error) {
    throw invalid("saved R selection is invalid: " + messageOf(error));
  }
  if (!isRecord(value) || value.schemaVersion !== PRIVATE_SETTINGS_SCHEMA_VERSION ||
      !(typeof value.rscript === "string" || value.rscript === null) || Object.keys(value).some((key) => !["schemaVersion", "rscript"].includes(key))) {
    throw invalid("saved R selection has an invalid schema");
  }
  return value.rscript;
}

async function findOnPath(command: string): Promise<string | null> {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidates = process.platform === "win32"
      ? [join(directory, command), join(directory, `${command}.exe`), join(directory, `${command}.cmd`)]
      : [join(directory, command)];
    for (const candidate of candidates) {
      if (!await isExecutable(candidate)) continue;
      try {
        return await realpath(candidate);
      } catch {
        // PATH entries can disappear between stat and realpath. Continue with
        // the next candidate rather than turning a transient race into an
        // untyped selection failure or silently falling back from an explicit
        // selection.
      }
    }
  }
  return null;
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

async function probeR(rscript: string): Promise<RProbe> {
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
      env: withoutRHome(process.env),
      timeout: R_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      windowsHide: true,
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

async function validateHelperLibrary(resources: ApplicationResources, manifest: ApplicationManifest): Promise<void> {
  if (!manifest.rPackages.some((pkg) => pkg.name === "alder")) {
    throw invalid("application manifest does not contain the Alder helper package");
  }
  const description = join(resources.rLibraryDirectory, "alder", "DESCRIPTION");

  try {
    const info = await stat(description);
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw invalid(`Alder helper package is unavailable: ${messageOf(error)}`);
  }
}

async function validateHelperLoad(environment: REnvironment, manifest: ApplicationManifest): Promise<void> {
  const script = [
    "suppressPackageStartupMessages(library(alder))",
    "description <- packageDescription('alder')",
    "cat(as.character(description$Version), '\\n', description$Built, '\\n', sep = '')",
  ].join("; ");
  try {
    const result = await execFileAsync(environment.rscript, ["--vanilla", "--slave", "-e", script], {
      env: {
        ...withoutRHome(process.env),
        R_HOME: environment.rHome,
        R_LIBS: environment.libraryPaths.join(delimiter),
        R_LIBS_SITE: "",
        R_LIBS_USER: "",
        ...(process.platform === "linux" ? {
          LD_LIBRARY_PATH: prependPath([join(environment.rHome, "lib"), join(environment.rHome, "lib", "R")], process.env.LD_LIBRARY_PATH),
        } : {}),
        ...(process.platform === "darwin" ? {
          DYLD_LIBRARY_PATH: prependPath([join(environment.rHome, "lib"), join(environment.rHome, "lib", "R")], process.env.DYLD_LIBRARY_PATH),
        } : {}),
      },
      timeout: R_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    const [packageVersion, built] = result.stdout.trim().split("\n");
    const [major, minor] = environment.version.split(".");
    if (packageVersion !== manifest.applicationVersion || !built?.startsWith("R " + major + "." + minor + ".")) {
      throw new Error("helper package version or Built R ABI does not match the selected runtime");
    }
  } catch (error) {
    throw invalid(`Alder helper package cannot load under selected R: ${messageOf(error)}`);
  }
}

async function validateSharedLibrary(rHome: string): Promise<void> {
  const candidates = process.platform === "win32"
    ? [join(rHome, "bin", "x64", "R.dll"), join(rHome, "bin", "R.dll")]
    : process.platform === "darwin"
      ? [join(rHome, "lib", "libR.dylib"), join(rHome, "lib", "R", "libR.dylib")]
      : [join(rHome, "lib", "libR.so"), join(rHome, "lib", "R", "libR.so")];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return;
  }
  throw invalid(`selected R has no loadable shared library under ${rHome}`);
}
function validateRPlatform(platform: string): void {
  const normalized = platform.toLowerCase();
  const expected = process.platform === "linux" ? "linux"
    : process.platform === "darwin" ? "darwin"
      : "mingw";
  if (!normalized.includes(expected)) {
    throw invalid(`selected R platform ${platform} does not match ${process.platform}`);
  }
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
    if (process.platform === "win32") return true;
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

function prependPath(prefixes: readonly string[], existing: string | undefined): string {
  return [...prefixes, ...(existing ? existing.split(delimiter) : [])].join(delimiter);
}

function withoutRHome(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.R_HOME;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(message: string): REnvironmentError {
  return new REnvironmentError("r_not_found", message);
}

function invalid(message: string): REnvironmentError {
  return new REnvironmentError("r_invalid", message);
}

function unsupported(version: string, supported: readonly string[]): REnvironmentError {
  return new REnvironmentError("r_unsupported", `R ${version} is not qualified; supported versions: ${supported.join(", ")}`, {
    detectedVersion: version,
    supportedVersions: [...supported],
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
