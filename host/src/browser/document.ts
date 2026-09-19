import type {
  CellType,
  CommandResult,
  DocumentChange,
  HostCellState,
  HostCommand,
  HostEvent,
  HostSnapshot,
  OperationRecord,
} from "../protocol.js";
import type { BrowserRecoveryDraft } from "./transport.js";
import { tailLog } from "../output-log.js";
import { toLogicalCellBody, toPhysicalCellBody } from "../cell-body.js";

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
  creationId: string | null;
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
  structural: DocumentChange[];
}

export interface PendingSource {
  changes: DocumentChange[];
}
export interface SourceCommitOutcome {
  created: unknown;
  edited: unknown;
  deleted: unknown;
  documentRevision: number;
}

export interface RunCommandOptions {
  requestId: string;
  clientId: string;
  scope: "cell" | "all" | "stale";
  targetKey?: string;
}

export type BrowserTransactionCommand = Omit<Extract<HostCommand, { type: "transaction" }>, never>;
export type BrowserRunCommand = Omit<Extract<HostCommand, { type: "run" }>, never>;

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
  private draftBaseValue: BrowserRecoveryDraft["base"] | null = null;
  private recoveredStructural: DocumentChange[] = [];
  private recoveredStructuralConflict = false;
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
  get hasSourceConflicts(): boolean { return this.recoveredStructuralConflict || this.ordered.some((cell) => cell.conflict || cell.tombstone); }
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
    creationId: string,
    afterKey: string | null,
    type: CellType = "code",
    body: readonly string[] = [],
  ): LocalCell {
    if (!creationId || this.keyByCreationId.has(creationId)) {
      throw new Error("creationId must be unique and nonempty");
    }
    const key = `creation:${creationId}`;
    const after = afterKey === null ? this.ordered.length - 1 : this.ordered.findIndex((cell) => cell.key === afterKey);
    if (afterKey !== null && after < 0) throw new Error(`no such predecessor: ${afterKey}`);
    this.captureDraftBase();
    const cell: LocalCell = {
      key,
      id: null,
      creationId,
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
    this.keyByCreationId.set(creationId, key);
    return cell;
  }

  edit(key: string, body: readonly string[], type?: CellType): LocalCell {
    const cell = this.requireCell(key);
    this.captureDraftBase();
    cell.desiredBody = [...body];
    if (type) cell.desiredType = type;
    cell.generation += 1;
    if (!cell.tombstone && cell.desiredType === cell.serverType && sameLines(cell.desiredBody, cell.serverBody)) {
      cell.conflict = false;
      cell.acknowledgedGeneration = cell.generation;
    }
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

  restoreDeleted(key: string, creationId: string): LocalCell {
    const cell = this.requireCell(key);
    if (!cell.tombstone || cell.id === null) throw new Error("cell is not a deleted-source conflict");
    if (!creationId || this.keyByCreationId.has(creationId)) {
      throw new Error("creationId must be unique and nonempty");
    }
    this.captureDraftBase();
    this.keyByServerId.delete(cell.id);
    cell.id = null;
    cell.creationId = creationId;
    cell.serverBody = [];
    cell.serverType = cell.desiredType;
    cell.serverRevision = 0;
    cell.acknowledgedGeneration = -1;
    cell.conflict = false;
    cell.tombstone = false;
    cell.server = null;
    this.keyByCreationId.set(creationId, cell.key);
    return cell;
  }

  pendingSource(): PendingSource {
    const changes: DocumentChange[] = [];
    for (const cell of this.ordered) {
      if (cell.tombstone) continue;
      if (cell.id === null) {
        const predecessor = this.predecessorReference(cell.key);
        changes.push({
          type: "create",
          creationId: cell.creationId!,
          after: predecessor,
          body: toPhysicalCellBody(cell.desiredType, cell.desiredBody),
          cellType: cell.desiredType,
          options: {},
        });
      } else if (
        cell.generation > cell.acknowledgedGeneration
        || cell.desiredType !== cell.serverType
        || !sameLines(cell.desiredBody, cell.serverBody)
      ) {
        changes.push({
          type: "edit",
          cell: { cellId: cell.id },
          body: toPhysicalCellBody(cell.desiredType, cell.desiredBody, cell.server?.body),
          cellType: cell.desiredType,
          expectedRevision: cell.serverRevision,
        });
      }
    }
    changes.push(...this.recoveredStructural.map((change) => cloneChange(change)));
    return { changes };
  }
  stageRecoveryIntent(changes: readonly DocumentChange[]): void {
    const structural = changes.filter((change) => change.type !== "create" && change.type !== "edit");
    if (structural.length === 0) return;
    this.captureDraftBase();
    this.recoveredStructural = structural.map((change) => cloneChange(change));
    this.recoveredStructuralConflict = false;
  }

  markStructuralRecoveryConflict(): void {
    if (this.recoveredStructural.length > 0) this.recoveredStructuralConflict = true;
  }


  recoveryDraft(draftId: string, submission: BrowserRecoveryDraft["submission"] = null, pendingRun: BrowserRecoveryDraft["pendingRun"] = null): BrowserRecoveryDraft | null {
    const changes = this.recoveryChanges();
    if (changes.length === 0 && pendingRun === null) {
      this.draftBaseValue = null;
      return null;
    }
    const base = this.draftBaseValue ?? this.snapshotBase();
    return {
      schemaVersion: 2,
      draftId,
      updatedAt: Date.now(),
      base: cloneDraftBase(base),
      changes,
      submission,
      pendingRun,
    };
  }

  restoreDraft(draft: BrowserRecoveryDraft, conflict: boolean): void {
    this.draftBaseValue = cloneDraftBase(draft.base);
    for (const change of draft.changes) {
      if (change.type === "create") {
        const existing = this.cell(this.keyByCreationId.get(change.creationId) ?? "");
        if (existing) {
          existing.desiredBody = toLogicalCellBody(change.cellType, change.body);
          existing.desiredType = change.cellType;
          existing.conflict = conflict;
          continue;
        }
        const after = change.after === null
          ? null
          : "cellId" in change.after
            ? this.cell(change.after.cellId)?.key ?? null
            : this.cell(this.keyByCreationId.get(change.after.creationId) ?? "")?.key ?? null;
        const cell = this.create(change.creationId, after, change.cellType, toLogicalCellBody(change.cellType, change.body));
        cell.conflict = conflict;
      } else if (change.type === "edit") {
        const key = "cellId" in change.cell
          ? this.cell(change.cell.cellId)?.key ?? ""
          : this.keyByCreationId.get(change.cell.creationId) ?? "";
        const cell = this.cell(key) ?? this.restoreMissingEdit(change, draft);
        cell.desiredBody = toLogicalCellBody(change.cellType, change.body);
        cell.desiredType = change.cellType;
        cell.generation = Math.max(1, cell.generation + 1);
        cell.acknowledgedGeneration = cell.generation - 1;
        cell.conflict = conflict || cell.tombstone;
      } else {
        this.recoveredStructural.push(cloneChange(change));
        this.recoveredStructuralConflict ||= conflict;
      }
    }
  }

  private recoveryChanges(): DocumentChange[] {
    const changes: DocumentChange[] = [];
    for (const cell of this.ordered) {
      if (cell.id === null) {
        changes.push({
          type: "create",
          creationId: cell.creationId!,
          after: this.predecessorReference(cell.key),
          body: toPhysicalCellBody(cell.desiredType, cell.desiredBody),
          cellType: cell.desiredType,
          options: {},
        });
      } else if (cell.tombstone || cell.generation > cell.acknowledgedGeneration || cell.desiredType !== cell.serverType || !sameLines(cell.desiredBody, cell.serverBody)) {
        changes.push({
          type: "edit",
          cell: { cellId: cell.id },
          body: toPhysicalCellBody(cell.desiredType, cell.desiredBody),
          cellType: cell.desiredType,
          expectedRevision: cell.serverRevision,
        });
      }
    }
    changes.push(...this.recoveredStructural.map((change) => cloneChange(change)));
    return changes;
  }

  private snapshotBase(): BrowserRecoveryDraft["base"] {
    return {
      epoch: this.snapshotValue.epoch,
      documentRevision: this.snapshotValue.documentRevision,
      cells: this.snapshotValue.cells.map((cell) => ({ id: cell.id, revision: cell.revision, type: cell.type, body: [...cell.body] })),
    };
  }

  private captureDraftBase(): void {
    this.draftBaseValue ??= this.snapshotBase();
  }

  rebaseDraftToSnapshot(): void {
    this.draftBaseValue = this.recoveryChanges().length === 0 ? null : this.snapshotBase();
  }

  private restoreMissingEdit(change: Extract<DocumentChange, { type: "edit" }>, draft: BrowserRecoveryDraft): LocalCell {
    const id = "cellId" in change.cell ? change.cell.cellId : null;
    const creationId = "creationId" in change.cell ? change.cell.creationId : null;
    const baseIndex = id === null ? -1 : draft.base.cells.findIndex((cell) => cell.id === id);
    const baseCell = baseIndex < 0 ? null : draft.base.cells[baseIndex]!;
    const key = id === null ? "recovery-created:" + creationId : "recovery-deleted:" + id;
    const preceding = baseIndex <= 0 ? null : draft.base.cells.slice(0, baseIndex).reverse().find((candidate) => this.cell(candidate.id))?.id ?? null;
    const cell: LocalCell = {
      key,
      id,
      creationId,
      desiredBody: toLogicalCellBody(change.cellType, change.body),
      desiredType: change.cellType,
      serverBody: baseCell ? toLogicalCellBody(baseCell.type, baseCell.body) : [],
      serverType: baseCell?.type ?? change.cellType,
      serverRevision: baseCell?.revision ?? change.expectedRevision ?? 0,
      generation: 0,
      acknowledgedGeneration: 0,
      conflict: true,
      tombstone: id !== null,
      restoreAfter: preceding,
      server: null,
      selection: null,
    };
    const insertion = preceding === null ? 0 : Math.max(0, this.ordered.findIndex((candidate) => candidate.id === preceding) + 1);
    this.ordered.splice(insertion, 0, cell);
    this.byKey.set(key, cell);
    if (id !== null) this.keyByServerId.set(id, key);
    if (creationId !== null) this.keyByCreationId.set(creationId, key);
    return cell;
  }

  buildTransactionCommand(operationId: string, clientId: string): BrowserTransactionCommand | null {
    this.assertNoSourceConflicts();
    const changes = this.pendingSource().changes;
    if (changes.length === 0) return null;
    return {
      type: "transaction", requestId: operationId, clientId, sessionEpoch: this.epochValue,
      expectedDocumentRevision: this.snapshotValue.documentRevision,
      changes,
    };
  }

  buildRunCommand(options: RunCommandOptions): BrowserRunCommand {
    this.assertNoSourceConflicts();
    const changes = this.pendingSource().changes;
    const target = options.targetKey ? this.requireCell(options.targetKey) : null;
    if (options.scope === "cell" && !target) throw new Error("a target cell is required");
    if (options.scope !== "cell" && target) throw new Error("a target cell is valid only for a cell run");
    if (target?.tombstone) throw new Error("deleted cells must be restored or discarded before running");
    const targetRef = target?.id !== null && target?.id !== undefined
      ? { cellId: target.id }
      : target?.creationId !== null && target?.creationId !== undefined
        ? { creationId: target.creationId }
        : undefined;
    return {
      type: "run",
      requestId: options.requestId,
      clientId: options.clientId,
      sessionEpoch: this.epochValue,
      scope: options.scope,
      ...(targetRef === undefined ? {} : { target: targetRef }),
      ...(changes.length === 0 ? {} : { changes }),
      expectedDocumentRevision: this.snapshotValue.documentRevision,
    };
  }

  noteSubmitted(operationId: string, command: HostCommand): void {
    const operation: SubmittedOperation = { cells: new Map(), creations: new Map(), structural: [] };
    const changes = command.type === "run" || command.type === "transaction" ? command.changes ?? [] : [];
    for (const change of changes) {
      if (change.type === "edit" || change.type === "text-edit") {
        const cell = this.cellRef(change.cell);
        if (cell && change.type === "edit") {
          const body = toLogicalCellBody(change.cellType, change.body);
          operation.cells.set(cell.key, {
            generation: cell.generation,
            body,
            type: change.cellType,
            expectedRevision: change.expectedRevision ?? cell.serverRevision,
            changesSource: cell.serverType !== change.cellType || !sameLines(cell.serverBody, body),
          });
        }
      } else if (change.type === "create") {
        const key = this.keyByCreationId.get(change.creationId);
        const cell = key ? this.byKey.get(key) : undefined;
        if (cell) operation.creations.set(change.creationId, {
          generation: cell.generation,
          body: toLogicalCellBody(change.cellType, change.body),
          type: change.cellType,
          expectedRevision: null,
          changesSource: true,
        });
      } else {
        operation.structural.push(cloneChange(change));
      }
    }
    this.submitted.set(operationId, operation);
  }

  acknowledge(result: CommandResult): void {
    this.cursorValue = Math.max(this.cursorValue, result.cursor);
    this.snapshotValue = {
      ...this.snapshotValue,
      cursor: this.cursorValue,
      version: Math.max(this.snapshotValue.version, result.version),
      documentRevision: Math.max(this.snapshotValue.documentRevision, result.documentRevision),
    };
    const submitted = this.submitted.get(result.requestId);
    const change = isRecord(result.result) ? result.result : {};
    this.reconcileCreated(change.created);
    this.reconcileEdited(change.edited, submitted);
    if (submitted) this.reconcileSubmittedCreations(change.created, submitted);
    if (submitted) this.recoveredStructuralConflict = false;
    if (submitted) this.recoveredStructural = [];
    this.submitted.delete(result.requestId);
    this.rebaseDraftToSnapshot();
  }
  acknowledgeSourceCommit(operationId: string, outcome: SourceCommitOutcome): boolean {
    const submitted = this.submitted.get(operationId);
    if (
      submitted === undefined
      || !Number.isSafeInteger(outcome.documentRevision)
      || outcome.documentRevision < 0
      || this.snapshotValue.documentRevision < outcome.documentRevision
    ) return false;
    this.snapshotValue = { ...this.snapshotValue, documentRevision: Math.max(this.snapshotValue.documentRevision, outcome.documentRevision) };
    this.reconcileCreated(outcome.created);
    this.reconcileEdited(outcome.edited, submitted);
    this.reconcileSubmittedCreations(outcome.created, submitted);
    return this.finishSourceCommit(operationId, submitted);
  }

  private finishSourceCommit(operationId: string, submitted: SubmittedOperation): boolean {
    if (!this.sourceSubmissionAcknowledged(submitted)) return false;
    this.recoveredStructuralConflict = false;
    this.recoveredStructural = [];
    this.submitted.delete(operationId);
    this.rebaseDraftToSnapshot();
    return true;
  }

  reject(operationId: string, code: string): void {
    const submitted = this.submitted.get(operationId);
    if (submitted && code === "source_conflict") {
      for (const [key, sent] of submitted.cells) {
        const cell = this.byKey.get(key);
        if (cell && cell.generation <= sent.generation && cell.generation > cell.acknowledgedGeneration && (cell.serverType !== sent.type || !sameLines(cell.serverBody, sent.body))) cell.conflict = true;
      }
    }
    if (submitted && submitted.structural.length > 0) {
      this.recoveredStructural = this.recoveredStructural.filter((candidate) => !submitted.structural.some((sent) => sameChange(candidate, sent)));
      if (this.recoveredStructural.length === 0) this.recoveredStructuralConflict = false;
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
    } else if ((event.type === "notebook" || event.type === "transaction") && isRecord(event.payload)) {
      this.reconcileCreated(event.payload.created);
      if (Array.isArray(event.payload.updated)) {
        for (const cell of event.payload.updated) if (isHostCell(cell)) this.mergeServerCell(cell, false, event.operationId);
      }
      if (typeof event.payload.deleted === "string") this.removeServerCell(event.payload.deleted);
      if (Array.isArray(event.payload.deleted)) {
        for (const id of event.payload.deleted) if (typeof id === "string") this.removeServerCell(id);
      }
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
  }

  applySnapshot(snapshot: HostSnapshot): void {
    const epochChanged = this.epochValue !== snapshot.epoch;
    this.epochValue = snapshot.epoch;
    this.cursorValue = snapshot.cursor;
    this.snapshotValue = snapshot;
    const previousOrder = this.serverOrder;
    this.serverOrder = snapshot.cells.map((cell) => cell.id);
    if (epochChanged) {
      for (const operation of this.submitted.values()) {
        for (const change of operation.structural) {
          if (!this.recoveredStructural.some(candidate => sameChange(candidate, change))) this.recoveredStructural.push(cloneChange(change));
        }
      }
      this.submitted.clear();
      for (const cell of this.ordered) {
        if (cell.creationId !== null || cell.generation > cell.acknowledgedGeneration || cell.tombstone) cell.conflict = true;
      }
      if (this.recoveredStructural.length > 0) this.recoveredStructuralConflict = true;
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
        } else this.removeCell(cell);
      }
    }
    this.reorderFromServerOrderIfPossible();
  }

  private mergeServerCell(serverCell: HostCellState, forceSource = false, operationId?: string): LocalCell {
    const logicalBody = toLogicalCellBody(serverCell.type, serverCell.body);
    let key = this.keyByServerId.get(serverCell.id);
    let cell = key ? this.byKey.get(key) : undefined;
    if (!cell) {
      key = `cell:${serverCell.id}`;
      cell = {
        key,
        id: serverCell.id,
        creationId: null,
        desiredBody: [...logicalBody],
        desiredType: serverCell.type,
        serverBody: [...logicalBody],
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
    const sourceChanged = forceSource || cell.serverRevision !== serverCell.revision || cell.serverType !== serverCell.type || !sameLines(cell.serverBody, logicalBody);
    if (pending && sourceChanged) {
      const desiredMatches = cell.desiredType === serverCell.type && sameLines(cell.desiredBody, logicalBody);
      const sent = operationId === undefined ? undefined : this.matchingSubmittedCell(operationId, cell, serverCell);
      cell.conflict = sent === undefined && !desiredMatches;
      if (sent !== undefined) cell.acknowledgedGeneration = Math.max(cell.acknowledgedGeneration, sent.generation);
      else if (desiredMatches) cell.acknowledgedGeneration = cell.generation;
    } else if (!pending) {
      if (sourceChanged) {
        cell.desiredBody = [...logicalBody];
        cell.desiredType = serverCell.type;
      }
      cell.conflict = false;
    }
    cell.id = serverCell.id;
    if (sourceChanged) cell.serverBody = [...logicalBody];
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
    const entries = createdEntries(value);
    for (const item of entries) {
      const key = this.keyByCreationId.get(item.creationId);
      const cell = key ? this.byKey.get(key) : undefined;
      if (!cell) continue;
      const existingKey = this.keyByServerId.get(item.id);
      const existing = existingKey === undefined || existingKey === cell.key ? undefined : this.byKey.get(existingKey);
      if (existing !== undefined) {
        const wasFocused = this.focused === existing.key;
        this.removeCell(existing);
        if (wasFocused) this.focused = cell.key;
        if (existing.server !== null) {
          cell.serverBody = [...existing.serverBody];
          cell.serverType = existing.serverType;
          cell.serverRevision = existing.serverRevision;
          cell.server = existing.server;
          cell.conflict = cell.generation > cell.acknowledgedGeneration && (cell.desiredType !== existing.serverType || !sameLines(cell.desiredBody, existing.serverBody));
        }
      }
      cell.id = item.id;
      cell.serverRevision = Math.max(cell.serverRevision, item.revision);
      this.keyByServerId.set(item.id, cell.key);
    }
  }

  private applyOutput(id: string, payload: Record<string, unknown>): void {
    const cell = this.cell(id);
    if (!cell?.server) return;
    const next: HostCellState = {
      ...cell.server, outputs: [...cell.server.outputs], log: [...cell.server.log],
      displayOrder: (cell.server.displayOrder ?? []).map((part) => ({ ...part })),
    };
    if (payload.kind === "clear") {
      next.outputs = [];
      next.outputsStale = false;
      next.log = [];
      next.displayOrder = [];
      next.progress = null;
    } else if (payload.kind === "append") {
      const value = isRecord(payload.payload) && "output" in payload.payload ? payload.payload.output : payload.payload;
      if (next.outputsStale) next.outputs = [];
      next.outputsStale = false;
      if (isOutputRecord(value)) {
        next.outputs.push(value);
        next.displayOrder?.push({ kind: "output", id: value.id });
      }
    } else if (payload.kind === "progress") {
      const progress = isRecord(payload.payload) && "progress" in payload.payload ? payload.payload.progress : payload.payload;
      next.progress = progress as HostCellState["progress"];
    } else if (payload.kind === "log") {
      const detail = isRecord(payload.payload) ? payload.payload : null;
      const value = detail ? detail.lines ?? detail.log ?? [] : payload.payload;
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      const previous = detail?.replaceLast === true && next.log.length > 0 ? next.log.slice(0, -1) : next.log;
      next.log = boundedLog([...previous, ...lines]);
      const raw = detail && typeof detail.raw === "string" ? detail.raw : lines.join("\n");
      if (raw.length > 0) {
        const last = next.displayOrder?.at(-1);
        if (last?.kind === "log") last.text += raw;
        else next.displayOrder?.push({ kind: "log", text: raw });
      }
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
  private reconcileSubmittedCreations(value: unknown, submitted: SubmittedOperation): void {
    for (const [creationId, sent] of submitted.creations) {
      const cell = this.cell(this.keyByCreationId.get(creationId) ?? "");
      const created = createdEntry(value, creationId);
      if (!cell || cell.id === null || created === null || cell.serverRevision > created.revision) continue;
      cell.serverBody = [...sent.body];
      cell.serverType = sent.type;
      cell.serverRevision = created.revision;
      cell.acknowledgedGeneration = Math.max(cell.acknowledgedGeneration, sent.generation);
      cell.conflict = false;
    }
  }

  private sourceSubmissionAcknowledged(submitted: SubmittedOperation): boolean {
    const acknowledgements: Array<{ cell: LocalCell; sent: SubmittedCell }> = [];
    for (const [key, sent] of submitted.cells) {
      const cell = this.byKey.get(key);
      const expectedRevision = sent.expectedRevision === null
        ? 0
        : sent.expectedRevision + (sent.changesSource ? 1 : 0);
      if (!cell || cell.id === null || cell.tombstone || cell.serverRevision < expectedRevision) return false;
      if (cell.serverRevision === expectedRevision && (cell.serverType !== sent.type || !sameLines(cell.serverBody, sent.body))) return false;
      acknowledgements.push({ cell, sent });
    }
    for (const [creationId, sent] of submitted.creations) {
      const cell = this.cell(this.keyByCreationId.get(creationId) ?? "");
      if (!cell || cell.id === null || cell.tombstone || cell.serverRevision < 0) return false;
      if (cell.serverRevision === 0 && (cell.serverType !== sent.type || !sameLines(cell.serverBody, sent.body))) return false;
      acknowledgements.push({ cell, sent });
    }
    for (const { cell, sent } of acknowledgements) {
      cell.acknowledgedGeneration = Math.max(cell.acknowledgedGeneration, sent.generation);
      if (cell.generation === sent.generation) {
        cell.conflict = cell.serverType !== sent.type || !sameLines(cell.serverBody, sent.body);
      } else if (cell.serverType === cell.desiredType && sameLines(cell.serverBody, cell.desiredBody)) {
        cell.conflict = false;
      }
    }
    return true;
  }

  private matchingSubmittedCell(operationId: string, cell: LocalCell, serverCell: HostCellState): SubmittedCell | undefined {
    const operation = this.submitted.get(operationId);
    if (operation === undefined) return undefined;
    const sent = operation.cells.get(cell.key) ?? (cell.creationId === null ? undefined : operation.creations.get(cell.creationId));
    if (sent === undefined || sent.type !== serverCell.type || !sameLines(sent.body, toLogicalCellBody(serverCell.type, serverCell.body))) return undefined;
    const expectedRevision = sent.expectedRevision;
    if (expectedRevision === null) return serverCell.revision === 0 ? sent : undefined;
    const submittedRevision = sent.changesSource ? expectedRevision + 1 : expectedRevision;
    return serverCell.revision === submittedRevision ? sent : undefined;
  }

  private predecessorReference(key: string): { cellId: string } | { creationId: string } | null {
    const index = this.ordered.findIndex((cell) => cell.key === key);
    for (let before = index - 1; before >= 0; before -= 1) {
      const prior = this.ordered[before]!;
      if (prior.id !== null) return { cellId: prior.id };
      if (prior.creationId !== null) return { creationId: prior.creationId };
    }
    return null;
  }

  private cellRef(ref: { cellId: string } | { creationId: string }): LocalCell | undefined {
    return "cellId" in ref ? this.cell(ref.cellId) : this.cell(this.keyByCreationId.get(ref.creationId) ?? "");
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
    if (cell.creationId) this.keyByCreationId.delete(cell.creationId);
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
    this.serverOrder.splice(Math.max(0, predecessor + 1), 0, id);
  }

  private requireCell(key: string): LocalCell {
    const cell = this.cell(key);
    if (!cell) throw new Error(`no such local cell: ${key}`);
    return cell;
  }

  private assertNoSourceConflicts(): void {
    if (this.hasSourceConflicts) throw new Error("resolve deleted or conflicting local source before continuing");
  }
}

function cloneDraftBase(base: BrowserRecoveryDraft["base"]): BrowserRecoveryDraft["base"] {
  return {
    epoch: base.epoch,
    documentRevision: base.documentRevision,
    cells: base.cells.map((cell) => ({ ...cell, body: [...cell.body] })),
  };
}

function patchSnapshot(snapshot: HostSnapshot, event: HostEvent, order: readonly string[]): HostSnapshot {
  const next = { ...snapshot, cursor: event.cursor, version: event.version, documentRevision: event.documentRevision };
  let addedCell = false;
  if (event.type === "active_clients_changed" && isRecord(event.payload)) {
    const activeClientIds = validActiveClientIds(event.payload.activeClientIds);
    if (activeClientIds !== null) next.activeClientIds = activeClientIds;
  }
  if (event.type === "runtime" && isRecord(event.payload)) next.runtime = event.payload as unknown as HostSnapshot["runtime"];
  if (event.type === "graph" && isRecord(event.payload)) next.graph = event.payload as unknown as HostSnapshot["graph"];
  if (event.type === "variables" && Array.isArray(event.payload)) next.variables = event.payload as unknown as HostSnapshot["variables"];
  if (event.type === "editor-diagnostics" && isRecord(event.payload)) next.editorDiagnostics = event.payload as HostSnapshot["editorDiagnostics"];
  if (event.type === "service-errors" && isRecord(event.payload)) next.serviceErrors = event.payload as HostSnapshot["serviceErrors"];
  if (event.type === "service-error") next.lastActionError = isRecord(event.payload) ? event.payload as unknown as HostSnapshot["lastActionError"] : null;
  if (event.type === "operation") {
    const operation = operationFromEventPayload(event.payload);
    if (operation) next.operations = upsertOperation(next.operations, operation);
  }
  if ((event.type === "notebook" || event.type === "transaction") && isRecord(event.payload)) {
    const payload = event.payload;
    if (isRecord(payload.config)) next.config = payload.config;
    if (isRecord(payload.runtime)) next.runtime = payload.runtime as unknown as HostSnapshot["runtime"];
    if (typeof payload.preferencesVersion === "string" || payload.preferencesVersion === null) next.preferencesVersion = payload.preferencesVersion;
    if (typeof payload.path === "string" || payload.path === null) next.path = payload.path;
    if (isSidecarObservations(payload.sidecars)) next.sidecars = payload.sidecars;
    if ("layout" in payload) next.layout = payload.layout;
    if (isRecord(payload.metadata)) next.metadata = payload.metadata;
    if (isRecord(payload.app)) next.metadata = { ...next.metadata, app: payload.app };
    if (isRecord(payload.graph)) next.graph = payload.graph as unknown as HostSnapshot["graph"];
    if ("lastValue" in payload) next.lastValue = payload.lastValue;
    if (typeof payload.deleted === "string") next.cells = next.cells.filter((cell) => cell.id !== payload.deleted);
    const deletedIds = payload.deleted;
    if (Array.isArray(deletedIds)) next.cells = next.cells.filter((cell) => !deletedIds.includes(cell.id));
    if (Array.isArray(payload.updated)) {
      const updates = new Map<string, HostCellState>();
      for (const value of payload.updated) if (isHostCell(value)) updates.set(value.id, value);
      if (updates.size > 0) {
        const present = new Set(next.cells.map((cell) => cell.id));
        next.cells = next.cells.map((cell) => updates.get(cell.id) ?? cell);
        for (const [id, cell] of updates) if (!present.has(id)) next.cells.push(cell);
        addedCell ||= [...updates.keys()].some((id) => !present.has(id));
      }
    }
    if (typeof payload.dirty === "boolean") next.dirty = payload.dirty;
  }
  if (["cell", "cell-started", "cell-completed"].includes(event.type) && event.cellId) {
    if (isRecord(event.payload) && event.payload.deleted === true) next.cells = next.cells.filter((cell) => cell.id !== event.cellId);
    else if (isHostCell(event.payload)) {
      const payload = event.payload;
      const index = next.cells.findIndex((cell) => cell.id === payload.id);
      const prior = index < 0 ? null : next.cells[index]!;
      next.cells = [...next.cells];
      if (index < 0) {
        next.cells.push(payload);
        addedCell = true;
      } else next.cells[index] = payload;
    }
  }
  if (event.type === "diagnostics" && event.cellId && Array.isArray(event.payload)) {
    const index = next.cells.findIndex((cell) => cell.id === event.cellId);
    if (index >= 0) {
      next.cells = [...next.cells];
      next.cells[index] = { ...next.cells[index]!, diagnostics: event.payload as HostCellState["diagnostics"] };
    }
  }
  const reorderNotebook = (event.type === "notebook" || event.type === "transaction") && order.length === next.cells.length && !next.cells.every((cell, index) => cell.id === order[index]);
  if (order.length && next.cells.length && (addedCell || reorderNotebook)) {
    const indexes = new Map(order.map((id, index) => [id, index]));
    next.cells = [...next.cells].sort((left, right) => (indexes.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  return next;
}

function validActiveClientIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return null;
  return ids;
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

function createdEntries(value: unknown): Array<{ creationId: string; id: string; revision: number }> {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([creationId, id]) => typeof id === "string" ? [{ creationId, id, revision: 0 }] : []);
}
function sameChange(left: DocumentChange, right: DocumentChange): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function createdEntry(value: unknown, creationId: string): { creationId: string; id: string; revision: number } | null {
  return createdEntries(value).find((item) => item.creationId === creationId) ?? null;
}
function cloneChange(change: DocumentChange): DocumentChange { return structuredClone(change); }

function isOperation(value: unknown): value is OperationRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.status === "string";
}

function operationFromEventPayload(value: unknown): OperationRecord | null {
  if (isOperation(value)) return value;
  if (isRecord(value) && isOperation(value.operation)) return value.operation;
  return null;
}

function isSidecarObservations(value: unknown): value is HostSnapshot["sidecars"] {
  return isRecord(value) && isDiskObservation(value.config) && isDiskObservation(value.layout) && isDiskObservation(value.packages);
}

function isDiskObservation(value: unknown): value is HostSnapshot["disk"] {
  if (!isRecord(value)) return false;
  const state = value.state;
  const digest = value.digest;
  return (state === "untitled" || state === "absent" || state === "present" || state === "unreadable")
    && (digest === null || (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)))
    && (value.version === null || typeof value.version === "string")
    && (value.error === null || isRecord(value.error));
}

function isHostCell(value: unknown): value is HostCellState {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.body) && typeof value.revision === "number" && (value.type === "code" || value.type === "markdown");
}

function isOutputRecord(value: unknown): value is HostCellState["outputs"][number] {
  return isRecord(value) && typeof value.id === "string" && typeof value.cellId === "string" && typeof value.sequence === "number" && "data" in value;
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

/** Compare source snapshots, not transport history, before recovering unacknowledged edits. */
export function reconcileDraft(draft: BrowserRecoveryDraft, snapshot: HostSnapshot): { draft: BrowserRecoveryDraft; conflict: boolean } {
  const sameCell = (cell: { type: CellType; body: string[] } | undefined, type: CellType, body: string[]) => cell !== undefined && cell.type === type && sameLines(cell.body, body);
  const current = new Map(snapshot.cells.map(cell => [cell.id, cell]));
  const base = new Map(draft.base.cells.map(cell => [cell.id, cell]));
  const unchanged = draft.base.cells.length === snapshot.cells.length && draft.base.cells.every((cell, index) => {
    const next = snapshot.cells[index];
    return next?.id === cell.id && sameCell(next, cell.type, cell.body);
  });
  let conflict = false;
  const changes: DocumentChange[] = [];
  for (const original of draft.changes) {
    let change = structuredClone(original);
    if (change.type === "create") {
      const cell = current.get(change.creationId);
      if (cell) {
        if (sameCell(cell, change.cellType, change.body)) continue;
        const creationId = change.creationId;
        const sent = draft.submission?.changes.find(item => item.type === "create" && item.creationId === creationId);
        if (!sent || sent.type !== "create" || !sameCell(cell, sent.cellType, sent.body)) conflict = true;
        change = { type: "edit", cell: { cellId: cell.id }, cellType: change.cellType, body: change.body, expectedRevision: cell.revision };
      } else if (!unchanged) conflict = true;
    } else if (change.type === "edit" && "cellId" in change.cell) {
      const cell = current.get(change.cell.cellId);
      if (sameCell(cell, change.cellType, change.body)) continue;
      const old = base.get(change.cell.cellId);
      const cellId = change.cell.cellId;
      const sent = draft.submission?.changes.find(item => item.type === "edit" && "cellId" in item.cell && item.cell.cellId === cellId);
      const matchesBase = old && sameCell(cell, old.type, old.body);
      const matchesSent = sent?.type === "edit" && sameCell(cell, sent.cellType, sent.body);
      if (!matchesBase && !matchesSent) conflict = true;
      if (cell) change.expectedRevision = cell.revision;
    } else if (change.type === "delete" && "cellId" in change.cell && !current.has(change.cell.cellId)) {
      continue;
    } else if (change.type === "move" && "cellId" in change.cell) {
      const cellId = change.cell.cellId;
      const index = snapshot.cells.findIndex(cell => cell.id === cellId);
      const previous = index <= 0 ? null : snapshot.cells[index - 1]!.id;
      const desired = change.after === null ? null : "cellId" in change.after ? change.after.cellId : change.after.creationId;
      if (index >= 0 && previous === desired) continue;
      if (!unchanged) conflict = true;
    } else if (change.type === "options" && "cellId" in change.cell) {
      const cell = current.get(change.cell.cellId);
      if (cell && Object.entries(change.patch).every(([key, value]) => cell.options[key] === value)) continue;
      if (!unchanged) conflict = true;
    } else if (!unchanged) conflict = true;
    changes.push(change);
  }
  return { draft: { ...draft, changes, submission: null }, conflict };
}
