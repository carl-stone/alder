import assert from "node:assert/strict";
import test from "node:test";

import { ReactiveGraph, type GraphCellInput } from "../src/graph.js";
import { SeededRandom, seedLabel } from "./seeded.js";

const SEED = 0xa1de2026;
const CASES = 160;
const MAX_CELLS = 9;
const SYMBOLS = ["a", "b", "c", "d", ".hidden", "café"];

interface Oracle {
  owners: Record<string, string[]>;
  edges: Record<string, string[]>;
  reverseEdges: Record<string, string[]>;
  duplicates: Record<string, string[]>;
  cycles: string[];
  blocked: string[];
  runnable: string[];
}

test("seeded dependency graphs agree with an independent brute-force oracle", { timeout: 2_000 }, (context) => {
  context.diagnostic(`seed=${seedLabel(SEED)} cases=${CASES} maxCells=${MAX_CELLS}`);
  const random = new SeededRandom(SEED);
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const cells = graphCase(random, caseIndex);
    const mismatch = graphMismatch(cells);
    if (mismatch === null) continue;
    const minimized = minimize(cells);
    assert.fail(`${mismatch}; seed=${seedLabel(SEED)} case=${caseIndex} minimized=${JSON.stringify(minimized)}`);
  }
});

function graphCase(random: SeededRandom, caseIndex: number): GraphCellInput[] {
  const count = 1 + random.integer(MAX_CELLS);
  const cells = Array.from({ length: count }, (_, index): GraphCellInput => ({
    id: `cell-${index}`,
    revision: 0,
    type: random.boolean(0.12) ? "markdown" : "code",
    defs: choose(random, SYMBOLS, 0.28),
    refs: choose(random, SYMBOLS, 0.35),
    selfRefs: random.boolean(0.12) ? [random.pick(SYMBOLS)] : [],
    diagnostics: [],
    error: null,
    disabled: random.boolean(0.1),
  }));
  if (count >= 4) {
    const mode = caseIndex % 4;
    if (mode === 0) {
      cells[0]!.defs = ["forced-duplicate"];
      cells[1]!.defs = ["forced-duplicate"];
      cells[2]!.refs = ["forced-duplicate"];
    } else if (mode === 1) {
      cells[0]!.defs = ["forced-left"];
      cells[0]!.refs = ["forced-right"];
      cells[1]!.defs = ["forced-right"];
      cells[1]!.refs = ["forced-left"];
      cells[2]!.refs = ["forced-left"];
    } else if (mode === 2) {
      cells[0]!.defs = ["independent"];
      cells[1]!.defs = ["chain-a"];
      cells[2]!.defs = ["chain-b"];
      cells[2]!.refs = ["chain-a"];
      cells[3]!.refs = ["chain-b"];
    } else {
      cells[0]!.selfRefs = ["self"];
    }
  }
  return cells;
}

function choose(random: SeededRandom, values: readonly string[], probability: number): string[] {
  const selected = values.filter(() => random.boolean(probability));
  if (selected.length > 0 && random.boolean(0.15)) selected.push(selected[0]!);
  return selected;
}

function graphMismatch(cells: readonly GraphCellInput[]): string | null {
  const actual = new ReactiveGraph(cells);
  const expected = oracle(cells);
  for (const symbol of Object.keys(expected.owners)) {
    if (!equal(actual.definitionOwners(symbol), expected.owners[symbol]!)) return `owners differ for ${symbol}`;
  }
  if (!equalRecord(actual.state.edges, expected.edges)) return "dependency edges differ";
  if (!equalRecord(actual.state.reverseEdges, expected.reverseEdges)) return "reverse dependency edges differ";
  if (!equalRecord(actual.state.duplicates, expected.duplicates)) return "duplicate definitions differ";
  if (!equal(actual.state.cycles, expected.cycles)) return "cycle membership differs";
  const blocked = new Set(actual.blockedCellIds());
  if (!equal(cells.map((cell) => cell.id).filter((id) => blocked.has(id)), expected.blocked)) return "blocking closure differs";
  const order = actual.state.topologicalOrder;
  if (order === null || !equal([...order].sort(), [...expected.runnable].sort())) return "runnable topological membership differs";
  const position = new Map(order.map((id, index) => [id, index]));
  for (const dependent of expected.runnable) for (const dependency of expected.edges[dependent] ?? []) {
    if (expected.blocked.includes(dependency)) continue;
    if ((position.get(dependency) ?? Infinity) >= (position.get(dependent) ?? -1)) return "topological dependency order is invalid";
  }
  return null;
}

function oracle(cells: readonly GraphCellInput[]): Oracle {
  const nodes = cells.map((cell) => cell.id);
  const owners = new Map<string, string[]>();
  for (const cell of cells) for (const symbol of new Set(cell.defs)) {
    const ids = owners.get(symbol) ?? [];
    ids.push(cell.id);
    owners.set(symbol, ids);
  }
  const edges = Object.fromEntries(nodes.map((id) => [id, [] as string[]]));
  for (const cell of cells) {
    const dependencies = new Set<string>();
    for (const reference of new Set(cell.refs)) for (const owner of owners.get(reference) ?? []) if (owner !== cell.id) dependencies.add(owner);
    if (new Set(cell.selfRefs).size > 0) dependencies.add(cell.id);
    edges[cell.id] = nodes.filter((id) => dependencies.has(id));
  }
  const reverseEdges = Object.fromEntries(nodes.map((id) => [id, [] as string[]]));
  for (const dependent of nodes) for (const dependency of edges[dependent]!) reverseEdges[dependency]!.push(dependent);
  const duplicates = Object.fromEntries([...owners.entries()].filter(([, ids]) => ids.length > 1).sort(([left], [right]) => left.localeCompare(right)));
  const cycles = nodes.filter((node) => canReturnTo(node, edges));
  const blockedSet = new Set<string>([...cycles, ...Object.values(duplicates).flat()]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (blockedSet.has(node) || !(edges[node] ?? []).some((dependency) => blockedSet.has(dependency))) continue;
      blockedSet.add(node);
      changed = true;
    }
  }
  const blocked = nodes.filter((node) => blockedSet.has(node));
  return {
    owners: Object.fromEntries([...owners.entries()]), edges, reverseEdges, duplicates, cycles, blocked,
    runnable: nodes.filter((node) => !blockedSet.has(node)),
  };
}

function canReturnTo(start: string, edges: Readonly<Record<string, readonly string[]>>): boolean {
  const pending = [...(edges[start] ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current === start) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(edges[current] ?? []));
  }
  return false;
}

function minimize(cells: readonly GraphCellInput[]): GraphCellInput[] {
  let current = cells.map((cell) => structuredClone(cell));
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current.length === 1) break;
    const candidate = current.filter((_, candidateIndex) => candidateIndex !== index);
    if (graphMismatch(candidate) !== null) current = candidate;
  }
  return current;
}

function equal(left: readonly unknown[], right: readonly unknown[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function equalRecord(left: Readonly<Record<string, readonly string[]>>, right: Readonly<Record<string, readonly string[]>>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
