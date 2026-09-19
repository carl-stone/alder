import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createNativeReviewOutputDirectory, parseNativeReviewOutputParent } from "../../desktop/src/native-review-output.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const reviewScript = join(repositoryRoot, "desktop/scripts/capture-native-review.mts");

test("native review output parsing ignores Electron's script-path argv entry", () => {
  const argv = ["/Applications/Electron.app/Contents/MacOS/Electron", reviewScript, "--output-dir", tmpdir()];
  assert.equal(parseNativeReviewOutputParent(argv), resolve(tmpdir()));
  assert.notEqual(parseNativeReviewOutputParent(argv), reviewScript);
  assert.throws(() => parseNativeReviewOutputParent([reviewScript, "--output-dir", "relative-output"]), /must be absolute/);
});

test("native review output refuses roots, source paths, symlinks, and unrelated directories", async () => {
  const unrelated = await mkdtemp(join(tmpdir(), "not-alder-native-review-"));
  const link = join(tmpdir(), `alder-native-review-link-${process.pid}-${Date.now()}`);
  await symlink(tmpdir(), link);
  try {
    for (const candidate of ["/", homedir(), repositoryRoot, dirname(reviewScript), reviewScript, unrelated, link]) {
      await assert.rejects(
        createNativeReviewOutputDirectory([reviewScript, "--output-dir", candidate]),
        /system temporary directory|existing non-symlink directory/,
        candidate,
      );
    }
    assert.equal((await lstat(reviewScript)).isFile(), true);
    assert.match(await readFile(reviewScript, "utf8"), /createNativeReviewOutputDirectory/);
  } finally {
    await rm(unrelated, { recursive: true, force: true });
    await rm(link, { force: true });
  }
});

test("hidden production native review exits cleanly and writes only owned evidence", {
  skip: process.platform !== "darwin",
  timeout: 20_000,
}, async () => {
  const started = performance.now();
  let outputDirectory: string | undefined;
  try {
    const temporaryRoot = await realpath(tmpdir());
    const before = new Set((await readdir(temporaryRoot)).filter(name => name.startsWith("alder-native-review-")));
    const { stderr } = await execFileAsync(
      join(repositoryRoot, "desktop/node_modules/.bin/electron"),
      [reviewScript, "--output-dir", tmpdir()],
      { cwd: repositoryRoot, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(stderr, "");
    const created = (await readdir(temporaryRoot)).filter(name => name.startsWith("alder-native-review-") && !before.has(name));
    assert.equal(created.length, 1, JSON.stringify(created));
    outputDirectory = await realpath(join(temporaryRoot, created[0]!));
    const evidence = JSON.parse(await readFile(join(outputDirectory, "native-window-state.json"), "utf8")) as Record<string, any>;
    assert.equal(evidence.outputDirectory, outputDirectory);
    assert.equal(outputDirectory.startsWith(temporaryRoot + "/alder-native-review-"), true);
    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      "methylation-analysis.R",
      "native-review-preload.cjs",
      "native-window-state.json",
    ]);
    assert.equal(evidence.visible, false);
    assert.equal(evidence.focused, false);
    assert.equal(evidence.documentEdited, true);
    const run = evidence.menus.find((item: any) => item.label === "Run").submenu;
    assert.equal(run.find((item: any) => item.label === "Run Cell").accelerator, "CmdOrCtrl+Enter");
    assert.equal(run.find((item: any) => item.label === "Interrupt R").accelerator, "CmdOrCtrl+.");
    assert.ok(performance.now() - started < 15_000);

    const processes = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 2 * 1024 * 1024 });
    const leaked = processes.stdout.split("\n").filter(line => line.includes("capture-native-review.mts"));
    assert.deepEqual(leaked, []);
    assert.equal((await lstat(reviewScript)).isFile(), true);
  } finally {
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
});
