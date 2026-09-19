import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = process.argv[2] ? resolve(process.argv[2]) : "/tmp/alder-ui-review-checkpoint2";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await mkdir(join(out, "zoom-200"), { recursive: true });
const css = pathToFileURL(join(repo, "inst/app/static/style.css")).href;

const code = (text) => `<div class="source-area code-area"><pre class="source-placeholder">${text}</pre></div>`;
const output = (html) => `<div class="output-area" data-role="output">${html}</div>`;
const cell = (status, title, source, result = "", extra = "") => `<section class="cell ${status} ${extra}" tabindex="-1"><div class="cell-head"><div class="cell-meta"><span class="drag-handle">⠿</span><strong class="cell-title">${title}</strong><span class="cell-badge ${status}">${status}</span></div><div class="cell-actions"><button class="btn mini primary">Run</button><details class="cell-overflow"><summary class="btn mini">•••</summary></details></div></div>${code(source)}${result ? output(result) : ""}<div class="cell-add"><button class="btn mini insert-cell">+ Add cell</button></div></section>`;
const panel = (long = false) => `<aside id="dataflow-panel" aria-label="Notebook inspector"><div class="panel-head"><strong>Notebook</strong><button class="panel-icon-btn">×</button></div><div class="panel-tabs"><button>Variables</button><button>Dependencies</button><button>Graph</button><button aria-selected="true">Outline</button></div><div class="panel-view"><div class="outline-list">${Array.from({length: long ? 28 : 6}, (_, i) => `<button class="panel-link outline-${i % 3 ? "cell" : "heading"}">${i % 3 ? `Cell ${i + 1} · analysis_${i + 1}` : `${i / 3 + 1}. Scientific section`}</button>`).join("")}</div></div></aside>`;
const table = `<div class="table-preview"><table><thead><tr><th>sample</th><th>condition</th><th>log₂ fold change</th><th>adjusted p</th></tr></thead><tbody>${["A01|control|−0.14|0.812","A02|treated|2.83|0.0004","B01|treated|1.47|0.013","B02|control|0.08|0.921","C01|treated|−1.96|0.007"].map(r=>`<tr>${r.split("|").map(v=>`<td>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="table-toolbar"><input class="table-filter" value="treated" aria-label="Filter rows"><button class="table-copy">Copy</button><span class="table-meta">3 of 5 rows</span></div>`;
const plot = `<svg class="plot" viewBox="0 0 640 250" role="img" aria-label="Volcano plot"><rect width="640" height="250" fill="white"/><g stroke="#d9dde3"><path d="M52 18V215H620" fill="none"/></g><g fill="#7b8794">${Array.from({length:38},(_,i)=>`<circle cx="${70+(i*67)%520}" cy="${35+(i*41)%165}" r="4"/>`).join("")}</g><g fill="#2864dc"><circle cx="120" cy="48" r="6"/><circle cx="540" cy="34" r="6"/><circle cx="486" cy="62" r="6"/></g><text x="270" y="242" fill="#333" font-size="12">log₂ fold change</text></svg>`;
const gallery = `${cell("done","Cell 1 · summary","summary(model)",`<pre class="value-text">Residuals:\n    Min      1Q  Median      3Q     Max\n-2.514  -0.603   0.018   0.624   2.087</pre>`)}${cell("done","Cell 2 · differential_expression","results |> arrange(padj)",table)}${cell("done","Cell 3 · volcano_plot","plot_volcano(results)",plot)}${cell("done","Cell 4 · notes","# Interpretation",`<div class="markdown-output"><h2>Response signature</h2><p>Treatment separates a compact set of genes while the control distribution remains centered.</p><div class="out-callout out-callout-info"><strong>Notebook note</strong><span>Thresholds are stored with the analysis.</span></div></div>`)} `;

function shell(scenario) {
  let theme = scenario.includes("dark") ? "dark" : "light";
  let bodyClass = scenario === "preview" ? "app-view panel-closed" : scenario.includes("inspector-closed") ? "panel-closed" : "";
  let status = ""; let cells = gallery; let inspector = panel(scenario === "long-outline"); let scrim = "hidden"; let dialog = "";
  if (scenario === "empty-r-unavailable") { cells = `<div class="empty-bar"><span class="empty-message">This notebook has no cells yet.</span><button class="btn mini">+ Add cell</button></div>`; status = `<div class="runtime-recovery-panel"><strong>R execution is unavailable</strong><div>Your edits and saves are preserved. Choose an R installation or restart R.</div><div class="recovery-actions"><button class="btn mini">Choose R…</button><button class="btn mini">Restart R</button></div></div>`; }
  if (scenario === "running-stale-progress") { cells = `${cell("done","Cell 1 · load_data","data <- read.csv(\"assay.csv\")",`<pre class="value-text">240 samples × 18 variables</pre>`)}${cell("running","Cell 2 · fit_model","fit <- lm(response ~ treatment, data)",`<div class="retained-output"><div class="retained-output-label">Previous output — updating</div><pre class="value-text">Previous estimate: 1.82 ± 0.31</pre></div><div class="progress-row"><progress value="62" max="100" aria-label="Fitting model"></progress><span class="progress-label">Fitting model · 62%</span></div>`)}${cell("stale","Cell 3 · report","tidy(fit)",`<pre class="value-text">Output waits for the updated model.</pre>`)}`; }
  if (scenario === "error-graph") { cells = `${cell("error","Cell 1 · normalize","normalized <- transform(raw, value = value / zero)",`<div class="output-error">Error: division produced non-finite values</div><details class="error-details" open><summary>Call and traceback</summary><pre class="error-trace">normalize_counts(raw)\ntransform.data.frame(...)\nstop(\"non-finite values\")</pre></details>`)}${cell("error","Cell 2 · duplicate model","fit <- lm(y ~ x, data)",`<div class="diagnostic-error">Duplicate definition: fit is also defined in Cell 4.</div>`,"source-conflict")}${cell("done","Cell 3 · independent_qc","summary(raw)",`<pre class="value-text">Healthy independent cell · 240 observations</pre>`)}`; }
  if (scenario === "output-gallery") cells = gallery;
  if (scenario === "recovery-conflict") { status = `<div class="recovery-panel"><strong>Recovered edits conflict with newer changes.</strong><div>Your edits are preserved. Review the conflicting cells before saving.</div><div class="recovery-actions"><button class="btn mini primary">Continue recovered</button><button class="btn mini">Save recovered copy</button><button class="btn mini">Open saved</button></div></div>`; cells = cell("error","Cell 2 · model","fit <- lm(y ~ treatment, local_data)",`<details class="source-conflict-diff" open><summary>Compare incoming and my edits</summary><pre>Incoming\nfit <- lm(y ~ treatment, shared_data)\n\nMy edits\nfit <- lm(y ~ treatment, local_data)</pre></details><div class="recovery-actions"><button class="btn mini">Keep my edits</button><button class="btn mini">Use incoming</button><button class="btn mini">Restore mine as new cell</button></div>`,"source-conflict"); }
  if (scenario === "settings-focus") dialog = `<dialog class="settings-dialog"><div class="settings-head"><h2>Packages</h2><button class="btn mini">Close</button></div><label>Package names<input id="package-names" value="edgeR, statmod, ggplot2"></label><pre class="package-status">Installing edgeR 4.2.1\nResolving project library…</pre><div class="progress-row"><progress value="43" max="100" aria-label="Installing project packages"></progress><span class="progress-label">Installing project packages · 43%</span></div><div class="settings-actions"><button class="btn" autofocus>Cancel install</button><button class="btn primary">Install missing</button></div></dialog>`;
  if (scenario === "inspector-open") { scrim = ""; cells = gallery.slice(0, gallery.indexOf('Cell 3')); }
  if (scenario === "inspector-closed") { inspector = `<aside id="dataflow-panel" hidden></aside>`; cells = gallery.slice(0, gallery.indexOf('Cell 3')); }
  if (scenario === "preview") { inspector = ""; cells = gallery; }
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"><title>${scenario}</title></head><body class="${bodyClass}"><header id="topbar"><div class="document-identity"><strong class="path">methylation-analysis.R</strong><span class="document-state">Saved</span></div><div class="spacer"></div><span class="runtime-state">${scenario.includes("running") ? "R running" : "R ready"}</span><button id="panel-toggle" class="btn editor-only">Notebook</button><button class="btn primary editor-only">Run All</button><a class="btn editor-only">Preview</a><a class="btn" ${scenario === "preview" ? "" : "hidden"}>Exit Preview</a></header><div id="status">${status}</div><div id="editor-workspace"><main id="notebook">${cells}</main>${inspector}<button id="panel-scrim" class="panel-scrim" ${scrim}></button></div>${dialog}${scenario === "settings-focus" ? "<script>document.querySelector(\"dialog\").showModal();document.querySelector(\"[autofocus]\").focus()</script>" : ""}</body></html>`;
}
const cases = [
  ["output-rich-light",1440,960], ["output-rich-dark",1440,960], ["inspector-closed",760,900], ["inspector-open",760,900],
  ["empty-r-unavailable",1100,760], ["running-stale-progress",1100,820], ["error-graph",1100,900], ["output-gallery",1200,1000],
  ["recovery-conflict",1100,820], ["settings-focus",1100,820], ["long-outline",1200,900], ["preview",1200,900],
];
const started = Date.now();
for (const [name,width,height] of cases) {
  const html = join(out, `${name}.html`); const png = join(out, `${name}.png`);
  await writeFile(html, shell(name));
  for (const [target, extra] of [[png, []], [join(out, "zoom-200", `${name}.png`), ["--force-device-scale-factor=2", "--force-prefers-reduced-motion"]]]) {
    await new Promise((ok, fail) => {
      const child = spawn(chrome, ["--headless=new","--disable-gpu","--hide-scrollbars","--allow-file-access-from-files",...extra,`--window-size=${width},${height}`,`--screenshot=${target}`,pathToFileURL(html).href], {stdio:["ignore","ignore","pipe"]});
      let error=""; child.stderr.on("data", b => error += b); child.on("exit", code => code === 0 ? ok() : fail(new Error(error || `Chrome exited ${code}`)));
    });
  }
}
const py = `from PIL import Image,ImageDraw\nimport sys,os,math\nout=sys.argv[1]; paths=sys.argv[2:]\nthumbs=[]\nfor p in paths:\n im=Image.open(p).convert('RGB'); im.thumbnail((420,300)); thumbs.append((p,im.copy()))\nw=900; h=math.ceil(len(thumbs)/2)*350\ncanvas=Image.new('RGB',(w,h),'#e8eaed'); d=ImageDraw.Draw(canvas)\nfor i,(p,im) in enumerate(thumbs):\n x=20+(i%2)*440; y=20+(i//2)*350; canvas.paste(im,(x,y+24)); d.text((x,y),os.path.basename(p),fill='#20242a')\ncanvas.save(os.path.join(out,'contact-sheet.png'))`;
const pngs = cases.map(([name]) => join(out, `${name}.png`));
const contact = spawnSync("python3", ["-c", py, out, ...pngs], {encoding:"utf8"});
if (contact.status !== 0) throw new Error(contact.stderr);
console.log(JSON.stringify({ outputDirectory: out, contactSheet: join(out,"contact-sheet.png"), captures: pngs, zoom200Directory: join(out,"zoom-200"), durationMs: Date.now()-started }, null, 2));
