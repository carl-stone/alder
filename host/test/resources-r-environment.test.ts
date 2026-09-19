import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveREnvironment, rEnvironmentVariables } from "../src/r-environment.js";
import { resolveApplicationResources } from "../src/resources.js";

interface Fixture {
  root: string;
  resources: Awaited<ReturnType<typeof resolveApplicationResources>>;
  rscript: string;
  rHome: string;
  normalLibrary: string;
  baseLibrary: string;
}
async function removeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

test("document resources resolve while all execution resources are absent", async () => {
  const fixture = await makeFixture();
  try {
    await rm(fixture.resources.rLibraryDirectory, { recursive: true });
    const resources = await resolveApplicationResources(fixture.root);
    assert.equal(resources.hostEntry, join(fixture.root, "host/alder-host.mjs"));
    await assert.rejects(stat(resources.arkExecutable), { code: "ENOENT" });
    await assert.rejects(stat(resources.airExecutable), { code: "ENOENT" });
    await assert.rejects(resolveREnvironment({ resources, projectDirectory: fixture.root }), { code: "r_invalid" });
  } finally { await removeFixture(fixture); }
});

test("missing editor files give an actionable startup error", async () => {
  const fixture = await makeFixture();
  try {
    await rm(fixture.resources.rendererDirectory, { recursive: true });
    await assert.rejects(resolveApplicationResources(fixture.root), /rendererDirectory is unavailable/);
  } finally { await removeFixture(fixture); }
});

test("R selection is explicit and environment serialization is deterministic", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      resolveREnvironment({
        rscript: join(fixture.root, "missing-Rscript"),
        projectDirectory: fixture.root,
        resources: fixture.resources,
      }),
      error => error instanceof Error && error.name === "REnvironmentError" && /rscript/i.test(error.message),
    );
    const projectLibrary = join(fixture.root, ".alder", "library");
    await mkdir(projectLibrary, { recursive: true });
    const selected = await resolveREnvironment({
      rscript: fixture.rscript,
      projectDirectory: fixture.root,
      resources: fixture.resources,
      sandbox: true,
      resolveProjectLibrary: async base => {
        assert.deepEqual(base.libraryPaths, [fixture.resources.rLibraryDirectory, fixture.baseLibrary]);
        return projectLibrary;
      },
    });
    assert.equal(selected.version, "4.6.1");
    assert.equal(selected.rscript, fixture.rscript);
    assert.equal(selected.rHome, fixture.rHome);
    assert.deepEqual(selected.libraryPaths, [
      fixture.resources.rLibraryDirectory,
      projectLibrary,
      fixture.baseLibrary,
    ]);
    const environment = rEnvironmentVariables(selected, fixture.resources, "analysis-1");
    assert.deepEqual(JSON.parse(environment.ALDER_R_LIBRARIES!), selected.libraryPaths);
    assert.equal(environment.R_LIBS_USER, "");
    assert.equal(environment.R_LIBS_SITE, "");
    assert.equal(environment.R_HOME, selected.rHome);
    assert.equal(environment.ALDER_RESOURCES_ROOT, fixture.resources.root);
    assert.equal(environment.ALDER_ANALYSIS_ENVIRONMENT_ID, "analysis-1");
    assert.match(environment.DYLD_LIBRARY_PATH!, new RegExp(fixture.rHome));
  } finally {
    await removeFixture(fixture);
  }
});

test("sandbox resolution does not create a missing project package library", async () => {
  const fixture = await makeFixture();
  try {
    const projectLibrary = join(fixture.root, ".alder", "library");
    const selected = await resolveREnvironment({
      rscript: fixture.rscript,
      projectDirectory: fixture.root,
      resources: fixture.resources,
      sandbox: true,
      resolveProjectLibrary: async () => projectLibrary,
    });
    assert.deepEqual(selected.libraryPaths, [fixture.resources.rLibraryDirectory, fixture.baseLibrary]);
    await assert.rejects(stat(projectLibrary), { code: "ENOENT" });
  } finally {
    await removeFixture(fixture);
  }
});
test("selected R rejects a bundled helper with the wrong package identity", async () => {
  const fixture = await makeFixture("9.9.9");
  try {
    await assert.rejects(
      resolveREnvironment({ rscript: fixture.rscript, projectDirectory: fixture.root, resources: fixture.resources }),
      /helper package version or Built R ABI does not match/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("canceling R discovery promptly stops its child process", async () => {
  const fixture = await makeFixture();
  try {
    const pidFile = join(fixture.root, "probe.pid");
    await writeFile(fixture.rscript, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const controller = new AbortController();
    const resolving = resolveREnvironment({ rscript: fixture.rscript, projectDirectory: fixture.root, resources: fixture.resources, signal: controller.signal });
    const rejected = assert.rejects(resolving, /abort/i);
    const deadline = Date.now() + 3_000;
    while (!await stat(pidFile).catch(() => null) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    await rejected;
    const stopped = Date.now() + 1_000;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < stopped) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(), false);
  } finally { await removeFixture(fixture); }
});

async function makeFixture(helperVersion = "0.1.0"): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-resources-r-")));
  for (const path of ["host/alder-host.mjs", "app/index.html", "worker/worker.R", "r-library/alder/DESCRIPTION"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path.endsWith("DESCRIPTION") ? "Package: alder\nVersion: 0.1.0\n" : path);
  }
  const rHome = join(root, "fake-r");
  const normalLibrary = join(root, "normal-library");
  const baseLibrary = join(rHome, "library");
  for (const path of [join(rHome, "lib"), normalLibrary, baseLibrary]) await mkdir(path, { recursive: true });
  await writeFile(join(rHome, "lib/libR.dylib"), "fake R");
  const rscript = join(root, "fake-Rscript");
  const output = [rHome, "R version 4.6.1 (fake)", "darwin", process.arch, normalLibrary, "--ALDER-LIBS-END--", baseLibrary].join("\n") + "\n";
  const helperOutput = helperVersion + "\nR 4.6.1; fake\n";
  await writeFile(rscript, `#!${process.execPath}\nconst helper = process.argv.join(' ').includes('library(alder)'); process.stdout.write(helper ? ${JSON.stringify(helperOutput)} : ${JSON.stringify(output)});\n`, { mode: 0o755 });
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1, kind: "headless", applicationVersion: "0.1.0",
    resources: { cliLauncher: "bin/alder", hostEntry: "host/alder-host.mjs", rendererDirectory: "app", workerDirectory: "worker", rLibraryDirectory: "r-library", arkExecutable: "runtime/ark", airExecutable: "runtime/air", nodeExecutable: "bin/node", electronEntry: null },
  }));
  return { root, resources: await resolveApplicationResources(root), rscript, rHome, normalLibrary, baseLibrary };
}
