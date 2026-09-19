import assert from "node:assert/strict";
import test from "node:test";

import {
  ReactiveGraph,
  dependencyLevels,
  detectCycleNodes,
  reachableNodes,
  topologicalOrder,
  type GraphCellInput,
} from "../src/graph.js";
import { MAX_DEPENDENCY_EDGES, MAX_NOTEBOOK_CELLS } from "../src/protocol.js";

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
    diagnostics: [],
    error: null,
    ...values,
  };
}

test("static definitions and references produce deterministic dependency edges", () => {
  const graph = new ReactiveGraph([
    cell("a", { defs: ["x"] }),
    cell("b", { defs: ["y"], refs: ["x"] }),
    cell("c", { defs: ["z"], refs: ["x", "y"] }),
  ]).state;
  assert.deepEqual(graph.edges, { a: [], b: ["a"], c: ["a", "b"] });
  assert.deepEqual(graph.reverseEdges, { a: ["b", "c"], b: ["c"], c: [] });
  assert.deepEqual(graph.topologicalOrder, ["a", "b", "c"]);
});

test("duplicate globals block their defining cells and known descendants", () => {
  const graph = new ReactiveGraph([
    cell("first", { defs: ["shared"] }),
    cell("second", { defs: ["shared"] }),
    cell("dependent", { refs: ["shared"] }),
    cell("unrelated", { defs: ["other"] }),
  ]);
  assert.deepEqual(graph.state.duplicates, { shared: ["first", "second"] });
  assert.deepEqual(graph.state.topologicalOrder, ["unrelated"]);
  assert.deepEqual([...graph.blockedCellIds()], ["first", "second", "dependent"]);
  assert.match(graph.issuesForCell("first")[0]?.message ?? "", /global shared.*first, second/);
  assert.deepEqual(graph.issuesForCell("dependent").map((issue) => issue.code), ["invalid-dependency"]);
  assert.match(graph.issuesForCell("dependent")[0]?.message ?? "", /first, second/);
  assert.deepEqual(graph.issuesForCell("unrelated"), []);
});

test("cycle diagnostics block cycle members and known descendants while unrelated cells remain runnable", () => {
  const graph = new ReactiveGraph([
    cell("a", { defs: ["x"], refs: ["y"] }),
    cell("b", { defs: ["y"], refs: ["x"] }),
    cell("dependent", { refs: ["x"] }),
    cell("unrelated", { defs: ["z"] }),
  ]);
  assert.deepEqual(graph.state.cycles, ["a", "b"]);
  assert.deepEqual(graph.state.topologicalOrder, ["unrelated"]);
  assert.deepEqual(detectCycleNodes(graph.state.edges, graph.state.nodes), ["a", "b"]);
  assert.equal(topologicalOrder(graph.state.edges, graph.state.nodes), null);
  assert.match(graph.issuesForCell("a")[0]?.message ?? "", /cells: a, b/);
  assert.deepEqual(graph.issuesForCell("dependent").map((issue) => issue.code), ["invalid-dependency"]);
  assert.deepEqual(graph.issuesForCell("unrelated"), []);
});

test("parse and analyzer diagnostics do not become graph execution errors", () => {
  const graph = new ReactiveGraph([
    cell("parse", { error: "unexpected end of input" }),
    cell("dynamic", { diagnostics: [{ level: "error", message: "unknown effect" }] }),
  ]);
  assert.deepEqual(graph.validate(), []);
  assert.deepEqual(graph.state.topologicalOrder, ["parse", "dynamic"]);
});

test("every update rebuilds ownership and topology from the accepted cells", () => {
  const graph = new ReactiveGraph([
    cell("a", { defs: ["x"] }),
    cell("b", { refs: ["x"] }),
  ]);
  assert.deepEqual(graph.state.edges.b, ["a"]);
  graph.update([
    cell("a", { defs: ["other"] }),
    cell("b", { refs: ["x"] }),
    cell("c", { defs: ["x"] }),
  ]);
  assert.deepEqual(graph.state, new ReactiveGraph(graph.cells).state);
  assert.deepEqual(graph.state.edges.b, ["c"]);
  assert.deepEqual(graph.definitionOwners("x"), ["c"]);
});

test("disabled descendants and automatic versus lazy planning retain their behavior", () => {
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
    ["a", "stale"], ["b", "done"], ["c", "done"], ["unrelated", "done"],
  ]);
  const status = (id: string) => statuses.get(id) ?? "idle";
  assert.deepEqual(graph.planCell("a", status, "lazy"), ["a"]);
  assert.deepEqual(graph.planCell("a", status, "automatic"), ["a", "b", "c"]);
  assert.deepEqual(graph.planCell("c", status, "lazy"), ["a", "c"]);
});

test("accepted-depth chains and cycles do not consume the JavaScript call stack", () => {
  const nodes = Array.from({ length: MAX_NOTEBOOK_CELLS }, (_, index) => `cell-${index}`);
  const cells = nodes.map((id, index) => cell(id, {
    defs: [`value_${index}`],
    refs: index === 0 ? [] : [`value_${index - 1}`],
  }));
  const graph = new ReactiveGraph(cells);
  assert.deepEqual(graph.state.topologicalOrder, nodes);
  assert.equal(graph.descendants(nodes[0]!).length, MAX_NOTEBOOK_CELLS - 1);

  graph.update(cells.map((item, index) => index === 0
    ? cell(item.id, { defs: [...item.defs], refs: [`value_${MAX_NOTEBOOK_CELLS - 1}`] })
    : item));
  assert.deepEqual(graph.state.cycles, nodes);
  assert.deepEqual(graph.state.topologicalOrder, []);
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

test("static edge exhaustion fails coherently and clears after a bounded repair", () => {
  const count = Math.ceil((1 + Math.sqrt(1 + 8 * MAX_DEPENDENCY_EDGES)) / 2);
  const symbols = Array.from({ length: count }, (_, index) => `value_${index}`);
  const dense = symbols.map((symbol, index) => cell(`cell-${index}`, {
    defs: [symbol],
    refs: symbols.slice(0, index),
  }));
  const graph = new ReactiveGraph(dense);
  assert.equal(graph.resourceLimited, true);
  assert.equal(graph.state.topologicalOrder, null);
  assert.deepEqual(graph.validate().map((issue) => issue.code), ["graph_blocked"]);

  const sparse = dense.map((item) => cell(item.id, { defs: [...item.defs] }));
  graph.update(sparse);
  assert.equal(graph.resourceLimited, false);
  assert.deepEqual(graph.state.topologicalOrder, sparse.map((item) => item.id));
});

test("prototype-shaped R symbols remain ordinary duplicate-definition keys", () => {
  const graph = new ReactiveGraph([
    cell("a", { defs: ["__proto__"] }),
    cell("b", { defs: ["__proto__"] }),
  ]).state;
  assert.equal(Object.hasOwn(graph.duplicates, "__proto__"), true);
  assert.deepEqual(graph.duplicates["__proto__"], ["a", "b"]);
});

test("dot-prefixed globals are ordinary dependency and duplicate keys", () => {
  const graph = new ReactiveGraph([
    cell("first", { defs: [".x"] }),
    cell("second", { defs: [".x"] }),
    cell("consumer", { refs: [".x"] }),
  ]);
  assert.deepEqual(graph.state.duplicates[".x"], ["first", "second"]);
  assert.deepEqual([...graph.blockedCellIds()], ["first", "second", "consumer"]);
});
