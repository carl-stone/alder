import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRecoveryStore } from "../../desktop/src/recovery-store.js";
import { DesktopRecoveryStore, type DesktopRecoveryCall } from "../src/browser/desktop-recovery.js";
import type { BrowserRecoveryDraft } from "../src/browser/transport.js";

const recoveryId = randomBytes(32).toString("base64url");
const draft: BrowserRecoveryDraft = {
  schemaVersion: 2, draftId: "window-before-restart", updatedAt: 1,
  base: { epoch: "before-restart", documentRevision: 0,
    cells: [{ id: "cell-1", revision: 0, type: "code", body: ["x <- 1"] }] },
  changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0, cellType: "code", body: ["x <- 42"] }],
  submission: null, pendingRun: null,
};
const bridge = (store: NativeRecoveryStore): DesktopRecoveryCall => async request => {
  switch (request.action) {
    case "read": return store.read(request.recoveryId, request.name!);
    case "write": return store.write(request.recoveryId, request.name!, request.value);
    case "remove": return store.remove(request.recoveryId, request.name!);
  }
};
const recordPath = (root: string, name: string): string => join(root, recoveryId, createHash("sha256").update(name).digest("hex") + ".json");

async function temporary(): Promise<string> { return realpath(await mkdtemp(join(tmpdir(), "alder-desktop-recovery-"))); }

test("plain desktop drafts survive new renderer origins and native store instances", async () => {
  const directory = await temporary();
  try {
    const renderer = new DesktopRecoveryStore(recoveryId, bridge(new NativeRecoveryStore(directory)));
    await renderer.saveDraft(draft);
    const reopened = new DesktopRecoveryStore(recoveryId, bridge(new NativeRecoveryStore(directory)));
    assert.deepEqual(await reopened.readDraft(draft.draftId), draft);
    assert.equal(await new NativeRecoveryStore(directory).read("different-document", "draft:" + draft.draftId), null);
    await reopened.clearDraft(draft.draftId);
    assert.equal(await reopened.readDraft(draft.draftId), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("record identities cannot supply filesystem paths", async () => {
  const directory = await temporary();
  try {
    const store = new NativeRecoveryStore(directory);
    for (const key of ["../outside", "", "a".repeat(129), "x/" + "a".repeat(41)]) {
      await assert.rejects(store.write(key, "cursor", {}), /Invalid recovery identity/);
    }
    for (const name of ["../outside", "/tmp/notebook", "draft:../outside", "branch:..", "draft:a/b", "draft:a\\b", "draft:", "draft:" + "x".repeat(257)]) {
      await assert.rejects(store.write(recoveryId, name, {}), /Invalid recovery record name/);
      await assert.rejects(store.read(recoveryId, name), /Invalid recovery record name/);
      await assert.rejects(store.remove(recoveryId, name), /Invalid recovery record name/);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("damaged JSON is reported and retained when later work replaces that record", async () => {
  const directory = await temporary();
  try {
    const native = new NativeRecoveryStore(directory);
    const renderer = new DesktopRecoveryStore(recoveryId, bridge(native));
    await renderer.saveDraft(draft);
    const name = "draft:" + draft.draftId;
    const path = recordPath(directory, name);
    const corrupt = "{ incomplete recovery";
    await writeFile(path, corrupt, { mode: 0o600 });
    await assert.rejects(new NativeRecoveryStore(directory).read(recoveryId, "draft:" + draft.draftId), { code: "desktop_recovery_corrupt" });
    assert.equal(await readFile(path, "utf8"), corrupt);
    await renderer.saveDraft({ ...draft, updatedAt: 18 });
    const retained = (await readdir(join(directory, recoveryId))).filter(name => name.startsWith("corrupt-"));
    assert.equal(retained.length, 1);
    assert.equal(await readFile(join(directory, recoveryId, retained[0]!), "utf8"), corrupt);
    assert.equal((await renderer.readDraft(draft.draftId))!.updatedAt, 18);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("atomic writes expose complete old or new values and keep recovery private", async () => {
  const directory = await temporary();
  try {
    const store = new NativeRecoveryStore(directory);
    const makeValue = (revision: number) => ({ revision, body: String(revision).repeat(128 * 1024) });
    await store.write(recoveryId, "draft:atomic", makeValue(0));
    const writes = Promise.all(Array.from({ length: 8 }, (_, index) => store.write(recoveryId, "draft:atomic", makeValue(index + 1))));
    for (let index = 0; index < 30; index++) {
      const value = await store.read(recoveryId, "draft:atomic") as ReturnType<typeof makeValue>;
      assert.ok(value);
      assert.deepEqual(value, makeValue(value.revision));
    }
    await writes;
    assert.deepEqual(await store.read(recoveryId, "draft:atomic"), makeValue(8));
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await assert.rejects(store.write(recoveryId, "draft:atomic", circular));
    assert.deepEqual(await store.read(recoveryId, "draft:atomic"), makeValue(8));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, recoveryId))).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath(directory, "draft:atomic"))).mode & 0o777, 0o600);
    assert.equal((await readdir(join(directory, recoveryId))).some(name => name.startsWith(".pending-")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the browser adapter reports unavailable storage without modifying its caller's draft", async () => {
  const before = structuredClone(draft);
  const renderer = new DesktopRecoveryStore(recoveryId, async () => { throw new Error("Disk unavailable"); });
  await assert.rejects(renderer.saveDraft(draft), /Disk unavailable/);
  assert.deepEqual(draft, before);
});
