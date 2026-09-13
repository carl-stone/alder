import test from "node:test";
import assert from "node:assert/strict";
import { renderHelp, renderMarkdown, sanitizeHtmlFragment } from "../src/markdown.js";

test("Markdown is rendered by the host with the inline trust policy", () => {
  const fragment = renderMarkdown([
    "# Safe heading",
    "",
    "Before **bold** <script>bad()</script>",
    "[safe](https://example.invalid/help) [bad](javascript:alert(1))",
    "<div onclick=\"alert(1)\"><strong>visible</strong></div>",
  ].join("\n"));
  assert.deepEqual(fragment.diagnostics, []);
  assert.match(fragment.html, /<h1>Safe heading<\/h1>/);
  assert.match(fragment.html, /<strong>bold<\/strong>/);
  assert.match(fragment.html, /visible/);
  assert.doesNotMatch(fragment.html, /<script|onclick|href=["']?javascript:/i);
});

test("help keeps tables and neutralizes relative help links", () => {
  const fragment = renderHelp({
    kind: "markdown",
    value: "| name | value |\n| :--- | ---: |\n| x | 1 |\n\n[docs](sum.html)",
  });
  assert.deepEqual(fragment.diagnostics, []);
  assert.match(fragment.html, /<table>/);
  assert.match(fragment.html, /<span>docs<\/span>/);
  assert.doesNotMatch(fragment.html, /href=["']?sum\.html["']?/);

  const code = renderHelp({ language: "r", value: "<script>bad()</script>" });
  assert.match(code.html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(code.html, /<script>/);
});

test("raw inline HTML is sanitized independently of Markdown rendering", () => {
  const html = sanitizeHtmlFragment("<strong>safe</strong><iframe srcdoc=\"bad\">bad</iframe><img src=\"data:text/html,bad\">");
  assert.match(html, /<strong>safe<\/strong>/);
  assert.doesNotMatch(html, /iframe|srcdoc|data:text/i);
});

test("inline images cannot trigger credentialed remote requests", () => {
  const html = sanitizeHtmlFragment('<img src="http://127.0.0.1:9000/steal"><img src="https://example.invalid/track"><img src="/api/artifact/local.png">');
  assert.doesNotMatch(html, /127.0.0.1|example.invalid/);
  assert.ok(html.includes('src="/api/artifact/local.png"'));
});
