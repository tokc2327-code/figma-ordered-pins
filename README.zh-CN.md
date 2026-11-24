> 属于 **Visual Collaboration** 生态——结构化的视觉上下文,以及可核验的人机协作。

# figma-ordered-pins

**0.1.0** · [English](README.md)

**在 Figma 图层上打编号图钉,让 AI agent 读到范围内的上下文、按顺序改画布,并且每一次改动都能核验。**

一个本地 Figma 开发插件,配一个只走回环地址的 MCP stdio 桥接——任何 Figma 套餐,只要有可编辑的 Design 文件就能用:不需要 Dev Mode 席位,不需要 Figma REST API 令牌,也不经过任何云端中继。

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](#快速开始)
[![Figma Plugin](https://img.shields.io/badge/Figma-Development%20Plugin-F24E1E.svg)](#怎么工作)
[![Protocol](https://img.shields.io/badge/MCP-stdio%20JSON--RPC-555555.svg)](#工具7-个)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#许可证)

---

## 为什么做 figma-ordered-pins?

把整份 Figma 文件丢给大模型,既烧 token,agent 还得自己猜该动哪个图层、按什么顺序动。**figma-ordered-pins** 把设计评审变成一条很小、可核验的队列:

- **有序意图(`#1 → #2 → #3`)。** 指令直接钉在画布上的目标图层上,agent 按确定的顺序往下改,不用去解析含糊的聊天描述。
- **低噪声、有锚点的上下文。** 读图钉只返回目标稳定的 Figma 节点 ID、边界、文字、纯色填充/描边样式、Auto Layout 设置和直接子级摘要——不是整棵树。
- **限定范围、带版本校验的写入(`执行 → 核验`)。** 画布改动只能落在被钉住的图层或它的直接子级上,用乐观版本号把关(`expectedVersion` → `newVersion`),每次写完都从 Figma 回读一遍。
- **单步原子撤销。** 每次写入都跑在一个 Figma undo 事务里(成功 `commitUndo`,中途失败 `triggerUndo` 回滚),所以一次 `Ctrl/Cmd+Z` 干净地只撤掉一次 MCP 写入。
- **免费套餐能用。** 靠 Figma Desktop 的开发插件和 `127.0.0.1:17349` 回环桥接在本地跑——不要 Dev Mode,不要付费 API 层,MIT 许可。

---

## 怎么工作

```text
MCP 客户端 / Agent
   │  MCP over stdio (JSON-RPC)
   ▼
packages/mcp-bridge/index.cjs   (绑定 127.0.0.1:17349,64 位十六进制令牌鉴权)
   │  WebSocket ws://localhost:17349/?token=<64-hex>
   ▼
Figma 插件面板 (ui.html)
   │  figma.ui.postMessage
   ▼
Figma 插件沙箱 (dist/code.js) ──► __VC_Pins__ frame + 目标图层
```

- **画布存储:** 插件把编号徽章及其 JSON 元数据(`schemaVersion: "0.1"`)存进每一页里由插件自己管理的 `__VC_Pins__` frame。每个图钉绑定一个稳定的 Figma 节点 ID(`anchor.nodeId`),`namePath` 和 `fallbackBounds` 只作为元数据一起存。
- **图钉生命周期:** 用 `get_ordered_pins` 读队列,把当前那条标成 `in_progress`;每次写入返回的 `newVersion` 作为下一次调用的 `expectedVersion`;看返回的节点快照;最后把图钉关成 `done`(或 `failed`,可带 `note`)。

| 图钉状态 | 画布徽章 | 后缀 | 含义 |
| --- | --- | --- | --- |
| `pending` | 黄色(`#FACC15`) | *(无)* | 排队待执行(计入 `pendingCount`)。 |
| `in_progress` | 蓝色(`#1D4ED8`) | `…` | 已被某个 agent 认领。 |
| `done` | 绿色(`#15803D`) | `✓` | 已核验完成。 |
| `failed` | 红色(`#B91C1C`) | `×` | 停住了,可选的 `note` 存在 `pin.lastError` 上。 |

---

## 工具(7 个)

7 个工具都接收顶层 `participantId`(非空字符串)和 `payload`(对象;出现未知键会被拒)。

- **3 个不带版本的**(`get_ordered_pins`、`add_pin`、`audit_visual`):只收 `{ participantId, payload }`。其中 `get_ordered_pins` 和 `audit_visual` 标了 `readOnlyHint: true`。
- **4 个带版本的写入工具**(`update_text`、`update_style`、`update_layout`、`update_pin_status`):还要顶层 `pinId`(字符串)和 `expectedVersion`(整数 `>= 1`),成功后返回 `newVersion`。

| 工具 | 用途 | `payload` 参数 |
| --- | --- | --- |
| `get_ordered_pins` | 按 `#order` 顺序读当前页的图钉,可选带上锚点节点的上下文。 | `statusFilter?`(`Array<"pending" \| "in_progress" \| "done" \| "failed">`)、`includeContext?`(`boolean`,默认 `true`;锚点已删除时返回 `orphaned: true`)。 |
| `update_text` | 改一个 `TEXT` 图层(被钉住的图层或其直接子级),返回核验过的快照。 | `nodeId`(必填)外加至少一项:`characters`(`string`)、`fontSize`(`number > 0`)、`fontStyle`(`string`,要求该节点只有一个字体家族)。 |
| `update_style` | 改被钉住图层或其直接子级的视觉属性,返回核验过的快照。 | `nodeId`(必填)外加至少一项:`fillHex`(`#RRGGBB`)、`strokeHex`(`#RRGGBB`)、`cornerRadius`(`number >= 0`)、`opacity`(`0..1`)。 |
| `update_layout` | 改被钉住图层或其直接子级的几何或 Auto Layout 属性,返回核验过的快照。 | `nodeId`(必填)外加至少一项:`width`(`number > 0`)、`height`(`number > 0`)、`x`(`number`)、`y`(`number`)、`itemSpacing`(`number`)、`padding`(`{ top?, right?, bottom?, left? }`,每项 `number >= 0`,至少给一侧)。 |
| `update_pin_status` | 改画布徽章和元数据;返回 `{ pin, pendingCount }`。 | `pinId`(必填,且要和顶层 `pinId` 一致)、`status`(必填:`"pending" \| "in_progress" \| "done" \| "failed"`)、`note?`(`string`,只在 `status` 为 `"failed"` 时存进 `lastError`)。 |
| `add_pin` | 在当前页的某个图层上打一个新编号图钉;返回创建出的图钉。 | `instruction`(必填,非空字符串)、`nodeId?`(`string`;省略时用当前唯一选中的图层)。 |
| `audit_visual` | 跑一次只读的视觉结构审计或内联注册表审计(`protocolVersion: "0.1"`)。 | `scope?`(`"selection" \| "page"`,默认先看选区,没选区退回整页)、`mode?`(`"generic" \| "registry"`,给了 `registry` 时默认 `"registry"`,否则 `"generic"`)、`maxDepth?`(`integer >= 0`,默认 `8`)、`maxNodes?`(`integer >= 1`,默认 `300`)、`registryRef?`(`{ version?, url? }`)、`registry?`(内联 JSON 对象)。 |

### 结构化错误

工具失败时返回 `ok: false`,以及 `error: { code, httpStatus, message }`:

| 错误码 | 状态 | 什么时候出现 |
| --- | --- | --- |
| `SCOPE_DENIED` | `403` | 目标图层在图钉的锚点/直接子级之外、落在 `__VC_Pins__` 里面,或者当前页被切走了。 |
| `ANCHOR_NOT_FOUND` | `404` | 引用的 `pinId`、徽章标签、`nodeId` 或被钉住的锚点在当前页已经不存在了。 |
| `VERSION_CONFLICT` | `409` | `expectedVersion` 和图钉当前版本对不上(先重读再重试)。 |
| `INVALID_PARAMS` | `422` | schema 错误、节点属性不支持、填充/字体混合(`figma.mixed`),或违反 Auto Layout 约束。 |
| `FONT_LOAD_FAILED` | `500` | 缺字体、字体加载失败,或加载过程中字体被换掉。 |
| `WRITE_FAILED` | `500` | 写后回读和请求的值对不上(事务已回滚),或其它意外写入错误。 |

---

## 快速开始

五分钟之内在本地跑起来。

### 1. 前置条件

- **Node.js 20+** 和 **npm 10+**
- **Figma Desktop**,有一个可编辑的 Design 文件(免费套餐就行)

### 2. 安装、测试、构建

在仓库根目录:

```sh
npm ci
npm test
npm run build
```

`npm test` 会在三个 workspace 里跑 **55 个自动化测试**(`@vc-figma/mcp-bridge` 里 `6` 个,`@visual-collaboration/figma-plugin` 里 `32` 个,`@vc-figma/protocol` 里 `17` 个)。`npm run build` 把插件沙箱打包成 `packages/plugin/dist/code.js`,并对桥接做一遍语法检查。

### 3. 在 Figma Desktop 里加载插件

1. 在 Figma Desktop 里打开一个可编辑的 Figma Design 文件。
2. 走 **Plugins → Development → Import plugin from manifest…**,选中 `packages/plugin/manifest.json`。
3. 从 **Plugins → Development** 菜单里启动 **Figma Ordered Pins**,把面板留在那儿别关。

### 4. 连上桥接,打第一个图钉

1. 在你的 MCP 客户端里注册这个 MCP 服务(见下一节)。
2. 把桥接启动时打在 `stderr` 上的 64 位十六进制令牌复制进插件面板的「本地桥接」输入框,再点**「连接」**。连上之后插件会把令牌存进 Figma 的 `clientStorage`,以后打开自动连。
3. 在画布上选中一个图层,在「有序标注」输入框里打一句修改指令,按 **Enter**。
4. 让 agent 用 `{"participantId":"agent:local","payload":{}}` 调用 `get_ordered_pins`。

---

## 接进 MCP 客户端

在你的 MCP 客户端里配置:用 `node` 启动,唯一参数是 `packages/mcp-bridge/index.cjs` 的绝对路径(把示例路径换成你自己的 checkout):

```json
{
  "mcpServers": {
    "figma-ordered-pins": {
      "command": "node",
      "args": ["<你的仓库路径>/packages/mcp-bridge/index.cjs"]
    }
  }
}
```

### 如果你的 MCP 客户端看不到 `stderr`

先一次性生成一个 64 位小写十六进制令牌:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

用环境变量 `VC_FIGMA_BRIDGE_TOKEN` 把它传给服务,再把同一个令牌粘进 Figma 插件面板:

```json
{
  "mcpServers": {
    "figma-ordered-pins": {
      "command": "node",
      "args": ["<你的仓库路径>/packages/mcp-bridge/index.cjs"],
      "env": {
        "VC_FIGMA_BRIDGE_TOKEN": "<64-lowercase-hex-token>"
      }
    }
  }
}
```

### Agent 调用示例序列

每次写入成功都会把 `version` 加一并返回 `newVersion`;把这个值当作同一条图钉下一次调用的参数:

```jsonc
// 1. get_ordered_pins — 读当前页的图钉
{ "participantId": "agent:local", "payload": {} }

// 2. update_pin_status — 认领 #1 号图钉(version 1 -> newVersion 2)
{
  "participantId": "agent:local",
  "pinId": "0:1/42:10",
  "expectedVersion": 1,
  "payload": { "pinId": "0:1/42:10", "status": "in_progress" }
}

// 3. update_text — 改锚定的文字节点(version 2 -> newVersion 3,返回核验过的快照)
{
  "participantId": "agent:local",
  "pinId": "0:1/42:10",
  "expectedVersion": 2,
  "payload": { "nodeId": "12:345", "characters": "新标题" }
}

// 4. update_pin_status — 核对快照后把 #1 标成 done(version 3 -> newVersion 4)
{
  "participantId": "agent:local",
  "pinId": "0:1/42:10",
  "expectedVersion": 3,
  "payload": { "pinId": "0:1/42:10", "status": "done" }
}
```

---

## 跑一遍验收

那 55 个自动化测试跑在 mock 的 Figma 运行时、mock 的插件面板,以及真实的回环 WebSocket 和 MCP stdio 连接上。Figma Desktop 的真实连通性、画布渲染、错误守卫、撤销行为和录屏,走下面这份桌面验收清单(和[英文版](README.md)是同一份)。

### 第 1 步 — 本地构建,打上三个有序图钉

1. 在仓库根目录跑 `npm ci`、`npm test`、`npm run build`。
2. 在一个可编辑的 Figma Desktop 测试文件里,通过 Development 插件菜单导入 `packages/plugin/manifest.json`,启动 **Figma Ordered Pins**。
3. 在同一页上依次选中:
   - 一个**标题**图层,
   - 一个**按钮**图层,
   - 一个包住三张卡片的**纵向 Auto Layout 容器**。
4. 在插件面板里输入各自图层的修改指令,按 **Enter**。
5. **确认:** 画布上出现三个黄底编号徽章(`#1`、`#2`、`#3`)。

### 第 2 步 — 连上 MCP 桥接,读队列

1. 在 MCP 客户端里加这个 stdio 服务:命令 `node`,唯一参数是 `packages/mcp-bridge/index.cjs` 的绝对路径。
2. 从 `stderr` 的启动日志里把桥接令牌复制进插件面板,点**「连接」**。如果客户端把 `stderr` 藏了,就给服务环境变量 `VC_FIGMA_BRIDGE_TOKEN` 设一个随机的 64 位小写十六进制令牌,再在面板里填同一个。
3. 让 agent 调用 `get_ordered_pins`。
4. **确认:** 三个图钉按 `#1 → #2 → #3` 顺序返回,目标节点 ID、文字内容和 Auto Layout 上下文都对得上。

### 第 3 步 — 录制执行、核对回读、试守卫和撤销

1. 开始录屏,大约 **30 秒**。
2. 让 agent 按 `#1 → #2 → #3` 执行,逐条回读并检查:
   - 标题的文字和颜色,
   - 按钮的颜色和圆角,
   - 卡片容器的间距(`itemSpacing`)是不是 `24`。
3. **确认:** 每条完成的图钉变绿并带对勾(`✓`),`pendingCount` 最后是 `0`。
4. 停止录制后,跑两个负向检查:
   - 用一个**过期的 `expectedVersion`** 尝试写入 → 确认收到 `VERSION_CONFLICT`。
   - 用当前版本、拿一个**无关图层的 ID** 再试一次写入 → 确认收到 `SCOPE_DENIED`。
5. 在测试文件里按一次**撤销**,确认只回退了最近那一次写入。

---

## 已知限制

- **只作用于当前页:** 图钉和改动都只落在 `figma.currentPage`。执行中途切页会以 `SCOPE_DENIED` 失败。被删掉或跑到页外的锚点会以 `orphaned: true` 返回;写入永远依赖稳定的节点 ID(`namePath` 和 `fallbackBounds` 只是元数据)。
- **单面板、只走回环:** 桥接监听 `127.0.0.1:17349`,同一时间只接受一个连上的插件面板(第二个连接收到 `409 Conflict`)。面板要一直开着,关掉就等于停掉插件。命令 `15` 秒超时,最多 `50` 条命令在飞,WebSocket 载荷上限 `1 MiB`。已建立的连接断开后,面板最多重试 `5` 次(`1s`–`5s` 退避);写入超时或断线之后,重试前一律先重读状态。
- **Figma 编辑约束:**
  - `update_text` 要求字体可用;`fontStyle` 要求该文字图层只有一个字体家族。
  - `update_style` 只改纯色填充(`SOLID`),填充或描边是混合(`figma.mixed`)时拒掉。
  - `update_layout` 要给 `itemSpacing` 和 `padding`,节点得是 `HORIZONTAL` 或 `VERTICAL` Auto Layout;Auto Layout 流式子级的 `x`/`y` 位移会被拒(除非 `layoutPositioning` 是 `ABSOLUTE`)。
- **`pendingCount` 的语义:** 只数状态严格为 `pending` 的图钉(不算 `in_progress` 和 `failed`)。要确认全都跑完了,得逐条看图钉状态。
- **`audit_visual` 的范围与注册表:** 默认 `selection`(没有选中时退回 `page`),深度 `8`,最多 `300` 个节点。注册表定义用内联的 `registry` 传;`registryRef` 只记元数据,插件从不去拉取它。
- **插件面板语言:** 面板界面目前就是中文标签。

---

## 已验证,以及这不是什么

`figma-ordered-pins` 是一份**参考实现**:它存在的意义是证明,一份 Figma 文件可以当成一条有序、带版本校验的小队列交给 agent,而不是一张截图加一段聊天记录。下面打勾的每一条都对着这个仓库核过——构建、自动化测试、以及一次真实的 Figma Desktop 会话。这里没有哪一条是在承诺某个它没跑过的插件 API。

### 已验证

- [x] **7 个 MCP 工具** —— 3 个不带版本信封(`get_ordered_pins`、`add_pin`、`audit_visual`),4 个带(`update_text`、`update_style`、`update_layout`、`update_pin_status`)
- [x] 画布编号图钉(`__VC_Pins__`)与带范围内节点上下文的有序读取,含 `namePath`/`fallbackBounds` 元数据和孤儿锚点检测
- [x] 乐观版本化写入(`expectedVersion` → `newVersion`),写后回读,加原子撤销回滚
- [x] Agent 自建图钉,以及只读的视觉结构 / 注册表审计
- [x] 鉴权的回环 WebSocket(`127.0.0.1:17349`,64 位小写十六进制令牌)加 MCP stdio 桥接,令牌持久化在 `clientStorage`,自动重连最多 5 次(`1s`–`5s` 退避)
- [x] 护栏是量出来的,不是假设的:`15 s` 命令超时、最多 `50` 条命令在飞、`1 MiB` WebSocket 载荷上限、第二个面板收到 `409 Conflict`
- [x] **55 个自动化测试** —— `@vc-figma/mcp-bridge` 里 6 个,`@visual-collaboration/figma-plugin` 里 32 个,`@vc-figma/protocol` 里 17 个
- [x] 桌面验收是一份**写下来的清单**(上面第 1–3 步),覆盖画布渲染、错误守卫和单步撤销

### 非目标

这些是故意不做的,是边界,不是待办:

- **不要 Dev Mode 席位、不要 REST API 令牌、不要云端中继。** 插件和桥接待在同一台机器、同一个回环端口上;远程 agent 不在范围内。
- **不做跨页或整文件范围。** 图钉和改动只作用于 `figma.currentPage`;执行中途切页就是会以 `SCOPE_DENIED` 失败,这是故意的。
- **不出录制演示。** 验收是一份人在 Figma Desktop 里照着跑的清单——不发布视频,也没有 CI 关卡。
- **不做插件面板本地化。** 面板出厂就是中文标签;没有英文界面,也不打算加。
- **不为未来 Figma API 变更做兼容。** 新版插件 API 要是把什么改坏了,那是 fork 的事。
- **没有路线图,也没有支持承诺。** 功能请求的答复是「fork 一份去改」。

### 维护说明

原样分享,从 **Visual Collaboration** 生态里抽出来的。不承诺响应时间,不做第三方兼容修补,也没有发布节奏。欢迎 bug 报告和反例——尤其是锚点变成 `orphaned`、改动被 `figma.mixed` 悄悄拒掉、或者写到一半超时的文件:这些能让这份参考实现更诚实。那是贡献,不是支持合同。`MIT` 许可:fork 它、改它、发你自己的。

---

## 生态

`orca-uia` 是 **Visual Collaboration** 的 Windows 桌面适配器;`figma-ordered-pins` 是 Figma 画布适配器。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
