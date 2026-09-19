import { app, BrowserWindow, dialog, Menu, nativeTheme } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { WindowState } from "../../host/src/protocol.js";
import {
  ALDER_APP_NAME,
  applyNativeWindowState,
  assertNativeDialogRuntime,
  installNativeMenu,
  nativeWindowOptions,
} from "../src/native-shell.mts";

const outputDirectory = resolve(process.argv[2] || "/tmp/alder-ui-review-checkpoint2-corrected/native");

void app.whenReady().then(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  assertNativeDialogRuntime(dialog);
  app.setName(ALDER_APP_NAME);

  const menu = installNativeMenu(Menu, {
    newNotebook: () => undefined,
    openNotebook: () => undefined,
    openNotebookInNewWindow: () => undefined,
    openRecent: () => undefined,
    dispatch: () => undefined,
    closeWindow: () => undefined,
  }, []);
  const preloadPath = resolve("desktop/.vite/build/preload.cjs");
  const window = new BrowserWindow(nativeWindowOptions(preloadPath, "alder-native-review"));
  const representedFilename = join(outputDirectory, "methylation-analysis.R");
  await writeFile(representedFilename, "# Native shell evidence fixture\n");
  const rendererState: WindowState = {
    path: representedFilename,
    dirty: true,
    saveState: "edited",
    sessionEpoch: "native-review-epoch",
  };
  await window.loadURL("data:text/html;charset=utf-8,<title>Alder native state</title>");
  applyNativeWindowState(window, rendererState);

  const menuItems = (value: Electron.Menu): unknown[] => value.items.map(item => ({
    label: item.label,
    role: item.role || undefined,
    accelerator: item.accelerator?.toString(),
    submenu: item.submenu ? menuItems(item.submenu) : undefined,
  }));
  const [width, height] = window.getSize();
  const [minimumWidth, minimumHeight] = window.getMinimumSize();
  const evidence = {
    source: "production native-shell.mts construction used by ElectronMain",
    runtime: process.versions.electron,
    platform: process.platform,
    rendererState,
    title: window.getTitle(),
    representedFilename: window.getRepresentedFilename(),
    documentEdited: window.isDocumentEdited(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    size: { width, height },
    minimumSize: { width: minimumWidth, height: minimumHeight },
    nativeTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    menus: menuItems(menu!),
    nativeDialogs: {
      open: typeof dialog.showOpenDialog === "function",
      save: typeof dialog.showSaveDialog === "function",
      message: typeof dialog.showMessageBox === "function",
    },
    visualEvidence: null,
    visualEvidenceReason: "A hidden, unfocused BrowserWindow cannot capture macOS titlebar, application menu, or native sheets. This file records production native state and menu construction directly.",
  };
  const run = (evidence.menus as Array<any>).find(item => item.label === "Run")?.submenu ?? [];
  const shortcut = (label: string) => run.find((item: any) => item.label === label)?.accelerator;
  if (evidence.visible || evidence.focused || !evidence.documentEdited ||
      evidence.minimumSize.width !== 720 || evidence.minimumSize.height !== 600 ||
      shortcut("Run Cell") !== "CmdOrCtrl+Enter" || shortcut("Interrupt R") !== "CmdOrCtrl+." ||
      !Object.values(evidence.nativeDialogs).every(Boolean)) {
    throw new Error("production native evidence failed: " + JSON.stringify(evidence));
  }
  await writeFile(join(outputDirectory, "native-window-state.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
