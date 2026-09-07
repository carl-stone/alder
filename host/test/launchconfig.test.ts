import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostConfiguration } from '../src/main.js';

test('launch configuration rejects ambiguous, oversized and invalid UTF-8 input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-launch-config-'));
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, '{"path":null,"port":0}');
    assert.deepEqual(await readHostConfiguration(path), { path: null, port: 0 });
    await writeFile(path, '{"path":"a.R","path":"b.R"}');
    await assert.rejects(readHostConfiguration(path), /duplicate/i);
    await writeFile(path, Buffer.from([0x22, 0xff, 0x22]));
    await assert.rejects(readHostConfiguration(path), /encoded data/i);
    await truncate(path, 8 * 1024 * 1024 + 1);
    await assert.rejects(readHostConfiguration(path), /8 MiB/);
    await assert.rejects(readHostConfiguration(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
