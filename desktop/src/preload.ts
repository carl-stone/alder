import { contextBridge, ipcRenderer } from "electron";
import {
  desktopRecoveryRequestSchema,
  desktopDiagnosticSchema,
  desktopCommandResultSchema,
  desktopCommandSchema,
  windowStateSchema,
  type PreloadApi,
  type DesktopCommand,
  type SaveDestination,
  saveAsCommandSchema,
} from "../../host/src/protocol.js";
import { IPC_CHANNELS } from "./ipc.js";

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
    recovery: request => ipc.invoke(IPC_CHANNELS.recovery, desktopRecoveryRequestSchema.parse(request)),
    onRecoveryChanged: callback => {
      if (typeof callback !== "function") throw new TypeError("onRecoveryChanged callback must be a function");
      const listener = (): void => callback();
      ipc.on(IPC_CHANNELS.recoveryChanged, listener);
      return (): void => ipc.removeListener(IPC_CHANNELS.recoveryChanged, listener);
    },
    openNotebook: async (): Promise<void> => {
      validateVoid(await ipc.invoke(IPC_CHANNELS.openNotebook), "openNotebook");
    },
    restartHost: async (): Promise<void> => {
      validateVoid(await ipc.invoke(IPC_CHANNELS.restartHost), "restartHost");
    },
    chooseSavePath: async (): Promise<SaveDestination | null> => {
      const value = await ipc.invoke(IPC_CHANNELS.chooseSavePath);
      if (value === null) return null;
      const candidate = value as SaveDestination;
      const path = validateSelectedPath(candidate.path, "chooseSavePath");
      if (path === null) throw new Error("Save destination is missing");
      const expectedDestination = saveAsCommandSchema.shape.expectedDestination.parse(candidate.expectedDestination);
      return { path, expectedDestination };
    },
    chooseRscript: async (): Promise<string | null> =>
      validateSelectedPath(await ipc.invoke(IPC_CHANNELS.chooseRscript), "chooseRscript"),
    getDraftId: async (): Promise<string> => {
      const value = await ipc.invoke(IPC_CHANNELS.getDraftId);
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid draft identity");
      return value;
    },
    rendererReady: async (): Promise<void> => {
      validateVoid(await ipc.invoke(IPC_CHANNELS.rendererReady), "rendererReady");
    },
    reportDiagnostic: async (event): Promise<void> => {
      validateVoid(await ipc.invoke(IPC_CHANNELS.diagnostic, desktopDiagnosticSchema.parse(event)), "reportDiagnostic");
    },
    updateWindowState: async (state): Promise<void> => {
      validateVoid(await ipc.invoke(IPC_CHANNELS.windowState, windowStateSchema.parse(state)), "updateWindowState");
    },
    completeDesktopCommand: async (result): Promise<void> => {
      validateVoid(await ipc.invoke(IPC_CHANNELS.commandResult, desktopCommandResultSchema.parse(result)), "completeDesktopCommand");
    },
    onDesktopCommand: (callback: (command: DesktopCommand) => void): (() => void) => {
      if (typeof callback !== "function") throw new TypeError("onDesktopCommand callback must be a function");
      let subscribed = true;
      const listener = (_event: unknown, value: unknown): void => {
        if (!subscribed) return;
        const parsed = desktopCommandSchema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipc.on(IPC_CHANNELS.desktopCommand, listener);
      return (): void => {
        if (!subscribed) return;
        subscribed = false;
        ipc.removeListener(IPC_CHANNELS.desktopCommand, listener);
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
