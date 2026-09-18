import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import envPaths from "env-paths";
import lockfile from "proper-lockfile";
import type { ApplicationResources } from "./resources.js";
import type { HostLaunchOptions } from "./sessions.js";

/** A client of the shared service, never the owner of its lifetime. */
export class SharedBackend {
  private ready?: Promise<void>;
  private readonly socketPath: string;
  constructor(private readonly resources: Pick<ApplicationResources, "root" | "nodeExecutable" | "hostEntry">, runtimeDirectory?: string) {
    this.socketPath = join(runtimeDirectory ?? process.env.ALDER_RUNTIME_DIRECTORY ?? join(envPaths("alder").data, "runtime"), "backend.sock");
  }

  async open(options: HostLaunchOptions): Promise<void> {
    await (this.ready ??= this.start().finally(() => { this.ready = undefined; }));
    await this.request({ type: "open", options });
  }

  private async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.socketPath, {
      realpath: false, retries: { retries: 150, minTimeout: 50, maxTimeout: 100 },
    });
    try { await this.startLocked(); } finally { await release(); }
  }

  private async startLocked(): Promise<void> {
    try { await this.request({ type: "ping" }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    const child = spawn(this.resources.nodeExecutable, [join(dirname(this.resources.hostEntry), "alder-backend.mjs"), this.socketPath], {
      cwd: this.resources.root, detached: true, stdio: "ignore", env: process.env,
    });
    let launchError: Error | undefined;
    child.once("error", error => { launchError = error; });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      try { await this.request({ type: "ping" }); return; } catch { /* service is starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Alder's document service did not start. Rebuild the Mac application and try again.");
  }

  private request(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      let input = "";
      socket.setTimeout(15_000, () => socket.destroy(new Error("The document service did not respond.")));
      socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
      socket.on("data", chunk => {
        input += String(chunk);
        if (input.length > 65_536) socket.destroy(new Error("Invalid document service response"));
      });
      socket.once("error", reject);
      socket.once("end", () => {
        try {
          const result = JSON.parse(input);
          if (result.ok === true) resolve();
          else reject(new Error(result.error ?? "The document could not be opened."));
        } catch (error) { reject(error); }
      });
    });
  }
}
