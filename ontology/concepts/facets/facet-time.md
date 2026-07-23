---
id: facet.time
type: facet
layer: ontology
summary: Lens for past evidence, present executable state, future plans, and multiverse branches.
relations:
  uses:
    - ontology.facet
    - ontology.projection
  visualizes:
    - time.past
    - time.present
    - time.future
    - time.multiverse
  constrains:
    - view.projection
---

# Time Facet

The time facet describes when a concept exists or acts.

It is the facet for:

- past evidence and memory
- present executable state
- future goals, plans, and tasks
- multiverse branches and simulations
- causal order

## Containment Rule

Time containment means temporal membership or causality.

```text
Past
  contains chat history
  contains file revision
  contains execution log

Future
  contains goal
  contains plan
  contains task
```

This does not mean the past memory is visually inside a desktop card or physically inside the CPU.

## Example

For `entity.llm_chat_session`, the time projection may be:

```text
projection.llm_chat_session.time.memory_trace
  label: Chat Memory Trace
  phase: Past
  evidence: messages, tool calls, decisions, summaries
```

