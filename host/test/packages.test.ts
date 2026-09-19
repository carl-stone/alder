import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPackageDeclarations } from "../src/packages.js";

test("package declarations reject malformed metadata without rewriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-packages-"));
  try {
    const metadata = join(directory, ".alder", "packages.yaml");
    await mkdir(join(directory, ".alder"), { recursive: true });
    for (const source of ["packages: [jsonlite]\nextra: true\n", "packages: !evil [jsonlite]\n", "packages: [jsonlite]\npackages: [yaml]\n"]) {
      await writeFile(metadata, source);
      await assert.rejects(readPackageDeclarations(directory), { code: "package_metadata_error" });
      assert.equal(await readFile(metadata, "utf8"), source);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
