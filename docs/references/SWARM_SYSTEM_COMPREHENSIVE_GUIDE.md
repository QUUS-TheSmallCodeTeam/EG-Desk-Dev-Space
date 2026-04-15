# EG-DESK Dev-Space: Swarm System Comprehensive Guide

**Created**: 2026-02-06 | **Consolidated from**: 6 Agent Team reports + system docs analysis

---

## Table of Contents

1. [Dev-Space Overview](#1-dev-space-overview)
2. [Entity Model](#2-entity-model)
3. [System Architecture](#3-system-architecture)
4. [Folder Structure & File Lifecycle](#4-folder-structure--file-lifecycle)
5. [7 Workflow Branches](#5-seven-workflow-branches)
6. [Agent Inventory & Capabilities](#6-agent-inventory--capabilities)
7. [Platform Constraints](#7-platform-constraints)
8. [Critical Bugs](#8-critical-bugs)
9. [Proposed Improvements](#9-proposed-improvements)
10. [Phase 0-3 Action Plan](#10-phase-0-3-action-plan)
11. [Open Questions](#11-open-questions)

---

## 1. Dev-Space Overview

EG-DESK-Dev-Space is a **research/planning/tooling workspace** -- NOT the application itself. It contains vision documents, external references (18+ projects), feature ideas/PRDs, agent definitions, and swarm orchestration docs. The `src/` directory currently holds only `CODEBASE_STRUCTURE.md`.

```
EG-DESK-Dev-Space     =/=     EG-DESK Application
   (this repo)                 (future: eg-desk/ subdirectory)

+---------------------------+     +----------------------------+
| Planning & Orchestration  |     | Runtime Application Code   |
| - Agent definitions       |     | - Theia extension packages |
| - Vision docs             |     | - Electron integration     |
| - External references     |     | - Custom widgets           |
| - Feature PRDs            |     | - Build system             |
| - Swarm workflow docs     |     | - Test infrastructure      |
+---------------------------+     +----------------------------+
```

### What Lives Here

| Directory | Purpose | Lifecycle |
|-----------|---------|-----------|
| `.claude/agents/` | Agent definitions (YAML + instructions) | Permanent, version-controlled |
| `.claude/docs/` | Modular CLAUDE.md documentation | Permanent, version-controlled |
| `.claude/commands/` | Slash commands / skills | Permanent, hot-reloadable |
| `references/` | External repos + API docs (18+ projects) | Permanent, managed by `setup.sh` |
| `ideas/confirmed/` | PM-approved PRDs | Permanent |
| `ideas/brainstorming/` | Exploratory feature ideas | Semi-permanent |
| `docs/` | Project documentation, vision, production docs | Permanent |
| `subagent_reports/` | Temporary agent communication | **Deleted when user issue resolved** |
| `setup.sh` / `setup.bat` | Reference repo management | Permanent |

---

## 2. Entity Model

Four distinct entities interact in the swarm system. Each has different authority, tools, and responsibilities.

```
+============================================================+
|                        USER (Human)                         |
|  Authority: Final decision-maker on all strategic choices   |
|  Actions:   Request, Approve, Reject, Defer                |
|  Sees:      Main Thread output only (not internal reports)  |
+==============================|=============================+
                               |
                    requests / decisions
                               |
                               v
+============================================================+
|                  MAIN THREAD (Claude Code)                  |
|  Authority: Orchestrator, router, synthesizer               |
|  Tools:     ALL (Read, Write, Edit, Bash, Glob, Grep, etc) |
|  Actions:   Classify requests, invoke agents, read reports, |
|             synthesize findings, present to user, cleanup   |
|  State:     Session-persistent (compactable)                |
+==|====================|===================|================+
   |                    |                   |
   v                    v                   v
+===============+  +==============+  +==================+
| PM AGENT      |  | FRAMEWORK    |  | EXECUTION AGENTS |
| (Strategic)   |  | AGENTS       |  | (Implementation) |
|               |  | (Analysis)   |  |                  |
| - Vision      |  | - Theia      |  | - coding-agent   |
|   alignment   |  | - Electron   |  | - ux-flow-sim    |
| - PRD creation|  |              |  | - test-strategy* |
| - Tech stack  |  | Read-heavy,  |  | - runtime-test*  |
|   management  |  | code analysis|  |                  |
|               |  |              |  | Write/Execute    |
| Read + Write  |  | Read + Bash  |  | capabilities     |
+===============+  +==============+  +==================+

  * = proposed (not yet created)
```

### Entity Separation Rules

| Entity | Creates Files | Reads Files | Modifies Code | Makes Decisions |
|--------|:---:|:---:|:---:|:---:|
| **User** | - | - | - | Strategic: approve/reject/defer |
| **Main Thread** | Reports (for built-in agents) | Everything | Via coding-agent | Classification, agent selection |
| **PM Agent** | PRDs, reports, brainstorming docs | Vision docs, tech stack | technology-stack.md | Strategic recommendations only |
| **Framework Agents** | Reports (via Bash*) | Framework source code | Never | Technical analysis only |
| **Coding Agent** | Source code, reports | Target + connected files | Direct Write/Edit | None (follows instructions) |

\* See [Critical Bugs](#8-critical-bugs) -- Write tool mismatch

---

## 3. System Architecture

### High-Level Data Flow

```
                          +-----------+
                          |   USER    |
                          +-----+-----+
                                |
                    Request / Decision / Feedback
                                |
                                v
+---------------------------------------------------------------+
|                      MAIN THREAD                               |
|                                                                |
|  1. Classify request into Branch 1-5                           |
|  2. Invoke appropriate agent(s)                                |
|  3. Read report files                                          |
|  4. Synthesize & present to user                               |
|  5. Manage cleanup                                             |
|                                                                |
|  STATE: .claude/CLAUDE.md (instructions) + conversation context|
+---+--------+--------+--------+--------+--------+--------------+
    |        |        |        |        |        |
    v        v        v        v        v        v
 Branch1  Branch2  Branch3a Branch3b Branch4  Branch5
 Simple   Framework Consult  Implement Research Agent
 Question Question  PM       Full Flow Technology Creation
    |        |        |        |        |        |
    v        v        v        v        v        v
 [Direct]  [Theia/  [PM     [PM      [PM     [SDK
  Answer    Electron  Agent]  Agent    Agent    Analyzer
            Agent]            +Frame   +Parallel Agent]
                              Agent    Research
                              +Coding  +Analyzer
                              Agent    Agents]
                              +UX Sim]
    |        |        |        |        |        |
    v        v        v        v        v        v
 (none)  subagent_ subagent_ subagent_ subagent_ .claude/
         reports/  reports/  reports/  reports/  agents/
         (temp)    (temp)    (temp)    (temp)    (permanent)
                             ideas/    references/
                             confirmed/ [tech]/
                             (permanent)(permanent)
```

### Communication Protocol

```
+-------------------+     File-Based Protocol     +------------------+
|   MAIN THREAD     |<===========================>|    SUBAGENT      |
|                   |                              |                  |
| 1. Task(agent,    |  ---- invoke (prompt) ---->  | 1. Read task     |
|    prompt)        |                              | 2. Execute work  |
|                   |  <-- CREATE report file ---  | 3. Write report  |
| 2. Read report    |                              |                  |
|                   |  ---- Edit (add comment) ->  | 4. (multi-turn)  |
| 3. Add comment    |                              |    Read comment  |
|                   |  <-- UPDATE report file ---  |    Update report |
| 4. Re-read report |                              |                  |
|                   |                              |                  |
| 5. DELETE report  |  ---- rm report file ----->  | (session ends)   |
|    when resolved  |                              |                  |
+-------------------+                              +------------------+

Report naming: subagent_reports/YYYYMMDD_HHMM_[topic]-[agent-type].md
```

### Subagent vs Agent Teams (Hybrid Model)

```
+================================================================+
|                     MAIN THREAD (Lead)                          |
|                                                                 |
|  +-- SUBAGENTS (focused, repeatable) --+                        |
|  |   - Precise tool control (YAML)     |                        |
|  |   - Version-controlled definitions  |                        |
|  |   - File-based communication        |   +-- AGENT TEAMS --+  |
|  |   - Persistent memory possible      |   | (collaborative) |  |
|  |   - Fresh context per invocation    |   | - Real-time msg |  |
|  |   - Session recovery via reports    |   | - Shared tasks  |  |
|  |   - MCP: unreliable (known bugs)    |   | - MCP: better   |  |
|  |                                     |   | - Session-scoped|  |
|  |  USE FOR:                           |   | - No pre-config |  |
|  |  - Framework analysis               |   |                 |  |
|  |  - PM consultation                  |   | USE FOR:        |  |
|  |  - Code generation                  |   | - Research+debate|  |
|  |  - UX validation                    |   | - Architecture  |  |
|  |  - Quick research                   |   |   design        |  |
|  +-------------------------------------+   | - Code review   |  |
|                                             | - Debugging     |  |
|                                             +-----------------+  |
+================================================================+

Decision: Need precise tools? --> Subagent
          Need agents talking? --> Agent Team
          Need MCP reliably?  --> Agent Team (preferred)
          Need audit trail?   --> Subagent + file reports
```

---

## 4. Folder Structure & File Lifecycle

### Complete Directory Map

```
EG-Desk-Dev-Space/
|
+-- .claude/                           # Agent System (heart of swarm)
|   +-- CLAUDE.md                      # Main Thread instructions (entry point)
|   +-- agents/                        # Agent definitions
|   |   +-- egdesk-pm-agent.md         # Strategic gatekeeper
|   |   +-- theia-analyzer-agent.md    # Theia framework analysis
|   |   +-- electron-analyzer-agent.md # Electron framework analysis
|   |   +-- coding-agent.md            # Code implementation
|   |   +-- ux-flow-simulator-agent.md # UX validation
|   |   +-- swarm-team-agent.md        # Structure management
|   |   +-- claude-agent-sdk-analyzer-agent.md  # Agent creation
|   |   +-- gemini-cli-analyzer-agent.md        # Gemini CLI analysis
|   |   +-- infinite-canvas-analyzer-agent.md   # Canvas analysis
|   |   +-- [staging/]*                # (Proposed) Draft/testing agents
|   |   +-- [templates/]*             # (Proposed) Agent scaffolds
|   |   +-- [archive/]*              # (Proposed) Retired agents
|   |
|   +-- docs/                          # Modular documentation
|   |   +-- protocol.md               # File-based communication rules
|   |   +-- agent-capabilities.md     # Agent tool matrix
|   |   +-- pm-workflows.md           # PM consultation/implementation
|   |   +-- research-workflows.md     # Research: integration vs study
|   |   +-- parallel-delegation.md    # Parallel agent spawning
|   |   +-- organization.md           # Folder structure rules
|   |
|   +-- commands/                      # Slash commands (hot-reloadable)
|   |   +-- codebase-check.md         # File length + structure validation
|   |   +-- my-workflow.md
|   |
|   +-- prompts/                       # Pseudo-agent instructions
|   |   +-- agent-orchestration.md
|   |
|   +-- config.json                    # MAX_OUTPUT_TOKENS=64000
|   +-- settings.local.json
|
+-- references/                        # External Codebases & Docs
|   +-- theia/                         # Eclipse Theia (main framework)
|   +-- brave/                         # Brave browser
|   +-- electron-playwright-integration/
|   +-- memori/ , memvid/             # Memory systems
|   +-- openmetadata/
|   +-- puppeteer-in-electron/
|   +-- claude-code/                   # Claude Code reference
|   +-- egdesk-scratch/                # EG-DESK prototype
|   +-- ai-cli-integration/
|   +-- infinite-canvas/
|   +-- ... (18+ projects)
|   (Each has: online_references.md + optional cloned repo)
|
+-- ideas/                             # Feature Planning
|   +-- confirmed/                     # PM-approved PRDs
|   |   +-- technology-stack.md        # Tech stack decisions
|   |   +-- CONTEXT_AWARE_BROWSER_AUTOMATION.md
|   |   +-- UNIFIED_BROWSER_AUTOMATION_API.md
|   |
|   +-- brainstorming/                 # Exploratory ideas
|       +-- APP_RUNTIME_ARCHITECTURE.md
|
+-- docs/                              # Project Documentation
|   +-- production/
|   +-- vision/
|   +-- references/                    # <-- THIS GUIDE LIVES HERE
|   +-- README.md
|
+-- subagent_reports/                  # TEMPORARY Agent Reports
|   +-- (files created and deleted per workflow)
|
+-- setup.sh / setup.bat               # Reference repo management
+-- .mcp.json                          # MCP server config
+-- .gitignore
```

\* = proposed, not yet created

### File Lifecycle Matrix

```
+--------------------+-----------+---------------------------+-----------+----------------+
| File Type          | Created By| Location                  | Lifecycle | Cleanup Trigger|
+--------------------+-----------+---------------------------+-----------+----------------+
| Subagent report    | Agent/MT  | subagent_reports/         | TEMPORARY | User resolved  |
| PRD                | PM Agent  | ideas/confirmed/          | PERMANENT | Never deleted  |
| Brainstorming idea | PM Agent  | ideas/brainstorming/      | SEMI-PERM | Promoted/stale |
| Technology stack   | PM Agent  | ideas/confirmed/tech*.md  | PERMANENT | Updated only   |
| Online references  | PM/MT     | references/*/online_*.md  | PERMANENT | Updated only   |
| Cloned repos       | setup.sh  | references/*/[name]/      | PERMANENT | Reclone via sh |
| Agent definitions  | SDK Agent | .claude/agents/*.md       | PERMANENT | Manual only    |
| Prompt files       | MT        | .claude/prompts/*.md      | PERMANENT | No cleanup def |
| Source code        | Coding Ag | eg-desk/*/                | PERMANENT | Git tracked    |
| setup.sh/bat       | PM/MT     | root                      | PERMANENT | Updated only   |
+--------------------+-----------+---------------------------+-----------+----------------+
```

---

## 5. Seven Workflow Branches

### Master Flow Diagram

```
                             USER REQUEST
                                  |
                                  v
                    +---------------------------+
                    |   MAIN THREAD CLASSIFIER  |
                    |   (Automatic, rule-based)  |
                    +--+--+--+--+--+--+--------+
                       |  |  |  |  |  |
          +------------+  |  |  |  |  +----------+
          |     +---------+  |  |  +------+       |
          v     v            v  v         v       v
      Branch1 Branch2    Branch3      Branch4   Branch5
      Simple  Framework  PM-Driven    Research  Agent
      Q&A     Analysis   Workflow     Tech      Creation
                           |  |         |  |
                          3a  3b       4A  4B
                        Consult Impl  Integ Study
                           |    |       |
                           v    v       v
                         [User decides] [User decides]
                           |    |       |
                           +----+---->--+ (transitions possible)
```

### Branch 1: Simple Questions

```
User: "What files are in src?"
         |
         v
  Main Thread answers directly
  Tools: Read, Glob, Grep, Bash
         |
         v
  Response to user (inline)

  Artifacts created: 0
  Subagent sessions: 0
  Reports: 0
```

**Gaps**: No classification validation, no boundary for when "simple" becomes "complex"

---

### Branch 2: Framework Questions

```
User: "How does Theia handle file watchers?"
         |
         v
  Main Thread selects: theia-analyzer-agent OR electron-analyzer-agent
         |
         v
  Task(agent: "[framework]-analyzer-agent",
       prompt: "Analyze [topic].
                CREATE REPORT FILE:
                subagent_reports/YYYYMMDD_[topic]-[fw]-analysis.md")
         |
         v
  Agent reads framework source code (5-30 files)
  Agent writes report
         |
         v
  Main Thread reads report -> presents to user
         |
    +----+----+
    |         |
    v         v
  Satisfied?  Follow-up?
    |         |
    v         v
  DELETE    MT adds <!-- MT: [question] --> to report
  report    Re-invoke agent with UPDATE instruction
            Re-read -> present -> loop
```

**Artifacts**: 1 temp report, 0 permanent
**Gaps**: Write tool mismatch (see Bugs), parallel delegation escape hatch undocumented

---

### Branch 3a: Strategic Consultation

```
User: "Should I implement Docker orchestration?"
         |
         v
  Main Thread classifies as consultation (not implementation)
  Cues: "should I", "can I", "is this worth", "does this align"
         |
         v
  Task(agent: "egdesk-pm-agent",
       prompt: "CONSULTATION - strategic analysis, DO NOT create PRD.
                CREATE REPORT FILE: subagent_reports/...-pm-consultation.md")
         |
         v
  PM reads: technology-stack.md, vision docs, existing code
  PM writes: strategic analysis + APPROVE/MODIFY/REJECT
         |
         v
  Main Thread reads -> presents to user
         |
    +----+----+----+
    |         |    |
    v         v    v
  APPROVE   DEFER  REJECT
    |         |      |
    v         v      v
  ->Branch3b PM may  No action
  (transition create  DELETE report
   to impl)  ideas/brainstorming/
             DELETE report
```

**Artifacts**: 1 temp report + 0-1 brainstorming doc
**Gaps**: APPROVE vs MODIFY path unclear, PM statelessness = re-reads all docs every time

---

### Branch 3b: Implementation Planning (Full Workflow)

This is the most complex branch. 11 steps with loops and error recovery.

```
Step 1: User: "Implement [feature]" (or approved from 3a)
  |
  v
Step 2: PM Strategic Guide + PRD
  |  Task(egdesk-pm-agent, "APPROVED. Create PRD.")
  |  PM creates: subagent_reports/...-pm-implementation.md
  |  PM creates: ideas/confirmed/[FEATURE_NAME].md (permanent PRD)
  |
  v
Step 3: Main Thread reads PM report
  |
  v
Step 4: Plan framework investigation
  |  (Main Thread decides which framework agents to query)
  |
  v
Step 5: Framework Investigation (potentially parallel)
  |  Task(theia-analyzer-agent, "Analyze patterns")
  |  Task(electron-analyzer-agent, "Analyze integration") [if needed]
  |  Creates: subagent_reports/...-theia-analysis.md
  |
  v
Step 6: (Optional) Return to PM for plan review
  |  PM is STATELESS -- must quote entire previous guide
  |  Cost: 10,000-60,000 tokens for redundant reads
  |
  v
Step 7*: [NEW - Proposed] Structure Design (Main Thread)
  |  - Apply decomposition template
  |  - Create file manifest (CREATE/MODIFY list)
  |  - Pre-check CODEBASE_STRUCTURE.md for conflicts
  |
  v
Step 8: Spawn coding-agent(s)
  |  Task(coding-agent, "[PM guide + framework patterns + file manifest]")
  |  Creates/modifies: source code files
  |  Updates: CODEBASE_STRUCTURE.md
  |
  v
Step 9: (Optional) UX Flow Validation
  |  Task(ux-flow-simulator-agent, "Trace execution flow")
  |  Static code path tracing (no actual execution)
  |     |
  |     +-- Issues found? -> Fix via coding-agent -> Re-validate (loop)
  |
  v
Step 9.5*: [NEW - Proposed] Test Strategy
  |  Task(test-strategy-agent, "Generate test plan + skeletons")
  |  Creates: .spec.ts files, E2E test scenarios
  |
  v
Step 9.7*: [NEW - Proposed] Runtime Testing
  |  Prerequisite: Main Thread pre-builds app
  |  Task(runtime-test-agent, "npx playwright test")
  |     |
  |     +-- FAIL? -> coding-agent fixes -> re-run (max 3 cycles)
  |
  v
Step 10: Build, Validate*, Test, Commit
  |  a. Build project
  |  b. /codebase-check* (proposed: validate file lengths + structure)
  |  c. Run tests
  |  d. Fix if needed
  |  e. git commit
  |
  v
Step 11: Cleanup
  |  rm subagent_reports/...-pm-implementation.md
  |  rm subagent_reports/...-theia-analysis.md
  |  rm subagent_reports/...-coding-agent.md
  |  Permanent: ideas/confirmed/[FEATURE].md + committed code

  * = proposed improvement (not yet in current system)
```

**Artifacts**: 3-5 temp reports, 1 permanent PRD, N source files
**Total Subagent Sessions**: 3-6 (PM + framework + coding + optional UX/test)

---

### Branch 4A: Integration Research

```
Step 0: Auto-classify
  |  "Add X to EG-DESK" -> Integration (PM needed)
  |
  v
Step 1: PM Diagnosis
  |  Task(egdesk-pm-agent, "Diagnose: does stack support [capability]?")
  |  PM returns: RESEARCH_NEEDED + evaluation criteria
  |
  v
Step 2: Parallel Research (2+ agents)
  |  Task(general-purpose, "Research Technology A") --+
  |  Task(general-purpose, "Research Technology B") --+--> parallel
  |
  v
Step 3: Read research reports
  |
  v
Step 4: Extract to references/
  |  mkdir -p references/[technology]/
  |  Write: references/[technology]/online_references.md
  |  Update: setup.sh + setup.bat
  |  DELETE research reports
  |
  v
Step 5: Analyzer Agent Assessment
  |  Task(theia-analyzer-agent, "Assess integration feasibility")
  |  May git clone to references/[tech]/[tech]/
  |
  v
Step 6: PM Evaluation
  |  Task(egdesk-pm-agent, "Evaluate options. Score. Recommend.")
  |  If approved: creates ideas/confirmed/[FEATURE].md + updates tech-stack
  |
  v
Step 7: Present to user -> Approve? -> Branch 3b (implement)
  |                         Reject? -> Cleanup
  v
Step 8: DELETE temp reports
  Permanent: references/[tech]/, PRD (if approved)
```

**Artifacts**: 3-4 temp reports, 1 references/ folder (permanent), 0-1 PRD
**Gaps**: general-purpose Write unreliable, who owns references/ creation is ambiguous

---

### Branch 4B: Pure Study Research

```
User: "What is AG Grid?"
  |
  v
Main Thread classifies: Pure study (no PM)
Cues: "What is X?", "Research X", "How does X work?"
  |
  v
Task(general-purpose, "Research [technology]. Generate report content.")
  |
  v
Main Thread creates report from function_results*
  |
  v
Present to user -> Discussion -> Follow-up?
  |                                |
  v                                v
  Satisfied?                    Re-invoke agent
  |
  v
  DELETE report (no extraction to references/)

  * Should use built-in agent protocol, not CREATE REPORT FILE
```

**Artifacts**: 1 temp report (deleted), 0 permanent
**Gaps**: No 4B->4A upgrade path, knowledge completely lost

---

### Branch 5: Agent Creation

```
+-- 5A: Permanent Agent --+        +-- 5B: Pseudo-Agent --+
|                          |        |                       |
| Task(claude-agent-sdk-   |        | Main Thread writes:   |
|   analyzer-agent,        |        | .claude/prompts/      |
|   "Create agent for X")  |        |   [task-name].md      |
|                          |        |                       |
| Agent reads:             |        | Task(general-purpose, |
| - best-practices.md      |        |   "Read prompts/      |
| - existing agents        |        |    [task].md and      |
|                          |        |    follow instructions"|
| Agent creates:           |        |    )                  |
| .claude/agents/          |        |                       |
|   [agent-name].md        |        | Agent executes task   |
|                          |        |                       |
| Post-creation*:          |        | Prompt file persists  |
| - Update capabilities.md |        | (no cleanup defined)  |
| - Session restart needed  |        |                       |
+--------------------------+        +-----------------------+

  * = proposed step (not in current system)
```

**Gaps**: No capabilities.md update step, no test invocation, session restart required

---

### Branch Transition Map

```
                    3a -----APPROVE-----> 3b
                    (Consultation)        (Implementation)
                         |
                       DEFER
                         |
                         v
                    ideas/brainstorming/

                    4A -----APPROVE-----> 3b
                    (Integration Research) (Implementation)

                    4B -----USER DECIDES--> 4A
                    (Pure Study)            (Integration)
                                            [must preserve report!]

Transition Rules:
  3a->3b: Carry consultation report until impl report created, then delete
  4A->3b: PRD + references/ persist, all temp reports already deleted
  4B->4A: DO NOT delete research report -- promote to 4A flow
```

---

## 6. Agent Inventory & Capabilities

### Current Agent Matrix

```
+---------------------------------+-----+-----+----+-----+----+----+--------+--------+
| Agent                           | Read|Write|Edit|Bash |Glob|Grep|WebFetch|WebSearch|
+---------------------------------+-----+-----+----+-----+----+----+--------+--------+
| Main Thread                     |  Y  |  Y  | Y  |  Y  | Y  | Y  |   Y    |   Y    |
+---------------------------------+-----+-----+----+-----+----+----+--------+--------+
| egdesk-pm-agent                 |  Y  |  Y  | Y  |  Y  | Y  | Y  |   Y    |   Y    |
| theia-analyzer-agent         *  |  Y  |  N! | N  |  Y  | Y  | Y  |   Y    |   Y    |
| electron-analyzer-agent      *  |  Y  |  N! | N  |  Y  | Y  | Y  |   Y    |   Y    |
| coding-agent                    |  Y  |  Y  | Y  |  N  | Y  | Y  |   N    |   N    |
| ux-flow-simulator-agent      *  |  Y  |  N! | N  |  Y  | Y  | Y  |   Y    |   Y    |
| swarm-team-agent                |  Y  |  Y  | Y  |  Y  | Y  | Y  |   N    |   N    |
| claude-agent-sdk-analyzer-agent |  Y  |  Y  | N  |  Y  | Y  | Y  |   Y    |   Y    |
| gemini-cli-analyzer-agent       |  Y  |  N  | N  |  Y  | Y  | Y  |   Y    |   Y    |
| infinite-canvas-analyzer-agent  |  Y  |  N  | N  |  Y  | Y  | Y  |   Y    |   Y    |
+---------------------------------+-----+-----+----+-----+----+----+--------+--------+
| general-purpose (built-in)      |  Y  |  ?  | ?  |  N  | Y  | Y  |   Y    |   Y    |
| claude-code-guide (built-in)    |  Y  |  N  | N  |  N  | Y  | Y  |   Y    |   Y    |
+---------------------------------+-----+-----+----+-----+----+----+--------+--------+

  * = CRITICAL BUG: agent-capabilities.md says Write=YES but YAML says NO
  ! = These agents likely use Bash (cat/echo) as workaround for file writing
  ? = "Context-dependent" -- unreliable, treat as NO
```

### Agent Role Taxonomy

```
CURRENT AGENTS (9 defined + 2 built-in)
========================================

  STRATEGIC (1)
  +-- egdesk-pm-agent         Vision alignment, PRDs, tech decisions

  FRAMEWORK ANALYSIS (2)
  +-- theia-analyzer-agent    Eclipse Theia codebase analysis
  +-- electron-analyzer-agent Electron framework analysis

  IMPLEMENTATION (2)
  +-- coding-agent            Code writing/editing (no Bash, no web)
  +-- ux-flow-simulator-agent Static code path validation

  INFRASTRUCTURE (2)
  +-- swarm-team-agent        Project structure validation
  +-- claude-agent-sdk-analyzer-agent  Agent creation factory

  EXTERNAL TOOL ANALYSIS (2)
  +-- gemini-cli-analyzer-agent        Gemini CLI codebase analysis
  +-- infinite-canvas-analyzer-agent   Infinite Canvas analysis


COVERAGE GAPS (identified by taxonomy analysis)
================================================
  P0 (Critical):
  +-- [NONE] Security auditor
  +-- [NONE] Test strategy generation
  +-- [NONE] Runtime test execution

  P1 (Important):
  +-- [NONE] Performance profiler
  +-- [NONE] Documentation generator
  +-- [NONE] Dependency manager
```

---

## 7. Platform Constraints

Seven verified constraints shape the architecture. Each sourced from official docs and GitHub issues.

### Constraint Summary Table

```
+---+----------------------------------+----------+----------------------------+
| # | Constraint                       | Severity | Workaround                 |
+---+----------------------------------+----------+----------------------------+
| 1 | Subagent .md no hot-reload       | HIGH     | Session restart, Skills    |
| 2 | Agent Teams: no pre-config       | MEDIUM   | Spawn prompts, CLAUDE.md   |
| 3 | Subagents stateless              | HIGH     | File-based reports, memory |
| 4 | File-based comm overhead         | MEDIUM   | Keep for durability        |
| 5 | Context window/compaction        | HIGH     | Short-lived teams, fresh   |
|   |                                  |          | subagent contexts          |
| 6 | MCP unreliable in subagents      | CRITICAL | Bash-based fallback,       |
|   |                                  |          | Agent Teams for MCP work   |
| 7 | Tool permissions: Teams coarse   | MEDIUM   | Post-spawn mode changes    |
+---+----------------------------------+----------+----------------------------+
```

### Constraint Details

**C1: Subagent .md No Hot-Reload** (GitHub #6497 OPEN)
- Editing `.claude/agents/*.md` does NOT take effect until session restart
- `/agents` command: lists only, does NOT reload (empirically verified 2026-02-06)
- `/compact` command: does NOT reload agents (empirically verified 2026-02-07)
- Skills (`.claude/commands/*.md`) DO hot-reload -- use for dynamic behavior
- **Only method: session restart**

**C2: Agent Teams No Pre-Configuration**
- Teammates defined purely by natural language spawn prompt
- No YAML frontmatter, no version control
- Workaround: Store role descriptions in `.claude/prompts/team-roles/`

**C3: Subagent Statelessness**
- Each invocation = fresh context (no conversation history)
- NEW: `memory: project` field enables cross-session learning via MEMORY.md
- File-based reports serve as persistent state between invocations

**C4: File-Based Communication**
- Minimum 3 file I/O per interaction (write + read + delete)
- BUT: provides session recovery, audit trail, debuggability
- Agent Teams messaging is real-time but ephemeral (lost on restart)

**C5: Context Window Pressure**
- Subagents: immune to main context compaction (fresh each invocation)
- Agent Teams: each teammate accumulates context, subject to compaction
- Lead's context grows with every teammate message

**C6: MCP Unreliable in Custom Subagents** (Multiple open GitHub issues)
- #13605, #13898, #19526, #14496, #7296
- Custom subagents hallucinate MCP tool calls instead of executing them
- Background subagents: MCP explicitly NOT available
- Agent Teams: better (full Claude instances) but new/untested

**C7: Tool Permissions**
- Subagents: precise via YAML `tools` allowlist
- Agent Teams: inherit lead's permissions, coarse control
- Can change teammate modes post-spawn but not at spawn time

### Session Recovery Comparison

```
SUBAGENT WORKFLOW (Robust Recovery):
+-------------------+----------+------------------------------+
| Artifact          | Survives?| Recovery Path                |
+-------------------+----------+------------------------------+
| Agent definitions | YES (git)| Loaded at next session start |
| Report files      | YES(disk)| MT reads and continues       |
| Transcripts       | YES(jsonl)| Can resume by agent ID      |
| Main Thread       | YES      | /resume restores context     |
| In-flight agent   | NO       | Re-invoke with same report   |
| Persistent memory | YES(disk)| Auto-loaded next invocation  |
+-------------------+----------+------------------------------+

AGENT TEAMS WORKFLOW (Fragile Recovery):
+-------------------+----------+------------------------------+
| Artifact          | Survives?| Recovery Path                |
+-------------------+----------+------------------------------+
| Team config       | YES(disk)| But teammates are dead       |
| Task list         | YES(disk)| Lead sees tasks, no workers  |
| Teammate context  | NO       | Lost permanently             |
| Messages          | NO       | Lost permanently             |
| Code changes      | YES(git) | Committed/staged code stays  |
| Lead context      | YES      | /resume, but msgs to dead    |
+-------------------+----------+------------------------------+
```

---

## 8. Critical Bugs

### Bug 1: Write Tool Mismatch (CRITICAL)

```
agent-capabilities.md says:      YAML frontmatter says:
+---------------------------+    +---------------------------+
| theia-analyzer: Write=YES |    | tools: Bash, Glob, Grep,  |
| electron-analyzer: W=YES  |    |   Read, WebFetch,         |
| ux-flow-simulator: W=YES  |    |   WebSearch, BashOutput,  |
+---------------------------+    |   KillShell, TodoWrite    |
                                 |   (NO Write, NO Edit)     |
                                 +---------------------------+

Result: Workflows instruct agents to "CREATE REPORT FILE"
        but agents may not have the Write tool.
        Agents likely use Bash (cat/echo) as undocumented workaround.

Fix: Option A - Update docs (agents use Bash for writing)
     Option B - Add Write to YAML (recommended -- gives proper tool)
```

### Bug 2: general-purpose Write Ambiguity (CRITICAL)

```
agent-capabilities.md says:
+------------------------------------------+
| general-purpose | Write = context-dependent |
+------------------------------------------+

No mechanism exists to control or detect which mode.
Research workflows (4A, 4B) use "CREATE REPORT FILE"
which may fail unpredictably.

Fix: ALWAYS treat as no-Write. Use built-in agent protocol:
     Agent returns content -> Main Thread creates file.
```

### Bug 3: MCP Tools in Subagents (CRITICAL, External)

```
GitHub Issues: #13605, #13898, #19526, #14496, #7296

Custom subagents HALLUCINATE MCP tool calls.
Background subagents: MCP explicitly unavailable.

Impact: runtime-test-agent cannot use Playwright MCP via subagent.
Fix: Use Bash-based Playwright (npx playwright test) for now.
     Migrate to Agent Teams when MCP stabilizes.
```

---

## 9. Proposed Improvements

### 9.1 Testing Layer Design

Two new agents to close the testing gap:

```
CURRENT STATE:
  ux-flow-simulator-agent -> Traces code paths mentally (NO execution)
  (nothing else)           -> No test generation, no test running

PROPOSED STATE:

  ux-flow-simulator-agent   -> Static code validation (KEEP)
          |
          v
  test-strategy-agent (NEW) -> Generates test plans + .spec.ts skeletons
  tools: Read, Write, Edit, Glob, Grep, WebSearch
  NO Bash (code analysis only, no execution)
          |
          v
  runtime-test-agent (NEW)  -> Launches Electron, runs Playwright tests
  tools: Bash, BashOutput, KillShell, Read, Write, Glob, Grep
  Uses: npx playwright test (Bash-based, NOT MCP due to unreliability)
  Timeout: 300000ms (5 min) per test batch

  Phase 2 evolution: Migrate runtime-test-agent to Agent Teams
  for MCP-based interactive debugging when MCP stabilizes.
```

**Workflow Integration (Steps 9.5 and 9.7 in Branch 3b)**:
```
coding-agent completes
    |
    v
test-strategy-agent generates test plan + skeletons
    |
    v
Main Thread builds app (Bash: yarn build)
    |
    v
runtime-test-agent runs tests (Bash: npx playwright test)
    |
    +-- PASS -> proceed to commit
    +-- FAIL -> coding-agent fixes -> re-run (max 3 cycles)
```

### 9.2 Module Structure Philosophy

Theia-derived decomposition rules for when app code exists:

```
Feature Request arrives from PM
         |
         v
  Package Decision: New package or extend existing?
         |
         v
  Platform Layers (mandatory Theia split):
  +-- common/          Shared IPC interfaces
  +-- browser/         Frontend (widgets, services, contributions)
  +-- node/            Backend (servers, file system access)
  +-- electron-browser/ Electron renderer specifics (optional)
  +-- electron-main/    Electron main process (optional)
         |
         v
  File Naming:
  +-- *-frontend-module.ts   ContainerModule (DI wiring)
  +-- *-contribution.ts      Commands, menus, keybindings
  +-- *-widget.tsx            React UI component
  +-- *-service.ts            Business logic (@injectable)
  +-- *-protocol.ts           IPC interfaces (in common/)
  +-- *.spec.ts               Unit test (colocated)
         |
         v
  Organization Principles:
  1. Feature-based packages (NOT layer-based)
  2. Platform split is structural (Theia requires it)
  3. Depth limit: 4 levels from package root
  4. One large class per file (kebab-case naming)
  5. 750-line maximum per file
  6. Tests colocated with source
  7. Per-platform index.ts exports (no root barrel)
```

**Proposed `eg-desk/` structure**:
```
eg-desk/
+-- package.json             Monorepo root
+-- CODEBASE_STRUCTURE.md    Conflict prevention (dual lifecycle)
+-- packages/
|   +-- [feature]/
|       +-- package.json     theiaExtensions entry
|       +-- src/
|           +-- common/      Shared interfaces
|           +-- browser/     Frontend implementation
|           +-- node/        Backend implementation
+-- app/                     Application entry point
+-- configs/                 Shared build configs
```

### 9.3 Dynamic Agent Lifecycle

Agents move through a 6-state lifecycle:

```
[Idea] --> [Draft] --> [Testing] --> [Active] --> [Archived]
             |            |            |  |
             |            |            |  +--> [Forked] --> new [Draft]
             |            +--> [Rejected]
             +--> [Discarded]

Directories:
  .claude/agents/staging/    Draft + Testing agents
  .claude/agents/            Active agents (production)
  .claude/agents/archive/    Retired agents
  .claude/agents/templates/  Agent scaffolds (not invocable)

Promotion Criteria:
  Draft -> Testing:  YAML valid, instructions coherent, tools appropriate
  Testing -> Active: 2+ successful task completions, consistent quality
  Active -> Archived: 30+ days unused OR superseded

Registry:
  .claude/agents/registry.yaml  Machine-readable index of all agents
  /refresh-agent-registry        Slash command to regenerate
```

**4 Agent Templates** (proposed scaffolds):
1. **Framework Analyzer**: Read-heavy, codebase-first analysis
2. **Research Agent**: WebSearch + synthesis
3. **Code Executor**: Write/Edit focused, instruction-following
4. **Validator/Checker**: Read-only verification

### 9.4 Hybrid Architecture Decision Guide

```
Task arrives at Main Thread
  |
  +-- Focused, well-defined task?
  |     |
  |     YES --> Need precise tool control?
  |     |         YES --> SUBAGENT
  |     |         NO  --> SUBAGENT (default)
  |     |
  |     NO --> Need multi-agent collaboration?
  |              |
  |              YES --> Agents must debate/challenge?
  |              |         YES --> AGENT TEAM
  |              |         NO  --> Parallel SUBAGENTS
  |              |
  |              NO --> Exploratory/open-ended?
  |                       YES --> AGENT TEAM
  |                       NO  --> Single SUBAGENT
  |
  +-- Need MCP tools?
        |
        YES --> Bash alternative exists?
                  YES --> SUBAGENT with Bash
                  NO  --> AGENT TEAM or MAIN THREAD
```

---

## 10. Phase 0-3 Action Plan

### Phase 0: Bug Fixes (Broken Right Now) -- ~1 hour

```
+-----+--------------------------------------+------------------------------+--------+
| #   | Action                               | Files to Modify              | Effort |
+-----+--------------------------------------+------------------------------+--------+
| 0.1 | Fix Write tool mismatch              | agent-capabilities.md +      | 15 min |
|     | (add Write to YAML OR update docs)   | agent YAML files             |        |
+-----+--------------------------------------+------------------------------+--------+
| 0.2 | Clarify general-purpose protocol     | agent-capabilities.md        | 30 min |
|     | (always treat as no-Write)           |                              |        |
+-----+--------------------------------------+------------------------------+--------+
| 0.3 | Fix research-workflows.md            | research-workflows.md        | 20 min |
|     | (stop using CREATE REPORT FILE with  |                              |        |
|     |  general-purpose)                    |                              |        |
+-----+--------------------------------------+------------------------------+--------+
```

### Phase 1: Quick Wins -- ~1.5 hours

```
+-----+--------------------------------------+------------------------------+--------+
| #   | Action                               | Files to Modify              | Effort |
+-----+--------------------------------------+------------------------------+--------+
| 1.1 | Add error recovery protocol          | NEW: error-recovery.md       | 30 min |
|     |                                      | + protocol.md reference      |        |
+-----+--------------------------------------+------------------------------+--------+
| 1.2 | Define branch transition handoffs    | pm-workflows.md              | 20 min |
|     | (3a->3b, 4A->3b, 4B->4A)           |                              |        |
+-----+--------------------------------------+------------------------------+--------+
| 1.3 | Integrate /codebase-check into 3b    | pm-workflows.md              | 5 min  |
+-----+--------------------------------------+------------------------------+--------+
| 1.4 | Agent creation post-step             | CLAUDE.md                    | 5 min  |
|     | (update capabilities.md after)       |                              |        |
+-----+--------------------------------------+------------------------------+--------+
| 1.5 | Enable persistent memory             | theia-analyzer-agent.md      | 5 min  |
|     | (memory: project for analyzers)      | electron-analyzer-agent.md   |        |
+-----+--------------------------------------+------------------------------+--------+
| 1.6 | Clarify report cleanup rules         | protocol.md                  | 10 min |
+-----+--------------------------------------+------------------------------+--------+
```

### Phase 2: New Capabilities -- ~6-8 hours

```
+-----+--------------------------------------+------------------------------+--------+
| #   | Action                               | Files to Create/Modify       | Effort |
+-----+--------------------------------------+------------------------------+--------+
| 2.1 | Create test-strategy-agent           | NEW: agents/test-strategy-   | 1 hr   |
|     |                                      | agent.md + workflow update   |        |
+-----+--------------------------------------+------------------------------+--------+
| 2.2 | Create runtime-test-agent            | NEW: agents/runtime-test-    | 1 hr   |
|     |                                      | agent.md                     |        |
+-----+--------------------------------------+------------------------------+--------+
| 2.3 | Structure design step in 3b          | pm-workflows.md + NEW:       | 45 min |
|     |                                      | module-decomposition.md      |        |
+-----+--------------------------------------+------------------------------+--------+
| 2.4 | Dual-lifecycle CODEBASE_STRUCTURE    | CODEBASE_STRUCTURE.md        | 15 min |
+-----+--------------------------------------+------------------------------+--------+
| 2.5 | Playwright test infrastructure       | playwright.config.ts,        | 2 hr   |
|     | (when first feature exists)          | fixtures, smoke test         |        |
+-----+--------------------------------------+------------------------------+--------+
| 2.6 | eg-desk/ folder structure            | eg-desk/ skeleton            | 1-2 hr |
|     | (when first feature ready)           |                              |        |
+-----+--------------------------------------+------------------------------+--------+
```

### Phase 3: Architecture Evolution -- Ongoing

```
+-----+--------------------------------------+------------------------------+--------+
| #   | Action                               | Trigger                      | Effort |
+-----+--------------------------------------+------------------------------+--------+
| 3.1 | Hybrid subagent + Agent Teams model  | Agent Teams battle-tested    | Ongoing|
+-----+--------------------------------------+------------------------------+--------+
| 3.2 | Migrate runtime-test to Agent Teams  | MCP bugs fixed (GitHub)      | TBD    |
+-----+--------------------------------------+------------------------------+--------+
| 3.3 | Skills hot-reload workaround         | Dynamic behavior needed      | 15 min |
+-----+--------------------------------------+------------------------------+--------+
| 3.4 | PM statelessness optimization        | PM invocations feel slow     | 5 min  |
|     | (memory: project for PM agent)       |                              | -1 hr  |
+-----+--------------------------------------+------------------------------+--------+
| 3.5 | Session recovery protocol            | Agent Teams used regularly   | 30 min |
+-----+--------------------------------------+------------------------------+--------+
```

---

## 11. Open Questions

These require user decisions before implementation:

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Write tool fix approach | A: Update docs (Bash writing) / B: Add Write to YAML | **B**: Add Write to YAML |
| 2 | App code directory name | `eg-desk/` / `src/` / other | **eg-desk/** |
| 3 | Theia fork vs standalone | Fork (modify Theia packages) / Standalone (npm deps) | Depends on project goals |
| 4 | When to create skeleton | Now (empty scaffolding) / With first feature | **With first feature** |
| 5 | Testing infra timing | Now / When first testable feature | **When first feature** |

---

## Appendix: Source Reports

This guide was consolidated from 6 Agent Team reports:

1. **Workflow Artifacts Map** -- Step-by-step artifact mapping for all 7 branches
2. **Testing Layer Design** -- test-strategy-agent + runtime-test-agent design
3. **Module Structure Philosophy** -- Theia decomposition patterns, folder hierarchy
4. **Platform Constraints Analysis** -- 7 verified constraints, hybrid architecture
5. **Unified Proposal (Synthesis)** -- Phase 0-3 action plan, updated 3b workflow
6. **Dynamic Agent Lifecycle Design** -- State machine, staging/templates/archive

---

*End of Comprehensive Guide*
