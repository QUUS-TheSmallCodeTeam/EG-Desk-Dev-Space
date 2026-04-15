# Explorer-1 Direct Hits — Designer Prompt Patterns

**Tier**: TIER-1 (direct designer/UI/UX agent hits)
**Date**: 2026-04-10
**Scope**: `references/omc-scan/`, `references/bkit-claude-code/`, `references/agent-tools/awesome-openclaw-agents/`, `references/ecc-scan/`, `references/clawteam-scan/`
**Reporter**: explorer-1-direct-hits → sprint-leader
**Read-only**: confirmed (no writes outside this report file)

---

## 1. Files inspected

Absolute paths, every file read during this scan:

```
/Users/minsoocha/Projects/EG-Desk-Dev-Space/.claude/agents/design-agent.md (first 30 lines)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/ideas/brainstorming/DESIGN_SYSTEM_SPEC.md (lines 1-80, 80-200, 200-260)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/omc-scan/agents/designer.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/omc-scan/agents/critic.md (lines 1-80)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/omc-scan/agents/verifier.md (lines 1-80)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/bkit-claude-code/agents/design-validator.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/bkit-claude-code/agents/frontend-architect.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/bkit-claude-code/agents/pdca-eval-design.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/bkit-claude-code/agents/starter-guide.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/creative/brand-designer/SOUL.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/creative/brand-designer/README.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/creative/thumbnail-designer/SOUL.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/creative/ux-researcher/SOUL.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/creative/ux-researcher/README.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/development/game-designer/SOUL.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/awesome-openclaw-agents/agents/development/schema-designer/SOUL.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/ecc-scan/agents/architect.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/ecc-scan/agents/planner.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/ecc-scan/agents/typescript-reviewer.md (lines 1-80)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/ecc-scan/agents/loop-operator.md (lines 1-60)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/clawteam-scan/skills/clawteam/openai.yaml (file existed but trivial)
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/clawteam-scan/skills/clawteam/SKILL.md
/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/clawteam-scan/skills/clawteam/references/workflows.md
```

**Glob sweeps** (for triage):
```
references/omc-scan/agents/**/*          → 19 .md files
references/bkit-claude-code/agents/**/*  → 31 .md files
references/agent-tools/awesome-openclaw-agents/agents/creative/**/*   → 18 files (9 agents × README+SOUL)
references/agent-tools/awesome-openclaw-agents/agents/development/**/* → 31 files
references/ecc-scan/agents/**/*          → 28 .md files
references/clawteam-scan/skills/clawteam/**/* → 4 files (skill framework, not agents)
```

---

## 2. Designer agents found

Ranked by direct relevance to EG-Desk's design-agent.md refactor.

### TIER-A — Fully-formed designer/UI prompts

| # | File | 1-line summary |
|---|------|----------------|
| A1 | `references/omc-scan/agents/designer.md` | XML-tagged UI/UX designer-developer. Commits to aesthetic direction before coding, detects framework from package.json, uses Read/Glob/Write/Edit/Bash, has explicit anti-slop rules. **Closest structural match for design-agent.md.** |
| A2 | `references/bkit-claude-code/agents/frontend-architect.md` | Next.js/React/Tailwind/shadcn architect. Multilingual trigger list, PDCA role table, design principles, file naming conventions. Uses YAML frontmatter heavy with `permissionMode`, `memory`, `disallowedTools`, `tools`, `skills`. |
| A3 | `references/bkit-claude-code/agents/design-validator.md` | Read-only design document validator (`disallowedTools: Write,Edit,Bash`). Validation checklist, scoring rubric, completeness gates. **Template for a companion validator agent**, not a replacement for design-agent. |
| A4 | `references/agent-tools/awesome-openclaw-agents/agents/creative/brand-designer/SOUL.md` | Identity/Responsibilities/Skills/Rules/Tone/Examples structure. Brand positioning, color palettes with hex codes, typography pairing. Heavy on worked examples. |
| A5 | `references/agent-tools/awesome-openclaw-agents/agents/creative/thumbnail-designer/SOUL.md` | Compact SOUL format. Identity/Personality/Capabilities/Rules/Integrations/Example. Output = design brief with exact dimensions and component list. |

### TIER-B — Adjacent patterns (UX/product/design-support)

| # | File | 1-line summary |
|---|------|----------------|
| B1 | `references/agent-tools/awesome-openclaw-agents/agents/creative/ux-researcher/SOUL.md` | Research-focused — survey design, thematic analysis, NPS breakdown. Useful for future `ux-research-agent` spin-off; not direct design-agent material. |
| B2 | `references/agent-tools/awesome-openclaw-agents/agents/development/game-designer/SOUL.md` | Systems-design agent. "Every mechanic must answer why is this fun?" Good example of opinionated principle-first framing. |
| B3 | `references/agent-tools/awesome-openclaw-agents/agents/development/schema-designer/SOUL.md` | Database schema designer. "Always respond in English, default to PostgreSQL" — shows how to bake strict defaults into Rules section. |
| B4 | `references/bkit-claude-code/agents/starter-guide.md` | Beginner-friendly HTML/CSS guide. Good example of tone constraints (Required Rules / Prohibited Rules blocks). |
| B5 | `references/bkit-claude-code/agents/pdca-eval-design.md` | Scoring rubric for design-phase quality. D1 accuracy / D2 domain / D3 phase skill. Template for a design-QA loop. |

### TIER-C — Verification/critic primitives (not designers, but referenced for primitive extraction)

| # | File | 1-line summary |
|---|------|----------------|
| C1 | `references/omc-scan/agents/critic.md` | Multi-perspective gap-analysis critic. Pre-commitment phase, pre-mortem protocol. Template for the "did the design actually render?" review loop. |
| C2 | `references/omc-scan/agents/verifier.md` | Evidence-based completion verifier. VERIFIED/PARTIAL/MISSING status per acceptance criterion. Template for Playwright-backed verification. |

### TIER-NULL — No direct hits
- `references/ecc-scan/agents/**` — no explicit designer/UI agent. `architect.md` is backend-flavored (Redis, pgvector, Supabase examples). Not applicable.
- `references/clawteam-scan/skills/clawteam/**` — CLI orchestration framework, not agent prompts. No designer content. **Out of tier scope.**

---

## 3. Prompt pattern excerpts (verbatim)

Organized by primitive. Each excerpt is directly quotable with `file:line` citation.

### 3.1 Role framing ("You are a ...")

**omc-scan/designer.md:9-13** — tight role + explicit non-responsibilities:
```
You are Designer. Your mission is to create visually stunning, production-grade UI implementations that users remember.
You are responsible for interaction design, UI solution design, framework-idiomatic component implementation, and visual polish (typography, color, motion, layout).
You are not responsible for research evidence generation, information architecture governance, backend logic, or API design.
```

**bkit/frontend-architect.md:47** — role stated once, no fluff:
```
You are a Frontend Architect specializing in modern web application architecture.
```

**openclaw/brand-designer/SOUL.md:3-4** — identity + scope (ends with "you think at the intersection"):
```
You are Brand Designer, an AI brand strategy and identity assistant powered by OpenClaw. You help companies define and articulate their brand — from positioning and messaging to visual guidelines and tone of voice. You think at the intersection of strategy and aesthetics, ensuring every brand element serves a purpose.
```

**openclaw/thumbnail-designer/SOUL.md:8-9** — identity as personality block:
```
## Personality
You are a click-optimized visual designer for thumbnails and social media banners. You understand what makes people stop scrolling and click. You balance attention-grabbing design with brand consistency.
```

**Pattern**: every designer prompt leads with an extremely specific role identity. OMC's is the strongest because it also declares what the agent is NOT responsible for — this is uncommon but high-leverage.

### 3.2 Tool permissions (allowed/disallowed tools)

**bkit/design-validator.md:30-42** — explicit disallow list + allow list:
```yaml
disallowedTools:
  - Write
  - Edit
  - Bash
# hooks: Managed by hooks/hooks.json (pre-write.js blocks Write) - GitHub #9354 workaround
tools:
  - Read
  - Glob
  - Grep
skills:
  - bkit-templates
  - phase-8-review
```

**bkit/frontend-architect.md:26-38** — disallow *patterns* (bash globs):
```yaml
disallowedTools:
  - "Bash(rm -rf*)"
  - "Bash(git push*)"
  - "Bash(git reset --hard*)"
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task(Explore)
  - WebSearch
```

**omc-scan/designer.md:44-55** — tool usage as *narrative*, not YAML:
```
<Tool_Usage>
  - Use Read/Glob to examine existing components and styling patterns.
  - Use Bash to check package.json for framework detection.
  - Use Write/Edit for creating and modifying components.
  - Use Bash to run dev server or build to verify implementation.
  <External_Consultation>
    When a second opinion would improve quality, spawn a Claude Task agent:
    - Use `Task(subagent_type="oh-my-claudecode:designer", ...)` for UI/UX cross-validation
    - Use `/team` to spin up a CLI worker for large-scale frontend work
    Skip silently if delegation is unavailable. Never block on external consultation.
  </External_Consultation>
</Tool_Usage>
```

**Pattern**: bkit uses frontmatter whitelist/blacklist (machine-enforced); OMC writes tool usage *instructions* in the body (human-readable). Two distinct approaches — both valid.

### 3.3 Output contract (what the agent returns)

**omc-scan/designer.md:63-82** — structured markdown template:
```
<Output_Format>
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
</Output_Format>
```

**bkit/design-validator.md:161-192** — validation report template with severity buckets:
```markdown
# Design Document Validation Results

## Validation Target
- Document: {document path}
- Validation Date: {date}

## Completeness Score: {score}/100

## Issues Found

### 🔴 Critical (Implementation Not Possible)
- [Issue description]
- [Recommended action]

### 🟡 Warning (Improvement Needed)
- [Issue description]
- [Recommended action]

### 🟢 Info (Reference)
- [Issue description]

## Checklist Results
- ✅ Overview: Complete
- ⚠️ Architecture: Diagram missing
- ❌ Test Plan: Not written
```

**omc-scan/verifier.md:55-80** — verdict table structure for companion verifier agent:
```
## Verification Report

### Verdict
**Status**: PASS | FAIL | INCOMPLETE
**Confidence**: high | medium | low
**Blockers**: [count — 0 means PASS]

### Evidence
| Check | Result | Command/Source | Output |
|-------|--------|----------------|--------|
| Tests | pass/fail | `npm test` | X passed, Y failed |
| Types | pass/fail | `lsp_diagnostics_directory` | N errors |
| Build | pass/fail | `npm run build` | exit code |
| Runtime | pass/fail | [manual check] | [observation] |
```

**Pattern**: every high-quality designer has a *fixed* output template. The agent cannot freestyle. EG-Desk's current design-agent.md has no such template.

### 3.4 Verification loops (how the agent checks its work)

**omc-scan/designer.md:36-42** — inline verification step:
```
<Investigation_Protocol>
  1) Detect framework: check package.json for react/next/vue/angular/svelte/solid. Use detected framework's idioms throughout.
  2) Commit to an aesthetic direction BEFORE coding: Purpose (what problem), Tone (pick an extreme), Constraints (technical), Differentiation (the ONE memorable thing).
  3) Study existing UI patterns in the codebase: component structure, styling approach, animation library.
  4) Implement working code that is production-grade, visually striking, and cohesive.
  5) Verify: component renders, no console errors, responsive at common breakpoints.
</Investigation_Protocol>
```

**omc-scan/designer.md:97-103** — final checklist (self-gate before returning):
```
<Final_Checklist>
  - Did I detect and use the correct framework?
  - Does the design have a clear, intentional aesthetic (not generic)?
  - Did I study existing patterns before implementing?
  - Does the implementation render without errors?
  - Is it responsive and accessible?
</Final_Checklist>
```

**omc-scan/verifier.md:29-41** — separation of verifier from writer:
```
<Constraints>
  - Verification is a separate reviewer pass, not the same pass that authored the change.
  - Never self-approve or bless work produced in the same active context; use the verifier lane only after the writer/executor pass is complete.
  - No approval without fresh evidence. Reject immediately if: words like "should/probably/seems to" used, no fresh test output, claims of "all tests pass" without results, no type check for TypeScript changes, no build verification for compiled languages.
  - Run verification commands yourself. Do not trust claims without output.
  - Verify against original acceptance criteria (not just "it compiles").
</Constraints>

<Investigation_Protocol>
  1) DEFINE: What tests prove this works? What edge cases matter? What could regress? What are the acceptance criteria?
  2) EXECUTE (parallel): Run test suite via Bash. Run lsp_diagnostics_directory for type checking. Run build command. Grep for related tests that should also pass.
```

**bkit/design-validator.md:206-216** — post-validation gating on score:
```
Validation Score < 70:
  → Recommend design completion before implementation

Validation Score >= 70 && < 90:
  → Implementation possible after improving Warning items

Validation Score >= 90:
  → Implementation approved
```

**Pattern**: two distinct loops observed:
  - **Self-verification** (OMC designer's step 5 + Final_Checklist) — same agent verifies its own output
  - **Separate reviewer pass** (OMC verifier + bkit design-validator) — different agent with Write disabled

OMC explicitly says `Never self-approve or bless work produced in the same active context`. For EG-Desk, this means design-agent should NOT be its own validator.

### 3.5 Design token / style guide handling

**bkit/frontend-architect.md:76-90** — design principles + naming conventions as tables:
```
### Design Principles

1. **Component Composition**: Prefer composition over inheritance
2. **Single Responsibility**: Each component has one clear purpose
3. **Accessibility First**: WCAG 2.1 AA compliance
4. **Performance**: Code splitting, lazy loading, memoization
5. **Type Safety**: Full TypeScript coverage with strict mode

### File Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| Components | PascalCase | `UserProfile.tsx` |
| Hooks | camelCase with `use` prefix | `useAuth.ts` |
| Utils | camelCase | `formatDate.ts` |
| Types | PascalCase | `UserTypes.ts` |
| Styles | kebab-case | `user-profile.module.css` |
```

**openclaw/brand-designer/SOUL.md:58-69** — color palette as structured table the agent must produce:
```
### Color Palette
| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| Primary | Deep Navy | #1B2A4A | Headers, primary buttons |
| Secondary | Electric Teal | #00D4AA | Accents, status indicators |
| Success | Green | #22C55E | Healthy/up states |
| Warning | Amber | #F59E0B | Degraded states |
| Error | Red | #EF4444 | Down/critical states |
| Background | Near-white | #F8FAFC | Page backgrounds |
| Text | Dark gray | #1E293B | Body copy |

*Rationale: Navy conveys trust and professionalism. Teal stands out in a space dominated by blues and purples. Status colors follow developer expectations.*
```

**omc-scan/designer.md:28-34** — design constraints as banned list (anti-slop):
```
<Constraints>
  - Detect the frontend framework from project files before implementing (package.json analysis).
  - Match existing code patterns. Your code should look like the team wrote it.
  - Complete what is asked. No scope creep. Work until it works.
  - Study existing patterns, conventions, and commit history before implementing.
  - Avoid: generic fonts, purple gradients on white (AI slop), predictable layouts, cookie-cutter design.
</Constraints>
```

**openclaw/schema-designer/SOUL.md:20-26** — strict formatting rules as "Rules" section:
```
## Rules
- Always respond in English
- Default to PostgreSQL syntax unless the user specifies otherwise
- Every table must have a primary key, created_at, and updated_at
- Use snake_case for column names, singular nouns for table names
- Always include foreign key constraints and ON DELETE behavior
- Provide both the SQL DDL and a Mermaid ERD in every response
```

**Pattern**: design tokens live in two places:
1. **Inside the prompt** (bkit frontend-architect naming table, brand-designer color table) — agent MUST produce this structure
2. **As an external reference** (EG-Desk's current design-agent.md points to `DESIGN_SYSTEM_SPEC.md`) — agent MUST consult it

None of the references did both. EG-Desk's DESIGN_SYSTEM_SPEC.md is far richer than anything in-prompt, so the "read external spec" pattern is the right fit — but the current design-agent.md should add **"reject any design decision that contradicts DESIGN_SYSTEM_SPEC §N"** as a hard constraint.

### 3.6 Anti-patterns / failure modes

**omc-scan/designer.md:84-90** — explicit failure modes block:
```
<Failure_Modes_To_Avoid>
  - Generic design: Using Inter/Roboto, default spacing, no visual personality. Instead, commit to a bold aesthetic and execute with precision.
  - AI slop: Purple gradients on white, generic hero sections. Instead, make unexpected choices that feel designed for the specific context.
  - Framework mismatch: Using React patterns in a Svelte project. Always detect and match the framework.
  - Ignoring existing patterns: Creating components that look nothing like the rest of the app. Study existing code first.
  - Unverified implementation: Creating UI code without checking that it renders. Always verify.
</Failure_Modes_To_Avoid>
```

**omc-scan/designer.md:92-95** — Good/Bad example pair:
```
<Examples>
  <Good>Task: "Create a settings page." Designer detects Next.js + Tailwind, studies existing page layouts, commits to a "editorial/magazine" aesthetic with Playfair Display headings and generous whitespace. Implements a responsive settings page with staggered section reveals on scroll, cohesive with the app's existing nav pattern.</Good>
  <Bad>Task: "Create a settings page." Designer uses a generic Bootstrap template with Arial font, default blue buttons, standard card layout. Result looks like every other settings page on the internet.</Bad>
</Examples>
```

**Pattern**: OMC designer is the only one with paired Good/Bad examples inside the prompt. This is cheap insurance against slop.

### 3.7 "Why this matters" (rationale injection)

**omc-scan/designer.md:15-17** — rationale block forces the model to internalize the stakes:
```
<Why_This_Matters>
  Generic-looking interfaces erode user trust and engagement. These rules exist because the difference between a forgettable and a memorable interface is intentionality in every detail -- font choice, spacing rhythm, color harmony, and animation timing. A designer-developer sees what pure developers miss.
</Why_This_Matters>
```

**omc-scan/critic.md:21-27** — heavy-weight rationale with supporting claim:
```
<Why_This_Matters>
  Standard reviews under-report gaps because reviewers default to evaluating what's present rather than what's absent. A/B testing showed that structured gap analysis ("What's Missing") surfaces dozens of items that unstructured reviews produce zero of — not because reviewers can't find them, but because they aren't prompted to look.
  ...
  Every undetected flaw that reaches implementation costs 10-100x more to fix later. Historical data shows plans average 7 rejections before being actionable — your thoroughness here is the highest-leverage review in the entire pipeline.
</Why_This_Matters>
```

**Pattern**: OMC is alone in using a `<Why_This_Matters>` block. Every other agent jumps straight to rules. This is an EG-Desk-worthy addition because EG-Desk has strong philosophical stakes (Ontology Bridge, Calm Technology) that the agent MUST understand, not just comply with.

---

## 4. Recurring primitives (seen 2+ times across different sources)

| # | Primitive | Sources | Observation |
|---|-----------|---------|-------------|
| R1 | **Identity/Role first, scope second** | omc designer, bkit frontend-architect, openclaw brand/thumbnail/schema/game, bkit starter-guide | Every designer starts with "You are X. Your mission is Y." Never buried. |
| R2 | **Rules section with prohibitions** | openclaw brand/thumbnail/schema/game, bkit starter-guide (Required/Prohibited), omc designer (Constraints/Failure_Modes) | Positive principles alone don't work — an explicit "do NOT" list is universal. |
| R3 | **Structured output template the agent must emit** | omc designer, bkit design-validator, omc verifier, openclaw brand-designer (embedded in example) | The best prompts fix the output shape. No output template = freestyle = inconsistent. |
| R4 | **Framework/stack detection step BEFORE generation** | omc designer (step 1: detect framework), bkit frontend-architect (stack focus list) | Agent reads package.json / stack indicators *before* writing code. Prevents mismatch. |
| R5 | **Example interactions (Good/Bad or User/Agent pairs)** | omc designer (Good/Bad), openclaw brand/thumbnail/ux-researcher/game/schema (User/Agent) | Few-shot examples inside the prompt are standard. OpenClaw goes heavy (half the file is examples), OMC goes light (one pair). |
| R6 | **Multilingual trigger keywords** | bkit design-validator, bkit frontend-architect, bkit starter-guide | Bkit uniformly lists trigger words in ~8 languages. EG-Desk might not need this (single user, Korean) but it's a pattern worth noting. |
| R7 | **Tool restrictions via YAML frontmatter OR via body narrative** | bkit (frontmatter disallow list), omc (body narrative), ecc (frontmatter tools array) | Two different conventions. Bkit's is machine-enforceable; OMC's is human-readable guidance. EG-Desk should pick one and be consistent. |
| R8 | **Separation of author pass from review pass** | omc verifier ("Never self-approve"), bkit design-validator (separate agent), omc critic (separate agent) | Consistent rule: the agent that produced the work CANNOT verify it. EG-Desk's design-agent currently has no such separation. |
| R9 | **Final checklist / self-gate before return** | omc designer (Final_Checklist), omc verifier (Investigation_Protocol step 4), omc critic (Gap Analysis phase) | Agents that write end-of-prompt checklists catch more issues than those that don't. |
| R10 | **Rationale block explaining WHY the rules exist** | omc designer (Why_This_Matters), omc critic (Why_This_Matters with A/B evidence) | Only OMC does this. Strong pattern for philosophically-loaded agents like EG-Desk design-agent. |

---

## 5. Notable anti-patterns (things to AVOID)

| # | Anti-pattern | Where seen | Why bad for EG-Desk |
|---|--------------|------------|---------------------|
| N1 | **Marketing-speak identity** ("click-optimized visual designer who understands what makes people stop scrolling") | openclaw thumbnail-designer/SOUL.md:9 | Sounds like ad copy. Doesn't help the agent make decisions. OMC's direct style is cleaner. |
| N2 | **Burying tool permissions inside prose** | omc designer (narrative) | Not enforceable by Claude Code harness. Any hard prohibition MUST be in frontmatter. |
| N3 | **Version-specific changelog cruft inside the agent body** (`v1.5.8 Feature Guidance`, `v1.6.1 Feature Guidance`) | bkit/design-validator.md:218-237, frontend-architect.md:92-99, starter-guide.md:119-137 | Changelog notes pollute the prompt and mislead the agent into referencing skills that may not exist. Never put release notes in an agent body. |
| N4 | **Multilingual trigger lists that triple the frontmatter size** | bkit/design-validator.md:11-15, frontend-architect.md:11-17, starter-guide.md:11-16 | Wastes tokens. EG-Desk is single-user; Korean triggers alone suffice. |
| N5 | **Architect agent with no concrete stack** (Redis, pgvector, Supabase as examples) | ecc-scan/architect.md:186-209 | Example-as-truth risk: model may default to suggesting Supabase even when project uses something else. If you list stack, list YOUR stack, not an example. |
| N6 | **Multiple rubric dimensions with weighted scores baked into the agent** | bkit/pdca-eval-design.md:48-93 | The scoring rubric is so rigid it becomes noise. Works for internal bkit benchmarking, not for a working designer agent. |
| N7 | **"Always respond in English" when the project is Korean** | openclaw thumbnail-designer/SOUL.md:21, schema-designer/SOUL.md:20 | Mechanical language rule without justification. EG-Desk wants Korean responses — explicitly set that. |
| N8 | **No output template at all** (free-form "study existing patterns") | ecc-scan/architect.md (no Output_Format block), ecc-scan/planner.md has a plan template but no explicit "return exactly this" constraint | Leads to inconsistent agent responses across invocations. Always fix the output shape. |
| N9 | **Self-verification in same pass** (agent says "I verified this works") without running anything | ecc-scan/architect.md (no verification step at all) | OMC explicitly forbids this. EG-Desk should too. |
| N10 | **Skill/tool references the current project doesn't have** (`skills: phase-3-mockup`, `skills: phase-5-design-system`) | bkit/frontend-architect.md:40-42 | Copy-pasting this into EG-Desk would produce dead references. Strip all `skills:` entries that don't exist in EG-Desk. |

---

## 6. Relevance score vs EG-Desk

EG-Desk context for scoring:
- **Stack**: HTML/CSS/JS + plans for React (see `.claude/agents/design-agent.md:3` — Figma MCP via Codex CLI, spatial canvas)
- **Verification**: Playwright (MCP available: `mcp__playwright-electron__*`), no Figma MCP
- **Design system**: Fixed — `DESIGN_SYSTEM_SPEC.md` (EG-Desk Surface, Warm Off-White #F5F3EF palette, Inter typography, 4-Edge Framework, hard prohibitions on black backgrounds / neon / gradients / glassmorphism — §2 `금지 색상`)
- **Philosophy**: Ontology Bridge (real-world analogies, anti-flattening), Calm Technology, AI-invisible-until-invoked (§1 design-agent.md:12-20)
- **Language**: Korean responses

Scoring: 1 = barely applicable, 3 = directly useful, 5 = copy with minor edit.

| Pattern | Source | Score | Notes |
|---------|--------|:-----:|-------|
| XML-tagged `<Agent_Prompt>` structure (Role / Why / Success / Constraints / Protocol / Output / Failure_Modes / Examples / Checklist) | `omc-scan/agents/designer.md:8-104` | **5** | Direct structural template for design-agent.md refactor. Every block is applicable. Adapt: replace "framework detection" with "DESIGN_SYSTEM_SPEC.md compliance check". |
| `<Why_This_Matters>` rationale block | `omc-scan/agents/designer.md:15-17`, `critic.md:21-27` | **5** | EG-Desk has the strongest philosophy (Ontology Bridge, Calm Technology) — this block forces the agent to internalize the stakes. Drop in directly, paraphrase for EG-Desk's specific mission. |
| `<Failure_Modes_To_Avoid>` explicit anti-slop list | `omc-scan/agents/designer.md:84-90` | **5** | EG-Desk already has a "금지 색상" list in DESIGN_SYSTEM_SPEC — mirror that format in the prompt. E.g., "Never use glassmorphism except on Edge HUD panels. Never tilt cards. Never use neon." |
| Fixed Output_Format block (`## Design Implementation` with Aesthetic Direction / Components / Design Choices / Verification sections) | `omc-scan/agents/designer.md:63-82` | **4** | Adapt: Verification section becomes Playwright-specific (screenshot paths, viewport breakpoints tested). Keep the structure. |
| Framework detection step BEFORE generation | `omc-scan/agents/designer.md:36` (step 1) | **4** | Adapt: instead of detecting framework, detect which EG-Desk screen type (canvas / Edge HUD / Entity card / Full mode) and which Edge (Top/Bottom/Left/Right). Agent reads DESIGN_SYSTEM_SPEC §7-8 before designing. |
| Separation of writer pass from verifier pass + companion verifier agent | `omc-scan/agents/verifier.md:29-41`, `bkit/design-validator.md` | **4** | EG-Desk should spawn a separate `design-validator-agent` (read-only) that checks output against DESIGN_SYSTEM_SPEC. design-agent.md itself should not self-approve. Strong fit. |
| YAML frontmatter tool restrictions (whitelist/blacklist) | `bkit/design-validator.md:30-42`, `bkit/frontend-architect.md:26-38` | **4** | EG-Desk design-agent.md currently has minimal frontmatter. Add explicit `tools:` list (Read, Write, Edit, Glob, Grep, Bash, Task, `mcp__playwright-electron__*`). Consider blocking `Bash(rm *)` patterns. |
| Rules section with "Required / Prohibited" dual lists | `bkit/starter-guide.md:47-64` | **4** | Clean format for EG-Desk's "Always X / Never Y" constraints. Cleaner than mixing them in a single bulleted Constraints block. |
| Good/Bad example pair inside prompt | `omc-scan/agents/designer.md:92-95` | **4** | EG-Desk needs this with a spatial-canvas example. e.g., Good: "Top Edge Desk Rail with frosted glass, traffic lights left, Cmd+K center, minimap right per §7-1". Bad: "Sidebar navigation with solid dark background and icon list" (violates §2 and §7-1). |
| Validation rubric with scoring tiers (Critical/Warning/Info + score gate) | `bkit/design-validator.md:161-216` | **3** | Useful shape for the separate design-validator-agent report. Adapt: Critical = violates DESIGN_SYSTEM_SPEC hard rules, Warning = ambiguous, Info = style nitpick. Score gate at 70/90 is arbitrary but the structure works. |
| Design principles as numbered list | `bkit/frontend-architect.md:76-82` | **3** | EG-Desk already has this in `DESIGN_SYSTEM_SPEC.md`. No need to duplicate in the agent prompt — link to spec. |
| Brand-designer style color palette table as output | `openclaw/brand-designer/SOUL.md:58-69` | **2** | EG-Desk color palette is FROZEN (§2). Agent should NOT generate new palettes; it should consume the existing one. Useful only as a reminder of how strict the palette table should be. |
| PDCA scoring rubric (D1/D2/D3 weighted) | `bkit/pdca-eval-design.md:48-93` | **2** | Overkill for EG-Desk. Only relevant if you want benchmarked evaluation reports — not a first-version need. |
| Game designer "why is this fun?" principle | `openclaw/game-designer/SOUL.md:21` | **2** | Meta-pattern worth noting: EG-Desk's analog could be "why does this feel like a physical desk?" — forces every design decision to justify itself against Ontology Bridge. |
| Loop-operator stall-detection pattern | `ecc-scan/agents/loop-operator.md:16-37` | **1** | Not relevant to design-agent directly. Possibly useful later if design-agent runs in a refinement loop. |
| CLI orchestration framework (clawteam) | `references/clawteam-scan/skills/clawteam/SKILL.md` | **1** | Out-of-scope for design-agent refactor. Possibly useful for team-lead agent composition, not designer. |
| Game designer monetization warnings | `openclaw/game-designer/SOUL.md:27` | **1** | Not applicable. |
| Architect ADR template | `ecc-scan/agents/architect.md:106-142` | **2** | Could be useful for design decision records (e.g., "ADR-001: Use frosted glass only on Edge HUDs, not on canvas cards"). Not first-version need. |
| Multilingual trigger keyword frontmatter | `bkit/design-validator.md:11-15` | **1** | Wastes tokens for single-user EG-Desk. Skip. |
| bkit version-history feature guidance footers | `bkit/design-validator.md:218-237` | **1** | Anti-pattern. Do NOT copy. |

---

## 7. Synthesis recommendations [분석]

For the sprint-leader to feed into agent-factory:

1. **Adopt OMC's XML-tagged skeleton** (`Role` / `Why_This_Matters` / `Success_Criteria` / `Constraints` / `Investigation_Protocol` / `Tool_Usage` / `Execution_Policy` / `Output_Format` / `Failure_Modes_To_Avoid` / `Examples` / `Final_Checklist`) as the design-agent.md backbone. This is the highest-quality direct-hit template found (relevance 5).

2. **Replace "framework detection" with "DESIGN_SYSTEM_SPEC consultation + Edge/mode detection"** in the Investigation Protocol. Step 1 must read `DESIGN_SYSTEM_SPEC.md` and identify which Edge/screen type applies.

3. **Add a hard constraint block citing DESIGN_SYSTEM_SPEC §2 (금지 색상) and §4 (절대 금지: tilt/3D/over-shadow)** under `Constraints`. Verbatim prohibitions from the spec.

4. **Add a `Why_This_Matters` block specific to EG-Desk's Ontology Bridge philosophy** (docs/vision/ontology-bridge.md reference). This is where you paste the "real world has two axes, digitization flattens both" thesis so the agent internalizes it.

5. **Fix the Output_Format** as: Aesthetic Direction (Edge/mode chosen + rationale) / Files Created / Design Choices (mapped to DESIGN_SYSTEM_SPEC tokens) / Verification (Playwright screenshot paths + viewport list).

6. **Spawn a separate `design-validator-agent`** (read-only, `disallowedTools: Write, Edit, Bash`) that consumes the designer's output and emits a Critical/Warning/Info report. Modeled on `bkit/design-validator.md` but with DESIGN_SYSTEM_SPEC as the checklist source, not bkit's generic phase gates.

7. **Tool permissions**: YAML frontmatter whitelist in EG-Desk style. Include `mcp__playwright-electron__*` for verification. Block destructive Bash patterns (`Bash(rm -rf*)`, `Bash(git reset --hard*)`).

8. **Korean response requirement** as an explicit Rule, not a frontmatter hack. Cite `~/.claude/CLAUDE.md` language directive.

9. **Paired Good/Bad examples** using actual EG-Desk screen types (Top Edge Desk Rail, a canvas card, a Cmd+K Spotlight). Both drawn from DESIGN_SYSTEM_SPEC §7 to ensure alignment.

10. **DO NOT copy**: multilingual trigger lists (N4), version-history footers (N3), the pdca-eval scoring rubric (N6), or fabricated stack examples (N5). Strip anything that references a skill that doesn't exist in EG-Desk.

---

## 8. Out-of-scope findings (handed off to other explorers)

None — this explorer stayed within tier-1 direct hits. Tier-2 (`claude-code`, orchestration frameworks) and tier-3 (`agent-orchestration` patterns, Deta Surf, Theia) are explorer-2 and explorer-3's responsibility.

---

**Report complete.** Read-only commitment honored: only write performed was this single report file.
