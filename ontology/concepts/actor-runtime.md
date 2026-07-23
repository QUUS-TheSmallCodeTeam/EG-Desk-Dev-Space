---
id: actor.runtime
type: actor
layer: runtime
summary: Human, agent, tool, and automation actors that operate inside the EG-Desk world.
relations:
  operates_inside:
    - egdesk.world
  acts_on:
    - time.present
    - architecture.runtime
  receives_constraints_from:
    - operation.layer
    - source.ref
---

# Runtime Actors

Runtime actors are entities that can observe, decide, or act inside EG-Desk.

Examples:

- human user
- Codex root thread
- subagent
- browser controller
- terminal process
- MCP tool
- heartbeat automation
- external service

Actors should be described by coordinates, not just names:

```text
Actor = {
  reality_scope,
  architecture_scope,
  present_surface,
  past_sources,
  future_objective,
  multiverse_branch,
  allowed_actions,
  output_contract
}
```

This is where swarm design fits. A swarm is a coordinated pattern of runtime actors over the EG-Desk ontology, not the ontology's foundation.

