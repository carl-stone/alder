import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

function harness() {
  let code = readFileSync(new URL('./input-latency-browser.js', import.meta.url), 'utf8');
  // In-memory mutations let validation prove these regressions detect defects.
  if (process.env.ALDER_LATENCY_MUTATION === 'stale') {
    code = code.replace('state.version <= sample.previousVersion', 'false');
  }
  if (process.env.ALDER_LATENCY_MUTATION === 'wrong-dom') {
    code = code.replace('target.innerText.trim() === sample.expected', 'true');
  }
  if (process.env.ALDER_LATENCY_MUTATION === 'input-delay') {
    code = code.replace('const at = event.timeStamp;', 'const at = handled;');
  }
  let time = 0;
  const frames = [];
  const listeners = new Map();
  const output = {innerText: '[1] 4', getBoundingClientRect: () => ({width: 100, height: 20, top: 0, bottom: 20}),
    classList: {contains: () => false}};
  const cell = {querySelector: () => output, classList: {contains: () => true}, contains: () => true};
  const document = {visibilityState: 'visible', activeElement: {},
    getElementById: () => cell, addEventListener: (name, fn) => listeners.set(name, fn)};
  const window = {fetch: async () => { throw new Error('unexpected fetch'); }};
  runInNewContext(code, {window, document, Map, URL, location: {href: 'http://localhost/'},
    performance: {now: () => ++time}, getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    innerHeight: 1000, requestAnimationFrame: fn => frames.push(fn)});
  const state = {version: 2, runtime: {busy: false}, last_action_error: null,
    cells: [{id: 'a', body: ['x <- 2'], revision: 1, status: 'done',
      outputs: [{kind: 'text', text: '[1] 4'}]}]};
  const sample = {kind: 'edit-run', previousVersion: 1, started: 0, runInput: 1,
    run: {run_id: 5}, sourceCell: 'a', resultCell: 'a', cells: ['a'],
    source: 'x <- 2', expected: '[1] 4', edits: [{id: 'a', body: 'x <- 2', revision: 1}],
    inputs: [{trusted: true}], requests: []};
  return {bench: window.__alderLatency, state, sample, output, frames, listeners, document, window,
    advance: ms => { time += ms; }};
}

test('stale snapshots and unacknowledged or different source cannot finish a sample', () => {
  const {bench, sample, state} = harness();
  assert.equal(bench.eligible(sample, {...state, version: 1}), false);
  assert.equal(bench.eligible({...sample, edits: []}, state), false);
  assert.equal(bench.eligible({...sample, source: 'x <- 3'}, state), false);
  state.cells[0].revision = 0;
  assert.equal(bench.eligible(sample, state), false);
});

test('old output, incomplete execution and absent run receipts are rejected', () => {
  const {bench, sample, state} = harness();
  assert.equal(bench.eligible({...sample, run: null}, state), false);
  state.runtime.busy = true;
  assert.equal(bench.eligible(sample, state), false);
  state.runtime.busy = false;
  state.cells[0].outputs[0].text = '[1] 2';
  assert.equal(bench.eligible(sample, state), false);
});

test('a held pre-run response cannot qualify through an unrelated newer version', () => {
  const {bench, sample, state} = harness();
  sample.runResponseMs = 20;
  bench.stateRequests.set(2, 10);
  assert.equal(bench.eligible(sample, state), false);
  bench.stateRequests.set(2, 21);
  assert.equal(bench.eligible(sample, state), true);
});

test('a correct API result cannot finish while the visible DOM is wrong', () => {
  const {bench, sample, state, output, frames} = harness();
  bench.active = sample;
  bench.states.set(2, state);
  bench.renderedVersion = 2;
  output.innerText = '[1] 2';
  bench.consider();
  assert.equal(frames.length, 0);
  assert.notEqual(sample.finished, true);
});

test('presentation requires two frames and rechecks visibility and current source', () => {
  const {bench, sample, state, frames, document} = harness();
  bench.active = sample;
  bench.states.set(2, state);
  bench.renderedVersion = 2;
  bench.consider();
  assert.notEqual(sample.finished, true);
  frames.shift()();
  assert.notEqual(sample.finished, true);
  document.visibilityState = 'hidden';
  frames.shift()();
  assert.notEqual(sample.finished, true);
  document.visibilityState = 'visible';
  bench.consider();
  frames.shift()();
  frames.shift()();
  assert.equal(sample.finished, true);
  assert.equal(sample.result.expected, '[1] 4');
  assert.ok(sample.result.presentation_ms > sample.result.dom_ms);
});

test('synthetic keyboard events cannot start the input timer', () => {
  const {bench, sample, listeners} = harness();
  sample.started = null;
  bench.active = sample;
  listeners.get('keydown')({isTrusted: false, key: 'Enter', ctrlKey: true});
  assert.equal(sample.started, null);
  listeners.get('keydown')({isTrusted: true, key: 'Enter', ctrlKey: true, timeStamp: 1});
  assert.ok(sample.started > 0);
});

test('input queued before JavaScript handles it remains in the measured latency', () => {
  const {bench, sample, state, listeners, advance, frames} = harness();
  sample.kind = 'run';
  sample.started = null;
  bench.active = sample;
  bench.states.set(2, state);
  bench.renderedVersion = 2;
  advance(100);
  listeners.get('keydown')({isTrusted: true, key: 'Enter', ctrlKey: true, timeStamp: 20});
  bench.consider();
  frames.shift()();
  frames.shift()();
  assert.equal(sample.result.input_ms, 20);
  assert.ok(sample.result.input_to_result_ms >= 80, 'queued input must not disappear from latency');
  assert.ok(sample.result.inputs.at(-1).handled_ms >= 100);
});
