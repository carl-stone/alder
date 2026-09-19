import { createServer } from "node:net";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationPreferences } from "./preferences.js";
import { startHost, type RunningHost } from "./application.js";
import { resolveApplicationResources, type ApplicationResources } from "./resources.js";
import type { BackendSessionDescriptor, HostLaunchOptions } from "./sessions.js";

/** One backend owns desktop documents and outlives any one attached client. */
export class NotebookBackend {
  private readonly hosts = new Map<string, RunningHost>();
  private readonly preferences = ApplicationPreferences.open();
  private opening = 0;
  private readonly openings = new Map<string, Promise<RunningHost>>();
  get idle(): boolean { return this.hosts.size === 0 && this.opening === 0; }
  constructor(private readonly resources: ApplicationResources, private readonly onIdle = () => {}) {}

  async open(options: HostLaunchOptions): Promise<BackendSessionDescriptor> {
    const key = options.path === null ? "untitled:" + options.sessionKey : "path:" + options.path;
    let host = this.hosts.get(key);
    if (host && host.ownership.canonicalPath !== options.path) { this.hosts.delete(key); host = undefined; }
    host ??= [...this.hosts.values()].find(item => item.ownership.canonicalPath === options.path && options.path !== null);
    if (!host) {
      let pending = this.openings.get(key);
      if (!pending) {
        pending = this.openNotebook(options).finally(() => this.openings.delete(key));
        this.openings.set(key, pending);
      }
      host = await pending;
    }
    if (host.ownership.canonicalPath !== null) {
      for (const [stored, value] of this.hosts) if (value === host && stored !== "path:" + host.ownership.canonicalPath) this.hosts.delete(stored);
      this.hosts.set("path:" + host.ownership.canonicalPath, host);
    }
    const token = options.tokenFile ? (await readFile(options.tokenFile, "utf8")).trim() : host.ownership.token;
    return {
      sessionKey: host.ownership.sessionKey,
      canonicalPath: host.ownership.canonicalPath,
      origin: host.ownership.origin,
      browserOrigin: host.ownership.browserOrigin,
      epoch: host.ownership.epoch,
      continuityProof: host.ownership.continuityProof,
      token,
      capabilities: [...(host.controller.snapshot().capabilities ?? [])],
    };
  }

  private async openNotebook(options: HostLaunchOptions): Promise<RunningHost> {
    this.opening++;
    try {
      const host = await startHost({
        path: options.path,
        externalOrigin: options.externalOrigin,
        tokenFile: options.tokenFile,
        resources: this.resources,
        preferences: await this.preferences,
        executionMode: options.executionMode,
        runOnStartup: options.runOnStartup,
        deferStartup: options.deferStartup ?? true,
        idleTimeout: 15,
        session: {
          sessionKey: options.sessionKey,
          projectDirectory: options.projectDirectory,
          ...(options.path === null ? { untitledRecoveryId: options.sessionKey } : {}),
        },
      });
      const key = host.ownership.canonicalPath === null ? "untitled:" + host.ownership.sessionKey : "path:" + host.ownership.canonicalPath;
      this.hosts.set(key, host);
      void host.closed.finally(() => {
        for (const [stored, value] of this.hosts) if (value === host) this.hosts.delete(stored);
        if (this.idle) this.onIdle();
      });
      return host;
    } finally {
      this.opening--;
      if (this.idle) this.onIdle();
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...new Set(this.hosts.values())].map(host => host.close()));
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
          const result = await backend.open(request.options);
          socket.end(JSON.stringify({ ok: true, result }) + "\n");
          return;
        } else if (request.type !== "ping") throw new Error("Unknown document service request");
        socket.end(JSON.stringify({ ok: true, result: null }) + "\n");
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
