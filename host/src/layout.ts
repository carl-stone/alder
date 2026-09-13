import { dirname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parseStrictJson } from "./strict-json.js";
import {
  type AtomicWriteOptions,
  writeAtomicText,
} from "./configuration.js";
import type { NotebookDocument } from "./notebook.js";
import type { Layout, LayoutGeometry, SlideGroup, SlideObject } from "./protocol.js";

export const LAYOUT_VERSION = 1;
export const LAYOUT_GRID_COLUMNS = 12;
export const LAYOUT_MAX_ROW = 1_000_000;
export const LAYOUT_MAX_HEIGHT = 1_000_000;
export const LAYOUT_MAX_BYTES = 1024 * 1024;



export type LayoutWriteOptions = AtomicWriteOptions;

export class LayoutError extends Error {
  readonly code = "invalid_layout" as const;

  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

export class NotebookHasNoPathError extends Error {
  readonly code = "notebook_has_no_path" as const;

  constructor() {
    super("notebook has no path");
    this.name = "NotebookHasNoPathError";
  }
}

function layoutAbort(message: string): never {
  throw new LayoutError(message);
}

function pathValue(value: string | Pick<NotebookDocument, "path"> | null | undefined): string {
  const path = typeof value === "string" ? value : value?.path;
  if (typeof path !== "string" || path.length === 0) throw new NotebookHasNoPathError();
  if (/[\u0000-\u001f\u007f]/.test(path)) layoutAbort("layout path contains an invalid control character");
  return path;
}

/** Resolve a notebook path to its layout sidecar path. */
export function layoutSidecarPath(value: string | Pick<NotebookDocument, "path"> | null | undefined): string {
  const path = pathValue(value);
  return `${path}.alder-layout.json`;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) layoutAbort(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) layoutAbort(message);
  return value as Record<string, unknown>;
}

function keyValid(key: unknown, field = "cell key"): string {
  if (typeof key !== "string" || key.length === 0) layoutAbort(`${field} must be a non-empty string`);
  if (key.includes("/") || key.includes("\\") || key.includes("\0") || key === "." || key === ".." || /[\u0000-\u001f\u007f\r\n]/.test(key)) {
    layoutAbort(`${field} contains traversal or a path separator`);
  }
  if (Buffer.byteLength(key, "utf8") > 256) layoutAbort(`${field} exceeds 256 UTF-8 bytes`);
  return key;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const item = value;
  if (typeof item !== "number" || !Number.isFinite(item) || !Number.isInteger(item) || item < minimum || item > maximum) {
    layoutAbort(`${field} must be a finite integer in [${minimum}, ${maximum}]`);
  }
  return item;
}

function geometry(value: unknown, key: string): LayoutGeometry {
  const object = record(value, `geometry for ${key} must be an object`);
  const fields = Object.keys(object);
  const required = ["x", "y", "w", "h"];
  if (fields.length !== required.length || required.some((field) => !Object.hasOwn(object, field))) {
    layoutAbort(`geometry for ${key} must contain only x, y, w, h`);
  }
  const x = integer(object.x, `${key}.x`, 0, LAYOUT_GRID_COLUMNS - 1);
  const y = integer(object.y, `${key}.y`, 0, LAYOUT_MAX_ROW);
  const w = integer(object.w, `${key}.w`, 1, LAYOUT_GRID_COLUMNS);
  const h = integer(object.h, `${key}.h`, 1, LAYOUT_MAX_HEIGHT);
  if (x + w > LAYOUT_GRID_COLUMNS) layoutAbort(`geometry for ${key} extends beyond the 12-column grid`);
  return { x, y, w, h };
}

function normalizedSlideGroup(group: unknown, index: number): SlideGroup {
  let title: string | undefined;
  let cells: unknown = group;
  if (group !== null && typeof group === "object" && !Array.isArray(group)) {
    const object = group as Record<string, unknown>;
    const fields = Object.keys(object);
    if (fields.some((field) => field !== "cells" && field !== "title") || !Object.hasOwn(object, "cells")) {
      layoutAbort(`slides[${index}] must be an array of cell keys`);
    }
    cells = object.cells;
    if (Object.hasOwn(object, "title")) {
      const value = object.title;
      if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f\r\n]/.test(value)) layoutAbort(`slides[${index}].title must be a string`);
      title = value;
    }
  }
  if (!Array.isArray(cells) || cells.length === 0) layoutAbort(`slides[${index}] must be a non-empty array`);
  const keys = cells.map((key, cellIndex) => keyValid(key, `slides[${index}] key ${cellIndex + 1}`));
  if (new Set(keys).size !== keys.length) layoutAbort(`slides[${index}] contains duplicate cell keys`);
  return title === undefined ? keys : { cells: keys, title };
}
function isSlideObject(group: SlideGroup): group is SlideObject {
  return !Array.isArray(group);
}
function normalizeSlides(value: unknown): SlideGroup[] {
  if (!Array.isArray(value)) layoutAbort("slides must be an array of groups");
  const groups = value.map((group, index) => normalizedSlideGroup(group, index + 1));
  const members = groups.flatMap((group) => isSlideObject(group) ? [...group.cells] : [...group]);
  if (new Set(members).size !== members.length) layoutAbort("a cell key occurs in more than one slide");
  return groups;
}

/** Validate and canonicalize a v1 layout sidecar value. */
export function validateLayout(value: unknown): Layout {
  const object = record(value, "layout must be a JSON object with unique fields");
  const allowed = new Set(["version", "layout", "cells", "slides"]);
  const unknown = Object.keys(object).find((field) => !allowed.has(field));
  if (unknown !== undefined) layoutAbort(`unknown layout field: ${unknown}`);

  if (!Object.hasOwn(object, "version")) layoutAbort("layout version is required");
  const version = integer(object.version, "version", LAYOUT_VERSION, LAYOUT_VERSION);
  const modePresent = Object.hasOwn(object, "layout");
  let mode: Layout["layout"] | undefined;
  if (modePresent) {
    const valueMode = object.layout;
    if (valueMode !== "grid" && valueMode !== "slides") layoutAbort('layout must be "grid" or "slides"');
    mode = valueMode;
  }

  if (!Object.hasOwn(object, "cells")) layoutAbort("cells is required");
  const rawCells = object.cells;
  const cellsObject = record(rawCells, "cells must be an object");
  const cells = Object.fromEntries(Object.keys(cellsObject).sort().map((key) => {
    keyValid(key, "cells key");
    return [key, geometry(cellsObject[key], key)] as const;
  }));

  return {
    version: version as 1,
    cells,
    ...(modePresent ? { layout: mode } : {}),
    ...(Object.hasOwn(object, "slides") ? { slides: normalizeSlides(object.slides) } : {}),
  };
}

function jsonLayout(checked: Layout): Record<string, unknown> {
  const value: Record<string, unknown> = { version: checked.version, cells: checked.cells };
  if (Object.hasOwn(checked, "layout")) value.layout = checked.layout;
  if (Object.hasOwn(checked, "slides")) value.slides = checked.slides;
  return value;
}

/** Serialize a validated layout in canonical key order with a final newline. */
export function serializeLayout(value: unknown): string {
  const checked = validateLayout(value);
  const text = `${JSON.stringify(jsonLayout(checked))}\n`;
  if (Buffer.byteLength(text, "utf8") > LAYOUT_MAX_BYTES) layoutAbort("serialized layout exceeds the 1 MiB safety limit");
  return text;
}

/** Read and validate a layout sidecar; absent sidecars return null. */
export async function readLayout(value: string | Pick<NotebookDocument, "path"> | null | undefined): Promise<Layout | null> {
  const sidecar = layoutSidecarPath(value);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(sidecar);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LayoutError(`layout sidecar is not readable: ${sidecar}`);
  }
  if (bytes.byteLength > LAYOUT_MAX_BYTES) layoutAbort("layout sidecar exceeds the 1 MiB safety limit");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, { maxBytes: LAYOUT_MAX_BYTES, maxDepth: 64 });
  } catch (error) {
    layoutAbort(`invalid layout JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateLayout(parsed);
  } catch (error) {
    if (error instanceof LayoutError) throw error;
    layoutAbort(`invalid layout JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate and atomically replace a layout sidecar in its existing directory. */
export async function writeLayout(
  value: string | Pick<NotebookDocument, "path"> | null | undefined,
  layout: unknown,
  options: LayoutWriteOptions = {},
): Promise<Layout> {
  const sidecar = layoutSidecarPath(value);
  const checked = validateLayout(layout);
  try {
    const parent = dirname(sidecar);
    const parentInfo = await stat(parent);
    if (!parentInfo.isDirectory()) layoutAbort(`layout directory does not exist: ${parent}`);
    await writeAtomicText(sidecar, serializeLayout(checked), options);
  } catch (error) {
    if (error instanceof LayoutError || error instanceof NotebookHasNoPathError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") layoutAbort(`layout directory does not exist: ${dirname(sidecar)}`);
    throw error;
  }
  return checked;
}

function layoutNotebook(value: Pick<NotebookDocument, "cells"> | readonly unknown[]): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== "object" || !("cells" in value) || !Array.isArray(value.cells)) {
    layoutAbort("notebook must be a parsed notebook or a path");
  }
  return value.cells;
}

/** Derive stable layout keys from notebook cell IDs and valid unique names. */
export function layoutCellKeys(notebook: Pick<NotebookDocument, "cells"> | readonly unknown[]): string[] {
  const cells = layoutNotebook(notebook);
  if (!Array.isArray(cells) || cells.length === 0) return [];
  const ids = cells.map((cell) => {
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return "";
    const id = (cell as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : "";
  });
  const names = cells.map((cell) => {
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return "";
    const options = (cell as Record<string, unknown>).options;
    if (options === null || typeof options !== "object" || Array.isArray(options)) return "";
    const name = (options as Record<string, unknown>).name;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.]*$/.test(name) ? name : "";
  });
  const nameCounts = new Map<string, number>();
  for (const name of names) if (name.length > 0) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const keys = ids.map((id, index) => nameCounts.get(names[index] ?? "") === 1 ? names[index] : id);
  for (const key of keys) keyValid(key, "notebook cell key");
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const reserved = new Set(keys.filter(key => counts.get(key) === 1));
  const used = new Set<string>();
  return keys.map((key, index) => {
    if (counts.get(key) === 1) {
      used.add(key);
      return key;
    }
    let suffix = index + 1;
    let candidate = `cell-${suffix}`;
    while (reserved.has(candidate) || used.has(candidate)) {
      suffix += 1;
      candidate = `cell-${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

function overlaps(a: LayoutGeometry, b: LayoutGeometry): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Generate full-width one-row grid positions, retaining valid persisted cells. */
export function gridPositions(notebook: Pick<NotebookDocument, "cells"> | readonly unknown[], layout?: unknown): Record<string, LayoutGeometry> {
  const keys = layoutCellKeys(notebook);
  const checked = layout === undefined || layout === null ? undefined : validateLayout(layout);
  const persisted = checked?.cells ?? {};
  const result: Record<string, LayoutGeometry> = Object.create(null);
  const occupied: LayoutGeometry[] = [];
  for (const key of keys) {
    const saved = persisted[key];
    if (saved !== undefined) {
      result[key] = { ...saved };
      occupied.push(result[key]);
    }
  }
  for (const key of keys) {
    if (result[key] !== undefined) continue;
    let y = 0;
    let candidate: LayoutGeometry = { x: 0, y, w: LAYOUT_GRID_COLUMNS, h: 1 };
    while (occupied.some((other) => overlaps(other, candidate))) {
      y += 1;
      if (y > LAYOUT_MAX_ROW) layoutAbort("cannot place all cells within the safe grid bounds");
      candidate = { x: 0, y, w: LAYOUT_GRID_COLUMNS, h: 1 };
    }
    result[key] = candidate;
    occupied.push(candidate);
  }
  return Object.fromEntries(Object.entries(result));
}

function headingStart(cell: unknown): boolean {
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return false;
  const object = cell as Record<string, unknown>;
  if (object.type !== "markdown" || !Array.isArray(object.body)) return false;
  const line = object.body.find((value) => typeof value === "string" && value.trim().length > 0);
  return typeof line === "string" && /^\s*#{1,2}(?:\s|$)/.test(line);
}

function slideMarker(cell: unknown): boolean {
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return false;
  const options = (cell as Record<string, unknown>).options;
  if (options === null || typeof options !== "object" || Array.isArray(options)) return false;
  const value = (options as Record<string, unknown>).slide;
  return value === true || (typeof value === "string" && ["true", "yes", "1"].includes(value.trim().toLowerCase()));
}

/** Return explicit slide groups plus unassigned cells, or automatic heading groups. */
export function slideGroups(notebook: Pick<NotebookDocument, "cells"> | readonly unknown[], layout?: unknown): SlideGroup[] {
  const cells = layoutNotebook(notebook);
  const keys = layoutCellKeys(cells);
  const checked = layout === undefined || layout === null ? undefined : validateLayout(layout);
  if (checked && Object.hasOwn(checked, "slides")) {
    const groups: SlideGroup[] = [];
    const used = new Set<string>();
    for (const group of checked.slides ?? []) {
      const members = isSlideObject(group) ? [...group.cells] : [...group];
      const known = members.filter((key) => keys.includes(key) && !used.has(key));
      if (known.length > 0) {
        groups.push(isSlideObject(group) ? { cells: known, ...(group.title === undefined ? {} : { title: group.title }) } : known);
        for (const key of known) used.add(key);
      }
    }
    for (const key of keys) if (!used.has(key)) groups.push([key]);
    return groups;
  }

  const groups: string[][] = [[]];
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0 && (headingStart(cells[index]) || slideMarker(cells[index]))) groups.push([]);
    groups[groups.length - 1]?.push(keys[index] as string);
  }
  return groups.filter((group) => group.length > 0);
}
