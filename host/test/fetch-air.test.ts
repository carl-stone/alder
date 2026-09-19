import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageAir } from "../scripts/fetch-air.mjs";

test("Air staging rejects corrupt cached and supplied archives before extraction", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-air-integrity-"));
  const asset = process.arch === "arm64" ? "air-aarch64-apple-darwin.tar.gz" : "air-x86_64-apple-darwin.tar.gz";
  const cache = join(root, "cache");
  const supplied = join(root, "supplied.tar.gz");
  try {
    await mkdir(cache);
    await writeFile(join(cache, asset), "corrupt cached archive");
    await assert.rejects(stageAir({ output: join(root, "cached-output"), cacheDirectory: cache }), /Air archive checksum mismatch/);

    await writeFile(supplied, "corrupt supplied archive");
    await assert.rejects(stageAir({ output: join(root, "supplied-output"), archive: supplied }), /Air archive checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
