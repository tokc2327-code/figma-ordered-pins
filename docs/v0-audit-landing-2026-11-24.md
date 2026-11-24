# v0-audit 落地记录（2026-11-24）

## 改动文件

- `packages/protocol/v0-audit.cjs`：从任务材料逐字复制，SHA-256 与源文件一致；未调整规则判法。
- `packages/protocol/v0-audit.test.cjs`：新增 9 个独立的引擎单测。
- `packages/plugin/ordered-pins.js`：补充 audit 节点采集、变量名缓存和 `audit_visual` 执行分支。
- `packages/plugin/build.cjs`：将审计引擎包进插件沙箱 IIFE，再加载插件代码。
- `packages/protocol/index.cjs`：注册命令、参数 schema、无版本读命令和审计结果校验。
- `packages/mcp-bridge/index.cjs`：注册 MCP 工具描述并标记为只读。
- `packages/plugin/ordered-pins.test.cjs`：新增变量 ID 反查缓存集成测试。
- `packages/protocol/protocol.test.cjs`：新增命令 envelope、参数与结果契约测试。
- `packages/protocol/package.json`：让 protocol 测试脚本同时运行审计单测。
- `packages/mcp-bridge/bridge.test.cjs`：更新工具数量断言说明（六项改为七项）。

现有错误码及 HTTP 状态码未改：`SCOPE_DENIED 403`、`ANCHOR_NOT_FOUND 404`、`VERSION_CONFLICT 409`、`INVALID_PARAMS 422`、`FONT_LOAD_FAILED 500`、`WRITE_FAILED 500`。注册表按 `item.id` 查找；节点的 `semanticId` 用作该主键的值。

## 十条断言与测试名

| # | 断言 | 测试名 / 文件 |
|---|---|---|
| 1 | 带 3 个子节点的大图片块不判 opaque 或 G1 | `图片块含三个子节点时不判为 opaque 或 G1` — `v0-audit.test.cjs` |
| 2 | 深层普通 FRAME 是 L0 且不触发 R1 | `深层普通 FRAME 默认 L0 且不触发 R1` — `v0-audit.test.cjs` |
| 3 | 带 semanticId 的 FRAME 升为 L1 并进入 R2/R3 | `带 semanticId 的 FRAME 升 L1 并进入 R2 和 R3 校验` — `v0-audit.test.cjs` |
| 4 | COMPONENT / INSTANCE 默认 L1，未登记时触发 R1 | `COMPONENT 和 INSTANCE 默认 L1 且无 semanticId 时触发 R1` — `v0-audit.test.cjs` |
| 5 | 必填属性缺失产生 R3 | `R3 报告缺失的必填属性` — `v0-audit.test.cjs` |
| 6 | 枚举越界产生 R3 和实际值证据 | `R3 报告越界枚举值` — `v0-audit.test.cjs` |
| 7 | 未声明属性产生 R3 | `R3 报告未声明属性` — `v0-audit.test.cjs` |
| 8 | 未知错误码透传原码与来源 | `未知错误码保留原码和来源且不归一` — `v0-audit.test.cjs` |
| 9 | 重复 Variable ID 只查一次，所有节点都产出令牌名 | `audit_visual 缓存同一变量 ID 的名称反查并为每个节点产出令牌证据` — `v0-audit.test.cjs` |
| 10 | error/warning/info 分值与零分下限 | `error、warning 和 info 权重计分并将下限钳制为零` — `v0-audit.test.cjs` |

此外，`protocol.test.cjs` 的 `audit_visual 是无版本读命令且校验范围、模式与注册表参数` 覆盖 MCP/插件命令契约。

## 规则使用的采集字段

| 规则 | 采集字段 | 用途 |
|---|---|---|
| G1 | `hasImageFill`, `bounds`, `childCount` | 图片填充、尺寸与空子节点共同识别 opaque |
| G2 | `name` | 匹配默认图层名 |
| G3 | `path`, `name`, 推导的 `role` | 统计同父级同角色同名节点 |
| T1 | `fillHex`, `hasFillVariable` | 写死颜色且没有填充变量绑定 |
| T2 | `textStyleId`, `fontSize` | 检查文字样式绑定 |
| C1 | `childSignature`（从直接子节点类型生成） | 统计重复 FRAME 结构 |
| C2 | `detachedMainComponent`（由 `getMainComponentAsync` 得出） | 识别脱离主组件的实例 |
| X1 | `type`, `name` | 识别名称像文字但类型为 VECTOR 的节点 |
| X2 | `hasMissingFont` | 报告缺字体 |
| L1 | `layoutMode`, `childCount` | 检查有多个子节点且未启用 Auto Layout 的 FRAME |
| F1 | `fillHex`, `parentFillHex` | 估算文字与父级填充的对比度 |
| F2 | `fontSize` | 统计字号种类数 |
| R1–R5 | `semanticId`, `props`、注册表 `id/schema/props` | 登记、kind、属性及双向孤项检查 |
| R6 | `boundTokenNames`、注册表 `tokens` | 通过变量 ID 名称反查检查令牌是否声明 |

采集器还输出 `boundVariables`、`mainComponent`、`layoutPositioning`、`textStyleId`、`hasMissingFont`、文本 `{ text }` 属性和展平后的 INSTANCE `componentProperties`。不会把整棵 `children` 放入审计节点，只记录 `childCount` 与 C1 使用的签名。

## 验收结果与未覆盖范围

- 基线 `npm test`：bridge 6/6、plugin 32/32、protocol 6/6；总计 44 通过、0 失败。
- 修改后 `npm test`：bridge 6/6、plugin 32/32、protocol 17/17；总计 55 通过、0 失败。新增十项断言均通过。
- `npm run build` 成功；已检查输出 `packages/plugin/dist/code.js` 包含 `vc-semantic-id` 和 `runAudit`。
- 新增 `.cjs` 文件均通过 `node --check`；`v0-audit.cjs` 不含 `require(`、`process.` 或 `globalThis`。
- 尚未在真实 Figma 沙箱运行插件；动态页面变量、字体状态和真实节点属性读取只由 mock 单测覆盖，不能视为真实 Figma 验收。
- 当前引擎按交付要求保持与材料原文一致，因此“字段缺失显式标记为 unverifiable”、UIA 侧审计、`compileComponentSpec` 注入适配以及大纲中 R7/R8 未实现。C1 只用子节点类型签名近似结构；F2 只按字号种类数阈值统计。这些限制不会因本轮测试通过而自动消失。
