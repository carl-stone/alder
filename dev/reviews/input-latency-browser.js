// Installed before app.js by CDP. Observes real requests and trusted input;
// never sends state polls or invokes Alder's edit/run functions itself.
(() => {
  const now = () => performance.now();
  const bench = window.__alderLatency = {
    states: new Map(), stateRequests: new Map(), renderedVersion: null, renderStarted: null,
    active: null, last: null, requests: [],
    arm(spec) {
      if (this.active && !this.active.finished) throw new Error('sample still active');
      const previous = this.states.get(this.renderedVersion);
      if (!previous) throw new Error('no acknowledged rendered state');
      this.active = {
        ...spec, previousVersion: previous.version, started: null, runInput: null,
        inputs: [], requests: [], edits: [], run: null, created: null,
        candidate: null, finished: false, failure: null,
      };
      return true;
    },
    fail(message) {
      if (this.active && !this.active.finished) {
        this.active.failure = message;
        this.active.finished = true;
      }
    },
    // Also exercised by deterministic negative controls.
    eligible(sample, state) {
      if (!sample || sample.started === null || !state ||
          state.version <= sample.previousVersion) return false;
      if (sample.kind === 'create') {
        return Boolean(sample.created && state.cells.some(c => c.id === sample.created.id));
      }
      if (!sample.run || state.runtime.busy || state.last_action_error) return false;
      // Ignore a response requested before the accepted run, even if some
      // unrelated update advanced its version and its old output looks right.
      if (sample.runResponseMs !== undefined &&
          (this.stateRequests.get(state.version) ?? -Infinity) < sample.runResponseMs) return false;
      if (sample.kind === 'edit-run' && !sample.edits.some(e =>
          e.id === sample.sourceCell && e.body === sample.source)) return false;
      const source = state.cells.find(c => c.id === sample.sourceCell);
      if (!source || source.body.join('\n') !== sample.source) return false;
      const edit = sample.edits.findLast(e => e.id === sample.sourceCell);
      if (edit && source.revision !== edit.revision) return false;
      return sample.cells.every(id => {
        const c = state.cells.find(c => c.id === id);
        return c && c.status === 'done' && !c.error;
      }) && state.cells.find(c => c.id === sample.resultCell)?.outputs
        .some(o => o.kind === 'text' && o.text.trim() === sample.expected);
    },
    visible(sample) {
      if (document.visibilityState !== 'visible') return false;
      const id = sample.kind === 'create' ? sample.created?.id : sample.resultCell;
      const cell = document.getElementById(`cell-${id}`);
      if (!cell) return false;
      const target = sample.kind === 'create'
        ? cell.querySelector('.cm-content') : cell.querySelector('[data-role="output"]');
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 ||
          rect.top >= innerHeight || style.visibility === 'hidden' || style.display === 'none') return false;
      if (sample.kind === 'create') return cell.contains(document.activeElement);
      return cell.classList.contains('done') &&
        target.innerText.trim() === sample.expected &&
        !target.classList.contains('retained-output');
    },
    consider() {
      const s = this.active;
      const state = this.states.get(this.renderedVersion);
      if (!s || s.finished || s.candidate || !this.eligible(s, state) || !this.visible(s)) return;
      const candidate = s.candidate = {
        version: state.version, dom_ms: now(), render_ms: this.lastRenderMs,
      };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (s !== this.active || s.finished) return;
        const current = this.states.get(this.renderedVersion);
        if (!this.eligible(s, current) || !this.visible(s)) {
          s.candidate = null;
          return;
        }
        const ended = now();
        s.finished = true;
        s.result = {
          label: s.label, kind: s.kind, input_ms: s.started, run_input_ms: s.runInput,
          input_clock: 'event.timeStamp',
          dom_ms: candidate.dom_ms, presentation_ms: ended,
          input_to_result_ms: ended - s.started,
          run_to_result_ms: s.runInput === null ? null : ended - s.runInput,
          pending_edit_at_run: s.pendingEditAtRun ?? null,
          render_ms: candidate.render_ms, presentation_wait_ms: ended - candidate.dom_ms,
          state_version: current.version, run_id: s.run?.run_id ?? null,
          created_id: s.created?.id ?? null, expected: s.expected ?? null,
          inputs: s.inputs, edits: s.edits,
          requests: s.requests.filter(r => r.body_ms !== undefined).map(r => ({...r})),
          pending_requests: s.requests.filter(r => r.body_ms === undefined).map(r => ({...r})),
          endpoint: 'current visible DOM after two animation frames (paint opportunity proxy)',
        };
        this.last = s.result;
      }));
    },
  };
  const inputTiming = event => {
    const handled = now();
    const at = event.timeStamp;
    // Event creation and performance.now() share this document's time origin.
    // Keep queued input time; tolerate at most 1 ms of timer precision rounding.
    if (!Number.isFinite(at) || at < 0 || at > handled + 1) {
      bench.fail('unsupported input event clock origin');
      return null;
    }
    return {at_ms: at, handled_ms: handled};
  };
  document.addEventListener('keydown', event => {
    const s = bench.active;
    if (!s || s.finished) return;
    if (!event.isTrusted) return;
    const run = event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.shiftKey);
    const editing = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    if (!run && !(s.kind === 'edit-run' && editing)) return;
    const timing = inputTiming(event);
    if (!timing) return;
    const at = timing.at_ms;
    s.inputs.push({type: 'keydown', key: event.key, trusted: true, ...timing});
    if (s.started === null) s.started = at;
    if (run) {
      s.runInput = at;
      if (s.kind === 'edit-run') {
        s.pendingEditAtRun = s.edits.length === 0;
        if (!s.pendingEditAtRun) bench.fail('edit was already acknowledged before Run');
      }
    }
  }, true);
  document.addEventListener('click', event => {
    const s = bench.active;
    if (!s || s.finished || !event.isTrusted || s.kind !== 'create') return;
    if (!event.target.closest('[data-act="add"][data-type="code"]')) return;
    const timing = inputTiming(event);
    if (!timing) return;
    s.started = timing.at_ms;
    s.inputs.push({type: 'click', trusted: true, ...timing});
  }, true);
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const route = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const started = now();
    const sample = bench.active;
    const tracked = sample && !sample.finished && sample.started !== null;
    const row = {route, start_ms: started, method: options.method || 'GET'};
    const body = options.body ? JSON.parse(options.body) : null;
    if (tracked) sample.requests.push(row);
    let response;
    try { response = await fetchOriginal(input, options); }
    catch (error) { if (tracked) bench.fail(`transport: ${error.message}`); throw error; }
    row.headers_ms = now();
    row.status = response.status;
    row.server_span = response.headers.get('X-Alder-Perf-Span');
    const read = response.json.bind(response);
    response.json = async () => {
      const value = await read();
      row.body_ms = now();
      if (route === '/api/state') {
        bench.states.set(value.version, value);
        bench.stateRequests.set(value.version,
          Math.max(bench.stateRequests.get(value.version) ?? -Infinity, started));
        // Preserve the currently rendered entry even if responses arrive out of order.
        for (const version of [...bench.states.keys()].slice(0, -8)) {
          if (version !== bench.renderedVersion) {
            bench.states.delete(version);
            bench.stateRequests.delete(version);
          }
        }
      }
      if (tracked && sample === bench.active) {
        if (!response.ok) bench.fail(`${route}: HTTP ${response.status}`);
        if (route === '/api/run') {
          if (sample.run) bench.fail('more than one run request');
          sample.run = value;
          sample.runResponseMs = row.headers_ms;
        }
        if (route === '/api/cell' && body?.op === 'edit') {
          sample.edits.push({id: body.id, body: body.body.join('\n'), revision: value.revision});
        }
        if (route === '/api/cell' && body?.op === 'add') sample.created = value;
      }
      bench.consider();
      return value;
    };
    return response;
  };
  window.__alderObserveRender = (phase, version) => {
    if (phase === 'begin') bench.renderStarted = now();
    else {
      bench.lastRenderMs = now() - bench.renderStarted;
      bench.renderedVersion = version;
      bench.consider();
    }
  };
  // Cell creation focuses its editor after render, so observe that transition.
  document.addEventListener('focusin', () => bench.consider(), true);
})();
