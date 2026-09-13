import test from "node:test";
import assert from "node:assert/strict";

import { archiveExtractionPlan, archivePackagingPlan, patchApplicationPlan } from "../scripts/build-ark.mjs";

test("Ark extraction keeps Windows drive paths out of tar operands", () => {
  const plan = archiveExtractionPlan(
    "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64\\source.tar.gz",
    "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64\\source",
    "win32",
  );

  assert.equal(plan.cwd, "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64");
  assert.equal(plan.archive, "source.tar.gz");
  assert.equal(plan.destination, "source");
  assert.doesNotMatch(plan.archive + plan.destination, /[:\\\\]/);
});

test("Ark extraction rejects destinations outside the archive directory", () => {
  assert.throws(
    () => archiveExtractionPlan("D:\\a\\source.tar.gz", "D:\\other\\source", "win32"),
    /must share a parent/,
  );
});


test("Ark packaging keeps Windows drive paths out of tar operands", () => {
  const plan = archivePackagingPlan(
    "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64\\package",
    "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64\\ark.tar.gz",
    "win32",
  );

  assert.equal(plan.cwd, "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64");
  assert.equal(plan.packageDirectory, "package");
  assert.equal(plan.artifact, "ark.tar.gz");
  assert.doesNotMatch(plan.packageDirectory + plan.artifact, /[:\\\\]/);
});

test("Ark patch invocation uses a relative slash-separated Windows operand", () => {
  const plan = patchApplicationPlan(
    "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64\\source",
    "D:\\a\\alder\\dev\\ark\\mime-publisher.patch",
    "win32",
  );

  assert.equal(plan.cwd, "D:\\a\\alder\\host\\.runtime\\ark-build\\win32-x64\\source");
  assert.equal(plan.input, "../../../../../dev/ark/mime-publisher.patch");
  assert.doesNotMatch(plan.input, /[:\\\\]/);
});

test("Ark packaging supports the CI artifact outside its build directory", () => {
  const plan = archivePackagingPlan(
    "D:\\a\\_temp\\ark\\build\\package",
    "D:\\a\\_temp\\ark\\ark.tar.gz",
    "win32",
  );

  assert.equal(plan.cwd, "D:\\a\\_temp\\ark\\build");
  assert.equal(plan.packageDirectory, "package");
  assert.equal(plan.artifact, "../ark.tar.gz");
  assert.doesNotMatch(plan.packageDirectory + plan.artifact, /[:\\\\]/);
});

test("Ark patch invocation rejects cross-drive Windows paths", () => {
  assert.throws(
    () => patchApplicationPlan("C:\\build\\source", "D:\\checkout\\mime-publisher.patch", "win32"),
    /must be reachable/,
  );
});