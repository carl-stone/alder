import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open as openFile, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export type PrivatePathKind = "file" | "directory";

export interface PrivatePathOptions {
  // Kept while the execution and session callers migrate off the former supervisor.
  readonly processSupervisorExecutable?: string | null;
}

export interface ReadPrivateFileOptions extends PrivatePathOptions {
  readonly maxBytes?: number;
  /** Deterministic test seam for changing the file between fstats. */
  readonly beforeRead?: () => void | Promise<void>;
}

export type PrivatePathErrorCode =
  | "private_path_invalid"
  | "private_path_missing"
  | "private_path_type"
  | "private_path_reparse"
  | "private_path_overshared"
  | "private_path_too_large";

export class PrivatePathError extends Error {
  constructor(
    readonly code: PrivatePathErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PrivatePathError";
  }
}

const DEFAULT_READ_MAX_BYTES = 16 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PATH_CONTROL = /[\u0000]/;

function invalid(message: string, cause?: unknown): PrivatePathError {
  return new PrivatePathError("private_path_invalid", message, cause);
}

function missing(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`private path does not exist: ${path}`), { code: "ENOENT", path });
}
function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(errorCode(error) ?? "");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function ensurePathString(path: string): string {
  if (typeof path !== "string" || path.length === 0 || PATH_CONTROL.test(path)) {
    throw invalid("private path must be a non-empty path without NUL");
  }
  return resolve(path);
}

interface PathInspection {
  readonly path: string;
  readonly exists: boolean;
}

/**
 * lstat every existing component before any operation. This is deliberately
 * separate from the final leaf checks: a safe leaf below a substituted parent
 * is not a private path.
 */
async function inspectPath(path: string, expectFinal: PrivatePathKind | null = null): Promise<PathInspection> {
  const absolute = ensurePathString(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let exists = true;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        exists = false;
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new PrivatePathError("private_path_reparse", `private path component is a symlink: ${current}`);
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new PrivatePathError("private_path_type", `private path component is not a directory: ${current}`);
    }
    if (index === components.length - 1 && expectFinal !== null) {
      if (expectFinal === "directory" && !info.isDirectory()) {
        throw new PrivatePathError("private_path_type", `private path is not a directory: ${absolute}`);
      }
      if (expectFinal === "file" && !info.isFile()) {
        throw new PrivatePathError("private_path_type", `private path is not a regular file: ${absolute}`);
      }
    }
  }
  return { path: absolute, exists };
}

function validatePrivateStats(
  info: Awaited<ReturnType<typeof lstat>>,
  kind: PrivatePathKind,
  path: string,
): void {
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new PrivatePathError("private_path_type", `private path is not a ${kind}: ${path}`);
  }
  if (info.isSymbolicLink()) {
    throw new PrivatePathError("private_path_reparse", `private path is a symlink: ${path}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new PrivatePathError("private_path_overshared", `private path is not owned by the current user: ${path}`);
  }
  if ((Number(info.mode) & 0o077) !== 0) {
    throw new PrivatePathError("private_path_overshared", `private path is accessible by group or other users: ${path}`);
  }
}

async function inspectExisting(
  path: string,
  kind: PrivatePathKind,
  options: PrivatePathOptions,
): Promise<PathInspection> {
  const inspection = await inspectPath(path, kind);
  if (!inspection.exists) throw missing(inspection.path);
  const info = await lstat(inspection.path);
  validatePrivateStats(info, kind, inspection.path);
  return inspection;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

export async function verifyPrivateDirectory(path: string, options: PrivatePathOptions = {}): Promise<void> {
  const inspection = await inspectExisting(path, "directory", options);
  const info = await lstat(inspection.path);
  validatePrivateStats(info, "directory", inspection.path);
}

export async function verifyPrivateFile(path: string, options: PrivatePathOptions = {}): Promise<void> {
  const inspection = await inspectExisting(path, "file", options);
  const info = await lstat(inspection.path);
  validatePrivateStats(info, "file", inspection.path);
}

export async function securePrivateDirectory(path: string, options: PrivatePathOptions = {}): Promise<void> {
  const inspection = await inspectExisting(path, "directory", options);
  await chmod(inspection.path, DIRECTORY_MODE);
  await verifyPrivateDirectory(inspection.path, options);
}

export async function securePrivateFile(path: string, options: PrivatePathOptions = {}): Promise<void> {
  const inspection = await inspectExisting(path, "file", options);
  await chmod(inspection.path, FILE_MODE);
  await verifyPrivateFile(inspection.path, options);
}

export async function ensurePrivateDirectory(path: string, options: PrivatePathOptions = {}): Promise<void> {
  const inspection = await inspectPath(path);
  if (inspection.exists) {
    await verifyPrivateDirectory(inspection.path, options);
    return;
  }
  await mkdir(inspection.path, { recursive: true, mode: DIRECTORY_MODE });
  await inspectPath(inspection.path, "directory");
  await securePrivateDirectory(inspection.path, options);
}

export async function readPrivateFile(path: string, options: ReadPrivateFileOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw invalid("maxBytes must be a non-negative safe integer");
  const inspection = await inspectPath(path, "file");
  if (!inspection.exists) throw missing(inspection.path);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(inspection.path, flags);
    const info = await handle.stat();
    validatePrivateStats(info, "file", inspection.path);
    if (!Number.isSafeInteger(info.size) || info.size > maxBytes) {
      throw new PrivatePathError("private_path_too_large", "private file exceeds " + maxBytes + " bytes: " + inspection.path);
    }
    await options.beforeRead?.();
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead <= 0) throw invalid("private file was truncated while being read: " + inspection.path);
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    validatePrivateStats(after, "file", inspection.path);
    if (
      after.dev !== info.dev || after.ino !== info.ino || after.mode !== info.mode || after.nlink !== info.nlink ||
      after.uid !== info.uid || after.gid !== info.gid || after.rdev !== info.rdev || after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.birthtimeMs !== info.birthtimeMs
    ) {
      throw invalid("private file changed while being read: " + inspection.path);
    }
    return bytes;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

export async function writePrivateFile(
  path: string,
  bytes: Uint8Array,
  options: PrivatePathOptions = {},
): Promise<void> {
  const inspection = await inspectPath(path, null);
  const parent = dirname(inspection.path);
  await ensurePrivateDirectory(parent, options);
  try {
    const target = await lstat(inspection.path);
    if (target.isSymbolicLink()) throw new PrivatePathError("private_path_reparse", "private path is a symlink: " + inspection.path);
    if (!target.isFile()) throw new PrivatePathError("private_path_type", "private path is not a regular file: " + inspection.path);
    validatePrivateStats(target, "file", inspection.path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const basename = inspection.path.slice(inspection.path.lastIndexOf(sep) + 1);
  const temporary = join(parent, `.${basename}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await openFile(temporary, flags, FILE_MODE);
    const info = await handle.stat();
    validatePrivateStats(info, "file", temporary);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) throw invalid(`short private file write: ${inspection.path}`);
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, FILE_MODE);
    await rename(temporary, inspection.path);
    await syncDirectory(parent);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function ensurePrivateFile(path: string, options: PrivatePathOptions = {}): Promise<void> {
  const inspection = await inspectPath(path, null);
  const parent = dirname(inspection.path);
  await ensurePrivateDirectory(parent, options);
  if (inspection.exists) {
    await verifyPrivateFile(inspection.path, options);
    return;
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(inspection.path, flags, FILE_MODE);
    const info = await handle.stat();
    validatePrivateStats(info, "file", inspection.path);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await securePrivateFile(inspection.path, options);
    await syncDirectory(parent);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (errorCode(error) === "EEXIST") {
      await verifyPrivateFile(inspection.path, options);
      return;
    }
    await rm(inspection.path, { force: true }).catch(() => undefined);
    throw error;
  }
}
