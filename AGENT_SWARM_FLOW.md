# Agent Swarm Flow: From Ideation to Implementation

This document maps the complete agent orchestration system for the EG-DESK project through concrete workflow scenarios.

For the complete routing logic and agent communication flow diagram, see [MASTER_FLOW_DIAGRAM.md](./MASTER_FLOW_DIAGRAM.md).

## Workflow Scenarios

### Scenario 1: Simple Question

**User Request:** "What files are in the packages/ai-chat directory?"

```
User → Main Thread → Glob("packages/ai-chat/**/*") → User
```

---

### Scenario 2A: Adopted Technology Investigation

**User Request:** "How does Theia's dependency injection work?"

```
User → Main Thread
         │
         ├──→ 2B: general tech research
         │
         ▼
   ┌──────────────────────┐
   │  Analyzer Agent      │ • Reads references/[tech]/
   │  (theia/electron/    │ • WebFetch + WebSearch (official docs)
   │   infinite-canvas)   │ • Returns investigation with file:line references
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Main Thread         │ • Reads agent report
   │  (Synthesizes)       │ • Presents findings to user
   └──────────┬───────────┘
              │
              ▼
            User
```

---

### Scenario 2B: General Technology Research (No Analyzer Agent)

**User Request:** "How do I use WebRTC for peer-to-peer connections?"

```
User → Main Thread
         │
         ├──→ 2A: analyzer agent tech
         │
         ▼
   ┌─────────────────────┐
   │  general-purpose    │ • WebFetch, WebSearch
   │  (Research Agent)   │ • Investigates WebRTC
   │                     │ (Parallel possible)
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐
   │  Main Thread        │ • Reads research report
   │  (Synthesizes)      │ • Presents findings
   └──────────┬──────────┘
              │
              ▼
            User
```

---

### Scenario 3A: Vision Check - Simple Question

**User Request:** "How did I implement the theme system last time?"

```
User → Main Thread
         │
         ├──→ 3B: framework/UX adoption
         │
         ▼
   ┌──────────────────┐
   │  PM Agent        │ • Checks vision docs
   │  (Vision Check)  │ • Retrieves past decisions
   └──────┬───────────┘
          │
          ▼
   ┌──────────────────┐
   │  Main Thread     │ • Presents answer
   │  (Reports)       │
   └──────┬───────────┘
          │
          ▼
        User
```

---

### Scenario 3B: Vision Check - Framework/UX Adoption

**User Request:** "Should we add a floating AI assistant that follows the cursor?"

```
User → Main Thread
         │
         ├──→ 3A: simple question
         │
         ▼
   ┌──────────────────┐
   │  PM Agent        │ • Checks vision docs
   │  (Vision Check)  │ • Analyzes alignment
   └──────┬───────────┘
          │
          ▼
    Vision aligned?
          │
     ┌────┴────┐
     │         │
   ACCEPT                              REJECT + Alternative
     │                                        │
     │                                        │
     │                                        ▼
     │                                   ┌──────────────┐
     │                                   │ Main Thread  │ • Presents PM analysis
     │                                   │ (Reports)    │ • Offers alternative
     │                                   └──────┬───────┘
     │                                          │
     │                                          │
     │                                          ▼
     │                                    ★ USER DECISION
     │                                          │
     │                                     ┌────┴────┬──────────────────┐
     │                                     │         │                  │
     │                                  Accept    Insist             Cancel
     │                                   Alt.     Original               │
     │                                     │         │                  │
     │                                     │         │                  └──→ [STOP]
     │                                     │         │
     │                                     │         └──→ Debate Loop
     │                                     │              (PM ↔ User, Multiple rounds)
     │                                     │                   │
     │                                     │                   ▼
     │                                     │              ★ FINAL DECISION
     │                                     │                   │
     │                                     │        ┌──────────┴──────────┐
     │                                     │        │                     │
     │                                     │     Evolve                Maintain
     │                                     │     vision                 vision
     │                                     │        │                     │
     │                                     │        │                  [STOP]
     │                                     │        │
     │                                     │        └─────────────────────────┘
     │                                     │                        │
     │                                     └────────────────────────┘
     │                                                │
     └────────────────────────────────────────────────┘
                       │
                       ▼
                 If framework research?
                       │
                  ┌────┴────┐
                  │         │
                 Yes       No
                  │         │
                  │         ▼
                  │  ┌──────────────┐
                  │  │  PM Agent    │ • Updates vision docs
                  │  │(Updates docs)│   (if evolved)
                  │  └──────┬───────┘
                  │         │
                  │         ▼
                  │  ┌──────────────┐
                  │  │ Main Thread  │ • Reports final decision
                  │  │ (Reports)    │
                  │  └──────┬───────┘
                  │         │
                  │         ▼
                  │  [Proceed to Implementation]
                  │
                  ▼
            Scenario 2 (Research)
```

---

### Scenario 4: Development with PM Strategic Guide

**User Request:** "Add a custom terminal theme that changes based on time of day"

```
User → Main Thread
         │
         ▼
   ┌──────────────┐
   │  PM Agent    │ • Discovers tech stack
   │  (Strategic  │ • Vision alignment check
   │   Guide)     │ • Creates PRD
   └──────┬───────┘ • Returns: APPROVE
          │           - Framework: Theia
          │           - Location: packages/terminal/src/browser/
          ▼
   ┌──────────────────┐
   │  Main Thread     │ • Presents PM strategic guide
   │  (Reports)       │ • Asks for user approval
   └──────┬───────────┘
          │
          ▼
    Approve / Reject / Alternative?
          │
    [If Approve]
          │
          ▼
   ┌──────────────────┐
   │  Main Thread     │ • Plans investigation
   │  (Plans          │ • Identifies patterns to research
   │   investigation) │
   └──────┬───────────┘
          │
          ▼
   ┌──────────────────────┐
   │  theia-analyzer      │ • Reads terminal-theme-service.ts
   │  (Framework          │ • Returns pattern + file list:
   │   investigation)     │   - CREATE time-based-theme-switcher.ts
   └──────┬───────────────┘   - MODIFY terminal-frontend-module.ts:36
          │                   - REFERENCE workspace-service.ts:89
          ▼
   ┌──────────────────────┐
   │  Main Thread         │ • Synthesizes PM guide + framework patterns
   │  (Creates impl plan) │ • Creates implementation plan
   └──────┬───────────────┘
          │
          ▼
    ★ DELEGATION DECISION
          │
      ┌───┴───┐
      │       │
      ▼       ▼
   Simple   Complex (3+ files)
      │       │
      ▼       ▼
   ┌──────┐ ┌────────────────┐
   │ Main │ │ coding-agent   │ • Checks conflicts (EG-DESK custom only)
   │Thread│ │ (Implements)   │ • If conflict: STOP → User decides
   └──┬───┘ └────┬───────────┘ • If no conflict: Implement
      │          │
      │          ▼
      │    ★ PARALLEL DECISION
      │          │
      │      ┌───┼───┐
      │      │   │   │
      │      ▼   ▼   ▼
      │   ┌──────────────────────────────────────────────────┐
      │   │ Option A: Sequential (1 agent)                   │
      │   │ Option B: Simple Parallel (different files)     │
      │   │ Option C: Worktree Parallel (same files)        │
      │   └──────────────────┬───────────────────────────────┘
      │                      │
      └──────────────────────┘
                │
                ▼
   ┌────────────────────────┐
   │ (Optional) UX Flow     │ • If complex: Invoke ux-flow-simulator
   │  Validator             │ • Traces execution paths
   └────────┬───────────────┘ • If issues: Fix → Re-validate
            │
            ▼
   ┌────────────────────────┐
   │  Main Thread           │ • Build, test, commit
   │  (Build/Test/Commit)   │
   └────────────────────────┘
```

---

### Scenario 5: Agent Creation

**User Request:** "We need an agent that analyzes Konva.js integration patterns"

```
User → Main Thread
     │
     ▼
   ┌─────────────────────────┐
   │ claude-agent-sdk        │ • Read(subagent-best-practices.md)
   │ -analyzer               │ • Glob(existing agents)
   └──────┬──────────────────┘ • Design + Create agent file
          │
          ▼
   ┌─────────────────────────┐
   │  Main Thread            │ • Confirms agent created
   │  (Reports completion)   │ • Informs user to restart session
   └──────┬──────────────────┘
          │
          ▼
        User
```

---

### Scenario 6: Simple File Edit

**User Request:** "Fix the typo in the README - change 'intsall' to 'install'"

```
User → Main Thread → coding-agent (Read, Edit) → Main Thread (commit) → User
```

---

## Appendix: Roles and Responsibilities Reference

| Agent | Domain | Can Read | Can Write | Output Format |
|-------|--------|----------|-----------|---------------|
| **Main Thread** | Orchestration | .claude/prompts/, .claude/agents/ | None (application code) | Synthesized plans, user communication |
| **egdesk-pm-agent** | Vision & Strategy | ideas/, technology-stack.md | PRDs, vision docs, tech stack | Strategic guide, PRD, evaluation report |
| **theia-analyzer-agent** | Theia Framework | packages/*, Theia docs | None | Pattern analysis, file lists |
| **electron-analyzer-agent** | Electron Framework | Electron docs (WebFetch) | None | Pattern analysis, API guidance |
| **infinite-canvas-analyzer-agent** | Infinite Canvas | references/infinite-canvas/ | None | Integration analysis |
| **coding-agent** | Code Execution | Target files (any worktree) | Application code, CODEBASE_STRUCTURE.md | Implementation report |
| **claude-agent-sdk-analyzer-agent** | Agent Architecture | .claude/agents/, best practices | .claude/agents/*.md | Agent spec |
| **ux-flow-simulator-agent** | UX Validation | Implemented files | None | Flow validation report |
| **general-purpose** | Research | Web | subagent_reports/*.md | Research findings |

**Key Ownership:**
- **Vision**: egdesk-pm-agent
- **Code**: coding-agent (ONLY entity that writes application code)
- **Build/Test/Commit**: Main Thread
- **Worktree Management**: Main Thread creates/merges, coding-agents work within
- **Structure Registry**: coding-agent maintains CODEBASE_STRUCTURE.md (EG-DESK custom only)
- **Research Notes**: general-purpose writes to subagent_reports/, PM moves to ideas/ after approval
- **PRDs**: egdesk-pm-agent creates/updates in ideas/confirmed/
