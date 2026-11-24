'use strict';

// 统一错误码映射层（只做归一映射，不改动现有顶层错误码表）
const ERROR_MAP = {
  figma: {
    ANCHOR_NOT_FOUND: 'NOT_FOUND',
    VERSION_CONFLICT: 'VERSION_CONFLICT',
    SCOPE_DENIED: 'SCOPE_DENIED',
    INVALID_PARAMS: 'INVALID_PARAMS',
    FONT_LOAD_FAILED: 'WRITE_FAILED',
    WRITE_FAILED: 'WRITE_FAILED',
  },
  uia: {
    NOT_FOUND: 'NOT_FOUND',
    AMBIGUOUS_MATCH: 'AMBIGUOUS',
    UNKNOWN_ID: 'STALE_ANCHOR',
    BAD_ARGS: 'INVALID_PARAMS',
  },
};

function normalizeError(source, rawCode) {
  const src = source || 'unknown';
  const table = Object.prototype.hasOwnProperty.call(ERROR_MAP, src) ? ERROR_MAP[src] : null;
  const mapped = table && rawCode && Object.prototype.hasOwnProperty.call(table, rawCode)
    ? table[rawCode]
    : null;
  return {
    code: mapped || rawCode || 'UNKNOWN_ERROR',
    rawCode: rawCode === undefined ? null : rawCode,
    source: src,
    normalized: Boolean(mapped),
  };
}

const SEVERITY_WEIGHT = {
  error: 10,
  warning: 4,
  info: 1,
};

const DEFAULT_NAME_RE = /^(Frame|Rectangle|Group|Ellipse|Vector|Line|Polygon|Star|Component|Instance)\s+\d+$/i;

function relLuminance(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const parts = hex.slice(1).match(/../g);
  if (!parts) return null;
  const rgb = parts.map((x) => {
    const v = parseInt(x, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(fgHex, bgHex) {
  const l1 = relLuminance(fgHex);
  const l2 = relLuminance(bgHex);
  if (l1 === null || l2 === null) return null;
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function inferFigmaRoleAndLevel(raw) {
  const nameLower = String(raw && raw.name ? raw.name : '').toLowerCase();
  const type = raw && raw.type ? raw.type : 'UNKNOWN';

  if (type === 'PAGE' || type === 'SECTION') {
    return { role: 'Container', level: 'L0' };
  }

  // 依赖 raw.hasImageFill, raw.bounds, raw.childCount
  const hasImageFill = Boolean(raw && raw.hasImageFill);
  const bounds = raw && raw.bounds;
  const isLarge = Boolean(bounds && bounds.width >= 120 && bounds.height >= 40);
  const childCount = typeof (raw && raw.childCount) === 'number' ? raw.childCount : 0;
  if (hasImageFill && isLarge && childCount === 0) {
    return { role: 'Opaque', level: 'opaque' };
  }

  let interactiveRole = null;
  if (/(btn|button|按钮)/.test(nameLower)) interactiveRole = 'Button';
  else if (/(input|field|search|输入)/.test(nameLower)) interactiveRole = 'Edit';
  else if (/(tab|标签)/.test(nameLower)) interactiveRole = 'TabItem';
  else if (/(check|toggle|switch|开关)/.test(nameLower)) interactiveRole = 'CheckBox';

  if (type === 'INSTANCE' || type === 'COMPONENT') {
    return { role: interactiveRole || 'Control', level: 'L1' };
  }

  // FRAME 默认 L0；仅在挂了 vc-semantic-id 或命中显式交互角色时升为 L1
  if (type === 'FRAME') {
    if ((raw && raw.semanticId) || interactiveRole) {
      return { role: interactiveRole || 'Control', level: 'L1' };
    }
    return { role: 'Container', level: 'L0' };
  }

  if (type === 'TEXT') {
    return { role: 'Text', level: 'L2' };
  }

  return { role: type, level: 'L2' };
}

function toFigmaAnchor(raw, observedAt) {
  const inferred = inferFigmaRoleAndLevel(raw);
  const anchor = {
    kind: 'figma',
    id: raw.id || '',
    role: inferred.role,
    name: raw.name || '',
    path: Array.isArray(raw.path) ? raw.path.slice() : [],
    bounds: raw.bounds || { x: 0, y: 0, width: 0, height: 0 },
    space: 'canvas',
    level: inferred.level,
    stability: 'stable',
    observedAt: observedAt,
  };
  if (raw.semanticId) anchor.semanticId = raw.semanticId;
  return anchor;
}

function toUiaAnchor(raw, observedAt) {
  const bounds = raw.bounds || { x: 0, y: 0, width: 0, height: 0 };
  const childCount = typeof raw.childCount === 'number' ? raw.childCount : 0;
  let level = raw.level;
  if (!level) {
    if (raw.isOpaque) {
      level = 'opaque';
    } else if (
      (raw.role === 'Window' || raw.role === 'Pane' || raw.role === 'Group') &&
      childCount === 0 &&
      !raw.name &&
      !raw.id &&
      bounds.width >= 120 &&
      bounds.height >= 60
    ) {
      level = 'opaque';
    } else if (raw.role === 'Window' || raw.role === 'Pane' || raw.role === 'Group') {
      level = 'L0';
    } else {
      level = 'L1';
    }
  }
  const anchor = {
    kind: 'windows-uia',
    id: raw.id || '',
    role: raw.role || 'Unknown',
    name: raw.name || '',
    path: Array.isArray(raw.path) ? raw.path.slice() : [],
    bounds: bounds,
    space: 'screen',
    level: level,
    stability: raw.stability || 'snapshot',
    observedAt: raw.observedAt || observedAt,
  };
  if (raw.semanticId) anchor.semanticId = raw.semanticId;
  return anchor;
}

// 解析 UiSemantic：完整 schema 优先，回落到简写 props（主键为 id）
function resolveSemanticProps(item) {
  const hasSchema = Boolean(item && item.schema && typeof item.schema === 'object');
  const kind = hasSchema && item.schema.kind ? item.schema.kind : (item ? item.id : '');
  const props = hasSchema && item.schema.props
    ? item.schema.props
    : (item && item.props && typeof item.props === 'object' ? item.props : {});
  return { kind: kind, props: props };
}

function defaultValidateProps(item, rawProps) {
  const resolved = resolveSemanticProps(item);
  const defs = resolved.props;
  const actualProps = rawProps && typeof rawProps === 'object' ? rawProps : {};
  const issues = [];

  for (const key of Object.keys(defs)) {
    const def = defs[key];
    if (!def) continue;
    const hasVal = Object.prototype.hasOwnProperty.call(actualProps, key) && actualProps[key] !== undefined;
    if (!hasVal) {
      if (def.required) {
        issues.push({ prop: key, reason: 'MISSING_REQUIRED_PROP', expected: def.type, actual: undefined });
      }
      continue;
    }
    const val = actualProps[key];
    if (def.type === 'enum') {
      const allowed = Array.isArray(def.enumValues) ? def.enumValues : [];
      if (!allowed.includes(val)) {
        issues.push({ prop: key, reason: 'INVALID_ENUM_VALUE', expected: allowed, actual: val });
      }
    } else if (def.type === 'string[]') {
      const ok = Array.isArray(val) && val.every((entry) => typeof entry === 'string');
      if (!ok) {
        issues.push({ prop: key, reason: 'INVALID_PROP_TYPE', expected: 'string[]', actual: val });
      }
    } else if (def.type === 'string' || def.type === 'number' || def.type === 'boolean') {
      if (typeof val !== def.type) {
        issues.push({ prop: key, reason: 'INVALID_PROP_TYPE', expected: def.type, actual: typeof val });
      }
    }
  }

  for (const key of Object.keys(actualProps)) {
    if (!Object.prototype.hasOwnProperty.call(defs, key)) {
      issues.push({ prop: key, reason: 'UNDECLARED_PROP', expected: undefined, actual: actualProps[key] });
    }
  }

  return issues;
}

function computeScore(findings) {
  let penalty = 0;
  const ruleCounts = {};
  for (const f of findings) {
    ruleCounts[f.ruleId] = (ruleCounts[f.ruleId] || 0) + 1;
    const w = Object.prototype.hasOwnProperty.call(SEVERITY_WEIGHT, f.severity)
      ? SEVERITY_WEIGHT[f.severity]
      : 1;
    penalty += w;
  }
  return {
    score: Math.max(0, 100 - penalty),
    penalty: penalty,
    ruleCounts: ruleCounts,
  };
}

function runAudit(options) {
  const opts = options || {};
  const source = opts.source || 'figma';
  const rawList = Array.isArray(opts.anchors) ? opts.anchors : [];
  const registry = opts.registry || null;
  const registryRef = opts.registryRef || (registry && registry.version
    ? { version: registry.version, url: registry.url || '' }
    : null);
  const mode = opts.mode || (registry ? 'registry' : 'generic');
  const isRegistry = mode === 'registry' && Boolean(registry);
  const observedAt = opts.observedAt || new Date().toISOString();
  const maxFontScale = typeof opts.maxFontScale === 'number' ? opts.maxFontScale : 6;
  const validatePropsFn = typeof opts.validateProps === 'function' ? opts.validateProps : defaultValidateProps;
  const treeCounts = opts.treeCounts || null;

  const findings = [];
  const normalizedAnchors = [];
  const siblingCount = new Map();
  const fontSizes = new Set();
  const structSignatures = new Map();

  function pushFinding(ruleId, anchor, severity, evidence) {
    const item = {
      ruleId: ruleId,
      anchor: anchor,
      severity: severity,
      evidence: evidence,
      level: anchor.level,
    };
    if (isRegistry && registryRef && registryRef.version !== undefined) {
      item.registryVersion = registryRef.version;
    }
    findings.push(item);
  }

  // 第一遍：归一化 Anchor 并统计全局信息
  const pairs = rawList.map((raw) => {
    const isUia = source === 'uia' || raw.kind === 'windows-uia';
    const anchor = isUia ? toUiaAnchor(raw, observedAt) : toFigmaAnchor(raw, observedAt);
    normalizedAnchors.push(anchor);

    const parentKey = anchor.path.slice(0, -1).join('/') + '::' + anchor.role + '::' + anchor.name;
    siblingCount.set(parentKey, (siblingCount.get(parentKey) || 0) + 1);

    // 依赖 raw.fontSize（用于 F2 字阶统计）
    if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) {
      fontSizes.add(raw.fontSize);
    }
    // 依赖 raw.childSignature（用于 C1 重复结构判断）
    if (raw.type === 'FRAME' && raw.childSignature) {
      structSignatures.set(raw.childSignature, (structSignatures.get(raw.childSignature) || 0) + 1);
    }
    return { raw: raw, anchor: anchor, parentKey: parentKey };
  });

  // A2：UIA 树未就绪（依赖 options.treeCounts: { before, after }）
  if (source === 'uia' && treeCounts && treeCounts.before !== treeCounts.after && normalizedAnchors.length > 0) {
    pushFinding('A2', normalizedAnchors[0], 'warning', {
      countBefore: treeCounts.before,
      countAfter: treeCounts.after,
    });
  }

  // 第二遍：通用模式规则（G1-G3 / T1-T2 / C1-C2 / X1-X2 / L1 / F1-F2 / A1）
  for (const entry of pairs) {
    const raw = entry.raw;
    const anchor = entry.anchor;
    const parentKey = entry.parentKey;

    // G1：整块不可拆（依赖 raw.hasImageFill, raw.bounds, raw.childCount；UIA 依赖 raw.isOpaque / raw.childCount）
    if (anchor.level === 'opaque') {
      pushFinding('G1', anchor, 'error', {
        type: raw.type || anchor.role,
        hasImageFill: Boolean(raw.hasImageFill),
        childCount: typeof raw.childCount === 'number' ? raw.childCount : 0,
      });
    }

    // G2：默认命名 / 无可寻址标识
    if (anchor.kind === 'figma' && DEFAULT_NAME_RE.test(anchor.name)) {
      pushFinding('G2', anchor, 'warning', { name: anchor.name });
    } else if (anchor.kind === 'windows-uia' && anchor.level === 'L1' && !anchor.name && !anchor.id) {
      pushFinding('G2', anchor, 'warning', { name: anchor.name, id: anchor.id });
    }

    // G3：同父级重名歧义
    if (anchor.level === 'L1' && anchor.name && siblingCount.get(parentKey) > 1) {
      pushFinding('G3', anchor, 'warning', {
        duplicateCount: siblingCount.get(parentKey),
        path: anchor.path,
      });
    }

    if (anchor.kind === 'figma') {
      // T1：填充未绑变量（依赖 raw.fillHex, raw.hasFillVariable）
      if (raw.fillHex && !raw.hasFillVariable) {
        pushFinding('T1', anchor, 'info', { fillHex: raw.fillHex });
      }
      // T2：文字未绑样式（依赖 raw.textStyleId, raw.fontSize）
      if (raw.type === 'TEXT' && !raw.textStyleId) {
        pushFinding('T2', anchor, 'info', { fontSize: raw.fontSize });
      }
      // C1：重复结构却是普通 FRAME（依赖 raw.childSignature）
      if (raw.type === 'FRAME' && raw.childSignature && structSignatures.get(raw.childSignature) >= 3) {
        pushFinding('C1', anchor, 'warning', {
          occurrences: structSignatures.get(raw.childSignature),
          childSignature: raw.childSignature,
        });
      }
      // C2：游离实例（依赖 raw.detachedMainComponent）
      if (raw.type === 'INSTANCE' && raw.detachedMainComponent) {
        pushFinding('C2', anchor, 'warning', { mainComponent: null });
      }
      // X1：文字疑被转成矢量
      if (raw.type === 'VECTOR' && /(text|title|label|文字|标题)/i.test(anchor.name)) {
        pushFinding('X1', anchor, 'warning', { type: raw.type, name: anchor.name });
      }
      // X2：缺字体（依赖 raw.hasMissingFont）
      if (raw.hasMissingFont) {
        pushFinding('X2', anchor, 'error', { hasMissingFont: true });
      }
      // L1：成组控件无自动布局（依赖 raw.layoutMode, raw.childCount）
      if (raw.type === 'FRAME' && raw.layoutMode === 'NONE' && (raw.childCount || 0) >= 3) {
        pushFinding('L1', anchor, 'info', { layoutMode: raw.layoutMode, childCount: raw.childCount });
      }
      // F1：正文与背景对比度低于 4.5:1（依赖 raw.fillHex, raw.parentFillHex）
      if (raw.type === 'TEXT' && raw.fillHex && raw.parentFillHex) {
        const ratio = contrastRatio(raw.fillHex, raw.parentFillHex);
        if (ratio !== null && ratio < 4.5) {
          pushFinding('F1', anchor, 'warning', {
            ratio: Number(ratio.toFixed(2)),
            fg: raw.fillHex,
            bg: raw.parentFillHex,
          });
        }
      }
    }

    if (anchor.kind === 'windows-uia') {
      // A1：控件无任何可用 Pattern（依赖 raw.hasPattern）
      if (anchor.level === 'L1' && raw.hasPattern === false) {
        pushFinding('A1', anchor, 'warning', { role: anchor.role, patterns: [] });
      }
    }
  }

  // F2：全局字阶越界（依赖 raw.fontSize）
  if (fontSizes.size > maxFontScale && normalizedAnchors.length > 0) {
    pushFinding('F2', normalizedAnchors[0], 'info', {
      distinctFontSizes: Array.from(fontSizes).sort((a, b) => a - b),
      limit: maxFontScale,
    });
  }

  // 第三遍：注册表模式规则（R1-R6，主键为 item.id）
  const mappings = [];
  if (isRegistry) {
    const allowedKinds = new Set(Array.isArray(registry.allowedKinds) ? registry.allowedKinds : []);
    const declaredTokens = new Set(Array.isArray(registry.tokens) ? registry.tokens : []);
    const registryItems = new Map();
    const rawItems = Array.isArray(registry.items) ? registry.items : [];
    for (const item of rawItems) {
      if (item && typeof item.id === 'string' && item.id) {
        registryItems.set(item.id, item);
      }
    }
    const matchedIds = new Set();

    for (const entry of pairs) {
      const raw = entry.raw;
      const anchor = entry.anchor;

      // R6：令牌不存在（依赖 raw.boundTokenNames）
      if (Array.isArray(raw.boundTokenNames) && declaredTokens.size > 0) {
        for (const tokenName of raw.boundTokenNames) {
          if (!declaredTokens.has(tokenName)) {
            pushFinding('R6', anchor, 'error', { tokenName: tokenName });
          }
        }
      }

      if (anchor.level !== 'L1') continue;

      // R1：L1 未登记 semanticId
      if (!anchor.semanticId) {
        pushFinding('R1', anchor, 'error', { name: anchor.name, role: anchor.role });
        continue;
      }

      const regItem = registryItems.get(anchor.semanticId);
      // R4：孤立设计节点（注册表里没有该 id）
      if (!regItem) {
        pushFinding('R4', anchor, 'error', { id: anchor.semanticId });
        continue;
      }

      matchedIds.add(regItem.id);
      const resolved = resolveSemanticProps(regItem);
      mappings.push({ nodeId: anchor.id, id: regItem.id, kind: resolved.kind });

      // R2：kind 越界
      if (allowedKinds.size > 0 && !allowedKinds.has(resolved.kind)) {
        pushFinding('R2', anchor, 'error', { id: regItem.id, kind: resolved.kind });
      }

      // R3：props 不合 schema（依赖 raw.props；优先用外部注入的 validateProps）
      const issues = validatePropsFn(regItem, raw.props || {});
      if (Array.isArray(issues) && issues.length > 0) {
        pushFinding('R3', anchor, 'error', {
          id: regItem.id,
          kind: resolved.kind,
          issues: issues,
        });
      }
    }

    // R5：孤立注册项（注册表有登记，但画布/窗口未匹配到）
    for (const entry of registryItems.entries()) {
      const regId = entry[0];
      const item = entry[1];
      if (!matchedIds.has(regId)) {
        const resolved = resolveSemanticProps(item);
        const placeholder = {
          kind: source === 'uia' ? 'windows-uia' : 'figma',
          id: '',
          role: resolved.kind || 'Unknown',
          name: item.label || regId,
          path: [],
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          space: source === 'uia' ? 'screen' : 'canvas',
          level: 'L1',
          stability: source === 'uia' ? 'snapshot' : 'stable',
          observedAt: observedAt,
          semanticId: regId,
        };
        pushFinding('R5', placeholder, 'warning', { id: regId });
      }
    }
  }

  const scored = computeScore(findings);
  const report = {
    protocolVersion: '0.1',
    mode: isRegistry ? 'registry' : 'generic',
    source: source,
    observedAt: observedAt,
    anchors: normalizedAnchors,
    findings: findings,
    summary: {
      score: scored.score,
      penalty: scored.penalty,
      totalAnchors: normalizedAnchors.length,
      totalFindings: findings.length,
      ruleCounts: scored.ruleCounts,
    },
  };
  if (isRegistry) {
    report.registryRef = registryRef;
    report.mappings = mappings;
  }
  return report;
}

module.exports = {
  ERROR_MAP,
  SEVERITY_WEIGHT,
  normalizeError,
  inferFigmaRoleAndLevel,
  toFigmaAnchor,
  toUiaAnchor,
  resolveSemanticProps,
  defaultValidateProps,
  computeScore,
  runAudit,
};