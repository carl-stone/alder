import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  CompletionRequest,
  DefinitionRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
  SignatureHelpRequest,
  TextDocumentSyncKind,
  type Diagnostic,
  type InitializeParams,
  type Position,
  type Range,
} from "vscode-languageserver-protocol";

const REQUEST_TYPES = {
  "textDocument/completion": CompletionRequest.type,
  "textDocument/hover": HoverRequest.type,
  "textDocument/definition": DefinitionRequest.type,
  "textDocument/references": ReferencesRequest.type,
  "textDocument/documentSymbol": DocumentSymbolRequest.type,
  "textDocument/signatureHelp": SignatureHelpRequest.type,
} as const;

export type AlderLspMethod = keyof typeof REQUEST_TYPES;

export interface NotebookRecord {
  text: string;
  eol?: string;
  kind: "header" | "delimiter" | "option" | "body" | string;
}

export interface NotebookCellDocument {
  id: string;
  /** Authoritative source revision captured with this document, when available. */
  revision?: number;
  type?: "code" | "markdown";
  body: readonly string[];
  delim?: string;
  options?: Readonly<Record<string, unknown>>;
  records?: readonly NotebookRecord[];
}

export interface NotebookDocument {
  path?: string | null;
  text?: string;
  cells: readonly NotebookCellDocument[];
  header?: readonly string[];
  headerRecords?: readonly NotebookRecord[];
}

export interface CellPosition {
  cell: string;
  line: number;
  character: number;
}

export interface CellRange {
  start: CellPosition;
  end: CellPosition;
}

export interface CellDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  symbol: null;
  source: "lsp";
  range: Omit<CellRange, "start" | "end"> & {
    start: Omit<CellPosition, "cell">;
    end: Omit<CellPosition, "cell">;
  } | null;
  fileRange?: Range;
}

export type DiagnosticsByCell = Record<string, CellDiagnostic[]>;

interface DocumentLayout {
  text: string;
  lineMap: Array<{ cell: string; line: number } | null>;
  cellLines: Map<string, number[]>;
}

export interface LspClientOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  document: NotebookDocument;
  diagnostics?: boolean;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  stderrLimitBytes?: number;
  processId?: number | null;
  onFailure?: (message: string) => void;
  /** A full replacement for diagnostics belonging to the supplied source snapshot. */
  onDiagnostics?: (document: NotebookDocument, diagnostics: DiagnosticsByCell) => void;
  spawnProcess?: typeof spawn;
}

const MAX_LSP_DIAGNOSTICS = 1_000;
const MAX_LSP_DIAGNOSTIC_MESSAGE_BYTES = 4_096;
const MAX_LSP_DIAGNOSTIC_CODE_BYTES = 256;

export class LspClientError extends Error {
  constructor(readonly code: "lsp_unavailable" | "lsp_timeout" | "invalid_request", message: string) {
    super(message);
    this.name = "LspClientError";
  }
}

export function encodeFilePathUri(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return pathToFileURL(path).href;
  const normalized = path.replaceAll("\\", "/");
  const encoded = normalized
    .split("/")
    .map((segment, index) => index === 0 && /^[A-Za-z]:$/.test(segment)
      ? `${segment[0]}:`
      : encodeURIComponent(segment))
    .join("/");
  // R's languageserver accepts the RFC 8089 E.3.2 compatibility form for UNC.
  return normalized.startsWith("//") ? `file:///${encoded}` : `file:///${encoded}`;
}

export function fileUri(
  path: string,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absolute = platform === "win32"
    ? win32.resolve(cwd, path)
    : resolvePath(cwd, path);
  return encodeFilePathUri(absolute, platform);
}

function optionLine(key: string, value: unknown): string {
  let rendered: string;
  if (typeof value === "boolean") rendered = value ? "true" : "false";
  else if (value === null) rendered = "null";
  else if (Array.isArray(value)) rendered = value.join(",");
  else rendered = String(value);
  return `#| ${key}: ${rendered}`;
}

export function layoutNotebook(document: NotebookDocument): DocumentLayout {
  if (!document || !Array.isArray(document.cells)) {
    throw new LspClientError("invalid_request", "notebook document must contain cells");
  }
  const parts: string[] = [];
  const lineMap: Array<{ cell: string; line: number } | null> = [];
  const cellLines = new Map<string, number[]>();
  const append = (text: string, eol: string, mapped: { cell: string; line: number } | null) => {
    parts.push(text, eol);
    lineMap.push(mapped);
  };
  if (document.headerRecords) {
    for (const record of document.headerRecords) append(record.text, record.eol ?? "\n", null);
  } else {
    for (const line of document.header ?? []) append(line, "\n", null);
  }
  const ids = new Set<string>();
  for (const cell of document.cells) {
    if (!cell || typeof cell.id !== "string" || !cell.id || ids.has(cell.id) || !Array.isArray(cell.body)) {
      throw new LspClientError("invalid_request", "notebook cells require unique nonempty ids and source arrays");
    }
    ids.add(cell.id);
    const physical: number[] = [];
    if (cell.records) {
      let bodyLine = 0;
      for (const record of cell.records) {
        const mapped = record.kind === "body" ? { cell: cell.id, line: bodyLine++ } : null;
        if (mapped) physical.push(lineMap.length);
        append(record.text, record.eol ?? "\n", mapped);
      }
    } else {
      append(cell.delim ?? (cell.type === "markdown" ? "# %% [markdown]" : "# %%"), "\n", null);
      for (const [key, value] of Object.entries(cell.options ?? {})) append(optionLine(key, value), "\n", null);
      cell.body.forEach((line: string, bodyLine: number) => {
        physical.push(lineMap.length);
        append(line, "\n", { cell: cell.id, line: bodyLine });
      });
    }
    cellLines.set(cell.id, physical);
  }
  const serialized = parts.join("");
  return { text: document.text ?? serialized, lineMap, cellLines };
}

export function toFilePosition(document: NotebookDocument, position: CellPosition): Position | null {
  if (!validCoordinate(position.line) || !validCoordinate(position.character)) return null;
  const lines = layoutNotebook(document).cellLines.get(position.cell);
  const fileLine = lines?.[position.line];
  return fileLine === undefined ? null : { line: fileLine, character: position.character };
}

export function fromFilePosition(document: NotebookDocument, position: Position): CellPosition | null {
  if (!validCoordinate(position.line) || !validCoordinate(position.character)) return null;
  const mapped = layoutNotebook(document).lineMap[position.line];
  return mapped ? { cell: mapped.cell, line: mapped.line, character: position.character } : null;
}

function validCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

export function translateRange(range: unknown, document: NotebookDocument): CellRange | null {
  if (!isRecord(range) || !isPosition(range.start) || !isPosition(range.end)) return null;
  const start = fromFilePosition(document, range.start);
  const end = fromFilePosition(document, range.end);
  return start && end && start.cell === end.cell ? { start, end } : null;
}

function translateLocation(location: unknown, document: NotebookDocument, uri: string): unknown | null {
  if (!isRecord(location)) return null;
  if (location.uri !== undefined && location.uri !== uri) return null;
  const range = translateRange(location.range, document);
  return range ? { ...location, uri, range } : null;
}

export function translateLspResult(
  result: unknown,
  method: AlderLspMethod,
  document: NotebookDocument,
  uri: string,
): unknown {
  if (result === null || result === undefined) return null;
  if (method === "textDocument/definition" || method === "textDocument/references") {
    if (isRecord(result) && "uri" in result) return translateLocation(result, document, uri);
    if (!Array.isArray(result)) return [];
    return result.map((location) => translateLocation(location, document, uri)).filter((item) => item !== null);
  }
  if (method === "textDocument/hover" && isRecord(result) && result.range !== undefined) {
    return { ...result, range: translateRange(result.range, document) };
  }
  if (method === "textDocument/documentSymbol" && Array.isArray(result)) {
    return result.flatMap((symbol) => {
      if (!isRecord(symbol)) return [];
      const range = translateRange(symbol.range, document);
      const selectionRange = symbol.selectionRange === undefined ? undefined : translateRange(symbol.selectionRange, document);
      if (!range || (symbol.selectionRange !== undefined && !selectionRange)) return [];
      return [{ ...symbol, range, ...(selectionRange ? { selectionRange } : {}) }];
    });
  }
  if (method === "textDocument/completion") {
    const container = isRecord(result) && Array.isArray(result.items) ? result : null;
    const items: unknown[] | null = container
      ? container.items as unknown[]
      : Array.isArray(result) ? result : null;
    if (!items) return result;
    const translated = items.flatMap((item) => {
      if (!isRecord(item)) return [];
      if (isRecord(item.textEdit) && item.textEdit.range !== undefined) {
        const range = translateRange(item.textEdit.range, document);
        if (!range) return [];
        return [{ ...item, textEdit: { ...item.textEdit, range } }];
      }
      return [item];
    });
    return container ? { ...container, items: translated } : translated;
  }
  return result;
}

export class LspClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private document: NotebookDocument;
  private layout: DocumentLayout;
  private documentPath: string;
  private documentUri: string;
  private rootUri: string;
  private version = 1;
  private acceptVersionlessDiagnostics = true;
  private diagnostics = new Map<string, { version: number | undefined; diagnostics: Diagnostic[] }>();
  private diagnosticsEnabled: boolean;
  private closed = false;
  private initialized = false;
  private failure: string | null = null;
  private failureReported = false;
  private stderrText = "";
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: LspClientOptions) {
    this.document = options.document;
    this.layout = layoutNotebook(options.document);
    this.documentPath = resolveDocumentPath(options.document, options.cwd);
    this.documentUri = fileUri(this.documentPath);
    this.rootUri = fileUri(resolvePath(this.documentPath, ".."));
    this.diagnosticsEnabled = options.diagnostics === true;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  get uri(): string { return this.documentUri; }
  get documentVersion(): number { return this.version; }
  get failureMessage(): string | null { return this.failure; }

  alive(): boolean {
    return !this.closed && this.initialized && this.process !== null && this.process.exitCode === null && !this.process.killed;
  }

  async start(): Promise<this> {
    if (this.closed) throw new LspClientError("lsp_unavailable", "language server is stopped");
    if (this.connection) return this;
    const child = this.spawnProcess(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd ?? resolvePath(this.documentPath, ".."),
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    child.stderr.on("data", (chunk: Buffer) => this.retainStderr(chunk));
    child.once("error", (error) => this.reportFailure(this.failureDetail(`language server failed to start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (!this.closed) this.reportFailure(this.failureDetail(`language server exited${code === null ? "" : ` with status ${code}`}${signal ? ` (${signal})` : ""}`));
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection = connection;
    connection.onError(([error]) => this.reportFailure(this.failureDetail(`language server connection failed: ${error.message}`)));
    connection.onClose(() => {
      if (!this.closed) this.reportFailure(this.failureDetail("language server connection closed"));
    });
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      if (params.uri !== this.documentUri) return;
      if (params.version !== undefined && params.version !== this.version) return;
      // A versionless result can be associated safely with the initial open,
      // but after didChange an older asynchronous lint task can arrive late.
      // R languageserver includes versions; for servers that do not, prefer
      // omitting diagnostics over attaching them to the wrong source.
      if (params.version === undefined && !this.acceptVersionlessDiagnostics) return;
      this.diagnostics.set(params.uri, {
        version: params.version,
        diagnostics: this.diagnosticsEnabled ? params.diagnostics.slice(0, MAX_LSP_DIAGNOSTICS) : [],
      });
      this.publishDiagnostics();
    });
    connection.listen();
    const initialize: InitializeParams = {
      processId: this.options.processId === undefined ? process.pid : this.options.processId,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          references: {},
          documentSymbol: {},
          signatureHelp: {},
        },
        workspace: {},
      },
      workspaceFolders: [{ uri: this.rootUri, name: basenameForUri(this.rootUri) }],
    };
    await this.withTimeout(
      connection.sendRequest(InitializeRequest.type, initialize),
      this.options.initializeTimeoutMs ?? 30_000,
      "initialize",
    );
    connection.sendNotification(InitializedNotification.type, {});
    connection.sendNotification(DidChangeConfigurationNotification.type, { settings: { diagnostics: this.diagnosticsEnabled } });
    connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: this.documentUri,
        languageId: "r",
        version: this.version,
        text: this.layout.text,
      },
    });
    this.initialized = true;
    return this;
  }

  async syncDocument(document: NotebookDocument): Promise<boolean> {
    this.assertAlive();
    const nextPath = resolveDocumentPath(document, this.options.cwd);
    const nextUri = fileUri(nextPath);
    const nextLayout = layoutNotebook(document);
    const previousText = this.layout.text;
    if (nextUri !== this.documentUri) {
      this.connection!.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: this.documentUri } });
      this.diagnostics.delete(this.documentUri);
      this.documentPath = nextPath;
      this.documentUri = nextUri;
      this.version = 1;
      this.acceptVersionlessDiagnostics = true;
      this.document = document;
      this.layout = nextLayout;
      this.publishDiagnostics();
      this.connection!.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: nextUri, languageId: "r", version: this.version, text: nextLayout.text },
      });
      return true;
    }
    this.document = document;
    this.layout = nextLayout;
    if (nextLayout.text === previousText) return false;
    this.version += 1;
    this.acceptVersionlessDiagnostics = false;
    this.diagnostics.delete(this.documentUri);
    this.connection!.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: this.documentUri, version: this.version },
      contentChanges: [{ text: nextLayout.text }],
    });
    this.publishDiagnostics();
    return true;
  }

  async didSave(): Promise<void> {
    this.assertAlive();
    this.connection!.sendNotification(DidSaveTextDocumentNotification.type, {
      textDocument: { uri: this.documentUri },
      text: this.layout.text,
    });
  }

  async setDiagnostics(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== "boolean") throw new LspClientError("invalid_request", "diagnostics must be a boolean");
    this.assertAlive();
    if (enabled === this.diagnosticsEnabled) return false;
    this.diagnosticsEnabled = enabled;
    this.diagnostics.clear();
    this.publishDiagnostics();
    this.connection!.sendNotification(DidChangeConfigurationNotification.type, { settings: { diagnostics: enabled } });
    if (enabled) {
      this.version += 1;
      this.acceptVersionlessDiagnostics = false;
      this.connection!.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: this.documentUri, version: this.version },
        contentChanges: [{ text: this.layout.text }],
      });
    }
    return true;
  }

  async requestDocument(
    method: string,
    rawParams: Record<string, unknown>,
    document: NotebookDocument,
    timeoutMs = this.options.requestTimeoutMs ?? 3_000,
  ): Promise<unknown> {
    if (!(method in REQUEST_TYPES)) throw new LspClientError("invalid_request", "unsupported language-server method");
    await this.syncDocument(document);
    const params: Record<string, unknown> = { ...rawParams, textDocument: { ...(isRecord(rawParams.textDocument) ? rawParams.textDocument : {}), uri: this.documentUri } };
    if (isRecord(params.position) && typeof params.position.cell === "string") {
      const position = toFilePosition(document, {
        cell: params.position.cell,
        line: params.position.line as number,
        character: (params.position.character ?? 0) as number,
      });
      if (!position) throw new LspClientError("invalid_request", "position is outside a cell body");
      params.position = position;
    }
    const cancellation = new CancellationTokenSource();
    try {
      const result = await this.withTimeout(
        this.connection!.sendRequest(method, params, cancellation.token),
        timeoutMs,
        method,
        cancellation,
      );
      return translateLspResult(result, method as AlderLspMethod, document, this.documentUri);
    } catch (error) {
      if (error instanceof LspClientError) throw error;
      throw new LspClientError("invalid_request", `language server request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      cancellation.dispose();
    }
  }

  diagnosticsByCell(document: NotebookDocument = this.document): DiagnosticsByCell {
    if (!this.diagnosticsEnabled) return {};
    const result: DiagnosticsByCell = {};
    const rows = this.diagnostics.get(this.documentUri)?.diagnostics ?? [];
    for (const diagnostic of rows.slice(0, MAX_LSP_DIAGNOSTICS)) {
      if (!isRange(diagnostic.range)) continue;
      const start = fromFilePosition(document, diagnostic.range.start);
      const end = fromFilePosition(document, diagnostic.range.end);
      const severity = diagnostic.severity ?? 3;
      const item: CellDiagnostic = {
        level: severity === 1 ? "error" : severity === 2 ? "warning" : "info",
        code: boundedUtf8(diagnostic.code === undefined ? "lsp" : String(diagnostic.code), MAX_LSP_DIAGNOSTIC_CODE_BYTES),
        message: typeof diagnostic.message === "string"
          ? boundedUtf8(diagnostic.message, MAX_LSP_DIAGNOSTIC_MESSAGE_BYTES)
          : diagnostic.message && typeof diagnostic.message === "object" && "value" in diagnostic.message
            ? boundedUtf8(String(diagnostic.message.value), MAX_LSP_DIAGNOSTIC_MESSAGE_BYTES)
            : "language-server diagnostic",
        symbol: null,
        source: "lsp",
        range: null,
      };
      const key = start && end && start.cell === end.cell ? start.cell : ".document";
      if (key !== ".document") {
        item.range = {
          start: { line: start!.line, character: start!.character },
          end: { line: end!.line, character: end!.character },
        };
      } else {
        item.fileRange = cloneRange(diagnostic.range);
      }
      (result[key] ??= []).push(item);
    }
    return result;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.diagnostics.clear();
    this.publishDiagnostics();
    const connection = this.connection;
    const child = this.process;
    if (connection && this.initialized && child?.exitCode === null) {
      try {
        connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: this.documentUri } });
        await this.withTimeout(connection.sendRequest(ShutdownRequest.type), 2_000, "shutdown");
        connection.sendNotification(ExitNotification.type);
      } catch {
        // Termination below is the authoritative cleanup path.
      }
    }
    connection?.dispose();
    if (child && child.exitCode === null) {
      await terminateChild(child, 2_000);
    }
    this.connection = null;
    this.process = null;
    this.initialized = false;
  }

  private assertAlive(): void {
    if (!this.alive() || !this.connection) {
      throw new LspClientError("lsp_unavailable", this.failureDetail("language server is unavailable"));
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    method: string,
    cancellation?: CancellationTokenSource,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancellation?.cancel();
            reject(new LspClientError("lsp_timeout", `language server request timed out: ${method}`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private retainStderr(chunk: Buffer): void {
    this.stderrText += chunk.toString("utf8");
    const limit = Math.max(1_024, this.options.stderrLimitBytes ?? 16_384);
    const bytes = Buffer.from(this.stderrText);
    if (bytes.length > limit) this.stderrText = bytes.subarray(bytes.length - limit).toString("utf8");
  }

  private failureDetail(prefix: string): string {
    const stderr = this.stderrText.trim();
    return stderr ? `${prefix} (stderr: ${stderr})` : prefix;
  }

  private reportFailure(message: string): void {
    this.failure = message;
    if (this.closed || this.failureReported) return;
    this.failureReported = true;
    this.diagnostics.clear();
    this.publishDiagnostics();
    this.options.onFailure?.(message);
  }

  private publishDiagnostics(): void {
    if (!this.options.onDiagnostics) return;
    const document = cloneDocument(this.document);
    const diagnostics = this.diagnosticsByCell(document);
    try {
      this.options.onDiagnostics(document, diagnostics);
    } catch (error) {
      this.options.onFailure?.(`language-server diagnostics callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function resolveDocumentPath(document: NotebookDocument, cwd = process.cwd()): string {
  const supplied = typeof document.path === "string" && document.path ? document.path : `.alder-unsaved-${process.pid}.R`;
  return resolvePath(cwd, supplied);
}

function basenameForUri(uri: string): string {
  const pieces = new URL(uri).pathname.split("/").filter(Boolean);
  return decodeURIComponent(pieces.at(-1) ?? "workspace");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
  return isRecord(value) && validCoordinate(value.line) && validCoordinate(value.character);
}

function isRange(value: unknown): value is Range {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function cloneRange(range: Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function cloneDocument(document: NotebookDocument): NotebookDocument {
  return {
    ...(document.path === undefined ? {} : { path: document.path }),
    ...(document.text === undefined ? {} : { text: document.text }),
    ...(document.header === undefined ? {} : { header: [...document.header] }),
    ...(document.headerRecords === undefined ? {} : {
      headerRecords: document.headerRecords.map((record) => ({ ...record })),
    }),
    cells: document.cells.map((cell) => ({
      ...cell,
      body: [...cell.body],
      ...(cell.options === undefined ? {} : { options: structuredClone(cell.options) }),
      ...(cell.records === undefined ? {} : { records: cell.records.map((record) => ({ ...record })) }),
    })),
  };
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Avoid retaining half of a UTF-16 surrogate pair at the boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low -= 1;
  return value.slice(0, low);
}

async function terminateChild(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export function defaultRLanguageServerOptions(
  document: NotebookDocument,
  rscript = process.env.RSCRIPT ?? "Rscript",
): LspClientOptions {
  const path = resolveDocumentPath(document);
  return {
    command: rscript,
    args: ["--vanilla", "-e", "languageserver::run()"],
    cwd: resolvePath(path, ".."),
    document,
  };
}

export { TextDocumentSyncKind };
