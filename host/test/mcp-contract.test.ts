import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { connectMcpStdio, createMcpServer, drainMcpServer, type McpControllerAdapter } from '../src/mcp.js';
import type { HostSnapshot, OperationRecord } from '../src/protocol.js';

async function wire(adapter: McpControllerAdapter) {
  const input = new PassThrough(), output = new PassThrough();
  const messages: any[] = [];
  let buffered = '';
  output.on('data', bytes => {
    buffered += String(bytes);
    for (;;) {
      const at = buffered.indexOf('\n');
      if (at < 0) break;
      messages.push(JSON.parse(buffered.slice(0, at)));
      buffered = buffered.slice(at + 1);
    }
  });
  const server = createMcpServer({ controller: adapter });
  const transport = await connectMcpStdio(server, { input, output });
  const send = (method: string, params: unknown, id?: number) => input.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n');
  const response = async (id: number) => {
    const deadline = Date.now() + 2000;
    while (!messages.some(message => message.id === id)) {
      if (Date.now() > deadline) throw new Error(`Missing MCP response ${id}`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    return messages.find(message => message.id === id);
  };
  send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract', version: '1' } }, 1);
  await response(1);
  send('notifications/initialized', {});
  return { send, response, messages, transport, drain: () => drainMcpServer(server), close: async () => { await server.close(); input.destroy(); output.destroy(); } };
}

function adapter(): McpControllerAdapter {
  return { snapshot: () => ({ epoch: 'epoch', cells: [], version: 0 } as unknown as HostSnapshot),
    dispatch: async command => ({ operation: { id: command.operationId, kind: 'run', status: 'done', acceptedAt: 0, settledAt: 1 }, version: 0, cursor: 0 }),
    awaitOperation: async id => ({ id, kind: 'run', status: 'done', acceptedAt: 0, settledAt: 1 }) };
}

test('MCP preserves pipelined action settlement and effectful notification ordering', { timeout: 5000 }, async () => {
  const controller = adapter();
  let effects = 0;
  controller.snapshot = () => ({ epoch: 'epoch', cells: [], version: effects } as unknown as HostSnapshot);
  controller.dispatch = async command => {
    await new Promise(resolve => setImmediate(resolve));
    effects++;
    return { operation: { id: command.operationId, kind: 'run', status: 'done', acceptedAt: 0, settledAt: 1 }, version: effects, cursor: 0 };
  };
  const client = await wire(controller);
  try {
    client.send('tools/call', { name: 'run_all', arguments: {} }, 2);
    client.send('tools/call', { name: 'notebook_state', arguments: {} }, 3);
    assert.equal(JSON.parse((await client.response(3)).result.content[0].text).version, 1);
    client.send('tools/call', { name: 'run_all', arguments: {} });
    client.send('tools/call', { name: 'notebook_state', arguments: {} }, 4);
    assert.equal(JSON.parse((await client.response(4)).result.content[0].text).version, 2);
    assert.deepEqual(client.messages.map(message => message.id), [1, 2, 3, 4]);
  } finally { await client.close(); }
});

test('MCP waits for configured startup settlement before accepting normal requests', { timeout: 5000 }, async () => {
  const controller = adapter();
  let settled = false;
  controller.activateStartup = async () => ({ id: 'startup', kind: 'run', status: 'accepted', acceptedAt: 0 });
  controller.awaitOperation = async id => {
    await new Promise(resolve => setImmediate(resolve));
    settled = true;
    return { id, kind: 'run', status: 'done', acceptedAt: 0, settledAt: 1 };
  };
  controller.snapshot = () => ({ epoch: 'epoch', cells: [], version: Number(settled) } as unknown as HostSnapshot);
  const client = await wire(controller);
  try {
    client.send('tools/call', { name: 'notebook_state', arguments: {} }, 2);
    await client.drain();
    assert.equal(JSON.parse((await client.response(2)).result.content[0].text).version, 1);
  } finally { await client.close(); }
});

test('MCP rejects malformed tool envelopes before effects and handles shutdown', { timeout: 5000 }, async () => {
  let effects = 0;
  const controller = adapter();
  const dispatch = controller.dispatch;
  controller.dispatch = command => { effects++; return dispatch(command); };
  const client = await wire(controller);
  try {
    let id = 2;
    for (const params of [{ name: 'absent', arguments: {} }, { name: '', arguments: {} },
      { name: 'run_all', arguments: [] }, { name: 'run_all', arguments: null },
      { name: 'run_all', arguments: 1 }, { arguments: {} }]) {
      client.send('tools/call', params, id);
      assert.equal((await client.response(id++)).error?.code, -32602);
    }
    assert.equal(effects, 0);
    for (const params of [[], false, null, { unexpected: true }]) {
      client.send('ping', params, id);
      assert.equal((await client.response(id++)).error?.code, -32602);
    }
    client.send('shutdown', {}, 21);
    assert.deepEqual((await client.response(21)).result, {});
  } finally { await client.close(); }
});

test('MCP Stop can interrupt an earlier action awaiting kernel settlement', { timeout: 5000 }, async () => {
  const controller = adapter();
  let finish!: (value: OperationRecord) => void;
  let runningId = '';
  const running = new Promise<OperationRecord>(resolve => { finish = resolve; });
  controller.dispatch = async command => {
    if (command.type === 'run') runningId = command.operationId;
    if (command.type === 'interrupt') finish({ id: runningId, kind: 'run', status: 'cancelled', acceptedAt: 0, settledAt: 1 });
    return { operation: { id: command.operationId, kind: command.type === 'run' ? 'run' : 'interrupt', status: 'running', acceptedAt: 0 }, version: 0, cursor: 0 };
  };
  controller.awaitOperation = async id => id === runningId ? running : ({ id, kind: 'interrupt', status: 'done', acceptedAt: 0, settledAt: 1 });
  const client = await wire(controller);
  try {
    client.send('tools/call', { name: 'run_all', arguments: {} }, 2);
    await new Promise(resolve => setImmediate(resolve));
    client.send('tools/call', { name: 'interrupt', arguments: {} }, 3);
    assert.equal((await client.response(3)).result.isError, false);
    assert.equal((await client.response(2)).result.isError, true);
  } finally {
    finish({ id: runningId, kind: 'run', status: 'cancelled', acceptedAt: 0, settledAt: 1 });
    await client.close();
  }
});
