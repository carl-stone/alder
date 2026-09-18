import { parseStrictJson } from "./strict-json.js";
import { z } from "zod";

/** The only authoritative wire versions for the Alder host and Ark engine. */
export const HOST_PROTOCOL = "alder-host-v2" as const;
export const ENGINE_PROTOCOL = "alder-engine-v2" as const;
export const HOST_CLIENT_PROTOCOL_VERSION = 2 as const;

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_ENGINE_FRAME_BYTES = 128 * 1024 * 1024;
export const MAX_NOTEBOOK_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_NOTEBOOK_CELLS = 10_000;
export const MAX_DEPENDENCY_EDGES = 1_000_000;
export const SNAPSHOT_ENVELOPE_LIMIT = 128 * 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
export const MAX_SOURCE_LINES = 100_000;
export const MAX_SOURCE_LINE_LENGTH = 1_048_576;
export const MAX_RUNTIME_VARIABLES = 2_000;
export const MAX_EDITOR_DIAGNOSTICS = 2_000;
export const MAX_PROTOCOL_COLLECTION_ITEMS = 100_000;
export const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_RESULT_BYTES = 1 * 1024 * 1024;
export const OUTPUT_CHUNK_BYTES = 262_144;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACT_HANDLE_BYTES = 128;
export const MAX_RELEASE_ARTIFACTS = 4_096;
export const MAX_EVENT_BYTES = MAX_FRAME_BYTES;
export const LAYOUT_MAX_BYTES = 1 * 1024 * 1024;

const MAX_ID_BYTES = 256;
const MAX_ANALYSIS_SYMBOL_BYTES = 1_024;
const MAX_ANALYSIS_SYMBOLS = 10_000;
const MAX_TABLE_COLUMNS = 50;
const MAX_TABLE_PREVIEW_ROWS = 25;

function hasUnpairedSurrogate(value: string): boolean {
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

function boundedUtf8StringSchema(maximumBytes: number, nonempty = false): z.ZodString {
  const schema = nonempty ? z.string().min(1) : z.string();
  return schema.superRefine((value, context) => {
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: "custom", message: "string must contain valid Unicode" });
      return;
    }
    if (new TextEncoder().encode(value).byteLength > maximumBytes) {
      context.addIssue({ code: "custom", message: "string exceeds UTF-8 byte limit" });
    }
  });
}

function safeStringRecordSchema<T>(valueSchema: z.ZodType<T>): z.ZodType<Record<string, T>> {
  return z.unknown().transform((value, context) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      context.addIssue({ code: "custom", message: "expected an object" });
      return z.NEVER;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      context.addIssue({ code: "custom", message: "expected a plain object" });
      return z.NEVER;
    }
    const entries: Array<[string, T]> = [];
    for (const [key, raw] of Object.entries(value)) {
      const parsed = valueSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: [key, ...issue.path], message: issue.message });
        }
      } else entries.push([key, parsed.data]);
    }
    return Object.fromEntries(entries);
  }) as z.ZodType<Record<string, T>>;
}

export const protocolIdSchema = boundedUtf8StringSchema(MAX_ID_BYTES, true)
  .refine((value) => !/[\u0000\r\n\u0001-\u001f\u007f]/.test(value), "identifier contains a control character");
const idSchema = protocolIdSchema;
const pathSchema = boundedUtf8StringSchema(32 * 1024, true);
const protocolIntegerSchema = z.number().int().nonnegative().safe();
const positiveIntegerSchema = z.number().int().positive().safe();
const revisionSchema = protocolIntegerSchema;
const finiteNumberSchema = z.number().finite();
function isFiniteNumberPair(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

class ProtocolJsonError extends Error {}

function cloneProtocolJson(value: unknown, depth = 0, active = new WeakSet<object>()): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new ProtocolJsonError("JSON numbers must be finite");
  }
  if (typeof value !== "object") throw new ProtocolJsonError("value is not JSON-compatible");
  if (depth >= MAX_JSON_DEPTH) throw new ProtocolJsonError("JSON nesting limit exceeded");
  if (active.has(value)) throw new ProtocolJsonError("JSON value contains a cycle");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new ProtocolJsonError("arrays must use the standard prototype");
      if (Object.getOwnPropertySymbols(value).length > 0) throw new ProtocolJsonError("JSON arrays cannot contain symbol properties");
      const names = Object.getOwnPropertyNames(value);
      for (const name of names) {
        if (name === "length") continue;
        if (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= value.length) throw new ProtocolJsonError("JSON arrays cannot contain extra properties");
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new ProtocolJsonError("JSON arrays cannot contain accessors or holes");
      }
      const copy: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, String(index))) throw new ProtocolJsonError("JSON arrays cannot contain holes");
        copy.push(cloneProtocolJson(value[index], depth + 1, active));
      }
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ProtocolJsonError("JSON objects must be plain objects");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new ProtocolJsonError("JSON objects cannot contain symbol properties");
    const copy = Object.create(prototype) as Record<string, JsonValue>;
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new ProtocolJsonError("JSON objects cannot contain accessors or non-enumerable properties");
      Object.defineProperty(copy, name, {
        value: cloneProtocolJson(descriptor.value, depth + 1, active),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy as JsonValue;
  } finally {
    active.delete(value);
  }
}

export const protocolJsonSchema = z.any().transform((value, context) => {
  try {
    return cloneProtocolJson(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "value is not JSON-compatible" });
    return z.NEVER;
  }
}) as z.ZodType<JsonValue>;
function strictProtocolJsonSchema<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value, context) => {
    const parsed = protocolJsonSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "value is not JSON-compatible" });
      return z.NEVER;
    }
    return parsed.data;
  }, schema);
}
const protocolJsonRecordSchema = safeStringRecordSchema(protocolJsonSchema);
const sourceLineSchema = boundedUtf8StringSchema(MAX_SOURCE_LINE_LENGTH).superRefine((line, context) => {
  if (line.includes("\n") || line.includes("\r")) {
    context.addIssue({ code: "custom", message: "source lines cannot contain line breaks" });
  }
  if (line.includes("\0")) {
    context.addIssue({ code: "custom", message: "source lines cannot contain NUL" });
  }
});
const sourceLinesSchema = z.array(sourceLineSchema).max(MAX_SOURCE_LINES);
const sourceTextSchema = boundedUtf8StringSchema(MAX_NOTEBOOK_SOURCE_BYTES).refine((value) => !value.includes("\0"), "source text cannot contain NUL");
/** Source values use this representation only at a transport boundary. */
export type WireSource = { encoding: "base64"; data: string; lines: number | null };

/** Return decoded bytes for canonical padded RFC 4648 base64, or null when invalid. */
export function canonicalBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  let lastSextet = 0;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const sextet = code >= 0x41 && code <= 0x5a
      ? code - 0x41
      : code >= 0x61 && code <= 0x7a
        ? code - 0x61 + 26
        : code >= 0x30 && code <= 0x39
          ? code - 0x30 + 52
          : code === 0x2b
            ? 62
            : code === 0x2f
              ? 63
              : -1;
    if (sextet < 0) return null;
    lastSextet = sextet;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return null;
  }
  if (padding === 2 && (lastSextet & 0x0f) !== 0) return null;
  if (padding === 1 && (lastSextet & 0x03) !== 0) return null;
  return (value.length / 4) * 3 - padding;
}

export const wireSourceSchema = z.object({
  encoding: z.literal("base64"),
  data: z.string().refine((value) => canonicalBase64ByteLength(value) !== null, "must be canonical padded base64"),
  lines: z.union([z.number().int().nonnegative().safe(), z.null()]),
}).strict();

const BASE64_QUANTUM_BYTES = 3 * 16_384;
const BASE64_BTOA_CHUNK_BYTES = 0x8000;

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.byteLength; start += BASE64_QUANTUM_BYTES) {
    const end = Math.min(bytes.byteLength, start + BASE64_QUANTUM_BYTES);
    let binary = "";
    for (let offset = start; offset < end; offset += BASE64_BTOA_CHUNK_BYTES) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(end, offset + BASE64_BTOA_CHUNK_BYTES)));
    }
    parts.push(btoa(binary));
  }
  return parts.join("");
}

function decodeBase64(value: string): Uint8Array {
  if (!wireSourceSchema.shape.data.safeParse(value).success) throw new ProtocolError("invalid_request", "source transfer data is not padded base64");
  const decodedLength = canonicalBase64ByteLength(value)!;
  if (decodedLength > MAX_NOTEBOOK_SOURCE_BYTES) throw new ProtocolError("invalid_request", "source transfer data exceeds the 32 MiB notebook limit");
  let binary: string;
  try { binary = atob(value); }
  catch { throw new ProtocolError("invalid_request", "source transfer data is not valid base64"); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ProtocolError("invalid_request", "source transfer data is not valid UTF-8"); }
}

export function encodeWireSource(value: string | readonly string[]): WireSource {
  const lines = typeof value === "string" ? null : value.length;
  const text = typeof value === "string" ? value : value.join("\n");
  if (hasUnpairedSurrogate(text)) throw new ProtocolError("invalid_request", "source transfer text contains an unpaired surrogate");
  return { encoding: "base64", data: encodeBase64(new TextEncoder().encode(text)), lines };
}

export function decodeWireSource(value: unknown): string | string[] {
  const parsed = wireSourceSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError("invalid_request", "invalid source transfer value");
  const text = decodeUtf8(decodeBase64(parsed.data.data));
  if (hasUnpairedSurrogate(text)) throw new ProtocolError("invalid_request", "source transfer text contains an unpaired surrogate");
  if (parsed.data.lines === null) return text;
  if (parsed.data.lines === 0) {
    if (text !== "") throw new ProtocolError("invalid_request", "empty source line array must have empty data");
    return [];
  }
  const lines = text.split("\n");
  if (lines.length !== parsed.data.lines || lines.some((line) => line.includes("\r"))) {
    throw new ProtocolError("invalid_request", "source transfer line count is inconsistent");
  }
  return lines;
}
export const cellTypeSchema = z.enum(["code", "markdown"]);
export type CellType = z.infer<typeof cellTypeSchema>;

export const sourcePositionSchema = z.object({
  line: protocolIntegerSchema,
  character: protocolIntegerSchema,
}).strict();
export type SourcePosition = z.infer<typeof sourcePositionSchema>;
export const sourceRangeSchema = z.object({
  start: sourcePositionSchema,
  end: sourcePositionSchema,
}).strict();
export type SourceRange = z.infer<typeof sourceRangeSchema>;

export const cellSnapshotSchema = z.object({
  id: idSchema,
  revision: revisionSchema,
  type: cellTypeSchema,
  source: sourceTextSchema,
}).strict();
export type CellSnapshot = z.infer<typeof cellSnapshotSchema>;

export const analysisDiagnosticSchema = z.object({
  level: z.enum(["error", "warning", "info"]).default("error"),
  code: boundedUtf8StringSchema(256, true).default("analysis"),
  message: boundedUtf8StringSchema(MAX_FRAME_BYTES),
  symbol: boundedUtf8StringSchema(MAX_ANALYSIS_SYMBOL_BYTES).nullable().optional(),
  source: boundedUtf8StringSchema(256, true).optional(),
  range: sourceRangeSchema.nullable(),
  fileRange: sourceRangeSchema.optional(),
  occurrences: z.array(sourceRangeSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS).optional(),
}).strict();
export type AnalysisDiagnostic = z.infer<typeof analysisDiagnosticSchema>;
const analysisSymbolSchema = boundedUtf8StringSchema(MAX_ANALYSIS_SYMBOL_BYTES, true);
const analysisSymbolArraySchema = z.array(analysisSymbolSchema).max(MAX_ANALYSIS_SYMBOLS);

export const analysisCellResultSchema = z.object({
  id: idSchema,
  revision: revisionSchema,
  defs: analysisSymbolArraySchema,
  refs: analysisSymbolArraySchema,
  selfRefs: analysisSymbolArraySchema,
  locals: analysisSymbolArraySchema,
  barrier: z.boolean(),
  opaque: z.boolean(),
  diagnostics: z.array(analysisDiagnosticSchema).max(MAX_EDITOR_DIAGNOSTICS),
  error: boundedUtf8StringSchema(MAX_FRAME_BYTES).nullable(),
  ranges: safeStringRecordSchema(z.array(sourceRangeSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS)).optional(),
}).strict();
export type AnalysisCellResult = z.infer<typeof analysisCellResultSchema>;
export const analysisEnvironmentIdSchema = idSchema;
export const analysisResultSchema = z.object({
  revision: revisionSchema,
  analysisEnvironmentId: analysisEnvironmentIdSchema,
  cells: z.array(analysisCellResultSchema).max(MAX_NOTEBOOK_CELLS),
  analyzer: z.object({
    packageVersion: boundedUtf8StringSchema(256, true),
    rVersion: boundedUtf8StringSchema(256, true),
    policy: boundedUtf8StringSchema(256, true),
    analysisEnvironmentId: analysisEnvironmentIdSchema,
  }).strict(),
}).strict();
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const engineErrorSchema = z.object({
  message: boundedUtf8StringSchema(MAX_FRAME_BYTES),
  code: boundedUtf8StringSchema(256).optional(),
  interrupted: z.boolean().optional(),
  transport: z.boolean().optional(),
  details: protocolJsonSchema.optional(),
}).strict();
export type EngineError = z.infer<typeof engineErrorSchema>;
const clearCellIdsSchema = z.array(idSchema).min(1).max(MAX_NOTEBOOK_CELLS).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "clear_cell ids must be unique" });
});
const clearCellRequestShape = z.object({ ids: clearCellIdsSchema }).strict();
// host-ark-runtime.R bounds condition text by UTF-8 bytes, preserving a valid
// prefix; these schemas mirror those byte caps and its forty-frame trace tail.
const rawConditionMessageSchema = boundedUtf8StringSchema(16_384);
const rawConditionClassSchema = z.array(boundedUtf8StringSchema(256)).min(1).max(MAX_PROTOCOL_COLLECTION_ITEMS);
const rawConditionCallSchema = boundedUtf8StringSchema(2_048).nullable();
const rawConditionTraceSchema = z.array(boundedUtf8StringSchema(2_048)).max(40);
const rawErrorCommonShape = {
  code: boundedUtf8StringSchema(256).optional(),
  interrupted: z.boolean().optional(),
  details: protocolJsonSchema.optional(),
};

export const rawConditionErrorSchema = z.object({
  message: rawConditionMessageSchema,
  class: rawConditionClassSchema,
  call: rawConditionCallSchema,
  trace: rawConditionTraceSchema,
  ...rawErrorCommonShape,
}).strict();
export type RawConditionError = z.infer<typeof rawConditionErrorSchema>;

export const rawValidationErrorSchema = z.object({
  message: boundedUtf8StringSchema(MAX_FRAME_BYTES),
  ...rawErrorCommonShape,
}).strict();
export type RawValidationError = z.infer<typeof rawValidationErrorSchema>;

export const rawEngineErrorSchema = z.union([
  rawConditionErrorSchema,
  rawValidationErrorSchema,
]);
export type RawEngineError = z.infer<typeof rawEngineErrorSchema>;
export const clearCellRequestSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(clearCellRequestShape);
export type ClearCellRequest = z.infer<typeof clearCellRequestShape>;
const releaseArtifactNameSchema = boundedUtf8StringSchema(1_024, true).refine(
  (value) => !value.startsWith(".") && !/[\\/]/.test(value),
  "invalid artifact handle",
);
const releaseArtifactNamesSchema = z.array(releaseArtifactNameSchema).max(MAX_RELEASE_ARTIFACTS);
export const releaseOutputsResponseSchema = z.object({
  ok: z.boolean(),
  released: releaseArtifactNamesSchema.optional(),
  missing: releaseArtifactNamesSchema.optional(),
  failed: releaseArtifactNamesSchema.optional(),
  error: engineErrorSchema.optional(),
}).strict().superRefine((response, context) => {
  if (response.ok && (response.released === undefined || response.missing === undefined || response.failed === undefined)) {
    context.addIssue({ code: "custom", message: "successful release_outputs responses require released, missing, and failed arrays" });
  }
});
export type ReleaseOutputsResponse = z.infer<typeof releaseOutputsResponseSchema>;
const tablePageSchema = z.lazy(() => tablePageShape);
export const richOutputPayloadSchema = z.lazy(() => richOutputShape) as unknown as z.ZodType<RichOutputPayload>;
const arkCleanupFailureSchema = z.object({
  name: idSchema,
  action: boundedUtf8StringSchema(256, true),
  active: z.boolean().nullable(),
  locked: z.boolean().nullable(),
  message: boundedUtf8StringSchema(2_048),
}).strict();
const arkRuntimeVariableSchema = z.object({
  name: boundedUtf8StringSchema(MAX_ANALYSIS_SYMBOL_BYTES, true),
  class: boundedUtf8StringSchema(MAX_ANALYSIS_SYMBOL_BYTES, true),
  dim: z.array(protocolIntegerSchema).max(64).nullable(),
  size: protocolIntegerSchema,
  widget: z.boolean(),
  value_summary: boundedUtf8StringSchema(160),
}).strict();
export const engineResponseSchema = z.object({
  ok: z.boolean(),
  cancelledBeforeStart: z.literal(true).optional(),
  outputs: z.array(z.lazy(() => outputRecordSchema)).max(MAX_PROTOCOL_COLLECTION_ITEMS).optional(),
  stopped: z.boolean().optional(),
  page: tablePageSchema.nullable().optional(),
  output: richOutputPayloadSchema.optional(),
  package_version: boundedUtf8StringSchema(256, true).optional(),
  r_version: boundedUtf8StringSchema(256, true).optional(),
  value: richOutputPayloadSchema.optional(),
  selected: z.lazy(() => widgetSelectedSchema).optional(),
  log: z.array(boundedUtf8StringSchema(MAX_FRAME_BYTES)).max(1_048_578).optional(),
  truncated: z.boolean().optional(),
  error: engineErrorSchema.optional(),
  kernelStateInvalid: engineErrorSchema.optional(),
  variables: z.array(arkRuntimeVariableSchema).max(MAX_RUNTIME_VARIABLES).optional(),
  failures: z.array(arkCleanupFailureSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS).optional(),
  released: releaseArtifactNamesSchema.optional(),
  missing: releaseArtifactNamesSchema.optional(),
  failed: releaseArtifactNamesSchema.optional(),
}).strict();
export type EngineResponse = z.infer<typeof engineResponseSchema>;

export const R_ENVIRONMENT_PLATFORMS = [
  "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32",
] as const;
export type REnvironmentPlatform = typeof R_ENVIRONMENT_PLATFORMS[number];
export const rEnvironmentSchema = z.object({
  rscript: pathSchema,
  rHome: pathSchema,
  version: boundedUtf8StringSchema(256, true),
  platform: z.enum(R_ENVIRONMENT_PLATFORMS),
  arch: boundedUtf8StringSchema(64, true),
  libraryPaths: z.array(pathSchema).max(256).readonly(),
  identity: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type REnvironment = z.infer<typeof rEnvironmentSchema>;

export const evaluationPayloadSchema = z.object({
  sessionEpoch: idSchema,
  kernelEpoch: idSchema,
  operationId: idSchema,
  runId: idSchema,
  cellId: idSchema,
  revision: revisionSchema,
  documentRevision: revisionSchema,
  source: sourceTextSchema,
  definitions: analysisSymbolArraySchema,
  locals: analysisSymbolArraySchema,
  opaque: z.boolean(),
}).strict();
export type EvaluationPayload = z.infer<typeof evaluationPayloadSchema>;

const engineEventIdentitySchema = z.object({
  requestId: positiveIntegerSchema,
  sessionEpoch: idSchema,
  kernelEpoch: idSchema,
  operationId: idSchema,
  runId: idSchema,
  cellId: idSchema,
  revision: revisionSchema,
  documentRevision: revisionSchema,
});
export const engineStartedEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("started"),
  sequence: z.literal(0),
}).strict();
const engineProgressPayloadSchema = strictProtocolJsonSchema(z.object({ progress: z.lazy(() => progressOutputSchema) }).strict());
const engineAppendPayloadSchema = strictProtocolJsonSchema(z.object({ output: z.lazy(() => outputRecordSchema) }).strict());
const engineClearPayloadSchema = strictProtocolJsonSchema(z.object({}).strict());
const engineAppendOutputEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("output"),
  sequence: positiveIntegerSchema,
  kind: z.literal("append"),
  payload: engineAppendPayloadSchema,
}).strict();
const engineProgressOutputEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("output"),
  sequence: positiveIntegerSchema,
  kind: z.literal("progress"),
  payload: engineProgressPayloadSchema,
}).strict();
const engineLogOutputEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("output"),
  sequence: positiveIntegerSchema,
  kind: z.literal("log"),
  payload: protocolJsonSchema,
}).strict();
const engineClearOutputEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("output"),
  sequence: positiveIntegerSchema,
  kind: z.literal("clear"),
  payload: engineClearPayloadSchema,
}).strict();
export const engineOutputEventSchema = z.discriminatedUnion("kind", [
  engineAppendOutputEventSchema,
  engineProgressOutputEventSchema,
  engineLogOutputEventSchema,
  engineClearOutputEventSchema,
]);
export const engineCompletedEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("completed"),
  sequence: positiveIntegerSchema,
  result: engineResponseSchema,
}).strict();
export const engineEventSchema = z.discriminatedUnion("type", [
  engineStartedEventSchema,
  engineOutputEventSchema,
  engineCompletedEventSchema,
]);
export type EngineEvent = z.infer<typeof engineEventSchema>;

export const engineHandshakeSchema = z.object({
  protocol: z.literal(ENGINE_PROTOCOL),
  packageVersion: boundedUtf8StringSchema(256, true),
  rVersion: boundedUtf8StringSchema(256, true),
  capabilities: z.array(boundedUtf8StringSchema(256, true)).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  kernel: z.object({
    name: z.literal("ark"),
    version: boundedUtf8StringSchema(256, true),
    buildVersion: z.literal("0.1.252-alder.1"),
    mimePublisher: z.literal("alder-json-v1"),
    protocol: boundedUtf8StringSchema(256, true),
    kernelEpoch: idSchema,
  }).strict().optional(),
  kernelReady: z.boolean(),
  analyzerReady: z.boolean(),
  captureReady: z.boolean(),
}).strict();
export type EngineHandshake = z.infer<typeof engineHandshakeSchema>;

export interface AnalyzerIdentity {
  packageVersion: string;
  rVersion: string;
  policy: string;
  analysisEnvironmentId: string;
}
export interface KernelIdentity {
  name: "ark";
  version: string;
  protocol: string;
  kernelEpoch: string;
}

export type OutputScope = {
  sessionEpoch: string;
  documentRevision: number;
  kernelEpoch: string | null;
  runId: string | null;
  cellId: string | null;
  revision: number | null;
};

export type EngineRequestOptions = {
  outputScope: OutputScope;
};

export interface EngineRestartOptions {
  environment?: REnvironment;
  notebookDirectory?: string;
  cacheDirectory?: string;
}

export interface EngineAdapter {
  onFailure?(listener: (role: "kernel" | "analyzer" | "services", error: Error) => void): () => void;
  start(): Promise<EngineHandshake>;
  startAnalyzer?(): Promise<AnalyzerIdentity>;
  startKernel?(): Promise<KernelIdentity>;
  readonly environment?: REnvironment;
  setEnvironment?(environment: REnvironment): void;
  analyze(cells: readonly CellSnapshot[], revision: number, analysisEnvironmentId?: string): Promise<AnalysisResult>;
  evaluate(payload: EvaluationPayload, onEvent?: (event: EngineEvent) => void, signal?: AbortSignal): Promise<EngineResponse>;
  evaluateBatch?(payloads: readonly EvaluationPayload[], onEvent?: (event: EngineEvent) => void | Promise<void>, signal?: AbortSignal): Promise<Array<EngineResponse | undefined>>;
  invalidateBatch?(cellIds?: ReadonlySet<string>): void;
  request(command: string, payload?: Record<string, unknown>, options?: EngineRequestOptions): Promise<EngineResponse>;
  interrupt(requestId?: number): Promise<{ requested: boolean; requestId?: number }>;
  restart(options?: EngineRestartOptions): Promise<EngineHandshake>;
  close(): Promise<void>;
}

const storedCellOptionsSchema = safeStringRecordSchema(z.union([z.string(), z.boolean(), finiteNumberSchema]));
export const cellOptionSchema = z.union([z.string(), z.boolean(), finiteNumberSchema]);
export type CellOption = z.infer<typeof cellOptionSchema>;
export const cellOptionsSchema = storedCellOptionsSchema.superRefine((options, context) => {
  for (const key of Object.keys(options)) {
    if (key.trim().length === 0 || /[:\r\n]/.test(key)) {
      context.addIssue({ code: "custom", path: [key], message: "cell option key is invalid" });
    }
  }
  if (options.disabled !== undefined && typeof options.disabled !== "boolean") {
    context.addIssue({ code: "custom", path: ["disabled"], message: "disabled must be a boolean" });
  }
  if (options.name !== undefined && (typeof options.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(options.name))) {
    context.addIssue({ code: "custom", path: ["name"], message: "cell name is invalid" });
  }
});
const markdownPhysicalBodySchema = sourceLinesSchema;
const markdownSemanticBodySchema = z.array(sourceLineSchema).max(MAX_SOURCE_LINES);
function markdownLinesValid(lines: readonly string[]): boolean {
  return lines.every((line) => line.trim().length === 0 || /^\s*#/.test(line));
}
function validateCellBody(cellType: CellType, body: readonly string[], context: z.RefinementCtx, path: (string | number)[]): void {
  if (cellType === "markdown" && !markdownLinesValid(body)) {
    context.addIssue({ code: "custom", path, message: "markdown host bodies must be blank or R comments" });
  }
}

export const notebookCellInputSchema = z.object({
  id: idSchema,
  type: cellTypeSchema,
  body: markdownPhysicalBodySchema,
  options: cellOptionsSchema.optional().default({}),
  revision: revisionSchema.optional().default(0),
}).strict().superRefine((cell, context) => validateCellBody(cell.type, cell.body, context, ["body"]));
export type NotebookCellInput = z.input<typeof notebookCellInputSchema>;
export const notebookInputSchema = z.object({
  path: pathSchema.nullable().optional(),
  metadata: protocolJsonRecordSchema.optional().default({}),
  cells: z.array(notebookCellInputSchema).max(MAX_NOTEBOOK_CELLS),
}).strict().superRefine((notebook, context) => {
  const ids = new Set<string>();
  for (const [index, cell] of notebook.cells.entries()) {
    if (ids.has(cell.id)) context.addIssue({ code: "custom", path: ["cells", index, "id"], message: "duplicate cell id" });
    ids.add(cell.id);
  }
  if (notebookSourceByteLength(notebook.cells) > MAX_NOTEBOOK_SOURCE_BYTES) {
    context.addIssue({ code: "custom", path: ["cells"], message: "notebook source exceeds byte limit" });
  }
});
export interface NotebookInput {
  path?: string | null;
  metadata?: Record<string, unknown>;
  cells: Array<{ id: string; type: CellType; body: string[]; options?: Record<string, unknown>; revision?: number }>;
}

export const cellRefSchema = z.union([
  z.object({ cellId: idSchema }).strict(),
  z.object({ creationId: idSchema }).strict(),
]);
export type CellRef = z.infer<typeof cellRefSchema>;

export const textEditSchema = z.object({
  start: sourcePositionSchema,
  end: sourcePositionSchema,
  text: boundedUtf8StringSchema(MAX_NOTEBOOK_SOURCE_BYTES).superRefine((text, context) => {
    if (text.includes("\0")) context.addIssue({ code: "custom", message: "text edit contains NUL" });
  }),
}).strict();
export type TextEdit = z.infer<typeof textEditSchema>;
const documentChangeBase = z.object({ type: z.string() });
export const createDocumentChangeSchema = z.object({
  type: z.literal("create"), creationId: idSchema, after: cellRefSchema.nullable(), cellType: cellTypeSchema,
  body: markdownPhysicalBodySchema, options: cellOptionsSchema,
}).strict().superRefine((change, context) => validateCellBody(change.cellType, change.body, context, ["body"]));
export const editDocumentChangeSchema = z.object({
  type: z.literal("edit"), cell: cellRefSchema, expectedRevision: revisionSchema.optional(), body: markdownPhysicalBodySchema, cellType: cellTypeSchema,
}).strict().superRefine((change, context) => validateCellBody(change.cellType, change.body, context, ["body"]));
export const optionsDocumentChangeSchema = z.object({
  type: z.literal("options"), cell: cellRefSchema, expectedRevision: revisionSchema.optional(), patch: safeStringRecordSchema(cellOptionSchema.nullable()),
}).strict();
export const moveDocumentChangeSchema = z.object({ type: z.literal("move"), cell: cellRefSchema, after: cellRefSchema.nullable() }).strict();
export const deleteDocumentChangeSchema = z.object({ type: z.literal("delete"), cell: cellRefSchema, expectedRevision: revisionSchema.optional() }).strict();
export const textEditDocumentChangeSchema = z.object({
  type: z.literal("text-edit"), cell: cellRefSchema, expectedRevision: revisionSchema, edits: z.array(textEditSchema).min(1).max(MAX_SOURCE_LINES),
}).strict();
export const documentChangeSchema = z.discriminatedUnion("type", [
  createDocumentChangeSchema, editDocumentChangeSchema, optionsDocumentChangeSchema,
  moveDocumentChangeSchema, deleteDocumentChangeSchema, textEditDocumentChangeSchema,
]);
export type DocumentChange = z.infer<typeof documentChangeSchema>;
export const mcpDocumentChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), creationId: idSchema, after: cellRefSchema.nullable(), cellType: cellTypeSchema, body: markdownSemanticBodySchema, options: cellOptionsSchema }).strict(),
  z.object({ type: z.literal("edit"), cell: cellRefSchema, expectedRevision: revisionSchema.optional(), body: markdownSemanticBodySchema, cellType: cellTypeSchema }).strict(),
  optionsDocumentChangeSchema, moveDocumentChangeSchema, deleteDocumentChangeSchema, textEditDocumentChangeSchema,
]);
export type McpDocumentChange = z.infer<typeof mcpDocumentChangeSchema>;

const commandIdentityShape = {
  operationId: idSchema,
  clientId: idSchema,
  commandSequence: positiveIntegerSchema,
  sessionEpoch: idSchema,
};
export const commandIdentitySchema = z.object(commandIdentityShape).strict();
export type CommandIdentity = z.infer<typeof commandIdentitySchema>;
const sourceChangeArraySchema = z.array(documentChangeSchema).max(MAX_NOTEBOOK_CELLS);
function sourceChangeBytes(changes: readonly DocumentChange[]): number {
  let bytes = 0;
  for (const change of changes) {
    if ("body" in change) bytes += sourceLinesByteLength(change.body);
    if (change.type === "text-edit") for (const edit of change.edits) bytes += new TextEncoder().encode(edit.text).byteLength;
  }
  return bytes > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : bytes;
}
function sourceChangeLimit(changes: readonly DocumentChange[], context: z.RefinementCtx): void {
  if (sourceChangeBytes(changes) > MAX_NOTEBOOK_SOURCE_BYTES) context.addIssue({ code: "custom", path: ["changes"], message: "source changes exceed byte limit" });
}

export const transactionCommandSchema = z.object({
  ...commandIdentityShape, type: z.literal("transaction"), expectedDocumentRevision: revisionSchema, changes: sourceChangeArraySchema,
}).strict().superRefine((command, context) => sourceChangeLimit(command.changes, context));
export const runCommandSchema = z.object({
  ...commandIdentityShape, type: z.literal("run"), scope: z.enum(["cell", "all", "stale"]), target: cellRefSchema.optional(), startup: z.boolean().optional(),
  changes: sourceChangeArraySchema.optional(), expectedDocumentRevision: revisionSchema,
}).strict().superRefine((command, context) => {
  if (command.scope === "cell" && command.target === undefined) context.addIssue({ code: "custom", path: ["target"], message: "cell runs require one target" });
  if (command.scope !== "cell" && command.target !== undefined) context.addIssue({ code: "custom", path: ["target"], message: "target is only valid for cell runs" });
  sourceChangeLimit(command.changes ?? [], context);
});
export const selectRCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("select-r"), rscript: pathSchema, persistDefault: z.boolean(), expectedDocumentRevision: revisionSchema }).strict();
export const setAppCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("set-app"), patch: z.object({ layout: z.enum(["vertical", "grid", "slides"]).optional(), width: z.enum(["compact", "medium", "full"]).optional(), include_code: z.boolean().optional() }).strict(), expectedDocumentRevision: revisionSchema }).strict();
export const packagesDeclareCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("packages-declare"), packages: z.array(boundedUtf8StringSchema(256, true)).max(MAX_PROTOCOL_COLLECTION_ITEMS), expectedSidecarVersion: boundedUtf8StringSchema(MAX_ID_BYTES).nullable(), expectedDocumentRevision: revisionSchema }).strict();
export const packagesInstallCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("packages-install"), packages: z.array(boundedUtf8StringSchema(256, true)).max(MAX_PROTOCOL_COLLECTION_ITEMS), expectedDocumentRevision: revisionSchema, kernelEpoch: idSchema.nullable() }).strict();
export const publishCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("publish"), includeCode: z.boolean(), outputPath: pathSchema.optional(), expectedDocumentRevision: revisionSchema }).strict();
export const uploadFileSchema = z.object({ name: pathSchema, content_base64: boundedUtf8StringSchema(16 * 1024 * 1024, true) }).strict();
export const uploadCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("upload"), name: idSchema, path: z.array(idSchema).max(256), files: z.array(uploadFileSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS), kernelEpoch: idSchema }).strict();
export const saveCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("save"), expectedDocumentRevision: revisionSchema }).strict();
export const saveAsCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("save-as"), path: pathSchema, expectedDestination: z.union([z.literal("absent"), z.object({ expectedDiskDigest: z.string().min(1), expectedDiskVersion: z.string().min(1) }).strict()]), expectedDocumentRevision: revisionSchema }).strict();
export const reloadSourceCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("reload-source"), expectedDocumentRevision: revisionSchema, expectedDiskDigest: z.string().regex(/^[0-9a-f]{64}$/), expectedDiskVersion: boundedUtf8StringSchema(MAX_ID_BYTES, true) }).strict();
export const formatCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("format"), cellIds: z.array(idSchema).max(MAX_NOTEBOOK_CELLS).optional(), expectedRevisions: safeStringRecordSchema(revisionSchema), expectedDocumentRevision: revisionSchema }).strict();
export const setConfigCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("set-config"), patch: protocolJsonRecordSchema, expectedSidecarVersion: boundedUtf8StringSchema(MAX_ID_BYTES).nullable(), expectedDocumentRevision: revisionSchema }).strict();
export type LayoutGeometry = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type SlideObject = { readonly cells: string[]; readonly title?: string };
export type SlideGroup = string[] | SlideObject;
export type Layout = { readonly version: 1; readonly cells: Readonly<Record<string, LayoutGeometry>>; readonly layout?: "grid" | "slides"; readonly slides?: SlideGroup[] };
const layoutKey = boundedUtf8StringSchema(MAX_ID_BYTES, true).refine((key) => !key.includes("/") && !key.includes("\\") && key !== "." && key !== "..", "invalid layout cell key");
const layoutGeometrySchema = z.object({ x: z.number().int().min(0).max(11).safe(), y: z.number().int().min(0).max(1_000_000).safe(), w: z.number().int().min(1).max(12).safe(), h: z.number().int().min(1).max(1_000_000).safe() }).strict().superRefine((geometry, context) => {
  if (geometry.x + geometry.w > 12) context.addIssue({ code: "custom", path: ["w"], message: "geometry extends beyond the 12-column grid" });
});
const layoutCellsSchema = safeStringRecordSchema(layoutGeometrySchema);
const slideObjectSchema = z.object({ cells: z.array(layoutKey).min(1).max(MAX_NOTEBOOK_CELLS), title: boundedUtf8StringSchema(MAX_FRAME_BYTES, true).optional() }).strict();
const slideGroupSchema = z.union([z.array(layoutKey).min(1).max(MAX_NOTEBOOK_CELLS), slideObjectSchema]);
export const layoutSchema = z.object({ version: z.literal(1), cells: layoutCellsSchema, layout: z.enum(["grid", "slides"]).optional(), slides: z.array(slideGroupSchema).max(MAX_NOTEBOOK_CELLS).optional() }).strict().superRefine((value, context) => {
  const members: string[] = [];
  for (const [key] of Object.entries(value.cells)) if (!layoutKey.safeParse(key).success) context.addIssue({ code: "custom", path: ["cells", key], message: "invalid layout cell key" });
  for (const [index, group] of (value.slides ?? []).entries()) {
    const keys = Array.isArray(group) ? group : group.cells;
    if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["slides", index], message: "slide group contains duplicate cell keys" });
    members.push(...keys);
  }
  if (new Set(members).size !== members.length) context.addIssue({ code: "custom", path: ["slides"], message: "a cell key occurs in more than one slide" });
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LAYOUT_MAX_BYTES) {
      context.addIssue({ code: "custom", path: [], message: "layout exceeds byte limit" });
    }
  } catch {
    context.addIssue({ code: "custom", path: [], message: "layout is not serializable" });
  }
});
export const setLayoutCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("set-layout"), layout: layoutSchema, expectedSidecarVersion: boundedUtf8StringSchema(MAX_ID_BYTES).nullable(), expectedDocumentRevision: revisionSchema }).strict();
export const setRuntimeCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("set-runtime"), on_cell_change: z.enum(["automatic", "lazy"]).optional(), on_startup: z.boolean().optional(), expectedDocumentRevision: revisionSchema }).strict().refine((value) => value.on_cell_change !== undefined || value.on_startup !== undefined, "at least one runtime setting is required");
export const restartCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("restart"), replay: z.boolean().default(false), expectedDocumentRevision: revisionSchema.optional() }).strict().superRefine((value, context) => {
  if (value.replay && value.expectedDocumentRevision === undefined) context.addIssue({ code: "custom", path: ["expectedDocumentRevision"], message: "replay restart requires document revision" });
});
const widgetIndexArraySchema = z.array(positiveIntegerSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "widget indices must be unique" });
});
const widgetJsonValueSchema = protocolJsonSchema.superRefine((value, context) => {
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_FRAME_BYTES) context.addIssue({ code: "custom", message: "widget value exceeds the event limit" }); }
  catch { context.addIssue({ code: "custom", message: "widget value is not serializable" }); }
});
const selectedIsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const selectedUtcDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const widgetSelectedScalarSchema = z.object({
  type: z.enum(["logical", "integer", "double", "character", "NULL"]),
  value: widgetJsonValueSchema,
}).strict();
const widgetSelectedSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("date"), value: selectedIsoDateSchema }).strict(),
  z.object({ type: z.literal("date_range"), value: z.array(selectedIsoDateSchema).length(2) }).strict(),
  z.object({ type: z.literal("datetime"), value: selectedUtcDateTimeSchema }).strict(),
  z.object({ type: z.literal("data.frame"), value: z.array(safeStringRecordSchema(widgetJsonValueSchema)).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict(),
  z.object({ type: z.literal("list"), value: z.union([z.array(widgetJsonValueSchema), safeStringRecordSchema(widgetJsonValueSchema)]) }).strict(),
  widgetSelectedScalarSchema,
]);
export const widgetUpdateSchema = z.object({
  value: widgetJsonValueSchema.optional(),
  index: positiveIntegerSchema.optional(),
  indices: widgetIndexArraySchema.optional(),
  selected: widgetIndexArraySchema.optional(),
  ops: z.array(widgetJsonValueSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS).optional(),
  submit: z.boolean().optional(),
  paused: z.boolean().optional(),
}).strict().superRefine((update, context) => {
  const primary = ["value", "index", "indices", "selected", "ops", "submit"]
    .filter((key) => Object.prototype.hasOwnProperty.call(update, key));
  if (primary.length !== 1) context.addIssue({ code: "custom", message: "widget update requires exactly one primary field" });
  if (update.paused !== undefined && primary.length !== 1) context.addIssue({ code: "custom", message: "paused is only valid with a primary update" });
});
export type WidgetUpdate = z.infer<typeof widgetUpdateSchema>;
export const widgetCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("widget"), name: idSchema, path: z.array(idSchema).max(256), update: widgetUpdateSchema, source: z.enum(["editor", "app", "mcp", "cli"]), kernelEpoch: idSchema, expectedRevision: revisionSchema }).strict();
export const inspectCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("inspect"), name: idSchema, kernelEpoch: idSchema }).strict();
export const lazyOutputCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("lazy-output"), key: idSchema, kernelEpoch: idSchema }).strict();
export const tablePageCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("table-page"), handle: idSchema, offset: protocolIntegerSchema, limit: z.number().int().min(1).max(200).safe(), sortBy: boundedUtf8StringSchema(256), sortDescending: z.boolean(), filter: boundedUtf8StringSchema(MAX_FRAME_BYTES), kernelEpoch: idSchema }).strict();
export const interruptCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("interrupt"), runId: idSchema.optional() }).strict();
const activeClientIdsSchema = z.array(idSchema).max(128).refine(
  (clientIds) => new Set(clientIds).size === clientIds.length,
  "expectedClientIds must not contain duplicates",
);
export const shutdownCommandSchema = z.object({ ...commandIdentityShape, type: z.literal("shutdown"), expectedDocumentRevision: revisionSchema, expectedClientIds: activeClientIdsSchema }).strict();
export const hostCommandSchema = z.discriminatedUnion("type", [
  transactionCommandSchema, runCommandSchema, selectRCommandSchema, setAppCommandSchema, packagesDeclareCommandSchema, packagesInstallCommandSchema,
  publishCommandSchema, uploadCommandSchema, saveCommandSchema, saveAsCommandSchema, reloadSourceCommandSchema, formatCommandSchema,
  setConfigCommandSchema, setLayoutCommandSchema, setRuntimeCommandSchema, restartCommandSchema, widgetCommandSchema, inspectCommandSchema,
  lazyOutputCommandSchema, tablePageCommandSchema, interruptCommandSchema, shutdownCommandSchema,
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;

export type CellStatus = "idle" | "stale" | "running" | "done" | "error" | "stopped" | "disabled";
export const cellStatusSchema = z.enum(["idle", "stale", "running", "done", "error", "stopped", "disabled"]);
export type OperationStatus = "accepted" | "running" | "done" | "error" | "interrupted" | "cancelled";
export const operationStatusSchema = z.enum(["accepted", "running", "done", "error", "interrupted", "cancelled"]);
export const operationKindSchema = z.enum(["transaction", "run", "select-r", "set-app", "packages-declare", "packages-install", "publish", "upload", "save", "save-as", "reload-source", "format", "set-config", "set-layout", "set-runtime", "restart", "widget", "inspect", "lazy-output", "table-page", "interrupt", "shutdown", "widget-reset", "analysis"]);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const hostErrorSchema = z.object({ code: boundedUtf8StringSchema(256, true), message: boundedUtf8StringSchema(MAX_FRAME_BYTES), operationId: idSchema.nullable().optional(), details: protocolJsonSchema.optional() }).strict();
export type HostError = z.infer<typeof hostErrorSchema>;

const MAX_OPERATION_PROGRESS_BYTES = 64 * 1024;
const operationProgressDataSchema = protocolJsonSchema.superRefine((value, context) => {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_OPERATION_PROGRESS_BYTES) {
      context.addIssue({ code: "custom", message: "operation progress data exceeds 64 KiB" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "operation progress data is not serializable" });
  }
});
export interface OperationProgress {
  phase: "started" | "output" | "finished";
  stream?: "stdout" | "stderr";
  text?: string;
  data?: JsonValue;
}
export const operationProgressSchema = z.object({
  phase: z.enum(["started", "output", "finished"]),
  stream: z.enum(["stdout", "stderr"]).optional(),
  text: boundedUtf8StringSchema(MAX_OPERATION_PROGRESS_BYTES).optional(),
  data: operationProgressDataSchema.optional(),
}).strict();

export interface OperationRecord {
  id: string;
  clientId: string;
  commandSequence: number;
  kind: OperationKind;
  status: OperationStatus;
  documentRevision: number;
  runId: string | null;
  result: JsonValue | null;
  error: HostError | null;
  acceptedAt?: number;
  settledAt?: number;
  cellIds?: string[];
  token?: number;
  executionDone?: boolean;
  resetOperationIds?: string[];
  progress?: OperationProgress;
}
export const operationRecordSchema = z.object({
  id: idSchema, clientId: idSchema, commandSequence: positiveIntegerSchema, kind: operationKindSchema, status: operationStatusSchema,
  documentRevision: revisionSchema, runId: idSchema.nullable(), result: protocolJsonSchema.nullable(), error: hostErrorSchema.nullable(),
  acceptedAt: z.number().finite().nonnegative().optional(), settledAt: z.number().finite().nonnegative().optional(), cellIds: z.array(idSchema).max(MAX_NOTEBOOK_CELLS).optional(),
  token: protocolIntegerSchema.optional(), executionDone: z.boolean().optional(), resetOperationIds: z.array(idSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS).optional(), progress: operationProgressSchema.optional(),
}).strict();
export const commandAdmissionSchema = z.object({
  epoch: idSchema, clientId: idSchema, operationId: idSchema, commandSequence: positiveIntegerSchema, accepted: z.boolean(), sequenceConsumed: z.boolean(), operation: operationRecordSchema.nullable(), error: hostErrorSchema.nullable(), nextCommandSequence: positiveIntegerSchema,
}).strict();
export type CommandAdmission = z.infer<typeof commandAdmissionSchema>;

export const runtimeStateSchema = z.object({
  documentReady: z.boolean(), analyzerState: z.enum(["stopped", "starting", "ready", "failed"]), kernelState: z.enum(["stopped", "starting", "ready", "failed"]), executionReady: z.boolean(), startupActivated: z.boolean(), executionBlockedReason: hostErrorSchema.nullable(), kernelEpoch: idSchema.nullable(), rEnvironment: rEnvironmentSchema.nullable(), analysisEnvironmentId: analysisEnvironmentIdSchema.nullable(),
}).strict();
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export const runtimeModeSchema = z.enum(["automatic", "lazy"]);
export const hostRuntimeSchema = runtimeStateSchema.extend({ executionMode: runtimeModeSchema, runOnStartup: z.boolean(), packageOperationActive: z.boolean(), busy: z.boolean(), activeRunId: idSchema.nullable() }).strict();
export type HostRuntime = z.infer<typeof hostRuntimeSchema>;

export const diskObservationSchema = z.object({ state: z.enum(["untitled", "absent", "present", "unreadable"]), digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(), version: boundedUtf8StringSchema(MAX_ID_BYTES).nullable(), error: hostErrorSchema.nullable() }).strict();
export type DiskObservation = z.infer<typeof diskObservationSchema>;
export const sidecarObservationsSchema = z.object({ config: diskObservationSchema, layout: diskObservationSchema, packages: diskObservationSchema }).strict();
export type SidecarObservations = z.infer<typeof sidecarObservationsSchema>;

export const hostConfigurationSchema = z.object({
  rscript: pathSchema.nullable(),
  executionMode: runtimeModeSchema,
  runOnStartup: z.boolean(),
  deferStartup: z.boolean(),
}).strict();
export type HostConfiguration = z.infer<typeof hostConfigurationSchema>;

const protocolStringArraySchema = z.array(boundedUtf8StringSchema(MAX_FRAME_BYTES)).max(MAX_PROTOCOL_COLLECTION_ITEMS);
export interface HostCellState {
  id: string; type: CellType; body: string[]; options: Record<string, CellOption>; revision: number; status: CellStatus; outputs: OutputRecord[]; outputsStale?: boolean; progress: JsonValue | null; log: string[]; error: EngineError | null; defs: string[]; refs: string[]; selfRefs: string[]; locals: string[]; barrier: boolean; opaque: boolean; diagnostics: AnalysisDiagnostic[]; analysisPending: boolean;
}
export const hostCellStateSchema = z.object({ id: idSchema, type: cellTypeSchema, body: sourceLinesSchema, options: storedCellOptionsSchema, revision: revisionSchema, status: cellStatusSchema, outputs: z.array(z.lazy(() => outputRecordSchema)).max(MAX_PROTOCOL_COLLECTION_ITEMS), outputsStale: z.boolean().optional(), progress: protocolJsonSchema.nullable(), log: z.array(boundedUtf8StringSchema(MAX_FRAME_BYTES)).max(1_048_578), error: engineErrorSchema.nullable(), defs: protocolStringArraySchema, refs: protocolStringArraySchema, selfRefs: protocolStringArraySchema, locals: protocolStringArraySchema, barrier: z.boolean(), opaque: z.boolean(), diagnostics: z.array(analysisDiagnosticSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS), analysisPending: z.boolean() }).strict();

export interface DependencyGraphState { nodes: string[]; edges: Record<string, string[]>; reverseEdges: Record<string, string[]>; duplicates: Record<string, string[]>; cycles: string[]; topologicalOrder: string[] | null; }
const graphCellIds = z.array(idSchema).max(MAX_NOTEBOOK_CELLS);
const graphMap = safeStringRecordSchema(graphCellIds);
export const dependencyGraphStateSchema = z.object({ nodes: graphCellIds, edges: graphMap, reverseEdges: graphMap, duplicates: graphMap, cycles: graphCellIds, topologicalOrder: graphCellIds.nullable() }).strict();
export interface RuntimeVariable { name: string; owner: string | null; revision: number | null; class: string; dim: number[] | null; size: number; widget: boolean; valueSummary?: string; }
export const runtimeVariableSchema = z.object({ name: boundedUtf8StringSchema(MAX_ANALYSIS_SYMBOL_BYTES, true), owner: idSchema.nullable(), revision: revisionSchema.nullable(), class: boundedUtf8StringSchema(MAX_ANALYSIS_SYMBOL_BYTES, true), dim: z.array(protocolIntegerSchema).max(64).nullable(), size: protocolIntegerSchema, widget: z.boolean(), valueSummary: boundedUtf8StringSchema(160).optional() }).strict();
export const runtimeVariablesSchema = z.array(runtimeVariableSchema).max(MAX_RUNTIME_VARIABLES);
export const editorDiagnosticsSchema = safeStringRecordSchema(z.array(analysisDiagnosticSchema).max(MAX_EDITOR_DIAGNOSTICS));
export const serviceErrorsSchema = z.object({ lsp: hostErrorSchema.optional() }).strict();

export interface HostSnapshot {
  protocol: typeof HOST_PROTOCOL; epoch: string; cursor: number; version: number; documentRevision: number; path: string | null; metadata: Record<string, JsonValue>; config: Record<string, JsonValue>; layout: JsonValue; dirty: boolean; changed?: boolean; disk: DiskObservation; sidecars: SidecarObservations; runtime: HostRuntime; cells: HostCellState[]; graph: DependencyGraphState; variables: RuntimeVariable[]; editorDiagnostics: Record<string, AnalysisDiagnostic[]>; serviceErrors: { lsp?: HostError }; operations: OperationRecord[]; lastValue: JsonValue | null; lastActionError: HostError | null; capabilities?: string[]; nextCommandSequence?: number; activeClientIds?: string[];
}
export const hostSnapshotSchema = z.object({ protocol: z.literal(HOST_PROTOCOL), epoch: idSchema, cursor: protocolIntegerSchema, version: protocolIntegerSchema, documentRevision: revisionSchema, path: pathSchema.nullable(), metadata: protocolJsonRecordSchema, config: protocolJsonRecordSchema, layout: protocolJsonSchema, dirty: z.boolean(), changed: z.boolean().optional(), disk: diskObservationSchema, sidecars: sidecarObservationsSchema, runtime: hostRuntimeSchema, cells: z.array(hostCellStateSchema).max(MAX_NOTEBOOK_CELLS), graph: dependencyGraphStateSchema, variables: runtimeVariablesSchema, editorDiagnostics: editorDiagnosticsSchema, serviceErrors: serviceErrorsSchema, operations: z.array(operationRecordSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS), lastValue: protocolJsonSchema.nullable(), lastActionError: hostErrorSchema.nullable(), capabilities: z.array(boundedUtf8StringSchema(256)).max(MAX_PROTOCOL_COLLECTION_ITEMS).optional(), nextCommandSequence: positiveIntegerSchema.optional(), activeClientIds: z.array(idSchema).max(128).optional() }).strict();

export interface HostEvent { protocol: typeof HOST_PROTOCOL; epoch: string; cursor: number; version: number; documentRevision: number; timestamp: number; type: HostEventType; operationId?: string; clientId?: string; commandSequence?: number; cellId?: string; runId?: string; kernelEpoch?: string | null; revision?: number; sequence?: number; payload: JsonValue; }
export type HostEventType = "receipt" | "transaction" | "notebook" | "cell" | "cell-started" | "cell-output" | "cell-completed" | "diagnostics" | "editor-diagnostics" | "service-errors" | "graph" | "variables" | "runtime" | "operation" | "service-error" | "active_clients_changed";
export const hostEventTypeSchema = z.enum(["receipt", "transaction", "notebook", "cell", "cell-started", "cell-output", "cell-completed", "diagnostics", "editor-diagnostics", "service-errors", "graph", "variables", "runtime", "operation", "service-error", "active_clients_changed"]);
const eventBase = { protocol: z.literal(HOST_PROTOCOL), epoch: idSchema, cursor: protocolIntegerSchema, version: protocolIntegerSchema, documentRevision: revisionSchema, timestamp: z.number().finite().nonnegative(), operationId: idSchema.optional(), clientId: idSchema.optional(), commandSequence: positiveIntegerSchema.optional(), cellId: idSchema.optional(), runId: idSchema.optional(), kernelEpoch: idSchema.nullable().optional(), revision: revisionSchema.optional(), sequence: protocolIntegerSchema.optional() };
export const hostEventSchema = z.object({ ...eventBase, type: hostEventTypeSchema, payload: protocolJsonSchema }).strict();

export interface RecoveryBranch { id: string; documentRevision: number; baseDisk: DiskObservation; sourceHandle: ArtifactHandle; state: "clean" | "dirty" | "conflict"; conflict: HostError | null; }
export const recoveryBranchSchema = z.object({ id: idSchema, documentRevision: revisionSchema, baseDisk: diskObservationSchema, sourceHandle: z.lazy(() => artifactHandleSchema), state: z.enum(["clean", "dirty", "conflict"]), conflict: hostErrorSchema.nullable() }).strict();
export interface RecoveryState { branches: RecoveryBranch[]; pending: boolean; corruption: HostError | null; }
export const recoveryStateSchema = z.object({ branches: z.array(recoveryBranchSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS), pending: z.boolean(), corruption: hostErrorSchema.nullable() }).strict();
export type RecoveryDelta = { kind: "source" | "sidecar"; value: JsonValue };
export type RecoveryBaseline = { documentRevision: number; disk: DiskObservation };
export type RecoveryDiskObservations = SidecarObservations;
export type Recovery = { kind: "replay"; epoch: string; cursor: number; events: HostEvent[] } | { kind: "snapshot"; epoch: string; cursor: number; snapshot: HostSnapshot };
export const recoverySchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("replay"), epoch: idSchema, cursor: protocolIntegerSchema, events: z.array(hostEventSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict(), z.object({ kind: z.literal("snapshot"), epoch: idSchema, cursor: protocolIntegerSchema, snapshot: hostSnapshotSchema }).strict()]);

export interface CommandResult { epoch: string; operation: OperationRecord; documentRevision: number; version: number; cursor: number; nextCommandSequence: number; result: JsonValue | null; error: HostError | null; }
export const commandResultSchema = z.object({ epoch: idSchema, operation: operationRecordSchema, documentRevision: revisionSchema, version: protocolIntegerSchema, cursor: protocolIntegerSchema, nextCommandSequence: positiveIntegerSchema, result: protocolJsonSchema.nullable(), error: hostErrorSchema.nullable() }).strict();

const queryOffset = protocolIntegerSchema.optional();
const cellQueryLimit = z.number().int().min(1).max(1_000).safe().optional();
const outputQueryLimit = z.number().int().min(1).max(262_144).safe().optional();
const artifactHandleIdSchema = idSchema.pipe(boundedUtf8StringSchema(MAX_ARTIFACT_HANDLE_BYTES, true)).refine((value) => !/[\\/]/.test(value) && !value.includes("..") && !value.startsWith("."), "invalid artifact handle");
export const hostQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notebook") }).strict(), z.object({ type: z.literal("cells"), offset: queryOffset, limit: cellQueryLimit }).strict(), z.object({ type: z.literal("cell"), cellId: idSchema }).strict(), z.object({ type: z.literal("graph") }).strict(), z.object({ type: z.literal("outputs"), cellId: idSchema.optional() }).strict(), z.object({ type: z.literal("output"), handle: artifactHandleIdSchema, offset: queryOffset, limit: outputQueryLimit }).strict(), z.object({ type: z.literal("operation"), operationId: idSchema, clientId: idSchema.optional() }).strict(), z.object({ type: z.literal("events"), epoch: idSchema.nullable(), cursor: protocolIntegerSchema.nullable() }).strict(), z.object({ type: z.literal("config") }).strict(), z.object({ type: z.literal("layout") }).strict(), z.object({ type: z.literal("packages-status") }).strict(), z.object({ type: z.literal("check") }).strict(), z.object({ type: z.literal("source") }).strict(), z.object({ type: z.literal("help"), contents: protocolJsonSchema }).strict(), z.object({ type: z.literal("recovery") }).strict(),
]);
export type HostQuery = z.infer<typeof hostQuerySchema>;
const notebookCellDescriptorSchema = z.object({ id: idSchema, type: cellTypeSchema, options: storedCellOptionsSchema, revision: revisionSchema }).strict();
export const notebookQueryResultSchema = z.object({
  protocol: z.literal(HOST_PROTOCOL), epoch: idSchema, cursor: protocolIntegerSchema, version: protocolIntegerSchema, documentRevision: revisionSchema,
  path: pathSchema.nullable(), metadata: protocolJsonRecordSchema, config: protocolJsonRecordSchema, dirty: z.boolean(), changed: z.boolean().optional(),
  disk: diskObservationSchema, sidecars: sidecarObservationsSchema, runtime: hostRuntimeSchema,
  capabilities: z.array(boundedUtf8StringSchema(256, true)).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  nextCommandSequence: positiveIntegerSchema, activeClientIds: z.array(idSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  cells: z.array(notebookCellDescriptorSchema).max(MAX_NOTEBOOK_CELLS),
}).strict();
export type NotebookQueryResult = z.infer<typeof notebookQueryResultSchema>;
export interface HostQueryResult { epoch: string; documentRevision: number; cursor: number; result: JsonValue | ArtifactHandle; }
export const hostQueryResultSchema = z.object({ epoch: idSchema, documentRevision: revisionSchema, cursor: protocolIntegerSchema, result: z.union([protocolJsonSchema, z.lazy(() => artifactHandleSchema)]) }).strict();
export interface ControllerServices { save?(snapshot: HostSnapshot): Promise<Record<string, unknown>>; format?(cells: readonly Pick<HostCellState, "id" | "type" | "body" | "revision">[]): Promise<Record<string, string[]>>; service?(command: string, payload: Record<string, unknown>): Promise<unknown>; refreshPackageEnvironment?(): Promise<REnvironment>; }

export type TableHandle = string;
export interface TablePage {
  nrow: number;
  ncol: number;
  columns: string[];
  preview: JsonValue[][];
  offset: number;
  limit: number;
  sort_by: string;
  sort_desc: boolean;
  filter: string;
  truncated_rows: boolean;
  truncated_columns: boolean;
}
export interface TextOutput { kind: "text"; text: string; truncated: boolean; }
export interface TableOutput extends TablePage {
  kind: "table";
  handle: TableHandle;
  page?: TablePage | null;
}
export interface ImageOutput { kind: "image"; artifact: ArtifactHandle; mime?: string; alt?: string; }
export interface HtmlOutput {
  kind: "html";
  artifact?: ArtifactHandle;
  html?: string;
  alt_text?: string;
}
export interface MarkdownOutput { kind: "markdown"; html: string; text: string; }
export interface MediaOutput { kind: "media"; media_type: "image" | "audio" | "video" | "pdf"; artifact: ArtifactHandle; mime: string; alt: string; }

/** Compare MIME values by their media-type essence, ignoring parameters. */
export function mimeEssence(value: string): string {
  const separator = value.indexOf(";");
  return value.slice(0, separator < 0 ? value.length : separator).trim().toLowerCase();
}

/** Return whether a MIME value can be rendered by the declared media kind. */
export function mediaMimeCompatible(mediaType: string, mimeType: string): boolean {
  const essence = mimeEssence(mimeType);
  if (essence.length === 0) return false;
  if (mediaType === "pdf") return mimeType === "application/pdf";
  if (mediaType === "image") return essence.startsWith("image/");
  if (mediaType === "audio") return essence.startsWith("audio/");
  if (mediaType === "video") return essence.startsWith("video/");
  return false;
}

/** HTML artifact documents are the only rich outputs loaded into srcdoc. */
export function htmlMimeCompatible(mimeType: string): boolean {
  const essence = mimeEssence(mimeType);
  return essence === "text/html" || essence === "application/xhtml+xml";
}

export function sameMimeEssence(left: string, right: string): boolean {
  return mimeEssence(left) === mimeEssence(right);
}

export const widgetOperationStatusSchema = z.enum(["pending", "done", "error", "cancelled"]);
const widgetOperationErrorSchema = z.object({
  code: boundedUtf8StringSchema(256, true),
  message: boundedUtf8StringSchema(MAX_FRAME_BYTES),
}).strict();
export const widgetOperationSchema = z.object({
  token: protocolIntegerSchema,
  operationId: idSchema,
  draft: z.boolean().optional(),
  status: widgetOperationStatusSchema,
  error: widgetOperationErrorSchema.nullable(),
}).strict();
export type WidgetOperation = z.infer<typeof widgetOperationSchema>;
export interface WidgetOutput { kind: "widget"; name: string; owner: string; path: string[]; commit_token: number | null; operation: WidgetOperation | null; operations?: Record<string, WidgetOperation>; spec: WidgetSpec; }
export type LayoutKind = "callout" | "hstack" | "vstack" | "tabs" | "accordion" | "sidebar";
export interface LayoutOutput { kind: "layout"; layout: LayoutKind; attrs: Record<string, JsonValue>; children: RichOutputPayload[]; }
export interface LazyOutput { kind: "lazy"; key: string; label: string; state: "collapsed" | "pending" | "ready" | "error"; child: RichOutputPayload | null; }
export interface ProgressOutput { kind: "progress"; value: number; total: number | null; label: string; done: boolean; }
export interface ErrorOutput { kind: "error"; code?: string; message: string; }
export type RichOutputPayload = TextOutput | TableOutput | ImageOutput | HtmlOutput | MarkdownOutput | MediaOutput | WidgetOutput | LayoutOutput | LazyOutput | ProgressOutput | ErrorOutput;

const outputHandleIdSchema = idSchema.refine((value) => !/[\\/]/.test(value) && !value.includes("..") && !value.startsWith("."), "invalid output handle");
const tableCellSchema = protocolJsonSchema;
const tablePreviewSchema = z.array(z.array(tableCellSchema).max(MAX_TABLE_COLUMNS)).max(MAX_TABLE_PREVIEW_ROWS);
const tablePagePreviewSchema = z.array(z.array(tableCellSchema).max(MAX_TABLE_COLUMNS)).max(200);
const tablePageShape = z.object({
  nrow: protocolIntegerSchema,
  ncol: protocolIntegerSchema,
  columns: z.array(boundedUtf8StringSchema(256)).max(MAX_TABLE_COLUMNS),
  preview: tablePagePreviewSchema,
  offset: protocolIntegerSchema,
  limit: z.number().int().min(1).max(200).safe(),
  sort_by: boundedUtf8StringSchema(256),
  sort_desc: z.boolean(),
  filter: boundedUtf8StringSchema(MAX_FRAME_BYTES),
  truncated_rows: z.boolean(),
  truncated_columns: z.boolean(),
}).strict().superRefine((page, context) => {
  if (page.ncol !== 0 && page.columns.length > page.ncol) context.addIssue({ code: "custom", path: ["columns"], message: "too many table columns" });
  if (page.preview.some((row) => row.length > page.columns.length && page.columns.length > 0)) context.addIssue({ code: "custom", path: ["preview"], message: "table row exceeds visible columns" });
});
const outputChildSchema = z.lazy(() => richOutputPayloadSchema);
export const textOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(z.object({ kind: z.literal("text"), text: boundedUtf8StringSchema(MAX_FRAME_BYTES), truncated: z.boolean() }).strict());
const tableOutputShape = z.object({
  kind: z.literal("table"),
  nrow: protocolIntegerSchema,
  ncol: protocolIntegerSchema,
  columns: z.array(boundedUtf8StringSchema(256)).max(MAX_TABLE_COLUMNS),
  preview: tablePreviewSchema,
  offset: protocolIntegerSchema,
  limit: z.number().int().min(1).max(200).safe(),
  sort_by: boundedUtf8StringSchema(256),
  sort_desc: z.boolean(),
  filter: boundedUtf8StringSchema(MAX_FRAME_BYTES),
  truncated_rows: z.boolean(),
  truncated_columns: z.boolean(),
  handle: outputHandleIdSchema,
  page: tablePageSchema.nullable().optional(),
}).strict().superRefine((table, context) => {
  if (table.ncol !== 0 && table.columns.length > table.ncol) context.addIssue({ code: "custom", path: ["columns"], message: "too many table columns" });
});
export const tableOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(tableOutputShape);
export const imageOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(
  z.object({ kind: z.literal("image"), artifact: z.lazy(() => artifactHandleSchema), mime: boundedUtf8StringSchema(256).optional(), alt: boundedUtf8StringSchema(4_096).optional() }).strict()
    .superRefine((value, context) => {
      const declaredMime = value.mime ?? value.artifact.mimeType;
      if (!mediaMimeCompatible("image", declaredMime)) {
        context.addIssue({ code: "custom", path: ["artifact", "mimeType"], message: "image output MIME type is incompatible with image output" });
      }
      if (value.mime !== undefined && !sameMimeEssence(value.mime, value.artifact.mimeType)) {
        context.addIssue({ code: "custom", path: ["mime"], message: "image output MIME does not match its artifact" });
      }
    }),
);
const inlineHtmlOutputSchema = z.object({ kind: z.literal("html"), html: boundedUtf8StringSchema(MAX_FRAME_BYTES), alt_text: boundedUtf8StringSchema(4_096).optional() }).strict();
const sandboxHtmlOutputSchema = z.object({ kind: z.literal("html"), artifact: z.lazy(() => artifactHandleSchema), alt_text: boundedUtf8StringSchema(4_096).optional() }).strict()
  .superRefine((value, context) => {
    if (!htmlMimeCompatible(value.artifact.mimeType)) {
      context.addIssue({ code: "custom", path: ["artifact", "mimeType"], message: "HTML output artifact MIME type is not an HTML document" });
    }
  });
export const htmlOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(z.union([inlineHtmlOutputSchema, sandboxHtmlOutputSchema]));
export const markdownOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(z.object({ kind: z.literal("markdown"), html: boundedUtf8StringSchema(MAX_FRAME_BYTES), text: boundedUtf8StringSchema(MAX_FRAME_BYTES) }).strict());
export const mediaOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(
  z.object({ kind: z.literal("media"), media_type: z.enum(["image", "audio", "video", "pdf"]), artifact: z.lazy(() => artifactHandleSchema), mime: boundedUtf8StringSchema(256, true), alt: boundedUtf8StringSchema(4_096) }).strict()
    .superRefine((value, context) => {
      if (!mediaMimeCompatible(value.media_type, value.mime)) {
        context.addIssue({ code: "custom", path: ["mime"], message: "media output MIME type is incompatible with media_type" });
      }
      if (!sameMimeEssence(value.mime, value.artifact.mimeType)) {
        context.addIssue({ code: "custom", path: ["artifact", "mimeType"], message: "media output MIME does not match its artifact" });
      }
      if (!mediaMimeCompatible(value.media_type, value.artifact.mimeType)) {
        context.addIssue({ code: "custom", path: ["artifact", "mimeType"], message: "artifact MIME type is incompatible with media_type" });
      }
    }),
);

const widgetKindSchema = z.enum(["slider", "range_slider", "number", "dropdown", "radio", "multiselect", "text_input", "text_area", "checkbox", "switch", "run_button", "button", "date", "date_range", "datetime", "code_editor", "refresh", "file", "table", "dataframe", "array", "dictionary", "form"]);
const widgetLabelSchema = boundedUtf8StringSchema(4_096).nullable().optional();
const widgetNameSchema = boundedUtf8StringSchema(MAX_ID_BYTES).optional();
const widgetChoiceSchema = z.union([boundedUtf8StringSchema(4_096), finiteNumberSchema, z.boolean()]);
const widgetChoicesSchema = z.array(widgetChoiceSchema).min(1).max(MAX_PROTOCOL_COLLECTION_ITEMS).superRefine((choices, context) => {
  if (choices.length === 0) return;
  const type = typeof choices[0];
  const seen = new Set<string>();
  choices.forEach((choice, index) => {
    if (typeof choice !== type) context.addIssue({ code: "custom", path: [index], message: "choices must have one scalar type" });
    const key = JSON.stringify([typeof choice, choice]);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "choices must be unique" });
    seen.add(key);
  });
});
const widgetBase = { label: widgetLabelSchema, name: widgetNameSchema };
const sliderSpecSchema = z.object({ ...widgetBase, kind: z.literal("slider"), value: finiteNumberSchema, min: finiteNumberSchema, max: finiteNumberSchema, step: finiteNumberSchema.positive() }).strict().superRefine((spec, context) => {
  if (spec.min > spec.max) context.addIssue({ code: "custom", path: ["max"], message: "min must not exceed max" });
  if (spec.value < spec.min || spec.value > spec.max) context.addIssue({ code: "custom", path: ["value"], message: "value is outside slider bounds" });
  if (Math.abs((spec.value - spec.min) / spec.step - Math.round((spec.value - spec.min) / spec.step)) > 1e-9) context.addIssue({ code: "custom", path: ["value"], message: "value is off the step lattice" });
});
const rangeSliderSpecSchema = z.object({ ...widgetBase, kind: z.literal("range_slider"), value: z.tuple([finiteNumberSchema, finiteNumberSchema]), min: finiteNumberSchema, max: finiteNumberSchema, step: finiteNumberSchema.positive() }).strict().superRefine((spec, context) => {
  if (spec.min > spec.max) context.addIssue({ code: "custom", path: ["max"], message: "min must not exceed max" });
  const values = spec.value;
  if (!isFiniteNumberPair(values)) return;
  if (values[0] > values[1] || values.some((value) => value < spec.min || value > spec.max)) context.addIssue({ code: "custom", path: ["value"], message: "value is outside range slider bounds" });
  for (const value of values) if (Math.abs((value - spec.min) / spec.step - Math.round((value - spec.min) / spec.step)) > 1e-9) context.addIssue({ code: "custom", path: ["value"], message: "value is off the step lattice" });
});
const numberSpecSchema = z.object({ ...widgetBase, kind: z.literal("number"), value: finiteNumberSchema, min: finiteNumberSchema.nullable().optional(), max: finiteNumberSchema.nullable().optional(), step: finiteNumberSchema.positive() }).strict().superRefine((spec, context) => {
  if (spec.min !== undefined && spec.min !== null && spec.max !== undefined && spec.max !== null && spec.min > spec.max) context.addIssue({ code: "custom", path: ["max"], message: "min must not exceed max" });
  if (spec.min !== undefined && spec.min !== null && spec.value < spec.min) context.addIssue({ code: "custom", path: ["value"], message: "value is below min" });
  if (spec.max !== undefined && spec.max !== null && spec.value > spec.max) context.addIssue({ code: "custom", path: ["value"], message: "value exceeds max" });
  const base = spec.min ?? 0;
  if (Math.abs((spec.value - base) / spec.step - Math.round((spec.value - base) / spec.step)) > 1e-9) context.addIssue({ code: "custom", path: ["value"], message: "value is off the step lattice" });
});
function choiceSpecSchema(kind: "dropdown" | "radio" | "multiselect") {
  const valueSchema = kind === "multiselect" ? z.array(widgetChoiceSchema) : widgetChoiceSchema;
  return z.object({ ...widgetBase, kind: z.literal(kind), value: valueSchema, choices: widgetChoicesSchema, ...(kind === "multiselect" ? { indices: z.array(positiveIntegerSchema).optional() } : { index: positiveIntegerSchema.optional() }) }).strict().superRefine((spec, context) => {
    const candidate = spec as any;
    const choiceType = typeof candidate.choices[0];
    if (kind === "multiselect") {
      const values = candidate.value as Array<string | number | boolean>;
      const seen = new Set<string>();
      let previous = 0;
      values.forEach((value, index) => {
        if (typeof value !== choiceType) context.addIssue({ code: "custom", path: ["value", index], message: "value type differs from choices" });
        const choiceIndex = candidate.choices.findIndex((choice: unknown) => typeof choice === typeof value && Object.is(choice, value));
        if (choiceIndex < 0) context.addIssue({ code: "custom", path: ["value", index], message: "value is not a choice" });
        const valueKey = JSON.stringify([typeof value, value]);
        if (seen.has(valueKey)) context.addIssue({ code: "custom", path: ["value", index], message: "value contains duplicates" });
        seen.add(valueKey);
        if (choiceIndex >= 0 && choiceIndex < previous) context.addIssue({ code: "custom", path: ["value", index], message: "value must follow choice order" });
        if (choiceIndex >= 0) previous = choiceIndex;
      });
      if (candidate.indices !== undefined) {
        if (candidate.indices.length !== values.length) context.addIssue({ code: "custom", path: ["indices"], message: "indices must match selected values" });
        candidate.indices.forEach((index: number, position: number) => { if (index > candidate.choices.length || (position > 0 && index <= candidate.indices[position - 1])) context.addIssue({ code: "custom", path: ["indices", position], message: "invalid choice index" }); });
      }
    } else {
      const value = candidate.value as string | number | boolean;
      const choiceIndex = candidate.choices.findIndex((choice: unknown) => typeof choice === typeof value && Object.is(choice, value));
      if (typeof value !== choiceType || choiceIndex < 0) context.addIssue({ code: "custom", path: ["value"], message: "value must be one of choices" });
      if (candidate.index !== undefined && (candidate.index > candidate.choices.length || candidate.index !== choiceIndex + 1)) context.addIssue({ code: "custom", path: ["index"], message: "index does not identify value" });
    }
  });
}
const dateValueSchema = boundedUtf8StringSchema(10).regex(/^\d{4}-\d{2}-\d{2}$/, "invalid date").refine((value) => {
  const millis = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}, "invalid calendar date");
const datetimeValueSchema = boundedUtf8StringSchema(32).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "invalid UTC datetime").refine((value) => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 19) + "Z" === value;
}, "invalid datetime");
const fileRowSchema = z.object({ name: boundedUtf8StringSchema(4_096, true), size: finiteNumberSchema.nonnegative(), path: boundedUtf8StringSchema(32 * 1024, true) }).strict();
const fileValueSchema = z.array(fileRowSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS);
const tableWidgetPageSchema = tablePageSchema.nullable().optional();
const widgetSpecSchema: z.ZodTypeAny = z.lazy(() => widgetSpecUnion);
const widgetCompositeChildrenSchema = z.array(widgetSpecSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS);
const widgetArraySpecSchema = z.object({ ...widgetBase, kind: z.literal("array"), value: protocolJsonSchema, children: widgetCompositeChildrenSchema }).strict().superRefine((spec, context) => { const names = spec.children.map((child: any) => child.name).filter((name: unknown): name is string => typeof name === "string"); if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["children"], message: "child names must be unique" }); });
const widgetDictionarySpecSchema = z.object({ ...widgetBase, kind: z.literal("dictionary"), value: protocolJsonSchema, children: z.array(widgetSpecSchema).min(1).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict().superRefine((spec, context) => { const names = spec.children.map((child: any) => child.name); if (names.some((name: unknown) => typeof name !== "string" || name.length === 0) || new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["children"], message: "dictionary child names must be unique and non-empty" }); });
const widgetFormSpecSchema = z.object({ ...widgetBase, kind: z.literal("form"), value: protocolJsonSchema.nullable(), submit_label: boundedUtf8StringSchema(4_096), dirty: z.boolean(), child: widgetSpecSchema }).strict();
const widgetSpecUnion = z.union([
  sliderSpecSchema, rangeSliderSpecSchema, numberSpecSchema, choiceSpecSchema("dropdown"), choiceSpecSchema("radio"), choiceSpecSchema("multiselect"),
  z.object({ ...widgetBase, kind: z.literal("text_input"), value: boundedUtf8StringSchema(MAX_FRAME_BYTES) }).strict(),
  z.object({ ...widgetBase, kind: z.literal("text_area"), value: boundedUtf8StringSchema(MAX_FRAME_BYTES), rows: positiveIntegerSchema }).strict(),
  z.object({ ...widgetBase, kind: z.literal("code_editor"), value: boundedUtf8StringSchema(MAX_FRAME_BYTES), language: z.enum(["r", "sql", "python", "markdown", "json"]) }).strict(),
  z.object({ ...widgetBase, kind: z.literal("checkbox"), value: z.boolean() }).strict(), z.object({ ...widgetBase, kind: z.literal("switch"), value: z.boolean() }).strict(), z.object({ ...widgetBase, kind: z.literal("run_button"), value: z.boolean() }).strict(),
  z.object({ ...widgetBase, kind: z.literal("button"), value: protocolIntegerSchema }).strict(),
  z.object({ ...widgetBase, kind: z.literal("date"), value: dateValueSchema, min: dateValueSchema.nullable().optional(), max: dateValueSchema.nullable().optional() }).strict().superRefine((spec, context) => { if (spec.min && spec.max && spec.min > spec.max) context.addIssue({ code: "custom", path: ["max"], message: "min must not exceed max" }); if (spec.min && spec.value < spec.min) context.addIssue({ code: "custom", path: ["value"], message: "value is below min" }); if (spec.max && spec.value > spec.max) context.addIssue({ code: "custom", path: ["value"], message: "value exceeds max" }); }),
  z.object({ ...widgetBase, kind: z.literal("date_range"), value: z.tuple([dateValueSchema, dateValueSchema]), min: dateValueSchema.nullable().optional(), max: dateValueSchema.nullable().optional() }).strict().superRefine((spec, context) => { if (spec.value[0] > spec.value[1]) context.addIssue({ code: "custom", path: ["value"], message: "date range must be ordered" }); if (spec.min && spec.max && spec.min > spec.max) context.addIssue({ code: "custom", path: ["max"], message: "min must not exceed max" }); if (spec.min && spec.value[0] < spec.min) context.addIssue({ code: "custom", path: ["value"], message: "value is below min" }); if (spec.max && spec.value[1] > spec.max) context.addIssue({ code: "custom", path: ["value"], message: "value exceeds max" }); }),
  z.object({ ...widgetBase, kind: z.literal("datetime"), value: datetimeValueSchema, min: datetimeValueSchema.nullable().optional(), max: datetimeValueSchema.nullable().optional() }).strict().superRefine((spec, context) => { if (spec.min && spec.max && spec.min > spec.max) context.addIssue({ code: "custom", path: ["max"], message: "min must not exceed max" }); if (spec.min && spec.value < spec.min) context.addIssue({ code: "custom", path: ["value"], message: "value is below min" }); if (spec.max && spec.value > spec.max) context.addIssue({ code: "custom", path: ["value"], message: "value exceeds max" }); }),
  z.object({ ...widgetBase, kind: z.literal("refresh"), value: protocolIntegerSchema, interval: finiteNumberSchema.min(0.5), paused: z.boolean() }).strict(),
  z.object({ ...widgetBase, kind: z.literal("file"), value: fileValueSchema, accept: z.array(boundedUtf8StringSchema(1_024, true)).min(1).nullable().optional(), multiple: z.boolean() }).strict(),
  z.object({ ...widgetBase, kind: z.literal("table"), value: protocolJsonSchema, handle: outputHandleIdSchema, selection: z.enum(["multi", "single", "none"]), page_size: z.number().int().min(1).max(200).safe(), selected: z.array(protocolIntegerSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS), page: tableWidgetPageSchema }).strict(),
  z.object({ ...widgetBase, kind: z.literal("dataframe"), value: protocolJsonSchema, handle: outputHandleIdSchema, ops: protocolJsonSchema, page: tableWidgetPageSchema }).strict(),
  widgetArraySpecSchema, widgetDictionarySpecSchema, widgetFormSpecSchema,
]);
export type WidgetSpec = z.infer<typeof widgetSpecUnion>;
const widgetOutputShape = z.object({ kind: z.literal("widget"), name: idSchema, owner: idSchema, path: z.array(idSchema).max(256), commit_token: protocolIntegerSchema.nullable(), operation: widgetOperationSchema.nullable(), operations: safeStringRecordSchema(widgetOperationSchema).optional(), spec: widgetSpecSchema }).strict();
export const widgetOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(widgetOutputShape);
const calloutLayoutSchema = z.object({ kind: z.literal("layout"), layout: z.literal("callout"), attrs: z.object({ variant: z.enum(["info", "warn", "danger", "success"]) }).strict(), children: z.array(outputChildSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict();
const hstackLayoutSchema = z.object({ kind: z.literal("layout"), layout: z.literal("hstack"), attrs: z.object({ gap: finiteNumberSchema.nonnegative().max(4_096), align: z.enum(["start", "center", "end", "stretch"]), justify: z.enum(["start", "center", "end", "space-between", "space-around", "space-evenly"]) }).strict(), children: z.array(outputChildSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict();
const vstackLayoutSchema = z.object({ kind: z.literal("layout"), layout: z.literal("vstack"), attrs: z.object({ gap: finiteNumberSchema.nonnegative().max(4_096) }).strict(), children: z.array(outputChildSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict();
const titledLayoutSchema = z.object({ kind: z.literal("layout"), layout: z.enum(["tabs", "accordion"]), attrs: z.object({ titles: z.array(boundedUtf8StringSchema(4_096)).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict(), children: z.array(outputChildSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict().superRefine((layout, context) => { if (layout.attrs.titles.length !== 0 && layout.attrs.titles.length !== layout.children.length) context.addIssue({ code: "custom", path: ["attrs", "titles"], message: "titles must match children" }); });
const sidebarLayoutSchema = z.object({ kind: z.literal("layout"), layout: z.literal("sidebar"), attrs: z.object({}).strict(), children: z.array(outputChildSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict();
const layoutOutputShape = z.union([calloutLayoutSchema, hstackLayoutSchema, vstackLayoutSchema, titledLayoutSchema, sidebarLayoutSchema]);
export const layoutOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(layoutOutputShape);
export const lazyOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(z.object({ kind: z.literal("lazy"), key: outputHandleIdSchema, label: boundedUtf8StringSchema(4_096), state: z.enum(["collapsed", "pending", "ready", "error"]), child: outputChildSchema.nullable() }).strict());
export const progressOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(z.object({ kind: z.literal("progress"), value: finiteNumberSchema.nonnegative(), total: finiteNumberSchema.nonnegative().nullable(), label: boundedUtf8StringSchema(4_096), done: z.boolean() }).strict());
export const errorOutputSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(z.object({ kind: z.literal("error"), code: boundedUtf8StringSchema(256).optional(), message: boundedUtf8StringSchema(MAX_FRAME_BYTES) }).strict());
const richOutputShape = z.union([textOutputSchema, tableOutputSchema, imageOutputSchema, htmlOutputSchema, markdownOutputSchema, mediaOutputSchema, widgetOutputSchema, layoutOutputSchema, lazyOutputSchema, progressOutputSchema, errorOutputSchema]);
export interface ArtifactHandle { handle: string; mimeType: string; byteLength: number; chunkBytes: 262_144; epoch: string; documentRevision: number; kernelEpoch: string | null; }
const artifactHandleShape = z.object({ handle: artifactHandleIdSchema, mimeType: boundedUtf8StringSchema(256, true), byteLength: protocolIntegerSchema.max(MAX_ARTIFACT_BYTES), chunkBytes: z.literal(OUTPUT_CHUNK_BYTES), epoch: idSchema, documentRevision: revisionSchema, kernelEpoch: idSchema.nullable() }).strict();
export const artifactHandleSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(artifactHandleShape);

// Browser-only content negotiation on the existing output query; never part of a tool result.
export const ARTIFACT_RESOLUTION_MEDIA_TYPE = "application/vnd.alder.artifact+json";
export const ARTIFACT_DESCRIPTOR_HEADER = "x-alder-artifact";
export const MAX_ARTIFACT_DESCRIPTOR_HEADER_BYTES = 4_096;
const artifactResourceNamePattern = "[A-Za-z0-9][A-Za-z0-9._-]{0,255}";
export const artifactResourceNameSchema = boundedUtf8StringSchema(256, true)
  .regex(new RegExp("^" + artifactResourceNamePattern + "(?![\\s\\S])"));
export const artifactResolutionSchema = z.object({
  artifact: artifactHandleSchema,
  url: boundedUtf8StringSchema(512, true)
    .regex(new RegExp("^/artifacts/[A-Za-z0-9_-]{43}/" + artifactResourceNamePattern + "(?![\\s\\S])")),
  expiresAt: positiveIntegerSchema,
}).strict();
export type ArtifactResolution = z.infer<typeof artifactResolutionSchema>;

export function encodeArtifactDescriptor(descriptor: ArtifactHandle): string {
  const encoded = encodeURIComponent(JSON.stringify(artifactHandleSchema.parse(descriptor)));
  if (encoded.length > MAX_ARTIFACT_DESCRIPTOR_HEADER_BYTES) throw new Error("artifact descriptor exceeds its header limit");
  return encoded;
}

export function parseArtifactDescriptor(encoded: string): ArtifactHandle {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_ARTIFACT_DESCRIPTOR_HEADER_BYTES ||
      /[^\x21-\x7e]/.test(encoded)) throw new Error("invalid artifact descriptor header");
  const descriptor = artifactHandleSchema.parse(parseStrictJson(decodeURIComponent(encoded), {
    maxBytes: MAX_ARTIFACT_DESCRIPTOR_HEADER_BYTES, maxDepth: 8,
  }));
  if (encodeArtifactDescriptor(descriptor) !== encoded) throw new Error("artifact descriptor header is not canonical");
  return descriptor;
}

export function sameArtifactHandle(left: ArtifactHandle, right: ArtifactHandle): boolean {
  return left.handle === right.handle && left.mimeType === right.mimeType && left.byteLength === right.byteLength &&
    left.chunkBytes === right.chunkBytes && left.epoch === right.epoch &&
    left.documentRevision === right.documentRevision && left.kernelEpoch === right.kernelEpoch;
}
const canonicalJsonOutputSchema = z.object({ mime: z.literal("application/json"), value: protocolJsonSchema, preview: boundedUtf8StringSchema(MAX_FRAME_BYTES) }).strict();
const outputDataSchema = z.union([z.lazy(() => richOutputPayloadSchema), canonicalJsonOutputSchema]);
const outputMetadataSchema = protocolJsonRecordSchema.superRefine((value, context) => { if (value.presentation !== "inline" && value.presentation !== "sandbox") context.addIssue({ code: "custom", path: ["presentation"], message: "host output metadata must declare presentation" }); });
const outputRecordShape = z.object({ id: idSchema, sessionEpoch: idSchema, kernelEpoch: idSchema.nullable(), runId: idSchema.nullable(), cellId: idSchema, revision: revisionSchema, sequence: positiveIntegerSchema, data: outputDataSchema, metadata: outputMetadataSchema, truncated: z.boolean() }).strict().superRefine((record, context) => { if ((record.kernelEpoch === null) !== (record.runId === null)) { context.addIssue({ code: "custom", path: ["kernelEpoch"], message: "kernelEpoch and runId must be paired" }); context.addIssue({ code: "custom", path: ["runId"], message: "kernelEpoch and runId must be paired" }); } });
export const outputRecordSchema = (protocolJsonSchema as z.ZodTypeAny).pipe(outputRecordShape);
export type OutputRecord = z.infer<typeof outputRecordSchema>;

export const sessionIdentitySchema = z.object({ sessionKey: idSchema, canonicalPath: pathSchema.nullable(), origin: boundedUtf8StringSchema(2_048, true), browserOrigin: boundedUtf8StringSchema(2_048, true), epoch: idSchema, processNonce: idSchema }).strict();
export type SessionIdentity = z.infer<typeof sessionIdentitySchema>;
export const sessionRegistryMetadataSchema = z.object({ state: z.enum(["starting", "ready", "stopping"]), pid: positiveIntegerSchema, processNonce: idSchema, continuityProof: idSchema, startIdentity: idSchema, canonicalPath: pathSchema.nullable(), origin: boundedUtf8StringSchema(2_048, true), epoch: idSchema, token: z.string().regex(/^[0-9a-f]{64}$/), protocol: z.literal(HOST_PROTOCOL), address: z.object({ host: boundedUtf8StringSchema(256, true), port: z.number().int().min(0).max(65_535).safe(), origin: boundedUtf8StringSchema(2_048, true), browserOrigin: boundedUtf8StringSchema(2_048, true) }).strict().optional() }).strict();
export type SessionRegistryMetadata = z.infer<typeof sessionRegistryMetadataSchema>;
export const sessionLeaseSchema = z.object({ leaseId: idSchema, clientId: idSchema, nextCommandSequence: positiveIntegerSchema, epoch: idSchema }).strict();
export type SessionLease = z.infer<typeof sessionLeaseSchema>;
export const attachLeaseRequestSchema = z.object({ action: z.literal("attach") }).strict();
export type AttachLeaseRequest = z.infer<typeof attachLeaseRequestSchema>;
export const leaseActionRequestSchema = z.object({ action: z.enum(["heartbeat", "release"]), leaseId: idSchema, disposition: z.enum(["normal", "discard"]).optional() }).strict().superRefine((value, context) => {
  if (value.action === "heartbeat" && value.disposition !== undefined) context.addIssue({ code: "custom", path: ["disposition"], message: "heartbeat cannot have a release disposition" });
});
export type LeaseActionRequest = z.infer<typeof leaseActionRequestSchema>;
export const ticketMintRequestSchema = z.object({ origin: boundedUtf8StringSchema(2_048, true), parentLeaseId: idSchema.optional() }).strict();
export type TicketMintRequest = z.infer<typeof ticketMintRequestSchema>;
export const ticketMintResponseSchema = z.object({ ticket: idSchema, expiresAt: boundedUtf8StringSchema(256, true) }).strict();
export type TicketMintResponse = z.infer<typeof ticketMintResponseSchema>;
export const ticketExchangeRequestSchema = z.object({ ticket: idSchema }).strict();
export type TicketExchangeRequest = z.infer<typeof ticketExchangeRequestSchema>;
export const ticketExchangeResponseSchema = z.object({ leaseId: idSchema, clientId: idSchema, nextCommandSequence: positiveIntegerSchema, epoch: idSchema, continuityProof: idSchema, csrf: idSchema, recoveryKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), recoveryKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict();
export type TicketExchangeResponse = z.infer<typeof ticketExchangeResponseSchema>;
export const hostIdentitySchema = z.object({ protocol: z.literal(HOST_PROTOCOL), epoch: idSchema, processNonce: idSchema, continuityProof: idSchema, sessionKey: idSchema, canonicalPath: pathSchema.nullable(), capabilities: z.array(boundedUtf8StringSchema(256, true)).max(MAX_PROTOCOL_COLLECTION_ITEMS), origin: boundedUtf8StringSchema(2_048, true), browserOrigin: boundedUtf8StringSchema(2_048, true), address: z.object({ host: boundedUtf8StringSchema(256, true), port: z.number().int().min(0).max(65_535).safe(), origin: boundedUtf8StringSchema(2_048, true), browserOrigin: boundedUtf8StringSchema(2_048, true) }).strict().optional(), leaseId: idSchema.optional(), clientId: idSchema.optional(), nextCommandSequence: positiveIntegerSchema.optional(), documentReady: z.boolean(), configuration: hostConfigurationSchema }).strict();
export type HostIdentity = z.infer<typeof hostIdentitySchema>;
export type SessionRequest = (path: string, init?: RequestInit) => Promise<Response>;
export interface SessionConnectionData { sessionKey: string; canonicalPath: string | null; origin: string; browserOrigin: string; epoch: string; processNonce: string; continuityProof: string; leaseId: string; clientId: string; nextCommandSequence: number; capabilities: string[]; }
export type SessionReleaseDisposition = "normal" | "discard";
export interface SessionConnection extends SessionConnectionData { request: SessionRequest; heartbeat(): Promise<void>; release(disposition?: SessionReleaseDisposition): Promise<void>; }
export const sessionConnectionSchema = z.object({ sessionKey: idSchema, canonicalPath: pathSchema.nullable(), origin: boundedUtf8StringSchema(2_048, true), browserOrigin: boundedUtf8StringSchema(2_048, true), epoch: idSchema, processNonce: idSchema, continuityProof: idSchema, leaseId: idSchema, clientId: idSchema, nextCommandSequence: positiveIntegerSchema, capabilities: z.array(boundedUtf8StringSchema(256, true)).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict();

export const windowActionSchema = z.enum(["new", "open", "save", "save-as", "publish", "run-cell", "run-all", "run-stale", "interrupt", "restart", "settings", "select-r", "close"]);
export type WindowAction = z.infer<typeof windowActionSchema>;
export const windowActionMessageSchema = z.object({ action: windowActionSchema }).strict();
export const windowStateSchema = z.object({ path: pathSchema.nullable(), dirty: z.boolean(), platform: boundedUtf8StringSchema(64, true), sessionEpoch: idSchema }).strict();
export type WindowState = z.infer<typeof windowStateSchema>;
export interface SaveDestination { path: string; expectedDestination: "absent" | { expectedDiskDigest: string; expectedDiskVersion: string }; }
export const desktopRecoveryRequestSchema = z.object({
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  action: z.enum(["read", "write", "remove", "list"]),
  name: z.string().max(256).optional(), prefix: z.string().max(256).optional(), value: z.unknown().optional(),
}).strict();
export type DesktopRecoveryRequest = z.infer<typeof desktopRecoveryRequestSchema>;
export interface PreloadApi { recovery(request: DesktopRecoveryRequest): Promise<unknown>; openNotebook(): Promise<void>; chooseSavePath(): Promise<SaveDestination | null>; chooseRscript(): Promise<string | null>; getWindowState(): Promise<WindowState>; hostShutdown(): Promise<void>; saveCancelled(): Promise<void>; rendererReady(): Promise<void>; onWindowAction(callback: (action: WindowAction) => void): () => void; }

export class ProtocolError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "ProtocolError"; this.code = code; } }
export function decodeJsonFrame(input: string | Uint8Array, maxBytes = MAX_FRAME_BYTES): unknown {
  try { return parseStrictJson(input, { maxBytes, maxDepth: MAX_JSON_DEPTH }); }
  catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    const message = typeof value.message === "string" ? value.message : "frame is not valid JSON";
    const code = typeof value.code === "string"
      ? value.code
      : message.startsWith("duplicate object key")
        ? "duplicate_key"
        : message.startsWith("invalid UTF-8")
          ? "invalid_utf8"
          : message.startsWith("JSON nesting limit exceeded")
            ? "nesting_too_deep"
            : message.startsWith("JSON input exceeds")
              ? "frame_too_large"
              : "invalid_json";
    throw new ProtocolError(code, message);
  }
}
export function sourceLinesByteLength(lines: readonly string[]): number { let bytes = 0; for (const [index, line] of lines.entries()) { bytes += new TextEncoder().encode(line).byteLength + Number(index > 0); if (bytes > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER; } return bytes; }
export function notebookSourceByteLength(cells: readonly { body: readonly string[] }[]): number { let bytes = 0; for (const cell of cells) { bytes += sourceLinesByteLength(cell.body); if (bytes > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER; } return bytes; }
function wireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolError("invalid_request", label + " must be an object");
  return value as Record<string, unknown>;
}

function wireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError("invalid_request", label + " must be an array");
  return value;
}

function sourceLines(value: unknown, label: string): string[] {
  const decoded = decodeWireSource(value);
  if (!Array.isArray(decoded)) throw new ProtocolError("invalid_request", label + " must use a line-array transfer value");
  return decoded;
}

function sourceText(value: unknown, label: string): string {
  const decoded = decodeWireSource(value);
  if (typeof decoded !== "string") throw new ProtocolError("invalid_request", label + " must use a scalar transfer value");
  return decoded;
}

function stringLines(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) throw new ProtocolError("invalid_request", label + " must be an array of strings");
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ProtocolError("invalid_request", label + " must be a string");
  return value;
}

function encodeDocumentChangeWire(value: unknown): unknown {
  const change = wireRecord(value, "document change");
  switch (change.type) {
    case "create":
    case "edit": return { ...change, body: encodeWireSource(stringLines(change.body, "document change body")) };
    case "text-edit": return {
      ...change,
      edits: wireArray(change.edits, "text edits").map((edit) => {
        const item = wireRecord(edit, "text edit");
        return { ...item, text: encodeWireSource(stringValue(item.text, "text edit text")) };
      }),
    };
    default: return { ...change };
  }
}

function decodeDocumentChangeWire(value: unknown): unknown {
  const change = wireRecord(value, "document change");
  switch (change.type) {
    case "create":
    case "edit": return { ...change, body: sourceLines(change.body, "document change body") };
    case "text-edit": return {
      ...change,
      edits: wireArray(change.edits, "text edits").map((edit) => {
        const item = wireRecord(edit, "text edit");
        return { ...item, text: sourceText(item.text, "text edit text") };
      }),
    };
    default: return { ...change };
  }
}

export function encodeHostCommandWire(command: HostCommand): unknown {
  const value = wireRecord(command, "host command");
  if ((value.type === "transaction" || value.type === "run") && value.changes !== undefined) {
    return { ...value, changes: wireArray(value.changes, "command changes").map(encodeDocumentChangeWire) };
  }
  return { ...value };
}

export function decodeHostCommandWire(value: unknown): unknown {
  const command = wireRecord(value, "host command");
  if ((command.type === "transaction" || command.type === "run") && command.changes !== undefined) {
    return { ...command, changes: wireArray(command.changes, "command changes").map(decodeDocumentChangeWire) };
  }
  return { ...command };
}

function encodeCellWire(value: unknown): unknown {
  const cell = wireRecord(value, "cell");
  if (cell.body === undefined) return { ...cell };
  return { ...cell, body: encodeWireSource(stringLines(cell.body, "cell body")) };
}

function decodeCellWire(value: unknown): unknown {
  const cell = wireRecord(value, "cell");
  if (cell.body === undefined) return { ...cell };
  return { ...cell, body: sourceLines(cell.body, "cell body") };
}

function snapshotCellWire(value: unknown, encode: boolean): unknown {
  const cell = wireRecord(value, "snapshot cell");
  if (cell.body === undefined) throw new ProtocolError("invalid_request", "snapshot cell body is required");
  return encode ? encodeCellWire(cell) : decodeCellWire(cell);
}

export function encodeHostSnapshotWire(snapshot: HostSnapshot): unknown {
  return { ...snapshot, cells: wireArray(snapshot.cells, "snapshot cells").map((cell) => snapshotCellWire(cell, true)) };
}

export function decodeHostSnapshotWire(value: unknown): unknown {
  const snapshot = wireRecord(value, "host snapshot");
  const cells = wireArray(snapshot.cells, "snapshot cells").map((cell) => snapshotCellWire(cell, false));
  const decoded = { ...snapshot, cells } as { cells: Array<{ body: string[] }> };
  if (notebookSourceByteLength(decoded.cells) > MAX_NOTEBOOK_SOURCE_BYTES) throw new ProtocolError("invalid_request", "snapshot source exceeds the transfer budget");
  return decoded;
}

function eventCellPayload(type: unknown): boolean {
  return type === "cell" || type === "cell-started" || type === "cell-completed";
}

export function encodeHostEventWire(event: HostEvent): unknown {
  const value = wireRecord(event, "host event");
  return eventCellPayload(value.type) ? { ...value, payload: encodeCellWire(value.payload) } : { ...value };
}

export function decodeHostEventWire(value: unknown): unknown {
  const event = wireRecord(value, "host event");
  return eventCellPayload(event.type) ? { ...event, payload: decodeCellWire(event.payload) } : { ...event };
}

export type WireRecovery =
  | { kind: "replay"; epoch: string; cursor: number; events: unknown[] }
  | { kind: "snapshot"; epoch: string; cursor: number; snapshot: unknown };
export type RecoveryTransfer = WireRecovery | ArtifactHandle;

function isArtifactHandle(value: unknown): value is ArtifactHandle {
  return artifactHandleSchema.safeParse(value).success;
}

export function encodeRecoveryWire(recovery: Recovery | ArtifactHandle): RecoveryTransfer {
  if (isArtifactHandle(recovery)) return recovery;
  if (recovery.kind === "replay") return { ...recovery, events: recovery.events.map(encodeHostEventWire) };
  return { ...recovery, snapshot: encodeHostSnapshotWire(recovery.snapshot) };
}

export function decodeRecoveryWire(value: unknown): unknown {
  if (isArtifactHandle(value)) return value;
  const recovery = wireRecord(value, "recovery");
  if (recovery.kind === "replay") return { ...recovery, events: wireArray(recovery.events, "recovery events").map(decodeHostEventWire) };
  if (recovery.kind === "snapshot") return { ...recovery, snapshot: decodeHostSnapshotWire(recovery.snapshot) };
  throw new ProtocolError("invalid_request", "invalid recovery transfer");
}

export function encodeHostQueryWire(query: HostQuery): unknown {
  const value = wireRecord(query, "host query");
  return { ...value };
}

export function decodeHostQueryWire(value: unknown): unknown {
  const query = wireRecord(value, "host query");
  return { ...query };
}

function isSnapshotPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cells = (value as Record<string, unknown>).cells;
  return Array.isArray(cells) && cells.every((cell) => typeof cell === "object" && cell !== null && !Array.isArray(cell) && "body" in cell);
}

function mapQueryResultWire(queryType: unknown, result: unknown, encode: boolean): unknown {
  if (isArtifactHandle(result)) return result;
  switch (queryType) {
    case "notebook": return isSnapshotPayload(result) ? (encode ? encodeHostSnapshotWire(result as HostSnapshot) : decodeHostSnapshotWire(result)) : result;
    case "cells": return wireArray(result, "cells query result").map(encode ? encodeCellWire : decodeCellWire);
    case "cell": return encode ? encodeCellWire(result) : decodeCellWire(result);
    case "source": return wireArray(result, "source query result").map(encode ? encodeCellWire : decodeCellWire);
    case "events": return encode ? encodeRecoveryWire(result as Recovery) : decodeRecoveryWire(result);
    default: return result;
  }
}

export function encodeHostQueryResultWire(query: HostQuery, result: HostQueryResult): unknown {
  const value = wireRecord(result, "host query result");
  return { ...value, result: mapQueryResultWire(query.type, value.result, true) };
}

export function decodeHostQueryResultWire(query: HostQuery, value: unknown): unknown {
  const result = wireRecord(value, "host query result");
  return { ...result, result: mapQueryResultWire(query.type, result.result, false) };
}

export function parseHostCommand(input: unknown): HostCommand { const result = hostCommandSchema.safeParse(input); if (!result.success) throw new ProtocolError("invalid_request", z.prettifyError(result.error)); return result.data; }
export function parseHostQuery(input: unknown): HostQuery { const result = hostQuerySchema.safeParse(input); if (!result.success) throw new ProtocolError("invalid_request", z.prettifyError(result.error)); return result.data; }
