import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { connectMcpStdio, drainMcpStdio, type McpInitializationMetadata } from "./mcp-stdio.js";
import { queryDiagnostics, type DiagnosticQuery } from "./diagnostics.js";
import { type HostReady } from "./application.js";
import { resolveApplicationResources, type ApplicationResources } from "./resources.js";
import { acquireNotebookSession, isUntitledRecoveryId, listUntitledRecoveryDescriptors, selectUntitledRecoveryDescriptor } from "./sessions.js";
import {
  artifactHandleSchema,
  commandResultSchema,
  decodeJsonFrame,
  decodeHostQueryResultWire,
  encodeHostCommandWire,
  encodeHostQueryWire,
  hostQueryResultSchema,
  ENGINE_PROTOCOL,
  HOST_PROTOCOL,
  hostSnapshotSchema,
  SNAPSHOT_ENVELOPE_LIMIT,
  type SessionConnection,
  type HostQuery,
  type HostQueryResult,
  type HostSnapshot,
  type CommandResult,
  type HostCommand,
} from "./protocol.js";

export const HOST_IDENTITY = Object.freeze({ protocol: HOST_PROTOCOL, engineProtocol: ENGINE_PROTOCOL, hostVersion: "0.1.0", packageVersion: "0.1.0" });
const AUTH_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_READY_TIMEOUT_MS = 120_000;
const RUNTIME_READY_POLL_MS = 100;

export interface RuntimeReadinessWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly readiness?: "document" | "analyzer" | "execution";
}

/**
 * Wait for the host's authoritative runtime state before issuing a CLI
 * operation. Session acquisition only proves that the HTTP host is ready;
 * runtime bootstrap can still be resolving (or can have reached a terminal
 * blocked state) after the lease is issued.
 */
export async function waitForRuntimeReadiness(
  readSnapshot: () => Promise<HostSnapshot>,
  options: RuntimeReadinessWaitOptions = {},
): Promise<HostSnapshot> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? RUNTIME_READY_POLL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("runtime readiness timeout must be a positive safe integer");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) throw new RangeError("runtime readiness poll interval must be a non-negative safe integer");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await readSnapshot();
    const ready = options.readiness === "document"
      ? snapshot.runtime.documentReady
      : options.readiness === "analyzer"
        ? snapshot.runtime.analyzerState === "ready"
        : snapshot.runtime.executionReady;
    if (ready || snapshot.runtime.executionBlockedReason !== null) return snapshot;
    if (Date.now() >= deadline) throw new Error("runtime_ready_timeout");
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
}

interface CliOptions {
  command: "desktop" | "check" | "run" | "publish" | "mcp" | "diagnostics";
  path: string | null;
  recover?: string;
  listRecoveries: boolean;
  browser: boolean;
  headless: boolean;
  lazy: boolean;
  noRun: boolean;
  externalOrigin?: string;
  tokenFile?: string;
  output?: string;
  includeCode: boolean;
  diagnosticQuery?: DiagnosticQuery;
  diagnosticLimit?: number;
  diagnosticSince?: string;
  diagnosticUntil?: string;
  diagnosticId?: string;
  diagnosticSlowMs?: number;
  retry?: { requestId: string; sessionEpoch: string; expectedDocumentRevision: number };
}

function usageError(message: string): Error { return Object.assign(new Error(message), { exitCode: 2 }); }
export function desktopUnavailableError(): Error & { readonly code: string } { return Object.assign(new Error("desktop runtime is unavailable; use --browser or --headless"), { code: "desktop_unavailable" }); }
function writeJson(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code + ": " + error.message : error.message;
}

async function readSessionJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let value: unknown = null;
  if (bytes.byteLength > 0) value = decodeJsonFrame(bytes, SNAPSHOT_ENVELOPE_LIMIT);
  if (!response.ok) {
    const detail = isRecord(value) ? value : {};
    throw new Error(typeof detail.message === "string" ? detail.message : "session request failed (" + response.status + ")");
  }
  return value;
}

function validateExternalOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError("--external-origin must be an exact HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.origin !== value) {
    throw usageError("--external-origin must be an exact HTTPS origin");
  }
}

function validateExternalAuthOptions(externalOrigin: string | undefined, tokenFile: string | undefined): void {
  if ((externalOrigin === undefined) !== (tokenFile === undefined)) {
    throw usageError("--external-origin and --token-file must be supplied together");
  }
  if (externalOrigin !== undefined) validateExternalOrigin(externalOrigin);
  if (tokenFile !== undefined && (tokenFile.length === 0 || tokenFile.includes("\0"))) {
    throw usageError("--token-file must be a non-empty path");
  }
}


export function parseCli(argv: readonly string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean" }, version: { type: "boolean" }, "host-info": { type: "boolean" },
        browser: { type: "boolean" }, headless: { type: "boolean" }, lazy: { type: "boolean" }, "no-run": { type: "boolean" },
        "external-origin": { type: "string" }, "token-file": { type: "string" },
        "request-id": { type: "string" }, "session-epoch": { type: "string" }, "document-revision": { type: "string" },
        output: { type: "string" }, "include-code": { type: "boolean" }, "list-recoveries": { type: "boolean" }, recover: { type: "string" },
        limit: { type: "string" }, since: { type: "string" }, until: { type: "string" }, id: { type: "string" }, "slow-ms": { type: "string" },
      },
    });
  } catch (error) { throw usageError(errorText(error)); }
  const values = parsed.values as Record<string, unknown>;
  if (values.help === true) return { command: "desktop", path: null, recover: undefined, listRecoveries: false, browser: false, headless: false, lazy: false, noRun: false, externalOrigin: undefined, tokenFile: undefined, output: undefined, includeCode: false };
  const positionals = parsed.positionals;
  const first = positionals[0];
  const command = first === "check" || first === "run" || first === "publish" || first === "mcp" || first === "diagnostics" ? first : "desktop";
  const path = command === "desktop" ? (first ?? null) : command === "diagnostics" ? null : (positionals[1] ?? null);
  if (positionals.length > (command === "desktop" ? 1 : 2)) throw usageError("too many positional arguments");
  const diagnosticQuery = command === "diagnostics" ? positionals[1] : undefined;
  if (command === "diagnostics" && !["status", "launches", "errors", "operations", "performance", "incident"].includes(diagnosticQuery ?? "")) {
    throw usageError("diagnostics requires status, launches, errors, operations, performance or incident");
  }
  const browser = values.browser === true;
  const headless = values.headless === true;
  const listRecoveries = values["list-recoveries"] === true;
  const recover = values.recover === undefined ? undefined : String(values.recover);
  if (browser && headless) throw usageError("--browser and --headless are mutually exclusive");
  if (listRecoveries) {
    if (positionals.length > 0 || recover !== undefined || browser || headless || values.lazy === true || values["no-run"] === true || values["external-origin"] !== undefined || values["token-file"] !== undefined || values.output !== undefined || values["include-code"] === true || values["host-info"] === true) {
      throw usageError("--list-recoveries cannot be combined with other command or session options");
    }
  }
  if (recover !== undefined) {
    if (!isUntitledRecoveryId(recover)) throw usageError("--recover requires a UUID");
    if (command !== "desktop") throw usageError("--recover is only valid for a desktop session");
    if (path !== null) throw usageError("--recover cannot be combined with NOTEBOOK.R");
  }
  const externalOrigin = typeof values["external-origin"] === "string" ? values["external-origin"] : undefined;
  const tokenFile = typeof values["token-file"] === "string" ? values["token-file"] : undefined;
  validateExternalAuthOptions(externalOrigin, tokenFile);
  const sessionOnly = browser || headless || values.lazy === true || values["no-run"] === true || values["external-origin"] !== undefined || values["token-file"] !== undefined;
  if (command !== "desktop" && sessionOnly) throw usageError("session flags are not valid for " + command);
  if (command === "desktop" && !browser && !headless && (values["external-origin"] !== undefined || values["token-file"] !== undefined)) {
    throw usageError("native desktop launch does not accept headless session flags");
  }
  if (command !== "publish" && (values.output !== undefined || values["include-code"] === true)) throw usageError("publish flags are only valid for publish");
  if (command === "publish" && typeof values.output !== "string") throw usageError("publish requires --output FILE.html");
  if ((command === "check" || command === "run" || command === "publish" || command === "mcp") && path === null) throw usageError(command + " requires NOTEBOOK.R");
  if (command === "mcp" && (browser || headless)) throw usageError("mcp does not accept --browser or --headless");
  const diagnosticFlags = [values.limit, values.since, values.until, values.id, values["slow-ms"]];
  if (command !== "diagnostics" && diagnosticFlags.some(value => value !== undefined)) throw usageError("diagnostic query flags require the diagnostics command");
  if (command === "diagnostics" && values.id !== undefined && diagnosticQuery !== "incident") throw usageError("--id is only valid for diagnostics incident");
  if (command === "diagnostics" && values["slow-ms"] !== undefined && diagnosticQuery !== "operations") throw usageError("--slow-ms is only valid for diagnostics operations");
  const diagnosticLimit = values.limit === undefined ? undefined : Number(values.limit);
  const diagnosticSlowMs = values["slow-ms"] === undefined ? undefined : Number(values["slow-ms"]);
  if (diagnosticLimit !== undefined && (!Number.isSafeInteger(diagnosticLimit) || diagnosticLimit <= 0 || diagnosticLimit > 10_000)) throw usageError("--limit must be an integer from 1 to 10000");
  if (diagnosticSlowMs !== undefined && (!Number.isSafeInteger(diagnosticSlowMs) || diagnosticSlowMs < 0)) throw usageError("--slow-ms must be a non-negative integer");
  const diagnosticSince = typeof values.since === "string" ? Date.parse(values.since) : Number.NEGATIVE_INFINITY;
  const diagnosticUntil = typeof values.until === "string" ? Date.parse(values.until) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(diagnosticSince) && diagnosticSince !== Number.NEGATIVE_INFINITY) throw usageError("--since must be a valid ISO timestamp");
  if (!Number.isFinite(diagnosticUntil) && diagnosticUntil !== Number.POSITIVE_INFINITY) throw usageError("--until must be a valid ISO timestamp");
  if (diagnosticSince > diagnosticUntil) throw usageError("--since must not be later than --until");
  const retryFlags = [values["request-id"], values["session-epoch"], values["document-revision"]];
  let retry: CliOptions["retry"];
  if (retryFlags.some(value => value !== undefined)) {
    if (command !== "run" && command !== "publish") throw usageError("request retry flags are only valid for run or publish");
    if (retryFlags.some(value => value === undefined)) throw usageError("--request-id, --session-epoch and --document-revision must be supplied together");
    const requestId = String(values["request-id"]);
    const sessionEpoch = String(values["session-epoch"]);
    const expectedDocumentRevision = Number(values["document-revision"]);
    if (!requestId || !sessionEpoch || requestId.length > 256 || sessionEpoch.length > 256 || !Number.isSafeInteger(expectedDocumentRevision) || expectedDocumentRevision < 0) throw usageError("invalid command retry identity or document revision");
    retry = { requestId, sessionEpoch, expectedDocumentRevision };
  }
  return {
    command, path, recover, listRecoveries, browser, headless, lazy: values.lazy === true, noRun: values["no-run"] === true,
    externalOrigin, tokenFile, output: typeof values.output === "string" ? values.output : undefined,
    includeCode: values["include-code"] === true, ...(retry === undefined ? {} : { retry }),
    ...(diagnosticQuery === undefined ? {} : { diagnosticQuery: diagnosticQuery as DiagnosticQuery }),
    ...(diagnosticLimit === undefined ? {} : { diagnosticLimit }),
    ...(diagnosticSlowMs === undefined ? {} : { diagnosticSlowMs }),
    ...(typeof values.since === "string" ? { diagnosticSince: values.since } : {}),
    ...(typeof values.until === "string" ? { diagnosticUntil: values.until } : {}),
    ...(typeof values.id === "string" ? { diagnosticId: values.id } : {}),
  };
}

async function applicationResources(): Promise<ApplicationResources> {
  const root = process.env.ALDER_APPLICATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return resolveApplicationResources(root);
}
function publicReady(origin: string, epoch: string, capabilities: readonly string[]): HostReady { return { type: "host.ready", origin, epoch, capabilities: [...capabilities] }; }
export async function browserUrl(connection: SessionConnection): Promise<string> {
  const response = await connection.request("/api/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin: connection.browserOrigin }),
  });
  const value = await readSessionJson(response);
  if (!isRecord(value) || typeof value.ticket !== "string" || !AUTH_TOKEN_PATTERN.test(value.ticket)) {
    throw new Error("host returned an invalid browser bootstrap ticket");
  }
  const url = new URL("/index.html", connection.browserOrigin);
  url.hash = `ticket=${encodeURIComponent(value.ticket)}`;
  return url.href;
}

interface BrowserOpenerChild {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "spawn", listener: () => void): this;
  unref(): void;
}

export interface SystemBrowserOpenOptions {
  /** Test-only platform override; production callers should omit it. */
  readonly platform?: "darwin";
  /** Test-only parent for the freshly created private launcher directory. */
  readonly temporaryRoot?: string;
  /** Test seam which must not invoke a real OS opener. */
  readonly spawn?: (command: string, args: readonly string[], options: { detached: true; stdio: "ignore" }) => BrowserOpenerChild;
  /** Test-only cleanup delay override. */
  readonly cleanupDelayMs?: number;
}

const BROWSER_LAUNCHER_CLEANUP_MS = 30_000;
const BROWSER_LAUNCHER_MAX_CLEANUP_MS = 60_000;

function browserLauncherHtml(url: string): string {
  const escapedUrl = JSON.stringify(url)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>location.replace(${escapedUrl})</script>
`;
}

export async function openSystemBrowser(url: string, options: SystemBrowserOpenOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("Alder currently supports macOS");
  const cleanupDelayMs = options.cleanupDelayMs ?? BROWSER_LAUNCHER_CLEANUP_MS;
  if (!Number.isSafeInteger(cleanupDelayMs) || cleanupDelayMs < 0 || cleanupDelayMs > BROWSER_LAUNCHER_MAX_CLEANUP_MS) {
    throw new RangeError("browser launcher cleanup delay is invalid");
  }

  let directory: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "alder-browser-launch-"));
    await chmod(directory, 0o700);
    const launcherPath = join(directory, "launch.html");
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await open(launcherPath, flags, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(browserLauncherHtml(url), { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;

    const command = "open";
    const launcherUrl = pathToFileURL(launcherPath).href;
    const args = [launcherUrl];
    const spawnOpener = options.spawn ?? ((executable, openerArgs, spawnOptions) => spawn(executable, [...openerArgs], spawnOptions));
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const child = spawnOpener(command, args, { detached: true, stdio: "ignore" });
      child.once("error", rejectOpen);
      child.once("spawn", () => { child.unref(); resolveOpen(); });
    });

    const cleanupDirectory = directory;
    const cleanup = setTimeout(() => { void rm(cleanupDirectory, { recursive: true, force: true }); }, cleanupDelayMs);
    cleanup.unref();
  } catch {
    await handle?.close().catch(() => undefined);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("could not open system browser");
  }
}

async function holdSession(connection: SessionConnection): Promise<number> {
  const ready = publicReady(connection.browserOrigin, connection.epoch, connection.capabilities);
  writeJson(ready);
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    await new Promise<void>(resolve => { const stop = () => { void connection.release().finally(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
  } finally {
    clearInterval(keepAlive);
  }
  return 0;
}

async function readOwnerArtifact(connection: SessionConnection, artifact: { handle: string; byteLength: number; chunkBytes: number }): Promise<unknown> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const pageQuery: HostQuery = { type: "output", handle: artifact.handle, offset, limit: artifact.chunkBytes };
    const pageEnvelope = await ownerQuery(connection, pageQuery);
    if (!isRecord(pageEnvelope.result)) throw new Error("owner artifact page is not an object");
    const page = pageEnvelope.result as unknown as { encoding: string; data: string; offset: number; nextOffset: number; eof: boolean };
    if (page.encoding !== "base64" || typeof page.data !== "string" || !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.nextOffset) || typeof page.eof !== "boolean") throw new Error("owner artifact page has an invalid shape");
    const bytes = Buffer.from(page.data, "base64");
    if (bytes.toString("base64") !== page.data || page.offset !== offset || page.nextOffset !== offset + bytes.byteLength || page.nextOffset > artifact.byteLength || bytes.byteLength > artifact.chunkBytes) throw new Error("owner artifact page is not canonical");
    chunks.push(bytes);
    offset = page.nextOffset;
    if (page.eof) break;
    if (bytes.byteLength === 0) throw new Error("owner artifact page made no progress");
  }
  if (offset !== artifact.byteLength) throw new Error("owner artifact length is inconsistent");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ownerQuery(connection: SessionConnection, query: HostQuery): Promise<HostQueryResult> {
  const raw = await readSessionJson(await connection.request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostQueryWire(query)) }));
  const decoded = hostQueryResultSchema.parse(decodeHostQueryResultWire(query, raw)) as HostQueryResult;
  const artifact = artifactHandleSchema.safeParse(decoded.result);
  if (!artifact.success) return decoded;
  const hydrated = { ...decoded, result: await readOwnerArtifact(connection, artifact.data) };
  return hostQueryResultSchema.parse(decodeHostQueryResultWire(query, hydrated)) as HostQueryResult;
}

async function ownerSnapshot(connection: SessionConnection): Promise<HostSnapshot> {
  const query: HostQuery = { type: "state" };
  const result = (await ownerQuery(connection, query)).result;
  if (!isRecord(result)) throw new Error("owner recovery query did not return an object");
  const recovery = result as Record<string, unknown>;
  if (recovery.kind !== "snapshot") throw new Error("owner recovery query did not return a snapshot");
  return hostSnapshotSchema.parse(recovery.snapshot) as HostSnapshot;
}

type OwnerCommand = { type: "run"; scope: "all"; startup?: boolean } | { type: "publish"; includeCode: boolean; outputPath?: string };
type OwnerCommandOutcome = (CommandResult | Pick<CommandResult, "requestId" | "epoch" | "result" | "error">) & { request: HostCommand };
export async function commandOnOwner(connection: SessionConnection, command: OwnerCommand, retry?: CliOptions["retry"]): Promise<OwnerCommandOutcome> {
  const identity = retry ?? { requestId: randomUUID(), sessionEpoch: connection.epoch, expectedDocumentRevision: (await ownerQuery(connection, { type: "notebook" })).documentRevision };
  const request: HostCommand = { ...command, ...identity, clientId: connection.clientId };
  if (identity.sessionEpoch !== connection.epoch) {
    return { requestId: identity.requestId, epoch: identity.sessionEpoch, result: null, error: { code: "session_replaced", message: "The original backend session ended. This uncertain command will not run again automatically." }, request };
  }
  try {
    const raw = await readSessionJson(await connection.request("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeHostCommandWire(request)) }));
    const completed = commandResultSchema.parse(raw);
    const artifact = artifactHandleSchema.safeParse(completed.result);
    const result = artifact.success ? await readOwnerArtifact(connection, artifact.data) : completed.result;
    return { ...completed, result, request } as OwnerCommandOutcome;
  } catch (error) {
    return {
      requestId: identity.requestId, epoch: identity.sessionEpoch, result: null, request,
      error: { code: "command_uncertain", message: `${errorText(error)} Retry the identical command with --request-id ${identity.requestId} --session-epoch ${identity.sessionEpoch} --document-revision ${identity.expectedDocumentRevision}.` },
    };
  }
}

async function activateHeadlessStartup(connection: SessionConnection): Promise<void> {
  const snapshot = await waitForRuntimeReadiness(() => ownerSnapshot(connection), { readiness: "analyzer" });
  if (snapshot.runtime.startupActivated || snapshot.runtime.executionBlockedReason !== null) return;
  await commandOnOwner(connection, { type: "run", scope: "all", startup: true });
}

async function runTool(cli: CliOptions, resources: ApplicationResources): Promise<number> {
  const connection = await acquireNotebookSession({ path: cli.path, resources, runtimeDirectory: process.env.ALDER_RUNTIME_DIRECTORY, executionMode: cli.lazy ? "lazy" : undefined, suppressStartup: cli.noRun, deferStartup: true });
  try {
    const runtimeSnapshot = await waitForRuntimeReadiness(() => ownerSnapshot(connection), {
      readiness: cli.command === "publish" ? "document" : "analyzer",
    });
    if (cli.command === "check") {
      const query: HostQuery = { type: "check" };
      const result = (await ownerQuery(connection, query)).result;
      if (!isRecord(result)) throw new Error("owner check query did not return an object");
      const check = result as Record<string, unknown>;
      writeJson({ epoch: connection.epoch, documentRevision: runtimeSnapshot.documentRevision, dirty: runtimeSnapshot.dirty, disk: runtimeSnapshot.disk, result: check, error: null });
      return Array.isArray(check.issues) && check.issues.length > 0 || runtimeSnapshot.runtime.executionBlockedReason !== null ? 1 : 0;
    }
    const command: OwnerCommand = cli.command === "run" ? { type: "run", scope: "all" } : { type: "publish", includeCode: cli.includeCode, outputPath: cli.output };
    const completed = await commandOnOwner(connection, command, cli.retry);
    writeJson(completed);
    if (completed.error?.code === "interrupted") return 130;
    return completed.error === null ? 0 : 1;
  } finally { await connection.release(); }
}

async function runMcp(cli: CliOptions, resources: ApplicationResources): Promise<number> {
  const connection = await acquireNotebookSession({
    path: cli.path,
    resources,
    runtimeDirectory: process.env.ALDER_RUNTIME_DIRECTORY,
    executionMode: cli.lazy ? "lazy" : undefined,
    suppressStartup: cli.noRun,
    deferStartup: true,
  });
  let stdio: Awaited<ReturnType<typeof connectMcpStdio>> | undefined;
  let upstreamClient: Client | undefined;
  try {
    const notebook = await ownerQuery(connection, { type: "notebook" });
    if (!Number.isSafeInteger(notebook.documentRevision) || notebook.documentRevision < 0) throw new Error("owner notebook metadata has no document revision");
    const alder: McpInitializationMetadata = {
      clientId: connection.clientId,
      sessionEpoch: connection.epoch,
      documentRevision: notebook.documentRevision,
      capabilities: [...connection.capabilities],
    };
    stdio = await connectMcpStdio(async ({ clientInfo, capabilities }) => {
      const client = new Client(clientInfo, { capabilities, enforceStrictCapabilities: false });
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", connection.origin), {
        fetch: async (url, init) => {
          const target = new URL(url);
          const origin = new URL(connection.origin);
          if (target.origin !== origin.origin) throw new Error("MCP upstream request changed origin");
          return connection.request(target.pathname + target.search, init);
        },
      });
      upstreamClient = client;
      return { client, transport };
    }, { input: process.stdin, output: process.stdout, alder });
    await new Promise<void>(resolve => process.stdin.once("end", resolve));
    await stdio.close();
    await drainMcpStdio(stdio);
    return 0;
  } finally {
    await stdio?.close().catch(() => undefined);
    await upstreamClient?.close().catch(() => undefined);
    await connection.release();
  }
}

async function runDesktop(cli: CliOptions, resources: ApplicationResources): Promise<number> {
  if (cli.browser || cli.headless) {
    const connection = await acquireNotebookSession({
      path: cli.path,
      untitledRecoveryId: cli.recover,
      resources,
      executionMode: cli.lazy ? "lazy" : undefined,
      suppressStartup: cli.noRun,
      deferStartup: true,
      externalOrigin: cli.externalOrigin,
      tokenFile: cli.tokenFile,
    });
    try {
      if (cli.headless) {
        void activateHeadlessStartup(connection)
          .catch(error => { process.stderr.write("alder: " + errorText(error) + "\n"); });
      }
      if (cli.browser) await openSystemBrowser(await browserUrl(connection));
      return await holdSession(connection);
    } catch (error) {
      await connection.release().catch(() => undefined);
      throw error;
    }
  }
  if (resources.electronEntry === null) throw desktopUnavailableError();
  if (cli.recover !== undefined) await selectUntitledRecoveryDescriptor(cli.recover);
  const desktopArgs = [
    ...(cli.path === null ? (cli.recover === undefined ? [] : ["--recover", cli.recover]) : [cli.path]),
    ...(cli.lazy ? ["--lazy"] : []),
    ...(cli.noRun ? ["--no-run"] : []),
  ];
  const child = spawn(resources.electronEntry, desktopArgs, { stdio: "inherit" });
  return await new Promise(resolveCode => { child.once("error", error => { process.stderr.write(errorText(error) + "\n"); resolveCode(1); }); child.once("exit", code => resolveCode(code ?? 1)); });
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const cli = parseCli(argv);
  if (argv.includes("--help")) {
    process.stdout.write("Usage: alder [NOTEBOOK.R] [--browser|--headless]\n");
    process.stdout.write("       alder --recover UUID [--browser|--headless]\n");
    process.stdout.write("       alder --list-recoveries\n");
    process.stdout.write("       alder check|run|publish|mcp NOTEBOOK.R\n");
    process.stdout.write("       alder diagnostics status|launches|errors|operations|performance [--limit N] [--since ISO] [--until ISO]\n");
    process.stdout.write("       alder diagnostics operations [--slow-ms N] [--limit N] [--since ISO] [--until ISO]\n");
    process.stdout.write("       alder diagnostics incident [--id VALUE] [--limit N] [--since ISO] [--until ISO]\n");
    process.stdout.write("       alder run|publish NOTEBOOK.R --request-id ID --session-epoch EPOCH --document-revision N\n");
    return 0;
  }
  if (argv.includes("--version")) { process.stdout.write(HOST_IDENTITY.packageVersion + "\n"); return 0; }
  if (cli.listRecoveries) {
    writeJson(await listUntitledRecoveryDescriptors());
    return 0;
  }
  if (cli.command === "diagnostics") {
    writeJson(await queryDiagnostics(cli.diagnosticQuery!, {
      limit: cli.diagnosticLimit,
      since: cli.diagnosticSince,
      until: cli.diagnosticUntil,
      id: cli.diagnosticId,
      slowMs: cli.diagnosticSlowMs,
    }));
    return 0;
  }
  const resources = await applicationResources();
  if (argv.includes("--host-info")) { writeJson({ type: "host.info", ...HOST_IDENTITY, resources: { root: resources.root, cliLauncher: resources.cliLauncher, hostEntry: resources.hostEntry, rendererDirectory: resources.rendererDirectory, workerDirectory: resources.workerDirectory, rLibraryDirectory: resources.rLibraryDirectory, arkExecutable: resources.arkExecutable, airExecutable: resources.airExecutable, nodeExecutable: resources.nodeExecutable, electronEntry: resources.electronEntry } }); return 0; }
  if (cli.command === "check" || cli.command === "run" || cli.command === "publish") return runTool(cli, resources);
  if (cli.command === "mcp") return runMcp(cli, resources);
  return runDesktop(cli, resources);
}
export { artifactHandleSchema, decodeHostQueryResultWire, encodeHostCommandWire, encodeHostQueryWire, hostQueryResultSchema, hostSnapshotSchema };

const entry = process.argv[1] === fileURLToPath(import.meta.url);
if (entry) {
  void runCli().then(
    code => { process.exitCode = code; },
    error => {
      if (process.argv[2] === "diagnostics") process.stderr.write(JSON.stringify({ error: { code: "invalid_diagnostic_query", message: errorText(error) } }) + "\n");
      else process.stderr.write("alder: " + errorText(error) + "\n");
      process.exitCode = typeof (error as { exitCode?: unknown }).exitCode === "number" ? Number((error as { exitCode: number }).exitCode) : 1;
    },
  );
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
