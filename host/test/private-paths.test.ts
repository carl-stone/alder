import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  PrivatePathError,
  readPrivateFile,
  securePrivateFile,
  verifyPrivateFile,
  writePrivateFile,
  type PrivatePathNativeResult,
} from "../src/private-paths.js";

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function privatePathFailure(code: PrivatePathError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof PrivatePathError && error.code === code;
}

test("ensurePrivateFile preserves an existing private file and rejects oversharing", async () => {
  const root = await temporaryDirectory("alder-private-file-");
  const path = join(root, "state");
  try {
    await writeFile(path, "before", { mode: 0o600 });
    await ensurePrivateFile(path);
    assert.equal((await readFile(path, "utf8")), "before");

    await chmod(path, 0o644);
    await assert.rejects(() => ensurePrivateFile(path), privatePathFailure("private_path_overshared"));
    assert.equal(await readFile(path, "utf8"), "before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readPrivateFile rejects metadata changes between fstats", async () => {
  const root = await temporaryDirectory("alder-private-read-change-");
  const path = join(root, "state");
  try {
    await writeFile(path, "before", { mode: 0o600 });
    await assert.rejects(
      () => readPrivateFile(path, {
        beforeRead: async () => { await writeFile(path, "after", { mode: 0o600 }); },
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
    await assert.rejects(() => writePrivateFile(path, Buffer.from("after")), privatePathFailure("private_path_overshared"));
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

test("Windows private reads cross the native supervisor boundary", async () => {
  const root = await temporaryDirectory("alder-private-native-");
  const path = join(root, "state");
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const invokeNative = async (executable: string, args: readonly string[]): Promise<PrivatePathNativeResult> => {
    calls.push({ executable, args: [...args] });
    return { status: 0, stdout: args[1] === "read" ? Uint8Array.from([1, 2, 3]) : new Uint8Array(), stderr: "" };
  };
  try {
    await writeFile(path, "placeholder", { mode: 0o644 });
    const options = {
      platform: "win32" as const,
      processSupervisorExecutable: "alder-process-supervisor.exe",
      invokeNative,
    };
    assert.deepEqual(await readPrivateFile(path, { ...options, maxBytes: 3 }), Buffer.from([1, 2, 3]));
    await verifyPrivateFile(path, options);
    await securePrivateFile(path, options);
    assert.deepEqual(calls.map(call => [call.executable, ...call.args]), [
      ["alder-process-supervisor.exe", "--private-path", "read", resolve(path)],
      ["alder-process-supervisor.exe", "--private-path", "verify", "file", resolve(path)],
      ["alder-process-supervisor.exe", "--private-path", "secure", "file", resolve(path)],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows native read enforces its byte limit at the TypeScript boundary", async () => {
  const root = await temporaryDirectory("alder-private-native-limit-");
  const path = join(root, "state");
  try {
    await writeFile(path, "placeholder", { mode: 0o600 });
    await assert.rejects(
      () => readPrivateFile(path, {
        platform: "win32",
        processSupervisorExecutable: "alder-process-supervisor.exe",
        invokeNative: async (): Promise<PrivatePathNativeResult> => ({ status: 0, stdout: Uint8Array.from([1, 2]), stderr: "" }),
        maxBytes: 1,
      }),
      privatePathFailure("private_path_too_large"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
