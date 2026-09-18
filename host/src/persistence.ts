import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { MAX_NOTEBOOK_SOURCE_BYTES } from "./protocol.js";
import type { DiskObservation, Layout } from "./protocol.js";
import {
  parseNotebook,
  restoreNotebookCellIdentity,
  reconcileNotebook,
  serializeNotebook,
  type NotebookDocument,
  type SourceNotebook,
} from "./notebook.js";
import { parseYamlMapping, readProjectSettings, serializeProjectSettings } from "./configuration.js";
import type { ProjectSettingsPatch } from "./settings.js";
import { serializeLayout, validateLayout } from "./layout.js";
import { packageMetadataPath, serializePackageDeclarations, validatePackageNames } from "./packages.js";

export type { DiskObservation } from "./protocol.js";

const MAX_NOTEBOOK_BYTES = MAX_NOTEBOOK_SOURCE_BYTES;
const MAX_SIDECAR_BYTES = 1 * 1024 * 1024;

type ByteLike = Uint8Array;

export interface DiskVersion {
  readonly bytes: Uint8Array;
  readonly identity: string | null;
  readonly mode: number;
  readonly digest: string;
  /** Metadata used to avoid re-reading unchanged files during watcher refresh. */
  readonly size?: bigint;
  readonly mtimeNs?: bigint;
}
export class FileConflict extends Error {
  readonly code = "source_conflict";
  readonly kind: "source" | "sidecar";

  constructor(message = "Notebook changed on disk; reload before saving", kind: "source" | "sidecar" = "source") {
    super(message);
    this.name = "FileConflict";
    this.kind = kind;
  }
}

export interface PublishedSaveAsResult {
  readonly path: string;
  readonly changed: true;
  readonly digest: string;
}

export interface PublishedSaveAs {
  readonly store: DocumentStore;
  readonly result: PublishedSaveAsResult;
  adopt(): void;
  abort(): Promise<void>;
}

export interface PreparedSaveAs {
  readonly destination: string;
  readonly digest: string;
  publish(): Promise<PublishedSaveAs>;
  adopt(): void;
  abort(): Promise<void>;
}

export interface ReloadPrecondition {
  readonly expectedDiskDigest: string;
  readonly expectedDiskVersion: string;
}

export interface PreparedReload {
  readonly notebook: NotebookDocument;
  readonly observation: DiskObservation;
  adopt(): void;
  abort(): void;
}

export interface SidecarPublication<T> {
  readonly value: T;
  readonly observation: DiskObservation;
}

export interface PreparedSidecar<T> {
  readonly value: T;
  publish(): Promise<SidecarPublication<T>>;
  abort(): Promise<void>;
}
export class PersistenceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.details = details;
  }
}

async function diskVersion(path: string, previous?: DiskVersion): Promise<DiskVersion> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const bytes = new Uint8Array();
      return { bytes, identity: null, mode: 0o600, digest: sha256(bytes), size: 0n, mtimeNs: 0n };
    }
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new PersistenceError("source_invalid", "Notebook path must be a regular file");
    if (info.size > BigInt(MAX_NOTEBOOK_BYTES)) {
      throw new PersistenceError("source_too_large", "Notebook exceeds 32 MiB source limit");
    }
    const currentIdentity = String(info.dev) + ":" + String(info.ino);
    const currentMode = Number(info.mode & 0o777n);
    if (previous !== undefined && previous.identity === currentIdentity && previous.mode === currentMode
      && previous.size === info.size && previous.mtimeNs === info.mtimeNs) {
      return cloneDiskVersion(previous);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (length <= MAX_NOTEBOOK_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, MAX_NOTEBOOK_BYTES + 1 - length));
      const read = await file.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, read.bytesRead));
      length += read.bytesRead;
    }
    if (length > MAX_NOTEBOOK_BYTES) throw new PersistenceError("source_too_large", "Notebook exceeds 32 MiB source limit");
    const bytes = concatBytes(chunks, length);
    return {
      bytes,
      identity: `${info.dev}:${info.ino}`,
      mode: Number(info.mode & 0o777n),
      digest: sha256(bytes),
      size: info.size,
      mtimeNs: info.mtimeNs,
    };
  } finally {
    await file.close();
  }
}

function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sha256(bytes: ByteLike): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameDisk(left: DiskVersion, right: DiskVersion): boolean {
  return left.identity === right.identity && left.mode === right.mode && sameBytes(left.bytes, right.bytes);
}

async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

async function resolveNotebookPath(path: string): Promise<{ spelling: string; canonical: string }> {
  const spelling = resolve(path);
  try {
    return { spelling, canonical: await realpath(spelling) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { spelling, canonical: join(await realpath(dirname(spelling)), basename(spelling)) };
  }
}

function cloneNotebook(document: NotebookDocument): NotebookDocument {
  return structuredClone(document);
}

function isNotebookDocument(value: SourceNotebook | NotebookDocument): value is NotebookDocument {
  return "text" in value || "header" in value || "headerRecords" in value
    || "preferredEol" in value || "finalNewline" in value || "nextCellNumber" in value || "bom" in value
    || value.cells.some((cell) => "records" in cell || "raw" in cell || "delim" in cell || "optionDuplicates" in cell);
}

function emptyDiskObservation(): DiskObservation {
  return { state: "absent", digest: null, version: null, error: null };
}

function diskVersionToken(version: DiskVersion): string {
  return (version.identity ?? "absent") + ":" + version.mode.toString(8) + ":" + version.digest;
}

function diskObservation(version: DiskVersion): DiskObservation {
  return {
    state: version.identity === null ? "absent" : "present",
    digest: version.identity === null ? null : version.digest,
    version: version.identity === null ? null : diskVersionToken(version),
    error: null,
  };
}

function emptyDiskVersion(): DiskVersion {
  const bytes = new Uint8Array();
  return { bytes, identity: null, mode: 0o600, digest: sha256(bytes), size: 0n, mtimeNs: 0n };
}

function cloneDiskVersion(version: DiskVersion): DiskVersion {
  return { ...version, bytes: new Uint8Array(version.bytes) };
}

function sidecarVersion(version: DiskVersion): string | null {
  return version.identity === null ? null : diskVersionToken(version);
}

function validateExpectedSidecarVersion(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0"))) {
    throw new PersistenceError("invalid_precondition", "sidecar version precondition is invalid");
  }
}

function packageDeclarationsFromVersion(version: DiskVersion): string[] {
  if (version.identity === null) return [];
  let mapping: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(version.bytes);
    mapping = parseYamlMapping(text, "packages");
  } catch (error) {
    throw new PersistenceError("package_metadata_error", "could not read package metadata: " + String(error));
  }
  const keys = Object.keys(mapping);
  if (keys.length !== 1 || keys[0] !== "packages" || !Array.isArray(mapping.packages)
    || mapping.packages.some((value) => typeof value !== "string")) {
    throw new PersistenceError("package_metadata_error", "package metadata must contain only a packages sequence");
  }
  try {
    return validatePackageNames(mapping.packages as string[]);
  } catch (error) {
    throw new PersistenceError("package_metadata_error", String(error));
  }
}
export class DocumentStore {
  /** Last source version adopted by this store and used as the save baseline. */
  private version!: DiskVersion;
  /** Latest physical source observation; external refreshes never move the save baseline. */
  private observedVersion!: DiskVersion;
  private readonly sidecars = new Map<string, DiskVersion>();
  private readonly sidecarTargets = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private documentValue!: NotebookDocument;

  private constructor(readonly path: string, private readonly spelling: string) {}

  static async open(path: string): Promise<{ store: DocumentStore; notebook: NotebookDocument }> {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new PersistenceError("invalid_path", "notebook path must be a non-empty path");
    const resolved = await resolveNotebookPath(path);
    const store = new DocumentStore(resolved.canonical, resolved.spelling);
    store.version = await diskVersion(resolved.canonical);
    store.observedVersion = cloneDiskVersion(store.version);
    await store.loadSidecars();
    store.documentValue = parseNotebook(store.version.bytes, store.path);
    return { store, notebook: cloneNotebook(store.documentValue) };
  }

  private async loadSidecars(): Promise<void> {
    for (const kind of ["config", "layout", "packages"] as const) {
      const file = this.sidecarPath(kind);
      this.sidecars.set(file, await diskVersion(file));
      this.sidecarTargets.set(file, await canonicalDestination(file));
    }
  }

  get sourceVersion(): DiskVersion {
    return { ...this.version, bytes: new Uint8Array(this.version.bytes) };
  }

  get currentDocument(): NotebookDocument {
    return cloneNotebook(this.documentValue);
  }

  observation(): DiskObservation {
    return diskObservation(this.observedVersion);
  }

  /** Refresh physical observations in the same serialized lane as commits. */
  async refreshObservations(): Promise<{
    source: DiskObservation;
    sidecars: { config: DiskObservation; layout: DiskObservation; packages: DiskObservation };
  }> {
    const next = this.queue.then(async () => {
      this.observedVersion = await diskVersion(this.path, this.observedVersion);
      for (const kind of ["config", "layout", "packages"] as const) {
        const path = this.sidecarPath(kind);
        this.sidecars.set(path, await diskVersion(path, this.sidecars.get(path)));
        this.sidecarTargets.set(path, await canonicalDestination(path));
      }
      return {
        source: diskObservation(this.observedVersion),
        sidecars: {
          config: this.sidecarObservation("config"),
          layout: this.sidecarObservation("layout"),
          packages: this.sidecarObservation("packages"),
        },
      };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  sidecarPath(kind: "config" | "layout" | "packages"): string {
    return kind === "config"
      ? join(dirname(this.path), ".alder", "config.yaml")
      : kind === "layout" ? `${this.path}.alder-layout.json`
      : packageMetadataPath(dirname(this.path));
  }

  sidecarObservation(kind: "config" | "layout" | "packages"): DiskObservation {
    const current = this.sidecars.get(this.sidecarPath(kind));
    if (current === undefined || current.identity === null) return emptyDiskObservation();
    return {
      state: "present",
      digest: current.digest,
      version: this.versionToken(current),
      error: null,
    };
  }

  /** Adopt a fresh source observation without changing the save-conflict baseline. */
  async adoptSourceObservation(source: DocumentStore): Promise<void> {
    if (source === this) return;
    if (!(source instanceof DocumentStore) || source.path !== this.path) {
      throw new PersistenceError("invalid_precondition", "source observation belongs to another notebook");
    }
    const next = this.queue.then(() => {
      this.observedVersion = cloneDiskVersion(source.observedVersion);
    });
    this.queue = next.catch(() => undefined);
    await next;
  }

  /** Adopt observations from another store opened on the same canonical notebook. */
  adoptSidecarObservations(source: DocumentStore): void {
    if (source === this) return;
    if (!(source instanceof DocumentStore) || source.path !== this.path) {
      throw new PersistenceError("invalid_precondition", "sidecar observations belong to another notebook");
    }
    for (const kind of ["config", "layout", "packages"] as const) {
      const path = this.sidecarPath(kind);
      const observed = source.sidecars.get(path);
      const target = source.sidecarTargets.get(path);
      if (observed === undefined || target === undefined) {
        throw new PersistenceError("invalid_precondition", "sidecar observations are incomplete");
      }
      this.sidecars.set(path, cloneDiskVersion(observed));
      this.sidecarTargets.set(path, target);
    }
  }

  private versionToken(version: DiskVersion): string {
    return diskVersionToken(version);
  }

  matchesSource(value: string | Uint8Array): boolean {
    const bytes = typeof value === "string" ? decodeBase64(value) : value;
    return bytes !== null && sameBytes(this.version.bytes, bytes);
  }

  async document(snapshot: SourceNotebook | NotebookDocument): Promise<NotebookDocument> {
    return cloneNotebook(this.candidate(snapshot));
  }

  private candidate(snapshot: SourceNotebook | NotebookDocument): NotebookDocument {
    let candidate: NotebookDocument;
    if (isNotebookDocument(snapshot)) {
      const copy = cloneNotebook(snapshot);
      // A full document carries the physical record ledger. Reconcile its
      // semantic projection against that same copy so body/option edits update
      // records without falling back to the store's potentially stale disk
      // document.
      const source: SourceNotebook = {
        cells: copy.cells.map((cell) => ({
          id: cell.id,
          type: cell.type ?? "code",
          body: [...cell.body],
          ...(cell.options === undefined ? {} : { options: { ...cell.options } }),
          ...(cell.revision === undefined ? {} : { revision: cell.revision }),
        })),
        ...(copy.metadata === undefined ? {} : { metadata: { ...copy.metadata } }),
      };
      candidate = reconcileNotebook(copy, source);
    } else {
      candidate = reconcileNotebook(this.documentValue, snapshot);
    }
    // A normal save is always for this store's canonical target. Save As is
    // explicit and never smuggled through a snapshot path field.
    return { ...candidate, path: this.path };
  }

  save(snapshot: SourceNotebook | NotebookDocument): Promise<{ path: string; changed: boolean; digest: string }> {
    const fixed = structuredClone(snapshot);
    const next = this.queue.then(async () => this.commit(this.candidate(fixed)));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async assertUnchanged(): Promise<void> {
    let canonical: string;
    try {
      canonical = await realpath(this.spelling);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = join(await realpath(dirname(this.spelling)), basename(this.spelling));
    }
    const current = await diskVersion(this.path);
    if (canonical !== this.path || !sameDisk(this.version, current)) throw new FileConflict();
  }

  private async commit(candidate: NotebookDocument): Promise<{ path: string; changed: boolean; digest: string }> {
    await this.assertUnchanged();
    const bytes = serializeNotebook(candidate);
    if (this.version.identity !== null && sameBytes(bytes, this.version.bytes)) {
      this.documentValue = cloneNotebook(candidate);
      return { path: this.path, changed: false, digest: this.version.digest };
    }
    const stage = join(dirname(this.path), `.alder-save-${randomUUID()}`);
    try {
      await writeStaged(stage, bytes, this.version.mode);
      await this.assertUnchanged();
      const committed = await publishStaged(stage, this.path, this.version, "Notebook changed while saving");
      this.version = committed;
      this.observedVersion = cloneDiskVersion(committed);
      this.documentValue = cloneNotebook(candidate);
      return { path: this.path, changed: true, digest: committed.digest };
    } finally {
      await unlink(stage).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  /** Replacement is permitted only for the exact destination the user confirmed. */
  prepareSaveAs(
    path: string,
    snapshot: SourceNotebook | NotebookDocument,
    replacement?: ReloadPrecondition,
  ): Promise<PreparedSaveAs> {
    const fixed = structuredClone(snapshot);
    const next = this.queue.then(async () => {
      if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
        throw new PersistenceError("invalid_path", "destination path must be a non-empty path");
      }
      const { spelling, canonical: destination } = await resolveNotebookPath(path);
      const expected = await diskVersion(destination);
      if (replacement === undefined) {
        if (expected.identity !== null) {
          throw new PersistenceError("destination_exists", "Confirm replacement of the existing Save As destination", { path: spelling });
        }
      } else {
        validateDiskPrecondition(replacement);
        if (expected.identity === null || expected.digest !== replacement.expectedDiskDigest
          || diskVersionToken(expected) !== replacement.expectedDiskVersion) {
          throw new FileConflict("Save As destination changed since replacement was confirmed");
        }
      }
      const assertUnchanged = async () => {
        const resolved = await resolveNotebookPath(spelling);
        if (resolved.canonical !== destination || !sameDisk(expected, await diskVersion(destination))) {
          throw new FileConflict("Save As destination changed while saving");
        }
      };
      const candidate = { ...this.candidate(fixed), path: destination };
      const bytes = serializeNotebook(candidate);
      let stage: string | null = join(dirname(destination), ".alder-save-as-" + randomUUID());
      const removeStage = async () => {
        if (stage === null) return;
        const current = stage;
        await unlink(current).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        stage = null;
      };
      // Prepare the destination binder before committing the file, so sidecar
      // read failures cannot turn a successful disk save into a failed adoption.
      const destinationStore = new DocumentStore(destination, spelling);
      try {
        await destinationStore.loadSidecars();
        await writeStaged(stage, bytes, expected.mode);
        await assertUnchanged();
      } catch (error) {
        await removeStage();
        throw error;
      }
      const digest = sha256(bytes);
      let aborted = false;
      let publication: Promise<PublishedSaveAs> | null = null;
      let published = false;
      const result: PublishedSaveAs = {
        store: destinationStore,
        result: { path: destination, changed: true, digest },
        adopt: () => {
          if (!published) throw new PersistenceError("publication_invalid", "Save As must publish before adoption");
        },
        abort: async () => {
          // A completed save survives later session or recovery failures.
          await removeStage();
        },
      };
      return {
        destination,
        digest,
        publish: () => {
          if (aborted) return Promise.reject(new PersistenceError("publication_invalid", "Save As preparation has been aborted"));
          if (publication !== null) return publication;
          publication = (async () => {
            try {
              await assertUnchanged();
              const committed = await publishStaged(stage!, destination, expected, "Save As destination changed while saving");
              stage = null;
              destinationStore.version = committed;
              destinationStore.observedVersion = cloneDiskVersion(committed);
              destinationStore.documentValue = cloneNotebook(candidate);
              published = true;
              return result;
            } finally {
              await removeStage();
            }
          })();
          return publication;
        },
        adopt: result.adopt,
        abort: async () => {
          if (publication !== null) await publication.catch(() => undefined);
          aborted = true;
          await removeStage();
        },
      };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  /** Prepare a read-only reload candidate; adoption is a synchronous binder mutation. */
  prepareReload(precondition: ReloadPrecondition, previousDocument: NotebookDocument): Promise<PreparedReload> {
    const next = this.queue.then(async () => {
      validateDiskPrecondition(precondition);
      if (previousDocument === null || typeof previousDocument !== "object" || !Array.isArray(previousDocument.cells)) {
        throw new PersistenceError("invalid_precondition", "reload previous document is invalid");
      }
      const expectedStoreVersion = this.versionToken(this.version);
      const current = await diskVersion(this.path);
      let canonical: string;
      try { canonical = await realpath(this.spelling); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        canonical = join(await realpath(dirname(this.spelling)), basename(this.spelling));
      }
      if (canonical !== this.path || current.digest !== precondition.expectedDiskDigest
        || this.versionToken(current) !== precondition.expectedDiskVersion) throw new FileConflict();
      const parsed = parseNotebook(current.bytes, this.path);
      const priorIds = new Set<string>();
      for (const cell of previousDocument.cells) {
        if (cell === null || typeof cell !== "object" || typeof cell.id !== "string") throw new PersistenceError("invalid_precondition", "reload previous document is invalid");
        priorIds.add(cell.id);
      }
      const transientIds = new Set<string>();
      const transientId = (): string => {
        let id: string;
        do id = "reload-" + randomUUID(); while (priorIds.has(id) || transientIds.has(id));
        transientIds.add(id);
        return id;
      };
      const source: SourceNotebook = {
        path: this.path,
        ...(parsed.metadata === undefined ? {} : { metadata: { ...parsed.metadata } }),
        cells: parsed.cells.map((cell) => ({
          id: transientId(),
          type: cell.type ?? "code",
          body: [...cell.body],
          ...(cell.options === undefined ? {} : { options: { ...cell.options } }),
        })),
      };
      const identities = reconcileNotebook(previousDocument, source).cells.map((cell) => ({
        id: cell.id,
        revision: cell.revision ?? 0,
      }));
      const reconciled = restoreNotebookCellIdentity(parsed, identities);
      const candidate = cloneNotebook(reconciled);
      let adopted = false;
      let aborted = false;
      const prepared: PreparedReload = {
        notebook: cloneNotebook(candidate),
        observation: diskObservation(current),
        adopt: () => {
          if (adopted || aborted) return;
          if (this.versionToken(this.version) !== expectedStoreVersion) throw new FileConflict("Notebook changed before reload adoption");
          this.version = current;
          this.observedVersion = cloneDiskVersion(current);
          this.documentValue = cloneNotebook(candidate);
          adopted = true;
        },
        abort: () => {
          aborted = true;
        },
      };
      return prepared;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  async prepareConfig(
    patch: ProjectSettingsPatch,
    expectedVersion: string | null,
  ): Promise<PreparedSidecar<ProjectSettingsPatch>> {
    return this.prepareSidecar("config", expectedVersion, async () => {
      const path = this.sidecarPath("config");
      const current = await readProjectSettings(path);
      const next: ProjectSettingsPatch = { cache: { ...current.cache, ...patch.cache } };
      return { value: next, bytes: new TextEncoder().encode(serializeProjectSettings(next)) };
    });
  }

  async prepareLayout(
    layout: Layout,
    expectedVersion: string | null,
  ): Promise<PreparedSidecar<Layout>> {
    return this.prepareSidecar("layout", expectedVersion, async () => {
      const value = validateLayout(layout);
      return { value, bytes: new TextEncoder().encode(serializeLayout(value)) };
    });
  }

  async preparePackages(
    additions: readonly string[],
    expectedVersion: string | null,
  ): Promise<PreparedSidecar<readonly string[]>> {
    return this.prepareSidecar("packages", expectedVersion, async (expected) => {
      const requested = validatePackageNames(additions, false);
      const current = packageDeclarationsFromVersion(expected);
      const value = validatePackageNames([...current, ...requested]);
      return { value, bytes: new TextEncoder().encode(serializePackageDeclarations(value)) };
    });
  }

  private prepareSidecar<T>(
    kind: "config" | "layout" | "packages",
    expectedVersion: string | null,
    prepare: (expected: DiskVersion) => Promise<{ value: T; bytes: Uint8Array }>,
  ): Promise<PreparedSidecar<T>> {
    const path = this.sidecarPath(kind);
    const next = this.queue.then(async () => {
      validateExpectedSidecarVersion(expectedVersion);
      const cached = this.sidecars.get(path) ?? emptyDiskVersion();
      const expected = cloneDiskVersion(cached);
      const target = this.sidecarTargets.get(path) ?? await canonicalDestination(path);
      const assertUnchanged = async (): Promise<void> => {
        if (await canonicalDestination(path) !== target || !sameDisk(expected, await diskVersion(target))) {
          throw new FileConflict("Notebook sidecar changed on disk", "sidecar");
        }
      };
      if (sidecarVersion(expected) !== expectedVersion) {
        throw new FileConflict("Notebook sidecar changed while the operation was waiting", "sidecar");
      }
      await assertUnchanged();
      const candidate = await prepare(expected);
      const value = structuredClone(candidate.value);
      const bytes = new Uint8Array(candidate.bytes);
      if (bytes.byteLength > MAX_SIDECAR_BYTES || bytes.includes(0)) {
        throw new PersistenceError("invalid_request", "sidecar exceeds its bounded text limit");
      }
      await assertUnchanged();
      const parent = dirname(target);
      let stage: string | null = null;
      if (!sameBytes(bytes, expected.bytes)) {
        await mkdir(parent, { recursive: true, mode: 0o700 });
        stage = join(parent, ".alder-sidecar-" + randomUUID());
        try {
          await writeStaged(stage, bytes, expected.mode);
          await assertUnchanged();
        } catch (error) {
          await unlink(stage).catch(() => undefined);
          stage = null;
          throw error;
        }
      }
      let publication: SidecarPublication<T> | null = null;
      let committed: DiskVersion = expected;
      let aborted = false;
      let abortPromise: Promise<void> | null = null;
      const removeStage = async (): Promise<void> => {
        if (stage === null) return;
        const current = stage;
        await unlink(current).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        stage = null;
      };
      const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
        const queued = this.queue.then(operation);
        this.queue = queued.catch(() => undefined);
        return queued;
      };
      const publish = (): Promise<SidecarPublication<T>> => enqueue(async () => {
        if (aborted) throw new PersistenceError("publication_invalid", "sidecar preparation has been aborted");
        if (publication !== null) return publication;
        await assertUnchanged();
        if (stage !== null) {
          try {
            committed = await publishStaged(stage, target, expected, "Notebook sidecar changed on disk", "sidecar");
            stage = null;
          } catch (error) {
            await removeStage();
            throw error;
          }
        } else {
          committed = expected;
        }
        this.sidecars.set(path, committed);
        this.sidecarTargets.set(path, await canonicalDestination(path));
        publication = { value: structuredClone(value), observation: diskObservation(committed) };
        return publication;
      });
      const abort = (): Promise<void> => {
        if (abortPromise !== null) return abortPromise;
        abortPromise = enqueue(async () => {
          if (aborted || publication !== null) return;
          await removeStage();
          aborted = true;
        });
        return abortPromise;
      };
      return { value, publish, abort };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}

/** The old path stays readable until the single atomic rename commits. */
async function publishStaged(
  stage: string,
  target: string,
  expected: DiskVersion,
  conflictMessage: string,
  kind: "source" | "sidecar" = "source",
): Promise<DiskVersion> {
  const committed = await diskVersion(stage);
  if (!sameDisk(expected, await diskVersion(target))) throw new FileConflict(conflictMessage, kind);
  await rename(stage, target);
  await syncDirectory(dirname(target));
  return committed;
}

function validateDiskPrecondition(precondition: ReloadPrecondition): void {
  if (precondition === null || typeof precondition !== "object" || Array.isArray(precondition)
    || Object.keys(precondition).sort().join(",") !== "expectedDiskDigest,expectedDiskVersion"
    || typeof precondition.expectedDiskDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(precondition.expectedDiskDigest)
    || typeof precondition.expectedDiskVersion !== "string" || precondition.expectedDiskVersion.length === 0
    || precondition.expectedDiskVersion.length > 512 || precondition.expectedDiskVersion.includes("\0")) {
    throw new PersistenceError("invalid_precondition", "disk preconditions are invalid");
  }
}

/** Observe a Save As target before presenting an explicit replacement confirmation. */
export async function observeSaveAsDestination(path: string): Promise<DiskObservation> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new PersistenceError("invalid_path", "destination path must be a non-empty path");
  }
  return diskObservation(await diskVersion((await resolveNotebookPath(path)).canonical));
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function writeStaged(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const file = await open(path, "wx", mode);
  try {
    await file.chmod(mode);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || bytes.byteLength > MAX_NOTEBOOK_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

export async function sameFile(first: string, second: string): Promise<boolean> {
  if (resolve(first) === resolve(second)) return true;
  try {
    const [left, right] = await Promise.all([stat(first, { bigint: true }), stat(second, { bigint: true })]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export { diskVersion, sameDisk, canonicalDestination };
