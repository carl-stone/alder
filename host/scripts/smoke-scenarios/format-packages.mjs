import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHarness, delay, openLogicalWebSocket, waitForExecutionReady } from "./_common.mjs";
import { WebSocket } from "ws";

const TERMINAL = new Set(["done", "error", "failed", "interrupted", "cancelled"]);

export async function run(ctx) {
  const source = `# %%
library(alder)
htmlwidgets_loaded <- requireNamespace("htmlwidgets", quietly = TRUE)
htmlwidgets_path <- if (htmlwidgets_loaded) {
  unname(find.package("htmlwidgets"))[[1]]
} else {
  "ALDER_HTMLWIDGETS_NOT_INSTALLED"
}
htmlwidgets_search_library <- if (htmlwidgets_loaded) {
  normalized_path <- normalizePath(htmlwidgets_path, winslash = "/", mustWork = FALSE)
  matches <- vapply(.libPaths(), function(path) identical(normalizePath(file.path(path, "htmlwidgets"), winslash = "/", mustWork = FALSE), normalized_path), logical(1))
  if (any(matches)) .libPaths()[which(matches)[1]] else "ALDER_HTMLWIDGETS_NO_LIBRARY_MATCH"
} else {
  "ALDER_HTMLWIDGETS_NOT_INSTALLED"
}
value <- 1+2
value
runtime_probe <- as.character(jsonlite::toJSON(list(path = htmlwidgets_path, libraryPaths = .libPaths(), loaded = htmlwidgets_loaded), auto_unbox = TRUE))
out$append(runtime_probe)
# %% [markdown]
# **ALDER_MARKDOWN_KEEP**
# %%
Sys.sleep(3)
value
`;
  const harness = await createHarness(ctx, { id: "format-packages", source });
  try {
    const notebookDirectory = harness.canonical.replace(/[\\/][^\\/]+$/, "");
    const ordinaryLibrary = join(notebookDirectory, ".alder", "library");
    const helperLibrary = join(ctx.applicationRoot, ctx.manifest.resources.rLibraryDirectory);
    const helperRelative = ctx.manifest.resources.rLibraryDirectory.replace(/[\\/]+$/, "");
    const helperPrefix = helperRelative + "/";
    const helperInventoryEntries = ctx.manifest.files.filter(file => file.path.startsWith(helperPrefix));
    assert.ok(helperInventoryEntries.length > 0, "staged manifest must inventory the complete helper library");
    const helperInventoryBefore = await verifyManifestInventory(helperInventoryEntries, helperLibrary, helperPrefix);
    const initial = await waitForExecutionReady(harness);
    const codeCells = initial.cells.filter(cell => cell.type === "code");
    const markdownCell = initial.cells.find(cell => cell.type === "markdown");
    assert.equal(codeCells.length, 2);
    assert.ok(markdownCell);
    const initialIds = initial.cells.map(cell => cell.id);
    const initialSource = await sourceData(harness);
    assertSourceMatchesCells(initialSource, initial.cells);
    const airPath = ctx.manifest.resources?.airExecutable ? join(ctx.applicationRoot, ctx.manifest.resources.airExecutable) : null;
    assert.ok(airPath, "staged manifest must declare the Air formatter");
    const airInfo = await stat(airPath);
    assert.ok(airInfo.isFile() && airInfo.size > 0, "staged Air executable is real");
    const formatReceipt = await harness.nextCommand({
      type: "format", cellIds: codeCells.map(cell => cell.id),
      expectedRevisions: Object.fromEntries(codeCells.map(cell => [cell.id, cell.revision])),
      expectedDocumentRevision: initial.documentRevision,
    });
    const formatResult = await settle(harness, formatReceipt);
    assert.equal(formatResult.status, "done", JSON.stringify(formatResult));
    let current = await harness.snapshot();
    assert.deepEqual(current.cells.map(cell => cell.id), initialIds);
    const formattedSource = await sourceData(harness);
    assertSourceMatchesCells(formattedSource, current.cells);
    assert.deepEqual(formattedSource.map(cell => ({ id: cell.id, type: cell.type })), initialSource.map(cell => ({ id: cell.id, type: cell.type })), "Air preserves source cell identity/order/type");
    assert.ok(formatResult.result && typeof formatResult.result === "object" && Array.isArray(formatResult.result.edited), JSON.stringify(formatResult));
    const expectedEdited = codeCells.filter(cell => {
      const before = initialSource.find(sourceCell => sourceCell.id === cell.id);
      const after = formattedSource.find(sourceCell => sourceCell.id === cell.id);
      assert.ok(before && after, "formatter source map must retain every selected code cell");
      return before.type !== after.type
        || before.revision !== after.revision
        || JSON.stringify(before.body) !== JSON.stringify(after.body)
        || JSON.stringify(before.options) !== JSON.stringify(after.options);
    });
    const editedIds = formatResult.result.edited.map(entry => entry.id);
    assert.deepEqual(editedIds, expectedEdited.map(cell => cell.id), "formatter result maps only changed selected code cells in source order");
    assert.equal(formatResult.result.changed, editedIds.length, "formatter changed count matches the actual source diff");
    const editedById = new Map(formatResult.result.edited.map(entry => [entry.id, entry]));
    for (const cell of codeCells) {
      const before = initialSource.find(sourceCell => sourceCell.id === cell.id);
      const after = formattedSource.find(sourceCell => sourceCell.id === cell.id);
      const changed = expectedEdited.some(candidate => candidate.id === cell.id);
      const entry = editedById.get(cell.id);
      if (changed) {
        assert.ok(entry, "changed source cell must be present in formatter result");
        assert.equal(entry.revision, after.revision, "formatter result revision matches exposed consumer source");
      } else {
        assert.equal(entry, undefined, "unchanged source cell must not be reported as edited");
        assert.deepEqual(after, before, "formatter preserves unchanged source cells");
      }
    }
    const formattedMarkdown = current.cells.find(cell => cell.id === markdownCell.id);
    assert.deepEqual(formattedMarkdown.body, markdownCell.body, "Air never rewrites Markdown");
    assert.equal(formattedMarkdown.revision, markdownCell.revision, "Markdown revision is unchanged");
    assert.match(current.cells.find(cell => cell.id === codeCells[0].id).body.join("\n"), /value\s*<-\s*1\s*\+\s*2/);
    const formattedBytes = await readFile(harness.notebook);
    const runReceipt = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: current.documentRevision });
    const runResult = await settle(harness, runReceipt);
    assert.equal(runResult.status, "done", JSON.stringify(runResult));
    current = await harness.snapshot();
    const first = current.cells.find(cell => cell.id === codeCells[0].id);
    const malformedEdit = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: current.documentRevision, changes: [{ type: "edit", cell: { cellId: first.id }, expectedRevision: first.revision, cellType: "code", body: ["if ("] }] });
    const malformedEditResult = await settle(harness, malformedEdit);
    assert.equal(malformedEditResult.status, "done", JSON.stringify(malformedEditResult));
    const malformed = await harness.snapshot();
    const malformedBytes = await readFile(harness.notebook);
    const invalidFormat = await harness.nextCommand({ type: "format", cellIds: [first.id], expectedRevisions: { [first.id]: malformed.cells.find(cell => cell.id === first.id).revision }, expectedDocumentRevision: malformed.documentRevision });
    const invalidFormatResult = await settle(harness, invalidFormat);
    assert.equal(invalidFormatResult.status, "error", JSON.stringify(invalidFormatResult));
    assert.equal(invalidFormatResult.error?.code, "format_failed", JSON.stringify(invalidFormatResult));
    assert.deepEqual(await readFile(harness.notebook), malformedBytes, "Air-only failure leaves notebook bytes unchanged");
    const afterInvalid = await harness.snapshot();
    assert.deepEqual(afterInvalid.cells.find(cell => cell.id === first.id).body, malformed.cells.find(cell => cell.id === first.id).body);
    assert.equal(afterInvalid.documentRevision, malformed.documentRevision);
    const repair = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: afterInvalid.documentRevision, changes: [{ type: "edit", cell: { cellId: first.id }, expectedRevision: afterInvalid.cells.find(cell => cell.id === first.id).revision, cellType: "code", body: formattedSource.find(cell => cell.id === first.id).body }] });
    assert.equal((await settle(harness, repair)).status, "done");
    current = await harness.snapshot();
    const raceCell = current.cells.find(cell => cell.id === codeCells[1].id);
    const staleFormat = { type: "format", cellIds: [raceCell.id], expectedRevisions: { [raceCell.id]: raceCell.revision }, expectedDocumentRevision: current.documentRevision };
    const raceEdit = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: current.documentRevision, changes: [{ type: "edit", cell: { cellId: raceCell.id }, expectedRevision: raceCell.revision, cellType: "code", body: ["Sys.sleep(3)", "value + 1"] }] });
    assert.equal((await settle(harness, raceEdit)).status, "done");
    const afterRaceEdit = await harness.snapshot();
    const raceBytes = await readFile(harness.notebook);
    const staleFormatResult = await expectFailure(harness, staleFormat);
    assert.equal(staleFormatResult.code, "source_conflict", JSON.stringify(staleFormatResult));
    assert.deepEqual(await readFile(harness.notebook), raceBytes);
    assert.equal((await harness.snapshot()).documentRevision, afterRaceEdit.documentRevision);
    current = afterRaceEdit;
    const packageBefore = value(await harness.query({ type: "packages-status" }));
    assert.equal(packageBefore.mode, "pak");
    assert.equal(packageBefore.library, null);
    await assert.rejects(stat(ordinaryLibrary), { code: "ENOENT" }, "status must not create the project library");
    const oldSidecarVersion = current.sidecars?.packages?.version ?? null;
    const declaration = await harness.nextCommand({ type: "packages-declare", packages: ["htmlwidgets", "jsonlite"], expectedSidecarVersion: oldSidecarVersion, expectedDocumentRevision: current.documentRevision });
    const declarationResult = await settle(harness, declaration);
    assert.equal(declarationResult.status, "done", JSON.stringify(declarationResult));
    current = await harness.snapshot();
    const packageMetadata = join(notebookDirectory, ".alder", "packages.yaml");
    const packageText = await readFile(packageMetadata, "utf8");
    assert.equal(packageText, "packages:\n  - htmlwidgets\n  - jsonlite\n");
    const declaredStatus = value(await harness.query({ type: "packages-status" }));
    assert.deepEqual(declaredStatus.packages, ["htmlwidgets", "jsonlite"]);
    assert.equal(declaredStatus.mode, "pak");
    assert.equal(declaredStatus.library, null);
    const staleDeclaration = await expectFailure(harness, { type: "packages-declare", packages: ["jsonlite", "yaml"], expectedSidecarVersion: oldSidecarVersion, expectedDocumentRevision: current.documentRevision });
    assert.equal(staleDeclaration.code, "source_conflict", JSON.stringify(staleDeclaration));
    const afterStaleDeclaration = await harness.snapshot();
    assert.equal(afterStaleDeclaration.documentRevision, current.documentRevision, "stale declaration leaves document revision unchanged");
    assert.equal(afterStaleDeclaration.sidecars?.packages?.version, current.sidecars?.packages?.version, "stale declaration leaves sidecar revision unchanged");
    assert.equal(await readFile(packageMetadata, "utf8"), packageText);
    current = await harness.snapshot();
    let outputsBeforePak;
    const sourceBeforePak = await sourceData(harness);
    assertSourceMatchesCells(sourceBeforePak, current.cells);
    const bytesBeforePak = await readFile(harness.notebook);
    const beforeInstallEpoch = kernelEpoch(current);
    const beforeInstallAnalysisEnvironment = current.runtime?.analysisEnvironmentId;
    assert.equal(typeof beforeInstallAnalysisEnvironment, "string", JSON.stringify(current.runtime));
    let sourceDuringPak;
    let bytesDuringPak;
    const packageEventStream = await openOperationEventStream(harness, current);
    let packageOperationId;
    let installResult;
    let installPayload;
    let progressOutput;
    let packageProgressEvidence;
    try {
      const installReceipt = await harness.nextCommand({ type: "packages-install", packages: ["htmlwidgets", "jsonlite"], expectedDocumentRevision: current.documentRevision, kernelEpoch: beforeInstallEpoch });
      packageOperationId = installReceipt.operationId;
      assert.equal(typeof packageOperationId, "string", JSON.stringify(installReceipt));
      const packageStarted = await packageEventStream.waitForOperationPhase(packageOperationId, "started");
      assert.equal(packageStarted.phase, "started");
      const installEditCell = current.cells.find(cell => cell.id === codeCells[1].id);
      assert.ok(installEditCell, "package preservation edit cell must exist");
      const installEditBody = [...installEditCell.body, "value + 0"];
      const editDuringInstallReceipt = await harness.nextCommand({ type: "transaction", expectedDocumentRevision: current.documentRevision, changes: [{ type: "edit", cell: { cellId: installEditCell.id }, expectedRevision: installEditCell.revision, cellType: "code", body: installEditBody }] });
      const editDuringInstallResult = await settle(harness, editDuringInstallReceipt);
      assert.equal(editDuringInstallResult.status, "done", JSON.stringify(editDuringInstallResult));
      const duringInstall = await harness.snapshot();
      sourceDuringPak = await sourceData(harness);
      assertSourceMatchesCells(sourceDuringPak, duringInstall.cells);
      assert.deepEqual(sourceDuringPak.find(cell => cell.id === installEditCell.id)?.body, installEditBody, "captured source edit is applied while package install runs");
      assert.notDeepEqual(sourceDuringPak, sourceBeforePak, "package preservation edit must differ from its preinstall source");
      bytesDuringPak = await readFile(harness.notebook);
      assert.deepEqual(bytesDuringPak, bytesBeforePak, "source transaction keeps notebook bytes unchanged until an explicit save");
      current = duringInstall;
      outputsBeforePak = new Map(current.cells.filter(cell => cell.type === "code").map(cell => [cell.id, cell.outputs]));
      const streamedOperation = packageEventStream.waitForOperation(packageOperationId, "done");
      installResult = await settle(harness, installReceipt);
      assert.equal(installResult.id, packageOperationId, JSON.stringify(installResult));
      packageProgressEvidence = await streamedOperation;
      assert.equal(packageProgressEvidence.terminalStatus, installResult.status, JSON.stringify(packageProgressEvidence));
      assert.equal(installResult.status, "done", JSON.stringify(installResult));
      installPayload = installResult.result;
      assert.ok(installPayload && installPayload.result && installPayload.status, JSON.stringify(installResult));
      assert.equal(installPayload.result.status, "installed", JSON.stringify(installPayload));
      assert.equal(installPayload.result.library, join(notebookDirectory, ".alder", "library"));
      assert.equal(installPayload.status.mode, "pak");
      assert.equal(installPayload.status.library, join(notebookDirectory, ".alder", "library"));
      progressOutput = String(installPayload.result.output ?? "");
      assert.match(progressOutput, /ALDER_PACKAGE_PROGRESS/);
      assert.ok(Buffer.byteLength(progressOutput, "utf8") <= 64 * 1024, "package diagnostics must be byte-bounded");
      assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(progressOutput, "utf8")), progressOutput);
    } finally {
      await packageEventStream.close();
    }
    const ordinaryLibraryInfo = await stat(ordinaryLibrary);
    assert.ok(ordinaryLibraryInfo.isDirectory(), "pak install creates the project-local library");
    const pakSentinel = join(ordinaryLibrary, "jsonlite", "DESCRIPTION");
    const pakSentinelBeforeRenv = await fileHash(pakSentinel);
    const helperInventoryAfterPak = await verifyManifestInventory(helperInventoryEntries, helperLibrary, helperPrefix);
    assert.equal(helperInventoryAfterPak, helperInventoryBefore, "pak install does not mutate the full staged helper library");
    const projectLibraryInventoryAfterPak = await collectFileInventory(ordinaryLibrary);
    assert.ok(projectLibraryInventoryAfterPak.length > 0, "pak install must produce a non-empty project library");
    const projectLibraryInventoryBeforeRenv = inventoryDigest(projectLibraryInventoryAfterPak);
    const afterInstall = await waitForExecutionReady(harness);
    const sourceAfterPak = await sourceData(harness);
    assertSourceMatchesCells(sourceAfterPak, afterInstall.cells);
    assert.deepEqual(sourceAfterPak, sourceDuringPak, "pak install preserves the source edit captured while running");
    assert.deepEqual(await readFile(harness.notebook), bytesDuringPak, "pak install preserves disk bytes while retaining the captured draft");
    assert.notEqual(kernelEpoch(afterInstall), beforeInstallEpoch, "package install restarts the kernel");
    assert.equal(typeof afterInstall.runtime?.analysisEnvironmentId, "string", JSON.stringify(afterInstall.runtime));
    assert.notEqual(afterInstall.runtime.analysisEnvironmentId, beforeInstallAnalysisEnvironment, "package install invalidates the analyzer generation");
    const pakRuntimeLibraries = afterInstall.runtime?.rEnvironment?.libraryPaths;
    assert.ok(Array.isArray(pakRuntimeLibraries), JSON.stringify(afterInstall.runtime));
    assert.ok(pakRuntimeLibraries.includes(installPayload.result.library), JSON.stringify({ libraryPaths: pakRuntimeLibraries, selectedLibrary: installPayload.result.library }));
    const afterInstallKernelEpoch = kernelEpoch(afterInstall);
    assert.equal(afterInstall.runtime.busy, false, JSON.stringify(afterInstall.runtime));
    assert.equal(afterInstall.runtime.activeRunId, null, JSON.stringify(afterInstall.runtime));
    for (const cell of afterInstall.cells.filter(cell => cell.type === "code")) {
      assert.equal(cell.status, "stale", JSON.stringify(cell));
      const previousOutputs = outputsBeforePak.get(cell.id);
      assert.ok(previousOutputs, "package restart must retain a preinstall output set");
      assert.deepEqual(cell.outputs, previousOutputs, "package restart retains exact preinstall outputs");
      assert.ok(cell.outputs.every(output => output.kernelEpoch === beforeInstallEpoch), JSON.stringify(cell.outputs));
      assert.ok(cell.outputs.every(output => output.kernelEpoch !== afterInstallKernelEpoch), "package restart must not expose new-epoch output before rerun");
    }
    const rerun = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: afterInstall.documentRevision });
    assert.equal((await settle(harness, rerun)).status, "done");
    current = await harness.snapshot();
    const pakProbe = await jsonProbe(harness, first.id, current);
    assert.equal(pakProbe.loaded, true, JSON.stringify(pakProbe));
    assert.equal(typeof pakProbe.path, "string", JSON.stringify(pakProbe));
    assert.notEqual(pakProbe.path, "ALDER_HTMLWIDGETS_NOT_INSTALLED");
    assert.notEqual(pakProbe.path, "ALDER_HTMLWIDGETS_NO_LIBRARY_MATCH");
    assert.equal(pakProbe.path, await realpath(join(installPayload.result.library, "htmlwidgets")), JSON.stringify({ probe: pakProbe, selectedLibrary: installPayload.result.library }));
    assert.ok(pakProbe.libraryPaths.includes(installPayload.result.library), JSON.stringify({ probe: pakProbe, selectedLibrary: installPayload.result.library }));
    const lockPath = join(notebookDirectory, "renv.lock");
    const htmlwidgetsRecord = await installedPackageRecord(ordinaryLibrary, "htmlwidgets");
    const jsonliteRecord = await installedPackageRecord(ordinaryLibrary, "jsonlite");
    await writeFile(lockPath, JSON.stringify({
      R: { Version: "4.6.1", Repositories: [{ Name: "CRAN", URL: "https://cloud.r-project.org" }] },
      Packages: {
        htmlwidgets: htmlwidgetsRecord,
        jsonlite: jsonliteRecord,
        AlderSmokeNoSuchPackage: {
          Package: "AlderSmokeNoSuchPackage",
          Version: "9999.0.0",
          Source: "Repository",
          Repository: "CRAN",
        },
      },
    }) + "\n");
    const renvStatus = value(await harness.query({ type: "packages-status" }));
    const beforeFailedInstallEpoch = kernelEpoch(current);
    assert.equal(renvStatus.mode, "renv");
    assert.equal(renvStatus.lockfile, lockPath);
    assert.notEqual(renvStatus.library, join(notebookDirectory, ".alder", "library"));
    const beforeFailedInstall = await readFile(harness.notebook);
    const failedInstall = await expectFailure(harness, { type: "packages-install", packages: ["AlderSmokeNoSuchPackage"], expectedDocumentRevision: current.documentRevision, kernelEpoch: kernelEpoch(current) });
    const afterFailedInstall = await waitForExecutionReady(harness);
    assert.notEqual(kernelEpoch(afterFailedInstall), beforeFailedInstallEpoch, "failed package install still invalidates the runtime generation");
    const failedRenvRuntimeLibraries = afterFailedInstall.runtime?.rEnvironment?.libraryPaths;
    assert.ok(Array.isArray(failedRenvRuntimeLibraries), JSON.stringify(afterFailedInstall.runtime));
    assert.equal(failedRenvRuntimeLibraries.includes(ordinaryLibrary), false, JSON.stringify({ libraryPaths: failedRenvRuntimeLibraries, previousLibrary: ordinaryLibrary }));
    for (const cell of afterFailedInstall.cells.filter(cell => cell.type === "code")) {
      assert.equal(cell.status, "stale", JSON.stringify(cell));
    }
    current = afterFailedInstall;
    assert.equal(failedInstall.code, "install_failed", JSON.stringify(failedInstall));
    const failedInstallPayload = failedInstall.operation?.error?.details?.result;
    assert.ok(failedInstallPayload && typeof failedInstallPayload === "object", JSON.stringify(failedInstall));
    assert.equal(failedInstallPayload.mutatedLibrary, true, JSON.stringify(failedInstall));
    assert.equal(failedInstallPayload.error?.code, "install_failed", JSON.stringify(failedInstall));
    assert.deepEqual(await readFile(harness.notebook), beforeFailedInstall);
    assert.equal(await fileHash(pakSentinel), pakSentinelBeforeRenv, "failed renv install leaves the pak library sentinel unchanged");
    const helperInventoryAfterFailure = await verifyManifestInventory(helperInventoryEntries, helperLibrary, helperPrefix);
    assert.equal(helperInventoryAfterFailure, helperInventoryBefore, "failed package install does not mutate the full staged helper library");
    const projectLibraryInventoryAfterFailure = await collectFileInventory(ordinaryLibrary);
    assert.equal(inventoryDigest(projectLibraryInventoryAfterFailure), projectLibraryInventoryBeforeRenv, "failed renv install leaves the project library inventory unchanged");
    assert.ok((await stat(ordinaryLibrary)).isDirectory());
    const recoveryRun = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: current.documentRevision });
    assert.equal((await settle(harness, recoveryRun)).status, "done");
    current = await harness.snapshot();
    assert.ok(current.cells.filter(cell => cell.type === "code").every(cell => cell.status === "done" && cell.outputs.length > 0), "failed renv recovery requires an explicit rerun");
    const outputsBeforeRenv = new Map(current.cells.filter(cell => cell.type === "code").map(cell => [cell.id, cell.outputs]));
    const sourceBeforeRenv = await sourceData(harness);
    assertSourceMatchesCells(sourceBeforeRenv, current.cells);
    const bytesBeforeRenv = await readFile(harness.notebook);
    const beforeRenvInstallEpoch = kernelEpoch(current);
    const beforeRenvInstallAnalysisEnvironment = current.runtime?.analysisEnvironmentId;
    assert.equal(typeof beforeRenvInstallAnalysisEnvironment, "string", JSON.stringify(current.runtime));
    const renvLibrary = renvStatus.library;
    assert.equal(typeof renvLibrary, "string", JSON.stringify(renvStatus));
    assert.notEqual(renvLibrary, ordinaryLibrary);
    const renvInstallReceipt = await harness.nextCommand({ type: "packages-install", packages: ["htmlwidgets", "jsonlite"], expectedDocumentRevision: current.documentRevision, kernelEpoch: beforeRenvInstallEpoch });
    const renvInstallResult = await settle(harness, renvInstallReceipt);
    assert.equal(renvInstallResult.status, "done", JSON.stringify(renvInstallResult));
    const renvInstallPayload = renvInstallResult.result;
    assert.ok(renvInstallPayload && renvInstallPayload.result && renvInstallPayload.status, JSON.stringify(renvInstallResult));
    assert.equal(renvInstallPayload.result.status, "installed", JSON.stringify(renvInstallPayload));
    assert.equal(renvInstallPayload.result.library, renvLibrary, JSON.stringify(renvInstallPayload));
    assert.equal(renvInstallPayload.result.mode, "renv", JSON.stringify(renvInstallPayload));
    assert.equal(renvInstallPayload.result.lockfile, lockPath, JSON.stringify(renvInstallPayload));
    assert.ok(renvInstallPayload.result.installed.includes("htmlwidgets"), JSON.stringify(renvInstallPayload));
    assert.ok(renvInstallPayload.result.installed.includes("jsonlite"), JSON.stringify(renvInstallPayload));
    assert.equal(renvInstallPayload.status.mode, "renv", JSON.stringify(renvInstallPayload));
    assert.equal(renvInstallPayload.status.lockfile, lockPath, JSON.stringify(renvInstallPayload));
    assert.equal(renvInstallPayload.status.library, renvLibrary, JSON.stringify(renvInstallPayload));
    const renvHtmlwidgetsRecord = renvInstallPayload.result.packageStatus.find(record => record.package === "htmlwidgets");
    assert.ok(renvHtmlwidgetsRecord, JSON.stringify(renvInstallPayload));
    assert.equal(renvHtmlwidgetsRecord.status, "installed", JSON.stringify(renvInstallPayload));
    assert.equal(renvHtmlwidgetsRecord.library, renvLibrary, JSON.stringify(renvInstallPayload));
    const renvPackageRecord = renvInstallPayload.result.packageStatus.find(record => record.package === "jsonlite");
    assert.ok(renvPackageRecord, JSON.stringify(renvInstallPayload));
    assert.equal(renvPackageRecord.status, "installed", JSON.stringify(renvPackageRecord));
    assert.equal(renvPackageRecord.library, renvLibrary, JSON.stringify(renvPackageRecord));
    assert.ok((await stat(join(renvLibrary, "htmlwidgets", "DESCRIPTION"))).isFile(), "renv install creates the isolated htmlwidgets package");
    assert.ok((await stat(join(renvLibrary, "jsonlite", "DESCRIPTION"))).isFile(), "renv install creates the isolated jsonlite package");
    assert.equal(await fileHash(pakSentinel), pakSentinelBeforeRenv, "renv install does not mutate the pak library");
    const helperInventoryAfterRenv = await verifyManifestInventory(helperInventoryEntries, helperLibrary, helperPrefix);
    assert.equal(helperInventoryAfterRenv, helperInventoryBefore, "renv install does not mutate the staged helper library");
    const projectLibraryInventoryAfterRenv = await collectFileInventory(ordinaryLibrary);
    assert.equal(inventoryDigest(projectLibraryInventoryAfterRenv), projectLibraryInventoryBeforeRenv, "renv install leaves the pak library isolated");
    const afterRenvInstall = await waitForExecutionReady(harness);
    const sourceAfterRenv = await sourceData(harness);
    assertSourceMatchesCells(sourceAfterRenv, afterRenvInstall.cells);
    assert.deepEqual(sourceAfterRenv, sourceBeforeRenv, "renv install preserves captured source edits");
    assert.deepEqual(await readFile(harness.notebook), bytesBeforeRenv, "renv install preserves notebook bytes");
    assert.equal(afterRenvInstall.documentRevision, current.documentRevision, "renv install does not mutate document revision");
    assert.notEqual(kernelEpoch(afterRenvInstall), beforeRenvInstallEpoch, "renv install restarts the kernel");
    assert.equal(afterRenvInstall.runtime.kernelState, "ready", JSON.stringify(afterRenvInstall.runtime));
    assert.equal(afterRenvInstall.runtime.analyzerState, "ready", JSON.stringify(afterRenvInstall.runtime));
    assert.equal(typeof afterRenvInstall.runtime.analysisEnvironmentId, "string", JSON.stringify(afterRenvInstall.runtime));
    assert.notEqual(afterRenvInstall.runtime.analysisEnvironmentId, beforeRenvInstallAnalysisEnvironment, "renv install invalidates the analyzer generation");
    const renvRuntimeLibraries = afterRenvInstall.runtime?.rEnvironment?.libraryPaths;
    assert.ok(Array.isArray(renvRuntimeLibraries), JSON.stringify(afterRenvInstall.runtime));
    assert.ok(renvRuntimeLibraries.includes(renvInstallPayload.result.library), JSON.stringify({ libraryPaths: renvRuntimeLibraries, selectedLibrary: renvInstallPayload.result.library }));
    assert.equal(renvRuntimeLibraries.includes(ordinaryLibrary), false, JSON.stringify({ libraryPaths: renvRuntimeLibraries, previousLibrary: ordinaryLibrary }));
    const afterRenvInstallKernelEpoch = kernelEpoch(afterRenvInstall);
    assert.equal(afterRenvInstall.runtime.busy, false, JSON.stringify(afterRenvInstall.runtime));
    assert.equal(afterRenvInstall.runtime.activeRunId, null, JSON.stringify(afterRenvInstall.runtime));
    for (const cell of afterRenvInstall.cells.filter(cell => cell.type === "code")) {
      assert.equal(cell.status, "stale", JSON.stringify(cell));
      const previousOutputs = outputsBeforeRenv.get(cell.id);
      assert.ok(previousOutputs, "renv restart must retain a preinstall output set");
      assert.deepEqual(cell.outputs, previousOutputs, "renv restart retains exact preinstall outputs");
      assert.ok(cell.outputs.every(output => output.kernelEpoch === beforeRenvInstallEpoch), JSON.stringify(cell.outputs));
      assert.ok(cell.outputs.every(output => output.kernelEpoch !== afterRenvInstallKernelEpoch), "renv restart must not expose new-epoch output before rerun");
    }
    const renvRerun = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: afterRenvInstall.documentRevision });
    const renvRerunResult = await settle(harness, renvRerun);
    assert.equal(renvRerunResult.status, "done", JSON.stringify(renvRerunResult));
    current = await harness.snapshot();
    assert.ok(current.cells.filter(cell => cell.type === "code").every(cell => cell.status === "done" && cell.outputs.length > 0), "renv values require an explicit rerun after install");
    const renvProbe = await jsonProbe(harness, first.id, current);
    assert.equal(renvProbe.loaded, true, JSON.stringify(renvProbe));
    assert.equal(typeof renvProbe.path, "string", JSON.stringify(renvProbe));
    assert.notEqual(renvProbe.path, "ALDER_HTMLWIDGETS_NOT_INSTALLED");
    assert.notEqual(renvProbe.path, "ALDER_HTMLWIDGETS_NO_LIBRARY_MATCH");
    assert.equal(renvProbe.path, await realpath(join(renvInstallPayload.result.library, "htmlwidgets")), JSON.stringify({ probe: renvProbe, selectedLibrary: renvInstallPayload.result.library }));
    assert.ok(renvProbe.libraryPaths.includes(renvInstallPayload.result.library), JSON.stringify({ probe: renvProbe, selectedLibrary: renvInstallPayload.result.library }));
    const longRun = await harness.nextCommand({ type: "run", scope: "all", expectedDocumentRevision: current.documentRevision });
    const busySnapshot = await waitForSnapshot(harness, value => value.runtime?.busy === true, 5000);
    assert.equal(typeof busySnapshot.runtime?.activeRunId, "string", JSON.stringify(busySnapshot.runtime));
    const busyInstall = await expectFailure(harness, { type: "packages-install", packages: ["AlderSmokeBusyPackage"], expectedDocumentRevision: current.documentRevision, kernelEpoch: kernelEpoch(current) });
    assert.equal(busyInstall.code, "run_in_progress", JSON.stringify(busyInstall));
    const interrupt = await harness.nextCommand({ type: "interrupt", runId: busySnapshot.runtime.activeRunId });
    const interruptResult = await settle(harness, interrupt);
    assert.equal(interruptResult.status, "done", JSON.stringify(interruptResult));
    const longRunResult = await settle(harness, longRun);
    assert.ok(["cancelled", "interrupted"].includes(longRunResult.status), JSON.stringify(longRunResult));
    current = await waitForExecutionReady(harness);
    assert.equal(current.runtime?.busy, false, JSON.stringify(current.runtime));
    assert.ok(current.runtime?.rEnvironment && typeof current.runtime.rEnvironment === "object");
    return {
      id: "format-packages",
      identity: {
        artifact: { manifestSha256: await manifestHash(ctx.applicationRoot), air: { path: airPath, bytes: airInfo.size, sha256: await fileHash(airPath) }, notebook: harness.canonical },
        format: { valid: formatResult.status, invalid: invalidFormatResult.error?.code, race: staleFormatResult.code, declarationConflict: staleDeclaration.code, markdownCell: markdownCell.id, formattedBytes: sha256(formattedBytes), unchangedAfterInvalid: true },
        packages: { mode: renvStatus.mode, declarationsSha256: sha256(Buffer.from(packageText)), install: installPayload.status, progress: true, progressBytes: Buffer.byteLength(progressOutput, "utf8"), failedInstall: failedInstall.code, failedMutatedLibrary: failedInstallPayload.mutatedLibrary, busyInstall: busyInstall.code, cancellation: longRunResult.status, library: installPayload.status.library, lockfile: renvStatus.lockfile, helperLibrary, helperInventory: { entries: helperInventoryEntries.length, sha256: helperInventoryBefore, unchangedAfterPak: helperInventoryAfterPak === helperInventoryBefore, unchangedAfterFailure: helperInventoryAfterFailure === helperInventoryBefore }, ordinaryLibrary, projectLibraryInventory: { entries: projectLibraryInventoryAfterPak.length, sha256: projectLibraryInventoryBeforeRenv, unchangedAfterRenvFailure: inventoryDigest(projectLibraryInventoryAfterFailure) === projectLibraryInventoryBeforeRenv } },
        packageProgress: packageProgressEvidence,
        packageRenv: { mode: renvInstallPayload.result.mode, install: renvInstallPayload.result.status, library: renvLibrary, package: renvPackageRecord, isolated: true, sourcePreserved: true, kernelRestarted: kernelEpoch(afterRenvInstall) !== beforeRenvInstallEpoch, analyzerGenerationChanged: afterRenvInstall.runtime.analysisEnvironmentId !== beforeRenvInstallAnalysisEnvironment, explicitRerun: renvRerunResult.status },
        sourcePreserved: { pak: true, renv: true },
        runtime: { epoch: current.epoch, kernelEpoch: kernelEpoch(current), rEnvironment: current.runtime.rEnvironment },
      },
    };
  } finally {
    await harness.close();
  }
}

async function openOperationEventStream(harness, baseline) {
  assert.equal(typeof harness?.origin, "string");
  assert.equal(typeof harness?.session?.cookie, "string");
  assert.equal(typeof harness?.session?.csrf, "string");
  assert.equal(typeof baseline?.epoch, "string");
  assert.equal(Number.isSafeInteger(baseline?.cursor) && baseline.cursor >= 0, true);
  const target = new URL("/api/socket", harness.origin);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const events = [];
  let fatal = null;
  let closed = false;
  let readyDone = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let wake = null;
  const signal = () => {
    const listener = wake;
    wake = null;
    listener?.();
  };
  const socket = openLogicalWebSocket(WebSocket, target, {
    origin: harness.origin,
    headers: { Cookie: harness.session.cookie },
    perMessageDeflate: false,
    handshakeTimeout: 5_000,
  });
  const fail = cause => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    fatal ??= error;
    if (!readyDone) {
      readyDone = true;
      readyReject(error);
    }
    signal();
    if (!closed && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) socket.close(1011, error.message.slice(0, 120));
  };
  socket.on("open", () => {
    try {
      socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, leaseId: harness.session.leaseId, clientId: harness.session.clientId, csrf: harness.session.csrf, epoch: baseline.epoch, cursor: baseline.cursor }));
    } catch (error) {
      fail(error);
    }
  });
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("event stream sent a binary frame");
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const frame = JSON.parse(bytes.toString("utf8"));
      assert.ok(frame && typeof frame === "object" && !Array.isArray(frame), "event stream frame must be an object");
      if (frame.type === "recovery") {
        assert.equal(frame.protocolVersion, 2, JSON.stringify(frame));
        assert.ok(frame.recovery && typeof frame.recovery === "object" && !Array.isArray(frame.recovery), JSON.stringify(frame));
        if (!readyDone) {
          readyDone = true;
          readyResolve();
        }
        return;
      }
      if (frame.type === "event") {
        if (!readyDone || fatal !== null) throw new Error("event stream event arrived before recovery");
        const event = frame.event;
        assert.ok(event && typeof event === "object" && !Array.isArray(event), "event stream event must be an object");
        assert.equal(event.protocol, "alder-host-v2", JSON.stringify(event));
        assert.equal(event.epoch, harness.session.epoch, JSON.stringify(event));
        assert.equal(Number.isSafeInteger(event.cursor) && event.cursor >= 0, true, JSON.stringify(event));
        assert.equal(typeof event.type, "string", JSON.stringify(event));
        assert.ok(Object.hasOwn(event, "payload"), JSON.stringify(event));
        if (event.cursor > baseline.cursor) {
          events.push(event);
          signal();
        }
        return;
      }
      if (frame.type === "heartbeat" || frame.type === "pong") return;
      if (frame.type === "error") throw new Error("event stream error: " + JSON.stringify(frame.error));
      throw new Error("unknown event stream frame: " + JSON.stringify(frame));
    } catch (error) {
      fail(error);
    }
  });
  socket.on("error", error => { if (!closed) fail(error); });
  socket.on("close", () => { if (!closed) fail(new Error("event stream closed before smoke completion")); });
  await ready;
  const waitForOperationPhase = async (operationId, phase) => {
    assert.equal(typeof operationId, "string");
    assert.equal(typeof phase, "string");
    const deadline = Date.now() + 300_000;
    for (;;) {
      if (fatal !== null) throw fatal;
      for (const event of events) {
        if (event.type !== "operation") continue;
        const record = event.payload;
        if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== operationId) continue;
        if (event.operationId !== undefined) assert.equal(event.operationId, operationId, JSON.stringify(event));
        if (record.progress?.phase === phase) return { operationId, phase, cursor: event.cursor };
        if (TERMINAL.has(record.status)) throw new Error("operation_phase_timeout: " + operationId + ":" + phase);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("operation_phase_timeout: " + operationId + ":" + phase);
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (wake === listener) wake = null;
          reject(new Error("operation_phase_timeout: " + operationId + ":" + phase));
        }, remaining);
        const listener = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (wake === listener) wake = null;
          resolve();
        };
        wake = listener;
      });
    }
  };
  const waitForOperation = async (operationId, terminalStatus) => {
    assert.equal(typeof operationId, "string");
    assert.equal(typeof terminalStatus, "string");
    const inspect = () => {
      let output = null;
      let terminal = null;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.type !== "operation") continue;
        const record = event.payload;
        if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== operationId) continue;
        if (event.operationId !== undefined) assert.equal(event.operationId, operationId, JSON.stringify(event));
        if (output === null && record.progress?.phase === "output") output = { event, record, index };
        if (terminal === null && TERMINAL.has(record.status)) terminal = { event, record, index };
      }
      if (terminal === null) return null;
      assert.equal(terminal.record.status, terminalStatus, JSON.stringify(terminal.record));
      assert.ok(output !== null, "packages-install must stream an output progress event before terminal");
      assert.ok(output.index < terminal.index, "output progress must precede the terminal operation event");
      assert.ok(output.event.cursor < terminal.event.cursor, "output progress cursor must precede the terminal operation event");
      const progress = output.record.progress;
      assert.equal(progress.phase, "output", JSON.stringify(progress));
      assert.ok(progress.text !== undefined || progress.data !== undefined, JSON.stringify(progress));
      if (progress.text !== undefined) {
        assert.equal(typeof progress.text, "string", JSON.stringify(progress));
        assert.ok(Buffer.byteLength(progress.text, "utf8") <= 64 * 1024, "streamed progress text must be byte-bounded");
      }
      if (progress.stream !== undefined) assert.ok(["stdout", "stderr"].includes(progress.stream), JSON.stringify(progress));
      if (progress.data !== undefined) {
        const encoded = JSON.stringify(progress.data);
        assert.equal(typeof encoded, "string", JSON.stringify(progress));
        assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024, "streamed progress data must be byte-bounded");
      }
      return {
        operationId,
        outputCursor: output.event.cursor,
        terminalCursor: terminal.event.cursor,
        outputProgress: { phase: progress.phase, stream: progress.stream ?? null, textBytes: typeof progress.text === "string" ? Buffer.byteLength(progress.text, "utf8") : 0, dataPresent: progress.data !== undefined },
        terminalStatus: terminal.record.status,
        eventCount: events.length,
      };
    };
    const deadline = Date.now() + 300_000;
    for (;;) {
      if (fatal !== null) throw fatal;
      const result = inspect();
      if (result !== null) return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("operation_event_timeout: " + operationId);
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (wake === listener) wake = null;
          reject(new Error("operation_event_timeout: " + operationId));
        }, remaining);
        const listener = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (wake === listener) wake = null;
          resolve();
        };
        wake = listener;
      });
    }
  };
  return {
    waitForOperationPhase,
    waitForOperation,
    async close() {
      closed = true;
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
        timer.unref?.();
        socket.once("close", () => { clearTimeout(timer); resolve(); });
        try { socket.close(1000, "smoke complete"); } catch { clearTimeout(timer); resolve(); }
      });
    },
  };
}
async function sourceData(harness) {
  const source = value(await harness.query({ type: "source" }));
  assert.ok(Array.isArray(source), "source query must return an array");
  for (const cell of source) {
    assert.ok(cell && typeof cell === "object" && !Array.isArray(cell));
    assert.deepEqual(Object.keys(cell).sort(), ["body", "id", "options", "revision", "type"].sort());
    assert.equal(typeof cell.id, "string");
    assert.ok(cell.type === "code" || cell.type === "markdown");
    assert.ok(Array.isArray(cell.body));
    assert.equal(Number.isSafeInteger(cell.revision) && cell.revision >= 0, true);
    assert.ok(cell.options && typeof cell.options === "object" && !Array.isArray(cell.options));
  }
  return source;
}
async function installedPackageRecord(library, name) {
  const description = await readFile(join(library, name, "DESCRIPTION"), "utf8");
  const version = description.match(/^Version:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof version, "string", `installed ${name} package must declare a version`);
  return { Package: name, Version: version, Source: "Repository", Repository: "CRAN" };
}

function assertSourceMatchesCells(source, cells) {
  assert.equal(source.length, cells.length, "consumer source cell count must match snapshot");
  for (let index = 0; index < source.length; index += 1) {
    const actual = source[index];
    const expected = cells[index];
    assert.deepEqual({ id: actual.id, type: actual.type, body: actual.body, revision: actual.revision, options: actual.options }, { id: expected.id, type: expected.type, body: expected.body, revision: expected.revision, options: expected.options });
  }
}
function value(result) {
  assert.ok(result && typeof result === "object" && Object.hasOwn(result, "result"), "query must return canonical envelope");
  assert.deepEqual(Object.keys(result).sort(), ["cursor", "documentRevision", "epoch", "result"].sort());
  return result.result;
}

function kernelEpoch(snap) { assert.equal(typeof snap.runtime?.kernelEpoch, "string", "package operations require an active kernel epoch"); return snap.runtime.kernelEpoch; }
async function settle(harness, receipt) {
  const operationId = receipt?.operationId;
  assert.equal(typeof operationId, "string", JSON.stringify(receipt));
  const deadline = Date.now() + 300_000;
  for (;;) {
    const operation = value(await harness.query({ type: "operation", operationId }));
    if (operation && TERMINAL.has(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error("operation_timeout: " + operationId);
    await delay(100);
  }
}
async function expectFailure(harness, command) {
  try {
    const receipt = await harness.nextCommand(command);
    const direct = receipt?.error?.code;
    if (direct) return { code: direct, receipt };
    const operation = await settle(harness, receipt);
    assert.equal(operation.status, "error", JSON.stringify(operation));
    const code = operation.error?.code;
    assert.equal(typeof code, "string", JSON.stringify(operation));
    return { code, receipt, operation };
  } catch (error) {
    const code = error?.code;
    assert.equal(typeof code, "string", String(error));
    return { code, error };
  }
}
async function jsonProbe(harness, cellId, snap) {
  const records = value(await harness.query({ type: "outputs", cellId }));
  assert.ok(Array.isArray(records), "JSON probe query must return canonical output records");
  const epoch = snap.runtime?.kernelEpoch;
  assert.equal(typeof epoch, "string", JSON.stringify(snap.runtime));
  const candidates = records.filter(record => record?.cellId === cellId && record.kernelEpoch === epoch && record.data?.kind === "text" && typeof record.data.text === "string" && record.data.text.startsWith("{\"path\""));
  assert.equal(candidates.length, 1, JSON.stringify({ cellId, epoch, records: records.map(record => ({ cellId: record?.cellId, kernelEpoch: record?.kernelEpoch, kind: record?.data?.kind, textType: typeof record?.data?.text })) }));
  const data = candidates[0].data;
  assert.deepEqual(Object.keys(data).sort(), ["kind", "text", "truncated"].sort());
  assert.equal(data.truncated, false, JSON.stringify(data));
  let probe;
  try {
    probe = JSON.parse(data.text);
  } catch (error) {
    assert.fail("JSON probe output is not valid serialized JSON: " + String(error));
  }
  assert.ok(probe && typeof probe === "object" && !Array.isArray(probe), JSON.stringify(probe));
  assert.deepEqual(Object.keys(probe).sort(), ["libraryPaths", "loaded", "path"].sort());
  assert.equal(typeof probe.path, "string", JSON.stringify(probe));
  assert.equal(typeof probe.loaded, "boolean", JSON.stringify(probe));
  assert.ok(Array.isArray(probe.libraryPaths) && probe.libraryPaths.every(path => typeof path === "string"), JSON.stringify(probe));
  return probe;
}
async function waitForSnapshot(harness, predicate, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await harness.snapshot();
    if (predicate(current)) return current;
    if (Date.now() >= deadline) throw new Error("snapshot_wait_timeout");
    await delay(100);
  }
}
async function verifyManifestInventory(expected, root, prefix) {
  const actual = (await collectFileInventory(root)).map(file => ({ ...file, path: prefix + file.path }));
  const expectedEntries = expected.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
  const sortEntries = (a, b) => a.path.localeCompare(b.path);
  actual.sort(sortEntries);
  expectedEntries.sort(sortEntries);
  assert.deepEqual(actual, expectedEntries, "staged helper inventory changed");
  return inventoryDigest(actual);
}
async function collectFileInventory(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: path.slice(root.length + 1).split(String.fromCharCode(92)).join("/"), bytes: bytes.byteLength, sha256: sha256(bytes) });
      } else {
        throw new Error("inventory_special_file: " + path);
      }
    }
  }
  await walk(root);
  return files;
}
function inventoryDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.path + "\0" + file.bytes + "\0" + file.sha256 + "\n");
  return hash.digest("hex");
}

async function manifestHash(root) {
  return createHash("sha256").update(await readFile(join(root, "resources", "manifest.json"))).digest("hex");
}
async function fileHash(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
