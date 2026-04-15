# Explorer-4: gstack + bkit Gold Tier — Designer Prompt Patterns

**Agent**: explore-agent-4 (special-ops)
**Date**: 2026-04-10
**Scope**: `references/gstack/` (design-consultation, design-review, AGENTS.md, ETHOS.md, SKILL.md) + `references/bkit-claude-code/` (skills, output-styles, skill-creator, templates, AI-NATIVE-DEVELOPMENT.md, CUSTOMIZATION-GUIDE.md)
**Mission**: Recover designer-focused gold that WM scope filter missed. Deep read (not skim) on gstack design-consultation/review.
**Evidence tag**: [조사]

---

## Executive Summary

gstack's `design-consultation` and `design-review` are the highest-value designer agent prompts found across all references so far. They are **generated from `.tmpl` files** via `bun run gen:skill-docs` — the `.tmpl` is the authoritative source, the `SKILL.md` is the expanded-preamble output. Both files use a **designer + frontend engineer** persona, are opinionated about AI slop, and ship with concrete tool contracts (the `$B` browse binary for headless screenshots/snapshots).

The most transferable primitive is gstack's **dual scoring system** (Design Score + separate AI Slop Score A-F), backed by a 10-category, ~80-item checklist with category-specific weights. This is a complete, ready-to-adapt rubric for EG-Desk's design-agent output contract.

bkit's scope in this mission (`skills/`, `output-styles/`, `skill-creator/`, `templates/`) is largely **PDCA-pipeline oriented** — useful for skill-template meta-patterns and `design-agent` factory scaffolding, but the *content* of bkit's design guidance is framework-catalog level (shadcn tokens, Flutter themes), not the prompt-craft-level gold that gstack provides.

---

## 1. gstack `design-consultation` deep-dive

**Source of truth**: `references/gstack/design-consultation/SKILL.md.tmpl` (19,081 bytes, 371 lines). The generated `SKILL.md` (38,883 bytes) is tmpl + preamble expansion.

### 1.1 Frontmatter & Persona

`references/gstack/design-consultation/SKILL.md.tmpl:1-21`:
```yaml
---
name: design-consultation
version: 1.0.0
description: |
  Design consultation: understands your product, researches the landscape, proposes a
  complete design system (aesthetic, typography, color, layout, spacing, motion), and
  generates font+color preview pages. Creates DESIGN.md as your project's design source
  of truth. For existing sites, use /plan-design-review to infer the system instead.
  Use when asked to "design system", "brand guidelines", or "create DESIGN.md".
  Proactively suggest when starting a new project's UI with no existing
  design system or DESIGN.md.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - WebSearch
---
```

**Persona declaration** (`SKILL.md.tmpl:27-29`):
> "You are a senior product designer with strong opinions about typography, color, and visual systems. You don't present menus — you listen, think, research, and propose. You're opinionated but not dogmatic. You explain your reasoning and welcome pushback."
>
> "**Your posture:** Design consultant, not form wizard. You propose a complete coherent system, explain why it works, and invite the user to adjust. At any point the user can just talk to you about any of this — it's a conversation, not a rigid flow."

Key role framing verbatim: "opinionated but not dogmatic", "design consultant, not form wizard", "propose a complete coherent system".

### 1.2 Workflow (6 phases)

`SKILL.md.tmpl:33-360`:

| Phase | Purpose | Key mechanism |
|-------|---------|---------------|
| **Phase 0: Pre-checks** | Gather product context, detect existing DESIGN.md, find browse binary | `ls DESIGN.md design-system.md`, `cat README.md`, `ls ~/.gstack/projects/$SLUG/*office-hours*` (L35-62) |
| **Phase 1: Product Context** | ONE AskUserQuestion covering product + space + research opt-in + conversational framing | "Pre-fill what you can infer from the codebase" (L73-83) |
| **Phase 2: Research (conditional)** | WebSearch → visual browse → three-layer synthesis → Eureka check | Three-layer framework: tried-and-true / new-and-popular / first-principles (L84-134) |
| **Phase 3: The Complete Proposal** | Full system proposed as one coherent package with SAFE/RISK breakdown | AESTHETIC / DECORATION / LAYOUT / COLOR / TYPOGRAPHY / SPACING / MOTION — all 7 at once (L136-222) |
| **Phase 4: Drill-downs (conditional)** | Go deep on one section when user requests adjustments | 3-5 concrete candidates with rationale (L224-234) |
| **Phase 5: Font & Color Preview Page** | Generate self-contained HTML preview page, open in browser | Product mockups with realistic content, light/dark toggle (L238-282) |
| **Phase 6: Write DESIGN.md & Confirm** | Write DESIGN.md + update CLAUDE.md + final confirmation | Full DESIGN.md schema provided verbatim (L286-358) |

### 1.3 Input/Output contract

**Input**: user request ("design system", "brand guidelines", "create DESIGN.md"); optional codebase context (README, package.json, office-hours output at `~/.gstack/projects/$SLUG/*office-hours*`).

**Output artifacts**:
1. HTML preview page at `/tmp/design-consultation-preview-$(date +%s).html` (self-contained, no framework deps) — `SKILL.md.tmpl:242-250`
2. `DESIGN.md` at repo root with strict structure (L289-341)
3. `CLAUDE.md` appended with Design System section (L345-351)

**DESIGN.md schema** (gold — directly adaptable) — `SKILL.md.tmpl:289-341`:
```markdown
# Design System — [Project Name]

## Product Context
- **What this is:** [1-2 sentence description]
- **Who it's for:** [target users]
- **Space/industry:** [category, peers]
- **Project type:** [web app / dashboard / marketing site / editorial / internal tool]

## Aesthetic Direction
- **Direction:** [name]
- **Decoration level:** [minimal / intentional / expressive]
- **Mood:** [1-2 sentence description of how the product should feel]
- **Reference sites:** [URLs, if research was done]

## Typography
- **Display/Hero:** [font name] — [rationale]
- **Body:** [font name] — [rationale]
- **UI/Labels:** [font name or "same as body"]
- **Data/Tables:** [font name] — [rationale, must support tabular-nums]
- **Code:** [font name]
- **Loading:** [CDN URL or self-hosted strategy]
- **Scale:** [modular scale with specific px/rem values for each level]

## Color
- **Approach:** [restrained / balanced / expressive]
- **Primary:** [hex] — [what it represents, usage]
- **Secondary:** [hex] — [usage]
- **Neutrals:** [warm/cool grays, hex range from lightest to darkest]
- **Semantic:** success [hex], warning [hex], error [hex], info [hex]
- **Dark mode:** [strategy — redesign surfaces, reduce saturation 10-20%]

## Spacing
- **Base unit:** [4px or 8px]
- **Density:** [compact / comfortable / spacious]
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** [grid-disciplined / creative-editorial / hybrid]
- **Grid:** [columns per breakpoint]
- **Max content width:** [value]
- **Border radius:** [hierarchical scale — e.g., sm:4px, md:8px, lg:12px, full:9999px]

## Motion
- **Approach:** [minimal-functional / intentional / expressive]
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms)

## Decisions Log
| Date | Decision | Rationale |
```

### 1.4 The SAFE/RISK breakdown (Phase 3)

This is a **distinctive prompt-craft pattern**. From `SKILL.md.tmpl:140-167`:

> "Based on [product context] and [research findings / my design knowledge]:
>
> AESTHETIC: [direction] — [one-line rationale]
> DECORATION: [level] — [why this pairs with the aesthetic]
> LAYOUT: [approach] — [why this fits the product type]
> COLOR: [approach] + proposed palette (hex values) — [rationale]
> TYPOGRAPHY: [3 font recommendations with roles] — [why these fonts]
> SPACING: [base unit + density] — [rationale]
> MOTION: [approach] — [rationale]
>
> This system is coherent because [explain how choices reinforce each other].
>
> **SAFE CHOICES** (category baseline — your users expect these):
>   - [2-3 decisions that match category conventions, with rationale for playing safe]
>
> **RISKS** (where your product gets its own face):
>   - [2-3 deliberate departures from convention]
>   - For each risk: what it is, why it works, what you gain, what it costs"

Rationale given in tmpl (L167): *"Design coherence is table stakes — every product in a category can be coherent and still look identical. The real question is: where do you take creative risks?"*

### 1.5 Font blacklists (verbatim from `SKILL.md.tmpl:199-203`)

**Blacklist (never recommend)**:
> "Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Raleway, Clash Display, Courier New (for body)"

**Overused (never as primary — only if user specifically requests)**:
> "Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins"

> **Note for EG-Desk**: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md:45-51` currently specifies `Inter` as the primary typography — this is on gstack's overused list. Not necessarily wrong, but the `design-agent` should be aware of the tension and note it if asked.

### 1.6 AI slop anti-patterns (verbatim from `SKILL.md.tmpl:205-212`)

> "**AI slop anti-patterns** (never include in your recommendations):
> - Purple/violet gradients as default accent
> - 3-column feature grid with icons in colored circles
> - Centered everything with uniform spacing
> - Uniform bubbly border-radius on all elements
> - Gradient buttons as the primary CTA pattern
> - Generic stock-photo-style hero sections
> - "Built for X" / "Designed for Y" marketing copy patterns"

### 1.7 Coherence validation (a distinctive pattern)

`SKILL.md.tmpl:216-221`. When the user overrides one section, the agent checks whether the rest still coheres and **flags mismatches with a gentle nudge — never blocks**:

> "- Brutalist/Minimal aesthetic + expressive motion → "Heads up: brutalist aesthetics usually pair with minimal motion. Your combo is unusual — which is fine if intentional. Want me to suggest motion that fits, or keep it?"
> - Expressive color + restrained decoration → "Bold palette with minimal decoration can work, but the colors will carry a lot of weight. Want me to suggest decoration that supports the palette?"
> - Always accept the user's final choice. Never refuse to proceed."

### 1.8 Important Rules (verbatim from `SKILL.md.tmpl:361-371`)

> 1. **Propose, don't present menus.** You are a consultant, not a form.
> 2. **Every recommendation needs a rationale.** Never say "I recommend X" without "because Y."
> 3. **Coherence over individual choices.** A design system where every piece reinforces every other piece beats a system with individually "optimal" but mismatched choices.
> 4. **Never recommend blacklisted or overused fonts as primary.**
> 5. **The preview page must be beautiful.** It's the first visual output and sets the tone for the whole skill.
> 6. **Conversational tone.** This isn't a rigid workflow.
> 7. **Accept the user's final choice.** Nudge on coherence issues, but never block.
> 8. **No AI slop in your own output.** Your recommendations, your preview page, your DESIGN.md — all should demonstrate the taste you're asking the user to adopt.

---

## 2. gstack `design-review` deep-dive

**Source of truth**: `references/gstack/design-review/SKILL.md.tmpl` (9,244 bytes, 267 lines). Generated `SKILL.md` is 56,821 bytes — most of the expansion is the inlined `DESIGN_METHODOLOGY` and `DESIGN_HARD_RULES` blocks which live in shared includes (the `{{PREAMBLE}}`, `{{BROWSE_SETUP}}`, `{{TEST_BOOTSTRAP}}`, `{{DESIGN_METHODOLOGY}}`, `{{DESIGN_HARD_RULES}}`, `{{DESIGN_OUTSIDE_VOICES}}`, `{{SLUG_SETUP}}` placeholders on L23, 68, 72, 85, 87, 112, 228).

### 2.1 Frontmatter & Persona

`references/gstack/design-review/SKILL.md.tmpl:1-21`:
```yaml
---
name: design-review
version: 2.0.0
description: |
  Designer's eye QA: finds visual inconsistency, spacing issues, hierarchy problems,
  AI slop patterns, and slow interactions — then fixes them. Iteratively fixes issues
  in source code, committing each fix atomically and re-verifying with before/after
  screenshots. For plan-mode design review (before implementation), use /plan-design-review.
  Use when asked to "audit the design", "visual QA", "check if it looks good", or "design polish".
  Proactively suggest when the user mentions visual inconsistencies or
  wants to polish the look of a live site.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - WebSearch
---
```

**Persona** (`SKILL.md.tmpl:27`):
> "You are a senior product designer AND a frontend engineer. Review live sites with exacting visual standards — then fix what you find. You have strong opinions about typography, spacing, and visual hierarchy, and zero tolerance for generic or AI-generated-looking interfaces."

Dual-role framing is deliberate: **designer + frontend engineer**, so the agent can go from finding → fixing in source without role-handoff.

### 2.2 Workflow (11 phases)

From `SKILL.md.tmpl:30-255`:

| Phase | Purpose | Evidence artifact |
|-------|---------|-------------------|
| **Setup** | Parse URL + scope + depth + auth; detect DESIGN.md; require clean working tree; find browse binary; bootstrap test framework | `git status --porcelain` check; AskUserQuestion with commit/stash/abort (L54-64) |
| **Phase 1: First Impression** | Gut-reaction critique in structured format | Full-page screenshot at `$REPORT_DIR/screenshots/first-impression.png` |
| **Phase 2: Design System Extraction** | Extract the *actual* rendered design (fonts, colors, heading hierarchy, touch targets, perf baseline) | Inferred Design System report + offer to save as DESIGN.md |
| **Phase 3: Page-by-Page Visual Audit** | Per-page annotated + responsive screenshots + 10-category checklist (~80 items) | `{page}-annotated.png`, `{page}-mobile.png`, `{page}-tablet.png`, `{page}-desktop.png` |
| **Phase 4: Interaction Flow Review** | Walk 2-3 user flows, evaluate feel (not just function) | Snapshot diffs before/after each click |
| **Phase 5: Cross-Page Consistency** | Compare nav/footer/components across pages | Consistency findings |
| **Phase 6: Compile Report** | Dual headline scoring (Design Score + AI Slop Score A-F) + per-category grades + weighted composite | `design-audit-{domain}-{YYYY-MM-DD}.md`, `design-baseline.json` |
| **Phase 7: Triage** | Sort findings by impact (high/medium/polish) | Ordered fix queue |
| **Phase 8: Fix Loop** | 8a locate → 8b minimal fix → 8c atomic commit → 8d re-test → 8e classify → 8e.5 regression test → 8f self-regulate | One `style(design): FINDING-NNN — description` commit per fix; before/after PNG pair per fix |
| **Phase 9: Final Design Audit** | Re-run audit, compute delta, WARN if regressed | Final scores vs baseline |
| **Phase 10: Report** | Dual-location write (local + project-scoped) with PR-ready summary line | `.gstack/design-reports/…` + `~/.gstack/projects/{slug}/…` |
| **Phase 11: TODOS.md Update** | Move deferred findings to TODOS, annotate fixed ones | TODOS.md updates |

### 2.3 The Design Audit Checklist — 10 categories, ~80 items (gold)

From `SKILL.md:620-736` (generated, originates in `DESIGN_METHODOLOGY` include). This is **the most directly transferable content** in the entire gstack corpus. Categories with weights (L809-820):

| # | Category | Items | Design Score weight |
|---|----------|-------|--------------------:|
| 1 | Visual Hierarchy & Composition | 8 | 15% |
| 2 | Typography | 15 | 15% |
| 3 | Color & Contrast | 10 | 10% |
| 4 | Spacing & Layout | 12 | 15% |
| 5 | Interaction States | 10 | 10% |
| 6 | Responsive Design | 8 | 10% |
| 7 | Motion & Animation | 6 | 5% |
| 8 | Content & Microcopy | 8 | 10% |
| 9 | AI Slop Detection | 10 | 5% (+ headline grade) |
| 10 | Performance as Design | 6 | 5% |

Each finding gets `impact` (high/medium/polish) and `category`. Grade computation rule (`SKILL.md:806`):
> "Each category starts at A. Each High-impact finding drops one letter grade. Each Medium-impact finding drops half a letter grade. Polish findings are noted but do not affect grade. Minimum is F."

### 2.4 Typography checklist — 15 concrete items (verbatim `SKILL.md:634-648`)

```
- Font count <=3 (flag if more)
- Scale follows ratio (1.25 major third or 1.333 perfect fourth)
- Line-height: 1.5x body, 1.15-1.25x headings
- Measure: 45-75 chars per line (66 ideal)
- Heading hierarchy: no skipped levels (h1→h3 without h2)
- Weight contrast: >=2 weights used for hierarchy
- No blacklisted fonts (Papyrus, Comic Sans, Lobster, Impact, Jokerman)
- If primary font is Inter/Roboto/Open Sans/Poppins → flag as potentially generic
- `text-wrap: balance` or `text-pretty` on headings
- Curly quotes used, not straight quotes
- Ellipsis character (…) not three dots (...)
- `font-variant-numeric: tabular-nums` on number columns
- Body text >= 16px
- Caption/label >= 12px
- No letterspacing on lowercase text
```

### 2.5 AI Slop blacklist — the 10 patterns (verbatim `SKILL.md:914-924`)

```
1. Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes
2. The 3-column feature grid: icon-in-colored-circle + bold title + 2-line description,
   repeated 3x symmetrically. THE most recognizable AI layout.
3. Icons in colored circles as section decoration (SaaS starter template look)
4. Centered everything (`text-align: center` on all headings, descriptions, cards)
5. Uniform bubbly border-radius on every element (same large radius on everything)
6. Decorative blobs, floating circles, wavy SVG dividers
7. Emoji as design elements (rockets in headings, emoji as bullet points)
8. Colored left-border on cards (`border-left: 3px solid <accent>`)
9. Generic hero copy ("Welcome to [X]", "Unlock the power of...")
10. Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA)
```

Source note from `SKILL.md:926`: *"OpenAI 'Designing Delightful Frontends with GPT-5.4' (Mar 2026) + gstack design methodology."*

### 2.6 Hard Rules — classifier pattern (`SKILL.md:861-913`)

The rules are **gated by a classifier** that runs before evaluation:
- **MARKETING/LANDING PAGE** → Landing Page Rules
- **APP UI** (dashboards, admin, settings) → App UI Rules
- **HYBRID** → both (landing rules on marketing shell, app rules on functional sections)

**Hard rejection criteria** (instant-fail, 7 items — `SKILL.md:866-874`):
```
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of layout
```

**Litmus checks (YES/NO, 7 items — `SKILL.md:876-884`)** used for cross-model consensus scoring:
```
1. Brand/product unmistakable in first screen?
2. One strong visual anchor present?
3. Page understandable by scanning headlines only?
4. Each section has one job?
5. Are cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would design feel premium with all decorative shadows removed?
```

**App UI rules** — particularly relevant for EG-Desk (ambient workspace) — verbatim `SKILL.md:898-905`:
```
- Calm surface hierarchy, strong typography, few colors
- Dense but readable, minimal chrome
- Organize: primary workspace, navigation, secondary context, one accent
- Avoid: dashboard-card mosaics, thick borders, decorative gradients, ornamental icons
- Copy: utility language — orientation, status, action. Not mood/brand/aspiration
- Cards only when card IS the interaction
- Section headings state what area is or what user can do
  ("Selected KPIs", "Plan status")
```

### 2.7 Fix Loop mechanics — distinctive engineering discipline

From `SKILL.md.tmpl:127-206` (`SKILL.md:1044-1123`). The fix loop is where design-review becomes unusual — it's not just audit, it's audit + minimal-fix + verify + self-regulate:

**8a. Locate source** — find file(s) responsible, NEVER touch unrelated files
**8b. Fix** — minimal change, CSS-first preferred
**8c. Commit** — atomic: `git commit -m "style(design): FINDING-NNN — short description"`
**8d. Re-test** — re-navigate, `$B screenshot "…/finding-NNN-after.png"`, check console, `$B snapshot -D` for diff
**8e. Classify** — verified / best-effort / reverted
**8e.5. Regression test** — only if JS behavior changed (CSS-only skips this)
**8f. Self-regulation** — compute design-fix risk every 5 fixes:

```
DESIGN-FIX RISK:
  Start at 0%
  Each revert:                        +15%
  Each CSS-only file change:          +0%   (safe — styling only)
  Each JSX/TSX/component file change: +5%   per file
  After fix 10:                       +1%   per additional fix
  Touching unrelated files:           +20%
```
> "If risk > 20%: STOP immediately. Show the user what you've done so far. Ask whether to continue."
> "Hard cap: 30 fixes. After 30 fixes, stop regardless of remaining findings."
(`SKILL.md:1111-1123`)

### 2.8 Design Critique Format — the "I notice / I wonder / What if / I think because" structure

`SKILL.md:833-841`:
> "- "I notice..." — observation
> - "I wonder..." — question
> - "What if..." — suggestion
> - "I think... because..." — reasoned opinion"

This is a **concrete, teachable format** — it forces structured feedback instead of "looks off".

### 2.9 Important Rules — designer-specific discipline (`SKILL.md:847-858`)

> 1. **Think like a designer, not a QA engineer.** You care whether things feel right, look intentional, and respect the user. You do NOT just care whether things "work."
> 2. **Screenshots are evidence.** Every finding needs at least one screenshot.
> 3. **Be specific and actionable.** "Change X to Y because Z" — not "the spacing feels off."
> 4. **Never read source code.** Evaluate the rendered site, not the implementation.
> 5. **AI Slop detection is your superpower.**
> 6. **Quick wins matter.** Always include a "Quick Wins" section — the 3-5 highest-impact fixes that take <30 minutes each.
> 7. **Use `snapshot -C` for tricky UIs.** Finds clickable divs that the accessibility tree misses.
> 8. **Responsive is design, not just 'not broken.'**
> 9. **Document incrementally.** Write each finding to the report as you find it. Don't batch.
> 10. **Depth over breadth.** 5-10 well-documented findings > 20 vague observations.
> 11. **Show screenshots to the user.** After every `$B screenshot`, use the Read tool on the output file(s).

### 2.10 Cross-model consensus — "Outside Voices" pattern

`SKILL.md:951-1030`. design-review automatically launches **two parallel second opinions** when Codex is available:
1. **Codex** via Bash (`codex exec` with design-specific prompt, `-s read-only -c 'model_reasoning_effort="high"'`)
2. **Claude subagent** via Agent tool (focused on consistency patterns across files)

Findings are merged with tags: `[codex]` / `[subagent]` / `[cross-model]` — cross-model findings carry higher confidence.

Error handling is **all non-blocking** — auth failure, timeout, empty response, or both-failed all degrade to primary review only. (`SKILL.md:1011-1017`)

---

## 3. gstack framework insights — ETHOS, AGENTS, SKILL

### 3.1 gstack as "collection of SKILL.md files = specialist roles"

`references/gstack/AGENTS.md:1-6`:
> "gstack is a collection of SKILL.md files that give AI agents structured roles for software development. Each skill is a specialist: CEO reviewer, eng manager, designer, QA lead, release engineer, debugger, and more."

Conceptual framing — **each skill IS an agent role**. The `/design-consultation` and `/design-review` skills are sibling roles to `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/qa`, `/review`, `/retro`, etc.

Skill catalog (`AGENTS.md:11-33`):

| Design-related skills | What they do |
|-----------------------|--------------|
| `/design-consultation` | Build a complete design system from scratch |
| `/plan-design-review` | Rate each design dimension 0-10, explain what a 10 looks like (plan mode) |
| `/design-review` | Design audit + fix loop with atomic commits (post-impl) |
| `/qa` | Open a real browser, find bugs, fix them, re-verify |
| `/qa-only` | Same as /qa but report only — no code changes |

Note the **plan-mode vs post-impl split** (`/plan-design-review` → before implementation vs `/design-review` → after). Both exist as separate skills. EG-Desk should consider the same split.

### 3.2 ETHOS — "Boil the Lake" + "Search Before Building"

`references/gstack/ETHOS.md:32-55`:
> "**1. Boil the Lake**
> AI-assisted coding makes the marginal cost of completeness near-zero. When the complete implementation costs minutes more than the shortcut — do the complete thing. Every time.
>
> **Lake vs. ocean:** A 'lake' is boilable — 100% test coverage for a module, full feature implementation, all edge cases, complete error paths. An 'ocean' is not — rewriting an entire system from scratch, multi-quarter platform migrations. Boil lakes. Flag oceans as out of scope."

`ETHOS.md:59-108`:
> "**2. Search Before Building**
> The 1000x engineer's first instinct is 'has someone already solved this?' not 'let me design it from scratch.'
>
> **Three Layers of Knowledge:**
> - **Layer 1: Tried and true.** Standard patterns. Cost of checking is near-zero.
> - **Layer 2: New and popular.** Current best practices, blog posts. Scrutinize — humans are subject to mania.
> - **Layer 3: First principles.** Original observations. **Prize these above everything else.**
>
> **The Eureka Moment:** The most valuable outcome of searching is not finding a solution to copy. It is:
> 1. Understanding what everyone is doing and WHY (Layers 1 + 2)
> 2. Applying first-principles reasoning to their assumptions (Layer 3)
> 3. Discovering a clear reason why the conventional approach is wrong"

These two principles are **auto-injected into every skill preamble** — they become the operating philosophy of every gstack skill. This is an infrastructural pattern: every skill's `{{PREAMBLE}}` contains these + Completeness Principle + AI effort compression table.

### 3.3 gstack top-level `SKILL.md` (the dispatcher)

`references/gstack/SKILL.md` is 29,474 bytes and serves as the gstack router — it describes how the `/gstack` command dispatches to sub-skills. Not directly useful for EG-Desk design-agent template, but confirms that the gstack pattern is: **one top-level skill + many specialist sub-skills**, each with their own `SKILL.md.tmpl`.

### 3.4 Skill preamble infrastructure (the meta-pattern)

Every `.tmpl` file starts with `{{PREAMBLE}}` (e.g. `design-review/SKILL.md.tmpl:23`), which expands at build time via `bun run gen:skill-docs` to include (from the generated `SKILL.md:25-297`):
- Session/branch detection
- Update check
- Contributor mode detection
- Proactive suggestions gate
- Repo ownership mode (solo/collaborative/unknown)
- AskUserQuestion format rules
- Completeness Principle / Boil the Lake
- Search Before Building / Eureka tracking
- Completion Status Protocol (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT)
- Escalation rules
- Telemetry logging
- Plan Status Footer

**Transfer opportunity**: EG-Desk could similarly define a **shared agent preamble** (e.g., `.claude/agents/_preamble.md`) that gets composed into each agent template, so rules like "Evidence Elevation" and "bypassPermissions vs acceptEdits" don't need repeating in every template. Currently EG-Desk has `CLAUDE.md` for this, which is loaded automatically — so the infrastructure already exists at a different layer.

### 3.5 Platform-agnostic config pattern (`gstack/CLAUDE.md:66-76`)

> "Skills must NEVER hardcode framework-specific commands, file patterns, or directory structures. Instead:
> 1. **Read CLAUDE.md** for project-specific config
> 2. **If missing, AskUserQuestion** — let the user tell you
> 3. **Persist the answer to CLAUDE.md** so we never have to ask again"

This is a **durable pattern** worth stealing for EG-Desk: agents read CLAUDE.md first, ask+persist once.

---

## 4. bkit skills (design-related) — pattern inventory

**Scope notice**: `references/bkit-claude-code/agents/` is explore-agent-1's territory. Only checked `skills/`, `output-styles/`, `skill-creator/`, `templates/`.

Of the 37 skills in `bkit-claude-code/skills/`, the following are design-adjacent:

| Skill | Purpose | Evaluated design-relevance |
|-------|---------|----------------------------|
| `phase-3-mockup` | HTML/CSS/JS prototypes → Next.js componentization | Medium — trend research catalogs (Dribbble, Behance, Awwwards), component separation discipline |
| `phase-5-design-system` | Platform-independent design systems | Medium — catalog of shadcn/Flutter/iOS/Android tools, design token JSON (Style Dictionary), CSS variable patterns |
| `phase-6-ui-integration` | UI implementation + API integration | Low — mostly API client patterns |
| `phase-8-review` | Overall codebase quality + gap analysis | Medium — PDCA-based Phase 8 review, uses `bkit:design-validator` agent for design-impl gap detection |

### 4.1 `phase-3-mockup` — trend research pattern

`references/bkit-claude-code/skills/phase-3-mockup/SKILL.md:98-156`:

**Trend research sources catalog**:
| Source | Purpose | URL |
|--------|---------|-----|
| Dribbble | UI design trends, color palettes | dribbble.com |
| Behance | Real project case studies | behance.net |
| Awwwards | Latest web trends from award winners | awwwards.com |
| Mobbin | Mobile app UI patterns | mobbin.com |
| Godly | Landing page references | godly.website |
| Land-book | Landing page gallery | land-book.com |

**Quick UI tools catalog** (L136-144):
| Tool | Purpose |
|------|---------|
| v0.dev | AI-based UI generation (shadcn/ui compatible) |
| Tailwind UI | High-quality component templates |
| Heroicons / Lucide | Icons |
| Coolors | Color palette generation |
| Realtime Colors | Real-time color preview |

**Component separation discipline** (L160-221) — the mockup should already be decomposed into Next.js-mappable components. `data-component="Header"`, `data-slot="title"` attributes, a `Component Mapping (mockup → Next.js)` table with Props columns. This is a **translation discipline** that bridges design phase to impl phase cleanly.

### 4.2 `phase-5-design-system` — design token patterns

`references/bkit-claude-code/skills/phase-5-design-system/SKILL.md`:

**3 layers of design system** (L69-80, gold diagram):
```
┌─────────────────────────────────────────────────────┐
│              Design Tokens                           │
│   Color, Typography, Spacing, Radius, Shadow, ...   │
├─────────────────────────────────────────────────────┤
│              Core Components                         │
│   Button, Input, Card, Dialog, Avatar, Badge, ...   │
├─────────────────────────────────────────────────────┤
│            Composite Components                      │
│   Form, DataTable, Navigation, SearchBar, ...       │
└─────────────────────────────────────────────────────┘
```

**Platform-specific implementation table** (L84-92):
| Platform | Recommended | Token method |
|----------|-------------|--------------|
| Web (React/Next.js) | shadcn/ui, Radix | CSS Variables |
| Web (Vue) | Vuetify, PrimeVue | CSS Variables |
| Flutter | Material 3, Custom Theme | ThemeData |
| iOS (SwiftUI) | Native Components | Asset Catalog, Color Set |
| Android (Compose) | Material 3 | MaterialTheme |
| React Native | NativeBase, Tamagui | StyleSheet + Theme |

**Style Dictionary JSON pattern** (L446-473) — for cross-platform token sharing. Moderately interesting for EG-Desk since it uses Electron + React/HTML; CSS Variables is the right choice per the table.

**Required component checklist** (L492-517): Design Tokens → Core Components → Composite Components → Documentation. A concrete Boolean completion checklist.

**Non-content observations**:
- `phase-5-design-system` is marked `classification: capability`, `classification-reason: "Pattern guidance may overlap with model's built-in knowledge as it improves"`, `deprecation-risk: medium`, and **`user-invocable: false`**. It runs as part of the PDCA pipeline, not standalone.
- It hooks into bkit's agent system: `agents: default: bkit:pipeline-guide`, `frontend: bkit:frontend-architect`.
- `next-skill: phase-6-ui-integration`, `pdca-phase: do` — explicit phase graph.

### 4.3 `phase-8-review` — design-impl gap detection

`references/bkit-claude-code/skills/phase-8-review/SKILL.md:28-34`:
```yaml
agents:
  default: bkit:code-analyzer
  validate: bkit:design-validator
  gap: bkit:gap-detector
  qa: bkit:qa-strategist
  team: bkit:cto-lead
```

The skill spawns a **dedicated `bkit:design-validator` agent** for verifying that design decisions from Phase 5 actually landed in Phase 6 implementation. This is a **design-implementation gap detection pattern** — different from gstack's design-review (which audits the rendered result), this one audits the source code against the spec.

**Takeaway for EG-Desk**: consider splitting design-agent into:
- **design-agent** (produces DESIGN.md + mockups — like gstack `/design-consultation`)
- **design-validator** (verifies impl matches spec — like bkit `phase-8-review.validate`)
- **design-reviewer** (audits live result — like gstack `/design-review`)

This is a **three-role split** that the current single `design-agent.md` does not implement.

---

## 5. bkit `output-styles` — visual output formatting patterns

`references/bkit-claude-code/output-styles/` contains 4 `.md` files:
- `bkit-enterprise.md`
- `bkit-learning.md`
- `bkit-pdca-enterprise.md`
- `bkit-pdca-guide.md`

### 5.1 Mechanism: `keep-coding-instructions: true`

From `bkit-pdca-guide.md:1-14`:
```yaml
---
name: bkit-pdca-guide
description: |
  PDCA workflow guide optimized style.
  Automatically displays checklists and progress for each phase.
  Best used with the bkit plugin for optimal results.

  Triggers: PDCA, workflow, checklist, progress, gap analysis, phase,
  워크플로우, 체크리스트, 진행, 단계, …
keep-coding-instructions: true
---
```

These are **Claude Code "output styles"** — they modify how Claude formats responses. They're not prompts per se, they're **persistent formatting rules** that get applied on top of whatever skill is running.

### 5.2 Response rules pattern (`bkit-pdca-guide.md:17-42`)

> "1. Include the current PDCA status badge at the beginning of every response:
>    [Plan] → [Design] → [Do] → [Check] → [Act] (highlight current phase)
> 2. Automatically assess and suggest Gap analysis when code changes are made.
> 3. Provide clear next-phase guidance upon completion of each phase
> 4. Automatically apply bkit templates when writing documents.
> 5. Include the bkit Feature Usage Report at the end of every response.
> 6. When multiple features are active, show batch processing guidance
> 7. After Check ≥ 90%, include /simplify suggestion before Report phase.
>
> ## Formatting
> - Use structured tables and checklists
> - Visualize PDCA progress
> - Phase color codes: Plan(blue), Design(purple), Do(green), Check(orange), Act(red)"

**Transfer opportunity**: EG-Desk could define an output-style that forces the design-agent to always lead with Evidence Elevation tags (`[의견]`, `[조사]`, `[검증]`, `[분석]`, `[보고]`) and a "current phase" indicator. Currently CLAUDE.md has the rules but agents don't always apply them uniformly.

---

## 6. bkit `skill-creator` / `templates` — meta-patterns for `/agent-factory`

### 6.1 Classification pattern — workflow vs capability

`references/bkit-claude-code/skill-creator/templates/capability-skill.yaml:1-19`:
```yaml
# Capability Skill Template
# Classification: capability (guidance that may become redundant)
# Deprecation Risk: medium (default)
name: "{name}"
classification: capability
classification-reason: "Development guidance that may become redundant as models improve"
deprecation-risk: medium
description: |
  {description}
argument-hint: "{argument-hint}"
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
imports: []
```

`references/bkit-claude-code/skill-creator/templates/workflow-skill.yaml:1-25`:
```yaml
# Workflow Skill Template
# Classification: workflow (process automation, model-independent)
# Deprecation Risk: none
name: "{name}"
classification: workflow
classification-reason: "Process automation independent of model capability evolution"
deprecation-risk: none
…
hooks:
  Stop:
    - type: command
      command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/{name}-stop.js"
      timeout: 10000
```

**The insight**: bkit distinguishes **workflow** (orchestrates steps, persists regardless of model advances) from **capability** (provides guidance, may become redundant as models improve). A design-agent that tells you "the primary should contrast 4.5:1 with the body" is capability (model will eventually know this); a design-agent that commits atomic fixes + runs regression tests is workflow (never redundant).

For EG-Desk `/agent-factory`, this taxonomy helps reason about which agent templates are long-lived infrastructure vs disposable guidance.

### 6.2 `skill-create` — interactive skill generation workflow

`references/bkit-claude-code/skills/skill-create/SKILL.md:27-122`:

**5-step workflow**:
1. Gather information (name, description, classification) via AskUserQuestion
2. Analyze project context — read CLAUDE.md, scan project structure, identify tech stack, find existing skills for overlap
3. Generate SKILL.md at `.claude/skills/project/{name}/SKILL.md`
4. Generate eval files (optional) at `evals/{name}/` with `eval.yaml`, `prompt.txt`, `expected.txt`
5. Confirm and report

**Eval template** (L101-115) — this is **directly applicable to EG-Desk**:
```yaml
name: "{name} skill eval"
skill: ".claude/skills/project/{name}/SKILL.md"
tests:
  - name: "basic trigger"
    prompt: "{trigger command}"
    expected:
      - "{expected behavior 1}"
      - "{expected behavior 2}"
  - name: "edge case"
    prompt: "{edge case prompt}"
    expected:
      - "{expected behavior}"
```

EG-Desk's `.claude/agents/` currently has no systematic eval harness. bkit's pattern suggests: each `/agent-factory` output ships with a test fixture.

### 6.3 Naming conventions (`skill-create/SKILL.md:132-138`)
| Pattern | Example | Use when |
|---------|---------|----------|
| `{project}-{domain}` | `hunikflow-model` | Domain-specific capability |
| `{action}-{target}` | `validate-entity` | Action-oriented workflow |
| `{tool}-{purpose}` | `proxy-guide` | Tool/pattern guide |

EG-Desk uses `kebab-case.md` (`agent-name.md`) per its CLAUDE.md — consistent direction, bkit's taxonomy just adds semantic categories.

---

## 7. Transferable primitives for EG-Desk (scored 1-5)

Relevance score: 1 = weak, 5 = directly pluggable into `design-agent.md` today.

| # | Primitive | Source | Score | Why it maps to EG-Desk |
|---|-----------|--------|------:|------------------------|
| 1 | **10-category design audit checklist with per-category weights** | gstack `design-review` (§2.3) | **5** | Direct adoption — the checklist already has App UI variants (`SKILL.md:898-905`) that match EG-Desk's spatial canvas + dashboard-like screens. Steal verbatim, drop the Landing Page rules since EG-Desk isn't marketing. |
| 2 | **AI Slop blacklist — 10 patterns** | gstack `design-review` (§2.5) | **5** | EG-Desk's `DESIGN_SYSTEM_SPEC.md:33-38` already forbids aurora/glassmorphism and `DESIGN_SYSTEM_SPEC.md:66-69` forbids tilt/3D. Adding gstack's 10 patterns gives a superset. Directly pasteable into design-agent rules. |
| 3 | **Dual scoring: Design Score + separate AI Slop Score (A-F)** | gstack `design-review` (§2.3) | **4** | Design-agent's output contract benefits from a measurable verdict. WM+PM review strategy in EG-Desk expects structured output — A-F + per-category grades gives reviewers a stable rubric. |
| 4 | **Classifier before evaluation (Landing vs App UI vs Hybrid)** | gstack `design-review` (§2.6) | **5** | EG-Desk IS an App UI by classification. Adopting the classifier pattern means design-agent always starts by stating which ruleset it's applying — self-documenting evaluation. |
| 5 | **SAFE/RISK breakdown in proposals** | gstack `design-consultation` (§1.4) | **5** | EG-Desk's ambient AI workspace positioning is explicitly non-conventional (`design-agent.md:10-19`). The SAFE/RISK framing forces the agent to name WHERE it's being risky (spatial canvas = risk) vs safe (WCAG contrast = safe) instead of hiding both under "design decisions". |
| 6 | **Fix-loop with atomic commits + before/after evidence** | gstack `design-review` (§2.2, §2.7) | **4** | EG-Desk's multi-agent setup has WM tracking file changes. One commit per fix + before/after PNG pair gives WM clean atomic units to log and gives sprint-leader clean units to report. |
| 7 | **Self-regulation risk heuristic (`DESIGN-FIX RISK`)** | gstack `design-review` (§2.7) | **4** | Prevents the design-agent from cascading into component refactors. Matches EG-Desk's "Don't add features, refactor code, or make improvements beyond what was asked" CLAUDE.md principle — turns that principle into a quantified stop signal. |
| 8 | **Plan-mode vs post-impl split (`/plan-design-review` vs `/design-review`)** | gstack `AGENTS.md` (§3.1) | **3** | EG-Desk could consider splitting `design-agent.md` into two templates: `design-planner-agent` (produces specs) and `design-reviewer-agent` (audits live result). Matches existing split of `egdesk-pm-agent` for strategy and workers for impl. |
| 9 | **Three-role split: consultant / validator / reviewer** | bkit `phase-5` + gstack `design-review` (§4.3) | **3** | Related to #8 but adds a **validator** role: source-code audit vs live audit. bkit's `bkit:design-validator` agent concept — useful when EG-Desk scales beyond one designer role. |
| 10 | **Coherence validation — nudge, never block** | gstack `design-consultation` (§1.7) | **4** | When user overrides one design token, agent flags downstream mismatches but accepts the override. Matches EG-Desk's "Accept the user's final choice" pattern but makes it operational. |
| 11 | **Cross-model consensus via parallel outside voices (Codex + subagent)** | gstack `design-review` (§2.10) | **3** | EG-Desk has Codex MCP wiring (per memory `codex-mcp-sandbox-rule.md`). Design-agent could spawn a parallel Codex read-only review for cross-model consensus on design decisions. Good match for WM+PM review strategy. |
| 12 | **"I notice / I wonder / What if / I think because" critique format** | gstack `design-review` (§2.8) | **4** | Structured feedback format that's teachable and reviewable. Much better than "spacing feels off". Directly pasteable into design-agent rules. |

---

## 8. Anti-patterns to AVOID

| # | Anti-pattern | Source | Why it conflicts with EG-Desk |
|---|--------------|--------|-------------------------------|
| A | **Full gstack preamble injection** | gstack `{{PREAMBLE}}` (§3.4) | The gstack preamble is ~270 lines of telemetry + update checks + session tracking. EG-Desk's CLAUDE.md already handles the philosophical layer (Evidence Elevation, Boil the Lake-like rules). Don't inject gstack's version-management machinery. |
| B | **`$B` browse binary as hard dependency** | gstack `design-review` (all phases) | gstack requires its own Playwright CLI (`browse`) at `.claude/skills/gstack/browse/dist/browse`. EG-Desk uses MCP Playwright (`mcp__playwright-electron__*`) which is a different API. Adopt the *pattern* (screenshots as evidence) but not the specific tool contract — rewrite for MCP Playwright. |
| C | **Generated SKILL.md files (the `.tmpl` → gen pipeline)** | gstack `CLAUDE.md:76-101` | gstack's `bun run gen:skill-docs` pipeline adds a build step that's unnecessary for EG-Desk's hand-curated `.claude/agents/*.md` files. Hot-reload is simpler. Steal the content, skip the generator. |
| D | **Telemetry hooks** | gstack `design-review/SKILL.md:44-51, 236-257` | Per-skill telemetry writes to `~/.gstack/analytics/` — explicitly out of scope for EG-Desk's project-scoped memory system. Drop entirely. |
| E | **bkit's multi-language trigger bloat** | bkit skills (e.g., `phase-5-design-system/SKILL.md:12-16`) | Each bkit skill declares triggers in ~8 languages. EG-Desk is Korean-primary with English secondary. Adopt Korean + English only; drop Chinese/Japanese/Spanish/French/German/Italian/Portuguese. |
| F | **bkit's `hooks.Stop` Node.js side-effects** | bkit `phase-5-design-system/SKILL.md:21-25` | Each phase skill runs a `node scripts/phase5-design-stop.js` hook with 10s timeout on Stop event. EG-Desk has its own hook system (`.claude/hooks/`, per CLAUDE.md). Don't double-wire. |
| G | **PDCA phase graph as hard state machine** | bkit `phase-*-*/SKILL.md` frontmatter (`pdca-phase`, `next-skill`) | bkit enforces Phase 1 → 2 → 3 → … → 9 in rigid order. EG-Desk's multi-track workflow (EGDesk dev + Swarm2 cofield per memory) doesn't fit a linear pipeline. Keep EG-Desk's ad-hoc team composition. |
| H | **gstack "contributor mode" + field reports** | gstack `design-review/SKILL.md:174-209` | Writes bug reports to `~/.gstack/contributor-logs/{slug}.md` for the gstack project. Out of scope for EG-Desk — would pollute EG-Desk's own memory with upstream feedback. |
| I | **gstack "Boil the Lake" completeness table forcing `A > B` regardless of cost** | gstack `ETHOS.md:20-28`, preamble `SKILL.md:117-140` | Every AskUserQuestion is pressured toward the "complete" option with compression ratios. This conflicts with EG-Desk's CLAUDE.md rule: *"Don't add features, refactor code, or make 'improvements' beyond what was asked."* Adopt the philosophy selectively — don't auto-pressure to the larger option. |
| J | **gstack hero image backgrounds + `font-display: swap`** | gstack `design-review/SKILL.md:888-889` | "No flat single-color backgrounds — use gradients, images, subtle patterns" + "Hero: full-bleed, edge-to-edge". These are **Landing Page Rules**, not App UI Rules. EG-Desk is App UI — apply only the App UI Rules subset (`SKILL.md:898-905`). |

---

## 9. Key file inventory (with byte counts)

### gstack — Priority A (deep read complete)
| File | Size | Status |
|------|------|--------|
| `references/gstack/design-consultation/SKILL.md.tmpl` | 19,081 B | Read in full |
| `references/gstack/design-consultation/SKILL.md` | 38,883 B | Read head (preamble verified as {{PREAMBLE}} expansion) |
| `references/gstack/design-review/SKILL.md.tmpl` | 9,244 B | Read in full |
| `references/gstack/design-review/SKILL.md` | 56,821 B | Read lines 1-1185 (preamble + Phases 1-11 + Fix Loop + Outside Voices) |
| `references/gstack/AGENTS.md` | 2,610 B | Read in full |
| `references/gstack/ETHOS.md` | 5,677 B | Read in full |
| `references/gstack/SKILL.md` | 29,474 B | Not read (top-level dispatcher, less relevant for design-agent template) |
| `references/gstack/SKILL.md.tmpl` | 7,528 B | Not read (same reason) |
| `references/gstack/CLAUDE.md` | 14,925 B | Partial (via system-reminder injection) |

### bkit — Priority B
| File | Status |
|------|--------|
| `references/bkit-claude-code/skills/phase-3-mockup/SKILL.md` | Read (UI trend catalog + componentization discipline) |
| `references/bkit-claude-code/skills/phase-5-design-system/SKILL.md` | Read in full (design system layers + tokens + platform catalog) |
| `references/bkit-claude-code/skills/phase-6-ui-integration/SKILL.md` | Listed, not read (low relevance) |
| `references/bkit-claude-code/skills/phase-8-review/SKILL.md` | Read head (agents section — design-validator pattern) |
| `references/bkit-claude-code/skills/skill-create/SKILL.md` | Read (interactive skill generation workflow + eval template) |
| `references/bkit-claude-code/output-styles/bkit-pdca-guide.md` | Read (response rules pattern + `keep-coding-instructions: true`) |
| `references/bkit-claude-code/output-styles/bkit-enterprise.md` | Listed, not read |
| `references/bkit-claude-code/output-styles/bkit-learning.md` | Listed, not read |
| `references/bkit-claude-code/output-styles/bkit-pdca-enterprise.md` | Listed, not read |
| `references/bkit-claude-code/skill-creator/templates/capability-skill.yaml` | Read in full |
| `references/bkit-claude-code/skill-creator/templates/workflow-skill.yaml` | Read in full |
| `references/bkit-claude-code/skill-creator/templates/eval-template.yaml` | Listed, not read (format already extracted from skill-create) |
| `references/bkit-claude-code/skill-creator/README.md` | Listed, not read |
| `references/bkit-claude-code/skill-creator/generator.js` | Listed, not read (JS impl, not prompt content) |
| `references/bkit-claude-code/skill-creator/validator.js` | Listed, not read (same) |
| `references/bkit-claude-code/templates/pipeline/phase-5-design-system.template.md` | Listed, not read (template variables) |
| `references/bkit-claude-code/templates/design.template.md` | Read head (PDCA "Design" phase document template, not an agent prompt — low relevance) |
| `references/bkit-claude-code/templates/design-starter.template.md` | Listed, not read |
| `references/bkit-claude-code/templates/design-enterprise.template.md` | Listed, not read |
| `references/bkit-claude-code/AI-NATIVE-DEVELOPMENT.md` | Read head (4 principles framework) |
| `references/bkit-claude-code/CUSTOMIZATION-GUIDE.md` | Listed, not read (67KB; not scanned in this mission) |

### Context files
| File | Status |
|------|--------|
| `.claude/agents/design-agent.md` (first 30 lines) | Read — confirms EG-Desk's current position on ambient AI workspace + Ontology Bridge |
| `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` (first 100 lines) | Read — confirms EG-Desk Surface color palette, Inter typography, forbidden patterns |

---

## 10. Most transferable single pattern (the bet)

If EG-Desk's design-agent can only adopt **one thing** from this mission:

> **gstack's 10-category / 80-item Design Audit Checklist with dual Design Score + AI Slop Score (A-F).**
> Source: `references/gstack/design-review/SKILL.md:620-736, 794-822, 861-926`.

**Why**:
- It's a **complete ready-to-adapt rubric** — not a philosophy, not a framework, but 80 concrete checks with impact severity and category weights.
- It's already **structured for review** — the WM+PM review strategy can cite category grades directly.
- It includes the **AI Slop blacklist** as both a category AND a headline metric — catches the single most visible AI-tell (which gstack calls out in `SKILL.md:915-924`).
- It has **App UI rules** specifically (not just landing page rules) — matches EG-Desk's workspace positioning.
- It ships with a **grading algorithm** (`SKILL.md:806`) that maps findings → category grade → composite score, so the agent's output is numerically comparable across runs.

**Second-best bet** (if two): gstack's **SAFE/RISK breakdown in design proposals** (`design-consultation/SKILL.md.tmpl:140-167`). Forces the agent to name where it's being unconventional instead of hiding spatial-canvas risk under "design decisions".

---

## Conclusion

**Gold tier confirmed**: explore-agent-4's assigned paths contained the highest-density prompt-craft patterns in the references/ directory. gstack's `design-consultation` and `design-review` are production-quality senior-designer prompts with concrete tool contracts, measurable output rubrics, and self-regulation discipline. bkit's contribution in this mission is smaller — mostly PDCA pipeline patterns and skill-factory meta-templates that are useful for `/agent-factory` but not for the designer persona itself.

**Recommended Phase 2 action for sprint-leader**: have `/agent-factory` merge the top 5 transferable primitives (items 1, 2, 4, 5, 6 in §7) into EG-Desk's `.claude/agents/design-agent.md`, with explicit attribution to gstack. Drop gstack's telemetry/browse-binary/preamble machinery (items A-D in §8). Keep EG-Desk's Ontology Bridge and ambient-AI positioning as the first-principles (Layer 3) framing that sits *above* the stolen rubric.

---

**Files read**: 14 full-read + 8 partial-read + 5 directory listings = 27 distinct file operations across gstack + bkit.
**Files created**: [`/Users/minsoocha/Projects/EG-Desk-Dev-Space/subagent_reports/20260410_explorer-4-gstack-bkit-gold_designer_prompt_patterns.md`]
**Agent**: explore-agent-4
**Report to**: sprint-leader
