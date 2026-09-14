import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open as openFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { ensurePrivateDirectory, readPrivateFile, securePrivateFile, verifyPrivateFile, writePrivateFile, PrivatePathError, type PrivatePathOptions } from "./private-paths.js";
import { canonicalBase64ByteLength, MAX_NOTEBOOK_CELLS, MAX_NOTEBOOK_SOURCE_BYTES, sidecarObservationsSchema } from "./protocol.js";
/**
 * Recovery persistence validates sidecar observations through the protocol-owned
 * schema while keeping filesystem recovery independent of host runtime state.
 * The local disk observation type also carries optional identity/mode checks.
 */
export type RecoveryJsonValue =
  | null
  | boolean
  | number
  | string
  | RecoveryJsonValue[]
  | { [key: string]: RecoveryJsonValue };
export type RecoveryJsonObject = { [key: string]: RecoveryJsonValue };

export interface RecoverySidecarObservations {
  config: DiskObservation;
  layout: DiskObservation;
  packages: DiskObservation;
}

export interface DiskObservation {
  state: "untitled" | "absent" | "present" | "unreadable";
  digest?: string | null;
  version?: string | null;
  error?: RecoveryJsonValue | null;
  identity?: string | null;
  mode?: number;
}

type ObservationFingerprint = {
  state: DiskObservation["state"];
  digest?: string | null;
  version?: string | null;
  identity?: string | null;
  mode?: number;
};

/** A source delta carries exact physical bytes and semantic identities, never R code. */
export interface RecoveryCellState {
  readonly id: string;
  readonly revision: number;
}

export interface RecoveryByteCopy {
  readonly kind: "copy";
  readonly offset: number;
  readonly length: number;
}

export interface RecoveryByteLiteral {
  readonly kind: "literal";
  readonly data: string;
}

export type RecoveryBytePiece = RecoveryByteCopy | RecoveryByteLiteral;

/** Runtime-free source patch over the prior exact physical bytes. */
export interface RecoverySourceDelta {
  readonly kind: "source";
  readonly baseLength: number;
  readonly baseSha256: string;
  readonly resultLength: number;
  readonly resultSha256: string;
  readonly pieces: readonly RecoveryBytePiece[];
  readonly cells: readonly RecoveryCellState[];
  readonly path?: string | null;
  readonly project?: RecoveryJsonValue;
  readonly config?: RecoveryJsonValue;
  readonly layout?: RecoveryJsonValue;
  readonly packageDeclarationIntent?: RecoveryJsonValue;
  readonly notebookDiskObservation: DiskObservation;
  readonly sidecarObservations: RecoverySidecarObservations;
}

export type RecoveryDelta = RecoverySourceDelta;

/** Exact source bytes and the ordered semantic cell identity projection. */
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

export interface RecoveryRecord {
  schemaVersion: 1;
  fromRevision: number;
  toRevision: number;
  delta: RecoveryDelta;
  sha256: string;
}

/** Input intentionally names the caller's disk fingerprint; sha256 is writer-owned. */
export interface RecoveryAppend {
  schemaVersion: 1;
  fromRevision: number;
  toRevision: number;
  delta: RecoveryDelta;
  fingerprint?: string;
}

export interface RecoveryCheckpoint {
  readonly notebookDiskObservation: DiskObservation;
  readonly sidecarObservations: RecoverySidecarObservations;
}

export type RecoveryStatus = "empty" | "clean" | "recovered" | "tail-discarded";

export interface RecoveryBranch {
  /** Stable branch identity; independent from on-disk generation names. */
  readonly id: string;
  readonly documentRevision: number;
  readonly status: RecoveryStatus;
  readonly fingerprint: string;
}

export interface RecoveryState {
  schemaVersion: 1;
  generation: string | null;
  baseline: RecoveryBaseline;
  records: readonly RecoveryRecord[];
  documentRevision: number;
  status: RecoveryStatus;
  fingerprint: string | null;
  branches: readonly RecoveryBranch[];
}

export interface RecoveryRebindTarget {
  readonly rootDir: string;
  readonly key: string;
  readonly baseline: RecoveryBaseline;
}

export interface PreparedRecoveryRebind {
  readonly writer: RecoveryWriter;
  readonly state: RecoveryState;
  publish(): Promise<void>;
  adopt(): void;
  abort(): Promise<void>;
}
export interface RecoveryBranchFork {
  readonly id?: string;
  readonly baseline?: RecoveryBaseline;
}

export interface RecoveryBranchDropExpected {
  readonly documentRevision: number;
  readonly fingerprint: string;
}


export interface RecoveryLimits {
  /** Maximum canonical baseline envelope bytes. */
  maxBaselineBytes?: number;
  /** Maximum complete log bytes, including four-byte frame lengths. */
  maxLogBytes?: number;
  /** Maximum canonical record payload bytes. */
  maxRecordBytes?: number;
  /** Maximum records in one generation. */
  maxRecords?: number;
  /** Maximum canonical delta bytes. */
  maxDeltaBytes?: number;
}

export interface RecoveryWriterOptions {
  /** Owner-only user-data root. A key-specific directory is derived below it. */
  rootDir: string;
  /** Stable notebook/project identity; never written in clear text. */
  key: string;
  /** Initial complete runtime-free baseline. Used only when no generation exists. */
  baseline: RecoveryBaseline;
  limits?: RecoveryLimits;
  /** Bundled supervisor used to enforce Windows private state ACLs. */
  processSupervisorExecutable?: string | null;
}
export type RecoveryErrorCode =
  | "recovery_corrupt"
  | "recovery_write_failed"
  | "recovery_limit"
  | "recovery_invalid"
  | "recovery_closed";

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  readonly details: RecoveryJsonValue | null;
  /** Paths of the untouched source files involved in a recovery failure. */
  readonly originals: readonly string[];

  constructor(
    code: RecoveryErrorCode,
    message: string,
    details: RecoveryJsonValue | null = null,
    originals: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RecoveryError";
    this.code = code;
    this.details = details;
    this.originals = [...originals];
  }
}

const SCHEMA_VERSION = 1 as const;
const POINTER_FILE = "current.json";
const RECOVERY_KEY_FILE = "recovery.key";
const BRANCH_INDEX_FILE = "branches.json";
const BASELINE_PREFIX = "baseline-";
const BASELINE_SUFFIX = ".json";
const LOG_PREFIX = "log-";
const LOG_SUFFIX = ".bin";
const DEFAULT_LIMITS: Required<RecoveryLimits> = {
  maxBaselineBytes: 128 * 1024 * 1024,
  maxLogBytes: 128 * 1024 * 1024,
  maxRecordBytes: 128 * 1024 * 1024,
  maxRecords: 100_000,
  maxDeltaBytes: 128 * 1024 * 1024,
};
const MAX_PATCH_PIECES = 1_000_000;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_KEY_BYTES = 4_096;
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CANONICAL_DEPTH = 128;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
type FileHandleLike = Awaited<ReturnType<typeof openFile>>;
type InternalStatus = RecoveryStatus | "corrupt";

interface GenerationPointer {
  schemaVersion: 1;
  keyHash: string;
  generation: string | null;
}

interface BranchIndexEntry {
  id: string;
  generation: string;
  documentRevision: number;
  status: RecoveryStatus;
  fingerprint: string;
}

function sameBranchEntry(left: BranchIndexEntry, right: BranchIndexEntry): boolean {
  return left.id === right.id && left.generation === right.generation
    && left.documentRevision === right.documentRevision && left.status === right.status
    && left.fingerprint === right.fingerprint;
}

function sameBranchEntries(left: readonly BranchIndexEntry[], right: readonly BranchIndexEntry[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = left.slice().sort((a, b) => a.id.localeCompare(b.id));
  const orderedRight = right.slice().sort((a, b) => a.id.localeCompare(b.id));
  return orderedLeft.every((entry, index) => sameBranchEntry(entry, orderedRight[index]!));
}

interface BranchIndexEnvelope {
  schemaVersion: 1;
  branches: readonly BranchIndexEntry[];
}

interface ParsedLog {
  records: RecoveryRecord[];
  tailDiscarded: boolean;
  logBytes: number;
}

interface GenerationData {
  generation: string;
  baseline: RecoveryBaseline;
  records: RecoveryRecord[];
  tailDiscarded: boolean;
  baselineBytes: number;
  logBytes: number;
}

interface CandidateGeneration {
  generation: string;
  baselinePath: string;
  logPath: string;
  modified: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function binaryBase64(value: Uint8Array | ArrayBuffer): string {
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("base64");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

function base64ByteLength(value: string, field: string): number {
  const length = canonicalBase64ByteLength(value);
  if (length === null) throw invalid(field + " is not canonical base64");
  return length;
}

function decodeBase64(value: string, field: string): Uint8Array {
  const expected = base64ByteLength(value, field);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expected) {
    throw invalid(field + " is not canonical base64");
  }
  return bytes;
}

function physicalSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function baselinePhysicalSha256(baseline: RecoveryBaseline): string {
  return physicalSha256(decodeBase64(baseline.physicalBytes as string, "baseline.physicalBytes"));
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function invalid(message: string, details: RecoveryJsonValue | null = null): RecoveryError {
  return new RecoveryError("recovery_invalid", message, details);
}

function limitFailure(message: string, details: RecoveryJsonValue | null = null): RecoveryError {
  return new RecoveryError("recovery_limit", message, details);
}

function writeFailure(
  message: string,
  cause: unknown,
  originals: readonly string[] = [],
): RecoveryError {
  return new RecoveryError("recovery_write_failed", message, null, originals, cause);
}

function corrupt(
  message: string,
  details: RecoveryJsonValue | null,
  originals: readonly string[],
): RecoveryError {
  return new RecoveryError("recovery_corrupt", message, details, originals);
}

function validateCanonicalString(value: string): void {
  if (hasUnpairedSurrogate(value)) throw invalid("recovery JSON contains an unpaired surrogate");
}

function canonicalEncode(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > MAX_CANONICAL_DEPTH) throw invalid("recovery JSON exceeds maximum nesting depth");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string":
      validateCanonicalString(value);
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw invalid("recovery JSON contains a non-finite number");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw invalid("recovery JSON contains a value that cannot be persisted");
    default:
      break;
  }
  const reference = value as object;
  if (seen.has(reference)) throw invalid("recovery JSON contains a cycle");
  seen.add(reference);
  try {
    if (isBinary(value)) return canonicalEncode({ $bytes: binaryBase64(value) }, depth + 1, seen);
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalEncode(item, depth + 1, seen)).join(",")}]`;
    }
    if (!isRecord(value)) throw invalid("recovery JSON contains an unsupported object");
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      validateCanonicalString(key);
      return `${JSON.stringify(key)}:${canonicalEncode(value[key], depth + 1, seen)}`;
    }).join(",")}}`;
  } finally {
    seen.delete(reference);
  }
}

/** Canonical JSON is exported for deterministic test/controller framing. */
export function canonicalRecoveryJson(value: unknown): string {
  return canonicalEncode(value);
}

/** SHA-256 over canonical JSON, represented as lowercase hexadecimal. */
export function recoverySha256(value: unknown): string {
  return createHash("sha256").update(canonicalRecoveryJson(value), "utf8").digest("hex");
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw invalid(`${what} is not valid UTF-8`, { what });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (canonicalEncode(parsed) !== text) throw invalid(`${what} is not canonical JSON`, { what });
    return parsed;
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw invalid(`${what} is not valid JSON`, { what });
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(canonicalEncode(value)) as T;
}

function forbiddenRecoveryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return normalized === "runtime"
    || normalized === "runtimestate"
    || normalized === "executionstate"
    || normalized === "kernelstate"
    || normalized === "analyzerstate"
    || normalized === "engineidentity"
    || normalized === "output"
    || normalized === "outputs"
    || normalized === "outputstate"
    || normalized === "secret"
    || normalized === "secrets"
    || normalized === "token"
    || normalized === "tokens"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized === "password"
    || normalized === "authorization"
    || normalized === "environment";
}
function normalizeWireValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  keyHint = "",
): RecoveryJsonValue {
  if (depth > MAX_CANONICAL_DEPTH) throw invalid("recovery value exceeds maximum nesting depth");
  if (value === null) return null;
  if (typeof value === "string") {
    validateCanonicalString(value);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("recovery value contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw invalid("recovery value is not JSON-safe");
  const reference = value as object;
  if (seen.has(reference)) throw invalid("recovery value contains a cycle");
  seen.add(reference);
  try {
    if (isBinary(value)) {
      // Bytes in physical projections are intentionally a compact base64 string;
      // other typed bytes retain an explicit tag so they cannot become R data.
      return keyHint.toLowerCase().includes("byte") || keyHint === "data"
        ? binaryBase64(value)
        : { $bytes: binaryBase64(value) };
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalizeWireValue(item, depth + 1, seen, keyHint));
    }
    if (!isRecord(value)) throw invalid("recovery value contains an unsupported object");
    const result: RecoveryJsonObject = Object.create(null);
    for (const key of Object.keys(value)) {
      validateCanonicalString(key);
      if (forbiddenRecoveryKey(key)) throw invalid(`recovery value contains forbidden field ${key}`);
      const item = value[key];
      if (item === undefined) throw invalid(`recovery value contains undefined field ${key}`);
      result[key] = normalizeWireValue(item, depth + 1, seen, key);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${name} must be a positive safe integer`);
  return value;
}

function normalizeLimits(input: RecoveryLimits | undefined): Required<RecoveryLimits> {
  return {
    maxBaselineBytes: positiveLimit(input?.maxBaselineBytes, DEFAULT_LIMITS.maxBaselineBytes, "maxBaselineBytes"),
    maxLogBytes: positiveLimit(input?.maxLogBytes, DEFAULT_LIMITS.maxLogBytes, "maxLogBytes"),
    maxRecordBytes: positiveLimit(input?.maxRecordBytes, DEFAULT_LIMITS.maxRecordBytes, "maxRecordBytes"),
    maxRecords: positiveLimit(input?.maxRecords, DEFAULT_LIMITS.maxRecords, "maxRecords"),
    maxDeltaBytes: positiveLimit(input?.maxDeltaBytes, DEFAULT_LIMITS.maxDeltaBytes, "maxDeltaBytes"),
  };
}

const SMALL_LOG_FLOOR_BYTES = 64 * 1024;

function baselineCompactionThreshold(baselineBytes: number): number {
  return Math.max(baselineBytes, SMALL_LOG_FLOOR_BYTES);
}

function shouldCompact(
  limits: Required<RecoveryLimits>,
  baselineBytes: number,
  recordCount: number,
  logBytes: number,
  nextFrameBytes: number,
): boolean {
  if (recordCount === 0) return false;
  return logBytes >= baselineCompactionThreshold(baselineBytes)
    || logBytes + nextFrameBytes > limits.maxLogBytes
    || recordCount + 1 > limits.maxRecords;
}

function validateRevision(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a non-negative safe integer`);
  }
}

function validateFingerprint(value: unknown, name = "fingerprint"): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || hasUnpairedSurrogate(value)) {
    throw invalid(`${name} must be a bounded non-empty string`);
  }
}

function validateBranchId(value: unknown, name = "branch id"): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || Buffer.byteLength(value, "utf8") > 256 || hasUnpairedSurrogate(value)
    || /[\u0000-\u001f\u007f\r\n\\/]/.test(value)) {
    throw invalid(name + " is invalid");
  }
}

/** Compare a recovery baseline observation with a fresh disk observation. */
export function recoveryObservationMatches(expected: ObservationFingerprint, actual: ObservationFingerprint): boolean {
  if (expected.state === "unreadable" || actual.state === "unreadable") return false;
  return expected.state === actual.state
    && expected.digest === actual.digest
    && expected.version === actual.version
    && expected.identity === actual.identity
    && expected.mode === actual.mode;
}
function validateObservation(value: unknown, field: string): void {
  if (!isRecord(value)) throw invalid(`${field} is not a DiskObservation`);
  const states = new Set(["untitled", "absent", "present", "unreadable"]);
  if (typeof value.state !== "string" || !states.has(value.state)) throw invalid(`${field}.state is invalid`);
  if (value.state === "present") {
    if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) throw invalid(`${field}.digest is invalid`);
    if (typeof value.version !== "string" || value.version.length === 0 || value.version.length > 1024 || hasUnpairedSurrogate(value.version)) throw invalid(`${field}.version is invalid`);
    if (value.error !== null && value.error !== undefined) throw invalid(`${field}.error is invalid`);
  } else {
    if (value.digest !== null || value.version !== null) throw invalid(`${field} must have null digest and version`);
    if (value.state === "unreadable" && !isRecord(value.error)) throw invalid(`${field}.error is invalid`);
    if (value.state !== "unreadable" && value.error !== null && value.error !== undefined) throw invalid(`${field}.error is invalid`);
  }
  if (value.identity !== undefined && value.identity !== null && typeof value.identity !== "string") throw invalid(`${field}.identity is invalid`);
  if (value.mode !== undefined && (typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) || value.mode < 0)) throw invalid(`${field}.mode is invalid`);
}

function normalizeCellStates(value: unknown, field: string): RecoveryCellState[] {
  if (!Array.isArray(value) || value.length > MAX_NOTEBOOK_CELLS) {
    throw invalid(field + " must contain at most " + MAX_NOTEBOOK_CELLS + " cells");
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "id,revision") {
      throw invalid(field + "[" + index + "] is invalid");
    }
    const id = item.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || hasUnpairedSurrogate(id)
      || /[\u0000-\u001f\u007f\r\n]/.test(id)) {
      throw invalid(field + "[" + index + "].id is invalid");
    }
    if (ids.has(id)) throw invalid(field + " contains duplicate cell IDs");
    ids.add(id);
    validateRevision(item.revision, field + "[" + index + "].revision");
    return { id, revision: item.revision };
  });
}

const BASELINE_KEYS = new Set([
  "schemaVersion", "documentRevision", "physicalBytes", "cells", "path", "project", "config", "layout",
  "packageDeclarationIntent", "notebookDiskObservation", "sidecarObservations",
]);

function normalizeBaseline(input: unknown, limits: Required<RecoveryLimits>): RecoveryBaseline {
  if (!isRecord(input)) throw invalid("recovery baseline must be an object");
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw invalid("recovery baseline has an unsupported schemaVersion");
  }
  const raw = normalizeWireValue({ ...input, schemaVersion: SCHEMA_VERSION }) as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!BASELINE_KEYS.has(key)) throw invalid("baseline field " + key + " is unsupported");
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) throw invalid("recovery baseline has an unsupported schemaVersion");
  validateRevision(raw.documentRevision, "baseline.documentRevision");
  if (typeof raw.physicalBytes !== "string") throw invalid("baseline.physicalBytes must be base64 bytes");
  const physicalLength = base64ByteLength(raw.physicalBytes, "baseline.physicalBytes");
  if (physicalLength > MAX_NOTEBOOK_SOURCE_BYTES) {
    throw limitFailure("recovery baseline source exceeds its byte limit", { limit: MAX_NOTEBOOK_SOURCE_BYTES });
  }
  const cells = normalizeCellStates(raw.cells, "baseline.cells");
  if (!Object.hasOwn(raw, "notebookDiskObservation")) throw invalid("baseline.notebookDiskObservation is required");
  validateObservation(raw.notebookDiskObservation, "baseline.notebookDiskObservation");
  if (!Object.hasOwn(raw, "sidecarObservations")) throw invalid("baseline.sidecarObservations is required");
  try {
    sidecarObservationsSchema.parse(raw.sidecarObservations);
  } catch {
    throw invalid("baseline.sidecarObservations does not match the protocol schema");
  }
  if (raw.path !== undefined && raw.path !== null && typeof raw.path !== "string") {
    throw invalid("baseline.path must be a string or null");
  }
  const normalized = { ...raw, physicalBytes: raw.physicalBytes, cells } as unknown as RecoveryBaseline;
  const encoded = canonicalEncode({ kind: "baseline", ...normalized });
  if (Buffer.byteLength(encoded, "utf8") > limits.maxBaselineBytes) {
    throw limitFailure("recovery baseline exceeds its byte limit", { limit: limits.maxBaselineBytes });
  }
  return normalized;
}

function storedBaseline(baseline: RecoveryBaseline): { kind: "baseline" } & RecoveryBaseline {
  return { kind: "baseline", ...baseline };
}


const SOURCE_DELTA_KEYS = new Set([
  "kind", "baseLength", "baseSha256", "resultLength", "resultSha256", "pieces", "cells", "path", "project",
  "config", "layout", "packageDeclarationIntent", "notebookDiskObservation", "sidecarObservations",
]);

function boundedSourceLength(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_NOTEBOOK_SOURCE_BYTES) {
    throw invalid(field + " is outside the notebook source byte limit");
  }
  return value;
}

function normalizeSourceDelta(input: unknown): RecoverySourceDelta {
  const raw = normalizeWireValue(input) as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!SOURCE_DELTA_KEYS.has(key)) throw invalid("recovery source delta field " + key + " is unsupported");
  }
  if (raw.kind !== "source") throw invalid("recovery delta must be a source patch");
  const baseLength = boundedSourceLength(raw.baseLength, "recovery delta.baseLength");
  const resultLength = boundedSourceLength(raw.resultLength, "recovery delta.resultLength");
  if (typeof raw.baseSha256 !== "string" || !SHA256.test(raw.baseSha256)) throw invalid("recovery delta.baseSha256 is invalid");
  if (typeof raw.resultSha256 !== "string" || !SHA256.test(raw.resultSha256)) throw invalid("recovery delta.resultSha256 is invalid");
  if (!Array.isArray(raw.pieces) || raw.pieces.length > MAX_PATCH_PIECES) throw invalid("recovery delta.pieces is invalid");
  let produced = 0;
  const pieces: RecoveryBytePiece[] = raw.pieces.map((value, index) => {
    if (!isRecord(value) || typeof value.kind !== "string") throw invalid("recovery delta.pieces[" + index + "] is invalid");
    if (value.kind === "copy") {
      if (Object.keys(value).sort().join(",") !== "kind,length,offset") throw invalid("recovery delta copy piece is invalid");
      const offset = boundedSourceLength(value.offset, "recovery delta copy offset");
      const length = boundedSourceLength(value.length, "recovery delta copy length");
      if (offset > baseLength || length > baseLength - offset) throw invalid("recovery delta copy range is outside its base");
      produced += length;
      if (produced > resultLength) throw invalid("recovery delta pieces exceed resultLength");
      return { kind: "copy", offset, length };
    }
    if (value.kind === "literal") {
      if (Object.keys(value).sort().join(",") !== "data,kind" || typeof value.data !== "string") {
        throw invalid("recovery delta literal piece is invalid");
      }
      const length = base64ByteLength(value.data, "recovery delta literal data");
      if (length > MAX_NOTEBOOK_SOURCE_BYTES - produced) throw invalid("recovery delta pieces exceed the source byte limit");
      produced += length;
      if (produced > resultLength) throw invalid("recovery delta pieces exceed resultLength");
      return { kind: "literal", data: value.data };
    }
    throw invalid("recovery delta piece kind is unsupported");
  });
  if (produced !== resultLength) throw invalid("recovery delta pieces do not produce resultLength");
  const cells = normalizeCellStates(raw.cells, "recovery delta.cells");
  if (!Object.hasOwn(raw, "notebookDiskObservation")) throw invalid("recovery delta.notebookDiskObservation is required");
  validateObservation(raw.notebookDiskObservation, "recovery delta.notebookDiskObservation");
  if (!Object.hasOwn(raw, "sidecarObservations")) throw invalid("recovery delta.sidecarObservations is required");
  try {
    sidecarObservationsSchema.parse(raw.sidecarObservations);
  } catch {
    throw invalid("recovery delta.sidecarObservations does not match the protocol schema");
  }
  if (raw.path !== undefined && raw.path !== null && typeof raw.path !== "string") throw invalid("recovery delta.path is invalid");
  const normalized = { ...raw, baseLength, resultLength, pieces, cells } as unknown as RecoverySourceDelta;
  return normalized;
}

function unsignedRecord(record: RecoveryAppend | RecoveryRecord, delta: RecoverySourceDelta): {
  schemaVersion: 1;
  fromRevision: number;
  toRevision: number;
  delta: RecoverySourceDelta;
} {
  return {
    schemaVersion: SCHEMA_VERSION,
    fromRevision: record.fromRevision,
    toRevision: record.toRevision,
    delta,
  };
}

function encodeRecord(record: RecoveryAppend | RecoveryRecord, limits: Required<RecoveryLimits>): { record: RecoveryRecord; payload: Buffer } {
  const delta = normalizeSourceDelta(record.delta);
  const unsigned = unsignedRecord(record, delta);
  const deltaBytes = Buffer.byteLength(canonicalEncode(delta), "utf8");
  if (deltaBytes > limits.maxDeltaBytes) {
    throw limitFailure("recovery delta exceeds its byte limit", { limit: limits.maxDeltaBytes });
  }
  const encodedRecord: RecoveryRecord = {
    schemaVersion: SCHEMA_VERSION,
    fromRevision: record.fromRevision,
    toRevision: record.toRevision,
    delta,
    sha256: recoverySha256(unsigned),
  };
  const payloadText = canonicalEncode(encodedRecord);
  const payload = Buffer.from(payloadText, "utf8");
  if (payload.length === 0 || payload.length > limits.maxRecordBytes) {
    throw limitFailure("recovery record exceeds its byte limit", { limit: limits.maxRecordBytes });
  }
  return { record: encodedRecord, payload };
}

function frame(payload: Buffer): Buffer {
  if (payload.length > 0xffffffff) throw limitFailure("recovery frame exceeds uint32 length");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload], header.length + payload.length);
}

function expectedRecordKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === 5
    && keys[0] === "delta"
    && keys[1] === "fromRevision"
    && keys[2] === "schemaVersion"
    && keys[3] === "sha256"
    && keys[4] === "toRevision";
}

function validateStoredRecord(value: unknown, limits: Required<RecoveryLimits>): RecoveryRecord {
  if (!isRecord(value) || !expectedRecordKeys(value)) throw invalid("recovery log record has unexpected fields");
  if (value.schemaVersion !== SCHEMA_VERSION) throw invalid("recovery log record has an unsupported schemaVersion");
  validateRevision(value.fromRevision, "record.fromRevision");
  validateRevision(value.toRevision, "record.toRevision");
  if (value.toRevision <= value.fromRevision) throw invalid("recovery record revisions are not increasing");
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw invalid("recovery record checksum is invalid");
  const normalizedDelta = normalizeSourceDelta(value.delta);
  const deltaBytes = Buffer.byteLength(canonicalEncode(normalizedDelta), "utf8");
  if (deltaBytes > limits.maxDeltaBytes) {
    throw limitFailure("recovery delta exceeds its byte limit", { limit: limits.maxDeltaBytes });
  }
  const unsigned = unsignedRecord(value as unknown as RecoveryRecord, normalizedDelta);
  const record: RecoveryRecord = {
    schemaVersion: SCHEMA_VERSION,
    fromRevision: value.fromRevision,
    toRevision: value.toRevision,
    delta: normalizedDelta,
    sha256: value.sha256,
  };
  if (recoverySha256(unsigned) !== record.sha256) throw invalid("recovery record checksum does not match payload");
  const encoded = canonicalEncode(record);
  if (Buffer.byteLength(encoded, "utf8") > limits.maxRecordBytes) {
    throw limitFailure("recovery record exceeds its byte limit", { limit: limits.maxRecordBytes });
  }
  return record;
}

function generationPaths(directory: string, generation: string): { baselinePath: string; logPath: string } {
  const branch = generation.startsWith("branch-");
  const staged = generation.startsWith("staged-");
  const prefix = branch ? "branch-" : staged ? "staged-" : "";
  const fileGeneration = prefix === "" ? generation : generation.slice(prefix.length);
  const baselinePrefix = branch ? "branch-baseline-" : staged ? "staged-baseline-" : BASELINE_PREFIX;
  const logPrefix = branch ? "branch-log-" : staged ? "staged-log-" : LOG_PREFIX;
  return {
    baselinePath: join(directory, baselinePrefix + fileGeneration + BASELINE_SUFFIX),
    logPath: join(directory, logPrefix + fileGeneration + LOG_SUFFIX),
  };
}

function generationName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function unsupportedDirectorySync(error: unknown): boolean {
  return isRecord(error) && (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EBADF" ||
      (process.platform === "win32" && error.code === "EPERM"));
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandleLike | undefined;
  try {
    handle = await openFile(directory, "r");
    await handle.sync();
  } catch (error) {
    // Linux supports directory fsync. Some supported filesystems/platforms do
    // not; file contents are still fsynced and rename remains same-directory.
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function repairRecoveryRoot(directory: string, privateOptions: PrivatePathOptions): Promise<void> {
  if ((privateOptions.platform ?? process.platform) === "win32") {
    throw new PrivatePathError("private_path_overshared", "recovery root is not private");
  }
  const initial = await lstat(directory, { bigint: true });
  const identity = (info: { dev: number | bigint; ino: number | bigint }): string => String(info.dev) + ":" + String(info.ino);
  const verify = (info: {
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
    uid: number | bigint;
    mode: number | bigint;
    dev: number | bigint;
    ino: number | bigint;
  }, phase: string): void => {
    if (info.isSymbolicLink()) throw new PrivatePathError("private_path_reparse", "recovery root is a symlink (" + phase + ")");
    if (!info.isDirectory()) throw new PrivatePathError("private_path_type", "recovery root is not a directory (" + phase + ")");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && Number(info.uid) !== uid) throw new PrivatePathError("private_path_overshared", "recovery root is not owned by the current user");
  };
  verify(initial, "before");
  const initialIdentity = identity(initial);
  let handle: FileHandleLike | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
    handle = await openFile(directory, flags);
    const opened = await handle.stat({ bigint: true });
    verify(opened, "open");
    if (identity(opened) !== initialIdentity) throw new PrivatePathError("private_path_reparse", "recovery root changed while opening");
    await handle.chmod(0o700);
    const final = await handle.stat({ bigint: true });
    verify(final, "chmod");
    if (identity(final) !== initialIdentity || (Number(final.mode) & 0o077) !== 0) {
      throw new PrivatePathError("private_path_reparse", "recovery root changed while securing");
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
  await ensurePrivateDirectory(directory, privateOptions);
}

async function ensureRecoveryRoot(directory: string, privateOptions: PrivatePathOptions = {}): Promise<void> {
  try {
    await ensureDirectory(directory, 0o700, privateOptions);
  } catch (error) {
    if (!(error instanceof PrivatePathError) || error.code !== "private_path_overshared") throw error;
    await repairRecoveryRoot(directory, privateOptions);
  }
}

async function ensureDirectory(directory: string, _mode: number, privateOptions: PrivatePathOptions = {}): Promise<void> {
  await ensurePrivateDirectory(directory, privateOptions);
}

async function ensureRegularFile(path: string, privateOptions: PrivatePathOptions = {}): Promise<void> {
  await verifyPrivateFile(path, privateOptions);
}

type FileIdentity = { dev: number | bigint; ino: number | bigint };

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

/**
 * Open an already-existing private file without following its leaf symlink.
 * The identity is captured before and after the private-path verification and
 * checked again on the opened handle, so a replacement between any path-based
 * step cannot redirect a later write to a different regular file.
 */
async function openVerifiedFile(
  path: string,
  access: number,
  privateOptions: PrivatePathOptions,
): Promise<FileHandleLike> {
  let handle: FileHandleLike | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    await verifyPrivateFile(path, privateOptions);
    const verified = await lstat(path, { bigint: true });
    if (!sameFileIdentity(before, verified)) {
      throw new PrivatePathError("private_path_reparse", "private path changed while opening: " + path);
    }
    handle = await openFile(path, access | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened)) {
      throw new PrivatePathError("private_path_reparse", "private path changed while opening: " + path);
    }
    return handle;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Create a private destination with kernel-exclusive, no-follow semantics. */
async function createExclusiveFile(path: string, privateOptions: PrivatePathOptions): Promise<FileHandleLike> {
  await ensurePrivateDirectory(dirname(path), privateOptions);
  let handle: FileHandleLike | undefined;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await openFile(path, flags, 0o600);
    const opened = await handle.stat({ bigint: true });
    const observed = await lstat(path, { bigint: true });
    if (!sameFileIdentity(opened, observed)) {
      throw new PrivatePathError("private_path_reparse", "private path changed while creating: " + path);
    }
    await verifyPrivateFile(path, privateOptions);
    const verified = await lstat(path, { bigint: true });
    if (!sameFileIdentity(opened, verified)) {
      throw new PrivatePathError("private_path_reparse", "private path changed while creating: " + path);
    }
    return handle;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    throw error;
  }
}


async function atomicWrite(
  path: string,
  bytes: Uint8Array,
  _mode: number,
  privateOptions: PrivatePathOptions = {},
): Promise<void> {
  await ensurePrivateDirectory(dirname(path), privateOptions);
  await writePrivateFile(path, bytes, privateOptions);
}

async function stageGenerationFiles(
  directory: string,
  baseline: RecoveryBaseline,
  limits: Required<RecoveryLimits>,
  kind: "active" | "branch" | "staged" = "active",
  privateOptions: PrivatePathOptions = {},
): Promise<{ generation: string; baselinePath: string; logPath: string; baselineBytes: number }> {
  const normalized = normalizeBaseline(baseline, limits);
  const generation = (kind === "active" ? "" : kind + "-") + randomUUID();
  const paths = generationPaths(directory, generation);
  const encodedBaseline = Buffer.from(canonicalEncode(storedBaseline(normalized)), "utf8");
  try {
    await atomicWrite(paths.baselinePath, encodedBaseline, 0o600, privateOptions);
    await atomicWrite(paths.logPath, Buffer.alloc(0), 0o600, privateOptions);
  } catch (error) {
    await rm(paths.baselinePath, { force: true }).catch(() => undefined);
    await rm(paths.logPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { generation, ...paths, baselineBytes: encodedBaseline.byteLength };
}

async function readBounded(path: string, limit: number, privateOptions: PrivatePathOptions = {}): Promise<Buffer> {
  try {
    return await readPrivateFile(path, { ...privateOptions, maxBytes: limit });
  } catch (error) {
    if (error instanceof PrivatePathError && error.code === "private_path_too_large") {
      throw limitFailure("recovery file exceeds " + limit + " bytes", { path, limit });
    }
    throw error;
  }
}

async function unlinkGeneration(paths: { baselinePath: string; logPath: string }): Promise<void> {
  await rm(paths.baselinePath, { force: false });
  await rm(paths.logPath, { force: false });
}

async function copyBranchFile(source: string, target: string, privateOptions: PrivatePathOptions = {}): Promise<void> {
  await ensureRegularFile(source, privateOptions);
  await ensurePrivateDirectory(dirname(target), privateOptions);
  try {
    await link(source, target);
    await verifyPrivateFile(target, privateOptions);
    return;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code !== "EXDEV" && code !== "EOPNOTSUPP" && code !== "ENOSYS" && code !== "EPERM") throw error;
  }
  let sourceHandle: FileHandleLike | undefined;
  let targetHandle: FileHandleLike | undefined;
  try {
    sourceHandle = await openVerifiedFile(source, constants.O_RDONLY, privateOptions);
    targetHandle = await createExclusiveFile(target, privateOptions);
    const sourceInfo = await sourceHandle.stat();
    if (!Number.isSafeInteger(sourceInfo.size) || sourceInfo.size < 0) {
      throw new Error("recovery branch source size is invalid");
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sourceOffset = 0;
    let targetOffset = 0;
    while (sourceOffset < sourceInfo.size) {
      const result = await sourceHandle.read(buffer, 0, Math.min(buffer.length, sourceInfo.size - sourceOffset), sourceOffset);
      if (result.bytesRead <= 0) throw new Error("recovery branch source was truncated while copying");
      let written = 0;
      while (written < result.bytesRead) {
        const copy = await targetHandle.write(buffer, written, result.bytesRead - written, targetOffset + written);
        if (copy.bytesWritten <= 0) throw new Error("short recovery branch copy write");
        written += copy.bytesWritten;
      }
      sourceOffset += result.bytesRead;
      targetOffset += result.bytesRead;
    }
    const finalSourceInfo = await sourceHandle.stat();
    if (finalSourceInfo.size !== sourceInfo.size || finalSourceInfo.mtimeMs !== sourceInfo.mtimeMs
      || finalSourceInfo.ctimeMs !== sourceInfo.ctimeMs) {
      throw new Error("recovery branch source changed while copying");
    }
    // The destination must be durable before its containing directory is
    // synced and the staged branch can be published.
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await securePrivateFile(target, privateOptions);
    await verifyPrivateFile(target, privateOptions);
    await syncDirectory(dirname(target));
  } catch (error) {
    if (targetHandle !== undefined) await targetHandle.close().catch(() => undefined);
    if (sourceHandle !== undefined) await sourceHandle.close().catch(() => undefined);
    throw error;
  }
}

function encodeRecoveryKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== RECOVERY_KEY_BYTES) throw corrupt("recovery key has the wrong length", null, []);
  return Buffer.from(bytes).toString("base64url");
}

function decodeRecoveryKey(value: string, path: string): Buffer {
  if (!RECOVERY_KEY_PATTERN.test(value)) throw corrupt("recovery key encoding is invalid", { path }, [path]);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== RECOVERY_KEY_BYTES || bytes.toString("base64url") !== value) {
    throw corrupt("recovery key encoding is invalid", { path }, [path]);
  }
  return bytes;
}

async function verifyRecoveryKeyFile(path: string, privateOptions: PrivatePathOptions): Promise<void> {
  await verifyPrivateFile(path, privateOptions);
  if ((privateOptions.platform ?? process.platform) !== "win32") {
    const info = await lstat(path, { bigint: true });
    if ((Number(info.mode) & 0o777) !== 0o600) throw corrupt("recovery key permissions are not strict", { path }, [path]);
  }
}

async function readRecoveryKeyFile(path: string, privateOptions: PrivatePathOptions): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(path, { ...privateOptions, maxBytes: RECOVERY_KEY_BYTES });
    await verifyRecoveryKeyFile(path, privateOptions);
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    if (error instanceof PrivatePathError) throw corrupt("recovery key is not a private regular file", { path }, [path]);
    throw error;
  }
  if (bytes.byteLength !== RECOVERY_KEY_BYTES) throw corrupt("recovery key has the wrong length", { path }, [path]);
  return bytes;
}

async function createRecoveryKeyFile(path: string, bytes: Uint8Array, privateOptions: PrivatePathOptions): Promise<boolean> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let handle: FileHandleLike | undefined;
  try {
    handle = await openFile(path, flags, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await securePrivateFile(path, privateOptions);
    await verifyRecoveryKeyFile(path, privateOptions);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (isRecord(error) && error.code === "EEXIST") return false;
    if (error instanceof RecoveryError) throw error;
    throw writeFailure("could not create recovery key", error, [path]);
  }
}

async function loadOrCreateRecoveryKey(directory: string, privateOptions: PrivatePathOptions): Promise<string> {
  const path = join(directory, RECOVERY_KEY_FILE);
  try {
    return encodeRecoveryKey(await readRecoveryKeyFile(path, privateOptions));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const generated = randomBytes(RECOVERY_KEY_BYTES);
  if (!(await createRecoveryKeyFile(path, generated, privateOptions))) {
    return encodeRecoveryKey(await readRecoveryKeyFile(path, privateOptions));
  }
  return encodeRecoveryKey(generated);
}

async function retireRecoveryKey(path: string, expected: string, privateOptions: PrivatePathOptions): Promise<void> {
  let existing: Buffer;
  try {
    existing = await readRecoveryKeyFile(path, privateOptions);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!existing.equals(decodeRecoveryKey(expected, path))) return;
  await rm(path, { force: false });
  await syncDirectory(dirname(path));
}

function detailsObject(entries: Record<string, RecoveryJsonValue>): RecoveryJsonObject {
  return entries;
}

/**
 * A single-owner, serialized, fsynced recovery generation. It never removes a
 * generation until a complete replacement and durable pointer are in place.
 */
export class RecoveryWriter {
  readonly rootDir: string;
  readonly key: string;
  readonly recoveryKey: string;
  readonly directory: string;
  readonly pointerPath: string;
  readonly branchIndexPath: string;
  readonly limits: Required<RecoveryLimits>;

  private baseline: RecoveryBaseline;
  private baselineBytes = 0;
  private logBytes = 0;
  private records: RecoveryRecord[] = [];
  private generation: string | null = null;
  private logPath: string | null = null;
  private physicalBytesSha256 = "";
  private baselinePath: string | null = null;
  private logHandle: FileHandleLike | null = null;
  private status: InternalStatus = "empty";
  private latestFingerprint: string | null = null;
  private failure: RecoveryError | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly branchCatalog = new Map<string, BranchIndexEntry>();
  private readonly privatePathOptions: PrivatePathOptions;
  private readonly recoveryKeyPath: string;
  private constructor(
    options: RecoveryWriterOptions,
    baseline: RecoveryBaseline,
    limits: Required<RecoveryLimits>,
    directory: string,
    recoveryKey: string,
  ) {
    this.rootDir = resolve(options.rootDir);
    this.key = options.key;
    this.recoveryKey = recoveryKey;
    this.directory = directory;
    this.recoveryKeyPath = join(directory, RECOVERY_KEY_FILE);
    this.pointerPath = join(directory, POINTER_FILE);
    this.branchIndexPath = join(directory, BRANCH_INDEX_FILE);
    this.baseline = baseline;
    this.physicalBytesSha256 = baselinePhysicalSha256(baseline);
    this.limits = limits;
    this.privatePathOptions = { processSupervisorExecutable: options.processSupervisorExecutable };
  }

  static async open(options: RecoveryWriterOptions): Promise<RecoveryWriter> {
    if (!isRecord(options)) throw invalid("recovery writer options must be an object");
    if (typeof options.rootDir !== "string" || options.rootDir.length === 0) throw invalid("rootDir is required");
    if (typeof options.key !== "string" || options.key.length === 0 || Buffer.byteLength(options.key, "utf8") > MAX_KEY_BYTES) {
      throw invalid("key must be a bounded non-empty string");
    }
    validateCanonicalString(options.key);
    const limits = normalizeLimits(options.limits);
    const initialBaseline = normalizeBaseline(options.baseline, limits);
    const rootDir = resolve(options.rootDir);
    const keyHash = recoverySha256(options.key);
    const directory = join(rootDir, "recovery-" + keyHash);
    const privatePathOptions: PrivatePathOptions = { processSupervisorExecutable: options.processSupervisorExecutable };
    await ensureRecoveryRoot(rootDir, privatePathOptions).catch((error) => { throw writeFailure("could not secure recovery root", error); });
    await ensureDirectory(directory, 0o700, privatePathOptions).catch((error) => { throw writeFailure("could not secure recovery directory", error); });
    const recoveryKey = await loadOrCreateRecoveryKey(directory, privatePathOptions);
    const writer = new RecoveryWriter(options, initialBaseline, limits, directory, recoveryKey);
    try {
      await writer.initialize(keyHash);
      return writer;
    } catch (error) {
      await writer.closeQuietly();
      throw error;
    }
  }


  get currentBaseline(): RecoveryBaseline {
    return jsonClone(this.baseline);
  }

  get currentGeneration(): string | null {
    return this.generation;
  }

  get currentLogPath(): string | null {
    return this.logPath;
  }

  get currentBaselinePath(): string | null {
    return this.baselinePath;
  }

  private originals(): string[] {
    return [this.baselinePath, this.logPath, this.pointerPath].filter((path): path is string => path !== null);
  }

  private ensureUsable(): void {
    if (this.closed || this.closing !== null) throw new RecoveryError("recovery_closed", "recovery writer is closed");
    if (this.failure !== null) throw this.failure;
    if (this.status === "corrupt") {
      throw corrupt("recovery generation is corrupt", null, this.originals());
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureUsable();
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readBranchCatalog(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readBounded(this.branchIndexPath, 4 * 1024 * 1024, this.privatePathOptions);
    } catch (error) {
      if (isMissing(error)) {
        this.branchCatalog.clear();
        return;
      }
      throw corrupt("recovery branch catalog cannot be read", { path: this.branchIndexPath }, [this.branchIndexPath]);
    }
    let parsed: unknown;
    try {
      parsed = parseJson(bytes, "recovery branch catalog");
    } catch {
      throw corrupt("recovery branch catalog is invalid", { path: this.branchIndexPath }, [this.branchIndexPath]);
    }
    if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "branches,schemaVersion"
      || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.branches)
      || parsed.branches.length > 4096) {
      throw corrupt("recovery branch catalog envelope is invalid", { path: this.branchIndexPath }, [this.branchIndexPath]);
    }
    const next = new Map<string, BranchIndexEntry>();
    for (const value of parsed.branches) {
      if (!isRecord(value) || Object.keys(value).sort().join(",") !== "documentRevision,fingerprint,generation,id,status") {
        throw corrupt("recovery branch catalog entry is invalid", { path: this.branchIndexPath }, [this.branchIndexPath]);
      }
      try {
        validateBranchId(value.id, "recovery branch id");
        const id = value.id;
        if (typeof value.generation !== "string" || !value.generation.startsWith("branch-") || !generationName(value.generation.slice("branch-".length))) throw corrupt("recovery branch generation is invalid", { path: this.branchIndexPath }, [this.branchIndexPath]);
        const generation = value.generation;
        validateRevision(value.documentRevision, "recovery branch documentRevision");
        const documentRevision = value.documentRevision;
        if (value.status !== "empty" && value.status !== "clean" && value.status !== "recovered" && value.status !== "tail-discarded") {
          throw corrupt("recovery branch status is invalid", { path: this.branchIndexPath }, [this.branchIndexPath]);
        }
        const status = value.status;
        validateFingerprint(value.fingerprint, "recovery branch fingerprint");
        const fingerprint = value.fingerprint;
        if (next.has(id)) throw corrupt("recovery branch IDs are duplicated", { path: this.branchIndexPath }, [this.branchIndexPath]);
        next.set(id, { id, generation, documentRevision, status, fingerprint });
      } catch (error) {
        if (error instanceof RecoveryError && error.code === "recovery_corrupt") throw error;
        throw corrupt("recovery branch catalog entry is invalid", { path: this.branchIndexPath }, [this.branchIndexPath]);
      }
    }
    this.branchCatalog.clear();
    for (const [id, entry] of next) this.branchCatalog.set(id, entry);
  }

  private async writeBranchCatalog(entries: readonly BranchIndexEntry[], path = this.branchIndexPath): Promise<void> {
    const envelope: BranchIndexEnvelope = { schemaVersion: SCHEMA_VERSION, branches: entries.slice().sort((left, right) => left.id.localeCompare(right.id)) };
    const bytes = Buffer.from(canonicalEncode(envelope), "utf8");
    try {
      await atomicWrite(path, bytes, 0o600, this.privatePathOptions);
    } catch (error) {
      throw writeFailure("could not atomically update recovery branch catalog", error, [path]);
    }
  }

  private branchDescriptor(entry: BranchIndexEntry): RecoveryBranch {
    return { id: entry.id, documentRevision: entry.documentRevision, status: entry.status, fingerprint: entry.fingerprint };
  }

  private branchEntries(): BranchIndexEntry[] {
    return [...this.branchCatalog.values()].map((entry) => ({ ...entry }));
  }

  private async initialize(keyHash: string): Promise<void> {
    await this.readBranchCatalog();
    const pointerRead = await this.readPointer(keyHash);
    if (pointerRead.kind === "empty") {
      this.generation = null;
      this.status = "empty";
      return;
    }
    if (pointerRead.kind === "generation") {
      const data = await this.readGeneration(pointerRead.generation);
      await this.installGeneration(data);
      return;
    }
    const candidates = await this.candidates();
    if (candidates.length > 0) {
      // An unavailable or invalid pointer leaves generation selection
      // ambiguous. The newest candidate is the only generation we may trust;
      // falling through to an older one could silently hide corruption or data
      // loss in the latest recovery state.
      const candidate = candidates[0]!;
      const data = await this.readGeneration(candidate.generation);
      await this.installGeneration(data);
      if (pointerRead.kind === "invalid") await this.writePointer(keyHash, candidate.generation);
      return;
    }
    if (pointerRead.kind === "missing") {
      await this.createGeneration(initialBaselineFor(this), keyHash);
      return;
    }
    throw corrupt("recovery generation pointer is invalid", null, [this.pointerPath]);
  }
  private async readPointer(keyHash: string): Promise<
    { kind: "missing" } | { kind: "empty" } | { kind: "generation"; generation: string } | { kind: "invalid" }
  > {
    let bytes: Buffer;
    try {
      bytes = await readBounded(this.pointerPath, 16 * 1024, this.privatePathOptions);
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" };
      if (error instanceof RecoveryError && error.code === "recovery_limit") throw error;
      if (error instanceof PrivatePathError) throw corrupt("recovery pointer cannot be read", { path: this.pointerPath }, [this.pointerPath]);
      return { kind: "invalid" };
    }
    let parsed: unknown;
    try {
      parsed = parseJson(bytes, "recovery pointer");
    } catch {
      return { kind: "invalid" };
    }
    if (!isRecord(parsed)
      || Object.keys(parsed).sort().join(",") !== "generation,keyHash,schemaVersion"
      || parsed.schemaVersion !== SCHEMA_VERSION
      || parsed.keyHash !== keyHash) {
      return { kind: "invalid" };
    }
    const generation = parsed.generation;
    if (generation === null) return { kind: "empty" };
    if (typeof generation !== "string" || !generationName(generation)) return { kind: "invalid" };
    return { kind: "generation", generation };
  }

  private async candidates(): Promise<CandidateGeneration[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const branchGenerations = new Set([...this.branchCatalog.values()].map((branch) => branch.generation));
    const candidates: CandidateGeneration[] = []
    for (const entry of entries) {
      if (!entry.name.startsWith(BASELINE_PREFIX) || !entry.name.endsWith(BASELINE_SUFFIX)) continue;
      if (entry.isSymbolicLink()) throw corrupt("recovery candidate contains a reparse point", { path: join(this.directory, entry.name) }, [join(this.directory, entry.name)]);
      if (!entry.isFile()) continue;
      const generation = entry.name.slice(BASELINE_PREFIX.length, -BASELINE_SUFFIX.length);
      if (!generationName(generation) || branchGenerations.has(generation)) continue;
      const paths = generationPaths(this.directory, generation);
      try {
        await verifyPrivateFile(paths.baselinePath, this.privatePathOptions);
        const info = await stat(paths.baselinePath);
        await ensureRegularFile(paths.logPath, this.privatePathOptions);
        candidates.push({ generation, ...paths, modified: info.mtimeMs });
      } catch (error) {
        if (error instanceof PrivatePathError) throw corrupt("recovery candidate private file is not secure", { generation }, [paths.baselinePath, paths.logPath]);
        // An orphaned/incomplete generation is ignored only while the pointer
        // itself is unavailable. A pointed generation is always reported below.
      }
    }
    candidates.sort((left, right) => right.modified - left.modified || right.generation.localeCompare(left.generation));
    return candidates;
  }

  private async readGeneration(generation: string): Promise<GenerationData> {
    if (!generationName(generation)) throw corrupt("recovery generation name is invalid", null, [this.pointerPath]);
    const paths = generationPaths(this.directory, generation);
    const originals = [paths.baselinePath, paths.logPath, this.pointerPath];
    let baselineBytes: Buffer;
    try {
      baselineBytes = await readBounded(paths.baselinePath, this.limits.maxBaselineBytes, this.privatePathOptions);
      await ensureRegularFile(paths.logPath, this.privatePathOptions);
    } catch (error) {
      if (error instanceof RecoveryError && error.code === "recovery_limit") throw error;
      throw corrupt("recovery generation files are missing or not regular", { generation }, originals);
    }
    let parsedBaseline: unknown;
    try {
      parsedBaseline = parseJson(baselineBytes, "recovery baseline");
    } catch (error) {
      if (error instanceof RecoveryError && error.code === "recovery_limit") throw error;
      throw corrupt("recovery baseline is invalid", { generation }, originals);
    }
    if (!isRecord(parsedBaseline) || parsedBaseline.kind !== "baseline") {
      throw corrupt("recovery baseline envelope is invalid", { generation }, originals);
    }
    let baseline: RecoveryBaseline;
    try {
      const { kind: _kind, ...rawBaseline } = parsedBaseline;
      baseline = normalizeBaseline(rawBaseline, this.limits);
    } catch (error) {
      if (error instanceof RecoveryError && error.code === "recovery_limit") {
        throw corrupt("recovery baseline exceeds its limit", { generation }, originals);
      }
      throw corrupt("recovery baseline fields are invalid", { generation }, originals);
    }
    const parsedLog = await this.readLog(paths.logPath, baseline.documentRevision, generation, originals);
    return { generation, baseline, records: parsedLog.records, tailDiscarded: parsedLog.tailDiscarded, baselineBytes: baselineBytes.length, logBytes: parsedLog.logBytes };
  }

  private async readLog(
    path: string,
    baselineRevision: number,
    generation: string,
    originals: readonly string[],
  ): Promise<ParsedLog> {
    let bytes: Buffer;
    try {
      bytes = await readBounded(path, this.limits.maxLogBytes, this.privatePathOptions);
    } catch (error) {
      if (error instanceof RecoveryError && error.code === "recovery_limit") {
        throw corrupt("recovery log exceeds its limit", { generation }, originals);
      }
      throw corrupt("recovery log cannot be read", { generation }, originals);
    }
    const records: RecoveryRecord[] = [];
    let offset = 0;
    let expectedRevision = baselineRevision;
    let tailDiscarded = false;
    while (offset < bytes.length) {
      const frameStart = offset;
      if (bytes.length - offset < 4) {
        tailDiscarded = true;
        offset = frameStart;
        break;
      }
      const payloadLength = bytes.readUInt32BE(offset);
      offset += 4;
      if (payloadLength === 0) {
        throw corrupt("recovery frame length is invalid", detailsObject({ generation, offset: frameStart }), originals);
      }
      if (payloadLength > this.limits.maxRecordBytes) {
        if (bytes.length - offset < payloadLength) {
          tailDiscarded = true;
          offset = frameStart;
          break;
        }
        throw corrupt("interior recovery frame length is invalid", detailsObject({ generation, offset: frameStart }), originals);
      }
      if (bytes.length - offset < payloadLength) {
        // A tampered length can still leave a complete canonical record in
        // the remaining bytes. Probe that case before treating the suffix as
        // an unacknowledged torn append.
        try {
          const candidate = validateStoredRecord(parseJson(bytes.subarray(offset), "recovery log record"), this.limits);
          void candidate;
          throw corrupt("recovery frame length does not match its complete payload", detailsObject({ generation, offset: frameStart }), originals);
        } catch (error) {
          if (error instanceof RecoveryError && error.code === "recovery_corrupt") throw error;
          if (error instanceof RecoveryError && error.code === "recovery_limit") {
            throw corrupt("recovery frame length is invalid", detailsObject({ generation, offset: frameStart }), originals);
          }
        }
        tailDiscarded = true;
        offset = frameStart;
        break;
      }
      const payload = bytes.subarray(offset, offset + payloadLength);
      offset += payloadLength;
      const frameEnd = offset;
      let parsed: unknown;
      let recordLimitExceeded = false;
      try {
        parsed = parseJson(payload, "recovery log record");
        const record = validateStoredRecord(parsed, this.limits);
        if (record.fromRevision !== expectedRevision || record.toRevision !== record.fromRevision + 1) {
          throw corrupt(
            "recovery log revisions are not continuous",
            detailsObject({ generation, offset: frameStart, expectedRevision, fromRevision: record.fromRevision, toRevision: record.toRevision }),
            originals,
          );
        }
        if (records.length >= this.limits.maxRecords) {
          recordLimitExceeded = true;
          throw corrupt("recovery log exceeds its record limit", detailsObject({ generation, limit: this.limits.maxRecords }), originals);
        }
        records.push(record);
        expectedRevision = record.toRevision;
      } catch (error) {
        if (recordLimitExceeded) throw error;
        if (frameEnd === bytes.length) {
          // A complete final frame can be a corrupt, unacknowledged tail.
          // Keep all preceding records and discard this frame; corruption in
          // any non-final frame remains fatal below.
          tailDiscarded = true;
          offset = frameStart;
          break;
        }
        if (error instanceof RecoveryError && error.code === "recovery_limit") {
          throw corrupt("recovery record exceeds a limit", detailsObject({ generation, offset: frameStart }), originals);
        }
        if (error instanceof RecoveryError && error.code === "recovery_corrupt") throw error;
        throw corrupt("recovery record is invalid", detailsObject({ generation, offset: frameStart }), originals);
      }
    }
    if (tailDiscarded) {
      await this.discardTail(path, offset, originals);
    }
    return { records, tailDiscarded, logBytes: offset };
  }

  private async discardTail(path: string, length: number, originals: readonly string[]): Promise<void> {
    let handle: FileHandleLike | undefined;
    try {
      handle = await openVerifiedFile(path, constants.O_RDWR, this.privatePathOptions);
      await handle.truncate(length);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await verifyPrivateFile(path, this.privatePathOptions);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      throw writeFailure("could not discard torn recovery tail", error, originals);
    }
  }

  private async installGeneration(data: GenerationData): Promise<void> {
    const materialized = materializeBaseline(data.baseline, data.records, this.limits);
    const paths = generationPaths(this.directory, data.generation);
    await verifyPrivateFile(paths.baselinePath, this.privatePathOptions);
    const handle = await openVerifiedFile(paths.logPath, constants.O_RDWR, this.privatePathOptions);
    this.generation = data.generation;
    this.baselinePath = paths.baselinePath;
    this.logPath = paths.logPath;
    this.baseline = data.baseline;
    this.baselineBytes = data.baselineBytes;
    this.records = data.records;
    this.physicalBytesSha256 = baselinePhysicalSha256(materialized);
    this.logBytes = data.logBytes;
    this.status = data.tailDiscarded ? "tail-discarded" : data.records.length > 0 ? "recovered" : "clean";
    this.logHandle = handle;
    this.latestFingerprint = data.records.at(-1)?.sha256 ?? baselineFingerprint(data.baseline);
  }

  private async createGeneration(baseline: RecoveryBaseline, keyHash: string): Promise<void> {
    const normalized = normalizeBaseline(baseline, this.limits);
    const generation = randomUUID();
    const paths = generationPaths(this.directory, generation);
    let stagedGenerationPublished = false;
    try {
      const encodedBaseline = Buffer.from(canonicalEncode(storedBaseline(normalized)), "utf8");
      await atomicWrite(paths.baselinePath, encodedBaseline, 0o600, this.privatePathOptions);
      await atomicWrite(paths.logPath, Buffer.alloc(0), 0o600, this.privatePathOptions);
      await this.writePointer(keyHash, generation);
      stagedGenerationPublished = true;
      const handle = await openVerifiedFile(paths.logPath, constants.O_RDWR, this.privatePathOptions);
      this.generation = generation;
      this.baselinePath = paths.baselinePath;
      this.logPath = paths.logPath;
      this.baseline = normalized;
      this.physicalBytesSha256 = baselinePhysicalSha256(normalized);
      this.baselineBytes = encodedBaseline.length;
      this.records = [];
      this.logBytes = 0;
      this.status = "clean";
      this.latestFingerprint = baselineFingerprint(normalized);
      this.logHandle = handle;
    } catch (error) {
      if (!stagedGenerationPublished) {
        try {
          const pointer = await this.readPointer(keyHash);
          // Invalid pointers are uncertain: staged files remain available for
          // candidate recovery rather than being deleted speculatively.
          stagedGenerationPublished = pointer.kind === "invalid"
            || (pointer.kind === "generation" && pointer.generation === generation);
        } catch {
          // An unreadable pointer leaves publication outcome uncertain.
          stagedGenerationPublished = true;
        }
      }
      if (!stagedGenerationPublished) {
        await rm(paths.baselinePath, { force: true }).catch(() => undefined);
        await rm(paths.logPath, { force: true }).catch(() => undefined);
      }
      const failure = error instanceof RecoveryError
        ? error
        : writeFailure("could not create recovery generation", error, [this.pointerPath]);
      this.failure = failure.code === "recovery_write_failed" ? failure : writeFailure(failure.message, failure, this.originals());
      throw this.failure;
    }
  }

  private async writePointer(keyHash: string, generation: string | null): Promise<void> {
    const pointer: GenerationPointer = { schemaVersion: SCHEMA_VERSION, keyHash, generation };
    const bytes = Buffer.from(canonicalEncode(pointer), "utf8");
    try {
      await atomicWrite(this.pointerPath, bytes, 0o600, this.privatePathOptions);
    } catch (error) {
      throw writeFailure("could not atomically switch recovery generation", error, [this.pointerPath]);
    }
  }

  private async publishPointerExclusive(keyHash: string, generation: string): Promise<void> {
    const pointer: GenerationPointer = { schemaVersion: SCHEMA_VERSION, keyHash, generation };
    const bytes = Buffer.from(canonicalEncode(pointer), "utf8");
    const temporary = join(this.directory, ".current-" + randomUUID() + ".tmp");
    try {
      await atomicWrite(temporary, bytes, 0o600, this.privatePathOptions);
      await link(temporary, this.pointerPath);
      await verifyPrivateFile(this.pointerPath, this.privatePathOptions);
      await syncDirectory(this.directory);
    } catch (error) {
      throw writeFailure("could not exclusively publish recovery generation", error, [this.pointerPath]);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private state(): RecoveryState {
    const baseline = jsonClone(this.baseline);
    const records = jsonClone(this.records);
    const status: RecoveryStatus = this.status === "corrupt" ? "empty" : this.status;
    return {
      schemaVersion: SCHEMA_VERSION,
      generation: this.generation,
      baseline,
      records,
      documentRevision: this.documentRevision(),
      status,
      fingerprint: this.latestFingerprint ?? baselineFingerprint(baseline),
      branches: [...this.branchCatalog.values()].map((entry) => this.branchDescriptor(entry)),
    };
  }

  private documentRevision(): number {
    return this.records.at(-1)?.toRevision ?? this.baseline.documentRevision;
  }

  private async loadInternal(): Promise<RecoveryState> {
    if (this.generation === null) return this.state();
    const data = await this.readGeneration(this.generation);
    this.baseline = data.baseline;
    this.baselineBytes = data.baselineBytes;
    this.records = data.records;
    this.logBytes = data.logBytes;
    this.physicalBytesSha256 = baselinePhysicalSha256(materializeBaseline(data.baseline, data.records, this.limits));
    this.status = data.tailDiscarded || this.status === "tail-discarded"
      ? "tail-discarded"
      : data.records.length > 0 ? "recovered" : "clean";
    this.latestFingerprint = data.records.at(-1)?.sha256 ?? baselineFingerprint(data.baseline);
    return this.state();
  }

  /** Stage a complete target generation without publishing its active pointer. */
  prepareRebind(target: RecoveryRebindTarget): Promise<PreparedRecoveryRebind> {
    return this.enqueue(async () => {
      if (!isRecord(target) || typeof target.rootDir !== "string" || target.rootDir.length === 0 || typeof target.key !== "string") {
        throw invalid("recovery rebind target is invalid");
      }
      if (target.key.length === 0 || Buffer.byteLength(target.key, "utf8") > MAX_KEY_BYTES) throw invalid("recovery rebind key is invalid");
      validateCanonicalString(target.key);
      const limits = this.limits;
      const normalized = normalizeBaseline(target.baseline, limits);
      const rootDir = resolve(target.rootDir);
      const keyHash = recoverySha256(target.key);
      const directory = join(rootDir, "recovery-" + keyHash);
      if (directory === this.directory) throw invalid("recovery rebind target is the current recovery directory");
      const privatePathOptions: PrivatePathOptions = { processSupervisorExecutable: this.privatePathOptions.processSupervisorExecutable };
      await ensureDirectory(rootDir, 0o700, privatePathOptions).catch((error) => { throw writeFailure("could not secure recovery rebind root", error); });
      await ensureDirectory(directory, 0o700, privatePathOptions).catch((error) => { throw writeFailure("could not secure recovery rebind directory", error); });
      const stagedWriter = new RecoveryWriter({ rootDir, key: target.key, baseline: normalized, limits, processSupervisorExecutable: this.privatePathOptions.processSupervisorExecutable }, normalized, limits, directory, this.recoveryKey);
      const pointer = await stagedWriter.readPointer(keyHash);
      if (pointer.kind !== "missing") throw invalid("recovery rebind target already has recovery state");
      try {
        await lstat(stagedWriter.recoveryKeyPath);
        throw invalid("recovery rebind target already has a recovery key");
      } catch (error) {
        if (error instanceof RecoveryError) throw error;
        if (!isMissing(error)) throw writeFailure("could not inspect recovery rebind key", error, [stagedWriter.recoveryKeyPath]);
      }
      const sourceBranches = this.branchEntries();
      await stagedWriter.readBranchCatalog();
      if (stagedWriter.branchCatalog.size !== 0) throw invalid("recovery rebind target has recovery branches");
      let targetBranchCatalogExists = true;
      try {
        await lstat(stagedWriter.branchIndexPath);
      } catch (error) {
        if (isMissing(error)) targetBranchCatalogExists = false;
        else throw writeFailure("could not inspect recovery rebind branch catalog", error, [stagedWriter.branchIndexPath]);
      }
      if (targetBranchCatalogExists) throw invalid("recovery rebind target already has a branch catalog");
      const existingCandidates = await stagedWriter.candidates();
      if (existingCandidates.length !== 0) throw invalid("recovery rebind target already has recovery generations");
      for (const entry of sourceBranches) {
        const data = await this.readGeneration(entry.generation);
        const baseline = materializeBaseline(data.baseline, data.records, this.limits);
        const actualRevision = data.records.at(-1)?.toRevision ?? data.baseline.documentRevision;
        const actualFingerprint = data.records.at(-1)?.sha256 ?? baselineFingerprint(data.baseline);
        if (actualRevision !== entry.documentRevision || actualFingerprint !== entry.fingerprint || baseline.documentRevision !== entry.documentRevision) {
          throw invalid("source recovery branch state is inconsistent");
        }
      }
      const recoveryKeyStagePath = join(directory, ".alder-recovery-key-" + randomUUID() + ".tmp");
      const branchCatalogStagePath = join(directory, ".alder-branches-" + randomUUID() + ".tmp");
      const copiedBranches: Array<{
        entry: BranchIndexEntry;
        stagedPaths: { baselinePath: string; logPath: string };
        publishedPaths: { baselinePath: string; logPath: string };
        baselinePublished: boolean;
        logPublished: boolean;
      }> = [];
      let branchCatalogStaged = false;
      let branchCatalogPublished = false;
      let recoveryKeyPublished = false;
      const assertMissingTarget = async (path: string): Promise<void> => {
        try {
          await lstat(path);
          throw invalid("recovery rebind target branch path already exists");
        } catch (error) {
          if (error instanceof RecoveryError) throw error;
          if (!isMissing(error)) throw writeFailure("could not inspect recovery rebind target branch path", error, [path]);
        }
      };
      let staged: Awaited<ReturnType<typeof stageGenerationFiles>>;
      try {
        if (!(await createRecoveryKeyFile(recoveryKeyStagePath, decodeRecoveryKey(this.recoveryKey, recoveryKeyStagePath), privatePathOptions))) {
          throw invalid("recovery rebind key staging path already exists");
        }
        for (const entry of sourceBranches) {
          const sourcePaths = generationPaths(this.directory, entry.generation);
          const stagedGeneration = "staged-" + entry.generation.slice("branch-".length);
          const stagedPaths = generationPaths(directory, stagedGeneration);
          const publishedPaths = generationPaths(directory, entry.generation);
          try {
            await copyBranchFile(sourcePaths.baselinePath, stagedPaths.baselinePath, this.privatePathOptions);
            await copyBranchFile(sourcePaths.logPath, stagedPaths.logPath, this.privatePathOptions);
          } catch (error) {
            await rm(stagedPaths.baselinePath, { force: true }).catch(() => undefined);
            await rm(stagedPaths.logPath, { force: true }).catch(() => undefined);
            throw error;
          }
          copiedBranches.push({ entry, stagedPaths, publishedPaths, baselinePublished: false, logPublished: false });
        }
        if (sourceBranches.length > 0) {
          await stagedWriter.writeBranchCatalog(sourceBranches, branchCatalogStagePath);
          for (const entry of sourceBranches) stagedWriter.branchCatalog.set(entry.id, { ...entry });
          branchCatalogStaged = true;
        }
        staged = await stageGenerationFiles(directory, normalized, limits, "staged", this.privatePathOptions);
      } catch (error) {
        await rm(recoveryKeyStagePath, { force: true }).catch(() => undefined);
        await rm(branchCatalogStagePath, { force: true }).catch(() => undefined);
        for (const copied of copiedBranches) {
          await rm(copied.stagedPaths.baselinePath, { force: true }).catch(() => undefined);
          await rm(copied.stagedPaths.logPath, { force: true }).catch(() => undefined);
        }
        throw writeFailure("could not stage recovery rebind branches", error, [directory]);
      }
      let handle: FileHandleLike | null = null;
      try {
        handle = await openVerifiedFile(staged.logPath, constants.O_RDWR, this.privatePathOptions);
        stagedWriter.generation = staged.generation;
        stagedWriter.baselinePath = staged.baselinePath;
        stagedWriter.logPath = staged.logPath;
        stagedWriter.baseline = normalized;
        stagedWriter.baselineBytes = staged.baselineBytes;
        stagedWriter.records = [];
        stagedWriter.logBytes = 0;
        stagedWriter.physicalBytesSha256 = baselinePhysicalSha256(normalized);
        stagedWriter.status = "clean";
        stagedWriter.latestFingerprint = baselineFingerprint(normalized);
        stagedWriter.logHandle = handle;
        handle = null;
      } catch (error) {
        if (handle !== null) await handle.close().catch(() => undefined);
        await rm(staged.baselinePath, { force: true }).catch(() => undefined);
        await rm(staged.logPath, { force: true }).catch(() => undefined);
        await rm(branchCatalogStagePath, { force: true }).catch(() => undefined);
        for (const copied of copiedBranches) {
          await rm(copied.stagedPaths.baselinePath, { force: true }).catch(() => undefined);
          await rm(copied.stagedPaths.logPath, { force: true }).catch(() => undefined);
        }
        throw writeFailure("could not open staged recovery rebind log", error, [staged.baselinePath, staged.logPath]);
      }
      let published = false;
      let adopted = false;
      let aborted = false;
      let abortPromise: Promise<void> | null = null;
      let retirementPromise: Promise<void> | null = null;
      const retireSourceBranches = (): Promise<void> => {
        if (retirementPromise !== null) return retirementPromise;
        retirementPromise = this.enqueue(async () => {
          const retiring = sourceBranches.filter((entry) => {
            const current = this.branchCatalog.get(entry.id);
            return current !== undefined && sameBranchEntry(current, entry);
          });
          if (retiring.length > 0) {
            const retiringIds = new Set(retiring.map((entry) => entry.id));
            await this.writeBranchCatalog(this.branchEntries().filter((entry) => !retiringIds.has(entry.id)));
            for (const entry of retiring) this.branchCatalog.delete(entry.id);
            for (const entry of retiring) await unlinkGeneration(generationPaths(this.directory, entry.generation));
            await syncDirectory(this.directory);
          }
          await retireRecoveryKey(this.recoveryKeyPath, this.recoveryKey, this.privatePathOptions);
        });
        return retirementPromise;
      };
      const prepared: PreparedRecoveryRebind = {
        writer: stagedWriter,
        state: stagedWriter.state(),
        publish: async () => {
          if (aborted) throw invalid("recovery rebind has been aborted");
          if (adopted || published) return;
          try {
            const current = await stagedWriter.readPointer(keyHash);
            if (current.kind !== "missing") throw invalid("recovery rebind target changed before publication");
            const observedBranches = stagedWriter.branchEntries();
            if (!sameBranchEntries(observedBranches, sourceBranches)) {
              throw invalid("recovery rebind target branch catalog changed before publication");
            }
            if (sourceBranches.length > 0) await ensureRegularFile(branchCatalogStagePath, this.privatePathOptions);
            for (const copied of copiedBranches) {
              const stagedGeneration = "staged-" + copied.entry.generation.slice("branch-".length);
              const data = await stagedWriter.readGeneration(stagedGeneration);
              const baseline = materializeBaseline(data.baseline, data.records, limits);
              const actualRevision = data.records.at(-1)?.toRevision ?? data.baseline.documentRevision;
              const actualFingerprint = data.records.at(-1)?.sha256 ?? baselineFingerprint(data.baseline);
              if (actualRevision !== copied.entry.documentRevision || actualFingerprint !== copied.entry.fingerprint || baseline.documentRevision !== copied.entry.documentRevision) {
                throw invalid("recovery rebind target branch state changed before publication");
              }
              await assertMissingTarget(copied.publishedPaths.baselinePath);
              await assertMissingTarget(copied.publishedPaths.logPath);
            }
            for (const copied of copiedBranches) {
              await link(copied.stagedPaths.baselinePath, copied.publishedPaths.baselinePath);
              copied.baselinePublished = true;
              await rm(copied.stagedPaths.baselinePath, { force: false });
              await link(copied.stagedPaths.logPath, copied.publishedPaths.logPath);
              copied.logPublished = true;
              await rm(copied.stagedPaths.logPath, { force: false });
            }
            if (sourceBranches.length > 0) {
              await assertMissingTarget(stagedWriter.branchIndexPath);
              await link(branchCatalogStagePath, stagedWriter.branchIndexPath);
              branchCatalogPublished = true;
              await rm(branchCatalogStagePath, { force: false });
            }
            await assertMissingTarget(stagedWriter.recoveryKeyPath);
            await link(recoveryKeyStagePath, stagedWriter.recoveryKeyPath);
            recoveryKeyPublished = true;
            const publishedKey = await readRecoveryKeyFile(stagedWriter.recoveryKeyPath, privatePathOptions);
            if (!publishedKey.equals(decodeRecoveryKey(this.recoveryKey, stagedWriter.recoveryKeyPath))) throw writeFailure("recovery rebind key publication was not observed", null, [stagedWriter.recoveryKeyPath]);
            await rm(recoveryKeyStagePath, { force: false });
            await stagedWriter.publishPointerExclusive(keyHash, staged.generation);
            const observed = await stagedWriter.readPointer(keyHash);
            if (observed.kind !== "generation" || observed.generation !== staged.generation) throw writeFailure("recovery rebind pointer publication was not observed", null, [stagedWriter.pointerPath]);
            published = true;
          } catch (error) {
            try {
              const observed = await stagedWriter.readPointer(keyHash);
              published = observed.kind === "generation" && observed.generation === staged.generation;
            } catch {
              // Keep staged files when pointer publication is uncertain.
            }
            throw error;
          }
        },
        adopt: () => {
          if (aborted) throw invalid("recovery rebind has been aborted");
          if (!published) throw invalid("recovery rebind must publish before adoption");
          adopted = true;
          try {
            void retireSourceBranches().catch((error) => {
              this.failure = error instanceof RecoveryError
                ? error
                : writeFailure("could not retire source recovery branches", error, [this.branchIndexPath]);
            });
          } catch (error) {
            this.failure = error instanceof RecoveryError
              ? error
              : writeFailure("could not retire source recovery branches", error, [this.branchIndexPath]);
          }
        },
        abort: async () => {
          if (adopted || aborted) return;
          if (abortPromise !== null) return abortPromise;
          abortPromise = (async () => {
            let pointerState: { kind: "missing" } | { kind: "empty" } | { kind: "generation"; generation: string } | { kind: "invalid" };
            try {
              pointerState = await stagedWriter.readPointer(keyHash);
            } catch {
              await stagedWriter.closeQuietly();
              aborted = true;
              return;
            }
            if (pointerState.kind === "generation" && pointerState.generation === staged.generation) {
              try {
                await stagedWriter.writePointer(keyHash, null);
                pointerState = await stagedWriter.readPointer(keyHash);
              } catch {
                await stagedWriter.closeQuietly();
                aborted = true;
                return;
              }
            }
            if (pointerState.kind === "generation") {
              await stagedWriter.closeQuietly();
              aborted = true;
              return;
            }
            await stagedWriter.closeQuietly();
            try {
              await rm(recoveryKeyStagePath, { force: true }).catch(() => undefined);
            if (recoveryKeyPublished) {
              try {
                const currentKey = await readRecoveryKeyFile(stagedWriter.recoveryKeyPath, privatePathOptions);
                if (currentKey.equals(decodeRecoveryKey(this.recoveryKey, stagedWriter.recoveryKeyPath))) {
                  await rm(stagedWriter.recoveryKeyPath, { force: false });
                  await syncDirectory(directory);
                }
              } catch (error) {
                if (!isMissing(error)) {
                  // A changed or malformed target key is foreign state; retain it.
                }
              }
            }
            await rm(staged.baselinePath, { force: false });
              await rm(staged.logPath, { force: false });
              let removeTransferredBranches = branchCatalogStaged;
              if (branchCatalogPublished) {
                try {
                  await stagedWriter.readBranchCatalog();
                  removeTransferredBranches = sameBranchEntries(stagedWriter.branchEntries(), sourceBranches);
                } catch {
                  removeTransferredBranches = false;
                }
              }
              if (removeTransferredBranches) {
                if (branchCatalogPublished) await rm(stagedWriter.branchIndexPath, { force: false });
                else await rm(branchCatalogStagePath, { force: false });
              } else if (!branchCatalogPublished) {
                await rm(branchCatalogStagePath, { force: false }).catch((error) => {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                });
              }
              if (branchCatalogPublished) await rm(branchCatalogStagePath, { force: true }).catch(() => undefined);
              for (const copied of copiedBranches) {
                await rm(copied.stagedPaths.baselinePath, { force: false }).catch((error) => {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                });
                await rm(copied.stagedPaths.logPath, { force: false }).catch((error) => {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                });
                if (removeTransferredBranches || !branchCatalogPublished) {
                  if (copied.baselinePublished) await rm(copied.publishedPaths.baselinePath, { force: false });
                  if (copied.logPublished) await rm(copied.publishedPaths.logPath, { force: false });
                }
              }
              await syncDirectory(directory);
              if (pointerState.kind === "empty") {
                const observed = await stagedWriter.readPointer(keyHash);
                if (observed.kind === "empty") await rm(stagedWriter.pointerPath, { force: false });
              }
              aborted = true;
            } catch (error) {
              aborted = true;
              throw writeFailure("could not abort staged recovery rebind", error, [staged.baselinePath, staged.logPath, stagedWriter.pointerPath]);
            }
          })();
          return abortPromise;
        },
      };
      return prepared;
    });
  }
  /** Return the fully materialized, runtime-free projection represented by the durable baseline and complete records. */
  materializedBaseline(): Promise<RecoveryBaseline> {
    return this.enqueue(async () => {
      try {
        return jsonClone(materializeBaseline(this.baseline, this.records, this.limits));
      } catch (error) {
        if (error instanceof RecoveryError && (error.code === "recovery_invalid" || error.code === "recovery_limit")) {
          this.status = "corrupt";
        }
        throw error;
      }
    });
  }
  /** Reloads and validates the durable generation; torn tail handling is durable. */
  load(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      try {
        return await this.loadInternal();
      } catch (error) {
        if (error instanceof RecoveryError && error.code === "recovery_corrupt") this.status = "corrupt";
        throw error;
      }
    });
  }

  /** Create a durable runtime-free recovery branch without changing active authority. */
  forkBranch(input: RecoveryBranchFork = {}): Promise<RecoveryBranch> {
    return this.enqueue(async () => {
      if (!isRecord(input)) throw invalid("recovery branch fork input is invalid");
      const inputKeys = Object.keys(input).sort().join(",");
      if (Object.prototype.hasOwnProperty.call(input, "id") && input.id === undefined) throw invalid("recovery branch fork input is invalid");
      if (Object.prototype.hasOwnProperty.call(input, "baseline") && input.baseline === undefined) throw invalid("recovery branch fork input is invalid");
      if (inputKeys !== "" && inputKeys !== "baseline" && inputKeys !== "id" && inputKeys !== "baseline,id") throw invalid("recovery branch fork input is invalid");
      const id = input.id === undefined ? randomUUID() : input.id;
      validateBranchId(id);
      if (this.branchCatalog.has(id)) throw invalid("recovery branch already exists");
      let baseline: RecoveryBaseline;
      try {
        baseline = input.baseline === undefined
          ? materializeBaseline(this.baseline, this.records, this.limits)
          : normalizeBaseline(input.baseline, this.limits);
      } catch (error) {
        throw writeFailure("could not materialize recovery branch", error, this.originals());
      }
      const staged = await stageGenerationFiles(this.directory, baseline, this.limits, "branch", this.privatePathOptions);
      const revision = baseline.documentRevision;
      const status: RecoveryStatus = revision === 0 ? "clean" : "recovered";
      const entry: BranchIndexEntry = {
        id,
        generation: staged.generation,
        documentRevision: revision,
        status,
        fingerprint: baselineFingerprint(baseline),
      };
      try {
        await this.writeBranchCatalog([...this.branchCatalog.values(), entry]);
        this.branchCatalog.set(id, entry);
      } catch (error) {
        await rm(staged.baselinePath, { force: true }).catch(() => undefined);
        await rm(staged.logPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return this.branchDescriptor(entry);
    });
  }

  /** Return only bounded branch descriptors; full state is loaded explicitly. */
  listBranches(): Promise<readonly RecoveryBranch[]> {
    return this.enqueue(async () => this.branchEntries().sort((left, right) => left.id.localeCompare(right.id)).map((entry) => this.branchDescriptor(entry)));
  }

  /** Load and materialize one durable branch's runtime-free source state. */
  materializeBranch(id: string): Promise<RecoveryBaseline> {
    return this.enqueue(async () => {
      validateBranchId(id);
      const entry = this.branchCatalog.get(id);
      if (entry === undefined) throw invalid("recovery branch does not exist");
      try {
        const data = await this.readGeneration(entry.generation);
        const baseline = materializeBaseline(data.baseline, data.records, this.limits);
        const actualRevision = data.records.at(-1)?.toRevision ?? data.baseline.documentRevision;
        const actualFingerprint = data.records.at(-1)?.sha256 ?? baselineFingerprint(data.baseline);
        if (actualRevision !== entry.documentRevision || actualFingerprint !== entry.fingerprint || baseline.documentRevision !== entry.documentRevision) {
          throw invalid("recovery branch state is inconsistent");
        }
        return jsonClone(baseline);
      } catch {
        throw corrupt("recovery branch cannot be materialized", { id }, [this.branchIndexPath]);
      }
    });
  }

  /** Drop a branch only when the caller proves its exact observed state. */
  dropBranch(id: string, expected: RecoveryBranchDropExpected): Promise<boolean> {
    return this.enqueue(async () => {
      validateBranchId(id);
      if (!isRecord(expected)) throw invalid("recovery branch drop precondition is invalid");
      const expectedKeys = Object.keys(expected).sort().join(",");
      if (expectedKeys !== "documentRevision,fingerprint") throw invalid("recovery branch drop precondition is invalid");
      validateRevision(expected.documentRevision, "dropBranch.documentRevision");
      validateFingerprint(expected.fingerprint, "dropBranch.fingerprint");
      const entry = this.branchCatalog.get(id);
      if (entry === undefined || entry.documentRevision !== expected.documentRevision || entry.fingerprint !== expected.fingerprint) return false;
      const paths = generationPaths(this.directory, entry.generation);
      let data: GenerationData;
      try {
        data = await this.readGeneration(entry.generation);
      } catch (error) {
        throw corrupt("recovery branch cannot be verified before drop", { id }, [paths.baselinePath, paths.logPath, this.branchIndexPath]);
      }
      const actualRevision = data.records.at(-1)?.toRevision ?? data.baseline.documentRevision;
      const actualFingerprint = data.records.at(-1)?.sha256 ?? baselineFingerprint(data.baseline);
      if (actualRevision !== expected.documentRevision || actualFingerprint !== expected.fingerprint) return false;
      const remaining = this.branchEntries().filter((candidate) => candidate.id !== id);
      await this.writeBranchCatalog(remaining);
      this.branchCatalog.delete(id);
      try {
        await unlinkGeneration(paths);
        await syncDirectory(this.directory);
      } catch (error) {
        throw writeFailure("could not remove recovery branch files", error, [paths.baselinePath, paths.logPath, this.branchIndexPath]);
      }
      return true;
    });
  }
  /** Append exactly one source revision after fsyncing its complete log frame. */
  append(input: RecoveryAppend): Promise<RecoveryRecord> {
    return this.enqueue(async () => {
      if (!isRecord(input) || input.schemaVersion !== SCHEMA_VERSION) throw writeFailure("recovery append has an unsupported schemaVersion", null, this.originals());
      validateRevision(input.fromRevision, "append.fromRevision");
      validateRevision(input.toRevision, "append.toRevision");
      if (input.toRevision !== input.fromRevision + 1) {
        throw writeFailure("recovery append must advance exactly one document revision", null, this.originals());
      }
      if (input.fromRevision !== this.documentRevision()) {
        throw writeFailure("recovery append is not continuous with the durable revision", null, this.originals());
      }
      if (input.fingerprint !== undefined) validateFingerprint(input.fingerprint);
      if (!isRecord(input.delta) || input.delta.baseSha256 !== this.physicalBytesSha256) {
        throw writeFailure("recovery source delta is not continuous with its physical bytes", null, this.originals());
      }
      const encoded = encodeRecord(input, this.limits);
      const sourceDelta = encoded.record.delta;
      try {
        materializeBaseline(this.baseline, [...this.records, encoded.record], this.limits);
      } catch (error) {
        throw writeFailure("recovery source delta result bytes are invalid", error, this.originals());
      }
      const bytes = frame(encoded.payload);
      if (bytes.length > this.limits.maxLogBytes) {
        throw writeFailure("recovery record exceeds its byte limit", null, this.originals());
      }
      if (this.generation === null) await this.createGeneration(this.baseline, recoverySha256(this.key));
      let currentSize = this.logBytes;
      if (shouldCompact(this.limits, this.baselineBytes, this.records.length, currentSize, bytes.length)) {
        await this.compactInternal();
        currentSize = this.logBytes;
      }
      if (this.records.length >= this.limits.maxRecords) {
        throw writeFailure("recovery log exceeds its record limit", null, this.originals());
      }
      if (currentSize + bytes.length > this.limits.maxLogBytes) {
        throw writeFailure("recovery log exceeds its byte limit", null, this.originals());
      }
      if (this.logHandle === null || this.logPath === null) throw writeFailure("recovery log is not open", null, this.originals());
      try {
        let writtenTotal = 0;
        while (writtenTotal < bytes.length) {
          const written = await this.logHandle.write(bytes, writtenTotal, bytes.length - writtenTotal, currentSize + writtenTotal);
          if (written.bytesWritten <= 0) throw new Error("short recovery log write");
          writtenTotal += written.bytesWritten;
        }
        await this.logHandle.sync();
      } catch (error) {
        const failure = writeFailure("could not durably append recovery record", error, this.originals());
        this.failure = failure;
        throw failure;
      }
      this.logBytes += bytes.length;
      this.records.push(encoded.record);
      this.physicalBytesSha256 = sourceDelta.resultSha256;
      this.status = "recovered";
      this.latestFingerprint = input.fingerprint ?? encoded.record.sha256;
      return jsonClone(encoded.record);
    });
  }

  /** Waits for prior operations and fsyncs the active log again. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.logHandle === null) return;
      try {
        await this.logHandle.sync();
      } catch (error) {
        const failure = writeFailure("could not flush recovery log", error, this.originals());
        this.failure = failure;
        throw failure;
      }
    });
  }

  /** Installs a complete baseline/log generation after lazy source replay. */
  private async compactInternal(replacementInput?: RecoveryBaseline): Promise<RecoveryState> {
    const currentRevision = this.documentRevision();
    let replacement: RecoveryBaseline;
    if (replacementInput !== undefined) {
      try {
        replacement = normalizeBaseline(replacementInput, this.limits);
      } catch (error) {
        throw writeFailure("checkpoint baseline is invalid", error, this.originals());
      }
      if (replacement.documentRevision !== currentRevision) {
        throw writeFailure("checkpoint baseline has the wrong revision", null, this.originals());
      }
    } else if (this.records.length === 0) {
      replacement = normalizeBaseline(this.baseline, this.limits);
    } else {
      try {
        replacement = materializeBaseline(this.baseline, this.records, this.limits);
      } catch (error) {
        if (error instanceof RecoveryError) {
          throw writeFailure("compaction requires a complete materialized source baseline", error, this.originals());
        }
        throw writeFailure("compaction could not materialize its baseline", error, this.originals());
      }
      if (replacement.documentRevision !== currentRevision) {
        throw writeFailure("materialized compaction baseline has the wrong revision", null, this.originals());
      }
    }
    const keyHash = recoverySha256(this.key);
    const oldGeneration = this.generation;
    const oldPaths = oldGeneration === null ? null : generationPaths(this.directory, oldGeneration);
    const generation = randomUUID();
    const paths = generationPaths(this.directory, generation);
    let newHandle: FileHandleLike | null = null;
    let pointerPublished = false;
    try {
      const encodedBaseline = Buffer.from(canonicalEncode(storedBaseline(replacement)), "utf8");
      await atomicWrite(paths.baselinePath, encodedBaseline, 0o600, this.privatePathOptions);
      await atomicWrite(paths.logPath, Buffer.alloc(0), 0o600, this.privatePathOptions);
      // Pointer is switched only after both complete files have been fsynced.
      await this.writePointer(keyHash, generation);
      pointerPublished = true;
      newHandle = await openVerifiedFile(paths.logPath, constants.O_RDWR, this.privatePathOptions);
      const oldHandle = this.logHandle;
      this.logHandle = newHandle;
      newHandle = null;
      this.generation = generation;
      this.baselinePath = paths.baselinePath;
      this.logPath = paths.logPath;
      this.baseline = replacement;
      this.physicalBytesSha256 = baselinePhysicalSha256(replacement);
      this.baselineBytes = encodedBaseline.length;
      this.records = [];
      this.logBytes = 0;
      this.status = "clean";
      this.latestFingerprint = baselineFingerprint(replacement);
      if (oldHandle !== null) await oldHandle.close();
      if (oldPaths !== null) await unlinkGeneration(oldPaths);
      await syncDirectory(this.directory);
    } catch (error) {
      // atomicWrite can rename the pointer and then fail while syncing its
      // directory. Re-read it before deciding whether staged files are safe
      // to remove; a published generation must remain self-consistent.
      if (!pointerPublished) {
        try {
          const pointer = await this.readPointer(keyHash);
          pointerPublished = pointer.kind === "generation" && pointer.generation === generation;
        } catch {
          // Preserve the original publication error below.
        }
      }
      if (newHandle !== null) await newHandle.close().catch(() => undefined);
      if (!pointerPublished) {
        await rm(paths.baselinePath, { force: true }).catch(() => undefined);
        await rm(paths.logPath, { force: true }).catch(() => undefined);
      }
      const failure = error instanceof RecoveryError
        ? error
        : writeFailure("could not compact recovery generation", error, this.originals());
      this.failure = failure.code === "recovery_write_failed" ? failure : writeFailure(failure.message, failure, this.originals());
      throw this.failure;
    }
    return this.state();
  }

  /** Persist fresh source and sidecar observations without a new document revision. */
  checkpoint(input: RecoveryCheckpoint): Promise<RecoveryState> {
    return this.enqueue(async () => {
      if (!isRecord(input) || Object.keys(input).sort().join(",") !== "notebookDiskObservation,sidecarObservations") {
        throw invalid("recovery checkpoint input is invalid");
      }
      validateObservation(input.notebookDiskObservation, "checkpoint.notebookDiskObservation");
      let sidecars: RecoverySidecarObservations;
      try {
        sidecars = sidecarObservationsSchema.parse(input.sidecarObservations) as RecoverySidecarObservations;
      } catch {
        throw invalid("checkpoint.sidecarObservations does not match the protocol schema");
      }
      let current: RecoveryBaseline;
      try {
        current = materializeBaseline(this.baseline, this.records, this.limits);
      } catch (error) {
        throw writeFailure("checkpoint requires a complete materialized source baseline", error, this.originals());
      }
      const replacement = normalizeBaseline({
        ...current,
        notebookDiskObservation: input.notebookDiskObservation,
        sidecarObservations: sidecars,
      }, this.limits);
      return this.compactInternal(replacement);
    });
  }

  compact(): Promise<RecoveryState> {
    return this.enqueue(() => this.compactInternal());
  }

  /** Clears only an exact saved revision/fingerprint match. */
  clearIfMatch(input: { documentRevision: number; fingerprint: string }): Promise<boolean> {
    return this.enqueue(async () => {
      validateRevision(input?.documentRevision, "clearIfMatch.documentRevision");
      validateFingerprint(input?.fingerprint, "clearIfMatch.fingerprint");
      if (this.generation === null || input.documentRevision !== this.documentRevision()) return false;
      const expectedFingerprint = this.latestFingerprint ?? baselineFingerprint(this.baseline);
      if (input.fingerprint !== expectedFingerprint) return false;
      let replacement: RecoveryBaseline;
      try {
        replacement = this.records.length === 0
          ? normalizeBaseline(this.baseline, this.limits)
          : materializeBaseline(this.baseline, this.records, this.limits);
      } catch (error) {
        const failure = writeFailure("could not prove recovery clear state", error, this.originals());
        this.failure = failure;
        throw failure;
      }
      const oldGeneration = this.generation;
      const oldPaths = generationPaths(this.directory, oldGeneration);
      // The saved notebook is the authoritative durable copy. Switch to an
      // explicit empty pointer before removing stale recovery generations.
      await this.writePointer(recoverySha256(this.key), null);
      try {
        if (this.logHandle !== null) await this.logHandle.close();
        await unlinkGeneration(oldPaths);
        await syncDirectory(this.directory);
      } catch (error) {
        const failure = writeFailure("could not remove cleared recovery generation", error, [
          ...this.originals(),
          oldPaths.baselinePath,
          oldPaths.logPath,
        ]);
        this.failure = failure;
        throw failure;
      }
      this.logHandle = null;
      this.generation = null;
      this.baselinePath = null;
      this.logPath = null;
      this.baseline = replacement;
      this.physicalBytesSha256 = baselinePhysicalSha256(replacement);
      this.records = [];
      this.logBytes = 0;
      this.status = "empty";
      this.latestFingerprint = baselineFingerprint(replacement);
      return true;
    });
  }

  /** Flushes and closes without deleting durable recovery. */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closing = this.queue.then(async () => {
      let failure: unknown;
      try {
        if (this.logHandle !== null) await this.logHandle.sync();
      } catch (error) {
        failure = writeFailure("could not flush recovery log during close", error, this.originals());
      }
      try {
        if (this.logHandle !== null) await this.logHandle.close();
      } catch (error) {
        failure ??= writeFailure("could not close recovery log", error, this.originals());
      }
      this.logHandle = null;
      this.closed = true;
      if (failure !== undefined) {
        this.failure = failure instanceof RecoveryError ? failure : writeFailure("could not close recovery writer", failure, this.originals());
        throw this.failure;
      }
    }, async () => {
      this.closed = true;
    });
    return this.closing;
  }

  private async closeQuietly(): Promise<void> {
    try {
      if (this.logHandle !== null) await this.logHandle.close();
    } catch {
      // Initialization already failed; preserving files is more important than
      // masking the original typed failure.
    } finally {
      this.logHandle = null;
      this.closed = true;
    }
  }
}

function initialBaselineFor(writer: RecoveryWriter): RecoveryBaseline {
  return writer.currentBaseline;
}

function baselineFingerprint(baseline: RecoveryBaseline): string {
  return recoverySha256(baseline);
}

interface RecoveryByteSegment {
  source: Uint8Array;
  offset: number;
  length: number;
}

interface RecoveryByteView {
  segments: RecoveryByteSegment[];
  length: number;
  sha256: string;
}

function appendByteSegment(
  output: RecoveryByteSegment[],
  source: Uint8Array,
  offset: number,
  length: number,
): void {
  if (length === 0) return;
  const previous = output.at(-1);
  if (previous !== undefined && previous.source === source && previous.offset + previous.length === offset) {
    previous.length += length;
    return;
  }
  output.push({ source, offset, length });
}

function appendViewRange(
  output: RecoveryByteSegment[],
  view: RecoveryByteView,
  start: number,
  length: number,
): void {
  if (length === 0) return;
  let cursor = 0;
  let remaining = length;
  for (const segment of view.segments) {
    const segmentEnd = cursor + segment.length;
    if (segmentEnd <= start) {
      cursor = segmentEnd;
      continue;
    }
    const begin = Math.max(start, cursor);
    const take = Math.min(segmentEnd - begin, remaining);
    appendByteSegment(output, segment.source, segment.offset + begin - cursor, take);
    remaining -= take;
    if (remaining === 0) return;
    cursor = segmentEnd;
  }
  throw invalid("recovery source copy range is outside its base");
}

function applySourceSegments(view: RecoveryByteView, delta: RecoverySourceDelta): RecoveryByteView {
  if (view.length !== delta.baseLength || view.sha256 !== delta.baseSha256) {
    throw invalid("recovery source delta does not match its base bytes");
  }
  const segments: RecoveryByteSegment[] = [];
  let length = 0;
  for (const piece of delta.pieces) {
    if (piece.kind === "copy") {
      appendViewRange(segments, view, piece.offset, piece.length);
      length += piece.length;
    } else {
      const literal = decodeBase64(piece.data, "recovery delta literal data");
      appendByteSegment(segments, literal, 0, literal.byteLength);
      length += literal.byteLength;
    }
  }
  if (length !== delta.resultLength) throw invalid("recovery source delta result length is invalid");
  return { segments, length, sha256: delta.resultSha256 };
}

function flattenByteView(view: RecoveryByteView): Uint8Array {
  const result = new Uint8Array(view.length);
  let offset = 0;
  for (const segment of view.segments) {
    result.set(segment.source.subarray(segment.offset, segment.offset + segment.length), offset);
    offset += segment.length;
  }
  if (offset !== result.byteLength || physicalSha256(result) !== view.sha256) {
    throw invalid("recovery source delta result bytes are invalid");
  }
  return result;
}

function applySourceProjection(
  baseline: RecoveryBaseline,
  delta: RecoverySourceDelta,
  toRevision: number,
): RecoveryBaseline {
  const result: RecoveryBaseline = {
    schemaVersion: 1,
    documentRevision: toRevision,
    physicalBytes: baseline.physicalBytes,
    cells: delta.cells,
    notebookDiskObservation: Object.prototype.hasOwnProperty.call(delta, "notebookDiskObservation")
      ? delta.notebookDiskObservation : baseline.notebookDiskObservation,
    sidecarObservations: Object.prototype.hasOwnProperty.call(delta, "sidecarObservations")
      ? delta.sidecarObservations : baseline.sidecarObservations,
  };
  const path = Object.prototype.hasOwnProperty.call(delta, "path") ? delta.path : baseline.path;
  if (path !== undefined) result.path = path;
  const project = Object.prototype.hasOwnProperty.call(delta, "project") ? delta.project : baseline.project;
  if (project !== undefined) result.project = project;
  const config = Object.prototype.hasOwnProperty.call(delta, "config") ? delta.config : baseline.config;
  if (config !== undefined) result.config = config;
  const layout = Object.prototype.hasOwnProperty.call(delta, "layout") ? delta.layout : baseline.layout;
  if (layout !== undefined) result.layout = layout;
  const packageDeclarationIntent = Object.prototype.hasOwnProperty.call(delta, "packageDeclarationIntent")
    ? delta.packageDeclarationIntent : baseline.packageDeclarationIntent;
  if (packageDeclarationIntent !== undefined) result.packageDeclarationIntent = packageDeclarationIntent;
  return result;
}

function materializeBaseline(
  initial: RecoveryBaseline,
  records: readonly RecoveryRecord[],
  limits: Required<RecoveryLimits>,
): RecoveryBaseline {
  let current = normalizeBaseline(initial, limits);
  const initialBytes = decodeBase64(current.physicalBytes as string, "baseline.physicalBytes");
  let view: RecoveryByteView = {
    segments: [{ source: initialBytes, offset: 0, length: initialBytes.byteLength }],
    length: initialBytes.byteLength,
    sha256: physicalSha256(initialBytes),
  };
  for (const record of records) {
    const delta = normalizeSourceDelta(record.delta);
    view = applySourceSegments(view, delta);
    current = applySourceProjection(current, delta, record.toRevision);
  }
  return normalizeBaseline({ ...current, physicalBytes: binaryBase64(flattenByteView(view)) }, limits);
}
