---
id: facet.intent
type: facet
layer: ontology
summary: Lens for purpose, objective, goal, plan, task, and decision pressure.
relations:
  uses:
    - ontology.facet
    - ontology.projection
  visualizes:
    - time.future
    - operation.layer
  constrains:
    - view.projection
---

# Intent Facet

The intent facet describes why a concept matters in the work system.

It is the facet for:

- user objective
- goal
- plan
- task
- decision blocker
- acceptance condition
- priority and scope

## Containment Rule

Intent containment means objective decomposition.

```text
Vision
  contains goal
  contains plan
  contains task
```

This does not mean the task is physically stored inside the future or visually contained inside the card.

## Example

For `entity.llm_chat_session`, the intent projection may be:

```text
projection.llm_chat_session.intent.context_binding
  label: Active Context Binding
  objective: answer or execute the user's current request
  acceptance: the requested work is complete and verified
```

