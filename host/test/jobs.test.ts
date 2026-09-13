import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { PackageJobError, PackageJobs } from "../src/jobs.js";
import type { ApplicationResources } from "../src/resources.js";
import type { ProcessScope } from "../src/processes.js";

const resources = (root: string): ApplicationResources => ({
  root,
  cliLauncher: root + "/bin/alder",
  hostEntry: root + "/host.mjs",
  rendererDirectory: root + "/renderer",
  workerDirectory: root + "/worker",
  rLibraryDirectory: root + "/r-library",
  arkExecutable: root + "/bin/ark",
  airExecutable: root + "/bin/air",
  nodeExecutable: root + "/bin/node",
  processSupervisorExecutable: root + "/bin/alder-process-supervisor",
  electronEntry: null,
});

test("PackageJobs fails before spawning when the selected R environment is unavailable", async () => {
  let spawned = 0;
  const processScope: ProcessScope = {
    spawn: async () => { spawned += 1; throw new Error("must not spawn"); },
    close: async () => undefined,
  };
  const jobs = new PackageJobs({
    resources: resources("/tmp/alder-jobs"),
    environment: null,
    processScope,
    projectDirectory: "/tmp/alder-project",
  });
  await assert.rejects(jobs.run("status", {}), (error: unknown) =>
    error instanceof PackageJobError && error.code === "r_not_found");
  assert.equal(spawned, 0);
  await jobs.close();
});

test("PackageJobs validates bounded timeouts before creating a child", () => {
  assert.throws(() => new PackageJobs({
    resources: resources("/tmp/alder-jobs"),
    environment: null,
    processScope: { spawn: async () => { throw new Error("must not spawn"); }, close: async () => undefined },
    projectDirectory: "/tmp/alder-project",
    timeoutMs: 0,
  }), /timeout must be an integer/);
});

test("PackageJobs reports structured installer failures as terminal failures", async () => {
  const terminal: Array<{ ok: boolean; operationId?: string; error?: { code: string } }> = [];
  const progress: Array<{ phase: string; operationId?: string }> = [];
  const processScope: ProcessScope = {
    spawn: async ({ args }) => {
      const outputPath = String(args[args.length - 1]);
      await writeFile(outputPath, JSON.stringify({ ok: true, result: {
        ok: false,
        status: "error",
        mutatedLibrary: true,
        output: "",
        records: [{ package: "jsonlite", status: "missing", version: null, library: null }],
        error: { code: "install_failed", message: "installer failed" },
      }}));
      const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      return {
        pid: 1,
        startIdentity: "fixture",
        stdin,
        stdout: Readable.from(["ALDER_PACKAGE_PROGRESS\t{\"phase\":\"install\"}\n"]),
        stderr: null,
        exited: Promise.resolve({ code: 0, signal: null }),
        terminate: async () => undefined,
      };
    },
    close: async () => undefined,
  };
  const jobs = new PackageJobs({
    resources: resources("/tmp/alder-jobs"),
    environment: {
      rscript: "/usr/bin/Rscript",
      rHome: "/usr/lib/R",
      version: "4.6.0",
      platform: process.platform,
      arch: process.arch,
      libraryPaths: ["/tmp"],
      identity: "fixture",
    },
    processScope,
    projectDirectory: "/tmp/alder-project",
    callbacks: { onProgress: event => progress.push(event), onTerminal: event => terminal.push(event) },
  });
  try {
    const result = await jobs.run("install", { operationId: "op-install" }) as Record<string, unknown>;
    assert.equal((result as { ok: boolean }).ok, false);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.ok, false);
    assert.equal(terminal[0]?.operationId, "op-install");
    assert.equal(terminal[0]?.error?.code, "install_failed");
    assert.ok(progress.some(event => event.phase === "output" && event.operationId === "op-install"));
  } finally {
    await jobs.close();
  }
});

test("PackageJobs bounds multibyte diagnostics by UTF-8 bytes without splitting code points", async () => {
  const multibyteText = "é".repeat(65_536);
  const outputEvents: string[] = [];
  const processScope: ProcessScope = {
    spawn: async ({ args }) => {
      const outputPath = String(args[args.length - 1]);
      await writeFile(outputPath, JSON.stringify({ ok: true, result: {
        ok: true,
        status: "installed",
        mutatedLibrary: false,
        output: "",
        records: [],
      }}));
      const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      return {
        pid: 1,
        startIdentity: "fixture-utf8",
        stdin,
        stdout: Readable.from([multibyteText]),
        stderr: null,
        exited: Promise.resolve({ code: 0, signal: null }),
        terminate: async () => undefined,
      };
    },
    close: async () => undefined,
  };
  const jobs = new PackageJobs({
    resources: resources("/tmp/alder-jobs"),
    environment: {
      rscript: "/usr/bin/Rscript",
      rHome: "/usr/lib/R",
      version: "4.6.0",
      platform: process.platform,
      arch: process.arch,
      libraryPaths: ["/tmp"],
      identity: "fixture-utf8",
    },
    processScope,
    projectDirectory: "/tmp/alder-project",
    callbacks: {
      onProgress: event => {
        if (event.phase === "output" && event.stream === "stdout" && event.text !== undefined) outputEvents.push(event.text);
      },
    },
  });
  try {
    const result = await jobs.run("install", { operationId: "op-utf8" }) as Record<string, unknown>;
    const output = result.output;
    assert.equal(typeof output, "string");
    const outputText = output as string;
    assert.ok(Buffer.byteLength(outputText, "utf8") <= 64 * 1024);
    assert.match(outputText, /^é*$/u);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(outputText, "utf8")), outputText);
    assert.ok(outputEvents.length > 0);
    for (const text of outputEvents) {
      assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024);
      assert.match(text, /^é*$/u);
      assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "utf8")), text);
    }
  } finally {
    await jobs.close();
  }
});
