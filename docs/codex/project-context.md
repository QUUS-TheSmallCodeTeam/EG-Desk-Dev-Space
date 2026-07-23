# EG-Desk Project Context

This document contains project reference context for Codex. It is not the Main agent profile. Main should load it only when the current task needs project structure, commands, style, testing, or security context.

## Project Direction
- The active implementation path is `apps/firefox-ui-demo/`. New EG-Desk UI/runtime work should start there unless the user explicitly asks for the legacy Electron path.
- `src/` is a legacy Electron/Vite POC. It is still useful as reference for canvas, offscreen browser, and Codex IPC experiments, but it is not the current product direction.
- Keep old experiments available for comparison, but do not extend both Firefox and Electron paths for the same feature without an explicit reason.

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
