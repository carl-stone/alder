import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, chmod, link, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseHTML } from "linkedom";
import renderHtml from "dom-serializer";
import { Comment, Element as HtmlElement, Text, type AnyNode } from "domhandler";

import { OutputStore, OutputStoreError, collectArtifactHandles, type OutputStoreSnapshot } from "./outputs.js";
import { OutputRenderer, type OutputArtifactSource } from "./output-renderer.js";
import type { ArtifactHandle, JsonValue, OutputRecord } from "./protocol.js";

const MAX_QUARTO_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PUBLISHED_HTML_BYTES = 128 * 1024 * 1024;

export interface PublishingProcessScope {
  spawn(options: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: Record<string, string>;
    stdio: "pipes" | "ignore";
  }): Promise<PublishingOwnedProcess>;
}

export interface PublishingOwnedProcess {
  stdout: AsyncIterable<Uint8Array> | null;
  stderr: AsyncIterable<Uint8Array> | null;
  exited: Promise<{ code: number | null; signal: string | null }>;
  terminate(): Promise<void>;
}

export interface PublicationCell {
  id: string;
  type: "code" | "markdown";
  body: readonly string[];
  options: Readonly<Record<string, unknown>>;
  revision: number;
  outputs: readonly OutputRecord[];
  log?: readonly string[];
  progress?: JsonValue | null;
}

/** One immutable view of the last saved source and outputs compatible with it. */
export interface PublicationSnapshot {
  documentRevision: number;
  path: string | null;
  metadata: Readonly<Record<string, JsonValue>>;
  editorDirty: boolean;
  cells: readonly PublicationCell[];
}

export interface PublishingServiceOptions {
  outputStore: OutputStore;
  processScope: PublishingProcessScope;
}

export interface PublishSnapshotOptions {
  outputPath: string;
  includeCode: boolean;
  signal?: AbortSignal;
}

export interface PublishSnapshotResult {
  path: string;
  documentRevision: number;
  source: "last-saved";
  unsavedChangesExcluded: boolean;
}

export interface PublishingService {
  publishSnapshot(snapshot: PublicationSnapshot, options: PublishSnapshotOptions): Promise<PublishSnapshotResult>;
}

export type PublishingErrorCode =
  | "tool_not_found"
  | "destination_exists"
  | "publish_failed"
  | "output_expired"
  | "output_quota"
  | "cancelled";

export class PublishingError extends Error {
  constructor(readonly code: PublishingErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "PublishingError";
  }
}

export function createPublishingService(options: PublishingServiceOptions): PublishingService {
  if (!(options?.outputStore instanceof OutputStore)) throw new TypeError("publishing requires the canonical OutputStore");
  if (!options.processScope || typeof options.processScope.spawn !== "function") throw new TypeError("publishing requires the application ProcessScope");
  return {
    publishSnapshot: (snapshot, publishOptions) => publishSnapshot(options.outputStore, options.processScope, snapshot, publishOptions),
  };
}

async function publishSnapshot(
  outputStore: OutputStore,
  processScope: PublishingProcessScope,
  source: PublicationSnapshot,
  options: PublishSnapshotOptions,
): Promise<PublishSnapshotResult> {
  throwIfAborted(options?.signal);
  validateOptions(options);
  const snapshot = captureSnapshot(outputStore, source);
  const outputPath = await validateDestinationPath(options.outputPath);
  let stagingDirectory: string | undefined;
  outputStore.pin(snapshot.artifacts);
  try {
    stagingDirectory = await mkdtemp(join(tmpdir(), "alder-publish-"));
    const qmdPath = join(stagingDirectory, "snapshot.qmd");
    const renderedPath = join(stagingDirectory, "rendered.html");
    const qmd = await composeQmd(snapshot, outputStore, options.includeCode, options.signal);
    await writeFile(qmdPath, qmd, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const quarto = await findQuartoExecutable();
    await runQuarto(processScope, quarto, stagingDirectory, qmdPath, renderedPath, options.signal);
    throwIfAborted(options.signal);
    const rendered = await readFile(renderedPath);
    if (rendered.byteLength === 0 || rendered.byteLength > MAX_PUBLISHED_HTML_BYTES) {
      throw new PublishingError("publish_failed", "Quarto did not produce a bounded HTML document");
    }
    await publishAbsentDestination(outputPath, rendered, options.signal);
    return {
      path: outputPath,
      documentRevision: snapshot.documentRevision,
      source: "last-saved",
      unsavedChangesExcluded: snapshot.editorDirty,
    };
  } catch (error) {
    throw normalizePublishingError(error);
  } finally {
    outputStore.unpin(snapshot.artifacts);
    if (stagingDirectory !== undefined) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

type CapturedPublication = PublicationSnapshot & { artifacts: readonly ArtifactHandle[] };

function captureSnapshot(outputStore: OutputStore, source: PublicationSnapshot): CapturedPublication {
  if (!source || !Number.isSafeInteger(source.documentRevision) || source.documentRevision < 0 || !Array.isArray(source.cells)) {
    throw new PublishingError("publish_failed", "publication snapshot is invalid");
  }
  let retained: OutputStoreSnapshot;
  try {
    retained = outputStore.snapshot({ cellIds: source.cells.map((cell) => cell.id) });
  } catch (error) {
    throw normalizeOutputError(error);
  }
  const retainedRecords = new Map(retained.records.map((record) => [record.id, record]));
  const retainedArtifacts = new Map(retained.artifacts.map((artifact) => [artifact.handle, artifact]));
  const records: OutputRecord[] = [];
  const cells = source.cells.map((cell) => {
    const outputs = cell.outputs.flatMap((record: OutputRecord) => {
      const current = retainedRecords.get(record.id);
      if (current === undefined || current.cellId !== cell.id || current.revision !== cell.revision) return [];
      const captured = structuredClone(current);
      records.push(captured);
      return [captured];
    });
    return {
      id: cell.id,
      type: cell.type,
      body: [...cell.body],
      options: structuredClone(cell.options),
      revision: cell.revision,
      outputs,
      log: [...(cell.log ?? [])],
      progress: structuredClone(cell.progress ?? null),
    } satisfies PublicationCell;
  });
  const artifacts = new Map<string, ArtifactHandle>();
  for (const record of records) {
    for (const reference of collectArtifactHandles(record.data)) {
      const descriptor = retainedArtifacts.get(reference.handle);
      if (descriptor !== undefined) artifacts.set(descriptor.handle, descriptor);
    }
  }
  return Object.freeze({
    documentRevision: source.documentRevision,
    path: source.path,
    metadata: structuredClone(source.metadata),
    editorDirty: source.editorDirty,
    cells: Object.freeze(cells),
    artifacts: Object.freeze([...artifacts.values()]),
  });
}

async function composeQmd(
  snapshot: CapturedPublication,
  outputStore: OutputStore,
  includeCode: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const artifactByHandle = new Map(snapshot.artifacts.map((artifact) => [artifact.handle, artifact]));
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const renderer = new OutputRenderer({
    document,
    mode: "static",
    resolveArtifact: async (descriptor): Promise<OutputArtifactSource> => {
      const bytes = await readArtifact(descriptor, artifactByHandle, outputStore, signal);
      if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(descriptor.mimeType)) {
        return { kind: "html", html: decodeUtf8(bytes, descriptor.handle) };
      }
      return { kind: "url", url: `data:${descriptor.mimeType};base64,${bytes.toString("base64")}` };
    },
  });
  const lines = [
    "---",
    "title: " + JSON.stringify(titleOf(snapshot)),
    "format:",
    "  html:",
    "    embed-resources: true",
    "    code-overflow: wrap",
    "execute:",
    "  enabled: false",
    "---",
    "",
    `<style>${PUBLISH_CSS}</style>`,
    "",
  ];
  for (const cell of snapshot.cells) {
    throwIfAborted(signal);
    if (cell.type === "markdown") {
      lines.push(...cell.body, "");
    } else if (includeCode && cell.options.hide_code !== true) {
      const fence = fenceFor(cell.body);
      lines.push(fence + "r", ...cell.body, fence, "");
    }
    for (const log of cell.log ?? []) if (log.length > 0) lines.push(`<pre class="output-log">${escapeHtml(log)}</pre>`, "");
    const container = document.createElement("div");
    renderer.render(container, cell.outputs, cell.progress ?? null);
    await renderer.flushArtifacts();
    const rendered = serializeDomChildren(container);
    if (rendered.length > 0) lines.push(rendered, "");
  }
  return `${lines.join("\n")}\n`;
}

function serializeDomChildren(container: Element): string {
  return renderHtml(Array.from(container.childNodes, htmlNode), { encodeEntities: "utf8" });
}

function htmlNode(node: Node): AnyNode {
  if (node.nodeType === 3) return new Text(node.nodeValue ?? "");
  if (node.nodeType === 8) return new Comment(node.nodeValue ?? "");
  if (node.nodeType === 1) {
    const element = node as Element;
    const children = Array.from(element.childNodes, htmlNode);
    const converted = new HtmlElement(element.localName, Object.fromEntries(Array.from(element.attributes, (attribute) => [attribute.name, attribute.value])), children);
    for (const child of children) child.parent = converted;
    return converted;
  }
  throw new Error(`Unsupported DOM node type ${node.nodeType}`);
}

async function readArtifact(
  requested: ArtifactHandle,
  artifacts: ReadonlyMap<string, ArtifactHandle>,
  outputStore: OutputStore,
  signal?: AbortSignal,
): Promise<Buffer> {
  const descriptor = artifacts.get(requested.handle);
  if (descriptor === undefined) throw new PublishingError("output_expired", `published artifact ${requested.handle} is no longer retained`);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < descriptor.byteLength) {
    throwIfAborted(signal);
    let chunk: Uint8Array;
    try {
      chunk = await outputStore.readArtifact(descriptor.handle, offset, Math.min(descriptor.chunkBytes, descriptor.byteLength - offset));
    } catch (error) {
      throw normalizeOutputError(error);
    }
    if (chunk.byteLength === 0) throw new PublishingError("output_expired", `published artifact ${descriptor.handle} ended early`);
    chunks.push(Buffer.from(chunk));
    offset += chunk.byteLength;
  }
  return Buffer.concat(chunks, descriptor.byteLength);
}

async function findQuartoExecutable(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, "quarto");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {}
  }
  throw new PublishingError("tool_not_found", "Quarto is required for HTML publishing but was not found on PATH");
}

async function runQuarto(processScope: PublishingProcessScope, executable: string, cwd: string, qmdPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let owned: PublishingOwnedProcess;
  try {
    owned = await processScope.spawn({
      executable,
      args: ["render", basename(qmdPath), "--to", "html", "--output", basename(outputPath), "--no-execute"],
      cwd,
      environment: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        QUARTO_PROJECT_DIR: cwd,
        QUARTO_PROFILE: "",
      },
      stdio: "pipes",
    });
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new PublishingError("tool_not_found", "Quarto executable disappeared before launch");
    throw error;
  }
  let aborted = signal?.aborted === true;
  const abort = () => { aborted = true; void owned.terminate().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (aborted) abort();
  try {
    const stdout = collectStream(owned.stdout);
    const stderr = collectStream(owned.stderr);
    const exit = await owned.exited;
    const [out, err] = await Promise.all([stdout, stderr]);
    if (aborted) throw new PublishingError("cancelled", "publishing was cancelled");
    if (exit.code !== 0) throw new PublishingError("publish_failed", `Quarto exited with status ${exit.code ?? "unknown"}${err ? `: ${err}` : ""}`, { ...exit, stdout: out, stderr: err });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function collectStream(stream: AsyncIterable<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      if (bytes >= MAX_QUARTO_STREAM_BYTES) continue;
      const bounded = chunk.subarray(0, MAX_QUARTO_STREAM_BYTES - bytes);
      chunks.push(Buffer.from(bounded));
      bytes += bounded.byteLength;
    }
  } catch (error) {
    return `[stream read failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function validateDestinationPath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim().length === 0) throw new PublishingError("publish_failed", "publish outputPath must be a non-empty path");
  const outputPath = resolve(path);
  let parent;
  try { parent = await stat(dirname(outputPath)); }
  catch (error) { throw new PublishingError("publish_failed", `publish output directory is unavailable: ${dirname(outputPath)}`, error); }
  if (!parent.isDirectory()) throw new PublishingError("publish_failed", `publish output parent is not a directory: ${dirname(outputPath)}`);
  try {
    await access(outputPath);
    throw new PublishingError("destination_exists", `publish destination already exists: ${outputPath}`);
  } catch (error) {
    if (error instanceof PublishingError) throw error;
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return outputPath;
}

async function publishAbsentDestination(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.alder-${process.pid}-${randomUUID()}.tmp`);
  try {
    throwIfAborted(signal);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o644);
    throwIfAborted(signal);
    await link(temporary, path);
  } catch (error) {
    throw normalizePublishingError(error);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function validateOptions(options: PublishSnapshotOptions): void {
  if (!options || typeof options.outputPath !== "string" || typeof options.includeCode !== "boolean") {
    throw new PublishingError("publish_failed", "publish options are invalid");
  }
}

function fenceFor(lines: readonly string[]): string {
  let longest = 2;
  for (const line of lines) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function titleOf(snapshot: PublicationSnapshot): string {
  const title = snapshot.metadata.title;
  return typeof title === "string" && title.trim().length > 0 ? title : "Alder notebook";
}

function decodeUtf8(bytes: Uint8Array, handle: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PublishingError("publish_failed", `HTML artifact ${handle} is not valid UTF-8`); }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PublishingError("cancelled", "publishing was cancelled");
}

function normalizeOutputError(error: unknown): PublishingError {
  if (error instanceof PublishingError) return error;
  if (error instanceof OutputStoreError) {
    if (error.code === "not_found" || error.code === "output_expired") return new PublishingError("output_expired", error.message);
    if (error.code === "output_quota") return new PublishingError("output_quota", error.message);
    return new PublishingError("publish_failed", error.message);
  }
  return normalizePublishingError(error);
}

function normalizePublishingError(error: unknown): PublishingError {
  if (error instanceof PublishingError) return error;
  if (error instanceof OutputStoreError) return normalizeOutputError(error);
  if (isErrno(error, "EEXIST")) return new PublishingError("destination_exists", "publish destination already exists");
  if (isErrno(error, "ENOENT")) return new PublishingError("publish_failed", "publication input or output was not produced");
  return new PublishingError("publish_failed", error instanceof Error ? error.message : String(error));
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const PUBLISH_CSS = `
:root { color-scheme: light dark; }
.value-text, .value-json, .output-log, .output-error { white-space: pre-wrap; }
.html-widget, .media-pdf { width: 100%; min-height: 2rem; border: 0; }
.media-pdf { min-height: 420px; }
.plot, .out-media, .markdown-output, .html-inline { max-width: 100%; }
.table-preview { overflow-x: auto; }
.table-preview table { border-collapse: collapse; }
.table-preview th, .table-preview td { border: 1px solid currentColor; padding: .25rem .5rem; text-align: left; }
.widget-container, .widget-group { display: inline-flex; gap: .5rem; align-items: center; }
.out-lazy { opacity: .75; }
`;
