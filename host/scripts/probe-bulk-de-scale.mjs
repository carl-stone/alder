import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createHarness, delay, waitForExecutionReady } from "./smoke-scenarios/_common.mjs";
import { openInteractiveBrowser } from "../test-support/live-browser.mjs";

const ID = "bulk-de-scale";
const EDIT_MARKER = "# Scale review: edited at the end of the notebook.";
const REQUIRED_PACKAGES = ["alder", "edgeR", "limma", "statmod", "ggplot2"];
const DEFAULT_SOURCE = resolve(fileURLToPath(new URL("../../dev/examples/bulk-differential-expression.R", import.meta.url)));

/**
 * Run the large differential-expression fixture through the installed
 * Node/controller application. This is intentionally a host-only probe: there
 * is no R controller, offline evaluator, or fake engine in this path.
 */
export async function run(ctx, { sourcePath = DEFAULT_SOURCE } = {}) {
  assert.ok(ctx && typeof ctx === "object");
  assert.equal(typeof ctx.applicationRoot, "string");
  assert.ok(ctx.manifest && typeof ctx.manifest === "object");
  assert.equal(typeof ctx.evidence, "string");
  const evidence = resolve(ctx.evidence);
  const source = resolve(sourcePath);
  await mkdir(evidence, { recursive: true });
  const sourceBytes = await readFile(source);
  const sourceSha256 = digest(sourceBytes);
  const sourceText = sourceBytes.toString("utf8");
  const lines = sourceLines(sourceText);
  const codeLines = lines.filter(line => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  }).length;
  const fixtureCells = (sourceText.match(/^# %%/gm) ?? []).length;
  const checks = {};
  const timings = {};
  let harness;
  let browser;
  let shutdownRequested = false;
  let thrown;
  let failure = null;
  let cleanupInfo = null;
  let browserPageErrors = [];
  let cleanupFailure = null;
  let result;

  const writeJson = async (name, value) => {
    await writeFile(join(evidence, name), JSON.stringify(value, null, 2) + "\n", "utf8");
  };
  const check = async (name, value, message = "check failed") => {
    checks[name] = value === true;
    await writeJson("checks.json", checks);
    if (!checks[name]) throw new Error(message + ": " + name);
  };
  const timed = async (name, operation) => {
    const started = performance.now();
    const value = await operation();
    timings[name] = (performance.now() - started) / 1000;
    await writeJson("timings.json", timings);
    return value;
  };

  await writeJson("input.json", {
    source,
    bytes: sourceBytes.byteLength,
    lines: lines.length,
    code_lines: codeLines,
    fixture_cells: fixtureCells,
    source_sha256: sourceSha256,
    required_packages: REQUIRED_PACKAGES,
    package: {
      application_root: resolve(ctx.applicationRoot),
      source_commit: ctx.manifest.sourceCommit,
      source_tree_sha256: ctx.manifest.sourceTreeSha256,
      host_protocol: ctx.manifest.hostProtocol,
      engine_protocol: ctx.manifest.engineProtocol,
    },
  });

  try {
    const harnessOptions = { id: ID, source: sourceText };
    if (typeof ctx.rscript === "string") harnessOptions.rscript = ctx.rscript;
    harness = await createHarness(ctx, harnessOptions);
    const initial = await timed("runtime_ready_seconds", () => waitForExecutionReady(harness));
    await writeJson("analysis-diagnostics.json", initial.cells.flatMap(cell => (cell.diagnostics ?? []).map(diagnostic => ({ cellId: cell.id, ...diagnostic }))));
    await writeJson("state-initial.json", initial);

    await check("at_least_1000_actual_R_lines", codeLines >= 1000, "fixture is too small");
    await check("at_least_60_cells", initial.cells.length >= 60, "fixture has too few cells");
    await check("fixture_cell_count_matches_source", initial.cells.length === fixtureCells, "host cell count differs from source markers");
    await check("all_cells_in_execution_plan", hasExecutionPlan(initial), "host graph has no complete execution plan");
    await check("no_static_diagnostics", initial.cells.every(cell => (cell.diagnostics ?? []).length === 0), "analyzer reported diagnostics");
    await check("required_runtime_is_ready", initial.runtime.executionReady === true && initial.runtime.kernelState === "ready" && initial.runtime.analyzerState === "ready", "host runtime is not ready");

    browser = await timed("browser_open_seconds", () => openInteractiveBrowser(harness, {
      evidence: join(evidence, "browser"),
      name: ID,
    }));
    await installBrowserErrorHooks(browser);
    const initialBrowser = await browser.observe("initial");
    await writeJson("browser-initial.json", initialBrowser.state);
    await check("browser_notebook_landmark", initialBrowser.state.controls?.notebook === true, "browser notebook landmark is missing");
    await check("browser_save_control", initialBrowser.state.controls?.save === true, "browser Save control is missing");
    await check("browser_run_all_control", initialBrowser.state.controls?.["run-all"] === true, "browser Run all control is missing");
    await check("browser_stop_control", initialBrowser.state.controls?.stop === true, "browser Stop control is missing");
    await check("browser_settings_control", await browserHasSelector(browser, "#settings"), "browser settings control is missing");
    await browser.wait("document.querySelectorAll('.cell[data-cell]').length === " + initial.cells.length, 60_000);

    await check("native_Run_all_click", await browser.click("#run-all").then(() => true), "native Run all click failed");
    await waitForSnapshot(harness, value => value.runtime?.busy === true || value.cells.some(cell => cell.status === "running"), "full notebook execution did not start", 30_000);
    const before = await timed("browser_full_run_seconds", () => waitForSettled(harness));
    await writeJson("state-before.json", before);
    const finalBefore = cellByName(before, "final_summary");
    const defaultSummary = outputText(finalBefore);
    const defaultCounts = summaryCounts(defaultSummary);
    await check("browser_summary_matches_fixture_contract", /^BULK_DE_COMPLETE genes=6000 samples=24 tested=[1-9][0-9]* selected=[0-9]+ discoveries=[0-9]+$/.test(defaultCounts.text), "final summary has the wrong scientific contract");
    await check("all_code_cells_done", allCodeCellsDone(before), "one or more code cells did not finish");
    await check("no_cell_warnings", noCellWarnings(before), "the fixture emitted a warning");
    await check("no_editor_or_runtime_errors", Object.keys(before.editorDiagnostics ?? {}).length === 0 && before.lastActionError === null, "host reported editor/runtime errors");

    const images = await timed("plot_wait_seconds", async () => {
      await browser.wait("(()=>{const images=[...document.querySelectorAll('.cell img')];return images.length>=15&&images.every(image=>image.complete&&image.naturalWidth>0)})()", 120_000);
      return browser.browser.evaluate("[...document.querySelectorAll('.cell img')].map(image=>({src:image.getAttribute('src'),complete:image.complete,width:image.naturalWidth}))");
    });
    await writeJson("rendered-images.json", images);
    await check("at_least_15_rendered_plots", Array.isArray(images) && images.length >= 15, "too few rendered plot images");
    await check("all_plot_images_loaded", Array.isArray(images) && images.every(image => image.complete === true && image.width > 0), "a plot image did not load");

    const outputQuery = await harness.query({ type: "outputs" });
    assert.deepEqual(Object.keys(outputQuery).sort(), ["cursor", "documentRevision", "epoch", "result"]);
    const records = outputQuery.result;
    await writeJson("outputs.json", records);
    await check("typed_output_records_present", Array.isArray(records) && records.length > 0, "host returned no output records");
    const stateLatency = [];
    for (let index = 0; index < 3; index += 1) {
      const started = performance.now();
      await harness.query({ type: "events", epoch: null, cursor: null });
      stateLatency.push((performance.now() - started) / 1000);
    }
    await writeJson("state-request-timings.json", { seconds: stateLatency });
    await captureCell(browser, evidence, before, "library_size_plot", "01-qc");
    await captureCell(browser, evidence, before, "pca_plot", "02-pca");
    await captureCell(browser, evidence, before, "volcano_plot", "03-volcano-default");
    await captureCell(browser, evidence, before, "top_gene_heatmap", "04-heatmap");
    await captureCell(browser, evidence, before, "final_summary", "05-final-summary");

    await browser.browser.evaluate("window.__bulkRunning=[];window.__bulkUnsubscribe=window.__alderHost?.client?.subscribe?.((_document,event)=>{if(event?.type==='cell-started'&&event.cellId)window.__bulkRunning.push(event.cellId)});true");
    const effectCell = cellByName(before, "effect_control");
    const fitCell = cellByName(before, "quasi_likelihood_fit");
    const effectWidget = widgetPayload(effectCell, "effect_cutoff");
    await check("effect_control_widget_present", effectWidget !== null, "effect cutoff widget is missing");
    await scrollCell(browser, effectCell.id);
    const sliderSelector = cellSelector(effectCell.id) + " input[type=range]";
    await browser.wait("Boolean(document.querySelector(" + JSON.stringify(sliderSelector) + "))", 30_000);
    await check("native_effect_slider_focus", await browser.click(sliderSelector).then(() => true), "native effect slider click failed");
    await sendKey(browser, "End", "End", 35);

    const strict = await timed("threshold_update_seconds", () => waitForSnapshot(harness, value => {
      const current = cellByName(value, "effect_control");
      const widget = widgetPayload(current, "effect_cutoff");
      const summary = summaryCounts(outputText(cellByName(value, "final_summary")));
      return Number(widgetValue(widget)) === 2 && value.runtime?.busy === false && summary.selected !== null && defaultCounts.selected !== null && summary.selected < defaultCounts.selected;
    }, "strict effect threshold", 120_000));
    await writeJson("state-strict.json", strict);
    const strictSummary = summaryCounts(outputText(cellByName(strict, "final_summary")));
    await check("strict_cutoff_reduces_selected_genes", strictSummary.selected !== null && defaultCounts.selected !== null && strictSummary.selected < defaultCounts.selected, "strict threshold did not reduce selected genes");
    await check("model_outputs_unchanged_after_threshold", JSON.stringify(cellByName(before, "quasi_likelihood_fit").outputs) === JSON.stringify(cellByName(strict, "quasi_likelihood_fit").outputs), "threshold unexpectedly refit the model");
    const descendants = dependentClosure(strict.graph?.edges, effectCell.id);
    await check("model_not_in_threshold_descendants", !descendants.has(fitCell.id), "threshold graph includes the model fit");
    const running = await browser.browser.evaluate("window.__bulkRunning ?? []");
    await writeJson("threshold-running-cells.json", running);
    await check("no_observed_model_refit", Array.isArray(running) && !running.includes(fitCell.id), "threshold update refit the model");
    await captureCell(browser, evidence, strict, "volcano_plot", "06-volcano-strict");

    await browser.browser.evaluate("window.__alderHost.client.setWidget('effect_cutoff',[],{value:0.5},'editor');true");
    const restored = await waitForSnapshot(harness, value => {
      const current = cellByName(value, "final_summary");
      return value.runtime?.busy === false && summaryCounts(outputText(current)).text === defaultCounts.text;
    }, "restore default threshold", 120_000);
    await writeJson("state-restored.json", restored);

    const finalCellBeforeEdit = cellByName(restored, "final_summary");
    const priorSources = sourceProjection(restored).filter(cell => cell.id !== finalCellBeforeEdit.id);
    await focusAppendEditor(browser, finalCellBeforeEdit.id, "\n" + EDIT_MARKER + "\n");
    await sendKey(browser, "s", "KeyS", 2, 83);
    await waitForFileContains(harness.notebook, EDIT_MARKER, 30_000);
    const saved = await waitForSnapshot(harness, value => value.dirty === false && cellByName(value, "final_summary").body.join("\n").includes(EDIT_MARKER), "save acknowledgment", 30_000);
    const savedBytes = await readFile(harness.notebook);
    await writeFile(join(evidence, "saved-notebook.R"), savedBytes);
    await check("save_preserves_other_64_cells", sameJson(priorSources, sourceProjection(saved).filter(cell => cell.id !== finalCellBeforeEdit.id)), "save changed another cell");
    await check("original_fixture_unchanged", Buffer.compare(sourceBytes, await readFile(source)) === 0, "source fixture was modified");
    await check("reload_without_unsaved_changes_dialog", await reloadBrowser(browser, initial.cells.length), "browser reload did not complete");
    await installBrowserErrorHooks(browser);
    await scrollCell(browser, finalCellBeforeEdit.id);
    await browser.wait("Boolean(window.__alderEditors?.has(" + JSON.stringify("cell:" + finalCellBeforeEdit.id) + "))", 30_000);
    const reloadedSource = await browser.browser.evaluate("window.__alderEditors.get(" + JSON.stringify("cell:" + finalCellBeforeEdit.id) + ").getDoc()");
    await check("reload_retains_saved_edit", typeof reloadedSource === "string" && reloadedSource.includes(EDIT_MARKER), "reload lost the saved edit");

    const repeatBefore = await harness.snapshot();
    await check("reloaded_native_Run_all_click", await browser.click("#run-all").then(() => true), "native repeat Run all click failed");
    await waitForSnapshot(harness, value => value.runtime?.busy === true || value.cells.some(cell => cell.status === "running"), "repeat notebook execution did not start", 30_000);
    const repeat = await timed("browser_repeat_run_seconds", () => waitForSettled(harness));
    await writeJson("state-final.json", repeat);
    await check("repeat_run_same_scientific_result", /^BULK_DE_COMPLETE genes=6000 samples=24 tested=[1-9][0-9]* selected=[0-9]+ discoveries=[0-9]+$/.test(summaryCounts(outputText(cellByName(repeat, "final_summary"))).text), "repeat run changed the scientific summary");
    await check("repeat_run_reexecuted_model", JSON.stringify(cellByName(repeatBefore, "quasi_likelihood_fit").outputs) !== JSON.stringify(cellByName(repeat, "quasi_likelihood_fit").outputs), "repeat Run all did not produce a new model result");
    await captureCell(browser, evidence, repeat, "final_summary", "07-reloaded-summary");
    browserPageErrors = await browser.browser.evaluate("window.__bulkBrowserErrors ?? []");
    await writeJson("browser-page-errors.json", browserPageErrors);
    await check("no_browser_console_errors", Array.isArray(browserPageErrors) && browserPageErrors.length === 0, "browser reported a console/page error");
    await check("no_browser_exceptions", browser.browser.errors.length === 0, "browser reported a runtime exception");

    await check("native_Shutdown_click", await browser.click("#shutdown").then(() => true), "native Shutdown click failed");
    shutdownRequested = true;
    const shutdownExited = await waitForChildExit(harness.child, 30_000);
    await check("CLI_shutdown_exit_zero", shutdownExited && harness.child.exitCode === 0, "CLI did not shut down cleanly");
    const stderr = (await harness.stderr.text()).join("");
    await check("CLI_stderr_empty", stderr.length === 0, "CLI emitted stderr");
    await writeJson("complete.json", { complete: true, checks: Object.keys(checks).length });
    result = {
      id: ID,
      identity: {
        artifact: {
          sourceCommit: ctx.manifest.sourceCommit,
          sourceTreeSha256: ctx.manifest.sourceTreeSha256,
          hostProtocol: ctx.manifest.hostProtocol,
          engineProtocol: ctx.manifest.engineProtocol,
        },
        fixture: { source, bytes: sourceBytes.byteLength, sha256: sourceSha256, cells: initial.cells.length, codeLines },
        runtime: {
          rscript: harness.selectedR,
          epoch: initial.epoch,
          kernelEpoch: repeat.runtime?.kernelEpoch,
          rEnvironment: repeat.runtime?.rEnvironment,
        },
      },
    };
  } catch (error) {
    thrown = error;
    failure = errorRecord(error);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (error) { cleanupFailure ??= error; }
    }
    if (harness) {
      try {
        cleanupInfo = await harness.close();
      } catch (error) {
        if (shutdownRequested && harness.child.exitCode === 0 && expectedShutdownCloseError(error)) {
          cleanupInfo = { shutdown: true, forced: false, release: "host retired before lease release" };
        } else {
          cleanupFailure ??= error;
        }
      }
    }
    await writeJson("browser-channels.json", {
      exceptions: browser?.browser?.errors ?? [],
      pageErrors: browserPageErrors,
    });
    await writeJson("cleanup.json", cleanupInfo ?? { error: cleanupFailure ? errorRecord(cleanupFailure) : null });
    const passed = thrown === undefined && cleanupFailure === null && Object.values(checks).every(value => value === true);
    await writeJson("result.json", {
      id: ID,
      passed,
      checks,
      timings,
      failure,
      cleanup: cleanupInfo ?? (cleanupFailure ? { error: errorRecord(cleanupFailure) } : null),
      source_sha256: sourceSha256,
    });
  }
  if (thrown !== undefined) throw thrown;
  if (cleanupFailure !== null) throw cleanupFailure;
  assert.ok(result);
  return result;
}

function sourceLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function errorRecord(error) {
  return { name: error?.name ?? "Error", message: String(error?.message ?? error), stack: error?.stack ?? null };
}
function errorMessages(error) {
  const values = [String(error?.message ?? error)];
  if (error instanceof AggregateError) for (const cause of error.errors) values.push(...errorMessages(cause));
  return values;
}
function expectedShutdownCloseError(error) {
  const text = errorMessages(error).join("\n");
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|network error/i.test(text)
    && !/did not retire|SIGKILL|forced|tree cleanup/i.test(text);
}
function allCodeCellsDone(snapshot) {
  return snapshot.cells.every(cell => cell.type !== "code" || cell.status === "done");
}
function noCellWarnings(snapshot) {
  return snapshot.cells.every(cell => !(cell.log ?? []).some(line => /^Warning:/.test(line))
    && !(cell.outputs ?? []).some(record => hasPayloadKind(record.data, "warning")));
}
function hasPayloadKind(value, kind) {
  if (!value || typeof value !== "object") return false;
  if (value.kind === kind) return true;
  return Array.isArray(value.children) && value.children.some(child => hasPayloadKind(child, kind));
}
function hasExecutionPlan(snapshot) {
  const ids = new Set(snapshot.cells.map(cell => cell.id));
  const nodes = new Set(snapshot.graph?.nodes ?? []);
  const order = snapshot.graph?.topologicalOrder;
  return order !== null && Array.isArray(order) && order.length === ids.size
    && nodes.size === ids.size && [...ids].every(id => nodes.has(id) && order.includes(id));
}
function cellByName(snapshot, name) {
  const matches = snapshot.cells.filter(cell => cell.options?.name === name);
  assert.equal(matches.length, 1, "expected one cell named " + name);
  return matches[0];
}
function outputText(cell) {
  return stringsFrom((cell.outputs ?? []).map(record => record.data)).join("\n");
}
function stringsFrom(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringsFrom);
}
function summaryCounts(text) {
  const match = /BULK_DE_COMPLETE genes=(\d+) samples=(\d+) tested=(\d+) selected=(\d+) discoveries=(\d+)/.exec(text);
  return {
    text: match?.[0] ?? "",
    genes: match ? Number(match[1]) : null,
    samples: match ? Number(match[2]) : null,
    tested: match ? Number(match[3]) : null,
    selected: match ? Number(match[4]) : null,
    discoveries: match ? Number(match[5]) : null,
  };
}
function widgetPayload(cell, name) {
  const values = outputPayloads(cell).filter(payload => payload.kind === "widget" && (name === undefined || payload.name === name));
  return values.length === 1 ? values[0] : null;
}
function widgetValue(widget) {
  return widget?.spec?.value ?? widget?.value ?? null;
}
function outputPayloads(cell) {
  const values = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.kind === "string") values.push(value);
    if (Array.isArray(value.children)) value.children.forEach(visit);
    if (value.child) visit(value.child);
  };
  for (const record of cell.outputs ?? []) visit(record.data);
  return values;
}
function sourceProjection(snapshot) {
  return snapshot.cells.map(cell => ({ id: cell.id, type: cell.type, body: cell.body, options: cell.options }));
}
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function cellSelector(id) {
  return '[data-cell="' + id + '"]';
}
function dependentClosure(edges, root) {
  const result = new Set([root]);
  for (;;) {
    const next = new Set(result);
    for (const [cellId, dependencies] of Object.entries(edges ?? {})) {
      if (dependencies.some(dependency => result.has(dependency))) next.add(cellId);
    }
    if (next.size === result.size) return result;
    result.clear();
    for (const value of next) result.add(value);
  }
}
async function installBrowserErrorHooks(browser) {
  const installed = await browser.browser.evaluate("(()=>{window.__bulkBrowserErrors=[];window.addEventListener('error',event=>{window.__bulkBrowserErrors.push({type:'error',message:String(event.message??'')})},true);window.addEventListener('unhandledrejection',event=>{window.__bulkBrowserErrors.push({type:'unhandledrejection',message:String(event.reason??'')})},true);return true})()");
  assert.equal(installed, true, "browser diagnostics hook installation failed");
}
async function waitForSnapshot(harness, predicate, label, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await harness.snapshot();
    if (predicate(current)) return current;
    if (current.runtime?.kernelState === "failed" || current.runtime?.analyzerState === "failed") throw new Error(label + ": runtime failed");
    if (Date.now() >= deadline) throw new Error(label + ": timeout");
    await delay(100);
  }
}
async function waitForSettled(harness, timeout = 180_000) {
  return waitForSnapshot(harness, value => !value.runtime?.busy && allCodeCellsDone(value), "notebook execution", timeout);
}
async function browserHasSelector(browser, selector) {
  return browser.browser.evaluate("Boolean(document.querySelector(" + JSON.stringify(selector) + "))");
}
async function scrollCell(browser, id) {
  const found = await browser.browser.evaluate("(()=>{const root=[...document.querySelectorAll('.cell[data-cell]')].find(value=>value.dataset.cell===" + JSON.stringify(id) + ");if(!root)return false;root.scrollIntoView({block:'center',inline:'center'});return true})()");
  assert.equal(found, true, "browser cell is not rendered: " + id);
}
async function captureCell(browser, evidence, snapshot, name, fileName) {
  const cell = cellByName(snapshot, name);
  await scrollCell(browser, cell.id);
  await delay(100);
  const capture = await browser.browser.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(evidence, fileName + ".png"), Buffer.from(capture.data, "base64"));
}
async function sendKey(browser, key, code, windowsVirtualKeyCode, modifiers = 0) {
  await browser.browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode, modifiers });
  await browser.browser.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
}
async function focusAppendEditor(browser, id, text) {
  await scrollCell(browser, id);
  const key = JSON.stringify("cell:" + id);
  await browser.wait("Boolean(window.__alderEditors?.has(" + key + "))", 30_000);
  await browser.browser.evaluate("(()=>{const editor=window.__alderEditors.get(" + key + ");editor.focus();editor.view.dispatch({selection:{anchor:editor.getDoc().length}});return true})()");
  await browser.browser.send("Input.insertText", { text });
}
async function waitForFileContains(path, needle, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.includes(needle)) return true;
    if (Date.now() >= deadline) throw new Error("saved notebook did not contain edit");
    await delay(100);
  }
}
async function reloadBrowser(browser, cellCount) {
  await browser.browser.send("Page.reload", { ignoreCache: true });
  await browser.wait("document.readyState==='complete'&&document.querySelectorAll('.cell[data-cell]').length === " + cellCount, 60_000);
  return true;
}
async function waitForChildExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolvePromise => {
    let finished = false;
    let timer;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); resolvePromise(value); };
    timer = setTimeout(() => finish(false), timeout);
    child.once("exit", () => finish(true));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { values, positionals } = parseArgs({ options: {
    application: { type: "string" },
    evidence: { type: "string" },
    source: { type: "string" },
    rscript: { type: "string" },
  }, allowPositionals: true });
  if (positionals.length > 0) throw new Error("unexpected positional arguments: " + positionals.join(" "));
  const applicationRoot = resolve(values.application ?? process.env.ALDER_APPLICATION_ROOT ?? "host/.application");
  const manifestPath = join(applicationRoot, "resources", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const evidence = resolve(values.evidence ?? process.env.ALDER_BULK_EVIDENCE ?? join("/tmp", "alder-bulk-de-scale-" + process.pid));
  const source = resolve(values.source ?? DEFAULT_SOURCE);
  const ctx = { applicationRoot, manifest, evidence, rscript: values.rscript };
  const output = await run(ctx, { sourcePath: source });
  process.stdout.write(JSON.stringify(output) + "\n");
}
