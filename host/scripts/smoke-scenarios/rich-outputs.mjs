import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanupScenarioResources, createHarness, delay, waitForExecutionReady } from './_common.mjs';
import { prewarmInteractiveBrowser } from "../../test-support/live-browser.mjs";

const TERMINAL = new Set(["done", "error", "failed", "interrupted", "cancelled"]);
const STALE_CODES = new Set(["stale_kernel", "stale_value", "output_expired", "table_unavailable", "lazy_expired", "not_found"]);

export async function run(ctx) {
  const source = `# %%
library(alder)
if (!requireNamespace("ggplot2", quietly = TRUE)) stop("rich smoke requires ggplot2")
if (!requireNamespace("htmlwidgets", quietly = TRUE)) stop("rich smoke requires htmlwidgets")
if (!requireNamespace("jsonlite", quietly = TRUE)) stop("rich smoke requires jsonlite")
# %%
table_value <- data.frame(id = 1:100, parity = ifelse(1:100 %% 2 == 0, "even", "odd"), value = (1:100)^2)
# %%
plot(1:3, type = "b", main = "ALDER_BASE_IMAGE")
# %%
ggplot_value <- ggplot2::ggplot(table_value[1:10, ], ggplot2::aes(id, value)) + ggplot2::geom_point() + ggplot2::ggtitle("ALDER_GGPLOT_IMAGE")
ggplot_value
# %%
third_party_widget <- htmlwidgets::createWidget(name = "alder-third-party-widget", x = list(message = "ALDER_THIRD_PARTY_WIDGET", value = 7), package = "htmlwidgets")
third_party_widget
# %%
control <- ui$slider(0, 10, value = 3, step = 1, label = "ALDER_CONTROL")
control
# %%
run_now <- ui$run_button("ALDER_RUN")
run_now
# %%
control$value + 1
if (isTRUE(run_now$value)) "ALDER_BUTTON_TRIGGERED" else "ALDER_BUTTON_IDLE"
# %%
message("ALDER_MESSAGE")
warning("ALDER_WARNING", call. = FALSE)
json_value <- jsonlite::toJSON(list(kind = "ALDER_JSON", values = c(1, 2, 3)), auto_unbox = TRUE)
out$tabs(
  Table = out$callout(out$vstack(out$md("ALDER_NESTED_MARKDOWN"), table_value), variant = "info"),
  Plot = ggplot_value,
  Widget = third_party_widget,
  Markdown = out$md("# ALDER_MARKDOWN\\n\\n| name | value |\\n| --- | --- |\\n| ALDER_TABLE | 1 |"),
  Html = out$html("<strong>ALDER_HTML_OUTPUT</strong>"),
  Lazy = out$lazy(function() data.frame(lazy = c("ALDER_LAZY", "ready")), label = "ALDER_LAZY_LABEL"),
  JSON = json_value,
  Text = "ALDER_TEXT_VALUE"
)
# %%
out$inspect({ str.alder_rich_truncation <- function(object, ...) cat(strrep("ALDER_TRUNCATE ", 5000)); structure(list(), class = "alder_rich_truncation") })
# %%
Sys.sleep(3)
"ALDER_SLOW_RUN"
`;
  let harness;
  let live;
  try {
    live = await prewarmInteractiveBrowser({ evidence: join(ctx.evidence, "browser"), name: "rich-outputs" });
    harness = await createHarness(ctx, { id: "rich-outputs", source });
    await live.navigate(harness);
    const initial = await waitForExecutionReady(harness);
    const packageNames = ["ggplot2", "htmlwidgets", "jsonlite"];
    const notebookDirectory = harness.canonical.replace(/[\\/][^\\/]+$/, "");
    const ordinaryLibrary = join(notebookDirectory, ".alder", "library");
    const packageMetadata = join(notebookDirectory, ".alder", "packages.yaml");
    const helperDescription = join(ctx.applicationRoot, ctx.manifest.resources.rLibraryDirectory, "alder", "DESCRIPTION");
    const helperDescriptionBefore = await readFile(helperDescription);
    const packageBefore = value(await harness.query({ type: "packages-status" }));
    assert.equal(packageBefore.mode, "pak", JSON.stringify(packageBefore));
    assert.equal(packageBefore.library, null, JSON.stringify(packageBefore));
    await assert.rejects(stat(ordinaryLibrary), { code: "ENOENT" }, "package status must not create the project library");
    const oldSidecarVersion = initial.sidecars?.packages?.version ?? null;
    const declaration = await harness.nextCommand({ type: "packages-declare", packages: packageNames, expectedSidecarVersion: oldSidecarVersion, expectedDocumentRevision: initial.documentRevision });
    const declarationResult = await settle(harness, declaration);
    assert.equal(declarationResult.status, "done", JSON.stringify(declarationResult));
    const declared = await harness.snapshot();
    const declaredOutputs = new Map(declared.cells.filter(cell => cell.type === "code").map(cell => [cell.id, cell.outputs]));
    const expectedPackageText = "packages:\n  - ggplot2\n  - htmlwidgets\n  - jsonlite\n";
    assert.equal(await readFile(packageMetadata, "utf8"), expectedPackageText);
    const declaredStatus = value(await harness.query({ type: "packages-status" }));
    assert.deepEqual(declaredStatus.packages, packageNames);
    assert.equal(declaredStatus.library, null);
    assert.equal(typeof declared.runtime?.kernelEpoch, "string", JSON.stringify(declared.runtime));
    const installReceipt = await harness.nextCommand({ type: "packages-install", packages: packageNames, expectedDocumentRevision: declared.documentRevision, kernelEpoch: declared.runtime.kernelEpoch });
    const installResult = await settle(harness, installReceipt);
    assert.equal(installResult.status, "done", JSON.stringify(installResult));
    const installPayload = installResult.result;
    assert.ok(installPayload && installPayload.result && installPayload.status, JSON.stringify(installResult));
    assert.equal(installPayload.result.status, "installed", JSON.stringify(installPayload));
    assert.equal(installPayload.result.library, ordinaryLibrary, JSON.stringify(installPayload));
    assert.equal(installPayload.status.mode, "pak", JSON.stringify(installPayload));
    assert.equal(installPayload.status.library, ordinaryLibrary, JSON.stringify(installPayload));
    const packageProgress = String(installPayload.result.output ?? "");
    assert.match(packageProgress, /ALDER_PACKAGE_PROGRESS/);
    assert.ok(Buffer.byteLength(packageProgress, "utf8") <= 64 * 1024, "package diagnostics must be byte-bounded");
    const installed = await waitForExecutionReady(harness);
    assert.notEqual(installed.runtime?.kernelEpoch, declared.runtime?.kernelEpoch, "package install must restart the kernel");
    assert.equal(installed.runtime?.busy, false, JSON.stringify(installed.runtime));
    assert.equal(installed.runtime?.activeRunId, null, JSON.stringify(installed.runtime));
    for (const cell of installed.cells.filter(cell => cell.type === "code")) {
      assert.equal(cell.status, "stale", JSON.stringify(cell));
      const previousOutputs = declaredOutputs.get(cell.id);
      assert.ok(previousOutputs, "package restart must retain the preinstall output set");
      assert.deepEqual(cell.outputs, previousOutputs, "package restart retains exact preinstall outputs");
      assert.ok(cell.outputs.every(output => output.kernelEpoch === declared.runtime.kernelEpoch), JSON.stringify(cell.outputs));
      assert.ok(cell.outputs.every(output => output.kernelEpoch !== installed.runtime.kernelEpoch), JSON.stringify(cell.outputs));
    }
    for (const packageName of packageNames) {
      const packageDescription = join(ordinaryLibrary, packageName, "DESCRIPTION");
      const packageDescriptionInfo = await stat(packageDescription);
      assert.ok(packageDescriptionInfo.isFile() && packageDescriptionInfo.size > 0, packageName + " must be installed in the owned project library");
    }
    assert.deepEqual(await readFile(helperDescription), helperDescriptionBefore, "package setup must not mutate the immutable helper library");
    const runReceipt = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: installed.documentRevision });
    const run = await settle(harness, runReceipt);
    assert.equal(run.status, "done", JSON.stringify(run));
    let settled = await harness.snapshot();
    assert.equal(settled.runtime?.executionReady, true, JSON.stringify(settled.runtime));
    assertExecutableCellsSucceeded(settled);
    const rawOutputs = value(await harness.query({ type: "outputs" }));
    const records = outputRecords(rawOutputs, settled);
    const kinds = new Set(records.map(item => item.payload.kind));
    for (const kind of ["layout", "table", "image", "html", "markdown", "lazy", "text", "widget"]) assert.ok(kinds.has(kind), "rich fixture missing typed output " + kind);
    const table = records.find(item => item.payload.kind === "table");
    const lazy = records.find(item => item.payload.kind === "lazy");
    const html = records.find(item => item.payload.kind === "html" && item.payload.artifact?.mimeType === "text/html" && typeof item.payload.artifact.handle === "string");
    const inlineHtml = records.find(item => item.payload.kind === "html" && typeof item.payload.html === "string");
    const control = records.find(item => item.payload.kind === "widget" && item.payload.name === "control");
    const button = records.find(item => item.payload.kind === "widget" && item.payload.name === "run_now");
    assert.ok(table && lazy && html && inlineHtml && control && button, "rich output fixture must expose table, lazy, html, inline HTML, and reactive widgets");
    assert.equal(html.record.metadata.presentation, "sandbox");
    assert.equal(typeof inlineHtml.payload.html, "string");
    assert.equal(table.payload.nrow, 100);
    assert.equal(typeof table.payload.handle, "string");
    assert.doesNotMatch(table.payload.handle, /[\/\\\0]|\.\./);
    assert.equal(table.payload.ncol, 3);
    assert.ok(Array.isArray(table.payload.columns) && Array.isArray(table.payload.preview));
    assert.equal(table.payload.offset, 0);
    assert.equal(table.payload.truncated_columns, false);
    assert.equal(typeof lazy.payload.key, "string");
    assert.doesNotMatch(lazy.payload.key, /[\/\\\0]|\.\./);
    assert.equal(table.payload.truncated_rows, true);
    assert.match(JSON.stringify(records), /ALDER_MESSAGE|ALDER_WARNING|ALDER_JSON/);
    assert.equal(lazy.payload.state, "collapsed");
    const truncated = records.find(item => item.payload.kind === "text" && item.payload.truncated === true);
    assert.ok(truncated, "rich output quota/truncation must be explicit");
    const htmlArtifact = artifactDescriptor(html.payload, settled, "html");
    const htmlBytes = await readArtifact(harness, htmlArtifact);
    const nativeHtmlText = htmlBytes.toString("utf8");
    assert.match(nativeHtmlText, /ALDER_THIRD_PARTY_WIDGET/);
    assert.match(nativeHtmlText, /htmlwidgets/i);
    assert.match(inlineHtml.payload.html, /ALDER_HTML_OUTPUT/);
    const tablePageReceipt = await harness.nextCommand({ type: "table-page", handle: table.payload.handle, offset: 0, limit: 10, sortBy: "id", sortDescending: true, filter: "even", kernelEpoch: kernelEpoch(settled) });
    const tablePage = await settle(harness, tablePageReceipt);
    assert.equal(tablePage.status, "done", JSON.stringify(tablePage));
    assert.equal(tablePage.result?.handle, table.payload.handle);
    assert.ok(Array.isArray(tablePage.result?.page?.preview), JSON.stringify(tablePage));
    const inspectReceipt = await harness.nextCommand({ type: "inspect", name: "table_value", kernelEpoch: kernelEpoch(settled) });
    const inspectResult = await settle(harness, inspectReceipt);
    assert.equal(inspectResult.status, "done", JSON.stringify(inspectResult));
    assert.equal(inspectResult.result?.name, "table_value", JSON.stringify(inspectResult));
    assert.match(JSON.stringify(inspectResult.result?.value), /even/);
    const lazyReceipt = await harness.nextCommand({ type: "lazy-output", key: lazy.payload.key, kernelEpoch: kernelEpoch(settled) });
    const lazyResult = await settle(harness, lazyReceipt);
    assert.equal(lazyResult.status, "done", JSON.stringify(lazyResult));
    assert.match(JSON.stringify(lazyResult.result), /ALDER_LAZY/);
    const widgetReceipt = await harness.nextCommand({ type: "widget", name: "control", path: [], update: { value: 5 }, source: "mcp", kernelEpoch: kernelEpoch(settled), expectedRevision: control.record.revision });
    const widgetResult = await settle(harness, widgetReceipt);
    assert.equal(widgetResult.status, "done", JSON.stringify(widgetResult));
    assert.equal(typeof widgetResult.runId, "string", JSON.stringify(widgetResult));
    settled = await waitForSnapshot(harness, value => value.cells.some(cell => cell.id === control.record.cellId && cell.status === "done"));
    const afterWidget = outputRecords(value(await harness.query({ type: "outputs" })), settled);
    assert.match(JSON.stringify(afterWidget), /ALDER_BUTTON_IDLE/);
    assert.match(JSON.stringify(afterWidget), /(^|[^0-9])6([^0-9]|$)/, "widget update must recompute its downstream value");
    const buttonReceipt = await harness.nextCommand({ type: "widget", name: "run_now", path: [], update: { value: true }, source: "editor", kernelEpoch: kernelEpoch(settled), expectedRevision: button.record.revision });
    const buttonResult = await settle(harness, buttonReceipt);
    assert.equal(buttonResult.status, "done", JSON.stringify(buttonResult));
    assert.ok(Array.isArray(buttonResult.resetOperationIds) && buttonResult.resetOperationIds.length > 0, "run-button update must expose causal reset operation");
    for (const resetId of buttonResult.resetOperationIds) {
      const reset = value(await harness.query({ type: "operation", operationId: resetId }));
      assert.equal(reset.status, "done", JSON.stringify(reset));
      assert.equal(reset.kind, "widget-reset");
    }
    const slowCell = settled.cells.find(cell => cell.body.some(line => line.includes("ALDER_SLOW_RUN")));
    assert.ok(slowCell, "slow execution cell is present");
    const slowReceipt = await harness.nextCommand({ type: "run", scope: "cell", target: { cellId: slowCell.id }, expectedDocumentRevision: settled.documentRevision });
    await waitForSnapshot(harness, value => value.runtime?.busy === true, 5000);
    const cached = await Promise.race([harness.query({ type: "outputs", cellId: table.record.cellId }), delay(1000).then(() => null)]);
    assert.ok(cached, "cached output reads remain responsive during execution");
    const auxiliaryReceipt = await harness.nextCommand({ type: "table-page", handle: table.payload.handle, offset: 0, limit: 5, sortBy: "", sortDescending: false, filter: "", kernelEpoch: kernelEpoch(settled) });
    const auxiliaryLazyReceipt = await harness.nextCommand({ type: "lazy-output", key: lazy.payload.key, kernelEpoch: kernelEpoch(settled) });
    const slowResult = await settle(harness, slowReceipt);
    const auxiliaryResult = await settle(harness, auxiliaryReceipt);
    assert.equal(slowResult.status, "done", JSON.stringify(slowResult));
    assert.equal(auxiliaryResult.status, "done", JSON.stringify(auxiliaryResult));
    const auxiliaryLazyResult = await settle(harness, auxiliaryLazyReceipt);
    assert.equal(auxiliaryLazyResult.status, "done", JSON.stringify(auxiliaryLazyResult));
    const beforeReplacement = await harness.snapshot();
    const owner = beforeReplacement.cells.find(cell => cell.type === "code" && cell.body.some(line => /^\s*table_value\s*<-\s*data\.frame/.test(line)));
    assert.ok(owner, "table definition cell is present for replacement");
    const replacement = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: beforeReplacement.documentRevision, changes: [{ type: "edit", cell: { cellId: owner.id }, expectedRevision: owner.revision, cellType: "code", body: ["table_value <- data.frame(id = 1:2, parity = c('odd', 'even'), value = c(1, 4))"] }] });
    const replacementResult = await settle(harness, replacement);
    assert.equal(replacementResult.status, "done", JSON.stringify(replacementResult));
    const replaced = await harness.snapshot();
    const replacedTableCode = await expectFailure(harness, { type: "table-page", handle: table.payload.handle, offset: 0, limit: 5, sortBy: "", sortDescending: false, filter: "", kernelEpoch: kernelEpoch(replaced) });
    assert.ok(STALE_CODES.has(replacedTableCode), replacedTableCode);
    const restart = await harness.nextCommand({ type: "restart", replay: false, expectedDocumentRevision: replaced.documentRevision });
    const restartResult = await settle(harness, restart);
    assert.equal(restartResult.status, "done", JSON.stringify(restartResult));
    const afterRestart = await waitForExecutionReady(harness);
    const replacedLazyCode = await expectFailure(harness, { type: "lazy-output", key: lazy.payload.key, kernelEpoch: kernelEpoch(afterRestart) });
    assert.ok(STALE_CODES.has(replacedLazyCode), replacedLazyCode);
    const visibleRerun = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: afterRestart.documentRevision });
    const visibleRerunResult = await settle(harness, visibleRerun);
    assert.equal(visibleRerunResult.status, "done", JSON.stringify(visibleRerunResult));
    const visibleOutputCellId = inlineHtml.record.cellId;
    await live.browser.evaluate(`document.querySelector(${JSON.stringify(`[data-cell="${visibleOutputCellId}"]`)})?.scrollIntoView({ block: "center" })`);
    await live.wait(`(document.body.innerText || "").includes("ALDER_MARKDOWN") || (document.body.innerText || "").includes("ALDER_HTML_OUTPUT")`, 30000);
    const visible = await live.observe("rich");
    assert.equal(visible.state.ready, true, JSON.stringify(visible.state));
    assert.match(visible.state.text, /ALDER_GGPLOT_IMAGE|ALDER_HTML_OUTPUT|ALDER_MARKDOWN/);
    const browserProof = await live.browser.evaluate(`(() => { const scope = document.querySelector("#notebook") || document.body; return {
      body: document.body.innerText,
      images: scope.querySelectorAll("img").length,
      widgets: scope.querySelectorAll("[data-role=widget]").length,
      scripts: scope.querySelectorAll("script").length,
    }; })()`);
    assert.match(browserProof.body, /ALDER_MARKDOWN|ALDER_HTML_OUTPUT/);
    assert.ok(browserProof.images > 0, JSON.stringify(browserProof));
    assert.ok(browserProof.widgets > 0, JSON.stringify(browserProof));
    assert.equal(browserProof.scripts, 0, "rich output UI must not interpolate executable inline scripts");
    await live.close();
    live = null;
    return {
      id: "rich-outputs",
      identity: {
        artifact: { manifestSha256: await manifestHash(ctx), notebook: harness.canonical, tableHandle: table.payload.handle, html: htmlArtifact },
        outputs: { kinds: [...kinds], records: records.length, tableRows: table.payload.nrow, lazy: lazy.payload.key, browser: "live-cdp" },
        reactivity: { widget: widgetResult.runId, resetOperationIds: buttonResult.resetOperationIds, replacement: replacedTableCode, restart: replacedLazyCode },
        runtime: { epoch: afterRestart.epoch, kernelEpoch: kernelEpoch(afterRestart) },
      },
    };
  } finally {
    await cleanupScenarioResources(() => live?.close(), () => harness?.close());
  }
}

function value(result) {
  assert.ok(result && typeof result === "object" && Object.hasOwn(result, "result"), "query must return canonical envelope");
  assert.deepEqual(Object.keys(result).sort(), ["cursor", "documentRevision", "epoch", "result"].sort());
  return result.result;
}
function assertExecutableCellsSucceeded(snap) {
  const diagnostics = (snap?.cells ?? []).filter(cell => cell?.type === "code" && cell.options?.disabled !== true).map(cell => ({ id: cell.id, status: cell.status, error: cell.error, log: cell.log }));
  assert.ok(diagnostics.length > 0, "rich fixture must expose enabled executable cells");
  for (const diagnostic of diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ["error", "id", "log", "status"]);
    assert.equal(typeof diagnostic.id, "string");
    assert.equal(typeof diagnostic.status, "string");
    assert.ok(Array.isArray(diagnostic.log));
    assert.equal(diagnostic.status, "done", "rich executable cell failed: " + JSON.stringify(diagnostic));
    assert.equal(diagnostic.error, null, "rich executable cell reported an error: " + JSON.stringify(diagnostic));
  }
}
function boundedOutputShape(raw) {
  if (!Array.isArray(raw)) return { type: raw === null ? "null" : typeof raw, array: false };
  const records = raw.slice(0, 8).map(record => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return { type: record === null ? "null" : typeof record };
    return {
      keys: Object.keys(record).sort().slice(0, 16).map(key => key.slice(0, 128)),
      id: typeof record.id === "string" ? record.id : null,
      cellId: typeof record.cellId === "string" ? record.cellId : null,
      dataKind: typeof record.data?.kind === "string" ? record.data.kind : null,
      presentation: typeof record.metadata?.presentation === "string" ? record.metadata.presentation : null,
    };
  });
  return { type: "array", count: raw.length, records, truncated: raw.length > records.length };
}
function kernelEpoch(snap) { assert.equal(typeof snap.runtime?.kernelEpoch, "string", "rich operations require an active kernel epoch"); return snap.runtime.kernelEpoch; }
function outputRecords(raw, snap) {
  assert.ok(Array.isArray(raw) && raw.length > 0, "outputs query must return canonical output records: " + JSON.stringify(boundedOutputShape(raw)));
  const result = [];
  const visit = (payload, record) => {
    if (!payload || typeof payload !== "object") return;
    if (typeof payload.kind === "string") result.push({ record, payload });
    if (payload.kind === "layout" && Array.isArray(payload.children)) payload.children.forEach(child => visit(child, record));
    if (payload.kind === "lazy" && payload.child) visit(payload.child, record);
  };
  for (const record of raw) {
    assert.equal(typeof record.id, "string");
    assert.deepEqual(Object.keys(record).sort(), ["cellId", "data", "id", "kernelEpoch", "metadata", "revision", "runId", "sequence", "sessionEpoch", "truncated"].sort());
    assert.equal(typeof record.sessionEpoch, "string");
    assert.equal(record.sessionEpoch, snap.epoch);
    const staticMarkdown = snap.cells?.find(cell => cell.id === record.cellId)?.type === "markdown" && record.data?.kind === "markdown" && record.kernelEpoch === null && record.runId === null;
    if (staticMarkdown) {
      assert.equal(record.kernelEpoch, null);
      assert.equal(record.runId, null);
    } else {
      assert.equal(typeof record.kernelEpoch, "string");
      assert.equal(record.kernelEpoch, snap.runtime?.kernelEpoch);
      assert.equal(typeof record.runId, "string");
    }
    assert.equal(typeof record.cellId, "string");
    assert.equal(typeof record.revision, "number");
    assert.equal(typeof record.sequence, "number");
    assert.equal(typeof record.truncated, "boolean");
    assert.ok(record.metadata && ["inline", "sandbox"].includes(record.metadata.presentation));
    assert.ok(record.data && typeof record.data === "object");
    visit(record.data, record);
  }
  assert.ok(result.length > 0, "output records must contain typed payloads: " + JSON.stringify(boundedOutputShape(raw)));
  return result;
}
function artifactDescriptor(payload, snap, label) {
  const artifact = payload.artifact;
  assert.ok(artifact && typeof artifact === "object", label + " must expose canonical ArtifactHandle");
  assert.deepEqual(Object.keys(artifact).sort(), ["byteLength", "chunkBytes", "documentRevision", "epoch", "handle", "kernelEpoch", "mimeType"].sort());
  assert.equal(typeof artifact.handle, "string");
  assert.doesNotMatch(artifact.handle, /[\/\\\0]|\.\./);
  assert.equal(typeof artifact.mimeType, "string");
  assert.equal(artifact.mimeType, "text/html");
  assert.ok(Number.isSafeInteger(artifact.byteLength) && artifact.byteLength > 0);
  assert.equal(artifact.chunkBytes, 262144);
  assert.equal(artifact.epoch, snap.epoch);
  assert.equal(artifact.documentRevision, snap.documentRevision);
  assert.equal(typeof snap.runtime?.kernelEpoch, "string");
  assert.equal(artifact.kernelEpoch, snap.runtime.kernelEpoch);
  return artifact;
}
async function readArtifact(harness, artifact) {
  const chunks = [];
  let offset = 0;
  while (offset < artifact.byteLength) {
    const page = value(await harness.query({ type: "output", handle: artifact.handle, offset, limit: Math.min(artifact.chunkBytes, artifact.byteLength - offset) }));
    assert.ok(page && (page.encoding === "base64" || page.encoding === "utf8"));
    assert.equal(page.offset, offset);
    assert.ok(Number.isSafeInteger(page.nextOffset) && page.nextOffset > offset && page.nextOffset <= artifact.byteLength);
    const bytes = Buffer.from(page.data, page.encoding === "base64" ? "base64" : "utf8");
    assert.equal(bytes.byteLength, page.nextOffset - offset);
    chunks.push(bytes);
    offset = page.nextOffset;
    if (page.eof) assert.equal(offset, artifact.byteLength);
  }
  return Buffer.concat(chunks);
}
async function settle(harness, receipt) {
  const operationId = receipt?.operationId;
  assert.equal(typeof operationId, "string", JSON.stringify(receipt));
  const deadline = Date.now() + 120000;
  for (;;) {
    const operation = value(await harness.query({ type: "operation", operationId }));
    if (operation && TERMINAL.has(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error("operation_timeout: " + operationId);
    await delay(100);
  }
}
async function expectFailure(harness, command) {
  try {
    const receipt = await harness.nextCommand(command);
    const direct = receipt?.error?.code;
    if (direct) return direct;
    const operation = await settle(harness, receipt);
    assert.equal(operation.status, "error", JSON.stringify(operation));
    const code = operation.error?.code;
    assert.equal(typeof code, "string", JSON.stringify(operation));
    return code;
  } catch (error) {
    const code = error?.code;
    assert.equal(typeof code, "string", String(error));
    return code;
  }
}
async function waitForSnapshot(harness, predicate, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await harness.snapshot();
    if (predicate(current)) return current;
    if (Date.now() >= deadline) throw new Error("snapshot_wait_timeout");
    await delay(100);
  }
}
async function manifestHash(ctx) {
  const resources = dirname(ctx.manifest.resources.rLibraryDirectory);
  return createHash("sha256").update(await readFile(join(ctx.applicationRoot, resources, "manifest.json"))).digest("hex");
}
