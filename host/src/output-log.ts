export interface LogDelta {
  lines: string[];
  replaceLast?: true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Keep the same bounded live console suffix in the controller and browser. */
export function tailLog(lines: readonly string[], limit: number): string[] {
  let start = lines.length;
  let bytes = 0;
  while (start > 0) {
    const addition = encoder.encode(lines[start - 1]!).length + Number(start < lines.length);
    if (bytes + addition > limit) break;
    bytes += addition;
    start--;
  }
  return lines.slice(start);
}

/** Bounded R console text, independent of Jupyter's stream chunk boundaries. */
export class OutputLog {
  readonly lines: string[] = [];
  bytes = 0;
  characters = 0;
  truncated = false;
  private newline = true;
  private carriageReturn = false;
  private finished = false;

  constructor(private readonly limit: number) {}

  append(text: string): LogDelta | undefined {
    if (!text || this.finished || this.truncated) return;
    const encoded = encoder.encode(text);
    const available = Math.max(0, this.limit - this.bytes);
    if (encoded.length > available) this.truncated = true;
    let end = Math.min(encoded.length, available);
    // A byte cap must never leave half of a UTF-8 code point in the console.
    while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
    this.bytes += end;
    let normalized = decoder.decode(encoded.subarray(0, end));
    if (this.carriageReturn && normalized.startsWith('\n')) normalized = normalized.slice(1);
    this.carriageReturn = normalized.endsWith('\r');
    normalized = normalized.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    if (!normalized) return;
    for (const _character of normalized) this.characters++;
    const lines = normalized.split('\n');
    const replaceLast = !this.newline && this.lines.length > 0;
    this.newline = normalized.endsWith('\n');
    if (this.newline) lines.pop();
    if (replaceLast) lines[0] = this.lines.pop()! + lines[0];
    // A bounded byte stream can still contain hundreds of thousands of empty
    // lines, beyond JavaScript's argument limit for push(...lines).
    for (const line of lines) this.lines.push(line);
    return { lines, ...(replaceLast ? { replaceLast: true } : {}) };
  }

  finish(marker: string): LogDelta | undefined {
    if (this.finished) return;
    this.finished = true;
    if (!this.truncated) return;
    this.lines.push(marker);
    return { lines: [marker] };
  }
}
