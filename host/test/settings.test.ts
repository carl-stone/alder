import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startHost, type RunningHost } from "../src/application.js";
import { ApplicationPreferences } from "../src/preferences.js";
import { BrowserDocument } from "../src/browser/document.js";
import { parseHostCommand } from "../src/protocol.js";
import type { ApplicationResources } from "../src/resources.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-settings-")));
  const hosts: RunningHost[] = [];
  const preferencePath = join(root, "application", "preferences.yaml");
  const resources: ApplicationResources = {
    root, cliLauncher: join(root, "alder"), hostEntry: join(root, "host.mjs"),
    rendererDirectory: join(root, "renderer"), workerDirectory: join(root, "worker"),
    rLibraryDirectory: join(root, "r-library"), arkExecutable: join(root, "ark"), airExecutable: join(root, "air"), quartoExecutable: join(root, "quarto"),
    nodeExecutable: process.execPath, electronEntry: null,
  };
  return {
    root, preferencePath,
    async open(path: string, preferences?: ApplicationPreferences, extra = {}) {
      const host = await startHost({ path, resources,
        preferences, preferencesPath: preferencePath, recoveryDirectory: join(root, "recovery"),
        ...extra });
      hosts.push(host);
      return host;
    },
    async notebook(name: string, source = "# %%\nx <- 1\n") {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      return path;
    },
    async close() { await Promise.allSettled(hosts.map(host => host.close())); await rm(root, { recursive: true, force: true }); },
  };
}

async function command(host: RunningHost, input: Record<string, unknown>) {
  const snapshot = host.controller.snapshot();
  const request = parseHostCommand({ requestId: randomUUID(), clientId: "settings-test", sessionEpoch: snapshot.epoch,
    ...(input.type === "set-preferences" ? { expectedPreferencesVersion: snapshot.preferencesVersion } : { expectedDocumentRevision: snapshot.documentRevision }),
    ...(input.type === "set-config" ? { expectedSidecarVersion: snapshot.sidecars.config.version } : {}), ...input });
  return host.controller.dispatch(request);
}
async function success(host: RunningHost, input: Record<string, unknown>) {
  const result = await command(host, input);
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result;
}
async function edit(host: RunningHost, text: string) {
  const cell = host.controller.snapshot().cells[0]!;
  await success(host, { type: "transaction", changes: [{ type: "edit", cell: { cellId: cell.id }, expectedRevision: cell.revision, cellType: "code", body: [text] }] });
}

test("settings have one owner across open notebooks, projects, and relaunch", async () => {
  const f = await fixture();
  const preferences = await ApplicationPreferences.open(f.preferencePath);
  try {
    const original = "# ---\n# title: Scientific notebook\n# vendor: keep-me\n# runtime:\n#   vendor: keep-this-too\n# app:\n#   width: full\n# ---\n# %%\nx <- 1\n";
    const pathA = await f.notebook("one/a.R", original);
    const pathB = await f.notebook("two/b.R");
    const a = await f.open(pathA, preferences);
    const b = await f.open(pathB, preferences);
    const browserA = new BrowserDocument(a.controller.snapshot());
    const browserB = new BrowserDocument(b.controller.snapshot());
    a.controller.subscribe(event => browserA.applyEvent(event));
    b.controller.subscribe(event => browserB.applyEvent(event));
    assert.equal(a.controller.snapshot().config.theme, "system");
    assert.equal(a.controller.snapshot().dirty, false);
    await edit(a, "x <- 29");
    const revision = a.controller.snapshot().documentRevision;
    await success(b, { type: "set-preferences", patch: { theme: "dark", editor: { font_size: 18 } } });
    for (const host of [a, b]) {
      assert.equal(host.controller.snapshot().config.theme, "dark");
      assert.equal((host.controller.snapshot().config.editor as { font_size: number }).font_size, 18);
    }
    assert.equal(a.controller.snapshot().documentRevision, revision);
    assert.equal(b.controller.snapshot().dirty, false, "preferences do not dirty notebook source");
    assert.equal(browserB.snapshot.config.theme, "dark");
    assert.equal(browserB.snapshot.dirty, false);
    assert.equal(await readFile(pathA, "utf8"), original);
    await success(a, { type: "set-runtime", on_cell_change: "lazy", on_startup: false, cache_enabled: false });
    assert.equal(a.controller.snapshot().runtime.executionMode, "lazy");
    assert.equal(b.controller.snapshot().runtime.executionMode, "automatic");
    assert.equal(browserA.snapshot.runtime.executionMode, "lazy");
    assert.equal(browserA.snapshot.runtime.runOnStartup, false);
    assert.deepEqual(browserA.snapshot.metadata, a.controller.snapshot().metadata);
    assert.equal(browserB.snapshot.runtime.executionMode, "automatic");
    const notebookRevision = a.controller.snapshot().documentRevision;
    const previousProjectVersion = a.controller.snapshot().sidecars.config.version;
    await success(a, { type: "set-config", patch: { cache: { dir: "project-cache" } } });
    assert.equal(a.controller.snapshot().documentRevision, notebookRevision, "project settings have their own sidecar version");
    const staleProjectChange = await command(a, { type: "set-config", patch: { cache: { dir: "stale-cache" } }, expectedSidecarVersion: previousProjectVersion });
    assert.equal(staleProjectChange.error?.code, "source_conflict");
    assert.equal((a.controller.snapshot().config.cache as { dir: string }).dir, "project-cache");
    assert.equal((b.controller.snapshot().config.cache as { dir: unknown }).dir, null);
    await success(a, { type: "save" });
    assert.equal(a.controller.snapshot().dirty, false);
    assert.equal(browserA.snapshot.dirty, false);
    const saved = await readFile(pathA, "utf8");
    assert.match(saved, /x <- 29/);
    assert.match(saved, /keep-me/);
    assert.match(saved, /keep-this-too/);
    assert.match(saved, /width: full/);
    assert.match(saved, /on_cell_change: lazy/);
    assert.doesNotMatch(saved, /theme:|font_size:|project-cache/);
    await a.close(); await b.close(); await preferences.close();
    const restoredPreferences = await ApplicationPreferences.open(f.preferencePath);
    const reopenedA = await f.open(pathA, restoredPreferences);
    const reopenedB = await f.open(pathB, restoredPreferences);
    assert.equal(reopenedA.controller.snapshot().dirty, false, "saved settings leave no pending notebook recovery");
    assert.equal(reopenedA.controller.snapshot().config.theme, "dark");
    assert.equal(reopenedB.controller.snapshot().config.theme, "dark");
    assert.equal(reopenedA.controller.snapshot().runtime.executionMode, "lazy");
    assert.equal(reopenedB.controller.snapshot().runtime.executionMode, "automatic");
    assert.equal((reopenedA.controller.snapshot().config.cache as { enabled: boolean }).enabled, false);
    assert.equal((reopenedB.controller.snapshot().config.cache as { enabled: boolean }).enabled, true);
    await restoredPreferences.close();
  } finally { await preferences.close(); await f.close(); }
});

test("launch execution choices remain editable notebook values", async () => {
  const f = await fixture();
  try {
    const path = await f.notebook("launch.R");
    const original = await readFile(path, "utf8");
    const launched = await f.open(path, undefined, { executionMode: "lazy", suppressStartup: true });
    assert.equal(launched.controller.snapshot().runtime.executionMode, "lazy");
    assert.equal(launched.controller.snapshot().runtime.runOnStartup, true, "--no-run does not alter the notebook setting");
    assert.equal(launched.controller.snapshot().dirty, true);
    assert.equal(await readFile(path, "utf8"), original, "--lazy uses Save, not a launch-time file rewrite");
    await launched.close();
    const host = await f.open(path);
    assert.equal(host.controller.snapshot().runtime.executionMode, "lazy", "the unsaved notebook choice is recoverable");
    await success(host, { type: "set-runtime", on_cell_change: "automatic", on_startup: true });
    assert.equal(host.controller.snapshot().runtime.executionMode, "automatic");
    assert.equal(host.controller.snapshot().runtime.runOnStartup, true);
    await success(host, { type: "save" });
    await host.close();
    const reopened = await f.open(path);
    assert.equal(reopened.controller.snapshot().runtime.executionMode, "automatic");
    assert.equal(reopened.controller.snapshot().runtime.runOnStartup, true);
  } finally { await f.close(); }
});

test("an unavailable selected R leaves preferences, editing, Save, and R selection available", async () => {
  const f = await fixture();
  try {
    const selected = join(f.root, "disappeared-Rscript");
    await mkdir(join(f.root, "r-library/alder"), { recursive: true });
    await writeFile(join(f.root, "r-library/alder/DESCRIPTION"), "Package: alder\nVersion: 0.1.0\n");
    await writeFile(join(f.root, "manifest.json"), JSON.stringify({
      schemaVersion: 1, kind: "headless", applicationVersion: "0.1.0",
      resources: { cliLauncher: "alder", hostEntry: "host.mjs", rendererDirectory: "renderer", workerDirectory: "worker", rLibraryDirectory: "r-library", arkExecutable: "ark", airExecutable: "air", quartoExecutable: "quarto", nodeExecutable: "node", electronEntry: null },
    }));
    await mkdir(dirname(f.preferencePath), { recursive: true });
    await writeFile(f.preferencePath, `rscript: ${JSON.stringify(selected)}\n`);
    const path = await f.notebook("missing-r.R");
    const host = await f.open(path);
    const deadline = Date.now() + 2_000;
    while (host.controller.snapshot().runtime.executionBlockedReason === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(host.controller.snapshot().runtime.executionBlockedReason?.message ?? "", /selected Rscript was not found/);
    assert.equal(host.controller.snapshot().config.rscript, selected);
    await success(host, { type: "set-preferences", patch: { theme: "dark" } });
    await edit(host, "answer <- 42");
    await success(host, { type: "save" });
    assert.match(await readFile(path, "utf8"), /answer <- 42/);
    const change = await command(host, { type: "select-r", rscript: join(f.root, "another-missing-Rscript") });
    assert.equal(change.error?.code, "r_not_found");
  } finally { await f.close(); }
});

test("invalid notebook settings reject ineffective changes while opening and saving remain available", async () => {
  const f = await fixture();
  try {
    for (const runtime of ["# runtime: false", "# runtime:\n#   on_startup: invalid"]) {
      const path = await f.notebook(`${runtime.includes("false") ? "mapping" : "field"}.R`, `# ---\n${runtime}\n# ---\n# %%\nx <- 1\n`);
      const host = await f.open(path, undefined, { executionMode: "lazy" });
      assert.ok(host.controller.snapshot().serviceErrors.settings?.message.includes(path));
      assert.equal(host.controller.snapshot().runtime.executionMode, "automatic");
      assert.equal(host.controller.snapshot().dirty, false);
      const result = await command(host, { type: "set-runtime", on_cell_change: "lazy" });
      assert.ok(result.error, "a remaining invalid setting must not produce a successful ineffective change");
      assert.equal(host.controller.snapshot().dirty, false);
      await edit(host, "x <- 31");
      await success(host, { type: "save" });
      const saved = await readFile(path, "utf8");
      assert.ok(saved.includes(runtime));
      assert.match(saved, /x <- 31/);
      if (runtime.includes("invalid")) {
        await success(host, { type: "set-runtime", on_cell_change: "lazy", on_startup: false });
        assert.equal(host.controller.snapshot().runtime.executionMode, "lazy");
        assert.equal(host.controller.snapshot().runtime.runOnStartup, false);
        assert.equal(host.controller.snapshot().serviceErrors.settings, undefined);
      }
    }
  } finally { await f.close(); }
});

for (const owner of ["application", "project"] as const) {
  test(`malformed ${owner} settings stay on disk while notebook edits save`, async () => {
    const f = await fixture();
    try {
      const path = await f.notebook("project/book.R");
      const settingsPath = owner === "application" ? f.preferencePath : join(dirname(path), ".alder", "config.yaml");
      const malformed = "cache: [not finished\n";
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, malformed);
      const host = await f.open(path);
      assert.ok(host.controller.snapshot().serviceErrors.settings?.message.includes(settingsPath));
      await edit(host, "x <- 7");
      await success(host, { type: "save" });
      assert.match(await readFile(path, "utf8"), /x <- 7/);
      assert.equal(await readFile(settingsPath, "utf8"), malformed);
      const result = await command(host, owner === "application"
        ? { type: "set-preferences", patch: { theme: "dark" } }
        : { type: "set-config", patch: { cache: { dir: "new-cache" } } });
      assert.ok(result.error, "a malformed owner cannot be silently overwritten");
      assert.equal(await readFile(settingsPath, "utf8"), malformed);
    } finally { await f.close(); }
  });

  test(`failed ${owner} settings writes retain persisted and displayed values`, async () => {
    const f = await fixture();
    let settingsDirectory: string | undefined;
    try {
      const path = await f.notebook("project/book.R");
      const settingsPath = owner === "application" ? f.preferencePath : join(dirname(path), ".alder", "config.yaml");
      settingsDirectory = dirname(settingsPath);
      await mkdir(settingsDirectory, { recursive: true });
      const prior = owner === "application" ? "theme: light\n" : "cache:\n  dir: previous-cache\n";
      await writeFile(settingsPath, prior);
      const host = await f.open(path);
      await chmod(settingsDirectory, 0o500);
      const result = await command(host, owner === "application"
        ? { type: "set-preferences", patch: { theme: "dark" } }
        : { type: "set-config", patch: { cache: { dir: "new-cache" } } });
      assert.ok(result.error, "a failed settings write must fail the command");
      assert.equal(await readFile(settingsPath, "utf8"), prior);
      assert.equal(owner === "application" ? host.controller.snapshot().config.theme : (host.controller.snapshot().config.cache as { dir: string }).dir,
        owner === "application" ? "light" : "previous-cache");
      await edit(host, "x <- 17");
      await success(host, { type: "save" });
      assert.match(await readFile(path, "utf8"), /x <- 17/);
    } finally {
      if (settingsDirectory) await chmod(settingsDirectory, 0o700);
      await f.close();
    }
  });
}
