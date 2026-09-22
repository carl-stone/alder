import { artifactHandleSchema } from "../protocol.js";
import type { AnalysisDiagnostic, ArtifactHandle, CommandResult, HostCellState, HostEvent, HostQueryResult, HostSnapshot, OperationRecord, OutputRecord } from "../protocol.js";
import { dependencyLevels, reachableNodes } from "../graph.js";
import { toLogicalCellBody } from "../cell-body.js";
import { BrowserNotebookClient } from "./client.js";
import type { BrowserDocument, EditorSelection, LocalCell } from "./document.js";
import { OutputRenderer } from "../output-renderer.js";
import { notebookUrl, notebookViewUrl } from "./url.js";
import type { PreferencesPatch, ProjectSettingsPatch } from "../settings.js";

import type {
  EditorHandle, EditorCompletionContext, EditorCompletion, EditorDiagnostic, EditorHover, EditorSignature,
} from "./editor.js";

declare global {
  interface Window {
    __alderEditors?: Map<string, EditorHandle>;
    __alderHost?: { client: BrowserNotebookClient; view: NotebookView };
  }
}

interface CellView {
  element: HTMLElement;
  editor: EditorHandle | null;
  fallback: HTMLTextAreaElement | null;
  language: "r" | "markdown";
  keymap: string;
  diagnosticsVisibleAt: number;
  diagnosticsTimer: number | null;
  rendered: {
    desiredBody: readonly string[];
    desiredType: LocalCell["desiredType"];
    server: LocalCell["server"];
    id: string | null;
    revision: number;
    conflict: boolean;
    tombstone: boolean;
    index: number;
    cellCount: number;
    config: HostSnapshot["config"];
    editorProjection: string;
  } | null;
}
type PackageServiceCommand = "packages.declare" | "packages.install";


interface LspCompletionEdit {
  cell: string;
  start: { line: number; character: number };
  end: { line: number; character: number };
  newText: string;
}
interface PackageOperationTarget {
  command: PackageServiceCommand;
  operationId: string | null;
  status: HTMLElement;
}

type DataflowPanelTab = "variables" | "dependencies" | "graph" | "outline";
type RuntimeSettings = { executionMode: "automatic" | "lazy"; runOnStartup: boolean; cacheEnabled: boolean };
interface DialogSettings {
  preferences: PreferencesPatch;
  runtime: RuntimeSettings;
  project: ProjectSettingsPatch;
}
interface SettingsBaseline extends DialogSettings {
  preferencesVersion: string | null;
  projectVersion: string | null;
  documentRevision: number;
}

export class NotebookView {
  private readonly notebook: HTMLElement;
  private readonly status: HTMLElement | null;
  private readonly path: HTMLElement | null;
  private readonly views = new Map<string, CellView>();
  private readonly keyByElement = new WeakMap<Element, string>();
  private readonly editors = new Map<string, EditorHandle>();
  private readonly editTimers = new Map<string, number>();
  private autosaveTimer: number | null = null;
  private readonly visibleKeys = new Set<string>();
  private readonly observer: IntersectionObserver | null;
  private readonly output: OutputRenderer;
  private documentValue: BrowserDocument | null = null;
  private actionError: string | null = null;
  private actionNotice: string | null = null;
  private saveStateValue: "edited" | "saving" | "saved" | "failed" = "saved";
  private transportError: string | null = null;
  private transportState: "connecting" | "open" | "recovering" | "closed" = "connecting";
  private editorHelpError: string | null = null;
  private editorHelpRestarting = false;
  private explicitRunCount = 0;
  private emptyBar: HTMLElement | null = null;
  private appView = false;
  private variableFilter = "";
  private graphOrientation: "vertical" | "horizontal" = "vertical";
  private graphZoom = 1;
  private graphExpanded = false;
  private panelOpen = true;
  private panelTab: DataflowPanelTab = "outline";
  private dataflowSignature = "";
  private variablesSignature = "";
  private variablesDirty = false;
  private variablesProjectionFrame: number | null = null;
  private variablesProjectionTimer: number | null = null;
  private variableRows = new Map<string, HTMLButtonElement>();
  private dependenciesSignature = "";
  private outlineSignature = "";
  private readonly outlineCells = new Map<string, string>();
  private configValue: HostSnapshot["config"] | null = null;
  private settingsBaseline: SettingsBaseline | null = null;
  private settingsError: string | null = null;
  private settingsSaving = false;
  private editorDiagnosticsValue: HostSnapshot["editorDiagnostics"] | null = null;
  private editorDiagnosticsVisible = false;
  private editorDiagnosticsSourceCurrent = false;
  private renderedOrder: string[] = [];
  private toolbarSignature = "";
  private hostClosed = false;
  private internalNavigation = false;
  private statusSignature = "";
  private recoveryUnsubscribe: (() => void) | null = null;
  private cellActionsSignature = "";
  private readonly dataflowStatuses = new Map<string, string>();
  private readonly dataflowCells = new Map<string, string>();
  private readonly graphNodes = new Map<string, SVGGElement>();
  private readonly lspRequests = new Map<string, AbortController>();
  private readonly packageOperations = new Set<PackageOperationTarget>();
  private readonly activeFormatOperationIds = new Set<string>();
  private activePublishOperationId: string | null = null;
  private activePackageInstallOperationId: string | null = null;
  private formatCancelButton: HTMLButtonElement | null = null;
  private packageCancelButton: HTMLButtonElement | null = null;
  private draggedKey: string | null = null;
  private panelReturnFocus: HTMLElement | null = null;
  private panelDrawerMode = false;
  private readonly dialogReturnFocus = new WeakMap<HTMLDialogElement, HTMLElement>();
  private deletedCell: { index: number; type: "code" | "markdown"; body: readonly string[]; timer: number } | null = null;
  private readonly resizeHandler = (): void => {
    this.updateTopbarInset();
    const next = this.isInspectorDrawer();
    const previous = this.panelDrawerMode;
    if (next === previous) { this.applyPanelState(); return; }
    const panel = this.dom.getElementById("dataflow-panel");
    const active = this.dom.activeElement as HTMLElement | null;
    if (this.panelOpen && next && (!panel || !active || !panel.contains(active))) {
      this.panelReturnFocus = active ?? this.dom.getElementById("panel-toggle");
    }
    this.panelDrawerMode = next;
    this.applyPanelState();
    if (!this.panelOpen) return;
    if (next) window.requestAnimationFrame(() => this.focusInspector());
    else {
      const target = this.panelReturnFocus ?? this.dom.getElementById("panel-toggle");
      this.panelReturnFocus = null;
      (target as HTMLElement | null)?.focus({ preventScroll: true });
    }
  };
  private readonly preserveRunFocus = (event: MouseEvent): void => {
    if (event.button === 0 && event.target instanceof Element &&
      event.target.closest("#run-all, .cell-head [data-act=run]")) event.preventDefault();
  };

  constructor(readonly client: BrowserNotebookClient, private readonly dom: Document = document) {
    const notebook = dom.getElementById("notebook");
    if (!notebook) throw new Error("Alder page is missing #notebook");
    this.notebook = notebook;
    this.status = dom.getElementById("status");
    this.path = dom.getElementById("path");
    this.appView = new URLSearchParams(location.search).get("view") === "preview";
    const panelPreference = loadPanelPreference(window);
    this.panelDrawerMode = this.isInspectorDrawer();
    this.panelOpen = this.panelDrawerMode ? false : panelPreference.open;
    this.panelTab = panelPreference.tab;
    const appLink = dom.getElementById("app-mode") as HTMLAnchorElement | null;
    const editLink = dom.getElementById("edit-mode") as HTMLAnchorElement | null;
    if (appLink) appLink.href = notebookViewUrl("preview");
    if (editLink) editLink.href = notebookViewUrl("editor");
    dom.body.classList.toggle("app-view", this.appView);
    window.__alderEditors = this.editors;
    this.output = new OutputRenderer({
      document: dom,
      resolveArtifact: async (descriptor) => ({ kind: "url", url: await client.resolveArtifact(descriptor) }),
      mode: "interactive",
      actions: {
        widget: (name, path, update, origin) => client.setWidget(name, path, update, this.appView ? "app" : "editor", origin),
        upload: async (name, path, files) => {
          const encoded = await Promise.all(files.map(encodeFile));
          await client.service("upload", {
            name, path: [...path], files: encoded,
            source: this.appView ? "app" : "editor",
          });
        },
        lazy: (key) => client.requestLazy(key),
        table: (request) => client.requestTable(request),
        error: (error) => this.showError(error),
        pageSize: () => configNumber(this.documentValue?.snapshot.config, ["table", "page_size"], 25),
        widgetAvailable: (widget) => {
          const owner = typeof widget.owner === "string" ? this.documentValue?.cell(widget.owner) : undefined;
          const runtime = this.documentValue?.snapshot.runtime;
          return owner?.server?.status === "done" && runtime?.executionReady === true && runtime?.kernelState === "ready";
        },
      },
    });
    this.observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => this.visibilityChanged(Array.from(entries)), {
          root: null,
          // Mount editors before a fast scroll makes them visible.
          rootMargin: "1200px 0px",
        })
      : null;
    this.bindToolbar();
    // Pointer Run preserves the editor/caret; keyboard users can still focus it.
    dom.addEventListener("mousedown", this.preserveRunFocus);
    this.bindSettings();
    this.bindPublishDialog();
    this.bindNavigation();
    this.bindDragAndDrop();
    this.bindServiceDialogs();
    this.bindDisclosureBehavior();
    this.recoveryUnsubscribe = client.subscribeRecovery(() => this.renderStatus());
    this.applyPanelState();
    this.updateTopbarInset();
    window.requestAnimationFrame(() => this.updateTopbarInset());
    window.addEventListener("resize", this.resizeHandler, { passive: true });
  }

  get document(): BrowserDocument | null { return this.documentValue; }
  get allowsUnload(): boolean { return this.hostClosed || this.internalNavigation; }
  get runPending(): boolean { return this.explicitRunCount > 0; }
  get documentSaveState(): "edited" | "saving" | "saved" | "failed" { return this.saveStateValue; }

  private setSaveState(state: "edited" | "saving" | "saved" | "failed"): void {
    if (this.saveStateValue === state) return;
    this.saveStateValue = state;
    window.dispatchEvent(new window.Event("alder:window-state"));
    if (this.documentValue) this.renderControls(this.documentValue.snapshot);
  }

  async runExplicit<T>(operation: () => Promise<{ completed: Promise<T> }>): Promise<T> {
    this.cancelEditTimers();
    this.captureEditorSources();
    this.explicitRunCount += 1;
    if (this.documentValue) this.renderControls(this.documentValue.snapshot);
    const pending = this.action(async () => {
      await this.output.flush();
      return operation();
    });
    // Lock source controls only through preparation and dispatch. Execution can
    // stay pending while the user edits or saves; Stop remains available for it.
    this.renderAllCellActions();
    try {
      const { completed } = await pending;
      return await completed;
    } finally {
      this.explicitRunCount -= 1;
      if (this.documentValue) {
        this.renderControls(this.documentValue.snapshot);
        this.renderAllCellActions();
      }
    }
  }

  setTransportState(state: "connecting" | "open" | "recovering" | "closed", error?: Error): void {
    if (this.hostClosed) return;
    this.transportState = state;
    this.transportError = state === "closed" && error ? error.message : state === "open" ? null : state === "connecting" ? (this.documentValue ? "Reconnecting…" : "Opening notebook…") : "Reconnecting…";
    this.renderStatus();
  }

  render(
    notebook: BrowserDocument,
    event?: HostEvent,
    localCellKeys?: readonly string[],
  ): void {
    this.documentValue = notebook;
    const snapshot = notebook.snapshot;
    if (event?.type === "operation" && isOperationRecord(event.payload)) this.renderPackageProgress(event.payload);
    if (event?.type === "service-errors" && snapshot.serviceErrors.lsp === undefined) {
      this.editorHelpError = null;
    }
    if (this.configValue !== snapshot.config) {
      const previousPageSize = this.configValue === null ? null : configNumber(this.configValue, ["table", "page_size"], 25);
      const autosaveChanged = this.configValue !== null && this.configValue.autosave !== snapshot.config.autosave;
      this.configValue = snapshot.config;
      this.applyConfig(snapshot.config);
      if (autosaveChanged) this.scheduleAutosave();
      const pageSize = configNumber(snapshot.config, ["table", "page_size"], 25);
      if (previousPageSize !== null && previousPageSize !== pageSize) {
        void this.repaginateTables(pageSize).catch(error => this.showError(error));
      }
    }
    const targetId = event && ['cell', 'cell-started', 'cell-output', 'cell-completed', 'diagnostics'].includes(event.type)
      ? event.cellId : undefined;
    const target = targetId ? notebook.cell(targetId) : undefined;
    const deleted = event?.type === 'cell' && isObject(event.payload) && event.payload.deleted === true;
    const reconcileNotebook = (event?.type === 'notebook' || event?.type === 'transaction')
      && notebookRequiresCellReconcile(event.payload, event.type === 'notebook');
    // notebook events create/order views, so execution must not scan every view.
    const canTarget = target !== undefined && this.views.has(target.key) && !deleted;
    const localTargets = event === undefined && localCellKeys !== undefined
      ? [...new Set(localCellKeys)].map((key) => notebook.cell(key))
      : [];
    const transactionTargets = event?.type === 'transaction' && !reconcileNotebook && isObject(event.payload) && Array.isArray(event.payload.updated)
      ? event.payload.updated.flatMap((value) => isObject(value) && typeof value.id === 'string' ? [notebook.cell(value.id)] : []).filter((cell): cell is LocalCell => cell !== undefined)
      : [];
    const canTargetTransaction = transactionTargets.length > 0
      && transactionTargets.every((cell) => this.views.has(cell.key));
    const canTargetLocal = event === undefined && localCellKeys !== undefined
      && localTargets.every((cell) => cell !== undefined && this.views.has(cell.key));
    if (canTargetLocal) {
      for (const cell of localTargets) {
        if (cell !== undefined) this.renderCell(cell, notebook.cells.indexOf(cell), snapshot);
      }
    } else if (canTarget) {
      this.renderCell(target, notebook.cells.indexOf(target), snapshot, event);
    } else if (canTargetTransaction) {
      for (const cell of transactionTargets) this.renderCell(cell, notebook.cells.indexOf(cell), snapshot, event);
      const orderChanged = notebook.cells.length !== this.renderedOrder.length
        || notebook.cells.some((cell, index) => cell.key !== this.renderedOrder[index]);
      if (orderChanged) {
        this.reconcileOrder(notebook.cells);
        this.renderedOrder = notebook.cells.map((cell) => cell.key);
      }
    } else if (!event || event.type === 'cell' || event.type === 'transaction' || reconcileNotebook) {
      const retained = new Set<string>();
      notebook.cells.forEach((cell, index) => {
        retained.add(cell.key);
        this.renderCell(cell, index, snapshot, event);
      });
      for (const [key, view] of this.views) {
        if (retained.has(key)) continue;
        this.destroyCell(key, view);
      }
      this.reconcileOrder(notebook.cells);
      this.renderedOrder = notebook.cells.map((cell) => cell.key);
      this.renderEmpty(notebook.cells.length === 0);
    }
    this.renderControls(snapshot);
    if (event?.type === "runtime") this.renderAllCellActions();
    this.renderEditorDiagnostics(snapshot);
    // Local editor input changes only desired source. Dataflow is authoritative
    // server state and will be refreshed by the causally identified host cell
    // event, so avoid serializing the whole graph on every keystroke.
    if (!canTargetLocal) this.renderDataflow(snapshot, event);
    this.renderStatus();
    if (event?.type === "cell-completed" && target?.server) {
      const label = cellName(target.server) || `Cell ${notebook.cells.indexOf(target) + 1}`;
      this.announce(target.server.status === "error" ? `${label} failed.` : `${label} completed.`);
    }
    if (event) {
      window.dispatchEvent(new CustomEvent<HostEvent>("alder:host-event", { detail: event }));
    }
  }

  destroy(): void {
    this.recoveryUnsubscribe?.();
    this.recoveryUnsubscribe = null;
    for (const timer of this.editTimers.values()) window.clearTimeout(timer);
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    for (const request of this.lspRequests.values()) request.abort();
    this.lspRequests.clear();
    for (const [key, view] of this.views) this.destroyCell(key, view);
    this.views.clear();
    this.observer?.disconnect();
    window.removeEventListener("resize", this.resizeHandler);
    this.dom.removeEventListener("mousedown", this.preserveRunFocus);
    this.setInspectorModal(false);
    this.cancelVariablesProjection();
  }

  showError(error: unknown): void {
    if (isObject(error) && error.code === "interrupted") {
      this.actionError = null;
      this.actionNotice = "Stopped.";
      this.renderStatus();
      return;
    }
    this.actionNotice = null;
    this.actionError = error instanceof Error ? error.message : String(error);
    this.renderStatus();
  }

  private createCell(cell: LocalCell): CellView {
    const template = this.dom.getElementById("cell-tpl") as HTMLTemplateElement | null;
    const element = template?.content.firstElementChild?.cloneNode(true) as HTMLElement | null;
    if (!element) throw new Error("Alder page is missing the canonical #cell-tpl template");
    if (this.appView) element.querySelectorAll<HTMLElement>("[data-editor-only]").forEach((node) => node.remove());
    const view: CellView = {
      element,
      editor: null,
      fallback: null,
      language: cell.desiredType === "markdown" ? "markdown" : "r",
      keymap: this.keymap(),
      diagnosticsVisibleAt: 0,
      diagnosticsTimer: null,
      rendered: null,
    };
    this.views.set(cell.key, view);
    this.keyByElement.set(element, cell.key);
    this.bindCell(view, cell.key);
    this.notebook.appendChild(element);
    this.observer?.observe(element);
    return view;
  }

  private renderCell(cell: LocalCell, index: number, snapshot: HostSnapshot, event?: HostEvent): void {
    const view = this.views.get(cell.key) ?? this.createCell(cell);
    this.stampOutputEvent(view.element, cell, event);
    if (!this.cellNeedsRender(view, cell, snapshot, index)) return;
    const editorProjection = JSON.stringify({
      refs: cell.server?.refs ?? [],
      diagnostics: this.visibleDiagnostics(cell.server?.diagnostics ?? [], cell),
    });
    const refreshEditor = view.rendered === null || view.rendered.desiredBody !== cell.desiredBody ||
      view.rendered.desiredType !== cell.desiredType || view.rendered.id !== cell.id ||
      view.rendered.config !== snapshot.config || view.rendered.editorProjection !== editorProjection;
    this.updateCell(view, cell, refreshEditor);
    view.rendered = {
      desiredBody: cell.desiredBody, desiredType: cell.desiredType, server: cell.server,
      id: cell.id, revision: cell.serverRevision, conflict: cell.conflict,
      tombstone: cell.tombstone, index, cellCount: this.documentValue?.cells.length ?? 0,
      config: snapshot.config, editorProjection,
    };
  }

  private bindCell(view: CellView, key: string): void {
    view.element.addEventListener("focusin", () => {
      const previous = this.documentValue?.focusedKey;
      if (previous && previous !== key) this.captureSelection(previous);
      this.documentValue?.focus(key);
      const cell = this.documentValue?.cell(key);
      if (cell) this.renderCellActions(view.element, cell);
      this.dependenciesSignature = "";
      if (this.documentValue && this.panelActive("dependencies")) {
        this.renderDependenciesProjection(this.documentValue.snapshot);
      }
    });
    view.element.querySelector<HTMLSelectElement>("[data-role=type]")?.addEventListener("change", (event) => {
      const type = (event.currentTarget as HTMLSelectElement).value === "markdown" ? "markdown" : "code";
      const text = this.sourceText(key);
      this.deferDiagnostics(key);
      this.client.editCell(key, text, type);
      this.scheduleEdit(key);
    });
    for (const button of Array.from(view.element.querySelectorAll<HTMLButtonElement>("button[data-act]"))) {
      button.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        button.closest<HTMLDetailsElement>("details.cell-overflow")?.removeAttribute("open");
        void this.cellAction(key, button, event).catch((error) => this.showError(error));
      });
    }
  }

  private cellNeedsRender(view: CellView, cell: LocalCell, snapshot: HostSnapshot, index: number): boolean {
    const prior = view.rendered;
    return prior === null || prior.desiredBody !== cell.desiredBody || prior.desiredType !== cell.desiredType ||
      prior.server !== cell.server || prior.id !== cell.id || prior.revision !== cell.serverRevision ||
      prior.conflict !== cell.conflict || prior.tombstone !== cell.tombstone || prior.index !== index ||
      prior.cellCount !== this.documentValue?.cells.length || prior.config !== snapshot.config;
  }

  private async cellAction(key: string, button: HTMLButtonElement, input: MouseEvent): Promise<void> {
    const action = button.dataset.act;
    if (action === "add") {
      this.addCell(key, button.dataset.type === "markdown" ? "markdown" : "code");
      return;
    }
    if (action === "run") {
      await this.runExplicit(async () => {
        if (this.requireCell(key).tombstone) {
          throw new Error("Restore this deleted cell as a new cell before running it");
        }
        return this.client.startRunCell(key, input);
      });
      this.scheduleAutosave();
      return;
    }
    await this.action(async () => {
      if (action === "delete") {
        const cells = [...this.requireDocument().cells];
        const index = cells.findIndex(cell => cell.key === key);
        const cell = this.requireCell(key);
        const deleted = { index, type: cell.desiredType, body: [...cell.desiredBody] };
        this.cancelEditTimer(key);
        await this.client.deleteCell(key);
        if (this.deletedCell) window.clearTimeout(this.deletedCell.timer);
        const timer = window.setTimeout(() => { this.deletedCell = null; this.actionNotice = null; this.renderStatus(); }, 8_000);
        this.deletedCell = { ...deleted, timer };
        this.actionNotice = "Cell deleted.";
        this.scheduleAutosave();
      } else if (action === "disable") {
        await this.client.commitEdits();
        const cell = this.requireCell(key);
        await this.client.setDisabled(key, cell.server?.status !== "disabled");
        this.scheduleAutosave();
      } else if (action === "move-up" || action === "move-down") {
        await this.client.commitEdits();
        const cells = [...this.requireDocument().cells];
        const index = cells.findIndex((cell) => cell.key === key);
        if (action === "move-up" && index > 0) await this.client.moveCell(key, index === 1 ? null : cells[index - 2]!.key);
        if (action === "move-down" && index >= 0 && index < cells.length - 1) await this.client.moveCell(key, cells[index + 1]!.key);
        this.scheduleAutosave();
      } else if (action === "use-server") {
        const cell = this.requireCell(key);
        this.client.editCell(key, cell.serverBody, cell.serverType);
      }
    });
  }

  private addCell(after: string | null, type: "code" | "markdown"): void {
    const cell = this.client.createCell(after, type, type === "markdown" ? ["# "] : []);
    const focus = (): boolean => {
      const view = this.views.get(cell.key);
      if (view?.editor) { view.editor.focus(); return true; }
      if (view?.fallback) { view.fallback.focus(); return true; }
      return false;
    };
    if (!focus()) window.setTimeout(focus, 0);
    this.scheduleEdit(cell.key);
  }

  private updateCell(view: CellView, cell: LocalCell, refreshEditor: boolean): void {
    const server = cell.server;
    const status = cell.tombstone ? "error" : server?.status ?? (cell.conflict ? "error" : "idle");
    const element = view.element;
    element.dataset.key = cell.key;
    if (cell.id) element.dataset.cell = cell.id;
    else delete element.dataset.cell;
    element.dataset.revision = String(cell.serverRevision);
    element.id = `cell-${safePart(cell.id ?? cell.key)}`;
    element.className = `cell ${status}${cell.conflict ? " source-conflict" : ""}${cell.tombstone ? " tombstone" : ""}`;
    element.style.removeProperty("content-visibility");
    element.style.removeProperty("contain-intrinsic-block-size");
    const title = element.querySelector<HTMLElement>("[data-role=cell-title]");
    const cellIndex = this.documentValue?.cells.findIndex((candidate) => candidate.key === cell.key) ?? -1;
    if (title) {
      const label = cell.tombstone ? `Deleted cell · ${cellName(server) || cell.id}`
        : cell.id && server ? cellLabelAt(server, cellIndex) : "New cell";
      if (title.textContent !== label) title.textContent = label;
      title.title = cell.tombstone ? `Cell ${cell.id} was deleted on the server; this local draft is retained`
        : cell.id ? `Stable ID ${cell.id}` : "Waiting to be saved";
      title.id = `${element.id}-title`;
      element.setAttribute("aria-labelledby", title.id);
    }
    element.dataset.cellIndex = String(cellIndex + 1);
    element.dataset.cellName = cellName(server);
    const badge = element.querySelector<HTMLElement>("[data-role=badge]");
    if (badge) {
      const warning = !cell.tombstone && !cell.conflict && status === "done"
        && (server?.log.some((line) => /^Warning(?: message)?:/i.test(line)) ?? false);
      const label = cell.tombstone ? "deleted on server" : cell.conflict ? "source conflict" : warning ? "warning" : status;
      if (badge.textContent !== label) badge.textContent = label;
      badge.className = `cell-badge ${cell.conflict ? "error" : warning ? "warning" : status}`;
      badge.hidden = !cell.tombstone && !cell.conflict && !warning && (status === "idle" || status === "done");
      element.classList.toggle("warning", warning);
    }
    const type = element.querySelector<HTMLSelectElement>("[data-role=type]");
    if (type && this.dom.activeElement !== type) type.value = cell.desiredType;
    const sourceArea = element.querySelector<HTMLElement>("[data-role=source-area]");
    sourceArea?.classList.toggle("md-area", cell.desiredType === "markdown");
    sourceArea?.classList.toggle("code-area", cell.desiredType === "code");
    if (this.shouldMountEditor(cell, view)) {
      if (refreshEditor || (!view.editor && !view.fallback)) this.ensureEditor(view, cell);
    } else if (refreshEditor || view.editor || view.fallback) {
      this.unmountEditor(cell.key, view, cell);
    }
    const conflictChanged = !view.rendered || view.rendered.conflict !== cell.conflict || view.rendered.tombstone !== cell.tombstone;
    if (refreshEditor || conflictChanged) this.renderDiagnostics(
      element.querySelector<HTMLElement>("[data-role=diagnostics]"),
      this.visibleDiagnostics(server?.diagnostics ?? [], cell),
      cell,
    );
    const outputArea = this.outputArea(element);
    this.output.render(outputArea, server?.outputs ?? [], server?.progress ?? null);
    const displayOrder = server?.status === "error" ? [] : server?.displayOrder ?? [];
    this.renderOrderedOutput(outputArea, server?.outputs ?? [], displayOrder);
    const retainedOutput = server?.outputsStale === true && Boolean(server.outputs.length);
    outputArea.classList.toggle("retained-output", retainedOutput);
    let retainedLabel = outputArea.querySelector<HTMLElement>(":scope > .retained-output-label");
    if (retainedOutput && !retainedLabel) {
      retainedLabel = elementNode(this.dom, "div", "retained-output-label", "Previous output — updating");
      retainedLabel.setAttribute("role", "status");
      outputArea.prepend(retainedLabel);
    } else if (!retainedOutput) retainedLabel?.remove();
    if (retainedOutput && retainedLabel) retainedLabel.textContent = server?.status === "running"
      ? "Previous output — updating" : "Previous output — stale";
    outputArea.hidden = !this.appView && !server?.outputs.length && !server?.progress && !displayOrder.length;
    outputArea.dataset.cell = cell.id ?? "";
    outputArea.dataset.revision = String(cell.serverRevision);
    const outputRunId = server?.outputs.at(-1)?.runId;
    if (outputRunId) outputArea.dataset.runId = outputRunId;
    else delete outputArea.dataset.runId;
    this.renderLog(element.querySelector<HTMLElement>("[data-role=log]"),
      displayOrder.length ? [] : server?.log ?? [], displayOrder.length ? null : server?.error);
    this.renderCellActions(element, cell, status, undefined, true);
    if (conflictChanged) this.renderConflict(element, cell);
  }

  private stampOutputEvent(element: HTMLElement, cell: LocalCell, event?: HostEvent): void {
    if (!event || event.cellId !== cell.id || !["cell-output", "cell-completed", "cell-started"].includes(event.type)) return;
    const output = this.outputArea(element);
    output.dataset.eventCursor = String(event.cursor);
    if (event.runId) output.dataset.runId = event.runId;
    if (event.operationId) output.dataset.operationId = event.operationId;
    if (typeof event.revision === "number") output.dataset.revision = String(event.revision);
    if (typeof event.sequence === "number") output.dataset.sequence = String(event.sequence);
  }

  private renderCellActions(
    element: HTMLElement,
    cell: LocalCell,
    status = cell.server?.status ?? "idle",
    knownIndex?: number,
    refreshLabels = false,
  ): void {
    const buttons = element.querySelectorAll<HTMLButtonElement>("button[data-act]");
    const cells = this.documentValue?.cells ?? [];
    const index = knownIndex ?? cells.findIndex((item) => item.key === cell.key);
    buttons.forEach((button) => {
      if (button.dataset.act === "run") setDisabled(button, this.runPending || !this.executionAvailable() ||
        this.documentValue?.snapshot.runtime.busy === true);
      else if (button.dataset.act === "move-up") setDisabled(button, !cell.id || index <= 0);
      else if (button.dataset.act === "move-down") setDisabled(button, !cell.id || index < 0 || index >= cells.length - 1);
      else if (button.dataset.act === "disable") {
        setDisabled(button, !cell.id);
        const label = status === "disabled" ? "Enable" : "Disable";
        if (button.textContent !== label) button.textContent = label;
      } else if (button.dataset.act === "delete" || button.dataset.act === "add") setDisabled(button, false);
    });
    if (refreshLabels) {
      const title = element.querySelector<HTMLElement>("[data-role=cell-title]");
      const name = title?.textContent || `Cell ${index + 1}`;
      const position = index >= 0 ? `${name}, position ${index + 1} of ${cells.length}` : name;
      const reorderHelp = element.querySelector<HTMLElement>("[data-role=reorder-help]");
      if (reorderHelp) reorderHelp.id = `${element.id}-reorder-help`;
      element.querySelector<HTMLButtonElement>("[data-act=run]")?.setAttribute("aria-label", `Run ${position}`);
      element.querySelector<HTMLElement>("details.cell-overflow summary")?.setAttribute("aria-label", `Actions for ${position}`);
      element.querySelector<HTMLSelectElement>("[data-role=type]")?.setAttribute("aria-label", `Cell type for ${position}`);
      element.querySelector<HTMLButtonElement>("[data-act=disable]")?.setAttribute("aria-label", `${status === "disabled" ? "Enable" : "Disable"} ${position}`);
      element.querySelector<HTMLButtonElement>("[data-act=delete]")?.setAttribute("aria-label", `Delete ${position}`);
      element.querySelector<HTMLButtonElement>("[data-act=add]")?.setAttribute("aria-label", `Insert code cell after ${position}`);
      for (const direction of ["up", "down"] as const) {
        const button = element.querySelector<HTMLButtonElement>(`[data-act=move-${direction}]`);
        if (!button) continue;
        button.setAttribute("aria-label", `Move ${title?.textContent || "cell"} ${direction}`);
        if (reorderHelp) button.setAttribute("aria-describedby", reorderHelp.id);
      }
    }
    const drag = element.querySelector<HTMLElement>("[data-role=drag-handle]");
    if (drag) {
      const available = cell.id !== null && !cell.tombstone;
      drag.draggable = available;
      drag.classList.toggle("disabled", !available);
    }
  }

  private renderAllCellActions(): void {
    const runtime = this.documentValue?.snapshot.runtime;
    const signature = JSON.stringify({
      runBlocked: this.runPending || runtime?.busy === true ||
        runtime?.executionReady !== true || runtime?.kernelState !== "ready",
    });
    if (signature === this.cellActionsSignature) return;
    this.cellActionsSignature = signature;
    const document = this.documentValue;
    const cells = document?.cells ?? [];
    const keys = this.observer
      ? new Set([...this.visibleKeys, ...(document?.focusedKey ? [document.focusedKey] : [])])
      : null;
    cells.forEach((cell, index) => {
      if (keys && !keys.has(cell.key)) return;
      const view = this.views.get(cell.key);
      if (!view) return;
      const status = cell.tombstone ? "error" : cell.server?.status ?? (cell.conflict ? "error" : "idle");
      this.renderCellActions(view.element, cell, status, index);
    });
  }

  private ensureEditor(view: CellView, cell: LocalCell): void {
    if (this.appView) return;
    const source = view.element.querySelector<HTMLElement>("[data-role=source]");
    if (!source) return;
    const language = cell.desiredType === "markdown" ? "markdown" : "r";
    const keymap = this.keymap();
    if (view.editor && (view.language !== language || view.keymap !== keymap)) {
      this.captureSelection(cell.key);
      view.editor.destroy();
      this.editors.delete(cell.key);
      view.editor = null;
      source.replaceChildren();
    }
    const text = cell.desiredBody.join("\n");
    if (!view.editor && window.AlderEditor?.createEditor) {
      source.replaceChildren();
      view.editor = window.AlderEditor.createEditor({
        parent: source,
        doc: text,
        language,
        readOnly: false,
        keymap,
        completionsEnabled: this.preference("completions", true),
        signatureHelpEnabled: this.preference("signature_help", true),
        onChange: (next) => {
          this.deferDiagnostics(cell.key);
          this.client.editCell(cell.key, next);
          this.captureSelection(cell.key);
          this.scheduleEdit(cell.key);
        },
        onRun: (next) => {
          void this.runExplicit(async () => {
            if (this.requireCell(cell.key).tombstone) {
              throw new Error("Restore this deleted cell as a new cell before running it");
            }
            return this.client.startRunCell(cell.key);
          }).then(() => {
            this.scheduleAutosave();
            if (next) this.focusAdjacentCell(cell.key, 1);
          }).catch((error) => this.showError(error));
        },
        onSave: () => void this.action(() => this.saveNotebook()).catch((error) => this.showError(error)),
        onFormat: () => void this.action(() => this.formatCells([cell.key])).catch((error) => this.showFormatFailure(error, [cell.key])),
        onJump: (kind, value) => {
          if (kind === "move") {
            void this.action(() => this.moveCellBy(cell.key, value < 0 ? -1 : 1)).catch((error) => this.showError(error));
          } else if (kind === "reference") void this.jumpToDefinition(cell, view.editor, value);
        },
        onHover: (_editor, position) => this.lspHover(cell, view.editor, position),
        onSignature: (_editor, position, trigger) => this.lspSignature(cell, view.editor, position, trigger),
      });
      view.language = language;
      view.keymap = keymap;
      this.editors.set(cell.key, view.editor);
      view.editor.setCompletionSource?.(language === "r"
        ? (context) => this.lspCompletion(cell, view.editor, context)
        : null);
      if (cell.selection) {
        const selection = cell.selection;
        window.setTimeout(() => {
          view.editor?.view?.dispatch?.({ selection: { anchor: selection.anchor, head: selection.head } });
          if (selection.scrollTop !== undefined && view.editor?.view?.scrollDOM) {
            view.editor.view.scrollDOM.scrollTop = selection.scrollTop;
          }
          if (this.documentValue?.focusedKey === cell.key) view.editor?.focus();
        }, 0);
      }
    }
    if (!view.editor && !view.fallback) {
      source.replaceChildren();
      const fallback = this.dom.createElement("textarea");
      fallback.className = "source-fallback";
      fallback.value = text;
      fallback.setAttribute("aria-label", language === "r" ? "R source" : "Markdown source");
      fallback.addEventListener("input", () => {
        this.deferDiagnostics(cell.key);
        this.client.editCell(cell.key, fallback.value);
        this.scheduleEdit(cell.key);
      });
      source.appendChild(fallback);
      view.fallback = fallback;
      if (cell.selection) {
        fallback.setSelectionRange(cell.selection.anchor, cell.selection.head);
        fallback.scrollTop = cell.selection.scrollTop ?? 0;
      }
    }
    const focused = source.contains(this.dom.activeElement);
    if (view.editor && view.editor.getDoc() !== text) {
      const previous = view.editor.getDoc();
      const live = view.editor.view?.state?.selection?.main;
      const selection = remapEditorSelection(previous, text, live ?? cell.selection);
      const scrollTop = view.editor.view?.scrollDOM?.scrollTop ?? cell.selection?.scrollTop;
      view.editor.setDoc(text, { silent: true });
      if (selection && view.editor.view?.dispatch) {
        view.editor.view.dispatch({ selection });
        this.documentValue?.updateSelection(cell.key, { ...selection, scrollTop });
      }
      if (scrollTop !== undefined && view.editor.view?.scrollDOM) {
        view.editor.view.scrollDOM.scrollTop = scrollTop;
      }
      if (focused) view.editor.focus();
    }
    if (view.fallback && view.fallback.value !== text) {
      const backward = view.fallback.selectionDirection === "backward";
      const selection = remapEditorSelection(view.fallback.value, text, {
        anchor: backward ? view.fallback.selectionEnd : view.fallback.selectionStart,
        head: backward ? view.fallback.selectionStart : view.fallback.selectionEnd,
      });
      const scrollTop = view.fallback.scrollTop;
      view.fallback.value = text;
      if (selection) {
        view.fallback.setSelectionRange(
          Math.min(selection.anchor, selection.head),
          Math.max(selection.anchor, selection.head),
          selection.anchor <= selection.head ? "forward" : "backward",
        );
        this.documentValue?.updateSelection(cell.key, { ...selection, scrollTop });
      }
      view.fallback.scrollTop = scrollTop;
      if (focused) view.fallback.focus();
    }
    view.editor?.setCompletionsEnabled?.(this.preference("completions", true));
    view.editor?.setSignatureHelpEnabled?.(this.preference("signature_help", true));
    view.editor?.setReactiveRefs?.(reactiveReferenceRanges(cell, text, this.documentValue?.snapshot));
    view.editor?.setDiagnostics?.(diagnosticsForEditor(this.visibleDiagnostics(cell.server?.diagnostics ?? [], cell), text));
    view.element.style.removeProperty("min-height");
  }

  private shouldMountEditor(cell: LocalCell, view: CellView): boolean {
    if (this.appView) return false;
    if ((this.documentValue?.cells.length ?? 0) <= 40 || !this.observer) return true;
    return this.visibleKeys.has(cell.key) || this.documentValue?.focusedKey === cell.key || view.element.contains(this.dom.activeElement);
  }

  private unmountEditor(key: string, view: CellView, cell: LocalCell): void {
    if (this.appView) return;
    if (!view.editor && !view.fallback) {
      const source = view.element.querySelector<HTMLElement>("[data-role=source]");
      const placeholder = source?.querySelector<HTMLElement>("[data-virtual-source]");
      if (placeholder) placeholder.textContent = cell.desiredBody.join("\n");
      else if (source) this.installPlaceholder(source, key, view, cell);
      return;
    }
    if (this.documentValue?.focusedKey === key || view.element.contains(this.dom.activeElement)) return;
    this.captureSelection(key);
    const source = view.element.querySelector<HTMLElement>("[data-role=source]");
    const sourceBox = source?.getBoundingClientRect().height ?? 0;
    const sourceStyle = source && this.dom.defaultView?.getComputedStyle(source);
    const sourcePadding = sourceStyle
      ? (Number.parseFloat(sourceStyle.paddingTop) || 0) + (Number.parseFloat(sourceStyle.paddingBottom) || 0)
      : 0;
    const sourceHeight = Math.ceil(Math.max(0, sourceBox - sourcePadding));
    view.editor?.destroy();
    this.editors.delete(key);
    view.editor = null;
    view.fallback = null;
    if (source) this.installPlaceholder(source, key, view, cell, sourceHeight);
  }

  private installPlaceholder(source: HTMLElement, key: string, view: CellView, cell: LocalCell, measuredHeight = 0): void {
    const placeholder = element(this.dom, "pre", "source-placeholder", cell.desiredBody.join("\n"));
    if (measuredHeight > 0) placeholder.style.minHeight = `${measuredHeight}px`;
    placeholder.dataset.virtualSource = "true";
    placeholder.tabIndex = 0;
    placeholder.setAttribute("aria-label", `${cell.desiredType === "markdown" ? "Markdown" : "R"} source; focus to edit`);
    placeholder.addEventListener("focus", () => {
      this.visibleKeys.add(key);
      this.ensureEditor(view, cell);
      window.setTimeout(() => {
        if (view.editor) view.editor.focus();
        else view.fallback?.focus();
      }, 0);
    }, { once: true });
    source.replaceChildren(placeholder);
  }

  private visibilityChanged(entries: IntersectionObserverEntry[]): void {
    const document = this.documentValue;
    if (!document) return;
    for (const entry of entries) {
      const key = this.keyByElement.get(entry.target);
      const view = key ? this.views.get(key) : undefined;
      if (!key || !view) continue;
      const cell = document.cell(key);
      if (!cell) continue;
      if (entry.isIntersecting) {
        this.visibleKeys.add(key);
        this.ensureEditor(view, cell);
        this.renderCellActions(view.element, cell);
      } else {
        this.visibleKeys.delete(key);
        if (document.cells.length > 40) this.unmountEditor(key, view, cell);
      }
    }
  }

  private outputArea(cell: HTMLElement): HTMLElement {
    const output = cell.querySelector<HTMLElement>("[data-role=output]");
    if (!output) throw new Error("Canonical cell template is missing [data-role=output]");
    return output;
  }

  private visibleDiagnostics(diagnostics: readonly AnalysisDiagnostic[], cell?: LocalCell): AnalysisDiagnostic[] {
    if (cell && !this.diagnosticsReady(cell)) return [];
    if (this.preference("live_diagnostics", false)) return [...diagnostics];
    return diagnostics.filter((diagnostic) => (diagnostic as AnalysisDiagnostic & { source?: string }).source !== "lsp");
  }

  private diagnosticsReady(cell: LocalCell): boolean {
    const view = this.views.get(cell.key);
    return this.diagnosticSourceCurrent(cell) && Date.now() >= (view?.diagnosticsVisibleAt ?? 0);
  }

  private diagnosticSourceCurrent(cell: LocalCell): boolean {
    const server = cell.server;
    if (!server || cell.conflict || cell.tombstone || cell.generation !== cell.acknowledgedGeneration ||
      cell.serverRevision !== server.revision || cell.serverType !== server.type || cell.desiredType !== server.type) return false;
    const source = toLogicalCellBody(server.type, server.body).join("\n");
    if (cell.serverBody.join("\n") !== source || cell.desiredBody.join("\n") !== source) return false;
    const editor = this.editors.get(cell.key);
    return !editor || editor.getDoc() === source;
  }

  private deferDiagnostics(key: string): void {
    const view = this.views.get(key);
    if (!view) return;
    view.diagnosticsVisibleAt = Date.now() + 1_000;
    if (view.diagnosticsTimer !== null) window.clearTimeout(view.diagnosticsTimer);
    view.rendered = null;
    this.editorDiagnosticsValue = null;
    view.diagnosticsTimer = window.setTimeout(() => {
      view.diagnosticsTimer = null;
      if (this.views.get(key) !== view || !this.documentValue?.cell(key)) return;
      view.rendered = null;
      this.editorDiagnosticsValue = null;
      this.render(this.documentValue, undefined, [key]);
    }, 1_000);
  }

  private renderDiagnostics(area: HTMLElement | null, diagnostics: readonly AnalysisDiagnostic[], cell: LocalCell): void {
    if (!area) return;
    area.replaceChildren();
    if (cell.conflict && !cell.tombstone) area.appendChild(element(this.dom, "div", "diagnostic-error", "Source changed in another client. Review or use the server version."));
    const list = this.dom.createElement("ul");
    list.setAttribute("role", "status");
    list.setAttribute("aria-live", "polite");
    for (const diagnostic of diagnostics) {
      const item = this.dom.createElement("li");
      item.className = `diagnostic-${diagnostic.level ?? "error"}`;
      item.textContent = `${diagnostic.code || diagnostic.level || "error"}: ${diagnostic.message}`;
      list.appendChild(item);
    }
    area.appendChild(list);
    area.hidden = diagnostics.length === 0 && (!cell.conflict || cell.tombstone);
  }

  private renderOrderedOutput(
    area: HTMLElement,
    outputs: readonly OutputRecord[],
    order: NonNullable<HostCellState["displayOrder"]>,
  ): void {
    const ids = new Map(outputs.map((record, index) => [record.id, index]));
    const desired: HTMLElement[] = [];
    const used = new Set<HTMLElement>();
    order.forEach((part, index) => {
      if (part.kind === "output") {
        const outputIndex = ids.get(part.id);
        if (outputIndex === undefined) return;
        const slot = Array.from(area.children).find((child): child is HTMLElement =>
          (child as HTMLElement).dataset.recordKey === `output-${outputIndex}`);
        if (slot && !used.has(slot)) { desired.push(slot); used.add(slot); }
      } else {
        let slot = Array.from(area.children).find((child): child is HTMLElement =>
          child.classList.contains("ordered-log") &&
          (child as HTMLElement).dataset.timelineIndex === String(index));
        if (!slot) {
          slot = this.dom.createElement("div");
          slot.className = "ordered-log log-area";
          slot.dataset.timelineIndex = String(index);
        }
        const content = part.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        if (slot.textContent !== content) slot.textContent = content;
        desired.push(slot);
        used.add(slot);
      }
    });
    for (const child of Array.from(area.children)) {
      if (child.classList.contains("ordered-log") && !used.has(child as HTMLElement)) child.remove();
    }
    for (const child of Array.from(area.children)) {
      if (child.classList.contains("out-record") && !used.has(child as HTMLElement)) desired.push(child as HTMLElement);
    }
    const retainedLabel = area.querySelector<HTMLElement>(":scope > .retained-output-label");
    let cursor = retainedLabel?.nextElementSibling ?? area.firstElementChild;
    for (const slot of desired) {
      if (slot !== cursor) area.insertBefore(slot, cursor);
      cursor = slot.nextElementSibling;
    }
  }

  private renderLog(area: HTMLElement | null, logs: readonly string[], rawError: unknown): void {
    if (!area) return;
    if (!logs.length && !rawError && area.childElementCount === 0) {
      area.hidden = !this.appView;
      return;
    }
    area.replaceChildren();
    logs.forEach((line) => area.appendChild(element(this.dom, "div", /^Error\b/.test(line) ? "log-error" : "log-line", line)));
    if (isObject(rawError)) {
      const errorDetails = isObject(rawError.details) ? rawError.details : undefined;
      const condition = errorDetails && isObject(errorDetails.condition) ? errorDetails.condition : undefined;
      const jupyter = errorDetails && isObject(errorDetails.jupyter) ? errorDetails.jupyter : undefined;
      const classes = condition && Array.isArray(condition.class) ? condition.class.map(String) : [];
      const call = condition && typeof condition.call === "string" ? condition.call : "";
      const trace = condition && Array.isArray(condition.trace) ? condition.trace.map(String) : [];
      const jupyterName = jupyter && typeof jupyter.ename === "string" ? jupyter.ename : "";
      const jupyterValue = jupyter && typeof jupyter.evalue === "string" ? jupyter.evalue : "";
      const jupyterTrace = jupyter && Array.isArray(jupyter.traceback) ? jupyter.traceback.map(String) : [];
      if (call || trace.length || classes.length || jupyterName || jupyterValue || jupyterTrace.length) {
        const details = this.dom.createElement("details");
        details.className = "error-details";
        details.appendChild(element(this.dom, "summary", "", "Call and traceback"));
        details.appendChild(element(this.dom, "pre", "error-trace", [
          classes.length ? `Condition: ${classes.join(", ")}` : "",
          call ? `Call: ${call}` : "",
          trace.length ? `Traceback:\n${trace.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : "",
          jupyterName || jupyterValue ? `Jupyter: ${[jupyterName, jupyterValue].filter(Boolean).join(": ")}` : "",
          jupyterTrace.length ? `Jupyter traceback:\n${jupyterTrace.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : "",
        ].filter(Boolean).join("\n")));
        area.appendChild(details);
      }
    }
    area.hidden = !this.appView && area.childElementCount === 0;
  }

  private renderConflict(element: HTMLElement, cell: LocalCell): void {
    const actions = element.querySelector<HTMLElement>("[data-role=cell-actions]");
    actions?.querySelectorAll("[data-recovery]").forEach((node) => node.remove());
    element.querySelector("[data-tombstone-message]")?.remove();
    element.querySelector("[data-conflict-diff]")?.remove();
    actions?.querySelectorAll<HTMLElement>("[data-act]").forEach((node) => { node.hidden = cell.tombstone; });
    if (!actions) return;
    if (cell.tombstone) {
      const message = elementNode(this.dom, "div", "tombstone-message",
        "This cell was deleted in another client. Your local draft is still here. Restore it as a new cell or discard it.");
      message.dataset.tombstoneMessage = "true";
      message.setAttribute("role", "alert");
      const source = element.querySelector("[data-role=source-area]");
      element.insertBefore(message, source);

      const restore = elementNode(this.dom, "button", "btn mini", "Restore as new cell") as HTMLButtonElement;
      restore.type = "button";
      restore.dataset.recovery = "true";
      restore.dataset.recoveryAction = "restore-new";
      restore.addEventListener("click", () => {
        this.cancelEditTimer(cell.key);
        void this.action(async () => {
          await this.client.restoreDeletedCell(cell.key);
          this.scheduleAutosave();
        }).catch((error) => this.showError(error));
      });
      const discard = elementNode(this.dom, "button", "btn mini", "Discard local draft") as HTMLButtonElement;
      discard.type = "button";
      discard.dataset.recovery = "true";
      discard.dataset.recoveryAction = "discard-local";
      discard.addEventListener("click", () => {
        this.cancelEditTimer(cell.key);
        this.client.discardLocalCell(cell.key);
      });
      actions.append(restore, discard);
      return;
    }
    if (!cell.conflict) return;
    const diff = this.dom.createElement("details");
    diff.className = "source-conflict-diff";
    diff.dataset.conflictDiff = "true";
    diff.appendChild(elementNode(this.dom, "summary", "", "Compare incoming and my edits"));
    diff.appendChild(elementNode(this.dom, "pre", "", `Incoming\n${cell.serverBody.join("\n")}\n\nMy edits\n${cell.desiredBody.join("\n")}`));
    const source = element.querySelector("[data-role=source-area]");
    element.insertBefore(diff, source);
    const choice = (label: string, recoveryAction: string, run: () => void | Promise<unknown>): HTMLButtonElement => {
      const button = elementNode(this.dom, "button", "btn mini", label) as HTMLButtonElement;
      button.type = "button";
      button.dataset.recovery = "true";
      button.dataset.recoveryAction = recoveryAction;
      button.addEventListener("click", () => { void Promise.resolve(run()).catch(error => this.showError(error)); });
      return button;
    };
    actions.append(
      choice("Keep my edits", "keep-local", () => this.client.keepLocalVersion(cell.key)),
      choice("Use incoming", "use-incoming", () => this.client.useServerVersion(cell.key)),
      choice("Restore mine as new cell", "restore-new", () => this.client.restoreConflictAsNewCell(cell.key)),
    );
  }

  private reconcileOrder(cells: readonly LocalCell[]): void {
    let cursor = this.notebook.querySelector(":scope > .cell");
    for (const cell of cells) {
      const element = this.views.get(cell.key)?.element;
      if (!element) continue;
      if (cursor === element) cursor = element.nextElementSibling;
      else {
        this.notebook.insertBefore(element, cursor);
        cursor = element.nextElementSibling;
      }
    }
  }

  private renderEmpty(empty: boolean): void {
    if (!this.emptyBar) {
      const template = this.dom.getElementById("empty-bar") as HTMLTemplateElement | null;
      this.emptyBar = template?.content.firstElementChild?.cloneNode(true) as HTMLElement | null ?? element(this.dom, "div", "empty-bar");
      for (const button of Array.from(this.emptyBar.querySelectorAll<HTMLButtonElement>("button[data-act=add]"))) {
        button.addEventListener("click", () => this.addCell(null, button.dataset.type === "markdown" ? "markdown" : "code"));
      }
    }
    if (this.appView) this.emptyBar.remove();
    else if (!this.emptyBar.isConnected) this.notebook.appendChild(this.emptyBar);
    const message = this.emptyBar.querySelector<HTMLElement>(".empty-message");
    if (message) message.hidden = !empty;
  }

  private renderControls(snapshot: HostSnapshot): void {
    const busy = snapshot.runtime.busy;
    const dirty = snapshot.dirty || (this.documentValue?.pendingSource().changes.length ?? 0) > 0;
    const available = !this.hostClosed && snapshot.runtime.executionReady && snapshot.runtime.kernelState === "ready";
    const runnableOutdated = this.documentValue?.cells.some((cell) => cell.desiredType === "code"
      && !cell.tombstone && !cell.conflict
      && cell.server?.options.disabled !== true
      && cell.desiredBody.some((line) => line.trim().length > 0)
      && (cell.generation > cell.acknowledgedGeneration || cell.creationId !== null
        || cell.server?.status === "idle" || cell.server?.status === "stale"
        || cell.server?.status === "error" || cell.server?.status === "stopped")) === true;
    const signature = JSON.stringify({
      runPending: this.runPending,
      hostClosed: this.hostClosed,
      busy,
      available,
      executionMode: snapshot.runtime.executionMode,
      kernelReady: snapshot.runtime.kernelState === "ready",
      dirty,
      saveState: this.saveStateValue,
      path: snapshot.path,
      runnableOutdated,
    });
    if (signature === this.toolbarSignature) return;
    this.toolbarSignature = signature;
    const runtime = this.dom.getElementById("runtime-select") as HTMLSelectElement | null;
    if (runtime && this.dom.activeElement !== runtime && runtime.value !== snapshot.runtime.executionMode) runtime.value = snapshot.runtime.executionMode;
    if (runtime) setDisabled(runtime, this.hostClosed);
    const path = this.dom.getElementById("path");
    const notebookName = snapshot.path?.split(/[\\/]/).at(-1) ?? "Untitled";
    if (path) {
      path.textContent = notebookName;
      path.title = snapshot.path ?? "Untitled notebook";
      path.setAttribute("aria-label", snapshot.path ? `Notebook ${notebookName}; ${snapshot.path}` : "Untitled notebook");
    }
    this.dom.title = this.appView ? `${notebookName} — Preview — Alder` : `${notebookName} — Alder`;
    const saveState = this.dom.getElementById("save-state");
    if (saveState) saveState.textContent = dirty && this.saveStateValue === "saved" ? "Edited" : ({ edited: "Edited", saving: "Saving…", saved: "Saved", failed: "Save failed" } as const)[this.saveStateValue];
    const rState = this.dom.getElementById("r-state");
    if (rState) rState.textContent = snapshot.runtime.busy ? "R running" : available ? "R ready" : snapshot.runtime.kernelState === "starting" ? "R starting" : "R unavailable";
    const runAll = this.dom.getElementById("run-all") as HTMLButtonElement | null;
    if (runAll) {
      const label = snapshot.runtime.executionMode === "lazy" ? "Run outdated cells" : "Run All";
      if (runAll.textContent !== label) runAll.textContent = label;
      setDisabled(runAll, this.runPending || busy || !available
        || (snapshot.runtime.executionMode === "lazy" && !runnableOutdated));
    }
    const stop = this.dom.getElementById("stop") as HTMLButtonElement | null;
    if (stop) {
      stop.hidden = !(busy || this.runPending);
      setDisabled(stop, this.hostClosed || !(busy || this.runPending));
    }
    const restart = this.dom.getElementById("restart") as HTMLButtonElement | null;
    if (restart) {
      restart.hidden = snapshot.runtime.kernelState === "ready";
      setDisabled(restart, this.hostClosed || busy);
    }
    const save = this.dom.getElementById("save") as HTMLButtonElement | null;
    if (save) setDisabled(save, this.hostClosed || !dirty);
  }

  private renderDataflow(snapshot: HostSnapshot, event?: HostEvent): void {
    if (this.appView) return;
    if (!event || event.cellId) this.patchDataflowStatuses(snapshot, event?.cellId);
    if (event?.type === "notebook") {
      return;
    }
    if (event?.type === "variables") {
      this.variablesDirty = true;
      this.scheduleVariablesProjection();
      return;
    }
    if (event?.type === "runtime") {
      if (snapshot.runtime.busy) {
        this.cancelVariablesProjection(false);
        if (this.variablesDirty && this.panelActive("variables")) {
          this.dom.getElementById("panel-variables")?.setAttribute("aria-busy", "true");
        }
      } else if (this.variablesDirty) {
        this.scheduleVariablesProjection();
      }
      return;
    }
    if (event?.type === "cell" && event.cellId) {
      this.patchDataflowCellLabel(snapshot, event.cellId);
      this.renderOutlineProjection(snapshot, event.cellId);
      if (!this.dataflowCellChanged(snapshot, event.cellId)) return;
      this.variablesDirty = true;
      this.scheduleVariablesProjection();
      if (this.panelActive("dependencies")) this.renderDependenciesProjection(snapshot);
      return;
    }
    if (event && [
      "cell-started", "cell-output", "cell-completed", "diagnostics",
      "editor-diagnostics", "service-errors", "operation", "service-error", "active_clients_changed",
    ].includes(event.type)) return;
    if (!event) {
      this.captureDataflowCells(snapshot);
      this.renderVariablesProjection(snapshot);
      this.renderDependenciesProjection(snapshot);
      this.renderGraphProjection(snapshot);
      this.renderOutlineProjection(snapshot);
      return;
    }
    if (event.type === "graph") {
      this.variablesDirty = true;
      this.scheduleVariablesProjection();
    }
    if (this.panelActive("dependencies")) this.renderDependenciesProjection(snapshot);
    if (this.panelActive("graph")) this.renderGraphProjection(snapshot);
    if (this.panelActive("outline")) this.renderOutlineProjection(snapshot);
  }

  private panelActive(tab: DataflowPanelTab): boolean {
    return this.panelOpen && this.panelTab === tab;
  }

  private renderDependenciesProjection(snapshot: HostSnapshot): void {
    const focused = this.documentValue?.focusedKey;
    const focusedCell = focused ? this.documentValue?.cell(focused)?.server : snapshot.cells[0];
    const dependenciesSignature = JSON.stringify({
      graph: snapshot.graph,
      focused,
      cell: focusedCell ? {
        id: focusedCell.id, defs: focusedCell.defs, refs: focusedCell.refs,
        options: focusedCell.options,
      } : null,
      labels: snapshot.cells.map((cell) => ({ id: cell.id, name: cell.options.name, defs: cell.defs })),
    });
    if (dependenciesSignature !== this.dependenciesSignature) {
      this.dependenciesSignature = dependenciesSignature;
      this.renderDependencies(snapshot);
    }
  }

  private renderGraphProjection(snapshot: HostSnapshot): void {
    const signature = JSON.stringify({ graph: snapshot.graph, orientation: this.graphOrientation });
    if (signature === this.dataflowSignature) return;
    this.dataflowSignature = signature;
    this.renderGraph(snapshot);
    window.requestAnimationFrame(() => this.updateTopbarInset());
  }

  private renderOutlineProjection(snapshot: HostSnapshot, cellId?: string): void {
    if (cellId !== undefined) {
      const cell = snapshot.cells.find((candidate) => candidate.id === cellId);
      const signature = cell ? outlineCellSignature(cell) : "";
      if (this.outlineCells.get(cellId) === signature) return;
      if (cell) this.outlineCells.set(cellId, signature);
      else this.outlineCells.delete(cellId);
    } else {
      const signature = JSON.stringify(snapshot.cells.map((cell) => [cell.id, outlineCellSignature(cell)]));
      if (signature === this.outlineSignature) return;
      this.outlineSignature = signature;
      this.outlineCells.clear();
      for (const cell of snapshot.cells) this.outlineCells.set(cell.id, outlineCellSignature(cell));
    }
    this.renderOutline(snapshot);
  }

  private renderVariablesProjection(snapshot: HostSnapshot): void {
    const signature = JSON.stringify({
      variables: snapshot.variables,
      labels: snapshot.cells.map((cell) => ({ id: cell.id, name: cell.options.name })),
      filter: this.variableFilter,
    });
    this.variablesDirty = false;
    this.dom.getElementById("panel-variables")?.removeAttribute("aria-busy");
    if (signature !== this.variablesSignature) {
      this.variablesSignature = signature;
      this.renderVariables(snapshot);
    }
  }

  private scheduleVariablesProjection(): void {
    if (!this.variablesDirty || !this.panelActive("variables") || !this.documentValue
      || this.documentValue.snapshot.runtime.busy) return;
    this.cancelVariablesProjection(false);
    this.dom.getElementById("panel-variables")?.setAttribute("aria-busy", "true");
    // Let the rendered cell result and its assistive announcement reach a
    // paint before the optional environment sidebar reconciles a large list.
    this.variablesProjectionFrame = window.requestAnimationFrame(() => {
      this.variablesProjectionFrame = window.requestAnimationFrame(() => {
        this.variablesProjectionFrame = null;
        this.variablesProjectionTimer = window.setTimeout(() => {
          this.variablesProjectionTimer = null;
          const document = this.documentValue;
          if (!document || !this.panelActive("variables") || document.snapshot.runtime.busy) return;
          this.renderVariablesProjection(document.snapshot);
        }, 0);
      });
    });
  }

  private cancelVariablesProjection(clearBusy = true): void {
    if (this.variablesProjectionFrame !== null) window.cancelAnimationFrame(this.variablesProjectionFrame);
    if (this.variablesProjectionTimer !== null) window.clearTimeout(this.variablesProjectionTimer);
    this.variablesProjectionFrame = null;
    this.variablesProjectionTimer = null;
    if (clearBusy) this.dom.getElementById("panel-variables")?.removeAttribute("aria-busy");
  }

  private dataflowCellChanged(snapshot: HostSnapshot, id: string): boolean {
    const cell = snapshot.cells.find((candidate) => candidate.id === id);
    if (cell === undefined) {
      const existed = this.dataflowCells.delete(id);
      this.dataflowStatuses.delete(id);
      return existed;
    }
    const signature = dataflowCellSignature(cell);
    const changed = this.dataflowCells.get(id) !== signature;
    this.dataflowCells.set(id, signature);
    return changed;
  }

  private captureDataflowCells(snapshot: HostSnapshot): void {
    const retained = new Set(snapshot.cells.map((cell) => cell.id));
    for (const id of this.dataflowCells.keys()) {
      if (!retained.has(id)) this.dataflowCells.delete(id);
    }
    for (const cell of snapshot.cells) this.dataflowCells.set(cell.id, dataflowCellSignature(cell));
  }

  private patchDataflowStatuses(snapshot: HostSnapshot, cellId?: string): void {
    if (cellId === undefined) {
      const currentIds = new Set(snapshot.cells.map((cell) => cell.id));
      for (const id of this.dataflowStatuses.keys()) {
        if (!currentIds.has(id)) this.dataflowStatuses.delete(id);
      }
    }
    const targeted = cellId === undefined
      ? snapshot.cells
      : [this.documentValue?.cell(cellId)?.server ?? snapshot.cells.find((cell) => cell.id === cellId)].filter((cell): cell is HostSnapshot["cells"][number] => cell !== undefined && cell !== null);
    const cells = targeted.filter((cell) => this.dataflowStatuses.get(cell.id) !== cell.status);
    for (const cell of cells) {
      this.dataflowStatuses.set(cell.id, cell.status);
      const graph = this.graphNodes.get(cell.id);
      if (graph) {
        graph.setAttribute("class", `dag-node status-${cell.status}${snapshot.graph.cycles.includes(cell.id) ? " cycle" : ""}`);
        const status = graph.querySelector(".dag-node-status");
        if (status) status.textContent = cell.status;
      }
    }
  }

  private patchDataflowCellLabel(snapshot: HostSnapshot, cellId: string): void {
    const index = snapshot.cells.findIndex((candidate) => candidate.id === cellId);
    const cell = snapshot.cells[index];
    if (!cell) return;
    const label = cellLabelAt(cell, index);
    const graph = this.graphNodes.get(cellId);
    const graphLabel = graph?.querySelector("text:not(.dag-node-status)");
    if (graphLabel && graphLabel.textContent !== truncate(label, 18)) graphLabel.textContent = truncate(label, 18);
    const graphAria = `Go to ${label}${snapshot.graph.cycles.includes(cellId) ? "; dependency cycle" : ""}`;
    if (graph?.getAttribute("aria-label") !== graphAria) graph?.setAttribute("aria-label", graphAria);
  }

  private renderVariables(snapshot: HostSnapshot): void {
    const panel = this.dom.getElementById("panel-variables");
    if (!panel) return;
    let filter = panel.querySelector<HTMLInputElement>(".panel-filter");
    if (!filter) {
      filter = this.dom.createElement("input");
      filter.type = "search";
      filter.className = "panel-filter";
      filter.placeholder = "Filter variables";
      filter.setAttribute("aria-label", "Filter variables");
      filter.addEventListener("input", () => {
        this.variableFilter = filter!.value;
        this.variablesSignature = "";
        this.variablesDirty = true;
        this.scheduleVariablesProjection();
      });
      panel.appendChild(filter);
    }
    if (this.dom.activeElement !== filter) filter.value = this.variableFilter;
    let list = panel.querySelector<HTMLElement>(".variable-list");
    if (!list) {
      list = element(this.dom, "div", "variable-list");
      panel.appendChild(list);
    }
    const query = this.variableFilter.trim().toLocaleLowerCase();
    const variables = snapshot.variables
      .filter(({ name }) => !query || name.toLocaleLowerCase().includes(query));
    const labels = new Map(snapshot.cells.map((cell, index) => [cell.id, cellLabelAt(cell, index)]));
    const active = this.dom.activeElement;
    const activeNavigationKey = active instanceof Element && list.contains(active)
      ? active.closest<HTMLElement>("[data-navigation-key]")?.dataset.navigationKey
      : undefined;
    const retained = new Set<string>();
    const rows = variables.map((variable) => {
      const key = JSON.stringify([variable.name, variable.owner ?? ""]);
      retained.add(key);
      let row = this.variableRows.get(key);
      if (!row) {
        row = this.panelButton(variable.name, variable.owner ?? "", "variable-row", undefined, ["variable", variable.name]);
        this.variableRows.set(key, row);
      }
      const dimensions = variable.dim?.length ? variable.dim.join("×") : "";
      const ownerLabel = variable.owner ? labels.get(variable.owner) ?? variable.owner : "";
      const signature = JSON.stringify({
        name: variable.name,
        owner: variable.owner,
        class: variable.class,
        dimensions,
        size: variable.size,
        ownerLabel,
        valueSummary: variable.valueSummary,
        widget: variable.widget,
      });
      if (row.dataset.variableSignature !== signature) {
        row.dataset.variableSignature = signature;
        if (variable.owner) row.dataset.targetCell = variable.owner;
        else delete row.dataset.targetCell;
        row.disabled = !variable.owner;
        const title = element(this.dom, "span", "variable-name", variable.name);
        const meta = element(this.dom, "span", "variable-meta", [
          variable.class,
          dimensions,
          formatBytes(variable.size),
          ownerLabel,
        ].filter(Boolean).join(" · "));
        row.replaceChildren(title, meta);
        if (variable.valueSummary) row.appendChild(element(this.dom, "span", "variable-summary", variable.valueSummary));
        if (variable.widget) row.appendChild(element(this.dom, "span", "panel-tag", "widget"));
      }
      return row;
    });
    for (const [key, row] of this.variableRows) {
      if (retained.has(key)) continue;
      row.remove();
      this.variableRows.delete(key);
    }
    if (!rows.length) {
      const message = query ? "No variables match this filter." : "Run a cell to inspect its variables.";
      const empty = list.querySelector<HTMLElement>(":scope > .panel-empty");
      if (empty && list.childElementCount === 1) {
        if (empty.textContent !== message) empty.textContent = message;
      } else {
        list.replaceChildren(element(this.dom, "p", "panel-empty", message));
      }
      return;
    }
    rows.forEach((row, index) => {
      const current = list.children.item(index);
      if (current !== row) list.insertBefore(row, current);
    });
    while (list.childElementCount > rows.length) list.lastElementChild?.remove();
    const currentActive = this.dom.activeElement;
    if (activeNavigationKey && !(currentActive instanceof Element && list.contains(currentActive))) {
      Array.from(list.querySelectorAll<HTMLButtonElement>("[data-navigation-key]"))
        .find((row) => row.dataset.navigationKey === activeNavigationKey)
        ?.focus({ preventScroll: true });
    }
  }

  private renderEditorDiagnostics(snapshot: HostSnapshot): void {
    const section = this.dom.getElementById("editor-diagnostics");
    const area = this.dom.getElementById("editor-diagnostics-list");
    if (!section || !area) return;
    const visible = this.preference("live_diagnostics", false);
    const sourceCurrent = visible && (this.documentValue?.cells.every((cell) => this.diagnosticsReady(cell)) ?? false);
    if (this.editorDiagnosticsValue === snapshot.editorDiagnostics &&
      this.editorDiagnosticsVisible === visible &&
      this.editorDiagnosticsSourceCurrent === sourceCurrent) return;
    this.editorDiagnosticsValue = snapshot.editorDiagnostics;
    this.editorDiagnosticsVisible = visible;
    this.editorDiagnosticsSourceCurrent = sourceCurrent;
    const diagnostics = sourceCurrent ? this.visibleDiagnostics(snapshot.editorDiagnostics[".document"] ?? []) : [];
    const list = this.dom.createElement("ul");
    list.setAttribute("role", "status");
    list.setAttribute("aria-live", "polite");
    for (const diagnostic of diagnostics) {
      const item = this.dom.createElement("li");
      item.className = `diagnostic-${diagnostic.level ?? "error"}`;
      const level = diagnostic.level ?? "error";
      const label = `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
      item.textContent = `${label} · ${diagnostic.code || level}: ${diagnostic.message}`;
      list.appendChild(item);
    }
    area.replaceChildren(list);
    section.hidden = this.appView || diagnostics.length === 0;
  }

  private renderDependencies(snapshot: HostSnapshot): void {
    const panel = this.dom.getElementById("panel-dependencies");
    if (!panel) return;
    const focused = this.documentValue?.focusedKey;
    const cell = focused ? this.documentValue?.cell(focused)?.server : snapshot.cells[0];
    if (!cell) {
      this.replaceNavigationChildren(panel, [element(this.dom, "p", "panel-empty", "Focus a cell to inspect its dataflow.")]);
      return;
    }
    const owner = new Map<string, string>();
    const labels = new Map(snapshot.cells.map((candidate, index) => [candidate.id, cellLabelAt(candidate, index)]));
    snapshot.cells.forEach((candidate) => candidate.defs.forEach((name) => { if (!owner.has(name)) owner.set(name, candidate.id); }));
    const ancestors = reachableNodes(snapshot.graph.edges, cell.id);
    const descendants = reachableNodes(snapshot.graph.reverseEdges, cell.id);
    const title = element(this.dom, "div", "focused-cell", cellName(cell) || cell.id);
    title.dataset.navigationKey = JSON.stringify(["focused-cell", cell.id]);
    this.replaceNavigationChildren(panel, [
      title,
      this.dependencySection("References", cell.refs.map((name) => ({ id: owner.get(name) ?? null, label: owner.has(name) ? `${name} ← ${labels.get(owner.get(name)!) ?? owner.get(name)!}` : name })), "No direct references."),
      this.dependencySection("Definitions", cell.defs.map((name) => ({ id: cell.id, label: name })), "No definitions."),
      this.dependencySection("Ancestors", ancestors.map((id) => ({ id, label: labels.get(id) ?? id })), "No ancestors."),
      this.dependencySection("Descendants", descendants.map((id) => ({ id, label: labels.get(id) ?? id })), "No descendants."),
    ]);
  }

  private dependencySection(title: string, items: readonly { id: string | null; label: string }[], empty: string): HTMLElement {
    const section = element(this.dom, "section", "dependency-section");
    section.dataset.navigationKey = JSON.stringify(["dependency-section", title]);
    section.appendChild(element(this.dom, "h3", "", title));
    if (!items.length) section.appendChild(element(this.dom, "p", "panel-empty", empty));
    else {
      const list = element(this.dom, "div", "dependency-list");
      list.append(...items.map((item) => {
        if (item.id) return this.panelButton(item.label, item.id);
        const unresolved = element(this.dom, "button", "panel-link", item.label) as HTMLButtonElement;
        unresolved.type = "button";
        unresolved.disabled = true;
        unresolved.title = "No defining cell is available";
        return unresolved;
      }));
      section.appendChild(list);
    }
    return section;
  }

  private renderGraph(snapshot: HostSnapshot): void {
    const panel = this.dom.getElementById("panel-graph");
    if (!panel) return;
    this.graphNodes.clear();
    const nodes = snapshot.graph.nodes;
    const labels = new Map(snapshot.cells.map((cell, index) => [cell.id, cellLabelAt(cell, index)]));
    const toolbar = element(this.dom, "div", "graph-toolbar");
    toolbar.appendChild(element(this.dom, "span", "graph-direction-note", this.graphOrientation === "vertical" ? "Dependencies flow down" : "Dependencies flow right"));
    const direction = this.graphButton(this.graphOrientation === "vertical" ? "Horizontal" : "Vertical", "orientation", () => {
      this.graphOrientation = this.graphOrientation === "vertical" ? "horizontal" : "vertical";
      this.dataflowSignature = "";
      this.renderGraphProjection(snapshot);
    }, this.graphOrientation === "vertical" ? "Switch to a left-to-right dependency layout" : "Switch to a top-to-bottom dependency layout");
    direction.dataset.graphOrientation = this.graphOrientation;
    const zoomOut = this.graphButton("−", "zoom-out", () => this.setGraphZoom(this.graphZoom - 0.2), "Zoom dependency graph out");
    const zoomIn = this.graphButton("+", "zoom-in", () => this.setGraphZoom(this.graphZoom + 0.2), "Zoom dependency graph in");
    const fit = this.graphButton("Fit", "fit", () => this.fitGraphCanvas(), "Fit the dependency graph in the viewport");
    const reset = this.graphButton("100%", "reset", () => this.setGraphZoom(1), "Reset dependency graph to readable size");
    const expand = this.graphButton(this.graphExpanded ? "Collapse" : "Expand", "expand", () => {
      this.graphExpanded = !this.graphExpanded;
      this.dom.getElementById("dataflow-panel")?.classList.toggle("graph-expanded", this.graphExpanded);
      this.renderGraph(snapshot);
    }, this.graphExpanded ? "Collapse the dependency graph panel" : "Expand the dependency graph panel");
    expand.setAttribute("aria-pressed", String(this.graphExpanded));
    const zoomStatus = element(this.dom, "span", "graph-zoom-status", `${Math.round(this.graphZoom * 100)}%`);
    zoomStatus.dataset.navigationKey = "graph-zoom-status";
    zoomStatus.dataset.graphZoomStatus = "true";
    zoomStatus.setAttribute("role", "status");
    zoomStatus.setAttribute("aria-live", "polite");
    toolbar.dataset.navigationKey = "graph-toolbar";
    toolbar.append(direction, zoomOut, zoomIn, fit, reset, expand, zoomStatus);
    if (!nodes.length) {
      this.replaceNavigationChildren(panel, [toolbar, element(this.dom, "p", "panel-empty", "No dependency graph is available.")]);
      return;
    }
    const ranks = dependencyLevels(snapshot.graph.edges, nodes)
      ?? new Map(nodes.map((id) => [id, 0]));
    const grouped = new Map<number, string[]>();
    nodes.forEach((id) => {
      const rank = ranks.get(id) ?? 0;
      const peers = grouped.get(rank) ?? [];
      peers.push(id);
      grouped.set(rank, peers);
    });
    const rankList = [...grouped.keys()].sort((a, b) => a - b);
    const nodeWidth = 150;
    const width = this.graphOrientation === "vertical" ? Math.max(180, Math.max(...rankList.map((rank) => grouped.get(rank)!.length)) * 180) : Math.max(220, rankList.length * 190);
    const height = this.graphOrientation === "vertical" ? Math.max(100, rankList.length * 90) : Math.max(100, Math.max(...rankList.map((rank) => grouped.get(rank)!.length)) * 80);
    const positions = new Map<string, { x: number; y: number }>();
    rankList.forEach((rank, rankIndex) => grouped.get(rank)!.forEach((id, index, peers) => {
      positions.set(id, this.graphOrientation === "vertical"
        ? { x: (width - peers.length * 180) / 2 + index * 180 + 15, y: rankIndex * 90 + 15 }
        : { x: rankIndex * 190 + 10, y: index * 80 + 15 });
    }));
    const svg = svgNode(this.dom, "svg", { class: "dag-graph", viewBox: `0 0 ${width} ${height}`, width: String(width * this.graphZoom), height: String(height * this.graphZoom), role: "img", "data-orientation": this.graphOrientation, "aria-label": "Notebook dependency graph. Arrows point from source cells to dependent cells." });
    svg.dataset.navigationKey = "dag-graph";
    svg.dataset.intrinsicWidth = String(width);
    svg.dataset.intrinsicHeight = String(height);
    svg.appendChild(svgNode(this.dom, "title", {}, "Notebook dependency graph"));
    const definitions = svgNode(this.dom, "defs", {});
    const arrow = svgNode(this.dom, "marker", { id: "dag-arrowhead", markerWidth: "8", markerHeight: "8", refX: "7", refY: "4", orient: "auto", markerUnits: "strokeWidth" });
    arrow.appendChild(svgNode(this.dom, "path", { class: "dag-arrowhead", d: "M 0 0 L 8 4 L 0 8 z" }));
    definitions.appendChild(arrow);
    svg.appendChild(definitions);
    const cycleNodes = new Set(snapshot.graph.cycles);
    for (const [dependent, dependencies] of Object.entries(snapshot.graph.edges)) {
      const to = positions.get(dependent);
      if (!to) continue;
      for (const dependency of dependencies) {
        const from = positions.get(dependency);
        if (!from) continue;
        const path = this.graphOrientation === "vertical"
          ? `M ${from.x + nodeWidth / 2} ${from.y + 45} L ${to.x + nodeWidth / 2} ${to.y}`
          : `M ${from.x + nodeWidth} ${from.y + 22} L ${to.x} ${to.y + 22}`;
        svg.appendChild(svgNode(this.dom, "path", {
          d: path,
          class: cycleNodes.has(dependency) && cycleNodes.has(dependent) ? "dag-edge cycle" : "dag-edge",
          "data-from": dependency,
          "data-to": dependent,
          "marker-end": "url(#dag-arrowhead)",
        }));
      }
    }
    for (const id of nodes) {
      const position = positions.get(id)!;
      const cell = snapshot.cells.find((candidate) => candidate.id === id);
      const label = labels.get(id) ?? id;
      const group = svgNode(this.dom, "g", { class: `dag-node status-${cell?.status ?? "idle"}${cycleNodes.has(id) ? " cycle" : ""}`, role: "button", tabindex: "0", "data-target-cell": id, "data-rank": String(ranks.get(id) ?? 0), "data-navigation-key": JSON.stringify(["graph-node", id]), "aria-label": `Go to ${label}${cycleNodes.has(id) ? "; dependency cycle" : ""}` });
      group.append(svgNode(this.dom, "rect", { x: position.x, y: position.y, width: String(nodeWidth), height: "45", rx: "5" }),
        svgNode(this.dom, "text", { x: position.x + 8, y: position.y + 18 }, truncate(label, 18)),
        svgNode(this.dom, "text", { class: "dag-node-status", x: position.x + 8, y: position.y + 35 }, cell?.status ?? "idle"));
      svg.appendChild(group);
      this.graphNodes.set(id, group);
    }
    const scroll = element(this.dom, "div", "graph-scroll");
    scroll.dataset.navigationKey = "graph-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "Scrollable dependency graph canvas");
    scroll.appendChild(svg);
    const children: HTMLElement[] = [toolbar];
    if (cycleNodes.size) {
      const warning = element(this.dom, "p", "panel-empty error", `Dependency cycle: ${[...cycleNodes].map((id) => labels.get(id) ?? id).join(", ")}`);
      warning.setAttribute("role", "alert");
      children.push(warning);
    }
    children.push(scroll);
    this.replaceNavigationChildren(panel, children);
  }

  private renderOutline(snapshot: HostSnapshot): void {
    const panel = this.dom.getElementById("panel-outline");
    if (!panel) return;
    const currentList = panel.querySelector<HTMLElement>(":scope > .outline-list");
    const list = currentList ?? element(this.dom, "nav", "outline-list");
    list.setAttribute("aria-label", "Notebook outline");
    const currentButtons = new Map(Array.from(
      list.querySelectorAll<HTMLButtonElement>(":scope > .panel-link[data-navigation-key]"),
    ).map((button) => [button.dataset.navigationKey!, button]));
    const buttons: HTMLButtonElement[] = [];
    const retain = (next: HTMLButtonElement): void => {
      const key = next.dataset.navigationKey!;
      const button = currentButtons.get(key) ?? next;
      if (button !== next) {
        button.className = next.className;
        button.textContent = next.textContent;
        button.dataset.targetCell = next.dataset.targetCell!;
        if (next.dataset.targetLine === undefined) delete button.dataset.targetLine;
        else button.dataset.targetLine = next.dataset.targetLine;
        button.style.cssText = next.style.cssText;
      }
      buttons.push(button);
    };
    for (const cell of snapshot.cells) {
      const name = cellName(cell);
      if (name) retain(this.panelButton(name, cell.id, "outline-cell", undefined, ["outline-cell", cell.id]));
      if (cell.type === "markdown") {
        markdownHeadings(toLogicalCellBody(cell.type, cell.body)).forEach((heading) => {
          const button = this.panelButton(heading.text, cell.id, "outline-heading", heading.line, ["outline-heading", cell.id, heading.line]);
          button.style.setProperty("--outline-level", String(heading.level - 1));
          retain(button);
        });
      }
    }
    list.dataset.navigationKey = "outline-list";
    if (!buttons.length) {
      this.replaceNavigationChildren(panel, [element(this.dom, "p", "panel-empty", "Name a cell or add a Markdown heading to build an outline.")]);
      return;
    }
    if (!currentList) panel.replaceChildren(list);
    const retainedButtons = new Set(buttons);
    const active = this.dom.activeElement;
    const activeButton = active instanceof HTMLButtonElement && list.contains(active) && retainedButtons.has(active)
      ? active
      : null;
    if (activeButton) {
      const activeIndex = buttons.indexOf(activeButton);
      for (const button of buttons.slice(0, activeIndex)) list.insertBefore(button, activeButton);
      for (const button of buttons.slice(activeIndex + 1).reverse()) {
        list.insertBefore(button, activeButton.nextSibling);
      }
    } else {
      buttons.forEach((button, index) => {
        const current = list.children.item(index);
        if (current !== button) list.insertBefore(button, current);
      });
    }
    for (const child of Array.from(list.children)) {
      if (!retainedButtons.has(child as HTMLButtonElement)) child.remove();
    }
  }

  private replaceNavigationChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
    const active = this.dom.activeElement;
    const key = active instanceof Element && parent.contains(active)
      ? active.closest<HTMLElement>("[data-navigation-key]")?.dataset.navigationKey
      : undefined;
    parent.replaceChildren(...children);
    if (!key) return;
    const replacement = Array.from(parent.querySelectorAll<HTMLElement>("[data-navigation-key]"))
      .find((candidate) => candidate.dataset.navigationKey === key);
    replacement?.focus({ preventScroll: true });
  }

  private panelButton(label: string, id: string, className = "", line?: number, key?: readonly unknown[]): HTMLButtonElement {
    const button = element(this.dom, "button", `panel-link ${className}`.trim(), label) as HTMLButtonElement;
    button.type = "button";
    button.dataset.targetCell = id;
    if (line !== undefined) button.dataset.targetLine = String(line);
    button.dataset.navigationKey = JSON.stringify(key ?? ["cell", id, line ?? null, className, label]);
    return button;
  }

  private graphButton(label: string, key: string, action: () => void, description: string): HTMLButtonElement {
    const button = element(this.dom, "button", "panel-secondary graph-control", label) as HTMLButtonElement;
    button.type = "button";
    button.dataset.graphAction = key;
    button.dataset.navigationKey = JSON.stringify(["graph-action", key]);
    button.title = description;
    button.setAttribute("aria-label", description);
    button.addEventListener("click", action);
    return button;
  }

  private setGraphZoom(value: number, fitted = false): void {
    this.graphZoom = Math.max(0.2, Math.min(2.5, value));
    const svg = this.dom.querySelector<SVGSVGElement>("#panel-graph .dag-graph");
    if (!svg) return;
    const box = svg.viewBox.baseVal;
    svg.setAttribute("width", String(Math.round(box.width * this.graphZoom)));
    svg.setAttribute("height", String(Math.round(box.height * this.graphZoom)));
    const status = this.dom.querySelector<HTMLElement>("#panel-graph .graph-zoom-status");
    if (status) status.textContent = `${Math.round(this.graphZoom * 100)}%${fitted ? " fit" : ""}`;
    const zoomOut = this.dom.querySelector<HTMLButtonElement>("#panel-graph [data-graph-action=zoom-out]");
    const zoomIn = this.dom.querySelector<HTMLButtonElement>("#panel-graph [data-graph-action=zoom-in]");
    const reset = this.dom.querySelector<HTMLButtonElement>("#panel-graph [data-graph-action=reset]");
    if (zoomOut) zoomOut.disabled = this.graphZoom <= 0.2;
    if (zoomIn) zoomIn.disabled = this.graphZoom >= 2.5;
    if (reset) reset.disabled = Math.abs(this.graphZoom - 1) < 0.001;
  }

  private fitGraphCanvas(): void {
    const scroller = this.dom.querySelector<HTMLElement>("#panel-graph .graph-scroll");
    const svg = scroller?.querySelector<SVGSVGElement>(".dag-graph");
    if (!scroller || !svg) return;
    const width = Number(svg.dataset.intrinsicWidth) || 1;
    const height = Number(svg.dataset.intrinsicHeight) || 1;
    this.setGraphZoom(Math.min(Math.max(1, scroller.clientWidth - 8) / width, Math.max(1, scroller.clientHeight - 8) / height), true);
    scroller.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  private navigateToCell(idOrKey: string, line?: number): void {
    const cell = this.documentValue?.cell(idOrKey);
    const view = cell ? this.views.get(cell.key) : undefined;
    if (!cell || !view) return;
    this.documentValue?.focus(cell.key);
    this.visibleKeys.add(cell.key);
    this.ensureEditor(view, cell);
    view.element.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => {
      if (line !== undefined) {
        const text = this.sourceText(cell.key);
        const offset = sourceOffset(text, line, 0);
        if (view.editor?.view?.dispatch) view.editor.view.dispatch({ selection: { anchor: offset, head: offset }, scrollIntoView: true });
        else if (view.fallback) {
          view.fallback.setSelectionRange(offset, offset);
          const lineHeight = Number.parseFloat(getComputedStyle(view.fallback).lineHeight) || 16;
          view.fallback.scrollTop = Math.max(0, line * lineHeight - view.fallback.clientHeight / 2);
        }
      }
      if (view.editor) view.editor.focus();
      else view.fallback?.focus();
    }, 0);
  }

  private focusAdjacentCell(key: string, offset: -1 | 1, createAtEnd = true): void {
    const cells = this.documentValue?.cells ?? [];
    const index = cells.findIndex((cell) => cell.key === key);
    const target = index < 0 ? undefined : cells[index + offset];
    if (target) this.navigateToCell(target.key);
    else if (offset > 0 && createAtEnd) this.addCell(key, "code");
  }

  private async moveCellBy(key: string, offset: -1 | 1): Promise<void> {
    await this.client.commitEdits();
    const cells = [...this.requireDocument().cells];
    const index = cells.findIndex((cell) => cell.key === key);
    if (index < 0) return;
    if (offset < 0 && index > 0) {
      await this.client.moveCell(key, index === 1 ? null : cells[index - 2]!.key);
    } else if (offset > 0 && index < cells.length - 1) {
      await this.client.moveCell(key, cells[index + 1]!.key);
    }
  }

  private jumpReactiveReference(cell: LocalCell, editor: EditorHandle | null, position: number): void {
    if (!cell.id || !editor) return;
    const name = sourceWordAt(editor.getDoc(), position);
    if (!name || !cell.server?.refs.includes(name)) return;
    const owner = this.documentValue?.snapshot.cells.find((candidate) =>
      candidate.id !== cell.id && candidate.defs.includes(name));
    if (owner) this.navigateToCell(owner.id);
  }

  private async jumpToDefinition(cell: LocalCell, editor: EditorHandle | null, position: number): Promise<void> {
    if (!cell.id || !editor) return;
    const source = this.sourceText(cell.key);
    try {
      const result = await this.lspRequest(`definition:${cell.key}`, "textDocument/definition", {
        position: editorPosition(editor, cell, position),
      });
      if (this.sourceText(cell.key) !== source) return;
      const location = Array.isArray(result) ? result[0] : result;
      const range = isObject(location) ? location.targetSelectionRange ?? location.range : null;
      const start = isObject(range) && isObject(range.start) ? range.start : null;
      if (start && typeof start.cell === "string" && typeof start.line === "number") {
        this.navigateToCell(start.cell, start.line);
        return;
      }
    } catch {
      // Reactive references remain useful when language assistance is unavailable.
    }
    this.jumpReactiveReference(cell, editor, position);
  }

  private bindNavigation(): void {
    for (const root of [this.dom.getElementById("dataflow-panel")]) {
      root?.addEventListener("click", (event) => {
        const target = (event.target as Element | null)?.closest("[data-target-cell]");
        const id = (target as HTMLElement | null)?.dataset.targetCell;
        const line = (target as HTMLElement | null)?.dataset.targetLine;
        if (id) this.navigateToCell(id, line === undefined ? undefined : Number(line));
      });
      root?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = (event.target as Element | null)?.closest("[data-target-cell]");
        if (!target) return;
        event.preventDefault();
        const id = (target as HTMLElement).dataset.targetCell;
        const line = (target as HTMLElement).dataset.targetLine;
        if (id) this.navigateToCell(id, line === undefined ? undefined : Number(line));
      });
    }
  }

  private bindDragAndDrop(): void {
    const clear = (): void => {
      for (const view of this.views.values()) view.element.classList.remove("drop-before", "drop-after", "dragging");
    };
    const cellElement = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(".cell[data-key]") : null;
    const placement = (target: HTMLElement, clientY: number): "before" | "after" => {
      const bounds = target.getBoundingClientRect();
      return clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    };
    this.notebook.addEventListener("dragstart", (event) => {
      const handle = event.target instanceof Element ? event.target.closest("[data-role=drag-handle]") : null;
      const target = cellElement(handle);
      const key = target?.dataset.key;
      const cell = key ? this.documentValue?.cell(key) : undefined;
      if (!target || !cell?.id || cell.tombstone) {
        event.preventDefault();
        return;
      }
      this.draggedKey = key!;
      target.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", cell.id);
      }
    });
    this.notebook.addEventListener("dragover", (event) => {
      if (!this.draggedKey) return;
      const target = cellElement(event.target);
      if (!target || target.dataset.key === this.draggedKey) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      clear();
      this.views.get(this.draggedKey)?.element.classList.add("dragging");
      target.classList.add(placement(target, event.clientY) === "before" ? "drop-before" : "drop-after");
    });
    this.notebook.addEventListener("drop", (event) => {
      const dragged = this.draggedKey;
      const target = cellElement(event.target);
      if (!dragged || !target || target.dataset.key === dragged) return;
      event.preventDefault();
      const cells = [...(this.documentValue?.cells ?? [])].filter((cell) => cell.key !== dragged);
      const targetIndex = cells.findIndex((cell) => cell.key === target.dataset.key);
      const insertion = targetIndex + (placement(target, event.clientY) === "after" ? 1 : 0);
      const predecessor = targetIndex < 0 || insertion === 0 ? null : cells[insertion - 1]?.key ?? null;
      this.draggedKey = null;
      clear();
      if (targetIndex >= 0) {
        void this.action(async () => {
          await this.client.commitEdits();
          await this.client.moveCell(dragged, predecessor);
          this.scheduleAutosave();
        }).catch((error) => this.showError(error));
      }
    });
    this.notebook.addEventListener("dragend", () => {
      this.draggedKey = null;
      clear();
    });
  }

  private bindServiceDialogs(): void {
    if (this.appView) return;
    const dialog = (id: string): HTMLDialogElement | null => this.dom.getElementById(id) as HTMLDialogElement | null;
    const close = (buttonId: string, dialogId: string): void => {
      this.dom.getElementById(buttonId)?.addEventListener("click", () => {
        const target = dialog(dialogId);
        if (target) this.closeDialog(target);
      });
    };
    close("format-close", "format-dialog");
    close("packages-close", "packages-dialog");
    close("shortcuts-close", "shortcuts-dialog");

    const formatStart = this.dom.getElementById("format-start") as HTMLButtonElement | null;
    const formatProgress = this.dom.getElementById("format-progress");
    const formatError = this.dom.getElementById("format-error");
    const formatReturn = this.dom.getElementById("format-return") as HTMLButtonElement | null;
    this.formatCancelButton = this.dom.getElementById("format-cancel") as HTMLButtonElement | null;
    formatReturn?.addEventListener("click", () => {
      const key = formatReturn.dataset.cellKey;
      const line = Number.parseInt(formatReturn.dataset.line ?? "", 10);
      const target = dialog("format-dialog");
      if (target) this.closeDialog(target);
      if (key) this.navigateToCell(key, Number.isSafeInteger(line) ? Math.max(0, line - 1) : undefined);
    });
    formatStart?.addEventListener("click", () => {
      if (formatStart.disabled) return;
      setDisabled(formatStart, true);
      if (formatProgress) formatProgress.textContent = "Formatting…";
      if (formatError) formatError.hidden = true;
      if (formatReturn) formatReturn.hidden = true;
      void this.action(() => this.formatCells()).then(() => {
        if (formatProgress) formatProgress.textContent = "Formatting complete.";
      }).catch((error) => {
        this.showFormatFailure(error);
      }).finally(() => setDisabled(formatStart, false));
    });
    this.formatCancelButton?.addEventListener("click", () => {
      const operationId = this.activeFormatOperationIds.values().next().value as string | undefined;
      if (operationId === undefined) return;
      void this.client.cancelOperation(operationId).catch((error) => this.showError(error));
    });

    const names = this.dom.getElementById("package-names") as HTMLInputElement | null;
    const status = this.dom.getElementById("package-status") as HTMLElement | null;
    this.packageCancelButton = this.dom.getElementById("packages-cancel") as HTMLButtonElement | null;
    const packages = (): string[] => Array.from(new Set((names?.value ?? "").split(/[\s,]+/).map((name) => name.trim()).filter(Boolean)));
    const updateStatus = (result: CommandResult | HostQueryResult, command?: PackageServiceCommand): void => {
      if (!status) return;
      const payload = operationPayload(result);
      const state = isObject(payload.status) ? payload.status : payload;
      const output = command === "packages.install" && isObject(payload.result) && typeof payload.result.output === "string"
        ? payload.result.output : "";
      status.textContent = packageStatusText(state, output);
    };
    const runPackage = async (command: PackageServiceCommand, payload: Record<string, unknown>): Promise<void> => {
      if (!status) return;
      const target: PackageOperationTarget = { command, operationId: null, status };
      this.packageOperations.add(target);
      try {
        const result = await this.runService(command, payload, (operationId) => {
          target.operationId = operationId;
          if (command === "packages.install") {
            this.activePackageInstallOperationId = operationId;
            if (this.packageCancelButton) this.packageCancelButton.disabled = false;
          }
          const current = this.documentValue?.snapshot.operations.find((candidate) => candidate.id === operationId);
          if (current) this.renderPackageProgress(current, target);
        });
        if (command === "packages.declare") updateStatus(await this.client.service("packages.status"), command);
        else updateStatus(result, command);
      } finally {
        if (command === "packages.install" && this.activePackageInstallOperationId === target.operationId) {
          this.activePackageInstallOperationId = null;
          if (this.packageCancelButton) this.packageCancelButton.disabled = true;
        }
        this.packageOperations.delete(target);
      }
    };
    const bindPackageAction = (id: string, run: () => Promise<void>): void => {
      const button = this.dom.getElementById(id) as HTMLButtonElement | null;
      button?.addEventListener("click", () => {
        if (button.disabled) return;
        setDisabled(button, true);
        void this.action(run).catch((error) => this.showError(error)).finally(() => setDisabled(button, false));
      });
    };
    bindPackageAction("packages-refresh", async () => updateStatus(await this.runService("packages.status", {})));
    bindPackageAction("packages-declare", async () => {
      const selected = packages();
      if (!selected.length) throw new Error("Enter one or more package names");
      await runPackage("packages.declare", { packages: selected });
    });
    bindPackageAction("packages-install", async () => runPackage("packages.install", { packages: packages() }));
    this.packageCancelButton?.addEventListener("click", () => {
      const operationId = this.activePackageInstallOperationId;
      if (operationId === null) return;
      void this.client.cancelOperation(operationId).catch((error) => this.showError(error));
    });

  }

  private async runService(command: "publish" | "check" | "packages.status" | "packages.declare" | "packages.install", payload: Record<string, unknown>, onAccepted?: (operationId: string) => void): Promise<CommandResult | HostQueryResult> {
    this.cancelEditTimers();
    await this.client.commitEdits();
    await this.output.flush();
    return this.client.service(command, payload, onAccepted);
  }

  private async formatCells(keys?: readonly string[]): Promise<CommandResult> {
    let acceptedOperationId: string | null = null;
    try {
      return await this.client.formatCells(keys, (operationId) => {
        acceptedOperationId = operationId;
        this.activeFormatOperationIds.add(operationId);
        if (this.formatCancelButton) this.formatCancelButton.disabled = false;
      });
    } finally {
      if (acceptedOperationId !== null) this.activeFormatOperationIds.delete(acceptedOperationId);
      if (this.formatCancelButton && this.activeFormatOperationIds.size === 0) this.formatCancelButton.disabled = true;
    }
  }

  private showFormatFailure(error: unknown, keys?: readonly string[]): void {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+$/u, "").slice(0, 4096);
    const reportedCell = message.match(/\bCell (\d+):/i);
    const reportedIndex = reportedCell === null ? -1 : Number.parseInt(reportedCell[1]!, 10) - 1;
    const key = keys?.length === 1 ? keys[0]
      : reportedIndex >= 0 ? this.documentValue?.cells[reportedIndex]?.key : undefined;
    const cell = key === undefined ? undefined : this.documentValue?.cell(key)?.server ?? undefined;
    const index = key === undefined ? -1 : (this.documentValue?.cells.findIndex((candidate) => candidate.key === key) ?? -1);
    const location = message.match(/(?:cell\.R|line)[: ]+(\d+)(?::(\d+))?/i);
    const prefix = cell === undefined || reportedCell !== null ? "" : `${cellLabelAt(cell, index)}: `;
    const progress = this.dom.getElementById("format-progress");
    if (progress) progress.textContent = "Formatting failed. Your source was not changed.";
    const detail = this.dom.getElementById("format-error");
    if (detail) {
      detail.textContent = prefix + message;
      detail.hidden = false;
    }
    const back = this.dom.getElementById("format-return") as HTMLButtonElement | null;
    if (back) {
      back.hidden = key === undefined;
      back.dataset.cellKey = key ?? "";
      back.dataset.line = location?.[1] ?? "";
      if (key !== undefined) back.textContent = location?.[1] ? `Return to Cell ${index + 1}, line ${location[1]}` : `Return to Cell ${index + 1}`;
    }
    this.openDialog("format-dialog");
  }

  private renderPackageProgress(operation: OperationRecord, target?: PackageOperationTarget): void {
    const candidate = target ?? [...this.packageOperations].find((entry) => entry.operationId === operation.id);
    if (!candidate || candidate.operationId !== operation.id) return;
    const progress = operation.progress;
    if (!progress) return;
    const text = progress.text && progress.text.length > 0 ? progress.text
      : progress.data === undefined ? packageProgressPhaseText(candidate.command, progress.phase) : packageProgressDataText(progress.data);
    if (text) candidate.status.textContent = text;
  }

  private async downloadServiceResult(result: CommandResult | HostQueryResult): Promise<void> {
    const descriptor = artifactHandleFromResult(result);
    if (descriptor === null) throw new Error("publish did not return an artifact handle");
    const scopedUrl = await this.client.resolveArtifact(descriptor);
    const response = await fetch(scopedUrl, { credentials: "omit" });
    if (!response.ok) throw new Error("published artifact download failed (" + response.status + ")");
    const bytes = await response.blob();
    const downloadUrl = URL.createObjectURL(bytes);
    try {
      const link = this.dom.createElement("a");
      link.href = downloadUrl;
      link.download = "notebook.html";
      link.rel = "noopener";
      link.click();
    } finally {
      globalThis.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    }
  }

  private applyConfig(config: Record<string, unknown>): void {
    const theme = ["light", "dark", "system"].includes(configString(config, ["theme"], "system"))
      ? configString(config, ["theme"], "system") : "system";
    const keymap = ["default", "vim"].includes(configString(config, ["keymap"], "default"))
      ? configString(config, ["keymap"], "default") : "default";
    this.dom.documentElement.dataset.theme = theme;
    this.dom.documentElement.dataset.keymap = keymap;
    this.dom.documentElement.style.setProperty("--alder-editor-font-size", `${boundedConfig(config, ["editor", "font_size"], 14, 10, 32)}px`);
    this.dom.documentElement.style.setProperty("--alder-editor-tab-size", String(boundedConfig(config, ["editor", "tab_size"], 2, 1, 8)));
    this.dom.body.classList.toggle("hide-line-numbers", nested(config, ["editor", "line_numbers"]) === false);
    const vim = this.dom.getElementById("vim-mode-indicator");
    if (vim) {
      vim.hidden = keymap !== "vim";
      vim.textContent = keymap === "vim" ? "Vim mode" : "";
    }
    const dialog = this.dom.getElementById("settings") as HTMLDialogElement | null;
    if (!dialog?.hasAttribute("open")) this.fillSettings(config);
  }

  private fillSettings(config: Record<string, unknown>): void {
    setSelect(this.dom, "settings-theme", configString(config, ["theme"], "system"), ["system", "light", "dark"]);
    setSelect(this.dom, "settings-keymap", configString(config, ["keymap"], "default"), ["default", "vim"]);
    setNumber(this.dom, "settings-font-size", boundedConfig(config, ["editor", "font_size"], 14, 10, 32));
    setNumber(this.dom, "settings-tab-size", boundedConfig(config, ["editor", "tab_size"], 2, 1, 8));
    setNumber(this.dom, "settings-table-page-size", boundedConfig(config, ["table", "page_size"], 25, 5, 200));
    setChecked(this.dom, "settings-line-numbers", nested(config, ["editor", "line_numbers"]) !== false);
    setChecked(this.dom, "settings-completions", nested(config, ["editor", "completions"]) !== false);
    setChecked(this.dom, "settings-signature-help", nested(config, ["editor", "signature_help"]) !== false);
    setChecked(this.dom, "settings-live-diagnostics", nested(config, ["editor", "live_diagnostics"]) === true);
    setChecked(this.dom, "settings-autosave", config.autosave === true);
    setChecked(this.dom, "settings-format-on-save", nested(config, ["format", "on_save"]) === true);
    setSelect(this.dom, "settings-execution-mode", this.documentValue?.snapshot.runtime.executionMode ?? "automatic", ["automatic", "lazy"]);
    setChecked(this.dom, "settings-run-on-startup", this.documentValue?.snapshot.runtime.runOnStartup ?? true);
    setChecked(this.dom, "settings-cache-enabled", nested(config, ["cache", "enabled"]) !== false);
    const directory = this.dom.getElementById("settings-cache-directory") as HTMLInputElement | null;
    if (directory) directory.value = configString(config, ["cache", "dir"], "");
    const selectedR = this.dom.getElementById("settings-selected-r") as HTMLInputElement | null;
    if (selectedR) selectedR.value = this.documentValue?.snapshot.runtime.rEnvironment?.rscript ?? "No R selected";
  }

  private settingsValues(): DialogSettings {
    const preferences: PreferencesPatch = {
      theme: inputValue(this.dom, "settings-theme", "system") as PreferencesPatch["theme"],
      keymap: inputValue(this.dom, "settings-keymap", "default") as PreferencesPatch["keymap"],
      autosave: inputChecked(this.dom, "settings-autosave"),
      format: { on_save: inputChecked(this.dom, "settings-format-on-save") },
      editor: {
        font_size: inputInteger(this.dom, "settings-font-size", 14, 10, 32),
        tab_size: inputInteger(this.dom, "settings-tab-size", 2, 1, 8),
        line_numbers: inputChecked(this.dom, "settings-line-numbers"),
        completions: inputChecked(this.dom, "settings-completions"),
        signature_help: inputChecked(this.dom, "settings-signature-help"),
        live_diagnostics: inputChecked(this.dom, "settings-live-diagnostics"),
      },
      table: { page_size: inputInteger(this.dom, "settings-table-page-size", 25, 5, 200) },
    };
    return {
      preferences,
      runtime: {
        executionMode: inputValue(this.dom, "settings-execution-mode", "automatic") === "lazy" ? "lazy" : "automatic",
        runOnStartup: inputChecked(this.dom, "settings-run-on-startup"),
        cacheEnabled: inputChecked(this.dom, "settings-cache-enabled"),
      },
      project: { cache: { dir: inputValue(this.dom, "settings-cache-directory", "").trim() || null } },
    };
  }

  private renderSettingsError(): void {
    const error = this.dom.getElementById("settings-error");
    if (!error) return;
    const message = this.settingsError ?? this.documentValue?.snapshot.serviceErrors.settings?.message ?? "";
    error.textContent = message;
    error.hidden = message.length === 0;
  }

  private openSettings(): void {
    const dialog = this.dom.getElementById("settings") as HTMLDialogElement | null;
    const snapshot = this.documentValue?.snapshot;
    if (!dialog || !snapshot) return;
    this.fillSettings(snapshot.config);
    this.settingsBaseline = { ...this.settingsValues(), preferencesVersion: snapshot.preferencesVersion ?? null,
      projectVersion: snapshot.sidecars.config.version, documentRevision: snapshot.documentRevision };
    this.settingsError = null;
    this.renderSettingsError();
    const body = this.dom.getElementById("settings-body");
    if (body) body.scrollTop = 0;
    this.openDialog("settings");
  }

  private bindSettings(): void {
    const dialog = this.dom.getElementById("settings") as HTMLDialogElement | null;
    const close = (): void => {
      if (dialog) this.closeDialog(dialog);
    };
    this.dom.getElementById("settings-open")?.addEventListener("click", () => this.openSettings());
    this.dom.getElementById("settings-close")?.addEventListener("click", close);
    this.dom.getElementById("settings-cancel")?.addEventListener("click", close);
    this.dom.getElementById("settings-choose-r")?.addEventListener("click", () => {
      const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
      void desktop?.chooseRscript().then(path => path ? this.client.selectR(path) : undefined).then(() => {
        if (this.documentValue) this.fillSettings(this.documentValue.snapshot.config);
      }).catch(error => this.showError(error));
    });
    this.dom.getElementById("settings-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const baseline = this.settingsBaseline;
      if (this.settingsSaving || !baseline) return;
      const values = this.settingsValues();
      const preferences = changedSettings(baseline.preferences, values.preferences) as PreferencesPatch;
      const runtime = changedSettings(baseline.runtime, values.runtime) as Partial<RuntimeSettings>;
      const project = changedSettings(baseline.project, values.project) as ProjectSettingsPatch;
      this.settingsSaving = true;
      const apply = this.dom.getElementById("settings-apply") as HTMLButtonElement | null;
      if (apply) setDisabled(apply, true);
      void this.action(async () => {
        if (Object.keys(preferences).length) {
          await this.client.setPreferences(preferences, baseline.preferencesVersion);
          baseline.preferences = values.preferences;
          baseline.preferencesVersion = this.documentValue?.snapshot.preferencesVersion ?? null;
        }
        if (Object.keys(runtime).length) {
          const result = await this.client.setRuntime(runtime, baseline.documentRevision);
          baseline.runtime = values.runtime;
          baseline.documentRevision = result.documentRevision;
          this.scheduleAutosave();
        }
        if (Object.keys(project).length) {
          const result = await this.client.setConfig(project, baseline.projectVersion, baseline.documentRevision);
          baseline.project = values.project;
          baseline.documentRevision = result.documentRevision;
          baseline.projectVersion = this.documentValue?.snapshot.sidecars.config.version ?? null;
        }
        this.settingsError = null;
        this.renderSettingsError();
        close();
      }).catch((error) => {
        this.settingsError = error instanceof Error ? error.message : String(error);
        this.renderSettingsError();
        this.showError(error);
      }).finally(() => {
        this.settingsSaving = false;
        if (apply) setDisabled(apply, false);
      });
    });
  }

  private async saveNotebook(mode: "explicit" | "autosave" = "explicit"): Promise<CommandResult | undefined> {
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
    if (mode === "autosave" && !this.documentValue?.snapshot.path) return undefined;
    const destination = !this.documentValue?.snapshot.path && desktop
      ? await desktop.chooseSavePath()
      : undefined;
    if (destination === null) return undefined;
    await this.flushEditorSources();
    let formatFailure: string | null = null;
    if (this.executionAvailable() && nested(this.documentValue?.snapshot.config, ["format", "on_save"]) === true) {
      try { await this.formatCells(); }
      catch (error) { formatFailure = error instanceof Error ? error.message : String(error); }
    }
    this.setSaveState("saving");
    try {
      const result = await (destination === undefined ? this.client.save() : this.client.saveAs(destination));
      this.setSaveState("saved");
      if (formatFailure !== null) this.actionNotice = "Saved; formatting failed: " + formatFailure;
      return result;
    } catch (error) {
      this.setSaveState("failed");
      throw error;
    }
  }

  private async saveRecoveryCopy(): Promise<void> {
    const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
    if (!desktop) throw new Error("Save a copy is available in the desktop app");
    const destination = await desktop.chooseSavePath();
    if (destination !== null) await this.client.saveAs(destination);
  }

  async saveForDesktop(): Promise<"saved" | "cancelled"> {
    return await this.saveNotebook("explicit") === undefined ? "cancelled" : "saved";
  }

  async performDesktopAction(action: import("../protocol.js").WindowAction): Promise<"ok" | "cancelled"> {
    if (action === "save") return await this.saveForDesktop() === "saved" ? "ok" : "cancelled";
    if (action === "save-as") {
      const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
      if (!desktop) return "cancelled";
      const destination = await desktop.chooseSavePath();
      if (destination === null) return "cancelled";
      await this.flushEditorSources();
      this.setSaveState("saving");
      try { await this.client.saveAs(destination); this.setSaveState("saved"); }
      catch (error) { this.setSaveState("failed"); throw error; }
      return "ok";
    }
    if (action === "run-all" || action === "run-stale") {
      await this.runExplicit(() => this.client.startRunAll(action === "run-stale" ? "stale" : "all"));
      this.scheduleAutosave();
    } else if (action === "interrupt") {
      await this.client.interrupt();
    } else if (action === "restart") {
      await this.action(() => this.client.restart());
    } else if (action === "toggle-notebook") {
      this.togglePanel();
    } else if (action === "preview") {
      (this.dom.getElementById("app-mode") as HTMLAnchorElement | null)?.click();
    } else if (action === "format") {
      this.openDialog("format-dialog");
    } else if (action === "packages") {
      this.openDialog("packages-dialog");
    } else if (action === "shortcuts") {
      this.openDialog("shortcuts-dialog");
    } else if (action === "r-documentation") {
      const key = this.documentValue?.focusedKey;
      const editor = key ? this.editors.get(key) : undefined;
      if (!editor?.openHelp?.()) throw new Error("Place the cursor in an R code cell to open R documentation.");
    } else if (action === "settings") {
      this.openSettings();
    } else if (action === "run-cell") {
      const element = this.dom.activeElement?.closest?.(".cell");
      const key = element ? this.keyByElement.get(element) : undefined;
      if (key) await this.runExplicit(() => this.client.startRunCell(key));
    } else if (action === "run-and-advance") {
      const element = this.dom.activeElement?.closest?.(".cell");
      const key = element ? this.keyByElement.get(element) : undefined;
      if (key) {
        await this.runExplicit(() => this.client.startRunCell(key));
        this.focusAdjacentCell(key, 1, true);
      }
    } else if (action === "publish") {
      this.openDialog("publish-dialog");
    }
    return "ok";
  }

  private openDialog(id: string): void {
    const dialog = this.dom.getElementById(id) as HTMLDialogElement | null;
    if (!dialog || dialog.hasAttribute("open")) return;
    const active = this.dom.activeElement;
    if (active && typeof (active as HTMLElement).focus === "function") this.dialogReturnFocus.set(dialog, active as HTMLElement);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    window.requestAnimationFrame(() => firstFocusable(dialog)?.focus());
  }

  private closeDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else {
      dialog.removeAttribute("open");
      const EventConstructor = this.dom.defaultView?.Event ?? Event;
      dialog.dispatchEvent(new EventConstructor("close"));
    }
  }

  private bindDisclosureBehavior(): void {
    for (const dialog of Array.from(this.dom.querySelectorAll<HTMLDialogElement>("dialog"))) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog && clickOutsideBounds(event, dialog)) this.closeDialog(dialog);
      });
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeDialog(dialog);
        } else if (event.key === "Tab") trapTabKey(event, dialog);
      });
      dialog.addEventListener("close", () => {
        const target = this.dialogReturnFocus.get(dialog);
        this.dialogReturnFocus.delete(dialog);
        target?.focus({ preventScroll: true });
      });
    }
    this.dom.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      for (const disclosure of Array.from(this.dom.querySelectorAll<HTMLDetailsElement>("details.cell-overflow[open]"))) {
        if (!target || !disclosure.contains(target)) disclosure.removeAttribute("open");
      }
    });
    this.dom.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const disclosure = (event.target as Element | null)?.closest<HTMLDetailsElement>("details.cell-overflow[open]");
      if (!disclosure) return;
      event.preventDefault();
      disclosure.removeAttribute("open");
      disclosure.querySelector<HTMLElement>("summary")?.focus();
    });
  }

  private bindPublishDialog(): void {
    const dialog = this.dom.getElementById("publish-dialog") as HTMLDialogElement | null;
    const form = this.dom.getElementById("publish-form") as HTMLFormElement | null;
    const cancel = this.dom.getElementById("publish-cancel") as HTMLButtonElement | null;
    cancel?.addEventListener("click", () => {
      const operationId = this.activePublishOperationId;
      if (operationId) {
        void this.client.cancelOperation(operationId).catch(error => this.showError(error));
      } else if (dialog) this.closeDialog(dialog);
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      const submit = this.dom.getElementById("publish-submit") as HTMLButtonElement | null;
      const progress = this.dom.getElementById("publish-progress");
      const version = form.querySelector<HTMLInputElement>('input[name="publish-version"]:checked')?.value ?? "save";
      const include = (this.dom.getElementById("publish-include-code") as HTMLInputElement | null)?.checked === true;
      if (submit) setDisabled(submit, true);
      if (progress) progress.textContent = version === "save" ? "Saving and publishing…" : "Publishing last saved version…";
      void this.action(async () => {
        if (version === "save" && await this.saveNotebook("explicit") === undefined) return;
        let result: CommandResult | HostQueryResult;
        try {
          result = await this.runService("publish", { include_code: include }, operationId => {
            this.activePublishOperationId = operationId;
          });
        } finally {
          this.activePublishOperationId = null;
        }
        await this.downloadServiceResult(result);
        this.actionNotice = operationPayload(result).unsavedChangesExcluded === true
          ? "Published the last saved version. Unsaved changes were not included."
          : "Published HTML downloaded.";
        if (dialog) this.closeDialog(dialog);
      }).catch(error => this.showError(error)).finally(() => {
        if (submit) setDisabled(submit, false);
        if (progress) progress.textContent = "";
      });
    });
  }

  private async repaginateTables(limit: number): Promise<void> {
    const requests: Array<Promise<unknown>> = [];
    visitTableOutputs(this.documentValue?.snapshot.cells ?? [], (output) => {
      const page = isObject(output.page) ? output.page : {};
      const oldOffset = Number(page.offset);
      const offset = Number.isFinite(oldOffset) ? Math.floor(oldOffset / limit) * limit : 0;
      requests.push(this.client.requestTable({
        handle: String(output.handle), offset, limit,
        sortBy: typeof page.sort_by === "string" ? page.sort_by : "",
        sortDescending: page.sort_desc === true,
        filter: typeof page.filter === "string" ? page.filter : "",
      }));
    });
    await Promise.all(requests);
  }

  private bindToolbar(): void {
    this.dom.getElementById("run-all")?.addEventListener("click", (event) => {
      void this.runExplicit(() => this.client.startRunAll(this.runScope(), event)).then(() => {
        this.scheduleAutosave();
      }).catch((error) => this.showError(error));
    });
    this.dom.getElementById("stop")?.addEventListener("click", () => {
      void this.client.interrupt().catch((error) => this.showError(error));
    });
    this.dom.getElementById("restart")?.addEventListener("click", () => void this.action(() => this.client.restart()).catch((error) => this.showError(error)));
    this.dom.getElementById("save")?.addEventListener("click", () => {
      this.cancelEditTimers();
      void this.action(() => this.saveNotebook()).catch((error) => this.showError(error));
    });
    this.dom.getElementById("runtime-select")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value === "lazy" ? "lazy" : "automatic";
      void this.action(() => this.client.setRuntime({ executionMode: value })).then(() => this.scheduleAutosave()).catch((error) => {
        const control = this.dom.getElementById("runtime-select") as HTMLSelectElement | null;
        if (control) control.value = this.documentValue?.snapshot.runtime.executionMode ?? "automatic";
        this.showError(error);
      });
    });
    this.status?.addEventListener("click", (event) => {
      const target = (event.target as Element | null)?.closest("[data-status-action]");
      const action = target?.getAttribute("data-status-action");
      if (action === "undo-delete" && this.deletedCell) {
        event.preventDefault();
        const deleted = this.deletedCell;
        window.clearTimeout(deleted.timer);
        this.deletedCell = null;
        void this.action(async () => {
          await this.client.restoreCellAt(deleted.index, deleted.type, deleted.body);
          this.actionNotice = "Cell restored.";
          this.renderStatus();
          this.scheduleAutosave();
        }).catch((error) => this.showError(error));
        return;
      }
      if (action === "retry-connection") {
        event.preventDefault();
        const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
        if (desktop) void desktop.restartHost().catch(error => this.showError(error));
        else this.client.retryConnection();
        return;
      }
      if (action === "close-window") {
        event.preventDefault();
        window.close();
        return;
      }
      if (action === "choose-r") {
        event.preventDefault();
        const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
        void desktop?.chooseRscript().then(path => path ? this.client.selectR(path) : undefined).catch(error => this.showError(error));
        return;
      }
      if (action === "restart-runtime") {
        event.preventDefault();
        void this.action(() => this.client.restart()).catch((error) => this.showError(error));
        return;
      }
      if (action !== "retry-editor-help" || this.editorHelpRestarting) return;
      event.preventDefault();
      this.editorHelpRestarting = true;
      this.renderStatus();
      void this.action(() => this.lsp("alder/restart", {})).catch((error) => this.showError(error)).finally(() => {
        this.editorHelpRestarting = false;
        this.renderStatus();
      });
    });
    this.dom.getElementById("panel-toggle")?.addEventListener("click", () => this.togglePanel());
    this.dom.getElementById("panel-scrim")?.addEventListener("click", () => this.togglePanel(false));
    this.dom.getElementById("panel-close")?.addEventListener("click", () => {
      this.togglePanel(false);
    });
    const panelTabs = Array.from(this.dom.querySelectorAll<HTMLButtonElement>("[data-panel-tab]"));
    for (const tab of panelTabs) {
      tab.addEventListener("click", () => this.selectPanel(tab.dataset.panelTab ?? "variables"));
      tab.addEventListener("keydown", (event) => {
        if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
        event.preventDefault();
        const index = panelTabs.indexOf(tab);
        const target = event.key === "Home" ? panelTabs[0]
          : event.key === "End" ? panelTabs.at(-1)
          : panelTabs[(index + (event.key === "ArrowRight" ? 1 : -1) + panelTabs.length) % panelTabs.length];
        if (!target) return;
        this.selectPanel(target.dataset.panelTab ?? "variables");
        target.focus();
      });
    }
    this.dom.getElementById("dataflow-panel")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.graphExpanded) {
          this.graphExpanded = false;
          this.applyPanelState();
          if (this.documentValue) this.renderGraph(this.documentValue.snapshot);
        } else if (this.panelDrawerMode) this.togglePanel(false);
        return;
      }
      if (event.key !== "Tab" || !this.panelDrawerMode) return;
      trapTabKey(event, this.dom.getElementById("dataflow-panel") as HTMLElement);
    });
    this.dom.getElementById("app-mode")?.addEventListener("click", (event) => {
      event.preventDefault();
      this.cancelEditTimers();
      void this.action(async () => {
        await this.client.commitEdits();
        await this.output.flush();
        this.internalNavigation = true;
        try { location.assign(notebookViewUrl("preview")); }
        catch (error) { this.internalNavigation = false; throw error; }
      }).catch((error) => this.showError(error));
    });
  }

  private togglePanel(force?: boolean): void {
    this.panelDrawerMode = this.isInspectorDrawer();
    const opening = force ?? !this.panelOpen;
    if (opening && this.panelDrawerMode) this.panelReturnFocus = this.dom.activeElement as HTMLElement | null;
    this.panelOpen = opening;
    if (!this.panelOpen) {
      this.graphExpanded = false;
      this.cancelVariablesProjection();
    }
    savePanelPreference(window, { open: this.panelOpen, tab: this.panelTab });
    this.applyPanelState();
    if (this.panelOpen && this.documentValue) this.renderSelectedPanel(this.documentValue.snapshot);
    if (this.panelOpen && this.panelDrawerMode) window.requestAnimationFrame(() => this.focusInspector());
    if (!this.panelOpen && this.panelReturnFocus) {
      const target = this.panelReturnFocus;
      this.panelReturnFocus = null;
      target.focus({ preventScroll: true });
    }
    window.requestAnimationFrame(() => this.updateTopbarInset());
  }

  private selectPanel(name: string): void {
    if (!isPanelTab(name)) return;
    if (name !== "variables") this.cancelVariablesProjection();
    this.panelTab = name;
    this.panelOpen = true;
    savePanelPreference(window, { open: this.panelOpen, tab: this.panelTab });
    this.applyPanelState();
    if (this.documentValue) this.renderSelectedPanel(this.documentValue.snapshot);
  }

  private renderSelectedPanel(snapshot: HostSnapshot): void {
    if (this.panelTab === "variables") {
      this.variablesSignature = "";
      this.variablesDirty = true;
      this.scheduleVariablesProjection();
    } else if (this.panelTab === "dependencies") {
      this.dependenciesSignature = "";
      this.renderDependenciesProjection(snapshot);
    } else if (this.panelTab === "graph") {
      this.dataflowSignature = "";
      this.renderGraphProjection(snapshot);
    } else {
      this.outlineSignature = "";
      this.renderOutlineProjection(snapshot);
    }
  }

  private applyPanelState(): void {
    const panel = this.dom.getElementById("dataflow-panel");
    if (!panel || this.appView) return;
    panel.hidden = !this.panelOpen;
    this.dom.body.classList.toggle("panel-closed", !this.panelOpen);
    const drawer = this.panelDrawerMode;
    panel.setAttribute("role", drawer ? "dialog" : "complementary");
    if (drawer) panel.setAttribute("aria-modal", "true");
    else panel.removeAttribute("aria-modal");
    const scrim = this.dom.getElementById("panel-scrim") as HTMLButtonElement | null;
    if (scrim) scrim.hidden = !(drawer && this.panelOpen);
    this.setInspectorModal(drawer && this.panelOpen);
    this.dom.getElementById("panel-toggle")?.setAttribute("aria-expanded", String(this.panelOpen));
    for (const tab of Array.from(this.dom.querySelectorAll<HTMLButtonElement>("[data-panel-tab]"))) {
      const selected = tab.dataset.panelTab === this.panelTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const value of ["variables", "dependencies", "graph", "outline"] as const) {
      const panel = this.dom.getElementById(`panel-${value}`);
      if (panel) panel.hidden = value !== this.panelTab;
    }
    if (this.panelTab !== "graph" && this.graphExpanded) {
      this.graphExpanded = false;
    }
    panel.classList.toggle("graph-expanded", this.graphExpanded && this.panelTab === "graph");
  }

  private isInspectorDrawer(): boolean {
    return window.matchMedia?.("(max-width: 900px)").matches === true;
  }

  private focusInspector(): void {
    (this.dom.querySelector("#dataflow-panel [aria-selected=true]") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private setInspectorModal(active: boolean): void {
    this.dom.body.classList.toggle("inspector-modal-open", active);
    for (const selector of ["#topbar", "#status", "#editor-diagnostics", "#notebook"]) {
      const target = this.dom.querySelector<HTMLElement>(selector);
      if (!target) continue;
      if (active) target.setAttribute("inert", "");
      else target.removeAttribute("inert");
    }
  }

  private updateTopbarInset(): void {
    const bottom = Math.max(0, this.dom.getElementById("topbar")?.getBoundingClientRect().bottom ?? 48);
    this.dom.documentElement.style.setProperty("--alder-topbar-bottom", `${Math.ceil(bottom)}px`);
  }

  private scheduleEdit(key: string): void {
    this.cancelEditTimer(key);
    const timer = window.setTimeout(() => {
      this.editTimers.delete(key);
      void this.client.commitEdits().then(() => this.scheduleAutosave()).catch((error) => this.showError(error));
    }, 400);
    this.editTimers.set(key, timer);
  }

  private cancelEditTimer(key: string): void {
    const timer = this.editTimers.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    this.editTimers.delete(key);
  }

  private cancelEditTimers(): void {
    for (const key of this.editTimers.keys()) this.cancelEditTimer(key);
    // Explicit source actions end the typing intent, including delayed help
    // that would otherwise start after Run while the caret stays focused.
    for (const editor of this.editors.values()) editor.closeCompletion?.();
    for (const [key, request] of this.lspRequests) {
      if (key.startsWith("completion:")) request.abort();
    }
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (this.appView || this.documentValue?.snapshot.config.autosave !== true
      || !(this.documentValue.snapshot.dirty || this.documentValue.pendingSource().changes.length > 0)) return;
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.saveNotebook("autosave").catch((error) => this.showError(error));
    }, 2_000);
  }

  private captureSelection(key: string): void {
    const view = this.views.get(key);
    const main = view?.editor?.view?.state?.selection?.main;
    if (main) {
      const selection: EditorSelection = { anchor: main.anchor, head: main.head, scrollTop: view?.editor?.view?.scrollDOM?.scrollTop };
      this.documentValue?.updateSelection(key, selection);
    } else if (view?.fallback) {
      this.documentValue?.updateSelection(key, { anchor: view.fallback.selectionStart, head: view.fallback.selectionEnd, scrollTop: view.fallback.scrollTop });
    }
  }

  private sourceText(key: string): string {
    const view = this.views.get(key);
    return view?.editor?.getDoc() ?? view?.fallback?.value ?? this.requireCell(key).desiredBody.join("\n");
  }

  private captureEditorSources(): void {
    if (!this.documentValue) return;
    for (const cell of this.documentValue.cells) {
      if (cell.tombstone) continue;
      const source = this.sourceText(cell.key);
      if (source !== cell.desiredBody.join("\n")) {
        this.client.editCell(cell.key, source, cell.desiredType);
      }
    }
  }

  private async flushEditorSources(): Promise<void> {
    this.cancelEditTimers();
    this.captureEditorSources();
  }

  private async action<T>(operation: () => Promise<T>): Promise<T> {
    this.actionNotice = null;
    try {
      const result = await operation();
      this.actionError = null;
      return result;
    } finally {
      this.renderStatus();
    }
  }

  private renderStatus(): void {
    if (!this.status) return;
    this.renderSettingsError();
    const stateError = this.documentValue?.snapshot.lastActionError?.message ?? null;
    const settingsError = this.documentValue?.snapshot.serviceErrors.settings?.message ?? null;
    const editorHelpError = this.editorHelpError
      ?? this.documentValue?.snapshot.serviceErrors.lsp?.message
      ?? null;
    const runtimeBlocked = this.documentValue?.snapshot.runtime.executionBlockedReason ?? null;
    const recovery = this.client.recoveryState;
    const recoveryConflict = recovery.status === "conflict" || recovery.candidate?.state === "conflict" || recovery.corruption !== null;
    const recoveryMessage = recovery.selectingRetainedDraft ? "Opening selected draft…" : recovery.uncertainRun ? "The previous run may have been interrupted. Run explicitly when you are ready." : recovery.local !== null
      ? recovery.status === "conflict" ? "Recovered edits conflict with newer changes." : "Unsaved edits recovered."
      : recovery.retainedDrafts?.length ? "Retained drafts are available for review."
      : recovery.persistenceError ? "Local edit recovery is not durable."
      : recovery.candidate?.state === "restored" ? "Unsaved edits recovered."
      : recovery.corruption ? "Recovery data needs your review." : recoveryConflict ? "Recovered edits need your review." : null;
    const message = this.hostClosed ? "Notebook closed." : recoveryMessage ?? this.actionError ?? stateError ?? settingsError ?? editorHelpError ?? this.actionNotice ?? "";
    const signature = JSON.stringify({
      runtimeBlocked: runtimeBlocked === null ? null : [runtimeBlocked.code, runtimeBlocked.message],
      message,
      actionError: Boolean(this.actionError),
      stateError: Boolean(stateError),
      settingsError: Boolean(settingsError),
      editorHelpError: Boolean(editorHelpError),
      transportError: Boolean(this.transportError),
      recoveryRuntime: [this.documentValue?.snapshot.runtime.kernelState ?? null,
        this.documentValue?.snapshot.runtime.rEnvironment?.rscript ?? null],
      editorHelpRestarting: this.editorHelpRestarting,
      recovery: { status: recovery.status, local: recovery.local !== null, retainedDrafts: recovery.retainedDrafts?.map(draft => draft.draftId) ?? [], selectingRetainedDraft: recovery.selectingRetainedDraft === true, candidate: recovery.candidate === null ? null : [recovery.candidate.state, recovery.candidate.documentRevision], uncertainRun: recovery.uncertainRun, corruption: recovery.corruption?.code ?? null, persistenceError: recovery.persistenceError?.code ?? null },
      canUndoDelete: this.deletedCell !== null,
    });
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    this.status.replaceChildren();
    if (message) this.status.appendChild(elementNode(this.dom, "span", "status-message", message));
    if (this.deletedCell) {
      const undo = elementNode(this.dom, "button", "btn mini status-action", "Undo") as HTMLButtonElement;
      undo.type = "button";
      undo.dataset.statusAction = "undo-delete";
      this.status.appendChild(undo);
    }
    if (this.transportError) {
      const banner = elementNode(this.dom, "div", "connection-banner", "") as HTMLDivElement;
      banner.dataset.connectionBanner = this.transportState;
      banner.setAttribute("role", "region");
      banner.setAttribute("aria-label", "Connection status");
      banner.appendChild(elementNode(this.dom, "span", "connection-message", this.transportError));
      const desktop = (globalThis as typeof globalThis & { alderDesktop?: import("../protocol.js").PreloadApi }).alderDesktop;
      const retry = elementNode(this.dom, "button", "btn mini", desktop ? "Restart host" : "Restart connection") as HTMLButtonElement;
      retry.type = "button";
      retry.dataset.statusAction = "retry-connection";
      const close = elementNode(this.dom, "button", "btn mini", "Close") as HTMLButtonElement;
      close.type = "button";
      close.dataset.statusAction = "close-window";
      banner.append(retry, close);
      this.status.appendChild(banner);
    }
    if (editorHelpError) {
      const retry = elementNode(this.dom, "button", "btn mini status-action", "Retry editor help") as HTMLButtonElement;
      retry.type = "button";
      retry.dataset.statusAction = "retry-editor-help";
      retry.disabled = this.editorHelpRestarting;
      if (this.editorHelpRestarting) retry.setAttribute("aria-busy", "true");
      this.status.appendChild(retry);
    }
    this.renderRuntimeControls(runtimeBlocked);
    this.renderRecoveryControls();
    this.status.classList.toggle("error", Boolean(this.actionError || stateError || settingsError || editorHelpError || runtimeBlocked || recoveryConflict));
    this.status.classList.toggle("poll-error", Boolean(!this.actionError && !stateError && !settingsError && !editorHelpError && !runtimeBlocked && this.transportError));
  }

  private announce(message: string): void {
    const announcer = this.dom.getElementById("announcer");
    if (!announcer) return;
    announcer.textContent = "";
    window.requestAnimationFrame(() => { announcer.textContent = message; });
  }

  private renderRuntimeControls(runtimeBlocked: HostSnapshot["runtime"]["executionBlockedReason"]): void {
    if (!this.status || runtimeBlocked === null || this.hostClosed) return;
    const panel = elementNode(this.dom, "div", "runtime-recovery-panel", "") as HTMLDivElement;
    panel.dataset.runtimeRecovery = "true";
    panel.setAttribute("role", "alert");
    const detail = runtimeBlocked.message || "Alder could not start R for this notebook.";
    panel.appendChild(elementNode(this.dom, "div", "runtime-message", "R execution is blocked: " + detail));
    panel.appendChild(elementNode(this.dom, "div", "runtime-guidance", "Your edits and saves are preserved. Choose an R installation or restart R."));
    const restart = elementNode(this.dom, "button", "btn mini status-action", "Restart R") as HTMLButtonElement;
    restart.type = "button";
    restart.dataset.statusAction = "restart-runtime";
    restart.disabled = this.hostClosed || this.documentValue?.snapshot.runtime.busy === true;
    if (restart.disabled) restart.setAttribute("aria-disabled", "true");
    panel.appendChild(restart);
    const choose = elementNode(this.dom, "button", "btn mini status-action", "Choose R…") as HTMLButtonElement;
    choose.type = "button";
    choose.dataset.statusAction = "choose-r";
    panel.appendChild(choose);
    this.status.appendChild(panel);
  }

  private renderRecoveryControls(): void {
    if (!this.status) return;
    const state = this.client.recoveryState;
    if (!state.local && !state.candidate && !state.uncertainRun && !state.corruption && !state.persistenceError && !state.retainedDrafts?.length && !state.selectingRetainedDraft) return;
    const panel = elementNode(this.dom, "div", "recovery-panel", "") as HTMLDivElement;
    panel.dataset.recovery = "true"; panel.dataset.recoveryPanel = "true"; panel.setAttribute("role", "alert");
    if (state.selectingRetainedDraft) panel.setAttribute("aria-busy", "true");
    const detail = state.selectingRetainedDraft ? "Opening the selected draft. Wait before choosing another recovery action." : state.uncertainRun ? "The previous run may have been interrupted. It has not been run again." : state.local ? state.status === "conflict"
      ? "Your edits are preserved. Review the conflicting cells before saving."
      : "Your unsaved edits have been recovered."
      : state.persistenceError?.message ?? state.corruption?.message ?? (state.candidate?.state === "conflict"
        ? "The saved notebook changed after these edits. Use Save As to preserve a copy, or reopen the saved file to discard them."
        : state.retainedDrafts?.length ? "Retained drafts are available. Choose one to restore; the others remain available." : "Unsaved changes were recovered.");
    panel.appendChild(elementNode(this.dom, "div", "recovery-message", detail));
    const actions = elementNode(this.dom, "div", "recovery-actions", "") as HTMLDivElement;
    const add = (label: string, action: () => Promise<void>): void => {
      const button = elementNode(this.dom, "button", "btn mini", label) as HTMLButtonElement;
      button.type = "button"; button.dataset.recovery = "true";
      button.disabled = state.selectingRetainedDraft === true;
      button.addEventListener("click", () => { void this.action(action).catch(error => this.showError(error)); });
      actions.appendChild(button);
    };
    if (state.local || state.candidate?.state === "restored") add("Continue recovered", async () => this.client.continueRecovered());
    for (const [index, draft] of (state.retainedDrafts ?? []).entries()) {
      const updated = new Date(draft.updatedAt);
      const time = Number.isFinite(updated.getTime()) ? updated.toLocaleString() : "unknown time";
      add(`Restore draft ${index + 1} (${time}): ${draft.preview}`, () => this.client.restoreRetainedDraft(draft.draftId));
    }
    if (state.retainedDrafts?.length) add("Use saved notebook", async () => this.client.dismissRetainedDrafts());
    if (state.local && this.documentValue?.snapshot.runtime.rEnvironment !== null
      && this.documentValue?.snapshot.runtime.kernelState !== "ready") {
      add("Start R", async () => {
        const rscript = this.documentValue?.snapshot.runtime.rEnvironment?.rscript;
        if (!rscript) throw new Error("Choose an R installation before starting R");
        await this.client.selectR(rscript);
      });
    }
    if (state.status === "conflict" || state.candidate?.state === "conflict") add("Save recovered copy", () => this.saveRecoveryCopy());
    if (state.local || state.candidate || state.corruption) add("Open saved", async () => {
      if (window.confirm("Open the saved notebook and remove the recovered edits?")) await this.client.discardRecovery();
    });
    if (actions.childElementCount) panel.appendChild(actions);
    this.status.appendChild(panel);
  }

  private executionAvailable(): boolean {
    const runtime = this.documentValue?.snapshot.runtime;
    return Boolean(runtime?.executionReady && runtime.kernelState === "ready");
  }

  private runScope(): "all" | "stale" {
    return this.documentValue?.snapshot.runtime.executionMode === "lazy" ? "stale" : "all";
  }

  private keymap(): string {
    return configString(this.documentValue?.snapshot.config, ["keymap"], "default");
  }

  private preference(name: string, fallback: boolean): boolean {
    const value = nested(this.documentValue?.snapshot.config, ["editor", name]);
    return typeof value === "boolean" ? value : fallback;
  }

  private lspCompletion(
    cell: LocalCell,
    editor: EditorHandle | null,
    context: EditorCompletionContext,
  ): Promise<{ from: number; options: EditorCompletion[] } | null> | null {
    if (!cell.id || !editor || editor.view?.hasFocus === false) return null;
    const word = context.matchBefore(/[A-Za-z.][A-Za-z0-9_.]*|[A-Za-z0-9_]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const requestedCells = new Map(
      (this.documentValue?.cells ?? []).flatMap((candidate) => candidate.id
        ? [[candidate.id, { key: candidate.key, source: this.sourceText(candidate.key) }] as const]
        : []),
    );
    return this.lspRequest(`completion:${cell.key}`, "textDocument/completion", {
      position: editorPosition(editor, cell, context.pos),
    }).then((result) => {
      const currentCells = this.documentValue?.cells ?? [];
      if (currentCells.some((candidate) => {
        const requested = candidate.id === null ? undefined : requestedCells.get(candidate.id);
        return requested !== undefined
          && (requested.key !== candidate.key || requested.source !== this.sourceText(candidate.key));
      })) return null;
      const items = Array.isArray(result) ? result : isObject(result) && Array.isArray(result.items) ? result.items : [];
      const options = items.flatMap((raw): EditorCompletion[] => {
        if (!isObject(raw)) return [];
        const textEdit = isObject(raw.textEdit) ? raw.textEdit : null;
        const label = String(raw.label ?? raw.insertText ?? textEdit?.newText ?? "");
        if (!label) return [];
        const newText = String(textEdit?.newText ?? raw.insertText ?? raw.label ?? "");
        const edits: LspCompletionEdit[] = [];
        if (textEdit) {
          const edit = lspCompletionEdit(textEdit, newText);
          if (!edit) return [];
          edits.push(edit);
        }
        if (raw.additionalTextEdits !== undefined) {
          if (!Array.isArray(raw.additionalTextEdits)) return [];
          for (const additional of raw.additionalTextEdits) {
            const edit = lspCompletionEdit(additional);
            if (!edit) return [];
            edits.push(edit);
          }
        }
        if (!textEdit && edits.length > 0) {
          const start = editorPosition(editor, cell, word.from);
          const end = editorPosition(editor, cell, word.to);
          if (!cell.id) return [];
          edits.unshift({ cell: cell.id, start: lspPosition(start), end: lspPosition(end), newText });
        }
        const apply = edits.length > 0 ? this.completionApply(edits, requestedCells) : newText;
        if (!apply) return [];
        return [{
          label,
          type: lspKind(raw.kind),
          detail: typeof raw.detail === "string" ? raw.detail : "",
          info: lspText(raw.documentation),
          apply,
        }];
      });
      return { from: word.from, options };
    }).catch(() => null);
  }

  private completionApply(
    edits: readonly LspCompletionEdit[],
    requestedCells: ReadonlyMap<string, { key: string; source: string }>,
  ): (() => void) | null {
    const document = this.documentValue;
    if (!document) return null;
    const groups = new Map<string, { source: string; changes: Array<{ from: number; to: number; insert: string }> }>();
    for (const edit of edits) {
      const requested = requestedCells.get(edit.cell);
      if (!requested) return null;
      const cell = document.cells.find((candidate) => candidate.id === edit.cell && candidate.key === requested.key);
      if (!cell) return null;
      const source = requested.source;
      const from = exactSourceOffset(source, edit.start.line, edit.start.character);
      const to = exactSourceOffset(source, edit.end.line, edit.end.character);
      if (from === null || to === null || to < from) return null;
      const group = groups.get(cell.key) ?? {
        source,
        changes: [] as Array<{ from: number; to: number; insert: string }>,
      };
      if (group.source !== source) return null;
      group.changes.push({ from, to, insert: edit.newText });
      groups.set(cell.key, group);
    }
    for (const group of groups.values()) {
      const ascending = [...group.changes].sort((a, b) => a.from - b.from || a.to - b.to);
      for (let index = 1; index < ascending.length; index += 1) {
        if (ascending[index]!.from < ascending[index - 1]!.to) return null;
      }
    }
    return () => {
      window.queueMicrotask(() => {
        if ([...groups].some(([key, group]) => this.sourceText(key) !== group.source)) return;
        for (const [key, group] of groups) {
          let next = group.source;
          const descending = [...group.changes].sort((a, b) => b.from - a.from || b.to - a.to);
          for (const change of descending) next = next.slice(0, change.from) + change.insert + next.slice(change.to);
          const view = this.views.get(key);
          view?.editor?.setDoc(next, { silent: true });
          if (view?.fallback) view.fallback.value = next;
          this.deferDiagnostics(key);
          this.client.editCell(key, next);
        }
      });
    };
  }

  private lspHover(cell: LocalCell, editor: EditorHandle | null, position: number): Promise<EditorHover> {
    if (!cell.id || !editor) return Promise.resolve(null);
    return this.lspRequest(`hover:${cell.key}`, "textDocument/hover", {
      position: editorPosition(editor, cell, position),
    }).then((result) => isObject(result) ? {
      text: lspText(result.contents),
      html: typeof result.rendered === "string" ? result.rendered : "",
    } : null, () => null);
  }

  private lspSignature(cell: LocalCell, editor: EditorHandle | null, position: number, trigger: string): Promise<EditorSignature | null> {
    if (!cell.id || !editor) return Promise.resolve(null);
    return this.lspRequest(`signature:${cell.key}`, "textDocument/signatureHelp", {
      position: editorPosition(editor, cell, position),
      context: { triggerKind: 2, triggerCharacter: trigger },
    }).then(lspSignatureModel, () => null);
  }

  private async lspRequest(key: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.lspRequests.get(key)?.abort();
    const controller = new AbortController();
    this.lspRequests.set(key, controller);
    try {
      return await this.lsp(method, params, controller.signal);
    } finally {
      if (this.lspRequests.get(key) === controller) this.lspRequests.delete(key);
    }
  }

  private async lsp(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      await this.client.commitEdits();
      signal?.throwIfAborted();
      const response = await fetch(notebookUrl("/api/lsp"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": this.client.transport.csrf },
        body: JSON.stringify({ method, params }),
        signal,
      });
      this.client.transport.assertResponseContinuity(response);
      const result = await response.json() as {
        ok?: boolean;
        epoch?: string;
        documentRevision?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (!response.ok || result.ok === false) throw new Error(result.error?.message ?? "language server request failed");
      const current = this.documentValue?.snapshot;
      if (!current || result.epoch !== current.epoch || result.documentRevision !== current.documentRevision) {
        throw new DOMException("stale language-server response", "AbortError");
      }
      this.editorHelpError = null;
      this.renderStatus();
      return result.result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      this.editorHelpError = error instanceof Error ? error.message : "Language assistance is unavailable";
      this.renderStatus();
      throw error;
    }
  }

  private destroyCell(key: string, view: CellView): void {
    this.cancelEditTimer(key);
    if (view.diagnosticsTimer !== null) window.clearTimeout(view.diagnosticsTimer);
    view.diagnosticsTimer = null;
    view.editor?.destroy();
    this.editors.delete(key);
    this.visibleKeys.delete(key);
    this.observer?.unobserve(view.element);
    view.element.remove();
    this.views.delete(key);
  }

  private requireDocument(): BrowserDocument {
    if (!this.documentValue) throw new Error("notebook is not connected");
    return this.documentValue;
  }

  private requireCell(key: string): LocalCell {
    const cell = this.requireDocument().cell(key);
    if (!cell) throw new Error(`no such cell: ${key}`);
    return cell;
  }
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.closest("[hidden], [aria-hidden=true]"));
}

function clickOutsideBounds(event: MouseEvent, element: HTMLElement): boolean {
  const bounds = element.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
}

function firstFocusable(root: HTMLElement): HTMLElement | undefined {
  return focusableElements(root)[0];
}

function trapTabKey(event: KeyboardEvent, root: HTMLElement): void {
  const focusable = focusableElements(root);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  const active = root.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function diagnosticsForEditor(diagnostics: readonly AnalysisDiagnostic[], source: string): EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const raw = diagnostic as AnalysisDiagnostic & { range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; line?: number; column?: number };
    const start = raw.range?.start ?? { line: Math.max(0, Number(raw.line ?? 1) - 1), character: Math.max(0, Number(raw.column ?? 1) - 1) };
    const end = raw.range?.end ?? start;
    return {
      from: sourceOffset(source, Number(start.line ?? 0), Number(start.character ?? 0)),
      to: sourceOffset(source, Number(end.line ?? start.line ?? 0), Number(end.character ?? start.character ?? 0)),
      severity: diagnostic.level ?? "error",
      message: diagnostic.message,
    };
  });
}

function sourceOffset(source: string, line: number, character: number): number {
  const lines = source.split("\n");
  const boundedLine = Math.max(0, Math.min(Math.floor(line), lines.length - 1));
  let offset = 0;
  for (let index = 0; index < boundedLine; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return Math.min(source.length, offset + Math.max(0, Math.min(Math.floor(character), lines[boundedLine]?.length ?? 0)));
}

function exactSourceOffset(source: string, line: number, character: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) return null;
  const lines = source.split("\n");
  if (line >= lines.length || character > lines[line]!.length) return null;
  let offset = character;
  for (let index = 0; index < line; index += 1) offset += lines[index]!.length + 1;
  return offset;
}

function lspPosition(value: Record<string, unknown>): { line: number; character: number } {
  return { line: Number(value.line), character: Number(value.character) };
}

function lspCompletionEdit(raw: unknown, fallbackText?: string): LspCompletionEdit | null {
  if (!isObject(raw)) return null;
  const range = isObject(raw.range) ? raw.range : isObject(raw.replace) ? raw.replace : null;
  if (!range || !isObject(range.start) || !isObject(range.end)) return null;
  const start = range.start;
  const end = range.end;
  const cell = typeof start.cell === "string" && start.cell === end.cell ? start.cell : null;
  const newText = typeof raw.newText === "string" ? raw.newText : fallbackText;
  if (!cell || newText === undefined) return null;
  const positions = [start.line, start.character, end.line, end.character];
  if (!positions.every((value) => Number.isInteger(value) && Number(value) >= 0)) return null;
  return {
    cell,
    start: { line: Number(start.line), character: Number(start.character) },
    end: { line: Number(end.line), character: Number(end.character) },
    newText,
  };
}

function editorPosition(editor: EditorHandle | null, cell: LocalCell, offset: number): Record<string, unknown> {
  const text = editor?.getDoc() ?? cell.desiredBody.join("\n");
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n");
  return { cell: cell.id, line: before.length - 1, character: before.at(-1)?.length ?? 0 };
}

function sourceWordAt(source: string, position: number): string | null {
  const bounded = Math.max(0, Math.min(source.length, position));
  const expression = /[A-Za-z.][A-Za-z0-9_.]*/g;
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    if (bounded >= match.index && bounded <= match.index + match[0].length) return match[0];
  }
  return null;
}

function reactiveReferenceRanges(
  cell: LocalCell,
  source: string,
  snapshot: HostSnapshot | undefined,
): Array<{ from: number; to: number }> {
  const references = new Set(cell.server?.refs ?? []);
  if (!references.size || !snapshot || !cell.id) return [];
  const owners = new Map<string, string>();
  for (const candidate of snapshot.cells) {
    for (const name of candidate.defs) if (!owners.has(name)) owners.set(name, candidate.id);
  }
  const ranges: Array<{ from: number; to: number }> = [];
  const expression = /[A-Za-z.][A-Za-z0-9_.]*/g;
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    const owner = owners.get(match[0]);
    if (references.has(match[0]) && owner && owner !== cell.id) {
      ranges.push({ from: match.index, to: match.index + match[0].length });
    }
  }
  return ranges;
}

function lspText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(lspText).filter(Boolean).join("\n");
  if (isObject(value)) {
    if (typeof value.value === "string") return value.value;
    if (value.contents !== undefined) return lspText(value.contents);
  }
  return value === null || value === undefined ? "" : String(value);
}

function lspKind(kind: unknown): string {
  return ({
    1: "text", 2: "method", 3: "function", 4: "constructor",
    5: "class", 6: "method", 7: "property", 8: "variable",
    9: "constant", 10: "struct", 11: "event", 12: "operator",
    13: "type", 14: "namespace", 15: "keyword", 16: "modifier",
    17: "number", 18: "string", 19: "regexp", 20: "class",
    21: "interface", 22: "function", 23: "variable", 24: "value",
    25: "unit", 26: "value", 27: "enum", 28: "interface",
  } as Record<number, string>)[Number(kind)] ?? "variable";
}

function lspSignatureModel(value: unknown): EditorSignature | null {
  if (!isObject(value) || !Array.isArray(value.signatures) || !value.signatures.length) return null;
  const signatureIndex = Math.max(0, Math.min(value.signatures.length - 1, Math.floor(Number(value.activeSignature) || 0)));
  const signature = value.signatures[signatureIndex];
  if (!isObject(signature)) return null;
  const parameters = Array.isArray(signature.parameters) ? signature.parameters : [];
  const requestedParameter = value.activeParameter ?? signature.activeParameter;
  const parameterIndex = Math.max(0, Math.min(Math.max(0, parameters.length - 1), Math.floor(Number(requestedParameter) || 0)));
  const parameter = isObject(parameters[parameterIndex]) ? parameters[parameterIndex] : {};
  let activeParameter: unknown = parameter.label;
  if (Array.isArray(activeParameter) && activeParameter.length === 2) {
    activeParameter = String(signature.label ?? "").slice(Number(activeParameter[0]) || 0, Number(activeParameter[1]) || 0);
  }
  return {
    label: String(signature.label ?? ""),
    activeParameter: String(activeParameter ?? ""),
    documentation: lspText(parameter.documentation ?? signature.documentation),
  };
}

function cellName(cell: unknown): string {
  if (!isObject(cell)) return "";
  const options = isObject(cell.options) ? cell.options : {};
  return typeof options.name === "string" ? options.name : "";
}

function nested(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

function configString(root: unknown, path: readonly string[], fallback: string): string {
  const value = nested(root, path);
  return typeof value === "string" ? value : fallback;
}

function configNumber(root: unknown, path: readonly string[], fallback: number): number {
  const value = Number(nested(root, path));
  return Number.isFinite(value) ? value : fallback;
}

function boundedConfig(root: unknown, path: readonly string[], fallback: number, minimum: number, maximum: number): number {
  const value = Math.round(configNumber(root, path, fallback));
  return Math.max(minimum, Math.min(maximum, value));
}

function changedSettings(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (isObject(value) && isObject(before[key])) {
      const nestedChanges = changedSettings(before[key], value);
      if (Object.keys(nestedChanges).length) changed[key] = nestedChanges;
    } else if (value !== before[key]) changed[key] = value;
  }
  return changed;
}

function setSelect(dom: Document, id: string, value: string, allowed: readonly string[]): void {
  const input = dom.getElementById(id) as HTMLSelectElement | null;
  if (input) input.value = allowed.includes(value) ? value : allowed[0] ?? "";
}

function setNumber(dom: Document, id: string, value: number): void {
  const input = dom.getElementById(id) as HTMLInputElement | null;
  if (input) input.value = String(value);
}

function setChecked(dom: Document, id: string, value: boolean): void {
  const input = dom.getElementById(id) as HTMLInputElement | null;
  if (input) input.checked = value;
}

function inputValue(dom: Document, id: string, fallback: string): string {
  const input = dom.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return input?.value || fallback;
}

function inputChecked(dom: Document, id: string): boolean {
  return (dom.getElementById(id) as HTMLInputElement | null)?.checked === true;
}

function inputInteger(dom: Document, id: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number((dom.getElementById(id) as HTMLInputElement | null)?.value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? Math.round(value) : fallback));
}

function visitTableOutputs(cells: readonly HostSnapshot["cells"][number][], visit: (output: Record<string, unknown>) => void): void {
  const walk = (value: unknown): void => {
    if (!isObject(value)) return;
    if (isObject(value.data)) { walk(value.data); return; }
    if (value.kind === "table" && typeof value.handle === "string") visit(value);
    if (value.kind === "layout" && Array.isArray(value.children)) value.children.forEach(walk);
    if (value.kind === "lazy") walk(value.child);
  };
  cells.forEach((cell) => cell.outputs.forEach(walk));
}

function operationPayload(result: CommandResult | HostQueryResult): Record<string, unknown> {
  return isObject(result.result) ? result.result : {};
}

function artifactHandleFromResult(result: CommandResult | HostQueryResult): ArtifactHandle | null {
  const payload = result.result;
  const candidates: unknown[] = [payload, isObject(payload) ? payload.artifact : null];
  for (const candidate of candidates) if (isArtifactHandle(candidate)) return candidate;
  return null;
}

function isArtifactHandle(value: unknown): value is ArtifactHandle {
  return artifactHandleSchema.safeParse(value).success;
}

function packageStatusText(value: Record<string, unknown>, output = ""): string {
  const lines: string[] = [];
  for (const [label, field] of [["Declared", "packages"], ["Installed", "installed"], ["Missing", "missing"]] as const) {
    const entries = Array.isArray(value[field]) ? value[field].map(String) : [];
    lines.push(`${label}: ${entries.length ? entries.join(", ") : "none"}`);
  }
  if (typeof value.mode === "string") lines.push(`Mode: ${value.mode}`);
  if (typeof value.library === "string") lines.push(`Library: ${value.library}`);
  if (output.length > 0) lines.push("Output:", output);
  return lines.join("\n");
}

function packageProgressPhaseText(command: PackageServiceCommand, phase: "started" | "output" | "finished"): string {
  if (phase === "started") return command === "packages.install" ? "Installing packages…" : "Declaring packages…";
  return phase === "finished" ? "Package operation finished" : "";
}

function packageProgressDataText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

function isOperationRecord(value: unknown): value is OperationRecord {
  return isObject(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.status === "string";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1_024) return `${Math.round(value)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function dataflowCellSignature(cell: HostSnapshot["cells"][number]): string {
  return JSON.stringify({
    type: cell.type,
    body: cell.type === "markdown" ? toLogicalCellBody(cell.type, cell.body) : undefined,
    options: cell.options,
    defs: cell.defs,
    refs: cell.refs,
  });
}

function outlineCellSignature(cell: HostSnapshot["cells"][number]): string {
  return JSON.stringify({
    type: cell.type,
    body: cell.type === "markdown" ? toLogicalCellBody(cell.type, cell.body) : undefined,
    name: cell.options.name,
  });
}

function cellLabelAt(cell: HostSnapshot["cells"][number], index: number): string {
  const name = cellName(cell);
  return name ? `Cell ${index + 1} · ${name}` : `Cell ${index + 1}`;
}

function markdownHeadings(body: readonly string[]): Array<{ level: number; text: string; line: number }> {
  const result: Array<{ level: number; text: string; line: number }> = [];
  for (const [line, raw] of body.entries()) {
    const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(raw);
    if (!match) continue;
    const text = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (text) result.push({ level: match[1]!.length, text, line });
  }
  return result;
}

function isPanelTab(value: string): value is DataflowPanelTab {
  return value === "variables" || value === "dependencies" || value === "graph" || value === "outline";
}

function loadPanelPreference(browser: Window): { open: boolean; tab: DataflowPanelTab } {
  const fallback = {
    open: false,
    tab: "outline" as DataflowPanelTab,
  };
  try {
    const value: unknown = JSON.parse(browser.localStorage.getItem("alder.panel") ?? "null");
    if (!isObject(value)) return fallback;
    return {
      open: typeof value.open === "boolean" ? value.open : fallback.open,
      tab: typeof value.tab === "string" && isPanelTab(value.tab) ? value.tab : fallback.tab,
    };
  } catch {
    return fallback;
  }
}

function savePanelPreference(browser: Window, preference: { open: boolean; tab: DataflowPanelTab }): void {
  try {
    browser.localStorage.setItem("alder.panel", JSON.stringify(preference));
  } catch {
    // Storage can be unavailable in a private or embedded browsing context.
  }
}

function svgNode<K extends keyof SVGElementTagNameMap>(dom: Document, tag: K, attributes: Record<string, string | number>, text = ""): SVGElementTagNameMap[K] {
  const node = dom.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text) node.textContent = text;
  return node;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function remapEditorSelection(
  previous: string,
  next: string,
  selection: { anchor: number; head: number } | null | undefined,
): { anchor: number; head: number } | null {
  if (!selection) return null;
  const oldLength = previous.length;
  const anchor = Math.max(0, Math.min(oldLength, selection.anchor));
  const head = Math.max(0, Math.min(oldLength, selection.head));
  let prefix = 0;
  while (prefix < oldLength && prefix < next.length
    && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < oldLength - prefix && suffix < next.length - prefix
    && previous.charCodeAt(oldLength - suffix - 1) === next.charCodeAt(next.length - suffix - 1)) suffix += 1;
  const mapOffset = (offset: number): number => {
    if (offset <= prefix) return offset;
    if (offset >= oldLength - suffix) return next.length - (oldLength - offset);
    const oldMiddle = oldLength - prefix - suffix;
    const nextMiddle = next.length - prefix - suffix;
    return prefix + Math.round(((offset - prefix) / oldMiddle) * nextMiddle);
  };
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const selected = previous.slice(from, to);
  if (selected.length > 0 && selected.length <= 65_536) {
    const expected = mapOffset(from);
    const before = next.lastIndexOf(selected, expected);
    const after = next.indexOf(selected, expected);
    const best = before < 0 ? after : after < 0 ? before
      : expected - before <= after - expected ? before : after;
    if (best >= 0) {
      return anchor <= head
        ? { anchor: best, head: best + selected.length }
        : { anchor: best + selected.length, head: best };
    }
  }
  return { anchor: mapOffset(anchor), head: mapOffset(head) };
}

function setDisabled(control: HTMLButtonElement | HTMLSelectElement, disabled: boolean): void {
  // Reassigning the same boolean still mutates its reflected DOM attribute.
  if (control.disabled !== disabled) control.disabled = disabled;
}

function safePart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function element<K extends keyof HTMLElementTagNameMap>(dom: Document, tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = dom.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}

const elementNode = element;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notebookRequiresCellReconcile(payload: unknown, configCanChange: boolean): boolean {
  if (!isObject(payload)) return true;
  // Source transactions repeat authoritative order and config. Only actual
  // structural deltas require scanning/reordering every cell view.
  const created = isObject(payload.created) && Object.keys(payload.created).length > 0;
  const deleted = Array.isArray(payload.deleted)
    ? payload.deleted.length > 0
    : typeof payload.deleted === 'string';
  return created || deleted || typeof payload.moved === 'string'
    || (configCanChange && isObject(payload.config));
}

async function encodeFile(file: File): Promise<{ name: string; content_base64: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { name: file.name, content_base64: btoa(binary) };
}
