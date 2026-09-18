import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appConfig, parseYamlMapping, readNotebookSettings, readProjectSettings,
  serializeProjectSettings, setAppConfig, setNotebookSettings,
} from "../src/configuration.js";
import {
  configDefaults, notebookSettingsPatchSchema, preferencesPatchSchema,
  projectSettingsPatchSchema, resolveSettings,
} from "../src/settings.js";

test("owners compose only their fields with ordinary defaults", () => {
  assert.deepEqual(resolveSettings(), configDefaults());
  const config = resolveSettings({
    preferences: { theme: "dark", editor: { font_size: 20 }, autosave: true },
    notebook: { on_cell_change: "lazy", cache: { enabled: false } },
    project: { cache: { dir: "results/cache" } },
  });
  assert.equal(config.theme, "dark");
  assert.equal(config.editor.font_size, 20);
  assert.equal(config.editor.tab_size, 2);
  assert.equal(config.autosave, true);
  assert.equal(config.on_cell_change, "lazy");
  assert.equal(config.on_startup, true);
  assert.deepEqual(config.cache, { enabled: false, dir: "results/cache" });
  assert.equal(resolveSettings({ preferences: { theme: "light" } }).cache.dir, null);
  assert.equal(resolveSettings().editor.font_size, 14);
});

test("setting boundaries reject fields owned elsewhere and invalid values", () => {
  assert.equal(preferencesPatchSchema.safeParse({ on_startup: true }).success, false);
  assert.equal(preferencesPatchSchema.safeParse({ editor: { font_size: 2 } }).success, false);
  assert.equal(notebookSettingsPatchSchema.safeParse({ theme: "dark" }).success, false);
  assert.equal(notebookSettingsPatchSchema.safeParse({ cache: { dir: "cache" } }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ cache: { enabled: false } }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ theme: "dark" }).success, false);
});

test("notebook updates retain unrelated authored metadata and original notebook", () => {
  const notebook = {
    metadata: {
      title: "Research", extension: { flag: true },
      runtime: { on_cell_change: "automatic", theme: "old unrelated value", vendor: 7, cache: { dir: "authored", extension: 3 } },
    },
  };
  assert.deepEqual(readNotebookSettings(notebook.metadata), { on_cell_change: "automatic" });
  const changed = setNotebookSettings(notebook, { on_cell_change: "lazy", on_startup: false, cache: { enabled: false } });
  assert.deepEqual(readNotebookSettings(changed.metadata), {
    on_cell_change: "lazy", on_startup: false, cache: { enabled: false },
  });
  assert.deepEqual(changed.metadata.extension, { flag: true });
  const runtime = changed.metadata.runtime as Record<string, unknown>;
  assert.equal(runtime.theme, "old unrelated value");
  assert.equal(runtime.vendor, 7);
  assert.deepEqual(runtime.cache, { dir: "authored", extension: 3, enabled: false });
  assert.equal(notebook.metadata.runtime.on_cell_change, "automatic");
  assert.throws(() => readNotebookSettings({ runtime: { on_startup: "yes" } }), /runtime/);
});

test("project settings use their own file and retain malformed source", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alder-project-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.yaml");
  assert.deepEqual(await readProjectSettings(path), {});
  await writeFile(path, serializeProjectSettings({ cache: { dir: "cache/results" } }));
  assert.deepEqual(await readProjectSettings(path), { cache: { dir: "cache/results" } });
  const malformed = "cache: [broken\n";
  await writeFile(path, malformed);
  await assert.rejects(readProjectSettings(path), (error: unknown) => error instanceof Error && error.message.includes(path));
  assert.equal(await readFile(path, "utf8"), malformed);
});

test("YAML uses library parsing and validates a mapping", () => {
  assert.deepEqual(parseYamlMapping("first: &value {a: 1}\nsecond: *value\n", "test"), {
    first: { a: 1 }, second: { a: 1 },
  });
  assert.throws(() => parseYamlMapping("[1, 2]", "test"), /mapping/);
  assert.throws(() => parseYamlMapping("null", "test"), /mapping/);
});

test("published layout settings retain authored fields without result wrappers", () => {
  const notebook = {
    path: "/tmp/notebook.R",
    metadata: { title: "Notebook", app: { layout: "grid", vendor_flag: { enabled: true } } },
  };
  assert.deepEqual(appConfig(notebook), { layout: "grid", width: "medium", include_code: false });
  const next = setAppConfig(notebook, { include_code: true });
  const nextApp = next.metadata.app as Record<string, unknown>;
  assert.equal(nextApp.layout, "grid");
  assert.equal(nextApp.include_code, true);
  assert.equal(nextApp.width, undefined);
  assert.deepEqual(nextApp.vendor_flag, { enabled: true });
  assert.equal(next.metadata.title, "Notebook");
  assert.equal((notebook.metadata.app as Record<string, unknown>).include_code, undefined);
});
