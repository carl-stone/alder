import assert from "node:assert/strict";
import test from "node:test";

import {
  FrameDecoder,
  FrameProtocolError,
  encodeFrame,
} from "../src/framing.js";
import { parseJson } from "../src/json.js";
import { DEFAULT_MAX_ENGINE_FRAME_BYTES } from "../src/protocol.js";

test("framed JSON survives arbitrary chunk boundaries and coalescing", () => {
  const values = [
    { protocol: "alder-engine-v2", source: "é\n中", empty: [] },
    [true, false, null, -12.5e2],
  ];
  const wire = Buffer.concat(values.map((value) => encodeFrame(value)));
  const decoder = new FrameDecoder();
  const decoded: unknown[] = [];
  for (let offset = 0; offset < wire.length;) {
    const size = Math.min((offset % 7) + 1, wire.length - offset);
    decoded.push(...decoder.push(wire.subarray(offset, offset + size)));
    offset += size;
  }
  decoder.finish();
  assert.deepEqual(decoded, values);
});

test("JSON boundaries use the standard parser with byte and UTF-8 limits", () => {
  const json = "{\n  \"ok\": true,\n  \"value\": 1e20\n}";
  assert.deepEqual(parseJson(new TextEncoder().encode(json), 128), { ok: true, value: 1e20 });
  assert.deepEqual(parseJson('{"same":1,"same":2}'), { same: 2 });
  assert.throws(() => parseJson(new Uint8Array(129), 128), /exceeds 128 bytes/);
  assert.throws(() => parseJson(Uint8Array.from([0xc3, 0x28]), 128), /valid UTF-8/);
});
test("decoder rejects invalid lengths, UTF-8 and truncated frames permanently", () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(33, 0);
  const bounded = new FrameDecoder(32);
  assert.throws(() => bounded.push(oversized), /outside 1\.\.32/);
  assert.throws(() => bounded.push(encodeFrame({ ok: true })), /failed state/);

  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => new FrameDecoder().push(invalidUtf8), /valid UTF-8/);

  const truncated = new FrameDecoder();
  truncated.push(encodeFrame({ ok: true }).subarray(0, 6));
  assert.throws(() => truncated.finish(), /truncated frame/);
});

test("encoder applies the byte limit to UTF-8 JSON", () => {
  const frame = encodeFrame("é", 4);
  assert.equal(frame.readUInt32BE(0), 4);
  assert.equal(frame.subarray(4).toString("utf8"), '"é"');
  assert.throws(() => encodeFrame("é", 3), FrameProtocolError);
  assert.throws(() => encodeFrame(1n), /cannot be encoded/);
});

test("private engine frames do not raise the public eight MiB default", () => {
  const value = { source: "x".repeat(8 * 1024 * 1024) };
  assert.throws(() => encodeFrame(value), /outside 1/);
  const wire = encodeFrame(value, DEFAULT_MAX_ENGINE_FRAME_BYTES);
  const decoder = new FrameDecoder(DEFAULT_MAX_ENGINE_FRAME_BYTES);
  const decoded: unknown[] = [];
  for (let offset = 0; offset < wire.length; offset += 65_521) {
    decoded.push(...decoder.push(wire.subarray(offset, offset + 65_521)));
  }
  decoder.finish();
  assert.deepEqual(decoded, [value]);
});
