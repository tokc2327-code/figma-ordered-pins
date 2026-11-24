const orderedPins = ((figma, protocol, v0Audit) => {
  const collectionKey = 'vc-ordered-pins';
  const pinKey = 'vc-comment-pin';
  const labelKey = 'vc-pin-label';
  const badgeFont = { family: 'Inter', style: 'Bold' };
  const colors = { pending: '#FACC15', in_progress: '#1D4ED8', done: '#15803D', failed: '#B91C1C' };
  const labels = { pending: '', in_progress: ' …', done: ' ✓', failed: ' ×' };
  const history = new Map();
  let queue = Promise.resolve();

  function fail(code, message) {
    throw Object.assign(new Error(message), { code });
  }

  function paint(hex) {
    const channels = hex.slice(1).match(/../g).map((byte) => parseInt(byte, 16) / 255);
    return { type: 'SOLID', color: { r: channels[0], g: channels[1], b: channels[2] } };
  }

  function firstSolid(paints) {
    return Array.isArray(paints) && paints.find((entry) => entry.type === 'SOLID' && entry.visible !== false);
  }

  function colorHex(entry) {
    return '#' + ['r', 'g', 'b'].map((channel) =>
      Math.round(entry.color[channel] * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function nodeBounds(node) {
    const box = node.absoluteBoundingBox;
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2], width: node.width, height: node.height };
  }

  function snapshot(node) {
    const summary = ({ id, name, type }) => ({ nodeId: id, name, type });
    const result = { ...summary(node), bounds: nodeBounds(node) };
    if (node.type === 'TEXT') {
      const { characters, fontSize, fontName } = node;
      result.text = { characters, fontSize: fontSize === figma.mixed ? 'MIXED' : fontSize };
      if (fontName !== figma.mixed) {
        result.text.fontFamily = fontName.family;
        result.text.fontStyle = fontName.style;
      }
    }
    const style = {};
    const fill = firstSolid(node.fills);
    const stroke = firstSolid(node.strokes);
    if (fill) style.fillHex = colorHex(fill);
    if (stroke) style.strokeHex = colorHex(stroke);
    if (node.cornerRadius !== undefined) {
      style.cornerRadius = node.cornerRadius === figma.mixed ? 'MIXED' : node.cornerRadius;
    }
    if (typeof node.opacity === 'number') style.opacity = node.opacity;
    if (Object.keys(style).length) result.style = style;

    const parentMode = node.parent?.layoutMode;
    if ((node.layoutMode && node.layoutMode !== 'NONE') || (parentMode && parentMode !== 'NONE')) {
      result.layout = { layoutMode: node.layoutMode || 'NONE' };
      if (parentMode) result.layout.parentLayoutMode = parentMode;
      if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
        result.layout.itemSpacing = node.itemSpacing;
        result.layout.padding = {
          top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft,
        };
      }
    }
    if (node.children) result.childrenSummary = node.children.map(summary);
    return result;
  }

  function collection(page) {
    return page.children.find((node) => node.type === 'FRAME' && node.getPluginData(collectionKey) === '1');
  }

  function readPin(marker) {
    try {
      const pin = JSON.parse(marker.getPluginData(pinKey));
      return protocol.isCommentPin(pin) && pin.pinNodeId === marker.id ? pin : null;
    } catch {
      return null;
    }
  }

  function pagePins(page) {
    return (collection(page)?.children || []).flatMap((marker) => {
      const pin = readPin(marker);
      return pin?.anchor.pageId === page.id ? [{ pin, marker }] : [];
    }).sort((a, b) => a.pin.order - b.pin.order || a.pin.pinId.localeCompare(b.pin.pinId));
  }

  function pageOf(node) {
    while (node && node.type !== 'PAGE') node = node.parent;
    return node;
  }

  function isAuxiliary(node) {
    for (; node && node.type !== 'PAGE'; node = node.parent) {
      if (node.getPluginData(collectionKey) === '1') return true;
    }
    return false;
  }

  const semanticIdKey = 'vc-semantic-id';

  function flattenComponentProperties(node) {
    const props = {};
    if (node.type !== 'INSTANCE') return props;
    let rawProps;
    try {
      rawProps = node.componentProperties;
    } catch {
      return props;
    }
    if (!rawProps || typeof rawProps !== 'object') return props;
    for (const [rawKey, entry] of Object.entries(rawProps)) {
      if (!entry || entry.value === undefined) continue;
      const cleanKey = rawKey.replace(/#\d+:\d+$/, '');
      props[cleanKey] = entry.value;
    }
    return props;
  }

  async function collectAuditNodes(roots, maxDepth = 8, maxNodes = 300) {
    const out = [];
    const varNameCache = new Map();

    function resolveVarName(varId) {
      if (!varId || !figma.variables || typeof figma.variables.getVariableByIdAsync !== 'function') {
        return Promise.resolve(null);
      }
      if (!varNameCache.has(varId)) {
        const req = figma.variables.getVariableByIdAsync(varId)
          .then((variable) => (variable && typeof variable.name === 'string' ? variable.name : null))
          .catch(() => null);
        varNameCache.set(varId, req);
      }
      return varNameCache.get(varId);
    }

    async function walk(node, depth, path, parentFillHex) {
      if (!node || out.length >= maxNodes || depth > maxDepth || isAuxiliary(node)) return;
      const nextPath = [...path, node.name];
      const fill = firstSolid(node.fills);
      const fillHex = fill ? colorHex(fill) : undefined;
      const hasImageFill = Array.isArray(node.fills)
        && node.fills.some((entry) => entry.type === 'IMAGE' && entry.visible !== false);
      const boundFillAliases = Array.isArray(node.boundVariables?.fills) ? node.boundVariables.fills : [];
      const boundStrokeAliases = Array.isArray(node.boundVariables?.strokes) ? node.boundVariables.strokes : [];
      const fillVarIds = boundFillAliases.map((alias) => alias && alias.id).filter(Boolean);
      const strokeVarIds = boundStrokeAliases.map((alias) => alias && alias.id).filter(Boolean);
      const allVarIds = [...new Set([...fillVarIds, ...strokeVarIds])];
      const resolvedNames = await Promise.all(allVarIds.map((id) => resolveVarName(id)));
      const boundTokenNames = resolvedNames.filter(Boolean);

      let mainComponent = null;
      let detachedMainComponent = false;
      if (node.type === 'INSTANCE' && typeof node.getMainComponentAsync === 'function') {
        try {
          const mc = await node.getMainComponentAsync();
          if (mc) mainComponent = { id: mc.id, name: mc.name };
          else detachedMainComponent = true;
        } catch {
          detachedMainComponent = true;
        }
      }

      const textStyleId = node.type === 'TEXT' && node.textStyleId && node.textStyleId !== figma.mixed
        ? node.textStyleId
        : undefined;
      const hasMissingFont = Boolean(node.hasMissingFont);
      const semanticId = typeof node.getPluginData === 'function'
        ? (node.getPluginData(semanticIdKey) || undefined)
        : undefined;
      let props = {};
      if (node.type === 'TEXT') props = { text: node.characters };
      else if (node.type === 'INSTANCE') props = flattenComponentProperties(node);

      const children = Array.isArray(node.children) ? node.children : [];
      const childSignature = children.length > 0
        ? children.slice(0, 10).map((child) => child.type).join('>')
        : undefined;
      out.push({
        id: node.id, name: node.name, type: node.type, depth, path: nextPath,
        bounds: nodeBounds(node), childCount: children.length, childSignature,
        fillHex, parentFillHex, hasImageFill,
        boundVariables: allVarIds.length > 0 ? { fills: fillVarIds, strokes: strokeVarIds } : undefined,
        hasFillVariable: fillVarIds.length > 0, boundTokenNames,
        mainComponent, detachedMainComponent, textStyleId,
        fontSize: node.type === 'TEXT' && typeof node.fontSize === 'number' ? node.fontSize : undefined,
        hasMissingFont, layoutMode: node.layoutMode, layoutPositioning: node.layoutPositioning,
        semanticId, props,
      });
      for (const child of children) {
        if (out.length >= maxNodes) break;
        await walk(child, depth + 1, nextPath, fillHex || parentFillHex);
      }
    }

    for (const root of roots) {
      if (out.length >= maxNodes) break;
      await walk(root, 1, [], undefined);
    }
    return out;
  }

  function assertPage(page) {
    if (figma.currentPage.id !== page.id) fail('SCOPE_DENIED', '当前页面已变更，请重新读取标注。');
  }

  async function resolveAnchor(pin, page) {
    const node = await figma.getNodeByIdAsync(pin.anchor.nodeId);
    return node && !node.removed && pageOf(node)?.id === page.id && !isAuxiliary(node) ? node : null;
  }

  async function getPins(page, payload) {
    const rows = pagePins(page).filter(({ pin }) => !payload.statusFilter || payload.statusFilter.includes(pin.status));
    const data = await Promise.all(rows.map(async ({ pin }) => {
      const anchor = await resolveAnchor(pin, page);
      if (!anchor) return { pin, orphaned: true };
      return payload.includeContext === false ? { pin } : { pin, context: snapshot(anchor) };
    }));
    assertPage(page);
    return data;
  }

  function fontsOf(node) {
    return node.fontName === figma.mixed
      ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
  }

  async function loadFonts(node, requestedStyle) {
    const fonts = fontsOf(node);
    const families = [...new Set(fonts.map((font) => font.family))];
    if (node.hasMissingFont || !fonts.length) fail('FONT_LOAD_FAILED', '目标文字缺少可用字体。');
    if (requestedStyle && families.length !== 1) {
      fail('INVALID_PARAMS', '设置字重需使用同一字体家族的文字。');
    }
    const target = requestedStyle === undefined ? undefined : { family: families[0], style: requestedStyle };
    const required = new Map([...fonts, ...(target ? [target] : [])].map((font) => [JSON.stringify(font), font]));
    try {
      await Promise.all([...required.values()].map((font) => figma.loadFontAsync(font)));
    } catch (error) {
      fail('FONT_LOAD_FAILED', error.message || '无法加载字体。');
    }
    return { target, signature: JSON.stringify(fonts) };
  }

  function editText(node, payload, targetFont, set) {
    if (payload.characters !== undefined) set(node, 'characters', payload.characters);
    if (payload.fontSize !== undefined) set(node, 'fontSize', payload.fontSize);
    if (targetFont && (node.fontName === figma.mixed || node.fontName.style !== targetFont.style)) {
      set(node, 'fontName', targetFont);
    }
  }

  function editStyle(node, payload, set) {
    const fields = { fillHex: 'fills', strokeHex: 'strokes', cornerRadius: 'cornerRadius', opacity: 'opacity' };
    for (const field of Object.keys(payload)) {
      if (field !== 'nodeId' && !(fields[field] in node)) fail('INVALID_PARAMS', '该节点不支持属性 ' + field);
    }
    for (const [field, property] of Object.entries(fields)) {
      if (payload[field] === undefined) continue;
      if (field.endsWith('Hex')) {
        const paints = node[property];
        if (!Array.isArray(paints)) fail('INVALID_PARAMS', '请先统一混合填充或描边。');
        const previous = firstSolid(paints);
        const next = paint(payload[field]);
        if (!previous || colorHex(previous) !== payload[field].toUpperCase()) {
          set(node, property, previous
            ? paints.map((entry) => entry === previous ? { ...previous, color: next.color } : entry)
            : [next, ...paints]);
        }
      } else {
        set(node, property, payload[field]);
      }
    }
  }

  function editLayout(node, payload, set, resize) {
    if ((payload.itemSpacing !== undefined || payload.padding)
      && node.layoutMode !== 'HORIZONTAL' && node.layoutMode !== 'VERTICAL') {
      fail('INVALID_PARAMS', '间距和内边距需要横向或纵向 Auto Layout。');
    }
    if ((payload.x !== undefined || payload.y !== undefined)
      && node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE') {
      fail('INVALID_PARAMS', 'Auto Layout 流内节点的位置由父级控制。');
    }
    if (payload.width !== undefined || payload.height !== undefined) {
      if (typeof node.resize !== 'function') fail('INVALID_PARAMS', '该节点不支持调整尺寸。');
      resize(node, payload.width ?? node.width, payload.height ?? node.height);
    }
    for (const property of ['x', 'y', 'itemSpacing']) {
      if (payload[property] !== undefined) set(node, property, payload[property]);
    }
    for (const [side, value] of Object.entries(payload.padding || {})) {
      set(node, 'padding' + side[0].toUpperCase() + side.slice(1), value);
    }
  }

  // badge 上要看得见「评论了什么」:编号 + 指令摘要。全文仍存在 pin 的 pluginData 里。
  function badgeText(pin) {
    const instruction = String(pin.instruction || '').replace(/\s+/g, ' ').trim();
    const excerpt = instruction.length > 14 ? instruction.slice(0, 14) + '…' : instruction;
    return '#' + pin.order + (excerpt ? ' · ' + excerpt : '') + labels[pin.status];
  }

  function editMarker(marker, label, pin, set) {
    const state = pin.status;
    set(marker, 'fills', [paint(colors[state])]);
    set(label, 'fills', [paint(state === 'pending' ? '#111827' : '#FFFFFF')]);
    set(label, 'characters', badgeText(pin));
  }

  function transaction(operation) {
    let changed = false;
    const change = (mutate) => {
      mutate();
      changed = true;
    };
    const set = (node, property, value) => {
      if (node[property] !== value) change(() => { node[property] = value; });
    };
    const resize = (node, width, height) => {
      if (node.width !== width || node.height !== height) change(() => node.resize(width, height));
    };
    try {
      const result = operation({ change, set, resize });
      if (changed) figma.commitUndo();
      return result;
    } catch (error) {
      if (changed) figma.triggerUndo();
      throw error;
    }
  }

  function verifyLayout(node, payload) {
    for (const field of ['width', 'height', 'x', 'y', 'itemSpacing']) {
      if (payload[field] !== undefined && Math.abs(node[field] - payload[field]) > 0.01) {
        fail('WRITE_FAILED', 'Figma 未保留请求的布局属性 ' + field);
      }
    }
    for (const [side, value] of Object.entries(payload.padding || {})) {
      if (Math.abs(node['padding' + side[0].toUpperCase() + side.slice(1)] - value) > 0.01) {
        fail('WRITE_FAILED', 'Figma 未保留请求的内边距 ' + side);
      }
    }
  }

  async function execute(page, command) {
    const { commandId, type, payload, pinId, expectedVersion } = command;
    if (type === 'get_ordered_pins') {
      const result = { commandId, ok: true, data: await getPins(page, payload) };
      if (!protocol.isCommandResult(result, type)) fail('WRITE_FAILED', '无法读取有效的标注列表。');
      return result;
    }
    if (type === 'add_pin') {
      // agent 走桥接打点时不一定有人在面板上选中东西,所以允许直接给 nodeId;给了就以它为准。
      const node = payload.nodeId === undefined ? null : await figma.getNodeByIdAsync(payload.nodeId);
      if (payload.nodeId !== undefined && (!node || node.removed)) {
        fail('ANCHOR_NOT_FOUND', '找不到 nodeId 指定的图层。');
      }
      const target = node || (page.selection.length === 1 ? page.selection[0] : null);
      const pin = await addPin(page, target, payload.instruction);
      const result = { commandId, ok: true, data: pin };
      if (!protocol.isCommandResult(result, type)) fail('WRITE_FAILED', '无法读取有效的新标注。');
      return result;
    }
    if (type === 'audit_visual') {
      const roots = payload.scope === 'page'
        ? [page]
        : (page.selection.length > 0 ? Array.from(page.selection) : [page]);
      const rawNodes = await collectAuditNodes(roots, payload.maxDepth ?? 8, payload.maxNodes ?? 300);
      assertPage(page);
      const data = v0Audit.runAudit({
        source: 'figma', anchors: rawNodes,
        mode: payload.mode || (payload.registry ? 'registry' : 'generic'),
        observedAt: new Date().toISOString(), registryRef: payload.registryRef, registry: payload.registry,
      });
      const result = { commandId, ok: true, data };
      if (!protocol.isCommandResult(result, type)) fail('WRITE_FAILED', '无法生成有效的视觉审计报告。');
      return result;
    }
    const entry = pagePins(page).find(({ pin }) => pin.pinId === pinId);
    if (!entry) fail('ANCHOR_NOT_FOUND', '当前页没有该标注。');
    const { marker, pin } = entry;
    if (pin.version !== expectedVersion) fail('VERSION_CONFLICT', '请重新读取该标注的当前版本。');
    const anchor = type === 'update_pin_status' ? null : await resolveAnchor(pin, page);
    if (type !== 'update_pin_status' && !anchor) fail('ANCHOR_NOT_FOUND', '标注目标已经丢失。');
    const node = anchor && (payload.nodeId === anchor.id ? anchor
      : anchor.children?.find((child) => child.id === payload.nodeId));
    if (anchor && !node) fail('SCOPE_DENIED', '仅允许修改标注目标及其直接子图层。');

    let fonts;
    let label;
    if (type === 'update_text') {
      if (node.type !== 'TEXT') fail('INVALID_PARAMS', '目标必须是文字图层。');
      fonts = await loadFonts(node, payload.fontStyle);
    }
    if (type === 'update_pin_status') {
      label = marker.children.find((child) => child.type === 'TEXT' && child.getPluginData(labelKey) === '1');
      if (!label) fail('ANCHOR_NOT_FOUND', '标注图形缺少编号。');
      fonts = await loadFonts(label);
    }
    assertPage(page);
    if (marker.removed || marker.parent !== collection(page) || readPin(marker)?.version !== expectedVersion) {
      fail('VERSION_CONFLICT', '标注已变更，请重新读取。');
    }
    if (anchor && (node.removed || anchor.removed || pageOf(anchor)?.id !== page.id
      || (node !== anchor && node.parent !== anchor) || isAuxiliary(node))) {
      fail('SCOPE_DENIED', '等待期间目标已移出标注范围。');
    }
    if (label && (label.removed || label.parent !== marker)) fail('ANCHOR_NOT_FOUND', '标注编号已移除。');
    if (fonts && JSON.stringify(fontsOf(label || node)) !== fonts.signature) {
      fail('FONT_LOAD_FAILED', '等待期间文字字体已变更，请重试。');
    }

    const next = { ...pin, version: pin.version + 1, updatedAt: new Date().toISOString() };
    return transaction(({ set, resize, change }) => {
      if (type === 'update_text') editText(node, payload, fonts.target, set);
      if (type === 'update_style') editStyle(node, payload, set);
      if (type === 'update_layout') {
        editLayout(node, payload, set, resize);
        verifyLayout(node, payload);
      }
      if (type === 'update_pin_status') {
        next.status = payload.status;
        delete next.lastError;
        if (payload.status === 'failed' && payload.note !== undefined) next.lastError = payload.note;
        editMarker(marker, label, next, set);
        if (label.characters !== badgeText(next)
          || colorHex(firstSolid(marker.fills)) !== colors[next.status]) {
          fail('WRITE_FAILED', '标注颜色或编号回读异常。');
        }
      }
      change(() => marker.setPluginData(pinKey, JSON.stringify(next)));
      const saved = readPin(marker);
      if (saved?.version !== next.version) fail('WRITE_FAILED', '标注版本回读异常。');
      const data = type === 'update_pin_status'
        ? { pin: saved, pendingCount: pagePins(page).filter((row) => row.pin.status === 'pending').length }
        : snapshot(node);
      if (type === 'update_text' || type === 'update_style') {
        const properties = type === 'update_text' ? data.text : data.style;
        for (const [field, value] of Object.entries(payload)) {
          if (field === 'nodeId') continue;
          const requested = field.endsWith('Hex') ? value.toUpperCase() : value;
          if (properties?.[field] !== requested
            && !(typeof requested === 'number' && Math.abs(properties?.[field] - requested) < 0.01)) {
            fail('WRITE_FAILED', 'Figma 未保留请求的属性 ' + field);
          }
        }
      }
      const result = { commandId, ok: true, data, newVersion: saved.version };
      if (!protocol.isCommandResult(result, type)) fail('WRITE_FAILED', '写后状态回读异常。');
      return result;
    });
  }

  async function addPin(page, node, instruction) {
    if (!node || typeof instruction !== 'string' || !instruction.trim()) {
      fail('INVALID_PARAMS', '请选中一个目标图层并填写修改指令。');
    }
    await figma.loadFontAsync(badgeFont);
    assertPage(page);
    if (node.removed || pageOf(node)?.id !== page.id || isAuxiliary(node)) {
      fail('SCOPE_DENIED', '请选择当前页中的设计图层。');
    }
    const fallbackBounds = nodeBounds(node);
    const namePath = [];
    for (let item = node; item && item !== page; item = item.parent) namePath.unshift(item.name);
    const order = (pagePins(page).at(-1)?.pin.order || 0) + 1;
    return transaction(({ change, set }) => {
      let layer = collection(page);
      if (!layer) {
        change(() => { layer = figma.createFrame(); });
        layer.name = '__VC_Pins__';
        layer.fills = [];
        layer.clipsContent = false;
        layer.resize(1, 1);
        layer.setPluginData(collectionKey, '1');
      }
      let marker;
      change(() => { marker = figma.createFrame(); });
      marker.name = '#' + order;
      marker.resize(200, 24);
      marker.cornerRadius = 12;
      layer.appendChild(marker);
      marker.x = fallbackBounds.x - layer.absoluteTransform[0][2] - 30;
      marker.y = fallbackBounds.y - layer.absoluteTransform[1][2] - 28;
      const otherMarkers = layer.children.filter((child) => child !== marker);
      while (otherMarkers.some((child) => child.x < marker.x + marker.width && marker.x < child.x + child.width
        && child.y < marker.y + marker.height && marker.y < child.y + child.height)) {
        marker.y -= marker.height + 4;
      }
      let label;
      change(() => { label = figma.createText(); });
      marker.appendChild(label);
      label.fontName = badgeFont;
      label.fontSize = 13;
      label.textAutoResize = 'TRUNCATE';
      label.textTruncation = 'ENDING';
      label.resize(184, 16);
      label.x = 8;
      label.y = 4;
      label.setPluginData(labelKey, '1');
      const pin = {
        schemaVersion: '0.1', pinId: page.id + '/' + marker.id, pinNodeId: marker.id, order,
        instruction: instruction.trim(), status: 'pending', version: 1,
        anchor: { nodeId: node.id, pageId: page.id, namePath, nodeType: node.type, fallbackBounds },
        updatedAt: new Date().toISOString(),
      };
      editMarker(marker, label, pin, set);
      marker.setPluginData(pinKey, JSON.stringify(pin));
      const saved = readPin(marker);
      if (!saved) fail('WRITE_FAILED', '未能回读新标注。');
      return saved;
    });
  }

  function errorResult(commandId, error) {
    const code = Object.prototype.hasOwnProperty.call(protocol.errorStatuses, error.code) ? error.code : 'WRITE_FAILED';
    return { commandId, ok: false, error: {
      code, httpStatus: protocol.errorStatuses[code], message: error.message || String(error),
    } };
  }

  function enqueue(operation) {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  }

  function command(envelope) {
    const page = figma.currentPage;
    return enqueue(async () => {
      const commandId = typeof envelope?.commandId === 'string' && envelope.commandId.trim()
        ? envelope.commandId : 'invalid';
      try {
        if (!protocol.isCommandEnvelope(envelope)) fail('INVALID_PARAMS', '命令格式或写入版本无效。');
        assertPage(page);
        const canonical = (value) => value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
        const fingerprint = JSON.stringify(canonical(envelope));
        const previous = history.get(commandId);
        if (previous) {
          if (previous.pageId !== page.id || previous.fingerprint !== fingerprint) {
            fail('INVALID_PARAMS', 'commandId 已用于不同的请求。');
          }
          return previous.result;
        }
        let result;
        try {
          result = await execute(page, envelope);
        } catch (error) {
          result = errorResult(commandId, error);
        }
        history.set(commandId, { pageId: page.id, fingerprint, result });
        if (history.size > 50) history.delete(history.keys().next().value);
        return result;
      } catch (error) {
        return errorResult(commandId, error);
      }
    });
  }

  return {
    command,
    // 面板表单走这里:不传 nodeId 就用当前选区。
    add(instruction, nodeId) {
      return enqueue(async () => {
        const page = figma.currentPage;
        const node = nodeId ? await figma.getNodeByIdAsync(nodeId) : null;
        if (nodeId && (!node || node.removed)) fail('ANCHOR_NOT_FOUND', '找不到 nodeId 指定的图层。');
        return addPin(page, node || (page.selection.length === 1 ? page.selection[0] : null), instruction);
      });
    },
  };
})(figma, pinProtocol, v0Audit);
