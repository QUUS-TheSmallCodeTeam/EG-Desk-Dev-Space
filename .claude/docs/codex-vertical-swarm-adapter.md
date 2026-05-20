# Codex Vertical Swarm Adapter

> Status: draft protocol for adapting the existing `.claude` swarm model to Codex MultiAgentV2.
> Date: 2026-05-18

## 1. Problem This Solves

The Codex swarm should solve two different failure modes:

1. **High-level goal dilution**
   - A session starts with a broad user goal.
   - Work moves into a narrow sub-goal.
   - Long context, compaction, and repeated local fixes make the high-level goal fade.
   - The user ends up manually tracking the original goal and every sub-goal transition.

2. **Role/context contamination**
   - Some agents are not workers. They are narrow simulation objects: reviewer, executive, customer, PM, skeptical domain expert.
   - A mono-thread makes it hard to keep their context narrow and reusable.
   - Once the main thread carries too much implementation context, roleplay feedback becomes polluted by details the simulated object should not know or care about.

The Codex adapter must therefore separate:

- **Metacognitive control**: preserving the high-level goal, decomposing tasks, deciding when to replan.
- **Working-level state**: codebase research, implementation state, document editing state.
- **Simulation state**: deliberately narrow persona/object context for repeated feedback.

## 2. Runtime Facts Assumed

This protocol is based on observed Codex MultiAgentV2 behavior and local source inspection:

- Nested agents are supported. A subagent can spawn its own descendants.
- Agents have canonical task paths such as `/root/mission/worker_a`.
- `followup_task` can trigger a new turn in an existing non-root agent.
- `send_message` queues mail and does not trigger a new turn.
- A live completed subagent can be reused by sending `followup_task` to its canonical path.
- In the current V2 tool surface, closed-agent `resume_agent` is not exposed. Treat engine-level resume as unavailable for this adapter.
- Parent/root does not auto-wake when a child completes. The orchestrator must use `wait_agent` when it needs results now.
- `fork_turns` is a branch-depth knob, not a semantic context selector. Prefer explicit context packages over relying on `all`.

## 3. Core Architecture

```text
Main / Session Lead
  owns: user conversation, high-level goal, final decision, final report

  -> Mission Agent
      starts as a task owner
      may self-escalate to Sprint Leader if the complexity gate passes

      -> Working Agents
          own long-lived research, code, docs, verification, or file territory

      -> Simulation Agents
          own narrow roleplay/persona/object perspective

      -> Verifier Agents
          independently check claims, tests, screenshots, or reasoning gaps
```

The important change from the existing Claude swarm is that Sprint Leader does not need to be a pre-created horizontal peer. In Codex, a Mission Agent can become a Sprint Leader because nested agents and direct child control are available.

## 4. Agent Classes

### Main / Session Lead

Responsibilities:

- Maintain the user-facing high-level goal.
- Decide whether to delegate at all.
- Spawn the initial Mission Agent when delegation is justified.
- Keep the final arbiter role: merge decisions, user-facing answer, destructive changes, git, persisted memory updates.
- Avoid becoming the working memory for every sub-goal.

Main should keep a short mission envelope:

```json
{
  "mission_id": "short_slug",
  "north_star": "The high-level user goal",
  "current_phase": "phase name",
  "active_leader": "/root/mission_slug",
  "open_questions": [],
  "non_goals": [],
  "final_arbiter": "main"
}
```

### Mission Agent / Sprint Leader

Starts as a normal delegated agent. It may self-escalate to Sprint Leader only when authorized by Main and the complexity gate passes.

Responsibilities after escalation:

- Maintain the task ledger.
- Spawn and reuse working-level child agents.
- Keep worker prompts small and explicit.
- Route `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, and `BLOCKED`.
- Preserve the high-level goal in every dispatch and phase report.
- Decide when a working agent should be reused instead of replaced.
- Keep Main informed through compact phase reports, not raw worker chatter.

It does not own final user decisions.

### Working-Level Agents

Use for research, code edits, document edits, tests, and source investigation when the state is expected to continue developing.

Justification for a working agent is not merely "parallel investigation." Use one when at least one is true:

- The same codebase/topic state will be reused across multiple follow-ups.
- The agent owns a coherent file territory or research territory.
- The work needs local continuity while Main preserves the high-level goal.
- The agent can continue from its own prior reads, attempts, and failed paths.
- The work benefits from writer/verifier separation.

Working agents should normally be kept live until the mission closes.

### Simulation / Roleplay Agents

Use for narrow-context feedback, not artifact ownership.

Rules:

- Spawn with `fork_turns: "none"` unless the exact thread history is intentionally part of the simulation.
- Pass only the selected concept paths, artifact paths, scenario, role boundary, and output shape.
- Do not let the simulation agent browse unrelated project context.
- Reuse the same live simulation agent through `followup_task` for repeated feedback in the same scenario.
- If the persona context becomes contaminated, close it and spawn a fresh sterile one.

## 5. Complexity Gate For Self-Escalation

A Mission Agent may become Sprint Leader when two or more are true:

- The task has more than one independent sub-goal.
- The task is expected to continue through user follow-ups.
- There is meaningful worker state to reuse.
- There are separate roles: writer, verifier, reviewer, PM, persona, file mapper.
- There is risk that Main will lose the high-level goal if it dives into implementation detail.
- There is risk that a roleplay/reviewer context will be polluted in the main thread.
- There is a need to preserve negative results or decisions across phases.

If the gate does not pass, use a single direct agent or no agent.

## 6. Context Strategy

Default policy:

```yaml
main_to_mission:
  fork_turns: "none"
  context: explicit mission envelope plus essential facts

mission_to_working_agent:
  fork_turns: "none"
  context: task slice, file paths, high-level north_star, output format

mission_to_simulation_agent:
  fork_turns: "none"
  context: narrow role package only

mission_to_verifier:
  fork_turns: "none"
  context: artifact/result to verify plus criteria
```

Use `fork_turns: "1"` or a calculated `N` only when the target agent must inspect recent conversation turns directly. If exact branch depth is uncertain, copy the essential context into the prompt instead of using a broader fork.

Avoid `fork_turns: "all"` except for coordinator/reviewer work where the entire conversation is truly relevant and context contamination is acceptable.

## 7. Session Reuse Protocol

### Live Reuse

This is the default.

```text
1. Spawn worker once.
2. Let it complete one task.
3. Do not close it.
4. Send follow-up work to the same canonical path with followup_task.
5. Leader waits only when the result is needed for the next step.
6. Close at mission end after snapshot/handoff if needed.
```

Example shape:

```json
{
  "target": "/root/mission_slug/research_firefox_runtime",
  "message": "Continue from your prior findings. New sub-goal: inspect helper bridge lifecycle. Preserve previous negative results. Report only deltas plus updated next_steps."
}
```

### Closed Agent Reuse

Do not depend on V2 closed-agent resume. If a worker must be closed, write or request a structured snapshot first, then spawn a new worker with that snapshot as explicit context.

Minimum snapshot:

```json
{
  "agent_path": "/root/mission_slug/worker_name",
  "role": "research | code | docs | verifier | simulation",
  "north_star": "High-level goal",
  "current_subgoal": "Current working target",
  "files_read": [],
  "files_modified": [],
  "key_findings": [],
  "negative_results": [],
  "decisions": [],
  "open_questions": [],
  "next_steps": []
}
```

## 8. Mission State Files

For complex missions, use local session-scoped files under:

```text
.tmp/codex-swarm/{mission_id}/
├── mission.json
├── task-ledger.jsonl
├── agent-registry.jsonl
├── shared-context.jsonl
├── decision-registry.jsonl
├── negative-results.jsonl
├── handoff/
│   └── phase-{n}.json
└── snapshots/
    └── {agent_name}.json
```

These files are not a replacement for live agent context. They are a guardrail against compaction, idle loss, and Main losing the high-level goal.

## 9. Signaling Protocol

Workers report to their parent Sprint Leader, not Main, unless Main spawned them directly.

First-turn project-document acknowledgement is not a worker ACK. A valid worker ACK must mention the assigned task scope, first action, and reporting target. If the first response only acknowledges project instructions, the Sprint Leader should send one `followup_task` that restates the task and asks for a valid ACK.

Required statuses:

```text
[ACK] task received; scope; first action
[DISCOVERY] important reusable finding; optional
[BLOCKED] blocker; attempted fix; requested decision
[DONE] result; evidence; files_created; files_modified; next_steps
[DONE_WITH_CONCERNS] result; concerns; verification gaps; next_steps
[NEEDS_CONTEXT] missing context; exact request
```

Sprint Leader reports to Main:

```text
[PHASE_START] phase goal; workers; expected outputs
[STATUS] progress; current risk; high-level goal alignment
[PHASE_DONE] outputs; decisions; open questions; next phase
[ESCALATE] user/main decision needed; options; recommendation
```

If `list_agents` shows `shutdown` or `NotFound` after a follow-up, do not assume live reuse succeeded. Route through the snapshot fallback or respawn the worker with explicit context. This matters because V2 live reuse depends on the target thread still existing and callable.

## 10. High-Level Goal Preservation

Every Sprint Leader and long-lived worker prompt must include:

```text
North Star:
<one sentence high-level user goal>

Current Sub-goal:
<specific local task>

Non-goals:
<what this agent must not expand into>

Report back with:
- status
- evidence
- how this affects the North Star
- next recommended sub-goal
```

This keeps the high-level goal outside any single working thread. The worker can focus, while the Sprint Leader keeps a metacognitive view, and Main keeps final judgment.

## 11. Roleplay Isolation Protocol

For persona/object simulation:

```text
1. Main or Sprint Leader assembles a narrow context package.
2. Spawn a simulation agent with fork_turns none.
3. The simulation agent must not edit artifacts.
4. It reports reactions, doubts, decision blockers, trusted evidence, untrusted evidence, and questions.
5. Parent translates feedback into artifact changes or worker tasks.
6. Reuse the same simulation agent only within the same scenario boundary.
```

Prompt skeleton:

```text
You are a simulation/reviewer agent, not an editor.

Role boundary:
<represented point of view>

Context package:
<only selected concept paths or artifact summaries>

Scenario:
<what the parent wants judged>

You may not inspect unrelated repo context.
Report:
- reaction
- trusted evidence
- untrusted evidence
- blockers
- questions
- recommendation
```

## 12. Close Policy

Do not close a reusable worker just because it reported `DONE`.

Close when:

- The mission is complete.
- The agent context is contaminated.
- Its file territory is no longer relevant.
- The agent is idle and a snapshot has been captured.
- The live thread budget or max concurrent thread limit requires eviction.

Before closing a reusable worker, Sprint Leader should capture a snapshot or explicitly decide that no future reuse is expected.

## 13. Acceptance Tests

Before relying on this protocol for real work, run these tests:

1. **Live worker reuse**
   - Spawn worker with a private token and small research task.
   - Let it complete.
   - Send `followup_task` asking it to continue from prior findings and recall the token.
   - Pass if it uses prior context without Main restating it.

2. **Vertical nesting**
   - Spawn a Mission Agent authorized to self-escalate.
   - Have it spawn one child worker and one verifier.
   - Pass if Main only receives phase reports while child coordination stays inside the subtree.

3. **Goal preservation**
   - Give a high-level goal plus narrow sub-goal.
   - Worker reports local result.
   - Sprint Leader must map result back to the high-level goal.

4. **Roleplay isolation**
   - Spawn a sterile persona agent with a narrow artifact summary.
   - Ask follow-up questions in the same scenario.
   - Pass if it stays in role and does not import unrelated implementation context.

5. **Snapshot fallback**
   - Close a reusable worker after writing a snapshot.
   - Spawn a replacement with the snapshot.
   - Pass if it continues from the captured state, while acknowledging that this is prompt-level rehydration, not V2 `resume_agent`.

## 14. Practical Default

For Codex today:

```text
Main keeps the user goal.
Mission Agent becomes Sprint Leader only when complexity gate passes.
Sprint Leader keeps working agents live and reuses them via followup_task.
Workers own working-level continuity.
Simulation agents own narrow roleplay continuity.
Snapshots and ledgers protect against compaction and close/replacement.
Main remains final arbiter.
```
