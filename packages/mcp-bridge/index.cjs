const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { commandTypes, toolInputSchema, isCommandEnvelope, isCommandResult } = require('@vc-figma/protocol');

const host = '127.0.0.1';
// Figma 的 manifest networkAccess 只认 localhost 这种主机名(裸 IP 不行),所以面板里连的是
// ws://localhost:17349 —— 但服务只监听 127.0.0.1,Host 头会是 localhost:port。两个都放行,
// 仍然只接受回环地址上的连接。
const hostNames = ['127.0.0.1', 'localhost'];
const defaultPort = 17349;

async function startBridge({ port = defaultPort, token, timeoutMs = 15000, log = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Bridge token must be 64 lowercase hex digits.');
  const server = createServer((request, response) => {
    // 从 https 页面连本机端口时，浏览器可能先发 CORS / Private-Network-Access 预检。
    // 把方法、Host 和预检头记下来，才能分清「请求没到本机」和「到了但被拒」。
    log(`http ${request.method} ${request.url} host=${request.headers.host ?? '-'}`
      + (request.headers['access-control-request-private-network'] ? ' pna=1' : ''));
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    }).end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const pending = new Map();
  let peer;

  server.on('upgrade', (request, socket, head) => {
    const address = server.address();
    const expectedHost = host + ':' + address.port;
    const allowedHosts = new Set(hostNames.map((name) => name + ':' + address.port));
    let supplied;
    try {
      const url = new URL(request.url, 'http://' + expectedHost);
      if (allowedHosts.has(url.host) && url.pathname === '/') supplied = url.searchParams.get('token');
    } catch {
      // The authentication check handles malformed request targets.
    }
    const valid = allowedHosts.has(request.headers.host) && /^[a-f0-9]{64}$/.test(supplied ?? '')
      && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(token, 'hex'));
    if (!valid || peer) {
      log(`upgrade rejected host=${request.headers.host ?? '-'} validToken=${valid} peer=${Boolean(peer)}`);
      socket.end('HTTP/1.1 ' + (valid ? '409 Conflict' : '403 Forbidden') + '\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      peer = connection;
      connection.on('error', () => connection.terminate());
      connection.on('message', (message, binary) => {
        if (binary) return;
        let result;
        try { result = JSON.parse(message.toString()); } catch { return; }
        const waiter = pending.get(result?.commandId);
        if (!waiter) return;
        if (!isCommandResult(result, waiter.type)) {
          waiter.finish(new Error('Plugin returned an invalid command result.'));
          return;
        }
        waiter.finish(null, result);
      });
      connection.on('close', () => {
        peer = undefined;
        for (const waiter of pending.values()) {
          waiter.finish(new Error('Figma plugin disconnected. Reconnect and read the latest state before retrying.'));
        }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    send(command) {
      const connection = peer;
      if (connection?.readyState !== WebSocket.OPEN) throw new Error('Connect the Figma plugin panel first.');
      if (pending.size >= 50) throw new Error('Too many outstanding Figma commands.');
      if (pending.has(command.commandId)) throw new Error('This command is already awaiting a reply.');
      return new Promise((resolve, reject) => {
        function finish(error, result) {
          if (!pending.delete(command.commandId)) return;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(result);
        }
        const timer = setTimeout(() => finish(new Error(
          'Figma did not reply in time. Read the latest state before retrying the command.')), timeoutMs);
        pending.set(command.commandId, { type: command.type, finish });
        connection.send(JSON.stringify(command), (error) => {
          if (error) finish(error);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        peer?.terminate();
        sockets.close();
        server.close(resolve);
      });
    },
  };
}

const descriptions = {
  get_ordered_pins: 'Read the current Figma page pins in order, with optional anchored node context.',
  add_pin: 'Drop a new ordered pin on a layer (nodeId, else the current selection) with an instruction.',
  audit_visual: 'Audit the selected Figma nodes or current page for visual structure and registry issues.',
  update_text: 'Edit text on the pinned layer or its direct child and return a verified snapshot.',
  update_style: 'Edit supported visual properties on the pinned layer or its direct child.',
  update_layout: 'Edit supported geometry or Auto Layout properties on the pinned layer or its direct child.',
  update_pin_status: 'Update the pin badge and return the saved pin and remaining pending count.',
};

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.ok === false,
  };
}

function createMcpServer(bridge) {
  const server = new Server({ name: 'figma-ordered-pins', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: commandTypes.map((type) => ({
      name: type,
      description: descriptions[type],
      inputSchema: toolInputSchema(type),
      annotations: { readOnlyHint: type === 'get_ordered_pins' || type === 'audit_visual', openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const envelope = { ...params.arguments, type: params.name, commandId: randomUUID() };
    if (!isCommandEnvelope(envelope)) {
      return toolResult({ commandId: envelope.commandId, ok: false,
        error: { code: 'INVALID_PARAMS', httpStatus: 422, message: 'Invalid tool name or arguments.' } });
    }
    try {
      return toolResult(await bridge.send(envelope));
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  });
  return server;
}

async function run({ port = defaultPort, token = process.env.VC_FIGMA_BRIDGE_TOKEN } = {}) {
  const tokenProvided = token !== undefined;
  token ??= randomBytes(32).toString('hex');
  const bridge = await startBridge({ port, token });
  const mcp = createMcpServer(bridge);
  mcp.onclose = () => { void bridge.close(); };
  const transport = new StdioServerTransport();
  const closeOnInputEnd = () => { void mcp.close(); };
  process.stdin.once('end', closeOnInputEnd);
  try {
    await mcp.connect(transport);
    const tokenHint = tokenProvided ? 'using configured token' : 'paste this token into Figma: ' + token;
    process.stderr.write('Figma Ordered Pins listening on ' + host + ':' + bridge.port + ' (' + tokenHint + ')\n');
  } catch (error) {
    process.stdin.off('end', closeOnInputEnd);
    await bridge.close();
    throw error;
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { startBridge, createMcpServer, run };
