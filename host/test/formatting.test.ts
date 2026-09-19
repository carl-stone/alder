import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFormattingService, FormattingError } from "../src/formatting.js";
import type { OwnedProcess, ProcessScope } from "../src/processes.js";

async function fakeAir(source: string): Promise<{ directory: string; executable: string }> {
  const directory = await mkdtemp(join(tmpdir(), "alder-format-test-"));
  const executable = join(directory, "air");
  await writeFile(executable, source, { encoding: "utf8", mode: 0o755 });
  await chmod(executable, 0o755);
  return { directory, executable };
}
function directProcessScope(): ProcessScope {
  const children = new Set<ChildProcessWithoutNullStreams>();
  const spawnOwned = async (options: Parameters<ProcessScope["spawn"]>[0]): Promise<OwnedProcess> => {
    const child = spawn(
      options.executable,
      [...options.args],
      {
        cwd: options.cwd,
        env: options.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once("close", (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      });
    });
    return {
      pid: child.pid!,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      terminate: async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        await exited;
      },
    };
  };
  return {
    spawn: spawnOwned,
    close: async () => {
      await Promise.all([...children].map(child => new Promise<void>(resolve => {
        child.once("close", () => resolve());
        if (child.exitCode === null) child.kill("SIGTERM");
        else resolve();
      })));
    },
  };
}
const document = {
  path: "/tmp/example.Rmd",
  text: "x<-1\\n<!-- %% -->\\ntext",
  cells: [
    { id: "markdown-1", type: "markdown" as const, body: ["text"], revision: 2 },
    { id: "code-1", type: "code" as const, body: ["x<-1"], revision: 7 },
  ],
};

test("Air formatting returns code edits with notebook identity and revision", async () => {
  const fake = await fakeAir(["#!/usr/bin/env node", "const fs = require('node:fs');", "const path = process.argv[3];", "fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace('x<-1', 'x <- 1'));"].join("\n"));
  const scope = directProcessScope();
  try {
    const edits = await createFormattingService(fake.executable, scope).formatCells(document, ["code-1", "markdown-1"]);
    assert.deepEqual(edits, [{
      type: "edit",
      cell: { cellId: "code-1" },
      expectedRevision: 7,
      body: ["x <- 1"],
      cellType: "code",
    }]);
  } finally {
    await scope.close();
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test("formatter failure is surfaced instead of falling back", async () => {
  const fake = await fakeAir("#!/usr/bin/env node\nprocess.stderr.write('bad formatter');\nprocess.exit(3);\n");
  const scope = directProcessScope();
  try {
    await assert.rejects(
      createFormattingService(fake.executable, scope).formatCells(document, ["code-1"]),
      (error: unknown) => error instanceof FormattingError && error.code === "format_failed" && /bad formatter/.test(error.message),
    );
  } finally {
    await scope.close();
    await rm(fake.directory, { recursive: true, force: true });
  }
});
