interface TraceRecord {
  event: string;
  pid: number;
  span: number;
  stage: string;
  duration_ms?: number;
  fields?: { operation_id?: string; run_id?: string };
}

export function validateProfileEvidence(
  files: string[], records: TraceRecord[],
  samples: { operationId?: string; runId?: string }[],
): void {
  const ends = new Map(records.filter(record => record.event === 'end')
    .map(record => [`${record.pid}:${record.span}`, record]));
  for (const begin of records.filter(record => record.event === 'begin')) {
    const end = ends.get(`${begin.pid}:${begin.span}`);
    if (!end || end.stage !== begin.stage || !Number.isFinite(end.duration_ms) || end.duration_ms! < 0) {
      throw new Error('unterminated or invalid profile span');
    }
  }
  if (!files.some(file => /^CPU\..*\.cpuprofile$/.test(file)) || !files.includes('browser.cpuprofile') || files.filter(file => file.endsWith('.Rprof')).length < 3) {
    throw new Error('missing browser, Node, kernel, analyzer, or services CPU profile');
  }
  const completed = records.filter(record => record.event === 'end');
  for (const role of ['analyzer', 'services']) {
    const trace = completed.find(record => record.stage === `${role}.request`);
    if (!trace) throw new Error(`missing ${role} trace`);
    if (!files.includes(`cpu-${trace.pid}.Rprof`)) throw new Error(`missing ${role} CPU profile`);
  }
  for (const sample of samples.filter(sample => sample.operationId)) {
    if (!completed.some(record => record.stage === 'host.engine.request' && record.fields?.operation_id === sample.operationId)) {
      throw new Error(`missing host trace for operation ${sample.operationId}`);
    }
    const kernel = completed.find(record => record.stage === 'kernel.execute' && record.fields?.run_id === sample.runId);
    if (!kernel) throw new Error(`missing kernel trace for run ${sample.runId}`);
    if (!files.includes(`cpu-${kernel.pid}.Rprof`)) throw new Error('missing kernel CPU profile');
  }
}
