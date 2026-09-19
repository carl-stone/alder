import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import envPaths from "env-paths";
import { parseDocument as parseYamlDocument, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { NotebookDocument } from "./notebook.js";
import {
  notebookSettingsPatchSchema, projectSettingsPatchSchema,
  type NotebookSettingsPatch, type ProjectSettingsPatch,
} from "./settings.js";

export const MAX_YAML_BYTES = 1024 * 1024;

export class ConfigError extends Error {
  readonly code = "config_invalid" as const;
  constructor(readonly key: string, message: string) {
    super(`config_invalid: ${key}: ${message}`);
    this.name = "ConfigError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ensureStringPath(path: string | null | undefined): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new ConfigError("path", "must be a non-empty path");
  }
  return path;
}

export function alderPaths(): ReturnType<typeof envPaths> {
  return envPaths("alder", { suffix: "" });
}

export function preferencesPath(): string {
  return join(alderPaths().config, "preferences.yaml");
}

export function projectConfigPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const directory = path.endsWith("/") ? path : dirname(path);
  return join(directory, ".alder", "config.yaml");
}

const mappingSchema = z.record(z.string(), z.unknown());

/** Standard YAML parsing shared by settings, notebook headers and packages. */
export function parseYamlMapping(text: string, kind: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_YAML_BYTES) {
    throw new ConfigError(kind, `YAML document exceeds the ${MAX_YAML_BYTES}-byte limit`);
  }
  let parsed: unknown;
  try {
    if (text.trim() === "") return {};
    const document = parseYamlDocument(text, { strict: true });
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem !== undefined) throw problem;
    parsed = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new ConfigError(kind, `malformed YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mapping = mappingSchema.safeParse(parsed);
  if (!mapping.success) throw new ConfigError(kind, "YAML root must be a mapping");
  return mapping.data;
}

export async function readProjectSettings(path: string | null | undefined): Promise<ProjectSettingsPatch> {
  if (path === null || path === undefined) return {};
  const file = ensureStringPath(path);
  try {
    const bytes = await readFile(file);
    const value = parseYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(bytes), file);
    return projectSettingsPatchSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(file, `cannot read project settings; fix this file and try again: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function serializeProjectSettings(value: ProjectSettingsPatch): string {
  return stringifyYaml(value, { sortMapEntries: true });
}

function metadataMapping(value: unknown, name: string): Record<string, unknown> {
  const result = mappingSchema.safeParse(value);
  if (!result.success) throw new ConfigError(name, "must be a mapping");
  return result.data;
}

/** Read only owned settings; authored extension fields stay in the document. */
export function readNotebookSettings(metadata: unknown): NotebookSettingsPatch {
  if (metadata === null || metadata === undefined) return {};
  const root = metadataMapping(metadata, "metadata");
  if (root.runtime === null || root.runtime === undefined) return {};
  const runtime = metadataMapping(root.runtime, "runtime");
  const known: Record<string, unknown> = {};
  for (const key of ["on_cell_change", "on_startup"] as const) {
    if (Object.hasOwn(runtime, key)) known[key] = runtime[key];
  }
  if (Object.hasOwn(runtime, "cache")) {
    const cache = metadataMapping(runtime.cache, "runtime.cache");
    if (Object.hasOwn(cache, "enabled")) known.cache = { enabled: cache.enabled };
  }
  const parsed = notebookSettingsPatchSchema.safeParse(known);
  if (!parsed.success) throw new ConfigError("runtime", parsed.error.message);
  return parsed.data;
}

export function setNotebookSettings<T extends Pick<NotebookDocument, "metadata">>(notebook: T, patch: NotebookSettingsPatch): T {
  const metadata: Record<string, unknown> = structuredClone(notebook.metadata ?? {});
  const runtime = metadata.runtime == null ? {} : metadataMapping(metadata.runtime, "runtime");
  metadata.runtime = {
    ...runtime,
    ...(patch.on_cell_change === undefined ? {} : { on_cell_change: patch.on_cell_change }),
    ...(patch.on_startup === undefined ? {} : { on_startup: patch.on_startup }),
    ...(patch.cache === undefined ? {} : {
      cache: { ...(runtime.cache == null ? {} : metadataMapping(runtime.cache, "runtime.cache")), ...patch.cache },
    }),
  };
  return { ...notebook, metadata };
}

/**
 * A bounded observation used by sidecar writers. Callers can provide their
 * own observation hook when they already own the persistence identity.
 */
export interface DiskObservation {
  readonly state: "absent" | "present" | "unreadable";
  readonly digest: string | null;
  readonly version: string | null;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly inode?: number;
  readonly identity?: string | null;
  readonly mode?: number;
}

export interface AtomicWriteOptions {
  readonly expected?: DiskObservation | string | null;
  readonly expectedDigest?: string | null;
  readonly expectedVersion?: string | null;
  readonly observe?: (path: string) => Promise<DiskObservation>;
  readonly beforeReplace?: (path: string, current: DiskObservation, expected: DiskObservation | string | null | undefined) => Promise<void> | void;
}

export class AtomicWriteConflictError extends Error {
  readonly code = "source_conflict" as const;
  readonly path: string;
  readonly expected: DiskObservation | string | null | undefined;
  readonly actual: DiskObservation;

  constructor(path: string, expected: DiskObservation | string | null | undefined, actual: DiskObservation) {
    super(`source_conflict: sidecar changed while writing \`${path}\``);
    this.name = "AtomicWriteConflictError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

export async function observeFile(path: string): Promise<DiskObservation> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { state: "unreadable", digest: null, version: null };
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const inode = typeof info.ino === "number" ? info.ino : undefined;
    const identity = inode === undefined ? null : `${info.dev}:${inode}`;
    const mode = info.mode & 0o777;
    const version = `${identity ?? ""}:${mode.toString(8)}:${digest}`;
    return { state: "present", digest, version, size: info.size, mtimeMs: info.mtimeMs, inode, identity, mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", digest: null, version: null };
    }
    return { state: "unreadable", digest: null, version: null };
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function expectedObservation(options: AtomicWriteOptions): DiskObservation | string | null | undefined {
  if (Object.hasOwn(options, "expected")) return options.expected;
  if (Object.hasOwn(options, "expectedVersion")) return options.expectedVersion;
  if (Object.hasOwn(options, "expectedDigest")) return options.expectedDigest;
  return undefined;
}

function observationsEqual(
  actual: DiskObservation,
  expected: DiskObservation | string | null | undefined,
): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual.state === "absent";
  if (typeof expected === "string") {
    return actual.digest === expected || actual.version === expected;
  }
  if (expected.state !== actual.state) return false;
  if (expected.digest !== undefined && expected.digest !== actual.digest) return false;
  if (expected.version !== undefined && expected.version !== actual.version) return false;
  if (expected.identity !== undefined && expected.identity !== actual.identity) return false;
  if (expected.mode !== undefined && expected.mode !== actual.mode) return false;
  return true;
}

/** Same-directory staged write with optional identity preconditions/hooks. */
export async function writeAtomicText(path: string, text: string, options: AtomicWriteOptions = {}): Promise<DiskObservation> {
  const file = ensureStringPath(path);
  const parent = dirname(file);
  const observe = options.observe ?? observeFile;
  const expected = expectedObservation(options);
  const initial = await observe(file);
  if (!observationsEqual(initial, expected)) throw new AtomicWriteConflictError(file, expected, initial);

  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.alder-write-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const mode = initial.mode ?? 0o600;
    handle = await open(temporary, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await observe(file);
    if (!observationsEqual(current, expected)) throw new AtomicWriteConflictError(file, expected, current);
    await options.beforeReplace?.(file, current, expected);
    const beforeRename = await observe(file);
    if (!observationsEqual(beforeRename, expected)) throw new AtomicWriteConflictError(file, expected, beforeRename);
    await rename(temporary, file);
    await syncDirectory(parent);
    return await observe(file);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Minimal layout-path error declaration shared without importing layout.ts. */
export class LayoutPathError extends Error {
  readonly code = "invalid_layout" as const;
  constructor(message: string) {
    super(message);
    this.name = "LayoutPathError";
  }
}

/** Kept private to configuration's implementation; exported for layout.ts. */
export function requireNotebookPath(path: string | null | undefined): string {
  if (path === null || path === undefined || path.length === 0) {
    const error = new Error("notebook has no path") as Error & { code?: string };
    error.code = "notebook_has_no_path";
    throw error;
  }
  return ensureStringPath(path);
}

export function notebookBasename(path: string): string {
  return basename(path);
}

export interface AppConfig {
  readonly layout: "vertical" | "grid" | "slides";
  readonly width: "compact" | "medium" | "full";
  readonly include_code: boolean;
}

export const appDefaults: AppConfig = { layout: "vertical", width: "medium", include_code: false };

const appLayoutSchema = z.enum(["vertical", "grid", "slides"]);
const appWidthSchema = z.enum(["compact", "medium", "full"]);
const appUpdateSchema = z.object({
  layout: appLayoutSchema,
  width: appWidthSchema,
  include_code: z.boolean(),
}).strict().partial();

export class AppConfigError extends Error {
  readonly code = "invalid_request" as const;
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

function appRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AppConfigError(message);
  return value as Record<string, unknown>;
}

/** Validate app metadata while retaining fields written by newer clients. */
export function validateAppMetadata(metadata: unknown): Record<string, unknown> {
  const record = metadata === null || metadata === undefined ? {} : appRecord(metadata, "notebook metadata must be a named mapping");
  const appValue = record.app;
  if (appValue === null || appValue === undefined) return {};
  const app = appRecord(appValue, "app metadata must be a named mapping");
  if (Object.hasOwn(app, "layout")) {
    const parsed = appLayoutSchema.safeParse(app.layout);
    if (!parsed.success) throw new AppConfigError("layout must be one of vertical, grid, slides");
  }
  if (Object.hasOwn(app, "width")) {
    const parsed = appWidthSchema.safeParse(app.width);
    if (!parsed.success) throw new AppConfigError("width must be one of compact, medium, full");
  }
  if (Object.hasOwn(app, "include_code") && typeof app.include_code !== "boolean") {
    throw new AppConfigError("include_code must be a scalar logical");
  }
  return clone(app);
}

/** Validate a non-empty partial app update. */
export function validateAppUpdate(updates: unknown): Partial<AppConfig> {
  const record = appRecord(updates, "app updates must be a non-empty mapping with unique keys");
  if (Object.keys(record).length === 0) throw new AppConfigError("app updates must be a non-empty mapping with unique keys");
  const parsed = appUpdateSchema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys" && issue.keys[0]) throw new AppConfigError("unknown app key: " + issue.keys[0]);
    const key = issue?.path[0] ? String(issue.path[0]) : "app";
    throw new AppConfigError(key + " is invalid");
  }
  return parsed.data as Partial<AppConfig>;
}

/** Published-notebook presentation belongs to notebook metadata. */
export function appConfig(notebook: Pick<NotebookDocument, "metadata">): AppConfig {
  const app = validateAppMetadata(notebook.metadata);
  return {
    layout: (app.layout as AppConfig["layout"] | undefined) ?? appDefaults.layout,
    width: (app.width as AppConfig["width"] | undefined) ?? appDefaults.width,
    include_code: (app.include_code as boolean | undefined) ?? appDefaults.include_code,
  };
}

/** Apply an app update to raw authored metadata, retaining unknown fields and omitted defaults. */
export function setAppConfig<T extends Pick<NotebookDocument, "metadata">>(notebook: T, updates: unknown): T {
  const checked = validateAppUpdate(updates);
  const metadata = appRecord(notebook.metadata ?? {}, "notebook metadata must be a named mapping");
  const app = validateAppMetadata(metadata);
  const nextMetadata = clone(metadata);
  nextMetadata.app = { ...app, ...checked };
  return { ...notebook, metadata: nextMetadata } as T;
}

/** Return a deterministic app title from metadata, notebook path, or fallback. */
export function appTitle(notebook: Pick<NotebookDocument, "path" | "metadata">): string {
  const metadata = notebook?.metadata;
  const title = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).title
    : undefined;
  if (typeof title === "string" && title.trim().length > 0) return title;
  if (typeof notebook?.path === "string" && notebook.path.length > 0) {
    const name = basename(notebook.path).replace(/\.[^./\\]+$/, "");
    if (name.length > 0) return name;
  }
  return "Untitled notebook";
}

/** Return the first Markdown cell's compact, bounded description. */
export function appDescription(notebook: Pick<NotebookDocument, "cells">): string {
  const cells = notebook?.cells;
  if (!Array.isArray(cells)) return "";
  const markdown = cells.find((cell) => {
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return false;
    return (cell as Record<string, unknown>).type === "markdown";
  });
  if (markdown === undefined || markdown === null || typeof markdown !== "object" || Array.isArray(markdown)) return "";
  const body = (markdown as Record<string, unknown>).body;
  if (!Array.isArray(body)) return "";
  const lines = body.map((line) => typeof line === "string" ? line.replace(/^\s*#\s?/, "") : "");
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, 240).join("");
}
