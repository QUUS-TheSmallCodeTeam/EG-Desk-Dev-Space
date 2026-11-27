# EG-DESK

EG-DESK is currently moving toward a Firefox-shell implementation: Firefox provides the real browser surface, while EG-DESK overlays workspace UI, Codex chat, terminal experiments, and automation controls into Firefox chrome.

The old Electron/Vite app still exists as a legacy POC under `src/`, but the active implementation path is now `apps/firefox-ui-demo/`.

## Current Status

**Active path**: Firefox shell POC

Most recent product work lives in `apps/firefox-ui-demo/`:

- 4-edge Firefox chrome surface overlay
- Codex chat HUD and thread UI
- Codex bridge server using `@openai/codex-sdk`
- Settings/provider/account UI experiments
- Terminal card and PTY helper experiments
- Firefox profile install/sync and Marionette verification scripts

The legacy Electron/Vite app in `src/` remains useful reference material for canvas, offscreen browser rendering, and Codex IPC, but it is no longer the default place for new feature work.

## Repository Structure

```text
EG-Desk-Dev-Space/
├── apps/
│   └── firefox-ui-demo/              # Active Firefox shell POC
│       ├── overlay/
│       │   ├── JS/                   # Firefox chrome runtime scripts
│       │   ├── CSS/                  # Firefox chrome surface styles
│       │   └── resources/            # chrome-loadable HTML/vendor assets
│       ├── helper/                   # Node Codex bridge and HTTP endpoints
│       ├── helper-rust/              # Rust PTY helper candidate
│       ├── scripts/                  # install/run/verification scripts
│       └── docs/                     # Firefox POC design notes
├── src/                              # Legacy Electron/Vite POC
│   ├── main/
│   ├── preload/
│   ├── renderer/
│   └── shared/
├── docs/                             # Project docs, whitepapers, references
├── ideas/                            # Brainstorming and confirmed plans
├── references/                       # Local external library checkouts, ignored
├── outputs/                          # Local generated artifacts, ignored
├── .claude/                          # Claude-style swarm/workflow material
└── AGENTS.md                         # Working rules for agents
```

## Firefox POC

Main files:

- `apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js`
- `apps/firefox-ui-demo/overlay/CSS/eg-desk-surface.uc.css`
- `apps/firefox-ui-demo/helper/codex-bridge-server.mjs`
- `apps/firefox-ui-demo/overlay/resources/terminal.html`
- `apps/firefox-ui-demo/helper-rust/src/main.rs`

Run the bridge server:

```bash
cd apps/firefox-ui-demo/helper
npm install
node codex-bridge-server.mjs
```

or:

```bash
apps/firefox-ui-demo/scripts/run-codex-bridge.sh
```

Install/sync the Firefox overlay:

```bash
cd apps/firefox-ui-demo/scripts
./install.sh
```

For the Rust PTY helper candidate:

```bash
cd apps/firefox-ui-demo/helper-rust
cargo build --release
```

## Legacy Electron/Vite POC

The Electron app is still available for reference:

```bash
npm install
npm run dev
npm run dev:full
npm run build
npm run typecheck
```

Treat `src/` as legacy unless a task explicitly targets Electron/Vite.

## Local Artifacts

The repository has local-only material that should stay out of commits:

- `references/`: local external library checkouts
- `outputs/`: generated spreadsheets, screenshots, cleanup archives
- `node_modules/`, nested `node_modules/`, Rust `target/`
- browser profiles, MCP state, screenshots, `.bak.*` files

Current cleanup archives are under:

```text
outputs/cleanup-20260518/
```

## Project Notes

The old Electron-first README language is intentionally removed. The current working assumption is:

```text
apps/firefox-ui-demo/ = active implementation path
src/                  = legacy Electron/Vite POC
```

Last updated: 2026-05-18

## License

EG-Desk is licensed under the [Mozilla Public License 2.0](LICENSE).
Third-party code vendored under `apps/firefox-ui-demo/overlay/resources/vendor/` keeps its own license (see the `LICENSE` file in each folder).
