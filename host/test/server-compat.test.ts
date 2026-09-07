import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { get as httpGet, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  HOST_PROTOCOL,
  type CommandResult,
  type HostCellState,
  type HostCommand,
  type HostEvent,
  type HostSnapshot,
  type OperationRecord,
  type Recovery,
} from "../src/protocol.js";
import {
  buildAllowedOrigins,
  createAlderServer,
  HTTP_JSON_LIMIT,
  HTTP_UPLOAD_LIMIT,
  parseStrictJsonObject,
  readJsonBody,
  safeChildPath,
  type ControllerAdapter,
  validateLoopbackHost,
  validateRequestOrigin,
} from "../src/server.js";

function cell(id: string): HostCellState {
  return {
    id,
    type: "code",
    body: ["x <- 1"],
    options: {},
    revision: 0,
    status: "done",
    outputs: [],
    progress: null,
    log: [],
    error: null,
    defs: ["x"],
    refs: [],
    selfRefs: [],
    locals: [],
    barrier: false,
    opaque: false,
    diagnostics: [],
    analysisPending: false,
  };
}

class CompatController implements ControllerAdapter {
  readonly operations = new Map<string, OperationRecord>();
  readonly commands = new Map<string, HostCommand>();
  readonly listeners = new Set<(event: HostEvent) => void>();
  private version = 1;
  private run = 0;
  private created = 1;
  private installResolve: ((operation: OperationRecord) => void) | null = null;
  private installPromise: Promise<OperationRecord> | null = null;
  readonly state: HostSnapshot = {
    protocol: HOST_PROTOCOL,
    epoch: "compat-epoch",
    cursor: 0,
    version: 1,
    path: "/tmp/notebook.R",
    metadata: { app: { layout: "tabs", width: "wide", include_code: true } },
    config: { on_cell_change: "automatic" },
    layout: { version: 1, cells: [] },
    changed: true,
    runtime: {
      executionMode: "automatic",
      runOnStartup: false,
      executionReady: true,
      analyzerAvailable: true,
      kernelAvailable: true,
      packageOperationActive: false,
      busy: false,
      activeRunId: null,
    },
    cells: [cell("cell-1")],
    graph: {
      nodes: ["cell-1"],
      edges: { "cell-1": [] },
      reverseEdges: { "cell-1": [] },
      duplicates: {},
      cycles: [],
      topologicalOrder: ["cell-1"],
    },
    variables: [{
      name: "x", owner: "cell-1", revision: 0, class: "numeric",
      dim: null, size: 56, widget: false, valueSummary: "1",
    }],
    editorDiagnostics: {},
    serviceErrors: {},
    operations: [],
    lastValue: null,
    lastActionError: null,
  };

  snapshot(): HostSnapshot {
    return structuredClone({
      ...this.state,
      version: this.version,
      operations: [...this.operations.values()],
    });
  }

  recover(): Recovery {
    return {
      kind: "snapshot",
      epoch: this.state.epoch,
      cursor: this.state.cursor,
      snapshot: this.snapshot(),
    };
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispatch(command: HostCommand): Promise<CommandResult> {
    this.commands.set(command.operationId, structuredClone(command));
    this.version += 1;
    let result: unknown;
    let operation: OperationRecord = {
      id: command.operationId,
      kind: command.type,
      status: "done",
      acceptedAt: Date.now(),
      settledAt: Date.now(),
    };
    if (command.type === "run" || command.type === "restart") {
      const runId = `host-run-${++this.run}`;
      operation = { ...operation, kind: command.type, runId, cellIds: ["cell-1"] };
      result = { runId, plan: ["cell-1"] };
    } else if (command.type === "interrupt") {
      result = { runId: "host-run-1", requested: true };
    } else if (command.type === "widget") {
      result = { token: 91, owner: "cell-1" };
      const widgetOperation = {
        operationId: command.operationId,
        token: 91,
        status: "done",
        error: null,
      };
      this.state.cells[0]!.outputs = [{
        kind: "widget",
        name: command.name,
        owner: "cell-1",
        spec: { kind: "slider", value: 2 },
        operation: widgetOperation,
        operations: { [command.name]: widgetOperation },
      }];
    } else if (command.type === "inspect") {
      result = { name: command.name, owner: "cell-1", revision: 0 };
      operation.result = {
        operationId: command.operationId,
        name: command.name,
        value: { kind: "text", text: "[1] 1" },
        owner: "cell-1",
        revision: 0,
      };
      this.state.lastValue = operation.result;
    } else if (command.type === "create") {
      const created = command.creations.map((creation) => ({
        clientOperationId: creation.clientOperationId,
        id: `cell-${++this.created}`,
        revision: 0,
      }));
      result = { edited: [], created };
    } else if (command.type === "edit") {
      result = { edited: command.edits.map((edit) => ({ id: edit.cellId, revision: edit.expectedRevision + 1 })), created: [] };
    } else if (command.type === "delete") {
      result = { id: command.cellId };
    } else if (command.type === "move") {
      result = { id: command.cellId, after: command.after };
    } else if (command.type === "disable") {
      result = { id: command.cellId, disabled: command.disabled, runId: null };
    } else if (command.type === "save") {
      result = { path: this.state.path, etag: "etag-1" };
    } else if (command.type === "set-runtime") {
      result = {
        executionMode: command.executionMode ?? this.state.runtime.executionMode,
        runOnStartup: command.runOnStartup ?? this.state.runtime.runOnStartup,
      };
    } else if (command.type === "set-config") {
      result = { config: command.patch };
    } else if (command.type === "set-layout") {
      result = { layout: command.layout };
    } else if (command.type === "format") {
      result = { changed: 1, edited: [{ id: "cell-1", revision: 1 }], created: [] };
    } else if (command.type === "service") {
      if (command.command === "check") {
        result = { ok: false, issues: [], cells: [{ id: "cell-1", diagnostics: [{ level: "warning", code: "style", message: "style" }] }] };
      } else if (command.command === "rename-cell") {
        result = { id: command.payload.cellId, name: command.payload.name };
      } else if (command.command === "set-app") {
        result = { app: command.payload };
      } else if (command.command === "export") {
        operation = { ...operation, status: "running", settledAt: undefined };
        result = { accepted: true };
      } else if (command.command === "packages") {
        operation = { ...operation, status: "running", settledAt: undefined };
        result = { accepted: true };
        if (command.payload.op === "install") {
          this.installPromise = new Promise((resolve) => { this.installResolve = resolve; });
        }
      }
    }
    if (operation.result === undefined && operation.status === "done") operation.result = structuredClone(result);
    this.operations.set(operation.id, operation);
    return { operation: structuredClone(operation), version: this.version, cursor: 0, ...(result === undefined ? {} : { result }) };
  }

  operation(id: string): OperationRecord | undefined {
    const operation = this.operations.get(id);
    return operation === undefined ? undefined : structuredClone(operation);
  }

  async awaitOperation(id: string): Promise<OperationRecord> {
    const command = this.commands.get(id);
    const current = this.operations.get(id);
    if (command?.type === "service" && command.command === "packages" && command.payload.op === "install") {
      return this.installPromise!;
    }
    if (current === undefined) throw Object.assign(new Error("no such operation"), { code: "not_found" });
    let result: unknown = current.result;
    if (command?.type === "service" && command.command === "export") {
      result = { format: command.payload.format, artifact: "export.html", url: "/download/export.html" };
    } else if (command?.type === "service" && command.command === "packages") {
      const status = { declared: ["dplyr"], missing: ["tidyr"], installed: ["dplyr"], installing: [], metadata: "/tmp/alder.json" };
      result = command.payload.op === "declare"
        ? { declaration: { declared: command.payload.packages ?? [command.payload.package], metadata: "/tmp/alder.json" }, status }
        : status;
    }
    const settled = { ...current, status: "done" as const, settledAt: Date.now(), result };
    this.operations.set(id, settled);
    return structuredClone(settled);
  }

  finishInstall(): void {
    const entry = [...this.commands.entries()].find(([, command]) => command.type === "service"
      && command.command === "packages" && command.payload.op === "install");
    assert.ok(entry);
    const [id] = entry;
    const current = this.operations.get(id)!;
    const operation: OperationRecord = {
      ...current,
      status: "done",
      settledAt: Date.now(),
      result: {
        result: { ok: true, packages: ["tidyr"] },
        status: { declared: ["dplyr"], missing: [], installed: ["dplyr", "tidyr"], installing: [] },
      },
    };
    this.operations.set(id, operation);
    this.installResolve?.(structuredClone(operation));
  }
}

async function fixture(): Promise<{
  controller: CompatController;
  origin: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "alder-server-compat-"));
  const staticDir = join(directory, "static");
  await mkdir(staticDir);
  const controller = new CompatController();
  const server = createAlderServer({ controller, staticDir, port: 0 });
  const address = await server.start();
  return {
    controller,
    origin: address.origin,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("HTTP parsing, origins, and file paths reject ambiguous or escaping input", async () => {
  const parsed = parseStrictJsonObject('{"outer":{"name":"ok"},"values":[1,true,null]}');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.getPrototypeOf(parsed.outer as object), null);
  assert.equal((parsed.outer as { name: string }).name, "ok");
  assert.deepEqual(parsed.values, [1, true, null]);
  for (const invalid of [
    '{"name":1,"name":2}',
    '{"name":1,"\\u006eame":2}',
    '[1,2]',
    '{"value":"\\ud800"}',
    `${"[".repeat(65)}0${"]".repeat(65)}`,
  ]) {
    assert.throws(() => parseStrictJsonObject(invalid), { name: "HttpBoundaryError" });
  }
  assert.throws(() => parseStrictJsonObject(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d])),
    /invalid JSON body/);
  assert.throws(() => parseStrictJsonObject(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x00, 0x22, 0x7d])),
    /NUL bytes/);
  const nested = (depth: number) => `{"value":${"[".repeat(depth)}0${"]".repeat(depth)}}`;
  assert.doesNotThrow(() => parseStrictJsonObject(nested(126)));
  assert.throws(() => parseStrictJsonObject(nested(127)), /structural complexity/);
  const containers = (count: number) => `{"value":[${Array.from({ length: count }, () => "{}").join(",")}]} `;
  assert.doesNotThrow(() => parseStrictJsonObject(containers(9_998)));
  assert.throws(() => parseStrictJsonObject(containers(9_999)), /structural complexity/);

  const request = (body: string | Buffer, headers: Record<string, string>): IncomingMessage =>
    Object.assign(Readable.from([body]), { headers }) as unknown as IncomingMessage;
  await assert.rejects(readJsonBody(request("{}", { "content-type": "text/plain" })),
    (error: unknown) => error instanceof Error && error.message === "Content-Type must be application/json");
  for (const limit of [HTTP_JSON_LIMIT, HTTP_UPLOAD_LIMIT]) {
    await assert.rejects(readJsonBody(request("{}", {
      "content-type": "application/json", "content-length": String(limit + 1),
    }), limit), (error: unknown) => error instanceof Error
      && error.message === `request body exceeds ${limit / (1024 * 1024)} MiB`);
  }
  await assert.rejects(readJsonBody(request('{"value":"too long"}', {
    "content-type": "application/json",
  }), 8), (error: unknown) => error instanceof Error && error.message === "request body exceeds 8 bytes");

  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.equal(validateLoopbackHost(host), host);
  for (const host of ["", "0.0.0.0", "127.0.0.2", "LOCALHOST"]) assert.throws(() => validateLoopbackHost(host));
  const defaults = buildAllowedOrigins(8899);
  assert.deepEqual(defaults, ["http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899"]);
  assert.equal(validateRequestOrigin({ host: "localhost:8899" }, defaults), true);
  assert.equal(validateRequestOrigin({ host: "localhost:8899", origin: "http://localhost:8899" }, defaults), true);
  assert.equal(validateRequestOrigin({ host: "evil.test", origin: "http://localhost:8899" }, defaults), false);
  assert.equal(validateRequestOrigin({ host: "localhost:8899", origin: "http://evil.test" }, defaults), false);
  assert.equal(validateRequestOrigin({}, defaults), false);
  assert.deepEqual(buildAllowedOrigins(8899, ["https://app.example.test"]), ["https://app.example.test"]);
  for (const origins of [[], ["http://localhost:8899", "http://localhost:8899"],
    ["ftp://localhost:8899"], ["http://user@localhost:8899"], ["http://localhost:8899/path"]]) {
    assert.throws(() => buildAllowedOrigins(8899, origins));
  }

  const directory = await mkdtemp(join(tmpdir(), "alder-static-boundary-"));
  const root = join(directory, "static");
  const sibling = join(directory, "sibling");
  await mkdir(join(root, "vendor"), { recursive: true });
  await mkdir(sibling);
  await writeFile(join(root, "app.js"), "export {};");
  await writeFile(join(root, "secret.txt"), "secret");
  await writeFile(join(root, "vendor", "module.js"), "export {};");
  await writeFile(join(sibling, "outside.js"), "outside");
  try {
    assert.equal(await safeChildPath(root, "app.js", ["js", "css"]), join(root, "app.js"));
    assert.equal(await safeChildPath(root, "vendor%2Fmodule.js", ["js"], true), join(root, "vendor", "module.js"));
    for (const path of ["", "secret.txt", "../sibling/outside.js", "..%2Fsibling%2Foutside.js",
      "%2e%2e%2fsibling%2foutside.js", "vendor%2Fmodule.js", ".hidden.js", "app.js%3Fextra",
      "C%3A%5Cwindows%5Cwin.ini.js", "a%00b.js", "%zz.js"]) {
      assert.equal(await safeChildPath(root, path, ["js", "css"]), null, path);
    }
    if (process.platform !== "win32") {
      await symlink(join(sibling, "outside.js"), join(root, "link.js"));
      assert.equal(await safeChildPath(root, "link.js", ["js"]), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only a successful browser state poll reports idle lifecycle activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-server-browser-activity-"));
  const staticDir = join(directory, "static");
  await mkdir(staticDir);
  const controller = new CompatController();
  let activities = 0;
  const server = createAlderServer({
    controller,
    staticDir,
    port: 0,
    onBrowserActivity: () => { activities += 1; },
  });
  try {
    const address = await server.start();
    assert.equal((await fetch(`${address.origin}/api/state`)).status, 200);
    assert.equal(activities, 0);
    assert.equal((await fetch(`${address.origin}/api/state`, {
      headers: {
        "User-Agent": "Mozilla/5.0 Alder lifecycle test",
        "Sec-Fetch-Site": "same-origin",
      },
    })).status, 200);
    assert.equal(activities, 1);
    assert.equal((await fetch(`${address.origin}/api/state`, {
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0" },
    })).status, 405);
    assert.equal(activities, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function post(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("shutdown completes a pending HTTP operation with session_stopped", { timeout: 5_000 }, async () => {
  const app = await fixture();
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let settle!: (operation: OperationRecord) => void;
  let pendingId = "";
  app.controller.awaitOperation = async id => {
    pendingId = id;
    entered();
    return new Promise<OperationRecord>(resolve => { settle = resolve; });
  };
  const request = post(app.origin, "/api/export", { format: "html" });
  await waiting;
  const closing = app.close();
  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown waited for the active HTTP operation")), 1_000);
      }),
    ]);
    assert.equal(response.status, 410);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "session_stopped");
    await closing;
  } finally {
    clearTimeout(timer);
    // A late service result must not overwrite the shutdown response.
    settle({ ...app.controller.operations.get(pendingId)!, status: "done",
      result: { format: "html", url: "/download/late.html" } });
    await request;
    await closing;
  }
});

for (const failure of ["throw", "reject"] as const) {
  test(`shutdown reports a callback ${failure} after acknowledging the request`, { timeout: 5_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-server-shutdown-"));
    const staticDir = join(directory, "static");
    await mkdir(staticDir);
    const controller = new CompatController();
    let report!: (message: string) => void;
    const reported = new Promise<string>((resolve) => { report = resolve; });
    const server = createAlderServer({
      controller,
      staticDir,
      port: 0,
      onShutdown: () => {
        if (failure === "throw") throw new Error("cleanup failed");
        return Promise.reject(new Error("cleanup failed"));
      },
      logger: (level, message) => {
        if (level === "error") report(message);
      },
    });
    try {
      const address = await server.start();
      const response = await fetch(`${address.origin}/api/shutdown`, {
        method: "POST",
        headers: { "X-Alder-Shutdown-Token": address.shutdownToken },
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true, stopping: true });
      assert.equal(await reported, "Shutdown callback failed: cleanup failed");
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("shutdown bounds a streamed response whose client stopped reading", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-server-stream-shutdown-"));
  const staticDir = join(directory, "static");
  const artifactDir = join(directory, "artifacts");
  await mkdir(staticDir);
  await mkdir(artifactDir);
  await writeFile(join(artifactDir, "large.html"), Buffer.alloc(32 * 1024 * 1024, 65));
  const server = createAlderServer({
    controller: new CompatController(),
    staticDir,
    artifactDir,
    port: 0,
  });
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  try {
    const address = await server.start();
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      request = httpGet(`${address.origin}/download/large.html`, resolve);
      request.once("error", reject);
    });
    response.on("error", () => {});
    response.pause();
    assert.equal(response.statusCode, 200);
    await server.close();
    assert.equal(server.address(), null);
  } finally {
    response?.destroy();
    request?.destroy();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP run and widget journals use strict bounded numeric aliases", async () => {
  const app = await fixture();
  try {
    const acceptedRun = await post(app.origin, "/api/run", { all: true });
    assert.equal(acceptedRun.status, 202);
    const runBody = await acceptedRun.json() as { run_id: number };
    assert.equal(Number.isSafeInteger(runBody.run_id), true);
    const runOperation = await fetch(`${app.origin}/api/run-operation?run_id=${runBody.run_id}`);
    assert.deepEqual(await runOperation.json(), {
      ok: true,
      operation: { run_id: runBody.run_id, status: "done", reset_tokens: [], error: null },
    });

    for (const query of ["", "?run_id=", "?run_id=0", "?run_id=-1", "?run_id=1.5", "?run_id=abc", "?run_id=1&run_id=2", "?run_id=1&extra=2", "?extra=1", "?run_id=99999999999999999999"]) {
      assert.equal((await fetch(`${app.origin}/api/run-operation${query}`)).status, 400, query);
    }
    const missing = await fetch(`${app.origin}/api/run-operation?run_id=2147483647`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { message: string } }).error.message, "run operation id was not found");
    const wrongMethod = await post(app.origin, `/api/run-operation?run_id=${runBody.run_id}`, {});
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const value = await post(app.origin, "/api/value", { name: "x" });
    const valueToken = ((await value.json()) as { token: number }).token;
    assert.equal((await fetch(`${app.origin}/api/widget-operation?token=${valueToken}`)).status, 404);

    const widget = await post(app.origin, "/api/widget", { name: "w", value: 2, source: "editor" });
    assert.equal(widget.status, 202);
    const widgetBody = await widget.json() as { token: number };
    const widgetOperation = await fetch(`${app.origin}/api/widget-operation?token=${widgetBody.token}`);
    assert.deepEqual(await widgetOperation.json(), {
      ok: true,
      operation: { token: widgetBody.token, status: "done", error: null, reset_expected: false },
    });

    assert.notEqual(valueToken, widgetBody.token);
    const state = await (await fetch(`${app.origin}/api/state`)).json() as {
      cells: Array<{ outputs: Array<{ operation: Record<string, unknown> }> }>;
    };
    assert.deepEqual(state.cells[0]!.outputs[0]!.operation, {
      token: widgetBody.token,
      status: "done",
      error: null,
    });
  } finally {
    await app.close();
  }
});

test("HTTP state and mutation responses preserve the public REST schema", async () => {
  const app = await fixture();
  try {
    const stateResponse = await fetch(`${app.origin}/api/state`);
    const state = await stateResponse.json() as Record<string, any>;
    assert.equal(state.epoch, "compat-epoch");
    assert.match(state.shutdown_token, /^[A-Za-z0-9]{48}$/);
    assert.equal(state.runtime.execution_mode, "automatic");
    assert.equal(state.runtime.worker_available, true);
    assert.deepEqual(state.app, { layout: "tabs", width: "wide", include_code: true });
    assert.equal(state.dataflow.variables[0].value_summary, "1");
    assert.deepEqual(state.dataflow.dag.edge_records, []);

    const added = await post(app.origin, "/api/cell", { op: "add", after: null, body: ["y <- 2"], type: "code" });
    assert.equal(added.status, 200);
    assert.deepEqual(Object.keys(await added.json() as object).sort(), ["id", "ok", "revision", "version"]);
    const commandCount = app.controller.commands.size;
    for (const expected_revision of [0.5, -1, 2_147_483_648]) {
      const invalid = await post(app.origin, "/api/cell", {
        op: "edit", id: "cell-1", expected_revision, body: ["x <- 999"], type: "code",
      });
      assert.equal(invalid.status, 400, String(expected_revision));
    }
    assert.equal(app.controller.commands.size, commandCount, "invalid revisions must not reach the controller");
    const edited = await post(app.origin, "/api/cell", { op: "edit", id: "cell-1", expected_revision: 0, body: ["x <- 2"], type: "code" });
    assert.equal((await edited.json() as { revision: number }).revision, 1);
    const runtime = await post(app.origin, "/api/runtime", { execution_mode: "lazy" });
    assert.deepEqual(await runtime.json(), { ok: true, execution_mode: "lazy", run_on_startup: false, version: 4 });
    const saved = await fetch(`${app.origin}/api/save`, { method: "POST" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { etag: string }).etag, "etag-1");
    assert.equal((await fetch(`${app.origin}/api/save`, { method: "POST", body: "{}" })).status, 400);

    assert.equal((await post(app.origin, "/api/run", { cell: "cell-1", extra: true })).status, 400);
    const media = await fetch(`${app.origin}/api/run`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(media.status, 415);
    const checked = await post(app.origin, "/api/check", {});
    const checkBody = await checked.json() as { diagnostics: Array<{ cell: string; code: string }> };
    assert.deepEqual(checkBody.diagnostics.map(({ cell, code }) => ({ cell, code })), [{ cell: "cell-1", code: "style" }]);
  } finally {
    await app.close();
  }
});

test("client logs are strictly shaped, byte bounded, and collapsed to one physical line", async () => {
  const app = await fixture();
  const originalWrite = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const response = await post(app.origin, "/api/log", {
      level: "error\r\nforged-level",
      message: "head\r\nforged-message",
      source: "window.error\nforged-source",
      status: 503,
      stack: "line 1\nline 2",
    });
    assert.deepEqual(await response.json(), { ok: true, logged: true });
    assert.equal(captured.split("\n").filter(Boolean).length, 1);
    assert.match(captured, /^\[client:error forged-level\] head forged-message \| source=window\.error forged-source status=503 stack=line 1 line 2\n$/);
    for (const invalid of [
      { level: "error", message: "x", extra: 1 },
      { level: "error", message: null },
      { level: "error", message: "x", source: null },
      { level: "error", message: "x", status: 99 },
      { level: "error", message: "x", status: 503.5 },
      { level: "error", message: "x".repeat(8193) },
    ]) {
      assert.equal((await post(app.origin, "/api/log", invalid)).status, 400);
    }
  } finally {
    process.stderr.write = originalWrite;
    await app.close();
  }
});

test("package installation accepts promptly while export waits for its exact operation", async () => {
  const app = await fixture();
  try {
    const installation = await Promise.race([
      post(app.origin, "/api/packages", { op: "install", packages: "tidyr" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("install response blocked on the job")), 250)),
    ]);
    assert.equal(installation.status, 202);
    assert.deepEqual(await installation.json(), {
      ok: true, packages: ["tidyr"], installed: [], missing: [], installing: ["tidyr"],
    });
    const whileInstalling = await (await fetch(`${app.origin}/api/state`)).json() as { packages: { installing: string[] } };
    assert.deepEqual(whileInstalling.packages.installing, ["tidyr"]);
    app.controller.finishInstall();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterInstall = await (await fetch(`${app.origin}/api/state`)).json() as { packages: { installing: string[]; installed: string[] } };
    assert.deepEqual(afterInstall.packages.installing, []);
    assert.deepEqual(afterInstall.packages.installed, ["dplyr", "tidyr"]);

    const exported = await post(app.origin, "/api/export", { format: "html", include_code: false });
    assert.equal(exported.status, 200);
    assert.deepEqual(await exported.json(), { ok: true, download: "/download/export.html", format: "html" });
  } finally {
    await app.close();
  }
});
