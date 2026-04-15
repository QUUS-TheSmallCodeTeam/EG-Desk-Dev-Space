#!/bin/bash
# PreToolUse:Bash hook — block destructive git for ALL subagents.
# Main session (user via Claude) is unrestricted — they're the operator.
# Fail-safe: if subagent_type field missing/empty → allow (under-block over over-block).

INPUT=$(cat)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.subagent_type // ""')

# Fail-safe: empty subagent_type = main session OR field missing → allow
if [[ -z "$AGENT_TYPE" || "$AGENT_TYPE" == "main" ]]; then
  exit 0
fi

# Subagent detected → check destructive git patterns
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

if echo "$CMD" | grep -qE '^[[:space:]]*git[[:space:]]+(push|reset[[:space:]]+--hard|clean[[:space:]]+-fd|checkout[[:space:]]+\.|branch[[:space:]]+-D)'; then
  echo "Blocked: Subagents cannot run destructive git commands." >&2
  echo "Agent: $AGENT_TYPE | Command: $CMD" >&2
  echo "Report DONE_WITH_CONCERNS in your status — your parent will route the request." >&2
  exit 2
fi

exit 0
