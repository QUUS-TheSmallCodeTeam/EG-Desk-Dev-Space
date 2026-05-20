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
              │
         ┌────┴─────┐
         │          │
      [STOP]    Adopt tech?
                   │
                   ▼
            Scenario 3B (Vision Check)
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
              │
         ┌────┴─────┐
         │          │
      [STOP]    Adopt tech?
                   │
                   ▼
            Scenario 3B (Vision Check)
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
User → Main Thread ←─────────────────────────────────────────────────────────────────────┐
         │                                                                               │
         ├──→ 3A: simple question                                                        │
         │                                                                         ┌─────┴─────┐
         ▼                                                                         │  DEBATE   │
   ┌──────────────────┐                                                            │   LOOP    │
   │  PM Agent        │ • Checks vision docs                                       │           │
   │  (Vision Check)  │ • Analyzes alignment                                       │ User new  │
   └──────┬───────────┘                                                            │ reasoning │
          │                                                                         │     ↓     │
          ▼                                                                         │ Main re-  │
    Vision aligned?                                                                 │ analyzes  │
          │                                                                         │     ↓     │
     ┌────┴────────────────────────────────────┐                                   │ 3A or 3B  │
     │                                          │                                   └───────────┘
   ACCEPT                              REJECT + Alternative                               │
     │                                          │                                         │
     │                                          │                                         │
     │                                          ▼                                         │
     │                                   ┌──────────────┐                                 │
     │                                   │ Main Thread  │ • Presents PM analysis          │
     │                                   │ (Reports)    │ • Offers alternative            │
     │                                   └──────┬───────┘                                 │
     │                                          │                                         │
     │                                          │                                         │
     │                                          ▼                                         │
     │                                    ★ USER DECISION                                 │
     │                                          │                                         │
     │                                     ┌────┴────┬─────────────┐                     │
     │                                     │         │             │                     │
     │                                  Accept    Insist        Cancel                   │
     │                                   Alt.     Original          │                     │
     │                                     │         │             │                     │
     │                                     │         │             └──→ [STOP]            │
     │                                     │         │                                   │
     │                                     │         └───────────────────────────────────┘
     │                                     │
     │                                     │
     └─────────────────────────────────────┘
                                    │
                                    │
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
                               │  Scenario 4 (Development)
                               │
                               ▼
                         Scenario 2 (Research)
```

---

### Scenario 4: Development with PM Strategic Guide

**User Request:** "Add a custom terminal theme that changes based on time of day"

```
User → ┌─────────────┐ (Attaches prev PM reports) → ┌───────────┐ ←──────────────────────────────────────────────────────────────────────────────────┐
       │ Main Thread │                               │ PM Agent  │                                                                                  │
       └─────────────┘                               └─────┬─────┘                                                                                  │
                                                           │ Returns PM report                                                                      │
                                                           ▼                                                                                        │
                                                   ┌───────────────┐                                                                                │
                                                   │ Main Thread   │ Reads PM report, presents to User                                              │
                                                   │  (Reports)    │                                                                                │
                                                   └───────┬───────┘                                                                                │
                                                           │                                                                                        │
                                               PM response type:                                                                                    │
           ┌───────────────────────────────────┼───────────────────────────────────────────┐                                            │
           │                                   │                                           │                                            │
       APPROVE                              CONFLICT                              RESEARCH_NEEDED                                      │
           │                                   │                                           │                                            │
           │                                   ▼                                           ▼                                            │
           │                           ┌───────────────┐                           Scenario 2 (Research)                                │
           │                           │ Main Thread   │ Presents conflict                                                              │
           │                           │   (Reports)   │ + alternatives to User                                                         │
           │                           └───────┬───────┘                                                                                │
           │                                   │                                                                                        │
           │               ┌───────────────────┴───────────────┐                                                                        │
           │               │                                   │                                                                        │
           │       User: Accept Alt.               User: Insist Original                                                                │
           │               │                                   │                                                                        │
           │               │                                   └─→ Scenario 3                                                           │
           │               │                                                                                                            │
           │               └────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
           │                                                                                                                            │
           ▼                                                                                                                            │
               ┌───────┴───────┐                                                                                                                                    │
               │               │                                                                                                                                    │
           Single option   Multiple options                                                                                                                       │
               │               │                                                                                                                                    │
               ▼               ▼                                                                                                                                    │
       ┌───────┴───────┐   ┌───┴───────────────┐                                                                                                                   │
       │               │   │                   │                                                                                                                   │
   User: Accept   Request User chooses   Request vision                                                                                                           │
                  check   one            check                                                                                                                     │
       │               │   │                   │                                                                                                                   │
       │               │   │                   └─→ Scenario 3B (Vision Check)                                                                                      │
       │               │   │                                                                                                                                       │
       │               └───┴─→ Scenario 3B (Vision Check)                                                                                                          │
       │                                                                                                                                                           │
       └───────────────────┘                                                                                                                                       │
               │                                                                                                                                                   │
               ▼                                                                                                                                                   │
   ┌───────────────┐                                                                                                                                                │
   │ Main Thread   │ Asks: "Approve this plan?"                                                                                                                     │
   │  (Requests)   │                                                                                                                                                │
   └───────┬───────┘                                                                                                                                                │
                   │                                                                                                                                           │
   ┌───────────────┴───────────────────────┐                                                                                                                   │
   │                   │                   │                                                                                                                   │
User: Approve      User: Reject    User: Request Changes                                                                                                       │
   │                   │                   │                                                                                                                   │
   │                   └──→ [STOP]         └──→ Back to PM (with feedback)                                                                                     │
   │                                                                                                                                                           │
   ▼                                                                                                                                                           │
┌───────────────┐                                                                                                                                              │
│ Main Thread   │ Plans framework investigation                                                                                                                │
│   (Plans)     │                                                                                                                                              │
└───────┬───────┘                                                                                                                                              │
        │                                                                                                                                              │
┌───────┴───────┐                                                                                                                                      │
│               │                                                                                                                                      │
Parallel    Sequential                                                                                                                                │
│               │                                                                                                                                      │
▼               ▼                                                                                                                                      │
┌──────────────────┐  ┌──────────────────┐                                                                                                            │
│ Framework Agents │  │ Framework Agent  │                                                                                                            │
│   (Parallel)     │  │  (Sequential)    │                                                                                                            │
└────────┬─────────┘  └────────┬─────────┘                                                                                                            │
         │                     │                                                                                                                      │
         └──────────┬──────────┘ Return patterns + file lists                                                                                         │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ Main Thread   │ Synthesizes findings                                                                                                    │
            │ (Synthesizes) │                                                                                                                          │
            └───────┬───────┘                                                                                                                          │
                    │                                                                                                                                  │
    ┌───────────────┴───────────────┐                                                                                                                  │
    │                               │                                                                                                                  │
Need PM Review              No PM Review                                                                                                              │
    │                               │                                                                                                                  │
    ▼                               │                                                                                                                  │
┌───────────┐                       │                                                                                                                  │
│ PM Agent  │ Reviews plan           │                                                                                                                  │
│  (Review) │                       │                                                                                                                  │
└─────┬─────┘                       │                                                                                                                  │
      │                             │                                                                                                                  │
      ▼                             │                                                                                                                  │
┌───────────────┐                   │                                                                                                                  │
│ Main Thread   │ Reads PM review   │                                                                                                                  │
│ (Synthesizes) │                   │                                                                                                                  │
└───────┬───────┘                   │                                                                                                                  │
        │                           │                                                                                                                  │
        └───────────┬───────────────┘                                                                                                                  │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ Main Thread   │ Creates complete impl plan                                                                                              │
            │ (Synthesizes) │ PM guide + framework patterns                                                                                           │
            └───────┬───────┘                                                                                                                          │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ coding-agent  │ Checks CODEBASE_STRUCTURE.md                                                                                            │
            │   (Checks)    │ Returns: OK / CONFLICT                                                                                                  │
            └───────┬───────┘                                                                                                                          │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ Main Thread   │ Reads check result                                                                                                      │
            │  (Analyzes)   │                                                                                                                          │
            └───────┬───────┘                                                                                                                          │
                    │                                                                                                                                  │
    ┌───────────────┴───────────────┐                                                                                                                  │
    │                               │                                                                                                                  │
No conflict                     CONFLICT                                                                                                               │
    │                               │                                                                                                                  │
    │                               ▼                                                                                                                  │
    │                       ┌───────────────┐                                                                                                          │
    │                       │ Main Thread   │ Reports conflict                                                                                        │
    │                       │   (Reports)   │ Presents options to User                                                                                │
    │                       └───────┬───────┘                                                                                                          │
    │                               │                                                                                                                  │
    │               ┌───────────────┴───────────────┐                                                                                                  │
    │               │                               │                                                                                                  │
    │       User: Rename/Override            User: Cancel                                                                                             │
    │               │                               │                                                                                                  │
    │               │                               └──→ [STOP]                                                                                       │
    │               │                                                                                                                                  │
    └───────────────┘                                                                                                                                  │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ coding-agent  │ Implements (Sequential / Simple Parallel / Worktree Parallel)                                                           │
            │ (Implements)  │ Updates CODEBASE_STRUCTURE.md                                                                                           │
            └───────┬───────┘ Returns implementation report                                                                                           │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ Main Thread   │ Reads implementation report                                                                                             │
            │   (Reviews)   │                                                                                                                          │
            └───────┬───────┘                                                                                                                          │
                    │                                                                                                                                  │
    ┌───────────────┴───────────────┐                                                                                                                  │
    │                               │                                                                                                                  │
Need UX Validation          No UX Validation                                                                                                           │
    │                               │                                                                                                                  │
    ▼                               │                                                                                                                  │
┌────────────────┐                  │                                                                                                                  │
│ ux-flow-       │ Traces flows     │                                                                                                                  │
│ simulator      │ Returns:Issues/OK│                                                                                                                  │
└────────┬───────┘                  │                                                                                                                  │
         │                          │                                                                                                                  │
         ▼                          │                                                                                                                  │
┌───────────────┐                   │                                                                                                                  │
│ Main Thread   │ Reads UX report   │                                                                                                                  │
│  (Analyzes)   │                   │                                                                                                                  │
└───────┬───────┘                   │                                                                                                                  │
        │                           │                                                                                                                  │
┌───────┴───────┐                   │                                                                                                                  │
│               │                   │                                                                                                                  │
Issues      No issues                │                                                                                                                  │
│               │                   │                                                                                                                  │
│               └───────────────────┘                                                                                                                  │
│                                   │                                                                                                                  │
└─→ Fix via coding-agent (loop back)│                                                                                                                  │
                                    │                                                                                                                  │
                    ┌───────────────┘                                                                                                                  │
                    │                                                                                                                                  │
                    ▼                                                                                                                                  │
            ┌───────────────┐                                                                                                                          │
            │ Main Thread   │ Asks User: "Proceed with build/test?"                                                                                   │
            │  (Requests)   │                                                                                                                          │
            └───────┬───────┘                                                                                                                          │
                    │                                                                                                                                  │
    ┌───────────────┴───────────────┐                                                                                                                  │
    │                               │                                                                                                                  │
User: Yes                       User: No                                                                                                               │
    │                               │                                                                                                                  │
    │                               └──→ [STOP] (User tests manually)                                                                                 │
    │                                                                                                                                                  │
    ▼                                                                                                                                                  │
┌───────────────┐                                                                                                                                      │
│ Main Thread   │ Build & Test                                                                                                                        │
│(Build & Test) │ npm run build, npm test                                                                                                             │
└───────┬───────┘                                                                                                                                      │
        │                                                                                                                                              │
┌───────┴───────┐                                                                                                                                      │
│               │                                                                                                                                      │
Success      Failure                                                                                                                                   │
│               │                                                                                                                                      │
▼               └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────┐
│ Main Thread │
│  (Commit)   │
└─────────────┘
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
