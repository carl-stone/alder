import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { observeFile, parseYamlMapping, type DiskObservation } from "./configuration.js";
import { PackageWorker, PackageWorkerError, type PackageProgress, type PackageRunOptions } from "./jobs.js";
import type { ApplicationResources } from "./resources.js";
import type { REnvironment } from "./protocol.js";
import type { ProcessScope } from "./processes.js";

export const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/;
export const PACKAGE_METADATA_RELATIVE_PATH = [".alder", "packages.yaml"] as const;
export const PACKAGE_REPOSITORY_RELATIVE_PATH = [".alder", "repository.yaml"] as const;
export const PACKAGE_LIBRARY_RELATIVE_PATH = [".alder", "library"] as const;
export type PackageInstallMode = "project";
export type PackageState = "installed" | "missing";

export interface PackageStatusRecord { readonly package: string; readonly status: PackageState; readonly version: string | null; readonly library: string | null; }
export interface PackageDeclarations { readonly path: string; readonly metadata: string; readonly packages: string[]; readonly sidecarVersion: string | null; }
export interface PackageStatusResult extends PackageDeclarations {
  readonly ok: true; readonly mode: PackageInstallMode; readonly lockfile: null; readonly library: string | null;
  readonly installed: string[]; readonly missing: string[]; readonly installing: string[]; readonly status: PackageStatusRecord[]; readonly error: null;
}
export interface PackageInstallError { readonly code: string; readonly message: string; readonly details?: unknown; }
export interface PackageInstallSummary {
  readonly status: "installed" | "error"; readonly library: string | null; readonly packages: string[];
  readonly installed: string[]; readonly missing: string[]; readonly output: string; readonly packageStatus: PackageStatusRecord[];
}
export interface PackageInstallResult {
  readonly ok: boolean; readonly status: "installed" | "error"; readonly path: string; readonly metadata: string;
  readonly sidecarVersion: string | null; readonly mode: PackageInstallMode; readonly lockfile: null; readonly library: string | null;
  readonly packages: string[]; readonly installed: string[]; readonly missing: string[]; readonly installing: string[];
  readonly mutatedLibrary: boolean; readonly result: PackageInstallSummary | null; readonly output: string;
  readonly packageStatus: PackageStatusRecord[]; readonly error: PackageInstallError | null;
}
export interface PackageServiceOptions {
  readonly resources: ApplicationResources; readonly environment: REnvironment | null; readonly processScope: ProcessScope;
  readonly projectDirectory: string; readonly onProgress?: (event: PackageProgress) => void | Promise<void>; readonly timeoutMs?: number;
}
export interface PackageInstallOptions extends PackageRunOptions { readonly operationId?: string; }
export interface PackageStatusOptions extends PackageRunOptions { readonly operationId?: string; }
export type PackageErrorCode = "invalid_request" | "package_metadata_error" | "r_not_found" | "environment_unavailable" | "install_failed" | "job_closed" | "job_timeout" | "job_failed" | "cancelled";

export class PackageError extends Error {
  constructor(readonly code: PackageErrorCode, message: string, readonly details?: unknown) { super(message); this.name = "PackageError"; }
}

export function packageMetadataPath(projectDirectory: string): string { return join(projectDirectory, ...PACKAGE_METADATA_RELATIVE_PATH); }
export function packageLibraryPath(projectDirectory: string): string { return join(projectDirectory, ...PACKAGE_LIBRARY_RELATIVE_PATH); }
export function packageRepositoryPath(projectDirectory: string): string { return join(projectDirectory, ...PACKAGE_REPOSITORY_RELATIVE_PATH); }

export function validatePackageNames(packages: readonly string[], allowEmpty = true): string[] {
  if (!Array.isArray(packages) || packages.some(value => typeof value !== "string")) throw new PackageError("invalid_request", "packages must be an array of package names");
  const values = [...new Set(packages)];
  const invalid = values.filter(value => !PACKAGE_NAME_RE.test(value));
  if (invalid.length > 0) throw new PackageError("invalid_request", "invalid package name: " + invalid.join(", "));
  if (!allowEmpty && values.length === 0) throw new PackageError("invalid_request", "at least one package is required");
  return values.sort();
}

export async function readPackageDeclarations(projectDirectory: string): Promise<PackageDeclarations> {
  const project = await canonicalProjectDirectory(projectDirectory);
  const metadata = packageMetadataPath(project);
  const observation = await observeFile(metadata);
  if (observation.state === "absent") return { path: project, metadata, packages: [], sidecarVersion: null };
  if (observation.state !== "present") throw new PackageError("package_metadata_error", "package metadata is not readable: " + metadata);
  try {
    const mapping = parseYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(metadata)), "packages");
    if (Object.keys(mapping).length !== 1 || !Array.isArray(mapping.packages) || mapping.packages.some(value => typeof value !== "string")) {
      throw new Error("package metadata must contain only a packages sequence");
    }
    return { path: project, metadata, packages: validatePackageNames(mapping.packages as string[]), sidecarVersion: sidecarVersion(observation) };
  } catch (error) {
    throw new PackageError("package_metadata_error", messageOf(error));
  }
}

export function serializePackageDeclarations(packages: readonly string[]): string {
  const text = stringifyYaml({ packages: validatePackageNames(packages) }, { sortMapEntries: true });
  return text.endsWith("\n") ? text : text + "\n";
}

export class PackageManager {
  readonly worker: PackageWorker;
  private closed = false;
  constructor(private readonly options: PackageServiceOptions) {
    if (!isAbsoluteNonEmptyPath(options.projectDirectory)) throw new Error("package project directory must be an absolute path");
    this.worker = new PackageWorker(options);
  }
  async declarations(): Promise<PackageDeclarations> { this.assertOpen(); return readPackageDeclarations(this.options.projectDirectory); }

  async status(options: PackageStatusOptions = {}): Promise<PackageStatusResult> {
    this.assertOpen();
    const declarations = await this.declarations();
    const library = packageLibraryPath(declarations.path);
    const exists = await existingDirectory(library);
    const response = workerResult(await this.run("status", declarations, declarations.packages, library, options.operationId, options));
    const records = statusRecords(declarations.packages, response.records);
    return { ...declarations, ok: true, mode: "project", lockfile: null, library: exists ? library : null,
      installed: records.filter(value => value.status === "installed").map(value => value.package),
      missing: records.filter(value => value.status === "missing").map(value => value.package), installing: [], status: records, error: null };
  }

  async install(packages: readonly string[], options: PackageInstallOptions = {}): Promise<PackageInstallResult> {
    this.assertOpen();
    const declarations = await this.declarations();
    const requested = validatePackageNames(packages).length > 0 ? validatePackageNames(packages) : declarations.packages;
    if (requested.length === 0) throw new PackageError("invalid_request", "declare at least one package before installing");
    const library = packageLibraryPath(declarations.path);
    if (this.options.environment === null) return failedInstall(declarations, requested, library, new PackageError("r_not_found", "selected R environment is unavailable"), false);
    try {
      await projectRepositories(declarations.path);
      await ensureProjectLibrary(declarations.path, library);
      const response = workerResult(await this.run("install", declarations, requested, library, options.operationId, options));
      const records = statusRecords(requested, response.records);
      const ok = response.ok && records.every(value => value.status === "installed");
      if (!ok) return failedInstall(declarations, requested, library, new PackageError("install_failed", response.error ?? "package installation failed"), response.mutatedLibrary);
      const installed = records.map(value => value.package);
      return { ...declarations, ok: true, status: "installed", mode: "project", lockfile: null, library, packages: requested,
        installed, missing: [], installing: [], mutatedLibrary: response.mutatedLibrary,
        result: { status: "installed", library, packages: requested, installed, missing: [], output: "", packageStatus: records },
        output: "", packageStatus: records, error: null };
    } catch (error) {
      const failure = error instanceof PackageWorkerError
        ? new PackageError(error.code as PackageErrorCode, error.message, error.details)
        : error instanceof PackageError ? error : new PackageError("install_failed", messageOf(error));
      const possiblyMutated = error instanceof PackageWorkerError
        && failure.code !== "r_not_found" && failure.code !== "cancelled" && failure.code !== "job_closed";
      return failedInstall(declarations, requested, library, failure, possiblyMutated);
    }
  }

  close(): Promise<void> { this.closed = true; return this.worker.close(); }
  private assertOpen(): void { if (this.closed) throw new PackageError("job_closed", "package manager is closed"); }
  private async run(command: "status" | "install", declarations: PackageDeclarations, packages: string[], library: string, operationId?: string, options: PackageRunOptions = {}): Promise<unknown> {
    return this.worker.run(command, { projectDirectory: declarations.path, packages, library,
      repositories: command === "install" ? await projectRepositories(declarations.path) : [],
      ...(operationId === undefined ? {} : { operationId }) }, options);
  }
}

async function canonicalProjectDirectory(value: string): Promise<string> {
  if (!isAbsoluteNonEmptyPath(value)) throw new PackageError("invalid_request", "project directory must be an absolute path");
  try { const path = await realpath(value); if (!(await stat(path)).isDirectory()) throw new Error("not a directory"); return path; }
  catch (error) { throw new PackageError("invalid_request", "project directory is unavailable: " + messageOf(error)); }
}

async function projectRepositories(project: string): Promise<string[]> {
  const path = packageRepositoryPath(project);
  try {
    const mapping = parseYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)), "package repository");
    if (Object.keys(mapping).length !== 1 || typeof mapping.repository !== "string") {
      throw new Error("repository settings must contain one repository URL");
    }
    const repository = new URL(mapping.repository);
    if (!["https:", "http:", "file:"].includes(repository.protocol)) throw new Error("repository URL must use HTTPS, HTTP, or file");
    return [repository.href];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new PackageError("package_metadata_error", "could not read package repository settings: " + messageOf(error));
  }
}

async function existingDirectory(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function ensureProjectLibrary(project: string, library: string): Promise<void> {
  const alder = join(project, ".alder");
  await mkdir(alder, { recursive: true, mode: 0o700 });
  await mkdir(library, { recursive: true, mode: 0o700 });
  if (!(await lstat(alder)).isDirectory() || !(await lstat(library)).isDirectory()) throw new Error("project library is not a directory");
  if (await realpath(library) !== join(await realpath(project), ".alder", "library")) throw new Error("project library is outside the project");
}

interface WorkerResponse { ok: boolean; records: PackageStatusRecord[]; mutatedLibrary: boolean; error?: string; }
function workerResult(value: unknown): WorkerResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.records)) throw new PackageError("job_failed", "package service returned invalid data");
  const records = value.records.filter(isRecord).map(record => ({
    package: String(record.package), status: record.status === "installed" ? "installed" as const : "missing" as const,
    version: typeof record.version === "string" ? record.version : null,
    library: typeof record.library === "string" ? record.library : null,
  }));
  return { ok: value.ok, records, mutatedLibrary: value.mutatedLibrary === true, ...(typeof value.error === "string" ? { error: value.error } : {}) };
}
function statusRecords(packages: readonly string[], records: readonly PackageStatusRecord[]): PackageStatusRecord[] {
  const byName = new Map(records.map(value => [value.package, value]));
  return packages.map(packageName => byName.get(packageName) ?? { package: packageName, status: "missing", version: null, library: null });
}
function failedInstall(declarations: PackageDeclarations, requested: string[], library: string, error: PackageError, mutatedLibrary: boolean): PackageInstallResult {
  const records = requested.map(packageName => ({ package: packageName, status: "missing" as const, version: null, library: null }));
  return { ...declarations, ok: false, status: "error", mode: "project", lockfile: null, library, packages: requested,
    installed: [], missing: requested, installing: [], mutatedLibrary, result: null, output: "", packageStatus: records,
    error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
}
function sidecarVersion(observation: DiskObservation): string | null { return observation.state === "present" ? observation.version ?? observation.digest : null; }
function isAbsoluteNonEmptyPath(value: string): boolean { return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
