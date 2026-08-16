// alder frontend: polls /api/state, renders cells, drives the editor and
// app mode. No build step — plain vanilla JS served by the httpuv server.
//
// Edit contract: every textarea edit is captured immediately into a
// per-cell pendingEdits entry {latestRevision, sentRevision, body, type,
// timer, inFlight, promise}; at most one /api/cell POST per cell runs at a
// time, and runs/saves/add/delete first flush every pending edit and abort
// when any of them fails.

const els = {
  notebook: document.getElementById('notebook'),
  path: document.getElementById('path'),
  runAll: document.getElementById('run-all'),
  stop: document.getElementById('stop'),
  appMode: document.getElementById('app-mode'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  cellTpl: document.getElementById('cell-tpl'),
};

// Cell id -> DOM element (for stable diffs on re-render).
const cellEls = new Map();
// The persistent "+ Add code cell" bar (idempotent across renders).
let addBar = null;
// Cell id -> pending edit state.
const pendingEdits = new Map();

let lastState = null;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error('Network error: ' + e.message);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('Invalid JSON from ' + path + ' (HTTP ' + res.status + ')');
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
  }
  return data;
}

// -- status region -----------------------------------------------------------
function showError(msg) {
  const el = els.status;
  el.textContent = msg || 'Error';
  el.classList.add('error');
}
function showStatus(msg) {
  const el = els.status;
  el.textContent = msg;
  el.classList.remove('error');
}
function clearStatus() {
  const el = els.status;
  el.textContent = '';
  el.classList.remove('error');
}

// -- pending edits -----------------------------------------------------------
function startEdit(id, body, type) {
  let p = pendingEdits.get(id);
  if (!p) {
    p = { id, latestRevision: 0, sentRevision: 0, body, type, timer: null, inFlight: false, await: null };
    pendingEdits.set(id, p);
  }
  p.latestRevision += 1;
  p.body = body;
  p.type = type;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { p.timer = null; commitPendingEdit(id).catch(showError); }, 400);
  return p;
}

// Send the latest unsent revision; after it commits, loop until no newer
// input arrived. One in-flight POST per cell.
function commitPendingEdit(id) {
  const p = pendingEdits.get(id);
  if (!p) return Promise.resolve();
  if (p.inFlight) {
    // Wait for the in-flight POST, then send whatever is newer.
    return (p.await || Promise.resolve()).then(() => commitPendingEdit(id)).catch(showError);
  }
  return (async () => {
    while (p.latestRevision > p.sentRevision) {
      const rev = p.latestRevision;
      const body = p.body;
      const type = p.type;
      p.inFlight = true;
      let resolveAwait;
      p.await = new Promise((r) => { resolveAwait = r; });
      try {
        await api('/api/cell', { body: { id, body, type } });
        if (p.sentRevision < rev) p.sentRevision = rev;
        if (p.latestRevision === p.sentRevision) pendingEdits.delete(id);
      } finally {
        p.inFlight = false;
        if (resolveAwait) resolveAwait();
        if (pendingEdits.get(id) === p && p.latestRevision === p.sentRevision) {
          pendingEdits.delete(id);
        }
      }
    }
  })();
}

// Cancel debounce timers and commit every pending cell's latest revision,
// in notebook order. Throws at the first failure; the failed entry stays
// pending and the caller must abort its action without touching the server.
async function flushPendingEdits() {
  const order = lastState ? new Map(lastState.cells.map((c) => [c.id, true])) : new Map();
  const ids = [...pendingEdits.keys()].sort((a, b) => {
    const ia = order.has(a) ? [...order.keys()].indexOf(a) : 1e9;
    const ib = order.has(b) ? [...order.keys()].indexOf(b) : 1e9;
    return ia - ib;
  });
  for (const id of ids) {
    const p = pendingEdits.get(id);
    if (!p) continue;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    await commitPendingEdit(id);
  }
}

const isPending = (id) => {
  const p = pendingEdits.get(id);
  return !!p && (p.inFlight || p.latestRevision > p.sentRevision);
};

// -- rendering ---------------------------------------------------------------
function statusClass(s) {
  if (s === 'stale') return 'stale';
  if (s === 'running') return 'running';
  if (s === 'error') return 'error';
  return 'done';
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function outputHtml(out) {
  if (!out) return '';
  const esc = escHtml;

  if (out.kind === 'text') {
    return `<div class="output-text"><pre>${esc(out.text)}</pre></div>`;
  }
  if (out.kind === 'image') {
    return `<img class="plot" src="/plot/${encodeURIComponent(out.artifact)}" alt="plot">`;
  }
  if (out.kind === 'html') {
    return `<iframe src="/plot/${encodeURIComponent(out.artifact)}" class="widget-html" style="width:100%;height:400px;border:none;"></iframe>`;
  }
  if (out.kind === 'table') {
    const rows = Array.isArray(out.preview) ? out.preview : [];
    const cols = Array.isArray(out.columns) ? out.columns
      : (rows.length ? Object.keys(rows[0] || {}) : []);
    if (!cols.length) {
      return `<div class="output-text">${out.nrow} x ${out.ncol} (empty preview)</div>`;
    }
    const trs = rows.map((r) =>
      `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('');
    const ths = cols.map((c) => `<th>${esc(c)}</th>`).join('');
    return `<div class="table-wrap"><table class="data"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>
      <div class="table-meta">${out.nrow} rows &times; ${out.ncol} columns</div>`;
  }
  return '';
}

// Build one widget control; `.value` is the only protocol value field and
// `.label` renders through a <label for="">. Labels are button text.
function widgetHtml(w) {
  const name = w.name;
  const spec = w.spec || {};
  const kind = spec['.kind'];
  const vid = 'wid-' + name;
  const wv = spec['.value'];
  const esc = escHtml;
  let control = '';
  if (kind === 'slider') {
    control = `<input id="${vid}" data-wid="${name}" type="range"
      min="${spec.min ?? 0}" max="${spec.max ?? 100}" step="${spec.step ?? 1}"
      value="${esc(wv)}"><span class="wval">${esc(wv)}</span>`;
  } else if (kind === 'dropdown') {
    const opts = (spec.choices || []).map((c) =>
      `<option value="${esc(c)}" ${String(c) === String(wv) ? 'selected' : ''}>${esc(c)}</option>`).join('');
    control = `<select id="${vid}" data-wid="${name}">${opts}</select>`;
  } else if (kind === 'text_input') {
    control = `<input id="${vid}" data-wid="${name}" type="text" value="${esc(wv)}">`;
  } else if (kind === 'number') {
    control = `<input id="${vid}" data-wid="${name}" type="number" value="${esc(wv)}"
      min="${spec.min ?? ''}" max="${spec.max ?? ''}" step="${spec.step ?? 1}">`;
  } else if (kind === 'checkbox') {
    control = `<input id="${vid}" data-wid="${name}" type="checkbox" ${wv ? 'checked' : ''}>`;
  } else if (kind === 'button') {
    control = `<button id="${vid}" data-wid="${name}" type="button" class="btn">${esc(spec.label ?? spec['.label'] ?? 'Run')}</button>`;
  } else {
    return '';
  }
  const label = spec['.label'] || spec.label || '';
  const lbl = label ? `<label for="${vid}">${esc(label)}</label>` : '';
  // reconcileWidgets owns the .widget-row wrapper; deliver label + control.
  return `${lbl}${control}`;
}

// Patch a live widget in place: same id/kind keeps the DOM node so focus,
// selection and drag state survive polling. Value spreads are skipped
// while the control has focus.
function patchWidget(row, w) {
  const spec = w.spec || {};
  const ctrl = row.querySelector('[data-wid]');
  if (!ctrl) return;
  const focused = document.activeElement === ctrl;
  const kind = spec['.kind'];
  const lbl = row.querySelector('label');
  const label = spec['.label'] || '';
  if (lbl && lbl.textContent !== label) lbl.textContent = label;
  if (kind === 'button') {
    const text = spec['.label'] || 'Run';
    if (ctrl.textContent !== text) ctrl.textContent = text;
    return;
  }
  for (const attr of ['min', 'max', 'step']) {
    if (spec[attr] !== undefined && String(ctrl.getAttribute(attr)) !== String(spec[attr])) {
      ctrl.setAttribute(attr, spec[attr]);
    }
  }
  if (kind === 'checkbox') {
    const on = !!spec['.value'];
    if (!focused && ctrl.checked !== on) ctrl.checked = on;
  } else if (kind === 'slider') {
    const span = row.querySelector('.wval');
    if (span) span.textContent = String(spec['.value']);
    if (!focused && String(ctrl.value) !== String(spec['.value'])) ctrl.value = spec['.value'];
  } else if (kind === 'dropdown') {
    const want = String(spec['.value']);
    const has = [...ctrl.options].some((o) => o.value === want);
    if (has && !focused && ctrl.value !== want) ctrl.value = want;
  } else {
    if (!focused && String(ctrl.value) !== String(spec['.value'])) ctrl.value = spec['.value'];
  }
}

function reconcileWidgets(container, widgets) {
  const seen = new Set();
  for (const w of widgets || []) {
    seen.add(w.name);
    let row = container.querySelector(`[data-widget="${CSS.escape(w.name)}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'widget-row';
      row.dataset.widget = w.name;
      container.appendChild(row);
      row.innerHTML = widgetHtml(w);
    } else if (row.dataset.kind !== (w.spec || {})['.kind']) {
      row.dataset.kind = (w.spec || {})['.kind'];
      row.innerHTML = widgetHtml(w);
    } else {
      patchWidget(row, w);
    }
  }
  for (const row of [...container.querySelectorAll('[data-widget]')]) {
    if (!seen.has(row.dataset.widget)) row.remove();
  }
  container.hidden = !(widgets && widgets.length);
}

// The non-widget render key: only when it changes is value HTML replaced.
function renderKey(out) {
  if (!out) return 'none';
  return JSON.stringify(out);
}

function render(st) {
  els.path.textContent = st.path || 'untitled notebook';
  const running = st.cells.some((c) => c.status === 'running');
  els.stop.disabled = !running;
  els.runAll.disabled = running;
  if (st.cells.length === 0) {
    els.notebook.innerHTML = '<div class="empty">Empty notebook — add a cell below.</div>';
    appendAddBar();
    return;
  }
  // Update existing cell nodes in place; append new ones, remove gone ones.
  // Never clear the container: disconnecting a focused node drops focus on
  // re-attach, and in-flight edits live on DOM nodes.
  const seen = new Set();
  st.cells.forEach((c) => {
    seen.add(c.id);
    let el = cellEls.get(c.id);
    if (!el) {
      el = els.cellTpl.content.firstElementChild.cloneNode(true);
      cellEls.set(c.id, el);
    }
    updateCell(el, c);
    if (!els.notebook.contains(el)) {
      els.notebook.insertBefore(el, (addBar && addBar.isConnected) ? addBar : null);
    }
  });
  for (const [id, el] of cellEls) {
    if (!seen.has(id)) {
      el.remove();
      cellEls.delete(id);
    }
  }
  appendAddBar();
}

function updateCell(el, c) {
  el.dataset.id = c.id;
  el.className = 'cell' +
    (c.status === 'error' ? ' cell-errored' : '') +
    (c.status === 'stale' ? ' stale-cell' : '') +
    (c.status === 'running' ? ' running-cell' : '');

  const codeArea = el.querySelector('.code-area');
  const mdArea = el.querySelector('.md-area');
  const ta = el.querySelector('.code');
  const md = el.querySelector('.md');
  const badge = el.querySelector('.badge');
  const widgetsEl = el.querySelector('.widgets');
  const valueEl = el.querySelector('.value');
  const log = el.querySelector('.log');

  const isMd = c.type === 'markdown';
  codeArea.hidden = isMd;
  mdArea.hidden = !isMd;
  // Never overwrite a textarea for a cell with pending/in-flight edits.
  if (!isPending(c.id)) {
    if (isMd) {
      if (document.activeElement !== md) md.value = (c.body || []).join('\n');
    } else {
      if (document.activeElement !== ta) ta.value = (c.body || []).join('\n');
    }
  }

  badge.textContent = c.status;
  badge.className = 'badge ' + statusClass(c.status);

  reconcileWidgets(widgetsEl, c.widgets || []);
  const key = renderKey(c.output);
  if (valueEl.dataset.key !== key) {
    valueEl.dataset.key = key;
    valueEl.innerHTML = outputHtml(c.output);
  }
  log.innerHTML = (c.log || []).map((l) =>
    `<div class="${/^Error:/.test(l) ? 'err' : ''}">${escHtml(l)}</div>`).join('');
}

function appendAddBar() {
  if (!addBar) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '+ Add code cell';
    btn.id = 'add-cell';
    btn.addEventListener('click', async () => {
      try {
        await flushPendingEdits();
        clearStatus();
        await api('/api/cell', { body: { add: true, type: 'code' } });
        refresh();
      } catch (e) {
        showError(e.message);
      }
    });
    addBar = document.createElement('div');
    addBar.style.textAlign = 'center';
    addBar.style.margin = '16px 0';
    addBar.appendChild(btn);
  }
  if (!addBar.isConnected) els.notebook.appendChild(addBar);
}

function widgetValueByName(name) {
  if (!lastState) return undefined;
  for (const c of lastState.cells) {
    for (const w of c.widgets || []) {
      if (w.name === name) return w.spec && w.spec['.value'];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
els.notebook.addEventListener('input', (e) => {
  const ta = e.target;
  if (ta.tagName !== 'TEXTAREA') return;
  const cellEl = ta.closest('.cell');
  if (!cellEl) return;
  const id = cellEl.dataset.id;
  const isMd = ta.classList.contains('md');
  startEdit(id, ta.value.split('\n'), isMd ? 'markdown' : 'code');
});

els.notebook.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const cellEl = btn.closest('.cell');
    const id = cellEl.dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'run') {
        await flushPendingEdits();
        clearStatus();
        await api('/api/run', { body: { cell: id } });
      } else if (act === 'add-below') {
        await flushPendingEdits();
        clearStatus();
        await api('/api/cell', { body: { add: true, after: id } });
      } else if (act === 'delete') {
        if (!confirm('Delete this cell?')) return;
        await flushPendingEdits();
        clearStatus();
        await api('/api/cell', { body: { delete: id } });
      }
      refresh();
    } catch (err) {
      showError(err.message);
    }
    return;
  }
  // Widget buttons commit on click: increment their stored value.
  const w = e.target.closest('[data-wid]');
  if (w && w.type === 'button') {
    const name = w.dataset.wid;
    const cur = widgetValueByName(name);
    try {
      await api('/api/widget', { body: { name, value: Number(cur ?? 0) + 1 } });
      clearStatus();
    } catch (err) {
      showError(err.message);
    }
  }
});

// Sliders commit live while dragging (input fires per tick).
els.notebook.addEventListener('input', async (e) => {
  const w = e.target.closest('[data-wid]');
  if (!w || w.type !== 'range') return;
  const row = w.closest('.widget-row');
  if (row) row.querySelector('.wval').textContent = w.value;
  try {
    await api('/api/widget', { body: { name: w.dataset.wid, value: Number(w.value) } });
    clearStatus();
  } catch (err) {
    showError(err.message);
  }
});

els.notebook.addEventListener('change', async (e) => {
  const w = e.target.closest('[data-wid]');
  if (!w || w.type === 'range' || w.type === 'button') return;
  const name = w.dataset.wid;
  let value;
  if (w.type === 'checkbox') {
    value = w.checked;
  } else if (w.type === 'number') {
    const n = Number(w.value);
    if (w.value.trim() === '' || !Number.isFinite(n)) {
      const prev = widgetValueByName(name);
      showError(`Invalid number for "${name}" — keeping previous value`);
      if (prev !== undefined && String(prev) !== String(w.value)) w.value = prev;
      return; // send nothing
    }
    value = n;
  } else {
    value = w.value;
  }
  try {
    await api('/api/widget', { body: { name, value } });
    clearStatus();
  } catch (err) {
    showError(err.message);
  }
});

els.runAll.addEventListener('click', async () => {
  try {
    await flushPendingEdits();
    clearStatus();
    await api('/api/run', { body: { all: true } });
    refresh();
  } catch (e) {
    showError(e.message);
  }
});

els.stop.addEventListener('click', async () => {
  try {
    await api('/api/interrupt', { method: 'POST' });
  } catch (e) {
    showError(e.message);
  }
});

els.appMode.addEventListener('click', () => {
  document.body.classList.toggle('app-mode');
  els.appMode.textContent = document.body.classList.contains('app-mode') ? 'Edit mode' : 'App mode';
});

els.save.addEventListener('click', async () => {
  try {
    await flushPendingEdits();
    await api('/api/save', { method: 'POST' });
    showStatus('Saved');
    refresh();
  } catch (e) {
    showError(e.message);
  }
});

// ---------------------------------------------------------------------------
// Refresh / render
// ---------------------------------------------------------------------------
// Fetch fresh state and re-render. render() keeps per-cell DOM nodes stable,
// so pending edits, focus, and widget drag state survive polling.
async function refresh() {
  const st = await api('/api/state');
  lastState = st;
  render(st);
  return st;
}

// Poll for state (running/stale transitions). A poll failure keeps the
// last good DOM; the status region surfaces the error until the next
// successful action.
setInterval(() => {
  refresh().catch((e) => {
    if (!els.status.classList.contains('error')) showError(e.message);
  });
}, 800);
refresh().catch((e) => showError(e.message));

