import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { connectRemoteController, type RemoteController } from '../src/remote.js';
import type { startHost } from '../src/main.js';

for (const mode of ['local', 'url'] as const) test(`installed ${mode} MCP shares source, value freshness and causal widget settlement`, {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alder-mcp-installed-'));
  const path = join(directory, 'notebook.R');
  const source = [
    '# header\r\n# %%\r\nlibrary(alder)',
    '# %%\nw <- ui$dictionary(slider = ui$slider(0, 10, value = 2), go = ui$run_button("Run"))\nw',
    '# %%\nresult <- w$value$slider * 10L\nresult',
    '# %%\npaste(w$value$go, "consumer")',
  ].join('\n');
  await writeFile(path, source);
  let app: Awaited<ReturnType<typeof startHost>> | undefined, remote: RemoteController | undefined;
  const client = new Client({ name: 'alder-contract', version: '1' });
  let server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const installed = await import(pathToFileURL(join(process.env.ALDER_R_PACKAGE!, 'host/alder-host.mjs')).href);
    app = await (installed.startHost as typeof startHost)({ path, port: 0, runOnStartup: false,
      executionMode: 'automatic', packagePath: process.env.ALDER_R_PACKAGE });
    remote = mode === 'url' ? await connectRemoteController(app.server.address()!.origin) : undefined;
    server = createMcpServer({ controller: remote ?? app.controller });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}, expectedError = false) => {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(Boolean(response.isError), expectedError, JSON.stringify(response));
      return JSON.parse((response.content as Array<{text: string}>)[0]!.text);
    };
    const readSource = async () => (await client.readResource({ uri: 'alder://notebook/source' })).contents[0]!.text;
    assert.equal(await readSource(), source);
    await call('run_all');
    assert.match(JSON.stringify((await call('get_value', { name: 'result' })).value), /20/);
    for (const value of [4, 6]) {
      const widget = await call('set_widget', { name: 'w', path: ['slider'], value });
      assert.equal(app.controller.operation(widget.operation_id)?.status, 'done');
      const state = await call('notebook_state');
      assert.equal(state.cells[2].outputs[0]?.text, `[1] ${value * 10}`, JSON.stringify(state));
      assert.equal(state.runtime.busy, false);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const button = await call('set_widget', { name: 'w', path: ['go'], value: true });
      assert.equal(app.controller.operation(button.operation_id)?.status, 'done');
      const state = await call('notebook_state');
      assert.match(state.cells[3].outputs[0].text, /TRUE consumer/);
      const reset = state.operations.find((operation: any) => operation.kind === 'widget-reset' && operation.status === 'done');
      assert.ok(reset, 'MCP must settle after the causal button reset');
    }
    const output = await client.readResource({ uri: 'alder://cell/cell-3/outputs' });
    assert.match(String(output.contents[0]!.text), /60/);
    await call('edit_cell', { cell: 'cell-2', type: 'code', expected_revision: 0,
      body: ['w <- ui$dictionary(slider = ui$slider(0, 10, value = 3), go = ui$run_button("Run"))', 'w'] });
    const stale = await call('get_value', { name: 'result' }, true);
    assert.equal(stale.error.code, 'stale_value');
    await call('run_stale');
    assert.match(JSON.stringify((await call('get_value', { name: 'result' })).value), /30/);
    const conflict = await call('edit_cell', { cell: 'cell-2', type: 'code', expected_revision: 0, body: ['w <- 99'] }, true);
    assert.equal(conflict.error.code, 'source_conflict');
    await call('save');
    assert.equal(await readSource(), await readFile(path, 'utf8'));
    await call('check');
  } finally {
    await client.close();
    await server?.close();
    await remote?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const ending of ['shutdown', 'eof', 'before-initialize'] as const) test(`installed R alder_mcp entry point preserves startup and pipe ownership on ${ending}`, {
  skip: !process.env.ALDER_R_PACKAGE, timeout: 45_000,
}, async () => {
  const { spawn } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'alder-mcp-pipe-'));
  const path = join(directory, 'notebook.R'), marker = join(directory, 'effect.txt');
  await writeFile(path, `# %%\ncat('tick\\n', file = ${JSON.stringify(marker)}, append = TRUE)\nSys.sleep(0.05)\n42\n`);
  const child = spawn(process.env.RSCRIPT ?? 'Rscript', ['--vanilla', '-e', [
    'library(alder, lib.loc = dirname(Sys.getenv("ALDER_R_PACKAGE")))',
    'alder_mcp(path = Sys.getenv("ALDER_TEST_NOTEBOOK"))',
  ].join('; ')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ALDER_TEST_NOTEBOOK: path },
  });
  const messages: any[] = [];
  let buffer = '', errors = '';
  child.stdout.on('data', bytes => {
    buffer += String(bytes);
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      messages.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  child.stderr.on('data', bytes => { errors += String(bytes); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const send = (method: string, params: unknown, id?: number) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }) + '\n');
  const response = async (id: number) => {
    const deadline = Date.now() + 30_000;
    while (!messages.some(message => message.id === id)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`MCP response ${id} missing: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return messages.find(message => message.id === id);
  };
  try {
    send('ping', {}, 1);
    assert.deepEqual((await response(1)).result, {});
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    if (ending === 'before-initialize') {
      child.stdin.end();
    } else {
      send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pipe', version: '1' } }, 2);
      await response(2);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      send('notifications/initialized', {});
      send('tools/call', { name: 'notebook_state', arguments: {} }, 3);
      if (ending === 'shutdown') send('shutdown', {}, 4);
      else child.stdin.end();
      const state = JSON.parse((await response(3)).result.content[0].text);
      assert.equal(state.cells[0].status, 'done');
      assert.equal(state.cells[0].outputs[0].text, '[1] 42');
      assert.equal(await readFile(marker, 'utf8'), 'tick\n');
      if (ending === 'shutdown') assert.deepEqual((await response(4)).result, {});
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP did not close its owned processes: ${errors}`)), 10_000);
      })]);
      assert.equal(status, 0, errors);
    } finally { clearTimeout(timer); }
    assert.equal(errors, '');
    assert.deepEqual(messages.map(message => message.id), ending === 'before-initialize' ? [1] : ending === 'shutdown' ? [1, 2, 3, 4] : [1, 2, 3]);
    if (ending === 'before-initialize') await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
