# EG-Desk Product Vision and Development Todo

**Status**: Living source-of-truth index
**Implementation path**: `apps/firefox-ui-demo/`
**Last updated**: 2026-05-20

This document tracks product decisions and development backlog items that came from active design/development discussion. It is not a marketing whitepaper. The public-facing vision remains in `docs/vision/`, while this file keeps the current product/runtime direction and todo surface aligned.

## Current Product Frame

EG-Desk is a live work surface where a user starts work from an Agenda, not from a folder. A Desk is the active computer-like surface. An Agenda pairs the work objective with browser cards, files, chat, agents, terminal state, outputs, and context. Cards are views/runtime surfaces, not the Agenda itself.

Core principles:

- Keep the first screen as the actual work surface, not a landing page.
- Treat Agenda as the work boundary and Card as the view/runtime form.
- Keep chat lightweight: short summary bubbles, result chips, and links to canvas artifacts.
- Put long outputs, evidence, run playback, and visual steps on canvas cards.
- Let AI act on the same visible browser/canvas state the user can inspect.
- Prefer repeatable Firefox MCP verification scripts for UI/runtime changes.

## Source Documents

| Area | Current source |
|---|---|
| Long-term product vision | `docs/vision/EG-DESK 백서 - Vision_v1.md` |
| Firefox shell strategy | `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md` |
| Firefox shell roadmap | `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` |
| Desk/Agenda/Card runtime | `apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md` |
| Chat/canvas/agent layer | `apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md` |
| Chat visual grammar | `apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md` |
| Viewport/HUD interaction | `apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md` |
| Canvas run playback | `apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md` |
| AI canvas annotation | `apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md` |
| Chat agent profiles | `ideas/confirmed/CHAT_AGENT_PROFILE_RUNTIME.md` |
| Browser agent observation runtime | `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` |
| Browser agent protocol | `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` |

## Decided Product Concepts

### Desk

Desk is closer to "computer / live work surface" than a browser profile or folder. One Desk can contain multiple browser profiles/accounts, files, chats, terminals, and cards. Switching Desk is closer to switching the working computer/work surface than changing a single project folder.

### Agenda

Agenda is the reusable work pairing. It can contain browser cards, file cards, chat cards, terminal cards, agent context, outputs, and workflow state. Nested Agenda is allowed as a work decomposition graph, but the UI should show the active slice instead of an infinite tree.

### Card

Card is a view/runtime form. "Show it as a card" should be a first-class output mode, similar to "show it as a sheet" or "show it as slides." Browser, terminal, chat, file, report, and annotation cards are all card forms.

### Chat

There are two chat entry modes:

- Agent DM: user talks to a specific agent profile. The agent can route work to an Agenda Thread when the work belongs there.
- Agenda Thread: project/work-room chat attached to an Agenda. Multiple agents can participate like a group chat.

Chat bubbles should be short. They should carry summaries and links/chips, while full results and step-by-step outputs live on canvas.

### Agent Runtime

Agent profile config is runtime context, not visible chat content. Current seeded profiles:

- `conversational-coding`
- `tool-operator`
- `coding-project-manager`
- `codebase-explorer`
- `implementation-worker`
- `review-verifier`

The current Codex SDK path has no dedicated system-prompt field, so EG-Desk sends profile/system prompt data as an application runtime-context envelope before the user message.

### Browser Agent

Browser cards should expose AI-observable state and action history. After an AI action, DOM/title/focus changes should be summarized back to the agent instead of forcing the model to rediscover the page from scratch every time.

### Viewport/HUD/Minimap

Viewport HUD should reflect the Agenda or maximized card currently in view. When a card is maximized, HUD should hide and return only on specific user actions. The minimap is desk-level navigation: its viewport box must be draggable like RTS minimaps, and its world bounds should adapt to the sparsity of cards/agendas.

## Development Todo

### P0 - Active Stabilization

- [x] Seed chat agent profiles and attach them to Agent DM / Agenda Thread runtime.
- [x] Send chat profile/system prompt through the Codex bridge runtime-context envelope.
- [x] Add profile chips/tool-mode chips to chat thread UI.
- [x] Add Firefox MCP verification for chat profile payload, visible chips, HUD fit, and bubble overflow.
- [x] Add browser agent observation and action history for browser cards.
- [x] Add dynamic minimap viewport box and drag navigation.
- [ ] Persist chat profile selection across browser restart and Agenda restore.
- [ ] Add UI for viewing/editing full agent profile/system prompt config in a canvas settings panel.
- [ ] Add Agenda Thread routing affordance from Agent DM: move to thread, tag user in thread, or return to DM.
- [ ] Add result-card creation from chat summary/result chips.
- [ ] Add run playback card for long AI answers and step-by-step review/divert flow.

### P1 - Browser Control

- [x] Basic browser controls: navigate, back, forward, reload, stop, home, duplicate, copy URL.
- [x] Browser agent snapshot/action APIs.
- [x] Action history API and event emission.
- [x] DOM-change notification summaries after AI/browser actions.
- [ ] Browser control toolbar polish: predictable icons, disabled states, tooltips, focus behavior.
- [ ] Browser card tab/focus behavior for duplicate source refs.
- [ ] OAuth/window.open popup flow regression suite.

### P1 - Canvas and Viewport

- [x] Shape tools: square, ellipse, line, arrow, pen.
- [x] Card maximized/fullscreen behavior with HUD hiding.
- [x] HUD viewport fit checks.
- [ ] Agenda region visual distinction on infinite canvas.
- [ ] Card placement policy: empty-space search, active Agenda placement, unsaved changes guard.
- [ ] Canvas output follow-up mode: step-by-step cards with arrows and divert points.
- [ ] AI canvas annotation mode: draw boxes/arrows/labels over cards or screenshots.

### P1 - Chat UX

- [x] KakaoTalk-like message metadata outside bubbles.
- [x] Agent DM / Agenda Thread split.
- [x] Profile and tool-mode badges.
- [ ] Profile detail peek: plan/run/action/context layers from avatar/profile interaction.
- [ ] Canvas-linked result chips for long outputs.
- [ ] Thread/session badges: `Resumed`, `Fresh`, `Forked`, `Stateless`.
- [ ] Multi-agent participant state in Agenda Thread.

### P2 - Runtime/Packaging

- [ ] Clean-profile boot verification gate.
- [ ] Portable EGDesk packaging path.
- [ ] Rust helper consolidation for terminal/PTY/native functions.
- [ ] Bridge restart/reconnect UX without noisy user-facing diagnostics.
- [ ] Local persistence schema decision: SQLite-first with possible PocketBase/Convex sync bridge later.

## Documentation Rule

When a product decision becomes implementation-relevant, update one of these:

1. This file, if it changes product direction or backlog.
2. A focused `apps/firefox-ui-demo/docs/*` doc, if it specifies runtime/UI behavior.
3. A focused `ideas/confirmed/*` doc, if it confirms a technical strategy.

Do not rely on chat history alone for product decisions that affect implementation.
