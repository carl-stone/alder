import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const RECOVERY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECORD_NAME = /^(?:cursor|draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/;
const MAX_BYTES = 256 * 1024 * 1024;
const fileName = (name: string): string => createHash("sha256").update(name).digest("hex") + ".json";
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export class DesktopRecoveryError extends Error {
  constructor(readonly code: "desktop_recovery_invalid" | "desktop_recovery_corrupt", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DesktopRecoveryError";
  }
}

/** Desktop-owned storage. Renderer requests identify records, never filesystem paths. */
export class NativeRecoveryStore {
  private readonly rootDir: string;
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(rootDir: string) { this.rootDir = resolve(rootDir); }

  private validKey(recoveryId: string): void {
    if (typeof recoveryId !== "string" || !RECOVERY_ID.test(recoveryId)) throw new DesktopRecoveryError("desktop_recovery_invalid", "Invalid recovery identity");
  }

  private async directory(recoveryId: string): Promise<string> {
    this.validKey(recoveryId);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    const directory = join(this.rootDir, recoveryId);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DesktopRecoveryError("desktop_recovery_invalid", "Invalid recovery directory");
    await chmod(directory, 0o700);
    return directory;
  }

  private validName(name: string): void {
    if (typeof name !== "string" || !RECORD_NAME.test(name)) throw new DesktopRecoveryError("desktop_recovery_invalid", "Invalid recovery record name");
  }

  private async readRecord(path: string): Promise<{ name: string; value: unknown } | null> {
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) throw new Error("Invalid recovery file");
      const record: unknown = JSON.parse(await handle.readFile("utf8"));
      if (typeof record !== "object" || record === null || !("name" in record) || !("value" in record)) throw new Error("Invalid recovery record");
      const name = record.name;
      if (typeof name !== "string" || !RECORD_NAME.test(name) || !path.endsWith("/" + fileName(name))) throw new Error("Recovery record name does not match");
      return { name, value: record.value };
    } catch (error) {
      throw new DesktopRecoveryError("desktop_recovery_corrupt", "A saved recovery record is damaged and has been retained.", error);
    } finally { await handle.close(); }
  }

  async read(recoveryId: string, name: string): Promise<unknown | null> {
    this.validName(name);
    const directory = await this.directory(recoveryId);
    return (await this.readRecord(join(directory, fileName(name))))?.value ?? null;
  }

  async listDrafts(recoveryId: string): Promise<{ draftIds: string[]; damaged: number }> {
    const directory = await this.directory(recoveryId);
    const draftIds: string[] = [];
    let damaged = 0;
    for (const entry of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      try {
        const record = await this.readRecord(join(directory, entry));
        if (record?.name.startsWith("draft:")) draftIds.push(record.name.slice("draft:".length));
      } catch (error) {
        if (!(error instanceof DesktopRecoveryError) || error.code !== "desktop_recovery_corrupt") throw error;
        damaged += 1;
      }
    }
    return { draftIds, damaged };
  }

  private enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.writes.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.writes.set(path, pending);
    void pending.finally(() => { if (this.writes.get(path) === pending) this.writes.delete(path); }).catch(() => {});
    return pending;
  }

  private async retainCorrupt(path: string, directory: string): Promise<void> {
    try { await this.readRecord(path); }
    catch (error) {
      if (!(error instanceof DesktopRecoveryError) || error.code !== "desktop_recovery_corrupt") throw error;
      await rename(path, join(directory, "corrupt-" + randomUUID() + ".json"));
      await syncDirectory(directory);
    }
  }

  async write(recoveryId: string, name: string, value: unknown): Promise<void> {
    this.validName(name);
    const text = JSON.stringify({ name, value });
    if (value === undefined || Buffer.byteLength(text) > MAX_BYTES) throw new DesktopRecoveryError("desktop_recovery_invalid", "Recovery record cannot be stored");
    this.validKey(recoveryId);
    const directory = join(this.rootDir, recoveryId);
    const path = join(directory, fileName(name));
    await this.enqueue(path, async () => {
      await this.directory(recoveryId);
      const temporary = join(directory, ".pending-" + randomUUID());
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
        await handle.close();
        await this.retainCorrupt(path, directory);
        await rename(temporary, path);
        await syncDirectory(directory);
      } finally {
        await handle.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
  }

  async remove(recoveryId: string, name: string): Promise<void> {
    this.validName(name);
    this.validKey(recoveryId);
    const directory = join(this.rootDir, recoveryId);
    const path = join(directory, fileName(name));
    await this.enqueue(path, async () => {
      await this.directory(recoveryId);
      await this.retainCorrupt(path, directory);
      await rm(path, { force: true });
      await syncDirectory(directory);
    });
  }

}
