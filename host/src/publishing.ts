import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseHTML } from "linkedom";
import renderHtml from "dom-serializer";
import { Comment, Element as HtmlElement, Text, type AnyNode } from "domhandler";

import {
  OutputStore,
  OutputStoreError,
  collectArtifactHandles,
  type OutputStoreSnapshot,
} from "./outputs.js";
import { OutputRenderer, type OutputArtifactSource } from "./output-renderer.js";
import type {
  ArtifactHandle,
  HostSnapshot,
  OutputRecord,
} from "./protocol.js";

const MAX_QUARTO_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_PUBLISHED_HTML_BYTES = 128 * 1024 * 1024;
const QUARTO_COMMAND = "quarto";
const PUBLISH_TITLE_MARKER = "ALDER_PUBLISH_TITLE_MARKER_" + randomUUID().replaceAll("-", "");
const HTML_RESOURCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ["src", "srcset"],
  audio: ["src"],
  video: ["src", "poster"],
  source: ["src", "srcset"],
  script: ["src"],
  iframe: ["src"],
  object: ["data"],
  embed: ["src"],
  track: ["src"],
  link: ["href"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
  input: ["src"],
};
const HTML_CSS_URL = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
const HTML_CSS_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)'|([^\s;]+))/gi;

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
}

export interface PublishingService {
  publishSnapshot(
    snapshot: HostSnapshot,
    options: PublishSnapshotOptions,
  ): Promise<PublishSnapshotResult>;
}

export type PublishingErrorCode =
  | "publish_not_ready"
  | "tool_not_found"
  | "destination_exists"
  | "publish_external_assets"
  | "publish_failed"
  | "stale_value"
  | "output_expired"
  | "output_quota"
  | "cancelled";

export class PublishingError extends Error {
  constructor(
    readonly code: PublishingErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PublishingError";
  }
}

/**
 * Bind publishing to the application's canonical output store and process
 * scope. The publisher never starts R and never discovers a notebook/project
 * path; the caller supplies the settled HostSnapshot and output store.
 */
export function createPublishingService(options: PublishingServiceOptions): PublishingService {
  if (!(options?.outputStore instanceof OutputStore)) {
    throw new TypeError("publishing requires the canonical OutputStore");
  }
  if (!options.processScope || typeof options.processScope.spawn !== "function") {
    throw new TypeError("publishing requires the application ProcessScope");
  }

  return {
    publishSnapshot: (snapshot, publishOptions) => publishSnapshot(
      options.outputStore,
      options.processScope,
      snapshot,
      publishOptions,
    ),
  };
}

async function publishSnapshot(
  outputStore: OutputStore,
  processScope: PublishingProcessScope,
  snapshot: HostSnapshot,
  options: PublishSnapshotOptions,
): Promise<PublishSnapshotResult> {
  throwIfAborted(options?.signal);
  validatePublishOptions(options);
  assertSettledSnapshot(snapshot);
  const outputPath = await validateDestinationPath(options.outputPath);

  let stagingDirectory: string | undefined;
  let pinned: readonly ArtifactHandle[] = [];
  try {
    throwIfAborted(options.signal);
    const captured = captureOutputs(outputStore, snapshot);
    pinned = captured.artifacts;
    outputStore.pin(pinned);

    stagingDirectory = await mkdtemp(join(tmpdir(), "alder-publish-"));
    const qmdPath = join(stagingDirectory, "snapshot.qmd");
    const renderedPath = join(stagingDirectory, "rendered.html");
    const qmd = await composeQmd(snapshot, captured.records, outputStore, captured.artifacts, options.includeCode, options.signal);
    await writeFile(qmdPath, qmd, { encoding: "utf8", mode: 0o600, flag: "wx" });

    const quarto = await findQuartoExecutable();
    await runQuarto(processScope, quarto, stagingDirectory, qmdPath, renderedPath, options.signal);
    throwIfAborted(options.signal);

    const rendered = await readFile(renderedPath);
    if (rendered.byteLength === 0 || rendered.byteLength > MAX_PUBLISHED_HTML_BYTES) {
      throw new PublishingError("publish_failed", "Quarto did not produce a bounded HTML document");
    }
    const html = restorePublishedTitle(restorePublishedLiterals(new TextDecoder("utf-8", { fatal: true }).decode(rendered)), titleOf(snapshot));
    const finalBytes = Buffer.from(html, "utf8");
    if (finalBytes.byteLength === 0 || finalBytes.byteLength > MAX_PUBLISHED_HTML_BYTES) {
      throw new PublishingError("publish_failed", "published HTML exceeded its bounded size");
    }
    assertNoExternalAssets(html, "published HTML");
    // Recheck the canonical store after Quarto: package/kernel/document changes may have invalidated the capture while it rendered.
    captureOutputs(outputStore, snapshot);
    await publishAbsentDestination(outputPath, finalBytes, options.signal);
    return { path: outputPath, documentRevision: snapshot.documentRevision };
  } catch (error) {
    throw normalizePublishingError(error);
  } finally {
    outputStore.unpin(pinned);
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function validatePublishOptions(options: PublishSnapshotOptions): void {
  if (!options || typeof options.outputPath !== "string" || options.outputPath.trim().length === 0) {
    throw new PublishingError("publish_failed", "publish outputPath must be a non-empty path");
  }
  if (typeof options.includeCode !== "boolean") {
    throw new PublishingError("publish_failed", "publish includeCode must be boolean");
  }
}

function assertSettledSnapshot(snapshot: HostSnapshot): void {
  if (!snapshot || snapshot.protocol !== "alder-host-v2" || !Number.isSafeInteger(snapshot.documentRevision) || snapshot.documentRevision < 0) {
    throw new PublishingError("publish_not_ready", "publish requires a valid host snapshot");
  }
  const runtime = snapshot.runtime;
  if (
    !runtime.documentReady ||
    !runtime.executionReady ||
    runtime.analyzerState !== "ready" ||
    runtime.kernelState !== "ready" ||
    runtime.activeRunId !== null ||
    runtime.busy ||
    runtime.packageOperationActive ||
    runtime.executionBlockedReason !== null
  ) {
    throw new PublishingError("publish_not_ready", "publish requires an idle, unblocked host");
  }

  const cells = snapshot.cells;
  const disabled = new Set(
    cells
      .filter((cell) => cell.status === "disabled" || cell.options.disabled === true)
      .map((cell) => cell.id),
  );
  const blocked = new Set(disabled);
  const queue = [...disabled];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const dependent of snapshot.graph.reverseEdges[id] ?? []) {
      if (blocked.has(dependent)) continue;
      blocked.add(dependent);
      queue.push(dependent);
    }
  }

  const enabledCodeCells = cells.filter((cell) => cell.type === "code" && !disabled.has(cell.id));
  const blockers: string[] = [];
  for (const cell of enabledCodeCells) {
    if (["stale", "error", "running"].includes(cell.status)) {
      blockers.push(`${cell.id}:${cell.status}`);
    }
    if (cell.outputsStale === true) blockers.push(`${cell.id}:outputs_stale`);
    if (cell.analysisPending) blockers.push(`${cell.id}:analysis_pending`);
    if (cell.error !== null) blockers.push(`${cell.id}:analysis_error`);
    if (cell.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      blockers.push(`${cell.id}:diagnostic_error`);
    }
    if (blocked.has(cell.id)) blockers.push(`${cell.id}:blocked`);
  }
  for (const cell of cells) {
    if (cell.type !== "markdown" || disabled.has(cell.id)) continue;
    if (["stale", "error", "running"].includes(cell.status)) blockers.push(`${cell.id}:${cell.status}`);
    if (cell.outputsStale === true) blockers.push(`${cell.id}:outputs_stale`);
  }

  const disabledOnly = (ids: readonly string[]): boolean => ids.length > 0 && ids.every((id) => disabled.has(id));
  if (snapshot.graph.cycles.length > 0 && !disabledOnly(snapshot.graph.cycles)) {
    blockers.push("graph:dependency_cycle");
  }
  const duplicateCells = Object.values(snapshot.graph.duplicates).flat();
  if (duplicateCells.length > 0 && !disabledOnly(duplicateCells)) {
    blockers.push("graph:duplicate_definition");
  }
  if (snapshot.graph.topologicalOrder === null && enabledCodeCells.length > 0) {
    blockers.push("graph:invalid");
  }
  if (blockers.length > 0) {
    throw new PublishingError(
      "publish_not_ready",
      `publish requires settled enabled cells: ${blockers.join(", ")}`,
      { cells: blockers },
    );
  }
}

async function validateDestinationPath(path: string): Promise<string> {
  const outputPath = resolve(path);
  const parent = dirname(outputPath);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new PublishingError("publish_failed", `publish output directory does not exist: ${parent}`);
    }
    throw error;
  }
  if (!parentStat.isDirectory()) {
    throw new PublishingError("publish_failed", `publish output parent is not a directory: ${parent}`);
  }
  try {
    await lstat(outputPath);
    throw new PublishingError("destination_exists", `publish destination already exists: ${outputPath}`);
  } catch (error) {
    if (error instanceof PublishingError) throw error;
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return outputPath;
}

type CapturedOutputs = {
  records: readonly OutputRecord[];
  artifacts: readonly ArtifactHandle[];
};

function captureOutputs(outputStore: OutputStore, snapshot: HostSnapshot): CapturedOutputs {
  let storeSnapshot: OutputStoreSnapshot;
  try {
    storeSnapshot = outputStore.snapshot({
      cellIds: snapshot.cells.map((cell) => cell.id),
      documentRevision: snapshot.documentRevision,
      kernelEpoch: snapshot.runtime.kernelEpoch,
    });
  } catch (error) {
    throw normalizeOutputError(error);
  }

  const expectedByCell = new Map<string, readonly OutputRecord[]>();
  const expectedById = new Map<string, OutputRecord>();
  for (const cell of snapshot.cells) {
    const records = [...cell.outputs].sort((left, right) => left.sequence - right.sequence);
    expectedByCell.set(cell.id, records);
    for (const record of records) {
      if (expectedById.has(record.id)) {
        throw new PublishingError("stale_value", `publish snapshot repeats output ${record.id}`);
      }
      expectedById.set(record.id, record);
      const staticMarkdown =
        cell.type === "markdown" &&
        "kind" in record.data &&
        record.data.kind === "markdown" &&
        record.kernelEpoch === null &&
        record.runId === null;
      const liveRuntime =
        cell.type === "code" &&
        record.kernelEpoch === snapshot.runtime.kernelEpoch &&
        record.runId !== null;
      if (
        record.sessionEpoch !== snapshot.epoch ||
        record.cellId !== cell.id ||
        record.revision !== cell.revision ||
        (!staticMarkdown && !liveRuntime)
      ) {
        throw new PublishingError("stale_value", `publish output ${record.id} has a stale runtime identity`);
      }
    }
  }

  const actualByCell = new Map<string, OutputRecord[]>();
  for (const record of storeSnapshot.records) {
    const records = actualByCell.get(record.cellId) ?? [];
    records.push(record);
    actualByCell.set(record.cellId, records);
  }
  for (const cell of snapshot.cells) {
    const expected = expectedByCell.get(cell.id) ?? [];
    const actual = actualByCell.get(cell.id) ?? [];
    if (expected.length !== actual.length) {
      throw new PublishingError("stale_value", `publish output set changed for cell ${cell.id}`);
    }
    const actualById = new Map(actual.map((record) => [record.id, record]));
    for (const record of expected) {
      const current = actualById.get(record.id);
      if (current === undefined || stableJson(current) !== stableJson(record)) {
        throw new PublishingError("stale_value", `publish output ${record.id} is no longer current`);
      }
    }
  }

  const referenced = new Map<string, ArtifactHandle>();
  for (const record of expectedById.values()) {
    for (const descriptor of collectArtifactHandles(record.data)) referenced.set(descriptor.handle, descriptor);
  }
  const descriptors = new Map(storeSnapshot.artifacts.map((artifact) => [artifact.handle, artifact]));
  for (const handle of referenced.keys()) {
    const descriptor = descriptors.get(handle);
    if (descriptor === undefined) {
      throw new PublishingError("output_expired", `publish artifact ${handle} is no longer retained`);
    }
    if (
      descriptor.epoch !== snapshot.epoch ||
      descriptor.documentRevision !== snapshot.documentRevision ||
      descriptor.kernelEpoch !== snapshot.runtime.kernelEpoch
    ) {
      throw new PublishingError("stale_value", `publish artifact ${handle} has a stale snapshot identity`);
    }
  }
  return {
    records: Object.freeze([...expectedById.values()]),
    artifacts: Object.freeze([...storeSnapshot.artifacts]),
  };
}

async function composeQmd(
  snapshot: HostSnapshot,
  records: readonly OutputRecord[],
  outputStore: OutputStore,
  artifacts: readonly ArtifactHandle[],
  includeCode: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const recordsByCell = new Map<string, OutputRecord[]>();
  for (const record of records) {
    const values = recordsByCell.get(record.cellId) ?? [];
    values.push(record);
    recordsByCell.set(record.cellId, values);
  }
  for (const values of recordsByCell.values()) values.sort((left, right) => left.sequence - right.sequence);

  const artifactByHandle = new Map(artifacts.map((artifact) => [artifact.handle, artifact]));
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const renderer = new OutputRenderer({
    document,
    mode: "static",
    resolveArtifact: async (descriptor): Promise<OutputArtifactSource> => {
      const artifact = await readArtifactReference(descriptor, artifactByHandle, outputStore, signal);
      throwIfAborted(signal);
      if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(descriptor.mimeType)) {
        const html = decodeArtifactText(artifact.bytes, artifact.handle);
        assertNoExternalAssets(html, `HTML artifact ${artifact.handle}`);
        return { kind: "html", html: withContentSecurityPolicy(html) };
      }
      return {
        kind: "url",
        url: `data:${descriptor.mimeType};base64,${artifact.bytes.toString("base64")}`,
      };
    },
  });
  const lines = [
    "---",
    "title: " + yamlString(PUBLISH_TITLE_MARKER),
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
  const renderCellOutputs = async (cell: HostSnapshot["cells"][number]): Promise<void> => {
    const container = document.createElement("div");
    renderer.render(container, recordsByCell.get(cell.id) ?? [], cell.progress);
    await renderer.flushArtifacts();
    const rendered = serializeDomChildren(container);
    if (rendered.length === 0) return;
    assertNoExternalAssets(rendered, `cell ${cell.id} output`);
    lines.push(neutralizeQuartoTokens(rendered), "");
  };
  for (const cell of snapshot.cells) {
    throwIfAborted(signal);
    if (cell.type === "markdown") {
      await renderCellOutputs(cell);
      continue;
    }
    if (includeCode && cell.options.hide_code !== true) {
      const fence = fenceFor(cell.body);
      lines.push(fence + "r", ...cell.body.map(neutralizeQuartoTokens), fence, "");
    }
    for (const log of cell.log) {
      if (log.length > 0) lines.push(neutralizeQuartoTokens('<pre class="output-log">' + escapeHtml(log) + "</pre>"), "");
    }
    await renderCellOutputs(cell);
  }
  // Quarto execution is disabled both in front matter and on the command line.
  // Neutralizing authored executable fence info strings makes this invariant
  // hold even when a Markdown cell contains a literal `{r}` example.
  return neutralizeExecutableFences(`${lines.join("\n")}\n`);
}
function serializeDomChildren(container: Element): string {
  const nodes = Array.from(container.childNodes, htmlNode);
  return renderHtml(nodes, { encodeEntities: "utf8" });
}

function htmlNode(node: Node): AnyNode {
  if (node.nodeType === 3) return new Text(node.nodeValue ?? "");
  if (node.nodeType === 8) return new Comment(node.nodeValue ?? "");
  if (node.nodeType === 1) {
    const elementNode = node as Element;
    const children = Array.from(elementNode.childNodes, htmlNode);
    const attributes = Object.fromEntries(Array.from(elementNode.attributes, (attribute) => [attribute.name, attribute.value]));
    const element = new HtmlElement(elementNode.localName, attributes, children);
    for (const child of children) child.parent = element;
    return element;
  }
  throw new Error(`Unsupported DOM node type ${node.nodeType}`);
}
async function readArtifactReference(
  requested: ArtifactHandle,
  artifacts: ReadonlyMap<string, ArtifactHandle>,
  outputStore: OutputStore,
  signal?: AbortSignal,
): Promise<{ descriptor: ArtifactHandle; bytes: Buffer; handle: string }> {
  const descriptor = artifacts.get(requested.handle);
  if (descriptor === undefined) throw new PublishingError("output_expired", `published artifact ${requested.handle} is not retained`);
  const handle = descriptor.handle;
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < descriptor.byteLength) {
    throwIfAborted(signal);
    let chunk: Uint8Array;
    try {
      chunk = await outputStore.readArtifact(handle, offset, Math.min(descriptor.chunkBytes, descriptor.byteLength - offset));
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new PublishingError("output_expired", `published artifact ${handle} is no longer retained`);
      throw normalizeOutputError(error);
    }
    if (chunk.byteLength === 0) throw new PublishingError("output_expired", `published artifact ${handle} ended early`);
    chunks.push(Buffer.from(chunk));
    offset += chunk.byteLength;
  }
  const bytes = Buffer.concat(chunks, descriptor.byteLength);
  if (bytes.byteLength !== descriptor.byteLength) {
    throw new PublishingError("stale_value", `published artifact ${handle} changed while reading`);
  }
  return { descriptor, bytes, handle };
}

async function findQuartoExecutable(): Promise<string> {
  const path = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["quarto.exe", "quarto.cmd", QUARTO_COMMAND] : [QUARTO_COMMAND];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        await access(candidate, constants.X_OK);
        const file = await stat(candidate);
        if (!file.isFile()) continue;
        return await realpath(candidate);
      } catch {
        // PATH entries are untrusted and can disappear between access and spawn.
      }
    }
  }
  throw new PublishingError("tool_not_found", "Quarto is required for HTML publishing but was not found on PATH");
}

async function runQuarto(
  processScope: PublishingProcessScope,
  executable: string,
  cwd: string,
  qmdPath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let owned: PublishingOwnedProcess;
  try {
    owned = await processScope.spawn({
      executable,
      args: ["render", basename(qmdPath), "--to", "html", "--output", basename(outputPath), "--no-execute"],
      cwd,
      environment: {
        ...Object.fromEntries(Object.entries(globalThis.process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
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
  const abort = () => {
    aborted = true;
    void owned.terminate().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const stdout = collectStream(owned.stdout);
    const stderr = collectStream(owned.stderr);
    const exit = await owned.exited;
    const [out, err] = await Promise.all([stdout, stderr]);
    if (aborted) throw new PublishingError("cancelled", "publishing was cancelled");
    if (exit.code !== 0) {
      throw new PublishingError(
        "publish_failed",
        `Quarto exited with status ${exit.code ?? "unknown"}${err.length > 0 ? `: ${err}` : ""}`,
        { code: exit.code, signal: exit.signal, stdout: out, stderr: err },
      );
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function collectStream(stream: AsyncIterable<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      if (bytes >= MAX_QUARTO_STREAM_BYTES) continue;
      const remaining = MAX_QUARTO_STREAM_BYTES - bytes;
      const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(bounded);
      bytes += bounded.byteLength;
    }
  } catch (error) {
    return `[stream read failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function publishAbsentDestination(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const temporary = join(dirname(path), `.${basename(path)}.alder-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o644);
    throwIfAborted(signal);
    try {
      await link(temporary, path);
    } catch (error) {
      if (isErrno(error, "EEXIST")) throw new PublishingError("destination_exists", `publish destination already exists: ${path}`);
      throw error;
    }
  } catch (error) {
    throw normalizePublishingError(error);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function srcsetCandidates(value: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ",") continue;
    const candidate = value.slice(start, index).trim();
    const next = value[index + 1] ?? "";
    if (/^data:/i.test(candidate) && next !== "" && !/\s/.test(next)) continue;
    if (candidate.length > 0) candidates.push(candidate);
    start = index + 1;
  }
  const final = value.slice(start).trim();
  if (final.length > 0) candidates.push(final);
  return candidates;
}

function assertNoExternalAssets(html: string, label: string): void {
  const reject = (value: string): void => {
    const resource = value.trim();
    if (resource.length === 0 || resource.startsWith("#") || /^data:/i.test(resource)) return;
    throw new PublishingError("publish_external_assets", label + " contains an external or sidecar asset: " + resource);
  };
  const pending: Array<{ html: string; label: string }> = [{ html, label }];
  for (let index = 0; index < pending.length; index += 1) {
    if (index >= 64) throw new PublishingError("publish_external_assets", label + " contains too many nested srcdoc documents");
    const current = pending[index];
    const document = parseHTML(current.html).document;
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const tag = element.localName.toLowerCase();
      assertEmbeddedWidgetIsolation(element);
      for (const attribute of HTML_RESOURCE_ATTRIBUTES[tag] ?? []) {
        const value = element.getAttribute(attribute);
        if (value === null) continue;
        if (attribute === "srcset") {
          for (const candidate of srcsetCandidates(value)) reject(candidate.split(/\s+/)[0] ?? "");
        } else {
          reject(value);
        }
      }
      const srcdoc = element.getAttribute("srcdoc");
      if (srcdoc !== null) pending.push({ html: srcdoc, label: current.label + " srcdoc" });
    }
    const css = [
      ...Array.from(document.querySelectorAll("style"), (element) => element.textContent ?? ""),
      ...Array.from(document.querySelectorAll("[style]"), (element) => element.getAttribute("style") ?? ""),
    ].join("\n");
    for (const match of css.matchAll(HTML_CSS_URL)) reject(match[1] ?? match[2] ?? match[3] ?? "");
    for (const match of css.matchAll(HTML_CSS_IMPORT)) reject(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "");
  }
}
function assertEmbeddedWidgetIsolation(element: Element): void {
  if (element.localName.toLowerCase() !== "iframe" || !element.hasAttribute("data-alder-artifact-frame")) return;
  const kind = (element.getAttribute("data-alder-artifact-frame") ?? "").trim().toLowerCase();
  const hasSandbox = element.hasAttribute("sandbox");
  const sandbox = element.getAttribute("sandbox") ?? "";
  const sandboxTokens = new Set(sandbox.split(/\s+/).filter(Boolean));
  const hasSrcdoc = element.hasAttribute("srcdoc");
  const srcdoc = element.getAttribute("srcdoc") ?? "";
  const src = element.getAttribute("src") ?? "";
  const referrer = (element.getAttribute("referrerpolicy") ?? "").trim().toLowerCase();
  const isolated = kind === "html"
    ? hasSrcdoc && srcdoc.length > 0 && hasSandbox && sandboxTokens.size === 1 && sandboxTokens.has("allow-scripts")
    : kind === "pdf"
      ? !hasSrcdoc && !hasSandbox && isCanonicalPdfDataUrl(src)
      : false;
  if (!isolated || referrer !== "no-referrer") {
    throw new PublishingError("publish_failed", "published artifact frame is not isolated");
  }
}

function isCanonicalPdfDataUrl(value: string): boolean {
  const prefix = "data:application/pdf;base64,";
  if (!value.startsWith(prefix)) return false;
  const encoded = value.slice(prefix.length);
  return encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) &&
    Buffer.from(encoded, "base64").toString("base64") === encoded;
}
function withContentSecurityPolicy(html: string): string {
  const policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; connect-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; font-src data:;\">";
  if (/<head\b/i.test(html)) return html.replace(/<head([^>]*)>/i, "<head$1>" + policy);
  return "<html><head>" + policy + "</head><body>" + html + "</body></html>";
}
const PUBLISH_LITERAL_MARKER_PREFIX = "ALDER_PUBLISH_LITERAL_" + randomUUID().replaceAll("-", "") + "_";
const PUBLISH_LITERAL_MARKER_PATTERN = new RegExp(PUBLISH_LITERAL_MARKER_PREFIX + "([A-Za-z0-9_-]+)_", "g");

// Quarto removes one brace layer from its triple-braced escape. Use it only
// for complete double-braced tokens; preserve every other authored opener,
// including already-triple text, through inert markers restored after rendering.
function neutralizeQuartoTokens(value: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const opener = nextShortcodeOpener(value, cursor);
    if (opener === null) {
      result += value.slice(cursor);
      break;
    }
    let prefixStart = opener.start;
    while (prefixStart > cursor && value[prefixStart - 1] === "\\") prefixStart -= 1;
    const contentStart = opener.start + opener.braceCount + (opener.encoded ? 4 : 1);
    const close = opener.kind === "<" ? findShortcodeClose(value, contentStart, opener.braceCount, opener.encoded) : null;
    let nested = false;
    if (close !== null) {
      const nestedOpener = nextShortcodeOpener(value, contentStart);
      nested = nestedOpener !== null && nestedOpener.start < close.start;
    }
    result += value.slice(cursor, prefixStart);
    if (prefixStart === opener.start && close !== null && !nested && opener.kind === "<" && opener.braceCount === 2) {
      result += "{{{<" + value.slice(contentStart, close.start) + ">}}}";
      cursor = close.end;
      continue;
    }
    const markerPrefix = opener.encoded ? value.slice(prefixStart, contentStart).replace("&lt;", "<") : value.slice(prefixStart, contentStart);
    result += literalMarker(markerPrefix);
    cursor = contentStart;
  }
  return result;
}

type ShortcodeOpener = { start: number; braceCount: number; kind: "<" | "%"; encoded: boolean };

type ShortcodeClose = { start: number; end: number };

function nextShortcodeOpener(value: string, from: number): ShortcodeOpener | null {
  for (let index = from; index + 2 < value.length; index += 1) {
    if (value[index] !== "{" || value[index + 1] !== "{" || (index > 0 && value[index - 1] === "{")) continue;
    let braceCount = 2;
    while (value[index + braceCount] === "{") braceCount += 1;
    const tokenStart = index + braceCount;
    const kind = value[tokenStart];
    if (kind === "<" || kind === "%") return { start: index, braceCount, kind, encoded: false };
    if (value.startsWith("&lt;", tokenStart)) return { start: index, braceCount, kind: "<", encoded: true };
  }
  return null;
}

function findShortcodeClose(value: string, from: number, braceCount: number, encoded: boolean): ShortcodeClose | null {
  for (let index = from; index < value.length; index += 1) {
    let markerLength = 1;
    if (encoded) {
      if (value.startsWith("&gt;", index)) markerLength = 4;
      else if (value[index] !== ">") continue;
    } else if (value[index] !== ">") {
      continue;
    }
    const braceStart = index + markerLength;
    let valid = true;
    for (let offset = 0; offset < braceCount; offset += 1) {
      if (value[braceStart + offset] !== "}") {
        valid = false;
        break;
      }
    }
    if (valid && value[braceStart + braceCount] !== "}") return { start: index, end: braceStart + braceCount };
  }
  return null;
}

function literalMarker(value: string): string {
  return PUBLISH_LITERAL_MARKER_PREFIX + Buffer.from(value, "utf8").toString("base64url") + "_";
}

function restorePublishedLiterals(html: string): string {
  return html.replace(PUBLISH_LITERAL_MARKER_PATTERN, (marker, encoded: string) => {
    try {
      return escapeHtml(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")));
    } catch {
      throw new PublishingError("publish_failed", "published literal marker is invalid: " + marker);
    }
  });
}

function restorePublishedTitle(html: string, title: string): string {
  return html.replaceAll(PUBLISH_TITLE_MARKER, escapeHtml(title));
}
function fenceFor(lines: readonly string[]): string {
  let longest = 2;
  for (const line of lines) {
    const runs = line.match(/`+/g) ?? [];
    for (const run of runs) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function neutralizeExecutableFences(qmd: string): string {
  return qmd.replace(/^(\s*(?:`{3,}|~{3,}))\{r(?=[\s,:}])[^}]*\}\s*$/gim, "$1text");
}

function titleOf(snapshot: HostSnapshot): string {
  const title = snapshot.metadata.title;
  return typeof title === "string" && title.trim().length > 0 ? title : "Alder notebook";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}


function decodeArtifactText(bytes: Uint8Array, handle: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublishingError("publish_failed", `HTML artifact ${handle} is not valid UTF-8`);
  }
}


function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}


function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key]));
  return "{" + entries.join(",") + "}";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PublishingError("cancelled", "publishing was cancelled");
}

function normalizeOutputError(error: unknown): PublishingError {
  if (error instanceof PublishingError) return error;
  if (error instanceof OutputStoreError) {
    if (error.code === "not_found") return new PublishingError("output_expired", error.message);
    if (error.code === "stale_value") return new PublishingError("stale_value", error.message);
    if (error.code === "output_expired") return new PublishingError("output_expired", error.message);
    if (error.code === "output_quota") return new PublishingError("output_quota", error.message);
    return new PublishingError("publish_failed", error.message);
  }
  return normalizePublishingError(error);
}

function normalizePublishingError(error: unknown): PublishingError {
  if (error instanceof PublishingError) return error;
  if (error instanceof OutputStoreError) return normalizeOutputError(error);
  if (isErrno(error, "ENOENT")) return new PublishingError("publish_failed", "publication input or output was not produced");
  if (isErrno(error, "EEXIST")) return new PublishingError("destination_exists", "publish destination already exists");
  return new PublishingError("publish_failed", error instanceof Error ? error.message : String(error));
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

const PUBLISH_CSS = `
:root { color-scheme: light dark; }
.value-text, .value-json, .output-log, .output-error { white-space: pre-wrap; }
.html-widget, .media-pdf { width: 100%; min-height: 2rem; border: 0; }
.media-pdf { min-height: 420px; }
.plot, .out-media { max-width: 100%; }
.markdown-output, .html-inline { max-width: 100%; }
.table-preview { overflow-x: auto; }
.table-preview table { border-collapse: collapse; }
.table-preview th, .table-preview td { border: 1px solid currentColor; padding: .25rem .5rem; text-align: left; }
.widget-container, .widget-group { display: inline-flex; gap: .5rem; align-items: center; }
.widget-container input:disabled, .widget-group input:disabled { opacity: .85; }
.out-lazy { opacity: .75; }
.out-layout { display: flex; flex-direction: column; gap: .5rem; }
.progress-row { display: flex; gap: .5rem; align-items: center; }
`;
