import { app, dialog } from "electron";
import { startPackagedElectronMain } from "./main.js";

void startPackagedElectronMain(process.argv.slice(1)).catch(async error => {
  await app.whenReady();
  dialog.showErrorBox("Alder could not start", error instanceof Error ? error.message : String(error));
  app.quit();
});
