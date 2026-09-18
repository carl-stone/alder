import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";
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
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
  SignatureHelpRequest,
  type Diagnostic,
  type InitializeParams,
  type Position,
  type Range,
} from "vscode-languageserver-protocol";
import {
  fromFilePosition,
  layoutNotebook,
  toFilePosition,
  translateRange,
  type CellPosition,
  type CellRange,
  type NotebookDocument,
  type NotebookLayout,
} from "./notebook.js";

const REQUEST_TYPES = {
  "textDocument/completion": CompletionRequest.type,
  "textDocument/hover": HoverRequest.type,
  "textDocument/definition": DefinitionRequest.type,
  "textDocument/references": ReferencesRequest.type,
  "textDocument/documentSymbol": DocumentSymbolRequest.type,
  "textDocument/signatureHelp": SignatureHelpRequest.type,
} as const;

export type AlderLspMethod = keyof typeof REQUEST_TYPES;

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

export interface LspClientOptions {
  connect: () => Promise<Duplex>;
  cwd?: string;
  document: NotebookDocument;
  diagnostics?: boolean;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  processId?: number | null;
  onFailure?: (message: string) => void;
  /** A full replacement for diagnostics belonging to the supplied source snapshot. */
  onDiagnostics?: (document: NotebookDocument, diagnostics: DiagnosticsByCell) => void;
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

export function encodeFilePathUri(path: string): string {
  return pathToFileURL(path).href;
}

export function fileUri(path: string, cwd = process.cwd()): string {
  return encodeFilePathUri(resolvePath(cwd, path));
}

function validCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function translateLocation(location: unknown, document: NotebookDocument, uri: string): unknown | null {
  if (!isRecord(location)) return null;
  if (location.uri !== undefined && location.uri !== uri) return null;
  const range = translateRange(location.range, document);
  return range ? { ...location, uri, range } : null;
}

function translateLocationLink(location: unknown, document: NotebookDocument, uri: string): unknown | null {
  if (!isRecord(location) || location.targetUri !== uri) return null;
  const targetRange = translateRange(location.targetRange, document);
  const targetSelectionRange = translateRange(location.targetSelectionRange, document);
  const originSelectionRange = location.originSelectionRange === undefined
    ? undefined
    : translateRange(location.originSelectionRange, document);
  if (!targetRange || !targetSelectionRange
    || (location.originSelectionRange !== undefined && !originSelectionRange)) return null;
  return {
    ...location, targetUri: uri, targetRange, targetSelectionRange,
    ...(originSelectionRange ? { originSelectionRange } : {}),
  };
}

function translateCompletionTextEdit(edit: unknown, document: NotebookDocument): unknown | null {
  if (!isRecord(edit)) return null;
  if (edit.range !== undefined) {
    const range = translateRange(edit.range, document);
    return range ? { ...edit, range } : null;
  }
  const insert = translateRange(edit.insert, document);
  const replace = translateRange(edit.replace, document);
  return insert && replace ? { ...edit, insert, replace } : null;
}

function translateDocumentSymbol(symbol: unknown, document: NotebookDocument, uri: string): unknown | null {
  if (!isRecord(symbol)) return null;
  if (isRecord(symbol.location)) {
    const location = translateLocation(symbol.location, document, uri);
    return location ? { ...symbol, location } : null;
  }
  const range = translateRange(symbol.range, document);
  const selectionRange = symbol.selectionRange === undefined ? undefined : translateRange(symbol.selectionRange, document);
  if (!range || (symbol.selectionRange !== undefined && !selectionRange)) return null;
  const children = symbol.children === undefined ? undefined
    : Array.isArray(symbol.children)
      ? symbol.children.map((child) => translateDocumentSymbol(child, document, uri)).filter((child) => child !== null)
      : null;
  if (children === null) return null;
  return { ...symbol, range, ...(selectionRange ? { selectionRange } : {}), ...(children ? { children } : {}) };
}


export function translateLspResult(
  result: unknown,
  method: AlderLspMethod,
  document: NotebookDocument,
  uri: string,
): unknown {
  if (result === null || result === undefined) return null;
  if (method === "textDocument/definition" || method === "textDocument/references") {
    const translate = (location: unknown) => isRecord(location) && "targetUri" in location
      ? translateLocationLink(location, document, uri)
      : translateLocation(location, document, uri);
    if (isRecord(result)) return translate(result);
    if (!Array.isArray(result)) return [];
    return result.map(translate).filter((item) => item !== null);
  }
  if (method === "textDocument/hover" && isRecord(result) && result.range !== undefined) {
    return { ...result, range: translateRange(result.range, document) };
  }
  if (method === "textDocument/documentSymbol" && Array.isArray(result)) {
    return result.map((symbol) => translateDocumentSymbol(symbol, document, uri)).filter((symbol) => symbol !== null);
  }
  if (method === "textDocument/completion") {
    const container = isRecord(result) && Array.isArray(result.items) ? result : null;
    const items: unknown[] | null = container
      ? container.items as unknown[]
      : Array.isArray(result) ? result : null;
    if (!items) return result;
    const translated = items.flatMap((item) => {
      if (!isRecord(item)) return [];
      const textEdit = item.textEdit === undefined ? undefined : translateCompletionTextEdit(item.textEdit, document);
      if (item.textEdit !== undefined && textEdit === null) return [];
      let additionalTextEdits: unknown[] | undefined;
      if (item.additionalTextEdits !== undefined) {
        if (!Array.isArray(item.additionalTextEdits)) return [];
        additionalTextEdits = item.additionalTextEdits.map((edit) => translateCompletionTextEdit(edit, document));
        if (additionalTextEdits.some((edit) => edit === null)) return [];
      }
      return [{
        ...item,
        ...(textEdit === undefined ? {} : { textEdit }),
        ...(additionalTextEdits === undefined ? {} : { additionalTextEdits }),
      }];
    });
    return container ? { ...container, items: translated } : translated;
  }
  return result;
}

export class LspClient {
  private socket: Duplex | null = null;
  private connection: MessageConnection | null = null;
  private document: NotebookDocument;
  private layout: NotebookLayout;
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

  constructor(private readonly options: LspClientOptions) {
    this.document = options.document;
    this.layout = layoutNotebook(options.document);
    this.documentPath = resolveDocumentPath(options.document, options.cwd);
    this.documentUri = fileUri(this.documentPath);
    this.rootUri = fileUri(resolvePath(this.documentPath, ".."));
    this.diagnosticsEnabled = options.diagnostics === true;
  }

  get uri(): string { return this.documentUri; }
  get documentVersion(): number { return this.version; }
  get failureMessage(): string | null { return this.failure; }

  alive(): boolean {
    return !this.closed && this.initialized && this.socket !== null && !this.socket.destroyed;
  }

  async start(): Promise<this> {
    if (this.closed) throw new LspClientError("lsp_unavailable", "language server is stopped");
    if (this.connection) return this;
    this.failure = null;
    this.failureReported = false;
    let socket: Duplex;
    try {
      socket = await this.options.connect();
    } catch (error) {
      throw new LspClientError("lsp_unavailable", `Ark language server is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.socket = socket;
    socket.on("close", () => { if (!this.closed) this.reportFailure("Ark language server connection closed"); });
    const connection = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    );
    this.connection = connection;
    connection.onError(([error]) => this.reportFailure("language server connection failed: " + error.message));
    connection.onClose(() => {
      if (!this.closed) this.reportFailure("language server connection closed");
    });
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      if (params.uri !== this.documentUri) return;
      if (params.version !== undefined && params.version !== this.version) return;
      // A versionless result can be associated safely with the initial open,
      // but after didChange an older asynchronous lint task can arrive late.
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
    try {
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
    } catch (error) {
      if (!this.closed && this.connection === connection) {
        connection.dispose();
        this.connection = null;
        this.initialized = false;
        this.socket?.destroy();
        this.socket = null;
      }
      throw error;
    }
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
      this.acceptVersionlessDiagnostics = true;
      this.connection!.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: this.documentUri } });
      this.connection!.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: this.documentUri, languageId: "r", version: this.version, text: this.layout.text },
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
      if (!this.alive()) throw new LspClientError("lsp_unavailable", this.failure ?? "Ark language server is unavailable");
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
    if (connection && this.initialized && this.socket !== null && !this.socket.destroyed) {
      try {
        connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: this.documentUri } });
        await this.withTimeout(connection.sendRequest(ShutdownRequest.type), 2_000, "shutdown");
      } catch {
        // Termination below is the authoritative cleanup path.
      }
    }
    const socket = this.socket;
    socket?.end();
    connection?.dispose();
    if (socket && !socket.destroyed) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        socket.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    socket?.destroy();
    this.socket = null;
    this.connection = null;
    this.initialized = false;
  }

  private assertAlive(): void {
    if (!this.alive() || !this.connection) {
      throw new LspClientError("lsp_unavailable", this.failure ?? "language server is unavailable");
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
    ...document,
    ...(document.header === undefined ? {} : { header: [...document.header] }),
    ...(document.headerRecords === undefined ? {} : {
      headerRecords: document.headerRecords.map((record) => ({ ...record })),
    }),
    ...(document.metadata === undefined ? {} : { metadata: structuredClone(document.metadata) }),
    ...(document.bom instanceof Uint8Array ? { bom: new Uint8Array(document.bom) } : {}),
    cells: document.cells.map((cell) => ({
      ...cell,
      body: [...cell.body],
      ...(cell.options === undefined ? {} : { options: structuredClone(cell.options) }),
      ...(cell.records === undefined ? {} : { records: cell.records.map((record) => ({ ...record })) }),
      ...(cell.raw === undefined ? {} : { raw: [...cell.raw] }),
      ...(cell.optionDuplicates === undefined ? {} : {
        optionDuplicates: Object.fromEntries(Object.entries(cell.optionDuplicates).map(([key, values]) => [key, [...values]])),
      }),
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
