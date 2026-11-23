> Part of the **Visual Collaboration** ecosystem — structured visual context and verifiable human-agent collaboration. *(Main repo link coming soon)*

# Figma Ordered Pins

**Drop numbered pins (`#1 → #2 → #3`) on Figma layers. Let AI agents read low-noise context, edit the canvas in order, and verify every change.**

## Why Ordered Pins?

Most Figma-to-AI tools dump raw node trees (blowing up tokens) or rely on fragile pixel coordinates. **Figma Ordered Pins** turns your canvas into a structured, verifiable task queue:

- **Ordered Intent:** Mark `#1`, `#2`, `#3` directly on target layers so the agent knows *what* to change and in *what sequence*.
- **Low-Noise Local Context:** Extracts only the pinned node, essential parent Auto Layout info, and immediate children — not the entire file.
- **Guardrailed Execution (`Execute → Verify`):** Agents can only modify nodes bound to the active pin through 5 typed commands, and every edit returns a live post-update snapshot for verification.
- **Works on Free Plans:** Uses a local WebSocket bridge + plugin-managed pin layer (`__VC_Pins__`) — no Dev Mode paywall or remote write quota required.

## 本地构建与桌面验收

1. 在仓库根目录运行 `npm ci`、`npm test` 和 `npm run build`。在 Figma Desktop 的可编辑测试稿中，通过开发插件菜单导入 `D:\figma-ordered-pins\packages\plugin\manifest.json`。在同一页面依次选中标题、按钮和一个包住三张卡片的纵向 Auto Layout 容器，在插件面板输入各自的修改指令并按回车。确认画布出现三个黄底编号。
2. 在 MCP 客户端添加 stdio 服务，命令为 `node`，唯一参数为 `D:\figma-ordered-pins\packages\mcp-bridge\index.cjs`。从启动日志的 stderr 取桥接令牌，填入插件面板并点击连接。若客户端隐藏 stderr，可在服务环境变量 `VC_FIGMA_BRIDGE_TOKEN` 中设置由 64 个小写十六进制字符组成的随机令牌，再将同一令牌填入面板。让 Agent 调用 `get_ordered_pins`，确认三个标注按 #1 → #2 → #3 返回，并核对目标 ID、文字和 Auto Layout 上下文。
3. 开始录制约 30 秒。请 Agent 按 #1 → #2 → #3 执行，逐条回读并检查标题文字和颜色、按钮颜色和圆角、卡片容器间距是否为 `24`。确认每个成功的图钉变绿打勾且 `pendingCount` 最终为 0。录完后分别用过期版本和无关图层 ID 尝试写入，确认收到 `VERSION_CONFLICT` 和 `SCOPE_DENIED`。在测试稿执行一次撤销，确认只撤销最近一次写入。

### MCP 工具调用

`get_ordered_pins` 接收 `{ participantId, payload }`。例如，`participantId` 使用 `agent:local`，`payload` 用 `{}` 获取当前页全部标注及锚点上下文。删除过的锚点会标记为 `orphaned`。写入依赖稳定节点 ID，名称路径和边界仅随标注元数据返回。

四个写入工具接收 `{ participantId, pinId, expectedVersion, payload }`。例如，`update_text` 的 `payload` 可为 `{ "nodeId": "12:345", "characters": "新标题" }`。每次成功调用后将回执中的 `newVersion` 用于同一标注的下一次写入。`update_pin_status` 的 `payload` 含同一个 `pinId` 和 `status`。Agent 应在开始前设为 `in_progress`，确认内容回读后设为 `done`，失败时可设为 `failed` 并附上 `note`。若桥接超时或断开，重新连接后先读当前状态，再决定是否重试。

本地自动测试使用 mock Figma、mock 插件面板和真实的回环 WebSocket 与 MCP stdio。Figma Desktop 实际连通、画布效果、撤销和录屏由桌面验收确认。
