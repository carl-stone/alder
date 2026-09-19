import { readFile } from "node:fs/promises";
import { parseJson } from "./json.js";
import type { NotebookDocument } from "./notebook.js";
import type { Layout, LayoutGeometry, SlideGroup, SlideObject } from "./protocol.js";

export const LAYOUT_VERSION = 1;
export const LAYOUT_GRID_COLUMNS = 12;
export const LAYOUT_MAX_ROW = 1_000_000;
export const LAYOUT_MAX_HEIGHT = 1_000_000;
export const LAYOUT_MAX_BYTES = 1024 * 1024;



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
    parsed = parseJson(bytes, LAYOUT_MAX_BYTES);
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
