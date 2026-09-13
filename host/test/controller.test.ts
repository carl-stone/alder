import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import assert from "node:assert/strict";
import test from "node:test";

import { Controller, ControllerError, type ControllerOptions, type SourcePublication } from "../src/controller.js";
import { parseNotebook, serializeNotebook } from "../src/notebook.js";
import { assertConfigPatchEffective, resolveConfigLayers, validateConfigLayer } from "../src/configuration.js";
import { OutputStore } from "../src/outputs.js";
import {
  MAX_DEPENDENCY_EDGES,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  recoverySchema,
} from "../src/protocol.js";
import type {
  AnalysisResult,
  CellSnapshot,
  EngineAdapter,
  EngineEvent,
  EngineHandshake,
  REnvironment,
  EngineResponse,
  EvaluationPayload,
  HostCommand,
  OutputRecord,
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
    buildVersion: "0.1.252-alder.1",
    mimePublisher: "alder-json-v1",
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

  emitEvaluationLog(payload: unknown): void {
    this.emitEvaluationOutput("log", payload);
  }

  emitEvaluationOutput(
    kind: Extract<EngineEvent, { type: "output" }>["kind"],
    payload: unknown,
  ): void {
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

  async request(command: string, payload: Record<string, unknown> = {}): Promise<EngineResponse> {
    this.requests.push({ command, payload: structuredClone(payload) });
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
  const definitions = [...cell.source.matchAll(/\b([A-Za-z][A-Za-z0-9_.]*)\s*<-/g)]
    .map((match) => match[1] as string);
  const rightSides = [...cell.source.matchAll(/<-([^\n]*)/g)].map((match) => match[1] ?? "").join(" ");
  const references = [...rightSides.matchAll(/\b([A-Za-z][A-Za-z0-9_.]*)\b/g)]
    .map((match) => match[1] as string)
    .filter((name) => !definitions.includes(name) && !["TRUE", "FALSE", "library"].includes(name));
  return {
    id: cell.id,
    revision: cell.revision,
    defs: [...new Set(definitions)],
    refs: [...new Set(references)],
    selfRefs: [],
    locals: [],
    barrier: /\b(?:library|source)\s*\(/.test(cell.source),
    opaque: /\bsource\s*\(/.test(cell.source),
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
const commandSequences = new WeakMap<Controller, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedNotebook(source: string) {
  return parseNotebook(new TextEncoder().encode(source), "/tmp/test.R");
}

function serializedNotebookBytes(controller: Controller): Uint8Array {
  return serializeNotebook(controller.notebookDocument());
}

function serializedNotebook(controller: Controller): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(serializedNotebookBytes(controller));
}

function exactLimitNotebookSource(): string {
  const encoder = new TextEncoder();
  const limit = MAX_NOTEBOOK_SOURCE_BYTES;
  const prefix = "\ufeff# title\r\n# noncanonical header\r\n# %%\r\n#| keep: original\r\nx <- 1\r\n";
  const filler = "# filler " + "x".repeat(1_023) + "\r\n";
  const fillerBytes = encoder.encode(filler).byteLength;
  let source = prefix;
  let bytes = encoder.encode(source).byteLength;
  while (bytes + fillerBytes + 1 < limit) {
    source += filler;
    bytes += fillerBytes;
  }
  source += "x".repeat(limit - bytes);
  assert.equal(encoder.encode(source).byteLength, limit);
  assert.equal(source.endsWith("\n"), false);
  return source;
}

function mixedPhysicalSource(): string {
  return "\ufeff# title\r\n# noncanonical header\r\n# %%\r#| foo: one\r#| foo: two\rx <- 1\n# %% markdown\n#| bar: two\nbody";
}
function command<T extends Record<string, unknown>>(
  controller: Controller,
  value: T,
): HostCommand {
  const input = value as Record<string, unknown>;
  const sequence = (commandSequences.get(controller) ?? 0) + 1;
  commandSequences.set(controller, sequence);
  const operationId = "operation-" + (++operationCounter);
  const clientId = "controller-tests";
  const identity = {
    operationId,
    clientId,
    commandSequence: sequence,
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

function mergeTestConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const prior = output[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)
      && prior !== null && typeof prior === "object" && !Array.isArray(prior)) {
      output[key] = mergeTestConfig(prior as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}

test("shutdown requires the complete active client set", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  const events: Array<{ type: string; payload: unknown }> = [];
  const unsubscribe = controller.subscribe(event => events.push(event));
  try {
    controller.registerClient("controller-tests");
    const first = command(controller, { type: "shutdown", expectedDocumentRevision: controller.snapshot().documentRevision, expectedClientIds: ["controller-tests"] });
    const firstAdmissionPromise = controller.dispatch(first);
    controller.registerClient("other-client");
    const firstAdmission = await firstAdmissionPromise;
    assert.equal(firstAdmission.accepted, true);
    const failed = await controller.awaitOperation(first.operationId, "controller-tests");
    assert.equal(failed.status, "error");
    assert.equal(failed.error?.code, "active_clients_changed");

    controller.releaseClient("other-client");
    const second = command(controller, { type: "shutdown", expectedDocumentRevision: controller.snapshot().documentRevision, expectedClientIds: ["controller-tests"] });
    const secondAdmission = await controller.dispatch(second);
    assert.equal(secondAdmission.accepted, true);
    const completed = await controller.awaitOperation(second.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      const document = request.document ?? context.document;
      context.preparePublication({
        document,
        path: document.path ?? context.path,
        configResolution: context.configResolution,
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
  const admission = await controller.dispatch(edit);
  assert.equal(admission.accepted, true);
  await settle(controller, edit.operationId);
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

test("configuration identifies the requested Rscript before runtime bootstrap", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    requestedRscript: "/opt/R/bin/Rscript",
    deferStartup: true,
  });
  assert.deepEqual(controller.configuration(), {
    rscript: "/opt/R/bin/Rscript",
    executionMode: "automatic",
    runOnStartup: false,
    deferStartup: true,
  });
  await controller.close();
});

test("deferred startup reaches readiness without executing source", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: true } }),
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

test("event filters preserve subscriber isolation and the complete recovery journal", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  assert.deepEqual(selected.map(event => event.type), ["cell-completed"]);
  assert.deepEqual(selected.map(event => event.cursor),
    all.filter(event => event.type === "cell-completed").map(event => event.cursor));
  assert.ok(all.some(event => event.type === "cell-started"));
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 1"]);
  const recovery = controller.recover(controller.epoch, cursor);
  assert.equal(recovery.kind, "replay");
  if (recovery.kind === "replay") assert.deepEqual(recovery.events, all);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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

test("explicit restart excludes concurrent source mutation", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  const restarting = controller.dispatch(restart);
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
  const editAdmission = await controller.dispatch(edit);
  const editOperation = await controller.awaitOperation(editAdmission.operationId, "controller-tests");
  assert.equal(editOperation.status, "error");
  assert.equal(editOperation.error?.code, "operation_in_progress");
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 1"]);
  releaseRestart();
  await restarting;
  await controller.awaitOperation(restart.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      commitEntered = true;
      await commitGate;
      const document = request.document ?? context.document;
      context.preparePublication({
        document, path: document.path ?? context.path, configResolution: context.configResolution,
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
    const editAdmission = await controller.dispatch(edit);
    await eventually(() => commitEntered);
    const restart = command(controller, { type: "restart", replay: false });
    const restartAdmission = await controller.dispatch(restart);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(engine.restartCount, 0);
    releaseCommit();
    assert.equal((await controller.awaitOperation(editAdmission.operationId, "controller-tests")).status, "done");
    await eventually(() => engine.restartCount === 1);
    releaseRestart();
    assert.equal((await controller.awaitOperation(restartAdmission.operationId, "controller-tests")).status, "done");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  const restarting = controller.dispatch(restart);
  await eventually(() => engine.restartCount === 1);
  await controller.close();
  const closedOperation = await controller.awaitOperation(restart.operationId, "controller-tests");
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

test("closing during a barrier restart prevents the pump from shifting queued work", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "library(stats)"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["library(stats); x <- 1"],
            cellType: "code"
        }
    ]
  });
  await controller.dispatch(edit);
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);

  let releaseRestart!: () => void;
  const restartGate = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  engine.restartHandler = async () => {
    await restartGate;
    return engine.handshake;
  };
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await eventually(() => engine.restartCount === 1);
  assert.equal(engine.restartCount, 1);
  assert.equal(controller.snapshot().runtime.executionReady, false);
  await controller.close();
  releaseRestart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.evaluations.length, 0);
  assert.equal(controller.snapshot().runtime.executionReady, false);
});

test("optional service-peer failure leaves analysis and execution available", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await settle(controller, run.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  const admission = await controller.dispatch(edit);
  const rejected = await controller.awaitOperation(admission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

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
  await controller.dispatch(edit);
  await settle(controller, edit.operationId);
  const causal = events.filter((event) => event.operationId === edit.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(cleanFormat);
  const cleanResult = await settle(controller, cleanFormat.operationId);
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
  await controller.dispatch(authored);
  const authoredResult = await settle(controller, authored.operationId);
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
  await controller.dispatch(dirtyFormat);
  const dirtyResult = await settle(controller, dirtyFormat.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
    const formatAdmission = await controller.dispatch(format);
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
    const editAdmission = await controller.dispatch(edit);
    const editOperation = await controller.awaitOperation(editAdmission.operationId, "controller-tests");
    assert.equal(editOperation.status, "done", editOperation.error?.message);
    const afterEdit = controller.snapshot();
    assert.equal(afterEdit.documentRevision, before.documentRevision + 1);
    assert.deepEqual(afterEdit.cells[0]?.body, ["x <- 2"]);
    assert.equal(afterEdit.cells[0]?.revision, 1);
    assert.equal(durableBytes.length, 1);
    assert.deepEqual(durableBytes[0], serializedNotebookBytes(controller));

    releaseFormatter({ a: ["x <- 999"] });
    const formatOperation = await controller.awaitOperation(formatAdmission.operationId, "controller-tests");
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

test("creating beyond the admitted notebook bound fails before source or engine effects", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: {
      path: "/tmp/bounded.R",
      metadata: {},
      cells: Array.from({ length: MAX_NOTEBOOK_CELLS }, (_, index) => ({
        id: `cell-${index}`,
        type: "markdown" as const,
        body: [],
        options: {},
        revision: 0,
      })),
    },
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const beforeIds = controller.snapshot().cells.map((cell) => cell.id);
  const create = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "create",
            creationId: "over-limit-cell",
            after: null,
            body: ["x <- 1"],
            cellType: "code",
            options: {}
        }
    ]
  });
  const createAdmission = await controller.dispatch(create);
  const createOperation = await controller.awaitOperation(createAdmission.operationId, "controller-tests");
  assert.equal(createOperation.status, "error");
  assert.equal(createOperation.error?.code, "too_many_cells");
  assert.deepEqual(controller.snapshot().cells.map((cell) => cell.id), beforeIds);
  assert.equal(engine.analysisCalls.length, 0);
  assert.equal(engine.evaluations.length, 0);
  assert.equal(engine.requests.length, 0);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  const editAdmission = await controller.dispatch(edit);
  const editOperation = await controller.awaitOperation(editAdmission.operationId, "controller-tests");
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

test("dependency edge exhaustion stays editable and clears after a bounded repair", { timeout: 30_000 }, async () => {
  const count = Math.ceil((1 + Math.sqrt(1 + 8 * MAX_DEPENDENCY_EDGES)) / 2);
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook(Array.from({ length: count }, (_, index) => [
      `cell-${index}`,
      "library(stats)",
    ] as [string, string])),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const exhausted = controller.snapshot();
  assert.equal(exhausted.graph.topologicalOrder, null);
  assert.equal(exhausted.lastActionError?.code, "graph_blocked");
  assert.ok(exhausted.cells.every((cell) => cell.status === "stale"));

  const repair = command(controller, {
    type: "transaction",
    changes: [
        ...exhausted.cells.map((cell, index) => ({
            type: "edit",
            cell: {
                cellId: cell.id
            },
            expectedRevision: cell.revision,
            body: [`value_${index} <- ${index}`],
            cellType: "code" as const
        }))
    ]
  });
  await controller.dispatch(repair);
  await eventually(() => controller.snapshot().graph.topologicalOrder !== null
    && controller.snapshot().lastActionError === null);
  assert.deepEqual(
    controller.snapshot().graph.topologicalOrder,
    exhausted.cells.map((cell) => cell.id),
  );
  await controller.close();
});

test("one command creates, reconciles, analyzes, and runs an optimistic cell", async () => {
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: notebook([]), configResolution: resolveConfigLayers({ launch: { on_startup: false } }) });
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
  const accepted = await controller.dispatch(run);
  const resultOperation = await controller.awaitOperation(accepted.operationId, "controller-tests");
  const result = resultOperation.result as { created: Record<string, string> };
  assert.deepEqual(result.created, { "focused-editor-1": "cell-1" });
  await settle(controller, run.operationId);
  assert.equal(controller.snapshot().cells[0]?.status, "done");
  assert.equal(engine.analysisCalls.at(-1)?.[0]?.id, "cell-1");
  assert.equal(engine.evaluations[0]?.cellId, "cell-1");
  await controller.close();
});

test("body edits retain the validated graph but execution waits for replacement analysis", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"], ["c", "z <- y"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const graph = controller.snapshot().graph;
  const events: HostEvent[] = [];
  controller.subscribe((event) => events.push(event));
  const analyze = engine.analyze.bind(engine);
  let releaseAnalysis: (() => void) | undefined;
  engine.analyze = async (...args) => {
    await new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    return analyze(...args);
  };
  await controller.dispatch(command(controller, {
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
  assert.deepEqual(controller.snapshot().graph, graph);
  const sourceTransaction = events.find((event) => event.type === 'transaction');
  assert.ok(sourceTransaction);
  assert.equal(Object.hasOwn(sourceTransaction.payload as object, 'graph'), false);
  assert.equal(controller.snapshot().cells[0]?.analysisPending, true);
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  const accepted = controller.dispatch(run);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(engine.evaluations.length, 0);
  releaseAnalysis!();
  await accepted;
  await settle(controller, run.operationId);
  assert.deepEqual(engine.analysisCalls.at(-1)?.map((cell) => cell.id), ['a']);
  assert.equal(engine.evaluations[0]?.source, "x <- 2");
  assert.equal(engine.evaluations[0]?.revision, 1);
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a", "b", "c"]);
  assert.equal(events.filter((event) => event.type === "graph").length, 0);

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
  await controller.dispatch(edit2);
  await settle(controller, edit2.operationId);
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  assert.deepEqual(controller.snapshot().graph.edges.b, []);
  assert.equal(events.filter((event) => event.type === "graph").length, 1);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const events: HostEvent[] = [];
  controller.subscribe((event) => events.push(event));
  const first = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(first);
  await settle(controller, first.operationId);
  assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a", "b", "c"]);
  assert.equal(events.filter((event) => event.type === "operation"
    && (event.payload as { status?: string }).status === "running").length, 1);
  assert.deepEqual(events.filter((event) => event.type === "cell-started").map((event) => event.cellId), ["a", "b", "c"]);
  const startedAt = events.findIndex((event) => event.type === "cell-started");
  const completedAt = events.findLastIndex((event) => event.type === "cell-completed");
  assert.ok(events.slice(startedAt, completedAt).filter((event) => event.type === "runtime")
    .every((event) => (event.payload as HostSnapshot["runtime"]).busy), "a continuing chain must not advertise idle between cells");
  await eventually(() => (events.findLast((event) => event.type === "runtime")?.payload as HostSnapshot["runtime"])?.busy === false);
  assert.deepEqual(events.filter((event) => event.type === "runtime").map((event) => {
    const runtime = event.payload as HostSnapshot["runtime"];
    return [runtime.busy, runtime.activeRunId];
  }), [[true, engine.evaluations[0]?.runId], [false, null]]);

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
  const disableAdmission = await controller.dispatch(disable);
  await controller.awaitOperation(disableAdmission.operationId, "controller-tests");
  const second = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(second);
  await settle(controller, second.operationId);
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
    engine, notebook: notebook([["a", "x <- 1"], ["b", "y <- x + 1"], ["c", "z <- y + 1"]]), configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  try {
    await controller.start();
    const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
    });
    await controller.dispatch(initial);
    await settle(controller, initial.operationId);
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
    await controller.dispatch(edited);
    await settle(controller, edited.operationId);
    assert.deepEqual(engine.evaluations.map((item) => item.source),
      ["x <- 1", "y <- x + 1", "z <- y + 1", "x <- 2", "y <- x + 1", "z <- y + 1"]);
    assert.deepEqual(engine.requests.filter((item) => item.command === "clear_cell"), []);
    assert.equal(controller.snapshot().cells[0]?.status, "done");
  } finally { await controller.close(); }
});

test("queued invalidations clear in one atomic request before evaluation resumes", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- 2"], ["c", "x + y"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
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
  await controller.dispatch(edit);
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
  await controller.dispatch(run);
  await eventually(() => engine.requests.some((request) => request.command === "clear_cell"));
  assert.equal(engine.evaluations.length, evaluationsBeforeClear);
  assert.deepEqual(
    engine.requests.filter((request) => request.command === "clear_cell"),
    [{ command: "clear_cell", payload: { ids: ["a", "b"] } }],
  );

  releaseClear();
  await settle(controller, run.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  const terminal = await controller.awaitOperation(run.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.emitEvaluationLog({ lines: ["a"] });
  engine.emitEvaluationLog({ lines: ["ab"], replaceLast: true });
  engine.emitEvaluationLog({ lines: ["c"] });
  engine.finishEvaluation({ ok: true, outputs: [] });
  await settle(controller, run.operationId);
  assert.deepEqual(controller.snapshot().cells[0]?.log, ["ab", "c"]);
  await controller.close();
});

test("native clear-output deltas reset every streamed projection before later output", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "stream_output()"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
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
  await settle(controller, run.operationId);
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
  await controller.dispatch(rerun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.deepEqual(controller.snapshot().cells[0]?.outputs.map((output) => output.data), [{ kind: "text", text: "new", truncated: false }]);
  assert.equal(controller.snapshot().cells[0]?.outputsStale, true);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "replacement", truncated: false } });
  assert.deepEqual(controller.snapshot().cells[0]?.outputs.map((output) => output.data), [{ kind: "text", text: "replacement", truncated: false }]);
  assert.notEqual(controller.snapshot().cells[0]?.outputsStale, true);
  engine.finishEvaluation({ ok: true, log: [] });
  await settle(controller, rerun.operationId);
  assert.notEqual(controller.snapshot().cells[0]?.outputsStale, true);
  unsubscribe();
  await controller.close();
});

test("completion preserves the authoritative log beyond the live stream window", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "cat(large_output)"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  const completeLine = "x".repeat(70 * 1024);
  engine.finishEvaluation({ ok: true, outputs: [], log: [completeLine] });
  await settle(controller, run.operationId);
  assert.deepEqual(controller.snapshot().cells[0]?.log, [completeLine]);

  const oversizedRun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await controller.dispatch(oversizedRun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.finishEvaluation({ ok: true, outputs: [], log: ["x".repeat(1_048_577)] });
  await settle(controller, oversizedRun.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
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
  await controller.dispatch(edit);
  await eventually(() => engine.interrupts.length === 1);
  assert.deepEqual(engine.interrupts, [1]);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "obsolete", truncated: false }] });
  await settle(controller, run.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  const firstAdmission = await controller.dispatch(firstEdit);
  await controller.awaitOperation(firstAdmission.operationId, "controller-tests");
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
  const secondAdmission = await controller.dispatch(secondEdit);
  await controller.awaitOperation(secondAdmission.operationId, "controller-tests");
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
test("parsed exact-limit physical source supports a reducing edit and small creation", { timeout: 60_000 }, async () => {
  const source = exactLimitNotebookSource();
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: parsedNotebook(source), configResolution: resolveConfigLayers({ launch: { on_startup: false } }) });
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
        },
        {
            type: "create",
            creationId: "small",
            after: {
                cellId: "cell-1"
            },
            body: ["y <- x"],
            cellType: "code",
            options: {}
        }
    ]
    });
    const admission = await controller.dispatch(edit);
    await settle(controller, admission.operationId);
    assert.equal(serializedNotebook(controller), "\ufeff# title\r\n# noncanonical header\r\n# %%\r\n#| keep: original\r\nx <- 2\r\n# %%\r\ny <- x");
  } finally {
    await controller.close();
  }
});

test("parsed physical records retain BOM, mixed EOL, and duplicate options around an edit", async () => {
  const source = mixedPhysicalSource();
  const engine = new FakeEngine();
  const controller = createController({ engine, notebook: parsedNotebook(source), configResolution: resolveConfigLayers({ launch: { on_startup: false } }) });
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
    const admission = await controller.dispatch(edit);
    await settle(controller, admission.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
    const admission = await controller.dispatch(edit);
    const operation = await controller.awaitOperation(admission.operationId, "controller-tests");
    assert.equal(operation.status, "error");
    assert.equal(serializedNotebook(controller), source);
  } finally {
    await controller.close();
  }
});


test("source admission keeps pending publication invisible and checks revision at lane acquisition", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
        configResolution: context.configResolution,
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
        configResolution: context.configResolution,
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "reload-source");
      const publish = context.preparePublication({
        document: {
          ...context.document,
          cells: context.document.cells.map((cell) => cell.id === "c" ? { ...cell, body: ["z <- 4"] } : cell),
        },
        path: context.path,
        configResolution: context.configResolution,
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
    await controller.dispatch(run);
    await eventually(() => engine.pendingEvaluations.length === 1);
    const beforeReload = controller.snapshot();
    await controller.commitSource({
      kind: "reload-source",
      expectedDocumentRevision: beforeReload.documentRevision,
      operationId: "reload-during-evaluation",
    });
    assert.deepEqual(engine.interrupts, [1]);
    assert.equal((await controller.awaitOperation(run.operationId, "controller-tests")).status, "error");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (_request, context) => {
      entered = true;
      const publish = context.preparePublication({
        document: context.document,
        path: context.path,
        configResolution: context.configResolution,
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "save-as");
      const path = request.path ?? "/tmp/destination.alder";
      const publish = context.preparePublication({
        document: { ...context.document, path },
        path,
        configResolution: context.configResolution,
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (_request, context) => {
      const publish = context.preparePublication({
        document: { ...context.document, path: "/tmp/destination.alder" },
        path: "/tmp/destination.alder",
        configResolution: context.configResolution,
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

test("failed source admission leaves the physical notebook and revision unchanged", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  const editAdmission = await controller.dispatch(edit);
  await controller.awaitOperation(editAdmission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      entered = true;
      const document = request.document ?? context.document;
      const publish = context.preparePublication({
        document,
        path: document.path ?? context.path,
        configResolution: context.configResolution,
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
    const admission = await controller.dispatch(run);
    await eventually(() => entered);

    for (const listener of engine.failureListeners) listener("kernel", new Error("kernel lost"));
    await eventually(() => controller.snapshot().runtime.executionBlockedReason?.code === "worker_unavailable");
    const pending = controller.snapshot().operations.find((operation) => operation.id === admission.operationId);
    assert.ok(pending);
    assert.ok(pending.status === "accepted" || pending.status === "running");

    release();
    const operation = await controller.awaitOperation(admission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
    const admission = await controller.dispatch(run);
    const operation = await controller.awaitOperation(admission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  try {
    const foreign: HostCommand = {
      operationId: "foreign-edit",
      clientId: "foreign-editor",
      commandSequence: 1,
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
    const foreignAdmission = await controller.dispatch(foreign);
    await settle(controller, foreignAdmission.operationId, "foreign-editor");
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
    const admission = await controller.dispatch(run);
    const operation = await controller.awaitOperation(admission.operationId, 'controller-tests');
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      commitEntered = true;
      await commitGate;
      const document = request.document ?? context.document;
      context.preparePublication({
        document, path: document.path ?? context.path, configResolution: context.configResolution,
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
    const runAdmission = await controller.dispatch(run);
    assert.equal(runAdmission.accepted, true);
    await eventually(() => commitEntered);
    assert.equal(controller.snapshot().runtime.busy, true);

    const stop = command(controller, { type: "interrupt" });
    const stopAdmission = await controller.dispatch(stop);
    assert.equal(stopAdmission.accepted, true);
    const stopOperation = await controller.awaitOperation(stopAdmission.operationId, "controller-tests");
    assert.equal(stopOperation.status, "done");
    assert.equal((stopOperation.result as { requested: boolean }).requested, true);
    assert.equal(engine.evaluations.length, 0);

    releaseCommit();
    const settled = await controller.awaitOperation(run.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  const stop = command(controller, { type: "interrupt" });
  await controller.dispatch(stop);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "[1] 2", truncated: false }] });
  const settled = await settle(controller, run.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  await controller.dispatch(command(controller, { type: "interrupt" }));
  engine.finishEvaluation({
    ok: false,
    error: { message: "Interrupted", code: "interrupted", interrupted: true },
  });
  const settled = await controller.awaitOperation(run.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  await controller.dispatch(command(controller, { type: "interrupt" }));
  engine.finishEvaluation({
    ok: false,
    error: { message: "bad error message", code: "evaluation_error" },
  });
  const settled = await controller.awaitOperation(run.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  await controller.dispatch(widget);
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
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(widget.operationId, "controller-tests")).status, "cancelled");
  resolveWidget({ ok: true, selected: { type: "double", value: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  const output = controller.snapshot().cells[0]?.outputs[0] as { data: { spec: { value: number } } };
  assert.equal(output.data.spec.value, 2);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false, on_cell_change: "automatic" } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  engine.deferred = true;
  const unrelated = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "c"
    },
    changes: []
  });
  await controller.dispatch(unrelated);
  await eventually(() => engine.pendingEvaluations.length === 1);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 9 }, source: "editor",
  });
  await controller.dispatch(widget);
  await eventually(() => resolveWidget !== undefined);
  await controller.dispatch(command(controller, {
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
  assert.equal((await controller.awaitOperation(widget.operationId, "controller-tests")).status, "cancelled");
  assert.equal(engine.evaluations.at(-1)?.cellId, "c");

  engine.finishEvaluation();
  await settle(controller, unrelated.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false, on_cell_change: "automatic" } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 9 }, source: "editor",
  });
  await controller.dispatch(widget);
  await eventually(() => resolveWidget !== undefined);
  await controller.dispatch(command(controller, {
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
  assert.equal((await controller.awaitOperation(widget.operationId, "controller-tests")).status, "cancelled");
  await controller.close();
});

test("an edited widget owner is rejected as stale before replacement analysis settles", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "threshold <- ui$slider(0, 10)"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

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
  await controller.dispatch(command(controller, {
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
  const widgetAdmission = await controller.dispatch(widget);
  const widgetOperation = await controller.awaitOperation(widgetAdmission.operationId, "controller-tests");
  assert.equal(widgetOperation.status, "error");
  assert.equal(widgetOperation.error?.code, "widget_not_current");
  const inspect = command(controller, { type: "inspect", name: "threshold" });
  const inspectAdmission = await controller.dispatch(inspect);
  const inspectOperation = await controller.awaitOperation(inspectAdmission.operationId, "controller-tests");
  assert.equal(inspectOperation.status, "error");
  assert.equal(inspectOperation.error?.code, "stale_value");
  const missingInspect = command(controller, { type: "inspect", name: "not_yet_owned" });
  const missingAdmission = await controller.dispatch(missingInspect);
  const missingOperation = await controller.awaitOperation(missingAdmission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const update = command(controller, {
    type: "widget",
    name: "stamp",
    path: [],
    update: { value: "2026-02-30T17:30:45Z" },
    source: "editor",
  });
  const updateAdmission = await controller.dispatch(update);
  const updateOperation = await controller.awaitOperation(updateAdmission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, { type: "run", scope: "all", changes: [] });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

  const impossible = command(controller, {
    type: "widget", name: "dates", path: [],
    update: { value: ["2026-02-30", "2026-03-01"] }, source: "editor",
  });
  const impossibleAdmission = await controller.dispatch(impossible);
  const impossibleOperation = await controller.awaitOperation(impossibleAdmission.operationId, "controller-tests");
  assert.equal(impossibleOperation.status, "error");
  assert.equal(impossibleOperation.error?.code, "invalid_request");
  assert.equal(impossibleOperation.error?.message, "temporal widget value required");

  const descending = command(controller, {
    type: "widget", name: "dates", path: [],
    update: { value: ["2026-09-04", "2026-09-03"] }, source: "editor",
  });
  const descendingAdmission = await controller.dispatch(descending);
  const descendingOperation = await controller.awaitOperation(descendingAdmission.operationId, "controller-tests");
  assert.equal(descendingOperation.status, "error");
  assert.equal(descendingOperation.error?.code, "invalid_request");
  assert.equal(descendingOperation.error?.message, "date range must be non-decreasing");
  assert.equal(engine.requests.filter(({ command }) => command === "set_widget").length, 0);
  await controller.close();

  const counterEngine = new FakeEngine();
  const counterController = createController({
    engine: counterEngine,
    notebook: notebook([["counter", "counter_boundary <- ui$button()"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await counterController.start();
  const counterRun = command(counterController, { type: "run", scope: "all", changes: [] });
  await counterController.dispatch(counterRun);
  await settle(counterController, counterRun.operationId);
  const tooLarge = command(counterController, {
    type: "widget", name: "counter", path: [],
    update: { value: 2_147_483_648 }, source: "editor",
  });
  const tooLargeAdmission = await counterController.dispatch(tooLarge);
  const tooLargeOperation = await counterController.awaitOperation(tooLargeAdmission.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  engine.deferred = true;
  const successful = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  await controller.dispatch(successful);
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(controller.operation(successful.operationId, "controller-tests")?.status, "running");
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "7", truncated: false }] });
  assert.equal((await controller.awaitOperation(successful.operationId, "controller-tests")).status, "done");
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
  await controller.dispatch(failed);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.finishEvaluation({ ok: false, error: { message: "consumer boom" } });
  const failure = await controller.awaitOperation(failed.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

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
    controller.dispatch(inspect),
    controller.dispatch(lazy),
    controller.dispatch(table),
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
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(inspect.operationId, "controller-tests")).error?.code, "stale_value");
  assert.equal((await controller.awaitOperation(lazy.operationId, "controller-tests")).error?.code, "lazy_expired");
  assert.equal((await controller.awaitOperation(table.operationId, "controller-tests")).error?.code, "table_unavailable");
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
  for (const operationId of [inspect.operationId, lazy.operationId, table.operationId]) {
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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

test("rerunning an owner expires a lazy request tied to its prior output object", async () => {
  const engine = new FakeEngine();
  let finishLazy!: (response: EngineResponse) => void;
  const controller = createController({
    engine,
    notebook: notebook([["a", "lazy_value <- make_lazy()"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
  engine.requestHandler = async (name) => name === "lazy_eval"
    ? new Promise((resolve) => { finishLazy = resolve; })
    : { ok: true };
  const lazy = command(controller, { type: "lazy-output", key: "lazy-1" });
  await controller.dispatch(lazy);
  await eventually(() => finishLazy !== undefined);
  const rerun = command(controller, {
    type: "run",
    scope: "cell",
    target: {
        cellId: "a"
    },
    changes: []
  });
  await controller.dispatch(rerun);
  await settle(controller, rerun.operationId);
  assert.equal((await controller.awaitOperation(lazy.operationId, "controller-tests")).error?.code, "lazy_expired");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

  const expand = command(controller, { type: "lazy-output", key: "lazy-1" });
  await controller.dispatch(expand);
  await settle(controller, expand.operationId);

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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await settle(controller, run.operationId);

  const upload = command(controller, {
    type: "upload",
    name: "files",
    path: [],
    files: [{ name: "data.csv", content_base64: "eAo=" }],
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await controller.dispatch(upload);
  const operation = await settle(controller, upload.operationId);
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
  assert.equal(output.data.operation.operationId, upload.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const upload = command(controller, {
    type: "upload",
    name: "files",
    path: [],
    files: [],
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  await controller.dispatch(upload);
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
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(upload.operationId, "controller-tests")).status, "cancelled");
  finishStore({
    uploadId: "upload-stale",
    value: [{ name: "data.csv", size: 4, path: "/tmp/upload-stale" }],
  });
  await eventually(() => removed.length === 1);
  assert.equal(engine.requests.some((request) => request.command === "set_widget"), false);
  await controller.close();
});

test("recovery replays retained ordered deltas and snapshots across gaps or epochs", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    journalByteLimit: 64 * 1024,
  });
  await controller.start();
  const cursor = controller.cursor;
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
  await controller.dispatch(edit);
  const replay = controller.recover(controller.epoch, cursor);
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.ok(replay.events.length > 0);
    assert.ok(replay.events.every((event, index, events) =>
      index === 0 || event.cursor > (events[index - 1]?.cursor ?? -1)));
    assert.equal(recoverySchema.safeParse(replay).success, true, "retained replay is wire-valid JSON");
  }
  assert.equal(controller.recover("old-epoch", cursor).kind, "snapshot");
  await controller.close();

  const bounded = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    journalByteLimit: 128,
  });
  await bounded.start();
  const oldCursor = bounded.cursor;
  const large = command(bounded, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["x <- 2 #" + "x".repeat(500)],
            cellType: "code"
        }
    ]
  });
  await bounded.dispatch(large);
  assert.equal(bounded.recover(bounded.epoch, oldCursor).kind, "snapshot");
  await bounded.close();
});

test("editor diagnostics publish only for an exact source identity and clear on source changes", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(edit);
  await settle(controller, edit.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(edit);
  const operation = await settle(controller, edit.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await settle(controller, run.operationId);
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
  await controller.dispatch(rerun);
  await settle(controller, rerun.operationId);
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
  await controller.dispatch(edit);
  resolveRefresh({
    ok: true,
    variables: [{ name: "x", class: "numeric", dim: null, size: 56, widget: false }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().variables, []);
  await controller.close();
});

test("runtime availability failures survive source edits and save until restart recovery", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: { ...notebook([["a", "x <- 1"]]), path: "/tmp/runtime-init.R" },
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      const document = request.document ?? context.document;
      context.preparePublication({
        document,
        path: document.path ?? context.path,
        configResolution: context.configResolution,
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
  await controller.dispatch(edit);
  await settle(controller, edit.operationId);
  assert.deepEqual(controller.snapshot().runtime.executionBlockedReason, unavailable.runtime.executionBlockedReason);

  const save = command(controller, { type: "save" });
  await controller.dispatch(save);
  await settle(controller, save.operationId);
  assert.equal(controller.snapshot().lastActionError, null);
  assert.deepEqual(controller.snapshot().runtime.executionBlockedReason, unavailable.runtime.executionBlockedReason);

  engine.restartHandler = async () => { throw new Error("restart failed"); };
  const failedRestart = command(controller, { type: "restart", replay: false });
  const failedAdmission = await controller.dispatch(failedRestart);
  assert.equal(failedAdmission.accepted, true);
  const failedOperation = await controller.awaitOperation(failedRestart.operationId, "controller-tests");
  assert.equal(failedOperation.status, "error");
  assert.deepEqual(controller.snapshot().runtime.executionBlockedReason, {
    code: "worker_unavailable", message: "restart failed",
  });

  engine.restartHandler = async () => engine.handshake;
  const restart = command(controller, { type: "restart", replay: false });
  await controller.dispatch(restart);
  await settle(controller, restart.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();

  const firstRun = command(controller, {
    type: "run",
    scope: "cell",
    target: { cellId: "a" },
    changes: [],
  });
  const firstAdmission = await controller.dispatch(firstRun);
  const firstOperation = await controller.awaitOperation(firstAdmission.operationId, "controller-tests");
  assert.equal(firstOperation.status, "error");
  assert.equal(firstOperation.error?.code, "kernel_state_invalid");
  assert.equal(controller.snapshot().cells[0]?.error?.code, "eval_error");
  assert.equal(controller.snapshot().runtime.executionBlockedReason?.code, "kernel_state_invalid");

  const edit = command(controller, {
    type: "transaction",
    changes: [{ type: "edit", cell: { cellId: "a" }, expectedRevision: 0, body: ["x <- 2"], cellType: "code" }],
  });
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(edit.operationId, "controller-tests")).status, "done");

  const blockedRun = command(controller, {
    type: "run",
    scope: "cell",
    target: { cellId: "a" },
    changes: [],
  });
  const blockedAdmission = await controller.dispatch(blockedRun);
  const blockedOperation = await controller.awaitOperation(blockedAdmission.operationId, "controller-tests");
  assert.equal(blockedOperation.status, "error");
  assert.equal(blockedOperation.error?.code, "kernel_state_invalid");
  assert.equal(engine.evaluations.length, 1);

  const restart = command(controller, { type: "restart", replay: false });
  await controller.dispatch(restart);
  assert.equal((await controller.awaitOperation(restart.operationId, "controller-tests")).status, "done");
  assert.equal(controller.snapshot().runtime.executionBlockedReason, null);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  await controller.close();
});
test("concurrent config patches serialize and reject stale revisions", async () => {
  const engine = new FakeEngine();
  const calls: Array<Record<string, unknown>> = [];
  const resolvers: Array<() => void> = [];
  const controller = createController({
    engine,
    notebook: notebook([]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.kind, "sidecar");
      assert.equal(request.sidecar, "config");
      const resolution = resolveConfigLayers({
        user: context.configResolution.layers.user,
        project: mergeTestConfig(context.configResolution.layers.project, request.patch ?? {}),
        runtime: context.configResolution.layers.runtime,
        launch: context.configResolution.layers.launch,
      });
      calls.push({ config: resolution.effective });
      await new Promise<void>((resolve) => resolvers.push(resolve));
      context.preparePublication({
        document: context.document,
        path: context.path,
        configResolution: resolution,
        layout: context.layout,
        disk: context.disk,
        sidecars: context.sidecars,
        dirty: true,
        advanceRevision: true,
      })();
      return { config: resolution.effective };
    },
  });
  await controller.start();
  const first = command(controller, { type: "set-config", patch: { theme: "dark" } });
  const second = command(controller, { type: "set-config", patch: { keymap: "vim" } });
  const firstPromise = controller.dispatch(first);
  const secondPromise = controller.dispatch(second);
  await eventually(() => calls.length === 1);
  assert.equal(calls.length, 1);
  resolvers.shift()?.();
  await firstPromise;
  await controller.awaitOperation(first.operationId, "controller-tests");
  await secondPromise;
  const secondOperation = await controller.awaitOperation(second.operationId, "controller-tests");
  assert.equal(secondOperation.status, "error");
  assert.equal(secondOperation.error?.code, "source_conflict");
  assert.equal(calls.length, 1);
  assert.equal(controller.snapshot().config.theme, "dark");
  assert.equal(controller.snapshot().config.keymap, "default");
  await controller.close();
});

test("runtime and config controls keep metadata, config, and replay events coherent", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([]),
    configResolution: resolveConfigLayers({ runtime: { on_cell_change: "automatic", on_startup: true } }),
    sourceCommit: async (request, context) => {
      if (request.kind === "runtime") {
        const patch = request.patch ?? {};
        const resolution = resolveConfigLayers({
          user: context.configResolution.layers.user,
          project: context.configResolution.layers.project,
          runtime: { ...context.configResolution.layers.runtime, ...patch },
          launch: context.configResolution.layers.launch,
        });
        const metadata = isRecord(context.document.metadata) ? structuredClone(context.document.metadata) : {};
        const priorRuntime = isRecord(metadata.runtime) ? metadata.runtime : {};
        metadata.runtime = { ...priorRuntime, ...patch };
        context.preparePublication({
          document: { ...context.document, metadata },
          path: context.path,
          configResolution: resolution,
          layout: context.layout,
          disk: context.disk,
          sidecars: context.sidecars,
          dirty: true,
          advanceRevision: true,
        })();
        return { config: resolution.effective };
      }
      assert.equal(request.kind, "sidecar");
      assert.equal(request.sidecar, "config");
      const patch = validateConfigLayer(request.patch ?? {});
      const resolution = resolveConfigLayers({
        user: context.configResolution.layers.user,
        project: mergeTestConfig(context.configResolution.layers.project, request.patch ?? {}),
        runtime: context.configResolution.layers.runtime,
        launch: context.configResolution.layers.launch,
      });
      assertConfigPatchEffective(resolution, patch, "project");
    },
  });
  await controller.start();
  const before = controller.cursor;
  const runtime = command(controller, {
    type: "set-runtime", on_cell_change: "lazy", on_startup: false,
  });
  await controller.dispatch(runtime);
  await settle(controller, runtime.operationId);
  let state = controller.snapshot();
  assert.deepEqual(state.metadata.runtime, {
    on_cell_change: "lazy", on_startup: false,
  });
  assert.equal(state.config.on_cell_change, "lazy");
  assert.equal(state.config.on_startup, false);
  assert.equal(state.changed, true);
  const configQuery = await controller.query({ type: "config" });
  const queriedConfig = configQuery.result as {
    effective: Record<string, unknown>;
    layers: { runtime: Record<string, unknown> };
    provenance: Record<string, string>;
  };
  assert.equal(queriedConfig.effective.on_cell_change, "lazy");
  assert.equal(queriedConfig.layers.runtime.on_cell_change, "lazy");
  assert.equal(queriedConfig.provenance.on_cell_change, "runtime");
  const replay = controller.recover(controller.epoch, before);
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    const replayedNotebook = replay.events.find((event) => event.type === "notebook"
      && event.documentRevision === state.documentRevision);
    assert.ok(replayedNotebook);
    const replayedConfig = (replayedNotebook.payload as { config?: Record<string, unknown> }).config;
    assert.equal(replayedConfig?.on_cell_change, state.config.on_cell_change);
    assert.equal(replayedConfig?.on_startup, state.config.on_startup);
  }

  const configCommand = command(controller, {
    type: "set-config", patch: { on_cell_change: "automatic", on_startup: true },
  });
  await controller.dispatch(configCommand);
  const configOperation = await controller.awaitOperation(configCommand.operationId, "controller-tests");
  assert.equal(configOperation.status, "error");
  assert.equal(configOperation.error?.code, "config_shadowed");
  assert.deepEqual(configOperation.error?.details, {
    key: "on_cell_change", writtenLayer: "project", effectiveLayer: "runtime",
  });
  state = controller.snapshot();
  assert.equal(state.runtime.executionMode, "lazy");
  assert.equal(state.runtime.runOnStartup, false);
  assert.deepEqual(state.metadata.runtime, {
    on_cell_change: "lazy", on_startup: false,
  });
  await controller.close();
});
test("persisted layout updates do not mark clean notebook source dirty", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    sourceCommit: async (request, context) => {
      assert.equal(request.sidecar, "layout");
      const layout = request.layout ?? null;
      context.preparePublication({
        document: context.document,
        path: context.path,
        configResolution: context.configResolution,
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
  await controller.dispatch(command(controller, {
    type: "set-layout",
    layout: { version: 1, layout: "grid", cells: {} },
    expectedSidecarVersion: null,
  }));
  await settle(controller, controller.snapshot().operations.at(-1)!.id);
  assert.deepEqual(controller.snapshot().layout, { version: 1, layout: "grid", cells: {} });
  assert.equal(controller.snapshot().changed, false);
  await controller.close();
});

test("source query returns the authoritative cell bodies", async () => {
  const controller = createController({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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

test("package installation is asynchronous, leaves edits responsive, blocks runs, and revalidates", async () => {
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(firstRun);
  await settle(controller, firstRun.operationId);

  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  const accepted = await controller.dispatch(install);
  assert.equal(accepted.operation.status, "accepted");
  await eventually(() => controller.snapshot().operations.find((operation) => operation.id === install.operationId)?.status === "running");
  assert.equal(controller.snapshot().runtime.packageOperationActive, true);

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
  await controller.dispatch(edit);
  await settle(controller, edit.operationId);
  assert.equal(controller.snapshot().cells[0]?.revision, 1);
  const blockedRun = command(controller, {
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
  const blockedAdmission = await controller.dispatch(blockedRun);
  const blockedOperation = await controller.awaitOperation(blockedAdmission.operationId, "controller-tests");
  assert.equal(blockedOperation.status, "error");
  assert.equal(blockedOperation.error?.code, "package_operation_in_progress");
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 2"]);

  finishInstall({ ok: true, status: "installed", packages: ["dplyr"] });
  const settled = await settle(controller, install.operationId);
  assert.equal(engine.restartCount, 1);
  assert.deepEqual(controller.snapshot().runtime.rEnvironment, refreshedEnvironment);
  assert.equal(controller.snapshot().runtime.analysisEnvironmentId, "analysis-test");
  assert.equal(controller.snapshot().runtime.packageOperationActive, false);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(install);
  await eventually(() => controller.operation(install.operationId, "controller-tests")?.status === "running");
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "operation" && event.operationId === install.operationId) events.push(event);
  }, ["operation"]);
  const progress = { phase: "output", stream: "stdout", text: "installing dplyr", data: { package: "dplyr" } };
  controller.publishPackageProgress(install.operationId, progress);
  assert.deepEqual(controller.operation(install.operationId, "controller-tests")?.progress, progress);
  assert.deepEqual((events.at(-1)?.payload as { progress?: unknown }).progress, progress);

  finishInstall({ ok: true, status: "installed", packages: ["dplyr"] });
  const settled = await settle(controller, install.operationId);
  assert.equal(settled.status, "done");
  const terminalProgress = controller.operation(install.operationId, "controller-tests")?.progress;
  assert.deepEqual(terminalProgress, progress);
  const eventCount = events.length;
  controller.publishPackageProgress(install.operationId, { phase: "output", text: "late callback" });
  assert.equal(events.length, eventCount);
  assert.deepEqual(controller.operation(install.operationId, "controller-tests")?.progress, terminalProgress);
  unsubscribe();
  await controller.close();
});

test("failed package installation still restarts and reanalyzes before settling error", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(install);
  const operation = await controller.awaitOperation(install.operationId, "controller-tests");
  assert.equal(operation.status, "error");
  assert.equal(operation.error?.code, "install_failed");
  assert.equal(engine.restartCount, 1);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().runtime.packageOperationActive, false);
  await controller.close();
});

test("failed package installation without library mutation does not restart runtime", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(install);
  const operation = await controller.awaitOperation(install.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    services: { service: async (name) => name === "packages.install"
      ? { ok: true, status: "ready", mutatedLibrary: false }
      : { declared: [], installed: [], missing: [] } },
  });
  await controller.start();
  const install = command(controller, { type: "packages-install", packages: ["dplyr"], expectedDocumentRevision: controller.snapshot().documentRevision, kernelEpoch: controller.snapshot().runtime.kernelEpoch });
  await controller.dispatch(install);
  const operation = await controller.awaitOperation(install.operationId, "controller-tests");
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(install);
  const operation = await controller.awaitOperation(install.operationId, "controller-tests");
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

test("package installation cannot start while a run is active", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  let serviceCalls = 0;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    services: { service: async () => { serviceCalls += 1; return {}; } },
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  const install = command(controller, {
    type: "packages-install",
    packages: ["dplyr"],
    expectedDocumentRevision: controller.snapshot().documentRevision,
    kernelEpoch: controller.snapshot().runtime.kernelEpoch,
  });
  const installAdmission = await controller.dispatch(install);
  const installOperation = await controller.awaitOperation(installAdmission.operationId, "controller-tests");
  assert.equal(installOperation.status, "error");
  assert.equal(installOperation.error?.code, "run_in_progress");
  assert.equal(serviceCalls, 0);
  engine.finishEvaluation();
  await settle(controller, run.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await controller.dispatch(widget);
  await eventually(() => finishReset !== undefined);
  const causalRunId = `run-button-${widget.operationId}`;
  const causalRun = controller.operation(causalRunId, "controller-tests");
  assert.ok(causalRun);
  assert.equal(causalRun.status, "accepted");
  assert.equal(causalRun.executionDone, true);
  assert.equal(causalRun.resetOperationIds?.length, 1);
  assert.equal(controller.operation(widget.operationId, "controller-tests")?.status, "running");

  finishReset({ ok: true, selected: { type: "logical", value: false } });
  assert.equal((await controller.awaitOperation(widget.operationId, "controller-tests")).status, "done");
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
    configResolution: resolveConfigLayers({ launch: { on_cell_change: "lazy", on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
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
  await controller.dispatch(widget);
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
  await controller.dispatch(explicit);
  await eventually(() => finishReset !== undefined);
  const pendingRun = controller.operation(explicit.operationId, "controller-tests");
  assert.equal(pendingRun?.executionDone, true);
  assert.equal(pendingRun?.status, "running");
  assert.equal(pendingRun?.resetOperationIds?.length, 1);
  finishReset({ ok: true, selected: { type: "logical", value: false } });
  await settle(controller, widget.operationId);
  await settle(controller, explicit.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const widget = command(controller, {
    type: "widget",
    name: "controls",
    path: ["go"],
    update: { value: true },
    source: "editor",
  });
  await controller.dispatch(widget);
  const trigger = await settle(controller, widget.operationId);
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
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await controller.dispatch(widget);
  const trigger = await controller.awaitOperation(widget.operationId, "controller-tests");
  const causalRun = await controller.awaitOperation(`run-button-${widget.operationId}`, "controller-tests");
  assert.equal(trigger.status, "error");
  assert.equal(trigger.error?.code, "widget_update_failed");
  assert.equal(trigger.error?.message, "cannot reset");
  assert.equal(trigger.error?.operationId, widget.operationId);
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

test("a failed barrier makes even never-run code stale", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = createController({
    engine,
    notebook: notebook([["a", "library(stats)"], ["b", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
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
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  engine.finishEvaluation({ ok: false, error: { message: "attach failed" }, log: [] });
  const terminal = await controller.awaitOperation(run.operationId, "controller-tests");
  assert.equal(terminal.status, "error");
  assert.equal(terminal.error?.code, "eval_error");
  assert.equal(terminal.error?.message, "attach failed");
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "a")?.status, "error");
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "b")?.status, "stale");
  await controller.close();
});

test("moving or deleting a barrier forces exactly one clean restart before the next run", async () => {
  for (const mutation of ["move", "delete"] as const) {
    const engine = new FakeEngine();
    const controller = createController({
      engine,
      notebook: notebook([["a", "library(stats)"], ["b", "x <- 1"], ["c", "y <- x"]]),
      configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
    });
    await controller.start();
    const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
    });
    await controller.dispatch(initial);
    await settle(controller, initial.operationId);
    const mutationCommand = mutation === "move"
      ? command(controller, {
    type: "transaction",
    changes: [
        {
            type: "move",
            cell: {
                cellId: "a"
            },
            after: {
                cellId: "c"
            }
        }
    ]
      })
      : command(controller, {
    type: "transaction",
    changes: [
        {
            type: "delete",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0
        }
    ]
      });
    await controller.dispatch(mutationCommand);
    await settle(controller, mutationCommand.operationId);
    const afterMutation = controller.snapshot();
    if (mutation === "move") {
      assert.ok(afterMutation.cells.filter((cell) => cell.type === "code").every((cell) => cell.status === "stale"));
    } else {
      assert.equal(afterMutation.cells.find((cell) => cell.id === "b")?.status, "done");
      assert.equal(afterMutation.cells.find((cell) => cell.id === "c")?.status, "stale");
    }
    const rerun = command(controller, {
    type: "run",
    scope: "all",
    changes: []
    });
    await controller.dispatch(rerun);
    await settle(controller, rerun.operationId);
    assert.equal(engine.restartCount, mutation === "move" ? 1 : 0, mutation);
    assert.ok(controller.snapshot().cells
      .filter((cell) => cell.type === "code")
      .every((cell) => cell.status === "done"));
    await controller.close();
  }
});

test("an explicit restart consumes opaque-source invalidation without a second restart", async () => {
  const engine = new FakeEngine();
  const controller = createController({
    engine,
    notebook: notebook([["a", "source('helpers.R')"], ["b", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const initial = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
  const edit = command(controller, {
    type: "transaction",
    changes: [
        {
            type: "edit",
            cell: {
                cellId: "a"
            },
            expectedRevision: 0,
            body: ["source('other.R')"],
            cellType: "code"
        }
    ]
  });
  await controller.dispatch(edit);
  await settle(controller, edit.operationId);
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  const restart = command(controller, { type: "restart", replay: false });
  await controller.dispatch(restart);
  await settle(controller, restart.operationId);
  assert.equal(engine.restartCount, 1);
  const rerun = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(rerun);
  await settle(controller, rerun.operationId);
  assert.equal(engine.restartCount, 1);
  await controller.close();
});

test("closing invalidates outstanding runtime requests and discards late replies", async () => {
  const engine = new FakeEngine();
  let finishInspection!: (value: EngineResponse) => void;
  const controller = createController({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    configResolution: resolveConfigLayers({ launch: { on_startup: false } }),
  });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "all",
    changes: []
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  engine.requestHandler = async (name) => name === "get_value"
    ? new Promise((resolve) => { finishInspection = resolve; })
    : { ok: true };
  const inspect = command(controller, { type: "inspect", name: "x" });
  await controller.dispatch(inspect);
  await eventually(() => finishInspection !== undefined);
  await controller.close();
  finishInspection({ ok: true, value: 99 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().lastValue, null);
  assert.equal(controller.operation(inspect.operationId, "controller-tests")?.status, "error");
});