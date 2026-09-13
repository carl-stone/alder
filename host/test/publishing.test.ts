import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import { parse } from "parse5";
import {
  createPublishingService,
  PublishingError,
  type PublishingOwnedProcess,
  type PublishingProcessScope,
} from "../src/publishing.js";
import { OutputStore } from "../src/outputs.js";
import type { HostCellState, HostSnapshot, OutputRecord } from "../src/protocol.js";

const epoch = "epoch-publish";
const kernelEpoch = "kernel-publish";
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
type ParsedHtmlNode = {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedHtmlNode[];
};

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

function cell(id: string, outputs: OutputRecord[] = [], overrides: Partial<HostCellState> = {}): HostCellState {
  return {
    id,
    type: "code",
    body: ["42"],
    options: {},
    revision: 0,
    status: "done",
    outputs,
    progress: null,
    log: [],
    error: null,
    defs: [],
    refs: [],
    selfRefs: [],
    locals: [],
    barrier: false,
    opaque: false,
    diagnostics: [],
    analysisPending: false,
    ...overrides,
  };
}

function snapshot(cells: HostCellState[]): HostSnapshot {
  return {
    protocol: "alder-host-v2",
    epoch,
    cursor: 8,
    version: 9,
    documentRevision: 4,
    path: "/tmp/publish-source.R",
    metadata: { title: "Settled publish" },
    config: {},
    layout: null,
    dirty: false,
    disk: { state: "present", digest: "0".repeat(64), version: "disk-v1", error: null },
    sidecars: {
      config: { state: "absent", digest: null, version: null, error: null },
      layout: { state: "absent", digest: null, version: null, error: null },
      packages: { state: "absent", digest: null, version: null, error: null },
    },
    runtime: {
      documentReady: true,
      analyzerState: "ready",
      kernelState: "ready",
      executionReady: true,
      executionBlockedReason: null,
      kernelEpoch,
      rEnvironment: null,
      analysisEnvironmentId: "analysis-publish",
      executionMode: "automatic",
      runOnStartup: true,
      packageOperationActive: false,
      busy: false,
      activeRunId: null,
    },
    cells,
    graph: {
      nodes: cells.map((item) => item.id),
      edges: Object.fromEntries(cells.map((item) => [item.id, []])),
      reverseEdges: Object.fromEntries(cells.map((item) => [item.id, []])),
      duplicates: {},
      cycles: [],
      topologicalOrder: cells.map((item) => item.id),
    },
    variables: [],
    editorDiagnostics: {},
    serviceErrors: {},
    operations: [],
    lastValue: null,
    lastActionError: null,
  };
}

async function fakeQuarto(directory: string, mode: "normal" | "external" | "entity" | "second" | "srcdoc" | "inline" | "missing" = "normal"): Promise<string> {
  const executable = join(directory, "quarto");
  const source = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const output = process.argv[7];",
    "if (!output) { process.stderr.write('missing output'); process.exit(9); }",
    "if (fs.existsSync(path.join(process.cwd(), '_quarto.yml'))) { process.stderr.write('project config inherited'); process.exit(8); }",
    mode === "external"
      ? "fs.writeFileSync(path.join(process.cwd(), output), '<html><body><script src=sidecar.js></script></body></html>');"
      : mode === "entity"
        ? "fs.writeFileSync(path.join(process.cwd(), output), '<!doctype html><html><body><img src=\"&#x68;ttps://entity.example/asset.png\"></body></html>');"
        : mode === "second"
          ? "fs.writeFileSync(path.join(process.cwd(), output), '<!doctype html><html><body><video src=\"data:video/mp4;base64,AA\" poster=\"https://second.example/poster.png\"></video></body></html>');"
          : mode === "srcdoc"
            ? "fs.writeFileSync(path.join(process.cwd(), output), '<!doctype html><html><body><iframe srcdoc=\"&lt;img src=\\'https://srcdoc.example/asset.png\\'&gt;\"></iframe></body></html>');"
            : mode === "inline"
              ? "fs.writeFileSync(path.join(process.cwd(), output), '<!doctype html><html><body><script data=JSON.parse(scriptData.textContent || \"\")>const scriptData = null;</script></body></html>');"
              : mode === "missing"
                ? "process.exit(0);"
                : "fs.writeFileSync(path.join(process.cwd(), output), '<!doctype html><html><body><p>rendered</p></body></html>');",
  ].join("\n");
  await mkdir(directory, { recursive: true });
  await writeFile(executable, source, { encoding: "utf8", mode: 0o755 });
  await chmod(executable, 0o755);
  return executable;
}

async function setupStore(
  cellId: string,
  text: string,
  directory: string,
): Promise<{ store: OutputStore; record: OutputRecord }> {
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const [record] = await store.ingestDisplay(
    { "text/plain": text },
    {},
    { runId: "run-publish", cellId, revision: 0 },
  );
  assert.ok(record, "output store must retain the canonical fixture record");
  return { store, record };
}

async function installedQuarto(): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "quarto");
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

const installedQuartoPath = await installedQuarto();

test("keeps hostile CommonMark shortcodes inert in installed Quarto", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-installed-"));
  const project = await mkdtemp(join(tmpdir(), "alder-publish-installed-project-"));
  const sentinel = join(directory, "sentinel.txt");
  const hookMarker = join(project, "hook-marker");
  const rawMarker = join(project, "raw-marker");
  const outputPath = join(directory, "report.html");
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const priorPath = process.env.PATH;
  try {
    await writeFile(sentinel, "SENTINEL_SECRET_INSTALLED", "utf8");
    await writeFile(join(project, "_quarto.yml"), "project:\n  pre-render: echo hostile > " + hookMarker + "\n", "utf8");
    const htmlOutputs = await store.ingestDisplay({ "text/html": "<div>{{< include " + sentinel + " >}}</div>" }, {}, { runId: "run-installed", cellId: "code", revision: 0 });
    const markdownOutputs = await store.ingestDisplay(
      {
        "text/markdown":
          "# Canonical Markdown Output\n\nCANONICAL_MARKDOWN_OUTPUT\n\n{{< include " + sentinel + " >}}\n\n<script>require('node:fs').writeFileSync('" + rawMarker + "', 'raw')</script>",
      },
      {},
      { kernelEpoch: null, runId: null, cellId: "markdown", revision: 0 },
    );
    const markdown = cell("markdown", markdownOutputs, {
      type: "markdown",
      body: [
        "# Logical Markdown",
        "SOURCE_MARKDOWN_MUST_NOT_BE_USED",
        "{{< include " + sentinel + " >}}",
        "{{% include /etc/passwd %}}",
        "~~~{r}",
        "{{{< include " + sentinel + " >}}}",
        "writeLines(\"fenced\", \"" + rawMarker + "\")",
        "~~~",
        "<script>require('node:fs').writeFileSync('" + rawMarker + "', 'raw')</script>",
        "---",
        "title: hostile second front matter",
        "---",
      ],
    });
    const code = cell("code", htmlOutputs, { body: ["42"] });
    process.env.PATH = dirname(installedQuartoPath) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    const settled = { ...snapshot([markdown, code]), path: join(project, "notebook.R") };
    await service.publishSnapshot(settled, { outputPath, includeCode: true });
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /CANONICAL_MARKDOWN_OUTPUT/);
    const bodyText = parseHTML(html).document.body?.textContent ?? "";
    assert.doesNotMatch(bodyText, /\{\{\{< include /, bodyText);
    assert.ok(bodyText.includes("{{< include " + sentinel + " >}}"), bodyText);
    assert.doesNotMatch(html, /SOURCE_MARKDOWN_MUST_NOT_BE_USED/);
    assert.doesNotMatch(html, /SENTINEL_SECRET_INSTALLED/);
    assert.doesNotMatch(html, /writeFileSync/);
    await assert.rejects(access(hookMarker), { code: "ENOENT" });
    await assert.rejects(access(rawMarker), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
test("preserves complete, escaped, malformed, and nested shortcode literals", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-literals-"));
  const project = await mkdtemp(join(tmpdir(), "alder-publish-literals-project-"));
  const outputPath = join(directory, "report.html");
  const secretPath = join(project, "include-secret.txt");
  const hookMarker = join(project, "hook-marker");
  const priorPath = process.env.PATH;
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const complete = "{{< include " + secretPath + " >}}";
  const alreadyTriple = "{{{< include " + secretPath + " >}}}";
  const malformed = "{{< include " + secretPath + " >";
  const nested = "{{< include {{< meta title >}} >}}";
  const percent = "{{% include " + secretPath + " %}}";
  const escaped = "\\" + complete;
  const title = "Literal title {{< meta title >}} and {{< include " + secretPath + " >";
  const codeLines = [
    "complete " + complete,
    "already-triple " + alreadyTriple,
    "malformed " + malformed,
    "nested " + nested,
    "percent " + percent,
    "escaped " + escaped,
  ];
  try {
    await writeFile(secretPath, "SENTINEL_SECRET_PUBLISH_LITERAL", "utf8");
    const hookScript = join(project, "hook.sh");
    await writeFile(hookScript, "#!/bin/sh\necho hook > " + hookMarker + "\n", { encoding: "utf8", mode: 0o755 });
    await chmod(hookScript, 0o755);
    await writeFile(join(project, "_quarto.yml"), "project:\n  type: default\n  pre-render: ./hook.sh\n", "utf8");
    await writeFile(join(project, "probe.qmd"), [
      "---",
      "title: probe",
      "format: html",
      "---",
      "",
      "probe",
    ].join("\n"), "utf8");
    process.env.PATH = dirname(installedQuartoPath) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const probe = spawn(installedQuartoPath, ["render", "probe.qmd", "--to", "html", "--no-execute", "--output", "probe.html"], {
      cwd: project,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const probeStderr: Buffer[] = [];
    probe.stderr?.on("data", (chunk: Buffer) => probeStderr.push(chunk));
    const probeCode = await new Promise<number | null>((resolve, reject) => {
      probe.once("error", reject);
      probe.once("exit", (code) => resolve(code));
    });
    assert.equal(probeCode, 0, Buffer.concat(probeStderr).toString("utf8"));
    assert.equal(await readFile(hookMarker, "utf8"), "hook\n");
    await rm(hookMarker, { force: true });

    const outputRecords = await store.ingestDisplay(
      { "text/plain": "Output literal " + complete + "\noutput triple " + alreadyTriple },
      {},
      { runId: "run-literal", cellId: "code", revision: 0 },
    );
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    const settled = { ...snapshot([cell("code", outputRecords, { body: codeLines })]), metadata: { title }, path: join(project, "notebook.R") };
    await service.publishSnapshot(settled, { outputPath, includeCode: true });
    const html = await readFile(outputPath, "utf8");
    const bodyText = parseHTML(html).document.body?.textContent ?? "";
    assert.ok(bodyText.includes("Output literal " + complete), "output literal");
    assert.ok(html.includes("{{&lt; include " + secretPath + " &gt;}}"), "complete literal survives in HTML bytes");
    assert.ok(bodyText.includes("complete " + complete), "complete literal");
    assert.ok(bodyText.includes("already-triple " + alreadyTriple), "already-triple source remains exact");
    assert.ok(bodyText.includes("output triple " + alreadyTriple), "encoded triple output remains exact");
    assert.ok(bodyText.includes("malformed " + malformed), "malformed literal");
    assert.ok(bodyText.includes("nested " + nested), "nested literal");
    assert.ok(bodyText.includes("percent " + percent), "percent literal");
    assert.ok(bodyText.includes("escaped " + escaped), "escaped literal");
    const renderedTitle = parseHTML(html).document.querySelector("title")?.textContent;
    assert.ok(renderedTitle === title, JSON.stringify({ renderedTitle, title }));
    assert.doesNotMatch(html, /SENTINEL_SECRET_PUBLISH_LITERAL/);
    await assert.rejects(access(hookMarker), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
test("rejects runtime Markdown output identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-markdown-identity-"));
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const [record] = await store.ingestDisplay(
    { "text/markdown": "# Runtime Markdown" },
    {},
    { runId: "run-markdown", cellId: "markdown", revision: 0 },
  );
  assert.ok(record);
  const outputPath = join(directory, "report.html");
  try {
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await assert.rejects(
      service.publishSnapshot(snapshot([cell("markdown", [record], { type: "markdown" })]), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "stale_value",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes a settled snapshot without inheriting project hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-quarto-"));
  const project = await mkdtemp(join(tmpdir(), "alder-publish-project-"));
  const marker = join(project, "hook-marker");
  const priorPath = process.env.PATH;
  const { store, record } = await setupStore("cell-1", "captured output", directory);
  const outputPath = join(directory, "report.html");
  try {
    await writeFile(join(project, "_quarto.yml"), `project:\n  pre-render: echo hook > ${marker}\n`, "utf8");
    const bin = join(directory, "bin");
    const quarto = await fakeQuarto(bin);
    process.env.PATH = `${dirname(quarto)}${process.platform === "win32" ? ";" : ":"}${priorPath ?? ""}`;
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    const result = await service.publishSnapshot(snapshot([cell("cell-1", [record])]), {
      outputPath,
      includeCode: true,
    });
    assert.equal(result.path, outputPath);
    assert.equal(result.documentRevision, 4);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("rejects stale cells before invoking Quarto", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-stale-"));
  const { store, record } = await setupStore("cell-1", "old", directory);
  const outputPath = join(directory, "report.html");
  try {
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await assert.rejects(
      service.publishSnapshot(snapshot([cell("cell-1", [record], { status: "stale" })]), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "publish_not_ready",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when Quarto leaves a sidecar asset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-assets-"));
  const { store, record } = await setupStore("cell-1", "captured", directory);
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  try {
    const quarto = await fakeQuarto(join(directory, "bin"), "external");
    process.env.PATH = `${dirname(quarto)}${process.platform === "win32" ? ";" : ":"}${priorPath ?? ""}`;
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await assert.rejects(
      service.publishSnapshot(snapshot([cell("cell-1", [record])]), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "publish_external_assets",
    );
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("allows resource-looking inline script data text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-inline-script-"));
  const { store, record } = await setupStore("cell-1", "captured", directory);
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  try {
    const quarto = await fakeQuarto(join(directory, "bin"), "inline");
    process.env.PATH = `${dirname(quarto)}${process.platform === "win32" ? ";" : ":"}${priorPath ?? ""}`;
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await service.publishSnapshot(snapshot([cell("cell-1", [record])]), { outputPath, includeCode: false });
    assert.match(await readFile(outputPath, "utf8"), /JSON\.parse\(scriptData\.textContent/);
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects decoded, secondary, and nested srcdoc assets", async () => {
  const cases = [
    ["entity", "https://entity.example/asset.png"],
    ["second", "https://second.example/poster.png"],
    ["srcdoc", "https://srcdoc.example/asset.png"],
  ] as const;
  for (const [mode, marker] of cases) {
    const directory = await mkdtemp(join(tmpdir(), `alder-publish-${mode}-asset-`));
    const { store, record } = await setupStore("cell-1", "captured", directory);
    const priorPath = process.env.PATH;
    const outputPath = join(directory, "report.html");
    try {
      const quarto = await fakeQuarto(join(directory, "bin"), mode);
      process.env.PATH = `${dirname(quarto)}${process.platform === "win32" ? ";" : ":"}${priorPath ?? ""}`;
      const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
      await assert.rejects(
        service.publishSnapshot(snapshot([cell("cell-1", [record])]), { outputPath, includeCode: false }),
        (error: unknown) => error instanceof PublishingError && error.code === "publish_external_assets" && error.message.includes(marker),
      );
      await assert.rejects(access(outputPath), { code: "ENOENT" });
    } finally {
      process.env.PATH = priorPath;
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("refuses to replace an existing destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-destination-"));
  const outputPath = join(directory, "report.html");
  await writeFile(outputPath, "user bytes", "utf8");
  const { store, record } = await setupStore("cell-1", "captured", directory);
  try {
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await assert.rejects(
      service.publishSnapshot(snapshot([cell("cell-1", [record])]), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "destination_exists",
    );
    assert.equal(await readFile(outputPath, "utf8"), "user bytes");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("embeds canonical rich artifacts and inert lazy/widget output", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-rich-"));
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  const identity = { runId: "run-rich", cellId: "cell-1", revision: 0 };
  try {
    const artifactIdentity = { sessionEpoch: epoch, documentRevision: 4, kernelEpoch, ...identity };
    const image = await store.ingestDisplay({ "image/png": pngBase64 }, {}, identity);
    const htmlArtifact = await store.writeArtifact(Buffer.from("<div>offline widget</div>", "utf8"), "text/html", ".html", artifactIdentity);
    const html = await store.ingestAlder({ kind: "html", artifact: htmlArtifact, alt_text: "offline widget > title" }, artifactIdentity);
    const pdfArtifact = await store.writeArtifact(Buffer.from("%PDF-1.7\\n", "utf8"), "application/pdf", ".pdf", artifactIdentity);
    const pdf = await store.ingestAlder({ kind: "media", media_type: "pdf", artifact: pdfArtifact, mime: "application/pdf", alt: "Offline PDF" }, artifactIdentity);
    const widget = store.ingestAlder({
      kind: "widget",
      name: "toggle",
      owner: "cell-1",
      path: [],
      commit_token: null,
      operation: null,
      spec: { kind: "checkbox", label: "Enabled", value: true },
    }, { sessionEpoch: epoch, documentRevision: 4, kernelEpoch, ...identity });
    const lazy = store.ingestAlder({ kind: "lazy", key: "lazy-1", label: "Deferred result", state: "collapsed", child: null }, { sessionEpoch: epoch, documentRevision: 4, kernelEpoch, ...identity });
    process.env.PATH = dirname(installedQuartoPath) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await service.publishSnapshot(snapshot([cell("cell-1", [...image, html, pdf, widget, lazy])]), { outputPath, includeCode: false });
    const published = await readFile(outputPath, "utf8");
    assert.ok(published.includes(`data:image/png;base64,${pngBase64}`));
    assert.match(published, /offline widget/);
    assert.match(published, /sandbox="allow-scripts"/);
    const publishedDocument = parseHTML(published).document;
    const artifactFrame = publishedDocument.querySelector('iframe[data-alder-artifact-frame="html"]');
    assert.ok(artifactFrame);
    assert.equal(artifactFrame.getAttribute("title"), "offline widget > title");
    assert.equal(artifactFrame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(artifactFrame.getAttribute("referrerpolicy"), "no-referrer");
    const pdfFrame = publishedDocument.querySelector('iframe[data-alder-artifact-frame="pdf"]');
    assert.ok(pdfFrame);
    assert.equal(pdfFrame.hasAttribute("sandbox"), false);
    assert.equal(pdfFrame.hasAttribute("srcdoc"), false);
    assert.equal(pdfFrame.getAttribute("referrerpolicy"), "no-referrer");
    assert.match(pdfFrame.getAttribute("src") ?? "", /^data:application\/pdf;base64,[A-Za-z0-9+/]*={0,2}$/);
    const checkbox = publishedDocument.querySelector('input[type="checkbox"]');
    assert.ok(checkbox);
    assert.equal(checkbox.hasAttribute("disabled"), true);
    assert.equal(checkbox.hasAttribute("checked"), true);
    const widgetSnapshotNote = publishedDocument.querySelector(".widget-snapshot-note");
    assert.equal(widgetSnapshotNote?.textContent?.trim(), "Published snapshot (noninteractive).");
    assert.equal(widgetSnapshotNote?.getAttribute("role"), "note");
    const lazyOutput = [...publishedDocument.querySelectorAll(".out-record")].find(element => element.textContent?.includes("Deferred result"));
    assert.ok(lazyOutput);
    assert.equal(lazyOutput.querySelector("button"), null);
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("publishes canonical textarea text without closing-tag injection", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-textarea-"));
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  const textareaValue = "ordinary before </textarea><img src=data:image/png;base64,AA onerror=textarea_injected> & ordinary after";
  try {
    const widget = await store.ingestAlder({
      kind: "widget",
      name: "notes",
      owner: "cell-textarea",
      path: [],
      commit_token: null,
      operation: null,
      spec: { kind: "text_area", label: "Notes", value: textareaValue, rows: 4 },
    }, {
      sessionEpoch: epoch,
      documentRevision: 4,
      kernelEpoch,
      runId: "run-textarea",
      cellId: "cell-textarea",
      revision: 0,
    });
    process.env.PATH = dirname(installedQuartoPath) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await service.publishSnapshot(snapshot([cell("cell-textarea", [widget])]), { outputPath, includeCode: false });
    const published = await readFile(outputPath, "utf8");
    const publishedDocument = parse(published) as ParsedHtmlNode;
    const nodes: ParsedHtmlNode[] = [];
    const visit = (node: ParsedHtmlNode): void => {
      nodes.push(node);
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(publishedDocument);
    const textarea = nodes.find((node) => node.nodeName === "textarea");
    assert.ok(textarea);
    const textareaText = (textarea.childNodes ?? [])
      .filter((node) => node.nodeName === "#text")
      .map((node) => node.value ?? "")
      .join("");
    assert.equal(textareaText, textareaValue);
    const injectedImages = nodes.filter((node) => node.nodeName === "img" && (node.attrs ?? []).some(({ name }) => name === "onerror"));
    assert.equal(injectedImages.length, 0);
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("publishes canonical inline HTML without unsafe markup", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-inline-html-"));
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  try {
    const inline = await store.ingestAlder({
      kind: "html",
      html: '<strong>INLINE_HTML_SAFE</strong><button onclick="INLINE_HTML_BAD_HANDLER">INLINE_HTML_BUTTON</button><script>window.INLINE_HTML_BAD_SCRIPT = true</script>',
    }, {
      sessionEpoch: epoch,
      documentRevision: 4,
      kernelEpoch,
      runId: "run-inline-html",
      cellId: "cell-inline-html",
      revision: 0,
    });
    process.env.PATH = dirname(installedQuartoPath) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await service.publishSnapshot(snapshot([cell("cell-inline-html", [inline])]), { outputPath, includeCode: false });
    const published = await readFile(outputPath, "utf8");
    assert.match(published, /<strong[^>]*>INLINE_HTML_SAFE<\/strong>/i);
    assert.doesNotMatch(published, /INLINE_HTML_BAD_HANDLER|INLINE_HTML_BAD_SCRIPT/);
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not treat artifact-shaped JSON values as retained artifacts", { skip: installedQuartoPath === null }, async () => {
  if (installedQuartoPath === null) return;
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-json-value-"));
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: epoch,
    documentRevision: 4,
    kernelEpoch,
  });
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  try {
    const jsonValue = { handle: "json-lookalike", mimeType: "text/plain", value: "JSON_LOOKALIKE_VALUE" };
    const [record] = await store.ingestDisplay(
      { "application/json": jsonValue },
      {},
      { runId: "run-json", cellId: "cell-json", revision: 0 },
    );
    assert.ok(record);
    process.env.PATH = dirname(installedQuartoPath) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await service.publishSnapshot(snapshot([cell("cell-json", [record])]), { outputPath, includeCode: false });
    const published = await readFile(outputPath, "utf8");
    assert.match(published, /JSON_LOOKALIKE_VALUE/);
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a missing Quarto output as publish_failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-missing-"));
  const { store, record } = await setupStore("cell-1", "captured", directory);
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  try {
    const quarto = await fakeQuarto(join(directory, "bin"), "missing");
    process.env.PATH = dirname(quarto) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const service = createPublishingService({ outputStore: store, processScope: directProcessScope() });
    await assert.rejects(
      service.publishSnapshot(snapshot([cell("cell-1", [record])]), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "publish_failed",
    );
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a store identity change during rendering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-publish-generation-"));
  const { store, record } = await setupStore("cell-1", "captured", directory);
  const priorPath = process.env.PATH;
  const outputPath = join(directory, "report.html");
  try {
    const quarto = await fakeQuarto(join(directory, "bin"));
    process.env.PATH = dirname(quarto) + (process.platform === "win32" ? ";" : ":") + (priorPath ?? "");
    const baseScope = directProcessScope();
    const processScope: PublishingProcessScope = {
      spawn: async (options) => {
        const owned = await baseScope.spawn(options);
        store.setIdentity({ documentRevision: 5, kernelEpoch });
        return owned;
      },
    };
    const service = createPublishingService({ outputStore: store, processScope });
    await assert.rejects(
      service.publishSnapshot(snapshot([cell("cell-1", [record])]), { outputPath, includeCode: false }),
      (error: unknown) => error instanceof PublishingError && error.code === "stale_value",
    );
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    process.env.PATH = priorPath;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
