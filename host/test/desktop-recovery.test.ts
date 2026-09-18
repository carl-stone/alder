import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRecoveryStore } from "../../desktop/src/recovery-store.js";
import { DesktopRecoveryStore, type DesktopRecoveryCall } from "../src/browser/desktop-recovery.js";
import type { BrowserRecoveryDraft } from "../src/browser/transport.js";

const keyId = randomBytes(32).toString("base64url");
const draft: BrowserRecoveryDraft = {
  schemaVersion: 1, clientId: "client-before-restart",
  base: { epoch: "before-restart", cursor: 4, version: 2, documentRevision: 0,
    cells: [{ id: "cell-1", revision: 0, type: "code", body: ["x <- 1"] }] },
  changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0, cellType: "code", body: ["x <- 42"] }],
  operation: null,
};
const bridge = (store: NativeRecoveryStore): DesktopRecoveryCall => async request => {
  switch (request.action) {
    case "read": return store.read(request.keyId, request.name!);
    case "write": return store.write(request.keyId, request.name!, request.value);
    case "remove": return store.remove(request.keyId, request.name!);
    case "list": return store.list(request.keyId, request.prefix!);
  }
};
const recordPath = (root: string, name: string): string => join(root, keyId, createHash("sha256").update(name).digest("hex") + ".json");

async function temporary(): Promise<string> { return realpath(await mkdtemp(join(tmpdir(), "alder-desktop-recovery-"))); }

test("desktop drafts, branches and cursor survive a new renderer origin and native store instance", async () => {
  const directory = await temporary();
  try {
    const renderer = new DesktopRecoveryStore(keyId, bridge(new NativeRecoveryStore(directory)));
    await renderer.save("old-epoch", 17);
    await renderer.saveDraft(draft);
    await renderer.saveBranch("before-crash", draft);
    // A replacement renderer receives only the stable key; its origin is deliberately irrelevant.
    const reopened = new DesktopRecoveryStore(keyId, bridge(new NativeRecoveryStore(directory)));
    assert.deepEqual(await reopened.load(), { epoch: "old-epoch", cursor: 17 });
    assert.deepEqual(await reopened.loadDraft(draft.clientId), draft);
    assert.deepEqual(await reopened.listDrafts(), [draft]);
    assert.deepEqual(await reopened.listBranches(), [{ id: "before-crash", draft }]);
    assert.equal(await new NativeRecoveryStore(directory).read(randomBytes(32).toString("base64url"), "draft:" + draft.clientId), null);
    await reopened.clearDraft(draft.clientId);
    await reopened.deleteBranch("before-crash");
    await reopened.clear();
    assert.deepEqual(await reopened.listDrafts(), []);
    assert.deepEqual(await reopened.listBranches(), []);
    assert.equal(await reopened.load(), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("record identities cannot supply filesystem paths", async () => {
  const directory = await temporary();
  try {
    const store = new NativeRecoveryStore(directory);
    for (const key of ["../outside", "a".repeat(42), "a".repeat(44), "x/" + "a".repeat(41)]) {
      await assert.rejects(store.write(key, "cursor", {}), /Invalid recovery identity/);
    }
    for (const name of ["../outside", "/tmp/notebook", "draft:../outside", "branch:..", "draft:a/b", "draft:a\\b", "draft:", "draft:" + "x".repeat(257)]) {
      await assert.rejects(store.write(keyId, name, {}), /Invalid recovery record name/);
      await assert.rejects(store.read(keyId, name), /Invalid recovery record name/);
      await assert.rejects(store.remove(keyId, name), /Invalid recovery record name/);
    }
    await assert.rejects(store.list(keyId, "../"), /Invalid recovery record prefix/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("damaged JSON is reported and retained when later work replaces that record", async () => {
  const directory = await temporary();
  try {
    const native = new NativeRecoveryStore(directory);
    const renderer = new DesktopRecoveryStore(keyId, bridge(native));
    await renderer.saveDraft(draft);
    const name = "draft:" + draft.clientId;
    const path = recordPath(directory, name);
    const corrupt = "{ incomplete recovery";
    await writeFile(path, corrupt, { mode: 0o600 });
    await assert.rejects(renderer.loadDraft(draft.clientId), { code: "desktop_recovery_corrupt" });
    assert.equal(await readFile(path, "utf8"), corrupt);
    await renderer.saveDraft({ ...draft, clientId: draft.clientId, base: { ...draft.base, cursor: 18 } });
    const retained = (await readdir(join(directory, keyId))).filter(name => name.startsWith("corrupt-"));
    assert.equal(retained.length, 1);
    assert.equal(await readFile(join(directory, keyId, retained[0]!), "utf8"), corrupt);
    assert.equal((await renderer.loadDraft(draft.clientId))!.base.cursor, 18);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("atomic writes expose complete old or new values and keep recovery private", async () => {
  const directory = await temporary();
  try {
    const store = new NativeRecoveryStore(directory);
    const makeValue = (revision: number) => ({ revision, body: String(revision).repeat(128 * 1024) });
    await store.write(keyId, "draft:atomic", makeValue(0));
    const writes = Promise.all(Array.from({ length: 8 }, (_, index) => store.write(keyId, "draft:atomic", makeValue(index + 1))));
    for (let index = 0; index < 30; index++) {
      const value = await store.read(keyId, "draft:atomic") as ReturnType<typeof makeValue>;
      assert.ok(value);
      assert.deepEqual(value, makeValue(value.revision));
    }
    await writes;
    assert.deepEqual(await store.read(keyId, "draft:atomic"), makeValue(8));
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await assert.rejects(store.write(keyId, "draft:atomic", circular));
    assert.deepEqual(await store.read(keyId, "draft:atomic"), makeValue(8));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, keyId))).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath(directory, "draft:atomic"))).mode & 0o777, 0o600);
    assert.equal((await readdir(join(directory, keyId))).some(name => name.startsWith(".pending-")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the browser adapter reports unavailable storage without modifying its caller's draft", async () => {
  const before = structuredClone(draft);
  const renderer = new DesktopRecoveryStore(keyId, async () => { throw new Error("Disk unavailable"); });
  await assert.rejects(renderer.saveDraft(draft), /Disk unavailable/);
  assert.deepEqual(draft, before);
});
