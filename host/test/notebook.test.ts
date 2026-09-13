import test from "node:test";
import assert from "node:assert/strict";
import {
  fromFilePosition,
  layoutNotebook,
  logicalBodyPosition,
  parseNotebook,
  physicalBodyLines,
  serializeNotebook,
  stageDocumentChanges,
  toFilePosition,
  translateRange,
  type NotebookDocument,
} from "../src/notebook.js";
import { toLogicalCellBody, toPhysicalCellBody } from "../src/cell-body.js";
import {
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_SOURCE_BYTES,
  MAX_SOURCE_LINE_LENGTH,
  MAX_SOURCE_LINES,
} from "../src/protocol.js";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function withBom(text: string): Uint8Array {
  const body = bytes(text);
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): void {
  assert.deepEqual(Array.from(actual), Array.from(expected));
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    if (!(error instanceof Error) || !("code" in error)) return false;
    const actualCode = error.code;
    return actualCode === code;
  };
}

function codecDocument(cells: NotebookDocument["cells"]): NotebookDocument {
  return { cells };
}

test("parseNotebook and serializeNotebook preserve mixed physical bytes and metadata/options", () => {
  const source = [
    "# %%not-a-cell\r\n",
    "# title: café\n",
    "# ---\r",
    "# title: \"Notebook 🚀\"\r\n",
    "# vendor_meta: \"keep\"\n",
    "# nested:\r",
    "#   emoji: \"☕\"\r\n",
    "# ---\r",
    "# %% [mArKdOwN] \r",
    "# heading\n",
    "#| vendor_flag: first\r\n",
    "#| vendor_flag: second\r\n",
    "\n",
    "  # indented\r\n",
    "# %% [R-custom]\n",
    "value <- \"λ\"",
  ].join("");
  const input = withBom(source);
  const document = parseNotebook(input, "/tmp/mixed.R");

  assert.equal(document.path, "/tmp/mixed.R");
  assert.equal(document.bom, true);
  assert.equal(document.text, source);
  assert.equal(document.preferredEol, "\r\n");
  assert.equal(document.finalNewline, false);
  assert.deepEqual(document.header, [
    "# %%not-a-cell",
    "# title: café",
    "# ---",
    "# title: \"Notebook 🚀\"",
    "# vendor_meta: \"keep\"",
    "# nested:",
    "#   emoji: \"☕\"",
    "# ---",
  ]);
  assert.equal(document.metadata?.title, "Notebook 🚀");
  assert.equal(document.metadata?.vendor_meta, "keep");
  const nested = document.metadata?.nested;
  assert.ok(nested !== null && typeof nested === "object" && !Array.isArray(nested));
  assert.deepEqual(Object.entries(nested), [["emoji", "☕"]]);

  assert.equal(document.cells.length, 2);
  const markdown = document.cells[0]!;
  const code = document.cells[1]!;
  assert.equal(markdown.type, "markdown");
  assert.equal(markdown.delim, "# %% [mArKdOwN] ");
  assert.deepEqual(markdown.body, ["# heading", "", "  # indented"]);
  assert.deepEqual(Object.entries(markdown.options ?? {}), [["vendor_flag", "second"]]);
  assert.deepEqual(Object.entries(markdown.optionDuplicates ?? {}), [["vendor_flag", [3, 4]]]);
  assert.deepEqual(markdown.raw, [
    "# %% [mArKdOwN] ",
    "# heading",
    "#| vendor_flag: first",
    "#| vendor_flag: second",
    "",
    "  # indented",
  ]);
  assert.deepEqual(markdown.records?.map((record) => ({ kind: record.kind, eol: record.eol })), [
    { kind: "delimiter", eol: "\r" },
    { kind: "body", eol: "\n" },
    { kind: "option", eol: "\r\n" },
    { kind: "option", eol: "\r\n" },
    { kind: "body", eol: "\n" },
    { kind: "body", eol: "\r\n" },
  ]);
  assert.equal(code.type, "code");
  assert.equal(code.delim, "# %% [R-custom]");
  assert.deepEqual(code.body, ["value <- \"λ\""]);
  assert.equal(code.records?.at(-1)?.eol, "");

  sameBytes(serializeNotebook(document), input);
});

test("Markdown logical and physical ranges exclude delimiters/options exactly", () => {
  const document = parseNotebook(bytes([
    "# header\r\n",
    "# %% [MaRkDoWn]\n",
    "# heading\r",
    "#| unknown: yes\r\n",
    "\n",
    "  # indented\r\n",
    "# %% [r]\n",
    "x <- 1\r\n",
  ].join("")), "/tmp/ranges.R");

  const markdown = document.cells[0]!;
  assert.deepEqual(toLogicalCellBody("markdown", markdown.body), ["heading", "", "  indented"]);
  assert.deepEqual(toPhysicalCellBody("markdown", ["heading", "", "  indented"]), [
    "# heading",
    "",
    "#   indented",
  ]);

  assert.deepEqual(physicalBodyLines(document, "cell-1"), [2, 4, 5]);
  assert.deepEqual(physicalBodyLines(document, "cell-2"), [7]);
  assert.deepEqual(logicalBodyPosition(document, 2), { id: "cell-1", line: 0 });
  assert.deepEqual(logicalBodyPosition(document, 4), { id: "cell-1", line: 1 });
  assert.deepEqual(logicalBodyPosition(document, 5), { id: "cell-1", line: 2 });
  assert.deepEqual(logicalBodyPosition(document, 7), { id: "cell-2", line: 0 });
  assert.equal(logicalBodyPosition(document, 1), null);
  assert.equal(logicalBodyPosition(document, 3), null);
  assert.equal(logicalBodyPosition(document, 6), null);

  assert.deepEqual(toFilePosition(document, { cell: "cell-1", line: 0, character: 3 }), { line: 2, character: 5 });
  assert.deepEqual(toFilePosition(document, { cell: "cell-1", line: 2, character: 4 }), { line: 5, character: 6 });
  assert.deepEqual(fromFilePosition(document, { line: 5, character: 4 }), { cell: "cell-1", line: 2, character: 2 });
  assert.equal(fromFilePosition(document, { line: 1, character: 0 }), null);
  assert.deepEqual(translateRange({
    start: { line: 2, character: 1 },
    end: { line: 5, character: 5 },
  }, document), {
    start: { cell: "cell-1", line: 0, character: 0 },
    end: { cell: "cell-1", line: 2, character: 3 },
  });
  assert.equal(translateRange({
    start: { line: 2, character: 0 },
    end: { line: 7, character: 0 },
  }, document), null);

  const layout = layoutNotebook(document);
  assert.equal(layout.text, [
    "# header\r\n",
    "# %% [MaRkDoWn]\n",
    "# heading\r",
    "#| unknown: yes\r\n",
    "\n",
    "  # indented\r\n",
    "# %% [r]\n",
    "x <- 1\r\n",
  ].join(""));
  assert.deepEqual(layout.lineMap, [
    null,
    null,
    { cell: "cell-1", line: 0 },
    null,
    { cell: "cell-1", line: 1 },
    { cell: "cell-1", line: 2 },
    null,
    { cell: "cell-2", line: 0 },
  ]);
  assert.deepEqual(layout.cellLines.get("cell-1"), [2, 4, 5]);
  assert.deepEqual(layout.cellLines.get("cell-2"), [7]);
});

test("Markdown body re-encoding preserves untouched physical prefixes and canonicalizes edits", () => {
  const source = [
    "# %% [markdown]\n",
    "#hello\n",
    "# hello\n",
    "  # note\n",
    "\n",
    "# changed\n",
  ].join("");
  const base = parseNotebook(bytes(source), "/tmp/markdown-preservation.R");
  const staged = stageDocumentChanges(base, [{
    type: "edit",
    cell: { cellId: "cell-1" },
    expectedRevision: 0,
    body: ["# changed-start", "# hello", "#   note", "", "# changed-end"],
    cellType: "markdown",
  }]);
  assert.equal(
    new TextDecoder().decode(serializeNotebook(staged.document)),
    "# %% [markdown]\n# changed-start\n# hello\n  # note\n\n# changed-end\n",
  );
});

test("Markdown logical decoding retains U+2028/U+2029 and does not duplicate prefixes", () => {
  const logical = ["hello\u2028world", "note\u2029tail"];
  const physical = toPhysicalCellBody("markdown", logical);
  assert.deepEqual(toLogicalCellBody("markdown", physical), logical);
  assert.deepEqual(physical, ["# hello\u2028world", "# note\u2029tail"]);
});

test("parseNotebook rejects malformed UTF-8, NUL, and malformed metadata before mutation", () => {
  assert.throws(
    () => parseNotebook(Uint8Array.from([0x23, 0x20, 0xc3, 0x28]), "/tmp/bad-utf8.R"),
    errorCode("invalid_utf8"),
  );
  assert.throws(
    () => parseNotebook(Uint8Array.from([0x23, 0x00, 0x0a]), "/tmp/nul.R"),
    errorCode("embedded_nul"),
  );
  assert.throws(
    () => parseNotebook(bytes("# ---\n# duplicate: one\n# duplicate: two\n# ---\n# %%\n"), "/tmp/duplicate-metadata.R"),
    errorCode("malformed_metadata"),
  );
  assert.throws(
    () => parseNotebook(bytes("# ---\nnot-a-comment: true\n# ---\n# %%\n"), "/tmp/uncommented-metadata.R"),
    errorCode("malformed_metadata"),
  );
});

test("parseNotebook enforces notebook, cell, line, and source-line limits", () => {
  assert.throws(
    () => parseNotebook(new Uint8Array(MAX_NOTEBOOK_SOURCE_BYTES + 1), "/tmp/too-large.R"),
    errorCode("notebook_too_large"),
  );
  assert.throws(
    () => parseNotebook(bytes("# %%\n".repeat(MAX_NOTEBOOK_CELLS + 1)), "/tmp/too-many-cells.R"),
    errorCode("too_many_cells"),
  );
  assert.throws(
    () => parseNotebook(bytes(`# %%\n${"x\n".repeat(MAX_SOURCE_LINES + 1)}`), "/tmp/too-many-lines.R"),
    errorCode("too_many_lines"),
  );
  assert.throws(
    () => parseNotebook(bytes(`# %%\n${"x".repeat(MAX_SOURCE_LINE_LENGTH + 1)}`), "/tmp/too-long-line.R"),
    errorCode("line_too_long"),
  );
});

test("serializeNotebook enforces cell, line, Unicode, and NUL limits", () => {
  const oversizedHeader = Array.from({ length: 33_000 }, () => "x".repeat(1024));
  assert.throws(
    () => serializeNotebook({ header: oversizedHeader, cells: [] }),
    errorCode("notebook_too_large"),
  );
  assert.throws(
    () => serializeNotebook(codecDocument(Array.from({ length: MAX_NOTEBOOK_CELLS + 1 }, (_, index) => ({
      id: `cell-${index + 1}`,
      type: "code" as const,
      body: [],
    })))),
    errorCode("too_many_cells"),
  );
  assert.throws(
    () => serializeNotebook(codecDocument([{
      id: "long-line",
      type: "code",
      body: ["x".repeat(MAX_SOURCE_LINE_LENGTH + 1)],
    }])),
    errorCode("line_too_long"),
  );
  assert.throws(
    () => serializeNotebook(codecDocument([{
      id: "many-lines",
      type: "code",
      body: Array.from({ length: MAX_SOURCE_LINES + 1 }, () => "x"),
    }])),
    errorCode("too_many_lines"),
  );
  assert.throws(
    () => serializeNotebook(codecDocument([{
      id: "nul",
      type: "code",
      body: ["before\u0000after"],
    }])),
    errorCode("embedded_nul"),
  );
  assert.throws(
    () => serializeNotebook(codecDocument([{
      id: "surrogate",
      type: "code",
      body: ["before\ud800after"],
    }])),
    errorCode("invalid_input"),
  );
});

test("stageDocumentChanges drops create/delete identities at the transaction boundary", () => {
  const base = parseNotebook(bytes("# %%\nx <- 1\n"), "/tmp/stage.R");
  const staged = stageDocumentChanges(base, [
    {
      type: "create",
      creationId: "temporary",
      after: null,
      cellType: "code",
      body: ["temporary <- TRUE"],
      options: {},
    },
    { type: "delete", cell: { creationId: "temporary" } },
    {
      type: "edit",
      cell: { cellId: "cell-1" },
      expectedRevision: 0,
      body: ["x <- 2"],
      cellType: "code",
    },
  ]);

  assert.deepEqual(Object.fromEntries(staged.created), {});
  assert.deepEqual([...staged.changed], ["cell-1"]);
  assert.deepEqual([...staged.deleted], []);
  assert.deepEqual(staged.document.cells.map((cell) => ({
    id: cell.id,
    body: [...cell.body],
    revision: cell.revision,
  })), [{ id: "cell-1", body: ["x <- 2"], revision: 1 }]);
  assert.equal(new TextDecoder().decode(serializeNotebook(staged.document)), "# %%\nx <- 2\n");
});

test("stageDocumentChanges treats a create/delete-only transaction as an exact no-op", () => {
  const source = "# %%\r\nx <- 1\r\n";
  const base = parseNotebook(bytes(source), "/tmp/stage-no-op.R");
  const before = serializeNotebook(base);
  const staged = stageDocumentChanges(base, [
    {
      type: "create",
      creationId: "temporary",
      after: null,
      cellType: "code",
      body: ["temporary <- TRUE"],
      options: {},
    },
    { type: "delete", cell: { creationId: "temporary" } },
  ]);

  assert.strictEqual(staged.document, base);
  assert.deepEqual(Object.fromEntries(staged.created), {});
  assert.deepEqual([...staged.changed], []);
  assert.deepEqual([...staged.deleted], []);
  sameBytes(serializeNotebook(staged.document), before);
});

test("stageDocumentChanges keeps final creations and base deletions distinct", () => {
  const base = parseNotebook(bytes("# %%\nx <- 1\n# %%\ny <- 2\n"), "/tmp/stage-identities.R");
  const staged = stageDocumentChanges(base, [
    {
      type: "create",
      creationId: "retained",
      after: { cellId: "cell-1" },
      cellType: "code",
      body: ["temporary <- TRUE"],
      options: {},
    },
    {
      type: "edit",
      cell: { creationId: "retained" },
      body: ["temporary <- FALSE"],
      cellType: "code",
    },
    {
      type: "options",
      cell: { creationId: "retained" },
      patch: { name: "temporary" },
    },
    { type: "delete", cell: { cellId: "cell-1" }, expectedRevision: 0 },
  ]);

  assert.deepEqual(Object.fromEntries(staged.created), { retained: "cell-3" });
  assert.deepEqual([...staged.changed], []);
  assert.deepEqual([...staged.deleted], ["cell-1"]);
  assert.deepEqual(staged.document.cells.map((cell) => cell.id), ["cell-3", "cell-2"]);
  assert.deepEqual(staged.document.cells[0]?.body, ["temporary <- FALSE"]);
  assert.equal(staged.document.cells[0]?.options?.name, "temporary");
});
