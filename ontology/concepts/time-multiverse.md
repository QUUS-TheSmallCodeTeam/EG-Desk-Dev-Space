---
id: time.multiverse
type: representative
layer: time
summary: Representative of alternate branches, simulations, and candidate futures.
relations:
  branches_from:
    - time.present
    - time.future
  branches_into:
    - candidate.future
    - simulated.state
    - alternate.plan
  informs:
    - time.future
    - output.structured
---

# Multiverse Representative

Multiverse is the representative for possible worlds.

Examples:

- alternate implementation plans
- simulated user reactions
- possible UI states
- branch/worktree futures
- rollback paths
- product strategy options
- hypothetical company or customer states

Multiverse answers:

```text
What could happen?
What path should we choose?
What should remain only a simulation?
What branch can be tested without committing it to reality?
```

This layer is necessary because EG-Desk should support planning, simulation, and branching without confusing those possibilities with current reality.

