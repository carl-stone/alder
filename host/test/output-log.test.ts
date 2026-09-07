import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputLog, tailLog } from '../src/output-log.js';

test('console text and export offsets survive partial lines and multibyte characters', () => {
  const log = new OutputLog(1024);
  assert.deepEqual(log.append('a'), { lines: ['a'] });
  assert.deepEqual(log.append('b'), { lines: ['ab'], replaceLast: true });
  assert.deepEqual(log.append('\n🧬前-before '), { lines: ['ab', '🧬前-before '], replaceLast: true });
  const offset = log.characters;
  assert.equal(offset, 13);
  log.append('after\n');
  const transcript = log.lines.join('\n');
  assert.equal(transcript, 'ab\n🧬前-before after');
  assert.equal(Array.from(transcript).slice(0, offset).join(''), 'ab\n🧬前-before ');
  assert.equal(Array.from(transcript).slice(offset).join(''), 'after');
});

test('every partition of CRLF console chunks preserves the same logical lines', () => {
  const text = 'first\r\n\r\nsecond\rthird\n';
  for (let boundary = 0; boundary <= text.length; boundary++) {
    const log = new OutputLog(1024);
    log.append(text.slice(0, boundary));
    log.append(text.slice(boundary));
    assert.deepEqual(log.lines, ['first', '', 'second', 'third']);
    assert.equal(log.characters, 'first\n\nsecond\nthird\n'.length);
  }
});

test('console truncation stays within the UTF-8 cap and reports exactly one marker', () => {
  const log = new OutputLog(5);
  log.append('a🧬more');
  log.append('ignored');
  assert.equal(log.bytes, 5);
  assert.equal(log.characters, 2);
  assert.deepEqual(log.lines, ['a🧬']);
  assert.deepEqual(log.finish('[truncated]'), { lines: ['[truncated]'] });
  assert.equal(log.finish('[truncated]'), undefined);
  assert.deepEqual(log.lines, ['a🧬', '[truncated]']);
  const partial = new OutputLog(3);
  partial.append('a🧬');
  assert.deepEqual(partial.lines, ['a']);
  assert.equal(partial.truncated, true);
});

test('a newline-dense console chunk remains valid within the byte limit', () => {
  const log = new OutputLog(1_048_576);
  const delta = log.append('\n'.repeat(200_000));
  assert.equal(log.lines.length, 200_000);
  assert.equal(delta?.lines.length, 200_000);
  assert.equal(log.characters, 200_000);
  assert.equal(log.truncated, false);
  assert.equal(tailLog(log.lines, 65_536).length, 65_537);
});

test('live console suffix uses UTF-8 bytes and separators', () => {
  assert.deepEqual(tailLog(['old', '🧬', 'x'], 6), ['🧬', 'x']);
  assert.deepEqual(tailLog(['old', '🧬', 'x'], 5), ['x']);
  assert.deepEqual(tailLog(['oversized'], 3), []);
  const log = new OutputLog(100);
  log.append('\ufefftext');
  assert.deepEqual(log.lines, ['\ufefftext']);
  assert.equal(log.characters, 5);
});
