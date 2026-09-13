export type CellType = "code" | "markdown";

function markdownLogicalLine(line: string): string {
  if (line.length === 0) return "";
  const match = /^(\s*)#(?: ?)([\s\S]*)$/.exec(line);
  return match === null ? line : match[1]! + match[2]!;
}

function isMarkdownPhysicalLine(line: string): boolean {
  return line.trim().length === 0 || /^\s*#/.test(line);
}

/** Whether two physical Markdown lines have the same editor-visible value. */
export function markdownPhysicalLinesEqual(left: string, right: string): boolean {
  return isMarkdownPhysicalLine(left)
    && isMarkdownPhysicalLine(right)
    && markdownLogicalLine(left) === markdownLogicalLine(right);
}

function canonicalMarkdownLine(logical: string): string {
  return logical.length === 0 ? "" : "# " + logical;
}

/** Canonicalize a physical body without changing its editor-visible content. */
export function canonicalizeCellBody(cellType: CellType, body: readonly string[]): string[] {
  if (cellType === "code") return [...body];
  return body.map((line) => canonicalMarkdownLine(markdownLogicalLine(line)));
}

/** Convert editor/logical cell lines to canonical wire body lines. */
export function toPhysicalCellBody(
  cellType: CellType,
  logicalBody: readonly string[],
  originalPhysicalBody?: readonly string[],
): string[] {
  if (cellType === "code") return [...logicalBody];
  const physicalBody = logicalBody.map((line) => canonicalMarkdownLine(line));
  if (originalPhysicalBody === undefined) return physicalBody;
  const shared = Math.min(originalPhysicalBody.length, physicalBody.length);
  let prefix = 0;
  let suffix = 0;
  while (prefix < shared
    && markdownPhysicalLinesEqual(originalPhysicalBody[prefix]!, physicalBody[prefix]!)) prefix += 1;
  while (suffix < shared - prefix
    && markdownPhysicalLinesEqual(
      originalPhysicalBody[originalPhysicalBody.length - suffix - 1]!,
      physicalBody[physicalBody.length - suffix - 1]!,
    )) suffix += 1;
  for (let index = 0; index < prefix; index += 1) physicalBody[index] = originalPhysicalBody[index]!;
  for (let index = prefix; index < shared - suffix; index += 1) {
    if (markdownPhysicalLinesEqual(originalPhysicalBody[index]!, physicalBody[index]!)) {
      physicalBody[index] = originalPhysicalBody[index]!;
    }
  }
  for (let index = 0; index < suffix; index += 1) {
    physicalBody[physicalBody.length - suffix + index] = originalPhysicalBody[originalPhysicalBody.length - suffix + index]!;
  }
  return physicalBody;
}

/** Convert wire body lines to editor/logical cell lines. */
export function toLogicalCellBody(cellType: CellType, physicalBody: readonly string[]): string[] {
  if (cellType === "code") return [...physicalBody];
  return physicalBody.map((line) => markdownLogicalLine(line));
}
