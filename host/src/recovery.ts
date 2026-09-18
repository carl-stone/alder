import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalBase64ByteLength, MAX_NOTEBOOK_CELLS, MAX_NOTEBOOK_SOURCE_BYTES, sidecarObservationsSchema } from "./protocol.js";
import { readPrivateFile } from "./private-paths.js";

export type RecoveryJsonValue = null | boolean | number | string | RecoveryJsonValue[] | { [key: string]: RecoveryJsonValue };
export type RecoveryJsonObject = { [key: string]: RecoveryJsonValue };
export interface DiskObservation {
  state: "untitled" | "absent" | "present" | "unreadable";
  digest?: string | null;
  version?: string | null;
  error?: RecoveryJsonValue | null;
  identity?: string | null;
  mode?: number;
}
export interface RecoverySidecarObservations { config: DiskObservation; layout: DiskObservation; packages: DiskObservation; }
export interface RecoveryCellState { readonly id: string; readonly revision: number; }
export interface RecoveryBaseline {
  schemaVersion: 1;
  physicalBytes: string | Uint8Array | ArrayBuffer;
  documentRevision: number;
  cells: readonly RecoveryCellState[];
  path?: string | null;
  project?: RecoveryJsonValue;
  config?: RecoveryJsonValue;
  layout?: RecoveryJsonValue;
  packageDeclarationIntent?: RecoveryJsonValue;
  notebookDiskObservation: DiskObservation;
  sidecarObservations: RecoverySidecarObservations;
}
export interface RecoveryCheckpoint { readonly notebookDiskObservation: DiskObservation; readonly sidecarObservations: RecoverySidecarObservations; }
export type RecoveryStatus = "empty" | "clean" | "recovered";
export interface RecoveryBranch { readonly id: string; readonly documentRevision: number; readonly status: RecoveryStatus; readonly fingerprint: string; }
export interface RecoveryState {
  schemaVersion: 1;
  generation: string | null;
  baseline: RecoveryBaseline;
  documentRevision: number;
  status: RecoveryStatus;
  pending: boolean;
  fingerprint: string | null;
  branches: readonly RecoveryBranch[];
}
export interface RecoveryRebindTarget { readonly rootDir: string; readonly key: string; readonly baseline: RecoveryBaseline; }
export interface PreparedRecoveryRebind {
  readonly writer: RecoveryWriter;
  readonly state: RecoveryState;
  publish(): Promise<void>;
  adopt(): void;
  abort(): Promise<void>;
}
export interface RecoveryBranchFork { readonly id?: string; readonly baseline?: RecoveryBaseline; }
export interface RecoveryBranchDropExpected { readonly documentRevision: number; readonly fingerprint: string; }
export interface RecoveryWriterOptions {
  rootDir: string;
  key: string;
  baseline: RecoveryBaseline;
  snapshotIntervalMs?: number;
  processSupervisorExecutable?: string | null;
}
export type RecoveryErrorCode = "recovery_corrupt" | "recovery_write_failed" | "recovery_invalid" | "recovery_closed";
export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode, message: string, readonly details: RecoveryJsonValue | null = null, readonly originals: readonly string[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RecoveryError";
  }
}

interface StoredBranch { id: string; baseline: RecoveryBaseline; fingerprint: string; }
interface Snapshot {
  schemaVersion: 2;
  baseline: RecoveryBaseline;
  pending: boolean;
  fingerprint: string;
  branches: StoredBranch[];
}
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_NAME = /^snapshot-\d+-[0-9a-f-]+\.json$/;
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: RecoveryBaseline): string => hash(JSON.stringify(value));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function recoveryObservationMatches(expected: DiskObservation, actual: DiskObservation): boolean {
  return expected.state !== "unreadable" && actual.state !== "unreadable"
    && expected.state === actual.state && expected.digest === actual.digest
    && expected.version === actual.version && expected.identity === actual.identity && expected.mode === actual.mode;
}

function normalizeBaseline(input: RecoveryBaseline): RecoveryBaseline {
  const rawBytes = input.physicalBytes;
  const bytes = typeof rawBytes === "string" ? rawBytes : Buffer.from(rawBytes instanceof ArrayBuffer ? new Uint8Array(rawBytes) : rawBytes).toString("base64");
  const length = canonicalBase64ByteLength(bytes);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.documentRevision) || input.documentRevision < 0
      || length === null || length > MAX_NOTEBOOK_SOURCE_BYTES || !Array.isArray(input.cells) || input.cells.length > MAX_NOTEBOOK_CELLS) {
    throw new RecoveryError("recovery_invalid", "Recovery snapshot has invalid document data");
  }
  const ids = new Set<string>();
  for (const cell of input.cells) {
    if (typeof cell?.id !== "string" || cell.id.length === 0 || ids.has(cell.id) || !Number.isSafeInteger(cell.revision) || cell.revision < 0) {
      throw new RecoveryError("recovery_invalid", "Recovery snapshot has invalid cell identities");
    }
    ids.add(cell.id);
  }
  if (input.path !== undefined && input.path !== null && typeof input.path !== "string") throw new RecoveryError("recovery_invalid", "Recovery snapshot has an invalid path");
  const observation = input.notebookDiskObservation;
  if (!observation || !["untitled", "absent", "present", "unreadable"].includes(observation.state)) throw new RecoveryError("recovery_invalid", "Recovery snapshot has no disk observation");
  sidecarObservationsSchema.parse(input.sidecarObservations);
  return JSON.parse(JSON.stringify({ ...input, physicalBytes: bytes })) as RecoveryBaseline;
}

/** Working state is in memory. Only periodic snapshots and explicit flushes touch storage. */
export class RecoveryWriter {
  readonly rootDir: string;
  readonly key: string;
  readonly directory: string;
  recoveryId = randomUUID() as string;
  issue: RecoveryError | null = null;
  private baseline: RecoveryBaseline;
  private pending = false;
  private latestFingerprint: string;
  private generation: string | null = null;
  private branches = new Map<string, StoredBranch>();
  private validGenerations: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private change = 0;
  private persisted = 0;
  private timestamp = 0;
  private closed = false;
  private readonly interval: number;

  private constructor(options: RecoveryWriterOptions) {
    this.rootDir = resolve(options.rootDir);
    this.key = options.key;
    this.directory = join(this.rootDir, "recovery-" + hash(JSON.stringify(options.key)));
    this.baseline = normalizeBaseline(options.baseline);
    this.latestFingerprint = fingerprint(this.baseline);
    this.interval = options.snapshotIntervalMs ?? 750;
  }

  static async open(options: RecoveryWriterOptions): Promise<RecoveryWriter> {
    let rootDir = resolve(options.rootDir);
    try {
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      rootDir = await realpath(rootDir);
    } catch { /* restore reports unavailable storage while preserving in-memory operation */ }
    const writer = new RecoveryWriter({ ...options, rootDir });
    await writer.restore();
    return writer;
  }

  get currentBaseline(): RecoveryBaseline { return clone(this.baseline); }
  get currentGeneration(): string | null { return this.generation; }
  get currentBaselinePath(): string | null { return this.generation === null ? null : join(this.directory, this.generation); }

  private async restore(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const identityPath = join(this.directory, "document.id");
      try {
        const id = (await readPrivateFile(identityPath, { maxBytes: 128 })).toString("utf8");
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Recovery identity is invalid");
        this.recoveryId = id;
      } catch (error) {
        if (!missing(error)) this.report(error, "recovery_corrupt", [identityPath]);
        if (missing(error)) {
          // Preserve the directory containing existing native drafts once; the old
          // key is no longer used for encryption or sent to a renderer.
          try {
            const key = await readPrivateFile(join(this.directory, "recovery.key"), { maxBytes: 64 });
            if (key.length === 32) this.recoveryId = createHash("sha256").update(key).digest("base64url");
          } catch { /* new document */ }
          await this.atomicWrite(identityPath, Buffer.from(this.recoveryId));
        }
      }
      const names = (await readdir(this.directory)).filter(name => SNAPSHOT_NAME.test(name)).sort().reverse();
      this.timestamp = Number(names[0]?.split("-")[1] ?? 0);
      let restored = false;
      for (const name of names) {
        const path = join(this.directory, name);
        try {
          const envelope = JSON.parse((await readPrivateFile(path, { maxBytes: MAX_SNAPSHOT_BYTES })).toString("utf8")) as { snapshot: Snapshot; sha256: string };
          if (hash(JSON.stringify(envelope.snapshot)) !== envelope.sha256 || envelope.snapshot?.schemaVersion !== 2
              || typeof envelope.snapshot.pending !== "boolean" || typeof envelope.snapshot.fingerprint !== "string"
              || !Array.isArray(envelope.snapshot.branches)) throw new Error("Recovery snapshot is incomplete");
          const snapshot = envelope.snapshot;
          const baseline = normalizeBaseline(snapshot.baseline);
          const branches = snapshot.branches.map(branch => {
            if (typeof branch.id !== "string" || typeof branch.fingerprint !== "string") throw new Error("Recovery branch is invalid");
            return { ...branch, baseline: normalizeBaseline(branch.baseline) };
          });
          this.validGenerations.push(name);
          if (!restored) {
            // A clean snapshot is a tombstone: the saved notebook remains authoritative.
            if (snapshot.pending) this.baseline = baseline;
            this.pending = snapshot.pending;
            this.latestFingerprint = snapshot.pending ? snapshot.fingerprint : fingerprint(this.baseline);
            this.branches = new Map(branches.map(branch => [branch.id, branch]));
            this.generation = name;
            restored = true;
          }
        } catch (error) {
          this.report(error, "recovery_corrupt", [path]);
        }
      }
    } catch (error) {
      this.report(error, "recovery_write_failed", [this.directory]);
    }
  }

  private report(cause: unknown, code: "recovery_corrupt" | "recovery_write_failed", originals: string[]): void {
    const paths = [...new Set([...(this.issue?.originals ?? []), ...originals])];
    this.issue = new RecoveryError(code,
      code === "recovery_corrupt"
        ? "Some recovery data could not be read and was retained. The latest valid snapshot is available."
        : "Recovery storage is unavailable. Editing and saving still work.", null, paths, cause);
  }

  private changed(): void {
    this.change += 1;
    if (!this.closed && this.timer === undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.interval);
      this.timer.unref();
    }
  }

  private state(): RecoveryState {
    return { schemaVersion: 1, generation: this.generation, baseline: clone(this.baseline), documentRevision: this.baseline.documentRevision,
      status: this.pending ? "recovered" : "empty", pending: this.pending, fingerprint: this.latestFingerprint,
      branches: [...this.branches.values()].map(branch => this.describeBranch(branch)) };
  }

  /** Called only after the controller has checked the source revision. No filesystem work. */
  update(baseline: RecoveryBaseline, sourceFingerprint?: string): void {
    if (this.closed) throw new RecoveryError("recovery_closed", "Recovery writer is closed");
    this.baseline = normalizeBaseline(baseline);
    this.latestFingerprint = sourceFingerprint ?? fingerprint(this.baseline);
    this.pending = true;
    this.changed();
  }

  async load(): Promise<RecoveryState> { return this.state(); }
  async materializedBaseline(): Promise<RecoveryBaseline> { return clone(this.baseline); }

  async checkpoint(input: RecoveryCheckpoint): Promise<RecoveryState> {
    this.baseline = normalizeBaseline({ ...this.baseline, ...input });
    this.latestFingerprint = fingerprint(this.baseline);
    this.changed();
    return this.state();
  }

  private describeBranch(branch: StoredBranch): RecoveryBranch {
    return { id: branch.id, documentRevision: branch.baseline.documentRevision, status: "recovered", fingerprint: branch.fingerprint };
  }

  async forkBranch(input: RecoveryBranchFork = {}): Promise<RecoveryBranch> {
    const baseline = normalizeBaseline(input.baseline ?? this.baseline);
    const branch = { id: input.id ?? randomUUID(), baseline, fingerprint: fingerprint(baseline) };
    this.branches.set(branch.id, branch);
    this.changed();
    return this.describeBranch(branch);
  }
  async listBranches(): Promise<readonly RecoveryBranch[]> { return [...this.branches.values()].map(branch => this.describeBranch(branch)); }
  async materializeBranch(id: string): Promise<RecoveryBaseline> {
    const branch = this.branches.get(id);
    if (!branch) throw new RecoveryError("recovery_invalid", "Recovery branch is no longer available");
    return clone(branch.baseline);
  }
  async dropBranch(id: string, expected: RecoveryBranchDropExpected): Promise<boolean> {
    const branch = this.branches.get(id);
    if (!branch || branch.baseline.documentRevision !== expected.documentRevision || branch.fingerprint !== expected.fingerprint) return false;
    this.branches.delete(id);
    this.changed();
    return true;
  }
  async clearIfMatch(expected: RecoveryBranchDropExpected): Promise<boolean> {
    if (expected.documentRevision !== this.baseline.documentRevision || expected.fingerprint !== this.latestFingerprint) return false;
    this.pending = false;
    this.changed();
    // Saving/discarding writes a clean marker immediately so older drafts are not resurrected.
    void this.flush();
    return true;
  }

  async prepareRebind(target: RecoveryRebindTarget): Promise<PreparedRecoveryRebind> {
    const writer = await RecoveryWriter.open(target);
    const existing = await writer.load();
    if (existing.pending) await writer.forkBranch();
    for (const [id, branch] of this.branches) writer.branches.set(id, clone(branch));
    const destinationId = writer.recoveryId;
    writer.recoveryId = this.recoveryId;
    writer.update(target.baseline);
    let adopted = false;
    let aborted = false;
    return {
      writer, state: writer.state(),
      publish: async () => { await writer.flush(); },
      adopt: () => {
        if (adopted) return;
        if (aborted) throw new RecoveryError("recovery_invalid", "Recovery rebind was aborted");
        adopted = true;
        // Renderer drafts follow Save As. Reopening the source needs a distinct identity.
        if (writer.directory !== this.directory) {
          this.recoveryId = randomUUID() as string;
          this.changed();
          void this.flush();
        }
      },
      abort: async () => {
        if (adopted || aborted) return;
        aborted = true;
        writer.recoveryId = destinationId;
        writer.changed();
        await writer.close();
      },
    };
  }

  private async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = path + "." + randomUUID() + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
    } finally {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** Best effort: callers never depend on recovery storage for ordinary document operations. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const operation = this.writeQueue.then(async () => {
      if (this.change === this.persisted) return;
      const change = this.change;
      const snapshot: Snapshot = { schemaVersion: 2, baseline: clone(this.baseline), pending: this.pending,
        fingerprint: this.latestFingerprint, branches: [...this.branches.values()].map(clone) };
      this.timestamp = Math.max(Date.now(), this.timestamp + 1);
      const generation = `snapshot-${this.timestamp}-${randomUUID()}.json`;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.atomicWrite(join(this.directory, "document.id"), Buffer.from(this.recoveryId));
        const bytes = Buffer.from(JSON.stringify({ snapshot, sha256: hash(JSON.stringify(snapshot)) }));
        if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error("Recovery snapshot is too large");
        await this.atomicWrite(join(this.directory, generation), bytes);
        this.generation = generation;
        this.persisted = change;
        this.validGenerations.unshift(generation);
        // Only delete snapshots that were successfully validated. Damaged material is retained.
        for (const old of this.validGenerations.splice(2)) await rm(join(this.directory, old), { force: true });
        if (this.issue?.code === "recovery_write_failed") this.issue = null;
      } catch (error) {
        this.report(error, "recovery_write_failed", [this.directory]);
      }
    });
    this.writeQueue = operation;
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return this.writeQueue;
    this.closed = true;
    await this.flush();
  }
}
