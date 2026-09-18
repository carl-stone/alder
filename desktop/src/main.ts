import { NativeRecoveryStore } from "./recovery-store.js";
import { observeSaveAsDestination } from "../../host/src/persistence.js";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  acquireNotebookSession,
  type AcquireNotebookSessionOptions,
  type SessionResources,
} from "../../host/src/sessions.js";
import {
  resolveApplicationResources,
  type ApplicationResources,
} from "../../host/src/resources.js";
import {
  desktopRecoveryRequestSchema,
  decodeHostQueryResultWire,
  decodeJsonFrame,
  encodeHostQueryWire,
  hostQueryResultSchema,
  hostIdentitySchema,
  notebookQueryResultSchema,
  ticketMintRequestSchema,
  ticketMintResponseSchema,
  windowActionMessageSchema,
  windowActionSchema,
  windowStateSchema,
  type HostQuery,
  type NotebookQueryResult,
  type SessionConnection,
  type WindowAction,
  type WindowState,
} from "../../host/src/protocol.js";

const IPC_CHANNELS = Object.freeze({
  recovery: "alderDesktop:recovery",
  openNotebook: "alderDesktop:openNotebook",
  chooseSavePath: "alderDesktop:chooseSavePath",
  chooseRscript: "alderDesktop:chooseRscript",
  getWindowState: "alderDesktop:getWindowState",
  hostShutdown: "alderDesktop:hostShutdown",
  windowAction: "alderDesktop:windowAction",
  saveCancelled: "alderDesktop:saveCancelled",
  rendererReady: "alderDesktop:rendererReady",
} as const);

const APP_NAME = "Alder";
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
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
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
  addRecentDocument?(path: string): void;
  clearRecentDocuments?(): void;
}

export interface ElectronBrowserWindowConstructor {
  new (options: Record<string, unknown>): ElectronWindow;
  fromWebContents(contents: ElectronWebContents): ElectronWindow | null;
  getAllWindows?(): ElectronWindow[];
}

export interface ElectronDialog {
  showOpenDialog(window: ElectronWindow, options: Record<string, unknown>): Promise<ElectronFileDialogResult>;
  showSaveDialog(window: ElectronWindow, options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>;
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
  readonly rscript?: string;
  readonly executionMode?: "automatic" | "lazy";
  readonly runOnStartup?: boolean;
  readonly deferStartup?: boolean;
  readonly startupTimeoutMs?: number;
  readonly closeSettlementTimeoutMs?: number;
  readonly acquireSession?: (options: AcquireNotebookSessionOptions) => Promise<SessionConnection>;
  readonly platform?: string;
}

export interface ElectronMainApplication {
  start(): Promise<boolean>;
  stop(): Promise<void>;
  openNotebook(path: string | null): Promise<void>;
  windows(): readonly ElectronWindow[];
}

interface ElectronWindowRecord {
  readonly window: ElectronWindow;
  readonly keys: Set<string>;
  connection: SessionConnection;
  origin: string;
  dirty: boolean;
  closing: boolean;
  released: boolean;
  monitor?: ReturnType<typeof setInterval>;
  reloadInProgress: boolean;
  monitorInProgress: boolean;
  hostFailureShown: boolean;
  loadGeneration: number;
  loadingOrigin?: string;
  rendererReadyGeneration: number;
  rendererReady?: { promise: Promise<void>; resolve: () => void };
  saveCancelled: boolean;
  recoveryKeyId?: string;
}

/**
 * Exact application-origin check used for every privileged renderer request.
 * Electron never trusts a renderer frame merely because it belongs to a known
 * BrowserWindow: its current URL must still be the authenticated host origin.
 */
export function isTrustedApplicationOrigin(value: string, expectedOrigin: string): boolean {
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

export function isLoopbackHttpOrigin(value: string): boolean {
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

export function authenticatedNotebookUrl(origin: string, ticket: string): string {
  if (!isLoopbackHttpOrigin(origin)) throw new Error("desktop host origin is not a loopback HTTP origin");
  if (typeof ticket !== "string" || !/^[0-9a-f]{64}$/.test(ticket)) throw new Error("desktop bootstrap ticket is invalid");
  const url = new URL("/index.html", origin);
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
    if (argument === "--rscript") { index += 1; continue; }
    if (typeof argument !== "string" || argument.length === 0 || argument.startsWith("-")) continue;
    if (/\.(?:r|rmd)$/i.test(argument)) {
      try { return validateNotebookPath(resolve(argument)); } catch { return null; }
    }
  }
  return null;
}

function parseRscriptArgument(argv: readonly string[]): string | undefined {
  let selected: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--rscript") continue;
    if (selected !== undefined) throw new Error("--rscript may be supplied only once");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
      throw new Error("--rscript requires an absolute executable path");
    }
    selected = resolve(value);
    index += 1;
  }
  return selected;
}

function loadElectronRuntime(): ElectronRuntime {
  // Forge emits a CommonJS main bundle, so this remains an external Electron
  // module and is never pulled into the host/headless bundle.
  return require("electron") as ElectronRuntime;
}

function sessionResources(resources: ApplicationResources): SessionResources {
  return {
    root: resources.root,
    nodeExecutable: resources.nodeExecutable,
    hostEntry: resources.hostEntry,
    processSupervisorExecutable: resources.processSupervisorExecutable,
  };
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

function rendererActionScript(action: WindowAction): string | null {
  switch (action) {
    case "save": return null;
    case "run-all": return null;
    case "interrupt": return "document.querySelector('#stop')?.click()";
    case "restart": return "document.querySelector('#restart')?.click()";
    case "settings": return "document.querySelector('#settings-open')?.click()";
    case "run-cell": return "document.activeElement?.closest('.cell')?.querySelector('[data-act=run]')?.click()";
    case "run-stale": return null;
    case "select-r": return null;
    case "publish": return "Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Publish HTML')?.click()";
    case "close": return null;
    default: return null;
  }
}

const DIRTY_PROJECTION_SCRIPT = `(() => {
  const host = globalThis.__alderHost;
  const documentValue = host?.client?.document;
  const snapshot = documentValue?.snapshot;
  if (snapshot === undefined) return null;
  const pending = typeof documentValue?.pendingSource === "function" ? documentValue.pendingSource() : null;
  return Boolean(snapshot.dirty || snapshot.changed || pending?.changes?.length || pending?.tombstones?.length);
})()`;

export class ElectronMain implements ElectronMainApplication {
  private readonly runtime: ElectronRuntime;
  private readonly options: ElectronMainOptions;
  private readonly records = new Set<ElectronWindowRecord>();
  private readonly byKey = new Map<string, ElectronWindowRecord>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly identityChecks = new WeakMap<ElectronWindowRecord, Promise<void>>();
  private readonly queuedPaths: string[] = [];
  private readonly recentPaths: string[] = [];
  private started = false;
  private stopping = false;
  private menuInstalled = false;
  private quitHandled = false;
  private resourcesPromise?: Promise<ApplicationResources>;
  private recoveryStore?: NativeRecoveryStore;

  constructor(runtime: ElectronRuntime = loadElectronRuntime(), options: ElectronMainOptions = {}) {
    this.runtime = runtime;
    this.options = options;
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
    this.runtime.app.on("before-quit", (event: { preventDefault?: () => void }) => {
      if (this.quitHandled) return;
      event.preventDefault?.();
      this.quitHandled = true;
      void (async () => {
        for (const record of [...this.records]) {
          await this.requestClose(record);
          if (!record.window.isDestroyed()) { this.quitHandled = false; return; }
        }
        this.stopping = true;
        await this.releaseAll();
        this.runtime.app.quit();
      })().catch(() => { this.quitHandled = false; });
    });
    this.runtime.app.on("will-quit", () => {
      if (this.quitHandled) return;
      this.quitHandled = true;
      this.stopping = true;
      void this.releaseAll();
    });

    await this.runtime.app.whenReady();
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
  }

  async openNotebook(path: string | null): Promise<void> {
    if (this.stopping) throw new Error("desktop application is stopping");
    if (path !== null) path = validateNotebookPath(path);
    const hint = path === null ? null : await canonicalPathHint(path);
    if (hint !== null) {
      const existing = this.byKey.get(hint);
      if (existing) { this.focus(existing); return; }
      const pending = this.pending.get(hint);
      if (pending) { await pending; const current = this.byKey.get(hint); if (current) this.focus(current); return; }
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
        resources: sessionResources(resources),
        ...(this.options.rscript === undefined ? {} : { rscript: this.options.rscript }),
        ...(this.options.executionMode === undefined ? {} : { executionMode: this.options.executionMode }),
        ...(this.options.runOnStartup === undefined ? {} : { runOnStartup: this.options.runOnStartup }),
        deferStartup: this.options.deferStartup ?? true,
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
    } catch (error) {
      await this.showApplicationError("Open notebook", error instanceof Error ? error.message : "The notebook host could not be started.");
      throw error;
    }

    const canonical = connection.canonicalPath;
    const existing = canonical === null ? undefined : this.byKey.get(canonical);
    if (existing) {
      await connection.release();
      this.focus(existing);
      return;
    }

    let ticket: string;
    try {
      ticket = await this.mintTicket(connection);
    } catch (error) {
      await connection.release();
      await this.showApplicationError("Open notebook", error instanceof Error ? error.message : "The notebook authentication ticket could not be created.");
      throw error;
    }

    const window = new this.runtime.BrowserWindow({
      width: 1440,
      height: 960,
      show: false,
      title: APP_NAME,
      webPreferences: {
        preload: this.options.preloadPath ?? join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        // Authentication lasts only for this window; draft files are stored by the native bridge.
        partition: "alder-" + randomUUID(),
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.session?.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    window.webContents.session?.setPermissionCheckHandler?.(() => false);
    const record: ElectronWindowRecord = {
      window,
      keys: new Set<string>(),
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
      saveCancelled: false,
    };
    record.keys.add(canonical ?? `session:${connection.sessionKey}`);
    if (hint !== null) record.keys.add(hint);
    this.records.add(record);
    for (const key of record.keys) this.byKey.set(key, record);
    if (canonical !== null) this.rememberRecent(canonical);
    this.installWindowPolicy(record);
    window.once("ready-to-show", () => window.show());
    window.on("close", (event: { preventDefault?: () => void }) => {
      if (this.stopping) return;
      event.preventDefault?.();
      if (!record.closing) void this.requestClose(record);
    });
    window.on("closed", () => { void this.disposeRecord(record); });
    window.setTitle?.(canonical ? `${basename(canonical)} — ${APP_NAME}` : APP_NAME);
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
      if (record.recoveryKeyId && request.keyId !== record.recoveryKeyId) throw new Error("Recovery identity changed");
      record.recoveryKeyId = request.keyId;
      const userData = this.runtime.app.getPath?.("userData");
      if (!userData) throw new Error("Desktop recovery storage is unavailable");
      const store = this.recoveryStore ??= new NativeRecoveryStore(join(userData, "document-recovery"));
      switch (request.action) {
        case "read": return store.read(request.keyId, request.name ?? "");
        case "write": return store.write(request.keyId, request.name ?? "", request.value);
        case "remove": return store.remove(request.keyId, request.name ?? "");
        case "list": return store.list(request.keyId, request.prefix ?? "");
      }
    });
    noArguments(IPC_CHANNELS.openNotebook, async (record) => {
      const result = await this.runtime.dialog.showOpenDialog(record.window, {
        title: "Open Alder notebook",
        properties: ["openFile"],
        filters: [{ name: "R notebooks", extensions: ["R", "rmd", "r"] }],
      });
      if (result.canceled || result.filePaths.length === 0) return undefined;
      const path = selectedPath(result.filePaths[0], "Open notebook");
      if (path) await this.openReplacingPristineUntitled(record, path);
      return undefined;
    });
    noArguments(IPC_CHANNELS.chooseSavePath, async (record) => {
      const result = await this.runtime.dialog.showSaveDialog(record.window, {
        title: "Save notebook",
        message: "Choose where to save this R notebook.",
        properties: ["createDirectory"],
        filters: [{ name: "R notebook", extensions: ["R", "rmd"] }],
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
        title: "Select Rscript",
        properties: ["openFile"],
        filters: [{ name: "Rscript", extensions: ["Rscript", ""] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return selectedPath(result.filePaths[0], "Rscript path");
    });
    noArguments(IPC_CHANNELS.getWindowState, record => this.readWindowState(record));
    noArguments(IPC_CHANNELS.hostShutdown, async (record) => {
      record.closing = true;
      record.hostFailureShown = true;
      await this.disposeRecord(record, "discard").catch(() => undefined);
      if (!record.window.isDestroyed()) record.window.destroy();
      if (this.records.size === 0) this.runtime.app.quit();
      return undefined;
    });
    noArguments(IPC_CHANNELS.saveCancelled, (record) => { record.saveCancelled = true; });
    noArguments(IPC_CHANNELS.rendererReady, (record) => {
      if (record.rendererReadyGeneration === record.loadGeneration) record.rendererReady?.resolve();
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
    contents.on("render-process-gone", (_event: unknown, details: { reason?: string }) => {
      if (record.released || record.reloadInProgress) return;
      record.reloadInProgress = true;
      void this.recoverRenderer(record, details?.reason ?? "unknown").finally(() => { record.reloadInProgress = false; });
    });
  }

  private async recoverRenderer(record: ElectronWindowRecord, reason: string): Promise<void> {
    const answer = await this.runtime.dialog.showMessageBox(record.window, {
      type: "warning",
      title: "Alder window recovered",
      message: "The notebook editor stopped unexpectedly.",
      detail: `Renderer reason: ${reason}. Alder will reload the authenticated host page and retain recovery data.`,
      buttons: ["Reload", "Close"],
      defaultId: 0,
      cancelId: 1,
    }).catch(() => ({ response: 0 }));
    if (record.released) return;
    if (answer.response !== 0) {
      await this.requestClose(record);
      return;
    }
    try {
      const ticket = await this.mintTicket(record.connection);
      await this.loadAuthenticatedNotebook(record, ticket);
    } catch (error) {
      await this.showApplicationError("Renderer recovery", error instanceof Error ? error.message : "The renderer could not be recovered.");
    }
  }

  private async dispatchAction(record: ElectronWindowRecord, action: WindowAction): Promise<void> {
    const payload = windowActionMessageSchema.parse({ action: windowActionSchema.parse(action) });
    if (record.released || record.window.webContents.isDestroyed?.()) return;
    record.window.webContents.send(IPC_CHANNELS.windowAction, payload);
    const script = rendererActionScript(action);
    if (script) await record.window.webContents.executeJavaScript(script, true).catch(() => undefined);
  }

  private installMenu(): void {
    if (this.menuInstalled) return;
    this.menuInstalled = true;
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    const action = (name: WindowAction) => (): void => {
      const record = this.focusedRecord() ?? this.firstRecord();
      if (record) void this.dispatchAction(record, name);
    };
    const fileSubmenu: Record<string, unknown>[] = [
      { label: "New", accelerator: "CmdOrCtrl+N", click: () => void this.openNotebook(null) },
      { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void this.openNotebookFromDialog(this.focusedRecord() ?? this.firstRecord()) },
      { label: "Recent", submenu: this.recentPaths.length === 0 ? [{ label: "No recent notebooks", enabled: false }] : this.recentPaths.map(path => ({ label: path, click: () => void this.openNotebook(path) })) },
      { type: "separator" },
      { label: "Save", accelerator: "CmdOrCtrl+S", click: action("save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: action("save-as") },
      { label: "Publish HTML", click: action("publish") },
      { type: "separator" },
      { label: "Close", role: "close", click: () => { const record = this.focusedRecord(); if (record) void this.requestClose(record); } },
    ];
    const runSubmenu: Record<string, unknown>[] = [
      { label: "Run Cell", click: action("run-cell") },
      { label: "Run All", click: action("run-all") },
      { label: "Run Stale", click: action("run-stale") },
      { label: "Interrupt", click: action("interrupt") },
      { label: "Restart R", click: action("restart") },
    ];
    const settingsSubmenu: Record<string, unknown>[] = [
      { label: "Settings", click: action("settings") },
      { label: "Select R…", click: action("select-r") },
    ];
    const editSubmenu: Record<string, unknown>[] = [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "selectAll" },
    ];
    const template: Record<string, unknown>[] = [
      ...(this.platform() === "darwin" ? [{ label: APP_NAME, submenu: [...settingsSubmenu, { type: "separator" }, { role: "quit" }] }] : []),
      { label: "File", submenu: fileSubmenu },
      { label: "Edit", submenu: editSubmenu },
      { label: "Run", submenu: runSubmenu },
      ...(this.platform() === "darwin" ? [] : [{ label: "Alder", submenu: settingsSubmenu }]),
    ];
    this.runtime.Menu.setApplicationMenu(this.runtime.Menu.buildFromTemplate(template));
  }

  private async openNotebookFromDialog(source: ElectronWindowRecord | undefined): Promise<void> {
    if (!source) return;
    const result = await this.runtime.dialog.showOpenDialog(source.window, {
      title: "Open Alder notebook",
      properties: ["openFile"],
      filters: [{ name: "R notebooks", extensions: ["R", "rmd", "r"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const path = selectedPath(result.filePaths[0], "Open notebook");
    if (path) await this.openReplacingPristineUntitled(source, path);
  }

  private async requestClose(record: ElectronWindowRecord): Promise<void> {
    if (record.closing || record.released) return;
    record.closing = true;
    let finished = false;
    try {
      const state = await this.readWindowState(record);
      if (!state.dirty) {
        this.finishClose(record);
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
        await this.dispatchAction(record, "close").catch(() => undefined);
        await this.waitForRelease(record, 500);
        if (!record.released) await this.disposeRecord(record, "discard");
        if (!record.window.isDestroyed()) record.window.destroy();
        finished = true;
        return;
      }
      record.saveCancelled = false;
      await this.dispatchAction(record, "save");
      const settled = await this.waitForClean(record, this.options.closeSettlementTimeoutMs ?? CLOSE_SETTLEMENT_TIMEOUT_MS);
      if (!settled) {
        if (!record.saveCancelled) await this.showApplicationError("Save", "The save operation did not settle; the window remains open.");
        return;
      }
      this.finishClose(record);
      finished = true;
    } catch (error) {
      await this.showApplicationError("Close notebook", error instanceof Error ? error.message : "The notebook remains open because its state could not be read.");
    } finally {
      if (!finished) record.closing = false;
    }
  }

  private finishClose(record: ElectronWindowRecord): void {
    if (record.released) return;
    record.closing = true;
    record.window.destroy();
  }

  private async waitForClean(record: ElectronWindowRecord, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!record.released && !record.saveCancelled && Date.now() < deadline) {
      if (!(await this.readWindowState(record)).dirty) return true;
      await new Promise(resolvePromise => setTimeout(resolvePromise, STATE_POLL_MS));
    }
    return false;
  }
  private async waitForRelease(record: ElectronWindowRecord, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!record.released && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, STATE_POLL_MS));
    return record.released;
  }

  private async readWindowState(record: ElectronWindowRecord): Promise<WindowState> {
    let localDirty = true;
    try {
      const local = await record.window.webContents.executeJavaScript(DIRTY_PROJECTION_SCRIPT, false);
      if (typeof local === "boolean") localDirty = local;
    } catch {
      // The host query below remains authoritative for committed dirty state.
    }
    let authoritativeDirty = true;
    try {
      const snapshot = await this.querySnapshot(record);
      authoritativeDirty = snapshot.dirty === true || snapshot.changed === true;
    } catch {
      // Keep the state dirty when the authoritative host query is unavailable.
      // Local renderer state cannot prove that another client has no changes.
    }
    const dirty = localDirty || authoritativeDirty;
    record.dirty = dirty;
    return windowStateSchema.parse({
      path: record.connection.canonicalPath,
      dirty,
      platform: this.platform(),
      sessionEpoch: record.connection.epoch,
    });
  }

  private async assertHostContinuity(record: ElectronWindowRecord): Promise<void> {
    const previous = this.identityChecks.get(record);
    const check = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (record.released) throw new Error("desktop application window is released");
      const connection = record.connection;
      const response = await connection.request("/api/identity", { method: "GET", signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error("desktop host identity query failed (" + response.status + ")");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_QUERY_RESPONSE_BYTES) throw new Error("desktop host identity response is too large");
      const identity = hostIdentitySchema.parse(decodeJsonFrame(bytes, MAX_QUERY_RESPONSE_BYTES));
      if (identity.continuityProof !== connection.continuityProof || identity.epoch !== connection.epoch ||
        identity.processNonce !== connection.processNonce || identity.origin !== connection.origin ||
        identity.browserOrigin !== connection.browserOrigin) {
        throw new Error("desktop host process identity changed");
      }
      const pathChanged = identity.canonicalPath !== connection.canonicalPath;
      const sessionChanged = identity.sessionKey !== connection.sessionKey;
      if (pathChanged !== sessionChanged || (pathChanged && identity.canonicalPath === null)) {
        throw new Error("desktop host path identity changed without an authoritative Save As");
      }
      if (record.released) throw new Error("desktop application window is released");
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
    const existing = this.byKey.get(nextKey);
    if (existing !== undefined && existing !== record) throw new Error("desktop host path is already owned by another window");
    for (const key of record.keys) if (this.byKey.get(key) === record) this.byKey.delete(key);
    record.connection.sessionKey = sessionKey;
    record.connection.canonicalPath = canonicalPath;
    record.keys.clear();
    record.keys.add(nextKey);
    this.byKey.set(nextKey, record);
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
    if (record.released || record.hostFailureShown || record.monitorInProgress) return;
    record.monitorInProgress = true;
    try {
      await this.querySnapshot(record);
    } catch (error) {
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
      if (answer.response === 0 && !record.released) await this.restartHost(record);
      else if (!record.released) await this.requestClose(record);
    } finally {
      record.monitorInProgress = false;
    }
  }

  private async restartHost(record: ElectronWindowRecord): Promise<void> {
    const old = record.connection;
    let next: SessionConnection | undefined;
    let navigationStarted = false;
    try {
      // Preserve live edits while the old page still owns its authenticated IPC origin.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          record.window.webContents.executeJavaScript("globalThis.__alderHost?.client?.flushDraftPersistence()", true),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Local edits could not be preserved. The current editor remains open.")), 3_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      const resources = await this.applicationResources();
      const acquire = this.options.acquireSession ?? acquireNotebookSession;
      next = await acquire({
        path: old.canonicalPath,
        ...(old.canonicalPath === null ? { untitledRecoveryId: old.sessionKey } : {}),
        resources: sessionResources(resources),
        ...(this.options.rscript === undefined ? {} : { rscript: this.options.rscript }),
        ...(this.options.executionMode === undefined ? {} : { executionMode: this.options.executionMode }),
        ...(this.options.runOnStartup === undefined ? {} : { runOnStartup: this.options.runOnStartup }),
        deferStartup: this.options.deferStartup ?? true,
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      });
      if (next === old) throw new Error("desktop host restart returned the active lease");
      const ticket = await this.mintTicket(next);
      if (record.released) {
        await next.release();
        return;
      }
      // Keep the old lease and identity authoritative until the replacement
      // page has passed its authenticated response check.
      navigationStarted = true;
      await this.loadAuthenticatedNotebook(record, ticket, next);
      if (record.released) {
        await next.release();
        return;
      }
      this.replaceConnection(record, next);
      await old.release().catch(() => undefined);
      record.hostFailureShown = false;
    } catch (error) {
      if (next !== undefined && next !== record.connection) await next.release().catch(() => undefined);
      if (!record.released && navigationStarted) {
        try {
          const rollbackTicket = await this.mintTicket(old);
          await this.loadAuthenticatedNotebook(record, rollbackTicket, old);
          record.hostFailureShown = false;
        } catch (rollbackError) {
          error = new Error((error instanceof Error ? error.message : String(error)) + "; previous host is unavailable: " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
        }
      }
      await this.showApplicationError("Restart host", error instanceof Error ? error.message : "The shared host could not be restarted.");
    }
  }

  private replaceConnection(record: ElectronWindowRecord, connection: SessionConnection): void {
    const nextKey = connection.canonicalPath ?? "session:" + connection.sessionKey;
    const existing = this.byKey.get(nextKey);
    if (existing !== undefined && existing !== record) throw new Error("desktop host path is already owned by another window");
    for (const key of record.keys) if (this.byKey.get(key) === record) this.byKey.delete(key);
    record.connection = connection;
    record.origin = connection.browserOrigin;
    record.keys.clear();
    record.keys.add(nextKey);
    this.byKey.set(nextKey, record);
    if (connection.canonicalPath !== null) {
      this.rememberRecent(connection.canonicalPath);
      record.window.setTitle?.(basename(connection.canonicalPath) + " — " + APP_NAME);
    }
  }

  private async closeAfterFailedRestart(record: ElectronWindowRecord): Promise<void> {
    if (record.released) return;
    this.finishClose(record);
    await this.disposeRecord(record).catch(() => undefined);
    if (!record.window.isDestroyed()) record.window.destroy();
  }

  private async disposeRecord(record: ElectronWindowRecord, disposition: "normal" | "discard" = "normal"): Promise<void> {
    if (record.released) return;
    record.released = true;
    if (record.monitor) clearInterval(record.monitor);
    this.records.delete(record);
    for (const key of record.keys) if (this.byKey.get(key) === record) this.byKey.delete(key);
    await Promise.race([record.connection.release(disposition), new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
  }

  private async releaseAll(): Promise<void> {
    const records = [...this.records];
    await Promise.all(records.map(record => this.disposeRecord(record)));
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
    this.finishClose(source);
  }

  private focus(record: ElectronWindowRecord): void {
    if (record.window.isMinimized?.()) record.window.restore?.();
    record.window.show();
    record.window.focus();
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
  private firstWindow(): ElectronWindow { return this.firstRecord()?.window ?? (this.runtime.BrowserWindow.getAllWindows?.()[0] as ElectronWindow | undefined)!; }
  private focusedRecord(): ElectronWindowRecord | undefined {
    return [...this.records].find(record => record.window.isFocused?.()) ?? this.firstRecord();
  }
  private platform(): string { return this.options.platform ?? process.platform; }

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
    if (!owner) {
      process.stderr.write(`${title}: ${detail}\n`);
      return;
    }
    await this.runtime.dialog.showMessageBox(owner, { type: "error", title, message: detail, buttons: ["OK"] }).catch(() => undefined);
  }
}

export async function startElectronMain(options: ElectronMainOptions = {}): Promise<ElectronMainApplication> {
  const application = new ElectronMain(options.runtime ?? loadElectronRuntime(), options);
  await application.start();
  return application;
}

export async function startPackagedElectronMain(argv: readonly string[] = process.argv.slice(1)): Promise<ElectronMainApplication> {
  const runtime = loadElectronRuntime();
  const rscript = parseRscriptArgument(argv);
  return startElectronMain({
    runtime,
    ...(rscript === undefined ? {} : { rscript }),
    ...(argv.includes("--lazy") ? { executionMode: "lazy" as const } : {}),
    ...(argv.includes("--no-run") ? { runOnStartup: false } : {}),
  });
}
