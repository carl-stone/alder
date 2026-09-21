import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveApplicationResources } from "../src/resources.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stageScript = join(repositoryRoot, "host/scripts/stage-headless-dev.mjs");

test("development staging resolves a runnable headless host from the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-headless-dev-test-"));
  const root = join(directory, "application");
  try {
    const launcher = execFileSync(process.execPath, [stageScript, "--output", root], { encoding: "utf8" }).trim();
    assert.equal(launcher, join(root, "bin/alder"));
    const resources = await resolveApplicationResources(root);
    assert.equal(resources.manifest?.kind, "headless");
    assert.equal(resources.electronEntry, null);
    const info = JSON.parse(execFileSync(launcher, ["--host-info"], { encoding: "utf8" })) as {
      type: string;
      resources: { root: string; hostEntry: string; rendererDirectory: string };
    };
    assert.equal(info.type, "host.info");
    assert.equal(info.resources.root, resources.root);
    assert.equal(info.resources.hostEntry, resources.hostEntry);
    assert.equal(info.resources.rendererDirectory, resources.rendererDirectory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
