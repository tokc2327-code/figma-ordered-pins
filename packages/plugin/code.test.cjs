'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const directory = __dirname;
const pluginSource = readFileSync(join(directory, 'code.js'), 'utf8');

function makeNode(id, name, type, children = [], overrides = {}) {
  return {
    id,
    name,
    type,
    visible: true,
    absoluteBoundingBox: { x: 10, y: 20, width: 120, height: 48 },
    width: 120,
    height: 48,
    children,
    ...overrides,
  };
}

function makePage() {
  const rectangle = makeNode('3:1', '第三层矩形', 'RECTANGLE');
  const group = makeNode('2:1', '第二层编组', 'GROUP', [rectangle]);
  const frame = makeNode('1:1', '第一层画框', 'FRAME', [group]);
  const text = makeNode('1:2', '隐藏文本', 'TEXT', [], { visible: false });
  return makeNode('0:1', 'Page 1', 'PAGE', [frame, text], {
    absoluteBoundingBox: null,
    width: null,
    height: null,
    selection: [],
  });
}

function bootPlugin(page, extraFigmaProps = {}) {
  const messages = [];
  const listeners = {};
  let shownUi;
  const figma = {
    currentPage: page,
    root: { name: 'Test Document' },
    fileKey: 'testFileKey123',
    showUI(html, options) {
      shownUi = { html, options };
    },
    ui: {
      postMessage(message) {
        messages.push(message);
      },
    },
    on(eventName, listener) {
      listeners[eventName] = listener;
    },
    ...extraFigmaProps,
  };
  const context = vm.createContext({ figma, __html__: '<html>panel</html>' });
  vm.runInContext(pluginSource, context, { filename: 'code.js' });

  return {
    context,
    figma,
    listeners,
    messages,
    shownUi,
    lastPayload(type = 'layer-tree') {
      const message = messages.filter((m) => m.type === type).at(-1);
      assert.ok(message, `Expected message of type ${type}`);
      return type === 'layer-tree' ? JSON.parse(message.json) : message;
    },
    lastMessage(type) {
      return messages.filter((m) => m.type === type).at(-1);
    },
  };
}

test('启动时深度优先导出整页及所需几何字段', () => {
  const page = makePage();
  const plugin = bootPlugin(page);

  assert.equal(plugin.figma.skipInvisibleInstanceChildren, true);
  assert.equal(plugin.shownUi.html, '<html>panel</html>');
  assert.ok(plugin.messages.length >= 2);

  const payload = plugin.lastPayload('layer-tree');
  assert.equal(payload.version, 1);
  assert.equal(payload.scope, 'page');
  assert.deepEqual(payload.page, { id: '0:1', name: 'Page 1' });
  assert.deepEqual(payload.limits, { maxNodes: 5000, maxDepth: 50 });
  assert.equal(payload.nodeCount, 5);
  assert.equal(payload.truncated, false);

  const pageNode = payload.nodes[0];
  const frame = pageNode.children[0];
  const group = frame.children[0];
  const rectangle = group.children[0];
  assert.equal(rectangle.name, '第三层矩形');
  assert.equal(rectangle.width, 120);
  assert.equal(rectangle.height, 48);
  assert.deepEqual(rectangle.absoluteBoundingBox, {
    x: 10,
    y: 20,
    width: 120,
    height: 48,
  });
  assert.deepEqual(Object.keys(rectangle), [
    'id',
    'name',
    'type',
    'visible',
    'absoluteBoundingBox',
    'width',
    'height',
    'children',
  ]);
  assert.equal(pageNode.children[1].name, '隐藏文本');
  assert.equal(pageNode.children[1].visible, false);

  const targetMsg = plugin.lastMessage('selection-target');
  assert.ok(targetMsg);
  assert.equal(targetMsg.figmaTarget, null);
});

test('selectionchange 只推送轻量目标，不再自动导出完整子树', () => {
  const page = makePage();
  const plugin = bootPlugin(page);
  const treeCountBefore = plugin.messages.filter((m) => m.type === 'layer-tree').length;
  page.selection = [page.children[0]];

  plugin.listeners.selectionchange();
  assert.equal(plugin.messages.filter((m) => m.type === 'layer-tree').length, treeCountBefore);
  assert.equal(plugin.lastMessage('selection-target').figmaTarget.id, '1:1');
});

test('export-selection 消息只导出选中子树，空选择导出空数组', () => {
  const page = makePage();
  const plugin = bootPlugin(page);
  page.selection = [page.children[0]];

  plugin.figma.ui.onmessage({ type: 'export-selection' });
  const selected = plugin.lastPayload('layer-tree');
  assert.equal(selected.scope, 'selection');
  assert.equal(selected.nodeCount, 3);
  assert.equal(selected.nodes.length, 1);
  assert.equal(selected.nodes[0].name, '第一层画框');
  assert.equal(selected.nodes[0].children[0].children[0].name, '第三层矩形');

  page.selection = [];
  plugin.figma.ui.onmessage({ type: 'export-selection' });
  const empty = plugin.lastPayload('layer-tree');
  assert.equal(empty.scope, 'selection');
  assert.equal(empty.nodeCount, 0);
  assert.deepEqual(empty.nodes, []);
});

test('selection-target 准确导出选中目标元数据、多选列表与 Figma 链接', () => {
  const page = makePage();
  const plugin = bootPlugin(page);

  // 单选测试
  const targetNode = page.children[0]; // 第一层画框
  page.selection = [targetNode];
  plugin.listeners.selectionchange();

  const singleTargetMsg = plugin.lastMessage('selection-target');
  assert.ok(singleTargetMsg);
  const target = JSON.parse(JSON.stringify(singleTargetMsg.figmaTarget));
  assert.equal(target.id, '1:1');
  assert.equal(target.name, '第一层画框');
  assert.equal(target.type, 'FRAME');
  assert.deepEqual(target.absoluteBoundingBox, { x: 10, y: 20, width: 120, height: 48 });
  assert.equal(target.pageId, '0:1');
  assert.equal(target.pageName, 'Page 1');
  assert.equal(target.fileKey, 'testFileKey123');
  assert.equal(target.fileName, 'Test Document');
  assert.equal(target.link, 'https://www.figma.com/design/testFileKey123?node-id=1-1');
  assert.equal(target.nodes, undefined);

  // 多选测试
  page.selection = [page.children[0], page.children[1]];
  plugin.listeners.selectionchange();

  const multiTargetMsg = plugin.lastMessage('selection-target');
  const multiTarget = JSON.parse(JSON.stringify(multiTargetMsg.figmaTarget));
  assert.equal(multiTarget.id, '1:1');
  assert.equal(multiTarget.nodes.length, 2);
  assert.equal(multiTarget.nodes[0].id, '1:1');
  assert.equal(multiTarget.nodes[1].id, '1:2');
  assert.equal(multiTarget.nodes[1].name, '隐藏文本');

  // 取消选择
  page.selection = [];
  plugin.listeners.selectionchange();
  assert.equal(plugin.lastMessage('selection-target').figmaTarget, null);
});

test('节点预算截断时会停止遍历并标记总结果和截断位置', () => {
  const page = makePage();
  const plugin = bootPlugin(page);
  plugin.context.testRoots = [page];
  plugin.context.testLimits = { maxNodes: 2, maxDepth: 50 };

  const result = vm.runInContext('serializeTrees(testRoots, testLimits)', plugin.context);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.nodeLimitReached, true);
  assert.equal(result.nodes[0].children.length, 1);
  assert.equal(result.nodes[0].truncated, true);
  assert.equal(result.nodes[0].children[0].truncated, true);
  assert.ok(result.nodes[0].truncationReasons.includes('MAX_NODES'));
});

test('多根遍历在根边界耗尽预算时仍标记省略', () => {
  const plugin = bootPlugin(makePage());
  plugin.context.testRoots = [makeNode('1:1', '完整根', 'FRAME'), makeNode('2:1', '被省略根', 'FRAME')];
  plugin.context.testLimits = { maxNodes: 1, maxDepth: 50 };

  const result = vm.runInContext('serializeTrees(testRoots, testLimits)', plugin.context);
  assert.equal(result.nodeCount, 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].name, '完整根');
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.nodeLimitReached, true);
});

test('深度上限保留边界节点、省略其子节点并明确标记', () => {
  const page = makePage();
  const plugin = bootPlugin(page);
  plugin.context.testRoots = [page];
  plugin.context.testLimits = { maxNodes: 5000, maxDepth: 2 };

  const result = vm.runInContext('serializeTrees(testRoots, testLimits)', plugin.context);
  assert.equal(result.nodeCount, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.depthLimitReached, true);
  const frame = result.nodes[0].children[0];
  assert.equal(frame.name, '第一层画框');
  assert.deepEqual(Array.from(frame.children), []);
  assert.equal(frame.truncated, true);
  assert.ok(frame.truncationReasons.includes('MAX_DEPTH'));
});

test('manifest 指向实际入口，声明网络权限且 UI 脚本语法有效', () => {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.api, '1.0.0');
  assert.equal(manifest.main, 'dist/code.js');
  assert.equal(manifest.ui, 'ui.html');
  assert.deepEqual(manifest.editorType, ['figma']);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.equal(manifest.enablePrivatePluginApi, true);
  assert.deepEqual(manifest.networkAccess.allowedDomains, ['https://vcollab.tokc2327.workers.dev']);
  // 白名单按 scheme 匹配：http:// 那条只管 fetch，面板连 ws:// 要单独登记一条 ws://。
  // 桥接监听 127.0.0.1，但 Host 头是 localhost:17349，桥接两种 Host 都放行。
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, ['http://localhost:5173', 'http://localhost:17349', 'ws://localhost:17349']);
  assert.ok(readFileSync(join(directory, manifest.main), 'utf8'));
  const currentUiSource = readFileSync(join(directory, 'ui.html'), 'utf8');
  const script = currentUiSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'ui.html' }));
});

test('面板接收 JSON，复制失败时回退到全选复制，并可重新读取整页', async () => {
  const elements = new Map();
  function getOrCreateElement(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        disabled: id === 'copy',
        textContent: '',
        classList: {
          toggle() {},
          add() {},
          remove() {},
          contains() {
            return false;
          },
        },
        addEventListener(eventName, listener) {
          this[eventName] = listener;
        },
        focus() {},
        select() {
          this.wasSelected = true;
        },
        setSelectionRange(start, end) {
          this.selectionRange = [start, end];
        },
      });
    }
    return elements.get(id);
  }

  for (const id of [
    'output',
    'summary',
    'notice',
    'copy',
    'export-page',
    'export-selection',
    'server-input',
    'room-input',
    'comment-input',
    'target-summary',
    'send-button',
    'send-status',
  ]) {
    getOrCreateElement(id);
  }

  let copiedText = '';
  const postedMessages = [];
  const context = vm.createContext({
    document: {
      getElementById(id) {
        return getOrCreateElement(id);
      },
      execCommand(command) {
        if (command !== 'copy') return false;
        copiedText = getOrCreateElement('output').value;
        return true;
      },
    },
    navigator: {
      clipboard: {
        writeText() {
          return Promise.reject(new Error('Clipboard permission denied'));
        },
      },
    },
    parent: {
      postMessage(message, targetOrigin) {
        postedMessages.push({ message, targetOrigin });
      },
    },
    fetch: async () => ({ ok: true, text: async () => 'ok' }),
    isSecureContext: true,
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    Date,
    URL,
  });
  context.window = context;
  const currentUiSource = readFileSync(join(directory, 'ui.html'), 'utf8');
  const script = currentUiSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  vm.runInContext(script, context, { filename: 'ui.html' });

  const json = JSON.stringify({ scope: 'page', nodes: [] }, null, 2);
  context.onmessage({
    data: {
      pluginMessage: {
        type: 'layer-tree',
        json,
        summary: { scope: 'page', nodeCount: 0, truncated: false },
      },
    },
  });
  assert.equal(elements.get('output').value, json);
  assert.equal(elements.get('copy').disabled, false);

  await elements.get('copy').click();
  assert.equal(copiedText, json);
  assert.equal(elements.get('output').wasSelected, true);
  assert.deepEqual(elements.get('output').selectionRange, [0, json.length]);

  elements.get('export-page').click();
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].targetOrigin, '*');
  assert.equal(postedMessages[0].message.pluginMessage.type, 'export-page');
});

test('UI 面板关联选中图层并成功发送批注至房间 API', async () => {
  const elements = new Map();
  function createMockElement(id, initialProps = {}) {
    const el = {
      id,
      value: '',
      disabled: false,
      textContent: '',
      classList: {
        classes: new Set(),
        toggle(cls, force) {
          if (force === undefined) {
            if (this.classes.has(cls)) this.classes.delete(cls);
            else this.classes.add(cls);
          } else if (force) {
            this.classes.add(cls);
          } else {
            this.classes.delete(cls);
          }
        },
        add(cls) {
          this.classes.add(cls);
        },
        remove(cls) {
          this.classes.delete(cls);
        },
        contains(cls) {
          return this.classes.has(cls);
        },
      },
      listeners: {},
      addEventListener(event, fn) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(fn);
      },
      trigger(event) {
        const fns = this.listeners[event] || [];
        for (const fn of fns) fn.call(this, { target: this });
      },
      focus() {},
      select() {},
      setSelectionRange() {},
      ...initialProps,
    };
    elements.set(id, el);
    return el;
  }

  for (const id of ['output', 'summary', 'notice', 'copy', 'export-page', 'export-selection']) {
    createMockElement(id);
  }
  createMockElement('server-input', { value: 'http://localhost:5173' });
  createMockElement('room-input', { value: '' });
  createMockElement('comment-input', { value: '' });
  createMockElement('target-summary', { textContent: '未选中图层' });
  createMockElement('send-button', { disabled: true });
  createMockElement('send-status', { textContent: '' });

  const fetchCalls = [];
  const mockFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
      text: async () => 'ok',
    };
  };

  const context = vm.createContext({
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      execCommand() {
        return true;
      },
    },
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve(),
      },
    },
    parent: {
      postMessage() {},
    },
    fetch: mockFetch,
    isSecureContext: true,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    Date,
    URL,
  });
  context.window = context;

  const currentUiSource = readFileSync(join(directory, 'ui.html'), 'utf8');
  const script = currentUiSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  vm.runInContext(script, context, { filename: 'ui.html' });

  // 1. 模拟收到 selection-target 消息
  const figmaTarget = {
    id: '10:20',
    name: 'CTA 按钮',
    type: 'RECTANGLE',
    absoluteBoundingBox: { x: 100, y: 250, width: 200, height: 48 },
    pageId: '0:1',
    pageName: 'Page 1',
    fileKey: 'fileKeyX',
    fileName: 'Doc',
    link: 'https://www.figma.com/design/fileKeyX?node-id=10-20',
  };

  context.onmessage({
    data: {
      pluginMessage: {
        type: 'selection-target',
        figmaTarget,
      },
    },
  });

  const targetBadge = elements.get('target-summary');
  assert.ok(targetBadge.textContent.includes('CTA 按钮'));
  assert.ok(targetBadge.textContent.includes('200×48'));
  assert.ok(targetBadge.classList.contains('has-target'));

  // 2. 填写房间与批注内容
  const roomInput = elements.get('room-input');
  const commentInput = elements.get('comment-input');
  const sendButton = elements.get('send-button');

  roomInput.value = 'http://localhost:5173/s/room-figma-sync';
  roomInput.trigger('input');
  assert.equal(sendButton.disabled, true); // 批注为空，不可发送

  commentInput.value = '按钮主色应使用 brand token';
  commentInput.trigger('input');
  assert.equal(sendButton.disabled, false); // 房间和批注均已填写，可发送

  // 3. 点击发送
  await sendButton.listeners['click'][0]();

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, 'http://localhost:5173/api/room-figma-sync');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/json');

  const bodyOps = JSON.parse(call.options.body);
  assert.equal(bodyOps.length, 1);
  const op = bodyOps[0];
  assert.ok(op.id.startsWith('figma_'));
  assert.equal(op.tool, 'comment');
  assert.equal(op.num, 1);
  assert.equal(op.text, '按钮主色应使用 brand token');
  assert.equal(op.x, 100);
  assert.equal(op.y, 250);
  assert.equal(op.author, 'Figma Plugin');
  assert.deepEqual(op.figmaTarget, figmaTarget);

  // 4. 验证发送反馈与输入清空
  assert.equal(commentInput.value, '');
  const sendStatus = elements.get('send-status');
  assert.ok(sendStatus.textContent.includes('已成功发送至房间 room-figma-sync'));
});

// ---- 以下为补充用例 ----

function bootUi({ fetchImpl, setTimeoutImpl, AbortControllerImpl } = {}) {
  const elements = new Map();
  for (const id of [
    'output',
    'summary',
    'notice',
    'copy',
    'export-page',
    'export-selection',
    'server-input',
    'room-input',
    'comment-input',
    'target-summary',
    'send-button',
    'send-status',
  ]) {
    elements.set(id, {
      id,
      value: '',
      disabled: false,
      textContent: '',
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      listeners: {},
      addEventListener(event, fn) {
        this.listeners[event] = this.listeners[event] || [];
        this.listeners[event].push(fn);
      },
      trigger(event) {
        for (const fn of this.listeners[event] || []) fn.call(this, { target: this });
      },
      focus() {},
      select() {},
      setSelectionRange() {},
    });
  }
  elements.get('server-input').value = 'http://localhost:5173';

  const posted = [];
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id), execCommand: () => true },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    parent: { postMessage: (message, origin) => posted.push({ message, origin }) },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, text: async () => 'ok' })),
    isSecureContext: true,
    setTimeout: setTimeoutImpl || (() => 1),
    clearTimeout: () => {},
    Date,
    URL,
    ...(AbortControllerImpl ? { AbortController: AbortControllerImpl } : {}),
  });
  context.window = context;
  const script = readFileSync(join(directory, 'ui.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1];
  vm.runInContext(script, context, { filename: 'ui.html' });

  function fill(room, comment) {
    elements.get('room-input').value = room;
    elements.get('comment-input').value = comment;
  }
  async function send() {
    await elements.get('send-button').listeners.click[0]();
  }
  return { elements, context, posted, fill, send, status: () => elements.get('send-status') };
}

test('多选图层列表有上限，并带总数与截断标记', () => {
  const page = makePage();
  const many = Array.from({ length: 120 }, (_, i) => makeNode(`9:${i}`, `图层${i}`, 'RECTANGLE'));
  page.children = many;
  const plugin = bootPlugin(page);
  page.selection = many;
  plugin.listeners.selectionchange();

  const target = plugin.lastMessage('selection-target').figmaTarget;
  assert.equal(target.nodes.length, 50);
  assert.equal(target.nodesTotal, 120);
  assert.equal(target.nodesTruncated, true);

  page.selection = many.slice(0, 2);
  plugin.listeners.selectionchange();
  const small = plugin.lastMessage('selection-target').figmaTarget;
  assert.equal(small.nodes.length, 2);
  assert.equal(small.nodesTotal, 2);
  assert.equal(small.nodesTruncated, false);
});

test('fileKey 缺失时 link 为 null，其余字段正常', () => {
  const page = makePage();
  const plugin = bootPlugin(page, { fileKey: undefined });
  page.selection = [page.children[0]];
  plugin.listeners.selectionchange();

  const target = plugin.lastMessage('selection-target').figmaTarget;
  assert.equal(target.fileKey, null);
  assert.equal(target.link, null);
  assert.equal(target.id, '1:1');
});

test('currentpagechange 会刷新选中目标', () => {
  const page = makePage();
  const plugin = bootPlugin(page);
  page.selection = [page.children[1]];
  plugin.listeners.currentpagechange();
  assert.equal(plugin.lastMessage('selection-target').figmaTarget.id, '1:2');
});

test('导出抛错时发送 export-error，选中目标读取抛错时发送 selection-target-error', () => {
  const page = makePage();
  const plugin = bootPlugin(page);
  Object.defineProperty(page, 'selection', {
    get() {
      throw new Error('boom');
    },
  });

  plugin.figma.ui.onmessage({ type: 'export-selection' });
  assert.equal(plugin.lastMessage('export-error').message, 'boom');
  assert.equal(plugin.lastMessage('selection-target-error').message, 'boom');

  plugin.figma.ui.onmessage(null);
  plugin.figma.ui.onmessage({ type: 'unknown' });
});

test('节点数、深度恰好等于上限时不误报截断；maxDepth=1 只保留根', () => {
  const plugin = bootPlugin(makePage());

  plugin.context.testRoots = [makePage()];
  plugin.context.testLimits = { maxNodes: 5, maxDepth: 50 };
  let result = vm.runInContext('serializeTrees(testRoots, testLimits)', plugin.context);
  assert.equal(result.nodeCount, 5);
  assert.equal(result.truncated, false);

  plugin.context.testLimits = { maxNodes: 5000, maxDepth: 4 };
  result = vm.runInContext('serializeTrees(testRoots, testLimits)', plugin.context);
  assert.equal(result.truncated, false);

  plugin.context.testLimits = { maxNodes: 5000, maxDepth: 1 };
  result = vm.runInContext('serializeTrees(testRoots, testLimits)', plugin.context);
  assert.equal(result.nodeCount, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.depthLimitReached, true);
  assert.deepEqual(Array.from(result.nodes[0].children), []);
});

test('UI：读取选中按钮向主线程发送 export-selection', () => {
  const ui = bootUi();
  ui.elements.get('export-selection').listeners.click[0]();
  assert.equal(ui.posted.length, 1);
  assert.equal(ui.posted[0].message.pluginMessage.type, 'export-selection');
});

test('UI：parseRoomId 边界输入', () => {
  const ui = bootUi();
  const parse = (value) => {
    ui.context.testRaw = value;
    return vm.runInContext('parseRoomId(testRaw)', ui.context);
  };
  assert.equal(parse(''), '');
  assert.equal(parse(null), '');
  assert.equal(parse('abc123'), 'abc123');
  assert.equal(parse('  s/abc  '), 'abc');
  assert.equal(parse('r/abc-def_9'), 'abc-def_9');
  assert.equal(parse('https://vcollab.tokc2327.workers.dev/s/room1?x=1#h'), 'room1');
  assert.equal(parse('https://example.com/some/room2'), 'room2');
});

test('UI：服务器与房间链接不一致时以链接为准，未知服务器被拒绝', async () => {
  const calls = [];
  const ui = bootUi({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });

  ui.fill('https://vcollab.tokc2327.workers.dev/s/prod-room', 'hi');
  await ui.send();
  assert.deepEqual(calls, ['https://vcollab.tokc2327.workers.dev/api/prod-room']);
  assert.equal(ui.elements.get('server-input').value, 'https://vcollab.tokc2327.workers.dev');

  ui.fill('https://evil.example.com/s/x', 'hi');
  await ui.send();
  assert.equal(calls.length, 1);
  assert.ok(ui.status().textContent.includes('不在插件允许的网络域名内'));

  ui.elements.get('server-input').value = 'https://other.example.com';
  ui.fill('plain-room', 'hi');
  await ui.send();
  assert.equal(calls.length, 1);
  assert.ok(ui.status().textContent.includes('不在插件允许的网络域名内'));
});

test('UI：非 2xx 响应显示状态码并截断过长的错误文本', async () => {
  const ui = bootUi({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'x'.repeat(5000),
    }),
  });
  ui.fill('room-a', 'hi');
  await ui.send();
  const text = ui.status().textContent;
  assert.ok(text.startsWith('发送失败 (500): '));
  assert.ok(text.length < 260);
  assert.equal(ui.elements.get('comment-input').value, 'hi');
  assert.equal(ui.elements.get('send-button').disabled, false);
});

test('UI：网络错误显示原因并恢复按钮', async () => {
  const ui = bootUi({
    fetchImpl: async () => {
      throw new Error('Failed to fetch');
    },
  });
  ui.fill('room-a', 'hi');
  await ui.send();
  assert.ok(ui.status().textContent.includes('Failed to fetch'));
  assert.equal(ui.elements.get('send-button').disabled, false);
});

test('UI：发送超时会中止请求、提示超时并恢复按钮', async () => {
  let abortCalled = false;
  let fireTimeout;
  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      abortCalled = true;
      this.signal.aborted = true;
    }
  }
  const ui = bootUi({
    AbortControllerImpl: FakeAbortController,
    setTimeoutImpl: (fn) => {
      fireTimeout = fn;
      return 1;
    },
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        // 请求一直挂起，直到被中止。
        const poll = setInterval(() => {
          if (init.signal && init.signal.aborted) {
            clearInterval(poll);
            reject(new Error('The operation was aborted'));
          }
        }, 1);
      }),
  });
  ui.fill('room-a', 'hi');
  const pending = ui.send();
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  await pending;

  assert.equal(abortCalled, true);
  assert.ok(ui.status().textContent.includes('发送超时'));
  assert.equal(ui.elements.get('send-button').disabled, false);
  assert.equal(ui.elements.get('comment-input').value, 'hi');
});

test('UI：无选中图层时发送成功并提示批注位置为 0,0；fileKey 缺失时提示', async () => {
  const ui = bootUi();
  ui.fill('room-a', 'hi');
  await ui.send();
  assert.ok(ui.status().textContent.includes('未关联图层'));

  ui.context.onmessage({
    data: {
      pluginMessage: {
        type: 'selection-target',
        figmaTarget: {
          id: '1:1',
          name: '按钮',
          type: 'FRAME',
          absoluteBoundingBox: { x: 1, y: 2, width: 30, height: 40 },
          fileKey: null,
          link: null,
          nodes: [{}, {}],
          nodesTotal: 120,
          nodesTruncated: true,
        },
      },
    },
  });
  const badge = ui.elements.get('target-summary').textContent;
  assert.ok(badge.includes('多选 120 个图层'));
  assert.ok(badge.includes('前 2 个'));
  assert.ok(badge.includes('无法获取 fileKey'));
});
