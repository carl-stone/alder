import {
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  MAX_SOURCE_LINE_LENGTH,
  MAX_SOURCE_LINES,
} from "./protocol.js";
import { parseYamlMapping } from "./configuration.js";
import { stringify as stringifyYaml } from "yaml";
import { canonicalizeCellBody, markdownPhysicalLinesEqual, toLogicalCellBody, toPhysicalCellBody } from "./cell-body.js";
import type { CellOption, CellRef, DocumentChange } from "./protocol.js";
export type NotebookRecordKind = "header" | "delimiter" | "option" | "body";

/** A physical source record. `originalBytes` is retained for untouched writes. */
export interface NotebookRecord {
  readonly text: string;
  readonly eol?: string;
  readonly kind: NotebookRecordKind | string;
  readonly originalBytes?: Readonly<Uint8Array>;
  readonly originalText?: string;
  readonly originalEol?: string;
  /** Current encoded bytes; present for records created or edited by this codec. */
  readonly bytes?: Readonly<Uint8Array>;
}

/** The host's sole document projection used by LSP and persistence. */
export interface NotebookCellDocument {
  readonly id: string;
  readonly revision?: number;
  readonly type?: "code" | "markdown";
  readonly body: readonly string[];
  readonly delim?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly records?: readonly NotebookRecord[];
  readonly raw?: readonly string[];
  readonly optionDuplicates?: Readonly<Record<string, readonly number[]>>;
}

export interface NotebookDocument {
  readonly path?: string | null;
  /** A decoded convenience projection. Physical records remain authoritative. */
  readonly text?: string;
  readonly cells: readonly NotebookCellDocument[];
  readonly header?: readonly string[];
  readonly headerRecords?: readonly NotebookRecord[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly preferredEol?: string;
  readonly finalNewline?: boolean;
  readonly nextCellNumber?: number;
  /** True for a UTF-8 BOM; a byte slice is also accepted for external callers. */
  readonly bom?: boolean | Readonly<Uint8Array>;
}

/** Ordered cell identity/revision state persisted by durable recovery. */
export interface NotebookCellIdentity {
  readonly id: string;
  readonly revision: number;
}

/** One exact serialized physical source span. */
export interface SerializedNotebookPart {
  readonly bytes: Readonly<Uint8Array>;
  /** The physical record that produced this span; absent only for a BOM. */
  readonly record?: NotebookRecord;
}

export interface SerializedNotebook {
  readonly bytes: Uint8Array;
  readonly parts: readonly SerializedNotebookPart[];
}
export interface SourceCell {
  id: string;
  type: "code" | "markdown";
  body: string[];
  options?: Record<string, unknown>;
  revision?: number;
}

export interface SourceNotebook {
  path?: string | null;
  metadata?: Record<string, unknown>;
  cells: SourceCell[];
}

export interface CellPosition {
  cell: string;
  line: number;
  character: number;
}

export interface CellRange {
  start: CellPosition;
  end: CellPosition;
}

export interface NotebookLayout {
  text: string;
  lineMap: Array<{ cell: string; line: number } | null>;
  cellLines: Map<string, number[]>;
}

export type NotebookErrorCode =
  | "invalid_input"
  | "notebook_too_large"
  | "too_many_cells"
  | "too_many_lines"
  | "line_too_long"
  | "embedded_nul"
  | "invalid_utf8"
  | "malformed_metadata"
  | "metadata_not_mapping"
  | "invalid_markdown"
  | "invalid_cell_type"
  | "cell_not_found"
  | "invalid_option_key"
  | "invalid_option_value"
  | "invalid_metadata_key"
  | 'stale_revision'
  | "invalid_document";

export class NotebookError extends Error {
  readonly code: NotebookErrorCode;
  readonly cause?: unknown;

  constructor(code: NotebookErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "NotebookError";
    this.code = code;
    this.cause = cause;
  }
}

export class NotebookCodecError extends NotebookError {}
export class NotebookParseError extends NotebookError {}
export class NotebookMutationError extends NotebookError {}

interface InternalRecord extends NotebookRecord {
  readonly eol: string;
  readonly originalBytes?: Readonly<Uint8Array>;
  readonly originalText?: string;
  readonly originalEol?: string;
  readonly bytes?: Readonly<Uint8Array>;
  readonly currentText?: string;
  readonly currentEol?: string;
}

interface InternalCell extends NotebookCellDocument {
  readonly id: string;
  readonly type: "code" | "markdown";
  readonly delim: string;
  readonly body: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly records: readonly InternalRecord[];
  readonly raw: readonly string[];
  readonly optionDuplicates: Readonly<Record<string, readonly number[]>>;
}

interface InternalDocument extends NotebookDocument {
  readonly cells: readonly InternalCell[];
  readonly header: readonly string[];
  readonly headerRecords: readonly InternalRecord[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly preferredEol: string;
  readonly finalNewline: boolean;
  readonly nextCellNumber: number;
  readonly bom: boolean | Readonly<Uint8Array>;
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const EOLS = new Set(["", "\n", "\r", "\r\n"]);
const textEncoder = new TextEncoder();
const delimiterPattern = /^\s*#\s*%%(\s|$)/;
const markdownDelimiterPattern = /^\s*#\s*%%\s*(.*)$/;
const optionPattern = /^\s*#\|/;
const metadataFencePattern = /^\s*#\s*---\s*$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withPath(message: string, path: string | null): string {
  return path === null ? message : `${message}: ${path}`;
}

function throwParse(
  code: NotebookErrorCode,
  message: string,
  path: string | null,
  cause?: unknown,
): never {
  throw new NotebookParseError(code, withPath(message, path), cause);
}

function isUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateSourceLine(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new NotebookMutationError("invalid_input", `${label} must contain strings`);
  }
  if (isUnpairedSurrogate(value)) {
    throw new NotebookMutationError("invalid_input", `${label} must contain valid Unicode`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new NotebookMutationError("invalid_input", `${label} cannot contain line breaks`);
  }
  if (value.includes("\u0000")) {
    throw new NotebookMutationError("embedded_nul", `${label} contains an embedded NUL`);
  }
  if (value.length > MAX_SOURCE_LINE_LENGTH || utf8Length(value) > MAX_SOURCE_LINE_LENGTH) {
    throw new NotebookMutationError(
      "line_too_long",
      `${label} exceeds ${MAX_SOURCE_LINE_LENGTH} bytes`,
    );
  }
}

function validateBody(body: readonly string[], id: string): string[] {
  if (!Array.isArray(body)) {
    throw new NotebookMutationError("invalid_input", `cell body must be an array: ${id}`);
  }
  if (body.length > MAX_SOURCE_LINES) {
    throw new NotebookMutationError(
      "too_many_lines",
      `cell ${id} exceeds ${MAX_SOURCE_LINES} source lines`,
    );
  }
  const result = new Array<string>(body.length);
  for (let index = 0; index < body.length; index += 1) {
    validateSourceLine(body[index], `cell ${id} source line ${index + 1}`);
    result[index] = body[index]!;
  }
  return result;
}

function validateMarkdown(body: readonly string[], id: string): void {
  for (const line of body) {
    if (line.trim().length !== 0 && !/^\s*#/.test(line)) {
      throw new NotebookMutationError(
        "invalid_markdown",
        `markdown cell lines must be blank or R comments: ${id}`,
      );
    }
  }
}

function validateCellType(type: unknown): asserts type is "code" | "markdown" {
  if (type !== "code" && type !== "markdown") {
    throw new NotebookMutationError(
      "invalid_cell_type",
      'invalid cell type; must be "code" or "markdown"',
    );
  }
}

function validateIdentifier(id: unknown, label: string): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || isUnpairedSurrogate(id)
    || id.length > 256 || utf8Length(id) > 256 || /[\u0000-\u001f\u007f\r\n]/.test(id)) {
    throw new NotebookMutationError("invalid_input", `${label} must be a non-empty identifier`);
  }
}

function cloneValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
      throw new NotebookMutationError("invalid_input", "metadata contains an unsupported value");
    }
    return value;
  }
  if (seen.has(value)) {
    throw new NotebookMutationError("invalid_input", "metadata contains a cyclic value");
  }
  if (Array.isArray(value)) {
    seen.set(value, value);
    const copy = value.map((item) => cloneValue(item, seen));
    seen.delete(value);
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NotebookMutationError("invalid_input", "metadata must contain plain values");
  }
  seen.set(value, value);
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item, seen);
  seen.delete(value);
  return copy;
}

function cloneRecordMap(value: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const cloned = cloneValue(value);
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new NotebookMutationError("invalid_input", "expected a plain object");
  }
  return cloned as Record<string, unknown>;
}

function equalValue(left: unknown, right: unknown, seen = new Set<object>()): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (seen.has(left) || seen.has(right)) return false;
  seen.add(left);
  seen.add(right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => equalValue(value, right[index], seen));
  }
  const leftProto = Object.getPrototypeOf(left);
  const rightProto = Object.getPrototypeOf(right);
  if ((leftProto !== Object.prototype && leftProto !== null)
    || (rightProto !== Object.prototype && rightProto !== null)) return false;
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right as Record<string, unknown>, key)
    && equalValue(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      seen,
    ));
}

function equalRecordMap(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return equalValue(left ?? {}, right ?? {});
}

function makeRecord(
  text: string,
  eol: string,
  kind: NotebookRecordKind | string,
  originalBytes?: Readonly<Uint8Array>,
  originalText?: string,
  originalEol?: string,
): InternalRecord {
  const record: InternalRecord = {
    text,
    eol,
    kind,
    ...(originalBytes === undefined ? {} : { originalBytes }),
    ...(originalText === undefined ? {} : { originalText }),
    ...(originalEol === undefined ? {} : { originalEol }),
  };
  if (originalBytes === undefined) {
    const bytes = textEncoder.encode(`${text}${eol}`);
    return { ...record, bytes, currentText: text, currentEol: eol };
  }
  return { ...record, bytes: originalBytes, currentText: text, currentEol: eol };
}

function rewriteRecord(record: InternalRecord, text: string, eol = record.eol): InternalRecord {
  if (record.text === text && record.eol === eol) return record;
  if (!EOLS.has(eol)) {
    throw new NotebookMutationError("invalid_input", "record EOL must be LF, CRLF, CR, or empty");
  }
  const bytes = textEncoder.encode(`${text}${eol}`);
  return {
    ...record,
    text,
    eol,
    bytes,
    currentText: text,
    currentEol: eol,
  };
}

function recordBytes(record: NotebookRecord, preferredEol: string): Readonly<Uint8Array> {
  const internal = record as InternalRecord;
  const eol = record.eol ?? preferredEol;
  if (!EOLS.has(eol)) {
    throw new NotebookError("invalid_document", "record EOL must be LF, CRLF, CR, or empty");
  }
  if (internal.bytes !== undefined && internal.currentText === record.text && internal.currentEol === eol) {
    return internal.bytes;
  }
  if (record.originalBytes !== undefined
    && record.originalText === record.text
    && (record.originalEol ?? "") === eol) {
    return record.originalBytes;
  }
  return textEncoder.encode(`${record.text}${eol}`);
}

function recordsForCell(cell: NotebookCellDocument, preferredEol: string): InternalRecord[] {
  if (cell.records !== undefined) {
    return cell.records.map((record) => {
      const eol = record.eol ?? preferredEol;
      if (!EOLS.has(eol)) {
        throw new NotebookMutationError("invalid_document", "record EOL must be LF, CRLF, CR, or empty");
      }
      return record as InternalRecord;
    });
  }
  const type = cell.type ?? "code";
  validateCellType(type);
  const delim = cell.delim ?? (type === "markdown" ? "# %% [markdown]" : "# %%");
  const body = validateBody(cell.body, cell.id);
  const options = cell.options ?? {};
  const records: InternalRecord[] = [makeRecord(delim, preferredEol, "delimiter")];
  for (const [key, value] of Object.entries(options)) {
    records.push(makeRecord(serializeCellOption(key, value), preferredEol, "option"));
  }
  for (const line of body) records.push(makeRecord(line, preferredEol, "body"));
  return records;
}

function headerRecordsFor(document: NotebookDocument, preferredEol: string): InternalRecord[] {
  if (document.headerRecords !== undefined) {
    return document.headerRecords.map((record) => {
      const eol = record.eol ?? preferredEol;
      if (!EOLS.has(eol)) {
        throw new NotebookMutationError("invalid_document", "record EOL must be LF, CRLF, CR, or empty");
      }
      return record as InternalRecord;
    });
  }
  return (document.header ?? []).map((line) => makeRecord(line, preferredEol, "header"));
}

function effectivePreferredEol(document: NotebookDocument): string {
  const candidate = document.preferredEol ?? "\n";
  if (!EOLS.has(candidate) || candidate === "") {
    throw new NotebookMutationError("invalid_document", "preferred EOL must be LF, CRLF, or CR");
  }
  return candidate;
}

function effectiveFinalNewline(document: NotebookDocument): boolean {
  return document.finalNewline ?? true;
}

function effectiveMetadata(document: NotebookDocument): Readonly<Record<string, unknown>> {
  return document.metadata ?? {};
}

function effectiveNextCellNumber(document: NotebookDocument): number {
  const supplied = document.nextCellNumber;
  if (supplied !== undefined && Number.isSafeInteger(supplied) && supplied >= 1) return supplied;
  let next = 1;
  for (const cell of document.cells) {
    const match = /^cell-([0-9]+)$/.exec(cell.id);
    if (match !== null) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number)) next = Math.max(next, number + 1);
    }
  }
  return next;
}

function hasBom(document: NotebookDocument): boolean {
  return document.bom === true
    || (document.bom instanceof Uint8Array && document.bom.byteLength !== 0);
}

function isDelimiter(text: string): boolean {
  return delimiterPattern.test(text);
}

function isMarkdownDelimiter(text: string): boolean {
  const match = markdownDelimiterPattern.exec(text);
  return match !== null && match[1]!.trim().toLowerCase() === "[markdown]";
}


function optionRecordKey(text: string): string {
  if (!optionPattern.test(text)) return "";
  const value = text.replace(/^\s*#\|\s*/, "");
  const colon = value.indexOf(":");
  return (colon < 0 ? value : value.slice(0, colon)).trim();
}

function parseOptionValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "true" || trimmed === "TRUE") return true;
  if (trimmed === "false" || trimmed === "FALSE") return false;
  return trimmed;
}

function parseOptions(records: readonly InternalRecord[]): {
  options: Record<string, unknown>;
  duplicates: Record<string, number[]>;
} {
  const options: Record<string, unknown> = Object.create(null);
  const positions: Record<string, number[]> = Object.create(null);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.kind !== "option") continue;
    const key = optionRecordKey(record.text);
    if (key.length === 0) continue;
    (positions[key] ??= []).push(index + 1);
    const value = record.text.replace(/^\s*#\|\s*/, "");
    const colon = value.indexOf(":");
    options[key] = parseOptionValue(colon < 0 ? "" : value.slice(colon + 1));
    if (colon < 0) options[key] = true;
  }
  const duplicates: Record<string, number[]> = Object.create(null);
  for (const [key, indices] of Object.entries(positions)) {
    if (indices.length > 1) duplicates[key] = indices;
  }
  return { options, duplicates };
}

function syncCell(
  cell: NotebookCellDocument,
  records: readonly InternalRecord[],
): InternalCell {
  if (records.length === 0 || records[0]!.kind !== "delimiter") {
    throw new NotebookMutationError("invalid_document", `cell has no delimiter: ${cell.id}`);
  }
  const delim = records[0]!.text;
  const type = isMarkdownDelimiter(delim) ? "markdown" : "code";
  const body: string[] = [];
  const raw: string[] = [];
  for (const record of records) {
    raw.push(record.text);
    if (record.kind === "body") body.push(record.text);
  }
  const parsed = parseOptions(records);
  if (type === "markdown") validateMarkdown(body, cell.id);
  const options = parsed.options;
  return {
    ...cell,
    type,
    delim,
    body,
    options,
    records,
    raw,
    optionDuplicates: parsed.duplicates,
  };
}

function parseCell(records: readonly InternalRecord[], id: string): InternalCell {
  const cell = syncCell({ id, body: [] }, records);
  return cell;
}

function parseHeaderMetadata(
  headerRecords: readonly InternalRecord[],
  path: string | null,
): Record<string, unknown> {
  const fences: number[] = [];
  for (let index = 0; index < headerRecords.length; index += 1) {
    if (metadataFencePattern.test(headerRecords[index]!.text)) fences.push(index);
  }
  if (fences.length === 0) return {};
  if (fences.length !== 2) throwParse("malformed_metadata", "notebook metadata must have exactly two fences", path);
  const start = fences[0]! + 1;
  const end = fences[1]! - 1;
  if (end < start) throwParse("malformed_metadata", "notebook metadata cannot be empty", path);
  const interior = headerRecords.slice(start, end + 1);
  if (!interior.every((record) => /^\s*#/.test(record.text))) {
    throwParse("malformed_metadata", "notebook metadata lines must be comments", path);
  }
  const yamlLines = interior.map((record) => record.text.replace(/^\s*#\s?/, ""));
  const text = yamlLines.join("\n");
  if (text.trim().length === 0) throwParse("malformed_metadata", "notebook metadata cannot be empty", path);
  try {
    const parsed = parseYamlMapping(text, "notebook metadata");
    return cloneRecordMap(parsed);
  } catch (error) {
    const raw = messageOf(error);
    const code: NotebookErrorCode = raw.toLowerCase().includes("mapping")
      || raw.toLowerCase().includes("root")
      ? "metadata_not_mapping"
      : "malformed_metadata";
    throwParse(code, raw || "malformed YAML metadata", path, error);
  }
}

function classifyRecords(records: InternalRecord[]): number[] {
  const delimiters: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isDelimiter(records[index]!.text)) delimiters.push(index);
  }
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      records[recordIndex] = { ...records[recordIndex]!, kind: "header" };
    }
  for (let cellIndex = 0; cellIndex < delimiters.length; cellIndex += 1) {
    const start = delimiters[cellIndex]!;
    const end = cellIndex + 1 < delimiters.length
      ? delimiters[cellIndex + 1]!
      : records.length;
    records[start] = { ...records[start]!, kind: "delimiter" };
    for (let index = start + 1; index < end; index += 1) {
      records[index] = {
        ...records[index]!,
        kind: optionPattern.test(records[index]!.text) ? "option" : "body",
      };
    }
  }
  return delimiters;
}

function validateParsedLines(records: readonly InternalRecord[], path: string | null): void {
  for (const record of records) {
    if (record.text.length > MAX_SOURCE_LINE_LENGTH || utf8Length(record.text) > MAX_SOURCE_LINE_LENGTH) {
      throwParse("line_too_long", `notebook source line exceeds ${MAX_SOURCE_LINE_LENGTH} bytes`, path);
    }
  }
}

export function parseNotebook(bytes: Uint8Array, path: string | null): NotebookDocument {
  if (!(bytes instanceof Uint8Array)) {
    throw new NotebookParseError("invalid_input", "notebook bytes must be a Uint8Array");
  }
  if (bytes.byteLength > MAX_NOTEBOOK_SOURCE_BYTES) {
    throwParse("notebook_too_large", "notebook exceeds the 32 MiB notebook limit", path);
  }
  const source = new Uint8Array(bytes);
  for (const byte of source) {
    if (byte === 0) throwParse("embedded_nul", "notebook contains an embedded NUL", path);
  }
  const bom = source.byteLength >= 3
    && source[0] === UTF8_BOM[0]
    && source[1] === UTF8_BOM[1]
    && source[2] === UTF8_BOM[2];
  const startOffset = bom ? 3 : 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(source);
  } catch (error) {
    throwParse("invalid_utf8", "notebook is not valid UTF-8", path, error);
  }

  const records: InternalRecord[] = [];
  let start = startOffset;
  let index = startOffset;
  while (index < source.byteLength) {
    const byte = source[index]!;
    if (byte !== 0x0a && byte !== 0x0d) {
      index += 1;
      continue;
    }
    const eolStart = index;
    let eolEnd = index + 1;
    let eol: string;
    if (byte === 0x0d && source[eolEnd] === 0x0a) {
      eolEnd += 1;
      eol = "\r\n";
    } else {
      eol = byte === 0x0d ? "\r" : "\n";
    }
    let text: string;
    try {
      text = decoder.decode(source.subarray(start, eolStart));
    } catch (error) {
      throwParse("invalid_utf8", "notebook is not valid UTF-8", path, error);
    }
    records.push(makeRecord(
      text,
      eol,
      "header",
      new Uint8Array(source.subarray(start, eolEnd)),
      text,
      eol,
    ));
    start = eolEnd;
    index = eolEnd;
  }
  if (start < source.byteLength) {
    let text: string;
    try {
      text = decoder.decode(source.subarray(start));
    } catch (error) {
      throwParse("invalid_utf8", "notebook is not valid UTF-8", path, error);
    }
    records.push(makeRecord(text, "", "header", new Uint8Array(source.subarray(start)), text, ""));
  }
  validateParsedLines(records, path);
  const delimiters = classifyRecords(records);
  if (delimiters.length > MAX_NOTEBOOK_CELLS) {
    throwParse("too_many_cells", `notebook exceeds ${MAX_NOTEBOOK_CELLS} cells`, path);
  }
  const headerEnd = delimiters.length > 0 ? delimiters[0]! : records.length;
  const headerRecords = records.slice(0, headerEnd);
  const cells: InternalCell[] = [];
  for (let cellIndex = 0; cellIndex < delimiters.length; cellIndex += 1) {
    const startIndex = delimiters[cellIndex]!;
    const endIndex = cellIndex + 1 < delimiters.length
      ? delimiters[cellIndex + 1]!
      : records.length;
    const cellRecords = records.slice(startIndex, endIndex);
    const cell = parseCell(cellRecords, `cell-${cellIndex + 1}`);
    if (cell.type === "markdown") validateMarkdown(cell.body, cell.id);
    if (cell.body.length > MAX_SOURCE_LINES) {
      throwParse("too_many_lines", `cell ${cell.id} exceeds ${MAX_SOURCE_LINES} source lines`, path);
    }
    cells.push(cell);
  }
  const firstEol = records.find((record) => record.eol.length > 0)?.eol ?? "\n";
  const finalNewline = records.length === 0 || records[records.length - 1]!.eol.length > 0;
  const metadata = parseHeaderMetadata(headerRecords, path);
  const decodedText = decoder.decode(source);
  const document: InternalDocument = {
    path,
    text: decodedText,
    cells,
    header: headerRecords.map((record) => record.text),
    headerRecords,
    metadata,
    preferredEol: firstEol,
    finalNewline,
    nextCellNumber: cells.reduce((next, cell) => {
      const match = /^cell-([0-9]+)$/.exec(cell.id);
      const number = match === null ? 0 : Number(match[1]);
      return Number.isSafeInteger(number) ? Math.max(next, number + 1) : next;
    }, 1),
    bom,
  };
  return document;
}

function normalizeBom(document: NotebookDocument): Uint8Array | null {
  if (!hasBom(document)) return null;
  if (document.bom instanceof Uint8Array) return new Uint8Array(document.bom);
  return UTF8_BOM;
}

function validateDocumentShape(document: NotebookDocument): void {
  if (document === null || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.cells)) {
    throw new NotebookError("invalid_document", "notebook document must contain cells");
  }
  if (document.header !== undefined && !Array.isArray(document.header)) {
    throw new NotebookError("invalid_document", "notebook header must be an array");
  }
  if (document.headerRecords !== undefined) {
    if (!Array.isArray(document.headerRecords)) throw new NotebookError("invalid_document", "notebook header records must be an array");
    for (const record of document.headerRecords) {
      if (record === null || typeof record !== "object" || Array.isArray(record)) throw new NotebookError("invalid_document", "notebook header record is invalid");
    }
  }
  for (const cell of document.cells) {
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) throw new NotebookError("invalid_document", "notebook cell is invalid");
    if (cell.body !== undefined && !Array.isArray(cell.body)) throw new NotebookError("invalid_document", "notebook cell body must be an array");
    if (cell.options !== undefined && (cell.options === null || typeof cell.options !== "object" || Array.isArray(cell.options) || (Object.getPrototypeOf(cell.options) !== Object.prototype && Object.getPrototypeOf(cell.options) !== null))) {
      throw new NotebookError("invalid_document", "notebook cell options must be a mapping");
    }
    if (cell.records !== undefined) {
      if (!Array.isArray(cell.records)) throw new NotebookError("invalid_document", "notebook cell records must be an array");
      for (const record of cell.records) {
        if (record === null || typeof record !== "object" || Array.isArray(record)) throw new NotebookError("invalid_document", "notebook cell record is invalid");
      }
    }
  }
}
function allPhysicalRecords(document: NotebookDocument): {
  header: InternalRecord[];
  cells: InternalRecord[][];
} {
  const preferredEol = effectivePreferredEol(document);
  const header = headerRecordsFor(document, preferredEol);
  const cells = document.cells.map((cell) => recordsForCell(cell, preferredEol));
  if (cells.length > MAX_NOTEBOOK_CELLS) {
    throw new NotebookError("too_many_cells", `notebook exceeds ${MAX_NOTEBOOK_CELLS} cells`);
  }
  return { header, cells };
}

function serializedPhysicalRecords(
  document: NotebookDocument,
  physical: { header: InternalRecord[]; cells: InternalRecord[][] },
): { header: InternalRecord[]; cells: InternalRecord[][] } {
  const header = physical.header.slice();
  const cells = physical.cells.map((records) => records.slice());
  const locations = new Map<InternalRecord, { header: boolean; index: number; cell?: number }>();
  header.forEach((record, index) => locations.set(record, { header: true, index }));
  cells.forEach((records, cell) => records.forEach((record, index) => locations.set(record, { header: false, index, cell })));
  const replace = (target: InternalRecord, next: InternalRecord): void => {
    const location = locations.get(target);
    if (location === undefined) throw new NotebookError("invalid_document", "physical record location is invalid");
    if (location.header) header[location.index] = next;
    else cells[location.cell!][location.index] = next;
  };
  const all = [...header, ...cells.flat()];
  const preferredEol = effectivePreferredEol(document);
  for (let index = 0; index < all.length - 1; index += 1) {
    const record = all[index]!;
    if (record.eol === "") replace(record, rewriteRecord(record, record.text, preferredEol));
  }
  const terminal = all.at(-1);
  if (terminal !== undefined) {
    const desired = effectiveFinalNewline(document)
      ? (terminal.eol === "" ? preferredEol : terminal.eol)
      : "";
    if (terminal.eol !== desired) replace(terminal, rewriteRecord(terminal, terminal.text, desired));
  }
  return { header, cells };
}
function validateDocumentForSerialization(document: NotebookDocument, physical: { header: InternalRecord[]; cells: InternalRecord[][] }): void {
  if (document === null || typeof document !== "object" || !Array.isArray(document.cells)) {
    throw new NotebookError("invalid_document", "notebook document must contain cells");
  }
  if (document.cells.length > MAX_NOTEBOOK_CELLS) {
    throw new NotebookError("too_many_cells", "notebook exceeds the notebook cell limit");
  }
  if (document.finalNewline !== undefined && typeof document.finalNewline !== "boolean") {
    throw new NotebookError("invalid_document", "finalNewline must be a boolean");
  }
  if (document.metadata !== undefined) cloneRecordMap(document.metadata);
  const ids = new Set<string>();
  for (let index = 0; index < document.cells.length; index += 1) {
    const cell = document.cells[index]!;
    validateIdentifier(cell.id, "cell id");
    if (ids.has(cell.id)) throw new NotebookError("invalid_document", "duplicate cell id: " + cell.id);
    ids.add(cell.id);
    const records = physical.cells[index]!;
    if (records.length === 0 || records[0]!.kind !== "delimiter") {
      throw new NotebookError("invalid_document", "cell has no delimiter: " + cell.id);
    }
    for (const record of records) {
      validateSourceLine(record.text, "cell " + cell.id + " record");
      if (!EOLS.has(record.eol)) throw new NotebookError("invalid_document", "record EOL is invalid");
    }
    const synced = syncCell(cell, records);
    if (synced.body.length > MAX_SOURCE_LINES) {
      throw new NotebookError("too_many_lines", "cell " + cell.id + " exceeds source line limit");
    }
    validateBody(synced.body, cell.id);
    if (synced.type === "markdown") validateMarkdown(synced.body, cell.id);
  }
  for (const record of physical.header) {
    validateSourceLine(record.text, "notebook header record");
    if (!EOLS.has(record.eol)) throw new NotebookError("invalid_document", "record EOL is invalid");
  }
  if (document.bom !== undefined && document.bom !== false && document.bom !== true) {
    if (!(document.bom instanceof Uint8Array) || document.bom.byteLength !== UTF8_BOM.byteLength
      || document.bom.some((byte, index) => byte !== UTF8_BOM[index])) {
      throw new NotebookError("invalid_document", "bom must be the UTF-8 BOM");
    }
  }
}

export function serializeNotebook(document: NotebookDocument): Uint8Array {
  return serializeNotebookWithParts(document).bytes;
}

/** Serialize once while retaining exact physical record spans for compact patches. */
export function serializeNotebookWithParts(document: NotebookDocument): SerializedNotebook {
  validateDocumentShape(document);
  const preferredEol = effectivePreferredEol(document);
  const physical = serializedPhysicalRecords(document, allPhysicalRecords(document));
  validateDocumentForSerialization(document, physical);
  const parts: SerializedNotebookPart[] = [];
  const bom = normalizeBom(document);
  if (bom !== null) parts.push({ bytes: bom });
  for (const record of physical.header) parts.push({ bytes: recordBytes(record, preferredEol), record });
  for (const records of physical.cells) {
    for (const record of records) parts.push({ bytes: recordBytes(record, preferredEol), record });
  }
  let size = 0;
  for (const part of parts) {
    size += part.bytes.byteLength;
    if (size > MAX_NOTEBOOK_SOURCE_BYTES) {
      throw new NotebookError("notebook_too_large", "notebook exceeds the 32 MiB notebook limit");
    }
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part.bytes, offset);
    offset += part.bytes.byteLength;
  }
  return { bytes: result, parts };
}

/** Reattach persisted cell IDs/revisions to a document parsed from exact bytes. */
export function restoreNotebookCellIdentity(
  document: NotebookDocument,
  identities: readonly NotebookCellIdentity[],
): NotebookDocument {
  if (!Array.isArray(identities) || identities.length !== document.cells.length) {
    throw new NotebookError("invalid_document", "recovery cell identity count does not match the notebook");
  }
  const ids = new Set<string>();
  const cells = document.cells.map((cell, index) => {
    const identity = identities[index];
    if (identity === undefined || typeof identity !== "object" || identity === null) {
      throw new NotebookError("invalid_document", "recovery cell identity is invalid");
    }
    validateIdentifier(identity.id, "recovery cell id");
    if (ids.has(identity.id)) throw new NotebookError("invalid_document", "recovery cell IDs are not unique");
    ids.add(identity.id);
    if (!Number.isSafeInteger(identity.revision) || identity.revision < 0) {
      throw new NotebookError("invalid_document", "recovery cell revision is invalid");
    }
    return { ...cell, id: identity.id, revision: identity.revision };
  });
  return { ...document, cells };
}
function cloneDocumentShallow(document: NotebookDocument): {
  document: NotebookDocument;
  cells: InternalCell[];
  header: InternalRecord[];
} {
  const preferredEol = effectivePreferredEol(document);
  const physical = allPhysicalRecords(document);
  const cells = document.cells.map((cell, index) => {
    const records = physical.cells[index]!;
    return syncCell(cell, records);
  });
  return {
    document: {
      ...document,
      text: undefined,
      cells,
      header: physical.header.map((record) => record.text),
      headerRecords: physical.header,
      metadata: effectiveMetadata(document),
      preferredEol,
      finalNewline: effectiveFinalNewline(document),
      nextCellNumber: effectiveNextCellNumber(document),
      bom: document.bom ?? false,
    },
    cells,
    header: physical.header,
  };
}

function documentWith(
  document: NotebookDocument,
  cells: readonly InternalCell[],
  headerRecords?: readonly InternalRecord[],
  extra: Record<string, unknown> = {},
): InternalDocument {
  const header = headerRecords ?? (document.headerRecords as readonly InternalRecord[] | undefined)
    ?? (document.header ?? []).map((line) => makeRecord(line, effectivePreferredEol(document), "header"));
  return {
    ...document,
    ...extra,
    text: undefined,
    cells,
    header: header.map((record) => record.text),
    headerRecords: header,
    metadata: (extra.metadata as Readonly<Record<string, unknown>> | undefined) ?? effectiveMetadata(document),
    preferredEol: (extra.preferredEol as string | undefined) ?? effectivePreferredEol(document),
    finalNewline: (extra.finalNewline as boolean | undefined) ?? effectiveFinalNewline(document),
    nextCellNumber: (extra.nextCellNumber as number | undefined) ?? effectiveNextCellNumber(document),
    bom: extra.bom as boolean | Readonly<Uint8Array> | undefined ?? document.bom ?? false,
  };
}

function terminalRecord(document: NotebookDocument): { where: "header" | "cell"; cell?: number; record: InternalRecord } | null {
  const physical = allPhysicalRecords(document);
  for (let cell = physical.cells.length - 1; cell >= 0; cell -= 1) {
    const records = physical.cells[cell]!;
    if (records.length > 0) return { where: "cell", cell, record: records[records.length - 1]! };
  }
  if (physical.header.length > 0) {
    return { where: "header", record: physical.header[physical.header.length - 1]! };
  }
  return null;
}



function normalizeBoundary(
  document: NotebookDocument,
  region: readonly number[] = [],
  headerChanged = false,
): InternalDocument {
  const preferredEol = effectivePreferredEol(document);
  const finalNewline = effectiveFinalNewline(document);
  const physical = allPhysicalRecords(document);
    const cellRecords = physical.cells.slice();
  const terminal = terminalRecord(document);
    const touched = new Set(region.filter((index) => index >= 0 && index < cellRecords.length));
  if (headerChanged && !finalNewline && physical.header.length > 0) {
    const last = physical.header.length - 1;
    if (physical.header[last]!.eol === "") {
      const header = physical.header.slice();
      header[last] = rewriteRecord(header[last]!, header[last]!.text, preferredEol);
      return normalizeBoundary(
        documentWith(document, cellRecords.map((records, index) => syncCell(document.cells[index]!, records)), header),
        [...touched],
        false,
      );
    }
  }
  for (const index of touched) {
        const records = cellRecords[index]!.slice();
    const terminalIndex = terminal?.where === "cell" && terminal.cell === index
      ? records.length - 1
      : -1;
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      if (records[recordIndex]!.eol === "" && recordIndex !== terminalIndex) {
        records[recordIndex] = rewriteRecord(records[recordIndex]!, records[recordIndex]!.text, preferredEol);
      }
    }
        cellRecords[index] = records;
  }
  if (!finalNewline && terminal !== null) {
    const nextPhysical = { header: physical.header, cells: cellRecords };
    const nextTerminal = nextPhysical.cells.length > 0
      ? { where: "cell" as const, cell: nextPhysical.cells.length - 1, record: nextPhysical.cells.at(-1)!.at(-1)! }
      : nextPhysical.header.length > 0
        ? { where: "header" as const, record: nextPhysical.header.at(-1)! }
        : null;
    if (nextTerminal !== null && nextTerminal.record.eol !== "") {
      if (nextTerminal.where === "cell") {
        const records = cellRecords[nextTerminal.cell!]!.slice();
        records[records.length - 1] = rewriteRecord(records.at(-1)!, records.at(-1)!.text, "");
        cellRecords[nextTerminal.cell!] = records;
      } else {
        const header = physical.header.slice();
        header[header.length - 1] = rewriteRecord(header.at(-1)!, header.at(-1)!.text, "");
        return documentWith(document, cellRecords.map((records, index) => syncCell(document.cells[index]!, records)), header);
      }
    }
  }
  return documentWith(document, cellRecords.map((records, index) => syncCell(document.cells[index]!, records)), physical.header);
}

function spliceBodyRecords(
  records: readonly InternalRecord[],
  body: readonly string[],
  preferredEol: string,
  cellType: "code" | "markdown" = "code",
): InternalRecord[] {
  const current = records.slice();
  const bodyPositions = current
    .map((record, index) => record.kind === "body" ? index : -1)
    .filter((index) => index >= 0);
  const optionPositions = current
    .map((record, index) => record.kind === "option" ? index : -1)
    .filter((index) => index >= 0);
  if (bodyPositions.length === 0) {
    if (body.length === 0) return current;
    const extra = body.map((line) => makeRecord(line, preferredEol, "body"));
    const anchor = optionPositions.length > 0 ? optionPositions.at(-1)! : 0;
    current.splice(anchor + 1, 0, ...extra);
    return current;
  }
  let prefix = 0;
  let suffix = 0;
  if (cellType === "markdown") {
    const shared = Math.min(bodyPositions.length, body.length);
    while (prefix < shared
      && markdownPhysicalLinesEqual(current[bodyPositions[prefix]!]!.text, body[prefix]!)) prefix += 1;
    while (suffix < shared - prefix
      && markdownPhysicalLinesEqual(
        current[bodyPositions[bodyPositions.length - suffix - 1]!]!.text,
        body[body.length - suffix - 1]!,
      )) suffix += 1;
  }
  const nextBodyRecords: InternalRecord[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (index < prefix) {
      nextBodyRecords.push(current[bodyPositions[index]!]!);
      continue;
    }
    if (index >= body.length - suffix) {
      const oldIndex = bodyPositions.length - (body.length - index);
      nextBodyRecords.push(current[bodyPositions[oldIndex]!]!);
      continue;
    }
    const oldRecord = bodyPositions[index] === undefined ? null : current[bodyPositions[index]!]!;
    if (cellType === "markdown" && oldRecord !== null
      && markdownPhysicalLinesEqual(oldRecord.text, body[index]!)) {
      nextBodyRecords.push(oldRecord);
      continue;
    }
    nextBodyRecords.push(oldRecord === null
      ? makeRecord(body[index]!, preferredEol, "body")
      : rewriteRecord(oldRecord, body[index]!));
  }
  const next: InternalRecord[] = [];
  let bodyIndex = 0;
  const lastBodyPosition = bodyPositions.at(-1) ?? -1;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]!.kind === "body") {
      if (bodyIndex < nextBodyRecords.length) next.push(nextBodyRecords[bodyIndex]!);
      bodyIndex += 1;
    } else {
      next.push(current[index]!);
    }
    if (index === lastBodyPosition) {
      while (bodyIndex < nextBodyRecords.length) next.push(nextBodyRecords[bodyIndex++]!);
    }
  }
  return next;
}

function requireCell(document: NotebookDocument, id: string): { index: number; cell: InternalCell } {
  validateIdentifier(id, "cell id");
  const physical = allPhysicalRecords(document);
  for (let index = 0; index < document.cells.length; index += 1) {
    if (document.cells[index]!.id === id) {
      return { index, cell: syncCell(document.cells[index]!, physical.cells[index]!) };
    }
  }
  throw new NotebookMutationError("cell_not_found", `no such cell: ${id}`);
}

function applyRecordsAt(
  document: NotebookDocument,
  index: number,
  records: readonly InternalRecord[],
  region: readonly number[] = [index],
): NotebookDocument {
  const physical = allPhysicalRecords(document);
  const cells = document.cells.map((cell, cellIndex) => cellIndex === index
    ? syncCell(cell, records)
    : syncCell(cell, physical.cells[cellIndex]!));
  return normalizeBoundary(documentWith(document, cells, physical.header), region);
}

export function updateCell(
  document: NotebookDocument,
  id: string,
  body: readonly string[] | string,
  type: "code" | "markdown",
): NotebookDocument {
  validateCellType(type);
  const bodyArray = typeof body === "string" ? [body] : validateBody(body, id);
  if (typeof body === "string") validateSourceLine(body, `cell ${id} source line 1`);
  if (bodyArray.length > MAX_SOURCE_LINES) {
    throw new NotebookMutationError("too_many_lines", `cell ${id} exceeds ${MAX_SOURCE_LINES} source lines`);
  }
  if (type === "markdown") validateMarkdown(bodyArray, id);
  const { index, cell } = requireCell(document, id);
  const currentBody = [...cell.body];
  if (cell.type === type && currentBody.length === bodyArray.length
    && currentBody.every((line, lineIndex) => line === bodyArray[lineIndex])) return document;
  const preferredEol = effectivePreferredEol(document);
  let records = spliceBodyRecords(cell.records, canonicalizeCellBody(type, bodyArray), preferredEol, type);
  const currentType = isMarkdownDelimiter(records[0]!.text) ? "markdown" : "code";
  if (currentType !== type) {
    records[0] = rewriteRecord(records[0]!, type === "markdown" ? "# %% [markdown]" : "# %%");
  }
  return applyRecordsAt(document, index, records, [index]);
}

function serializeCellOption(key: string, value: unknown): string {
  if (typeof key !== "string" || key.trim().length === 0 || key !== key.trim() || /[:\r\n]/.test(key)) {
    throw new NotebookMutationError(
      "invalid_option_key",
      "cell option key must be canonical, non-empty, and contain no ':'",
    );
  }
  if (key === "name" && (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(value))) {
    throw new NotebookMutationError("invalid_option_value", "cell name must match ^[A-Za-z][A-Za-z0-9_.]*$");
  }
  if (value === null || value === undefined || typeof value === "object"
    || typeof value === "function" || typeof value === "symbol") {
    throw new NotebookMutationError(
      "invalid_option_value",
      "cell option value must be logical, character, or numeric",
    );
  }
  let rendered: string;
  if (typeof value === "boolean") rendered = value ? "true" : "false";
  else if (typeof value === "string") rendered = value;
  else if (typeof value === "number" && Number.isFinite(value)) rendered = String(value);
  else {
    throw new NotebookMutationError(
      "invalid_option_value",
      "cell option value must be logical, character, or numeric",
    );
  }
  if (isUnpairedSurrogate(rendered) || /[\r\n\u0000]/.test(rendered)) {
    throw new NotebookMutationError("invalid_option_value", "cell option value must be a single line");
  }
  if (utf8Length(rendered) > MAX_SOURCE_LINE_LENGTH) {
    throw new NotebookMutationError("line_too_long", "cell option value exceeds source line limit");
  }
  return `#| ${key.trim()}: ${rendered}`;
}

function updateOptionRecords(
  records: readonly InternalRecord[],
  key: string,
  value: unknown | null,
  preferredEol: string,
): InternalRecord[] {
  const positions = records
    .map((record, index) => optionRecordKey(record.text) === key ? index : -1)
    .filter((index) => index >= 0);
  const next = records.slice();
  if (value === null) {
    for (const position of positions.sort((left, right) => right - left)) next.splice(position, 1);
    return next;
  }
  const text = serializeCellOption(key, value);
  if (positions.length > 0) {
    const position = positions.at(-1)!;
    next[position] = rewriteRecord(next[position]!, text);
    return next;
  }
  let eol = next[0]?.eol ?? preferredEol;
  if (eol === "") eol = next.find((record) => record.eol !== "")?.eol ?? preferredEol;
  next.splice(1, 0, makeRecord(text, eol, "option"));
  return next;
}

function validateMetadataKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) {
    throw new NotebookMutationError("invalid_metadata_key", "metadata key must be a non-empty scalar");
  }
}

function metadataRecords(metadata: Readonly<Record<string, unknown>>, eol: string): InternalRecord[] {
  if (Object.keys(metadata).length === 0) return [];
  let rendered: string;
  try {
    rendered = stringifyYaml(metadata, { aliasDuplicateObjects: false, lineWidth: 0 });
  } catch (error) {
    throw new NotebookMutationError("invalid_input", `metadata cannot be serialized: ${messageOf(error)}`, error);
  }
  rendered = rendered.replace(/(?:\r\n|\r|\n)+$/, "");
  if (rendered.length === 0) return [];
  return rendered.split("\n").map((line) => makeRecord(line.length > 0 ? `# ${line}` : "#", eol, "header"));
}

export function setMetadata(
  document: NotebookDocument,
  key: string,
  value: unknown | null,
): NotebookDocument {
  validateMetadataKey(key);
  const metadata = cloneRecordMap(effectiveMetadata(document));
  if (value === null) {
    if (!Object.hasOwn(metadata, key)) return document;
    delete metadata[key];
  } else {
    const nextValue = cloneValue(value);
    if (equalValue(metadata[key], nextValue)) return document;
    metadata[key] = nextValue;
  }
  const preferredEol = effectivePreferredEol(document);
  const physical = allPhysicalRecords(document);
  const header = physical.header.slice();
  const fences: number[] = [];
  for (let index = 0; index < header.length; index += 1) {
    if (metadataFencePattern.test(header[index]!.text)) fences.push(index);
  }
  const eol = fences.length > 0 && header[fences[0]!]!.eol !== ""
    ? header[fences[0]!]!.eol
    : preferredEol;
  const interior = metadataRecords(metadata, eol);
  let nextHeader: InternalRecord[];
  if (fences.length >= 2) {
    nextHeader = [
      ...header.slice(0, fences[0]! + 1),
      ...interior,
      ...header.slice(fences[1]!),
    ];
  } else {
    nextHeader = [
      makeRecord("# ---", eol, "header"),
      ...interior,
      makeRecord("# ---", eol, "header"),
      ...header,
    ];
  }
  const next = documentWith(document, physical.cells.map((records, index) =>
    syncCell(document.cells[index]!, records)), nextHeader, { metadata });
  return normalizeBoundary(next, [], true);
}

export const setNotebookMetadata = setMetadata;

export function setCellOption(
  document: NotebookDocument,
  id: string,
  key: string,
  value: unknown | null,
): NotebookDocument {
  if (typeof key !== "string") {
    throw new NotebookMutationError("invalid_option_key", "cell option key must be a non-empty scalar without ':'");
  }
  const { index, cell } = requireCell(document, id);
  if (key === "name" && value !== null
    && (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(value))) {
    throw new NotebookMutationError("invalid_option_value", "cell name must match ^[A-Za-z][A-Za-z0-9_.]*$");
  }
  // Validate even semantic no-ops so invalid wire values cannot be hidden by
  // an existing equal option.
  if (value !== null) serializeCellOption(key, value);
  if (value === null && !Object.hasOwn(cell.options, key)) return document;
  if (value !== null && Object.hasOwn(cell.options, key) && equalValue(cell.options[key], value)) return document;
  const records = updateOptionRecords(cell.records, key, value, effectivePreferredEol(document));
  if (records.length === cell.records.length
    && records.every((record, recordIndex) => record === cell.records[recordIndex])) return document;
  return applyRecordsAt(document, index, records, [index]);
}

function createCell(
  id: string,
  body: readonly string[],
  type: "code" | "markdown",
  preferredEol: string,
): InternalCell {
  validateIdentifier(id, "cell id");
  const sourceBody = validateBody(body, id);
  if (type === "markdown") validateMarkdown(sourceBody, id === "" ? "<new cell>" : id);
  const bodyArray = canonicalizeCellBody(type, sourceBody);
  const delim = type === "markdown" ? "# %% [markdown]" : "# %%";
  const records = [
    makeRecord(delim, preferredEol, "delimiter"),
    ...bodyArray.map((line) => makeRecord(line, preferredEol, "body")),
  ];
  return syncCell({ id, type, body: bodyArray, delim, options: {} }, records);
}

function assignedCellId(document: NotebookDocument): { id: string; next: number } {
  const ids = new Set(document.cells.map((cell) => cell.id));
  let next = effectiveNextCellNumber(document);
  let id = `cell-${next}`;
  while (ids.has(id)) {
    next += 1;
    id = `cell-${next}`;
  }
  return { id, next: next + 1 };
}

export function addCell(
  document: NotebookDocument,
  body: readonly string[] | string = [],
  type: "code" | "markdown" = "code",
  after: string | null = null,
  id?: string,
): NotebookDocument {
  validateCellType(type);
  const bodyArray = typeof body === "string" ? [body] : validateBody(body, "<new cell>");
  if (typeof body === "string") validateSourceLine(body, "new cell source line 1");
  if (type === "markdown") validateMarkdown(bodyArray, "<new cell>");
  if (document.cells.length >= MAX_NOTEBOOK_CELLS) {
    throw new NotebookMutationError("too_many_cells", `notebook exceeds ${MAX_NOTEBOOK_CELLS} cells`);
  }
  const physical = allPhysicalRecords(document);
  let index: number;
  if (after === null) index = document.cells.length;
  else {
    index = document.cells.findIndex((cell) => cell.id === after);
    if (index < 0) throw new NotebookMutationError("cell_not_found", `no such cell: ${after}`);
    index += 1;
  }
  const assignment = assignedCellId(document);
  if (id !== undefined) {
    validateIdentifier(id, "cell id");
    if (document.cells.some(cell => cell.id === id)) throw new NotebookMutationError("duplicate_cell", "cell already exists: " + id);
  }
  const cell = createCell(id ?? assignment.id, bodyArray, type, effectivePreferredEol(document));
  const cells = document.cells.map((candidate, cellIndex) => syncCell(candidate, physical.cells[cellIndex]!));
  cells.splice(index, 0, cell);
  const next = documentWith(document, cells, physical.header, { nextCellNumber: assignment.next });
  if (index === cells.length - 1) {
    return normalizeBoundary(next, [index, index - 1], cells.length === 1);
  }
  return next;
}

export function deleteCell(document: NotebookDocument, id: string): NotebookDocument {
  const { index } = requireCell(document, id);
  const physical = allPhysicalRecords(document);
  const cells = document.cells
    .filter((_, cellIndex) => cellIndex !== index)
    .map((cell, cellIndex) => {
      const sourceIndex = cellIndex >= index ? cellIndex + 1 : cellIndex;
      return syncCell(cell, physical.cells[sourceIndex]!);
    });
  const next = documentWith(document, cells, physical.header);
  if (index === document.cells.length - 1) return normalizeBoundary(next, [cells.length - 1], cells.length === 0);
  return next;
}

export function moveCell(
  document: NotebookDocument,
  id: string,
  after: string | null = null,
): NotebookDocument {
  const { index: from } = requireCell(document, id);
  if (after === id) {
    throw new NotebookMutationError("invalid_input", "cannot move a cell after itself");
  }
  const targetIndex = after === null ? -1 : document.cells.findIndex((cell) => cell.id === after);
  if (after !== null && targetIndex < 0) {
    throw new NotebookMutationError("cell_not_found", `no such cell: ${after}`);
  }
  const remaining = document.cells.filter((_, cellIndex) => cellIndex !== from);
  const insertion = after === null
    ? 0
    : remaining.findIndex((cell) => cell.id === after) + 1;
  const currentOrder = document.cells.map((cell) => cell.id);
  const movedOrder = [
    ...remaining.slice(0, insertion).map((cell) => cell.id),
    id,
    ...remaining.slice(insertion).map((cell) => cell.id),
  ];
  if (currentOrder.every((candidate, cellIndex) => candidate === movedOrder[cellIndex])) return document;
  const physical = allPhysicalRecords(document);
  const physicalById = new Map(document.cells.map((cell, cellIndex) => [cell.id, physical.cells[cellIndex]!])) as Map<string, InternalRecord[]>;
  const cells = movedOrder.map((cellId) => {
    const sourceCell = document.cells.find((cell) => cell.id === cellId)!;
    return syncCell(sourceCell, physicalById.get(cellId)!);
  });
  const next = documentWith(document, cells, physical.header);
  const region = [...new Set([from, insertion])];
  return normalizeBoundary(next, region);
}

function sourceCellValid(source: SourceCell, index: number): void {
  if (source === null || typeof source !== "object") {
    throw new NotebookMutationError("invalid_input", `source cell ${index + 1} is invalid`);
  }
  validateIdentifier(source.id, `source cell ${index + 1} id`);
  validateCellType(source.type);
  const body = validateBody(source.body, source.id);
  if (source.type === "markdown") validateMarkdown(body, source.id);
  if (source.options !== undefined) cloneRecordMap(source.options);
  if (source.revision !== undefined
    && (!Number.isSafeInteger(source.revision) || source.revision < 0)) {
    throw new NotebookMutationError("invalid_input", `source cell ${source.id} revision is invalid`);
  }
}

function optionsStructurallyEqual(
  cell: NotebookCellDocument,
  source: SourceCell,
): boolean {
  return source.options === undefined || equalRecordMap(cell.options, source.options);
}

function cellsStructurallyEqual(cell: NotebookCellDocument, source: SourceCell): boolean {
  if ((cell.type ?? "code") !== source.type || cell.body.length !== source.body.length) return false;
  if (!cell.body.every((line, index) => line === source.body[index])) return false;
  return optionsStructurallyEqual(cell, source);
}

function sourceOptionsApplied(
  cell: InternalCell,
  source: SourceCell,
  preferredEol: string,
): InternalCell {
  if (source.options === undefined || equalRecordMap(cell.options, source.options)) return cell;
  const desired = cloneRecordMap(source.options);
  let records = cell.records.slice();
  for (const key of Object.keys(cell.options)) {
    if (!Object.hasOwn(desired, key)) records = updateOptionRecords(records, key, null, preferredEol);
  }
  for (const [key, value] of Object.entries(desired)) {
    records = updateOptionRecords(records, key, value, preferredEol);
  }
  return syncCell(cell, records);
}

function applySourceCell(
  cell: InternalCell,
  source: SourceCell,
  preservedId: string,
  preferredEol: string,
): InternalCell {
  let records = cell.records.slice();
  records = spliceBodyRecords(records, canonicalizeCellBody(source.type, source.body), preferredEol, source.type);
  const currentType = isMarkdownDelimiter(records[0]!.text) ? "markdown" : "code";
  if (currentType !== source.type) {
    records[0] = rewriteRecord(records[0]!, source.type === "markdown" ? "# %% [markdown]" : "# %%");
  }
  let next = syncCell({ ...cell, id: preservedId }, records);
  next = sourceOptionsApplied(next, source, preferredEol);
  return {
    ...next,
    id: preservedId,
    revision: source.revision === undefined ? cell.revision : source.revision,
  };
}

export function reconcileNotebook(
  document: NotebookDocument,
  source: SourceNotebook,
): NotebookDocument {
  if (source === null || typeof source !== "object" || !Array.isArray(source.cells)) {
    throw new NotebookMutationError("invalid_input", "source notebook must contain cells");
  }
  if (source.cells.length > MAX_NOTEBOOK_CELLS) {
    throw new NotebookMutationError("too_many_cells", `notebook exceeds ${MAX_NOTEBOOK_CELLS} cells`);
  }
  const physical = allPhysicalRecords(document);
  const currentCells = document.cells.map((cell, index) => syncCell(cell, physical.cells[index]!));
  const currentIds = new Set<string>();
  for (const cell of currentCells) {
    validateIdentifier(cell.id, "cell id");
    if (currentIds.has(cell.id)) throw new NotebookMutationError("invalid_document", `duplicate cell id: ${cell.id}`);
    currentIds.add(cell.id);
  }
  source.cells.forEach(sourceCellValid);
  const sourceIds = new Set<string>();
  for (const sourceCell of source.cells) {
    if (sourceIds.has(sourceCell.id)) throw new NotebookMutationError("invalid_input", "duplicate source cell id: " + sourceCell.id);
    sourceIds.add(sourceCell.id);
  }
  if (source.metadata !== undefined) cloneRecordMap(source.metadata);
  const matched = new Array<number>(source.cells.length).fill(-1);
  const used = new Set<number>();
  for (let sourceIndex = 0; sourceIndex < source.cells.length; sourceIndex += 1) {
    const sourceCell = source.cells[sourceIndex]!;
    const exact = currentCells.findIndex((cell, index) => !used.has(index) && cell.id === sourceCell.id);
    if (exact >= 0) {
      matched[sourceIndex] = exact;
      used.add(exact);
    }
  }
  for (let sourceIndex = 0; sourceIndex < source.cells.length; sourceIndex += 1) {
    if (matched[sourceIndex] !== -1) continue;
    const sourceCell = source.cells[sourceIndex]!;
    const structural = currentCells.findIndex((cell, index) => !used.has(index)
      && cellsStructurallyEqual(cell, sourceCell));
    if (structural >= 0) {
      matched[sourceIndex] = structural;
      used.add(structural);
    }
  }

  // Reload parses fresh source cells with transient IDs; retain host IDs for same-position type matches.
  for (let sourceIndex = 0; sourceIndex < source.cells.length; sourceIndex += 1) {
    if (matched[sourceIndex] !== -1 || sourceIndex >= currentCells.length || used.has(sourceIndex)) continue;
    const sourceCell = source.cells[sourceIndex]!;
    const currentCell = currentCells[sourceIndex]!;
    if ((currentCell.type ?? "code") !== sourceCell.type) continue;
    matched[sourceIndex] = sourceIndex;
    used.add(sourceIndex);
  }

  const preferredEol = effectivePreferredEol(document);
  const nextCells: InternalCell[] = [];
  const changedRegions: number[] = [];
  for (let sourceIndex = 0; sourceIndex < source.cells.length; sourceIndex += 1) {
    const sourceCell = source.cells[sourceIndex]!;
    const oldIndex = matched[sourceIndex]!;
    if (oldIndex >= 0) {
      const oldCell = currentCells[oldIndex]!;
      const preservedId = oldCell.id;
      const nextCell = applySourceCell(oldCell, sourceCell, preservedId, preferredEol);
      nextCells.push(nextCell);
      if (oldIndex !== sourceIndex || nextCell.records !== oldCell.records
        || nextCell.type !== oldCell.type || nextCell.body !== oldCell.body
        || !equalRecordMap(nextCell.options, oldCell.options)) {
        changedRegions.push(oldIndex, sourceIndex);
      }
    } else {
      const created = sourceOptionsApplied(
        createCell(sourceCell.id, sourceCell.body, sourceCell.type, preferredEol),
        sourceCell,
        preferredEol,
      );
      nextCells.push(sourceCell.revision === undefined ? created : { ...created, revision: sourceCell.revision });
      changedRegions.push(sourceIndex);
    }
  }
  for (let oldIndex = 0; oldIndex < currentCells.length; oldIndex += 1) {
    if (!used.has(oldIndex)) changedRegions.push(oldIndex);
  }
  let nextNumber = effectiveNextCellNumber(document);
  for (const cell of nextCells) {
    const match = /^cell-([0-9]+)$/.exec(cell.id);
    if (match !== null) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number)) nextNumber = Math.max(nextNumber, number + 1);
    }
  }
  const nextPath = source.path === undefined ? document.path ?? null : source.path;
  let next: NotebookDocument = documentWith(document, nextCells, physical.header, {
    path: nextPath,
    nextCellNumber: nextNumber,
  });
  if (source.metadata !== undefined && !equalRecordMap(effectiveMetadata(next), source.metadata)) {
    const sourceMetadata = cloneRecordMap(source.metadata);
    // Update the full metadata map in one physical header replacement. This
    // avoids exposing a transient key-by-key document to callers.
    const metadata = sourceMetadata;
    const header = physical.header.slice();
    const fences: number[] = [];
    for (let index = 0; index < header.length; index += 1) {
      if (metadataFencePattern.test(header[index]!.text)) fences.push(index);
    }
    const eol = fences.length > 0 && header[fences[0]!]!.eol !== ""
      ? header[fences[0]!]!.eol
      : preferredEol;
    const interior = metadataRecords(metadata, eol);
    const nextHeader = fences.length >= 2
      ? [...header.slice(0, fences[0]! + 1), ...interior, ...header.slice(fences[1]!)]
      : [makeRecord("# ---", eol, "header"), ...interior, makeRecord("# ---", eol, "header"), ...header];
    next = documentWith(next, nextCells, nextHeader, { metadata });
  }
  return normalizeBoundary(next, [...new Set(changedRegions)], currentCells.length > 0 && source.cells.length === 0);
}

/** Return zero-based physical file lines occupied by a cell's body records. */
export function physicalBodyLines(document: NotebookDocument, id: string): number[] {
  validateIdentifier(id, "cell id");
  const preferredEol = effectivePreferredEol(document);
  const header = headerRecordsFor(document, preferredEol);
  const physical = allPhysicalRecords(document);
  let line = header.length;
  for (let index = 0; index < document.cells.length; index += 1) {
    const cell = document.cells[index]!;
    const records = physical.cells[index]!;
    const lines: number[] = [];
    let bodyLine = 0;
    for (const record of records) {
      if (record.kind === "body") {
        lines.push(line);
        bodyLine += 1;
      }
      line += 1;
    }
    if (cell.id === id) return lines;
    void bodyLine;
  }
  return [];
}

/** Translate a zero-based physical file line to a cell/body line. */
export function logicalBodyPosition(
  document: NotebookDocument,
  physicalLine: number,
): { id: string; line: number } | null {
  if (!Number.isSafeInteger(physicalLine) || physicalLine < 0) return null;
  const preferredEol = effectivePreferredEol(document);
  const physical = allPhysicalRecords(document);
  let line = physical.header.length;
  for (let index = 0; index < document.cells.length; index += 1) {
    const cell = document.cells[index]!;
    const records = physical.cells[index]!;
    let bodyLine = 0;
    for (const record of records) {
      if (line === physicalLine && record.kind === "body") return { id: cell.id, line: bodyLine };
      if (record.kind === "body") bodyLine += 1;
      line += 1;
    }
  }
  void preferredEol;
  return null;
}

export function layoutNotebook(document: NotebookDocument): NotebookLayout {
  const preferredEol = effectivePreferredEol(document);
  const physical = allPhysicalRecords(document);
  const lineMap: Array<{ cell: string; line: number } | null> = [];
  const cellLines = new Map<string, number[]>();
  const parts: string[] = [];
  const append = (record: InternalRecord, mapped: { cell: string; line: number } | null) => {
    parts.push(record.text, record.eol);
    lineMap.push(mapped);
  };
  for (const record of physical.header) append(record, null);
  for (let index = 0; index < document.cells.length; index += 1) {
    const cell = document.cells[index]!;
    const records = physical.cells[index]!;
    const lines: number[] = [];
    let bodyLine = 0;
    for (const record of records) {
      const mapped = record.kind === "body" ? { cell: cell.id, line: bodyLine } : null;
      if (mapped !== null) {
        lines.push(lineMap.length);
        bodyLine += 1;
      }
      append(record, mapped);
    }
    cellLines.set(cell.id, lines);
  }
  return { text: parts.join(""), lineMap, cellLines };
}

function validCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function physicalBodyCoordinate(
  document: NotebookDocument,
  id: string,
  bodyLine: number,
): { line: number; text: string; type: "code" | "markdown" } | null {
  const physical = allPhysicalRecords(document);
  let line = physical.header.length;
  for (let index = 0; index < document.cells.length; index += 1) {
    const cell = document.cells[index]!;
    let logicalLine = 0;
    for (const record of physical.cells[index]!) {
      if (record.kind === "body") {
        if (cell.id === id && logicalLine === bodyLine) {
          return { line, text: record.text, type: cell.type ?? "code" };
        }
        logicalLine += 1;
      }
      line += 1;
    }
  }
  return null;
}

function markdownMarker(text: string): { indent: number; width: number } | null {
  const match = /^(\s*)#( ?)/.exec(text);
  return match === null ? null : { indent: match[1]!.length, width: 1 + match[2]!.length };
}

export function toFilePosition(
  document: NotebookDocument,
  position: CellPosition,
): { line: number; character: number } | null {
  if (!validCoordinate(position?.line) || !validCoordinate(position?.character)) return null;
  const physical = physicalBodyCoordinate(document, position.cell, position.line);
  if (physical === null) return null;
  const marker = physical.type === "markdown" ? markdownMarker(physical.text) : null;
  const character = marker !== null && position.character >= marker.indent
    ? position.character + marker.width
    : position.character;
  return { line: physical.line, character };
}

export function fromFilePosition(
  document: NotebookDocument,
  position: { line: number; character: number },
): CellPosition | null {
  if (!validCoordinate(position?.line) || !validCoordinate(position?.character)) return null;
  const logical = logicalBodyPosition(document, position.line);
  if (logical === null) return null;
  const physical = physicalBodyCoordinate(document, logical.id, logical.line);
  const marker = physical?.type === "markdown" ? markdownMarker(physical.text) : null;
  const character = marker === null || marker === undefined || position.character <= marker.indent
    ? position.character
    : position.character <= marker.indent + marker.width
      ? marker.indent
      : position.character - marker.width;
  return { cell: logical.id, line: logical.line, character };
}

export function translateRange(range: unknown, document: NotebookDocument): CellRange | null {
  if (range === null || typeof range !== "object") return null;
  const candidate = range as { start?: unknown; end?: unknown };
  if (candidate.start === null || typeof candidate.start !== "object"
    || candidate.end === null || typeof candidate.end !== "object") return null;
  const start = fromFilePosition(document, candidate.start as { line: number; character: number });
  const end = fromFilePosition(document, candidate.end as { line: number; character: number });
  return start !== null && end !== null && start.cell === end.cell ? { start, end } : null;
}

export interface StagedDocument {
  readonly document: NotebookDocument;
  readonly created: ReadonlyMap<string, string>;
  readonly changed: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
}

interface ResolvedCellRef {
  readonly id: string;
  readonly created: boolean;
}

function stageInvalid(message: string): NotebookMutationError {
  return new NotebookMutationError("invalid_document", message);
}
function stageConflict(message: string): NotebookMutationError {
  return new NotebookMutationError('stale_revision', message);
}

function stageCell(document: NotebookDocument, id: string): NotebookCellDocument {
  const cell = document.cells.find((candidate) => candidate.id === id);
  if (cell === undefined) throw new NotebookMutationError("cell_not_found", `no such cell: ${id}`);
  return cell;
}

function stageCellEqual(left: NotebookCellDocument, right: NotebookCellDocument): boolean {
  return left.id === right.id
    && (left.type ?? "code") === (right.type ?? "code")
    && left.body.length === right.body.length
    && left.body.every((line, index) => line === right.body[index])
    && equalRecordMap(left.options, right.options);
}

function resolveStageRef(
  document: NotebookDocument,
  ref: CellRef,
  created: ReadonlyMap<string, string>,
  deleted: ReadonlySet<string>,
): ResolvedCellRef {
  if (ref === null || typeof ref !== "object") throw stageInvalid("cell reference must be an object");
  const candidate = ref as { cellId?: unknown; creationId?: unknown };
  if (typeof candidate.cellId === "string") {
    validateIdentifier(candidate.cellId, "cell id");
    if (deleted.has(candidate.cellId)) throw stageInvalid(`cell was deleted earlier in this transaction: ${candidate.cellId}`);
    stageCell(document, candidate.cellId);
    return { id: candidate.cellId, created: false };
  }
  if (typeof candidate.creationId === "string") {
    validateIdentifier(candidate.creationId, "creation id");
    const id = created.get(candidate.creationId);
    if (id === undefined) throw stageInvalid(`creation reference is not available: ${candidate.creationId}`);
    if (deleted.has(id)) throw stageInvalid(`created cell was deleted earlier in this transaction: ${candidate.creationId}`);
    stageCell(document, id);
    return { id, created: true };
  }
  throw stageInvalid("cell reference must contain cellId or creationId");
}

function checkStageRevision(
  expected: number | undefined,
  resolved: ResolvedCellRef,
  initialRevisions: ReadonlyMap<string, number>,
): void {
  if (resolved.created) {
    if (expected !== undefined) throw stageInvalid("created cells do not accept expectedRevision");
    return;
  }
  if (expected === undefined) throw stageInvalid("expectedRevision is required for an existing cell");
  const actual = initialRevisions.get(resolved.id);
  if (actual === undefined || expected !== actual) {
    throw stageConflict(`cell revision mismatch for ${resolved.id}: expected ${expected}, actual ${actual ?? -1}`);
  }
}

function positionOffset(lines: readonly string[], position: unknown): number {
  if (position === null || typeof position !== "object") throw stageInvalid("text edit position must be an object");
  const candidate = position as { line?: unknown; character?: unknown };
  if (!Number.isSafeInteger(candidate.line) || !Number.isSafeInteger(candidate.character)
    || (candidate.line as number) < 0 || (candidate.character as number) < 0) {
    throw stageInvalid("text edit position is invalid");
  }
  const line = candidate.line as number;
  const character = candidate.character as number;
  if (line >= lines.length) {
    if (lines.length === 0 && line === 0 && character === 0) return 0;
    throw stageInvalid("text edit line is outside the cell");
  }
  const value = lines[line]!;
  if (character > value.length) throw stageInvalid("text edit character is outside the line");
  if (character > 0 && character < value.length
    && isHighSurrogate(value.charCodeAt(character - 1))
    && isLowSurrogate(value.charCodeAt(character))) {
    throw stageInvalid("text edit splits a UTF-16 surrogate pair");
  }
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += lines[index]!.length + 1;
  return offset + character;
}

function applyUtf16Edits(
  body: readonly string[],
  cellType: "code" | "markdown",
  edits: ReadonlyArray<{ start: unknown; end: unknown; text: string }>,
): string[] {
  const logicalBody = toLogicalCellBody(cellType, body);
  const source = logicalBody.join("\n");
  const normalized = edits.map((edit) => {
    if (edit === null || typeof edit !== "object" || typeof edit.text !== "string"
      || /[\r\u0000]/.test(edit.text) || isUnpairedSurrogate(edit.text)) {
      throw stageInvalid("text edit has invalid text");
    }
    const start = positionOffset(logicalBody, edit.start);
    const end = positionOffset(logicalBody, edit.end);
    if (end < start) throw stageInvalid("text edit range is reversed");
    return { start, end, text: edit.text };
  });
  const sorted = normalized
    .map((edit, index) => ({ ...edit, index }))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);
  let previousEnd = -1;
  for (const edit of sorted) {
    if (edit.start < previousEnd) throw stageInvalid("text edits overlap");
    previousEnd = Math.max(previousEnd, edit.end);
  }
  let result = source;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const edit = sorted[index]!;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result.length === 0 ? [] : result.split("\n");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Stage an ordered transaction without mutating the base document. */
export function stageDocumentChanges(
  base: NotebookDocument,
  changes: readonly DocumentChange[],
): StagedDocument {
  if (base === null || typeof base !== "object" || !Array.isArray(base.cells)) {
    throw stageInvalid("base document must contain cells");
  }
  if (!Array.isArray(changes) || changes.length > MAX_NOTEBOOK_CELLS) {
    throw stageInvalid("transaction changes exceed the notebook limit");
  }
  // Validate and size the immutable base once. No caller-visible state is
  // touched, and the bytes are reused for exact no-op detection below.
  let baseBytes: Uint8Array;
  try { baseBytes = serializeNotebook(base); } catch (error) {
    if (error instanceof NotebookError) throw error;
    throw stageInvalid(error instanceof Error ? error.message : String(error));
  }
  const initialRevisions = new Map<string, number>();
  const initialCells = new Map<string, NotebookCellDocument>();
  const initialOrder = base.cells.map((cell) => cell.id);
  for (const cell of base.cells) {
    validateIdentifier(cell.id, "cell id");
    if (initialRevisions.has(cell.id)) throw stageInvalid("duplicate cell id: " + cell.id);
    if (cell.revision !== undefined && (!Number.isSafeInteger(cell.revision) || cell.revision < 0)) {
      throw stageInvalid("cell revision is invalid: " + cell.id);
    }
    initialRevisions.set(cell.id, cell.revision ?? 0);
    initialCells.set(cell.id, cell);
  }
  let document = base;
  const created = new Map<string, string>();
  const deleted = new Set<string>();
  const bodyModes = new Map<string, "edit" | "text-edit">();
  const stagedTextEdits = new Map<string, Parameters<typeof applyUtf16Edits>[2]>();
  const moved = new Set<string>();
  for (const change of changes) {
    if (change === null || typeof change !== "object" || typeof change.type !== "string") {
      throw stageInvalid("transaction change must be an object with a type");
    }
    if (change.type === "create") {
      validateIdentifier(change.creationId, "creation id");
      if (created.has(change.creationId)) throw stageInvalid("duplicate creation id: " + change.creationId);
      if (change.options === null || typeof change.options !== "object" || Array.isArray(change.options)
        || Object.getPrototypeOf(change.options) !== Object.prototype) {
        throw stageInvalid("create options must be a mapping");
      }
      for (const value of Object.values(change.options)) {
        if (value === null) throw stageInvalid("create options cannot contain null values");
      }
      const after = change.after === null ? null : resolveStageRef(document, change.after, created, deleted).id;
      const beforeIds = new Set(document.cells.map((cell) => cell.id));
      document = addCell(document, change.body, change.cellType, after, change.creationId);
      const added = document.cells.find((cell) => !beforeIds.has(cell.id));
      if (added === undefined) throw stageInvalid("cell creation did not produce a cell");
      created.set(change.creationId, added.id);
      for (const [key, value] of Object.entries(change.options)) {
        document = setCellOption(document, added.id, key, value);
      }
      continue;
    }
    if (change.type === "edit") {
      const resolved = resolveStageRef(document, change.cell, created, deleted);
      checkStageRevision(change.expectedRevision, resolved, initialRevisions);
      const previousMode = bodyModes.get(resolved.id);
      if (previousMode !== undefined && previousMode !== "edit") throw stageInvalid("edit and text-edit cannot target the same cell in one transaction");
      bodyModes.set(resolved.id, "edit");
      const original = initialCells.get(resolved.id);
      const originalBody = original !== undefined && original.type === change.cellType
        ? original.body
        : undefined;
      const physicalBody = toPhysicalCellBody(
        change.cellType,
        toLogicalCellBody(change.cellType, change.body),
        originalBody,
      );
      document = updateCell(document, resolved.id, physicalBody, change.cellType);
      continue;
    }
    if (change.type === "options") {
      const resolved = resolveStageRef(document, change.cell, created, deleted);
      checkStageRevision(change.expectedRevision, resolved, initialRevisions);
      if (change.patch === null || typeof change.patch !== "object" || Array.isArray(change.patch)) throw stageInvalid("options patch must be a mapping");
      for (const [key, value] of Object.entries(change.patch)) document = setCellOption(document, resolved.id, key, value as CellOption | null);
      continue;
    }
    if (change.type === "text-edit") {
      const resolved = resolveStageRef(document, change.cell, created, deleted);
      checkStageRevision(change.expectedRevision, resolved, initialRevisions);
      const previousMode = bodyModes.get(resolved.id);
      if (resolved.created) throw stageInvalid("text-edit targets an existing cell only");
      if (!Array.isArray(change.edits)) throw stageInvalid("text-edit edits must be an array");
      if (previousMode !== undefined && previousMode !== "text-edit") throw stageInvalid("edit and text-edit cannot target the same cell in one transaction");
      bodyModes.set(resolved.id, "text-edit");
      const original = initialCells.get(resolved.id);
      if (original === undefined) throw stageInvalid("text-edit targets an existing cell only");
      const type = original.type ?? "code";
      const edits = [...(stagedTextEdits.get(resolved.id) ?? []), ...change.edits];
      const nextLogicalBody = applyUtf16Edits(original.body, type, edits);
      stagedTextEdits.set(resolved.id, edits);
      const nextPhysicalBody = toPhysicalCellBody(type, nextLogicalBody, original.body);
      document = updateCell(document, resolved.id, nextPhysicalBody, type);
      continue;
    }
    if (change.type === "move") {
      const resolved = resolveStageRef(document, change.cell, created, deleted);
      const after = change.after === null ? null : resolveStageRef(document, change.after, created, deleted).id;
      if (after === resolved.id) throw stageInvalid("a cell cannot be moved after itself");
      const beforeOrder = document.cells.map((cell) => cell.id).join("\u0000");
      document = moveCell(document, resolved.id, after);
      if (document.cells.map((cell) => cell.id).join("\u0000") !== beforeOrder) moved.add(resolved.id);
      continue;
    }
    if (change.type === "delete") {
      const resolved = resolveStageRef(document, change.cell, created, deleted);
      checkStageRevision(change.expectedRevision, resolved, initialRevisions);
      document = deleteCell(document, resolved.id);
      deleted.add(resolved.id);
      continue;
    }
    throw stageInvalid("unsupported transaction change: " + change.type);
  }
  const finalIds = new Set(document.cells.map((cell) => cell.id));
  // Deltas describe the final document, not every intermediate mutation. A
  // cell created and deleted in this transaction never crossed the base
  // document boundary, so it must not appear as either a creation or a
  // deletion. Existing cells that remain are handled by changed below.
  for (const [creationId, id] of created) {
    if (!finalIds.has(id)) created.delete(creationId);
  }
  for (const id of deleted) {
    if (!initialCells.has(id) || finalIds.has(id)) deleted.delete(id);
  }
  const changed = new Set<string>();
  for (const [id, original] of initialCells) {
    if (!finalIds.has(id)) continue;
    const candidate = stageCell(document, id);
    if (!stageCellEqual(original, candidate) || (moved.has(id) && initialOrder.indexOf(id) !== document.cells.findIndex((cell) => cell.id === id))) changed.add(id);
  }
  const revisioned = document.cells.map((cell) => {
    if (!changed.has(cell.id) || deleted.has(cell.id) || !initialRevisions.has(cell.id)) return cell;
    return { ...cell, revision: initialRevisions.get(cell.id)! + 1 };
  });
  let candidate: NotebookDocument = revisioned === document.cells ? document : { ...document, cells: revisioned };
  let candidateBytes: Uint8Array;
  try { candidateBytes = serializeNotebook(candidate); } catch (error) {
    if (error instanceof NotebookError) throw error;
    throw stageInvalid(error instanceof Error ? error.message : String(error));
  }
  // If ordered operations cancelled out, return the original immutable base so
  // no delimiter/EOL rewrite leaks from an otherwise semantic no-op. Physical
  // bytes are the authoritative observable, including metadata/EOL/BOM.
  if (changes.length > 0 && sameBytes(baseBytes, candidateBytes)) {
    created.clear();
    changed.clear();
    deleted.clear();
    candidate = base;
  }
  return { document: candidate, created, changed, deleted };
}
