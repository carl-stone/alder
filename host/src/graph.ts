import {
  MAX_DEPENDENCY_EDGES,
  type AnalysisCellResult,
  type CellStatus,
  type CellType,
  type DependencyGraphState,
} from "./protocol.js";

export interface GraphCellInput extends AnalysisCellResult {
  type: CellType;
  disabled?: boolean;
}

export interface GraphValidationIssue {
  code: "dependency-cycle" | "duplicate-definition" | "syntax-error" | "analysis-error" | "graph_blocked";
  message: string;
  cellId?: string;
  symbol?: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nullRecord(nodes: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(nodes.map((node) => [node, []]));
}

/**
 * Build the same dependency relation as R/analysis.R: every edge is stored on
 * the dependent and points to its dependencies. Arrays retain notebook order.
 */
export function buildDependencyGraph(
  cells: readonly GraphCellInput[],
): DependencyGraphState {
  const graph = new ReactiveGraph(cells);
  if (graph.resourceLimited) {
    throw new Error(`dependency graph exceeds ${MAX_DEPENDENCY_EDGES} edge limit`);
  }
  return graph.state;
}

/** Iterative Tarjan SCC traversal with cycle members returned in input order. */
export function detectCycleNodes(
  edges: Readonly<Record<string, readonly string[]>>,
  nodes: readonly string[],
): string[] {
  interface Frame {
    node: string;
    parent: string | null;
    dependencies: readonly string[];
    next: number;
  }

  const known = new Set(nodes);
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const members = new Set<string>();
  let nextIndex = 0;

  const visit = (node: string, parent: string | null, frames: Frame[]): void => {
    nextIndex += 1;
    indexes.set(node, nextIndex);
    lowlinks.set(node, nextIndex);
    stack.push(node);
    onStack.add(node);
    frames.push({
      node,
      parent,
      dependencies: (edges[node] ?? []).filter((dependency) => known.has(dependency)),
      next: 0,
    });
  };

  for (const root of nodes) {
    if (indexes.has(root)) continue;
    const frames: Frame[] = [];
    visit(root, null, frames);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const dependency = frame.dependencies[frame.next];
      if (dependency !== undefined) {
        frame.next += 1;
        if (!indexes.has(dependency)) {
          visit(dependency, frame.node, frames);
        } else if (onStack.has(dependency)) {
          lowlinks.set(
            frame.node,
            Math.min(lowlinks.get(frame.node)!, indexes.get(dependency)!),
          );
        }
        continue;
      }

      frames.pop();
      if (frame.parent !== null) {
        lowlinks.set(
          frame.parent,
          Math.min(lowlinks.get(frame.parent)!, lowlinks.get(frame.node)!),
        );
      }
      if (lowlinks.get(frame.node) !== indexes.get(frame.node)) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      const selfLoop = component.length === 1
        && (edges[frame.node] ?? []).includes(frame.node);
      if (component.length > 1 || selfLoop) {
        for (const member of component) members.add(member);
      }
    }
  }
  return nodes.filter((node) => members.has(node));
}

/** Kahn ordering matching the R implementation, including its input-order tie break. */
export function dependencyLevels(
  edges: Readonly<Record<string, readonly string[]>>,
  nodes: readonly string[],
): Map<string, number> | null {
  const known = new Set(nodes);
  const dependencyCounts = new Map<string, number>();
  const dependents = new Map(nodes.map((node) => [node, [] as string[]]));
  const levels = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    const dependencies = new Set(
      (edges[node] ?? []).filter((dependency) => known.has(dependency)),
    );
    dependencyCounts.set(node, dependencies.size);
    levels.set(node, 0);
    if (dependencies.size === 0) queue.push(node);
    for (const dependency of dependencies) dependents.get(dependency)?.push(node);
  }

  let head = 0;
  while (head < queue.length) {
    const dependency = queue[head++]!;
    const nextLevel = (levels.get(dependency) ?? 0) + 1;
    for (const dependent of dependents.get(dependency) ?? []) {
      levels.set(dependent, Math.max(levels.get(dependent) ?? 0, nextLevel));
      const remaining = (dependencyCounts.get(dependent) ?? 0) - 1;
      dependencyCounts.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  return queue.length === nodes.length ? levels : null;
}

/** Kahn ordering matching the R implementation, including its input-order tie break. */
export function topologicalOrder(
  edges: Readonly<Record<string, readonly string[]>>,
  nodes: readonly string[],
): string[] | null {
  const levels = dependencyLevels(edges, nodes);
  if (levels === null) return null;

  const layers: string[][] = [];
  for (const node of nodes) {
    const level = levels.get(node) ?? 0;
    (layers[level] ??= []).push(node);
  }
  return layers.flat();
}

export function reachableNodes(
  adjacency: Readonly<Record<string, readonly string[]>>,
  start: string,
): string[] {
  const seen = new Set<string>();
  const queue = [...(adjacency[start] ?? [])];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(adjacency[current] ?? []));
  }
  return [...seen];
}

export class ReactiveGraph {
  private cellsValue: GraphCellInput[];
  private stateValue: DependencyGraphState;
  private cellById: Map<string, GraphCellInput>;
  private position: Map<string, number>;
  private owners = new Map<string, Set<string>>();
  private referrers = new Map<string, Set<string>>();
  private edgeIndex = new Map<string, string[]>();
  private barrierPositions: number[] = [];
  private opaquePositions: number[] = [];
  private codePositions: number[] = [];
  private complexityExceeded = false;

  constructor(cells: readonly GraphCellInput[]) {
    this.cellsValue = cells.map(normalizeCell);
    assertUniqueCellIds(this.cellsValue);
    this.cellById = new Map(this.cellsValue.map((cell) => [cell.id, cell]));
    this.position = new Map(this.cellsValue.map((cell, index) => [cell.id, index]));
    ({
      barrier: this.barrierPositions,
      opaque: this.opaquePositions,
      code: this.codePositions,
    } = orderingPositions(this.cellsValue));
    for (const cell of this.cellsValue) this.addToIndexes(cell);
    let dependencies = 0;
    for (const cell of this.cellsValue) {
      const cellDependencies = this.dependenciesOf(cell);
      dependencies += cellDependencies.length;
      if (dependencies > MAX_DEPENDENCY_EDGES) {
        this.edgeIndex.clear();
        this.complexityExceeded = true;
        break;
      }
      this.edgeIndex.set(cell.id, cellDependencies);
    }
    this.stateValue = this.deriveState();
  }

  get cells(): readonly GraphCellInput[] {
    return this.cellsValue;
  }

  get state(): DependencyGraphState {
    return this.stateValue;
  }

  get resourceLimited(): boolean {
    return this.complexityExceeded;
  }
  refreshCellsIfTopologyUnchanged(cells: readonly GraphCellInput[]): boolean {
    const normalized = cells.map(normalizeCell);
    if (normalized.some((cell) => !sameGraphCell(this.cellById.get(cell.id), cell))) return false;
    this.cellsValue = [...this.cellsValue];
    for (const cell of normalized) {
      const index = this.position.get(cell.id);
      if (index === undefined) return false;
      this.cellsValue[index] = cell;
      this.cellById.set(cell.id, cell);
    }
    return true;
  }


  update(cells: readonly GraphCellInput[]): this {
    const nextCells = cells.map(normalizeCell);
    assertUniqueCellIds(nextCells);
    const nextById = new Map(nextCells.map((cell) => [cell.id, cell]));
    const priorNodes = this.cellsValue.map((cell) => cell.id);
    const nextNodes = nextCells.map((cell) => cell.id);
    const priorSet = new Set(priorNodes);
    const nextSet = new Set(nextNodes);
    const added = new Set(nextNodes.filter((id) => !priorSet.has(id)));
    const removed = new Set(priorNodes.filter((id) => !nextSet.has(id)));
    const priorCommon = priorNodes.filter((id) => nextSet.has(id));
    const nextCommon = nextNodes.filter((id) => priorSet.has(id));
    const reordered = new Set<string>();
    if (!sameArray(priorCommon, nextCommon)) {
      const priorCommonPosition = new Map(priorCommon.map((id, index) => [id, index]));
      for (let index = 0; index < nextCommon.length; index += 1) {
        const id = nextCommon[index];
        if (id !== undefined && priorCommonPosition.get(id) !== index) reordered.add(id);
      }
    }
    const changed = new Set<string>();
    for (const id of new Set([...priorNodes, ...nextNodes])) {
      if (!sameGraphCell(this.cellById.get(id), nextById.get(id))) changed.add(id);
    }
    if (changed.size === 0 && reordered.size === 0) {
      // Validation still needs the latest revisions and diagnostics even when
      // the dependency relation itself is unchanged.
      this.cellsValue = nextCells;
      this.cellById = nextById;
      return this;
    }

    const priorCells = this.cellsValue;
    const priorPosition = this.position;
    const nextPosition = new Map(nextCells.map((cell, index) => [cell.id, index]));
    const nextOwners = cloneIndex(this.owners);
    const nextReferrers = cloneIndex(this.referrers);
    const changedDefinitions = new Set<string>();
    const affected = this.complexityExceeded
      ? new Set(nextNodes)
      : new Set<string>([...changed, ...reordered]);
    for (const id of changed) {
      const prior = this.cellById.get(id);
      const next = nextById.get(id);
      for (const symbol of prior?.defs ?? []) changedDefinitions.add(symbol);
      for (const symbol of next?.defs ?? []) changedDefinitions.add(symbol);
      if (prior !== undefined) removeCellFromIndexes(nextOwners, nextReferrers, prior);
      if (next !== undefined) addCellToIndexes(nextOwners, nextReferrers, next);
    }
    for (const id of reordered) {
      for (const symbol of this.cellById.get(id)?.defs ?? []) changedDefinitions.add(symbol);
    }
    for (const symbol of changedDefinitions) {
      for (const id of this.referrers.get(symbol) ?? []) affected.add(id);
      for (const id of nextReferrers.get(symbol) ?? []) affected.add(id);
    }

    const structuralSources = new Set([...added, ...removed, ...reordered]);
    for (const id of changed) {
      const prior = this.cellById.get(id);
      const next = nextById.get(id);
      if (prior?.type !== next?.type
        || prior?.barrier !== next?.barrier
        || prior?.opaque !== next?.opaque) structuralSources.add(id);
    }
    for (const id of structuralSources) {
      const prior = this.cellById.get(id);
      if (prior !== undefined) {
        addOrderingDependents(prior, priorPosition.get(id), priorCells, affected);
      }
    }

    for (const id of structuralSources) {
      const next = nextById.get(id);
      if (next !== undefined) {
        addOrderingDependents(next, nextPosition.get(id), nextCells, affected);
      }
    }
    const ordering = orderingPositions(nextCells);
    const nextEdgeIndex = this.complexityExceeded
      ? new Map<string, string[]>()
      : new Map(this.edgeIndex);
    let dependencyCount = edgeCount(nextEdgeIndex);
    // Remove every affected edge set before adding replacements. This keeps
    // the count equal to retained, unaffected edges throughout the update and
    // avoids both a false limit breach and building a second large graph.
    for (const id of affected) {
      dependencyCount -= nextEdgeIndex.get(id)?.length ?? 0;
      nextEdgeIndex.delete(id);
    }
    let complexityExceeded = false;
    for (const id of affected) {
      const cell = nextById.get(id);
      if (cell === undefined) continue;
      const dependencies = dependenciesFor(cell, {
        cells: nextCells,
        position: nextPosition,
        owners: nextOwners,
        barrierPositions: ordering.barrier,
        opaquePositions: ordering.opaque,
        codePositions: ordering.code,
      });
      dependencyCount += dependencies.length;
      if (dependencyCount > MAX_DEPENDENCY_EDGES) {
        complexityExceeded = true;
        break;
      }
      nextEdgeIndex.set(id, dependencies);
    }
    if (complexityExceeded) nextEdgeIndex.clear();
    const nextState = deriveGraphState(
      nextCells,
      nextEdgeIndex,
      nextOwners,
      nextPosition,
      complexityExceeded,
    );

    this.cellsValue = nextCells;
    this.cellById = nextById;
    this.position = nextPosition;
    this.owners = nextOwners;
    this.referrers = nextReferrers;
    this.edgeIndex = nextEdgeIndex;
    this.barrierPositions = ordering.barrier;
    this.opaquePositions = ordering.opaque;
    this.codePositions = ordering.code;
    this.complexityExceeded = complexityExceeded;
    this.stateValue = nextState;
    return this;
  }

  has(id: string): boolean {
    return this.cellById.has(id);
  }

  cell(id: string): GraphCellInput | undefined {
    return this.cellById.get(id);
  }

  ancestors(id: string): string[] {
    return this.closure(this.state.edges, id);
  }

  descendants(id: string): string[] {
    return this.closure(this.state.reverseEdges, id);
  }

  definitionOwners(symbol: string): string[] {
    return [...(this.owners.get(symbol) ?? [])].sort(
      (left, right) => (this.position.get(left) ?? 0) - (this.position.get(right) ?? 0),
    );
  }

  definitionOwner(symbol: string): string | undefined {
    const owners = this.definitionOwners(symbol);
    return owners.length === 1 ? owners[0] : undefined;
  }

  blockedByDisabled(disabled?: ReadonlySet<string>): Set<string> {
    const roots = disabled ?? new Set(
      this.cells.filter((cell) => cell.disabled).map((cell) => cell.id),
    );
    const blocked = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) {
      if (!this.has(root)) continue;
      blocked.add(root);
      queue.push(root);
    }
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (current === undefined) continue;
      for (const descendant of this.state.reverseEdges[current] ?? []) {
        if (blocked.has(descendant)) continue;
        blocked.add(descendant);
        queue.push(descendant);
      }
    }
    return blocked;
  }

  orderOf(ids: Iterable<string>): string[] {
    const selected = new Set(ids);
    return (this.state.topologicalOrder ?? []).filter((id) => selected.has(id));
  }

  validate(): GraphValidationIssue[] {
    const issues: GraphValidationIssue[] = [];
    if (this.complexityExceeded) {
      issues.push({
        code: "graph_blocked",
        message: `cannot run: dependency graph exceeds ${MAX_DEPENDENCY_EDGES} edge limit`,
      });
    }
    if (this.state.cycles.length > 0) {
      issues.push({
        code: "dependency-cycle",
        message: `cannot run: dependency cycle: ${this.state.cycles.join(", ")}`,
      });
    }
    const duplicateSymbols = Object.keys(this.state.duplicates).sort();
    if (duplicateSymbols.length > 0) {
      issues.push({
        code: "duplicate-definition",
        message: `cannot run: duplicate definitions: ${duplicateSymbols.join(", ")}`,
      });
    }
    for (const cell of this.cells) {
      if (cell.error !== null) {
        issues.push({
          code: "syntax-error",
          cellId: cell.id,
          message: `cannot run: ${cell.id} has a syntax error: ${cell.error}`,
        });
      }
      for (const raw of cell.diagnostics) {
        if (!isErrorDiagnostic(raw)) continue;
        issues.push({
          code: "analysis-error",
          cellId: cell.id,
          message: `cannot run: ${cell.id} cannot be analyzed safely: ${raw.message}`,
        });
      }
    }
    const seen = new Set<string>();
    return issues
      .sort((left, right) => left.message.localeCompare(right.message))
      .filter((issue) => {
        if (seen.has(issue.message)) return false;
        seen.add(issue.message);
        return true;
      });
  }

  private addToIndexes(cell: GraphCellInput): void {
    for (const symbol of cell.defs) addIndexValue(this.owners, symbol, cell.id);
    for (const symbol of cell.refs) addIndexValue(this.referrers, symbol, cell.id);
  }

  private removeFromIndexes(cell: GraphCellInput): void {
    for (const symbol of cell.defs) removeIndexValue(this.owners, symbol, cell.id);
    for (const symbol of cell.refs) removeIndexValue(this.referrers, symbol, cell.id);
  }

  private dependenciesOf(cell: GraphCellInput): string[] {
    return dependenciesFor(cell, {
      cells: this.cellsValue,
      position: this.position,
      owners: this.owners,
      barrierPositions: this.barrierPositions,
      opaquePositions: this.opaquePositions,
      codePositions: this.codePositions,
    });
  }

  private deriveState(): DependencyGraphState {
    return deriveGraphState(
      this.cellsValue,
      this.edgeIndex,
      this.owners,
      this.position,
      this.complexityExceeded,
    );
  }

  planCell(
    id: string,
    status: (id: string) => CellStatus,
    mode: "automatic" | "lazy",
    source: "editor" | "app" | "mcp" | "cli" = "editor",
  ): string[] {
    const cell = this.cellById.get(id);
    if (cell === undefined) throw new Error(`no such cell: ${id}`);
    if (cell.type === "markdown") return [];
    const required = (candidate: string): boolean =>
      ["idle", "stale", "error", "stopped"].includes(status(candidate));
    const plan = new Set(this.ancestors(id).filter(required));
    plan.add(id);
    if (mode === "automatic" || source === "app") {
      this.expandClosure(plan, required, true);
    }
    return this.orderOf(plan);
  }

  planStale(status: (id: string) => CellStatus): string[] {
    const required = (id: string): boolean =>
      ["idle", "stale", "error", "stopped"].includes(status(id));
    const plan = new Set(
      this.cells
        .filter((cell) => cell.type === "code" && required(cell.id))
        .map((cell) => cell.id),
    );
    this.expandClosure(plan, required, false);
    return this.orderOf(plan);
  }

  private closure(
    adjacency: Readonly<Record<string, readonly string[]>>,
    id: string,
  ): string[] {
    return reachableNodes(adjacency, id).sort(
      (left, right) => (this.position.get(left) ?? 0) - (this.position.get(right) ?? 0),
    );
  }

  private expandClosure(
    plan: Set<string>,
    required: (id: string) => boolean,
    includeDescendants: boolean,
  ): void {
    const queue = [...plan];
    const expanded = new Set<string>();
    const ancestorQueue: string[] = [];
    const ancestorsScanned = new Set<string>();
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      if (id === undefined || expanded.has(id)) continue;
      expanded.add(id);
      if (includeDescendants) {
        for (const descendant of this.state.reverseEdges[id] ?? []) {
          if (plan.has(descendant)) continue;
          plan.add(descendant);
          queue.push(descendant);
        }
      }
      ancestorQueue.push(id);
      let ancestorHead = 0;
      while (ancestorHead < ancestorQueue.length) {
        const current = ancestorQueue[ancestorHead++];
        if (current === undefined || ancestorsScanned.has(current)) continue;
        ancestorsScanned.add(current);
        for (const ancestor of this.state.edges[current] ?? []) {
          ancestorQueue.push(ancestor);
          if (!required(ancestor) || plan.has(ancestor)) continue;
          plan.add(ancestor);
          queue.push(ancestor);
        }
      }
      ancestorQueue.length = 0;
    }
  }
}

interface DependencyContext {
  cells: readonly GraphCellInput[];
  position: ReadonlyMap<string, number>;
  owners: ReadonlyMap<string, ReadonlySet<string>>;
  barrierPositions: readonly number[];
  opaquePositions: readonly number[];
  codePositions: readonly number[];
}

function dependenciesFor(cell: GraphCellInput, context: DependencyContext): string[] {
  const dependencies = new Set<string>();
  for (const reference of cell.refs) {
    const owners = [...(context.owners.get(reference) ?? [])].sort(
      (left, right) => (context.position.get(left) ?? 0) - (context.position.get(right) ?? 0),
    );
    for (const owner of owners) {
      if (owner !== cell.id) dependencies.add(owner);
    }
  }
  if (cell.selfRefs.length > 0) dependencies.add(cell.id);

  const index = context.position.get(cell.id);
  if (index === undefined) return [...dependencies];
  if (cell.type === "code") {
    addPriorCells(dependencies, context.cells, context.barrierPositions, index);
    addPriorCells(dependencies, context.cells, context.opaquePositions, index);
  }
  if (cell.opaque) {
    addPriorCells(dependencies, context.cells, context.codePositions, index);
  }
  return [...dependencies];
}

function addPriorCells(
  target: Set<string>,
  cells: readonly GraphCellInput[],
  positions: readonly number[],
  before: number,
): void {
  for (const position of positions) {
    if (position >= before) break;
    const cell = cells[position];
    if (cell !== undefined) target.add(cell.id);
  }
}

function orderingPositions(cells: readonly GraphCellInput[]): {
  barrier: number[];
  opaque: number[];
  code: number[];
} {
  const barrier: number[] = [];
  const opaque: number[] = [];
  const code: number[] = [];
  for (const [index, cell] of cells.entries()) {
    if (cell.barrier) barrier.push(index);
    if (cell.opaque) opaque.push(index);
    if (cell.type === "code") code.push(index);
  }
  return { barrier, opaque, code };
}

function deriveGraphState(
  cells: readonly GraphCellInput[],
  edgeIndex: ReadonlyMap<string, readonly string[]>,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
  position: ReadonlyMap<string, number>,
  complexityExceeded: boolean,
): DependencyGraphState {
  const nodes = cells.map((cell) => cell.id);
  const edges = Object.fromEntries(nodes.map((id) => [
    id,
    complexityExceeded ? [] : [...(edgeIndex.get(id) ?? [])],
  ]));
  const reverseEdges = nullRecord(nodes);
  if (!complexityExceeded) {
    for (const dependent of nodes) {
      for (const dependency of edges[dependent] ?? []) reverseEdges[dependency]?.push(dependent);
    }
  }
  const duplicateEntries: Array<[string, string[]]> = [];
  for (const symbol of [...owners.keys()].sort()) {
    const definitions = [...(owners.get(symbol) ?? [])].sort(
      (left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0),
    );
    if (definitions.length > 1) duplicateEntries.push([symbol, definitions]);
  }
  const duplicates = Object.fromEntries(duplicateEntries);
  return {
    nodes,
    edges,
    reverseEdges,
    duplicates,
    cycles: complexityExceeded ? [] : detectCycleNodes(edges, nodes),
    topologicalOrder: complexityExceeded ? null : topologicalOrder(edges, nodes),
  };
}

function edgeCount(index: ReadonlyMap<string, readonly string[]>): number {
  let count = 0;
  for (const edges of index.values()) count += edges.length;
  return count;
}

function cloneIndex(
  index: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  return new Map([...index].map(([key, values]) => [key, new Set(values)]));
}

function addCellToIndexes(
  owners: Map<string, Set<string>>,
  referrers: Map<string, Set<string>>,
  cell: GraphCellInput,
): void {
  for (const symbol of cell.defs) addIndexValue(owners, symbol, cell.id);
  for (const symbol of cell.refs) addIndexValue(referrers, symbol, cell.id);
}

function removeCellFromIndexes(
  owners: Map<string, Set<string>>,
  referrers: Map<string, Set<string>>,
  cell: GraphCellInput,
): void {
  for (const symbol of cell.defs) removeIndexValue(owners, symbol, cell.id);
  for (const symbol of cell.refs) removeIndexValue(referrers, symbol, cell.id);
}

function normalizeCell(cell: GraphCellInput): GraphCellInput {
  return {
    ...cell,
    defs: unique(cell.defs),
    refs: unique(cell.refs),
    selfRefs: unique(cell.selfRefs),
    locals: unique(cell.locals),
    diagnostics: [...cell.diagnostics],
  };
}

function assertUniqueCellIds(cells: readonly GraphCellInput[]): void {
  if (new Set(cells.map((cell) => cell.id)).size !== cells.length) {
    throw new Error("dependency graph contains duplicate cell ids");
  }
}

function sameGraphCell(
  left: GraphCellInput | undefined,
  right: GraphCellInput | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.id === right.id
    && left.type === right.type
    && left.disabled === right.disabled
    && left.barrier === right.barrier
    && left.opaque === right.opaque
    && sameArray(left.defs, right.defs)
    && sameArray(left.refs, right.refs)
    && sameArray(left.selfRefs, right.selfRefs);
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function addIndexValue(index: Map<string, Set<string>>, key: string, id: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(id);
  index.set(key, values);
}

function removeIndexValue(index: Map<string, Set<string>>, key: string, id: string): void {
  const values = index.get(key);
  if (values === undefined) return;
  values.delete(id);
  if (values.size === 0) index.delete(key);
}

function addOrderingDependents(
  source: GraphCellInput,
  sourcePosition: number | undefined,
  cells: readonly GraphCellInput[],
  affected: Set<string>,
): void {
  affected.add(source.id);
  if (sourcePosition === undefined) return;
  if (source.barrier || source.opaque) {
    for (let index = sourcePosition + 1; index < cells.length; index += 1) {
      const target = cells[index];
      if (target?.type === "code") affected.add(target.id);
    }
  }
  if (source.type === "code") {
    for (let index = sourcePosition + 1; index < cells.length; index += 1) {
      const target = cells[index];
      if (target?.opaque) affected.add(target.id);
    }
  }
}

function isErrorDiagnostic(value: unknown): value is { level: "error"; message: string } {
  return typeof value === "object" && value !== null
    && (value as { level?: unknown }).level === "error"
    && typeof (value as { message?: unknown }).message === "string";
}
