async function launch(): Promise<void> {
  if (process.env.ALDER_DESKTOP_RUNTIME_PROBE === "1" ||
      process.argv.includes("--alder-runtime-probe")) {
    process.stdout.write(JSON.stringify(process.versions));
    process.exit(0);
  }

  // The runtime probe must complete before loading application modules, which require the staged manifest.
  const { startPackagedElectronMain } = await import("./main.js");
  await startPackagedElectronMain(process.argv.slice(1));
}

void launch().catch(error => {
  const message = error instanceof Error ? error.message : "Electron startup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  const { app } = require("electron") as { app: { quit(): void } };
  app.quit();
});
