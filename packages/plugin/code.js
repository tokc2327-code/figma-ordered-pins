const MAX_NODES = 5000;
const MAX_DEPTH = 50;
// 多选时随 figmaTarget 一起发送的图层数上限，避免全选几千个图层时消息过大。
const MAX_TARGET_NODES = 50;

figma.skipInvisibleInstanceChildren = true;
figma.showUI(__html__, { width: 560, height: 680, themeColors: true });

function errorMessage(error) {
  return (error && error.message) || String(error);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function serializeBounds(bounds) {
  if (!bounds) return null;

  return {
    x: numberOrNull(bounds.x),
    y: numberOrNull(bounds.y),
    width: numberOrNull(bounds.width),
    height: numberOrNull(bounds.height),
  };
}

function markTruncated(node, reason, state) {
  node.truncated = true;
  if (!node.truncationReasons) node.truncationReasons = [];
  if (!node.truncationReasons.includes(reason)) node.truncationReasons.push(reason);

  if (reason === 'MAX_NODES') state.truncation.nodeLimitReached = true;
  if (reason === 'MAX_DEPTH') state.truncation.depthLimitReached = true;
}

// 深度优先、按 Figma 图层面板中的原始顺序序列化；根节点深度为 1。
function serializeNode(node, depth, state) {
  state.nodeCount += 1;

  const serialized = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: typeof node.visible === 'boolean' ? node.visible : null,
    absoluteBoundingBox: serializeBounds(node.absoluteBoundingBox),
    width: numberOrNull(node.width),
    height: numberOrNull(node.height),
    children: [],
  };
  const children = node.children || [];

  if (children.length === 0) return serialized;

  if (depth >= state.limits.maxDepth) {
    markTruncated(serialized, 'MAX_DEPTH', state);
    return serialized;
  }

  for (const child of children) {
    if (state.nodeCount >= state.limits.maxNodes) {
      markTruncated(serialized, 'MAX_NODES', state);
      break;
    }

    serialized.children.push(serializeNode(child, depth + 1, state));
  }

  return serialized;
}

function serializeTrees(roots, limits) {
  const effectiveLimits = {
    maxNodes: limits && limits.maxNodes !== undefined ? limits.maxNodes : MAX_NODES,
    maxDepth: limits && limits.maxDepth !== undefined ? limits.maxDepth : MAX_DEPTH,
  };
  const state = {
    limits: effectiveLimits,
    nodeCount: 0,
    truncation: {
      nodeLimitReached: false,
      depthLimitReached: false,
    },
  };
  const nodes = [];

  for (const root of roots) {
    if (state.nodeCount >= state.limits.maxNodes) {
      state.truncation.nodeLimitReached = true;
      break;
    }
    nodes.push(serializeNode(root, 1, state));
  }

  return {
    limits: effectiveLimits,
    nodeCount: state.nodeCount,
    truncated: state.truncation.nodeLimitReached || state.truncation.depthLimitReached,
    truncation: state.truncation,
    nodes,
  };
}

function buildExport(scope) {
  const page = figma.currentPage;
  const roots = scope === 'selection' ? Array.from(page.selection) : [page];
  const tree = serializeTrees(roots);

  return {
    version: 1,
    scope,
    exportedAt: new Date().toISOString(),
    page: {
      id: page.id,
      name: page.name,
    },
    limits: tree.limits,
    nodeCount: tree.nodeCount,
    truncated: tree.truncated,
    truncation: tree.truncation,
    nodes: tree.nodes,
  };
}

function postExport(scope) {
  try {
    const payload = buildExport(scope);
    figma.ui.postMessage({
      type: 'layer-tree',
      json: JSON.stringify(payload, null, 2),
      summary: {
        scope: payload.scope,
        nodeCount: payload.nodeCount,
        truncated: payload.truncated,
      },
    });
  } catch (error) {
    figma.ui.postMessage({
      type: 'export-error',
      message: errorMessage(error),
    });
  }
}

function buildFigmaTarget() {
  const page = figma.currentPage;
  const selection = page && page.selection ? Array.from(page.selection) : [];
  if (selection.length === 0) return null;

  const primary = selection[0];
  // fileKey 仅在私有插件（manifest 中 enablePrivatePluginApi）下可用；取不到时 link 为 null。
  const fileKey = figma.fileKey || null;
  const fileName = figma.root && figma.root.name ? figma.root.name : null;
  const targetId = primary.id || null;
  const link =
    fileKey && targetId
      ? 'https://www.figma.com/design/' + fileKey + '?node-id=' + encodeURIComponent(targetId.replace(/:/g, '-'))
      : null;

  const target = {
    id: targetId,
    name: primary.name,
    type: primary.type,
    absoluteBoundingBox: serializeBounds(primary.absoluteBoundingBox),
    pageId: page ? page.id : null,
    pageName: page ? page.name : null,
    fileKey,
    fileName,
    link,
  };

  if (selection.length > 1) {
    target.nodes = selection.slice(0, MAX_TARGET_NODES).map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      absoluteBoundingBox: serializeBounds(node.absoluteBoundingBox),
    }));
    target.nodesTotal = selection.length;
    target.nodesTruncated = selection.length > MAX_TARGET_NODES;
  }

  return target;
}

function postSelectionTarget() {
  try {
    const figmaTarget = buildFigmaTarget();
    figma.ui.postMessage({
      type: 'selection-target',
      figmaTarget,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: 'selection-target-error',
      message: errorMessage(error),
    });
  }
}

// 选择变化时只推送轻量的 figmaTarget；完整子树改为用户点“读取选中”时按需导出，
// 这样既避免大选区下的同步大序列化，也不会覆盖用户刚读取的整页结果。
figma.on('selectionchange', () => {
  postSelectionTarget();
});

figma.on('currentpagechange', () => {
  postSelectionTarget();
});

figma.ui.onmessage = (message) => {
  if (!message) return;

  if (message.type === 'export-page') {
    postExport('page');
    postSelectionTarget();
  } else if (message.type === 'export-selection') {
    postExport('selection');
    postSelectionTarget();
  } else if (message.type === 'ordered-pin-command') {
    return orderedPins.command(message.envelope).then((result) => {
      figma.ui.postMessage({ type: 'ordered-pin-result', result });
    });
  } else if (message.type === 'ordered-pin-add') {
    return orderedPins.add(message.instruction).then(
      (pin) => figma.ui.postMessage({ type: 'ordered-pin-added', pin }),
      (error) => figma.ui.postMessage({ type: 'ordered-pin-add-error', message: errorMessage(error) }),
    );
  }
};

postExport('page');
postSelectionTarget();
