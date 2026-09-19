import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import assert from "node:assert/strict";
import test from "node:test";

import { Controller, ControllerError, type ControllerOptions, type SourcePublication } from "../src/controller.js";
import { parseNotebook, serializeNotebook } from "../src/notebook.js";
import { preferenceDefaults, resolveSettings } from "../src/settings.js";
import { OutputStore } from "../src/outputs.js";
import type { DiagnosticFields, DiagnosticSeverity, DiagnosticSink } from "../src/diagnostics.js";
import {
  MAX_DEPENDENCY_EDGES,
  MAX_NOTEBOOK_SOURCE_BYTES,
} from "../src/protocol.js";
import type {
  AnalysisResult,
  CellSnapshot,
  EngineAdapter,
  EngineEvent,
  EngineHandshake,
  EngineRequestOptions,
  REnvironment,
  EngineResponse,
  EvaluationPayload,
  HostCommand,
  OutputRecord,
  RichOutputPayload,
  HostEvent,
} from "../src/protocol.js";

const HANDSHAKE: EngineHandshake = {
  protocol: "alder-engine-v2",
  packageVersion: "test",
  rVersion: "test",
  capabilities: ["analysis", "evaluation", "streaming", "interrupt"],
  kernel: {
    name: "ark",
    version: "test",
    protocol: "ark-protocol-v2",
    kernelEpoch: "kernel-test",
  },
  kernelReady: true,
  analyzerReady: true,
  captureReady: true,
};

interface PendingEvaluation {
  requestId: number;
  payload: EvaluationPayload;
  onEvent?: (event: EngineEvent) => void;
  resolve: (response: EngineResponse) => void;
  sequence: number;
}

class FakeEngine implements EngineAdapter {
  readonly analysisCalls: CellSnapshot[][] = [];
  readonly evaluations: EvaluationPayload[] = [];
  readonly interrupts: Array<number | undefined> = [];
  readonly requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
  readonly requestSignals = new Map<string, AbortSignal | undefined>();
  readonly pendingEvaluations: PendingEvaluation[] = [];
  readonly failureListeners = new Set<(role: "kernel" | "analyzer" | "services", error: Error) => void>();
  private outputStore: OutputStore | undefined;
  deferred = false;
  handshake: EngineHandshake = HANDSHAKE;
  startCount = 0;
  restartCount = 0;
  startHandler: () => Promise<EngineHandshake> = async () => this.handshake;
  restartHandler: () => Promise<EngineHandshake> = async () => this.handshake;
  requestHandler: (command: string, payload: Record<string, unknown>) => Promise<EngineResponse>
    = async () => ({ ok: true });
  evaluationHandler: (payload: EvaluationPayload) => EngineResponse | Promise<EngineResponse>
    = (payload) => this.rawResponseFor(payload);
  private requestId = 0;

  setOutputStore(store: OutputStore): void {
    this.outputStore = store;
  }

  rawResponseFor(payload: EvaluationPayload): EngineResponse {
    return evaluationResponse(payload.source, payload);
  }


  onFailure(listener: (role: "kernel" | "analyzer" | "services", error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async start(): Promise<EngineHandshake> {
    this.startCount += 1;
    return this.startHandler();
  }

  async analyze(cells: readonly CellSnapshot[], revision: number): Promise<AnalysisResult> {
    this.analysisCalls.push(cells.map((cell) => structuredClone(cell)));
    return {
      revision,
      analysisEnvironmentId: "analysis-test",
      analyzer: { packageVersion: "test", rVersion: "test", policy: "test", analysisEnvironmentId: "analysis-test" },
      cells: cells.map((cell) => analyzeCell(cell)),
    };
  }

  async evaluate(
    payload: EvaluationPayload,
    onEvent?: (event: EngineEvent) => void,
  ): Promise<EngineResponse> {
    this.evaluations.push(structuredClone(payload));
    const requestId = ++this.requestId;
    onEvent?.({
      type: "started",
      requestId,
      sessionEpoch: payload.sessionEpoch,
      kernelEpoch: payload.kernelEpoch,
      documentRevision: payload.documentRevision,
      operationId: payload.operationId,
      runId: payload.runId,
      cellId: payload.cellId,
      revision: payload.revision,
      sequence: 0,
    });
    if (this.deferred) {
      return new Promise<EngineResponse>((resolve) => {
        this.pendingEvaluations.push({ requestId, payload, onEvent, resolve, sequence: 0 });
      });
    }
    const response = this.canonicalizeResponse(payload, await this.evaluationHandler(payload));
    onEvent?.({
      type: "completed",
      requestId,
      sessionEpoch: payload.sessionEpoch,
      kernelEpoch: payload.kernelEpoch,
      documentRevision: payload.documentRevision,
      operationId: payload.operationId,
      runId: payload.runId,
      cellId: payload.cellId,
      revision: payload.revision,
      sequence: 1,
      result: response,
    });
    return response;
  }

  finishEvaluation(response?: EngineResponse): void {
    const pending = this.pendingEvaluations.shift();
    assert.ok(pending, "an evaluation must be pending");
    const result = this.canonicalizeResponse(pending.payload, response ?? this.rawResponseFor(pending.payload));
    pending.onEvent?.({
      type: "completed",
      requestId: pending.requestId,
      sessionEpoch: pending.payload.sessionEpoch,
      kernelEpoch: pending.payload.kernelEpoch,
      documentRevision: pending.payload.documentRevision,
      operationId: pending.payload.operationId,
      runId: pending.payload.runId,
      cellId: pending.payload.cellId,
      revision: pending.payload.revision,
      sequence: ++pending.sequence,
      result,
    });
    pending.resolve(result);
  }

  finishEvaluationWithCanonicalResponse(result: EngineResponse): void {
    const pending = this.pendingEvaluations.shift();
    assert.ok(pending, "an evaluation must be pending");
    pending.onEvent?.({
      type: "completed", requestId: pending.requestId, sessionEpoch: pending.payload.sessionEpoch,
      kernelEpoch: pending.payload.kernelEpoch, documentRevision: pending.payload.documentRevision,
      operationId: pending.payload.operationId, runId: pending.payload.runId, cellId: pending.payload.cellId,
      revision: pending.payload.revision, sequence: ++pending.sequence, result,
    });
    pending.resolve(result);
  }

  emitEvaluationLog(payload: unknown): void {
    this.emitEvaluationOutput("log", payload);
  }

  emitEvaluationOutput(
    kind: Extract<EngineEvent, { type: "output" }>["kind"],
    payload: unknown,
  ): OutputRecord | undefined {
    const pending = this.pendingEvaluations[0];
    assert.ok(pending, "an evaluation must be pending");
    const eventPayload = kind === "append"
      ? { output: this.canonicalRecord(pending.payload, isRecord(payload) && "output" in payload ? payload.output : payload) }
      : payload;
    pending.onEvent?.({
      type: "output",
      requestId: pending.requestId,
      sessionEpoch: pending.payload.sessionEpoch,
      kernelEpoch: pending.payload.kernelEpoch,
      documentRevision: pending.payload.documentRevision,
      operationId: pending.payload.operationId,
      runId: pending.payload.runId,
      cellId: pending.payload.cellId,
      revision: pending.payload.revision,
      sequence: ++pending.sequence,
      kind,
      payload: eventPayload,
    });
    return kind === "append" && isRecord(eventPayload) && "output" in eventPayload
      ? eventPayload.output as OutputRecord : undefined;
  }
  private canonicalRecord(payload: EvaluationPayload, value: unknown): OutputRecord {
    const store = this.outputStore;
    assert.ok(store, "FakeEngine must share the Controller OutputStore");
    return canonicalFixtureRecord(store, payload, value);
  }

  private canonicalizeResponse(payload: EvaluationPayload, response: EngineResponse): EngineResponse {
    if (response.outputs === undefined) return response;
    return { ...response, outputs: response.outputs.map((output) => this.canonicalRecord(payload, output)) };
  }

  async replaceCanonicalRecord(expected: OutputRecord, payload: RichOutputPayload): Promise<OutputRecord> {
    assert.ok(this.outputStore, "FakeEngine must share the Controller OutputStore");
    return this.outputStore.updateRecord(expected, payload);
  }

  async request(command: string, payload: Record<string, unknown> = {}, options?: EngineRequestOptions): Promise<EngineResponse> {
    this.requests.push({ command, payload: structuredClone(payload) });
    this.requestSignals.set(command, options?.signal);
    return this.requestHandler(command, payload);
  }
  async interrupt(requestId?: number): Promise<{ requested: boolean; requestId?: number }> {
    this.interrupts.push(requestId);
    return requestId === undefined ? { requested: true } : { requested: true, requestId };
  }

  async restart(): Promise<EngineHandshake> {
    this.restartCount += 1;
    return this.restartHandler();
  }

  async close(): Promise<void> {}
}

type FixtureControllerOptions = Omit<ControllerOptions, "outputStore"> & { outputStore?: OutputStore };

class CollectingDiagnostics implements DiagnosticSink {
  readonly events: Array<{ severity: DiagnosticSeverity; event: string; fields: DiagnosticFields }> = [];
  record(severity: DiagnosticSeverity, event: string, fields: DiagnosticFields = {}): void { this.events.push({ severity, event, fields }); }
  child(_fields: DiagnosticFields): DiagnosticSink { return this; }
}

function createController(options: FixtureControllerOptions): Controller {
  const sessionEpoch = options.epoch ?? randomUUID();
  const fixtureArtifactDirectory = options.outputStore === undefined
    ? join(tmpdir(), `alder-controller-test-${randomUUID()}`)
    : undefined;
  const outputStore = options.outputStore ?? new OutputStore({
    artifactDirectory: fixtureArtifactDirectory!,
    sessionEpoch,
    documentRevision: options.initialDocumentRevision ?? 0,
    kernelEpoch: HANDSHAKE.kernel.kernelEpoch,
  });
  if (options.engine instanceof FakeEngine) options.engine.setOutputStore(outputStore);
  return new Controller({ ...options, epoch: sessionEpoch, outputStore });
}
function analyzeCell(cell: CellSnapshot) {
  const definitions = [...cell.source.matchAll(/([A-Za-z.][A-Za-z0-9_.]*)\s*<-/g)]
    .map((match) => match[1] as string);
  const rightSides = [...cell.source.matchAll(/<-([^\n]*)/g)].map((match) => match[1] ?? "").join(" ");
  const references = [...rightSides.matchAll(/[A-Za-z.][A-Za-z0-9_.]*/g)]
    .map((match) => match[0] as string)
    .filter((name) => !definitions.includes(name) && !["TRUE", "FALSE", "library"].includes(name));
  return {
    id: cell.id,
    revision: cell.revision,
    defs: [...new Set(definitions)],
    refs: [...new Set(references)],
    selfRefs: [],
    diagnostics: [],
    error: null,
  };
}

function canonicalFixtureRecord(store: OutputStore, payload: EvaluationPayload, value: unknown): OutputRecord {
  const record = store.ingestAlder(value, {
    sessionEpoch: payload.sessionEpoch,
    documentRevision: payload.documentRevision,
    kernelEpoch: payload.kernelEpoch,
    runId: payload.runId,
    cellId: payload.cellId,
    revision: payload.revision,
  }, { presentation: "inline" });
  assert.ok(!(record instanceof Promise), "controller fixtures must use synchronous canonical outputs");
  return record;
}

function evaluationResponse(source: string, payload: EvaluationPayload): EngineResponse {
  if (source.includes("make_lazy")) {
    return {
      ok: true,
      outputs: [{ kind: "lazy", key: "lazy-1", label: "lazy", state: "pending", child: null }],
      log: [],
    };
  }
  if (source.includes("make_table")) {
    return {
      ok: true,
      outputs: [{
        kind: "table",
        nrow: 1,
        ncol: 1,
        columns: ["x"],
        preview: [[1]],
        offset: 0,
        limit: 25,
        sort_by: "",
        sort_desc: false,
        filter: "",
        truncated_rows: false,
        truncated_columns: false,
        handle: "table-1",
      }],
      log: [],
    };
  }
  if (source.includes("ui$array") && source.includes("ui$button")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "controls",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: {
          kind: "array",
          value: { go: false, level: 5 },
          children: [
            { name: "go", kind: "run_button", value: false },
            { name: "level", kind: "slider", value: 5, min: 0, max: 10, step: 1 },
          ],
        },
      }],
      log: [],
    };
  }
  if (source.includes("ui$file")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "files",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: { kind: "file", value: [], multiple: false },
      }],
      log: [],
    };
  }
  if (source.includes("ui$button") && !source.includes("counter_boundary")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "btn",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: { kind: "run_button", value: false },
      }],
      log: [],
    };
  }
  if (source.includes("ui$slider")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "threshold",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: { kind: "slider", value: 2, min: 0, max: 10, step: 1 },
      }],
      log: [],
    };
  }
  if (source.includes("ui$date_range")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "dates",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: {
          kind: "date_range",
          value: ["2026-09-01", "2026-09-03"],
          min: "2026-09-01",
          max: "2026-09-30",
        },
      }],
      log: [],
    };
  }
  if (source.includes("ui$button")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "counter",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: { kind: "button", value: 0 },
      }],
      log: [],
    };
  }
  if (source.includes("ui$datetime")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "stamp",
        owner: payload.cellId,
        path: [],
        commit_token: null,
        operation: null,
        spec: {
          kind: "datetime",
          value: "2026-09-03T16:00:00Z",
          min: "2026-09-03T15:00:00Z",
          max: "2026-09-03T18:00:00Z",
        },
      }],
      log: [],
    };
  }
  return { ok: true, outputs: [{ kind: "text", text: source, truncated: false }], log: [] };
}

function notebook(lines: Array<[string, string]>) {
  return {
    path: "/tmp/test.R",
    metadata: {},
    cells: lines.map(([id, source]) => ({
      id,
      type: "code" as const,
      body: [source],
      options: {},
      revision: 0,
    })),
  };
}

let operationCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedNotebook(source: string) {
  return parseNotebook(new TextEncoder().encode(source), "/tmp/test.R");
}

function reactiveExample(name: string) {
  return parseNotebook(readFileSync(new URL(`../../dev/examples/${name}`, import.meta.url)), `/tmp/${name}`);
}

function serializedNotebookBytes(controller: Controller): Uint8Array {
  return serializeNotebook(controller.notebookDocument());
}

function serializedNotebook(controller: Controller): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(serializedNotebookBytes(controller));
}

function mixedPhysicalSource(): string {
  return "\ufeff# title\r\n# noncanonical header\r\n# %%\r#| foo: one\r#| foo: two\rx <- 1\n# %% markdown\n#| bar: two\nbody";
}
function command<T extends Record<string, unknown>>(
  controller: Controller,
  value: T,
): HostCommand {
  const input = value as Record<string, unknown>;
  const requestId = "request-" + (++operationCounter);
  const clientId = "controller-tests";
  const identity = {
    requestId,
    clientId,
    sessionEpoch: controller.epoch,
  };
  const expectedDocumentRevision = controller.snapshot().documentRevision;
  const type = input.type;
  const normalized = { ...input, ...identity } as Record<string, unknown>;
  if (["transaction", "run", "set-config", "set-layout", "set-runtime", "format", "publish", "save", "save-as", "reload-source", "set-app"].includes(String(type))
    && normalized.expectedDocumentRevision === undefined) {
    normalized.expectedDocumentRevision = expectedDocumentRevision;
  }
  if ((type === "set-config" || type === "set-layout") && normalized.expectedSidecarVersion === undefined) {
    normalized.expectedSidecarVersion = null;
  }
  if (["widget", "inspect", "lazy-output", "table-page"].includes(String(type))
    && normalized.kernelEpoch === undefined) {
    normalized.kernelEpoch = controller.snapshot().runtime.kernelEpoch;
  }
  if (type === "widget" && normalized.expectedRevision === undefined) {
    normalized.expectedRevision = controller.snapshot().cells.find((cell) =>
      cell.outputs.some((output) => JSON.stringify(output).includes(String(normalized.name))),
    )?.revision ?? 0;
  }
  return normalized as HostCommand;
}

// Controlled-engine tests deliberately leave commands running so they can inject
// outputs, edits and interrupts. Public completion behavior is tested below.
function startCommand(controller: Controller, request: HostCommand): Promise<HostCommand> {
  void controller.dispatch(request).catch((error: unknown) => { assert.fail(String(error)); });
  return Promise.resolve(request);
}

async function settle(controller: Controller, id: string, clientId = "controller-tests") {
  const operation = await controller.awaitOperation(id, clientId);
  assert.equal(operation.status, "done", operation.error?.message);
  return operation;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

async function eventuallyTimed(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}


test("shutdown requires the complete active client set", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  const events: Array<{ type: string; payload: unknown }> = [];
  const unsubscribe = controller.subscribe(event => events.push(event));
  try {
    controller.registerClient("controller-tests");
    const first = command(controller, { type: "shutdown", expectedDocumentRevision: controller.snapshot().documentRevision, expectedClientIds: ["controller-tests"] });
    const firstStartedPromise = startCommand(controller, first);
    controller.registerClient("other-client");
    const firstStarted = await firstStartedPromise;

    const failed = await controller.awaitOperation(first.requestId, "controller-tests");
    assert.equal(failed.status, "error");
    assert.equal(failed.error?.code, "active_clients_changed");

    controller.releaseClient("other-client");
    const second = command(controller, { type: "shutdown", expectedDocumentRevision: controller.snapshot().documentRevision, expectedClientIds: ["controller-tests"] });
    const secondStarted = await startCommand(controller, second);

    const completed = await controller.awaitOperation(second.requestId, "controller-tests");
    assert.equal(completed.status, "done");
    assert.deepEqual(completed.result, { closing: true, expectedClientIds: ["controller-tests"] });
    assert.ok(events.some(event => event.type === "active_clients_changed"));
  } finally {
    unsubscribe();
    await controller.close();
  }
});

test("source edits commit before runtime startup and survive startup failure", async () => {
  const engine = new FakeEngine();
  let failStart!: (error: Error) => void;
  const startGate = new Promise<EngineHandshake>((_resolve, reject) => { failStart = reject; });
  engine.startHandler = () => startGate;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      const document = request.document ?? context.document;
      context.preparePublication({
        document,
        path: document.path ?? context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: true,
        advanceRevision: true,
      })();
      return { documentRevision: context.fromRevision + 1 };
    },
  });
  const startPromise = controller.start();
  await eventually(() => engine.startCount === 1);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  const started = await startCommand(controller, edit);

  await settle(controller, edit.requestId);
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 2"]);
  assert.equal(controller.snapshot().runtime.documentReady, true);
  assert.equal(controller.snapshot().runtime.executionReady, false);
  assert.equal(controller.snapshot().lastActionError?.code, "analysis_unavailable");
  failStart(new Error("R runtime unavailable"));
  await assert.rejects(startPromise, (error: unknown) => (
    error instanceof ControllerError && error.code === "engine_start_failed"
  ));
  const afterFailure = controller.snapshot();
  assert.deepEqual(afterFailure.cells[0]?.body, ["x <- 2"]);
  assert.equal(afterFailure.documentRevision, 1);
  assert.equal(afterFailure.runtime.documentReady, true);
  await controller.close();
});

test("deferred startup reaches readiness without executing source", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: true } }),
    deferStartup: true,
  });
  const ready = await controller.start();
  assert.equal(ready.runtime.executionReady, true);
  assert.equal(engine.evaluations.length, 0);
  const startup = await controller.activateStartup();
  assert.ok(startup);
  await settle(controller, startup.id, "internal");
  assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a"]);
  assert.equal(await controller.activateStartup(), null);
  await controller.close();
});

test("no-run suppresses this opening's startup without changing settings or explicit Run", async () => {
  for (const startupPath of ["activation", "command"] as const) {
    const engine = new FakeEngine();
    const controller = createController({
      engine,
      notebook: { ...notebook([["a", "x <- 1"]]), metadata: { runtime: { on_startup: true } } },
      config: resolveSettings({ notebook: { on_startup: true } }),
      suppressStartup: true,
      deferStartup: startupPath === "command",
    });
    try {
      await controller.start();
      const before = controller.snapshot();
      assert.equal(engine.evaluations.length, 0);
      if (startupPath === "activation") {
        assert.equal(await controller.activateStartup(), null);
      } else {
        const startup = await controller.dispatch(command(controller, { type: "run", scope: "all", startup: true }));
        assert.equal(startup.error, null);
      }
      const suppressed = controller.snapshot();
      assert.equal(engine.evaluations.length, 0);
      assert.equal(suppressed.runtime.runOnStartup, true);
      assert.equal(suppressed.config.on_startup, true);
      assert.deepEqual(suppressed.metadata, { runtime: { on_startup: true } });
      assert.deepEqual(suppressed.config, before.config);
      assert.equal(suppressed.documentRevision, before.documentRevision);
      assert.equal(suppressed.dirty, before.dirty);

      const explicit = await controller.dispatch(command(controller, { type: "run", scope: "all" }));
      assert.equal(explicit.error, null);
      assert.deepEqual(engine.evaluations.map(evaluation => evaluation.cellId), ["a"]);
      assert.equal(controller.snapshot().cells[0]?.status, "done");
      assert.equal(controller.snapshot().runtime.runOnStartup, true);
      assert.deepEqual(controller.snapshot().metadata, before.metadata);
      assert.deepEqual(controller.snapshot().config, before.config);
    } finally { await controller.close(); }
  }
});

test("event filters preserve subscriber isolation", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const cursor = controller.cursor;
  const selected: HostEvent[] = [], all: HostEvent[] = [];
  const types: HostEvent["type"][] = ["cell-completed"];
  const unsubscribe = controller.subscribe(event => {
    selected.push(event);
    (event.payload as { body: string[] }).body.push("subscriber mutation");
  }, types);
  types.length = 0;
  controller.subscribe(event => all.push(event));
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  assert.deepEqual(selected.map(event => event.type), ["cell-completed"]);
  assert.deepEqual(selected.map(event => event.cursor),
    all.filter(event => event.type === "cell-completed").map(event => event.cursor));
  assert.ok(all.some(event => event.type === "cell-started"));
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 1"]);
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 1"]);
  unsubscribe();
  await controller.close();
  assert.equal(selected.length, 1);
});

test("concurrent startup shares one engine lifecycle", async () => {
  const engine = new FakeEngine();
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  engine.startHandler = async () => {
    await startGate;
    return engine.handshake;
  };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  const first = controller.start();
  const second = controller.start();
  assert.equal(engine.startCount, 1);
  assert.equal(controller.snapshot().runtime.analyzerState, "starting");
  assert.equal(controller.snapshot().runtime.kernelState, "starting");
  releaseStart();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.equal(engine.startCount, 1);
  assert.equal(firstSnapshot.epoch, secondSnapshot.epoch);
  await controller.close();
});

test("source edits remain usable during an explicit restart", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  let releaseRestart!: () => void;
  const restartGate = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  engine.restartHandler = async () => {
    await restartGate;
    return engine.handshake;
  };
  const restart = command(controller, { type: "restart", replay: false });
  const restarting = startCommand(controller, restart);
  await eventually(() => engine.restartCount === 1);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  const editStarted = await startCommand(controller, edit);
  const editOperation = await controller.awaitOperation(editStarted.requestId, "controller-tests");
  assert.equal(editOperation.status, "done");
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 2"]);
  releaseRestart();
  await restarting;
  await controller.awaitOperation(restart.requestId, "controller-tests");
  assert.equal(engine.restartCount, 1);
  await controller.close();
});

test("explicit restart waits for an admitted source commit", async () => {
  const engine = new FakeEngine();
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let commitEntered = false;
  const controller = createController({
    engine, notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      commitEntered = true;
      await commitGate;
      const document = request.document ?? context.document;
      context.preparePublication({
        document, path: document.path ?? context.path, config: context.config,
        layout: context.layout, disk: context.disk, sidecars: context.sidecars,
        dirty: true, advanceRevision: true,
      })();
    },
  });
  await controller.start();
  let releaseRestart!: () => void;
  const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
  engine.restartHandler = async () => { await restartGate; return engine.handshake; };
  try {
    const edit = command(controller, {
      type: "transaction", changes: [{ type: "edit", cell: { cellId: "a" },
        expectedRevision: 0, body: ["x <- 2"], cellType: "code" }],
    });
    const editStarted = await startCommand(controller, edit);
    await eventually(() => commitEntered);
    const restart = command(controller, { type: "restart", replay: false });
    const restartStarted = await startCommand(controller, restart);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(engine.restartCount, 0);
    releaseCommit();
    assert.equal((await controller.awaitOperation(editStarted.requestId, "controller-tests")).status, "done");
    await eventually(() => engine.restartCount === 1);
    releaseRestart();
    assert.equal((await controller.awaitOperation(restartStarted.requestId, "controller-tests")).status, "done");
    assert.equal(controller.snapshot().runtime.analyzerState, "ready");
  } finally {
    releaseCommit();
    releaseRestart();
    await controller.close();
  }
});

test("R environment selection rebuilds analysis before readiness", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const before = engine.analysisCalls.length;
  const environment: REnvironment = {
    rscript: "/tmp/Rscript", rHome: "/tmp/R", version: "4.6.0",
    platform: "linux", arch: "x64", libraryPaths: ["/tmp/library"], identity: "b".repeat(64),
  };
  await controller.restartRuntimeContext({ environment }, "select-r-analysis");
  assert.equal(engine.analysisCalls.length, before + 1);
  assert.deepEqual(controller.snapshot().runtime.rEnvironment, environment);
  assert.equal(controller.snapshot().runtime.analyzerState, "ready");
  assert.equal(controller.snapshot().cells[0]?.analysisPending, false);
  await controller.close();
});

test("closing during restart cannot resurrect runtime readiness", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  let releaseRestart!: () => void;
  const restartGate = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  engine.restartHandler = async () => {
    await restartGate;
    return engine.handshake;
  };
  const restart = command(controller, { type: "restart", replay: false });
  const restarting = startCommand(controller, restart);
  await eventually(() => engine.restartCount === 1);
  await controller.close();
  const closedOperation = await controller.awaitOperation(restart.requestId, "controller-tests");
  assert.equal(closedOperation.status, "error");
  assert.equal(closedOperation.error?.code, "session_stopped");
  releaseRestart();
  await restarting;
  await new Promise((resolve) => setImmediate(resolve));
  const closed = controller.snapshot();
  assert.equal(closed.runtime.executionReady, false);
  assert.notEqual(closed.runtime.kernelState, "ready");
  assert.notEqual(closed.runtime.analyzerState, "ready");
});

test("optional service-peer failure leaves analysis and execution available", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event));
  for (const listener of engine.failureListeners) {
    listener("services", new Error("optional service peer exited"));
  }
  const afterFailure = controller.snapshot();
  assert.equal(afterFailure.runtime.executionReady, true);
  assert.equal(afterFailure.runtime.analyzerState, "ready");
  assert.equal(afterFailure.runtime.kernelState, "ready");
  assert.equal(afterFailure.lastActionError?.code, "service_unavailable");
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a"]);
  assert.equal(controller.snapshot().lastActionError, null);
  assert.ok(events.some((event) => event.type === "service-error" && event.payload === null));
  unsubscribe();
  await controller.close();
});

test("all edit preconditions are validated before any source mutation or engine effect", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const before = controller.snapshot();
  const edit = command(controller, {
    type: "run",
    scope: "all",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        },
        {
            type: "edit",
            cell: {
                cellId: "b"
            },
            expectedRevision: 9,
            body: ["y <- x + 1"],
            cellType: "code"
        }
    ]
  });
  const started = await startCommand(controller, edit);
  const rejected = await controller.awaitOperation(started.requestId, "controller-tests");
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error?.code, 'source_conflict');
  assert.deepEqual(
    controller.snapshot().cells.map((cell) => [cell.body, cell.revision]),
    before.cells.map((cell) => [cell.body, cell.revision]),
  );
  assert.equal(engine.evaluations.length, 0);
  assert.equal(engine.requests.filter((request) => request.command === "clear_cell").length, 0);
  await controller.close();
});

test("source events publish causal cell projections without replacing unchanged dependencies", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);

  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event));
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  await settle(controller, edit.requestId);
  const causal = events.filter((event) => event.operationId === edit.requestId);
  const transactionEvent = causal.find((event) => event.type === "transaction");
  assert.ok(transactionEvent);
  const transaction = transactionEvent?.payload as { documentRevision: number; updated: CellSnapshot[] };
  assert.equal(transaction.documentRevision, 1);
  assert.equal(transaction.updated.length, 1);
  assert.equal(transaction.updated[0]?.id, 'a');
  assert.equal(transaction.updated[0]?.revision, 1);
  assert.deepEqual(transaction.updated[0]?.body, ['x <- 2']);
  assert.equal(transaction.updated.some(cell => cell.id === 'b'), false);
  assert.deepEqual(controller.snapshot().cells.map((cell) => cell.status), ["stale", "stale"]);
  assert.ok(causal.every((event) => Number.isInteger(event.version)));
  unsubscribe();
  await controller.close();
});

test("Markdown-only formatting preserves authored source commits and clean no-op state", async () => {
  const engine = new FakeEngine();
  const durableCommits: Array<{ fromRevision: number; toRevision: number; delta: { edited: readonly { id: string; revision: number }[]; created: Readonly<Record<string, string>>; deleted: readonly string[] } }> = [];
  let formatCalls = 0;
  const controller = createController({
    engine,
    notebook: {
      path: "/tmp/markdown-format.R",
      metadata: {},
      cells: [{ id: "md", type: "markdown", body: ["# before"], options: {}, revision: 0 }],
    },
    config: resolveSettings({ notebook: { on_startup: false } }),
    durableCommit: async (commit) => {
      durableCommits.push(structuredClone(commit));
    },
    services: {
      format: async () => {
        formatCalls += 1;
        return {};
      },
    },
  });
  await controller.start();
  const cleanBefore = controller.snapshot();
  const cleanFormat = command(controller, {
    type: "format",
    cellIds: ["md"],
    expectedRevisions: { md: 0 },
  });
  await startCommand(controller, cleanFormat);
  const cleanResult = await settle(controller, cleanFormat.requestId);
  assert.deepEqual(cleanResult.result, { changed: 0, edited: [], created: [] });
  const cleanAfter = controller.snapshot();
  assert.equal(cleanAfter.documentRevision, cleanBefore.documentRevision);
  assert.equal(cleanAfter.dirty, cleanBefore.dirty);
  assert.deepEqual(cleanAfter.cells.map((cell) => ({ id: cell.id, body: cell.body, revision: cell.revision, status: cell.status, outputs: cell.outputs, outputsStale: cell.outputsStale })),
    cleanBefore.cells.map((cell) => ({ id: cell.id, body: cell.body, revision: cell.revision, status: cell.status, outputs: cell.outputs, outputsStale: cell.outputsStale })));
  assert.equal(formatCalls, 0);
  assert.equal(durableCommits.length, 0);

  const authored = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "md"
            },
            expectedRevision: 0,
            body: ["# authored"],
            cellType: "markdown"
        }
    ]
  });
  await startCommand(controller, authored);
  const authoredResult = await settle(controller, authored.requestId);
  assert.deepEqual(authoredResult.result, {
    created: {}, edited: [{ id: "md", revision: 1 }], deleted: [], documentRevision: 1,
  });
  assert.equal(durableCommits.length, 1);
  assert.deepEqual(durableCommits[0]?.delta.edited, [{ id: "md", revision: 1 }]);

  const dirtyBefore = controller.snapshot();
  const dirtyFormat = command(controller, {
    type: "format",
    cellIds: ["md"],
    expectedRevisions: { md: 1 },
  });
  await startCommand(controller, dirtyFormat);
  const dirtyResult = await settle(controller, dirtyFormat.requestId);
  assert.deepEqual(dirtyResult.result, { changed: 0, edited: [], created: [] });
  const dirtyAfter = controller.snapshot();
  assert.equal(dirtyAfter.documentRevision, dirtyBefore.documentRevision);
  assert.equal(dirtyAfter.dirty, dirtyBefore.dirty);
  assert.deepEqual(dirtyAfter.cells.map((cell) => ({ id: cell.id, body: cell.body, revision: cell.revision, status: cell.status, outputs: cell.outputs, outputsStale: cell.outputsStale })),
    dirtyBefore.cells.map((cell) => ({ id: cell.id, body: cell.body, revision: cell.revision, status: cell.status, outputs: cell.outputs, outputsStale: cell.outputsStale })));
  assert.equal(formatCalls, 0);
  assert.equal(durableCommits.length, 1);
  await controller.close();
});

test("source edit admitted during formatting rejects late candidate before durable commit", async () => {
  let formatEntered = false;
  let releaseFormatter: (value: Record<string, string[]>) => void = () => {};
  let signalFormatEntered: () => void = () => {};
  const formatterEntered = new Promise<void>((resolve) => {
    signalFormatEntered = resolve;
  });
  const formatGate = new Promise<Record<string, string[]>>((resolve) => {
    releaseFormatter = resolve;
  });
  const durableBytes: Uint8Array[] = [];
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    durableCommit: async ({ delta }) => {
      durableBytes.push(serializeNotebook(delta.document));
    },
    services: {
      format: async () => {
        formatEntered = true;
        signalFormatEntered();
        return formatGate;
      },
    },
  });
  await controller.start();
  try {
    const before = controller.snapshot();
    const format = command(controller, {
      type: "format",
      cellIds: ["a"],
      expectedRevisions: { a: 0 },
    });
    const formatStarted = await startCommand(controller, format);
    await formatterEntered;
    assert.equal(formatEntered, true);

    const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    const editStarted = await startCommand(controller, edit);
    const editOperation = await controller.awaitOperation(editStarted.requestId, "controller-tests");
    assert.equal(editOperation.status, "done", editOperation.error?.message);
    const afterEdit = controller.snapshot();
    assert.equal(afterEdit.documentRevision, before.documentRevision + 1);
    assert.deepEqual(afterEdit.cells[0]?.body, ["x <- 2"]);
    assert.equal(afterEdit.cells[0]?.revision, 1);
    assert.equal(durableBytes.length, 1);
    assert.deepEqual(durableBytes[0], serializedNotebookBytes(controller));

    releaseFormatter({ a: ["x <- 999"] });
    const formatOperation = await controller.awaitOperation(formatStarted.requestId, "controller-tests");
    assert.equal(formatOperation.status, "error");
    assert.equal(formatOperation.error?.code, "source_conflict");
    const afterLateFormat = controller.snapshot();
    assert.equal(afterLateFormat.documentRevision, afterEdit.documentRevision);
    assert.deepEqual(afterLateFormat.cells[0]?.body, afterEdit.cells[0]?.body);
    assert.equal(afterLateFormat.cells[0]?.revision, afterEdit.cells[0]?.revision);
    assert.equal(durableBytes.length, 1);
    assert.deepEqual(durableBytes[0], serializedNotebookBytes(controller));
  } finally {
    releaseFormatter({ a: ["x <- 999"] });
    await controller.close();
  }
});

test("optional operations reject only duplicates and cancel their owned work", async () => {
  const diagnostics = new CollectingDiagnostics();
  let formatAborted = false;
  let formatStarted!: () => void;
  const formatting = new Promise<void>((resolve) => { formatStarted = resolve; });
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    diagnostics,
    services: {
      format: async (_cells, context) => {
        assert.ok(context);
        formatStarted();
        return new Promise<Record<string, string[]>>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            formatAborted = true;
            reject(new Error("formatter stopped"));
          }, { once: true });
        });
      },
      service: async (name) => {
        if (name === "publish") return { published: true };
        throw new Error(`unexpected service: ${name}`);
      },
    },
  });
  await controller.start();
  const first = command(controller, { type: "format", cellIds: ["a"], expectedRevisions: { a: 0 } });
  await startCommand(controller, first);
  await formatting;

  const duplicate = command(controller, { type: "format", cellIds: ["a"], expectedRevisions: { a: 0 } });
  await startCommand(controller, duplicate);
  const duplicateOperation = await controller.awaitOperation(duplicate.requestId, "controller-tests");
  assert.equal(duplicateOperation.status, "error");
  assert.equal(duplicateOperation.error?.code, "operation_in_progress");

  const publish = command(controller, { type: "publish", includeCode: false });
  await startCommand(controller, publish);
  assert.equal((await controller.awaitOperation(publish.requestId, "controller-tests")).status, "done");

  const cancel = command(controller, { type: "cancel-operation", operationId: first.requestId });
  const cancelResult = await controller.dispatch(cancel);
  assert.equal(cancelResult.error, null);
  assert.deepEqual(cancelResult.result, { operationId: first.requestId, cancellationRequested: true });
  const cancelled = await controller.awaitOperation(first.requestId, "controller-tests");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error?.code, "cancelled");
  assert.equal(formatAborted, true);
  await eventually(() => diagnostics.events.some(item => item.event === "operation.cancelled" && item.fields.operationId === first.requestId));
  assert.ok(diagnostics.events.some(item => item.event === "operation.cancelled" && item.fields.operationId === first.requestId));
  assert.ok(diagnostics.events.some(item => item.event === "operation.failed" && item.fields.operationId === duplicate.requestId));
  assert.ok(diagnostics.events.some(item => item.event === "operation.settled" && item.fields.operationId === publish.requestId));
  await controller.close();
});

test("projected notebook bytes are rejected atomically before source or engine effects", async () => {
  const engine = new FakeEngine();
  const commentLine = `#${"x".repeat(512 * 1024 - 1)}`;
  const retainedLines = Array.from({ length: 30 }, () => commentLine);
  const replacementLines = Array.from({ length: 36 }, () => commentLine);
  assert.ok(
    new TextEncoder().encode(replacementLines.join("\n")).byteLength
      < MAX_NOTEBOOK_SOURCE_BYTES,
  );
  const controller = createController({
    engine,
    notebook: {
      path: "/tmp/bounded-source.R",
      metadata: {},
      cells: [
        { id: "a", type: "markdown", body: retainedLines, options: {}, revision: 0 },
        { id: "b", type: "markdown", body: retainedLines, options: {}, revision: 0 },
      ],
    },
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const before = controller.snapshot();
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "b"
            },
            expectedRevision: 0,
            body: replacementLines,
            cellType: "markdown"
        }
    ]
  });
  const editStarted = await startCommand(controller, edit);
  const editOperation = await controller.awaitOperation(editStarted.requestId, "controller-tests");
  assert.equal(editOperation.status, "error");
  assert.equal(editOperation.error?.code, "notebook_too_large");
  assert.deepEqual(
    controller.snapshot().cells.map((cell) => [cell.id, cell.revision, cell.body.length]),
    before.cells.map((cell) => [cell.id, cell.revision, cell.body.length]),
  );
  assert.equal(engine.analysisCalls.length, 0);
  assert.equal(engine.evaluations.length, 0);
  assert.equal(engine.requests.length, 0);
  await controller.close();
});

test("one command creates, reconciles, analyzes, and runs an optimistic cell", async () => {
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: notebook([]), config: resolveSettings({ notebook: { on_startup: false } }) });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        creationId: "focused-editor-1"
    },
    changes: [
        {
            type: "create",
            creationId: "focused-editor-1",
            after: null,
            body: ["answer <- 42"],
            cellType: "code",
            options: {}
        }
    ]
  });
  const accepted = await startCommand(controller, run);
  const resultOperation = await controller.awaitOperation(accepted.requestId, "controller-tests");
  const result = resultOperation.result as { created: Record<string, string> };
  assert.deepEqual(result.created, { "focused-editor-1": "focused-editor-1" });
  await settle(controller, run.requestId);
  assert.equal(controller.snapshot().cells[0]?.status, "done");
  assert.equal(engine.analysisCalls.at(-1)?.[0]?.id, "focused-editor-1");
  assert.equal(engine.evaluations[0]?.cellId, "focused-editor-1");
  await controller.close();
});

test("run diagnostics report causal host phases and mark empty execution phases not applicable", async () => {
  const diagnostics = new CollectingDiagnostics();
  const controller = createController({
    engine: new FakeEngine(), notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }), diagnostics,
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "all" });
  await controller.dispatch(run);
  await settle(controller, run.requestId);
  await eventually(() => diagnostics.events.some(item => item.event === "operation.settled" && item.fields.operationId === run.requestId));
  const events = diagnostics.events.filter(item => item.fields.operationId === run.requestId);
  const phases = events.filter(item => item.event === "operation.phase").map(item => item.fields.phase);
  assert.deepEqual(phases, ["analysis-ready", "kernel-dispatch", "kernel-completion", "authoritative-completion"]);
  assert.ok(events.every(item => item.fields.clientId === "controller-tests"));
  assert.ok(events.find(item => item.event === "operation.settled"));
  await controller.close();

  const emptyDiagnostics = new CollectingDiagnostics();
  const empty = createController({
    engine: new FakeEngine(), notebook: notebook([]),
    config: resolveSettings({ notebook: { on_startup: false } }), diagnostics: emptyDiagnostics,
  });
  await empty.start();
  const emptyRun = command(empty, { type: "run", scope: "all" });
  await empty.dispatch(emptyRun);
  await settle(empty, emptyRun.requestId);
  await eventually(() => emptyDiagnostics.events.some(item => item.event === "operation.settled" && item.fields.operationId === emptyRun.requestId));
  const terminal = emptyDiagnostics.events.find(item => item.event === "operation.settled" && item.fields.operationId === emptyRun.requestId);
  assert.deepEqual(terminal?.fields.notApplicablePhases, ["first-output", "kernel-dispatch", "kernel-completion"]);
  assert.ok(emptyDiagnostics.events.some(item => item.event === "operation.phase" && item.fields.operationId === emptyRun.requestId && item.fields.phase === "authoritative-completion"));
  await empty.close();
});

test("body edits rebuild current static facts while execution waits for replacement analysis", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"], ["c", "z <- y"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const events: HostEvent[] = [];
  controller.subscribe((event) => events.push(event));
  const analyze = engine.analyze.bind(engine);
  let releaseAnalysis: (() => void) | undefined;
  engine.analyze = async (...args) => {
    await new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    return analyze(...args);
  };
  await startCommand(controller, command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  }));
  await eventually(() => releaseAnalysis !== undefined);
  assert.deepEqual(controller.snapshot().graph.edges, { a: [], b: [], c: ["b"] });
  const sourceTransaction = events.find((event) => event.type === 'transaction');
  assert.ok(sourceTransaction);
  assert.deepEqual((sourceTransaction.payload as { graph: { edges: Record<string, string[]> } }).graph.edges,
    { a: [], b: [], c: ["b"] });
  assert.equal(controller.snapshot().cells[0]?.analysisPending, true);
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  const accepted = startCommand(controller, run);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(engine.evaluations.length, 0);
  releaseAnalysis!();
  await accepted;
  await settle(controller, run.requestId);
  assert.deepEqual(engine.analysisCalls.at(-1)?.map((cell) => cell.id), ['a']);
  assert.equal(engine.evaluations[0]?.source, "x <- 2");
  assert.equal(engine.evaluations[0]?.revision, 1);
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a", "b", "c"]);
  assert.equal(events.filter((event) => event.type === "graph").length, 1);

  engine.analyze = analyze;
  const edit2 = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 1,
            body: ["other <- 3"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit2);
  await settle(controller, edit2.requestId);
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  assert.deepEqual(controller.snapshot().graph.edges.b, []);
  assert.equal(events.filter((event) => event.type === "graph").length, 2);
  assert.ok(events.findIndex((event) => event.type === "graph") < events.findLastIndex((event) =>
    event.type === "cell" && event.cellId === "a" && event.revision === 2
      && (event.payload as { analysisPending: boolean }).analysisPending === false));
  await controller.close();
});

test("serial scheduling follows dependency order and blocks disabled descendants", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"], ["c", "z <- y"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const events: HostEvent[] = [];
  controller.subscribe((event) => events.push(event));
  const first = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, first);
  await settle(controller, first.requestId);
  assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a", "b", "c"]);
  assert.equal(events.filter((event) => event.type === "operation"
    && (event.payload as { status?: string }).status === "running").length, 1);
  assert.deepEqual(events.filter((event) => event.type === "cell-started").map((event) => event.cellId), ["a", "b", "c"]);
  const startedAt = events.findIndex((event) => event.type === "cell-started");
  const completedAt = events.findLastIndex((event) => event.type === "cell-completed");
  assert.ok(events.slice(startedAt, completedAt).filter((event) => event.type === "runtime")
    .every((event) => (event.payload as HostSnapshot["runtime"]).busy), "a continuing chain must not advertise idle between cells");
  await eventually(() => (events.findLast((event) => event.type === "runtime")?.payload as HostSnapshot["runtime"])?.busy === false);
  const runtimeEvents = events.filter((event) => event.type === "runtime");
  assert.equal((runtimeEvents[0]?.payload as HostSnapshot["runtime"]).activeRunId, engine.evaluations[0]?.runId);
  assert.equal((runtimeEvents.at(-1)?.payload as HostSnapshot["runtime"]).busy, false);

  const disable = command(controller, {
    type: "transaction",
    changes: [
      {
        type: "options",
        cell: { cellId: "b" },
        expectedRevision: 0,
        patch: { disabled: true },
      },
    ],
  });
  const disableStarted = await startCommand(controller, disable);
  await controller.awaitOperation(disableStarted.requestId, "controller-tests");
  const second = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, second);
  await settle(controller, second.requestId);
  assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a", "b", "c", "a"]);
  assert.deepEqual(events.filter((event) => event.type === "runtime"
    && (event.payload as HostSnapshot["runtime"]).busy)
    .map((event) => (event.payload as HostSnapshot["runtime"]).activeRunId),
  [engine.evaluations[0]?.runId, engine.evaluations[3]?.runId]);
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "b")?.status, "disabled");
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "c")?.status, "stale");
  await controller.close();
});

test("a scalar chain edit and run needs no separate binding cleanup", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: notebook([["a", "x <- 1"], ["b", "y <- x + 1"], ["c", "z <- y + 1"]]), config: resolveSettings({ notebook: { on_startup: false } }),
  });
  try {
    await controller.start();
    const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
    });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    const edited = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    await startCommand(controller, edited);
    await settle(controller, edited.requestId);
    assert.deepEqual(engine.evaluations.map((item) => item.source),
      ["x <- 1", "y <- x + 1", "z <- y + 1", "x <- 2", "y <- x + 1", "z <- y + 1"]);
    assert.deepEqual(engine.requests.filter((item) => item.command === "clear_cell"), []);
    assert.equal(controller.snapshot().cells[0]?.status, "done");
  } finally { await controller.close(); }
});

test("automatic edits run only affected branches in dependency order", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: reactiveExample("reactive-branches.R"),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const ids = controller.snapshot().cells.map((cell) => cell.id);
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId), [ids[0], ids[3], ids[1], ids[2]]);
    const independentOutput = controller.snapshot().cells[3]?.outputs[0]?.id;

    const edit = command(controller, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: ids[0]! }, expectedRevision: 0,
        body: ["x <- 4L", "x"], cellType: "code" }],
    });
    await startCommand(controller, edit);
    await settle(controller, edit.requestId);
    await eventuallyTimed(() => engine.evaluations.length === 7);
    assert.equal(engine.evaluations.length, 7);
    assert.deepEqual(engine.evaluations.slice(4).map((item) => item.cellId), ids.slice(0, 3));
    assert.equal(controller.snapshot().cells[3]?.outputs[0]?.id, independentOutput);
  } finally { await controller.close(); }
});

test("an explicit Run waits for active automatic work and takes priority over pending reactive work", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "a <- 1"], ["b", "b <- 2"], ["chosen", "chosen <- 3", "chosen"]]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const edit = (cellId: string, revision: number, body: string) => command(controller, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId }, expectedRevision: revision, body: [body], cellType: "code" }],
    });
    const first = edit("a", 0, "a <- 10");
    await startCommand(controller, first);
    await settle(controller, first.requestId);
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);

    const second = edit("b", 0, "b <- 20");
    await startCommand(controller, second);
    await settle(controller, second.requestId);
    const explicit = command(controller, { type: "run", scope: "cell", target: { cellId: "chosen" } });
    const explicitResult = controller.dispatch(explicit);
    assert.equal(controller.snapshot().runtime.busy, true);

    engine.finishEvaluation();
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    assert.equal(engine.pendingEvaluations[0]?.payload.cellId, "chosen");
    engine.finishEvaluation();
    assert.equal((await explicitResult).error, null);
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    assert.equal(engine.pendingEvaluations[0]?.payload.cellId, "b");
    engine.finishEvaluation();
    await eventuallyTimed(() => !controller.snapshot().runtime.busy);
    assert.deepEqual(engine.evaluations.map(evaluation => evaluation.cellId), ["a", "chosen", "b"]);
  } finally { await controller.close(); }
});

test("a newly created code cell joins automatic execution", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: reactiveExample("reactive-branches.R"),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    const originalOutputs = controller.snapshot().cells.map((cell) => cell.outputs[0]?.id);
    const lastId = controller.snapshot().cells[3]!.id;
    const create = command(controller, { type: "transaction", changes: [{
      type: "create", creationId: "added", after: { cellId: lastId },
      cellType: "code", body: ["triple <- x * 3L", "triple"], options: {},
    }] });
    await startCommand(controller, create);
    await settle(controller, create.requestId);
    await eventuallyTimed(() => engine.evaluations.length === 5);
    assert.equal(engine.evaluations[4]?.cellId, controller.snapshot().cells[4]?.id);
    assert.deepEqual(controller.snapshot().cells.slice(0, 4).map((cell) => cell.outputs[0]?.id), originalOutputs);
  } finally { await controller.close(); }
});

test("lazy edits wait for an explicit dependent Run", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: reactiveExample("reactive-lazy.R"),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "lazy" } }),
  });
  try {
    await controller.start();
    const ids = controller.snapshot().cells.map((cell) => cell.id);
    const edit = command(controller, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: ids[0]! }, expectedRevision: 0,
        body: ["x <- 3L", "x"], cellType: "code" }],
    });
    await startCommand(controller, edit);
    await settle(controller, edit.requestId);
    assert.equal(engine.evaluations.length, 0);
    const run = command(controller, { type: "run", scope: "cell", target: { cellId: ids[1]! } });
    await startCommand(controller, run);
    await settle(controller, run.requestId);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId), ids);
  } finally { await controller.close(); }
});

test("an obsolete slow result cannot replace a newer reactive result", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: reactiveExample("reactive-slow.R"),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const ids = controller.snapshot().cells.map((cell) => cell.id);
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    const unrelatedOutput = controller.snapshot().cells[2]?.outputs[0]?.id;
    engine.deferred = true;

    const edit = (value: number, revision: number) => command(controller, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: ids[0]! }, expectedRevision: revision,
        body: [`x <- ${value}L`, "x"], cellType: "code" }],
    });
    const first = edit(2, 0);
    await startCommand(controller, first);
    await settle(controller, first.requestId);
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    engine.finishEvaluation();
    await eventually(() => engine.pendingEvaluations.length === 1);
    assert.equal(engine.pendingEvaluations[0]?.payload.cellId, ids[1]);

    const second = edit(3, 1);
    await startCommand(controller, second);
    await settle(controller, second.requestId);
    await eventually(() => engine.interrupts.length > 0);
    engine.emitEvaluationOutput("append", { output: { kind: "text", text: "obsolete streamed output", truncated: false } });
    engine.emitEvaluationOutput("progress", { progress: { kind: "progress", value: 1, total: 2, label: "obsolete", done: false } });
    assert.ok(!JSON.stringify(controller.snapshot()).includes("obsolete streamed output"));
    assert.ok(!JSON.stringify(controller.snapshot()).includes('"label":"obsolete"'));
    engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "obsolete slow result", truncated: false }] });
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    assert.equal(engine.pendingEvaluations[0]?.payload.cellId, ids[0]);
    engine.finishEvaluation();
    await eventually(() => engine.pendingEvaluations.length === 1);
    assert.equal(engine.pendingEvaluations[0]?.payload.cellId, ids[1]);
    engine.finishEvaluation();
    await eventuallyTimed(() => controller.snapshot().cells[1]?.status === "done");
    assert.ok(!JSON.stringify(controller.snapshot()).includes("obsolete slow result"));
    assert.equal(controller.snapshot().cells[2]?.outputs[0]?.id, unrelatedOutput);
  } finally { await controller.close(); }
});

test("source edits retire obsolete output and accept the replacement generation", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: reactiveExample("reactive-slow.R"),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const ids = controller.snapshot().cells.map(cell => cell.id);
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial); await settle(controller, initial.requestId);
    engine.deferred = true;
    const edit = (value: number, revision: number) => command(controller, {
      type: "transaction", changes: [{ type: "edit", cell: { cellId: ids[0]! }, expectedRevision: revision,
        body: [`x <- ${value}L`, "x"], cellType: "code" }],
    });
    const first = edit(2, 0); await startCommand(controller, first); await settle(controller, first.requestId);
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    engine.finishEvaluation();
    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    const second = edit(3, 1); await startCommand(controller, second); await settle(controller, second.requestId);
    await eventuallyTimed(() => engine.interrupts.length > 0);
    engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "obsolete", truncated: false }] });

    await eventuallyTimed(() => engine.pendingEvaluations.length === 1);
    const retired = engine.emitEvaluationOutput("append", { kind: "text", text: "replaced", truncated: false })!;
    const replacement = await engine.replaceCanonicalRecord(retired, { kind: "text", text: "accepted replacement", truncated: false });
    engine.finishEvaluationWithCanonicalResponse({ ok: true, outputs: [retired, replacement] });
    const deadline = Date.now() + 1_000;
    while (controller.snapshot().runtime.busy && Date.now() < deadline) {
      if (engine.pendingEvaluations.length) engine.finishEvaluation();
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    await eventuallyTimed(() => controller.snapshot().runtime.kernelState === "ready" && !controller.snapshot().runtime.busy);
    const rendered = JSON.stringify(controller.snapshot());
    assert.ok(!rendered.includes('"text":"replaced"'));
    assert.ok(!rendered.includes("obsolete"));
    assert.ok(rendered.includes("accepted replacement"));
  } finally { await controller.close(); }
});

test("reactive errors leave descendants stale and recover after an edit", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: reactiveExample("reactive-errors.R"),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const ids = controller.snapshot().cells.map((cell) => cell.id);
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    let fail = true;
    engine.evaluationHandler = (payload) => fail && payload.cellId === ids[1]
      ? { ok: false, error: { message: "x must be nonnegative" } }
      : engine.rawResponseFor(payload);

    const edit = (value: number, revision: number) => command(controller, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: ids[0]! }, expectedRevision: revision,
        body: [`x <- ${value}L`, "x"], cellType: "code" }],
    });
    const negative = edit(-1, 0);
    await startCommand(controller, negative);
    await settle(controller, negative.requestId);
    await eventuallyTimed(() => controller.snapshot().cells[1]?.status === "error");
    assert.equal(controller.snapshot().cells[2]?.status, "stale");

    fail = false;
    const positive = edit(3, 1);
    await startCommand(controller, positive);
    await settle(controller, positive.requestId);
    await eventuallyTimed(() => controller.snapshot().cells.every((cell) => cell.status === "done"));
    assert.deepEqual(engine.evaluations.slice(-3).map((item) => item.cellId), ids);
  } finally { await controller.close(); }
});

test("an ordinary automatic cell Run keeps its dependency scope", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: notebook([["a", "x <- 1"], ["b", "y <- x + 1"], ["c", "z <- y + 1"]]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const ids = controller.snapshot().cells.map((cell) => cell.id);
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    const run = command(controller, { type: "run", scope: "cell", target: { cellId: ids[1]! } });
    await startCommand(controller, run);
    const completed = await settle(controller, run.requestId);
    assert.deepEqual((completed.result as { plan: string[] }).plan, ids.slice(1));
    assert.deepEqual(engine.evaluations.slice(3).map((item) => item.cellId), ids.slice(1));
    assert.equal(engine.restartCount, 0);
  } finally { await controller.close(); }
});

test("duplicate globals and their consumer stay blocked until repair while an independent cell runs", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([
      ["first", ".x <- 1"],
      ["second", ".x <- 2"],
      ["consumer", "answer <- .x + 1"],
      ["unrelated", "other <- 3"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  try {
    await controller.start();
    const snapshot = controller.snapshot();
    assert.match(snapshot.cells[0]?.diagnostics[0]?.message ?? "", /global \.x.*first, second/);
    assert.match(snapshot.cells[1]?.diagnostics[0]?.message ?? "", /global \.x.*first, second/);
    assert.match(snapshot.cells[2]?.diagnostics[0]?.message ?? "", /blocked by invalid dependencies.*first, second/);
    assert.deepEqual(snapshot.cells[3]?.diagnostics, []);

    const all = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, all);
    const completed = await settle(controller, all.requestId);
    assert.deepEqual((completed.result as { plan: string[] }).plan, ["unrelated"]);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["unrelated"]);

    const blocked = command(controller, { type: "run", scope: "cell", target: { cellId: "first" } });
    await startCommand(controller, blocked);
    const failed = await controller.awaitOperation(blocked.requestId, "controller-tests");
    assert.equal(failed.status, "error");
    assert.equal(failed.error?.code, "graph_invalid");

    const dependent = command(controller, { type: "run", scope: "cell", target: { cellId: "consumer" } });
    await startCommand(controller, dependent);
    const dependentFailure = await controller.awaitOperation(dependent.requestId, "controller-tests");
    assert.equal(dependentFailure.status, "error");
    assert.equal(dependentFailure.error?.code, "graph_invalid");

    const repair = command(controller, { type: "transaction", changes: [{
      type: "edit", cell: { cellId: "second" }, expectedRevision: 0,
      body: ["other_shared <- 2"], cellType: "code",
    }] });
    await startCommand(controller, repair);
    await settle(controller, repair.requestId);
    await eventually(() => controller.snapshot().cells.every((cell) => !cell.analysisPending));
    const rerun = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, rerun);
    const repaired = await settle(controller, rerun.requestId);
    assert.deepEqual((repaired.result as { plan: string[] }).plan, ["first", "second", "unrelated", "consumer"]);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId),
      ["unrelated", "first", "second", "unrelated", "consumer"]);
    assert.ok(controller.snapshot().cells.every((cell) => cell.status === "done"));
  } finally { await controller.close(); }
});

test("cycle members and their consumer stay blocked until repair while an independent cell runs", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "x <- y"],
      ["b", "y <- x"],
      ["consumer", "answer <- x + y"],
      ["unrelated", "other <- 3"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  try {
    await controller.start();
    const snapshot = controller.snapshot();
    assert.match(snapshot.cells[0]?.diagnostics[0]?.message ?? "", /cells: a, b/);
    assert.match(snapshot.cells[1]?.diagnostics[0]?.message ?? "", /cells: a, b/);
    assert.match(snapshot.cells[2]?.diagnostics[0]?.message ?? "", /blocked by invalid dependencies.*a, b/);
    assert.deepEqual(snapshot.cells[3]?.diagnostics, []);

    const all = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, all);
    const completed = await settle(controller, all.requestId);
    assert.deepEqual((completed.result as { plan: string[] }).plan, ["unrelated"]);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["unrelated"]);

    const repair = command(controller, { type: "transaction", changes: [{
      type: "edit", cell: { cellId: "b" }, expectedRevision: 0,
      body: ["y <- 1"], cellType: "code",
    }] });
    await startCommand(controller, repair);
    await settle(controller, repair.requestId);
    await eventually(() => controller.snapshot().cells.every((cell) => !cell.analysisPending));
    const rerun = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, rerun);
    const repaired = await settle(controller, rerun.requestId);
    assert.deepEqual((repaired.result as { plan: string[] }).plan, ["b", "unrelated", "a", "consumer"]);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId),
      ["unrelated", "b", "unrelated", "a", "consumer"]);
    assert.ok(controller.snapshot().cells.every((cell) => cell.status === "done"));
  } finally { await controller.close(); }
});

test("automatic edits resume once after a runtime-context reservation", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: notebook([["a", "x <- 1"], ["b", "y <- x + 1"]]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  try {
    await controller.start();
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    const reservation = controller.reserveRuntimeContext();
    const edit = command(controller, { type: "transaction", changes: [{
      type: "edit", cell: { cellId: "a" }, expectedRevision: 0,
      body: ["x <- 2"], cellType: "code",
    }] });
    await startCommand(controller, edit);
    await settle(controller, edit.requestId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(engine.evaluations.length, 2);
    reservation.release();
    reservation.release();
    await eventuallyTimed(() => engine.evaluations.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a", "b", "a", "b"]);
  } finally { await controller.close(); }
});

test("automatic edits during package installation rebuild the restarted kernel once", async () => {
  const engine = new FakeEngine();
  let finishInstall!: (value: unknown) => void;
  const controller = createController({
    engine, notebook: notebook([["a", "seed <- 5"], ["b", "answer <- seed + 1"]]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
    services: { service: async (name) => name === "packages.install"
      ? new Promise((resolve) => { finishInstall = resolve; })
      : { declared: [], installed: [], missing: [] } },
  });
  try {
    await controller.start();
    const initial = command(controller, { type: "run", scope: "all" });
    await startCommand(controller, initial);
    await settle(controller, initial.requestId);
    const earlierOutput = controller.snapshot().cells[0]?.outputs[0]?.id;
    const install = command(controller, {
      type: "packages-install", packages: ["stats"],
      expectedDocumentRevision: controller.snapshot().documentRevision,
      kernelEpoch: controller.snapshot().runtime.kernelEpoch,
    });
    await startCommand(controller, install);
    await eventually(() => finishInstall !== undefined);
    const edit = command(controller, { type: "transaction", changes: [{
      type: "edit", cell: { cellId: "b" }, expectedRevision: 0,
      body: ["answer <- seed + 2"], cellType: "code",
    }] });
    await startCommand(controller, edit);
    await settle(controller, edit.requestId);
    assert.equal(engine.evaluations.length, 2);
    finishInstall({ ok: true, status: "installed", packages: ["stats"] });
    await settle(controller, install.requestId);
    await eventuallyTimed(() => engine.evaluations.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(engine.restartCount, 1);
    assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a", "b", "a", "b"]);
    assert.notEqual(controller.snapshot().cells[0]?.outputs[0]?.id, earlierOutput);
  } finally { await controller.close(); }
});

test("queued invalidations clear in one atomic request before evaluation resumes", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- 2"], ["c", "x + y"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);
  const evaluationsBeforeClear = engine.evaluations.length;

  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 10"],
            cellType: "code"
        },
        {
            type: "edit",
            cell: {
                cellId: "b"
            },
            expectedRevision: 0,
            body: ["y <- 20"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  await eventually(() => controller.snapshot().cells.every((cell) => !cell.analysisPending));

  let releaseClear!: () => void;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  engine.requestHandler = async (name) => {
    if (name === "clear_cell") await clearGate;
    return { ok: true };
  };
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => engine.requests.some((request) => request.command === "clear_cell"));
  assert.equal(engine.evaluations.length, evaluationsBeforeClear);
  assert.deepEqual(
    engine.requests.filter((request) => request.command === "clear_cell"),
    [{ command: "clear_cell", payload: { ids: ["a", "b"] } }],
  );

  releaseClear();
  await settle(controller, run.requestId);
  assert.equal(
    engine.requests.filter((request) => request.command === "clear_cell").length,
    1,
  );
  assert.deepEqual(
    engine.evaluations.slice(evaluationsBeforeClear).map((evaluation) => evaluation.cellId),
    ["a", "b", "c"],
  );
  await controller.close();
});

test("a failed cell drops only its same-run descendants and continues independent work", async () => {
  const engine = new FakeEngine();
  engine.evaluationHandler = (payload) => payload.cellId === "a"
    ? { ok: false, error: { message: "expected failure" }, log: ["side effect happened"] }
    : engine.rawResponseFor(payload);
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "x <- side_effect_then_fail()"],
      ["b", "y <- x + 1"],
      ["c", "independent <- 42"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  const terminal = await controller.awaitOperation(run.requestId, "controller-tests");
  assert.equal(terminal.status, "error");
  assert.equal(terminal.error?.code, "eval_error");
  assert.equal(terminal.error?.message, "expected failure");
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a", "c"]);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.cells.find((cell) => cell.id === "a")?.status, "error");
  assert.equal(snapshot.cells.find((cell) => cell.id === "b")?.status, "idle");
  assert.equal(snapshot.cells.find((cell) => cell.id === "c")?.status, "done");
  assert.ok(snapshot.cells.find((cell) => cell.id === "a")?.log.includes("side effect happened"));
  await controller.close();
});

test("streamed log replacements compose partial lines without duplicating them", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "cat('ab\\nc\\n')"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.emitEvaluationLog({ lines: ["a"] });
  engine.emitEvaluationLog({ lines: ["ab"], replaceLast: true });
  engine.emitEvaluationLog({ lines: ["c"] });
  engine.finishEvaluation({ ok: true, outputs: [] });
  await settle(controller, run.requestId);
  assert.deepEqual(controller.snapshot().cells[0]?.log, ["ab", "c"]);
  await controller.close();
});

test("mixed rich output and console text retain emission order", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "out$append('first'); cat('second\\n'); out$append('third')"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "cell", target: { cellId: "a" }, changes: [] });
  await startCommand(controller, run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "first", truncated: false } });
  engine.emitEvaluationLog({ lines: ["second"], raw: "second\n" });
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "third", truncated: false } });
  engine.finishEvaluation({ ok: true });
  await settle(controller, run.requestId);
  const cell = controller.snapshot().cells[0]!;
  const outputs = new Map(cell.outputs.map((output) => [output.id, output.data]));
  assert.deepEqual(cell.displayOrder?.map((part) => part.kind === "log"
    ? part.text : outputs.get(part.id)), [
      { kind: "text", text: "first", truncated: false },
      "second\n",
      { kind: "text", text: "third", truncated: false },
    ]);
  await controller.close();
});

test("native clear-output deltas reset every streamed projection before later output", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "stream_output()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event));
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "old", truncated: false } });
  engine.emitEvaluationOutput("log", { lines: ["old log"] });
  engine.emitEvaluationOutput("progress", { progress: { kind: "progress", value: 0.5, total: null, label: "", done: false } });
  engine.emitEvaluationOutput("clear", {});
  assert.deepEqual(controller.snapshot().cells[0]?.outputs, []);
  assert.deepEqual(controller.snapshot().cells[0]?.log, []);
  assert.equal(controller.snapshot().cells[0]?.progress, null);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "new", truncated: false } });
  engine.finishEvaluation({ ok: true, log: [] });
  await settle(controller, run.requestId);
  assert.deepEqual(controller.snapshot().cells[0]?.outputs.map((output) => output.data), [{ kind: "text", text: "new", truncated: false }]);
  assert.ok(events.some((event) => event.type === "cell-output"
    && (event.payload as { kind?: string }).kind === "clear"));
  const rerun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, rerun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.deepEqual(controller.snapshot().cells[0]?.outputs.map((output) => output.data), [{ kind: "text", text: "new", truncated: false }]);
  assert.equal(controller.snapshot().cells[0]?.outputsStale, true);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "replacement", truncated: false } });
  assert.deepEqual(controller.snapshot().cells[0]?.outputs.map((output) => output.data), [{ kind: "text", text: "replacement", truncated: false }]);
  assert.notEqual(controller.snapshot().cells[0]?.outputsStale, true);
  engine.finishEvaluation({ ok: true, log: [] });
  await settle(controller, rerun.requestId);
  assert.notEqual(controller.snapshot().cells[0]?.outputsStale, true);
  unsubscribe();
  await controller.close();
});

test("completed and interrupted cells clear progress and ignore output after Stop", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine, notebook: notebook([["a", "out$progress(3)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const completedRun = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, completedRun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.emitEvaluationOutput("progress", { progress: { kind: "progress", value: 3, total: 3, label: "Rows", done: true } });
  assert.equal((controller.snapshot().cells[0]?.progress as { value: number }).value, 3);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "[1] 6", truncated: false }] });
  await settle(controller, completedRun.requestId);
  assert.equal(controller.snapshot().cells[0]?.progress, null);

  const interruptedRun = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, interruptedRun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  await startCommand(controller, command(controller, { type: "interrupt" }));
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "late", truncated: false } });
  engine.emitEvaluationOutput("progress", { progress: { kind: "progress", value: 2, total: 3, label: "late", done: false } });
  assert.ok(!JSON.stringify(controller.snapshot().cells[0]).includes("late"));
  engine.finishEvaluation({ ok: false, error: { message: "Interrupted", interrupted: true } });
  await controller.awaitOperation(interruptedRun.requestId, "controller-tests");
  assert.equal(controller.snapshot().cells[0]?.progress, null);
  await controller.close();
});

test("completion preserves the authoritative log beyond the live stream window", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "cat(large_output)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  const completeLine = "x".repeat(70 * 1024);
  engine.finishEvaluation({ ok: true, outputs: [], log: [completeLine] });
  await settle(controller, run.requestId);
  assert.deepEqual(controller.snapshot().cells[0]?.log, [completeLine]);

  const oversizedRun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, oversizedRun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.finishEvaluation({ ok: true, outputs: [], log: ["x".repeat(1_048_577)] });
  await settle(controller, oversizedRun.requestId);
  assert.deepEqual(controller.snapshot().cells[0]?.log, [
    "x".repeat(1_048_576),
    "[output truncated at 1048576 bytes]",
  ]);
  await controller.close();
});

test("editing an active cell requests scoped interruption and discards its late success", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => controller.snapshot().runtime.busy);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 9"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  await eventually(() => engine.interrupts.length === 1);
  assert.deepEqual(engine.interrupts, [1]);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "obsolete", truncated: false }] });
  await settle(controller, run.requestId);
  const state = controller.snapshot();
  assert.equal(state.cells.find((cell) => cell.id === "a")?.revision, 1);
  assert.equal(state.cells.find((cell) => cell.id === "a")?.status, "stale");
  assert.ok(!JSON.stringify(state).includes("obsolete"));
  assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a"]);
  await controller.close();
});

test("analysis cache evicts old source entries while retaining recent reusable results", async () => {
  const engine = new FakeEngine();
  const sources = Array.from({ length: 257 }, (_, index) => `value_${index} <- ${index}`);
  const controller = createController({
    engine,
    notebook: notebook(sources.map((source, index) => [`cell-${index}`, source])),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  assert.equal(engine.analysisCalls.length, 1);
  assert.equal(engine.analysisCalls[0]?.length, sources.length);

  const firstEdit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "cell-256"
            },
            expectedRevision: 0,
            body: [sources[0]!],
            cellType: "code"
        }
    ]
  });
  const firstStarted = await startCommand(controller, firstEdit);
  await controller.awaitOperation(firstStarted.requestId, "controller-tests");
  await eventually(() => controller.snapshot().cells[256]?.analysisPending === false);
  assert.equal(engine.analysisCalls.length, 2);
  assert.equal(engine.analysisCalls[1]?.[0]?.source, sources[0]);

  const secondEdit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "cell-255"
            },
            expectedRevision: 0,
            body: [sources[0]!],
            cellType: "code"
        }
    ]
  });
  const secondStarted = await startCommand(controller, secondEdit);
  await controller.awaitOperation(secondStarted.requestId, "controller-tests");
  await eventually(() => controller.snapshot().cells[255]?.analysisPending === false);
  assert.equal(engine.analysisCalls.length, 2);
  await controller.close();
});
test('notebook option names colliding with Object.prototype remain editable and lossless', () => {
  const source = '# %%\n#| constructor: 1\n#| __proto__: 2\nx <- 1\n';
  const notebook = parsedNotebook(source);
  assert.equal(notebook.cells[0]?.options.constructor, '1');
  assert.equal(notebook.cells[0]?.options.__proto__, '2');
  assert.equal(new TextDecoder().decode(serializeNotebook(notebook)), source);
});
test("parsed physical records retain BOM, mixed EOL, and duplicate options around an edit", async () => {
  const source = mixedPhysicalSource();
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: parsedNotebook(source), config: resolveSettings({ notebook: { on_startup: false } }) });
  await controller.start();
  try {
    const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "cell-1"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    const started = await startCommand(controller, edit);
    await settle(controller, started.requestId);
    assert.deepEqual([...serializedNotebookBytes(controller).slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(serializedNotebook(controller), "\ufeff# title\r\n# noncanonical header\r\n# %%\r#| foo: one\r#| foo: two\rx <- 2\n# %% markdown\n#| bar: two\nbody");
  } finally {
    await controller.close();
  }
});

test("failed durable commit does not adopt staged physical notebook bytes", async () => {
  const source = mixedPhysicalSource();
  const controller = createController({
    engine: new FakeEngine(),
    notebook: parsedNotebook(source),
    config: resolveSettings({ notebook: { on_startup: false } }),
    durableCommit: async () => { throw new Error("durable failure"); },
  });
  await controller.start();
  try {
    const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "cell-1"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    const started = await startCommand(controller, edit);
    const operation = await controller.awaitOperation(started.requestId, "controller-tests");
    assert.equal(operation.status, "error");
    assert.equal(serializedNotebook(controller), source);
  } finally {
    await controller.close();
  }
});


test("source started keeps pending publication invisible and checks revision at lane acquisition", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      entered = true;
      const document = {
        ...context.document,
        cells: context.document.cells.map((cell) => cell.id === "a"
          ? { ...cell, body: ["x <- 2"], revision: cell.revision + 1 }
          : cell),
      };
      const publish = context.preparePublication({
        document,
        path: context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: true,
        advanceRevision: true,
      });
      await gate;
      publish();
      return request.operationId;
    },
  });
  await controller.start();
  try {
    const before = controller.snapshot();
    const first = controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: before.documentRevision,
      operationId: "watcher-1",
    });
    await eventually(() => entered);
    assert.equal(controller.snapshot().documentRevision, before.documentRevision);
    assert.equal(controller.snapshot().cells[0]?.body[0], "x <- 1");

    const second = controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: before.documentRevision,
      operationId: "watcher-2",
    });
    release();
    assert.equal(await first, "watcher-1");
    await assert.rejects(second, (error: unknown) => (
      error instanceof ControllerError && error.code === "source_conflict"
    ));
    const after = controller.snapshot();
    assert.equal(after.documentRevision, before.documentRevision + 1);
    assert.equal(after.cells[0]?.body[0], "x <- 2");
    assert.equal(after.dirty, true);
  } finally {
    release();
    await controller.close();
  }
});


test("external reloads publish full authoritative cells, graph, and revisions", async () => {
  const engine = new FakeEngine();
  const reloadDocuments = [
    [{ id: "a", body: "x <- 2" }],
    [{ id: "a", body: "x <- 3" }, { id: "b", body: "y <- x" }],
  ];
  let reloadIndex = 0;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "reload-source");
      const next = reloadDocuments[reloadIndex++];
      assert.ok(next);
      const document = {
        ...context.document,
        cells: next.map((entry) => ({
          id: entry.id,
          type: "code" as const,
          body: [entry.body],
          options: {},
          revision: context.document.cells.find((cell) => cell.id === entry.id)?.revision ?? 0,
        })),
      };
      const publish = context.preparePublication({
        document,
        path: context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: false,
        advanceRevision: true,
        invalidateRuntime: true,
      });
      publish();
    },
  });
  await controller.start();
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "notebook") events.push(event);
  });
  try {
    const firstBefore = controller.snapshot();
    await controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: firstBefore.documentRevision,
      operationId: "reload-authoritative-1",
    });
    const secondBefore = controller.snapshot();
    await controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: secondBefore.documentRevision,
      operationId: "reload-authoritative-2",
    });
    assert.equal(events.length, 2);
    const firstPayload = events[0]!.payload as Record<string, unknown>;
    const secondPayload = events[1]!.payload as Record<string, unknown>;
    const firstCell = (firstPayload.updated as Array<{ id: string; body: string[]; revision: number }>).find((cell) => cell.id === "a");
    const secondCell = (secondPayload.updated as Array<{ id: string; body: string[]; revision: number }>).find((cell) => cell.id === "a");
    assert.deepEqual(firstCell?.body, ["x <- 2"]);
    assert.equal(firstCell?.revision, 0);
    assert.deepEqual(secondCell?.body, ["x <- 3"]);
    assert.equal(secondCell?.revision, 0);
    assert.equal(events[0]!.documentRevision, firstBefore.documentRevision + 1);
    assert.equal(events[1]!.documentRevision, secondBefore.documentRevision + 1);
    assert.equal(firstPayload.documentRevision, events[0]!.documentRevision);
    assert.equal(secondPayload.documentRevision, events[1]!.documentRevision);
    assert.deepEqual(secondPayload.order, ["a", "b"]);
    assert.deepEqual(secondPayload.created, { b: "b" });
    assert.deepEqual(secondPayload.deleted, []);
    assert.ok(secondPayload.graph !== undefined);
    await eventually(() => engine.analysisCalls.some((cells) => cells.some((cell) => cell.source === "x <- 2")));
    await eventually(() => engine.analysisCalls.some((cells) => cells.some((cell) => cell.source === "y <- x")));
    const snapshot = controller.snapshot();
    assert.equal(snapshot.cells.find((cell) => cell.id === "a")?.body[0], "x <- 3");
    assert.equal(snapshot.cells.find((cell) => cell.id === "b")?.body[0], "y <- x");
  } finally {
    unsubscribe();
    await controller.close();
  }
});

test("external reload invalidates active evaluations before late success can publish", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- 2"], ["c", "z <- 3"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "reload-source");
      const publish = context.preparePublication({
        document: {
          ...context.document,
          cells: context.document.cells.map((cell) => cell.id === "c" ? { ...cell, body: ["z <- 4"] } : cell),
        },
        path: context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: false,
        advanceRevision: true,
        invalidateRuntime: true,
      });
      publish();
    },
  });
  await controller.start();
  try {
    const run = command(controller, {
      type: "run",
      scope: "all",
      changes: [],
    });
    await startCommand(controller, run);
    await eventually(() => engine.pendingEvaluations.length === 1);
    const beforeReload = controller.snapshot();
    await controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: beforeReload.documentRevision,
      operationId: "reload-during-evaluation",
    });
    assert.deepEqual(engine.interrupts, [1]);
    assert.equal((await controller.awaitOperation(run.requestId, "controller-tests")).status, "error");
    engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "late", truncated: false }] });
    await eventually(() => engine.pendingEvaluations.length === 0);
    assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a"]);
    const cell = controller.snapshot().cells.find((candidate) => candidate.id === "a");
    assert.equal(cell?.status, "stale");
    assert.deepEqual(cell?.outputs, []);
  } finally {
    await controller.close();
  }
});

test("closing waits for the durable source lane before engine teardown", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (_request, context) => {
      entered = true;
      const publish = context.preparePublication({
        document: context.document,
        path: context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: context.dirty,
        advanceRevision: false,
      });
      await gate;
      publish();
    },
  });
  await controller.start();
  const commit = controller.commitSource({
    kind: "reload-source",
    expectedDocumentRevision: controller.snapshot().documentRevision,
    operationId: "closing-source-lane",
  });
  await eventually(() => entered);
  let closed = false;
  const closing = controller.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  release();
  await commit;
  await closing;
  assert.equal(closed, true);
});


test("save-as source publication can change path without advancing the document revision", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "save-as");
      const path = request.path ?? "/tmp/destination.alder";
      const publish = context.preparePublication({
        document: { ...context.document, path },
        path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: false,
        advanceRevision: false,
      });
      publish();
      return { path };
    },
  });
  await controller.start();
  try {
    const before = controller.snapshot();
    const result = await controller.commitSource({
      kind: "save-as",
      expectedDocumentRevision: before.documentRevision,
      path: "/tmp/destination.alder",
      operationId: "save-as-1",
    });
    assert.deepEqual(result, { path: "/tmp/destination.alder" });
    const after = controller.snapshot();
    assert.equal(after.documentRevision, before.documentRevision);
    assert.equal(after.path, "/tmp/destination.alder");
    assert.equal(after.dirty, false);
    assert.deepEqual(after.cells, before.cells);
  } finally {
    await controller.close();
  }
});
test("failed Save As binder restores the controller source identity", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (_request, context) => {
      const publish = context.preparePublication({
        document: { ...context.document, path: "/tmp/destination.alder" },
        path: "/tmp/destination.alder",
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: context.dirty,
        advanceRevision: false,
      });
      publish();
    },
  });
  await controller.start();
  const internal = controller as unknown as { bump: (...args: any[]) => void };
  const originalBump = internal.bump;
  internal.bump = (...args: any[]) => {
    originalBump.apply(controller, args);
    throw new Error("publication observer failed");
  };
  try {
    const before = controller.snapshot();
    await assert.rejects(
      controller.commitSource({
        kind: "save-as",
        expectedDocumentRevision: before.documentRevision,
        path: "/tmp/destination.alder",
        operationId: "save-as-failure",
      }),
      /publication observer failed/,
    );
    const after = controller.snapshot();
    assert.equal(after.path, before.path);
    assert.deepEqual(after.cells, before.cells);
    assert.deepEqual(after.disk, before.disk);
  } finally {
    internal.bump = originalBump;
    await controller.close();
  }
});

test("failed source started leaves the physical notebook and revision unchanged", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async () => { throw new Error("source failure"); },
  });
  await controller.start();
  try {
    const before = controller.snapshot();
    await assert.rejects(controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: before.documentRevision,
      operationId: "reload-1",
    }), /source failure/);
    const after = controller.snapshot();
    assert.equal(after.documentRevision, before.documentRevision);
    assert.equal(after.path, before.path);
    assert.deepEqual(after.cells, before.cells);
    assert.equal(after.dirty, before.dirty);
  } finally {
    await controller.close();
  }
});

test("a source transaction publishes its immediate graph even when no analysis follows", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const events: string[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event.type));
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["# Notes"],
            cellType: "markdown"
        }
    ]
  });
  const editStarted = await startCommand(controller, edit);
  await controller.awaitOperation(editStarted.requestId, "controller-tests");
  assert.ok(events.includes("transaction"));
  assert.deepEqual(controller.snapshot().graph, {
    nodes: ["a"],
    edges: { a: [] },
    reverseEdges: { a: [] },
    duplicates: {},
    cycles: [],
    topologicalOrder: ["a"],
  });
  assert.equal(engine.analysisCalls.length, 1);
  unsubscribe();
  await controller.close();
});

test("kernel failure waits for a pending run source commit", async () => {
  const engine = new FakeEngine();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      entered = true;
      const document = request.document ?? context.document;
      const publish = context.preparePublication({
        document,
        path: document.path ?? context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: true,
        advanceRevision: true,
      });
      await gate;
      publish();
      return { committed: request.kind };
    },
  });
  try {
    await controller.start();
    const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    const started = await startCommand(controller, run);
    await eventually(() => entered);

    for (const listener of engine.failureListeners) listener("kernel", new Error("kernel lost"));
    await eventually(() => controller.snapshot().runtime.executionBlockedReason?.code === "worker_unavailable");
    const pending = controller.snapshot().operations.find((operation) => operation.id === started.requestId);
    assert.ok(pending);
    assert.ok(pending.status === "accepted" || pending.status === "running");

    release();
    const operation = await controller.awaitOperation(started.requestId, "controller-tests");
    assert.equal(operation.status, "error");
    assert.equal(operation.runId, null);
    assert.deepEqual(operation.result, {
      created: {},
      edited: [{ id: "a", revision: 1 }],
      deleted: [],
      documentRevision: 1,
    });
    const snapshot = controller.snapshot();
    assert.equal(snapshot.documentRevision, 1);
    assert.deepEqual(snapshot.cells[0]?.body, ["x <- 2"]);
    assert.equal(snapshot.cells[0]?.revision, 1);
    assert.equal(engine.evaluations.length, 0);
  } finally {
    release();
    await controller.close();
  }
});

test("run source outcomes survive analysis failure after publication", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  try {
    engine.analyze = async () => { throw new Error("analysis failed"); };
    const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    const started = await startCommand(controller, run);
    const operation = await controller.awaitOperation(started.requestId, "controller-tests");
    assert.equal(operation.status, "error");
    assert.equal(operation.error?.code, "analysis_unavailable");
    assert.equal(operation.runId, null);
    assert.deepEqual(operation.result, {
      created: {},
      edited: [{ id: "a", revision: 1 }],
      deleted: [],
      documentRevision: 1,
    });
    const snapshot = controller.snapshot();
    assert.equal(snapshot.documentRevision, 1);
    assert.deepEqual(snapshot.cells[0]?.body, ["x <- 2"]);
    assert.equal(snapshot.cells[0]?.revision, 1);
  } finally {
    await controller.close();
  }
});

test("rejected stale run does not acknowledge a foreign identical edit", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  try {
    const foreign: HostCommand = {
      requestId: "foreign-edit",
      clientId: "foreign-editor",
      sessionEpoch: controller.epoch,
      type: "transaction",
      expectedDocumentRevision: 0,
      changes: [{
        type: "edit",
        cell: { cellId: "a" },
        expectedRevision: 0,
        body: ["x <- 2"],
        cellType: "code",
      }],
    };
    const foreignStarted = await startCommand(controller, foreign);
    await settle(controller, foreignStarted.requestId, "foreign-editor");
    const beforeRun = controller.snapshot();
    assert.equal(beforeRun.documentRevision, 1);
    assert.deepEqual(beforeRun.cells[0]?.body, ["x <- 2"]);
    assert.equal(beforeRun.cells[0]?.revision, 1);

    const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
    });
    const started = await startCommand(controller, run);
    const operation = await controller.awaitOperation(started.requestId, 'controller-tests');
    assert.equal(operation.status, 'error');
    assert.equal(operation.error?.code, 'source_conflict');
    assert.equal(operation.runId, null);
    assert.equal(operation.result, null);
    const snapshot = controller.snapshot();
    assert.equal(snapshot.documentRevision, 1);
    assert.deepEqual(snapshot.cells[0]?.body, ["x <- 2"]);
    assert.equal(snapshot.cells[0]?.revision, 1);
  } finally {
    await controller.close();
  }
});

test("a Stop is accepted while a run waits for durable source commit", async () => {
  const engine = new FakeEngine();
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let commitEntered = false;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      commitEntered = true;
      await commitGate;
      const document = request.document ?? context.document;
      context.preparePublication({
        document, path: document.path ?? context.path, config: context.config,
        layout: context.layout, disk: context.disk, sidecars: context.sidecars,
        dirty: true, advanceRevision: true,
      })();
    },
  });
  await controller.start();
  try {
    const run = command(controller, {
      type: "run", scope: "cell", target: { cellId: "a" },
      changes: [{ type: "edit", cell: { cellId: "a" }, expectedRevision: 0, body: ["x <- 2"], cellType: "code" }],
    });
    const runStarted = await startCommand(controller, run);

    await eventually(() => commitEntered);
    assert.equal(controller.snapshot().runtime.busy, true);

    const stop = command(controller, { type: "interrupt" });
    const stopStarted = await startCommand(controller, stop);

    const stopOperation = await controller.awaitOperation(stopStarted.requestId, "controller-tests");
    assert.equal(stopOperation.status, "done");
    assert.equal((stopOperation.result as { requested: boolean }).requested, true);
    assert.equal(engine.evaluations.length, 0);

    releaseCommit();
    const settled = await controller.awaitOperation(run.requestId, "controller-tests");
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.error?.code, "interrupted");
    assert.equal(engine.evaluations.length, 0);
  } finally {
    releaseCommit();
    await controller.close();
  }
});

test("a late Stop cannot erase a successful matching completion", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "1 + 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => controller.snapshot().runtime.busy);
  const stop = command(controller, { type: "interrupt" });
  await startCommand(controller, stop);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "[1] 2", truncated: false }] });
  const settled = await settle(controller, run.requestId);
  assert.equal(settled.status, "done");
  assert.equal(controller.snapshot().cells[0]?.status, "done");
  assert.equal((controller.snapshot().cells[0]?.outputs[0]?.data as { text: string }).text, "[1] 2");
  await controller.close();
});

test("a matching interrupted Stop cancels the run after its cell result is published", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "repeat Sys.sleep(1)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const events: string[] = [];
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "cell-completed") events.push("cell-completed");
    if (event.type === "operation"
      && (event.payload as { status?: string }).status === "cancelled") events.push("cancelled");
  });
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => controller.snapshot().runtime.busy);
  await startCommand(controller, command(controller, { type: "interrupt" }));
  engine.finishEvaluation({
    ok: false,
    error: { message: "Interrupted", code: "interrupted", interrupted: true },
  });
  const settled = await controller.awaitOperation(run.requestId, "controller-tests");
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.error?.code, "interrupted");
  assert.equal(controller.snapshot().cells[0]?.status, "error");
  assert.deepEqual(events, ["cell-completed", "cancelled"]);
  unsubscribe();
  await controller.close();
});
test("a requested Stop canonicalizes a malformed native interrupt error", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "Sys.sleep(30)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => controller.snapshot().runtime.busy);
  await startCommand(controller, command(controller, { type: "interrupt" }));
  engine.finishEvaluation({
    ok: false,
    error: { message: "bad error message", code: "evaluation_error" },
  });
  const settled = await controller.awaitOperation(run.requestId, "controller-tests");
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.error?.code, "interrupted");
  assert.equal(settled.error?.message, "Interrupted");
  await controller.close();
});

test("widget owner edits cancel the exact operation and late replies cannot commit", async () => {
  const engine = new FakeEngine();
  let resolveWidget!: (response: EngineResponse) => void;
  engine.requestHandler = (name) => name === "set_widget"
    ? new Promise((resolve) => { resolveWidget = resolve; })
    : Promise.resolve({ ok: true });
  const controller = createController({
    engine,
    notebook: notebook([["a", "threshold <- ui$slider(0, 10)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  await startCommand(controller, widget);
  await eventually(() => resolveWidget !== undefined);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["threshold <- ui$slider(0, 20)"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  assert.equal((await controller.awaitOperation(widget.requestId, "controller-tests")).status, "cancelled");
  resolveWidget({ ok: true, selected: { type: "double", value: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  const output = controller.snapshot().cells[0]?.outputs[0] as { data: { spec: { value: number } } };
  assert.equal(output.data.spec.value, 2);
  await controller.close();
});

test("widget events from replaced output records never reach R", async () => {
  const engine = new FakeEngine();
  engine.requestHandler = async (name, payload) => name === "set_widget"
    ? { ok: true, selected: { type: "double", value: payload.value } }
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "threshold <- ui$slider(0, 10)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  const original = controller.snapshot().cells[0]!.outputs[0]!;
  const first = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 4 }, source: "editor",
    expectedRevision: original.revision, expectedOutputId: original.id, expectedOutputGeneration: original.generation ?? 0,
  });
  await startCommand(controller, first);
  const changed = await settle(controller, first.requestId);
  assert.equal(changed.status, "done");
  const replacement = controller.snapshot().cells[0]!.outputs[0]!;
  assert.equal(replacement.id, original.id);
  assert.ok((replacement.generation ?? 0) > (original.generation ?? 0));
  assert.equal((changed.result as { outputRecordId: string }).outputRecordId, replacement.id);

  const stale = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
    expectedRevision: original.revision, expectedOutputId: original.id, expectedOutputGeneration: original.generation ?? 0,
  });
  await startCommand(controller, stale);
  const rejected = await controller.awaitOperation(stale.requestId, "controller-tests");
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error?.code, "widget_not_current");
  assert.equal(engine.requests.filter(({ command }) => command === "set_widget").length, 1);
  assert.equal((controller.snapshot().cells[0]!.outputs[0]!.data as { spec: { value: number } }).spec.value, 4);

  const edit = command(controller, { type: "transaction", changes: [{
    type: "edit", cell: { cellId: "a" }, expectedRevision: 0,
    body: ["threshold <- ui$slider(0, 20)"], cellType: "code",
  }] });
  await startCommand(controller, edit);
  await settle(controller, edit.requestId);
  const afterEdit = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 8 }, source: "editor",
    expectedRevision: original.revision, expectedOutputId: original.id, expectedOutputGeneration: original.generation ?? 0,
  });
  await startCommand(controller, afterEdit);
  const staleRevision = await controller.awaitOperation(afterEdit.requestId, "controller-tests");
  assert.equal(staleRevision.status, "error");
  assert.equal(staleRevision.error?.code, "widget_not_current");
  assert.equal(engine.requests.filter(({ command }) => command === "set_widget").length, 1);
  await controller.close();
});

test("a successful obsolete widget request replays authoritative source after unrelated work", async () => {
  const engine = new FakeEngine();
  let resolveWidget!: (response: EngineResponse) => void;
  engine.requestHandler = (name) => name === "set_widget"
    ? new Promise((resolve) => { resolveWidget = resolve; })
    : Promise.resolve({ ok: true });
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "threshold <- ui$slider(0, 10)"],
      ["b", "seen <- threshold"],
      ["c", "Sys.sleep(2)"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);

  engine.deferred = true;
  const unrelated = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "c"
    },
    changes: []
  });
  await startCommand(controller, unrelated);
  await eventually(() => engine.pendingEvaluations.length === 1);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 9 }, source: "editor",
  });
  await startCommand(controller, widget);
  await eventually(() => resolveWidget !== undefined);
  await startCommand(controller, command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["threshold <- ui$slider(0, 10, value = 7)"],
            cellType: "code"
        }
    ]
  }));
  assert.equal((await controller.awaitOperation(widget.requestId, "controller-tests")).status, "cancelled");
  assert.equal(engine.evaluations.at(-1)?.cellId, "c");

  engine.finishEvaluation();
  await settle(controller, unrelated.requestId);
  resolveWidget({ ok: true, selected: { type: "double", value: 9 } });
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(engine.evaluations.at(-1)?.cellId, "a");
  assert.equal(engine.evaluations.at(-1)?.revision, 1);
  assert.match(engine.evaluations.at(-1)?.source ?? "", /value = 7/);
  engine.finishEvaluation();
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(engine.evaluations.at(-1)?.cellId, "b");
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "[1] 7", truncated: false }] });
  await eventually(() => controller.snapshot().cells.find((cell) => cell.id === "b")?.status === "done");
  assert.equal(
    (controller.snapshot().cells.find((cell) => cell.id === "b")?.outputs[0]?.data as { text?: string }).text,
    "[1] 7",
  );
  const reconciliation = controller.snapshot().operations.find((operation) =>
    operation.id.startsWith("widget-reconcile-"),
  );
  assert.equal(reconciliation?.status, "done");
  await controller.close();
});

test("a rejected obsolete widget request does not execute edited source", async () => {
  const engine = new FakeEngine();
  let resolveWidget!: (response: EngineResponse) => void;
  engine.requestHandler = (name) => name === "set_widget"
    ? new Promise((resolve) => { resolveWidget = resolve; })
    : Promise.resolve({ ok: true });
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "threshold <- ui$slider(0, 10)"],
      ["b", "seen <- threshold"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "automatic" } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);

  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 9 }, source: "editor",
  });
  await startCommand(controller, widget);
  await eventually(() => resolveWidget !== undefined);
  await startCommand(controller, command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["threshold <- ui$slider(0, 10, value = 7)"],
            cellType: "code"
        }
    ]
  }));
  resolveWidget({ ok: false, error: { message: "request rejected before kernel entry" } });
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a", "b"]);
  assert.equal((await controller.awaitOperation(widget.requestId, "controller-tests")).status, "cancelled");
  await controller.close();
});

test("an edited widget owner is rejected as stale before replacement analysis settles", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "threshold <- ui$slider(0, 10)"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);

  let releaseAnalysis: (() => void) | undefined;
  engine.analyze = async (cells, revision) => {
    await new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    return {
      revision,
      analysisEnvironmentId: "analysis-test",
      analyzer: { packageVersion: "test", rVersion: "test", policy: "test", analysisEnvironmentId: "analysis-test" },
      cells: cells.map((cell) => analyzeCell(cell)),
    };
  };
  await startCommand(controller, command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["threshold <- ui$slider(0, 20)"],
            cellType: "code"
        }
    ]
  }));
  await eventually(() => releaseAnalysis !== undefined);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  const widgetStarted = await startCommand(controller, widget);
  const widgetOperation = await controller.awaitOperation(widgetStarted.requestId, "controller-tests");
  assert.equal(widgetOperation.status, "error");
  assert.equal(widgetOperation.error?.code, "widget_not_current");
  const inspect = command(controller, { type: "inspect", name: "threshold" });
  const inspectStarted = await startCommand(controller, inspect);
  const inspectOperation = await controller.awaitOperation(inspectStarted.requestId, "controller-tests");
  assert.equal(inspectOperation.status, "error");
  assert.equal(inspectOperation.error?.code, "stale_value");
  const missingInspect = command(controller, { type: "inspect", name: "not_yet_owned" });
  const missingStarted = await startCommand(controller, missingInspect);
  const missingOperation = await controller.awaitOperation(missingStarted.requestId, "controller-tests");
  assert.equal(missingOperation.status, "error");
  assert.equal(missingOperation.error?.code, "analysis_pending");
  assert.equal(engine.requests.some((request) => request.command === "get_value"), false);
  releaseAnalysis?.();
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  await controller.close();
});

test("datetime updates reject impossible UTC calendar values before reaching R", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "stamp <- ui$datetime()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  const update = command(controller, {
    type: "widget",
    name: "stamp",
    path: [],
    update: { value: "2026-02-30T17:30:45Z" },
    source: "editor",
  });
  const updateStarted = await startCommand(controller, update);
  const updateOperation = await controller.awaitOperation(updateStarted.requestId, "controller-tests");
  assert.equal(updateOperation.status, "error");
  assert.equal(updateOperation.error?.code, "invalid_request");
  assert.equal(updateOperation.error?.message, "temporal widget value required");
  assert.equal(engine.requests.filter(({ command }) => command === "set_widget").length, 0);
  await controller.close();
});

test("date range and counter widget updates enforce protocol boundaries", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["dates", "selected <- ui$date_range()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, run);
  await settle(controller, run.requestId);

  const impossible = command(controller, {
    type: "widget", name: "dates", path: [],
    update: { value: ["2026-02-30", "2026-03-01"] }, source: "editor",
  });
  const impossibleStarted = await startCommand(controller, impossible);
  const impossibleOperation = await controller.awaitOperation(impossibleStarted.requestId, "controller-tests");
  assert.equal(impossibleOperation.status, "error");
  assert.equal(impossibleOperation.error?.code, "invalid_request");
  assert.equal(impossibleOperation.error?.message, "temporal widget value required");

  const descending = command(controller, {
    type: "widget", name: "dates", path: [],
    update: { value: ["2026-09-04", "2026-09-03"] }, source: "editor",
  });
  const descendingStarted = await startCommand(controller, descending);
  const descendingOperation = await controller.awaitOperation(descendingStarted.requestId, "controller-tests");
  assert.equal(descendingOperation.status, "error");
  assert.equal(descendingOperation.error?.code, "invalid_request");
  assert.equal(descendingOperation.error?.message, "date range must be non-decreasing");
  assert.equal(engine.requests.filter(({ command }) => command === "set_widget").length, 0);
  await controller.close();

  const counterEngine = new FakeEngine();
  const counterController = createController({
    engine: counterEngine,
    notebook: notebook([["counter", "counter_boundary <- ui$button()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await counterController.start();
  const counterRun = command(counterController, { type: "run", scope: "all", changes: [] });
  await startCommand(counterController, counterRun);
  await settle(counterController, counterRun.requestId);
  const tooLarge = command(counterController, {
    type: "widget", name: "counter", path: [],
    update: { value: 2_147_483_648 }, source: "editor",
  });
  const tooLargeStarted = await startCommand(counterController, tooLarge);
  const tooLargeOperation = await counterController.awaitOperation(tooLargeStarted.requestId, "controller-tests");
  assert.equal(tooLargeOperation.status, "error");
  assert.equal(tooLargeOperation.error?.code, "invalid_request");
  assert.equal(tooLargeOperation.error?.message, "counter widget value required");
  assert.equal(counterEngine.requests.filter(({ command }) => command === "set_widget").length, 0);
  await counterController.close();
});

test("widget operations settle after their automatic consumer run and inherit its error", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "threshold <- ui$slider(0, 10)"],
      ["b", "seen <- threshold"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);

  engine.deferred = true;
  const successful = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  await startCommand(controller, successful);
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(controller.operation(successful.requestId, "controller-tests")?.status, "running");
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "7", truncated: false }] });
  assert.equal((await controller.awaitOperation(successful.requestId, "controller-tests")).status, "done");
  const widgetOutput = controller.snapshot().cells[0]?.outputs[0] as {
    data: {
      operation?: { status?: string };
      operations?: Record<string, { status?: string }>;
      spec: { value: number };
    };
  };
  assert.equal(widgetOutput.data.operation?.status, "done");
  assert.equal(widgetOutput.data.operations?.threshold?.status, "done");

  const failed = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 8 }, source: "editor",
  });
  await startCommand(controller, failed);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.finishEvaluation({ ok: false, error: { message: "consumer boom" } });
  const failure = await controller.awaitOperation(failed.requestId, "controller-tests");
  assert.equal(failure.status, "error");
  assert.equal(failure.error?.code, "eval_error");
  assert.equal(failure.error?.message, "consumer boom");
  await controller.close();
});

test("owner edits expire pending inspect, lazy, and table requests before late replies", async () => {
  const engine = new FakeEngine();
  const resolvers = new Map<string, (response: EngineResponse) => void>();
  engine.requestHandler = async (name) => new Promise((resolve) => {
    resolvers.set(name, resolve);
  });
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "x <- 1"],
      ["b", "lazy_value <- make_lazy()"],
      ["c", "table_value <- make_table()"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);

  const inspect = command(controller, { type: "inspect", name: "x" });
  const lazy = command(controller, { type: "lazy-output", key: "lazy-1" });
  const table = command(controller, {
    type: "table-page",
    handle: "table-1",
    offset: 0,
    limit: 25,
    sortBy: "",
    sortDescending: false,
    filter: "",
  });
  await Promise.all([
    startCommand(controller, inspect),
    startCommand(controller, lazy),
    startCommand(controller, table),
  ]);
  await eventually(() => resolvers.size === 3);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        },
        {
            type: "edit",
            cell: {
                cellId: "b"
            },
            expectedRevision: 0,
            body: ["lazy_value <- make_lazy(2)"],
            cellType: "code"
        },
        {
            type: "edit",
            cell: {
                cellId: "c"
            },
            expectedRevision: 0,
            body: ["table_value <- make_table(2)"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  assert.equal((await controller.awaitOperation(inspect.requestId, "controller-tests")).error?.code, "stale_value");
  assert.equal(engine.requestSignals.get("get_value")?.aborted, true);
  assert.equal((await controller.awaitOperation(lazy.requestId, "controller-tests")).error?.code, "lazy_expired");
  assert.equal((await controller.awaitOperation(table.requestId, "controller-tests")).error?.code, "table_unavailable");
  resolvers.get("get_value")?.({ ok: true, value: { kind: "text", text: "obsolete", truncated: false } });
  resolvers.get("lazy_eval")?.({ ok: true, output: { kind: "text", text: "obsolete lazy", truncated: false } });
  resolvers.get("table_page")?.({ ok: true, page: {
    nrow: 1, ncol: 1, columns: ["x"], preview: [[999]], offset: 0, limit: 25,
    sort_by: "", sort_desc: false, filter: "", truncated_rows: false, truncated_columns: false,
  } });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = controller.snapshot();
  assert.equal(snapshot.lastValue, null);
  const lazyOutput = snapshot.cells.find((cell) => cell.id === "b")?.outputs[0]?.data as
    | Record<string, unknown>
    | undefined;
  const tableOutput = snapshot.cells.find((cell) => cell.id === "c")?.outputs[0]?.data as
    | Record<string, unknown>
    | undefined;
  assert.equal(lazyOutput?.child, null);
  assert.equal(tableOutput?.page, undefined);
  assert.deepEqual(tableOutput?.preview, [[1]]);
  for (const operationId of [inspect.requestId, lazy.requestId, table.requestId]) {
    assert.equal(snapshot.operations.find((operation) => operation.id === operationId)?.result, null);
  }
  await controller.close();
});
test("output queries read bounded artifact pages without user JSON handle collisions", async () => {
  const sessionEpoch = randomUUID();
  const outputStore = new OutputStore({
    artifactDirectory: join(tmpdir(), "alder-controller-output-query-" + randomUUID()),
    sessionEpoch,
    documentRevision: 0,
    kernelEpoch: null,
  });
  const descriptor = await outputStore.writeStaticArtifact(
    Buffer.from("artifact", "utf8"),
    "text/plain",
    ".txt",
    { sessionEpoch, documentRevision: 0, kernelEpoch: null, runId: null, cellId: null, revision: null },
  );
  const binaryDescriptor = await outputStore.writeStaticArtifact(
    Uint8Array.from([0xff, 0xfe, 0xfd]),
    "application/octet-stream",
    ".bin",
    { sessionEpoch, documentRevision: 0, kernelEpoch: null, runId: null, cellId: null, revision: null },
  );
  const malformedTextDescriptor = await outputStore.writeStaticArtifact(
    Uint8Array.from([0x80, 0xef, 0xbb, 0xbf, 0x61]),
    "text/html",
    ".html",
    { sessionEpoch, documentRevision: 0, kernelEpoch: null, runId: null, cellId: null, revision: null },
  );
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    outputStore,
    epoch: sessionEpoch,
  });
  await controller.start();

  const page = await controller.query({ type: "output", handle: descriptor.handle, offset: 0, limit: 3 });
  assert.deepEqual(page.result, { encoding: "utf8", offset: 0, nextOffset: 3, eof: false, data: "art" });
  const tail = await controller.query({ type: "output", handle: descriptor.handle, offset: 3, limit: 8 });
  const binary = await controller.query({ type: "output", handle: binaryDescriptor.handle, offset: 0, limit: 1 });
  assert.deepEqual(binary.result, { encoding: "base64", offset: 0, nextOffset: 1, eof: false, data: "/w==" });
  const malformedText = await controller.query({ type: "output", handle: malformedTextDescriptor.handle, offset: 0, limit: 1 });
  assert.deepEqual(malformedText.result, { encoding: "base64", offset: 0, nextOffset: 1, eof: false, data: "gA==" });
  const embeddedBom = await controller.query({ type: "output", handle: malformedTextDescriptor.handle, offset: 1, limit: 4 });
  assert.deepEqual(embeddedBom.result, { encoding: "utf8", offset: 1, nextOffset: 5, eof: true, data: "\ufeffa" });
  assert.deepEqual(tail.result, { encoding: "utf8", offset: 3, nextOffset: 8, eof: true, data: "ifact" });
  await assert.rejects(
    () => controller.query({ type: "output", handle: "user-json-handle", offset: 0, limit: 25 }),
    (error: unknown) => error instanceof ControllerError && error.code === "not_found",
  );
  await assert.rejects(
    () => controller.query({ type: "output", handle: descriptor.handle, offset: 0, limit: 262_145 }),
    (error: unknown) => error instanceof ControllerError && error.code === "invalid_request",
  );
  await controller.close();
});

test("Stop cancels explicit value inspection without blocking later edits", async () => {
  const engine = new FakeEngine();
  let resolveInspection!: (response: EngineResponse) => void;
  engine.requestHandler = async (name) => name === "get_value"
    ? new Promise((resolve) => { resolveInspection = resolve; })
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, run);
  await settle(controller, run.requestId);

  const inspect = command(controller, { type: "inspect", name: "x" });
  await startCommand(controller, inspect);
  await eventually(() => resolveInspection !== undefined);
  const stop = command(controller, { type: "interrupt" });
  await startCommand(controller, stop);
  assert.equal((await settle(controller, stop.requestId)).error, null);
  const cancelled = await controller.awaitOperation(inspect.requestId, "controller-tests");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error?.code, "interrupted");
  assert.equal(engine.requestSignals.get("get_value")?.aborted, true);

  const edit = command(controller, {
    type: "transaction",
    changes: [{
      type: "edit",
      cell: { cellId: "a" },
      expectedRevision: 0,
      body: ["x <- 2"],
      cellType: "code",
    }],
  });
  await startCommand(controller, edit);
  assert.equal((await settle(controller, edit.requestId)).error, null);
  resolveInspection({ ok: true, value: { kind: "text", text: "obsolete", truncated: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().lastValue, null);
  await controller.close();
});

test("rerunning an owner expires a lazy request tied to its prior output object", async () => {
  const engine = new FakeEngine();
  let finishLazy!: (response: EngineResponse) => void;
  const controller = createController({
    engine,
    notebook: notebook([["a", "lazy_value <- make_lazy()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);
  engine.requestHandler = async (name) => name === "lazy_eval"
    ? new Promise((resolve) => { finishLazy = resolve; })
    : { ok: true };
  const lazy = command(controller, { type: "lazy-output", key: "lazy-1" });
  await startCommand(controller, lazy);
  await eventually(() => finishLazy !== undefined);
  const rerun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, rerun);
  await settle(controller, rerun.requestId);
  assert.equal((await controller.awaitOperation(lazy.requestId, "controller-tests")).error?.code, "lazy_expired");
  finishLazy({ ok: true, output: { kind: "text", text: "obsolete lazy", truncated: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!JSON.stringify(controller.snapshot()).includes("obsolete lazy"));
  await controller.close();
});

test("lazy output completion uses the public loaded state and preserves renderer conditions", async () => {
  const engine = new FakeEngine();
  engine.requestHandler = async (name) => name === "lazy_eval"
    ? {
        ok: true,
        output: { kind: "text", text: "rendered", truncated: false },
        log: ["renderer-message", "Warning: renderer-warning"],
      }
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "lazy_value <- make_lazy()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);

  const expand = command(controller, { type: "lazy-output", key: "lazy-1" });
  await startCommand(controller, expand);
  await settle(controller, expand.requestId);

  const cell = controller.snapshot().cells[0]!;
  assert.deepEqual(cell.log, ["renderer-message", "Warning: renderer-warning"]);
  assert.deepEqual(cell.outputs[0]?.data, {
    kind: "lazy",
    key: "lazy-1",
    label: "lazy",
    state: "ready",
    child: { kind: "text", text: "rendered", truncated: false },
  });
  await controller.close();
});

test("uploads use the file widget journal and retain successful stored values", async () => {
  const engine = new FakeEngine();
  const serviceCalls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  engine.requestHandler = async (name, payload) => name === "set_widget"
    ? { ok: true, selected: { type: typeof payload.value === "boolean" ? "logical" : "double", value: payload.value } }
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "files <- ui$file()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name, payload) => {
        serviceCalls.push({ name, payload: structuredClone(payload) });
        if (name === "upload.store") {
          return {
            uploadId: "upload-1",
            value: [{ name: "data.csv", size: 4, path: "/tmp/upload-1" }],
          };
        }
        if (name === "upload.remove") return {};
        throw new Error(`unexpected service: ${name}`);
      },
    },
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);

  const upload = command(controller, {
    type: "upload",
    name: "files",
    path: [],
    files: [{ name: "data.csv", content_base64: "eAo=" }],
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, upload);
  const operation = await settle(controller, upload.requestId);
  assert.equal(operation.kind, "widget");
  assert.deepEqual(serviceCalls[0], {
    name: "upload.store",
    payload: { files: [{ name: "data.csv", content_base64: "eAo=" }] },
  });
  assert.deepEqual(
    engine.requests.find((request) => request.command === "set_widget")?.payload.value,
    [{ name: "data.csv", size: 4, path: "/tmp/upload-1" }],
  );
  const output = controller.snapshot().cells[0]?.outputs[0] as {
    data: {
      spec: { value: unknown };
      operation: { operationId: string; status: string };
    };
  };
  assert.deepEqual(output.data.spec.value, [{ name: "data.csv", size: 4, path: "/tmp/upload-1" }]);
  assert.equal(output.data.operation.operationId, upload.requestId);
  assert.equal(output.data.operation.status, "done");
  assert.deepEqual(serviceCalls.filter((call) => call.name === "upload.remove"), [{ name: "upload.remove", payload: { uploadId: "upload-1" } }]);
  await controller.close();
});

test("an upload stored after its widget owner changes is removed and never reaches R", async () => {
  const engine = new FakeEngine();
  let finishStore!: (value: unknown) => void;
  const removed: string[] = [];
  const controller = createController({
    engine,
    notebook: notebook([["a", "files <- ui$file()"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name) => {
        if (name === "upload.store") {
          return new Promise((resolve) => { finishStore = resolve; });
        }
        if (name === "upload.remove") {
          removed.push("upload-stale");
          return {};
        }
        throw new Error(`unexpected service: ${name}`);
      },
    },
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  const upload = command(controller, {
    type: "upload",
    name: "files",
    path: [],
    files: [],
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, upload);
  await eventually(() => finishStore !== undefined);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["files <- ui$file(accept = '.csv')"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  assert.equal((await controller.awaitOperation(upload.requestId, "controller-tests")).status, "cancelled");
  finishStore({
    uploadId: "upload-stale",
    value: [{ name: "data.csv", size: 4, path: "/tmp/upload-stale" }],
  });
  await eventually(() => removed.length === 1);
  assert.equal(engine.requests.some((request) => request.command === "set_widget"), false);
  await controller.close();
});


test("editor diagnostics publish only for an exact source identity and clear on source changes", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const source: CellSnapshot[] = [{ id: "a", revision: 0, type: "code", source: "x <- 1" }];
  assert.equal(controller.publishEditorDiagnostics([
    { ...source[0]!, revision: 1 },
  ], { a: [] }), false);

  assert.equal(controller.publishEditorDiagnostics(source, {
    a: [{ level: "warning", code: "style", message: "Prefer a clearer name", source: "spoofed", range: null }],
    ".document": [{ level: "info", code: "document", message: "Notebook diagnostic", range: null, fileRange: {
      start: { line: 0, character: 0 }, end: { line: 1, character: 1 },
    } }],
    missing: [{ level: "error", code: "unknown", message: "must not escape", range: null }],
  }), true);
  let snapshot = controller.snapshot();
  assert.equal(snapshot.cells[0]?.diagnostics.at(-1)?.source, "lsp");
  assert.deepEqual(Object.keys(snapshot.editorDiagnostics).sort(), [".document", "a"]);
  assert.deepEqual(snapshot.editorDiagnostics[".document"]?.[0]?.fileRange, {
    start: { line: 0, character: 0 }, end: { line: 1, character: 1 },
  });
  assert.equal(snapshot.editorDiagnostics.missing, undefined);

  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  await settle(controller, edit.requestId);
  snapshot = controller.snapshot();
  assert.deepEqual(snapshot.editorDiagnostics, {});
  assert.ok(snapshot.cells[0]?.diagnostics.every((diagnostic) => diagnostic.source !== "lsp"));
  assert.equal(controller.publishEditorDiagnostics(source, { a: [] }), false);
  await controller.close();
});

test("recovery baseline revision is preserved by the first durable transaction", async () => {
  const commits: Array<{ fromRevision: number; toRevision: number; delta: unknown; fingerprint: string }> = [];
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    initialDocumentRevision: 7,
    durableCommit: async (commit) => { commits.push(commit); },
  });
  await controller.start();
  assert.equal(controller.snapshot().documentRevision, 7);

  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  const operation = await settle(controller, edit.requestId);
  assert.equal(operation.result?.documentRevision, 8);
  assert.equal(controller.snapshot().documentRevision, 8);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.fromRevision, 7);
  assert.equal(commits[0]?.toRevision, 8);
  await controller.close();
});

test("variable snapshots wait for idle input, retain ownership, and reject late refreshes after edits", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = new FakeEngine();
  engine.handshake = {
    ...HANDSHAKE,
    capabilities: [...HANDSHAKE.capabilities, "variables"],
  };
  engine.requestHandler = async (name) => name === "env_snapshot"
    ? {
        ok: true,
        variables: [{
          name: "x", class: "numeric", dim: null, size: 56, widget: false,
          value_summary: "42",
        }],
      }
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 42"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  const variableEvents: unknown[] = [];
  controller.subscribe((event) => {
    if (event.type === "variables") variableEvents.push(event.payload);
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  assert.equal(engine.requests.some((request) => request.command === "env_snapshot"), false);
  context.mock.timers.tick(100);
  await eventually(() => controller.snapshot().variables.length === 1);
  assert.deepEqual(controller.snapshot().variables, [{
    name: "x",
    owner: "a",
    revision: 0,
    class: "numeric",
    dim: null,
    size: 56,
    widget: false,
    valueSummary: "42",
  }]);
  assert.ok(variableEvents.length > 0);

  let resolveRefresh!: (response: EngineResponse) => void;
  engine.requestHandler = async (name) => name === "env_snapshot"
    ? new Promise((resolve) => { resolveRefresh = resolve; })
    : { ok: true };
  const rerun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, rerun);
  await settle(controller, rerun.requestId);
  context.mock.timers.tick(100);
  await eventually(() => resolveRefresh !== undefined);
  assert.deepEqual(controller.snapshot().variables, []);

  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 43"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  resolveRefresh({
    ok: true,
    variables: [{ name: "x", class: "numeric", dim: null, size: 56, widget: false }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().variables, []);
  await controller.close();
});

test("automatic variable snapshot failures stay quiet and nonfatal", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = new FakeEngine();
  engine.handshake = {
    ...HANDSHAKE,
    capabilities: [...HANDSHAKE.capabilities, "variables"],
  };
  engine.requestHandler = async (name) => name === "env_snapshot"
    ? { ok: false, error: { message: "environment inspection failed", code: "r_error", transport: true } }
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 42"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, run);
  const operation = await settle(controller, run.requestId);
  assert.equal(operation.error, null);
  context.mock.timers.tick(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().lastActionError, null);

  engine.requestHandler = async (name) => {
    if (name === "env_snapshot") throw new Error("snapshot transport closed");
    return { ok: true };
  };
  const rerun = command(controller, { type: "run", scope: "cell", target: { cellId: "a" }, changes: [] });
  await startCommand(controller, rerun);
  assert.equal((await settle(controller, rerun.requestId)).error, null);
  context.mock.timers.tick(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().lastActionError, null);
  await controller.close();
});

test("runtime availability failures survive source edits and save until restart recovery", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: { ...notebook([["a", "x <- 1"]]), path: "/tmp/runtime-init.R" },
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      const document = request.document ?? context.document;
      context.preparePublication({
        document,
        path: document.path ?? context.path,
        config: context.config,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: request.kind !== "save",
        advanceRevision: request.kind === "transaction",
      })();
      return { committed: request.kind };
    },
  });
  await controller.start();

  controller.recordActionError("ordinary action failure");
  assert.deepEqual(controller.snapshot().lastActionError, {
    code: "internal_error", message: "ordinary action failure",
  });
  assert.equal(controller.snapshot().runtime.executionBlockedReason, null);

  for (const listener of engine.failureListeners) listener("kernel", new Error("kernel lost"));
  const unavailable = controller.snapshot();
  assert.equal(unavailable.runtime.executionReady, false);
  assert.deepEqual(unavailable.runtime.executionBlockedReason, {
    code: "worker_unavailable",
    message: "kernel lost; outputs are stale. Restart R to replay the notebook",
  });

  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  await settle(controller, edit.requestId);
  assert.deepEqual(controller.snapshot().runtime.executionBlockedReason, unavailable.runtime.executionBlockedReason);

  const save = command(controller, { type: "save" });
  await startCommand(controller, save);
  await settle(controller, save.requestId);
  assert.equal(controller.snapshot().lastActionError, null);
  assert.deepEqual(controller.snapshot().runtime.executionBlockedReason, unavailable.runtime.executionBlockedReason);

  engine.restartHandler = async () => { throw new Error("restart failed"); };
  const failedRestart = command(controller, { type: "restart", replay: false });
  const failedStarted = await startCommand(controller, failedRestart);

  const failedOperation = await controller.awaitOperation(failedRestart.requestId, "controller-tests");
  assert.equal(failedOperation.status, "error");
  assert.deepEqual(controller.snapshot().runtime.executionBlockedReason, {
    code: "worker_unavailable", message: "restart failed",
  });

  engine.restartHandler = async () => engine.handshake;
  const restart = command(controller, { type: "restart", replay: false });
  await startCommand(controller, restart);
  await settle(controller, restart.requestId);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().runtime.executionBlockedReason, null);
  await controller.close();
});
test("kernel state invalidation preserves the cell error and blocks until explicit restart", async () => {
  const engine = new FakeEngine();
  engine.evaluationHandler = async () => ({
    ok: false,
    outputs: [],
    error: { code: "eval_error", message: "cell failure" },
    kernelStateInvalid: { code: "kernel_state_invalid", message: "Alder kernel state is invalid; restart the kernel" },
  });
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();

  const firstRun = command(controller, {
    type: "run",
    scope: "cell",
    target: { cellId: "a" },
    changes: [],
  });
  const firstStarted = await startCommand(controller, firstRun);
  const firstOperation = await controller.awaitOperation(firstStarted.requestId, "controller-tests");
  assert.equal(firstOperation.status, "error");
  assert.equal(firstOperation.error?.code, "kernel_state_invalid");
  assert.equal(controller.snapshot().cells[0]?.error?.code, "eval_error");
  assert.equal(controller.snapshot().runtime.executionBlockedReason?.code, "kernel_state_invalid");

  const edit = command(controller, {
    type: "transaction",
    changes: [{ type: "edit", cell: { cellId: "a" }, expectedRevision: 0, body: ["x <- 2"], cellType: "code" }],
  });
  await startCommand(controller, edit);
  assert.equal((await controller.awaitOperation(edit.requestId, "controller-tests")).status, "done");

  const blockedRun = command(controller, {
    type: "run",
    scope: "cell",
    target: { cellId: "a" },
    changes: [],
  });
  const blockedStarted = await startCommand(controller, blockedRun);
  const blockedOperation = await controller.awaitOperation(blockedStarted.requestId, "controller-tests");
  assert.equal(blockedOperation.status, "error");
  assert.equal(blockedOperation.error?.code, "kernel_state_invalid");
  assert.equal(engine.evaluations.length, 1);

  const restart = command(controller, { type: "restart", replay: false });
  await startCommand(controller, restart);
  assert.equal((await controller.awaitOperation(restart.requestId, "controller-tests")).status, "done");
  assert.equal(controller.snapshot().runtime.executionBlockedReason, null);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  await controller.close();
});
test("concurrent project cache changes serialize and reject stale sidecar versions", async () => {
  const calls: string[] = [];
  let releaseWrite!: () => void;
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "sidecar");
      assert.equal(request.sidecar, "config");
      const patch = request.patch as { cache: { dir: string } };
      const config = { ...context.config, cache: { ...context.config.cache, dir: patch.cache.dir } };
      calls.push(patch.cache.dir);
      await new Promise<void>(resolve => { releaseWrite = resolve; });
      context.preparePublication({
        document: context.document, path: context.path, config,
        layout: context.layout, disk: context.disk,
        sidecars: { ...context.sidecars, config: { state: "present", digest: "a".repeat(64), version: "cache-a" } },
        dirty: false, advanceRevision: false,
      })();
      return { config };
    },
  });
  await controller.start();
  const first = controller.dispatch(command(controller, { type: "set-config", patch: { cache: { dir: "cache-a" } } }));
  const second = controller.dispatch(command(controller, { type: "set-config", patch: { cache: { dir: "cache-b" } } }));
  await eventually(() => calls.length === 1);
  releaseWrite();
  assert.equal((await first).error, null);
  assert.equal((await second).error?.code, "source_conflict");
  assert.deepEqual(calls, ["cache-a"]);
  assert.equal(controller.snapshot().config.cache.dir, "cache-a");
  assert.equal(controller.snapshot().config.theme, "system");
  assert.equal(controller.snapshot().dirty, false);
  await controller.close();
});

test("runtime controls update notebook metadata and current settings together", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    config: resolveSettings({ notebook: { on_cell_change: "automatic", on_startup: true } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "runtime");
      const patch = request.patch as { on_cell_change: "lazy"; on_startup: false; cache: { enabled: false } };
      const metadata = { ...context.document.metadata, runtime: patch };
      const config = { ...context.config, on_cell_change: patch.on_cell_change, on_startup: patch.on_startup,
        cache: { ...context.config.cache, enabled: patch.cache.enabled } };
      context.preparePublication({
        document: { ...context.document, metadata }, path: context.path, config,
        layout: context.layout, disk: context.disk, sidecars: context.sidecars,
        dirty: true, advanceRevision: true,
      })();
      return { config };
    },
  });
  await controller.start();
  const result = await controller.dispatch(command(controller, {
    type: "set-runtime", on_cell_change: "lazy", on_startup: false, cache_enabled: false,
  }));
  assert.equal(result.error, null);
  const state = controller.snapshot();
  assert.deepEqual(state.metadata.runtime, { on_cell_change: "lazy", on_startup: false, cache: { enabled: false } });
  assert.equal(state.config.on_cell_change, "lazy");
  assert.equal(state.config.on_startup, false);
  assert.equal(state.config.cache.enabled, false);
  assert.equal(state.dirty, true);
  const queried = (await controller.query({ type: "config" })).result;
  assert.deepEqual(queried, { config: state.config, preferencesVersion: null, sidecar: state.sidecars.config });
  assert.equal(state.runtime.executionMode, "lazy");
  assert.equal(state.runtime.runOnStartup, false);
  await controller.close();
});
test("application preferences refresh every view without changing notebook settings or source", async () => {
  const controller = createController({
    engine: new FakeEngine(), notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false, on_cell_change: "lazy", cache: { enabled: false } }, project: { cache: { dir: "project-cache" } } }),
    preferencesVersion: "preferences-v1",
  });
  const before = controller.snapshot();
  controller.updatePreferences({ ...preferenceDefaults(), theme: "dark", keymap: "vim" }, "preferences-v2");
  const after = controller.snapshot();
  assert.equal(after.config.theme, "dark");
  assert.equal(after.config.keymap, "vim");
  assert.equal(after.config.on_cell_change, "lazy");
  assert.equal(after.config.on_startup, false);
  assert.deepEqual(after.config.cache, { enabled: false, dir: "project-cache" });
  assert.equal(after.preferencesVersion, "preferences-v2");
  assert.equal(after.documentRevision, before.documentRevision);
  assert.equal(after.dirty, before.dirty);
  assert.deepEqual(after.metadata, before.metadata);
  assert.deepEqual(after.cells, before.cells);
  await controller.close();
});

test("persisted layout updates do not mark clean notebook source dirty", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.sidecar, "layout");
      const layout = request.layout ?? null;
      context.preparePublication({
        document: context.document,
        path: context.path,
        config: context.config,
        layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: false,
        advanceRevision: true,
      })();
      return { layout };
    },
  });
  await controller.start();
  const layoutCommand = command(controller, {
    type: "set-layout",
    layout: { version: 1, layout: "grid", cells: {} },
    expectedSidecarVersion: null,
  });
  const layoutResult = await controller.dispatch(layoutCommand);
  assert.equal(layoutResult.error, null);
  assert.deepEqual(controller.snapshot().layout, { version: 1, layout: "grid", cells: {} });
  assert.equal(controller.snapshot().dirty, false);
  await controller.close();
});

test("source query returns the authoritative cell bodies", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const response = await controller.query({ type: "source" });
  assert.deepEqual(response.result, [{
    id: "a",
    type: "code",
    body: ["x <- 1"],
    revision: 0,
    options: {},
  }]);
  await controller.close();
});

test("package installation is asynchronous, leaves edits and runs responsive, and revalidates", async () => {
  const engine = new FakeEngine();
  let finishInstall!: (value: unknown) => void;
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const refreshedEnvironment: REnvironment = {
    rscript: "/tmp/Rscript",
    rHome: "/tmp/R",
    version: "4.6.0",
    platform: "linux",
    arch: "x64",
    libraryPaths: ["/tmp/alder-library"],
    identity: "a".repeat(64),
  };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      refreshPackageEnvironment: async () => refreshedEnvironment,
      service: async (name, payload) => {
        calls.push({ name, payload: structuredClone(payload) });
        if (name === "packages.install") {
          return new Promise((resolve) => { finishInstall = resolve; });
        }
        if (name === "packages.status") {
          return { declared: ["dplyr"], installed: ["dplyr"], missing: [] };
        }
        throw new Error(`unexpected service: ${name}`);
      },
    },
  });
  await controller.start();
  const firstRun = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, firstRun);
  await settle(controller, firstRun.requestId);

  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  const accepted = await startCommand(controller, install);
  assert.ok(controller.operation(accepted.requestId, "controller-tests"));
  await eventually(() => controller.snapshot().operations.find((operation) => operation.id === install.requestId)?.status === "running");
  assert.equal(controller.snapshot().operations.find((operation) => operation.id === install.requestId)?.status, "running");

  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2"],
            cellType: "code"
        }
    ]
  });
  await startCommand(controller, edit);
  await settle(controller, edit.requestId);
  assert.equal(controller.snapshot().cells[0]?.revision, 1);
  const overlappingRun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 1,
            body: ["x <- 3"],
            cellType: "code"
        }
    ]
  });
  const overlappingStarted = await startCommand(controller, overlappingRun);
  const overlappingOperation = await controller.awaitOperation(overlappingStarted.requestId, "controller-tests");
  assert.equal(overlappingOperation.status, "done");
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 3"]);

  finishInstall({ ok: true, status: "installed", packages: ["dplyr"] });
  const settled = await settle(controller, install.requestId);
  assert.equal(engine.restartCount, 1);
  assert.deepEqual(controller.snapshot().runtime.rEnvironment, refreshedEnvironment);
  assert.equal(controller.snapshot().runtime.analysisEnvironmentId, "analysis-test");
  assert.equal(controller.snapshot().operations.find((operation) => operation.id === install.requestId)?.status, "done");
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().cells[0]?.status, "stale");
  assert.ok(calls.filter((call) => call.name === "packages.status").length >= 1);
  assert.equal((settled.result as { result: { status: string } }).result.status, "installed");
  await controller.close();
});

test("package progress remains scoped to the running install operation", async () => {
  const engine = new FakeEngine();
  let finishInstall!: (value: unknown) => void;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name) => name === "packages.install"
        ? new Promise((resolve) => { finishInstall = resolve; })
        : { declared: [], installed: [], missing: [] },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, install);
  await eventually(() => controller.operation(install.requestId, "controller-tests")?.status === "running");
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "operation" && event.operationId === install.requestId) events.push(event);
  }, ["operation"]);
  const progress = { phase: "output", stream: "stdout", text: "installing dplyr", data: { package: "dplyr" } };
  controller.publishPackageProgress(install.requestId, progress);
  assert.deepEqual(controller.operation(install.requestId, "controller-tests")?.progress, progress);
  assert.deepEqual((events.at(-1)?.payload as { progress?: unknown }).progress, progress);

  finishInstall({ ok: true, status: "installed", packages: ["dplyr"] });
  const settled = await settle(controller, install.requestId);
  assert.equal(settled.status, "done");
  const terminalProgress = controller.operation(install.requestId, "controller-tests")?.progress;
  assert.deepEqual(terminalProgress, progress);
  const eventCount = events.length;
  controller.publishPackageProgress(install.requestId, { phase: "output", text: "late callback" });
  assert.equal(events.length, eventCount);
  assert.deepEqual(controller.operation(install.requestId, "controller-tests")?.progress, terminalProgress);
  unsubscribe();
  await controller.close();
});

test("package installation cancellation aborts its owned service", async () => {
  let installStarted!: () => void;
  const started = new Promise<void>((resolve) => { installStarted = resolve; });
  let aborted = false;
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name, _payload, context) => {
        if (name === "packages.status") return { declared: [], installed: [], missing: [] };
        if (name !== "packages.install") throw new Error(`unexpected service: ${name}`);
        assert.ok(context);
        installStarted();
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("installer stopped"));
          }, { once: true });
        });
      },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "packages-install", packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, install);
  await started;
  const cancel = command(controller, { type: "cancel-operation", operationId: install.requestId });
  assert.equal((await controller.dispatch(cancel)).error, null);
  const operation = await controller.awaitOperation(install.requestId, "controller-tests");
  assert.equal(operation.status, "cancelled");
  assert.equal(aborted, true);
  await controller.close();
});

test("package restart pending rejects new runs until restart completes", async () => {
  const engine = new FakeEngine();
  let restartStarted!: () => void;
  const restarting = new Promise<void>((resolve) => { restartStarted = resolve; });
  let finishRestart!: (value: EngineHandshake) => void;
  engine.restartHandler = async () => {
    restartStarted();
    return new Promise<EngineHandshake>((resolve) => { finishRestart = resolve; });
  };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name) => name === "packages.install"
        ? { ok: true, mutatedLibrary: true }
        : { declared: [], installed: [], missing: [] },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "packages-install", packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, install);
  await restarting;

  const run = command(controller, {
    type: "run", scope: "cell", target: { cellId: "a" },
    changes: [{ type: "edit", cell: { cellId: "a" }, expectedRevision: 0, body: ["x <- 2"], cellType: "code" }],
  });
  await startCommand(controller, run);
  const blocked = await controller.awaitOperation(run.requestId, "controller-tests");
  assert.equal(blocked.status, "error");
  assert.equal(blocked.error?.code, "operation_in_progress");
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 1"]);

  finishRestart(HANDSHAKE);
  assert.equal((await controller.awaitOperation(install.requestId, "controller-tests")).status, "done");
  const reopened = command(controller, { type: "run", scope: "all", changes: [] });
  await startCommand(controller, reopened);
  assert.equal((await controller.awaitOperation(reopened.requestId, "controller-tests")).status, "done");
  await controller.close();
});

test("failed package installation still restarts and reanalyzes before settling error", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name) => name === "packages.install"
        ? { ok: false, status: "error", error: { code: "install_failed", message: "no archive" } }
        : { declared: [], installed: [], missing: [] },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, install);
  const operation = await controller.awaitOperation(install.requestId, "controller-tests");
  assert.equal(operation.status, "error");
  assert.equal(operation.error?.code, "install_failed");
  assert.equal(engine.restartCount, 1);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  await controller.close();
});

test("failed package installation without library mutation does not restart runtime", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name) => name === "packages.install"
        ? { ok: false, status: "error", mutatedLibrary: false, error: { code: "r_not_found", message: "R is unavailable" } }
        : { declared: [], installed: [], missing: [] },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, install);
  const operation = await controller.awaitOperation(install.requestId, "controller-tests");
  assert.equal(operation.status, "error");
  assert.equal(operation.error?.code, "r_not_found");
  assert.equal(engine.restartCount, 0);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  await controller.close();
});

test("successful package installation without library mutation does not restart runtime", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine, notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: { service: async (name) => name === "packages.install"
      ? { ok: true, status: "ready", mutatedLibrary: false }
      : { declared: [], installed: [], missing: [] } },
  });
  await controller.start();
  const install = command(controller, { type: "packages-install", packages: ["dplyr"], expectedDocumentRevision: controller.snapshot().documentRevision, kernelEpoch: controller.snapshot().runtime.kernelEpoch });
  await startCommand(controller, install);
  const operation = await controller.awaitOperation(install.requestId, "controller-tests");
  assert.equal(operation.status, "done");
  assert.equal(engine.restartCount, 0);
  await controller.close();
});

test("installer failure remains primary when package restart fails", async () => {
  const engine = new FakeEngine();
  engine.restartHandler = async () => { throw new Error("restart failed"); };
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: {
      service: async (name) => name === "packages.install"
        ? { ok: false, status: "error", error: { code: "install_failed", message: "no archive" } }
        : { declared: [], installed: [], missing: [] },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await startCommand(controller, install);
  const operation = await controller.awaitOperation(install.requestId, "controller-tests");
  assert.equal(operation.status, "error");
  assert.equal(operation.error?.code, "install_failed");
  assert.equal(engine.restartCount, 1);
  assert.equal(controller.snapshot().runtime.executionReady, false);
  assert.equal(controller.snapshot().runtime.executionBlockedReason?.code, "worker_unavailable");
  const details = operation.error?.details;
  assert.ok(details && typeof details === "object" && !Array.isArray(details));
  const detailRecord = details as Record<string, unknown>;
  assert.deepEqual(detailRecord.result, {
    ok: false,
    status: "error",
    error: { code: "install_failed", message: "no archive" },
  });
  assert.ok(detailRecord.restartFailure && typeof detailRecord.restartFailure === "object");
  const restartFailure = detailRecord.restartFailure as Record<string, unknown>;
  assert.equal(restartFailure.code, "worker_unavailable");
  assert.match(String(restartFailure.message), /restart failed/);
  await controller.close();
});

test("package installation overlaps an active run and waits to restart R", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  let serviceCalls = 0;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
    services: { service: async () => { serviceCalls += 1; return {}; } },
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await eventually(() => controller.snapshot().runtime.busy);
  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  const installStarted = await startCommand(controller, install);
  await eventually(() => serviceCalls > 0);
  assert.equal(controller.operation(installStarted.requestId, "controller-tests")?.status, "running");
  engine.finishEvaluation();
  await settle(controller, run.requestId);
  const installOperation = await controller.awaitOperation(installStarted.requestId, "controller-tests");
  assert.equal(installOperation.status, "done");
  assert.ok(serviceCalls >= 1);
  await controller.close();
});

test("an empty run-button plan remains unsettled until its causal reset completes", async () => {
  const engine = new FakeEngine();
  let finishReset!: (value: EngineResponse) => void;
  engine.requestHandler = async (name, payload) => {
    if (name === "set_widget" && payload.value === false) {
      return new Promise((resolve) => { finishReset = resolve; });
    }
    return { ok: true };
  };
  const controller = createController({
    engine,
    notebook: {
      path: "/tmp/test.R",
      metadata: {},
      cells: [
        { id: "a", type: "code", body: ["btn <- ui$button()"], options: {}, revision: 0 },
        { id: "b", type: "code", body: ["out <- btn"], options: { disabled: true }, revision: 0 },
      ],
    },
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await startCommand(controller, widget);
  await eventually(() => finishReset !== undefined);
  const causalRunId = `run-button-${widget.requestId}`;
  const causalRun = controller.operation(causalRunId, "controller-tests");
  assert.ok(causalRun);
  assert.equal(causalRun.status, "accepted");
  assert.equal(causalRun.executionDone, true);
  assert.equal(causalRun.resetOperationIds?.length, 1);
  assert.equal(controller.operation(widget.requestId, "controller-tests")?.status, "running");

  finishReset({ ok: true, selected: { type: "logical", value: false } });
  assert.equal((await controller.awaitOperation(widget.requestId, "controller-tests")).status, "done");
  assert.equal((await controller.awaitOperation(causalRunId, "controller-tests")).status, "done");
  const output = controller.snapshot().cells[0]?.outputs[0] as { data: { spec: { value: boolean } } };
  assert.equal(output.data.spec.value, false);
  await controller.close();
});

test("a lazy explicit run settles only after its linked run-button reset", async () => {
  const engine = new FakeEngine();
  let finishReset!: (value: EngineResponse) => void;
  engine.requestHandler = async (name, payload) => {
    if (name === "set_widget" && payload.value === false) {
      return new Promise((resolve) => { finishReset = resolve; });
    }
    return { ok: true };
  };
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "btn <- ui$button()"],
      ["b", "seen <- btn"],
      ["c", "result <- seen"],
    ]),
    config: resolveSettings({ notebook: { on_cell_change: "lazy", on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);
  const staleCellEvents: string[] = [];
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "cell" && event.cellId !== undefined
      && (event.payload as { status?: string }).status === "stale") {
      staleCellEvents.push(event.cellId);
    }
  });
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await startCommand(controller, widget);
  await eventually(() => controller.snapshot().cells.find((cell) => cell.id === "c")?.status === "stale");
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "b")?.status, "stale");
  assert.deepEqual(staleCellEvents, ["b", "c"]);
  const explicit = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "b"
    },
    changes: []
  });
  await startCommand(controller, explicit);
  await eventually(() => finishReset !== undefined);
  const pendingRun = controller.operation(explicit.requestId, "controller-tests");
  assert.equal(pendingRun?.executionDone, true);
  assert.equal(pendingRun?.status, "running");
  assert.equal(pendingRun?.resetOperationIds?.length, 1);
  finishReset({ ok: true, selected: { type: "logical", value: false } });
  await settle(controller, widget.requestId);
  await settle(controller, explicit.requestId);
  assert.equal(
    (controller.snapshot().cells[0]?.outputs[0]?.data as { spec: { value: boolean } }).spec.value,
    false,
  );
  unsubscribe();
  await controller.close();
});

test("nested run buttons reset only their addressed child and journal the reset", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([
      ["a", "controls <- ui$array(go = ui$button(), level = ui$slider(0, 10))"],
      ["b", "seen <- controls"],
    ]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  const widget = command(controller, {
    type: "widget",
    name: "controls",
    path: ["go"],
    update: { value: true },
    source: "editor",
  });
  await startCommand(controller, widget);
  const trigger = await settle(controller, widget.requestId);
  const output = controller.snapshot().cells[0]?.outputs[0] as {
    data: {
      spec: { children: Array<{ name: string; value: unknown }> };
      operations: Record<string, { operationId: string; status: string }>;
    };
  };
  assert.equal(output.data.spec.children.find((child) => child.name === "go")?.value, false);
  assert.equal(output.data.spec.children.find((child) => child.name === "level")?.value, 5);
  const resetId = trigger.resetOperationIds?.[0];
  assert.ok(resetId);
  assert.equal(output.data.operations["controls\u0001go"]?.operationId, resetId);
  assert.equal(output.data.operations["controls\u0001go"]?.status, "done");
  await controller.close();
});

test("a run-button reset failure rejects the trigger and its causal run", async () => {
  const engine = new FakeEngine();
  engine.requestHandler = async (name, payload) => name === "set_widget" && payload.value === false
    ? { ok: false, error: { code: "reset_failed", message: "cannot reset" } }
    : { ok: true };
  const controller = createController({
    engine,
    notebook: notebook([["a", "btn <- ui$button()"], ["b", "seen <- btn"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, initial);
  await settle(controller, initial.requestId);
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await startCommand(controller, widget);
  const trigger = await controller.awaitOperation(widget.requestId, "controller-tests");
  const causalRun = await controller.awaitOperation(`run-button-${widget.requestId}`, "controller-tests");
  assert.equal(trigger.status, "error");
  assert.equal(trigger.error?.code, "widget_update_failed");
  assert.equal(trigger.error?.message, "cannot reset");
  assert.equal(trigger.error?.operationId, widget.requestId);
  assert.equal(causalRun.status, "error");
  assert.equal(causalRun.error?.code, "widget_update_failed");
  assert.equal(causalRun.error?.message, "cannot reset");
  assert.equal(causalRun.error?.operationId, causalRun.id);
  const output = controller.snapshot().cells[0]?.outputs[0] as {
    data: { operation: { status: string; error: { code: string } } };
  };
  assert.equal(output.data.operation.status, "error");
  assert.equal(output.data.operation.error.code, "widget_update_failed");
  await controller.close();
});

test("closing invalidates outstanding runtime requests and discards late replies", async () => {
  const engine = new FakeEngine();
  let finishInspection!: (value: EngineResponse) => void;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    config: resolveSettings({ notebook: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await startCommand(controller, run);
  await settle(controller, run.requestId);
  engine.requestHandler = async (name) => name === "get_value"
    ? new Promise((resolve) => { finishInspection = resolve; })
    : { ok: true };
  const inspect = command(controller, { type: "inspect", name: "x" });
  await startCommand(controller, inspect);
  await eventually(() => finishInspection !== undefined);
  await controller.close();
  finishInspection({ ok: true, value: 99 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().lastValue, null);
  assert.equal(controller.operation(inspect.requestId, "controller-tests")?.status, "error");
});
test("command completion commits one concurrent writer and reports the other revision conflict", async () => {
  const controller = createController({ engine: new FakeEngine(), notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  const edit = (body: string) => command(controller, {
    type: "transaction", expectedDocumentRevision: 0,
    changes: [{ type: "edit", cell: { cellId: "a" }, expectedRevision: 0, body: [body], cellType: "code" }],
  });
  try {
    const gui = edit("x <- 2");
    const agent = { ...edit("x <- 3"), clientId: "agent" };
    const [first, second] = await Promise.all([controller.dispatch(gui), controller.dispatch(agent)]);
    assert.equal(first.requestId, gui.requestId);
    assert.equal(first.error, null);
    assert.equal(second.error?.code, "source_conflict");
    assert.equal(first.documentRevision, 1);
    assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 2"]);
    assert.deepEqual(controller.snapshot().operations, []);
    assert.equal("operation" in first, false);
  } finally { await controller.close(); }
});

test("lost run responses retry once across leases and stay deduplicated beyond ordinary result retention", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({ engine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  try {
    await controller.start();
    const run = command(controller, { type: "run", scope: "all" });
    let completed = false;
    const lostResponse = controller.dispatch(run).then(result => { completed = true; return result; });
    await eventually(() => engine.pendingEvaluations.length === 1);
    const retried = controller.dispatch({ ...run, clientId: "reconnected-gui" });
    assert.equal(completed, false);
    assert.equal(engine.evaluations.length, 1);
    engine.finishEvaluation();
    const first = await lostResponse;
    assert.equal(first.error, null);
    assert.deepEqual(await retried, first);
    for (let i = 0; i < 520; i += 1) {
      const edit = command(controller, { type: "transaction", changes: [] });
      assert.equal((await controller.dispatch(edit)).error, null);
    }
    await assert.rejects(controller.dispatch({ ...run, clientId: "another-lease" }), { code: "request_expired" });
    assert.equal(engine.evaluations.length, 1);
    await assert.rejects(controller.dispatch({ ...run, scope: "stale" } as HostCommand), { code: "request_id_conflict" });

    const restartedEngine = new FakeEngine();
    const restarted = createController({ engine: restartedEngine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
    try {
      await assert.rejects(restarted.dispatch(run), { code: "session_epoch_mismatch" });
      assert.equal(restartedEngine.evaluations.length, 0);
      assert.equal(restartedEngine.startCount, 0);
    } finally { await restarted.close(); }
  } finally { await controller.close(); }
});

test("distinct run requests execute FIFO and each response waits for its own completion", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({ engine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  try {
    await controller.start();
    const firstCommand = command(controller, { type: "run", scope: "all" });
    const secondCommand = command(controller, { type: "run", scope: "all" });
    const first = controller.dispatch(firstCommand);
    let secondDone = false;
    const second = controller.dispatch(secondCommand).then(result => { secondDone = true; return result; });
    await eventually(() => engine.pendingEvaluations.length === 1);
    assert.equal(engine.evaluations.length, 1);
    engine.finishEvaluation();
    assert.equal((await first).error, null);
    await eventually(() => engine.evaluations.length === 2);
    assert.equal(secondDone, false);
    assert.deepEqual(engine.evaluations.map(value => value.operationId), [firstCommand.requestId, secondCommand.requestId]);
    engine.finishEvaluation();
    assert.equal((await second).error, null);
  } finally { await controller.close(); }
});

test("edits bypass a running request and invalidate an older queued revision", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({ engine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  try {
    await controller.start();
    const first = controller.dispatch(command(controller, { type: "run", scope: "all" }));
    const second = controller.dispatch(command(controller, { type: "run", scope: "all" }));
    await eventually(() => engine.pendingEvaluations.length === 1);
    const edit = await controller.dispatch(command(controller, {
      type: "transaction", changes: [{ type: "create", creationId: "notes", after: { cellId: "a" }, cellType: "markdown", body: ["# unsaved notes"], options: {} }],
    }));
    assert.equal(edit.error, null);
    assert.equal(controller.snapshot().cells[1]?.id, "notes");
    engine.finishEvaluation();
    assert.equal((await first).error, null);
    assert.equal((await second).error?.code, "source_conflict");
    assert.equal(engine.evaluations.length, 1);
  } finally { await controller.close(); }
});

test("Stop bypasses the run queue and cancels waiting runs", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({ engine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  try {
    await controller.start();
    const first = controller.dispatch(command(controller, { type: "run", scope: "all" }));
    const second = controller.dispatch(command(controller, { type: "run", scope: "all" }));
    await eventually(() => engine.pendingEvaluations.length === 1);
    const stop = await controller.dispatch(command(controller, { type: "interrupt" }));
    assert.equal(stop.error, null);
    assert.equal(engine.interrupts.length, 1);
    engine.finishEvaluation({ ok: false, error: { message: "Interrupted", interrupted: true } });
    assert.equal((await first).error?.code, "interrupted");
    assert.equal((await second).error?.code, "interrupted");
    assert.equal(engine.evaluations.length, 1);
  } finally { await controller.close(); }
});

test("a concurrent edit during analysis prevents execution of an unexpected document revision", async () => {
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  try {
    await controller.start();
    const analyze = engine.analyze.bind(engine);
    let release!: () => void;
    let analyzing = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine.analyze = async (cells, revision) => { analyzing = true; await gate; return analyze(cells, revision); };
    const run = controller.dispatch(command(controller, {
      type: "run", scope: "all", changes: [{ type: "edit", cell: { cellId: "a" }, body: ["x <- 2"], expectedRevision: 0, cellType: "code" }],
    }));
    await eventually(() => analyzing);
    const edited = await controller.dispatch(command(controller, {
      type: "transaction", changes: [{ type: "edit", cell: { cellId: "a" }, body: ["x <- 3"], expectedRevision: 1, cellType: "code" }],
    }));
    assert.equal(edited.error, null);
    release();
    assert.equal((await run).error?.code, "source_conflict");
    assert.equal(engine.evaluations.length, 0);
    assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 3"]);
  } finally { await controller.close(); }
});

test("restart replay never evaluates edits made while the kernel was restarting", async () => {
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: notebook([["a", "x <- 1"]]), config: resolveSettings({ notebook: { on_startup: false } }) });
  try {
    await controller.start();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine.restartHandler = async () => { await gate; return HANDSHAKE; };
    const restart = controller.dispatch(command(controller, { type: "restart", replay: true, expectedDocumentRevision: 0 }));
    await eventually(() => engine.restartCount === 1);
    const edit = await controller.dispatch(command(controller, {
      type: "transaction", changes: [{ type: "edit", cell: { cellId: "a" }, expectedRevision: 0, body: ["x <- 9"], cellType: "code" }],
    }));
    assert.equal(edit.error, null);
    release();
    assert.equal((await restart).error?.code, "source_conflict");
    assert.equal(engine.evaluations.length, 0);
    assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 9"]);
  } finally { await controller.close(); }
});
