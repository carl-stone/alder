/** Fixed channels for the context-isolated desktop bridge. */
export const IPC_CHANNELS = Object.freeze({
  recovery: "alderDesktop:recovery",
  openNotebook: "alderDesktop:openNotebook",
  restartHost: "alderDesktop:restartHost",
  chooseSavePath: "alderDesktop:chooseSavePath",
  chooseRscript: "alderDesktop:chooseRscript",
  getDraftId: "alderDesktop:getDraftId",
  rendererReady: "alderDesktop:rendererReady",
  diagnostic: "alderDesktop:diagnostic",
  windowState: "alderDesktop:windowState",
  commandResult: "alderDesktop:commandResult",
  desktopCommand: "alderDesktop:desktopCommand",
} as const);
