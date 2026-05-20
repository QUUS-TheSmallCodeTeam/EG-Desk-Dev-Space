# Firefox Shell Path 1.5 Stabilization

**Date**: 2026-05-18
**Status**: Current execution gate before Path 2 packaging
**Scope**: `apps/firefox-ui-demo/`

---

## Goal

Path 1 proved that Firefox chrome JS can host the EG-Desk surface. Path 1.5 turns that proof into a repeatable local POC before packaging starts.

This phase is not for expanding the product surface. It is for making the current surface reliable enough that Path 2 is mostly packaging, branding, updater, and distribution work.

---

## Source Anchors

| Area | Source |
|------|--------|
| Firefox chrome runtime | `overlay/JS/eg-desk-surface.uc.js` |
| Surface styles | `overlay/CSS/eg-desk-surface.uc.css` |
| Codex bridge | `helper/codex-bridge-server.mjs` |
| Terminal iframe | `overlay/resources/terminal.html` |
| Rust helper candidate | `helper-rust/` |
| Repeatable scripts | `scripts/` |
| Chat/canvas/agent UX model | `docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md` |

---

## P0 Order

### 1. Codex HUD Runtime Contract

Stabilize the Codex path before multi-provider work.

Acceptance criteria:
- `/v1/state`, `/auth/status`, `/auth/start`, `/auth/cancel`, `/auth/signout`, `/chat/send` return stable shapes.
- Duplicate login attempts do not create stuck UI states.
- `conversationId` is owned by the active thread and survives HUD-to-canvas moves.
- Send failure shows a product error state, not raw transport leakage.
- Diagnostics remain available but are not the primary UX.

### 2. Browser Entity / Popup / Gesture

Stabilize the real browser card because it is the core EG-Desk execution surface.

Acceptance criteria:
- Browser card create, close, move, resize, back, forward, reload, and URL entry work repeatedly.
- `window.open` / OAuth-like popup routes to a browser card.
- Active card scroll and desk pan/zoom do not switch owner mid-gesture.
- Failure to create a XUL `<browser>` is visible as a blocker, not silently treated as equivalent to the iframe fallback.

### 3. Terminal / Helper Path

Pick one terminal path for the POC.

Current known split:
- `terminal.html` expects a JSON-RPC WebSocket helper at `127.0.0.1:39300`.
- `codex-bridge-server.mjs` exposes HTTP terminal endpoints with `node-pty` fallback.

Path 1.5 decision:
- Either wire the terminal card to the Rust helper candidate, or switch the terminal UI to the Node bridge HTTP/polling path.
- Do not keep both paths as equal product routes.

Acceptance criteria:
- Spawn, write, read/output, resize, and kill pass from the UI card.
- Helper/bridge unavailable state is shown inside the terminal card.
- Closing the card cleans up the PTY session.

### 4. Repeatable Smoke Scripts

Move from one-off probes to scripts that can be rerun before each packaging attempt.

Minimum scripts:
- bridge health/auth state smoke
- HUD send/resume smoke
- browser card spawn/popup smoke
- terminal spawn/write/kill smoke
- console error capture smoke

All repeatable scripts should live under `apps/firefox-ui-demo/scripts/`.

---

## Gate To Path 2

Path 2 starts only when:

- 80% or more of the Path 1.5 checklist in `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` is satisfied.
- Remaining gaps are explicitly classified as `packaging blocker` or `deferred`.
- The active implementation path is still `apps/firefox-ui-demo/`.
- No root-level probe scripts are required to validate the POC.

---

## Deferred For Later Discussion

These are intentionally out of Path 1.5:

- First real execution workflow demo
- Path 2 packaging start
- Multi-provider expansion beyond Codex
- Mini-app marketplace
- WASM acceleration
