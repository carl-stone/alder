import type {
  CellCreation,
  CellEdit,
  CellType,
  CommandResult,
  HostCellState,
  HostCommand,
  HostEvent,
  HostSnapshot,
  OperationRecord,
} from "../protocol.js";
import { tailLog } from "../output-log.js";

const MAX_LOG_BYTES = 65_536;

export interface EditorSelection {
  anchor: number;
  head: number;
  scrollTop?: number;
}

export interface LocalCell {
  /** Stable view identity. It never changes when an optimistic cell is acknowledged. */
  readonly key: string;
  id: string | null;
  clientOperationId: string | null;
  desiredBody: string[];
  desiredType: CellType;
  serverBody: string[];
  serverType: CellType;
  serverRevision: number;
  generation: number;
  acknowledgedGeneration: number;
  conflict: boolean;
  tombstone: boolean;
  restoreAfter: string | null;
  server: HostCellState | null;
  selection: EditorSelection | null;
}

interface SubmittedCell {
  generation: number;
  body: string[];
  type: CellType;
  expectedRevision: number | null;
  changesSource: boolean;
}

interface SubmittedOperation {
  cells: Map<string, SubmittedCell>;
  creations: Map<string, SubmittedCell>;
}

export interface PendingSource {
  edits: CellEdit[];
  creations: CellCreation[];
}

export interface RunCommandOptions {
  operationId: string;
  clientId: string;
  scope: "cell" | "all" | "stale";
  targetKey?: string;
  source?: "editor" | "app" | "mcp" | "cli";
}

export class BrowserDocument {
  private ordered: LocalCell[] = [];
  private byKey = new Map<string, LocalCell>();
  private keyByServerId = new Map<string, string>();
  private keyByCreationId = new Map<string, string>();
  private submitted = new Map<string, SubmittedOperation>();
  private focused: string | null = null;
  private epochValue: string;
  private cursorValue: number;
  private snapshotValue: HostSnapshot;
  private serverOrder: string[];

  constructor(snapshot: HostSnapshot) {
    this.epochValue = snapshot.epoch;
    this.cursorValue = snapshot.cursor;
    this.snapshotValue = snapshot;
    this.serverOrder = snapshot.cells.map((cell) => cell.id);
    this.applySnapshot(snapshot);
  }

  get epoch(): string { return this.epochValue; }
  get cursor(): number { return this.cursorValue; }
  get snapshot(): HostSnapshot { return this.snapshotValue; }
  get cells(): readonly LocalCell[] { return this.ordered; }
  get focusedKey(): string | null { return this.focused; }
  get hasSourceConflicts(): boolean { return this.ordered.some((cell) => cell.conflict || cell.tombstone); }

  cell(keyOrId: string): LocalCell | undefined {
    return this.byKey.get(keyOrId) ?? this.byKey.get(this.keyByServerId.get(keyOrId) ?? "");
  }

  focus(key: string | null, selection?: EditorSelection | null): void {
    if (key !== null && !this.byKey.has(key)) return;
    if (this.focused && selection !== undefined) {
      const old = this.byKey.get(this.focused);
      if (old) old.selection = selection;
    }
    this.focused = key;
  }

  updateSelection(key: string, selection: EditorSelection): void {
    const cell = this.requireCell(key);
    cell.selection = { ...selection };
  }

  create(
    clientOperationId: string,
    afterKey: string | null,
    type: CellType = "code",
    body: readonly string[] = [],
  ): LocalCell {
    if (!clientOperationId || this.keyByCreationId.has(clientOperationId)) {
      throw new Error("clientOperationId must be unique and nonempty");
    }
    const key = `creation:${clientOperationId}`;
    const after = afterKey === null ? this.ordered.length - 1 : this.ordered.findIndex((cell) => cell.key === afterKey);
    if (afterKey !== null && after < 0) throw new Error(`no such predecessor: ${afterKey}`);
    const cell: LocalCell = {
      key,
      id: null,
      clientOperationId,
      desiredBody: [...body],
      desiredType: type,
      serverBody: [],
      serverType: type,
      serverRevision: 0,
      generation: 0,
      acknowledgedGeneration: -1,
      conflict: false,
      tombstone: false,
      restoreAfter: null,
      server: null,
      selection: { anchor: 0, head: 0 },
    };
    this.ordered.splice(after + 1, 0, cell);
    this.byKey.set(key, cell);
    this.keyByCreationId.set(clientOperationId, key);
    this.snapshotValue = { ...this.snapshotValue, changed: true };
    return cell;
  }

  edit(key: string, body: readonly string[], type?: CellType): LocalCell {
    const cell = this.requireCell(key);
    cell.desiredBody = [...body];
    if (type) cell.desiredType = type;
    cell.generation += 1;
    if (!cell.tombstone && cell.desiredType === cell.serverType && sameLines(cell.desiredBody, cell.serverBody)) {
      cell.conflict = false;
      cell.acknowledgedGeneration = cell.generation;
    }
    this.snapshotValue = { ...this.snapshotValue, changed: true };
    return cell;
  }

  useServerVersion(key: string): LocalCell {
    const cell = this.requireCell(key);
    if (!cell.conflict || cell.tombstone || cell.id === null) throw new Error("cell has no resolvable source conflict");
    cell.desiredBody = [...cell.serverBody];
    cell.desiredType = cell.serverType;
    cell.acknowledgedGeneration = cell.generation;
    cell.conflict = false;
    return cell;
  }

  discardLocal(key: string): void {
    const cell = this.requireCell(key);
    if (cell.id !== null && !cell.tombstone) throw new Error("cannot discard an authoritative cell locally");
    this.removeCell(cell);
  }

  restoreDeleted(key: string, clientOperationId: string): LocalCell {
    const cell = this.requireCell(key);
    if (!cell.tombstone || cell.id === null) throw new Error("cell is not a deleted-source conflict");
    if (!clientOperationId || this.keyByCreationId.has(clientOperationId)) {
      throw new Error("clientOperationId must be unique and nonempty");
    }
    this.keyByServerId.delete(cell.id);
    cell.id = null;
    cell.clientOperationId = clientOperationId;
    cell.serverBody = [];
    cell.serverType = cell.desiredType;
    cell.serverRevision = 0;
    cell.acknowledgedGeneration = -1;
    cell.conflict = false;
    cell.tombstone = false;
    cell.server = null;
    this.keyByCreationId.set(clientOperationId, cell.key);
    this.snapshotValue = { ...this.snapshotValue, changed: true };
    return cell;
  }

  pendingSource(): PendingSource {
    const edits: CellEdit[] = [];
    const creations: CellCreation[] = [];
    const creationGroups = new Map<string | null, CellCreation[]>();
    for (const cell of this.ordered) {
      if (cell.tombstone) continue;
      if (cell.id === null) {
        const predecessor = this.predecessorServerId(cell.key);
        const creation: CellCreation = {
          clientOperationId: cell.clientOperationId!,
          after: predecessor,
          body: [...cell.desiredBody],
          cellType: cell.desiredType,
          options: {},
        };
        const group = creationGroups.get(predecessor) ?? [];
        // The controller inserts each item immediately after the same server
        // predecessor, so reverse each contiguous optimistic group on the wire.
        group.unshift(creation);
        creationGroups.set(predecessor, group);
      } else if (
        cell.generation > cell.acknowledgedGeneration ||
        cell.desiredType !== cell.serverType ||
        !sameLines(cell.desiredBody, cell.serverBody)
      ) {
        edits.push({
          cellId: cell.id,
          body: [...cell.desiredBody],
          cellType: cell.desiredType,
          expectedRevision: cell.serverRevision,
        });
      }
    }
    for (const group of creationGroups.values()) creations.push(...group);
    return { edits, creations };
  }

  buildEditCommand(operationId: string, clientId: string): Extract<HostCommand, { type: "edit" }> | Extract<HostCommand, { type: "create" }> | null {
    this.assertNoSourceConflicts();
    const pending = this.pendingSource();
    if (pending.edits.length && pending.creations.length) {
      throw new Error("mixed source changes must be submitted atomically with Run");
    }
    if (pending.edits.length) return {
      type: "edit", operationId, clientId, sessionEpoch: this.epochValue,
      edits: pending.edits,
    };
    if (pending.creations.length) return {
      type: "create", operationId, clientId, sessionEpoch: this.epochValue,
      creations: pending.creations,
    };
    return null;
  }

  buildRunCommand(options: RunCommandOptions): Extract<HostCommand, { type: "run" }> {
    this.assertNoSourceConflicts();
    const pending = this.pendingSource();
    const target = options.targetKey ? this.requireCell(options.targetKey) : null;
    if (options.scope === "cell" && !target) throw new Error("a target cell is required");
    if (options.scope !== "cell" && target) throw new Error("a target cell is valid only for a cell run");
    if (target?.id === null) {
      // Protocol support for targeting a creation in the same transaction is
      // represented by targetCreationId. The controller resolves it only after
      // all edit and creation preconditions have passed.
      return {
        type: "run",
        operationId: options.operationId,
        clientId: options.clientId,
        sessionEpoch: this.epochValue,
        scope: "cell",
        targetCreationId: target.clientOperationId!,
        edits: pending.edits,
        creations: pending.creations,
        source: options.source ?? "editor",
      };
    }
    if (target?.tombstone) throw new Error("deleted cells must be restored or discarded before running");
    return {
      type: "run",
      operationId: options.operationId,
      clientId: options.clientId,
      sessionEpoch: this.epochValue,
      scope: options.scope,
      ...(target?.id ? { cellId: target.id } : {}),
      edits: pending.edits,
      creations: pending.creations,
      source: options.source ?? "editor",
    };
  }

  noteSubmitted(operationId: string, command: HostCommand): void {
    const operation: SubmittedOperation = { cells: new Map(), creations: new Map() };
    const edits = command.type === "run" || command.type === "edit" ? command.edits : [];
    const creations = command.type === "run" || command.type === "create" ? command.creations : [];
    for (const edit of edits) {
      const cell = this.cell(edit.cellId);
      if (cell) operation.cells.set(cell.key, {
        generation: cell.generation,
        body: [...edit.body],
        type: edit.cellType,
        expectedRevision: edit.expectedRevision,
        changesSource: cell.serverType !== edit.cellType || !sameLines(cell.serverBody, edit.body),
      });
    }
    for (const creation of creations) {
      const key = this.keyByCreationId.get(creation.clientOperationId);
      const cell = key ? this.byKey.get(key) : undefined;
      if (cell) operation.creations.set(creation.clientOperationId, {
        generation: cell.generation,
        body: [...creation.body],
        type: creation.cellType,
        expectedRevision: null,
        changesSource: true,
      });
    }
    this.submitted.set(operationId, operation);
  }

  acknowledge(result: CommandResult): void {
    this.cursorValue = Math.max(this.cursorValue, result.cursor);
    this.snapshotValue = {
      ...this.snapshotValue,
      cursor: this.cursorValue,
      version: Math.max(this.snapshotValue.version, result.version),
    };
    const submitted = this.submitted.get(result.operation.id);
    const change = isRecord(result.result) ? result.result : {};
    this.reconcileCreated(change.created);
    this.reconcileEdited(change.edited, submitted);
    if (submitted) {
      for (const [creationId, sent] of submitted.creations) {
        const cell = this.cell(this.keyByCreationId.get(creationId) ?? "");
        const created = Array.isArray(change.created)
          ? change.created.find((item) => isRecord(item)
            && item.clientOperationId === creationId
            && typeof item.revision === "number")
          : undefined;
        if (!cell || cell.id === null || !isRecord(created) || typeof created.revision !== "number"
          || cell.serverRevision > created.revision) continue;
        cell.serverBody = [...sent.body];
        cell.serverType = sent.type;
        cell.acknowledgedGeneration = Math.max(cell.acknowledgedGeneration, sent.generation);
        cell.conflict = false;
      }
    }
    this.submitted.delete(result.operation.id);
  }

  reject(operationId: string, code: string): void {
    const submitted = this.submitted.get(operationId);
    if (submitted && code === "source_conflict") {
      for (const [key, sent] of submitted.cells) {
        const cell = this.byKey.get(key);
        if (cell && (cell.serverType !== sent.type || !sameLines(cell.serverBody, sent.body))) {
          cell.conflict = true;
        }
      }
    }
    this.submitted.delete(operationId);
  }

  applyEvent(event: HostEvent): void {
    if (event.epoch !== this.epochValue || event.cursor <= this.cursorValue) return;
    this.cursorValue = event.cursor;
    if (event.type === "cell" || event.type === "cell-completed" || event.type === "cell-started") {
      if (isRecord(event.payload) && event.payload.deleted === true && event.cellId) {
        this.removeServerCell(event.cellId);
      } else if (isHostCell(event.payload)) {
        const known = this.keyByServerId.has(event.payload.id);
        this.mergeServerCell(event.payload, false, event.operationId);
        if (!known) this.reorderFromServerOrderIfPossible();
      }
    } else if (event.type === "cell-output" && event.cellId && isRecord(event.payload)) {
      this.applyOutput(event.cellId, event.payload);
    } else if (event.type === "diagnostics" && event.cellId && Array.isArray(event.payload)) {
      this.applyDiagnostics(event.cellId, event.payload);
    } else if (event.type === "notebook" && isRecord(event.payload)) {
      this.reconcileCreated(event.payload.created);
      if (typeof event.payload.deleted === "string") this.removeServerCell(event.payload.deleted);
      let orderChanged = false;
      if (Array.isArray(event.payload.order) && event.payload.order.every((id) => typeof id === "string")) {
        const order = event.payload.order as string[];
        orderChanged = !sameLines(this.serverOrder, order);
        if (orderChanged) this.serverOrder = [...order];
      } else if (typeof event.payload.moved === "string") {
        const before = [...this.serverOrder];
        this.moveServerOrder(event.payload.moved, typeof event.payload.after === "string" ? event.payload.after : null);
        orderChanged = !sameLines(before, this.serverOrder);
      }
      if (orderChanged) this.reorderFromServerOrderIfPossible();
    }
    this.snapshotValue = patchSnapshot(this.snapshotValue, event, this.serverOrder);
    if (isRecord(event.payload) && event.type === "notebook" && event.payload.saved === true) {
      const pending = this.pendingSource();
      if (pending.edits.length || pending.creations.length || this.ordered.some((cell) => cell.tombstone)) {
        this.snapshotValue = { ...this.snapshotValue, changed: true };
      }
    }
  }

  applySnapshot(snapshot: HostSnapshot): void {
    const epochChanged = this.epochValue !== snapshot.epoch;
    this.epochValue = snapshot.epoch;
    this.cursorValue = snapshot.cursor;
    this.snapshotValue = snapshot;
    const previousOrder = this.serverOrder;
    this.serverOrder = snapshot.cells.map((cell) => cell.id);
    if (epochChanged) {
      this.submitted.clear();
      for (const cell of this.ordered) {
        if (cell.id !== null && cell.generation > cell.acknowledgedGeneration) cell.conflict = true;
      }
    }
    const seen = new Set<string>();
    for (const serverCell of snapshot.cells) {
      seen.add(serverCell.id);
      this.mergeServerCell(serverCell, epochChanged);
    }
    for (const cell of [...this.ordered]) {
      if (cell.id !== null && !seen.has(cell.id)) {
        if (cell.tombstone || cell.generation > cell.acknowledgedGeneration) {
          cell.conflict = true;
          cell.tombstone = true;
          cell.restoreAfter ??= predecessorInOrder(previousOrder, cell.id, new Set(this.serverOrder));
        } else {
          this.removeCell(cell);
        }
      }
    }
    this.reorderFromServerOrderIfPossible();
    this.reassertLocalDirty();
  }

  private mergeServerCell(
    serverCell: HostCellState,
    forceSource = false,
    operationId?: string,
  ): LocalCell {
    let key = this.keyByServerId.get(serverCell.id);
    let cell = key ? this.byKey.get(key) : undefined;
    if (!cell) {
      key = `cell:${serverCell.id}`;
      cell = {
        key,
        id: serverCell.id,
        clientOperationId: null,
        desiredBody: [...serverCell.body],
        desiredType: serverCell.type,
        serverBody: [...serverCell.body],
        serverType: serverCell.type,
        serverRevision: serverCell.revision,
        generation: 0,
        acknowledgedGeneration: 0,
        conflict: false,
        tombstone: false,
        restoreAfter: null,
        server: serverCell,
        selection: null,
      };
      this.ordered.push(cell);
      this.byKey.set(key, cell);
      this.keyByServerId.set(serverCell.id, key);
      return cell;
    }
    const pending = cell.generation > cell.acknowledgedGeneration;
    const sourceChanged = forceSource
      || cell.serverRevision !== serverCell.revision
      || cell.serverType !== serverCell.type
      || !sameLines(cell.serverBody, serverCell.body);
    if (pending && sourceChanged) {
      const desiredMatches = cell.desiredType === serverCell.type && sameLines(cell.desiredBody, serverCell.body);
      const sent = operationId === undefined
        ? undefined
        : this.matchingSubmittedCell(operationId, cell, serverCell);
      cell.conflict = sent === undefined && !desiredMatches;
      if (sent !== undefined) {
        cell.acknowledgedGeneration = Math.max(cell.acknowledgedGeneration, sent.generation);
      } else if (desiredMatches) {
        cell.acknowledgedGeneration = cell.generation;
      }
    } else if (!pending) {
      if (sourceChanged) {
        cell.desiredBody = [...serverCell.body];
        cell.desiredType = serverCell.type;
      }
      cell.conflict = false;
    }
    cell.id = serverCell.id;
    if (sourceChanged) cell.serverBody = [...serverCell.body];
    cell.serverType = serverCell.type;
    cell.serverRevision = serverCell.revision;
    cell.server = serverCell;
    cell.tombstone = false;
    cell.restoreAfter = null;
    return cell;
  }

  private applyDiagnostics(id: string, value: unknown[]): void {
    const cell = this.cell(id);
    if (!cell?.server) return;
    const server = { ...cell.server, diagnostics: value as HostCellState["diagnostics"] };
    cell.server = server;
    const index = this.snapshotValue.cells.findIndex((candidate) => candidate.id === id);
    if (index >= 0) {
      const cells = [...this.snapshotValue.cells];
      cells[index] = server;
      this.snapshotValue = { ...this.snapshotValue, cells };
    }
  }

  private reconcileCreated(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isRecord(item) || typeof item.clientOperationId !== "string" || typeof item.id !== "string") continue;
      const key = this.keyByCreationId.get(item.clientOperationId);
      const cell = key ? this.byKey.get(key) : undefined;
      if (!cell) continue;
      const existingKey = this.keyByServerId.get(item.id);
      const existing = existingKey === undefined || existingKey === cell.key
        ? undefined
        : this.byKey.get(existingKey);
      if (existing !== undefined) {
        const wasFocused = this.focused === existing.key;
        this.removeCell(existing);
        if (wasFocused) this.focused = cell.key;
        if (existing.server !== null) {
          cell.serverBody = [...existing.serverBody];
          cell.serverType = existing.serverType;
          cell.serverRevision = existing.serverRevision;
          cell.server = existing.server;
          cell.conflict = cell.generation > cell.acknowledgedGeneration
            && (cell.desiredType !== existing.serverType || !sameLines(cell.desiredBody, existing.serverBody));
        }
      }
      cell.id = item.id;
      cell.serverRevision = Math.max(cell.serverRevision, typeof item.revision === "number" ? item.revision : 0);
      this.keyByServerId.set(item.id, cell.key);
    }
  }

  private applyOutput(id: string, payload: Record<string, unknown>): void {
    const cell = this.cell(id);
    if (!cell?.server) return;
    const next: HostCellState = { ...cell.server, outputs: [...cell.server.outputs], log: [...cell.server.log] };
    if (payload.kind === "clear") {
      next.outputs = [];
      next.outputsStale = false;
      next.log = [];
      next.progress = null;
    } else if (payload.kind === "append") {
      const value = isRecord(payload.payload) && "output" in payload.payload
        ? payload.payload.output
        : payload.payload;
      if (next.outputsStale) next.outputs = [];
      next.outputsStale = false;
      next.outputs.push(value);
    } else if (payload.kind === "progress") {
      next.progress = isRecord(payload.payload) && "progress" in payload.payload
        ? payload.payload.progress
        : payload.payload;
    } else if (payload.kind === "log") {
      const detail = isRecord(payload.payload) ? payload.payload : null;
      const value = detail
        ? detail.lines ?? detail.log ?? []
        : payload.payload;
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      const previous = detail?.replaceLast === true && next.log.length > 0
        ? next.log.slice(0, -1)
        : next.log;
      next.log = boundedLog([...previous, ...lines]);
    }
    cell.server = next;
    const index = this.snapshotValue.cells.findIndex((candidate) => candidate.id === id);
    if (index >= 0) {
      const cells = [...this.snapshotValue.cells];
      cells[index] = next;
      this.snapshotValue = { ...this.snapshotValue, cells };
    }
  }

  private reconcileEdited(value: unknown, submitted?: SubmittedOperation): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.revision !== "number") continue;
      const cell = this.cell(item.id);
      if (!cell) continue;
      const sent = submitted?.cells.get(cell.key);
      if (sent === undefined || sent.expectedRevision === null) continue;
      const submittedRevision = sent.expectedRevision + (sent.changesSource ? 1 : 0);
      if (item.revision !== submittedRevision || item.revision < cell.serverRevision) continue;
      if (item.revision > cell.serverRevision) {
        cell.serverBody = [...sent.body];
        cell.serverType = sent.type;
      }
      const authoritativeMatches = cell.serverType === sent.type && sameLines(cell.serverBody, sent.body);
      if (!authoritativeMatches) continue;
      cell.serverRevision = item.revision;
      cell.acknowledgedGeneration = Math.max(cell.acknowledgedGeneration, sent.generation);
      cell.conflict = false;
    }
  }

  private matchingSubmittedCell(
    operationId: string,
    cell: LocalCell,
    serverCell: HostCellState,
  ): SubmittedCell | undefined {
    const operation = this.submitted.get(operationId);
    if (operation === undefined) return undefined;
    const sent = operation.cells.get(cell.key)
      ?? (cell.clientOperationId === null ? undefined : operation.creations.get(cell.clientOperationId));
    if (sent === undefined || sent.type !== serverCell.type || !sameLines(sent.body, serverCell.body)) {
      return undefined;
    }
    const expectedRevision = sent.expectedRevision;
    if (expectedRevision === null) return serverCell.revision === 0 ? sent : undefined;
    const submittedRevision = sent.changesSource ? expectedRevision + 1 : expectedRevision;
    return serverCell.revision === submittedRevision ? sent : undefined;
  }

  private reassertLocalDirty(): void {
    const pending = this.pendingSource();
    if (pending.edits.length || pending.creations.length || this.ordered.some((cell) => cell.tombstone)) {
      this.snapshotValue = { ...this.snapshotValue, changed: true };
    }
  }

  private predecessorServerId(key: string): string | null {
    const index = this.ordered.findIndex((cell) => cell.key === key);
    for (let before = index - 1; before >= 0; before -= 1) {
      const id = this.ordered[before]!.id;
      if (id !== null) return id;
    }
    return null;
  }

  private removeServerCell(id: string): void {
    const cell = this.cell(id);
    if (!cell) return;
    const restoreAfter = predecessorInOrder(this.serverOrder, id, new Set(this.serverOrder.filter((candidate) => candidate !== id)));
    this.serverOrder = this.serverOrder.filter((candidate) => candidate !== id);
    if (cell.tombstone) return;
    if (cell.generation > cell.acknowledgedGeneration) {
      cell.conflict = true;
      cell.tombstone = true;
      cell.restoreAfter = restoreAfter;
      return;
    }
    this.removeCell(cell);
  }

  private removeCell(cell: LocalCell): void {
    this.ordered = this.ordered.filter((candidate) => candidate !== cell);
    this.byKey.delete(cell.key);
    if (cell.id) this.keyByServerId.delete(cell.id);
    if (cell.clientOperationId) this.keyByCreationId.delete(cell.clientOperationId);
    if (this.focused === cell.key) this.focused = null;
  }

  private reorderFromServerOrderIfPossible(): void {
    if (this.ordered.some((cell) => cell.id === null || cell.tombstone)) return;
    const indexes = new Map(this.serverOrder.map((id, index) => [id, index]));
    this.ordered.sort((a, b) => (a.id ? indexes.get(a.id) ?? Infinity : Infinity) - (b.id ? indexes.get(b.id) ?? Infinity : Infinity));
  }

  private moveServerOrder(id: string, after: string | null): void {
    const from = this.serverOrder.indexOf(id);
    if (from < 0) return;
    this.serverOrder.splice(from, 1);
    const predecessor = after === null ? -1 : this.serverOrder.indexOf(after);
    if (after !== null && predecessor < 0) {
      this.serverOrder.splice(from, 0, id);
      return;
    }
    const target = predecessor + 1;
    this.serverOrder.splice(Math.max(0, target), 0, id);
  }

  private requireCell(key: string): LocalCell {
    const cell = this.cell(key);
    if (!cell) throw new Error(`no such local cell: ${key}`);
    return cell;
  }

  private assertNoSourceConflicts(): void {
    if (this.hasSourceConflicts) {
      throw new Error("resolve deleted or conflicting local source before continuing");
    }
  }
}

function patchSnapshot(snapshot: HostSnapshot, event: HostEvent, order: readonly string[]): HostSnapshot {
  const next = { ...snapshot, cursor: event.cursor, version: event.version };
  let addedCell = false;
  if (event.type === "runtime" && isRecord(event.payload)) next.runtime = event.payload as unknown as HostSnapshot["runtime"];
  if (event.type === "graph" && isRecord(event.payload)) next.graph = event.payload as unknown as HostSnapshot["graph"];
  if (event.type === "variables" && Array.isArray(event.payload)) {
    next.variables = event.payload as HostSnapshot["variables"];
  }
  if (event.type === "editor-diagnostics" && isRecord(event.payload)) {
    next.editorDiagnostics = event.payload as HostSnapshot["editorDiagnostics"];
  }
  if (event.type === "service-errors" && isRecord(event.payload)) {
    next.serviceErrors = event.payload as HostSnapshot["serviceErrors"];
  }
  if (event.type === "service-error") {
    next.lastActionError = isRecord(event.payload) ? event.payload as unknown as HostSnapshot["lastActionError"] : null;
  }
  if (event.type === "receipt" && isRecord(event.payload) && isOperation(event.payload.operation)) {
    next.operations = upsertOperation(next.operations, event.payload.operation);
  }
  if (event.type === "operation" && isOperation(event.payload)) {
    next.operations = upsertOperation(next.operations, event.payload);
  }
  if (event.type === "notebook" && isRecord(event.payload)) {
    const payload = event.payload;
    if (isRecord(payload.config)) next.config = payload.config;
    if ("layout" in payload) next.layout = payload.layout;
    if (isRecord(payload.metadata)) next.metadata = payload.metadata;
    if (isRecord(payload.app)) next.metadata = { ...next.metadata, app: payload.app };
    if ("lastValue" in payload) next.lastValue = payload.lastValue;
    if (payload.saved === true) next.changed = false;
    const deleted = payload.deleted;
    if (typeof deleted === "string") {
      next.cells = next.cells.filter((cell) => cell.id !== deleted);
    }
    if (
      Array.isArray(payload.edited) || Array.isArray(payload.created) ||
      typeof payload.deleted === "string" || typeof payload.moved === "string" ||
      isRecord(payload.config) || isRecord(payload.metadata) || isRecord(payload.app)
    ) next.changed = true;
  }
  if (["cell", "cell-started", "cell-completed"].includes(event.type) && event.cellId) {
    if (isRecord(event.payload) && event.payload.deleted === true) {
      next.cells = next.cells.filter((cell) => cell.id !== event.cellId);
    } else if (isHostCell(event.payload)) {
      const payload = event.payload;
      const index = next.cells.findIndex((cell) => cell.id === payload.id);
      const prior = index < 0 ? null : next.cells[index]!;
      next.cells = [...next.cells];
      if (index < 0) {
        next.cells.push(payload);
        addedCell = true;
      }
      else next.cells[index] = payload;
      if (event.type === "cell" && prior && sourceRecordChanged(prior, payload)) next.changed = true;
    }
  }
  if (event.type === "diagnostics" && event.cellId && Array.isArray(event.payload)) {
    const index = next.cells.findIndex((cell) => cell.id === event.cellId);
    if (index >= 0) {
      next.cells = [...next.cells];
      next.cells[index] = { ...next.cells[index]!, diagnostics: event.payload as HostCellState["diagnostics"] };
    }
  }
  // Execution, output, diagnostics, and operation events never change source
  // order. Sorting a long snapshot for each of those ordered messages adds
  // avoidable work to the input-to-result path.
  const reorderNotebook = event.type === "notebook" && order.length === next.cells.length
    && !next.cells.every((cell, index) => cell.id === order[index]);
  if (order.length && next.cells.length && (
    addedCell || reorderNotebook
  )) {
    const indexes = new Map(order.map((id, index) => [id, index]));
    next.cells = [...next.cells].sort((left, right) =>
      (indexes.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  return next;
}

function upsertOperation(operations: readonly OperationRecord[], operation: OperationRecord): OperationRecord[] {
  const index = operations.findIndex((candidate) => candidate.id === operation.id);
  if (index < 0) return [...operations, operation];
  const next = [...operations];
  next[index] = operation;
  return next;
}

function predecessorInOrder(order: readonly string[], id: string, retained: ReadonlySet<string>): string | null {
  const index = order.indexOf(id);
  for (let before = index - 1; before >= 0; before -= 1) {
    const candidate = order[before];
    if (candidate !== undefined && retained.has(candidate)) return candidate;
  }
  return null;
}

function isOperation(value: unknown): value is OperationRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.status === "string";
}

function sourceRecordChanged(left: HostCellState, right: HostCellState): boolean {
  return left.type !== right.type || !sameLines(left.body, right.body) || JSON.stringify(left.options) !== JSON.stringify(right.options);
}

function isHostCell(value: unknown): value is HostCellState {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.body) && typeof value.revision === "number" && (value.type === "code" || value.type === "markdown");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function boundedLog(lines: readonly string[]): string[] {
  return tailLog(lines, MAX_LOG_BYTES);
}
