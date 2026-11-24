const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { startBridge } = require('./index.cjs');

const token = 'a'.repeat(64);
const command = { commandId: 'read-1', participantId: 'agent:local', type: 'get_ordered_pins', payload: {} };
const websocket = (port, password = token) => new WebSocket('ws://127.0.0.1:' + port + '/?token=' + password);

async function connect(port, password) {
  const socket = websocket(port, password);
  await once(socket, 'open');
  return socket;
}

async function makeBridge(t, options = {}) {
  const bridge = await startBridge({ port: 0, token, ...options });
  t.after(() => bridge.close());
  return bridge;
}

test('loopback upgrade requires a valid token and permits one active panel', async (t) => {
  const bridge = await makeBridge(t);
  await assert.rejects(connect(bridge.port, 'b'.repeat(64)), /403/);
  const first = await connect(bridge.port);
  await assert.rejects(connect(bridge.port), /409/);
  const closed = once(first, 'close');
  first.close();
  await closed;
  const next = await connect(bridge.port);
  assert.equal(next.readyState, WebSocket.OPEN);
});

test('panel may reach the bridge through the localhost hostname, as the plugin panel does', async (t) => {
  const bridge = await makeBridge(t);
  const socket = new WebSocket('ws://localhost:' + bridge.port + '/?token=' + token);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  socket.close();
  await closed;
});

test('loopback WebSocket correlates out-of-order responses by commandId', async (t) => {
  const bridge = await makeBridge(t);
  const socket = await connect(bridge.port);
  const requests = [];
  socket.on('message', (data) => {
    requests.push(JSON.parse(data));
    if (requests.length === 2) {
      for (const request of [...requests].reverse()) {
        socket.send(JSON.stringify({ commandId: request.commandId, ok: true, data: [] }));
      }
    }
  });
  const next = { ...command, commandId: 'read-2' };
  const replies = await Promise.all([bridge.send(command), bridge.send(next)]);
  assert.deepEqual(requests, [command, next]);
  assert.deepEqual(replies.map((result) => result.commandId), ['read-1', 'read-2']);
});

test('missing panel and panel disconnection surface actionable transport errors', async (t) => {
  const bridge = await makeBridge(t);
  assert.throws(() => bridge.send(command), /Connect the Figma plugin/);
  const socket = await connect(bridge.port);
  socket.on('message', () => socket.close());
  await assert.rejects(bridge.send(command), /disconnected/);
});

test('invalid readback is rejected and a silent peer times out', async (t) => {
  const bridge = await makeBridge(t, { timeoutMs: 80 });
  const socket = await connect(bridge.port);
  socket.once('message', () => socket.send(JSON.stringify({ commandId: command.commandId, ok: true })));
  await assert.rejects(bridge.send(command), /invalid command result/);
  await assert.rejects(bridge.send(command), /did not reply/);
});

test('real MCP stdio client lists seven tools and receives plugin readback through WebSocket', { timeout: 10000 }, async (t) => {
  const entry = path.join(__dirname, 'index.cjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-e', 'require(' + JSON.stringify(entry) + ').run({port:0}).catch(() => process.exit(1))'],
    // 继承当前环境再叠 token:SDK 传了 env 就整份替换,只剩 token 会丢掉 PATH、
    // 以及 Electron 二进制当 node 用时必需的 ELECTRON_RUN_AS_NODE → 子进程起来就退,
    // client.connect 报 "Connection closed"。这里要验的是「token 走环境变量」,不是「环境是空的」。
    env: { ...process.env, VC_FIGMA_BRIDGE_TOKEN: token },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  t.after(() => client.close());
  const started = once(transport.stderr, 'data');
  await client.connect(transport);
  const [line] = await started;
  const port = Number(line.toString().match(/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port > 0);
  assert.equal(line.toString().includes(token), false);
  const socket = await connect(port);
  const requests = [];
  socket.on('message', (data) => {
    const envelope = JSON.parse(data);
    requests.push(envelope);
    const result = envelope.type === 'get_ordered_pins'
      ? { commandId: envelope.commandId, ok: true, data: [] }
      : { commandId: envelope.commandId, ok: false,
        error: { code: 'SCOPE_DENIED', httpStatus: 403, message: 'mock scope guard' } };
    socket.send(JSON.stringify(result));
  });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name),
    ['get_ordered_pins', 'update_text', 'update_style', 'update_layout', 'update_pin_status', 'add_pin', 'audit_visual']);
  const participantId = 'agent:bridge-test';
  const read = await client.callTool({ name: command.type, arguments: { participantId, payload: {} } });
  assert.equal(read.structuredContent.ok, true);
  assert.deepEqual(JSON.parse(read.content[0].text), read.structuredContent);
  assert.match(requests[0].commandId, /^[0-9a-f-]{36}$/);
  assert.equal(requests[0].participantId, participantId);

  const invalid = await client.callTool({ name: 'update_style',
    arguments: { participantId, pinId: 'p1', payload: { nodeId: '1:2', opacity: 0.5 } } });
  assert.equal(invalid.structuredContent.error.code, 'INVALID_PARAMS');
  const denied = await client.callTool({ name: 'update_style',
    arguments: { participantId, pinId: 'p1', expectedVersion: 1, payload: { nodeId: '1:2', opacity: 0.5 } } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'SCOPE_DENIED');
  assert.equal(requests.length, 2);
});
