import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHost } from "../src/application.js";
import { parseHostCommand } from "../src/protocol.js";
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

test("development staging includes an installed Ark and R helper library", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-headless-tools-test-"));
  const root = join(directory, "application");
  const ark = join(directory, "ark");
  const library = join(directory, "r-library");
  try {
    await writeFile(ark, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await mkdir(library);
    await writeFile(join(library, "sentinel"), "helper");
    execFileSync(process.execPath, [stageScript, "--output", root, "--ark", ark, "--r-library", library]);
    const resources = await resolveApplicationResources(root);
    assert.equal(await realpath(resources.arkExecutable), await realpath(ark));
    assert.equal(await readFile(join(resources.rLibraryDirectory, "sentinel"), "utf8"), "helper");
    assert.equal((await realpath(resources.rLibraryDirectory)).startsWith(await realpath(root)), true);
    assert.equal((await realpath(resources.workerDirectory)).startsWith(await realpath(root)), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("edit-only development root serves and saves a notebook without R tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-headless-edit-test-"));
  const root = join(directory, "application");
  const notebook = join(directory, "notebook.R");
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    await writeFile(notebook, "# %%\nx <- 1\n");
    execFileSync(process.execPath, [stageScript, "--output", root]);
    app = await startHost({ path: notebook, resources: await resolveApplicationResources(root),
      recoveryDirectory: join(directory, "recovery"), suppressStartup: true });
    assert.equal(app.ready.type, "host.ready");
    const response = await fetch(app.ready.origin);
    assert.equal(response.status, 200);
    for (const asset of ["/static/style.css", "/static/host-app.js", "/static/vendor/alder-editor.js"]) {
      const file = await fetch(app.ready.origin + asset);
      assert.equal(file.status, 200, `${asset} must load from the staged root`);
    }
    const cell = app.controller.snapshot().cells[0]!;
    const command = (type: "transaction" | "save", changes?: unknown[]) => parseHostCommand({
      type, ...(changes === undefined ? {} : { changes }), requestId: randomUUID(), clientId: "dev-root-test",
      sessionEpoch: app!.controller.snapshot().epoch,
      expectedDocumentRevision: app!.controller.snapshot().documentRevision,
    });
    const edit = await app.controller.dispatch(command("transaction", [{ type: "edit", cell: { cellId: cell.id },
      expectedRevision: cell.revision, cellType: "code", body: ["x <- 42"] }]));
    assert.equal(edit.error, null);
    const save = await app.controller.dispatch(command("save"));
    assert.equal(save.error, null);
    assert.equal(await readFile(notebook, "utf8"), "# %%\nx <- 42\n");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged Linux notebook runs 6 * 7 through Ark", { skip: process.platform !== "linux" || !process.env.ALDER_LINUX_DEV_ROOT,
  timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-headless-run-test-"));
  const notebook = join(directory, "notebook.R");
  let app: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    await writeFile(notebook, "# %%\n6 * 7\n");
    app = await startHost({ path: notebook,
      resources: await resolveApplicationResources(process.env.ALDER_LINUX_DEV_ROOT!),
      recoveryDirectory: join(directory, "recovery"), suppressStartup: true });
    const deadline = Date.now() + 60_000;
    while (!app.controller.snapshot().runtime.executionReady) {
      const runtime = app.controller.snapshot().runtime;
      assert.equal(runtime.executionBlockedReason, null);
      assert.ok(Date.now() < deadline, "R kernel did not become ready");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const run = await app.controller.dispatch(parseHostCommand({
      type: "run", scope: "all", requestId: randomUUID(), clientId: "linux-dev-test",
      sessionEpoch: app.controller.snapshot().epoch,
      expectedDocumentRevision: app.controller.snapshot().documentRevision,
    }));
    assert.equal(run.error, null);
    while (app.controller.snapshot().cells[0]?.outputs.length === 0) {
      assert.equal(app.controller.snapshot().cells[0]?.error, null);
      assert.ok(Date.now() < deadline, "Ark did not produce a cell output");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((app.controller.snapshot().cells[0]!.outputs[0]!.data as { text?: string }).text, "[1] 42");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
