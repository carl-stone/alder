import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  cleanupScenarioResources,
  delay,
  spawnSmokeProcess,
  stopChild,
} from '../scripts/smoke-scenarios/_common.mjs';

const smokeDriver = fileURLToPath(new URL('../scripts/smoke-application.mjs', import.meta.url));

test('smoke cleanup reports every finalizer failure', async () => {
  const first = new Error('first cleanup failure');
  const second = new Error('second cleanup failure');
  await assert.rejects(
    cleanupScenarioResources(() => { throw first; }, () => { throw second; }),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      return true;
    },
  );
});

test('smoke child shutdown kills descendants in the process group', async t => {
  if (process.platform === 'win32') {
    t.skip('process-group assertion is POSIX-specific');
    return;
  }
  const child = spawnSmokeProcess(process.execPath, [
    '-e',
    "require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
  ], { stdio: 'ignore' });
  try {
    // The real child must finish creating its descendant before group shutdown is exercised.
    await delay(100);
    const pid = child.pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    await stopChild(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(-pid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH');
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stopChild(child);
  }
});

test('smoke child shutdown cleans descendants after leader exit', async t => {
  if (process.platform === 'win32') {
    t.skip('process-group assertion is POSIX-specific');
    return;
  }
  const child = spawnSmokeProcess(process.execPath, [
    '-e',
    "const descendant = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); descendant.unref();",
  ], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try {
    await new Promise(resolve => child.once('exit', resolve));
    await delay(100);
    await stopChild(child);
    assert.throws(() => process.kill(-pid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH');
  } finally {
    await stopChild(child);
  }
});

async function runDriverWithManifest(resources: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'alder-smoke-manifest-'));
  await mkdir(join(root, 'resources'), { recursive: true });
  await writeFile(join(root, 'resources', 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'headless',
    files: [],
    symlinks: [],
    resources,
  }));
  try {
    return spawnSync(process.execPath, [smokeDriver, root, '--rscript', '/bin/true'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('smoke manifest rejects traversal resource paths before launch', async () => {
  const result = await runDriverWithManifest({ cliLauncher: '../outside' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /manifest resource cliLauncher.*unsafe path segment/i);
});

test('smoke manifest rejects resource symlinks escaping the staged root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alder-smoke-symlink-'));
  const outside = join(root, '..', 'alder-smoke-outside-' + process.pid);
  const launcher = join(root, 'resources', 'launcher');
  await mkdir(join(root, 'resources'), { recursive: true });
  await writeFile(outside, '#!/bin/sh\n');
  await symlink(outside, launcher);
  await writeFile(join(root, 'resources', 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'headless',
    files: [],
    symlinks: [],
    resources: { cliLauncher: 'resources/launcher' },
  }));
  try {
    const result = spawnSync(process.execPath, [smokeDriver, root, '--rscript', '/bin/true'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /manifest resource cliLauncher|outside staged root/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
