'use strict';

const statuses = ['pending', 'in_progress', 'done', 'failed'];
const errorStatuses = {
  SCOPE_DENIED: 403, ANCHOR_NOT_FOUND: 404, VERSION_CONFLICT: 409,
  INVALID_PARAMS: 422, FONT_LOAD_FAILED: 500, WRITE_FAILED: 500,
};
const string = { type: 'string' };
const id = { type: 'string', minLength: 1, pattern: '\\S' };
const number = { type: 'number' };
const nonnegative = { ...number, minimum: 0 };
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 };
const status = { enum: statuses };
const boolean = { type: 'boolean' };
const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const layoutMode = { enum: ['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'] };
const array = (items) => ({ type: 'array', items });
const object = (properties, required = [], extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
const padding = { top: nonnegative, right: nonnegative, bottom: nonnegative, left: nonnegative };
const bounds = object({ x: number, y: number, width: nonnegative, height: nonnegative },
  ['x', 'y', 'width', 'height']);
const pinSchema = object({
  schemaVersion: { const: '0.1' }, pinId: id, order: version, instruction: id, status,
  anchor: object({ nodeId: id, pageId: id, namePath: array(string), nodeType: id, fallbackBounds: bounds },
    ['nodeId', 'pageId', 'namePath', 'nodeType']),
  pinNodeId: id, version, lastError: string,
  updatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' },
}, ['schemaVersion', 'pinId', 'order', 'instruction', 'status', 'anchor', 'version', 'updatedAt']);
const nodeSchema = object({
  nodeId: id, name: string, type: id, bounds,
  text: object({
    characters: string, fontSize: { anyOf: [nonnegative, { const: 'MIXED' }] }, fontFamily: id, fontStyle: id,
  }, ['characters', 'fontSize']),
  style: object({
    fillHex: hex, strokeHex: hex, cornerRadius: { anyOf: [nonnegative, { const: 'MIXED' }] },
    opacity: { ...nonnegative, maximum: 1 },
  }),
  layout: object({
    layoutMode, parentLayoutMode: layoutMode, itemSpacing: number,
    padding: object(padding, Object.keys(padding)),
  }, ['layoutMode']),
  childrenSummary: array(object({ nodeId: id, name: string, type: id }, ['nodeId', 'name', 'type'])),
}, ['nodeId', 'name', 'type', 'bounds']);
const payloadSchemas = {
  get_ordered_pins: object({ statusFilter: array(status), includeContext: boolean }),
  update_text: object({ nodeId: id, characters: string, fontSize: { ...number, exclusiveMinimum: 0 },
    fontStyle: id }, ['nodeId'], { minProperties: 2 }),
  update_style: object({ nodeId: id, fillHex: hex, strokeHex: hex, cornerRadius: nonnegative,
    opacity: { ...nonnegative, maximum: 1 } }, ['nodeId'], { minProperties: 2 }),
  update_layout: object({ nodeId: id, width: { ...number, exclusiveMinimum: 0 },
    height: { ...number, exclusiveMinimum: 0 }, x: number, y: number, itemSpacing: number,
    padding: object(padding, [], { minProperties: 1 }) }, ['nodeId'], { minProperties: 2 }),
  update_pin_status: object({ pinId: id, status, note: string }, ['pinId', 'status']),
  // add_pin 只带指令(可选指定目标图层,不给就用当前选区),没有既有的 pinId / expectedVersion。
  add_pin: object({ instruction: id, nodeId: id }, ['instruction']),
};
const commandTypes = Object.keys(payloadSchemas);
// 这两条命令不是修改既有标注,所以信封里不带 pinId / expectedVersion,回执也不带 newVersion。
const versionlessTypes = ['get_ordered_pins', 'add_pin'];
const resultSchemas = {
  add_pin: pinSchema,
  get_ordered_pins: array(object({
    pin: pinSchema, context: nodeSchema, orphaned: { const: true },
  }, ['pin'])),
  update_text: nodeSchema,
  update_style: nodeSchema,
  update_layout: nodeSchema,
  update_pin_status: object({ pin: pinSchema, pendingCount: { type: 'integer', minimum: 0 } },
    ['pin', 'pendingCount']),
};

function matches(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((item) => matches(value, item));
  if (schema.enum) return schema.enum.includes(value);
  if ('const' in schema) return value === schema.const;
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      return keys.length >= (schema.minProperties ?? 0)
        && schema.required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every((key) => Object.prototype.hasOwnProperty.call(schema.properties, key)
          && matches(value[key], schema.properties[key]));
    }
    case 'array':
      return Array.isArray(value) && Array.from(value).every((item) => matches(item, schema.items));
    case 'string':
      return typeof value === 'string' && value.length >= (schema.minLength ?? 0)
        && (!schema.pattern || new RegExp(schema.pattern).test(value));
    case 'integer':
    case 'number':
      return Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value))
        && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
        && value > (schema.exclusiveMinimum ?? -Infinity);
    default:
      return typeof value === schema.type;
  }
}

function toolInputSchema(type) {
  const properties = { participantId: id, payload: payloadSchemas[type] };
  const required = ['participantId', 'payload'];
  if (!versionlessTypes.includes(type)) {
    Object.assign(properties, { pinId: id, expectedVersion: version });
    required.push('pinId', 'expectedVersion');
  }
  return object(properties, required);
}

function isCommandEnvelope(value) {
  if (!commandTypes.includes(value?.type)) return false;
  const input = toolInputSchema(value.type);
  const schema = object({ ...input.properties, commandId: id, type: { const: value.type } },
    [...input.required, 'commandId', 'type']);
  return matches(value, schema)
    && (value.type !== 'update_pin_status' || value.pinId === value.payload.pinId);
}

function isCommandResult(value, type) {
  if (!commandTypes.includes(type)) return false;
  if (value?.ok === true) {
    const properties = { commandId: id, ok: { const: true }, data: resultSchemas[type] };
    const required = ['commandId', 'ok', 'data'];
    if (!versionlessTypes.includes(type)) {
      properties.newVersion = version;
      required.push('newVersion');
    }
    if (!matches(value, object(properties, required))) return false;
    if (type === 'add_pin') return isCommentPin(value.data);
    if (type === 'update_pin_status') {
      return isCommentPin(value.data.pin) && value.newVersion === value.data.pin.version;
    }
    return type !== 'get_ordered_pins' || value.data.every(({ pin, orphaned, context }) =>
      isCommentPin(pin) && !(orphaned && context));
  }
  const code = value?.error?.code;
  return Object.prototype.hasOwnProperty.call(errorStatuses, code) && matches(value, object({
    commandId: id, ok: { const: false }, error: object({
      code: { const: code }, httpStatus: { const: errorStatuses[code] }, message: id,
    }, ['code', 'httpStatus', 'message']),
  }, ['commandId', 'ok', 'error']));
}

function isCommentPin(value) {
  return matches(value, pinSchema) && Number.isFinite(Date.parse(value.updatedAt))
    && (value.lastError === undefined || value.status === 'failed');
}

module.exports = {
  commandTypes, errorStatuses, statuses, toolInputSchema,
  isCommentPin, isNodeSnapshot: (value) => matches(value, nodeSchema),
  isCommandEnvelope, isCommandResult,
};
