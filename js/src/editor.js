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
  hoverTooltip
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment
} from "@codemirror/commands";
import {indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage} from "@codemirror/language";
import {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap} from "@codemirror/autocomplete";
import {searchKeymap, highlightSelectionMatches, openSearchPanel} from "@codemirror/search";
import {linter, setDiagnostics} from "@codemirror/lint";
import {r} from "@codemirror/legacy-modes/mode/r";
import {sql} from "@codemirror/legacy-modes/mode/sql";
import {vim} from "@replit/codemirror-vim";

const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const completionCompartment = new Compartment();
const reactiveEffect = StateEffect.define();
const reactiveField = StateField.define({
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

function languageFor(name) {
  if (name === "sql") return StreamLanguage.define(sql);
  return StreamLanguage.define(r);
}

function toDecorations(ranges) {
  const marks = [];
  for (const item of Array.isArray(ranges) ? ranges : []) {
    const from = Number.isFinite(item.from) ? item.from : null;
    const to = Number.isFinite(item.to) ? item.to : from;
    if (from !== null && to >= from) marks.push(Decoration.mark({class: "cm-reactive-ref"}).range(from, to));
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
  onRunAll,
  onSave,
  onFormat,
  onJump,
  onHover
} = {}) {
  const completionSource = {current: null};
  const diagnostics = {current: []};
  let suppressChanges = false;
  const extensions = [
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    drawSelection(),
    highlightSpecialChars(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    history(),
    closeBrackets(),
    indentOnInput(),
    reactiveField,
    languageCompartment.of(languageFor(language)),
    readOnlyCompartment.of(EditorState.readOnly.of(Boolean(readOnly))),
    completionCompartment.of(autocompletion()),
    linter(() => diagnostics.current, {delay: 600}),
    keymap.of([
      {key: "Mod-Enter", run: () => { onRun?.(); return true; }},
      {key: "Shift-Enter", run: () => { onRun?.(true); return true; }},
      {key: "Mod-s", run: () => { onSave?.(); return true; }},
      {key: "Mod-Shift-f", run: () => { onFormat?.(); return true; }},
      {key: "Mod-Alt-f", run: () => { onFormat?.(); return true; }},
      {key: "Mod-/", run: toggleComment},
      {key: "Alt-ArrowUp", run: () => { onJump?.("move", -1); return true; }},
      {key: "Alt-ArrowDown", run: () => { onJump?.("move", 1); return true; }},
      ...defaultKeymap,
      ...historyKeymap,
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...foldKeymap,
      ...searchKeymap,
      indentWithTab,
      {key: "Mod-f", run: openSearchPanel}
    ])
  ];
  if (onHover) {
    extensions.push(hoverTooltip((view, pos) => {
      const pending = onHover(view, pos);
      return Promise.resolve(pending).then((value) => {
        if (!value) return null;
        const text = typeof value === "string" ? value : String(value.text ?? "");
        if (!text) return null;
        return {
          pos,
          end: pos,
          above: true,
          create() {
            const dom = document.createElement("pre");
            dom.className = "cm-alder-hover";
            dom.textContent = text;
            return {dom};
          }
        };
      });
    }));
  }
  extensions.push(EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.metaKey && !event.ctrlKey) return false;
      const pos = view.posAtCoords({x: event.clientX, y: event.clientY});
      if (pos == null) return false;
      onJump?.("reference", pos);
      return false;
    }
  }));
  if (keymapName === "vim") extensions.unshift(vim());
  extensions.push(EditorView.updateListener.of(update => {
    if (update.docChanged && !suppressChanges) onChange?.(update.state.doc.toString(), update);
  }));
  const view = new EditorView({
    state: EditorState.create({doc, extensions}),
    parent
  });

  return {
    view,
    setDoc(value, options = {}) {
      const next = String(value ?? "");
      if (view.state.doc.toString() === next) return;
      suppressChanges = options === true || Boolean(options?.silent);
      try {
        view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: next}});
      } finally {
        suppressChanges = false;
      }
    },
    getDoc() { return view.state.doc.toString(); },
    focus() { view.focus(); },
    setDiagnostics(items) {
      diagnostics.current = Array.isArray(items) ? items : [];
      view.dispatch(setDiagnostics(view.state, diagnostics.current));
    },
    setReactiveRefs(ranges) {
      view.dispatch({effects: reactiveEffect.of(toDecorations(ranges))});
    },
    setCompletionSource(source) {
      completionSource.current = source || null;
      view.dispatch({effects: completionCompartment.reconfigure(
        completionSource.current ? autocompletion({override: [completionSource.current]}) : autocompletion()
      )});
    },
    destroy() { view.destroy(); }
  };
}

if (typeof window !== "undefined") window.AlderEditor = {createEditor};
