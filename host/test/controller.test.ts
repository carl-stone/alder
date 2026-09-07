import assert from "node:assert/strict";
import test from "node:test";

import { Controller, ControllerError } from "../src/controller.js";
import {
  MAX_DEPENDENCY_EDGES,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
} from "../src/protocol.js";
import type {
  AnalysisResult,
  CellSnapshot,
  EngineAdapter,
  EngineEvent,
  EngineHandshake,
  EngineResponse,
  EvaluationPayload,
  HostCommand,
  HostEvent,
} from "../src/protocol.js";

const HANDSHAKE: EngineHandshake = {
  protocol: "alder-engine-v1",
  packageVersion: "test",
  rVersion: "test",
  capabilities: ["analysis", "evaluation", "streaming", "interrupt"],
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
  deferred = false;
  handshake: EngineHandshake = HANDSHAKE;
  startCount = 0;
  restartCount = 0;
  startHandler: () => Promise<EngineHandshake> = async () => this.handshake;
  restartHandler: () => Promise<EngineHandshake> = async () => this.handshake;
  requestHandler: (command: string, payload: Record<string, unknown>) => Promise<EngineResponse>
    = async () => ({ ok: true });
  evaluationHandler: (payload: EvaluationPayload) => EngineResponse
    = (payload) => evaluationResponse(payload.source);
  private requestId = 0;

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
      analyzer: { packageVersion: "test", rVersion: "test", policy: "test" },
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
    const response = this.evaluationHandler(payload);
    onEvent?.({
      type: "completed",
      requestId,
      sessionEpoch: payload.sessionEpoch,
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
    const result = response ?? evaluationResponse(pending.payload.source);
    pending.onEvent?.({
      type: "completed",
      requestId: pending.requestId,
      sessionEpoch: pending.payload.sessionEpoch,
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
    pending.onEvent?.({
      type: "output",
      requestId: pending.requestId,
      sessionEpoch: pending.payload.sessionEpoch,
      operationId: pending.payload.operationId,
      runId: pending.payload.runId,
      cellId: pending.payload.cellId,
      revision: pending.payload.revision,
      sequence: ++pending.sequence,
      kind,
      payload,
    });
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

function evaluationResponse(source: string): EngineResponse {
  if (source.includes("make_lazy")) {
    return {
      ok: true,
      outputs: [{ kind: "lazy", key: "lazy-1", status: "pending" }],
      log: [],
    };
  }
  if (source.includes("make_table")) {
    return {
      ok: true,
      outputs: [{ kind: "table", handle: "table-1", columns: ["x"], rows: [[1]] }],
      log: [],
    };
  }
  if (source.includes("ui$array") && source.includes("ui$button")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "controls",
        spec: {
          kind: "array",
          value: { go: false, level: 5 },
          children: [
            { name: "go", kind: "run_button", value: false },
            { name: "level", kind: "slider", value: 5, min: 0, max: 10 },
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
        spec: { kind: "file", value: [] },
      }],
      log: [],
    };
  }
  if (source.includes("ui$button")) {
    return {
      ok: true,
      outputs: [{
        kind: "widget",
        name: "btn",
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
        spec: { kind: "slider", value: 2, min: 0, max: 10 },
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
  return { ok: true, outputs: [{ kind: "text", text: source }], log: [] };
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
type CommandWithoutIdentity<T> = T extends HostCommand
  ? Omit<T, "operationId" | "sessionEpoch">
  : never;
type CommandInput = CommandWithoutIdentity<HostCommand>;

function command<T extends CommandInput>(
  controller: Controller,
  value: T,
): HostCommand {
  return {
    ...value,
    operationId: `operation-${++operationCounter}`,
    sessionEpoch: controller.epoch,
  } as HostCommand;
}

async function settle(controller: Controller, id: string) {
  const operation = await controller.awaitOperation(id);
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

test("deferred startup reaches readiness without executing source", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: true,
    deferStartup: true,
  });
  const ready = await controller.start();
  assert.equal(ready.runtime.executionReady, true);
  assert.equal(engine.evaluations.length, 0);
  const startup = await controller.activateStartup();
  assert.ok(startup);
  await settle(controller, startup.id);
  assert.deepEqual(engine.evaluations.map((item) => item.cellId), ["a"]);
  assert.equal(await controller.activateStartup(), null);
  await controller.close();
});

test("event filters preserve subscriber isolation and the complete recovery journal", async () => {
  const controller = new Controller({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
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
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
  });
  const first = controller.start();
  const second = controller.start();
  assert.equal(engine.startCount, 1);
  releaseStart();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.equal(engine.startCount, 1);
  assert.equal(firstSnapshot.epoch, secondSnapshot.epoch);
  await controller.close();
});

test("explicit restart excludes concurrent source mutation", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
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
  assert.equal(engine.restartCount, 1);
  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 }],
  });
  await assert.rejects(
    controller.dispatch(edit),
    (error: unknown) => error instanceof ControllerError && error.code === "operation_in_progress",
  );
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 1"]);
  releaseRestart();
  await restarting;
  assert.equal(engine.restartCount, 1);
  await controller.close();
});

test("closing during restart cannot resurrect runtime readiness", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
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
  assert.equal(engine.restartCount, 1);
  await controller.close();
  releaseRestart();
  await assert.rejects(
    restarting,
    (error: unknown) => error instanceof ControllerError && error.code === "session_stopped",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const closed = controller.snapshot();
  assert.equal(closed.runtime.executionReady, false);
  assert.equal(closed.runtime.kernelAvailable, false);
  assert.equal(closed.runtime.analyzerAvailable, false);
});

test("closing during a barrier restart prevents the pump from shifting queued work", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "library(stats)"]]),
    runOnStartup: false,
  });
  await controller.start();
  const edit = command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["library(stats); x <- 1"],
      cellType: "code",
      expectedRevision: 0,
    }],
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
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  assert.equal(engine.restartCount, 1);
  await controller.close();
  releaseRestart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.evaluations.length, 0);
  assert.equal(controller.snapshot().runtime.executionReady, false);
});

test("optional service-peer failure leaves analysis and execution available", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event));
  for (const listener of engine.failureListeners) {
    listener("services", new Error("optional service peer exited"));
  }
  const afterFailure = controller.snapshot();
  assert.equal(afterFailure.runtime.executionReady, true);
  assert.equal(afterFailure.runtime.analyzerAvailable, true);
  assert.equal(afterFailure.runtime.kernelAvailable, true);
  assert.equal(afterFailure.lastActionError?.code, "service_unavailable");
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"]]),
    runOnStartup: false,
  });
  await controller.start();
  const before = controller.snapshot();
  const edit = command(controller, {
    type: "run",
    scope: "all",
    source: "editor",
    creations: [],
    edits: [
      { cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 },
      { cellId: "b", body: ["y <- x + 1"], cellType: "code", expectedRevision: 9 },
    ],
  });
  await assert.rejects(
    controller.dispatch(edit),
    (error: unknown) => error instanceof ControllerError && error.code === "source_conflict",
  );
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"]]),
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event));
  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 }],
  });
  await controller.dispatch(edit);
  const causal = events.filter((event) => event.operationId === edit.operationId);
  const notebookIndex = causal.findIndex((event) => event.type === "notebook");
  const graphIndex = causal.findIndex((event) => event.type === "graph");
  const projected = causal.filter((event) => event.type === "cell");
  assert.ok(notebookIndex >= 0);
  assert.equal(graphIndex, -1);
  assert.ok(projected.every((event) => causal.indexOf(event) > notebookIndex));
  assert.deepEqual(projected.map((event) => event.cellId), ["a", "b"]);
  assert.deepEqual(
    projected.map((event) => (event.payload as { status: string }).status),
    ["stale", "stale"],
  );
  assert.ok(causal.every((event) => Number.isInteger(event.version)));
  unsubscribe();
  await controller.close();
});

test("creating beyond the admitted notebook bound fails before source or engine effects", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
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
    runOnStartup: false,
  });
  await controller.start();
  const beforeIds = controller.snapshot().cells.map((cell) => cell.id);
  await assert.rejects(
    controller.dispatch(command(controller, {
      type: "create",
      creations: [{
        clientOperationId: "over-limit-cell",
        after: null,
        body: ["x <- 1"],
        cellType: "code",
        options: {},
      }],
    })),
    (error: unknown) => error instanceof ControllerError
      && error.code === "invalid_request"
      && error.message === `notebook exceeds ${MAX_NOTEBOOK_CELLS} cell limit`,
  );
  assert.deepEqual(controller.snapshot().cells.map((cell) => cell.id), beforeIds);
  assert.equal(engine.analysisCalls.length, 0);
  assert.equal(engine.evaluations.length, 0);
  assert.equal(engine.requests.length, 0);
  await controller.close();
});

test("projected notebook bytes are rejected atomically before source or engine effects", async () => {
  const engine = new FakeEngine();
  const commentLine = `#${"x".repeat(1024 * 1024 - 1)}`;
  const retainedLines = Array.from({ length: 15 }, () => commentLine);
  const replacementLines = Array.from({ length: 18 }, () => commentLine);
  assert.ok(
    new TextEncoder().encode(replacementLines.join("\n")).byteLength
      < MAX_NOTEBOOK_SOURCE_BYTES,
  );
  const controller = new Controller({
    engine,
    notebook: {
      path: "/tmp/bounded-source.R",
      metadata: {},
      cells: [
        { id: "a", type: "markdown", body: retainedLines, options: {}, revision: 0 },
        { id: "b", type: "markdown", body: retainedLines, options: {}, revision: 0 },
      ],
    },
    runOnStartup: false,
  });
  await controller.start();
  const before = controller.snapshot();
  await assert.rejects(
    controller.dispatch(command(controller, {
      type: "edit",
      edits: [{
        cellId: "b",
        body: replacementLines,
        cellType: "markdown",
        expectedRevision: 0,
      }],
    })),
    (error: unknown) => error instanceof ControllerError
      && error.code === "invalid_request"
      && error.message === `notebook source exceeds ${MAX_NOTEBOOK_SOURCE_BYTES} byte limit`,
  );
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
  const controller = new Controller({
    engine,
    notebook: notebook(Array.from({ length: count }, (_, index) => [
      `cell-${index}`,
      "library(stats)",
    ] as [string, string])),
    runOnStartup: false,
  });
  await controller.start();
  const exhausted = controller.snapshot();
  assert.equal(exhausted.graph.topologicalOrder, null);
  assert.equal(exhausted.lastActionError?.code, "graph_too_complex");
  assert.ok(exhausted.cells.every((cell) => cell.status === "stale"));

  const repair = command(controller, {
    type: "edit",
    edits: exhausted.cells.map((cell, index) => ({
      cellId: cell.id,
      body: [`value_${index} <- ${index}`],
      cellType: "code" as const,
      expectedRevision: cell.revision,
    })),
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
  const controller = new Controller({ engine, notebook: notebook([]), runOnStartup: false });
  await controller.start();
  const run = command(controller, {
    type: "run",
    scope: "cell",
    targetCreationId: "focused-editor-1",
    source: "editor",
    edits: [],
    creations: [{
      clientOperationId: "focused-editor-1",
      after: null,
      body: ["answer <- 42"],
      cellType: "code",
      options: {},
    }],
  });
  const accepted = await controller.dispatch(run);
  const result = accepted.result as { created: Array<{ clientOperationId: string; id: string }> };
  assert.deepEqual(result.created, [{ clientOperationId: "focused-editor-1", id: "cell-1", revision: 0 }]);
  await settle(controller, run.operationId);
  assert.equal(controller.snapshot().cells[0]?.status, "done");
  assert.equal(engine.analysisCalls.at(-1)?.[0]?.id, "cell-1");
  assert.equal(engine.evaluations[0]?.cellId, "cell-1");
  await controller.close();
});

test("body edits retain the validated graph but execution waits for replacement analysis", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"], ["c", "z <- y"]]),
    runOnStartup: false,
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
    type: "edit", edits: [{ cellId: "a", expectedRevision: 0, cellType: "code", body: ["x <- 2"] }],
  }));
  await eventually(() => releaseAnalysis !== undefined);
  assert.deepEqual(controller.snapshot().graph, graph);
  assert.equal(controller.snapshot().cells[0]?.analysisPending, true);
  const run = command(controller, { type: "run", scope: "all", source: "editor", edits: [], creations: [] });
  const accepted = controller.dispatch(run);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(engine.evaluations.length, 0);
  releaseAnalysis!();
  await accepted;
  await settle(controller, run.operationId);
  assert.equal(engine.evaluations[0]?.source, "x <- 2");
  assert.equal(engine.evaluations[0]?.revision, 1);
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a", "b", "c"]);
  assert.equal(events.filter((event) => event.type === "graph").length, 0);

  engine.analyze = analyze;
  await controller.dispatch(command(controller, {
    type: "edit", edits: [{ cellId: "a", expectedRevision: 1, cellType: "code", body: ["other <- 3"] }],
  }));
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"], ["c", "z <- y"]]),
    runOnStartup: false,
  });
  await controller.start();
  const events: HostEvent[] = [];
  controller.subscribe((event) => events.push(event));
  const first = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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

  const disable = command(controller, { type: "disable", cellId: "b", disabled: true });
  await controller.dispatch(disable);
  const second = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
  const controller = new Controller({
    engine, notebook: notebook([["a", "x <- 1"], ["b", "y <- x + 1"], ["c", "z <- y + 1"]]), runOnStartup: false,
  });
  try {
    await controller.start();
    const initial = command(controller, {
      type: "run", scope: "all", source: "editor", edits: [], creations: [],
    });
    await controller.dispatch(initial);
    await settle(controller, initial.operationId);
    const edited = command(controller, {
      type: "run", scope: "cell", cellId: "a", source: "editor", creations: [],
      edits: [{ cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 }],
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- 2"], ["c", "x + y"]]),
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
  const evaluationsBeforeClear = engine.evaluations.length;

  const edit = command(controller, {
    type: "edit",
    edits: [
      { cellId: "a", body: ["x <- 10"], cellType: "code", expectedRevision: 0 },
      { cellId: "b", body: ["y <- 20"], cellType: "code", expectedRevision: 0 },
    ],
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
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
    : evaluationResponse(payload.source);
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "x <- side_effect_then_fail()"],
      ["b", "y <- x + 1"],
      ["c", "independent <- 42"],
    ]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "cat('ab\\nc\\n')"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "stream_output()"]]),
    runOnStartup: false,
  });
  await controller.start();
  const events: HostEvent[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event));
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "old" } });
  engine.emitEvaluationOutput("log", { lines: ["old log"] });
  engine.emitEvaluationOutput("progress", { progress: { value: 0.5 } });
  engine.emitEvaluationOutput("clear", {});
  assert.deepEqual(controller.snapshot().cells[0]?.outputs, []);
  assert.deepEqual(controller.snapshot().cells[0]?.log, []);
  assert.equal(controller.snapshot().cells[0]?.progress, null);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "new" } });
  engine.finishEvaluation({ ok: true, log: [] });
  await settle(controller, run.operationId);
  assert.deepEqual(controller.snapshot().cells[0]?.outputs, [{ kind: "text", text: "new" }]);
  assert.ok(events.some((event) => event.type === "cell-output"
    && (event.payload as { kind?: string }).kind === "clear"));
  const rerun = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(rerun);
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.deepEqual(controller.snapshot().cells[0]?.outputs, [{ kind: "text", text: "new" }]);
  assert.equal(controller.snapshot().cells[0]?.outputsStale, true);
  engine.emitEvaluationOutput("append", { output: { kind: "text", text: "replacement" } });
  assert.deepEqual(controller.snapshot().cells[0]?.outputs, [{ kind: "text", text: "replacement" }]);
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "cat(large_output)"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => engine.pendingEvaluations.length === 1);
  const completeLine = "x".repeat(70 * 1024);
  engine.finishEvaluation({ ok: true, outputs: [], log: [completeLine] });
  await settle(controller, run.operationId);
  assert.deepEqual(controller.snapshot().cells[0]?.log, [completeLine]);

  const oversizedRun = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"], ["b", "y <- x"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 9"], cellType: "code", expectedRevision: 0 }],
  });
  await controller.dispatch(edit);
  assert.deepEqual(engine.interrupts, [1]);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "obsolete" }] });
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
  const controller = new Controller({
    engine,
    notebook: notebook(sources.map((source, index) => [`cell-${index}`, source])),
    runOnStartup: false,
  });
  await controller.start();
  assert.equal(engine.analysisCalls.length, 1);
  assert.equal(engine.analysisCalls[0]?.length, sources.length);

  await controller.dispatch(command(controller, {
    type: "edit",
    edits: [{
      cellId: "cell-256",
      body: [sources[0]!],
      cellType: "code",
      expectedRevision: 0,
    }],
  }));
  await eventually(() => controller.snapshot().cells[256]?.analysisPending === false);
  assert.equal(engine.analysisCalls.length, 2);
  assert.equal(engine.analysisCalls[1]?.[0]?.source, sources[0]);

  await controller.dispatch(command(controller, {
    type: "edit",
    edits: [{
      cellId: "cell-255",
      body: [sources[256]!],
      cellType: "code",
      expectedRevision: 0,
    }],
  }));
  await eventually(() => controller.snapshot().cells[255]?.analysisPending === false);
  assert.equal(engine.analysisCalls.length, 2);
  await controller.close();
});

test("a source transaction publishes its immediate graph even when no analysis follows", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const events: string[] = [];
  const unsubscribe = controller.subscribe((event) => events.push(event.type));
  await controller.dispatch(command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["# Notes"],
      cellType: "markdown",
      expectedRevision: 0,
    }],
  }));
  const notebookEvent = events.indexOf("notebook");
  const graphEvent = events.indexOf("graph");
  const cellEvent = events.indexOf("cell");
  assert.ok(notebookEvent >= 0 && graphEvent > notebookEvent && cellEvent > graphEvent);
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

test("a late Stop cannot erase a successful matching completion", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "1 + 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  const stop = command(controller, { type: "interrupt" });
  await controller.dispatch(stop);
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "[1] 2" }] });
  const settled = await settle(controller, run.operationId);
  assert.equal(settled.status, "done");
  assert.equal(controller.snapshot().cells[0]?.status, "done");
  assert.equal((controller.snapshot().cells[0]?.outputs[0] as { text: string }).text, "[1] 2");
  await controller.close();
});

test("a matching interrupted Stop cancels the run after its cell result is published", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "repeat Sys.sleep(1)"]]),
    runOnStartup: false,
  });
  await controller.start();
  const events: string[] = [];
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "cell-completed") events.push("cell-completed");
    if (event.type === "operation"
      && (event.payload as { status?: string }).status === "cancelled") events.push("cancelled");
  });
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  await controller.dispatch(command(controller, { type: "interrupt" }));
  engine.finishEvaluation({
    ok: false,
    error: { message: "Interrupted", code: "interrupted", interrupted: true },
  });
  const settled = await controller.awaitOperation(run.operationId);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.error?.code, "interrupted");
  assert.equal(controller.snapshot().cells[0]?.status, "error");
  assert.deepEqual(events, ["cell-completed", "cancelled"]);
  unsubscribe();
  await controller.close();
});

test("widget owner edits cancel the exact operation and late replies cannot commit", async () => {
  const engine = new FakeEngine();
  let resolveWidget!: (response: EngineResponse) => void;
  engine.requestHandler = (name) => name === "set_widget"
    ? new Promise((resolve) => { resolveWidget = resolve; })
    : Promise.resolve({ ok: true });
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "threshold <- ui$slider(0, 10)"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  await controller.dispatch(widget);
  const edit = command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["threshold <- ui$slider(0, 20)"],
      cellType: "code",
      expectedRevision: 0,
    }],
  });
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(widget.operationId)).status, "cancelled");
  resolveWidget({ ok: true, selected: { value: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  const output = controller.snapshot().cells[0]?.outputs[0] as { spec: { value: number } };
  assert.equal(output.spec.value, 2);
  await controller.close();
});

test("a successful obsolete widget request replays authoritative source after unrelated work", async () => {
  const engine = new FakeEngine();
  let resolveWidget!: (response: EngineResponse) => void;
  engine.requestHandler = (name) => name === "set_widget"
    ? new Promise((resolve) => { resolveWidget = resolve; })
    : Promise.resolve({ ok: true });
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "threshold <- ui$slider(0, 10)"],
      ["b", "seen <- threshold"],
      ["c", "Sys.sleep(2)"],
    ]),
    runOnStartup: false,
    executionMode: "automatic",
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  engine.deferred = true;
  const unrelated = command(controller, {
    type: "run", scope: "cell", cellId: "c", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(unrelated);
  await eventually(() => engine.pendingEvaluations.length === 1);
  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 9 }, source: "editor",
  });
  await controller.dispatch(widget);
  await controller.dispatch(command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["threshold <- ui$slider(0, 10, value = 7)"],
      cellType: "code",
      expectedRevision: 0,
    }],
  }));
  assert.equal((await controller.awaitOperation(widget.operationId)).status, "cancelled");
  assert.equal(engine.evaluations.at(-1)?.cellId, "c");

  engine.finishEvaluation();
  await settle(controller, unrelated.operationId);
  resolveWidget({ ok: true, selected: { value: 9 } });
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(engine.evaluations.at(-1)?.cellId, "a");
  assert.equal(engine.evaluations.at(-1)?.revision, 1);
  assert.match(engine.evaluations.at(-1)?.source ?? "", /value = 7/);
  engine.finishEvaluation();
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(engine.evaluations.at(-1)?.cellId, "b");
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "[1] 7" }] });
  await eventually(() => controller.snapshot().cells.find((cell) => cell.id === "b")?.status === "done");
  assert.equal(
    (controller.snapshot().cells.find((cell) => cell.id === "b")?.outputs[0] as { text?: string }).text,
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
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "threshold <- ui$slider(0, 10)"],
      ["b", "seen <- threshold"],
    ]),
    runOnStartup: false,
    executionMode: "automatic",
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  const widget = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 9 }, source: "editor",
  });
  await controller.dispatch(widget);
  await controller.dispatch(command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["threshold <- ui$slider(0, 10, value = 7)"],
      cellType: "code",
      expectedRevision: 0,
    }],
  }));
  resolveWidget({ ok: false, error: { message: "request rejected before kernel entry" } });
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(engine.evaluations.map((evaluation) => evaluation.cellId), ["a", "b"]);
  assert.equal((await controller.awaitOperation(widget.operationId)).status, "cancelled");
  await controller.close();
});

test("an edited widget owner is rejected as stale before replacement analysis settles", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "threshold <- ui$slider(0, 10)"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

  let releaseAnalysis: (() => void) | undefined;
  engine.analyze = async (cells, revision) => {
    await new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    return {
      revision,
      analyzer: { packageVersion: "test", rVersion: "test", policy: "test" },
      cells: cells.map((cell) => analyzeCell(cell)),
    };
  };
  await controller.dispatch(command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["threshold <- ui$slider(0, 20)"],
      cellType: "code",
      expectedRevision: 0,
    }],
  }));
  await eventually(() => releaseAnalysis !== undefined);
  await assert.rejects(
    controller.dispatch(command(controller, {
      type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
    })),
    (error: unknown) => error instanceof ControllerError && error.code === "widget_not_current",
  );
  await assert.rejects(
    controller.dispatch(command(controller, { type: "inspect", name: "threshold" })),
    (error: unknown) => error instanceof ControllerError && error.code === "stale_value",
  );
  await assert.rejects(
    controller.dispatch(command(controller, { type: "inspect", name: "not_yet_owned" })),
    (error: unknown) => error instanceof ControllerError && error.code === "analysis_pending",
  );
  assert.equal(engine.requests.some((request) => request.command === "get_value"), false);
  releaseAnalysis?.();
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  await controller.close();
});

test("datetime updates reject impossible UTC calendar values before reaching R", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "stamp <- ui$datetime()"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
  await assert.rejects(
    controller.dispatch(update),
    (error: unknown) => error instanceof ControllerError
      && error.code === "invalid_request"
      && error.message === "temporal widget value required",
  );
  assert.equal(engine.requests.filter(({ command }) => command === "set_widget").length, 0);
  await controller.close();
});

test("widget operations settle after their automatic consumer run and inherit its error", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "threshold <- ui$slider(0, 10)"],
      ["b", "seen <- threshold"],
    ]),
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);

  engine.deferred = true;
  const successful = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 7 }, source: "editor",
  });
  await controller.dispatch(successful);
  await eventually(() => engine.pendingEvaluations.length === 1);
  assert.equal(controller.operation(successful.operationId)?.status, "running");
  engine.finishEvaluation({ ok: true, outputs: [{ kind: "text", text: "7" }] });
  assert.equal((await controller.awaitOperation(successful.operationId)).status, "done");

  const failed = command(controller, {
    type: "widget", name: "threshold", path: [], update: { value: 8 }, source: "editor",
  });
  await controller.dispatch(failed);
  await eventually(() => engine.pendingEvaluations.length === 1);
  engine.finishEvaluation({ ok: false, error: { message: "consumer boom" } });
  const failure = await controller.awaitOperation(failed.operationId);
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
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "x <- 1"],
      ["b", "lazy_value <- make_lazy()"],
      ["c", "table_value <- make_table()"],
    ]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
    type: "edit",
    edits: [
      { cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 },
      { cellId: "b", body: ["lazy_value <- make_lazy(2)"], cellType: "code", expectedRevision: 0 },
      { cellId: "c", body: ["table_value <- make_table(2)"], cellType: "code", expectedRevision: 0 },
    ],
  });
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(inspect.operationId)).error?.code, "stale_value");
  assert.equal((await controller.awaitOperation(lazy.operationId)).error?.code, "lazy_expired");
  assert.equal((await controller.awaitOperation(table.operationId)).error?.code, "table_unavailable");
  resolvers.get("get_value")?.({ ok: true, value: 999 });
  resolvers.get("lazy_eval")?.({ ok: true, output: { kind: "text", text: "obsolete lazy" } });
  resolvers.get("table_page")?.({ ok: true, page: { rows: [[999]] } });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = controller.snapshot();
  assert.equal(snapshot.lastValue, null);
  const lazyOutput = snapshot.cells.find((cell) => cell.id === "b")?.outputs[0] as
    | Record<string, unknown>
    | undefined;
  const tableOutput = snapshot.cells.find((cell) => cell.id === "c")?.outputs[0] as
    | Record<string, unknown>
    | undefined;
  assert.equal(lazyOutput?.child, undefined);
  assert.equal(tableOutput?.page, undefined);
  assert.deepEqual(tableOutput?.rows, [[1]]);
  for (const operationId of [inspect.operationId, lazy.operationId, table.operationId]) {
    assert.equal(snapshot.operations.find((operation) => operation.id === operationId)?.result, undefined);
  }
  await controller.close();
});

test("rerunning an owner expires a lazy request tied to its prior output object", async () => {
  const engine = new FakeEngine();
  let finishLazy!: (response: EngineResponse) => void;
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "lazy_value <- make_lazy()"]]),
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(rerun);
  await settle(controller, rerun.operationId);
  assert.equal((await controller.awaitOperation(lazy.operationId)).error?.code, "lazy_expired");
  finishLazy({ ok: true, output: { kind: "text", text: "obsolete lazy" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!JSON.stringify(controller.snapshot()).includes("obsolete lazy"));
  await controller.close();
});

test("lazy output completion uses the public loaded state and preserves renderer conditions", async () => {
  const engine = new FakeEngine();
  engine.requestHandler = async (name) => name === "lazy_eval"
    ? {
        ok: true,
        output: { kind: "text", text: "rendered" },
        log: ["renderer-message", "Warning: renderer-warning"],
      }
    : { ok: true };
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "lazy_value <- make_lazy()"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

  const expand = command(controller, { type: "lazy-output", key: "lazy-1" });
  await controller.dispatch(expand);
  await settle(controller, expand.operationId);

  const cell = controller.snapshot().cells[0]!;
  assert.deepEqual(cell.log, ["renderer-message", "Warning: renderer-warning"]);
  assert.deepEqual(cell.outputs[0], {
    kind: "lazy",
    key: "lazy-1",
    status: "pending",
    state: "loaded",
    child: { kind: "text", text: "rendered" },
  });
  await controller.close();
});

test("uploads use the file widget journal and retain successful stored values", async () => {
  const engine = new FakeEngine();
  const serviceCalls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  engine.requestHandler = async (name, payload) => name === "set_widget"
    ? { ok: true, selected: { value: payload.value } }
    : { ok: true };
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "files <- ui$file()"]]),
    runOnStartup: false,
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
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);

  const upload = command(controller, {
    type: "service",
    command: "upload",
    payload: {
      name: "files",
      path: [],
      source: "app",
      files: [{ name: "data.csv", content_base64: "eAo=" }],
    },
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
    spec: { value: unknown };
    operation: { operationId: string; status: string };
  };
  assert.deepEqual(output.spec.value, [{ name: "data.csv", size: 4, path: "/tmp/upload-1" }]);
  assert.equal(output.operation.operationId, upload.operationId);
  assert.equal(output.operation.status, "done");
  assert.equal(serviceCalls.some((call) => call.name === "upload.remove"), false);
  await controller.close();
});

test("an upload stored after its widget owner changes is removed and never reaches R", async () => {
  const engine = new FakeEngine();
  let finishStore!: (value: unknown) => void;
  const removed: string[] = [];
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "files <- ui$file()"]]),
    runOnStartup: false,
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
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const upload = command(controller, {
    type: "service",
    command: "upload",
    payload: { name: "files", path: [], files: [] },
  });
  await controller.dispatch(upload);
  await eventually(() => finishStore !== undefined);
  const edit = command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["files <- ui$file(accept = '.csv')"],
      cellType: "code",
      expectedRevision: 0,
    }],
  });
  await controller.dispatch(edit);
  assert.equal((await controller.awaitOperation(upload.operationId)).status, "cancelled");
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
    journalByteLimit: 64 * 1024,
  });
  await controller.start();
  const cursor = controller.cursor;
  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 }],
  });
  await controller.dispatch(edit);
  const replay = controller.recover(controller.epoch, cursor);
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.ok(replay.events.length > 0);
    assert.ok(replay.events.every((event, index, events) =>
      index === 0 || event.cursor > (events[index - 1]?.cursor ?? -1)));
  }
  assert.equal(controller.recover("old-epoch", cursor).kind, "snapshot");
  await controller.close();

  const bounded = new Controller({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
    journalByteLimit: 128,
  });
  await bounded.start();
  const oldCursor = bounded.cursor;
  const large = command(bounded, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 2 #" + "x".repeat(500)], cellType: "code", expectedRevision: 0 }],
  });
  await bounded.dispatch(large);
  assert.equal(bounded.recover(bounded.epoch, oldCursor).kind, "snapshot");
  await bounded.close();
});

test("editor diagnostics publish only for an exact source identity and clear on source changes", async () => {
  const controller = new Controller({
    engine: new FakeEngine(),
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const source: CellSnapshot[] = [{ id: "a", revision: 0, type: "code", source: "x <- 1" }];
  assert.equal(controller.publishEditorDiagnostics([
    { ...source[0]!, revision: 1 },
  ], { a: [] }), false);

  assert.equal(controller.publishEditorDiagnostics(source, {
    a: [{ level: "warning", code: "style", message: "Prefer a clearer name", source: "spoofed" }],
    ".document": [{ level: "info", code: "document", message: "Notebook diagnostic" }],
    missing: [{ level: "error", code: "unknown", message: "must not escape" }],
  }), true);
  let snapshot = controller.snapshot();
  assert.equal(snapshot.cells[0]?.diagnostics.at(-1)?.source, "lsp");
  assert.deepEqual(Object.keys(snapshot.editorDiagnostics).sort(), [".document", "a"]);
  assert.equal(snapshot.editorDiagnostics.missing, undefined);

  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 }],
  });
  await controller.dispatch(edit);
  snapshot = controller.snapshot();
  assert.deepEqual(snapshot.editorDiagnostics, {});
  assert.ok(snapshot.cells[0]?.diagnostics.every((diagnostic) => diagnostic.source !== "lsp"));
  assert.equal(controller.publishEditorDiagnostics(source, { a: [] }), false);
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
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 42"]]),
    runOnStartup: false,
  });
  const variableEvents: unknown[] = [];
  controller.subscribe((event) => {
    if (event.type === "variables") variableEvents.push(event.payload);
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(rerun);
  await settle(controller, rerun.operationId);
  context.mock.timers.tick(100);
  await eventually(() => resolveRefresh !== undefined);
  assert.deepEqual(controller.snapshot().variables, []);

  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 43"], cellType: "code", expectedRevision: 0 }],
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

test("concurrent config patches serialize and merge against the latest committed config", async () => {
  const engine = new FakeEngine();
  const calls: Array<Record<string, unknown>> = [];
  const resolvers: Array<(value: unknown) => void> = [];
  const controller = new Controller({
    engine,
    notebook: notebook([]),
    runOnStartup: false,
    config: { editor: { theme: "light" } },
    services: {
      service: async (name, payload) => {
        assert.equal(name, "config.update");
        calls.push(structuredClone(payload));
        return new Promise((resolve) => resolvers.push(resolve));
      },
    },
  });
  await controller.start();
  const first = command(controller, { type: "set-config", patch: { editor: { theme: "dark" } } });
  const second = command(controller, { type: "set-config", patch: { runtime: { timeout: 5 } } });
  const firstPromise = controller.dispatch(first);
  const secondPromise = controller.dispatch(second);
  await eventually(() => calls.length === 1);
  assert.equal(calls.length, 1);
  resolvers.shift()?.({ config: (calls[0] as { config: Record<string, unknown> }).config });
  await firstPromise;
  await eventually(() => calls.length === 2);
  const secondConfig = (calls[1] as { config: Record<string, unknown> }).config;
  assert.deepEqual(secondConfig, {
    editor: { theme: "dark" },
    runtime: { timeout: 5 },
  });
  resolvers.shift()?.({ config: secondConfig });
  await secondPromise;
  assert.deepEqual(controller.snapshot().config, secondConfig);
  await controller.close();
});

test("runtime and config controls keep metadata, config, and replay events coherent", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([]),
    runOnStartup: true,
    config: { theme: "light", on_cell_change: "automatic", on_startup: true },
    services: {
      service: async (name, payload) => {
        assert.equal(name, "config.update");
        return { config: payload.config };
      },
    },
  });
  await controller.start();
  const before = controller.cursor;
  await controller.dispatch(command(controller, {
    type: "set-runtime", executionMode: "lazy", runOnStartup: false,
  }));
  let state = controller.snapshot();
  assert.deepEqual(state.metadata.runtime, {
    execution_mode: "lazy", run_on_startup: false,
  });
  assert.equal(state.config.on_cell_change, "lazy");
  assert.equal(state.config.on_startup, false);
  assert.equal(state.changed, true);
  const replay = controller.recover(controller.epoch, before);
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.ok(replay.events.some((event) => event.type === "notebook"
      && (event.payload as { metadata?: unknown }).metadata !== undefined));
    assert.ok(replay.events.some((event) => event.type === "runtime"));
  }

  await controller.dispatch(command(controller, {
    type: "set-config", patch: { on_cell_change: "automatic", on_startup: true },
  }));
  state = controller.snapshot();
  assert.equal(state.runtime.executionMode, "automatic");
  assert.equal(state.runtime.runOnStartup, true);
  assert.deepEqual(state.metadata.runtime, {
    execution_mode: "automatic", run_on_startup: true,
  });
  await controller.close();
});

test("persisted layout updates do not mark clean notebook source dirty", async () => {
  const controller = new Controller({
    engine: new FakeEngine(),
    notebook: notebook([]),
    runOnStartup: false,
    services: {
      service: async (name, payload) => {
        assert.equal(name, "layout.update");
        return { layout: payload.layout };
      },
    },
  });
  await controller.start();
  await controller.dispatch(command(controller, {
    type: "set-layout", layout: { type: "grid", cells: [] },
  }));
  assert.deepEqual(controller.snapshot().layout, { type: "grid", cells: [] });
  assert.equal(controller.snapshot().changed, false);
  await controller.close();
});

test("exact source is returned only through the authoritative host service", async () => {
  const engine = new FakeEngine();
  const exact = "#| custom: value\r\n# %% [cell]\r\nx <- 1";
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
    services: {
      service: async (name, payload) => {
        calls.push({ name, payload: structuredClone(payload) });
        return { text: exact };
      },
    },
  });
  await controller.start();
  const source = command(controller, { type: "service", command: "source", payload: {} });
  const result = await controller.dispatch(source);
  assert.deepEqual(result.result, { text: exact });
  assert.deepEqual(calls, [{ name: "source", payload: {} }]);
  const injected = command(controller, {
    type: "service", command: "source", payload: { path: "/etc/passwd" },
  });
  await assert.rejects(
    controller.dispatch(injected),
    (error: unknown) => error instanceof ControllerError && error.code === "invalid_request",
  );
  assert.equal(calls.length, 1);
  await controller.close();
});

test("package installation is asynchronous, leaves edits responsive, blocks runs, and revalidates", async () => {
  const engine = new FakeEngine();
  let finishInstall!: (value: unknown) => void;
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
    services: {
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
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(firstRun);
  await settle(controller, firstRun.operationId);

  const install = command(controller, {
    type: "service",
    command: "packages",
    payload: { op: "install", package: "dplyr" },
  });
  const accepted = await controller.dispatch(install);
  assert.equal(accepted.operation.status, "running");
  assert.deepEqual(accepted.result, { accepted: true, command: "packages.install" });
  assert.equal(controller.snapshot().runtime.packageOperationActive, true);

  const edit = command(controller, {
    type: "edit",
    edits: [{ cellId: "a", body: ["x <- 2"], cellType: "code", expectedRevision: 0 }],
  });
  await controller.dispatch(edit);
  assert.equal(controller.snapshot().cells[0]?.revision, 1);
  const blockedRun = command(controller, {
    type: "run",
    scope: "cell",
    cellId: "a",
    source: "editor",
    edits: [{ cellId: "a", body: ["x <- 3"], cellType: "code", expectedRevision: 1 }],
    creations: [],
  });
  await assert.rejects(
    controller.dispatch(blockedRun),
    (error: unknown) => error instanceof ControllerError
      && error.code === "package_operation_in_progress",
  );
  assert.deepEqual(controller.snapshot().cells[0]?.body, ["x <- 2"]);

  finishInstall({ ok: true, status: "installed", packages: ["dplyr"] });
  const settled = await settle(controller, install.operationId);
  assert.equal(engine.restartCount, 1);
  assert.equal(controller.snapshot().runtime.packageOperationActive, false);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().cells[0]?.status, "stale");
  assert.deepEqual(calls.find((call) => call.name === "packages.install")?.payload, {
    packages: ["dplyr"],
  });
  assert.ok(calls.filter((call) => call.name === "packages.status").length >= 1);
  assert.equal((settled.result as { result: { status: string } }).result.status, "installed");
  await controller.close();
});

test("failed package installation still restarts and reanalyzes before settling error", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
    services: {
      service: async (name) => name === "packages.install"
        ? { ok: false, status: "error", error: { code: "install_failed", message: "no archive" } }
        : { declared: [], installed: [], missing: [] },
    },
  });
  await controller.start();
  const install = command(controller, {
    type: "service",
    command: "packages.install",
    payload: { packages: ["dplyr"] },
  });
  await controller.dispatch(install);
  const operation = await controller.awaitOperation(install.operationId);
  assert.equal(operation.status, "error");
  assert.equal(operation.error?.code, "install_failed");
  assert.equal(engine.restartCount, 1);
  assert.equal(controller.snapshot().runtime.executionReady, true);
  assert.equal(controller.snapshot().runtime.packageOperationActive, false);
  await controller.close();
});

test("package installation cannot start while a run is active", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  let serviceCalls = 0;
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
    services: { service: async () => { serviceCalls += 1; return {}; } },
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  const install = command(controller, {
    type: "service", command: "packages.install", payload: { packages: ["dplyr"] },
  });
  await assert.rejects(
    controller.dispatch(install),
    (error: unknown) => error instanceof ControllerError && error.code === "run_in_progress",
  );
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
  const controller = new Controller({
    engine,
    notebook: {
      path: "/tmp/test.R",
      metadata: {},
      cells: [
        { id: "a", type: "code", body: ["btn <- ui$button()"], options: {}, revision: 0 },
        { id: "b", type: "code", body: ["out <- btn"], options: { disabled: true }, revision: 0 },
      ],
    },
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await settle(controller, run.operationId);
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await controller.dispatch(widget);
  await eventually(() => finishReset !== undefined);
  const causalRunId = `run-button-${widget.operationId}`;
  const causalRun = controller.operation(causalRunId);
  assert.ok(causalRun);
  assert.equal(causalRun.status, "accepted");
  assert.equal(causalRun.executionDone, true);
  assert.equal(causalRun.resetOperationIds?.length, 1);
  assert.equal(controller.operation(widget.operationId)?.status, "running");

  finishReset({ ok: true, selected: { value: false } });
  assert.equal((await controller.awaitOperation(widget.operationId)).status, "done");
  assert.equal((await controller.awaitOperation(causalRunId)).status, "done");
  const output = controller.snapshot().cells[0]?.outputs[0] as { spec: { value: boolean } };
  assert.equal(output.spec.value, false);
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
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "btn <- ui$button()"],
      ["b", "seen <- btn"],
      ["c", "result <- seen"],
    ]),
    executionMode: "lazy",
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
    type: "run", scope: "cell", cellId: "b", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(explicit);
  await eventually(() => finishReset !== undefined);
  const pendingRun = controller.operation(explicit.operationId);
  assert.equal(pendingRun?.executionDone, true);
  assert.equal(pendingRun?.status, "running");
  assert.equal(pendingRun?.resetOperationIds?.length, 1);
  finishReset({ ok: true, selected: { value: false } });
  await settle(controller, widget.operationId);
  await settle(controller, explicit.operationId);
  assert.equal(
    (controller.snapshot().cells[0]?.outputs[0] as { spec: { value: boolean } }).spec.value,
    false,
  );
  unsubscribe();
  await controller.close();
});

test("nested run buttons reset only their addressed child and journal the reset", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([
      ["a", "controls <- ui$array(go = ui$button(), level = ui$slider(0, 10))"],
      ["b", "seen <- controls"],
    ]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
    spec: { children: Array<{ name: string; value: unknown }> };
    operations: Record<string, { operationId: string; status: string }>;
  };
  assert.equal(output.spec.children.find((child) => child.name === "go")?.value, false);
  assert.equal(output.spec.children.find((child) => child.name === "level")?.value, 5);
  const resetId = trigger.resetOperationIds?.[0];
  assert.ok(resetId);
  assert.equal(output.operations["controls\u0001go"]?.operationId, resetId);
  assert.equal(output.operations["controls\u0001go"]?.status, "done");
  await controller.close();
});

test("a run-button reset failure rejects the trigger and its causal run", async () => {
  const engine = new FakeEngine();
  engine.requestHandler = async (name, payload) => name === "set_widget" && payload.value === false
    ? { ok: false, error: { code: "reset_failed", message: "cannot reset" } }
    : { ok: true };
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "btn <- ui$button()"], ["b", "seen <- btn"]]),
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
  const widget = command(controller, {
    type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
  });
  await controller.dispatch(widget);
  const trigger = await controller.awaitOperation(widget.operationId);
  const causalRun = await controller.awaitOperation(`run-button-${widget.operationId}`);
  assert.equal(trigger.status, "error");
  assert.equal(trigger.error?.code, "widget_update_failed");
  assert.equal(trigger.error?.message, "cannot reset");
  assert.equal(trigger.error?.operationId, widget.operationId);
  assert.equal(causalRun.status, "error");
  assert.equal(causalRun.error?.code, "widget_update_failed");
  assert.equal(causalRun.error?.message, "cannot reset");
  assert.equal(causalRun.error?.operationId, causalRun.id);
  const output = controller.snapshot().cells[0]?.outputs[0] as {
    operation: { status: string; error: { code: string } };
  };
  assert.equal(output.operation.status, "error");
  assert.equal(output.operation.error.code, "widget_update_failed");
  await controller.close();
});

test("a failed barrier makes even never-run code stale", async () => {
  const engine = new FakeEngine();
  engine.deferred = true;
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "library(stats)"], ["b", "x <- 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "cell", cellId: "a", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(run);
  await eventually(() => controller.snapshot().runtime.busy);
  engine.finishEvaluation({ ok: false, error: { message: "attach failed" }, log: [] });
  await settle(controller, run.operationId);
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "a")?.status, "error");
  assert.equal(controller.snapshot().cells.find((cell) => cell.id === "b")?.status, "stale");
  await controller.close();
});

test("moving or deleting a barrier forces exactly one clean restart before the next run", async () => {
  for (const mutation of ["move", "delete"] as const) {
    const engine = new FakeEngine();
    const controller = new Controller({
      engine,
      notebook: notebook([["a", "library(stats)"], ["b", "x <- 1"], ["c", "y <- x"]]),
      runOnStartup: false,
    });
    await controller.start();
    const initial = command(controller, {
      type: "run", scope: "all", source: "editor", edits: [], creations: [],
    });
    await controller.dispatch(initial);
    await settle(controller, initial.operationId);
    if (mutation === "move") {
      await controller.dispatch(command(controller, { type: "move", cellId: "a", after: "c" }));
    } else {
      await controller.dispatch(command(controller, {
        type: "delete", cellId: "a", expectedRevision: 0,
      }));
    }
    assert.ok(controller.snapshot().cells
      .filter((cell) => cell.type === "code")
      .every((cell) => cell.status === "stale"));
    const rerun = command(controller, {
      type: "run", scope: "all", source: "editor", edits: [], creations: [],
    });
    await controller.dispatch(rerun);
    await settle(controller, rerun.operationId);
    assert.equal(engine.restartCount, 1, mutation);
    assert.ok(controller.snapshot().cells
      .filter((cell) => cell.type === "code")
      .every((cell) => cell.status === "done"));
    await controller.close();
  }
});

test("an explicit restart consumes opaque-source invalidation without a second restart", async () => {
  const engine = new FakeEngine();
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "source('helpers.R')"], ["b", "x <- 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const initial = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(initial);
  await settle(controller, initial.operationId);
  const edit = command(controller, {
    type: "edit",
    edits: [{
      cellId: "a",
      body: ["source('other.R')"],
      cellType: "code",
      expectedRevision: 0,
    }],
  });
  await controller.dispatch(edit);
  await eventually(() => controller.snapshot().cells[0]?.analysisPending === false);
  const restart = command(controller, { type: "restart", replay: false });
  await controller.dispatch(restart);
  assert.equal(engine.restartCount, 1);
  const rerun = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
  });
  await controller.dispatch(rerun);
  await settle(controller, rerun.operationId);
  assert.equal(engine.restartCount, 1);
  await controller.close();
});

test("closing invalidates outstanding runtime requests and discards late replies", async () => {
  const engine = new FakeEngine();
  let finishInspection!: (value: EngineResponse) => void;
  const controller = new Controller({
    engine,
    notebook: notebook([["a", "x <- 1"]]),
    runOnStartup: false,
  });
  await controller.start();
  const run = command(controller, {
    type: "run", scope: "all", source: "editor", edits: [], creations: [],
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
  assert.equal(controller.operation(inspect.operationId)?.status, "error");
});
