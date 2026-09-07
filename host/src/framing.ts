import { TextDecoder } from "node:util";

export const ENGINE_PROTOCOL = "alder-engine-v1" as const;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
// A codec request can contain both the immutable 32 MiB disk version and the
// current 32 MiB source snapshot. Their exact per-line base64 representation
// needs about 90 MiB before bounded structural metadata.
export const DEFAULT_MAX_ENGINE_FRAME_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_JSON_NESTING = 64;

export class FrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameProtocolError";
  }
}

class StrictJsonParser {
  private offset = 0;

  constructor(
    private readonly text: string,
    private readonly maxNesting: number,
  ) {}

  parse(): unknown {
    this.whitespace();
    const result = this.value(0);
    this.whitespace();
    if (this.offset !== this.text.length) this.fail("trailing content");
    return result;
  }

  private value(depth: number): unknown {
    const next = this.text[this.offset];
    if (next === "{") return this.object(depth + 1);
    if (next === "[") return this.array(depth + 1);
    if (next === '"') return this.string();
    if (next === "t") return this.literal("true", true);
    if (next === "f") return this.literal("false", false);
    if (next === "n") return this.literal("null", null);
    if (next === "-" || (next !== undefined && next >= "0" && next <= "9")) {
      return this.number();
    }
    this.fail("expected a JSON value");
  }

  private object(depth: number): Record<string, unknown> {
    this.checkDepth(depth);
    this.offset += 1;
    this.whitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.consume("}")) return result;
    while (true) {
      if (this.text[this.offset] !== '"') this.fail("expected an object key");
      const key = this.string();
      if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.whitespace();
      if (!this.consume(":")) this.fail("expected ':' after an object key");
      this.whitespace();
      const item = this.value(depth);
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      });
      this.whitespace();
      if (this.consume("}")) return result;
      if (!this.consume(",")) this.fail("expected ',' or '}'");
      this.whitespace();
    }
  }

  private array(depth: number): unknown[] {
    this.checkDepth(depth);
    this.offset += 1;
    this.whitespace();
    const result: unknown[] = [];
    if (this.consume("]")) return result;
    while (true) {
      result.push(this.value(depth));
      this.whitespace();
      if (this.consume("]")) return result;
      if (!this.consume(",")) this.fail("expected ',' or ']'");
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        let result: string;
        try {
          result = JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch {
          this.fail("invalid JSON string");
        }
        this.validateSurrogates(result!);
        return result!;
      }
      if (code < 0x20) this.fail("unescaped control character in string");
      if (code === 0x5c) {
        this.offset += 1;
        if (this.offset >= this.text.length) this.fail("unterminated escape");
        const escaped = this.text[this.offset];
        if (escaped === "u") {
          const digits = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("invalid Unicode escape");
          this.offset += 4;
        } else if (!'"\\/bfnrt'.includes(escaped!)) {
          this.fail("invalid string escape");
        }
      }
      this.offset += 1;
    }
    this.fail("unterminated JSON string");
  }

  private validateSurrogates(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) this.fail("unpaired surrogate");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        this.fail("unpaired surrogate");
      }
    }
  }

  private number(): number {
    const token = this.text.slice(this.offset).match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/,
    )?.[0];
    if (token === undefined) this.fail("invalid number");
    this.offset += token!.length;
    const result = Number(token);
    if (!Number.isFinite(result)) this.fail("non-finite number");
    return result;
  }

  private literal<T>(token: string, result: T): T {
    if (!this.text.startsWith(token, this.offset)) this.fail("invalid literal");
    this.offset += token.length;
    return result;
  }

  private whitespace(): void {
    while (/\s/.test(this.text[this.offset] ?? "") &&
           " \t\r\n".includes(this.text[this.offset]!)) {
      this.offset += 1;
    }
  }

  private consume(token: string): boolean {
    if (this.text[this.offset] !== token) return false;
    this.offset += 1;
    return true;
  }

  private checkDepth(depth: number): void {
    if (depth > this.maxNesting) this.fail("JSON nesting limit exceeded");
  }

  private fail(message: string): never {
    throw new FrameProtocolError(`${message} at byte ${Buffer.byteLength(
      this.text.slice(0, this.offset),
      "utf8",
    )}`);
  }
}

export function parseStrictJson(
  text: string,
  maxNesting = DEFAULT_MAX_JSON_NESTING,
): unknown {
  if (!Number.isSafeInteger(maxNesting) || maxNesting < 1) {
    throw new RangeError("maxNesting must be a positive safe integer");
  }
  return new StrictJsonParser(text, maxNesting).parse();
}

export function encodeFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  validateMaxFrameBytes(maxFrameBytes);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new FrameProtocolError(
      `value cannot be encoded as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (json === undefined) throw new FrameProtocolError("value cannot be encoded as JSON");
  const body = Buffer.from(json, "utf8");
  if (body.length === 0 || body.length > maxFrameBytes) {
    throw new FrameProtocolError(`frame length ${body.length} is outside 1..${maxFrameBytes}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body], header.length + body.length);
}

export class FrameDecoder {
  private chunks: Buffer[] = [];
  private chunkIndex = 0;
  private bufferedBytes = 0;
  private expectedBytes: number | undefined;
  private failed = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    readonly maxNesting = DEFAULT_MAX_JSON_NESTING,
  ) {
    validateMaxFrameBytes(maxFrameBytes);
    if (!Number.isSafeInteger(maxNesting) || maxNesting < 1) {
      throw new RangeError("maxNesting must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.failed) throw new FrameProtocolError("decoder is in a failed state");
    if (!(chunk instanceof Uint8Array)) throw new TypeError("frame chunk must be bytes");
    if (chunk.byteLength === 0) return [];
    this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.bufferedBytes += chunk.byteLength;
    const values: unknown[] = [];
    try {
      while (true) {
        if (this.expectedBytes === undefined) {
          if (this.bufferedBytes < 4) break;
          this.expectedBytes = this.readBytes(4).readUInt32BE(0);
          if (this.expectedBytes === 0 || this.expectedBytes > this.maxFrameBytes) {
            throw new FrameProtocolError(
              `frame length ${this.expectedBytes} is outside 1..${this.maxFrameBytes}`,
            );
          }
        }
        if (this.bufferedBytes < this.expectedBytes) break;
        const body = this.readBytes(this.expectedBytes);
        this.expectedBytes = undefined;
        let text: string;
        try {
          text = this.decoder.decode(body);
        } catch {
          throw new FrameProtocolError("frame body is not valid UTF-8");
        }
        values.push(parseStrictJson(text, this.maxNesting));
      }
      return values;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  finish(): void {
    if (this.failed) return;
    if (this.expectedBytes !== undefined || this.bufferedBytes !== 0) {
      this.failed = true;
      throw new FrameProtocolError("stream ended with a truncated frame");
    }
  }

  private readBytes(count: number): Buffer {
    const first = this.chunks[this.chunkIndex]!;
    if (first.length === count) {
      this.chunkIndex += 1;
      this.bufferedBytes -= count;
      this.resetConsumedChunks();
      return first;
    }
    if (first.length > count) {
      const value = first.subarray(0, count);
      this.chunks[this.chunkIndex] = first.subarray(count);
      this.bufferedBytes -= count;
      return value;
    }
    const value = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const part = this.chunks[this.chunkIndex]!;
      const size = Math.min(part.length, count - offset);
      part.copy(value, offset, 0, size);
      offset += size;
      if (size === part.length) this.chunkIndex += 1;
      else this.chunks[this.chunkIndex] = part.subarray(size);
    }
    this.bufferedBytes -= count;
    this.resetConsumedChunks();
    return value;
  }

  private resetConsumedChunks(): void {
    if (this.bufferedBytes === 0) {
      this.chunks = [];
      this.chunkIndex = 0;
    } else if (this.chunkIndex >= 1_024 && this.chunkIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
  }
}

function validateMaxFrameBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
    throw new RangeError("maxFrameBytes must be an integer in 1..4294967295");
  }
}
