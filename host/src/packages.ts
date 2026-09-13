import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import {
  observeFile,
  parseYamlMapping,
  type DiskObservation,
} from "./configuration.js";
import { PackageJobError, PackageJobs, type JobCallbacks, type JobRunOptions } from "./jobs.js";
import type { ApplicationResources } from "./resources.js";
import type { REnvironment } from "./protocol.js";
import type { ProcessScope } from "./processes.js";
import { parseStrictJson } from "./strict-json.js";

export const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/;
export const PACKAGE_METADATA_RELATIVE_PATH = [".alder", "packages.yaml"] as const;
export const PACKAGE_LIBRARY_RELATIVE_PATH = [".alder", "library"] as const;

export type PackageInstallMode = "pak" | "renv";
export type PackageState = "installed" | "missing";

export interface PackageStatusRecord {
  readonly package: string;
  readonly status: PackageState;
  readonly version: string | null;
  readonly library: string | null;
}

export interface PackageDeclarations {
  readonly path: string;
  readonly metadata: string;
  readonly packages: string[];
  readonly sidecarVersion: string | null;
}

export interface PackageStatusResult extends PackageDeclarations {
  readonly ok: true;
  readonly mode: PackageInstallMode;
  readonly lockfile: string | null;
  readonly library: string | null;
  readonly installed: string[];
  readonly missing: string[];
  readonly installing: string[];
  readonly status: PackageStatusRecord[];
  readonly error: null;
}

export interface PackageInstallError {
  readonly code: string;
  readonly message: string;
  readonly status?: number | null;
  readonly output?: string;
  readonly details?: unknown;
}

export interface PackageInstallSummary {
  readonly status: "installed" | "error";
  readonly library: string | null;
  readonly packages: string[];
  readonly installed: string[];
  readonly missing: string[];
  readonly output: string;
  readonly packageStatus: PackageStatusRecord[];
}

export interface PackageInstallResult {
  readonly ok: boolean;
  readonly status: "installed" | "error";
  readonly path: string;
  readonly metadata: string;
  readonly sidecarVersion: string | null;
  readonly mode: PackageInstallMode;
  readonly lockfile: string | null;
  readonly library: string | null;
  readonly packages: string[];
  readonly installed: string[];
  readonly missing: string[];
  readonly installing: string[];
  /** True when a worker could have changed a project library. */
  readonly mutatedLibrary: boolean;
  /** Successful worker summary; null when the operation reports an error. */
  readonly result: PackageInstallSummary | null;
  readonly output: string;
  readonly packageStatus: PackageStatusRecord[];
  readonly error: PackageInstallError | null;
}

export interface PackageServiceOptions {
  readonly resources: ApplicationResources;
  readonly environment: REnvironment | null;
  readonly processScope: ProcessScope;
  readonly projectDirectory: string;
  readonly callbacks?: JobCallbacks;
  readonly timeoutMs?: number;
}

export interface PackageInstallOptions extends JobRunOptions {
  readonly operationId?: string;
}

export interface PackageStatusOptions {
  readonly operationId?: string;
}

export type PackageErrorCode =
  | "invalid_request"
  | "package_metadata_error"
  | "r_not_found"
  | "environment_unavailable"
  | "install_failed"
  | "job_closed"
  | "job_timeout"
  | "job_failed"
  | "job_protocol_error"
  | "cancelled";

export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PackageError";
  }
}

/** Return the canonical project package metadata path. */
export function packageMetadataPath(projectDirectory: string): string {
  return join(projectDirectory, ...PACKAGE_METADATA_RELATIVE_PATH);
}

/** Return Alder's project-local ordinary-package library path. */
export function packageLibraryPath(projectDirectory: string): string {
  return join(projectDirectory, ...PACKAGE_LIBRARY_RELATIVE_PATH);
}

/** Validate, deduplicate and deterministically order package names. */
export function validatePackageNames(packages: readonly string[], allowEmpty = true): string[] {
  if (!Array.isArray(packages) || packages.some(packageName => typeof packageName !== "string")) {
    throw new PackageError("invalid_request", "packages must be an array of package names");
  }
  const unique = [...new Set(packages)];
  const invalid = unique.filter(packageName => !PACKAGE_NAME_RE.test(packageName));
  if (invalid.length > 0) {
    throw new PackageError("invalid_request", "invalid package name: " + invalid.join(", "));
  }
  if (!allowEmpty && unique.length === 0) {
    throw new PackageError("invalid_request", "at least one package is required");
  }
  return unique.sort();
}

/** Read the canonical `.alder/packages.yaml` sidecar without mutation. */
export async function readPackageDeclarations(projectDirectory: string): Promise<PackageDeclarations> {
  const project = await canonicalProjectDirectory(projectDirectory);
  const metadata = packageMetadataPath(project);
  const observation = await observeFile(metadata);
  if (observation.state === "absent") {
    return { path: project, metadata, packages: [], sidecarVersion: null };
  }
  if (observation.state !== "present") {
    throw new PackageError("package_metadata_error", "package metadata is not readable: " + metadata);
  }
  let text: string;
  try {
    const bytes = await readFile(metadata);
    if (bytes.includes(0)) throw new Error("package metadata contains an embedded NUL");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PackageError("package_metadata_error", "could not read package metadata: " + messageOf(error));
  }
  let mapping: Record<string, unknown>;
  try {
    mapping = parseYamlMapping(text, "packages");
  } catch (error) {
    throw new PackageError("package_metadata_error", messageOf(error), error);
  }
  const keys = Object.keys(mapping);
  if (keys.length !== 1 || keys[0] !== "packages") {
    throw new PackageError("package_metadata_error", "package metadata must contain only a packages sequence");
  }
  if (!Array.isArray(mapping.packages) || mapping.packages.some(value => typeof value !== "string")) {
    throw new PackageError("package_metadata_error", "packages must be a character sequence");
  }
  let packages: string[];
  try {
    packages = validatePackageNames(mapping.packages as string[]);
  } catch (error) {
    throw new PackageError("package_metadata_error", messageOf(error), error);
  }
  return {
    path: project,
    metadata,
    packages,
    sidecarVersion: sidecarVersion(observation),
  };
}

/** Serialize the only accepted canonical package sidecar shape. */
export function serializePackageDeclarations(packages: readonly string[]): string {
  const value = { packages: validatePackageNames(packages) };
  const text = stringifyYaml(value, {
    version: "1.2",
    schema: "core",
    sortMapEntries: true,
  });
  return text.endsWith("\n") ? text : text + "\n";
}

/** Host-owned package metadata and isolated worker lifecycle. */
export class PackageManager {
  readonly jobs: PackageJobs;
  private closed = false;

  constructor(private readonly options: PackageServiceOptions) {
    if (!isAbsoluteNonEmptyPath(options.projectDirectory)) {
      throw new Error("package project directory must be an absolute path");
    }
    this.jobs = new PackageJobs(options);
  }

  async declarations(): Promise<PackageDeclarations> {
    this.assertOpen();
    return readPackageDeclarations(this.options.projectDirectory);
  }

  async status(options: PackageStatusOptions = {}): Promise<PackageStatusResult> {
    this.assertOpen();
    const declarations = await readPackageDeclarations(this.options.projectDirectory);
    const lockfile = await projectLockfile(declarations.path);
    const locked = lockfile === null ? null : await readRenvLockSnapshot(lockfile);
    if (locked !== null) requireLockedPackages(declarations.packages, locked);
    const mode: PackageInstallMode = lockfile === null ? "pak" : "renv";
    const ordinaryLibrary = packageLibraryPath(declarations.path);
    const ordinaryPresent = await existingDirectory(ordinaryLibrary);
    const libraryPaths = mode === "pak"
      ? uniquePaths([...(ordinaryPresent ? [ordinaryLibrary] : []), ...(this.options.environment?.libraryPaths ?? [])])
      : [...(this.options.environment?.libraryPaths ?? [])];
    let result: unknown;
    try {
      result = await this.jobs.run("status", {
        projectDirectory: declarations.path,
        packages: declarations.packages,
        mode,
        lockfilePath: lockfile,
        libraryPath: mode === "pak" && ordinaryPresent ? ordinaryLibrary : null,
        libraryPaths,
        ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      });
    } catch (error) {
      if (error instanceof PackageJobError) {
        throw new PackageError(error.code as PackageErrorCode, error.message, error.details);
      }
      throw error;
    }
    const worker = checkedWorkerStatus(result);
    const records = statusRecords(declarations.packages, worker.records);
    return {
      ok: true,
      path: declarations.path,
      metadata: declarations.metadata,
      packages: declarations.packages,
      sidecarVersion: declarations.sidecarVersion,
      mode,
      lockfile,
      library: mode === "pak" ? (ordinaryPresent ? ordinaryLibrary : null) : worker.library,
      installed: records.filter(record => record.status === "installed").map(record => record.package),
      missing: records.filter(record => record.status === "missing").map(record => record.package),
      installing: [],
      status: records,
      error: null,
    };
  }


  async install(
    packages: readonly string[],
    runOptions: PackageInstallOptions = {},
  ): Promise<PackageInstallResult> {
    this.assertOpen();
    const requested = validatePackageNames(packages, false);
    const declarations = await readPackageDeclarations(this.options.projectDirectory);
    const lockfile = await projectLockfile(declarations.path);
    const locked = lockfile === null ? null : await readRenvLockSnapshot(lockfile);
    if (locked !== null) requireLockedPackages(requested, locked);
    const mode: PackageInstallMode = lockfile === null ? "pak" : "renv";
    const ordinaryLibrary = packageLibraryPath(declarations.path);
    if (this.options.environment === null) {
      return failedInstall(declarations, mode, lockfile, mode === "pak" ? ordinaryLibrary : null,
        requested, new PackageError("r_not_found", "selected R environment is unavailable"), false);
    }
    if (mode === "pak") {
      try {
        await ensureProjectLibrary(declarations.path, ordinaryLibrary);
      } catch (error) {
        return failedInstall(declarations, mode, lockfile, ordinaryLibrary, requested,
          new PackageError("install_failed", "could not create safe package library: " + messageOf(error)), false);
      }
    }
    const libraryPaths = mode === "pak"
      ? uniquePaths([ordinaryLibrary, ...(this.options.environment?.libraryPaths ?? [])])
      : [...(this.options.environment?.libraryPaths ?? [])];
    try {
      const result = await this.jobs.run("install", {
        projectDirectory: declarations.path,
        packages: requested,
        mode,
        lockfilePath: lockfile,
        libraryPath: mode === "pak" ? ordinaryLibrary : null,
        libraryPaths,
        ...(runOptions.operationId === undefined ? {} : { operationId: runOptions.operationId }),
      }, runOptions);
      return normalizeInstallResult(result, declarations, mode, lockfile, requested,
        mode === "pak" ? ordinaryLibrary : null);
    } catch (error) {
      const failure = error instanceof PackageJobError
        ? new PackageError(error.code as PackageErrorCode, error.message, error.details)
        : error instanceof PackageError ? error : new PackageError("install_failed", messageOf(error));
      const mutatedLibrary = failure.code !== "r_not_found" && failure.code !== "cancelled";
      return failedInstall(declarations, mode, lockfile, mode === "pak" ? ordinaryLibrary : null, requested, failure, mutatedLibrary);
    }
  }

  close(): Promise<void> {
    if (this.closed) return this.jobs.close();
    this.closed = true;
    return this.jobs.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new PackageError("job_closed", "package manager is closed");
  }
}

export function createPackageManager(options: PackageServiceOptions): PackageManager {
  return new PackageManager(options);
}

async function canonicalProjectDirectory(value: string): Promise<string> {
  if (!isAbsoluteNonEmptyPath(value)) {
    throw new PackageError("invalid_request", "project directory must be an absolute path");
  }
  try {
    const path = await realpath(value);
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("project directory is not a directory");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PackageError("invalid_request", "project directory does not exist: " + value);
    }
    if (error instanceof PackageError) throw error;
    throw new PackageError("invalid_request", "project directory is unavailable: " + messageOf(error));
  }
}

async function projectLockfile(project: string): Promise<string | null> {
  const path = join(project, "renv.lock");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PackageError("package_metadata_error", "renv.lock must be a regular file");
    }
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof PackageError) throw error;
    throw new PackageError("package_metadata_error", "could not inspect renv.lock: " + messageOf(error));
  }
}

interface RenvLockRecord {
  readonly package: string;
  readonly version: string;
  readonly source: string;
  readonly repository: string | null;
}

const MAX_RENV_LOCKFILE_BYTES = 16 * 1024 * 1024;

async function readRenvLockSnapshot(path: string): Promise<Map<string, RenvLockRecord>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new PackageError("package_metadata_error", "could not read renv.lock: " + messageOf(error));
  }
  let value: unknown;
  try {
    value = parseStrictJson(bytes, { maxBytes: MAX_RENV_LOCKFILE_BYTES, maxDepth: 64 });
  } catch (error) {
    throw new PackageError("package_metadata_error", "renv.lock is not strict JSON: " + messageOf(error), error);
  }
  if (!isRecord(value) || !isRecord(value.R) || !isRecord(value.Packages)) {
    throw new PackageError("package_metadata_error", "renv.lock must contain R and Packages objects");
  }
  const r = value.R;
  if (!strictLockString(r.Version, "R.Version") || !Array.isArray(r.Repositories)) {
    throw new PackageError("package_metadata_error", "renv.lock has an invalid R record");
  }
  const repositoryNames = new Set<string>();
  for (const repository of r.Repositories) {
    if (!isRecord(repository) || !strictLockString(repository.Name, "repository Name")
      || !strictLockString(repository.URL, "repository URL") || repositoryNames.has(repository.Name)) {
      throw new PackageError("package_metadata_error", "renv.lock has an invalid repository record");
    }
    repositoryNames.add(repository.Name);
  }
  const records = new Map<string, RenvLockRecord>();
  for (const [name, record] of Object.entries(value.Packages)) {
    if (!PACKAGE_NAME_RE.test(name) || !isRecord(record)
      || record.Package !== name
      || !strictLockString(record.Package, "package Package")
      || !strictLockString(record.Version, "package Version")
      || !strictLockString(record.Source, "package Source")) {
      throw new PackageError("package_metadata_error", "renv.lock has an invalid package record: " + name);
    }
    const source = record.Source;
    const repository = record.Repository === undefined ? null : record.Repository;
    if (repository !== null && !strictLockString(repository, "package Repository")) {
      throw new PackageError("package_metadata_error", "renv.lock has an invalid package repository: " + name);
    }
    if (["repository", "cran", "p3m", "ppm", "rspm", "bioconductor"].includes(source.toLowerCase())
      && repository === null) {
      throw new PackageError("package_metadata_error", "renv.lock package lacks repository identity: " + name);
    }
    for (const [field, fieldValue] of Object.entries(record)) {
      if (field.startsWith("Remote") && !strictLockString(fieldValue, "package " + field)) {
        throw new PackageError("package_metadata_error", "renv.lock has an invalid remote identity: " + name);
      }
    }
    records.set(name, { package: name, version: record.Version, source, repository });
  }
  return records;
}

function requireLockedPackages(packages: readonly string[], records: ReadonlyMap<string, RenvLockRecord>): void {
  const missing = packages.filter(packageName => !records.has(packageName));
  if (missing.length > 0) {
    throw new PackageError(
      "package_metadata_error",
      "renv.lock does not declare requested package(s): " + missing.join(", "),
      { missing },
    );
  }
}

function strictLockString(value: unknown, label: string): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 * 1024
    && !/[\u0000-\u001f\u007f]/u.test(value) && label.length > 0;
}

async function existingDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function ensureProjectLibrary(project: string, library: string): Promise<void> {
  const alder = join(project, ".alder");
  await mkdir(alder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const alderInfo = await lstat(alder);
  if (!alderInfo.isDirectory() || alderInfo.isSymbolicLink()) throw new Error("project .alder path must be a real directory");
  await mkdir(library, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const libraryInfo = await lstat(library);
  if (!libraryInfo.isDirectory() || libraryInfo.isSymbolicLink()) throw new Error("project package library must be a real directory");
  const [physicalProject, physicalLibrary] = await Promise.all([realpath(project), realpath(library)]);
  if (physicalLibrary !== join(physicalProject, ".alder", "library")) throw new Error("project package library escapes the project directory");
}

function checkedWorkerStatus(value: unknown): { records: WorkerPackageRecord[]; library: string | null } {
  if (!isRecord(value)) {
    throw new PackageError("job_protocol_error", "package worker returned invalid status data");
  }
  if (value.ok === false) {
    const detail = isRecord(value.error) ? value.error : {};
    const code = typeof detail.code === "string" ? detail.code as PackageErrorCode : "job_failed";
    const message = typeof detail.message === "string" ? detail.message : "package status failed";
    throw new PackageError(code, message, detail);
  }
  if (value.ok !== true || value.status !== "installed" || !Array.isArray(value.records)
    || value.records.some(record => !isRecord(record)
      || typeof record.package !== "string"
      || (record.status !== "installed" && record.status !== "missing")
      || (record.version !== null && typeof record.version !== "string")
      || (record.library !== null && typeof record.library !== "string"))) {
    throw new PackageError("job_protocol_error", "package worker returned invalid status data");
  }
  if (value.library !== null && typeof value.library !== "string") {
    throw new PackageError("job_protocol_error", "package worker returned an invalid library path");
  }
  return { records: value.records as WorkerPackageRecord[], library: value.library as string | null };
}

interface WorkerPackageRecord {
  readonly package: string;
  readonly status: PackageState;
  readonly version: string | null;
  readonly library: string | null;
}

function statusRecords(packages: readonly string[], worker: readonly WorkerPackageRecord[]): PackageStatusRecord[] {
  const byName = new Map(worker.map(record => [record.package, record]));
  return packages.map(packageName => {
    const record = byName.get(packageName);
    if (record === undefined) return { package: packageName, status: "missing", version: null, library: null };
    return { package: packageName, status: record.status, version: record.version, library: record.library };
  });
}

function normalizeInstallResult(
  value: unknown,
  declarations: PackageDeclarations,
  mode: PackageInstallMode,
  lockfile: string | null,
  requested: string[],
  library: string | null,
): PackageInstallResult {
  if (!isRecord(value)
    || typeof value.ok !== "boolean"
    || (value.status !== "installed" && value.status !== "error")
    || !Array.isArray(value.records)
    || value.records.some(record => !isRecord(record)
      || typeof record.package !== "string"
      || (record.status !== "installed" && record.status !== "missing")
      || (record.version !== null && typeof record.version !== "string")
      || (record.library !== null && typeof record.library !== "string"))
    || (value.library !== null && typeof value.library !== "string")
    || typeof value.mutatedLibrary !== "boolean"
    || typeof value.output !== "string") {
    throw new PackageError("job_protocol_error", "package worker returned invalid install data");
  }
  const records = statusRecords(requested, value.records as WorkerPackageRecord[]);
  const error = value.error === null || value.error === undefined ? null : installError(value.error);
  const ok = value.ok && value.status === "installed" && error === null && records.every(record => record.status === "installed");
  const resultLibrary = mode === "renv" ? value.library as string | null : library;
  return {
    ok,
    status: ok ? "installed" : "error",
    path: declarations.path,
    metadata: declarations.metadata,
    sidecarVersion: declarations.sidecarVersion,
    mode,
    lockfile,
    library: resultLibrary,
    packages: requested,
    installed: records.filter(record => record.status === "installed").map(record => record.package),
    missing: records.filter(record => record.status === "missing").map(record => record.package),
    installing: [],
    mutatedLibrary: value.mutatedLibrary,
    result: ok ? {
      status: "installed",
      library: resultLibrary,
      packages: requested,
      installed: records.filter(record => record.status === "installed").map(record => record.package),
      missing: records.filter(record => record.status === "missing").map(record => record.package),
      output: value.output,
      packageStatus: records,
    } : null,
    output: value.output,
    packageStatus: records,
    error: ok ? null : error ?? {
      code: "install_failed",
      message: "requested packages remain unavailable",
      output: value.output,
    },
  };
}

function installError(value: unknown): PackageInstallError {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw new PackageError("job_protocol_error", "package worker returned invalid install error data");
  }
  const status = typeof value.status === "number" || value.status === null ? value.status : undefined;
  const output = typeof value.output === "string" ? value.output : undefined;
  return {
    code: value.code,
    message: value.message,
    ...(status === undefined ? {} : { status }),
    ...(output === undefined ? {} : { output }),
    ...(value.details === undefined ? {} : { details: value.details }),
  };
}

function failedInstall(
  declarations: PackageDeclarations,
  mode: PackageInstallMode,
  lockfile: string | null,
  library: string | null,
  requested: string[],
  error: PackageError,
  mutatedLibrary: boolean,
): PackageInstallResult {
  const errorValue: PackageInstallError = {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
  return {
    ok: false,
    status: "error",
    path: declarations.path,
    metadata: declarations.metadata,
    sidecarVersion: declarations.sidecarVersion,
    mode,
    lockfile,
    library,
    packages: requested,
    installed: [],
    missing: requested,
    installing: [],
    mutatedLibrary,
    result: null,
    output: typeof error.details === "object" && error.details !== null && "output" in error.details
      && typeof (error.details as Record<string, unknown>).output === "string"
      ? (error.details as Record<string, string>).output
      : "",
    packageStatus: requested.map(packageName => ({ package: packageName, status: "missing", version: null, library: null })),
    error: errorValue,
  };
}

function sidecarVersion(observation: DiskObservation): string | null {
  if (observation.state !== "present") return null;
  return observation.version ?? observation.digest;
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && path.length > 0))];
}

function isAbsoluteNonEmptyPath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
