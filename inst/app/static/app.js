// alder frontend: one small, dependency-free controller for the editor and
// output-only app view.  The server is authoritative; local source/widget
// edits are kept separately until their acknowledgements arrive.

const els = {
  notebook: document.getElementById('notebook'),
  path: document.getElementById('path'),
  runtime: document.getElementById('runtime-select'),
  runAll: document.getElementById('run-all'),
  stop: document.getElementById('stop'),
  save: document.getElementById('save'),
  appMode: document.getElementById('app-mode'),
  editMode: document.getElementById('edit-mode'),
  status: document.getElementById('status'),
  cellTpl: document.getElementById('cell-tpl'),
  emptyTpl: document.getElementById('empty-bar'),
};

let lastRenderedVersion = -1;
const cellRecords = new Map();
const cellEls = new Map();
const lastWidgetOps = new Map();
const pendingWidgetOps = new Map();
const widgetWaiters = new Map();
let actionError = null;
let pollError = null;
const pollAbort = new AbortController();
let lastState = null;
let renderingState = null;
let emptyBar = null;
let actionInFlight = false;
let focusAfterCell = null;
let suppressUnloadOnce = false;
const pendingMarker = Symbol('pending-widget-value');

class ApiError extends Error {
  constructor(message, code = 'internal_error', status = 0) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function api(path, opts = {}) {
  const init = {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    signal: opts.signal,
    headers: { ...(opts.headers || {}) },
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError(`Network error: ${error.message}`, 'internal_error', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError(`Invalid JSON from ${path} (HTTP ${response.status})`,
      'internal_error', response.status);
  }
  if (!response.ok || (data && data.ok === false)) {
    const detail = data && data.error;
    if (detail && typeof detail === 'object') {
      throw new ApiError(detail.message || 'Request failed',
        detail.code || 'internal_error', response.status);
    }
    throw new ApiError(typeof detail === 'string' ? detail : `HTTP ${response.status}`,
      'internal_error', response.status);
  }
  return data;
}

function showActionError(message) {
  actionError = message || 'Request failed';
  renderStatus();
}


function renderStatus() {
  if (!els.status) return;
  const message = actionError || pollError || '';
  els.status.textContent = message;
  els.status.classList.toggle('error', Boolean(actionError));
  els.status.classList.toggle('poll-error', Boolean(!actionError && pollError));
}

function isViewApp() {
  return new URLSearchParams(window.location.search).get('view') === 'app';
}

function setViewApp(app) {
  const target = app ? '/?view=app' : '/?view=editor';
  suppressUnloadOnce = true;
  window.location.assign(target);
}

function splitBody(text) {
  return text === '' ? [] : text.split('\n');
}

function bodyText(body) {
  return Array.isArray(body) ? body.join('\n') : '';
}

function cellOrder() {
  return lastState && Array.isArray(lastState.cells) ? lastState.cells.map((c) => c.id) : [];
}

function makeCellRecord(cell) {
  const revision = Number.isInteger(cell.revision) ? cell.revision : 0;
  return {
    desiredBody: Array.isArray(cell.body) ? cell.body.slice() : [],
    desiredType: cell.type === 'markdown' ? 'markdown' : 'code',
    generation: 0,
    ackGeneration: 0,
    ackServerRevision: revision,
    latestServerRevision: revision,
    timer: null,
    drainPromise: null,
    failedGeneration: null,
    error: null,
    conflict: false,
    serverBody: Array.isArray(cell.body) ? cell.body.slice() : [],
    serverType: cell.type === 'markdown' ? 'markdown' : 'code',
    tombstone: false,
    predecessor: null,
  };
}

function ensureCellRecord(cell) {
  let record = cellRecords.get(cell.id);
  if (!record) {
    record = makeCellRecord(cell);
    cellRecords.set(cell.id, record);
  }
  record.latestServerRevision = Number.isInteger(cell.revision)
    ? cell.revision : record.latestServerRevision;
  record.serverBody = Array.isArray(cell.body) ? cell.body.slice() : [];
  record.serverType = cell.type === 'markdown' ? 'markdown' : 'code';

  const source = sourceElement(cell.id);
  const focused = Boolean(source && document.activeElement === source) ||
    Boolean(cellEls.get(cell.id) && document.activeElement ===
      cellEls.get(cell.id).querySelector('[data-role="type"]'));
  const protectedLocal = record.ackGeneration < record.generation ||
    Boolean(record.drainPromise) || Boolean(record.error);
  if (!focused && !protectedLocal && record.latestServerRevision >= record.ackServerRevision) {
    record.desiredBody = record.serverBody.slice();
    record.desiredType = record.serverType;
    record.ackServerRevision = record.latestServerRevision;
    record.ackGeneration = record.generation;
    record.failedGeneration = null;
    record.error = null;
    record.conflict = false;
  }
  record.tombstone = false;
  return record;
}

function sourceElement(id) {
  const el = cellEls.get(id);
  return el ? el.querySelector('[data-role="source"]') : null;
}


function editError(message, code = 'internal_error') {
  return new ApiError(message, code, 0);
}

// This is the only function that sends an edit.  A newer local generation is
// deliberately sent after the acknowledgement for the previous one.
function drainEdit(id) {
  const record = cellRecords.get(id);
  if (!record) return Promise.resolve();
  if (record.drainPromise) return record.drainPromise;
  if (record.error && record.failedGeneration === record.generation) {
    return Promise.reject(editError(record.error, record.conflict ? 'source_conflict' : 'internal_error'));
  }

  const promise = (async () => {
    try {
      while (record.ackGeneration < record.generation) {
        const generation = record.generation;
        const body = record.desiredBody.slice();
        const type = record.desiredType;
        const expectedRevision = record.ackServerRevision;
        try {
          const response = await api('/api/cell', {
            body: {
              op: 'edit', id, expected_revision: expectedRevision, body, type,
            },
          });
          const revision = Number.isInteger(response.revision)
            ? response.revision : expectedRevision;
          record.ackServerRevision = revision;
          record.latestServerRevision = revision;
          record.ackGeneration = generation;
          record.failedGeneration = null;
          record.error = null;
          record.conflict = false;
          record.serverBody = body.slice();
          record.serverType = type;
        } catch (error) {
          record.failedGeneration = generation;
          record.error = error.message;
          record.conflict = error.code === 'source_conflict';
          if (record.conflict) {
            // Keep the action error while obtaining the server source that is
            // offered by the conflict-resolution controls.
            refresh().catch(() => {});
          }
          throw error;
        }
      }
    } finally {
      if (record.drainPromise === promise) record.drainPromise = null;
    }
  })();
  record.drainPromise = promise;
  return promise;
}

function startEdit(id, body, type) {
  const record = cellRecords.get(id);
  if (!record) return null;
  record.desiredBody = Array.isArray(body) ? body.slice() : [];
  record.desiredType = type === 'markdown' ? 'markdown' : 'code';
  record.generation += 1;
  clearTimeout(record.timer);
  record.timer = null;
  // An unresolved conflict/error is intentionally not silently rebased.  The
  // user can keep typing, but must choose Retry or Use server version.
  if (!record.error) {
    record.timer = window.setTimeout(() => {
      record.timer = null;
      drainEdit(id).catch((error) => showActionError(error.message));
    }, 500);
  }
  return record;
}

async function flushPendingEdits() {
  while (true) {
    const order = new Map(cellOrder().map((id, index) => [id, index]));
    const records = [...cellRecords.entries()].sort((a, b) =>
      (order.get(a[0]) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b[0]) ?? Number.MAX_SAFE_INTEGER));
    let dirty = false;
    for (const [id, record] of records) {
      if (record.timer !== null) {
        clearTimeout(record.timer);
        record.timer = null;
      }
      if (record.error) throw editError(record.error,
        record.conflict ? 'source_conflict' : 'internal_error');
      if (record.ackGeneration < record.generation || record.drainPromise) {
        dirty = true;
        await drainEdit(id);
      }
      if (record.error) throw editError(record.error,
        record.conflict ? 'source_conflict' : 'internal_error');
    }
    if (!dirty) break;
  }
}

function widgetKey(name, kind) {
  return `${String(name)}\u0000${String(kind)}`;
}

function widgetSource(source) {
  return source === 'app' || isViewApp() ? 'app' : 'editor';
}

function widgetDoneState(widget) {
  const state = renderingState || lastState;
  if (!state || !widget) return false;
  const owner = state.cells?.find((cell) => cell.id === widget.owner);
  return Boolean(owner && owner.status === 'done');
}

function waitForWidgetCompletion(key, token) {
  const previous = lastWidgetOps.get(key);
  if (previous && previous.token === token && previous.status) {
    if (previous.status === 'error') {
      return Promise.reject(editError(previous.error || 'Widget update failed', 'internal_error'));
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const list = widgetWaiters.get(key) || [];
    list.push({ token, resolve, reject });
    widgetWaiters.set(key, list);
  });
}

function resolveWidgetWaiters(st) {
  const seen = new Set();
  for (const cell of st.cells || []) {
    const output = cell.output;
    if (!output || output.kind !== 'widget') continue;
    const kind = output.spec?.kind;
    const key = widgetKey(output.name, kind);
    seen.add(key);
    const operation = output.operation;
    // When an operation exists, it is authoritative: a pending op must never
    // be masked as done by an older commit_token from a previous update.
    const token = operation?.token ?? output.commit_token;
    const status = operation ? (
      operation.status === 'error' ? 'error' :
      operation.status === 'done' ? 'done' : null
    ) : (output.commit_token ? 'done' : null);
    const error = operation?.error?.message || operation?.error || null;
    lastWidgetOps.set(key, {
      token: token || null, pendingValue: pendingMarker, source: widgetSource(),
      status, error,
    });
    if (!token || !status) continue;
    const waiters = widgetWaiters.get(key);
    if (!waiters) continue;
    const remaining = [];
    for (const waiter of waiters) {
      // Only a committed (done/error) op can complete a waiter; pending
      // means the worker reply has not arrived yet.
      if (status !== 'done' && status !== 'error') {
        remaining.push(waiter);
        continue;
      }
      const exact = waiter.token === token;
      // A numerically GREATER committed token supersedes this waiter's
      // update (e.g. the rerun of a run-button cell). The old token will
      // never appear again. A LOWER token is stale state that rendered
      // after our POST: keep waiting — it must not resolve or reject.
      const newer = typeof waiter.token === 'number' && typeof token === 'number'
        ? token > waiter.token : null;
      if (!exact && newer !== true) {
        remaining.push(waiter);
        continue;
      }
      if (status === 'error') {
        waiter.reject(editError(error || 'Widget update failed', 'internal_error'));
      } else {
        waiter.resolve();
      }
    }
    if (remaining.length) widgetWaiters.set(key, remaining);
    else widgetWaiters.delete(key);
  }
  // A widget output can disappear after a source edit.  Keep its last token
  // for diagnostics, but do not resolve a request on a missing/stale output.
  for (const key of [...lastWidgetOps.keys()]) {
    if (!seen.has(key) && !pendingWidgetOps.has(key)) lastWidgetOps.delete(key);
  }
}

function commitWidgetUpdate(name, kind, value, index, source) {
  const key = widgetKey(name, kind);
  let operation = pendingWidgetOps.get(key);
  if (operation) {
    operation.hasPending = true;
    operation.pendingValue = value;
    operation.pendingIndex = index;
    operation.source = widgetSource(source);
    return operation.promise;
  }
  operation = {
    name, kind, source: widgetSource(source), hasPending: true,
    pendingValue: value, pendingIndex: index, token: null, promise: null,
  };
  operation.promise = (async () => {
    try {
      while (operation.hasPending) {
        operation.hasPending = false;
        const valueAtSend = operation.pendingValue;
        const indexAtSend = operation.pendingIndex;
        const payload = {
          name, source: operation.source,
          ...(kind === 'dropdown' ? { index: indexAtSend } : { value: valueAtSend }),
        };
        const response = await api('/api/widget', { body: payload });
        operation.token = response.token;
        lastWidgetOps.set(key, {
          token: response.token, pendingValue: pendingMarker,
          source: operation.source, status: null,
        });
        await waitForWidgetCompletion(key, response.token);
        actionError = null;
        renderStatus();
      }
    } finally {
      if (pendingWidgetOps.get(key) === operation) pendingWidgetOps.delete(key);
    }
  })();
  pendingWidgetOps.set(key, operation);
  operation.promise.catch((error) => showActionError(error.message));
  return operation.promise;
}

async function flushWidgetUpdates() {
  while (pendingWidgetOps.size) {
    const promises = [...pendingWidgetOps.values()].map((operation) => operation.promise);
    if (!promises.length) break;
    await Promise.all(promises);
  }
}

function safeDomPart(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

function widgetDomId(widget, kind) {
  return `widget-${safeDomPart(widget.owner || 'cell')}-${safeDomPart(kind)}`;
}

function createWidgetRow(widget) {
  const spec = widget.spec || {};
  const kind = spec.kind;
  const key = widgetKey(widget.name, kind);
  const row = document.createElement('div');
  row.className = 'widget-container';
  row.dataset.widgetKey = key;
  row.dataset.kind = kind || '';
  row.dataset.name = widget.name || '';
  row.dataset.owner = widget.owner || '';

  const label = document.createElement('label');
  label.dataset.role = 'widget-label';
  row.appendChild(label);
  const control = document.createElement(kind === 'dropdown' ? 'select' :
    kind === 'run_button' ? 'button' : 'input');
  control.dataset.role = 'widget';
  control.dataset.name = widget.name || '';
  control.dataset.kind = kind || '';
  control.dataset.owner = widget.owner || '';
  control.id = widgetDomId(widget, kind);
  if (kind === 'run_button') control.type = 'button';
  if (kind === 'slider') control.type = 'range';
  if (kind === 'number') control.type = 'number';
  if (kind === 'text_input') control.type = 'text';
  if (kind === 'checkbox') control.type = 'checkbox';
  row.appendChild(control);
  if (kind === 'slider') {
    const value = document.createElement('span');
    value.className = 'widget-value';
    row.appendChild(value);
  }
  patchWidget(row, widget);
  return row;
}

function patchWidget(row, widget) {
  const spec = widget.spec || {};
  const kind = spec.kind;
  const key = widgetKey(widget.name, kind);
  let control = row.querySelector('[data-role="widget"]');
  if (!control || row.dataset.kind !== kind) return;
  const pending = pendingWidgetOps.has(key);
  const focused = document.activeElement === control;
  const current = widgetDoneState(widget);
  const available = workerAvailable(renderingState || lastState);
  const labelText = spec.label == null ? '' : String(spec.label);
  const label = row.querySelector('[data-role="widget-label"]');
  if (kind === 'run_button') {
    if (label) label.remove();
    control.textContent = labelText || 'Run';
    control.setAttribute('aria-label', labelText || 'Run');
  } else {
    if (label) {
      label.textContent = labelText;
      label.htmlFor = control.id;
      label.hidden = !labelText;
    }
    if (labelText) control.setAttribute('aria-label', labelText);
    else control.removeAttribute('aria-label');
  }
  control.disabled = !available || !current || (kind === 'run_button' && pending);
  row.dataset.current = current ? 'true' : 'false';

  if (kind === 'slider' || kind === 'number') {
    if (spec.min !== undefined && spec.min !== null) control.min = String(spec.min);
    else control.removeAttribute('min');
    if (spec.max !== undefined && spec.max !== null) control.max = String(spec.max);
    else control.removeAttribute('max');
    if (spec.step !== undefined && spec.step !== null) control.step = String(spec.step);
    if (!focused && !pending && spec.value !== undefined) control.value = String(spec.value);
    if (kind === 'slider') {
      const value = row.querySelector('.widget-value');
      if (value && (!focused && !pending)) value.textContent = String(spec.value ?? '');
    }
  } else if (kind === 'dropdown') {
    const choices = Array.isArray(spec.choices) ? spec.choices : [];
    const selectedBefore = control.selectedIndex;
    control.replaceChildren();
    choices.forEach((choice, i) => {
      const option = document.createElement('option');
      option.value = String(i + 1);
      option.textContent = String(choice);
      control.appendChild(option);
    });
    const index = Number.isInteger(spec.index) ? spec.index : 1;
    if (!focused && !pending) control.selectedIndex = Math.max(0, index - 1);
    else if (selectedBefore >= 0 && selectedBefore < control.options.length) {
      control.selectedIndex = selectedBefore;
    }
  } else if (kind === 'checkbox') {
    if (!focused && !pending) control.checked = Boolean(spec.value);
  } else if (kind === 'text_input') {
    if (!focused && !pending && spec.value !== undefined) control.value = String(spec.value);
  }
}

function renderWidgetOutput(container, widget) {
  const kind = widget.spec?.kind;
  const key = widgetKey(widget.name, kind);
  let row = [...container.children].find((node) => node.dataset?.widgetKey === key);
  if (!row || row.dataset.kind !== kind) {
    container.replaceChildren();
    row = createWidgetRow(widget);
    container.appendChild(row);
  } else {
    patchWidget(row, widget);
  }
}

function appendText(container, className, text) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = String(text ?? '');
  container.appendChild(node);
  return node;
}

function renderOutput(container, output) {
  if (!output) {
    container.replaceChildren();
    return;
  }
  if (output.kind === 'widget') {
    renderWidgetOutput(container, output);
    return;
  }
  container.replaceChildren();
  if (output.kind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'value-text';
    pre.textContent = String(output.text ?? '');
    container.appendChild(pre);
    if (output.truncated) appendText(container, 'truncation-note', 'Output truncated.');
    return;
  }
  if (output.kind === 'table') {
    const wrap = document.createElement('div');
    wrap.className = 'table-preview';
    const table = document.createElement('table');
    const columns = Array.isArray(output.columns) ? output.columns : [];
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((column) => {
      const th = document.createElement('th');
      th.textContent = String(column);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    (Array.isArray(output.preview) ? output.preview : []).forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((column, index) => {
        const td = document.createElement('td');
        const value = Array.isArray(row) ? row[index] : row?.[column];
        td.textContent = String(value ?? '');
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    container.appendChild(wrap);
    const meta = document.createElement('div');
    meta.className = 'table-meta';
    meta.textContent = `${output.nrow ?? 0} rows × ${output.ncol ?? columns.length} columns`;
    container.appendChild(meta);
    if (output.truncated_rows || output.truncated_columns) {
      const note = [];
      if (output.truncated_rows) note.push('rows truncated');
      if (output.truncated_columns) note.push('columns truncated');
      appendText(container, 'truncation-note', note.join('; '));
    }
    return;
  }
  if (output.kind === 'image') {
    const image = document.createElement('img');
    image.className = 'plot';
    image.alt = output.alt_text || 'Plot';
    image.src = `/plot/${encodeURIComponent(String(output.artifact || ''))}`;
    container.appendChild(image);
    return;
  }
  if (output.kind === 'html') {
    const frame = document.createElement('iframe');
    frame.className = 'html-widget';
    frame.title = output.alt_text || 'HTML widget';
    frame.sandbox = 'allow-scripts';
    frame.referrerPolicy = 'no-referrer';
    frame.src = `/plot/${encodeURIComponent(String(output.artifact || ''))}`;
    if (Number.isFinite(output.height)) frame.height = String(Math.max(100, output.height));
    container.appendChild(frame);
    return;
  }
  if (output.kind === 'markdown') {
    const markdown = document.createElement('div');
    markdown.className = 'markdown-output';
    // The Session sanitizes this exact field before it enters the wire state.
    markdown.innerHTML = String(output.html || '');
    container.appendChild(markdown);
    return;
  }
  if (output.kind === 'error') {
    appendText(container, 'output-error', output.message || 'Evaluation failed');
  }
}

function renderLogs(area, logs) {
  area.replaceChildren();
  const values = Array.isArray(logs) ? logs : [];
  values.forEach((line) => {
    const item = document.createElement('div');
    item.className = /^Error\b/.test(String(line)) ? 'log-error' : 'log-line';
    item.textContent = String(line ?? '');
    area.appendChild(item);
  });
  area.hidden = values.length === 0 && !isViewApp();
}

function renderDiagnostics(area, diagnostics) {
  area.replaceChildren();
  const list = document.createElement('ul');
  list.setAttribute('role', 'status');
  list.setAttribute('aria-live', 'polite');
  const values = Array.isArray(diagnostics) ? diagnostics : [];
  values.forEach((diagnostic) => {
    const item = document.createElement('li');
    const level = diagnostic.level === 'warning' ? 'warning' : 'error';
    item.className = `diagnostic-${level}`;
    item.textContent = `${diagnostic.code || level}: ${diagnostic.message || ''}`;
    list.appendChild(item);
  });
  area.appendChild(list);
  area.hidden = values.length === 0;
}

function cellHasLocalProtection(id) {
  const record = cellRecords.get(id);
  if (!record) return false;
  const source = sourceElement(id);
  const typeSelect = cellEls.get(id)?.querySelector('[data-role="type"]');
  return Boolean(record.ackGeneration < record.generation || record.drainPromise ||
    record.error || document.activeElement === source ||
    document.activeElement === typeSelect);
}

function renderEditRecovery(el, record) {
  const actions = el.querySelector('[data-role="cell-actions"]');
  if (!actions || record.tombstone) return;
  actions.querySelectorAll('[data-recovery]').forEach((node) => node.remove());
  if (!record.error) return;
  const button = document.createElement('button');
  button.className = 'btn mini';
  button.dataset.recovery = 'true';
  button.dataset.act = record.conflict ? 'use-server' : 'retry-edit';
  button.textContent = record.conflict ? 'Use server version' : 'Retry local edit';
  actions.appendChild(button);
}

function updateCell(el, cell) {
  const record = ensureCellRecord(cell);
  el.dataset.id = cell.id;
  el.id = `cell-${safeDomPart(cell.id)}`;
  el.dataset.tombstone = 'false';
  el.className = `cell ${cell.status || 'idle'}`;
  const badge = el.querySelector('[data-role="badge"]');
  if (badge) {
    badge.textContent = cell.status || 'idle';
    badge.className = `cell-badge ${cell.status || 'idle'}`;
  }
  const typeSelect = el.querySelector('[data-role="type"]');
  const protectedLocal = cellHasLocalProtection(cell.id);
  const visibleType = protectedLocal ? record.desiredType :
    (cell.type === 'markdown' ? 'markdown' : 'code');
  const source = el.querySelector('[data-role="source"]');
  if (typeSelect) typeSelect.id = `${el.id}-type`;
  if (source) source.id = `${el.id}-source`;
  if (typeSelect && !protectedLocal && document.activeElement !== typeSelect) {
    typeSelect.value = cell.type === 'markdown' ? 'markdown' : 'code';
  }
  if (source && !protectedLocal && document.activeElement !== source) {
    source.value = bodyText(record.desiredBody);
  }
  const sourceArea = el.querySelector('[data-role="source-area"]');
  if (sourceArea) {
    sourceArea.classList.toggle('md-area', visibleType === 'markdown');
    sourceArea.classList.toggle('code-area', visibleType !== 'markdown');
  }
  let diagnosticsArea = el.querySelector('[data-role="diagnostics"]');
  const diagnostics = Array.isArray(cell.diagnostics) ? cell.diagnostics : [];
  if (isViewApp() && diagnostics.length === 0) {
    diagnosticsArea?.remove();
    diagnosticsArea = null;
  } else {
    if (!diagnosticsArea) {
      diagnosticsArea = document.createElement('div');
      diagnosticsArea.className = 'diagnostics-area';
      diagnosticsArea.dataset.role = 'diagnostics';
      const output = el.querySelector('[data-role="output"]');
      el.insertBefore(diagnosticsArea, output || null);
    }
    renderDiagnostics(diagnosticsArea, diagnostics);
  }

  let outputArea = el.querySelector('[data-role="output"]');
  if (cell.output || !isViewApp()) {
    if (!outputArea) {
      outputArea = document.createElement('div');
      outputArea.className = 'output-area';
      outputArea.dataset.role = 'output';
      const diagnosticsNode = el.querySelector('[data-role="diagnostics"]');
      const logNode = el.querySelector('[data-role="log"]');
      const anchor = diagnosticsNode ? diagnosticsNode.nextSibling : logNode;
      el.insertBefore(outputArea, anchor || null);
    }
    renderOutput(outputArea, cell.output);
    outputArea.hidden = !cell.output && !isViewApp();
  } else if (outputArea) {
    outputArea.remove();
  }

  let logArea = el.querySelector('[data-role="log"]');
  const logs = Array.isArray(cell.log) ? cell.log : [];
  if (isViewApp() && logs.length === 0) {
    logArea?.remove();
    logArea = null;
  } else if (!logArea) {
    logArea = document.createElement('div');
    logArea.className = 'log-area';
    logArea.dataset.role = 'log';
    el.appendChild(logArea);
  }
  if (logArea) renderLogs(logArea, logs);
  const actions = el.querySelector('[data-role="cell-actions"]');
  if (actions && !actions.querySelector('[data-act="run"]') && !isViewApp()) {
    actions.replaceChildren();
    const run = document.createElement('button');
    run.className = 'btn mini primary';
    run.type = 'button';
    run.dataset.act = 'run';
    run.textContent = 'Run';
    const del = document.createElement('button');
    del.className = 'btn mini';
    del.type = 'button';
    del.dataset.act = 'delete';
    del.textContent = 'Delete';
    actions.append(run, del);
  }
  renderEditRecovery(el, record);
  const actionButtons = el.querySelectorAll('[data-act]');
  actionButtons.forEach((button) => {
    const act = button.dataset.act;
    if (act === 'run') {
      button.disabled = actionInFlight || !workerAvailable(renderingState || lastState) ||
        Boolean(renderingState?.runtime?.busy || lastState?.runtime?.busy);
    } else {
      button.disabled = actionInFlight;
    }
  });
  if (focusAfterCell === cell.id && source && !isViewApp()) {
    focusAfterCell = null;
    window.setTimeout(() => {
      source.focus();
      source.setSelectionRange(source.value.length, source.value.length);
    }, 0);
  }
}

function updateTombstone(el, id) {
  const record = cellRecords.get(id);
  if (!record) return;
  el.dataset.id = id;
  el.id = `cell-${safeDomPart(id)}`;
  el.dataset.tombstone = 'true';
  el.className = 'cell error tombstone';
  const badge = el.querySelector('[data-role="badge"]');
  if (badge) {
    badge.textContent = 'conflict: cell deleted on server';
    badge.className = 'cell-badge error';
  }
  const source = el.querySelector('[data-role="source"]');
  const type = el.querySelector('[data-role="type"]');
  if (source && document.activeElement !== source) source.value = bodyText(record.desiredBody);
  if (type && document.activeElement !== type) type.value = record.desiredType;
  const message = el.querySelector('[data-role="tombstone-message"]') ||
    document.createElement('div');
  message.dataset.role = 'tombstone-message';
  message.className = 'tombstone-message';
  message.textContent = record.error || 'This cell was deleted in another editor.';
  const sourceArea = el.querySelector('[data-role="source-area"]');
  if (sourceArea && !message.isConnected) sourceArea.after(message);
  const actions = el.querySelector('[data-role="cell-actions"]');
  if (actions) {
    actions.replaceChildren();
    const restore = document.createElement('button');
    restore.className = 'btn mini';
    restore.dataset.act = 'restore';
    restore.textContent = 'Restore as new cell';
    const discard = document.createElement('button');
    discard.className = 'btn mini';
    discard.dataset.act = 'discard-local';
    discard.textContent = 'Discard local cell';
    actions.append(restore, discard);
  }
}

function createCell(cell) {
  const fragment = els.cellTpl.content.cloneNode(true);
  const element = fragment.firstElementChild;
  if (isViewApp()) {
    element.querySelectorAll('[data-editor-only]').forEach((node) => node.remove());
  }
  return element;
}

function createAddButton(type, after) {
  const button = document.createElement('button');
  button.className = 'btn mini';
  button.dataset.act = 'add';
  button.dataset.type = type;
  if (after !== null && after !== undefined) button.dataset.after = after;
  button.textContent = type === 'markdown' ? '+ Add Markdown' : '+ Add code';
  return button;
}
function ensureEmptyBar() {
  if (!emptyBar) {
    if (els.emptyTpl) {
      emptyBar = els.emptyTpl.content.cloneNode(true).firstElementChild;
    } else {
      emptyBar = document.createElement('div');
      emptyBar.className = 'empty-bar';
      emptyBar.append(createAddButton('code', null), createAddButton('markdown', null));
    }
  }
  if (!isViewApp() && !emptyBar.isConnected) els.notebook.appendChild(emptyBar);
  if (isViewApp() && emptyBar.isConnected) emptyBar.remove();
  const message = emptyBar.querySelector('.empty-message');
  if (message) message.hidden = Boolean((renderingState || lastState)?.cells?.length);
}

function visibleCellNodes() {
  return [...els.notebook.children].filter((node) => node.classList.contains('cell'));

}
function reconcileCellOrder(cells) {
  let cursor = visibleCellNodes()[0] ||
    (emptyBar && emptyBar.isConnected ? emptyBar : null);
  for (const cell of cells) {
    const element = cellEls.get(cell.id);
    if (!element) continue;
    if (cursor === element) {
      // already in place: never re-insert, Chrome drops focus on moves
      cursor = element.nextElementSibling;
      continue;
    }
    els.notebook.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
  }
}

function predecessorFor(id, cells) {
  const oldOrder = cellOrder();
  const oldIndex = oldOrder.indexOf(id);
  if (oldIndex < 0) return null;
  const present = new Set((cells || []).map((cell) => cell.id));
  for (let i = oldIndex - 1; i >= 0; i -= 1) {
    if (present.has(oldOrder[i])) return oldOrder[i];
  }
  return null;
}

function removeUnseenCells(seen, cells) {
  for (const [id, element] of [...cellEls.entries()]) {
    if (seen.has(id)) continue;
    const record = cellRecords.get(id);
    if (record && cellHasLocalProtection(id)) {
      if (!record.tombstone) record.predecessor = predecessorFor(id, cells);
      record.tombstone = true;
      updateTombstone(element, id);
      if (emptyBar && emptyBar.isConnected) els.notebook.insertBefore(element, emptyBar);
      else els.notebook.appendChild(element);
    } else {
      element.remove();
      cellEls.delete(id);
      cellRecords.delete(id);
    }
  }
}

function workerAvailable(state = renderingState || lastState) {
  return state?.runtime?.worker_available !== false;
}

function renderControls(st) {
  const runtime = st.runtime || {};
  const busy = Boolean(runtime.busy);
  const unavailable = runtime.worker_available === false;
  if (els.runtime) {
    if (document.activeElement !== els.runtime) els.runtime.value =
      runtime.execution_mode === 'lazy' ? 'lazy' : 'automatic';
    els.runtime.disabled = actionInFlight;
  }
  if (els.runAll) {
    els.runAll.textContent = runtime.execution_mode === 'lazy' ? 'Run stale' : 'Run all';
    els.runAll.title = runtime.execution_mode === 'lazy'
      ? 'Run all stale cells' : 'Run all cells';
    els.runAll.disabled = actionInFlight || unavailable || busy;
  }
  if (els.stop) els.stop.disabled = actionInFlight || unavailable || !busy;
  if (els.save) els.save.disabled = actionInFlight || !st.changed;
  if (els.appMode) els.appMode.hidden = isViewApp();
  if (els.editMode) els.editMode.hidden = !isViewApp();
  for (const element of cellEls.values()) {
    element.querySelectorAll('[data-act]').forEach((button) => {
      if (button.dataset.act === 'run') {
        button.disabled = actionInFlight || unavailable || busy;
      } else {
        button.disabled = actionInFlight;
      }
    });
}
}
function render(st) {
  if (!st || typeof st.version !== 'number' || st.version < lastRenderedVersion) return false;
  renderingState = st;
  if (!actionError && st.last_action_error?.message) {
    actionError = st.last_action_error.message;
  }
  document.body.classList.toggle('app-view', isViewApp());
  if (isViewApp()) {
    document.querySelectorAll('#topbar .editor-only').forEach((node) => node.remove());
  }
  if (els.path) els.path.textContent = st.path || 'untitled notebook';
  renderControls(st);
  resolveWidgetWaiters(st);

  const cells = Array.isArray(st.cells) ? st.cells : [];
  const seen = new Set();
  for (const cell of cells) {
    seen.add(cell.id);
    let element = cellEls.get(cell.id);
    if (!element) {
      element = createCell(cell);
      cellEls.set(cell.id, element);
    }
    updateCell(element, cell);
  }
  removeUnseenCells(seen, cells);
  ensureEmptyBar();
  if (!isViewApp()) {
    for (const cell of cells) {
      const element = cellEls.get(cell.id);
      const addArea = element?.querySelector('[data-role="cell-add"]');
      if (addArea) {
        addArea.replaceChildren(createAddButton('code', cell.id),
          createAddButton('markdown', cell.id));
      }
    }
  }
  reconcileCellOrder(cells);
  renderStatus();
  lastState = st;
  lastRenderedVersion = st.version;
  renderingState = null;
  return true;
}

function refresh(signal) {
  return api('/api/state', { signal }).then((st) => {
    render(st);
    return st;
  });
}

async function action(task) {
  actionInFlight = true;
  renderControls(lastState || { runtime: {}, changed: false });
  try {
    await task();
    actionError = null;
    pollError = null;
    renderStatus();
    await refresh();
  } catch (error) {
    showActionError(error.message);
  } finally {
    actionInFlight = false;
    if (lastState) renderControls(lastState);
  }
}

async function addCell(type, after) {
  await flushPendingEdits();
  const body = type === 'markdown' ? ['# '] : [];
  const response = await api('/api/cell', {
    body: { op: 'add', after: after ?? null, body, type },
  });
  focusAfterCell = response.id || null;
}

async function deleteCell(id) {
  await flushPendingEdits();
  const record = cellRecords.get(id);
  if (!record) throw editError(`no such cell: ${id}`, 'not_found');
  await api('/api/cell', {
    body: { op: 'delete', id, expected_revision: record.ackServerRevision },
  });
}

function localSourceFor(id) {
  const source = sourceElement(id);
  return source ? splitBody(source.value) : (cellRecords.get(id)?.desiredBody || []);
}

async function handleCellAction(button) {
  const element = button.closest('.cell');
  const id = element?.dataset.id;
  const act = button.dataset.act;
  if (!element && act === 'add') {
    await addCell(button.dataset.type || 'code', null);
    return;
  }
  if (!element) return;
  if (act === 'run') {
    await flushPendingEdits();
    await flushWidgetUpdates();
    await api('/api/run', { body: { cell: id } });
  } else if (act === 'add') {
    await addCell(button.dataset.type || 'code', button.dataset.after ?? id);
  } else if (act === 'delete') {
    await deleteCell(id);
  } else if (act === 'use-server') {
    resolveSourceConflict(id);
    return;
  } else if (act === 'retry-edit') {
    await retryEdit(id);
  } else if (act === 'restore') {
    await restoreTombstone(id);
  } else if (act === 'discard-local') {
    discardTombstone(id);
    return;
  }
}

function resolveSourceConflict(id) {
  const record = cellRecords.get(id);
  if (!record) return;
  const oldError = record.error;
  clearTimeout(record.timer);
  record.timer = null;
  record.desiredBody = record.serverBody.slice();
  record.desiredType = record.serverType;
  record.ackGeneration = record.generation;
  record.ackServerRevision = record.latestServerRevision;
  record.failedGeneration = null;
  record.error = null;
  record.conflict = false;
  if (actionError === oldError) {
    actionError = null;
    renderStatus();
  }
  if (lastState) render(lastState);
}

async function retryEdit(id) {
  const record = cellRecords.get(id);
  if (!record) return;
  record.error = null;
  record.conflict = false;
  record.failedGeneration = null;
  await drainEdit(id);
}

async function restoreTombstone(id) {
  const record = cellRecords.get(id);
  if (!record) return;
  // The tombstone is already absent from the server. Its protected local
  // body is the payload to restore; flushing it would recreate the conflict.
  const response = await api('/api/cell', {
    body: {
      op: 'add', after: record.predecessor ?? null,
      body: record.desiredBody.slice(), type: record.desiredType,
    },
  });
  cellEls.get(id)?.remove();
  cellEls.delete(id);
  cellRecords.delete(id);
  focusAfterCell = response.id || null;
}

function discardTombstone(id) {
  const element = cellEls.get(id);
  element?.remove();
  cellEls.delete(id);
  cellRecords.delete(id);
}

function handleWidgetEvent(control, eventType) {
  const kind = control.dataset.kind;
  const name = control.dataset.name;
  if (!kind || !name) return;
  const source = widgetSource();
  if (kind === 'run_button' && eventType === 'click') {
    control.disabled = true;
    commitWidgetUpdate(name, kind, true, null, source).catch(() => {});
    return;
  }
  if (eventType === 'input' && kind === 'slider') {
    const value = Number(control.value);
    const valueLabel = control.closest('.widget-container')?.querySelector('.widget-value');
    if (valueLabel) valueLabel.textContent = String(value);
    if (Number.isFinite(value)) commitWidgetUpdate(name, kind, value, null, source).catch(() => {});
    return;
  }
  if (eventType !== 'change') return;
  if (kind === 'dropdown') {
    const index = Number(control.value);
    if (Number.isInteger(index) && index > 0) {
      commitWidgetUpdate(name, kind, null, index, source).catch(() => {});
    }
  } else if (kind === 'checkbox') {
    commitWidgetUpdate(name, kind, Boolean(control.checked), null, source).catch(() => {});
  } else if (kind === 'number') {
    const value = Number(control.value);
    if (control.value.trim() !== '' && Number.isFinite(value)) {
      commitWidgetUpdate(name, kind, value, null, source).catch(() => {});
    }
  } else if (kind === 'text_input') {
    commitWidgetUpdate(name, kind, control.value, null, source).catch(() => {});
  }
}

els.notebook.addEventListener('input', (event) => {
  const source = event.target.closest('[data-role="source"]');
  if (source) {
    const element = source.closest('.cell');
    if (element) {
      const id = element.dataset.id;
      const type = element.querySelector('[data-role="type"]')?.value || 'code';
      startEdit(id, splitBody(source.value), type);
    }
    return;
  }
  const control = event.target.closest('[data-role="widget"]');
  if (control) handleWidgetEvent(control, 'input');
});

els.notebook.addEventListener('change', (event) => {
  const type = event.target.closest('[data-role="type"]');
  if (type) {
    const element = type.closest('.cell');
    if (element) startEdit(element.dataset.id, localSourceFor(element.dataset.id), type.value);
    return;
  }
  const control = event.target.closest('[data-role="widget"]');
  if (control) handleWidgetEvent(control, 'change');
});

els.notebook.addEventListener('click', (event) => {
  const control = event.target.closest('[data-role="widget"]');
  if (control && control.dataset.kind === 'run_button') {
    handleWidgetEvent(control, 'click');
    return;
  }
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  event.preventDefault();
  const localOnly = button.dataset.act === 'use-server' ||
    button.dataset.act === 'discard-local';
  if (localOnly) {
    handleCellAction(button);
  } else {
    action(() => handleCellAction(button));
  }
});

if (els.runAll) els.runAll.addEventListener('click', (event) => {
  event.preventDefault();
  action(async () => {
    await flushPendingEdits();
    await flushWidgetUpdates();
    await api('/api/run', { body: { all: true } });
  });
});

if (els.stop) els.stop.addEventListener('click', (event) => {
  event.preventDefault();
  action(() => api('/api/interrupt', { method: 'POST' }));
});

if (els.save) els.save.addEventListener('click', (event) => {
  event.preventDefault();
  action(async () => {
    await flushPendingEdits();
    await api('/api/save', { method: 'POST' });
  });
});

if (els.runtime) els.runtime.addEventListener('change', () => {
  const mode = els.runtime.value === 'lazy' ? 'lazy' : 'automatic';
  action(() => api('/api/runtime', { body: { execution_mode: mode } }));
});

if (els.appMode) els.appMode.addEventListener('click', (event) => {
  event.preventDefault();
  action(async () => {
    await flushPendingEdits();
    await flushWidgetUpdates();
    setViewApp(true);
  });
});
if (els.editMode) els.editMode.addEventListener('click', (event) => {
  event.preventDefault();
  setViewApp(false);
});

window.addEventListener('beforeunload', (event) => {
  if (suppressUnloadOnce) {
    suppressUnloadOnce = false;
    return;
  }
  const dirty = [...cellRecords.values()].some((record) =>
    record.ackGeneration < record.generation || record.error);
  if (dirty || Boolean(lastState?.changed)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function pollLoop() {
  while (!pollAbort.signal.aborted) {
    try {
      await refresh(pollAbort.signal);
      pollError = null;
      renderStatus();
    } catch (error) {
      if (error.name !== 'AbortError') {
        pollError = error.message;
        if (!actionError) renderStatus();
      }
    }
    await new Promise((resolve) => {
      const timer = window.setTimeout(resolve, 800);
      pollAbort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

// The first request and every subsequent request are serialized by pollLoop;
// there is never a setInterval race with an action-triggered refresh.
pollLoop();
