import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadStore } from '../src/uploads.js';

test('uploads validate all files before writing and remove only owned batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-uploads-'));
  try {
    const uploads = new UploadStore(directory);
    await assert.rejects(uploads.store([{ name: '../secret', content_base64: '' }]));
    await assert.rejects(uploads.store([{ name: 'data.csv', content_base64: '!!!!' }]), { code: 'invalid_request' });
    assert.deepEqual(await readdir(directory), []);
    const first = await uploads.store([{ name: 'data.csv', content_base64: Buffer.from('a\n1\n').toString('base64') }]);
    const second = await uploads.store([{ name: 'empty.txt', content_base64: '' }]);
    assert.equal(first.value[0]!.size, 4);
    assert.equal(await readFile(first.value[0]!.path, 'utf8'), 'a\n1\n');
    await uploads.remove('../');
    assert.equal((await readdir(directory)).length, 2);
    await uploads.remove(first.uploadId);
    assert.equal((await readdir(directory)).length, 1);
    assert.equal(await readFile(second.value[0]!.path, 'utf8'), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
