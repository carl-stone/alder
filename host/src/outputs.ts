import { randomUUID } from "node:crypto";
import { constants, unlinkSync, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { renderMarkdown, sanitizeHtmlFragment } from "./markdown.js";
import {
  MAX_ARTIFACT_HANDLE_BYTES,
  artifactHandleSchema,
  artifactResourceNameSchema,
  sameArtifactHandle,
  outputRecordSchema,
  protocolJsonSchema,
  richOutputPayloadSchema,
  htmlMimeCompatible,
  mediaMimeCompatible,
  type ArtifactHandle,
  type JsonValue,
  type OutputRecord,
  type OutputScope,
  type RichOutputPayload,
} from "./protocol.js";

/** The maximum artifact range returned by one publisher/browser request. */
export const OUTPUT_ARTIFACT_CHUNK_BYTES = 262_144;
/** The total logical bytes retained by one store. */
export const OUTPUT_ARTIFACT_QUOTA_BYTES = 512 * 1024 * 1024;
/** Output records share the ordinary host event envelope limit. */
export const OUTPUT_RECORD_MAX_BYTES = 8 * 1024 * 1024;
/** Inline previews never exceed this UTF-8 byte count. */
export const OUTPUT_PREVIEW_MAX_BYTES = 262_144;

const MAX_RECORDS_PER_CELL = 4_096;
const MAX_COLLECTION_DEPTH = 64;
const MAX_MIME_BYTES = 256;
const MAX_ARTIFACT_EXTENSION_BYTES = 12;
const SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;

type OutputPresentation = "inline" | "sandbox";

export type OutputIdentity = {
  sessionEpoch: string;
  documentRevision: number;
  kernelEpoch: string | null;
  runId: string | null;
  cellId: string;
  revision: number;
};
/** A runtime-free output scope for immutable recovery/source artifacts. */
export type StaticOutputScope = {
  sessionEpoch: string;
  documentRevision: number;
  kernelEpoch: null;
  runId: null;
  cellId: null;
  revision: null;
};

export type OutputStoreOptions = {
  /** Private directory owned by this host for retained artifact bytes. */
  artifactDirectory: string;
  /** Session incarnation used in descriptors and output identity checks. */
  sessionEpoch: string;
  documentRevision?: number;
  kernelEpoch?: string | null;
  maxArtifactBytes?: number;
  /** Optional R staging directory. It is never exposed to consumers. */
  artifactSourceDirectory?: string;
};

export type OutputStoreSnapshot = {
  records: readonly OutputRecord[];
  artifacts: readonly ArtifactHandle[];
};

/** In-process declared resource map; descriptors and wire metadata never contain capabilities or paths. */
export interface ArtifactManifest {
  readonly entry: string;
  readonly resources: Readonly<Record<string, ArtifactHandle>>;
}

export interface ArtifactResourceRead {
  readonly descriptor: ArtifactHandle;
  read(offset: number, limit: number): Promise<Uint8Array>;
  close(): void;
}

export type ArtifactImportOptions = {
  mimeType?: string;
  extension?: string;
};

export class OutputStoreError extends Error {
  constructor(
    readonly code: "not_found" | "stale_value" | "output_expired" | "output_quota" | "output_invalid",
    message: string,
  ) {
    super(message);
    this.name = "OutputStoreError";
  }
}

type ArtifactOwner = OutputScope;

type StoredArtifact = {
  descriptor: ArtifactHandle;
  readonly manifest: ArtifactManifest;
  /** null owns a dedicated static value until release; zero grants no public read. */
  readableUntil: number | null;
  path: string;
  bytes: number;
  pins: number;
  /** Number of retained visible records that reference this artifact. */
  recordReferences: number;
  /** Number of live request results that retain this artifact. */
  requestReferences: number;
  retired: boolean;
  staticValue: boolean;
  /** Dedicated recovery artifacts survive active document/kernel invalidation. */
  survivesIdentityChanges: boolean;
  /** A newly written artifact is protected until attached to a record or released. */
  protected: boolean;
  owner: ArtifactOwner;
  lastAccess: number;
};

type StoredRecord = OutputRecord;
type StoredRecordMetadata = {
  readonly handles: readonly string[];
  readonly documentRevision: number;
};

type PreparedRecord = {
  record: OutputRecord;
  handles: readonly ArtifactHandle[];
  ownerKey: string;
  documentRevision: number;
};
type OutputInvalidationPredicate = {
  cellId?: string;
  revision?: number;
  kernelEpoch?: string | null;
  documentRevision?: number;
};

type PrepareRecordOptions = {
  skipCurrentSequence?: boolean;
  documentRevision?: number;
  replaceExpected?: StoredRecord;
};

/**
 * The sole host owner of canonical output records and opaque artifact bytes.
 *
 * The store deliberately keeps records and descriptors as the exact frozen
 * objects it returns. Browser, MCP, notifications, and publication all consume
 * those same references; only mutable lifetime/quota bookkeeping is private.
 */
export class OutputStore {
  private readonly recordsByCell = new Map<string, StoredRecord[]>();
  private readonly recordsById = new Map<string, StoredRecord>();
  private readonly recordMetadata = new WeakMap<StoredRecord, StoredRecordMetadata>();
  private readonly ownedRecords = new WeakSet<object>();
  private readonly artifactsByHandle = new Map<string, StoredArtifact>();
  private readonly nextSequenceByOwner = new Map<string, number>();
  private readonly requestArtifactsByOwner = new Map<string, {
    identity: OutputScope;
    handles: readonly string[];
  }>();
  private readonly artifactDirectory: string;
  private readonly artifactSourceDirectory: string;
  private readonly sessionEpoch: string;
  private readonly maxArtifactBytes: number;
  private documentRevision: number;
  private kernelEpoch: string | null;
  private retainedArtifactBytes = 0;
  private reservedArtifactBytes = 0;
  private accessCounter = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: OutputStoreOptions) {
    if (!options || typeof options.artifactDirectory !== "string" || options.artifactDirectory.length === 0) {
      throw new TypeError("artifactDirectory must be a non-empty path");
    }
    if (!safeId(options.sessionEpoch)) throw new TypeError("sessionEpoch must be a bounded identifier");
    const quota = options.maxArtifactBytes ?? OUTPUT_ARTIFACT_QUOTA_BYTES;
    if (!Number.isSafeInteger(quota) || quota <= 0 || quota > OUTPUT_ARTIFACT_QUOTA_BYTES) {
      throw new RangeError("maxArtifactBytes must be a positive safe integer <= 512 MiB");
    }
    const documentRevision = options.documentRevision ?? 0;
    if (!isRevision(documentRevision)) throw new TypeError("documentRevision must be a non-negative safe integer");
    if (options.kernelEpoch !== undefined && options.kernelEpoch !== null && !safeId(options.kernelEpoch)) {
      throw new TypeError("kernelEpoch must be null or a bounded identifier");
    }
    this.artifactDirectory = resolve(options.artifactDirectory);
    this.artifactSourceDirectory = resolve(options.artifactSourceDirectory ?? options.artifactDirectory);
    this.sessionEpoch = options.sessionEpoch;
    this.documentRevision = documentRevision;
    this.kernelEpoch = options.kernelEpoch ?? null;
    this.maxArtifactBytes = quota;
  }

  setIdentity(identity: { documentRevision: number; kernelEpoch: string | null }): void {
    this.assertOpen();
    if (!identity || !isRevision(identity.documentRevision) ||
        (identity.kernelEpoch !== null && !safeId(identity.kernelEpoch))) {
      throw new TypeError("invalid output store identity");
    }
    const nextDocumentRevision = Math.max(this.documentRevision, identity.documentRevision);
    const oldKernelEpoch = this.kernelEpoch;
    const oldDocumentRevision = this.documentRevision;
    if (oldKernelEpoch !== identity.kernelEpoch && oldKernelEpoch !== null) {
      this.invalidateRequests({ kernelEpoch: oldKernelEpoch });
    }
    if (oldDocumentRevision !== nextDocumentRevision) {
      this.invalidateRequests({ documentRevision: oldDocumentRevision });
    }
    this.documentRevision = nextDocumentRevision;
    this.kernelEpoch = identity.kernelEpoch;
  }

  /** True for the exact canonical object created by this store, including after retirement. */
  ownsRecordReference(value: unknown): value is OutputRecord {
    return typeof value === "object" && value !== null && this.ownedRecords.has(value);
  }
  /** Normalize one public Jupyter display-data map. */

  async ingestDisplay(
    data: Record<string, JsonValue>,
    metadata: Record<string, JsonValue>,
    identity: Omit<OutputIdentity, "sessionEpoch" | "documentRevision" | "kernelEpoch"> & {
      sessionEpoch?: string;
      documentRevision?: number;
      kernelEpoch?: string | null;
    },
  ): Promise<OutputRecord[]> {
    this.assertOpen();
    const checkedData = strictJsonInput(data, "display data must be strict JSON");
    const checkedMetadata = strictJsonInput(metadata, "display metadata must be strict JSON");
    if (!isPlainRecord(checkedData) || !isPlainRecord(checkedMetadata)) {
      throw new OutputStoreError("output_invalid", "display data and metadata must be plain objects");
    }
    data = checkedData as Record<string, JsonValue>;
    metadata = checkedMetadata as Record<string, JsonValue>;

    const full = this.completeIdentity(identity);
    this.assertIdentity(full, true);
    const rich = data["application/vnd.alder.output+json"];
    if (rich !== undefined) {
      const record = await Promise.resolve(this.ingestAlder(rich, full, metadata));
      return [record];
    }

    const markdown = data["text/markdown"];
    if (typeof markdown === "string") {
      this.assertMIMEInput(markdown);
      const rendered = renderMarkdown(markdown);
      return [this.record(full, {
        kind: "markdown",
        html: boundedText(sanitizeHtmlFragment(rendered.html), OUTPUT_RECORD_MAX_BYTES),
        text: boundedText(markdown, OUTPUT_RECORD_MAX_BYTES),
      }, this.metadata(metadata, "inline", rendered.diagnostics.length === 0 ? undefined : {
        diagnostics: rendered.diagnostics,
      }))];
    }

    const html = data["text/html"];
    if (typeof html === "string") {
      this.assertMIMEInput(html);
      try {
        const artifact = await this.writeArtifact(Buffer.from(html, "utf8"), "text/html", ".html", full);
        try {
          return [this.record(full, { kind: "html", artifact, alt_text: "" }, this.metadata(metadata, "sandbox"))];
        } catch (error) {
          this.release([artifact]);
          throw error;
        }
      } catch (error) {
        if (this.isOutputQuotaError(error)) return [this.outputQuotaRecord(full, metadata, error)];
        throw error;
      }
    }

    const json = data["application/json"];
    if (json !== undefined) {
      const preview = boundedPreview(json);
      return [this.record(full, {
        mime: "application/json",
        value: cloneJson(json),
        preview,
      }, this.metadata(metadata, "inline"))];
    }

    for (const [mime, extension, mediaKind] of [
      ["image/png", ".png", "image"],
      ["image/jpeg", ".jpg", "image"],
      ["image/svg+xml", ".svg", "image"],
      ["audio/wav", ".wav", "audio"],
      ["video/mp4", ".mp4", "video"],
      ["application/pdf", ".pdf", "pdf"],
    ] as const) {
      const value = data[mime];
      if (typeof value !== "string") continue;
      const bytes = mime === "image/svg+xml"
        ? this.decodeSvg(value)
        : decodeBase64(value);
      try {
        const artifact = await this.writeArtifact(bytes, mime, extension, full);
        try {
          if (mediaKind === "image") {
            return [this.record(full, { kind: "image", artifact, mime }, this.metadata(metadata, "sandbox"))];
          }
          return [this.record(full, {
            kind: "media",
            media_type: mediaKind === "pdf" ? "pdf" : mediaKind,
            artifact,
            mime,
            alt: "",
          }, this.metadata(metadata, "sandbox"))];
        } catch (error) {
          this.release([artifact]);
          throw error;
        }
      } catch (error) {
        if (this.isOutputQuotaError(error)) return [this.outputQuotaRecord(full, metadata, error)];
        throw error;
      }
    }

    const text = data["text/plain"];
    if (typeof text === "string") {
      const bounded = boundedText(text, OUTPUT_RECORD_MAX_BYTES);
      // Presentation is assigned by the host after MIME validation.
      return [this.record(full, {
        kind: "text",
        text: bounded,
        truncated: bounded !== text,
      }, this.metadata(metadata, "inline"))];
    }

    const first = Object.entries(data)[0];
    if (first !== undefined) {
      const value = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]) ?? "";
      const bounded = boundedText(value, OUTPUT_RECORD_MAX_BYTES);
      return [this.record(full, {
        kind: "text",
        text: bounded,
        truncated: bounded !== value,
      }, this.metadata(metadata, "inline"))];
    }
    return [];
  }

  /**
   * Accept an already-canonical rich payload synchronously. Raw R payloads that
   * contain an HTML string or registered artifact basename return a Promise so
   * the caller can await the scoped copy; canonical payloads remain synchronous
   * for existing in-process consumers.
   */
  ingestAlder(
    payload: unknown,
    identity: OutputIdentity,
    metadata: Record<string, JsonValue> = {},
  ): OutputRecord | Promise<OutputRecord> {
    this.assertOpen();
    this.assertIdentity(identity, true);
    const checkedPayload = strictJsonInput(payload, "Alder output must be strict JSON");
    const checkedMetadata = strictJsonInput(metadata, "output metadata must be strict JSON");
    if (!isPlainRecord(checkedMetadata)) throw new OutputStoreError("output_invalid", "output metadata must be a plain object");
    const canonicalMetadata = checkedMetadata as Record<string, JsonValue>;
    if (requiresAsyncRawNormalization(checkedPayload)) return this.ingestAlderAsync(checkedPayload, identity, canonicalMetadata);
    const normalized = this.normalizeRichSync(checkedPayload, identity);
    try {
      return this.record(identity, normalized, this.metadataForRich(canonicalMetadata, normalized));
    } catch (error) {
      if (this.isOutputQuotaError(error)) return this.outputQuotaRecord(identity, canonicalMetadata, error);
      throw error;
    }
  }

  /** Normalize one rich request result without adding a visible output record. */
  async normalizeAlder(payload: unknown, identity: OutputScope): Promise<RichOutputPayload> {
    this.assertOpen();
    this.assertScope(identity);
    if (identity.documentRevision !== this.documentRevision) {
      throw new OutputStoreError("stale_value", "request output scope belongs to a stale document revision");
    }
    const normalized = await this.normalizeRichAsync(payload, identity);
    try {
      this.assertScope(identity);
      if (identity.documentRevision !== this.documentRevision) {
        throw new OutputStoreError("stale_value", "request output scope belongs to a stale document revision");
      }
      this.retainRequestArtifacts(normalized, identity);
      return normalized;
    } catch (error) {
      for (const descriptor of collectArtifactHandles(normalized)) this.release([descriptor]);
      throw error;
    }
  }

  /** Normalize raw out$md/out$html and registered R artifact basenames. */
  async ingestAlderAsync(
    payload: unknown,
    identity: OutputIdentity,
    metadata: Record<string, JsonValue> = {},
  ): Promise<OutputRecord> {
    this.assertOpen();
    this.assertIdentity(identity, true);
    const checkedPayload = strictJsonInput(payload, "Alder output must be strict JSON");
    const checkedMetadata = strictJsonInput(metadata, "output metadata must be strict JSON");
    if (!isPlainRecord(checkedMetadata)) throw new OutputStoreError("output_invalid", "output metadata must be a plain object");
    const canonicalMetadata = checkedMetadata as Record<string, JsonValue>;
    try {
      const normalized = await this.normalizeRichAsync(checkedPayload, identity);
      try {
        return this.record(identity, normalized, this.metadataForRich(canonicalMetadata, normalized));
      } catch (error) {
        for (const descriptor of collectArtifactHandles(normalized)) this.release([descriptor]);
        throw error;
      }
    } catch (error) {
      if (this.isOutputQuotaError(error)) return this.outputQuotaRecord(identity, canonicalMetadata, error);
      throw error;
    }
  }

  /** Append one canonical record received from a handler/replay path. */
  append(record: OutputRecord): void {
    this.assertOpen();
    const prepared = this.prepareRecord(record);
    this.commitPrepared(prepared);
  }
  /** Atomically replace one retained frozen record version by expected reference. */
  async updateRecord(expected: OutputRecord, payload: RichOutputPayload): Promise<OutputRecord> {
    this.assertOpen();
    if (expected === null || typeof expected !== "object" || typeof expected.id !== "string") {
      throw new OutputStoreError("stale_value", "expected output record is stale");
    }
    const current = this.recordsById.get(expected.id);
    if (current !== expected) throw new OutputStoreError("stale_value", "expected output record version is stale");
    const identity: OutputIdentity = {
      sessionEpoch: current.sessionEpoch,
      documentRevision: this.recordMetadataFor(current).documentRevision,
      kernelEpoch: current.kernelEpoch,
      runId: current.runId,
      cellId: current.cellId,
      revision: current.revision,
    };
    let normalized: RichOutputPayload | undefined;
    try {
      normalized = await this.normalizeRichAsync(payload, identity);
      const replacementData = normalized;
      const replacement: OutputRecord = {
        id: current.id,
        sessionEpoch: current.sessionEpoch,
        kernelEpoch: current.kernelEpoch,
        runId: current.runId,
        cellId: current.cellId,
        revision: current.revision,
        sequence: current.sequence,
        generation: (current.generation ?? 0) + 1,
        data: replacementData,
        metadata: this.metadataForRich(current.metadata, replacementData),
        truncated: hasTruncation(replacementData),
      };
      const prepared = this.prepareRecord(replacement, {
        skipCurrentSequence: true,
        documentRevision: identity.documentRevision,
        replaceExpected: current,
      });
      if (this.recordsById.get(expected.id) !== current) {
        throw new OutputStoreError("stale_value", "expected output record version is stale");
      }
      this.commitPreparedReplacement(current, prepared);
      return prepared.record;
    } catch (error) {
      if (normalized !== undefined) {
        for (const descriptor of collectArtifactHandles(normalized)) this.release([descriptor]);
      }
      throw error;
    }
  }

  /** Replace a cell's output atomically after validating every new record. */
  replace(cellId: string, revision: number, records: readonly OutputRecord[]): void {
    this.assertOpen();
    if (!safeId(cellId) || !isRevision(revision) || !Array.isArray(records) || records.length > MAX_RECORDS_PER_CELL) {
      throw new OutputStoreError("output_invalid", "invalid output replacement");
    }
    const prepared: PreparedRecord[] = [];
    const ids = new Set<string>();
    const ownerSequences = new Map<string, number>();
    for (const input of records) {
      if (input.cellId !== cellId || input.revision !== revision) {
        throw new OutputStoreError("output_invalid", "replacement record owner mismatch");
      }
      const candidate = this.prepareRecord(input, { skipCurrentSequence: true });
      if (ids.has(candidate.record.id) || this.recordsById.has(candidate.record.id)) {
        throw new OutputStoreError("output_invalid", "replacement contains a duplicate output id");
      }
      ids.add(candidate.record.id);
      const previous = ownerSequences.get(candidate.ownerKey);
      if (previous !== undefined && candidate.record.sequence !== previous + 1) {
        throw new OutputStoreError("output_invalid", "replacement output sequence is not monotonic");
      }
      ownerSequences.set(candidate.ownerKey, candidate.record.sequence);
      prepared.push(candidate);
    }

    this.removeRecords((record) => record.cellId === cellId);
    for (const candidate of prepared) this.commitPrepared(candidate);
  }

  /** Return canonical frozen records, preserving their object identities. */
  records(cellId?: string): readonly OutputRecord[] {
    this.assertOpen();
    if (cellId !== undefined && !safeId(cellId)) throw new OutputStoreError("output_invalid", "invalid output cell id");
    const values = cellId === undefined
      ? [...this.recordsByCell.values()].flat()
      : [...(this.recordsByCell.get(cellId) ?? [])];
    return Object.freeze(values);
  }

  /** Return the current canonical frozen version for one output id. */
  getRecord(id: string): OutputRecord | undefined {
    this.assertOpen();
    return this.recordsById.get(id);
  }

  /** Remove only the exact retained output versions supplied by the caller. */
  discardExact(records: readonly OutputRecord[]): void {
    this.assertOpen();
    if (!Array.isArray(records)) throw new OutputStoreError("output_invalid", "invalid exact output discard set");
    const exact = new Set<StoredRecord>();
    for (const expected of records) {
      if (expected === null || typeof expected !== "object" || typeof expected.id !== "string") continue;
      const current = this.recordsById.get(expected.id);
      if (current !== undefined && current === expected) exact.add(current);
    }
    if (exact.size !== 0) this.removeRecords((record) => exact.has(record));
  }
  /** Capture one immutable settled view, including every referenced descriptor. */
  snapshot(options: { cellIds?: readonly string[]; documentRevision?: number; kernelEpoch?: string | null } = {}): OutputStoreSnapshot {
    this.assertOpen();
    if (options.documentRevision !== undefined && options.documentRevision !== this.documentRevision) {
      throw new OutputStoreError("stale_value", "output snapshot has a stale document revision");
    }
    if (options.kernelEpoch !== undefined && options.kernelEpoch !== this.kernelEpoch) {
      throw new OutputStoreError("stale_value", "output snapshot has a stale kernel epoch");
    }
    const ids = options.cellIds === undefined ? undefined : new Set(options.cellIds);
    if (ids !== undefined) {
      for (const id of ids) if (!safeId(id)) throw new OutputStoreError("output_invalid", "invalid output cell id");
    }
    const records = [...this.recordsByCell.entries()]
      .filter(([id]) => ids === undefined || ids.has(id))
      .flatMap(([, values]) => values);
    const handles = new Map<string, ArtifactHandle>();
    for (const record of records) {
      for (const descriptor of this.recordDescriptors(record)) {
        const artifact = this.requireArtifact(descriptor);
        handles.set(artifact.descriptor.handle, artifact.descriptor);
      }
    }
    const frozenRecords = Object.freeze(records as readonly OutputRecord[]);
    const frozenArtifacts = Object.freeze([...handles.values()]);
    const result: OutputStoreSnapshot = { records: frozenRecords, artifacts: frozenArtifacts };
    if (jsonByteLength(result) > SNAPSHOT_MAX_BYTES) {
      throw new OutputStoreError("output_quota", "output snapshot exceeds the 128 MiB envelope");
    }
    return Object.freeze(result);
  }

  artifactManifest(descriptor: ArtifactHandle | string): ArtifactManifest {
    this.assertOpen();
    return this.requireReadableArtifact(descriptor).manifest;
  }

  /** Transfer a provisional or dedicated static value into a bounded public read lease. */
  retainArtifactRead(descriptor: ArtifactHandle, expiresAt: number): void {
    this.assertOpen();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new OutputStoreError("output_invalid", "invalid artifact read lease");
    }
    const artifact = this.requireArtifact(descriptor);
    artifact.readableUntil = Math.max(artifact.readableUntil ?? 0, expiresAt);
    artifact.protected = false;
  }

  /** Public eligibility and pins are acquired synchronously before any file I/O. */
  openArtifactResource(descriptor: ArtifactHandle | string, relative?: string): ArtifactResourceRead {
    this.assertOpen();
    const root = this.requireReadableArtifact(descriptor);
    const name = relative ?? root.manifest.entry;
    if (!Object.hasOwn(root.manifest.resources, name)) {
      throw new OutputStoreError("not_found", "artifact resource was not found");
    }
    const member = this.requireArtifact(root.manifest.resources[name]!);
    const pinned = root === member ? [root.descriptor] : [root.descriptor, member.descriptor];
    this.pin(pinned);
    let closed = false;
    return Object.freeze({
      descriptor: member.descriptor,
      read: (offset: number, limit: number): Promise<Uint8Array> => {
        if (closed) return Promise.reject(new OutputStoreError("output_expired", "artifact reader is closed"));
        return this.readArtifact(member.descriptor, offset, limit);
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        this.unpin(pinned);
      },
    });
  }
  /** Pin descriptors for a settled export or another durable consumer. */
  pin(handles: readonly ArtifactHandle[]): void {
    this.assertOpen();
    if (!Array.isArray(handles)) throw new OutputStoreError("output_invalid", "invalid artifact pin set");
    const artifacts = handles.map((descriptor) => this.requireArtifact(descriptor));
    for (const artifact of artifacts) {
      artifact.pins += 1;
      artifact.lastAccess = ++this.accessCounter;
    }
  }

  unpin(handles: readonly ArtifactHandle[]): void {
    if (!Array.isArray(handles)) return;
    for (const descriptor of handles) {
      if (!isArtifactHandle(descriptor)) continue;
      const artifact = this.artifactsByHandle.get(descriptor.handle);
      if (artifact === undefined) continue;
      if (!sameArtifactHandle(artifact.descriptor, descriptor)) continue;
      artifact.pins = Math.max(0, artifact.pins - 1);
      artifact.lastAccess = ++this.accessCounter;
      if (artifact.pins === 0 && !this.hasArtifactReference(artifact) && !artifact.protected && artifact.readableUntil === 0) artifact.retired = true;
    }
    this.collectRetiredArtifacts();
  }


  async readArtifact(handle: string | ArtifactHandle, offset: number, limit: number): Promise<Uint8Array> {
    this.assertOpen();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 ||
        limit > OUTPUT_ARTIFACT_CHUNK_BYTES) {
      throw new OutputStoreError("output_invalid", "invalid artifact range");
    }
    const artifact = typeof handle === "string" ? this.requireArtifactById(handle) : this.requireArtifact(handle);
    let file: FileHandle;
    let before: Stats;
    try {
      before = await lstat(artifact.path);
      if (!before.isFile()) throw new OutputStoreError("output_expired", "artifact is no longer a retained regular file");
      file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw error instanceof OutputStoreError ? error : new OutputStoreError("output_expired", "artifact bytes are no longer retained");
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || !sameSourceStat(before, info) || info.size !== artifact.descriptor.byteLength) {
        throw new OutputStoreError("output_expired", "artifact bytes no longer match their descriptor");
      }
      if (offset > info.size) throw new OutputStoreError("stale_value", "artifact offset is outside the retained value");
      const length = Math.min(limit, info.size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const result = await file.read(chunk, 0, length, offset);
      if (result.bytesRead !== length) throw new OutputStoreError("output_expired", "artifact bytes were truncated during read");
      artifact.lastAccess = ++this.accessCounter;
      return Uint8Array.from(chunk);
    } finally {
      await file.close();
    }
  }
  release(handles: readonly ArtifactHandle[]): { released: string[]; missing: string[]; failed: string[] } {
    const result = { released: [] as string[], missing: [] as string[], failed: [] as string[] };
    if (!Array.isArray(handles)) return result;
    for (const descriptor of handles) {
      if (!isArtifactHandle(descriptor)) continue;
      const artifact = this.artifactsByHandle.get(descriptor.handle);
      if (artifact === undefined || artifact.retired) { result.missing.push(descriptor.handle); continue; }
      if (!sameArtifactHandle(artifact.descriptor, descriptor)) { result.failed.push(descriptor.handle); continue; }
      artifact.readableUntil = 0;
      artifact.protected = false;
      if (artifact.pins === 0 && !this.hasArtifactReference(artifact)) artifact.retired = true;
      result.released.push(descriptor.handle);
    }
    this.collectRetiredArtifacts();
    return result;
  }

  /** Invalidate only request-owned artifacts; visible records remain retained. */
  invalidateRequests(predicate: OutputInvalidationPredicate = {}): void {
    this.assertOpen();
    for (const [ownerKey, retained] of this.requestArtifactsByOwner) {
      const owner = retained.identity;
      const matches =
        (predicate.cellId === undefined || owner.cellId === predicate.cellId) &&
        (predicate.revision === undefined || owner.revision === predicate.revision) &&
        (predicate.kernelEpoch === undefined || owner.kernelEpoch === predicate.kernelEpoch) &&
        (predicate.documentRevision === undefined || owner.documentRevision === predicate.documentRevision);
      if (!matches) continue;
      this.releaseRequestArtifacts(retained.handles);
      this.requestArtifactsByOwner.delete(ownerKey);
    }
    this.collectRetiredArtifacts();
  }

  async clear(): Promise<void> {
    this.assertOpen();
    await this.writeTail;
    this.removeRecords(() => true);
    for (const artifact of this.artifactsByHandle.values()) {
      artifact.retired = artifact.pins === 0;
      artifact.protected = false;
      artifact.readableUntil = 0;
      artifact.recordReferences = 0;
      artifact.requestReferences = 0;
    }
    this.requestArtifactsByOwner.clear();
    this.collectRetiredArtifacts();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeTail;
    this.removeRecords(() => true);
    for (const artifact of this.artifactsByHandle.values()) {
      artifact.retired = artifact.pins === 0;
      artifact.protected = false;
      artifact.readableUntil = 0;
      artifact.recordReferences = 0;
      artifact.requestReferences = 0;
    }
    this.requestArtifactsByOwner.clear();
    this.collectRetiredArtifacts();
    this.recordsByCell.clear();
    this.recordsById.clear();
    this.nextSequenceByOwner.clear();
  }

  /** Copy a registered R basename into the canonical opaque store. */
  async importArtifact(
    name: string,
    identity: OutputScope,
    options: ArtifactImportOptions = {},
  ): Promise<ArtifactHandle> {
    this.assertOpen();
    this.assertScope(identity);
    if (!safeHandle(name)) throw new OutputStoreError("output_invalid", "artifact name must be a safe registered basename");
    const root = await realpath(this.artifactSourceDirectory).catch(() => {
      throw new OutputStoreError("not_found", "artifact source directory is unavailable");
    });
    const candidate = resolve(root, name);
    if (!isInside(root, candidate) || isAbsolute(name)) {
      throw new OutputStoreError("output_invalid", "artifact path escapes the source directory");
    }
    const source = await realpath(candidate).catch(() => {
      throw new OutputStoreError("not_found", "registered artifact was not found");
    });
    if (!isInside(root, source)) throw new OutputStoreError("output_invalid", "artifact path escapes the source directory");
    const sourceStat = await stat(source).catch(() => {
      throw new OutputStoreError("not_found", "registered artifact was not found");
    });
    if (!sourceStat.isFile()) throw new OutputStoreError("output_invalid", "registered artifact is not a regular file");
    if (!Number.isSafeInteger(sourceStat.size) || sourceStat.size > this.maxArtifactBytes) {
      throw new OutputStoreError("output_quota", "artifact exceeds the retained output quota");
    }
    const mimeType = options.mimeType ?? mimeForArtifact(name);
    const extension = options.extension ?? extensionForMime(mimeType, name);
    let sourceHandle: FileHandle;
    try {
      sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new OutputStoreError("stale_value", "registered artifact changed during import");
    }
    try {
      const openedStat = await sourceHandle.stat();
      if (!sameSourceStat(sourceStat, openedStat)) {
        throw new OutputStoreError("stale_value", "registered artifact changed during import");
      }
      const resolvedAgain = await realpath(candidate).catch(() => "");
      if (resolvedAgain !== source) throw new OutputStoreError("stale_value", "registered artifact path changed during import");
      return await this.writeArtifactFromSource(sourceHandle, sourceStat, source, candidate, mimeType, extension, identity);
    } finally {
      await sourceHandle.close().catch(() => {});
    }
  }

  private async writeArtifactFromSource(
    sourceHandle: FileHandle,
    sourceStat: Stats,
    sourcePath: string,
    candidatePath: string,
    mimeType: string,
    extension: string,
    identity: OutputScope,
  ): Promise<ArtifactHandle> {
    const byteLength = sourceStat.size;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.maxArtifactBytes) {
      throw new OutputStoreError("output_quota", "artifact exceeds the retained output quota");
    }
    if (!safeMime(mimeType)) throw new OutputStoreError("output_invalid", "artifact MIME type is invalid");
    const safeExtension = normalizeExtension(extension);
    return this.withArtifactWriteLock(async () => {
      await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
      this.makeRoom(byteLength);
      this.reservedArtifactBytes += byteLength;
      const handle = randomUUID();
      const path = join(this.artifactDirectory, handle + safeExtension);
      const temporary = join(this.artifactDirectory, handle + ".tmp-" + randomUUID());
      let promoted = false;
      let destination: FileHandle | undefined;
      try {
        destination = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(OUTPUT_ARTIFACT_CHUNK_BYTES, byteLength)));
        let offset = 0;
        while (offset < byteLength) {
          const length = Math.min(chunk.byteLength, byteLength - offset);
          let bytesRead = 0;
          while (bytesRead < length) {
            const result = await sourceHandle.read(chunk, bytesRead, length - bytesRead, offset + bytesRead);
            if (result.bytesRead <= 0) throw new OutputStoreError("output_expired", "registered artifact was truncated during import");
            bytesRead += result.bytesRead;
          }
          let bytesWritten = 0;
          while (bytesWritten < length) {
            const result = await destination.write(chunk, bytesWritten, length - bytesWritten, offset + bytesWritten);
            if (result.bytesWritten <= 0) throw new OutputStoreError("output_expired", "artifact copy was truncated");
            bytesWritten += result.bytesWritten;
          }
          offset += length;
        }
        const finalStat = await sourceHandle.stat();
        const resolvedAgain = await realpath(candidatePath).catch(() => "");
        if (!sameSourceStat(sourceStat, finalStat) || resolvedAgain !== sourcePath) {
          throw new OutputStoreError("stale_value", "registered artifact changed during import");
        }
        await destination.close();
        destination = undefined;
        await rename(temporary, path);
        promoted = true;
        const descriptor: ArtifactHandle = Object.freeze({
          handle,
          mimeType,
          byteLength,
          chunkBytes: OUTPUT_ARTIFACT_CHUNK_BYTES,
          epoch: this.sessionEpoch,
          documentRevision: identity.documentRevision,
          kernelEpoch: identity.kernelEpoch,
        });
        const artifact: StoredArtifact = {
          descriptor,
          manifest: createArtifactManifest(descriptor, safeExtension),
          readableUntil: 0,
          path,
          bytes: byteLength,
          pins: 0,
          recordReferences: 0,
          requestReferences: 0,
          retired: false,
          staticValue: identity.kernelEpoch === null && identity.runId === null,
          survivesIdentityChanges: false,
          owner: { ...identity },
          lastAccess: ++this.accessCounter,
          protected: true,
        };
        this.artifactsByHandle.set(handle, artifact);
        this.retainedArtifactBytes += byteLength;
        return descriptor;
      } catch (error) {
        await destination?.close().catch(() => {});
        if (!promoted) await unlink(temporary).catch(() => {});
        else await unlink(path).catch(() => {});
        throw error;
      } finally {
        this.reservedArtifactBytes -= byteLength;
      }
    });
  }

  /** Retain bytes under a request or standalone static output scope. */
  async writeArtifact(
    bytes: Uint8Array,
    mimeType: string,
    extension: string,
    identity: OutputScope,
  ): Promise<ArtifactHandle> {
    this.assertOpen();
    this.assertScope(identity);
    return this.writeArtifactBytes(bytes, mimeType, extension, identity);
  }

  /**
   * Retain immutable bytes for a historical or newly acknowledged document
   * revision without changing the store's active runtime identity.
   *
   * Static artifacts are deliberately runtime-free: they cannot carry a
   * kernel, run, cell, or execution revision, and their session epoch must
   * still belong to this store.
   */
  async writeStaticArtifact(
    bytes: Uint8Array,
    mimeType: string,
    extension: string,
    identity: StaticOutputScope,
  ): Promise<ArtifactHandle> {
    this.assertOpen();
    this.assertStaticScope(identity);
    return this.writeArtifactBytes(bytes, mimeType, extension, identity, true);
  }

  private async writeArtifactBytes(
    bytes: Uint8Array,
    mimeType: string,
    extension: string,
    identity: OutputScope,
    survivesIdentityChanges = false,
  ): Promise<ArtifactHandle> {
    const staticScope = identity.kernelEpoch === null && identity.runId === null;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxArtifactBytes) {
      throw new OutputStoreError("output_quota", "artifact exceeds the retained output quota");
    }
    if (!safeMime(mimeType)) throw new OutputStoreError("output_invalid", "artifact MIME type is invalid");
    const safeExtension = normalizeExtension(extension);
    const capturedIdentity = Object.freeze({ ...identity });
    const byteLength = bytes.byteLength;
    return this.withArtifactWriteLock(async () => {
      await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
      this.makeRoom(byteLength);
      this.reservedArtifactBytes += byteLength;
      const handle = randomUUID();
      const path = join(this.artifactDirectory, `${handle}${safeExtension}`);
      const temporary = join(this.artifactDirectory, `${handle}.tmp-${randomUUID()}`);
      let promoted = false;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
        promoted = true;
        const descriptor: ArtifactHandle = Object.freeze({
          handle,
          mimeType,
          byteLength,
          chunkBytes: OUTPUT_ARTIFACT_CHUNK_BYTES,
          epoch: capturedIdentity.sessionEpoch,
          documentRevision: capturedIdentity.documentRevision,
          kernelEpoch: capturedIdentity.kernelEpoch,
        });
        const artifact: StoredArtifact = {
          descriptor,
          manifest: createArtifactManifest(descriptor, safeExtension),
          readableUntil: survivesIdentityChanges ? null : 0,
          path,
          bytes: byteLength,
          pins: 0,
          recordReferences: 0,
          requestReferences: 0,
          retired: false,
          staticValue: staticScope,
          survivesIdentityChanges,
          owner: capturedIdentity,
          lastAccess: ++this.accessCounter,
          protected: true,
        };
        this.artifactsByHandle.set(handle, artifact);
        this.retainedArtifactBytes += byteLength;
        return descriptor;
      } catch (error) {
        if (!promoted) await unlink(temporary).catch(() => {});
        else await unlink(path).catch(() => {});
        throw error;
      } finally {
        this.reservedArtifactBytes -= byteLength;
      }
    });
  }

  private completeIdentity(
    identity: Omit<OutputIdentity, "sessionEpoch" | "documentRevision" | "kernelEpoch"> & {
      sessionEpoch?: string;
      documentRevision?: number;
      kernelEpoch?: string | null;
    },
  ): OutputIdentity {
    const kernelEpoch = Object.prototype.hasOwnProperty.call(identity, "kernelEpoch") ? identity.kernelEpoch! : this.kernelEpoch;
    return {
      sessionEpoch: identity.sessionEpoch ?? this.sessionEpoch,
      documentRevision: identity.documentRevision ?? this.documentRevision,
      kernelEpoch,
      runId: identity.runId,
      cellId: identity.cellId,
      revision: identity.revision,
    };
  }

  private record(identity: OutputIdentity, data: OutputRecord["data"], metadata: Record<string, JsonValue>, truncated = hasTruncation(data)): OutputRecord {
    const candidate: OutputRecord = {
      id: randomUUID(),
      sessionEpoch: identity.sessionEpoch,
      kernelEpoch: identity.kernelEpoch,
      runId: identity.runId,
      cellId: identity.cellId,
      revision: identity.revision,
      sequence: this.nextSequence(identity),
      data,
      metadata,
      truncated,
    };
    const prepared = this.prepareRecord(candidate, { documentRevision: identity.documentRevision });
    this.commitPrepared(prepared);
    return prepared.record;
  }
  private isOutputQuotaError(error: unknown): error is OutputStoreError {
    return error instanceof OutputStoreError && error.code === "output_quota";
  }

  private outputQuotaRecord(identity: OutputIdentity, metadata: Record<string, JsonValue>, error: OutputStoreError): OutputRecord {
    return this.record(identity, {
      kind: "error",
      code: "output_quota",
      message: boundedText(error.message, OUTPUT_RECORD_MAX_BYTES),
    }, this.metadata(metadata, "inline"), true);
  }

  private prepareRecord(record: OutputRecord, options: PrepareRecordOptions = {}): PreparedRecord {
    const checkedRecord = strictJsonInput(record, "output record must be strict JSON");
    if (!isPlainRecord(checkedRecord)) throw new OutputStoreError("output_invalid", "invalid output record");
    const recordObject = checkedRecord as Record<string, JsonValue>;
    const checkedMetadata = recordObject.metadata;
    if (!isPlainRecord(checkedMetadata)) throw new OutputStoreError("output_invalid", "invalid output metadata");
    const metadata = this.metadataForRich(checkedMetadata as Record<string, JsonValue>, recordObject.data);
    const parsed = outputRecordSchema.safeParse({ ...recordObject, metadata });
    if (!parsed.success) throw new OutputStoreError("output_invalid", "invalid output record");
    const value = parsed.data;
    const documentRevision = options.documentRevision ?? this.documentRevision;
    if (!isRevision(documentRevision) || documentRevision > this.documentRevision) {
      throw new OutputStoreError("stale_value", "output record belongs to a future document revision");
    }

    if (!safeId(value.id) || value.sessionEpoch !== this.sessionEpoch || !safeId(value.cellId) ||
        !isRevision(value.revision) || !Number.isSafeInteger(value.sequence) || value.sequence <= 0 ||
        !isRevision(value.sequence)) {
      throw new OutputStoreError("output_invalid", "invalid output record identity or sequence");
    }
    if (!pairedIdentity(value.kernelEpoch, value.runId)) {
      throw new OutputStoreError("output_invalid", "kernelEpoch and runId must both be null or both be present");
    }
    if (value.kernelEpoch !== null && value.kernelEpoch !== this.kernelEpoch) {
      throw new OutputStoreError("stale_value", "output record belongs to a stale kernel epoch");
    }
    const normalizedData = this.normalizeRecordDataSync(value.data, {
      sessionEpoch: value.sessionEpoch,
      documentRevision,
      kernelEpoch: value.kernelEpoch,
      runId: value.runId,
      cellId: value.cellId,
      revision: value.revision,
    });
    const normalizedMetadata = this.metadataForRich(value.metadata, normalizedData);
    const canonical: OutputRecord = {
      ...value,
      data: normalizedData,
      metadata: normalizedMetadata,
      truncated: value.truncated || hasTruncation(normalizedData),
    };
    if (jsonByteLength(canonical) > OUTPUT_RECORD_MAX_BYTES) {
      throw new OutputStoreError("output_quota", "output record exceeds the 8 MiB envelope");
    }
    const handles = this.validateRecordArtifacts(canonical, documentRevision);
    const ownerKey = outputOwnerKey({ ...canonical, documentRevision });

    if (!options.skipCurrentSequence) {
      const expected = this.nextSequenceByOwner.get(ownerKey) ?? 1;
      if (canonical.sequence !== expected) {
        throw new OutputStoreError("output_invalid", "output sequence is not monotonic for its owner");
      }
    }
    const retained = this.recordsById.get(canonical.id);
    if (options.replaceExpected === undefined) {
      if (retained !== undefined) throw new OutputStoreError("output_invalid", "output id is already retained");
    } else {
      const expected = options.replaceExpected;
      if (retained !== expected || canonical.id !== expected.id ||
          canonical.sessionEpoch !== expected.sessionEpoch || canonical.kernelEpoch !== expected.kernelEpoch ||
          canonical.runId !== expected.runId || canonical.cellId !== expected.cellId ||
          canonical.revision !== expected.revision || canonical.sequence !== expected.sequence) {
        throw new OutputStoreError("stale_value", "expected output record version is stale");
      }
    }
    const stored: StoredRecord = Object.freeze({
      ...canonical,
      data: freezeJson(canonical.data),
      metadata: freezeJson(canonical.metadata),
    });
    return { record: stored, handles, ownerKey, documentRevision };
  }

  private normalizeRecordDataSync(value: unknown, identity: OutputIdentity): OutputRecord["data"] {
    if (!isPlainRecord(value)) throw new OutputStoreError("output_invalid", "output data must be a plain object");
    if (typeof value.kind === "string") {
      const parsed = richOutputPayloadSchema.safeParse(value);
      if (!parsed.success) throw new OutputStoreError("output_invalid", "invalid Alder rich output payload");
      const normalized = this.canonicalizeRichSync(parsed.data, identity);
      return normalized;
    }
    // application/json is the only non-rich fallback representation retained in
    // the canonical record. Every other invented data shape is rejected.
    if (value.mime !== "application/json" || !("value" in value) || typeof value.preview !== "string" ||
        !isJsonValue(value.value) || byteLength(value.preview) > OUTPUT_PREVIEW_MAX_BYTES) {
      throw new OutputStoreError("output_invalid", "output data is not one of the eleven canonical kinds");
    }
    return {
      mime: "application/json",
      value: cloneJson(value.value),
      preview: boundedPreview(value.value),
    };
  }

  private normalizeRichSync(value: unknown, identity: OutputIdentity): RichOutputPayload {
    const checked = strictJsonInput(value, "Alder output must be strict JSON");
    if (!isPlainRecord(checked)) throw new OutputStoreError("output_invalid", "Alder output must be a plain object");
    const richValue = this.normalizeRawRich(checked) as Record<string, unknown>;
    const parsed = richOutputPayloadSchema.safeParse(richValue);
    if (!parsed.success) throw new OutputStoreError("output_invalid", "invalid Alder rich output payload");
    return this.canonicalizeRichSync(parsed.data, identity);
  }

  private async normalizeRichAsync(value: unknown, identity: OutputScope): Promise<RichOutputPayload> {
    const checked = strictJsonInput(value, "Alder output must be strict JSON");
    if (!isPlainRecord(checked)) throw new OutputStoreError("output_invalid", "Alder output must be a plain object");
    const created: ArtifactHandle[] = [];
    try {
      const copied = await this.copyRawArtifacts(checked, identity, created, true);
      const normalizedRaw = this.normalizeRawRich(copied);
      const parsed = richOutputPayloadSchema.safeParse(normalizedRaw);
      if (!parsed.success) throw new OutputStoreError("output_invalid", "invalid Alder rich output payload");
      return this.canonicalizeRichSync(parsed.data, identity);
    } catch (error) {
      for (const descriptor of created) this.release([descriptor]);
      throw error;
    }
  }

  private normalizeRawRich(value: unknown): unknown {
    if (!isPlainRecord(value)) return value;
    const kind = typeof value.kind === "string" ? value.kind : undefined;
    if (kind === "markdown" && typeof value.text === "string") {
      this.assertMIMEInput(value.text);
      const html = typeof value.html === "string" ? value.html : renderMarkdown(value.text).html;
      this.assertMIMEInput(html);
      return {
        ...value,
        kind: "markdown",
        text: boundedText(value.text, OUTPUT_RECORD_MAX_BYTES),
        html: boundedText(sanitizeHtmlFragment(html), OUTPUT_RECORD_MAX_BYTES),
      };
    }
    if (kind === "html" && typeof value.html === "string" && value.artifact === undefined) {
      this.assertMIMEInput(value.html);
      return {
        ...value,
        html: boundedText(sanitizeHtmlFragment(value.html), OUTPUT_RECORD_MAX_BYTES),
      };
    }
    if (kind === "layout" && Array.isArray(value.children)) {
      return { ...value, children: value.children.map((child) => this.normalizeRawRich(child)) };
    }
    if (kind === "lazy" && value.child !== null && value.child !== undefined) {
      return { ...value, child: this.normalizeRawRich(value.child) };
    }
    return value;
  }

  private retainRequestArtifacts(value: unknown, identity: OutputScope): void {
    const descriptors = collectArtifactHandles(value);
    const artifacts = descriptors.map((descriptor) => this.requireArtifact(descriptor));
    for (const artifact of artifacts) {
      if (artifact.owner.sessionEpoch !== identity.sessionEpoch ||
          artifact.owner.documentRevision !== identity.documentRevision ||
          artifact.owner.kernelEpoch !== identity.kernelEpoch ||
          artifact.owner.runId !== identity.runId ||
          artifact.owner.cellId !== identity.cellId ||
          artifact.owner.revision !== identity.revision) {
        throw new OutputStoreError("stale_value", "artifact is scoped to a different request output scope");
      }
    }
    const ownerKey = outputOwnerKey(identity);
    const previous = this.requestArtifactsByOwner.get(ownerKey);
    const previousHandles = new Set(previous?.handles ?? []);
    const nextHandles: string[] = [];
    const nextHandleSet = new Set<string>();
    for (const artifact of artifacts) {
      const handle = artifact.descriptor.handle;
      if (nextHandleSet.has(handle)) continue;
      nextHandleSet.add(handle);
      nextHandles.push(handle);
      if (previousHandles.has(handle)) continue;
      artifact.retired = false;
      artifact.protected = false;
      artifact.requestReferences += 1;
      artifact.lastAccess = ++this.accessCounter;
    }
    if (previous !== undefined) {
      this.releaseRequestArtifacts(previous.handles.filter((handle) => !nextHandleSet.has(handle)));
    }
    if (nextHandles.length === 0) this.requestArtifactsByOwner.delete(ownerKey);
    else {
      this.requestArtifactsByOwner.set(ownerKey, {
        identity: Object.freeze({ ...identity }),
        handles: Object.freeze(nextHandles),
      });
    }
    this.collectRetiredArtifacts();
  }

  private releaseRequestArtifacts(handles: readonly string[]): void {
    for (const handle of handles) {
      const artifact = this.artifactsByHandle.get(handle);
      if (artifact === undefined) continue;
      artifact.requestReferences = Math.max(0, artifact.requestReferences - 1);
      if (!this.hasArtifactReference(artifact) && artifact.pins === 0 && artifact.readableUntil === 0) {
        artifact.protected = false;
        if (!artifact.survivesIdentityChanges) artifact.retired = true;
      }
    }
  }

  private async copyRawArtifacts(
    value: unknown,
    identity: OutputScope,
    created: ArtifactHandle[],
    richNode: boolean,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => this.copyRawArtifacts(entry, identity, created, richNode)));
    }
    if (!isPlainRecord(value)) return value;
    const currentKind = richNode && typeof value.kind === "string" ? value.kind : undefined;
    if (currentKind === "html" && typeof value.html === "string" && value.artifact === undefined) {
      this.assertMIMEInput(value.html);
      return { ...value, html: boundedText(value.html, OUTPUT_RECORD_MAX_BYTES) };
    }
    const artifactKind = currentKind === "image" || currentKind === "html" || currentKind === "media";
    const next: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (artifactKind && key === "artifact" && typeof entry === "string") {
        const mimeType = typeof value.mime === "string"
          ? value.mime
          : currentKind === "html" ? "text/html" : currentKind === "image" ? mimeForArtifact(entry) : "application/octet-stream";
        const descriptor = await this.importArtifact(entry, identity, {
          mimeType,
          extension: extensionForMime(mimeType, entry),
        });
        created.push(descriptor);
        next[key] = descriptor;
      } else {
        const childRich = richNode && ((currentKind === "layout" && key === "children") || (currentKind === "lazy" && key === "child"));
        next[key] = await this.copyRawArtifacts(entry, identity, created, childRich);
      }
    }
    return next;
  }
  private canonicalizeRichSync(value: RichOutputPayload, identity: OutputScope): RichOutputPayload {
    const parsed = richOutputPayloadSchema.safeParse(value);
    if (!parsed.success) throw new OutputStoreError("output_invalid", "invalid Alder rich output payload");
    const raw = parsed.data as unknown as Record<string, unknown>;
    const canonical = this.canonicalizeJsonReferences(raw, identity, 0, true) as Record<string, unknown>;
    if (canonical.kind === "markdown") {
      if (typeof canonical.html !== "string" || typeof canonical.text !== "string") {
        throw new OutputStoreError("output_invalid", "markdown output is incomplete");
      }
      canonical.html = boundedText(sanitizeHtmlFragment(canonical.html), OUTPUT_RECORD_MAX_BYTES);
      canonical.text = boundedText(canonical.text, OUTPUT_RECORD_MAX_BYTES);
    }
    if (canonical.kind === "html" && typeof canonical.html === "string") {
      canonical.html = boundedText(sanitizeHtmlFragment(canonical.html), OUTPUT_RECORD_MAX_BYTES);
    }
    if (canonical.kind === "text" && typeof canonical.text === "string") {
      canonical.text = boundedText(canonical.text, OUTPUT_RECORD_MAX_BYTES);
    }
    return canonical as unknown as RichOutputPayload;
  }


  private canonicalizeJsonReferences(value: unknown, identity: OutputScope, depth = 0, richNode = false, artifactKind?: string): unknown {
    if (depth > MAX_COLLECTION_DEPTH) throw new OutputStoreError("output_invalid", "nested output exceeds the depth limit");
    if (artifactKind !== undefined) {
      if (!isArtifactHandle(value)) throw new OutputStoreError("output_invalid", "canonical output requires an ArtifactHandle descriptor");
      const descriptor = this.requireArtifact(value).descriptor;
      const compatible = artifactKind === "html"
        ? htmlMimeCompatible(descriptor.mimeType)
        : mediaMimeCompatible(artifactKind, descriptor.mimeType);
      if (!compatible) throw new OutputStoreError("output_invalid", "artifact MIME type is incompatible with its output kind");
      return descriptor;
    }
    if (Array.isArray(value)) return value.map((entry) => this.canonicalizeJsonReferences(entry, identity, depth + 1, richNode));
    if (!isPlainRecord(value)) return value;
    const kind = richNode && typeof value.kind === "string" ? value.kind : undefined;
    const artifactMediaType = kind === "image" ? "image" : kind === "html" ? "html" :
      kind === "media" && typeof value.media_type === "string" ? value.media_type : undefined;
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      const childRich = richNode && ((kind === "layout" && key === "children") || (kind === "lazy" && key === "child"));
      output[key] = this.canonicalizeJsonReferences(entry, identity, depth + 1, childRich,
        key === "artifact" ? artifactMediaType : undefined);
    }
    return output;
  }
  private metadataForRich(metadata: Record<string, JsonValue>, data: unknown): Record<string, JsonValue> {
    const record = isPlainRecord(data) ? data : undefined;
    const kind = record !== undefined && typeof record.kind === "string" ? record.kind : undefined;
    const presentation: OutputPresentation = record?.mime === "application/json" || kind === undefined ||
      kind === "markdown" || kind === "text" || kind === "table" || kind === "progress" || kind === "error" ||
      (kind === "html" && record !== undefined && typeof record.html === "string") ? "inline" : "sandbox";
    return this.metadata(metadata, presentation);
  }
  private metadata(
    metadata: Record<string, JsonValue>,
    presentation: OutputPresentation,
    extra?: Record<string, JsonValue>,
  ): Record<string, JsonValue> {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "presentation") continue;
      if (!isJsonValue(value)) continue;
      result[key] = cloneJson(value) as JsonValue;
    }
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) if (isJsonValue(value)) result[key] = cloneJson(value) as JsonValue;
    }
    result.presentation = presentation;
    return result;
  }

  private validateRecordArtifacts(record: OutputRecord, documentRevision: number): readonly ArtifactHandle[] {
    const descriptors = collectArtifactHandles(record.data);
    for (const descriptor of descriptors) {
      const artifact = this.requireArtifact(descriptor);
      if (artifact.owner.sessionEpoch !== record.sessionEpoch ||
          artifact.owner.documentRevision !== documentRevision ||
          artifact.owner.kernelEpoch !== record.kernelEpoch ||
          artifact.owner.runId !== record.runId ||
          artifact.owner.cellId !== record.cellId ||
          artifact.owner.revision !== record.revision) {
        throw new OutputStoreError("stale_value", "artifact is scoped to a different output owner");
      }
    }
    return Object.freeze(descriptors);
  }

  private recordMetadataFor(record: StoredRecord): StoredRecordMetadata {
    const metadata = this.recordMetadata.get(record);
    if (metadata === undefined) throw new OutputStoreError("output_expired", "output record is no longer retained");
    return metadata;
  }

  private recordDescriptors(record: StoredRecord): readonly ArtifactHandle[] {
    return this.recordMetadataFor(record).handles.map((handle) => this.requireArtifactById(handle).descriptor);
  }

  private commitPrepared(prepared: PreparedRecord): void {
    const current = this.recordsByCell.get(prepared.record.cellId) ?? [];
    if (current.length >= MAX_RECORDS_PER_CELL) {
      throw new OutputStoreError("output_quota", "cell output record quota exceeded");
    }
    const stored = prepared.record as StoredRecord;
    for (const descriptor of prepared.handles) {
      const artifact = this.requireArtifact(descriptor);
      artifact.protected = false;
      artifact.recordReferences += 1;
      artifact.lastAccess = ++this.accessCounter;
    }
    current.push(stored);
    this.recordsByCell.set(stored.cellId, current);
    this.recordsById.set(stored.id, stored);
    this.ownedRecords.add(stored);
    this.nextSequenceByOwner.set(prepared.ownerKey, stored.sequence + 1);
    this.recordMetadata.set(stored, Object.freeze({
      handles: Object.freeze(prepared.handles.map((descriptor) => descriptor.handle)),
      documentRevision: prepared.documentRevision,
    }));
  }
  private commitPreparedReplacement(expected: StoredRecord, prepared: PreparedRecord): void {
    const current = this.recordsById.get(expected.id);
    const records = this.recordsByCell.get(expected.cellId);
    const expectedMetadata = this.recordMetadata.get(expected);
    const stored = prepared.record;
    const index = records?.indexOf(expected) ?? -1;
    if (current !== expected || records === undefined || expectedMetadata === undefined || index < 0 ||
        stored.id !== expected.id || stored.sessionEpoch !== expected.sessionEpoch ||
        stored.kernelEpoch !== expected.kernelEpoch || stored.runId !== expected.runId ||
        stored.cellId !== expected.cellId || stored.revision !== expected.revision ||
        stored.sequence !== expected.sequence || prepared.documentRevision !== expectedMetadata.documentRevision) {
      for (const descriptor of prepared.handles) this.release([descriptor]);
      throw new OutputStoreError("stale_value", "expected output record version is stale");
    }

    const previousHandles = new Set(expectedMetadata.handles);
    const nextHandles = new Set(prepared.handles.map((descriptor) => descriptor.handle));
    for (const descriptor of prepared.handles) {
      if (previousHandles.has(descriptor.handle)) continue;
      const artifact = this.requireArtifact(descriptor);
      artifact.protected = false;
      artifact.recordReferences += 1;
      artifact.lastAccess = ++this.accessCounter;
    }
    for (const handle of previousHandles) {
      if (nextHandles.has(handle)) continue;
      const artifact = this.artifactsByHandle.get(handle);
      if (artifact === undefined) continue;
      artifact.recordReferences = Math.max(0, artifact.recordReferences - 1);
      if (!this.hasArtifactReference(artifact) && artifact.pins === 0 && artifact.readableUntil === 0) {
        artifact.protected = false;
        artifact.retired = true;
      }
    }
    records[index] = stored;
    this.recordsById.set(stored.id, stored);
    this.ownedRecords.add(stored);
    this.nextSequenceByOwner.set(prepared.ownerKey, stored.sequence + 1);
    this.recordMetadata.set(stored, Object.freeze({
      handles: Object.freeze([...nextHandles]),
      documentRevision: prepared.documentRevision,
    }));
    this.recordMetadata.delete(expected);
    this.collectRetiredArtifacts();
  }

  private removeRecords(predicate: (record: StoredRecord) => boolean): void {
    for (const [cellId, records] of this.recordsByCell) {
      const remove: StoredRecord[] = [];
      const keep: StoredRecord[] = [];
      for (const record of records) {
        if (predicate(record)) remove.push(record);
        else keep.push(record);
      }
      for (const record of remove) this.removeRecord(record);
      if (keep.length === 0) this.recordsByCell.delete(cellId);
      else this.recordsByCell.set(cellId, keep);
    }
    this.collectRetiredArtifacts();
  }

  private removeRecord(record: StoredRecord): void {
    const metadata = this.recordMetadataFor(record);
    this.recordsById.delete(record.id);
    const ownerKey = outputOwnerKey({ ...record, documentRevision: metadata.documentRevision });

    const next = this.nextSequenceByOwner.get(ownerKey);
    if (next !== undefined && next <= record.sequence + 1) this.nextSequenceByOwner.delete(ownerKey);
    for (const handle of metadata.handles) {
      const artifact = this.artifactsByHandle.get(handle);
      if (artifact === undefined) continue;
      artifact.recordReferences = Math.max(0, artifact.recordReferences - 1);
      if (!this.hasArtifactReference(artifact) && artifact.pins === 0 && artifact.readableUntil === 0) {
        artifact.protected = false;
        artifact.retired = true;
      }
    }
    this.recordMetadata.delete(record);
  }
  private requireReadableArtifact(descriptor: ArtifactHandle | string): StoredArtifact {
    const artifact = typeof descriptor === "string" ? this.requireArtifactById(descriptor) : this.requireArtifact(descriptor);
    if (!this.hasArtifactReference(artifact) && artifact.readableUntil !== null && artifact.readableUntil <= Date.now()) {
      throw new OutputStoreError("output_expired", "artifact has no retained public owner");
    }
    return artifact;
  }
  private requireArtifact(descriptor: ArtifactHandle): StoredArtifact {
    if (!isArtifactHandle(descriptor)) throw new OutputStoreError("output_invalid", "invalid artifact handle");
    const artifact = this.artifactsByHandle.get(descriptor.handle);
    if (artifact === undefined || artifact.retired) throw new OutputStoreError("output_expired", "artifact handle is stale");
    if (!sameArtifactHandle(artifact.descriptor, descriptor)) {
      throw new OutputStoreError("stale_value", "artifact handle identity is stale");
    }
    artifact.lastAccess = ++this.accessCounter;
    return artifact;
  }

  private requireArtifactById(handle: string): StoredArtifact {
    if (!safeHandle(handle)) throw new OutputStoreError("output_invalid", "invalid artifact handle");
    const artifact = this.artifactsByHandle.get(handle);
    if (artifact === undefined || artifact.retired) throw new OutputStoreError("not_found", "artifact was not found");
    artifact.lastAccess = ++this.accessCounter;
    return artifact;
  }

  private hasArtifactReference(artifact: StoredArtifact): boolean {
    return artifact.recordReferences > 0 || artifact.requestReferences > 0;
  }

  private makeRoom(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxArtifactBytes) {
      throw new OutputStoreError("output_quota", "artifact exceeds output quota");
    }
    this.collectRetiredArtifacts();
    const now = Date.now();
    const candidates = [...this.artifactsByHandle.values()]
      .filter((artifact) => artifact.pins === 0 && !this.hasArtifactReference(artifact) && !artifact.protected && !artifact.retired && artifact.readableUntil !== null && artifact.readableUntil <= now)
      .sort((left, right) => left.lastAccess - right.lastAccess);
    for (const artifact of candidates) {
      if (this.retainedArtifactBytes + this.reservedArtifactBytes + bytes <= this.maxArtifactBytes) break;
      artifact.retired = true;
      this.collectRetiredArtifacts();
    }
    if (this.retainedArtifactBytes + this.reservedArtifactBytes + bytes > this.maxArtifactBytes) {
      throw new OutputStoreError("output_quota", "retained artifact quota is full");
    }
  }

  private collectRetiredArtifacts(): void {
    for (const [handle, artifact] of this.artifactsByHandle) {
      if (!artifact.retired || artifact.pins > 0 || this.hasArtifactReference(artifact)) continue;
      this.artifactsByHandle.delete(handle);
      this.retainedArtifactBytes -= artifact.bytes;
      try { unlinkSync(artifact.path); } catch { /* already removed */ }
    }
  }

  private decodeSvg(value: string): Buffer {
    this.assertMIMEInput(value);
    return Buffer.from(value, "utf8");
  }

  private assertMIMEInput(value: string): void {
    if (hasUnpairedSurrogate(value)) {
      throw new OutputStoreError("output_invalid", "MIME output must contain valid Unicode");
    }
    if (byteLength(value) > OUTPUT_RECORD_MAX_BYTES) {
      throw new OutputStoreError("output_quota", "MIME output exceeds the 8 MiB envelope");
    }
  }

  private nextSequence(identity: OutputIdentity): number {
    return this.nextSequenceByOwner.get(outputOwnerKey(identity)) ?? 1;
  }

  private async withArtifactWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertScope(identity: OutputScope): void {
    if (!identity || !safeId(identity.sessionEpoch) || identity.sessionEpoch !== this.sessionEpoch ||
        !isRevision(identity.documentRevision) || identity.documentRevision > this.documentRevision ||
        (identity.cellId === null
          ? identity.revision !== null
          : !safeId(identity.cellId) || identity.revision === null || !isRevision(identity.revision)) ||
        (identity.kernelEpoch !== null && !safeId(identity.kernelEpoch)) ||
        (identity.runId !== null && !safeId(identity.runId)) ||
        (identity.kernelEpoch === null && identity.runId !== null)) {
      throw new OutputStoreError("stale_value", "output scope is stale or incomplete");
    }
    if (identity.kernelEpoch !== null && identity.kernelEpoch !== this.kernelEpoch) {
      throw new OutputStoreError("stale_value", "output scope belongs to a stale kernel epoch");
    }
  }

  private assertStaticScope(identity: OutputScope): asserts identity is StaticOutputScope {
    if (!identity || !safeId(identity.sessionEpoch) || identity.sessionEpoch !== this.sessionEpoch ||
        !isRevision(identity.documentRevision) || identity.kernelEpoch !== null ||
        identity.runId !== null || identity.cellId !== null || identity.revision !== null) {
      throw new OutputStoreError("stale_value", "static output scope is stale or not runtime-free");
    }
  }

  private assertIdentity(identity: OutputIdentity, allowStatic: boolean): void {
    this.assertScope(identity);
    if (!safeId(identity.cellId) || !isRevision(identity.revision) ||
        !pairedIdentity(identity.kernelEpoch, identity.runId) ||
        (!allowStatic && (identity.kernelEpoch === null || identity.runId === null))) {
      throw new OutputStoreError("stale_value", "output identity is stale or incomplete");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new OutputStoreError("output_expired", "output store is closed");
  }
}

/** Collect descriptor objects only from artifact-bearing rich output fields. */
export function collectArtifactHandles(value: unknown, result: ArtifactHandle[] = []): ArtifactHandle[] {
  const seen = new Set<unknown>();
  collectArtifactHandlesInner(value, result, seen, 0, false);
  return result;
}

function collectArtifactHandlesInner(value: unknown, result: ArtifactHandle[], seen: Set<unknown>, depth: number, artifactField: boolean): void {
  if (depth > MAX_COLLECTION_DEPTH) return;
  if (artifactField) {
    if (isArtifactHandle(value) && !result.some((entry) => entry.handle === value.handle)) result.push(value);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of value) collectArtifactHandlesInner(child, result, seen, depth + 1, false);
    return;
  }
  if (!isPlainRecord(value) || seen.has(value)) return;
  seen.add(value);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  if (kind === "image" || kind === "html" || kind === "media") {
    collectArtifactHandlesInner(value.artifact, result, seen, depth + 1, true);
  } else if (kind === "layout") {
    collectArtifactHandlesInner(value.children, result, seen, depth + 1, false);
  } else if (kind === "lazy") {
    collectArtifactHandlesInner(value.child, result, seen, depth + 1, false);
  }
}

function invalidBase64(): never {
  throw new OutputStoreError("output_invalid", "invalid or non-canonical base64 output");
}

// Ark emits RFC 4648 standard-alphabet plot bytes without optional padding.
function decodeBase64(value: string): Buffer {
  const maximumBodyLength = Math.ceil(OUTPUT_RECORD_MAX_BYTES * 4 / 3);
  if (typeof value !== "string" || value.length === 0) invalidBase64();
  if (value.length > maximumBodyLength + 2) {
    throw new OutputStoreError("output_quota", "binary output exceeds the 8 MiB envelope");
  }

  let bodyLength = value.length;
  let paddingLength = 0;
  while (bodyLength > 0 && value.charCodeAt(bodyLength - 1) === 61) {
    bodyLength -= 1;
    paddingLength += 1;
  }
  if (bodyLength === 0 || paddingLength > 2 || bodyLength % 4 === 1) invalidBase64();
  const expectedPadding = (4 - bodyLength % 4) % 4;
  if (paddingLength !== 0 && paddingLength !== expectedPadding) invalidBase64();
  if (bodyLength > maximumBodyLength) {
    throw new OutputStoreError("output_quota", "binary output exceeds the 8 MiB envelope");
  }

  for (let index = 0; index < bodyLength; index += 1) {
    if (base64Sextet(value.charCodeAt(index)) < 0) invalidBase64();
  }
  if (bodyLength % 4 === 2) {
    if ((base64Sextet(value.charCodeAt(bodyLength - 1)) & 0x0f) !== 0) invalidBase64();
  } else if (bodyLength % 4 === 3) {
    if ((base64Sextet(value.charCodeAt(bodyLength - 1)) & 0x03) !== 0) invalidBase64();
  }

  const expectedByteLength = Math.floor(bodyLength / 4) * 3 +
    (bodyLength % 4 === 2 ? 1 : bodyLength % 4 === 3 ? 2 : 0);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedByteLength) invalidBase64();
  if (bytes.byteLength > OUTPUT_RECORD_MAX_BYTES) {
    throw new OutputStoreError("output_quota", "binary output exceeds the 8 MiB envelope");
  }
  return bytes;
}

function base64Sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function boundedText(value: string, maximumBytes: number): string {
  if (byteLength(value) <= maximumBytes) return value;
  const suffix = "\n[output truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maximumBytes <= suffixBytes) return utf8Prefix(value, maximumBytes);
  return utf8Prefix(value, maximumBytes - suffixBytes) + suffix;
}

function boundedPreview(value: unknown): string {
  let json: string;
  try { json = JSON.stringify(value) ?? "null"; } catch { json = "[unserializable]"; }
  return boundedText(json, OUTPUT_PREVIEW_MAX_BYTES);
}

function hasTruncation(value: unknown): boolean {
  return isPlainRecord(value) && (value.truncated === true || value.truncated_rows === true || value.truncated_columns === true);
}

function isArtifactHandle(value: unknown): value is ArtifactHandle {
  if (!isPlainRecord(value) || !protocolJsonSchema.safeParse(value).success || !safeHandle(value.handle)) return false;
  const parsed = artifactHandleSchema.safeParse(value);
  return parsed.success && value.chunkBytes === OUTPUT_ARTIFACT_CHUNK_BYTES &&
    isRevision(value.byteLength) && value.byteLength <= OUTPUT_ARTIFACT_QUOTA_BYTES &&
    safeId(value.epoch) && safeMime(value.mimeType) && isRevision(value.documentRevision) &&
    (value.kernelEpoch === null || safeId(value.kernelEpoch));
}


function strictJsonInput(value: unknown, message: string): JsonValue {
  const parsed = protocolJsonSchema.safeParse(value);
  if (!parsed.success) throw new OutputStoreError("output_invalid", message);
  return parsed.data;
}


function isPlainRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, depth = 0, seen = new Set<unknown>()): value is JsonValue {
  if (depth > MAX_COLLECTION_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((entry) => isJsonValue(entry, depth + 1, seen));
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1, seen));
  }
  return false;
}

function cloneJson<T>(value: T, depth = 0): T {
  if (depth > MAX_COLLECTION_DEPTH) throw new OutputStoreError("output_invalid", "JSON value exceeds the depth limit");
  if (isArtifactHandle(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry, depth + 1)) as T;
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJson(entry, depth + 1);
    return result as T;
  }
  return value;
}

function freezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) freezeJson(child);
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    return Object.freeze(value);
  }
  return value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= 256 &&
    !hasUnpairedSurrogate(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeHandle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= MAX_ARTIFACT_HANDLE_BYTES &&
    safeId(value) && !/[\\/]/.test(value) && !value.includes("..") && !value.startsWith(".");
}

function safeMime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= MAX_MIME_BYTES &&
    !hasUnpairedSurrogate(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeExtension(value: string): string {
  if (typeof value !== "string" || byteLength(value) > MAX_ARTIFACT_EXTENSION_BYTES ||
      !/^\.[A-Za-z0-9]{1,12}$/.test(value)) return ".bin";
  return value.toLowerCase();
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(maximumBytes, bytes.byteLength);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function sameSourceStat(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function pairedIdentity(kernelEpoch: string | null, runId: string | null): boolean {
  return (kernelEpoch === null) === (runId === null) &&
    (kernelEpoch === null || (safeId(kernelEpoch) && safeId(runId)));
}

function outputOwnerKey(value: Pick<OutputScope, "sessionEpoch" | "documentRevision" | "kernelEpoch" | "runId" | "cellId" | "revision">): string {
  return JSON.stringify([
    value.sessionEpoch,
    value.documentRevision,
    value.kernelEpoch,
    value.runId,
    value.cellId,
    value.revision,
  ]);
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new OutputStoreError("output_invalid", "output is not JSON serializable");
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("..") && !isAbsolute(relativePath));
}


function extensionForMime(mimeType: string, name = ""): string {
  const fromName = /\.[A-Za-z0-9]{1,12}$/.exec(name)?.[0];
  if (fromName !== undefined) return normalizeExtension(fromName);
  switch (mimeType.toLowerCase()) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/svg+xml": return ".svg";
    case "text/html": return ".html";
    case "audio/wav": return ".wav";
    case "video/mp4": return ".mp4";
    case "application/pdf": return ".pdf";
    default: return ".bin";
  }
}

function mimeForArtifact(name: string): string {
  const extension = name.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1];
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "svg": return "image/svg+xml";
    case "html":
    case "htm": return "text/html";
    case "wav": return "audio/wav";
    case "mp4": return "video/mp4";
    case "pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function requiresAsyncRawNormalization(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "html" && typeof value.html === "string" && value.artifact === undefined) return true;
  return containsStringArtifact(value, new Set(), 0, true);
}

function containsStringArtifact(value: unknown, seen: Set<unknown>, depth: number, richNode: boolean): boolean {
  if (depth > MAX_COLLECTION_DEPTH) return false;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((entry) => containsStringArtifact(entry, seen, depth + 1, richNode));
  }
  if (!isPlainRecord(value) || seen.has(value)) return false;
  seen.add(value);
  const kind = richNode && typeof value.kind === "string" ? value.kind : undefined;
  if (kind === "markdown" && typeof value.text === "string" && typeof value.html !== "string") return true;
  if ((kind === "image" || kind === "html" || kind === "media") && typeof value.artifact === "string") return true;
  for (const [key, entry] of Object.entries(value)) {
    const childRich = richNode && ((kind === "layout" && key === "children") || (kind === "lazy" && key === "child"));
    if (childRich && containsStringArtifact(entry, seen, depth + 1, true)) return true;
  }
  return false;
}

function createArtifactManifest(descriptor: ArtifactHandle, extension: string): ArtifactManifest {
  const entry = artifactResourceNameSchema.parse("artifact" + extension);
  const resources: Record<string, ArtifactHandle> = Object.create(null);
  resources[entry] = descriptor;
  return Object.freeze({ entry, resources: Object.freeze(resources) });
}
