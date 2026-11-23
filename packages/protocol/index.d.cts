export type PinStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export type Bounds = { x: number; y: number; width: number; height: number };
export type Padding = { top: number; right: number; bottom: number; left: number };
export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';

export interface NodeAnchor {
  nodeId: string;
  pageId: string;
  namePath: string[];
  nodeType: string;
  fallbackBounds?: Bounds;
}

export interface CommentPin {
  schemaVersion: '0.1';
  pinId: string;
  order: number;
  instruction: string;
  status: PinStatus;
  anchor: NodeAnchor;
  pinNodeId?: string;
  version: number;
  lastError?: string;
  updatedAt: string;
}

export interface NodeSnapshot {
  nodeId: string;
  name: string;
  type: string;
  bounds: Bounds;
  text?: { characters: string; fontSize: number | 'MIXED'; fontFamily?: string; fontStyle?: string };
  style?: { fillHex?: string; strokeHex?: string; cornerRadius?: number | 'MIXED'; opacity?: number };
  layout?: { layoutMode: LayoutMode; itemSpacing?: number; padding?: Padding; parentLayoutMode?: LayoutMode };
  childrenSummary?: Array<{ nodeId: string; name: string; type: string }>;
}

interface Payloads {
  get_ordered_pins: { statusFilter?: PinStatus[]; includeContext?: boolean };
  update_text: { nodeId: string; characters?: string; fontSize?: number; fontStyle?: string };
  update_style: { nodeId: string; fillHex?: string; strokeHex?: string; cornerRadius?: number; opacity?: number };
  update_layout: { nodeId: string; width?: number; height?: number; x?: number; y?: number; itemSpacing?: number; padding?: Partial<Padding> };
  update_pin_status: { pinId: string; status: PinStatus; note?: string };
}
export type CommandType = keyof Payloads;

export type CommandEnvelope<T extends CommandType = CommandType> = T extends CommandType ? {
  commandId: string;
  participantId: string;
  type: T;
  payload: Payloads[T];
} & (T extends 'get_ordered_pins' ? {} : { pinId: string; expectedVersion: number }) : never;

export type ErrorCode = 'SCOPE_DENIED' | 'ANCHOR_NOT_FOUND' | 'VERSION_CONFLICT'
  | 'INVALID_PARAMS' | 'FONT_LOAD_FAILED' | 'WRITE_FAILED';
interface ResultData {
  get_ordered_pins: Array<{ pin: CommentPin; context?: NodeSnapshot; orphaned?: true }>;
  update_text: NodeSnapshot;
  update_style: NodeSnapshot;
  update_layout: NodeSnapshot;
  update_pin_status: { pin: CommentPin; pendingCount: number };
}

export type CommandResult<T extends CommandType = CommandType> = {
  commandId: string; ok: false;
  error: { code: ErrorCode; httpStatus: 403 | 404 | 409 | 422 | 500; message: string };
} | (T extends CommandType ? { commandId: string; ok: true; data: ResultData[T] }
  & (T extends 'get_ordered_pins' ? {} : { newVersion: number }) : never);

export const statuses: readonly PinStatus[];
export const commandTypes: readonly CommandType[];
export const errorStatuses: Readonly<Record<ErrorCode, number>>;
export function toolInputSchema(type: CommandType): Record<string, unknown>;
export function isCommentPin(value: unknown): value is CommentPin;
export function isNodeSnapshot(value: unknown): value is NodeSnapshot;
export function isCommandEnvelope(value: unknown): value is CommandEnvelope;
export function isCommandResult<T extends CommandType>(value: unknown, type: T): value is CommandResult<T>;
