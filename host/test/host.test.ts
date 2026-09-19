import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { startHost } from "../src/application.js";
import { resolveApplicationResources } from "../src/resources.js";
import { widgetOutputSchema, type CommandResult, type HostCommand } from "../src/protocol.js";

type RunningHost = Awaited<ReturnType<typeof startHost>>;
const APPLICATION_ROOT = process.env.ALDER_APPLICATION_ROOT;
let stagedResources: Awaited<ReturnType<typeof resolveApplicationResources>> | undefined;

async function startInstalledHost(path: string, options: { executionMode?: "automatic" | "lazy"; runOnStartup?: boolean; idleTimeout?: number } = {}): Promise<RunningHost> {
  if (!APPLICATION_ROOT) throw new Error("ALDER_APPLICATION_ROOT is required for installed host tests");
  stagedResources ??= await resolveApplicationResources(APPLICATION_ROOT);
  const app = await startHost({
    path,
    port: 0,
    runOnStartup: options.runOnStartup ?? false,
    executionMode: options.executionMode,
    idleTimeout: options.idleTimeout,
    rscript: process.env.ALDER_RSCRIPT ?? execFileSync("which", ["Rscript"], { encoding: "utf8" }).trim(),
    resources: stagedResources,
    preferencesPath: join(dirname(path), ".test-preferences.yaml"),
  });
  const deadline = performance.now() + 45_000;
  while (!app.controller.snapshot().runtime.executionReady && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!app.controller.snapshot().runtime.executionReady) {
    const runtime = app.controller.snapshot().runtime;
    await app.close();
    throw new Error(`installed host runtime did not become ready: ${JSON.stringify(runtime)}`);
  }
  return app;
}

function hostCommand(app: RunningHost, value: Record<string, unknown>): HostCommand {
  const snapshot = app.controller.snapshot();
  const type = String(value.type);
  const needsRevision = ["transaction", "run", "publish", "save", "save-as", "reload-source", "format", "set-app", "set-config", "set-layout", "set-runtime", "packages-declare", "packages-install"].includes(type);
  return {
    ...value,
    requestId: typeof value.requestId === "string" ? value.requestId : randomUUID(),
    clientId: typeof value.clientId === "string" ? value.clientId : "host-tests",
    sessionEpoch: snapshot.epoch,
    ...(needsRevision && value.expectedDocumentRevision === undefined ? { expectedDocumentRevision: snapshot.documentRevision } : {}),
    ...(type === "set-config" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.config.version } : {}),
    ...(type === "set-layout" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.layout.version } : {}),
    ...(type === "packages-declare" && value.expectedSidecarVersion === undefined ? { expectedSidecarVersion: snapshot.sidecars.packages.version } : {}),
    ...(type === "packages-install" && value.kernelEpoch === undefined ? { kernelEpoch: snapshot.runtime.kernelEpoch } : {}),
  } as HostCommand;
}

async function dispatchHost(app: RunningHost, value: Record<string, unknown>) {
  return app.controller.dispatch(hostCommand(app, value));
}

type HttpSession = { origin: string; cookie: string; csrf: string; leaseId: string };

async function localPackageRepository(root: string, packageName: string): Promise<string> {
  const repository = join(root, "repository");
  const contributionDirectory = join(repository, "src", "contrib");
  const sourceParent = join(root, "package-source");
  const sourceDirectory = join(sourceParent, packageName);
  const dependencyName = "jsonlite";
  const dependencyDirectory = join(sourceParent, dependencyName);
  await mkdir(join(sourceDirectory, "R"), { recursive: true });
  await mkdir(join(dependencyDirectory, "R"), { recursive: true });
  await mkdir(contributionDirectory, { recursive: true });
  await writeFile(join(sourceDirectory, "DESCRIPTION"), [
    `Package: ${packageName}`,
    "Type: Package",
    "Title: Alder Offline Package Fixture",
    "Version: 1.0.0",
    "Authors@R: person('Alder', 'Tester', email='alder@example.invalid', role=c('aut','cre'))",
    "Description: Local package used by the project package acceptance journey.",
    "License: MIT",
    "Encoding: UTF-8",
    `Imports: ${dependencyName} (>= 999.0.0)`,
    "",
  ].join("\n"));
  await writeFile(join(sourceDirectory, "NAMESPACE"), "export(fixture_value)\n");
  await writeFile(join(sourceDirectory, "R", "fixture-value.R"),
    `fixture_value <- function() ${dependencyName}::fixture_dependency_value()\n`);
  await writeFile(join(dependencyDirectory, "DESCRIPTION"), [
    `Package: ${dependencyName}`,
    "Type: Package",
    "Title: Alder Project Dependency Fixture",
    "Version: 999.0.0",
    "Authors@R: person('Alder', 'Tester', email='alder@example.invalid', role=c('aut','cre'))",
    "Description: Confirms project dependencies are installed into the project library.",
    "License: MIT",
    "Encoding: UTF-8",
    "",
  ].join("\n"));
  await writeFile(join(dependencyDirectory, "NAMESPACE"), "export(fixture_dependency_value)\n");
  await writeFile(join(dependencyDirectory, "R", "fixture-dependency-value.R"),
    "fixture_dependency_value <- function() 'project-package-value'\n");
  execFileSync(process.env.R_BIN ?? "R", ["CMD", "build", "--no-manual", dependencyName], { cwd: sourceParent });
  execFileSync(process.env.R_BIN ?? "R", ["CMD", "build", "--no-manual", packageName], { cwd: sourceParent });
  await rename(join(sourceParent, `${dependencyName}_999.0.0.tar.gz`), join(contributionDirectory, `${dependencyName}_999.0.0.tar.gz`));
  await rename(join(sourceParent, `${packageName}_1.0.0.tar.gz`), join(contributionDirectory, `${packageName}_1.0.0.tar.gz`));
  execFileSync(process.env.RSCRIPT ?? "Rscript", ["--vanilla", "-e", "tools::write_PACKAGES(commandArgs(TRUE)[[1L]], type='source')", contributionDirectory]);
  const repositoryUrl = pathToFileURL(repository).href;
  const binaryContribution = execFileSync(process.env.RSCRIPT ?? "Rscript", ["--vanilla", "-e",
    "cat(sub('^file://', '', contrib.url(commandArgs(TRUE)[[1L]], type='binary')))", repositoryUrl], { encoding: "utf8" });
  await mkdir(binaryContribution, { recursive: true });
  await writeFile(join(binaryContribution, "PACKAGES"), "");
  return repository;
}

async function installFixturePackage(
  root: string,
  library: string,
  packageName: string,
  version: string,
  value: string,
): Promise<void> {
  const source = join(root, `${packageName}-${version}`);
  await mkdir(join(source, "R"), { recursive: true });
  await mkdir(library, { recursive: true });
  await writeFile(join(source, "DESCRIPTION"), [
    `Package: ${packageName}`,
    "Type: Package",
    "Title: Alder Library Precedence Fixture",
    `Version: ${version}`,
    "Authors@R: person('Alder', 'Tester', email='alder@example.invalid', role=c('aut','cre'))",
    "Description: Verifies ordinary project startup and package precedence.",
    "License: MIT",
    "Encoding: UTF-8",
    "",
  ].join("\n"));
  await writeFile(join(source, "NAMESPACE"), "export(fixture_value)\n");
  await writeFile(join(source, "R", "fixture-value.R"),
    `fixture_value <- function() ${JSON.stringify(value)}\n`);
  execFileSync(process.env.R_BIN ?? "R", ["CMD", "INSTALL", `--library=${library}`, source]);
}

async function openHttpSession(app: RunningHost): Promise<HttpSession> {
  const origin = app.server.address()!.origin;
  const ticketResponse = await fetch(origin + "/api/ticket", {
    method: "POST",
    headers: { Authorization: "Bearer " + app.ownership.token, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ origin }),
  });
  assert.equal(ticketResponse.ok, true, "host test ticket issuance must succeed");
  const ticketValue = await ticketResponse.json() as { ticket?: unknown };
  assert.equal(typeof ticketValue.ticket, "string");
  const sessionResponse = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: ticketValue.ticket }),
  });
  assert.equal(sessionResponse.ok, true, "host test session exchange must succeed");
  const session = await sessionResponse.json() as { leaseId?: unknown; csrf?: unknown };
  assert.equal(typeof session.leaseId, "string");
  assert.equal(typeof session.csrf, "string");
  const setCookie = typeof sessionResponse.headers.getSetCookie === "function"
    ? sessionResponse.headers.getSetCookie()[0]
    : sessionResponse.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  assert.ok(cookie, "host test session exchange must set a cookie");
  return { origin, cookie, csrf: session.csrf as string, leaseId: session.leaseId as string };
}

async function closeHttpSession(session: HttpSession, disposition?: "discard"): Promise<void> {
  const response = await fetch(session.origin + "/api/lease", {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "release", leaseId: session.leaseId, ...(disposition === undefined ? {} : { disposition }) }),
  });
  assert.equal(response.ok, true, "host test lease release must succeed");
}
test("discarding the last lease removes unsaved recovery", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-discard-"));
  const path = join(directory, "notebook.R");
  const original = "# %%\nx <- 1\n";
  await writeFile(path, original);
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path);
    const before = app.controller.snapshot();
    const edit = await dispatchHost(app, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: before.cells[0]!.id }, expectedRevision: before.cells[0]!.revision,
        cellType: "code", body: ["x <- 2"] }],
    });
    assert.equal(edit.error, null);
    assert.equal(app.controller.snapshot().dirty, true);

    session = await openHttpSession(app);
    await closeHttpSession(session, "discard");
    session = undefined;
    await app.closed;
    app = undefined;
    assert.equal(await readFile(path, "utf8"), original);

    app = await startInstalledHost(path);
    assert.equal(app.controller.snapshot().cells[0]!.body[0], "x <- 1");
    assert.equal(app.controller.snapshot().dirty, false);
    const recovery = await app.controller.query({ type: "recovery" });
    assert.equal(recovery.result.candidate, null);
  } finally {
    if (session !== undefined) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function requestSymbols(session: HttpSession): Promise<string> {
  const response = await fetch(session.origin + "/api/lsp", {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "textDocument/documentSymbol", params: {} }),
  });
  const body = await response.text();
  let diagnostic = body;
  try { diagnostic = JSON.stringify(JSON.parse(body)); } catch {}
  assert.equal(response.status, 200, "LSP response " + response.status + ": " + diagnostic);
  return body;
}

async function requestLsp(session: HttpSession, method: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(session.origin + "/api/lsp", {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() };
}

test("editor help synchronizes source only on request or for enabled diagnostics", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-help-idle-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# %%\ninitial_symbol <- function() 1\n");
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path);
    session = await openHttpSession(app);
    assert.match(await requestSymbols(session), /initial_symbol/);

    const before = app.controller.snapshot();
    const edited = await dispatchHost(app, {
      type: "transaction",
      expectedDocumentRevision: before.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: before.cells[0]!.revision,
        cellType: "code", body: ["fresh_symbol <- function() 2"] }],
    });
    assert.equal(edited.error, null);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(await requestSymbols(session), /fresh_symbol/);

    const config = app.controller.snapshot();
    const diagnostics = await dispatchHost(app, {
      type: "set-preferences",
      patch: { editor: { live_diagnostics: true } },
      expectedPreferencesVersion: config.preferencesVersion ?? null,
    });
    assert.equal(diagnostics.error, null);
    const diagnosticBefore = app.controller.snapshot();
    const diagnosticEdit = await dispatchHost(app, {
      type: "transaction",
      expectedDocumentRevision: diagnosticBefore.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: diagnosticBefore.cells[0]!.revision,
        cellType: "code", body: ["diagnostic_symbol <- function() 2"] }],
    });
    assert.equal(diagnosticEdit.error, null);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(await requestSymbols(session), /diagnostic_symbol/);
  } finally {
    if (session !== undefined) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed Ark editor help follows live R values, source edits and kernel restart", {
  skip: !APPLICATION_ROOT, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-help-ark-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# %%\nmy_table <- data.frame(long_column = 1L)\n# %%\nmy_table$lo\n# %%\nmissing_symbol\n");
  let app: RunningHost | undefined;
  let session: HttpSession | undefined;
  try {
    app = await startInstalledHost(path);
    const first = await dispatchHost(app, { type: "run", scope: "cell", target: { cellId: "cell-1" } });
    assert.equal(first.error, null);
    session = await openHttpSession(app);
    const completion = await requestLsp(session, "textDocument/completion", { position: { cell: "cell-2", line: 0, character: 11 } });
    assert.equal(completion.status, 200);
    assert.match(JSON.stringify(completion.body), /long_column/);
    const hover = await requestLsp(session, "textDocument/hover", { position: { cell: "cell-1", line: 0, character: 15 } });
    assert.equal(hover.status, 200);
    assert.match(JSON.stringify(hover.body), /Data Frames/);
    const definition = await requestLsp(session, "textDocument/definition", { position: { cell: "cell-2", line: 0, character: 2 } });
    assert.equal(definition.status, 200);
    assert.match(JSON.stringify(definition.body), /"cell-1"/);

    const preference = await dispatchHost(app, { type: "set-preferences", patch: { editor: { live_diagnostics: true } },
      expectedPreferencesVersion: app.controller.snapshot().preferencesVersion ?? null });
    assert.equal(preference.error, null);
    const deadline = Date.now() + 5_000;
    while (!JSON.stringify(app.controller.snapshot().editorDiagnostics).includes("missing_symbol") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(JSON.stringify(app.controller.snapshot().editorDiagnostics), /missing_symbol/);
    const restart = await dispatchHost(app, { type: "restart", replay: false });
    assert.equal(restart.error, null);
    const afterRestart = await requestLsp(session, "textDocument/definition", { position: { cell: "cell-2", line: 0, character: 2 } });
    assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
    assert.match(JSON.stringify(afterRestart.body), /"cell-1"/);

    const kernelPid = (app.engine as unknown as { kernel?: { processId?: number } }).kernel?.processId;
    assert.ok(kernelPid);
    process.kill(kernelPid, "SIGKILL");
    const failureDeadline = Date.now() + 5_000;
    while (app.controller.snapshot().runtime.kernelState !== "failed" && Date.now() < failureDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(app.controller.snapshot().runtime.kernelState, "failed");
    const unavailable = await requestLsp(session, "textDocument/completion", { position: { cell: "cell-2", line: 0, character: 11 } });
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
    const beforeEdit = app.controller.snapshot();
    const edit = await dispatchHost(app, { type: "transaction", expectedDocumentRevision: beforeEdit.documentRevision,
      changes: [{ type: "edit", cell: { cellId: "cell-3" }, expectedRevision: beforeEdit.cells[2]!.revision,
        cellType: "code", body: ['offline_note <- "saved"'] }] });
    assert.equal(edit.error, null);
    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: app.controller.snapshot().documentRevision });
    assert.equal(save.error, null);
    assert.match(await readFile(path, "utf8"), /offline_note <- "saved"/);
  } finally {
    if (session) await closeHttpSession(session);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clean external reload does not create recovery startup deferral", {
  skip: !APPLICATION_ROOT, timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-clean-reload-"));
  const path = join(directory, "notebook.R");
  let app: RunningHost | undefined;
  let restarted: RunningHost | undefined;
  try {
    await writeFile(path, "# %%\nx <- 1\n");
    app = await startInstalledHost(path, { runOnStartup: true, idleTimeout: 0 });
    const originalDigest = app.controller.snapshot().disk.digest;
    writeFileSync(path, "# %%\nx <- 2\n");
    let observed = app.controller.snapshot();
    const deadline = Date.now() + 5_000;
    while ((observed.disk.digest === originalDigest || observed.disk.digest === null || observed.disk.version === null)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      observed = app.controller.snapshot();
    }
    assert.notEqual(observed.disk.digest, originalDigest);
    assert.notEqual(observed.disk.digest, null);
    assert.notEqual(observed.disk.version, null);

    const result = await dispatchHost(app, {
      type: "reload-source",
      expectedDocumentRevision: observed.documentRevision,
      expectedDiskDigest: observed.disk.digest!,
      expectedDiskVersion: observed.disk.version!,
    });
    assert.equal(result.error, null, JSON.stringify(result));
    const clean = app.controller.snapshot();
    assert.equal(clean.dirty, false);
    assert.equal(clean.runtime.startupActivated, true);
    assert.equal(app.controller.configuration().deferStartup, false);
    const recovery = await app.controller.query({ type: "recovery" });
    assert.equal(recovery.result.candidate, null);

    await app.close();
    app = undefined;
    restarted = await startInstalledHost(path, { runOnStartup: true, idleTimeout: 0 });
    const afterRestart = restarted.controller.snapshot();
    assert.equal(afterRestart.dirty, false);
    assert.equal(afterRestart.runtime.startupActivated, true);
    assert.equal(restarted.controller.configuration().deferStartup, false);
    const restartedRecovery = await restarted.controller.query({ type: "recovery" });
    assert.equal(restartedRecovery.result.candidate, null);
  } finally {
    await app?.close();
    await restarted?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("installed host runs exact edited source, saves bytes and publishes committed results", {
  skip: !APPLICATION_ROOT, timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-integration-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# title\r\n# %%\r\na <- 1\r\na\r\n# %%\r\nb <- a + 1\nb\r\n# %%\r\nc <- b + 1\nc");
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path);
    const controller = app.controller;
    const snapshot = controller.snapshot();
    assert.equal(snapshot.runtime.executionReady, true);
    assert.equal(snapshot.cells.length, 3);
    const run = await dispatchHost(app, {
      type: "run", scope: "all",
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 0,
        cellType: "code", body: [
          "get <- assign <- exists <- library <- source <- 1L",
          "a <- 40",
          "a",
        ] }],
      expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(run.error, null);
    const completed = controller.snapshot();
    assert.equal(completed.cells[0]!.revision, 1);
    assert.deepEqual(completed.cells.map(cell => cell.status), ["done", "done", "done"]);
    assert.match(JSON.stringify(completed.cells[2]!.outputs), /42/);
    const inspected = await dispatchHost(app, {
      type: "inspect", name: "a", kernelEpoch: completed.runtime.kernelEpoch,
    });
    assert.equal(inspected.error, null);
    assert.match(JSON.stringify(inspected.result), /40/);


    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: completed.documentRevision });
    assert.equal(save.error, null);
    assert.equal(controller.snapshot().dirty, false, 'a successful Save must clear the durable recovery draft');
    assert.equal(await readFile(path, "utf8"), "# title\r\n# %%\r\nget <- assign <- exists <- library <- source <- 1L\r\na <- 40\r\na\r\n# %%\r\nb <- a + 1\nb\r\n# %%\r\nc <- b + 1\nc");

    const publishedPath = join(directory, "published.html");
    const publishDocumentRevision = controller.snapshot().documentRevision;
    const publish = await dispatchHost(app, { type: "publish", includeCode: true, outputPath: publishedPath,
      expectedDocumentRevision: publishDocumentRevision });
    assert.equal(publish.error, null);
    assert.deepEqual(publish.result, { path: publishedPath, documentRevision: publishDocumentRevision });
    const html = await readFile(publishedPath, "utf8");
    assert.match(html, /42/);
    const publishedText = parseHTML(html).document.querySelector("main")?.textContent ?? "";
    assert.match(publishedText, /a\s*<-\s*40/);

    const edit = await dispatchHost(app, {
      type: "transaction",
      changes: [{ type: "edit", cell: { cellId: "cell-1" }, expectedRevision: 1,
        cellType: "code", body: ["a <- 99", "a"] }],
    });
    assert.equal(edit.error, null);
    await writeFile(path, "# external replacement\n");
    const failedSave = await dispatchHost(app, { type: "save" });
    assert.equal(failedSave.error?.code, "source_conflict");
    const refusedPath = join(directory, "must-not-publish.html");
    const refused = await dispatchHost(app, { type: "publish", includeCode: true, outputPath: refusedPath });
    assert.equal(refused.error?.code, "publish_not_ready");
    await assert.rejects(access(refusedPath));
    assert.equal(controller.snapshot().cells[0]!.body[0], "a <- 99");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed kernel follows ordinary project profile and library activation", {
  skip: !APPLICATION_ROOT, timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-project-profile-"));
  const path = join(directory, "notebook.R");
  const userLibrary = join(directory, "user-library");
  const projectLibrary = join(directory, "renv-library");
  const packageName = "alder";
  const priorUserLibrary = process.env.R_LIBS_USER;
  let app: RunningHost | undefined;
  try {
    await installFixturePackage(directory, userLibrary, packageName, "1.0.0", "user");
    process.env.R_LIBS_USER = userLibrary;
    const userExpression = `paste(as.character(packageVersion('${packageName}')), ` +
      `normalizePath(find.package('${packageName}'), winslash='/'), ${packageName}::fixture_value(), sep='|')`;
    await writeFile(path, `# %%\n${userExpression}\n`);
    app = await startInstalledHost(path, { executionMode: "lazy" });
    let run = await dispatchHost(app, { type: "run", scope: "all", changes: [] });
    assert.equal(run.error, null);
    assert.match(JSON.stringify(app.controller.snapshot().cells[0]!.outputs),
      /1\.0\.0\|.*user-library.*\|user/,
      "the selected R user library must precede the bundled Alder fallback");
    await app.close();
    app = undefined;

    await installFixturePackage(directory, projectLibrary, packageName, "2.0.0", "project");
    await installFixturePackage(directory, projectLibrary, "jsonlite", "999.0.0",
      "incompatible-project-jsonlite");
    await writeFile(join(directory, ".Renviron"), "ALDER_PROFILE_MARKER=project-marker\n");
    await writeFile(join(directory, ".Rprofile"),
      ".libPaths(c(file.path(getwd(), 'renv-library'), .libPaths()))\n");
    const valueExpression = `paste(as.character(packageVersion('${packageName}')), ` +
      `normalizePath(find.package('${packageName}'), winslash='/'), ` +
      `${packageName}::fixture_value(), Sys.getenv('ALDER_PROFILE_MARKER'), ` +
      "as.character(packageVersion('jsonlite')), jsonlite::fixture_value(), sep='|')";
    const setupExpression = `library(${packageName}); library(jsonlite); `;
    const ordinary = execFileSync(process.env.RSCRIPT ?? "Rscript", ["--slave", "-e",
      setupExpression + `cat(${valueExpression})`], {
      cwd: directory,
      env: { ...process.env, R_LIBS_USER: userLibrary },
      encoding: "utf8",
    }).trim();
    assert.match(ordinary,
      /^2\.0\.0\|.*renv-library.*\|project\|project-marker\|999\.0\.0\|incompatible-project-jsonlite$/);
    await writeFile(path, `# %%\n${setupExpression}${valueExpression}\n`);
    app = await startInstalledHost(path, { executionMode: "lazy" });
    for (const dependency of ["codetools", "jsonlite", "mime", "rlang"]) {
      await access(join(stagedResources!.rLibraryDirectory, dependency, "DESCRIPTION"));
    }
    const beforeFormat = app.controller.snapshot();
    const formatted = await dispatchHost(app, {
      type: "format",
      expectedRevisions: Object.fromEntries(beforeFormat.cells.map(cell => [cell.id, cell.revision])),
    });
    assert.equal(formatted.error, null,
      "formatting and analysis services must remain independent of project R packages");
    run = await dispatchHost(app, { type: "run", scope: "all", changes: [] });
    assert.equal(run.error, null);
    assert.match(JSON.stringify(app.controller.snapshot().cells[0]!.outputs),
      new RegExp(ordinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (priorUserLibrary === undefined) delete process.env.R_LIBS_USER;
    else process.env.R_LIBS_USER = priorUserLibrary;
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("project packages declare, install offline, restart Ark, and leave the user library unchanged", {
  skip: !APPLICATION_ROOT, timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-project-package-"));
  const path = join(directory, "notebook.R");
  const userLibrary = join(directory, "user-library");
  const marker = join(userLibrary, "marker.txt");
  const priorUserLibrary = process.env.R_LIBS_USER;
  let app: RunningHost | undefined;
  try {
    await mkdir(userLibrary);
    await writeFile(marker, "unrelated user library\n");
    const repository = await localPackageRepository(directory, "alderfixturepkg");
    await mkdir(join(directory, ".alder"));
    await writeFile(join(directory, ".alder", "repository.yaml"), `repository: ${JSON.stringify(pathToFileURL(repository).href)}\n`);
    await assert.rejects(access(join(directory, "renv.lock")));
    await writeFile(path, [
      "# %%",
      "package_sentinel <- 41L",
      "if (requireNamespace('alderfixturepkg', quietly = TRUE)) alderfixturepkg::fixture_value() else package_sentinel",
      "",
    ].join("\n"));
    process.env.R_LIBS_USER = userLibrary;
    app = await startInstalledHost(path, { executionMode: "lazy" });

    const declared = await dispatchHost(app, { type: "packages-declare", packages: ["alderfixturepkg"] });
    assert.equal(declared.error, null);
    const initialRun = await dispatchHost(app, { type: "run", scope: "all", changes: [] });
    assert.equal(initialRun.error, null);
    assert.match(JSON.stringify(app.controller.snapshot().cells[0]!.outputs), /41/);
    const stableEpoch = app.controller.snapshot().runtime.kernelEpoch;
    const missing = await app.controller.query({ type: "packages-status" });
    assert.deepEqual((missing.result as { missing: string[] }).missing, ["alderfixturepkg"]);
    assert.equal(app.controller.snapshot().runtime.kernelEpoch, stableEpoch);

    await writeFile(join(directory, ".alder", "repository.yaml"), "repository: 42\n");
    const earlyFailure = await dispatchHost(app, { type: "packages-install", packages: [] });
    assert.equal(earlyFailure.error?.code, "package_metadata_error");
    assert.equal(app.controller.snapshot().runtime.kernelEpoch, stableEpoch);
    const retained = await dispatchHost(app, {
      type: "inspect", name: "package_sentinel", kernelEpoch: stableEpoch,
    });
    assert.equal(retained.error, null);
    assert.match(JSON.stringify(retained.result), /41/);
    await writeFile(join(directory, ".alder", "repository.yaml"),
      `repository: ${JSON.stringify(pathToFileURL(repository).href)}\n`);

    const beforeEpoch = app.controller.snapshot().runtime.kernelEpoch;
    const installed = await dispatchHost(app, { type: "packages-install", packages: [] });
    assert.equal(installed.error, null, JSON.stringify(installed.error));
    const afterInstall = app.controller.snapshot();
    assert.notEqual(afterInstall.runtime.kernelEpoch, beforeEpoch);
    const status = (await app.controller.query({ type: "packages-status" })).result as {
      installed: string[]; library: string; status: Array<{ package: string; library: string }>;
    };
    assert.deepEqual(status.installed, ["alderfixturepkg"]);
    assert.equal(status.library, join(directory, ".alder", "library"));
    assert.equal(status.status[0]?.library, status.library);
    const dependencyDescription = await readFile(join(status.library, "jsonlite", "DESCRIPTION"), "utf8");
    assert.match(dependencyDescription, /^Version: 999\.0\.0$/m,
      "the project dependency must be installed in the project library instead of borrowed from the app");

    const run = await dispatchHost(app, { type: "run", scope: "all", changes: [] });
    assert.equal(run.error, null);
    assert.match(JSON.stringify(app.controller.snapshot().cells[0]!.outputs), /project-package-value/);
    const noOpEpoch = app.controller.snapshot().runtime.kernelEpoch;
    const noOp = await dispatchHost(app, { type: "packages-install", packages: [] });
    assert.equal(noOp.error, null);
    assert.equal(app.controller.snapshot().runtime.kernelEpoch, noOpEpoch);
    const afterNoOp = await dispatchHost(app, {
      type: "inspect", name: "package_sentinel", kernelEpoch: noOpEpoch,
    });
    assert.equal(afterNoOp.error, null);
    assert.match(JSON.stringify(afterNoOp.result), /41/);
    assert.equal(await readFile(marker, "utf8"), "unrelated user library\n");
  } finally {
    if (priorUserLibrary === undefined) delete process.env.R_LIBS_USER;
    else process.env.R_LIBS_USER = priorUserLibrary;
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime and app metadata survive recovery restart, Save, and Save As", {
  skip: !APPLICATION_ROOT, timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-metadata-recovery-"));
  const path = join(directory, "notebook.R");
  const destination = join(directory, "copy.R");
  const original = [
    "# ---",
    "# runtime:",
    "#   on_cell_change: automatic",
    "#   on_startup: true",
    "# app:",
    "#   layout: vertical",
    "#   width: medium",
    "#   vendor_note: keep me",
    "# ---",
    "# %%",
    "x <- 1",
    "",
  ].join("\r\n");
  await writeFile(path, original);
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path);
    let snapshot = app.controller.snapshot();
    const runtime = await dispatchHost(app, {
      type: "set-runtime", on_cell_change: "lazy", on_startup: false,
      expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(runtime.error, null);
    snapshot = app.controller.snapshot();
    const appUpdate = await dispatchHost(app, {
      type: "set-app", patch: { layout: "grid" }, expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(appUpdate.error, null);
    assert.equal(await readFile(path, "utf8"), original);
    await app.close();
    app = undefined;

    app = await startInstalledHost(path);
    snapshot = app.controller.snapshot();
    assert.deepEqual(snapshot.metadata?.runtime, { on_cell_change: "lazy", on_startup: false });
    assert.deepEqual(snapshot.metadata?.app, { layout: "grid", width: "medium", vendor_note: "keep me" });

    const save = await dispatchHost(app, { type: "save", expectedDocumentRevision: snapshot.documentRevision });
    assert.equal(save.error, null);
    const saved = await readFile(path, "utf8");
    assert.match(saved, /on_cell_change: lazy/);
    assert.match(saved, /on_startup: false/);
    assert.match(saved, /layout: grid/);
    assert.match(saved, /vendor_note: keep me/);
    assert.doesNotMatch(saved, /on_cell_change: automatic/);
    assert.doesNotMatch(saved, /on_startup: true/);
    assert.doesNotMatch(saved, /layout: vertical/);

    snapshot = app.controller.snapshot();
    const nextRuntime = await dispatchHost(app, {
      type: "set-runtime", on_cell_change: "automatic", expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(nextRuntime.error, null);
    snapshot = app.controller.snapshot();
    const nextApp = await dispatchHost(app, {
      type: "set-app", patch: { width: "full" }, expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(nextApp.error, null);
    snapshot = app.controller.snapshot();
    const saveAs = await dispatchHost(app, {
      type: "save-as", path: destination, expectedDestination: "absent", expectedDocumentRevision: snapshot.documentRevision,
    });
    assert.equal(saveAs.error, null, JSON.stringify(saveAs.error));
    const copied = await readFile(destination, "utf8");
    assert.match(copied, /on_cell_change: automatic/);
    assert.match(copied, /on_startup: false/);
    assert.match(copied, /layout: grid/);
    assert.match(copied, /width: full/);
    assert.match(copied, /vendor_note: keep me/);
    assert.equal(app.controller.snapshot().dirty, false, "a successful Save As must clear the durable recovery draft");
    const saveAsRecovery = await app.controller.query({ type: "recovery" });
    assert.equal(saveAsRecovery.result.candidate, null);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("editing a queued batch cell prevents its old effects and retains unaffected work", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-batch-edit-"));
  const path = join(directory, "notebook.R");
  const marker = join(directory, "obsolete-source");
  await writeFile(path, "# %%\nSys.sleep(0.3); a <- 1; a\n# %%\nb <- a + 1; b\n# %%\n" +
    "writeLines('obsolete', " + JSON.stringify(marker) + "); c <- b + 1; c\n");
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: "lazy" });
    const controller = app.controller;
    let edited: Promise<CommandResult> | undefined;
    controller.subscribe(event => {
      if (event.type !== "cell-started" || event.cellId !== "cell-1" || edited !== undefined) return;
      const state = controller.snapshot();
      edited = dispatchHost(app!, {
        type: "transaction",
        expectedDocumentRevision: state.documentRevision,
        changes: [{ type: "edit", cell: { cellId: "cell-3" }, expectedRevision: state.cells[2]!.revision,
          cellType: "code", body: ["c <- b + 20; c"] }],
      });
    });
    const run = () => dispatchHost(app!, { type: "run", scope: "all", expectedDocumentRevision: controller.snapshot().documentRevision });
    assert.equal((await run()).error, null);
    assert.ok(edited, "the source edit must occur while the batch is running");
    assert.equal((await edited).error, null);
    await assert.rejects(access(marker));
    assert.deepEqual(controller.snapshot().cells.slice(0, 2).map(cell => cell.status), ["done", "done"]);
    assert.deepEqual(controller.snapshot().cells[2]!.body, ["c <- b + 20; c"]);
    assert.equal((await run()).error, null);
    assert.match(JSON.stringify(controller.snapshot().cells[2]!.outputs), /22/);
    assert.equal(controller.snapshot().runtime.busy, false);
    await assert.rejects(access(marker));
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("a batched consumer run settles its run-button reset", {
  skip: !APPLICATION_ROOT, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-host-batch-button-"));
  const path = join(directory, "notebook.R");
  await writeFile(path, "# %%\nlibrary(alder)\nbtn <- ui$run_button(); btn\n# %%\nseen <- btn$value; seen\n# %%\nresult <- as.integer(seen); result\n");
  let app: RunningHost | undefined;
  try {
    app = await startInstalledHost(path, { executionMode: "lazy" });
    const controller = app.controller;
    const initial = await dispatchHost(app, { type: "run", scope: "all", expectedDocumentRevision: controller.snapshot().documentRevision });
    assert.equal(initial.error, null);
    const beforeWidget = controller.snapshot();
    const widget = dispatchHost(app, {
      type: "widget", name: "btn", path: [], update: { value: true }, source: "editor",
      kernelEpoch: beforeWidget.runtime.kernelEpoch!, expectedRevision: beforeWidget.cells[0]!.revision,
    });
    const deadline = performance.now() + 5_000;
    while (controller.snapshot().cells[2]!.status !== "stale" && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(controller.snapshot().cells[2]!.status, "stale");
    const explicit = await dispatchHost(app, {
      type: "run", scope: "cell", target: { cellId: "cell-3" },
      expectedDocumentRevision: controller.snapshot().documentRevision,
    });
    assert.equal(explicit.error, null);
    assert.equal((await widget).error, null);
    const state = controller.snapshot();
    const widgetRecord = state.cells[0]!.outputs.find(record => widgetOutputSchema.safeParse(record.data).success);
    if (widgetRecord === undefined) {
      assert.fail("button widget output missing: outputs=" + JSON.stringify(state.cells[0]!.outputs) + " error=" + JSON.stringify(state.cells[0]!.error));
    }
    const widgetData = widgetOutputSchema.parse(widgetRecord.data);
    assert.equal(widgetData.name, "btn");
    assert.equal(widgetData.spec.kind, "run_button");
    assert.equal(widgetData.spec.value, false);
    assert.match(JSON.stringify(state.cells[2]!.outputs), /\[1\] 1/);
    assert.equal(state.runtime.busy, false);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
