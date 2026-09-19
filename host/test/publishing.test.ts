import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import {
  PublishingService,
  PublishingError,
  type PublicationSnapshot,
  type PublishingOwnedProcess,
  type PublishingProcessScope,
} from "../src/publishing.js";
import { OutputStore } from "../src/outputs.js";
import type { OutputRecord } from "../src/protocol.js";

const epoch = "epoch-publish";
const kernelEpoch = "kernel-publish";

function directProcessScope(): PublishingProcessScope {
  return {
    async spawn(options): Promise<PublishingOwnedProcess> {
      const child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.environment,
        stdio: "pipe",
      });
      const { promise, resolve, reject } = Promise.withResolvers<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>();
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        exited: promise,
        terminate: async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        },
      };
    },
  };
}

function snapshot(
  outputs: readonly OutputRecord[] = [],
  overrides: Partial<PublicationSnapshot> = {},
): PublicationSnapshot {
  return {
    documentRevision: 4,
    path: "/tmp/publish-source.R",
    metadata: { title: "Saved notebook" },
    editorDirty: false,
    cells: [{
      id: "cell-1",
      type: "code",
      body: ["saved_value <- 40"],
      options: {},
      revision: 0,
      outputs,
      log: [],
      progress: null,
    }],
    ...overrides,
  };
}

async function fakeQuarto(directory: string, mode: "render" | "fail" | "missing" = "render"): Promise<string> {
  const executable = join(directory, "quarto");
  const body = mode === "fail"
    ? "process.stderr.write('ordinary render error'); process.exit(2);"
    : mode === "missing"
      ? "process.exit(0);"
      : [
          "const input = fs.readFileSync(process.argv[3], 'utf8');",
          "const escaped = input.replaceAll('&', '&amp;').replaceAll('<', '&lt;');",
          "fs.writeFileSync(process.argv[7], '<!doctype html><main><pre>' + escaped + '</pre></main>');",
        ].join("\n");
  await mkdir(directory, { recursive: true });
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    body,
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  await chmod(executable, 0o755);
  return executable;
}

async function setupStore(directory: string): Promise<{ store: OutputStore; record: OutputRecord }> {
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const [record] = await store.ingestDisplay(
    { "text/plain": "saved output" },
    {},
    { runId: "run-publish", cellId: "cell-1", revision: 0 },
  );
  assert.ok(record);
  return { store, record };
}

async function withFakeQuarto<T>(directory: string, mode: "render" | "fail" | "missing", run: (quarto: string) => Promise<T>): Promise<T> {
  const priorPath = process.env.PATH;
  const quarto = await fakeQuarto(join(directory, "bin"), mode);
  process.env.PATH = dirname(quarto) + delimiter + (priorPath ?? "");
  try {
    return await run(quarto);
  } finally {
    process.env.PATH = priorPath;
  }
}

test("publishes saved source and compatible retained output through static Quarto", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-clean-"));
  const { store, record } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  try {
    const result = await withFakeQuarto(directory, "render", (quarto) =>
      new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: quarto })
        .publishSnapshot(snapshot([record]), { outputPath, includeCode: true }));
    assert.deepEqual(result, {
      path: outputPath,
      documentRevision: 4,
      source: "last-saved",
      unsavedChangesExcluded: false,
    });
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /saved_value &lt;- 40/);
    assert.match(html, /saved output/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dirty publication explicitly reports that unsaved edits were excluded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-dirty-"));
  const { store } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  try {
    const result = await withFakeQuarto(directory, "render", (quarto) =>
      new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: quarto })
        .publishSnapshot(snapshot([], { editorDirty: true }), { outputPath, includeCode: true }));
    assert.equal(result.unsavedChangesExcluded, true);
    assert.match(await readFile(outputPath, "utf8"), /saved_value &lt;- 40/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication is independent of runtime, analyzer, graph, and cell status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-independent-"));
  const { store } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  try {
    await withFakeQuarto(directory, "render", (quarto) =>
      new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: quarto })
        .publishSnapshot(snapshot([], {
          cells: [
            { id: "broken", type: "code", body: ["stop('saved error')"], options: {}, revision: 9, outputs: [] },
            { id: "markdown", type: "markdown", body: ["Saved **markdown**"], options: {}, revision: 2, outputs: [] },
          ],
        }), { outputPath, includeCode: true }));
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /stop\('saved error'\)/);
    assert.match(html, /Saved \*\*markdown\*\*/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("captures immutable source and output before concurrent changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-immutable-"));
  const { store, record } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  const source = snapshot([record], { editorDirty: true });
  const priorPath = process.env.PATH;
  try {
    const quarto = await fakeQuarto(join(directory, "bin"), "render");
    process.env.PATH = dirname(quarto) + delimiter + (priorPath ?? "");
    const promise = new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: quarto })
      .publishSnapshot(source, { outputPath, includeCode: true });
    (source.cells[0]!.body as string[])[0] = "concurrent_edit <- 99";
    store.setIdentity({ documentRevision: 5, kernelEpoch });
    await promise;
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /saved_value &lt;- 40/);
    assert.doesNotMatch(html, /concurrent_edit/);
    assert.match(html, /saved output/);
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quarto failure and cancellation leave the destination absent", async () => {
  for (const mode of ["fail", "missing"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `alder-publish-${mode}-`));
    const { store } = await setupStore(directory);
    const outputPath = join(directory, "report.html");
    try {
      await assert.rejects(
        withFakeQuarto(directory, mode, (quarto) =>
          new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: quarto })
            .publishSnapshot(snapshot(), { outputPath, includeCode: false })),
        (error: unknown) => error instanceof PublishingError && error.code === "publish_failed",
      );
      await assert.rejects(access(outputPath), { code: "ENOENT" });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("cancelling a slow publication terminates Quarto and leaves no destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-cancel-"));
  const { store } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  const priorPath = process.env.PATH;
  const quarto = await fakeQuarto(join(directory, "bin"), "render");
  process.env.PATH = dirname(quarto) + delimiter + (priorPath ?? "");
  const started = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>();
  let terminated = false;
  const scope: PublishingProcessScope = {
    spawn: async () => {
      started.resolve();
      return {
        stdout: null,
        stderr: null,
        exited: exited.promise,
        terminate: async () => {
          terminated = true;
          exited.resolve({ code: null, signal: "SIGTERM" });
        },
      };
    },
  };
  const abort = new AbortController();
  try {
    const publishing = new PublishingService({ outputStore: store, processScope: scope, quartoExecutable: quarto })
      .publishSnapshot(snapshot(), { outputPath, includeCode: false, signal: abort.signal });
    await started.promise;
    abort.abort();
    await assert.rejects(publishing, (error: unknown) => error instanceof PublishingError && error.code === "cancelled");
    assert.equal(terminated, true);
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a hung Quarto process is terminated at the publishing deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-timeout-"));
  const { store } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  const quarto = await fakeQuarto(join(directory, "bin"), "render");
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>();
  let terminated = false;
  const scope: PublishingProcessScope = {
    spawn: async () => ({
      stdout: null,
      stderr: null,
      exited: exited.promise,
      terminate: async () => { terminated = true; exited.resolve({ code: null, signal: "SIGTERM" }); },
    }),
  };
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(
      new PublishingService({ outputStore: store, processScope: scope, quartoExecutable: quarto, quartoTimeoutMs: 10 })
        .publishSnapshot(snapshot(), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "publish_failed"
        && (error.details as { code?: string } | undefined)?.code === "publish_timeout",
    );
    assert.equal(terminated, true);
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    clearInterval(keepAlive);
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to replace an existing destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-existing-"));
  const { store } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  await writeFile(outputPath, "existing bytes", "utf8");
  try {
    await assert.rejects(
      new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: join(directory, "missing-quarto") })
        .publishSnapshot(snapshot(), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "destination_exists",
    );
    assert.equal(await readFile(outputPath, "utf8"), "existing bytes");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function installedQuarto(): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "quarto");
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

const installedQuartoPath = await installedQuarto();
test("installed Quarto creates one self-contained HTML file without executing R", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-installed-"));
  const { store } = await setupStore(directory);
  const outputPath = join(directory, "report.html");
  const marker = join(directory, "must-not-exist");
  const priorPath = process.env.PATH;
  process.env.PATH = dirname(installedQuartoPath) + delimiter + (priorPath ?? "");
  try {
    await new PublishingService({ outputStore: store, processScope: directProcessScope(), quartoExecutable: installedQuartoPath }).publishSnapshot(
      snapshot([], { cells: [{ id: "cell-1", type: "code", body: [`writeLines("ran", "${marker}")`], options: {}, revision: 0, outputs: [] }] }),
      { outputPath, includeCode: true },
    );
    assert.match(await readFile(outputPath, "utf8"), /writeLines/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
