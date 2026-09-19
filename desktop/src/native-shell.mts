import { basename } from "node:path";

import type { WindowAction, WindowState } from "../../host/src/protocol.js";

export const ALDER_APP_NAME = "Alder";

export interface NativeWindowTarget {
  setTitle?(title: string): void;
  setDocumentEdited?(edited: boolean): void;
  setRepresentedFilename?(path: string): void;
}

export interface NativeMenuRuntime<MenuValue = unknown> {
  buildFromTemplate(template: any[]): MenuValue;
  setApplicationMenu(menu: MenuValue): void;
}

export interface NativeDialogRuntime {
  showOpenDialog(...args: unknown[]): Promise<unknown>;
  showSaveDialog(...args: unknown[]): Promise<unknown>;
  showMessageBox(...args: unknown[]): Promise<unknown>;
}

export interface NativeMenuCallbacks {
  newNotebook(): void;
  openNotebook(): void;
  openNotebookInNewWindow(): void;
  openRecent(path: string): void;
  dispatch(action: WindowAction): void;
  closeWindow(): void;
}

export function nativeWindowOptions(preloadPath: string, partition: string): Record<string, unknown> {
  return {
    width: 1440,
    height: 960,
    minWidth: 720,
    minHeight: 600,
    show: false,
    title: ALDER_APP_NAME,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      partition,
      sandbox: true,
      webSecurity: true,
    },
  };
}

export function assertNativeDialogRuntime(runtime: NativeDialogRuntime): void {
  for (const name of ["showOpenDialog", "showSaveDialog", "showMessageBox"] as const) {
    if (typeof runtime[name] !== "function") throw new Error(`Electron dialog.${name} is unavailable`);
  }
}

export function applyNativeWindowState(window: NativeWindowTarget, state: Pick<WindowState, "path" | "dirty">): void {
  window.setDocumentEdited?.(state.dirty);
  if (state.path) window.setRepresentedFilename?.(state.path);
  window.setTitle?.(`${state.path ? basename(state.path) : "Untitled"}${state.dirty ? " — Edited" : ""} — ${ALDER_APP_NAME}`);
}

export function nativeMenuTemplate(callbacks: NativeMenuCallbacks, recentPaths: readonly string[]): Record<string, unknown>[] {
  const action = (name: WindowAction) => (): void => callbacks.dispatch(name);
  const fileSubmenu: Record<string, unknown>[] = [
    { label: "New Notebook", accelerator: "CmdOrCtrl+N", click: callbacks.newNotebook },
    { label: "Open…", accelerator: "CmdOrCtrl+O", click: callbacks.openNotebook },
    { label: "New Window for Notebook…", accelerator: "CmdOrCtrl+Alt+O", click: callbacks.openNotebookInNewWindow },
    { label: "Recent", submenu: recentPaths.length === 0 ? [{ label: "No recent notebooks", enabled: false }] : recentPaths.map(path => ({ label: path, click: () => callbacks.openRecent(path) })) },
    { type: "separator" },
    { label: "Save", accelerator: "CmdOrCtrl+S", click: action("save") },
    { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: action("save-as") },
    { label: "Format Notebook", click: action("format") },
    { label: "Packages…", click: action("packages") },
    { label: "Publish HTML…", click: action("publish") },
    { type: "separator" },
    { label: "Close", role: "close", click: callbacks.closeWindow },
  ];
  const runSubmenu: Record<string, unknown>[] = [
    { label: "Run Cell", accelerator: "CmdOrCtrl+Enter", click: action("run-cell") },
    { label: "Run and Advance", accelerator: "Shift+Enter", click: action("run-and-advance") },
    { label: "Run All", accelerator: "CmdOrCtrl+Shift+Enter", click: action("run-all") },
    { label: "Run Outdated Cells", click: action("run-stale") },
    { label: "Interrupt R", accelerator: "CmdOrCtrl+.", click: action("interrupt") },
    { label: "Restart R", click: action("restart") },
  ];
  const settingsSubmenu: Record<string, unknown>[] = [
    { role: "about" },
    { type: "separator" },
    { label: "Settings…", accelerator: "CmdOrCtrl+,", click: action("settings") },
    { label: "Choose R…", click: action("select-r") },
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
  ];
  return [
    { label: ALDER_APP_NAME, submenu: [...settingsSubmenu, { type: "separator" }, { role: "quit" }] },
    { label: "File", submenu: fileSubmenu },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
    { label: "View", submenu: [
      { label: "Toggle Notebook Sidebar", accelerator: "CmdOrCtrl+Alt+S", click: action("toggle-notebook") },
      { label: "Preview", accelerator: "CmdOrCtrl+Shift+P", click: action("preview") },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { label: "Run", submenu: runSubmenu },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
    { label: "Help", submenu: [
      { label: "Keyboard Shortcuts", click: action("shortcuts") },
      { label: "R Documentation", accelerator: "F1", click: action("r-documentation") },
    ] },
  ];
}

export function installNativeMenu<MenuValue>(runtime: NativeMenuRuntime<MenuValue>, callbacks: NativeMenuCallbacks, recentPaths: readonly string[]): MenuValue {
  const menu = runtime.buildFromTemplate(nativeMenuTemplate(callbacks, recentPaths));
  runtime.setApplicationMenu(menu);
  return menu;
}
