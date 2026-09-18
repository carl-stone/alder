import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OutputStore, OutputStoreError } from "../src/outputs.js";
import { artifactHandleSchema } from "../src/protocol.js";

const identity = { runId: "run-1", cellId: "cell-1", revision: 0 };

async function makeStore(options: Partial<ConstructorParameters<typeof OutputStore>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "alder-output-boundary-"));
  const store = new OutputStore({
    artifactDirectory: join(directory, "artifacts"),
    sessionEpoch: "session-1",
    documentRevision: 0,
    kernelEpoch: "kernel-1",
    ...options,
  });
  return { directory, store };
}

function runtimeIdentity(overrides: Record<string, unknown> = {}) {
  return { sessionEpoch: "session-1", documentRevision: 0, kernelEpoch: "kernel-1", ...identity, ...overrides };
}

test("assigns HTML provenance to normalized output", async () => {
  const { directory, store } = await makeStore();
  try {
    const markdown = await store.ingestAlder({ kind: "markdown", text: "# title" }, runtimeIdentity(), { presentation: "sandbox" });
    assert.equal(markdown.metadata.presentation, "inline");
    const html = await store.ingestAlder({ kind: "html", html: "<p>ok</p><script>bad()</script>" }, runtimeIdentity());
    assert.equal(html.metadata.presentation, "inline");
    assert.equal(typeof html.data.html, "string");
    assert.doesNotMatch(String(html.data.html), /script/i);
    assert.equal(store.snapshot().artifacts.length, 0);
    const native = (await store.ingestDisplay({ "text/html": "<p>native</p>" }, {}, runtimeIdentity()))[0]!;
    assert.equal(native.metadata.presentation, "sandbox");
    assert.equal(store.snapshot().artifacts.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects symbol-bearing rich inputs before schema projection", async () => {
  const { directory, store } = await makeStore();
  try {
    const payload = { kind: "text", text: "x", truncated: false } as Record<PropertyKey, unknown>;
    payload[Symbol("extra")] = 123;
    assert.throws(
      () => store.ingestAlder(payload, runtimeIdentity()),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_invalid",
    );
    assert.equal(store.records().length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects oversized registered artifacts before copying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-output-import-boundary-"));
  const sourceDirectory = join(directory, "source");
  const retainedDirectory = join(directory, "retained");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "oversized.bin"), Buffer.alloc(101, 7));
  const store = new OutputStore({
    artifactDirectory: retainedDirectory,
    artifactSourceDirectory: sourceDirectory,
    sessionEpoch: "session-1",
    documentRevision: 0,
    kernelEpoch: "kernel-1",
    maxArtifactBytes: 100,
  });
  try {
    await assert.rejects(
      store.importArtifact("oversized.bin", runtimeIdentity()),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_quota",
    );
    assert.equal((await readdir(retainedDirectory).catch(() => [])).length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonicalizes UTF-8 and opaque live handles while rejecting unsafe artifacts", async () => {
  const { directory, store } = await makeStore();
  try {
    const text = (await store.ingestDisplay({ "text/plain": "ok " + String.fromCodePoint(0x1f600) }, {}, runtimeIdentity()))[0]!;
    assert.equal(text.data.kind, "text");
    assert.equal(String(text.data.text), "ok " + String.fromCodePoint(0x1f600));
    const table = store.ingestAlder({
      kind: "table", nrow: 1, ncol: 1, columns: ["x"], preview: [[1]], offset: 0, limit: 25,
      sort_by: "", sort_desc: false, filter: "", truncated_rows: false, truncated_columns: false,
      handle: "cell:name:1",
    }, runtimeIdentity());
    assert.equal(table.data.handle, "cell:name:1");
    const descriptorLikeCell = {
      handle: "not-retained", mimeType: "application/json", byteLength: 0, chunkBytes: 262_144,
      epoch: "session-1", documentRevision: 1, kernelEpoch: "kernel-1",
    };
    const tableWithDescriptorLikeCell = store.ingestAlder({
      kind: "table", nrow: 1, ncol: 1, columns: ["x"], preview: [[descriptorLikeCell]], offset: 0, limit: 25,
      sort_by: "", sort_desc: false, filter: "", truncated_rows: false, truncated_columns: false,
      handle: "cell:descriptor-like:1",
    }, runtimeIdentity({ cellId: "descriptor-like" }));
    assert.equal((tableWithDescriptorLikeCell.data.preview[0][0] as Record<string, unknown>).handle, "not-retained");
    assert.equal(store.snapshot().artifacts.length, 0);
    const kindImageCell = await store.ingestAlder({
      kind: "table", nrow: 1, ncol: 1, columns: ["x"], preview: [[{ kind: "image", artifact: "not-a-file.txt", note: "ordinary" }]], offset: 0, limit: 25,
      sort_by: "", sort_desc: false, filter: "", truncated_rows: false, truncated_columns: false,
      handle: "cell:kind-image:1",
    }, runtimeIdentity({ cellId: "kind-image" }));
    assert.equal((kindImageCell.data.preview[0][0] as Record<string, unknown>).artifact, "not-a-file.txt");
    assert.equal(store.snapshot().artifacts.length, 0);
    await assert.rejects(
      store.ingestAlder({ kind: "image", artifact: "../escape.png", mime: "image/png" }, runtimeIdentity()),
      (error: unknown) => error instanceof OutputStoreError,
    );
    await assert.rejects(
      store.ingestDisplay({ "image/png": "A" }, {}, runtimeIdentity()),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_invalid",
    );
    const svg = (await store.ingestDisplay({ "image/svg+xml": "<svg>😀</svg>" }, {}, runtimeIdentity()))[0]!;
    const descriptor = svg.data.artifact;
    assert.equal(Buffer.from(await store.readArtifact(descriptor, 0, 1024)).toString("utf8"), "<svg>😀</svg>");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("binds rich media variants to compatible artifact MIME", async () => {
  const { directory, store } = await makeStore();
  try {
    const pdfIdentity = runtimeIdentity({ cellId: "media-pdf" });
    const pdfArtifact = await store.writeArtifact(Buffer.from("%PDF-1.7\\n", "utf8"), "application/pdf", ".pdf", pdfIdentity);
    const accepted = await store.ingestAlder({
      kind: "media", media_type: "pdf", artifact: pdfArtifact, mime: "application/pdf", alt: "",
    }, pdfIdentity);
    assert.equal(accepted.data.kind, "media");
    assert.equal(accepted.data.media_type, "pdf");

    const htmlIdentity = runtimeIdentity({ cellId: "media-html" });
    const htmlArtifact = await store.writeArtifact(Buffer.from("<p>not a PDF</p>", "utf8"), "text/html", ".html", htmlIdentity);
    assert.throws(
      () => store.ingestAlder({
        kind: "media", media_type: "pdf", artifact: htmlArtifact, mime: "text/html", alt: "",
      }, htmlIdentity),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_invalid",
    );
    assert.throws(
      () => store.ingestAlder({
        kind: "html", artifact: pdfArtifact,
      }, pdfIdentity),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_invalid",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("accepts Ark's canonical unpadded binary MIME payloads", async () => {
  const { directory, store } = await makeStore();
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const payload = bytes.toString("base64").replace(/=+$/, "");
    const [record] = await store.ingestDisplay({ "image/png": payload }, {}, runtimeIdentity());
    assert.equal(record?.data.kind, "image");
    assert.equal(record?.data.mime, "image/png");
    assert.deepEqual(Buffer.from(await store.readArtifact(record!.data.artifact, 0, bytes.length)), bytes);
    const [paddedRecord] = await store.ingestDisplay(
      { "image/png": bytes.toString("base64") }, {}, runtimeIdentity({ cellId: "padded" }),
    );
    assert.deepEqual(Buffer.from(await store.readArtifact(paddedRecord!.data.artifact, 0, bytes.length)), bytes);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lastSextet = alphabet.indexOf(payload[payload.length - 1]!);
    const nonCanonicalLast = (lastSextet & ~0x03) | ((lastSextet + 1) & 0x03);
    for (const invalid of [
      `data:image/png;base64,${payload}`,
      payload.slice(0, -1) + String.fromCharCode(10),
      "-" + payload.slice(1),
      payload.slice(0, -1) + alphabet[nonCanonicalLast]!,
    ]) {
      await assert.rejects(
        store.ingestDisplay({ "image/png": invalid }, {}, runtimeIdentity({ cellId: "invalid-" + invalid.length })),
        (error: unknown) => error instanceof OutputStoreError && error.code === "output_invalid",
      );
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("serializes artifact quota reservations without orphaning concurrent writes", async () => {
  const { directory, store } = await makeStore({ maxArtifactBytes: 100 });
  try {
    const payload = Buffer.alloc(60, 7).toString("base64");
    const results = await Promise.all([
      store.ingestDisplay({ "image/png": payload }, {}, runtimeIdentity({ cellId: "cell-a", runId: "run-a" })),
      store.ingestDisplay({ "image/png": payload }, {}, runtimeIdentity({ cellId: "cell-b", runId: "run-b" })),
    ]);
    const records = results.flat();
    assert.equal(records.length, 2);
    assert.equal(records.filter((record) => record.data.kind === "image").length, 1);
    const quotaRecord = records.find((record) => record.data.kind === "error");
    assert.ok(quotaRecord);
    if (!quotaRecord || quotaRecord.data.kind !== "error") throw new Error("quota record was not returned");
    assert.equal(quotaRecord.data.code, "output_quota");
    assert.equal(quotaRecord.truncated, true);
    assert.equal(store.records().length, 2);
    assert.equal(store.snapshot().artifacts.length, 1);
    const files = await readdir(join(directory, "artifacts"));
    assert.equal(files.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a visible truncated error when pinned artifact quota is saturated", async () => {
  const { directory, store } = await makeStore({ maxArtifactBytes: 1 });
  try {
    const firstBytes = Buffer.from([0]);
    const [first] = await store.ingestDisplay(
      { "image/png": firstBytes.toString("base64") },
      {},
      runtimeIdentity({ cellId: "quota-first", runId: "run-quota-first" }),
    );
    assert.ok(first);
    const firstArtifact = artifactHandleSchema.parse(first.data.artifact);
    const reader = store.openArtifactResource(firstArtifact);
    const [quota] = await store.ingestDisplay(
      { "image/png": Buffer.from([1]).toString("base64") },
      {},
      runtimeIdentity({ cellId: "quota-second", runId: "run-quota-second" }),
    );
    assert.ok(quota);
    assert.equal(quota.data.kind, "error");
    if (quota.data.kind !== "error") throw new Error("quota record was not returned");
    assert.equal(quota.data.code, "output_quota");
    assert.equal(quota.data.message, "retained artifact quota is full");
    assert.equal("artifact" in quota.data, false);
    assert.equal(quota.truncated, true);
    assert.equal(store.records().length, 2);
    assert.equal(store.getRecord(first.id), first);
    assert.deepEqual(Buffer.from(await reader.read(0, firstBytes.length)), firstBytes);
    reader.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clear and close preserve pinned artifacts until readers release them", async () => {
  const { directory, store } = await makeStore();
  try {
    const bytes = Buffer.from("pinned output", "utf8");
    const [cleared] = await store.ingestDisplay(
      { "text/html": bytes.toString("utf8") },
      {},
      runtimeIdentity({ cellId: "clear-pinned", runId: "run-clear-pinned" }),
    );
    assert.ok(cleared);
    const clearedArtifact = artifactHandleSchema.parse(cleared.data.artifact);
    const clearReader = store.openArtifactResource(clearedArtifact);
    await store.clear();
    assert.equal(store.records().length, 0);
    assert.deepEqual(Buffer.from(await clearReader.read(0, bytes.length)), bytes);
    assert.equal((await readdir(join(directory, "artifacts"))).length, 1);
    clearReader.close();
    assert.equal((await readdir(join(directory, "artifacts")).catch(() => [])).length, 0);

    const [closed] = await store.ingestDisplay(
      { "text/html": bytes.toString("utf8") },
      {},
      runtimeIdentity({ cellId: "close-pinned", runId: "run-close-pinned" }),
    );
    assert.ok(closed);
    const closedArtifact = artifactHandleSchema.parse(closed.data.artifact);
    const closeReader = store.openArtifactResource(closedArtifact);
    await store.close();
    assert.equal((await readdir(join(directory, "artifacts"))).length, 1);
    closeReader.close();
    assert.equal((await readdir(join(directory, "artifacts")).catch(() => [])).length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps historical and ahead static artifacts across active identity changes", async () => {
  const { directory, store } = await makeStore({ documentRevision: 2, kernelEpoch: "kernel-2" });
  try {
    const activeIdentity = runtimeIdentity({
      documentRevision: 2,
      kernelEpoch: "kernel-2",
      cellId: "active",
      runId: "run-active",
    });
    const active = await store.ingestAlder({ kind: "text", text: "active output", truncated: false }, activeIdentity);
    assert.equal(store.records("active").length, 1);

    const historicalScope = {
      sessionEpoch: "session-1",
      documentRevision: 1,
      kernelEpoch: null,
      runId: null,
      cellId: null,
      revision: null,
    };
    const aheadScope = { ...historicalScope, documentRevision: 3 };
    const historicalBytes = Buffer.from("historical source bytes\n", "utf8");
    const aheadBytes = Buffer.from("ahead source bytes\n", "utf8");
    const historical = await store.writeStaticArtifact(
      historicalBytes, "text/plain; charset=utf-8", ".R", historicalScope,
    );
    const ahead = await store.writeStaticArtifact(
      aheadBytes, "text/plain; charset=utf-8", ".R", aheadScope,
    );
    assert.equal(historical.documentRevision, 1);
    assert.equal(historical.kernelEpoch, null);
    assert.equal(ahead.documentRevision, 3);
    assert.equal(ahead.kernelEpoch, null);
    assert.deepEqual(Buffer.from(await store.readArtifact(historical, 0, historicalBytes.length)), historicalBytes);
    assert.deepEqual(Buffer.from(await store.readArtifact(ahead, 0, aheadBytes.length)), aheadBytes);
    await assert.rejects(
      store.readArtifact({ ...historical, epoch: "other-session" }, 0, historicalBytes.length),
      (error: unknown) => error instanceof OutputStoreError && error.code === "stale_value",
    );
    assert.equal(store.records("active").length, 1);
    assert.equal(active.data.text, "active output");

    await assert.rejects(
      store.writeStaticArtifact(historicalBytes, "text/plain; charset=utf-8", ".R", { ...historicalScope, sessionEpoch: "other-session" }),
      (error: unknown) => error instanceof OutputStoreError && error.code === "stale_value",
    );

    const requestScope = { ...historicalScope, documentRevision: 2 };
    const requestBytes = Buffer.from("requested source bytes\n", "utf8");
    const requestArtifact = await store.writeStaticArtifact(
      requestBytes, "image/png", ".png", requestScope,
    );
    const normalizedRequest = await store.normalizeAlder(
      { kind: "image", artifact: requestArtifact, mime: "image/png", alt: "" }, requestScope,
    );
    assert.deepEqual((normalizedRequest as unknown as Record<string, unknown>).artifact, requestArtifact);

    await store.setIdentity({ documentRevision: 2, kernelEpoch: "kernel-3" });
    assert.deepEqual(Buffer.from(await store.readArtifact(requestArtifact, 0, requestBytes.length)), requestBytes);
    await store.setIdentity({ documentRevision: 3, kernelEpoch: "kernel-3" });

    assert.deepEqual(Buffer.from(await store.readArtifact(historical, 0, historicalBytes.length)), historicalBytes);
    assert.deepEqual(Buffer.from(await store.readArtifact(ahead, 0, aheadBytes.length)), aheadBytes);
    assert.throws(
      () => store.ingestAlder(
        { kind: "text", text: "stale kernel output", truncated: false },
        runtimeIdentity({ documentRevision: 3, kernelEpoch: "kernel-2", cellId: "stale-kernel", runId: "run-stale-kernel" }),
      ),
      (error: unknown) => error instanceof OutputStoreError && error.code === "stale_value",
    );
    const current = await store.ingestAlder(
      { kind: "text", text: "new active output", truncated: false },
      runtimeIdentity({ documentRevision: 3, kernelEpoch: "kernel-3", cellId: "current", runId: "run-current" }),
    );
    assert.equal(current.data.text, "new active output");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});



test("retains visible rich artifacts across kernel restart while retiring stale request artifacts", async () => {
  const { directory, store } = await makeStore();
  try {
    const visibleIdentity = runtimeIdentity({ cellId: "retained-html", runId: "run-html" });
    const htmlBytes = Buffer.from("<article>retained HTML</article>", "utf8");
    const visible = (await store.ingestDisplay(
      { "text/html": htmlBytes.toString("utf8") },
      {},
      visibleIdentity,
    ))[0]!;
    const visibleArtifact = artifactHandleSchema.parse(visible.data.artifact);

    // Exercise the request-retention path with the same handle as the visible record.
    await store.normalizeAlder(
      { kind: "html", artifact: visibleArtifact, alt_text: "" },
      visibleIdentity,
    );

    const requestIdentity = runtimeIdentity({ cellId: "stale-request", runId: "run-stale-request" });
    const requestBytes = Buffer.from("<article>request only</article>", "utf8");
    const requestArtifact = await store.writeArtifact(requestBytes, "text/html", ".html", requestIdentity);
    await store.normalizeAlder(
      { kind: "html", artifact: requestArtifact, alt_text: "" },
      requestIdentity,
    );

    assert.deepEqual(Buffer.from(await store.readArtifact(requestArtifact, 0, requestBytes.length)), requestBytes);
    await store.setIdentity({ documentRevision: 1, kernelEpoch: "kernel-2" });

    assert.equal(store.getRecord(visible.id), visible);
    assert.deepEqual(Buffer.from(await store.readArtifact(visibleArtifact.handle, 0, htmlBytes.length)), htmlBytes);
    await assert.rejects(
      store.readArtifact(requestArtifact, 0, requestBytes.length),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});



test("preserves async raw HTML records through restart and browser resource reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-output-restart-"));
  const sourceDirectory = join(directory, "source");
  const artifactDirectory = join(directory, "artifacts");
  await mkdir(sourceDirectory);
  const bytes = Buffer.from("<section>async HTML output</section>", "utf8");
  await writeFile(join(sourceDirectory, "widget.html"), bytes);
  const store = new OutputStore({
    artifactDirectory,
    artifactSourceDirectory: sourceDirectory,
    sessionEpoch: "session-1",
    documentRevision: 0,
    kernelEpoch: "kernel-1",
  });
  try {
    const runtime = runtimeIdentity({ cellId: "async-html", runId: "run-async-html" });
    const record = await store.ingestAlder({ kind: "html", artifact: "widget.html", alt_text: "" }, runtime);
    const descriptor = artifactHandleSchema.parse(record.data.artifact);
    const manifest = store.artifactManifest(descriptor);

    // Engine.stopPeers performs this cleanup before the replacement kernel is ready.
    store.invalidateRequests({ kernelEpoch: runtime.kernelEpoch });
    store.setIdentity({ documentRevision: runtime.documentRevision, kernelEpoch: "kernel-2" });

    assert.equal(store.getRecord(record.id), record);
    assert.deepEqual(Buffer.from(await store.readArtifact(descriptor.handle, 0, bytes.length)), bytes);
    const resource = store.openArtifactResource(descriptor, manifest.entry);
    try {
      assert.deepEqual(Buffer.from(await resource.read(0, bytes.length)), bytes);
    } finally {
      resource.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains owned artifacts across identity changes and rejects stale immutable updates", async () => {
  const { directory, store } = await makeStore();
  try {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const [image] = await store.ingestDisplay(
      { "image/png": bytes.toString("base64") },
      {},
      runtimeIdentity({ cellId: "retained", runId: "run-image" }),
    );
    assert.ok(image);
    const descriptor = artifactHandleSchema.parse(image.data.artifact);

    await store.setIdentity({ documentRevision: 1, kernelEpoch: "kernel-2" });
    assert.equal(store.getRecord(image.id), image);
    assert.deepEqual(Buffer.from(await store.readArtifact(descriptor.handle, 0, bytes.length)), bytes);

    const original = await store.ingestAlder(
      { kind: "text", text: "original", truncated: false },
      runtimeIdentity({ documentRevision: 1, kernelEpoch: "kernel-2", cellId: "versioned", runId: "run-versioned" }),
    );
    const updated = await store.updateRecord(original, {
      kind: "text",
      text: "updated",
      truncated: false,
    });
    assert.equal(updated.id, original.id);
    assert.equal(updated.sequence, original.sequence);
    assert.equal(original.data.text, "original");
    assert.equal(updated.data.text, "updated");
    assert.notEqual(updated.data, original.data);
    assert.equal(Object.isFrozen(updated), true);
    assert.equal(Object.isFrozen(updated.data), true);

    store.discardExact([original]);
    assert.equal(store.getRecord(original.id), updated);
    await assert.rejects(
      store.updateRecord(original, { kind: "text", text: "late", truncated: false }),
      (error: unknown) => error instanceof OutputStoreError && error.code === "stale_value",
    );

    const late = await store.ingestAlder(
      { kind: "text", text: "late response", truncated: false },
      runtimeIdentity({ documentRevision: 1, kernelEpoch: "kernel-2", cellId: "same-owner", runId: "run-late" }),
    );
    const current = await store.ingestAlder(
      { kind: "text", text: "current response", truncated: false },
      runtimeIdentity({ documentRevision: 1, kernelEpoch: "kernel-2", cellId: "same-owner", runId: "run-current" }),
    );
    store.discardExact([late]);
    assert.equal(store.getRecord(current.id), current);
    store.discardExact([current, updated]);
    assert.equal(store.getRecord(current.id), undefined);
    assert.equal(store.getRecord(updated.id), undefined);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public artifact revocation does not revoke an acquired read or publisher pin", async () => {
  const { directory, store } = await makeStore();
  try {
    const bytes = Buffer.from("<p>captured widget</p>");
    const [record] = await store.ingestDisplay({ "text/html": bytes.toString() }, {}, runtimeIdentity());
    const descriptor = artifactHandleSchema.parse(record!.data.artifact);
    const manifest = store.artifactManifest(descriptor);
    assert.throws(() => store.openArtifactResource({ ...descriptor, mimeType: "application/json" }),
      (error: unknown) => error instanceof OutputStoreError && error.code === "stale_value");
    assert.throws(() => store.openArtifactResource(descriptor, "__proto__"),
      (error: unknown) => error instanceof OutputStoreError && error.code === "not_found");
    store.pin([descriptor]);
    const reader = store.openArtifactResource(descriptor, manifest.entry);
    store.discardExact([record!]);
    assert.throws(() => store.openArtifactResource(descriptor),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired");
    assert.deepEqual(Buffer.from(await reader.read(0, bytes.length)), bytes);
    reader.close();
    reader.close();
    assert.deepEqual(Buffer.from(await store.readArtifact(descriptor, 0, bytes.length)), bytes);
    store.unpin([descriptor]);
    await assert.rejects(store.readArtifact(descriptor, 0, bytes.length),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained result leases resist quota eviction and expire without revoking in-flight reads", async (t) => {
  const { directory, store } = await makeStore({ maxArtifactBytes: 8 });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    const bytes = Buffer.from("held");
    const descriptor = await store.writeArtifact(bytes, "text/plain", ".txt", runtimeIdentity());
    store.pin([descriptor]);
    assert.throws(() => store.artifactManifest(descriptor),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired");
    store.unpin([descriptor]);
    store.retainArtifactRead(descriptor, now + 1_000);
    await assert.rejects(store.writeArtifact(Buffer.from("large"), "text/plain", ".txt", runtimeIdentity()),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_quota");
    const reader = store.openArtifactResource(descriptor);
    now += 1_001;
    assert.throws(() => store.openArtifactResource(descriptor),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired");
    assert.deepEqual(Buffer.from(await reader.read(0, bytes.length)), bytes);
    await assert.rejects(store.writeArtifact(Buffer.from("large"), "text/plain", ".txt", runtimeIdentity()),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_quota");
    reader.close();
    await store.writeArtifact(Buffer.from("large"), "text/plain", ".txt", runtimeIdentity());
    await assert.rejects(store.readArtifact(descriptor, 0, bytes.length),
      (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact reads reject symbolic links even when the target matches descriptor size", async () => {
  const { directory, store } = await makeStore();
  try {
    const descriptor = await store.writeArtifact(Buffer.from("public"), "text/plain", ".txt", runtimeIdentity());
    store.retainArtifactRead(descriptor, Date.now() + 60_000);
    const retainedDirectory = join(directory, "artifacts");
    const [retainedName] = await readdir(retainedDirectory);
    const retainedPath = join(retainedDirectory, retainedName!);
    const privatePath = join(directory, "private.txt");
    await writeFile(privatePath, "secret");
    await unlink(retainedPath);
    await symlink(privatePath, retainedPath);
    const reader = store.openArtifactResource(descriptor);
    try {
      await assert.rejects(reader.read(0, 6),
        (error: unknown) => error instanceof OutputStoreError && error.code === "output_expired");
    } finally {
      reader.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
