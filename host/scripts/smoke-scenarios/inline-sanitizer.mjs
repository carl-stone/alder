import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupScenarioResources, createHarness, waitForExecutionReady } from './_common.mjs';
import { prewarmInteractiveBrowser } from "../../test-support/live-browser.mjs";

const TERMINAL = new Set(["done", "error", "failed", "interrupted", "cancelled"]);

export async function run(ctx) {
  const source = `# %% [markdown]
# # ALDER_SAFE_MARKDOWN
#
# **ALDER_BOLD** <script>window.__inline_escape = true</script>
# [safe](https://example.invalid/help) [encoded](java&#x73;cript:alert(1)) [data](data:text/html,bad)
# <div onclick="alert(1)" onmouseover="alert(2)"><strong>ALDER_VISIBLE</strong><svg onload="alert(3)"></svg></div>
#
# | name | value |
# | --- | --- |
# | ALDER_HELP_TABLE | 1 |
# %%
library(alder)
out$md("# ALDER_SAFE_OUTPUT\\n\\n**ALDER_SAFE_STRONG** <script>window.__inline_escape = true</script> [safe](https://example.invalid) [encoded](java&#x73;cript:alert(1)) [data](data:text/html,bad) <div onclick='bad()' onerror='bad()'>ALDER_INLINE_VISIBLE</div>")
# %%
out$html("<strong>ALDER_RAW_HTML_ARTIFACT</strong><iframe srcdoc='window.__inline_escape=true'></iframe><img src='data:text/html,bad' onerror='bad()'><svg onload='bad()'></svg>")
# %%
out$tabs(
  Safe = out$md("**ALDER_NESTED_SAFE** [safe](https://example.invalid/nested)"),
  Nested = out$md("ALDER_NESTED_ATTACK <script>window.__inline_escape = true</script> [bad](java&#x73;cript:alert(1))")
)
# %%
out$md("ALDER_MALFORMED <div><strong>")
`;
  let harness;
  let live;
  try {
    live = await prewarmInteractiveBrowser({ evidence: join(ctx.evidence, "browser"), name: "inline-sanitizer" });
    harness = await createHarness(ctx, { id: "inline-sanitizer", source });
    await live.navigate(harness);
    const initial = await waitForExecutionReady(harness);
    const receipt = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: initial.documentRevision });
    const run = await settle(harness, receipt);
    assert.equal(run.status, "done", JSON.stringify(run));
    const settled = await harness.snapshot();
    const records = outputRecords(value(await harness.query({ type: "outputs" })), settled);
    const markdown = records.filter(item => item.payload.kind === "markdown");
    assert.ok(markdown.length >= 4, "markdown, nested, and malformed outputs remain typed records");
    for (const item of markdown) {
      assert.equal(typeof item.payload.html, "string");
      assert.equal(typeof item.payload.text, "string");
      assert.doesNotMatch(item.payload.html, /<script\b|<iframe\b|<object\b|<embed\b|<svg\b|srcdoc\s*=|on[a-z]+\s*=|(?:href|src)\s*=\s*["']?javascript:/i);
      assert.doesNotMatch(item.payload.html, /(?:href|src)\s*=\s*["']?data:text\/html/i);
    }
    const safe = markdown.find(item => item.payload.html.includes("ALDER_SAFE_STRONG"));
    assert.ok(safe);
    assert.match(safe.payload.html, /<strong>ALDER_SAFE_STRONG<\/strong>/);
    assert.match(safe.payload.html, /ALDER_INLINE_VISIBLE/);
    assert.match(safe.payload.html, /<a[^>]+href=["']https:\/\/example.invalid/);
    const nested = markdown.find(item => item.payload.text.includes("ALDER_NESTED_ATTACK"));
    assert.ok(nested, "nested helper output uses the same sanitizer");
    const malformed = markdown.find(item => item.payload.text.includes("ALDER_MALFORMED"));
    assert.ok(malformed);
    assert.match(malformed.payload.text, /ALDER_MALFORMED/);
    assert.match(malformed.payload.html, /ALDER_MALFORMED/);
    const rawHtml = records.find(item => item.payload.kind === "html");
    assert.ok(rawHtml, "raw HTML remains a typed inline output");
    assert.equal(rawHtml.record.metadata.presentation, "inline");
    assert.equal(typeof rawHtml.payload.html, "string");
    assert.match(rawHtml.payload.html, /<strong>ALDER_RAW_HTML_ARTIFACT<\/strong>/);
    assert.doesNotMatch(rawHtml.payload.html, /<script\b|<iframe\b|<object\b|<embed\b|<svg\b|srcdoc\s*=|on[a-z]+\s*=|(?:href|src)\s*=\s*["']?javascript:/i);
    assert.doesNotMatch(rawHtml.payload.html, /(?:href|src)\s*=\s*["']?data:text\/html/i);
    const help = value(await harness.query({ type: "help", contents: {
      kind: "markdown",
      value: "| name | value |\n| --- | --- |\n| ALDER_HELP | 1 |\n\n[bad](java&#x73;cript:alert(1)) <script>bad()</script>",
    } }));
    const helpHtml = help?.html;
    assert.equal(typeof helpHtml, "string", JSON.stringify(help));
    assert.ok(helpHtml, "help markdown is rendered by the host");
    assert.match(helpHtml, /<table>/);
    assert.match(helpHtml, /ALDER_HELP/);
    assert.doesNotMatch(helpHtml, /<script\b|on[a-z]+\s*=|(?:href|src)\s*=\s*["']?javascript:|data:text\/html/i);
    const visible = await live.observe("sanitized");
    assert.equal(visible.state.ready, true, JSON.stringify(visible.state));
    assert.match(visible.state.text, /ALDER_SAFE_STRONG|ALDER_HELP_TABLE/);
    const beforeUrl = await live.browser.evaluate("location.href");
    const browserProofExpression = [
      '(() => {',
      '  const scope = document.querySelector("#notebook") || document.body;',
      '  const links = [...scope.querySelectorAll("a")].map(a => ({href: a.getAttribute("href"), text: a.textContent}));',
      '  const unsafeNodes = scope.querySelectorAll("script,object,embed,iframe,svg,[onclick],[onerror],[onload],[onmouseover]").length;',
      '  const unsafeLinks = [...scope.querySelectorAll("[href],[src]")].map(node => node.getAttribute("href") ?? node.getAttribute("src")).filter(url => /^(?:javascript:|data:text\\/html)/i.test(url || ""));',
      '  const attackMarker = window.__inline_escape === true;',
      '  const unsafeAttrs = [...scope.querySelectorAll("*")].filter(node => [...node.attributes].some(attribute => /^on[a-z]+$/i.test(attribute.name))).length;',
      '  const visibleText = document.body.innerText || "";',
      '  const hostileAnchor = [...scope.querySelectorAll("a")].find(anchor => /encoded|data|bad/i.test(anchor.textContent || "") && !/^https:\\/\\//i.test(anchor.getAttribute("href") || ""));',
      '  if (hostileAnchor) hostileAnchor.click();',
      '  return { links, unsafeNodes, unsafeAttrs, unsafeLinks, attackMarker, visibleText, afterClick: location.href, rawMarker: visibleText.includes("ALDER_RAW_HTML_ARTIFACT") && [...scope.querySelectorAll("strong")].some(node => node.textContent?.includes("ALDER_RAW_HTML_ARTIFACT")), table: visibleText.includes("ALDER_HELP_TABLE") };',
      '})()',
    ].join(String.fromCharCode(10));
    const browserProof = await live.browser.evaluate(browserProofExpression);
    assert.equal(browserProof.attackMarker, false, "inline attack script must never execute");
    assert.equal(browserProof.unsafeAttrs, 0, JSON.stringify(browserProof));
    assert.equal(browserProof.unsafeNodes, 0, JSON.stringify(browserProof));
    assert.deepEqual(browserProof.unsafeLinks, []);
    assert.equal(browserProof.afterClick, beforeUrl, "hostile URL click must not navigate the application");
    assert.equal(browserProof.rawMarker, true, "sanitized inline HTML remains visible in the app DOM");
    assert.equal(browserProof.table, true, "benign help/table content remains visible");
    assert.match(browserProof.visibleText, /ALDER_MALFORMED/);
    await live.close();
    live = null;
    return {
      id: "inline-sanitizer",
      identity: {
        artifact: { manifestSha256: await manifestHash(ctx.applicationRoot), notebook: harness.canonical, inlineHtml: { kind: rawHtml.payload.kind, presentation: rawHtml.record.metadata.presentation, bytes: Buffer.byteLength(rawHtml.payload.html, "utf8"), sha256: createHash("sha256").update(rawHtml.payload.html).digest("hex") } },
        sanitizer: { authority: "Node host markdown renderer", markdownRecords: markdown.length, nested: true, helpTable: true, malformedVisible: true, noRRenderer: true },
        browser: { driver: "live-cdp", unsafeNodes: browserProof.unsafeNodes, unsafeAttrs: browserProof.unsafeAttrs, attackExecuted: browserProof.attackMarker, navigation: browserProof.afterClick },
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
    visit(record.data, record);
  }
  return result;
}
async function settle(harness, receipt) {
  const operationId = receipt?.operationId;
  assert.equal(typeof operationId, "string", JSON.stringify(receipt));
  const deadline = Date.now() + 120000;
  for (;;) {
    const operation = value(await harness.query({ type: "operation", operationId }));
    if (operation && TERMINAL.has(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error("operation_timeout: " + operationId);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function manifestHash(root) {
  return createHash("sha256").update(await readFile(join(root, "resources", "manifest.json"))).digest("hex");
}
