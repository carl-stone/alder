import { NativeRecoveryStore } from "./recovery-store.js";
import { ALDER_APP_NAME, applyNativeWindowState, assertNativeDialogRuntime, installNativeMenu, nativeWindowOptions } from "./native-shell.mjs";
import { observeSaveAsDestination } from "../../host/src/persistence.js";
import { StructuredDiagnostics, diagnosticError, exportDiagnosticBundle } from "../../host/src/diagnostics.js";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { IPC_CHANNELS } from "./ipc.js";

import {
  acquireNotebookSession,
  sessionKeyFor,
  type AcquireNotebookSessionOptions,
} from "../../host/src/sessions.js";
import {
  resolveApplicationResources,
  type ApplicationResources,
} from "../../host/src/resources.js";
import {
  desktopCommandResultSchema,
  desktopCommandSchema,
  desktopRecoveryRequestSchema,
  desktopDiagnosticSchema,
  decodeHostQueryResultWire,
  decodeJsonFrame,
  encodeHostQueryWire,
  hostQueryResultSchema,
  hostIdentitySchema,
  notebookQueryResultSchema,
  ticketMintRequestSchema,
  ticketMintResponseSchema,
  windowActionSchema,
  windowStateSchema,
  type HostQuery,
  type NotebookQueryResult,
  type SessionConnection,
  type WindowAction,
  type WindowState,
} from "../../host/src/protocol.js";

const APP_NAME = ALDER_APP_NAME;
const MAX_TICKET_RESPONSE_BYTES = 64 * 1024;
const MAX_QUERY_RESPONSE_BYTES = 16 * 1024 * 1024;
const CLOSE_SETTLEMENT_TIMEOUT_MS = 5_000;
const STATE_POLL_MS = 100;
const RENDERER_READY_TIMEOUT_MS = 15_000;
const HOST_MONITOR_MS = 5_000;
const HOST_REQUEST_TIMEOUT_MS = 4_000;
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const NONCE_LOCALHOST_HOST = /^[0-9a-f]{32}\.localhost$/;

/** The small structural surface used from Electron. Keeping it injectable makes
 * security and lifecycle behavior testable without a graphical session. */
export interface ElectronWebContents {
  readonly session?: ElectronSession;
  readonly mainFrame?: { readonly url?: string };
  getURL(): string;
  send(channel: string, value: unknown): void;
  setWindowOpenHandler(handler: (details: ElectronWindowOpenDetails) => ElectronWindowOpenResult): void;
  on(event: string, listener: (...args: never[]) => unknown): this;
  once(event: string, listener: (...args: never[]) => unknown): this;
  isDestroyed?(): boolean;
  reload?(): void;
}

export interface ElectronWindow {
  readonly webContents: ElectronWebContents;
  on(event: string, listener: (...args: never[]) => unknown): this;
  once(event: string, listener: (...args: never[]) => unknown): this;
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  isFocused?(): boolean;
  restore?(): void;
  focus(): void;
  show(): void;
  close(): void;
  destroy(): void;
  loadURL(url: string, options?: { extraHeaders?: string }): Promise<void>;
  setTitle?(title: string): void;
  setDocumentEdited?(edited: boolean): void;
  setRepresentedFilename?(path: string): void;
}

export interface ElectronSession {
  setPermissionRequestHandler?(handler: (webContents: ElectronWebContents, permission: string, callback: (allowed: boolean) => void) => void): void;
  setPermissionCheckHandler?(handler: (webContents: ElectronWebContents, permission: string, requestingOrigin: string, details?: unknown) => boolean): void;
  readonly webRequest?: {
    onBeforeSendHeaders(filter: { urls: string[] } | null, listener?: ((details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders?: Record<string, string> }) => void) => void) | null): void;
    onHeadersReceived(filter: { urls: string[] } | null, listener?: ((details: { resourceType?: string; responseHeaders?: Record<string, string[]> }, callback: (response: { cancel?: boolean; responseHeaders?: Record<string, string[]> }) => void) => void) | null): void;
  };
}

export interface ElectronApp {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: never[]) => unknown): this;
  quit(): void;
  getPath?(name: string): string;
  getVersion?(): string;
  addRecentDocument?(path: string): void;
  clearRecentDocuments?(): void;
}

export interface ElectronBrowserWindowConstructor {
  new (options: Record<string, unknown>): ElectronWindow;
  fromWebContents(contents: ElectronWebContents): ElectronWindow | null;
  getAllWindows?(): ElectronWindow[];
}

export interface ElectronDialog {
  showOpenDialog(options: Record<string, unknown>): Promise<ElectronFileDialogResult>;
  showOpenDialog(window: ElectronWindow, options: Record<string, unknown>): Promise<ElectronFileDialogResult>;
  showSaveDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>;
  showSaveDialog(window: ElectronWindow, options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>;
  showMessageBox(options: Record<string, unknown>): Promise<{ response: number }>;
  showMessageBox(window: ElectronWindow, options: Record<string, unknown>): Promise<{ response: number }>;
}

export interface ElectronMenu {
  buildFromTemplate(template: readonly Record<string, unknown>[]): unknown;
  setApplicationMenu(menu: unknown): void;
}

export interface ElectronShell {
  openExternal(url: string): Promise<void>;
}

export interface ElectronIpcMain {
  handle(channel: string, listener: (event: ElectronIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
}

export interface ElectronRuntime {
  app: ElectronApp;
  BrowserWindow: ElectronBrowserWindowConstructor;
  dialog: ElectronDialog;
  Menu: ElectronMenu;
  shell: ElectronShell;
  session: { readonly defaultSession: ElectronSession };
  ipcMain: ElectronIpcMain;
}

export interface ElectronFileDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface ElectronIpcEvent {
  readonly sender: ElectronWebContents;
  readonly senderFrame?: { readonly url?: string };
  readonly frameId?: number;
}

export interface ElectronWindowOpenDetails {
  readonly url: string;
  readonly disposition?: string;
  readonly referrer?: { readonly url?: string };
}

export interface ElectronWindowOpenResult {
  action: "allow" | "deny";
}

export interface ElectronMainOptions {
  /** Injected only by tests; production obtains this from Electron. */
  readonly runtime?: ElectronRuntime;
  /** Installed application root. Production derives it from process.resourcesPath. */
  readonly applicationRoot?: string;
  readonly resources?: ApplicationResources;
  readonly preloadPath?: string;
  readonly initialPath?: string | null;
  readonly executionMode?: "automatic" | "lazy";
  readonly suppressStartup?: boolean;
  readonly deferStartup?: boolean;
  readonly startupTimeoutMs?: number;
  readonly closeSettlementTimeoutMs?: number;
  readonly acquireSession?: (options: AcquireNotebookSessionOptions) => Promise<SessionConnection>;
  /** Injected by diagnostics tests; production creates the bounded local logger after app readiness. */
  readonly diagnostics?: StructuredDiagnostics;
}

interface ElectronWindowRecord {
  readonly windowId: string;
  readonly openedAt: number;
  readonly window: ElectronWindow;
  readonly keys: Set<string>;
  connection: SessionConnection;
  origin: string;
  dirty: boolean;
  closing: boolean;
  released: boolean;
  closeRequest?: Promise<void>;
  disposal?: Promise<void>;
  monitor?: ReturnType<typeof setInterval>;
  reloadInProgress: boolean;
  monitorInProgress: boolean;
  hostFailureShown: boolean;
  hostRestart?: Promise<void>;
  loadGeneration: number;
  authenticatedRendererGeneration?: number;
  loadingOrigin?: string;
  rendererReadyGeneration: number;
  rendererReady?: { promise: Promise<void>; resolve: () => void };
  windowState: WindowState | null;
  readonly pendingCommands: Map<string, { resolve: (result: ReturnType<typeof desktopCommandResultSchema.parse>) => void; reject: (error: Error) => void }>;
  recoveryId?: string;
  draftId: string;
}

/**
 * Exact application-origin check used for every privileged renderer request.
 * Electron never trusts a renderer frame merely because it belongs to a known
 * BrowserWindow: its current URL must still be the authenticated host origin.
 */
function isTrustedApplicationOrigin(value: string, expectedOrigin: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(expectedOrigin);
    return actual.protocol === "http:" && expected.protocol === "http:" && actual.origin === expected.origin &&
      actual.username === "" && actual.password === "" && expected.username === "" && expected.password === "" &&
      isStrictNonceLocalhostHost(value, actual) && isLoopbackHttpOrigin(expectedOrigin);
  } catch {
    return false;
  }
}

function isStrictNonceLocalhostHost(value: string, parsed: URL): boolean {
  const authority = /^http:\/\/([^/?#]*)/.exec(value)?.[1];
  if (authority === undefined) return false;
  const rawHost = authority.split(":", 1)[0];
  return rawHost === parsed.hostname && NONCE_LOCALHOST_HOST.test(rawHost);
}

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && parsed.username === "" && parsed.password === "" &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "" &&
      parsed.origin === value && isStrictNonceLocalhostHost(value, parsed);
  } catch {
    return false;
  }
}

/**
 * Return a URL that may be handed to the OS browser. Same-origin links, file
 * URLs, javascript/data URLs, credentials, and malformed mailto URLs are not
 * external links and are denied by the BrowserWindow policy.
 */
export function safeExternalUrl(value: string, applicationOrigin: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.protocol === "mailto:") {
    if (parsed.username || parsed.password || parsed.hostname || parsed.pathname.length === 0 || !parsed.pathname.includes("@")) return null;
    return parsed.href;
  }
  if (parsed.username || parsed.password || parsed.origin === applicationOrigin) return null;
  return parsed.href;
}

export function validateNotebookPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("notebook path must be an absolute path without NUL bytes");
  }
  return value;
}

function authenticatedNotebookUrl(origin: string, ticket: string): string {
  if (!isLoopbackHttpOrigin(origin)) throw new Error("desktop host origin is not a loopback HTTP origin");
  if (typeof ticket !== "string" || !/^[0-9a-f]{64}$/.test(ticket)) throw new Error("desktop bootstrap ticket is invalid");
  const url = new URL("/index.html", origin);
  url.searchParams.set("navigation", randomUUID());
  url.hash = `ticket=${encodeURIComponent(ticket)}`;
  return url.href;
}

async function canonicalPathHint(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

export function parseNotebookArgument(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || argument.length === 0 || argument.startsWith("-")) continue;
    if (/\.r$/i.test(argument)) {
      try { return validateNotebookPath(resolve(argument)); } catch { return null; }
    }
  }
  return null;
}

function loadElectronRuntime(): ElectronRuntime {
  // Forge emits a CommonJS main bundle, so this remains an external Electron
  // module and is never pulled into the host/headless bundle.
  return require("electron") as ElectronRuntime;
}

function appRootFromProcess(): string {
  const resourcesPath = typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
    ? process.resourcesPath : resolve(__dirname, "..");
  return join(resourcesPath, "alder");
}

function selectedPath(value: unknown, label: string): string | null {
  if (value === null) return null;
  try { return validateNotebookPath(value); } catch { throw new Error(`${label} returned an invalid path`); }
}

export class ElectronMain {
  private readonly runtime: ElectronRuntime;
  private readonly options: ElectronMainOptions;
  private readonly records = new Set<ElectronWindowRecord>();
  private readonly byKey = new Map<string, Set<ElectronWindowRecord>>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly identityChecks = new WeakMap<ElectronWindowRecord, Promise<void>>();
  private readonly queuedPaths: string[] = [];
  private readonly recentPaths: string[] = [];
  private started = false;
  private stopping = false;
  private menuInstalled = false;
  private quitState: "idle" | "disposing" | "authorized" = "idle";
  private quitPromise?: Promise<void>;
  private readonly pendingDisposals = new Set<Promise<void>>();
  private resourcesPromise?: Promise<ApplicationResources>;
  private recoveryStore?: NativeRecoveryStore;
  private diagnostics?: StructuredDiagnostics;
  private readonly appLaunchId = randomUUID();

  constructor(runtime: ElectronRuntime = loadElectronRuntime(), options: ElectronMainOptions = {}) {
    this.runtime = runtime;
    this.options = options;
    this.diagnostics = options.diagnostics;
    assertNativeDialogRuntime(runtime.dialog);
  }

  async start(): Promise<boolean> {
    if (!this.runtime.app.requestSingleInstanceLock()) {
      this.runtime.app.quit();
      return false;
    }
    this.runtime.app.on("second-instance", (_event: unknown, commandLine: string[]) => {
      const path = parseNotebookArgument(commandLine);
      if (path) this.queueOrOpen(path);
      else this.focusOrOpenUntitled();
    });
    this.runtime.app.on("open-file", (event: { preventDefault?: () => void }, path: string) => {
      event.preventDefault?.();
      try {
        const absolute = validateNotebookPath(path);
        this.queueOrOpen(absolute);
      } catch {
        void this.showApplicationError("Open", "The requested notebook path is invalid.");
      }
    });
    this.runtime.app.on("activate", () => this.focusOrOpenUntitled());
    if (process.platform === "darwin") this.runtime.app.on("window-all-closed", () => undefined);
    this.runtime.app.on("before-quit", (event: { preventDefault?: () => void }) => {
      if (this.quitState === "authorized") return;
      event.preventDefault?.();
      if (this.quitState === "disposing") return;
      this.quitState = "disposing";
      const quit = this.finishApplicationQuit();
      this.quitPromise = quit;
      void quit.finally(() => { if (this.quitPromise === quit) this.quitPromise = undefined; });
    });

    await this.runtime.app.whenReady();
    const userData = this.runtime.app.getPath?.("userData");
    if (userData && !this.diagnostics) {
      const appVersion = this.runtime.app.getVersion?.() ?? "unknown";
      const buildId = process.env.ALDER_BUILD_ID ?? appVersion;
      this.diagnostics = new StructuredDiagnostics({
        rootDir: join(userData, "diagnostics"), role: "desktop", component: "desktop",
        appLaunchId: this.appLaunchId, appVersion, buildId,
      });
      process.env.ALDER_DIAGNOSTICS_DIR = join(userData, "diagnostics");
      process.env.ALDER_APP_LAUNCH_ID = this.appLaunchId;
      process.env.ALDER_APP_VERSION = appVersion;
      process.env.ALDER_BUILD_ID = buildId;
      this.diagnostics.record("info", "desktop.launch", { cold: true });
    } else if (this.diagnostics) {
      this.diagnostics.record("info", "desktop.launch", { cold: true });
    }
    this.started = true;
    this.installPermissionDenials();
    this.installIpcHandlers();
    this.installMenu();

    const initial = this.options.initialPath !== undefined
      ? this.options.initialPath
      : parseNotebookArgument(typeof process !== "undefined" ? process.argv.slice(1) : []);
    if (initial === null) {
      if (this.queuedPaths.length === 0) await this.openNotebook(null);
    } else if (initial !== undefined) await this.openNotebook(initial);
    while (this.queuedPaths.length > 0) {
      const path = this.queuedPaths.shift();
      if (path) await this.openNotebook(path);
    }
    return true;
  }

  windows(): readonly ElectronWindow[] {
    return [...this.records].map(record => record.window);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.releaseAll();
    this.diagnostics?.record("info", "desktop.quit", { outcome: "success" });
    await this.diagnostics?.close();
  }

  async openNotebook(path: string | null, options: { newWindow?: boolean } = {}): Promise<void> {
    if (this.stopping) throw new Error("desktop application is stopping");
    if (path !== null) path = validateNotebookPath(path);
    const hint = path === null ? null : await canonicalPathHint(path);
    if (hint !== null) {
      const pending = this.pending.get(hint);
      if (pending) await pending;
      if (!options.newWindow) {
        const prior = [...(this.byKey.get(hint) ?? [])].filter(record => !record.released);
        await Promise.allSettled(prior.map(record => this.assertHostContinuity(record)));
        if (prior.length === 0 && !this.byKey.has(hint)) {
          await Promise.allSettled([...this.records].filter(record => !record.released).map(record => this.assertHostContinuity(record)));
        }
        const existing = this.byKey.get(hint)?.values().next().value as ElectronWindowRecord | undefined;
        if (existing && !existing.released) {
          this.focus(existing);
          return;
        }
      }
    }
    const key = hint ?? `untitled:${Date.now()}:${Math.random()}`;
    const operation = this.createWindow(path, hint);
    if (hint !== null) this.pending.set(key, operation);
    try { await operation; } finally { if (hint !== null && this.pending.get(key) === operation) this.pending.delete(key); }
  }

  private async createWindow(path: string | null, hint: string | null): Promise<void> {
    const resources = await this.applicationResources();
    const acquire = this.options.acquireSession ?? acquireNotebookSession;
    let connection: SessionConnection;
    try {
      connection = await acquire({
        path,
        ...(path === null ? { untitledProjectDirectory: this.runtime.app.getPath?.("home") ?? process.cwd() } : {}),
        resources,
        ...(this.options.executionMode === undefined ? {} : { executionMode: this.options.executionMode }),
        suppressStartup: this.options.suppressStartup ?? false,
        deferStartup: this.options.deferStartup ?? true,
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
    } catch (error) {
      await this.showApplicationError("Open notebook", error instanceof Error ? error.message : "The notebook host could not be started.");
      throw error;
    }

    const canonical = connection.canonicalPath;
    let ticket: string;
    try {
      ticket = await this.mintTicket(connection);
    } catch (error) {
      await this.releaseDiscardedConnection(connection);
      await this.showApplicationError("Open notebook", error instanceof Error ? error.message : "The notebook authentication ticket could not be created.");
      throw error;
    }

    const window = new this.runtime.BrowserWindow(nativeWindowOptions(
      this.options.preloadPath ?? join(__dirname, "preload.cjs"),
      // Authentication lasts only for this window; draft files are stored by the native bridge.
      "alder-" + randomUUID(),
    ));
    window.webContents.session?.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    window.webContents.session?.setPermissionCheckHandler?.(() => false);
    const record: ElectronWindowRecord = {
      windowId: randomUUID(),
      openedAt: performance.now(),
      window,
      keys: new Set<string>(),
      draftId: randomUUID(),
      connection,
      origin: connection.browserOrigin,
      dirty: false,
      closing: false,
      released: false,
      reloadInProgress: false,
      monitorInProgress: false,
      hostFailureShown: false,
      loadGeneration: 0,
      rendererReadyGeneration: 0,
      windowState: null,
      pendingCommands: new Map(),
    };
    this.diagnostics?.record("info", "window.open", {
      windowId: record.windowId, sessionId: connection.sessionKey, sessionEpoch: connection.epoch,
      cold: ![...this.records].some(item => item.connection.sessionKey === connection.sessionKey),
      path: canonical, origin: connection.origin, browserOrigin: connection.browserOrigin,
    });
    record.keys.add(canonical ?? `session:${connection.sessionKey}`);
    if (hint !== null) record.keys.add(hint);
    this.records.add(record);
    for (const key of record.keys) this.addRecordKey(key, record);
    if (canonical !== null) this.rememberRecent(canonical);
    this.installWindowPolicy(record);
    window.once("ready-to-show", () => window.show());
    window.on("close", (event: { preventDefault?: () => void }) => {
      if (this.stopping) return;
      event.preventDefault?.();
      if (!record.closing) void this.requestClose(record);
    });
    window.on("closed", () => { void this.disposeRecord(record); });
    applyNativeWindowState(window, { path: canonical, dirty: false });
    try {
      await this.loadAuthenticatedNotebook(record, ticket);
    } catch (error) {
      await this.showApplicationError("Open notebook", error instanceof Error ? error.message : "The notebook window could not be loaded.");
      await this.disposeRecord(record);
      if (!record.window.isDestroyed()) record.window.destroy();
      throw error;
    }
    record.monitor = setInterval(() => { void this.monitorHost(record); }, HOST_MONITOR_MS);
    record.monitor.unref?.();
  }

  private async loadAuthenticatedNotebook(record: ElectronWindowRecord, ticket: string, connection: SessionConnection = record.connection): Promise<void> {
    const webRequest = record.window.webContents.session?.webRequest;
    if (webRequest === undefined) throw new Error("Electron response interception is unavailable");
    const generation = (record.loadGeneration ?? 0) + 1;
    record.loadGeneration = generation;
    record.windowState = null;
    record.rendererReadyGeneration = generation;
    let resolveRendererReady!: () => void;
    const rendererReadyPromise = new Promise<void>(resolve => { resolveRendererReady = resolve; });
    record.rendererReady = { promise: rendererReadyPromise, resolve: resolveRendererReady };
    const origin = connection.browserOrigin;
    const continuityProof = connection.continuityProof;
    record.loadingOrigin = origin;
    let bootstrapTicket: string | null = ticket;
    let receivedMainFrame = false;
    webRequest.onBeforeSendHeaders({ urls: [origin + "/*"] }, (details, callback) => {
      if (record.loadGeneration !== generation) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const requestHeaders = { ...details.requestHeaders };
      if (bootstrapTicket !== null) requestHeaders["X-Alder-Bootstrap-Ticket"] = bootstrapTicket;
      callback({ requestHeaders });
    });
    webRequest.onHeadersReceived({ urls: [origin + "/*"] }, (details, callback) => {
      if (record.loadGeneration !== generation) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      if (details.resourceType !== "mainFrame") {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      receivedMainFrame = true;
      const headers = details.responseHeaders ?? {};
      const proofHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-alder-continuity-proof")?.[1];
      const proof = Array.isArray(proofHeader) ? proofHeader[0] : proofHeader;
      callback(proof === continuityProof
        ? { responseHeaders: details.responseHeaders }
        : { cancel: true });
    });
    try {
      await record.window.loadURL(authenticatedNotebookUrl(origin, ticket));
      if (record.loadGeneration !== generation) throw new Error("Electron notebook load was superseded");
      if (!receivedMainFrame) throw new Error("Electron did not authenticate the notebook response");
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error("Electron notebook renderer did not become ready")), RENDERER_READY_TIMEOUT_MS);
        rendererReadyPromise.then(() => { clearTimeout(timeout); resolveReady(); }, rejectReady);
      });
      record.authenticatedRendererGeneration = generation;
      this.diagnostics?.record("info", "renderer.ready", {
        windowId: record.windowId, sessionId: connection.sessionKey, sessionEpoch: connection.epoch,
        rendererGeneration: generation, durationMs: Math.round(performance.now() - record.openedAt), ready: true,
      });
    } finally {
      bootstrapTicket = null;
      if (record.loadGeneration === generation) record.loadingOrigin = undefined;
    }
  }
  private async mintTicket(connection: SessionConnection): Promise<string> {
    const request = ticketMintRequestSchema.parse({ origin: connection.browserOrigin, parentLeaseId: connection.leaseId });
    const response = await connection.request("/api/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`desktop host ticket request failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const value = ticketMintResponseSchema.parse(decodeJsonFrame(bytes, MAX_TICKET_RESPONSE_BYTES));
    return value.ticket;
  }

  private installPermissionDenials(): void {
    const desktopSession = this.runtime.session.defaultSession;
    desktopSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    desktopSession.setPermissionCheckHandler?.(() => false);
  }

  private installIpcHandlers(): void {
    const ipc = this.runtime.ipcMain;
    const noArguments = <T>(channel: string, handler: (record: ElectronWindowRecord) => Promise<T> | T): void => {
      ipc.removeHandler?.(channel);
      ipc.handle(channel, async (event, ...args) => {
        if (args.length !== 0) throw new Error("desktop IPC arguments are not permitted");
        return handler(this.recordForEvent(event));
      });
    };
    ipc.removeHandler?.(IPC_CHANNELS.recovery);
    ipc.handle(IPC_CHANNELS.recovery, async (event, ...args) => {
      const record = this.recordForEvent(event);
      if (args.length !== 1) throw new Error("Recovery requires one request");
      const request = desktopRecoveryRequestSchema.parse(args[0]);
      if (record.recoveryId && request.recoveryId !== record.recoveryId) throw new Error("Recovery identity changed");
      record.recoveryId = request.recoveryId;
      const userData = this.runtime.app.getPath?.("userData");
      if (!userData) throw new Error("Desktop recovery storage is unavailable");
      const store = this.recoveryStore ??= new NativeRecoveryStore(join(userData, "document-recovery"));
      switch (request.action) {
        case "read": return store.read(request.recoveryId, request.name ?? "");
        case "write": return store.write(request.recoveryId, request.name ?? "", request.value);
        case "remove": return store.remove(request.recoveryId, request.name ?? "");
        case "list": {
          if (request.name !== undefined || request.value !== undefined) throw new Error("Draft inventory does not accept a record");
          const inventory = await store.listDrafts(request.recoveryId);
          const active = new Set([...this.records].filter(item => !item.released).map(item => item.draftId));
          return { ...inventory, draftIds: inventory.draftIds.filter(id => !active.has(id)) };
        }
        case "claim": {
          const name = request.name ?? "";
          if (!/^draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(name) || request.value !== undefined) throw new Error("Invalid draft claim");
          const draftId = name.slice("draft:".length);
          if (await store.read(request.recoveryId, name) === null) throw new Error("The selected draft is no longer available");
          if (await store.read(request.recoveryId, "draft:" + record.draftId) !== null) throw new Error("This window already has unsaved local edits");
          if ([...this.records].some(item => item !== record && !item.released && item.draftId === draftId)) throw new Error("Another window is already using this draft");
          record.draftId = draftId;
          this.notifyRetainedDraftsChanged(request.recoveryId);
          return;
        }
      }
    });
    noArguments(IPC_CHANNELS.openNotebook, async (record) => {
      const result = await this.runtime.dialog.showOpenDialog(record.window, {
        title: "Open Alder notebook",
        properties: ["openFile"],
        filters: [{ name: "R source", extensions: ["R", "r"] }],
      });
      if (result.canceled || result.filePaths.length === 0) return undefined;
      const path = selectedPath(result.filePaths[0], "Open notebook");
      if (path) await this.openReplacingPristineUntitled(record, path);
      return undefined;
    });
    noArguments(IPC_CHANNELS.restartHost, record => this.restartHost(record));
    noArguments(IPC_CHANNELS.chooseSavePath, async (record) => {
      const result = await this.runtime.dialog.showSaveDialog(record.window, {
        title: "Save notebook",
        message: "Choose where to save this R notebook.",
        properties: ["createDirectory"],
        filters: [{ name: "R source", extensions: ["R", "r"] }],
      });
      if (result.canceled || !result.filePath) return null;
      const path = selectedPath(result.filePath, "Save path");
      if (path === null) return null;
      const observation = await observeSaveAsDestination(path);
      if (observation.state === "absent") return { path, expectedDestination: "absent" };
      if (observation.state !== "present" || observation.digest === null || observation.version === null) throw new Error("The destination could not be read.");
      // macOS Save panels confirm replacement before returning an existing path.
      return { path, expectedDestination: { expectedDiskDigest: observation.digest, expectedDiskVersion: observation.version } };
    });
    noArguments(IPC_CHANNELS.chooseRscript, async (record) => {
      const result = await this.runtime.dialog.showOpenDialog(record.window, {
        title: "Choose R installation",
        properties: ["openFile"],
        filters: [{ name: "Rscript", extensions: ["Rscript", ""] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return selectedPath(result.filePaths[0], "Rscript path");
    });
    noArguments(IPC_CHANNELS.getDraftId, record => record.draftId);
    noArguments(IPC_CHANNELS.rendererReady, (record) => {
      if (record.rendererReadyGeneration === record.loadGeneration) record.rendererReady?.resolve();
    });
    ipc.removeHandler?.(IPC_CHANNELS.diagnostic);
    ipc.handle(IPC_CHANNELS.diagnostic, async (event, ...args) => {
      if (args.length !== 1) throw new Error("Desktop diagnostic requires one value");
      const record = this.recordForEvent(event);
      const diagnostic = desktopDiagnosticSchema.parse(args[0]);
      if (diagnostic.event !== "run.visible") {
        this.diagnostics?.record("error", diagnostic.event, {
          windowId: record.windowId, sessionId: record.connection.sessionKey, sessionEpoch: record.connection.epoch,
          reason: diagnostic.category, outcome: "error", error: diagnostic.error,
          filename: diagnostic.filename, line: diagnostic.line, column: diagnostic.column,
        });
        return;
      }
      this.diagnostics?.record("info", diagnostic.event, {
        windowId: record.windowId, sessionId: record.connection.sessionKey, sessionEpoch: record.connection.epoch,
        operationId: diagnostic.operationId, runId: diagnostic.runId, cellId: diagnostic.cellId,
        cellRevision: diagnostic.revision, durationMs: Math.round(diagnostic.inputToVisibleMs),
        dispatchMs: Math.round(diagnostic.inputToHandlerMs), visibleMs: Math.round(diagnostic.handlerToVisibleMs),
        phase: "visible-result", mode: diagnostic.proxy,
      });
      const response = await record.connection.request("/api/diagnostics/phase", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          operationId: diagnostic.operationId, runId: diagnostic.runId, cellId: diagnostic.cellId,
          revision: diagnostic.revision, phase: "visible-result", durationMs: diagnostic.inputToVisibleMs,
        }),
      });
      if (!response.ok) throw new Error("The host rejected renderer timing metadata.");
    });
    ipc.removeHandler?.(IPC_CHANNELS.windowState);
    ipc.handle(IPC_CHANNELS.windowState, (event, ...args) => {
      if (args.length !== 1) throw new Error("Window state requires one value");
      const record = this.recordForEvent(event);
      const state = windowStateSchema.parse(args[0]);
      if (state.sessionEpoch !== record.connection.epoch) throw new Error("Window state belongs to another session");
      if (state.path !== record.connection.canonicalPath) {
        if (state.path === null) throw new Error("A named notebook cannot return to an untitled identity");
        this.adoptHostIdentity(record, sessionKeyFor(state.path), state.path);
      }
      record.windowState = state;
      record.dirty = state.dirty;
      applyNativeWindowState(record.window, state);
    });
    ipc.removeHandler?.(IPC_CHANNELS.commandResult);
    ipc.handle(IPC_CHANNELS.commandResult, (event, ...args) => {
      if (args.length !== 1) throw new Error("Desktop command result requires one value");
      const record = this.recordForEvent(event);
      const result = desktopCommandResultSchema.parse(args[0]);
      record.pendingCommands.get(result.requestId)?.resolve(result);
    });
  }

  private recordForEvent(event: ElectronIpcEvent): ElectronWindowRecord {
    const sender = event?.sender;
    if (!sender) throw new Error("desktop IPC sender is missing");
    const window = this.runtime.BrowserWindow.fromWebContents(sender);
    const record = window ? [...this.records].find(item => item.window === window) : undefined;
    if (!record || record.released) throw new Error("desktop IPC sender is not an active application window");
    if (!event.senderFrame || !sender.mainFrame || event.senderFrame !== sender.mainFrame) throw new Error("desktop IPC is restricted to the main frame");
    const frameUrl = event.senderFrame.url ?? sender.getURL();
    if (!isTrustedApplicationOrigin(frameUrl, record.loadingOrigin ?? record.origin)) throw new Error("desktop IPC origin is not trusted");
    return record;
  }

  private installWindowPolicy(record: ElectronWindowRecord): void {
    const contents = record.window.webContents;
    contents.on("unresponsive", () => {
      this.diagnostics?.record("warn", "renderer.unresponsive", {
        windowId: record.windowId, sessionEpoch: record.connection.epoch, reason: "unresponsive", outcome: "error",
      });
    });
    contents.on("responsive", () => {
      this.diagnostics?.record("info", "renderer.responsive", {
        windowId: record.windowId, sessionEpoch: record.connection.epoch, reason: "responsive", outcome: "success",
      });
    });
    contents.on("did-fail-load", (_event: unknown, errorCode: number, description: string, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.diagnostics?.record("error", "renderer.load_failed", {
        windowId: record.windowId, sessionEpoch: record.connection.epoch, reason: "load-failed",
        status: errorCode, description, url, outcome: "error",
      });
    });
    contents.setWindowOpenHandler(details => {
      const expectedOrigin = record.loadingOrigin ?? record.origin;
      const external = safeExternalUrl(details.url, expectedOrigin);
      // Electron does not expose a portable userGesture bit on this callback;
      // requiring an ordinary foreground/default disposition and a same-origin
      const disposition = details.disposition ?? "default";
      const referrerUrl = details.referrer?.url;
      const trustedOpener = referrerUrl
        ? isTrustedApplicationOrigin(referrerUrl, expectedOrigin)
        : isTrustedApplicationOrigin(contents.getURL(), expectedOrigin);
      if (external !== null && (disposition === "default" || disposition === "foreground-tab") && trustedOpener) {
        void this.runtime.shell.openExternal(external).catch(() => undefined);
      }
      return { action: "deny" };
    });
    contents.on("will-prevent-unload", (event: { preventDefault?: () => void }) => {
      // An approved host restart reloads from native recovery storage.
      if (record.loadingOrigin !== undefined) event.preventDefault?.();
    });
    contents.on("will-navigate", (event: { preventDefault?: () => void }, url: string) => {
      if (!isTrustedApplicationOrigin(url, record.loadingOrigin ?? record.origin)) event.preventDefault?.();
    });
    contents.on("will-frame-navigate", (event: { preventDefault?: () => void }, url: string) => {
      if (!isTrustedApplicationOrigin(url, record.loadingOrigin ?? record.origin)) event.preventDefault?.();
    });
    contents.on("render-process-gone", (_event: unknown, details: { reason?: string; exitCode?: number }) => {
      if (record.released || record.reloadInProgress) return;
      this.diagnostics?.record("error", "renderer.gone", {
        windowId: record.windowId, sessionEpoch: record.connection.epoch,
        reason: details?.reason ?? "unknown", exitCode: details?.exitCode ?? null, details, outcome: "error",
      });
      record.reloadInProgress = true;
      void this.recoverRenderer(record).finally(() => { record.reloadInProgress = false; });
    });
  }

  private async recoverRenderer(record: ElectronWindowRecord): Promise<void> {
    while (!record.released) {
      try {
        const ticket = await this.mintTicket(record.connection);
        await this.loadAuthenticatedNotebook(record, ticket);
        this.diagnostics?.record("info", "renderer.recovered", {
          windowId: record.windowId, sessionEpoch: record.connection.epoch,
          rendererGeneration: record.loadGeneration, outcome: "success",
        });
        return;
      } catch (error) {
        this.diagnostics?.record("error", "renderer.recovery_failed", {
          windowId: record.windowId, sessionEpoch: record.connection.epoch,
          rendererGeneration: record.loadGeneration, outcome: "error",
          errorCode: (error as NodeJS.ErrnoException)?.code ?? "renderer_recovery_failed",
          error: diagnosticError(error),
        });
        const answer = await this.runtime.dialog.showMessageBox(record.window, {
          type: "error", title: "Renderer recovery", message: "The notebook editor could not be reloaded.",
          detail: `${error instanceof Error ? error.message : "Renderer reload failed."}\n\n${record.connection.canonicalPath === null
            ? "This untitled notebook has no file to reopen. Retry Reload to restore available recovery data before closing."
            : "Alder recovery data remains available. Closing this window does not save the notebook; reopen it to review unsaved work."}`,
          buttons: ["Retry Reload", "Close Window"], defaultId: 0, cancelId: 1,
        });
        if (record.released) return;
        if (answer.response === 0) continue;
        if (await this.closeFailedRenderer(record)) return;
      }
    }
  }

  private async closeFailedRenderer(record: ElectronWindowRecord): Promise<boolean> {
    await this.disposeRecord(record);
    if (!record.window.isDestroyed()) record.window.destroy();
    return true;
  }

  private async dispatchAction(record: ElectronWindowRecord, action: WindowAction, timeoutMs = 30_000): Promise<"ok" | "cancelled"> {
    if (record.released || record.window.webContents.isDestroyed?.()) throw new Error("Desktop window is unavailable");
    const requestId = randomUUID();
    const command = desktopCommandSchema.parse({ requestId, action: windowActionSchema.parse(action) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<ReturnType<typeof desktopCommandResultSchema.parse>>((resolveResult, rejectResult) => {
      record.pendingCommands.set(requestId, { resolve: resolveResult, reject: rejectResult });
      timer = setTimeout(() => {
        this.diagnostics?.record("warn", "native_command.timeout", {
          windowId: record.windowId, sessionEpoch: record.connection.epoch, kind: action,
          requestId, durationMs: timeoutMs, outcome: "error", errorCode: "command_timeout",
        });
        rejectResult(new Error("The editor did not complete the native command."));
      }, timeoutMs);
    });
    try {
      this.diagnostics?.record("info", "native_command.started", {
        windowId: record.windowId, sessionId: record.connection.sessionKey, sessionEpoch: record.connection.epoch,
        requestId, action, command,
      });
      record.window.webContents.send(IPC_CHANNELS.desktopCommand, command);
      const completed = await result;
      this.diagnostics?.record(completed.status === "error" ? "error" : "info", "native_command.settled", {
        windowId: record.windowId, sessionId: record.connection.sessionKey, sessionEpoch: record.connection.epoch,
        requestId, action, result: completed,
      });
      if (completed.status === "error") throw new Error(completed.message ?? "The editor command failed.");
      return completed.status;
    } catch (error) {
      this.diagnostics?.record("error", "native_command.failed", {
        windowId: record.windowId, sessionId: record.connection.sessionKey, sessionEpoch: record.connection.epoch,
        requestId, action, command, error: diagnosticError(error),
      });
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      record.pendingCommands.delete(requestId);
    }
  }

  private installMenu(): void {
    if (this.menuInstalled) return;
    this.menuInstalled = true;
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    const dispatch = (name: WindowAction): void => {
      const record = this.focusedRecord() ?? this.firstRecord();
      if (record) void this.dispatchAction(record, name).catch(error => this.showApplicationError("Alder", error instanceof Error ? error.message : String(error)));
    };
    installNativeMenu(this.runtime.Menu, {
      newNotebook: () => { void this.openNotebook(null); },
      openNotebook: () => { void this.openNotebookFromDialog(this.focusedRecord() ?? this.firstRecord()); },
      openNotebookInNewWindow: () => { void this.openNotebookFromDialog(undefined, true); },
      openRecent: path => { void this.openNotebook(path); },
      dispatch,
      closeWindow: () => { const record = this.focusedRecord(); if (record) void this.requestClose(record); },
      diagnostics: () => { void this.showDiagnostics().catch(() => this.showDiagnosticsError()); },
    }, this.recentPaths);
  }

  private async openNotebookFromDialog(source: ElectronWindowRecord | undefined, newWindow = false): Promise<void> {
    const options = {
      title: "Open Alder notebook",
      properties: ["openFile"],
      filters: [{ name: "R source", extensions: ["R", "r"] }],
    };
    const result = source
      ? await this.runtime.dialog.showOpenDialog(source.window, options)
      : await this.runtime.dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return;
    const path = selectedPath(result.filePaths[0], "Open notebook");
    if (path) await (source && !newWindow ? this.openReplacingPristineUntitled(source, path) : this.openNotebook(path, { newWindow }));
  }

  private requestClose(record: ElectronWindowRecord): Promise<void> {
    if (record.released) return Promise.resolve();
    if (record.closeRequest) return record.closeRequest;
    let tracked!: Promise<void>;
    tracked = this.performRequestClose(record).finally(() => { if (record.closeRequest === tracked) record.closeRequest = undefined; });
    record.closeRequest = tracked;
    return tracked;
  }

  private async performRequestClose(record: ElectronWindowRecord): Promise<void> {
    if (record.released) return;
    record.closing = true;
    let finished = false;
    try {
      const state = await this.readWindowState(record);
      if (!state.dirty) {
        await this.prepareRendererUnload(record);
        await this.finishClose(record);
        finished = true;
        return;
      }
      const answer = await this.runtime.dialog.showMessageBox(record.window, {
        type: "warning",
        title: "Save notebook changes?",
        message: "This notebook has unsaved changes.",
        detail: "Save your changes before closing, or keep this window open to continue editing.",
        buttons: ["Save", "Discard", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      });
      if (answer.response === 2) return;
      if (answer.response === 1) {
        await this.prepareRendererUnload(record);
        await this.dispatchAction(record, "close");
        if (!record.released) await this.disposeRecord(record);
        if (!record.window.isDestroyed()) record.window.destroy();
        finished = true;
        return;
      }
      if (await this.dispatchAction(record, "save") === "cancelled") return;
      const settled = await this.waitForClean(record, this.options.closeSettlementTimeoutMs ?? CLOSE_SETTLEMENT_TIMEOUT_MS);
      if (!settled) {
        await this.showApplicationError("Save", "The save operation did not settle; the window remains open.");
        return;
      }
      await this.prepareRendererUnload(record);
      await this.finishClose(record);
      finished = true;
    } catch (error) {
      try {
        await this.prepareRendererUnload(record);
      } catch (flushError) {
        await this.showApplicationError("Close notebook", flushError instanceof Error ? flushError.message : "The editor could not preserve its latest draft.");
        return;
      }
      const answer = await this.runtime.dialog.showMessageBox(record.window, {
        type: "warning", title: "Keep notebook recovery?",
        message: "The notebook host did not complete the close action.",
        detail: `${error instanceof Error ? error.message : "The host is unavailable."}\n\nClose and keep recovery preserves unsaved work for reopening. It does not save or discard the notebook.`,
        buttons: ["Close and Keep Recovery", "Keep Window Open"], defaultId: 1, cancelId: 1,
      });
      if (answer.response === 0) {
        await this.finishClose(record);
        finished = true;
      }
    } finally {
      if (!finished) record.closing = false;
    }
  }

  private async finishClose(record: ElectronWindowRecord): Promise<void> {
    if (record.released) return;
    record.closing = true;
    await this.disposeRecord(record);
    if (!record.window.isDestroyed()) record.window.destroy();
  }

  private async prepareRendererUnload(record: ElectronWindowRecord): Promise<void> {
    if (record.released || record.window.webContents.isDestroyed?.()) return;
    await this.dispatchAction(record, "prepare-unload", 3_000);
  }

  private async waitForClean(record: ElectronWindowRecord, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!record.released && Date.now() < deadline) {
      if (!(await this.readWindowState(record)).dirty) return true;
      await new Promise(resolvePromise => setTimeout(resolvePromise, STATE_POLL_MS));
    }
    return false;
  }
  private async readWindowState(record: ElectronWindowRecord): Promise<WindowState> {
    const state = record.windowState ?? windowStateSchema.parse({ path: record.connection.canonicalPath, dirty: true, saveState: "edited", sessionEpoch: record.connection.epoch });
    record.dirty = state.dirty;
    return state;
  }

  private async assertHostContinuity(record: ElectronWindowRecord): Promise<void> {
    const previous = this.identityChecks.get(record);
    const check = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (record.released) throw new Error("desktop application window is released");
      const connection = record.connection;
      const generation = record.loadGeneration;
      const path = connection.canonicalPath;
      const sessionKey = connection.sessionKey;
      const superseded = (): boolean => record.released || record.connection !== connection || record.loadGeneration !== generation
        || connection.canonicalPath !== path || connection.sessionKey !== sessionKey;
      let response: Response;
      try { response = await connection.request("/api/identity", { method: "GET", signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS) }); }
      catch (error) { if (superseded()) return; throw error; }
      if (superseded()) return;
      if (!response.ok) throw new Error("desktop host identity query failed (" + response.status + ")");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (superseded()) return;
      if (bytes.byteLength > MAX_QUERY_RESPONSE_BYTES) throw new Error("desktop host identity response is too large");
      const identity = hostIdentitySchema.parse(decodeJsonFrame(bytes, MAX_QUERY_RESPONSE_BYTES));
      if (identity.continuityProof !== connection.continuityProof || identity.epoch !== connection.epoch ||
        identity.origin !== connection.origin || identity.browserOrigin !== connection.browserOrigin) {
        throw new Error("desktop host process identity changed");
      }
      const pathChanged = identity.canonicalPath !== connection.canonicalPath;
      const sessionChanged = identity.sessionKey !== connection.sessionKey;
      if (pathChanged !== sessionChanged || (pathChanged && identity.canonicalPath === null)) {
        throw new Error("desktop host path identity changed without an authoritative Save As");
      }
      if (superseded()) return;
      if (pathChanged) this.adoptHostIdentity(record, identity.sessionKey, identity.canonicalPath);
    });
    this.identityChecks.set(record, check);
    try {
      await check;
    } finally {
      if (this.identityChecks.get(record) === check) this.identityChecks.delete(record);
    }
  }

  private adoptHostIdentity(record: ElectronWindowRecord, sessionKey: string, canonicalPath: string | null): void {
    const nextKey = canonicalPath ?? "session:" + sessionKey;
    this.removeRecordKeys(record);
    record.connection.sessionKey = sessionKey;
    record.connection.canonicalPath = canonicalPath;
    record.keys.clear();
    record.keys.add(nextKey);
    this.addRecordKey(nextKey, record);
    if (canonicalPath !== null) {
      this.rememberRecent(canonicalPath);
      record.window.setTitle?.(basename(canonicalPath) + " — " + APP_NAME);
    }
  }

  private async querySnapshot(record: ElectronWindowRecord): Promise<NotebookQueryResult> {
    await this.assertHostContinuity(record);
    const connection = record.connection;
    const query: HostQuery = { type: "notebook" };
    const response = await connection.request("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodeHostQueryWire(query)),
      signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("desktop host state query failed (" + response.status + ")");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_QUERY_RESPONSE_BYTES) throw new Error("desktop host state response is too large");
    const wire = decodeJsonFrame(bytes, MAX_QUERY_RESPONSE_BYTES);
    const decoded = decodeHostQueryResultWire(query, wire);
    const envelope = hostQueryResultSchema.parse(decoded);
    return notebookQueryResultSchema.parse(envelope.result);
  }
  private async monitorHost(record: ElectronWindowRecord): Promise<void> {
    if (record.released || record.hostRestart || record.hostFailureShown || record.monitorInProgress || this.hasAuthenticatedRenderer(record)) return;
    record.monitorInProgress = true;
    try {
      await this.assertHostContinuity(record);
    } catch (error) {
      if (record.released || record.hostRestart) return;
      // An authenticated page has its own actionable connection banner. A native
      // sheet would hide its Restart host button and can outlive a successful retry.
      if (this.hasAuthenticatedRenderer(record)) return;
      const failedConnection = record.connection;
      record.hostFailureShown = true;
      const answer = await this.runtime.dialog.showMessageBox(record.window, {
        type: "error",
        title: "Alder host unavailable",
        message: "The shared notebook host is no longer responding.",
        detail: error instanceof Error ? error.message : "The host process may have exited.",
        buttons: ["Restart host", "Close"],
        defaultId: 0,
        cancelId: 1,
      }).catch(() => ({ response: 1 }));
      if (record.released || record.hostRestart || record.connection !== failedConnection) return;
      if (answer.response === 0 && !record.released) await this.restartHost(record);
      else if (!record.released) await this.requestClose(record);
    } finally {
      record.monitorInProgress = false;
      record.hostFailureShown = false;
    }
  }

  private restartHost(record: ElectronWindowRecord): Promise<void> {
    if (record.released) return Promise.resolve();
    if (record.hostRestart) return record.hostRestart;
    const attempt = this.performHostRestart(record);
    record.hostRestart = attempt;
    void attempt.then(() => { if (record.hostRestart === attempt) record.hostRestart = undefined; },
      () => { if (record.hostRestart === attempt) record.hostRestart = undefined; });
    return attempt;
  }

  private hasAuthenticatedRenderer(record: ElectronWindowRecord): boolean {
    return record.authenticatedRendererGeneration === record.loadGeneration && !record.window.webContents.isDestroyed?.();
  }

  private async performHostRestart(record: ElectronWindowRecord): Promise<void> {
    let old = record.connection;
    let next: SessionConnection | undefined;
    let navigationStarted = false;
    try {
      // Preserve live edits while an authenticated page can still answer IPC.
      // After failed navigation and rollback, the first flush is already stored.
      if (this.hasAuthenticatedRenderer(record)) await this.prepareRendererUnload(record);
      try { await this.assertHostContinuity(record); }
      catch (error) {
        if (record.windowState && record.windowState.path !== record.connection.canonicalPath) throw error;
      }
      old = record.connection;
      const resources = await this.applicationResources();
      const acquire = this.options.acquireSession ?? acquireNotebookSession;
      next = await acquire({
        path: old.canonicalPath,
        ...(old.canonicalPath === null ? { untitledRecoveryId: old.sessionKey } : {}),
        resources,
        ...(this.options.executionMode === undefined ? {} : { executionMode: this.options.executionMode }),
        suppressStartup: this.options.suppressStartup ?? false,
        deferStartup: this.options.deferStartup ?? true,
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
      if (next === old) throw new Error("desktop host restart returned the active lease");
      const ticket = await this.mintTicket(next);
      if (record.released) {
        await this.releaseDiscardedConnection(next);
        return;
      }
      // Keep the old lease and identity authoritative until the replacement
      // page has passed its authenticated response check.
      navigationStarted = true;
      await this.loadAuthenticatedNotebook(record, ticket, next);
      if (record.released) {
        await this.releaseDiscardedConnection(next);
        return;
      }
      this.replaceConnection(record, next);
      await this.releaseDiscardedConnection(old);
    } catch (error) {
      if (next !== undefined && next !== record.connection) await this.releaseDiscardedConnection(next);
      if (!record.released && navigationStarted) {
        try {
          const rollbackTicket = await this.mintTicket(old);
          await this.loadAuthenticatedNotebook(record, rollbackTicket, old);
        } catch (rollbackError) {
          error = new Error((error instanceof Error ? error.message : String(error)) + "; previous host is unavailable: " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
        }
      }
      await this.showApplicationError("Restart host", error instanceof Error ? error.message : "The shared host could not be restarted.");
    }
  }

  private async releaseDiscardedConnection(connection: SessionConnection): Promise<void> {
    try { await connection.release(); }
    catch { connection.abandon(); }
  }

  private replaceConnection(record: ElectronWindowRecord, connection: SessionConnection): void {
    const nextKey = connection.canonicalPath ?? "session:" + connection.sessionKey;
    this.removeRecordKeys(record);
    record.connection = connection;
    record.origin = connection.browserOrigin;
    record.keys.clear();
    record.keys.add(nextKey);
    this.addRecordKey(nextKey, record);
    if (connection.canonicalPath !== null) {
      this.rememberRecent(connection.canonicalPath);
      record.window.setTitle?.(basename(connection.canonicalPath) + " — " + APP_NAME);
    }
  }

  private async disposeRecord(record: ElectronWindowRecord): Promise<void> {
    if (record.released) return;
    if (record.disposal) return record.disposal;
    const operation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let releaseError: unknown;
      try {
        await Promise.race([
          record.connection.release(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("native lease release timed out")), 1_000); }),
        ]);
      } catch (error) {
        releaseError = error;
        record.connection.abandon();
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!record.released) {
        record.released = true;
        if (record.monitor) clearInterval(record.monitor);
        for (const pending of record.pendingCommands.values()) pending.reject(new Error("Desktop window closed before the command completed."));
        record.pendingCommands.clear();
        this.records.delete(record);
        this.removeRecordKeys(record);
        this.notifyRetainedDraftsChanged(record.recoveryId);
      }
      this.diagnostics?.record(releaseError ? "warn" : "info", "window.close", {
        windowId: record.windowId, sessionId: record.connection.sessionKey, sessionEpoch: record.connection.epoch,
        outcome: releaseError ? "local_detach" : "success", errorCode: releaseError ? (releaseError as NodeJS.ErrnoException)?.code ?? "lease_release_failed" : null,
        durationMs: Math.round(performance.now() - record.openedAt),
      });
    })();
    let disposal!: Promise<void>;
    disposal = operation.finally(() => {
      this.pendingDisposals.delete(disposal);
      if (record.disposal === disposal) record.disposal = undefined;
    });
    record.disposal = disposal;
    this.pendingDisposals.add(disposal);
    return disposal;
  }

  private notifyRetainedDraftsChanged(recoveryId: string | undefined): void {
    if (!recoveryId) return;
    for (const record of this.records) if (!record.released && record.recoveryId === recoveryId && !record.window.webContents.isDestroyed?.()) {
      record.window.webContents.send(IPC_CHANNELS.recoveryChanged, {});
    }
  }

  private async showDiagnostics(): Promise<void> {
    const diagnostics = this.diagnostics;
    if (!diagnostics) throw new Error("diagnostics unavailable");
    const status = diagnostics.status();
    const record = this.focusedRecord() ?? this.firstRecord();
    const state = record?.windowState;
    const snapshot = record ? await this.querySnapshot(record).catch(() => null) : null;
    const answer = await (record
      ? this.runtime.dialog.showMessageBox(record.window, {
          type: "info", title: "Alder Diagnostics", message: status.available ? "Local diagnostics are available." : "Local diagnostics are unavailable.",
          detail: `Retained bytes: ${status.retainedBytes}; dropped records: ${status.droppedEvents + status.unavailableEvents}\nRuntime: ${snapshot?.runtime.kernelState ?? "unknown"}; active operation: ${snapshot?.runtime.activeRunId ?? "none"}\n\nAlder automatically retains full local diagnostic records. Agents can inspect them with \`alder diagnostics\`; saving a raw copy is optional.`,
          buttons: ["Save Raw Copy…", "Close"], defaultId: 0, cancelId: 1,
        })
      : this.runtime.dialog.showMessageBox({
          type: "info", title: "Alder Diagnostics", message: status.available ? "Local diagnostics are available." : "Local diagnostics are unavailable.",
          detail: `Retained bytes: ${status.retainedBytes}; dropped records: ${status.droppedEvents + status.unavailableEvents}`, buttons: ["Save Raw Copy…", "Close"], defaultId: 0, cancelId: 1,
        }));
    if (answer.response !== 0) return;
    const selected = record
      ? await this.runtime.dialog.showSaveDialog(record.window, { title: "Save Raw Diagnostic Copy", message: "Choose a new folder for the raw diagnostic copy.", properties: ["createDirectory"] })
      : await this.runtime.dialog.showSaveDialog({ title: "Save Raw Diagnostic Copy", message: "Choose a new folder for the raw diagnostic copy.", properties: ["createDirectory"] });
    if (selected.canceled || !selected.filePath) return;
    const cacheRoot = record?.connection.canonicalPath ? join(dirname(record.connection.canonicalPath), ".alder", "cache") : undefined;
    await exportDiagnosticBundle(diagnostics, selected.filePath, {
      appVersion: this.runtime.app.getVersion?.() ?? "unknown", buildId: process.env.ALDER_BUILD_ID,
      recoveryRoot: this.runtime.app.getPath?.("userData") ? join(this.runtime.app.getPath!("userData"), "document-recovery") : undefined,
      cacheRoot,
      flushPeers: async () => {
        if (!record) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("diagnostic flush timeout")), 2_000); timer.unref?.(); });
        const response = await Promise.race([record.connection.request("/api/diagnostics/flush", { method: "POST" }), timeout])
          .finally(() => { if (timer) clearTimeout(timer); });
        if (!response.ok) throw new Error("diagnostic flush failed");
      },
      runtime: snapshot?.runtime ? {
        kernelState: snapshot.runtime.kernelState, analyzerState: snapshot.runtime.analyzerState,
        executionReady: snapshot.runtime.executionReady, activeRunId: snapshot.runtime.activeRunId,
      } : {},
      state: { dirty: state?.dirty ?? false, sessionEpoch: state?.sessionEpoch ?? null },
    });
  }

  private async showDiagnosticsError(): Promise<void> {
    const record = this.focusedRecord() ?? this.firstRecord();
    const options = {
      type: "error", title: "Alder Diagnostics", message: "The raw diagnostic copy could not be saved.",
      detail: "Alder remains usable. Choose a new destination and try again.", buttons: ["OK"],
    };
    await (record ? this.runtime.dialog.showMessageBox(record.window, options) : this.runtime.dialog.showMessageBox(options)).catch(() => undefined);
  }

  private async releaseAll(): Promise<void> {
    const disposals = [...this.records].map(record => this.disposeRecord(record));
    for (const pending of this.pendingDisposals) if (!disposals.includes(pending)) disposals.push(pending);
    const results = await Promise.allSettled(disposals);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "one or more native leases could not be released");
  }

  private async finishApplicationQuit(): Promise<void> {
    try {
      for (const record of [...this.records]) {
        await this.requestClose(record);
        if (!record.window.isDestroyed()) {
          this.quitState = "idle";
          return;
        }
      }
      this.stopping = true;
      await this.releaseAll();
      this.diagnostics?.record("info", "desktop.quit", { outcome: "success" });
      await this.diagnostics?.close();
      this.quitState = "authorized";
      this.runtime.app.quit();
    } catch (error) {
      this.stopping = false;
      this.quitState = "idle";
      this.diagnostics?.record("error", "desktop.quit", {
        outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? "lease_release_failed", error: diagnosticError(error),
      });
      await this.showApplicationError("Quit Alder", error instanceof Error ? error.message : "Alder could not release its notebook processes.").catch(() => undefined);
    }
  }

  private queueOrOpen(path: string): void {
    if (!this.started) { this.queuedPaths.push(path); return; }
    const first = this.firstRecord();
    const source = this.records.size === 1 && first?.connection.canonicalPath === null ? first : undefined;
    void (source ? this.openReplacingPristineUntitled(source, path) : this.openNotebook(path)).catch(() => undefined);
  }

  private async openReplacingPristineUntitled(source: ElectronWindowRecord, path: string): Promise<void> {
    await this.openNotebook(path);
    if (source.released || source.closing || source.connection.canonicalPath !== null) return;
    const state = await this.readWindowState(source).catch(() => null);
    if (state === null || state.path !== null || state.dirty || source.released || source.closing) return;
    await this.finishClose(source);
  }

  private focus(record: ElectronWindowRecord): void {
    if (record.window.isMinimized?.()) record.window.restore?.();
    record.window.show();
    record.window.focus();
  }

  private addRecordKey(key: string, record: ElectronWindowRecord): void {
    const records = this.byKey.get(key) ?? new Set<ElectronWindowRecord>();
    records.add(record);
    this.byKey.set(key, records);
  }

  private removeRecordKeys(record: ElectronWindowRecord): void {
    for (const key of record.keys) {
      const records = this.byKey.get(key);
      records?.delete(record);
      if (records?.size === 0) this.byKey.delete(key);
    }
  }

  private focusOrOpenUntitled(): void {
    const record = this.firstRecord();
    if (record) {
      this.focus(record);
      return;
    }
    if (!this.started || this.stopping) return;
    void this.openNotebook(null).catch(error => {
      void this.showApplicationError("Open notebook", error instanceof Error ? error.message : "The notebook host could not be started.");
    });
  }

  private firstRecord(): ElectronWindowRecord | undefined { return this.records.values().next().value as ElectronWindowRecord | undefined; }
  private focusedRecord(): ElectronWindowRecord | undefined {
    return [...this.records].find(record => record.window.isFocused?.()) ?? this.firstRecord();
  }

  private rememberRecent(path: string): void {
    const index = this.recentPaths.indexOf(path);
    if (index >= 0) this.recentPaths.splice(index, 1);
    this.recentPaths.unshift(path);
    if (this.recentPaths.length > 10) this.recentPaths.length = 10;
    this.runtime.app.addRecentDocument?.(path);
    if (this.menuInstalled) this.rebuildMenu();
  }

  private async applicationResources(): Promise<ApplicationResources> {
    if (this.options.resources) return this.options.resources;
    return this.resourcesPromise ??= (async () => {
      const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
      const priorNoAsar = electronProcess.noAsar;
      electronProcess.noAsar = true;
      try {
        return await resolveApplicationResources(this.options.applicationRoot ?? appRootFromProcess());
      } finally {
        electronProcess.noAsar = priorNoAsar;
      }
    })();
  }

  private async showApplicationError(title: string, detail: string): Promise<void> {
    const owner = this.firstRecord()?.window ?? this.runtime.BrowserWindow.getAllWindows?.()[0];
    const options = { type: "error", title, message: detail, buttons: ["OK"] };
    if (owner) await this.runtime.dialog.showMessageBox(owner, options).catch(() => undefined);
    else await this.runtime.dialog.showMessageBox(options).catch(() => { process.stderr.write(`${title}: ${detail}\n`); });
  }
}

export async function startElectronMain(options: ElectronMainOptions = {}): Promise<ElectronMain> {
  const application = new ElectronMain(options.runtime ?? loadElectronRuntime(), options);
  await application.start();
  return application;
}

export async function startPackagedElectronMain(argv: readonly string[] = process.argv.slice(1)): Promise<ElectronMain> {
  const runtime = loadElectronRuntime();
  return startElectronMain({
    runtime,
    ...(argv.includes("--lazy") ? { executionMode: "lazy" as const } : {}),
    suppressStartup: argv.includes("--no-run"),
  });
}
