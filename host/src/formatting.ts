import type { OwnedProcess, ProcessScope } from "./processes.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import type { NotebookDocument } from "./notebook.js";
import type { DocumentChange } from "./protocol.js";

export type EditChange = Extract<DocumentChange, { type: "edit" }>;

export interface FormattingService {
  formatCells(document: NotebookDocument, cellIds: readonly string[], signal?: AbortSignal): Promise<EditChange[]>;
}

export class FormattingError extends Error {
  constructor(readonly code: "format_failed" | "format_unavailable" | "cancelled", message: string) {
    super(message);
  }
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

/** Bind formatting to the immutable application Air executable and process scope. */
export function createFormattingService(airExecutable: string, processScope: Pick<ProcessScope, "spawn">): FormattingService {
  if (!isAbsoluteNonEmptyPath(airExecutable)) {
    throw new Error("Air executable must be an absolute path");
  }
  if (!processScope || typeof processScope.spawn !== "function") {
    throw new Error("formatting requires the application ProcessScope");
  }
  const formatCells = async (
    document: NotebookDocument,
    cellIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<EditChange[]> => {
    if (!Array.isArray(cellIds)) throw new FormattingError("format_failed", "cellIds must be an array");
    const wanted = new Set<string>();
    for (const id of cellIds) {
      if (typeof id !== "string" || id.length === 0 || wanted.has(id)) {
        throw new FormattingError("format_failed", "cellIds must contain unique nonempty IDs");
      }
      wanted.add(id);
    }
    const cells = document.cells.filter(cell => wanted.has(cell.id));
    if (cells.length !== wanted.size) {
      const missing = [...wanted].find(id => !document.cells.some(cell => cell.id === id));
      throw new FormattingError("format_failed", "no such cell: " + (missing ?? ""));
    }
    const edits: EditChange[] = [];
    for (const cell of cells) {
      if (cell.type === "markdown") continue;
      if (signal?.aborted) throw new FormattingError("cancelled", "formatting was cancelled");
      const body = await formatOne(airExecutable, processScope, cell.body, signal);
      edits.push({
        type: "edit",
        cell: { cellId: cell.id },
        expectedRevision: cell.revision,
        body,
        cellType: "code",
      } as EditChange);
    }
    return edits;
  };
  return { formatCells };
}

async function formatOne(
  airExecutable: string,
  processScope: Pick<ProcessScope, "spawn">,
  body: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "alder-format-"));
  const input = join(directory, "cell.R");
  try {
    const text = body.join("\n");
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
      throw new FormattingError("format_failed", "cell source exceeds formatter limit");
    }
    await writeFile(input, text, { encoding: "utf8", mode: 0o600 });
    const result = await runAir(airExecutable, input, processScope, directory, signal);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "exit status " + (result.code ?? "unknown");
      throw new FormattingError("format_failed", "air could not format the cell: " + detail);
    }
    const bytes = await readFile(input);
    if (bytes.length > MAX_OUTPUT_BYTES) throw new FormattingError("format_failed", "air output exceeds formatter limit");
    const output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (output.includes("\0")) throw new FormattingError("format_failed", "air returned NUL bytes");
    return sourceLines(output);
  } catch (error) {
    if (error instanceof FormattingError) throw error;
    throw new FormattingError("format_failed", error instanceof Error ? error.message : String(error));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runAir(
  executable: string,
  input: string,
  processScope: Pick<ProcessScope, "spawn">,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (signal?.aborted) throw new FormattingError("cancelled", "formatting was cancelled");
  let child: OwnedProcess | undefined;
  let stdout = "";
  let stderr = "";
  let settled = false;
  let aborting = false;
  const collect = (current: string, chunk: Buffer | Uint8Array | string): string =>
    (current + Buffer.from(chunk).toString("utf8")).slice(-65536);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      aborting = true;
      if (child !== undefined) void child.terminate().catch(() => {});
      finish(() => reject(new FormattingError("cancelled", "formatting was cancelled")));
    };
    if (signal?.aborted) return abort();
    void processScope.spawn({
      executable,
      args: ["format", input],
      cwd,
      environment,
      stdio: "pipes",
    }).then(spawned => {
      child = spawned;
      if (aborting || signal?.aborted) {
        abort();
        return;
      }
      spawned.stdout?.on("data", chunk => { stdout = collect(stdout, chunk); });
      spawned.stderr?.on("data", chunk => { stderr = collect(stderr, chunk); });
      void spawned.exited.then(({ code }) => {
        finish(() => resolve({ code, stdout, stderr }));
      }, error => {
        finish(() => reject(new FormattingError("format_failed", error instanceof Error ? error.message : String(error))));
      });
    }, error => {
      finish(() => reject(new FormattingError("format_failed", error instanceof Error ? error.message : String(error))));
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
  return result;
}

function sourceLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new FormattingError("format_failed", "air returned an oversized source line");
    }
  }
  return lines;
}

function isAbsoluteNonEmptyPath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}
