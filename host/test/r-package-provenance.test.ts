import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readLockedRSourceArchives,
  sha256,
  verifyInstalledRLibrary,
} from "../scripts/r-package-provenance.mjs";

const nativeDependencies = { needsCompilation: false, systemRequirements: null };

function lockFor(bytes, packageVersion = "1.0.0") {
  const packageName = "fixturepkg";
  return {
    ProvenanceSchemaVersion: 1,
    Roots: ["alder", packageName],
    Packages: {
      alder: {
        Package: "alder",
        Version: "0.1.0",
        Source: "Local",
        SourcePath: ".",
        License: "Apache License (>= 2)",
        NativeDependencies: nativeDependencies,
      },
      [packageName]: {
        Package: packageName,
        Version: packageVersion,
        Source: "Repository",
        SourceArchive: "https://example.invalid/src/contrib/fixturepkg_" + packageVersion + ".tar.gz",
        SourceSHA256: sha256(bytes),
        SourceBytes: bytes.byteLength,
        License: "MIT",
        NativeDependencies: nativeDependencies,
      },
    },
  };
}

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), "alder-r-provenance-test-"));
}

async function writeDescription(directory, packageName, version) {
  await mkdir(join(directory, packageName), { recursive: true });
  await writeFile(join(directory, packageName, "DESCRIPTION"), [
    "Package: " + packageName,
    "Version: " + version,
    "License: MIT",
    "Description: fixture",
    "",
  ].join("\n"));
}

test("locked source cache returns the exact declared fixture bytes", async () => {
  const directory = await fixtureDirectory();
  try {
    const bytes = Buffer.from("exact locked fixture tarball\n", "utf8");
    const lock = lockFor(bytes);
    const cache = join(directory, "cache");
    await mkdir(cache);
    await writeFile(join(cache, "fixturepkg_1.0.0.tar.gz"), bytes);
    const result = await readLockedRSourceArchives(lock, { sourceCacheDirectory: cache });
    assert.deepEqual([...result.order], ["fixturepkg", "alder"]);
    assert.deepEqual(result.archives.get("fixturepkg"), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("locked source fetch returns verified fixture bytes", async () => {
    const bytes = Buffer.from("fetched locked fixture tarball\n", "utf8");
  const lock = lockFor(bytes);
  const calls = [];
  const result = await readLockedRSourceArchives(lock, {
    fetcher: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    },
  });
  assert.deepEqual(calls, [lock.Packages.fixturepkg.SourceArchive]);
  assert.deepEqual(result.archives.get("fixturepkg"), bytes);
});

test("source cache rejects bytes whose length or SHA differs from the lock", async () => {
  const directory = await fixtureDirectory();
  try {
    const declared = Buffer.from("declared fixture\n", "utf8");
    const lock = lockFor(declared);
    const cache = join(directory, "cache");
    await mkdir(cache);
    await writeFile(join(cache, "fixturepkg_1.0.0.tar.gz"), Buffer.from("tampered fixture\n", "utf8"));
    await assert.rejects(
      readLockedRSourceArchives(lock, { sourceCacheDirectory: cache }),
      /r_dependency_source_mismatch: fixturepkg/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ambient same-version package cannot satisfy the staged closure", async () => {
  const directory = await fixtureDirectory();
  try {
    const bytes = Buffer.from("unused\n", "utf8");
    const lock = lockFor(bytes);
    const staged = join(directory, "staged");
    const ambient = join(directory, "ambient");
    await writeDescription(staged, "alder", "0.1.0");
    await writeDescription(ambient, "fixturepkg", "1.0.0");
    await assert.rejects(verifyInstalledRLibrary(staged, lock), /r_dependency_closure_mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline source staging fails when the explicit cache artifact is absent", async () => {
  const directory = await fixtureDirectory();
  try {
    const bytes = Buffer.from("offline fixture\n", "utf8");
    const lock = lockFor(bytes);
    const cache = join(directory, "empty-cache");
    await mkdir(cache);
    await assert.rejects(
      readLockedRSourceArchives(lock, { sourceCacheDirectory: cache }),
      /r_dependency_source_unavailable: fixturepkg: cache artifact is unavailable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
