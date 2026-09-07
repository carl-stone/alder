import { mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Controller } from './controller.js';
import { Engine } from './engine.js';
import { createAlderServer } from './server.js';
import { DocumentStore, FileConflict } from './services.js';
import { RJobs } from './jobs.js';
import { LspClient, type NotebookDocument } from './lsp.js';
import type { CellSnapshot, HostSnapshot } from './protocol.js';
import { createMcpServer, connectMcpStdio, drainMcpServer } from './mcp.js';
import { connectRemoteController } from './remote.js';
import { UploadStore } from './uploads.js';
import { startGallery } from './gallery.js';
import { DEFAULT_MAX_FRAME_BYTES, parseStrictJson } from './framing.js';

export const HOST_IDENTITY = Object.freeze({
  protocol: 1, hostVersion: '0.1.0', packageVersion: '0.1.0',
});

function reportFailure(error: unknown): void {
  process.stderr.write(`alder: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function runDetached(operation: () => unknown): void {
  void Promise.resolve().then(operation).catch(reportFailure);
}

const optionsSchema = z.object({
  path: z.string().min(1).nullable().default(null),
  host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8899),
  executionMode: z.enum(['automatic', 'lazy']).optional(),
  runOnStartup: z.boolean().optional(),
  sandbox: z.boolean().default(false),
  idleTimeout: z.number().nonnegative().finite().default(0),
  deferStartup: z.boolean().default(false),
  expectedSource: z.string().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  packagePath: z.string().optional(),
  rscript: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
}).strict();
export type HostOptions = z.input<typeof optionsSchema>;

export async function startHost(input: HostOptions) {
  const options = optionsSchema.parse(input);
  if (options.path !== null) return startNotebookHost({ ...options, path: options.path });
  if (options.sandbox) throw new Error('sandbox mode requires a notebook file path');
  const temporary = await mkdtemp(join(tmpdir(), 'alder-unsaved-'));
  try {
    const app = await startNotebookHost({ ...options, path: join(temporary, 'Untitled.R') }, true);
    const closed = app.closed.then(() => rm(temporary, { recursive: true, force: true }));
    return { ...app, closed, close: async () => {
      try { await app.close(); } finally { await closed; }
    } };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function startNotebookHost(input: HostOptions & { path: string }, unsaved = false) {
  const options = optionsSchema.parse(input);
  const packagePath = options.packagePath ?? process.env.ALDER_R_PACKAGE ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const notebookPath = await realpath(input.path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(resolve(input.path))), input.path.split(/[\\/]/).at(-1)!);
  });
  const notebookDirectory = unsaved ? process.cwd() : dirname(notebookPath);
  const projectLibrary = join(notebookDirectory, '.alder', 'library');
  const environment: NodeJS.ProcessEnv = { ...options.environment, ALDER_PROJECT_LIB: projectLibrary };
  if (options.sandbox) {
    const bootstrap = new RJobs({ rscript: options.rscript ?? process.env.ALDER_RSCRIPT ?? 'Rscript',
      packagePath, environment: options.environment });
    try {
      const sandbox = await bootstrap.run('sandbox.resolve', { path: notebookPath }) as { lib: string };
      delete environment.ALDER_PROJECT_LIB;
      environment.ALDER_SANDBOX_LIB = z.string().min(1).parse(sandbox.lib);
    } finally { await bootstrap.close(); }
  }
  const work = await mkdtemp(join(tmpdir(), 'alder-host-'));
  const uploads = new UploadStore(join(work, 'uploads'));
  const cacheDirectory = unsaved ? join(work, 'cache') : join(notebookDirectory, '.alder', 'cache');
  let engine: Engine;
  try {
    engine = new Engine({ rscript: options.rscript, packagePath, notebookDirectory,
      artifactDirectory: work, cacheDirectory, environment });
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
  const jobs = new RJobs({ rscript: options.rscript ?? process.env.ALDER_RSCRIPT ?? 'Rscript',
    packagePath, environment });
  let controller: Controller | undefined;
  let lsp: LspClient | undefined;
  let lspStarting: Promise<LspClient> | undefined;
  let lspRestarting: Promise<LspClient> | undefined;
  let lspGeneration = 0;
  let server: ReturnType<typeof createAlderServer> | undefined;
  let closing: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let lspSyncTimer: NodeJS.Timeout | undefined;
  let stopLspSync: (() => void) | undefined;
  let lspSyncRunning: Promise<void> | undefined;
  let everConnected = false;
  let clientCount = 0;
  let browserActivity = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = () => closing ??= (async () => {
    clearTimeout(idleTimer);
    clearTimeout(lspSyncTimer);
    stopLspSync?.();
    const errors: unknown[] = [];
    const attempt = async (operation: () => unknown) => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    // Stop admission and settle controller waits together: draining HTTP first
    // would wait forever on a request whose active R run is being shut down.
    const retiring = [attempt(() => server?.close()),
      attempt(() => controller ? controller.close() : engine.close()),
      attempt(() => jobs.close()),
      // Interrupt a language-server initialize/request before waiting for the
      // promise that owns it. Initialize otherwise carries a 30 second timeout.
      attempt(() => lsp?.stop())];
    await lspSyncRunning?.catch(() => {});
    await lspStarting?.catch(() => {});
    // getLsp may have passed its pre-construction closing check immediately
    // before shutdown began, so cover a client created after the first stop.
    await attempt(() => lsp?.stop());
    await Promise.all(retiring);
    await attempt(() => rm(work, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, 'Alder shutdown failed');
  })().finally(resolveClosed);
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const engineIdentity = await engine.start();
    const { store, notebook } = await DocumentStore.open(input.path, engine);
    if (unsaved) notebook.path = null;
    if (options.expectedSource !== undefined && !store.matchesSource(options.expectedSource)) throw new FileConflict();
    const config = await engine.service('config.resolve', {
      path: unsaved ? null : store.path, metadata: notebook.metadata,
    }) as Record<string, unknown>;
    const layout = await engine.service('layout.read', { path: store.path });
    controller = new Controller({
      engine, notebook, config, layout,
      deferStartup: options.deferStartup,
      executionMode: options.executionMode ?? config.on_cell_change as 'automatic' | 'lazy' | undefined,
      runOnStartup: options.runOnStartup ?? config.on_startup as boolean | undefined,
      services: {
        renderMarkdown: lines => store.renderMarkdown([...lines]),
        save: snapshot => {
          if (unsaved) throw Object.assign(new Error('notebook has no path'), { code: 'notebook_has_no_path' });
          return store.save(snapshot);
        },
        format: cells => store.format(cells.map(cell => ({ ...cell, body: [...cell.body] }))),
        service: (command, payload) => {
          if (command === 'source') return store.document(controller!.snapshot()).then(document => ({ text: (document as { text: string }).text }));
          if (command === 'upload.store') return uploads.store(payload.files);
          if (command === 'upload.remove') return uploads.remove(z.string().parse(payload.uploadId));
          if (unsaved && ['config.update', 'layout.update'].includes(command)) {
            throw Object.assign(new Error('configuration requires a notebook path'), { code: 'notebook_has_no_path' });
          }
          if (command === 'config.update') return store.updateConfig(payload.config as Record<string, unknown>);
          if (command === 'layout.update') return store.updateLayout(payload.layout);
          if (command === 'app.update') return engine.service('app.validate', payload).then(app => ({ app }));
          if (['packages.status', 'packages.declare', 'packages.install'].includes(command)) {
            const packages = payload.packages === undefined ? [] : z.array(z.string()).parse(payload.packages);
            return jobs.run(command, { packages, path: unsaved ? notebookDirectory : store.path, metadata: controller!.snapshot().metadata });
          }
          if (command === 'publish') {
            const engineName = z.enum(['pandoc', 'quarto']).parse(payload.engine);
            const filename = `publish-${randomUUID()}.html`;
            return jobs.run('publish', { engine: engineName, state: controller!.snapshot(),
              include_code: payload.include_code === true, artifact_dir: work, out: join(work, filename),
            }).then(() => ({ engine: engineName, artifact: filename, url: `/download/${filename}` }));
          }
          if (command === 'export') {
            const format = z.enum(['html', 'md', 'script', 'ipynb', 'qmd', 'session']).parse(payload.format);
            const extension = format === 'script' ? 'R' : format === 'session' ? 'json' : format;
            const filename = `export-${randomUUID()}.${extension}`;
            return jobs.run('export', { format, state: controller!.snapshot(),
              include_code: payload.include_code === true, artifact_dir: work,
              out: join(work, filename),
            }).then(() => ({ format, artifact: filename, url: `/download/${filename}` }));
          }
          return engine.service(command, payload);
        },
      },
    });
    await controller.start();
    const documentSources = (document: NotebookDocument): CellSnapshot[] => document.cells.map(cell => ({
      id: cell.id, revision: cell.revision!, type: cell.type ?? 'code', source: cell.body.join('\n'),
    }));
    const documentFor = async (snapshot: HostSnapshot): Promise<NotebookDocument> => {
      const document = await store.document(snapshot) as NotebookDocument;
      const cells = new Map(snapshot.cells.map(cell => [cell.id, cell]));
      if (unsaved) document.path = null;
      document.cells = document.cells.map(cell => ({ ...cell,
        revision: cells.get(cell.id)!.revision, type: cells.get(cell.id)!.type,
      }));
      return document;
    };
    let liveDiagnostics = (config.editor as Record<string, unknown> | undefined)?.live_diagnostics === true;
    const diagnosticsEnabled = () => liveDiagnostics;
    const createLsp = async (generation: number): Promise<LspClient> => {
        if (closing) throw new Error('Application host is closing');
        const document = await documentFor(controller!.snapshot());
        if (closing || generation !== lspGeneration) throw new Error('Language assistance startup was superseded');
        const lspEnvironment = { ...process.env, ...environment };
        lspEnvironment.R_LIBS = [dirname(packagePath), lspEnvironment.R_LIBS]
          .filter(Boolean).join(delimiter);
        delete lspEnvironment.R_HOME;
        const client = new LspClient({
          command: options.rscript ?? process.env.ALDER_RSCRIPT ?? 'Rscript',
          args: ['--vanilla', '-e',
            'suppressPackageStartupMessages(library(alder)); invisible(loadNamespace("languageserver")); invisible(alder:::alder_host_apply_library_policy()); languageserver::run()'],
          cwd: notebookDirectory, env: lspEnvironment, document,
          diagnostics: diagnosticsEnabled(),
          onFailure: message => {
            if (!closing && generation === lspGeneration && lsp === client) {
              controller!.publishServiceError('lsp', { code: 'lsp_unavailable', message });
            }
          },
          onDiagnostics: (document, diagnostics) => {
            if (!closing && generation === lspGeneration && lsp === client) {
              controller!.publishEditorDiagnostics(documentSources(document), diagnostics);
            }
          },
        });
        lsp = client;
        try {
          const started = await client.start();
          if (closing || generation !== lspGeneration || lsp !== client) {
            await client.stop();
            throw new Error('Language assistance startup was superseded');
          }
          controller!.publishServiceError('lsp', null);
          return started;
        } catch (error) {
          if (!closing && generation === lspGeneration && lsp === client) {
            controller!.publishServiceError('lsp', {
              code: 'lsp_unavailable',
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
    };
    const getLsp = () => {
      if (lspStarting) return lspStarting;
      const generation = ++lspGeneration;
      lspStarting = createLsp(generation);
      return lspStarting;
    };
    // Optional linting follows source edits independently and stays off the
    // required analysis/Run path. Coalesce typing before asking the R codec.
    const scheduleLspSync = () => {
      clearTimeout(lspSyncTimer);
      if (closing || (!lspStarting && !diagnosticsEnabled())) return;
      lspSyncTimer = setTimeout(() => {
        const previous = lspSyncRunning ?? Promise.resolve();
        lspSyncRunning = previous.catch(() => {}).then(async () => {
          if (closing) return;
          const client = await getLsp();
          if (closing) return;
          // Explicit help synchronizes its own exact source. Background source
          // work is needed only for live diagnostics, not an abandoned popup.
          if (diagnosticsEnabled()) {
            const document = await documentFor(controller!.snapshot());
            if (closing) return;
            await client.syncDocument(document);
          }
          await client.setDiagnostics(diagnosticsEnabled());
        }).catch(error => {
          if (!closing) process.stderr.write(`Language assistance unavailable: ${String(error)}\n`);
        });
      }, 150);
    };
    const knownRevisions = new Map(controller.snapshot().cells.map(cell => [cell.id, cell.revision]));
    stopLspSync = controller.subscribe(event => {
      if (event.type === 'cell' && event.cellId && event.revision !== undefined) {
        if (knownRevisions.get(event.cellId) === event.revision) return;
        knownRevisions.set(event.cellId, event.revision);
        scheduleLspSync();
      } else if (event.type === 'notebook') {
        const change = event.payload as Record<string, unknown>;
        if (typeof change.deleted === 'string') knownRevisions.delete(change.deleted);
        if (change.config) {
          const editor = (change.config as Record<string, unknown>).editor as Record<string, unknown> | undefined;
          liveDiagnostics = editor?.live_diagnostics === true;
        }
        if (['order', 'metadata', 'saved', 'app', 'config'].some(key => key in change)) scheduleLspSync();
      }
    }, ["cell", "notebook"]);
    scheduleLspSync();
    const scheduleIdle = () => {
      clearTimeout(idleTimer);
      if (clientCount !== 0 || !everConnected || options.idleTimeout === 0 || closing) return;
      const activity = browserActivity;
      idleTimer = setTimeout(() => {
        void (async () => {
          if (controller!.snapshot().changed) {
            await controller!.dispatch({ type: 'save', operationId: randomUUID(), sessionEpoch: controller!.epoch });
          }
          // Saving is asynchronous. A reconnect or newer acknowledged edit
          // during that save must get another full idle period.
          if (activity !== browserActivity || clientCount !== 0 || closing) return;
          if (controller!.snapshot().changed) { scheduleIdle(); return; }
          await close();
        })().catch(error => {
          const message = `Automatic idle shutdown is paused because Alder could not save notebook: ${String(error)}`;
          controller!.recordActionError(message, 'idle_save_failed');
          process.stderr.write(`${message}\n`);
        });
      }, options.idleTimeout * 1000);
    };
    server = createAlderServer({
      controller, host: options.host, port: options.port,
      staticDir: join(packagePath, 'app', 'static'), artifactDir: work,
      allowedOrigins: options.allowedOrigins,
      onClientCount: count => {
        clientCount = count;
        browserActivity++;
        if (count > 0) everConnected = true;
        scheduleIdle();
      },
      onBrowserActivity: () => {
        everConnected = true;
        browserActivity++;
        scheduleIdle();
      },
      lsp: {
        requestDocument: async (method, params, snapshot) => {
          const client = await getLsp();
          const document = await documentFor(snapshot as HostSnapshot);
          try {
            const result = await client.requestDocument(method, params, document);
            if (method === 'textDocument/hover' && result && typeof result === 'object' && !Array.isArray(result)) {
              const hover: Record<string, unknown> = { ...result as Record<string, unknown>, rendered: '' };
              const maxHoverBytes = 8 * 1024 * 1024;
              if (Buffer.byteLength(JSON.stringify(hover)) > maxHoverBytes) {
                throw new Error('R documentation exceeds the 8 MiB display limit');
              }
              // Render with the package sanitizer independently of a busy kernel.
              const rendered = await engine.service('help.render', { contents: hover.contents })
                .then(value => z.string().parse(value))
                .catch(() => '');
              const response = { ...hover, rendered };
              return Buffer.byteLength(JSON.stringify(response)) <= maxHoverBytes ? response : hover;
            }
            return result;
          }
          finally { scheduleLspSync(); }
        },
        restart: async () => {
          if (lspRestarting) {
            await lspRestarting;
            return { ok: true };
          }
          const previous = lsp;
          const pending = lspStarting;
          const generation = ++lspGeneration;
          lsp = undefined;
          const replacement = (async () => {
            await previous?.stop();
            await pending?.catch(() => {});
            if (closing || generation !== lspGeneration) {
              throw new Error('Language assistance restart was superseded');
            }
            return createLsp(generation);
          })();
          lspStarting = replacement;
          lspRestarting = replacement;
          try {
            await replacement;
            return { ok: true };
          } finally {
            if (lspRestarting === replacement) lspRestarting = undefined;
          }
        },
      },
      onShutdown: close,
    });
    await server.start();
    return { controller, engine, engineIdentity, server, close, closed, artifactDirectory: work };
  } catch (error) {
    try { await close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Alder startup and cleanup failed');
    }
    throw error;
  }
}

export async function readHostConfiguration(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > DEFAULT_MAX_FRAME_BYTES) {
      throw new Error('Host configuration must be a regular file of at most 8 MiB');
    }
    // Read a bounded extra byte, so a file growing after stat cannot evade the cap.
    const bytes = Buffer.alloc(DEFAULT_MAX_FRAME_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > DEFAULT_MAX_FRAME_BYTES) throw new Error('Host configuration exceeds 8 MiB');
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await file.close(); }
}

async function main(): Promise<void> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 24 || (major === 24 && minor! < 20)) {
    throw new Error('Alder requires Node 24.20.0 or newer; use the packaged runtime or set ALDER_NODE');
  }
  const { values } = parseArgs({ options: {
    'host-info': { type: 'boolean' }, config: { type: 'string' },
    notebook: { type: 'string' }, port: { type: 'string' },
    host: { type: 'string' }, lazy: { type: 'boolean' },
    mcp: { type: 'boolean' },
    url: { type: 'string' },
    'no-run': { type: 'boolean' },
  } });
  if (values['host-info']) {
    process.stdout.write(`${JSON.stringify(HOST_IDENTITY)}\n`);
    return;
  }
  if (values.url) {
    if (!values.mcp || values.notebook || values.config) throw new Error('--url requires --mcp and cannot be combined with a local notebook');
    const remote = await connectRemoteController(values.url);
    const mcp = createMcpServer({ controller: remote });
    const transport = await connectMcpStdio(mcp);
    const onclose = transport.onclose;
    transport.onclose = () => runDetached(async () => {
      try { onclose?.(); } finally { await remote.close(); }
    });
    process.once('SIGTERM', () => runDetached(() => mcp.close().finally(() => remote.close())));
    process.once('SIGINT', () => runDetached(() => mcp.close().finally(() => remote.close())));
    process.stdin.once('end', () => runDetached(() =>
      drainMcpServer(mcp).finally(() => mcp.close()).finally(() => remote.close())));
    return;
  }
  let input: unknown;
  if (values.config) input = await readHostConfiguration(values.config);
  else input = {
    path: values.notebook, host: values.host,
    port: values.port === undefined ? undefined : Number(values.port),
    executionMode: values.lazy ? 'lazy' : undefined,
    runOnStartup: values['no-run'] ? false : undefined,
    deferStartup: values.mcp === true,
  };
  const parsed = optionsSchema.parse(input);
  if (parsed.path && await stat(parsed.path).then(info => info.isDirectory(), () => false)) {
    if (values.mcp) throw new Error('MCP requires a notebook file path');
    const gallery = await startGallery({ ...parsed, path: parsed.path,
      packagePath: parsed.packagePath ?? process.env.ALDER_R_PACKAGE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    }, startHost);
    const shutdown = () => runDetached(() => gallery.close());
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    if (values.config) { process.stdin.resume(); process.stdin.once('end', shutdown); }
    runDetached(() => gallery.closed.then(() => process.stdin.pause()));
    process.stdout.write(`${JSON.stringify({ type: 'host.ready', ...HOST_IDENTITY,
      address: gallery.server.address(), epoch: gallery.epoch, gallery: true,
    })}\n`);
    return;
  }
  const app = await startHost({ ...parsed, deferStartup: values.mcp === true || parsed.deferStartup });
  runDetached(() => app.closed.then(() => process.stdin.pause()));
  const shutdown = () => runDetached(() => app.close());
  // R owns its child through stdin. A parent crash must retire the notebook processes.
  if (values.config && !values.mcp) {
    process.stdin.resume();
    process.stdin.once('end', shutdown);
  }
  if (values.mcp) {
    const mcp = createMcpServer({ controller: app.controller });
    const transport = await connectMcpStdio(mcp);
    const onclose = transport.onclose;
    transport.onclose = () => runDetached(async () => {
      try { onclose?.(); } finally { await app.close(); }
    });
    const shutdownMcp = () => runDetached(() => mcp.close().finally(() => app.close()));
    process.once('SIGINT', shutdownMcp);
    process.once('SIGTERM', shutdownMcp);
    process.stdin.once('end', () => runDetached(() =>
      drainMcpServer(mcp).finally(() => mcp.close()).finally(() => app.close())));
  } else {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdout.write(`${JSON.stringify({ type: 'host.ready', ...HOST_IDENTITY,
      address: app.server.address(), epoch: app.controller.snapshot().epoch,
      artifactDirectory: app.artifactDirectory, engine: app.engineIdentity,
    })}\n`);
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main().catch(reportFailure);
