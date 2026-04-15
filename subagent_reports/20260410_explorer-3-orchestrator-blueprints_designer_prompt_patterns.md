# Explorer-3 — Orchestrator Blueprints: Designer Prompt Patterns

**Date**: 2026-04-10
**Tier**: TIER-3 ORCHESTRATOR BLUEPRINTS (multi-agent orchestration systems)
**Scope**: How designer roles are defined when interfaced with planners, coders, verifiers in pipelines
**Method**: Read-only exploration of 7 reference systems

---

## 1. Files Inspected

### Context (read once)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/.claude/agents/design-agent.md` (lines 1-30)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` (§1-3, §7-1, §7-2, §7-3)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/.claude/wm/project-profile.md` (§7 Agent Infrastructure)

### agent-orchestration/agent-orchestrator (Composio)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/CLAUDE.md` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/AGENTS.md` (lines 1-31)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/agent-orchestrator.yaml.example` (full, lines 77-95 = role-specific overrides)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/packages/core/src/orchestrator-prompt.ts` (full, 247 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/packages/core/src/agent-selection.ts` (lines 10, 25, 36-37)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/docs/design/feedback-routing-and-followup-design.md` (lines 1-120)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/agent-orchestrator/README.md` (referenced via grep)

### agent-orchestration/deepagentsjs (LangChain/Anthropic)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/deepagentsjs/libs/deepagents/src/middleware/subagents.ts` (lines 1-340)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/deepagentsjs/examples/hierarchical/hierarchical-agent.ts` (full, 189 lines)

### agent-orchestration/paperclip
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/paperclip/skills/paperclip-create-agent/SKILL.md` (full, 143 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/paperclip/docs/start/core-concepts.md` (full, 87 lines)

### agent-orchestration/ruflo (Claude Flow v3.5)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/ruflo/CLAUDE.md` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/ruflo/CLAUDE.local.md` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/ruflo/agents/architect.yaml` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/ruflo/agents/coder.yaml` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/ruflo/agents/reviewer.yaml` (full)

### agent-orchestration/clawteam (HKUDS)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-orchestration/clawteam/README.md` (lines 1-80)

### agent-tools/superpowers (Obra)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/CLAUDE.md` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/skills/subagent-driven-development/SKILL.md` (full, 278 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/skills/subagent-driven-development/implementer-prompt.md` (full, 113 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/skills/subagent-driven-development/spec-reviewer-prompt.md` (full, 61 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/skills/subagent-driven-development/code-quality-reviewer-prompt.md` (full, 27 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/skills/dispatching-parallel-agents/SKILL.md` (full, 183 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/superpowers/agents/code-reviewer.md` (full, 49 lines)

### agent-tools/claude-howto (Anthropic howto repo)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/claude-howto/04-subagents/README.md` (full, 1142 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/claude-howto/04-subagents/code-reviewer.md` (full, 62 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/claude-howto/04-subagents/implementation-agent.md` (full, 79 lines)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/claude-howto/04-subagents/data-scientist.md` (full, 98 lines)

### agent-tools/prompt-master
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/prompt-master/SKILL.md` (lines 1-80)

### agent-tools/cc-wf-studio
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/cc-wf-studio/CLAUDE.md` (full)
- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/references/agent-tools/cc-wf-studio/specs/001-ai-workflow-generation/spec.md` (lines 1-100)

---

## 2. Designer Role Definitions Across Systems

**Critical finding (negative space)**: **No system in this scope defines a UI/UX/visual designer role.** All systems treat "design" as either (a) a *stage* embedded in an architect/system-design role producing text/diagrams, or (b) a *document artifact* (design brief, spec) authored by a human or generic agent. The closest analogue is `architect` (system-level) or `data-scientist` (domain specialist).

| System | Role with closest "designer" semantics | Role definition (verbatim or summary) | Citation |
|---|---|---|---|
| **agent-orchestrator (Composio)** | None — only `orchestrator` and `worker` roles | `"Your role is to coordinate and manage worker agent sessions. You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help."` | `references/agent-orchestration/agent-orchestrator/packages/core/src/orchestrator-prompt.ts:30` |
| **agent-orchestrator (Composio)** | `SessionRole = "orchestrator" \| "worker"` (TypeScript type) | `export type SessionRole = "orchestrator" \| "worker";` — role split is at the SESSION level. Only ONE specialization axis exists; the agent backend itself (`claude-code`/`codex`/`aider`/`opencode`) is interchangeable per role. | `references/agent-orchestration/agent-orchestrator/packages/core/src/agent-selection.ts:10` |
| **agent-orchestrator (Composio)** | YAML config supports `orchestrator:` and `worker:` overrides per project | `# Optional role-specific agent overrides` / `# orchestrator: agent: claude-code agentConfig: model: claude-sonnet-4-5` / `# worker: agent: codex agentConfig: model: gpt-5-codex` | `references/agent-orchestration/agent-orchestrator/agent-orchestrator.yaml.example:77-86` |
| **deepagentsjs (LangChain)** | `SubAgent` interface — fully generic, role defined by `name + description + systemPrompt` | `interface SubAgent { name: string; description: string; systemPrompt: string; tools?, model?, middleware?, interruptOn?, skills?, responseFormat? }` — no built-in designer/coder/reviewer taxonomy. Roles are emergent from prompt content. | `references/agent-orchestration/deepagentsjs/libs/deepagents/src/middleware/subagents.ts:267-337` |
| **deepagentsjs (LangChain)** | "general-purpose" subagent default | `"General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent."` | `references/agent-orchestration/deepagentsjs/libs/deepagents/src/middleware/subagents.ts:57-58` |
| **deepagentsjs hierarchical example** | `research-specialist` (sub-DeepAgent) and `fact-checker` (leaf SubAgent) — 3-level org chart | `"You are a research specialist. Your role is to gather news, analyze data, and produce well-researched findings."` / `"You are a fact-checking specialist. Use the verify_claim tool to check the accuracy of any claims or statements you receive."` | `references/agent-orchestration/deepagentsjs/examples/hierarchical/hierarchical-agent.ts:115-118, 101-104` |
| **paperclip** | Agent is a *company employee* with `role`, `title`, `reportsTo`, `capabilities` — taxonomy is unconstrained, defined per-hire | Hire payload example: `"name": "CTO", "role": "cto", "title": "Chief Technology Officer", "icon": "crown", "reportsTo": "<ceo-agent-id>", "capabilities": "Owns technical roadmap, architecture, staffing, execution"` | `references/agent-orchestration/paperclip/skills/paperclip-create-agent/SKILL.md:73-89` |
| **paperclip** | Org-chart enforcement | `"Agents are organized in a strict tree hierarchy. Every agent reports to exactly one manager (except the CEO). This chain of command is used for escalation and delegation."` | `references/agent-orchestration/paperclip/docs/start/core-concepts.md:30` |
| **ruflo (Claude Flow v3.5)** | `architect` agent (closest to "designer") | YAML: `type: architect / capabilities: [system-design, api-design, documentation] / optimizations: [context-caching, memory-persistence]`. No system prompt — role is purely declarative metadata. | `references/agent-orchestration/ruflo/agents/architect.yaml:1-11` |
| **ruflo** | `coder` agent | YAML: `type: coder / capabilities: [code-generation, refactoring, debugging] / optimizations: [flash-attention, token-reduction]` | `references/agent-orchestration/ruflo/agents/coder.yaml:1-11` |
| **ruflo** | `reviewer` agent | YAML: `type: reviewer / capabilities: [code-review, quality-analysis, best-practices] / optimizations: [incremental-analysis]` | `references/agent-orchestration/ruflo/agents/reviewer.yaml:1-10` |
| **ruflo** | Auto-Start Swarm template uses fixed taxonomy | `Task("Coordinator", ...) Task("Researcher", ...) Task("Architect", ...) Task("Coder", ...) Task("Tester", ...) Task("Reviewer", ...)` — 6-role default. No designer slot. | `references/agent-orchestration/ruflo/CLAUDE.md` (Auto-Start Swarm Protocol section, STEP 2) |
| **ruflo dual-mode pipelines** | Pre-built `feature` template = `Architect → Coder → Tester → Reviewer` | Cross-platform workflow: `🔵 Architect → 🟢 Coder → 🔵 Tester → 🟢 Reviewer` | `references/agent-orchestration/ruflo/CLAUDE.md` (Collaboration Templates section) |
| **superpowers (Obra)** | `subagent-driven-development` skill defines 3 prompts: implementer, spec-reviewer, code-quality-reviewer | Implementer: `"You are implementing Task N: [task name]"` / Spec reviewer: `"You are reviewing whether an implementation matches its specification."` / Quality reviewer: uses `superpowers:code-reviewer` template. **No designer role.** | `references/agent-tools/superpowers/skills/subagent-driven-development/implementer-prompt.md:7`, `spec-reviewer-prompt.md:11`, `code-quality-reviewer-prompt.md:10` |
| **superpowers code-reviewer agent** | Generic senior reviewer | `"You are a Senior Code Reviewer with expertise in software architecture, design patterns, and best practices. Your role is to review completed project steps against original plans and ensure code quality standards are met."` | `references/agent-tools/superpowers/agents/code-reviewer.md:8` |
| **claude-howto/04-subagents** | `implementation-agent` | `"You are a senior developer implementing features from specifications."` Tools: `Read, Write, Edit, Bash, Grep, Glob` | `references/agent-tools/claude-howto/04-subagents/implementation-agent.md:9, 4` |
| **claude-howto/04-subagents** | `code-reviewer` | `"You are a senior code reviewer ensuring high standards of code quality and security."` Tools: `Read, Grep, Glob, Bash` | `references/agent-tools/claude-howto/04-subagents/code-reviewer.md:9, 4` |
| **claude-howto/04-subagents** | `data-scientist` (closest to a domain specialist analogue) | `"You are a data scientist specializing in SQL and BigQuery analysis."` Tools: `Bash, Read, Write` | `references/agent-tools/claude-howto/04-subagents/data-scientist.md:9, 4` |
| **claude-howto/04-subagents inventory** | 7 ready-made specialists | code-reviewer, test-engineer, documentation-writer, secure-reviewer, implementation-agent, debugger, data-scientist. **Zero UI/visual/design specialists.** | `references/agent-tools/claude-howto/04-subagents/README.md:898-1010` |
| **clawteam (HKUDS)** | Generic CLI swarm — agent role taxonomy not declared in README. Templates exist but undocumented at this level. | `"agents spawn swarms, delegate tasks, and deliver results. Human provides the goal. The Agent Team orchestrates everything else."` Documented use cases: AI Research Automation, Agentic Engineering, Open Source Dev. No designer slot in showcased scenes. | `references/agent-orchestration/clawteam/README.md:24, 42-78` |
| **cc-wf-studio (CC Workflow Studio)** | VSCode visual editor for sub-agent workflows. 7 node types: `Start, End, Prompt, SubAgent, AskUserQuestion, IfElse, Switch`. `SubAgent` node is generic — no typed designer role. | `"all 7 node types (Start, End, Prompt, SubAgent, AskUserQuestion, IfElse, Switch) are documented with complete field specifications"` | `references/agent-tools/cc-wf-studio/specs/001-ai-workflow-generation/spec.md:42` |
| **prompt-master** | Identity prompt for prompt engineer (meta-tool) | `"You are a prompt engineer. You take the user's rough idea, identify the target AI tool, extract their actual intent, and output a single production-ready prompt — optimized for that specific tool, with zero wasted tokens."` Not a multi-agent role; single-prompt LLM persona. | `references/agent-tools/prompt-master/SKILL.md:9-15` |

### Negative-space conclusion

A "designer" agent does not exist as a first-class role in any inspected orchestration framework. The convergent taxonomy across ruflo, claude-howto, superpowers, and the dual-mode pipelines is:

```
{architect | system-architect}  →  {coder | implementer}  →  {tester}  →  {reviewer}
```

EG-Desk's `design-agent` is therefore **inventing a role** that has no precedent in the surveyed ecosystem. The closest analogues are:
1. **architect** (ruflo) — declarative `system-design + api-design + documentation` capabilities
2. **data-scientist** (claude-howto) — domain specialist with narrow tool grant (`Bash, Read, Write`) and explicit "Output Format" template
3. **research-specialist** (deepagentsjs hierarchical example) — domain agent with sub-agents of its own

---

## 3. Input/Output Contracts (closest analogues to designer pipeline)

| System | Role | Input | Output |
|---|---|---|---|
| **agent-orchestrator** | orchestrator | GitHub/Linear issue ID; PR state; CI status; user `ao send` messages | Spawn decisions (`ao spawn`, `ao batch-spawn`); coordination instructions to workers; never code or PRs |
| **agent-orchestrator** | worker | Issue context, branch, agent rules from `agent-orchestrator.yaml`, `agentRulesFile`, dedupe markers | Code commits, PR (one PR per session), CI fixes, response to review comments |
| **deepagentsjs** | subagent (any role) | Single string prompt from parent (no inherited messages, todos, structuredResponse, skillsMetadata, memoryContents) | A SINGLE final message; optional `responseFormat` produces structured JSON via `toolStrategy`/`providerStrategy` |
| **deepagentsjs hierarchical** | research-specialist (sub-DeepAgent) | Topic string from main agent | Synthesized summary string after using `get_news → analyze_data → fact-checker (sub-sub)` chain |
| **paperclip** | hired agent (any role) | Heartbeat trigger (schedule, assignment, comment, manual, approval-resolution); assigned issue with parent issue chain back to company goal | Issue status updates (`backlog → todo → in_progress → in_review → done`); comments on issues; hire requests for subordinates (gated by board approval) |
| **superpowers implementer** | implementer subagent | `## Task Description` (full text pasted, NOT file path), `## Context` (scene-setting/dependencies/architectural context), working directory, code organization rules | Status (`DONE`/`DONE_WITH_CONCERNS`/`BLOCKED`/`NEEDS_CONTEXT`) + what implemented + tests/results + files changed + self-review findings + concerns |
| **superpowers spec-reviewer** | spec compliance reviewer subagent | `## What Was Requested` (FULL TEXT of task requirements) + `## What Implementer Claims They Built` (from implementer's report) | Either `✅ Spec compliant` OR `❌ Issues found: [missing or extra, with file:line references]` |
| **superpowers code-quality-reviewer** | code quality reviewer subagent | `WHAT_WAS_IMPLEMENTED`, `PLAN_OR_REQUIREMENTS`, `BASE_SHA`, `HEAD_SHA`, `DESCRIPTION` | Strengths, Issues (Critical/Important/Minor), Assessment |
| **claude-howto code-reviewer** | code-reviewer subagent | Recent git diff, modified files | Per-issue: Severity, Category, Location (file:line), Issue Description, Suggested Fix (code example), Impact. Organized by Critical/Warnings/Suggestions |
| **claude-howto implementation-agent** | implementation-agent | Requirements + existing code patterns + project structure | Files Created (list), Files Modified (list), Tests Added (paths), Build Status (Pass/Fail), Notes |
| **claude-howto data-scientist** | data-scientist | Data analysis question | Objective, Query (SQL with comments), Results, Insights, Recommendations |
| **ruflo architect** | architect agent | Task description + memory namespace | System design stored in memory; "design decisions" written to shared collaboration namespace |
| **ruflo dual-mode feature template** | architect → coder → tester → reviewer | Each stage reads previous stage output from `collaboration` memory namespace | Each stage writes its artifact (design / code / tests / review findings) to the same namespace |

### Designer-specific pattern: not found

No system in scope defines:
- Designer input as user stories / specs / requirements
- Designer output as HTML / React / design tokens / Figma frames / screenshots
- Designer-to-coder handoff contract (what the coder receives from a designer)

---

## 4. Handoff Patterns

### Upstream (planner → designer/architect)
| System | Pattern | Citation |
|---|---|---|
| **superpowers SDD** | Plan → Controller extracts ALL tasks with FULL TEXT → Controller spawns implementer with task text + scene-setting context. **Implementer never reads the plan file** — controller curates exactly what context is needed. Controller asks subagent questions before they begin. | `subagent-driven-development/SKILL.md:215-219`, `implementer-prompt.md:18-28` |
| **agent-orchestrator** | Tracker (GitHub/Linear) → Issue → orchestrator session reads metadata via `ao status` → spawns worker via `ao spawn INT-1234` (worker is launched with "context about the issue" — see `orchestrator-prompt.ts:106`) | `orchestrator-prompt.ts:100-107` |
| **paperclip** | CEO creates strategy (board-approved) → CEO breaks goals into tasks → CEO assigns tasks based on agent role/capabilities → CEO can request to hire new agents (board-approved) → atomic issue checkout (one agent at a time, 409 Conflict on race) | `paperclip/docs/start/core-concepts.md:55-62, 51` |
| **ruflo** | Hierarchical coordinator (Queen) → spawns Researcher, Architect, Coder, Tester, Reviewer in ONE message via Task tool. Researcher's findings stored in memory, Architect reads them | `ruflo/CLAUDE.md` Auto-Start Swarm Protocol (STEP 2) |
| **deepagentsjs** | Main agent's LLM planner decides whether to invoke subagent vs. tool directly. Subagent spawned via `task` tool with explicit role/instructions/expected-output fields | `deepagentsjs/libs/deepagents/src/middleware/subagents.ts:188-216` (TASK_SYSTEM_PROMPT) |

### Downstream (designer/architect → coder)
| System | Pattern | Citation |
|---|---|---|
| **ruflo dual-mode** | Architect (Claude) writes design to `collaboration` memory namespace → Coder (Codex) reads from same namespace. Worker dependency levels enforced: `Level 0: [Architect] → Level 1: [Coder, Tester] → Level 2: [Reviewer] → Level 3: [Optimizer]` | `ruflo/CLAUDE.md` Worker Dependency Levels |
| **agent-orchestrator** | Orchestrator never writes code. **Hard rule** (verbatim): `"The orchestrator session must never own a PR. Never claim a PR into the orchestrator session, and never treat the orchestrator as the worker responsible for implementation."` Spawning a worker session = handoff. | `orchestrator-prompt.ts:36, 30` |
| **superpowers SDD** | NO handoff between specialized agents. **Single implementer subagent does the entire task** (impl + test + commit + self-review). Reviewers come AFTER, not in parallel. Two-stage review: spec compliance first, THEN code quality. | `subagent-driven-development/SKILL.md:35-39, 247` |
| **deepagentsjs** | Each subagent is **stateless and ephemeral**. No persistent context, no inter-subagent communication. Result returned as a SINGLE message. Parent reconciles. `EXCLUDED_STATE_KEYS = ["messages", "todos", "structuredResponse", "skillsMetadata", "memoryContents"]` | `deepagentsjs/libs/deepagents/src/middleware/subagents.ts:45-51, 200-204` |
| **paperclip** | Issue assignment (one agent at a time) is the handoff mechanism. State transitions via issue status. No direct agent-to-agent message passing — all communication is through issue comments and status changes. | `paperclip/docs/start/core-concepts.md:42-51` |

### Critical handoff design choices observed

1. **Stateless ephemeral subagents** (deepagentsjs, claude-howto subagents, superpowers) — parent must construct EVERYTHING the subagent needs. No inheritance.
2. **Single PR ownership** (agent-orchestrator) — one worker session = one PR. Coordinator never owns code.
3. **Shared memory namespace** (ruflo dual-mode) — workers read/write to common namespace; orchestrator does not pass messages between them.
4. **Issue-based handoff** (paperclip) — no direct agent-to-agent comm; everything flows through issue lifecycle.
5. **Atomic checkout** (paperclip) — race conditions handled with 409 Conflict; one agent owns a task at a time.
6. **Implementer + reviewers, not implementer + planner + tester** (superpowers) — superpowers consciously rejects multi-stage upfront pipelines in favor of single-implementer + 2-stage post-hoc review.

---

## 5. Review / Feedback Loops

| System | Loop pattern | Citation |
|---|---|---|
| **superpowers SDD (canonical 2-stage review)** | After implementer reports DONE → spec reviewer (verifies match against spec, returns ✅/❌) → if ❌, implementer (same subagent) fixes → spec reviewer re-reviews → only after spec ✅ → code quality reviewer → if issues, implementer fixes → code reviewer re-reviews → loop until ✅. **Never mix the two review stages — spec compliance first, then quality.** | `subagent-driven-development/SKILL.md:42-85, 247` |
| **superpowers SDD critical rule** | Verbatim: `"Start code quality review before spec compliance is ✅ (wrong order)"` listed as forbidden | `subagent-driven-development/SKILL.md:247` |
| **superpowers spec-reviewer** | **Distrust protocol**: `"DO NOT: Take their word for what they implemented / Trust their claims about completeness / Accept their interpretation of requirements. DO: Read the actual code they wrote / Compare actual implementation to requirements line by line / Check for missing pieces they claimed to implement / Look for extra features they didn't mention"` | `spec-reviewer-prompt.md:23-37` |
| **agent-orchestrator** | **Reaction-based feedback loop**: events from SCM (CI failed, changes requested, approved+green, agent stuck) auto-route messages to worker via `ao send`. Configurable per project: `auto: true / action: send-to-agent / retries: 2 / escalateAfter: 30m`. Human only intervenes when escalation threshold hit. | `agent-orchestrator.yaml.example:130-150`, `orchestrator-prompt.ts:208-218` |
| **agent-orchestrator** | Lifecycle state machine: `spawning → working → pr_open → ci_failed/review_pending → changes_requested/approved → mergeable → merged → cleanup → done`. CI/review feedback is structural, not ad-hoc messaging. | `agent-orchestrator/CLAUDE.md` Session Lifecycle |
| **agent-orchestrator** | **Two-stage spec-reviewer-style enforcement** in feedback routing: optional subagent/skill can RECOMMEND decisions but cannot EXECUTE SCM mutations. Side effects stay deterministic in orchestrator control code. | `feedback-routing-and-followup-design.md:14-17` |
| **paperclip** | Feedback flows through issue comments + governance approvals. Hire requests, CEO strategy = explicit board approval. Status `in_review` is a discrete lifecycle state. | `paperclip/docs/start/core-concepts.md:42-46, 79-86` |
| **paperclip** | Heartbeat-driven: agent doesn't run continuously. Triggered by Schedule, Assignment, Comment (@-mention), Manual, or Approval-resolution. Each heartbeat: identity check → review assignments → pick work → atomic checkout → execute → status update. | `paperclip/docs/start/core-concepts.md:65-76` |
| **deepagentsjs** | **No native review loop**. Subagents are one-shot — return single message and die. Loop must be implemented at parent level. Subagent cannot communicate mid-task. | `deepagentsjs/libs/deepagents/src/middleware/subagents.ts:73 (point 3)` |
| **ruflo Worker Dependency Levels** | Levels enforce sequencing: Architect (L0) → Coder+Tester (L1) → Reviewer (L2) → Optimizer (L3). Reviewer approval gates Optimizer. No native rework loop documented at the framework level. | `ruflo/CLAUDE.md` Worker Dependency Levels |
| **ruflo hooks** | `pre-task`/`post-task`/`teammate-idle`/`task-completed` hooks fire on lifecycle transitions. `train-patterns true` flag turns successful runs into reusable patterns. Self-learning loop is at the platform level, not per-task. | `ruflo/CLAUDE.md` Essential Hook Commands |
| **claude-howto code-reviewer** | **Proactive auto-invocation**: includes `Use PROACTIVELY` in description so Claude auto-delegates after code changes. `When invoked: 1. Run git diff to see recent changes / 2. Focus on modified files / 3. Begin review immediately`. Output: per-issue Severity/Category/Location/Issue/Fix/Impact. | `claude-howto/04-subagents/code-reviewer.md:3, 12-15` |

### Handoff/feedback pattern matrix (visual review specifically)

**None** of the systems define a "visual review feedback loop" (e.g., screenshot → comparison → designer fixes). The closest pattern is superpowers' spec-reviewer "distrust protocol" — read the actual artifact (code), compare line by line against requirements, never trust the implementer's claims. **This pattern is directly portable to a visual review loop**: instead of "read the code", "open the screenshot", instead of "line by line against requirements", "pixel/region against design spec", instead of "trust the implementer", "trust the rendered artifact, not the implementer's description".

---

## 6. Orchestration Primitives Applicable to EG-Desk

EG-Desk's model from `.claude/wm/project-profile.md §7`:
- **Session Lead** (root) — coordinates with user, spawns teams
- **WM (wm-agent)** — file-level intelligence, persistent
- **Sprint Leader** — task coordinator chosen by `/compose-team`
- **Worker** — concrete task executor (coding-agent, design-agent, etc.)

| Pattern | Source | Direct fit / Needs adaptation / Incompatible | Reasoning |
|---|---|---|---|
| **Orchestrator/worker session-role split** (orchestrator never owns code, never owns PR) | agent-orchestrator | **Direct fit** | Maps cleanly to Session Lead (orchestrator) vs. workers. Already in EG-Desk's CLAUDE.md: "Session Lead은 sprint-leader하고만 소통" mirrors `"orchestrator session-role"` constraint. Adopt the verbatim hard rule: design-agent must NEVER implement Electron production code itself; it produces design artifacts (HTML mocks/Figma frames/screenshots) and hands off to a coding-agent worker. |
| **Hard rule: read-only investigation from coordinator** | agent-orchestrator orchestrator-prompt.ts:34 | **Direct fit** | Verbatim: `"Investigations from the orchestrator session are read-only. Inspect status, logs, metadata, PR state, and worker output, but do not edit repository files or implement fixes from the orchestrator session."` Apply to design-agent as: design-agent investigates user requirements / existing screens / brand context but does not directly modify production renderer code. |
| **Two-stage reviewer (spec compliance → code quality)** | superpowers SDD | **Direct fit, with substitution** | EG-Desk equivalent: **(1) design-spec compliance reviewer** (does the rendered screen match DESIGN_SYSTEM_SPEC.md and the requested wireframe?) → **(2) visual quality reviewer** (does it look good — alignment, hierarchy, breathing room, ontology bridge enforcement?). Order matters — never run aesthetic review before spec compliance is ✅. |
| **Spec reviewer "distrust protocol"** | superpowers spec-reviewer-prompt.md:23-37 | **Direct fit** | "Do not trust the design-agent's claim that 'I built the Desk Rail'. OPEN THE SCREENSHOT. Compare to DESIGN_SYSTEM_SPEC §7-1 line by line. Look for missing elements (Cmd+K trigger position, frosted glass blur radius, traffic light spacing) and extras (drop shadows the spec didn't ask for)." |
| **Implementer status taxonomy** (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT) | superpowers implementer-prompt.md:103 | **Direct fit** | Adopt verbatim. Designer reports `DONE_WITH_CONCERNS` when they hit ambiguity in spec (e.g., "Section 7-1 says 60-70% width — I picked 65%, but this conflicts visually with the 7-3 Preset Bag at 280px expanded — flagging"). |
| **Self-review checklist before reporting** | superpowers implementer-prompt.md:75-98 | **Direct fit, with substitution** | Designer self-review categories: **Completeness** (all spec sections rendered?), **Quality** (does it look intentional? names/labels accurate?), **Discipline** (avoided overdesigning beyond spec?), **Testing** (screenshot captured? does it actually render in the target environment?). |
| **No mid-session subagent communication, single final message return** | deepagentsjs subagents.ts:73 | **Direct fit** | EG-Desk's design-agent should return a SINGLE structured artifact per dispatch: `{status, what_designed, files_created, screenshot_paths, concerns, self_review_findings}`. No back-and-forth chatter — sprint-leader curates context upfront and waits for the final report. |
| **Parent constructs context, subagent never inherits parent state** | deepagentsjs subagents.ts:45-51, 220-222 | **Direct fit** | Sprint-leader/Session Lead should paste FULL TEXT of relevant DESIGN_SYSTEM_SPEC sections + screenshot of current state into design-agent's prompt. Do not tell design-agent "read DESIGN_SYSTEM_SPEC.md" — quote the relevant edges/sections directly. Mirrors superpowers rule `"Make subagent read plan file (provide full text instead)"` → forbidden. |
| **Reaction-based feedback routing** (agent-stuck after N min → notify human; ci-failed → auto-resend) | agent-orchestrator yaml `reactions:` block | **Needs adaptation** | EG-Desk has no equivalent of CI/PR/SCM, but the *pattern* is reusable: define structural reactions for design-agent. Examples: `design-stuck after 10m → notify Session Lead`, `screenshot-mismatch → auto-resend with diff annotation`, `spec-violation → escalate to PM agent`. Build into compose-team or hooks. |
| **Lifecycle state machine** | agent-orchestrator session lifecycle | **Needs adaptation** | A design-agent task could have states: `briefing → designing → screenshot_captured → spec_review → quality_review → revisions → approved → done`. Useful for WM tracking and Session Lead orchestration. |
| **Heartbeat-triggered execution** | paperclip core-concepts.md:65-76 | **Incompatible** | EG-Desk uses on-demand spawning via Session Lead, not scheduled heartbeats. Paperclip's model assumes long-running agent processes. EG-Desk subagents are ephemeral (Claude Code subagent model). |
| **Atomic issue checkout (one agent at a time, 409 on race)** | paperclip core-concepts.md:51 | **Needs adaptation** | EG-Desk's spawn protocol already enforces single-Session-Lead spawn authority. Pattern is more relevant to file-level locking — apply via WM: when design-agent is editing a screen file, mark it as "in_progress by design-agent-N" in file-map.json so a parallel worker doesn't conflict. |
| **Org chart with strict reportsTo chain** | paperclip core-concepts.md:30 | **Direct fit** | Already matches EG-Desk: Worker → Sprint Leader → Session Lead → User. Designer specifically: design-agent reports to sprint-leader only (per template). Adopt paperclip's verbatim phrase: "Every employee reports to exactly one manager". |
| **Hire-with-board-approval governance** | paperclip-create-agent SKILL.md | **Incompatible (overkill)** | EG-Desk uses `/agent-factory` skill — no governance/approval needed for project-level templates. User-level agent creation requires user approval (already in CLAUDE.md) which is the lightweight equivalent. |
| **Dispatch-parallel-agents pattern** (3+ independent failures → parallel dispatch) | superpowers dispatching-parallel-agents/SKILL.md | **Direct fit** | If design-agent needs to mock 3 independent screens (e.g., Desk Rail HUD, Dock, Preset Bag), Session Lead spawns 3 design-agent instances in parallel via background dispatch (already in EG-Desk CLAUDE.md). Apply superpowers rule: "Don't dispatch multiple implementation subagents in parallel (conflicts)" — but parallel design dispatch is OK if outputs go to different files. |
| **Worker dependency levels** | ruflo CLAUDE.md Worker Dependency Levels | **Direct fit** | EG-Desk equivalent: `Level 0: design-agent → Level 1: coding-agent (Electron impl) → Level 2: visual-test-agent (Playwright screenshot diff) → Level 3: review aggregator`. Already implicit in EG-Desk's phase-based spawn protocol. |
| **Pre-built collaboration templates** (`feature`, `security`, `refactor`, `bugfix`) | ruflo CLAUDE.md Collaboration Templates | **Needs adaptation** | EG-Desk could ship templates: `screen-design` (design-agent → coding-agent → visual-test-agent → reviewer), `screen-revision` (visual-test-agent → design-agent → coding-agent), `design-system-update` (design-agent → coding-agent for tokens → visual-test-agent across all affected screens). |
| **YAML role-specific agent overrides** (different model/permissions per role) | agent-orchestrator yaml.example:77-86 | **Needs adaptation** | EG-Desk could allow design-agent to use a different model than coding-agent (e.g., design-agent uses opus for visual reasoning, coding-agent uses sonnet for speed). Already supported via individual `.claude/agents/*.md` frontmatter. |
| **TASK_SYSTEM_PROMPT lifecycle** ("Spawn → Run → Return → Reconcile") | deepagentsjs subagents.ts:200-205 | **Direct fit (rename)** | Use these 4 verbs verbatim in design-agent dispatch documentation. Already implicit in EG-Desk, but explicit naming clarifies expectations. |
| **Skills inheritance: custom subagents do NOT inherit main agent's skills (only general-purpose does)** | deepagentsjs subagents.ts:294-297 | **Direct fit** | Mirrors EG-Desk's project-level vs. user-level agent split. Design-agent should only get skills explicitly listed (e.g., `figma-mcp`, `playwright-screenshot`), not inherit Session Lead's full skill set. |
| **Backgroundable subagents with background-permission constraint** | claude-howto/04-subagents README §Background | **Direct fit** | EG-Desk already uses `run_in_background: true` for parallel dispatch. Add: when design-agent runs in background, pre-approve permissions for screenshot capture and Figma MCP — don't fire interactive permission prompts. |
| **Agent Teams: shared task list + mailbox + team lead** | claude-howto/04-subagents README §Agent Teams | **Direct fit** | This IS the EG-Desk model (Session Lead + sprint-leader + workers). Adopt the comparison table phrase verbatim: "Subagents (delegate, fresh context, return value) vs Agent Teams (independent, persistent context, mailbox)." design-agent runs as a team member, not a subagent — reports via SendMessage, not return value. |
| **Co-located shared collaboration memory namespace** | ruflo dual-mode CLAUDE.md | **Needs adaptation** | EG-Desk's `.claude/agent-memory/{name}/` is per-agent. Adding a shared `collaboration` namespace at the team level would let design-agent and coding-agent share context (e.g., "design-agent decided 64px corner radius for HUD cards, coding-agent uses this in CSS variable"). Currently this would go through Sprint Leader as broker. |
| **Lemmas for designer prompts: explicit target tool, explicit output format, no prompt-engineering theory** | prompt-master SKILL.md:9-15 | **Direct fit** | When dispatching design-agent, the prompt MUST specify: target rendering environment (Figma frame? React component? HTML mockup? screenshot for review?), output format (file paths? Figma URLs? base64 PNG?), and edge constraints from DESIGN_SYSTEM_SPEC. Avoid telling design-agent "be creative" — tell it exactly what artifact to produce. |

### Score summary

- **Direct fit**: 14 patterns
- **Needs adaptation**: 7 patterns
- **Incompatible**: 2 patterns

### Top 5 highest-leverage adoptions for design-agent.md refactor

1. **Two-stage reviewer pattern (spec compliance → visual quality), in that order, never mixed** — superpowers SDD. This is the single biggest gap in EG-Desk's current design-agent.md (which has no review loop at all).
2. **Hard rule: design-agent never owns production renderer code** — agent-orchestrator orchestrator/worker split. Forces a clean handoff to coding-agent and prevents the design-agent from drifting into implementation work.
3. **Status taxonomy (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT) + self-review checklist before reporting** — superpowers implementer pattern. Directly portable; replaces implicit "I'm done" reporting.
4. **Distrust protocol for visual review** — superpowers spec-reviewer. The reviewer must open the screenshot/Figma frame and verify against the spec line by line, not trust the design-agent's claim.
5. **Parent constructs context — subagent never reads spec files itself** — deepagentsjs + superpowers convergent rule. Sprint-leader pastes the relevant DESIGN_SYSTEM_SPEC sections into the design-agent's prompt verbatim, never tells it "read the spec".

### Critical insight (negative space)

**No external system has solved "designer agent" at all.** The architect/coder/reviewer trinity is universal across orchestration frameworks because all surveyed frameworks were built for *backend/library code generation*. EG-Desk is in novel territory by trying to create a UI/UX visual designer agent. The right strategy is therefore to **steal structural primitives** (handoff contracts, review loops, status taxonomies, distrust protocols) from the surveyed systems and apply them to a brand-new role definition that has no upstream precedent. **Do not try to find a designer-shaped template to copy** — there isn't one. Instead, build the role from first principles using the ontology in EG-Desk's own DESIGN_SYSTEM_SPEC.md and ontology-bridge.md, and wire it into the orchestration with proven primitives.

---

## 7. Verbatim quotes worth preserving in design-agent.md refactor

| Source | Quote | Use in design-agent.md |
|---|---|---|
| agent-orchestrator orchestrator-prompt.ts:34 | `"Investigations from the orchestrator session are read-only. Inspect status, logs, metadata, PR state, and worker output, but do not edit repository files or implement fixes from the orchestrator session."` | Adapt as: "design-agent investigates the spec, current state, and reference materials but does not modify production renderer code. Implementation handoff goes to coding-agent." |
| superpowers SDD SKILL.md:35-39 | `"Fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration"` | Use as principle headline for design-agent's review loop |
| superpowers SDD SKILL.md:247 | `"Start code quality review before spec compliance is ✅ (wrong order)"` | Add as a hard rule: never aesthetic-review before spec-review passes |
| superpowers spec-reviewer-prompt.md:23-37 | `"DO NOT: Take their word for what they implemented / Trust their claims about completeness... DO: Read the actual code they wrote / Compare actual implementation to requirements line by line"` | Translate to: "DO NOT trust design-agent's verbal report. DO open the screenshot and compare to DESIGN_SYSTEM_SPEC line by line." |
| deepagentsjs subagents.ts:73 (TASK_SYSTEM_PROMPT) | `"Each agent invocation is stateless. You will not be able to send additional messages to the agent... your prompt should contain a highly detailed task description for the agent to perform autonomously"` | Sprint Leader's contract: design-agent gets one shot, full context, single return |
| superpowers SDD SKILL.md:241-242 | `"Make subagent read plan file (provide full text instead) / Skip scene-setting context (subagent needs to understand where task fits)"` | Forbidden patterns when dispatching design-agent |
| paperclip core-concepts.md:30 | `"Every agent reports to exactly one manager (except the CEO). This chain of command is used for escalation and delegation."` | Reinforces design-agent reports to sprint-leader only |
| superpowers implementer-prompt.md:57-72 | `"It is always OK to stop and say 'this is too hard for me.' Bad work is worse than no work. You will not be penalized for escalating."` | Critical for visual design where stuck-and-pretending is worse than escalating |

---

## 8. Files Created

- `/Users/minsoocha/Projects/EG-Desk-Dev-Space/subagent_reports/20260410_explorer-3-orchestrator-blueprints_designer_prompt_patterns.md`

`files_created: ["/Users/minsoocha/Projects/EG-Desk-Dev-Space/subagent_reports/20260410_explorer-3-orchestrator-blueprints_designer_prompt_patterns.md"]`
