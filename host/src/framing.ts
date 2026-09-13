import { DEFAULT_STRICT_JSON_LIMITS, StrictJsonError, parseStrictJson } from "./strict-json.js";

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
// A codec request can contain both the immutable 32 MiB disk version and the
// current 32 MiB source snapshot. Their exact per-line base64 representation
// needs about 90 MiB before bounded structural metadata.
export const DEFAULT_MAX_ENGINE_FRAME_BYTES = 128 * 1024 * 1024;

export class FrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameProtocolError";
  }
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

  constructor(
    readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    readonly maxNesting = DEFAULT_STRICT_JSON_LIMITS.maxDepth,
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
        try {
          values.push(parseStrictJson(body, {
            maxBytes: this.maxFrameBytes,
            maxDepth: this.maxNesting,
          }));
        } catch (error) {
          if (error instanceof StrictJsonError && error.message.startsWith("invalid UTF-8")) {
            throw new FrameProtocolError("frame body is not valid UTF-8");
          }
          throw error;
        }
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
