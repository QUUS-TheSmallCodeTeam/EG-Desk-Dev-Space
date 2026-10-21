# EG-Desk Project Context

This document contains project reference context for Codex. It is not the Main agent profile. Main should load it only when the current task needs project structure, commands, style, testing, or security context.

## Project Direction
- The active implementation path is `apps/firefox-ui-demo/`. New EG-Desk UI/runtime work should start there unless the user explicitly asks for the legacy Electron path.
- `src/` is a legacy Electron/Vite POC. It is still useful as reference for canvas, offscreen browser, and Codex IPC experiments, but it is not the current product direction.
- Keep old experiments available for comparison, but do not extend both Firefox and Electron paths for the same feature without an explicit reason.
- The Firefox-shell platform pivot is decided. Later choices such as packaging channel, portable distribution, or an optional Firefox fork are phase decisions, not a reopening of the platform direction.
- Current product design starts first-time users in a focused Browser landing page with Canvas hidden; online profile/Codex connection leads into Desk. Returning-session restoration is a separate path. The Firefox injection POC is not the permanent user-facing installation model.
- Ordinary Codex is available before a custom Agent is created. Custom Agents optionally add a named persona, role/personality, and thought/activity surfaces; do not require a custom Agent Profile to send the first basic Codex request. These are document baselines, not claims about current implementation.
- Canvas owns actual work objects and report artifacts. Custom Agent thought bubbles open scoped historical-read and work/decision-summary records; do not automatically add a Canvas card per tool call or move the camera when a record is opened. Explicit report/Briefing evidence may still be shown on Canvas.
- Per the owner's 2026-09-26 decision, Board (plural Boards; Korean 보드) is the currently adopted, provisional product name for the existing ready-to-work arrangement of materials, tools, conversations, groups, layout, and reference bindings. It is not the Canvas itself, a Kanban board, a reference-file archive, a new Desk, or a new workspace. The prior product label was Agenda; stable IDs and existing wire/storage identifiers remain unchanged. One-login profile setup remains a candidate and does not authorize a new cloud identity provider or merge Browser and Codex accounts.
- The final business direction includes multi-user collaboration in which another authorized person can enter and work in a user's Desk.
- The product connects resources and execution across multiple PCs through Canvas-based Boards. One Desk/Canvas is a UI topology, not a one-PC limit; a Board is not restricted to one folder. Saved Board and automatic Desk restoration remain distinct. See the [Atlas](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md) and [Contract §12](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use) for the product and execution boundaries.
- Local capabilities may proceed autonomously. Actual server or network infrastructure, remote databases, identity providers, paid services, external deployment, credentials, domains, or external accounts require explicit user approval through Main's approval queue.
- Product outcomes and authority boundaries should be explicit; implementation structure, refactoring, task decomposition, and technical method remain flexible unless they change an approved product outcome or risk boundary.
- Prefer current external standards, official documentation, mature open-source work, and the local `references/` library before custom implementation. Reuse must follow the current license policy and verified evidence.

### Current approved visual baseline
- For EG-Desk visual work, inspect the owner-approved desktop [HTML reference](../../apps/firefox-ui-demo/docs/egdesk-approved-desktop-style.html) and [rendered JPG](../../apps/firefox-ui-demo/docs/egdesk-approved-desktop-style.jpg) together. These are visual references, not evidence that the running app already matches them.
- Read the existing [Chat design grammar](../../apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md), [Desk Window common-frame contract](../../apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md#desk-window-shell-and-adapter-contract), and [viewport interaction model](../../apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md). Preserve the established EG-Desk layout and operating model while applying the approved visual feel and refining details; do not treat the reference as permission to replace the UI/UX philosophy.
- Compare an actual current-app screenshot with the approved JPG when assessing or implementing changes. A prose description or static mock alone does not verify the live shell, Chat, dock, cards, or viewport behavior.

## Codex Product Management
- `.codex/agents/egdesk-pm.toml` is the active Codex-native EG-Desk PM profile.
- PM owns product interpretation, final-capability baselines, roadmap and PRD coherence, research framing, external-reference product fit, decision drift, and approval-candidate preparation.
- PM is not user-facing and does not own agent spawning, the approval queue, application code, tests, WM state, Git, or final operational routing.
- PM defaults to read-only consultation. It may edit product, PRD, ADR, vision, or reference documents only when Main explicitly delegates that document work.
- Main remains the only user-facing authority and owns queueing and batching approval candidates. Pending approval pauses only dependent work; independent local work continues.
- WM owns file and source selection, local-reference location and freshness, current-vs-reference classification, and drift warnings. PM supplies product criteria; WM supplies local reality; Main composes and dispatches.
- Research workers gather bounded evidence. They do not approve product direction. Main returns their evidence to PM for product-fit evaluation before routing implementation or approval.
- `ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md` is the canonical user manual and UI-action specification: exact product-user input, visible response, next action, recovery, and completion evidence.
- `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` is the canonical technical contract that makes those UI actions valid through state, data, identity, runtime, storage, recovery, and orchestration guarantees. Neither document is runtime evidence.
- `docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md` owns only product-owner `HUM-*` design gaps and decisions. Main batches owner questions; only dependent work waits.
- `docs/codex/egdesk-product-documentation-governance.md` owns the AI/PM/Main-facing authoring contract, document weave, source precedence, provenance, routing, stable IDs, audit history, and validation rules.
- Keep each sentence in its receiving situation: Atlas must sound like a product manual and UI-action specification, the Contract like a normative technical contract, and the owner ledger like a decision brief. Prompt-like instructions to document agents or maintainers belong only in Documentation Governance and must be transposed before entering a product document.
- Product examples are coverage probes, not requirements by themselves. Detailed use cases must trace actor intent, starting state, exact UI action, visible feedback, state transition, agent/tool processing, recovery/approval, and completion evidence.
- For non-trivial technical capabilities, WM first maps current source, dependencies, and local references; bounded research then compares current official sources and active reference implementations before implementation agents choose a method.

### Product source precedence
1. The user's latest explicit decision, as recorded or relayed by Main.
2. Current Decided ADRs and confirmed product sources that do not conflict with that decision.
3. This Codex project context and current WM routing context.
4. Proposed PRDs, brainstorming notes, and current implementation evidence.
5. Historical Claude swarm files and legacy implementation notes.

### Existing Claude assets
- Keep `.claude/agents/egdesk-pm-agent.md` and `.claude/skills/pm/SKILL.md` as historical method references; do not treat them as the active PM authority.
- Keep existing PRDs under `ideas/` and existing ADRs under `.claude/docs/decisions/` in place during the PM-profile migration. Do not create duplicate Codex copies.
- Do not use `.claude/wm/project-profile.md` as current project identity without a WM-selected, current section; it contains stale Electron-era assumptions.

## `.claude` Swarm Reference
- Keep all Claude-style swarm artifacts under `.claude/`. Do not move, flatten, rename, or mirror them into Codex-specific folders unless the user explicitly asks.
- Do not read `.claude/` by default. Load it only when the user asks about the swarm, agent roles, WM/file-map behavior, prior subagent reports, or when explicitly simulating/adapting a Claude-style workflow.
- When `.claude/` is relevant, treat it as an operational reference model, not application source code.
- Codex mapping: Main Codex = Session Lead; WM = optional file-structure and metacognitive intelligence; Worker/Profile = Codex subagent only when delegation or parallel agent work is useful.
- The current source-of-truth direction overrides stale swarm notes: `apps/firefox-ui-demo/` is active; `src/` is legacy Electron/Vite POC.

## Project Structure
- `apps/firefox-ui-demo/` contains the current Firefox shell POC.
  - `overlay/JS/eg-desk-surface.uc.js` is the main Firefox chrome UI/runtime script.
  - `overlay/CSS/eg-desk-surface.uc.css` is the main surface stylesheet.
  - `overlay/resources/` contains chrome-loadable HTML/vendor assets such as the terminal iframe.
  - `helper/` contains the Node bridge server for Codex chat and terminal HTTP endpoints.
  - `helper-rust/` contains the Rust PTY helper candidate.
  - `scripts/` contains install, sync, run, and repeatable verification scripts.
- `src/` contains the legacy Electron/Vite POC.
  - `src/main/` is the Electron main process.
  - `src/preload/` exposes the renderer bridge API.
  - `src/renderer/` contains the React canvas shell.
  - `src/shared/` contains shared contracts and types.
- `docs/` stores project documentation, design notes, whitepapers, and production-facing written material.
- `docs/codex/` stores Codex-facing project context and operating notes that should not live in `AGENTS.md`.
- `.codex/agents/` stores project-scoped Codex custom subagent profiles.
- `.codex/wm/` stores WM-owned operating memory, inventory snapshots, contextual file maps, source-boundary tracking, and agent file bindings.
- `ideas/` stores exploratory and confirmed product/architecture notes.
- `references/` stores external reference checkouts and research material. Cloned reference repositories are local-only and must not be committed.
- `outputs/`, `.tmp/`, screenshots, generated workbooks, and ad hoc browser/test captures are local artifacts unless the user explicitly asks to preserve them as project evidence.

## Build, Test, And Development Commands
- Firefox bridge:
  - `cd apps/firefox-ui-demo/helper && npm install`
  - `node codex-bridge-server.mjs`
  - or from the repo root: `apps/firefox-ui-demo/scripts/run-codex-bridge.sh`
- Firefox overlay install/sync:
  - `cd apps/firefox-ui-demo/scripts && ./install.sh` on macOS/Linux
  - `apps/firefox-ui-demo/scripts/write-userjs.sh` when only profile chrome files need updating.
- Rust PTY helper candidate:
  - `cd apps/firefox-ui-demo/helper-rust && cargo build --release`
- Legacy Electron POC:
  - `npm install`
  - `npm run dev`, `npm run dev:full`, `npm run build`, `npm run typecheck`

## Coding Style And Naming Conventions
- Follow `.editorconfig`: LF endings, spaces, 4-space indent for TS/JS/MD, and 2-space indent for JSON/YAML.
- For Firefox overlay code, keep runtime code in `overlay/JS`, style in `overlay/CSS`, chrome-loadable resources in `overlay/resources`, and host-side services in `helper/` or `helper-rust/`.
- Use PascalCase for React components and classes, camelCase for functions/variables, and kebab-case for filenames unless an existing local pattern differs.
- Keep generated files, screenshots, temporary scripts, browser profiles, and local session state out of the repository.

## Testing Guidelines
- For Firefox UI work, prefer repeatable scripts in `apps/firefox-ui-demo/scripts/` over root-level one-off probes.
- Verify overlay changes through Firefox/Marionette or the existing helper scripts when practical.
- Run `npm run typecheck` before treating legacy Electron/Vite code changes as ready.
- Do not commit `node_modules/`, Rust `target/`, `.bak.*` files, persistent browser profiles, or local MCP/session artifacts.

## Commit And Pull Request Guidelines
- Use imperative, scoped commit subjects such as `fix(firefox-ui): repair terminal card css` or `chore(repo): ignore local artifacts`.
- Keep commits narrowly scoped: separate source changes, generated artifact cleanup, and documentation updates when possible.
- Describe user impact and verification commands in commit bodies for behavior changes.
- Include screenshots or recordings for user-visible UI changes when they clarify the result.

## Security And Configuration Tips
- Do not commit credentials, persistent browser profiles, MCP state, local tokens, or copied account/session artifacts.
- Treat `.mcp.json`, `.playwright-mcp/`, `playwright-user-data/`, and browser automation captures as local-only.
- Keep external reference repositories under `references/` reproducible through setup instructions rather than committing their contents.
