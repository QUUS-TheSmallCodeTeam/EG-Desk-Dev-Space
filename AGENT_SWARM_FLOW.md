# Agent Swarm Flow: From Ideation to Implementation

This document maps the complete agent orchestration system for the EG-DESK project through concrete workflow scenarios, showing exactly who does what at each step.

## Master Flow Diagram: All Request Types

This diagram shows the complete routing logic and agent communication flow. **CRITICAL**: All subagents report back to Main Thread (via subagent_reports/), and Main Thread communicates results to User.

```
                          ┌──────────────────────────────────────────────────────────────┐
                          │                                                              │
                          │  [All "New Req?" loops back here]                            │
                          ▼                                                              │
                    User Request                                                         │
                         │                                                               │
                         ▼                                                               │
                ┌─────────────────┐                                                      │
                │  Main Thread    │◄─────────────────────────────────────────────────────┘
                │ (Analyzes type) │
                └────────┬────────┘
                         │
   ┬────────────────────────┬────────────────────────┬────────────────────────┬────────────────────────┬
   │                        │                        │                        │                        │
   ▼                        ▼                        ▼                        ▼                        ▼
Simple Task            Research              Vision Question            Development            Agent Creation
   │                        │                        │                        │                        │
   │                 Has analyzer?                   │                        │                        │
   │                 ┌──────┴──────┐                 │                        │                        │
   │                Yes            No                 │                        │                        │
   │                 │              │                 │                        │                        │
   ▼                 ▼              ▼                 ▼                        ▼                        ▼
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐            ┌──────────┐            ┌──────────┐
│Main      │   │Analyzer  │   │Main      │   │PM Agent  │            │PM Agent  │            │claude-   │
│Thread    │   │Agent     │   │Thread    │   │          │            │(strategic│            │agent-sdk │
│(executes)│   │          │   │(plans    │   │          │            │guide)    │            │-analyzer │
└─────┬────┘   └─────┬────┘   │research) │   └─────┬────┘            └─────┬────┘            └─────┬────┘
      │              │         └─────┬────┘         │                       │                       │
      │              │               │              │                       │                       │
      │              │          ┌────┼────┐         │                       │                       │
      │              │          │    │    │         │                       │                       ▼
      │              │          ▼    ▼    ▼         │                       │                ┌──────────┐
      │              │     ┌──────────────────┐     │                       │                │Main      │
      │              │     │Research │Research│     │                       │                │Thread    │
      │              │     │Agent 1  │Agent 2 │     │                       │                │(reads &  │
      │              │     │         │Research│     │                       │                │confirms) │
      │              │     │         │Agent 3 │     │                       │                └─────┬────┘
      │              │     └────┬────┴────┬───┘     │                       │                      │
      │              │          │         │         │                       │                      │
      │              │          └─────────┼─────┐   │                       │                      ▼
      │              │                    │     │   │                       │                    USER
      │              │                    ▼     │   │                       │                (Complete)
      │              │             ┌──────────┐ │   │                       │                      │
      │              │             │Main      │ │   │                       │                ┌─────┴─────┐
      │              │             │Thread    │ │   │                       │                │           │
      │              │             │(organizes│ │   │                       │              Done?      New Req?
      │              │             │findings) │ │   │                       │                │           │
      │              │             └─────┬────┘ │   │                       │                └→END       └──────┐
      │              │                   │      │   │                       │                                   │
      │              ├───────────────────┴──────┘   │                       │                                   │
      │              │                              │                       │                                   │
      │              │        ┌──────────┐          │                       │                                   │
      │              │        │Main      │          │                       │                                   │
      │              │        │Thread    │          │                       │                                   │
      │              │        │(reads    │          │                       │                                   │
      │              │        │report)   │          │                       │                                   │
      │              │        └─────┬────┘          │                       │                                   │
      │              │              │               │                       │                                   │
      │              └──────────────┼───────────────┘                       │                                   │
      │                             │                                       │                                   │
      │                             ▼                                       │                                   │
      │                           USER                                      │                                   │
      │                             │                                       │                                   │
      │                  ┌──────────┼──────────┐                            │                                   │
      │                  │          │          │                            │                                   │
      │               Done?     Implement?  NewReq?                         │                                   │
      │                  │          │          │                            │                                   │
      │                  │          │          └────────────────────────────┤                                   │
      │                  └→END      │                                       │                                   │
      │                             │                                       │                                   │
      │         ┌───────────────────┘                                       │                                   │
      │         │                                                           │                                   │
      │         │                 ┌──────────┐                              │                                   │
      │         │                 │Main      │                              │                                   │
      │         │                 │Thread    │                              │                                   │
      │         │                 │(reads    │                              │                                   │
      │         │                 │report)   │                              │                                   │
      │         │                 └─────┬────┘                              │                                   │
      │         │                       │                                   │                                   │
      │         │                       ▼                                   │                                   │
      │         │                     USER                                  │                                   │
      │         │                       │                                   │                                   │
      │         │             ┌─────────┼─────────┐                         │                                   │
      │         │             │         │         │                         │                                   │
      │         │         Approve    Insist    Cancel                       │                                   │
      │         │             │         │         │                         │                                   │
      │         │             │         │         └─→END                    │                                   │
      │         │             │         │                                   │                                   │
      │         │             │    ┌────┴───┐                               │                                   │
      │         │             │    │PM loop │                               │                                   │
      │         │             │    └────┬───┘                               │                                   │
      │         │             │         │                                   │                                   │
      │         │             │         └────────────┐                      │                                   │
      │         │             │                      │                      │                                   │
      │         └─────────────┴──────────────────────┘                      │                                   │
      │                                                                     │                                   │
      │                                      ┌────────────┐                 │                                   │
      │                                      │Main Thread │                 │                                   │
      │                                      │(synthesizes│                 │                                   │
      │                                      │ PM+patterns│                 │                                   │
      │                                      └──────┬─────┘                 │                                   │
      │                                             │                       │                                   │
      │                                             ▼                       │                                   │
      │                                    ┌─────────────────┐              │                                   │
      │                                    │Framework        │              │                                   │
      │                                    │Analyzer         │              │                                   │
      │                                    │(pattern         │              │                                   │
      │                                    │discovery)       │              │                                   │
      │                                    └────────┬────────┘              │                                   │
      │                                             │                       │                                   │
      │                                             ▼                       │                                   │
      │                                      ┌────────────┐                 │                                   │
      │                                      │coding-agent│                 │                                   │
      │                                      │(implements)│                 │                                   │
      │                                      └──────┬─────┘                 │                                   │
      │                                             │                       │                                   │
      │                                    ┌────────┼────────┐              │                                   │
      │                                    │        │        │              │                                   │
      │                              Needs new?  Build/Test  Complex UX?    │                                   │
      │                                    │        │        │              │                                   │
      │                                    ▼        │        ▼              │                                   │
      │                              ┌──────────┐   │  ┌──────────┐         │                                   │
      │                              │PM gap    │   │  │UX Flow   │         │                                   │
      │                              │diagnosis │   │  │Validator │         │                                   │
      │                              └─────┬────┘   │  └─────┬────┘         │                                   │
      │                                    │        │        │               │                                   │
      │                                    │        │    Issues?            │                                   │
      │                                    │        │    ┌───┴───┐          │                                   │
      │                                    │        │   Yes     No           │                                   │
      │                                    │        │    │       │           │                                   │
      │                         [Triggers  │        │    │       ▼           │                                   │
      │                          Research: │        │    │  ┌──────────┐     │                                   │
      │                          No path]  │        │    │  │Main      │     │                                   │
      │                                    │        │    │  │Thread    │     │                                   │
      │                                    │        │    │  │(build &  │     │                                   │
      │                                    │        │    │  │commit)   │     │                                   │
      │                                    │        │    │  └─────┬────┘     │                                   │
      │                                    │        │    │        │          │                                   │
      │                                    │        │    └────────┘          │                                   │
      │                                    │        │             │          │                                   │
      │                                    │        │             ▼          │                                   │
      │                                    │        │           USER         │                                   │
      │                                    │        │             │          │                                   │
      │                                    │        │       ┌─────┼─────┐    │                                   │
      │                                    │        │       │     │     │    │                                   │
      │                                    │        │    Done? Refine? NewReq?
      │                                    │        │       │     │     │
      │                                    │        │       │     │     └────────────────────────────────────────┐
      │                                    │        │       │     │                                              │
      │                                    │        │       └→END └──[Loop Dev]                                  │
      │                                    │        │                                                            │
      │                                    │        └──────────────────────────┐                                 │
      │                                    │                                   │                                 │
      │                                    └───────────────────────────────────┼─────────────────────────────────┘
      │                                                                        │
      └────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
                                         USER
                                      (Complete)
```

## Development (Detailed Steps Below)

```
        │
        │ Step 1: Strategic Guide (shown above in main diagram)
        │ Step 2: Framework Investigation
        │
        ▼
   ┌──────────────────────┐
   │   Main Thread        │
   │ (plans investigation)│
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Framework Analyzer  │
   │  (writes report)     │
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │   Main Thread        │
   │  (reads report)      │
   └──────────┬───────────┘
              │
              ▼
   Extracts patterns
              │
              │ Step 3: Implementation Planning
              │
              ▼
   ┌──────────────────────┐
   │   Main Thread        │
   │   (synthesizes       │
   │  PM + Analyzer)      │
   └──────────┬───────────┘
              │
              ▼
   Creates impl plan
   (Direction + File list)
              │
              ▼
         ★ DELEGATION DECISION
              │
     ┌────────┴────────┐
     │                 │
     ▼                 ▼
┌──────────┐    ┌──────────────┐
│Main      │    │coding-agent  │
│Thread    │    │(implements)  │
│(<3 files)│    │(3+ files)    │
└────┬─────┘    └──────┬───────┘
     │                 │
     │      ★ PARALLEL DECISION
     │                 │
     │    ┌────────────┼────────────┐
     │    │            │            │
     │    ▼            ▼            ▼
     │ Sequential  Simple P.  Worktree P.
     │    │            │            │
     │    └────────────┼────────────┘
     │                 │
     └─────────────────┘
              │
              │ Step 4 (Optional): UX Flow Validation
              │
              ▼
   ┌──────────────────────┐
   │  UX Flow Validator   │
   │  (writes report)     │
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │   Main Thread        │
   │  (reads report)      │
   └──────────┬───────────┘
              │
              ▼
      Issues found?
              │
     ┌────────┴────────┐
    Yes               No
     │                 │
     ▼                 │
┌─────────────┐        │
│coding-agent │        │
│  (fixes)    │        │
└──────┬──────┘        │
       │               │
       └─→ Re-validate │
                       │
                       │ Step 5: Build & Commit
                       │
                       ▼
            ┌──────────────────────┐
            │   Main Thread        │
            │ (build/test/commit)  │
            └──────────┬───────────┘
                       │
                       ▼
                     USER
```

## Workflow Scenarios

### Scenario 1: Simple Question (No Agents)

**User Request:** "What files are in the packages/ai-chat directory?"

**Flow:**
```
User → Main Thread (analyzes) → Glob("packages/ai-chat/**/*") → User
```

**Total Agents:** 0 | **Who Wrote Code:** Nobody | **Duration:** Immediate

---

### Scenario 2: Vision Conflict with Decision Branches

**User Request:** "Should we add a floating AI assistant that follows the mouse cursor?"

**Why this scenario:** User proposes feature that conflicts with vision - PM provides insight + alternative. Shows user decision flow.

**Flow:**
```
User → Main Thread (analyzes: vision alignment question)
         │
         ▼
   ┌──────────────┐
   │  PM Agent    │ • Discovers vision docs (Glob ideas/)
   │  (Analyzes)  │ • Finds: AGAINST floating UI
   └──────┬───────┘ • Reason: breaks spatial affordances
          │         • Returns: REJECT + Alternative
          │           (proximity-based AI, vision-aligned)
          ▼
    ★ USER DECISION 1
          │
      ┌───┼───┐
      │   │   │
      A   B   C
   Accept Insist Cancel
   Alt.  Original  │
      │   │   └──→ [STOP]
      │   │
      │   ▼
      │   ┌──────────────┐
      │   │  PM Agent    │ • Re-evaluates with user's rationale
      │   │(Re-evaluates)│ • Provides deeper analysis
      │   └──────┬───────┘
      │          │
      │          ▼
      │    ★ USER DECISION 2
      │          │
      │      ┌───┴───┐
      │      │       │
      │   Maintain  Evolve
      │   vision    vision
      │      │       │
      │  [STOP]     ▼
      │        ┌──────────────┐
      │        │  PM Agent    │ • Updates vision docs
      │        │(Updates docs)│ • Documents evolution rationale
      │        └──────┬───────┘
      │               │
      └───────────────┘
              │
              ▼
      [Proceed to Implementation]
```

**Decision Gates:**
1. **User Decision 1**: Accept alternative? Insist? Cancel?
2. **User Decision 2** (if insisted): Maintain vision or evolve vision?

**Total Agents:** 2-3 (PM rejection → optional PM re-evaluation → optional PM vision update)

**Key Points:**
- **PM provides insight, not just rejection**: Explains why conflict exists with evidence
- **Constructive alternative**: Vision-aligned approach that solves same user need
- **User can challenge vision**: PM reassesses, but user has final authority
- **Vision can evolve**: PM documents evolution with user's rationale
- **Institutional memory preserved**: Updates vision docs with reasoning

---

### Scenario 3: Development with PM Strategic Guide

**User Request:** "Add a custom terminal theme that changes based on time of day"

**Variations covered:**
- Base flow: PM guide → Framework investigation → Implementation
- Optional delegation: Main Thread delegates to coding-agent if complex (3+ files)
- Optional conflict check: Checks if feature exists in eg-desk_taehwa/ (EG-DESK custom code only)
- Optional UX validation: ux-flow-simulator-agent validates complex flows
- Parallel execution: Sequential / Simple Parallel / Worktree Parallel options

**Flow:**

```
User → Main Thread (analyzes: development task)
         │
         ▼
   ┌──────────────┐
   │  PM Agent    │ • Discovers tech stack (Glob technology-stack.md)
   │  (Strategic  │ • Vision alignment check
   │   Guide)     │ • Analyzes existing structure
   └──────┬───────┘ • Creates PRD
          │         • Returns: APPROVE
          │           - Framework: Theia (terminal theming)
          │           - Location: packages/terminal/src/browser/
          │           - Approach: analyze → design → implement
          │           - Considerations: manual override, persistence
          ▼
    Approve / Reject / Alternative?
          │
    [If Approve]
          │
          ▼
   ┌──────────────────┐
   │  Main Thread     │ • Plans investigation based on PM's guide
   │  (Plans          │ • Identifies patterns to research
   │   investigation) │ • Output: Query theia-analyzer for theme patterns, DI
   └──────┬───────────┘
          │
          ▼
   ┌──────────────────────┐
   │  theia-analyzer      │ • Reads terminal-theme-service.ts
   │  (Framework          │ • Reads terminal-frontend-module.ts
   │   investigation)     │ • Returns pattern + file list:
   └──────┬───────────────┘   - CREATE time-based-theme-switcher.ts
          │                   - MODIFY terminal-frontend-module.ts:36
          │                   - REFERENCE workspace-service.ts:89 (@injectable)
          ▼
   ┌──────────────────────┐
   │  Main Thread         │ • Synthesizes PM guide + framework patterns
   │  (Creates impl plan) │ • Creates implementation plan:
   └──────┬───────────────┘   - Direction: Create TimeBasedThemeSwitcher
          │                   - File list: CREATE/MODIFY/REFERENCE w/ line nums
          ▼
    ★ DELEGATION DECISION
          │
      ┌───┴───┐
      │       │
      ▼       ▼
   Simple   Complex (3+ files)
      │       │
      │       │
      ▼       ▼
   ┌──────┐ ┌────────────────┐
   │ Main │ │ coding-agent   │ • Checks CODEBASE_STRUCTURE.md for conflicts
   │Thread│ │ (Implements)   │   (EG-DESK custom code only)
   └──┬───┘ └────┬───────────┘ • If conflict: STOP → User decides
      │          │             • If no conflict: Implement
      │          │
      │          ▼
      │    ★ PARALLEL DECISION (for complex tasks)
      │          │
      │      ┌───┼───┐
      │      │   │   │
      │      ▼   ▼   ▼
      │   ┌──────────────────────────────────────────────────┐
      │   │ Option A: Sequential (1 agent)                   │
      │   │   Task(agent: "coding-agent",                    │
      │   │        prompt: "Direction + File List")          │
      │   │                                                  │
      │   │ Option B: Simple Parallel (different files)     │
      │   │   Task(agent: "coding-agent", "[Agent 1: X,Y]") │
      │   │   Task(agent: "coding-agent", "[Agent 2: A,B]") │
      │   │                                                  │
      │   │ Option C: Worktree Parallel (same files)        │
      │   │   Bash: git worktree add ../egdesk-t1 -b task1  │
      │   │   Bash: git worktree add ../egdesk-t2 -b task2  │
      │   │   Task(agent: "coding-agent",                   │
      │   │        prompt: "Working dir: egdesk-t1 ...")    │
      │   │   Task(agent: "coding-agent",                   │
      │   │        prompt: "Working dir: egdesk-t2 ...")    │
      │   │   Bash: git checkout master && git merge ...    │
      │   │   Bash: git worktree remove ...                 │
      │   └──────────────────┬───────────────────────────────┘
      │                      │
      └──────────────────────┘
                │
                ▼
   ┌────────────────────────┐
   │ (Optional) UX Flow     │ • Main Thread decides: Complex flow?
   │  Validator             │ • If yes: Invoke ux-flow-simulator-agent
   └────────┬───────────────┘ • Traces execution paths
            │                 • If issues: coding-agent fixes → Re-validate
            │
            ▼
   ┌────────────────────────┐
   │  Main Thread           │ • Builds, tests, commits
   │  (Build/Test/Commit)   │ • Bash("npm run build && git add . && git commit")
   └────────────────────────┘
```

**Total Agents:** 2-4 (PM → framework analyzer → optional coding-agent → optional ux-flow-simulator)

**Who Wrote Code:** coding-agent (if delegated) or Main Thread (if simple)

**Key Points:**
- **PM provides strategic direction**: Framework, location, approach, considerations
- **PM creates PRD**: Documents approved feature
- **Main Thread plans investigation**: Identifies framework patterns to research
- **Framework agent investigates**: Returns technical patterns (not strategic direction)
- **Main Thread synthesizes**: PM guide + framework patterns → implementation plan
- **Conflict detection** (EG-DESK custom code only): coding-agent checks CODEBASE_STRUCTURE.md BEFORE implementing
- **Structure document updates** (EG-DESK custom code only): coding-agent updates after success
- **coding-agent delegation** (optional): For large implementations (3+ files), preserves MT context
- **UX validation** (optional): Main Thread's discretion for complex flows
- **Main Thread retains control**: Builds, tests, commits

**When to delegate to coding-agent:**
- Large implementations (3+ files)
- Main Thread needs to stay available for orchestration
- Context preservation is critical

**When conflict checking applies:**
- **YES**: EG-DESK custom features (eg-desk_taehwa/*) - check CODEBASE_STRUCTURE.md
- **NO**: Theia framework modifications (packages/*) - no conflict checking

**UX validation criteria:**
- ✅ Use for: Complex flows, state management, race conditions, async ops, critical features
- ❌ Skip for: Simple CRUD, pure UI styling, documentation updates

---

### Scenario 4: Technology Research & Investigation

This scenario covers two workflows depending on whether a dedicated analyzer agent exists:

**Branch A: Adopted Technology Investigation** - When analyzer agent exists (theia/electron/infinite-canvas)
**Branch B: New Technology Evaluation** - When researching new technologies for adoption

---

#### Branch A: Adopted Technology Investigation

**User Request:** "How does Theia's dependency injection work?"

**When to use:** Investigating details of already-adopted technologies with dedicated analyzer agents.

**Flow:**
```
User → Main Thread (analyzes: adopted tech investigation)
         │
         ▼
   ┌──────────────────────┐
   │  Analyzer Agent      │ • Reads references/[tech]/
   │  (theia/electron/    │   (previous investigation files)
   │   infinite-canvas)   │ • WebFetch + WebSearch (official docs)
   └──────────┬───────────┘ • Returns detailed investigation
              │               with file:line references
              ▼
          Result
```

**Total Agents:** 1 (analyzer agent) | **Who Wrote Code:** Nobody | **Duration:** Single agent

**Key Points:**
- **Analyzer agents** investigate adopted technologies with institutional memory
- **Read references/[tech]/**: Previous investigation files guide research
- **WebFetch + WebSearch**: Access official docs for up-to-date info
- **No PM involvement**: These are technical investigations, not strategic decisions
- **file:line references**: Analyzer provides evidence-based explanations

**When analyzer agents get involved:**
- PM requests during Development workflow: "I need to know how Theia implements X"
- User asks direct questions: "How does Electron handle IPC?"
- MT needs technical patterns: "What's the Theia DI pattern for services?"

---

#### Branch B: New Technology Evaluation

**User Request:** "캔버스에 3D visualization을 추가하고 싶어. 어떤 framework가 좋을까?"

**When to use:** Evaluating new technologies not yet in tech stack, requires PM for vision alignment.

**Flow:**
```
User → Main Thread (analyzes: technology gap)
         │
         ▼
   ┌──────────────┐
   │  PM Agent    │ • Discovers tech stack (Glob technology-stack.md)
   │  (Diagnoses  │ • Diagnoses: Konva.js = 2D-only, cannot render 3D
   │   Gap)       │ • Returns: RESEARCH_NEEDED
   └──────┬───────┘   - Gap: 3D rendering
          │           - Criteria: bundle size, integration, performance
          │           - Options: Three.js, Babylon.js, WebGL
          ▼
   ┌──────────────────┐
   │  Main Thread     │ • Plans parallel research (auto-proceed)
   │  (Plans          │ • Chooses 3 frameworks to investigate
   │   research)      │ • No user approval needed for research start
   └──────┬───────────┘
          │
          ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │Research │ │Research │ │Research │ • WebFetch, WebSearch
   │Agent 1  │ │Agent 2  │ │Agent 3  │ • Write to subagent_reports/
   │Three.js │ │Babylon  │ │ WebGL   │   (temporary, NOT references/)
   └────┬────┘ └────┬────┘ └────┬────┘
        │           │           │
        └───────────┼───────────┘
                    │
                    ▼
   ┌──────────────────────────┐
   │  Technical Analyzer      │ • Reads subagent_reports/*.md
   │  (if applicable)         │ • Analyzes integration complexity
   └──────┬───────────────────┘ • Returns: Three.js (medium), Babylon (high)
          │
          ▼
   ┌──────────────────────────┐
   │  PM Agent                │ • Reads subagent_reports/
   │  (Evaluates)             │ • May WebSearch for additional info
   └──────┬───────────────────┘ • Evaluates against criteria + vision
          │                     • Returns: Recommended Three.js (4.2/5)
          │                       - Rationale + Scoring + Tradeoffs
          ▼
    ★ USER DECISION
          │
      ┌───┼───┐
      │   │   │
      A   B   C
  Approve Choose Modify
  Three.js different criteria
      │   │   │
      │   │   └──→ Loop back to research
      │   │
      └───┴──→ ┌──────────────────┐
               │  PM Agent        │ • Adopts technology
               │  (Adopts tech)   │ • Updates tech-stack.md
               └──────┬───────────┘ • Moves findings → references/
                      │             • Deletes other subagent_reports/
                      │             • Creates PRD
                      │             • (Optional) Create analyzer agent
                      │               if recurring investigation needed
                      ▼
               [Proceed to PM-Driven Development Workflow]
```

**Decision Gate:** User approves technology adoption? Choose different? Modify criteria?

**Total Agents:** 5+ (PM diagnosis → 3 parallel research → technical analyzer → PM evaluation → PM adoption)

**Key Points:**
- **PM diagnoses gap**: Identifies limitation in current stack, suggests options
- **Main Thread plans research**: Decides frameworks to investigate (auto-proceed, no user approval)
- **Research to subagent_reports/**: Temporary workspace, NOT institutional memory yet
- **PM evaluates**: Reads reports, may WebSearch, scores against criteria + vision
- **User approves adoption**: Decision gate is technology choice, not research start
- **PM adopts tech**: Moves confirmed findings to references/, updates tech-stack.md
- **Optional analyzer creation**: If technology requires recurring investigation, create dedicated analyzer
- **Cleanup**: Delete subagent_reports/ after decision

**Why subagent_reports/ first?**
- Temporary workspace for research notes
- PM can validate findings before institutional memory
- User can reject entire research without polluting references/
- Clean separation: tentative vs confirmed knowledge

---

### Scenario 5: Agent Creation Request

**User Request:** "We need an agent that analyzes Konva.js integration patterns"

**Flow:**
```
User → MT (analyzes: agent creation)
     ↓
Task(agent: "claude-agent-sdk-analyzer-agent", prompt: "Create Konva analyzer agent")
     ↓
claude-agent: Read(subagent-best-practices.md) + Glob(existing agents) + Design + Create(.claude/agents/konva-analyzer-agent.md)
     ↓
MT → User ("Agent created. Restart session to use konva-analyzer.")
```

**Total Agents:** 1 (claude-agent-sdk-analyzer-agent) | **Who Wrote Code:** claude-agent (created agent file) | **Duration:** Single agent

**Key Points:**
- **Main Thread** delegates agent creation to specialized claude-agent
- **claude-agent** reads best practices, examines existing agents, designs and creates new agent file
- **Evidence-based design**: claude-agent always reads `subagent-best-practices.md` before creating agents

---

### Scenario 6: Simple File Edit (coding-agent)

**User Request:** "Fix the typo in the README - change 'intsall' to 'install'"

**Flow:**
```
User → MT (analyzes: simple edit) → coding-agent (Read README, Edit typo) → MT (commits) → User
```

**Total Agents:** 1 (coding-agent) | **Who Wrote Code:** coding-agent | **Duration:** Single agent + commit

**Key Point:** ALL file changes go through coding-agent for consistency. Main Thread NEVER edits application files directly.

---

## Appendix: Roles and Responsibilities Reference

| Agent | Domain | Can Read | Can Write | Output Format | Model |
|-------|--------|----------|-----------|---------------|-------|
| **Main Thread** | Orchestration | .claude/prompts/, .claude/agents/ (optional) | None (application code) | Synthesized plans, user communication | Default |
| **egdesk-pm-agent** | Vision & Strategy | ideas/, technology-stack.md | PRDs, vision docs, tech stack updates | Strategic guide, PRD, evaluation report | Inherit |
| **theia-analyzer-agent** | Theia Framework | packages/*, Theia docs | None | Pattern analysis, file lists (CREATE/MODIFY/DELETE/REFERENCE) | Inherit |
| **electron-analyzer-agent** | Electron Framework | Electron docs (WebFetch) | None | Pattern analysis, API guidance | Inherit |
| **infinite-canvas-analyzer-agent** | Infinite Canvas | references/infinite-canvas/ | None | Integration analysis | Inherit |
| **coding-agent** | Code Execution | Target files (any worktree) | Application code (CREATE/MODIFY), CODEBASE_STRUCTURE.md | Implementation report, conflict reports | Inherit |
| **claude-agent-sdk-analyzer-agent** | Agent Architecture | .claude/agents/, subagent-best-practices.md | .claude/agents/*.md | Agent spec, best practices report | Inherit |
| **ux-flow-simulator-agent** | UX Validation | Implemented files | None | Flow validation report, issue list | Inherit |
| **general-purpose** | Research | Web (WebSearch, WebFetch) | subagent_reports/*.md (temporary) | Research findings | Inherit |

**Key Ownership:**
- **Vision**: egdesk-pm-agent owns vision docs, decides alignment
- **Code**: coding-agent is ONLY entity that writes application code
- **Build/Test/Commit**: Main Thread retains control (Bash tool)
- **Worktree Management**: Main Thread creates/merges/removes worktrees (git worktree commands), coding-agents work within assigned worktrees
- **Structure Registry**: coding-agent maintains CODEBASE_STRUCTURE.md (EG-DESK custom code only)
- **Research Notes**: general-purpose writes to subagent_reports/, PM moves to ideas/ after approval
- **PRDs**: egdesk-pm-agent creates/updates in ideas/confirmed/

