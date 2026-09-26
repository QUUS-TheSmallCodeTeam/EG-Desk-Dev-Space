# EG-Desk Product Vision and Development Todo

**Status**: Living source-of-truth index
**Implementation path**: `apps/firefox-ui-demo/`
**Last updated**: 2026-07-30

This document tracks product decisions and development backlog items that came from active design/development discussion. It is not a marketing whitepaper. The public-facing whitepaper is [Production v8](../../docs/production/EG-DESK%20백서%20-%20Production_v8_한글.md), while this file keeps the current product/runtime direction and todo surface aligned.

Board is the product term used here. Some current runtime identifiers and UI
copy still say `Agenda`; checked backlog items describe the underlying behavior,
not completion of the visible rename.

## Current Product Frame

EG-Desk is a live work surface that organizes durable work through a Board
rather than reducing work to a folder. A Desk is the active computer-like
surface and can contain transient unsaved work before it is retained in a
Board. A Board pairs the work objective with browser cards, files, chat,
agents, execution state, outputs, and context. Cards are views/runtime surfaces,
not the Board itself.

Core principles:

- Keep the first screen as the actual work surface, not a landing page.
- Treat Board as the work boundary and Card as the view/runtime form.
- Compose one answer across Chat and Canvas using each medium's own interaction grammar.
- Put spatial, visual, interactive, artifact, and playback expressions on Canvas while keeping conversational explanation complete in Chat.
- Let AI act on the same visible browser/canvas state the user can inspect.
- Prefer repeatable Firefox MCP verification scripts for UI/runtime changes.

## Source Documents

| Area | Current source |
|---|---|
| Public-facing whitepaper | [Production v8](../../docs/production/EG-DESK%20백서%20-%20Production_v8_한글.md) |
| Interaction and orchestration contract | `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` |
| Interaction trace and acceptance coverage (non-normative; not runtime evidence) | `ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md` |
| Firefox shell strategy | `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md` |
| Firefox shell roadmap | `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` |
| Desk/Board/Card runtime | `apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md` |
| Chat/canvas/agent layer | `apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md` |
| Chat visual grammar | `apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md` |
| Viewport/HUD interaction | `apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md` |
| Answer Briefing | `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` §8 and `ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md` `OBJ-038` / `AI-05`; legacy `apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md` is superseded |
| AI canvas annotation | `apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md` |
| Chat agent profiles | `ideas/confirmed/CHAT_AGENT_PROFILE_RUNTIME.md` |
| Browser agent observation runtime | `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` |
| Human-in-the-loop workflow await | `apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md` |
| Historical browser-agent protocol (Electron-era; superseded by ADR-007 and the Firefox runtime sources above) | `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` |

## Decided Product Concepts

### Desk

Desk is closer to "computer / live work surface" than a browser profile or folder. One Desk can contain multiple browser profiles/accounts, files, chats, terminals, and cards. Switching Desk is closer to switching the working computer/work surface than changing a single project folder.

Desk has an automatic local recovery lifecycle distinct from Board
persistence. An unsaved arrangement may be restored after restart without
becoming a saved Board revision.

<a id="agenda"></a>
### Board

Board is the reusable work pairing. It can contain browser cards, file cards, chat cards, terminal cards, agent context, outputs, and workflow state. Nested Board is allowed as a work decomposition graph, but the UI should show the active slice instead of an infinite tree.

### Card

Card is a view/runtime form. "Show it as a card" should be a first-class output mode, similar to "show it as a sheet" or "show it as slides." Browser, terminal, chat, file, report, and annotation cards are all card forms.

### Chat

There are two chat entry modes:

- Agent DM: user talks to a specific agent profile. The agent can route work to a Board Thread when the work belongs there.
- Board Thread: project/work-room chat attached to a Board. Multiple agents can participate like a group chat.

Chat should remain conversationally complete and avoid pasting artifact bodies
or raw execution traces. When Canvas carries the spatial/visual result, Chat
uses an appropriate explanation plus links/chips into that result.

Chat and Canvas are medium-specific projections of one answer. Chat keeps the
conversational explanation; Canvas carries spatial, visual, interactive, and
artifact-oriented expression. A result chip is a navigation affordance, not a
durable product object.

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

### Human-in-the-Loop Await

AI workflows should support dependency-aware Await states. When an upstream
agent task completes with the required evidence and approvals, dependent tasks
should become ready and start automatically. OAuth/login handoffs,
terminal/browser events, file arrival, and user action are possible dependency
conditions, not the definition of Await. Manual "continue" remains a fallback,
not the default path.

### Ontology Runtime and View

Ontology is the system model that organizes agent context, relations, state,
constraints, actions, and evidence. The current Ontology Desk Window visualizes
and helps inspect/co-design that model; it is not a primary workflow in which an
agent or end user manually manages the ontology.

### Coding Surface

Terminal is an agent execution substrate and optional expert/debug view. The
primary user-facing coding experience should support project/folder, file tree,
editor/viewer, diff, and run/test/review results. Non-trivial implementation
design starts with current official documentation, active reference
implementations, the local `references/` library, and verified license evidence.

### Viewport/HUD/Minimap

Viewport HUD should reflect the Board or maximized card currently in view. When a card is maximized, HUD should hide and return only on specific user actions. The minimap is desk-level navigation: its viewport box must be draggable like RTS minimaps, and its world bounds should adapt to the sparsity of cards and Boards.

## Development Todo

### P0 - Active Stabilization

- [x] Seed chat agent profiles and attach them to Agent DM / Board Thread runtime.
- [x] Send chat profile/system prompt through the Codex bridge runtime-context envelope.
- [x] Add profile chips/tool-mode chips to chat thread UI.
- [x] Add Firefox MCP verification for chat profile payload, visible chips, HUD fit, and bubble overflow.
- [x] Add browser agent observation and action history for browser cards.
- [x] Add dynamic minimap viewport box and drag navigation.
- [ ] Persist chat profile selection across browser restart and Board restore.
- [ ] Add UI for viewing/editing full agent profile/system prompt config in a canvas settings panel.
- [ ] Add Board Thread routing affordance from Agent DM: move to thread, tag user in thread, or return to DM.
- [ ] Add result-card creation from chat summary/result chips.
- [ ] Add Prezi-like canvas run playback with step comments that can be inserted into the next chat message.
- [ ] Add dependency graph/task state registry and automatic downstream start; model user-action awaits as one dependency-gate type.

### P1 - Browser Control

- [x] Basic browser controls: navigate, back, forward, reload, stop, home, duplicate, copy URL.
- [x] Browser agent snapshot/action APIs.
- [x] Action history API and event emission.
- [x] DOM-change notification summaries after AI/browser actions.
- [ ] Browser control toolbar polish: predictable icons, disabled states, tooltips, focus behavior.
- [ ] Separate content/canonical-resource deduplication from profile/account execution context in SourceRef and Browser Card focus behavior.
- [ ] OAuth/window.open popup flow regression suite.
- [ ] Detect OAuth/browser completion events for Await Token satisfaction.

### P1 - Canvas and Viewport

- [x] Shape tools: square, ellipse, line, arrow, pen.
- [x] Card maximized/fullscreen behavior with HUD hiding.
- [x] HUD viewport fit checks.
- [ ] Board region visual distinction on infinite canvas.
- [ ] Card placement policy: empty-space search, active Board placement, unsaved changes guard.
- [ ] Canvas output follow-up mode: temporal/spatial steps, camera movement, annotations, and comment anchors.
- [ ] AI canvas annotation mode: draw boxes/arrows/labels over cards or screenshots.

### P1 - Chat UX

- [x] KakaoTalk-like message metadata outside bubbles.
- [x] Agent DM / Board Thread split.
- [x] Profile and tool-mode badges.
- [ ] Profile detail peek: plan/run/action/context layers from avatar/profile interaction.
- [ ] Canvas-linked result chips for long outputs.
- [ ] Thread/session badges: `Resumed`, `Fresh`, `Forked`, `Stateless`.
- [ ] Multi-agent participant state in Board Thread.

### P1 - Context, Recovery, and Coding UX

- [ ] Separate saved Board revisions from the automatically journaled Desk recovery surface.
- [ ] Resolve run context from explicit selection, best-matching Board, transient Desk grouping/layout, visible resources, and account/permission scope.
- [ ] Make the selected run context inspectable and correctable without exposing the whole Desk by default.
- [ ] Research current project/file/editor/diff/test-result frameworks and active implementations before selecting the coding-surface integration path.
- [ ] Add user-facing project/folder, file tree/search, editor/viewer, diff, and run/test/review result surfaces; keep terminal as an optional expert/debug view and agent substrate.

### P2 - Runtime/Packaging

- [ ] Clean-profile boot verification gate.
- [ ] Portable EGDesk packaging path.
- [ ] Rust helper consolidation for terminal/PTY/native functions.
- [ ] Bridge restart/reconnect UX without noisy user-facing diagnostics.
- [ ] Terminal/browser/auth/file watcher bus for cross-app workflow sync.
- [ ] Local persistence schema decision: SQLite-first with possible PocketBase/Convex sync bridge later.
- [ ] Add a Desk-visible host-activity view and control-lease model for computer-use that occurs outside native Desk Windows.
- [ ] Prefer isolated app/desktop execution for global pointer/keyboard computer-use; require explicit handoff before controlling the user's active desktop.
- [ ] Keep remote host-activity streaming, identity, and authorization behind the external-infrastructure approval gate.

## Documentation Rule

When a product decision becomes implementation-relevant, update one of these:

1. This file, if it changes product direction or backlog.
2. A focused `apps/firefox-ui-demo/docs/*` doc, if it specifies runtime/UI behavior.
3. A focused `ideas/confirmed/*` doc, if it confirms a technical strategy.

Do not rely on chat history alone for product decisions that affect implementation.
