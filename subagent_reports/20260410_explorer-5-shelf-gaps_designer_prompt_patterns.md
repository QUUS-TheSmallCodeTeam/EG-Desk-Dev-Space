# Explorer-5 Shelf Gaps Report — Designer Prompt Patterns

**Agent**: explorer-5-shelf-gaps
**Date**: 2026-04-10
**Tier**: SHELF GAP-FILLING (WM-excluded / under-assigned paths)
**Report to**: sprint-leader

---

## Executive Summary

- **Biggest find**: `references/agent-orchestration/oh-my-claudecode/agents/designer.md` — a full, production-grade designer-developer agent prompt (104 lines) with XML-tagged sections (Role / Why_This_Matters / Success_Criteria / Constraints / Investigation_Protocol / Tool_Usage / Execution_Policy / Output_Format / Failure_Modes_To_Avoid / Examples / Final_Checklist). **Highly transferable** to EG-Desk's `design-agent.md`.
- **Biggest dead-end**: `references/infinite-canvas/` is NOT a spatial UI library. It is a 2D drawing canvas (HTML5 `<canvas>` + pan/zoom/rotate for `CanvasRenderingContext2D` paths). Relevance to EG-Desk's DOM-card spatial canvas = **LOW**. The name is misleading.
- **Medium find**: Theia's `side-panel-handler.ts` + `ColorRegistry` show a mature pattern for collapsible docked panels and CSS-variable-driven theming. Architecture useful, UX model different (tab-bar docks vs EG-Desk's edge-hover reveal).
- **Agent-research Priority B**: `copilotkit` does not exist in this shelf. `hermes-agent` and `openjarvis` have system prompt builders but they are orchestration wiring, not designer personas. `atlas` and `500-ai-agents` = confirmed dead-ends.

---

## 1. infinite-canvas findings

**Repo**: `references/infinite-canvas/` (ef-infinite-canvas, npm package)
**Nature**: A library that wraps HTML5 `<canvas>` and extends `CanvasRenderingContext2D` with pan/zoom/rotate transforms plus the ability to draw paths "at infinity" (e.g. `moveToInfinityInDirection(x, y)`, `lineToInfinityInDirection(x, y)`, `fillRect(-Infinity, -Infinity, Infinity, Infinity)`).

**Structure verified**:
- `src/api/` — `InfiniteCanvas`, `InfiniteCanvasRenderingContext2D`, `Transformation`, `Transformable`, `EventMap`, `TransformationEvent`, `DrawEvent`, `TouchEvent`, `Transformed`, `Config`, `Units`
- `src/impl/` — `Transformer`, `Viewbox`, `InstructionSet`, `Areas`, `Rectangle`, `Geometry`, `State`, `Styles`, `InfiniteContext` (drawing instruction recorder), `DrawingInstruction`, `InfiniteCanvasPathInfinityProvider`
- `docs/guide.md` — explains `moveToInfinityInDirection`, `lineToInfinityInDirection`, infinite `rect()`, `fillRect`, and the coordinate-transformed Mouse/Touch/Wheel events (`offsetX/Y` and `infiniteCanvasX/Y` are relative to the transformed canvas space, not the DOM canvas)
- `docs/getting-started.md` — basic usage: `new InfiniteCanvas(canvasElement).getContext('2d')` then draw with standard Canvas API calls
- `examples/catalog/` — 5 tiny demo pages: `getting-started`, `start-path-at-infinity`, `line-to-infinity`, `infinite-rectangles-1`, `resetting`. All are line/rect drawing demos, not UI widget placement.

**Limitations** (from `docs/guide.md` §Limitations):
> Animations are expensive on InfiniteCanvas — every pan/zoom/rotate forces a full redraw because the drawing has to be kept in memory.
> Does NOT support `getImageData()`, `createImageData()`, `isPointInPath()`, `isPointInStroke()`, `drawFocusIfNeeded()`, `scrollPathIntoView()`.

**Relevance to EG-Desk**:
- EG-Desk's spatial canvas places DOM elements (browser tab cards, PDF cards, Excel cards, HUD panels) on a workspace with pan/zoom. The underlying tech is expected to be DOM-based or WebGL-layered (transform: translate/scale), not Canvas2D draw calls.
- `ef-infinite-canvas` cannot place or interact with DOM cards. It only draws paths and shapes. Its `infiniteCanvasX/Y` mouse-event translation pattern is useful conceptually but trivial to reimplement.
- **Verdict**: **LOW relevance**. Flagging as dead-end for design language / spatial UI. Can be dropped from the shelf or repurposed only if EG-Desk needs true Canvas2D background drawing (e.g. annotation overlays), which the current brainstorming docs don't require.

**Recommendation**: Remove from the design-agent's reading list. If EG-Desk needs an infinite-canvas DOM-element framework, research `react-zoom-pan-pinch`, `use-gesture` + `framer-motion`, or Excalidraw-style architectures via web search (E6's territory).

---

## 2. theia findings

**Repo**: `references/theia/` (Eclipse Theia, the IDE framework VSCode Web is based on)
**Nature**: A TypeScript monorepo (lerna, 77 packages) that builds a browser-or-Electron IDE. Uses Lumino 2.x for the widget system (tabs, panels, dock layout).

### 2.1 Dock/panel/side-edge patterns — `packages/core/src/browser/shell/`

Relevant files:
- `application-shell.ts` — top-level layout manager
- `side-panel-handler.ts` — left/right side panels with collapsible tab bars
- `theia-dock-panel.ts` — dockable widget container
- `theia-split-panel.ts`
- `split-panels.ts` — split position handler with animated expansion
- `tab-bars.ts` — side tab bar widgets
- `sidebar-menu-widget.tsx`, `sidebar-top-menu-widget.tsx`, `sidebar-bottom-menu-widget.tsx`
- `side-panel-toolbar.ts`
- `additional-views-menu-widget.tsx` — overflow menu for hidden tabs
- `tab-bar-toolbar/`

**Key pattern** (from `side-panel-handler.ts`):

```typescript
// L39-44: CSS class conventions
export const LEFT_RIGHT_AREA_CLASS = 'theia-app-sides';
const COLLAPSED_CLASS = 'theia-mod-collapsed';

// L789-794: Explicit 4-state enum for expansion
export enum ExpansionState {
    collapsed = 'collapsed',
    expanding = 'expanding',
    expanded = 'expanded',
    collapsing = 'collapsing'
}

// L764-787: Persisted State type with lastPanelSize (width before collapse)
export interface State {
    empty: boolean;
    expansion: ExpansionState;
    pendingUpdate: Promise<void>;
    lastActiveTabIndex?: number;
    lastPanelSize?: number;  // restored on re-expand
}
```

**Architecture notes**:
- Uses InversifyJS DI (property injection, `@postConstruct` init). Every shell component is `@injectable` and bound via modules.
- Widget system is `@lumino/widgets` (not React for the shell itself — React is only used inside widget content).
- Side panels are controlled entirely through tab selection — setting `tabBar.currentTitle = null` hides the panel; setting it to a title reveals that widget.
- `refreshVisibility()` / `collapse()` / `expand()` drive animated transitions between states.
- There's a sash (draggable divider) that auto-hides when the side panel is collapsed.
- Drag-and-drop support: `revealTimeout` — dragging a widget over a collapsed side panel expands it after a delay so the user can drop into the panel. See `side-panel-handler.ts:717`: "Set this to `-1` to disable expanding the side panel while dragging."

### 2.2 Theming — `packages/core/src/browser/color-registry.ts`

```typescript
// L22-60 (excerpt)
@injectable()
export class ColorRegistry {
    toCssVariableName(id: string, prefix = 'theia'): string {
        return `--${prefix}-${id.replace(/\./g, '-')}`;
    }
    register(...definitions: ColorDefinition[]): Disposable { ... }
}
```

**Pattern**: Colors are registered programmatically with IDs like `widget.shadow`, automatically exposed as CSS variables `--theia-widget-shadow`. The coding guidelines (`doc/coding-guidelines.md` §Theming) forbid hard-coded CSS colors and require:

1. New colors registered via `ColorContribution` + `ColorRegistry.register`
2. Derive new colors from existing VS Code colors via `Color.lighten('widget.shadow', 0.4)`
3. Only apply concrete color values in the per-theme JSON files (`light_theia.json`, `dark_theia.json`, `hc_theia.json`)
4. Variable naming pattern: `object.property` (e.g. `secondaryButton.foreground`, not `button.secondary.foreground`)

### 2.3 `doc/` — developer documentation

Files in `references/theia/doc/`: `Developing.md`, `Migration.md`, `Plugin-API.md`, `Publishing.md`, `Testing.md`, `api-management.md`, `api-testing.md`, `code-organization.md`, `coding-guidelines.md`, `pull-requests.md`, `runtime-policy.md`, `vscode-usage.md`.

- `code-organization.md` — platform-folder rules (`browser/` cannot import `node/`, etc.)
- `coding-guidelines.md` — TypeScript style, DI property injection, `@postConstruct`, InversifyJS conventions, Theming section, CSS rules, React patterns (don't bind in event handlers)
- `Plugin-API.md` — Main-Ext RPC pattern for plugin isolation

**None of these contain EG-Desk-relevant UX/design metaphors.** They're developer-facing engineering conventions.

### 2.4 `dev-packages/` — confirmed dead-end for design

Contents: `application-manager`, `application-package`, `cli`, `ffmpeg`, `localization-manager`, `native-webpack-plugin`, `ovsx-client`, `private-eslint-plugin`, `private-ext-scripts`, `private-re-exports`, `private-test-setup`, `request`. All build/infrastructure tooling. **No UI, no design content.**

### 2.5 `configs/` — confirmed dead-end for design

Contents: `base.eslintrc.json`, `base.tsconfig.json`, `build.eslintrc.json`, `errors.eslintrc.json`, `license-check-config.json`, `merge.typedoc.json`, `mocharc.yml`, `nyc.json`, `package.typedoc.json`, `warnings.eslintrc.json`, `xss.eslintrc.json`. All linting, TS, and test-runner config. **No theme/design configs.**

### 2.6 Relevance to EG-Desk L3 4-Edge Framework

The EG-Desk spec (`DESIGN_SYSTEM_SPEC.md` §7) defines 4 edges: Desk Rail (top), Dock (bottom), Preset Bag (left), Contextual HUD Panel (right). Each with:
- Floating 12-24px from viewport edge (NOT touching)
- Frosted glass (`rgba(255,255,255,0.6)` + `backdrop-filter: blur(20px) saturate(180%)`)
- Auto-hide reveal: "커서가 뷰포트 가장자리 3px 이내에 0.3초 머물면 해당 Edge slide-in, 0.5초 후 slide-out"

**Theia's model is different**:
- Theia panels attach to the viewport edge (not floating).
- Theia uses collapsible tab-bar docks, not edge-hover slide-in.
- Theia has no frosted glass, no auto-hide-on-cursor-proximity.
- Theia's expansion triggers are: (a) clicking a tab, (b) drag-and-drop hover timeout over collapsed panel.

**What's transferable from Theia**:
1. **ExpansionState enum pattern** — having explicit `expanding`/`collapsing` transition states (not just binary `open/closed`) lets EG-Desk animate the reveal/hide without race conditions. Worth stealing.
2. **State persistence** — remembering `lastPanelSize` / `lastActiveTabIndex` across collapse-expand cycles. Useful for per-edge visibility restoration.
3. **CSS variable naming convention** — EG-Desk's `DESIGN_SYSTEM_SPEC.md` §2 already defines tokens like "Surface #F5F3EF", "Primary #2D5A7B". Theia's `object.property` naming (`secondaryButton.foreground`) + auto-generated `--theia-*` CSS variables is a solid pattern to adopt. EG-Desk could use `--egdesk-surface`, `--egdesk-primary`, `--egdesk-on-surface`, etc.
4. **Drag-hover-reveal** — Theia's pattern of expanding a collapsed panel during a drag operation (with a delay) directly matches EG-Desk's Preset Bag "drag-to-canvas to unpack" and "drag-from-canvas to pack" flows. Reuse the delay-based expansion UX.
5. **Contribution-point pattern** — Theia's `ColorContribution`, `CommandContribution`, `KeybindingContribution` interfaces could inspire EG-Desk if/when it needs plugin-extensible Edge content (e.g. third-party dock icons).

**Verdict**: **MEDIUM relevance**. Theia is architectural inspiration for implementation (state enums, DI, CSS variables, drag-hover-reveal), but its UX model differs from the 4-Edge frosted-glass floating-capsule language. Do not copy theia's visual style.

---

## 3. agent-research findings

### 3.1 `copilotkit` — DOES NOT EXIST

Listed in the task scope but `ls references/agent-research/copilotkit/` returns "No such file or directory". Actual contents of `references/agent-research/`: `500-ai-agents`, `atlas`, `autoresearch`, `awesome-ai-agents`, `browseros`, `context-mode`, `hermes-agent`, `nodeskclaw`, `openjarvis`, `walnut`.

**Verdict**: The WM's scope had an incorrect entry. Dead-end (path missing).

### 3.2 `hermes-agent` — orchestration wiring, no designer prompt

Structure: `acp_adapter/`, `acp_registry/`, `agent/` (prompt_builder.py, memory_manager.py, model_metadata.py, prompt_caching.py, context_compressor.py, etc.), `batch_runner.py`, `cli.py`, `cron/`.

Found in `agent/prompt_builder.py` — **channel-specific prompt fragments** (relevant pattern, not a designer prompt):

```python
# L270-288 verbatim
"cron": (
    "You are running as a scheduled cron job. There is no user present — you "
    "cannot ask questions, request clarification, or wait for follow-up. Execute "
    "the task fully and autonomously, making reasonable decisions where needed. "
    "Your final response is automatically delivered to the job's configured "
    "destination — put the primary content directly in your response."
),
"cli": (
    "You are a CLI AI Agent. Try not to use markdown but simple text "
    "renderable inside a terminal."
),
"sms": (
    "You are communicating via SMS. Keep responses concise and use plain text "
    "only — no markdown, no formatting. SMS messages are limited to ~1600 "
    "characters, so be brief and direct."
),
```

Also exports a `build_skills_system_prompt()` function and skills prompt caching with mtime-manifest-based invalidation (L320-368).

**Relevance to EG-Desk designer prompt**: **Pattern only, not content.** Hermes shows how to compose context-specific system prompt fragments that adapt behavior to the deployment channel (cron vs cli vs sms). EG-Desk's design-agent could similarly have "figma mode" vs "stitch mode" vs "codex mode" fragments. But there is no designer persona content to copy verbatim.

### 3.3 `openjarvis` — has a SystemPromptBuilder class, not a designer persona

File: `src/openjarvis/prompt/builder.py`

```python
# L6-23 (excerpt)
from openjarvis.core.config import MemoryFilesConfig, SystemPromptConfig

class SystemPromptBuilder:
    """Assembles system prompts with frozen prefix for cache stability."""
    def __init__(
        self,
        system_prompt_config: Optional[SystemPromptConfig] = None,
        ...
    ):
        self._sp_config = system_prompt_config or SystemPromptConfig()
```

The `openjarvis/src/openjarvis/` tree has many sub-packages (`agents/`, `channels/`, `connectors/`, `core/`, `daemon/`, `engine/`, `evals/`, `intelligence/`, `learning/`, `mcp/`, `operators/`, `optimize/`, `prompt/`, `recipes/`, `sandbox/`, `scheduler/`, `security/`, `sessions/`, `skills/`, `speech/`, `templates/`). The `agents/` dir has `channel_agent.py`, `claude_code.py`, `deep_research.py`, `executor.py`, `native_openhands.py`, `native_react.py`, `openhands.py`, `operative.py`, `orchestrator.py`, `react.py` — these are orchestration agent classes, not Markdown designer personas.

**Relevance**: **Pattern only.** The "frozen prefix for cache stability" idea is useful for EG-Desk's design-agent if prompts get long. No verbatim designer content.

### 3.4 `atlas` — dead-end

Docs: `API.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, `SETUP.md`, `TROUBLESHOOTING.md`, `V2_5_ABLATION_STUDY.md`, `V3_ABLATION_STUDY.md`. All technical architecture/operations. No designer prompts, no UI/UX content.

Inner `atlas/atlas/`: `dashboard/`, `manifests/`, `sandbox/`, `task-worker/`, `v1_archived/`. Task orchestration, not design.

**Verdict**: Dead-end for designer prompts.

### 3.5 `500-ai-agents` — dead-end

Confirmed: README says "A curated collection of AI agent use cases across industries" — it's a link list of 500+ open-source projects organized by framework (CrewAI, AutoGen, Agno, Langgraph). Only contents:

```
CONTRIBUTION.md  LICENSE  README.md
crewai_mcp_course/  images/
```

The `crewai_mcp_course/` is a learning course, not prompt templates.

**Verdict**: Dead-end. WM's "awesome list, skip" assessment was correct.

---

## 4. agent-tools remainder

### 4.1 `nvidia-nemoclaw` — dead-end

Structure: `bin/`, `ci/`, `docs/`, `k8s/`, `nemoclaw/` (source), `Dockerfile`, `Makefile`, `install.sh`.

Docs contents: `CONTRIBUTING.md`, `_ext/`, `_templates/`, `about/`, `conf.py`, `deployment/`, `get-started/`, `index.md`, `inference/`, `monitoring/`, `network-policy/`, `project.json`, `reference/`, `resources/`, `security/`, `workspace/`.

Grep for `designer|design system|UI/UX` across the entire repo: **0 files matched**.

**Verdict**: Dead-end. Nvidia's nemoclaw is an inference/deployment agent platform, not a UI design tool.

### 4.2 `sim-studio` — dead-end for EG-Desk's desk canvas

This is an open-source platform for building agent workflows. From its README:
> "The open-source platform to build AI agents and run your agentic workforce."
> "Design agent workflows visually on a canvas—connect agents, tools, and blocks, then run them instantly."

UI stack: Shadcn + Tailwind CSS (stated in README L144).

The "canvas" here is a **node-graph workflow canvas** (think n8n, Langflow, Flowise) — nodes are agent/tool blocks connected by edges representing data flow. This is NOT the "physical desk with spatial file cards" metaphor EG-Desk uses. Different UX paradigm.

**What's transferable**: Nothing for EG-Desk's spatial file canvas. The Shadcn + Tailwind stack choice is a data point (a common modern default, not a breakthrough).

**Verdict**: Dead-end.

### 4.3 `agent-deck` — dead-end

File `skills/agent-deck/SKILL.md` L1-15 verbatim:

```
name: agent-deck
description: Terminal session manager for AI coding agents. Use when user mentions "agent-deck", "session", "sub-agent", "MCP attach", "git worktree", or needs to (1) create/start/stop/restart/fork sessions, (2) attach/detach MCPs, (3) manage groups/profiles, ...
```

It's a TUI session manager built with Go + Bubble Tea. No UI design content, no designer persona.

**Verdict**: Dead-end.

### 4.4 `agent-skills-cli` — dead-end

Contents: `skills/` dir has only `deep-researcher/` and `test-skill/`. No designer skill.

**Verdict**: Dead-end.

---

## 5. agent-orchestration remainder

### 5.1 `oh-my-claudecode/agents/designer.md` — THE GOLD FIND

**Full 104-line designer agent** at `references/agent-orchestration/oh-my-claudecode/agents/designer.md`.

Key quotes (verbatim):

**Frontmatter**:
```
---
name: designer
description: UI/UX Designer-Developer for stunning interfaces (Sonnet)
model: claude-sonnet-4-6
level: 2
---
```

**Role** (L9-13):
> You are Designer. Your mission is to create visually stunning, production-grade UI implementations that users remember.
> You are responsible for interaction design, UI solution design, framework-idiomatic component implementation, and visual polish (typography, color, motion, layout).
> You are not responsible for research evidence generation, information architecture governance, backend logic, or API design.

**Why_This_Matters** (L15-17):
> Generic-looking interfaces erode user trust and engagement. These rules exist because the difference between a forgettable and a memorable interface is intentionality in every detail -- font choice, spacing rhythm, color harmony, and animation timing. A designer-developer sees what pure developers miss.

**Success_Criteria** (L19-26):
> - Implementation uses the detected frontend framework's idioms and component patterns
> - Visual design has a clear, intentional aesthetic direction (not generic/default)
> - Typography uses distinctive fonts (not Arial, Inter, Roboto, system fonts, Space Grotesk)
> - Color palette is cohesive with CSS variables, dominant colors with sharp accents
> - Animations focus on high-impact moments (page load, hover, transitions)
> - Code is production-grade: functional, accessible, responsive

**Constraints** (L28-34):
> - Detect the frontend framework from project files before implementing (package.json analysis).
> - Match existing code patterns. Your code should look like the team wrote it.
> - Complete what is asked. No scope creep. Work until it works.
> - Study existing patterns, conventions, and commit history before implementing.
> - Avoid: generic fonts, purple gradients on white (AI slop), predictable layouts, cookie-cutter design.

**Investigation_Protocol** (L36-42):
> 1) Detect framework: check package.json for react/next/vue/angular/svelte/solid. Use detected framework's idioms throughout.
> 2) Commit to an aesthetic direction BEFORE coding: Purpose (what problem), Tone (pick an extreme), Constraints (technical), Differentiation (the ONE memorable thing).
> 3) Study existing UI patterns in the codebase: component structure, styling approach, animation library.
> 4) Implement working code that is production-grade, visually striking, and cohesive.
> 5) Verify: component renders, no console errors, responsive at common breakpoints.

**Failure_Modes_To_Avoid** (L84-90):
> - Generic design: Using Inter/Roboto, default spacing, no visual personality. Instead, commit to a bold aesthetic and execute with precision.
> - AI slop: Purple gradients on white, generic hero sections. Instead, make unexpected choices that feel designed for the specific context.
> - Framework mismatch: Using React patterns in a Svelte project. Always detect and match the framework.
> - Ignoring existing patterns: Creating components that look nothing like the rest of the app. Study existing code first.
> - Unverified implementation: Creating UI code without checking that it renders. Always verify.

**Examples** (L92-95):
> **Good**: Task: "Create a settings page." Designer detects Next.js + Tailwind, studies existing page layouts, commits to a "editorial/magazine" aesthetic with Playfair Display headings and generous whitespace. Implements a responsive settings page with staggered section reveals on scroll, cohesive with the app's existing nav pattern.
> **Bad**: Task: "Create a settings page." Designer uses a generic Bootstrap template with Arial font, default blue buttons, standard card layout. Result looks like every other settings page on the internet.

**Output_Format** (L63-82):
```
## Design Implementation

**Aesthetic Direction:** [chosen tone and rationale]
**Framework:** [detected framework]

### Components Created/Modified
- `path/to/Component.tsx` - [what it does, key design decisions]

### Design Choices
- Typography: [fonts chosen and why]
- Color: [palette description]
- Motion: [animation approach]
- Layout: [composition strategy]

### Verification
- Renders without errors: [yes/no]
- Responsive: [breakpoints tested]
- Accessible: [ARIA labels, keyboard nav]
```

**Relevance to EG-Desk**: **VERY HIGH (5/5)**. This is exactly the shape a production design-agent prompt should take. EG-Desk's `design-agent.md` draft can mirror this XML-tagged structure (`<Role>`, `<Constraints>`, `<Investigation_Protocol>`, `<Failure_Modes_To_Avoid>`, `<Examples>`, `<Final_Checklist>`) and specialize the content for:
- **Role**: Figma-first Figma MCP workflow (not codegen)
- **Tool_Usage**: Figma MCP + Codex CLI (not Read/Write/Bash)
- **Constraints**: Locked to `DESIGN_SYSTEM_SPEC.md` tokens (LIGHT mode, #F5F3EF surface, Primary #2D5A7B, no tilt, no dark mode, no 3D, no gradients, 4-Edge Framework)
- **Failure_Modes_To_Avoid**: Add EG-Desk-specific "AI slop" list — purple aurora glassmorphism, dark mode, cards as icons, chat-thread layouts, persistent chat windows, dock bars touching screen edge, >5 elements per edge, rotated cards
- **Investigation_Protocol**: Read `DESIGN_SYSTEM_SPEC.md` §1-10 + `DESK_BEHAVIORS_BY_OBJECT.md` + `docs/vision/ontology-bridge.md` BEFORE generating designs

Interesting specific anti-pattern lists from the oh-my-claudecode designer that EG-Desk can reuse verbatim:
- "generic fonts, purple gradients on white (AI slop), predictable layouts, cookie-cutter design"
- "Using Inter/Roboto, default spacing, no visual personality" (note: EG-Desk DESIGN_SYSTEM_SPEC §3 actually *mandates* Inter, so this rule must be *inverted* for EG-Desk — Inter is required, not forbidden. This is a signal that EG-Desk has a distinctive-enough system specification that the project overrides the generic designer's "avoid common fonts" rule).

### 5.2 `ruflo/agents/` — dead-end

Contents: `architect.yaml`, `coder.yaml`, `reviewer.yaml`, `security-architect.yaml`, `tester.yaml`. **No designer agent.**

### 5.3 `clawteam/clawteam/templates/` — dead-end

TOML template files: `code-review.toml`, `harness-default.toml`, `hedge-fund.toml`, `research-paper.toml`, `software-dev.toml`, `strategy-room.toml`.

`software-dev.toml` grep hits:
```
L37: - Design and implement RESTful APIs
L56: - Implement responsive UI components
L110: subject = "Design and implement backend API endpoints"
L114: subject = "Implement frontend UI components"
```

These are tmux-backend task subjects for a generic software-dev team, not a designer persona.

**Verdict**: Dead-end.

### 5.4 `deer-flow` — dead-end

Python backend + Next.js frontend + tooling skills. Grep for designer|design system|UI designer across the repo hits only:
- 2 SKILL.md files for ppt-generation and image-generation (content-generation tools, not designer personas)
- 5 demo thread JSONs (user-facing demo data)

**No designer persona file.**

### 5.5 `claude-agent-flow/src/` — dead-end

Only 3 TypeScript files: `extension.ts`, `jsonlParser.ts`, `sessionWatcher.ts`. A VSCode extension that parses Claude Code JSONL session files. No UI design content.

### 5.6 `724-office/` — dead-end

Single-flat Chinese agent platform: `llm.py`, `mcp_client.py`, `memory.py`, `router.py`, `scheduler.py`, `self_check_tool.py`, `tools.py`, `xiaowang.py`, `config.example.json`, `README.md`. Backend orchestration, no UI content.

### 5.7 `oh-my-claudecode/CLAUDE.md` — orchestration manual (context)

Worth noting: oh-my-claudecode positions itself as a multi-agent orchestration layer with model-routing rules:
> Delegate for: multi-file changes, refactors, debugging, reviews, planning, research, verification.
> Direct writes OK for: `~/.claude/**`, `.omc/**`, `.claude/**`, `CLAUDE.md`, `AGENTS.md`.
> Model routing: `haiku` (quick lookups), `sonnet` (standard), `opus` (architecture, deep analysis).

And its agent catalog (verbatim):
> explore (haiku), analyst (opus), planner (opus), architect (opus), debugger (sonnet), executor (sonnet), verifier (sonnet), tracer (sonnet), security-reviewer (sonnet), code-reviewer (opus), test-engineer (sonnet), **designer (sonnet)**, writer (haiku), qa-tester (sonnet), scientist (sonnet), document-specialist (sonnet), git-master (sonnet), code-simplifier (opus), critic (opus)

This is a 19-agent catalog where designer is level-2 (sonnet model). Mirrors how EG-Desk's swarm model-priority works (`opus > sonnet > never haiku`).

---

## 6. Top transferable primitives

Scored 1-5 for EG-Desk relevance (5 = directly reusable, 1 = inspiration only).

| # | Primitive | Source | Score | How to use in EG-Desk design-agent |
|---|-----------|--------|-------|------------------------------------|
| **1** | **XML-tagged agent prompt template** (`<Role>`, `<Why_This_Matters>`, `<Success_Criteria>`, `<Constraints>`, `<Investigation_Protocol>`, `<Tool_Usage>`, `<Execution_Policy>`, `<Output_Format>`, `<Failure_Modes_To_Avoid>`, `<Examples>`, `<Final_Checklist>`) | `oh-my-claudecode/agents/designer.md` | **5/5** | Use this structure verbatim in `design-agent.md`. Replace content with EG-Desk-specific spec (Figma MCP workflow, DESIGN_SYSTEM_SPEC.md enforcement, 4-Edge Framework anti-patterns). Model: `claude-sonnet-4-6` or `opus`. |
| **2** | **"Failure modes to avoid" explicit list** — name the AI-slop patterns the agent must not produce | `oh-my-claudecode/agents/designer.md` | **5/5** | EG-Desk list: purple aurora glassmorphism, dark mode, cards as icons, rotated cards, persistent chat windows, dock bars touching screen edge, >5 elements per edge, 3D transforms, perspective, neon colors, gradients. Read from `DESIGN_SYSTEM_SPEC.md` §4 forbidden list. |
| **3** | **"Commit to aesthetic direction BEFORE coding"** principle — force the agent to articulate Purpose/Tone/Constraints/Differentiation before implementation | `oh-my-claudecode/agents/designer.md` (L38) | **4/5** | For EG-Desk, the aesthetic is ALREADY committed (Ambient AI Workspace, overhead desk view, frosted glass edges, LIGHT mode, Inter). The agent should read `DESIGN_SYSTEM_SPEC.md` §10-2 `designMd` block verbatim and reference it in every Figma MCP call. |
| **4** | **ExpansionState enum + lastPanelSize persistence** pattern for edge panels | `theia/packages/core/src/browser/shell/side-panel-handler.ts` L789-794, L764-787 | **4/5** | When EG-Desk implements the 4-Edge Framework, use explicit `collapsed / expanding / expanded / collapsing` state enum (not binary) to prevent race conditions in cursor-hover slide-in/slide-out animations. Remember `lastPanelSize` / `lastActiveTabIndex` per edge across reveals. |
| **5** | **CSS variable naming convention** `object.property` → `--prefix-object-property` generated from `ColorRegistry` | `theia/packages/core/src/browser/color-registry.ts` + `doc/coding-guidelines.md` §Theming | **3/5** | EG-Desk's `DESIGN_SYSTEM_SPEC.md` §2 already lists tokens. Adopt `--egdesk-surface`, `--egdesk-surface-elevated`, `--egdesk-primary`, `--egdesk-on-surface`, etc. Enforce "no hardcoded hex in components, only var() references" in design-agent constraints. |

---

## 7. Confirmed dead-ends (sprint-leader should NOT revisit)

Paths verified to contain no designer persona / UI metaphor / EG-Desk-transferable content:

1. `references/infinite-canvas/` — entire repo. It's a Canvas2D drawing library, not a spatial DOM UI library. Name is misleading. **Score 0/5 for design language.**
2. `references/infinite-canvas/docs/` — confirmed drawing-API documentation only
3. `references/infinite-canvas/examples/` — 5 line/rect drawing demos
4. `references/theia/configs/` — only eslint/tsconfig/mocha/nyc build config files
5. `references/theia/dev-packages/` — only build/CLI/localization/webpack infrastructure
6. `references/theia/doc/` — developer engineering docs (TypeScript style, DI, testing), no UX metaphors
7. `references/agent-research/copilotkit/` — **path does not exist** in the shelf
8. `references/agent-research/hermes-agent/` — no designer prompt (channel-specific prompt builder only)
9. `references/agent-research/openjarvis/` — SystemPromptBuilder class only, no designer persona
10. `references/agent-research/atlas/` — technical architecture docs only
11. `references/agent-research/500-ai-agents/` — curated link list, no prompt content
12. `references/agent-tools/nvidia-nemoclaw/` — grep confirmed 0 matches for designer|design system|UI/UX
13. `references/agent-tools/sim-studio/` — workflow-graph canvas (n8n-style), not spatial desk UI
14. `references/agent-tools/agent-deck/` — TUI terminal session manager, no design content
15. `references/agent-tools/agent-skills-cli/skills/` — only `deep-researcher` + `test-skill`, no designer
16. `references/agent-orchestration/clawteam/clawteam/templates/` — tmux task-subject TOMLs, no designer persona
17. `references/agent-orchestration/ruflo/agents/` — 5 YAMLs (architect/coder/reviewer/security/tester), no designer
18. `references/agent-orchestration/deer-flow/` — grep confirmed only ppt/image-generation skills + demo JSONs, no designer persona
19. `references/agent-orchestration/claude-agent-flow/src/` — 3-file VSCode extension for JSONL session parsing
20. `references/agent-orchestration/724-office/` — Chinese single-file Python agent platform, no UI content

---

## 8. Gap recovered summary

**What was recovered that WM had excluded or under-assigned:**

1. **A full production-grade designer persona prompt** at `oh-my-claudecode/agents/designer.md` — 104 lines, XML-tagged, with Role/Constraints/Investigation Protocol/Failure Modes/Examples. **This is the single most valuable shelf asset for EG-Desk's `design-agent.md` template.**
2. **Theia's panel state machine + theming pattern** for implementing the 4-Edge Framework's collapsible reveal UX — useful as architectural reference even though Theia's visual style differs.
3. **Confirmation that `infinite-canvas` is NOT a spatial UI library** — important negative result. WM's "DIRECTLY relevant to EG-Desk's spatial canvas design language" assessment was wrong. E6's web research should look for real DOM-based infinite-canvas libraries (react-zoom-pan-pinch, Excalidraw architecture, use-gesture patterns).

**infinite-canvas / theia value**: **LOW for infinite-canvas, MEDIUM for theia.**

---

## Files read during this scan

- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/.claude/agents/design-agent.md` (first 30 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` (L1-500)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/infinite-canvas/README.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/infinite-canvas/docs/index.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/infinite-canvas/docs/guide.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/infinite-canvas/docs/getting-started.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/theia/doc/code-organization.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/theia/packages/core/src/browser/shell/side-panel-handler.ts` (L1-100, L760-796)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/theia/packages/core/src/browser/color-registry.ts`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-research/hermes-agent/agent/prompt_builder.py` (L270-368)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-research/openjarvis/src/openjarvis/prompt/builder.py` (L1-30)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-research/500-ai-agents/README.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/sim-studio/README.md` (keyword excerpt)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/agent-deck/skills/agent-deck/SKILL.md`
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/oh-my-claudecode/agents/designer.md` (full 104 lines)
- Directory listings for all 21 Priority A/B/C paths

**files_created: [/Users/minsoocha/Projects/EG-Desk-Dev-Space/subagent_reports/20260410_explorer-5-shelf-gaps_designer_prompt_patterns.md]**
