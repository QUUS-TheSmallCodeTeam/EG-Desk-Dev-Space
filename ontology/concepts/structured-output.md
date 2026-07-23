---
id: output.structured
type: output
layer: operation
summary: Machine-readable output that updates time representatives and can become context.
relations:
  derived_from:
    - time.past
    - time.present
    - action.execution
  updates:
    - time.future
    - time.multiverse
    - time.past
  uses:
    - source.ref
---

# Structured Output

Structured Output is the bridge from action to reusable world state.

Examples:

- state diff
- decision record
- plan update
- task list
- evidence bundle
- artifact manifest
- source-ref list
- branch comparison
- run playback record

Structured Output should be both human-readable and machine-readable. It is how EG-Desk turns an action into future context without forcing the LLM to reread an entire transcript.

## Output Contract Shape

```yaml
id: output.example
type: decision_record
summary: One-line result.
updates:
  future:
    goals: []
    plans: []
  past:
    evidence_refs: []
  present:
    changed_surfaces: []
source_refs: []
```

