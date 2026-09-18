import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationPreferences, type PreferencesSnapshot } from "../src/preferences.js";
import { preferenceDefaults } from "../src/settings.js";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "alder-preferences-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "preferences.yaml") };
}

const code = (value: string) => (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === value;

test("missing preferences use defaults, notify two subscribers, and survive reopening", async (context) => {
  const { path } = await fixture(context);
  const preferences = await ApplicationPreferences.open(path);
  assert.deepEqual(preferences.snapshot(), { values: preferenceDefaults(), version: null, path, error: null });
  const first: PreferencesSnapshot[] = [];
  const second: PreferencesSnapshot[] = [];
  preferences.subscribe((snapshot) => first.push(snapshot));
  const unsubscribe = preferences.subscribe((snapshot) => second.push(snapshot));
  const changed = await preferences.update({ theme: "dark", editor: { font_size: 19 } }, null);
  assert.equal(changed.values.theme, "dark");
  assert.equal(changed.values.editor.font_size, 19);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0], second[0]);
  const persisted = await readFile(path, "utf8");
  assert.match(persisted, /theme: dark/);
  assert.match(persisted, /font_size: 19/);
  unsubscribe();
  await preferences.close();
  const reopened = await ApplicationPreferences.open(path);
  assert.deepEqual(reopened.snapshot(), changed);
  await reopened.close();
});

test("malformed file stays on disk and cannot be silently overwritten", async (context) => {
  const { path } = await fixture(context);
  const malformed = "editor: [broken\n";
  await writeFile(path, malformed);
  const preferences = await ApplicationPreferences.open(path);
  const initial = preferences.snapshot();
  assert.deepEqual(initial.values, preferenceDefaults());
  assert.ok(initial.version);
  assert.equal(initial.error?.code, "config_invalid");
  assert.ok(initial.error?.message.includes(path));
  await assert.rejects(preferences.update({ theme: "dark" }, initial.version), code("config_invalid"));
  assert.equal(await readFile(path, "utf8"), malformed);
  assert.deepEqual(preferences.snapshot().values, preferenceDefaults());

  await writeFile(path, "theme: light\n");
  await assert.rejects(preferences.update({ theme: "dark" }, initial.version), code("source_conflict"));
  const repaired = preferences.snapshot();
  assert.equal(repaired.values.theme, "light");
  assert.equal(repaired.error, null);
  await preferences.update({ theme: "dark" }, repaired.version);
  assert.equal(preferences.snapshot().values.theme, "dark");
});

test("schema-invalid preference values are retained and reported", async (context) => {
  const { path } = await fixture(context);
  const invalid = "editor:\n  font_size: tiny\n";
  await writeFile(path, invalid);
  const preferences = await ApplicationPreferences.open(path);
  assert.equal(preferences.snapshot().error?.code, "config_invalid");
  await assert.rejects(preferences.update({ theme: "dark" }, preferences.snapshot().version), code("config_invalid"));
  assert.equal(await readFile(path, "utf8"), invalid);
});

test("failed write keeps prior values and bytes and never publishes the requested value", async (context) => {
  const { directory, path } = await fixture(context);
  await writeFile(path, "theme: light\n");
  const preferences = await ApplicationPreferences.open(path);
  const before = preferences.snapshot();
  const events: PreferencesSnapshot[] = [];
  preferences.subscribe((snapshot) => events.push(snapshot));
  await chmod(directory, 0o500);
  try {
    await assert.rejects(preferences.update({ theme: "dark" }, before.version), code("preferences_write_failed"));
    assert.equal(preferences.snapshot().values.theme, "light");
    assert.equal(preferences.snapshot().version, before.version);
    assert.equal(await readFile(path, "utf8"), "theme: light\n");
    assert.ok(events.every((snapshot) => snapshot.values.theme === "light"));
    assert.ok(preferences.snapshot().error?.message.includes(path));
  } finally {
    await chmod(directory, 0o700);
  }
  assert.deepEqual(await readdir(directory), ["preferences.yaml"]);
  await preferences.update({ theme: "dark" }, before.version);
  assert.equal(preferences.snapshot().values.theme, "dark");
  assert.equal(preferences.snapshot().error, null);
});

test("unwritable destination remains usable with default preferences", async (context) => {
  const { directory } = await fixture(context);
  const parent = join(directory, "blocked");
  await mkdir(parent, { mode: 0o500 });
  const preferences = await ApplicationPreferences.open(join(parent, "preferences.yaml"));
  try {
    assert.equal(preferences.snapshot().error, null);
    await assert.rejects(preferences.update({ autosave: true }, null), code("preferences_write_failed"));
    assert.equal(preferences.snapshot().values.autosave, false);
  } finally {
    await chmod(parent, 0o700);
  }
});

test("concurrent updates serialize and a stale client cannot replace the winner", async (context) => {
  const { path } = await fixture(context);
  const preferences = await ApplicationPreferences.open(path);
  const first = preferences.update({ theme: "dark" }, null);
  const stale = preferences.update({ keymap: "vim" }, null);
  await first;
  await assert.rejects(stale, code("source_conflict"));
  assert.equal(preferences.snapshot().values.theme, "dark");
  assert.equal(preferences.snapshot().values.keymap, "default");
  await preferences.update({ keymap: "vim" }, preferences.snapshot().version);
  assert.equal(preferences.snapshot().values.keymap, "vim");
});

test("external valid changes refresh shared values but reject the conflicting patch", async (context) => {
  const { path } = await fixture(context);
  const preferences = await ApplicationPreferences.open(path);
  const before = await preferences.update({ theme: "dark" }, null);
  await writeFile(path, "theme: light\nkeymap: vim\n");
  await assert.rejects(preferences.update({ autosave: true }, before.version), code("source_conflict"));
  const external = preferences.snapshot();
  assert.equal(external.values.theme, "light");
  assert.equal(external.values.keymap, "vim");
  assert.equal(external.values.autosave, false);
  assert.equal(await readFile(path, "utf8"), "theme: light\nkeymap: vim\n");
  await preferences.update({ autosave: true }, external.version);
  assert.equal(preferences.snapshot().values.autosave, true);
});

test("external malformed file retains last good values and requires repair", async (context) => {
  const { path } = await fixture(context);
  const preferences = await ApplicationPreferences.open(path);
  const before = await preferences.update({ theme: "dark" }, null);
  const malformed = "theme: [broken\n";
  await writeFile(path, malformed);
  await assert.rejects(preferences.update({ keymap: "vim" }, before.version), code("config_invalid"));
  assert.equal(preferences.snapshot().values.theme, "dark");
  assert.equal(preferences.snapshot().values.keymap, "default");
  assert.equal(preferences.snapshot().error?.code, "config_invalid");
  assert.equal(await readFile(path, "utf8"), malformed);
});
