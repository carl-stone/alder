import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_PROTOCOL,
  MAX_JSON_DEPTH,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  ProtocolError,
  cellCreationSchema,
  commandResultSchema,
  decodeJsonFrame,
  engineEventSchema,
  evaluationPayloadSchema,
  hostEventSchema,
  hostSnapshotSchema,
  notebookInputSchema,
  parseHostCommand,
  recoverySchema,
} from "../src/protocol.js";

test("strict JSON frames reject duplicate decoded keys, invalid UTF-8, depth, and trailing input", () => {
  assert.throws(
    () => decodeJsonFrame('{"name":1,"\\u006eame":2}'),
    (error: unknown) => error instanceof ProtocolError && error.code === "duplicate_key",
  );
  assert.throws(
    () => decodeJsonFrame(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d])),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_utf8",
  );
  assert.throws(
    () => decodeJsonFrame(`${"[".repeat(MAX_JSON_DEPTH + 2)}0${"]".repeat(MAX_JSON_DEPTH + 2)}`),
    (error: unknown) => error instanceof ProtocolError && error.code === "nesting_too_deep",
  );
  assert.throws(
    () => decodeJsonFrame("{} false"),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_json",
  );
  assert.deepEqual(decodeJsonFrame('{"ok":true,"items":[1,null,"x"]}'), {
    ok: true,
    items: [1, null, "x"],
  });
});

test("JSON structural limits distinguish keys, nested values, and string punctuation", () => {
  const value = { 'quote"\\': ['{[,:]}', { nested: '"escaped"', repeated: 1 }, { repeated: 2 }], empty: {} };
  assert.deepEqual(decodeJsonFrame(JSON.stringify(value)), value);
  for (const source of [
    '{"outer":{"a":1,"\\u0061":2}}',
    '[{"a":[],"a":{}}]',
    '{"a\\\\":1,"a\\u005c":2}',
    '{"a" \t:1,"\\u0061"\r\n:2}',
  ]) assert.throws(() => decodeJsonFrame(source), (error: unknown) =>
    error instanceof ProtocolError && error.code === "duplicate_key");
  for (const source of ['{"x":}', '[1,]', '{"x" 1}', '"unterminated', '"bad\\q"', 'true false', '']) {
    assert.throws(() => decodeJsonFrame(source), (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_json");
  }
  assert.doesNotThrow(() => decodeJsonFrame('['.repeat(MAX_JSON_DEPTH) + '0' + ']'.repeat(MAX_JSON_DEPTH)));
  assert.deepEqual(decodeJsonFrame('{"key" \r\n: ["value:", "other"], "nested": {"key": 1}}'),
    { key: ["value:", "other"], nested: { key: 1 } });
  assert.throws(() => decodeJsonFrame('['.repeat(MAX_JSON_DEPTH + 1) + '0' + ']'.repeat(MAX_JSON_DEPTH + 1)),
    (error: unknown) => error instanceof ProtocolError && error.code === "nesting_too_deep");
});

test("source and revision schemas preserve the R integer and physical-line contract", () => {
  const notebook = {
    metadata: {},
    cells: [{ id: "cell-1", type: "code", body: ["x <- 1"], revision: 0, options: {} }],
  };
  assert.equal(notebookInputSchema.parse(notebook).cells[0]?.revision, 0);
  assert.throws(() => notebookInputSchema.parse({
    ...notebook,
    cells: [{ ...notebook.cells[0], revision: 2_147_483_648 }],
  }));
  for (const line of ["one\ntwo", "one\rtwo", "bad\0line", "\ud800"]) {
    assert.throws(() => notebookInputSchema.parse({
      ...notebook,
      cells: [{ ...notebook.cells[0], body: [line] }],
    }));
  }
  assert.throws(() => notebookInputSchema.parse({
    ...notebook,
    cells: [{ ...notebook.cells[0], type: "markdown", body: ["plain markdown"] }],
  }));
  assert.doesNotThrow(() => notebookInputSchema.parse({
    ...notebook,
    cells: [{ ...notebook.cells[0], type: "markdown", body: ["# heading", "", "  # text"] }],
  }));
  for (const options of [
    { nested: { bad: true } },
    { array: [1, 2] },
    { number: Number.POSITIVE_INFINITY },
    { disabled: "yes" },
  ]) {
    assert.throws(() => notebookInputSchema.parse({
      ...notebook,
      cells: [{ ...notebook.cells[0], options }],
    }));
  }
  assert.throws(() => cellCreationSchema.parse({
    clientOperationId: "create-1", options: { name: "not valid" },
  }));

  const cells = Array.from({ length: MAX_NOTEBOOK_CELLS }, (_, index) => ({
    id: `cell-${index}`,
    type: "code" as const,
    body: [],
    revision: 0,
    options: {},
  }));
  assert.equal(notebookInputSchema.safeParse({ metadata: {}, cells }).success, true);
  assert.equal(notebookInputSchema.safeParse({
    metadata: {},
    cells: [...cells, {
      id: `cell-${MAX_NOTEBOOK_CELLS}`,
      type: "code",
      body: [],
      revision: 0,
      options: {},
    }],
  }).success, false);

  const oneMiB = "x".repeat(1024 * 1024);
  const oversized = Array.from(
    { length: Math.floor(MAX_NOTEBOOK_SOURCE_BYTES / oneMiB.length) + 1 },
    () => oneMiB,
  );
  assert.equal(notebookInputSchema.safeParse({
    metadata: {},
    cells: [{ ...notebook.cells[0], body: oversized }],
  }).success, false);
});

test("cell Run identifies exactly one existing or same-command optimistic creation", () => {
  const base = { operationId: "op", sessionEpoch: "epoch", type: "run" as const };
  const existing = parseHostCommand({ ...base, scope: "cell", cellId: "cell-1" });
  assert.equal(existing.type, "run");
  if (existing.type !== "run") assert.fail("expected run command");
  assert.equal(existing.cellId, "cell-1");
  const created = parseHostCommand({
      ...base,
      scope: "cell",
      targetCreationId: "local-cell",
      creations: [{ clientOperationId: "local-cell", body: ["1 + 1"], cellType: "code" }],
    });
  assert.equal(created.type, "run");
  if (created.type !== "run") assert.fail("expected run command");
  assert.equal(created.targetCreationId, "local-cell");
  assert.throws(() => parseHostCommand({ ...base, scope: "cell" }));
  assert.throws(() => parseHostCommand({
    ...base,
    scope: "cell",
    cellId: "cell-1",
    targetCreationId: "local-cell",
  }));
});

test("engine clear-output deltas require the exact empty payload", () => {
  const clear = {
    type: "output",
    requestId: 1,
    sessionEpoch: "epoch",
    operationId: "operation",
    runId: "run",
    cellId: "cell-1",
    revision: 0,
    sequence: 1,
    kind: "clear",
    payload: {},
  };
  assert.equal(engineEventSchema.safeParse(clear).success, true);
  assert.equal(engineEventSchema.safeParse({ ...clear, payload: { wait: true } }).success, false);
  assert.equal(engineEventSchema.safeParse({ ...clear, payload: null }).success, false);
});

test("evaluation definitions and locals retain analyzer symbol bounds", () => {
  const payload = {
    sessionEpoch: "epoch",
    operationId: "operation",
    runId: "run",
    cellId: "cell-1",
    revision: 0,
    source: "x <- 1",
    definitions: ["x"],
    locals: [],
    opaque: false,
  };
  assert.equal(evaluationPayloadSchema.safeParse(payload).success, true);
  assert.equal(evaluationPayloadSchema.safeParse({
    ...payload,
    definitions: ["x".repeat(1_025)],
  }).success, false);
  assert.equal(evaluationPayloadSchema.safeParse({
    ...payload,
    locals: Array.from({ length: 10_001 }, () => "x"),
  }).success, false);
});

test("client service commands cannot reach internal codec, filesystem, or validation services", () => {
  const base = {
    operationId: "service-op",
    sessionEpoch: "epoch",
    type: "service" as const,
    payload: {},
  };
  const parsed = parseHostCommand({ ...base, command: "export" });
  assert.equal(parsed.type, "service");
  if (parsed.type !== "service") assert.fail("expected service command");
  assert.equal(parsed.command, "export");
  for (const command of ["codec.decode", "layout.read", "config.update", "config.resolve"]) {
    assert.throws(() => parseHostCommand({ ...base, command }));
  }
});

test("shared host response schemas validate complete bounded snapshots and deltas", () => {
  const cell = {
    id: "cell-1",
    type: "code" as const,
    body: ["x <- 1"],
    options: {},
    revision: 0,
    status: "done" as const,
    outputs: [{ kind: "text", text: "1" }],
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
  const snapshot = {
    protocol: HOST_PROTOCOL,
    epoch: "epoch-1",
    cursor: 7,
    version: 3,
    path: "/tmp/notebook.R",
    metadata: {},
    config: {},
    layout: null,
    changed: false,
    runtime: {
      executionMode: "automatic" as const,
      runOnStartup: false,
      executionReady: true,
      analyzerAvailable: true,
      kernelAvailable: true,
      packageOperationActive: false,
      busy: false,
      activeRunId: null,
    },
    cells: [cell],
    graph: {
      nodes: ["cell-1"],
      edges: { "cell-1": [] },
      reverseEdges: { "cell-1": [] },
      duplicates: {},
      cycles: [],
      topologicalOrder: ["cell-1"],
    },
    variables: [{
      name: "x",
      owner: "cell-1",
      revision: 0,
      class: "numeric",
      dim: null,
      size: 56,
      widget: false,
      valueSummary: "1",
    }],
    editorDiagnostics: { ".document": [] },
    serviceErrors: {},
    operations: [],
    lastValue: null,
    lastActionError: null,
  };
  assert.deepEqual(hostSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(hostSnapshotSchema.safeParse({
    ...snapshot,
    cells: [{ ...cell, log: Array.from({ length: 200_000 }, () => "") }],
  }).success, true);
  assert.equal(hostSnapshotSchema.safeParse({ ...snapshot, variables: undefined }).success, false);
  assert.equal(hostSnapshotSchema.safeParse({ ...snapshot, editorDiagnostics: undefined }).success, false);

  const variableEvent = {
    protocol: HOST_PROTOCOL,
    epoch: "epoch-1",
    cursor: 8,
    version: 3,
    timestamp: 1,
    type: "variables" as const,
    payload: snapshot.variables,
  };
  assert.deepEqual(hostEventSchema.parse(variableEvent), variableEvent);
  assert.equal(hostEventSchema.safeParse({
    ...variableEvent,
    payload: [{ ...snapshot.variables[0], valueSummary: "x".repeat(161) }],
  }).success, false);
  assert.equal(hostEventSchema.safeParse({
    ...variableEvent,
    payload: [{
      ...snapshot.variables[0],
      name: "é".repeat(512),
      class: "λ".repeat(512),
      valueSummary: "é".repeat(80),
    }],
  }).success, true);
  assert.equal(hostEventSchema.safeParse({
    ...variableEvent,
    payload: [{ ...snapshot.variables[0], name: "é".repeat(513) }],
  }).success, false);
  assert.equal(hostEventSchema.safeParse({
    ...variableEvent,
    payload: [{ ...snapshot.variables[0], class: "λ".repeat(513) }],
  }).success, false);
  assert.equal(hostEventSchema.safeParse({
    ...variableEvent,
    payload: [{ ...snapshot.variables[0], valueSummary: "é".repeat(81) }],
  }).success, false);
  assert.equal(hostEventSchema.safeParse({
    ...variableEvent,
    payload: [{ ...snapshot.variables[0], name: "broken\ud800" }],
  }).success, false);
  assert.equal(hostEventSchema.safeParse({ ...variableEvent, type: "invented" }).success, false);
  assert.equal(hostEventSchema.safeParse({ ...variableEvent, version: undefined }).success, false);
  assert.deepEqual(hostEventSchema.parse({
    ...variableEvent,
    cursor: 9,
    type: "service-error",
    payload: null,
  }).payload, null);

  const secondCell = { ...cell, id: "cell-2", defs: ["__proto__"] };
  const firstCell = { ...cell, defs: ["__proto__"] };
  const duplicates = Object.fromEntries([["__proto__", ["cell-1", "cell-2"]]]);
  const prototypeGraph = {
    nodes: ["cell-1", "cell-2"],
    edges: { "cell-1": [], "cell-2": [] },
    reverseEdges: { "cell-1": [], "cell-2": [] },
    duplicates,
    cycles: [],
    topologicalOrder: ["cell-1", "cell-2"],
  };
  const parsedPrototypeSnapshot = hostSnapshotSchema.parse({
    ...snapshot,
    cells: [firstCell, secondCell],
    graph: prototypeGraph,
  });
  assert.equal(Object.hasOwn(parsedPrototypeSnapshot.graph.duplicates, "__proto__"), true);
  assert.deepEqual(parsedPrototypeSnapshot.graph.duplicates["__proto__"], ["cell-1", "cell-2"]);
  const parsedPrototypeEvent = hostEventSchema.parse({
    ...variableEvent,
    cursor: 10,
    type: "graph",
    payload: prototypeGraph,
  });
  assert.equal(Object.hasOwn(
    (parsedPrototypeEvent.payload as typeof prototypeGraph).duplicates,
    "__proto__",
  ), true);
  assert.deepEqual(
    (parsedPrototypeEvent.payload as typeof prototypeGraph).duplicates["__proto__"],
    ["cell-1", "cell-2"],
  );

  const operation = {
    id: "save-1",
    kind: "save" as const,
    status: "done" as const,
    acceptedAt: 1,
    settledAt: 2,
    error: null,
  };
  assert.equal(commandResultSchema.safeParse({
    operation,
    version: 3,
    cursor: 8,
  }).success, true);
  assert.equal(commandResultSchema.safeParse({
    operation: { ...operation, status: "invented" },
    version: 3,
    cursor: 8,
  }).success, false);

  assert.equal(recoverySchema.safeParse({
    kind: "snapshot",
    epoch: "epoch-1",
    cursor: 7,
    snapshot,
  }).success, true);
  assert.equal(recoverySchema.safeParse({
    kind: "snapshot",
    epoch: "different-epoch",
    cursor: 7,
    snapshot,
  }).success, false);
  assert.equal(recoverySchema.safeParse({
    kind: "replay",
    epoch: "epoch-1",
    cursor: 9,
    events: [variableEvent],
  }).success, false);
});
