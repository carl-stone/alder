import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupScenarioResources, createHarness, delay, waitForExecutionReady } from "./_common.mjs";
import { prewarmInteractiveBrowser } from "../../test-support/live-browser.mjs";

const TERMINAL = new Set(["done", "error", "failed", "interrupted", "cancelled"]);
const STALE_ARTIFACT_CODES = new Set(["output_expired", "not_found"]);
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_VALUES = [...Buffer.from(PNG_BASE64, "base64")].join(",");
const ARTIFACT_KEYS = ["byteLength", "chunkBytes", "documentRevision", "epoch", "handle", "kernelEpoch", "mimeType"];

// This is a real htmlwidgets binding and htmltools dependency. It deliberately
// attempts the same parent-DOM, parent-fetch, cookie, and API paths an injected
// widget would try, while still rendering a visible functional marker.
const WIDGET_SCRIPT = [
  "(function () {",
  "  function parentDomBlocked() {",
  "    try { window.parent.document.body.setAttribute('data-alder-parent-compromised', 'yes'); return false; }",
  "    catch (_) { return true; }",
  "  }",
  "  function parentApiBlocked() {",
  "    try { return typeof window.parent.fetch !== 'function'; }",
  "    catch (_) { return true; }",
  "  }",
  "  HTMLWidgets.widget({",
  "    name: 'alder-sandbox-widget',",
  "    type: 'output',",
  "    factory: function (element) {",
  "      return {",
  "        renderValue: function (value) {",
  "          element.textContent = value.marker + ':' + value.value;",
  "          var cookie = null;",
  "          var cookieError = null;",
  "          try { cookie = document.cookie; }",
  "          catch (error) { cookieError = { name: error && error.name ? String(error.name) : 'Error', message: String(error) }; }",
  "          var payload = {",
  "            source: 'alder-sandbox-fixture',",
  "            marker: value.marker,",
  "            functional: element.textContent,",
  "            parentDomBlocked: parentDomBlocked(),",
  "            parentApiBlocked: parentApiBlocked(),",
  "            cookie: cookie,",
  "            cookieError: cookieError",
  "          };",
  "          function publish(extra) { window.parent.postMessage(Object.assign(payload, extra), '*'); }",
  "          try {",
  "            fetch('/api/query', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'notebook' }) })",
  "              .then(function (response) { publish({ apiStatus: response.status, apiBodyReadable: false }); })",
  "              .catch(function (error) { publish({ apiStatus: null, apiBodyReadable: false, apiError: String(error) }); });",
  "          } catch (error) { publish({ apiStatus: null, apiBodyReadable: false, apiError: String(error) }); }",
  "        }",
  "      };",
  "    }",
  "  });",
  "}());",
].join("\n");

export async function run(ctx) {
  const fixtureDirectory = join(ctx.evidence, "fixtures", "sandbox-artifacts");
  await mkdir(fixtureDirectory, { recursive: true });
  const widgetScript = join(fixtureDirectory, "alder-sandbox-widget.js");
  await writeFile(widgetScript, WIDGET_SCRIPT, "utf8");
  const rFixtureDirectory = JSON.stringify(fixtureDirectory);
  const source = [
    "# %%",
    "library(alder)",
    "if (!requireNamespace(\"htmlwidgets\", quietly = TRUE)) stop(\"sandbox requires htmlwidgets\")",
    "if (!requireNamespace(\"htmltools\", quietly = TRUE)) stop(\"sandbox requires htmltools\")",
    "# %%",
    "widget_dependency <- htmltools::htmlDependency(",
    "  name = \"alder-sandbox-fixture\",",
    "  version = \"1.0.0\",",
    "  src = c(file = " + rFixtureDirectory + "),",
    "  script = \"alder-sandbox-widget.js\"",
    ")",
    "sandbox_widget <- htmlwidgets::createWidget(",
    "  name = \"alder-sandbox-widget\",",
    "  x = list(marker = \"ALDER_WIDGET_FUNCTIONAL\", value = 7),",
    "  package = \"alder\",",
    "  width = \"100%\",",
    "  height = 120,",
    "  dependencies = list(widget_dependency)",
    ")",
    "sandbox_widget",
    "# %%",
    "out$image(as.raw(c(" + PNG_VALUES + ")), alt = \"ALDER_MEDIA_IMAGE\")",
  ].join("\n") + "\n";
  let harness;
  let live;
  try {
    live = await prewarmInteractiveBrowser({ evidence: join(ctx.evidence, "browser"), name: "sandbox-artifacts" });
    harness = await createHarness(ctx, { id: "sandbox-artifacts", source });
    await live.navigate(harness);
    // Page.navigate is asynchronous in the CDP helper. Attach the message
    // listener only after the new host document owns the target, otherwise a
    // listener installed on the pre-navigation about:blank is discarded.
    await live.wait("window.__alderHost?.client?.document?.snapshot?.runtime?.executionReady === true", 60_000);
    await live.browser.evaluate([
      "(() => {",
      "  window.__alderSandboxMessages = [];",
      "  window.addEventListener(\"message\", event => {",
      "    if (event.data && event.data.source === \"alder-sandbox-fixture\") {",
      "      window.__alderSandboxMessages.push({ origin: event.origin, data: event.data });",
      "    }",
      "  });",
      "})()",
    ].join("\n"));

    const initial = await waitForExecutionReady(harness);
    const notebookDirectory = harness.canonical.replace(/[\\/][^\\/]+$/, "");
    const ordinaryLibrary = join(notebookDirectory, ".alder", "library");
    const packageMetadata = join(notebookDirectory, ".alder", "packages.yaml");
    const helperDescription = join(ctx.applicationRoot, ctx.manifest.resources.rLibraryDirectory, "alder", "DESCRIPTION");
    const helperDescriptionBefore = await fileHash(helperDescription);
    const packageBefore = value(await harness.query({ type: "packages-status" }));
    assert.equal(packageBefore.mode, "pak", JSON.stringify(packageBefore));
    assert.equal(packageBefore.library, null, JSON.stringify(packageBefore));
    await assert.rejects(stat(ordinaryLibrary), { code: "ENOENT" }, "package status must not create the project library");
    const packages = ["htmltools", "htmlwidgets"];
    const oldSidecarVersion = initial.sidecars?.packages?.version ?? null;
    const declaration = await harness.nextCommand({
      type: "packages-declare",
      packages,
      expectedSidecarVersion: oldSidecarVersion,
      expectedDocumentRevision: initial.documentRevision,
    });
    const declarationResult = await settle(harness, declaration);
    assert.equal(declarationResult.status, "done", JSON.stringify(declarationResult));
    const declared = await harness.snapshot();
    const declaredStatus = value(await harness.query({ type: "packages-status" }));
    assert.deepEqual(declaredStatus.packages, packages);
    assert.equal(declaredStatus.library, null);
    assert.equal(await readFile(packageMetadata, "utf8"), "packages:\n  - htmltools\n  - htmlwidgets\n");
    const declaredOutputs = new Map(declared.cells.filter(cell => cell.type === "code").map(cell => [cell.id, cell.outputs]));
    const installReceipt = await harness.nextCommand({
      type: "packages-install",
      packages,
      expectedDocumentRevision: declared.documentRevision,
      kernelEpoch: declared.runtime.kernelEpoch,
    });
    const installResult = await settle(harness, installReceipt);
    assert.equal(installResult.status, "done", JSON.stringify(installResult));
    const installPayload = installResult.result;
    assert.ok(installPayload?.result && installPayload.status, JSON.stringify(installResult));
    assert.equal(installPayload.result.status, "installed", JSON.stringify(installPayload));
    assert.equal(installPayload.result.library, ordinaryLibrary, JSON.stringify(installPayload));
    assert.equal(installPayload.status.mode, "pak", JSON.stringify(installPayload));
    assert.equal(installPayload.status.library, ordinaryLibrary, JSON.stringify(installPayload));
    const packageProgress = String(installPayload.result.output ?? "");
    assert.match(packageProgress, /ALDER_PACKAGE_PROGRESS/);
    assert.ok(Buffer.byteLength(packageProgress, "utf8") <= 64 * 1024, "package diagnostics must be byte-bounded");
    const installed = await waitForExecutionReady(harness);
    assert.notEqual(installed.runtime.kernelEpoch, declared.runtime.kernelEpoch, "package install must restart the kernel");
    assert.equal(installed.runtime.busy, false, JSON.stringify(installed.runtime));
    assert.equal(installed.runtime.activeRunId, null, JSON.stringify(installed.runtime));
    for (const cell of installed.cells.filter(cell => cell.type === "code")) {
      assert.equal(cell.status, "stale", JSON.stringify(cell));
      const previousOutputs = declaredOutputs.get(cell.id);
      assert.ok(previousOutputs, "package restart must retain the preinstall output set");
      assert.deepEqual(cell.outputs, previousOutputs, "package restart retains exact preinstall outputs");
      assert.ok(cell.outputs.every(output => output.kernelEpoch === declared.runtime.kernelEpoch), JSON.stringify(cell.outputs));
      assert.ok(cell.outputs.every(output => output.kernelEpoch !== installed.runtime.kernelEpoch), JSON.stringify(cell.outputs));
    }
    const packageDescriptions = {};
    for (const packageName of packages) {
      const description = join(ordinaryLibrary, packageName, "DESCRIPTION");
      const info = await stat(description);
      assert.ok(info.isFile() && info.size > 0, packageName + " must be installed in the owned project library");
      packageDescriptions[packageName] = { path: description, bytes: info.size, sha256: await fileHash(description) };
    }
    assert.equal(await fileHash(helperDescription), helperDescriptionBefore, "package setup must not mutate the immutable helper library");

    const runReceipt = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: installed.documentRevision });
    const runResult = await settle(harness, runReceipt);
    assert.equal(runResult.status, "done", JSON.stringify(runResult));
    const settled = await harness.snapshot();
    assertExecutableCellsSucceeded(settled);
    const records = outputRecords(value(await harness.query({ type: "outputs" })), settled);
    const html = records.find(item => item.payload.kind === "html");
    const image = records.find(item => item.payload.kind === "media" && item.payload.media_type === "image");
    assert.ok(html, "real htmlwidget fixture must publish a sandbox artifact");
    assert.ok(image, "image media output is published as an opaque artifact");
    assert.equal(image.payload.kind, "media");
    assert.equal(image.payload.media_type, "image");
    assert.equal(image.payload.mime, "image/png");
    assert.equal(html.record.metadata.presentation, "sandbox");
    const htmlArtifact = artifactDescriptor(html.payload, settled, "html");
    const imageArtifact = artifactDescriptor(image.payload, settled, "image", "image/png");
    const htmlBytes = await readArtifact(harness, htmlArtifact);
    const imageBytes = await readArtifact(harness, imageArtifact);
    const htmlText = htmlBytes.toString("utf8");
    assert.match(htmlText, /ALDER_WIDGET_FUNCTIONAL/);
    assert.match(htmlText, /HTMLWidgets\.widget/);
    assert.match(htmlText, /alder-sandbox-widget|parentDomBlocked|document\.cookie|cookieError|\/api\/query/);
    assert.ok(imageBytes.length > 8 && imageBytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "media artifact preserves PNG identity");

    try {
      await live.wait("Array.isArray(window.__alderSandboxMessages) && window.__alderSandboxMessages.some(message => message.data && message.data.marker === \"ALDER_WIDGET_FUNCTIONAL\")", 60_000);
    } catch (functionalError) {
      await persistSandboxTimeoutDebug({
        evidence: ctx.evidence,
        live,
        settled,
        htmlArtifact,
        imageArtifact,
        htmlText,
        htmlBytes,
        imageBytes,
      });
      throw functionalError;
    }
    const browserProof = await artifactBrowserUrl(live);
    assert.ok(browserProof, "the live output renderer must attach the HTML artifact to an iframe");
    const iframeUrl = new URL(browserProof.src, harness.origin);
    assert.equal(iframeUrl.origin, harness.origin);
    assert.match(iframeUrl.pathname, /^\/artifacts\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(iframeUrl.search, "");
    assert.equal(iframeUrl.hash, "");
    assert.equal(browserProof.srcdoc, null, "sandbox artifacts use the browser artifact URL, not inline srcdoc");
    assert.equal(browserProof.sandbox, "allow-scripts");
    assert.doesNotMatch(browserProof.sandbox, /allow-same-origin/i);
    assert.equal(browserProof.referrerPolicy, "no-referrer");
    assert.equal(browserProof.resourceStatus, 200, JSON.stringify(browserProof));
    assert.match(browserProof.resourceText, /ALDER_WIDGET_FUNCTIONAL/);
    assert.match(browserProof.resourceText, /HTMLWidgets\.widget/);
    const message = browserProof.messages.find(item => item.data?.marker === "ALDER_WIDGET_FUNCTIONAL");
    assert.ok(message, JSON.stringify(browserProof.messages));
    assert.equal(message.origin, "null", "sandboxed widget must have an opaque origin");
    assert.equal(message.data.functional, "ALDER_WIDGET_FUNCTIONAL:7");
    assert.equal(message.data.parentDomBlocked, true);
    assert.equal(message.data.parentApiBlocked, true);
    if (message.data.cookieError === null) {
      assert.equal(message.data.cookie, "", "sandboxed widget must not receive the host session cookie");
    } else {
      assert.equal(message.data.cookie, null);
      assert.ok(message.data.cookieError && typeof message.data.cookieError.name === "string" && typeof message.data.cookieError.message === "string", JSON.stringify(message.data));
      assert.equal(message.data.cookieError.name, "SecurityError", JSON.stringify(message.data));
    }
    assert.equal(message.data.apiBodyReadable, false);
    assert.ok(message.data.apiStatus === null || message.data.apiStatus === 401 || message.data.apiStatus === 403, JSON.stringify(message.data));
    const parentMarker = await live.browser.evaluate("document.body.getAttribute(\"data-alder-parent-compromised\")");
    assert.equal(parentMarker, null, "widget cannot write into the parent DOM");
    const visible = await live.observe("sandbox");
    assert.equal(visible.state.ready, true, JSON.stringify(visible.state));

    const unauthenticated = await rawQuery(harness, { type: "output", handle: htmlArtifact.handle, offset: 0, limit: 1 }, false);
    assert.equal(unauthenticated.ok, false, JSON.stringify(unauthenticated));
    assert.equal(unauthenticated.body?.error?.code, "forbidden", JSON.stringify(unauthenticated));
    const traversal = await rawQuery(harness, { type: "output", handle: "../manifest.json", offset: 0, limit: 1 });
    assert.equal(traversal.ok, false, JSON.stringify(traversal));
    assert.equal(traversal.body?.error?.code, "invalid_request", JSON.stringify(traversal));
    const unlisted = await expectQueryFailure(harness, { type: "output", handle: "not-issued.html", offset: 0, limit: 1 });
    assert.equal(unlisted, "not_found", unlisted);

    const resourceUrl = new URL(browserProof.src, harness.origin);
    const imageResourceUrl = new URL(await live.browser.evaluate("window.__alderHost.client.resolveArtifact(" + JSON.stringify(imageArtifact) + ")"), harness.origin);
    const capabilityResponse = await fetch(resourceUrl, { credentials: "omit", headers: { Origin: "null" } });
    assert.equal(capabilityResponse.status, 200);
    assert.deepEqual(Buffer.from(await capabilityResponse.arrayBuffer()), htmlBytes);
    await live.close();
    live = null;
    const owningCell = settled.cells.find(cell => cell.id === html.record.cellId);
    assert.ok(owningCell);
    const deletion = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: settled.documentRevision,
      changes: [{ type: "delete", cell: { cellId: owningCell.id }, expectedRevision: owningCell.revision }] });
    assert.equal((await settle(harness, deletion)).status, "done");
    const afterDeletion = await waitForExecutionReady(harness);
    const revoked = await expectQueryFailure(harness, { type: "output", handle: htmlArtifact.handle, offset: 0, limit: 1 });
    assert.ok(STALE_ARTIFACT_CODES.has(revoked), "owner deletion must revoke public artifact reads, got " + revoked);
    const revokedResource = await fetch(resourceUrl, { credentials: "omit", headers: { Origin: "null" } });
    assert.equal(revokedResource.status, 404, "previously issued capability must be revoked as missing with its owner");
    const revokedResourceBody = await revokedResource.json();
    assert.equal(revokedResourceBody?.error?.code, "output_expired", "revoked capabilities must report the typed expiry code");
    const retainedImage = await fetch(imageResourceUrl, { credentials: "omit", headers: { Origin: "null" } });
    assert.equal(retainedImage.status, 200, "another cell's retained artifact remains readable before restart");
    assert.deepEqual(Buffer.from(await retainedImage.arrayBuffer()), imageBytes);
    const restartReceipt = await harness.nextCommand({ type: "restart", replay: false, expectedDocumentRevision: afterDeletion.documentRevision });
    const restartResult = await settle(harness, restartReceipt);
    assert.equal(restartResult.status, "done", JSON.stringify(restartResult));
    const afterRestart = await waitForExecutionReady(harness);
    assert.notEqual(afterRestart.runtime.kernelEpoch, htmlArtifact.kernelEpoch, "restart replaces the kernel identity");
    const restartRevoked = await expectQueryFailure(harness, { type: "output", handle: imageArtifact.handle, offset: 0, limit: 1 });
    assert.ok(STALE_ARTIFACT_CODES.has(restartRevoked), "restart must revoke prior-kernel artifact reads, got " + restartRevoked);
    const restartRevokedResource = await fetch(imageResourceUrl, { credentials: "omit", headers: { Origin: "null" } });
    assert.equal(restartRevokedResource.status, 404, "restart must revoke previously issued artifact capabilities");
    const restartRevokedBody = await restartRevokedResource.json();
    assert.equal(restartRevokedBody?.error?.code, "output_expired", "restart-revoked capabilities must report the typed expiry code");
    return {
      id: "sandbox-artifacts",
      identity: {
        artifact: {
          manifestSha256: await manifestHash(ctx.applicationRoot),
          html: htmlArtifact,
          image: imageArtifact,
          htmlSha256: sha256(htmlBytes),
          imageSha256: sha256(imageBytes),
        },
        dependencies: {
          packages,
          widgetScript,
          widgetScriptSha256: await fileHash(widgetScript),
          library: ordinaryLibrary,
          packageMetadata,
          packageMetadataSha256: await fileHash(packageMetadata),
          packageDescriptions,
          helperDescription,
          helperDescriptionBefore,
          helperDescriptionAfter: await fileHash(helperDescription),
          kernelEpochBefore: declared.runtime.kernelEpoch,
          kernelEpochAfter: installed.runtime.kernelEpoch,
        },
        sandbox: {
          iframe: browserProof.sandbox,
          sameOrigin: false,
          resourceRoute: "scoped-capability-via-api-query",
          resourceUrl: "/artifacts/<capability>/<resource>",
          resourceSha256: sha256(Buffer.from(browserProof.resourceText, "utf8")),
          parentMarkerAbsent: parentMarker === null,
          parentMessageOrigin: message.origin,
          parentDomBlocked: message.data.parentDomBlocked,
          parentApiBlocked: message.data.parentApiBlocked,
          cookieEmpty: message.data.cookie === "",
          cookieReadError: message.data.cookieError,
          apiStatus: message.data.apiStatus,
          apiError: message.data.apiError ?? null,
          unauthenticatedRejected: !unauthenticated.ok,
          traversalRejected: !traversal.ok,
          unlistedRejected: unlisted,
          revokedHandle: revoked,
          retainedAcrossRestart: false,
          revokedResourceStatus: revokedResource.status,
          unrelatedResourceRetainedUntilRestart: true,
          restartRevokedHandle: restartRevoked,
          restartRevokedResourceStatus: restartRevokedResource.status,
        },
        browser: {
          driver: process.env.CHROME_PATH ?? "google-chrome",
          screenshot: visible.screenshot ?? null,
          parentMarkerAbsent: parentMarker === null,
        },
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
  const diagnostics = (snap?.cells ?? [])
    .filter(cell => cell?.type === "code" && cell.options?.disabled !== true)
    .map(cell => ({ id: cell.id, status: cell.status, error: cell.error, log: cell.log }));
  assert.ok(diagnostics.length > 0, "sandbox fixture must expose enabled executable cells");
  for (const diagnostic of diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ["error", "id", "log", "status"]);
    assert.equal(diagnostic.status, "done", "sandbox executable cell failed: " + JSON.stringify(diagnostic));
    assert.equal(diagnostic.error, null, "sandbox executable cell reported an error: " + JSON.stringify(diagnostic));
  }
}

function outputRecords(raw, snap) {
  assert.ok(Array.isArray(raw) && raw.length > 0, "outputs query must return canonical output records");
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
    assert.equal(record.sessionEpoch, snap.epoch);
    assert.equal(typeof record.cellId, "string");
    assert.equal(typeof record.revision, "number");
    assert.equal(typeof record.sequence, "number");
    assert.equal(typeof record.truncated, "boolean");
    assert.ok(record.metadata && ["inline", "sandbox"].includes(record.metadata.presentation));
    assert.ok(record.data && typeof record.data === "object");
    const staticMarkdown = snap.cells?.find(cell => cell.id === record.cellId)?.type === "markdown" && record.data?.kind === "markdown" && record.kernelEpoch === null && record.runId === null;
    if (staticMarkdown) {
      assert.equal(record.kernelEpoch, null);
      assert.equal(record.runId, null);
    } else {
      assert.equal(typeof record.kernelEpoch, "string");
      assert.equal(record.kernelEpoch, snap.runtime?.kernelEpoch);
      assert.equal(typeof record.runId, "string");
    }
    visit(record.data, record);
  }
  assert.ok(result.length > 0, "output records must contain typed payloads");
  return result;
}

function artifactDescriptor(payload, snap, label, mimeType = "text/html") {
  const artifact = payload.artifact;
  assert.ok(artifact && typeof artifact === "object", label + " must expose canonical ArtifactHandle");
  assert.deepEqual(Object.keys(artifact).sort(), ARTIFACT_KEYS.slice().sort());
  assert.equal(typeof artifact.handle, "string");
  assert.doesNotMatch(artifact.handle, /[\/\0]|\.\./);
  assert.equal(artifact.mimeType, mimeType);
  assert.ok(Number.isSafeInteger(artifact.byteLength) && artifact.byteLength > 0);
  assert.equal(artifact.chunkBytes, 262144);
  assert.equal(artifact.epoch, snap.epoch);
  assert.equal(artifact.documentRevision, snap.documentRevision);
  assert.equal(artifact.kernelEpoch, snap.runtime?.kernelEpoch);
  return artifact;
}

async function readArtifact(harness, artifact) {
  const chunks = [];
  let offset = 0;
  while (offset < artifact.byteLength) {
    const envelope = await harness.query({ type: "output", handle: artifact.handle, offset, limit: Math.min(artifact.chunkBytes, artifact.byteLength - offset) });
    assert.equal(envelope.epoch, artifact.epoch);
    assert.equal(envelope.documentRevision, artifact.documentRevision);
    const page = value(envelope);
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

async function persistSandboxTimeoutDebug({ evidence, live, settled, htmlArtifact, imageArtifact, htmlText, htmlBytes, imageBytes }) {
  let parent = null;
  try {
    parent = await live.browser.evaluate([
      "(() => {",
      "  const frameDetails = [...document.querySelectorAll(\"iframe.html-widget\")].map(frame => ({",
      "    src: frame.getAttribute(\"src\"),",
      "    srcdoc: frame.getAttribute(\"srcdoc\"),",
      "    sandbox: frame.getAttribute(\"sandbox\"),",
      "    referrerPolicy: frame.getAttribute(\"referrerpolicy\"),",
      "    title: frame.getAttribute(\"title\"),",
      "    outerHTML: frame.outerHTML,",
      "    child: (() => {",
      "      try {",
      "        const child = frame.contentDocument;",
      "        return child ? { url: child.URL, readyState: child.readyState, text: child.body?.innerText ?? \"\", html: child.documentElement?.outerHTML ?? \"\" } : null;",
      "      } catch (error) { return { error: String(error) }; }",
      "    })(),",
      "  }));",
      "  return {",
      "    readyState: document.readyState,",
      "    runtime: window.__alderHost?.client?.document?.snapshot?.runtime ?? null,",
      "    messages: window.__alderSandboxMessages ?? null,",
      "    outputText: document.querySelector(\"#notebook\")?.innerText ?? \"\",",
      "    frameDetails,",
      "  };",
      "})()",
    ].join("\n"));
  } catch (error) {
    parent = { error: String(error) };
  }
  const chrome = live?.browser;
  const debug = {
    id: "sandbox-artifacts",
    settledRuntime: settled.runtime ?? null,
    canonical: {
      html: { descriptor: htmlArtifact, byteLength: htmlBytes.byteLength, sha256: sha256(htmlBytes), text: htmlText },
      image: { descriptor: imageArtifact, byteLength: imageBytes.byteLength, sha256: sha256(imageBytes) },
    },
    liveParent: parent,
    frameConsole: chrome?.events ?? [],
    cdpExceptions: chrome?.errors ?? [],
    chromeStderr: chrome?.stderr ?? "",
  };
  try {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "sandbox-artifacts-timeout-debug.json"), JSON.stringify(debug, null, 2) + "\n", "utf8");
  } catch {
    // Preserve the original functional wait error if diagnostics cannot persist.
  }
}

async function artifactBrowserUrl(live) {
  return live.browser.evaluate([
    "(async () => {",
    "  const frame = document.querySelector(\"iframe.html-widget\");",
    "  if (!frame) return null;",
    "  const src = frame.getAttribute(\"src\") || \"\";",
    "  const response = await fetch(src, { credentials: \"omit\" });",
    "  return {",
    "    src,",
    "    srcdoc: frame.getAttribute(\"srcdoc\"),",
    "    sandbox: frame.getAttribute(\"sandbox\"),",
    "    referrerPolicy: frame.getAttribute(\"referrerpolicy\"),",
    "    resourceStatus: response.status,",
    "    resourceText: await response.text(),",
    "    messages: window.__alderSandboxMessages || [],",
    "  };",
    "})()",
  ].join("\n"));
}

async function rawQuery(harness, query, authenticated = true) {
  const headers = { Origin: harness.origin, "Content-Type": "application/json" };
  if (authenticated) {
    headers.Cookie = harness.session.cookie;
    headers["X-CSRF-Token"] = harness.session.csrf;
  }
  const response = await fetch(new URL("/api/query", harness.origin), {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify(harness.wire.encodeHostQueryWire(query)),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let body = null;
  if (bytes.length > 0) {
    try { body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); }
    catch { body = new TextDecoder().decode(bytes); }
  }
  return { ok: response.ok, status: response.status, body };
}

async function expectQueryFailure(harness, query) {
  try {
    await harness.query(query);
  } catch (error) {
    const match = String(error).match(/\b(output_expired|stale_value|stale_kernel|not_found)\b/);
    assert.ok(match, String(error));
    return match[1];
  }
  assert.fail("expected output query to fail: " + JSON.stringify(query));
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

async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function manifestHash(root) {
  return createHash("sha256").update(await readFile(join(root, "resources", "manifest.json"))).digest("hex");
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
