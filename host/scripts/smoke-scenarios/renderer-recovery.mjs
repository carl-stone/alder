import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupScenarioResources, createHarness, awaitOperation, command, delay, openSession, releaseLease, signalSmokeProcessGroup } from './_common.mjs';
import { openInteractiveBrowser } from '../../test-support/live-browser.mjs';

const ID = 'renderer-recovery';

async function ensureLauncher(ctx) {
  const relative = ctx.manifest?.resources?.cliLauncher;
  if (typeof relative !== 'string' || !await access(join(ctx.applicationRoot, relative)).then(() => true).catch(() => false)) {
    const error = new Error('scenario_unavailable: ' + ID + ': staged CLI launcher is unavailable');
    error.code = 'scenario_unavailable';
    throw error;
  }
}

/**
 * Exercise the durable recovery path with an unclean renderer/host death and
 * a concurrent peer revision. Recovery must retain the branch or expose an
 * explicit conflict; silently replaying the old source is a failure.
 */
export async function run(ctx) {
  const originalSource = '# %%\nlocal <- 1\nlocal\n# %%\n# recovery fixture\n';
  let harness;
  let restarted;
  let peer;
  let hardCrash = false;
  try {
    await ensureLauncher(ctx);
        harness = await createHarness(ctx, { id: ID, source: originalSource });
    let notebook = await harness.snapshot();
    assert.equal(notebook.cells?.length, 2, 'recovery fixture must contain two cells');

    const browserDraft = await exerciseIndexedDbDraft(harness);
    assert.match(browserDraft.dom, /id="save"/, 'renderer recovery requires the real editor renderer');
    assert.match(browserDraft.dom, /id="settings"/, 'renderer recovery requires the real settings dialog');
    notebook = await harness.snapshot();
    const baselineRevision = documentRevision(notebook);

    // A transaction is acknowledged by the controller but deliberately not
    // saved. This is the committed shared dirty source that recovery must keep.
    const localOperation = randomUUID();
    const localAdmission = await harness.nextCommand({
      operationId: localOperation,
      type: 'transaction',
      expectedDocumentRevision: baselineRevision,
      changes: [{
        type: 'edit', cell: { cellId: 'cell-1' }, expectedRevision: notebook.cells[0].revision,
        cellType: 'code', body: ['local <- 2', 'local'],
      }],
    });
    assertAdmission(localAdmission, 'local dirty edit');
    const localResult = await harness.awaitOperation(localOperation);
    assert.equal(localResult.status, 'done');

    notebook = await harness.snapshot();

    assert.deepEqual(notebook.cells[0].body, ['local <- 2', 'local']);
    const dirtyRevision = documentRevision(notebook);

    // A second authenticated client advances the same cell. The primary
    // renderer must be able to recover a newer peer revision, not replay its
    // stale local branch over it.
    peer = await openSession(harness.origin, harness.registry);
    const peerOperation = randomUUID();
    const peerAdmission = await command(harness.origin, peer, {
      operationId: peerOperation,
      clientId: peer.clientId,
      commandSequence: peer.nextCommandSequence,
      sessionEpoch: peer.epoch,
      type: 'transaction',
      expectedDocumentRevision: dirtyRevision,
      changes: [{
        type: 'edit', cell: { cellId: 'cell-1' }, expectedRevision: notebook.cells[0].revision,
        cellType: 'code', body: ['peer <- 9', 'peer'],
      }],
    });
    assertAdmission(peerAdmission, 'peer revision');
    const peerResult = await awaitOperation(harness.origin, peer, peerOperation);
    assert.equal(peerResult.status, 'done');
    peer.nextCommandSequence += 1;

    notebook = await harness.snapshot();

    assert.deepEqual(notebook.cells[0].body, ['peer <- 9', 'peer'], 'newer peer revision must be visible before recovery');

    // Change the disk independently, then kill the host without going through
    // its clean shutdown path. The recovery writer must retain enough metadata
    // to report a conflict instead of silently choosing either source.
    const externalSource = '# %%\ndisk <- 77\ndisk\n# %%\n# recovery fixture\n';
    await writeFile(harness.notebook, externalSource);
    signalSmokeProcessGroup(harness.child.pid, 'SIGKILL');
    hardCrash = true;
    await new Promise(resolve => harness.child.once('exit', resolve));

    restarted = await createHarness(ctx, { id: ID, source: externalSource });
    const recovered = await restarted.snapshot();

    const recoveryQuery = await restarted.query({ type: 'recovery' });
    const branches = recoveryBranches(recoveryQuery, recovered);
    assert.ok(Array.isArray(branches), 'recovery endpoint must expose durable branches');
    assert.ok(
      branches.some(branch => branch.state === 'conflict' || branch.state === 'dirty')
        || recovered.cells?.[0]?.body?.join('\n').includes('peer <- 9'),
      'unclean restart must retain the dirty branch or expose an explicit conflict',
    );
    assert.doesNotMatch(JSON.stringify(recoveryQuery), /csrf|bearer|authorization|ticket/i, 'recovery artifacts must not contain credentials');

    const recoveredBrowser = await browserState(restarted);
    assert.match(recoveredBrowser.dom, /id="notebook"/, 'renderer must reload after host recovery');
    if (branches.some(branch => branch.state === 'conflict')) {
      assert.equal(recoveredBrowser.recovery.branches.some(candidate => candidate.state === 'conflict'), true, `renderer did not load host recovery state: ${JSON.stringify(recoveredBrowser.recovery)}`);
      assert.match(recoveredBrowser.dom, /data-recovery/, 'a disk/branch mismatch must be visible as a recovery action');
      assert.match(recoveredBrowser.dom, /Reload authoritative|Keep as recovery|Discard local branch|Cancel/, 'conflict recovery must expose explicit choices');
    }

    // A clean Save after recovery is still an explicit command and must not
    // happen as a side effect of reload. If the branch is clean, this verifies
    // the committed source path; if it is dirty, it verifies durable saving.
    const postNotebook = await restarted.snapshot();

    const saveOperation = randomUUID();
    const saveAdmission = await restarted.nextCommand({
      operationId: saveOperation,
      type: 'save',
      expectedDocumentRevision: documentRevision(postNotebook),
    });
    assertAdmission(saveAdmission, 'recovery save');
    const saveResult = await restarted.awaitOperation(saveOperation);
    assert.equal(saveResult.status, 'done', 'explicit recovery Save must settle');

    return {
      id: ID,
      identity: {
        artifact: ctx.manifest.sourceCommit,
        browser: 'headless Chromium recovery reload',
        runtime: {
          rscript: restarted.selectedR,
          before: harness.registry.epoch,
          after: restarted.registry.epoch,
          processNonce: restarted.registry.processNonce,
        },
      },
      fixture: restarted.notebook,
      result: 'dirty branch, peer revision, unclean host restart, recovery identity, conflict visibility, and explicit Save were exercised',
    };
  } catch (error) {
    throw normalizeUnavailable(ID, error);
  } finally {
    await cleanupScenarioResources(
      () => peer && harness ? releaseLease(harness.origin, peer) : undefined,
      () => restarted?.close(),
      () => harness && !hardCrash ? harness.close() : undefined,
    );
  }
}



function documentRevision(notebook) {
  const revision = notebook?.documentRevision ?? notebook?.revision;
  assert.equal(typeof revision, 'number', 'snapshot must carry a document revision');
  return revision;
}

function recoveryBranches(value, notebook) {
  const candidate = value?.result ?? value;
  if (Array.isArray(candidate?.branches)) return candidate.branches;
  if (Array.isArray(candidate?.recovery?.branches)) return candidate.recovery.branches;
  if (Array.isArray(notebook?.recovery?.branches)) return notebook.recovery.branches;
  return [];
}

async function exerciseIndexedDbDraft(harness) {
  let live;
  try {
    live = await openInteractiveBrowser(harness, { name: ID + '-indexeddb' });
    await live.wait("window.__alderHost?.client?.document?.snapshot != null");
    const edited = await live.browser.evaluate("(async () => { const client = window.__alderHost.client; const cell = client.document.cells[0]; client.editCell(cell.key, ['browserDraft <- 3', 'browserDraft']); client.document.updateSelection(cell.key, { anchor: 7, head: 12, scrollTop: 19 }); await client.flushDraftPersistence(); return { body: client.document.cell(cell.key).desiredBody, recovery: client.recoveryState }; })()");
    assert.deepEqual(edited.body, ['browserDraft <- 3', 'browserDraft'], 'local renderer edit must remain unacknowledged');
    const storedBefore = await indexedDbEntries(live);
    assert.ok(storedBefore.some(entry => String(entry.key).endsWith(':cursor') && entry.value?.schemaVersion === 1 && entry.value?.algorithm === 'AES-256-GCM' && entry.value?.ciphertext), 'IndexedDB must contain encrypted unacknowledged edit intent');
    assert.doesNotMatch(JSON.stringify(storedBefore), /browserDraft <- 3|csrf|bearer|authorization|ticket|cookie|leaseId/i, 'IndexedDB draft must contain neither plaintext source nor credentials');

    await live.browser.evaluate("window.__alderHost.view.internalNavigation = true");
    await live.browser.send('Page.navigate', { url: 'about:blank' });
    const authoritative = await harness.snapshot();
    const operationId = randomUUID();
    const admission = await harness.nextCommand({
      operationId,
      type: 'transaction',
      expectedDocumentRevision: documentRevision(authoritative),
      changes: [{ type: 'edit', cell: { cellId: authoritative.cells[0].id }, expectedRevision: authoritative.cells[0].revision, cellType: 'code', body: ['peerDraft <- 9', 'peerDraft'] }],
    });
    assertAdmission(admission, 'newer peer draft edit');
    assert.equal((await harness.awaitOperation(operationId)).status, 'done');

    await live.navigate(harness);
    await live.wait("window.__alderHost?.client?.recoveryState?.status === 'conflict'");
    const conflict = await live.browser.evaluate("(() => { const client = window.__alderHost.client; const cell = client.document.cells[0]; return { status: client.recoveryState.status, local: client.recoveryState.local, desired: cell.desiredBody, server: cell.serverBody, conflicted: cell.conflict, dom: document.documentElement.outerHTML }; })()");
    assert.equal(conflict.status, 'conflict', 'newer peer revision must retain the renderer draft as conflict');
    assert.deepEqual(conflict.desired, ['browserDraft <- 3', 'browserDraft']);
    assert.deepEqual(conflict.server, ['peerDraft <- 9', 'peerDraft']);
    assert.equal(conflict.conflicted, true);

    const cancelled = await live.browser.evaluate("(() => { const client = window.__alderHost.client; client.cancelRecovery(); return { status: client.recoveryState.status, local: client.recoveryState.local, desired: client.document.cells[0].desiredBody }; })()");
    assert.equal(cancelled.status, 'conflict', 'Cancel must keep the recovery branch visible');
    assert.ok(cancelled.local, 'Cancel must retain the current client branch');
    assert.deepEqual(cancelled.desired, ['browserDraft <- 3', 'browserDraft']);

    const discarded = await live.browser.evaluate("(async () => { const client = window.__alderHost.client; await client.discardRecovery(); await client.flushDraftPersistence(); return { status: client.recoveryState.status, local: client.recoveryState.local, desired: client.document.cells[0].desiredBody, server: client.document.cells[0].serverBody, dom: document.documentElement.outerHTML }; })()");
    assert.equal(discarded.status, 'none', 'Discard must remove only the current renderer branch');
    assert.equal(discarded.local, null);
    assert.deepEqual(discarded.desired, ['peerDraft <- 9', 'peerDraft'], 'Discard must preserve authoritative peer source');
    const storedAfter = await indexedDbEntries(live);
    assert.notDeepEqual(storedAfter, storedBefore, 'Discard must replace the persisted renderer draft');
    await live.navigate(harness);
    await live.wait("window.__alderHost?.client?.recoveryState?.status === 'none'");
    const restored = await live.browser.evaluate("(() => { const client = window.__alderHost.client; return { desired: client.document.cells[0].desiredBody, server: client.document.cells[0].serverBody }; })()");
    assert.deepEqual(restored.desired, ['peerDraft <- 9', 'peerDraft'], 'discarded draft must not recover after navigation');
    assert.deepEqual(restored.server, ['peerDraft <- 9', 'peerDraft']);
    return { dom: discarded.dom, storedBefore, storedAfter };
  } finally {
    await cleanupScenarioResources(() => live?.close());
  }
}

async function indexedDbEntries(live) {
  return live.browser.evaluate("new Promise((resolve, reject) => { const request = indexedDB.open('alder-browser-recovery'); request.onerror = () => reject(request.error); request.onsuccess = () => { const database = request.result; const transaction = database.transaction('state', 'readonly'); const store = transaction.objectStore('state'); const keys = store.getAllKeys(); const values = store.getAll(); transaction.onerror = () => reject(transaction.error); transaction.oncomplete = () => resolve(keys.result.map((key, index) => ({ key, value: values.result[index] }))); }; })");
}

function assertAdmission(value, label) {
  assert.notEqual(value?.accepted, false, `${label} command was rejected: ${JSON.stringify(value)}`);
}
async function browserState(harness) {
  let live;
  try {
    live = await openInteractiveBrowser(harness, { name: ID });
    await live.wait("window.__alderHost?.client?.document?.snapshot != null");
    const query = await live.browser.evaluate("window.__alderHost.client.query({ type: 'recovery' })");
    if (query.result.branches.length > 0 || query.result.pending || query.result.corruption !== null) {
      await live.wait("window.__alderHost.client.recoveryState.branches.length > 0 || window.__alderHost.client.recoveryState.pending || window.__alderHost.client.recoveryState.corruption !== null");
    }
    return await live.browser.evaluate("({ dom: document.documentElement.outerHTML, recovery: window.__alderHost.client.recoveryState })");
  } catch (error) {
    if (error?.code === 'scenario_unavailable' || String(error?.message ?? error).startsWith('browser_')) {
      const unavailable = new Error(`scenario_unavailable: ${ID}: ${error?.message ?? error}`);
      unavailable.code = 'scenario_unavailable';
      throw unavailable;
    }
    throw error;
  } finally {
    await cleanupScenarioResources(() => live?.close());
  }
}

function normalizeUnavailable(id, error) {
  if (error?.code === 'scenario_unavailable' || String(error?.message ?? '').startsWith('scenario_unavailable:')) return error;
  if (/browser_(unavailable|failed)|host_ready_timeout|session_registry_timeout|r_(invalid|not_found)/.test(String(error?.message ?? error))) {
    const unavailable = new Error(`scenario_unavailable: ${id}: ${error.message ?? error}`);
    unavailable.code = 'scenario_unavailable';
    return unavailable;
  }
  return error;
}
