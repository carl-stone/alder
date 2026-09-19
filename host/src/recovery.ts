import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalBase64ByteLength, MAX_NOTEBOOK_CELLS, MAX_NOTEBOOK_SOURCE_BYTES } from "./protocol.js";
import { readPrivateFile } from "./private-paths.js";

export type RecoveryJsonValue = null | boolean | number | string | RecoveryJsonValue[] | { [key: string]: RecoveryJsonValue };
export interface DiskObservation {
  state: "untitled" | "absent" | "present" | "unreadable";
  digest?: string | null;
  version?: string | null;
  error?: RecoveryJsonValue | null;
  identity?: string | null;
  mode?: number;
}
export interface RecoveryCellState { readonly id: string; readonly revision: number; }
export interface RecoveryBaseline {
  schemaVersion: 1;
  physicalBytes: string | Uint8Array | ArrayBuffer;
  documentRevision: number;
  cells: readonly RecoveryCellState[];
  path?: string | null;
  notebookDiskObservation: DiskObservation;
}
export interface RecoveryState { baseline: RecoveryBaseline; pending: boolean; fingerprint: string | null; }
export interface RecoveryWriterOptions {
  rootDir: string;
  key: string;
  baseline: RecoveryBaseline;
  recoveryId?: string;
  processSupervisorExecutable?: string | null;
}
export type RecoveryErrorCode = "recovery_corrupt" | "recovery_write_failed" | "recovery_invalid" | "recovery_closed";
export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode, message: string, readonly originals: readonly string[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RecoveryError";
  }
}

interface StoredJournal { schemaVersion: 1; baseline: RecoveryBaseline; fingerprint: string; }
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: RecoveryBaseline): string => hash(JSON.stringify(value));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

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
    throw new RecoveryError("recovery_invalid", "Recovery journal has invalid document data");
  }
  const ids = new Set<string>();
  for (const cell of input.cells) {
    if (typeof cell?.id !== "string" || cell.id.length === 0 || ids.has(cell.id)
        || !Number.isSafeInteger(cell.revision) || cell.revision < 0) {
      throw new RecoveryError("recovery_invalid", "Recovery journal has invalid cell identities");
    }
    ids.add(cell.id);
  }
  if (input.path !== undefined && input.path !== null && typeof input.path !== "string") {
    throw new RecoveryError("recovery_invalid", "Recovery journal has an invalid path");
  }
  if (!input.notebookDiskObservation || !["untitled", "absent", "present", "unreadable"].includes(input.notebookDiskObservation.state)) {
    throw new RecoveryError("recovery_invalid", "Recovery journal has no saved baseline");
  }
  return JSON.parse(JSON.stringify({ ...input, physicalBytes: bytes })) as RecoveryBaseline;
}

/** One durable snapshot of accepted source that has not yet reached the notebook file. */
export class RecoveryWriter {
  readonly rootDir: string;
  readonly key: string;
  readonly directory: string;
  readonly journalPath: string;
  recoveryId: string;
  issue: RecoveryError | null = null;
  private baseline: RecoveryBaseline;
  private pending = false;
  private latestFingerprint: string;
  private dirty = false;
  private corruptJournal = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(options: RecoveryWriterOptions) {
    this.rootDir = resolve(options.rootDir);
    this.key = options.key;
    this.directory = join(this.rootDir, "recovery-" + hash(JSON.stringify(options.key)));
    this.journalPath = join(this.directory, "journal.json");
    this.recoveryId = options.recoveryId ?? randomUUID();
    this.baseline = normalizeBaseline(options.baseline);
    this.latestFingerprint = fingerprint(this.baseline);
  }

  static async open(options: RecoveryWriterOptions): Promise<RecoveryWriter> {
    let rootDir = resolve(options.rootDir);
    try {
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      rootDir = await realpath(rootDir);
    } catch { /* the first durable mutation reports the storage failure */ }
    const writer = new RecoveryWriter({ ...options, rootDir });
    await writer.restore();
    return writer;
  }

  static async hasJournal(options: Pick<RecoveryWriterOptions, "rootDir" | "key">): Promise<boolean> {
    const directory = join(resolve(options.rootDir), "recovery-" + hash(JSON.stringify(options.key)));
    try { await access(join(directory, "journal.json")); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }

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
        await this.atomicWrite(identityPath, Buffer.from(this.recoveryId));
      }
      let bytes: Buffer;
      try { bytes = await readFile(this.journalPath); }
      catch (error) { if (missing(error)) return; throw error; }
      if (bytes.length > MAX_JOURNAL_BYTES) throw new Error("Recovery journal is too large");
      const value = JSON.parse(bytes.toString("utf8")) as StoredJournal;
      if (value?.schemaVersion !== 1 || typeof value.fingerprint !== "string") throw new Error("Recovery journal is incomplete");
      const baseline = normalizeBaseline(value.baseline);
      if (fingerprint(baseline) !== value.fingerprint) throw new Error("Recovery journal checksum does not match");
      this.baseline = baseline;
      this.latestFingerprint = value.fingerprint;
      this.pending = true;
    } catch (error) {
      this.corruptJournal = true;
      this.report(error, "recovery_corrupt", [this.journalPath]);
    }
  }

  private report(cause: unknown, code: "recovery_corrupt" | "recovery_write_failed", originals: string[]): void {
    this.issue = new RecoveryError(code,
      code === "recovery_corrupt"
        ? "The recovery journal is damaged and was retained. The saved notebook is still available."
        : "The recovery journal could not be written.",
      [...new Set([...(this.issue?.originals ?? []), ...originals])], cause);
  }

  async load(): Promise<RecoveryState> {
    return { baseline: clone(this.baseline), pending: this.pending, fingerprint: this.pending ? this.latestFingerprint : null };
  }
  async materializedBaseline(): Promise<RecoveryBaseline> { return clone(this.baseline); }

  async adoptRecoveryId(recoveryId: string): Promise<void> {
    if (this.closed) throw new RecoveryError("recovery_closed", "Recovery writer is closed");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(recoveryId)) throw new RecoveryError("recovery_invalid", "Recovery identity is invalid");
    await this.writeQueue;
    if (this.pending || this.corruptJournal) throw Object.assign(new Error("Save As destination has pending recovery data"), { code: "destination_recovery_conflict" });
    await this.atomicWrite(join(this.directory, "document.id"), Buffer.from(recoveryId));
    this.recoveryId = recoveryId;
  }

  update(baseline: RecoveryBaseline): void {
    if (this.closed) throw new RecoveryError("recovery_closed", "Recovery writer is closed");
    this.baseline = normalizeBaseline(baseline);
    this.latestFingerprint = fingerprint(this.baseline);
    this.pending = true;
    this.dirty = true;
  }

  async clearIfMatch(expected: { documentRevision: number; fingerprint: string }): Promise<boolean> {
    if (!this.pending || expected.documentRevision !== this.baseline.documentRevision || expected.fingerprint !== this.latestFingerprint) return false;
    this.pending = false;
    this.dirty = false;
    await this.writeQueue;
    await rm(this.journalPath, { force: true });
    await syncDirectory(this.directory);
    return true;
  }

  async discard(): Promise<void> {
    this.pending = false;
    this.dirty = false;
    await this.writeQueue;
    await rm(this.journalPath, { force: true });
    await syncDirectory(this.directory);
    this.issue = null;
    this.corruptJournal = false;
  }

  private async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = path + "." + randomUUID() + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } finally {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  flush(): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      if (!this.dirty) return;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.atomicWrite(join(this.directory, "document.id"), Buffer.from(this.recoveryId));
        if (this.corruptJournal) {
          await rename(this.journalPath, join(this.directory, "corrupt-" + randomUUID() + ".json")).catch(error => {
            if (!missing(error)) throw error;
          });
          this.corruptJournal = false;
        }
        const journal: StoredJournal = { schemaVersion: 1, baseline: clone(this.baseline), fingerprint: this.latestFingerprint };
        const bytes = Buffer.from(JSON.stringify(journal));
        if (bytes.length > MAX_JOURNAL_BYTES) throw new Error("Recovery journal is too large");
        await this.atomicWrite(this.journalPath, bytes);
        this.dirty = false;
        if (this.issue?.code === "recovery_write_failed") this.issue = null;
      } catch (error) {
        this.report(error, "recovery_write_failed", [this.journalPath]);
        throw this.issue;
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async retire(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
    await rm(this.directory, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.closed) return this.writeQueue;
    await this.flush();
    this.closed = true;
  }
}
