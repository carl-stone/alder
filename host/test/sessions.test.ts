import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { listUntitledRecoveryDescriptors, registerUntitledRecoveryDescriptor, retireUntitledRecoveryDescriptor, selectUntitledRecoveryDescriptor, untitledRecoveryDescriptorDirectory } from "../src/sessions.js";

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

test("untitled recovery descriptors migrate a live project alias to its physical directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-untitled-alias-")));
  const project = join(root, "project");
  const alias = join(root, "project-alias");
  const id = randomUUID();
  try {
    await mkdir(project);
    await symlink(project, alias, "dir");
    const created = await registerUntitledRecoveryDescriptor(id, project, root);
    const descriptorPath = join(untitledRecoveryDescriptorDirectory(root), `${id}.json`);
    await writeFile(descriptorPath, JSON.stringify({ ...created, projectDirectory: alias }));

    const selected = await selectUntitledRecoveryDescriptor(id, root);
    assert.equal(selected.projectDirectory, await realpath(project));
    assert.equal(JSON.parse(await readFile(descriptorPath, "utf8")).projectDirectory, selected.projectDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
