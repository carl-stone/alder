export interface StrictJsonLimits {
  maxBytes: number;
  maxDepth: number;
}

export const DEFAULT_STRICT_JSON_LIMITS: StrictJsonLimits = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 64,
});

export class StrictJsonError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "StrictJsonError";
  }
}

class StrictJsonParser {
  private offset = 0;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
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
    if (depth > this.maxDepth) this.fail("JSON nesting limit exceeded");
  }

  private fail(message: string): never {
    throw new StrictJsonError(message, this.encoder.encode(this.text.slice(0, this.offset)).byteLength);
  }
}

export function parseStrictJson(
  input: string | Uint8Array,
  limits: StrictJsonLimits = DEFAULT_STRICT_JSON_LIMITS,
): unknown {
  validateLimits(limits);
  let text: string;
  if (typeof input === "string") {
    if (hasUnpairedSurrogate(input)) throw new StrictJsonError("unpaired surrogate", 0);
    if (new TextEncoder().encode(input).byteLength > limits.maxBytes) {
      throw new RangeError(`JSON input exceeds ${limits.maxBytes} bytes`);
    }
    text = input;
  } else {
    if (!(input instanceof Uint8Array)) throw new TypeError("JSON input must be text or bytes");
    if (input.byteLength > limits.maxBytes) throw new RangeError(`JSON input exceeds ${limits.maxBytes} bytes`);
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new StrictJsonError("invalid UTF-8", 0);
    }
  }
  return new StrictJsonParser(text, limits.maxDepth).parse();
}

function validateLimits(limits: StrictJsonLimits): void {
  if (!limits || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1) {
    throw new RangeError("maxDepth must be a positive safe integer");
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
