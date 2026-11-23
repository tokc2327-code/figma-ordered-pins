> Part of the **Visual Collaboration** ecosystem — structured visual context and verifiable human-agent collaboration. *(Main repo link coming soon)*

# Figma Ordered Pins

**Drop numbered pins (`#1 → #2 → #3`) on Figma layers. Let AI agents read low-noise context, edit the canvas in order, and verify every change.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Tests](https://img.shields.io/badge/plugin%20tests-22%20passing-brightgreen.svg)](#quick-start)

<!-- TODO: Replace with a 30-second GIF showing #1 -> #2 -> #3 live edits & pin status turning green -->
![Demo](./docs/assets/demo.gif)

---

## Why Ordered Pins?

Most Figma-to-AI tools dump raw node trees (blowing up tokens) or rely on fragile pixel coordinates. **Figma Ordered Pins** turns your canvas into a structured, verifiable task queue:

- **Ordered Intent:** Mark `#1`, `#2`, `#3` directly on target layers so the agent knows *what* to change and in *what sequence*.
- **Low-Noise Local Context:** Extracts only the pinned node, essential parent Auto Layout info, and immediate children — not the entire file.
- **Guardrailed Execution (`Execute → Verify`):** Agents can only modify nodes bound to the active pin through 5 typed commands, and every edit returns a live post-update snapshot for verification.
- **Works on Free Plans:** Uses a local WebSocket bridge + plugin-managed pin layer (`__VC_Pins__`) — no Dev Mode paywall or remote write quota required.
