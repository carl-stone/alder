import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { listUntitledRecoveryDescriptors, registerUntitledRecoveryDescriptor, retireUntitledRecoveryDescriptor, selectUntitledRecoveryDescriptor } from "../src/sessions.js";

test("untitled recovery descriptors support explicit selection and exact retirement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-untitled-descriptor-"))); const id = randomUUID();
  try {
    const created = await registerUntitledRecoveryDescriptor(id, root, root);
    assert.deepEqual(await selectUntitledRecoveryDescriptor(id, root), created);
    assert.deepEqual(await listUntitledRecoveryDescriptors(root), [created]);
    await retireUntitledRecoveryDescriptor(created, root);
    assert.deepEqual(await listUntitledRecoveryDescriptors(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
