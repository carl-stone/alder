import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveREnvironment, rEnvironmentVariables } from "../src/r-environment.js";
import { resolveApplicationResources } from "../src/resources.js";
import { createWindowsNodeLauncher, secureWindowsPath } from "./windows-fixtures.js";

interface Fixture {
  root: string;
  supportRoot: string;
  resources: Awaited<ReturnType<typeof resolveApplicationResources>>;
  rscript: string;
  rHome: string;
  normalLibrary: string;
  baseLibrary: string;
}
async function removeFixture(fixture: Fixture): Promise<void> {
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(fixture.supportRoot, { recursive: true, force: true }),
  ]);
}


test("application resources require an exact inventory and content hash", async () => {
  const fixture = await makeFixture();
  try {
    const resolved = fixture.resources;
    assert.equal(resolved.root, fixture.root);
    const original = await readFile(resolved.hostEntry);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0]! ^ 1;
    await writeFile(resolved.hostEntry, tampered);
    await assert.rejects(resolveApplicationResources(fixture.root), /SHA-256 mismatch/);
    await writeFile(resolved.hostEntry, original);
    await writeFile(join(dirname(resolved.hostEntry), "unlisted.mjs"), "unlisted");
    await assert.rejects(resolveApplicationResources(fixture.root), /inventory mismatch/);
  } finally {
    await removeFixture(fixture);
  }
});

test("application resources hash Forge top-level runtime payloads", async () => {
  const fixture = await makeFixture();
  try {
    const path = join(fixture.root, "chrome-sandbox");
    const bytes = Buffer.from(await readFile(path));
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(path, bytes);
    await assert.rejects(resolveApplicationResources(fixture.root), /SHA-256 mismatch: chrome-sandbox/);
  } finally {
    await removeFixture(fixture);
  }
});

test("application resources require a valid supervisor provenance descriptor", async () => {
  const fixture = await makeFixture();
  try {
    const manifest = fixture.resources.manifest!;
    assert.equal("processSupervisor" in manifest, false);
    assert.equal("processSupervisorProvenance" in manifest.resources, false);
    assert.ok(manifest.files.some(file => file.path === "resources/host/locks/process-supervisor-provenance.json"));
    assert.ok(manifest.files.every(file => !("linkTarget" in file)));
  } finally {
    await removeFixture(fixture);
  }
});

test('removed supervisor manifest fields are rejected', async () => {
  const fixture = await makeFixture();
  try {
    const manifestPath = join(fixture.root, 'resources/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.processSupervisor = {};
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(resolveApplicationResources(fixture.root), /unexpected or missing fields/);
    delete manifest.processSupervisor;
    manifest.resources.processSupervisorProvenance = 'resources/host/locks/process-supervisor-provenance.json';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(resolveApplicationResources(fixture.root), /unexpected or missing fields/);
  } finally {
    await removeFixture(fixture);
  }
});
test("application resources require both qualified R patches", async () => {
  const fixture = await makeFixture();
  try {
    const manifestPath = join(fixture.root, "resources/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.qualifiedRPatchVersions = ["4.6.1"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(resolveApplicationResources(fixture.root), /both 4.6.0 and 4.6.1/);
  } finally {
    await removeFixture(fixture);
  }
});

test("application resources reject a tampered supervisor producer descriptor", async () => {
  const fixture = await makeFixture();
  try {
    const descriptorPath = join(fixture.root, "resources/host/locks/process-supervisor-provenance.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.producer.toolchain = "rust-1.94.0";
    const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
    await writeFile(descriptorPath, descriptorBytes);
    const manifestPath = join(fixture.root, "resources/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const inventory = manifest.files.find((file: { path: string }) => file.path === "resources/host/locks/process-supervisor-provenance.json");
    assert.ok(inventory);
    inventory.bytes = descriptorBytes.byteLength;
    inventory.sha256 = createHash("sha256").update(descriptorBytes).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(resolveApplicationResources(fixture.root), /toolchain/);
  } finally {
    await removeFixture(fixture);
  }
});

test("application resource symlinks cannot escape the application root", async () => {
  const fixture = await makeFixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "alder-resources-outside-")));
  try {
    const link = join(fixture.root, "resources/app/index.html");
    await rm(link);
    const target = join(outside, "outside.html");
    await writeFile(target, "outside");

    await symlink(target, link);
    await assert.rejects(resolveApplicationResources(fixture.root), /symlink escapes/);
  } finally {
    await removeFixture(fixture);
    await rm(outside, { recursive: true, force: true });
  }
});

test('application resource symlinks preserve contained framework-style identities', async () => {
  const fixture = await makeFixture();
  try {
    const directory = join(fixture.root, 'resources/app');
    const linkPath = join(directory, 'index.html');
    const targetPath = join(directory, 'framework-resource.html');
    const targetBytes = Buffer.from('framework resource');
    await rm(linkPath);
    await writeFile(targetPath, targetBytes);
    await symlink('framework-resource.html', linkPath);
    const manifestPath = join(fixture.root, 'resources/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const linkEntry = manifest.files.find((file: { path: string }) => file.path === 'resources/app/index.html');
    Object.assign(linkEntry, { bytes: targetBytes.byteLength, sha256: createHash('sha256').update(targetBytes).digest('hex') });
    manifest.files.push({ path: 'resources/app/framework-resource.html', bytes: targetBytes.byteLength, sha256: createHash('sha256').update(targetBytes).digest('hex') });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const resolved = await resolveApplicationResources(fixture.root);
    assert.equal(resolved.rendererDirectory, directory);
  } finally {
    await removeFixture(fixture);
  }
});



test("application resource hardlinks cannot be introduced", async () => {
  const fixture = await makeFixture();
  try {
    await link(join(fixture.root, "chrome-sandbox"), join(fixture.root, "resources/app/hardlink"));
    await assert.rejects(resolveApplicationResources(fixture.root), /hard linked/);
  } finally {
    await removeFixture(fixture);
  }
});

test("application root replacement through a symlink is rejected", async () => {
  const fixture = await makeFixture();
  const linkedRoot = fixture.root + "-link";
  try {
    await symlink(fixture.root, linkedRoot);
    await assert.rejects(resolveApplicationResources(linkedRoot), /application root.*symbolic link/);
  } finally {
    await removeFixture(fixture);
    await rm(linkedRoot, { force: true });
  }
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
    assert.equal(environment.R_LIBS_USER, undefined);
    assert.equal(environment.R_HOME, selected.rHome);
    assert.equal(environment.ALDER_RESOURCES_ROOT, fixture.resources.root);
    assert.equal(environment.ALDER_ANALYSIS_ENVIRONMENT_ID, "analysis-1");
    if (process.platform === "linux") assert.match(environment.LD_LIBRARY_PATH!, new RegExp(fixture.rHome));
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

async function makeFixture(helperVersion = "0.1.0"): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-resources-r-")));
  const supportRoot = await realpath(await mkdtemp(join(tmpdir(), "alder-resources-r-support-")));
  await secureWindowsPath("directory", root);
  await secureWindowsPath("directory", supportRoot);
  const executablePath = (path: string): string => process.platform === "win32" ? path + ".exe" : path;
  const paths = [
    executablePath("bin/alder"),
    "chrome-sandbox",
    "resources/host/alder-host.mjs",
    "resources/app/index.html",
    "resources/worker/worker.mjs",
    "resources/r-library/alder/DESCRIPTION",
    executablePath("resources/runtime/ark"),
    executablePath("resources/runtime/air"),
    executablePath("resources/runtime/node"),
    executablePath("resources/runtime/alder-process-supervisor"),
  ];
  for (const path of paths) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, path.endsWith("DESCRIPTION") ? "Package: alder\nVersion: 0.1.0\n" : path);
    await secureWindowsPath("file", absolute);
    if (process.platform !== "win32" && (!path.endsWith("DESCRIPTION") || path === executablePath("bin/alder"))) {
      await chmod(absolute, 0o755);
    }
  }
  const supervisorPath = executablePath("resources/runtime/alder-process-supervisor");
  const supervisorSha = createHash("sha256").update(await readFile(join(root, supervisorPath))).digest("hex");
  const producer = {
    toolchain: "rust-1.95.0",
    rustc: "rustc 1.95.0 (test)",
    cargo: "cargo 1.95.0 (test)",
    command: "cargo +1.95.0 build --locked --release --manifest-path host/native/process-supervisor/Cargo.toml",
  };
  const descriptorPath = "resources/host/locks/process-supervisor-provenance.json";
  await mkdir(dirname(join(root, descriptorPath)), { recursive: true });
  await secureWindowsPath("directory", dirname(join(root, descriptorPath)));
  await writeFile(join(root, descriptorPath), JSON.stringify({ schemaVersion: 1, artifact: { sha256: supervisorSha }, producer }));
  await secureWindowsPath("file", join(root, descriptorPath));
  const rHome = join(supportRoot, "fake-r");
  const normalLibrary = join(supportRoot, "normal-library");
  const baseLibrary = join(rHome, "library");
  const rBin = join(rHome, "bin", "x64");
  await mkdir(rBin, { recursive: true });
  await secureWindowsPath("directory", rBin);
  await mkdir(join(rHome, "lib"), { recursive: true });
  await secureWindowsPath("directory", join(rHome, "lib"));
  await mkdir(normalLibrary, { recursive: true });
  await secureWindowsPath("directory", normalLibrary);
  await mkdir(baseLibrary, { recursive: true });
  await secureWindowsPath("directory", baseLibrary);
  const sharedLibrary = process.platform === "darwin" ? join(rHome, "lib", "libR.dylib")
    : process.platform === "win32" ? join(rBin, "R.dll") : join(rHome, "lib", "libR.so");
  await writeFile(sharedLibrary, "fake-R");
  await secureWindowsPath("file", sharedLibrary);
  const rscriptScriptPath = join(supportRoot, "fake-Rscript.mjs");
  const rscript = join(supportRoot, process.platform === "win32" ? "fake-Rscript.exe" : "fake-Rscript");
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  const output = [
    rHome,
    "R version 4.6.1 (fake)",
    process.platform === "win32" ? "mingw" : process.platform,
    arch,
    normalLibrary,
    "--ALDER-LIBS-END--",
    baseLibrary,
  ].join("\n") + "\n";
  const helperOutput = helperVersion + "\nR 4.6.1; fake\n";
  const nodeScript = [
    "const output = " + JSON.stringify(output) + ";",
    "const helperOutput = " + JSON.stringify(helperOutput) + ";",
    "process.stdout.write(process.argv.join(\" \").includes(\"library(alder)\") ? helperOutput : output);",
    "",
  ].join("\n");
  await writeFile(rscriptScriptPath, nodeScript);
  await secureWindowsPath("file", rscriptScriptPath);
  if (process.platform === "win32") {
    await createWindowsNodeLauncher(rscript, rscriptScriptPath);
    await secureWindowsPath("file", rscript);
  } else {
    const shellScript = "#!/bin/sh\ncase \"$*\" in *\"library(alder)\"*) printf '%b' " + JSON.stringify(helperOutput) + " ;; *) printf '%b' " + JSON.stringify(output) + " ;; esac\n";
    await writeFile(rscript, shellScript);
    await chmod(rscript, 0o755);
  }

  const inventory = [];
  for (const path of [...paths, descriptorPath]) {
    const bytes = await readFile(join(root, path));
    inventory.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = {
    schemaVersion: 1,
    kind: "headless",
    applicationVersion: "0.1.0",
    sourceCommit: "0".repeat(40),
    sourceTreeSha256: "0".repeat(64),
    hostProtocol: "alder-host-v2",
    engineProtocol: "alder-engine-v2",
    target: { platform: process.platform, arch: process.arch },
    rVersionRange: ">=4.6.0 <4.7.0",
    qualifiedRPatchVersions: ["4.6.0", "4.6.1"],
    rBuildVersion: "4.6.1",
    resources: {
      cliLauncher: executablePath("bin/alder"),
      hostEntry: "resources/host/alder-host.mjs",
      rendererDirectory: "resources/app",
      workerDirectory: "resources/worker",
      rLibraryDirectory: "resources/r-library",
      arkExecutable: executablePath("resources/runtime/ark"),
      airExecutable: executablePath("resources/runtime/air"),
      nodeExecutable: executablePath("resources/runtime/node"),
      processSupervisorExecutable: executablePath("resources/runtime/alder-process-supervisor"),
      electronEntry: null,
    },
    runtimes: {
      node: "test",
      ark: { upstreamVersion: "test", buildVersion: "test", baseCommit: "test", patchSha256: "0".repeat(64), mimePublisher: "alder-json-v1" },
      air: "test",
      electron: null,
      chromium: null,
      electronNode: null,
    },
    files: inventory,
    rPackages: [{ name: "alder", version: "0.1.0", builtR: "4.6.1", platform: process.platform, license: "MIT" }],
  };
  await mkdir(join(root, "resources"), { recursive: true });
  await secureWindowsPath("directory", join(root, "resources"));
  await writeFile(join(root, "resources/manifest.json"), JSON.stringify(manifest));
  await secureWindowsPath("file", join(root, "resources/manifest.json"));
  const resources = await resolveApplicationResources(root);
  return { root, supportRoot, resources, rscript, rHome, normalLibrary, baseLibrary };
}
