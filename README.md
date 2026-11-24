> Part of the **Visual Collaboration** ecosystem — structured visual context and verifiable human-agent collaboration.

# figma-ordered-pins

**0.1.0** · [中文](README.zh-CN.md)

**Drop numbered pins on Figma layers so an AI agent can read scoped context, edit the canvas in order, and verify every change.**

Run a local Figma development plugin paired with a loopback MCP stdio bridge — free to use on any Figma plan with an editable Design file, with no Dev Mode seat, no Figma REST API token, and no cloud relay required.

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](#quick-start)
[![Figma Plugin](https://img.shields.io/badge/Figma-Development%20Plugin-F24E1E.svg)](#how-it-works)
[![Protocol](https://img.shields.io/badge/MCP-stdio%20JSON--RPC-555555.svg)](#tools-7)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

---

## Why figma-ordered-pins?

Dumping an entire Figma file into an LLM wastes tokens and still leaves the agent guessing which layer to touch and in what order. **figma-ordered-pins** turns design review into a small, verifiable queue:

- **Ordered intent (`#1 → #2 → #3`).** Pin instructions directly onto target layers on the canvas so the agent works through edits in deterministic order instead of parsing ambiguous chat descriptions.
- **Low-noise, anchored context.** Reading pins returns each target's stable Figma node ID, bounds, text, solid fill/stroke style, Auto Layout settings, and direct children summaries — not the entire document tree.
- **Scoped, version-checked writes (`Execute → Verify`).** Canvas mutations are restricted to the pinned layer or its direct children, guarded by optimistic versioning (`expectedVersion` → `newVersion`), and read back from Figma after every write.
- **Atomic single-step Undo.** Each write executes in a Figma undo transaction (`commitUndo` on success, `triggerUndo` rollback on mid-operation failure), so one `Ctrl/Cmd+Z` reverts one MCP write cleanly.
- **Works on Figma Free plans.** Runs locally via a Figma Desktop development plugin and a `127.0.0.1:17349` loopback bridge — no Dev Mode, no paid API tier, and MIT-licensed.

---

## How it works

```text
MCP Client / Agent
   │  MCP over stdio (JSON-RPC)
   ▼
packages/mcp-bridge/index.cjs   (binds 127.0.0.1:17349, 64-hex token auth)
   │  WebSocket ws://localhost:17349/?token=<64-hex>
   ▼
Figma Plugin Panel (ui.html)
   │  figma.ui.postMessage
   ▼
Figma Plugin Sandbox (dist/code.js) ──► __VC_Pins__ frame + target layers
```

- **Canvas storage:** The plugin stores numbered badges and their JSON metadata (`schemaVersion: "0.1"`) inside a plugin-managed `__VC_Pins__` frame on each page. Each pin binds to a stable Figma node ID (`anchor.nodeId`) and carries its `namePath` and `fallbackBounds` as metadata.
- **Pin lifecycle:** Read the queue with `get_ordered_pins`, mark the active pin `in_progress`, pass each successful write's returned `newVersion` as the next call's `expectedVersion`, inspect the returned node snapshot, and close the pin as `done` (or `failed` with an optional `note`).

| Pin status | Canvas badge | Suffix | Meaning |
| --- | --- | --- | --- |
| `pending` | Yellow (`#FACC15`) | *(none)* | Queued for execution (counted in `pendingCount`). |
| `in_progress` | Blue (`#1D4ED8`) | `…` | Claimed by an agent. |
| `done` | Green (`#15803D`) | `✓` | Verified complete. |
| `failed` | Red (`#B91C1C`) | `×` | Stopped; optional `note` saved on `pin.lastError`. |

---

## Tools (7)

All 7 tools take top-level `participantId` (non-empty string) and `payload` (object; unknown keys are rejected).

- **3 versionless tools** (`get_ordered_pins`, `add_pin`, `audit_visual`): take only `{ participantId, payload }`. `get_ordered_pins` and `audit_visual` are marked `readOnlyHint: true`.
- **4 versioned write tools** (`update_text`, `update_style`, `update_layout`, `update_pin_status`): also require top-level `pinId` (string) and `expectedVersion` (integer `>= 1`), and return `newVersion` on success.

| Tool | Purpose | `payload` parameters |
| --- | --- | --- |
| `get_ordered_pins` | Read the current page's pins in `#order` sequence with optional anchored node context. | `statusFilter?` (`Array<"pending" \| "in_progress" \| "done" \| "failed">`), `includeContext?` (`boolean`, default `true`; deleted anchors return `orphaned: true`). |
| `update_text` | Edit a `TEXT` layer (pinned layer or direct child) and return a verified snapshot. | `nodeId` (required) plus at least one of: `characters` (`string`), `fontSize` (`number > 0`), `fontStyle` (`string`, requires a single font family on the node). |
| `update_style` | Edit visual properties on the pinned layer or a direct child and return a verified snapshot. | `nodeId` (required) plus at least one of: `fillHex` (`#RRGGBB`), `strokeHex` (`#RRGGBB`), `cornerRadius` (`number >= 0`), `opacity` (`0..1`). |
| `update_layout` | Edit geometry or Auto Layout properties on the pinned layer or a direct child and return a verified snapshot. | `nodeId` (required) plus at least one of: `width` (`number > 0`), `height` (`number > 0`), `x` (`number`), `y` (`number`), `itemSpacing` (`number`), `padding` (`{ top?, right?, bottom?, left? }`, each `number >= 0`, at least 1 side). |
| `update_pin_status` | Update the canvas badge and metadata; returns `{ pin, pendingCount }`. | `pinId` (required, must match top-level `pinId`), `status` (required: `"pending" \| "in_progress" \| "done" \| "failed"`), `note?` (`string`, saved to `lastError` only when `status` is `"failed"`). |
| `add_pin` | Drop a new numbered pin on a layer in the current page; returns the created pin. | `instruction` (required, non-empty string), `nodeId?` (`string`; defaults to the single currently selected layer). |
| `audit_visual` | Run a read-only visual structure or inline-registry audit (`protocolVersion: "0.1"`). | `scope?` (`"selection" \| "page"`, defaults to selection then falls back to page), `mode?` (`"generic" \| "registry"`, defaults to `"registry"` if `registry` is supplied, else `"generic"`), `maxDepth?` (`integer >= 0`, default `8`), `maxNodes?` (`integer >= 1`, default `300`), `registryRef?` (`{ version?, url? }`), `registry?` (inline JSON object). |

### Structured errors

Tool failures return `ok: false` with `error: { code, httpStatus, message }`:

| Error code | Status | When it occurs |
| --- | --- | --- |
| `SCOPE_DENIED` | `403` | Target layer is outside the pin's anchor/direct children, inside `__VC_Pins__`, or the active page changed. |
| `ANCHOR_NOT_FOUND` | `404` | Referenced `pinId`, badge label, `nodeId`, or pinned anchor no longer exists on the current page. |
| `VERSION_CONFLICT` | `409` | `expectedVersion` does not match the pin's current version (re-read before retrying). |
| `INVALID_PARAMS` | `422` | Schema error, unsupported node property, mixed fills/fonts, or Auto Layout constraint violation. |
| `FONT_LOAD_FAILED` | `500` | Missing font, font load failure, or font changed while loading. |
| `WRITE_FAILED` | `500` | Post-write readback did not match the requested values (transaction is rolled back) or unexpected write error. |

---

## Quick start

Get running locally in under five minutes.

### 1. Prerequisites

- **Node.js 20+** and **npm 10+**
- **Figma Desktop** with an editable Design file (Free plan works)

### 2. Install, test, and build

From the repository root:

```sh
npm ci
npm test
npm run build
```

`npm test` runs **55 automated tests** across all three workspaces (`6` in `@vc-figma/mcp-bridge`, `32` in `@visual-collaboration/figma-plugin`, and `17` in `@vc-figma/protocol`). `npm run build` bundles the plugin sandbox into `packages/plugin/dist/code.js` and syntax-checks the bridge.

### 3. Load the plugin in Figma Desktop

1. Open an editable Figma Design file in Figma Desktop.
2. Go to **Plugins → Development → Import plugin from manifest…** and select `packages/plugin/manifest.json`.
3. Launch **Figma Ordered Pins** from the **Plugins → Development** menu and keep the plugin panel open.

### 4. Connect the bridge and drop a pin

1. Register the MCP server in your MCP client (next section).
2. Copy the 64-character hex token printed by the bridge on `stderr` into the plugin panel's local bridge token field (`本地桥接`), then click **Connect** (`连接`). Once connected, the plugin stores the token in Figma's `clientStorage` and auto-connects on future launches.
3. Select a single layer on the canvas, type an instruction into the ordered-pin input (`有序标注`), and press **Enter**.
4. Ask your agent to call `get_ordered_pins` with `{"participantId":"agent:local","payload":{}}`.

---

## Wire it into an MCP client

Configure your MCP client to spawn `node` with the absolute path to `packages/mcp-bridge/index.cjs` as its only argument (replace the example path with your checkout):

```json
{
  "mcpServers": {
    "figma-ordered-pins": {
      "command": "node",
      "args": ["<your-checkout>/packages/mcp-bridge/index.cjs"]
    }
  }
}
```

### If your MCP client hides `stderr`

Generate a 64-character lowercase hexadecimal token once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Pass it to the server via the `VC_FIGMA_BRIDGE_TOKEN` environment variable and paste the same token into the Figma plugin panel:

```json
{
  "mcpServers": {
    "figma-ordered-pins": {
      "command": "node",
      "args": ["<your-checkout>/packages/mcp-bridge/index.cjs"],
      "env": {
        "VC_FIGMA_BRIDGE_TOKEN": "<64-lowercase-hex-token>"
      }
    }
  }
}
```

### Example agent call sequence

Each successful write increments `version` and returns `newVersion`; pass that value into the next call on the same pin:

```jsonc
// 1. get_ordered_pins — read pins on the current page
{ "participantId": "agent:local", "payload": {} }

// 2. update_pin_status — claim pin #1 (version 1 -> newVersion 2)
{
  "participantId": "agent:local",
  "pinId": "0:1/42:10",
  "expectedVersion": 1,
  "payload": { "pinId": "0:1/42:10", "status": "in_progress" }
}

// 3. update_text — edit anchored text node (version 2 -> newVersion 3, returns verified snapshot)
{
  "participantId": "agent:local",
  "pinId": "0:1/42:10",
  "expectedVersion": 2,
  "payload": { "nodeId": "12:345", "characters": "New heading" }
}

// 4. update_pin_status — mark pin #1 done after verifying snapshot (version 3 -> newVersion 4)
{
  "participantId": "agent:local",
  "pinId": "0:1/42:10",
  "expectedVersion": 3,
  "payload": { "pinId": "0:1/42:10", "status": "done" }
}
```

---

## Running the acceptance

The 55 automated tests run against a mock Figma runtime, a mock plugin panel, and real loopback WebSocket + MCP stdio connections. Use this desktop acceptance checklist (the Chinese README mirrors it in [README.zh-CN.md](README.zh-CN.md)) to verify live Figma Desktop connectivity, canvas rendering, error guards, Undo behavior, and recording.

### Step 1 — Build locally and place three ordered pins

1. From the repository root, run `npm ci`, `npm test`, and `npm run build`.
2. In an editable Figma Desktop test file, import `packages/plugin/manifest.json` via the Development plugins menu and launch **Figma Ordered Pins**.
3. On the same page, select in order:
   - a **heading** layer,
   - a **button** layer, and
   - a **vertical Auto Layout container** holding three cards.
4. Enter each layer's edit instruction in the plugin panel and press **Enter**.
5. **Confirm:** Three yellow-background numbered badges (`#1`, `#2`, `#3`) appear on the canvas.

### Step 2 — Connect the MCP bridge and read the queue

1. Add the stdio server to your MCP client with command `node` and the single argument `packages/mcp-bridge/index.cjs` (absolute path of your checkout).
2. Copy the bridge token from the startup log on `stderr` into the plugin panel and click **Connect** (`连接`). If the client hides `stderr`, set `VC_FIGMA_BRIDGE_TOKEN` in the server environment to a random 64-character lowercase hex token and enter the same token in the panel.
3. Ask the agent to call `get_ordered_pins`.
4. **Confirm:** All three pins return in `#1 → #2 → #3` order, with accurate target node IDs, text content, and Auto Layout context.

### Step 3 — Record execution, verify readback, and test guards + Undo

1. Start a screen recording of about **30 seconds**.
2. Have the agent execute `#1 → #2 → #3`, reading back each edit and checking:
   - the heading's text and color,
   - the button's color and corner radius, and
   - that the card container's spacing (`itemSpacing`) is `24`.
3. **Confirm:** Each completed pin turns green with a checkmark (`✓`) and `pendingCount` ends at `0`.
4. After stopping the recording, run two negative-path checks:
   - Attempt a write with a **stale `expectedVersion`** → confirm you receive `VERSION_CONFLICT`.
   - Attempt a separate write with an **unrelated layer ID** (using the current version) → confirm you receive `SCOPE_DENIED`.
5. Run **Undo** once in the test file and **confirm** it reverts only the most recent write.

---

## Known limits

- **Current-page scope:** Pins and edits apply only to `figma.currentPage`. Switching pages mid-command fails with `SCOPE_DENIED`. A deleted or off-page anchor is returned as `orphaned: true`; writes always rely on stable node IDs (`namePath` and `fallbackBounds` are metadata only).
- **Single panel & loopback transport:** The bridge listens on `127.0.0.1:17349` and accepts one connected plugin panel at a time (a second connection receives `409 Conflict`). Keep the panel open; closing it stops the plugin. Commands time out after `15` seconds, at most `50` commands may be in flight, and WebSocket payloads are capped at `1 MiB`. After a drop on an established connection, the panel retries up to `5` times (`1s`–`5s` backoff); always re-read state before retrying a timed-out or disconnected write.
- **Figma editing constraints:**
  - `update_text` requires available fonts; `fontStyle` requires a single font family across the text layer.
  - `update_style` edits solid paints (`SOLID`) and rejects mixed fills/strokes (`figma.mixed`).
  - `update_layout` requires `HORIZONTAL` or `VERTICAL` Auto Layout for `itemSpacing` and `padding`, and rejects `x`/`y` moves on Auto Layout flow children (unless `layoutPositioning` is `ABSOLUTE`).
- **`pendingCount` semantics:** `pendingCount` counts only pins whose status is strictly `pending` (not `in_progress` or `failed`). Inspect individual pin statuses to confirm everything reached `done`.
- **`audit_visual` bounds and registry handling:** Defaults to `selection` (falling back to `page` when nothing is selected), depth `8`, and `300` nodes. Pass registry definitions inline via `registry`; `registryRef` only records metadata and is never fetched by the plugin.
- **Plugin panel language:** The plugin panel UI currently displays Chinese labels.

---

## Verified, and what this is not

`figma-ordered-pins` is a **reference implementation**: it exists to show that a Figma file can be handed to an agent as a small, ordered, version-checked queue instead of a screenshot and a chat log. Everything ticked below was checked against this repository — build, automated suite, and a live Figma Desktop session. Nothing here promises to work on a plugin API it has not been run against.

### Verified

- [x] **7 MCP tools** — 3 without a version envelope (`get_ordered_pins`, `add_pin`, `audit_visual`) and 4 that carry one (`update_text`, `update_style`, `update_layout`, `update_pin_status`)
- [x] Numbered canvas pins (`__VC_Pins__`) and ordered reads with scoped node context, `namePath`/`fallbackBounds` metadata, and orphan detection
- [x] Optimistically versioned writes (`expectedVersion` → `newVersion`) with post-write readback and atomic Undo rollback
- [x] Agent-created pins and read-only visual structure / registry auditing
- [x] Authenticated loopback WebSocket (`127.0.0.1:17349`, 64-lowercase-hex token) plus MCP stdio bridge, with `clientStorage` token persistence and auto-reconnect capped at 5 attempts (`1s`–`5s` backoff)
- [x] Guardrails measured, not assumed: `15 s` command timeout, at most `50` commands in flight, `1 MiB` WebSocket payload cap, and `409 Conflict` for a second panel
- [x] **55 automated tests** — 6 in `@vc-figma/mcp-bridge`, 32 in `@visual-collaboration/figma-plugin`, 17 in `@vc-figma/protocol`
- [x] Desktop acceptance as a **written checklist** (Steps 1–3 above) covering canvas rendering, error guards, and single-step Undo

### Non-Goals

Deliberately not done. These are boundaries, not a backlog:

- **No Dev Mode seat, no REST API token, no cloud relay.** The plugin and the bridge stay on one machine and one loopback port; remote agents are out of scope.
- **No cross-page or whole-file scope.** Pins and edits apply to `figma.currentPage`; a mid-command page switch fails with `SCOPE_DENIED` on purpose.
- **No recorded demo.** The acceptance is a checklist a person runs in Figma Desktop — no video is shipped and no CI gate runs it.
- **No plugin-panel localisation.** The panel ships with Chinese labels; there is no English locale and none is planned here.
- **No compatibility work for future Figma API changes.** If a newer plugin API breaks something, that is a fork's problem.
- **No roadmap and no support contract.** Feature requests are answered with "fork it".

### Maintenance policy

Shared as-is, extracted from the **Visual Collaboration** ecosystem. There is no response-time promise, no compatibility patching, and no release schedule. Bug reports and counter-examples are welcome — especially files where a pin's anchor is `orphaned`, an edit is silently rejected by `figma.mixed`, or a write times out mid-way: those make the reference implementation more honest. They are a contribution, not a support contract. `MIT` license: fork it, adapt it, ship your own.

---

## Ecosystem

`orca-uia` is the Windows desktop surface adapter for **Visual Collaboration**; `figma-ordered-pins` is the Figma canvas adapter.

## License

MIT — see [LICENSE](LICENSE).
