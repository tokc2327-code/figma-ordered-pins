const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const built = readFileSync(path.join(__dirname, 'dist/code.js'), 'utf8');

function fixture() {
  const nodes = new Map();
  const messages = [];
  const fontLoads = [];
  const mixed = Symbol('mixed');
  const undoStack = [];
  let stable = new Map();
  let serial = 0;
  let undos = 0;

  function make(type, parent) {
    const data = new Map();
    const node = {
      id: '1:' + ++serial, type, name: type, parent: null, children: [],
      x: 0, y: 0, width: 120, height: 48, fills: [], strokes: [],
      cornerRadius: 0, opacity: 1,
      get absoluteTransform() {
        const offset = this.parent?.absoluteTransform ?? [[1, 0, 0], [0, 1, 0]];
        return [[1, 0, this.x + offset[0][2]], [0, 1, this.y + offset[1][2]]];
      },
      get absoluteBoundingBox() {
        const transform = this.absoluteTransform;
        return { x: transform[0][2], y: transform[1][2], width: this.width, height: this.height };
      },
      resize(w, h) { this.width = w; this.height = h; },
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter((entry) => entry !== child);
        child.parent = this;
        this.children.push(child);
      },
      getPluginData(key) { return data.get(key) ?? ''; },
      setPluginData(key, value) { data.set(key, value); },
      data,
    };
    if (type === 'TEXT') Object.assign(node, {
      characters: '之前', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
    });
    if (type === 'FRAME') Object.assign(node, {
      layoutMode: 'NONE', itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    });
    parent?.appendChild(node);
    nodes.set(node.id, node);
    return node;
  }

  function record() {
    const properties = ['x', 'y', 'width', 'height', 'characters', 'fontSize', 'fontName',
      'opacity', 'fills', 'strokes', 'cornerRadius', 'itemSpacing'];
    return new Map([...nodes.values()].map((node) => [
      node, { values: properties.filter((property) => property in node)
        .map((property) => [property, node[property]]), data: new Map(node.data) },
    ]));
  }

  const page = make('PAGE');
  const otherPage = make('PAGE');
  page.selection = [];
  otherPage.selection = [];
  const frame = make('FRAME', page);
  const text = make('TEXT', frame);
  const deeper = make('RECTANGLE', text);
  const unrelated = make('RECTANGLE', page);
  const figma = {
    mixed, currentPage: page, root: { name: 'Mock' },
    showUI() {}, on() {}, notify() {},
    ui: { postMessage(message) { messages.push(message); } },
    async getNodeByIdAsync(id) { return nodes.get(id); },
    async loadFontAsync(font) { fontLoads.push(font); },
    createFrame() { return make('FRAME', figma.currentPage); },
    createText() { return make('TEXT', figma.currentPage); },
    commitUndo() { undoStack.push(stable); stable = record(); },
    triggerUndo() {
      undos++;
      for (const [node, state] of stable) {
        for (const [name, value] of state.values) node[name] = value;
        node.data.clear();
        for (const [key, value] of state.data) node.data.set(key, value);
      }
    },
  };
  stable = record();
  const sandbox = vm.createContext({ figma, __html__: '' });
  vm.runInContext(built, sandbox);
  let commandNumber = 0;
  return {
    figma, fontLoads, frame, text, deeper, unrelated, page, otherPage, nodes, undoStack,
    get undos() { return undos; },
    async add(node, instruction = '调整图层') {
      page.selection = [node];
      await figma.ui.onmessage({ type: 'ordered-pin-add', instruction });
      return structuredClone(messages.at(-1));
    },
    async command(type, payload, pin, options = {}) {
      const envelope = { type, payload, participantId: 'agent:test', commandId: 'req' + ++commandNumber };
      if (pin) Object.assign(envelope, { pinId: pin.pinId, expectedVersion: pin.version });
      await figma.ui.onmessage({ type: 'ordered-pin-command', envelope: { ...envelope, ...options } });
      return structuredClone(messages.at(-1).result);
    },
  };
}

test('创建画布图钉，按页面和顺序返回低噪上下文，删除目标后标记孤立', async () => {
  const f = fixture();
  const first = await f.add(f.frame);
  const second = await f.add(f.text, '改标题');
  assert.equal(first.type, 'ordered-pin-added');
  assert.equal(second.pin.order, 2);
  assert.equal(f.nodes.get(second.pin.pinNodeId).parent.name, '__VC_Pins__');
  const read = await f.command('get_ordered_pins', {});
  assert.deepEqual(read.data.map((row) => row.pin.order), [1, 2]);
  assert.equal(read.data[0].context.childrenSummary[0].nodeId, f.text.id);
  assert.equal(read.data[1].context.text.characters, '之前');
  f.nodes.delete(f.text.id);
  const orphan = await f.command('get_ordered_pins', { includeContext: false });
  assert.deepEqual(orphan.data.map((row) => [row.context, row.orphaned]), [[undefined, undefined], [undefined, true]]);
  f.figma.currentPage = f.otherPage;
  assert.deepEqual((await f.command('get_ordered_pins', {})).data, []);
});

test('混排字体预加载，只修改直接子文字并回读，重复命令无副作用', async () => {
  const f = fixture();
  const { pin } = await f.add(f.frame);
  f.text.fontName = f.figma.mixed;
  f.text.getRangeAllFontNames = () => [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Medium' }];
  const payload = { nodeId: f.text.id, characters: '新标题', fontSize: 24, fontStyle: 'Semi Bold' };
  const result = await f.command('update_text', payload, pin, { commandId: 'duplicate' });
  assert.equal(result.ok, true);
  assert.equal(result.newVersion, 2);
  assert.equal(result.data.text.characters, '新标题');
  assert.equal(result.data.text.fontStyle, 'Semi Bold');
  assert.deepEqual(f.fontLoads.map((font) => font.style), ['Bold', 'Regular', 'Medium', 'Semi Bold']);
  const replay = await f.command('update_text', { ...payload, nodeId: f.text.id }, pin, { commandId: 'duplicate' });
  assert.deepEqual(replay, result);
  assert.equal(f.undoStack.length, 2);
  assert.equal((await f.command('update_text', { ...payload, characters: '覆盖' }, pin,
    { commandId: 'duplicate' })).error.code, 'INVALID_PARAMS');
});

test('越界、过期、缺失版本和丢失锚点均阻止写入', async () => {
  const f = fixture();
  const { pin } = await f.add(f.frame);
  for (const node of [f.deeper, f.unrelated, f.nodes.get(pin.pinNodeId)]) {
    const denied = await f.command('update_style', { nodeId: node.id, opacity: 0 }, pin);
    assert.equal(denied.error.code, 'SCOPE_DENIED');
    assert.equal(node.opacity, 1);
  }
  const payload = { nodeId: f.frame.id, opacity: 0.5 };
  assert.equal((await f.command('update_style', payload, pin, { expectedVersion: undefined })).error.code, 'INVALID_PARAMS');
  assert.equal((await f.command('update_style', payload, pin, { expectedVersion: 2 })).error.code, 'VERSION_CONFLICT');
  f.nodes.delete(f.frame.id);
  assert.equal((await f.command('update_style', payload, pin)).error.code, 'ANCHOR_NOT_FOUND');
});

test('并发写入相同版本时仅一次生效，样式保留其他画笔及未设置字段', async () => {
  const f = fixture();
  const { pin } = await f.add(f.frame);
  const gradient = { type: 'GRADIENT_LINEAR' };
  f.frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.6 }, gradient];
  const payload = { nodeId: f.frame.id, fillHex: '#1a73e8', cornerRadius: 12 };
  const [a, b] = await Promise.all([
    f.command('update_style', payload, pin),
    f.command('update_style', { ...payload, opacity: 0 }, pin),
  ]);
  assert.equal(a.data.style.fillHex, '#1A73E8');
  assert.equal(a.data.style.cornerRadius, 12);
  assert.equal(b.error.code, 'VERSION_CONFLICT');
  assert.equal(f.frame.fills[0].opacity, 0.6);
  assert.equal(f.frame.fills[1], gradient);
  assert.equal(f.frame.opacity, 1);
});

test('位置尺寸与 Auto Layout 部分内边距写后回读', async () => {
  const f = fixture();
  const { pin } = await f.add(f.frame);
  let result = await f.command('update_layout', { nodeId: f.frame.id, itemSpacing: 24 }, pin);
  assert.equal(result.error.httpStatus, 422);
  Object.assign(f.frame, { layoutMode: 'VERTICAL', paddingRight: 10 });
  result = await f.command('update_layout',
    { nodeId: f.frame.id, width: 200, x: -10, itemSpacing: 24, padding: { left: 16 } }, pin);
  assert.equal(result.data.bounds.width, 200);
  assert.equal(result.data.bounds.x, -10);
  assert.equal(result.data.layout.itemSpacing, 24);
  assert.deepEqual(result.data.layout.padding, { top: 0, right: 10, bottom: 0, left: 16 });
  result = await f.command('update_layout', { nodeId: f.text.id, x: 10 }, { ...pin, version: result.newVersion });
  assert.equal(result.error.code, 'INVALID_PARAMS');
});

test('状态持久化，完成状态同步为绿色和勾号，返回剩余 pending 数', async () => {
  const f = fixture();
  const { pin } = await f.add(f.frame);
  await f.add(f.text);
  let result = await f.command('update_pin_status', { pinId: pin.pinId, status: 'failed', note: '稍后重试' }, pin);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.pin.lastError, '稍后重试');
  result = await f.command('update_pin_status', { pinId: pin.pinId, status: 'done' }, result.data.pin);
  assert.equal(result.data.pin.lastError, undefined);
  assert.equal(result.data.pendingCount, 1);
  const marker = f.nodes.get(pin.pinNodeId);
  assert.equal(marker.children[0].characters, '#1 · 调整图层 ✓');
  assert.equal(Math.round(marker.fills[0].color.g * 255), 128);
  const read = await f.command('get_ordered_pins', { statusFilter: ['done'] });
  assert.deepEqual(read.data.map((row) => row.pin.version), [3]);
});

test('字体加载失败与等待期间跨页均拒绝写入', async () => {
  const f = fixture();
  const { pin } = await f.add(f.text);
  f.figma.loadFontAsync = async () => { throw new Error('404 from mock'); };
  const payload = { nodeId: f.text.id, characters: '禁止' };
  assert.equal((await f.command('update_text', payload, pin)).error.code, 'FONT_LOAD_FAILED');
  f.figma.loadFontAsync = async () => { f.figma.currentPage = f.otherPage; };
  assert.equal((await f.command('update_text', payload, pin)).error.code, 'SCOPE_DENIED');
  assert.equal(f.text.characters, '之前');
});

test('多属性操作中途失败时撤回修改并保留版本', async () => {
  const f = fixture();
  const { pin } = await f.add(f.frame);
  Object.defineProperty(f.frame, 'opacity', {
    configurable: true, get: () => 1, set(value) { if (value !== 1) throw new Error('mock failure'); },
  });
  const failed = await f.command('update_style', { nodeId: f.frame.id, cornerRadius: 10, opacity: 0.5 }, pin);
  assert.equal(failed.error.code, 'WRITE_FAILED');
  assert.equal(f.undos, 1);
  assert.equal(f.frame.cornerRadius, 0);
  const read = await f.command('get_ordered_pins', {});
  assert.equal(read.data[0].pin.version, 1);
});

test('agent 走桥接的 add_pin：给 nodeId 打在那层，不给用选区，同一 commandId 幂等', async () => {
  const f = fixture();
  const byId = await f.command('add_pin', { instruction: '把这层改成蓝色', nodeId: f.text.id });
  assert.equal(byId.ok, true);
  assert.equal(byId.data.anchor.nodeId, f.text.id);
  assert.equal(byId.data.order, 1);
  assert.equal(byId.data.status, 'pending');
  assert.equal(byId.newVersion, undefined);

  // 桥接重发同一条命令（同 commandId）不应再打一个点
  const replay = await f.command('add_pin', { instruction: '把这层改成蓝色', nodeId: f.text.id },
    null, { commandId: 'req1' });
  assert.deepEqual(replay, byId);
  assert.equal(f.nodes.get(byId.data.pinNodeId).parent.children.length, 1);

  f.page.selection = [f.frame];
  const fromSelection = await f.command('add_pin', { instruction: '改标题' });
  assert.equal(fromSelection.data.anchor.nodeId, f.frame.id);
  assert.equal(fromSelection.data.order, 2);

  const missing = await f.command('add_pin', { instruction: '改标题', nodeId: '9:9' });
  assert.equal(missing.error.code, 'ANCHOR_NOT_FOUND');
});

test('插件面板把桥接命令和回执双向透传，并提交本地落点', () => {
  const scripts = [...readFileSync(path.join(__dirname, 'ui.html'), 'utf8')
    .matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const posted = [];
  const received = [];
  const elements = new Map();
  const listeners = {};
  let socket;
  class TestSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.listeners = {};
      socket = this;
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    send(message) { received.push(JSON.parse(message)); }
  }
  const document = {
    getElementById(id) {
      const element = { value: '', addEventListener(name, listener) { this[name] = listener; } };
      elements.set(id, element);
      return element;
    },
  };
  const parent = { postMessage(message) { posted.push(structuredClone(message.pluginMessage)); } };
  const window = { addEventListener(name, listener) { listeners[name] = listener; } };
  vm.runInNewContext(scripts[1][1], { document, parent, window, WebSocket: TestSocket });
  // 面板一打开就问主线程要存过的令牌（拿回来会自动连）
  assert.deepEqual(posted.at(-1), { type: 'bridge-token-get' });
  const tokenField = elements.get('bridge-token');
  tokenField.value = 'a'.repeat(64);
  elements.get('bridge-connect').click();
  assert.match(socket.url, /^ws:\/\/localhost:17349\//);
  socket.readyState = TestSocket.OPEN;
  socket.listeners.open();
  assert.equal(tokenField.value, '');
  assert.equal(elements.get('bridge-status').textContent, '已连接');
  // 连上后令牌落进 clientStorage，下次打开面板就不用再粘
  assert.deepEqual(posted.find((message) => message.type === 'bridge-token-set'),
    { type: 'bridge-token-set', token: 'a'.repeat(64) });
  const envelope = { type: 'get_ordered_pins', payload: {} };
  socket.listeners.message({ data: JSON.stringify(envelope) });
  assert.deepEqual(posted.pop(), { type: 'ordered-pin-command', envelope });

  const result = { commandId: '1', ok: true, data: [] };
  const event = { data: { pluginMessage: { type: 'ordered-pin-result', result } } };
  // 宿主派发插件消息时不一定带 source（线上实测 source 不是 parent），所以不再按 source 过滤。
  listeners.message(event);
  assert.deepEqual(received, [result]);

  elements.get('pin-instruction').value = '改标题';
  elements.get('pin-form').submit({ preventDefault() {} });
  assert.deepEqual(posted.pop(), { type: 'ordered-pin-add', instruction: '改标题' });
  listeners.message({ source: parent, data: { pluginMessage: { type: 'ordered-pin-added', pin: { order: 1 } } } });
  assert.equal(elements.get('pin-status').textContent, '已添加 #1');
});
