import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_PROTOCOL,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  canonicalBase64ByteLength,
  ProtocolError,
  commandResultSchema,
  decodeHostCommandWire,
  decodeHostQueryWire,
  decodeHostSnapshotWire,
  decodeWireSource,
  encodeHostCommandWire,
  encodeHostQueryWire,
  encodeHostSnapshotWire,
  encodeWireSource,
  clearCellRequestSchema,
  decodeJsonFrame,
  engineEventSchema,
  engineResponseSchema,
  evaluationPayloadSchema,
  hostEventSchema,
  hostSnapshotSchema,
  notebookInputSchema,
  parseHostCommand,
  rawEngineErrorSchema,
  rawConditionErrorSchema,
  parseHostQuery,
  rawValidationErrorSchema,
  recoverySchema,
  releaseOutputsResponseSchema,
} from "../src/protocol.js";
import { renderHelp } from "../src/markdown.js";

test("JSON frames use the standard parser and enforce I/O byte and UTF-8 limits", () => {
  assert.deepEqual(decodeJsonFrame('{"ok":true,"items":[1,null,"x"]}'), { ok: true, items: [1, null, "x"] });
  assert.deepEqual(decodeJsonFrame('{"name":1,"name":2}'), { name: 2 });
  assert.throws(() => decodeJsonFrame(Uint8Array.from([0xc3, 0x28])),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_utf8");
  assert.throws(() => decodeJsonFrame('{"long":true}', 4),
    (error: unknown) => error instanceof ProtocolError && error.code === "frame_too_large");
  assert.throws(() => decodeJsonFrame('{} false'),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_json");
});

test("source and revision schemas preserve the R integer and physical-line contract", () => {
  const notebook = {
    metadata: {},
    cells: [{ id: "cell-1", type: "code", body: ["x <- 1"], revision: 0, options: {} }],
  };
  assert.equal(notebookInputSchema.parse(notebook).cells[0]?.revision, 0);
  assert.doesNotThrow(() => notebookInputSchema.parse({
    ...notebook,
    cells: [{ ...notebook.cells[0], revision: 2_147_483_648 }],
  }));
  assert.throws(() => notebookInputSchema.parse({
    ...notebook,
    cells: [{ ...notebook.cells[0], revision: Number.MAX_SAFE_INTEGER + 1 }],
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

test("wire source keeps scalar and line-array identity with strict UTF-8/base64 validation", () => {
  for (const source of [[] as string[], [""], ["one", "two"], "", "one\ntwo", "\ufeffbom"]) {
    const wire = encodeWireSource(source);
    assert.deepEqual(decodeWireSource(wire), source);
    assert.equal(wire.encoding, "base64");
    assert.equal(typeof wire.data, "string");
    assert.equal(wire.lines, typeof source === "string" ? null : source.length);
  }
  assert.throws(() => encodeWireSource("\ud800"), ProtocolError);
  assert.throws(() => decodeWireSource({ encoding: "base64", data: "AB==", lines: null }), ProtocolError);
  assert.throws(() => decodeWireSource({ encoding: "base64", data: "", lines: 2 }), ProtocolError);
  assert.throws(() => decodeWireSource({ encoding: "base64", data: "wA==", lines: null }), ProtocolError);
  const encoder = new TextEncoder();
  const unit = "# utf8 λ\t\n";
  const repeats = Math.floor((MAX_NOTEBOOK_SOURCE_BYTES - 1) / encoder.encode(unit).byteLength);
  let largestSource = unit.repeat(repeats);
  largestSource += "x".repeat(MAX_NOTEBOOK_SOURCE_BYTES - encoder.encode(largestSource).byteLength);
  const largestWire = encodeWireSource(largestSource);
  assert.equal(canonicalBase64ByteLength(largestWire.data), MAX_NOTEBOOK_SOURCE_BYTES);
  assert.equal(decodeWireSource(largestWire), largestSource);

  const command = parseHostCommand({
    type: "transaction", requestId: "wire-op", clientId: "wire-client", sessionEpoch: "wire-epoch",
    expectedDocumentRevision: 0,
    changes: [{ type: "create", creationId: "wire-cell", after: null, body: ["x <- 1", "x"], cellType: "code", options: {} }],
  });
  const encoded = encodeHostCommandWire(command) as Record<string, unknown>;
  const encodedChange = (encoded.changes as Array<Record<string, unknown>>)[0]!;
  assert.equal(typeof encodedChange.body, "object");
  assert.deepEqual(parseHostCommand(decodeHostCommandWire(encoded)), command);
  const query = parseHostQuery({ type: "help", contents: "hover text" });
  assert.deepEqual(parseHostQuery(decodeHostQueryWire(encodeHostQueryWire(query))), query);
  const structuredContents = [
    { kind: "markdown", value: "**safe** <script>bad()</script>" },
    { language: "r", value: "x <- 1" },
  ];
  const structuredQuery = parseHostQuery({ type: "help", contents: structuredContents });
  const structuredWire = encodeHostQueryWire(structuredQuery);
  const structuredRoundTrip = parseHostQuery(decodeHostQueryWire(structuredWire));
  assert.deepEqual(structuredRoundTrip, structuredQuery);
  assert.equal(structuredRoundTrip.type, "help");
  if (structuredRoundTrip.type !== "help") assert.fail("expected help query");
  const rendered = renderHelp(structuredRoundTrip.contents as never);
  assert.deepEqual(rendered.diagnostics, []);
  assert.match(rendered.html, /<strong>safe<\/strong>/);
  assert.match(rendered.html, /<pre><code>x &lt;- 1<\/code><\/pre>/);
  assert.doesNotMatch(rendered.html, /<script/);
});

test("cell Run identifies exactly one existing or same-command optimistic creation", () => {
  const base = {
    requestId: "op", clientId: "client", sessionEpoch: "epoch",
    type: "run" as const, expectedDocumentRevision: 0,
  };
  const existing = parseHostCommand({ ...base, scope: "cell", target: { cellId: "cell-1" } });
  assert.equal(existing.type, "run");
  if (existing.type !== "run") assert.fail("expected run command");
  assert.deepEqual(existing.target, { cellId: "cell-1" });
  const created = parseHostCommand({
    ...base,
    scope: "cell",
    target: { creationId: "local-cell" },
    changes: [{ type: "create", creationId: "local-cell", after: null, body: ["1 + 1"], cellType: "code", options: {} }],
  });
  assert.equal(created.type, "run");
  if (created.type !== "run") assert.fail("expected run command");
  assert.deepEqual(created.target, { creationId: "local-cell" });
  assert.throws(() => parseHostCommand({ ...base, scope: "cell" }));
  assert.throws(() => parseHostCommand({ ...base, scope: "all", target: { cellId: "cell-1" } }));
});
test("engine clear-output deltas require the exact empty payload", () => {
  const clear = {
    type: "output",
    requestId: 1,
    sessionEpoch: "epoch",
    kernelEpoch: "kernel",
    operationId: "operation",
    runId: "run",
    cellId: "cell-1",
    revision: 0,
    documentRevision: 0,
    sequence: 1,
    kind: "clear",
    payload: {},
  };
  assert.equal(engineEventSchema.safeParse(clear).success, true);
  assert.equal(engineEventSchema.safeParse({ ...clear, payload: { wait: true } }).success, false);
  assert.equal(engineEventSchema.safeParse({ ...clear, payload: null }).success, false);
});
test("clear-cell requests use one bounded unique batch", () => {
  assert.deepEqual(clearCellRequestSchema.parse({ ids: ["cell-a", "cell-b"] }), { ids: ["cell-a", "cell-b"] });
  assert.equal(clearCellRequestSchema.safeParse({ ids: ["cell-a", "cell-a"] }).success, false);
  assert.equal(clearCellRequestSchema.safeParse({ id: "cell-a" }).success, false);
  assert.equal(clearCellRequestSchema.safeParse({ ids: [] }).success, false);
  const symbolPayload = { ids: ["cell-a"] } as Record<PropertyKey, unknown>;
  symbolPayload[Symbol("extra")] = true;
  assert.equal(clearCellRequestSchema.safeParse(symbolPayload).success, false);
});
test("Ark command responses preserve strict typed fields", () => {
  const text = { kind: "text", text: "ok", truncated: false };
  const page = {
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
  };
  const response = engineResponseSchema.parse({
    ok: true,
    package_version: "0.1.0",
    r_version: "4.4.0",
    output: text,
    value: text,
    page,
    selected: { type: "character", value: "ok" },
    log: [],
    truncated: false,
    variables: [{
      name: "x",
      class: "numeric",
      dim: null,
      size: 8,
      widget: false,
      value_summary: "1",
    }],
    failures: [{
      name: "cell-1",
      action: "clear_definition",
      active: false,
      locked: false,
      message: "cleanup failed",
    }],
  });
  assert.deepEqual(response.output, text);
  assert.deepEqual(response.value, text);
  assert.deepEqual(response.page, page);
  assert.equal(response.variables?.[0]?.value_summary, "1");
  assert.equal(response.failures?.[0]?.action, "clear_definition");
  assert.equal(engineResponseSchema.safeParse({ ...response, extra: true }).success, false);
  assert.equal(engineResponseSchema.safeParse({ ...response, output: { kind: "unknown" } }).success, false);
});
test("raw Ark errors strictly distinguish R conditions from validation failures", () => {
  const condition = {
    message: "ordinary error",
    class: ["simpleError", "error", "condition"],
    call: null,
    trace: ["stop(\"ordinary error\")"],
    code: "evaluation_error",
    details: { condition: "raw-condition", data: "raw-data" },
  };
  assert.deepEqual(rawConditionErrorSchema.parse(condition), condition);
  assert.deepEqual(rawEngineErrorSchema.parse(condition), condition);

  const validation = { message: "invalid request", code: "invalid_request" };
  assert.deepEqual(rawValidationErrorSchema.parse(validation), validation);
  assert.deepEqual(rawEngineErrorSchema.parse(validation), validation);
  assert.equal(rawEngineErrorSchema.safeParse({ ...condition, call: undefined }).success, false);
  assert.equal(rawEngineErrorSchema.safeParse({ ...validation, class: [], call: null, trace: [] }).success, false);
  assert.equal(rawEngineErrorSchema.safeParse({ ...condition, extra: true }).success, false);

  const utf8 = "é".repeat(8_192);
  assert.equal(rawConditionErrorSchema.safeParse({ ...condition, message: utf8 }).success, true);
  assert.equal(rawConditionErrorSchema.safeParse({ ...condition, message: `${utf8}é` }).success, false);
});

test("evaluation definitions and locals retain analyzer symbol bounds", () => {
  const payload = {
    sessionEpoch: "epoch",
    kernelEpoch: "kernel",
    operationId: "operation",
    runId: "run",
    cellId: "cell-1",
    revision: 0,
    documentRevision: 0,
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
    requestId: "service-op",
    clientId: "client",

    sessionEpoch: "epoch",
    expectedDocumentRevision: 0,
  };
  const parsed = parseHostCommand({ ...base, type: "set-app", patch: { layout: "grid" } });
  assert.equal(parsed.type, "set-app");
  for (const command of ["codec.decode", "layout.read", "config.update", "config.resolve"]) {
    assert.throws(() => parseHostCommand({ ...base, type: "service", command, payload: {} }));
  }
});
test("shared host response schemas validate complete bounded snapshots and deltas", () => {
  const disk = { state: "present" as const, digest: "0".repeat(64), version: "disk-v1", error: null };
  const output = {
    id: "output-1", sessionEpoch: "epoch-1", kernelEpoch: "kernel-1", runId: "run-1", cellId: "cell-1",
    revision: 0, sequence: 1,
    data: { kind: "text", text: "1", truncated: false }, metadata: { presentation: "inline" }, truncated: false,
  };
  const widgetOutput = {
    id: "widget-output-1", sessionEpoch: "epoch-1", kernelEpoch: "kernel-1", runId: "run-1", cellId: "cell-1",
    revision: 0, sequence: 2,
    data: {
      kind: "widget" as const, name: "control", owner: "cell-1", path: [], commit_token: null,
      operation: { token: 1, operationId: "op-1", status: "pending", error: null },
      operations: { control: { token: 1, operationId: "op-1", status: "pending", error: null } },
      spec: { kind: "slider", value: 3, min: 0, max: 5, step: 1 },
    },
    metadata: { presentation: "inline" }, truncated: false,
  };
  const cell = {
    id: "cell-1", type: "code" as const, body: ["x <- 1"], options: {}, revision: 0, status: "done" as const,
    outputs: [output, widgetOutput], progress: null, log: [], error: null, defs: ["x"], refs: [], selfRefs: [], locals: [],
    barrier: false, opaque: false, diagnostics: [], analysisPending: false,
  };
  const snapshot = {
    protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 7, version: 3, documentRevision: 7,
    path: "/tmp/notebook.R", metadata: {}, config: {}, layout: null, dirty: false, changed: false,
    disk, sidecars: { config: disk, layout: disk, packages: disk },
    runtime: {
      documentReady: true, analyzerState: "ready" as const, kernelState: "ready" as const, executionReady: true,
      executionBlockedReason: null, kernelEpoch: "kernel-1", rEnvironment: null, analysisEnvironmentId: "analysis-1",
      executionMode: "automatic" as const, runOnStartup: false, startupActivated: false, packageOperationActive: false, busy: false, activeRunId: null,
    },
    cells: [cell],
    graph: { nodes: ["cell-1"], edges: { "cell-1": [] }, reverseEdges: { "cell-1": [] }, duplicates: {}, cycles: [], topologicalOrder: ["cell-1"] },
    variables: [{ name: "x", owner: "cell-1", revision: 0, class: "numeric", dim: null, size: 56, widget: false, valueSummary: "1" }],
    editorDiagnostics: { ".document": [] }, serviceErrors: {}, operations: [], lastValue: null, lastActionError: null,
  };
  assert.deepEqual(hostSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(hostSnapshotSchema.safeParse({ ...snapshot, cells: [{ ...cell, log: Array.from({ length: 200_000 }, () => "") }] }).success, true);
  assert.equal(hostSnapshotSchema.safeParse({ ...snapshot, variables: undefined }).success, false);
  assert.equal(hostSnapshotSchema.safeParse({ ...snapshot, editorDiagnostics: undefined }).success, false);
  const snapshotWire = encodeHostSnapshotWire(snapshot) as Record<string, unknown>;
  const wireCell = (snapshotWire.cells as Array<Record<string, unknown>>)[0]!;
  assert.equal(typeof wireCell.body, "object");
  assert.deepEqual(hostSnapshotSchema.parse(decodeHostSnapshotWire(snapshotWire)), snapshot);
  const variableEvent = {
    protocol: HOST_PROTOCOL, epoch: "epoch-1", cursor: 8, version: 3, documentRevision: 7, timestamp: 1,
    type: "variables" as const, payload: snapshot.variables,
  };
  assert.deepEqual(hostEventSchema.parse(variableEvent), variableEvent);
  assert.equal(hostEventSchema.safeParse({ ...variableEvent, type: "invented" }).success, false);
  assert.equal(hostEventSchema.safeParse({ ...variableEvent, version: undefined }).success, false);
  assert.deepEqual(hostEventSchema.parse({ ...variableEvent, cursor: 9, type: "service-error", payload: null }).payload, null);

  const secondCell = { ...cell, id: "cell-2", defs: ["__proto__"] };
  const firstCell = { ...cell, defs: ["__proto__"] };
  const duplicates = Object.fromEntries([["__proto__", ["cell-1", "cell-2"]]]);
  const prototypeGraph = {
    nodes: ["cell-1", "cell-2"], edges: { "cell-1": [], "cell-2": [] }, reverseEdges: { "cell-1": [], "cell-2": [] },
    duplicates, cycles: [], topologicalOrder: ["cell-1", "cell-2"],
  };
  const parsedPrototypeSnapshot = hostSnapshotSchema.parse({ ...snapshot, cells: [firstCell, secondCell], graph: prototypeGraph });
  assert.equal(Object.hasOwn(parsedPrototypeSnapshot.graph.duplicates, "__proto__"), true);
  assert.deepEqual(parsedPrototypeSnapshot.graph.duplicates["__proto__"], ["cell-1", "cell-2"]);
  const parsedPrototypeEvent = hostEventSchema.parse({ ...variableEvent, cursor: 10, type: "graph", payload: prototypeGraph });
  assert.equal(Object.hasOwn((parsedPrototypeEvent.payload as typeof prototypeGraph).duplicates, "__proto__"), true);
  assert.deepEqual((parsedPrototypeEvent.payload as typeof prototypeGraph).duplicates["__proto__"], ["cell-1", "cell-2"]);

  const completion = { requestId: "save-1", epoch: "epoch-1", documentRevision: 7, version: 3, cursor: 8, result: null, error: null };
  assert.equal(commandResultSchema.safeParse(completion).success, true);
  assert.equal(commandResultSchema.safeParse({ ...completion, requestId: undefined }).success, false);

  assert.equal(recoverySchema.safeParse({ kind: "snapshot", epoch: "epoch-1", cursor: 7, snapshot }).success, true);
  assert.equal(recoverySchema.safeParse({ kind: "snapshot", epoch: "different-epoch", cursor: 7, snapshot: undefined }).success, false);
  assert.equal(recoverySchema.safeParse({ kind: "replay", epoch: "epoch-1", cursor: 9, events: [variableEvent] }).success, false);
  assert.equal(releaseOutputsResponseSchema.safeParse({ ok: true, released: ["artifact.bin"], missing: ["missing.bin"], failed: [] }).success, true);
  assert.equal(releaseOutputsResponseSchema.safeParse({ ok: true, released: [], missing: undefined, failed: [] }).success, false);
  assert.equal(releaseOutputsResponseSchema.safeParse({ ok: false, error: { code: "invalid_request", message: "bad request" } }).success, true);
  assert.equal(releaseOutputsResponseSchema.safeParse({ ok: true, released: ["../escape"], missing: [], failed: [] }).success, false);
});
