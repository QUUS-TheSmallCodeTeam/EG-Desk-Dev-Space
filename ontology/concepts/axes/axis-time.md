---
id: axis.time
type: primary_axis
layer: ontology
summary: Temporal axis for past evidence, present executable state, future goals, and alternate branches.
relations:
  constrains:
    - ontology.projection
  represented_by:
    - facet.time
    - time.past
    - time.present
    - time.future
    - time.multiverse
  intertwines_with:
    - axis.space
    - axis.virtual
---

# Time Axis

The time axis is for temporal state and transition.

In product-facing views, the main time axis flows left to right:

```text
Past -> Present -> Future
```

Backward references can exist as evidence lookup or memory retrieval, but the visible time axis should not be drawn as a bidirectional arrow unless the view is explicitly about branching, rewind, or comparison.

It includes:

- past evidence, memory, chat history, logs, revisions
- present executable state and active context
- future vision, goals, plans, tasks, and commitments
- multiverse branches, simulations, and hypothetical states
- events and actions as transitions

## Rule

Action is not a separate primary axis. It is a temporal transition that touches Space and Virtual.

```text
Action
  = Time transition
  + Space target
  + Virtual meaning
```
