import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import {
  captureProcessTree,
  cleanupScenarioResources,
  createHarness,
  delay,
  openSession,
  processStartIdentity,
  redact,
  releaseLease,
  sanitizedEnvironment,
  spawnSmokeProcess,
  stopChild,
  waitForExecutionReady,
  requireAbsoluteRscript,
  fetchLogicalOrigin,
} from './_common.mjs';

const EXPECTED_TOOLS = new Set([
  'notebook_state', 'list_cells', 'read_cell', 'add_cell', 'edit_cell', 'delete_cell',
  'move_cell', 'rename_cell', 'disable_cell', 'run_cell', 'run_all', 'run_stale',
  'interrupt', 'get_value', 'set_widget', 'save', 'check', 'apply_transaction',
  'edit_cell_ranges', 'select_r', 'set_runtime', 'reload_source', 'get_help',
  'recovery_state', 'shutdown', 'restart', 'format', 'save_as', 'read_output',
  'table_page', 'materialize_output', 'operation_status', 'read_events', 'get_config',
  'set_config', 'get_layout', 'set_layout', 'set_app', 'packages_status',
  'packages_declare', 'packages_install', 'publish', 'upload_file',
]);

const TERMINAL_OPERATIONS = new Set(['done', 'error', 'interrupted', 'cancelled']);

export async function run(ctx) {
  if (ctx.manifest.kind === 'desktop') {
    assert.equal(typeof ctx.manifest.runtimes?.electron, 'string', 'desktop co-use requires an actual Electron identity');
    assert.equal(typeof ctx.manifest.runtimes?.chromium, 'string', 'desktop co-use requires an actual Chromium identity');
    assert.equal(typeof ctx.manifest.runtimes?.electronNode, 'string', 'desktop co-use requires an embedded Node identity');
  }
  const first = await createHarness(ctx, {
    id: 'mcp-couse-gui-first',
    source: [
      '# %%',
      'x <- 40',
      '# %%',
      'Sys.sleep(5); x + 2',
      '# %%',
      'x + 1',
      '',
    ].join('\n'),
  });
  let firstAgents = [];
  let firstHttpAgents = [];
  let firstDesktop;
  let firstClosed = false;
  let second;
  let secondAgents = [];
  let secondHttpAgents = [];
  let secondDesktop;
  try {
    // GUI-first: exercise the real browser before either stdio MCP client exists.
    await waitForExecutionReady(first);
    const browserBeforeAgents = await browserDump(first.origin, await first.mintTicket(), join(ctx.evidence, 'browser-mcp-couse'), 'x <- 40');
    assert.match(browserBeforeAgents, /x\s*<-\s*40/);
    firstDesktop = await openDesktop(ctx, first, 'mcp-couse-electron-gui-first', 'x <- 40');
    process.stderr.write('[mcp-couse] GUI-first browser and Electron ready\n');

    firstAgents = await Promise.all([
      openAgent(ctx, first, 'mcp-couse-agent-a'),
      openAgent(ctx, first, 'mcp-couse-agent-b'),
    ]);
    process.stderr.write('[mcp-couse] GUI-first agents connected\n');
    firstHttpAgents = await Promise.all([
      openHttpAgent(first.origin, first.registry, 'mcp-couse-http-a'),
      openHttpAgent(first.origin, first.registry, 'mcp-couse-http-b'),
    ]);
    process.stderr.write('[mcp-couse] GUI-first HTTP agents connected\n');
    await assertCatalog([...firstAgents, ...firstHttpAgents]);
    const httpInitialA = await notebookState(firstHttpAgents[0]);
    const httpInitialB = await notebookState(firstHttpAgents[1]);
    assert.equal(httpInitialA.envelope.epoch, first.registry.epoch);
    assert.equal(httpInitialB.envelope.epoch, httpInitialA.envelope.epoch);
    assert.equal(httpInitialA.nextCommandSequence, 1);
    assert.equal(httpInitialB.nextCommandSequence, 1);
    await assertHttpSessionIsolation(first.origin, firstHttpAgents[0], firstHttpAgents[1]);

    const initialA = await notebookState(firstAgents[0]);
    const initialB = await notebookState(firstAgents[1]);
    assert.equal(initialA.envelope.epoch, first.registry.epoch);
    assert.equal(initialB.envelope.epoch, initialA.envelope.epoch);
    assert.equal(initialA.state.runtime.kernelEpoch, initialB.state.runtime.kernelEpoch);
    assert.equal(initialA.nextCommandSequence, 1);
    assert.equal(initialB.nextCommandSequence, 1);
    assert.equal(first.registry.pid > 0, true);
    const firstCell = initialA.state.cells[0];
    assert.ok(firstCell?.id);

    const editA = await effect(firstAgents[0], 'edit_cell', {
      expectedDocumentRevision: initialA.state.documentRevision,
      cell: firstCell.id,
      body: ['x <- 41'],
      type: firstCell.type,
      expectedRevision: firstCell.revision,
    });
    assert.equal(editA.raw.isError, false, JSON.stringify(redact(editA.raw)));
    assert.equal(editA.admission.commandSequence, 1);
    assert.equal(editA.admission.sequenceConsumed, true);
    assert.equal(editA.admission.nextCommandSequence, 2);
    assert.equal(editA.envelope.documentRevision, initialA.state.documentRevision + 1);

    // Client B observes A's committed edit while retaining its own sequence 1.
    const afterPeerEdit = await notebookState(firstAgents[1]);
    assert.equal(afterPeerEdit.nextCommandSequence, 1);
    const afterPeerCell = await readCell(firstAgents[1], firstCell.id);
    assert.deepEqual(afterPeerCell.cell.body, ['x <- 41']);
    assert.ok(afterPeerCell.cell.revision > firstCell.revision);
    const httpAfterPeerEdit = await notebookState(firstHttpAgents[1]);
    assert.equal(httpAfterPeerEdit.nextCommandSequence, 1);
    const httpAfterPeerCell = await readCell(firstHttpAgents[1], firstCell.id);
    assert.deepEqual(httpAfterPeerCell.cell.body, ['x <- 41']);
    const browserAfterPeerEdit = await browserDump(first.origin, await first.mintTicket(), join(ctx.evidence, 'browser-mcp-couse'), 'x <- 41');
    assert.match(browserAfterPeerEdit, /x\s*<-\s*41/);
    const firstDesktopState = await readDesktop(firstDesktop, 'x <- 41');
    if (firstDesktopState) {
      assert.equal(firstDesktopState.epoch, afterPeerEdit.state.epoch);
      assert.equal(firstDesktopState.documentRevision, afterPeerEdit.state.documentRevision);
      assert.equal(firstDesktopState.kernelEpoch, afterPeerEdit.state.runtime.kernelEpoch);
      assert.equal(firstDesktopState.hostPid, first.registry.pid);
      assert.equal(firstDesktopState.hostStartIdentity, first.registry.startIdentity);
      assert.equal(firstDesktopState.processNonce, first.registry.processNonce);
      assert.equal(firstDesktopState.sessionKey, first.registry.sessionKey);
      assert.equal(firstDesktopState.continuityProof, first.registry.continuityProof);
      assert.equal(firstDesktopState.origin, first.registry.origin);
    }

    // The stale revision is rejected as a structured conflict, without rebasing B's draft.
    const stale = await effect(firstAgents[1], 'edit_cell', {
      expectedDocumentRevision: initialA.state.documentRevision,
      cell: firstCell.id,
      body: ['x <- 99'],
      type: firstCell.type,
      expectedRevision: firstCell.revision,
    });
    assert.equal(stale.raw.isError, true, JSON.stringify(redact(stale.raw)));
    assert.equal(stale.envelope.error?.code, 'source_conflict');
    assert.equal(stale.envelope.result.admission.sequenceConsumed, true);
    assert.equal(stale.envelope.result.admission.commandSequence, 1);
    assert.equal(stale.envelope.result.admission.nextCommandSequence, 2);
    const afterStale = await notebookState(firstAgents[1]);
    assert.equal(afterStale.nextCommandSequence, 2);
    assert.deepEqual((await readCell(firstAgents[1], firstCell.id)).cell.body, ['x <- 41']);

    const longCell = afterStale.state.cells[1];
    assert.ok(longCell?.id);
    const runAccepted = await effect(firstAgents[0], 'run_cell', {
      expectedDocumentRevision: afterStale.state.documentRevision,
      cell: longCell.id,
      wait: false,
    });
    assert.equal(runAccepted.raw.isError, false, JSON.stringify(redact(runAccepted.raw)));
    assert.equal(runAccepted.admission.commandSequence, 2);
    assert.equal(runAccepted.admission.sequenceConsumed, true);
    assert.equal(runAccepted.admission.nextCommandSequence, 3);
    assert.equal(runAccepted.envelope.operation.id, runAccepted.operationId);

    // The long run is admitted asynchronously; state and cell queries stay live before it ends.
    const runningState = await waitForActiveRun(firstAgents[1]);
    const runId = runningState.state.runtime.activeRunId;
    assert.equal(typeof runId, 'string');
    const [responsiveState, responsiveCells] = await Promise.all([
      notebookState(firstAgents[1]),
      query(firstAgents[1], 'list_cells'),
    ]);
    assert.equal(responsiveState.state.runtime.activeRunId, runId);
    assert.ok(Array.isArray(responsiveCells.envelope.result));
    assert.equal(responsiveCells.raw.isError, false);

    const stop = await effect(firstAgents[1], 'interrupt', { runId });
    assert.equal(stop.raw.isError, false, JSON.stringify(redact(stop.raw)));
    assert.equal(stop.admission.commandSequence, 2);
    assert.equal(stop.admission.sequenceConsumed, true);
    assert.equal(stop.admission.nextCommandSequence, 3);
    assert.equal(stop.envelope.result.value.runId, runId);
    assert.equal(stop.envelope.result.value.requested, true);

    const stoppedOperation = await waitForOperation(firstAgents[0], runAccepted.operationId);
    assert.ok(['cancelled', 'interrupted'].includes(stoppedOperation.status));
    assert.match(stoppedOperation.error?.code ?? '', /cancel|interrupt/i);
    process.stderr.write('[mcp-couse] asynchronous run interrupted\n');
    const stoppedState = await notebookState(firstAgents[1]);
    assert.equal(stoppedState.state.runtime.activeRunId, null);

    const recovery = (await query(firstAgents[1], 'recovery_state')).envelope.result;
    assert.deepEqual(Object.keys(recovery).sort(), ['branches', 'corruption', 'pending']);
    assert.ok(Array.isArray(recovery.branches));
    assert.equal(typeof recovery.pending, 'boolean');
    assert.equal(recovery.corruption, null);

    const repairedCell = stoppedState.state.cells.find((cell) => cell.id === longCell.id);
    assert.ok(repairedCell);
    const repaired = await effect(firstAgents[0], 'edit_cell', {
      expectedDocumentRevision: stoppedState.state.documentRevision,
      cell: repairedCell.id,
      body: ['x + 2'],
      type: repairedCell.type,
      expectedRevision: repairedCell.revision,
    });
    assert.equal(repaired.raw.isError, false, JSON.stringify(redact(repaired.raw)));
    assert.equal(repaired.admission.commandSequence, 3);
    assert.equal(repaired.admission.nextCommandSequence, 4);

    const readyToRerun = await notebookState(firstAgents[1]);
    assert.equal((await readCell(firstAgents[1], longCell.id)).cell.body[0], 'x + 2');
    const rerun = await effect(firstAgents[1], 'run_cell', {
      expectedDocumentRevision: readyToRerun.state.documentRevision,
      cell: longCell.id,
      wait: true,
    });
    assert.equal(rerun.raw.isError, false, JSON.stringify(redact(rerun.raw)));
    assert.equal(rerun.admission.commandSequence, 3);
    assert.equal(rerun.admission.nextCommandSequence, 4);
    assert.equal(rerun.envelope.operation.status, 'done');
    assert.equal(typeof rerun.envelope.operation.runId, 'string');
    assert.notEqual(rerun.envelope.operation.runId, runId);
    assert.equal(rerun.envelope.result.value.runId, rerun.envelope.operation.runId);

    const settledState = await notebookState(firstAgents[1]);
    const settledCell = (await readCell(firstAgents[1], longCell.id)).cell;
    assert.ok(settledCell);
    assert.equal(settledCell.status, 'done');
    assert.match(JSON.stringify(settledCell.outputs), /43/);
    assert.equal(settledState.nextCommandSequence, 4);
    const authoritativePeer = await notebookState(firstAgents[0]);
    assert.equal(authoritativePeer.envelope.documentRevision, settledState.envelope.documentRevision);
    assert.deepEqual(authoritativePeer.state.cells, settledState.state.cells);
    assert.equal(authoritativePeer.nextCommandSequence, 4);

    await closeHttpAgents(first.origin, firstHttpAgents);
    firstHttpAgents = [];
    await closeAgents(firstAgents);
    firstAgents = [];
    await closeDesktop(firstDesktop);
    firstDesktop = undefined;
    await first.close();
    firstClosed = true;
    process.stderr.write('[mcp-couse] GUI-first agents and Electron closed\n');

    second = await createHarness(ctx, {
      id: 'mcp-couse-agent-first',
      source: [
        '# %%',
        'y <- 7',
        '# %%',
        'y + 5',
        '',
      ].join('\n'),
    });
    // Agent-first: both official SDK clients connect before the browser starts.
    secondAgents = await Promise.all([
      openAgent(ctx, second, 'mcp-couse-agent-first-a'),
      openAgent(ctx, second, 'mcp-couse-agent-first-b'),
    ]);
    process.stderr.write('[mcp-couse] agent-first agents connected\n');
    const agentFirstA = await notebookState(secondAgents[0]);
    const agentFirstB = await notebookState(secondAgents[1]);
    assert.equal(agentFirstA.nextCommandSequence, 1);
    assert.equal(agentFirstB.nextCommandSequence, 1);
    assert.equal(agentFirstA.envelope.epoch, second.registry.epoch);
    assert.equal(agentFirstB.envelope.epoch, agentFirstA.envelope.epoch);
    assert.equal(agentFirstA.state.runtime.kernelEpoch, agentFirstB.state.runtime.kernelEpoch);
    secondHttpAgents = [await openHttpAgent(second.origin, second.registry, 'mcp-couse-agent-first-http')];
    await assertCatalog([...secondAgents, ...secondHttpAgents]);
    const httpAgentFirst = await notebookState(secondHttpAgents[0]);
    assert.equal(httpAgentFirst.envelope.epoch, second.registry.epoch);
    assert.equal(httpAgentFirst.state.runtime.kernelEpoch, agentFirstA.state.runtime.kernelEpoch);
    assert.equal(httpAgentFirst.nextCommandSequence, 1);

    await waitForExecutionReady(second);
    secondDesktop = await openDesktop(ctx, second, 'mcp-couse-electron-agent-first', 'y <- 7');
    const browserAfterMcpStartup = await browserDump(second.origin, await second.mintTicket(), join(ctx.evidence, 'browser-mcp-couse'), 'y <- 7');
    assert.match(browserAfterMcpStartup, /y\s*<-\s*7/);
    const agentCell = agentFirstA.state.cells[0];
    assert.ok(agentCell?.id);
    const changed = await effect(secondAgents[1], 'edit_cell', {
      expectedDocumentRevision: agentFirstA.state.documentRevision,
      cell: agentCell.id,
      body: ['y <- 8'],
      type: agentCell.type,
      expectedRevision: agentCell.revision,
    });
    assert.equal(changed.raw.isError, false, JSON.stringify(redact(changed.raw)));
    assert.equal(changed.admission.commandSequence, 1);
    assert.equal(changed.admission.nextCommandSequence, 2);
    const browserAfterAgents = await browserDump(second.origin, await second.mintTicket(), join(ctx.evidence, 'browser-mcp-couse'), 'y <- 8');
    assert.match(browserAfterAgents, /y\s*<-\s*8/);
    const finalState = await notebookState(secondAgents[0]);
    const finalPeerState = await notebookState(secondAgents[1]);
    assert.equal(finalState.envelope.epoch, second.registry.epoch);
    assert.equal(finalPeerState.envelope.epoch, finalState.envelope.epoch);
    assert.deepEqual((await readCell(secondAgents[0], agentCell.id)).cell.body, ['y <- 8']);
    assert.deepEqual(finalPeerState.state.cells, finalState.state.cells);
    assert.equal(finalState.nextCommandSequence, 1);
    assert.equal(finalPeerState.nextCommandSequence, 2);
    const httpFinal = await notebookState(secondHttpAgents[0]);
    assert.equal(httpFinal.envelope.epoch, finalState.envelope.epoch);
    assert.equal(httpFinal.envelope.documentRevision, finalState.envelope.documentRevision);
    assert.deepEqual(httpFinal.state.cells, finalState.state.cells);
    assert.equal(httpFinal.nextCommandSequence, 1);
    const secondDesktopState = await readDesktop(secondDesktop, 'y <- 8');
    if (secondDesktopState) {
      assert.equal(secondDesktopState.epoch, finalState.state.epoch);
      assert.equal(secondDesktopState.documentRevision, finalState.state.documentRevision);
      assert.equal(secondDesktopState.kernelEpoch, finalState.state.runtime.kernelEpoch);
      assert.equal(secondDesktopState.hostPid, second.registry.pid);
      assert.equal(secondDesktopState.hostStartIdentity, second.registry.startIdentity);
      assert.equal(secondDesktopState.processNonce, second.registry.processNonce);
      assert.equal(secondDesktopState.sessionKey, second.registry.sessionKey);
      assert.equal(secondDesktopState.continuityProof, second.registry.continuityProof);
      assert.equal(secondDesktopState.origin, second.registry.origin);
    }
    process.stderr.write('[mcp-couse] agent-first browser and Electron synchronized\n');

    return {
      id: 'mcp-couse',
      identity: {
        protocol: first.ready.protocol ?? 'alder-host-v2',
        guiFirst: {
          epoch: first.registry.epoch,
          pid: first.registry.pid,
          revision: settledState.state.cells[0].revision,
          kernelEpoch: settledState.state.runtime.kernelEpoch,
          runId,
          rerunId: rerun.envelope.operation.runId,
          sequences: { a: authoritativePeer.nextCommandSequence, b: settledState.nextCommandSequence },
        },
        agentFirst: {
          epoch: second.registry.epoch,
          pid: second.registry.pid,
          revision: finalState.state.cells[0].revision,
          kernelEpoch: finalState.state.runtime.kernelEpoch,
          sequences: { a: finalState.nextCommandSequence, b: finalPeerState.nextCommandSequence },
        },
        electron: firstDesktopState && secondDesktopState ? {
          electron: ctx.manifest.runtimes.electron,
          chromium: ctx.manifest.runtimes.chromium,
          guiFirst: firstDesktopState,
          agentFirst: secondDesktopState,
        } : null,
        http: {
          sessionIsolation: true,
          guiFirstClients: firstHttpAgents.length,
          agentFirstClients: secondHttpAgents.length,
        },
        staleWrite: stale.envelope.error.code,
        stop: stoppedOperation.error.code,
      },
    };
  } finally {
    await cleanupScenarioResources(
      () => closeHttpAgents(first.origin, firstHttpAgents),
      () => closeDesktop(firstDesktop),
      () => closeAgents(firstAgents),
      () => !firstClosed ? first.close() : undefined,
      () => second ? closeHttpAgents(second.origin, secondHttpAgents) : undefined,
      () => closeDesktop(secondDesktop),
      () => closeAgents(secondAgents),
      () => second?.close(),
    );
  }
}

async function openAgent(ctx, harness, name) {
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const cwd = resolve(ctx.evidence, 'mcp-agents', name);
  const runtimeData = resolve(harness.dataHome);
  await mkdir(cwd, { recursive: true });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ['mcp', harness.notebook],
    cwd,
    env: sanitizedEnvironment({
      HOME: cwd,
      XDG_CONFIG_HOME: join(cwd, 'config'),
      XDG_DATA_HOME: runtimeData,
    }),
    stderr: 'pipe',
    maxBufferSize: 16 * 1024 * 1024,
  });
  const client = new Client({ name, version: 'smoke' });
  let stderr = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', value => { stderr = (stderr + value).slice(-65_536); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(name + ' connect failed: ' + (error?.message ?? error) + '; stderr=' + stderr, { cause: error }); }
  return { name, client, transport, nextCommandSequence: null, operationCounter: 0 };
}

async function openHttpAgent(origin, registry, name) {
  const session = await openSession(origin, registry);
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', origin);
      headers.set('Authorization', 'Bearer ' + registry.token);
      headers.set('X-Alder-Lease-Id', session.leaseId);
      headers.set('X-Alder-Client-Id', session.clientId);
      return fetchLogicalOrigin(input, { ...init, headers });
    },
  });
  const client = new Client({ name, version: 'smoke' });
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await cleanupScenarioResources(() => transport.close(), () => releaseLease(origin, session));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], name + ' HTTP connect cleanup failed');
    }
    throw new Error(name + ' HTTP connect failed: ' + (error?.message ?? error), { cause: error });
  }
  return { name, client, transport, session, token: registry.token, nextCommandSequence: null, operationCounter: 0 };
}

async function assertHttpSessionIsolation(origin, first, second) {
  const firstSessionId = first.transport.sessionId;
  const secondSessionId = second.transport.sessionId;
  assert.equal(typeof firstSessionId, 'string');
  assert.equal(typeof secondSessionId, 'string');
  assert.notEqual(firstSessionId, secondSessionId);
  const response = await fetchLogicalOrigin(new URL('/mcp', origin), {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: 'Bearer ' + second.token,
      'X-Alder-Lease-Id': second.session.leaseId,
      'X-Alder-Client-Id': second.session.clientId,
      'MCP-Session-Id': firstSessionId,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cross-session', method: 'ping', params: {} }),
  });
  try {
    assert.equal(response.status, 403);
  } finally {
    await response.arrayBuffer();
  }
}

async function closeHttpAgents(origin, agents) {
  await cleanupScenarioResources(...agents.map(({ client, transport, session }) => (
    () => cleanupScenarioResources(() => client.close(), () => transport.close(), () => releaseLease(origin, session))
  )));
}

async function assertCatalog(agents) {
  for (const agent of agents) {
    const tools = await agent.client.listTools();
    assert.deepEqual(new Set(tools.tools.map((tool) => tool.name)), EXPECTED_TOOLS);
  }
}

async function closeAgents(agents) {
  await cleanupScenarioResources(...agents.map(({ client, transport }) => (
    () => cleanupScenarioResources(() => client.close(), () => transport.close())
  )));
}
async function browserDump(origin, ticket, cwd, expected) {
  await mkdir(cwd, { recursive: true });
  const executable = process.env.CHROME_PATH ?? 'google-chrome';
  const profile = join(cwd, 'profile-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  await mkdir(profile, { recursive: true });
  const child = spawnSmokeProcess(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, origin + '/#ticket=' + encodeURIComponent(ticket),
  ], { cwd, env: sanitizedEnvironment({ HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data') }), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-65_536); });
  let cdp;
  try {
    const port = await waitForDebugPort(child, () => stderr);
    let target;
    const targetDeadline = Date.now() + 20_000;
    while (!target) {
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
      target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl);
      if (Date.now() >= targetDeadline) throw new Error('browser_cdp_timeout: no page target');
      if (!target) await delay(100);
    }
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const deadline = Date.now() + 30_000;
    for (;;) {
      const view = await cdp.evaluate("(() => ({ text: document.querySelector('#notebook')?.textContent ?? '', html: document.documentElement.outerHTML, error: document.querySelector('#status')?.classList.contains('poll-error') ? document.querySelector('#status')?.textContent : null }))()");
      if (view.text.includes(expected)) return view.text;
      if (Date.now() >= deadline) throw new Error('browser_render_timeout: expected ' + expected + '; status=' + (view.error ?? 'pending'));
      await delay(100);
    }
  } finally {
    await cleanupScenarioResources(() => cdp?.close(), () => stopChild(child));
  }
}

async function openDesktop(ctx, harness, label, expected) {
  if (ctx.manifest.kind !== 'desktop') return null;
  const entry = join(ctx.applicationRoot, ctx.manifest.resources.electronEntry);
  const cwd = join(ctx.evidence, label);
  const profile = join(cwd, 'profile');
  await mkdir(profile, { recursive: true });
  const rscript = await requireAbsoluteRscript(ctx.rscript, 'MCP desktop Rscript');
  const child = spawnSmokeProcess(entry, [
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--disable-gpu',
    '--rscript', rscript,
    harness.notebook,
  ], {
    cwd,
    env: sanitizedEnvironment({
      HOME: cwd,
      XDG_CONFIG_HOME: join(cwd, 'config'),
      XDG_CACHE_HOME: join(cwd, 'cache'),
      XDG_DATA_HOME: resolve(harness.dataHome),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { output = (output + value).slice(-65_536); });
  child.stderr.on('data', value => { output = (output + value).slice(-65_536); });
  try {
    const port = await waitForDebugPort(child, () => output);
    const deadline = Date.now() + 20_000;
    let target;
    while (!target) {
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
      target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/.test(value.url ?? ''));
      if (Date.now() >= deadline) throw new Error('electron_cdp_timeout: no authenticated renderer target; output=' + output);
      if (!target) await delay(100);
    }
    const cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    const hostProcess = await observeElectronHost(ctx, child);
    assert.equal(hostProcess.pid, harness.registry.pid, 'Electron descendant host PID must match the authenticated registry');
    assert.equal(hostProcess.startIdentity, harness.registry.startIdentity, 'Electron descendant host identity must match the authenticated registry');
    const desktop = { child, cdp, entry, hostProcess };
    await cdp.send('Runtime.enable');
    await readDesktop(desktop, expected);
    return desktop;
  } catch (error) {
    await closeDesktop({ child });
    throw error;
  }
}

async function observeElectronHost(ctx, child) {
  const rootStartIdentity = await processStartIdentity(child.pid);
  assert.equal(typeof rootStartIdentity, 'string', 'Electron process start identity is unavailable');
  const nodeExecutable = await realpath(join(ctx.applicationRoot, ctx.manifest.resources.nodeExecutable));
  const hostEntry = await realpath(join(ctx.applicationRoot, ctx.manifest.resources.hostEntry));
  const hostEntryName = basename(hostEntry);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const tree = await captureProcessTree(child.pid, rootStartIdentity);
    const candidates = tree.filter(record => {
      if ((record.depth ?? 0) < 1 || record.executable !== nodeExecutable) return false;
      const command = typeof record.command === 'string' ? record.command : '';
      const commandParts = command.split(/\s+/);
      return command.includes(hostEntry) || commandParts.some(part => part === hostEntry || part.endsWith('/' + hostEntryName) || part.endsWith('\\' + hostEntryName));
    });
    if (candidates.length > 1) throw new Error('electron_host_identity_ambiguous: ' + candidates.map(record => record.pid).join(','));
    if (candidates.length === 1) {
      const [candidate] = candidates;
      return { pid: candidate.pid, startIdentity: candidate.startIdentity, depth: candidate.depth ?? 0 };
    }
    if (Date.now() >= deadline) throw new Error('electron_host_identity_missing: ' + tree.map(record => record.command).join(' | '));
    await delay(100);
  }
}

async function readDesktop(desktop, expected) {
  if (!desktop) return null;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await desktop.cdp.evaluate(`(async () => {
      const snapshot = window.__alderHost?.client?.document?.snapshot;
      const response = await fetch('/api/identity', { credentials: 'same-origin' });
      const identity = response.ok ? await response.json().catch(() => null) : null;
      return {
        text: document.querySelector('#notebook')?.textContent ?? '',
        origin: location.origin,
        epoch: snapshot?.epoch ?? null,
        documentRevision: snapshot?.documentRevision ?? null,
        kernelEpoch: snapshot?.runtime?.kernelEpoch ?? null,
        identity,
      };
    })()`);
    const identity = state.identity;
    if (state.text.includes(expected) && typeof state.epoch === 'string' && Number.isSafeInteger(state.documentRevision)
      && identity?.protocol === 'alder-host-v2' && identity.epoch === state.epoch
      && identity.origin === state.origin && typeof identity.processNonce === 'string'
      && typeof identity.sessionKey === 'string' && typeof identity.continuityProof === 'string') {
      return {
        protocol: identity.protocol,
        epoch: state.epoch,
        documentRevision: state.documentRevision,
        kernelEpoch: state.kernelEpoch,
        origin: state.origin,
        processNonce: identity.processNonce,
        sessionKey: identity.sessionKey,
        continuityProof: identity.continuityProof,
        leaseId: identity.leaseId,
        clientId: identity.clientId,
        hostPid: desktop.hostProcess?.pid ?? null,
        hostStartIdentity: desktop.hostProcess?.startIdentity ?? null,
      };
    }
    if (Date.now() >= deadline) throw new Error('electron_render_timeout: expected ' + expected);
    await delay(100);
  }
}

async function closeDesktop(desktop) {
  if (!desktop) return;
  await cleanupScenarioResources(
    () => desktop.cdp?.close(),
    () => desktop.child ? stopChild(desktop.child) : undefined,
  );
}
async function waitForDebugPort(child, output, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const match = output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('browser_failed: ' + output());
    if (Date.now() >= deadline) throw new Error('browser_cdp_timeout: Chrome did not expose DevTools');
    await delay(100);
  }
}

class CdpSession {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    return new CdpSession(socket);
  }
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.code + ': ' + message.error.message));
      else pending.resolve(message.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
    return result.result?.value;
  }
  async close() { this.socket.close(); }
}

async function query(agent, name, args = {}) {
  let raw;
  try { raw = await agent.client.callTool({ name, arguments: args }); }
  catch (error) { throw new Error(agent.name + ' ' + name + ' failed: ' + (error?.message ?? error), { cause: error }); }
  return { raw, envelope: decodeTool(raw) };
}
async function notebookState(agent) {
  const response = await query(agent, 'notebook_state');
  const { envelope } = response;
  const state = envelope.result;
  assert.ok(state && typeof state === 'object' && !Array.isArray(state));
  assert.equal(state.epoch, envelope.epoch);
  assert.equal(state.documentRevision, envelope.documentRevision);
  assert.equal(state.cursor, envelope.cursor);
  const nextCommandSequence = state.nextCommandSequence;
  assert.equal(Number.isSafeInteger(nextCommandSequence) && nextCommandSequence > 0, true);
  if (agent.nextCommandSequence === null) agent.nextCommandSequence = nextCommandSequence;
  else assert.equal(nextCommandSequence, agent.nextCommandSequence);
  return { ...response, state, nextCommandSequence };
}
async function listCells(agent) {
  const response = await query(agent, 'list_cells');
  const cells = response.envelope.result;
  assert.ok(Array.isArray(cells));
  return { ...response, cells };
}
async function readCell(agent, id) {
  const response = await query(agent, 'read_cell', { cell: id });
  const cell = response.envelope.result;
  assert.ok(cell && typeof cell === 'object' && !Array.isArray(cell));
  return { ...response, cell };
}

async function effect(agent, name, args) {
  assert.ok(args && typeof args === 'object' && !Array.isArray(args));
  assert.equal(args.operationId, undefined);
  assert.equal(args.commandSequence, undefined);
  const operationId = `${agent.name}-operation-${++agent.operationCounter}`;
  const commandSequence = agent.nextCommandSequence;
  assert.equal(Number.isSafeInteger(commandSequence) && commandSequence > 0, true, `${agent.name} has no sequence state`);
  let raw;
  try { raw = await agent.client.callTool({
    name,
    arguments: { ...args, operationId, commandSequence },
  }); } catch (error) { throw new Error(agent.name + ' ' + name + ' failed: ' + (error?.message ?? error), { cause: error }); }
  const envelope = decodeTool(raw);
  const admission = envelope.result?.admission;
  assert.ok(admission && typeof admission === 'object' && !Array.isArray(admission), `effect ${name} omitted its admission`);
  assert.equal(admission.operationId, operationId);
  assert.equal(admission.commandSequence, commandSequence);
  assert.equal(Number.isSafeInteger(admission.nextCommandSequence) && admission.nextCommandSequence > commandSequence, true);
  agent.nextCommandSequence = admission.nextCommandSequence;
  return { raw, envelope, admission, operationId, commandSequence };
}

async function waitForActiveRun(agent, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await notebookState(agent);
    if (typeof state.state.runtime.activeRunId === 'string' && state.state.runtime.activeRunId.length > 0) return state;
    if (Date.now() >= deadline) throw new Error('long MCP run did not become active');
    await delay(100);
  }
}

async function waitForOperation(agent, operationId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await query(agent, 'operation_status', { operation: operationId });
    const operation = response.envelope.result;
    assert.ok(operation && typeof operation === 'object' && !Array.isArray(operation));
    if (TERMINAL_OPERATIONS.has(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error(`operation ${operationId} did not settle`);
    await delay(100);
  }
}

function decodeTool(result) {
  const structured = result?.structuredContent;
  assert.ok(structured && typeof structured === 'object' && !Array.isArray(structured), `MCP tool returned no structuredContent: ${JSON.stringify(redact(result))}`);
  assert.equal(typeof structured.epoch, 'string', `MCP envelope has no epoch: ${JSON.stringify(redact(result))}`);
  assert.equal(Number.isSafeInteger(structured.documentRevision), true, `MCP envelope has no document revision: ${JSON.stringify(redact(result))}`);
  assert.equal(Number.isSafeInteger(structured.cursor), true, `MCP envelope has no cursor: ${JSON.stringify(redact(result))}`);
  const summary = result.content?.find((entry) => entry.type === 'text')?.text;
  assert.equal(typeof summary, 'string', `MCP tool returned no concise text summary: ${JSON.stringify(redact(result))}`);
  assert.equal(summary.trimStart().startsWith('{'), false, `MCP text summary must not carry JSON: ${summary}`);
  assert.ok(summary.length < 1_024, 'MCP text summary is not concise');
  return structured;
}
