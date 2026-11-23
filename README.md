# figma-ordered-pins

Part of the Visual Collaboration Ecosystem (local-only for now; no remote configured).

- `packages/plugin/` Figma 插件本体(manifest.json / code.js / ui.html / 测试),从主仓库 `apps/figma-plugin` 复制而来
- `packages/protocol/` 预留:CommentPin / CommandEnvelope / NodeSnapshot 类型
- `packages/mcp-bridge/` 预留:本地 WebSocket 桥接 + MCP Server
- `docs/` 设计稿

测试:`cd packages/plugin; node --test code.test.cjs`
