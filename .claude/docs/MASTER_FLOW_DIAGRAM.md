# Master Flow Diagram: All Request Types

This diagram shows the complete routing logic and agent communication flow for the EG-DESK agent orchestration system. **CRITICAL**: All subagents report back to Main Thread (via subagent_reports/), and Main Thread communicates results to User.

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

## Development Workflow (Detailed Steps)

The Development branch shown in the master flow above expands into the following detailed workflow:

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

## Flow Types Summary

The master flow handles five main request types:

1. **Simple Task**: Direct execution by Main Thread (no agents)
2. **Research**:
   - Branch A: Analyzer agent for adopted technologies
   - Branch B: Parallel research + PM evaluation for new technologies
3. **Vision Question**: PM agent for vision alignment checks
4. **Development**: Full PM-driven workflow with framework investigation and implementation
5. **Agent Creation**: claude-agent-sdk-analyzer for new agent creation

For detailed scenario examples, see [AGENT_SWARM_FLOW.md](./AGENT_SWARM_FLOW.md).
