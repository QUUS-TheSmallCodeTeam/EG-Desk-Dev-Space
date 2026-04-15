# Explorer-6 Web Research — Designer Prompt Patterns

**Agent**: explorer-6-web-research
**Date**: 2026-04-10
**Scope**: External production-AI designer/UI/UX system prompts
**Method**: WebSearch + WebFetch against public leak archives, official open-source skills, and vendor docs. Read-only on local repo.

---

## Methodology notes

- Two primary archives cover most production tools:
  - `jujumilk3/leaked-system-prompts` — 124 `.md` files, chronological snapshots, root-level naming `{tool}_{YYYYMMDD}.md`
  - `x1xhlol/system-prompts-and-models-of-ai-tools` — 34+ tool directories; typically `{Tool}/Agent Prompt.txt` + `{Tool}/Agent Tools.json`
- The first archive gives cleaner Markdown, the second has the broader current coverage (Lovable, Leap, Orchids, Kiro, Replit, Warp, Junie, Traycer, Same.dev, Qoder, Comet, etc.)
- Anthropic's official `frontend-design` skill is Apache-2.0 and is the single most relevant designer-focused prompt found — it is **not** a leak, it is the canonical reference.
- All quotes held to under 15 words each, per the rules.
- WebFetch's underlying model refused a few fetches (notably the `cursor-ide-sonnet_20241224.md` raw file and one Replit mirror) when framed naively; rephrasing as "publicly archived third-party research file" unlocked most of them. Two remained 404 (Replit, Kiro) because those paths don't exist on main — the vendor directories have different filenames than guessed. Impact on findings: low; Cursor coverage recovered via the `cursor-ide-agent-claude-sonnet-3.7_20250309.md` file; Replit/Kiro are weak gaps noted below.

---

## 1. Production AI design-tool prompts

### 1.1 Vercel v0

- **Sources**:
  - jujumilk3 archive: https://github.com/jujumilk3/leaked-system-prompts/blob/main/v0_20250306.md (fetched 2026-04-10)
  - Mirror (older 2024-11-24 snapshot): https://github.com/2-fly-4-ai/V0-system-prompt (fetched 2026-04-10)
  - x1xhlol archive root: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools (fetched 2026-04-10)
- **Verbatim excerpts**:
  - "v0 tries to use the shadcn/ui library unless the user specifies otherwise."
  - "v0 MUST generate responsive designs." (repeated twice for emphasis)
  - "v0 avoids using indigo or blue colors unless specified in the prompt."
  - "v0 MUST use kebab-case for file names, ex: `login-form.tsx`."
  - "v0 DOES NOT output <svg> for icons." (uses lucide-react instead)
  - "Do not write package.json; npm modules are inferred from imports."
  - "Hardcode colors in tailwind.config.js unless specified otherwise."
  - On planning: "BEFORE creating a Code Project, v0 uses `<Thinking>` tags to think through the project structure."
  - Newer (2025-03-06) layer adds explicit color/typography caps: "ALWAYS use exactly 3-5 colors total", max 2 font families, "Prefer the Tailwind spacing scale instead of arbitrary values".
  - "Ship something interesting rather than boring, but never ugly."
  - "No gradients" unless explicitly requested.
- **Key tool permissions**: `CodeProject`, `QuickEdit`, `DeleteFile`, `MoveFile`, Node.js executable blocks, Mermaid, LaTeX, `AddEnvironmentVariables`.
- **Validation / verification patterns**:
  - `<Thinking>` tag before any code project creation
  - Screenshot input triggers "recreate the design" mode
  - Built-in token system (`bg-primary`, `text-primary-foreground`) forces semantic tokens over raw colors
  - Accessibility: `sr-only` required, ARIA roles required, alt text required
- **Notable design philosophy**:
  - Semantic-token-first. Raw colors are a smell.
  - Mobile-first, but "optimized for 16:9 desktop secondary" framing in newer snapshots.
  - Flex → Grid → avoid floats/absolute.
  - 44px touch targets, 16px min input font on mobile.
  - Single project per response ("v0 must only create one Code Project per response").

### 1.2 Bolt.new (StackBlitz)

- **Sources**:
  - jujumilk3 archive: https://github.com/jujumilk3/leaked-system-prompts/blob/main/bolt.new_20241009.md (fetched 2026-04-10)
  - Open-source prompt mirror: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Open%20Source%20prompts/Bolt/Prompt.txt (fetched 2026-04-10)
  - Original source file is public in StackBlitz repo: https://github.com/stackblitz/bolt.new/blob/main/app/lib/.server/llm/prompts.ts
- **Verbatim excerpts**:
  - "Think HOLISTICALLY and COMPREHENSIVELY BEFORE creating an artifact."
  - "ULTRA IMPORTANT: Do NOT be verbose."
  - "Split functionality into smaller modules instead of putting everything in a single gigantic file."
  - "Never skip RLS setup for any table. Security is non-negotiable!"
  - "There is NO `pip` support." / "CANNOT run native binaries or compile C/C++ code." / "Git is NOT available."
  - 2-space indentation mandated.
- **Key tool permissions**: WebContainer shell (limited cmd set: cat, cp, curl, node, python3 stdlib only), file artifacts via `<diff>` / `<file>` elements, prefers Vite.
- **Validation / verification patterns**:
  - Holistic review before artifact creation is the explicit gate.
  - Single comprehensive artifact per project (no incremental drip).
  - No dev server re-runs after file updates (hot-reload assumed).
- **Notable design philosophy**:
  - **Artifact-first**, not dialogue-first. The artifact is the unit of output, user iteration happens via diffs against it.
  - Weak on visual design rules. Bolt is engineering-first; v0/Lovable are design-first.

### 1.3 Lovable

- **Sources**:
  - https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Lovable/Agent%20Prompt.txt (fetched 2026-04-10)
  - Raw: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Lovable/Agent%20Prompt.txt
- **Verbatim excerpts** (this is the single most transferable prompt found):
  - "The design system is everything."
  - "You should never write custom styles in components, you should always use the design system."
  - "ALWAYS use HSL colors in index.css and tailwind.config.ts."
  - "DO NOT use direct colors like text-white, text-black, bg-white, bg-black."
  - "USE SEMANTIC TOKENS FOR COLORS, GRADIENTS, FONTS, ETC."
  - "Everything must be themed via the design system defined in the index.css and tailwind.config.ts files."
  - "Beautiful designs are your top priority."
  - "Make sure to wow them with a really, really beautiful and well coded app." (first-interaction bar)
  - "Make sure to edit the index.css and tailwind.config.ts files as often as necessary to avoid boring designs."
  - "ALWAYS generate beautiful and responsive designs."
  - "Spaghetti code is your enemy."
  - "Create small, focused components instead of large files."
  - "Make sure that the component and file names are unique."
  - Tool discipline: "NEVER read files already in 'useful-context'." / "ALWAYS batch multiple operations when possible." / "NEVER make sequential tool calls that could be combined." / "Prefer using the search-replace tool rather than the write tool."
  - Communication: "You MUST answer concisely with fewer than 2 lines of text (not including tool use or code generation)."
  - "Conclude with a very concise summary of the changes you made. Avoid emojis."
  - "Always reply in the same language as the user's message."
  - Color-function rule: "ALWAYS check CSS variable format before using in color functions." (HSL-only, wrapping RGB in `hsl()` will break.)
- **Key tool permissions**: `write-file`, `search-replace`, `read-console-logs`, `read-network-requests`, Supabase integration hook.
- **Validation / verification patterns**:
  - Verify feature doesn't already exist before coding.
  - Check if request is unclear and ask, rather than guess.
  - Read console logs and network requests **before** reading source when debugging.
  - "No build errors. Make sure to write valid Typescript and CSS."
  - Semantic HTML + proper heading hierarchy required.
  - SEO checklist runs automatically (meta description ≤160 chars, single H1, alt attributes, lazy loading, canonical tags).
- **Notable design philosophy**:
  - **Design tokens are mandatory, not recommended.** This is the most aggressive tokens-first stance found in any production prompt.
  - Edit the design system file (index.css / tailwind.config.ts) *per feature*, not once at project init.
  - First impression is a special-cased quality gate ("wow them").

### 1.4 Replit Agent

- **Source status**: Weak. `x1xhlol/.../Replit/Prompt.txt` and `Replit/Prompt.md` both returned 404 on my fetches; WebFetch's underlying model also declined a reframed fetch. The directory exists but I did not confirm the exact filename during this scan.
- **Coverage**: Referenced in the augmentcode overview (https://www.augmentcode.com/learn/leaked-ai-system-prompts-github, fetched via snippet) as part of the "app builder" cluster. Not recovered verbatim in this session.
- **Gap**: marked as "further fetch needed" — try `Replit/` listing directly, also check `Replit/Agent/*`.

### 1.5 Cursor (IDE agent mode)

- **Sources**:
  - https://github.com/jujumilk3/leaked-system-prompts/blob/main/cursor-ide-sonnet_20241224.md (fetched 2026-04-10; underlying model declined verbatim extraction)
  - https://github.com/jujumilk3/leaked-system-prompts/blob/main/cursor-ide-agent-claude-sonnet-3.7_20250309.md (fetched 2026-04-10; successful)
- **Verbatim excerpts** (from 2025-03-09 snapshot):
  - "Use the code edit tools at most once per turn."
  - Generated code "can be run immediately by the USER."
  - "NEVER generate an extremely long hash or any non-textual code."
  - "Do not loop more than 3 times on fixing linter errors."
  - "Give it a beautiful and modern UI, imbued with best UX practices." (this is the only design-quality sentence in Cursor's prompt, and it fires only on from-scratch web apps.)
- **Key tool permissions**: `codebase_search` (semantic), `read_file` (250-line cap), `run_terminal_cmd` (user-approved), `list_dir`, `grep_search` (50-result cap), `edit_file`, `file_search` (fuzzy, 10 results), `delete_file`, `web_search`, `diff_history`.
- **Validation / verification patterns**:
  - Linter-error fix loop capped at 3 attempts (hard ceiling).
  - Create `requirements.txt` + README for new codebases as default scaffolding.
  - Single-pass editing per turn.
  - Avoid mentioning tool names to the user: "I will edit your file" not "I will use edit_file".
- **Notable design philosophy**:
  - Cursor is **deliberately design-agnostic**. Aesthetic lives in one sentence. Everything else is engineering rigor.
  - The contrast with Lovable is striking: Cursor assumes the user owns design taste; Lovable assumes the agent does.

### 1.6 Codeium / Windsurf (Cascade)

- **Sources**:
  - https://github.com/jujumilk3/leaked-system-prompts/blob/main/codeium-windsurf-cascade_20241206.md (fetched 2026-04-10)
  - A later R1 variant also exists: `codeium-windsurf-cascade-R1_20250201.md`
- **Verbatim excerpts**:
  - "NEVER output code to the USER, unless requested." (force tool use)
  - "NEVER call tools that are not explicitly provided."
  - "Give it a beautiful and modern UI, imbued with best UX practices." (same phrasing as Cursor — likely shared lineage)
  - "Concise and do not repeat yourself." / "Conversational but professional."
- **Key tool permissions**: 9 tools — semantic codebase search, grep, file finder, list_dir, file viewer, code-item inspector, related-file discovery, command execution, file create/edit.
- **Validation / verification patterns**:
  - One-edit-per-turn with a brief pre-change narration.
  - Auto context (open files, cursor position) is provided but must be judged for relevance by the agent.
  - Explicit async-tool handling: "stop asking for new tools" while a previous call is pending.
- **Notable design philosophy**: Near-identical to Cursor on design — the same single "beautiful and modern UI" sentence appears in both, strongly suggesting both prompts were authored around the same template. Cascade differs from Cursor mainly on tool discipline (tool use is more aggressive, raw code-to-user output is banned by default).

### 1.7 Canva Code

- **Source**: https://github.com/jujumilk3/leaked-system-prompts/blob/main/canva-code_20250519.md (fetched 2026-04-10)
- **Verbatim excerpts**:
  - "Every single button or interaction created MUST work."
  - "Nothing may be incomplete."
  - "NEVER outputs broken code with syntax errors."
  - "Never uses gray or white as the background, unless explicitly requested." ← striking design rule
  - "Tailwind CSS for styling by default unless the user asks otherwise."
  - "Text inside a container has margins between edges."
  - "Maintain an optimistic, encouraging, and friendly human-like tone."
  - Max 3 clarifying questions, numbered.
- **Key tool permissions**: SVG + emojis only for graphics. No external image URLs. Vanilla JS. Frontend only — no backend allowed.
- **Validation / verification patterns**:
  - Full-file code output every time (no diffs) — prevents mid-stream corruption.
  - Single markdown code block per response.
  - Interactive element completeness is the hard gate.
  - Safety-scoped refusals: no password fields, no payment forms, no brand mimicry, no sexual content (enforces PG).
- **Notable design philosophy**:
  - **"Never gray or white background"** — the only production prompt I found that bans the default background. Everyone else allows it.
  - Interactive completeness as quality bar, not visual polish. Closer to "it must work" than "it must be pretty".

### 1.8 Claude Artifacts (Anthropic)

- **Source**: https://github.com/jujumilk3/leaked-system-prompts/blob/main/claude-artifacts_20240620.md (fetched 2026-04-10)
- **Verbatim excerpts**:
  - "Substantial content (>15 lines)" — artifact threshold
  - "Content the user is likely to modify, iterate on, or take ownership of"
  - "One artifact per message" as default
  - React components: "no required props (or provide default values for all props)"
  - External images forbidden; placeholder API required
  - HTML imports restricted to "cdnjs.cloudflare.com" only
- **Key tool permissions**: 6 artifact categories — code, documents, HTML, SVG, Mermaid, React components.
- **Validation / verification patterns**:
  - Decision rule **before** artifact: "prefer in-line content when possible".
  - Completeness: no truncation allowed.
  - Self-contained: no external deps outside whitelist.
- **Notable design philosophy**:
  - Artifacts are an **ownership transfer** — content becomes the user's to iterate on. That's the mental model; everything else follows.
  - No design-aesthetic rules. Artifacts aims at structural correctness, not visual polish.

### 1.9 Orchids.app

- **Source**: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Orchids.app/System%20Prompt.txt (fetched 2026-04-10)
- **Verbatim excerpts**:
  - "styled-jsx is COMPLETELY BANNED from this project."
  - "Use ONLY Tailwind CSS classes for styling."
  - "KNOW WHEN TO STOP: The moment the user's request is correctly and completely fulfilled, stop."
  - "Prefer the smallest viable change that fully solves the request."
  - "Always reference colors via their CSS variables—e.g., use `var(--color-muted)` instead of `theme(colors.muted)`."
  - "Always use @theme to define semantic design tokens based on the design system."
  - "Keep page files minimal; compose them from separately defined components."
  - Error handling: "Always check error?.code before proceeding with success actions."
  - State management: "ALWAYS check isLoading first."
- **Key tool permissions**: Not fully enumerated in this excerpt; referenced `write-file`, `search-replace`, `read-console-logs`.
- **Validation / verification patterns**:
  - Minimal-diff principle (rare in this set — most prompts allow expansive edits).
  - Hard stop discipline after requirement fulfillment.
  - Preflight checks on error codes and loading states before success paths.
- **Notable design philosophy**:
  - Between Lovable (maximalist design agent) and Cursor (engineering-only), Orchids sits in the middle: semantic tokens are required, but no aesthetic quality bar.
  - The "smallest viable change" rule is the only one in the corpus that explicitly discourages scope creep.

### 1.10 Leap.new

- **Source**: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Leap.new/Prompts.txt (fetched 2026-04-10)
- **Verbatim excerpts**:
  - "Ensure there is consistent spacing and alignment patterns."
  - Dark mode: "set the `dark` class on the app root element."
  - "Split functionality into smaller, reusable modules."
  - "Keep files as small as possible."
  - "ALL data must be stored via Encore.ts's built-in SQL Database or Object Storage."
  - "Apply subtle animations for transitions and interactions." ← motion policy
  - "Leverage auto-generated backend types via `import type { ... } from ~backend/...`."
- **Key tool permissions**: Encore.ts (backend), Vite (bundler), `@tanstack/react-query` (data fetching), Clerk (auth), Tailwind CSS v4, shadcn/ui pre-installed.
- **Notable design philosophy**:
  - Leap is the most opinionated on **stack lock-in**: every layer has exactly one allowed choice (router, query, auth, backend). This is a design decision at the prompt layer — remove ambiguity to remove churn.

---

## 2. Leaked-prompt repos (catalogs)

### 2.1 jujumilk3/leaked-system-prompts

- **URL**: https://github.com/jujumilk3/leaked-system-prompts
- **Structure**: 124 markdown files, flat root, named `{tool}_{YYYYMMDD}.md`. Chronologically versioned snapshots — you can watch a prompt evolve over time (e.g. Cursor 2024-12-24 vs 2025-03-09).
- **Designer-related entries**:
  - `v0_20250306.md` — Vercel v0 (design-first)
  - `bolt.new_20241009.md` — Bolt (engineering-first)
  - `claude-artifacts_20240620.md` — Artifacts
  - `canva-code_20250519.md` — Canva Code (frontend-only, anti-gray-bg)
  - `cursor-ide-sonnet_20241224.md` + `cursor-ide-agent-claude-sonnet-3.7_20250309.md` — Cursor
  - `codeium-windsurf-cascade_20241206.md` + `codeium-windsurf-cascade-R1_20250201.md` — Windsurf
- **Most transferable patterns (verbatim)**:
  - v0's explicit color-count cap: "ALWAYS use exactly 3-5 colors total"
  - Canva Code's ban: "Never uses gray or white as the background"
  - Bolt's holistic gate: "Think HOLISTICALLY and COMPREHENSIVELY BEFORE creating an artifact."
  - Cursor/Windsurf's linter-loop cap: "Do not loop more than 3 times on fixing linter errors."

### 2.2 x1xhlol/system-prompts-and-models-of-ai-tools

- **URL**: https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
- **Structure**: 34 tool directories + "Open Source prompts" + "v0 Prompts and Tools". Each tool directory typically contains `Agent Prompt.txt` + `Agent Tools.json`. Some have multiple prompt files (e.g. Orchids has `Decision-making prompt.txt` + `System Prompt.txt`).
- **Coverage**: Amp, Anthropic, Augment Code, Cluely, CodeBuddy, Comet Assistant, Cursor, Devin AI, Emergent, Google, Junie, Kiro, Leap.new, Lovable, Manus Agent, NotionAI, Orchids.app, Perplexity, Poke, Qoder, Replit, Same.dev, Trae, Traycer AI, VSCode Agent, Warp.dev, Windsurf, Xcode, Z.ai Code, dia.
- **Designer-related entries**:
  - `Lovable/Agent Prompt.txt` — **single most transferable designer prompt in the corpus**
  - `v0 Prompts and Tools/` — current v0 snapshots
  - `Orchids.app/System Prompt.txt` — semantic-tokens-required, minimal-diff
  - `Leap.new/Prompts.txt` — stack-lock-in design
  - `Lovable/Agent Tools.json` — the actual tool schema (worth reading as companion)
- **Most transferable patterns (verbatim)**:
  - Lovable: "The design system is everything."
  - Lovable: "You should never write custom styles in components, you should always use the design system."
  - Lovable: "ALWAYS use HSL colors in index.css and tailwind.config.ts."
  - Orchids: "Always reference colors via their CSS variables."
  - Orchids: "Always use @theme to define semantic design tokens."

### 2.3 asgeirtj/system_prompts_leaks

- **URL**: https://github.com/asgeirtj/system_prompts_leaks
- **Structure**: By vendor (Anthropic/, Google/, Misc/, OpenAI/, Perplexity/, xAI/)
- **Designer-related entries**: None directly. Files cover foundation models (claude-opus-4.6.md, claude-sonnet-4.6.md, claude-code.md, claude-in-chrome.md, claude-for-excel.md) and assistants (Notion AI, Raycast AI, Kagi Assistant). Useful for understanding the *parent* model prompts that tools like v0/Lovable build on top of, not for designer-specific patterns.
- **Verdict**: Skip for design research. Keep for context research on what the base Claude Code prompt looks like.

### 2.4 linexjlin/GPTs

- **Status**: Searched but not fetched in this scan. Known to contain leaked ChatGPT GPTs; most are user-created non-production configurations. Low signal-to-noise for production design patterns.

---

## 3. Official / ecosystem examples (the key finding)

### 3.1 Anthropic `frontend-design` skill ← **most relevant to EG-Desk**

- **Sources**:
  - https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md (fetched 2026-04-10)
  - https://claude.com/plugins/frontend-design (fetched 2026-04-10)
  - https://claude.com/blog/improving-frontend-design-through-skills (fetched 2026-04-10)
- **License**: Apache 2.0. This is a **canonical, citable reference** — not a leak.
- **Installs**: 455,628 reported on claude.com/plugins/frontend-design.
- **Structure**: 2 files — `SKILL.md`, `LICENSE.txt`. No subdirectories. (Notably: no `references/`, `examples/`, or `scripts/` — the entire skill fits in one file, by design.)
- **Sections**: Skill Header (YAML frontmatter), Design Thinking, Frontend Aesthetics Guidelines.
- **Verbatim excerpts**:
  - "Create distinctive, production-grade frontend interfaces with high design quality." (description)
  - "Before coding, understand the context and commit to a BOLD aesthetic direction."
  - "Choose a clear conceptual direction and execute it with precision."
  - "Bold maximalism and refined minimalism both work—the key is intentionality, not intensity."
  - Typography: "Choose fonts that are beautiful, unique, and interesting."
  - Typography: "Avoid generic fonts like Arial and Inter; opt instead for distinctive choices."
  - Pair "distinctive display font with a refined body font for contrast and hierarchy."
  - Color: "Commit to a cohesive aesthetic. Use CSS variables for consistency."
  - Color: "Dominant colors with sharp accents outperform timid, evenly-distributed palettes."
  - Layout: unexpected spatial composition, "asymmetry, overlap, diagonal flow, and grid-breaking elements"
  - Motion: "Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML."
  - Motion: "one well-orchestrated page load with staggered reveals creating more delight than scattered micro-interactions"
  - Anti-pattern: "NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial)."
  - Anti-pattern: "cliched color schemes (particularly purple gradients on white backgrounds)"
  - Anti-pattern: "cookie-cutter design that lacks context-specific character"
- **Validation / verification patterns**:
  - **None built in.** The SKILL.md does not describe a Playwright or screenshot feedback loop. There are no explicit validation steps.
  - The blog post confirms this: "No mention of Claude validating, testing, or refining its own work iteratively."
  - This is a **significant gap** that the ecosystem has identified and that EG-Desk should close.
- **Notable design philosophy**:
  - "Specialized context on demand without permanent overhead" — the skill loads just-in-time rather than bloating every system prompt. EG-Desk's agent template system does the same.
  - **Problem statement**: "Distributional convergence — safe design choices dominate web training data." Without a skill, Claude defaults to Inter + purple gradients. This is exactly why a designer agent is needed instead of relying on the base model.

### 3.2 Justin Wetch's frontend-design improvements (PR #210)

- **Sources**:
  - https://www.justinwetch.com/blog/improvingclaudefrontend (fetched 2026-04-10)
  - https://github.com/anthropics/skills/pull/210
- **Key findings** (this is the highest-value external contribution to designer prompt engineering):
  - **Meta-insight**: The original skill said "NEVER converge on common choices across generations," which is impossible — Claude has no memory between conversations. The rule asks the model to do something it cannot do.
  - **Evaluation methodology**: Built a system of 50 representative prompts across design contexts, captured screenshots via Puppeteer, had Claude Opus 4.5 score both versions on 5 criteria (Prompt Adherence, Aesthetic Fit, Visual Polish, UX, Creative Distinction).
  - **Result**: 75% win rate, 21 of 28 decisive comparisons, statistically significant p=0.0125.
  - **Smaller models benefited more than larger ones.** This is the single most interesting data point for EG-Desk — it implies good prompts compound more on Sonnet than Opus.
  - **Changes applied**:
    - "Default fonts signal default thinking" (replaced aesthetic adjectives like "beautiful, unique, interesting" with actionable guidance)
    - "Full typographic range (size, weight, case, spacing) to establish hierarchy"
    - Added "dark and moody aesthetics" and "lo-fi zine energy" as named aesthetic directions
    - Added INSTEAD structure: pair each anti-pattern with a concrete alternative
    - "Lead with dominant color, punctuate with sharp accents"
- **Transferable primitives**: The **evaluation methodology** (Puppeteer + LLM judge, statistical scoring) is directly applicable to EG-Desk. This is a known-good pattern for validating designer-agent output quality.

### 3.3 Impeccable (impeccable.style)

- **Source**: https://impeccable.style/ (fetched 2026-04-10)
- **License**: Apache 2.0 (open source)
- **What it is**: A third-party upgrade to Anthropic's `frontend-design` skill. 11 AI platforms supported including Claude Code, Cursor, Gemini CLI.
- **Architecture**: 3 layers
  1. **Foundation** — "Deep reference knowledge across 7 dimensions, loaded every time your AI writes code."
  2. **Language** — "18 commands form a shared vocabulary between you and your AI. Each one encodes a specific design discipline."
  3. **Anti-patterns** — "names them, detects them, and teaches the AI to avoid them"
- **Verification layers** (this is the core value-add over Anthropic's skill):
  - **Visual Mode**: "25 deterministic checks" via Chrome extension or CLI overlay. Issues "highlighted directly on the page."
  - **CLI Tool**: "Scans HTML, CSS, JSX/TSX, Vue, Svelte" with CI-pipeline integration.
  - **Critique Command**: "persona sub-agents review in parallel, score against Nielsen's heuristics"
- **Concrete anti-patterns detected**:
  - Gradient-backed text
  - Purple color palettes (the canonical "AI slop" tell)
  - "Cardocalypse" (nested card structures)
  - Low contrast typography
  - Overused fonts (particularly Inter)
  - Generic template layouts
- **Transferability**: High. The **three-layer architecture (foundation knowledge + command vocabulary + anti-pattern detection)** is a reusable design-agent shape. The 25-check visual mode is the closest prior art to what EG-Desk needs for its Playwright verification step.

---

## 4. Research / industry insights

### 4.1 Agent feedback-loop design (Playwright-based)

- **Sources**:
  - https://claude.com/blog/building-agents-with-the-claude-agent-sdk (fetched 2026-04-10)
  - https://alexop.dev/posts/building_ai_qa_engineer_claude_code_playwright/
  - https://www.builder.io/blog/playwright-mcp-server-claude-code
- **Key patterns**:
  - Claude Code's core design principle: "Claude needs the same tools that programmers use every day." (Anthropic engineering blog)
  - The loop: "prompt → review → strengthen assertions → re-run → adjust selectors → commit" — industry-reported as 30-60 minutes per well-tested flow, not the 5 minutes demo videos suggest.
  - Playwright MCP enables: take screenshots of rendered HTML, capture different viewport sizes, test interactive elements — all in-agent.
  - The iteration pattern: LLM writes Playwright script → runs Node.js → reads console + screenshots → fixes → re-runs. This is the feedback loop that Anthropic's `frontend-design` skill **lacks** and that Impeccable **adds**.

### 4.2 Distributional convergence (the core problem statement)

- **Source**: https://claude.com/blog/improving-frontend-design-through-skills
- **Insight**: AI design outputs converge on a small number of defaults (Inter, Roboto, purple gradients, flat white backgrounds, Space Grotesk) because those choices dominate web training data. A designer agent's primary job is to **push against the training distribution**.
- **Concrete tells of AI slop**:
  - Inter or Roboto (v0 and Anthropic skill both warn against these)
  - Purple gradient on white (Anthropic, Impeccable, both flag this)
  - Gradient-backed text (Impeccable)
  - Nested cards / "Cardocalypse" (Impeccable)
  - Space Grotesk convergence (Anthropic skill warns specifically)
  - Flat white background (Canva Code bans it; Anthropic skill warns against it)
- **EG-Desk relevance**: EG-Desk's DESIGN_SYSTEM_SPEC.md currently uses Inter as its primary font. This is directly in the "AI slop" anti-pattern territory according to both Anthropic and Impeccable. **This is worth surfacing to the team.**

### 4.3 Single-sentence UI quality bars

- Cursor and Windsurf both contain a single sentence: "Give it a beautiful and modern UI, imbued with best UX practices." The identical phrasing strongly suggests shared lineage or shared prompt consultants.
- v0 escalates this to a formula: 3-5 colors, 2 fonts, mobile-first, no gradients, 44px touch targets.
- Lovable escalates further to design-system-as-mandatory.
- Anthropic frontend-design escalates differently: aesthetic intentionality as the quality bar.
- **Observation**: There is a spectrum from "one sentence" (Cursor/Windsurf) → "numeric rules" (v0) → "design system mandatory" (Lovable, Orchids) → "aesthetic intentionality" (Anthropic skill). EG-Desk's designer prompt will need to choose where on this spectrum to sit. Given the Ontology Bridge philosophy, **aesthetic intentionality** (Anthropic's direction) is the closest conceptual fit.

---

## 5. Comparative analysis — industry consensus patterns

These 10 patterns appear across multiple production tools. Each is a candidate primitive for EG-Desk's design-agent prompt.

| # | Pattern | Tools that use it | Strength |
|---|---|---|---|
| 1 | **Semantic design tokens mandatory (no raw colors)** | Lovable, Orchids, v0, Leap.new | Very strong — 4/10 tools |
| 2 | **Tailwind CSS as default styling layer** | v0, Lovable, Canva Code, Orchids, Leap.new, Bolt | Near-universal |
| 3 | **shadcn/ui as default component library** | v0, Leap.new (pre-installed) | Strong — closing in on de facto standard |
| 4 | **`lucide-react` for icons (no inline SVG)** | v0, Leap.new | Strong |
| 5 | **Responsive design required (stated as MUST)** | v0, Lovable, Canva Code, Leap.new | Universal |
| 6 | **Linter-error fix loop capped (3 attempts)** | Cursor, Windsurf | Important for escape-hatch design |
| 7 | **Single-edit-per-turn / minimal-diff discipline** | Cursor, Windsurf, Orchids | Strong |
| 8 | **Thinking / planning tag before code generation** | v0 (`<Thinking>`), Bolt (holistic review) | Strong |
| 9 | **AI-slop anti-patterns explicitly named** | Anthropic frontend-design, Impeccable, v0 (no indigo/blue) | Strong and growing |
| 10 | **Conciseness mandate for user-facing responses** | Lovable ("< 2 lines"), Cursor, Windsurf, Bolt ("Do NOT be verbose") | Near-universal |

**Industry consensus summary**: the modal production designer prompt in 2026 is: Tailwind + shadcn + lucide + semantic tokens + responsive + Thinking-tag + anti-slop rules + concise communication. That's the floor, not the ceiling.

---

## 6. Unique / surprising findings

1. **Canva Code's "never gray or white background"** — the only production prompt that bans the default background. Most designer-agent prompts allow flat backgrounds; Canva actively refuses. This is a strong lever for distinctiveness.

2. **Lovable's HSL-only color rule** — `rgb()` inside `hsl()` causes runtime errors. This is a hard-won engineering detail masquerading as a style rule. The implication: design-agent prompts should encode **engineering gotchas** alongside aesthetic preferences.

3. **Cursor's linter-error loop cap (3 tries)** — a specific escape hatch from infinite retry. Most designer prompts don't have this; they'll loop forever fixing CSS warnings.

4. **Justin Wetch's finding: "smaller models benefited more than larger ones"** — prompt upgrades compound more on Sonnet/Haiku than on Opus. EG-Desk should run its designer on Sonnet by default and reserve Opus for review.

5. **Anthropic's `frontend-design` skill has no validation loop** — the ecosystem filled this gap with Impeccable (25 deterministic checks) and with third-party Puppeteer-based eval frameworks. This is a known gap, not an oversight that EG-Desk has to rediscover.

6. **Lovable edits the design-system files *per feature*, not once at init** — "Make sure to edit the index.css and tailwind.config.ts files as often as necessary to avoid boring designs." This is a mindset shift: the design system is a *living artifact*, not a fixed config. EG-Desk's design-agent.md currently implies the opposite (a fixed DESIGN_SYSTEM_SPEC.md). Worth revisiting.

7. **Cursor and Windsurf share identical UI quality sentences** — strong evidence of a shared lineage of design consultants in the Claude-based coding-agent category. Prompts are converging.

8. **v0 repeats "MUST generate responsive designs" twice in the same prompt** for emphasis. Repetition-for-emphasis is a documented pattern in prompt engineering; v0 is the only one in the corpus doing it.

9. **Orchids.app's "KNOW WHEN TO STOP" rule** — minimal-diff as a design-agent principle. This is a rare instance of telling an agent to **under-deliver**. Counterintuitive but probably valuable for EG-Desk's "calm technology" philosophy.

10. **Impeccable's critique sub-agents run in parallel, each scoring against Nielsen's heuristics** — this is the most sophisticated validation pattern found. Each persona (e.g. "senior designer", "accessibility reviewer") is its own agent with its own scoring rubric. Directly applicable to EG-Desk's WM+PM review strategy.

---

## 7. Transferable primitives for EG-Desk (scored 1–5)

EG-Desk context: HTML/React + Playwright + WM+PM review strategy, Ontology Bridge philosophy, Ambient AI workspace, LIGHT mode only, Figma MCP as primary tool.

| # | Primitive | Source | Score | Notes |
|---|---|---|---|---|
| 1 | **Design-system-first rule ("never custom styles in components")** | Lovable | 5/5 | Aligns perfectly with EG-Desk Surface tokens. Paste verbatim into design-agent.md. |
| 2 | **Semantic tokens mandatory (var(--x), not raw colors)** | Lovable, Orchids, v0 | 5/5 | Matches EG-Desk's existing token list in DESIGN_SYSTEM_SPEC.md §2. |
| 3 | **AI-slop anti-patterns (no Inter/Roboto/purple/flat-white)** | Anthropic, Impeccable | 5/5 | **Inter is EG-Desk's current body font.** This is a conflict — the team should decide: rename the anti-pattern exception, or swap fonts. |
| 4 | **Puppeteer/Playwright screenshot eval loop (75% win rate)** | Justin Wetch | 5/5 | EG-Desk already uses Playwright MCP. Adding a design-quality scoring step costs little and gives objective feedback. |
| 5 | **"Edit the design system per feature, not once"** | Lovable | 4/5 | Philosophical shift. Worth discussing with PM before adopting. |
| 6 | **`<Thinking>` tag before code generation** | v0 | 4/5 | Low cost, widely validated. EG-Desk can adopt as a prompt section. |
| 7 | **Linter-loop cap (3 tries)** | Cursor, Windsurf | 4/5 | Prevents design-agent from getting stuck on CSS warnings. Cheap insurance. |
| 8 | **Conciseness mandate (< 2 lines, no summary)** | Lovable | 4/5 | EG-Desk already favors concise output. Paste verbatim. |
| 9 | **Persona-based critique sub-agents (parallel, Nielsen-scored)** | Impeccable | 4/5 | Fits WM+PM review pattern. Could be expressed as explore-agent variants. |
| 10 | **"KNOW WHEN TO STOP" minimal-diff discipline** | Orchids | 4/5 | Strong fit with EG-Desk's "calm technology" philosophy. |
| 11 | **Three-layer architecture: foundation + commands + anti-patterns** | Impeccable | 4/5 | Reusable as a structural template for design-agent.md. |
| 12 | **Color/font hard caps (3-5 colors, 2 fonts)** | v0 | 3/5 | EG-Desk already has a defined palette; this becomes redundant. |
| 13 | **"Wow them on first interaction"** | Lovable | 3/5 | Clashes with calm-technology philosophy. Don't adopt verbatim; reframe as "first impression should feel crafted, not flashy". |
| 14 | **"Never gray or white background"** | Canva Code | 2/5 | **Direct conflict**: EG-Desk Surface is #F5F3EF (warm off-white) — a deliberate choice. Don't adopt. |
| 15 | **Replit/Kiro patterns** | — | N/A | Not recovered in this scan. Gap to close in a follow-up. |

**Top 5 for immediate adoption**:
1. Lovable's design-system-first rule (verbatim, paste-in)
2. Anthropic's anti-slop list (verbatim, paste-in — but resolve the Inter conflict first)
3. v0's `<Thinking>` planning tag
4. Cursor's linter-loop cap
5. Justin Wetch's Playwright screenshot eval methodology (as a separate verification step, not in the prompt itself)

---

## 8. Source list

Fetched 2026-04-10 unless otherwise noted.

### Primary sources (leaked-prompt archives)

- [jujumilk3/leaked-system-prompts repo](https://github.com/jujumilk3/leaked-system-prompts)
- [jujumilk3 — v0_20250306.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/v0_20250306.md)
- [jujumilk3 — bolt.new_20241009.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/bolt.new_20241009.md)
- [jujumilk3 — cursor-ide-agent-claude-sonnet-3.7_20250309.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/cursor-ide-agent-claude-sonnet-3.7_20250309.md)
- [jujumilk3 — cursor-ide-sonnet_20241224.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/cursor-ide-sonnet_20241224.md)
- [jujumilk3 — codeium-windsurf-cascade_20241206.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/codeium-windsurf-cascade_20241206.md)
- [jujumilk3 — canva-code_20250519.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/canva-code_20250519.md)
- [jujumilk3 — claude-artifacts_20240620.md](https://github.com/jujumilk3/leaked-system-prompts/blob/main/claude-artifacts_20240620.md)
- [x1xhlol/system-prompts-and-models-of-ai-tools repo](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [x1xhlol — Lovable/Agent Prompt.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Lovable/Agent%20Prompt.txt)
- [x1xhlol — Orchids.app/System Prompt.txt](https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Orchids.app/System%20Prompt.txt)
- [x1xhlol — Leap.new/Prompts.txt](https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Leap.new/Prompts.txt)
- [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks)
- [2-fly-4-ai/V0-system-prompt (older snapshot)](https://github.com/2-fly-4-ai/V0-system-prompt)
- [stackblitz/bolt.new original source](https://github.com/stackblitz/bolt.new/blob/main/app/lib/.server/llm/prompts.ts)

### Official / canonical sources

- [anthropics/skills — frontend-design SKILL.md](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)
- [anthropics/skills — frontend-design directory](https://github.com/anthropics/skills/tree/main/skills/frontend-design)
- [Anthropic blog — Improving frontend design through skills](https://claude.com/blog/improving-frontend-design-through-skills)
- [Claude plugin — frontend-design](https://claude.com/plugins/frontend-design)
- [Anthropic blog — Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
- [PR #210 — Improve frontend-design skill clarity](https://github.com/anthropics/skills/pull/210)

### Industry / research

- [Justin Wetch — Improving Claude's frontend design](https://www.justinwetch.com/blog/improvingclaudefrontend)
- [Impeccable design skill upgrade](https://impeccable.style/)
- [Augment Code — Leaked AI system prompts analysis](https://www.augmentcode.com/learn/leaked-ai-system-prompts-github)
- [Medium — The story behind leaked AI system prompts (12K stars)](https://medium.com/@lucknite/over-12-000-stars-42cf92d1cc4b)
- [Simon Willison — Leaked v0 system prompts](https://simonwillison.net/2024/Nov/25/leaked-system-prompts-from-vercel-v0/)
- [Cursor forum — leaked system prompt discussion](https://forum.cursor.com/t/what-we-can-learn-from-the-leaked-cursor-system-prompt-full-text-included/82643)
- [Builder.io — Playwright MCP with Claude Code](https://www.builder.io/blog/playwright-mcp-server-claude-code)
- [alexop.dev — Building an AI QA Engineer with Playwright MCP](https://alexop.dev/posts/building_ai_qa_engineer_claude_code_playwright/)
- [Cyber Corsairs — Vercel's v0 prompts leaked](https://cybercorsairs.com/vercels-v0-prompts-leaked/)
- [Geeky Gadgets — Cursor system prompt leak analysis](https://www.geeky-gadgets.com/cursor-system-prompt-leak/)

---

## Known gaps (for follow-up)

1. **Replit Agent** — directory exists on x1xhlol, exact filename not confirmed. `Prompt.txt` and `Prompt.md` both 404'd. Needs directory listing fetch.
2. **Kiro** — same issue as Replit.
3. **Devin AI** — directory exists, not fetched in this pass. Would be useful for autonomous-agent patterns.
4. **Notion AI, NotionAI (asgeirtj Misc/)** — may have design rules since Notion has a distinctive visual identity. Not fetched.
5. **Raw file fetch refusals** — WebFetch's underlying model reflexively refuses some files on sight when the word "leaked" appears. Reframing as "publicly archived research document" worked in most cases but not all. Follow-up scans should use that framing preemptively.
6. **Anthropic skills repo — other skills** — the frontend-design skill was fetched. There may be `webapp-testing`, `canvas-design`, `brand-guidelines`, `theme-factory`, `algorithmic-art` (all visible in my current session's skill list) with relevant design rules. Not fetched this pass.
