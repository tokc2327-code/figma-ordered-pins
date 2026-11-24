const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const pinProtocol = require('./index.cjs');
const { inferFigmaRoleAndLevel, normalizeError, runAudit } = require('./v0-audit.cjs');

const at = '2026-11-24T00:00:00.000Z';
const frame = (overrides = {}) => ({ id: 'node:1', type: 'FRAME', name: 'Panel', path: ['Page', 'Panel'], ...overrides });
const audit = (anchors, registry) => runAudit({ anchors, registry, mode: registry ? 'registry' : 'generic', observedAt: at });

test('图片块含三个子节点时不判为 opaque 或 G1', () => {
  const raw = frame({ hasImageFill: true, bounds: { x: 0, y: 0, width: 300, height: 200 }, childCount: 3 });
  assert.notEqual(inferFigmaRoleAndLevel(raw).level, 'opaque');
  assert.equal(audit([raw]).findings.some(({ ruleId }) => ruleId === 'G1'), false);
});

test('深层普通 FRAME 默认 L0 且不触发 R1', () => {
  const report = audit([frame({ depth: 6 })], { version: '1', items: [] });
  assert.equal(report.anchors[0].level, 'L0');
  assert.equal(report.findings.some(({ ruleId }) => ruleId === 'R1'), false);
});

test('带 semanticId 的 FRAME 升 L1 并进入 R2 和 R3 校验', () => {
  const raw = frame({ semanticId: 'nav.submit', props: {} });
  const registry = { version: '1', allowedKinds: ['Button'], items: [
    { id: 'nav.submit', schema: { kind: 'Unknown', props: { label: { type: 'string', required: true } } } },
  ] };
  const report = audit([raw], registry);
  assert.equal(report.anchors[0].level, 'L1');
  assert.deepEqual(report.findings.filter(({ ruleId }) => ['R2', 'R3'].includes(ruleId))
    .map(({ ruleId }) => ruleId).sort(), ['R2', 'R3']);
});

test('COMPONENT 和 INSTANCE 默认 L1 且无 semanticId 时触发 R1', () => {
  const report = audit([
    { id: 'component', type: 'COMPONENT', name: 'Primary Action' },
    { id: 'instance', type: 'INSTANCE', name: 'Primary Action' },
  ], { version: '1', items: [] });
  assert.deepEqual(report.anchors.map(({ level }) => level), ['L1', 'L1']);
  assert.equal(report.findings.filter(({ ruleId }) => ruleId === 'R1').length, 2);
});

test('R3 报告缺失的必填属性', () => {
  const registry = { version: '1', items: [
    { id: 'nav.submit', props: { label: { type: 'string', required: true } } },
  ] };
  const report = audit([frame({ type: 'INSTANCE', semanticId: 'nav.submit', props: {} })], registry);
  const finding = report.findings.find(({ ruleId }) => ruleId === 'R3');
  assert.ok(finding);
  assert.ok(finding.evidence.issues.some(({ prop, reason }) => prop === 'label' && reason === 'MISSING_REQUIRED_PROP'));
});

test('R3 报告越界枚举值', () => {
  const registry = { version: '1', items: [
    { id: 'nav.submit', props: { variant: { type: 'enum', enumValues: ['primary', 'ghost'] } } },
  ] };
  const report = audit([frame({ type: 'INSTANCE', semanticId: 'nav.submit', props: { variant: 'danger' } })], registry);
  const issue = report.findings.find(({ ruleId }) => ruleId === 'R3')?.evidence.issues
    .find(({ prop }) => prop === 'variant');
  assert.deepEqual(issue, { prop: 'variant', reason: 'INVALID_ENUM_VALUE', expected: ['primary', 'ghost'], actual: 'danger' });
});

test('R3 报告未声明属性', () => {
  const registry = { version: '1', items: [{ id: 'nav.submit', props: {} }] };
  const report = audit([frame({ type: 'INSTANCE', semanticId: 'nav.submit', props: { foo: 123 } })], registry);
  const issue = report.findings.find(({ ruleId }) => ruleId === 'R3')?.evidence.issues
    .find(({ prop }) => prop === 'foo');
  assert.equal(issue?.reason, 'UNDECLARED_PROP');
});

test('未知错误码保留原码和来源且不归一', () => {
  assert.deepEqual(normalizeError('uia', 'CDP_TIMEOUT'), {
    code: 'CDP_TIMEOUT', rawCode: 'CDP_TIMEOUT', source: 'uia', normalized: false,
  });
});

test('audit_visual 缓存同一变量 ID 的名称反查并为每个节点产出令牌证据', async () => {
  let lookups = 0;
  const page = { id: 'page:1', type: 'PAGE' };
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    id: 'node:' + index, name: 'Layer ' + index, type: 'FRAME', parent: page,
    fills: [], children: [], boundVariables: { fills: [{ id: 'VariableID:1:1' }] },
    absoluteBoundingBox: { x: index, y: 0, width: 120, height: 48 },
    getPluginData() { return ''; },
  }));
  page.selection = nodes;
  const figma = {
    currentPage: page, mixed: Symbol('mixed'), variables: {
      async getVariableByIdAsync(id) {
        lookups++;
        assert.equal(id, 'VariableID:1:1');
        return { name: 'color/brand/primary' };
      },
    },
  };
  const context = vm.createContext({ figma, pinProtocol, v0Audit: require('./v0-audit.cjs') });
  const pluginSource = readFileSync(path.join(__dirname, '../plugin/ordered-pins.js'), 'utf8');
  vm.runInContext(pluginSource, context);
  const orderedPins = vm.runInContext('orderedPins', context);
  const result = await orderedPins.command({
    commandId: 'audit-cache', participantId: 'agent:test', type: 'audit_visual',
    payload: { scope: 'selection', mode: 'registry',
      registry: { version: '1', tokens: ['color/surface/default'], items: [] } },
  });
  assert.equal(result.ok, true);
  assert.equal(lookups, 1);
  assert.equal(result.data.anchors.length, nodes.length);
  const findings = result.data.findings.filter(({ ruleId }) => ruleId === 'R6');
  assert.equal(findings.length, nodes.length);
  assert.ok(findings.every(({ evidence }) => evidence.tokenName === 'color/brand/primary'));
});

test('error、warning 和 info 权重计分并将下限钳制为零', () => {
  const report = audit([
    frame({ name: 'Hero artwork', hasImageFill: true, bounds: { x: 0, y: 0, width: 300, height: 200 }, childCount: 0 }),
    frame({ id: '2', name: 'Rectangle 2' }),
    frame({ id: '3', name: 'Frame 3' }),
    { id: '4', type: 'TEXT', name: 'Title', path: ['Page', 'Title'], fillHex: '#000000' },
    { id: '5', type: 'TEXT', name: 'Body', path: ['Page', 'Body'] },
    { id: '6', type: 'TEXT', name: 'Caption', path: ['Page', 'Caption'], textStyleId: 'style:1' },
  ]);
  assert.equal(report.summary.score, 79);
  assert.equal(runAudit({ anchors: Array.from({ length: 30 }, (_, index) => ({
    id: String(index), type: 'FRAME', name: 'Rectangle ' + index, path: [String(index)],
  })), observedAt: at }).summary.score, 0);
});
