import {
  MAX_DEPENDENCY_EDGES,
  type AnalysisCellResult,
  type CellStatus,
  type CellType,
  type DependencyGraphState,
} from "./protocol.js";

export interface GraphCellInput extends AnalysisCellResult { type: CellType; disabled?: boolean; }
export interface GraphValidationIssue {
  code: "dependency-cycle" | "duplicate-definition" | "graph_blocked";
  message: string;
  cellId?: string;
  symbol?: string;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function nullRecord(nodes: readonly string[]): Record<string, string[]> { return Object.fromEntries(nodes.map(node => [node, []])); }

export function buildDependencyGraph(cells: readonly GraphCellInput[]): DependencyGraphState {
  const graph = new ReactiveGraph(cells);
  if (graph.resourceLimited) throw new Error(`dependency graph exceeds ${MAX_DEPENDENCY_EDGES} edge limit`);
  return graph.state;
}

/** Iterative Tarjan traversal with cycle members returned in notebook order. */
export function detectCycleNodes(edges: Readonly<Record<string, readonly string[]>>, nodes: readonly string[]): string[] {
  interface Frame { node: string; parent: string | null; dependencies: readonly string[]; next: number; }
  const known = new Set(nodes), indexes = new Map<string, number>(), lowlinks = new Map<string, number>(), onStack = new Set<string>(), members = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;
  const visit = (node: string, parent: string | null, frames: Frame[]): void => {
    nextIndex += 1; indexes.set(node, nextIndex); lowlinks.set(node, nextIndex); stack.push(node); onStack.add(node);
    frames.push({ node, parent, dependencies: (edges[node] ?? []).filter(value => known.has(value)), next: 0 });
  };
  for (const root of nodes) {
    if (indexes.has(root)) continue;
    const frames: Frame[] = []; visit(root, null, frames);
    while (frames.length > 0) {
      const frame = frames.at(-1)!; const dependency = frame.dependencies[frame.next];
      if (dependency !== undefined) {
        frame.next += 1;
        if (!indexes.has(dependency)) visit(dependency, frame.node, frames);
        else if (onStack.has(dependency)) lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node)!, indexes.get(dependency)!));
        continue;
      }
      frames.pop();
      if (frame.parent !== null) lowlinks.set(frame.parent, Math.min(lowlinks.get(frame.parent)!, lowlinks.get(frame.node)!));
      if (lowlinks.get(frame.node) !== indexes.get(frame.node)) continue;
      const component: string[] = [];
      for (;;) { const member = stack.pop(); if (member === undefined) break; onStack.delete(member); component.push(member); if (member === frame.node) break; }
      if (component.length > 1 || (edges[frame.node] ?? []).includes(frame.node)) for (const member of component) members.add(member);
    }
  }
  return nodes.filter(node => members.has(node));
}

export function dependencyLevels(edges: Readonly<Record<string, readonly string[]>>, nodes: readonly string[]): Map<string, number> | null {
  const known = new Set(nodes), counts = new Map<string, number>(), dependents = new Map(nodes.map(node => [node, [] as string[]])), levels = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    const dependencies = new Set((edges[node] ?? []).filter(value => known.has(value)));
    counts.set(node, dependencies.size); levels.set(node, 0); if (dependencies.size === 0) queue.push(node);
    for (const dependency of dependencies) dependents.get(dependency)?.push(node);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const dependency = queue[head]!; const nextLevel = (levels.get(dependency) ?? 0) + 1;
    for (const dependent of dependents.get(dependency) ?? []) {
      levels.set(dependent, Math.max(levels.get(dependent) ?? 0, nextLevel));
      const remaining = (counts.get(dependent) ?? 0) - 1; counts.set(dependent, remaining); if (remaining === 0) queue.push(dependent);
    }
  }
  return queue.length === nodes.length ? levels : null;
}

export function topologicalOrder(edges: Readonly<Record<string, readonly string[]>>, nodes: readonly string[]): string[] | null {
  const levels = dependencyLevels(edges, nodes); if (levels === null) return null;
  const layers: string[][] = []; for (const node of nodes) (layers[levels.get(node) ?? 0] ??= []).push(node); return layers.flat();
}

export function reachableNodes(adjacency: Readonly<Record<string, readonly string[]>>, start: string): string[] {
  const seen = new Set<string>(), queue = [...(adjacency[start] ?? [])];
  for (let head = 0; head < queue.length; head += 1) { const current = queue[head]; if (current === undefined || seen.has(current)) continue; seen.add(current); queue.push(...(adjacency[current] ?? [])); }
  return [...seen];
}

/** A small, fully rebuilt projection of the analyzer's current static facts. */
export class ReactiveGraph {
  private cellsValue: GraphCellInput[] = [];
  private stateValue: DependencyGraphState = { nodes: [], edges: {}, reverseEdges: {}, duplicates: {}, cycles: [], topologicalOrder: [] };
  private cellById = new Map<string, GraphCellInput>();
  private position = new Map<string, number>();
  private owners = new Map<string, Set<string>>();
  private complexityExceeded = false;

  constructor(cells: readonly GraphCellInput[]) { this.replace(cells); }
  get cells(): readonly GraphCellInput[] { return this.cellsValue; }
  get state(): DependencyGraphState { return this.stateValue; }
  get resourceLimited(): boolean { return this.complexityExceeded; }
  update(cells: readonly GraphCellInput[]): this { this.replace(cells); return this; }

  private replace(cells: readonly GraphCellInput[]): void {
    const normalized = cells.map(normalizeCell);
    if (new Set(normalized.map(cell => cell.id)).size !== normalized.length) throw new Error("dependency graph contains duplicate cell ids");
    const position = new Map(normalized.map((cell, index) => [cell.id, index])), owners = new Map<string, Set<string>>();
    for (const cell of normalized) for (const symbol of cell.defs) { const values = owners.get(symbol) ?? new Set<string>(); values.add(cell.id); owners.set(symbol, values); }
    const nodes = normalized.map(cell => cell.id), edges = nullRecord(nodes);
    let count = 0, limited = false;
    for (const cell of normalized) {
      const dependencies = new Set<string>();
      for (const reference of cell.refs) for (const owner of owners.get(reference) ?? []) if (owner !== cell.id) dependencies.add(owner);
      if (cell.selfRefs.length > 0) dependencies.add(cell.id);
      count += dependencies.size; if (count > MAX_DEPENDENCY_EDGES) { limited = true; break; }
      edges[cell.id] = [...dependencies].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    }
    if (limited) for (const node of nodes) edges[node] = [];
    const reverseEdges = nullRecord(nodes);
    if (!limited) for (const dependent of nodes) for (const dependency of edges[dependent] ?? []) reverseEdges[dependency]?.push(dependent);
    const duplicates = Object.fromEntries([...owners.entries()].filter(([, ids]) => ids.size > 1).sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, ids]) => [symbol, [...ids].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))]));
    const cycles = limited ? [] : detectCycleNodes(edges, nodes), blocked = new Set<string>([...cycles, ...Object.values(duplicates).flat()]);
    const runnable = nodes.filter(node => !blocked.has(node));
    const runnableEdges = Object.fromEntries(runnable.map(node => [node, (edges[node] ?? []).filter(dependency => !blocked.has(dependency))]));
    this.cellsValue = normalized; this.cellById = new Map(normalized.map(cell => [cell.id, cell])); this.position = position; this.owners = owners; this.complexityExceeded = limited;
    this.stateValue = { nodes, edges, reverseEdges, duplicates, cycles, topologicalOrder: limited ? null : topologicalOrder(runnableEdges, runnable) };
  }

  has(id: string): boolean { return this.cellById.has(id); }
  cell(id: string): GraphCellInput | undefined { return this.cellById.get(id); }
  ancestors(id: string): string[] { return this.closure(this.state.edges, id); }
  descendants(id: string): string[] { return this.closure(this.state.reverseEdges, id); }
  definitionOwners(symbol: string): string[] { return [...(this.owners.get(symbol) ?? [])].sort((a, b) => (this.position.get(a) ?? 0) - (this.position.get(b) ?? 0)); }
  definitionOwner(symbol: string): string | undefined { const owners = this.definitionOwners(symbol); return owners.length === 1 ? owners[0] : undefined; }
  blockedCellIds(): Set<string> { return new Set([...this.state.cycles, ...Object.values(this.state.duplicates).flat()]); }
  issuesForCell(id: string): GraphValidationIssue[] { return this.validate().filter(issue => issue.cellId === id || issue.cellId === undefined); }

  blockedByDisabled(disabled?: ReadonlySet<string>): Set<string> {
    const roots = disabled ?? new Set(this.cells.filter(cell => cell.disabled).map(cell => cell.id)); const blocked = new Set<string>(), queue = [...roots].filter(id => this.has(id));
    for (const id of queue) blocked.add(id);
    for (let head = 0; head < queue.length; head += 1) for (const descendant of this.state.reverseEdges[queue[head]!] ?? []) if (!blocked.has(descendant)) { blocked.add(descendant); queue.push(descendant); }
    return blocked;
  }
  orderOf(ids: Iterable<string>): string[] { const selected = new Set(ids); return (this.state.topologicalOrder ?? []).filter(id => selected.has(id)); }

  validate(): GraphValidationIssue[] {
    if (this.complexityExceeded) return [{ code: "graph_blocked", message: `cannot run: dependency graph exceeds ${MAX_DEPENDENCY_EDGES} edge limit` }];
    const issues: GraphValidationIssue[] = [];
    for (const [symbol, ids] of Object.entries(this.state.duplicates)) for (const cellId of ids) issues.push({ code: "duplicate-definition", cellId, symbol, message: `global ${symbol} is defined by multiple cells: ${ids.join(", ")}` });
    if (this.state.cycles.length > 0) { const message = `dependency cycle involves cells: ${this.state.cycles.join(", ")}`; for (const cellId of this.state.cycles) issues.push({ code: "dependency-cycle", cellId, message }); }
    return issues;
  }

  planCell(id: string, status: (id: string) => CellStatus, mode: "automatic" | "lazy", source: "editor" | "app" | "mcp" | "cli" = "editor"): string[] {
    const cell = this.cellById.get(id); if (cell === undefined) throw new Error(`no such cell: ${id}`);
    const graphBlocked = this.blockedCellIds(); if (cell.type === "markdown" || graphBlocked.has(id)) return [];
    const required = (candidate: string): boolean => ["idle", "stale", "error", "stopped"].includes(status(candidate));
    const plan = new Set(this.ancestors(id).filter(candidate => !graphBlocked.has(candidate) && required(candidate))); plan.add(id);
    if (mode === "automatic" || source === "app") this.expandClosure(plan, required, true); return this.orderOf(plan);
  }
  planStale(status: (id: string) => CellStatus): string[] {
    const blocked = this.blockedCellIds(), required = (id: string): boolean => ["idle", "stale", "error", "stopped"].includes(status(id));
    const plan = new Set(this.cells.filter(cell => cell.type === "code" && !blocked.has(cell.id) && required(cell.id)).map(cell => cell.id)); this.expandClosure(plan, required, false); return this.orderOf(plan);
  }
  private closure(adjacency: Readonly<Record<string, readonly string[]>>, id: string): string[] { return reachableNodes(adjacency, id).sort((a, b) => (this.position.get(a) ?? 0) - (this.position.get(b) ?? 0)); }
  private expandClosure(plan: Set<string>, required: (id: string) => boolean, includeDescendants: boolean): void {
    const blocked = this.blockedCellIds(), queue = [...plan];
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head]!;
      for (const candidate of includeDescendants ? this.state.reverseEdges[id] ?? [] : []) if (!blocked.has(candidate) && !plan.has(candidate)) { plan.add(candidate); queue.push(candidate); }
      for (const ancestor of this.ancestors(id)) if (!blocked.has(ancestor) && required(ancestor) && !plan.has(ancestor)) { plan.add(ancestor); queue.push(ancestor); }
    }
  }
}

function normalizeCell(cell: GraphCellInput): GraphCellInput {
  return { ...cell, defs: unique(cell.defs), refs: unique(cell.refs), selfRefs: unique(cell.selfRefs), locals: unique(cell.locals), diagnostics: [...cell.diagnostics] };
}
