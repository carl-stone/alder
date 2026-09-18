import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

import { createMcpServer, type AlderMcpOptions, type McpControllerAdapter } from "../src/mcp.js";
import { connectMcpStdio, drainMcpStdio } from "../src/mcp-stdio.js";
import type { CommandResult, HostCommand, HostQueryResult, HostSnapshot } from "../src/protocol.js";

const cell = {
  id: "cell-1",
  type: "code",
  body: ["answer <- 42"],
  options: {},
  revision: 0,
  status: "done",
  outputs: [],
  progress: null,
  log: [],
  error: null,
  defs: [],
  refs: [],
  selfRefs: [],
  locals: [],
  barrier: false,
  opaque: false,
  diagnostics: [],
  analysisPending: false,
} as unknown as HostSnapshot["cells"][number];

const snapshot = {
  epoch: "epoch-1",
  cursor: 7,
  version: 0,
  documentRevision: 3,
  cells: [cell],
  runtime: { kernelEpoch: "kernel-1" },
} as unknown as HostSnapshot;
const CANONICAL_TOOL_NAMES = [
  "add_cell",
  "apply_transaction",
  "check",
  "delete_cell",
  "disable_cell",
  "edit_cell",
  "edit_cell_ranges",
  "format",
  "get_config",
  "get_help",
  "get_layout",
  "get_value",
  "interrupt",
  "list_cells",
  "materialize_output",
  "move_cell",
  "notebook_state",
  "packages_declare",
  "packages_install",
  "packages_status",
  "publish",
  "read_cell",
  "read_output",
  "recovery_state",
  "reload_source",
  "rename_cell",
  "restart",
  "run_all",
  "run_cell",
  "run_stale",
  "save",
  "save_as",
  "select_r",
  "set_app",
  "set_config",
  "set_layout",
  "set_runtime",
  "set_widget",
  "shutdown",
  "table_page",
  "upload_file",
] as const;

const REQUIRED_EFFECT_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  add_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  edit_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision", "expectedRevision"],
  delete_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision", "expectedRevision"],
  move_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  rename_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision", "expectedRevision"],
  disable_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision", "expectedRevision"],
  run_cell: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  run_all: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  run_stale: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  interrupt: ["requestId", "sessionEpoch"],
  get_value: ["requestId", "sessionEpoch"],
  set_widget: ["requestId", "sessionEpoch", "expectedRevision"],
  save: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  apply_transaction: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  edit_cell_ranges: ["requestId", "sessionEpoch", "expectedDocumentRevision", "expectedRevision"],
  select_r: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  set_runtime: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  reload_source: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  shutdown: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  restart: ["requestId", "sessionEpoch"],
  format: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  save_as: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  table_page: ["requestId", "sessionEpoch"],
  materialize_output: ["requestId", "sessionEpoch"],
  set_config: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  set_layout: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  set_app: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  packages_declare: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  packages_install: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  publish: ["requestId", "sessionEpoch", "expectedDocumentRevision"],
  upload_file: ["requestId", "sessionEpoch"],
};

function assertToolCatalog(tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>): void {
  assert.deepEqual(tools.map(tool => tool.name).sort(), CANONICAL_TOOL_NAMES);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const [name, fields] of Object.entries(REQUIRED_EFFECT_IDENTITY_FIELDS)) {
    const tool = byName.get(name);
    assert.ok(tool, "missing effect tool " + name);
    const properties = tool.inputSchema.properties ?? {};
    const required = new Set(tool.inputSchema.required ?? []);
    for (const field of fields) {
      assert.ok(Object.hasOwn(properties, field), name + " schema missing " + field + " property");
      assert.ok(required.has(field), name + " schema must require " + field);
    }
  }
}

const artifactStore: AlderMcpOptions["artifactStore"] = {
  writeArtifact: async () => { throw new Error("artifact store is not used by this contract test"); },
  retainArtifactRead: () => undefined,
  openArtifactResource: () => { throw new Error("artifact store is not used by this contract test"); },
  release: () => undefined,
};

function makeController(overrides: Partial<McpControllerAdapter> = {}): McpControllerAdapter {
  return {
    snapshot: () => snapshot,
    query: query => ({
      epoch: snapshot.epoch,
      documentRevision: snapshot.documentRevision,
      cursor: snapshot.cursor,
      result: query.type === "notebook"
        ? {
          protocol: "alder-host-v2",
          epoch: snapshot.epoch,
          cursor: snapshot.cursor,
          version: snapshot.version,
          documentRevision: snapshot.documentRevision,
          path: null,
          metadata: {},
          config: {},
          dirty: false,
          changed: false,
          disk: {},
          sidecars: {},
          runtime: snapshot.runtime,
          capabilities: [],
          activeClientIds: ["client-1"],
          cells: snapshot.cells.map(candidate => ({ id: candidate.id, type: candidate.type, options: candidate.options, revision: candidate.revision })),
        }
        : query.type === "state"
          ? { kind: "snapshot", epoch: snapshot.epoch, cursor: snapshot.cursor, snapshot }
        : query.type === "cells"
          ? snapshot.cells.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? snapshot.cells.length))
          : null,
    } as unknown as HostQueryResult),
    subscribe: () => () => undefined,
    dispatch: async command => completed(command.requestId, { saved: true }),
    ...overrides,
  };
}

function completed(requestId: string, result: CommandResult["result"] = null, error: CommandResult["error"] = null): CommandResult {
  return { requestId, epoch: snapshot.epoch, version: snapshot.version, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor, result, error };
}

function catalogOptions(controller: McpControllerAdapter, store: AlderMcpOptions["artifactStore"] = artifactStore, extras: Partial<AlderMcpOptions> = {}): AlderMcpOptions {
  return {
    controller,
    artifactStore: store,
    clientId: "client-1",
    sessionEpoch: snapshot.epoch,
    ...extras,
  };
}
interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const withResolvers = <T>(): PromiseResolvers<T> =>
  (Promise as unknown as { withResolvers: <Value>() => PromiseResolvers<Value> }).withResolvers<T>();

interface InMemoryConnection {
  client: Client;
  server: McpServer;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
}

interface CatalogProxyConnection {
  client: Client;
  clientTransport: StdioServerTransport;
  transport: StdioServerTransport;
  input: PassThrough;
  output: PassThrough;
  upstreamServers: McpServer[];
  upstreamClients: Client[];
  factoryCalls: number;
}

async function connectInMemory(controller: McpControllerAdapter = makeController(), store: AlderMcpOptions["artifactStore"] = artifactStore, extras: Partial<AlderMcpOptions> = {}): Promise<InMemoryConnection> {
  const server = createMcpServer(catalogOptions(controller, store, extras));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-contract", version: "1" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, clientTransport, serverTransport };
}
async function closeInMemory(connection: InMemoryConnection): Promise<void> {
  await connection.client.close();
  await connection.server.close();
}

async function waitForMessage(output: PassThrough): Promise<Record<string, unknown>> {
  let buffered = "";
  const { promise, resolve, reject } = withResolvers<Record<string, unknown>>();
  const onData = (bytes: Buffer) => {
    buffered += String(bytes);
    const at = buffered.indexOf("\n");
    if (at < 0) return;
    output.off("data", onData);
    output.off("error", onError);
    try { resolve(JSON.parse(buffered.slice(0, at)) as Record<string, unknown>); }
    catch (error) { reject(error); }
  };
  const onError = (error: Error) => {
    output.off("data", onData);
    reject(error);
  };
  output.on("data", onData);
  output.on("error", onError);
  return promise;
}

async function connectCatalogProxy(controller: McpControllerAdapter = makeController()): Promise<CatalogProxyConnection> {
  const input = new PassThrough();
  const output = new PassThrough();
  const upstreamServers: McpServer[] = [];
  const upstreamClients: Client[] = [];
  let factoryCalls = 0;
  const transport = await connectMcpStdio(async initialization => {
    factoryCalls++;
    const server = createMcpServer(catalogOptions(controller));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(initialization.clientInfo, { capabilities: initialization.capabilities });
    upstreamServers.push(server);
    upstreamClients.push(client);
    return { client, transport: clientTransport };
  }, { input, output });
  const clientTransport = new StdioServerTransport(output, input);
  const client = new Client({ name: "stdio-contract", version: "1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, clientTransport, transport, input, output, upstreamServers, upstreamClients, factoryCalls };
}

async function closeCatalogProxy(connection: CatalogProxyConnection): Promise<void> {
  await connection.client.close();
  await connection.transport.close();
  await drainMcpStdio(connection.transport);
  await Promise.all(connection.upstreamClients.map(client => client.close()));
  await Promise.all(connection.upstreamServers.map(server => server.close()));
  connection.input.destroy();
  connection.output.destroy();
}

test("createMcpServer initializes over the official in-memory transport and lists the catalog", async () => {
  const connection = await connectInMemory();
  try {
    const tools = await connection.client.listTools();
    assertToolCatalog(tools.tools);

    const resources = await connection.client.listResources();
    assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), [
      "alder://cell/cell-1/outputs",
      "alder://notebook/dag",
      "alder://notebook/source",
      "alder://notebook/state",
    ]);
    const templates = await connection.client.listResourceTemplates();
    assert.deepEqual(templates.resourceTemplates.map(template => template.uriTemplate).sort(), [
      "alder://cell/{cell}/outputs",
      "alder://outputs/{output}",
    ]);
  } finally {
    await closeInMemory(connection);
  }
});
test("MCP reads and interrupt remain live during startup and resource updates require subscriptions", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const connection = await connectInMemory(makeController({
    subscribe: next => { listener = next as (event: unknown) => void; return () => { listener = undefined; }; },
  }));
  try {
    const updates: string[] = [];
    connection.client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { updates.push(notification.params.uri); });
    await connection.client.subscribeResource({ uri: "alder://notebook/state" });
    listener?.({ type: "transaction" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(updates, ["alder://notebook/state"]);

    const state = await Promise.race([
      connection.client.callTool({ name: "notebook_state", arguments: {} }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read blocked on startup")), 250)),
    ]);
    assert.equal(state.isError, false);
    const stateResult = (state.structuredContent as { result?: Record<string, unknown> } | undefined)?.result;
    assert.equal(stateResult?.kind, "snapshot");
    assert.deepEqual((stateResult?.snapshot as HostSnapshot).cells, snapshot.cells);
    const interrupted = await Promise.race([
      connection.client.callTool({ name: "interrupt", arguments: { requestId: "interrupt-startup", sessionEpoch: snapshot.epoch } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("interrupt blocked on startup")), 250)),
    ]);
    assert.equal(interrupted.isError, false);
    await connection.client.unsubscribeResource({ uri: "alder://notebook/state" });
    listener?.({ type: "transaction" });
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let index = 0; index < 256; index++) await connection.client.subscribeResource({ uri: `alder://outputs/output-${index}` });
    await assert.rejects(connection.client.subscribeResource({ uri: "alder://outputs/overflow" }));
    assert.deepEqual(updates, ["alder://notebook/state"]);
  } finally {
    await closeInMemory(connection);
  }
});

test("MCP check waits for runtime readiness", async () => {
  const runtimeReady = withResolvers<void>();
  const connection = await connectInMemory(makeController(), artifactStore, { runtimeReady: () => runtimeReady.promise });
  try {
    let settled = false;
    const pending = connection.client.callTool({ name: "check", arguments: {} }).then(result => {
      settled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    runtimeReady.resolve();
    const result = await pending;
    assert.equal(result.isError, false);
  } finally {
    runtimeReady.resolve();
    await closeInMemory(connection);
  }
});

test("MCP resource reads remain available during runtime startup", async () => {
  const startup = withResolvers<void>();
  const connection = await connectInMemory(makeController(), artifactStore, { startup: startup.promise });
  try {
    const result = await Promise.race([
      connection.client.readResource({ uri: "alder://notebook/state" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("resource read blocked on runtime startup")), 250)),
    ]);
    assert.equal(result.contents[0]?.uri, "alder://notebook/state");
  } finally {
    startup.resolve();
    await closeInMemory(connection);
  }
});
test("MCP host-only mutations bypass pending runtime startup", async () => {
  const startup = withResolvers<void>();
  const connection = await connectInMemory(makeController(), artifactStore, { startup: startup.promise });
  try {
    const result = await Promise.race([
      connection.client.callTool({
        name: "add_cell",
        arguments: {
          requestId: "add-while-starting",
          sessionEpoch: snapshot.epoch,
          expectedDocumentRevision: snapshot.documentRevision,
          after: null,
          body: ["x <- 1"],
          type: "code",
          options: {},
        },
      }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("host-only mutation blocked on runtime startup")), 250); timer.unref(); }),
    ]);
    assert.equal(result.isError, false);
  } finally {
    startup.resolve();
    await closeInMemory(connection);
  }
});

test("MCP runtime mutations follow the current readiness generation", async () => {
  let readiness = withResolvers<void>();
  const connection = await connectInMemory(makeController(), artifactStore, { runtimeReady: () => readiness.promise });
  try {
    const pending = connection.client.callTool({
      name: "run_all",
      arguments: { requestId: "wait-runtime", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision },
    });
    const remainsPending = await Promise.race([
      pending.then(() => false),
      new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(true), 25); timer.unref(); }),
    ]);
    assert.equal(remainsPending, true);
    readiness.resolve();
    assert.equal((await pending).isError, false);

    readiness = withResolvers<void>();
    readiness.promise.catch(() => undefined);
    readiness.reject(new Error("replacement runtime failed"));
    const failed = await connection.client.callTool({
      name: "run_all",
      arguments: { requestId: "failed-runtime", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision },
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0]?.text, "replacement runtime failed");

    readiness = withResolvers<void>();
    readiness.resolve();
    const recovered = await connection.client.callTool({
      name: "run_all",
      arguments: { requestId: "recovered-runtime", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision },
    });
    assert.equal(recovered.isError, false);
  } finally {
    await closeInMemory(connection);
  }
});

test("MCP select_r remains callable when initial runtime startup fails", async () => {
  let selected: HostCommand | undefined;
  const connection = await connectInMemory(makeController({
    dispatch: async command => {
      selected = command;
      return await makeController().dispatch(command);
    },
  }), artifactStore, { startup: async () => { throw new Error("initial R environment unavailable"); } });
  try {
    const result = await connection.client.callTool({
      name: "select_r",
      arguments: {
        requestId: "select-r-1",
        sessionEpoch: snapshot.epoch,
        rscript: "/usr/bin/Rscript",
        persistDefault: false,
        expectedDocumentRevision: snapshot.documentRevision,
      },
    });
    assert.equal(result.isError, false);
    assert.equal(selected?.type, "select-r");
    if (selected?.type !== "select-r") throw new Error("expected select-r command");
    assert.equal(selected.rscript, "/usr/bin/Rscript");
  } finally {
    await closeInMemory(connection);
  }
});

test("MCP revocation after progress prevents dispatch", async () => {
  const progressSent = withResolvers<void>();
  const releaseProgress = withResolvers<void>();
  const dispatched: HostCommand[] = [];
  const controller = makeController({
    dispatch: async command => {
      dispatched.push(command);
      return await makeController().dispatch(command);
    },
  });
  const connection = await connectInMemory(controller);
  const send = connection.serverTransport.send.bind(connection.serverTransport);
  connection.serverTransport.send = async (message, options) => {
    if ("method" in message && message.method === "notifications/progress") {
      progressSent.resolve();
      await releaseProgress.promise;
    }
    return send(message, options);
  };
  let closed = false;
  try {
    const pending = connection.client.callTool({
      name: "run_all",
      arguments: { requestId: "revoked-run", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision },
    }, undefined, { onprogress: () => undefined });
    await progressSent.promise;
    const closing = connection.server.close().then(() => { closed = true; });
    releaseProgress.resolve();
    await closing;
    await pending.catch(() => undefined);
    assert.equal(dispatched.length, 0);
  } finally {
    if (!closed) await closeInMemory(connection);
  }
});
test("MCP lease revocation after progress prevents dispatch", async () => {
  const progressSent = withResolvers<void>();
  const releaseProgress = withResolvers<void>();
  const dispatched: HostCommand[] = [];
  let leaseActive = true;
  let activeChecks = 0;
  const connection = await connectInMemory(makeController({
    dispatch: async command => {
      dispatched.push(command);
      return await makeController().dispatch(command);
    },
  }), artifactStore, {
    assertActive: () => {
      activeChecks++;
      if (!leaseActive) throw Object.assign(new Error("session lease has ended"), { code: "forbidden" });
    },
  });
  const send = connection.serverTransport.send.bind(connection.serverTransport);
  connection.serverTransport.send = async (message, options) => {
    if ("method" in message && message.method === "notifications/progress") {
      progressSent.resolve();
      await releaseProgress.promise;
    }
    return send(message, options);
  };
  try {
    const pending = connection.client.callTool({
      name: "run_all",
      arguments: { requestId: "revoked-run-authoritative", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision },
      _meta: { progressToken: "revocation-barrier" },
    }, undefined, { onprogress: () => undefined });
    await progressSent.promise;
    // Model the lease registry removing this generation while progress is in flight.
    leaseActive = false;
    releaseProgress.resolve();
    await pending.catch(() => undefined);
    assert.equal(activeChecks >= 2, true);
    assert.equal(dispatched.length, 0);
  } finally {
    await closeInMemory(connection);
  }
});

test("MCP shutdown sends its settled response before closing the transport", async () => {
  let connection: InMemoryConnection | undefined;
  let shutdownCalled = false;
  const controller = makeController({
    dispatch: async command => completed(command.requestId, { closing: true }),
  });
  connection = await connectInMemory(controller, artifactStore, {
    onShutdown: () => {
      shutdownCalled = true;
      if (connection !== undefined) void connection.server.server.close().catch(() => undefined);
    },
  });
  try {
    const result = await connection.client.callTool({
      name: "shutdown",
      arguments: {
        requestId: "shutdown-1",
        sessionEpoch: snapshot.epoch,
        expectedDocumentRevision: snapshot.documentRevision,
        expectedClientIds: [],
        confirmed: true,
      },
    });
    assert.equal(result.isError, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownCalled, true);
  } finally {
    await closeInMemory(connection);
  }
});

test("MCP uncertain completion retains identity and only retries when explicitly called", async () => {
  const commands: HostCommand[] = [];
  const done = withResolvers<CommandResult>();
  const controller = makeController({ dispatch: command => { commands.push(command); return done.promise; } });
  const connection = await connectInMemory(controller, artifactStore, { commandTimeoutMs: 10 });
  const args = { requestId: "uncertain-run", sessionEpoch: snapshot.epoch, expectedDocumentRevision: 3 };
  try {
    const first = await connection.client.callTool({ name: "run_all", arguments: args });
    assert.equal(first.isError, true);
    assert.equal(first.structuredContent?.requestId, args.requestId);
    assert.equal(first.structuredContent?.epoch, args.sessionEpoch);
    assert.equal((first.structuredContent?.error as { code: string }).code, "command_uncertain");
    assert.equal(commands.length, 1);
    done.resolve(completed(args.requestId, { ran: ["cell-1"] }));
    const second = await connection.client.callTool({ name: "run_all", arguments: args });
    assert.equal(second.isError, false);
    assert.deepEqual(second.structuredContent, completed(args.requestId, { ran: ["cell-1"] }));
    assert.deepEqual(commands[0], commands[1]);
  } finally { await closeInMemory(connection); }
});

test("MCP passes an old epoch unchanged so the backend can reject an uncertain retry", async () => {
  let dispatched: HostCommand | undefined;
  const controller = makeController({ dispatch: async command => {
    dispatched = command;
    return completed(command.requestId, null, { code: "session_replaced", message: "The original session ended" });
  } });
  const connection = await connectInMemory(controller);
  try {
    const result = await connection.client.callTool({ name: "run_all", arguments: { requestId: "prior-run", sessionEpoch: "prior-epoch", expectedDocumentRevision: 3 } });
    assert.equal(dispatched?.sessionEpoch, "prior-epoch");
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent?.error as { code: string }).code, "session_replaced");
  } finally { await closeInMemory(connection); }
});

test("MCP forwards logical Markdown range edits without re-encoding them", async () => {
  const markdownCell = { ...cell, type: "markdown", body: ["# # Heading", "#", "# Body text", ""] } as unknown as HostSnapshot["cells"][number];
  let dispatched: HostCommand | undefined;
  const controller = makeController({
    snapshot: () => ({ ...snapshot, cells: [markdownCell] }),
    dispatch: async command => { dispatched = command; return await makeController().dispatch(command); },
  });
  const connection = await connectInMemory(controller);
  const edits = [{ start: { line: 0, character: 2 }, end: { line: 0, character: 9 }, text: "Renamed" }];
  try {
    const result = await connection.client.callTool({ name: "edit_cell_ranges", arguments: { requestId: "range-1", sessionEpoch: snapshot.epoch, expectedDocumentRevision: 3, cell: "cell-1", expectedRevision: 0, edits } });
    assert.equal(result.isError, false);
    assert.equal(dispatched?.type, "transaction");
    if (dispatched?.type !== "transaction") throw new Error("expected transaction command");
    assert.deepEqual(dispatched.changes, [{ type: "text-edit", cell: { cellId: "cell-1" }, expectedRevision: 0, edits }]);
  } finally { await closeInMemory(connection); }
});

test("MCP returns completed effects directly and reads current snapshots", async () => {
  let dispatched: HostCommand | undefined;
  let queried: unknown;
  const current = { kind: "snapshot", epoch: snapshot.epoch, cursor: snapshot.cursor, snapshot };
  const controller = makeController({
    query: query => { queried = query; return { epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor, result: current } as unknown as HostQueryResult; },
    dispatch: async command => { dispatched = command; return completed(command.requestId, { saved: true }); },
  });
  const connection = await connectInMemory(controller);
  try {
    const state = await connection.client.callTool({ name: "notebook_state", arguments: {} });
    assert.deepEqual(queried, { type: "state" });
    assert.deepEqual(state.structuredContent?.result, current);
    const result = await connection.client.callTool({ name: "save", arguments: { requestId: "save-1", sessionEpoch: snapshot.epoch, expectedDocumentRevision: 3 } });
    assert.deepEqual(dispatched, { requestId: "save-1", clientId: "client-1", sessionEpoch: snapshot.epoch, type: "save", expectedDocumentRevision: 3 });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, completed("save-1", { saved: true }));
  } finally { await closeInMemory(connection); }
});

test("MCP snapshot queries expose logical Markdown bodies", async () => {
  const physicalMarkdown = { ...cell, type: "markdown", body: ["# Heading", "#", "# Body"] };
  const controller = makeController({ query: () => ({ epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor,
    result: { kind: "snapshot", epoch: snapshot.epoch, cursor: 9, snapshot: { ...snapshot, cells: [physicalMarkdown] } },
  } as unknown as HostQueryResult) });
  const connection = await connectInMemory(controller);
  try {
    const result = await connection.client.callTool({ name: "notebook_state", arguments: {} });
    const body = (result.structuredContent as { result: { snapshot: HostSnapshot } }).result.snapshot.cells[0]!.body;
    assert.deepEqual(body, ["Heading", "", "Body"]);
  } finally { await closeInMemory(connection); }
});

test("connectMcpStdio forwards official SDK initialization, catalog listing, and queries", async () => {
  const connection = await connectCatalogProxy();
  try {
    assert.equal(connection.factoryCalls, 1);
    const tools = await connection.client.listTools();
    assertToolCatalog(tools.tools);
    const resources = await connection.client.listResources();
    assert.equal(resources.resources.length, 4);
    const result = await connection.client.callTool({ name: "list_cells", arguments: {} });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      epoch: snapshot.epoch,
      documentRevision: snapshot.documentRevision,
      cursor: snapshot.cursor,
      result: [cell],
    });
  } finally {
    await closeCatalogProxy(connection);
  }
});

test("connectMcpStdio rejects malformed pre-initialize frames without invoking the upstream", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let factoryCalls = 0;
  const transport = await connectMcpStdio(async () => {
    factoryCalls++;
    throw new Error("upstream must not be created");
  }, { input, output });
  try {
    input.write("not-json\n");
    assert.deepEqual(await waitForMessage(output), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    assert.equal(factoryCalls, 0);
  } finally {
    await transport.close();
    input.destroy();
    output.destroy();
  }
});

test("connectMcpStdio forwards cancellation to an in-flight official SDK request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const upstreamServer = new McpServer({ name: "cancellation-server", version: "1" });
  const startedGate = withResolvers<void>();
  const cancelledGate = withResolvers<void>();
  const started = startedGate.promise;
  const cancelled = cancelledGate.promise;
  upstreamServer.registerTool("slow", { description: "waits until cancelled", inputSchema: z.object({}) }, async (_args, extra) => {
    startedGate.resolve();
    const request = withResolvers<never>();
    extra.signal.addEventListener("abort", () => {
      cancelledGate.resolve();
      request.reject(new Error("upstream request cancelled"));
    }, { once: true });
    await request.promise;
    throw new Error("unreachable");
  });
  const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(upstreamServerTransport);
  const upstreamClients: Client[] = [];
  const transport = await connectMcpStdio(async initialization => {
    const client = new Client(initialization.clientInfo, { capabilities: initialization.capabilities });
    upstreamClients.push(client);
    return { client, transport: upstreamClientTransport };
  }, { input, output });
  const clientTransport = new StdioServerTransport(output, input);
  const client = new Client({ name: "cancellation-client", version: "1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const controller = new AbortController();
    const pending = client.callTool({ name: "slow", arguments: {} }, undefined, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending);
    await cancelled;
  } finally {
    await client.close();
    await transport.close();
    await drainMcpStdio(transport);
    await Promise.all(upstreamClients.map(upstreamClient => upstreamClient.close()));
    await upstreamServer.close();
    input.destroy();
    output.destroy();
  }
});

test("large structured results become immutable artifacts while output tools use HostQuery", async () => {
  let captured = new Uint8Array();
  const released: string[] = [];
  const outputQueries: Array<{ type: "output"; handle: string; offset: number; limit: number }> = [];
  const descriptor = {
    handle: "large-result",
    mimeType: "application/json",
    byteLength: 0,
    chunkBytes: 256 * 1024,
    epoch: snapshot.epoch,
    documentRevision: snapshot.documentRevision,
    kernelEpoch: snapshot.runtime.kernelEpoch,
  };
  const store: AlderMcpOptions["artifactStore"] = {
    writeArtifact: async bytes => {
      captured = Uint8Array.from(bytes);
      return { ...descriptor, byteLength: captured.byteLength };
    },
    retainArtifactRead: () => undefined,
    openArtifactResource: () => ({
      descriptor: { ...descriptor, byteLength: captured.byteLength },
      read: async (offset, limit) => captured.slice(offset, offset + limit),
      close: () => undefined,
    }),
    release: handles => { released.push(...handles.map(handle => handle.handle)); },
  };
  const controller = makeController({
    snapshot: () => ({ ...snapshot, cells: [{ ...cell, body: ["😀".repeat(300_000)] }] }),
    query: query => {
      if (query.type === "cells") {
        return { epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor, result: { cells: [{ ...cell, body: ["😀".repeat(300_000)] }] } } as unknown as HostQueryResult;
      }
      if (query.type === "output") {
        outputQueries.push({ type: "output", handle: query.handle, offset: query.offset ?? 0, limit: query.limit ?? 0 });
        const offset = query.offset ?? 0;
        return {
          epoch: snapshot.epoch,
          documentRevision: snapshot.documentRevision,
          cursor: snapshot.cursor,
          result: { encoding: "utf8", offset, nextOffset: offset + 4, eof: false, data: "delegated" },
        } as unknown as HostQueryResult;
      }
      return { epoch: snapshot.epoch, documentRevision: snapshot.documentRevision, cursor: snapshot.cursor, result: null } as unknown as HostQueryResult;
    },
  });
  const connection = await connectInMemory(controller, store);
  try {
    const result = await connection.client.callTool({ name: "list_cells", arguments: {} });
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) < 1_048_576);
    assert.equal((result.structuredContent as { result?: { artifact?: { handle?: string } } }).result?.artifact?.handle, descriptor.handle);
    assert.ok(captured.byteLength > 1_048_576);

    const page = await connection.client.callTool({ name: "read_output", arguments: { handle: descriptor.handle, offset: 4, limit: 5 } });
    assert.deepEqual((page.structuredContent as { result?: unknown }).result, { encoding: "utf8", offset: 4, nextOffset: 8, eof: false, data: "delegated" });
    const tinyPage = await connection.client.callTool({ name: "read_output", arguments: { handle: descriptor.handle, offset: 8, limit: 1 } });
    assert.deepEqual((tinyPage.structuredContent as { result?: unknown }).result, { encoding: "utf8", offset: 8, nextOffset: 12, eof: false, data: "delegated" });
    assert.deepEqual(outputQueries, [
      { type: "output", handle: descriptor.handle, offset: 4, limit: 5 },
      { type: "output", handle: descriptor.handle, offset: 8, limit: 1 },
    ]);

    const stateResource = await connection.client.readResource({ uri: "alder://notebook/state" });
    const stateContent = stateResource.contents[0]!;
    assert.equal(stateContent.mimeType, "application/vnd.alder.artifact-handle+json");
    assert.equal((stateContent._meta as { alderArtifactHandle?: { handle?: string } }).alderArtifactHandle?.handle, descriptor.handle);
    assert.equal((JSON.parse((stateContent as { text: string }).text) as { artifact: { handle: string } }).artifact.handle, descriptor.handle);
  } finally {
    await closeInMemory(connection);
  }
  assert.deepEqual(released, [descriptor.handle]);
});

test("MCP runtime startup timeout is bounded and ignores a late startup result", async () => {
  const startup = withResolvers<void>();
  const connection = await connectInMemory(makeController(), artifactStore, { startup: startup.promise, startupTimeoutMs: 20 });
  try {
    const result = await Promise.race([
      connection.client.callTool({ name: "run_all", arguments: { requestId: "timed-out-startup", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision } }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("runtime startup timeout was not enforced")), 500); timer.unref(); }),
    ]);
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "MCP action timed out");

    startup.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    const late = await connection.client.callTool({ name: "run_all", arguments: { requestId: "late-startup", sessionEpoch: snapshot.epoch, expectedDocumentRevision: snapshot.documentRevision } });
    assert.equal(late.isError, true);
    assert.equal(late.content[0]?.text, "MCP action timed out");
  } finally {
    startup.resolve();
    await closeInMemory(connection);
  }
});

test("connectMcpStdio bounds a never-settling upstream factory and drains", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const factory = withResolvers<{ client: Client; transport: Transport }>();
  let lateCloseCalls = 0;
  const lateClient = new Client({ name: "late-factory-client", version: "1" }, { capabilities: {} });
  const lateTransport: Transport = {
    start: async () => undefined,
    send: async () => undefined,
    close: async () => { lateCloseCalls++; },
  };
  const transport = await connectMcpStdio(() => factory.promise, { input, output, upstreamTimeoutMs: 20 });
  try {
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "factory-timeout", version: "1" } } }) + "\n");
    const response = await Promise.race([
      waitForMessage(output),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("upstream factory timeout was not enforced")), 500); timer.unref(); }),
    ]);
    assert.deepEqual(response, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "MCP upstream connection timed out" } });
    factory.resolve({ client: lateClient, transport: lateTransport });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(lateCloseCalls > 0);
    await Promise.race([
      drainMcpStdio(transport),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("stdio drain remained blocked after factory timeout")), 500); timer.unref(); }),
    ]);
  } finally {
    await transport.close();
    await drainMcpStdio(transport);
    input.destroy();
    output.destroy();
  }
});

test("connectMcpStdio bounds client.connect and closes the abandoned upstream", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closeCalls = 0;
  const hangingTransport: Transport = {
    start: () => new Promise<void>(() => {}),
    send: async () => undefined,
    close: async () => { closeCalls++; },
  };
  const upstreamClient = new Client({ name: "connect-timeout", version: "1" }, { capabilities: {} });
  const transport = await connectMcpStdio(async () => ({ client: upstreamClient, transport: hangingTransport }), { input, output, upstreamTimeoutMs: 20 });
  try {
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "connect-timeout-client", version: "1" } } }) + "\n");
    const response = await Promise.race([
      waitForMessage(output),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("client.connect timeout was not enforced")), 500); timer.unref(); }),
    ]);
    assert.deepEqual(response, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "MCP upstream connection timed out" } });
    assert.ok(closeCalls > 0);
    await Promise.race([
      drainMcpStdio(transport),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("stdio drain remained blocked after connect timeout")), 500); timer.unref(); }),
    ]);
  } finally {
    await transport.close();
    await drainMcpStdio(transport);
    await upstreamClient.close().catch(() => undefined);
    input.destroy();
    output.destroy();
  }
});
