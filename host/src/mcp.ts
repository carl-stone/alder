import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  InitializedNotificationSchema,
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  McpError,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Transform, type Readable, type TransformCallback, type Writable } from "node:stream";
import { z } from "zod/v4";
import {
  decodeJsonFrame,
  parseHostCommand,
  ProtocolError,
  type CommandResult,
  type HostCommand,
  type HostSnapshot,
  type OperationRecord,
} from "./protocol.js";

export const MCP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface McpControllerAdapter {
  snapshot(): HostSnapshot;
  dispatch(command: HostCommand): Promise<CommandResult>;
  awaitOperation(id: string, signal?: AbortSignal): Promise<OperationRecord>;
  activateStartup?(): Promise<OperationRecord | null>;
}

export interface AlderMcpOptions {
  controller: McpControllerAdapter;
  version?: string;
  operationTimeoutMs?: number;
  onInitialized?: () => void | Promise<void>;
}

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType },
  callback: (args: Record<string, unknown>) => Promise<McpToolResult>,
) => unknown;

const cellId = z.string().min(1).max(256);
const sourceLines = z.array(z.string().refine((line) => !/[\r\n\0]/.test(line), "source lines cannot contain line breaks or NUL"));
const cellKind = z.enum(["code", "markdown"]);
const revision = z.number().int().min(0).max(2_147_483_647);
const empty = z.object({}).strict();
const drains = new WeakMap<McpServer, () => Promise<void>>();
const transportDrains = new WeakMap<McpServer, () => Promise<void>>();

const TOOL_DEFINITIONS = [
  ["notebook_state", "Return the complete notebook state snapshot.", empty],
  ["list_cells", "List cells in document order.", empty],
  ["read_cell", "Read one cell's source and metadata.", z.object({ cell: cellId }).strict()],
  ["add_cell", "Insert a new code or markdown cell.", z.object({ after: cellId.nullable().optional(), body: sourceLines, type: cellKind }).strict()],
  ["edit_cell", "Replace one cell's source without executing it.", z.object({ cell: cellId, body: sourceLines, type: cellKind, expected_revision: revision.optional() }).strict()],
  ["delete_cell", "Delete a cell.", z.object({ cell: cellId, expected_revision: revision.optional() }).strict()],
  ["move_cell", "Move a cell after another cell.", z.object({ cell: cellId, after: cellId.nullable().optional() }).strict()],
  ["rename_cell", "Set or clear a cell's stable display name.", z.object({ cell: cellId, name: cellId.nullable() }).strict()],
  ["disable_cell", "Enable or disable a cell and its descendants.", z.object({ cell: cellId, disabled: z.boolean() }).strict()],
  ["run_cell", "Run one cell and its required reactive dependencies, waiting for exact settlement.", z.object({ cell: cellId }).strict()],
  ["run_all", "Run all runnable cells and wait for exact settlement.", empty],
  ["run_stale", "Run stale cells and required ancestors and wait for exact settlement.", empty],
  ["interrupt", "Interrupt the active run and wait until its operation settles.", empty],
  ["get_value", "Render and return a current top-level notebook value.", z.object({ name: cellId }).strict()],
  ["set_widget", "Apply one widget update and wait for its reactive effects and causal reset.", z.object({
    name: cellId,
    path: z.array(cellId).optional(),
    value: z.unknown().optional(),
    index: z.number().int().optional(),
    indices: z.array(z.number().int()).optional(),
    selected: z.array(z.number().int()).optional(),
    ops: z.array(z.unknown()).optional(),
    submit: z.boolean().optional(),
    paused: z.boolean().optional(),
    source: z.enum(["editor", "app"]).optional(),
  }).strict()],
  ["save", "Atomically save the notebook to its path.", empty],
  ["export", "Export the notebook in a supported static format.", z.object({
    format: z.enum(["html", "md", "script", "ipynb", "qmd", "session"]),
    include_code: z.boolean().optional(),
  }).strict()],
  ["check", "Analyze the notebook and return diagnostics.", empty],
] as const;

export function createMcpServer(options: AlderMcpOptions): McpServer {
  const server = new McpServer({ name: "alder", version: options.version ?? "0.1.0" });
  let resolveInitialized!: () => void;
  let rejectInitialized!: (error: unknown) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveInitialized = resolve;
    rejectInitialized = reject;
  });
  void readiness.catch(() => undefined);
  let initialized = false;
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const ordered = <T>(action: () => Promise<T>): Promise<T> => {
    if (queued >= 1_000) return Promise.reject(new McpError(ErrorCode.InvalidRequest, "too many pending MCP actions"));
    queued++;
    const result = queue.then(action).finally(() => { queued--; });
    queue = result.catch(() => undefined);
    return result;
  };
  drains.set(server, async () => {
    // Let the SDK's schema-validation microtasks enter the ordered action queue.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (initialized) await readiness;
    for (;;) {
      const pending = queue;
      await pending;
      if (pending === queue) return;
    }
  });
  server.server.oninitialized = () => {
    initialized = true;
    void Promise.resolve()
      .then(() => options.onInitialized?.())
      .then(() => options.controller.activateStartup?.())
      .then(async operation => {
        if (operation) await waitForOperation(options.controller, operation.id, options.operationTimeoutMs ?? 120_000);
      })
      .then(resolveInitialized, rejectInitialized);
  };
  const requireReady = async (): Promise<void> => {
    if (!initialized) throw new McpError(ErrorCode.InvalidRequest, "server not initialized");
    await readiness;
  };
  // Each tuple member has a different inferred Zod input. At runtime the SDK
  // validates it before this common dispatcher receives the parsed object.
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  for (const [name, description, schema] of TOOL_DEFINITIONS) {
    const invoke = async (args: Record<string, unknown>) => {
      if (!initialized) throw new McpError(ErrorCode.InvalidRequest, "server not initialized");
      try {
        await readiness;
      } catch (error) {
        return content({ ok: false, error: {
          code: "startup_failed",
          message: `notebook startup failed: ${error instanceof Error ? error.message : String(error)}`,
        } }, true);
      }
      return invokeMcpTool(
        options.controller,
        name,
        args as Record<string, unknown>,
        options.operationTimeoutMs,
      );
    };
    registerTool(name, { description, inputSchema: schema }, args =>
      name === "interrupt" ? invoke(args) : ordered(() => invoke(args)));
  }
  // Alder's existing stdio contract permits effectful tool notifications and
  // pipelined requests. Serialize their effects and exact settlement together.
  server.server.setNotificationHandler(z.object({
    method: z.literal("tools/call"), params: z.object({
      name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(),
    }),
  }), notification => ordered(async () => {
    if (!initialized) return;
    const definition = TOOL_DEFINITIONS.find(([name]) => name === notification.params.name);
    if (!definition) return;
    const args = definition[2].safeParse(notification.params.arguments ?? {});
    if (!args.success) return;
    await readiness;
    await invokeMcpTool(options.controller, definition[0], args.data, options.operationTimeoutMs);
  }));
  server.server.setRequestHandler(z.object({ method: z.literal("shutdown"),
    params: empty.optional() }), () => ordered(async () => {
    await requireReady();
    // The SDK writes the response in this turn before the transport closes.
    setImmediate(() => { void server.close(); });
    return {};
  }));
  server.server.setNotificationHandler(z.object({ method: z.literal("shutdown"),
    params: empty.optional() }), () => ordered(async () => {
    await requireReady();
    setImmediate(() => { void server.close(); });
  }));

  server.registerResource(
    "Notebook source",
    "alder://notebook/source",
    { description: "Serialized Alder notebook source", mimeType: "text/plain" },
    (uri) => ordered(async () => {
      await requireReady();
      const snapshot = options.controller.snapshot();
      const result = await options.controller.dispatch(parseHostCommand({
        type: "service",
        command: "source",
        payload: {},
        operationId: randomUUID(),
        clientId: "mcp",
        sessionEpoch: snapshot.epoch,
      }));
      if (!isRecord(result.result) || typeof result.result.text !== "string") {
        throw new Error("source service returned an invalid document");
      }
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: result.result.text }] };
    }),
  );
  server.registerResource(
    "Notebook DAG",
    "alder://notebook/dag",
    { description: "Notebook dependency graph", mimeType: "application/json" },
    (uri) => ordered(async () => {
      await requireReady();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(options.controller.snapshot().graph) }] };
    }),
  );
  server.registerResource(
    "Cell outputs",
    new ResourceTemplate("alder://cell/{cell}/outputs", {
      list: () => ordered(async () => ({
        resources: (await requireReady(), options.controller.snapshot()).cells.map((cell) => ({
          uri: `alder://cell/${encodeURIComponent(cell.id)}/outputs`,
          name: `Outputs ${cell.id}`,
          description: "Rendered cell outputs",
          mimeType: "application/json",
        })),
      })),
    }),
    { description: "Rendered output records for one notebook cell", mimeType: "application/json" },
    (uri, variables) => ordered(async () => {
      await requireReady();
      const encoded = typeof variables.cell === "string" ? variables.cell : "";
      let id: string;
      try { id = decodeURIComponent(encoded); } catch { id = ""; }
      const cell = options.controller.snapshot().cells.find((candidate) => candidate.id === id);
      if (!cell) throw new Error(`no such cell: ${id}`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(cell.outputs) }] };
    }),
  );
  return server;
}

export async function connectMcpStdio(
  server: McpServer,
  streams: { input?: Readable; output?: Writable } = {},
): Promise<StdioServerTransport> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const validated = new StrictMcpInput(output);
  const transport = new StdioServerTransport(
    validated,
    output,
    { maxBufferSize: MCP_MAX_MESSAGE_BYTES },
  );
  const pending: Array<Parameters<NonNullable<typeof transport.onmessage>>> = [];
  const sizes = new WeakMap<object, number>();
  let pendingBytes = 0;
  let active: string | number | null = null;
  let notifying = false;
  let closed = false;
  const waiting = new Set<() => void>();
  const resolveDrains = () => {
    if (!closed && (active !== null || notifying || pending.length)) return;
    for (const resolve of waiting) resolve();
    waiting.clear();
  };
  transportDrains.set(server, async () => {
    if (!closed && (active !== null || notifying || pending.length)) {
      await new Promise<void>(resolve => waiting.add(resolve));
    }
  });
  const close = transport.close.bind(transport);
  transport.close = async () => {
    closed = true;
    pending.length = 0;
    pendingBytes = 0;
    resolveDrains();
    input.unpipe(validated);
    input.pause();
    validated.destroy();
    await close();
  };
  await server.connect(transport);
  const receive = transport.onmessage!;
  const pump = () => {
    if (closed || active !== null || notifying) return;
    const next = pending.shift();
    if (!next) { resolveDrains(); return; }
    const [message] = next;
    pendingBytes -= sizes.get(message) ?? 0;
    if ('id' in message && message.id !== undefined) {
      active = message.id;
      receive(...next);
    } else {
      notifying = true;
      receive(...next);
      void drains.get(server)!().finally(() => {
        notifying = false;
        pump();
      }).catch(error => transport.onerror?.(error instanceof Error ? error : new Error(String(error))));
    }
  };
  const send = transport.send.bind(transport);
  transport.send = async message => {
    try { await send(message); }
    finally {
      if ('id' in message && ('result' in message || 'error' in message) && message.id === active) {
        active = null;
        pump();
      }
    }
  };
  transport.onmessage = (...args) => {
    if (closed) return;
    const [message] = args;
    // Stop must reach an outstanding evaluation instead of waiting behind it.
    if ('method' in message && message.method === 'tools/call' && message.params?.name === 'interrupt') {
      receive(...args);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (pending.length >= 1_000 || pendingBytes + bytes > MCP_MAX_MESSAGE_BYTES) {
      transport.onerror?.(new Error('too many queued MCP messages'));
      void transport.close();
      return;
    }
    sizes.set(message, bytes);
    pendingBytes += bytes;
    pending.push(args);
    pump();
  };
  input.pipe(validated);
  return transport;
}

export async function drainMcpServer(server: McpServer): Promise<void> {
  await transportDrains.get(server)?.();
  await drains.get(server)?.();
}

class StrictMcpInput extends Transform {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private oversized = false;
  private phase: "new" | "awaiting-initialized" | "ready" | "shutdown" = "new";

  constructor(private readonly output: Writable) {
    super();
  }

  _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(offset, end);
        if (!this.oversized) {
          if (this.buffered.length + part.length > MCP_MAX_MESSAGE_BYTES) {
            this.buffered = Buffer.alloc(0);
            this.oversized = true;
          } else if (part.length) {
            this.buffered = this.buffered.length ? Buffer.concat([this.buffered, part]) : part;
          }
        }
        if (newline < 0) break;
        this.finishLine();
        offset = newline + 1;
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  _flush(callback: TransformCallback): void {
    if (this.buffered.length === 0 && !this.oversized) {
      callback();
      return;
    }
    this.finishLine();
    callback();
  }

  private finishLine(): void {
    if (this.phase === "shutdown") { this.buffered = Buffer.alloc(0); return; }
    const line = this.buffered;
    this.buffered = Buffer.alloc(0);
    if (this.oversized) {
      this.oversized = false;
      this.respond(null, -32600, "invalid JSON-RPC request");
      return;
    }
    if (line.every((byte) => byte === 0x09 || byte === 0x0d || byte === 0x20)) return;
    let value: unknown;
    try {
      value = parseMcpMessage(line);
    } catch (error) {
      const parse = error instanceof ProtocolError && (error.code === "invalid_json" || error.code === "invalid_utf8");
      const id = error instanceof ProtocolError && error.code === "duplicate_key" ? recoverRequestId(line, error.message) : null;
      this.respond(id, parse ? -32700 : -32600, parse ? "parse error" : "invalid JSON-RPC request");
      return;
    }
    if (!isRecord(value) || !JSONRPCMessageSchema.safeParse({ ...value, params: undefined }).success || typeof value.method !== "string") {
      this.respond(recoverRequestId(line), -32600, "invalid JSON-RPC request");
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    const id = validRequestId(value.id) ? value.id : null;
    if (hasId && id === null) {
      this.respond(null, -32600, "invalid JSON-RPC request");
      return;
    }
    if (value.method === "ping") {
      if (!PingRequestSchema.safeParse(value).success || !emptyParams(value.params)) {
        if (hasId) this.respond(id, -32602, "ping params must be empty");
        return;
      }
      this.forward(line);
      return;
    }
    if (value.method === "initialize") {
      if (!hasId || this.phase !== "new") {
        if (hasId) this.respond(id, -32600, this.phase === "new" ? "invalid JSON-RPC request" : "server already initialized");
        return;
      }
      if (!InitializeRequestSchema.safeParse(value).success) {
        this.respond(id, -32602, "invalid initialize params");
        return;
      }
      this.phase = "awaiting-initialized";
      this.forward(line);
      return;
    }
    if (value.method === "notifications/initialized") {
      if (hasId) {
        this.respond(id, -32600, "invalid JSON-RPC request");
        return;
      }
      if (!InitializedNotificationSchema.safeParse(value).success) return;
      if (this.phase === "awaiting-initialized") {
        this.phase = "ready";
        this.forward(line);
      }
      return;
    }
    if (this.phase !== "ready") {
      if (hasId) this.respond(id, -32600, "server not initialized");
      return;
    }
    if (["tools/list", "resources/list", "resources/templates/list", "shutdown"].includes(value.method) && !emptyParams(value.params)) {
      if (hasId) this.respond(id, -32602, "method params must be empty");
      return;
    }
    if (value.method === "tools/call" && (!isRecord(value.params) ||
        !TOOL_DEFINITIONS.some(([name]) => name === (value.params as Record<string, unknown>).name) ||
        (value.params.arguments !== undefined && !isRecord(value.params.arguments)))) {
      if (hasId) this.respond(id, -32602, "invalid tools/call params");
      return;
    }
    if (value.method === "shutdown") this.phase = "shutdown";
    this.forward(line);
  }

  private forward(line: Uint8Array): void {
    this.push(line);
    this.push(Buffer.from("\n"));
  }

  private respond(id: unknown, code: number, message: string): void {
    this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }
}

export function validateMcpMessage(input: string | Uint8Array): void {
  const value = parseMcpMessage(input);
  if (!isRecord(value)) throw new Error("MCP JSON-RPC message must be an object");
}

function parseMcpMessage(input: string | Uint8Array): unknown {
  return decodeJsonFrame(input, MCP_MAX_MESSAGE_BYTES);
}

function recoverRequestId(input: Uint8Array, duplicateMessage = ""): string | number | null {
  if (/duplicate JSON object key: id$/.test(duplicateMessage)) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as unknown;
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "id")) return null;
    return validRequestId(value.id) ? value.id : null;
  } catch {
    return null;
  }
}

function validRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
}

export async function invokeMcpTool(
  controller: McpControllerAdapter,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<McpToolResult> {
  try {
    const value = await executeTool(controller, name, args, timeoutMs);
    return content({ ok: true, ...(isRecord(value) ? value : { value }) }, false);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : String(error);
    return content({ ok: false, error: { code, message } }, true);
  }
}

async function executeTool(
  controller: McpControllerAdapter,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  if (name === "notebook_state") return controller.snapshot();
  if (name === "list_cells") return { cells: controller.snapshot().cells };
  if (name === "read_cell") return { cell: requireCell(controller.snapshot(), args.cell) };

  const base = () => ({
    operationId: randomUUID(),
    clientId: "mcp",
    sessionEpoch: controller.snapshot().epoch,
  });
  let command: HostCommand;
  let settle = false;
  switch (name) {
    case "add_cell":
      command = parseHostCommand({ ...base(), type: "create", creations: [{
        clientOperationId: randomUUID(), after: args.after ?? null, body: args.body,
        cellType: args.type,
      }] });
      break;
    case "edit_cell": {
      const cell = requireCell(controller.snapshot(), args.cell);
      command = parseHostCommand({ ...base(), type: "edit", edits: [{
        cellId: cell.id, body: args.body, cellType: args.type,
        expectedRevision: args.expected_revision ?? cell.revision,
      }] });
      break;
    }
    case "delete_cell": {
      const cell = requireCell(controller.snapshot(), args.cell);
      command = parseHostCommand({ ...base(), type: "delete", cellId: cell.id,
        expectedRevision: args.expected_revision ?? cell.revision });
      break;
    }
    case "move_cell":
      command = parseHostCommand({ ...base(), type: "move", cellId: args.cell, after: args.after ?? null });
      break;
    case "rename_cell":
      command = parseHostCommand({ ...base(), type: "service", command: "rename-cell", payload: { cellId: args.cell, name: args.name } });
      break;
    case "disable_cell":
      command = parseHostCommand({ ...base(), type: "disable", cellId: args.cell, disabled: args.disabled });
      break;
    case "run_cell":
      command = parseHostCommand({ ...base(), type: "run", scope: "cell", cellId: args.cell, source: "mcp" });
      settle = true;
      break;
    case "run_all":
      command = parseHostCommand({ ...base(), type: "run", scope: "all", source: "mcp" });
      settle = true;
      break;
    case "run_stale":
      command = parseHostCommand({ ...base(), type: "run", scope: "stale", source: "mcp" });
      settle = true;
      break;
    case "interrupt":
      command = parseHostCommand({ ...base(), type: "interrupt" });
      settle = true;
      break;
    case "get_value":
      command = parseHostCommand({ ...base(), type: "inspect", name: args.name });
      settle = true;
      break;
    case "set_widget": {
      const fields = ["value", "index", "indices", "selected", "ops", "submit"].filter((key) => key in args);
      if (fields.length !== 1) throw codedError("invalid_request", "provide exactly one widget update field");
      const update: Record<string, unknown> = { [fields[0]!]: args[fields[0]!] };
      if ("paused" in args) update.paused = args.paused;
      command = parseHostCommand({ ...base(), type: "widget", name: args.name,
        path: args.path ?? [], update, source: args.source ?? "mcp" });
      settle = true;
      break;
    }
    case "save":
      command = parseHostCommand({ ...base(), type: "save" });
      break;
    case "export":
      command = parseHostCommand({ ...base(), type: "service", command: "export", payload: args });
      settle = true;
      break;
    case "check":
      command = parseHostCommand({ ...base(), type: "service", command: "check", payload: {} });
      break;
    default:
      throw codedError("invalid_request", `unknown tool: ${name}`);
  }
  const accepted = await controller.dispatch(command);
  if (!settle) return dispatchValue(accepted);
  const operation = await waitForOperation(controller, accepted.operation.id, timeoutMs);
  if (operation.status === "error" || operation.status === "cancelled") {
    throw codedError(operation.error?.code ?? `${command.type}_failed`, operation.error?.message ?? `${command.type} operation failed`);
  }
  if (name === "get_value") {
    const snapshot = controller.snapshot();
    return { name: args.name, value: operation.result ?? snapshot.lastValue, operation_id: operation.id };
  }
  const initial = dispatchValue(accepted);
  const settledResult = isRecord(operation.result)
    ? operation.result
    : operation.result === undefined ? {} : { result: operation.result };
  return { ...initial, ...settledResult, operation_id: operation.id, ...(operation.runId ? { run_id: operation.runId } : {}),
    ...(operation.token !== undefined ? { token: operation.token } : {}) };
}

async function waitForOperation(
  controller: McpControllerAdapter,
  id: string,
  timeoutMs: number,
): Promise<OperationRecord> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref();
  try {
    return await controller.awaitOperation(id, abort.signal);
  } catch (error) {
    if (abort.signal.aborted) throw codedError("mcp_timeout", "MCP action timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function dispatchValue(result: CommandResult): Record<string, unknown> {
  if (isRecord(result.result)) return { ...result.result, operation_id: result.operation.id };
  return { operation_id: result.operation.id, ...(result.result === undefined ? {} : { result: result.result }) };
}

function requireCell(snapshot: HostSnapshot, value: unknown): HostSnapshot["cells"][number] {
  if (typeof value !== "string" || !value) throw codedError("invalid_request", "cell must be a nonempty string");
  const cell = snapshot.cells.find((candidate) => candidate.id === value);
  if (!cell) throw codedError("not_found", `no such cell: ${value}`);
  return cell;
}

function content(payload: unknown, isError: boolean): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyParams(value: unknown): boolean {
  return value === undefined || isRecord(value) && Object.keys(value).length === 0;
}
