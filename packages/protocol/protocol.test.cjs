const assert = require('node:assert/strict');
const test = require('node:test');
const { isCommandEnvelope, isCommandResult, isCommentPin, isNodeSnapshot } = require('./index.cjs');
const read = { commandId: 'req', participantId: 'agent:test', type: 'get_ordered_pins', payload: {} };
const write = { ...read, type: 'update_style', pinId: 'p1', expectedVersion: 1,
  payload: { nodeId: '1:2', fillHex: '#1a73e8' } };
const pin = { schemaVersion: '0.1', pinId: 'p1', order: 1, instruction: '改色', status: 'pending',
  anchor: { pageId: '0:1', nodeId: '1:2', namePath: ['Frame'], nodeType: 'RECTANGLE' },
  version: 1, updatedAt: '2026-11-23T00:00:00.000Z' };
const node = { nodeId: '1:2', name: 'Frame', type: 'RECTANGLE',
  bounds: { x: 0, y: -10, width: 5, height: 5 } };

test('accepts reads and each scoped write', () => {
  for (const command of [
    read, write,
    { ...write, type: 'update_text', payload: { nodeId: '1:2', characters: '' } },
    { ...write, type: 'update_layout', payload: { nodeId: '1:2', padding: { left: 0 } } },
    { ...write, type: 'update_pin_status', payload: { pinId: 'p1', status: 'done' } },
  ]) assert.equal(isCommandEnvelope(command), true);
});

test('rejects missing concurrency data, scope mismatch and malformed payloads', () => {
  for (const command of [
    { ...write, expectedVersion: undefined }, { ...write, pinId: ' ' },
    { ...write, payload: { nodeId: '1:2' } },
    { ...write, payload: { ...write.payload, opacity: Infinity } },
    { ...write, payload: { nodeId: '1:2', fillHex: '#fff' } },
    { ...write, type: 'update_pin_status', payload: { pinId: 'p2', status: 'done' } },
    { ...read, payload: { statusFilter: [,'done'] } },
    { ...read, type: 'constructor' }, { ...read, payload: JSON.parse('{"__proto__":{}}') },
  ]) assert.equal(isCommandEnvelope(command), false);
});

test('validates pin and snapshot contracts', () => {
  assert.equal(isCommentPin(pin), true);
  assert.equal(isCommentPin({ ...pin, updatedAt: 'yesterday' }), false);
  assert.equal(isNodeSnapshot(node), true);
  assert.equal(isNodeSnapshot({ ...node, bounds: { ...node.bounds, width: -1 } }), false);
});

test('requires readback and version in write results and matches error statuses', () => {
  const result = { commandId: 'req', ok: true, data: node, newVersion: 2 };
  assert.equal(isCommandResult(result, 'update_style'), true);
  assert.equal(isCommandResult({ ...result, newVersion: undefined }, 'update_style'), false);
  const error = { commandId: 'req', ok: false,
    error: { code: 'SCOPE_DENIED', httpStatus: 403, message: 'scope' } };
  assert.equal(isCommandResult(error, 'update_style'), true);
  assert.equal(isCommandResult({ ...error, error: { ...error.error, httpStatus: 409 } }, 'update_style'), false);
});

test('validates orphan rows and status result version', () => {
  assert.equal(isCommandResult({ commandId: 'req', ok: true, data: [{ pin, orphaned: true }] }, read.type), true);
  assert.equal(isCommandResult({ commandId: 'req', ok: true,
    data: [{ pin, orphaned: true, context: node }] }, read.type), false);
  assert.equal(isCommandResult({ commandId: 'req', ok: true, newVersion: 2,
    data: { pin, pendingCount: 1 } }, 'update_pin_status'), false);
  assert.equal(isCommandResult({ commandId: 'req', ok: true, newVersion: 1,
    data: { pin: { ...pin, lastError: 'unexpected' }, pendingCount: 1 } }, 'update_pin_status'), false);
});

test('add_pin 不带并发字段，回执是新建的 pin 本身', () => {
  const add = { commandId: 'req', participantId: 'agent:test', type: 'add_pin',
    payload: { instruction: '改标题' } };
  assert.equal(isCommandEnvelope(add), true);
  assert.equal(isCommandEnvelope({ ...add, payload: { instruction: '改标题', nodeId: '1:2' } }), true);
  // 打点不是修改既有标注：带 pinId / expectedVersion 就不合法
  assert.equal(isCommandEnvelope({ ...add, pinId: 'p1', expectedVersion: 1 }), false);
  assert.equal(isCommandEnvelope({ ...add, payload: {} }), false);
  assert.equal(isCommandEnvelope({ ...add, payload: { instruction: '  ' } }), false);

  assert.equal(isCommandResult({ commandId: 'req', ok: true, data: pin }, 'add_pin'), true);
  assert.equal(isCommandResult({ commandId: 'req', ok: true, data: pin, newVersion: 1 }, 'add_pin'), false);
  assert.equal(isCommandResult({ commandId: 'req', ok: true, data: node }, 'add_pin'), false);
  assert.equal(isCommandResult({ commandId: 'req', ok: true, data: { ...pin, status: 'odd' } }, 'add_pin'), false);
});
