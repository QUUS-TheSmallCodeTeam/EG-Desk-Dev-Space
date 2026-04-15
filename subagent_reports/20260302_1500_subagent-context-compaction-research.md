# Subagent Context Compaction Research Report

**Date**: 2026-03-02
**Researcher**: Haiku 4.5
**Topic**: Claude Code Subagent Automatic Context Compaction

---

## Executive Summary

Claude Code subagents **DO automatically compact their context** when approaching capacity limits. Auto-compaction is independent of the main conversation's compaction and operates with the same mechanisms. The `maxTurns` parameter is a turn/iteration limit (not context-related) and does **NOT prevent auto-compaction** from occurring.

---

## Question 1: Do subagents automatically compact when their context window fills up?

### Answer: YES

**Evidence**:
- Subagents support automatic compaction using the same logic as the main conversation
- Auto-compaction triggers at approximately **95% capacity** of the subagent's context window
- Compaction can be triggered earlier by setting `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` environment variable to a lower percentage (e.g., 50)

**From Official Documentation**:
> "Subagents support automatic compaction using the same logic as the main conversation. By default, auto-compaction triggers at approximately 95% capacity."

**Observed Behavior**:
Real-world example from GitHub issue #16944:
```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 167189
  }
}
```

In this observed case:
- Pre-compaction: ~167,000 tokens
- Post-compaction: ~27,000 tokens (83% reduction)
- Subagent continued working successfully after compaction

---

## Question 2: Is there a max_turns limit that prevents this from ever happening?

### Answer: NO, `maxTurns` does NOT prevent compaction

**Key Distinction**:
- **`maxTurns`** = Limits the number of agentic iterations/tool calls (safety rail to prevent infinite loops)
- **Auto-compaction** = Triggered by context capacity, not turn count

**What `maxTurns` Does**:
- Available as configuration option in subagent definitions
- Controls maximum number of agentic turns before the subagent stops
- Acts as a safety mechanism to prevent infinite loops
- Used in CLI mode with `--max-turns N` flag
- In interactive mode: no hard default turn limit; bounded by practical factors (context limits, user interruption, model termination)

**What `maxTurns` Does NOT Do**:
- Does not interact with auto-compaction triggers
- Does not prevent context-based compaction
- Does not affect the 95% capacity threshold

**Configuration Example**:
```yaml
---
name: my-subagent
description: My subagent
maxTurns: 10
---
```

In this configuration, the subagent can make up to 10 tool calls. If it approaches context capacity during those 10 turns, **auto-compaction will still occur independently**.

---

## Question 3: What happens when a subagent approaches its context limit?

### Answer: Auto-compaction occurs; execution continues

**Process**:
1. Subagent context usage approaches ~95% of capacity
2. Auto-compaction is automatically triggered
3. System message with `compact_boundary` metadata is logged
4. Subagent continues working with compacted context
5. `compactMetadata` records:
   - `trigger`: "auto" (or other trigger type)
   - `preTokens`: Token count before compaction

**No Error Condition**:
- Subagent does **NOT error out** when context fills
- Does **NOT stop execution** before trying compaction
- Compaction happens transparently within the 95% capacity threshold

**Transcript Persistence**:
- Main conversation compaction: Does NOT affect subagent transcripts
- Subagent transcripts persist in separate files
- Full context history retained for resuming subagents
- Transcripts cleaned up based on `cleanupPeriodDays` setting (default: 30 days)

---

## Question 4: Is there any difference between Team agents vs Task-spawned agents regarding compaction?

### Answer: NO meaningful difference; both follow same compaction logic

**Terminology Clarification**:
- **Task-spawned agents** = Agents spawned via the Task tool (now renamed to Agent tool in v2.1.63)
- **Team agents** = Agent teams (cross-session agent coordination with independent context windows)

**Team Agents Context**:
- Each team agent member has its own independent context window
- Each team agent runs in separate session
- Team agents benefit from **per-agent context isolation** (not reliant on shared context)
- Each team agent uses the same auto-compaction mechanism

**Task/Agent Tool Subagents**:
- Run within the same session as parent
- Have independent context windows from parent
- Use standard auto-compaction at 95% capacity
- Transcript stored separately from main conversation

**Same Compaction Mechanism**:
Both types use the same auto-compaction logic:
```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": [token_count]
  }
}
```

**Practical Difference**:
- **Team agents**: Better for sustained parallel work (each has its own 200K context) and don't return results to main conversation
- **Task subagents**: Better for isolation within single session; results return to main conversation; share parent's token budget across results

---

## Environment Variables for Compaction Control

### CLAUDE_AUTOCOMPACT_PCT_OVERRIDE

Triggers auto-compaction earlier than default 95%:
```bash
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50  # Compact at 50% capacity instead of 95%
```

**Use cases**:
- Conservative contexts (ensure safety margin)
- Long-running subagents (trigger compaction preemptively)
- Testing compaction behavior

---

## Token Budget Constraints (Important Limitation)

When orchestrating multiple subagents:
- All subagents **share the parent session's 200K token budget**
- Individual subagent has its own context window for transcripts
- Results returned to main conversation consume main context tokens
- Team agents do NOT share this constraint (each has own 200K budget)

**Implication**:
- Auto-compaction in a subagent works independently
- BUT returning verbose results to main conversation can still exhaust parent's budget
- Solution: Have subagents return summaries, not full transcripts

---

## Documentation References

**Official Sources**:
1. [Claude Code Subagents Documentation - Auto-compaction section](https://code.claude.com/docs/en/sub-agents#auto-compaction)
2. [GitHub Issue #16944: Document subagent auto-compaction behavior](https://github.com/anthropics/claude-code/issues/16944)
3. [Claude API Compaction Documentation](https://platform.claude.com/docs/en/build-with-claude/compaction)
4. [Claude Code Costs Documentation](https://code.claude.com/docs/en/costs)

---

## Summary Table

| Question | Answer | Key Finding |
|----------|--------|------------|
| Auto-compact when full? | YES | Triggers at ~95% capacity |
| `maxTurns` prevents compaction? | NO | Different mechanisms; `maxTurns` limits iterations, not context |
| What happens at context limit? | Auto-compact | Transparent; execution continues with compacted context |
| Team vs Task difference? | NO | Same auto-compaction logic; different execution models |

---

## Recommendations for Your System

1. **No worries about context exhaustion**: Both Team agents and Task subagents will automatically compact
2. **maxTurns is a safety rail**: Use it to prevent infinite loops, not to manage context
3. **For long-running subagents**: Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` for safety margin
4. **For parallel research**: Team agents recommended over Task subagents (no shared token budget)
5. **Monitor compaction events**: Check `compactMetadata.preTokens` in transcripts to understand usage patterns

---

**Report Status**: Complete
**Confidence Level**: High (sourced from official documentation and GitHub issues)
