import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, lstat, mkdir, open, chmod, rename, rm, unlink, writeFile, readdir, link } from "node:fs/promises";

import { basename, dirname, join, resolve, sep } from "node:path";
import envPaths from "env-paths";
import lockfile, { type LockOptions } from "proper-lockfile";
import { SharedBackend } from "./backend-client.js";
import {
  HOST_PROTOCOL,
  MAX_PROTOCOL_COLLECTION_ITEMS,
  attachLeaseRequestSchema,
  hostIdentitySchema,
  leaseActionRequestSchema,
  sessionLeaseSchema,
  sessionIdentitySchema,
  sessionRegistryMetadataSchema,
  type SessionConnection,
  type SessionRequest,
  type SessionLease,
  type SessionRegistryMetadata,
} from "./protocol.js";
import { parseStrictJson } from "./strict-json.js";
import { ensurePrivateDirectory, ensurePrivateFile, readPrivateFile, securePrivateDirectory, verifyPrivateDirectory, verifyPrivateFile, writePrivateFile, type PrivatePathOptions } from "./private-paths.js";
export const STARTUP_TIMEOUT_MS = 120_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const LEASE_EXPIRY_MS = 30_000;
export const LOCK_STALE_MS = 30_000;
export const LOCK_UPDATE_MS = 10_000;
export const MAX_ACTIVE_LEASES = 128;
export const MAX_LIVE_TICKETS = 128;
const POLL_INTERVAL_MS = 100;
const RUNTIME_MODE = 0o700;
const REGISTRY_MODE = 0o600;
const LOOPBACK_HOSTS = new Set(["127.0.0.1"]);
const IDENTITY_REQUEST_TIMEOUT_MS = 2_000;
const SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/;
const UNTITLED_SESSION_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DETACHED_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "ALDER_PERF_TRACE_DIR",
  "ALDER_PERF_RPROF",
  "XDG_RUNTIME_DIR",
  "R_LIBS",
  "R_LIBS_USER",
  "R_LIBS_SITE",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
] as const;

function inheritedDetachedEnvironment(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of DETACHED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}
export interface SessionResources {
  /** Absolute application root used as the detached host cwd. */
  readonly root?: string;
  /** Absolute bundled Node executable used to launch a candidate host. */
  readonly nodeExecutable?: string;
  /** Absolute bundled host entry module used by a candidate host. */
  readonly hostEntry?: string;
  /** Absolute native process supervisor used for detached ownership. */
  readonly processSupervisorExecutable?: string | null;
}

export const UNTITLED_RECOVERY_SCHEMA_VERSION = 1 as const;
const UNTITLED_RECOVERY_DIRECTORY = "untitled-recoveries";
const UNTITLED_RECOVERY_DESCRIPTOR_MAX_BYTES = 64 * 1024;

export interface UntitledRecoveryDescriptor {
  readonly schemaVersion: typeof UNTITLED_RECOVERY_SCHEMA_VERSION;
  readonly id: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
}

export interface HostLaunchOptions {
  externalOrigin?: string;
  tokenFile?: string;
  path: string | null;
  sessionKey: string;
  runtimeDirectory: string;
  projectDirectory?: string;
  rscript?: string;
  executionMode?: "automatic" | "lazy";
  runOnStartup?: boolean;
  deferStartup?: boolean;
}

export interface AcquireNotebookSessionOptions {
  readonly launchHost?: (options: HostLaunchOptions) => Promise<void>;
  readonly path: string | null;
  /** Explicit local recovery identity; only valid when path is null. */
  readonly untitledRecoveryId?: string;
  /** Existing writable directory used as the project root for a new untitled notebook. */
  readonly untitledProjectDirectory?: string;
  readonly resources: SessionResources;
  readonly rscript?: string;
  readonly executionMode?: "automatic" | "lazy";
  readonly runOnStartup?: boolean;
  readonly deferStartup?: boolean;
  /** Explicit constraints for joining an already-running host; spawn flags stay separate. */
  readonly requestedConfiguration?: {
    readonly rscript?: string;
    readonly executionMode?: "automatic" | "lazy";
    readonly runOnStartup?: boolean;
    readonly deferStartup?: boolean;
  };
  readonly startupTimeoutMs?: number;
  readonly runtimeDirectory?: string;
  /** Exact HTTPS origin accepted from the external reverse proxy. */
  readonly externalOrigin?: string;
  /** Owner-only bearer token file path forwarded to a detached candidate. */
  readonly tokenFile?: string;
}

export interface NotebookOwnershipOptions {
  readonly path: string | null;
  /** Parent-generated key used to bind an untitled child to its launch. */
  readonly sessionKey?: string;
  readonly runtimeDirectory?: string;
  readonly origin?: string;
  readonly pid?: number;
  readonly epoch?: string;
  readonly processNonce?: string;
  readonly continuityProof?: string;
  readonly token?: string;
  readonly startIdentity?: string;
  /** Native supervisor used to query this process identity on non-Linux hosts. */
  readonly processSupervisorExecutable?: string | null;
  readonly protocol?: string;
  /** Invoked exactly once when any ownership lock is compromised. */
  readonly onCompromised?: LockCompromiseHandler;
}
export interface PreparedNotebookRekey {
  readonly canonicalPath: string;
  readonly sessionKey: string;
  /**
   * Publish through the returned binder before changing active ownership.
   * A binder failure leaves the source claim authoritative and releases the
   * destination reservation.
   */
  commit(preparePublication: () => Promise<() => void | Promise<void>>): Promise<void>;
  abort(): Promise<void>;
}

export interface NotebookOwnership {
  readonly sessionKey: string;
  readonly canonicalPath: string | null;
  readonly registryPath: string;
  readonly lockPath: string;
  readonly epoch: string;
  readonly processNonce: string;
  readonly continuityProof: string;
  readonly token: string;
  readonly pid: number;
  readonly lockRelease: () => Promise<void>;
  readonly publishReady: (origin: string, address?: { host: string; port: number; origin: string; browserOrigin: string }) => Promise<void>;
  readonly prepareRekey: (path: string) => Promise<PreparedNotebookRekey>;
  readonly close: () => Promise<void>;
}

export class SessionUnavailableError extends Error {
  readonly code = "session_unavailable";
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SessionUnavailableError";
  }
}


export class SessionAuthError extends Error {
  readonly code = "session_auth_failed";
  constructor(message: string) {
    super(message);
    this.name = "SessionAuthError";
  }
}

export class SessionConfigurationConflictError extends Error {
  readonly code = "session_configuration_conflict";
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SessionConfigurationConflictError";
  }
}
function validateExternalAuthOptions(options: AcquireNotebookSessionOptions): boolean {
  const hasOrigin = options.externalOrigin !== undefined;
  const hasTokenFile = options.tokenFile !== undefined;
  if (hasOrigin !== hasTokenFile) {
    throw new SessionAuthError("--external-origin and --token-file must be supplied together");
  }
  if (options.tokenFile !== undefined && (options.tokenFile.length === 0 || options.tokenFile.includes("\0"))) {
    throw new SessionAuthError("--token-file must be a non-empty path");
  }
  if (options.externalOrigin === undefined) return false;
  let origin: URL;
  try {
    origin = new URL(options.externalOrigin);
  } catch {
    throw new SessionAuthError("--external-origin must be an exact HTTPS origin");
  }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== ""
    || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" || origin.origin !== options.externalOrigin) {
    throw new SessionAuthError("--external-origin must be an exact HTTPS origin");
  }
  return true;
}

export function isUntitledRecoveryId(value: unknown): value is string {
  return typeof value === "string" && UNTITLED_SESSION_KEY_PATTERN.test(value);
}

/** Return the owner-only local descriptor directory used by the launcher. */
export function untitledRecoveryDescriptorDirectory(dataRoot?: string): string {
  return join(resolve(dataRoot ?? envPaths("alder", { suffix: "" }).data), UNTITLED_RECOVERY_DIRECTORY);
}

/** Register one exact untitled identity without exposing a global catalog. */
export async function registerUntitledRecoveryDescriptor(
  id: string,
  projectDirectory: string,
  dataRoot?: string,
  privatePathOptions: PrivatePathOptions = {},
): Promise<UntitledRecoveryDescriptor> {
  const validId = requireUntitledRecoveryId(id);
  const validProjectDirectory = normalizeProjectDirectory(projectDirectory);
  const directory = await ensureUntitledRecoveryDirectory(dataRoot, privatePathOptions);
  const path = untitledRecoveryDescriptorPath(directory, validId);
  const current = await readUntitledRecoveryDescriptor(path, validId, privatePathOptions);
  if (current !== null) {
    if (current.projectDirectory !== validProjectDirectory) {
      throw new SessionUnavailableError("untitled recovery identity belongs to another project", { id: validId });
    }
    return current;
  }
  const descriptor: UntitledRecoveryDescriptor = {
    schemaVersion: UNTITLED_RECOVERY_SCHEMA_VERSION,
    id: validId,
    projectDirectory: validProjectDirectory,
    createdAt: new Date().toISOString(),
  };
  await atomicWriteUntitledRecoveryDescriptor(path, descriptor, privatePathOptions);
  const written = await readUntitledRecoveryDescriptor(path, validId, privatePathOptions);
  if (written === null) throw new SessionUnavailableError("untitled recovery descriptor disappeared after registration", { id: validId });
  if (written.projectDirectory !== validProjectDirectory) {
    throw new SessionUnavailableError("untitled recovery identity changed during registration", { id: validId });
  }
  return written;
}

/** List only valid owner-controlled descriptors; unknown files remain untouched. */
export async function listUntitledRecoveryDescriptors(dataRoot?: string, privatePathOptions: PrivatePathOptions = {}): Promise<UntitledRecoveryDescriptor[]> {
  const directory = await ensureUntitledRecoveryDirectory(dataRoot, privatePathOptions);
  const entries = await readdir(directory, { withFileTypes: true });
  const descriptors: UntitledRecoveryDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!isUntitledRecoveryId(id)) continue;
    try {
      const descriptor = await readUntitledRecoveryDescriptor(join(directory, entry.name), id, privatePathOptions);
      if (descriptor !== null) descriptors.push(descriptor);
    } catch (error) {
      // Preserve malformed/stale artifacts rather than letting one unknown
      // file block explicit selection of the remaining recoveries.
      if (!(error instanceof SessionUnavailableError)) throw error;
    }
  }
  descriptors.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return descriptors;
}

/** Select one exact descriptor; no directory-wide recovery is performed. */
export async function selectUntitledRecoveryDescriptor(id: string, dataRoot?: string, privatePathOptions: PrivatePathOptions = {}): Promise<UntitledRecoveryDescriptor> {
  const validId = requireUntitledRecoveryId(id);
  const directory = await ensureUntitledRecoveryDirectory(dataRoot, privatePathOptions);
  const descriptor = await readUntitledRecoveryDescriptor(untitledRecoveryDescriptorPath(directory, validId), validId, privatePathOptions);
  if (descriptor === null) throw new SessionUnavailableError("untitled recovery descriptor was not found", { id: validId });
  return descriptor;
}

/** Retire exactly one descriptor after an explicit adoption or discard. */
export async function retireUntitledRecoveryDescriptor(expected: UntitledRecoveryDescriptor, dataRoot?: string, privatePathOptions: PrivatePathOptions = {}): Promise<void> {
  const validId = requireUntitledRecoveryId(expected?.id);
  const directory = await ensureUntitledRecoveryDirectory(dataRoot, privatePathOptions);
  const path = untitledRecoveryDescriptorPath(directory, validId);
  const expectedDescriptor = parseUntitledRecoveryDescriptor(expected, validId, path);
  const descriptor = await readUntitledRecoveryDescriptor(path, validId, privatePathOptions);
  if (descriptor === null) return;
  if (descriptor.schemaVersion !== expectedDescriptor.schemaVersion
    || descriptor.id !== expectedDescriptor.id
    || descriptor.projectDirectory !== expectedDescriptor.projectDirectory
    || descriptor.createdAt !== expectedDescriptor.createdAt) {
    throw new SessionUnavailableError("untitled recovery descriptor changed before retirement", { id: validId });
  }
  await verifyPrivateFile(path, privatePathOptions);
  await unlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

const lockOptions: LockOptions = {
  realpath: false,
  // proper-lockfile's stale check only knows about mtime. Ownership is
  // reclaimable only after the registry owner has failed an authenticated
  // health probe and its recorded PID is proven dead, so never let the
  // library reclaim one of these locks on mtime alone.
  stale: Number.MAX_SAFE_INTEGER,
  update: LOCK_UPDATE_MS,
  retries: { retries: 0 },
  // An asynchronous compromise callback cannot safely throw into the caller
  // that acquired the lock. Per-lock callbacks below record the compromise
  // and operations turn it into a typed unavailable error instead.
  onCompromised: () => undefined,
};

// Prepared Save As claims must never reclaim an existing or stale artifact.
// The preflight lock check is paired with a deliberately non-expiring lock
// policy so a race cannot turn an unknown destination claim into ours.
const reservationLockOptions: LockOptions = {
  ...lockOptions,
  stale: Number.MAX_SAFE_INTEGER,
  update: 1_000,
};

 type LockCompromiseHandler = (error: Error) => void | Promise<void>;

function lockOptionsFor(target: string, base: LockOptions = lockOptions, onCompromised?: LockCompromiseHandler): LockOptions {
  return {
    ...base,
    onCompromised: (error: Error): void => {
      try {
        const result = onCompromised?.(error);
        if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // Compromise handling must never rethrow into proper-lockfile's timer.
      }
    },
  };
}
function sameRegistryAddress(left: SessionRegistryMetadata["address"], right: SessionRegistryMetadata["address"]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.host === right.host
    && left.port === right.port
    && left.origin === right.origin
    && left.browserOrigin === right.browserOrigin;
}
function sameRegistryOwner(left: SessionRegistryMetadata, right: SessionRegistryMetadata): boolean {
  return left.pid === right.pid
    && left.startIdentity === right.startIdentity
    && left.processNonce === right.processNonce
    && left.continuityProof === right.continuityProof
    && left.epoch === right.epoch
    && left.token === right.token
    && left.protocol === right.protocol
    && left.canonicalPath === right.canonicalPath
    && left.origin === right.origin
    && sameRegistryAddress(left.address, right.address);
}

const launches = new Map<string, Promise<void>>();

/**
 * Acquire a client lease for the canonical notebook host. A client never
 * constructs a Controller or Engine and never owns the notebook lock.
 */
export async function acquireNotebookSession(options: AcquireNotebookSessionOptions): Promise<SessionConnection> {
  const hasExternalAuth = validateExternalAuthOptions(options);
  const canonicalPath = await canonicalizePath(options.path);
  if (canonicalPath !== null && (options.untitledRecoveryId !== undefined || options.untitledProjectDirectory !== undefined)) {
    throw new SessionAuthError("untitled options cannot be combined with a notebook path");
  }
  const processSupervisorExecutable = options.resources?.processSupervisorExecutable;
  const selectedRecovery = canonicalPath === null && options.untitledRecoveryId !== undefined
    ? await selectUntitledRecoveryDescriptor(options.untitledRecoveryId, undefined, { processSupervisorExecutable })
    : undefined;
  const sessionKey = canonicalPath === null ? selectedRecovery?.id ?? randomUUID() : await sessionKeyFor(canonicalPath);
  const projectDirectory = canonicalPath === null
    ? selectedRecovery?.projectDirectory ?? resolve(options.untitledProjectDirectory ?? process.cwd())
    : undefined;
  if (projectDirectory !== undefined) await registerUntitledRecoveryDescriptor(sessionKey, projectDirectory, undefined, { processSupervisorExecutable });
  const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > STARTUP_TIMEOUT_MS) {
    throw new RangeError(`startupTimeoutMs must be between 1 and ${STARTUP_TIMEOUT_MS}`);
  }
  const runtime = await runtimePaths(options.runtimeDirectory, processSupervisorExecutable);
  const deadline = Date.now() + timeoutMs;

  let metadata = await readRegistry(runtime.registryPath(sessionKey));
  while (metadata?.state === "stopping") {
    const alive = await ownerLiveness(metadata);
    if (alive === false) break;
    if (Date.now() >= deadline) {
      throw new SessionUnavailableError("notebook host did not finish stopping before the startup deadline", {
        sessionKey,
        registryPath: runtime.registryPath(sessionKey),
        lockPath: runtime.lockPath(sessionKey),
      });
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    metadata = await readRegistry(runtime.registryPath(sessionKey));
  }
  if (metadata?.state === "ready") {
    if (hasExternalAuth) {
      const ownerState = await ownerLiveness(metadata);
      if (ownerState !== false) {
        throw new SessionUnavailableError("external authentication settings cannot attach to an existing notebook host", { sessionKey });
      }
    } else {
      const connection = await tryAttach(metadata, sessionKey, options);
      if (connection) return connection;
    }
    await assertReclaimable(metadata, runtime.lockPath(sessionKey), sessionKey);
  } else if (metadata?.state === "stopping") {
    await assertReclaimable(metadata, runtime.lockPath(sessionKey), sessionKey);
  } else if (metadata?.state === "starting") {
    // A concurrent candidate is allowed to finish. Starting metadata with a
    // live/unknown owner is not evidence that a second owner may be started.
    const ownerState = await ownerLiveness(metadata);
    if (ownerState !== false) {
      if (hasExternalAuth) {
        throw new SessionUnavailableError("external authentication settings cannot attach to an existing notebook host", { sessionKey });
      }
      await waitForReady(runtime, sessionKey, deadline);
      metadata = await readRegistry(runtime.registryPath(sessionKey));
      if (metadata?.state === "ready") {
        const connection = await tryAttach(metadata, sessionKey, options);
        if (connection) return connection;
      }
      throw new SessionUnavailableError("notebook host did not publish authenticated readiness", {
        sessionKey,
        lockPath: runtime.lockPath(sessionKey),
      });
    }
    await assertReclaimable(metadata, runtime.lockPath(sessionKey), sessionKey);
  }
  let launch = launches.get(sessionKey);
  let launchedHere = false;
  if (launch !== undefined && hasExternalAuth) {
    throw new SessionUnavailableError("external authentication settings cannot attach to an existing notebook host", { sessionKey });
  }
  if (launch === undefined) {
    launchedHere = true;
    launch = options.launchHost
      ? options.launchHost({ path: canonicalPath, sessionKey, runtimeDirectory: runtime.directory, projectDirectory, rscript: options.rscript, executionMode: options.executionMode, runOnStartup: options.runOnStartup, deferStartup: options.deferStartup })
      : launchCandidate({ ...options, path: canonicalPath }, runtime, sessionKey, deadline, projectDirectory);
    launches.set(sessionKey, launch);
    void launch.then(
      () => { if (launches.get(sessionKey) === launch) launches.delete(sessionKey); },
      () => { if (launches.get(sessionKey) === launch) launches.delete(sessionKey); },
    );
  }
  let startupTimer: NodeJS.Timeout | undefined;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    await Promise.race([
      launch,
      new Promise<void>(resolveStartup => { startupTimer = setTimeout(resolveStartup, remaining); }),
    ]);
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
  }
  await waitForReady(runtime, sessionKey, deadline);
  metadata = await readRegistry(runtime.registryPath(sessionKey));
  if (metadata?.state !== "ready") {
    throw new SessionUnavailableError("notebook host did not become ready before the 120-second startup deadline", {
      sessionKey,
      registryPath: runtime.registryPath(sessionKey),
      lockPath: runtime.lockPath(sessionKey),
    });
  }
  if (hasExternalAuth && !launchedHere) {
    throw new SessionUnavailableError("external authentication settings cannot attach to an existing notebook host", { sessionKey });
  }
  const connection = await tryAttach(metadata, sessionKey, options);
  if (connection) return connection;
  throw new SessionUnavailableError("notebook host readiness failed authenticated identity validation", {
    sessionKey,
    registryPath: runtime.registryPath(sessionKey),
  });
}

/**
 * Host-side ownership acquisition. This is called before Engine, Ark,
 * analyzer, LSP, or package-job construction. The lock remains held until
 * close and metadata is written before any child may be started.
 */
export async function acquireNotebookOwnership(options: NotebookOwnershipOptions): Promise<NotebookOwnership> {
  const canonicalPath = await canonicalizePath(options.path);
  const runtime = await runtimePaths(options.runtimeDirectory, options.processSupervisorExecutable);
  const sessionKey = await ownershipSessionKey(canonicalPath, options.sessionKey);
  const registryPath = runtime.registryPath(sessionKey);
  const lockPath = runtime.lockPath(sessionKey);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  const pid = options.pid ?? process.pid;
  const epoch = options.epoch ?? randomUUID();
  const processNonce = options.processNonce ?? randomUUID();
  const continuityProof = options.continuityProof ?? randomBytes(32).toString("hex");
  const startIdentity = options.startIdentity ?? await currentProcessStartIdentity(pid, options.processSupervisorExecutable) ?? `pid:${pid}:${processNonce}`;
  let currentOrigin = options.origin ?? "http://127.0.0.1:0";
  const token = options.token ?? randomBytes(32).toString("hex");
  let closed = false;
  let currentPath = canonicalPath;
  let currentKey = sessionKey;
  let currentRegistry = registryPath;
  let currentLock = lockPath;
  let compromiseError: Error | undefined;
  const handleCompromise: LockCompromiseHandler = (error: Error): void | Promise<void> => {
    if (compromiseError !== undefined) return;
    compromiseError = error;
    return options.onCompromised?.(error);
  };
  const throwIfCompromised = (): void => {
    if (compromiseError === undefined) return;
    throw new SessionUnavailableError("notebook ownership lock was compromised; owned work is unavailable", {
      lockPath: currentLock,
      cause: compromiseError.message,
    });
  };
  const ownershipLockOptions = (target: string, base: LockOptions = lockOptions): LockOptions => lockOptionsFor(target, base, handleCompromise);
  const metadataFor = (state: "starting" | "ready" | "stopping", path: string | null, origin: string, address?: { host: string; port: number; origin: string; browserOrigin: string }): SessionRegistryMetadata => sessionRegistryMetadataSchema.parse({
    state,
    pid,
    processNonce,
    continuityProof,
    startIdentity,
    origin,
    canonicalPath: path,
    epoch,
    token,
    protocol: options.protocol ?? HOST_PROTOCOL,
    ...(address === undefined ? {} : { address }),
  });
  const metadata = (state: "starting" | "ready" | "stopping", address?: { host: string; port: number; origin: string; browserOrigin: string }): SessionRegistryMetadata => metadataFor(state, currentPath, currentOrigin, address);

  await ensureRegistryFile(registryPath);
  await ensureRegistryFile(runtime.recoveryPath(sessionKey));
  let releaseLock: (() => Promise<void>) | undefined;
  const activeRekeyCommits = new Set<Promise<void>>();
  let lastError: unknown;
  for (;;) {
    throwIfCompromised();
    let releaseRecovery: (() => Promise<void>) | undefined;
    try {
      try {
        releaseRecovery = await acquirePrivateLock(runtime.recoveryPath(sessionKey), ownershipLockOptions(runtime.recoveryPath(sessionKey)), runtime.privatePathOptions);
      } catch (error) {
        lastError = error;
        const current = await readRegistry(registryPath);
        if (current !== null) await assertReclaimable(current, lockPath, sessionKey);
        else if (await lockPresent(lockPath)) throw unavailableLock(registryPath, lockPath, lastError);
        if (Date.now() >= deadline) throw unavailableLock(registryPath, lockPath, lastError);
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      throwIfCompromised();
      const observed = await readRegistry(registryPath);
      if (observed !== null) {
        // Recovery is authorized only for a proven-dead owner whose
        // authenticated health probe also failed. This check is repeated
        // after taking the registry lock below before replacing the claim.
        await assertReclaimable(observed, lockPath, sessionKey);
      } else if (await lockPresent(lockPath)) {
        throw unavailableLock(registryPath, lockPath, new Error("owner metadata is missing"));
      }

      let candidateRelease: (() => Promise<void>) | undefined;
      try {
        candidateRelease = await acquirePrivateLock(runtime.lockTarget(sessionKey), ownershipLockOptions(runtime.lockTarget(sessionKey)), runtime.privatePathOptions);
      } catch (error) {
        lastError = error;
        const current = await readRegistry(registryPath);
        if (current !== null) {
          await assertReclaimable(current, lockPath, sessionKey);
          await reclaimOwnerLock(lockPath, runtime.privatePathOptions);
        } else if (await lockPresent(lockPath)) throw unavailableLock(registryPath, lockPath, lastError);
        if (Date.now() >= deadline) throw unavailableLock(registryPath, lockPath, lastError);
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      throwIfCompromised();

      try {
        const current = await readRegistry(registryPath);
        const changed = (observed === null) !== (current === null)
          || (observed !== null && current !== null && !sameRegistryOwner(current, observed));
        if (changed) {
          throw unavailableLock(registryPath, lockPath, new Error("owner metadata changed during stale-claim recovery"));
        }
        if (current !== null) await assertReclaimable(current, lockPath, sessionKey);
        await atomicWriteRegistry(registryPath, metadata("starting"));
        releaseLock = candidateRelease;
        candidateRelease = undefined;
        break;
      } finally {
        await candidateRelease?.().catch(() => undefined);
      }
    } finally {
      await releaseRecovery?.().catch(() => undefined);
    }
  }

  const publishReady = async (readyOrigin: string, address?: { host: string; port: number; origin: string; browserOrigin: string }): Promise<void> => {
    throwIfCompromised();
    if (closed) throw new SessionUnavailableError("notebook ownership is closed");
    if (address === undefined || address.origin !== readyOrigin) throw new SessionAuthError("readiness must publish the numeric connection origin and browser origin together");
    await withRecoveryMutex(runtime, currentKey, async () => {
      if (closed) throw new SessionUnavailableError("notebook ownership is closed");
      const current = await readRegistry(currentRegistry);
      const expected = current === null ? null : metadataFor(current.state, currentPath, currentOrigin, current.address);
      if (current === null || (current.state !== "starting" && current.state !== "ready") || expected === null || !sameRegistryOwner(current, expected)) {
        throw new SessionUnavailableError("notebook ownership changed before readiness publication", { registryPath: currentRegistry });
      }
      currentOrigin = readyOrigin;
      await atomicWriteRegistry(currentRegistry, metadata("ready", address));
    }, handleCompromise);
  };
  const prepareRekey = async (path: string): Promise<PreparedNotebookRekey> => {
    throwIfCompromised();
    if (closed) throw new SessionUnavailableError("notebook ownership is closed");
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      throw new TypeError("Save As destination path must be a non-empty path");
    }
    const spelling = resolve(path);
    const destination = await canonicalizePath(spelling);
    if (destination === null) throw new TypeError("Save As requires a destination path");
    if (destination === currentPath) {
      throw new SessionUnavailableError("Save As destination is already the active notebook", { path: destination });
    }
    const destinationKey = await sessionKeyFor(destination);
    if (destinationKey === currentKey) {
      throw new SessionUnavailableError("Save As destination is already the active notebook", { path: destination });
    }
    const destinationRegistry = runtime.registryPath(destinationKey);
    const destinationLock = runtime.lockPath(destinationKey);
    if (await pathPresent(destinationRegistry)) {
      throw unavailableLock(destinationRegistry, destinationLock, new Error("destination ownership metadata already exists"));
    }
    if (await lockPresent(destinationLock)) {
      throw unavailableLock(destinationRegistry, destinationLock, new Error("destination ownership lock already exists"));
    }

    const targetOrigin = currentOrigin;
    const reservationMetadata = metadataFor("starting", destination, targetOrigin);
    let releaseDestination: (() => Promise<void>) | undefined;
    let reservationWriteAttempted = false;
    let reservationReleased = false;
    let phase: "prepared" | "committing" | "committed" | "aborted" = "prepared";
    let commitPublished = false;
    let commitPromise: Promise<void> | undefined;
    const removeReservationArtifact = async (): Promise<void> => {
      if (!reservationWriteAttempted) return;
      try {
        const current = await readRegistry(destinationRegistry);
        if (current !== null && (current.state === "starting" || current.state === "ready") && sameRegistryOwner(current, reservationMetadata)) {
          await unlink(destinationRegistry).catch(() => undefined);
        }
      } catch {
        // Preserve unknown/corrupt destination artifacts rather than deleting them.
      }
    };
    try {
      releaseDestination = await acquirePrivateLock(destinationRegistry, ownershipLockOptions(destinationRegistry, reservationLockOptions), runtime.privatePathOptions);
      if (await pathPresent(destinationRegistry)) {
        const existing = await readRegistry(destinationRegistry);
        throw unavailableLock(destinationRegistry, destinationLock, new Error(existing === null
          ? "destination ownership metadata appeared during reservation"
          : "destination ownership metadata is already claimed"));
      }
      reservationWriteAttempted = true;
      await atomicWriteRegistry(destinationRegistry, reservationMetadata);
    } catch (error) {
      await removeReservationArtifact();
      await releaseDestination?.().catch(() => undefined);
      throw error;
    }

    const releaseDestinationLock = async (): Promise<void> => {
      if (reservationReleased) return;
      reservationReleased = true;
      const release = releaseDestination;
      releaseDestination = undefined;
      await release?.().catch(() => undefined);
    };
    const cleanupReservation = async (): Promise<void> => {
      await removeReservationArtifact();
      await releaseDestinationLock();
    };
    const abort = async (): Promise<void> => {
      if (phase === "committed" || phase === "aborted") return;
      if (commitPromise !== undefined) {
        await commitPromise.catch(() => undefined);
        return;
      }
      phase = "aborted";
      await cleanupReservation();
    };
    const commit = (preparePublication: () => Promise<() => void | Promise<void>>): Promise<void> => {
      throwIfCompromised();
      if (phase !== "prepared") throw new SessionUnavailableError("prepared Save As ownership is no longer available");
      if (typeof preparePublication !== "function") throw new TypeError("Save As publication preparation is required");
      const operation = (async (): Promise<void> => {
        phase = "committing";
        try {
          const oldRegistry = currentRegistry;
          const oldPath = currentPath;
          const oldKey = currentKey;
          const oldRelease = releaseLock;
          await withRecoveryMutex(runtime, oldKey, async () => {
            const oldMetadata = await readRegistry(oldRegistry);
            if (closed || oldMetadata === null || oldMetadata.state !== "ready" || !sameRegistryOwner(oldMetadata, metadataFor("ready", oldPath, targetOrigin, oldMetadata.address))) {
              throw new SessionUnavailableError("active notebook ownership changed before Save As commit");
            }
            const reserved = await readRegistry(destinationRegistry);
            if (reserved === null || reserved.state !== "starting" || !sameRegistryOwner(reserved, reservationMetadata)) {
              throw new SessionUnavailableError("prepared Save As ownership reservation changed");
            }
            const publishBinding = await preparePublication();
            if (typeof publishBinding !== "function") throw new TypeError("Save As publication preparation returned no binder");
            if (closed) throw new SessionUnavailableError("notebook ownership is closed");
            let destinationReady: SessionRegistryMetadata | undefined;
            await withRecoveryMutex(runtime, destinationKey, async () => {
              const stillOld = await readRegistry(oldRegistry);
              if (stillOld === null || stillOld.state !== "ready" || !sameRegistryOwner(stillOld, metadataFor("ready", oldPath, targetOrigin, stillOld.address))) {
                throw new SessionUnavailableError("active notebook ownership changed during Save As preparation");
              }
              const stillReserved = await readRegistry(destinationRegistry);
              if (stillReserved === null || stillReserved.state !== "starting" || !sameRegistryOwner(stillReserved, reservationMetadata)) {
                throw new SessionUnavailableError("prepared Save As ownership reservation changed");
              }
              destinationReady = metadataFor("ready", destination, targetOrigin, stillOld.address);
              await atomicWriteRegistry(destinationRegistry, destinationReady);
            }, handleCompromise);
            try {
              await publishBinding();
            } catch (error) {
              if (destinationReady !== undefined) await removeExactRegistry(destinationRegistry, destinationReady);
              await releaseDestinationLock();
              throw error;
            }
            commitPublished = true;
            phase = "committed";
            currentPath = destination;
            currentKey = destinationKey;
            currentRegistry = destinationRegistry;
            currentLock = destinationLock;
            releaseLock = releaseDestination;
            releaseDestination = undefined;
            await removeExactRegistry(oldRegistry, oldMetadata);
            await oldRelease?.().catch(() => undefined);
          }, handleCompromise);
        } catch (error) {
          if (!commitPublished) {
            phase = "aborted";
            await cleanupReservation();
          }
          throw error;
        }
      })();
      commitPromise = operation;
      activeRekeyCommits.add(operation);
      void operation.finally(() => {
        if (commitPromise === operation) commitPromise = undefined;
        activeRekeyCommits.delete(operation);
      }).catch(() => undefined);
      return operation;
    };
    return { canonicalPath: destination, sessionKey: destinationKey, commit, abort };
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const rekeyCommits = [...activeRekeyCommits];
    if (rekeyCommits.length > 0) await Promise.allSettled(rekeyCommits);
    const closeKey = currentKey;
    const closePath = currentPath;
    const closeRegistry = currentRegistry;
    const closeOrigin = currentOrigin;
    await withRecoveryMutex(runtime, closeKey, async () => {
      const current = await readRegistry(closeRegistry);
      const expected = current === null ? null : metadataFor(current.state, closePath, closeOrigin, current.address);
      if (current === null || (current.state !== "starting" && current.state !== "ready") || expected === null || !sameRegistryOwner(current, expected)) return;
      const stopping = metadataFor("stopping", closePath, closeOrigin, current.address);
      await atomicWriteRegistry(closeRegistry, stopping).catch(() => undefined);
      await removeExactRegistry(closeRegistry, stopping);
    }, handleCompromise).catch(() => undefined);
    await releaseLock?.().catch(() => undefined);
    releaseLock = undefined;
  };

  return {
    get sessionKey() { return currentKey; },
    get canonicalPath() { return currentPath; },
    get registryPath() { return currentRegistry; },
    get lockPath() { return currentLock; },
    epoch,
    processNonce,
    token,
    continuityProof,
    pid,
    lockRelease: async () => { await releaseLock?.(); },
    publishReady,
    prepareRekey,
    close,
  };
}


async function canonicalRscriptPath(value: string): Promise<string> {
  const requested = resolve(value);
  try {
    return await realpath(requested);
  } catch {
    // Runtime validation belongs to the host. Identity comparison must still
    // let clients attach to a document whose selected R is unavailable.
    return requested;
  }
}

async function assertAttachConfiguration(
  identity: ReturnType<typeof hostIdentitySchema.parse>,
  requested: AcquireNotebookSessionOptions | undefined,
  sessionKey: string,
): Promise<void> {
  if (requested === undefined) return;
  const active = identity.configuration;
  const activeRscript = active.rscript === null ? null : await canonicalRscriptPath(active.rscript);
  const join = requested.requestedConfiguration;
  const requestedConfiguration: Record<string, unknown> = {};
  const requestedRscript = join?.rscript ?? requested.rscript;
  const requestedExecutionMode = join?.executionMode ?? requested.executionMode;
  const requestedRunOnStartup = join?.runOnStartup ?? requested.runOnStartup;
  const requestedDeferStartup = join?.deferStartup;
  if (requestedRscript !== undefined) requestedConfiguration.rscript = await canonicalRscriptPath(requestedRscript);
  if (requestedExecutionMode !== undefined) requestedConfiguration.executionMode = requestedExecutionMode;
  if (requestedRunOnStartup !== undefined) requestedConfiguration.runOnStartup = requestedRunOnStartup;
  if (requestedDeferStartup !== undefined) requestedConfiguration.deferStartup = requestedDeferStartup;
  const comparisons: Array<[string, unknown, unknown]> = [
    ["rscript", requestedConfiguration.rscript, activeRscript],
    ["executionMode", requestedConfiguration.executionMode, active.executionMode],
    ["runOnStartup", requestedConfiguration.runOnStartup, active.runOnStartup],
    ["deferStartup", requestedConfiguration.deferStartup, active.deferStartup],
  ];
  const mismatch = comparisons.find(([, value, current]) => value !== undefined && value !== current);
  if (mismatch !== undefined) {
    throw new SessionConfigurationConflictError("existing notebook host uses different runtime settings; joining would not change its active configuration", {
      sessionKey,
      setting: mismatch[0],
      requested: requestedConfiguration,
      active: { ...active, rscript: activeRscript },
    });
  }
}

async function tryAttach(metadata: SessionRegistryMetadata, sessionKey: string, requested?: AcquireNotebookSessionOptions): Promise<SessionConnection | null> {
  if (metadata.state !== "ready" || metadata.address === undefined
    || metadata.address.origin !== metadata.origin || metadata.address.browserOrigin.length === 0) return null;
  const token = metadata.token;
  const origin = metadata.address.origin;
  const browserOrigin = metadata.address.browserOrigin;
  try {
    const identity = hostIdentitySchema.parse(await requestJson<Record<string, unknown>>(origin, token, "/api/identity", { method: "GET", signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS) }, metadata.continuityProof));
    const parsedIdentity = sessionIdentitySchema.parse({
      sessionKey: identity.sessionKey,
      canonicalPath: identity.canonicalPath,
      origin: identity.origin,
      browserOrigin: identity.browserOrigin,
      epoch: identity.epoch,
      processNonce: identity.processNonce,
    });
    const identityAddress = identity.address;
    const capabilities = parseIdentityCapabilities(identity.capabilities);
    const sameCanonicalPath = await sameNotebookIdentity(parsedIdentity.canonicalPath, metadata.canonicalPath);
    if (parsedIdentity.sessionKey !== sessionKey
      || parsedIdentity.origin !== metadata.origin
      || parsedIdentity.browserOrigin !== browserOrigin
      || identityAddress === undefined
      || identityAddress.host !== metadata.address.host
      || identityAddress.port !== metadata.address.port
      || identityAddress.origin !== metadata.origin
      || identityAddress.browserOrigin !== browserOrigin
      || identity.continuityProof !== metadata.continuityProof
      || parsedIdentity.epoch !== metadata.epoch
      || parsedIdentity.processNonce !== metadata.processNonce
      || !sameCanonicalPath) {
      throw new SessionAuthError("authenticated host identity does not match registry metadata");
    }
    await assertAttachConfiguration(identity, requested, sessionKey);
    const lease = await requestJson(origin, token, "/api/lease", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attachLeaseRequestSchema.parse({ action: "attach" })),
      signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
    }, metadata.continuityProof);
    return createConnection(
      { ...metadata, origin },
      sessionKey,
      token,
      sessionLeaseSchema.parse(lease),
      identity.continuityProof,
      browserOrigin,
      capabilities,
    );
  } catch (error) {
    if (error instanceof SessionConfigurationConflictError) throw error;
    return null;
  }
}

function parseIdentityCapabilities(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROTOCOL_COLLECTION_ITEMS || value.some(capability => typeof capability !== "string" || capability.length > 256)) {
    throw new SessionAuthError("authenticated host identity has invalid capabilities");
  }
  return [...value];
}
function createConnection(
  metadata: SessionRegistryMetadata,
  sessionKey: string,
  token: string,
  lease: SessionLease,
  continuityProof: string,
  browserOrigin: string,
  capabilities: string[] = [],
): SessionConnection {
  let released = false;
  let nextCommandSequence = lease.nextCommandSequence;
  const authenticatedHeaders = (init: RequestInit = {}): Headers => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer " + token);
    headers.set("X-Alder-Lease-Id", lease.leaseId);
    headers.set("X-Alder-Client-Id", lease.clientId);
    return headers;
  };
  const authenticatedJsonHeaders = (): Headers => {
    const headers = authenticatedHeaders({});
    headers.set("Content-Type", "application/json");
    return headers;
  };
  const request: SessionRequest = async (path, init = {}) => {
    if (released) throw new SessionUnavailableError("session lease is released");
    const response = await requestRaw(metadata.origin, token, path, { ...init, headers: authenticatedHeaders(init) });
    if (response.headers.get("X-Alder-Continuity-Proof") !== continuityProof) throw new SessionAuthError("host HTTP continuity proof changed");
    return response;
  };
  const heartbeat = async (): Promise<void> => {
    if (released) return;
    const response = await request("/api/lease", {
      method: "POST",
      headers: authenticatedJsonHeaders(),
      body: JSON.stringify(leaseActionRequestSchema.parse({ action: "heartbeat", leaseId: lease.leaseId })),
    });
    if (!response.ok) throw new SessionUnavailableError("session heartbeat failed (" + response.status + ")");
    const current = sessionLeaseSchema.parse(await response.json());
    nextCommandSequence = Math.max(nextCommandSequence, current.nextCommandSequence);
    connection.nextCommandSequence = nextCommandSequence;
  };
  let releasePromise: Promise<void> | undefined;
  const release = (disposition: "normal" | "discard" = "normal"): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    releasePromise = (async () => {
      await request("/api/lease", {
        method: "POST",
        headers: authenticatedJsonHeaders(),
        body: JSON.stringify(leaseActionRequestSchema.parse({ action: "release", leaseId: lease.leaseId, disposition })),
      }).catch(() => undefined);
      released = true;
    })();
    return releasePromise;
  };
  const interval = setInterval(() => { void heartbeat().catch(() => undefined); }, HEARTBEAT_INTERVAL_MS);
  interval.unref();
  const connection: SessionConnection = {
    sessionKey,
    canonicalPath: metadata.canonicalPath,
    origin: metadata.origin,
    browserOrigin,
    epoch: metadata.epoch,
    processNonce: metadata.processNonce,
    continuityProof,
    leaseId: lease.leaseId,
    clientId: lease.clientId,
    nextCommandSequence,
    capabilities: [...capabilities],
    request,
    heartbeat,
    release: async (disposition = "normal") => {
      clearInterval(interval);
      await release(disposition);
    },
  };
  return connection;
}

export async function releaseNotebookSession(connection: SessionConnection): Promise<void> {
  await connection.release();
}
async function launchCandidate(options: AcquireNotebookSessionOptions, runtime: RuntimePaths, sessionKey: string, _deadline: number, projectDirectory?: string): Promise<void> {
  const { root, nodeExecutable, hostEntry } = options.resources;
  if (!root || !nodeExecutable || !hostEntry) throw new SessionUnavailableError("bundled document service is unavailable");
  await new SharedBackend({ root, nodeExecutable, hostEntry }, runtime.directory).open({
    path: options.path, sessionKey, runtimeDirectory: runtime.directory, projectDirectory,
    rscript: options.rscript, executionMode: options.executionMode,
    runOnStartup: options.runOnStartup, deferStartup: options.deferStartup,
    externalOrigin: options.externalOrigin, tokenFile: options.tokenFile,
  });
}

async function assertReclaimable(metadata: SessionRegistryMetadata, lockPath: string, sessionKey?: string): Promise<void> {
  const alive = await ownerLiveness(metadata);
  if (alive !== false) {
    throw new SessionUnavailableError("notebook owner liveness is alive or unknown; manual stale-lock recovery is required", {
      lockPath,
      pid: metadata.pid,
      state: metadata.state,
    });
  }
  if (await authenticatedHealth(metadata, sessionKey)) {
    throw new SessionUnavailableError("authenticated notebook owner remains active", { lockPath, pid: metadata.pid });
  }
}

async function authenticatedHealth(metadata: SessionRegistryMetadata, sessionKey?: string): Promise<boolean> {
  if (metadata.state !== "ready" || metadata.address === undefined || metadata.address.origin !== metadata.origin || metadata.address.browserOrigin.length === 0) return false;
  try {
    const value = hostIdentitySchema.parse(await requestJson<Record<string, unknown>>(metadata.address.origin, metadata.token, "/api/identity", { method: "GET", signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS) }, metadata.continuityProof));
    return (sessionKey === undefined || value.sessionKey === sessionKey)
      && value.processNonce === metadata.processNonce
      && value.continuityProof === metadata.continuityProof
      && value.epoch === metadata.epoch
      && value.canonicalPath === metadata.canonicalPath
      && value.origin === metadata.origin
      && value.browserOrigin === metadata.address.browserOrigin
      && value.address !== undefined
      && value.address.host === metadata.address.host
      && value.address.port === metadata.address.port
      && value.address.origin === metadata.address.origin
      && value.address.browserOrigin === metadata.address.browserOrigin;
  } catch {
    return false;
  }
}

async function ownerLiveness(metadata: SessionRegistryMetadata): Promise<boolean | null> {
  const pidState = await pidAlive(metadata.pid);
  if (pidState !== true) return pidState;
  const observed = await processStartIdentity(metadata.pid);
  if (observed === null) return null;
  return observed === metadata.startIdentity ? true : null;
}

async function waitForReady(runtime: RuntimePaths, sessionKey: string, deadline: number): Promise<void> {
  for (;;) {
    const metadata = await readRegistry(runtime.registryPath(sessionKey));
    if (metadata?.state === "ready") return;
    if (metadata?.state === "stopping") throw new SessionUnavailableError("notebook host is stopping; retry after it exits", { sessionKey });
    if (Date.now() >= deadline) {
      throw new SessionUnavailableError("notebook host did not become ready before the 120-second startup deadline", {
        sessionKey,
        registryPath: runtime.registryPath(sessionKey),
        lockPath: runtime.lockPath(sessionKey),
      });
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

async function requestRaw(origin: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError("session request path must be origin-relative");
  let base: URL;
  try { base = new URL(origin); } catch { throw new SessionAuthError("session registry origin is invalid"); }
  const hostname = base.hostname.replace(/^\[|\]$/g, "");
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname) || base.username !== "" || base.password !== "" || base.pathname !== "/" || base.search !== "" || base.hash !== "") {
    throw new SessionAuthError("session registry origin is not a loopback HTTP origin");
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new TypeError("session request may not change origin");
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + token);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers, redirect: "error" });
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new SessionAuthError("session response exceeds the byte limit");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new SessionAuthError("session response exceeds the byte limit"); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function requestJson<T>(origin: string, token: string, path: string, init: RequestInit = {}, expectedProof?: string): Promise<T> {
  const response = await requestRaw(origin, token, path, init);
  if (expectedProof !== undefined && response.headers.get("X-Alder-Continuity-Proof") !== expectedProof) {
    await response.body?.cancel().catch(() => undefined);
    throw new SessionAuthError("host HTTP continuity proof changed");
  }
  const bytes = await readBoundedResponse(response, 1024 * 1024);
  let value: unknown = null;
  if (bytes.length > 0) {
    try {
      value = parseStrictJson(bytes, { maxBytes: 1024 * 1024, maxDepth: 64 });
    } catch (error) {
      throw new SessionAuthError(error instanceof Error ? error.message : "session response is not valid JSON");
    }
  }
  if (!response.ok) {
    const detail = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    throw new SessionAuthError(typeof detail.message === "string" ? detail.message : "session request failed (" + response.status + ")");
  }
  return value as T;
}

async function readRegistry(path: string, privatePathOptions: PrivatePathOptions = privatePathOptionsFor(path)): Promise<SessionRegistryMetadata | null> {
  try {
    const bytes = await readPrivateFile(path, { ...privatePathOptions, maxBytes: 64 * 1024 });
    if (bytes.byteLength === 0) return null;
    return sessionRegistryMetadataSchema.parse(parseStrictJson(bytes, { maxBytes: 64 * 1024, maxDepth: 32 }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new SessionUnavailableError("notebook registry metadata is corrupt; manual stale-lock recovery is required", { path });
  }
}

async function atomicWriteRegistry(path: string, value: SessionRegistryMetadata, privatePathOptions: PrivatePathOptions = privatePathOptionsFor(path)): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  try {
    await writePrivateFile(path, bytes, privatePathOptions);
  } catch (error) {
    throw new SessionUnavailableError("notebook registry metadata could not be written safely", { path, cause: error instanceof Error ? error.message : String(error) });
  }
}
async function ensureUntitledRecoveryDirectory(dataRoot?: string, privatePathOptions: PrivatePathOptions = {}): Promise<string> {
  const directory = untitledRecoveryDescriptorDirectory(dataRoot);
  try {
    await ensurePrivateDirectory(directory, privatePathOptions);
  } catch (error) {
    throw new SessionUnavailableError("untitled recovery descriptor directory must be private and owner-controlled", {
      directory,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return directory;
}

function requireUntitledRecoveryId(value: unknown): string {
  if (!isUntitledRecoveryId(value)) throw new SessionUnavailableError("untitled recovery identity is invalid", { id: value });
  return value;
}

function normalizeProjectDirectory(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new SessionUnavailableError("untitled recovery project directory is invalid");
  }
  return resolve(value);
}

function untitledRecoveryDescriptorPath(directory: string, id: string): string {
  return join(directory, id + ".json");
}

async function readUntitledRecoveryDescriptor(path: string, id: string, privatePathOptions: PrivatePathOptions = {}): Promise<UntitledRecoveryDescriptor | null> {
  try {
    const bytes = await readPrivateFile(path, { ...privatePathOptions, maxBytes: UNTITLED_RECOVERY_DESCRIPTOR_MAX_BYTES });
    if (bytes.byteLength === 0) throw new SessionUnavailableError("untitled recovery descriptor is empty", { path });
    return parseUntitledRecoveryDescriptor(parseStrictJson(bytes, { maxBytes: UNTITLED_RECOVERY_DESCRIPTOR_MAX_BYTES, maxDepth: 16 }), id, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SessionUnavailableError) throw error;
    throw new SessionUnavailableError("untitled recovery descriptor is corrupt", { path });
  }
}

function parseUntitledRecoveryDescriptor(value: unknown, id: string, path: string): UntitledRecoveryDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionUnavailableError("untitled recovery descriptor is not an object", { path });
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== "createdAt\0id\0projectDirectory\0schemaVersion") throw new SessionUnavailableError("untitled recovery descriptor has unexpected fields", { path });
  if (record.schemaVersion !== UNTITLED_RECOVERY_SCHEMA_VERSION || record.id !== id || !isUntitledRecoveryId(record.id)) throw new SessionUnavailableError("untitled recovery descriptor identity is invalid", { path });
  if (typeof record.projectDirectory !== "string" || record.projectDirectory.length === 0 || record.projectDirectory.includes("\0") || resolve(record.projectDirectory) !== record.projectDirectory) {
    throw new SessionUnavailableError("untitled recovery descriptor project directory is invalid", { path });
  }
  if (typeof record.createdAt !== "string" || !isIsoTimestamp(record.createdAt)) throw new SessionUnavailableError("untitled recovery descriptor timestamp is invalid", { path });
  return { schemaVersion: UNTITLED_RECOVERY_SCHEMA_VERSION, id, projectDirectory: record.projectDirectory, createdAt: record.createdAt };
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

async function atomicWriteUntitledRecoveryDescriptor(path: string, descriptor: UntitledRecoveryDescriptor, privatePathOptions: PrivatePathOptions = {}): Promise<void> {
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  const bytes = Buffer.from(JSON.stringify(descriptor) + "\n");
  try {
    await writePrivateFile(temporary, bytes, privatePathOptions);
    await link(temporary, path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureRegistryFile(path: string, privatePathOptions: PrivatePathOptions = privatePathOptionsFor(path)): Promise<void> {
  try {
    await ensurePrivateFile(path, privatePathOptions);
  } catch (error) {
    throw new SessionUnavailableError("notebook registry path is not private and owner-controlled", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

interface RuntimePaths {
  readonly directory: string;
  readonly privatePathOptions: PrivatePathOptions;
  readonly registryPath: (sessionKey: string) => string;
  readonly lockPath: (sessionKey: string) => string;
  readonly lockTarget: (sessionKey: string) => string;
  readonly recoveryPath: (sessionKey: string) => string;
  readonly logPath: (sessionKey: string) => string;
}
const privatePathOptionsByDirectory = new Map<string, PrivatePathOptions>();

function privatePathOptionsFor(path: string): PrivatePathOptions {
  let selected: PrivatePathOptions | undefined;
  let selectedLength = -1;
  for (const [directory, options] of privatePathOptionsByDirectory) {
    if ((path === directory || path.startsWith(directory + sep)) && directory.length > selectedLength) {
      selected = options;
      selectedLength = directory.length;
    }
  }
  return selected ?? {};
}
async function runtimePaths(explicit?: string, processSupervisorExecutable?: string | null): Promise<RuntimePaths> {
  const directory = resolve(explicit ?? process.env.ALDER_RUNTIME_DIRECTORY ?? join(envPaths("alder").data, "runtime"));
  const privatePathOptions: PrivatePathOptions = { processSupervisorExecutable };
  await ensurePrivateDirectory(directory, privatePathOptions);
  privatePathOptionsByDirectory.set(directory, privatePathOptions);
  return {
    directory,
    privatePathOptions,
    registryPath: key => join(directory, `${key}.json`),
    lockPath: key => join(directory, `${key}.json.lock`),
    lockTarget: key => join(directory, `${key}.json`),
    recoveryPath: key => join(directory, `${key}.recovery`),
    logPath: key => join(directory, `${key}.log`),
  };
}

async function canonicalizePath(path: string | null): Promise<string | null> {
  if (path === null) return null;
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realpath(dirname(absolute)), basename(absolute));
  }
}
async function sessionKeyFor(path: string | null): Promise<string> {
  if (path === null) return randomUUID();
  return createHash("sha256").update("path:" + path).digest("hex");
}

async function ownershipSessionKey(canonicalPath: string | null, supplied: string | undefined): Promise<string> {
  if (supplied === undefined) return sessionKeyFor(canonicalPath);
  const expected = canonicalPath === null ? null : await sessionKeyFor(canonicalPath);
  const valid = canonicalPath === null
    ? UNTITLED_SESSION_KEY_PATTERN.test(supplied)
    : SESSION_KEY_PATTERN.test(supplied) && supplied === expected;
  if (!valid) throw new SessionAuthError("ownership session key does not match the canonical notebook identity");
  return supplied;
}

async function sameNotebookIdentity(left: string | null, right: string | null): Promise<boolean> {
  if (left === right) return true;
  if (left === null || right === null) return false;
  try {
    return (await sessionKeyFor(left)) === (await sessionKeyFor(right));
  } catch {
    // A missing/replaced path cannot prove that two distinct spellings still
    // refer to one notebook. Exact spellings remain valid above.
    return false;
  }
}

async function pidAlive(pid: number): Promise<boolean | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

async function processStartIdentity(_pid: number): Promise<string | null> {
  return null;
}

async function currentProcessStartIdentity(_pid: number, _supervisorExecutable?: string | null): Promise<string | null> {
  return null;
}

function parseAddress(origin: string): { host: string; port: number; origin: string } {
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname === "[::1]" ? "::1" : parsed.hostname;
    const port = parsed.port === "" ? parsed.protocol === "https:" ? 443 : 80 : Number(parsed.port);
    return { host, port, origin: parsed.origin };
  } catch {
    return { host: "127.0.0.1", port: 0, origin };
  }
}

function unavailableLock(registryPath: string, lockPath: string, cause: unknown): SessionUnavailableError {
  return new SessionUnavailableError("notebook lock acquisition timed out; manual stale-lock recovery is required", {
    registryPath,
    lockPath,
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}

async function hardenLockDirectory(path: string, privatePathOptions: PrivatePathOptions): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await verifyPrivateDirectory(path, privatePathOptions);
    return;
  }
  await chmod(path, RUNTIME_MODE);
  await verifyPrivateDirectory(path, privatePathOptions);
}

async function reclaimOwnerLock(path: string, privatePathOptions: PrivatePathOptions): Promise<void> {
  try {
    await hardenLockDirectory(path, privatePathOptions);
    await rm(path, { recursive: true, force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquirePrivateLock(target: string, options: LockOptions, privatePathOptions: PrivatePathOptions = privatePathOptionsFor(target)): Promise<() => Promise<void>> {
  const release = await lockfile.lock(target, options);
  try {
    await hardenLockDirectory(target + ".lock", privatePathOptions);
    return release;
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

async function lockPresent(path: string, privatePathOptions: PrivatePathOptions = privatePathOptionsFor(path)): Promise<boolean> {
  try {
    await verifyPrivateDirectory(path, privatePathOptions);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof Error && "code" in error && String((error as { code?: unknown }).code).startsWith("private_path_")) return true;
    throw error;
  }
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withRecoveryMutex<T>(runtime: RuntimePaths, sessionKey: string, callback: () => Promise<T>, onCompromised?: LockCompromiseHandler): Promise<T> {
  const path = runtime.recoveryPath(sessionKey);
  await ensureRegistryFile(path, runtime.privatePathOptions);
  const release = await acquirePrivateLock(path, lockOptionsFor(path, lockOptions, onCompromised), runtime.privatePathOptions);
  try {
    return await callback();
  } finally {
    await release().catch(() => undefined);
  }
}

async function removeExactRegistry(path: string, expected: SessionRegistryMetadata): Promise<void> {
  try {
    const current = await readRegistry(path);
    if (current !== null && current.state === expected.state && sameRegistryOwner(current, expected)) {
      await unlink(path).catch(() => undefined);
    }
  } catch {
    // Preserve unknown/corrupt artifacts; committed ownership is authoritative.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
