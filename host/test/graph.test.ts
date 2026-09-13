import assert from "node:assert/strict";
import test from "node:test";

import {
  ReactiveGraph,
  buildDependencyGraph,
  dependencyLevels,
  detectCycleNodes,
  reachableNodes,
  topologicalOrder,
  type GraphCellInput,
} from "../src/graph.js";
import {
  MAX_DEPENDENCY_EDGES,
  MAX_NOTEBOOK_CELLS,
} from "../src/protocol.js";


function cell(
  id: string,
  values: Partial<Omit<GraphCellInput, "id" | "revision" | "type">> = {},
  type: GraphCellInput["type"] = "code",
): GraphCellInput {
  return {
    id,
    revision: 0,
    type,
    defs: [],
    refs: [],
    selfRefs: [],
    locals: [],
    barrier: false,
    opaque: false,
    diagnostics: [],
    error: null,
    ...values,
  };
}

test('metadata-only graph refresh preserves topology and updates validation', () => {
  const graph = new ReactiveGraph([cell('a', { defs: ['x'] }), cell('b', { refs: ['x'] })]);
  const state = graph.state;
  assert.equal(graph.refreshCellsIfTopologyUnchanged([cell('a', { defs: ['x'], error: 'invalid source' })]), true);
  assert.strictEqual(graph.state, state);
  assert.equal(graph.validate().some((issue) => issue.code === 'syntax-error'), true);
  assert.equal(graph.refreshCellsIfTopologyUnchanged([cell('a', { defs: ['other'] })]), false);
});

test("graph reproduces definition edges, duplicate owners, cycles, and deterministic order", () => {
  const graph = buildDependencyGraph([
    cell("a", { defs: ["x"] }),
    cell("b", { defs: ["y"], refs: ["x"] }),
    cell("c", { defs: ["z"], refs: ["x", "y"] }),
  ]);
  assert.deepEqual(graph.edges, { a: [], b: ["a"], c: ["a", "b"] });
  assert.deepEqual(graph.reverseEdges, { a: ["b", "c"], b: ["c"], c: [] });
  assert.deepEqual(graph.topologicalOrder, ["a", "b", "c"]);

  const duplicate = buildDependencyGraph([
    cell("a", { defs: ["x"] }),
    cell("b", { defs: ["x"] }),
  ]);
  assert.deepEqual(duplicate.duplicates, { x: ["a", "b"] });

  const cyclic = buildDependencyGraph([
    cell("a", { defs: ["x"], refs: ["y"] }),
    cell("b", { defs: ["y"], refs: ["x"] }),
    cell("c", { refs: ["x"] }),
  ]);
  assert.deepEqual(cyclic.cycles, ["a", "b"]);
  assert.equal(cyclic.topologicalOrder, null);
  assert.deepEqual(detectCycleNodes(cyclic.edges, cyclic.nodes), ["a", "b"]);
  assert.equal(topologicalOrder(cyclic.edges, cyclic.nodes), null);
});

test("self references cycle while package and opaque barriers preserve R ordering", () => {
  const graph = buildDependencyGraph([
    cell("before", { defs: ["x"] }),
    cell("package", { barrier: true }),
    cell("note", {}, "markdown"),
    cell("opaque", { barrier: true, opaque: true }),
    cell("after"),
    cell("self", { defs: ["counter"], selfRefs: ["counter"] }),
  ]);
  assert.deepEqual(graph.edges.package, []);
  assert.deepEqual(graph.edges.note, []);
  assert.deepEqual(graph.edges.opaque, ["package", "before"]);
  assert.deepEqual(graph.edges.after, ["package", "opaque"]);
  assert.ok(graph.edges.self?.includes("self"));
  assert.deepEqual(graph.cycles, ["self"]);
});

test("disabled cells block their complete descendant region and planning respects mode", () => {
  const graph = new ReactiveGraph([
    cell("a", { defs: ["x"] }),
    cell("b", { defs: ["y"], refs: ["x"] }),
    cell("c", { refs: ["y"] }),
    cell("unrelated"),
  ]);
  assert.deepEqual(graph.ancestors("c"), ["a", "b"]);
  assert.deepEqual(graph.descendants("a"), ["b", "c"]);
  assert.deepEqual([...graph.blockedByDisabled(new Set(["b"]))], ["b", "c"]);

  const statuses = new Map<string, import("../src/protocol.js").CellStatus>([
    ["a", "stale"],
    ["b", "done"],
    ["c", "done"],
    ["unrelated", "done"],
  ] as const);
  assert.deepEqual(
    graph.planCell("a", (id) => statuses.get(id) ?? "idle", "lazy"),
    ["a"],
  );
  assert.deepEqual(
    graph.planCell("a", (id) => statuses.get(id) ?? "idle", "automatic"),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    graph.planCell("c", (id) => statuses.get(id) ?? "idle", "lazy"),
    ["a", "c"],
  );
});

test("only analyzer error diagnostics block dispatch; warnings remain runnable", () => {
  const warning = new ReactiveGraph([
    cell("a", { diagnostics: [{ level: "warning", message: "conservative" }] }),
  ]);
  assert.deepEqual(warning.validate(), []);
  const invalid = new ReactiveGraph([
    cell("syntax", { error: "unexpected end of input" }),
    cell("dynamic", { diagnostics: [{ level: "error", message: "assign target is dynamic" }] }),
  ]);
  assert.deepEqual(
    invalid.validate().map((issue) => issue.code),
    ["analysis-error", "syntax-error"],
  );
});

test("unchanged dependencies retain graph state while validation metadata advances", () => {
  const graph = new ReactiveGraph([cell("a", { defs: ["x"] }), cell("b", { refs: ["x"] })]);
  const state = graph.state;
  graph.update([cell("a", {
    revision: 1, defs: ["x"], locals: ["scratch"], error: "invalid replacement",
    diagnostics: [{ level: "error", message: "unsafe analysis" }],
  }), cell("b", { refs: ["x"] })]);
  assert.equal(graph.state, state);
  assert.equal(graph.cells[0]?.revision, 1);
  assert.deepEqual(graph.cells[0]?.locals, ["scratch"]);
  assert.deepEqual(graph.validate().map((issue) => issue.code).sort(), ["analysis-error", "syntax-error"]);
  graph.update([cell("a", { revision: 2, defs: ["x"] }), cell("b", { refs: ["x"] })]);
  assert.equal(graph.state, state);
  assert.deepEqual(graph.validate(), []);
});

test("persistent graph updates match a fresh graph across ownership and structural changes", () => {
  let cells = [
    cell("a", { defs: ["x"] }),
    cell("b", { defs: ["y"], refs: ["x"] }),
    cell("c", { refs: ["y"] }),
    cell("note", {}, "markdown"),
  ];
  const graph = new ReactiveGraph(cells);
  const identity = graph;

  const check = (next: GraphCellInput[]): void => {
    cells = next;
    assert.equal(graph.update(cells), identity);
    const fresh = new ReactiveGraph(cells);
    assert.deepEqual(graph.state, buildDependencyGraph(cells));
    assert.deepEqual(graph.state, fresh.state);
    const symbols = new Set(cells.flatMap((item) => [...item.defs, ...item.refs]));
    for (const symbol of symbols) {
      assert.deepEqual(graph.definitionOwners(symbol), fresh.definitionOwners(symbol));
    }
    assert.deepEqual([...graph.blockedByDisabled()], [...fresh.blockedByDisabled()]);
  };

  check(cells.map((item) => item.id === "a"
    ? cell("a", { defs: ["z"] })
    : item));
  check(cells.map((item) => item.id === "b"
    ? cell("b", { defs: ["y"], refs: ["z"] })
    : item));
  check([
    ...cells.slice(0, 1),
    cell("d", { defs: ["z"] }),
    ...cells.slice(1),
  ]);
  check([
    cells.find((item) => item.id === "d")!,
    ...cells.filter((item) => item.id !== "d"),
  ]);
  check(cells.map((item) => item.id === "d"
    ? cell("d", { defs: ["z"], barrier: true })
    : item));
  check(cells.map((item) => item.id === "c"
    ? cell("c", { refs: ["y"], opaque: true })
    : item));
  check([
    cells.find((item) => item.id === "d")!,
    cells.find((item) => item.id === "c")!,
    ...cells.filter((item) => item.id !== "d" && item.id !== "c"),
  ]);
  check(cells.map((item) => item.id === "a"
    ? { ...item, disabled: true }
    : item));
  check(cells.filter((item) => item.id !== "d"));
  check(cells.map((item) => item.id === "b"
    ? cell("b", { defs: ["y"], refs: ["z"] }, "markdown")
    : item));
});

test("accepted-depth chains and cycles do not consume the JavaScript call stack", () => {
  const nodes = Array.from({ length: MAX_NOTEBOOK_CELLS }, (_, index) => `cell-${index}`);
  const cells = nodes.map((id, index) => cell(id, {
    defs: [`value_${index}`],
    refs: index === 0 ? [] : [`value_${index - 1}`],
  }));
  const graph = new ReactiveGraph(cells);
  assert.deepEqual(graph.state.topologicalOrder, nodes);
  const descendants = graph.descendants(nodes[0]!);
  assert.equal(descendants.length, MAX_NOTEBOOK_CELLS - 1);
  assert.equal(descendants[0], nodes[1]);
  assert.equal(descendants.at(-1), nodes.at(-1));

  const cyclic = cells.map((item, index) => index === 0
    ? cell(item.id, { defs: [...item.defs], refs: [`value_${MAX_NOTEBOOK_CELLS - 1}`] })
    : item);
  graph.update(cyclic);
  assert.equal(graph.state.topologicalOrder, null);
  assert.deepEqual(graph.state.cycles, nodes);
});

test("graph helpers preserve iterative reachability and layered order", () => {
  const edges = { a: [], b: ["a"], c: ["a"], d: ["b", "c"] };
  assert.deepEqual([...(dependencyLevels(edges, Object.keys(edges)) ?? [])], [
    ["a", 0], ["b", 1], ["c", 1], ["d", 2],
  ]);
  assert.deepEqual(reachableNodes({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }, "a"), [
    "b", "c", "d",
  ]);
});

test("aggregate edge admission is coherent and recovers transactionally", () => {
  const count = Math.ceil((1 + Math.sqrt(1 + 8 * MAX_DEPENDENCY_EDGES)) / 2);
  const dense = Array.from({ length: count }, (_, index) => cell(`barrier-${index}`, {
    barrier: true,
  }));
  const graph = new ReactiveGraph(dense);
  assert.equal(graph.resourceLimited, true);
  assert.equal(graph.state.topologicalOrder, null);
  assert.ok(Object.values(graph.state.edges).every((dependencies) => dependencies.length === 0));
  assert.deepEqual(graph.validate().map((issue) => issue.code), ["graph_blocked"]);

  const sparse = dense.map((item) => ({ ...item, barrier: false }));
  graph.update(sparse);
  assert.equal(graph.resourceLimited, false);
  assert.deepEqual(graph.state, buildDependencyGraph(sparse));
  assert.deepEqual(graph.state.topologicalOrder, sparse.map((item) => item.id));
});

test("prototype-shaped R symbols remain ordinary duplicate-definition keys", () => {
  const graph = buildDependencyGraph([
    cell("a", { defs: ["__proto__"] }),
    cell("b", { defs: ["__proto__"] }),
  ]);
  assert.equal(Object.hasOwn(graph.duplicates, "__proto__"), true);
  assert.deepEqual(graph.duplicates["__proto__"], ["a", "b"]);
});
