---
id: axis.virtual
type: primary_axis
layer: ontology
summary: Conceptual and semantic axis for entities, concepts, identities, intentions, goals, and meanings.
relations:
  constrains:
    - ontology.canonical_concept
    - ontology.projection
  represented_by:
    - ontology.canonical_concept
    - ontology.facet
    - facet.intent
  intertwines_with:
    - axis.space
    - axis.time
---

# Virtual Axis

The virtual axis is for conceptual and semantic identity.

It includes:

- canonical concepts and entities
- ontology concepts
- goals, plans, tasks, blockers, decisions
- agent identity, role, memory, and context meaning
- source reference meaning, not just the bytes or path

## Rule

Intent is not a separate primary axis. It is a virtual meaning that becomes temporal commitment and spatial work.

```text
Intent
  = Virtual objective
  + Time commitment
  + Space artifact or action surface
```

