import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import envPaths from "env-paths";
import type { DiagnosticSink } from "./diagnostics.js";
import { watch, type FSWatcher } from "chokidar";
import { z } from "zod";
import { Controller, type SourceCommitContext, type SourceCommitHandler, type SourcePublication } from "./controller.js";
import { Engine } from "./engine.js";
import { createAlderServer, createOriginHost, type AlderServer } from "./server.js";
import { createMcpHttpHandler } from "./mcp.js";
import { appConfig, projectConfigPath, readProjectSettings, readNotebookSettings, setNotebookSettings, setAppConfig } from "./configuration.js";
import { resolveSettings, type Config, type ProjectSettingsPatch, type NotebookSettingsPatch, type PreferencesPatch } from "./settings.js";
import { ApplicationPreferences } from "./preferences.js";
import { readLayout } from "./layout.js";
import { DocumentStore, FileConflict, type PreparedSaveAs } from "./persistence.js";
import { RecoveryWriter, recoveryObservationMatches, type DiskObservation as RecoveryDiskObservation, type RecoveryBaseline, type RecoveryCellState } from "./recovery.js";
import { PackageManager, readPackageDeclarations } from "./packages.js";
import { PublishingService, type PublicationSnapshot } from "./publishing.js";
import { FormattingService } from "./formatting.js";
import type { PackageProgress } from "./jobs.js";
import { renderHelp } from "./markdown.js";
import { LspClient } from "./lsp.js";
import { parseNotebook, restoreNotebookCellIdentity, serializeNotebook, serializeNotebookWithParts, setMetadata, type NotebookDocument } from "./notebook.js";
import type { ArtifactHandle, EngineHandshake, HostSnapshot, Layout, REnvironment, RecoveryState as ProtocolRecoveryState } from "./protocol.js";
import { UploadStore } from "./uploads.js";
import { REnvironmentError, resolveREnvironment } from "./r-environment.js";
import type { ApplicationResources } from "./resources.js";
import { createProcessScope, type ProcessScope } from "./processes.js";
import { acquireNotebookOwnership, isUntitledRecoveryId, registerUntitledRecoveryDescriptor, retireUntitledRecoveryDescriptor, selectUntitledRecoveryDescriptor, SessionAuthError, type NotebookOwnership, type UntitledRecoveryDescriptor } from "./sessions.js";
import { readPrivateFile } from "./private-paths.js";

type RecoveryObservationSource = Pick<RecoveryDiskObservation, "state" | "digest" | "version">;

function recoveryObservation(source: RecoveryObservationSource): RecoveryDiskObservation {
  return source.state === "unreadable"
    ? { state: source.state, digest: null, version: null, error: { code: "disk_unreadable", message: "disk observation was unreadable" } }
    : { state: source.state, digest: source.digest, version: source.version, error: null };
}

function recoveryCellStates(document: { cells: ReadonlyArray<{ id: string; revision?: number }> }): RecoveryCellState[] {
  return document.cells.map(cell => ({ id: cell.id, revision: cell.revision ?? 0 }));
}

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, semanticValue(value[key])]));
  return value;
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(semanticValue(left)) === JSON.stringify(semanticValue(right));
}

function publicationSnapshot(saved: NotebookDocument, current: HostSnapshot): PublicationSnapshot {
  const currentById = new Map(current.cells.map((cell) => [cell.id, cell]));
  return {
    documentRevision: current.documentRevision,
    path: saved.path ?? current.path,
    metadata: structuredClone((saved.metadata ?? {}) as HostSnapshot["metadata"]),
    editorDirty: current.dirty,
    cells: saved.cells.map((cell) => {
      const live = currentById.get(cell.id);
      const revision = cell.revision ?? 0;
      const compatible = live?.revision === revision;
      return {
        id: cell.id,
        type: cell.type ?? "code",
        body: [...cell.body],
        options: structuredClone(cell.options ?? {}),
        revision,
        outputs: cell.type === "markdown" ? [] : (live?.outputs.filter((record) => record.revision === revision) ?? []),
        log: compatible ? [...live.log] : [],
        progress: compatible ? structuredClone(live.progress) : null,
      };
    }),
  };
}
const optionsSchema = z.object({
  path: z.string().min(1).nullable().default(null),
  executionMode: z.enum(["automatic", "lazy"]).optional(),
  runOnStartup: z.boolean().optional(),
  idleTimeout: z.number().nonnegative().finite().default(0),
  deferStartup: z.boolean().default(false),
  externalOrigin: z.string().optional(),
  tokenFile: z.string().optional(),
  recoveryDirectory: z.string().optional(),
  preferences: z.custom<ApplicationPreferences>().optional(),
  preferencesPath: z.string().optional(),
  resources: z.custom<ApplicationResources>(),
  diagnostics: z.custom<DiagnosticSink>().optional(),
  session: z.object({
    sessionKey: z.string().optional(),
    epoch: z.string().optional(),
    continuityProof: z.string().optional(),
    token: z.string().optional(),
    untitledRecoveryId: z.string().optional(),
    projectDirectory: z.string().optional(),
  }).strict().optional(),
}).strict();

export type HostOptions = z.input<typeof optionsSchema>;

export interface HostReady {
  readonly type: "host.ready";
  readonly origin: string;
  readonly epoch: string;
  readonly capabilities: string[];
}

export interface RunningHost {
  readonly controller: Controller;
  readonly engine: Engine;
  readonly server: AlderServer;
  readonly ownership: NotebookOwnership;
  readonly resources: ApplicationResources;
  readonly runtimeEnvironment: REnvironment | null;
  readonly engineIdentity: EngineHandshake | null;
  readonly ready: HostReady;
  readonly artifactDirectory: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function startHost(input: HostOptions): Promise<RunningHost> {
  const options = optionsSchema.parse(input);
  if (options.path !== null) return startNotebookHost(options, options.path, false, options.path);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "alder-unsaved-")));
  const storagePath = join(temporary, "Untitled.R");
  try {
    const app = await startNotebookHost(options, storagePath, true, null);
    const closed = app.closed.finally(() => rm(temporary, { recursive: true, force: true }));
    return { ...app, closed, close: async () => { try { await app.close(); } finally { await closed; } } };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function startNotebookHost(
  input: HostOptions,
  storagePath: string,
  unsaved: boolean,
  ownershipPath: string | null,
): Promise<RunningHost> {
  const options = optionsSchema.parse({ ...input, path: storagePath });
  const diagnostics = options.diagnostics;
  const hostStartedAt = performance.now();
  diagnostics?.record("info", "host.launch", { cold: true });
  const browserOriginHost = createOriginHost();
  let isUntitled = unsaved;
  const declaredProjectDirectory = options.session?.projectDirectory ?? process.env.ALDER_UNTITLED_PROJECT_DIRECTORY;
  const untitledProjectDirectory = declaredProjectDirectory !== undefined && resolve(declaredProjectDirectory) === declaredProjectDirectory
    ? await realpath(declaredProjectDirectory).catch(() => declaredProjectDirectory)
    : null;
  const initialNotebookDirectory = unsaved ? (untitledProjectDirectory ?? process.cwd()) : dirname(resolve(storagePath));
  let notebookDirectory = await realpath(initialNotebookDirectory).catch(() => initialNotebookDirectory);
  let selectedRscript: string | undefined;
  let configuredToken = options.session?.token;
  if (options.tokenFile !== undefined) {
    try {
      const bytes = await readPrivateFile(options.tokenFile, { maxBytes: 65 });
      const text = bytes.toString("utf8").replace(/\r?\n$/, "");
      if (!/^[0-9a-f]{64}$/.test(text)) throw new Error("token file must contain exactly 64 lowercase hexadecimal characters");
      configuredToken = text;
    } catch (error) {
      if (error instanceof SessionAuthError) throw error;
      throw new SessionAuthError("token file could not be securely read");
    }
  }
  const ownership = await acquireNotebookOwnership({
    path: ownershipPath,
    origin: initialOrigin("127.0.0.1", 0),
    epoch: options.session?.epoch,
    continuityProof: options.session?.continuityProof,
    token: configuredToken,
    sessionKey: options.session?.sessionKey,
  });
  if (options.session?.sessionKey !== undefined && options.session.sessionKey !== ownership.sessionKey) {
    await ownership.close().catch(() => {});
    throw new Error("internal host session key does not match canonical notebook path");
  }
  const requestedRecoveryId = options.session?.untitledRecoveryId;
  if (requestedRecoveryId !== undefined && requestedRecoveryId !== ownership.sessionKey) {
    await ownership.close().catch(() => {});
    throw new Error("untitled recovery identity does not match the ownership session");
  }
  const untitledRecoveryId = isUntitled && isUntitledRecoveryId(ownership.sessionKey) ? ownership.sessionKey : null;
  let untitledRecoveryDescriptor: UntitledRecoveryDescriptor | undefined;
  if (untitledRecoveryId !== null) {
    try {
      if (requestedRecoveryId !== undefined) {
        const descriptor = await selectUntitledRecoveryDescriptor(untitledRecoveryId);
        if (untitledProjectDirectory !== null && descriptor.projectDirectory !== untitledProjectDirectory) throw new Error("untitled recovery project directory does not match its descriptor");
        notebookDirectory = descriptor.projectDirectory;
        untitledRecoveryDescriptor = descriptor;
      } else {
        untitledRecoveryDescriptor = await registerUntitledRecoveryDescriptor(untitledRecoveryId, notebookDirectory);
      }
    } catch (error) {
      if (requestedRecoveryId !== undefined) {
        await ownership.close().catch(() => {});
        throw error;
      }
    }
  }

  let store: DocumentStore | undefined;
  let recovery: RecoveryWriter | undefined;
  let processScope: ProcessScope | undefined;
  let packageManager: PackageManager | undefined;
  let controller: Controller | undefined;
  let engine: Engine | undefined;
  let server: AlderServer | undefined;
  let lsp: LspClient | undefined;
  let lspStarting: Promise<LspClient> | undefined;
  let lspRestarting: Promise<LspClient> | undefined;
  let lspGeneration = 0;
  let lspSyncTimer: NodeJS.Timeout | undefined;
  let lspSyncRunning: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let watcher: FSWatcher | undefined;
  let watcherGeneration = 0;
  let watcherReady: Promise<void> = Promise.resolve();
  let sourceWatchTimer: NodeJS.Timeout | undefined;
  let sourceWatchRunning: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolveClosedValue => { resolveClosed = resolveClosedValue; });
  let runtimeEnvironment: REnvironment | null = null;
  let runtimeError: unknown = null;
  let runtimeBootstrapGeneration = 0;
  let runtimeBootstrap: Promise<void> | undefined;
  let runtimeAbort: AbortController | undefined;
  let startRuntime: (restart?: boolean) => void = () => {};
  let engineIdentity: EngineHandshake | null = null;
  let formatter: FormattingService | undefined;
  let publisher: PublishingService | undefined;
  const activePublishes = new Set<Promise<unknown>>();
  let recoveryFingerprint: string | undefined;
  let recoveryPending = false;
  let recoveryConflict = false;
  let recoveryDocumentRevision = 0;
  let packageDeclarationIntent: string[] = [];
  let projectSettings: ProjectSettingsPatch = {};
  const preferences = options.preferences ?? await ApplicationPreferences.open(options.preferencesPath);
  selectedRscript = preferences.snapshot().values.rscript ?? undefined;
  let unsubscribePreferences: (() => void) | undefined;
  const settingsErrors = new Map<string, string>();
  const publishSettingsError = (): void => {
    const message = [...settingsErrors.values()].join("\n");
    controller?.publishServiceError("settings", message ? { code: "settings_invalid", message } : null);
  };
  const loadProjectSettings = async (path: string | null): Promise<ProjectSettingsPatch> => {
    try {
      const settings = await readProjectSettings(path);
      settingsErrors.delete("project");
      publishSettingsError();
      return settings;
    } catch (error) {
      settingsErrors.set("project", `Fix the project settings file ${path}: ${errorMessage(error)}`);
      publishSettingsError();
      return {};
    }
  };
  const configurationFor = (document: NotebookDocument, project = projectSettings): Config => {
    let notebook: NotebookSettingsPatch = {};
    try { notebook = readNotebookSettings(document.metadata); settingsErrors.delete("notebook"); }
    catch (error) { settingsErrors.set("notebook", `Fix runtime settings in ${document.path ?? "this notebook"}: ${errorMessage(error)}`); }
    publishSettingsError();
    return resolveSettings({ preferences: preferences.snapshot().values, notebook, project });
  };
  let projectLayoutIntent: Layout | null = null;
  const pendingSidecars = { layout: false, packages: false };
  let config: Config | null = null;
  let resolvedLayout: Layout | null = null;
  const onPackageProgress = (event: PackageProgress): void => {
      if (controller === undefined || event.operationId === undefined) return;
      controller.publishPackageProgress(event.operationId, {
        phase: event.phase,
        ...(event.text === undefined ? {} : { text: event.text }),
      });
  };
  const resolveProjectLibrary = async (base: REnvironment, projectDirectory: string): Promise<string | null> => {
    if (processScope === undefined) throw new Error("R process scope is unavailable while resolving the project library");
    const temporaryManager = new PackageManager({
      resources: options.resources,
      environment: base,
      processScope,
      projectDirectory,
    });
    try {
      return (await temporaryManager.status()).library;
    } finally {
      await temporaryManager.close().catch(() => {});
    }
  };
  let clientCount = 0;
  let leaseCount = 0;
  let everConnected = false;
  let browserActivity = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let cacheDirectory = "";
  let work = "";
  let uploads!: UploadStore;
  let resolveRuntimeReady!: () => void;
  let rejectRuntimeReady!: (reason: unknown) => void;
  let runtimeReady!: Promise<void>;
  const resetRuntimeReady = (): void => {
    runtimeReady = new Promise<void>((resolve, reject) => {
      resolveRuntimeReady = resolve;
      rejectRuntimeReady = reject;
    });
    void runtimeReady.catch(() => {});
  };
  resetRuntimeReady();

  const sourceObservation = (candidate: DocumentStore): RecoveryDiskObservation => isUntitled
    ? recoveryObservation({ state: "untitled", digest: null, version: null })
    : recoveryObservation(candidate.observation());
  const sourceProtocolObservation = (candidate: DocumentStore): HostSnapshot["disk"] => isUntitled
    ? { state: "untitled", digest: null, version: null, error: null }
    : candidate.observation();
  const sidecarProtocolObservations = (candidate: DocumentStore, untitled = isUntitled): HostSnapshot["sidecars"] => untitled
    ? { config: { state: "absent", digest: null, version: null, error: null }, layout: { state: "absent", digest: null, version: null, error: null }, packages: { state: "absent", digest: null, version: null, error: null } }
    : { config: candidate.sidecarObservation("config"), layout: candidate.sidecarObservation("layout"), packages: candidate.sidecarObservation("packages") };
  const sameObservation = (left: { digest?: string | null; version?: string | null; state: string }, right: { digest?: string | null; version?: string | null; state: string }): boolean => left.state === right.state && left.digest === right.digest && left.version === right.version;
  const asHostError = (error: unknown, code: string, operationId?: string): HostSnapshot["disk"]["error"] => ({
    code,
    message: errorMessage(error),
    ...(operationId === undefined ? {} : { operationId }),
  });
  const asRuntimeHostError = (error: unknown): HostSnapshot["disk"]["error"] => asHostError(error, error instanceof REnvironmentError ? error.code : "runtime_unavailable");
  const unreadableObservation = (error: unknown, code: string, operationId?: string): HostSnapshot["disk"] => ({
    state: "unreadable",
    digest: null,
    version: null,
    error: asHostError(error, code, operationId),
  });
  const closeWatcher = async (): Promise<void> => {
    ++watcherGeneration;
    clearTimeout(sourceWatchTimer);
    const current = watcher;
    watcher = undefined;
    await current?.close();
  };
  const close = (): Promise<void> => closing ??= (async () => {
    diagnostics?.record("info", "host.stop.started", {});
    runtimeAbort?.abort();
    controller?.cancelOptionalOperations();
    await Promise.allSettled([...activePublishes]);
    clearTimeout(idleTimer);
    clearTimeout(lspSyncTimer);
    clearTimeout(sourceWatchTimer);
    rejectRuntimeReady(new Error("Alder host closed before runtime startup completed"));
    void runtimeBootstrap?.catch(() => {});
    unsubscribe?.();
    unsubscribePreferences?.();
    if (!options.preferences) await preferences.close();
    await sourceWatchRunning?.catch(() => {});
    const errors: unknown[] = [];
    const attempt = async (operation: () => unknown): Promise<void> => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(closeWatcher);
    await attempt(() => server?.close());
    await lspSyncRunning?.catch(() => {});
    await lspStarting?.catch(() => {});
    await attempt(() => lsp?.stop());
    await attempt(() => controller?.close());
    if (controller === undefined) await attempt(() => engine?.close());
    await attempt(() => packageManager?.close());
    await attempt(() => recovery?.flush());
    await attempt(() => recovery?.close());
    await attempt(() => processScope?.close());
    await attempt(() => store?.close());
    await attempt(() => ownership.close());
    await attempt(() => work === "" ? undefined : rm(work, { recursive: true, force: true }));
    diagnostics?.record(errors.length ? "error" : "info", "host.stop.settled", {
      outcome: errors.length ? "error" : "success", count: errors.length,
      durationMs: Math.round(performance.now() - hostStartedAt),
    });
    if (errors.length > 0) throw new AggregateError(errors, "Alder shutdown failed");
  })().finally(resolveClosed);
  const discardAndClose = async (): Promise<void> => {
    if (recovery !== undefined) {
      const state = await recovery.load();
      if (state.fingerprint !== null) await recovery.clearIfMatch({ documentRevision: state.baseline.documentRevision, fingerprint: state.fingerprint });
      recoveryPending = false;
      recoveryFingerprint = undefined;
    }
    await close();
  };
  try {
    work = await realpath(await mkdtemp(join(tmpdir(), "alder-host-")));
    uploads = new UploadStore(join(work, "uploads"));
    cacheDirectory = unsaved ? join(work, "cache") : join(notebookDirectory, ".alder", "cache");
    const opened = await DocumentStore.open(storagePath);
    store = opened.store;
    let notebook = opened.notebook;
    if (isUntitled) notebook = { ...notebook, path: null };
    const projectPath = isUntitled ? join(notebookDirectory, ".alder", "config.yaml") : projectConfigPath(store.path);
    projectSettings = await loadProjectSettings(projectPath);
    config = configurationFor(notebook);
    projectLayoutIntent = isUntitled ? null : await readLayout(store.path);
    resolvedLayout = projectLayoutIntent;
    processScope = await createProcessScope(options.resources, diagnostics);
    try {
      const declarations = await readPackageDeclarations(notebookDirectory);
      packageDeclarationIntent = [...declarations.packages];
    } catch {
      packageDeclarationIntent = [];
    }

    const initialSerialized = serializeNotebookWithParts(notebook);
    const baseline: RecoveryBaseline = {
      schemaVersion: 1,
      documentRevision: 0,
      physicalBytes: initialSerialized.bytes,
      cells: recoveryCellStates(notebook),
      path: notebook.path ?? (isUntitled ? null : store.path),
      notebookDiskObservation: sourceObservation(store),
    };
    recovery = await RecoveryWriter.open({ rootDir: options.recoveryDirectory ?? envPaths("alder", { suffix: "" }).data, key: ownership.sessionKey, baseline });
    const loadedRecoveryState = await recovery.load();
    recoveryPending = loadedRecoveryState.pending;
    recoveryFingerprint = recoveryPending ? loadedRecoveryState.fingerprint ?? undefined : undefined;
    const materialized = await recovery.materializedBaseline();
    const currentObservation = sourceObservation(store);
    recoveryDocumentRevision = materialized.documentRevision;
    const observationsMatch = recoveryObservationMatches(materialized.notebookDiskObservation, currentObservation);
    if (recoveryPending) {
      const bytes = decodePhysicalBytes(materialized.physicalBytes);
      if (bytes === null) throw new Error("recovery baseline has no physical source bytes");
      notebook = restoreNotebookCellIdentity(parseNotebook(bytes, notebook.path ?? (isUntitled ? null : store.path)), materialized.cells);
      recoveryConflict = !observationsMatch;
    } else {
      // A saved notebook still needs stable cell IDs when a renderer lost the
      // response to a create. Reuse identities only for the exact saved source.
      const savedBytes = decodePhysicalBytes(materialized.physicalBytes);
      if (savedBytes !== null && Buffer.from(savedBytes).equals(Buffer.from(serializeNotebookWithParts(notebook).bytes))) {
        notebook = restoreNotebookCellIdentity(notebook, materialized.cells);
      }
    }
    config = configurationFor(notebook);
    cacheDirectory = config.cache.dir ? resolve(notebookDirectory, config.cache.dir) : cacheDirectory;
    resolvedLayout = projectLayoutIntent;
    pendingSidecars.layout = false;
    pendingSidecars.packages = false;
    engine = new Engine({ resources: options.resources, processScope, environment: runtimeEnvironment ?? undefined, notebookDirectory, artifactDirectory: work, cacheDirectory });
    packageManager = new PackageManager({ resources: options.resources, environment: runtimeEnvironment, processScope, projectDirectory: notebookDirectory, onProgress: onPackageProgress });
    formatter = new FormattingService(options.resources.airExecutable, processScope);

    const appendRecovery = async (input: {
      fromRevision: number;
      document: NotebookDocument;
      disk: HostSnapshot["disk"];
    }): Promise<string | undefined> => {
      if (recovery === undefined) return undefined;
      const next = serializeNotebookWithParts(input.document);
      const baseline: RecoveryBaseline = {
        schemaVersion: 1,
        physicalBytes: next.bytes,
        documentRevision: input.fromRevision + 1,
        cells: recoveryCellStates(input.document),
        path: input.document.path ?? (isUntitled ? null : store!.path),
        notebookDiskObservation: recoveryObservation(input.disk),
      };
      recovery.update(baseline);
      await recovery.flush();
      const state = await recovery.load();
      notebook = input.document;
      recoveryFingerprint = state.fingerprint ?? undefined;
      recoveryDocumentRevision = baseline.documentRevision;
      recoveryPending = true;
      return recoveryFingerprint;
    };
    type SourcePublicationInput = Omit<SourcePublication, "config"> & { config?: Config };
    const publishSource = (context: SourceCommitContext, publication: SourcePublicationInput): void => {
      const preparedPublication: SourcePublication = { ...publication, config: publication.config ?? context.config };
      context.preparePublication(preparedPublication)();
    };
    const invalidateLsp = async (): Promise<boolean> => {
      const requested = lsp !== undefined || lspStarting !== undefined;
      const startedAt = performance.now();
      if (requested) diagnostics?.record("info", "lsp.stop", { phase: "started" });
      ++lspGeneration;
      const previous = lsp;
      const pending = lspStarting;
      lsp = undefined;
      await previous?.stop().catch(() => {});
      await pending?.catch(() => {});
      if (lspStarting === pending) lspStarting = undefined;
      await lspSyncRunning?.catch(() => {});
      if (requested) diagnostics?.record("info", "lsp.stop", { phase: "settled", durationMs: Math.round(performance.now() - startedAt), outcome: "success" });
      return requested;
    };

    const retryPendingSidecars = async (
      operationId?: string,
    ): Promise<{ sidecars: HostSnapshot["sidecars"]; error: { kind: "config" | "layout" | "packages"; error: unknown } | null }> => {
      let sidecars = sidecarProtocolObservations(store!, false);
      let activeKind: "config" | "layout" | "packages" = "config";
      const updateObservation = (kind: "config" | "layout" | "packages", observation: HostSnapshot["sidecars"]["config"]): void => {
        sidecars = { ...sidecars, [kind]: observation };
      };
      const failure = (kind: "config" | "layout" | "packages", error: unknown): { sidecars: HostSnapshot["sidecars"]; error: { kind: "config" | "layout" | "packages"; error: unknown } } => {
        const observation = sidecars[kind];
        updateObservation(kind, { ...observation, error: asHostError(error, "sidecar_write_failed", operationId) });
        return { sidecars, error: { kind, error } };
      };
      try {
        if (pendingSidecars.layout || pendingSidecars.packages) {
          activeKind = "layout";
          const actualLayout = await readLayout(store!.path);
          pendingSidecars.layout = !sameSemanticValue(projectLayoutIntent, actualLayout);
          activeKind = "packages";
          const actualPackages = await readPackageDeclarations(notebookDirectory);
          pendingSidecars.packages = !sameSemanticValue(packageDeclarationIntent, actualPackages.packages);
        }
        if (pendingSidecars.layout) {
          activeKind = "layout";
          const prepared = await store!.prepareLayout(projectLayoutIntent as never, store!.sidecarObservation("layout").version);
          projectLayoutIntent = prepared.value;
          const published = await prepared.publish();
          pendingSidecars.layout = false;
          projectLayoutIntent = published.value;
          resolvedLayout = published.value;
          updateObservation("layout", published.observation);
        }
        if (pendingSidecars.packages) {
          activeKind = "packages";
          const current = await readPackageDeclarations(notebookDirectory);
          const additions = packageDeclarationIntent.filter(packageName => !current.packages.includes(packageName));
          if (additions.length > 0) {
            const prepared = await store!.preparePackages(additions, store!.sidecarObservation("packages").version);
            packageDeclarationIntent = [...prepared.value];
            const published = await prepared.publish();
            packageDeclarationIntent = [...published.value];
            updateObservation("packages", published.observation);
          } else {
            packageDeclarationIntent = [...current.packages];
            updateObservation("packages", store!.sidecarObservation("packages"));
          }
          pendingSidecars.packages = false;
        }
      } catch (error) {
        return failure(activeKind, error);
      }
      return { sidecars, error: null };
    };
    const publishSidecarFailure = (
      context: SourceCommitContext,
      document: NotebookDocument,
      config: Config,
      layout: SourcePublication["layout"],
      kind: "config" | "layout" | "packages",
      error: unknown,
      code: "sidecar_write_failed" | "recovery_checkpoint_failed",
    ): unknown => {
      const observed = sidecarProtocolObservations(store!, false);
      const sidecars = {
        ...context.sidecars,
        [kind]: { ...observed[kind], error: asHostError(error, code, context.operationId) },
      };
      publishSource(context, { document, path: context.path, config, layout, disk: context.disk, sidecars, dirty: true, advanceRevision: true });
      return { committed: true, diskError: { code, sidecar: kind, message: errorMessage(error) } };
    };
    const sourceCommit: SourceCommitHandler = async (request, context) => {
      diagnostics?.record("info", "operation.phase", {
        operationId: request.operationId ?? null, kind: request.kind, phase: "persistence",
        documentRevision: context.fromRevision,
      });
      if (request.kind === "transaction") {
        const document = request.document ?? context.document;
        const delta = request.delta;
        await appendRecovery({
          fromRevision: context.fromRevision,
          document,
          disk: context.disk,
        });
        diagnostics?.record("info", "persistence.recovery_flushed", {
          operationId: request.operationId ?? null, kind: request.kind, phase: "recovery-flush",
          documentRevision: context.fromRevision + 1,
        });
        publishSource(context, { document,
          path: document.path ?? context.path,
          layout: context.layout,
          disk: context.disk,
          sidecars: context.sidecars,
          dirty: true,
          advanceRevision: true,
        });
        diagnostics?.record("info", "operation.phase", {
          operationId: request.operationId ?? null, kind: request.kind, phase: "authoritative-ack",
          documentRevision: context.fromRevision + 1,
        });
        return { created: delta?.created ?? {}, edited: delta?.edited ?? [], deleted: delta?.deleted ?? [], documentRevision: context.fromRevision + 1 };
      }
      if (request.kind === "save") {
        if (isUntitled) throw Object.assign(new Error("notebook has no path"), { code: "notebook_has_no_path" });
        if (recoveryConflict) throw Object.assign(new Error("The saved notebook changed after these recovered edits. Use Save As or discard the recovered edits."), { code: "recovery_conflict" });
        try {
          const result = await store!.save(context.document);
          diagnostics?.record("info", "save.source_published", {
            operationId: request.operationId ?? null, phase: "publication", documentRevision: context.fromRevision,
          });
          const disk = sourceProtocolObservation(store!);
          const retry = await retryPendingSidecars(request.operationId);
          const sidecars = retry.sidecars;
          let clearError: unknown = null;
          let cleared = false;
          if (recoveryPending && recoveryFingerprint !== undefined) {
            try {
              cleared = await recovery!.clearIfMatch({ documentRevision: context.fromRevision, fingerprint: recoveryFingerprint });
              if (cleared) {
                recoveryPending = false;
                recoveryFingerprint = undefined;
                recoveryConflict = false;
              }
            } catch (error) { clearError = error; }
          }
          const dirty = retry.error !== null
            || clearError !== null
            || recoveryPending
            || pendingSidecars.layout
            || pendingSidecars.packages;
          publishSource(context, { document: context.document, path: store!.path, layout: resolvedLayout, disk, sidecars, dirty, advanceRevision: false });
          diagnostics?.record(dirty ? "warn" : "info", "save.clean_state", {
            operationId: request.operationId ?? null, phase: "clean", dirty, documentRevision: context.fromRevision,
          });
          if (retry.error !== null) return { ...result, committed: true, diskError: { code: "sidecar_write_failed", sidecar: retry.error.kind, message: errorMessage(retry.error.error) } };
          if (clearError !== null) return { ...result, committed: true, diskError: { code: "recovery_checkpoint_failed", message: errorMessage(clearError) } };
          return result;
        } catch (error) {
          diagnostics?.record(error instanceof FileConflict ? "warn" : "error", error instanceof FileConflict ? "persistence.conflict" : "persistence.failure", {
            operationId: request.operationId ?? null, kind: request.kind, outcome: "error",
            errorCode: error instanceof FileConflict ? "source_conflict" : (error as NodeJS.ErrnoException)?.code ?? "source_write_failed",
          });
          if (error instanceof FileConflict) throw error;
          const diskError = asHostError(error, "source_write_failed", request.operationId);
          publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: unreadableObservation(error, "source_write_failed", request.operationId), sidecars: context.sidecars, dirty: true, advanceRevision: false });
          return { committed: true, diskError };
        }
      }
      if (request.kind === "runtime") {
        const updated = setNotebookSettings(context.document, request.patch as NotebookSettingsPatch);
        const document = setMetadata(context.document, "runtime", updated.metadata?.runtime ?? null);
        const notebook = readNotebookSettings(document.metadata);
        const nextConfig = resolveSettings({ preferences: preferences.snapshot().values, notebook, project: projectSettings });
        await appendRecovery({ fromRevision: context.fromRevision, document, disk: context.disk });
        config = nextConfig;
        publishSource(context, { document, path: context.path, config: nextConfig, layout: context.layout, disk: context.disk, sidecars: context.sidecars, dirty: true, advanceRevision: true });
        settingsErrors.delete("notebook");
        publishSettingsError();
        return { config: nextConfig };
      }
      if (request.kind === "sidecar" && request.sidecar === "config") {
        if (isUntitled) throw Object.assign(new Error("Project settings require a notebook path"), { code: "notebook_has_no_path" });
        const prepared = await store!.prepareConfig(request.patch as ProjectSettingsPatch, context.sidecars.config.version);
        const published = await prepared.publish();
        projectSettings = published.value;
        config = configurationFor(context.document);
        cacheDirectory = config.cache.dir ? resolve(notebookDirectory, config.cache.dir) : join(notebookDirectory, ".alder", "cache");
        settingsErrors.delete("project");
        publishSettingsError();
        const sidecars = { ...context.sidecars, config: published.observation };
        publishSource(context, { document: context.document, path: context.path, config, layout: context.layout, disk: context.disk, sidecars, dirty: context.dirty, advanceRevision: false });
        return { config };
      }
      if (request.kind === "sidecar" && request.sidecar === "layout") {
        if (isUntitled) throw Object.assign(new Error("layout requires a notebook path"), { code: "notebook_has_no_path" });
        const requestedLayout = request.layout ?? null;
        const prepared = await store!.prepareLayout(requestedLayout as never, context.sidecars.layout.version);
        projectLayoutIntent = prepared.value;
        pendingSidecars.layout = true;
        try {
          const published = await prepared.publish();
          pendingSidecars.layout = false;
          resolvedLayout = published.value;
          const sidecars = { ...context.sidecars, layout: published.observation };
          publishSource(context, { document: context.document, path: context.path, layout: resolvedLayout, disk: context.disk, sidecars, dirty: context.dirty, advanceRevision: false });
          return { layout: resolvedLayout };
        } catch (error) {
          const code = pendingSidecars.layout ? "sidecar_write_failed" : "recovery_checkpoint_failed";
          return publishSidecarFailure(context, context.document, context.config, projectLayoutIntent, "layout", error, code);
        }
      }
      if (request.kind === "sidecar" && request.sidecar === "packages") {
        if (isUntitled) throw Object.assign(new Error("packages require a notebook path"), { code: "notebook_has_no_path" });
        const additions = request.packages ?? [];
        const prepared = await store!.preparePackages(additions, context.sidecars.packages.version);
        packageDeclarationIntent = [...prepared.value];
        pendingSidecars.packages = true;
        try {
          const published = await prepared.publish();
          pendingSidecars.packages = false;
          const sidecars = { ...context.sidecars, packages: published.observation };
          publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: context.disk, sidecars, dirty: context.dirty, advanceRevision: false });
          return { ok: true, path: notebookDirectory, metadata: join(notebookDirectory, ".alder", "packages.yaml"), packages: [...published.value], sidecarVersion: published.observation.version };
        } catch (error) {
          const code = pendingSidecars.packages ? "sidecar_write_failed" : "recovery_checkpoint_failed";
          return publishSidecarFailure(context, context.document, context.config, context.layout, "packages", error, code);
        }
      }
      if (request.kind === "sidecar" && request.sidecar === undefined && request.patch !== undefined) {
        const appDocument = setAppConfig(context.document, request.patch);
        const document = setMetadata(context.document, "app", appDocument.metadata?.app ?? null);
        await appendRecovery({ fromRevision: context.fromRevision, document, disk: context.disk });
        const appResolution = appConfig(document);
        publishSource(context, { document, path: context.path, layout: context.layout, disk: context.disk, sidecars: context.sidecars, dirty: true, advanceRevision: true });
        return appResolution;
      }
      if (request.kind === "save-as" && request.path !== undefined && !isUntitled
          && await realpath(request.path).catch(() => null) === store!.path) {
        return sourceCommit({ ...request, kind: "save" }, context);
      }
      if (request.kind === "save-as") {
        if (request.path === undefined || request.path.length === 0) throw new Error("Save As destination path is required");
        const oldStore = store!;
        const oldRecovery = recovery!;
        const oldManager = packageManager;
        const tentativeDirectory = dirname(resolve(request.path));
        const reservation = (!isUntitled && tentativeDirectory === notebookDirectory && runtimeEnvironment === null) ? undefined : controller!.reserveRuntimeContext();
        let preparedOwner: Awaited<ReturnType<typeof ownership.prepareRekey>> | undefined;
        let preparedSave: PreparedSaveAs | undefined;
        let savePublication: Awaited<ReturnType<PreparedSaveAs["publish"]>> | undefined;
        let destinationStore: DocumentStore | undefined;
        let destinationRecovery: RecoveryWriter | undefined;
        let destinationRecoveryPreviousId: string | undefined;
        let destinationRecoveryAdopted = false;
        let nextManager: PackageManager | undefined;
        try {
          preparedOwner = await ownership.prepareRekey(request.path);
          preparedSave = await oldStore.prepareSaveAs(request.path, context.document, request.expectedDestination);
          if (preparedSave.destination !== preparedOwner.canonicalPath) throw new Error("Save As destination canonicalization changed during preparation");
          const destination = preparedSave.destination;
          const destinationDirectory = dirname(destination);
          const destinationProjectConfig = await loadProjectSettings(projectConfigPath(destination));
          const destinationConfig = configurationFor(context.document, destinationProjectConfig);
          const destinationCache = destinationConfig.cache.dir ? resolve(destinationDirectory, destinationConfig.cache.dir) : join(destinationDirectory, ".alder", "cache");
          const destinationLayout = await readLayout(destination);
          let destinationPackages: string[] = [];
          try { destinationPackages = [...(await readPackageDeclarations(destinationDirectory)).packages]; } catch { destinationPackages = []; }
          const runtimeChanged = destinationDirectory !== notebookDirectory || destinationCache !== cacheDirectory;
          const destinationRuntime = runtimeChanged ? null : runtimeEnvironment;
          const recoveryRoot = options.recoveryDirectory ?? envPaths("alder", { suffix: "" }).data;
          if (await RecoveryWriter.hasJournal({ rootDir: recoveryRoot, key: preparedOwner.sessionKey })) {
            throw Object.assign(new Error("Save As destination has pending recovery data"), { code: "destination_recovery_conflict" });
          }
          savePublication = await preparedSave.publish();
          destinationStore = savePublication.store;
          nextManager = new PackageManager({ resources: options.resources, environment: destinationRuntime, processScope: processScope!, projectDirectory: destinationDirectory, onProgress: onPackageProgress });
          const destinationDisk = destinationStore.observation();
          const destinationSidecars = sidecarProtocolObservations(destinationStore, false);
          const destinationSerialized = serializeNotebookWithParts(destinationStore.currentDocument);
          const destinationRevision = context.fromRevision;
          const destinationBaseline: RecoveryBaseline = {
            schemaVersion: 1,
            documentRevision: destinationRevision,
            physicalBytes: destinationSerialized.bytes,
            cells: recoveryCellStates(destinationStore.currentDocument),
            path: destination,
            notebookDiskObservation: recoveryObservation(destinationDisk),
          };
          destinationRecovery = await RecoveryWriter.open({
            rootDir: recoveryRoot,
            key: preparedOwner.sessionKey,
            baseline: destinationBaseline,
            recoveryId: oldRecovery.recoveryId,
          });
          if ((await destinationRecovery.load()).pending) {
            throw Object.assign(new Error("Save As destination has pending recovery data"), { code: "destination_recovery_conflict" });
          }
          destinationRecoveryPreviousId = destinationRecovery.recoveryId;
          const publicationBinder = context.preparePublication({
            document: { ...context.document, path: destination },
            path: destination,
            config: destinationConfig,
            layout: destinationLayout,
            disk: destinationDisk,
            sidecars: destinationSidecars,
            dirty: false,
            advanceRevision: false,
            invalidateRuntime: runtimeChanged,
            rEnvironment: destinationRuntime,
          });
          await preparedOwner.commit(async () => {
            const rollbackControllerPublication = (): void => {
              const binder = context.preparePublication({
                document: context.document,
                path: context.path,
                config: context.config,
                layout: context.layout,
                disk: context.disk,
                sidecars: context.sidecars,
                dirty: context.dirty,
                advanceRevision: false,
                invalidateRuntime: false,
                rEnvironment: runtimeEnvironment,
              });
              binder();
            };
            return async () => {
              try {
                await destinationRecovery!.adoptRecoveryId(oldRecovery.recoveryId);
                destinationRecoveryAdopted = true;
                // Apply the controller publication before adopting any destination state.
                publicationBinder();
                store = destinationStore;
                recovery = destinationRecovery;
                packageManager = nextManager;
                notebookDirectory = destinationDirectory;
                cacheDirectory = destinationCache;
                config = destinationConfig;
                projectSettings = { ...destinationProjectConfig };
                resolvedLayout = destinationLayout;
                projectLayoutIntent = destinationLayout;
                packageDeclarationIntent = destinationPackages;
                pendingSidecars.layout = false;
                pendingSidecars.packages = false;
                isUntitled = false;
                runtimeEnvironment = destinationRuntime;
                runtimeError = null;
                recoveryDocumentRevision = destinationRevision;
                recoveryPending = false;
                recoveryFingerprint = undefined;
                recoveryConflict = false;
                reservation?.release();
                try {
                  bindWatcher(destination);
                } catch (error) {
                  controller?.recordActionError(errorMessage(error), "watcher_failed");
                }
                invalidateLsp();
                if (runtimeError !== null) controller!.recordRuntimeAvailabilityError(asRuntimeHostError(runtimeError)!);
                if (untitledRecoveryDescriptor !== undefined) void retireUntitledRecoveryDescriptor(untitledRecoveryDescriptor).catch(error => controller?.recordActionError(errorMessage(error), "recovery_checkpoint_failed"));
                void oldStore.close().catch(() => {});
                await oldRecovery.retire().catch(() => {});
                if (runtimeChanged) startRuntime(true);
                void oldManager?.close().catch(() => {});
              } catch (error) {
                if (destinationRecoveryAdopted && destinationRecoveryPreviousId !== undefined) {
                  await destinationRecovery!.adoptRecoveryId(destinationRecoveryPreviousId).catch(() => {});
                  destinationRecoveryAdopted = false;
                }
                try {
                  rollbackControllerPublication();
                } catch {
                  // Preserve the original publication failure; ownership rollback remains authoritative.
                }
                throw error;
              }
            };
          });
          await watcherReady;
          return savePublication.result;
        } catch (error) {
          reservation?.release();
          if (destinationRecovery !== undefined && destinationRecovery !== recovery) {
            if (destinationRecoveryAdopted && destinationRecoveryPreviousId !== undefined) await destinationRecovery.adoptRecoveryId(destinationRecoveryPreviousId).catch(() => {});
            await destinationRecovery.close().catch(() => {});
          }
          await preparedSave?.abort().catch(() => {});
          await preparedOwner?.abort().catch(() => {});
          await nextManager?.close().catch(() => {});
          if (destinationStore !== undefined && destinationStore !== store) await destinationStore.close().catch(() => {});
          throw error;
        }
      }
      if (request.kind === "reload-source" || request.kind === "watcher") {
        if (isUntitled || store === undefined) throw Object.assign(new Error("notebook has no path"), { code: "notebook_has_no_path" });
        let observed: { store: DocumentStore; notebook: NotebookDocument } | undefined;
        let sidecarReadKind: "config" | "layout" | null = null;
        try {
          observed = await DocumentStore.open(store.path);
          const current = observed.store.observation();
          const currentSidecars = sidecarProtocolObservations(observed.store);
          const sourceChanged = !sameObservation(context.disk, current);
          const sidecarsChanged = !sameObservation(context.sidecars.config, currentSidecars.config)
            || !sameObservation(context.sidecars.layout, currentSidecars.layout)
            || !sameObservation(context.sidecars.packages, currentSidecars.packages);
          if (request.kind === "watcher" && !sourceChanged && !sidecarsChanged) {
            await observed.store.close();
            publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: context.disk, sidecars: context.sidecars, dirty: context.dirty, advanceRevision: false });
            return { changed: false };
          }
          if (context.dirty && (sourceChanged || sidecarsChanged || request.kind === "reload-source") && request.discardRecovery !== true) {
            if (sourceChanged) await store.adoptSourceObservation(observed.store);
            store.adoptSidecarObservations(observed.store);
            await observed.store.close();
            publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: sourceChanged ? current : context.disk, sidecars: currentSidecars, dirty: true, advanceRevision: false });
            controller!.recordActionError("external notebook state changed; local draft retained", sourceChanged ? "source_conflict" : "sidecar_conflict");
            return { conflict: true, disk: sourceChanged ? current : context.disk };
          }
          if (request.kind === "watcher" && current.state === "absent" && !context.dirty) {
            await store.adoptSourceObservation(observed.store);
            store.adoptSidecarObservations(observed.store);
            await observed.store.close();
            publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: current, sidecars: currentSidecars, dirty: false, advanceRevision: false });
            return { changed: true, disk: current };
          }
          const precondition = request.expectedDisk === undefined
            ? { expectedDiskDigest: current.digest ?? "", expectedDiskVersion: current.version ?? "" }
            : { expectedDiskDigest: request.expectedDisk.digest ?? "", expectedDiskVersion: request.expectedDisk.version ?? "" };
          const preparedReload = await store.prepareReload(precondition, context.document);
          const nextDocument = preparedReload.notebook;
          let nextProjectConfig = projectSettings;
          let nextLayout = projectLayoutIntent;
          let nextPackageDeclarationIntent = packageDeclarationIntent;
          const nextPendingSidecars = { ...pendingSidecars };
          if (sidecarsChanged) {
            sidecarReadKind = "config";
            nextProjectConfig = await loadProjectSettings(projectConfigPath(store.path));
            sidecarReadKind = "layout";
            nextLayout = await readLayout(store.path);
            sidecarReadKind = null;
          }
          const nextConfig = configurationFor(nextDocument, nextProjectConfig);
          if (sidecarsChanged) {
            try { nextPackageDeclarationIntent = [...(await readPackageDeclarations(dirname(store.path))).packages]; } catch { nextPackageDeclarationIntent = []; }
            nextPendingSidecars.layout = false;
            nextPendingSidecars.packages = false;
          }
          const nextSidecars = currentSidecars;
          const nextDisk = preparedReload.observation;
          preparedReload.adopt();
          store.adoptSidecarObservations(observed.store);
          await observed.store.close();
          publishSource(context, { document: nextDocument, path: store.path, layout: nextLayout, disk: nextDisk, sidecars: nextSidecars, dirty: false, advanceRevision: sourceChanged || sidecarsChanged, invalidateRuntime: sourceChanged, config: nextConfig });
          notebook = nextDocument;
          if (request.discardRecovery === true) {
            await recovery!.discard();
            recoveryPending = false;
            recoveryFingerprint = undefined;
            recoveryConflict = false;
          }
          if (sidecarsChanged) {
            projectSettings = { ...nextProjectConfig };
            projectLayoutIntent = nextLayout;
            resolvedLayout = nextLayout;
            packageDeclarationIntent = [...nextPackageDeclarationIntent];
            pendingSidecars.layout = nextPendingSidecars.layout;
            pendingSidecars.packages = nextPendingSidecars.packages;
            config = nextConfig;
          }
          return { reloaded: true, disk: nextDisk };
        } catch (error) {
          const observedSidecars = observed === undefined ? context.sidecars : sidecarProtocolObservations(observed.store);
          await observed?.store.close().catch(() => {});
          if (request.kind === "watcher") {
            if (sidecarReadKind !== null) {
              const sidecars = {
                ...observedSidecars,
                [sidecarReadKind]: {
                  ...observedSidecars[sidecarReadKind],
                  error: asHostError(error, "sidecar_read_failed", request.operationId),
                },
              };
              publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: context.disk, sidecars, dirty: true, advanceRevision: false });
              controller!.recordActionError(errorMessage(error), "sidecar_conflict");
              return { conflict: true, sidecars };
            }
            publishSource(context, { document: context.document, path: context.path, layout: context.layout, disk: unreadableObservation(error, "source_unreadable", request.operationId), sidecars: context.sidecars, dirty: true, advanceRevision: false });
            controller!.recordActionError(errorMessage(error), "source_conflict");
            return { conflict: true };
          }
          throw error;
        }
      }
      throw Object.assign(new Error("unsupported source commit: " + request.kind), { code: "service_unavailable" });
    };

    const artifactStore = engine!.prepareOutputStore({ sessionEpoch: ownership.epoch, documentRevision: recoveryDocumentRevision });
    const recoveryState = async (): Promise<ProtocolRecoveryState> => {
      try {
        const state = await recovery!.load();
        return {
          candidate: state.pending ? {
            documentRevision: state.baseline.documentRevision,
            state: recoveryConflict ? "conflict" : "restored",
          } : null,
          corruption: recovery!.issue ? asHostError(recovery!.issue, recovery!.issue.code) : null,
        };
      } catch (error) {
        return { candidate: null, corruption: asHostError(error, "recovery_corrupt") };
      }
    };
    const initialProtocolSidecars = sidecarProtocolObservations(store);
    const recoveredStartup = recoveryPending;
    controller = new Controller({
      engine,
      outputStore: artifactStore,
      notebook,
      config: config!,
      layout: resolvedLayout,
      epoch: ownership.epoch,
      deferStartup: options.deferStartup || recoveredStartup,
      suppressStartup: options.runOnStartup === false,
      initialDirty: recoveredStartup,
      preferencesVersion: preferences.snapshot().version,
      initialDocumentRevision: recoveryDocumentRevision,
      rEnvironment: runtimeEnvironment,
      disk: sourceProtocolObservation(store),
      sidecars: initialProtocolSidecars,
      sourceCommit,
      getRecoveryState: recoveryState,
      diagnostics,
      services: {
        format: async (cells, operation) => {
          const codeCells = cells.filter(cell => cell.type === "code");
          if (codeCells.length === 0) return {};
          const document: NotebookDocument = { cells: codeCells.map(cell => ({ id: cell.id, type: cell.type, body: [...cell.body], revision: cell.revision })) };
          const edits = await formatter!.formatCells(document, codeCells.map(cell => cell.id), operation?.signal);
          return Object.fromEntries(edits.map(edit => [cellRefId(edit.cell), edit.body]));
        },
        refreshPackageEnvironment: async (): Promise<REnvironment> => {
          const refreshGeneration = runtimeBootstrapGeneration;
          const refreshed = await resolveREnvironment({
            signal: runtimeAbort?.signal,
            rscript: selectedRscript,
            projectDirectory: notebookDirectory,
            resources: options.resources,
            resolveProjectLibrary: base => resolveProjectLibrary(base, notebookDirectory),
          });
          const isCurrent = (): boolean => !closing
            && refreshGeneration === runtimeBootstrapGeneration
            && controller !== undefined
            && processScope !== undefined;
          const superseded = (): Error => Object.assign(new Error("R package environment refresh was superseded"), { code: "operation_in_progress" });
          if (!isCurrent()) throw superseded();
          const nextManager = new PackageManager({
            resources: options.resources,
            environment: refreshed,
            processScope: processScope!,
            projectDirectory: notebookDirectory,
            onProgress: onPackageProgress,
          });
          if (!isCurrent()) {
            await nextManager.close().catch(() => {});
            throw superseded();
          }
          const previousManager = packageManager;
          packageManager = nextManager;
          runtimeEnvironment = refreshed;
          runtimeError = null;
          await refreshLspForEnvironment(refreshGeneration);
          if (!isCurrent()) throw superseded();
          await previousManager?.close().catch(() => {});
          scheduleLspSync();
          return refreshed;
        },
        service: async (command, payload, operation) => {
          if (command === "preferences.update") {
            await preferences.update(payload.patch as PreferencesPatch, payload.expectedPreferencesVersion as string | null);
            return { config: controller!.snapshot().config, preferencesVersion: preferences.snapshot().version };
          }
          if (command === "r.select") {
            const selectionGeneration = ++runtimeBootstrapGeneration;
            runtimeAbort?.abort();
            runtimeAbort = new AbortController();
            const selectionSignal = runtimeAbort.signal;
            resetRuntimeReady();
            const resolveSelectionReady = resolveRuntimeReady;
            const rejectSelectionReady = rejectRuntimeReady;
            try {
            const selected = await resolveREnvironment({
              signal: selectionSignal,
              rscript: z.string().min(1).parse(payload.rscript),
              projectDirectory: notebookDirectory,
              resources: options.resources,
              resolveProjectLibrary: base => resolveProjectLibrary(base, notebookDirectory),
            });
            if (selectionGeneration !== runtimeBootstrapGeneration) throw Object.assign(new Error("R environment selection was superseded"), { code: "operation_in_progress" });
            const current = controller!.snapshot();
            if (current.runtime.busy || current.runtime.activeRunId !== null) throw Object.assign(new Error("cannot select R while the notebook is busy"), { code: "busy" });
            selectedRscript = selected.rscript;
            await preferences.update({ rscript: selected.rscript }, preferences.snapshot().version);
            const nextManager = new PackageManager({ resources: options.resources, environment: selected, processScope: processScope!, projectDirectory: notebookDirectory, onProgress: onPackageProgress });
            try {
              await controller!.restartRuntimeContext({ environment: selected, notebookDirectory, cacheDirectory }, stringValue(payload.operationId) ?? randomUUID());
            } catch (error) {
              await nextManager.close().catch(() => {});
              throw error;
            }
            const previousManager = packageManager;
            packageManager = nextManager;
            runtimeEnvironment = selected;
            runtimeError = null;
            await previousManager?.close();
            await invalidateLsp();
            scheduleLspSync();
            resolveSelectionReady();
            return { rEnvironment: selected, identity: selected.identity };
            } catch (error) {
              rejectSelectionReady(error);
              throw error;
            }
          }
          if (command === "packages.status") return packageManager!.status({ operationId: stringValue(payload.operationId), signal: operation?.signal });
          if (command === "packages.install") return packageManager!.install(z.array(z.string()).parse(payload.packages ?? []), {
            operationId: stringValue(payload.operationId),
            signal: operation?.signal,
          });
          if (command === "publish") {
            if (activePublishes.size > 0) throw Object.assign(new Error("a publication is already in progress"), { code: "operation_in_progress" });
            if (publisher === undefined) publisher = new PublishingService({ outputStore: artifactStore, processScope: processScope!, quartoExecutable: options.resources.quartoExecutable });
            const liveSnapshot = controller!.snapshot();
            if (store === undefined) throw Object.assign(new Error("notebook has no saved source"), { code: "notebook_has_no_path" });
            const snapshot = publicationSnapshot(store.currentDocument, liveSnapshot);
            const requestedPath = typeof payload.outputPath === "string" && payload.outputPath.length > 0 ? payload.outputPath : null;
            const outputPath = requestedPath ?? join(work, "publish-" + randomUUID() + ".html");
            const pendingPublish = publisher.publishSnapshot(snapshot, { outputPath, includeCode: payload.includeCode === true, signal: operation?.signal });
            activePublishes.add(pendingPublish);
            const result = await pendingPublish.finally(() => { activePublishes.delete(pendingPublish); });
            if (requestedPath !== null) return result;
            let artifact: ArtifactHandle | undefined;
            try {
              try {
                artifact = await artifactStore.importArtifact(basename(result.path), {
                  sessionEpoch: liveSnapshot.epoch,
                  documentRevision: result.documentRevision,
                  kernelEpoch: null,
                  runId: null,
                  cellId: null,
                  revision: null,
                }, { mimeType: "text/html; charset=utf-8", extension: ".html" });
              } finally {
                await rm(result.path, { force: true });
              }
              if (server === undefined) throw new Error("publish server is unavailable");
              return {
                artifact: server.retainArtifact(artifact),
                source: result.source,
                unsavedChangesExcluded: result.unsavedChangesExcluded,
              };
            } catch (error) {
              if (artifact !== undefined) artifactStore.release([artifact]);
              throw error;
            }
          }
          if (command === "upload.store") return uploads.store(payload.files);
          if (command === "upload.remove") return uploads.remove(z.string().parse(payload.uploadId));
          if (command === "source") {
            const sourceDocument = controller!.notebookDocument();
            return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(serializeNotebook(sourceDocument)) };
          }
          if (command === "help") { const rendered = renderHelp(payload.contents as never); return { kind: "markdown", html: rendered.html, text: String(payload.contents ?? "") }; }
          throw Object.assign(new Error("unsupported host service: " + command), { code: "service_unavailable" });
        },
      },
    });
    const refreshPreferences = (): void => {
      const state = preferences.snapshot();
      const nextRscript = state.values.rscript ?? undefined;
      const rSelectionChanged = nextRscript !== selectedRscript;
      selectedRscript = nextRscript;
      if (state.error) settingsErrors.set("preferences", state.error.message);
      else settingsErrors.delete("preferences");
      controller!.updatePreferences(state.values, state.version);
      publishSettingsError();
      if (rSelectionChanged) startRuntime(true);
    };
    unsubscribePreferences = preferences.subscribe(refreshPreferences);
    refreshPreferences();
    if (options.executionMode !== undefined && options.executionMode !== controller.snapshot().runtime.executionMode) {
      // The launch choice uses the same dirty/recovery path as the notebook control.
      const result = await controller.dispatch({ type: "set-runtime", requestId: randomUUID(), clientId: "launch",
        sessionEpoch: controller.epoch, expectedDocumentRevision: controller.snapshot().documentRevision,
        on_cell_change: options.executionMode });
      if (result.error) controller.recordActionError(`Could not apply launch execution mode: ${result.error.message}`, result.error.code);
    }
    if (runtimeError !== null) controller.recordRuntimeAvailabilityError(asRuntimeHostError(runtimeError)!);
    if (recoveryConflict) controller.recordActionError("notebook changed on disk; recovery draft retained", "recovery_conflict");
    const getLsp = (): Promise<LspClient> => {
      if (lsp?.alive()) return Promise.resolve(lsp);
      if (lspStarting !== undefined) return lspStarting;
      const generation = ++lspGeneration;
      const starting = createLsp(generation, () => lspGeneration, controller!, engine!, () => runtimeReady, notebookDirectory, setLsp, diagnostics);
      lspStarting = starting;
      void starting.then(
        () => { if (lspStarting === starting) lspStarting = undefined; },
        () => { if (lspStarting === starting) lspStarting = undefined; },
      );
      return starting;
    };
    function setLsp(value: LspClient | undefined): void { lsp = value; }
    const scheduleLspSync = (): void => {
      clearTimeout(lspSyncTimer);
      if (closing || controller!.snapshot().runtime.kernelState !== "ready" ||
          (!lspStarting && !diagnosticsEnabled(controller!))) return;
      lspSyncTimer = setTimeout(() => { const previous = lspSyncRunning ?? Promise.resolve(); lspSyncRunning = previous.catch(() => {}).then(async () => { const client = await getLsp(); if (diagnosticsEnabled(controller!)) await client.syncDocument(await lspDocument(controller!.snapshot())); await client.setDiagnostics(diagnosticsEnabled(controller!)); }).catch(error => { if (!closing) process.stderr.write("Language assistance unavailable: " + errorMessage(error) + "\\n"); }); }, 150);
    };
    const refreshLspForEnvironment = async (expectedGeneration: number): Promise<void> => {
      clearTimeout(lspSyncTimer);
      lspSyncTimer = undefined;
      const requested = await invalidateLsp();
      if (!requested || closing || expectedGeneration !== runtimeBootstrapGeneration) return;
      try {
        const client = await getLsp();
        if (closing || expectedGeneration !== runtimeBootstrapGeneration) {
          await client.stop().catch(() => {});
          return;
        }
        await client.syncDocument(await lspDocument(controller!.snapshot()));
        await client.setDiagnostics(diagnosticsEnabled(controller!));
        scheduleLspSync();
      } catch (error) {
        if (!closing) process.stderr.write("Language assistance unavailable: " + errorMessage(error) + "\n");
      }
    };
    const bindWatcher = (path: string | null): void => {
      const generation = ++watcherGeneration;
      const previous = watcher;
      watcher = undefined;
      void previous?.close().catch(() => {});
      if (path === null || closing) {
        watcherReady = Promise.resolve();
        return;
      }
      const canonical = resolve(path);
      const sidecarPaths = (["config", "layout", "packages"] as const).map(kind => store!.sidecarPath(kind));
      const observedPaths = new Set([canonical, ...sidecarPaths]);
      const next = watch([...observedPaths], { ignoreInitial: true, persistent: true, followSymlinks: false });
      watcher = next;
      watcherReady = new Promise<void>(resolveReady => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolveReady();
        };
        next.once("ready", settle);
        next.once("error", settle);
      });
      next.on("all", (_event, changedPath) => {
        const resolvedChangedPath = resolve(changedPath);
        if (generation !== watcherGeneration || !observedPaths.has(resolvedChangedPath)) return;
        clearTimeout(sourceWatchTimer);
        sourceWatchTimer = setTimeout(() => {
          const previousRun = sourceWatchRunning ?? Promise.resolve();
          sourceWatchRunning = previousRun.catch(() => {}).then(async () => {
            if (closing || controller === undefined || store === undefined || isUntitled) return;
            const snapshot = controller.snapshot();
            await store.refreshObservations();
            const disk = sourceProtocolObservation(store);
            const sidecars = sidecarProtocolObservations(store, false);
            const unchanged = sameObservation(snapshot.disk, disk)
              && sameObservation(snapshot.sidecars.config, sidecars.config)
              && sameObservation(snapshot.sidecars.layout, sidecars.layout)
              && sameObservation(snapshot.sidecars.packages, sidecars.packages);
            if (unchanged) return;
            const request = { kind: "watcher" as const, expectedDocumentRevision: snapshot.documentRevision, operationId: randomUUID() };
            await controller.commitSource(request, async context => sourceCommit(request, context));
          }).catch(error => { if (!closing) controller?.recordActionError(errorMessage(error), "watcher_failed"); });
        }, 100);
      });
      next.on("error", error => { if (!closing) controller?.recordActionError(errorMessage(error), "watcher_failed"); });
    };
    unsubscribe = controller.subscribe(event => {
      if (event.type === "cell" || event.type === "notebook") scheduleLspSync();
      if (event.type === "runtime") {
        if (controller!.snapshot().runtime.kernelState !== "ready") {
          clearTimeout(lspSyncTimer);
          if (lsp || lspStarting) void invalidateLsp();
        } else scheduleLspSync();
      }
      if (event.type === "operation") scheduleIdle();
    });
    const scheduleIdle = (): void => {
      clearTimeout(idleTimer);
      if (clientCount !== 0 || leaseCount !== 0 || controller?.hasActiveOperations() === true || !everConnected || options.idleTimeout === 0 || closing) return;
      const activity = browserActivity;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        void (async () => {
          if (activity !== browserActivity || clientCount !== 0 || leaseCount !== 0 || controller?.hasActiveOperations() === true || closing) return;
          await close();
        })().catch(error => { if (!closing) controller!.recordActionError(errorMessage(error), "idle_close_failed"); });
      }, options.idleTimeout * 1000);
    };

    const serverOptions = {
      controller,
      host: "127.0.0.1",
      originHost: browserOriginHost,
      port: 0,
      externalOrigin: options.externalOrigin,
      tokenFile: options.tokenFile,
      session: {
        get sessionKey() { return ownership.sessionKey; },
        get canonicalPath() { return ownership.canonicalPath; },
        epoch: ownership.epoch,
        continuityProof: ownership.continuityProof,
        token: ownership.token,
        get recoveryId() { return recovery!.recoveryId; },
      },
      staticDir: options.resources.rendererDirectory,
      indexFile: join(options.resources.rendererDirectory, "index.html"),
      uploads,
      artifactStore,
      diagnostics,
      flushDiagnostics: () => diagnostics?.flush?.() ?? Promise.resolve(),
      mcpHandler: createMcpHttpHandler({ controller, artifactStore, runtimeReady: () => runtimeReady, onShutdown: close, diagnostics }),
      documentReady: true,
      lsp: {
        requestDocument: async (method: string, params: Record<string, unknown>, snapshot: unknown) => {
          const client = await getLsp();
          const result = await client.requestDocument(method, params, await lspDocument(snapshot as HostSnapshot));
          return method === "textDocument/hover" && isRecord(result) ? { ...result, rendered: renderHelp(result.contents as never).html } : result;
        },
        restart: async () => {
          if (lspRestarting) return lspRestarting;
          const generation = ++lspGeneration;
          const previous = lsp;
          const pending = lspStarting;
          lsp = undefined;
          let replacement!: Promise<LspClient>;
          replacement = (async () => {
            await previous?.stop();
            await pending?.catch(() => {});
            if (closing || generation !== lspGeneration) throw new Error("Language assistance restart was superseded");
            if (lspStarting === replacement) lspStarting = undefined;
            return getLsp();
          })();
          lspStarting = replacement;
          void replacement.then(
            () => { if (lspStarting === replacement) lspStarting = undefined; },
            () => { if (lspStarting === replacement) lspStarting = undefined; },
          );
          lspRestarting = replacement;
          try { await replacement; return { ok: true }; } finally { if (lspRestarting === replacement) lspRestarting = undefined; }
        },
      },
      acceptingLeases: () => closing === undefined,
      onClientCount: (count: number) => { clientCount = count; browserActivity++; if (count > 0) everConnected = true; scheduleIdle(); },
      onLeaseCount: (count: number) => { leaseCount = count; browserActivity++; if (count > 0) everConnected = true; scheduleIdle(); },
      onLastLeaseDiscard: discardAndClose,
      onBrowserActivity: () => { everConnected = true; browserActivity++; scheduleIdle(); },
      onCompromised: async (reason: string) => { controller!.recordActionError(reason, "session_compromised"); await close(); },
      onShutdown: close,
    };
    server = createAlderServer(serverOptions as Parameters<typeof createAlderServer>[0]);
    const address = await server.start();
    bindWatcher(isUntitled ? null : store.path);
    await watcherReady;
    const connectionOrigin = initialOrigin(address.host, address.port);
    await ownership.publishReady(connectionOrigin, { host: address.host, port: address.port, origin: connectionOrigin, browserOrigin: address.origin });
    startRuntime = (restart = false): void => {
      runtimeAbort?.abort();
      runtimeAbort = new AbortController();
      const bootstrapSignal = runtimeAbort.signal;
      const bootstrapGeneration = ++runtimeBootstrapGeneration;
      resetRuntimeReady();
      const resolveBootstrapReady = resolveRuntimeReady;
      const rejectBootstrapReady = rejectRuntimeReady;
      const bootstrapDirectory = notebookDirectory;
      const bootstrapUntitled = isUntitled;
      const runtimeStartedAt = performance.now();
      diagnostics?.record("info", restart ? "r.runtime.restart" : "r.runtime.start", { phase: "environment" });
      runtimeBootstrap = (async () => {
        let selected: REnvironment;
        let nextManager: PackageManager;
        try {
          selected = await resolveREnvironment({
            signal: bootstrapSignal,
            rscript: selectedRscript,
            projectDirectory: bootstrapDirectory,
            resources: options.resources,
            resolveProjectLibrary: base => resolveProjectLibrary(base, bootstrapDirectory),
          });
          diagnostics?.record("info", "r.environment.ready", {
            durationMs: Math.round(performance.now() - runtimeStartedAt), runtimeVersion: selected.version,
          });
          if (closing || bootstrapGeneration !== runtimeBootstrapGeneration || bootstrapUntitled !== isUntitled || bootstrapDirectory !== notebookDirectory) {
            rejectBootstrapReady(new Error("runtime bootstrap superseded"));
            return;
          }
          nextManager = new PackageManager({ resources: options.resources, environment: selected, processScope: processScope!, projectDirectory: bootstrapDirectory, onProgress: onPackageProgress });
          if (!restart) engine!.setEnvironment(selected);
        } catch (error) {
          if (closing || bootstrapGeneration !== runtimeBootstrapGeneration || bootstrapUntitled !== isUntitled || bootstrapDirectory !== notebookDirectory) {
            rejectBootstrapReady(new Error("runtime bootstrap superseded"));
            return;
          }
          runtimeError = error;
          diagnostics?.record("error", "r.runtime.failure", {
            phase: "environment", outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? "r_environment_failed",
          });
          controller!.recordRuntimeAvailabilityError(asRuntimeHostError(error)!);
          rejectBootstrapReady(error);
          return;
        }
        try {
          if (restart) await controller!.restartRuntimeContext({ environment: selected, notebookDirectory: bootstrapDirectory, cacheDirectory });
          else if (options.deferStartup) await controller!.startAnalyzer();
          else await controller!.start();
          engineIdentity = engine!.identity;
          const runtime = controller!.snapshot().runtime;
          diagnostics?.record("info", "r.runtime.ready", {
            durationMs: Math.round(performance.now() - runtimeStartedAt), analyzerState: runtime.analyzerState,
            kernelState: runtime.kernelState, executionReady: runtime.executionReady,
          });
        } catch (error) {
          diagnostics?.record("error", "r.runtime.failure", {
            phase: "startup", outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? "r_start_failed",
          });
          rejectBootstrapReady(error);
          await nextManager.close().catch(() => {});
          return;
        }
        if (closing || bootstrapGeneration !== runtimeBootstrapGeneration || bootstrapUntitled !== isUntitled || bootstrapDirectory !== notebookDirectory) {
          rejectBootstrapReady(new Error("runtime bootstrap superseded"));
          await nextManager.close().catch(() => {});
          return;
        }
        const previousManager = packageManager;
        packageManager = nextManager;
        runtimeEnvironment = selected;
        runtimeError = null;
        resolveBootstrapReady();
        await previousManager?.close();
        scheduleLspSync();
      })().catch(error => {
        if (closing) return;
        rejectBootstrapReady(error);
        controller!.recordRuntimeAvailabilityError(asRuntimeHostError(error)!);
      });
    };
    startRuntime();
    const ready = { type: "host.ready" as const, origin: address.origin, epoch: ownership.epoch, capabilities: [...(controller.snapshot().capabilities ?? [])] };
    diagnostics?.record("info", "host.ready", {
      sessionEpoch: ownership.epoch, durationMs: Math.round(performance.now() - hostStartedAt), ready: true,
    });
    scheduleLspSync();
    return {
      controller,
      engine,
      server,
      ownership,
      resources: options.resources,
      get runtimeEnvironment() { return runtimeEnvironment; },
      get engineIdentity() { return engine?.identity ?? engineIdentity; },
      ready,
      artifactDirectory: work,
      closed,
      close,
    };
  } catch (error) {
    diagnostics?.record("error", "host.fatal", {
      outcome: "error", errorCode: (error as { code?: string })?.code ?? "host_start_failed",
      errorType: error instanceof Error ? error.name : "unknown",
      durationMs: Math.round(performance.now() - hostStartedAt),
    });
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Alder startup and cleanup failed"); } throw error;
  }
}



async function createLsp(generation: number, currentGeneration: () => number, controller: Controller, engine: Engine, runtimeReady: () => Promise<void>, notebookDirectory: string, setLsp: (value: LspClient | undefined) => void, diagnostics?: DiagnosticSink): Promise<LspClient> {
  const startedAt = performance.now();
  diagnostics?.record("info", "lsp.start", {});
  await runtimeReady();
  const document = await lspDocument(controller.snapshot());
  const client = new LspClient({ document, cwd: notebookDirectory, connect: () => engine.connectArkLsp(), onFailure: message => controller.publishServiceError("lsp", { code: "lsp_unavailable", message }), onDiagnostics: (changed, diagnostics) => controller.publishEditorDiagnostics(changed.cells.map(cell => ({ id: cell.id, revision: cell.revision ?? 0, type: cell.type ?? "code", source: cell.body.join("\n") })), diagnostics) });
  try {
    await client.start();
    if (generation !== currentGeneration()) {
      await client.stop();
      throw new Error("Language assistance startup was superseded");
    }
    setLsp(client);
    controller.publishServiceError("lsp", null);
    diagnostics?.record("info", "lsp.ready", { durationMs: Math.round(performance.now() - startedAt), ready: true });
    return client;
  } catch (error) {
    diagnostics?.record("error", "lsp.failure", {
      outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? "lsp_unavailable",
      durationMs: Math.round(performance.now() - startedAt),
    });
    await client.stop().catch(() => {});
    throw error;
  }
}

function diagnosticsEnabled(controller: Controller): boolean { return (controller.snapshot().config.editor as Record<string, unknown> | undefined)?.live_diagnostics === true; }
function lspDocument(snapshot: HostSnapshot): Promise<NotebookDocument> { return Promise.resolve({ path: snapshot.path, cells: snapshot.cells.map(cell => ({ id: cell.id, type: cell.type, body: [...cell.body], revision: cell.revision, options: cell.options })) }); }
function cellRefId(value: unknown): string { if (isRecord(value) && typeof value.cellId === "string") return value.cellId; throw new Error("formatter returned an invalid cell reference"); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function decodePhysicalBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return Uint8Array.from(Buffer.from(value, "base64"));
  if (isRecord(value) && typeof value.$bytes === "string") return Uint8Array.from(Buffer.from(value.$bytes, "base64"));
  return null;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function initialOrigin(host: string, port: number): string { return "http://" + (host === "::1" ? "[::1]" : host) + ":" + port; }
