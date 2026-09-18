import { contextBridge, ipcRenderer } from "electron";
import {
  desktopRecoveryRequestSchema,
  windowActionMessageSchema,
  windowStateSchema,
  type PreloadApi,
  type WindowAction,
  type WindowState,
  type SaveDestination,
  saveAsCommandSchema,
} from "../../host/src/protocol.js";

/** Private, fixed IPC channels. They are deliberately not exposed to the page. */
export const ELECTRON_IPC_CHANNELS = Object.freeze({
  recovery: "alderDesktop:recovery",
  openNotebook: "alderDesktop:openNotebook",
  chooseSavePath: "alderDesktop:chooseSavePath",
  chooseRscript: "alderDesktop:chooseRscript",
  getWindowState: "alderDesktop:getWindowState",
  hostShutdown: "alderDesktop:hostShutdown",
  saveCancelled: "alderDesktop:saveCancelled",
  rendererReady: "alderDesktop:rendererReady",
  windowAction: "alderDesktop:windowAction",
} as const);

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void;
}

interface ContextBridgeLike {
  exposeInMainWorld(name: string, api: PreloadApi): void;
}

const MAX_PATH_BYTES = 32 * 1024;

function validateSelectedPath(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} returned an invalid path`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES) {
    throw new Error(`${label} returned an overlong path`);
  }
  return value;
}

function validateVoid(value: unknown, label: string): void {
  if (value !== undefined) throw new Error(`${label} returned an invalid response`);
}

/**
 * Build the only object that may cross the context-isolation boundary.
 * The renderer cannot provide filesystem paths, commands, credentials, or arbitrary IPC
 * channel names; native dialogs and actions are selected by the main process.
 */
export function createPreloadApi(ipc: IpcRendererLike): PreloadApi {
  const api: PreloadApi = {
    recovery: request => ipc.invoke(ELECTRON_IPC_CHANNELS.recovery, desktopRecoveryRequestSchema.parse(request)),
    openNotebook: async (): Promise<void> => {
      validateVoid(await ipc.invoke(ELECTRON_IPC_CHANNELS.openNotebook), "openNotebook");
    },
    chooseSavePath: async (): Promise<SaveDestination | null> => {
      const value = await ipc.invoke(ELECTRON_IPC_CHANNELS.chooseSavePath);
      if (value === null) return null;
      const candidate = value as SaveDestination;
      const path = validateSelectedPath(candidate.path, "chooseSavePath");
      if (path === null) throw new Error("Save destination is missing");
      const expectedDestination = saveAsCommandSchema.shape.expectedDestination.parse(candidate.expectedDestination);
      return { path, expectedDestination };
    },
    chooseRscript: async (): Promise<string | null> =>
      validateSelectedPath(await ipc.invoke(ELECTRON_IPC_CHANNELS.chooseRscript), "chooseRscript"),
    getWindowState: async (): Promise<WindowState> =>
      windowStateSchema.parse(await ipc.invoke(ELECTRON_IPC_CHANNELS.getWindowState)),
    hostShutdown: async (): Promise<void> => {
      validateVoid(await ipc.invoke(ELECTRON_IPC_CHANNELS.hostShutdown), "hostShutdown");
    },
    saveCancelled: async (): Promise<void> => {
      validateVoid(await ipc.invoke(ELECTRON_IPC_CHANNELS.saveCancelled), "saveCancelled");
    },
    rendererReady: async (): Promise<void> => {
      validateVoid(await ipc.invoke(ELECTRON_IPC_CHANNELS.rendererReady), "rendererReady");
    },
    onWindowAction: (callback: (action: WindowAction) => void): (() => void) => {
      if (typeof callback !== "function") throw new TypeError("onWindowAction callback must be a function");
      let subscribed = true;
      const listener = (_event: unknown, value: unknown): void => {
        if (!subscribed) return;
        const parsed = windowActionMessageSchema.safeParse(value);
        if (parsed.success) callback(parsed.data.action);
      };
      ipc.on(ELECTRON_IPC_CHANNELS.windowAction, listener);
      return (): void => {
        if (!subscribed) return;
        subscribed = false;
        ipc.removeListener(ELECTRON_IPC_CHANNELS.windowAction, listener);
      };
    },
  };
  return Object.freeze(api);
}

export function installPreloadBridge(
  bridge: ContextBridgeLike,
  ipc: IpcRendererLike,
): PreloadApi {
  const api = createPreloadApi(ipc);
  bridge.exposeInMainWorld("alderDesktop", api);
  return api;
}

// Forge executes this module as the sandboxed preload. Keeping the guard makes
// the contract independently testable under Node without importing Electron's
// main-process runtime.
if (typeof process !== "undefined" && process.versions?.electron) {
  installPreloadBridge(contextBridge, ipcRenderer);
}
