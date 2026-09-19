import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import {
  AtomicWriteConflictError, MAX_YAML_BYTES, preferencesPath, parseYamlMapping,
  writeAtomicText, type DiskObservation,
} from "./configuration.js";
import {
  mergePreferences, preferenceDefaults, storedPreferencesPatchSchema,
  type Preferences, type StoredPreferencesPatch,
} from "./settings.js";

export interface PreferencesSnapshot {
  readonly values: Preferences;
  readonly version: string | null;
  readonly path: string;
  readonly error: { code: string; message: string } | null;
}

interface PreferencesFile {
  observation: DiskObservation;
  values?: Preferences;
  error: PreferencesSnapshot["error"];
}

class PreferencesFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreferencesFileError";
  }
}

async function readPreferences(path: string): Promise<PreferencesFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let observation: DiskObservation = { state: "unreadable", digest: null, version: null };
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("the destination is not a regular file");
    if (info.size > MAX_YAML_BYTES) throw new Error(`file exceeds the ${MAX_YAML_BYTES}-byte limit`);
    const bytes = await handle.readFile();
    const digest = createHash("sha256").update(bytes).digest("hex");
    const identity = `${info.dev}:${info.ino}`;
    const mode = info.mode & 0o777;
    observation = {
      state: "present", digest, version: `${identity}:${mode.toString(8)}:${digest}`,
      identity, mode, inode: info.ino, mtimeMs: info.mtimeMs, size: bytes.byteLength,
    };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const patch = storedPreferencesPatchSchema.parse(parseYamlMapping(text, path));
    return { observation, values: mergePreferences(preferenceDefaults(), patch), error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        observation: { state: "absent", digest: null, version: null },
        values: preferenceDefaults(), error: null,
      };
    }
    return {
      observation,
      error: {
        code: "config_invalid",
        message: `Cannot read application preferences at ${path}. Fix this file and try again: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    await handle?.close();
  }
}

/** One shared owner; values are published only after their file is replaced. */
export class ApplicationPreferences {
  private values = preferenceDefaults();
  private version: string | null = null;
  private error: PreferencesSnapshot["error"] = null;
  private pending = Promise.resolve();
  private readonly listeners = new Set<(snapshot: PreferencesSnapshot) => void>();

  private constructor(private readonly path: string) {}

  static async open(path = preferencesPath()): Promise<ApplicationPreferences> {
    const preferences = new ApplicationPreferences(path);
    const file = await readPreferences(path);
    preferences.accept(file);
    return preferences;
  }

  snapshot(): PreferencesSnapshot {
    return {
      values: structuredClone(this.values), version: this.version, path: this.path,
      error: this.error === null ? null : { ...this.error },
    };
  }

  subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: StoredPreferencesPatch, expectedVersion: string | null): Promise<PreferencesSnapshot> {
    const changes = structuredClone(patch);
    const operation = this.pending.then(() => this.write(changes, expectedVersion));
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    await this.pending;
    this.listeners.clear();
  }

  private accept(file: PreferencesFile): void {
    if (file.values !== undefined) this.values = file.values;
    this.version = file.observation.version;
    this.error = file.error;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      // A subscriber cannot turn a completed disk write into a failed command.
      try { listener(this.snapshot()); } catch { /* Other subscribers still receive the update. */ }
    }
  }

  private async write(patch: StoredPreferencesPatch, expectedVersion: string | null): Promise<PreferencesSnapshot> {
    const current = await readPreferences(this.path);
    if (current.error !== null) {
      this.accept(current);
      this.notify();
      throw new PreferencesFileError(current.error.code, current.error.message);
    }
    if (current.observation.version !== this.version) {
      const previousVersion = this.version;
      this.accept(current);
      this.notify();
      throw new AtomicWriteConflictError(this.path, previousVersion, current.observation);
    }
    if (expectedVersion !== this.version) {
      throw new AtomicWriteConflictError(this.path, expectedVersion, current.observation);
    }

    const next = mergePreferences(current.values!, patch);
    try {
      const observation = await writeAtomicText(this.path, stringifyYaml(next, { sortMapEntries: true }), {
        expected: current.observation,
      });
      if (observation.state !== "present") throw new Error("cannot read the saved preferences file");
      this.values = next;
      this.version = observation.version;
      this.error = null;
    } catch (error) {
      if (error instanceof AtomicWriteConflictError) throw error;
      this.error = {
        code: "preferences_write_failed",
        message: `Cannot save application preferences to ${this.path}. Check that the folder is writable and try again: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.notify();
      throw new PreferencesFileError(this.error.code, this.error.message);
    }
    this.notify();
    return this.snapshot();
  }
}
