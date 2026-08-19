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
  settingsOpen: document.getElementById('settings-open'),
  settings: document.getElementById('settings'),
  settingsForm: document.getElementById('settings-form'),
  settingsClose: document.getElementById('settings-close'),
  settingsCancel: document.getElementById('settings-cancel'),
  settingsTheme: document.getElementById('settings-theme'),
  settingsKeymap: document.getElementById('settings-keymap'),
  settingsFontSize: document.getElementById('settings-font-size'),
  settingsTabSize: document.getElementById('settings-tab-size'),
  settingsTablePageSize: document.getElementById('settings-table-page-size'),
  settingsLineNumbers: document.getElementById('settings-line-numbers'),
  settingsAutosave: document.getElementById('settings-autosave'),
  settingsFormatOnSave: document.getElementById('settings-format-on-save'),
  vimIndicator: document.getElementById('vim-mode-indicator'),
  status: document.getElementById('status'),
  cellTpl: document.getElementById('cell-tpl'),
  emptyTpl: document.getElementById('empty-bar'),
  panelToggle: document.getElementById('panel-toggle'),
  panelClose: document.getElementById('panel-close'),
  panel: document.getElementById('dataflow-panel'),
  panelTabs: [...document.querySelectorAll('[data-panel-tab]')],
  panelViews: {
    variables: document.getElementById('panel-variables'),
    dependencies: document.getElementById('panel-dependencies'),
    graph: document.getElementById('panel-graph'),
    outline: document.getElementById('panel-outline'),
  },
  minimap: document.getElementById('minimap'),
};

let lastRenderedVersion = -1;
const cellRecords = new Map();
const editorHandles = new Map();
window.__alderEditors = editorHandles;
const cellEls = new Map();
const lastWidgetOps = new Map();
const pendingWidgetOps = new Map();
const widgetWaiters = new Map();
let actionError = null;
let pollError = null;

// Best-effort report of client-side failures to the server logs. Never throws:
// logging itself must not crash the app or recurse back into error handling.
async function clientLog(level, message, extra = {}) {
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, ...extra }),
    });
  } catch (error) {
    // swallowing is intentional: /api/log must never break the caller
  }
}

window.addEventListener('error', (event) => {
  const error = event.error;
  clientLog('error', event.message || 'Uncaught JS error', {
    source: 'window.error',
    url: event.filename || location.href,
    stack: (error && error.stack) || '',
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  clientLog('error', (reason && reason.message) || String(reason), {
    source: 'unhandledrejection',
    stack: (reason && reason.stack) || '',
  });
});
const pollAbort = new AbortController();
let lastState = null;
let renderingState = null;
let emptyBar = null;
let actionInFlight = false;
let autosaveTimer = null;
let focusAfterCell = null;
let suppressUnloadOnce = false;
const pendingMarker = Symbol('pending-widget-value');
let focusedCellId = null;
let variableFilter = '';
let graphOrientation = 'vertical';
let dataflowPanel = loadPanelPreference();

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
  function fail(error) {
    if (error && error.name !== 'AbortError') {
      clientLog('error', `API ${path}: ${error.message}`, {
        source: 'api',
        code: error.code,
        status: error.status,
      });
    }
    throw error;
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    return fail(new ApiError(`Network error: ${error.message}`, 'internal_error', 0));
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    return fail(new ApiError(`Invalid JSON from ${path} (HTTP ${response.status})`,
      'internal_error', response.status));
  }
  if (!response.ok || (data && data.ok === false)) {
    const detail = data && data.error;
    if (detail && typeof detail === 'object') {
      return fail(new ApiError(detail.message || 'Request failed',
        detail.code || 'internal_error', response.status));
    }
    return fail(new ApiError(typeof detail === 'string' ? detail : `HTTP ${response.status}`,
      'internal_error', response.status));
  }
  return data;
}
function showActionError(message) {
  actionError = message || 'Request failed';
  renderStatus();
  clientLog('error', `UI: ${actionError}`, { source: 'toast' });
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
if (isViewApp()) {
  document.body.classList.add('app-view');
  document.querySelectorAll('#topbar .editor-only').forEach((node) => node.remove());
}

function setViewApp(app) {
  const target = app ? '/?view=app' : '/?view=editor';
  if (app) {
    document.body.classList.add('app-view');
    document.querySelectorAll('#topbar .editor-only').forEach((node) => node.remove());
  }
  suppressUnloadOnce = true;
  window.location.assign(target);
}

function splitBody(text) {
  return text === '' ? [] : text.split('\n');
}

function bodyText(body) {
  return Array.isArray(body) ? body.join('\n') : '';
}

function cellType(type) {
  return type === 'markdown' || type === 'sql' ? type : 'code';
}

function parseSqlBody(body) {
  const text = bodyText(body);
  const match = text.match(
    /^\s*([A-Za-z][A-Za-z0-9_.]*)\s*<-\s*sql\(\s*r"(-+)\(([\s\S]*)\)\2"(?:\s*,\s*conn\s*=\s*(.+?))?\s*\)\s*$/,
  );
  if (!match) return null;
  let query = match[3];
  if (query.startsWith('\n')) query = query.slice(1);
  if (query.endsWith('\n')) query = query.slice(0, -1);
  return {
    into: match[1],
    query,
    conn: match[4] ? match[4].trim() : null,
  };
}

function sqlDelimiter(query) {
  let dashes = '---';
  while (query.includes(`)${dashes}"`)) dashes += '-';
  return dashes;
}

function sqlBody({ query, conn = null, into = 'result' }) {
  const dashes = sqlDelimiter(query);
  const lines = query === '' ? [] : query.split('\n');
  const closing = `)${dashes}"${conn ? `, conn = ${conn}` : ''})`;
  return [`${into} <- sql(r"${dashes}(`, ...lines, closing];
}

function sqlSpecFromRecord(record) {
  if (record?.desiredSql) return record.desiredSql;
  return parseSqlBody(record?.desiredBody || []) || {
    into: 'result', query: '', conn: null,
  };
}

function cellOrder() {
  return lastState && Array.isArray(lastState.cells) ? lastState.cells.map((c) => c.id) : [];
}

function makeCellRecord(cell) {
  const revision = Number.isInteger(cell.revision) ? cell.revision : 0;
  const body = Array.isArray(cell.body) ? cell.body.slice() : [];
  return {
    desiredBody: body,
    desiredType: cellType(cell.type),
    desiredSql: cell.type === 'sql' ? parseSqlBody(body) : null,
    generation: 0,
    ackGeneration: 0,
    ackServerRevision: revision,
    latestServerRevision: revision,
    timer: null,
    drainPromise: null,
    failedGeneration: null,
    error: null,
    conflict: false,
    serverBody: body.slice(),
    serverType: cellType(cell.type),
    serverSql: cell.type === 'sql' ? parseSqlBody(body) : null,
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
  record.serverType = cellType(cell.type);
  record.serverSql = record.serverType === 'sql'
    ? parseSqlBody(record.serverBody) : null;

  const focusedSql = cellEls.get(cell.id)?.querySelector(
    '[data-role="sql-query"], [data-role="sql-conn"], [data-role="sql-into"]',
  );
  const focused = sourceFocused(cell.id) ||
    Boolean(focusedSql && focusedSql.contains(document.activeElement)) ||
    Boolean(cellEls.get(cell.id) && document.activeElement ===
      cellEls.get(cell.id).querySelector('[data-role="type"]'));
  const protectedLocal = record.ackGeneration < record.generation ||
    Boolean(record.drainPromise) || Boolean(record.error);
  if (!focused && !protectedLocal && record.latestServerRevision >= record.ackServerRevision) {
    record.desiredBody = record.serverBody.slice();
    record.desiredType = record.serverType;
    record.desiredSql = record.serverSql;
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

function sourceEditor(id) {
  return editorHandles.get(id) || null;
}

function sourceFocused(id) {
  const source = sourceElement(id);
  return Boolean(source && source.contains(document.activeElement));
}

function sourceText(id) {
  const editor = sourceEditor(id);
  if (editor) return editor.getDoc();
  return bodyText(cellRecords.get(id)?.desiredBody || []);
}

function focusSource(id) {
  const editor = sourceEditor(id);
  if (editor) {
    editor.focus();
    return;
  }
  sourceElement(id)?.focus();
}

const lspRequests = new Map();

function lspPosition(view, id, pos) {
  const line = view.state.doc.lineAt(pos);
  return {
    cell: id,
    line: line.number - 1,
    character: pos - line.from,
  };
}

function lspText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(lspText).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.value === 'string') return value.value;
    if (typeof value.contents !== 'undefined') return lspText(value.contents);
  }
  return value == null ? '' : String(value);
}

function lspKind(kind) {
  return ({
    1: 'text', 2: 'method', 3: 'function', 4: 'constructor',
    5: 'class', 6: 'method', 7: 'property', 8: 'variable',
    9: 'constant', 10: 'struct', 11: 'event', 12: 'operator',
    13: 'type', 14: 'namespace', 15: 'keyword', 16: 'modifier',
    17: 'number', 18: 'string', 19: 'regexp', 20: 'class',
    21: 'interface', 22: 'function', 23: 'variable', 24: 'value',
    25: 'unit', 26: 'value', 27: 'enum', 28: 'interface',
  }[Number(kind)] || 'variable');
}

function lspCompletionSource(id, context) {
  const word = context.matchBefore(/[A-Za-z.][A-Za-z0-9_.]*|[A-Za-z0-9_]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const key = `completion:${id}`;
  lspRequests.get(key)?.abort();
  const controller = new AbortController();
  lspRequests.set(key, controller);
  const request = flushPendingEdits()
    .then(() => api('/api/lsp', {
      signal: controller.signal,
      body: {
        method: 'textDocument/completion',
        params: { position: lspPosition(context, id, context.pos) },
      },
    }))
    .then((response) => {
      const result = response.result || {};
      const items = Array.isArray(result) ? result : (result.items || []);
      return {
        from: word.from,
        options: items.map((item) => ({
          label: String(item.label || item.insertText || ''),
          type: lspKind(item.kind),
          detail: item.detail || '',
          info: lspText(item.documentation),
          apply: item.insertText || item.label,
        })).filter((item) => item.label),
      };
    })
    .catch((error) => {
      if (error?.name !== 'AbortError') return null;
      return null;
    })
    .finally(() => {
      if (lspRequests.get(key) === controller) lspRequests.delete(key);
    });
  return request;
}

function lspHover(id, view, pos) {
  const key = `hover:${id}`;
  lspRequests.get(key)?.abort();
  const controller = new AbortController();
  lspRequests.set(key, controller);
  return flushPendingEdits()
    .then(() => api('/api/lsp', {
      signal: controller.signal,
      body: {method: 'textDocument/hover',
        params: {position: lspPosition(view, id, pos)}},
    }))
    .then((response) => controller.signal.aborted ? null
      : lspText(response.result?.contents))
    .catch(() => null)
    .finally(() => {
      if (lspRequests.get(key) === controller) lspRequests.delete(key);
    });
}

function dataflowState(state = renderingState || lastState) {
  const aggregate = state?.dataflow && typeof state.dataflow === 'object'
    ? state.dataflow : {};
  return {
    variables: Array.isArray(aggregate.variables) ? aggregate.variables
      : Array.isArray(state?.variables) ? state.variables : [],
    dag: aggregate.dag && typeof aggregate.dag === 'object' ? aggregate.dag
      : state?.dag && typeof state.dag === 'object' ? state.dag : {},
    outline: Array.isArray(aggregate.outline) ? aggregate.outline
      : Array.isArray(state?.outline) ? state.outline : [],
    reactiveRanges: aggregate.reactive_ranges &&
      typeof aggregate.reactive_ranges === 'object'
      ? aggregate.reactive_ranges
      : state?.reactive_ranges && typeof state.reactive_ranges === 'object'
        ? state.reactive_ranges : {},
  };
}

function sourceOffset(view, position) {
  if (!view || !position) return null;
  try {
    const line = view.state.doc.line(Number(position.line) + 1);
    const character = Math.max(0, Math.min(
      Number(position.character) || 0, line.length,
    ));
    return line.from + character;
  } catch (_) {
    return null;
  }
}

function reactiveReferenceRanges(id, text) {
  const state = renderingState || lastState;
  const editor = editorHandles.get(id);
  const projected = dataflowState(state).reactiveRanges[id];
  if (Array.isArray(projected) && editor?.view) {
    return projected
      .filter((range) => range?.kind === 'reference' && range.target)
      .map((range) => ({
        from: sourceOffset(editor.view, range.start || {
          line: range.line, character: range.character,
        }),
        to: sourceOffset(editor.view, range.end || {
          line: range.end_line, character: range.end_character,
        }),
      }))
      .filter((range) => Number.isInteger(range.from) &&
        Number.isInteger(range.to) && range.to > range.from);
  }
  const refs = new Set(state?.cells?.find((cell) => cell.id === id)?.refs || []);
  const owners = new Map();
  for (const cell of state?.cells || []) {
    for (const name of cell.defs || []) {
      if (!owners.has(name)) owners.set(name, cell.id);
    }
  }
  const ranges = [];
  const re = /[A-Za-z.][A-Za-z0-9_.]*/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (refs.has(match[0]) && owners.get(match[0]) && owners.get(match[0]) !== id) {
      ranges.push({from: match.index, to: match.index + match[0].length});
    }
  }
  return ranges;
}

function editorDiagnostics(cell, editor) {
  const result = [];
  for (const diagnostic of cell.diagnostics || []) {
    if (diagnostic.source !== 'lsp' || !diagnostic.range) continue;
    try {
      const startLine = editor.view.state.doc.line(diagnostic.range.start.line + 1);
      const endLine = editor.view.state.doc.line(diagnostic.range.end.line + 1);
      result.push({
        from: startLine.from + Number(diagnostic.range.start.character || 0),
        to: endLine.from + Number(diagnostic.range.end.character || 0),
        severity: diagnostic.level === 'warning' ? 'warning' : 'error',
        message: diagnostic.message || diagnostic.code || 'language-server diagnostic',
      });
    } catch (_) {
      // A stale diagnostic range is discarded until the next server refresh.
    }
  }
  return result;
}

function jumpReactiveReference(id, view, pos) {
  const projected = dataflowState().reactiveRanges[id];
  if (Array.isArray(projected)) {
    const match = projected.find((range) => {
      if (range?.kind !== 'reference' || !range.target) return false;
      const from = sourceOffset(view, range.start || {
        line: range.line, character: range.character,
      });
      const to = sourceOffset(view, range.end || {
        line: range.end_line, character: range.end_character,
      });
      return Number.isInteger(from) && Number.isInteger(to) &&
        pos >= from && pos <= to;
    });
    if (match) {
      navigateToCell(match.target, null, {focus: true});
      return;
    }
  }
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  const re = /[A-Za-z.][A-Za-z0-9_.]*/g;
  let match;
  while ((match = re.exec(line.text)) !== null) {
    if (offset < match.index || offset > match.index + match[0].length) continue;
    const target = (lastState?.cells || []).find((cell) =>
      cell.id !== id && (cell.defs || []).includes(match[0]));
    if (target) navigateToCell(target.id, null, {focus: true});
    return;
  }
}

function loadPanelPreference() {
  const fallback = {open: true, tab: 'variables'};
  try {
    const value = JSON.parse(window.localStorage.getItem('alder.panel') || 'null');
    if (!value || typeof value !== 'object') return fallback;
    return {
      open: value.open !== false,
      tab: ['variables', 'dependencies', 'graph', 'outline'].includes(value.tab)
        ? value.tab : fallback.tab,
    };
  } catch (_) {
    return fallback;
  }
}

function savePanelPreference() {
  try {
    window.localStorage.setItem('alder.panel', JSON.stringify(dataflowPanel));
  } catch (_) {
    // Storage may be unavailable in a private or embedded browsing context.
  }
}

function cellLabel(id, state = renderingState || lastState) {
  const info = dataflowState(state).dag.node_info?.[id];
  const outline = dataflowState(state).outline.find((item) => item.id === id);
  return info?.name || outline?.name || outline?.label || id;
}

function navigateToCell(id, line = null, options = {}) {
  const element = cellEls.get(id);
  if (!element) return false;
  focusedCellId = id;
  element.scrollIntoView({behavior: options.smooth === false ? 'auto' : 'smooth',
    block: 'center'});
  renderDataflow(lastState);
  window.setTimeout(() => {
    const editor = editorHandles.get(id);
    if (editor && Number.isInteger(line) && line >= 0) {
      try {
        const docLine = editor.view.state.doc.line(line + 1);
        editor.view.dispatch({
          selection: {anchor: docLine.from},
          scrollIntoView: true,
        });
      } catch (_) {
        // A stale outline line still navigates to and focuses the cell.
      }
    }
    if (options.focus !== false) focusSource(id);
  }, 0);
  return true;
}

function panelButton(label, id, line = null, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `panel-link ${className}`.trim();
  button.textContent = label;
  if (id) {
    button.dataset.targetCell = id;
    if (Number.isInteger(line)) button.dataset.targetLine = String(line);
  } else {
    button.disabled = true;
  }
  return button;
}

function panelEmpty(message) {
  const node = document.createElement('p');
  node.className = 'panel-empty';
  node.textContent = message;
  return node;
}

function variableOwner(variable) {
  return variable?.owner || variable?.cell || null;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function renderVariablesPanel(state) {
  const view = els.panelViews.variables;
  if (!view) return;
  const dataflow = dataflowState(state);
  let input = view.querySelector('.panel-filter');
  if (!input) {
    input = document.createElement('input');
    input.type = 'search';
    input.className = 'panel-filter';
    input.placeholder = 'Filter variables';
    input.setAttribute('aria-label', 'Filter variables');
    view.appendChild(input);
  }
  if (document.activeElement !== input) input.value = variableFilter;
  let list = view.querySelector('.variable-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'variable-list';
    view.appendChild(list);
  }
  list.replaceChildren();
  const query = variableFilter.trim().toLocaleLowerCase();
  const variables = dataflow.variables.filter((variable) =>
    !query || String(variable?.name || '').toLocaleLowerCase().includes(query));
  for (const variable of variables) {
    const owner = variableOwner(variable);
    const row = panelButton(variable.name || 'unnamed variable', owner, null,
      'variable-row');
    const title = document.createElement('span');
    title.className = 'variable-name';
    title.textContent = variable.name || 'unnamed';
    const meta = document.createElement('span');
    meta.className = 'variable-meta';
    const dimensions = Array.isArray(variable.dim) && variable.dim.length
      ? variable.dim.join('×') : '';
    meta.textContent = [
      variable.class || '',
      dimensions,
      formatBytes(variable.size),
      owner ? cellLabel(owner, state) : '',
    ].filter(Boolean).join(' · ');
    const summary = document.createElement('span');
    summary.className = 'variable-summary';
    summary.textContent = variable.value_summary || variable.summary || '';
    row.replaceChildren(title, meta);
    if (summary.textContent) row.appendChild(summary);
    if (variable.widget) {
      const tag = document.createElement('span');
      tag.className = 'panel-tag';
      tag.textContent = 'widget';
      row.appendChild(tag);
    }
    list.appendChild(row);
  }
  if (!variables.length) {
    list.appendChild(panelEmpty(query ? 'No variables match this filter.'
      : 'Run a cell to inspect its variables.'));
  }
  if (input.nextElementSibling !== list) input.after(list);
}

function graphNeighbors(map, start) {
  const result = [];
  const seen = new Set([start]);
  const visit = (id) => {
    for (const next of Array.isArray(map?.[id]) ? map[id] : []) {
      if (seen.has(next)) continue;
      seen.add(next);
      result.push(next);
      visit(next);
    }
  };
  visit(start);
  return result;
}

function dependencySection(title, items, state, empty) {
  const section = document.createElement('section');
  section.className = 'dependency-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);
  if (!items.length) {
    section.appendChild(panelEmpty(empty));
    return section;
  }
  const list = document.createElement('div');
  list.className = 'dependency-list';
  for (const item of items) {
    list.appendChild(panelButton(
      item.label || cellLabel(item.id, state), item.id, null,
    ));
  }
  section.appendChild(list);
  return section;
}

function renderDependenciesPanel(state) {
  const view = els.panelViews.dependencies;
  if (!view) return;
  const cells = Array.isArray(state?.cells) ? state.cells : [];
  const current = cells.find((cell) => cell.id === focusedCellId);
  if (!current) {
    view.replaceChildren(panelEmpty('Focus a cell to inspect its dataflow.'));
    return;
  }
  const dataflow = dataflowState(state);
  const dag = dataflow.dag;
  const variables = new Map(dataflow.variables.map((variable) =>
    [variable.name, variable]));
  const title = document.createElement('div');
  title.className = 'focused-cell';
  title.textContent = cellLabel(current.id, state);
  const refs = (current.refs || []).map((name) => {
    const owner = variableOwner(variables.get(name));
    return {id: owner, label: owner ? `${name} ← ${cellLabel(owner, state)}` : name};
  });
  const defs = (current.defs || []).map((name) =>
    ({id: current.id, label: name}));
  const ancestors = graphNeighbors(dag.edges, current.id)
    .map((id) => ({id}));
  const descendants = graphNeighbors(dag.reverse_edges, current.id)
    .map((id) => ({id}));
  view.replaceChildren(
    title,
    dependencySection('References', refs, state, 'No direct references.'),
    dependencySection('Definitions', defs, state, 'No definitions.'),
    dependencySection('Ancestors', ancestors, state, 'No ancestors.'),
    dependencySection('Descendants', descendants, state, 'No descendants.'),
  );
}

function graphRanks(nodes, edges) {
  const ranks = new Map();
  const visiting = new Set();
  const rank = (id) => {
    if (ranks.has(id)) return ranks.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (Array.isArray(edges?.[id]) ? edges[id] : [])
      .filter((dep) => nodes.includes(dep));
    const value = deps.length ? Math.max(...deps.map((dep) => rank(dep) + 1)) : 0;
    visiting.delete(id);
    ranks.set(id, value);
    return value;
  };
  nodes.forEach(rank);
  return ranks;
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attributes).forEach(([key, value]) =>
    node.setAttribute(key, String(value)));
  return node;
}

function renderGraphPanel(state) {
  const view = els.panelViews.graph;
  if (!view) return;
  const dag = dataflowState(state).dag;
  const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
  const records = Array.isArray(dag.edge_records) ? dag.edge_records : [];
  const toolbar = document.createElement('div');
  toolbar.className = 'graph-toolbar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'panel-secondary';
  toggle.dataset.graphOrientation = graphOrientation;
  toggle.textContent = graphOrientation === 'vertical' ? 'Horizontal layout'
    : 'Vertical layout';
  toolbar.appendChild(toggle);
  if (!nodes.length) {
    view.replaceChildren(toolbar, panelEmpty('No dependency graph is available.'));
    return;
  }
  const ranks = graphRanks(nodes, dag.edges || {});
  const groups = new Map();
  nodes.forEach((id) => {
    const rank = ranks.get(id) || 0;
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank).push(id);
  });
  const nodeWidth = 128;
  const nodeHeight = 38;
  const rankGap = 70;
  const itemGap = 18;
  const positions = new Map();
  let crossCount = 1;
  for (const group of groups.values()) crossCount = Math.max(crossCount, group.length);
  for (const [rank, group] of groups.entries()) {
    group.forEach((id, index) => {
      const primary = 18 + rank * (nodeHeight + rankGap);
      const cross = 18 + index * (nodeWidth + itemGap);
      positions.set(id, graphOrientation === 'vertical'
        ? {x: cross, y: primary} : {x: primary, y: cross});
    });
  }
  const rankCount = Math.max(0, ...ranks.values()) + 1;
  const width = graphOrientation === 'vertical'
    ? 36 + crossCount * nodeWidth + (crossCount - 1) * itemGap
    : 36 + rankCount * nodeWidth + (rankCount - 1) * rankGap;
  const height = graphOrientation === 'vertical'
    ? 36 + rankCount * nodeHeight + (rankCount - 1) * rankGap
    : 36 + crossCount * nodeHeight + (crossCount - 1) * itemGap;
  const svg = svgElement('svg', {
    class: 'dag-graph', viewBox: `0 0 ${width} ${height}`,
    role: 'img', 'aria-label': 'Notebook dependency graph',
  });
  const cycleNodes = new Set(dag.cycles || dag.cycle_nodes || []);
  for (const edge of records) {
    const from = positions.get(edge?.from);
    const to = positions.get(edge?.to);
    if (!from || !to) continue;
    const x1 = from.x + nodeWidth / 2;
    const y1 = from.y + nodeHeight / 2;
    const x2 = to.x + nodeWidth / 2;
    const y2 = to.y + nodeHeight / 2;
    const path = svgElement('path', {
      class: cycleNodes.has(edge.from) && cycleNodes.has(edge.to)
        ? 'dag-edge cycle' : 'dag-edge',
      d: graphOrientation === 'vertical'
        ? `M ${x1} ${from.y + nodeHeight} C ${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${to.y}`
        : `M ${from.x + nodeWidth} ${y1} C ${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${to.x} ${y2}`,
    });
    svg.appendChild(path);
  }
  for (const id of nodes) {
    const position = positions.get(id);
    const info = dag.node_info?.[id] || {};
    const group = svgElement('g', {
      class: `dag-node status-${info.status || 'idle'}${cycleNodes.has(id) ? ' cycle' : ''}`,
      role: 'button', tabindex: '0', 'data-target-cell': id,
      'aria-label': `Go to ${cellLabel(id, state)}`,
    });
    group.appendChild(svgElement('rect', {
      x: position.x, y: position.y, width: nodeWidth, height: nodeHeight, rx: 5,
    }));
    const label = svgElement('text', {
      x: position.x + 9, y: position.y + 16,
    });
    label.textContent = cellLabel(id, state);
    const status = svgElement('text', {
      class: 'dag-node-status', x: position.x + 9, y: position.y + 30,
    });
    status.textContent = info.status || 'idle';
    group.append(label, status);
    svg.appendChild(group);
  }
  const scroller = document.createElement('div');
  scroller.className = 'graph-scroll';
  scroller.appendChild(svg);
  view.replaceChildren(toolbar, scroller);
}

function renderOutlinePanel(state) {
  const view = els.panelViews.outline;
  if (!view) return;
  const list = document.createElement('nav');
  list.className = 'outline-list';
  list.setAttribute('aria-label', 'Notebook outline');
  let count = 0;
  for (const item of dataflowState(state).outline) {
    if (item?.name) {
      list.appendChild(panelButton(item.name, item.id, null, 'outline-cell'));
      count += 1;
    }
    for (const heading of Array.isArray(item?.headings) ? item.headings : []) {
      const button = panelButton(heading.text || 'Untitled heading',
        heading.cell || item.id, Number(heading.line), 'outline-heading');
      button.style.setProperty('--outline-level',
        String(Math.max(0, Math.min(5, Number(heading.level || 1) - 1))));
      list.appendChild(button);
      count += 1;
    }
  }
  view.replaceChildren(count ? list : panelEmpty(
    'Name a cell or add a Markdown heading to build an outline.',
  ));
}

function renderMinimap(state) {
  if (!els.minimap) return;
  const cells = Array.isArray(state?.cells) ? state.cells : [];
  const fragment = document.createDocumentFragment();
  for (const cell of cells) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `minimap-cell status-${cell.status || 'idle'}`;
    button.dataset.targetCell = cell.id;
    button.title = `${cellLabel(cell.id, state)} — ${cell.status || 'idle'}`;
    button.setAttribute('aria-label', button.title);
    fragment.appendChild(button);
  }
  els.minimap.replaceChildren(fragment);
  updateMinimapViewport();
}

function updateMinimapViewport() {
  if (!els.minimap || isViewApp()) return;
  const middle = window.innerHeight / 2;
  let current = null;
  let distance = Infinity;
  for (const [id, element] of cellEls) {
    if (element.dataset.tombstone === 'true') continue;
    const rect = element.getBoundingClientRect();
    const delta = rect.top <= middle && rect.bottom >= middle
      ? 0 : Math.min(Math.abs(rect.top - middle), Math.abs(rect.bottom - middle));
    if (delta < distance) {
      distance = delta;
      current = id;
    }
  }
  els.minimap.querySelectorAll('.minimap-cell').forEach((button) => {
    const selected = button.dataset.targetCell === current;
    button.classList.toggle('in-viewport', selected);
    if (selected) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  });
}

function renderDataflow(state) {
  if (isViewApp() || !els.panel) return;
  const cells = Array.isArray(state?.cells) ? state.cells : [];
  if (!focusedCellId || !cells.some((cell) => cell.id === focusedCellId)) {
    focusedCellId = cells[0]?.id || null;
  }
  document.body.classList.toggle('panel-closed', !dataflowPanel.open);
  els.panel.hidden = !dataflowPanel.open;
  if (els.panelToggle) els.panelToggle.setAttribute(
    'aria-expanded', String(dataflowPanel.open),
  );
  for (const tab of els.panelTabs) {
    const active = tab.dataset.panelTab === dataflowPanel.tab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  Object.entries(els.panelViews).forEach(([name, view]) => {
    if (view) view.hidden = name !== dataflowPanel.tab;
  });
  renderVariablesPanel(state);
  renderDependenciesPanel(state);
  renderGraphPanel(state);
  renderOutlinePanel(state);
  renderMinimap(state);
}

function applyConfig(config) {
  const value = config && typeof config === 'object' ? config : {};
  const theme = ['light', 'dark', 'system'].includes(value.theme)
    ? value.theme : 'system';
  document.documentElement.dataset.theme = theme;
  const keymap = ['default', 'vim'].includes(value.keymap)
    ? value.keymap : 'default';
  document.documentElement.dataset.keymap = keymap;
  if (els.vimIndicator) {
    els.vimIndicator.hidden = keymap !== 'vim';
    els.vimIndicator.textContent = keymap === 'vim' ? 'Vim mode' : '';
  }
  const editor = value.editor && typeof value.editor === 'object' ? value.editor : {};
  const fontSize = Number.isFinite(Number(editor.font_size))
    ? Number(editor.font_size) : 14;
  const tabSize = Number.isFinite(Number(editor.tab_size))
    ? Number(editor.tab_size) : 2;
  document.documentElement.style.setProperty('--alder-editor-font-size', `${fontSize}px`);
  document.documentElement.style.setProperty('--alder-editor-tab-size', String(tabSize));
  document.body.classList.toggle('hide-line-numbers', editor.line_numbers === false);
  if (els.settings && !els.settings.open) fillSettings(value);
}

function fillSettings(config) {
  const value = config && typeof config === 'object' ? config : {};
  const editor = value.editor && typeof value.editor === 'object' ? value.editor : {};
  const format = value.format && typeof value.format === 'object' ? value.format : {};
  const table = value.table && typeof value.table === 'object' ? value.table : {};
  if (els.settingsTheme) {
    els.settingsTheme.value = ['light', 'dark', 'system'].includes(value.theme)
      ? value.theme : 'system';
  }
  if (els.settingsKeymap) {
    els.settingsKeymap.value = ['default', 'vim'].includes(value.keymap)
      ? value.keymap : 'default';
  }
  if (els.settingsFontSize) {
    els.settingsFontSize.value = Number.isFinite(Number(editor.font_size))
      ? Number(editor.font_size) : 14;
  }
  if (els.settingsTabSize) {
    els.settingsTabSize.value = Number.isFinite(Number(editor.tab_size))
      ? Number(editor.tab_size) : 2;
  }
  if (els.settingsTablePageSize) {
    els.settingsTablePageSize.value = Number.isFinite(Number(table.page_size))
      ? Number(table.page_size) : 25;
  }
  if (els.settingsLineNumbers) els.settingsLineNumbers.checked =
    editor.line_numbers !== false;
  if (els.settingsAutosave) els.settingsAutosave.checked =
    value.autosave === true;
  if (els.settingsFormatOnSave) els.settingsFormatOnSave.checked =
    format.on_save === true;
}

function settingsPatch() {
  const numberOr = (input, fallback) => {
    const value = Number(input?.value);
    return Number.isFinite(value) ? Math.round(value) : fallback;
  };
  return {
    theme: els.settingsTheme?.value || 'system',
    keymap: els.settingsKeymap?.value || 'default',
    autosave: Boolean(els.settingsAutosave?.checked),
    format: {on_save: Boolean(els.settingsFormatOnSave?.checked)},
    editor: {
      font_size: numberOr(els.settingsFontSize, 14),
      tab_size: numberOr(els.settingsTabSize, 2),
      line_numbers: Boolean(els.settingsLineNumbers?.checked),
    },
    table: {page_size: numberOr(els.settingsTablePageSize, 25)},
  };
}

function openSettings() {
  if (!els.settings) return;
  fillSettings(lastState?.config || renderingState?.config || {});
  if (typeof els.settings.showModal === 'function') {
    if (!els.settings.open) els.settings.showModal();
  } else {
    els.settings.setAttribute('open', '');
  }
}

function closeSettings() {
  if (!els.settings) return;
  if (typeof els.settings.close === 'function' && els.settings.open) {
    els.settings.close();
  } else {
    els.settings.removeAttribute('open');
  }
}

function settingsSubmit(event) {
  event.preventDefault();
  const patch = settingsPatch();
  action(async () => {
    await api('/api/config', {body: patch});
    closeSettings();
  });
}

function destroyEditor(id) {
  const editor = editorHandles.get(id);
  if (!editor) return;
  editor.destroy();
  editorHandles.delete(id);
}

function ensureEditor(id, element, record, protectedLocal) {
  const source = element?.querySelector('[data-role="source"]');
  if (!source || isViewApp() || record.desiredType === 'sql' ||
      !window.AlderEditor?.createEditor) {
    if (record.desiredType === 'sql') destroyEditor(id);
    return null;
  }
  const language = record.desiredType === 'markdown' ? 'markdown' : 'r';
  const keymapName = renderingState?.config?.keymap || lastState?.config?.keymap || 'default';
  let editor = editorHandles.get(id);
  if (editor && (editor._alderLanguage !== language ||
                 editor._alderKeymap !== keymapName)) {
    destroyEditor(id);
    editor = null;
  }
  if (!editor) {
    editor = window.AlderEditor.createEditor({
      parent: source,
      doc: bodyText(record.desiredBody),
      language,
      readOnly: false,
      keymap: keymapName,
      onChange: (text) => {
        const current = cellEls.get(id);
        if (!current || current.dataset.tombstone === 'true') return;
        const type = current.querySelector('[data-role="type"]')?.value || 'code';
        startEdit(id, splitBody(text), type);
      },
      onRun: (next) => action(async () => {
        await flushPendingEdits();
        await flushWidgetUpdates();
        if (next) {
          const order = cellOrder();
          const index = order.indexOf(id);
          focusAfterCell = index >= 0 ? order[index + 1] || null : null;
        }
        await api('/api/run', {body: {cell: id}});
      }),
      onRunAll: () => action(async () => {
        await flushPendingEdits();
        await flushWidgetUpdates();
        await api('/api/run', {body: {all: true}});
      }),
      onSave: () => els.save?.click(),
      onFormat: () => action(async () => {
        await flushPendingEdits();
        await api('/api/format', {body: {cell: id}});
      }),
      onJump: (kind, value) => {
        if (kind === 'move') {
          action(() => moveCell(id, value < 0 ? 'up' : 'down'));
        } else if (kind === 'reference') {
          jumpReactiveReference(id, editorHandles.get(id)?.view, value);
        }
      },
      onHover: (view, pos) => lspHover(id, view, pos),
    });
    editor._alderLanguage = language;
    editor._alderKeymap = keymapName;
    editorHandles.set(id, editor);
  }
  editor.setCompletionSource(language === 'r'
    ? (context) => lspCompletionSource(id, context) : null);
  editor.setReactiveRefs(reactiveReferenceRanges(id, editor.getDoc()));
  const state = renderingState || lastState;
  editor.setDiagnostics(editorDiagnostics(
    state?.cells?.find((cell) => cell.id === id) || {diagnostics: []},
    editor,
  ));
  if (!sourceFocused(id)) {
    const desired = bodyText(record.desiredBody);
    const server = bodyText(record.serverBody);
    if (record.conflict && editor.getDoc() === desired && editor.getDoc() !== server) {
      editor.setDoc(server, {silent: true});
    } else if (!protectedLocal && editor.getDoc() !== desired) {
      editor.setDoc(desired, {silent: true});
    }
  }
  return editor;
}

window.__alderSetCellSource = (id, text) => {
  const record = cellRecords.get(id);
  if (!record) return false;
  const type = record.desiredType || 'code';
  const editor = sourceEditor(id);
  if (editor) {
    editor.setDoc(String(text ?? ''));
  } else {
    startEdit(id, splitBody(String(text ?? '')), type);
  }
  return true;
};


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
        const sql = sqlSpecFromRecord(record);
        const request = type === 'sql'
          ? {
            op: 'sql', cell: id, expected_revision: expectedRevision,
            query: sql.query, conn: sql.conn || null, into: sql.into,
          }
          : { op: 'edit', id, expected_revision: expectedRevision, body, type };
        try {
          const response = await api('/api/cell', { body: request });
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
          record.serverSql = type === 'sql' ? { ...sql } : null;
          scheduleAutosave();
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
  record.desiredType = cellType(type);
  record.desiredSql = record.desiredType === 'sql'
    ? parseSqlBody(record.desiredBody) : null;
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

function startSqlEdit(id, spec) {
  const record = cellRecords.get(id);
  if (!record) return null;
  const sql = {
    query: String(spec?.query ?? ''),
    conn: spec?.conn ? String(spec.conn).trim() : null,
    into: String(spec?.into || 'result').trim() || 'result',
  };
  record.desiredSql = sql;
  record.desiredBody = sqlBody(sql);
  record.desiredType = 'sql';
  record.generation += 1;
  clearTimeout(record.timer);
  record.timer = null;
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

function clearAutosaveTimer() {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

function autosaveEnabled() {
  return lastState?.config?.autosave === true && !isViewApp();
}

function scheduleAutosave() {
  clearAutosaveTimer();
  if (!autosaveEnabled()) return;
  autosaveTimer = window.setTimeout(async () => {
    autosaveTimer = null;
    try {
      await flushPendingEdits();
      if (lastState?.config?.format?.on_save === true) {
        await api('/api/format', {body: {}});
      }
      await api('/api/save', {method: 'POST'});
    } catch (error) {
      showActionError(error.message);
    }
  }, 2000);
}

function widgetKey(name, kind, path = []) {
  return `${String(name)}\u0000${String(kind)}\u0000${path.join('\u0001')}`;
}

function widgetOpKey(name, path = []) {
  return `${String(name)}\u0001${path.join('\u0001')}`;
}

function widgetPath(control) {
  try {
    const value = control?.dataset?.path;
    return value ? JSON.parse(value) : [];
  } catch (_) {
    return [];
  }
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
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    const output = outputs.length ? outputs[outputs.length - 1] : null;
    if (!output || output.kind !== 'widget') continue;
    const visit = (spec, path) => {
      if (!spec || !spec.kind) return;
      const key = widgetKey(output.name, spec.kind, path);
      const operationKey = widgetOpKey(output.name, path);
      const operation = path.length
        ? output.operations?.[operationKey]
        : (output.operation || output.operations?.[operationKey]);
      const token = operation?.token ?? output.commit_token;
      const status = operation ? (
        operation.status === 'error' ? 'error' :
        operation.status === 'done' ? 'done' : null
      ) : (output.commit_token ? 'done' : null);
      const error = operation?.error?.message || operation?.error || null;
      seen.add(key);
      lastWidgetOps.set(key, {
        token: token || null, pendingValue: pendingMarker, source: widgetSource(),
        status, error,
      });
      if (token && status) {
        const waiters = widgetWaiters.get(key);
        if (waiters) {
          const remaining = [];
          for (const waiter of waiters) {
            if (status !== 'done' && status !== 'error') {
              remaining.push(waiter);
              continue;
            }
            const exact = waiter.token === token;
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
      }
      if (spec.kind === 'array' || spec.kind === 'dictionary') {
        for (const child of spec.children || []) {
          visit(child, [...path, String(child.name || '')]);
        }
      } else if (spec.kind === 'form') {
        visit(spec.child, path);
      }
    };
    visit(output.spec, []);
  }
  for (const key of [...lastWidgetOps.keys()]) {
    if (!seen.has(key) && !pendingWidgetOps.has(key)) lastWidgetOps.delete(key);
  }
}

function commitWidgetUpdate(name, path, kind, update, source, endpoint = '/api/widget') {
  const key = widgetKey(name, kind, path);
  let operation = pendingWidgetOps.get(key);
  if (operation) {
    operation.hasPending = true;
    operation.pendingUpdate = update;
    operation.source = widgetSource(source);
    operation.endpoint = endpoint;
    return operation.promise;
  }
  operation = {
    name, path: path.slice(), kind, source: widgetSource(source), endpoint,
    hasPending: true, pendingUpdate: update, token: null, promise: null,
  };
  operation.promise = (async () => {
    try {
      while (operation.hasPending) {
        operation.hasPending = false;
        const payload = {
          name, path: operation.path.slice(), ...operation.pendingUpdate,
        };
        if (operation.endpoint === '/api/widget') {
          payload.source = operation.source;
        }
        const response = await api(operation.endpoint, { body: payload });
        operation.token = response.token;
        lastWidgetOps.set(key, {
          token: response.token, pendingValue: pendingMarker,
          source: operation.source, status: null,
        });
        await waitForWidgetCompletion(key, response.token);
        scheduleAutosave();
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

function widgetDomId(widget, kind, path = []) {
  const suffix = path.length ? `-${safeDomPart(path.join('-'))}` : '';
  return `widget-${safeDomPart(widget.owner || 'cell')}-${safeDomPart(kind)}${suffix}`;
}

function widgetNodeKey(widget, kind, path = []) {
  return widgetKey(widget.name, kind, path);
}

function makeWidgetLabel(spec, control) {
  const labelText = spec.label == null ? '' : String(spec.label);
  if (!labelText) return null;
  const label = document.createElement('label');
  label.dataset.role = 'widget-label';
  label.textContent = labelText;
  if (control) label.htmlFor = control.id;
  return label;
}

function configureWidgetControl(control, widget, spec, kind, path) {
  control.dataset.role = 'widget';
  control.dataset.name = widget.name || '';
  control.dataset.kind = kind || '';
  control.dataset.owner = widget.owner || '';
  control.dataset.path = JSON.stringify(path);
  control.id = widgetDomId(widget, kind, path);
  return control;
}

function makeTableWidgetNode(node, widget, spec, kind, path) {
  const page = spec.page && typeof spec.page === 'object' ? spec.page : {};
  const rawColumns = Array.isArray(page.columns)
    ? page.columns : page.columns == null ? [] : [page.columns];
  const columns = rawColumns;
  const rows = Array.isArray(page.preview) ? page.preview : [];
  const selected = new Set((spec.selected || []).map(Number));
  const table = document.createElement('table');
  table.className = 'widget-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  if (kind === 'table') {
    const th = document.createElement('th');
    th.textContent = '';
    headRow.appendChild(th);
  }
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = String(column);
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    if (kind === 'table') {
      const td = document.createElement('td');
      const input = configureWidgetControl(
        document.createElement('input'), widget, spec, kind, path);
      input.type = 'checkbox';
      input.value = String(index + 1);
      input.checked = selected.has(index + 1);
      td.appendChild(input);
      tr.appendChild(td);
    }
    for (const value of (Array.isArray(row) ? row : [])) {
      const td = document.createElement('td');
      td.textContent = String(value ?? '');
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  table.appendChild(body);
  node.appendChild(table);
}

function createWidgetNode(widget, spec, path = []) {
  const kind = spec?.kind || '';
  const node = document.createElement('div');
  node.className = kind === 'array' || kind === 'dictionary' || kind === 'form'
    ? 'widget-group' : 'widget-container';
  node.dataset.widgetKey = widgetNodeKey(widget, kind, path);
  node.dataset.kind = kind;
  node.dataset.name = widget.name || '';
  node.dataset.owner = widget.owner || '';
  node.dataset.path = JSON.stringify(path);

  if (kind === 'array' || kind === 'dictionary') {
    const title = makeWidgetLabel(spec, null);
    if (title) node.appendChild(title);
    for (const child of spec.children || []) {
      node.appendChild(createWidgetNode(widget, child, [...path, String(child.name || '')]));
    }
    return node;
  }
  if (kind === 'form') {
    const title = makeWidgetLabel(spec, null);
    if (title) node.appendChild(title);
    node.appendChild(createWidgetNode(widget, spec.child || {}, path));
    const submit = configureWidgetControl(
      document.createElement('button'), widget, spec, kind, path);
    submit.type = 'button';
    submit.textContent = spec.submit_label || 'Submit';
    submit.dataset.formSubmit = 'true';
    node.appendChild(submit);
    return node;
  }
  if (kind === 'table' || kind === 'dataframe') {
    const title = makeWidgetLabel(spec, null);
    if (title) node.appendChild(title);
    makeTableWidgetNode(node, widget, spec, kind, path);
    return node;
  }

  let control;
  if (kind === 'dropdown' || kind === 'multiselect') {
    control = document.createElement('select');
    control.multiple = kind === 'multiselect';
    for (const [i, choice] of (spec.choices || []).entries()) {
      const option = document.createElement('option');
      option.value = String(i + 1);
      option.textContent = String(choice);
      control.appendChild(option);
    }
  } else if (kind === 'radio') {
    const fieldset = document.createElement('fieldset');
    const legend = makeWidgetLabel(spec, null);
    if (legend) fieldset.appendChild(legend);
    for (const [i, choice] of (spec.choices || []).entries()) {
      const label = document.createElement('label');
      const input = configureWidgetControl(
        document.createElement('input'), widget, spec, kind, path);
      input.type = 'radio';
      input.name = `${widget.name}-${path.join('-')}`;
      input.value = String(i + 1);
      label.append(input, document.createTextNode(String(choice)));
      fieldset.appendChild(label);
    }
    node.appendChild(fieldset);
    return node;
  } else if (kind === 'run_button' || kind === 'button' || kind === 'refresh') {
    control = document.createElement('button');
    control.type = 'button';
    control.textContent = spec.label || (kind === 'run_button' ? 'Run' : kind);
  } else if (kind === 'text_area' || kind === 'code_editor') {
    control = document.createElement('textarea');
    if (kind === 'text_area' && spec.rows) control.rows = Number(spec.rows);
  } else if (kind === 'range_slider') {
    control = document.createElement('div');
    const lower = configureWidgetControl(
      document.createElement('input'), widget, spec, kind, path);
    lower.type = 'range';
    lower.dataset.rangePart = '0';
    const upper = configureWidgetControl(
      document.createElement('input'), widget, spec, kind, path);
    upper.type = 'range';
    upper.dataset.rangePart = '1';
    control.append(lower, upper);
  } else if (kind === 'file') {
    control = document.createElement('input');
    control.type = 'file';
    control.multiple = Boolean(spec.multiple);
    if (spec.accept) control.accept = Array.isArray(spec.accept)
      ? spec.accept.join(',') : String(spec.accept);
  } else if (kind === 'date' || kind === 'datetime') {
    control = document.createElement('input');
    control.type = kind === 'date' ? 'date' : 'datetime-local';
  } else if (kind === 'date_range') {
    control = document.createElement('div');
    const start = configureWidgetControl(
      document.createElement('input'), widget, spec, kind, path);
    start.type = 'date';
    start.dataset.rangePart = '0';
    const end = configureWidgetControl(
      document.createElement('input'), widget, spec, kind, path);
    end.type = 'date';
    end.dataset.rangePart = '1';
    control.append(start, end);
  } else if (kind === 'checkbox' || kind === 'switch') {
    control = document.createElement('input');
    control.type = 'checkbox';
  } else {
    control = document.createElement('input');
    control.type = kind === 'slider' || kind === 'range_slider' ? 'range' :
      kind === 'number' ? 'number' : 'text';
  }
  if (control.nodeName === 'INPUT' || control.nodeName === 'SELECT' ||
      control.nodeName === 'TEXTAREA' || control.nodeName === 'BUTTON') {
    configureWidgetControl(control, widget, spec, kind, path);
  }
  const label = makeWidgetLabel(spec, control);
  if (label) node.appendChild(label);
  node.appendChild(control);
  if (kind === 'slider' || kind === 'number') {
    const value = document.createElement('span');
    value.className = 'widget-value';
    node.appendChild(value);
  }
  return node;
}
function widgetControls(node, kind, path) {
  const encodedPath = JSON.stringify(path);
  return [...node.querySelectorAll('[data-role="widget"]')].filter((entry) =>
    entry.dataset.kind === kind && JSON.stringify(widgetPath(entry)) === encodedPath);
}

function patchWidgetNode(node, widget, spec, path = []) {
  const kind = spec?.kind;
  if (!node || node.dataset.kind !== kind) return;
  const key = widgetNodeKey(widget, kind, path);
  const pending = pendingWidgetOps.has(key);
  const focused = node.contains(document.activeElement);
  const current = widgetDoneState(widget);
  const available = workerAvailable(renderingState || lastState);
  node.dataset.current = current ? 'true' : 'false';
  if (kind === 'array' || kind === 'dictionary') {
    const expected = new Set();
    for (const child of spec.children || []) {
      const childPath = [...path, String(child.name || '')];
      const childKey = widgetNodeKey(widget, child.kind, childPath);
      expected.add(childKey);
      let childNode = [...node.children].find((entry) =>
        entry.dataset?.widgetKey === childKey);
      if (!childNode) {
        childNode = createWidgetNode(widget, child, childPath);
        node.appendChild(childNode);
      }
      patchWidgetNode(childNode, widget, child, childPath);
    }
    for (const childNode of [...node.children]) {
      if (childNode.dataset?.widgetKey && !expected.has(childNode.dataset.widgetKey)) {
        childNode.remove();
      }
    }
    return;
  }
  if (kind === 'form') {
    const child = spec.child || {};
    const childKey = widgetNodeKey(widget, child.kind, path);
    let childNode = [...node.children].find((entry) =>
      entry.dataset?.widgetKey === childKey);
    const submit = node.querySelector('[data-form-submit="true"]');
    if (!childNode) {
      childNode = createWidgetNode(widget, child, path);
      if (submit) node.insertBefore(childNode, submit);
      else node.appendChild(childNode);
    }
    patchWidgetNode(childNode, widget, child, path);
    if (submit) {
      submit.disabled = !available || !current || !spec.dirty ||
        pendingWidgetOps.has(widgetKey(widget.name, kind, path));
      submit.textContent = spec.submit_label || 'Submit';
    }
    return;
  }
  if (kind === 'table' || kind === 'dataframe') {
    if (!focused && !pending) {
      const replacement = createWidgetNode(widget, spec, path);
      node.replaceChildren(...replacement.childNodes);
    }
    return;
  }
  const controls = widgetControls(node, kind, path);
  const control = controls[0];
  for (const candidate of controls) {
    candidate.disabled = !available || !current || pending;
    if (spec.value !== undefined && !Array.isArray(spec.value)) {
      candidate.dataset.value = String(spec.value);
    }
  }
  if (!control || focused || pending) return;
  if (kind === 'dropdown') {
    control.value = String(Number.isInteger(spec.index) ? spec.index : 1);
  } else if (kind === 'multiselect') {
    const indices = new Set((spec.indices || []).map(Number));
    [...control.options].forEach((option) => {
      option.selected = indices.has(Number(option.value));
    });
  } else if (kind === 'radio') {
    const index = Number.isInteger(spec.index) ? spec.index : 1;
    controls.forEach((entry) => { entry.checked = Number(entry.value) === index; });
  } else if (kind === 'checkbox' || kind === 'switch') {
    control.checked = Boolean(spec.value);
  } else if (kind === 'date_range' || kind === 'range_slider') {
    const value = Array.isArray(spec.value) ? spec.value : ['', ''];
    controls.forEach((entry, index) => {
      entry.value = String(value[index] ?? '');
      if (spec.min != null) entry.min = String(spec.min);
      if (spec.max != null) entry.max = String(spec.max);
      if (spec.step != null) entry.step = String(spec.step);
    });
  } else if (kind === 'file') {
    // Browsers do not allow restoring file input values.
  } else if (spec.value !== undefined) {
    control.value = Array.isArray(spec.value)
      ? String(spec.value[0] ?? '') : String(spec.value);
  }
  if (kind === 'slider' || kind === 'number') {
    if (spec.min != null) control.min = String(spec.min);
    if (spec.max != null) control.max = String(spec.max);
    if (spec.step != null) control.step = String(spec.step);
    const value = node.querySelector('.widget-value');
    if (value) value.textContent = String(spec.value ?? '');
  }
}

function createWidgetRow(widget) {
  return createWidgetNode(widget, widget.spec || {}, []);
}

function patchWidget(row, widget) {
  patchWidgetNode(row, widget, widget.spec || {}, []);
}

function renderWidgetOutput(container, widget) {
  const kind = widget.spec?.kind;
  const key = widgetNodeKey(widget, kind, []);
  let row = [...container.children].find((node) => node.dataset?.widgetKey === key);
  if (!row || row.dataset.kind !== kind) {
    container.replaceChildren();
    row = createWidgetRow(widget);
    container.appendChild(row);
  }
  // Freshly created controls are built without their spec attributes (min,
  // max, step, value, selection). Patch every row so a just-created slider is
  // fully configured for its widget spec instead of showing browser defaults.
  patchWidget(row, widget);
}

function appendText(container, className, text) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = String(text ?? '');
  container.appendChild(node);
  return node;
}
function renderOutputRecord(container, output) {
  if (!output) return;
  if (output.kind === 'widget') {
    renderWidgetOutput(container, output);
    return;
  }
  if (output.kind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'value-text';
    pre.textContent = String(output.text ?? '');
    container.appendChild(pre);
    if (output.truncated) appendText(container, 'truncation-note', 'Output truncated.');
    return;
  }
  if (output.kind === 'table') {
    const page = output.page && typeof output.page === 'object' ? output.page : null;
    const wrap = document.createElement('div');
    wrap.className = 'table-preview';
    const rawColumns = Array.isArray(page?.columns) ? page.columns
      : (Array.isArray(output.columns) ? output.columns
        : (page?.columns ?? output.columns));
    const columns = rawColumns == null
      ? [] : Array.isArray(rawColumns) ? rawColumns : [rawColumns];
    const rows = Array.isArray(page?.preview) ? page.preview
      : (Array.isArray(output.preview) ? output.preview : []);
    const offset = Number.isFinite(Number(page?.offset)) ? Number(page.offset) : 0;
    const configuredPageSize = Number((renderingState || lastState)?.config?.table?.page_size);
    const limit = Number.isFinite(configuredPageSize) && configuredPageSize >= 5
      ? configuredPageSize
      : (Number.isFinite(Number(page?.limit)) ? Number(page.limit)
        : Math.max(1, rows.length || 25));
    const totalRows = Number.isFinite(Number(page?.nrow)) ? Number(page.nrow)
      : Number(output.nrow || 0);
    const sortBy = String(page?.sort_by || '');
    const sortDesc = Boolean(page?.sort_desc);
    const filter = String(page?.filter || '');

    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((column) => {
      const th = document.createElement('th');
      const sort = document.createElement('button');
      sort.type = 'button';
      sort.className = 'table-sort';
      sort.dataset.role = 'table-sort';
      sort.dataset.column = String(column);
      const selected = sortBy === String(column);
      sort.textContent = `${String(column)}${selected
        ? (sortDesc ? ' (desc)' : ' (asc)') : ''}`;
      sort.addEventListener('click', async () => {
        sort.disabled = true;
        try {
          await api('/api/table', {
            body: {
              handle: output.handle,
              offset,
              limit,
              sort_by: String(column),
              sort_desc: selected ? !sortDesc : false,
              filter,
            },
          });
          await refresh();
        } catch (error) {
          sort.disabled = false;
          showActionError(error.message || 'Table sort failed');
        }
      });
      th.appendChild(sort);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    rows.forEach((row) => {
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

    const toolbar = document.createElement('div');
    toolbar.className = 'table-toolbar';
    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.className = 'table-filter';
    filterInput.dataset.role = 'table-filter';
    filterInput.placeholder = 'Filter text columns';
    filterInput.setAttribute('aria-label', 'Filter table');
    filterInput.value = filter;
    let filterTimer = null;
    filterInput.addEventListener('input', () => {
      if (filterTimer !== null) window.clearTimeout(filterTimer);
      filterTimer = window.setTimeout(async () => {
        filterInput.disabled = true;
        try {
          await api('/api/table', {
            body: {
              handle: output.handle,
              offset: 0,
              limit,
              sort_by: sortBy,
              sort_desc: sortDesc,
              filter: filterInput.value,
            },
          });
          await refresh();
        } catch (error) {
          filterInput.disabled = false;
          showActionError(error.message || 'Table filter failed');
        }
      }, 250);
    });
    toolbar.appendChild(filterInput);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'table-copy';
    copy.dataset.role = 'table-copy';
    copy.textContent = 'Copy TSV';
    copy.addEventListener('click', async () => {
      const text = [
        columns.map((column) => String(column ?? '')).join('\t'),
        ...rows.map((row) => columns.map((column, index) => {
          const value = Array.isArray(row) ? row[index] : row?.[column];
          return String(value ?? '');
        }).join('\t')),
      ].join('\n');
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        copy.textContent = 'Copied';
        window.setTimeout(() => { copy.textContent = 'Copy TSV'; }, 1000);
      } catch (error) {
        showActionError(error.message || 'Could not copy table');
      }
    });
    toolbar.appendChild(copy);
    container.appendChild(toolbar);

    const pager = document.createElement('div');
    pager.className = 'table-pager';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = 'Prev';
    prev.disabled = offset <= 0;
    prev.addEventListener('click', async () => {
      prev.disabled = true;
      try {
        await api('/api/table', {
          body: {
            handle: output.handle,
            offset: Math.max(0, offset - limit),
            limit,
            sort_by: sortBy,
            sort_desc: sortDesc,
            filter,
          },
        });
        await refresh();
      } catch (error) {
        prev.disabled = false;
        showActionError(error.message || 'Table page failed');
      }
    });
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = 'Next';
    next.disabled = offset + rows.length >= totalRows;
    next.addEventListener('click', async () => {
      next.disabled = true;
      try {
        await api('/api/table', {
          body: {
            handle: output.handle,
            offset: offset + limit,
            limit,
            sort_by: sortBy,
            sort_desc: sortDesc,
            filter,
          },
        });
        await refresh();
      } catch (error) {
        next.disabled = false;
        showActionError(error.message || 'Table page failed');
      }
    });
    pager.appendChild(prev);
    const first = totalRows === 0 ? 0 : offset + 1;
    const last = Math.min(totalRows, offset + rows.length);
    appendText(pager, 'table-page-label',
      `${first}..${last} of ${totalRows}`);
    pager.appendChild(next);
    container.appendChild(pager);

    const meta = document.createElement('div');
    meta.className = 'table-meta';
    meta.textContent = `${output.nrow ?? totalRows} rows × ${output.ncol ?? columns.length} columns`;
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
  if (output.kind === 'media') {
    const mediaType = String(output.media_type || 'image');
    const src = `/plot/${encodeURIComponent(String(output.artifact || ''))}`;
    let node;
    if (mediaType === 'audio') {
      node = document.createElement('audio');
      node.controls = true;
    } else if (mediaType === 'video') {
      node = document.createElement('video');
      node.controls = true;
    } else if (mediaType === 'pdf') {
      node = document.createElement('iframe');
      node.title = output.alt || 'PDF';
      node.className = 'media-pdf';
    } else {
      node = document.createElement('img');
      node.alt = output.alt || '';
    }
    node.classList.add('out-media');
    node.src = src;
    container.appendChild(node);
    return;
  }
  if (output.kind === 'layout') {
    const layout = String(output.layout || 'vstack');
    const wrap = document.createElement('div');
    wrap.className = `out-layout out-${layout}`;
    if (layout === 'callout') {
      wrap.classList.add(`out-callout-${String(output.attrs?.variant || 'info')}`);
    }
    const children = Array.isArray(output.children) ? output.children : [];
    const renderChild = (child, index) => {
      const slot = document.createElement('div');
      slot.className = 'out-layout-child';
      slot.dataset.index = String(index);
      renderOutputRecord(slot, child);
      wrap.appendChild(slot);
      return slot;
    };
    if (layout === 'tabs' || layout === 'accordion') {
      const titles = Array.isArray(output.attrs?.titles) ? output.attrs.titles : [];
      const controls = document.createElement('div');
      controls.className = layout === 'tabs' ? 'out-tabs' : 'out-accordion';
      const slots = children.map(renderChild);
      slots.forEach((slot, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = layout === 'tabs' ? 'out-tab-btn' : 'out-accordion-btn';
        button.textContent = String(titles[index] || `Item ${index + 1}`);
        button.setAttribute('aria-controls', `${layout}-${index}`);
        button.addEventListener('click', () => {
          slots.forEach((other, otherIndex) => {
            other.hidden = layout === 'tabs'
              ? otherIndex !== index : (otherIndex !== index || !other.hidden);
          });
        });
        controls.appendChild(button);
      });
      wrap.prepend(controls);
      slots.forEach((slot, index) => {
        slot.id = `${layout}-${index}`;
        slot.hidden = layout === 'tabs' ? index !== 0 : true;
      });
    } else {
      children.forEach(renderChild);
    }
    container.appendChild(wrap);
    return;
  }
  if (output.kind === 'lazy') {
    if (output.child) {
      renderOutputRecord(container, output.child);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'out-lazy';
    button.textContent = String(output.label || 'Show');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api('/api/lazy', {
          method: 'POST',
          body: { key: output.key },
        });
        await refresh();
      } catch (error) {
        button.disabled = false;
        appendText(container, 'output-error', error.message || 'Lazy output failed');
      }
    });
    container.appendChild(button);
    return;
  }
  if (output.kind === 'progress') {
    const row = document.createElement('div');
    row.className = 'progress-row';
    const progress = document.createElement('progress');
    if (Number.isFinite(output.total)) progress.max = output.total;
    progress.value = Number(output.value || 0);
    row.appendChild(progress);
    appendText(row, 'progress-label', output.label || '');
    container.appendChild(row);
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

function renderOutputs(container, outputs, progress = null) {
  container.replaceChildren();
  container.classList.add('out-stack');
  const values = Array.isArray(outputs) ? outputs : [];
  values.forEach((output, index) => {
    const slot = document.createElement('div');
    slot.className = 'out-record';
    slot.dataset.index = String(index);
    renderOutputRecord(slot, output);
    container.appendChild(slot);
  });
  if (progress) {
    const slot = document.createElement('div');
    slot.className = 'out-record out-progress';
    renderOutputRecord(slot, progress);
    container.appendChild(slot);
  }
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
  const sourceFocusedCell = sourceFocused(id);
  const typeSelect = cellEls.get(id)?.querySelector('[data-role="type"]');
  const sqlControl = cellEls.get(id)?.querySelector(
    '[data-role="sql-query"], [data-role="sql-conn"], [data-role="sql-into"]',
  );
  return Boolean(record.ackGeneration < record.generation || record.drainPromise ||
    record.error || sourceFocusedCell ||
    document.activeElement === typeSelect ||
    (sqlControl && sqlControl.contains(document.activeElement)));
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

function renderSqlEditor(area, record, protectedLocal) {
  if (!area) return;
  const source = area.querySelector('[data-role="source"]');
  const isSql = record.desiredType === 'sql';
  let panel = area.querySelector('[data-role="sql-editor"]');
  if (!isSql) {
    panel?.remove();
    if (source) source.hidden = false;
    return;
  }
  if (source) source.hidden = true;
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'sql-editor';
    panel.dataset.role = 'sql-editor';
    const query = document.createElement('textarea');
    query.dataset.role = 'sql-query';
    query.spellcheck = false;
    query.rows = 6;
    query.setAttribute('aria-label', 'SQL query');
    const fields = document.createElement('div');
    fields.className = 'sql-fields';
    const connLabel = document.createElement('label');
    connLabel.textContent = 'Connection';
    const conn = document.createElement('input');
    conn.dataset.role = 'sql-conn';
    conn.type = 'text';
    conn.placeholder = 'optional connection name';
    conn.setAttribute('aria-label', 'SQL connection');
    connLabel.appendChild(conn);
    const intoLabel = document.createElement('label');
    intoLabel.textContent = 'Result name';
    const into = document.createElement('input');
    into.dataset.role = 'sql-into';
    into.type = 'text';
    into.setAttribute('aria-label', 'SQL result name');
    intoLabel.appendChild(into);
    fields.append(connLabel, intoLabel);
    panel.append(query, fields);
    area.appendChild(panel);
  }
  const spec = sqlSpecFromRecord(record);
  const query = panel.querySelector('[data-role="sql-query"]');
  const conn = panel.querySelector('[data-role="sql-conn"]');
  const into = panel.querySelector('[data-role="sql-into"]');
  if (!protectedLocal || document.activeElement !== query) query.value = spec.query;
  if (!protectedLocal || document.activeElement !== conn) conn.value = spec.conn || '';
  if (!protectedLocal || document.activeElement !== into) into.value = spec.into;
}

function updateCell(el, cell) {
  const record = ensureCellRecord(cell);
  el.dataset.id = cell.id;
  el.dataset.cellName = cell.name || '';
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
  const visibleType = protectedLocal ? record.desiredType : cellType(cell.type);
  const source = el.querySelector('[data-role="source"]');
  if (typeSelect) typeSelect.id = `${el.id}-type`;
  if (source) source.id = `${el.id}-source`;
  const editor = ensureEditor(cell.id, el, record, protectedLocal);
  if (typeSelect && !protectedLocal && document.activeElement !== typeSelect) {
    typeSelect.value = cellType(cell.type);
  }
  if (!editor && source && !protectedLocal && !sourceFocused(cell.id)) {
    source.textContent = bodyText(record.desiredBody);
  }
  const sourceArea = el.querySelector('[data-role="source-area"]');
  if (sourceArea) {
    sourceArea.classList.toggle('md-area', visibleType === 'markdown');
    sourceArea.classList.toggle('sql-area', visibleType === 'sql');
    sourceArea.classList.toggle('code-area', visibleType === 'code');
    renderSqlEditor(sourceArea, record, protectedLocal);
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

  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const progress = cell.progress && typeof cell.progress === 'object'
    ? { kind: 'progress', ...cell.progress }
    : null;
  let outputArea = el.querySelector('[data-role="output"]');
  if (outputs.length || progress || !isViewApp()) {
    if (!outputArea) {
      outputArea = document.createElement('div');
      outputArea.className = 'output-area';
      outputArea.dataset.role = 'output';
      const diagnosticsNode = el.querySelector('[data-role="diagnostics"]');
      const logNode = el.querySelector('[data-role="log"]');
      const anchor = diagnosticsNode ? diagnosticsNode.nextSibling : logNode;
      el.insertBefore(outputArea, anchor || null);
    }
    renderOutputs(outputArea, outputs, progress);
    outputArea.hidden = !outputs.length && !progress && !isViewApp();
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
    const disable = document.createElement('button');
    disable.className = 'btn mini';
    disable.type = 'button';
    disable.dataset.act = 'disable';
    const up = document.createElement('button');
    up.className = 'btn mini';
    up.type = 'button';
    up.dataset.act = 'move-up';
    up.textContent = 'Up';
    const down = document.createElement('button');
    down.className = 'btn mini';
    down.type = 'button';
    down.dataset.act = 'move-down';
    down.textContent = 'Down';
    const del = document.createElement('button');
    del.className = 'btn mini';
    del.type = 'button';
    del.dataset.act = 'delete';
    del.textContent = 'Delete';
    actions.append(run, disable, up, down, del);
  }
  const disable = actions?.querySelector('[data-act="disable"]');
  if (disable) {
    const isDisabled = Boolean(cell.disabled);
    disable.dataset.disabled = String(isDisabled);
    disable.textContent = isDisabled ? 'Enable' : 'Disable';
    disable.title = isDisabled ? 'Enable this cell' : 'Disable this cell';
  }
  const order = Array.from(cellRecords.keys());
  const position = order.indexOf(cell.id);
  const moveUp = actions?.querySelector('[data-act="move-up"]');
  const moveDown = actions?.querySelector('[data-act="move-down"]');
  if (moveUp) moveUp.disabled = position <= 0;
  if (moveDown) moveDown.disabled = position < 0 || position >= order.length - 1;
  renderEditRecovery(el, record);
  const actionButtons = el.querySelectorAll('[data-act]');
  actionButtons.forEach((button) => {
    const act = button.dataset.act;
    if (act === 'run') {
      button.disabled = actionInFlight || !workerAvailable(renderingState || lastState) ||
        Boolean(renderingState?.runtime?.busy || lastState?.runtime?.busy);
    } else if (act === 'move-up' || act === 'move-down') {
      button.disabled = actionInFlight || button.disabled;
    } else {
      button.disabled = actionInFlight;
    }
  });
  if (focusAfterCell === cell.id && source && !isViewApp()) {
    focusAfterCell = null;
    window.setTimeout(() => focusSource(cell.id), 0);
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
  const editor = sourceEditor(id);
  if (editor && !sourceFocused(id)) editor.setDoc(bodyText(record.desiredBody), {silent: true});
  if (!editor && source && !sourceFocused(id)) {
    source.textContent = bodyText(record.desiredBody);
  }
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
  button.textContent = type === 'markdown' ? '+ Add Markdown'
    : type === 'sql' ? '+ Add SQL' : '+ Add code';
  return button;
}
function ensureEmptyBar() {
  if (!emptyBar) {
    if (els.emptyTpl) {
      emptyBar = els.emptyTpl.content.cloneNode(true).firstElementChild;
    } else {
      emptyBar = document.createElement('div');
      emptyBar.className = 'empty-bar';
      emptyBar.append(createAddButton('code', null),
        createAddButton('markdown', null), createAddButton('sql', null));
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
      destroyEditor(id);
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
  applyConfig(st.config);
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
          createAddButton('markdown', cell.id), createAddButton('sql', cell.id));
    }
  }
  }
  reconcileCellOrder(cells);
  renderDataflow(st);
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
  const body = type === 'markdown' ? ['# ']
    : type === 'sql' ? sqlBody({ query: 'SELECT 1', into: 'result' }) : [];
  const response = await api('/api/cell', {
    body: { op: 'add', after: after ?? null, body, type },
  });
  focusAfterCell = response.id || null;
  scheduleAutosave();
}

async function deleteCell(id) {
  await flushPendingEdits();
  const record = cellRecords.get(id);
  if (!record) throw editError(`no such cell: ${id}`, 'not_found');
  await api('/api/cell', {
    body: { op: 'delete', id, expected_revision: record.ackServerRevision },
  });
  scheduleAutosave();
}

async function moveCell(id, direction) {
  const order = Array.from(cellRecords.keys());
  const index = order.indexOf(id);
  if (index < 0) return;
  let after;
  if (direction === 'up') {
    if (index === 0) return;
    after = index === 1 ? null : order[index - 2];
  } else {
    if (index >= order.length - 1) return;
    after = order[index + 1];
  }
  await flushPendingEdits();
  await api('/api/cell', {
    body: { op: 'move', cell: id, after },
  });
  scheduleAutosave();
}

function localSourceFor(id) {
  return splitBody(sourceText(id));
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
  } else if (act === 'move-up') {
    await moveCell(id, 'up');
  } else if (act === 'move-down') {
    await moveCell(id, 'down');
  } else if (act === 'disable') {
    await flushPendingEdits();
    await api('/api/cell', {
      body: {
        op: 'disable',
        cell: id,
        disabled: button.dataset.disabled !== 'true',
      },
    });
    scheduleAutosave();
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
  record.desiredSql = record.serverSql ? { ...record.serverSql } : null;
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

function encodeFileUpload(file) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return { name: file.name, content_base64: btoa(binary) };
  });
}

async function uploadWidgetFiles(name, path, kind, files, source) {
  if (!files.length) return;
  try {
    const rows = await Promise.all(files.map(encodeFileUpload));
    await commitWidgetUpdate(name, path, kind, { files: rows }, source, '/api/upload');
  } catch (error) {
    showActionError(error.message);
  }
}

function handleWidgetEvent(control, eventType) {
  const kind = control.dataset.kind;
  const name = control.dataset.name;
  const path = widgetPath(control);
  if (!kind || !name) return;
  const source = widgetSource();
  const send = (update) => commitWidgetUpdate(name, path, kind, update, source)
    .catch(() => {});
  if (eventType === 'click' && kind === 'run_button') {
    control.disabled = true;
    send({ value: true });
    return;
  }
  if (eventType === 'click' && kind === 'form' &&
      control.dataset.formSubmit === 'true') {
    control.disabled = true;
    send({ submit: true });
    return;
  }
  if (eventType === 'click' && (kind === 'button' || kind === 'refresh')) {
    const current = Number(control.dataset.value || 0);
    const update = { value: Number.isFinite(current) ? Math.floor(current) + 1 : 1 };
    if (kind === 'refresh') update.paused = false;
    send(update);
    return;
  }
  if (kind === 'table' && eventType === 'change') {
    const row = control.closest('.widget-container, .widget-group');
    const selected = [...(row?.querySelectorAll('[data-role="widget"][data-kind="table"]') || [])]
      .filter((entry) => entry.checked)
      .map((entry) => Number(entry.value))
      .filter((value) => Number.isInteger(value) && value > 0);
    send({ selected });
    return;
  }
  if (eventType === 'input' && (kind === 'slider' || kind === 'number')) {
    const value = Number(control.value);
    const valueLabel = control.closest('.widget-container')?.querySelector('.widget-value');
    if (valueLabel) valueLabel.textContent = String(value);
    if (Number.isFinite(value)) send({ value });
    return;
  }
  if (eventType === 'input' && kind === 'range_slider') {
    const controls = [...control.closest('.widget-container')?.querySelectorAll(
      '[data-role="widget"][data-kind="range_slider"]') || []];
    const value = controls.map((entry) => Number(entry.value));
    if (value.length === 2 && value.every(Number.isFinite)) send({ value });
    return;
  }
  if (eventType !== 'change' && !(eventType === 'input' &&
      ['text_input', 'text_area', 'code_editor'].includes(kind))) return;
  if (kind === 'dropdown' || kind === 'radio') {
    const index = Number(control.value);
    if (Number.isInteger(index) && index > 0) send({ index });
  } else if (kind === 'multiselect') {
    const indexes = [...control.selectedOptions]
      .map((option) => Number(option.value))
      .filter((index) => Number.isInteger(index) && index > 0);
    send({ indices: indexes });
  } else if (kind === 'checkbox' || kind === 'switch') {
    send({ value: Boolean(control.checked) });
  } else if (kind === 'text_input' || kind === 'text_area' ||
      kind === 'code_editor') {
    send({ value: control.value });
  } else if (kind === 'date' || kind === 'datetime') {
    send({ value: control.value });
  } else if (kind === 'date_range') {
    const controls = [...control.closest('.widget-container')?.querySelectorAll(
      '[data-role="widget"][data-kind="date_range"]') || []];
    send({ value: controls.map((entry) => entry.value) });
  } else if (kind === 'file') {
    const files = [...(control.files || [])];
    control.disabled = true;
    void uploadWidgetFiles(name, path, kind, files, source);
  }
}

function sqlSpecFromElement(element) {
  const record = cellRecords.get(element?.dataset.id);
  const fallback = sqlSpecFromRecord(record);
  return {
    query: element?.querySelector('[data-role="sql-query"]')?.value ?? fallback.query,
    conn: element?.querySelector('[data-role="sql-conn"]')?.value ?? fallback.conn,
    into: element?.querySelector('[data-role="sql-into"]')?.value ?? fallback.into,
  };
}

els.notebook.addEventListener('input', (event) => {
  const sqlControl = event.target.closest(
    '[data-role="sql-query"], [data-role="sql-conn"], [data-role="sql-into"]',
  );
  if (sqlControl) {
    const element = sqlControl.closest('.cell');
    if (element) startSqlEdit(element.dataset.id, sqlSpecFromElement(element));
    return;
  }
  const source = event.target.closest('[data-role="source"]');
  if (source) {
    // CodeMirror sends changes through its update listener. Its content
    // DOM also emits an input event, which must not create a second edit.
    if (source.classList.contains('cm-host')) return;
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
    if (element) {
      const id = element.dataset.id;
      if (type.value === 'sql') {
        const record = cellRecords.get(id);
        const parsed = parseSqlBody(record?.desiredBody || []);
        startSqlEdit(id, parsed || {
          query: bodyText(record?.desiredBody || []),
          conn: null,
          into: 'result',
        });
      } else {
        startEdit(id, localSourceFor(id), type.value);
      }
    }
    return;
  }
  const control = event.target.closest('[data-role="widget"]');
  if (control) handleWidgetEvent(control, 'change');
});
els.notebook.addEventListener('focusin', (event) => {
  const element = event.target.closest('.cell');
  if (!element || element.dataset.tombstone === 'true') return;
  if (focusedCellId !== element.dataset.id) {
    focusedCellId = element.dataset.id;
    renderDependenciesPanel(lastState);
    updateMinimapViewport();
  }
});


els.notebook.addEventListener('click', (event) => {
  const focused = event.target.closest('.cell');
  if (focused && focused.dataset.tombstone !== 'true' &&
      focusedCellId !== focused.dataset.id) {
    focusedCellId = focused.dataset.id;
    renderDependenciesPanel(lastState);
    updateMinimapViewport();
  }
  const control = event.target.closest('[data-role="widget"]');
  if (control && ['run_button', 'button', 'refresh', 'form'].includes(control.dataset.kind)) {
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

if (els.panelToggle) els.panelToggle.addEventListener('click', () => {
  dataflowPanel.open = !dataflowPanel.open;
  savePanelPreference();
  renderDataflow(lastState);
});

if (els.panelClose) els.panelClose.addEventListener('click', () => {
  dataflowPanel.open = false;
  savePanelPreference();
  renderDataflow(lastState);
  els.panelToggle?.focus();
});

if (els.panel) {
  els.panel.addEventListener('input', (event) => {
    if (!event.target.matches('.panel-filter')) return;
    variableFilter = event.target.value;
    renderVariablesPanel(lastState);
  });
  els.panel.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-panel-tab]');
    if (tab) {
      dataflowPanel.tab = tab.dataset.panelTab;
      dataflowPanel.open = true;
      savePanelPreference();
      renderDataflow(lastState);
      els.panelTabs.find((item) => item.dataset.panelTab === dataflowPanel.tab)?.focus();
      return;
    }
    const orientation = event.target.closest('[data-graph-orientation]');
    if (orientation) {
      graphOrientation = graphOrientation === 'vertical' ? 'horizontal' : 'vertical';
      renderGraphPanel(lastState);
      return;
    }
    const target = event.target.closest('[data-target-cell]');
    if (target) {
      navigateToCell(target.dataset.targetCell,
        target.dataset.targetLine === undefined ? null
          : Number(target.dataset.targetLine),
        {focus: true});
    }
  });
  els.panel.addEventListener('keydown', (event) => {
    const tab = event.target.closest('[data-panel-tab]');
    if (tab && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index = els.panelTabs.indexOf(tab);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = els.panelTabs[(index + direction + els.panelTabs.length) %
        els.panelTabs.length];
      next?.click();
      return;
    }
    const node = event.target.closest('.dag-node[data-target-cell]');
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      navigateToCell(node.dataset.targetCell, null, {focus: true});
    }
  });
}

if (els.minimap) els.minimap.addEventListener('click', (event) => {
  const target = event.target.closest('[data-target-cell]');
  if (target) navigateToCell(target.dataset.targetCell, null, {focus: true});
});

let minimapFrame = null;
window.addEventListener('scroll', () => {
  if (minimapFrame !== null) return;
  minimapFrame = window.requestAnimationFrame(() => {
    minimapFrame = null;
    updateMinimapViewport();
  });
}, {passive: true});

function installExportMenu() {
  if (isViewApp()) return;
  const topbar = document.getElementById('topbar');
  if (!topbar || topbar.querySelector('[data-export-menu]')) return;

  const wrap = document.createElement('div');
  wrap.className = 'editor-only export-menu';
  wrap.dataset.exportMenu = 'true';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn';
  toggle.textContent = 'Export';
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.className = 'export-menu-panel';
  panel.hidden = true;
  const includeLabel = document.createElement('label');
  includeLabel.className = 'export-include-code';
  const include = document.createElement('input');
  include.type = 'checkbox';
  includeLabel.append(include, document.createTextNode(' Include code'));
  panel.appendChild(includeLabel);
  const formats = [
    ['html', 'HTML'], ['md', 'Markdown'], ['script', 'R script'],
    ['ipynb', 'IPYNB'], ['qmd', 'Quarto'], ['session', 'Session JSON'],
  ];
  const download = (href) => {
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    link.download = '';
    link.target = '_blank';
    link.rel = 'noopener';
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const runExport = (format) => action(async () => {
    await flushPendingEdits();
    await flushWidgetUpdates();
    const result = await api('/api/export', {
      body: { format, include_code: include.checked },
    });
    download(result.download);
  });
  formats.forEach(([format, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn mini';
    button.textContent = label;
    button.dataset.exportFormat = format;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      runExport(format);
    });
    panel.appendChild(button);
  });
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'btn mini';
  check.textContent = 'Check notebook';
  check.addEventListener('click', (event) => {
    event.preventDefault();
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    action(async () => {
      await flushPendingEdits();
      const result = await api('/api/check', { body: {} });
      const diagnostics = Array.isArray(result.diagnostics)
        ? result.diagnostics : [];
      const errors = diagnostics.filter((item) => item?.level === 'error').length;
      if (errors) {
        throw new ApiError(
          `${errors} error diagnostic${errors === 1 ? '' : 's'}`,
          'check_failed', 200);
      }
    });
  });
  panel.appendChild(check);
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  wrap.append(toggle, panel);
  const anchor = els.appMode || els.editMode;
  if (anchor && anchor.parentNode === topbar) topbar.insertBefore(wrap, anchor);
  else topbar.appendChild(wrap);
}

installExportMenu();

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
  clearAutosaveTimer();
  event.preventDefault();
  action(async () => {
    await flushPendingEdits();
    if (lastState?.config?.format?.on_save === true) {
      await api('/api/format', {body: {}});
    }
    await api('/api/save', {method: 'POST'});
  });
});

if (els.settingsOpen) els.settingsOpen.addEventListener('click', (event) => {
  event.preventDefault();
  openSettings();
});
if (els.settingsClose) els.settingsClose.addEventListener('click', (event) => {
  event.preventDefault();
  closeSettings();
});
if (els.settingsCancel) els.settingsCancel.addEventListener('click', (event) => {
  event.preventDefault();
  closeSettings();
});
if (els.settingsForm) els.settingsForm.addEventListener('submit', settingsSubmit);
if (els.settings) els.settings.addEventListener('click', (event) => {
  if (event.target === els.settings) closeSettings();
});

if (els.runtime) els.runtime.addEventListener('change', () => {
  const mode = els.runtime.value === 'lazy' ? 'lazy' : 'automatic';
  action(async () => {
    await api('/api/runtime', { body: { execution_mode: mode } });
    scheduleAutosave();
  });
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
