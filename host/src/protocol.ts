import { z } from "zod";

export const HOST_PROTOCOL = "alder-host-v1" as const;
export const ENGINE_PROTOCOL = "alder-engine-v1" as const;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
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

const idSchema = z.string().min(1).max(256);
const revisionSchema = z.number().int().nonnegative().max(2_147_483_647);
const sourceLineSchema = z.string().max(MAX_SOURCE_LINE_LENGTH).superRefine((line, context) => {
  if (line.includes("\n") || line.includes("\r")) {
    context.addIssue({ code: "custom", message: "source lines cannot contain line breaks" });
  }
  if (line.includes("\0")) {
    context.addIssue({ code: "custom", message: "source lines cannot contain NUL" });
  }
  if (hasUnpairedSurrogate(line)) {
    context.addIssue({ code: "custom", message: "source lines must contain valid Unicode" });
  }
});
const sourceLinesSchema = z.array(sourceLineSchema).max(MAX_SOURCE_LINES);
const recordSchema = safeStringRecordSchema(z.unknown());
const optionValueSchema = z.union([z.string(), z.boolean(), z.number().finite()]);
const storedCellOptionsSchema = safeStringRecordSchema(optionValueSchema).superRefine((options, context) => {
  for (const key of Object.keys(options)) {
    if (key.trim().length === 0 || /[:\r\n]/.test(key)) {
      context.addIssue({ code: "custom", path: [key], message: "cell option key is invalid" });
    }
  }
  if (options.disabled !== undefined && typeof options.disabled !== "boolean") {
    context.addIssue({ code: "custom", path: ["disabled"], message: "disabled must be a boolean" });
  }
});
const cellOptionsSchema = storedCellOptionsSchema.superRefine((options, context) => {
  if (options.name !== undefined
    && (typeof options.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(options.name))) {
    context.addIssue({
      code: "custom",
      path: ["name"],
      message: "cell name must match ^[A-Za-z][A-Za-z0-9_.]*$",
    });
  }
});

export const cellTypeSchema = z.enum(["code", "markdown"]);
export type CellType = z.infer<typeof cellTypeSchema>;

export const cellSnapshotSchema = z.object({
  id: idSchema,
  revision: revisionSchema,
  type: cellTypeSchema,
  source: z.string(),
}).strict();

export interface CellSnapshot extends z.infer<typeof cellSnapshotSchema> {}

export const analysisDiagnosticSchema = z.object({
  level: z.enum(["error", "warning", "info"]).default("error"),
  code: z.string().min(1).default("analysis"),
  message: z.string(),
  symbol: z.string().nullable().optional(),
  source: z.string().optional(),
}).passthrough();

export type AnalysisDiagnostic = z.infer<typeof analysisDiagnosticSchema>;

const analysisSymbolSchema = boundedUtf8StringSchema(1_024, true);
const analysisSymbolArraySchema = z.array(analysisSymbolSchema).max(10_000);

export const analysisCellResultSchema = z.object({
  id: idSchema,
  revision: revisionSchema,
  defs: analysisSymbolArraySchema,
  refs: analysisSymbolArraySchema,
  selfRefs: analysisSymbolArraySchema,
  locals: analysisSymbolArraySchema,
  barrier: z.boolean(),
  opaque: z.boolean(),
  diagnostics: z.array(z.unknown()).max(MAX_EDITOR_DIAGNOSTICS),
  error: z.string().max(MAX_FRAME_BYTES).nullable(),
}).strict();

export interface AnalysisCellResult
  extends z.infer<typeof analysisCellResultSchema> {}

export const analysisResultSchema = z.object({
  revision: revisionSchema,
  cells: z.array(analysisCellResultSchema).max(MAX_NOTEBOOK_CELLS),
  analyzer: z.object({
    packageVersion: z.string(),
    rVersion: z.string(),
    policy: z.string(),
  }).strict(),
}).strict();

export interface AnalysisResult extends z.infer<typeof analysisResultSchema> {}

export const engineErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  interrupted: z.boolean().optional(),
  transport: z.boolean().optional(),
}).passthrough();

export const engineResponseSchema = z.object({
  ok: z.boolean(),
  outputs: z.array(z.unknown()).optional(),
  stopped: z.boolean().optional(),
  log: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
  error: engineErrorSchema.optional(),
}).passthrough();

export interface EngineResponse extends z.infer<typeof engineResponseSchema> {
  [key: string]: unknown;
}

export const evaluationPayloadSchema = z.object({
  sessionEpoch: idSchema,
  operationId: idSchema,
  runId: idSchema,
  cellId: idSchema,
  revision: revisionSchema,
  source: z.string(),
  definitions: analysisSymbolArraySchema,
  locals: analysisSymbolArraySchema,
  opaque: z.boolean(),
}).strict();

export interface EvaluationPayload
  extends z.infer<typeof evaluationPayloadSchema> {}

const engineEventIdentitySchema = z.object({
  requestId: z.number().int().positive().safe(),
  sessionEpoch: idSchema,
  operationId: idSchema,
  runId: idSchema,
  cellId: idSchema,
  revision: revisionSchema,
});

export const engineStartedEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("started"),
  sequence: z.literal(0),
}).strict();

export const engineOutputEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("output"),
  sequence: z.number().int().positive().safe(),
  kind: z.enum(["append", "progress", "log", "clear"]),
  payload: z.unknown(),
}).strict().superRefine((event, context) => {
  if (event.kind === "clear" && (
    typeof event.payload !== "object"
    || event.payload === null
    || Array.isArray(event.payload)
    || Object.keys(event.payload).length !== 0
  )) {
    context.addIssue({ code: "custom", path: ["payload"], message: "clear output payload must be an empty object" });
  }
});

export const engineCompletedEventSchema = engineEventIdentitySchema.extend({
  type: z.literal("completed"),
  sequence: z.number().int().positive().safe(),
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
  packageVersion: z.string(),
  rVersion: z.string(),
  capabilities: z.array(z.string()),
  kernel: z.object({
    name: z.literal("ark"),
    version: z.string().min(1),
    protocol: z.string().min(1),
  }).strict().optional(),
  kernelReady: z.boolean(),
  analyzerReady: z.boolean(),
  captureReady: z.boolean(),
}).strict();

export interface EngineHandshake extends z.infer<typeof engineHandshakeSchema> {}

export interface EngineAdapter {
  onFailure?(
    listener: (role: "kernel" | "analyzer" | "services", error: Error) => void,
  ): () => void;
  start(): Promise<EngineHandshake>;
  analyze(cells: readonly CellSnapshot[], revision: number): Promise<AnalysisResult>;
  evaluate(
    payload: EvaluationPayload,
    onEvent?: (event: EngineEvent) => void,
    signal?: AbortSignal,
  ): Promise<EngineResponse>;
  evaluateBatch?(
    payloads: readonly EvaluationPayload[],
    onEvent?: (event: EngineEvent) => void | Promise<void>,
  ): Promise<Array<EngineResponse | undefined>>;
  invalidateBatch?(cellIds?: ReadonlySet<string>): void;
  request(
    command: string,
    payload?: Record<string, unknown>,
  ): Promise<EngineResponse>;
  interrupt(requestId?: number): Promise<{ requested: boolean; requestId?: number }>;
  restart(): Promise<EngineHandshake>;
  close(): Promise<void>;
}

export const notebookCellInputSchema = z.object({
  id: idSchema,
  type: cellTypeSchema,
  body: sourceLinesSchema,
  // Existing source can use renderer-facing labels such as Quarto's
  // hyphenated labels. Preserve them; create/rename inputs use the stricter
  // mutable option schema below.
  options: storedCellOptionsSchema.optional().default({}),
  revision: revisionSchema.optional().default(0),
}).strict();

export type NotebookCellInput = z.input<typeof notebookCellInputSchema>;

export const notebookInputSchema = z.object({
  path: z.string().nullable().optional(),
  metadata: recordSchema.optional().default({}),
  cells: z.array(notebookCellInputSchema).max(MAX_NOTEBOOK_CELLS),
}).strict().superRefine((notebook, context) => {
  const ids = new Set<string>();
  for (const [index, cell] of notebook.cells.entries()) {
    if (ids.has(cell.id)) {
      context.addIssue({
        code: "custom",
        path: ["cells", index, "id"],
        message: `duplicate cell id: ${cell.id}`,
      });
    }
    ids.add(cell.id);
    if (cell.type === "markdown" && !markdownLinesValid(cell.body)) {
      context.addIssue({
        code: "custom",
        path: ["cells", index, "body"],
        message: `markdown cell lines must be blank or R comments: ${cell.id}`,
      });
    }
  }
  if (notebookSourceByteLength(notebook.cells) > MAX_NOTEBOOK_SOURCE_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["cells"],
      message: `notebook source exceeds ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
    });
  }
});

export interface NotebookInput {
  path?: string | null;
  metadata?: Record<string, unknown>;
  cells: Array<{
    id: string;
    type: CellType;
    body: string[];
    options?: Record<string, unknown>;
    revision?: number;
  }>;
}

export const cellEditSchema = z.object({
  cellId: idSchema,
  body: sourceLinesSchema,
  cellType: cellTypeSchema,
  expectedRevision: revisionSchema,
}).strict().superRefine((edit, context) => {
  if (edit.cellType === "markdown" && !markdownLinesValid(edit.body)) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: `markdown cell lines must be blank or R comments: ${edit.cellId}`,
    });
  }
});

export type CellEdit = z.infer<typeof cellEditSchema>;

export const cellCreationSchema = z.object({
  clientOperationId: idSchema,
  after: idSchema.nullable().optional().default(null),
  body: sourceLinesSchema.optional().default([]),
  cellType: cellTypeSchema.optional().default("code"),
  options: cellOptionsSchema.optional().default({}),
}).strict().superRefine((creation, context) => {
  if (creation.cellType === "markdown" && !markdownLinesValid(creation.body)) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: "markdown cell lines must be blank or R comments: <new cell>",
    });
  }
});

export type CellCreation = z.infer<typeof cellCreationSchema>;

const commandBase = {
  operationId: idSchema,
  clientId: idSchema.optional(),
  sessionEpoch: idSchema,
};

const editCommandSchema = z.object({
  ...commandBase,
  type: z.literal("edit"),
  edits: z.array(cellEditSchema).min(1).max(MAX_NOTEBOOK_CELLS),
}).strict().superRefine((command, context) => {
  if (notebookSourceByteLength(command.edits) > MAX_NOTEBOOK_SOURCE_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["edits"],
      message: `source changes exceed ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
    });
  }
});

const createCommandSchema = z.object({
  ...commandBase,
  type: z.literal("create"),
  creations: z.array(cellCreationSchema).min(1).max(MAX_NOTEBOOK_CELLS),
}).strict().superRefine((command, context) => {
  if (notebookSourceByteLength(command.creations) > MAX_NOTEBOOK_SOURCE_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["creations"],
      message: `source changes exceed ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
    });
  }
});

const deleteCommandSchema = z.object({
  ...commandBase,
  type: z.literal("delete"),
  cellId: idSchema,
  expectedRevision: revisionSchema,
}).strict();

const moveCommandSchema = z.object({
  ...commandBase,
  type: z.literal("move"),
  cellId: idSchema,
  after: idSchema.nullable(),
}).strict();

const disableCommandSchema = z.object({
  ...commandBase,
  type: z.literal("disable"),
  cellId: idSchema,
  disabled: z.boolean(),
  expectedRevision: revisionSchema.optional(),
}).strict();

const runCommandSchema = z.object({
  ...commandBase,
  type: z.literal("run"),
  scope: z.enum(["cell", "all", "stale"]).default("cell"),
  cellId: idSchema.optional(),
  targetCreationId: idSchema.optional(),
  edits: z.array(cellEditSchema).max(MAX_NOTEBOOK_CELLS).optional().default([]),
  creations: z.array(cellCreationSchema).max(MAX_NOTEBOOK_CELLS).optional().default([]),
  source: z.enum(["editor", "app", "mcp", "cli"]).optional().default("editor"),
}).strict().superRefine((command, context) => {
  const targetCount = Number(command.cellId !== undefined)
    + Number(command.targetCreationId !== undefined);
  if (command.scope === "cell" && targetCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["cellId"],
      message: "exactly one of cellId or targetCreationId is required for a cell run",
    });
  }
  if (command.scope !== "cell" && targetCount !== 0) {
    context.addIssue({
      code: "custom",
      path: ["cellId"],
      message: "cellId and targetCreationId are only valid for a cell run",
    });
  }
  if (notebookSourceByteLength([...command.edits, ...command.creations])
    > MAX_NOTEBOOK_SOURCE_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["edits"],
      message: `source changes exceed ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
    });
  }
});

const interruptCommandSchema = z.object({
  ...commandBase,
  type: z.literal("interrupt"),
}).strict();

const restartCommandSchema = z.object({
  ...commandBase,
  type: z.literal("restart"),
  replay: z.boolean().optional().default(true),
}).strict();

const widgetCommandSchema = z.object({
  ...commandBase,
  type: z.literal("widget"),
  name: idSchema,
  path: z.array(idSchema).optional().default([]),
  update: recordSchema,
  source: z.enum(["editor", "app", "mcp", "cli"]).optional().default("editor"),
}).strict();

const inspectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("inspect"),
  name: idSchema,
}).strict();

const lazyOutputCommandSchema = z.object({
  ...commandBase,
  type: z.literal("lazy-output"),
  key: idSchema,
}).strict();

const tablePageCommandSchema = z.object({
  ...commandBase,
  type: z.literal("table-page"),
  handle: idSchema,
  offset: revisionSchema.optional().default(0),
  limit: z.number().int().min(1).max(1_000).safe().optional().default(25),
  sortBy: z.string().optional().default(""),
  sortDescending: z.boolean().optional().default(false),
  filter: z.string().optional().default(""),
}).strict();

const saveCommandSchema = z.object({
  ...commandBase,
  type: z.literal("save"),
}).strict();

const formatCommandSchema = z.object({
  ...commandBase,
  type: z.literal("format"),
  cellIds: z.array(idSchema).optional(),
  expectedRevisions: safeStringRecordSchema(revisionSchema),
}).strict();

const runtimeCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set-runtime"),
  executionMode: z.enum(["automatic", "lazy"]).optional(),
  runOnStartup: z.boolean().optional(),
}).strict().refine(
  (value) => value.executionMode !== undefined || value.runOnStartup !== undefined,
  { message: "provide executionMode or runOnStartup" },
);

const configCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set-config"),
  patch: recordSchema,
}).strict();

const layoutCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set-layout"),
  layout: z.unknown(),
}).strict();

const serviceCommandSchema = z.object({
  ...commandBase,
  type: z.literal("service"),
  command: z.enum([
    "export",
    "publish",
    "check",
    "packages",
    "packages.status",
    "packages.declare",
    "packages.install",
    "rename-cell",
    "set-app",
    "source",
    "upload",
  ]),
  payload: recordSchema.optional().default({}),
}).strict();

export const hostCommandSchema = z.discriminatedUnion("type", [
  editCommandSchema,
  createCommandSchema,
  deleteCommandSchema,
  moveCommandSchema,
  disableCommandSchema,
  runCommandSchema,
  interruptCommandSchema,
  restartCommandSchema,
  widgetCommandSchema,
  inspectCommandSchema,
  lazyOutputCommandSchema,
  tablePageCommandSchema,
  saveCommandSchema,
  formatCommandSchema,
  runtimeCommandSchema,
  configCommandSchema,
  layoutCommandSchema,
  serviceCommandSchema,
]);

export type HostCommand = z.infer<typeof hostCommandSchema>;

export type CellStatus =
  | "idle"
  | "stale"
  | "running"
  | "done"
  | "error"
  | "stopped"
  | "disabled";

export interface HostError {
  code: string;
  message: string;
  operationId?: string | null;
  details?: unknown;
}

export type OperationStatus =
  | "accepted"
  | "running"
  | "cancellation-requested"
  | "done"
  | "error"
  | "cancelled";

export interface OperationRecord {
  id: string;
  kind: HostCommand["type"] | "run" | "widget-reset" | "analysis";
  status: OperationStatus;
  acceptedAt: number;
  settledAt?: number;
  runId?: string;
  cellIds?: string[];
  token?: number;
  executionDone?: boolean;
  resetOperationIds?: string[];
  error?: HostError | null;
  result?: unknown;
}

export interface HostCellState {
  id: string;
  type: CellType;
  body: string[];
  options: Record<string, unknown>;
  revision: number;
  status: CellStatus;
  outputs: unknown[];
  outputsStale?: boolean;
  progress: unknown | null;
  log: string[];
  error: EngineResponse["error"] | null;
  defs: string[];
  refs: string[];
  selfRefs: string[];
  locals: string[];
  barrier: boolean;
  opaque: boolean;
  diagnostics: AnalysisDiagnostic[];
  analysisPending: boolean;
}

export interface DependencyGraphState {
  nodes: string[];
  edges: Record<string, string[]>;
  reverseEdges: Record<string, string[]>;
  duplicates: Record<string, string[]>;
  cycles: string[];
  topologicalOrder: string[] | null;
}

export interface RuntimeVariable {
  name: string;
  owner: string | null;
  revision: number | null;
  class: string;
  dim: number[] | null;
  size: number;
  widget: boolean;
  valueSummary?: string;
}

export interface HostSnapshot {
  protocol: typeof HOST_PROTOCOL;
  epoch: string;
  cursor: number;
  version: number;
  path: string | null;
  metadata: Record<string, unknown>;
  config: Record<string, unknown>;
  layout: unknown;
  changed: boolean;
  runtime: {
    executionMode: "automatic" | "lazy";
    runOnStartup: boolean;
    executionReady: boolean;
    analyzerAvailable: boolean;
    kernelAvailable: boolean;
    packageOperationActive: boolean;
    busy: boolean;
    activeRunId: string | null;
  };
  cells: HostCellState[];
  graph: DependencyGraphState;
  variables: RuntimeVariable[];
  editorDiagnostics: Record<string, AnalysisDiagnostic[]>;
  serviceErrors: { lsp?: HostError };
  operations: OperationRecord[];
  lastValue: unknown | null;
  lastActionError: HostError | null;
}

export type HostEventType =
  | "receipt"
  | "notebook"
  | "cell"
  | "cell-started"
  | "cell-output"
  | "cell-completed"
  | "diagnostics"
  | "editor-diagnostics"
  | "service-errors"
  | "graph"
  | "variables"
  | "runtime"
  | "operation"
  | "service-error";

export interface HostEvent {
  protocol: typeof HOST_PROTOCOL;
  epoch: string;
  cursor: number;
  version: number;
  timestamp: number;
  type: HostEventType;
  operationId?: string;
  cellId?: string;
  runId?: string;
  revision?: number;
  sequence?: number;
  payload: unknown;
}

export type Recovery =
  | {
      kind: "replay";
      epoch: string;
      cursor: number;
      events: HostEvent[];
    }
  | {
      kind: "snapshot";
      epoch: string;
      cursor: number;
      snapshot: HostSnapshot;
    };

export interface CommandResult {
  operation: OperationRecord;
  version: number;
  cursor: number;
  result?: unknown;
}

const protocolIntegerSchema = z.number().int().nonnegative().safe();
const protocolStringSchema = z.string().max(MAX_FRAME_BYTES);
const protocolStringArraySchema = z.array(protocolStringSchema)
  .max(MAX_PROTOCOL_COLLECTION_ITEMS);
const protocolIdArraySchema = z.array(idSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS);
const protocolJsonSchema = z.json();
const protocolJsonRecordSchema = safeStringRecordSchema(protocolJsonSchema);

export const cellStatusSchema = z.enum([
  "idle",
  "stale",
  "running",
  "done",
  "error",
  "stopped",
  "disabled",
]);

export const hostErrorSchema = z.object({
  code: z.string().min(1).max(256),
  message: protocolStringSchema,
  operationId: idSchema.nullable().optional(),
  details: protocolJsonSchema.optional(),
}).strict();

export const operationStatusSchema = z.enum([
  "accepted",
  "running",
  "cancellation-requested",
  "done",
  "error",
  "cancelled",
]);

export const operationKindSchema = z.enum([
  "edit",
  "create",
  "delete",
  "move",
  "disable",
  "run",
  "interrupt",
  "restart",
  "widget",
  "inspect",
  "lazy-output",
  "table-page",
  "save",
  "format",
  "set-runtime",
  "set-config",
  "set-layout",
  "service",
  "widget-reset",
  "analysis",
]);

export const operationRecordSchema: z.ZodType<OperationRecord> = z.object({
  id: idSchema,
  kind: operationKindSchema,
  status: operationStatusSchema,
  acceptedAt: z.number().finite().nonnegative(),
  settledAt: z.number().finite().nonnegative().optional(),
  runId: idSchema.optional(),
  cellIds: protocolIdArraySchema.optional(),
  token: protocolIntegerSchema.optional(),
  executionDone: z.boolean().optional(),
  resetOperationIds: protocolIdArraySchema.optional(),
  error: hostErrorSchema.nullable().optional(),
  result: protocolJsonSchema.optional(),
}).strict();

export const hostCellStateSchema: z.ZodType<HostCellState> = z.object({
  id: idSchema,
  type: cellTypeSchema,
  body: sourceLinesSchema,
  options: storedCellOptionsSchema,
  revision: revisionSchema,
  status: cellStatusSchema,
  outputs: z.array(protocolJsonSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  outputsStale: z.boolean().optional(),
  progress: protocolJsonSchema.nullable(),
  // One MiB of console bytes can be one MiB of empty lines. Leave room for
  // the truncation marker and a terminal condition without capping source or
  // other protocol collections at this larger console-specific size.
  log: z.array(protocolStringSchema).max(1_048_578),
  error: engineErrorSchema.nullable(),
  defs: protocolStringArraySchema,
  refs: protocolStringArraySchema,
  selfRefs: protocolStringArraySchema,
  locals: protocolStringArraySchema,
  barrier: z.boolean(),
  opaque: z.boolean(),
  diagnostics: z.array(analysisDiagnosticSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  analysisPending: z.boolean(),
}).strict();

const graphCellIdArraySchema = z.array(idSchema).max(MAX_NOTEBOOK_CELLS);
const graphAdjacencySchema = safeStringRecordSchema(graphCellIdArraySchema)
  .superRefine((value, context) => {
  if (Object.keys(value).length > MAX_NOTEBOOK_CELLS) {
    context.addIssue({ code: "custom", message: "graph mapping has too many entries" });
  }
});
const graphDuplicatesSchema = safeStringRecordSchema(graphCellIdArraySchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_PROTOCOL_COLLECTION_ITEMS) {
      context.addIssue({ code: "custom", message: "duplicate mapping has too many entries" });
    }
  });

export const dependencyGraphStateSchema: z.ZodType<DependencyGraphState> = z.object({
  nodes: graphCellIdArraySchema,
  edges: graphAdjacencySchema,
  reverseEdges: graphAdjacencySchema,
  duplicates: graphDuplicatesSchema,
  cycles: graphCellIdArraySchema,
  topologicalOrder: graphCellIdArraySchema.nullable(),
}).strict().superRefine((graph, context) => {
  const nodes = new Set(graph.nodes);
  if (nodes.size !== graph.nodes.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "graph nodes must be unique" });
  }
  const edgeKeys = Object.keys(graph.edges);
  const reverseKeys = Object.keys(graph.reverseEdges);
  if (edgeKeys.length !== nodes.size || edgeKeys.some((id) => !nodes.has(id))) {
    context.addIssue({ code: "custom", path: ["edges"], message: "graph edges must name every node exactly once" });
  }
  if (reverseKeys.length !== nodes.size || reverseKeys.some((id) => !nodes.has(id))) {
    context.addIssue({ code: "custom", path: ["reverseEdges"], message: "graph reverse edges must name every node exactly once" });
  }
  let edgeCount = 0;
  let reverseCount = 0;
  const reverseSets = new Map<string, Set<string>>();
  for (const [dependency, dependents] of Object.entries(graph.reverseEdges)) {
    reverseCount += dependents.length;
    reverseSets.set(dependency, new Set(dependents));
    if (new Set(dependents).size !== dependents.length
      || dependents.some((dependent) => !nodes.has(dependent))) {
      context.addIssue({ code: "custom", path: ["reverseEdges", dependency], message: "graph reverse edges contain duplicate or unknown nodes" });
    }
  }
  for (const [dependent, dependencies] of Object.entries(graph.edges)) {
    edgeCount += dependencies.length;
    if (new Set(dependencies).size !== dependencies.length
      || dependencies.some((dependency) => !nodes.has(dependency))) {
      context.addIssue({ code: "custom", path: ["edges", dependent], message: "graph edges contain duplicate or unknown nodes" });
    }
    for (const dependency of dependencies) {
      if (!reverseSets.get(dependency)?.has(dependent)) {
        context.addIssue({ code: "custom", path: ["reverseEdges", dependency], message: "graph edges and reverse edges disagree" });
        break;
      }
    }
  }
  if (edgeCount > MAX_DEPENDENCY_EDGES) {
    context.addIssue({ code: "custom", path: ["edges"], message: `dependency graph exceeds ${MAX_DEPENDENCY_EDGES} edge limit` });
  }
  if (reverseCount !== edgeCount) {
    context.addIssue({ code: "custom", path: ["reverseEdges"], message: "graph edges and reverse edges have different sizes" });
  }
  for (const [symbol, definitions] of Object.entries(graph.duplicates)) {
    if (!analysisSymbolSchema.safeParse(symbol).success) {
      context.addIssue({ code: "custom", path: ["duplicates", symbol], message: "duplicate symbol is invalid" });
    }
    if (definitions.length < 2
      || new Set(definitions).size !== definitions.length
      || definitions.some((id) => !nodes.has(id))) {
      context.addIssue({ code: "custom", path: ["duplicates", symbol], message: "duplicate definitions must name at least two distinct graph nodes" });
    }
  }
  if (graph.cycles.some((id) => !nodes.has(id))) {
    context.addIssue({ code: "custom", path: ["cycles"], message: "graph cycles contain unknown nodes" });
  }
  if (graph.topologicalOrder !== null && (
    graph.topologicalOrder.length !== nodes.size
    || new Set(graph.topologicalOrder).size !== nodes.size
    || graph.topologicalOrder.some((id) => !nodes.has(id))
  )) {
    context.addIssue({ code: "custom", path: ["topologicalOrder"], message: "graph topological order must contain every node exactly once" });
  }
});

const runtimeVariableNameSchema = boundedUtf8StringSchema(1_024, true);
const runtimeVariableClassSchema = boundedUtf8StringSchema(1_024, true);
const runtimeVariableSummarySchema = boundedUtf8StringSchema(160, false);

export const runtimeVariableSchema: z.ZodType<RuntimeVariable> = z.object({
  name: runtimeVariableNameSchema,
  owner: idSchema.nullable(),
  revision: revisionSchema.nullable(),
  class: runtimeVariableClassSchema,
  dim: z.array(protocolIntegerSchema).max(64).nullable(),
  size: protocolIntegerSchema,
  widget: z.boolean(),
  valueSummary: runtimeVariableSummarySchema.optional(),
}).strict();

export const runtimeVariablesSchema = z.array(runtimeVariableSchema)
  .max(MAX_RUNTIME_VARIABLES);

export const editorDiagnosticsSchema = safeStringRecordSchema(
  z.array(analysisDiagnosticSchema).max(MAX_EDITOR_DIAGNOSTICS),
).superRefine((value, context) => {
  const count = Object.values(value).reduce(
    (total, diagnostics) => total + diagnostics.length,
    0,
  );
  if (count > MAX_EDITOR_DIAGNOSTICS) {
    context.addIssue({ code: "custom", message: "too many editor diagnostics" });
  }
});

export const serviceErrorsSchema: z.ZodType<HostSnapshot["serviceErrors"]> = z.object({
  lsp: hostErrorSchema.optional(),
}).strict();

export const hostRuntimeSchema: z.ZodType<HostSnapshot["runtime"]> = z.object({
  executionMode: z.enum(["automatic", "lazy"]),
  runOnStartup: z.boolean(),
  executionReady: z.boolean(),
  analyzerAvailable: z.boolean(),
  kernelAvailable: z.boolean(),
  packageOperationActive: z.boolean(),
  busy: z.boolean(),
  activeRunId: idSchema.nullable(),
}).strict();

export const hostSnapshotSchema: z.ZodType<HostSnapshot> = z.object({
  protocol: z.literal(HOST_PROTOCOL),
  epoch: idSchema,
  cursor: protocolIntegerSchema,
  version: protocolIntegerSchema,
  path: protocolStringSchema.nullable(),
  metadata: protocolJsonRecordSchema,
  config: protocolJsonRecordSchema,
  layout: protocolJsonSchema,
  changed: z.boolean(),
  runtime: hostRuntimeSchema,
  cells: z.array(hostCellStateSchema).max(MAX_NOTEBOOK_CELLS),
  graph: dependencyGraphStateSchema,
  variables: runtimeVariablesSchema,
  editorDiagnostics: editorDiagnosticsSchema,
  serviceErrors: serviceErrorsSchema,
  operations: z.array(operationRecordSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  lastValue: protocolJsonSchema.nullable(),
  lastActionError: hostErrorSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  const ids = new Set<string>();
  for (const [index, cell] of snapshot.cells.entries()) {
    if (ids.has(cell.id)) {
      context.addIssue({
        code: "custom",
        path: ["cells", index, "id"],
        message: `duplicate cell id: ${cell.id}`,
      });
    }
    ids.add(cell.id);
  }
  if (notebookSourceByteLength(snapshot.cells) > MAX_NOTEBOOK_SOURCE_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["cells"],
      message: `notebook source exceeds ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
    });
  }
});

const eventBase = {
  protocol: z.literal(HOST_PROTOCOL),
  epoch: idSchema,
  cursor: protocolIntegerSchema,
  version: protocolIntegerSchema,
  timestamp: z.number().finite().nonnegative(),
  operationId: idSchema.optional(),
  cellId: idSchema.optional(),
  runId: idSchema.optional(),
  revision: revisionSchema.optional(),
  sequence: protocolIntegerSchema.optional(),
};
const deletedCellSchema = z.object({ deleted: z.literal(true) }).strict();
const genericEventTypeSchema = z.enum([
  "receipt",
  "notebook",
  "cell-output",
]);

export const hostEventTypeSchema = z.enum([
  "receipt",
  "notebook",
  "cell",
  "cell-started",
  "cell-output",
  "cell-completed",
  "diagnostics",
  "editor-diagnostics",
  "service-errors",
  "graph",
  "variables",
  "runtime",
  "operation",
  "service-error",
]);

export const hostEventSchema: z.ZodType<HostEvent> = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: genericEventTypeSchema, payload: protocolJsonSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("cell"), payload: z.union([
    hostCellStateSchema,
    deletedCellSchema,
  ]) }).strict(),
  z.object({ ...eventBase, type: z.literal("cell-started"), payload: hostCellStateSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("cell-completed"), payload: z.union([
    hostCellStateSchema,
    deletedCellSchema,
  ]) }).strict(),
  z.object({ ...eventBase, type: z.literal("diagnostics"), payload: z.array(
    analysisDiagnosticSchema,
  ).max(MAX_PROTOCOL_COLLECTION_ITEMS) }).strict(),
  z.object({ ...eventBase, type: z.literal("editor-diagnostics"), payload: editorDiagnosticsSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("service-errors"), payload: serviceErrorsSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("graph"), payload: dependencyGraphStateSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("variables"), payload: runtimeVariablesSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("runtime"), payload: hostRuntimeSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("operation"), payload: operationRecordSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("service-error"), payload: hostErrorSchema.nullable() }).strict(),
]);

export const recoverySchema: z.ZodType<Recovery> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replay"),
    epoch: idSchema,
    cursor: protocolIntegerSchema,
    events: z.array(hostEventSchema).max(MAX_PROTOCOL_COLLECTION_ITEMS),
  }).strict(),
  z.object({
    kind: z.literal("snapshot"),
    epoch: idSchema,
    cursor: protocolIntegerSchema,
    snapshot: hostSnapshotSchema,
  }).strict(),
]).superRefine((recovery, context) => {
  if (recovery.kind === "snapshot") {
    if (recovery.snapshot.epoch !== recovery.epoch) {
      context.addIssue({ code: "custom", path: ["snapshot", "epoch"], message: "snapshot epoch does not match recovery" });
    }
    if (recovery.snapshot.cursor !== recovery.cursor) {
      context.addIssue({ code: "custom", path: ["snapshot", "cursor"], message: "snapshot cursor does not match recovery" });
    }
    return;
  }
  let prior = -1;
  for (const [index, event] of recovery.events.entries()) {
    if (event.epoch !== recovery.epoch) {
      context.addIssue({ code: "custom", path: ["events", index, "epoch"], message: "event epoch does not match recovery" });
    }
    if (event.cursor <= prior) {
      context.addIssue({ code: "custom", path: ["events", index, "cursor"], message: "replay cursors must increase" });
    }
    prior = event.cursor;
  }
  if (recovery.events.length > 0 && prior !== recovery.cursor) {
    context.addIssue({ code: "custom", path: ["cursor"], message: "recovery cursor does not match its last event" });
  }
});

export const commandResultSchema: z.ZodType<CommandResult> = z.object({
  operation: operationRecordSchema,
  version: protocolIntegerSchema,
  cursor: protocolIntegerSchema,
  result: protocolJsonSchema.optional(),
}).strict();

export interface ControllerServices {
  renderMarkdown?(lines: readonly string[]): unknown | Promise<unknown>;
  save?(snapshot: HostSnapshot): Promise<Record<string, unknown>>;
  format?(
    cells: readonly Pick<HostCellState, "id" | "type" | "body" | "revision">[],
  ): Promise<Record<string, string[]>>;
  service?(
    command: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
}

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** Parse one complete JSON protocol frame with Alder's transport limits. */
export function decodeJsonFrame(
  input: string | Uint8Array,
  maxBytes = MAX_FRAME_BYTES,
): unknown {
  const byteLength = typeof input === "string"
    ? new TextEncoder().encode(input).byteLength
    : input.byteLength;
  if (byteLength > maxBytes) {
    throw new ProtocolError("frame_too_large", `frame exceeds ${maxBytes} bytes`);
  }
  let source: string;
  try {
    source = typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ProtocolError("invalid_utf8", "frame is not valid UTF-8");
  }
  inspectJsonStructure(source);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ProtocolError("invalid_json", "frame is not valid JSON");
  }
}

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

function safeStringRecordSchema<T>(
  valueSchema: z.ZodType<T>,
): z.ZodType<Record<string, T>> {
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
    const parsedEntries: Array<[string, T]> = [];
    for (const [key, raw] of Object.entries(value)) {
      const parsed = valueSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: "custom",
            path: [key, ...issue.path],
            message: issue.message,
          });
        }
        continue;
      }
      parsedEntries.push([key, parsed.data]);
    }
    return Object.fromEntries(parsedEntries);
  }) as z.ZodType<Record<string, T>>;
}

function boundedUtf8StringSchema(maximumBytes: number, nonempty: boolean): z.ZodString {
  const schema = nonempty ? z.string().min(1).max(maximumBytes) : z.string().max(maximumBytes);
  return schema.superRefine((value, context) => {
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: "custom", message: "string must contain valid Unicode" });
    } else if (new TextEncoder().encode(value).byteLength > maximumBytes) {
      context.addIssue({ code: "custom", message: `string exceeds ${maximumBytes} UTF-8 bytes` });
    }
  });
}

function markdownLinesValid(lines: readonly string[]): boolean {
  return lines.every((line) => line.trim().length === 0 || /^\s*#/.test(line));
}

/** Logical UTF-8 bytes sent to analysis/evaluation, excluding notebook framing. */
export function sourceLinesByteLength(lines: readonly string[]): number {
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    bytes += new TextEncoder().encode(line).byteLength + Number(index > 0);
    if (bytes > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

export function notebookSourceByteLength(
  cells: readonly { body: readonly string[] }[],
): number {
  let bytes = 0;
  for (const cell of cells) {
    bytes += sourceLinesByteLength(cell.body);
    if (bytes > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

export function parseHostCommand(input: unknown): HostCommand {
  const result = hostCommandSchema.safeParse(input);
  if (!result.success) {
    throw new ProtocolError("invalid_request", z.prettifyError(result.error));
  }
  return result.data;
}

function inspectJsonStructure(source: string): void {
  // JSON.parse validates the grammar. This lexical pass enforces only the
  // limits JSON.parse cannot: nesting and duplicate (decoded) object keys.
  // Only a string followed by a colon can be an object key in valid JSON.
  const tokens = /"(?:[^"\\]*\\[\s\S])*[^"\\]*"(\s*:)?|[{}\[\]]|[^\s{}\[\],:"]+/g;
  const stack: Array<Set<string> | null> = [];
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source)) !== null) {
    const token = match[0];
    if (token === "}" || token === "]") {
      stack.pop();
    } else if (match[1]) {
      const quoted = token.slice(0, -match[1].length);
      let key: string;
      try {
        key = quoted.includes("\\") ? JSON.parse(quoted) as string : quoted.slice(1, -1);
      } catch {
        throw new ProtocolError("invalid_json", "invalid JSON object key");
      }
      const keys = stack[stack.length - 1];
      if (keys?.has(key)) {
        throw new ProtocolError("duplicate_key", `duplicate JSON object key: ${key}`);
      }
      keys?.add(key);
    } else {
      if (stack.length > MAX_JSON_DEPTH) {
        throw new ProtocolError("nesting_too_deep", `JSON nesting exceeds ${MAX_JSON_DEPTH}`);
      }
      if (token === "{" || token === "[") {
        stack.push(token === "{" ? new Set<string>() : null);
      }
    }
  }
}
