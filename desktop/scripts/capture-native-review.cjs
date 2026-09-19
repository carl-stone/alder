const { app, BrowserWindow, Menu, dialog, nativeTheme } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');

const outputDirectory = resolve(process.argv[2] || '/tmp/alder-ui-review-checkpoint2-corrected/native');
app.whenReady().then(async () => {
  await mkdir(outputDirectory, { recursive: true });
  const window = new BrowserWindow({ width: 980, height: 720, minWidth: 720, minHeight: 600, show: false,
    title: 'methylation-analysis.R — Alder', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const menu = Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Open…', accelerator: 'CmdOrCtrl+O' }, { label: 'Save', accelerator: 'CmdOrCtrl+S' }, { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S' }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    { label: 'Run', submenu: [{ label: 'Run Cell', accelerator: 'Shift+Enter' }, { label: 'Run All', accelerator: 'CmdOrCtrl+Shift+Enter' }, { label: 'Interrupt', accelerator: 'Escape' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]);
  Menu.setApplicationMenu(menu);
  const representedFilename = join(outputDirectory, 'methylation-analysis.R');
  window.setRepresentedFilename(representedFilename);
  window.setDocumentEdited(true);
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta name="color-scheme" content="light dark"><style>body{margin:0;padding:48px;font:15px -apple-system;background:#f5f6f8;color:#20242a}main{max-width:720px;margin:auto;border:1px solid #d9dde3;border-radius:12px;background:white;padding:24px}code{font-family:ui-monospace}</style><main><h1>Alder native shell check</h1><p>The real hidden BrowserWindow owns conventional macOS title, edited-document, menu and dialog APIs.</p><code>methylation-analysis.R</code></main>'));
  const image = await window.capturePage();
  await writeFile(join(outputDirectory, 'native-hidden-content.png'), image.toPNG());
  const [width, height] = window.getSize();
  const [minimumWidth, minimumHeight] = window.getMinimumSize();
  const evidence = {
    runtime: process.versions.electron,
    platform: process.platform,
    title: window.getTitle(),
    representedFilename: window.getRepresentedFilename(),
    documentEdited: window.isDocumentEdited(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    size: { width, height },
    minimumSize: { width: minimumWidth, height: minimumHeight },
    nativeTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    menus: menu.items.map(item => ({ label: item.label, entries: item.submenu?.items.map(entry => ({ label: entry.label, role: entry.role, accelerator: entry.accelerator?.toString() })) })),
    nativeDialogApi: typeof dialog.showMessageBox === 'function',
    dialogVisualEvidence: 'deferred because macOS native sheets cannot be captured without showing and activating their parent window',
    capture: join(outputDirectory, 'native-hidden-content.png'),
  };
  if (evidence.visible || evidence.focused || !evidence.documentEdited || evidence.minimumSize.width !== 720 || evidence.minimumSize.height !== 600 || !evidence.nativeDialogApi) throw new Error('native hidden-window evidence failed: ' + JSON.stringify(evidence));
  await writeFile(join(outputDirectory, 'native-window-state.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
