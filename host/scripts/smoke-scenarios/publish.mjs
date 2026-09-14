import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "parse5";
import { cleanupScenarioResources, createHarness, delay, fetchLogicalOrigin, waitForExecutionReady } from './_common.mjs';
import { prewarmInteractiveBrowser } from "../../test-support/live-browser.mjs";

const TERMINAL = new Set(["done", "error", "failed", "interrupted", "cancelled"]);

export async function run(ctx) {
  const fixtureDirectory = join(ctx.evidence, "fixtures", "publish");
  const counterPath = join(fixtureDirectory, "publish-counter.txt");
  const hookMarker = join(ctx.evidence, "publish-hook-ran.txt");
  const hookScriptName = process.platform === "win32" ? "publish-hook.cmd" : "publish-hook.sh";
  const hookScriptPath = join(fixtureDirectory, hookScriptName);
  const includeSecretPath = join(fixtureDirectory, "include-secret.txt");
  const widgetScriptPath = join(fixtureDirectory, "alder-publish-widget.js");
  const pdfFixturePath = join(fixtureDirectory, "publish-paper.pdf");
  const widgetScript = [
    "(function () {",
    "  HTMLWidgets.widget({",
    "    name: 'alder-publish-widget',",
    "    type: 'output',",
    "    factory: function (element) {",
    "      return {",
    "        renderValue: function (value) {",
    "          element.textContent = value.message + ':' + value.value;",
    "          window.parent.postMessage({ source: 'alder-publish-fixture', marker: value.message, functional: element.textContent }, '*');",
    "        }",
    "      };",
    "    }",
    "  });",
    "}());",
  ].join("\n");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(counterPath, "0\n");
  await writeFile(widgetScriptPath, widgetScript, "utf8");
  await writeFile(includeSecretPath, "SENTINEL_SECRET_PUBLISH_INCLUDE\n");
  const rCounter = JSON.stringify(counterPath);
  const rIncludeSecretPath = JSON.stringify(includeSecretPath);
  const rWidgetDirectory = JSON.stringify(fixtureDirectory);
  const rPdfPath = JSON.stringify(pdfFixturePath);
  const literalComplete = "{{< include " + includeSecretPath + " >}}";
  const literalTriple = "{{{< include " + includeSecretPath + " >}}}";
  const literalMalformed = "{{< include " + includeSecretPath + " >";
  const literalNested = "{{< include {{< meta title >}} >}}";
  const literalPercent = "{{% include " + includeSecretPath + " %}}";
  // CommonMark consumes one backslash, so the R fixture emits two for one visible literal.
  const literalEscaped = "\\" + literalComplete;
  const source = `# %%
library(alder)
if (!requireNamespace("htmlwidgets", quietly = TRUE)) stop("publish requires htmlwidgets")
if (!requireNamespace("htmltools", quietly = TRUE)) stop("publish requires htmltools")
# %%
publish_control <- ui$slider(0, 10, value = 4, step = 1, label = "ALDER_PUBLISH_CONTROL")
publish_control
# %%
marker <- ${rCounter}
count <- as.integer(readLines(marker, warn = FALSE)) + 1L
# literal shortcode: {{< include ${rIncludeSecretPath} >}}
writeLines(as.character(count), marker)
# %%
widget_dependency <- htmltools::htmlDependency(name = "alder-publish-widget", version = "1.0.0", src = c(file = ${rWidgetDirectory}), script = "alder-publish-widget.js")
widget <- htmlwidgets::createWidget(name = "alder-publish-widget", x = list(message = "ALDER_PUBLISH_WIDGET", value = 7), package = "alder", dependencies = list(widget_dependency))
pdf_path <- ${rPdfPath}
local({
  grDevices::pdf(pdf_path, width = 4, height = 4)
  on.exit(grDevices::dev.off())
  graphics::plot.new()
  graphics::text(0.5, 0.5, "ALDER_PUBLISH_PDF")
})
literal_complete <- paste0("{{< include ", ${rIncludeSecretPath}, " >}}")
literal_triple <- paste0("{{{< include ", ${rIncludeSecretPath}, " >}}}")
literal_malformed <- paste0("{{< include ", ${rIncludeSecretPath}, " >")
literal_nested <- "{{< include {{< meta title >}} >}}"
literal_percent <- paste0("{{% include ", ${rIncludeSecretPath}, " %}}")
literal_escaped <- paste0(intToUtf8(c(92, 92)), literal_complete)
out$tabs(Widget = widget, PDF = out$pdf(pdf_path, alt = "ALDER_PUBLISH_PDF"), Lazy = out$lazy(function() "ALDER_PUBLISH_LAZY", label = "ALDER_LAZY_PLACEHOLDER"), Text = out$md(paste0(
  "**ALDER_PUBLISH_TEXT** ", literal_complete,
  " triple ", literal_triple,
  " malformed ", literal_malformed,
  " nested ", literal_nested,
  " percent ", literal_percent,
  " escaped ", literal_escaped
)))
# %%
Sys.sleep(1)
count
`;
  let harness;
  let live;
  try {
    live = await prewarmInteractiveBrowser({ evidence: join(ctx.evidence, "browser"), name: "publish" });
    harness = await createHarness(ctx, { id: "publish", source });
    await live.navigate(harness);
    const hookScript = process.platform === "win32"
      ? '@echo off\r\necho ALDER_HOOK_RAN > "' + hookMarker.replaceAll('"', '""') + '"\r\n'
      : "#!/bin/sh\nprintf ALDER_HOOK_RAN > " + shellQuote(hookMarker) + "\n";
    await writeFile(hookScriptPath, hookScript, { encoding: "utf8", mode: 0o755 });
    await chmod(hookScriptPath, 0o755);
    await writeFile(join(fixtureDirectory, "_quarto.yml"), "project:\n  type: default\n  pre-render: " + JSON.stringify("./" + hookScriptName) + "\nformat:\n  html:\n    toc: false\n");
    const quarto = "quarto";
    const quartoVersion = spawnSync(quarto, ["--version"], { encoding: "utf8", timeout: 30000 });
    assert.equal(quartoVersion.status, 0, "installed Quarto is required for publish smoke: " + (quartoVersion.stderr ?? ""));
    const initial = await waitForExecutionReady(harness);
    const notebookDirectory = harness.canonical.replace(/[\\/][^\\/]+$/, "");
    const ordinaryLibrary = join(notebookDirectory, ".alder", "library");
    const helperDescription = join(ctx.applicationRoot, ctx.manifest.resources.rLibraryDirectory, "alder", "DESCRIPTION");
    const helperDescriptionBefore = await fileHash(helperDescription);
    const packageBefore = value(await harness.query({ type: "packages-status" }));
    assert.equal(packageBefore.mode, "pak", JSON.stringify(packageBefore));
    assert.equal(packageBefore.library, null, JSON.stringify(packageBefore));
    await assert.rejects(stat(ordinaryLibrary), { code: "ENOENT" }, "package status must not create the project library");
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0", "startup must not evaluate source before package setup");
    const oldSidecarVersion = initial.sidecars?.packages?.version ?? null;
    const declaration = await harness.nextCommand({ type: "packages-declare", packages: ["htmlwidgets"], expectedSidecarVersion: oldSidecarVersion, expectedDocumentRevision: initial.documentRevision });
    const declarationResult = await settle(harness, declaration);
    assert.equal(declarationResult.status, "done", JSON.stringify(declarationResult));
    const declared = await harness.snapshot();
    const declaredOutputs = new Map(declared.cells.filter(cell => cell.type === "code").map(cell => [cell.id, cell.outputs]));
    const packageMetadata = join(notebookDirectory, ".alder", "packages.yaml");
    assert.equal(await readFile(packageMetadata, "utf8"), "packages:\n  - htmlwidgets\n");
    const declaredStatus = value(await harness.query({ type: "packages-status" }));
    assert.deepEqual(declaredStatus.packages, ["htmlwidgets"]);
    assert.equal(declaredStatus.library, null);
    assert.equal(typeof declared.runtime?.kernelEpoch, "string", JSON.stringify(declared.runtime));
    const installReceipt = await harness.nextCommand({ type: "packages-install", packages: ["htmlwidgets"], expectedDocumentRevision: declared.documentRevision, kernelEpoch: declared.runtime.kernelEpoch });
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
      assert.ok(cell.outputs.every(output => output.kernelEpoch === declared.runtime?.kernelEpoch), JSON.stringify(cell.outputs));
      assert.ok(cell.outputs.every(output => output.kernelEpoch !== installed.runtime?.kernelEpoch), JSON.stringify(cell.outputs));
    }
    const packageDescription = join(ordinaryLibrary, "htmlwidgets", "DESCRIPTION");
    const packageDescriptionInfo = await stat(packageDescription);
    assert.ok(packageDescriptionInfo.isFile() && packageDescriptionInfo.size > 0, "htmlwidgets must be installed in the owned project library");
    const helperDescriptionAfter = await fileHash(helperDescription);
    assert.equal(helperDescriptionAfter, helperDescriptionBefore, "optional package install must not mutate the immutable helper library");
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0", "package setup must not evaluate notebook source");
    const dependencySetup = {
      package: "htmlwidgets",
      declaration: declarationResult.status,
      declaredSidecarVersion: declared.sidecars?.packages?.version ?? null,
      install: installResult.status,
      installPayload: installPayload.result.status,
      progressBytes: Buffer.byteLength(packageProgress, "utf8"),
      library: ordinaryLibrary,
      packageMetadata,
      packageMetadataSha256: await fileHash(packageMetadata),
      kernelEpochBefore: declared.runtime.kernelEpoch,
      kernelEpochAfter: installed.runtime.kernelEpoch,
      packageDescription,
      packageDescriptionBytes: packageDescriptionInfo.size,
      packageDescriptionSha256: await fileHash(packageDescription),
      helperDescription,
      helperDescriptionBefore,
      helperDescriptionAfter,
    };
    const runReceipt = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: installed.documentRevision });
    const runResult = await settle(harness, runReceipt);
    assert.equal(runResult.status, "done", JSON.stringify(runResult));
    const runSnapshot = await harness.snapshot();
    assertExecutableCellsSucceeded(runSnapshot);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "1", "source runs exactly once before publish");
    const settled = await harness.snapshot();
    const records = outputRecords(value(await harness.query({ type: "outputs" })), settled);
    const htmlOutput = records.find(item => item.payload.kind === "html");
    assert.ok(Array.isArray(settled.capabilities) && settled.capabilities.includes("mimePublisher:alder-json-v1"), JSON.stringify(settled.capabilities));
    assert.ok(htmlOutput, "publish fixture produces an htmlwidget artifact");
    const artifact = artifactDescriptor(htmlOutput.payload, settled);
    assert.equal(htmlOutput.record.metadata.presentation, "sandbox");
    const artifactBytes = await readArtifact(harness, artifact);
    assert.match(artifactBytes.toString("utf8"), /ALDER_PUBLISH_WIDGET/);
    const outputPath = join(ctx.evidence, "published", "alder-publish.html");
    const downloadDirectory = join(ctx.evidence, "published");
    const downloadPath = join(downloadDirectory, "notebook.html");
    await mkdir(downloadDirectory, { recursive: true });
    const explicitReceipt = await harness.nextCommand({ type: "publish", includeCode: true, outputPath, expectedDocumentRevision: settled.documentRevision });
    const explicitPublished = await settle(harness, explicitReceipt);
    assert.equal(explicitPublished.status, "done", JSON.stringify(explicitPublished));
    assert.deepEqual(explicitPublished.result, { path: outputPath, documentRevision: settled.documentRevision });
    assert.match(await readFile(outputPath, "utf8"), /ALDER_PUBLISH_TEXT/);

    await live.browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDirectory }, "");
    const previousOperations = new Set((await harness.snapshot()).operations.map(operation => operation.id));
    await live.click(".service-menu > button");
    await live.wait("Boolean(document.querySelector('.publish-include-code input'))", 5000);
    if (!await live.browser.evaluate("document.querySelector('.publish-include-code input').checked")) {
      await live.click(".publish-include-code input");
    }
    await live.click(".service-menu-panel button");
    const admitted = await waitForSnapshot(harness, snapshot => snapshot.operations.some(operation => operation.kind === "publish" && !previousOperations.has(operation.id)));
    const browserPublication = admitted.operations.find(operation => operation.kind === "publish" && !previousOperations.has(operation.id));
    const published = await live.browser.evaluate(`window.__alderHost.client.awaitOperation(${JSON.stringify(browserPublication.id)})`);
    assert.equal(published.status, "done", JSON.stringify(published));
    const publication = harness.wire.artifactHandleSchema.parse(published.result);
    assert.equal(publication.epoch, settled.epoch);
    assert.equal(publication.documentRevision, settled.documentRevision);
    assert.equal(publication.kernelEpoch, null);
    const downloadDeadline = Date.now() + 60_000;
    while (!await exists(downloadPath)) {
      if (Date.now() >= downloadDeadline) throw new Error("browser publish download was not written");
      await delay(100);
    }
    const outputBytes = await readFile(downloadPath);
    assert.deepEqual(outputBytes, await readArtifact(harness, publication), "browser download must equal the canonical published artifact");
    const resolvedUrl = await live.browser.evaluate("window.__alderHost.client.resolveArtifact(" + JSON.stringify(publication) + ")");
    const publishedUrl = new URL(resolvedUrl, harness.origin);
    assert.equal(publishedUrl.origin, harness.origin);
    assert.match(publishedUrl.pathname, /^\/artifacts\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(publishedUrl.search, "");
    assert.equal(publishedUrl.hash, "");
    const downloadedBytes = await fetchPublishedArtifact(publishedUrl);
    assert.deepEqual(downloadedBytes, outputBytes, "capability-only retrieval must equal the browser-downloaded bytes");
    const adjacentUrl = new URL(publishedUrl);
    adjacentUrl.pathname = publishedUrl.pathname.replace(/\/[^/]*$/, "/include-secret.txt");
    const adjacentResponse = await fetchLogicalOrigin(adjacentUrl, { method: "GET", redirect: "error", credentials: "omit", headers: { Origin: "null" } });
    assert.equal(adjacentResponse.status, 404, "artifact capability must not expose adjacent fixture/project files");
    await adjacentResponse.arrayBuffer();
    await live.observe("published-download");
    const afterPublish = await harness.snapshot();
    assert.equal(afterPublish.documentRevision, settled.documentRevision, "publish must not mutate the document revision");
    const cellState = cells => cells.map(cell => ({ id: cell.id, revision: cell.revision, body: [...cell.body], outputs: cell.outputs }));
    assert.deepEqual(cellState(afterPublish.cells), cellState(settled.cells), "publish must not mutate canonical source or output records");
    const outputText = outputBytes.toString("utf8");
    assert.ok(outputBytes.length > 0);
    assert.match(outputText, /ALDER_PUBLISH_TEXT/);
    assert.match(outputText, /ALDER_LAZY_PLACEHOLDER/, "lazy output is a visible placeholder");
    assert.doesNotMatch(outputText, /```\{r\b|<script[^>]*src=["'][^"']*(?:file:|\.js)/i, "published HTML contains no executable R chunks or external scripts");
    assert.doesNotMatch(outputText, /SENTINEL_SECRET_PUBLISH_INCLUDE/, "Quarto shortcodes must remain inert");
    assert.match(outputText, /include-secret\.txt/, "literal shortcode source remains visible");
    assert.ok(outputText.includes("{{&lt; include " + includeSecretPath + " &gt;}}"), "complete literal survives in HTML bytes");
    assert.ok(outputText.includes("malformed {{&lt; include " + includeSecretPath + " &gt;"), "malformed literal survives in HTML bytes");
    const publishedMarkup = inspectPublishedMarkup(outputText);
    const references = publishedMarkup.resources.filter(ref => !isEmbeddedResource(ref));
    assert.deepEqual(references, [], "published HTML must be self-contained: " + references.join(", "));
    const cssReferences = publishedMarkup.styles.flatMap(css => [...css.matchAll(/url\(\s*["']?([^)'"]+)["']?\s*\)/gi)].map(match => match[1] ?? "").filter(ref => !isEmbeddedResource(ref)));
    assert.deepEqual(cssReferences, [], "published CSS must not reference external assets: " + cssReferences.join(", "));
    assert.equal((await readFile(counterPath, "utf8")).trim(), "1", "publish never evaluates notebook source");
    assert.equal(await exists(hookMarker), false, "publish does not inherit hostile project Quarto hooks");
    await live.close();
    live = await prewarmInteractiveBrowser({ evidence: join(ctx.evidence, "browser"), name: "publish-offline" });
    await live.browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__alderPublishMessages = [];
        window.addEventListener("message", event => {
          if (event.data && event.data.source === "alder-publish-fixture") {
            window.__alderPublishMessages.push({ origin: event.origin, data: event.data });
          }
        });
      })();`,
    });
    await live.browser.send("Network.enable");
    await live.browser.send("Network.setCacheDisabled", { cacheDisabled: true });
    await live.browser.send("Page.navigate", { url: pathToFileURL(downloadPath).href });
    await live.wait("document.readyState === 'complete' && (document.body.innerText || '').includes('ALDER_PUBLISH_TEXT')", 60000);
    const networkProbe = "fetch(" + JSON.stringify(harness.origin + "/api/identity") + ", { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false)";
    assert.equal(await live.browser.evaluate(networkProbe), true, "offline proof requires a reachable network control");
    await live.browser.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await live.browser.evaluate("window.__alderPublishBeforeReload = true");
    await live.browser.send("Page.reload", { ignoreCache: true });
    await live.wait("window.__alderPublishBeforeReload !== true && document.readyState === 'complete' && (document.body.innerText || '').includes('ALDER_PUBLISH_TEXT')", 60000);
    await live.wait("Array.isArray(window.__alderPublishMessages) && window.__alderPublishMessages.some(message => message.data && message.data.source === 'alder-publish-fixture' && message.data.marker === 'ALDER_PUBLISH_WIDGET')", 60000);
    const offlineProof = await live.browser.evaluate(`(() => {
      const frames = [...document.querySelectorAll("iframe")];
      const scripts = [...document.querySelectorAll("script[src]")].map(script => script.getAttribute("src")).filter(src => src !== null && !/^(?:data:|#)/i.test(src));
      const body = document.body.innerText || "";
      const widgetControls = [...document.querySelectorAll(".widget-container input")].map(input => ({ disabled: input.disabled, value: input.value, checked: input.checked }));
      return {
        url: location.href,
        online: navigator.onLine,
        body,
        lazy: body.includes("ALDER_LAZY_PLACEHOLDER"),
        frames: frames.map(frame => ({kind: frame.getAttribute("data-alder-artifact-frame"), sandbox: frame.getAttribute("sandbox"), srcdoc: frame.getAttribute("srcdoc") || "", src: frame.getAttribute("src") || ""})),
        messages: window.__alderPublishMessages ?? [],
        scripts,
        widgetControls,
      };
    })()`);
    // Chromium file documents can report onLine=true even while requests fail with ERR_INTERNET_DISCONNECTED.
    offlineProof.networkBlocked = !(await live.browser.evaluate(networkProbe));
    assert.equal(offlineProof.networkBlocked, true, "offline Chromium must block the previously reachable network control");
    assert.match(offlineProof.body, /ALDER_PUBLISH_TEXT/);
    assert.ok(offlineProof.body.includes("{{< include " + includeSecretPath + " >}}"), JSON.stringify(offlineProof));
    assert.ok(offlineProof.body.includes("triple " + literalTriple), JSON.stringify(offlineProof));
    assert.ok(offlineProof.body.includes("malformed {{< include " + includeSecretPath + " >"), JSON.stringify(offlineProof));
    assert.ok(offlineProof.body.includes("nested {{< include {{< meta title >}} >}}"), JSON.stringify(offlineProof));
    assert.ok(offlineProof.body.includes("percent {{% include " + includeSecretPath + " %}}"), JSON.stringify(offlineProof));
    assert.ok(offlineProof.body.includes("escaped " + literalEscaped), JSON.stringify(offlineProof));
    assert.doesNotMatch(offlineProof.body, /SENTINEL_SECRET_PUBLISH_INCLUDE/);
    assert.equal(offlineProof.scripts.length, 0, JSON.stringify(offlineProof));
    assert.ok(offlineProof.lazy, JSON.stringify(offlineProof));
    assert.ok(offlineProof.frames.length > 0, "published widget remains an embedded sandbox");
    assert.ok(offlineProof.widgetControls.length > 0, JSON.stringify(offlineProof));
    assert.ok(offlineProof.widgetControls.every(control => control.disabled && control.value === "4"), JSON.stringify(offlineProof));
    assert.match(offlineProof.body, /Published snapshot \(noninteractive\)\./);
    const widgetMessage = offlineProof.messages.find(message => message.data?.marker === "ALDER_PUBLISH_WIDGET");
    assert.ok(widgetMessage, JSON.stringify(offlineProof.messages));
    assert.equal(widgetMessage.origin, "null", JSON.stringify(widgetMessage));
    assert.equal(widgetMessage.data.functional, "ALDER_PUBLISH_WIDGET:7", JSON.stringify(widgetMessage));
    const htmlFrames = offlineProof.frames.filter(frame => frame.kind === "html");
    assert.equal(htmlFrames.length, 1, "the captured HTML widget remains an isolated document");
    for (const frame of htmlFrames) {
      assert.equal(frame.sandbox, "allow-scripts");
      assert.match(frame.srcdoc, /ALDER_PUBLISH_WIDGET/);
    }
    const pdfFrames = offlineProof.frames.filter(frame => frame.kind === "pdf");
    assert.equal(pdfFrames.length, 1, "the captured PDF remains an embedded native-viewer document");
    assert.equal(pdfFrames[0].sandbox, null, "PDF plugin loading must not be disabled by sandbox flags");
    assert.equal(pdfFrames[0].srcdoc, "");
    assert.match(pdfFrames[0].src, /^data:application\/pdf;base64,/);
    assert.deepEqual(Buffer.from(pdfFrames[0].src.slice("data:application/pdf;base64,".length), "base64"), await readFile(pdfFixturePath), "offline PDF bytes must equal the captured R-produced document");
    await live.observe("offline-artifacts");
    await live.close();
    live = null;
    const occupied = join(ctx.evidence, "published", "occupied.html");
    await writeFile(occupied, "OCCUPIED_DESTINATION\n");
    const occupiedResult = await expectFailure(harness, { type: "publish", includeCode: false, outputPath: occupied, expectedDocumentRevision: settled.documentRevision });
    assert.equal(occupiedResult.code, "destination_exists", JSON.stringify(occupiedResult));
    assert.equal(await readFile(occupied, "utf8"), "OCCUPIED_DESTINATION\n");
    const racePath = join(ctx.evidence, "published", "racing.html");
    const raceReceipts = await Promise.all([
      harness.nextCommand({ type: "publish", includeCode: false, outputPath: racePath, expectedDocumentRevision: settled.documentRevision }),
      harness.nextCommand({ type: "publish", includeCode: false, outputPath: racePath, expectedDocumentRevision: settled.documentRevision }),
    ]);
    const raceResults = await Promise.all(raceReceipts.map(receipt => settleOrError(harness, receipt)));
    assert.equal(raceResults.filter(result => result.status === "done").length, 1, JSON.stringify(raceResults));
    assert.equal(raceResults.filter(result => result.code === "operation_in_progress").length, 1, JSON.stringify(raceResults));
    assert.ok((await readFile(racePath)).length > 0);
    const activeSnapshot = await harness.snapshot();
    const activeRun = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: activeSnapshot.documentRevision });
    await waitForSnapshot(harness, value => value.runtime?.busy === true, 5000);
    const activePublish = await expectFailure(harness, { type: "publish", includeCode: false, outputPath: join(ctx.evidence, "published", "busy.html"), expectedDocumentRevision: activeSnapshot.documentRevision });
    assert.equal(activePublish.code, "run_in_progress", JSON.stringify(activePublish));
    const activeTerminal = await settle(harness, activeRun);
    assert.equal(activeTerminal.status, "done", JSON.stringify(activeTerminal));
    const afterActiveCount = (await readFile(counterPath, "utf8")).trim();
    assert.equal(afterActiveCount, "2");
    const fresh = await harness.snapshot();
    const outputCell = fresh.cells.find(candidate => candidate.type === "code" && candidate.body.some(line => line.includes("ALDER_PUBLISH_TEXT")));
    assert.ok(outputCell);
    const edit = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: fresh.documentRevision, changes: [{ type: "edit", cell: { cellId: outputCell.id }, expectedRevision: outputCell.revision, cellType: "code", body: [...outputCell.body, "# ALDER_STALE_SOURCE"] }] });
    assert.equal((await settle(harness, edit)).status, "done");
    const stale = await expectFailure(harness, { type: "publish", includeCode: false, outputPath: join(ctx.evidence, "published", "stale.html"), expectedDocumentRevision: (await harness.snapshot()).documentRevision });
    assert.equal(stale.code, "publish_not_ready", JSON.stringify(stale));
    const staleFixed = await harness.snapshot();
    const staleCell = staleFixed.cells.find(cell => cell.id === outputCell.id);
    const errorEdit = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: staleFixed.documentRevision, changes: [{ type: "edit", cell: { cellId: staleCell.id }, expectedRevision: staleCell.revision, cellType: "code", body: [...staleCell.body, "stop(\"ALDER_PUBLISH_ERROR\")"] }] });
    assert.equal((await settle(harness, errorEdit)).status, "done");
    const errorSnapshot = await harness.snapshot();
    const errorRun = await harness.nextCommand({ type: "run", scope: "cell", target: { cellId: staleCell.id }, expectedDocumentRevision: errorSnapshot.documentRevision });
    const errorResult = await settle(harness, errorRun);
    assert.equal(errorResult.status, "error", JSON.stringify(errorResult));
    const errorPublish = await expectFailure(harness, { type: "publish", includeCode: false, outputPath: join(ctx.evidence, "published", "error.html"), expectedDocumentRevision: (await harness.snapshot()).documentRevision });
    assert.equal(errorPublish.code, "publish_not_ready", JSON.stringify(errorPublish));
    const missingPath = join(ctx.evidence, "published", "missing-quarto.html");
    const pathWithoutQuarto = await withoutQuarto(process.env.PATH ?? "");
    const previousPath = process.env.PATH;
    let missingHarness;
    try {
      process.env.PATH = pathWithoutQuarto;
      missingHarness = await createHarness(ctx, { id: "publish-missing-quarto", source: '# %%\n"ALDER_MISSING_QUARTO"\n', rscript: harness.selectedR });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    try {
      const missingInitial = await waitForExecutionReady(missingHarness);
      const missingRun = await missingHarness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: missingInitial.documentRevision });
      const missingRunTerminal = await settle(missingHarness, missingRun);
      assert.equal(missingRunTerminal.status, "done", JSON.stringify(missingRunTerminal));
      const missingSettled = await missingHarness.snapshot();
      const missingPublish = await expectFailure(missingHarness, { type: "publish", includeCode: false, outputPath: missingPath, expectedDocumentRevision: missingSettled.documentRevision });
      assert.equal(missingPublish.code, "tool_not_found", JSON.stringify(missingPublish));
      assert.equal(await exists(missingPath), false);
    } finally {
      if (missingHarness) await missingHarness.close();
    }
    return {
      id: "publish",
      identity: {
        dependencySetup,
        artifact: { manifestSha256: await manifestHash(ctx.applicationRoot), explicitPublishedPath: outputPath, downloadedPath: downloadPath, publication, publishedSha256: sha256(outputBytes), downloadedSha256: sha256(downloadedBytes), capturedWidgetSha256: sha256(artifactBytes), documentRevision: settled.documentRevision, handle: artifact },
        quarto: { executable: quarto, version: quartoVersion.stdout.trim(), versionSha256: sha256(Buffer.from(quartoVersion.stdout)), offlineChrome: "live-cdp" },
        safety: { sourceCounterBeforePublish: "1", sourceCounterAfterActive: afterActiveCount, hookRan: false, externalReferences: references, cssReferences, overwrite: occupiedResult.code, race: raceResults.map(result => result.code ?? result.status), active: activePublish.code, stale: stale.code, error: errorPublish.code, missingTool: "tool_not_found", offline: offlineProof, authorizedDownload: { route: "/artifacts/<capability>/<resource>", browserAction: "Publish HTML", bytesMatch: true, opaqueOrigin: true, adjacentStatus: adjacentResponse.status } },
      },
    };
  } finally {
    await cleanupScenarioResources(() => live?.close(), () => harness?.close());
  }
}

function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function value(result) {
  assert.ok(result && typeof result === "object" && Object.hasOwn(result, "result"), "query must return canonical envelope");
  assert.deepEqual(Object.keys(result).sort(), ["cursor", "documentRevision", "epoch", "result"].sort());
  return result.result;
}
function assertExecutableCellsSucceeded(snap) {
  const diagnostics = (snap?.cells ?? []).filter(cell => cell?.type === "code" && cell.options?.disabled !== true).map(cell => ({ id: cell.id, status: cell.status, error: cell.error, log: cell.log }));
  assert.ok(diagnostics.length > 0, "publish fixture must expose enabled executable cells");
  for (const diagnostic of diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ["error", "id", "log", "status"]);
    assert.equal(typeof diagnostic.id, "string");
    assert.equal(typeof diagnostic.status, "string");
    assert.ok(Array.isArray(diagnostic.log));
    assert.equal(diagnostic.status, "done", "publish executable cell failed: " + JSON.stringify(diagnostic));
    assert.equal(diagnostic.error, null, "publish executable cell reported an error: " + JSON.stringify(diagnostic));
  }
}

function outputRecords(raw, snap) {
  assert.ok(Array.isArray(raw) && raw.length > 0, "outputs query must return canonical output records");
  const result = [];
  for (const record of raw) {
    assert.equal(typeof record.id, "string");
    assert.deepEqual(Object.keys(record).sort(), ["cellId", "data", "id", "kernelEpoch", "metadata", "revision", "runId", "sequence", "sessionEpoch", "truncated"].sort());
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
    const payload = record.data;
    assert.ok(payload && typeof payload === "object" && typeof payload.kind === "string");
    result.push({ record, payload });
    if (payload.kind === "layout" && Array.isArray(payload.children)) for (const child of payload.children) result.push({ record, payload: child });
  }
  return result;
}
function artifactDescriptor(payload, snap) {
  const artifact = payload.artifact;
  assert.ok(artifact && typeof artifact === "object");
  assert.deepEqual(Object.keys(artifact).sort(), ["byteLength", "chunkBytes", "documentRevision", "epoch", "handle", "kernelEpoch", "mimeType"].sort());
  assert.equal(typeof artifact.handle, "string");
  assert.equal(artifact.handle.includes("/"), false);
  assert.equal(artifact.handle.includes(String.fromCharCode(92)), false);
  assert.equal(artifact.handle.includes(String.fromCharCode(0)), false);
  assert.equal(artifact.handle.includes(".."), false);
  assert.equal(typeof artifact.mimeType, "string");
  assert.equal(artifact.mimeType, "text/html");
  assert.equal(artifact.chunkBytes, 262144);
  assert.ok(Number.isSafeInteger(artifact.byteLength) && artifact.byteLength > 0);
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
    const bytes = Buffer.from(page.data, page.encoding === "base64" ? "base64" : "utf8");
    assert.equal(bytes.byteLength, page.nextOffset - offset);
    chunks.push(bytes);
    offset = page.nextOffset;
    assert.ok(offset > page.offset && offset <= artifact.byteLength);
    if (page.eof) assert.equal(offset, artifact.byteLength);
  }
  return Buffer.concat(chunks);
}
async function fetchPublishedArtifact(url) {
  const response = await fetchLogicalOrigin(url, { method: "GET", redirect: "error", credentials: "omit", headers: { Origin: "null" } });
  assert.equal(response.status, 200, "authorized publish URL must be readable: " + response.status);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html(?:;|$)/i, "publish URL must return HTML");
  return Buffer.from(await response.arrayBuffer());
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
async function settleOrError(harness, receipt) {
  const direct = receipt?.error?.code;
  if (direct) return { code: direct, status: "error" };
  const operation = await settle(harness, receipt);
  if (operation.status === "done") return operation;
  return { code: operation.error?.code, status: operation.status };
}
async function expectFailure(harness, command) {
  try {
    const receipt = await harness.nextCommand(command);
    const direct = receipt?.error?.code;
    if (direct) return { code: direct, receipt };
    const operation = await settle(harness, receipt);
    assert.equal(operation.status, "error", JSON.stringify(operation));
    const code = operation.error?.code;
    assert.equal(typeof code, "string", JSON.stringify(operation));
    return { code, receipt, operation };
  } catch (error) {
    const code = error?.code;
    assert.equal(typeof code, "string", String(error));
    return { code, error };
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
async function exists(path) { return stat(path).then(() => true).catch(() => false); }
async function withoutQuarto(path) {
  const names = process.platform === "win32" ? ["quarto.exe", "quarto.cmd", "quarto"] : ["quarto"];
  const retained = [];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    let containsQuarto = false;
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) containsQuarto = true;
      } catch {
        // This PATH entry does not provide this Quarto executable name.
      }
    }
    if (!containsQuarto) retained.push(directory);
  }
  assert.ok(retained.length > 0, "missing-Quarto fixture must retain launcher dependencies");
  return retained.join(delimiter);
}

async function manifestHash(root) {
  return createHash("sha256").update(await readFile(join(root, "resources", "manifest.json"))).digest("hex");
}
function inspectPublishedMarkup(html) {
  const resources = [];
  const styles = [];
  const resourceAttributes = {
    img: ["src", "srcset"],
    audio: ["src"],
    video: ["src", "poster"],
    source: ["src", "srcset"],
    script: ["src"],
    iframe: ["src"],
    object: ["data"],
    embed: ["src"],
    track: ["src"],
    link: ["href"],
    image: ["href", "xlink:href"],
    use: ["href", "xlink:href"],
    input: ["src"],
  };
  const pending = [parse(html)];
  for (let documentIndex = 0; documentIndex < pending.length; documentIndex += 1) {
    const nodes = [...(pending[documentIndex].childNodes ?? [])];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      if (typeof node.tagName === "string") {
        const attributes = new Map((node.attrs ?? []).map(attribute => [attribute.name, attribute.value]));
        for (const attribute of resourceAttributes[node.tagName] ?? []) {
          const value = attributes.get(attribute);
          if (value === undefined) continue;
          if (attribute === "srcset") {
            for (const candidate of srcsetCandidates(value)) resources.push(candidate.split(/\s+/)[0] ?? "");
          } else {
            resources.push(value);
          }
        }
        const srcdoc = attributes.get("srcdoc");
        if (srcdoc !== undefined) pending.push(parse(srcdoc));
        if (node.tagName === "style") styles.push(parsedTextContent(node));
        const style = attributes.get("style");
        if (style !== undefined) styles.push(style);
      }
      nodes.push(...(node.childNodes ?? []));
    }
  }
  return { resources, styles };
}
function parsedTextContent(root) {
  const nodes = [root];
  let text = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.nodeName === "#text") text += node.value ?? "";
    nodes.push(...(node.childNodes ?? []));
  }
  return text;
}
function srcsetCandidates(value) {
  const candidates = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ",") continue;
    const candidate = value.slice(start, index).trim();
    const next = value[index + 1] ?? "";
    if (/^data:/i.test(candidate) && next !== "" && !/\s/.test(next)) continue;
    if (candidate.length > 0) candidates.push(candidate);
    start = index + 1;
  }
  const final = value.slice(start).trim();
  if (final.length > 0) candidates.push(final);
  return candidates;
}
function isEmbeddedResource(value) {
  const resource = value.trim();
  return resource.length === 0 || resource.startsWith("#") || /^data:/i.test(resource);
}
async function fileHash(path) { return sha256(await readFile(path)); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
