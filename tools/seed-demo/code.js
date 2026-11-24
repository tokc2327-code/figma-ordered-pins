// 一次性 dev 插件：按注册表规格在 Figma 里新建一页并搭出一张设计稿。
// 每个 L1 图层都挂 vc-semantic-id + vc-semantic-props，供 audit_visual 的 registry 模式核对。
// 其中故意留了 3 处不合规（见文件末尾），用来验证规则能抓到。

const SPEC = {
  colors: {
    'color/surface/base': '#FFFFFF',
    'color/surface/raised': '#F5F6F8',
    'color/text/primary': '#1A1A1A',
    'color/text/muted': '#5B6472',
    'color/brand/primary': '#2F6BFF',
    'color/on-brand': '#FFFFFF',
  },
  pageName: 'Demo / 按规格 2026-11-24',
  screenName: 'VC / 协作首页',
};

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/../g);
  return {
    r: parseInt(m[0], 16) / 255,
    g: parseInt(m[1], 16) / 255,
    b: parseInt(m[2], 16) / 255,
  };
}

const fonts = {
  regular: { family: 'Inter', style: 'Regular' },
  medium: { family: 'Inter', style: 'Medium' },
  bold: { family: 'Inter', style: 'Bold' },
};

let vars = {};
let styles = {};

function paint(varName) {
  const base = { type: 'SOLID', color: hexToRgb(SPEC.colors[varName]) };
  const v = vars[varName];
  if (!v) return base;
  try {
    return figma.variables.setBoundVariableForPaint(base, 'color', v);
  } catch (e) {
    return base;
  }
}

function frame(opts) {
  const f = figma.createFrame();
  f.name = opts.name;
  f.fills = opts.fill ? [paint(opts.fill)] : [];
  f.cornerRadius = opts.radius || 0;
  if (opts.layout) {
    f.layoutMode = opts.layout;
    f.primaryAxisSizingMode = 'AUTO';
    f.counterAxisSizingMode = 'AUTO';
    f.itemSpacing = opts.spacing || 0;
    f.paddingTop = opts.pad || 0;
    f.paddingBottom = opts.pad || 0;
    f.paddingLeft = opts.pad || 0;
    f.paddingRight = opts.pad || 0;
  }
  if (opts.size) f.resize(opts.size[0], opts.size[1]);
  if (opts.alignStretch) f.layoutAlign = 'STRETCH';
  if (opts.grow) f.layoutGrow = opts.grow;
  if (opts.crossAxisAlign) f.counterAxisAlignItems = opts.crossAxisAlign;
  if (opts.mainAxisAlign) f.primaryAxisAlignItems = opts.mainAxisAlign;
  return f;
}

function text(str, styleName, color) {
  const t = figma.createText();
  t.fontName = fonts.regular;
  t.textAutoResize = 'WIDTH_AND_HEIGHT';
  t.characters = str;
  t.name = str;
  t.fills = [paint(color || 'color/text/primary')];
  const s = styles[styleName];
  if (s) {
    try {
      t.textStyleId = s.id;
    } catch (e) {
      t.fontSize = styleName === 'heading' ? 20 : styleName === 'caption' ? 12 : 13;
    }
  }
  return t;
}

function semantic(node, id, props) {
  // 读规格的是另一个插件，pluginData 按插件 id 隔离，所以必须写 sharedPluginData
  node.setSharedPluginData('vc_semantic', 'semantic-id', id);
  node.setSharedPluginData('vc_semantic', 'semantic-props', JSON.stringify(props || {}));
}

async function ensureStyles() {
  for (const key of ['regular', 'medium', 'bold']) {
    await figma.loadFontAsync(fonts[key]);
  }
  const specs = { heading: 20, body: 13, caption: 12 };
  for (const name of Object.keys(specs)) {
    const s = figma.createTextStyle();
    s.name = 'VC Demo / ' + name;
    s.fontName = name === 'heading' ? fonts.bold : fonts.regular;
    s.fontSize = specs[name];
    styles[name] = s;
  }
}

function ensureVars() {
  const coll = figma.variables.createVariableCollection('VC Demo Tokens');
  const modeId = coll.modes[0].modeId;
  for (const name of Object.keys(SPEC.colors)) {
    const v = figma.variables.createVariable(name, coll, 'COLOR');
    const rgb = hexToRgb(SPEC.colors[name]);
    v.setValueForMode(modeId, { r: rgb.r, g: rgb.g, b: rgb.b, a: 1 });
    vars[name] = v;
  }
}

function buildButton(label, tone, semanticProps) {
  const solid = tone === 'solid';
  const b = frame({
    name: '按钮 / ' + label,
    layout: 'HORIZONTAL',
    spacing: 8,
    pad: 10,
    radius: 8,
    fill: solid ? 'color/brand/primary' : 'color/surface/raised',
    crossAxisAlign: 'CENTER',
  });
  b.paddingLeft = 16;
  b.paddingRight = 16;
  b.appendChild(text(label, 'body', solid ? 'color/on-brand' : 'color/text/primary'));
  semantic(b, 'button/primary', semanticProps);
  return b;
}

function buildStatCard(iconKind, value, label, props) {
  const card = frame({
    name: '统计卡 / ' + value,
    layout: 'VERTICAL',
    spacing: 6,
    pad: 16,
    radius: 12,
    fill: 'color/surface/raised',
    grow: 1,
  });
  let icon;
  if (iconKind === 'rect') icon = figma.createRectangle();
  else if (iconKind === 'ellipse') icon = figma.createEllipse();
  else icon = figma.createPolygon();
  icon.name = '图标';
  icon.resize(20, 20);
  icon.cornerRadius = 4;
  icon.fills = [paint('color/brand/primary')];
  card.appendChild(icon);
  card.appendChild(text(value, 'heading'));
  card.appendChild(text(label, 'caption', 'color/text/muted'));
  semantic(card, 'card/stat', props);
  return card;
}

function buildRow(iconKind, title, status, props) {
  const row = frame({
    name: '任务行 / ' + title,
    layout: 'HORIZONTAL',
    spacing: 10,
    pad: 12,
    radius: 10,
    fill: 'color/surface/raised',
    alignStretch: true,
    crossAxisAlign: 'CENTER',
  });
  if (iconKind === 'rect') {
    const dot = figma.createRectangle();
    dot.name = '状态点';
    dot.resize(8, 8);
    dot.cornerRadius = 4;
    dot.fills = [paint('color/brand/primary')];
    row.appendChild(dot);
  } else if (iconKind === 'ellipse') {
    const dot = figma.createEllipse();
    dot.name = '状态点';
    dot.resize(8, 8);
    dot.fills = [paint('color/brand/primary')];
    row.appendChild(dot);
  }
  row.appendChild(text(title, 'body'));
  const spacer = figma.createFrame();
  spacer.name = '弹性空位';
  spacer.fills = [];
  spacer.resize(1, 1);
  spacer.layoutGrow = 1;
  row.appendChild(spacer);
  row.appendChild(text(status, 'caption', 'color/text/muted'));
  semantic(row, 'row/task', props);
  return row;
}

(async () => {
  try {
    await ensureStyles();
    ensureVars();

    let page = figma.root.children.find((p) => p.name === SPEC.pageName);
    if (page) {
      await figma.setCurrentPageAsync(page);
      for (const child of [...page.children]) {
        try { child.remove(); } catch (e) { /* 清不掉的先留着 */ }
      }
    } else {
      page = figma.createPage();
      page.name = SPEC.pageName;
      await figma.setCurrentPageAsync(page);
    }

    const screen = frame({
      name: SPEC.screenName,
      layout: 'VERTICAL',
      spacing: 20,
      pad: 32,
      fill: 'color/surface/base',
      size: [1040, 700],
    });
    screen.primaryAxisSizingMode = 'FIXED';
    screen.counterAxisSizingMode = 'FIXED';
    page.appendChild(screen);
    semantic(screen, 'screen/home', { title: '协作首页', route: '/home' });

    // 页头
    const header = frame({
      name: '页头',
      layout: 'HORIZONTAL',
      spacing: 12,
      alignStretch: true,
      crossAxisAlign: 'CENTER',
    });
    header.appendChild(text('协作首页', 'heading'));
    const gap = figma.createFrame();
    gap.name = '弹性空位';
    gap.fills = [];
    gap.resize(1, 1);
    gap.layoutGrow = 1;
    header.appendChild(gap);
    header.appendChild(buildButton('邀请成员', 'outline', { label: '邀请成员', tone: 'outline' }));
    header.appendChild(buildButton('新建协作', 'solid', { label: '新建协作', tone: 'solid' }));
    semantic(header, 'layout/header', { title: '协作首页' });
    screen.appendChild(header);

    // 统计卡
    const stats = frame({ name: '统计区', layout: 'HORIZONTAL', spacing: 16, alignStretch: true });
    stats.appendChild(buildStatCard('rect', '12', '进行中的协作', { label: '进行中的协作', value: '12' }));
    // 故意：缺必填 label
    stats.appendChild(buildStatCard('ellipse', '4', '本周完成', { value: '4' }));
    stats.appendChild(buildStatCard('polygon', '2', '待我确认', { label: '待我确认', value: '2' }));
    screen.appendChild(stats);

    // 任务列表
    const list = frame({ name: '任务列表', layout: 'VERTICAL', spacing: 8, alignStretch: true });
    list.appendChild(buildRow('rect', '首页改版评审', '进行中', { title: '首页改版评审', status: 'in_progress' }));
    list.appendChild(buildRow('ellipse', '共享组件库整理', '待处理', { title: '共享组件库整理', status: 'pending' }));
    list.appendChild(buildRow('none', '标记规范补充', '已完成', { title: '标记规范补充', status: 'done' }));
    screen.appendChild(list);

    // 故意：注册表里没有 card/promo（R4 未登记）
    const promo = frame({
      name: '推广卡',
      layout: 'VERTICAL',
      spacing: 6,
      pad: 16,
      radius: 12,
      fill: 'color/surface/raised',
      alignStretch: true,
    });
    promo.appendChild(text('把团队拉进同一个画布', 'body'));
    promo.appendChild(text('邀请成员开始协作', 'caption', 'color/text/muted'));
    semantic(promo, 'card/promo', { label: '推广卡' });
    screen.appendChild(promo);

    // 故意：tone 用了规格外的值
    const badButton = buildButton('导入设计', 'outline', { label: '导入设计', tone: 'ghost' });
    badButton.layoutAlign = 'STRETCH';
    screen.appendChild(badButton);

    // 收尾：父级定下来之后再设一次拉伸，否则子节点会缩成最小宽度
    const fill = (node) => {
      try { node.layoutSizingHorizontal = 'FILL'; return; } catch (e) { /* 老 API 兜底 */ }
      try { node.layoutAlign = 'STRETCH'; } catch (e2) { /* ignore */ }
    };
    for (const child of screen.children) fill(child);
    for (const card of stats.children) fill(card);
    const stack = [screen];
    while (stack.length) {
      const node = stack.pop();
      for (const child of node.children || []) {
        if (child.name === '弹性空位') fill(child);
        stack.push(child);
      }
    }

    figma.viewport.scrollAndZoomIntoView([screen]);
    figma.closePlugin('seeded: ' + screen.children.length + ' top-level children');
  } catch (e) {
    const msg = 'SEED FAILED: ' + (e && e.message ? e.message : String(e)) + '\n' + (e && e.stack ? e.stack : '');
    try {
      const host = figma.currentPage;
      const box = figma.createFrame();
      box.name = 'SEED ERROR';
      box.fills = [{ type: 'SOLID', color: { r: 1, g: 0.9, b: 0.9 } }];
      box.resize(900, 220);
      box.x = 0;
      box.y = 0;
      host.appendChild(box);
      const t = figma.createText();
      t.fontName = { family: 'Inter', style: 'Regular' };
      t.fontSize = 11;
      t.textAutoResize = 'HEIGHT';
      t.resize(880, 200);
      t.characters = msg;
      box.appendChild(t);
      box.x = 40;
      box.y = 40;
    } catch (inner) { /* 连错误框都建不出来就没办法了 */ }
    figma.closePlugin(msg);
  }
})();
