import type { EditorSelection, Extension, Range, Text } from "@codemirror/state";
import type { DecorationSet, Tooltip, TooltipView } from "@codemirror/view";
import type { CompletionSource } from "@codemirror/autocomplete";
import type {
  EditorFactoryOptions, EditorHandle, EditorHover, EditorSignature, EditorDiagnostic, EditorReference,
} from "../../host/src/browser/editor.js";
import {EditorState, Compartment, StateEffect, StateField} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  highlightSpecialChars,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  Decoration,
  hoverTooltip,
  activateHover,
  closeHoverTooltips,
  hasHoverTooltips,
  logException,
  tooltips
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment
} from "@codemirror/commands";
import {indentOnInput, foldGutter, foldKeymap, HighlightStyle, StreamLanguage, syntaxHighlighting} from "@codemirror/language";
import {markdown} from "@codemirror/lang-markdown";
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  completionKeymap,
  closeCompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion
} from "@codemirror/autocomplete";
import {searchKeymap, highlightSelectionMatches, openSearchPanel} from "@codemirror/search";
import {linter, setDiagnostics} from "@codemirror/lint";
import {r} from "@codemirror/legacy-modes/mode/r";
import {vim} from "@replit/codemirror-vim";
import {tags} from "@lezer/highlight";

const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const completionCompartment = new Compartment();
const themeCompartment = new Compartment();
const reactiveEffect = StateEffect.define<DecorationSet>();
const reactiveField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(reactiveEffect)) value = effect.value;
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

export function languageFor(name: string) {
  return name === "markdown" ? markdown() : StreamLanguage.define(r);
}

const lightHighlightStyle = HighlightStyle.define([
  {tag: [tags.keyword, tags.controlKeyword], color: "#7656b8"},
  {tag: [tags.string, tags.regexp], color: "#9a4a2d"},
  {tag: [tags.number, tags.bool, tags.null], color: "#176982"},
  {tag: tags.comment, color: "#6b737d", fontStyle: "italic"},
  {tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "#255fa8"},
  {tag: [tags.typeName, tags.className], color: "#7b4b18"},
  {tag: tags.operator, color: "#6b4f85"},
  {tag: tags.heading, color: "#244f91", fontWeight: "700"},
  {tag: tags.link, color: "#1557c0", textDecoration: "underline"},
  {tag: tags.invalid, color: "#b4232f", textDecoration: "underline wavy"},
]);

const darkHighlightStyle = HighlightStyle.define([
  {tag: [tags.keyword, tags.controlKeyword], color: "#c5a7ff"},
  {tag: [tags.string, tags.regexp], color: "#e7a17f"},
  {tag: [tags.number, tags.bool, tags.null], color: "#83cbe5"},
  {tag: tags.comment, color: "#9aa3ae", fontStyle: "italic"},
  {tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "#8ab7ff"},
  {tag: [tags.typeName, tags.className], color: "#e4bc82"},
  {tag: tags.operator, color: "#ccb2df"},
  {tag: tags.heading, color: "#a9c5ff", fontWeight: "700"},
  {tag: tags.link, color: "#9dbbff", textDecoration: "underline"},
  {tag: tags.invalid, color: "#ff8b95", textDecoration: "underline wavy"},
]);

const editorChrome = {
  "&": {backgroundColor: "transparent", color: "var(--text)"},
  "&.cm-focused": {outline: "none"},
  ".cm-content": {caretColor: "var(--accent)"},
  ".cm-cursor, .cm-dropCursor": {borderLeftColor: "var(--accent)", borderLeftWidth: "2px"},
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  ".cm-activeLine": {backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)"},
  ".cm-gutters": {backgroundColor: "transparent", color: "var(--muted)", borderRight: "0"},
  ".cm-activeLineGutter": {backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)", color: "var(--text-secondary)"},
  ".cm-matchingBracket": {backgroundColor: "var(--accent-soft)", outline: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)"},
  ".cm-searchMatch": {backgroundColor: "color-mix(in srgb, #e7b43a 36%, transparent)", outline: "1px solid color-mix(in srgb, #b47a00 55%, transparent)"},
  ".cm-searchMatch.cm-searchMatch-selected": {backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)"},
  ".cm-tooltip": {border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", backgroundColor: "var(--surface-raised)", color: "var(--text)", boxShadow: "var(--shadow-menu)", overflow: "hidden"},
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {backgroundColor: "var(--accent-soft)", color: "var(--text)"},
  ".cm-panels": {borderColor: "var(--border)", backgroundColor: "var(--surface-raised)", color: "var(--text)"},
  ".cm-diagnostic": {borderLeftColor: "var(--border-strong)", color: "var(--text)"},
  ".cm-diagnostic-error": {borderLeftColor: "var(--danger)"},
  ".cm-diagnostic-warning": {borderLeftColor: "var(--warning)"},
  ".cm-lintRange-error": {backgroundImage: "none", textDecoration: "underline wavy var(--danger)"},
  ".cm-lintRange-warning": {backgroundImage: "none", textDecoration: "underline wavy var(--warning)"},
  ".cm-alder-hover, .cm-alder-signature": {backgroundColor: "var(--surface-raised)", color: "var(--text)"},
};

export function editorThemeExtensions(dark: boolean): Extension {
  return [
    EditorView.theme(editorChrome, {dark}),
    syntaxHighlighting(dark ? darkHighlightStyle : lightHighlightStyle),
  ];
}

function darkThemeActive(): boolean {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
}

function makeSignatureTooltip(value: EditorSignature | null) {
  if (!value || !value.label) return null;
  const dom = document.createElement("div");
  dom.className = "cm-alder-signature";
  dom.setAttribute("role", "tooltip");
  const label = document.createElement("code");
  label.textContent = String(value.label);
  dom.appendChild(label);
  if (value.activeParameter) {
    const argument = document.createElement("div");
    argument.className = "cm-alder-signature-argument";
    argument.textContent = `Argument: ${value.activeParameter}`;
    dom.appendChild(argument);
  }
  if (value.documentation) {
    const documentation = document.createElement("div");
    documentation.className = "cm-alder-signature-documentation";
    documentation.textContent = String(value.documentation);
    dom.appendChild(documentation);
  }
  return dom;
}

function makeHoverTooltip(value: NonNullable<EditorHover>, view: EditorView, focusContent: boolean): TooltipView {
  const text = typeof value === "string" ? value : String(value?.text ?? "");
  const html = typeof value !== "string" && typeof value.html === "string" ? value.html : "";
  const dom = document.createElement("div");
  dom.className = "cm-alder-hover";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "R documentation");
  const heading = document.createElement("div");
  heading.className = "cm-alder-hover-heading";
  const title = document.createElement("strong");
  title.textContent = "R documentation";
  const hint = document.createElement("span");
  hint.textContent = "Esc to close";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn mini";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close R documentation");
  const dismiss = () => {
    view.dispatch({effects: closeHoverTooltips});
    view.focus();
  };
  close.addEventListener("click", dismiss);
  dom.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  heading.append(title, hint, close);
  const content = document.createElement("div");
  content.className = "cm-alder-hover-content";
  content.tabIndex = 0;
  content.setAttribute("role", "document");
  content.setAttribute("aria-label", "R help contents");
  if (html) {
    // This optional field is sanitized by the same server boundary as output
    // Markdown. The original LSP contents remain available as the fallback.
    content.innerHTML = html;
  } else {
    const plain = document.createElement("pre");
    plain.textContent = text;
    content.appendChild(plain);
  }
  dom.append(heading, content);
  return {dom, mount() { if (focusContent && view.hasFocus) content.focus(); }};
}

function toDecorations(ranges: readonly EditorReference[]) {
  const marks: Range<Decoration>[] = [];
  const references: readonly EditorReference[] = Array.isArray(ranges) ? ranges : [];
  for (const item of references) {
    const from = Number.isFinite(item.from) ? item.from : null;
    const to = typeof item.to === "number" && Number.isFinite(item.to) ? item.to : from;
    if (from !== null && to !== null && to >= from) marks.push(Decoration.mark({class: "cm-reactive-ref"}).range(from, to));
  }
  return Decoration.set(marks, true);
}
export function createEditor({
  parent,
  doc = "",
  language = "r",
  readOnly = false,
  keymap: keymapName = "default",
  onChange,
  onRun,
  onSave,
  onFormat,
  onJump,
  onHover,
  onSignature,
  completionsEnabled = true,
  signatureHelpEnabled = true
}: EditorFactoryOptions = {}) {
  const cspNonce = typeof document === "undefined" ? "" :
    (document.querySelector<HTMLMetaElement>('meta[name="alder-csp-nonce"]')?.content || "");
  const isMarkdown = language === "markdown";
  const completionSource: {current: CompletionSource | null} = {current: null};
  const completions = {enabled: !isMarkdown && completionsEnabled !== false};
  const signature = {enabled: !isMarkdown && signatureHelpEnabled !== false, request: 0};
  const diagnostics: {current: readonly EditorDiagnostic[]} = {current: []};
  let signatureNode: HTMLElement | null = null;
  let suppressChanges = false;
  let keyboardHoverIntent: {doc: Text; selection: EditorSelection; pos: number} | null = null;
  let preparedKeyboardHover: {pos: number; value: NonNullable<EditorHover>} | null = null;
  let darkTheme = darkThemeActive();
  const cancelKeyboardHover = () => { keyboardHoverIntent = null; };
  const helpTooltip = (value: EditorHover, pos: number, focusContent: boolean): Tooltip | null => {
    if (!value) return null;
    const text = typeof value === "string" ? value : String(value.text ?? "");
    if (!text && (typeof value === "string" || !value.html)) return null;
    return {pos, end: pos, above: true,
      create: (editor) => makeHoverTooltip(value, editor, focusContent)};
  };
  const helpHover: ReturnType<typeof hoverTooltip> | null = !isMarkdown && onHover ? hoverTooltip((view, pos) => {
    if (preparedKeyboardHover?.pos === pos) {
      const prepared = preparedKeyboardHover;
      preparedKeyboardHover = null;
      return helpTooltip(prepared.value, pos, true);
    }
    // Delayed mouse retries must neither abort requested F1 help nor replace
    // help that is already open (including a locked keyboard tooltip).
    if (keyboardHoverIntent || (helpHover && view.state.field(helpHover.active, false)?.length)) return null;
    return Promise.resolve(onHover(view, pos)).then(value => helpTooltip(value, pos, false));
  }, {hideOnChange: true}) : null;
  const openKeyboardHelp = (view: EditorView) => {
    if (!helpHover || !onHover) return false;
    const selection = view.state.selection;
    const intent = {doc: view.state.doc, selection, pos: selection.main.head};
    keyboardHoverIntent = intent;
    // CodeMirror cancels async hover on any ViewUpdate, including decorations.
    // Fetch independently, then install the still-requested help synchronously.
    Promise.resolve().then(() => keyboardHoverIntent === intent ?
      onHover(view, intent.pos) : null).then(value => {
      if (keyboardHoverIntent !== intent) return;
      cancelKeyboardHover();
      if (!value || !view.hasFocus || view.state.doc !== intent.doc ||
          !view.state.selection.eq(intent.selection)) return;
      preparedKeyboardHover = {pos: intent.pos, value};
      try {
        activateHover(view, intent.pos, 1, {tooltip: helpHover});
      } finally {
        preparedKeyboardHover = null;
      }
    }).catch(error => {
      if (keyboardHoverIntent === intent) cancelKeyboardHover();
      logException(view.state, error, "R documentation request");
    });
    return true;
  };
  // Keep CodeMirror's completion StateField installed for the editor's entire
  // lifetime. Removing it through a compartment while a tooltip/blur handler
  // is active can leave that handler consulting an absent field. The stable
  // adapter gates requests without invalidating CodeMirror plugin state.
  const stableCompletionSource: CompletionSource = (context) => {
    if (!completions.enabled || !completionSource.current) return null;
    return completionSource.current(context);
  };
  const extensions: Extension[] = [
    tooltips({parent: document.body}),
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    drawSelection(),
    highlightSpecialChars(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
    history(),
    closeBrackets(),
    indentOnInput(),
    reactiveField,
    languageCompartment.of(languageFor(language)),
    readOnlyCompartment.of(EditorState.readOnly.of(Boolean(readOnly))),
    // Server completion commits source. Share the typing pause with notebook
    // edits so automatic help cannot split an immediate edit-and-Run command.
    // Explicit Tab completion still starts immediately.
    completionCompartment.of(autocompletion({override: [stableCompletionSource], activateOnTypingDelay: 400})),
    themeCompartment.of(editorThemeExtensions(darkTheme)),
    linter(() => diagnostics.current, {delay: 1000}),
    keymap.of([
      {key: "F1", run: openKeyboardHelp},
      {key: "Escape", run: (view) => {
        const pending = Boolean(keyboardHoverIntent);
        cancelKeyboardHover();
        if (!hasHoverTooltips(view.state)) return pending;
        view.dispatch({effects: closeHoverTooltips});
        return true;
      }},
      {key: "Mod-Enter", run: () => { onRun?.(); return true; }},
      {key: "Shift-Enter", run: () => { onRun?.(true); return true; }},
      {key: "Mod-s", run: () => { onSave?.(); return true; }},
      {key: "Mod-Shift-f", run: () => { if (!isMarkdown) onFormat?.(); return !isMarkdown; }},
      {key: "Mod-Alt-f", run: () => { if (!isMarkdown) onFormat?.(); return !isMarkdown; }},
      {key: "Mod-/", run: toggleComment},
      {key: "Alt-ArrowUp", run: () => { onJump?.("move", -1); return true; }},
      {key: "Alt-ArrowDown", run: () => { onJump?.("move", 1); return true; }},
      {key: "F12", run: (view) => { onJump?.("reference", view.state.selection.main.head); return true; }},
      ...defaultKeymap,
      ...historyKeymap,
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...foldKeymap,
      ...searchKeymap,
      {key: "Tab", run: (view) => {
        if (!completions.enabled) return false;
        if (acceptCompletion(view)) return true;
        const head = view.state.selection.main.head;
        const previous = head > 0 ? view.state.sliceDoc(head - 1, head) : "";
        return /[A-Za-z0-9_.]/.test(previous) ? startCompletion(view) : false;
      }},
      indentWithTab,
      {key: "Mod-f", run: openSearchPanel}
    ])
  ];
  if (helpHover) {
    extensions.push(helpHover,
      EditorView.contentAttributes.of({"aria-keyshortcuts": "F1"}));
  }
  extensions.push(EditorView.domEventHandlers({
    blur() { cancelKeyboardHover(); return false; },
    mousedown(event, view) {
      cancelKeyboardHover();
      if (!event.metaKey && !event.ctrlKey) return false;
      const pos = view.posAtCoords({x: event.clientX, y: event.clientY});
      if (pos == null) return false;
      onJump?.("reference", pos);
      return false;
    }
  }));
  if (keymapName === "vim") extensions.unshift(vim());
  extensions.push(EditorView.updateListener.of(update => {
    if (update.docChanged || update.selectionSet) cancelKeyboardHover();
    if (update.docChanged && !suppressChanges) onChange?.(update.state.doc.toString(), update);
    if (!update.docChanged || !signature.enabled || !onSignature) return;
    signatureNode?.remove();
    signatureNode = null;
    const pos = update.state.selection.main.head;
    const trigger = pos > 0 ? update.state.sliceDoc(pos - 1, pos) : "";
    if (trigger !== "(" && trigger !== ",") return;
    const request = ++signature.request;
    Promise.resolve(onSignature(update.view, pos, trigger)).then((value) => {
      if (!signature.enabled || request !== signature.request) return;
      signatureNode = makeSignatureTooltip(value);
      if (!signatureNode) return;
      const editorRect = update.view.dom.getBoundingClientRect();
      const caret = update.view.coordsAtPos(pos);
      signatureNode.style.left = `${Math.max(0, (caret?.left || editorRect.left) - editorRect.left)}px`;
      signatureNode.style.top = `${Math.max(0, (caret?.bottom || editorRect.top) - editorRect.top + 4)}px`;
      update.view.dom.appendChild(signatureNode);
    }).catch(() => {});
  }));
  const view = new EditorView({
    state: EditorState.create({doc, extensions}),
    parent
  });
  const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const refreshTheme = () => {
    const next = darkThemeActive();
    if (next === darkTheme) return;
    darkTheme = next;
    view.dispatch({effects: themeCompartment.reconfigure(editorThemeExtensions(darkTheme))});
  };
  const themeObserver = new MutationObserver(refreshTheme);
  themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
  colorScheme?.addEventListener?.("change", refreshTheme);

  return {
    view,
    setDoc(value: string, options: boolean | {silent?: boolean} = {}) {
      const next = String(value ?? "");
      if (view.state.doc.toString() === next) return;
      suppressChanges = options === true || (typeof options === "object" && Boolean(options?.silent));
      try {
        view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: next}});
      } finally {
        suppressChanges = false;
      }
    },
    getDoc() { return view.state.doc.toString(); },
    focus() { view.focus(); },
    openHelp() { return openKeyboardHelp(view); },
    setDiagnostics(items: readonly EditorDiagnostic[]) {
      diagnostics.current = Array.isArray(items) ? items : [];
      view.dispatch(setDiagnostics(view.state, diagnostics.current));
    },
    setReactiveRefs(ranges: readonly EditorReference[]) {
      view.dispatch({effects: reactiveEffect.of(toDecorations(ranges))});
    },
    setCompletionSource(source: CompletionSource | null) {
      completionSource.current = source || null;
      if (!completionSource.current) closeCompletion(view);
    },
    setCompletionsEnabled(enabled: boolean) {
      const next = enabled !== false;
      if (completions.enabled === next) return;
      completions.enabled = next;
      if (!next) closeCompletion(view);
    },
    setSignatureHelpEnabled(enabled: boolean) {
      const next = enabled !== false;
      if (signature.enabled === next) return;
      signature.enabled = next;
      signature.request += 1;
      if (!signature.enabled) {
        signatureNode?.remove();
        signatureNode = null;
      }
    },
    completionStatus() { return completionStatus(view.state); },
    closeCompletion() { closeCompletion(view); },
    destroy() {
      cancelKeyboardHover();
      themeObserver.disconnect();
      colorScheme?.removeEventListener?.("change", refreshTheme);
      signatureNode?.remove();
      view.destroy();
    }
  } satisfies EditorHandle;
}

if (typeof window !== "undefined") window.AlderEditor = {createEditor};
