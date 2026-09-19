import { app, dialog } from "electron";
import { join } from "node:path";
import { startPackagedElectronMain } from "./main.js";
import { StructuredDiagnostics, drainDiagnosticsBounded, persistEmergencyDiagnostic } from "../../host/src/diagnostics.js";

let handlingFatal = false;
let diagnostics: StructuredDiagnostics | undefined;

async function fatal(event: "desktop.fatal" | "desktop.uncaught_exception" | "desktop.unhandled_rejection", error: unknown): Promise<void> {
  if (handlingFatal) process.exit(1);
  handlingFatal = true;
  try {
    const diagnosticsRoot = join(app.getPath("userData"), "diagnostics");
    diagnostics ??= new StructuredDiagnostics({
      rootDir: diagnosticsRoot, role: "desktop", component: "desktop",
      appLaunchId: process.env.ALDER_APP_LAUNCH_ID, appVersion: app.getVersion(),
      buildId: process.env.ALDER_BUILD_ID ?? app.getVersion(),
    });
    const fields = {
      outcome: "error", errorCode: (error as NodeJS.ErrnoException)?.code ?? (event === "desktop.fatal" ? "desktop_start_failed" : event === "desktop.unhandled_rejection" ? "unhandled_rejection" : "uncaught_exception"),
      errorType: error instanceof Error ? error.name : "other",
    } as const;
    const emergency = await persistEmergencyDiagnostic({ rootDir: diagnosticsRoot, role: "desktop", component: "desktop", event, fields })
      .then(() => true, () => false);
    if (!emergency) diagnostics.record("error", event, fields);
    await drainDiagnosticsBounded(diagnostics, 250);
    dialog.showErrorBox("Alder could not continue", "Alder stopped unexpectedly. Local diagnostics were retained when possible.");
  } catch {
    try { process.stderr.write("Alder desktop failed before diagnostics could be retained.\n"); } catch {}
  }
  app.exit(1);
}

process.once("uncaughtException", error => { void fatal("desktop.uncaught_exception", error); });
process.once("unhandledRejection", reason => { void fatal("desktop.unhandled_rejection", reason); });
void startPackagedElectronMain(process.argv.slice(1)).catch(error => fatal("desktop.fatal", error));
