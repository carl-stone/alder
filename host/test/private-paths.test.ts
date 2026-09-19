import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ensurePrivateDirectory,
  PrivatePathError,
  readPrivateFile,
  securePrivateFile,
  verifyPrivateFile,
  writePrivateFile,
} from "../src/private-paths.js";

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return root;
}

function privatePathFailure(code: PrivatePathError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof PrivatePathError && error.code === code;
}

const privateOptions = {};

test("readPrivateFile rejects metadata changes between fstats", async () => {
  const root = await temporaryDirectory("alder-private-read-change-");
  const path = join(root, "state");
  try {
    await writeFile(path, "before", { mode: 0o600 });
    await assert.rejects(
      () => readPrivateFile(path, {
        ...privateOptions,
        beforeRead: async () => {
          await writeFile(path, "after", { mode: 0o600 });
        },
      }),
      privatePathFailure("private_path_invalid"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("writePrivateFile refuses to replace an overshared target", async () => {
  const root = await temporaryDirectory("alder-private-write-");
  const path = join(root, "state");
  try {
    await writeFile(path, "before", { mode: 0o644 });
    await assert.rejects(() => writePrivateFile(path, Buffer.from("after"), privateOptions), privatePathFailure("private_path_overshared"));
    assert.equal(await readFile(path, "utf8"), "before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private paths reject a symlinked parent before creating state", async () => {
  const root = await temporaryDirectory("alder-private-link-");
  const target = join(root, "target");
  const alias = join(root, "alias");
  try {
    await symlink(target, alias, "dir");
    await assert.rejects(
      () => ensurePrivateDirectory(join(alias, "state")),
      privatePathFailure("private_path_reparse"),
    );
    await assert.rejects(() => lstat(join(alias, "state")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
