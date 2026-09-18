import { createServer } from "node:net";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationPreferences } from "./preferences.js";
import { startHost, type RunningHost } from "./application.js";
import { resolveApplicationResources, type ApplicationResources } from "./resources.js";
import type { HostLaunchOptions } from "./sessions.js";

/** One backend owns desktop documents and outlives any one attached client. */
export class NotebookBackend {
  private readonly hosts = new Set<RunningHost>();
  private readonly preferences = ApplicationPreferences.open();
  private opening = 0;
  private readonly openings = new Map<string, Promise<void>>();
  get idle(): boolean { return this.hosts.size === 0 && this.opening === 0; }
  constructor(private readonly resources: ApplicationResources, private readonly onIdle = () => {}) {}

  async open(options: HostLaunchOptions): Promise<void> {
    if ([...this.hosts].some(host => host.ownership.sessionKey === options.sessionKey)) return;
    const pending = this.openings.get(options.sessionKey);
    if (pending) return pending;
    const opening = this.openNotebook(options).finally(() => this.openings.delete(options.sessionKey));
    this.openings.set(options.sessionKey, opening);
    return opening;
  }

  private async openNotebook(options: HostLaunchOptions): Promise<void> {
    this.opening++;
    try {
      const host = await startHost({
        path: options.path,
        externalOrigin: options.externalOrigin,
        tokenFile: options.tokenFile,
        resources: this.resources,
        preferences: await this.preferences,
        rscript: options.rscript,
        executionMode: options.executionMode,
        runOnStartup: options.runOnStartup,
        deferStartup: options.deferStartup ?? true,
        idleTimeout: 1,
        session: {
          sessionKey: options.sessionKey,
          runtimeDirectory: options.runtimeDirectory,
          projectDirectory: options.projectDirectory,
          ...(options.path === null ? { untitledRecoveryId: options.sessionKey } : {}),
        },
      });
      this.hosts.add(host);
      void host.closed.finally(() => { this.hosts.delete(host); if (this.idle) this.onIdle(); });
    } finally {
      this.opening--;
      if (this.idle) this.onIdle();
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.hosts].map(host => host.close()));
    await (await this.preferences).close();
  }
}

async function serve(socketPath: string): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let idleTimer: NodeJS.Timeout;
  const backend = new NotebookBackend(await resolveApplicationResources(root), () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (backend.idle) stop(); }, 1_000);
  });
  // Only this user's clients can reach the control socket. Notebook HTTP APIs
  // continue to use their own bearer tokens and isolated browser sessions.
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer(socket => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (backend.idle) stop(); }, 15_000);
    let input = "";
    socket.setTimeout(20_000, () => socket.destroy());
    socket.on("data", chunk => {
      input += String(chunk);
      if (input.length > 65_536) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        const request = JSON.parse(input.trim()) as { type: string; options: HostLaunchOptions };
        if (request.type === "open") {
          clearTimeout(idleTimer);
          await backend.open(request.options);
        } else if (request.type !== "ping") throw new Error("Unknown document service request");
        socket.end(JSON.stringify({ ok: true }) + "\n");
      })().catch(error => socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"));
    });
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    server.close();
    const deadline = setTimeout(() => process.exit(0), 5_000);
    void backend.close().finally(async () => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(socketPath, ready); });
  await chmod(socketPath, 0o600);
  idleTimer = setTimeout(() => { if (backend.idle) stop(); }, 15_000);
}

const socketPath = process.argv[2];
if (socketPath && process.argv[1]?.endsWith("alder-backend.mjs")) void serve(socketPath).catch(error => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
