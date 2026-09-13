import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigShadowedError,
  appConfig,
  assertConfigPatchEffective,
  resolveConfig,
  setAppConfig,
  validateConfigLayer,
} from '../src/configuration.js';

test('resolves every configuration layer and reports leaf provenance', async () => {
  const resolution = await resolveConfig({
    path: null,
    user: { theme: 'light', editor: { font_size: 16 } },
    project: { theme: 'dark', editor: { tab_size: 4 } },
    runtime: { editor: { font_size: 20 }, on_cell_change: 'lazy' },
    launch: { theme: 'system' },
  });

  assert.equal(resolution.effective.theme, 'system');
  assert.equal(resolution.effective.editor.font_size, 20);
  assert.equal(resolution.effective.editor.tab_size, 4);
  assert.equal(resolution.effective.on_cell_change, 'lazy');
  assert.equal(resolution.provenance.theme, 'launch');
  assert.equal(resolution.provenance['editor.font_size'], 'runtime');
  assert.equal(resolution.provenance['editor.tab_size'], 'project');
  assert.equal(resolution.provenance['editor.line_numbers'], 'defaults');
  assert.equal(resolution.layers.user.theme, 'light');
  assert.equal(resolution.layers.project.editor?.tab_size, 4);
});

test('rejects a project patch shadowed by runtime before the writer commits', async () => {
  const resolution = await resolveConfig({
    path: null,
    user: {},
    project: { theme: 'dark' },
    runtime: { theme: 'light' },
    launch: {},
  });
  const patch = validateConfigLayer({ theme: 'dark' });

  assert.throws(
    () => assertConfigPatchEffective(resolution, patch, 'project'),
    (error: unknown) => error instanceof ConfigShadowedError
      && error.code === 'config_shadowed'
      && error.details.key === 'theme'
      && error.details.writtenLayer === 'project'
      && error.details.effectiveLayer === 'runtime',
  );
});

test('allows a shadowed patch when the requested effective value is unchanged', async () => {
  const resolution = await resolveConfig({
    path: null,
    user: {},
    project: { theme: 'light' },
    runtime: { theme: 'light' },
    launch: {},
  });
  const patch = validateConfigLayer({ theme: 'light' });

  assert.doesNotThrow(() => assertConfigPatchEffective(resolution, patch, 'project'));
  assert.equal(resolution.effective.theme, 'light');
  assert.equal(resolution.provenance.theme, 'runtime');
  assert.equal(resolution.layers.project.theme, 'light');
});

test('rejects a runtime patch shadowed by launch', async () => {
  const resolution = await resolveConfig({
    path: null,
    user: {},
    project: {},
    runtime: { on_startup: false },
    launch: { on_startup: true },
  });
  const patch = validateConfigLayer({ on_startup: false });

  assert.throws(
    () => assertConfigPatchEffective(resolution, patch, 'runtime'),
    (error: unknown) => error instanceof ConfigShadowedError
      && error.details.key === 'on_startup'
      && error.details.writtenLayer === 'runtime'
      && error.details.effectiveLayer === 'launch',
  );
});
test('returns app leaf provenance and preserves unknown authored fields on update', () => {
  const notebook = {
    path: '/tmp/notebook.R',
    metadata: { title: 'Notebook', app: { layout: 'grid', vendor_flag: { enabled: true } } },
  };
  const before = appConfig(notebook);
  assert.equal(before.effective.layout, 'grid');
  assert.equal(before.effective.width, 'medium');
  assert.equal(before.provenance.layout, 'app');
  assert.equal(before.provenance.width, 'defaults');
  assert.equal(before.provenance.include_code, 'defaults');

  const next = setAppConfig(notebook, { include_code: true });
  const nextApp = (next.metadata as Record<string, unknown>).app as Record<string, unknown>;
  const vendorFlag = nextApp.vendor_flag as Record<string, unknown>;
  assert.equal(nextApp.layout, 'grid');
  assert.equal(nextApp.include_code, true);
  assert.equal(nextApp.width, undefined);
  assert.equal(vendorFlag.enabled, true);
  assert.equal((next.metadata as Record<string, unknown>).title, 'Notebook');
  const originalApp = ((notebook.metadata as Record<string, unknown>).app) as Record<string, unknown>;
  assert.equal(originalApp.include_code, undefined);
});
