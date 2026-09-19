import { app, dialog } from "electron";
import { startPackagedElectronMain } from "./main.js";

void startPackagedElectronMain(process.argv.slice(1)).catch(async error => {
  await app.whenReady();
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.ALDER_ACCEPTANCE_HIDDEN === "1") process.stderr.write(`Alder could not start: ${message}\n`);
  else dialog.showErrorBox("Alder could not start", message);
  app.quit();
});
