import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseNotebook, serializeNotebook } from "../src/notebook.js";
import { MAX_SOURCE_LINE_LENGTH } from "../src/protocol.js";
import { RecoveryWriter, type RecoveryBaseline } from "../src/recovery.js";
import { SeededRandom, seedLabel } from "./seeded.js";

const NOTEBOOK_SEED = 0xb00c2026;
const NOTEBOOK_CASES = 180;
const RECOVERY_SEED = 0x5ec02026;
const RECOVERY_CASES = 24;

test("seeded notebook inputs either round-trip exactly or fail within bounded parsing", { timeout: 5_000 }, (context) => {
  context.diagnostic(`seed=${seedLabel(NOTEBOOK_SEED)} cases=${NOTEBOOK_CASES} maxBytes=8192`);
  const random = new SeededRandom(NOTEBOOK_SEED);
  for (let caseIndex = 0; caseIndex < NOTEBOOK_CASES; caseIndex += 1) {
    const input = notebookInput(random, caseIndex);
    let parsed: ReturnType<typeof parseNotebook>;
    try {
      parsed = parseNotebook(input, `/generated/${caseIndex}.R`);
    } catch (error) {
      assert.ok(error instanceof Error, `seed=${seedLabel(NOTEBOOK_SEED)} case=${caseIndex}`);
      assert.ok(error.message.length > 0 && error.message.length < 4_096,
        `unbounded parse error; seed=${seedLabel(NOTEBOOK_SEED)} case=${caseIndex}`);
      continue;
    }
    const serialized = serializeNotebook(parsed);
    if (!Buffer.from(serialized).equals(Buffer.from(input))) {
      const minimized = minimizeRoundTripFailure(input);
      assert.fail(`round-trip changed bytes; seed=${seedLabel(NOTEBOOK_SEED)} case=${caseIndex} minimized=${summarize(minimized)}`);
    }
  }
  const oversizedLine = Buffer.from(`# %%\n${"x".repeat(MAX_SOURCE_LINE_LENGTH + 1)}`);
  assert.throws(() => parseNotebook(oversizedLine, "/generated/oversized.R"), { code: "line_too_long" });
});

test("seeded corrupt recovery journals preserve saved source and valid journals round-trip", { timeout: 8_000 }, async (context) => {
  context.diagnostic(`seed=${seedLabel(RECOVERY_SEED)} corruptCases=${RECOVERY_CASES} validCases=12 maxReproducerBytes=256`);
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-generated-recovery-")));
  const savedPath = join(root, "saved.R");
  const savedBytes = Buffer.from('# %%\nsaved <- "café"\n');
  await writeFile(savedPath, savedBytes);
  const random = new SeededRandom(RECOVERY_SEED);
  try {
    for (let caseIndex = 0; caseIndex < RECOVERY_CASES; caseIndex += 1) {
      const key = `corrupt-${caseIndex}`;
      const writer = await RecoveryWriter.open({ rootDir: root, key, baseline: baseline(savedPath, savedBytes, 0) });
      const recovered = Buffer.from(`# %%\naccepted <- ${caseIndex}\n`);
      writer.update(baseline(savedPath, recovered, caseIndex + 1));
      await writer.flush();
      const valid = await readFile(writer.journalPath);
      await writer.close();
      const damage = damageJournal(random, valid, caseIndex);
      await writeFile(writer.journalPath, damage.bytes);

      const reopened = await RecoveryWriter.open({ rootDir: root, key, baseline: baseline(savedPath, savedBytes, 0) });
      const state = await reopened.load();
      const replay = `seed=${seedLabel(RECOVERY_SEED)} case=${caseIndex} reproducer=${JSON.stringify(damage.reproducer)}`;
      assert.equal(reopened.issue?.code, "recovery_corrupt", replay);
      assert.equal(state.pending, false, replay);
      assert.deepEqual(decodePhysical(state.baseline.physicalBytes), savedBytes,
        `fallback changed; ${replay}`);
      assert.deepEqual(await readFile(savedPath), savedBytes,
        `saved source overwritten; ${replay}`);
      assert.deepEqual(await readFile(writer.journalPath), damage.bytes,
        `corrupt journal was not retained; ${replay}`);
      await reopened.close();
    }

    for (let caseIndex = 0; caseIndex < 12; caseIndex += 1) {
      const key = `valid-${caseIndex}`;
      const source = Buffer.from(validNotebook(random, 1 + random.integer(5)));
      const expected = baseline(savedPath, source, caseIndex + 1);
      const writer = await RecoveryWriter.open({ rootDir: root, key, baseline: baseline(savedPath, savedBytes, 0) });
      writer.update(expected);
      await writer.flush();
      await writer.close();
      const reopened = await RecoveryWriter.open({ rootDir: root, key, baseline: baseline(savedPath, savedBytes, 0) });
      const state = await reopened.load();
      assert.equal(state.pending, true, `seed=${seedLabel(RECOVERY_SEED)} validCase=${caseIndex}`);
      // Recovery ID and issue state are writer lifecycle fields; every source-truth
      // field in the normalized baseline is stable and must match exactly.
      assert.deepEqual(state.baseline, expected);
      assert.deepEqual(decodePhysical(state.baseline.physicalBytes), source);
      assert.equal(state.fingerprint, createHash("sha256").update(JSON.stringify(expected)).digest("hex"));
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opening and closing a valid idle recovery writer prunes accumulated corrupt copies", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-recovery-lifecycle-prune-")));
  const savedPath = join(root, "saved.R");
  const savedBytes = Buffer.from("# %%\nvalue <- 1\n");
  await writeFile(savedPath, savedBytes);
  const initial = await RecoveryWriter.open({ rootDir: root, key: "lifecycle-prune", baseline: baseline(savedPath, savedBytes, 0) });
  const directory = dirname(initial.journalPath);
  await initial.close();
  for (let index = 0; index < 9; index++) {
    const path = join(directory, `corrupt-planted-${index}.json`);
    await writeFile(path, String(index));
    const time = new Date(Date.now() - index * 40 * 24 * 60 * 60 * 1000);
    await utimes(path, time, time);
  }
  const reopened = await RecoveryWriter.open({ rootDir: root, key: "lifecycle-prune", baseline: baseline(savedPath, savedBytes, 0) });
  assert.ok((await readdir(directory)).filter(name => name.startsWith("corrupt-")).length <= 3);
  for (let index = 0; index < 7; index++) {
    const path = join(directory, `corrupt-close-${index}.json`);
    await writeFile(path, String(index));
    const time = new Date(Date.now() - (index + 1) * 40 * 24 * 60 * 60 * 1000);
    await utimes(path, time, time);
  }
  await reopened.close();
  assert.ok((await readdir(directory)).filter(name => name.startsWith("corrupt-")).length <= 3);
  await rm(root, { recursive: true, force: true });
});

function notebookInput(random: SeededRandom, caseIndex: number): Uint8Array {
  const valid = Buffer.from(validNotebook(random, 1 + random.integer(7)));
  switch (caseIndex % 7) {
    case 0: return caseIndex % 14 === 0 ? withBom(valid) : valid;
    case 1: return valid.subarray(0, random.integer(valid.length));
    case 2: {
      const bytes = Buffer.from(valid);
      if (bytes.length > 0) bytes[random.integer(bytes.length)] = 0;
      return bytes;
    }
    case 3: return Buffer.concat([valid, Buffer.from([0xc3, 0x28])]);
    case 4: return Buffer.from(`# ---\n# duplicate: one\n# duplicate: two\n# ---\n${valid.toString("utf8")}`);
    case 5: return Buffer.from(Array.from({ length: 1 + random.integer(256) }, () => random.integer(256)));
    default: return Buffer.from(`# %% [markdown]\n${"# ".repeat(random.integer(8))}${random.pick(["é", "λ", "🧬", "\u2028", "\u2029"])}\r\n`);
  }
}

function withBom(input: Buffer): Buffer {
  const body = input.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? input.subarray(3) : input;
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}

function validNotebook(random: SeededRandom, cells: number): string {
  const eols = ["\n", "\r\n", "\r"];
  let source = random.boolean(0.2) ? "\ufeff" : "";
  if (random.boolean(0.4)) source += `# generated ${random.pick(["café", "λ", "🧬"])}${random.pick(eols)}`;
  for (let index = 0; index < cells; index += 1) {
    const eol = random.pick(eols);
    const markdown = random.boolean(0.25);
    source += markdown ? `# %% [markdown]${eol}# ${random.pick(["text", "café", "λ", "🧬"])}${eol}`
      : `# %%${eol}value_${index} <- ${random.integer(100)}${eol}value_${index}${eol}`;
  }
  return random.boolean(0.35) ? source.replace(/(?:\r\n|\r|\n)$/, "") : source;
}

function baseline(path: string, bytes: Uint8Array, revision: number): RecoveryBaseline {
  const notebook = parseNotebook(bytes, path);
  return {
    schemaVersion: 1,
    physicalBytes: Buffer.from(bytes).toString("base64"),
    documentRevision: revision,
    cells: notebook.cells.map((cell) => ({ id: cell.id, revision })),
    path,
    notebookDiskObservation: { state: "present", digest: "a".repeat(64), version: "generated", identity: "generated", mode: 0o600 },
  };
}

function damageJournal(random: SeededRandom, valid: Buffer, caseIndex: number): {
  bytes: Buffer;
  reproducer: Record<string, string | number>;
} {
  switch (caseIndex % 6) {
    case 0: {
      const length = random.integer(valid.length);
      return { bytes: valid.subarray(0, length), reproducer: { kind: "truncate", length } };
    }
    case 1: return exactReplacement("invalid-json", Buffer.from("{damaged"));
    case 2: return exactReplacement("missing-baseline", Buffer.from(JSON.stringify({ schemaVersion: 1, baseline: null, fingerprint: "bad" })));
    case 3: {
      const value = JSON.parse(valid.toString("utf8")) as Record<string, unknown>;
      value.fingerprint = "0".repeat(64);
      return { bytes: Buffer.from(JSON.stringify(value)), reproducer: { kind: "replace-fingerprint", value: "0".repeat(64) } };
    }
    case 4: return exactReplacement("random-bytes", Buffer.from(Array.from({ length: 1 + random.integer(64) }, () => random.integer(256))));
    default: return exactReplacement("wrong-root", Buffer.from("[]"));
  }
}

function exactReplacement(kind: string, bytes: Buffer): { bytes: Buffer; reproducer: Record<string, string | number> } {
  return { bytes, reproducer: { kind, payloadHex: bytes.toString("hex") } };
}

function decodePhysical(value: RecoveryBaseline["physicalBytes"]): Buffer {
  return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function summarize(input: Uint8Array): string {
  const encoded = Buffer.from(input.subarray(0, 96)).toString("base64");
  return `${input.byteLength}:${encoded}`;
}

function minimizeRoundTripFailure(input: Uint8Array): Uint8Array {
  let current = new Uint8Array(input);
  for (let width = Math.max(1, Math.floor(current.byteLength / 2)); width >= 1; width = Math.floor(width / 2)) {
    let offset = 0;
    while (offset < current.byteLength) {
      const candidate = Buffer.concat([Buffer.from(current.subarray(0, offset)), Buffer.from(current.subarray(offset + width))]);
      try {
        const serialized = serializeNotebook(parseNotebook(candidate, "/generated/minimized.R"));
        if (!Buffer.from(serialized).equals(candidate)) { current = candidate; continue; }
      } catch { /* a parser rejection is not the original round-trip failure */ }
      offset += width;
    }
  }
  return current;
}
