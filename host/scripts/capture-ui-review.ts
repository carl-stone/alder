import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHost } from "../src/application.js";
import { resolveApplicationResources } from "../src/resources.js";
import { Chrome } from "../test-support/chrome.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : "/tmp/alder-ui-review-checkpoint2-corrected";
const zoomDirectory = join(outputDirectory, "zoom-200");
const fixtureDirectory = await mkdtemp(join(tmpdir(), "alder-ui-review-"));
const notebookPath = join(fixtureDirectory, "methylation-analysis.R");
const preferencesPath = join(fixtureDirectory, "preferences.yaml");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(zoomDirectory, { recursive: true });
await writeFile(notebookPath, Array.from({ length: 24 }, (_, index) =>
  `# %% Cell ${index + 1}\nvalue_${index + 1} <- if (TRUE) "sample" else ${index}\nvalue_${index + 1}\n`,
).join(""));

const resources = await resolveApplicationResources(join(repo, "host/.application"));
const app = await startHost({ path: notebookPath, port: 0, runOnStartup: false, resources, preferencesPath });
let browser: Chrome | undefined;
let previewBrowser: Chrome | undefined;
const started = Date.now();

const text = (value: string) => ({ kind: "text", text: value });
const table = {
  kind: "table", handle: "review-table", nrow: 5, ncol: 4,
  page: { nrow: 5, ncol: 4, columns: ["sample", "condition", "log2 fold change", "adjusted p"],
    preview: [["A01", "control", -0.14, 0.812], ["A02", "treated", 2.83, 0.0004], ["B01", "treated", 1.47, 0.013], ["B02", "control", 0.08, 0.921], ["C01", "treated", -1.96, 0.007]],
    offset: 0, limit: 5, sort_by: "", sort_desc: false, filter: "" },
};
const plot = { kind: "image", alt: "Volcano plot of differential expression" };
const html = { kind: "html", html: '<section class="review-html"><h3>Pathway enrichment</h3><p>Interferon response and antigen presentation are enriched.</p><button type="button">Inspect pathway</button></section>', alt_text: "Pathway enrichment summary" };
const widget = { kind: "widget", name: "threshold", owner: "gallery", value: 0.4,
  spec: { kind: "slider", name: "threshold", label: "Adjusted p-value threshold", value: 0.4, min: 0, max: 1, step: 0.1 } };
const outputError = { kind: "error", message: "Model fit failed: design matrix is rank deficient" };
const traceError = { message: "Model fit failed: design matrix is rank deficient", code: "evaluation-error",
  details: { condition: { class: ["simpleError", "error", "condition"], call: "fit_model(counts, design)",
    trace: ["fit_model(counts, design)", "lm.fit(design, response)", "stop(\"rank deficient\")"] } } };

const richCells = [
  { id: "summary", name: "summary", body: ['if (TRUE) { result <- "treated"; summary(model) } # review'], status: "done", outputs: [text("Residuals:\n    Min      1Q  Median      3Q     Max\n-2.514  -0.603   0.018   0.624   2.087")] },
  { id: "results", name: "differential_expression", body: ["results |> arrange(padj)"], status: "done", outputs: [table] },
  { id: "volcano", name: "volcano_plot", body: ["plot_volcano(results)"], status: "done", outputs: [plot] },
];
const galleryCells = [{ id: "gallery", name: "output_gallery", body: ["display(scientific_results)"], status: "error",
  outputs: [html, widget, outputError, table, plot, text(Array.from({ length: 16 }, (_, i) => `Package ${String(i + 1).padStart(2, "0")} · version 4.${i}.0 · loaded and ready`).join("\n"))],
  log: ["Error in lm.fit(design, response): rank deficient"], error: traceError }];

const cases = [
  { name: "output-rich-light", width: 1440, height: 960, spec: { theme: "light", cells: richCells, editorEvidence: true } },
  { name: "output-rich-dark", width: 1440, height: 960, spec: { theme: "dark", cells: richCells, editorEvidence: true } },
  { name: "inspector-closed", width: 760, height: 900, spec: { theme: "light", cells: richCells.slice(0, 2), panel: false } },
  { name: "inspector-open", width: 760, height: 900, spec: { theme: "light", cells: richCells.slice(0, 2), panel: true, tab: "outline" } },
  { name: "empty-r-unavailable", width: 1100, height: 760, spec: { theme: "light", cells: [], runtimeBlocked: true } },
  { name: "running-stale-progress", width: 1100, height: 820, spec: { theme: "light", cells: [
    { id: "load", name: "load_data", body: ['data <- read.csv("assay.csv")'], status: "done", outputs: [text("240 samples × 18 variables")] },
    { id: "fit", name: "fit_model", body: ["fit <- lm(response ~ treatment, data)"], status: "running", outputs: [text("Previous estimate: 1.82 ± 0.31")], outputsStale: true, progress: { value: 62, total: 100, label: "Fitting model · 62%" } },
    { id: "report", name: "report", body: ["tidy(fit)"], status: "stale", outputs: [text("Output waits for the updated model.")] },
  ] } },
  { name: "error-graph", width: 1100, height: 900, spec: { theme: "light", tab: "graph", panel: true, graph: "error", cells: [
    { id: "normalize", name: "normalize", body: ["normalized <- transform(raw, value = value / zero)"], status: "error", outputs: [{ kind: "error", message: "Division produced non-finite values" }], error: { ...traceError, message: "Division produced non-finite values" }, diagnostics: [{ level: "error", code: "duplicate-definition", message: "normalized is also defined in Cell 2" }] },
    { id: "duplicate", name: "duplicate_model", body: ["normalized <- scale(raw)"], status: "error", diagnostics: [{ level: "error", code: "duplicate-definition", message: "normalized is also defined in Cell 1" }] },
    { id: "qc", name: "independent_qc", body: ["summary(raw)"], status: "done", outputs: [text("Healthy independent cell · 240 observations")] },
  ] } },
  { name: "output-gallery", width: 1200, height: 1800, spec: { theme: "light", cells: galleryCells, expandErrors: true, panel: false } },
  { name: "recovery-conflict", width: 1100, height: 820, spec: { theme: "light", cells: [{ id: "model", name: "model", body: ["fit <- lm(y ~ treatment, shared_data)"], status: "done" }], conflict: true } },
  { name: "settings-focus", width: 1100, height: 820, spec: { theme: "light", cells: richCells, settings: true } },
  { name: "long-outline", width: 1200, height: 900, spec: { theme: "light", cells: Array.from({ length: 24 }, (_, index) => ({ id: `outline-${index + 1}`, name: `analysis_${index + 1}`, body: [`value_${index + 1} <- ${index + 1}`], status: "done" })), panel: true, tab: "outline" } },
] as const;

async function ticket(view: "editor" | "preview" = "editor"): Promise<string> {
  const origin = app.server.address()!.origin;
  const response = await fetch(origin + "/api/ticket", { method: "POST", headers: { Authorization: "Bearer " + app.ownership.token, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
  if (!response.ok) throw new Error("ticket issuance failed");
  const value = await response.json() as { ticket: string };
  return origin + (view === "preview" ? "/?view=preview" : "/") + "#ticket=" + encodeURIComponent(value.ticket);
}

async function installHarness(target: Chrome, preview = false): Promise<void> {
  await target.wait(preview
    ? "Boolean(window.__alderHost?.client.document && document.querySelector('.cell'))"
    : "Boolean(window.__alderHost?.client.document && document.querySelector('.cm-content'))");
  await target.evaluate(`(() => {
    const client = window.__alderHost.client;
    const view = window.__alderHost.view;
    const base = structuredClone(client.document.snapshot);
    const makeOutput = (cellId, data, index) => ({id:cellId+'-output-'+index, sessionEpoch:base.epoch, kernelEpoch:'review-kernel', runId:'review-run', cellId, revision:0, sequence:index+1, generation:0, data, metadata:data?.kind === 'html' && data?.html ? {presentation:'inline'} : {}, truncated:false});
    const makeCell = (source, index) => ({id:source.id, type:'code', body:source.body || ['value <- '+(index+1)], options:{name:source.name || source.id}, revision:0, status:source.status || 'done', outputs:(source.outputs || []).map((data, outputIndex) => makeOutput(source.id, data, outputIndex)), outputsStale:source.outputsStale === true, progress:source.progress || null, log:source.log || [], displayOrder:undefined, error:source.error || null, defs:source.defs || [], refs:source.refs || [], selfRefs:[], diagnostics:source.diagnostics || [], analysisPending:false});
    window.__uiReview = {
      async apply(spec) {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        for (const cell of client.document.cells) {
          if (cell.conflict && !cell.tombstone) client.document.useServerVersion(cell.key);
          else if (cell.tombstone) client.document.discardLocal(cell.key);
        }
        const snapshot = structuredClone(base);
        snapshot.cursor += 1;
        snapshot.version += 1;
        snapshot.config = {...snapshot.config, theme:spec.theme || 'light'};
        snapshot.path = '/Users/carlstone/Research/methylation-analysis.R';
        snapshot.dirty = false;
        snapshot.lastActionError = null;
        snapshot.serviceErrors = {};
        snapshot.runtime = {...snapshot.runtime, documentReady:true, analyzerState:'ready', kernelState:spec.runtimeBlocked ? 'failed' : 'ready', executionReady:!spec.runtimeBlocked, busy:spec.cells?.some(cell => cell.status === 'running') || false, activeRunId:spec.cells?.some(cell => cell.status === 'running') ? 'review-run' : null,
          executionBlockedReason:spec.runtimeBlocked ? {code:'r-unavailable', message:'R execution is unavailable. Choose an R installation or restart R.'} : null};
        snapshot.cells = (spec.cells || []).map(makeCell);
        const ids = snapshot.cells.map(cell => cell.id);
        snapshot.graph = spec.graph === 'error' ? {nodes:ids, edges:{normalize:['duplicate'],duplicate:['normalize'],qc:[]}, reverseEdges:{normalize:['duplicate'],duplicate:['normalize'],qc:[]}, duplicates:{normalized:['normalize','duplicate']}, cycles:['normalize','duplicate'], topologicalOrder:null}
          : {nodes:ids, edges:Object.fromEntries(ids.map((id,index) => [id,index ? [ids[index-1]] : []])), reverseEdges:Object.fromEntries(ids.map((id,index) => [id,index < ids.length-1 ? [ids[index+1]] : []])), duplicates:{}, cycles:[], topologicalOrder:ids};
        client.document.applySnapshot(snapshot);
        view.render(client.document);
        if (spec.conflict) {
          const cell = client.document.cells[0];
          cell.desiredBody = ['fit <- lm(y ~ treatment, local_data)'];
          cell.generation += 1;
          cell.conflict = true;
          view.render(client.document);
          document.querySelector('[data-conflict-diff]')?.setAttribute('open','');
        }
        const panel = document.getElementById('dataflow-panel');
        const toggle = document.getElementById('panel-toggle');
        if (spec.panel === true && panel.hidden) toggle.click();
        if (spec.panel === false && !panel.hidden) toggle.click();
        if (spec.tab) document.querySelector('[data-panel-tab="'+spec.tab+'"]').click();
        if (spec.editorEvidence) {
          const editors = Array.from(view.editors.values());
          const editor = editors[0];
          if (editor) {
            editor.setDiagnostics([{from:0,to:7,severity:'warning',message:'Review model input'}]);
            editor.setCompletionSource(context => ({from:Math.max(0,context.pos-2),options:[{label:'ifelse',type:'function',detail:'R base',info:'Choose values conditionally',apply:'ifelse'}]}));
            editor.view.dispatch({selection:{anchor:2}});
            editor.focus();
          }
          const selected = editors[1];
          if (selected) selected.view.dispatch({selection:{anchor:0,head:Math.min(12,selected.view.state.doc.length)}});
        }
        if (spec.settings) {
          await view.performDesktopAction('settings');
          await new Promise(resolve => requestAnimationFrame(resolve));
          document.getElementById('settings-theme').focus();
        }
        for (const image of document.querySelectorAll('img.plot')) image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="280" viewBox="0 0 720 280"><rect width="720" height="280" fill="white"/><path d="M55 20V235H690" stroke="#c8ced7" fill="none"/><g fill="#7b8794">'+Array.from({length:40},(_,i)=>'<circle cx="'+(75+(i*83)%570)+'" cy="'+(38+(i*47)%170)+'" r="4"/>').join('')+'</g><g fill="#2864dc"><circle cx="135" cy="42" r="7"/><circle cx="590" cy="34" r="7"/><circle cx="515" cy="58" r="7"/></g><text x="290" y="268" fill="#333" font-size="13">log2 fold change</text></svg>');
        if (spec.expandErrors) for (const details of document.querySelectorAll('.error-details')) details.setAttribute('open','');
        scrollTo(0,0);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    };
  })()`);
}

async function setViewport(target: Chrome, width: number, height: number, reducedMotion = false): Promise<void> {
  await target.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await target.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }] });
}

async function apply(target: Chrome, spec: unknown): Promise<void> {
  await target.evaluate(`window.__uiReview.apply(${JSON.stringify(spec)})`);
}

async function screenshot(target: Chrome, destination: string, scale = 1): Promise<void> {
  const metrics = await target.evaluate(`({width:innerWidth,height:innerHeight})`);
  const result = await target.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false,
    ...(scale === 1 ? {} : { clip: { x: 0, y: 0, width: metrics.width, height: metrics.height, scale } }) });
  await writeFile(destination, Buffer.from(result.data, "base64"));
}

try {
  browser = await Chrome.open(await ticket());
  await installHarness(browser);
  const captures: string[] = [];
  let editorEvidence: any = null;
  for (const entry of cases) {
    await setViewport(browser, entry.width, entry.height);
    await apply(browser, entry.spec);
    const destination = join(outputDirectory, entry.name + ".png");
    if (entry.name === "output-rich-light") {
      await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 2 });
      await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 2 });
      await browser.wait("Boolean(document.querySelector('.cm-tooltip-autocomplete'))", 2_000);
      editorEvidence = await browser.evaluate(`(() => { const spans=Array.from(document.querySelectorAll('.cm-line span')); const editors=Array.from(window.__alderHost.view.editors.values()); return {tokenSpans:spans.length,tokenColors:[...new Set(spans.map(node=>getComputedStyle(node).color))],selection:editors.some(editor=>editor.view.state.selection.main.from !== editor.view.state.selection.main.to) ? 1 : 0,completion:document.querySelectorAll('.cm-tooltip-autocomplete').length}; })()`);
      if (editorEvidence.tokenSpans < 3 || editorEvidence.tokenColors.length < 3 || editorEvidence.selection < 1 || editorEvidence.completion < 1) throw new Error("Production editor evidence is incomplete: " + JSON.stringify(editorEvidence));
    }
    await screenshot(browser, destination);
    captures.push(destination);
    if (entry.name === "settings-focus") {
      const focus = await browser.evaluate(`(() => { const node=document.activeElement; const style=getComputedStyle(node); return {id:node?.id,outlineWidth:style.outlineWidth,outlineStyle:style.outlineStyle}; })()`);
      if (focus.id !== "settings-theme" || focus.outlineStyle === "none" || focus.outlineWidth === "0px") throw new Error("Settings capture lacks visible keyboard focus: " + JSON.stringify(focus));
    }
    if (entry.name === "output-gallery") {
      const gallery = await browser.evaluate(`({html:document.querySelector('.html-inline')?.innerText,widget:Boolean(document.querySelector('.widget-container')),error:Boolean(document.querySelector('.output-error')),table:Boolean(document.querySelector('.table-preview')),plot:Boolean(document.querySelector('.plot')),longText:(document.querySelector('.value-text')?.innerText || '').split('\\n').length,trace:Boolean(document.querySelector('.error-trace'))})`);
      if (!gallery.html?.includes('Pathway enrichment') || !gallery.widget || !gallery.error || !gallery.table || !gallery.plot || gallery.longText < 12 || !gallery.trace) throw new Error("Output gallery is incomplete: " + JSON.stringify(gallery));
    }
    if (entry.name === "inspector-open") {
      const geometry = await browser.evaluate(`(() => { const panel=document.getElementById('dataflow-panel'); const rect=panel.getBoundingClientRect(); return {position:getComputedStyle(panel).position,top:rect.top,bottom:rect.bottom,height:innerHeight,inert:document.getElementById('notebook').inert,overflow:getComputedStyle(document.body).overflow}; })()`);
      if (geometry.position !== "fixed" || geometry.top < 0 || geometry.bottom > geometry.height + 1 || !geometry.inert || geometry.overflow !== "hidden") throw new Error("Inspector geometry failed: " + JSON.stringify(geometry));
    }
    await setViewport(browser, Math.max(360, Math.floor(entry.width / 2)), Math.max(360, Math.floor(entry.height / 2)));
    await apply(browser, entry.name === "inspector-open" || entry.name === "long-outline" ? entry.spec : { ...entry.spec, panel: false });
    await screenshot(browser, join(zoomDirectory, entry.name + ".png"), 2);
  }

  await setViewport(browser, 1100, 820, true);
  const reducedSpec = { theme: "light", cells: [{ id: "motion", name: "model_update", body: ["fit <- update(model)"], status: "running", outputs: [text("Previous estimate retained while the model updates")], outputsStale: true, progress: { value: 41, total: 100, label: "Updating model · 41%" } }] };
  await apply(browser, reducedSpec);
  const motion = await browser.evaluate(`(() => { const cell=document.querySelector('.cell.running'); const style=getComputedStyle(cell); return {transitionDuration:style.transitionDuration,animationDuration:style.animationDuration,progress:document.querySelector('progress')?.getAttribute('aria-label')}; })()`);
  if (!/^0(?:\.0+)?s$|^0\.0*1ms$|^1e-05s$/.test(motion.transitionDuration) || !motion.progress) throw new Error("Reduced motion was not applied to a changing state: " + JSON.stringify(motion));
  const reducedMotionCapture = join(outputDirectory, "reduced-motion.png");
  await screenshot(browser, reducedMotionCapture);
  captures.push(reducedMotionCapture);

  previewBrowser = await Chrome.open(await ticket("preview"));
  await installHarness(previewBrowser, true);
  await setViewport(previewBrowser, 1200, 900);
  await apply(previewBrowser, { theme: "light", cells: richCells });
  const previewCapture = join(outputDirectory, "preview.png");
  await screenshot(previewBrowser, previewCapture);
  captures.push(previewCapture);
  await setViewport(previewBrowser, 600, 450);
  await apply(previewBrowser, { theme: "light", cells: richCells });
  await screenshot(previewBrowser, join(zoomDirectory, "preview.png"), 2);

  const python = `from PIL import Image,ImageDraw\nimport sys,os,math\nout=sys.argv[1]; paths=sys.argv[2:]\nthumbs=[]\nfor p in paths:\n im=Image.open(p).convert('RGB'); im.thumbnail((420,300)); thumbs.append((p,im.copy()))\nw=900; h=math.ceil(len(thumbs)/2)*350\ncanvas=Image.new('RGB',(w,h),'#e8eaed'); d=ImageDraw.Draw(canvas)\nfor i,(p,im) in enumerate(thumbs):\n x=20+(i%2)*440; y=20+(i//2)*350; canvas.paste(im,(x,y+24)); d.text((x,y),os.path.basename(p),fill='#20242a')\ncanvas.save(os.path.join(out,'contact-sheet.png'))`;
  const contact = spawnSync("python3", ["-c", python, outputDirectory, ...captures], { encoding: "utf8" });
  if (contact.status !== 0) throw new Error(contact.stderr);
  const evidence = { renderer: "production-host", editorEvidence, reducedMotion: motion, zoom200: { method: "half CSS viewport with 2x capture scale", deviceScaleFactor: 1 }, captures };
  await writeFile(join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ outputDirectory, contactSheet: join(outputDirectory, "contact-sheet.png"), captures, zoom200Directory: zoomDirectory, evidence: join(outputDirectory, "evidence.json"), durationMs: Date.now() - started }, null, 2));
} finally {
  await previewBrowser?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await app.close().catch(() => {});
  await rm(fixtureDirectory, { recursive: true, force: true });
}
