import { McpServer, ResourceTemplate, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema, type ServerCapabilities, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod/v4";
import {
  cellOptionsSchema,
  layoutSchema,
  mcpDocumentChangeSchema,
  setAppCommandSchema,
  setConfigCommandSchema,
  setPreferencesCommandSchema,
  textEditSchema,
  widgetUpdateSchema,
  type ArtifactHandle,
  type CommandResult,
  type HostCommand,
  type HostEvent,
  type HostQuery,
  type HostQueryResult,
  type HostSnapshot,
  type McpDocumentChange,
  type OutputScope,
} from "./protocol.js";
import { serializeNotebook, type NotebookDocument } from "./notebook.js";
import { toLogicalCellBody, toPhysicalCellBody } from "./cell-body.js";
import type { ArtifactResourceRead } from "./outputs.js";

/** MCP framing accepts up to 16 MiB; individual result envelopes are smaller. */
const MCP_MAX_PENDING_REQUESTS = 128;
const MCP_STARTUP_TIMEOUT_MS = 120_000;
export const MCP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MCP_MAX_PENDING_BYTES = MCP_MAX_MESSAGE_BYTES;
export const MCP_MAX_RESULT_BYTES = 1024 * 1024;
export const MCP_OUTPUT_CHUNK_BYTES = 256 * 1024;

export interface McpControllerAdapter {
  snapshot(clientId?: string): HostSnapshot;
  subscribe(listener: (event: HostEvent) => void): () => void;
  dispatch(command: HostCommand): Promise<CommandResult>;
  query?(query: HostQuery, callerClientId?: string): Promise<HostQueryResult> | HostQueryResult;
  notebookDocument?(): NotebookDocument;
}

export interface McpArtifactStore {
  writeArtifact(bytes: Uint8Array, mimeType: string, extension: string, scope: OutputScope): Promise<ArtifactHandle>;
  retainArtifactRead(descriptor: ArtifactHandle, expiresAt: number): void;
  openArtifactResource(descriptor: ArtifactHandle | string, relative?: string): ArtifactResourceRead;
  release(handles: readonly ArtifactHandle[]): void;
}

export interface AlderMcpOptions {
  controller: McpControllerAdapter;
  startup?: Promise<void> | (() => Promise<void>);
  /** Return the readiness promise for the current runtime generation. */
  runtimeReady?: () => Promise<void>;
  onShutdown?(): void | Promise<void>;
  artifactStore: McpArtifactStore;
  clientId: string;
  sessionEpoch: string;
  version?: string;
  capabilities?: ServerCapabilities;
  commandTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Authoritative lease-registry check after asynchronous MCP boundaries. */
  assertActive?(): void;
  artifactExpiresAt?: number;
}

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType },
  callback: ToolCallback<z.ZodType>,
) => unknown;

const id = z.string().min(1).max(256);
const path = z.string().min(1).max(32 * 1024);
const revision = z.number().int().min(0).max(2_147_483_647);
const bodyLine = z.string().refine((value) => !/[\r\n\0]/.test(value), "logical source lines cannot contain line breaks or NUL");
const logicalLines = z.array(bodyLine).max(1_000_000);
const activeClientIds = z.array(id).max(128).refine((clientIds) => new Set(clientIds).size === clientIds.length, "expectedClientIds must not contain duplicates");
const cellType = z.enum(["code", "markdown"]);
const empty = z.object({}).strict();
const requestIdentity = { requestId: id, sessionEpoch: id };
const expectedDocumentRevision = revision;
const expectedCellRevision = revision;
const queryOffset = z.number().int().min(0).max(2_147_483_647).optional();

const commonEffect = { ...requestIdentity };

const toolSchemas: Record<string, z.ZodType> = {
  notebook_state: empty,
  list_cells: z.object({ offset: queryOffset, limit: z.number().int().min(1).max(1_000).optional() }).strict(),
  read_cell: z.object({ cell: id }).strict(),
  add_cell: z.object({ ...commonEffect, expectedDocumentRevision, after: id.nullable(), body: logicalLines, type: cellType, options: cellOptionsSchema.default({}) }).strict(),
  edit_cell: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, body: logicalLines, type: cellType, expectedRevision: expectedCellRevision }).strict(),
  delete_cell: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, expectedRevision: expectedCellRevision }).strict(),
  move_cell: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, after: id.nullable() }).strict(),
  rename_cell: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, name: id.nullable(), expectedRevision: expectedCellRevision }).strict(),
  disable_cell: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, disabled: z.boolean(), expectedRevision: expectedCellRevision }).strict(),
  run_cell: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, changes: z.array(mcpDocumentChangeSchema).max(1_000).optional() }).strict(),
  run_all: z.object({ ...commonEffect, expectedDocumentRevision, changes: z.array(mcpDocumentChangeSchema).max(1_000).optional() }).strict(),
  run_stale: z.object({ ...commonEffect, expectedDocumentRevision, changes: z.array(mcpDocumentChangeSchema).max(1_000).optional() }).strict(),
  interrupt: z.object({ ...commonEffect, runId: id.optional() }).strict(),
  get_value: z.object({ ...commonEffect, name: id, kernelEpoch: id }).strict(),
  set_widget: z.object({ ...commonEffect, name: id, path: z.array(id).max(256), update: widgetUpdateSchema, kernelEpoch: id, expectedRevision: expectedCellRevision }).strict(),
  save: z.object({ ...commonEffect, expectedDocumentRevision }).strict(),
  check: empty,
  apply_transaction: z.object({ ...commonEffect, changes: z.array(mcpDocumentChangeSchema).min(1).max(1_000), expectedDocumentRevision }).strict(),
  edit_cell_ranges: z.object({ ...commonEffect, expectedDocumentRevision, cell: id, edits: z.array(textEditSchema).min(1).max(1_000), expectedRevision: expectedCellRevision }).strict(),

  select_r: z.object({ ...commonEffect, rscript: path, expectedDocumentRevision }).strict(),
  set_runtime: z.object({ ...commonEffect, on_cell_change: z.enum(["automatic", "lazy"]).optional(), on_startup: z.boolean().optional(), cache_enabled: z.boolean().optional(), expectedDocumentRevision }).strict().refine((v) => v.on_cell_change !== undefined || v.on_startup !== undefined || v.cache_enabled !== undefined, "provide a runtime setting"),
  reload_source: z.object({ ...commonEffect, expectedDocumentRevision, expectedDiskDigest: z.string().regex(/^[0-9a-f]{64}$/), expectedDiskVersion: id }).strict(),
  get_help: z.object({ contents: z.unknown() }).strict(),
  recovery_state: empty,
  shutdown: z.object({ ...commonEffect, expectedDocumentRevision, expectedClientIds: activeClientIds, confirmed: z.literal(true) }).strict(),
  restart: z.object({ ...commonEffect, replay: z.boolean().default(false), expectedDocumentRevision: expectedDocumentRevision.optional() }).strict().refine(value => !value.replay || value.expectedDocumentRevision !== undefined, "replay restart requires document revision"),
  format: z.object({ ...commonEffect, cellIds: z.array(id).max(1_000).optional(), expectedRevisions: z.record(z.string(), revision), expectedDocumentRevision }).strict(),
  save_as: z.object({ ...commonEffect, path, expectedDestination: z.literal("absent"), expectedDocumentRevision }).strict(),
  read_output: z.object({ handle: id, offset: z.number().int().min(0), limit: z.number().int().min(1).max(MCP_OUTPUT_CHUNK_BYTES) }).strict(),
  table_page: z.object({ ...commonEffect, handle: id, offset: z.number().int().min(0), limit: z.number().int().min(1).max(200), sortBy: z.string().max(256), sortDescending: z.boolean(), filter: z.string().max(32 * 1024), kernelEpoch: id }).strict(),
  materialize_output: z.object({ ...commonEffect, key: id, kernelEpoch: id }).strict(),
  get_config: empty,
  set_preferences: z.object({ ...commonEffect, patch: setPreferencesCommandSchema.shape.patch, expectedPreferencesVersion: id.nullable() }).strict(),
  set_config: z.object({ ...commonEffect, patch: setConfigCommandSchema.shape.patch, expectedSidecarVersion: id.nullable(), expectedDocumentRevision }).strict(),
  get_layout: empty,
  set_layout: z.object({ ...commonEffect, layout: layoutSchema, expectedSidecarVersion: id.nullable(), expectedDocumentRevision }).strict(),
  set_app: z.object({ ...commonEffect, patch: setAppCommandSchema.shape.patch, expectedDocumentRevision }).strict(),
  packages_status: empty,
  packages_declare: z.object({ ...commonEffect, packages: z.array(z.string().min(1).max(256)).max(1_000), expectedSidecarVersion: id.nullable(), expectedDocumentRevision }).strict(),
  packages_install: z.object({ ...commonEffect, packages: z.array(z.string().min(1).max(256)).max(1_000), expectedDocumentRevision, kernelEpoch: id.nullable() }).strict(),
  publish: z.object({ ...commonEffect, includeCode: z.boolean(), outputPath: path.optional(), expectedDocumentRevision }).strict(),
  upload_file: z.object({ ...commonEffect, name: id, path: z.array(id).max(256), files: z.array(z.object({ name: path, content_base64: z.string().max(16 * 1024 * 1024) }).strict()).max(1_000), kernelEpoch: id }).strict(),
};

const descriptions: Record<string, string> = {
  notebook_state: "Return the authoritative notebook snapshot and identity.", list_cells: "List cells in document order.", read_cell: "Read one logical cell.",
  add_cell: "Insert one code or Markdown cell.", edit_cell: "Replace one cell body.", delete_cell: "Delete one cell.", move_cell: "Move one cell.", rename_cell: "Rename one cell.", disable_cell: "Enable or disable one cell.",
  run_cell: "Run one cell and its required dependencies.", run_all: "Run all runnable cells.", run_stale: "Run stale cells.", interrupt: "Interrupt the identified active run.", get_value: "Read one current runtime value.", set_widget: "Apply one widget update.", save: "Save the current notebook.", check: "Analyze the notebook without evaluating source.",
  apply_transaction: "Apply one atomic transaction.", edit_cell_ranges: "Apply exactly one text range edit.", select_r: "Select the Rscript runtime.", set_runtime: "Set notebook execution and cache settings, saved in notebook metadata.", reload_source: "Reload source after checking disk preconditions.", get_help: "Read sanitized help content.", recovery_state: "Read durable recovery state.", shutdown: "Shutdown the host after explicit confirmation.", restart: "Restart the runtime.", format: "Format selected cells.", save_as: "Save the notebook to a new path.", read_output: "Read one bounded output page.", table_page: "Read one table page.", materialize_output: "Materialize one lazy output.", get_config: "Read current settings and versions: appearance/editor preferences belong to the application, execution/cache enablement to the notebook, and cache directory to the project.", set_preferences: "Update application appearance and editor preferences for every open notebook, using the current preferences version.", set_config: "Update the project cache directory only, using the current sidecar version and document revision.", get_layout: "Read notebook layout.", set_layout: "Update notebook layout.", set_app: "Update notebook presentation settings, saved in notebook metadata.", packages_status: "Read package status.", packages_declare: "Declare notebook packages.", packages_install: "Install notebook packages.", publish: "Publish the settled notebook.", upload_file: "Upload files for a widget.",
};

const catalogOrder = ["notebook_state", "list_cells", "read_cell", "add_cell", "edit_cell", "delete_cell", "move_cell", "rename_cell", "disable_cell", "run_cell", "run_all", "run_stale", "interrupt", "get_value", "set_widget", "save", "check", "apply_transaction", "edit_cell_ranges", "select_r", "set_runtime", "reload_source", "get_help", "recovery_state", "shutdown", "restart", "format", "save_as", "read_output", "table_page", "materialize_output", "get_config", "set_preferences", "set_config", "get_layout", "set_layout", "set_app", "packages_status", "packages_declare", "packages_install", "publish", "upload_file"] as const;
const runtimeToolNames = new Set(["run_cell", "run_all", "run_stale", "get_value", "set_widget", "restart", "packages_status", "packages_install", "check"]);
const staticResourceUris = new Set(["alder://notebook/source", "alder://notebook/dag", "alder://notebook/state"]);

function canonicalResourceUri(uri: string): boolean {
  if (Buffer.byteLength(uri, "utf8") > 1_024) return false;
  if (staticResourceUris.has(uri)) return true;
  const match = new RegExp("^(alder://(?:cell|outputs)/)([^/?#]+)(/outputs)?$").exec(uri);
  if (!match) return false;
  if (match[1] === "alder://cell/" ? match[3] !== "/outputs" : match[3] !== undefined) return false;
  try {
    const value = decodeURIComponent(match[2]!);
    return value.length >= 1 && value.length <= 256 && encodeURIComponent(value) === match[2];
  } catch { return false; }
}

const readyByServer = new WeakMap<McpServer, Promise<void>>();
const drainByServer = new WeakMap<McpServer, () => Promise<void>>();
const capturedArtifactsByOptions = new WeakMap<AlderMcpOptions, Map<string, ArtifactHandle>>();

export function createMcpServer(options: AlderMcpOptions): McpServer {
  options = { ...options };
  const startupTimeoutMs = options.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new RangeError("startupTimeoutMs must be a positive safe integer");
  }
  const server = new McpServer({ name: "alder", version: options.version ?? "0.1.0" }, { capabilities: { ...options.capabilities, resources: { ...options.capabilities?.resources, subscribe: true, listChanged: true } } });
  const sessionAbort = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let pendingBytes = 0;
  const capturedArtifacts = new Map<string, ArtifactHandle>();
  capturedArtifactsByOptions.set(options, capturedArtifacts);
  let initialized = false;
  let startupError: unknown;
  let unsubscribe: (() => void) | undefined;
  const subscribedResources = new Set<string>();
  let resolveReady!: () => void;
  let readinessGeneration = 0;
  let ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  void ready.catch(() => undefined);
  readyByServer.set(server, ready);

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  };
  const schedule = <T>(factory: () => Promise<T>, retainedBytes = 0): Promise<T> => {
    if (sessionAbort.signal.aborted) return Promise.reject(abortReason(sessionAbort.signal));
    if (pending.size >= MCP_MAX_PENDING_REQUESTS || retainedBytes > MCP_MAX_PENDING_BYTES - pendingBytes) {
      return Promise.reject(codedError("resource_exhausted", "MCP request queue is full"));
    }
    pendingBytes += retainedBytes;
    const promise = factory().finally(() => { pendingBytes -= retainedBytes; });
    return track(promise);
  };
  drainByServer.set(server, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (initialized) await ready;
    while (pending.size > 0) await Promise.allSettled([...pending]);
  });

  server.server.oninitialized = () => {
    initialized = true;
    unsubscribe = options.controller.subscribe((event) => {
      const uris = new Set(["alder://notebook/state"]);
      if (event.type === "graph" || event.type === "transaction" || event.type === "notebook") uris.add("alder://notebook/dag");
      if (event.type === "transaction" || event.type === "notebook" || event.type === "cell") uris.add("alder://notebook/source");
      if (event.cellId !== undefined) uris.add(`alder://cell/${encodeURIComponent(event.cellId!)}/outputs`);
      for (const uri of uris) if (subscribedResources.has(uri)) void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
    });
    void track((async () => {
      const startupGeneration = readinessGeneration;
      const resolveStartupReady = resolveReady;
      try {
        if (options.startup !== undefined) {
          const startup = Promise.resolve()
            .then(() => typeof options.startup === "function" ? options.startup() : options.startup)
            .catch(error => {
              if (readinessGeneration === startupGeneration) startupError = error;
            });
          const timeout = codedError("mcp_timeout", "MCP action timed out");
          try {
            await awaitWithTimeout(startup, startupTimeoutMs, timeout, [sessionAbort.signal]);
          } catch (error) {
            if (error === timeout && readinessGeneration === startupGeneration && !sessionAbort.signal.aborted) {
              startupError = timeout;
              resolveStartupReady();
              readinessGeneration++;
              ready = Promise.resolve();
              readyByServer.set(server, ready);
            }
          }
        }
      } finally {
        if (readinessGeneration === startupGeneration) resolveStartupReady();
      }
    })());
  };
  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    if (!canonicalResourceUri(params.uri)) throw codedError("invalid_request", "resource subscription URI is not canonical");
    if (!subscribedResources.has(params.uri) && subscribedResources.size >= 256) throw codedError("resource_exhausted", "resource subscription limit exceeded");
    subscribedResources.add(params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => { subscribedResources.delete(params.uri); return {}; });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    if (!sessionAbort.signal.aborted) sessionAbort.abort(codedError("request_cancelled", "MCP session closed"));
    resolveReady();
    readinessGeneration++;
    unsubscribe?.();
    unsubscribe = undefined;
    subscribedResources.clear();
    while (pending.size > 0) await Promise.allSettled([...pending]);
    options.artifactStore.release([...capturedArtifacts.values()]);
    capturedArtifacts.clear();
    capturedArtifactsByOptions.delete(options);
    await originalClose();
  };

  const markRuntimeReady = (): void => {
    resolveReady();
    readinessGeneration++;
    startupError = undefined;
    ready = Promise.resolve();
    readyByServer.set(server, ready);
  };
  const requireInitialized = async (extra?: McpRequestExtra) => {
    if (!initialized) throw codedError("invalid_request", "server not initialized");
    throwIfAborted(sessionAbort.signal);
    validateRequestExtra(options, extra);
    throwIfAborted(sessionAbort.signal);
  };
  const requireReady = async (extra?: McpRequestExtra) => {
    await requireInitialized(extra);
    const observed = options.runtimeReady === undefined
      ? ready
      : Promise.resolve().then(() => options.runtimeReady!());
    const timeout = codedError("mcp_timeout", "MCP action timed out");
    try {
      await awaitWithTimeout(observed, startupTimeoutMs, timeout, [extra?.signal, sessionAbort.signal]);
    } catch (error) {
      if (extra?.signal.aborted || sessionAbort.signal.aborted) throw abortReason(extra?.signal?.aborted ? extra.signal : sessionAbort.signal);
      if (error === timeout) throw timeout;
      throw codedError("service_unavailable", error instanceof Error ? error.message : "host startup failed");
    }
    await requireInitialized(extra);
    if (options.runtimeReady === undefined && startupError !== undefined) {
      if (startupError instanceof Error && isRecord(startupError) && typeof startupError.code === "string") {
        throw startupError as unknown as Error & { code: string };
      }
      throw codedError("service_unavailable", startupError instanceof Error ? startupError.message : "host startup failed");
    }
  };
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  for (const name of catalogOrder) {
    const schema = toolSchemas[name];
    const invoke = async (raw: Record<string, unknown>, extra: McpRequestExtra): Promise<McpToolResult> => {
      await (runtimeToolNames.has(name) ? requireReady(extra) : requireInitialized(extra));
      try {
        // The SDK validates tool arguments against inputSchema at the I/O boundary.
        const parsed = raw;
        const combined = combineSignals(extra.signal, sessionAbort.signal);
        try {
          const value = await executeTool(options, name, parsed, combined.signal, extra);
          if (name === "select_r") markRuntimeReady();
          return await envelope(options, value, false);
        } finally {
          combined.dispose();
        }
      } catch (error) {
        const value = isRecord(error) && isRecord(error.envelope) ? error.envelope : { error: errorShape(error) };
        return await envelope(options, value, true);
      }
    };
    registerTool(name, { description: descriptions[name]! + ("requestId" in (schema as z.ZodObject).shape ? " Supply a unique requestId and the current sessionEpoch. If the result is uncertain, retry only the identical request with the same ID and epoch; never start a fresh run automatically." : ""), inputSchema: schema }, ((args: Record<string, unknown>, extra: McpRequestExtra) => {
      const retainedBytes = Buffer.byteLength(JSON.stringify(args), "utf8");
      return schedule(() => invoke(args, extra), retainedBytes);
    }) as ToolCallback<z.ZodType>);
  }

  const resourceMeta = () => {
    const snapshot = options.controller.snapshot(options.clientId);
    return { alder: { epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor } };
  };
  for (const [resourceName, uri, description, mimeType, reader] of resources(options, requireInitialized)) {
    if (typeof uri === "string") {
      server.registerResource(resourceName, uri, { description, mimeType }, async (resourceUri, extra) => {
        const payload = await schedule(() => reader(resourceUri.href, undefined, extra));
        await requireInitialized(extra);
        return { contents: [{ uri: resourceUri.href, mimeType: payload.mimeType, text: payload.text, _meta: { ...resourceMeta(), ...(payload.artifact === undefined ? {} : { alderArtifactHandle: payload.artifact }) } }] };
      });
    } else {
      server.registerResource(resourceName, uri, { description, mimeType }, async (resourceUri, variables, extra) => {
        const payload = await schedule(() => reader(resourceUri.href, variables, extra));
        await requireInitialized(extra);
        return { contents: [{ uri: resourceUri.href, mimeType: payload.mimeType, text: payload.text, _meta: { ...resourceMeta(), ...(payload.artifact === undefined ? {} : { alderArtifactHandle: payload.artifact }) } }] };
      });
    }
  }
  return server;
}

async function executeTool(options: AlderMcpOptions, name: string, args: Record<string, unknown>, signal: AbortSignal, extra: McpRequestExtra): Promise<unknown> {
  const controller = options.controller;
  const query = async (input: HostQuery): Promise<HostQueryResult> => {
    options.assertActive?.();
    throwIfAborted(signal);
    const result = await queryOrSnapshot(controller, input, options.clientId, options.assertActive);
    throwIfAborted(signal);
    options.assertActive?.();
    return result as HostQueryResult;
  };
  throwIfAborted(signal);
  options.assertActive?.();
  if (name === "notebook_state") return logicalQueryResult(await query({ type: "state" }));
  if (name === "list_cells") return logicalQueryResult(await query({ type: "cells", ...(args.offset === undefined ? {} : { offset: Number(args.offset) }), ...(args.limit === undefined ? {} : { limit: Number(args.limit) }) }));
  if (name === "read_cell") return logicalQueryResult(await query({ type: "cell", cellId: String(args.cell) }));
  if (name === "get_config") return await query({ type: "config" });
  if (name === "get_layout") return await query({ type: "layout" });
  if (name === "packages_status") return await query({ type: "packages-status" });
  if (name === "recovery_state") return logicalQueryResult(await query({ type: "recovery" }));
  if (name === "read_output") {
    return await query({
      type: "output",
      handle: String(args.handle),
      offset: Number(args.offset),
      limit: Math.min(Number(args.limit), MCP_OUTPUT_CHUNK_BYTES),
    });
  }
  if (name === "get_help") return await query({ type: "help", contents: args.contents as never });
  if (name === "check") return await query({ type: "check" });

  throwIfAborted(signal);
  const command = commandFromTool(options, name, args);
  await sendProgress(extra, 0, "started");
  throwIfAborted(signal);
  options.assertActive?.();
  let completed: CommandResult;
  try {
    completed = await awaitWithTimeout(
      controller.dispatch(command),
      options.commandTimeoutMs ?? 120_000,
      codedError("command_uncertain", "The command is still pending or its response was lost."),
      [signal],
    );
  } catch (error) {
    // A timeout or disconnect says nothing about whether the backend executed.
    // Keep the original identity so an explicit retry can recover that result.
    const failure = codedError("command_uncertain", `${errorShape(error).message} Retry the identical request only with requestId ${command.requestId} and sessionEpoch ${command.sessionEpoch}.`);
    throw Object.assign(failure, { envelope: { requestId: command.requestId, epoch: command.sessionEpoch, result: null, error: errorShape(failure) } });
  }
  options.assertActive?.();
  await sendProgress(extra, 1, completed.error === null ? "done" : "failed").catch(() => undefined);
  if (completed.error !== null) throw Object.assign(codedError(completed.error.code, completed.error.message), { envelope: completed });
  if (name === "shutdown" && isRecord(completed.result) && completed.result.closing === true) {
    // Let the SDK write the completed response before closing its transport.
    setImmediate(() => { void Promise.resolve().then(() => options.onShutdown?.()).catch(() => undefined); });
  }
  return completed;
}
function commandFromTool(options: AlderMcpOptions, name: string, args: Record<string, unknown>): HostCommand {
  const base = {
    requestId: String(args.requestId),
    clientId: options.clientId,
    sessionEpoch: String(args.sessionEpoch),
  };
  const transaction = (changes: readonly McpDocumentChange[]): HostCommand => ({
    ...base,
    type: "transaction",
    expectedDocumentRevision: Number(args.expectedDocumentRevision),
    changes: projectChanges(changes),
  });
  switch (name) {
    case "add_cell": return transaction([{ type: "create", creationId: String(args.requestId), after: args.after === null ? null : { cellId: String(args.after) }, cellType: args.type as "code" | "markdown", body: args.body as string[], options: args.options as Record<string, string | boolean | number> }]);
    case "edit_cell": return transaction([{ type: "edit", cell: { cellId: String(args.cell) }, cellType: args.type as "code" | "markdown", body: args.body as string[], expectedRevision: Number(args.expectedRevision) }]);
    case "delete_cell": return transaction([{ type: "delete", cell: { cellId: String(args.cell) }, expectedRevision: Number(args.expectedRevision) }]);
    case "move_cell": return transaction([{ type: "move", cell: { cellId: String(args.cell) }, after: args.after === null ? null : { cellId: String(args.after) } }]);
    case "rename_cell": return transaction([{ type: "options", cell: { cellId: String(args.cell) }, patch: { name: args.name as string | null }, expectedRevision: Number(args.expectedRevision) }]);
    case "disable_cell": return transaction([{ type: "options", cell: { cellId: String(args.cell) }, patch: { disabled: Boolean(args.disabled) }, expectedRevision: Number(args.expectedRevision) }]);
    case "run_cell": return { ...base, type: "run", scope: "cell", target: { cellId: args.cell }, changes: projectOptionalChanges(args.changes), expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "run_all": return { ...base, type: "run", scope: "all", changes: projectOptionalChanges(args.changes), expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "run_stale": return { ...base, type: "run", scope: "stale", changes: projectOptionalChanges(args.changes), expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "interrupt": return { ...base, type: "interrupt", ...(args.runId === undefined ? {} : { runId: args.runId }) } as HostCommand;
    case "get_value": return { ...base, type: "inspect", name: args.name, kernelEpoch: args.kernelEpoch } as HostCommand;
    case "set_widget": return { ...base, type: "widget", name: args.name, path: args.path, update: args.update, source: "mcp", kernelEpoch: args.kernelEpoch, expectedRevision: args.expectedRevision } as HostCommand;
    case "save": return { ...base, type: "save", expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "apply_transaction": return transaction(args.changes as McpDocumentChange[]);
    case "edit_cell_ranges": return transaction([projectRangeEdit(args)]);
    case "select_r": return { ...base, type: "select-r", rscript: args.rscript, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "set_runtime": return { ...base, type: "set-runtime", on_cell_change: args.on_cell_change, on_startup: args.on_startup, cache_enabled: args.cache_enabled, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "reload_source": return { ...base, type: "reload-source", expectedDocumentRevision: args.expectedDocumentRevision, expectedDiskDigest: args.expectedDiskDigest, expectedDiskVersion: args.expectedDiskVersion } as HostCommand;
    case "shutdown": return { ...base, type: "shutdown", expectedDocumentRevision: args.expectedDocumentRevision, expectedClientIds: args.expectedClientIds } as HostCommand;
    case "restart": return { ...base, type: "restart", replay: args.replay, ...(args.expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision: args.expectedDocumentRevision }) } as HostCommand;
    case "format": return { ...base, type: "format", cellIds: args.cellIds, expectedRevisions: args.expectedRevisions, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "save_as": return { ...base, type: "save-as", path: args.path, expectedDestination: args.expectedDestination, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "table_page": return { ...base, type: "table-page", handle: args.handle, offset: args.offset, limit: args.limit, sortBy: args.sortBy, sortDescending: args.sortDescending, filter: args.filter, kernelEpoch: args.kernelEpoch } as HostCommand;
    case "materialize_output": return { ...base, type: "lazy-output", key: args.key, kernelEpoch: args.kernelEpoch } as HostCommand;
    case "set_preferences": return { ...base, type: "set-preferences", patch: args.patch, expectedPreferencesVersion: args.expectedPreferencesVersion } as HostCommand;
    case "set_config": return { ...base, type: "set-config", patch: args.patch, expectedSidecarVersion: args.expectedSidecarVersion, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "set_layout": return { ...base, type: "set-layout", layout: args.layout, expectedSidecarVersion: args.expectedSidecarVersion, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "set_app": return { ...base, type: "set-app", patch: args.patch, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "packages_declare": return { ...base, type: "packages-declare", packages: args.packages, expectedSidecarVersion: args.expectedSidecarVersion, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "packages_install": return { ...base, type: "packages-install", packages: args.packages, expectedDocumentRevision: args.expectedDocumentRevision, kernelEpoch: args.kernelEpoch } as HostCommand;
    case "publish": return { ...base, type: "publish", includeCode: args.includeCode, outputPath: args.outputPath, expectedDocumentRevision: args.expectedDocumentRevision } as HostCommand;
    case "upload_file": return { ...base, type: "upload", name: args.name, path: args.path, files: args.files, kernelEpoch: args.kernelEpoch } as HostCommand;
    default: throw codedError("invalid_request", `unknown tool: ${name}`);
  }
}

function projectOptionalChanges(value: unknown): ReturnType<typeof projectChanges> | undefined {
  return value === undefined ? undefined : projectChanges(value as McpDocumentChange[]);
}

function projectChanges(changes: readonly McpDocumentChange[]) {
  return changes.map((change) => {
    if (change.type === "create" || change.type === "edit") return { ...change, body: toPhysicalCellBody(change.cellType, change.body) };
    return change;
  });
}

function projectRangeEdit(args: Record<string, unknown>) {
  return { type: "text-edit" as const, cell: { cellId: String(args.cell) }, expectedRevision: Number(args.expectedRevision), edits: args.edits as Array<z.infer<typeof textEditSchema>> };
}

async function queryOrSnapshot(controller: McpControllerAdapter, query: HostQuery, clientId: string, assertActive?: () => void): Promise<unknown> {
  if (controller.query === undefined) throw codedError("service_unavailable", "typed host queries are unavailable");
  assertActive?.();
  const result = await controller.query(query, clientId);
  assertActive?.();
  return result;
}

async function envelope(options: AlderMcpOptions, value: unknown, isError: boolean): Promise<McpToolResult> {
  options.assertActive?.();
  const snapshot = options.controller.snapshot();
  const structured = normalizeEnvelope(value, snapshot);
  const bytes = new TextEncoder().encode(JSON.stringify(structured));
  if (bytes.byteLength <= MCP_MAX_RESULT_BYTES) {
    const summary = isError && isRecord(structured.error)
      ? String(structured.error.code ?? "error") + ": " + String(structured.error.message ?? "request failed")
      : "OK";
    options.assertActive?.();
    return { structuredContent: structured, content: [{ type: "text", text: summary }], isError };
  }
  const artifact = await captureArtifact(options, bytes, "application/json", ".json", snapshot);
  options.assertActive?.();
  const bounded = { epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor, result: { artifact } };
  return { structuredContent: bounded, content: [{ type: "text", text: "Result captured as " + artifact.handle }], isError };
}

function normalizeEnvelope(value: unknown, snapshot: HostSnapshot): Record<string, unknown> {
  const base = { epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor };
  if (isRecord(value) && "epoch" in value && "documentRevision" in value && "cursor" in value) return value;
  if (isRecord(value) && ("error" in value || "result" in value)) return { ...base, ...value };
  return { ...base, result: value };
}

async function captureArtifact(options: AlderMcpOptions, bytes: Uint8Array, mimeType: string, extension: string, snapshot = options.controller.snapshot()): Promise<ArtifactHandle> {
  options.assertActive?.();
  const artifact = await options.artifactStore.writeArtifact(bytes, mimeType, extension, {
    sessionEpoch: snapshot.epoch,
    documentRevision: snapshot.documentRevision,
    kernelEpoch: snapshot.runtime.kernelEpoch,
    runId: null,
    cellId: null,
    revision: null,
  });
  try {
    options.assertActive?.();
    options.artifactStore.retainArtifactRead(artifact, options.artifactExpiresAt ?? Date.now() + 5 * 60_000);
    options.assertActive?.();
    capturedArtifactsByOptions.get(options)?.set(artifact.handle, artifact);
    return artifact;
  } catch (error) {
    options.artifactStore.release([artifact]);
    throw error;
  }
}

function errorShape(error: unknown): { code: string; message: string } {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "internal_error";
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function codedError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function abortReason(signal: AbortSignal): Error & { code: string } {
  const reason = signal.reason;
  if (reason instanceof Error && isRecord(reason) && typeof reason.code === "string") return reason as unknown as Error & { code: string };
  return codedError("request_cancelled", "MCP request was cancelled");
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}
async function awaitWithAbort<T>(promise: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  const watched = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  for (const signal of watched) throwIfAborted(signal);
  if (watched.length === 0) return promise;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      callback();
    };
    for (const signal of watched) {
      const onAbort = (): void => settle(() => reject(abortReason(signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
    void promise.then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
  });
}
async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
    timer.unref?.();
  });
  try {
    return await awaitWithAbort(Promise.race([promise, timeout]), signals);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateRequestExtra(options: AlderMcpOptions, extra?: McpRequestExtra): void {
  if (extra?.signal.aborted) throw codedError("request_cancelled", "MCP request was cancelled");
  if (extra?.authInfo?.clientId !== undefined && extra.authInfo.clientId !== options.clientId) throw codedError("forbidden", "MCP request client identity does not match its session");
  options.assertActive?.();
}

function combineSignals(...signals: AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = (signal: AbortSignal) => { if (!controller.signal.aborted) controller.abort(signal.reason); };
  const dispose = () => {
    for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener);
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (signal.aborted) abort(signal);
    else {
      const listener = () => abort(signal);
      listeners.push({ signal, listener });
      signal.addEventListener("abort", listener, { once: true });
    }
  }
  if (controller.signal.aborted) dispose();
  return { signal: controller.signal, dispose };
}

async function sendProgress(extra: McpRequestExtra, progress: number, message: string): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, total: 1, message } });
}

function logicalCell(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.body) || (value.type !== "code" && value.type !== "markdown")) return value;
  return { ...value, body: toLogicalCellBody(value.type, value.body.filter((line): line is string => typeof line === "string")) };
}

function logicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(logicalValue);
  if (!isRecord(value)) return value;
  const cell = logicalCell(value);
  if (cell !== value) return cell;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = logicalValue(child);
    mapped[key] = next;
    changed ||= next !== child;
  }
  return changed ? mapped : value;
}

function logicalSnapshot(snapshot: HostSnapshot): HostSnapshot {
  return { ...snapshot, cells: snapshot.cells.map((cell) => logicalCell(cell) as HostSnapshot["cells"][number]) };
}

function logicalQueryResult(value: unknown): unknown {
  if (isRecord(value) && "result" in value) return { ...value, result: logicalValue(value.result) };
  return logicalValue(value);
}

async function readArtifactPage(store: McpArtifactStore, handle: string, offset: number, limit: number, assertActive?: () => void): Promise<Record<string, unknown>> {
  assertActive?.();
  const resource = store.openArtifactResource(handle);
  try {
    const descriptor = resource.descriptor;
    const pageLimit = Math.min(limit, MCP_OUTPUT_CHUNK_BYTES);
    const readLimit = Math.min(MCP_OUTPUT_CHUNK_BYTES, Math.max(7, pageLimit + 6));
    const essence = descriptor.mimeType.split(";", 1)[0]!.trim().toLowerCase();
    const textual = essence.startsWith("text/") || essence === "application/json" || essence.endsWith("+json") || essence === "application/javascript" || essence === "application/xml";
    const bytes = await resource.read(offset, readLimit);
    assertActive?.();
    const binaryPage = () => {
      const page = bytes.subarray(0, pageLimit);
      return { encoding: "base64", offset, nextOffset: offset + page.byteLength, eof: offset + page.byteLength >= descriptor.byteLength, data: Buffer.from(page).toString("base64") };
    };
    if (!textual) return binaryPage();
    if (bytes.byteLength === 0) {
      if (offset < descriptor.byteLength) throw codedError("output_expired", "artifact reader returned no bytes before end of artifact");
      return { encoding: "utf8", offset, nextOffset: offset, eof: true, data: "" };
    }
    if ((bytes[0]! & 0xc0) === 0x80) return binaryPage();
    const start = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let end = Math.min(bytes.length, start + pageLimit);
    let data: string | undefined;
    while (end > start) {
      try {
        data = decoder.decode(bytes.subarray(start, end));
        break;
      } catch {
        end--;
      }
    }
    if (data === undefined) {
      for (let candidate = Math.max(start + pageLimit, start + 1); candidate <= bytes.length; candidate++) {
        try {
          data = decoder.decode(bytes.subarray(start, candidate));
          end = candidate;
          break;
        } catch {
          // Extend a tiny requested page until its first complete code point fits.
        }
      }
    }
    if (data === undefined) return binaryPage();
    const nextOffset = offset + end;
    if (nextOffset <= offset && nextOffset < descriptor.byteLength) throw codedError("output_expired", "artifact reader did not advance");
    return { encoding: "utf8", offset: offset + start, nextOffset, eof: nextOffset >= descriptor.byteLength, data };
  } finally { resource.close(); }
}
type ResourcePayload = { text: string; mimeType: string; artifact?: ArtifactHandle };
type ResourceVariables = Record<string, string | string[]>;
type ResourceReader = (uri: string, variables: ResourceVariables | undefined, extra: McpRequestExtra) => Promise<ResourcePayload>;

function resources(options: AlderMcpOptions, requireInitialized: (extra?: McpRequestExtra) => Promise<void>): Array<[string, string | ResourceTemplate, string, string, ResourceReader]> {
  const read: ResourceReader = async (uri, variables, extra) => {
    await requireInitialized(extra);
    const controller = options.controller;
    if (uri === "alder://notebook/source") {
      const document = controller.notebookDocument?.();
      if (document === undefined) throw codedError("source_unavailable", "authoritative notebook source is unavailable");
      return boundedResource(options, serializeNotebook(document), "text/plain", ".R");
    }
    if (uri === "alder://notebook/dag") return boundedJsonResource(options, await queryOrSnapshot(controller, { type: "graph" }, options.clientId, options.assertActive));
    if (uri === "alder://notebook/state") return boundedJsonResource(options, logicalSnapshot(controller.snapshot(options.clientId)));
    if (variables?.cell !== undefined) {
      const raw = variables.cell; const cellId = decodeURIComponent(Array.isArray(raw) ? raw[0]! : raw);
      const cell = controller.snapshot(options.clientId).cells.find((candidate) => candidate.id === cellId);
      if (!cell) throw codedError("not_found", `no such cell: ${cellId}`);
      return boundedJsonResource(options, cell.outputs);
    }
    if (variables?.output !== undefined) {
      const raw = variables.output; const handle = decodeURIComponent(Array.isArray(raw) ? raw[0]! : raw);
      return boundedJsonResource(options, await readArtifactPage(options.artifactStore, handle, 0, MCP_OUTPUT_CHUNK_BYTES, options.assertActive));
    }
    throw codedError("not_found", `unknown MCP resource: ${uri}`);
  };
  const cellTemplate = new ResourceTemplate("alder://cell/{cell}/outputs", { list: async () => ({ resources: options.controller.snapshot(options.clientId).cells.map((cell) => ({ uri: `alder://cell/${encodeURIComponent(cell.id)}/outputs`, name: `Outputs ${cell.id}`, mimeType: "application/json" })) }) });
  const outTemplate = new ResourceTemplate("alder://outputs/{output}", { list: undefined });
  return [
    ["Notebook source", "alder://notebook/source", "Exact executable notebook source", "text/plain", read],
    ["Notebook DAG", "alder://notebook/dag", "Notebook dependency graph", "application/json", read],
    ["Notebook state", "alder://notebook/state", "Authoritative notebook state", "application/json", read],
    ["Cell outputs", cellTemplate, "Rendered outputs for one cell", "application/json", read],
    ["Output", outTemplate, "Captured output", "application/json", read],
  ];
}

async function boundedJsonResource(options: AlderMcpOptions, value: unknown): Promise<ResourcePayload> {
  return boundedResource(options, new TextEncoder().encode(JSON.stringify(value)), "application/json", ".json");
}

async function boundedResource(options: AlderMcpOptions, bytes: Uint8Array, mimeType: string, extension: string): Promise<ResourcePayload> {
  options.assertActive?.();
  if (bytes.byteLength <= MCP_MAX_RESULT_BYTES) {
    options.assertActive?.();
    return { text: new TextDecoder().decode(bytes), mimeType };
  }
  const artifact = await captureArtifact(options, bytes, mimeType, extension);
  options.assertActive?.();
  return { text: JSON.stringify({ artifact }), mimeType: "application/vnd.alder.artifact-handle+json", artifact };
}
