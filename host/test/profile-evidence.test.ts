import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfileEvidence } from '../test-support/profile-evidence.js';

const files = ['CPU.host.cpuprofile', 'browser.cpuprofile', 'cpu-2.Rprof', 'cpu-3.Rprof', 'cpu-4.Rprof'];
const samples = [{ operationId: 'operation-1', runId: 'run-1' }];
const records = [
  { pid: 1, span: 1, stage: 'host.engine.request', fields: { operation_id: 'operation-1' } },
  { pid: 2, span: 1, stage: 'kernel.execute', fields: { run_id: 'run-1' } },
  { pid: 3, span: 1, stage: 'analyzer.request', fields: {} },
  { pid: 4, span: 1, stage: 'services.request', fields: {} },
].flatMap(record => [{ ...record, event: 'begin' }, { ...record, event: 'end', duration_ms: 2 }]);

test('profile qualification rejects missing stages, CPU profiles and mismatched execution identities', () => {
  assert.doesNotThrow(() => validateProfileEvidence(files, records, samples));
  for (const stage of ['host.engine.request', 'kernel.execute', 'analyzer.request', 'services.request']) {
    assert.throws(() => validateProfileEvidence(files, records.filter(record => record.stage !== stage), samples), /missing/);
    assert.throws(() => validateProfileEvidence(files,
      records.filter(record => record.event !== 'end' || record.stage !== stage), samples), /unterminated/);
  }
  for (const name of files) {
    assert.throws(() => validateProfileEvidence(files.filter(file => file !== name), records, samples), /missing/);
  }
  assert.throws(() => validateProfileEvidence(files, records, [{ operationId: 'operation-2', runId: 'run-1' }]), /missing host/);
  assert.throws(() => validateProfileEvidence(files, records, [{ operationId: 'operation-1', runId: 'run-2' }]), /missing kernel/);
  assert.throws(() => validateProfileEvidence(['CPU.host.cpuprofile', 'browser.cpuprofile', 'cpu-2.Rprof', 'cpu-4.Rprof', 'cpu-5.Rprof'], records, samples), /analyzer CPU/);
  assert.throws(() => validateProfileEvidence(files,
    records.map(record => ({ ...record, duration_ms: -1 })), samples), /invalid profile/);
});
