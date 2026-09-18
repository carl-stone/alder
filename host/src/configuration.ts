import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, basename } from "node:path";
import envPaths from "env-paths";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { NotebookDocument } from "./notebook.js";

/** The maximum UTF-8 document accepted by the shared YAML boundary. */
export const MAX_YAML_BYTES = 1024 * 1024;
/** The maximum nesting depth accepted by the shared YAML boundary. */
export const MAX_YAML_DEPTH = 64;

export const configThemeSchema = z.enum(["light", "dark", "system"]);
export const configKeymapSchema = z.enum(["default", "vim"]);
export const configChangeSchema = z.enum(["automatic", "lazy"]);

const integer = (minimum: number, maximum: number) =>
  z.number().int().refine(Number.isFinite, "must be finite").min(minimum).max(maximum);

export const configFormatSchema = z.object({
  on_save: z.boolean(),
}).strict().partial();

export const configEditorSchema = z.object({
  font_size: integer(10, 32),
  tab_size: integer(1, 8),
  line_numbers: z.boolean(),
  completions: z.boolean(),
  signature_help: z.boolean(),
  live_diagnostics: z.boolean(),
}).strict().partial();

export const configTableSchema = z.object({
  page_size: integer(5, 200),
}).strict().partial();

export const configCacheSchema = z.object({
  enabled: z.boolean(),
  dir: z.string().min(1).or(z.null()),
}).strict().partial();

/** A user/project/runtime/launch configuration overlay. */
export const configLayerSchema = z.object({
  theme: configThemeSchema,
  keymap: configKeymapSchema,
  on_cell_change: configChangeSchema,
  on_startup: z.boolean(),
  autosave: z.boolean(),
  format: configFormatSchema,
  editor: configEditorSchema,
  table: configTableSchema,
  cache: configCacheSchema,
}).strict().partial();

export const configSchema = z.object({
  theme: configThemeSchema,
  keymap: configKeymapSchema,
  on_cell_change: configChangeSchema,
  on_startup: z.boolean(),
  autosave: z.boolean(),
  format: z.object({ on_save: z.boolean() }).strict(),
  editor: z.object({
    font_size: integer(10, 32),
    tab_size: integer(1, 8),
    line_numbers: z.boolean(),
    completions: z.boolean(),
    signature_help: z.boolean(),
    live_diagnostics: z.boolean(),
  }).strict(),
  table: z.object({ page_size: integer(5, 200) }).strict(),
  cache: z.object({ enabled: z.boolean(), dir: z.string().min(1).or(z.null()) }).strict(),
}).strict();

export type Config = z.infer<typeof configSchema>;
export type ConfigLayer = z.infer<typeof configLayerSchema>;

export type ConfigErrorCode = "config_invalid";

/** Errors raised by configuration/YAML validation. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode = "config_invalid";
  readonly key: string;

  constructor(key: string, message: string) {
    super(`config_invalid: key \`${key || "config"}\` ${message}`);
    this.name = "ConfigError";
    this.key = key || "config";
  }
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = clone(entry);
  }
  return result as T;
}

function issueKey(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return issue.keys[0] ?? "config";
  }
  return issue.path.length > 0 ? issue.path.map(String).join(".") : "config";
}

function parseConfigLayer(value: unknown, partial: boolean): ConfigLayer | Config {
  const result = partial ? configLayerSchema.safeParse(value) : configSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigError(issueKey(issue), issue.message);
  }
  return result.data as ConfigLayer | Config;
}

/** Return a fresh copy of Alder's complete built-in configuration. */
export function configDefaults(): Config {
  return {
    theme: "system",
    keymap: "default",
    on_cell_change: "automatic",
    on_startup: true,
    autosave: false,
    format: { on_save: false },
    editor: {
      font_size: 14,
      tab_size: 2,
      line_numbers: true,
      completions: true,
      signature_help: true,
      live_diagnostics: false,
    },
    table: { page_size: 25 },
    cache: { enabled: true, dir: null },
  };
}

/** Validate and normalize one configuration layer. */
export function validateConfigLayer(value: unknown): ConfigLayer {
  return parseConfigLayer(value, true) as ConfigLayer;
}

/**
 * Validate a configuration value. Partial values are overlays; complete values
 * are merged with defaults first, matching the R implementation's behavior.
 */
export function validateConfig(value: unknown, options: { partial?: boolean } = {}): Config | ConfigLayer {
  if (options.partial === false) {
    const merged = mergeConfig(configDefaults(), validateConfigLayer(value));
    return parseConfigLayer(merged, false) as Config;
  }
  return validateConfigLayer(value);
}

/** Deeply merge an overlay without mutating either input. */
export function mergeConfig(base: Config | ConfigLayer, overlay: ConfigLayer): Config | ConfigLayer {
  const result = clone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      result[key] !== null && typeof result[key] === "object" && !Array.isArray(result[key])
    ) {
      result[key] = mergeConfig(
        result[key] as Config | ConfigLayer,
        value as ConfigLayer,
      );
    } else {
      result[key] = clone(value);
    }
  }
  return result as Config | ConfigLayer;
}

function ensureStringPath(path: string | null | undefined, code = "config"): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    if (code === "layout") throw new LayoutPathError("layout path must be a non-empty path");
    throw new ConfigError("path", "must be a non-empty path");
  }
  return path;
}

/** Host-owned user paths. R is never invoked to discover these locations. */
export function alderPaths(): ReturnType<typeof envPaths> {
  return envPaths("alder", { suffix: "" });
}

export function userConfigPath(): string {
  return join(alderPaths().config, "config.yaml");
}

function projectDirectory(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path.length === 0) return null;
  return path.endsWith("/") || path.endsWith("\\") ? path : dirname(path);
}

export function projectConfigPath(path: string | null | undefined): string | null {
  const directory = projectDirectory(path);
  return directory === null ? null : join(directory, ".alder", "config.yaml");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function yamlNodeType(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = node as { type?: unknown; constructor?: { name?: unknown } };
  return typeof value.type === "string"
    ? value.type
    : typeof value.constructor?.name === "string" ? value.constructor.name : undefined;
}

function rejectYamlNode(node: unknown, depth: number, kind: string): void {
  if (node === null || typeof node !== "object") return;
  if (depth > MAX_YAML_DEPTH) throw new ConfigError(kind, "YAML nesting exceeds depth " + MAX_YAML_DEPTH);
  const value = node as Record<string, unknown>;
  const type = yamlNodeType(node);
  if (type === "ALIAS" || type === "Alias") throw new ConfigError(kind, "YAML aliases are not allowed");
  if (Object.hasOwn(value, "anchor")) throw new ConfigError(kind, "YAML anchors are not allowed");
  if (Object.hasOwn(value, "tag")) throw new ConfigError(kind, "YAML custom tags are not allowed");
  if (type === "PAIR" || type === "Pair") {
    rejectYamlNode(value.key, depth, kind);
    rejectYamlNode(value.value, depth + 1, kind);
    return;
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      const itemType = yamlNodeType(item);
      rejectYamlNode(item, itemType === "PAIR" || itemType === "Pair" ? depth : depth + 1, kind);
    }
  }
  if (Object.hasOwn(value, "key")) rejectYamlNode(value.key, depth, kind);
  if (Object.hasOwn(value, "value")) rejectYamlNode(value.value, depth + 1, kind);
}

function assertPlainJson(value: unknown, depth: number, kind: string): void {
  if (depth > MAX_YAML_DEPTH) {
    throw new ConfigError(kind, `YAML nesting exceeds depth ${MAX_YAML_DEPTH}`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigError(kind, "YAML contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertPlainJson(entry, depth + 1, kind);
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConfigError(kind, "YAML contains a non-JSON value");
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.includes("\0")) throw new ConfigError(kind, "YAML contains an embedded NUL key");
    assertPlainJson(entry, depth + 1, kind);
  }
}

/**
 * Parse one bounded YAML mapping using YAML 1.2 core semantics. This is the
 * sole YAML entry point used by configuration, notebook headers and packages.
 */
export function parseYamlMapping(text: string, kind: string): Record<string, unknown> {
  if (typeof text !== "string") throw new ConfigError(kind, "YAML input must be text");
  if (hasUnpairedSurrogate(text)) throw new ConfigError(kind, "YAML input contains an unpaired surrogate");
  if (text.includes("\0")) throw new ConfigError(kind, "YAML input contains an embedded NUL");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_YAML_BYTES) {
    throw new ConfigError(kind, `YAML document exceeds the ${MAX_YAML_BYTES}-byte limit`);
  }
  if (text.trim().length === 0) return {};

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      customTags: [],
      prettyErrors: false,
    });
  } catch (error) {
    throw new ConfigError(kind, `malformed YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document.errors.length > 0) {
    const first = document.errors[0];
    throw new ConfigError(kind, `malformed YAML: ${first?.message ?? "parse error"}`);
  }
  if (document.warnings.length > 0) {
    const first = document.warnings[0];
    throw new ConfigError(kind, `malformed YAML: ${first?.message ?? "parse warning"}`);
  }
  rejectYamlNode(document.contents, 0, kind);

  let parsed: unknown;
  try {
    parsed = document.toJS({ mapAsMap: false });
  } catch (error) {
    throw new ConfigError(kind, `malformed YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainJson(parsed, 0, kind);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(kind, "YAML root must be a mapping");
  }
  return parsed as Record<string, unknown>;
}

function yamlError(path: string, error: unknown): ConfigError {
  return error instanceof ConfigError
    ? error
    : new ConfigError(path, error instanceof Error ? error.message : String(error));
}

/** Read, bound, parse and validate a configuration file. Missing is empty. */
export async function readConfigFile(path: string | null | undefined): Promise<ConfigLayer> {
  if (path === null || path === undefined) return {};
  const file = ensureStringPath(path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new ConfigError("path", `cannot read configuration file \`${file}\`: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > MAX_YAML_BYTES) {
    throw new ConfigError("path", `configuration file exceeds the ${MAX_YAML_BYTES}-byte limit`);
  }
  try {
    const value = parseYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "config");
    return validateConfigLayer(value);
  } catch (error) {
    throw yamlError("config", error);
  }
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

export interface WriteConfigOptions extends AtomicWriteOptions {
  /** Replace rather than patch the existing mapping. Defaults to false. */
  readonly replace?: boolean;
}

/** Validate, patch and atomically write a project/user configuration file. */
export async function writeConfigFile(
  path: string,
  patch: unknown,
  options: WriteConfigOptions = {},
): Promise<ConfigLayer> {
  const file = ensureStringPath(path);
  const checked = validateConfigLayer(patch);
  const current = options.replace ? {} : await readConfigFile(file);
  const next = validateConfigLayer(mergeConfig(current, checked));
  const text = serializeConfigYaml(next);
  await writeAtomicText(file, text, options);
  return next;
}

/** Serialize a validated configuration mapping with deterministic YAML and a final newline. */
export function serializeConfigYaml(value: Record<string, unknown>): string {
  const checked = validateConfigLayer(value);
  const text = stringifyYaml(checked, { version: "1.2", schema: "core", sortMapEntries: true });
  return text.endsWith("\n") ? text : `${text}\n`;
}
export interface ResolveConfigOptions {
  readonly path?: string | null;
  readonly metadata?: unknown;
  readonly user?: unknown;
  readonly project?: unknown;
  readonly runtime?: unknown;
  readonly launch?: unknown;
  readonly userPath?: string;
  readonly projectPath?: string | null;
}

export type ConfigLayerName = "defaults" | "user" | "project" | "runtime" | "launch";
export type ConfigWritableLayer = "project" | "runtime";

export interface ConfigResolutionLayers {
  readonly defaults: Config;
  readonly user: ConfigLayer;
  readonly project: ConfigLayer;
  readonly runtime: ConfigLayer;
  readonly launch: ConfigLayer;
}

export interface ConfigResolution {
  readonly effective: Config;
  readonly layers: ConfigResolutionLayers;
  /** Dot-delimited leaf keys map to the highest-precedence layer that supplies them. */
  readonly provenance: Readonly<Record<string, ConfigLayerName>>;
}

export interface ConfigShadowedDetails {
  readonly key: string;
  readonly writtenLayer: ConfigWritableLayer;
  readonly effectiveLayer: ConfigLayerName;
}

export class ConfigShadowedError extends Error {
  readonly code = "config_shadowed" as const;
  readonly key: string;
  readonly writtenLayer: ConfigWritableLayer;
  readonly effectiveLayer: ConfigLayerName;
  readonly details: ConfigShadowedDetails;

  constructor(details: ConfigShadowedDetails) {
    super("config_shadowed: key `" + details.key + "` written in " + details.writtenLayer + " is overridden by " + details.effectiveLayer);
    this.name = "ConfigShadowedError";
    this.key = details.key;
    this.writtenLayer = details.writtenLayer;
    this.effectiveLayer = details.effectiveLayer;
    this.details = { ...details };
  }

  toJSON(): ConfigShadowedDetails & { readonly code: "config_shadowed" } {
    return { code: this.code, ...this.details };
  }
}


function runtimeLayer(metadata: unknown, explicit: unknown): ConfigLayer {
  let value: unknown = explicit;
  if (value === undefined && metadata !== undefined && metadata !== null) {
    if (typeof metadata !== "object" || Array.isArray(metadata)) throw new ConfigError("runtime", "metadata must be a mapping");
    value = (metadata as Record<string, unknown>).runtime;
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ConfigError("runtime", "must be a mapping");
  return validateConfigLayer(value);
}

/** Resolve defaults < user < project < metadata.runtime < launch. */
const CONFIG_LAYER_ORDER: readonly ConfigLayerName[] = ["defaults", "user", "project", "runtime", "launch"];
const CONFIG_LAYER_RANK: Readonly<Record<ConfigLayerName, number>> = {
  defaults: 0,
  user: 1,
  project: 2,
  runtime: 3,
  launch: 4,
};

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configLeafValues(value: unknown, prefix = "", result: Array<{ key: string; value: unknown }> = []): Array<{ key: string; value: unknown }> {
  if (!isConfigRecord(value)) {
    if (prefix.length > 0) result.push({ key: prefix, value });
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : prefix + "." + key;
    if (isConfigRecord(child)) configLeafValues(child, path, result);
    else result.push({ key: path, value: child });
  }
  return result;
}

function configValueAt(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!isConfigRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameConfigValue(value, right[index]));
  }
  if (!isConfigRecord(left) || !isConfigRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameConfigValue(left[key], right[key]));
}

export interface ResolveConfigLayersOptions {
  readonly user?: unknown;
  readonly project?: unknown;
  readonly runtime?: unknown;
  readonly launch?: unknown;
}

async function readConfigLayers(options: ResolveConfigOptions): Promise<ResolveConfigLayersOptions> {
  const path = options.path ?? null;
  const user = options.user === undefined
    ? await readConfigFile(options.userPath ?? userConfigPath())
    : options.user;
  const projectPath = options.projectPath === undefined ? projectConfigPath(path) : options.projectPath;
  const project = options.project === undefined
    ? await readConfigFile(projectPath)
    : options.project;
  const runtime = runtimeLayer(options.metadata, options.runtime);
  const launch = options.launch === undefined ? {} : options.launch;
  return { user, project, runtime, launch };
}

/** Resolve supplied partial layers synchronously with the canonical precedence and result shape. */
export function resolveConfigLayers(options: ResolveConfigLayersOptions = {}): ConfigResolution {
  const layers: ConfigResolutionLayers = {
    defaults: configDefaults(),
    user: options.user === undefined ? {} : validateConfigLayer(options.user),
    project: options.project === undefined ? {} : validateConfigLayer(options.project),
    runtime: options.runtime === undefined ? {} : validateConfigLayer(options.runtime),
    launch: options.launch === undefined ? {} : validateConfigLayer(options.launch),
  };
  return buildConfigResolution(layers);
}
function buildConfigResolution(layers: ConfigResolutionLayers): ConfigResolution {
  let effective: Config = clone(layers.defaults);
  const provenance: Record<string, ConfigLayerName> = {};
  for (const layerName of CONFIG_LAYER_ORDER) {
    const layer = layers[layerName];
    for (const { key } of configLeafValues(layer)) provenance[key] = layerName;
    if (layerName !== "defaults") effective = mergeConfig(effective, layer) as Config;
  }
  effective = validateConfig(effective, { partial: false }) as Config;
  return {
    effective: clone(effective),
    layers: {
      defaults: clone(layers.defaults),
      user: clone(layers.user),
      project: clone(layers.project),
      runtime: clone(layers.runtime),
      launch: clone(layers.launch),
    },
    provenance: { ...provenance },
  };
}

/** Reject a patch whose requested leaf value is hidden by a higher layer. */
export function assertConfigPatchEffective(
  resolution: ConfigResolution,
  patch: ConfigLayer,
  writtenLayer: ConfigWritableLayer,
): void {
  if (writtenLayer !== "project" && writtenLayer !== "runtime") {
    throw new ConfigError("writtenLayer", "must be project or runtime");
  }
  for (const { key, value } of configLeafValues(patch)) {
    const effectiveLayer = resolution.provenance[key];
    if (effectiveLayer === undefined) continue;
    if (CONFIG_LAYER_RANK[effectiveLayer] > CONFIG_LAYER_RANK[writtenLayer]
      && !sameConfigValue(configValueAt(resolution.effective, key), value)) {
      throw new ConfigShadowedError({ key, writtenLayer, effectiveLayer });
    }
  }
}

export async function resolveConfig(options: ResolveConfigOptions = {}): Promise<ConfigResolution> {
  return resolveConfigLayers(await readConfigLayers(options));
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

export type AppLayerName = "defaults" | "app";

export interface AppResolution {
  readonly effective: AppConfig;
  readonly provenance: Readonly<Record<keyof AppConfig, AppLayerName>>;
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

/** Return effective app settings and per-key defaults/app provenance. */
export function appConfig(notebook: Pick<NotebookDocument, "metadata">): AppResolution {
  const app = validateAppMetadata(notebook?.metadata);
  const effective: AppConfig = {
    layout: Object.hasOwn(app, "layout") ? app.layout as AppConfig["layout"] : appDefaults.layout,
    width: Object.hasOwn(app, "width") ? app.width as AppConfig["width"] : appDefaults.width,
    include_code: Object.hasOwn(app, "include_code") ? app.include_code as boolean : appDefaults.include_code,
  };
  return {
    effective,
    provenance: {
      layout: Object.hasOwn(app, "layout") ? "app" : "defaults",
      width: Object.hasOwn(app, "width") ? "app" : "defaults",
      include_code: Object.hasOwn(app, "include_code") ? "app" : "defaults",
    },
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
