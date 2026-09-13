import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import type { Hover } from "vscode-languageserver-protocol";
import type { AnalysisDiagnostic } from "./protocol.js";

/** A host-rendered, sanitized fragment and any recoverable diagnostics. */
export interface RenderFragment {
  html: string;
  diagnostics: AnalysisDiagnostic[];
}

type Attributes = Record<string, string>;

const INLINE_TAGS = [
  "p", "br", "hr", "em", "strong", "blockquote", "ul", "ol", "li",
  "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "a", "img",
];
const HELP_TAGS = [...INLINE_TAGS, "div", "span", "table", "thead", "tbody", "tfoot", "tr", "th", "td"];
const DROPPED_TAGS = ["script", "style", "iframe", "object", "embed", "svg", "math", "noscript", "template"];
const TEXTLESS_TAGS = ["textarea", "title", "xmp", ...DROPPED_TAGS];

const markdown = new MarkdownIt("commonmark", { html: true, breaks: false, linkify: false, typographer: false });
const helpMarkdown = new MarkdownIt("commonmark", { html: true, breaks: false, linkify: false, typographer: false }).enable("table");

function escaped(value: string): string {
  return value.replace(/[&<>\"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]!));
}

function controlsOrBackslash(value: string): boolean {
  for (const character of value) {
    if (character.codePointAt(0)! < 0x20 || character === "\\") return true;
  }
  return false;
}

function safeUrl(value: unknown, image: boolean): string | null {
  if (typeof value !== "string" || value.length === 0 || controlsOrBackslash(value)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (controlsOrBackslash(decoded)) return null;
  decoded = decoded.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g, "");
  if (decoded.length === 0 || decoded.startsWith("//")) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)?.[1]?.toLowerCase();
  if (scheme && (image || !["http", "https", "mailto"].includes(scheme))) return null;
  return decoded;
}

function textAttribute(value: unknown): value is string {
  return typeof value === "string" && !controlsOrBackslash(value);
}

function allowedAttribute(tag: string, name: string, value: string, help: boolean): string | null {
  if (tag === "a" && name === "href") {
    const url = safeUrl(value, false);
    if (url === null) return help ? "__remove_relative_link__" : null;
    if (help && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return "__remove_relative_link__";
    return url;
  }
  if (tag === "img" && name === "src") return safeUrl(value, true);
  if ((name === "title" || name === "alt") && textAttribute(value)) return value;
  if (tag === "ol" && name === "start" && /^[1-9][0-9]*$/.test(value)) return value;
  if (tag === "code" && name === "class" && /^language-[a-zA-Z0-9_-]+$/.test(value)) return value;
  return null;
}

function sanitizerOptions(help: boolean): sanitizeHtml.IOptions {
  const tags = help ? HELP_TAGS : INLINE_TAGS;
  return {
    allowedTags: tags,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt"],
      ol: ["start"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: TEXTLESS_TAGS,
    transformTags: {
      "*": (tagName, attributes: Attributes) => {
        const next: Attributes = {};
        let replaceWithSpan = false;
        for (const [name, value] of Object.entries(attributes)) {
          const cleaned = allowedAttribute(tagName.toLowerCase(), name.toLowerCase(), value, help);
          if (cleaned === "__remove_relative_link__") replaceWithSpan = true;
          else if (cleaned !== null) next[name.toLowerCase()] = cleaned;
        }
        return { tagName: replaceWithSpan ? "span" : tagName, attribs: replaceWithSpan ? {} : next };
      },
    },
  };
}

function sanitizeFragment(html: string, help: boolean): string {
  return sanitizeHtml(html, sanitizerOptions(help));
}

function diagnostic(error: unknown): AnalysisDiagnostic {
  return {
    level: "error",
    code: "markdown_render_failed",
    message: error instanceof Error ? error.message : String(error),
    range: null,
  };
}

function renderFailure(source: string, error: unknown): RenderFragment {
  return { html: escaped(source), diagnostics: [diagnostic(error)] };
}

export function sanitizeHtmlFragment(html: string): string {
  try {
    return sanitizeFragment(html, false);
  } catch {
    return escaped(String(html));
  }
}

export function renderMarkdown(source: string): RenderFragment {
  const input = typeof source === "string" ? source : String(source);
  try {
    return { html: sanitizeFragment(markdown.render(input), false), diagnostics: [] };
  } catch (error) {
    return renderFailure(input, error);
  }
}

function renderHelpValue(value: Hover["contents"]): string {
  if (typeof value === "string") return helpMarkdown.render(value);
  if (Array.isArray(value)) return value.map(renderHelpValue).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") {
      if (record.kind === "plaintext" || typeof record.language === "string") {
        return "<pre><code>" + escaped(record.value) + "</code></pre>";
      }
      return helpMarkdown.render(record.value);
    }
  }
  return escaped(value == null ? "" : String(value));
}

export function renderHelp(contents: Hover["contents"]): RenderFragment {
  try {
    const rendered = renderHelpValue(contents);
    return { html: sanitizeFragment(rendered, true), diagnostics: [] };
  } catch (error) {
    const text = typeof contents === "string" ? contents : JSON.stringify(contents);
    return renderFailure(text ?? "", error);
  }
}
