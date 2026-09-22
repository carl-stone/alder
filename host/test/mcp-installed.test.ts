import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupOwnedProcesses, ownedProcessRows, waitForOwnedExit } from "../scripts/native-process-cleanup.mjs";

const APPLICATION_ROOT = process.env.ALDER_APPLICATION_ROOT;
const TEST_RSCRIPT = process.env.ALDER_TEST_RSCRIPT;
const installedIntegration = {
  skip: !APPLICATION_ROOT || !TEST_RSCRIPT,
  timeout: 120_000,
};

function sanitizedEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ALDER_") || key === "R_HOME" || key.startsWith("R_LIBS")) delete environment[key];
  }
  return { ...environment, ...extra };
}

test("the staged alder launcher serves MCP over official stdio", installedIntegration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-mcp-installed-"));
  const notebook = join(directory, "notebook.R");
  await writeFile(notebook, "# %%\nanswer <- 42\nanswer\n");
  const configDirectory = join(directory, "config");
  const runtimeDirectory = join("/tmp", `alder-mcp-installed-${process.pid}`);
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(join(configDirectory, "alder"), { recursive: true });
  await writeFile(join(configDirectory, "alder/preferences.yaml"), `rscript: ${JSON.stringify(TEST_RSCRIPT)}\n`);

  const transport = new StdioClientTransport({
    command: join(resolve(APPLICATION_ROOT!), "bin", "alder"),
    args: ["mcp", notebook],
    cwd: directory,
    env: sanitizedEnvironment({
      HOME: directory,
      XDG_CONFIG_HOME: configDirectory,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_STATE_HOME: join(directory, "state"),
      ALDER_RUNTIME_DIRECTORY: runtimeDirectory,
    }),
    stderr: "pipe",
    maxBufferSize: 16 * 1024 * 1024,
  });
  const client = new Client({ name: "mcp-installed-test", version: "1" }, { capabilities: {} });
  const stderr = transport.stderr;
  const stderrChunks: Buffer[] = [];
  const ownedPids = new Set<number>();
  stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

  try {
    await client.connect(transport);

    const result = await client.callTool({ name: "list_cells", arguments: {} });
    assert.equal(result.isError, false);
    const structured = requireRecord(result.structuredContent);
    assert.equal(requireNonEmptyString(structured.epoch).length > 0, true);
    assert.equal(structured.documentRevision, 0);
    assert.ok(requireNonNegativeInteger(structured.cursor) >= 0);
    const cells = requireArray(structured.result);
    assert.equal(cells.length, 1);
    const firstCell = requireRecord(cells[0]);
    assert.equal(firstCell.id, "cell-1");
    assert.equal(firstCell.type, "code");
    assert.deepEqual(requireArray(firstCell.body), ["answer <- 42", "answer"]);
  } catch (error) {
    const diagnostics = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (diagnostics.length > 0) throw new Error(String(error) + "\n" + diagnostics, { cause: error });
    throw error;
  } finally {
    for (const row of ownedProcessRows(ownedPids, runtimeDirectory)) ownedPids.add(row.pid);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    // Normal MCP detach retains recovery until the idle host exits; its diagnostics may still be writing.
    try {
      await waitForOwnedExit(ownedPids, runtimeDirectory, 25_000);
    } finally {
      await cleanupOwnedProcesses(ownedPids, runtimeDirectory);
      await rm(directory, { recursive: true, force: true });
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("expected an object");
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("expected an array");
  return value;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("expected a non-empty string");
  return value;
}

function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("expected a non-negative integer");
  return value;
}
